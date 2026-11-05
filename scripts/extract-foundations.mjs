// One-off: extract the v1 curriculum from client.js into src/data/foundations.mjs.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '..');
const src = fs.readFileSync(path.join(root, 'client.js'), 'utf8');

const a = src.indexOf('const STAGES = ');
const b = src.indexOf('const LESSONS = ');
const c = src.indexOf('const LESSON_BY_ID');
if (a < 0 || b < 0 || c < 0) throw new Error('markers not found');

const stagesSrc = src.slice(a + 'const STAGES = '.length, b).trim().replace(/;\s*$/, '');
const lessonsSrc = src.slice(b + 'const LESSONS = '.length, c).trim().replace(/;\s*$/, '');

const sandbox = {};
const { STAGES, LESSONS } = vm.runInNewContext('const STAGES = ' + stagesSrc + ';\nconst LESSONS = ' + lessonsSrc + ';\n({ STAGES, LESSONS })', sandbox);


const lessons = LESSONS.map((lesson) => {
  const { stage, ...rest } = lesson;
  const level = stage <= 1 ? 'core' : stage <= 3 ? 'advanced' : 'industry';
  return { ...rest, level };
});

const track = {
  key: 'foundations',
  title: 'Rust fundamentals',
  blurb: 'The language itself: ownership, types, traits, async basics, and the habits that make Rust code maintainable.',
  level: 'core',
  project: {
    title: 'Capstone: a production-grade CLI toolkit',
    brief: 'Build a small but complete command-line toolkit that reads files, validates input, reports errors with context, is covered by tests, and ships as a single binary.',
    deliverables: [
      'A clap-based CLI with subcommands and helpful --help output',
      'Errors that carry context and exit with meaningful codes',
      'Unit and integration tests, formatted and clippy-clean',
      'A GitHub Actions workflow that builds and tests on every push',
    ],
    stack: ['clap', 'anyhow', 'thiserror', 'serde', 'tracing'],
  },
  lessons,
};

const header = `/**
 * Rust fundamentals track.
 *
 * Authored for the Rust Academy plugin. Every lesson is plain JSON-compatible
 * data consumed by src/app.js through build.mjs.
 */
`;

fs.writeFileSync(path.join(root, 'src/data/foundations.mjs'), header + 'export default ' + JSON.stringify(track, null, 2) + ';\n');
console.log('wrote src/data/foundations.mjs with', lessons.length, 'lessons');
