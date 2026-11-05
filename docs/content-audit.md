# Content audit — 2026-11-05

- chapters audited: **640**
- clean: **640** · with issues: **0**
- unique URLs checked: **1468** · unique crates checked: **358**
- chapters with broken links: **0**
- moved links: **9** · unknown crates: **0**

## Bot-blocked links (verified valid in a browser, but refuse automated fetches)
- https://dl.acm.org/doi/10.1145/3035918.3056101
- https://dl.acm.org/doi/pdf/10.1145/3733699
- https://dl.acm.org/doi/10.1145/128765.128770
- https://dl.acm.org/doi/10.1145/564585.564601
- https://dl.acm.org/doi/10.1145/1294261.1294281
- https://dl.acm.org/doi/10.1145/78969.78972
- https://dl.acm.org/doi/10.1145/258533.258660
- https://dl.acm.org/doi/10.1145/279227.279229
- https://dl.acm.org/doi/10.1145/359545.359563
- https://dl.acm.org/doi/10.1145/74850.74870
- https://dl.acm.org/doi/10.1145/41840.41841
- https://dl.acm.org/doi/10.1145/38713.38742
- https://dl.acm.org/doi/10.1145/351240.351266

## Moved links
- https://kafka.apache.org/intro -> https://kafka.apache.org/intro/
- https://docs.aws.amazon.com/whitepapers/latest/availability-and-beyond-improving-resilience/time-synchronization.html -> https://docs.aws.amazon.com/whitepapers/latest/availability-and-beyond-improving-resilience/
- https://doc.rust-lang.org/rustdoc/write-documentation/documentation-tests.html#attributes -> https://doc.rust-lang.org/rustdoc/write-documentation/documentation-tests.html
- https://docs.rs/pprof/latest/pprof/ -> https://docs.rs/crate/pprof/latest
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/selecting-content-storage-class.html -> https://docs.aws.amazon.com/AmazonS3/latest/userguide/
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/request-rate-perf-considerations.html -> https://docs.aws.amazon.com/AmazonS3/latest/userguide/
- https://docs.embassy.dev/ -> https://docs.embassy.dev/embassy-executor/0.10.0/cortex-m/index.html
- https://docs.rs/gloo/latest/gloo/ -> https://docs.rs/crate/gloo/latest
- https://docs.rs/mdbook/latest/mdbook/ -> https://docs.rs/crate/mdbook/latest

## Per chapter

| track | chapter | status | issues |
| --- | --- | --- | --- |
| foundations | l01 Hello, Cargo & Variables | OK |  |
| foundations | l02 Types & Mutability | OK |  |
| foundations | l03 Control Flow | OK |  |
| foundations | l04 Functions & Expressions | OK |  |
| foundations | l05 Strings & Text | OK |  |
| foundations | l06 Ownership & Moves | OK |  |
| foundations | l07 Borrowing & References | OK |  |
| foundations | l08 Slices | OK |  |
| foundations | l09 Structs & Methods | OK |  |
| foundations | l10 Enums & Pattern Matching | OK |  |
| foundations | l11 Option, Result & Error Handling | OK |  |
| foundations | l12 Traits & Generics | OK |  |
| foundations | l13 Closures & Iterators | OK |  |
| foundations | l14 Modules, Crates & Cargo | OK |  |
| foundations | l15 Collections in Depth | OK |  |
| foundations | l16 Files, I/O & a CLI Tool | OK |  |
| foundations | l17 Threads, Channels & Shared State | OK |  |
| foundations | l18 Async & Tokio Basics | OK |  |
| foundations | l19 Lifetimes & Smart Pointers | OK |  |
| foundations | l20 Testing, Errors & Idiomatic Rust | OK |  |
| web | w01 Axum 0.8 routing and composition | OK |  |
| web | w02 Extractors and typed request contracts | OK |  |
| web | w03 Errors as responses with problem+json | OK |  |
| web | w04 tower and tower-http middleware | OK |  |
| web | w05 JWT authentication and authorization | OK |  |
| web | w06 Realtime with WebSockets and SSE | OK |  |
| web | w07 API contracts, versioning, and idempotency | OK |  |
| web | w08 Testing and hardening HTTP services | OK |  |
| web | w09 Header-based versioning and content negotiation | OK |  |
| web | w10 Multipart uploads and streaming request bodies | OK |  |
| web | w11 Per-tenant rate limits and quotas | OK |  |
| web | w12 ETag, Cache-Control, and conditional requests | OK |  |
| web | w13 Background jobs triggered by HTTP handlers | OK |  |
| web | w14 RED metrics and W3C trace propagation | OK |  |
| web | w15 Graceful shutdown for in-flight requests | OK |  |
| web | w16 Deprecation and Sunset headers on a live API | OK |  |
| web | w17 Security headers and CSP for API surfaces | OK |  |
| web | w18 Contract tests and open-model load tests | OK |  |
| web | w19 X-Forwarded-* and trusted proxy boundaries | OK |  |
| web | w20 Request validation that emits problem details | OK |  |
| data | d01 SQLx 0.8 foundations: pools, checked queries, migrations | OK |  |
| data | d02 Transactions, row locks and isolation levels | OK |  |
| data | d03 Repository and domain boundaries | OK |  |
| data | d04 Redis caching: cache-aside, TTLs and stampedes | OK |  |
| data | d05 Query performance: keyset pagination, EXPLAIN, indexes | OK |  |
| data | d06 Object storage: presigned URLs, multipart, streaming | OK |  |
| data | d07 Integrity under concurrency: outbox, idempotency, retention | OK |  |
| data | d08 Read replicas: routing reads and a lag budget | OK |  |
| data | d09 Logical replication and change data capture | OK |  |
| data | d10 Migrations at scale: locks, batches, rollback | OK |  |
| data | d11 Connection pool sizing under real load | OK |  |
| data | d12 Time-series ingest, partitioning and rollups | OK |  |
| data | d13 Full-text search: tsvector, GIN and ranking | OK |  |
| data | d14 JSONB modelling: containment, GIN and expression indexes | OK |  |
| data | d15 Multi-tenant isolation with row-level security | OK |  |
| data | d16 Backup and restore drills you can prove | OK |  |
| data | d17 Data lifecycle: retention, erasure and proof | OK |  |
| data | d18 Zero-downtime schema evolution: expand and contract | OK |  |
| data | d19 Query plan regression tests that catch the 100x | OK |  |
| data | d20 Application-side sharding: routing and resharding | OK |  |
| services | s01 Service decomposition & API contracts | OK |  |
| services | s02 gRPC with tonic: codegen, deadlines, health | OK |  |
| services | s03 Kafka with rdkafka: acks, groups, offsets | OK |  |
| services | s04 NATS & JetStream with async-nats | OK |  |
| services | s05 Transactional outbox & idempotent consumers | OK |  |
| services | s06 Sagas & workflows: compensation and state | OK |  |
| services | s07 Retries, backoff & dead-letter queues | OK |  |
| services | s08 Distributed locks, leases & fencing tokens | OK |  |
| services | s09 Service discovery & client-side load balancing | OK |  |
| services | s10 API gateway: edge concerns, not business logic | OK |  |
| services | s11 Circuit breaking between services | OK |  |
| services | s12 Evolving event schemas without breaking consumers | OK |  |
| services | s13 Consumer lag: measure per partition, scale on it | OK |  |
| services | s14 Request-reply over a message bus | OK |  |
| services | s15 Operating a dead-letter queue you can drain | OK |  |
| services | s16 Trace context propagation across services | OK |  |
| services | s17 Backpressure: bound the queue, or it bounds you | OK |  |
| services | s18 Multi-region messaging: gateways and geo-affinity | OK |  |
| services | s19 Service mesh: what the sidecar does, and what it cannot | OK |  |
| services | s20 Consumer-driven contract tests between services | OK |  |
| processes | p01 Worker pools & bounded concurrency | OK |  |
| processes | p02 Task supervision & cancellation | OK |  |
| processes | p03 Subprocess handling | OK |  |
| processes | p04 Signals & graceful shutdown | OK |  |
| processes | p05 Schedulers & cron | OK |  |
| processes | p06 IPC & streaming | OK |  |
| processes | p07 Resource limits & isolation | OK |  |
| processes | p08 Container entrypoints and PID 1 | OK |  |
| processes | p09 Reaping orphans and subreapers | OK |  |
| processes | p10 Process supervisors and restart policy | OK |  |
| processes | p11 systemd units and socket activation | OK |  |
| processes | p12 Daemonising and journald logging | OK |  |
| processes | p13 Autoscaling workers by queue depth | OK |  |
| processes | p14 At-least-once execution and dedupe | OK |  |
| processes | p15 Job prioritisation and fairness | OK |  |
| processes | p16 Crash-only design and idempotent restarts | OK |  |
| processes | p17 Per-worker resource accounting | OK |  |
| processes | p18 Sandboxing child processes with seccomp | OK |  |
| processes | p19 Process metrics and health endpoints | OK |  |
| processes | p20 Cross-platform process handling | OK |  |
| production | g01 Observability: tracing, JSON logs, OTLP and metrics | OK |  |
| production | g02 Configuration and secrets without leaks | OK |  |
| production | g03 Resilience: timeouts, retries, breakers, bulkheads | OK |  |
| production | g04 Security hardening for HTTP services | OK |  |
| production | g05 Docker packaging: multi-stage, cargo-chef, distroless | OK |  |
| production | g06 Kubernetes runtime: probes, limits, drain, HPA | OK |  |
| production | g07 CI/CD and software supply chain | OK |  |
| production | g08 Performance engineering: bench, profile, load test | OK |  |
| production | g09 Incident response: severity, roles, blameless review | OK |  |
| production | g10 SLOs and error budgets: burn rate, alerts, policy | OK |  |
| production | g11 Capacity planning, queueing and load shedding | OK |  |
| production | g12 Cost engineering: unit economics and right-sizing | OK |  |
| production | g13 Environment parity: one artifact, explicit differences | OK |  |
| production | g14 Secret rotation: overlap, dual verification, expiry | OK |  |
| production | g15 Canary and blue/green with automated metric gates | OK |  |
| production | g16 Migration ordering: expand, backfill, contract | OK |  |
| production | g17 Disaster recovery drills with measured RTO and RPO | OK |  |
| production | g18 Patch cadence: SLA triage, rebuilds, expiring exceptions | OK |  |
| production | g19 Service catalogue: ownership, tiers, dependency map | OK |  |
| production | g20 Production readiness review: evidence before launch | OK |  |
| rust-advanced | r01 macro_rules!: fragments, repetition, hygiene | OK |  |
| rust-advanced | r02 Procedural macros: derive, syn, quote | OK |  |
| rust-advanced | r03 Unsafe is a proof obligation, not an escape hatch | OK |  |
| rust-advanced | r04 FFI: repr(C), bindgen and ownership across the boundary | OK |  |
| rust-advanced | r05 no_std: core, alloc, and a panic handler | OK |  |
| rust-advanced | r06 Const generics and compile-time capacities | OK |  |
| rust-advanced | r07 GATs: traits that lend borrowed data | OK |  |
| rust-advanced | r08 dyn dispatch: vtables, dyn compatibility, cost | OK |  |
| rust-advanced | r09 Variance: why &mut T is invariant | OK |  |
| rust-advanced | r10 Pin: keeping self-references valid | OK |  |
| rust-advanced | r11 Async internals: poll, wakers, and cancellation | OK |  |
| rust-advanced | r12 SIMD: target_feature, intrinsics, and the portable gap | OK |  |
| rust-advanced | r13 Zero-copy parsing: borrowed views and validation | OK |  |
| rust-advanced | r14 The type-state pattern: states as types | OK |  |
| rust-advanced | r15 Error design at scale: enums, codes, retries | OK |  |
| rust-advanced | r16 Custom allocators: GlobalAlloc and arenas | OK |  |
| rust-advanced | r17 Build scripts: codegen, env vars, host vs target | OK |  |
| rust-advanced | r18 Feature flags and semver discipline | OK |  |
| rust-advanced | r19 Generic performance: monomorphization and code size | OK |  |
| rust-advanced | r20 Profiling type-level abstractions | OK |  |
| algorithms | a01 Complexity analysis: counting the operation that dominates | OK |  |
| algorithms | a02 Arrays and two pointers: the write-index invariant | OK |  |
| algorithms | a03 Hashing strategies: entry API, load factor, and hash DoS | OK |  |
| algorithms | a04 Sorting: stability, key cost, and adversarial input | OK |  |
| algorithms | a05 Binary search: bounds, predicates, and off-by-one | OK |  |
| algorithms | a06 Stacks, queues, and the monotonic stack | OK |  |
| algorithms | a07 Linked lists: boxes, arenas, and a recursive Drop | OK |  |
| algorithms | a08 Trees and traversals: depth, order, and arena layout | OK |  |
| algorithms | a09 Heaps and priority queues: lazy deletion and indexed updates | OK |  |
| algorithms | a10 Graph BFS and DFS: representation, visitation, cycles | OK |  |
| algorithms | a11 Shortest paths: Dijkstra, Bellman-Ford, and A* | OK |  |
| algorithms | a12 Union-find: path compression and union by size | OK |  |
| algorithms | a13 Dynamic programming: state, order, and rolling arrays | OK |  |
| algorithms | a14 Greedy algorithms: exchange arguments and honest limits | OK |  |
| algorithms | a15 Backtracking: pruning, bitmasks, and exact cover | OK |  |
| algorithms | a16 String algorithms: UTF-8 boundaries, KMP, and multi-pattern search | OK |  |
| algorithms | a17 Bit manipulation: masks, popcount, and subset DP | OK |  |
| algorithms | a18 Math and number theory: gcd, modular arithmetic, primality | OK |  |
| algorithms | a19 Randomised algorithms: sampling, shuffle, and selection | OK |  |
| algorithms | a20 Problem-solving patterns: constraints, prefixes, and windows | OK |  |
| data-structures | b01 Vec internals: capacity, growth, invalidation | OK |  |
| data-structures | b02 HashMap: SwissTable groups and hasher choice | OK |  |
| data-structures | b03 BTreeMap: ordered iteration and range scans | OK |  |
| data-structures | b04 LRU caches: O(1) recency and why get takes &mut | OK |  |
| data-structures | b05 Ring buffers: fixed-capacity FIFO without reallocation | OK |  |
| data-structures | b06 Arenas and slabs: generational keys, not references | OK |  |
| data-structures | b07 Intrusive lists: links stored inside the value | OK |  |
| data-structures | b08 Skip lists: ordered maps under concurrent writes | OK |  |
| data-structures | b09 Tries and FSTs: prefix search over keys | OK |  |
| data-structures | b10 Bloom filters: bits per item, false positives, no deletes | OK |  |
| data-structures | b11 HyperLogLog: cardinality in a few kilobytes | OK |  |
| data-structures | b12 Cuckoo filters: deletion, fingerprints, and load | OK |  |
| data-structures | b13 Concurrent maps: sharded guards and deadlock | OK |  |
| data-structures | b14 Lock-free queues: bounded MPMC and memory ordering | OK |  |
| data-structures | b15 SmallVec: inline storage and its hidden costs | OK |  |
| data-structures | b16 Bytes and BytesMut: refcounted slices, no copies | OK |  |
| data-structures | b17 Roaring bitmaps: compressed sets of integers | OK |  |
| data-structures | b18 Heapless containers for no_std and bounded memory | OK |  |
| data-structures | b19 Persistent structures: cheap snapshots by sharing | OK |  |
| data-structures | b20 Benchmarking containers without lying to yourself | OK |  |
| database-internals | c01 Storage engines: what an engine owes you | OK |  |
| database-internals | c02 Page layout: slotted pages and checksums | OK |  |
| database-internals | c03 B+ trees: fanout, splits, and the root | OK |  |
| database-internals | c04 LSM trees: memtables, runs, and compaction | OK |  |
| database-internals | c05 Write-ahead logging: the commit rule | OK |  |
| database-internals | c06 Buffer pools: pins, dirty pages, and clock sweep | OK |  |
| database-internals | c07 MVCC: version chains and snapshot visibility | OK |  |
| database-internals | c08 Isolation levels: what each one actually prevents | OK |  |
| database-internals | c09 Latching and locking: memory versus data | OK |  |
| database-internals | c10 Query planning: cost models and join order | OK |  |
| database-internals | c11 Index selection: when a scan beats an index | OK |  |
| database-internals | c12 Joins and aggregation under memory pressure | OK |  |
| database-internals | c13 Replication: logs, quorum, and failover | OK |  |
| database-internals | c14 Sharding: keys, routing, and resharding | OK |  |
| database-internals | c15 Connection pooling: sizing, queues, and timeouts | OK |  |
| database-internals | c16 Schema migrations that do not lock the table | OK |  |
| database-internals | c17 Transactions at scale: idempotency and retries | OK |  |
| database-internals | c18 Vacuum, bloat, and the wraparound countdown | OK |  |
| database-internals | c19 Durability: fsync, group commit, and lying disks | OK |  |
| database-internals | c20 Benchmarking databases honestly | OK |  |
| distributed-systems | e01 CAP and PACELC: the trade-off is per operation | OK |  |
| distributed-systems | e02 Consistency models you can test | OK |  |
| distributed-systems | e03 Replication strategies and quorum arithmetic | OK |  |
| distributed-systems | e04 Partitioning, consistent hashing and rebalancing | OK |  |
| distributed-systems | e05 Raft: elections, log matching and commit rules | OK |  |
| distributed-systems | e06 Paxos and its variants: what the acceptor promises | OK |  |
| distributed-systems | e07 Vector clocks: detecting concurrency, not ordering it | OK |  |
| distributed-systems | e08 CRDTs: convergence by construction | OK |  |
| distributed-systems | e09 Leases, quorum grants and fencing tokens | OK |  |
| distributed-systems | e10 Failure detection: timeouts, phi accrual and suspicion | OK |  |
| distributed-systems | e11 Gossip: spreading state in O(log n) rounds | OK |  |
| distributed-systems | e12 Exactly-once semantics: dedup plus a transaction | OK |  |
| distributed-systems | e13 Idempotency keys at the API boundary | OK |  |
| distributed-systems | e14 Two-phase commit and the in-doubt window | OK |  |
| distributed-systems | e15 Sagas: compensation, isolation and the pivot step | OK |  |
| distributed-systems | e16 Consensus in practice: sizing, fsync and read paths | OK |  |
| distributed-systems | e17 Clock skew: monotonic time, TrueTime and leases | OK |  |
| distributed-systems | e18 Backpressure: queues are not capacity | OK |  |
| distributed-systems | e19 Observability: traces that survive a partition | OK |  |
| distributed-systems | e20 Chaos engineering: hypotheses, seeds and linearizability | OK |  |
| networking | f01 Layers on paper, packets on the wire | OK |  |
| networking | f02 TCP: handshakes, windows, and the 40 ms stall | OK |  |
| networking | f03 UDP: datagrams you must frame yourself | OK |  |
| networking | f04 Accept loops that survive bad days | OK |  |
| networking | f05 HTTP/1.1: framing, semantics, and smuggling | OK |  |
| networking | f06 HTTP/2: multiplexing, HPACK, and stalled windows | OK |  |
| networking | f07 QUIC and HTTP/3: streams over UDP | OK |  |
| networking | f08 TLS termination with rustls | OK |  |
| networking | f09 DNS: the cache you do not control | OK |  |
| networking | f10 Proxies: forward, reverse, and CONNECT | OK |  |
| networking | f11 Load balancing: round robin, P2C, and the tail | OK |  |
| networking | f12 Timeouts and retries that do not cascade | OK |  |
| networking | f13 Keep-alive: the idle-timeout race | OK |  |
| networking | f14 WebSockets: upgrade, frames, and slow clients | OK |  |
| networking | f15 gRPC internals: five bytes and a trailer | OK |  |
| networking | f16 Backpressure: the queue is the outage | OK |  |
| networking | f17 Framing: turning bytes into messages | OK |  |
| networking | f18 Connection pooling: sizing and staleness | OK |  |
| networking | f19 CDN and caching: keys, freshness, purge | OK |  |
| networking | f20 Debugging a network path without guesswork | OK |  |
| security | h01 Threat modelling: assets, boundaries, STRIDE | OK |  |
| security | h02 OWASP Top 10 mapped to Rust failure modes | OK |  |
| security | h03 Authentication: a login flow without enumeration | OK |  |
| security | h04 Authorization models: RBAC, ABAC, ReBAC | OK |  |
| security | h05 OAuth 2.0 and OIDC: flows, PKCE, token meaning | OK |  |
| security | h06 JWT internals: header, claims, and the checks people skip | OK |  |
| security | h07 Sessions and cookies: opaque ids and rotation | OK |  |
| security | h08 Password hashing with Argon2id | OK |  |
| security | h09 Cryptographic primitives: AEAD, MAC, KDF, signatures | OK |  |
| security | h10 Key management: envelope encryption and rotation | OK |  |
| security | h11 Secret storage: from env vars to a secret manager | OK |  |
| security | h12 TLS configuration with rustls | OK |  |
| security | h13 Input validation: parse into types, never sanitize | OK |  |
| security | h14 SSRF, CSRF and XSS in a Rust service | OK |  |
| security | h15 Rate limiting: token buckets and the 429 contract | OK |  |
| security | h16 Audit logging: tamper-evident and PII-free | OK |  |
| security | h17 Supply chain: cargo-audit, deny, vet, SBOM | OK |  |
| security | h18 Sandboxing untrusted work: seccomp and Wasm | OK |  |
| security | h19 Secrets in CI: OIDC and short-lived credentials | OK |  |
| security | h20 Incident response: containment to postmortem | OK |  |
| testing | i01 Unit tests: assert behavior, not implementation | OK |  |
| testing | i02 Integration tests as separate crates | OK |  |
| testing | i03 Doc tests: examples that cannot rot | OK |  |
| testing | i04 Property-based testing with proptest | OK |  |
| testing | i05 Fuzzing with cargo-fuzz and arbitrary | OK |  |
| testing | i06 Mutation testing: do your assertions bite? | OK |  |
| testing | i07 Snapshot testing with insta | OK |  |
| testing | i08 Consumer-driven contract testing | OK |  |
| testing | i09 Testcontainers: real dependencies, disposable | OK |  |
| testing | i10 Load testing with k6: baselines and gates | OK |  |
| testing | i11 Chaos experiments: hypothesis, blast radius, abort | OK |  |
| testing | i12 Coverage with cargo-llvm-cov: useful, not sacred | OK |  |
| testing | i13 Flaky tests: causes, not retries | OK |  |
| testing | i14 Mocking with mockall: seams, not stand-ins | OK |  |
| testing | i15 Fixtures and builders for readable test data | OK |  |
| testing | i16 CI test matrices that find real breakage | OK |  |
| testing | i17 Benchmark-driven testing with criterion | OK |  |
| testing | i18 Golden files for CLI and rendered output | OK |  |
| testing | i19 Concurrency testing with loom | OK |  |
| testing | i20 Test design: one reason to fail | OK |  |
| observability | j01 Logging: from println! to leveled events | OK |  |
| observability | j02 Structured logging: one JSON object per event | OK |  |
| observability | j03 Metrics: counters, gauges, histograms | OK |  |
| observability | j04 Distributed tracing: one trace, many services | OK |  |
| observability | j05 OpenTelemetry in Rust: the SDK and OTLP export | OK |  |
| observability | j06 Span design: names, kinds, status, attributes | OK |  |
| observability | j07 Context propagation: traceparent across boundaries | OK |  |
| observability | j08 RED and USE: four metrics per component | OK |  |
| observability | j09 SLIs and SLOs: measuring what users feel | OK |  |
| observability | j10 Error budgets: spending reliability deliberately | OK |  |
| observability | j11 Alerting: burn rates, runbooks, and silence | OK |  |
| observability | j12 Dashboards: one screen, four questions | OK |  |
| observability | j13 Profiling: where the CPU actually went | OK |  |
| observability | j14 Continuous profiling: always-on, low overhead | OK |  |
| observability | j15 Exemplars: from a latency bucket to a trace | OK |  |
| observability | j16 Sampling: head, tail, and what you lose | OK |  |
| observability | j17 Cardinality control: the metric that ate the TSDB | OK |  |
| observability | j18 Incident response: the first ten minutes | OK |  |
| observability | j19 Postmortems: blameless, specific, actionable | OK |  |
| observability | j20 Observability cost: volume, cardinality, retention | OK |  |
| devops | k01 A CI ladder: the gates worth running | OK |  |
| devops | k02 GitHub Actions: permissions, jobs, artifacts | OK |  |
| devops | k03 Build caching that survives a cold machine | OK |  |
| devops | k04 What is actually inside your image | OK |  |
| devops | k05 Multi-stage builds without a 2 GB image | OK |  |
| devops | k06 Distroless: no shell, no libc, no comfort | OK |  |
| devops | k07 Kubernetes: the objects a service needs | OK |  |
| devops | k08 Helm: values contracts and atomic upgrades | OK |  |
| devops | k09 GitOps with Argo CD: the cluster pulls | OK |  |
| devops | k10 Infrastructure as code with a plan gate | OK |  |
| devops | k11 Blue/green: flipping traffic without dropping requests | OK |  |
| devops | k12 Canary releases gated by metrics | OK |  |
| devops | k13 Feature flags: deploy without releasing | OK |  |
| devops | k14 Rollback: undo, roll forward, or drain | OK |  |
| devops | k15 Release engineering: one version, one artifact | OK |  |
| devops | k16 SBOMs that survive an incident | OK |  |
| devops | k17 Signing artifacts and verifying identity | OK |  |
| devops | k18 Secrets in CI: short-lived by default | OK |  |
| devops | k19 Build matrices: targets, features, MSRV | OK |  |
| devops | k20 Self-hosted runners: cost, cache, isolation | OK |  |
| data-engineering | m01 Batch versus streaming: bounded and unbounded work | OK |  |
| data-engineering | m02 Kafka as a log: retention, compaction and lag | OK |  |
| data-engineering | m03 JetStream: streams, durable consumers and acks | OK |  |
| data-engineering | m04 Stream processing: keyed state, event time and watermarks | OK |  |
| data-engineering | m05 Apache Arrow: columnar memory, nulls and zero-copy | OK |  |
| data-engineering | m06 Parquet: row groups, dictionary encoding and statistics | OK |  |
| data-engineering | m07 Polars: lazy plans, pushdown and streaming scans | OK |  |
| data-engineering | m08 Lakehouse: table commits over object storage | OK |  |
| data-engineering | m09 Change data capture: reading the write-ahead log | OK |  |
| data-engineering | m10 Orchestration: DAGs, leases and idempotent tasks | OK |  |
| data-engineering | m11 Data quality checks that fail loudly | OK |  |
| data-engineering | m12 Data lineage: emitting OpenLineage events | OK |  |
| data-engineering | m13 Schema evolution: compatibility directions and field ids | OK |  |
| data-engineering | m14 Partitioning strategies and pruning that works | OK |  |
| data-engineering | m15 Compaction: fixing the small-file problem | OK |  |
| data-engineering | m16 Exactly-once: transactions and idempotent sinks | OK |  |
| data-engineering | m17 Backfills: replay without breaking production | OK |  |
| data-engineering | m18 Medallion layers: bronze, silver and gold | OK |  |
| data-engineering | m19 Pipeline observability: SLIs, run records and traces | OK |  |
| data-engineering | m20 Data platform cost: bytes, requests and small files | OK |  |
| systems | n01 System calls: the ABI boundary between Rust and the kernel | OK |  |
| systems | n02 Virtual memory: pages, VMAs, and the fault path | OK |  |
| systems | n03 The system allocator: tcache, arenas, and why RSS does not fall | OK |  |
| systems | n04 mmap: shared, private, and the page cache in the middle | OK |  |
| systems | n05 io_uring: shared rings and completion-based I/O | OK |  |
| systems | n06 epoll and event loops: readiness, edges, and EAGAIN | OK |  |
| systems | n07 eBPF: verifier-bounded programs inside the kernel | OK |  |
| systems | n08 Filesystems: VFS, page cache, fsync, and atomic replace | OK |  |
| systems | n09 Processes: fork, exec, wait, and the zombie you forgot | OK |  |
| systems | n10 Signals: handlers, masks, and the self-pipe trick | OK |  |
| systems | n11 Namespaces and cgroups: isolation versus accounting | OK |  |
| systems | n12 Container internals: pivot_root, capabilities, seccomp | OK |  |
| systems | n13 WebAssembly: linear memory and a capability-free sandbox | OK |  |
| systems | n14 Freestanding Rust: _start, inline asm, and no libc | OK |  |
| systems | n15 Embedded Rust: memory-mapped registers and async executors | OK |  |
| systems | n16 Writing drivers: a kernel char device and an embedded-hal client | OK |  |
| systems | n17 Performance counters: cycles, cache misses, and multiplexing | OK |  |
| systems | n18 Time and clocks: monotonic, realtime, and the vDSO | OK |  |
| systems | n19 IPC: pipes, unix sockets, and passing file descriptors | OK |  |
| systems | n20 Systems debugging: strace, perf, and the state a process is in | OK |  |
| operating-systems | os01 Processes, threads, and what the kernel actually shares | OK |  |
| operating-systems | os02 CPU scheduling: vruntime, nice, and affinity | OK |  |
| operating-systems | os03 Virtual memory: page tables, PTEs and demand paging | OK |  |
| operating-systems | os04 The system call boundary: registers, vDSO and errno | OK |  |
| operating-systems | os05 Interrupts, exceptions, and what reaches userspace | OK |  |
| operating-systems | os06 Filesystems and VFS: inodes, dentries and mounts | OK |  |
| operating-systems | os07 Block devices and IO scheduling: from bio to blk-mq | OK |  |
| operating-systems | os08 Memory mapping and the page cache contract | OK |  |
| operating-systems | os09 Kernel synchronisation: spinlocks, RCU and futexes | OK |  |
| operating-systems | os10 Namespaces and cgroups: the isolation substrate | OK |  |
| operating-systems | os11 Containers from first principles: pivot_root and exec | OK |  |
| operating-systems | os12 Boot, initramfs, and PID 1 duties | OK |  |
| operating-systems | os13 Device drivers and the Linux device model | OK |  |
| operating-systems | os14 eBPF and tracing: the verifier is the contract | OK |  |
| operating-systems | os15 io_uring: shared rings and real async IO | OK |  |
| operating-systems | os16 Real-time scheduling: determinism, not speed | OK |  |
| operating-systems | os17 Signals and process control: exit codes and orphans | OK |  |
| operating-systems | os18 Resource limits and accounting: rlimits to cgroups | OK |  |
| operating-systems | os19 OS security boundaries: capabilities, seccomp, Landlock | OK |  |
| operating-systems | os20 Debugging the kernel interface without guessing | OK |  |
| ai-ml | o01 The Rust ML stack: what each crate owns | OK |  |
| ai-ml | o02 candle tensors: shape, dtype, device | OK |  |
| ai-ml | o03 burn: modules, rank-typed tensors, backends | OK |  |
| ai-ml | o04 ONNX Runtime via ort: sessions and IO | OK |  |
| ai-ml | o05 tokenizers: truncation, padding, offsets | OK |  |
| ai-ml | o06 Embeddings: pooling, normalization, batching | OK |  |
| ai-ml | o07 Vector search: HNSW knobs and recall | OK |  |
| ai-ml | o08 RAG: context assembly under a token budget | OK |  |
| ai-ml | o09 Serving inference: axum, limits, streaming | OK |  |
| ai-ml | o10 Dynamic batching: queue, window, coalesce | OK |  |
| ai-ml | o11 Quantization: 4-bit weights and what breaks | OK |  |
| ai-ml | o12 GPU basics: device choice and memory math | OK |  |
| ai-ml | o13 Evaluation: golden sets and recall gates | OK |  |
| ai-ml | o14 Prompt infrastructure: templates and budgets | OK |  |
| ai-ml | o15 Model routing: cost, latency, fallback | OK |  |
| ai-ml | o16 Response caching: exact and semantic | OK |  |
| ai-ml | o17 LLM observability: spans, TTFT, cost | OK |  |
| ai-ml | o18 Training data pipelines: JSONL to shards | OK |  |
| ai-ml | o19 Fine-tuning: LoRA by hand in candle | OK |  |
| ai-ml | o20 Safety and cost: budgets, guards, audit | OK |  |
| architecture | q01 Bounded contexts and the ubiquitous language | OK |  |
| architecture | q02 Hexagonal ports and adapters | OK |  |
| architecture | q03 Clean architecture: use cases and the composition root | OK |  |
| architecture | q04 Modular monolith: seams inside one deployable | OK |  |
| architecture | q05 Microservice boundaries: the extraction test | OK |  |
| architecture | q06 CQRS: separate write and read models | OK |  |
| architecture | q07 Event sourcing: the log is the source of truth | OK |  |
| architecture | q08 API gateway: edge policy, not edge logic | OK |  |
| architecture | q09 Backend for frontend: shaped payloads, honest degradation | OK |  |
| architecture | q10 Saga orchestration with a persisted state machine | OK |  |
| architecture | q11 Multi-tenancy: isolation you can prove | OK |  |
| architecture | q12 Idempotency by design, not by hope | OK |  |
| architecture | q13 Caching strategy: staleness is the currency | OK |  |
| architecture | q14 Consistency boundaries: one transaction, one aggregate | OK |  |
| architecture | q15 Contract-first APIs from Rust types | OK |  |
| architecture | q16 API versioning and a deprecation you can measure | OK |  |
| architecture | q17 Capacity planning with Little law | OK |  |
| architecture | q18 Architecture decision records that get read | OK |  |
| architecture | q19 Managing technical debt as an interest rate | OK |  |
| architecture | q20 Team topologies and the architecture they produce | OK |  |
| interview-prep | t01 Ownership questions: trace the value, name the rule | OK |  |
| interview-prep | t02 Lifetime questions: elision, 'static, and the real error | OK |  |
| interview-prep | t03 Async questions: the future that is not Send | OK |  |
| interview-prep | t04 Concurrency puzzles: publish data with the right ordering | OK |  |
| interview-prep | t05 DSA drills: an LRU cache without a linked list | OK |  |
| interview-prep | t06 System design: sizing a webhook delivery pipeline | OK |  |
| interview-prep | t07 Debugging: the task that never yields | OK |  |
| interview-prep | t08 Code review: the five findings senior reviewers name | OK |  |
| interview-prep | t09 Behavioural stories: quantify the incident, own the action | OK |  |
| interview-prep | t10 Take-home: the four-hour scope | OK |  |
| interview-prep | t11 Benchmarking: why your bench beats production | OK |  |
| interview-prep | t12 Error handling: the library boundary rule | OK |  |
| interview-prep | t13 API design: what actually counts as breaking | OK |  |
| interview-prep | t14 Database questions: N+1 queries and pool arithmetic | OK |  |
| interview-prep | t15 Distributed systems: the quorum answer that scores | OK |  |
| interview-prep | t16 Security questions: token validation on the whiteboard | OK |  |
| interview-prep | t17 Performance: profile first, then remove work | OK |  |
| interview-prep | t18 Testing: the plan a senior writes in ten minutes | OK |  |
| interview-prep | t19 Rust trivia: ten answers that separate levels | OK |  |
| interview-prep | t20 Mock interviews: running the 45-minute loop | OK |  |
| projects | u01 CLI toolkit: exit codes, error context, and a testable contract | OK |  |
| projects | u02 REST API: a typed error boundary in axum 0.8 | OK |  |
| projects | u03 gRPC service: server streaming without unbounded buffers | OK |  |
| projects | u04 Worker queue: claiming jobs with SKIP LOCKED and a lease | OK |  |
| projects | u05 Realtime gateway: bounded fan-out and slow-consumer policy | OK |  |
| projects | u06 Data pipeline: checkpointed commits with conditional puts | OK |  |
| projects | u07 Observability stack: one trace context across every hop | OK |  |
| projects | u08 Kubernetes operator: level-triggered reconcile with status | OK |  |
| projects | u09 WASM app: the JS boundary is your performance budget | OK |  |
| projects | u10 Embedded firmware: static tasks and bounded channels | OK |  |
| projects | u11 ML inference server: batching, queueing, and cancellation | OK |  |
| projects | u12 Event-sourced app: optimistic concurrency on an append-only log | OK |  |
| projects | u13 Multi-tenant SaaS: isolation enforced by Postgres, not by discipline | OK |  |
| projects | u14 Chaos harness: deterministic faults with failpoints and a paused clock | OK |  |
| projects | u15 Benchmark suite: measure the thing that regresses | OK |  |
| projects | u16 Fuzz target: structured input, invariants, and a growth loop | OK |  |
| projects | u17 Plugin system: native ABI risk versus WASM sandboxing | OK |  |
| projects | u18 Distributed cache: consistent hashing and the hot-key cliff | OK |  |
| projects | u19 Rate limiter: GCRA, keyed limits, and honest 429s | OK |  |
| projects | u20 Log aggregator: durable ingest, time-segmented storage | OK |  |
| frontend-wasm | v01 WebAssembly: a typed stack machine in a sandbox | OK |  |
| frontend-wasm | v02 wasm-bindgen: the glue layer you ship but never read | OK |  |
| frontend-wasm | v03 JS interop: closures, promises and the JsValue escape hatch | OK |  |
| frontend-wasm | v04 Leptos: fine-grained reactivity without a virtual DOM | OK |  |
| frontend-wasm | v05 Yew: virtual DOM, typed props and reducers | OK |  |
| frontend-wasm | v06 Dioxus: one rsx! tree, several renderers | OK |  |
| frontend-wasm | v07 web-sys: typed bindings and a feature flag per type | OK |  |
| frontend-wasm | v08 SSR and hydration: one tree, two runtimes | OK |  |
| frontend-wasm | v09 State management: signals, context and server state | OK |  |
| frontend-wasm | v10 WASM performance: the boundary is the cost centre | OK |  |
| frontend-wasm | v11 Component testing with wasm-bindgen-test | OK |  |
| frontend-wasm | v12 Bundling: Trunk, wasm-opt and a size budget | OK |  |
| frontend-wasm | v13 wasm-pack: from crate to npm package | OK |  |
| frontend-wasm | v14 Web Workers: moving work off the main thread | OK |  |
| frontend-wasm | v15 Canvas and WebGL: drawing from Rust | OK |  |
| frontend-wasm | v16 Accessibility: the semantics you have to render | OK |  |
| frontend-wasm | v17 PWA: installable, offline and safely updatable | OK |  |
| frontend-wasm | v18 Edge WASM: request-scoped code at the edge | OK |  |
| frontend-wasm | v19 wasmtime: embedding untrusted modules safely | OK |  |
| frontend-wasm | v20 The component model: WIT, worlds and the canonical ABI | OK |  |
| embedded | x01 embedded-hal 1.0: traits as the port boundary | OK |  |
| embedded | x02 no_std: what you lose, what you must supply | OK |  |
| embedded | x03 Cortex-M boot: vector table, memory.x, reset path | OK |  |
| embedded | x04 Interrupts, priorities and critical sections | OK |  |
| embedded | x05 RTIC 2: static priorities and resource ceilings | OK |  |
| embedded | x06 Embassy: async tasks on one stack | OK |  |
| embedded | x07 Timers and monotonic clocks: ticks, drift, deadlines | OK |  |
| embedded | x08 GPIO: pin typestate, electrical limits, debouncing | OK |  |
| embedded | x09 I2C: transactions, NACKs and bus recovery | OK |  |
| embedded | x10 SPI: modes, chip select, and full-duplex framing | OK |  |
| embedded | x11 UART: framing, ring buffers and backpressure | OK |  |
| embedded | x12 DMA: buffer ownership, alignment and cache | OK |  |
| embedded | x13 defmt: logging that costs bytes, not milliseconds | OK |  |
| embedded | x14 probe-rs: flash, run, and read RTT | OK |  |
| embedded | x15 Memory: stack, statics and the linker map | OK |  |
| embedded | x16 Power: sleep modes, tickless idle and the budget | OK |  |
| embedded | x17 Choosing a HAL: STM32, nRF, RP and ESP compared | OK |  |
| embedded | x18 RTIC vs Embassy vs FreeRTOS, Tock and Hubris | OK |  |
| embedded | x19 Safety and reliability: watchdogs and fail-safe state | OK |  |
| embedded | x20 Firmware updates: A/B partitions, signing, rollback | OK |  |
| compilers | cl01 The compiler pipeline: five representations, one program | OK |  |
| compilers | cl02 Lexing: maximal munch, spans, and keywords | OK |  |
| compilers | cl03 Parsing: recursive descent, precedence, and recovery | OK |  |
| compilers | cl04 Name resolution: ribs, namespaces, and macro hygiene | OK |  |
| compilers | cl05 Type checking: unification, occurs checks, and obligations | OK |  |
| compilers | cl06 HIR and MIR: rustc's two middle representations | OK |  |
| compilers | cl07 SSA: one definition per value and where phi nodes go | OK |  |
| compilers | cl08 Dataflow analysis: lattices, worklists, and fixpoints | OK |  |
| compilers | cl09 Optimisation passes: inlining, folding, and phase ordering | OK |  |
| compilers | cl10 Borrow checking internals: loans, regions, and NLL | OK |  |
| compilers | cl11 Monomorphisation: from generic MIR to concrete code | OK |  |
| compilers | cl12 LLVM and Cranelift: choosing a code generation backend | OK |  |
| compilers | cl13 Interpreters: tree-walking, bytecode, and MIR evaluation | OK |  |
| compilers | cl14 JIT compilation: executable memory, symbols, and ABIs | OK |  |
| compilers | cl15 Macros as metaprogramming: expansion, hygiene, proc macros | OK |  |
| compilers | cl16 Diagnostics: spans, labels, and machine-applicable fixes | OK |  |
| compilers | cl17 Incremental compilation: the query system and red-green | OK |  |
| compilers | cl18 Linkers and debug info: symbols, relocations, DWARF | OK |  |
| compilers | cl19 Compiler testing: differential, property, and fuzzing | OK |  |
| compilers | cl20 Language design trade-offs: what a compiler can and cannot buy | OK |  |
| design-principles | dp01 Coupling and cohesion: reading a module graph as a change-cost map | OK |  |
| design-principles | dp02 SOLID translated into Rust: what survives and what does not | OK |  |
| design-principles | dp03 Composition over inheritance: fields, forwarding, and the Deref trap | OK |  |
| design-principles | dp04 Information hiding: private fields, sealed traits, opaque types | OK |  |
| design-principles | dp05 Interface segregation: small traits, honest test doubles | OK |  |
| design-principles | dp06 Dependency inversion: the domain owns the trait, the edge owns the impl | OK |  |
| design-principles | dp07 Type-driven design: the signature is the specification | OK |  |
| design-principles | dp08 Newtypes: distinct types for ids, money, and units | OK |  |
| design-principles | dp09 Parse, don't validate: one gate at the boundary | OK |  |
| design-principles | dp10 Invariants in types: the constructor is the only gate | OK |  |
| design-principles | dp11 Error design: the failure surface is part of the API | OK |  |
| design-principles | dp12 Naming: units, verbs, and the conventions std already set | OK |  |
| design-principles | dp13 Simplicity: DRY is about knowledge, not identical text | OK |  |
| design-principles | dp14 Least surprise: behave the way the standard library behaves | OK |  |
| design-principles | dp15 Fail-fast: validate at startup, never silently default | OK |  |
| design-principles | dp16 Idempotency by design: unique keys and guarded transitions | OK |  |
| design-principles | dp17 Backpressure: bounded queues, permits, and load shedding | OK |  |
| design-principles | dp18 Graceful degradation: degrade features, never correctness | OK |  |
| design-principles | dp19 API ergonomics: make the right call the easy call | OK |  |
| design-principles | dp20 Design review: a checklist ordered by blast radius | OK |  |
| engineering-craft | ec01 Review that argues about design, not formatting | OK |  |
| engineering-craft | ec02 RFCs: from proposal to a decision with a date | OK |  |
| engineering-craft | ec03 ADRs: one decision, one file, one status | OK |  |
| engineering-craft | ec04 Debug by shrinking: reproduce, minimise, explain | OK |  |
| engineering-craft | ec05 Incident command: decide, communicate, record | OK |  |
| engineering-craft | ec06 Blameless postmortems that change the system | OK |  |
| engineering-craft | ec07 Estimates as ranges: reference class and throughput | OK |  |
| engineering-craft | ec08 Technical writing a busy reader finishes | OK |  |
| engineering-craft | ec09 Documentation that fails the build when stale | OK |  |
| engineering-craft | ec10 Onboarding as a product: first PR in week one | OK |  |
| engineering-craft | ec11 Pairing: driver, navigator, and ping-pong | OK |  |
| engineering-craft | ec12 Technical debt you can price and rank | OK |  |
| engineering-craft | ec13 Refactoring under a compiler guarantee | OK |  |
| engineering-craft | ec14 Legacy code: find the seam before the behaviour | OK |  |
| engineering-craft | ec15 Choosing tests by the failure they must catch | OK |  |
| engineering-craft | ec16 Prioritisation: cost of delay beats priority labels | OK |  |
| engineering-craft | ec17 Product thinking: the engineer's version | OK |  |
| engineering-craft | ec18 Landing a change in someone else's project | OK |  |
| engineering-craft | ec19 Career growth through written influence | OK |  |
| engineering-craft | ec20 Metrics that do not lie | OK |  |
| performance-engineering | pf01 Measure first: what a performance claim needs | OK |  |
| performance-engineering | pf02 Benchmarking with criterion: honest micro-benchmarks | OK |  |
| performance-engineering | pf03 Profilers and flamegraphs: where the time actually goes | OK |  |
| performance-engineering | pf04 Allocation analysis: count, size, and lifetime | OK |  |
| performance-engineering | pf05 Cache-friendly data layout | OK |  |
| performance-engineering | pf06 SIMD and autovectorisation | OK |  |
| performance-engineering | pf07 Async performance pitfalls | OK |  |
| performance-engineering | pf08 Lock contention: measure, shard, or remove | OK |  |
| performance-engineering | pf09 Memory bandwidth: when the algorithm stops mattering | OK |  |
| performance-engineering | pf10 Latency budgets: allocate milliseconds like money | OK |  |
| performance-engineering | pf11 Tail latency: why p99 is a product, not a sum | OK |  |
| performance-engineering | pf12 Queueing theory for engineers | OK |  |
| performance-engineering | pf13 Load testing: open versus closed models | OK |  |
| performance-engineering | pf14 Capacity planning: headroom, not averages | OK |  |
| performance-engineering | pf15 Database performance: the query is the bottleneck | OK |  |
| performance-engineering | pf16 Network performance: RTT, syscalls, and TLS | OK |  |
| performance-engineering | pf17 GC-less memory design: arenas, pools, and ownership | OK |  |
| performance-engineering | pf18 The optimisation workflow: one change, one measurement | OK |  |
| performance-engineering | pf19 Performance regression detection in CI | OK |  |
| performance-engineering | pf20 Cost-aware performance: performance per dollar | OK |  |
| concurrency-patterns | cp01 Concurrency is not parallelism | OK |  |
| concurrency-patterns | cp02 Threads, stacks, and scoped threads | OK |  |
| concurrency-patterns | cp03 Channels and CSP: moving ownership instead of sharing | OK |  |
| concurrency-patterns | cp04 The actor model without a framework | OK |  |
| concurrency-patterns | cp05 Shared state: choosing the right lock | OK |  |
| concurrency-patterns | cp06 Atomics and memory ordering | OK |  |
| concurrency-patterns | cp07 Lock-free basics: CAS loops and ABA | OK |  |
| concurrency-patterns | cp08 False sharing and cache-line layout | OK |  |
| concurrency-patterns | cp09 Work stealing and data parallelism with rayon | OK |  |
| concurrency-patterns | cp10 Structured concurrency with JoinSet | OK |  |
| concurrency-patterns | cp11 Cancellation and timeouts that actually stop work | OK |  |
| concurrency-patterns | cp12 Backpressure and bounded queues | OK |  |
| concurrency-patterns | cp13 Deadlock and livelock | OK |  |
| concurrency-patterns | cp14 Starvation and fairness | OK |  |
| concurrency-patterns | cp15 Testing concurrent code without flaky failures | OK |  |
| concurrency-patterns | cp16 Loom: model checking the shared state | OK |  |
| concurrency-patterns | cp17 Async runtime internals you can reason about | OK |  |
| concurrency-patterns | cp18 Blocking inside async: the tax and the escape hatch | OK |  |
| concurrency-patterns | cp19 Measuring concurrency performance honestly | OK |  |
| concurrency-patterns | cp20 A concurrency design review you can run | OK |  |
| api-design | ap01 Resources, actions, and addressable state | OK |  |
| api-design | ap02 REST semantics: safety, idempotency, status codes | OK |  |
| api-design | ap03 RPC and gRPC contract design | OK |  |
| api-design | ap04 GraphQL trade-offs: what a query language costs | OK |  |
| api-design | ap05 Schema design: ids, money, time, and open enums | OK |  |
| api-design | ap06 Error models: one envelope, stable codes | OK |  |
| api-design | ap07 Pagination: offset, cursor, and keyset | OK |  |
| api-design | ap08 Filtering, sorting, and sparse fields | OK |  |
| api-design | ap09 Idempotency keys and safe retries | OK |  |
| api-design | ap10 Versioning and compatibility | OK |  |
| api-design | ap11 Deprecation: sunset with evidence | OK |  |
| api-design | ap12 Authentication and authorization boundaries | OK |  |
| api-design | ap13 Rate limiting and quotas | OK |  |
| api-design | ap14 Bulk and batch endpoints | OK |  |
| api-design | ap15 Streaming APIs: SSE, WebSocket, and gRPC streams | OK |  |
| api-design | ap16 Webhooks that survive retries | OK |  |
| api-design | ap17 SDK design: generated clients people keep | OK |  |
| api-design | ap18 OpenAPI as a build artifact | OK |  |
| api-design | ap19 Developer experience: time to first 200 | OK |  |
| api-design | ap20 The API review checklist | OK |  |
| debugging-troubleshooting | dg01 The debugging method: one falsifiable hypothesis at a time | OK |  |
| debugging-troubleshooting | dg02 Building a reproducer that fails on demand | OK |  |
| debugging-troubleshooting | dg03 git bisect: turning a commit range into one culprit | OK |  |
| debugging-troubleshooting | dg04 Reading panics, backtraces and panic hooks | OK |  |
| debugging-troubleshooting | dg05 Logging versus tracing: choosing the instrument | OK |  |
| debugging-troubleshooting | dg06 Debuggers: breakpoints that answer a question | OK |  |
| debugging-troubleshooting | dg07 Core dumps and minidumps: debugging a corpse | OK |  |
| debugging-troubleshooting | dg08 Memory bugs: Miri, sanitizers and the aliasing rules | OK |  |
| debugging-troubleshooting | dg09 Deadlocks and hangs: finding the cycle | OK |  |
| debugging-troubleshooting | dg10 Async task debugging: tasks that never wake | OK |  |
| debugging-troubleshooting | dg11 Distributed tracing for bugs: follow one request | OK |  |
| debugging-troubleshooting | dg12 Flaky tests: measure the rate before you fix it | OK |  |
| debugging-troubleshooting | dg13 Performance regressions: prove it, localize it, gate it | OK |  |
| debugging-troubleshooting | dg14 Production debugging without making it worse | OK |  |
| debugging-troubleshooting | dg15 Feature flags and kill switches as debugging instruments | OK |  |
| debugging-troubleshooting | dg16 Root cause analysis: from symptom to mechanism | OK |  |
| debugging-troubleshooting | dg17 Writing the postmortem and updating the runbook | OK |  |
| debugging-troubleshooting | dg18 Preventing regressions: guards that actually fail | OK |  |
| debugging-troubleshooting | dg19 The debugging toolbox: what to reach for and when | OK |  |
| debugging-troubleshooting | dg20 The debugging checklist: a runbook for hard bugs | OK |  |
