/**
 * Expand the cheatsheet to cover every track.
 *
 *   node scripts/expand-cheatsheet.mjs
 *
 * Appends groups that are missing (matched by title) and rewrites reference.mjs.
 * Idempotent: running it twice does not duplicate groups.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '..');
const file = path.join(root, 'src', 'data', 'reference.mjs');

const NEW_GROUPS = [
  {
    title: 'Rust fundamentals',
    items: [
      { name: 'immutable by default', code: 'let answer = 42;\nlet mut counter = 0;\ncounter += 1;' },
      { name: 'ownership move vs borrow', code: 'let owned = String::from("hi");\nlet moved = owned;           // owned is invalid now\nlet borrowed: &str = &moved;  // borrow instead of moving' },
      { name: 'iterators', code: 'let total: i32 = (1..=5)\n    .filter(|n| n % 2 == 0)\n    .map(|n| n * n)\n    .sum();' },
      { name: 'Result with ?', code: 'fn parse(s: &str) -> Result<i32, std::num::ParseIntError> {\n    let n: i32 = s.parse()?;\n    Ok(n * 2)\n}' },
      { name: 'match and Option', code: 'match map.get("key") {\n    Some(value) => println!("{}", value),\n    None => println!("missing"),\n}' },
      { name: 'derive common traits', code: '#[derive(Debug, Clone, PartialEq, Eq)]\nstruct User { id: u64, name: String }' },
    ],
  },
  {
    title: 'Rust in depth',
    items: [
      { name: 'declarative macro', code: 'macro_rules! map_of {\n    ($($k:expr => $v:expr),+ $(,)?) => {{\n        let mut map = std::collections::HashMap::new();\n        $( map.insert($k, $v); )+\n        map\n    }};\n}' },
      { name: 'unsafe with a safety comment', code: '// SAFETY: index is checked against slice.len() above.\nlet value = unsafe { *slice.as_ptr().add(index) };' },
      { name: 'const generics', code: 'fn zeros<const N: usize>() -> [f64; N] {\n    [0.0; N]\n}' },
      { name: 'GAT (lending iterator)', code: 'trait Lend {\n    type Item<\'a> where Self: \'a;\n    fn next(&mut self) -> Option<Self::Item<\'_>>;\n}' },
      { name: 'feature gate', code: '#[cfg(feature = "serde")]\nimpl serde::Serialize for Config { /* ... */ }' },
      { name: 'type state', code: 'struct Draft;\nstruct Published;\nstruct Post<State> { body: String, _state: std::marker::PhantomData<State> }' },
    ],
  },
  {
    title: 'Data structures',
    items: [
      { name: 'VecDeque as queue', code: 'use std::collections::VecDeque;\nlet mut q = VecDeque::with_capacity(8);\nq.push_back(1);\nq.push_front(0);\nassert_eq!(q.pop_front(), Some(0));' },
      { name: 'SmallVec inline storage', code: 'use smallvec::SmallVec;\nlet mut v: SmallVec<[u8; 16]> = SmallVec::new();\nv.push(1);  // no heap allocation until 17 bytes' },
      { name: 'Bytes zero-copy slice', code: 'use bytes::Bytes;\nlet buf = Bytes::from_static(b"hello world");\nlet word = buf.slice(0..5);  // shares the allocation' },
      { name: 'binary heap', code: 'use std::collections::BinaryHeap;\nlet mut heap = BinaryHeap::new();\nheap.push(3);\nheap.push(1);\nassert_eq!(heap.pop(), Some(3));' },
      { name: 'hashbrown reserve', code: 'use hashbrown::HashMap;\nlet mut map: HashMap<&str, u32> = HashMap::with_capacity(64);\nmap.reserve(128);' },
      { name: 'roaring bitmap', code: 'use roaring::RoaringBitmap;\nlet mut ids = RoaringBitmap::new();\nids.insert(42);\nassert!(ids.contains(42));' },
    ],
  },
  {
    title: 'Database internals',
    items: [
      { name: 'keyset pagination', code: "SELECT id, created_at\nFROM orders\nWHERE (created_at, id) < ($1, $2)\nORDER BY created_at DESC, id DESC\nLIMIT 50;" },
      { name: 'explain with buffers', code: 'EXPLAIN (ANALYZE, BUFFERS)\nSELECT * FROM orders WHERE tenant_id = $1;' },
      { name: 'covering index', code: 'CREATE INDEX CONCURRENTLY idx_orders_tenant_created\nON orders (tenant_id, created_at DESC, id DESC)\nINCLUDE (status);' },
      { name: 'advisory lock', code: 'SELECT pg_try_advisory_xact_lock(42);' },
      { name: 'repeatable read', code: 'BEGIN ISOLATION LEVEL REPEATABLE READ;\n-- snapshot is fixed for the whole transaction\nCOMMIT;' },
      { name: 'range partition', code: "CREATE TABLE events_2026 PARTITION OF events\nFOR VALUES FROM ('2026-01-01') TO ('2027-01-01');" },
    ],
  },
  {
    title: 'Distributed systems',
    items: [
      { name: 'fenced lease claim', code: 'UPDATE jobs\nSET owner = $1, fence = fence + 1, lease_until = now() + interval \'30 seconds\'\nWHERE id = $2 AND (lease_until < now() OR owner = $1)\nRETURNING fence;' },
      { name: 'transactional outbox', code: 'WITH inserted AS (\n    INSERT INTO orders (id, total) VALUES ($1, $2) RETURNING id\n)\nINSERT INTO outbox (id, topic, payload)\nSELECT gen_random_uuid(), \'orders\', to_jsonb(inserted) FROM inserted;' },
      { name: 'idempotency key', code: 'INSERT INTO idempotency (key, request_hash)\nVALUES ($1, $2)\nON CONFLICT (key) DO NOTHING\nRETURNING key;' },
      { name: 'vector-clock merge', code: 'fn merge(a: &mut HashMap<String, u64>, b: &HashMap<String, u64>) {\n    for (node, counter) in b {\n        let slot = a.entry(node.clone()).or_default();\n        *slot = (*slot).max(*counter);\n    }\n}' },
      { name: 'reject stale term', code: 'if msg.term < self.current_term {\n    return Err(RaftError::StaleTerm);\n}' },
      { name: 'quorum size', code: 'fn quorum(nodes: usize) -> usize {\n    nodes / 2 + 1\n}' },
    ],
  },
  {
    title: 'Networking',
    items: [
      { name: 'TCP listener', code: 'let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await?;\nloop {\n    let (socket, peer) = listener.accept().await?;\n    tokio::spawn(handle(socket, peer));\n}' },
      { name: 'disable Nagle', code: 'stream.set_nodelay(true)?;' },
      { name: 'connect with timeout', code: 'let stream = tokio::time::timeout(\n    Duration::from_secs(5),\n    TcpStream::connect(addr),\n).await??;' },
      { name: 'DNS resolution', code: 'let addrs: Vec<SocketAddr> = tokio::net::lookup_host(("example.com", 443))\n    .await?\n    .collect();' },
      { name: 'rustls server config', code: 'let config = rustls::ServerConfig::builder()\n    .with_no_client_auth()\n    .with_single_cert(certs, key)?;' },
      { name: 'HTTP/1.1 headers', code: 'GET /v1/orders HTTP/1.1\nHost: api.example.com\nAccept: application/json\nAuthorization: Bearer <token>' },
    ],
  },
  {
    title: 'Systems programming',
    items: [
      { name: 'SIGTERM handler', code: 'let mut term = tokio::signal::unix::signal(SignalKind::terminate())?;\nterm.recv().await;' },
      { name: 'mmap a file', code: 'use memmap2::Mmap;\nlet file = std::fs::File::open("data.bin")?;\nlet map = unsafe { Mmap::map(&file)? };' },
      { name: 'process limit (cgroup v2)', code: 'std::fs::write("/sys/fs/cgroup/demo/pids.max", "64")?;\nstd::fs::write("/sys/fs/cgroup/demo/memory.max", "268435456")?;' },
      { name: 'fork via nix', code: 'use nix::unistd::{fork, ForkResult};\nmatch unsafe { fork() }? {\n    ForkResult::Child => { /* child */ }\n    ForkResult::Parent { child } => { /* parent */ }\n}' },
      { name: 'unix socket', code: 'let listener = tokio::net::UnixListener::bind("/tmp/app.sock")?;\nlet (stream, _addr) = listener.accept().await?;' },
      { name: 'eBPF program load (aya)', code: 'let mut bpf = aya::Bpf::load(aya::include_bytes_aligned!(concat!(env!("OUT_DIR"), "/bpf")))?;' },
    ],
  },
  {
    title: 'AI/ML inference',
    items: [
      { name: 'candle matmul', code: 'use candle_core::{Device, Tensor};\nlet a = Tensor::new(&[[1f32, 2.], [3., 4.]], &Device::Cpu)?;\nlet c = a.matmul(&a)?;' },
      { name: 'tokenizer encode', code: 'use tokenizers::Tokenizer;\nlet tokenizer = Tokenizer::from_file("tokenizer.json")?;\nlet encoding = tokenizer.encode("hello world", true)?;\nlet ids = encoding.get_ids();' },
      { name: 'ONNX session', code: 'use ort::session::Session;\nlet session = Session::builder()?.commit_from_file("model.onnx")?;' },
      { name: 'cosine similarity', code: 'fn cosine(a: &[f32], b: &[f32]) -> f32 {\n    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();\n    let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();\n    let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();\n    dot / (na * nb)\n}' },
      { name: 'dynamic batching', code: 'let batch: Vec<Request> = pending.drain(..).take(max_batch).collect();\nlet outputs = model.run(batch).await?;' },
      { name: 'top-k retrieval', code: 'hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());\nhits.truncate(k);' },
    ],
  },
  {
    title: 'Architecture',
    items: [
      { name: 'hexagonal port', code: '#[async_trait::async_trait]\npub trait OrderRepository: Send + Sync {\n    async fn save(&self, order: &Order) -> anyhow::Result<()>;\n}' },
      { name: 'CQRS read model', code: 'pub struct OrderView {\n    pub id: uuid::Uuid,\n    pub status: String,\n    pub total_cents: i64,\n}' },
      { name: 'domain event', code: 'pub enum OrderEvent {\n    Placed { id: uuid::Uuid },\n    Cancelled { id: uuid::Uuid, reason: String },\n}' },
      { name: 'newtype identifier', code: '#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]\npub struct TenantId(pub uuid::Uuid);' },
      { name: 'use case function', code: 'pub async fn place_order(\n    repo: &impl OrderRepository,\n    cmd: PlaceOrder,\n) -> anyhow::Result<uuid::Uuid> { /* ... */ }' },
      { name: 'idempotent command', code: 'let inserted = repo\n    .insert_idempotent(&cmd.key, &cmd.hash)\n    .await?;\nif !inserted { return repo.find_by_key(&cmd.key).await; }' },
    ],
  },
  {
    title: 'API design',
    items: [
      { name: 'cursor pagination', code: 'GET /v1/orders?limit=50&after=eyJpZCI6MTIzfQ\n\n{\n  "items": [],\n  "next_cursor": "eyJpZCI6MTczfQ"\n}' },
      { name: 'problem+json error', code: 'HTTP/1.1 409 Conflict\nContent-Type: application/problem+json\n\n{\n  "type": "https://example.com/errors/conflict",\n  "title": "Conflict",\n  "status": 409,\n  "detail": "Order already shipped"\n}' },
      { name: 'idempotency key', code: 'POST /v1/payments HTTP/1.1\nIdempotency-Key: 9f1c2b7e-4a3d-4c1e-9b0a-2f6d8e5c1a77' },
      { name: 'media type versioning', code: 'Accept: application/vnd.acme.v2+json' },
      { name: 'conditional GET', code: 'GET /v1/orders/42 HTTP/1.1\nIf-None-Match: "etag-abc"\n\nHTTP/1.1 304 Not Modified' },
      { name: 'rate limited', code: 'HTTP/1.1 429 Too Many Requests\nRetry-After: 30\nX-RateLimit-Remaining: 0' },
    ],
  },
  {
    title: 'Performance engineering',
    items: [
      { name: 'criterion benchmark', code: 'use criterion::{black_box, criterion_group, criterion_main, Criterion};\n\nfn bench(c: &mut Criterion) {\n    c.bench_function("parse", |b| b.iter(|| parse(black_box(input))));\n}\ncriterion_group!(benches, bench);\ncriterion_main!(benches);' },
      { name: 'flamegraph', code: 'cargo install flamegraph\ncargo flamegraph --bin api -- --port 8080' },
      { name: 'pprof guard', code: 'let guard = pprof::ProfilerGuard::new(100)?;\n// ... run workload ...\nlet report = guard.report().build()?;' },
      { name: 'load test with oha', code: 'oha -z 30s -c 50 --latency http://127.0.0.1:8080/health' },
      { name: 'release profile', code: '[profile.release]\nlto = "thin"\ncodegen-units = 1\nstrip = true' },
      { name: 'global allocator', code: '#[global_allocator]\nstatic GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;' },
    ],
  },
  {
    title: 'Concurrency patterns',
    items: [
      { name: 'scoped threads', code: 'std::thread::scope(|scope| {\n    scope.spawn(|| work("a"));\n    scope.spawn(|| work("b"));\n});  // joins automatically' },
      { name: 'bounded mpsc', code: 'let (tx, mut rx) = tokio::sync::mpsc::channel::<Job>(256);\nwhile let Some(job) = rx.recv().await {\n    process(job).await;\n}' },
      { name: 'select with cancellation', code: 'tokio::select! {\n    _ = token.cancelled() => break,\n    Some(job) = rx.recv() => process(job).await,\n}' },
      { name: 'atomic counter', code: 'use std::sync::atomic::{AtomicU64, Ordering};\nstatic REQUESTS: AtomicU64 = AtomicU64::new(0);\nREQUESTS.fetch_add(1, Ordering::Relaxed);' },
      { name: 'semaphore backpressure', code: 'let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(32));\nlet permit = sem.clone().acquire_owned().await?;\n// permit is released on drop' },
      { name: 'loom model check', code: 'loom::model(|| {\n    let flag = loom::sync::atomic::AtomicBool::new(false);\n    // exercise the concurrent algorithm\n});' },
    ],
  },
  {
    title: 'Design principles',
    items: [
      { name: 'parse, don\u2019t validate', code: 'pub struct Email(String);\n\nimpl TryFrom<String> for Email {\n    type Error = InvalidEmail;\n    fn try_from(value: String) -> Result<Self, Self::Error> {\n        if value.contains(\'@\') { Ok(Email(value)) } else { Err(InvalidEmail) }\n    }\n}' },
      { name: 'make illegal states unrepresentable', code: 'enum Connection {\n    Disconnected,\n    Connecting { attempt: u8 },\n    Ready { stream: TcpStream },\n}' },
      { name: 'accept abstractions, return concretes', code: 'fn total(prices: impl IntoIterator<Item = u64>) -> u64 {\n    prices.into_iter().sum()\n}' },
      { name: 'small trait, explicit errors', code: 'pub trait Clock {\n    fn now(&self) -> std::time::Instant;\n}' },
      { name: 'composition over inheritance', code: 'struct Service {\n    repo: Arc<dyn OrderRepository>,\n    clock: Arc<dyn Clock>,\n}' },
      { name: 'document invariants', code: '/// # Panics\n/// Panics if `capacity` is zero.\npub fn new(capacity: usize) -> Self { assert!(capacity > 0); /* ... */ }' },
    ],
  },
  {
    title: 'Debugging & troubleshooting',
    items: [
      { name: 'backtrace everywhere', code: 'RUST_BACKTRACE=full RUST_LIB_BACKTRACE=1 ./target/debug/api' },
      { name: 'gdb session', code: 'rust-gdb --args target/debug/api --port 8080\n(gdb) break handlers::create_order\n(gdb) run' },
      { name: 'bisect a regression', code: 'git bisect start\ngit bisect bad\ngit bisect good v1.4.0\n# git bisect run cargo test --quiet' },
      { name: 'instrument an async fn', code: '#[tracing::instrument(skip(pool))]\nasync fn create_order(pool: &PgPool, input: NewOrder) -> Result<Order> {\n    // ...\n}' },
      { name: 'core dump', code: 'ulimit -c unlimited\n# reproduce the crash, then:\ncoredumpctl gdb ./target/debug/api' },
      { name: 'log with spans', code: 'let span = tracing::info_span!("job", id = %job.id);\nlet _guard = span.enter();' },
    ],
  },
  {
    title: 'Compilers',
    items: [
      { name: 'expand macros', code: 'cargo install cargo-expand\ncargo expand --bin api handlers::create' },
      { name: 'dump MIR (nightly)', code: 'rustc -Zunpretty=mir src/main.rs 2>&1 | less' },
      { name: 'dump HIR (nightly)', code: 'rustc -Zunpretty=hir-tree src/main.rs 2>&1 | less' },
      { name: 'clippy with deny', code: 'cargo clippy --all-targets -- -D warnings' },
      { name: 'cross target', code: 'rustup target add x86_64-unknown-linux-musl\ncargo build --release --target x86_64-unknown-linux-musl' },
      { name: 'compile timings', code: 'cargo build --timings\n# writes target/cargo-timings/cargo-timing.html' },
    ],
  },
];

const mod = await import(pathToFileURL(file).href + '?v=' + Date.now());
const existing = mod.CHEATSHEET;
const titles = new Set(existing.map((group) => group.title));
let added = 0;
for (const group of NEW_GROUPS) {
  if (titles.has(group.title)) continue;
  existing.push(group);
  titles.add(group.title);
  added += 1;
}

const header = '/**\n * Rust Academy reference data: the cheatsheet and the architecture blueprints.\n *\n * Plain JSON-compatible data consumed by src/app.js through build.mjs.\n */\n';
fs.writeFileSync(file, header + 'export const CHEATSHEET = ' + JSON.stringify(existing, null, 2) + ';\n\nexport const BLUEPRINTS = ' + JSON.stringify(mod.BLUEPRINTS, null, 2) + ';\n');
console.log('cheatsheet groups: ' + existing.length + ' (added ' + added + '), items: ' + existing.reduce((total, group) => total + group.items.length, 0));
