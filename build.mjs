#!/usr/bin/env node
/**
 * Assemble client.js from src/app.js + the track data modules.
 *
 *   node build.mjs
 *
 * The shipped client.js is generated and committed; the Harness serves it as
 * the package's Client module. Every data module is JSON-serialized into the
 * factory, so the runtime needs no fetch, build tool, or filesystem access.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname);
const dataDir = path.join(here, 'src', 'data');
const FALLBACK_PREFIX = { foundations: 'l', web: 'w', data: 'd', services: 's', processes: 'p', production: 'g' };
const stamp = Date.now();

const indexFile = path.join(dataDir, 'index.mjs');
const { TRACK_FILES } = await import(pathToFileURL(indexFile).href + '?v=' + stamp);
if (!Array.isArray(TRACK_FILES) || TRACK_FILES.length === 0) {
  console.error('build: src/data/index.mjs must export TRACK_FILES');
  process.exit(1);
}

const tracks = [];
const seenKeys = new Set();

for (const name of TRACK_FILES) {
  const file = path.join(dataDir, name + '.mjs');
  if (!fs.existsSync(file)) {
    console.error('build: missing data module ' + file + ' (listed in src/data/index.mjs)');
    process.exit(1);
  }
  const mod = await import(pathToFileURL(file).href + '?v=' + stamp);
  const track = mod.default;
  if (!track || !Array.isArray(track.lessons) || track.lessons.length === 0) {
    console.error('build: ' + name + '.mjs has no default track with lessons');
    process.exit(1);
  }
  if (track.key !== name) {
    console.error('build: ' + name + '.mjs key is "' + track.key + '", expected "' + name + '"');
    process.exit(1);
  }
  if (seenKeys.has(track.key)) {
    console.error('build: duplicate track key ' + track.key);
    process.exit(1);
  }
  seenKeys.add(track.key);
  const prefix = track.prefix || FALLBACK_PREFIX[name];
  if (!prefix) {
    console.error('build: ' + name + ' needs a "prefix" field (1-2 letters)');
    process.exit(1);
  }
  for (const lesson of track.lessons) {
    if (!new RegExp('^' + prefix + '\\d{2}$').test(lesson.id)) {
      console.error('build: ' + name + ' has invalid lesson id "' + lesson.id + '" (expected ' + prefix + 'NN)');
      process.exit(1);
    }
  }
  tracks.push({ ...track, prefix });
}

const referenceFile = path.join(dataDir, 'reference.mjs');
if (!fs.existsSync(referenceFile)) {
  console.error('build: missing data module ' + referenceFile);
  process.exit(1);
}
const reference = await import(pathToFileURL(referenceFile).href + '?v=' + stamp);
const CHEATSHEET = reference.CHEATSHEET;
const BLUEPRINTS = reference.BLUEPRINTS;
if (!Array.isArray(CHEATSHEET) || !Array.isArray(BLUEPRINTS)) {
  console.error('build: reference.mjs must export CHEATSHEET and BLUEPRINTS arrays');
  process.exit(1);
}

const seen = new Set();
const lessons = [];
let n = 0;

const trackMeta = tracks.map((track, trackIndex) => {
  const { lessons: trackLessons, ...meta } = track;
  const first = n + 1;
  for (const lesson of trackLessons) {
    if (seen.has(lesson.id)) {
      console.error('build: duplicate lesson id ' + lesson.id);
      process.exit(1);
    }
    seen.add(lesson.id);
    n += 1;
    lessons.push({ ...lesson, n, trackIndex, trackKey: track.key, trackTitle: track.title });
  }
  return { ...meta, index: trackIndex, firstN: first, lastN: n, lessonCount: trackLessons.length };
});

const dataSource = [
  'const TRACKS = ' + JSON.stringify(trackMeta) + ';',
  'const LESSONS = ' + JSON.stringify(lessons) + ';',
  'const CHEATSHEET = ' + JSON.stringify(CHEATSHEET) + ';',
  'const BLUEPRINTS = ' + JSON.stringify(BLUEPRINTS) + ';',
  'const TOTAL = LESSONS.length;',
].join('\n    ');

const template = fs.readFileSync(path.join(here, 'src', 'app.js'), 'utf8');
if (!template.includes('/*@DATA@*/')) {
  console.error('build: src/app.js is missing the /*@DATA@*/ marker');
  process.exit(1);
}
// Function replacement: the JSON contains "$" sequences (shell prompts, ${...}
// configs) that String.replace would otherwise treat as replacement patterns.
const output = template.replace('/*@DATA@*/', () => dataSource);
fs.writeFileSync(path.join(here, 'client.js'), output);

const bytes = Buffer.byteLength(output);
console.log('build: client.js written');
console.log('build: ' + tracks.length + ' tracks, ' + lessons.length + ' lessons, ' +
  CHEATSHEET.length + ' cheatsheet groups, ' + BLUEPRINTS.length + ' blueprints, ' +
  (bytes / 1024).toFixed(1) + ' KiB');
for (const track of trackMeta) {
  console.log('  - ' + track.key.padEnd(16) + String(track.lessonCount).padStart(3) + ' lessons  ' + track.title);
}

// Compiler gate: every Rust snippet must parse with rustfmt, and self-contained
// exercise solutions must compile with rustc. Known context-dependent snippets
// are baselined in .snippet-baseline.json; the build fails on new failures.
if (!process.argv.includes('--no-snippets')) {
  const gate = await import(pathToFileURL(path.join(here, 'scripts', 'compiler-gate.mjs')).href + '?v=' + stamp);
  const result = await gate.checkSnippets({ baseline: !process.argv.includes('--snippets-warn') });
  if (result.exitCode !== 0) {
    console.error('\nbuild: compiler gate failed — fix the snippets above, or run');
    console.error('       node scripts/compiler-gate.mjs --update-baseline to accept them.');
    process.exit(1);
  }
}
