#!/usr/bin/env node
/**
 * Validate one Rust Academy data module.
 *
 *   node scripts/validate-data.mjs src/data/web.mjs
 *   node scripts/validate-data.mjs src/data/reference.mjs
 *
 * Exit code 0 = valid, 1 = errors. Warnings never fail the run.
 */
import path from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/validate-data.mjs <src/data/file.mjs>');
  process.exit(2);
}

const abs = path.resolve(target);
const isReference = /reference\.mjs$/.test(abs);
const mod = await import(new URL('file://' + abs).href + '?t=' + Date.now());
const errors = [];
const warnings = [];
const LEVELS = new Set(['core', 'advanced', 'industry']);
const KINDS = new Set(['docs', 'repo', 'paper', 'video', 'article']);
const CANONICAL = [
  'docs.rs', 'crates.io', 'tokio.rs', 'rust-lang.org', 'github.com',
  'kubernetes.io', 'open-telemetry.io', 'opentelemetry.io',
  'sqlx.rs', 'redis.io', 'kafka.apache.org', 'nats.io', 'grpc.io', 'docker.com',
  'docs.docker.com', 'postgresql.org', 'docs.aws.amazon.com', 'amazonaws.com',
  'man7.org', 'docs.kernel.org', 'rust-lang.github.io', 'github.blog',
  'youtube.com', 'youtu.be', 'arxiv.org', 'usenix.org', 'dl.acm.org',
  'raft.github.io', 'research.google', 'cacm.acm.org', 'infoq.com',
  'developer.mozilla.org', 'webassembly.org', 'wasm-bindgen.github.io',
  'embassy.dev', 'docs.embassy.dev', 'rtic.rs', 'cortex-m.rs',
];

function fail(where, message) { errors.push(where + ': ' + message); }
function warn(where, message) { warnings.push(where + ': ' + message); }

function checkString(value, where, min, max) {
  if (typeof value !== 'string') { fail(where, 'must be a string'); return false; }
  if (value.trim().length < min) fail(where, 'shorter than ' + min + ' chars');
  if (value.length > max) fail(where, 'longer than ' + max + ' chars');
  return true;
}

function checkUrl(value, where, hostFilter) {
  if (typeof value !== 'string' || !/^https:\/\/[^\s]+$/.test(value)) {
    fail(where, 'must be an https URL');
    return;
  }
  let host;
  try { host = new URL(value).hostname.replace(/^www\./, ''); } catch { fail(where, 'invalid URL'); return; }
  if (hostFilter && !(host === hostFilter || host.endsWith('.' + hostFilter))) {
    fail(where, 'must be a ' + hostFilter + ' URL');
  }
  if (!CANONICAL.some((domain) => host === domain || host.endsWith('.' + domain))) {
    warn(where, 'non-canonical host "' + host + '"');
  }
}

function checkResources(lesson, where) {
  if (lesson.resources === undefined) { warn(where, 'no resources[]'); return; }
  if (!Array.isArray(lesson.resources)) { fail(where + '.resources', 'must be an array'); return; }
  if (lesson.resources.length < 2 || lesson.resources.length > 6) fail(where + '.resources', 'must have 2-6 entries');
  lesson.resources.forEach((resource, i) => {
    const at = where + '.resources[' + i + ']';
    if (!resource || typeof resource !== 'object') { fail(at, 'must be an object'); return; }
    checkString(resource.title, at + '.title', 4, 120);
    checkUrl(resource.url, at + '.url');
    if (resource.kind !== undefined && !KINDS.has(resource.kind)) {
      fail(at + '.kind', 'must be docs|repo|paper|video|article');
    }
  });
  const kinds = new Set(lesson.resources.map((resource) => resource && resource.kind).filter(Boolean));
  if (kinds.size === 0) warn(where + '.resources', 'no resource kinds (docs|repo|paper|video) — UI badges stay generic');
}

function checkQuestions(lesson, where) {
  if (lesson.questions === undefined) { warn(where, 'no questions[] (quiz)'); return; }
  if (!Array.isArray(lesson.questions)) { fail(where + '.questions', 'must be an array'); return; }
  if (lesson.questions.length < 1 || lesson.questions.length > 6) fail(where + '.questions', 'must have 1-6 questions');
  lesson.questions.forEach((question, i) => {
    const at = where + '.questions[' + i + ']';
    if (!question || typeof question !== 'object') { fail(at, 'must be an object'); return; }
    checkString(question.q, at + '.q', 10, 400);
    if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 5) {
      fail(at + '.options', 'must have 2-5 options');
    } else {
      question.options.forEach((option, oi) => checkString(option, at + '.options[' + oi + ']', 1, 240));
      if (!Number.isInteger(question.answer) || question.answer < 0 || question.answer >= question.options.length) {
        fail(at + '.answer', 'must be an index into options');
      }
    }
    checkString(question.explain, at + '.explain', 10, 500);
  });
}

function checkQuickbytes(lesson, where) {
  if (lesson.quickbytes === undefined) return;
  if (!Array.isArray(lesson.quickbytes)) { fail(where + '.quickbytes', 'must be an array'); return; }
  if (lesson.quickbytes.length < 1 || lesson.quickbytes.length > 6) fail(where + '.quickbytes', 'must have 1-6 items');
  lesson.quickbytes.forEach((item, i) => checkString(item, where + '.quickbytes[' + i + ']', 5, 300));
}

function checkGithub(lesson, where) {
  if (lesson.github === undefined) return;
  if (!Array.isArray(lesson.github)) { fail(where + '.github', 'must be an array'); return; }
  if (lesson.github.length < 1 || lesson.github.length > 3) fail(where + '.github', 'must have 1-3 entries');
  lesson.github.forEach((repo, i) => {
    const at = where + '.github[' + i + ']';
    if (!repo || typeof repo !== 'object') { fail(at, 'must be an object'); return; }
    checkString(repo.name, at + '.name', 2, 100);
    checkUrl(repo.url, at + '.url', 'github.com');
  });
}

function checkLesson(lesson, index, expectedPrefix) {
  const where = 'lessons[' + index + ']';
  if (!lesson || typeof lesson !== 'object') { fail(where, 'must be an object'); return; }
  if (typeof lesson.id !== 'string' || !new RegExp('^' + expectedPrefix + '\\d{2}$').test(lesson.id)) {
    fail(where + '.id', 'must match ' + expectedPrefix + 'NN');
  }
  checkString(lesson.title, where + '.title', 5, 90);
  if (!Number.isInteger(lesson.minutes) || lesson.minutes < 15 || lesson.minutes > 180) fail(where + '.minutes', 'must be an integer 15-180');
  if (lesson.level !== undefined && !LEVELS.has(lesson.level)) fail(where + '.level', 'must be core|advanced|industry');
  checkString(lesson.goal, where + '.goal', 10, 260);

  if (!Array.isArray(lesson.sections) || lesson.sections.length < 2 || lesson.sections.length > 6) {
    fail(where + '.sections', 'must have 2-6 sections');
  } else {
    lesson.sections.forEach((section, si) => {
      const at = where + '.sections[' + si + ']';
      if (!section || typeof section !== 'object') { fail(at, 'must be an object'); return; }
      checkString(section.h, at + '.h', 3, 90);
      if (!Array.isArray(section.p) || section.p.length < 1 || section.p.length > 4) {
        fail(at + '.p', 'must be an array of 1-4 paragraphs');
      } else {
        section.p.forEach((paragraph, pi) => checkString(paragraph, at + '.p[' + pi + ']', 20, 900));
      }
      if (section.list !== undefined) {
        if (!Array.isArray(section.list) || section.list.length < 2) fail(at + '.list', 'must be an array of >= 2 items');
        else section.list.forEach((item, li) => checkString(item, at + '.list[' + li + ']', 4, 300));
      }
      if (section.code !== undefined) checkString(section.code, at + '.code', 10, 6000);
      if (section.tip !== undefined) checkString(section.tip, at + '.tip', 10, 400);
    });
  }

  const exercise = lesson.exercise;
  if (!exercise || typeof exercise !== 'object') {
    fail(where + '.exercise', 'must be an object');
  } else {
    checkString(exercise.prompt, where + '.exercise.prompt', 15, 400);
    checkString(exercise.starter, where + '.exercise.starter', 10, 3000);
    checkString(exercise.hint, where + '.exercise.hint', 10, 400);
    checkString(exercise.solution, where + '.exercise.solution', 10, 4000);
  }

  checkQuestions(lesson, where);
  checkQuickbytes(lesson, where);
  checkGithub(lesson, where);

  if (lesson.production !== undefined) {
    if (!Array.isArray(lesson.production) || lesson.production.length < 2 || lesson.production.length > 6) {
      fail(where + '.production', 'must be an array of 2-6 checklist items');
    } else {
      lesson.production.forEach((item, pi) => checkString(item, where + '.production[' + pi + ']', 10, 240));
    }
  }
  if (lesson.crates !== undefined) {
    if (!Array.isArray(lesson.crates)) fail(where + '.crates', 'must be an array');
    else lesson.crates.forEach((name, ci) => checkString(name, where + '.crates[' + ci + ']', 1, 60));
  }
  if (lesson.pitfall !== undefined) checkString(lesson.pitfall, where + '.pitfall', 10, 400);
  checkResources(lesson, where);
}

function validateTrack(track, prefix) {
  if (!track || typeof track !== 'object') { fail('default export', 'must be an object'); return; }
  if (typeof track.key !== 'string' || !/^[a-z][a-z0-9-]*$/.test(track.key)) fail('key', 'must be lowercase kebab-case');
  if (track.key !== path.basename(abs, '.mjs')) fail('key', 'must match the file name "' + path.basename(abs, '.mjs') + '"');
  if (track.prefix !== undefined) {
    if (typeof track.prefix !== 'string' || !/^[a-z]{1,2}$/.test(track.prefix)) fail('prefix', 'must be 1-2 lowercase letters');
    else if (prefix !== undefined && prefix !== track.prefix) fail('prefix', 'declared "' + track.prefix + '" but filename expects "' + prefix + '"');
    else prefix = track.prefix;
  }
  checkString(track.title, 'title', 4, 60);
  checkString(track.blurb, 'blurb', 20, 240);
  if (!LEVELS.has(track.level)) fail('level', 'must be core|advanced|industry');
  if (track.project !== undefined) {
    const p = track.project;
    if (!p || typeof p !== 'object') fail('project', 'must be an object');
    else {
      checkString(p.title, 'project.title', 4, 90);
      checkString(p.brief, 'project.brief', 30, 600);
      if (!Array.isArray(p.deliverables) || p.deliverables.length < 2) fail('project.deliverables', 'must be an array of >= 2 items');
      else p.deliverables.forEach((d, i) => checkString(d, 'project.deliverables[' + i + ']', 8, 300));
      if (!Array.isArray(p.stack) || p.stack.length < 1) fail('project.stack', 'must be an array of crate names');
      else p.stack.forEach((s, i) => checkString(s, 'project.stack[' + i + ']', 1, 60));
    }
  }
  if (!Array.isArray(track.lessons) || track.lessons.length < 1) { fail('lessons', 'must be a non-empty array'); return; }
  const seen = new Set();
  track.lessons.forEach((lesson, index) => {
    checkLesson(lesson, index, prefix);
    if (lesson && typeof lesson.id === 'string') {
      if (seen.has(lesson.id)) fail('lessons[' + index + '].id', 'duplicate id ' + lesson.id);
      seen.add(lesson.id);
    }
  });
  try {
    const json = JSON.stringify(track);
    if (!json || json.length < 100) fail('track', 'serialized data is suspiciously small');
  } catch (error) {
    fail('track', 'not JSON-serializable: ' + error.message);
  }
}

function validateReference(data) {
  const { CHEATSHEET, BLUEPRINTS } = data;
  if (!Array.isArray(CHEATSHEET) || CHEATSHEET.length < 10) fail('CHEATSHEET', 'must have >= 10 groups');
  else {
    CHEATSHEET.forEach((group, gi) => {
      const at = 'CHEATSHEET[' + gi + ']';
      checkString(group.title, at + '.title', 4, 60);
      if (!Array.isArray(group.items) || group.items.length < 2) fail(at + '.items', 'must have >= 2 items');
      else group.items.forEach((item, ii) => {
        checkString(item.name, at + '.items[' + ii + '].name', 3, 60);
        checkString(item.code, at + '.items[' + ii + '].code', 3, 1200);
      });
    });
  }
  if (!Array.isArray(BLUEPRINTS) || BLUEPRINTS.length < 6) fail('BLUEPRINTS', 'must have >= 6 blueprints');
  else {
    BLUEPRINTS.forEach((blueprint, bi) => {
      const at = 'BLUEPRINTS[' + bi + ']';
      checkString(blueprint.id, at + '.id', 3, 60);
      checkString(blueprint.title, at + '.title', 5, 90);
      checkString(blueprint.summary, at + '.summary', 40, 600);
      if (!Array.isArray(blueprint.stack) || blueprint.stack.length < 2) fail(at + '.stack', 'must have >= 2 crates');
      else blueprint.stack.forEach((s, si) => checkString(s, at + '.stack[' + si + ']', 1, 60));
      if (!Array.isArray(blueprint.flow) || blueprint.flow.length < 3) fail(at + '.flow', 'must have >= 3 numbered steps');
      else blueprint.flow.forEach((f, fi) => checkString(f, at + '.flow[' + fi + ']', 10, 400));
      if (!Array.isArray(blueprint.checklist) || blueprint.checklist.length < 3) fail(at + '.checklist', 'must have >= 3 items');
      else blueprint.checklist.forEach((c, ci) => checkString(c, at + '.checklist[' + ci + ']', 8, 300));
      if (!Array.isArray(blueprint.lessons) || blueprint.lessons.length < 2) fail(at + '.lessons', 'must reference >= 2 lesson ids');
      else blueprint.lessons.forEach((id, li) => {
        if (typeof id !== 'string' || !/^[a-z]{1,2}\d{2}$/.test(id)) fail(at + '.lessons[' + li + ']', 'must look like w02 / d01 / s03');
      });
      if (!Array.isArray(blueprint.resources) || blueprint.resources.length < 1) warn(at + '.resources', 'add 1-3 canonical links');
      else blueprint.resources.forEach((resource, ri) => {
        checkString(resource.title, at + '.resources[' + ri + '].title', 4, 120);
        checkUrl(resource.url, at + '.resources[' + ri + '].url');
        if (resource.kind !== undefined && !KINDS.has(resource.kind)) fail(at + '.resources[' + ri + '].kind', 'invalid kind');
      });
    });
  }
  try { JSON.stringify(data); } catch (error) { fail('reference', 'not JSON-serializable: ' + error.message); }
}

if (isReference) {
  validateReference(mod);
} else {
  const fallback = { foundations: 'l', web: 'w', data: 'd', services: 's', processes: 'p', production: 'g' }[path.basename(abs, '.mjs')];
  validateTrack(mod.default, fallback);
}

for (const message of warnings) console.warn('WARN  ' + message);
for (const message of errors) console.error('ERROR ' + message);

const lessons = isReference ? null : (mod.default && mod.default.lessons ? mod.default.lessons.length : 0);
console.log(isReference
  ? 'reference.mjs: ' + (mod.CHEATSHEET || []).length + ' cheatsheet groups, ' + (mod.BLUEPRINTS || []).length + ' blueprints'
  : (mod.default && mod.default.key) + ': ' + lessons + ' lessons');

if (errors.length) {
  console.error('\n' + errors.length + ' error(s) — fix before the build.');
  process.exit(1);
}
console.log('OK  ' + path.relative(process.cwd(), abs));
