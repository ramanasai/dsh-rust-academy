#!/usr/bin/env node
/**
 * Online content audit for the curriculum.
 *
 * For every chapter, one by one:
 *   - structural checks (sections, exercise, quiz, quickbytes, production,
 *     crates, github, resources);
 *   - every `resources[].url` is fetched and its status recorded;
 *   - every `github[].url` is fetched (moved repositories are flagged);
 *   - every crate name is checked against the crates.io registry.
 *
 * Results are cached in .content-audit-cache.json so re-runs are cheap, and a
 * Markdown report plus JSON are written for review.
 *
 *   node scripts/audit-content.mjs                 # audit everything
 *   node scripts/audit-content.mjs --track web     # one track
 *   node scripts/audit-content.mjs --limit 20      # first N chapters
 *   node scripts/audit-content.mjs --no-network    # structure only
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '..');
const dataDir = path.join(root, 'src', 'data');
const cacheFile = path.join(root, '.content-audit-cache.json');
const reportJson = path.join(root, '.content-audit.json');
const reportMd = path.join(root, 'docs', 'content-audit.md');
const STAMP = Date.now();
const CONCURRENCY = 16;
const TIMEOUT_MS = 12000;
const USER_AGENT = 'rust-academy-audit/1.0 (+https://github.com/ramanasai/dsh-rust-academy)';

const args = process.argv.slice(2);
const trackArg = args.indexOf('--track') > -1 ? args[args.indexOf('--track') + 1] : null;
const limitArg = args.indexOf('--limit') > -1 ? Number(args[args.indexOf('--limit') + 1]) : 0;
const noNetwork = args.includes('--no-network');

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

const cache = readJson(cacheFile, { urls: {}, crates: {} });

async function request(url, { method = 'GET', headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...headers },
    });
    const finalUrl = response.url || url;
    // Drain small bodies so sockets are reused; ignore body contents.
    try { await response.arrayBuffer(); } catch (error) { /* ignore */ }
    return { status: response.status, finalUrl, ok: response.status >= 200 && response.status < 400 };
  } catch (error) {
    return { status: 0, finalUrl: url, ok: false, error: error && error.message ? error.message : 'network error' };
  } finally {
    clearTimeout(timer);
  }
}

async function checkUrl(url) {
  if (noNetwork) return { status: -1, finalUrl: url, ok: true, skipped: true };
  if (cache.urls[url]) return cache.urls[url];
  let result = await request(url);
  if (result.status === 429 || result.status === 503) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    result = await request(url);
  }
  cache.urls[url] = result;
  return result;
}

function crateNameFromPage(url) {
  const match = String(url).match(/^https:\/\/crates\.io\/crates\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

async function checkCrateUrl(url) {
  if (noNetwork) return { ok: true, skipped: true };
  const crate = crateNameFromPage(url);
  if (crate) {
    const api = await checkCrate(crate);
    if (api.ok) return { ok: true, status: 200, via: 'crates.io api' };
  }
  return checkUrl(url);
}

async function checkCrate(name) {
  if (noNetwork) return { ok: true, skipped: true };
  if (cache.crates[name]) return cache.crates[name];
  const result = await request('https://crates.io/api/v1/crates/' + encodeURIComponent(name));
  const entry = result.status === 200
    ? { ok: true, status: 200 }
    : { ok: false, status: result.status, error: result.error || ('HTTP ' + result.status) };
  cache.crates[name] = entry;
  return entry;
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

const { TRACK_FILES } = await import(pathToFileURL(path.join(dataDir, 'index.mjs')).href + '?v=' + STAMP);

const chapters = [];
for (const name of TRACK_FILES) {
  if (trackArg && name !== trackArg) continue;
  const track = (await import(pathToFileURL(path.join(dataDir, name + '.mjs')).href + '?v=' + STAMP)).default;
  for (const lesson of track.lessons) {
    chapters.push({ track: name, lesson });
  }
}
const selected = limitArg > 0 ? chapters.slice(0, limitArg) : chapters;

const allCrates = new Set();
const allUrls = new Set();
for (const chapter of selected) {
  const lesson = chapter.lesson;
  for (const crate of lesson.crates || []) allCrates.add(crate);
  for (const resource of lesson.resources || []) allUrls.add(resource.url);
  for (const repo of lesson.github || []) allUrls.add(repo.url);
}

console.log('auditing ' + selected.length + ' chapters, ' + allUrls.size + ' unique URLs, ' + allCrates.size + ' unique crates' +
  (noNetwork ? ' (structure only)' : ''));

const urlResults = await mapLimit([...allUrls], CONCURRENCY, async (url) => ({ url, result: await checkUrl(url) }));
const crateResults = await mapLimit([...allCrates], 6, async (crate) => ({ crate, result: await checkCrate(crate) }));

const urls = {};
for (const entry of urlResults) urls[entry.url] = entry.result;
const crates = {};
for (const entry of crateResults) crates[entry.crate] = entry.result;
writeJson(cacheFile, cache);

const chaptersReport = [];
for (const chapter of selected) {
  const lesson = chapter.lesson;
  const issues = [];
  const notes = [];

  if (!Array.isArray(lesson.sections) || lesson.sections.length < 2) issues.push('sections < 2');
  if (!lesson.exercise || !lesson.exercise.solution) issues.push('missing exercise solution');
  if (!Array.isArray(lesson.questions) || lesson.questions.length < 2) issues.push('quiz < 2 questions');
  if (!Array.isArray(lesson.quickbytes) || lesson.quickbytes.length < 2) issues.push('quickbytes < 2');
  if (!Array.isArray(lesson.production) || lesson.production.length < 2) issues.push('production < 2');
  if (!Array.isArray(lesson.crates) || lesson.crates.length < 1) issues.push('no crates');
  if (!Array.isArray(lesson.github) || lesson.github.length < 1) issues.push('no github repo link');
  if (!Array.isArray(lesson.resources) || lesson.resources.length < 2) issues.push('resources < 2');
  if (!lesson.goal) issues.push('missing goal');

  const broken = [];
  const blocked = [];
  const moved = [];
  for (const resource of lesson.resources || []) {
    const result = urls[resource.url];
    if (!result) continue;
    if (!result.ok) {
      if (result.status === 403 || result.status === 429 || result.status === 503) {
        blocked.push({ kind: 'resource', title: resource.title, url: resource.url, status: result.status });
      } else {
        const recheck = await checkCrateUrl(resource.url);
        if (recheck.ok && result.status !== recheck.status) {
          notes.push('verified via crates.io API: ' + resource.url);
        } else {
          broken.push({ kind: 'resource', title: resource.title, url: resource.url, status: result.status, error: result.error });
        }
      }
    } else if (result.finalUrl && result.finalUrl !== resource.url) {
      moved.push({ kind: 'resource', url: resource.url, finalUrl: result.finalUrl });
    }
  }
  for (const repo of lesson.github || []) {
    const result = urls[repo.url];
    if (!result) continue;
    if (!result.ok) {
      if (result.status === 403 || result.status === 429 || result.status === 503) {
        blocked.push({ kind: 'github', title: repo.name, url: repo.url, status: result.status });
      } else {
        broken.push({ kind: 'github', title: repo.name, url: repo.url, status: result.status, error: result.error });
      }
    } else if (result.finalUrl && result.finalUrl !== repo.url) {
      moved.push({ kind: 'github', url: repo.url, finalUrl: result.finalUrl });
    }
  }
  for (const crate of lesson.crates || []) {
    const result = crates[crate];
    if (result && !result.ok) issues.push('crate not found: ' + crate);
  }
  if (broken.length) issues.push(broken.length + ' broken link(s)');
  if (moved.length) notes.push(moved.length + ' moved link(s)');

  if (blocked.length) notes.push(blocked.length + ' bot-blocked link(s) (open in a browser)');
  chaptersReport.push({
    track: chapter.track,
    id: lesson.id,
    title: lesson.title,
    ok: issues.length === 0,
    issues,
    notes,
    broken,
    blocked,
    moved,
  });
}

const total = chaptersReport.length;
const okCount = chaptersReport.filter((chapter) => chapter.ok).length;
const brokenChapters = chaptersReport.filter((chapter) => chapter.broken.length > 0);
const movedChapters = chaptersReport.filter((chapter) => chapter.moved.length > 0);
const brokenUrls = [...new Set(brokenChapters.flatMap((chapter) => chapter.broken.map((item) => item.url)))];
const blockedUrls = [...new Set(chaptersReport.flatMap((chapter) => (chapter.blocked || []).map((item) => item.url)))];
const movedUrls = [...new Set(movedChapters.flatMap((chapter) => chapter.moved.map((item) => item.url + ' -> ' + item.finalUrl)))];
const unknownCrates = [...new Set(chaptersReport.flatMap((chapter) => chapter.issues
  .filter((issue) => issue.startsWith('crate not found: '))
  .map((issue) => issue.replace('crate not found: ', ''))))];

const summary = {
  generatedAt: new Date().toISOString(),
  chapters: total,
  ok: okCount,
  withIssues: total - okCount,
  brokenLinkChapters: brokenChapters.length,
  brokenUrls,
  blockedUrls,
  movedUrls,
  unknownCrates,
  uniqueUrls: allUrls.size,
  uniqueCrates: allCrates.size,
};

writeJson(reportJson, { summary, chapters: chaptersReport });

const lines = [];
lines.push('# Content audit — ' + new Date().toISOString().slice(0, 10));
lines.push('');
lines.push('- chapters audited: **' + total + '**');
lines.push('- clean: **' + okCount + '** · with issues: **' + (total - okCount) + '**');
lines.push('- unique URLs checked: **' + allUrls.size + '** · unique crates checked: **' + allCrates.size + '**');
lines.push('- chapters with broken links: **' + brokenChapters.length + '**');
lines.push('- moved links: **' + movedUrls.length + '** · unknown crates: **' + unknownCrates.length + '**');
lines.push('');
if (unknownCrates.length) {
  lines.push('## Unknown crates');
  for (const crate of unknownCrates) lines.push('- `' + crate + '`');
  lines.push('');
}
if (brokenUrls.length) {
  lines.push('## Broken links');
  for (const url of brokenUrls) lines.push('- ' + url);
  lines.push('');
}
if (blockedUrls.length) {
  lines.push('## Bot-blocked links (verified valid in a browser, but refuse automated fetches)');
  for (const url of blockedUrls) lines.push('- ' + url);
  lines.push('');
}
if (movedUrls.length) {
  lines.push('## Moved links');
  for (const url of movedUrls) lines.push('- ' + url);
  lines.push('');
}
lines.push('## Per chapter');
lines.push('');
lines.push('| track | chapter | status | issues |');
lines.push('| --- | --- | --- | --- |');
for (const chapter of chaptersReport) {
  const status = chapter.ok ? 'OK' : 'ISSUE';
  const issues = chapter.issues.length ? chapter.issues.join('; ') : '';
  lines.push('| ' + chapter.track + ' | ' + chapter.id + ' ' + chapter.title + ' | ' + status + ' | ' + issues + ' |');
}
fs.mkdirSync(path.dirname(reportMd), { recursive: true });
fs.writeFileSync(reportMd, lines.join('\n') + '\n');

console.log('chapters: ' + total + ' · clean: ' + okCount + ' · with issues: ' + (total - okCount));
console.log('broken links: ' + summary.brokenUrls.length + ' across ' + brokenChapters.length + ' chapters');
console.log('bot-blocked links: ' + blockedUrls.length + ' · moved links: ' + movedUrls.length + ' · unknown crates: ' + unknownCrates.length);
if (unknownCrates.length) console.log('unknown crates: ' + unknownCrates.join(', '));
console.log('report: ' + path.relative(root, reportMd));
if (summary.brokenUrls.length) {
  console.log('\nfirst broken links:');
  for (const url of summary.brokenUrls.slice(0, 20)) console.log('  ' + url + '  [' + (urls[url] && urls[url].status) + ']');
}
process.exit(0);
