/**
 * Apply the content-audit fixes.
 *
 *   node scripts/fix-audit-findings.mjs
 *
 * - foundations: add real crates + production checklists to all 20 chapters
 * - algorithms: drop `std` from crates (std is not a crates.io crate)
 * - processes: add a second quiz question, quickbytes and GitHub repos
 * - systems: fix the moved linked_list_allocator repository URL
 * - concurrency-patterns: fix the AtomicU64 rustdoc URL (type alias page)
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname);
const dataDir = path.resolve(here, '..', 'src', 'data');

function header(track) {
  return '/**\n * ' + track + ' track.\n *\n * Authored for the Rust Academy plugin. Every lesson is plain JSON-compatible\n * data consumed by src/app.js through build.mjs.\n */\n';
}

async function load(name) {
  return (await import(pathToFileURL(path.join(dataDir, name + '.mjs')).href + '?v=' + Date.now())).default;
}

function save(name, track, head) {
  fs.writeFileSync(path.join(dataDir, name + '.mjs'), (head || header(track.title)) + 'export default ' + JSON.stringify(track, null, 2) + ';\n');
}

const FOUNDATIONS = {
  l01: { crates: ['clap'], production: ['Commit Cargo.lock for binaries so builds are reproducible.', 'Run cargo build --locked in CI to catch dependency drift.'] },
  l02: { crates: ['anyhow'], production: ['Annotate public function signatures; let inference handle locals.', 'Run cargo clippy and fix numeric cast lints before merging.'] },
  l03: { crates: ['itertools'], production: ['Prefer for loops and iterators over manual index arithmetic.', 'Deny clippy::needless_range_loop so index bugs are caught.'] },
  l04: { crates: ['anyhow'], production: ['Keep functions small and return Result instead of panicking.', 'Enable clippy::too_many_arguments and clippy::type_complexity.'] },
  l05: { crates: ['regex'], production: ['Never slice user text by byte offsets; use char_indices or split.', 'Treat len() as bytes and chars().count() as characters in APIs.'] },
  l06: { crates: ['serde'], production: ['Do not clone() to silence borrow errors; redesign ownership instead.', 'Take &str and &[T] in functions so ownership stays with the caller.'] },
  l07: { crates: ['serde'], production: ['Keep mutable borrows short; a block often ends them earlier.', 'Return references tied to inputs instead of cloning data.'] },
  l08: { crates: ['memchr'], production: ['Use &str and &[T] in public APIs to accept borrowed views.', 'Document byte-index assumptions for any String slicing.'] },
  l09: { crates: ['serde'], production: ['Derive Debug/Clone/PartialEq only when actually needed.', 'Keep behaviour on the type that owns the data; avoid anemic structs.'] },
  l10: { crates: ['serde'], production: ['Model states as enums so impossible states cannot be constructed.', 'Prefer exhaustive matches over _ so new variants fail compilation.'] },
  l11: { crates: ['thiserror', 'anyhow'], production: ['Use thiserror for library errors and anyhow at application boundaries.', 'Never unwrap in request paths; map errors to responses.'] },
  l12: { crates: ['thiserror'], production: ['Prefer generic bounds over dyn unless dynamic dispatch is required.', 'Keep traits small and document their contract.'] },
  l13: { crates: ['itertools'], production: ['Prefer iterator chains to manual loops and annotate collect().', 'Benchmark hot iterator chains before adding complexity.'] },
  l14: { crates: ['cargo-nextest'], production: ['Keep a workspace with shared lints and dependency versions.', 'Run cargo deny and cargo audit in CI for crate hygiene.'] },
  l15: { crates: ['indexmap'], production: ['Choose HashMap for lookups and BTreeMap for ordered iteration.', 'Reserve capacity up front when the size is known.'] },
  l16: { crates: ['clap'], production: ['Return non-zero exit codes on failure and write errors to stderr.', 'Use clap for argument parsing instead of manual args().'] },
  l17: { crates: ['crossbeam'], production: ['Prefer channels over shared state when possible.', 'Keep lock scopes short and never hold a Mutex across await.'] },
  l18: { crates: ['tokio'], production: ['Never block inside async; use spawn_blocking for CPU work.', 'Set timeouts on every network call and propagate cancellation.'] },
  l19: { crates: ['thiserror'], production: ['Box recursively sized types; share only with Rc/Arc when real.', 'Avoid RefCell in async code; prefer message passing.'] },
  l20: { crates: ['proptest'], production: ['Test behaviour, not implementation, and run cargo test in CI.', 'Deny warnings with RUSTFLAGS="-D warnings" on the CI matrix.'] },
};

const PROCESSES = {
  p01: {
    question: { q: 'Why bound the queue between producers and workers?', options: ['It makes the queue faster by using less memory', 'An unbounded queue turns overload into unbounded memory growth and latency', 'Bounded queues remove the need for backpressure', 'It guarantees jobs run exactly once'], answer: 1, explain: 'Unbounded queues hide overload until memory or latency collapses. A bounded queue makes producers wait or shed load, which is explicit backpressure.' },
    quickbytes: ['Size the pool to the downstream concurrency limit, not just CPU cores.', 'Use tokio::sync::Semaphore or a bounded channel to apply backpressure.'],
    github: [{ name: 'tokio-rs/tokio', url: 'https://github.com/tokio-rs/tokio' }, { name: 'tokio-rs/tokio-util', url: 'https://github.com/tokio-rs/tokio-util' }],
  },
  p02: {
    question: { q: 'What does a CancellationToken guarantee for child tasks?', options: ['It aborts them immediately, even mid-syscall', 'It signals cancellation; tasks must poll it or be dropped at an await point', 'It restarts tasks after cancellation', 'It only works with spawn_blocking'], answer: 1, explain: 'Cancellation is cooperative: tasks observe the token or get cancelled when their future is dropped at an await point. Blocking code must be interrupted explicitly.' },
    quickbytes: ['JoinSet aborts dropped tasks; keep the handle alive until you intend cancellation.', 'Use TaskTracker to wait for all children during shutdown.'],
    github: [{ name: 'tokio-rs/tokio', url: 'https://github.com/tokio-rs/tokio' }, { name: 'tokio-rs/tokio-util', url: 'https://github.com/tokio-rs/tokio-util' }],
  },
  p03: {
    question: { q: 'Why kill the whole process group instead of just the child?', options: ['It is faster than killing one process', 'Grandchildren forked by the child survive a single kill and become orphans', 'Killing one process leaves its stdout pipe open', 'Rust cannot kill a single process'], answer: 1, explain: 'The child may have spawned its own children. Killing only the direct child leaves them running as orphans; use process groups (killpg) and expect to reap them.' },
    quickbytes: ['Wrap child.wait() in tokio::time::timeout so a hung child cannot block shutdown.', 'Stream stdout and stderr concurrently; draining one pipe sequentially can deadlock.'],
    github: [{ name: 'tokio-rs/tokio', url: 'https://github.com/tokio-rs/tokio' }, { name: 'nix-rust/nix', url: 'https://github.com/nix-rust/nix' }],
  },
  p04: {
    question: { q: 'Why should readiness become false before termination begins?', options: ['It is required by Rust', 'Load balancers stop routing new requests while in-flight work drains', 'It closes the listening socket immediately', 'It forces the process to exit faster'], answer: 1, explain: 'Marking not-ready first removes the instance from rotation; then drain in-flight requests, then exit. Otherwise clients hit a closed socket during rollout.' },
    quickbytes: ['Install handlers for SIGTERM and SIGINT; exit non-zero only on the second signal.', 'Give shutdown a deadline with a timeout and abort remaining work after it.'],
    github: [{ name: 'tokio-rs/tokio', url: 'https://github.com/tokio-rs/tokio' }, { name: 'tokio-rs/tokio-util', url: 'https://github.com/tokio-rs/tokio-util' }],
  },
  p05: {
    question: { q: 'Why must scheduled jobs be idempotent?', options: ['Cron expressions are advisory', 'At-least-once schedulers can run a job twice after a crash or lease loss', 'Because Rust makes jobs run twice by default', 'So the job can be cancelled'], answer: 1, explain: 'Crashes, retries and leader changes can redeliver a run. Dedupe by run id or make the effect conditional (upsert, idempotency key) so a repeat is harmless.' },
    quickbytes: ['Persist last-run state in the database, not in process memory.', 'Use a leader lease so only one replica schedules each job.'],
    github: [{ name: 'tokio-rs/tokio', url: 'https://github.com/tokio-rs/tokio' }, { name: 'apalis-dev/apalis', url: 'https://github.com/apalis-dev/apalis' }],
  },
  p06: {
    question: { q: 'What does length-delimited framing solve?', options: ['It compresses messages', 'It tells the reader where one message ends without guessing from read boundaries', 'It encrypts each frame', 'It removes the need for backpressure'], answer: 1, explain: 'Streams deliver arbitrary byte chunks. A length prefix lets the decoder split frames deterministically instead of assuming one read equals one message.' },
    quickbytes: ['Framed codecs handle partial reads; never assume one read equals one message.', 'Bound the maximum frame size to reject malicious payloads early.'],
    github: [{ name: 'tokio-rs/tokio-util', url: 'https://github.com/tokio-rs/tokio-util' }, { name: 'tokio-rs/tokio', url: 'https://github.com/tokio-rs/tokio' }],
  },
  p07: {
    question: { q: 'Why set RLIMIT_NOFILE explicitly for services?', options: ['Rust needs exactly 1024 descriptors', 'Containers often inherit low defaults and exhaust descriptors under load', 'It caps memory usage of the process', 'It is required for async code'], answer: 1, explain: 'The default descriptor limit is often low relative to connection-heavy services. Raising it deliberately (and monitoring usage) avoids accept failures under load.' },
    quickbytes: ['Set cgroup v2 memory.max, cpu.max and pids.max for child workloads.', 'Drop privileges (uid/gid, no_new_privs) after setup, not before.'],
    github: [{ name: 'nix-rust/nix', url: 'https://github.com/nix-rust/nix' }, { name: 'rust-osdev/linked-list-allocator', url: 'https://github.com/rust-osdev/linked-list-allocator' }],
  },
};

// 1. Foundations: crates + production
const foundations = await load('foundations');
for (const lesson of foundations.lessons) {
  const extra = FOUNDATIONS[lesson.id];
  if (!extra) continue;
  lesson.crates = extra.crates;
  lesson.production = extra.production;
}
save('foundations', foundations);

// 2. Algorithms: std is not a crate
const algorithms = await load('algorithms');
for (const lesson of algorithms.lessons) {
  if (Array.isArray(lesson.crates)) lesson.crates = lesson.crates.filter((name) => name !== 'std');
}
save('algorithms', algorithms);

// 3. Processes: second quiz, quickbytes, github
const processes = await load('processes');
for (const lesson of processes.lessons) {
  const extra = PROCESSES[lesson.id];
  if (!extra) continue;
  lesson.questions = Array.isArray(lesson.questions) ? lesson.questions : [];
  if (!lesson.questions.some((question) => question.q === extra.question.q)) lesson.questions.push(extra.question);
  lesson.quickbytes = Array.isArray(lesson.quickbytes) ? lesson.quickbytes : [];
  for (const byte of extra.quickbytes) if (!lesson.quickbytes.includes(byte)) lesson.quickbytes.push(byte);
  lesson.github = Array.isArray(lesson.github) && lesson.github.length ? lesson.github : extra.github;
}
save('processes', processes);

// 4. Systems: moved repository
const systems = await load('systems');
const FIXED_REPO = 'https://github.com/rust-osdev/linked-list-allocator';
for (const lesson of systems.lessons) {
  for (const repo of lesson.github || []) {
    if (repo.url === 'https://github.com/rust-osdev/linked_list_allocator') repo.url = FIXED_REPO;
  }
  for (const resource of lesson.resources || []) {
    if (resource.url === 'https://github.com/rust-osdev/linked_list_allocator') resource.url = FIXED_REPO;
  }
}
save('systems', systems);

// 5. Concurrency patterns: AtomicU64 rustdoc path is a type alias page
const concurrency = await load('concurrency-patterns');
for (const lesson of concurrency.lessons) {
  for (const resource of lesson.resources || []) {
    if (resource.url === 'https://doc.rust-lang.org/std/sync/atomic/struct.AtomicU64.html') {
      resource.url = 'https://doc.rust-lang.org/std/sync/atomic/type.AtomicU64.html';
    }
  }
}
save('concurrency-patterns', concurrency);

console.log('fixes applied: foundations(20), algorithms(std), processes(7), systems(repo), concurrency-patterns(AtomicU64)');
