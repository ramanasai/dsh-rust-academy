#!/usr/bin/env node
/**
 * Compiler gate for the curriculum.
 *
 * Before the Client module is shipped, every Rust snippet in src/data is checked
 * with the real Rust toolchain:
 *
 *   1. rustfmt (the rustc parser) must accept the snippet as a module, inside
 *      fn main, or inside a module block;
 *   2. exercise solutions and cheatsheet snippets that are self-contained are
 *      additionally compiled with rustc, so they are proven runnable, not just
 *      parseable.
 *
 * Non-Rust blocks (TOML, YAML, SQL, shell, Docker, JSON, HTTP) and explicit
 * pseudo-code are skipped. Exercise starters are parse-checked only: they are
 * intentionally broken for the learner to fix.
 *
 * Known context-dependent snippets live in `.snippet-baseline.json`. The build
 * fails only when a snippet fails that is not in the baseline (a regression).
 *
 *   node scripts/compiler-gate.mjs                  # report only
 *   node scripts/compiler-gate.mjs --strict         # fail on any failure
 *   node scripts/compiler-gate.mjs --baseline       # fail only on new failures
 *   node scripts/compiler-gate.mjs --update-baseline
 *   node scripts/compiler-gate.mjs --track web --limit 20
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '..');
const cacheFile = path.join(root, '.snippet-cache.json');
const baselineFile = path.join(root, '.snippet-baseline.json');
const dataDir = path.join(root, 'src', 'data');
const STAMP = Date.now();

const RUST_MARKERS = [
  /\bfn\s+[A-Za-z_]\w*\s*\(/,
  /\blet\b/,
  /^\s*use\s+[a-zA-Z_]/m,
  /\bimpl\b/,
  /\bstruct\b/,
  /\benum\b/,
  /\btrait\b/,
  /\bmatch\b/,
  /\bprintln!\s*\(/,
  /\bformat!\s*\(/,
  /\bvec!\s*\[/,
  /\bpub\b/,
  /\bmod\b/,
  /\basync\b/,
  /->/,
  /::/,
  /#\[/,
  /\.await\b/,
  /\bconst\b/,
  /\bSome\s*\(/,
  /\bOk\s*\(/,
  /\bResult\b/,
  /\bOption\b/,
];

const NON_RUST = [
  /^\s*\[(package|dependencies|build-dependencies|dev-dependencies|workspace|features|profile|Unit|Service|Install)\]/m,
  /^\s*(apiVersion|kind|metadata|spec):/m,
  /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|EXPLAIN|BEGIN|COMMIT|WITH)\b/im,
  /^\s*\$ /m,
  /^\s*(cargo|rustup|docker|kubectl|helm|git|curl|openssl|psql|redis-cli|npm|pnpm|node|pgbackrest|systemctl|journalctl|nginx|wrk|oha|k6)\s/m,
  /^\s*FROM\s+\S+/m,
  /^\s*\{\s*"[\w-]+"\s*:/m,
  /^\s*(HTTP\/\d|GET\s+\/|POST\s+\/|PUT\s+\/|DELETE\s+\/|PATCH\s+\/)/m,
  /^\s*(Content-Type|Authorization|Accept|Cache-Control|User-Agent|X-[A-Za-z-]+):/m,
  /^\s*(import|export)\s/m,
  /^\s*(npm|npx|yarn|pnpm|wasm-pack|trunk|vite|rollup|webpack)\s/m,
  /^\s*<[a-z!]/m,
  /^\s*crates\//m,
  /^\s*include\s+\S+/m,
  /^[A-Z][A-Za-z0-9 _./-]*:$/m,
  /^\s*[A-Z][A-Za-z0-9 _./-]+\s*$/m,
];

const EXTERNAL_USE = /^\s*(?:pub\s+)?use\s+([a-zA-Z_]\w*)/gm;
const EXTERNAL_PATH = /\b([a-z][a-z0-9_]*)::/g;
const STD_CRATES = new Set(['std', 'core', 'alloc', 'self', 'super', 'crate']);

function looksRust(code) {
  return RUST_MARKERS.some((pattern) => pattern.test(code));
}

function looksNonRust(code) {
  return NON_RUST.some((pattern) => pattern.test(code));
}

function isPseudo(code) {
  return /\.\.\.|…|\bTODO\b|\bFIXME\b|\bplaceholder\b|<\s*[a-z][a-z0-9_-]*\s*>/.test(code);
}

/** Share of lines that look like Rust syntax rather than prose/config. */
function rustDensity(code) {
  const lines = code.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return 0;
  const rustish = lines.filter((line) => (
    /[;{}]/.test(line)
    || /^(#\[|#!\[|\/\/|\/\*|\*|pub\b|impl\b|fn\b|let\b|use\b|mod\b|struct\b|enum\b|trait\b|match\b|const\b|static\b|type\b|where\b|async\b|extern\b|macro_rules!|unsafe\b)/.test(line)
    || /^\s*[\w"'(].*[;{}]\s*$/.test(line)
  )).length;
  return rustish / lines.length;
}

function isSelfContainedProgram(code) {
  if (!/\bfn\s+main\s*\(/.test(code)) return false;
  if (/\bextern\s+crate\b/.test(code)) return false;
  if (/#\[\s*(tokio|async_std|actix|axum|warp|rocket|embassy|rtic)::/.test(code)) return false;
  EXTERNAL_USE.lastIndex = 0;
  let match;
  while ((match = EXTERNAL_USE.exec(code)) !== null) {
    if (!STD_CRATES.has(match[1])) return false;
  }
  // Crate paths are snake_case; local types are CamelCase. A snake_case path
  // segment other than std/core/alloc means an external crate is referenced.
  EXTERNAL_PATH.lastIndex = 0;
  while ((match = EXTERNAL_PATH.exec(code)) !== null) {
    const segment = match[1];
    if (STD_CRATES.has(segment)) continue;
    if (/^[a-z][a-z0-9_]*$/.test(segment) && segment.length > 1) return false;
  }
  return true;
}

function hash(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (error) {
    return fallback;
  }
}

function writeJson(file, value) {
  try { fs.writeFileSync(file, JSON.stringify(value)); } catch (error) { /* optional */ }
}

function runTool(command, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stderr: String(stderr || (error && error.message) || '') });
    });
  });
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-academy-snippets-'));

function writeTemp(name, content) {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, content);
  return file;
}

function firstLine(text) {
  const line = String(text || '').split('\n').map((part) => part.trim()).find(Boolean);
  return line || 'parse error';
}

async function parseCheck(source, cache, id) {
  const key = 'fmt:' + hash(source);
  if (cache[key]) return cache[key];
  const file = writeTemp(id + '.rs', source);
  const result = await runTool('rustfmt', ['--edition', '2021', '--emit', 'stdout', file]);
  const entry = result.ok ? { ok: true } : { ok: false, error: firstLine(result.stderr) };
  cache[key] = entry;
  return entry;
}

async function compileCheck(source, cache, id) {
  const key = 'rustc:' + hash(source);
  if (cache[key]) return cache[key];
  const file = writeTemp(id + '.rs', source);
  const out = path.join(tmpDir, id + '.rmeta');
  const result = await runTool('rustc', [
    '--edition', '2021', '--crate-type', 'lib', '--emit', 'metadata',
    '--cap-lints', 'allow', '-o', out, file,
  ]);
  const entry = result.ok ? { ok: true } : { ok: false, error: firstLine(result.stderr) };
  cache[key] = entry;
  return entry;
}

function variants(code) {
  const trimmed = code.trim();
  return [
    { mode: 'module', source: trimmed + '\n' },
    { mode: 'fn-main', source: 'fn main() {\n' + trimmed + '\n}\n' },
    { mode: 'mod-block', source: 'mod snippet {\n' + trimmed + '\n}\n' },
  ];
}

async function checkOne(snippet, cache, index) {
  const code = snippet.code;
  if (isPseudo(code)) return { status: 'skipped', reason: 'pseudo-code' };
  if (!looksRust(code)) return { status: 'skipped', reason: 'not Rust' };
  if (looksNonRust(code)) return { status: 'skipped', reason: 'mixed/non-Rust block' };
  if (!/\bfn\s+main\s*\(/.test(code) && rustDensity(code) < 0.45) {
    return { status: 'skipped', reason: 'prose/partial non-Rust block' };
  }

  const id = 'snippet-' + index;
  let parsed = null;
  for (const variant of variants(code)) {
    const result = await parseCheck(variant.source, cache, id + '-' + variant.mode);
    if (result.ok) { parsed = variant; break; }
    parsed = parsed || { mode: variant.mode, error: result.error };
  }
  if (!parsed || parsed.error) {
    return { status: 'failed', check: 'parse', error: parsed ? parsed.error : 'parse error' };
  }

  const compiledSource = parsed.mode === 'module' ? code.trim() + '\n'
    : parsed.mode === 'fn-main' ? 'fn main() {\n' + code.trim() + '\n}\n'
    : 'mod snippet {\n' + code.trim() + '\n}\n';

  // Only runnable artefacts are compiled: exercise solutions and cheatsheet
  // snippets. Section snippets may depend on definitions from earlier sections.
  const compilable = parsed.mode === 'module'
    && (snippet.kind === 'solution' || snippet.kind === 'cheatsheet')
    && isSelfContainedProgram(code);
  if (compilable) {
    const compiled = await compileCheck(compiledSource, cache, id + '-compile');
    if (!compiled.ok) return { status: 'failed', check: 'compile', error: compiled.error };
    return { status: 'compiled', mode: parsed.mode };
  }
  return { status: 'parsed', mode: parsed.mode };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function failureKey(failure) {
  return [failure.snippet.track, failure.snippet.lesson, failure.snippet.where, failure.result.check].join(' | ');
}

export async function checkSnippets(options = {}) {
  const { TRACK_FILES } = await import(pathToFileURL(path.join(dataDir, 'index.mjs')).href + '?v=' + STAMP);
  const cache = readJson(cacheFile, {});
  const snippets = [];

  for (const name of TRACK_FILES) {
    if (options.track && name !== options.track) continue;
    const track = (await import(pathToFileURL(path.join(dataDir, name + '.mjs')).href + '?v=' + STAMP)).default;
    for (const lesson of track.lessons) {
      for (const section of lesson.sections || []) {
        if (section.code) {
          snippets.push({ track: name, lesson: lesson.id, kind: 'section', where: 'section "' + section.h + '"', code: section.code });
        }
      }
      if (lesson.exercise) {
        snippets.push({ track: name, lesson: lesson.id, kind: 'starter', where: 'exercise starter', code: lesson.exercise.starter });
        snippets.push({ track: name, lesson: lesson.id, kind: 'solution', where: 'exercise solution', code: lesson.exercise.solution });
      }
    }
  }
  const reference = await import(pathToFileURL(path.join(dataDir, 'reference.mjs')).href + '?v=' + STAMP);
  for (const group of reference.CHEATSHEET || []) {
    for (const item of group.items || []) {
      if (item.code) {
        snippets.push({ track: 'cheatsheet', lesson: group.title, kind: 'cheatsheet', where: 'cheatsheet "' + item.name + '"', code: item.code });
      }
    }
  }

  const selected = options.limit > 0 ? snippets.slice(0, options.limit) : snippets;
  const results = await mapLimit(selected, 8, (snippet, index) => checkOne(snippet, cache, index));
  writeJson(cacheFile, cache);

  const stats = { total: selected.length, parsed: 0, compiled: 0, skipped: 0, failed: 0 };
  const failures = [];
  results.forEach((result, index) => {
    if (result.status === 'failed') {
      stats.failed += 1;
      failures.push({ snippet: selected[index], result });
    } else if (result.status === 'skipped') stats.skipped += 1;
    else if (result.status === 'compiled') stats.compiled += 1;
    else stats.parsed += 1;
  });

  const baseline = readJson(baselineFile, { known: [] });
  const known = new Set(Array.isArray(baseline.known) ? baseline.known : []);
  const keys = failures.map(failureKey);
  const newFailures = failures.filter((failure) => !known.has(failureKey(failure)));
  const stale = [...known].filter((key) => !keys.includes(key));

  if (options.updateBaseline) {
    writeJson(baselineFile, { updatedAt: new Date().toISOString(), known: keys.sort() });
  }

  console.log('snippets: ' + stats.total + ' total, ' + stats.parsed + ' parsed, ' +
    stats.compiled + ' compiled, ' + stats.skipped + ' skipped, ' + stats.failed + ' failed' +
    (known.size ? ' (' + newFailures.length + ' new vs baseline)' : ''));

  for (const failure of newFailures.slice(0, 25)) {
    const where = failure.snippet.track + '/' + failure.snippet.lesson + ' (' + failure.snippet.where + ')';
    console.log('  FAIL [' + failure.result.check + '] ' + where + ': ' + failure.result.error);
  }
  if (newFailures.length > 25) console.log('  ... and ' + (newFailures.length - 25) + ' more');
  if (newFailures.length === 0 && failures.length > 0) {
    console.log('  ' + failures.length + ' known context-dependent snippets baselined (.snippet-baseline.json)');
  }
  if (stale.length > 0 && !options.updateBaseline) {
    console.log('  NOTE ' + stale.length + ' baseline entries no longer fail; run --update-baseline to refresh');
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (error) { /* best effort */ }

  let exitCode = 0;
  if (options.strict) exitCode = failures.length > 0 ? 1 : 0;
  else if (options.baseline) exitCode = newFailures.length > 0 ? 1 : 0;

  return { ...stats, failures, newFailures, stale, exitCode };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const trackIndex = args.indexOf('--track');
  const limitIndex = args.indexOf('--limit');
  const result = await checkSnippets({
    strict: args.includes('--strict'),
    baseline: args.includes('--baseline'),
    updateBaseline: args.includes('--update-baseline'),
    track: trackIndex > -1 ? args[trackIndex + 1] : null,
    limit: limitIndex > -1 ? Number(args[limitIndex + 1]) : 0,
  });
  process.exit(result.exitCode);
}
