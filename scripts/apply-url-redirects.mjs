/**
 * Apply the safe URL updates discovered by the content audit.
 *
 *   node scripts/apply-url-redirects.mjs
 *
 * Reads .content-audit.json (movedUrls), then rewrites URLs in the data modules
 * for hosts where the redirect target is a stable canonical page. APId docs
 * that redirect to less specific pages (docs.aws.amazon.com user guide root,
 * docs.rs crate roots, docs.embassy.dev) are intentionally left alone.
 * Also fixes the tokio-util repository (it lives in the tokio repo).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '..');
const dataDir = path.join(root, 'src', 'data');
const audit = JSON.parse(fs.readFileSync(path.join(root, '.content-audit.json'), 'utf8'));

const SAFE_PREFIXES = [
  'https://github.com/',
  'https://developer.mozilla.org/',
  'https://rust-lang.github.io/rust-clippy/',
  'https://rust-lang.github.io/rustc-dev-guide/',
  'https://kafka.apache.org/',
  'https://docs.nats.io/',
  'https://docs.docker.com/',
  'https://kubernetes.io/',
  'https://research.google/',
];

const replacements = new Map();
for (const entry of audit.summary.movedUrls) {
  const [from, to] = entry.split(' -> ');
  if (!from || !to) continue;
  if (!SAFE_PREFIXES.some((prefix) => from.startsWith(prefix))) continue;
  // Skip redirects that lose information (repo -> org, or docs -> root).
  if (to.replace(/\/$/, '') === from.replace(/\/$/, '')) continue;
  replacements.set(from, to);
}
// tokio-util is maintained inside the tokio repository.
replacements.set('https://github.com/tokio-rs/tokio-util', 'https://github.com/tokio-rs/tokio');

const files = fs.readdirSync(dataDir).filter((name) => name.endsWith('.mjs') && name !== 'index.mjs' && name !== 'reference.mjs');
let changedFiles = 0;
let changedUrls = 0;

for (const file of files) {
  const filePath = path.join(dataDir, file);
  const mod = await import(pathToFileURL(filePath).href + '?v=' + Date.now());
  const track = mod.default;
  if (!track || !Array.isArray(track.lessons)) continue;
  let changed = false;
  for (const lesson of track.lessons) {
    for (const collection of [lesson.resources, lesson.github]) {
      for (const entry of collection || []) {
        if (entry && replacements.has(entry.url)) {
          entry.url = replacements.get(entry.url);
          changed = true;
          changedUrls += 1;
        }
      }
    }
  }
  if (changed) {
    const headerComment = '/**\n * ' + (track.title || 'Track') + ' track.\n *\n * Authored for the Rust Academy plugin. Every lesson is plain JSON-compatible\n * data consumed by src/app.js through build.mjs.\n */\n';
    fs.writeFileSync(filePath, headerComment + 'export default ' + JSON.stringify(track, null, 2) + ';\n');
    changedFiles += 1;
  }
}

console.log('url redirects applied: ' + changedUrls + ' in ' + changedFiles + ' track files');
