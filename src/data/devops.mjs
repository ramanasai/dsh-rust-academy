/**
 * Delivery & platform track.
 *
 * Authored for the Rust Academy plugin. Every lesson is plain JSON-compatible
 * data consumed by src/app.js through build.mjs.
 */
export default {
  "key": "devops",
  "prefix": "k",
  "title": "Delivery & platform",
  "blurb": "CI/CD, containers, Kubernetes, GitOps, release engineering and supply-chain integrity for Rust services.",
  "level": "industry",
  "project": {
    "title": "Capstone: a zero-downtime delivery pipeline",
    "brief": "Ship a Rust service through CI, signed images, GitOps deployment and canary rollout with automatic rollback. The pipeline must build once, produce an SBOM and a signature that a cluster can verify, deploy the same digest through Git, and abort a bad rollout on metrics instead of on a human noticing.",
    "deliverables": [
      "A cached, audited CI pipeline that fails on fmt, clippy, doctests, advisories, license drift and unapproved registries.",
      "A signed multi-arch image built once, with an SBOM and provenance attestation attached by digest.",
      "GitOps manifests in a separate repository, rendered by Helm or Kustomize, synced by Argo CD with prune and self-heal.",
      "A canary rollout that shifts traffic in steps and promotes or aborts from a PromQL error-rate analysis.",
      "A written rollback drill: the exact commands, the measured recovery time, and the migration rule that made rollback possible."
    ],
    "stack": [
      "cargo-chef",
      "cargo-deny",
      "syft",
      "cosign",
      "helm",
      "kube",
      "metrics-exporter-prometheus"
    ]
  },
  "lessons": [
    {
      "id": "k01",
      "n": 1,
      "title": "A CI ladder: the gates worth running",
      "minutes": 75,
      "level": "core",
      "goal": "Choose the small set of gates that actually predicts a shippable commit, order them by cost per failure, and run them identically on a laptop and in CI.",
      "sections": [
        {
          "h": "Every gate must name the failure it prevents",
          "p": [
            "A pipeline is a proof, not a build. Each gate should map to a failure you have already seen: a formatting diff that wastes review time, a clippy lint that hides a real bug, a doctest that stopped compiling two releases ago, a dependency with an advisory, a crate pulled from a registry you do not trust. If a gate cannot name its failure, delete it, because a green pipeline that proves nothing trains people to ignore red.",
            "Order gates by cost per failure caught, not by prestige. rustfmt and cargo check fail in seconds and catch a large share of review comments; the test suite takes minutes; the audit and license checks take a network round trip. Cheap gates go first on every push, expensive ones fan out in parallel behind them. The same script must run locally, or developers will only discover breakage after they push."
          ],
          "list": [
            "Format, then type-check, then lint, then test, then audit: cheapest failure first",
            "One script, invoked by both the developer and the CI runner, so the two cannot drift",
            "Fail the run on the first error in the cheap gates; do not collect every failure",
            "Every gate must be reproducible offline once dependencies are vendored or cached"
          ],
          "tip": "A check that only runs on main is a report, not a gate. If it cannot block a merge, it does not exist."
        },
        {
          "h": "The Rust-specific gates that pay for themselves",
          "p": [
            "Clippy needs three flags to be worth running: --all-targets lints tests and benches as well as the library, --all-features compiles feature-gated code that CI would otherwise never type-check, and -D warnings turns a warning into a failed build. Without --all-features, a cfg-gated module can rot for months because the default feature set never includes it.",
            "cargo nextest runs each test in its own process, retries nothing by default, and reports far faster than the built-in harness, but it does not run doctests at all. A repository that switches to nextest and drops cargo test silently stops checking every example in its documentation. Keep both: nextest for the test binaries, cargo test --doc for the snippets users copy."
          ],
          "code": "#!/usr/bin/env bash\n# scripts/ci.sh - the same gates locally and in CI. Run with --locked everywhere.\nset -euo pipefail\n\ncargo fmt --all --check\ncargo check --workspace --all-targets --all-features --locked\ncargo clippy --workspace --all-targets --all-features --locked -- -D warnings\ncargo nextest run --workspace --all-features --locked --no-fail-fast\ncargo test --workspace --doc --locked          # nextest skips doctests\ncargo deny check                               # advisories, licenses, bans, sources\n\n# Optional, and slow enough to belong behind a path filter:\ncargo test --workspace --locked --release      # catches debug-only assumptions\ncargo doc --workspace --no-deps --locked       # broken intra-doc links fail the build",
          "tip": "Put --locked in every command. Without it CI happily resolves a new patch release that your Cargo.lock never saw."
        },
        {
          "h": "The supply-chain gate: deny.toml",
          "p": [
            "cargo deny check runs four independent checks over the resolved graph: advisories from the RustSec database, licences against an allow-list, bans on named crates or on duplicate versions, and sources so that only approved registries and git hosts can appear. It is one command and one config file, which is why it belongs in the same ladder as fmt and clippy rather than in a quarterly audit that nobody schedules.",
            "The config schema has moved, and older examples are actively wrong. In current releases version = 2 is no longer used, and the removed keys vulnerability, unlicensed, deny and copyleft now emit errors instead of being quietly ignored, so a deny.toml copied from an older post fails on the key rather than on a crate. Run cargo deny init to generate the schema for the installed version, then move your values across."
          ],
          "code": "# deny.toml - generate the skeleton with `cargo deny init`\n[advisories]\nyanked = \"deny\"\nunmaintained = \"workspace\"       # fail on unmaintained direct dependencies\nignore = [\n  { id = \"RUSTSEC-2024-0001\", reason = \"no code path reaches the parser\", expiry = \"P90D\" },\n]\n\n[licenses]\nallow = [\"MIT\", \"Apache-2.0\", \"Apache-2.0 WITH LLVM-exception\", \"BSD-3-Clause\"]\nconfidence-threshold = 0.95\n\n[bans]\nmultiple-versions = \"warn\"\ndeny = [{ name = \"openssl-sys\", reason = \"static builds use rustls\" }]\n\n[sources]\nunknown-registry = \"deny\"\nunknown-git = \"deny\"\nallow-registry = [\"https://github.com/rust-lang/crates.io-index\"]",
          "list": [
            "unknown-registry and unknown-git set to deny: crates.io plus named hosts, nothing else",
            "Every ignored advisory carries a reason and an expiry, never a bare identifier",
            "multiple-versions = warn surfaces duplicate crates without blocking the build",
            "A ban on a crate you have replaced (openssl-sys) stops a transitive dependency reintroducing it"
          ],
          "tip": "A deny.toml from an older release fails on schema, not on a dependency. Regenerate with cargo deny init and move the values."
        },
        {
          "h": "Make failure cheap before making the pipeline fast",
          "p": [
            "The instinct is to parallelize first. The better first move is to shorten the feedback loop: split the workspace so a change to one crate does not rebuild everything, keep a debug profile that links incrementally, and make the fast gates finish in under two minutes. A pipeline that finishes in four minutes but reports the wrong thing is worse than a ten-minute one that is trusted.",
            "Two anti-patterns destroy that trust. Automatic retries hide flakiness until it becomes an outage, and continue-on-error turns a gate into decoration that still shows a green check. Fix or delete a flaky test; if a check is genuinely advisory, mark it non-blocking in the branch protection rules instead, where everyone can see the exception."
          ],
          "list": [
            "Never retry a failing test to make the pipeline green",
            "Prefer deleting an advisory gate over wrapping it in continue-on-error",
            "Upload the failure artifact (test report, clippy JSON) so the fix does not need a rerun",
            "Time-box every job so a hung test cannot hold a runner for an hour"
          ],
          "tip": "If a gate is slow and unreliable, it will be bypassed within a month. Reliability is a feature of the gate, not of the tool."
        }
      ],
      "exercise": {
        "prompt": "A repository runs only cargo test. Write the full gate ladder as one script, including the doctest and audit steps, and add a comment explaining which gate you would cut first if the budget were ten minutes.",
        "starter": "#!/usr/bin/env bash\nset -euo pipefail\n\n# 1. formatting\n# 2. type-check all targets and features\n# 3. clippy with warnings denied\n# 4. tests (which runner?) and doctests separately\n# 5. dependency audit",
        "hint": "nextest does not run doctests, so cargo test --doc stays. cargo deny check is one command covering advisories, licenses, bans and sources. Cut the release-mode test run first: it is the slowest and duplicates debug coverage.",
        "solution": "#!/usr/bin/env bash\nset -euo pipefail\n\ncargo fmt --all --check\ncargo check --workspace --all-targets --all-features --locked\ncargo clippy --workspace --all-targets --all-features --locked -- -D warnings\ncargo nextest run --workspace --all-features --locked --no-fail-fast\ncargo test --workspace --doc --locked\ncargo deny check\n\n# Budget note: under ten minutes, drop the release-mode test run first.\n# It duplicates the debug run's coverage and is the most expensive gate.\n# Keep doctests: they are the only check on the examples users copy."
      },
      "questions": [
        {
          "q": "You replace cargo test with cargo nextest run. What stops being checked?",
          "options": [
            "Integration tests under tests/",
            "Tests behind feature flags",
            "Unit tests inside #[cfg(test)] modules",
            "Doctests in /// examples and crate-level docs"
          ],
          "answer": 3,
          "explain": "nextest runs test binaries and deliberately does not run doctests, which are compiled as separate crates by rustdoc. Keep cargo test --doc in the pipeline or documentation examples silently rot."
        },
        {
          "q": "Why pass --all-features to clippy rather than the default feature set?",
          "options": [
            "It makes clippy run faster by compiling once",
            "It is required for -D warnings to take effect",
            "Code behind non-default features is otherwise never type-checked or linted in CI",
            "It disables the incremental cache, which is more accurate"
          ],
          "answer": 2,
          "explain": "Cargo only compiles the features you enable. Optional modules gated behind a non-default feature will not be linted unless some job turns that feature on, so they can break for months without a red build."
        },
        {
          "q": "A test is flaky about once in thirty runs. What is the correct pipeline change?",
          "options": [
            "Retry the job up to three times automatically",
            "Mark the job continue-on-error so the pipeline stays green",
            "Fix or delete the test, and never let the pipeline retry it",
            "Move the test to a nightly-only workflow"
          ],
          "answer": 2,
          "explain": "Retries convert a known defect into a hidden one and teach the team that red means nothing. A flaky test is either a real race in the product or a bad test; both need a fix, not a retry policy."
        }
      ],
      "quickbytes": [
        "cargo fmt --all --check, never cargo fmt, inside CI.",
        "cargo clippy --all-targets --all-features -- -D warnings is the whole lint gate.",
        "nextest skips doctests; cargo test --doc is a separate step.",
        "cargo deny check runs advisories, licenses, bans and sources in one pass."
      ],
      "production": [
        "One script runs every gate locally and in CI, so a green laptop means a green pipeline.",
        "All cargo invocations use --locked so CI never resolves a version the lockfile never saw.",
        "Branch protection requires the gates, not just the pipeline run, to pass.",
        "Failure artifacts (test reports, clippy JSON) are uploaded so triage does not need a rerun.",
        "Doctests are a required job; switching to nextest without them is a silent coverage loss."
      ],
      "crates": [
        "cargo-nextest",
        "cargo-deny",
        "cargo-audit"
      ],
      "github": [
        {
          "name": "nextest-rs/nextest",
          "url": "https://github.com/nextest-rs/nextest"
        },
        {
          "name": "rustsec/rustsec",
          "url": "https://github.com/rustsec/rustsec"
        }
      ],
      "pitfall": "Moving to nextest and dropping cargo test entirely: every doctest in the crate stops being compiled, so examples in the public API break for users while CI stays green.",
      "resources": [
        {
          "title": "The Cargo Book: cargo test",
          "url": "https://doc.rust-lang.org/cargo/commands/cargo-test.html",
          "kind": "docs"
        },
        {
          "title": "Clippy usage and lint configuration",
          "url": "https://doc.rust-lang.org/clippy/usage.html",
          "kind": "docs"
        },
        {
          "title": "nextest: a next-generation test runner for Rust",
          "url": "https://github.com/nextest-rs/nextest",
          "kind": "repo"
        },
        {
          "title": "RustSec: advisory database and cargo-audit",
          "url": "https://github.com/rustsec/rustsec",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "k02",
      "n": 2,
      "title": "GitHub Actions: permissions, jobs, artifacts",
      "minutes": 75,
      "level": "core",
      "goal": "Write a workflow whose token permissions are minimal, whose jobs hand off state through artifacts rather than luck, and whose concurrency rules stop duplicate deploys.",
      "sections": [
        {
          "h": "The token is the security boundary",
          "p": [
            "Every workflow run gets a GITHUB_TOKEN whose scopes come from the permissions block. Omitting the block leaves the repository default, which is often read-write on contents, packages and more; a compromised dependency in a build step then inherits that. Set permissions: contents: read at the top of the workflow and widen it per job, where the widening is visible next to the step that needs it.",
            "Two triggers carry most of the risk. pull_request from a fork runs with a read-only token and no secrets, which is the safe default; pull_request_target runs in the base repository's context with secrets and is the classic path to remote code execution when the job checks out and builds the contributor's code. If you need pull_request_target for labeling, never combine it with a checkout of the head commit."
          ],
          "code": "name: ci\non:\n  push:\n    branches: [main]\n  pull_request:\n\npermissions:\n  contents: read\n\nconcurrency:\n  group: ci-${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n\njobs:\n  lint:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 15\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions-rust-lang/setup-rust-toolchain@v1\n        with:\n          toolchain: 1.85.0\n          components: clippy,rustfmt\n      - run: ./scripts/ci.sh",
          "tip": "cancel-in-progress on pull_request only: cancelling a main-branch deploy midway leaves the cluster in a half-applied state."
        },
        {
          "h": "Jobs do not share a disk",
          "p": [
            "Each job starts on a fresh runner. Environment variables, built binaries and the target directory do not survive between jobs, so a build job that compiles the binary and a test job that expects to find it will fail in a way that looks like a cache problem. Either keep build and test in one job, or pass the artifact explicitly with upload-artifact and download-artifact.",
            "needs builds the dependency graph and gates downstream jobs on success. Use it to make deploy depend on both test and image, and remember that a skipped dependency skips its dependents too. For cleanup steps that must run regardless, use if: always() on that specific job rather than weakening the gate."
          ],
          "code": "jobs:\n  build:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions-rust-lang/setup-rust-toolchain@v1\n        with:\n          toolchain: 1.85.0\n      - run: cargo build --release --locked --bin api\n      - uses: actions/upload-artifact@v4\n        with:\n          name: api-binary\n          path: target/release/api\n          retention-days: 3\n\n  smoke:\n    needs: build\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/download-artifact@v4\n        with:\n          name: api-binary\n          path: ./bin\n      - run: chmod +x ./bin/api && ./bin/api --self-check",
          "tip": "Artifact names must be unique per job or the second upload fails; include the matrix value in the name when you fan out."
        },
        {
          "h": "Caching is an optimization, never a correctness input",
          "p": [
            "The dependency cache is keyed by a hash of Cargo.lock plus the toolchain and the rustflags. If any of those is missing from the key, a restored cache can contain artifacts compiled with different settings, and cargo will either rebuild everything or, worse, reuse a stale proc-macro output. Include the target triple too, or an aarch64 job will happily restore an x86_64 cache.",
            "Treat a cache miss as normal and a cache restore as a bonus. Never make the build depend on a cache entry existing, and never cache secrets or anything derived from them. For Rust, the two things worth caching are the cargo registry and git checkouts, plus a compiler cache such as sccache; the target directory is usually too large and too sensitive to flags to restore reliably."
          ],
          "list": [
            "Key on Cargo.lock hash, toolchain version, target triple and RUSTFLAGS",
            "Restore the registry and git db before the build; let sccache handle compiled objects",
            "Never cache target/ across different feature sets or profiles",
            "Cache writes from forks are read-only; do not build a workflow that assumes otherwise"
          ],
          "tip": "Print the cache hit result in the job log. A cache that silently never hits looks exactly like a slow build."
        }
      ],
      "exercise": {
        "prompt": "Given a single job that builds, tests and pushes an image, split it into build, test and publish jobs with minimal permissions, an artifact handoff, and a concurrency rule that does not cancel main-branch runs.",
        "starter": "name: ci\non: [push, pull_request]\n\njobs:\n  everything:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@v4\n      - run: cargo build --release --locked\n      - run: cargo nextest run --locked\n      # push image here\n",
        "hint": "Top-level permissions: contents: read; give the publish job packages: write and id-token: write. Upload the binary as an artifact in build and download it in test. Set cancel-in-progress only for pull_request events.",
        "solution": "name: ci\non:\n  push:\n    branches: [main]\n  pull_request:\n\npermissions:\n  contents: read\n\nconcurrency:\n  group: ci-${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n\njobs:\n  build:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 20\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions-rust-lang/setup-rust-toolchain@v1\n        with:\n          toolchain: 1.85.0\n      - run: cargo build --release --locked --bin api\n      - uses: actions/upload-artifact@v4\n        with:\n          name: api-binary\n          path: target/release/api\n\n  test:\n    needs: build\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions-rust-lang/setup-rust-toolchain@v1\n        with:\n          toolchain: 1.85.0\n      - run: cargo nextest run --locked\n\n  publish:\n    needs: [build, test]\n    if: github.ref == 'refs/heads/main'\n    runs-on: ubuntu-24.04\n    permissions:\n      contents: read\n      packages: write\n      id-token: write\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/download-artifact@v4\n        with:\n          name: api-binary\n          path: ./bin\n      - run: ./scripts/publish-image.sh ./bin/api"
      },
      "questions": [
        {
          "q": "What does a workflow without a permissions block inherit?",
          "options": [
            "A read-only token by default in every repository",
            "The repository or organization default, which may be read-write",
            "A token scoped to the triggering user's rights",
            "No token at all"
          ],
          "answer": 1,
          "explain": "GitHub lets the repository or organization set the default GITHUB_TOKEN scope, and many older repositories still default to read-write. Declaring permissions explicitly makes the blast radius a reviewed line of YAML."
        },
        {
          "q": "A job that needs the binary built by an earlier job fails with 'no such file'. Why?",
          "options": [
            "Each job runs on a fresh runner, so files do not persist between jobs",
            "Artifacts are deleted when the job finishes successfully",
            "Cargo stores the binary in a temporary directory",
            "The build job did not use --locked"
          ],
          "answer": 0,
          "explain": "Jobs are isolated. Pass data with upload-artifact and download-artifact, or keep the steps in one job. Environment variables do not cross job boundaries either."
        },
        {
          "q": "Which trigger combination is the classic remote-code-execution risk?",
          "options": [
            "pull_request_target combined with a checkout and build of the contributor's head commit",
            "schedule with a read-only token",
            "pull_request with contents: read",
            "push to main with id-token: write"
          ],
          "answer": 0,
          "explain": "pull_request_target runs in the base repository context with secrets available. Checking out and executing untrusted head code there hands those secrets to the contributor."
        }
      ],
      "quickbytes": [
        "permissions: contents: read at the top; widen per job, not per workflow.",
        "cancel-in-progress only for pull_request, never for a deploy on main.",
        "timeout-minutes on every job, or a hung test holds a runner for hours.",
        "Artifacts, not environment variables, are how state crosses job boundaries."
      ],
      "production": [
        "Workflow-level permissions default to contents: read, with widening declared per job.",
        "Deploy jobs are gated by needs on both test and image build, and never run on pull_request.",
        "Artifact names include the matrix value so parallel jobs cannot collide.",
        "Cache keys include Cargo.lock hash, toolchain, target triple and RUSTFLAGS.",
        "Every job sets timeout-minutes, and the workflow logs whether the cache hit."
      ],
      "crates": [
        "cargo-nextest",
        "cargo-deny"
      ],
      "github": [
        {
          "name": "nextest-rs/nextest",
          "url": "https://github.com/nextest-rs/nextest"
        },
        {
          "name": "actions-rust-lang/setup-rust-toolchain",
          "url": "https://github.com/actions-rust-lang/setup-rust-toolchain"
        }
      ],
      "pitfall": "Reaching for pull_request_target to get secrets into a fork PR, then checking out the PR head: untrusted code runs with your token, and the first sign is a pushed commit you did not author.",
      "resources": [
        {
          "title": "Docker Docs: GitHub Actions build pipeline",
          "url": "https://docs.docker.com/build/ci/github-actions/",
          "kind": "docs"
        },
        {
          "title": "setup-rust-toolchain action",
          "url": "https://github.com/actions-rust-lang/setup-rust-toolchain",
          "kind": "repo"
        },
        {
          "title": "actions/runner: the runner that executes workflow jobs",
          "url": "https://github.com/actions/runner",
          "kind": "repo"
        },
        {
          "title": "GitHub channel: Actions and platform talks",
          "url": "https://www.youtube.com/@github",
          "kind": "video"
        }
      ]
    },
    {
      "id": "k03",
      "n": 3,
      "title": "Build caching that survives a cold machine",
      "minutes": 90,
      "level": "advanced",
      "goal": "Explain why Rust rebuilds from scratch, then cut rebuild time with cargo-chef for dependency layers, sccache for object reuse, and cache keys that cannot silently go stale.",
      "sections": [
        {
          "h": "Why the compiler throws the work away",
          "p": [
            "Cargo decides whether to rebuild a unit from a fingerprint: the compiler version, the feature set, RUSTFLAGS, the profile, and the mtimes of every input. Change any of those and the unit is dirty. In a container the mtime problem is worse, because COPY resets file timestamps and cargo's fingerprinting relies on timestamps for path dependencies, which is why a single-line change to your crate can rebuild every workspace member.",
            "Two properties make this expensive in Rust specifically. Monomorphization means generic-heavy crates like serde or tokio compile a lot of code per consuming crate, and proc macros run as host programs before any of it starts. A release build of a mid-sized service can spend four to six minutes on dependencies and twenty seconds on the code you actually changed, which is exactly the ratio a cache should attack."
          ],
          "list": [
            "Fingerprints include RUSTFLAGS, profile, features and toolchain - all must be in the cache key",
            "Proc macros compile for the host, so a cross build cannot reuse host artifacts blindly",
            "Incremental compilation is off in release profiles by default",
            "Path dependencies are re-fingerprinted by mtime, not content hash"
          ],
          "tip": "cargo build --timings writes an HTML report that shows which crates dominate the build. Cache the top five, not the whole graph."
        },
        {
          "h": "cargo-chef caches the dependency layer",
          "p": [
            "cargo-chef splits the build into two phases. prepare analyses the workspace and emits recipe.json, a skeleton of every manifest and the lockfile with all targets declared explicitly; cook rehydrates that skeleton and builds the dependencies. Because the recipe changes only when a manifest, a feature or the lockfile changes, the cook layer stays cached across ordinary source edits.",
            "Two constraints come straight from the project's own documentation. cook and build must run from the same working directory, because the .d files under target contain absolute paths, and every stage must use the same Rust version, or the cached layer is silently invalidated. Run prepare on the full source tree, then copy only recipe.json into the builder stage."
          ],
          "code": "# syntax=docker/dockerfile:1\nFROM rust:1.85-bookworm AS chef\nRUN cargo install --locked cargo-chef\nWORKDIR /app\n\nFROM chef AS planner\nCOPY . .\nRUN cargo chef prepare --recipe-path recipe.json\n\nFROM chef AS builder\nCOPY --from=planner /app/recipe.json recipe.json\nRUN cargo chef cook --release --locked --recipe-path recipe.json\nCOPY . .\nRUN cargo build --release --locked --bin api\n\nFROM debian:bookworm-slim AS runtime\nCOPY --from=builder /app/target/release/api /usr/local/bin/api\nENTRYPOINT [\"/usr/local/bin/api\"]",
          "tip": "Never run cargo chef prepare outside a container. It rewrites files in the source tree and will clobber a working checkout."
        },
        {
          "h": "sccache reuses compiled objects across machines",
          "p": [
            "cargo-chef helps within one Docker layer history; sccache helps across machines and branches. It wraps rustc via RUSTC_WRAPPER, hashes the compilation inputs, and returns a cached object file when the hash matches. Because the key is the compiler invocation rather than the target directory, sccache survives a wiped target/ and a fresh runner.",
            "The economics only work with a shared backend. A local sccache on an ephemeral runner starts empty on every job; point it at a remote store (S3, Redis, or GitHub Actions cache via SCCACHE_GHA_ENABLED) and hit rates climb after the first branch warms it. Expect 50 to 80 percent on repeated CI runs, and near zero on a cache miss - so measure rather than assume."
          ],
          "code": "# In the builder stage:\n#   ENV RUSTC_WRAPPER=sccache SCCACHE_GHA_ENABLED=true\n#   RUN --mount=type=cache,target=/usr/local/cargo/registry \\\n#       --mount=type=cache,target=/root/.cache/sccache \\\n#       cargo build --release --locked --bin api\n\n# Outside containers, on a self-hosted runner:\n#   export RUSTC_WRAPPER=sccache\n#   export SCCACHE_BUCKET=acme-rust-sccache\n#   sccache --start-server\n#   sccache --show-stats   # check hits before and after a change\n\n# CI cache key that cannot go stale:\n#   ${{ runner.os }}-${{ hashFiles('**/Cargo.lock') }}-${{ env.RUSTFLAGS }}-rust1.85",
          "tip": "sccache and a target/ cache solve different problems. Restoring target/ across a flag change causes full rebuilds; sccache just misses."
        },
        {
          "h": "Cache keys that cannot lie",
          "p": [
            "A cache key is a promise about compatibility. If the key omits the target triple, an aarch64 job restores x86_64 objects and either fails at link time or, with sccache, silently misses. If it omits RUSTFLAGS, a job with -C target-cpu=native reuses objects built for a generic CPU. Compose the key from the inputs that change codegen and nothing else.",
            "Then make cache health observable. Print sccache --show-stats and the cache hit outcome in the job log, and alert when the hit rate collapses, because that usually means a key silently changed shape or the backend credentials expired. A cache is an optimization: the build must still be correct on a cold runner, which is why a nightly uncached build is worth keeping."
          ],
          "list": [
            "Key on lockfile hash, toolchain, target triple and RUSTFLAGS",
            "Keep one scheduled cold build to prove the pipeline works without any cache",
            "Never cache target/ across profiles, feature sets or targets",
            "Rotate the cache when the compiler major version changes"
          ],
          "tip": "If a cache change makes CI faster but a clean build fails, you have found a missing input in the key, not a win."
        }
      ],
      "exercise": {
        "prompt": "A Rust service takes 6 minutes to build in CI, 5 of them on dependencies. Add cargo-chef to the Dockerfile and an sccache configuration, then write the cache key you would use for the registry cache and justify each component.",
        "starter": "# syntax=docker/dockerfile:1\nFROM rust:1.85-bookworm AS builder\nWORKDIR /app\nCOPY . .\nRUN cargo build --release --locked\n\nFROM debian:bookworm-slim\nCOPY --from=builder /app/target/release/api /usr/local/bin/api\nENTRYPOINT [\"/usr/local/bin/api\"]",
        "hint": "Three stages: chef installs cargo-chef, planner runs prepare, builder runs cook then build. Put RUSTC_WRAPPER=sccache in the builder and mount the cargo registry as a BuildKit cache.",
        "solution": "# syntax=docker/dockerfile:1\nFROM rust:1.85-bookworm AS chef\nRUN cargo install --locked cargo-chef\nWORKDIR /app\n\nFROM chef AS planner\nCOPY . .\nRUN cargo chef prepare --recipe-path recipe.json\n\nFROM chef AS builder\nENV RUSTC_WRAPPER=sccache \\\n    SCCACHE_GHA_ENABLED=true\nCOPY --from=planner /app/recipe.json recipe.json\nRUN --mount=type=cache,target=/usr/local/cargo/registry \\\n    --mount=type=cache,target=/root/.cache/sccache \\\n    cargo chef cook --release --locked --recipe-path recipe.json\nCOPY . .\nRUN --mount=type=cache,target=/usr/local/cargo/registry \\\n    --mount=type=cache,target=/root/.cache/sccache \\\n    cargo build --release --locked --bin api\n\nFROM debian:bookworm-slim AS runtime\nCOPY --from=builder /app/target/release/api /usr/local/bin/api\nUSER 65532:65532\nENTRYPOINT [\"/usr/local/bin/api\"]\n\n# Registry cache key: lockfile hash (dependency set) + toolchain (codegen)\n# + target triple (object format) + RUSTFLAGS (codegen flags).\n# Anything else either causes spurious misses or unsafe hits."
      },
      "questions": [
        {
          "q": "Why must cargo chef cook and cargo build run in the same working directory?",
          "options": [
            "The .d files cargo writes contain absolute paths to the target directory, so a moved project loses the cached units",
            "Docker requires identical WORKDIR across stages",
            "sccache keys on the working directory",
            "cargo-chef stores an absolute path in recipe.json"
          ],
          "answer": 0,
          "explain": "Cargo's dep-info files record absolute paths. If cook ran in /app and build runs in /src, cargo cannot match the cached dependencies and rebuilds them, silently defeating the cache."
        },
        {
          "q": "What does sccache reuse that restoring target/ does not?",
          "options": [
            "The Cargo.lock resolution",
            "Proc macro expansion output for the current checkout",
            "The compiled dependency graph across branches and machines, keyed on the compiler invocation",
            "Incremental compilation metadata for the local crate"
          ],
          "answer": 2,
          "explain": "sccache hashes the rustc invocation and stores the resulting object. It works from a cold target directory and across machines sharing a backend, which a target/ tarball cannot do safely across flags."
        },
        {
          "q": "Which cache key component is missing if an aarch64 job restores x86_64 artifacts?",
          "options": [
            "The Cargo.lock hash",
            "The Rust toolchain version",
            "The target triple",
            "The runner operating system"
          ],
          "answer": 2,
          "explain": "Objects are target-specific. Without the triple in the key, the two matrix legs collide on one cache entry and one of them restores objects it cannot link."
        }
      ],
      "quickbytes": [
        "cargo build --timings shows where the six minutes actually go.",
        "cargo chef prepare rewrites the source tree; only ever run it in a container.",
        "Same working directory and same toolchain in every stage, or the chef layer is wasted.",
        "sccache needs a shared backend; a local cache on an ephemeral runner is a no-op."
      ],
      "production": [
        "Every Dockerfile uses the planner/builder/runtime split with cook before the source copy.",
        "sccache is configured with a shared backend and its hit rate is logged per job.",
        "Cache keys include lockfile hash, toolchain, target triple and RUSTFLAGS.",
        "A scheduled uncached build runs nightly to prove the pipeline works cold.",
        "Build timing regressions are visible: the job reports total build time and dependency time."
      ],
      "crates": [
        "cargo-chef",
        "sccache"
      ],
      "github": [
        {
          "name": "LukeMathWalker/cargo-chef",
          "url": "https://github.com/LukeMathWalker/cargo-chef"
        },
        {
          "name": "mozilla/sccache",
          "url": "https://github.com/mozilla/sccache"
        }
      ],
      "pitfall": "Adding a BuildKit cache mount on target/ and then copying the binary from it in a later stage: cache mounts are not part of the image, so the COPY finds nothing and the build fails only on a cold cache.",
      "resources": [
        {
          "title": "cargo-chef crate documentation",
          "url": "https://docs.rs/cargo-chef/latest/chef/",
          "kind": "docs"
        },
        {
          "title": "Docker Docs: build cache",
          "url": "https://docs.docker.com/build/cache/",
          "kind": "docs"
        },
        {
          "title": "sccache: shared compilation cache",
          "url": "https://github.com/mozilla/sccache",
          "kind": "repo"
        },
        {
          "title": "Build Systems a la Carte (arXiv:1809.02942)",
          "url": "https://arxiv.org/abs/1809.02942",
          "kind": "paper"
        }
      ]
    },
    {
      "id": "k04",
      "n": 4,
      "title": "What is actually inside your image",
      "minutes": 60,
      "level": "core",
      "goal": "Read an image as layers plus config, choose a runtime base by ABI rather than fashion, and pin by digest so a tag cannot change under a running cluster.",
      "sections": [
        {
          "h": "An image is a manifest, layers and a config",
          "p": [
            "An image is a content-addressed manifest pointing at layer blobs plus a config with environment, entrypoint and architecture. The tag is a mutable pointer to the manifest digest; the digest is the only immutable identifier. Two builds of the same commit can produce different digests, so a deploy record that says only myregistry/api:1.4.2 cannot tell you what ran.",
            "Layers are shared and additive. Each RUN, COPY and ADD creates a layer whose digest depends on its inputs, so ordering instructions from least to most frequently changing lets a registry reuse blobs across builds. A single RUN that installs packages and copies source produces one fat layer that changes on every commit and is re-pulled by every node."
          ],
          "list": [
            "Tag for humans, digest for deploys and rollbacks",
            "Order layers from stable to volatile so sharing actually happens",
            "Every layer you add is bytes every node pulls on a cold start",
            "docker history shows layer size; a 400 MB layer is usually a build toolchain"
          ],
          "tip": "Deploy by digest. kubectl set image with a digest cannot silently pull different bytes than the ones you signed."
        },
        {
          "h": "Pick a base by ABI, not by size chart",
          "p": [
            "A Rust binary's runtime needs depend on how it was linked. A default x86_64-unknown-linux-gnu build dynamically links glibc, so the runtime image must provide a compatible glibc, which rules out alpine's musl unless you rebuild for musl. A musl static build has no libc dependency but also no dynamic loader, so anything that dlopens - some TLS stacks, some DNS resolvers - needs attention.",
            "Then decide on the shell. debian-slim gives you apt and a shell, which is convenient for debugging and a liability for attack surface. distroless or scratch removes both and forces you to debug through logs, metrics and ephemeral containers instead. The honest trade-off is operational: pick the smallest image your team can actually diagnose at 3 a.m."
          ],
          "code": "# Debian slim: glibc-compatible, has a shell, ~80 MB before your binary.\nFROM debian:bookworm-slim\nRUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \\\n    && rm -rf /var/lib/apt/lists/*\nCOPY --from=builder /app/target/release/api /usr/local/bin/api\nUSER 65532:65532\nENTRYPOINT [\"/usr/local/bin/api\"]\n\n# Verify what the registry really stores:\n#   docker buildx imagetools inspect registry.example.com/api:1.4.2\n#   docker image inspect api:1.4.2 --format '{{.RepoDigests}}'\n#   docker history --no-trunc api:1.4.2",
          "tip": "Pin the base by digest (debian:bookworm-slim@sha256:...) in production builds; a moving base tag is an unreviewed dependency update."
        },
        {
          "h": "Scan, sign and refuse to run :latest",
          "p": [
            "A scan is a snapshot against a database, not a property of the image. Trivy or Grype will report OS packages and, with the right flags, Rust crates from Cargo.lock; the same image scanned a week later can fail. That is why scanning belongs in CI as a gate on new critical findings, and in the registry as a continuous job, not as a one-time approval.",
            "The runtime side is about pull semantics. With imagePullPolicy: Always, every pod start hits the registry and a tag flip changes what runs without a deploy record. With IfNotPresent, a node that already has the tag keeps running old bytes. Neither is a substitute for an immutable digest: pin the digest in the manifest and let policy controllers reject anything else."
          ],
          "code": "# Gate in CI: fail on HIGH/CRITICAL in the OS layer, report the rest.\ntrivy image --exit-code 1 --severity HIGH,CRITICAL \\\n  --ignore-unfixed registry.example.com/api@sha256:abc123\n\n# Kubernetes: pin and pull once.\n# spec:\n#   containers:\n#     - name: api\n#       image: registry.example.com/api@sha256:abc123\n#       imagePullPolicy: IfNotPresent",
          "list": [
            "Scan on every build; treat the registry scan as a second opinion, not the gate",
            "Fail only on actionable severities, or the gate gets muted within a week",
            "Record the digest in the deploy log, not the tag",
            "A private registry needs imagePullSecrets on the ServiceAccount, not on every Pod"
          ],
          "tip": "If your deploy tool cannot answer 'which digest is running in prod right now', fix that before adding another scanner."
        }
      ],
      "exercise": {
        "prompt": "Write a runtime stage for a glibc-linked Rust binary that runs as a non-root user, includes CA certificates for outbound TLS, and is pinned by digest. Then list the two commands you would run to prove what is in the published image.",
        "starter": "FROM debian:bookworm-slim\n# add CA certs, copy the binary, drop root, set the entrypoint\n",
        "hint": "Use --no-install-recommends and remove /var/lib/apt/lists in the same RUN so it stays one layer. USER 65532:65532 is the distroless nonroot uid, which also works on Debian. Prove the contents with imagetools inspect and docker history.",
        "solution": "FROM debian:bookworm-slim@sha256:0000000000000000000000000000000000000000000000000000000000000000 AS runtime\nRUN apt-get update \\\n    && apt-get install -y --no-install-recommends ca-certificates \\\n    && rm -rf /var/lib/apt/lists/*\nCOPY --from=builder /app/target/release/api /usr/local/bin/api\nUSER 65532:65532\nENV RUST_LOG=info\nEXPOSE 8080\nENTRYPOINT [\"/usr/local/bin/api\"]\n\n# Proof of contents:\n#   docker buildx imagetools inspect registry.example.com/api:1.4.2\n#   docker history --no-trunc registry.example.com/api:1.4.2\n# Replace the placeholder digest with the one your registry reports."
      },
      "questions": [
        {
          "q": "What makes an image reference immutable?",
          "options": [
            "The digest, which is the content hash of the manifest",
            "Setting imagePullPolicy to Always",
            "Signing the image with cosign",
            "A semantic version tag such as 1.4.2"
          ],
          "answer": 0,
          "explain": "Tags are mutable pointers. The digest is derived from the manifest content, so referencing it pins the exact bytes. Signing proves who produced the bytes but does not make a tag immutable."
        },
        {
          "q": "A default cargo build --release binary fails in alpine with a missing loader error. Why?",
          "options": [
            "Alpine lacks CA certificates",
            "The binary was linked against glibc, and alpine uses musl",
            "Alpine does not support static binaries",
            "The binary needs a newer kernel"
          ],
          "answer": 1,
          "explain": "The gnu target links glibc dynamically. Alpine ships musl and no glibc, so the loader cannot resolve it. Rebuild for x86_64-unknown-linux-musl or use a glibc base image."
        },
        {
          "q": "Why is a registry-side scan not a replacement for the CI scan?",
          "options": [
            "CI scans are required by OCI spec",
            "Registry scanners cannot read Cargo.lock",
            "A scan is a snapshot: new advisories appear later, so continuous scanning is also needed",
            "Registry scans only cover base images"
          ],
          "answer": 2,
          "explain": "The vulnerability database changes after the build. CI catches what is known at build time; continuous registry scanning catches what is disclosed later. You need both."
        }
      ],
      "quickbytes": [
        "Deploy by digest; tags are for humans.",
        "docker buildx imagetools inspect shows the manifest and its platform entries.",
        "Install packages and delete the apt lists in one RUN, or the layer doubles.",
        "imagePullPolicy: Always with a mutable tag means a tag flip changes prod silently."
      ],
      "production": [
        "Production manifests reference image digests, and the deploy log records the digest.",
        "Base images are pinned by digest and updated by an automated, reviewable PR.",
        "The runtime user is non-root and the root filesystem is read-only where the app allows it.",
        "CI fails on new HIGH or CRITICAL findings; a scheduled registry scan covers later disclosures.",
        "The registry pull secret lives on the ServiceAccount, not duplicated in every manifest."
      ],
      "crates": [
        "rustls",
        "tokio"
      ],
      "github": [
        {
          "name": "rustls/rustls",
          "url": "https://github.com/rustls/rustls"
        },
        {
          "name": "aquasecurity/trivy",
          "url": "https://github.com/aquasecurity/trivy"
        }
      ],
      "pitfall": "Using imagePullPolicy: IfNotPresent with a mutable tag: nodes that already cached the tag keep running the old binary after a deploy, and the rollout looks successful because the pods are healthy.",
      "resources": [
        {
          "title": "Dockerfile reference",
          "url": "https://docs.docker.com/reference/dockerfile/",
          "kind": "docs"
        },
        {
          "title": "Docker Docs: building best practices",
          "url": "https://docs.docker.com/build/building/best-practices/",
          "kind": "docs"
        },
        {
          "title": "Official Rust Docker images",
          "url": "https://github.com/rust-lang/docker-rust",
          "kind": "repo"
        },
        {
          "title": "Trivy: vulnerability and misconfiguration scanner",
          "url": "https://github.com/aquasecurity/trivy",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "k05",
      "n": 5,
      "title": "Multi-stage builds without a 2 GB image",
      "minutes": 75,
      "level": "core",
      "goal": "Separate the build toolchain from the runtime stage, keep the binary reproducible with --locked, and avoid the cache-mount and COPY traps that make multi-stage builds fail only on cold machines.",
      "sections": [
        {
          "h": "Each stage answers one question",
          "p": [
            "A stage is a filesystem snapshot with a purpose. The planner stage answers what the dependency graph is, the builder stage answers how to compile it, and the runtime stage answers what the process needs at run time. Anything not needed by the last question should not exist in the final image, and with multi-stage builds it does not: only the paths you COPY survive.",
            "The practical benefit is size and attack surface at once. The rust:1.85 image is over a gigabyte with the toolchain, and none of it belongs in production. Copying a single stripped binary into a slim base takes the final image to tens of megabytes, which shortens cold-start pulls on every node and removes a compiler from anything that can be exploited."
          ],
          "list": [
            "Builder stage: toolchain, source, target directory, nothing else",
            "Runtime stage: binary, CA certificates, timezone data if you need it",
            "Never COPY the whole target directory into the runtime stage",
            "Name your stages so COPY --from reads like documentation"
          ],
          "tip": "If the final image contains cargo, you are shipping a build toolchain to production."
        },
        {
          "h": "The two traps that only appear cold",
          "p": [
            "The first trap is cache mounts. RUN --mount=type=cache,target=/app/target keeps the target directory out of the layer, so a later COPY --from=builder /app/target/release/api finds nothing. The binary must be copied within the same RUN that produced it, or the target directory must be a real layer. This passes on a developer machine with a warm local cache mount and fails in CI.",
            "The second is --locked. Without it, cargo may resolve a newer patch version inside the builder, so the image contains a dependency set your Cargo.lock and your audit never saw. Always pass --locked in the builder, and fail the build if Cargo.lock is missing or out of date rather than letting cargo quietly update it."
          ],
          "code": "FROM chef AS builder\nCOPY --from=planner /app/recipe.json recipe.json\nRUN cargo chef cook --release --locked --recipe-path recipe.json\nCOPY . .\n# Copy the binary in the same layer that builds it, or use no cache mount.\nRUN cargo build --release --locked --bin api \\\n && install -Dm755 target/release/api /out/api\n\nFROM debian:bookworm-slim AS runtime\nCOPY --from=builder /out/api /usr/local/bin/api\nUSER 65532:65532\nENTRYPOINT [\"/usr/local/bin/api\"]",
          "tip": "install -Dm755 into a path outside target/ is the cheapest way to make a binary copyable regardless of cache mounts."
        },
        {
          "h": "Shrink and harden the artifact",
          "p": [
            "Stripping symbols is the single largest easy win: a release binary with debug info can be hundreds of megabytes. Set strip = \"symbols\" in the release profile, or run strip in the builder, and keep the unstripped binary as a separate CI artifact if you need symbolized backtraces. Debug symbols belong in a symbol server, not in the image.",
            "Then make the artifact self-describing. cargo-auditable embeds the dependency list into a linker section, so a scanner can enumerate crates from the binary alone, without Cargo.lock or network access. That closes the gap where an image is scanned months later and nobody can prove which crate versions it contains."
          ],
          "code": "# Cargo.toml - smaller binary, no debug info in the shipped artifact.\n[profile.release]\nstrip = \"symbols\"\nlto = \"thin\"\ncodegen-units = 1\npanic = \"abort\"\n\n# Builder: embed dependency metadata for offline scanning.\n#   cargo install --locked cargo-auditable\n#   cargo auditable build --release --locked --bin api\n# Then in CI, no Cargo.lock needed:\n#   syft scan registry.example.com/api@sha256:abc123 -o cyclonedx-json",
          "list": [
            "strip = \"symbols\" in release; archive the unstripped binary separately",
            "panic = \"abort\" removes unwinding tables, but forfeits catch_unwind",
            "cargo-auditable embeds the dependency list in the binary",
            "A smaller image pulls faster on every node, which is a deploy-latency win"
          ],
          "tip": "Measure the final image, not the binary: docker images --format '{{.Size}}' on the tag you actually deploy."
        }
      ],
      "exercise": {
        "prompt": "Convert a single-stage Dockerfile into planner, builder and runtime stages, add --locked to both cargo commands, and fix a build that currently copies the binary from a cache-mounted target directory.",
        "starter": "FROM rust:1.85\nWORKDIR /app\nCOPY . .\nRUN cargo build --release\nCMD [\"./target/release/api\"]\n",
        "hint": "Copy the binary to /out inside the same RUN that builds it, then COPY --from=builder /out/api. Add a runtime stage on debian:bookworm-slim with ca-certificates and a non-root USER.",
        "solution": "# syntax=docker/dockerfile:1\nFROM rust:1.85-bookworm AS chef\nRUN cargo install --locked cargo-chef\nWORKDIR /app\n\nFROM chef AS planner\nCOPY . .\nRUN cargo chef prepare --recipe-path recipe.json\n\nFROM chef AS builder\nCOPY --from=planner /app/recipe.json recipe.json\nRUN cargo chef cook --release --locked --recipe-path recipe.json\nCOPY . .\nRUN cargo build --release --locked --bin api \\\n && install -Dm755 target/release/api /out/api\n\nFROM debian:bookworm-slim AS runtime\nRUN apt-get update \\\n && apt-get install -y --no-install-recommends ca-certificates \\\n && rm -rf /var/lib/apt/lists/*\nCOPY --from=builder /out/api /usr/local/bin/api\nUSER 65532:65532\nEXPOSE 8080\nENTRYPOINT [\"/usr/local/bin/api\"]"
      },
      "questions": [
        {
          "q": "Why does COPY --from=builder /app/target/release/api fail when the builder used a cache mount on /app/target?",
          "options": [
            "COPY cannot read from a stage that used a mount",
            "The path is remapped inside BuildKit",
            "Cache mounts are read-only inside the stage",
            "Cache mounts are not part of the image layer, so the file is invisible to later stages"
          ],
          "answer": 3,
          "explain": "A cache mount is a temporary volume attached during that RUN. Its contents never enter the image, so a later stage has nothing to copy. Write the artifact outside the mount within the same RUN."
        },
        {
          "q": "What does --locked actually guarantee in a container build?",
          "options": [
            "The build fails if any dependency has an advisory",
            "The build cannot access the network",
            "Cargo will not update Cargo.lock, so the resolved dependency set matches the reviewed lockfile",
            "Dependencies are downloaded once and cached"
          ],
          "answer": 2,
          "explain": "--locked makes cargo error instead of updating the lockfile. Without it, the image can contain patch versions that never passed your audit or your review."
        },
        {
          "q": "What does cargo-auditable buy you that Cargo.lock does not?",
          "options": [
            "Reproducible builds",
            "Faster builds",
            "The dependency list is embedded in the binary, so a scanner can enumerate crates from an image alone",
            "Automatic patching of vulnerable crates"
          ],
          "answer": 2,
          "explain": "The lockfile lives in the build context and is usually absent from the runtime image. cargo-auditable writes the resolved dependency metadata into a linker section, making the shipped artifact self-describing."
        }
      ],
      "quickbytes": [
        "Only COPY what the process needs at run time.",
        "Copy the binary to /out inside the building RUN if target/ is a cache mount.",
        "strip = \"symbols\" in [profile.release]; archive unstripped binaries elsewhere.",
        "Pass --locked to cook and build, or the image can contain unreviewed patch versions."
      ],
      "production": [
        "The runtime stage contains no compiler, no package manager cache and no source.",
        "Both cargo-chef cook and cargo build run with --locked.",
        "Artifacts are copied outside any cache mount, or the target directory is a real layer.",
        "Release binaries are stripped and the unstripped copies are retained as CI artifacts.",
        "Image size is tracked per release so a regression is visible in review."
      ],
      "crates": [
        "cargo-chef",
        "cargo-auditable"
      ],
      "github": [
        {
          "name": "rust-secure-code/cargo-auditable",
          "url": "https://github.com/rust-secure-code/cargo-auditable"
        },
        {
          "name": "docker/buildx",
          "url": "https://github.com/docker/buildx"
        }
      ],
      "pitfall": "Building with a cache mount on target/ and copying the binary in a later stage: the build passes locally where the mount is warm and fails in CI, where the mount starts empty and the file was never written to a layer.",
      "resources": [
        {
          "title": "Docker Docs: multi-stage builds",
          "url": "https://docs.docker.com/build/building/multi-stage/",
          "kind": "docs"
        },
        {
          "title": "cargo-chef: dependency caching for Docker builds",
          "url": "https://github.com/LukeMathWalker/cargo-chef",
          "kind": "repo"
        },
        {
          "title": "cargo-auditable: dependency data inside the binary",
          "url": "https://github.com/rust-secure-code/cargo-auditable",
          "kind": "repo"
        },
        {
          "title": "Cargo Book: release profiles",
          "url": "https://doc.rust-lang.org/cargo/reference/profiles.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "k06",
      "n": 6,
      "title": "Distroless: no shell, no libc, no comfort",
      "minutes": 75,
      "level": "advanced",
      "goal": "Build a static musl binary, ship it in a distroless image with CA certificates and a non-root user, and keep a debugging path that does not depend on a shell in the container.",
      "sections": [
        {
          "h": "What distroless actually removes",
          "p": [
            "A distroless image keeps the runtime essentials and drops the rest: no shell, no package manager, no coreutils, no dynamic linker beyond what the variant needs. What remains is your binary, CA certificates, timezone data and a passwd entry for the nonroot user. That removes an entire class of post-exploitation convenience, because an attacker who lands in the container cannot curl a payload or spawn a shell.",
            "The variants are not interchangeable. cc-debian12 includes glibc and is the right base for a normally linked Rust binary; static-debian12 assumes a statically linked binary and provides no libc at all. Picking static with a glibc-linked binary produces an exec format error or a missing loader message, and the fix is in the build target, not in the image."
          ],
          "list": [
            "cc-debian12 for glibc-linked binaries, static-debian12 for musl static builds",
            "The :nonroot tag runs as uid 65532, so file ownership must match",
            "CA certificates are present; a custom CA bundle is not - mount or bake it",
            "No shell means no kubectl exec; plan the debugging path before the incident"
          ],
          "tip": "Tag the image with the base variant in its name (api:1.4.2-static), so an operator can tell at a glance what the container expects."
        },
        {
          "h": "Static linking, and why rustls is the enabler",
          "p": [
            "Targeting x86_64-unknown-linux-musl produces a binary with no glibc dependency, which is what a scratch or static distroless image needs. The friction is C libraries: openssl-sys needs perl, make and a C toolchain, and links a shared libssl unless you go out of your way. Swapping to rustls removes that dependency graph entirely and makes the static build routine.",
            "Two behaviours change with musl and are worth testing rather than assuming. DNS resolution goes through musl's resolver, which historically had different search-domain and NSS behaviour than glibc, so a service that relied on glibc NSS modules may fail to resolve internal names. And anything that calls dlopen - some database drivers, some crypto engines - cannot work in a truly static binary."
          ],
          "code": "# Build a static binary for the container's architecture.\nrustup target add x86_64-unknown-linux-musl\ncargo build --release --locked --target x86_64-unknown-linux-musl --bin api\n\nfile target/x86_64-unknown-linux-musl/release/api\n# ELF 64-bit LSB executable, statically linked, stripped\n\n# Cargo.toml: no openssl in the graph at all.\n# [dependencies]\n# reqwest = { version = \"0.13\", default-features = false, features = [\"rustls-tls\", \"http2\", \"json\"] }\n# sqlx = { version = \"0.9\", default-features = false, features = [\"runtime-tokio\", \"postgres\", \"rustls-ring\"] }",
          "tip": "cargo tree -i openssl-sys tells you immediately whether the static build is even possible. If it resolves, find the crate that pulled it in."
        },
        {
          "h": "Debugging without a shell",
          "p": [
            "The operational objection to distroless is real: you cannot exec in and poke around. The answer is to build the debugging path into the platform instead. Ephemeral containers attach to a running pod's namespaces without restarting it, and a debug-tagged image variant that carries busybox gives you a shell for the cases where you need one, at the cost of a larger image you never deploy to production.",
            "For most incidents the shell was never the useful part. Structured logs, a metrics endpoint and a /debug/config route that reports the loaded configuration and the git commit will answer more questions than cat /etc/resolv.conf. Invest in those, and keep the ephemeral-container recipe in the runbook so nobody improvises at 3 a.m."
          ],
          "code": "# Attach a debug container to a running pod (no restart, shares namespaces).\nkubectl debug -it pod/api-7d9c8f-2xk4l \\\n  --image=busybox:1.37 --target=api -- sh\n\n# If the process cannot start at all, override the command in a copy.\nkubectl debug pod/api-7d9c8f-2xk4l --copy-to=api-debug \\\n  --container=api --image=debian:bookworm-slim -- sleep 3600\n\n# What the app should expose instead of a shell:\n#   GET /healthz   liveness: process is up\n#   GET /readyz    readiness: dependencies reachable\n#   GET /version   version, git sha, build time\n#   GET /metrics   Prometheus exposition",
          "list": [
            "kubectl debug --target shares the pod's namespaces; --copy-to makes a modified copy",
            "Keep a debug variant of the image for the rare interactive case",
            "Expose /version and /metrics so the common questions need no shell",
            "A read-only root filesystem breaks tools that write to /tmp; mount an emptyDir"
          ],
          "tip": "If your runbook's first step is kubectl exec, it does not work on a distroless fleet. Rewrite step one as a query."
        }
      ],
      "exercise": {
        "prompt": "Write a Dockerfile that ships a musl-static Rust binary in a distroless static image as the nonroot user, and list the two commands that prove the binary is static and the image has no shell.",
        "starter": "FROM rust:1.85 AS builder\n# build for x86_64-unknown-linux-musl\n\nFROM gcr.io/distroless/static-debian12:nonroot\n# copy the binary, set the entrypoint\n",
        "hint": "Add the musl target in the builder with rustup target add, build with --target, then COPY the binary from target/x86_64-unknown-linux-musl/release/. Prove it with file and with docker run --entrypoint sh (which should fail).",
        "solution": "FROM rust:1.85-bookworm AS builder\nRUN rustup target add x86_64-unknown-linux-musl\nWORKDIR /app\nCOPY . .\nRUN cargo build --release --locked --target x86_64-unknown-linux-musl --bin api\n\nFROM gcr.io/distroless/static-debian12:nonroot\nCOPY --from=builder /app/target/x86_64-unknown-linux-musl/release/api /usr/local/bin/api\nUSER 65532:65532\nEXPOSE 8080\nENTRYPOINT [\"/usr/local/bin/api\"]\n\n# Proof:\n#   file target/x86_64-unknown-linux-musl/release/api   -> statically linked\n#   docker run --rm --entrypoint sh api:1.4.2-static     -> exec: \"sh\": not found"
      },
      "questions": [
        {
          "q": "You ship a glibc-linked binary in gcr.io/distroless/static. What happens?",
          "options": [
            "It fails at exec with a missing dynamic loader or libc",
            "It runs but DNS is broken",
            "It runs only as root",
            "It runs, because the binary carries its own loader"
          ],
          "answer": 0,
          "explain": "The static variant has no libc and no dynamic loader. A glibc-linked binary needs ld-linux and libc.so.6 at run time, so it cannot start. Use cc-debian12 or rebuild for musl."
        },
        {
          "q": "What is the most common blocker when switching a service to a musl static build?",
          "options": [
            "A C dependency such as openssl-sys that needs a toolchain and links a shared library",
            "Rust's standard library is unavailable on musl",
            "Async runtimes cannot run on musl",
            "Cargo does not support musl targets"
          ],
          "answer": 0,
          "explain": "Pure-Rust dependencies compile fine. openssl-sys and similar crates pull in perl, make and a C compiler and link libssl dynamically. Replacing them with rustls is usually the fix."
        },
        {
          "q": "What does kubectl debug --target=api actually do?",
          "options": [
            "Opens a shell inside the existing container",
            "Restarts the pod with a debug image",
            "Adds an ephemeral container that shares the target container's namespaces without restarting the pod",
            "Copies the pod to a new namespace"
          ],
          "answer": 2,
          "explain": "Ephemeral containers join the pod's process, network and filesystem namespaces, so you can inspect the running process without a shell in the app image and without a restart."
        }
      ],
      "quickbytes": [
        "static-debian12 expects a static binary; cc-debian12 expects glibc.",
        "cargo tree -i openssl-sys decides whether a static build is possible.",
        "file, not ldd, is how you confirm a binary is static.",
        "Ephemeral containers replace kubectl exec on a distroless fleet."
      ],
      "production": [
        "The runtime image has no shell or package manager, and the pipeline asserts it.",
        "Static builds are verified with file before the image is published.",
        "A debug variant exists for interactive triage and is never deployed to production.",
        "The service exposes /version and /metrics so routine questions need no shell.",
        "A custom CA bundle is mounted explicitly; nothing assumes the base image's trust store."
      ],
      "crates": [
        "rustls",
        "tokio"
      ],
      "github": [
        {
          "name": "GoogleContainerTools/distroless",
          "url": "https://github.com/GoogleContainerTools/distroless"
        },
        {
          "name": "rustls/rustls",
          "url": "https://github.com/rustls/rustls"
        }
      ],
      "pitfall": "Switching to distroless static while a transitive dependency still links openssl: the build succeeds because the builder has libssl, and the container fails at exec on the node with a missing shared object.",
      "resources": [
        {
          "title": "Distroless: language-focused base images",
          "url": "https://github.com/GoogleContainerTools/distroless",
          "kind": "repo"
        },
        {
          "title": "rustls crate documentation",
          "url": "https://docs.rs/rustls/latest/rustls/",
          "kind": "docs"
        },
        {
          "title": "Kubernetes: debug a running pod",
          "url": "https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/",
          "kind": "docs"
        },
        {
          "title": "Docker Docs: building best practices",
          "url": "https://docs.docker.com/build/building/best-practices/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "k07",
      "n": 7,
      "title": "Kubernetes: the objects a service needs",
      "minutes": 90,
      "level": "core",
      "goal": "Describe a Rust service as a Deployment and a Service with honest probes and resource requests, and explain what the controllers do between apply and a healthy rollout.",
      "sections": [
        {
          "h": "Desired state and the reconcile loop",
          "p": [
            "You do not start pods; you declare a Deployment and a controller makes pods exist. The Deployment owns a ReplicaSet per revision, the ReplicaSet owns pods, and each controller compares desired to observed on a loop. That ownership chain is why deleting a pod is not an incident: the ReplicaSet notices the count is short and creates another.",
            "This inverts the operational model. kubectl apply sends intent, and the response is accepted, not done. Anything that reads back immediately and calls it success is lying to you, which is why rollout gates must watch status conditions rather than the exit code of apply. It also means manual kubectl edits are temporary: the next reconcile may undo them, and in a GitOps cluster it certainly will."
          ],
          "list": [
            "Deployment owns ReplicaSets; ReplicaSets own Pods; the chain is the rollback unit",
            "kubectl apply returns accepted, not ready - watch the rollout",
            "Manual edits are drift and will be reverted by the controller or by GitOps",
            "A Service selects pods by label; a label mismatch is the classic empty-endpoints bug"
          ],
          "tip": "kubectl get endpointslices -n prod is the fastest way to confirm a Service actually selects your pods."
        },
        {
          "h": "Probes: readiness routes traffic, liveness restarts",
          "p": [
            "Readiness answers one question: should this pod receive traffic right now. When it fails, the pod is removed from the Service endpoints but keeps running, which is exactly what you want during a dependency outage. Liveness answers a different question: is this process wedged beyond recovery. Pointing liveness at a database check is a classic outage amplifier, because a brief database blip restarts every replica at once.",
            "The startupProbe exists for slow boots. Without it, a service that takes forty seconds to load a cache fails liveness at ten seconds and enters a restart loop that never lets it finish booting. With a startupProbe, liveness is suppressed until startup succeeds, so failureThreshold times periodSeconds can be generous without slowing the steady state."
          ],
          "code": "containers:\n  - name: api\n    image: registry.example.com/api@sha256:abc123\n    ports:\n      - name: http\n        containerPort: 8080\n    startupProbe:\n      httpGet: { path: /healthz, port: http }\n      periodSeconds: 2\n      failureThreshold: 30      # up to 60s to boot, then liveness takes over\n    readinessProbe:\n      httpGet: { path: /readyz, port: http }\n      periodSeconds: 5\n      failureThreshold: 2\n    livenessProbe:\n      httpGet: { path: /healthz, port: http }\n      periodSeconds: 10\n      failureThreshold: 3\n    resources:\n      requests: { cpu: 100m, memory: 128Mi }\n      limits:   { memory: 256Mi }   # no CPU limit: avoid throttling at burst",
          "tip": "Never put a downstream dependency in the liveness probe. Readiness may fail because of the database; liveness must not."
        },
        {
          "h": "Requests, limits and how pods actually die",
          "p": [
            "Requests are what the scheduler reserves and what determines the QoS class; limits are what the kernel enforces. A memory limit is a hard wall: exceed it and the kernel OOM-kills the container, which looks like a restart with exit code 137 and no application log. A CPU limit is a quota that throttles in 100 ms periods, which turns a latency-sensitive Rust service into a slow one while CPU utilisation looks low.",
            "Rust makes memory predictable but not flat: a connection pool, an in-memory cache and per-request buffers all scale with concurrency. Measure the resident set at peak load and set the limit above it with headroom, not at the average. Setting requests equal to limits gives Guaranteed QoS, which is the right default for a latency-critical service and the wrong default for a batch worker that should use spare capacity."
          ],
          "code": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  replicas: 3\n  revisionHistoryLimit: 3\n  strategy:\n    type: RollingUpdate\n    rollingUpdate: { maxUnavailable: 0, maxSurge: 1 }\n  selector:\n    matchLabels: { app: api }\n  template:\n    metadata:\n      labels: { app: api }\n    spec:\n      securityContext:\n        runAsNonRoot: true\n        seccompProfile: { type: RuntimeDefault }\n      containers:\n        - name: api\n          image: registry.example.com/api@sha256:abc123\n          securityContext:\n            allowPrivilegeEscalation: false\n            readOnlyRootFilesystem: true\n            capabilities: { drop: [\"ALL\"] }\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: api\nspec:\n  selector: { app: api }\n  ports:\n    - { name: http, port: 80, targetPort: http }",
          "list": [
            "maxUnavailable: 0 with maxSurge: 1 keeps capacity during a rollout",
            "Exit code 137 means SIGKILL: usually the memory limit, sometimes a liveness kill",
            "requests == limits gives Guaranteed QoS; CPU limits cause throttling",
            "readOnlyRootFilesystem needs an emptyDir for anything that writes to /tmp"
          ],
          "tip": "kubectl get pod -o jsonpath='{.status.containerStatuses[*].lastState}' tells you whether the last death was an OOM kill or a liveness restart."
        }
      ],
      "exercise": {
        "prompt": "Write a Deployment and Service for a Rust API that must not drop requests during a rollout, has a slow 40-second boot, and must not be restarted when its database is briefly unavailable.",
        "starter": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  # replicas, strategy, selector, template with probes and resources\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: api\nspec:\n  # selector and port mapping\n",
        "hint": "Use maxUnavailable: 0 and maxSurge: 1. Add a startupProbe with a generous failureThreshold, a readinessProbe that can include a dependency check, and a livenessProbe that only checks the process. Point the Service at the named port.",
        "solution": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  replicas: 3\n  revisionHistoryLimit: 3\n  strategy:\n    type: RollingUpdate\n    rollingUpdate: { maxUnavailable: 0, maxSurge: 1 }\n  selector:\n    matchLabels: { app: api }\n  template:\n    metadata:\n      labels: { app: api }\n    spec:\n      terminationGracePeriodSeconds: 30\n      containers:\n        - name: api\n          image: registry.example.com/api@sha256:abc123\n          ports: [{ name: http, containerPort: 8080 }]\n          startupProbe:\n            httpGet: { path: /healthz, port: http }\n            periodSeconds: 2\n            failureThreshold: 30\n          readinessProbe:\n            httpGet: { path: /readyz, port: http }\n            periodSeconds: 5\n            failureThreshold: 2\n          livenessProbe:\n            httpGet: { path: /healthz, port: http }\n            periodSeconds: 10\n            failureThreshold: 3\n          resources:\n            requests: { cpu: 100m, memory: 128Mi }\n            limits: { memory: 256Mi }\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: api\nspec:\n  selector: { app: api }\n  ports:\n    - { name: http, port: 80, targetPort: http }"
      },
      "questions": [
        {
          "q": "What happens when a readiness probe fails but the liveness probe passes?",
          "options": [
            "The pod is evicted from the node",
            "The Deployment rolls back to the previous revision",
            "The container is restarted",
            "The pod is removed from Service endpoints but keeps running"
          ],
          "answer": 3,
          "explain": "Readiness only controls endpoint membership. The pod stays up, which is what lets it recover when a dependency comes back without a restart storm across all replicas."
        },
        {
          "q": "Why is putting a database ping in the liveness probe dangerous?",
          "options": [
            "It prevents the pod from being scheduled",
            "It adds latency to every request",
            "A brief database outage fails liveness on every replica and restarts them all",
            "Kubernetes does not allow network calls in liveness probes"
          ],
          "answer": 2,
          "explain": "Liveness failure means restart. During a shared dependency outage every replica fails at once, so the service restarts itself repeatedly instead of simply not receiving traffic."
        },
        {
          "q": "A pod restarts with exit code 137 and no application error log. What is the likely cause?",
          "options": [
            "The image entrypoint is wrong",
            "A panic in the main thread",
            "SIGKILL from the kernel, typically an exceeded memory limit",
            "A failed readiness probe"
          ],
          "answer": 2,
          "explain": "137 is 128 plus 9, SIGKILL. The OOM killer or kubelet sends it, so the process gets no chance to log. Check lastState and the container's memory usage against its limit."
        }
      ],
      "quickbytes": [
        "kubectl apply means accepted, not ready; watch the rollout status.",
        "Readiness can depend on downstream services; liveness must not.",
        "A startupProbe is the fix for a slow boot loop.",
        "No CPU limit, always a memory limit: throttling hurts more than it protects."
      ],
      "production": [
        "Every Deployment sets maxUnavailable: 0 for zero-downtime rollouts.",
        "Liveness probes check only the process; readiness may check dependencies.",
        "Memory limits are set from measured peak RSS with headroom, and OOM kills alert.",
        "Containers run as non-root with a read-only root filesystem and no capabilities.",
        "terminationGracePeriodSeconds exceeds the app's graceful-shutdown time."
      ],
      "crates": [
        "kube",
        "k8s-openapi"
      ],
      "github": [
        {
          "name": "kube-rs/kube",
          "url": "https://github.com/kube-rs/kube"
        },
        {
          "name": "kubernetes/kubernetes",
          "url": "https://github.com/kubernetes/kubernetes"
        }
      ],
      "pitfall": "Setting a CPU limit on a latency-sensitive service: the container gets throttled at the quota every period, p99 latency climbs, and dashboards show low CPU utilisation so nobody suspects the limit.",
      "resources": [
        {
          "title": "Kubernetes: Deployments",
          "url": "https://kubernetes.io/docs/concepts/workloads/controllers/deployment/",
          "kind": "docs"
        },
        {
          "title": "Kubernetes: liveness, readiness and startup probes",
          "url": "https://kubernetes.io/docs/concepts/workloads/pods/probes/",
          "kind": "docs"
        },
        {
          "title": "Kubernetes: resource requests and limits",
          "url": "https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/",
          "kind": "docs"
        },
        {
          "title": "kube-rs: Kubernetes client and controller runtime for Rust",
          "url": "https://github.com/kube-rs/kube",
          "kind": "repo"
        },
        {
          "title": "CNCF channel: Kubernetes deep dives",
          "url": "https://www.youtube.com/@CNCF",
          "kind": "video"
        }
      ]
    },
    {
      "id": "k08",
      "n": 8,
      "title": "Helm: values contracts and atomic upgrades",
      "minutes": 75,
      "level": "advanced",
      "goal": "Structure a chart so its values are a validated contract, run migrations as hooks, and make an upgrade that fails mid-flight roll itself back.",
      "sections": [
        {
          "h": "A chart is a template plus a contract",
          "p": [
            "Helm renders templates with values and hands the result to the API server. The templates are the easy part; the contract is values.yaml, and an unvalidated contract is where charts rot. Ship values.schema.json alongside it so helm install rejects a string where an integer belongs, instead of rendering a manifest that the API server rejects three layers deeper.",
            "Keep one chart per deployable and push shared concerns into library charts or a small set of named templates. The failure mode to avoid is the mega-chart with a boolean per service, where a change for one team re-renders everything and the blast radius of a typo is the whole platform. The second failure mode is duplicating the same Deployment YAML across twenty charts, which is a configuration management problem wearing a template."
          ],
          "code": "# charts/api/Chart.yaml\napiVersion: v2\nname: api\ndescription: Rust API service\ntype: application\nversion: 0.1.0\nappVersion: \"1.4.2\"\n\n# charts/api/values.yaml\nreplicaCount: 3\nimage:\n  repository: registry.example.com/api\n  digest: sha256:abc123          # digest, not tag\nresources:\n  requests: { cpu: 100m, memory: 128Mi }\n  limits: { memory: 256Mi }\ncanary:\n  enabled: false\n  weight: 10",
          "tip": "Put the digest in values and let CI write it; never template a mutable tag in production values."
        },
        {
          "h": "Templates, helpers and the digest",
          "p": [
            "The deployment template should reference the image by digest, set the probes from values, and carry a checksum annotation of the ConfigMap so a config change actually triggers a rollout. That annotation is a small piece of glue people forget: without it, helm upgrade changes the ConfigMap and the pods keep running with the old environment until something else restarts them.",
            "Helpers in _helpers.tpl exist to keep names and labels consistent across resources, because a Service whose selector does not match the Deployment's labels is the most common chart bug. Define app.kubernetes.io/name and instance once, and use the same include in the selector, the pod template labels and the Service selector."
          ],
          "code": "# charts/api/templates/deployment.yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ include \"api.fullname\" . }}\n  labels:\n    {{- include \"api.labels\" . | nindent 4 }}\nspec:\n  replicas: {{ .Values.replicaCount }}\n  selector:\n    matchLabels:\n      {{- include \"api.selectorLabels\" . | nindent 6 }}\n  template:\n    metadata:\n      labels:\n        {{- include \"api.selectorLabels\" . | nindent 8 }}\n      annotations:\n        checksum/config: {{ include (print $.Template.BasePath \"/configmap.yaml\") . | sha256sum }}\n    spec:\n      containers:\n        - name: api\n          image: \"{{ .Values.image.repository }}@{{ .Values.image.digest }}\"\n          ports: [{ name: http, containerPort: 8080 }]\n          readinessProbe:\n            httpGet: { path: /readyz, port: http }",
          "tip": "The checksum/config annotation is the difference between a config change and a config change that takes effect."
        },
        {
          "h": "Hooks, --atomic and rollback that actually runs",
          "p": [
            "A schema migration must run before the new pods start, exactly once, and must not block a rollback. Helm hooks express that ordering: a Job annotated with pre-upgrade runs before the upgrade, and hook-delete-policy controls whether its pods survive for logs. The Job must be idempotent, because a failed upgrade retries it, and it must be safe to run against the previous schema, because rollback does not undo it.",
            "--atomic changes the failure semantics: if the upgrade fails or the timeout expires, Helm rolls back to the previous release automatically. Without it, a failed upgrade leaves the release in a pending state that the next upgrade refuses to touch, and someone runs helm rollback under pressure. Pair it with --wait so readiness is actually observed, and with a --timeout long enough for a cold image pull."
          ],
          "code": "# CI: render and lint before the cluster sees anything.\nhelm lint charts/api --strict\nhelm template api charts/api -f values/prod.yaml | kubeconform -strict -summary\nhelm diff upgrade api charts/api -f values/prod.yaml   # plugin: what would change\n\n# Deploy: wait for readiness, roll back automatically on failure.\nhelm upgrade --install api charts/api \\\n  --namespace prod --create-namespace \\\n  -f values/prod.yaml \\\n  --atomic --wait --timeout 10m\n\n# Hook Job for migrations\n# metadata:\n#   annotations:\n#     helm.sh/hook: pre-upgrade,pre-install\n#     helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded\n#     helm.sh/hook-weight: \"-5\"",
          "list": [
            "--atomic implies --wait; without it a failed upgrade leaves a pending release",
            "Migration Jobs must be idempotent and safe against the previous schema",
            "helm template plus kubeconform catches invalid manifests without a cluster",
            "helm rollback does not reverse a database migration"
          ],
          "tip": "Give the upgrade timeout more room than a cold image pull; a premature timeout with --atomic causes a rollback you did not need."
        }
      ],
      "exercise": {
        "prompt": "Add a values.schema.json contract and a pre-upgrade migration hook to a chart whose image is currently templated as a mutable tag, then write the CI commands that render, validate and atomically deploy it.",
        "starter": "# values.yaml\nimage:\n  repository: registry.example.com/api\n  tag: latest\n\n# templates/deployment.yaml\n# image: \"{{ .Values.image.repository }}:{{ .Values.image.tag }}\"\n",
        "hint": "Replace tag with digest and make it required in the schema. Add a Job with helm.sh/hook: pre-upgrade,pre-install and hook-delete-policy. In CI, run helm lint, helm template | kubeconform, then helm upgrade --install --atomic --wait.",
        "solution": "# values.schema.json (excerpt)\n{\n  \"$schema\": \"https://json-schema.org/draft/2020-12/schema\",\n  \"type\": \"object\",\n  \"required\": [\"image\", \"replicaCount\"],\n  \"properties\": {\n    \"replicaCount\": { \"type\": \"integer\", \"minimum\": 1 },\n    \"image\": {\n      \"type\": \"object\",\n      \"required\": [\"repository\", \"digest\"],\n      \"properties\": {\n        \"repository\": { \"type\": \"string\" },\n        \"digest\": { \"type\": \"string\", \"pattern\": \"^sha256:[a-f0-9]{64}$\" }\n      },\n      \"additionalProperties\": false\n    }\n  }\n}\n\n# templates/migrate-job.yaml\napiVersion: batch/v1\nkind: Job\nmetadata:\n  name: {{ include \"api.fullname\" . }}-migrate\n  annotations:\n    helm.sh/hook: pre-upgrade,pre-install\n    helm.sh/hook-weight: \"-5\"\n    helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded\nspec:\n  backoffLimit: 0\n  template:\n    spec:\n      restartPolicy: Never\n      containers:\n        - name: migrate\n          image: \"{{ .Values.image.repository }}@{{ .Values.image.digest }}\"\n          args: [\"migrate\", \"--to\", \"latest\"]\n\n# CI\n#   helm lint charts/api --strict\n#   helm template api charts/api -f values/prod.yaml | kubeconform -strict -summary\n#   helm upgrade --install api charts/api -f values/prod.yaml --atomic --wait --timeout 10m"
      },
      "questions": [
        {
          "q": "What does --atomic add to helm upgrade?",
          "options": [
            "It renders templates without a cluster",
            "It rolls back to the previous release if the upgrade fails or times out",
            "It deletes the release on failure",
            "It runs hooks in parallel"
          ],
          "answer": 1,
          "explain": "--atomic makes the upgrade transactional: on failure or timeout, Helm rolls back to the last successful release. It implies --wait, so readiness is actually observed before success is declared."
        },
        {
          "q": "Why annotate the pod template with a checksum of the ConfigMap?",
          "options": [
            "Because Kubernetes requires it for ConfigMap mounts",
            "To speed up the scheduler",
            "To detect tampering with the ConfigMap",
            "So a ConfigMap change alters the pod template and triggers a rollout"
          ],
          "answer": 3,
          "explain": "A mounted ConfigMap updates eventually, but environment variables do not change in a running pod. The checksum changes the pod template hash, so the Deployment rolls new pods that read the new config."
        },
        {
          "q": "Why must a pre-upgrade migration Job be safe to run twice?",
          "options": [
            "A failed or retried upgrade re-runs the hook, and hook-delete-policy may not have cleaned up",
            "Kubernetes Jobs cannot be idempotent",
            "Rollback re-runs all hooks in reverse",
            "Helm always runs hooks twice"
          ],
          "answer": 0,
          "explain": "Hooks are retried on a failed upgrade and the Job may already have completed. Migrations must be written as idempotent steps (create if not exists, add column if missing), not as a one-shot script."
        }
      ],
      "quickbytes": [
        "helm template | kubeconform catches schema errors without a cluster.",
        "helm upgrade --install --atomic --wait is the safe default in CI.",
        "A digest in values, not a tag, is what makes rollback exact.",
        "helm rollback does not reverse migrations; design them to be backward compatible."
      ],
      "production": [
        "Every chart ships values.schema.json and CI runs helm lint --strict.",
        "Production values pin the image by digest, written by the pipeline, never by hand.",
        "Upgrades use --atomic --wait with a timeout longer than a cold image pull.",
        "Migrations run as pre-upgrade hooks and are idempotent and backward compatible.",
        "helm diff runs in CI so reviewers see the rendered change, not the values diff."
      ],
      "crates": [
        "kube",
        "k8s-openapi"
      ],
      "github": [
        {
          "name": "helm/helm",
          "url": "https://github.com/helm/helm"
        },
        {
          "name": "databus23/helm-diff",
          "url": "https://github.com/databus23/helm-diff"
        }
      ],
      "pitfall": "Templating a mutable tag and relying on helm upgrade to roll pods: the Deployment spec does not change, so no rollout happens and the cluster keeps running the old image until someone deletes the pods.",
      "resources": [
        {
          "title": "Helm: the package manager for Kubernetes",
          "url": "https://github.com/helm/helm",
          "kind": "repo"
        },
        {
          "title": "helm-diff: preview rendered changes",
          "url": "https://github.com/databus23/helm-diff",
          "kind": "repo"
        },
        {
          "title": "Kubernetes: configuration best practices",
          "url": "https://kubernetes.io/blog/2025/11/25/configuration-good-practices/",
          "kind": "docs"
        },
        {
          "title": "kubeconform: manifest schema validation",
          "url": "https://github.com/yannh/kubeconform",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "k09",
      "n": 9,
      "title": "GitOps with Argo CD: the cluster pulls",
      "minutes": 90,
      "level": "advanced",
      "goal": "Move deployment authority from CI to a controller that reconciles a git repository, and configure sync policy, sync waves and drift handling so a manual kubectl edit cannot survive.",
      "sections": [
        {
          "h": "CI builds, the cluster pulls",
          "p": [
            "The defining property of GitOps is direction: CI produces an artifact and a commit to a manifests repository, and a controller inside the cluster pulls that repository and applies it. CI never holds cluster credentials. That single inversion removes the long-lived kubeconfig from the build system, which is the most valuable credential in the organization, and turns every deploy into a reviewable diff.",
            "It also gives you a free audit trail. The cluster's state is whatever the repository says at a specific commit, so the question what changed in prod last Tuesday has an answer that does not depend on someone's memory of a kubectl command. The cost is latency and indirection: a deploy now waits for a poll or a webhook, and debugging starts with the controller's view of the repository rather than the terminal."
          ],
          "list": [
            "CI holds registry credentials; the cluster holds repository read access and nothing else",
            "The manifests repo is the deployment audit log - protect it like production",
            "Image promotion is a commit that changes a digest, not a kubectl set image",
            "Secrets never enter the manifests repo; use External Secrets or Sealed Secrets"
          ],
          "tip": "Separate the application repo from the manifests repo. A revert of application code should not require reverting a deployment commit, and vice versa."
        },
        {
          "h": "Application, AppProject and sync policy",
          "p": [
            "An Application names a source (repository, path, revision) and a destination (cluster, namespace). An AppProject scopes what an Application may touch: which repositories, which clusters, which resource kinds. Without projects, one Application with cluster-admin can deploy anything anywhere, which is the same blast radius as the CI kubeconfig you just removed.",
            "syncPolicy.automated with prune and selfHeal is what makes the controller authoritative. Prune deletes resources removed from git; selfHeal reverts manual edits within the sync interval. Both are necessary for the model to hold, and both are dangerous if your repository is incomplete, because a missing manifest becomes a deletion. Turn on prune only after the repository covers every object the app owns."
          ],
          "code": "apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: api-prod\n  namespace: argocd\nspec:\n  project: platform\n  source:\n    repoURL: https://github.com/acme/deploy.git\n    targetRevision: main\n    path: apps/api/overlays/prod\n  destination:\n    server: https://kubernetes.default.svc\n    namespace: prod\n  syncPolicy:\n    automated:\n      prune: true\n      selfHeal: true\n    syncOptions:\n      - CreateNamespace=true\n      - ApplyOutOfSyncOnly=true\n    retry:\n      limit: 3\n      backoff: { duration: 10s, factor: 2, maxDuration: 3m }\n---\napiVersion: argoproj.io/v1alpha1\nkind: AppProject\nmetadata:\n  name: platform\n  namespace: argocd\nspec:\n  sourceRepos: [\"https://github.com/acme/deploy.git\"]\n  destinations:\n    - { server: https://kubernetes.default.svc, namespace: \"prod-*\" }\n  clusterResourceWhitelist:\n    - { group: \"\", kind: Namespace }",
          "tip": "ApplyOutOfSyncOnly cuts API traffic on large apps; without it every sync rewrites every object."
        },
        {
          "h": "Drift, waves and the Rust view of sync status",
          "p": [
            "Sync waves order resources inside one Application: lower wave numbers apply first, and Argo waits for health before moving on. That is how a migration Job, a ConfigMap and a Deployment get a deterministic order without a second tool. Health checks are per-kind, so a Job must actually complete, not merely exist, for the next wave to start.",
            "Drift is any difference between live state and the rendered manifests. selfHeal closes it on a timer, but you also want to see it: a service that is OutOfSync for an hour is either a stuck sync or a controller that cannot apply something, and both need a human. A small Rust binary using kube can poll Applications and page on anything not Synced and Healthy, which is a better signal than watching pod restarts."
          ],
          "code": "use kube::api::{Api, DynamicObject, ListParams};\nuse kube::core::{ApiResource, GroupVersionKind};\nuse kube::Client;\n\n/// Names of Argo CD Applications that are not Synced and Healthy.\npub async fn unhealthy_apps(client: Client) -> kube::Result<Vec<String>> {\n    let gvk = GroupVersionKind::gvk(\"argoproj.io\", \"v1alpha1\", \"Application\");\n    let resource = ApiResource::from_gvk(&gvk);\n    let apps: Api<DynamicObject> = Api::all_with(client, &resource);\n\n    let list = apps.list(&ListParams::default()).await?;\n    Ok(list\n        .items\n        .into_iter()\n        .filter(|app| {\n            let status = &app.data[\"status\"];\n            status[\"sync\"][\"status\"].as_str() != Some(\"Synced\")\n                || status[\"health\"][\"status\"].as_str() != Some(\"Healthy\")\n        })\n        .filter_map(|app| app.metadata.name)\n        .collect())\n}",
          "list": [
            "Sync waves apply in ascending order and wait for health between waves",
            "selfHeal reverts manual edits; it is not a substitute for review",
            "A stuck OutOfSync usually means an immutable field changed - Replace=true is the escape hatch",
            "Alert on Applications that are not Synced and Healthy, not only on pod restarts"
          ],
          "tip": "ignoreDifferences on a field you do not own (a controller-managed annotation) is better than disabling selfHeal entirely."
        }
      ],
      "exercise": {
        "prompt": "Write an Application that deploys apps/api/overlays/prod from git with prune and selfHeal, scoped by an AppProject to one namespace pattern, and add a small Rust check that lists Applications that are not Synced and Healthy.",
        "starter": "apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: api-prod\nspec:\n  # source, destination, syncPolicy\n---\napiVersion: argoproj.io/v1alpha1\nkind: AppProject\nmetadata:\n  name: platform\nspec:\n  # sourceRepos, destinations\n",
        "hint": "Point source at the deploy repo and path apps/api/overlays/prod, destination at the in-cluster server and namespace prod. In the project, restrict sourceRepos and use a namespace wildcard. The Rust side lists DynamicObject for the Application GVK and filters on status.sync.status and status.health.status.",
        "solution": "apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: api-prod\n  namespace: argocd\nspec:\n  project: platform\n  source:\n    repoURL: https://github.com/acme/deploy.git\n    targetRevision: main\n    path: apps/api/overlays/prod\n  destination:\n    server: https://kubernetes.default.svc\n    namespace: prod\n  syncPolicy:\n    automated:\n      prune: true\n      selfHeal: true\n    syncOptions:\n      - CreateNamespace=true\n      - ApplyOutOfSyncOnly=true\n---\napiVersion: argoproj.io/v1alpha1\nkind: AppProject\nmetadata:\n  name: platform\n  namespace: argocd\nspec:\n  sourceRepos: [\"https://github.com/acme/deploy.git\"]\n  destinations:\n    - { server: https://kubernetes.default.svc, namespace: \"prod-*\" }\n\n// Rust health check (kube 5, k8s-openapi 0.29)\n// let gvk = GroupVersionKind::gvk(\"argoproj.io\", \"v1alpha1\", \"Application\");\n// let apps: Api<DynamicObject> = Api::all_with(client, &ApiResource::from_gvk(&gvk));\n// filter on status.sync.status != \"Synced\" || status.health.status != \"Healthy\""
      },
      "questions": [
        {
          "q": "What is the security argument for GitOps over CI-applies-to-cluster?",
          "options": [
            "Argo CD signs every manifest",
            "Git is encrypted at rest",
            "CI no longer needs a cluster credential, so the build system cannot mutate production",
            "Kubernetes rejects kubectl apply from outside the cluster"
          ],
          "answer": 2,
          "explain": "The build system becomes artifact-only. The cluster pulls from a repository it can read, so a compromised CI job can publish a bad image but cannot deploy it without a reviewed commit."
        },
        {
          "q": "What does selfHeal do?",
          "options": [
            "Rolls back to the previous image on error",
            "Re-runs hooks on every sync",
            "Restarts unhealthy pods",
            "Reverts live changes that differ from the rendered manifests in git"
          ],
          "answer": 3,
          "explain": "selfHeal makes the controller authoritative: drift between live state and the repository is corrected on the next reconcile. It does not do rollbacks; a rollback is a revert commit."
        },
        {
          "q": "Why can enabling prune be dangerous on a partially migrated app?",
          "options": [
            "Prune disables selfHeal",
            "Prune requires cluster-admin",
            "Prune deletes the namespace",
            "Objects not present in the rendered manifests are treated as removed and deleted"
          ],
          "answer": 3,
          "explain": "Prune deletes resources that the Application no longer renders. If the repository does not yet contain every object the app owns, the first sync after enabling prune removes them."
        }
      ],
      "quickbytes": [
        "CI builds; the cluster pulls. No kubeconfig in CI.",
        "prune and selfHeal together make git authoritative; enable prune last.",
        "Sync waves order resources; health gates the next wave.",
        "Promotion is a commit that changes an image digest."
      ],
      "production": [
        "The manifests repository is separate from the application repository and requires review.",
        "AppProjects restrict source repositories, clusters and namespaces per team.",
        "prune is enabled only after the repository covers every object the app owns.",
        "Alerts fire on Applications that are not Synced and Healthy, not just on pod restarts.",
        "No secret material is committed; External Secrets or Sealed Secrets supply it."
      ],
      "crates": [
        "kube",
        "k8s-openapi",
        "tokio"
      ],
      "github": [
        {
          "name": "kube-rs/kube",
          "url": "https://github.com/kube-rs/kube"
        },
        {
          "name": "argoproj/argo-cd",
          "url": "https://github.com/argoproj/argo-cd"
        }
      ],
      "pitfall": "Enabling prune on day one with a repository that only contains the Deployment: the first sync deletes the Service, ConfigMap and HPA because they are not in git, and the outage looks like Argo CD deleted production.",
      "resources": [
        {
          "title": "Argo CD: declarative GitOps for Kubernetes",
          "url": "https://github.com/argoproj/argo-cd",
          "kind": "repo"
        },
        {
          "title": "Argo CD documentation (in-tree)",
          "url": "https://github.com/argoproj/argo-cd/tree/master/docs",
          "kind": "docs"
        },
        {
          "title": "Kubernetes: managing resources with kubectl",
          "url": "https://kubernetes.io/docs/concepts/workloads/management/",
          "kind": "docs"
        },
        {
          "title": "Argo Project channel: GitOps and progressive delivery",
          "url": "https://www.youtube.com/@ArgoProject",
          "kind": "video"
        }
      ]
    },
    {
      "id": "k10",
      "n": 10,
      "title": "Infrastructure as code with a plan gate",
      "minutes": 90,
      "level": "advanced",
      "goal": "Manage cluster and cloud resources declaratively, review the plan rather than the source, and fail the pipeline on a plan that destroys stateful infrastructure.",
      "sections": [
        {
          "h": "State is the hard part, not the syntax",
          "p": [
            "Terraform's value is the plan, and the plan is only meaningful because of state: the mapping from declared resources to real identifiers. State belongs in a remote backend with locking, not on a laptop, or two engineers apply overlapping changes and the provider ends up with resources nobody can name. Treat the state bucket as production data with versioning and access control.",
            "The second hard part is drift. Someone edits a security group in the console, the plan now wants to revert it, and the next apply silently undoes an emergency fix. Drift is not a tooling failure; it is a signal that either the change belongs in code or the resource does not belong in this stack. A scheduled plan that reports drift is how you find out before an apply surprises you."
          ],
          "list": [
            "Remote state with locking and versioning; never commit state or plan files",
            "One stack per blast radius, not one stack for the whole company",
            "A scheduled plan reports drift without applying anything",
            "Import existing resources instead of recreating them by hand"
          ],
          "tip": "If a resource's deletion would page someone, it deserves an explicit lifecycle prevent_destroy and a plan gate."
        },
        {
          "h": "The plan is the review artifact",
          "p": [
            "Reviewing HCL diffs is guesswork; reviewing a plan is not. terraform plan -out writes a plan file, and terraform show -json turns it into a structure you can query. -detailed-exitcode makes the command useful in CI: 0 means no changes, 2 means changes are pending, 1 means an error, so a pipeline can distinguish a no-op from a real change without parsing text.",
            "The gate that pays for itself is a rule about destructive actions. Parse planned_values and resource_changes, and fail when an action is delete or replace on a resource whose type is stateful - a database, a bucket, a volume, a DNS zone. Replace is the dangerous one, because it looks like an update in the summary and is actually a destroy followed by a create."
          ],
          "code": "// xtask/src/bin/plan-gate.rs - fail CI on destructive plans.\nuse std::process::Command;\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    let out = Command::new(\"terraform\")\n        .args([\"show\", \"-json\", \"tfplan\"])\n        .output()?;\n    if !out.status.success() {\n        return Err(\"terraform show failed\".into());\n    }\n    let plan: serde_json::Value = serde_json::from_slice(&out.stdout)?;\n    let changes = plan[\"resource_changes\"]\n        .as_array()\n        .ok_or(\"no resource_changes in plan\")?;\n\n    let mut blocked = Vec::new();\n    for change in changes {\n        let actions = change[\"change\"][\"actions\"].as_array().cloned().unwrap_or_default();\n        let destructive = actions.iter().any(|a| a == \"delete\");\n        let kind = change[\"type\"].as_str().unwrap_or(\"\");\n        let stateful = kind.contains(\"db_\")\n            || kind.contains(\"s3_bucket\")\n            || kind.contains(\"ebs_volume\")\n            || kind.contains(\"dns_\");\n        if destructive && stateful {\n            blocked.push(format!(\"{}.{}\", kind, change[\"name\"].as_str().unwrap_or(\"?\")));\n        }\n    }\n    if !blocked.is_empty() {\n        eprintln!(\"destructive plan blocked: {blocked:?}\");\n        std::process::exit(1);\n    }\n    Ok(())\n}",
          "tip": "actions is an array: [\"delete\",\"create\"] means replace. Checking only for the string replace misses the most dangerous case."
        },
        {
          "h": "Two IaC tools, one owner per object",
          "p": [
            "Terraform and Kustomize solve different layers. Terraform provisions the cluster, the registry, the IAM roles and the DNS; Kustomize or Helm describe the workloads that live inside the cluster. The rule that keeps this sane is single ownership: an object is managed by exactly one tool, or the two will fight and each apply will undo the other's change.",
            "Kustomize is the lighter of the two for workloads because it is a pure overlay system with no templating language: bases hold the real manifests, overlays patch image digests, replica counts and namespace per environment. That makes the diff readable and the promotion step a two-line patch. Validate the rendered output with kubeconform in CI, since Kustomize will happily produce a manifest the API server rejects."
          ],
          "code": "# deploy/apps/api/overlays/prod/kustomization.yaml\napiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nnamespace: prod\nresources:\n  - ../../base\nimages:\n  - name: registry.example.com/api\n    newName: registry.example.com/api\n    newTag: \"\"                       # digest replaces the tag\n    digest: sha256:abc123\nreplicas:\n  - name: api\n    count: 6\npatches:\n  - target: { kind: Deployment, name: api }\n    patch: |-\n      - op: replace\n        path: /spec/template/spec/containers/0/resources/limits/memory\n        value: 512Mi\n\n# CI\n#   kustomize build overlays/prod | kubeconform -strict -summary\n#   terraform plan -out=tfplan -detailed-exitcode && ./plan-gate tfplan",
          "list": [
            "Terraform owns cloud resources; Kustomize or Helm owns workloads",
            "One owner per object, or two tools will revert each other",
            "Promote by patching the image digest in the overlay, not by rebuilding",
            "Validate rendered manifests with kubeconform before the cluster sees them"
          ],
          "tip": "If both Terraform and Argo CD manage the same Deployment, the first Argo sync and the next terraform apply will fight until someone gives up and edits prod by hand."
        }
      ],
      "exercise": {
        "prompt": "Write a CI step that plans Terraform, fails when the plan would delete or replace a stateful resource, and a Kustomize overlay that promotes a new image digest for prod.",
        "starter": "# CI step sketch\nterraform init -input=false\nterraform plan -out=tfplan -detailed-exitcode\n# fail on destructive changes to stateful resources\n\n# overlays/prod/kustomization.yaml\nresources:\n  - ../../base\n",
        "hint": "terraform show -json tfplan gives resource_changes[].change.actions. Treat an actions array containing delete as destructive, including [\"delete\",\"create\"] which is a replace. In the overlay, set images[].digest and the replica count for prod.",
        "solution": "# CI\nset -euo pipefail\nterraform init -input=false\nterraform plan -out=tfplan -detailed-exitcode || code=$?\ncase \"${code:-0}\" in\n  0) echo \"no changes\"; exit 0 ;;\n  2) echo \"changes pending\"; ./plan-gate tfplan ;;\n  *) echo \"plan failed\"; exit 1 ;;\nesac\n\n# overlays/prod/kustomization.yaml\napiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nnamespace: prod\nresources:\n  - ../../base\nimages:\n  - name: registry.example.com/api\n    newName: registry.example.com/api\n    digest: sha256:abc123\nreplicas:\n  - name: api\n    count: 6\n\n# plan-gate rule: actions containing \"delete\" on db_/s3_bucket/ebs_volume/dns_\n# resources exits 1. [\"delete\",\"create\"] is a replace and counts as destructive."
      },
      "questions": [
        {
          "q": "What does terraform plan -detailed-exitcode return when changes are pending?",
          "options": [
            "0",
            "1",
            "2",
            "It prints the count and returns 0"
          ],
          "answer": 2,
          "explain": "0 means no changes, 2 means changes are pending, 1 means an error. That lets CI branch on a no-op versus a real change without parsing human-readable output."
        },
        {
          "q": "Why is a replace more dangerous than an update in a Terraform plan?",
          "options": [
            "It requires a provider upgrade",
            "It is implemented as a destroy followed by a create, so data can be lost",
            "It cannot be applied with a saved plan",
            "It always changes the resource address"
          ],
          "answer": 1,
          "explain": "A replace destroys the existing resource and creates a new one. For a database or bucket, the destroy is the data-loss step, and the summary line can make it look like a routine update."
        },
        {
          "q": "Terraform and Argo CD both manage the same Deployment. What happens?",
          "options": [
            "Argo CD detects Terraform and defers",
            "Terraform refuses to plan while Argo CD is installed",
            "They merge changes deterministically",
            "They revert each other's changes on every apply and sync"
          ],
          "answer": 3,
          "explain": "Both write the full object. Argo's selfHeal reverts Terraform's change and the next terraform apply reverts Argo's, producing flapping that usually ends with someone editing prod manually."
        }
      ],
      "quickbytes": [
        "Remote state with locking, or two applies will corrupt the mapping.",
        "terraform plan -out=tfplan, then show -json: review the plan, not the HCL.",
        "[\"delete\",\"create\"] in actions is a replace, not an update.",
        "One owner per Kubernetes object: Terraform or Argo CD, never both."
      ],
      "production": [
        "State lives in a remote backend with locking and version history.",
        "CI posts the plan for review and applies only the saved plan file.",
        "A plan gate blocks delete or replace of stateful resources without an override.",
        "A scheduled plan reports drift; the report is a ticket, not an auto-apply.",
        "Cloud resources are Terraform-owned and workloads are Kustomize/Helm-owned, with no overlap."
      ],
      "crates": [
        "serde_json",
        "serde"
      ],
      "github": [
        {
          "name": "serde-rs/json",
          "url": "https://github.com/serde-rs/json"
        },
        {
          "name": "hashicorp/terraform",
          "url": "https://github.com/hashicorp/terraform"
        }
      ],
      "pitfall": "Parsing terraform plan text output for the word destroy: the format changes between versions, replaces are reported as updates in some summaries, and the gate silently stops blocking anything.",
      "resources": [
        {
          "title": "Terraform: infrastructure as code",
          "url": "https://github.com/hashicorp/terraform",
          "kind": "repo"
        },
        {
          "title": "Kustomize: template-free configuration customization",
          "url": "https://github.com/kubernetes-sigs/kustomize",
          "kind": "repo"
        },
        {
          "title": "Conftest: policy tests for structured configuration",
          "url": "https://github.com/open-policy-agent/conftest",
          "kind": "repo"
        },
        {
          "title": "Kubernetes API reference",
          "url": "https://kubernetes.io/docs/reference/kubernetes-api/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "k11",
      "n": 11,
      "title": "Blue/green: flipping traffic without dropping requests",
      "minutes": 75,
      "level": "advanced",
      "goal": "Run two full stacks behind one Service, cut over only after the new stack is genuinely ready, and drain the old one without losing in-flight requests.",
      "sections": [
        {
          "h": "Two stacks, one mutable selector",
          "p": [
            "Blue/green keeps two complete deployments and moves traffic by changing which one a Service selects. The cutover is a single patch of spec.selector, and rollback is the same patch in reverse, which makes recovery time measured in seconds rather than in a rollout. That property is the entire reason to pay for it.",
            "The price is doubled capacity for the duration of the overlap, plus a hard requirement that both versions can talk to the same database schema. If the new version needs a column the old one does not know about, the schema change must land first and be backward compatible; otherwise the rollback you were counting on restores code that cannot read the data it now finds."
          ],
          "list": [
            "Cutover cost is one selector patch; rollback cost is the same patch",
            "Both versions must tolerate the same schema during the overlap",
            "You need 2x capacity, or a very short overlap window",
            "Long-lived connections (WebSockets, gRPC streams) do not migrate on a flip"
          ],
          "tip": "Keep the old stack running for at least one full connection-drain period after the flip. Deleting it immediately is how you discover the requests that were still in flight."
        },
        {
          "h": "Draining is asynchronous, so make it visible",
          "p": [
            "When a pod is deleted, two things happen in parallel: the endpoint controller removes it from the Service, and the kubelet sends SIGTERM. They are not synchronised. A request can be routed to a pod that has already received SIGTERM, which is why the standard advice is a preStop sleep long enough for endpoint propagation plus a graceful shutdown that stops accepting new connections before it exits.",
            "terminationGracePeriodSeconds must exceed the sum of the preStop delay and the app's own drain time. If it does not, the kubelet sends SIGKILL mid-request and the client sees a reset connection. In Rust, that means the server future must complete on SIGTERM and the process must not exit until in-flight handlers finish, which axum's with_graceful_shutdown does for you."
          ],
          "code": "use axum::{routing::get, Router};\nuse tokio::net::TcpListener;\nuse tokio::signal::unix::{signal, SignalKind};\n\n#[tokio::main]\nasync fn main() -> Result<(), Box<dyn std::error::Error>> {\n    let app = Router::new()\n        .route(\"/healthz\", get(|| async { \"ok\" }))\n        .route(\"/readyz\", get(|| async { \"ok\" }));\n\n    let listener = TcpListener::bind(\"0.0.0.0:8080\").await?;\n\n    let shutdown = async {\n        let mut sigterm = signal(SignalKind::terminate()).expect(\"sigterm handler\");\n        tokio::select! {\n            _ = tokio::signal::ctrl_c() => {}\n            _ = sigterm.recv() => {}\n        }\n        tracing::info!(\"shutdown signal received, draining\");\n    };\n\n    axum::serve(listener, app)\n        .with_graceful_shutdown(shutdown)\n        .await?;\n    Ok(())\n}",
          "tip": "Log on SIGTERM. A pod that dies without a shutdown log either never got the signal or exited before draining."
        },
        {
          "h": "The cutover, with checks before and after",
          "p": [
            "The flip is a patch, but the decision to flip is a check. Green must be fully available - every replica ready, readiness probes passing from inside the cluster - before the selector moves. Checking from your laptop proves nothing about the pod network or the Service endpoints, so use a temporary in-cluster Job or kubectl exec into an existing pod to curl the green Service.",
            "After the flip, watch error rate and latency for at least one traffic cycle before deleting blue. If the metric moves, patch the selector back: it is the same one-line operation and it is faster than any rollout. Record both digests in the deploy log so the incident review can name exactly what served traffic during the window."
          ],
          "code": "# 1. Deploy green (a full second stack) and wait for it.\nkubectl apply -f deploy/api-green.yaml\nkubectl rollout status deployment/api-green -n prod --timeout=5m\n\n# 2. Prove green is reachable through the cluster network, not just from a laptop.\nkubectl run smoke --rm -it --restart=Never --image=curlimages/curl:8.10.1 -n prod -- \\\n  curl -fsS http://api-green.prod.svc.cluster.local/readyz\n\n# 3. Flip the selector: the whole cutover.\nkubectl patch service api -n prod --type=json \\\n  -p='[{\"op\":\"replace\",\"path\":\"/spec/selector/version\",\"value\":\"green\"}]'\n\n# 4. Watch the error rate, then retire blue.\nkubectl rollout status deployment/api-green -n prod\nkubectl scale deployment/api-blue -n prod --replicas=0   # after the soak window",
          "list": [
            "Smoke test from inside the cluster before the flip",
            "Flip with a JSON patch on spec.selector, not by editing a manifest and applying",
            "Soak for a full traffic cycle before scaling blue down",
            "Record both digests; the deploy log is the incident timeline"
          ],
          "tip": "If the selector patch is not a one-liner in your runbook, nobody will do it correctly at 3 a.m. Script it and test the script."
        }
      ],
      "exercise": {
        "prompt": "Write the manifests and commands for a blue/green cutover of a Rust API: two deployments distinguished by a version label, one Service, a readiness gate before the flip, and a rollback command.",
        "starter": "# deploy/api-blue.yaml and api-green.yaml differ only by label and image\n# service selects version: blue\n# commands: deploy green, verify, flip, rollback\n",
        "hint": "Use labels app: api and version: blue|green, with the Service selecting both app and version. Verify with an in-cluster curl against the green Service. Flip with a JSON patch and roll back with the same patch pointing at blue.",
        "solution": "# Both Deployments carry labels app=api and version=blue|green.\n# The Service selects {app: api, version: blue} initially.\n\napiVersion: v1\nkind: Service\nmetadata:\n  name: api\nspec:\n  selector:\n    app: api\n    version: blue        # the only field that changes at cutover\n  ports:\n    - { name: http, port: 80, targetPort: http }\n\n# Cutover\n#   kubectl apply -f deploy/api-green.yaml\n#   kubectl rollout status deployment/api-green -n prod --timeout=5m\n#   kubectl run smoke --rm -it --restart=Never -n prod \\\n#     --image=curlimages/curl:8.10.1 -- curl -fsS http://api-green.prod.svc.cluster.local/readyz\n#   kubectl patch service api -n prod --type=json \\\n#     -p='[{\"op\":\"replace\",\"path\":\"/spec/selector/version\",\"value\":\"green\"}]'\n\n# Rollback: identical patch, value blue. Seconds, not minutes.\n#   kubectl patch service api -n prod --type=json \\\n#     -p='[{\"op\":\"replace\",\"path\":\"/spec/selector/version\",\"value\":\"blue\"}]'"
      },
      "questions": [
        {
          "q": "What is the main structural cost of blue/green compared with a rolling update?",
          "options": [
            "It cannot be rolled back",
            "It requires the same image in both stacks",
            "It requires a service mesh",
            "It needs double capacity during the overlap and schema compatibility across both versions"
          ],
          "answer": 3,
          "explain": "Two complete stacks must run simultaneously, so you pay for capacity twice, and both versions read and write the same database, so migrations must be backward compatible."
        },
        {
          "q": "Why is a preStop sleep often needed before shutdown?",
          "options": [
            "It prevents the pod from being rescheduled",
            "Kubernetes requires a delay for readiness",
            "It gives the JIT time to warm up",
            "Endpoint removal and SIGTERM are not synchronised, so traffic can still arrive after shutdown starts"
          ],
          "answer": 3,
          "explain": "The endpoint controller and the kubelet act independently. A short sleep lets the Service stop sending new connections before the process begins draining, avoiding resets on requests that were routed mid-shutdown."
        },
        {
          "q": "What breaks a blue/green rollback that was planned as instant?",
          "options": [
            "A migration that dropped or renamed a column the old version still reads",
            "The image digests differ",
            "The old Deployment was scaled to zero",
            "The Service selector is immutable"
          ],
          "answer": 0,
          "explain": "Rolling back restores old code, not the old schema. A destructive migration makes the previous version unable to run, which is why schema changes must be expand/contract across at least two releases."
        }
      ],
      "quickbytes": [
        "Cutover and rollback are the same selector patch in opposite directions.",
        "terminationGracePeriodSeconds > preStop sleep + drain time.",
        "Smoke test from inside the cluster, not from a laptop.",
        "Scale the old stack to zero only after a full traffic cycle."
      ],
      "production": [
        "Both stacks run from digest-pinned images and the deploy log records both digests.",
        "The Service selector flip is a scripted, tested operation, not a manual edit.",
        "Graceful shutdown is implemented and logs on SIGTERM; the grace period exceeds drain time.",
        "Schema changes are expand/contract so the previous version remains runnable.",
        "A soak window with error-rate and latency checks precedes retiring the old stack."
      ],
      "crates": [
        "axum",
        "tokio",
        "tracing"
      ],
      "github": [
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        },
        {
          "name": "tokio-rs/tokio",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "pitfall": "Flipping the Service selector before the green stack is ready: the Service now routes to pods with no endpoints, and every request fails until the new pods pass readiness - an outage caused by a correct deployment.",
      "resources": [
        {
          "title": "Kubernetes: Service and selectors",
          "url": "https://kubernetes.io/docs/concepts/services-networking/service/",
          "kind": "docs"
        },
        {
          "title": "Kubernetes: pod lifecycle and termination",
          "url": "https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/",
          "kind": "docs"
        },
        {
          "title": "axum crate documentation",
          "url": "https://docs.rs/axum/latest/axum/",
          "kind": "docs"
        },
        {
          "title": "Kubernetes: configure liveness and readiness probes",
          "url": "https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "k12",
      "n": 12,
      "title": "Canary releases gated by metrics",
      "minutes": 100,
      "level": "industry",
      "goal": "Shift a fraction of traffic to a new version, decide promotion from a PromQL error-rate analysis rather than a human watching a dashboard, and abort automatically when the analysis fails.",
      "sections": [
        {
          "h": "A canary is an experiment with a blast radius",
          "p": [
            "Blue/green asks whether the new version is broken; a canary asks how broken, on real traffic, for a small share of users. That is a better question when the failure is a slow query or a rare 500 under a specific payload, but it only works if you can measure the difference between the two populations. Without per-version metrics, a canary is just a slower deploy.",
            "The statistics matter more than the tooling. With 1 percent of traffic and a 0.1 percent baseline error rate, you need tens of thousands of requests before a doubling is distinguishable from noise. Set the step weights and the analysis interval from your traffic volume, not from a blog post: a low-traffic service needs bigger steps or longer windows, and a service with no traffic cannot canary at all."
          ],
          "list": [
            "Every metric must carry a version or revision label, or the comparison is impossible",
            "Choose step weight and interval from request volume, not from defaults",
            "Define the abort condition before the first rollout",
            "A canary that cannot reach statistical significance is a slow blue/green"
          ],
          "tip": "Compare canary against stable in the same query (a ratio), not against a historical baseline. Diurnal traffic patterns will otherwise trigger false aborts."
        },
        {
          "h": "Rollout steps and the analysis template",
          "p": [
            "Argo Rollouts replaces the Deployment with a Rollout custom resource and adds steps: setWeight, pause, and analysis. The controller creates a canary ReplicaSet, shifts traffic through the Service or an ingress, and runs the analysis at the points you specify. A failed analysis aborts the rollout and shifts traffic back without a human.",
            "The AnalysisTemplate is where the real decision lives. It is a PromQL query, an interval, a success condition and a failure limit. Keep the query narrow: the share of 5xx responses for the canary revision over the last few minutes, compared with the stable revision. Wide queries that mix in unrelated endpoints or background jobs produce aborts that nobody can explain."
          ],
          "code": "apiVersion: argoproj.io/v1alpha1\nkind: Rollout\nmetadata:\n  name: api\nspec:\n  replicas: 6\n  selector:\n    matchLabels: { app: api }\n  template:\n    metadata:\n      labels: { app: api }\n    spec:\n      containers:\n        - name: api\n          image: registry.example.com/api@sha256:abc123\n          ports: [{ name: http, containerPort: 8080 }]\n  strategy:\n    canary:\n      analysis:\n        templates:\n          - templateName: error-rate\n        startingStep: 1\n      steps:\n        - setWeight: 10\n        - pause: { duration: 5m }\n        - setWeight: 30\n        - pause: { duration: 10m }\n        - setWeight: 60\n        - pause: { duration: 10m }\n---\napiVersion: argoproj.io/v1alpha1\nkind: AnalysisTemplate\nmetadata:\n  name: error-rate\nspec:\n  metrics:\n    - name: error-rate\n      interval: 1m\n      count: 10\n      failureLimit: 2\n      successCondition: result[0] < 0.01\n      provider:\n        prometheus:\n          address: http://prometheus.monitoring:9090\n          query: |\n            sum(rate(http_requests_total{app=\"api\",status=~\"5..\"}[2m]))\n            / clamp_min(sum(rate(http_requests_total{app=\"api\"}[2m])), 0.001)",
          "tip": "failureLimit above zero tolerates a blip; count and interval decide how long the controller keeps watching before it declares success."
        },
        {
          "h": "The metrics the service must expose",
          "p": [
            "The analysis is only as good as the metric. A Rust service should expose a request counter labelled by status class and a latency histogram, both carrying whatever label the rollout controller uses to distinguish revisions. With metrics-exporter-prometheus that is a global recorder plus a scrape endpoint rendered from a handle.",
            "One detail bites people: install_recorder does not spawn the upkeep task, so histogram buckets accumulate memory until the process restarts. Keep the handle and call run_upkeep on an interval, or use install and let the exporter own its listener. Also label with a bounded set of values - status, method, route - never with user ids or raw paths, or the series count explodes."
          ],
          "code": "use axum::{extract::State, routing::get, Router};\nuse metrics::{counter, histogram};\nuse metrics_exporter_prometheus::{PrometheusBuilder, PrometheusHandle};\nuse std::time::Instant;\n\n#[tokio::main]\nasync fn main() -> Result<(), Box<dyn std::error::Error>> {\n    let handle = PrometheusBuilder::new().install_recorder()?;\n\n    // install_recorder does not spawn upkeep: do it ourselves.\n    let upkeep = handle.clone();\n    tokio::spawn(async move {\n        loop {\n            tokio::time::sleep(std::time::Duration::from_secs(5)).await;\n            upkeep.run_upkeep();\n        }\n    });\n\n    let app = Router::new()\n        .route(\"/metrics\", get(metrics_handler))\n        .with_state(handle);\n    let listener = tokio::net::TcpListener::bind(\"0.0.0.0:8080\").await?;\n    axum::serve(listener, app).await?;\n    Ok(())\n}\n\nasync fn metrics_handler(State(handle): State<PrometheusHandle>) -> String {\n    handle.render()\n}\n\npub fn observe_request(status: u16, started: Instant) {\n    let class = format!(\"{}xx\", status / 100);\n    counter!(\"http_requests_total\", \"status\" => class).increment(1);\n    histogram!(\"http_request_duration_seconds\").record(started.elapsed().as_secs_f64());\n}",
          "list": [
            "Label with bounded cardinality: status class, method, route template",
            "Call run_upkeep on an interval when using install_recorder",
            "Expose /metrics on the pod network only, not through the public ingress",
            "Assert in a test that a request increments the counter with the expected labels"
          ],
          "tip": "A histogram with a user-id label will eventually take down Prometheus, not the service. Cardinality is a shared resource."
        }
      ],
      "exercise": {
        "prompt": "Define a canary strategy that reaches 50 percent traffic in three steps with an automated error-rate gate, and add the Rust counter that the analysis query depends on.",
        "starter": "apiVersion: argoproj.io/v1alpha1\nkind: Rollout\nmetadata:\n  name: api\nspec:\n  strategy:\n    canary:\n      steps: []\n",
        "hint": "Use setWeight 10/30/50 with a pause after each, and attach an AnalysisTemplate with a successCondition on the 5xx ratio. On the Rust side, increment a counter with a status label on every response so the query has data.",
        "solution": "apiVersion: argoproj.io/v1alpha1\nkind: Rollout\nmetadata:\n  name: api\nspec:\n  replicas: 6\n  selector:\n    matchLabels: { app: api }\n  template:\n    metadata:\n      labels: { app: api }\n    spec:\n      containers:\n        - name: api\n          image: registry.example.com/api@sha256:abc123\n  strategy:\n    canary:\n      analysis:\n        templates: [{ templateName: error-rate }]\n      steps:\n        - setWeight: 10\n        - pause: { duration: 5m }\n        - setWeight: 30\n        - pause: { duration: 10m }\n        - setWeight: 50\n        - pause: { duration: 10m }\n\n// Rust: the counter the query reads\n// counter!(\"http_requests_total\", \"status\" => format!(\"{}xx\", status / 100)).increment(1);\n// PromQL: sum(rate(http_requests_total{status=~\"5..\"}[2m]))\n//        / clamp_min(sum(rate(http_requests_total[2m])), 0.001)"
      },
      "questions": [
        {
          "q": "Why compare canary and stable in one PromQL ratio instead of against last week's baseline?",
          "options": [
            "Traffic patterns change by time of day, so a historical baseline produces false aborts",
            "Ratios are cheaper to compute",
            "The canary has no labels",
            "Prometheus cannot query historical data"
          ],
          "answer": 0,
          "explain": "Error rates follow load and time of day. Dividing canary errors by canary traffic and comparing with stable traffic at the same moment removes that shared variation."
        },
        {
          "q": "What happens when an AnalysisRun fails during a canary?",
          "options": [
            "The canary pods are left running at 50 percent",
            "The Rollout is deleted",
            "The Rollout pauses indefinitely",
            "The controller aborts the rollout and shifts traffic back to the stable version"
          ],
          "answer": 3,
          "explain": "A failed analysis marks the rollout Degraded, scales the canary down and restores full traffic to stable. That automatic abort is the point of metric-gated promotion."
        },
        {
          "q": "What is the risk of calling install_recorder and never running upkeep?",
          "options": [
            "Counters reset on every scrape",
            "Metrics are not recorded at all",
            "Histogram state grows without maintenance and memory climbs over the process lifetime",
            "The scrape endpoint returns 404"
          ],
          "answer": 2,
          "explain": "install_recorder installs the recorder but does not spawn the background upkeep task. Without periodic run_upkeep, histogram buckets and idle series accumulate and memory grows until a restart."
        }
      ],
      "quickbytes": [
        "Every metric needs a revision or version label, or the canary is unmeasurable.",
        "successCondition: result[0] < 0.01 with failureLimit: 2 tolerates a blip.",
        "install_recorder requires you to call run_upkeep yourself.",
        "Low traffic means bigger steps and longer windows, not smaller ones."
      ],
      "production": [
        "Request metrics carry a revision label and a bounded status label.",
        "Analysis windows and step weights are set from measured request volume.",
        "A failed analysis aborts and restores stable traffic without human action.",
        "The metrics endpoint is reachable only from the monitoring network.",
        "Canary and stable digests are recorded in the deploy log for the postmortem."
      ],
      "crates": [
        "metrics-exporter-prometheus",
        "metrics",
        "axum",
        "tokio"
      ],
      "github": [
        {
          "name": "argoproj/argo-rollouts",
          "url": "https://github.com/argoproj/argo-rollouts"
        },
        {
          "name": "metrics-rs/metrics",
          "url": "https://github.com/metrics-rs/metrics"
        }
      ],
      "pitfall": "Running a canary at 1 percent on a service that receives a few hundred requests an hour: the analysis window contains too few requests to distinguish a regression from noise, so it either never aborts or aborts on a single 500.",
      "resources": [
        {
          "title": "Argo Rollouts: progressive delivery for Kubernetes",
          "url": "https://github.com/argoproj/argo-rollouts",
          "kind": "repo"
        },
        {
          "title": "metrics-exporter-prometheus crate documentation",
          "url": "https://docs.rs/metrics-exporter-prometheus/latest/metrics_exporter_prometheus/",
          "kind": "docs"
        },
        {
          "title": "Kubernetes: Deployments and rollout semantics",
          "url": "https://kubernetes.io/docs/concepts/workloads/controllers/deployment/",
          "kind": "docs"
        },
        {
          "title": "CNCF channel: progressive delivery talks",
          "url": "https://www.youtube.com/@CNCF",
          "kind": "video"
        }
      ]
    },
    {
      "id": "k13",
      "n": 13,
      "title": "Feature flags: deploy without releasing",
      "minutes": 75,
      "level": "advanced",
      "goal": "Separate deployment from release with runtime flags, choose a deliberate behaviour when the flag provider is unavailable, and keep flag debt from becoming permanent branching.",
      "sections": [
        {
          "h": "Four kinds of flag, one lifecycle each",
          "p": [
            "Release flags hide unfinished work behind a default-off switch so trunk stays deployable. Ops flags are kill switches you turn on during an incident, and they must be testable before you need them. Permission flags encode entitlement and belong with authorization, not with a rollout tool. Experiment flags split traffic to measure an outcome and must be removed when the experiment concludes.",
            "Mixing them is how flag debt starts. Every flag is a branch that doubles the state space of the service, so each one needs an owner and an expiry date, and the default should be the safe state that requires no action. A repository with three hundred live flags does not have a feature-flag system; it has an undocumented configuration language."
          ],
          "list": [
            "Release flag: default off, removed after rollout, owner named in the PR",
            "Ops flag: default on for the safe path, exercised in a drill before it is needed",
            "Permission flag: evaluated server-side, never trusted from the client",
            "Experiment flag: has a conclusion date and a removal commit"
          ],
          "tip": "Put the flag name, owner and expiry in one registry file, and fail CI on flags older than their expiry."
        },
        {
          "h": "Decide what happens when the provider is down",
          "p": [
            "Flag evaluation is a network call, and networks fail. The client library keeps a cached configuration and evaluates locally, so the steady state does not depend on the provider, but a cold start during an outage has no cache. The default argument to is_enabled is therefore a real product decision, not a formality: default false keeps a broken feature off, default true keeps a working feature on.",
            "Whichever you choose, choose it per flag and write it down. A kill switch whose fallback is on has no value during the incident it exists for. A new feature whose fallback is on will be enabled by an outage. The failure mode to avoid is the accidental one: a default that nobody reviewed, differing between the server and a batch job that evaluates the same flag."
          ],
          "code": "use unleash_api_client::client::{Client, ClientBuilder, FeatureKey};\nuse unleash_api_client::context::Context;\n\n#[derive(Debug, Copy, Clone)]\npub enum Flags {\n    NewCheckout,\n    PaymentsKillSwitch,\n}\n\nimpl FeatureKey for Flags {\n    fn name(self) -> &'static str {\n        match self {\n            Flags::NewCheckout => \"checkout.v2\",\n            Flags::PaymentsKillSwitch => \"payments.kill\",\n        }\n    }\n}\n\npub fn context_for(user_id: &str) -> Context {\n    Context { user_id: Some(user_id.to_string()), ..Default::default() }\n}\n\npub async fn is_new_checkout(client: &Client<Flags>, user_id: &str) -> bool {\n    // Default false: if the provider is unreachable and there is no cache,\n    // the new path stays off rather than exposing an unproven feature.\n    client.is_enabled(Flags::NewCheckout, Some(context_for(user_id)), false)\n}",
          "tip": "The third argument to is_enabled is the fallback, and it is the only thing standing between an outage and an accidental launch."
        },
        {
          "h": "Sticky bucketing and the polling client",
          "p": [
            "A percentage rollout is only coherent if the same user keeps landing on the same side. Providers derive that from a hash of the flag name and a context field - usually the user id - so the assignment is stable without server state. Pass a stable identifier; a random uuid per request turns a 10 percent rollout into 10 percent of every user's requests.",
            "The Rust client is async and pushes nothing: you register, then drive poll_for_updates in a background task so the local cache refreshes. The client also sends usage metrics back, which is what makes the provider's view of flag usage match reality. If the polling task dies, evaluation keeps working from the last cache and quietly drifts out of date, so log and alert on staleness."
          ],
          "code": "use std::sync::Arc;\nuse std::time::Duration;\nuse unleash_api_client::client::{Client, ClientBuilder};\nuse crate::flags::{context_for, Flags};\n\n// Client<F> is not Clone, so share it behind an Arc: the poller needs one\n// handle and the request path needs another.\npub async fn start(\n    api_url: String,\n    app_name: String,\n    instance_id: String,\n    token: String,\n) -> Result<Arc<Client<Flags>>, Box<dyn std::error::Error + Send + Sync>> {\n    let client = Arc::new(ClientBuilder::default().into_client::<Flags>(\n        &api_url, &app_name, &instance_id, token,\n    )?);\n    client.register().await?;\n\n    let poller = Arc::clone(&client);\n    tokio::spawn(async move {\n        // poll_for_updates returns () and runs until stop_poll() is called;\n        // if this task dies the cache silently stops refreshing.\n        poller.poll_for_updates().await;\n    });\n\n    tokio::time::sleep(Duration::from_millis(500)).await;\n    Ok(client)\n}\n\npub fn kill_switch_engaged(client: &Client<Flags>, user: &str) -> bool {\n    // Ops flag: default true means payments stay blocked if we cannot evaluate.\n    client.is_enabled(Flags::PaymentsKillSwitch, Some(context_for(user)), true)\n}",
          "list": [
            "Pass a stable user id, not a per-request random value",
            "Run poll_for_updates in a supervised task and alert if it exits",
            "Test both branches of every release flag in CI",
            "Remove the flag and the dead branch in the same PR that completes the rollout"
          ],
          "tip": "A flag that is always true in production is dead code with a network dependency. Delete it."
        }
      ],
      "exercise": {
        "prompt": "Define a feature-flag enum with a release flag and a payments kill switch, wire the client with a background poller, and make each flag's fallback behaviour explicit with a comment explaining the choice.",
        "starter": "use unleash_api_client::client::{Client, ClientBuilder, FeatureKey};\n\n#[derive(Debug, Copy, Clone)]\npub enum Flags {\n    // add variants\n}\n\nimpl FeatureKey for Flags {\n    fn name(self) -> &'static str { todo!() }\n}\n",
        "hint": "Two variants: a new checkout path (fallback false, so an outage does not launch it) and a payments kill switch (fallback true, so an outage fails safe). Build the client with ClientBuilder::default().into_client, register, then spawn poll_for_updates.",
        "solution": "use std::sync::Arc;\nuse std::time::Duration;\nuse unleash_api_client::client::{Client, ClientBuilder, FeatureKey};\nuse unleash_api_client::context::Context;\n\n#[derive(Debug, Copy, Clone)]\npub enum Flags {\n    NewCheckout,\n    PaymentsKillSwitch,\n}\n\nimpl FeatureKey for Flags {\n    fn name(self) -> &'static str {\n        match self {\n            Flags::NewCheckout => \"checkout.v2\",\n            Flags::PaymentsKillSwitch => \"payments.kill\",\n        }\n    }\n}\n\nfn ctx(user_id: &str) -> Context {\n    Context { user_id: Some(user_id.to_string()), ..Context::default() }\n}\n\npub async fn start(url: &str, app: &str, instance: &str, token: String)\n    -> Result<Arc<Client<Flags>>, Box<dyn std::error::Error + Send + Sync>>\n{\n    let client = Arc::new(ClientBuilder::default()\n        .into_client::<Flags>(url, app, instance, token)?);\n    client.register().await?;\n\n    let poller = Arc::clone(&client);\n    tokio::spawn(async move { poller.poll_for_updates().await });\n    tokio::time::sleep(Duration::from_millis(500)).await;\n    Ok(client)\n}\n\npub fn checkout(client: &Client<Flags>, user: &str) -> bool {\n    client.is_enabled(Flags::NewCheckout, Some(ctx(user)), false) // fail closed\n}\n\npub fn payments_blocked(client: &Client<Flags>, user: &str) -> bool {\n    client.is_enabled(Flags::PaymentsKillSwitch, Some(ctx(user)), true) // fail safe\n}"
      },
      "questions": [
        {
          "q": "What is the third argument to is_enabled for?",
          "options": [
            "The user's group membership",
            "The fallback value used when the flag cannot be evaluated, including a cold start during an outage",
            "Whether to send usage metrics",
            "The flag's default percentage"
          ],
          "answer": 1,
          "explain": "It is the local default. With no cached configuration - a fresh pod during a provider outage - evaluation returns this value, so it decides whether an outage disables or enables the behaviour."
        },
        {
          "q": "Why must the bucketing context contain a stable identifier?",
          "options": [
            "The provider bills per unique context",
            "Assignment is a hash of flag and context, so a random value per request randomises the rollout",
            "Contexts are cached by user id",
            "Metrics require a primary key"
          ],
          "answer": 1,
          "explain": "Percentage rollouts rely on deterministic hashing so a user consistently lands on the same side. A per-request uuid makes every request independently bucketed, which is not a rollout."
        },
        {
          "q": "What does a flag that is permanently true in production represent?",
          "options": [
            "Dead code plus a network dependency, and a branch that still needs testing",
            "A kill switch in the armed state",
            "A permission flag",
            "A successful experiment"
          ],
          "answer": 0,
          "explain": "Once a release flag is fully rolled out, both branches still exist in the binary and both must be maintained and tested. Removing the flag and the losing branch is part of finishing the release."
        }
      ],
      "quickbytes": [
        "Release flags default off; kill switches default to the safe state.",
        "Pass a stable user id, or the percentage is per request, not per user.",
        "poll_for_updates must run in a supervised task; a dead poller is silent drift.",
        "Delete the flag in the same PR that finishes the rollout."
      ],
      "production": [
        "Every flag has an owner and an expiry in a registry that CI checks.",
        "Fallback values are reviewed per flag and documented next to the evaluation site.",
        "Flag polling runs in a supervised task with staleness alerting.",
        "Permission flags are evaluated server-side and never trusted from client input.",
        "Both branches of an active flag are covered by tests."
      ],
      "crates": [
        "unleash-api-client",
        "tokio",
        "serde"
      ],
      "github": [
        {
          "name": "Unleash/unleash",
          "url": "https://github.com/Unleash/unleash"
        },
        {
          "name": "Unleash/unleash-rust-sdk",
          "url": "https://github.com/Unleash/unleash-rust-sdk"
        }
      ],
      "pitfall": "Setting the fallback of a kill switch to false (feature enabled): during the incident the switch exists for, a provider outage silently re-enables the thing you are trying to turn off.",
      "resources": [
        {
          "title": "unleash-api-client crate documentation",
          "url": "https://docs.rs/unleash-api-client/latest/unleash_api_client/",
          "kind": "docs"
        },
        {
          "title": "Unleash: open-source feature flag service",
          "url": "https://github.com/Unleash/unleash",
          "kind": "repo"
        },
        {
          "title": "flagd: an OpenFeature-compliant flag daemon",
          "url": "https://github.com/open-feature/flagd",
          "kind": "repo"
        },
        {
          "title": "Unleash Rust SDK",
          "url": "https://github.com/Unleash/unleash-rust-sdk",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "k14",
      "n": 14,
      "title": "Rollback: undo, roll forward, or drain",
      "minutes": 90,
      "level": "industry",
      "goal": "Classify a production failure before reacting, use Kubernetes revision history and digest pinning for an exact revert, and rehearse the drill until the recovery time is a measured number.",
      "sections": [
        {
          "h": "Three failures, three different responses",
          "p": [
            "Rolling back is correct when the new code is wrong and the old code is still compatible with the data. It is wrong when the new code already wrote data the old code cannot read, when the failure is a dependency outage that the old code shares, or when the problem is capacity that a revert will not restore. The first five minutes should be classification, not action.",
            "Write the classification into the runbook as questions with observable answers: did the error rate rise with the deploy, does it correlate with a specific route, did a migration run in this release, is the dependency healthy for other services. A rollback that does not address the cause costs a second deploy window and often makes the data situation worse, which is why the drill matters more than the command."
          ],
          "list": [
            "Bad code, compatible data: roll back to the previous digest",
            "Bad code, incompatible data: roll forward with a fix, then repair data",
            "Shared dependency failure: reverting changes nothing; drain and mitigate",
            "Capacity or quota: scale or shed load, do not redeploy"
          ],
          "tip": "If the error rate started before the deploy, a rollback will not fix it. Check the timeline before the first kubectl command."
        },
        {
          "h": "What rollout undo actually does, and its limits",
          "p": [
            "kubectl rollout undo does not restore a snapshot. It takes the pod template from a previous ReplicaSet and makes it the current template, which triggers a new rollout through the same readiness gates as any deploy. That is good - it cannot bypass probes - and slow: recovery takes as long as a rollout, not as long as a Service patch.",
            "revisionHistoryLimit controls how many old ReplicaSets are kept, and the default of 10 is usually fine until someone deploys twenty times in a day and the revision you need has been garbage collected. Rolling back by digest is more reliable than by revision number: the digest names exact bytes, whereas a revision number depends on history that may have been pruned."
          ],
          "code": "# Inspect before acting: what changed, and is it still there?\nkubectl rollout history deployment/api -n prod\nkubectl rollout history deployment/api -n prod --revision=7\n\n# Revert to a specific revision (creates a new rollout, gated by probes).\nkubectl rollout undo deployment/api -n prod --to-revision=7\nkubectl rollout status deployment/api -n prod --timeout=5m\n\n# More reliable: revert to a known digest.\nkubectl set image deployment/api -n prod \\\n  api=registry.example.com/api@sha256:9f2c1e0b7a4d\nkubectl rollout status deployment/api -n prod --timeout=5m\n\n# If the rollout is stuck, see why before deleting anything.\nkubectl describe deployment/api -n prod | sed -n '/Conditions/,$p'",
          "tip": "Set revisionHistoryLimit deliberately. The default 10 can be too few for a service that deploys several times a day."
        },
        {
          "h": "Rehearse the rollback as a Rust program",
          "p": [
            "A rollback drill that depends on a human remembering a revision number is not a drill. Automate the verification half: patch the Deployment to a known-good digest, wait for the controller to report the rollout complete, and confirm the running pods actually serve that digest. kube's await_condition with is_deployment_completed gives you a typed wait instead of parsing kubectl output.",
            "The timeout is the important parameter. If the deployment does not complete within the budget, the program must fail loudly rather than hang, because a stuck rollback is an incident of its own. Print the elapsed time: the number you record in the drill is the number you can promise in the next incident review."
          ],
          "code": "use std::time::{Duration, Instant};\nuse k8s_openapi::api::apps::v1::Deployment;\nuse kube::api::{Api, Patch, PatchParams};\nuse kube::runtime::wait::{await_condition, conditions};\nuse kube::Client;\n\npub async fn rollback_to(\n    client: Client,\n    namespace: &str,\n    name: &str,\n    digest: &str,\n    budget: Duration,\n) -> Result<Duration, Box<dyn std::error::Error>> {\n    let started = Instant::now();\n    let deployments: Api<Deployment> = Api::namespaced(client.clone(), namespace);\n\n    let patch = serde_json::json!({\n        \"spec\": { \"template\": { \"spec\": { \"containers\": [{\n            \"name\": \"api\",\n            \"image\": format!(\"registry.example.com/api@{digest}\"),\n        }] } } }\n    });\n    deployments\n        .patch(name, &PatchParams::default(), &Patch::Strategic(patch))\n        .await?;\n\n    let wait = await_condition(deployments, name, conditions::is_deployment_completed());\n    tokio::time::timeout(budget, wait).await??;\n    Ok(started.elapsed())\n}",
          "list": [
            "A rollback is a rollout: it is gated by readiness, so it is not instant",
            "Revert by digest, not by revision number, when the history may have been pruned",
            "Time-box the wait and fail loudly on timeout",
            "Record the measured recovery time; that is the number you can promise"
          ],
          "tip": "Run the drill against a staging cluster on a schedule. A rollback path that has not executed in six months has decayed."
        }
      ],
      "exercise": {
        "prompt": "Write a function that reverts a Deployment to a previous image digest, waits for the rollout with a timeout, and returns how long recovery took. Then write the runbook questions that decide whether a rollback is the right response.",
        "starter": "pub async fn rollback_to(\n    client: kube::Client,\n    namespace: &str,\n    name: &str,\n    digest: &str,\n) -> Result<(), Box<dyn std::error::Error>> {\n    // patch the image, wait for completion, measure elapsed time\n    todo!()\n}\n",
        "hint": "Use Api::<Deployment>::namespaced, Patch::Strategic with a container image, then await_condition with conditions::is_deployment_completed wrapped in tokio::time::timeout. Return the elapsed Duration and error on timeout.",
        "solution": "use std::time::{Duration, Instant};\nuse k8s_openapi::api::apps::v1::Deployment;\nuse kube::api::{Api, Patch, PatchParams};\nuse kube::runtime::wait::{await_condition, conditions};\nuse kube::Client;\n\npub async fn rollback_to(\n    client: Client,\n    namespace: &str,\n    name: &str,\n    digest: &str,\n    budget: Duration,\n) -> Result<Duration, Box<dyn std::error::Error>> {\n    let started = Instant::now();\n    let deployments: Api<Deployment> = Api::namespaced(client, namespace);\n    let patch = serde_json::json!({\n        \"spec\": { \"template\": { \"spec\": { \"containers\": [{\n            \"name\": \"api\",\n            \"image\": format!(\"registry.example.com/api@{digest}\"),\n        }] } } }\n    });\n    deployments\n        .patch(name, &PatchParams::default(), &Patch::Strategic(patch))\n        .await?;\n    let wait = await_condition(deployments, name, conditions::is_deployment_completed());\n    tokio::time::timeout(budget, wait).await??;\n    Ok(started.elapsed())\n}\n\n// Runbook questions, answered before any command:\n// 1. Did the error rate rise within minutes of the deploy?\n// 2. Did a migration run in this release, and can the old code read the new schema?\n// 3. Is the dependency failing for other services too?\n// 4. Is the failure a capacity or quota problem?"
      },
      "questions": [
        {
          "q": "Why is kubectl rollout undo not an instant recovery?",
          "options": [
            "It creates a new rollout from the previous template, gated by readiness like any deploy",
            "It rebuilds the image",
            "It restores a volume snapshot",
            "It waits for a manual approval"
          ],
          "answer": 0,
          "explain": "Undo changes the pod template back and lets the Deployment controller roll it out. Pods must schedule, start and pass readiness, so recovery takes a rollout's worth of time."
        },
        {
          "q": "When is a rollback the wrong response?",
          "options": [
            "When the image is pinned by digest",
            "When the Service uses a named port",
            "When the previous revision is still available",
            "When a migration already wrote data the previous version cannot read"
          ],
          "answer": 3,
          "explain": "Old code plus new data is often worse than new code plus a bug. If the schema moved forward destructively, the fix is to roll forward and repair, not to restore a version that cannot read its own database."
        },
        {
          "q": "Why prefer reverting by digest over --to-revision?",
          "options": [
            "Revision rollback skips readiness probes",
            "Revision numbers are not supported in newer versions",
            "Old ReplicaSets can be pruned by revisionHistoryLimit, so the revision you need may be gone",
            "Digests deploy faster"
          ],
          "answer": 2,
          "explain": "Revision history is capped and garbage collected. A digest names exact bytes and remains valid as long as the image exists in the registry, independent of cluster history."
        }
      ],
      "quickbytes": [
        "Classify the failure before issuing a command.",
        "rollout undo is a rollout, not a snapshot restore.",
        "Set revisionHistoryLimit from your deploy frequency.",
        "A drill that has not run in six months is not a rollback plan."
      ],
      "production": [
        "The runbook starts with classification questions, not commands.",
        "Rollback targets are image digests recorded at deploy time.",
        "revisionHistoryLimit is set deliberately for the deploy frequency.",
        "The rollback drill runs on a schedule and its measured MTTR is recorded.",
        "Migrations are expand/contract so the previous version stays runnable."
      ],
      "crates": [
        "kube",
        "k8s-openapi",
        "serde_json",
        "tokio"
      ],
      "github": [
        {
          "name": "kube-rs/kube",
          "url": "https://github.com/kube-rs/kube"
        },
        {
          "name": "kubernetes/kubernetes",
          "url": "https://github.com/kubernetes/kubernetes"
        }
      ],
      "pitfall": "Rolling back after a destructive migration: the old pods start, fail to read a column that no longer exists, and the service is now failing in a way the new version did not, with data already rewritten.",
      "resources": [
        {
          "title": "Kubernetes: managing deployments and rollouts",
          "url": "https://kubernetes.io/docs/concepts/workloads/management/",
          "kind": "docs"
        },
        {
          "title": "kube crate documentation",
          "url": "https://docs.rs/kube/latest/kube/",
          "kind": "docs"
        },
        {
          "title": "kube-rs: wait conditions and controller runtime",
          "url": "https://github.com/kube-rs/kube",
          "kind": "repo"
        },
        {
          "title": "Kubernetes: Deployments and revision history",
          "url": "https://kubernetes.io/docs/concepts/workloads/controllers/deployment/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "k15",
      "n": 15,
      "title": "Release engineering: one version, one artifact",
      "minutes": 75,
      "level": "advanced",
      "goal": "Treat the version as a contract with a single source of truth, expose the running build's identity at runtime, and promote one artifact by digest instead of rebuilding per environment.",
      "sections": [
        {
          "h": "Semver is a promise, and a service makes several",
          "p": [
            "For a library, semver is enforced by the compiler: a breaking change is one that stops downstream code from compiling. A service has no such check, so the version is a promise you make to clients, dashboards and runbooks. Breaking changes for an HTTP API are removals and semantic changes - a field that becomes nullable, a status code that changes from 400 to 422, an enum that gains a value a strict client rejects.",
            "Keep two numbers separate. The artifact version identifies the build; the API version identifies the contract, and it usually appears in the path or a header. Coupling them means a patch release of the binary implies an API change, which is false, and it forces clients to track your deploy cadence. A service can ship 1.9.3 while still serving v1 of its API."
          ],
          "list": [
            "Artifact version: identifies the build, moves with every release",
            "API version: identifies the contract, moves rarely and with notice",
            "Additive changes are minor; removals and semantic changes are major",
            "Announce deprecations with a date and a migration path in the changelog"
          ],
          "tip": "If clients cannot tell which contract version they are calling, the API version is not doing its job."
        },
        {
          "h": "One source of truth, stamped into the binary",
          "p": [
            "The version must be written once and derived everywhere else: the crate manifest, the image label, the git tag, the changelog heading and the /version response. The practical way is a build script that reads the git commit and the package version and emits them as compile-time environment variables, so the running process can report exactly which build it is.",
            "That endpoint is the difference between a five-minute and a fifty-minute incident. When a pod reports version, commit and build time, an operator can answer is prod running the fix without pulling an image or trusting a dashboard. Add the image digest if the build system can pass it in; the digest is the identifier that survives a rebuild of the same commit."
          ],
          "code": "// build.rs - stamp the build identity into the binary.\nuse std::process::Command;\n\nfn main() {\n    println!(\"cargo:rerun-if-changed=build.rs\");\n    println!(\"cargo:rerun-if-env-changed=GIT_SHA\");\n\n    let sha = std::env::var(\"GIT_SHA\").unwrap_or_else(|_| {\n        Command::new(\"git\")\n            .args([\"rev-parse\", \"--short=12\", \"HEAD\"])\n            .output()\n            .ok()\n            .and_then(|out| String::from_utf8(out.stdout).ok())\n            .map(|s| s.trim().to_string())\n            .unwrap_or_else(|| \"unknown\".into())\n    });\n    println!(\"cargo:rustc-env=BUILD_GIT_SHA={sha}\");\n    println!(\"cargo:rustc-env=BUILD_VERSION={}\", env!(\"CARGO_PKG_VERSION\"));\n}\n\n// src/version.rs\n#[derive(serde::Serialize)]\npub struct BuildInfo {\n    pub version: &'static str,\n    pub git_sha: &'static str,\n}\n\npub fn build_info() -> BuildInfo {\n    BuildInfo {\n        version: env!(\"BUILD_VERSION\"),\n        git_sha: env!(\"BUILD_GIT_SHA\"),\n    }\n}",
          "tip": "Pass GIT_SHA from CI rather than running git in the container build: the .git directory is usually absent from the build context."
        },
        {
          "h": "Build once, promote by digest",
          "p": [
            "Rebuilding per environment is the most common release bug in disguise: staging and production receive different bytes from the same commit because a dependency resolved differently or a builder image changed. Build one image, sign it, and promote that digest through environments. The promotion is a commit that changes a digest, which is reviewable and reversible.",
            "For the notes, generate them from the commit history rather than from memory. Conventional commits plus a changelog generator produce a draft that a human edits, and tools like cargo-release or cargo-dist automate the mechanical parts for libraries and binaries. What matters is that the changelog and the tag are produced by the same step that publishes, so they cannot disagree about what shipped."
          ],
          "code": "# Promote the exact digest that passed staging.\nDIGEST=sha256:abc123\ncosign verify registry.example.com/api@$DIGEST \\\n  --certificate-identity-regexp '^https://github.com/acme/api/' \\\n  --certificate-oidc-issuer https://token.actions.githubusercontent.com\n\n# The promotion commit only changes a digest in the deploy repo.\n#   git commit -m \"promote api to $DIGEST\"\n\n# Tag and changelog from one step, for a published library:\n#   cargo release patch --execute --no-confirm\n#   cargo dist plan && cargo dist build --artifacts=all\n\n# Image labels make the identity greppable in the registry:\n#   org.opencontainers.image.version=1.4.2\n#   org.opencontainers.image.revision=$GIT_SHA",
          "list": [
            "Build once, promote the digest; never rebuild for production",
            "Tag and changelog are produced by the publishing step",
            "Image labels carry version and revision for registry-side queries",
            "A rebuild of the same commit is a different artifact and must not be treated as equal"
          ],
          "tip": "If your release notes are written by hand after the deploy, they will eventually describe a different release than the one that shipped."
        }
      ],
      "exercise": {
        "prompt": "Add a build script that stamps the git sha and package version into the binary, expose them on /version, and write the promotion step that deploys an existing digest rather than rebuilding.",
        "starter": "// build.rs\nfn main() {\n    // emit BUILD_GIT_SHA and BUILD_VERSION\n}\n\n// handler\n// GET /version -> { version, git_sha }\n",
        "hint": "Use println!(\"cargo:rustc-env=...\") in build.rs and env!() in the handler. Read GIT_SHA from the environment with a git rev-parse fallback. For promotion, reference the image by @sha256 digest and never run docker build again.",
        "solution": "// build.rs\nuse std::process::Command;\n\nfn main() {\n    println!(\"cargo:rerun-if-env-changed=GIT_SHA\");\n    let sha = std::env::var(\"GIT_SHA\").unwrap_or_else(|_| {\n        Command::new(\"git\")\n            .args([\"rev-parse\", \"--short=12\", \"HEAD\"])\n            .output()\n            .ok()\n            .and_then(|o| String::from_utf8(o.stdout).ok())\n            .map(|s| s.trim().to_string())\n            .unwrap_or_else(|| \"unknown\".into())\n    });\n    println!(\"cargo:rustc-env=BUILD_GIT_SHA={sha}\");\n    println!(\"cargo:rustc-env=BUILD_VERSION={}\", env!(\"CARGO_PKG_VERSION\"));\n}\n\n// src/main.rs\nuse axum::{routing::get, Json, Router};\nuse serde::Serialize;\n\n#[derive(Serialize)]\nstruct BuildInfo { version: &'static str, git_sha: &'static str }\n\nasync fn version() -> Json<BuildInfo> {\n    Json(BuildInfo {\n        version: env!(\"BUILD_VERSION\"),\n        git_sha: env!(\"BUILD_GIT_SHA\"),\n    })\n}\n\npub fn app() -> Router {\n    Router::new().route(\"/version\", get(version))\n}\n\n// Promotion: deploy registry.example.com/api@sha256:abc123, never rebuild."
      },
      "questions": [
        {
          "q": "Why should production not rebuild the artifact that staging validated?",
          "options": [
            "The registry rejects duplicate tags",
            "Builds are not reproducible across architectures",
            "Rebuilds are slower",
            "The same commit can produce different bytes, so staging did not validate what production runs"
          ],
          "answer": 3,
          "explain": "Toolchain, base image and dependency resolution can differ between builds. Promoting the exact digest guarantees production runs the artifact that was tested and signed."
        },
        {
          "q": "What belongs in the /version response?",
          "options": [
            "The deployment's replica count",
            "Only the semver string from Cargo.toml",
            "The version, the git revision and ideally the image digest, stamped at build time",
            "The full Cargo.lock contents"
          ],
          "answer": 2,
          "explain": "An operator needs to answer which build is running without pulling the image. Version plus revision plus digest makes that a single HTTP call and ties the process to the artifact."
        },
        {
          "q": "Why keep the API version separate from the artifact version?",
          "options": [
            "Semver does not apply to services",
            "They change at different rates: a patch release does not imply a contract change",
            "Kubernetes requires an API version label",
            "Clients cannot parse semver"
          ],
          "answer": 1,
          "explain": "The artifact version tracks builds; the API version tracks the contract. Coupling them forces clients to follow your deploy cadence and makes every patch release look like a compatibility event."
        }
      ],
      "quickbytes": [
        "Artifact version and API version are different promises.",
        "Stamp the git sha at build time; do not run git inside the container.",
        "Promote the digest, never rebuild for production.",
        "Tag, changelog and publish happen in one step, or they disagree."
      ],
      "production": [
        "One source of truth for the version; image labels, tags and /version all derive from it.",
        "Every build records its git revision, and /version reports it.",
        "Environments promote the same digest; no environment rebuilds.",
        "Release notes are generated from commits and edited before publishing.",
        "Deprecations carry a date and a migration path in the changelog."
      ],
      "crates": [
        "semver",
        "serde",
        "axum"
      ],
      "github": [
        {
          "name": "dtolnay/semver",
          "url": "https://github.com/dtolnay/semver"
        },
        {
          "name": "crate-ci/cargo-release",
          "url": "https://github.com/crate-ci/cargo-release"
        }
      ],
      "pitfall": "Stamping the git sha by running git inside the Docker build: the .git directory is excluded from the build context, so every image reports unknown and the field looks like a bug rather than a missing input.",
      "resources": [
        {
          "title": "Cargo Book: semver compatibility",
          "url": "https://doc.rust-lang.org/cargo/reference/semver.html",
          "kind": "docs"
        },
        {
          "title": "semver crate documentation",
          "url": "https://docs.rs/semver/latest/semver/",
          "kind": "docs"
        },
        {
          "title": "cargo-release: release automation for Cargo projects",
          "url": "https://github.com/crate-ci/cargo-release",
          "kind": "repo"
        },
        {
          "title": "cargo-dist: build and publish distributable artifacts",
          "url": "https://github.com/axodotdev/cargo-dist",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "k16",
      "n": 16,
      "title": "SBOMs that survive an incident",
      "minutes": 80,
      "level": "advanced",
      "goal": "Generate an SBOM from the actual artifact, bind it to the image digest as an attestation, and answer which deployed images contain a given crate without rebuilding anything.",
      "sections": [
        {
          "h": "What an SBOM proves, and what it does not",
          "p": [
            "A software bill of materials is an inventory: components, versions, and the dependency relationships between them, in a standard format. CycloneDX and SPDX are the two that matter, and both can express the same facts. What an SBOM does not do is tell you whether anything is vulnerable - it is the input to that question, not the answer, and an SBOM without a digest binding is a spreadsheet that may describe a different build.",
            "The binding is the part teams skip. An SBOM attached to a tag describes whatever that tag pointed at when it was generated. An SBOM attached to a digest, as an OCI attestation, describes exactly the bytes you deployed. During an incident the difference is everything: you need to enumerate images by digest and know the inventory is true for the running container."
          ],
          "list": [
            "CycloneDX for security tooling, SPDX for license compliance - both are legitimate",
            "Bind the SBOM to the image digest, not to a tag or a CI run id",
            "Include direct and transitive dependencies, and the relationship edges",
            "Record the generator and the format version so the file is reproducible later"
          ],
          "tip": "An SBOM generated from the source tree describes the source; one generated from the image describes what shipped. Prefer the image."
        },
        {
          "h": "Generate from the artifact, attach as an attestation",
          "p": [
            "syft reads an image, a directory or an archive and emits CycloneDX or SPDX. Pointed at an image digest, it enumerates OS packages and language ecosystems, including crates when it can read Cargo.lock or the embedded dependency data. cargo-cyclonedx produces a CycloneDX document from the Cargo metadata for the source side, which is useful for a repository-level inventory.",
            "Then attach it. cosign attest writes an in-toto attestation with the SBOM as the predicate and stores it alongside the image in the registry, keyed by digest. That is what makes the SBOM discoverable at 2 a.m. without a CI system: cosign download attestation against the digest, no build logs required. Attach provenance the same way - the build system already knows which workflow and commit produced the image."
          ],
          "code": "# Generate from the published digest, not from the local build.\nDIGEST=sha256:abc123\nsyft registry.example.com/api@$DIGEST \\\n  -o cyclonedx-json=sbom.cdx.json \\\n  -o spdx-json=sbom.spdx.json\n\n# Attach as an OCI attestation bound to that digest.\ncosign attest --yes \\\n  --predicate sbom.cdx.json \\\n  --type cyclonedx \\\n  registry.example.com/api@$DIGEST\n\n# Source-side inventory for the repository.\ncargo cyclonedx --format json --output-file target/sbom.cdx.json\n\n# Provenance is generated by the builder, not hand-written:\n#   docker buildx build --provenance=mode=max --sbom=true ...",
          "tip": "--provenance=mode=max records the build inputs and the builder; --sbom=true asks BuildKit for its own SBOM. Both land as attestations on the digest."
        },
        {
          "h": "The query you actually need",
          "p": [
            "The SBOM earns its keep when a crate gets an advisory and someone asks which production images include it. That is a search across every SBOM you have retained, filtered by name and version range, returning digests. If your SBOMs live only as CI artifacts behind a ninety-day retention policy, that query is unanswerable for anything older than a quarter.",
            "Two habits make the query possible. Retain SBOMs in the registry next to the image, where the retention matches the image's. And keep a small index - a table of digest, image name, crate, version - that you can query with SQL rather than grepping JSON. A Rust binary using cargo_metadata can also catch the cheap version of this before publish: duplicate crate versions in the graph are a supply-chain smell and a licence-review problem."
          ],
          "code": "use cargo_metadata::MetadataCommand;\nuse std::collections::BTreeMap;\n\n/// Crates that appear at more than one version in the dependency graph.\n/// Duplicates bloat the binary, double the audit surface and often signal\n/// a stale direct dependency pinning an old release.\npub fn duplicate_crates() -> Result<Vec<String>, Box<dyn std::error::Error>> {\n    let metadata = MetadataCommand::new().exec()?;\n    let mut versions: BTreeMap<String, Vec<String>> = BTreeMap::new();\n\n    for package in &metadata.packages {\n        versions\n            .entry(package.name.to_string())\n            .or_default()\n            .push(package.version.to_string());\n    }\n\n    let mut duplicates: Vec<String> = versions\n        .into_iter()\n        .filter(|(_, found)| found.len() > 1)\n        .map(|(name, mut found)| {\n            found.sort();\n            format!(\"{name}: {}\", found.join(\", \"))\n        })\n        .collect();\n    duplicates.sort();\n    Ok(duplicates)\n}",
          "list": [
            "Retain SBOMs with the image, in the registry, for the image's lifetime",
            "Index digest, image, crate and version in a queryable table",
            "Duplicate crate versions are a smell worth failing on in review",
            "Keep the generator version; a format change should be a diff you can explain"
          ],
          "tip": "cosign download attestation --predicate-type cyclonedx returns the SBOM for a digest. Test that path before you need it."
        }
      ],
      "exercise": {
        "prompt": "Write the pipeline steps that generate an SBOM from a published image digest, attach it as an attestation, and answer which of two digests contains a vulnerable crate version.",
        "starter": "# 1. generate from the digest\n# 2. attach as an attestation\n# 3. query the SBOM for a crate and version\n",
        "hint": "syft registry.example.com/api@sha256:... -o cyclonedx-json=sbom.json, then cosign attest --predicate sbom.json --type cyclonedx against the same digest. Query with jq over .components[] selecting .name and .version.",
        "solution": "set -euo pipefail\nDIGEST=sha256:abc123\nIMAGE=registry.example.com/api@$DIGEST\n\n# 1. Generate from the digest that is actually deployed.\nsyft \"$IMAGE\" -o cyclonedx-json=sbom.cdx.json\n\n# 2. Bind it to the digest in the registry.\ncosign attest --yes --predicate sbom.cdx.json --type cyclonedx \"$IMAGE\"\n\n# 3. Query: which components are the crate we care about?\njq -r '.components[]\n  | select(.name == \"openssl\")\n  | \"\\(.name) \\(.version)\"' sbom.cdx.json\n\n# Across every retained SBOM, the same jq filter over each digest\n# answers \"which images contain openssl < 0.10.68\".\n# Retain the attestations for the image's lifetime, not the CI artifact's."
      },
      "questions": [
        {
          "q": "Why attach the SBOM to the image digest rather than the tag?",
          "options": [
            "Tags cannot carry attestations",
            "The digest names exact bytes, so the inventory is provably about the running image",
            "Attestations are smaller when keyed by digest",
            "Registries garbage-collect tags"
          ],
          "answer": 1,
          "explain": "A tag can be moved to a different image. A digest is the content hash, so an attestation stored against it describes exactly the artifact you are running."
        },
        {
          "q": "What does an SBOM tell you on its own?",
          "options": [
            "Whether the image is signed",
            "Whether the build was reproducible",
            "Which components and versions are present, and how they relate",
            "Which components are vulnerable"
          ],
          "answer": 2,
          "explain": "It is an inventory. Vulnerability status comes from matching that inventory against advisory data, and signature or provenance status comes from separate attestations."
        },
        {
          "q": "Why is retaining SBOMs only as CI artifacts a problem?",
          "options": [
            "Artifact retention is usually shorter than the image's lifetime, so older deployed images have no inventory",
            "Artifacts cannot store JSON",
            "CI artifacts are not immutable",
            "Artifacts are not signed"
          ],
          "answer": 0,
          "explain": "CI artifacts typically expire in weeks or months while images stay deployed for years. When an advisory lands, the SBOM must still exist for every digest that is running."
        }
      ],
      "quickbytes": [
        "Generate the SBOM from the image digest, not from the source tree.",
        "cosign attest --type cyclonedx binds the inventory to the digest.",
        "Retain SBOMs as long as the image, not as long as the CI artifact.",
        "Duplicate crate versions are both an audit and a size problem."
      ],
      "production": [
        "Every published image has a CycloneDX or SPDX SBOM attached to its digest.",
        "SBOMs are retained for the image's lifetime and indexed for querying by crate and version.",
        "The pipeline fails on duplicate crate versions above a reviewed threshold.",
        "Provenance is generated by the builder (--provenance=mode=max), not written by hand.",
        "A documented query answers which deployed digests contain a given crate version."
      ],
      "crates": [
        "cargo_metadata",
        "serde_json"
      ],
      "github": [
        {
          "name": "oli-obk/cargo_metadata",
          "url": "https://github.com/oli-obk/cargo_metadata"
        },
        {
          "name": "anchore/syft",
          "url": "https://github.com/anchore/syft"
        }
      ],
      "pitfall": "Generating the SBOM from a local build directory instead of the published image: the inventory lists crates from a different feature set or target than the bytes in the registry, and the incident query returns the wrong answer with confidence.",
      "resources": [
        {
          "title": "syft: SBOM generation for images and filesystems",
          "url": "https://github.com/anchore/syft",
          "kind": "repo"
        },
        {
          "title": "cyclonedx-rust-cargo: SBOMs from Cargo projects",
          "url": "https://github.com/CycloneDX/cyclonedx-rust-cargo",
          "kind": "repo"
        },
        {
          "title": "Docker Docs: SLSA provenance attestations",
          "url": "https://docs.docker.com/build/metadata/attestations/slsa-provenance/",
          "kind": "docs"
        },
        {
          "title": "Towards Measuring Supply Chain Attacks on Package Managers (arXiv:2003.09772)",
          "url": "https://arxiv.org/abs/2003.09772",
          "kind": "paper"
        }
      ]
    },
    {
      "id": "k17",
      "n": 17,
      "title": "Signing artifacts and verifying identity",
      "minutes": 90,
      "level": "industry",
      "goal": "Sign images keylessly from CI, verify the signer's workflow identity rather than a bare key, and make an unsigned or foreign-signed image un-deployable.",
      "sections": [
        {
          "h": "A signature answers two questions",
          "p": [
            "A signature proves integrity - these bytes were not modified after signing - and identity - this principal signed them. It does not prove the code is safe, and it does not prove the build was clean. Those are separate claims, which is why provenance and SBOM attestations exist alongside the signature rather than instead of it.",
            "The identity question is the one people get wrong. Verifying that an image is signed by some key in a public key file says nothing about who holds that key. Verifying that it was signed by a certificate whose identity is your repository's release workflow, issued by a known OIDC issuer, says something specific and auditable. Pin the identity, not just the key."
          ],
          "list": [
            "Integrity: the digest matches what was signed",
            "Identity: which workflow, repository and issuer produced the signature",
            "Provenance: which inputs and builder produced the artifact",
            "Safety: none of the above; that requires review, tests and scanning"
          ],
          "tip": "A verify step without --certificate-identity and --certificate-oidc-issuer accepts any signer with a valid certificate. That is a signature check, not a trust decision."
        },
        {
          "h": "Keyless signing, bound to the workflow",
          "p": [
            "Keyless signing removes the long-lived private key from CI. The job requests an OIDC token from GitHub, exchanges it with Fulcio for a short-lived certificate whose subject encodes the workflow identity, signs the image digest, and records the signature in Rekor, an append-only transparency log. Nothing durable is left on the runner for an attacker to steal.",
            "Verification then becomes an identity check against the certificate, plus a Rekor lookup to confirm the signature was logged at a time you accept. That is why the verify command needs the issuer and an identity pattern: without them, cosign will happily verify an image signed by anyone else's workflow, including an attacker's fork."
          ],
          "code": "permissions:\n  contents: read\n  packages: write\n  id-token: write        # required for keyless signing\n\nsteps:\n  - uses: sigstore/cosign-installer@v3\n  - run: |\n      cosign sign --yes registry.example.com/api@${{ steps.build.outputs.digest }}\n\n# Verify: pin the identity, not just the key.\ncosign verify registry.example.com/api@sha256:abc123 \\\n  --certificate-identity-regexp '^https://github.com/acme/api/.github/workflows/release.yml@refs/heads/main$' \\\n  --certificate-oidc-issuer https://token.actions.githubusercontent.com\n\n# Verify an offline bundle without a registry round trip.\ncosign verify-blob --bundle api.sigstore.json --certificate-identity-regexp '...' \\\n  --certificate-oidc-issuer https://token.actions.githubusercontent.com api.tar.gz",
          "tip": "The identity regexp is the security boundary. A pattern like '.*' verifies that someone signed it, which is not a policy."
        },
        {
          "h": "Verifying inside the cluster",
          "p": [
            "The strongest place to enforce a signature is admission: a policy controller checks the image reference before the pod is created, and rejects anything not signed by the expected identity. That closes the gap where a manifest change points at an unsigned image and nothing in CI is involved, which is exactly the drift scenario GitOps is supposed to prevent.",
            "For Rust services that need to verify an artifact themselves - an updater, an operator validating a plugin - sigstore-rs provides the verification path. The API is explicit about trust material: build a trust root, fetch trusted signature layers for the image, then evaluate constraints such as the public key or annotations. Expect the crate to be labelled experimental, and pin the version deliberately."
          ],
          "code": "use sigstore::cosign::verification_constraint::{\n    AnnotationVerifier, PublicKeyVerifier, VerificationConstraintVec,\n};\nuse sigstore::cosign::{verify_constraints, CosignCapabilities};\nuse sigstore::crypto::SigningScheme;\nuse sigstore::trust::sigstore::SigstoreTrustRoot;\nuse std::collections::BTreeMap;\n\npub async fn verify_image(image_ref: &str, cosign_pub: &[u8])\n    -> Result<(), Box<dyn std::error::Error>>\n{\n    let auth = &sigstore::registry::Auth::Anonymous;\n    let repo = SigstoreTrustRoot::new(None).await?;\n    let mut client = sigstore::cosign::ClientBuilder::default()\n        .with_trust_repository(&repo)?\n        .build()?;\n\n    let image = image_ref.parse()?;\n    let layers = client.trusted_signature_layers(auth, &image).await?;\n\n    let mut annotations: BTreeMap<String, String> = BTreeMap::new();\n    annotations.insert(\"env\".into(), \"prod\".into());\n\n    let constraints: VerificationConstraintVec = vec![\n        Box::new(AnnotationVerifier { annotations }),\n        Box::new(PublicKeyVerifier::new(cosign_pub, &SigningScheme::default())?),\n    ];\n    verify_constraints(&layers, constraints.iter())?;\n    Ok(())\n}",
          "list": [
            "Admission control is where a signature actually prevents a deploy",
            "sigstore-rs is experimental: pin the version and cover it with tests",
            "PublicKeyVerifier proves the key, AnnotationVerifier proves the claim",
            "Transparency log entries let you audit when a signature appeared"
          ],
          "tip": "Rotate to keyless even if you keep a key-based fallback for air-gapped clusters. The long-lived key is the part that leaks."
        }
      ],
      "exercise": {
        "prompt": "Write a release job that signs an image keylessly, a verify command that only accepts your release workflow on main, and a Rust verification path for an operator that checks a public key plus an env annotation.",
        "starter": "permissions:\n  id-token: write\nsteps:\n  # install cosign, sign the digest\n\n# verify: which identity and issuer?\n",
        "hint": "id-token: write enables keyless. Sign the digest output of the build step, then verify with --certificate-identity-regexp pinned to your workflow path and --certificate-oidc-issuer set to GitHub's token issuer. For Rust, use ClientBuilder with a trust root and combine PublicKeyVerifier with AnnotationVerifier.",
        "solution": "permissions:\n  contents: read\n  packages: write\n  id-token: write\n\nsteps:\n  - uses: sigstore/cosign-installer@v3\n  - name: sign the digest\n    run: cosign sign --yes registry.example.com/api@${{ steps.build.outputs.digest }}\n\n# Verification used by CD and by admission policy:\n#   cosign verify registry.example.com/api@sha256:abc123 \\\n#     --certificate-identity-regexp '^https://github.com/acme/api/.github/workflows/release.yml@refs/heads/main$' \\\n#     --certificate-oidc-issuer https://token.actions.githubusercontent.com\n\n// Rust operator path (sigstore 0.14)\n// let repo = SigstoreTrustRoot::new(None).await?;\n// let mut client = sigstore::cosign::ClientBuilder::default()\n//     .with_trust_repository(&repo)?.build()?;\n// let layers = client.trusted_signature_layers(auth, &image).await?;\n// verify_constraints(&layers, vec![Box::new(AnnotationVerifier { annotations }),\n//     Box::new(PublicKeyVerifier::new(pub_key, &SigningScheme::default())?)].iter())?;"
      },
      "questions": [
        {
          "q": "What does keyless signing remove from CI?",
          "options": [
            "The need to verify signatures",
            "The long-lived private signing key, replaced by a short-lived certificate bound to the workflow identity",
            "The need for a transparency log",
            "The image digest"
          ],
          "answer": 1,
          "explain": "The runner exchanges an OIDC token for a short-lived Fulcio certificate, signs, and logs to Rekor. There is no durable key on the runner for an attacker to exfiltrate."
        },
        {
          "q": "Why is cosign verify without --certificate-identity insufficient?",
          "options": [
            "It requires a private key",
            "It cannot verify Rekor entries",
            "It skips the digest check",
            "It accepts a valid signature from any identity, including an attacker's workflow"
          ],
          "answer": 3,
          "explain": "Verification proves the artifact was signed and unmodified. Only the identity constraint ties that signature to your release workflow, which is the actual trust decision."
        },
        {
          "q": "Where does a signature prevent a deployment rather than merely describe one?",
          "options": [
            "In an admission controller that rejects images without a valid signature from the expected identity",
            "In the SBOM",
            "In the image label",
            "In the CI log"
          ],
          "answer": 0,
          "explain": "Admission control runs at pod creation, so it covers every path to the cluster, including a manifest edit that bypassed CI. A verified signature in a CI log prevents nothing."
        }
      ],
      "quickbytes": [
        "Sign the digest, never the tag.",
        "Verify with --certificate-identity-regexp and --certificate-oidc-issuer, always.",
        "id-token: write is the only permission keyless signing needs beyond packages: write.",
        "sigstore-rs is experimental; pin it and test the verification path."
      ],
      "production": [
        "Images are signed by digest in CI with keyless OIDC, and Rekor records the entry.",
        "Verification pins the workflow identity and the OIDC issuer, not just a public key.",
        "An admission policy rejects unsigned images and images signed by a foreign identity.",
        "SBOM and provenance attestations are signed and verified alongside the image.",
        "The verification command is tested in CI against a deliberately unsigned image."
      ],
      "crates": [
        "sigstore",
        "sha2",
        "tokio"
      ],
      "github": [
        {
          "name": "sigstore/cosign",
          "url": "https://github.com/sigstore/cosign"
        },
        {
          "name": "sigstore/sigstore-rs",
          "url": "https://github.com/sigstore/sigstore-rs"
        }
      ],
      "pitfall": "Verifying with a bare public key and no identity constraint: an attacker who obtains any certificate from the same issuer, or who can push to a fork's workflow, produces a signature that passes your check.",
      "resources": [
        {
          "title": "cosign: container signing and verification",
          "url": "https://github.com/sigstore/cosign",
          "kind": "repo"
        },
        {
          "title": "sigstore-rs crate documentation",
          "url": "https://docs.rs/sigstore/latest/sigstore/",
          "kind": "docs"
        },
        {
          "title": "sigstore-rs: Sigstore client in Rust",
          "url": "https://github.com/sigstore/sigstore-rs",
          "kind": "repo"
        },
        {
          "title": "Backstabber's Knife Collection: supply chain attacks (arXiv:2005.09535)",
          "url": "https://arxiv.org/abs/2005.09535",
          "kind": "paper"
        },
        {
          "title": "Sigstore channel: signing and transparency logs",
          "url": "https://www.youtube.com/@Sigstore",
          "kind": "video"
        }
      ]
    },
    {
      "id": "k18",
      "n": 18,
      "title": "Secrets in CI: short-lived by default",
      "minutes": 75,
      "level": "advanced",
      "goal": "Remove long-lived credentials from pipelines with OIDC federation, keep secrets out of logs, images and artifacts, and give the running service a rotation path that does not need a redeploy.",
      "sections": [
        {
          "h": "The leak surface is bigger than the log",
          "p": [
            "A secret in CI can leak through the log, an error message that includes a connection string, a test artifact, a cache entry, a Docker build argument recorded in image history, or a crash dump uploaded by a monitoring agent. Masking handles exactly one of those, and only when the value is printed verbatim - base64-encoding it defeats the mask, which is why masked secrets are a hygiene measure, not a control.",
            "The structural fix is to stop having long-lived secrets in the pipeline at all. A cloud credential that lives in repository settings for two years is a standing target; one minted per job and valid for fifteen minutes is not worth stealing. Everything else is defence in depth around that change."
          ],
          "list": [
            "Build arguments are visible in image history - never pass a secret with ARG",
            "Fork pull requests get no secrets; do not build a workflow that assumes they do",
            "Caches and artifacts persist beyond the job; never write credentials into them",
            "Masking is a log filter, not an access control"
          ],
          "tip": "grep your Dockerfiles for ARG and ENV near the word secret. If it appears, the value is in the image history whether or not the build failed."
        },
        {
          "h": "OIDC: mint credentials per job",
          "p": [
            "With id-token: write, a job can request a signed OIDC token from GitHub that asserts the repository, workflow, ref and environment. The cloud provider trusts that issuer and exchanges the token for short-lived credentials, subject to a condition on those claims. Nothing long-lived is stored, and the trust is narrow: a token from a pull request cannot assume the production role if the trust policy requires a protected environment.",
            "The trust policy is where the security lives. A condition that accepts any token from the repository lets any workflow, including one added in a fork's pull request after approval, assume the role. Pin the subject to the exact workflow path and ref, and require an environment for production so an approval gate sits between a branch and the credential."
          ],
          "code": "permissions:\n  id-token: write\n  contents: read\n\njobs:\n  deploy:\n    runs-on: ubuntu-24.04\n    environment: production       # adds the approval gate to the subject claim\n    steps:\n      - name: exchange OIDC token for short-lived cloud credentials\n        run: |\n          TOKEN=$(curl -fsS \\\n            -H \"Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN\" \\\n            \"$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com\" | jq -r .value)\n          CREDS=$(aws sts assume-role-with-web-identity \\\n            --role-arn arn:aws:iam::123456789012:role/gha-deploy \\\n            --role-session-name \"gha-$GITHUB_RUN_ID\" \\\n            --web-identity-token \"$TOKEN\" \\\n            --query Credentials --output json)\n          echo \"::add-mask::$(jq -r .SessionToken <<<\"$CREDS\")\"\n          echo \"AWS_ACCESS_KEY_ID=$(jq -r .AccessKeyId <<<\"$CREDS\")\" >> \"$GITHUB_ENV\"\n          echo \"AWS_SECRET_ACCESS_KEY=$(jq -r .SecretAccessKey <<<\"$CREDS\")\" >> \"$GITHUB_ENV\"\n          echo \"AWS_SESSION_TOKEN=$(jq -r .SessionToken <<<\"$CREDS\")\" >> \"$GITHUB_ENV\"",
          "tip": "Set the audience explicitly and check it in the trust policy. A token minted for one audience should not be replayable against another service."
        },
        {
          "h": "Secrets at runtime, and rotation",
          "p": [
            "Inside the cluster, a Secret is base64 in etcd unless encryption at rest is configured, and anyone with read access to the namespace can read it. That is acceptable for a bootstrap credential and not for much else. External Secrets Operator pulls from a real secret manager and keeps the Kubernetes Secret as a projection; Sealed Secrets lets you commit an encrypted value that only the cluster's controller can decrypt.",
            "Whatever the source, the service should read the secret once at startup, hold it in a type that does not print itself, and fail fast if it is missing rather than starting in a half-configured state. The secrecy crate wraps a value so Debug and Display redact it, which removes the accidental log line. For rotation, prefer credentials that can be reloaded - a file mount that is re-read on change, or a database credential with two active versions - over a redeploy."
          ],
          "code": "use secrecy::{ExposeSecret, SecretString};\n\npub struct Config {\n    pub database_url: SecretString,\n    pub stripe_key: SecretString,\n}\n\nimpl Config {\n    pub fn from_env() -> Result<Self, ConfigError> {\n        Ok(Self {\n            database_url: std::env::var(\"DATABASE_URL\")\n                .map_err(|_| ConfigError::Missing(\"DATABASE_URL\"))?\n                .into(),\n            stripe_key: std::env::var(\"STRIPE_KEY\")\n                .map_err(|_| ConfigError::Missing(\"STRIPE_KEY\"))?\n                .into(),\n        })\n    }\n}\n\n#[derive(Debug, thiserror::Error)]\npub enum ConfigError {\n    #[error(\"missing required environment variable {0}\")]\n    Missing(&'static str),\n}\n\n// The only place the value is unwrapped is where it is used:\n// let pool = PgPool::connect(config.database_url.expose_secret()).await?;",
          "list": [
            "Read secrets at startup and fail fast; never default to an empty value",
            "Wrap in SecretString so Debug and Display cannot print it",
            "Prefer file mounts over environment variables: env is visible in /proc and in crash dumps",
            "Design for rotation: reloadable files or dual-version credentials, not a redeploy"
          ],
          "tip": "If a service can start with a missing secret and only fail on the first request, it will pass readiness and fail in production."
        }
      ],
      "exercise": {
        "prompt": "Replace a long-lived cloud key in a deploy job with an OIDC exchange, and make the Rust service load its secrets into non-printing types that fail fast when absent.",
        "starter": "permissions:\n  contents: read\n\njobs:\n  deploy:\n    steps:\n      # currently uses secrets.AWS_SECRET_ACCESS_KEY\n\n// src/config.rs\n// load DATABASE_URL and STRIPE_KEY\n",
        "hint": "Add id-token: write and environment: production, request the token from ACTIONS_ID_TOKEN_REQUEST_URL, exchange it with sts assume-role-with-web-identity, and mask the session token. In Rust, wrap values in SecretString and return an error naming the missing variable.",
        "solution": "// permissions:\n//   contents: read\n//   id-token: write\n//\n// jobs:\n//   deploy:\n//     runs-on: ubuntu-24.04\n//     environment: production\n//     steps:\n//       - run: |\n//           TOKEN=$(curl -fsS -H \"Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN\" \\\n//             \"$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com\" | jq -r .value)\n//           aws sts assume-role-with-web-identity \\\n//             --role-arn arn:aws:iam::123456789012:role/gha-deploy \\\n//             --role-session-name \"gha-$GITHUB_RUN_ID\" \\\n//             --web-identity-token \"$TOKEN\" > creds.json\n//           echo \"::add-mask::$(jq -r .Credentials.SessionToken creds.json)\"\n\n// src/config.rs\nuse secrecy::SecretString;\n\npub struct Config {\n    pub database_url: SecretString,\n    pub stripe_key: SecretString,\n}\n\nimpl Config {\n    pub fn from_env() -> Result<Self, ConfigError> {\n        let get = |name: &'static str| -> Result<SecretString, ConfigError> {\n            std::env::var(name)\n                .map(SecretString::from)\n                .map_err(|_| ConfigError::Missing(name))\n        };\n        Ok(Self { database_url: get(\"DATABASE_URL\")?, stripe_key: get(\"STRIPE_KEY\")? })\n    }\n}\n\n#[derive(Debug, thiserror::Error)]\npub enum ConfigError {\n    #[error(\"missing required environment variable {0}\")]\n    Missing(&'static str),\n}"
      },
      "questions": [
        {
          "q": "Why is passing a secret as a Docker ARG unsafe?",
          "options": [
            "BuildKit rejects secrets in ARG",
            "ARG values are truncated",
            "The value is recorded in the image history and readable with docker history",
            "ARG cannot hold long strings"
          ],
          "answer": 2,
          "explain": "ARG and ENV values become part of the image config and layer history, so anyone who can pull the image can read them. Use BuildKit secret mounts instead."
        },
        {
          "q": "What makes an OIDC trust policy narrow enough to be useful?",
          "options": [
            "Pinning the subject to the exact workflow path and ref, and requiring a protected environment",
            "Requiring MFA on the GitHub account",
            "Rotating the role's access keys monthly",
            "Trusting the repository's issuer for any workflow"
          ],
          "answer": 0,
          "explain": "The token's claims are the authorization boundary. If any workflow in the repository can assume the role, a workflow added in a PR is enough to obtain production credentials."
        },
        {
          "q": "Why prefer a mounted file over an environment variable for a secret?",
          "options": [
            "Environment variables cannot be rotated",
            "Files are encrypted by the kubelet",
            "Environment variables are visible in /proc and in crash dumps, and are inherited by child processes",
            "Files bypass RBAC"
          ],
          "answer": 2,
          "explain": "Env vars are readable from the process environment by anything running in the container and often end up in dumps. A file mount can also be updated in place, which supports rotation without a restart."
        }
      ],
      "quickbytes": [
        "Masking is a log filter, not an access control.",
        "id-token: write plus a pinned subject claim replaces stored cloud keys.",
        "Never pass a secret through ARG or ENV in a Dockerfile.",
        "A missing secret must fail startup, not the first request."
      ],
      "production": [
        "Pipelines use OIDC federation; no long-lived cloud keys exist in repository settings.",
        "Trust policies pin the workflow path, ref and environment in the subject claim.",
        "Runtime secrets come from a secret manager via External Secrets or Sealed Secrets.",
        "Services hold secrets in non-printing types and fail fast when they are absent.",
        "Rotation is exercised on a schedule and does not require a redeploy."
      ],
      "crates": [
        "secrecy",
        "thiserror",
        "zeroize"
      ],
      "github": [
        {
          "name": "iqlusioninc/crates",
          "url": "https://github.com/iqlusioninc/crates"
        },
        {
          "name": "external-secrets/external-secrets",
          "url": "https://github.com/external-secrets/external-secrets"
        }
      ],
      "pitfall": "Printing a token with echo for debugging: masking only catches the exact string, so a base64 or partial print puts the credential in the log permanently, and logs are copied into ticketing systems.",
      "resources": [
        {
          "title": "Kubernetes: secrets good practices",
          "url": "https://kubernetes.io/docs/concepts/security/secrets-good-practices/",
          "kind": "docs"
        },
        {
          "title": "External Secrets Operator",
          "url": "https://github.com/external-secrets/external-secrets",
          "kind": "repo"
        },
        {
          "title": "Sealed Secrets: encrypted secrets in git",
          "url": "https://github.com/bitnami/sealed-secrets",
          "kind": "repo"
        },
        {
          "title": "secrecy crate documentation",
          "url": "https://docs.rs/secrecy/latest/secrecy/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "k19",
      "n": 19,
      "title": "Build matrices: targets, features, MSRV",
      "minutes": 80,
      "level": "advanced",
      "goal": "Multiply builds along the axes that catch real breakage - target triples, feature combinations and the minimum supported Rust version - without multiplying cost.",
      "sections": [
        {
          "h": "Choose the axes that find bugs",
          "p": [
            "A matrix exists to find the combinations that break. Target triples catch platform assumptions - endianness, libc, path separators, available syscalls. Feature combinations catch code that only compiles when two optional features are on together, which a default-feature build never exercises. Rust versions catch the difference between your MSRV claim and reality.",
            "Every axis doubles the job count, so the honest question is which failure each one has found. A matrix of six Rust versions and four targets is thirty jobs that mostly duplicate; two targets, an MSRV job and a feature powerset covers more real risk for less compute. Set fail-fast: false so one broken combination does not cancel the evidence from the others."
          ],
          "list": [
            "Targets: one glibc, one musl, one foreign architecture",
            "Features: default, no-default, all, and the powerset if the crate is a library",
            "Rust versions: stable and the declared MSRV, nothing in between",
            "fail-fast: false so a single failure does not hide the rest"
          ],
          "tip": "If a matrix leg has never failed, it is either perfect or untested. Check which one before keeping it."
        },
        {
          "h": "Cross-compilation beats emulation",
          "p": [
            "Multi-arch images are usually built with buildx and QEMU: buildx runs the arm64 builder under emulation on an x86 host. It works and it is slow, often five to ten times slower for a Rust build, and some build scripts behave differently under emulation. For a workspace with heavy dependencies, that cost is the difference between a four-minute and a forty-minute pipeline.",
            "Two better options exist. cross runs the build in a container with the right linker and sysroot, without full emulation, and is the least-effort path to aarch64 and musl targets. Native arm64 runners remove the emulation entirely and are the fastest option if you can get them. Whichever you choose, build both platforms in one buildx invocation so the manifest list is created atomically with the same tags."
          ],
          "code": "strategy:\n  fail-fast: false\n  matrix:\n    include:\n      - target: x86_64-unknown-linux-gnu\n        runner: ubuntu-24.04\n      - target: x86_64-unknown-linux-musl\n        runner: ubuntu-24.04\n      - target: aarch64-unknown-linux-musl\n        runner: ubuntu-24.04-arm\n\nsteps:\n  - uses: actions/checkout@v4\n  - uses: taiki-e/install-action@v2\n    with:\n      tool: cross\n  - run: cross build --release --locked --target ${{ matrix.target }}\n\n# One buildx invocation produces the multi-arch manifest list:\n#   docker buildx build --platform linux/amd64,linux/arm64 \\\n#     --provenance=mode=max --sbom=true --push -t registry.example.com/api:1.4.2 .",
          "tip": "Check the manifest list after publishing: docker buildx imagetools inspect must show both platforms, or the arm nodes will pull the amd64 image and crash."
        },
        {
          "h": "MSRV is a claim until a job proves it",
          "p": [
            "rust-version in Cargo.toml is a promise that the crate builds on that toolchain. Nothing enforces it: a dependency can raise its own MSRV in a patch release, and your claim silently becomes false while stable CI stays green. The only defence is a job that installs the declared version and builds, which means pinning the toolchain in that job rather than using stable.",
            "For libraries, add a feature powerset run. cargo-hack can enumerate each feature individually and the powerset of combinations, which catches the classic bug where two optional features define the same item or where a feature enables a module that references a dependency it did not enable. Run the powerset on one target and the individual features on the rest, or the job count explodes."
          ],
          "code": "# Cargo.toml: the claim\n# [package]\n# rust-version = \"1.85\"\n\njobs:\n  msrv:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions-rust-lang/setup-rust-toolchain@v1\n        with:\n          toolchain: 1.85.0\n      - run: cargo build --workspace --locked --all-targets\n\n  features:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@v4\n      - uses: taiki-e/install-action@v2\n        with:\n          tool: cargo-hack\n      - run: cargo hack check --workspace --each-feature --locked\n      - run: cargo hack check --workspace --feature-powerset --depth 2 --locked",
          "list": [
            "A rust-version without a pinned-toolchain job is documentation, not a guarantee",
            "cargo hack --each-feature catches features that do not compile alone",
            "Limit --feature-powerset with --depth; the full powerset is exponential",
            "A dependency's MSRV bump is the usual cause of a broken MSRV claim"
          ],
          "tip": "Run the MSRV job on a schedule as well as on PRs. Dependency patch releases can break the claim without any change in your repository."
        }
      ],
      "exercise": {
        "prompt": "Design a matrix for a Rust service with one glibc target, one musl target, an arm64 leg and an MSRV job, keeping the total job count at four, and add the feature-check job.",
        "starter": "jobs:\n  build:\n    strategy:\n      matrix:\n        include: []\n    steps: []\n",
        "hint": "Use include entries with target and runner pairs so each leg gets the right architecture runner. Put the MSRV and feature checks in separate jobs, not in the matrix, and use taiki-e/install-action for cargo-hack.",
        "solution": "jobs:\n  build:\n    strategy:\n      fail-fast: false\n      matrix:\n        include:\n          - { target: x86_64-unknown-linux-gnu, runner: ubuntu-24.04 }\n          - { target: x86_64-unknown-linux-musl, runner: ubuntu-24.04 }\n          - { target: aarch64-unknown-linux-musl, runner: ubuntu-24.04-arm }\n    runs-on: ${{ matrix.runner }}\n    steps:\n      - uses: actions/checkout@v4\n      - uses: taiki-e/install-action@v2\n        with: { tool: cross }\n      - run: cross build --release --locked --target ${{ matrix.target }}\n\n  msrv:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions-rust-lang/setup-rust-toolchain@v1\n        with: { toolchain: 1.85.0 }\n      - run: cargo build --workspace --locked --all-targets\n\n  features:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@v4\n      - uses: taiki-e/install-action@v2\n        with: { tool: cargo-hack }\n      - run: cargo hack check --workspace --each-feature --locked\n      - run: cargo hack check --workspace --feature-powerset --depth 2 --locked"
      },
      "questions": [
        {
          "q": "Why is QEMU-based multi-arch building expensive for Rust?",
          "options": [
            "It requires a different Cargo.lock",
            "QEMU cannot run rustc",
            "The whole compiler and every proc macro run under emulation, often several times slower",
            "It disables caching"
          ],
          "answer": 2,
          "explain": "buildx under QEMU emulates the target architecture for the entire build, including rustc and build scripts. Native arm runners or cross's containerised linkers avoid that cost."
        },
        {
          "q": "What does rust-version in Cargo.toml actually enforce?",
          "options": [
            "Cargo refuses to build on an older toolchain when resolving the workspace",
            "Nothing by itself; it is a claim that needs a CI job with that exact toolchain to be true",
            "It pins the toolchain for all contributors",
            "It sets the edition"
          ],
          "answer": 1,
          "explain": "Cargo will report an incompatible rust-version when resolving, but nothing checks that your code and dependencies actually build there. Only a job pinned to that toolchain proves the claim."
        },
        {
          "q": "What does cargo hack check --each-feature catch that --all-features does not?",
          "options": [
            "Unused dependencies",
            "MSRV violations",
            "Faster compilation",
            "Features that fail to compile on their own because of a missing dependency or a duplicate definition"
          ],
          "answer": 3,
          "explain": "--all-features compiles everything at once, which can mask a feature that only works because another feature was also enabled. Checking each feature alone finds the missing cfg or dependency."
        }
      ],
      "quickbytes": [
        "fail-fast: false, or one failure hides the rest of the matrix.",
        "Native arm runners beat QEMU for Rust builds by a large margin.",
        "A rust-version claim needs a job pinned to that exact toolchain.",
        "cargo hack --feature-powerset --depth 2 keeps the job count finite."
      ],
      "production": [
        "The matrix covers one glibc target, one musl target and one foreign architecture.",
        "The MSRV job pins the declared toolchain and runs on a schedule as well as on PRs.",
        "Feature checks cover each feature individually, not only --all-features.",
        "Multi-arch images are published as one manifest list and verified with imagetools inspect.",
        "Dead matrix legs are removed when they stop finding failures."
      ],
      "crates": [
        "cross",
        "cargo-hack"
      ],
      "github": [
        {
          "name": "cross-rs/cross",
          "url": "https://github.com/cross-rs/cross"
        },
        {
          "name": "taiki-e/cargo-hack",
          "url": "https://github.com/taiki-e/cargo-hack"
        }
      ],
      "pitfall": "Publishing a multi-arch image without checking the manifest list: the build succeeds for amd64 only, the arm nodes pull that image, and the pods crash with an exec format error during the next scale-up.",
      "resources": [
        {
          "title": "cross: zero-setup cross compilation for Rust",
          "url": "https://github.com/cross-rs/cross",
          "kind": "repo"
        },
        {
          "title": "cargo-hack: feature and version matrix testing",
          "url": "https://github.com/taiki-e/cargo-hack",
          "kind": "repo"
        },
        {
          "title": "Docker Docs: multi-platform builds",
          "url": "https://docs.docker.com/build/building/multi-platform/",
          "kind": "docs"
        },
        {
          "title": "Docker Buildx",
          "url": "https://github.com/docker/buildx",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "k20",
      "n": 20,
      "title": "Self-hosted runners: cost, cache, isolation",
      "minutes": 90,
      "level": "industry",
      "goal": "Run CI on infrastructure you control without turning build machines into a persistent, credential-holding, unpatched attack surface.",
      "sections": [
        {
          "h": "What you gain and what you take on",
          "p": [
            "Self-hosted runners buy three things: bigger machines for a compiler that wants cores and memory, network locality to a private registry and cluster, and a cost model that beats per-minute billing at sustained volume. Rust builds are unusually good candidates because they are CPU-bound, cache-heavy and repetitive.",
            "You also take on everything the hosted product did for you: patching the OS, rotating the runner image, monitoring disk, and - most importantly - isolation. A hosted runner is a fresh VM per job. A self-hosted runner that persists between jobs keeps the previous job's files, environment and credentials, and if it ever runs untrusted code, that is a compromise waiting for a trigger."
          ],
          "list": [
            "Gain: cores, memory, private network access, predictable cost at volume",
            "Take on: patching, disk management, isolation, and the runner's own credentials",
            "Rust-specific win: a warm cargo registry and sccache close to the builder",
            "Rust-specific risk: target directories fill disks silently"
          ],
          "tip": "Measure hosted cost per pipeline-minute against the fully loaded cost of the machine, its patching and its on-call. The break-even is usually higher than people expect."
        },
        {
          "h": "Ephemeral by default, isolated by policy",
          "p": [
            "Configure runners as ephemeral: one job per runner instance, then the process exits and the pod is replaced. That restores the hosted model's best property and removes the class of attack where a job plants something for the next job to execute. With Actions Runner Controller, scale sets create a pod per job and scale to zero when idle.",
            "Then constrain what a runner can reach. A runner that can talk to the Kubernetes API with a cluster-admin kubeconfig is a production credential sitting in a build container that runs third-party actions. Builders should push to a registry and nothing else; deployment should happen through GitOps, where the cluster pulls. Put runners on a network segment that can reach the registry and the package mirrors, and not the database."
          ],
          "code": "# Actions Runner Controller: one pod per job, scale to zero.\ngithubConfigUrl: https://github.com/acme/api\ngithubConfigSecret: arc-github-app\nrunnerScaleSetName: rust-linux-x64\nminRunners: 0\nmaxRunners: 20\n\n# runner container: ephemeral, no service-account token, bounded disk.\ntemplate:\n  spec:\n    serviceAccountName: arc-runner\n    automountServiceAccountToken: false\n    containers:\n      - name: runner\n        image: ghcr.io/actions/actions-runner:latest   # pin by digest in production\n        resources:\n          requests: { cpu: \"4\", memory: 8Gi, ephemeral-storage: 20Gi }\n          limits:   { cpu: \"8\", memory: 16Gi, ephemeral-storage: 40Gi }\n        env:\n          - { name: RUSTC_WRAPPER, value: sccache }\n          - { name: SCCACHE_BUCKET, value: acme-rust-sccache }\n\n# The kubeconfig that used to live here is gone: deployments are GitOps.",
          "tip": "automountServiceAccountToken: false on the runner pod. A runner with a mounted token can call the API server it is scheduled on."
        },
        {
          "h": "Cache locality is the real payoff",
          "p": [
            "The reason a self-hosted runner is fast is proximity. A registry mirror or a pre-pulled cargo registry, an sccache bucket in the same region, and a persistent build cache all cut the minutes that dominate a Rust pipeline. The mistake is to make correctness depend on that warmth: a runner that has never seen the repository must still produce a correct build, just slower.",
            "Operate it like any other production service. Alert on disk usage because target directories and Docker layers fill ephemeral storage and the symptom is a mysterious no space left on device mid-compile. Alert on queue depth, since maxRunners caps concurrency and a spike shows up as waiting jobs. And rebuild the runner image on a schedule, because an unpatched build machine with registry credentials is a more attractive target than the service it builds."
          ],
          "list": [
            "Pre-pull the cargo registry and point sccache at a local bucket",
            "Alert on ephemeral-storage usage; target/ growth is the usual outage",
            "Alert on queue depth against maxRunners",
            "Rebuild the runner image on a schedule and patch the OS inside it"
          ],
          "tip": "Run one job per week on a cold runner with no cache. If it fails, the cache has become a correctness dependency."
        }
      ],
      "exercise": {
        "prompt": "Write an ARC scale-set configuration for ephemeral Rust runners that scale to zero, cannot reach the cluster API, and use a shared sccache bucket. Then list the three alerts you would page on.",
        "starter": "# gha-runner-scale-set values\ngithubConfigUrl: https://github.com/acme/api\nminRunners: 0\nmaxRunners: 20\n# template: ephemeral, no automounted token, sccache env\n",
        "hint": "Set automountServiceAccountToken: false, give the runner CPU and memory requests sized for a Rust build, and set RUSTC_WRAPPER=sccache with an SCCACHE_BUCKET. Page on ephemeral-storage pressure, queue depth, and runner image age.",
        "solution": "githubConfigUrl: https://github.com/acme/api\ngithubConfigSecret: arc-github-app\nrunnerScaleSetName: rust-linux-x64\nminRunners: 0\nmaxRunners: 20\n\ntemplate:\n  spec:\n    serviceAccountName: arc-runner\n    automountServiceAccountToken: false\n    containers:\n      - name: runner\n        image: ghcr.io/actions/actions-runner:latest   # pin by digest in production\n        resources:\n          requests: { cpu: \"4\", memory: 8Gi, ephemeral-storage: 20Gi }\n          limits: { cpu: \"8\", memory: 16Gi, ephemeral-storage: 40Gi }\n        env:\n          - { name: RUSTC_WRAPPER, value: sccache }\n          - { name: SCCACHE_BUCKET, value: acme-rust-sccache }\n          - { name: CARGO_HOME, value: /home/runner/.cargo }\n\n# Page on:\n# 1. ephemeral-storage usage above 80% on any runner pod\n# 2. queued jobs older than 5 minutes against maxRunners\n# 3. runner image age above 30 days (patching SLA)"
      },
      "questions": [
        {
          "q": "Why must a self-hosted runner be ephemeral?",
          "options": [
            "Persistent runners cannot cache",
            "Ephemeral runners are cheaper",
            "State and credentials from one job would otherwise be available to the next job on the same machine",
            "GitHub requires it for scale sets"
          ],
          "answer": 2,
          "explain": "A persistent runner keeps files, environment and any leaked credential between jobs. Ephemeral runners restore the one-job-per-machine property that hosted runners give you for free."
        },
        {
          "q": "Why should a build runner not hold a cluster-admin kubeconfig?",
          "options": [
            "The runner executes third-party actions, so that credential is exposed to any dependency that runs in the job",
            "Kubernetes rejects clients from CI",
            "It conflicts with GitOps",
            "It slows the build"
          ],
          "answer": 0,
          "explain": "Build jobs run arbitrary code from actions and dependencies. A cluster credential there is a production key handed to whatever the supply chain delivers. GitOps removes the need entirely."
        },
        {
          "q": "What is the most common self-hosted runner outage in a Rust shop?",
          "options": [
            "Ephemeral storage filling up from target directories and image layers",
            "CPU throttling",
            "DNS resolution failures",
            "Network partitions"
          ],
          "answer": 0,
          "explain": "Rust target directories are large and grow with every feature set. Without disk alerts and cleanup, the machine hits no space left on device mid-compile, which presents as a random compiler error."
        }
      ],
      "quickbytes": [
        "One job per runner, then destroy it.",
        "automountServiceAccountToken: false on every runner pod.",
        "Alert on ephemeral-storage before the compiler does.",
        "Builders push to a registry; the cluster pulls from git."
      ],
      "production": [
        "Runners are ephemeral and scale to zero when idle.",
        "Runner pods have no automounted service-account token and no cluster credentials.",
        "Disk usage, queue depth and runner image age are alerted.",
        "A scheduled cold build proves the pipeline does not depend on warm caches.",
        "The runner image is rebuilt on a schedule with OS patches applied."
      ],
      "crates": [
        "sccache",
        "cargo-nextest"
      ],
      "github": [
        {
          "name": "actions/actions-runner-controller",
          "url": "https://github.com/actions/actions-runner-controller"
        },
        {
          "name": "mozilla/sccache",
          "url": "https://github.com/mozilla/sccache"
        }
      ],
      "pitfall": "Leaving one persistent runner in a pool for a hot cache: it accumulates credentials and files from every job, and it becomes the single machine an attacker needs to reach to obtain everything the pipeline has ever touched.",
      "resources": [
        {
          "title": "Actions Runner Controller: scale sets on Kubernetes",
          "url": "https://github.com/actions/actions-runner-controller",
          "kind": "repo"
        },
        {
          "title": "actions/runner: the runner agent",
          "url": "https://github.com/actions/runner",
          "kind": "repo"
        },
        {
          "title": "sccache: shared compilation cache",
          "url": "https://github.com/mozilla/sccache",
          "kind": "repo"
        },
        {
          "title": "GitHub channel: Actions at scale",
          "url": "https://www.youtube.com/@github",
          "kind": "video"
        }
      ]
    }
  ]
};
