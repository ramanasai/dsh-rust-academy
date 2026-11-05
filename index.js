/**
 * Host half of the Rust Academy bundle.
 *
 * Provides an authenticated, sandboxed local Rust runner behind the
 * `config.enabled` flag (default off). The Client probes `/rust-academy/status`
 * and only offers the local option when this half answers.
 *
 * Execution model (single-file lessons, no crates):
 *   mkdtemp -> write main.rs -> sandboxed `rustc` -> sandboxed binary
 *   -> bounded output, wall-clock deadline, temp dir removed.
 *
 * Security posture: the sandbox confines FILE WRITES only. Local code can still
 * read the user's files and use the network, so this is opt-in and never exposed
 * as an agent tool. Auth is enforced per request via ctx.connection.
 */
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROUTE = '/rust-academy';
const EDITIONS = new Set(['2015', '2018', '2021', '2024']);
const MAX_CODE_BYTES = 200 * 1024;
const OUTPUT_CAP = 64 * 1024;
const SPILL_CAP = 1024 * 1024;
const COMPILE_MS = 15000;
const RUN_MS = 5000;
const GRACE_MS = 1000;
const MAX_PARALLEL = 2;
const TEMP_PREFIX = 'dsh-rust-';
let dataPayloadPromise = null;

export const inject = ['webServer'];

export function apply(ctx, config = {}) {
  // Course data is static public content: serve it without the runner flag so
  // the panel can lazy-load the curriculum even when local execution is off.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE + '/data.json',
    handler: dataHandler,
  }), 'rust-academy: course data route');

  // Hand-validated on purpose: plugin packages cannot resolve schemastery here.
  if (!config || config.enabled !== true) return;

  const handles = new Set();
  const dirs = new Set();
  let running = 0;

  ctx.effect(() => () => {
    for (const handle of handles) {
      try { handle.terminate(); } catch (error) { /* already gone */ }
    }
    for (const dir of dirs) {
      rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    handles.clear();
    dirs.clear();
  }, 'rust-academy: stop local runners and clean temp dirs');

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler,
  }), 'rust-academy: local runner route');

  // Best-effort sweep of temp dirs left behind by a hard host crash.
  sweepStaleDirs().catch(() => {});

  async function handler(req, res) {
    const send = (status, body) => sendJson(res, status, body);

    // Auth: the webserver does not authenticate routes; the plugin must.
    const connection = ctx.get('connection');
    const rejection = connection ? connection.requestRejection({ headers: req.headers }) : 401;
    if (rejection !== undefined) {
      send(rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' });
      return;
    }

    const pathname = new URL(req.url || '/', 'http://rust-academy.invalid').pathname;
    if (pathname === ROUTE + '/status' && req.method === 'GET') {
      send(200, { enabled: true, running, maxParallel: MAX_PARALLEL });
      return;
    }
    if (pathname !== ROUTE + '/run' || req.method !== 'POST') {
      send(404, { error: 'not found' });
      return;
    }
    if (running >= MAX_PARALLEL) {
      send(429, { error: 'busy: too many local runs in flight' });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(await readBody(req, MAX_CODE_BYTES + 4096));
    } catch (error) {
      send(400, { error: 'body must be JSON under ' + MAX_CODE_BYTES + ' bytes' });
      return;
    }
    const code = typeof payload.code === 'string' ? payload.code : '';
    if (code.trim() === '' || Buffer.byteLength(code) > MAX_CODE_BYTES) {
      send(400, { error: 'code must be between 1 byte and ' + MAX_CODE_BYTES + ' bytes' });
      return;
    }
    const edition = EDITIONS.has(payload.edition) ? payload.edition : '2021';

    const abort = new AbortController();
    req.on('aborted', () => abort.abort());
    res.on('close', () => abort.abort());
    running += 1;
    try {
      send(200, await execute(ctx, code, edition, dirs, handles, abort.signal));
    } catch (error) {
      send(500, { error: error && error.message ? error.message : String(error) });
    } finally {
      running -= 1;
    }
  }
}

function sendJson(res, status, body) {
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
  } catch (error) {
    /* connection already closed */
  }
}

async function dataHandler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  try {
    const payload = await buildCourseData();
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
  } catch (error) {
    sendJson(res, 500, { error: error && error.message ? error.message : 'failed to build course data' });
  }
}

async function buildCourseData() {
  if (dataPayloadPromise) return dataPayloadPromise;
  dataPayloadPromise = (async () => {
    const index = await import(new URL('./src/data/index.mjs', import.meta.url).href);
    const tracks = [];
    const lessons = [];
    let n = 0;
    for (const name of index.TRACK_FILES) {
      const mod = await import(new URL('./src/data/' + name + '.mjs', import.meta.url).href);
      const track = mod.default;
      const { lessons: trackLessons, ...meta } = track;
      const first = n + 1;
      const trackIndex = tracks.length;
      for (const lesson of trackLessons) {
        n += 1;
        lessons.push({ ...lesson, n, trackIndex, trackKey: track.key, trackTitle: track.title });
      }
      tracks.push({ ...meta, index: trackIndex, firstN: first, lastN: n, lessonCount: trackLessons.length });
    }
    const reference = await import(new URL('./src/data/reference.mjs', import.meta.url).href);
    return JSON.stringify({
      tracks,
      lessons,
      cheatsheet: reference.CHEATSHEET,
      blueprints: reference.BLUEPRINTS,
    });
  })();
  dataPayloadPromise = dataPayloadPromise.catch((error) => {
    dataPayloadPromise = null;
    throw error;
  });
  return dataPayloadPromise;
}

async function execute(ctx, code, edition, dirs, handles, signal) {
  const subprocess = ctx.get('subprocess');
  if (!subprocess) throw new Error('local runner unavailable: subprocess service missing');
  const rustc = await subprocess.resolveExecutable('rustc');
  const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  dirs.add(dir);
  const sandbox = ctx.get('sandbox');
  const policy = { mode: 'workspace-write', workspaceRoot: dir };
  const confine = async (argv) => {
    if (!sandbox) return argv;
    try {
      const confined = await sandbox.confine(argv, policy, signal);
      return confined && Array.isArray(confined.argv) ? confined.argv : argv;
    } catch (error) {
      throw new Error('sandbox unavailable: ' + (error && error.message ? error.message : String(error)));
    }
  };

  try {
    await writeFile(join(dir, 'main.rs'), code, { mode: 0o600 });
    const binary = join(dir, 'prog');
    const buildArgv = await confine([rustc, '--edition', edition, '-O', '-o', binary, 'main.rs']);
    const build = await run(subprocess, handles, buildArgv, dir, COMPILE_MS, signal);
    if (build.exitCode !== 0) {
      return { success: false, phase: 'compile', ...build };
    }
    const programArgv = process.platform === 'win32'
      ? [binary]
      : ['/bin/sh', '-c', 'ulimit -t 5 2>/dev/null; ulimit -v 524288 2>/dev/null; exec "$0"', binary];
    const runArgv = await confine(programArgv);
    const result = await run(subprocess, handles, runArgv, dir, RUN_MS, signal);
    return { success: result.exitCode === 0, phase: 'run', ...result };
  } finally {
    dirs.delete(dir);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function run(subprocess, handles, argv, cwd, timeoutMs, outer) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;
  const handle = subprocess.spawn({
    argv,
    cwd,
    graceMs: GRACE_MS,
    signal,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: OUTPUT_CAP, spill: { maxBytes: SPILL_CAP } },
      stderr: { maxBytes: OUTPUT_CAP, spill: { maxBytes: SPILL_CAP } },
    },
  });
  handles.add(handle);
  try {
    const outcome = await handle.done;
    const stdout = handle.collected.stdout ? handle.collected.stdout.readFrom(0) : null;
    const stderr = handle.collected.stderr ? handle.collected.stderr.readFrom(0) : null;
    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut: timeout.aborted,
      stdout: stdout ? stdout.text : '',
      stderr: stderr ? stderr.text : '',
      truncated: Boolean((stdout && stdout.lossy) || (stderr && stderr.lossy)),
    };
  } finally {
    handles.delete(handle);
  }
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function sweepStaleDirs() {
  const base = tmpdir();
  const entries = await readdir(base, { withFileTypes: true });
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(TEMP_PREFIX)) continue;
    const target = join(base, entry.name);
    try {
      const info = await stat(target);
      if (info.mtimeMs < cutoff) await rm(target, { recursive: true, force: true });
    } catch (error) {
      /* raced with another cleanup */
    }
  }
}
