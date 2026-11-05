# Rust Academy — a DeepSeek Harness plugin

An industry-grade Rust curriculum in the left sidebar of DeepSeek Harness. 30 tracks,
538 focused chapters, from `fn main` to production distributed systems — with
exercises, quizzes, quickbytes, production checklists, reference architectures and
verified links to docs, GitHub repos, papers and conference talks.

<p align="center">
  <img src="icon.svg" alt="Rust Academy crab" width="96" height="96">
</p>

## What you get

- **30 tracks / 538 chapters.** Each chapter targets one narrow concept and is
  ordered from fundamentals to production depth.
- **Hands-on by default.** Every chapter has a goal, focused explanations, real code,
  an exercise with a hint and a worked solution, and a "check yourself" quiz.
- **Industry material.** Production checklists, named failure modes ("pitfall"),
  the crates involved (linked to docs.rs), and the GitHub repositories behind them.
- **Verified references.** Each chapter links docs, GitHub repos, research papers and
  YouTube talks where they are genuinely relevant — tagged `Docs`, `Repo`, `Paper`,
  `Video`.
- **Quickbytes.** Short, paste-ready rules of thumb, commands and gotchas.
- **12 reference blueprints.** How the pieces fit together: request flow, components,
  production checklist and related chapters.
- **23-group cheatsheet.** 130 copy-ready snippets for the whole stack.
- **Progress + search.** Per-track and overall completion, plus full-text search over
  chapters, crates and patterns.

## Tracks

| # | Track | Chapters | Focus |
|---|-------|----------|-------|
| 1 | Rust fundamentals | 20 | Ownership, types, traits, iterators, async basics |
| 2 | Production web services | 8 | axum 0.8, extractors, auth, WebSockets, OpenAPI |
| 3 | Data & persistence | 7 | SQLx, transactions, Redis, object storage, integrity |
| 4 | Microservices & messaging | 8 | tonic/gRPC, Kafka, NATS, outbox, sagas, locks |
| 5 | Process handling & workers | 7 | Worker pools, cancellation, subprocesses, signals |
| 6 | Production & platform | 8 | OTel, config, resilience, Docker, K8s, CI/CD, perf |
| 7 | Rust in depth | 20 | Macros, unsafe, FFI, const generics, Pin, SIMD |
| 8 | Algorithms & problem solving | 20 | Complexity, graphs, DP, strings, interview patterns |
| 9 | Data structures in Rust | 20 | Containers, caches, arenas, lock-free structures |
| 10 | Database internals | 20 | Pages, B+trees, LSM, WAL, MVCC, planning, sharding |
| 11 | Distributed systems | 20 | Raft, consistency, CRDTs, leases, exactly-once |
| 12 | Networking & protocols | 20 | TCP/UDP, HTTP/2, QUIC, TLS, proxies, gRPC internals |
| 13 | Security engineering | 20 | Threat modelling, OIDC, crypto, secrets, supply chain |
| 14 | Testing & quality | 20 | Property tests, fuzzing, mutation, contract, load |
| 15 | Observability & reliability | 20 | Logs, metrics, traces, SLOs, alerting, profiling |
| 16 | Delivery & platform | 20 | CI/CD, containers, Kubernetes, GitOps, releases |
| 17 | Data engineering | 20 | Arrow, Parquet, Polars, CDC, orchestration, quality |
| 18 | Systems programming | 20 | Syscalls, allocators, io_uring, eBPF, WASM, no_std |
| 19 | AI/ML in Rust | 20 | candle, burn, ONNX, embeddings, RAG, serving |
| 20 | Architecture & design | 20 | DDD, hexagonal, CQRS, event sourcing, multi-tenancy |
| 21 | Interview prep | 20 | Rust questions, DSA drills, system design, mocks |
| 22 | Capstone projects | 20 | End-to-end project briefs with acceptance criteria |
| 23 | WASM & frontend | 20 | wasm-bindgen, Leptos, Yew, SSR, edge WASM |
| 24 | Embedded Rust | 20 | embedded-hal, RTIC, Embassy, DMA, power, defmt |
| 25 | Design principles | 20 | Coupling, cohesion, SOLID in Rust, type-driven design, API ergonomics |
| 26 | Engineering craft | 20 | Code review, RFCs, ADRs, debugging, incidents, mentorship, tech writing |
| 27 | Performance engineering | 20 | Profiling, allocation, cache behaviour, latency budgets, capacity |
| 28 | Concurrency patterns | 20 | Actors, CSP, structured concurrency, atomics, lock-free, testing |
| 29 | API design | 20 | REST/RPC/GraphQL, versioning, pagination, errors, SDKs, DX |
| 30 | Debugging & troubleshooting | 20 | Reproducers, bisection, traces, core dumps, deadlocks, postmortems |

## How it is wired

| Slot | Registration |
| --- | --- |
| `sidebar.panellist` | `id: rust-academy`, `order: 20`, localized `label` |
| `main` | `key: rust-academy` |

The Host half (`index.js`) is a no-op: the panel needs no Host capability. The Client
module embeds the curriculum as JSON at build time, so there is no fetch, no database
and no filesystem access at runtime. Styles use only `--dsw-alias-*` theme tokens, so
light and dark themes follow the Harness. UI text is registered in the Client locale
service under the `rust-academy` namespace; display metadata lives in `locale/en.json`
with the artwork in `icon.svg`.

## Requirements

- DeepSeek Harness (Desktop or `dsh web`) with a Web GUI.
- No runtime dependencies and no build step for installation: `client.js` is committed.

## Install

```bash
git clone https://github.com/ramanasai/dsh-rust-academy.git
```

Then, from a Harness session (Plugin Manager needs Full access or approval):

```
plugin_manager install_bundle target=/absolute/path/to/dsh-rust-academy
```

The bundle is linked from the checkout, so editing `client.js` changes the source the
profile uses; reinstall or reload the page to pick up a new module generation.

## Editing the curriculum

Content lives in `src/data/*.mjs` — one module per track, plus `reference.mjs` for the
cheatsheet and blueprints. `src/data/index.mjs` lists the track order. `src/app.js` is
the UI template; `build.mjs` injects the data and writes `client.js`.

```bash
node scripts/validate-data.mjs src/data/web.mjs   # validate one track
node build.mjs                                    # regenerate client.js
node --check client.js                            # syntax check the artifact
```

Each chapter supports: `id`, `title`, `minutes`, `level`, `goal`, `sections[]`
(`h`/`p`/`list`/`code`/`tip`), `exercise` (`prompt`/`starter`/`hint`/`solution`),
`questions[]` (MCQ with `answer` index and `explain`), `quickbytes[]`,
`production[]`, `crates[]`, `github[]`, `pitfall`, and `resources[]` with
`kind: docs|repo|paper|video`.

## Files

| File | Purpose |
| --- | --- |
| `package.json` | Bundle manifest: patch, Client module, locale and icon exports |
| `cordis.patch.yml` | Inserts the `rust-academy` row into the profile |
| `index.js` | Host half (empty `apply`) |
| `client.js` | Generated Client module: sidebar icon + full panel |
| `build.mjs` | Assembles `client.js` from `src/app.js` + `src/data/*.mjs` |
| `src/app.js` | UI template (React without JSX) |
| `src/data/` | Curriculum modules and track index |
| `scripts/validate-data.mjs` | Data-module validator |
| `locale/en.json` | Plugin Manager title and description |
| `icon.svg` | Original crab artwork |

## License

MIT — see [LICENSE](LICENSE).
