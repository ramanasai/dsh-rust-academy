/**
 * Testing & quality track.
 *
 * API versions verified against docs.rs while authoring: proptest 1.12.0,
 * insta 1.49.0, mockall 0.15.0, testcontainers 0.28.0,
 * testcontainers-modules 0.15.0, criterion 0.8.2, loom 0.7.2, rstest 0.28.0,
 * trycmd 1.2.1, arbitrary 1.5.0, pact_consumer 1.4.11.
 * Tool versions are not pinned here because cargo-fuzz, cargo-mutants,
 * cargo-llvm-cov and nextest are binaries, not libraries; the commands shown
 * are the ones those tools document today.
 *
 * Data is JSON-compatible and consumed by the plugin build.
 */
export default {
  "key": "testing",
  "prefix": "i",
  "title": "Testing & quality",
  "blurb": "From unit tests to property-based testing, fuzzing, mutation testing, contract tests and chaos experiments.",
  "level": "industry",
  "project": {
    "title": "Capstone: a quality harness for a service",
    "brief": "Build a testing stack for an HTTP service: property tests over the core invariants, fuzz targets that run in CI, consumer-driven contract tests against a mock peer, and a load-test baseline that fails the build when p95 latency regresses beyond its budget.",
    "deliverables": [
      "Property tests for core invariants: round-trip codecs, ordering of idempotent writes, and money arithmetic that never loses a cent.",
      "Fuzz targets wired into CI with a committed corpus and a bounded per-run time budget.",
      "Contract tests against a mock peer that publish a pact file and verify it against the real provider.",
      "Load-test baseline and regression gate: k6 thresholds checked on every merge to main, with the previous run as the reference."
    ],
    "stack": [
      "proptest",
      "libfuzzer-sys",
      "insta",
      "testcontainers",
      "k6"
    ]
  },
  "lessons": [
    {
      "id": "i01",
      "n": 1,
      "title": "Unit tests: assert behavior, not implementation",
      "minutes": 55,
      "level": "core",
      "goal": "Write unit tests that pin observable behavior, keep them inside #[cfg(test)] so they never ship, and read a failing assertion without guessing.",
      "sections": [
        {
          "h": "A test is a function that states a claim",
          "p": [
            "A #[test] function runs on a harness thread and fails by panicking. assert_eq! prints both operands plus a diff on failure, which is why it beats assert!(a == b) for anything with a value worth seeing. Tests that need fallible setup can return Result<(), E> instead, so a failed ? aborts that one test with the error attached rather than a bare panic message.",
            "The module holding the tests is usually annotated #[cfg(test)], so it is compiled only for the test profile. Test helpers, fake implementations and extra dev-dependencies therefore never reach the release binary. That gate is also a discipline: if a test needs the helper in production code, the helper belongs in the library, not behind the cfg."
          ],
          "code": "#[derive(Debug, PartialEq, Eq)]\npub struct Millis(pub u64);\n\n#[derive(Debug, PartialEq, Eq)]\npub enum ParseError {\n    NoDigits,\n    UnknownUnit,\n    Overflow,\n}\n\npub fn parse_duration(input: &str) -> Result<Millis, ParseError> {\n    let split = input\n        .find(|c: char| !c.is_ascii_digit())\n        .unwrap_or(input.len());\n    let (digits, unit) = input.split_at(split);\n    let value: u64 = digits.parse().map_err(|_| ParseError::NoDigits)?;\n\n    let factor = match unit {\n        \"ms\" => 1,\n        \"s\" => 1_000,\n        _ => return Err(ParseError::UnknownUnit),\n    };\n\n    value.checked_mul(factor).map(Millis).ok_or(ParseError::Overflow)\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn seconds_are_scaled_to_milliseconds() {\n        assert_eq!(parse_duration(\"2s\"), Ok(Millis(2_000)));\n    }\n\n    #[test]\n    fn missing_digits_is_an_error() {\n        assert_eq!(parse_duration(\"ms\"), Err(ParseError::NoDigits));\n    }\n\n    #[test]\n    fn overflow_is_reported_not_wrapped() -> Result<(), ParseError> {\n        // 18446744073709552 * 1000 is just past u64::MAX.\n        assert_eq!(parse_duration(\"18446744073709552s\"), Err(ParseError::Overflow));\n        Ok(())\n    }\n}",
          "tip": "#[should_panic] without expected = \"...\" passes on any panic, including the one your setup caused by accident. Always name the message."
        },
        {
          "h": "Assert the contract, not the call order",
          "p": [
            "The test to keep is the one whose assertion reads like the requirement: two seconds is two thousand milliseconds, a missing digit count is an error, overflow is reported and not wrapped. A test that asserts on a private helper's call sequence breaks on a refactor that changed nothing a caller can see, and every such break teaches the team to update assertions without reading them.",
            "That does not forbid testing private functions. It forbids encoding incidental structure. Ask what a caller could observe, assert exactly that, and let the internal shape move. The exception is a function complex enough that its own contract matters; then test it directly, through the same public surface the caller uses."
          ],
          "list": [
            "One behavior per test: when it fails, the name alone should tell you what broke",
            "Compare whole values with assert_eq! rather than asserting on a field at a time",
            "No sleep, no network, no clock: a unit test that needs those is an integration test",
            "Test the error path, not just the happy path; errors are the code that never runs in demos"
          ]
        },
        {
          "h": "Where unit tests stop paying",
          "p": [
            "Unit tests are cheap and fast because they isolate: no database, no sockets, no serialization boundary. The same isolation is the limit. They cannot tell you that the router is wired to the wrong handler, that the migration does not match the struct, or that two crates disagree about a field name, because all of that is connection, not logic.",
            "The practical split is by cost of the boundary, not by line count. Pure functions, parsers, state machines and arithmetic get unit tests on every branch. Anything crossing a process, a schema or a clock gets an integration test that uses the real dependency, which the next lesson builds."
          ],
          "tip": "If a unit test needs a mock of your own database layer to pass, you are testing the mock. Move it to an integration test with a real Postgres."
        }
      ],
      "exercise": {
        "prompt": "Write the unit tests for a percent clamp: values below 0 become 0, above 100 become 100, and anything else is unchanged. Include the two boundaries and one error-free path, using one assertion style that fails informatively.",
        "starter": "pub fn clamp_percent(value: i32) -> u8 {\n    value.clamp(0, 100) as u8\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn clamps_below_zero() {\n        // assert something here\n    }\n\n    // 2. add the upper boundary\n    // 3. add a value that must not move\n}",
        "hint": "assert_eq!(clamp_percent(-5), 0) reports both sides on failure. Add clamp_percent(250) == 100 and clamp_percent(42) == 42; the three cases together pin the whole function.",
        "solution": "pub fn clamp_percent(value: i32) -> u8 {\n    value.clamp(0, 100) as u8\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn clamps_below_zero_to_zero() {\n        assert_eq!(clamp_percent(-5), 0);\n    }\n\n    #[test]\n    fn clamps_above_hundred_to_hundred() {\n        assert_eq!(clamp_percent(250), 100);\n    }\n\n    #[test]\n    fn leaves_in_range_values_alone() {\n        assert_eq!(clamp_percent(0), 0);\n        assert_eq!(clamp_percent(42), 42);\n        assert_eq!(clamp_percent(100), 100);\n    }\n}"
      },
      "questions": [
        {
          "q": "Why does assert_eq!(parse_duration(\"2s\"), Ok(Millis(2_000))) give a better failure message than assert!(parse_duration(\"2s\").is_ok())?",
          "options": [
            "assert_eq! is faster at runtime",
            "assert_eq! prints both operands and a diff, so a wrong value is visible; assert! only says false",
            "assert! cannot be used with Result values",
            "assert_eq! runs the expression twice to cross-check"
          ],
          "answer": 1,
          "explain": "assert_eq! formats both sides with Debug and shows a diff. The is_ok() version collapses a wrong value and a missing value into the same opaque failure."
        },
        {
          "q": "What does #[cfg(test)] on a module actually do?",
          "options": [
            "Marks the module as a test module for the harness to discover",
            "Compiles the module only when building with the test profile, keeping helpers out of the release binary",
            "Runs the module's functions in parallel with the rest of the suite",
            "Disables optimizations inside the module during tests"
          ],
          "answer": 1,
          "explain": "It is conditional compilation, not a test marker. Discovery comes from #[test]; #[cfg(test)] decides whether the code exists at all in a non-test build."
        },
        {
          "q": "A test returns Result<(), ParseError>. What happens when it returns Err?",
          "options": [
            "The test is skipped",
            "The test fails and the error is reported as the failure reason",
            "The harness panics and stops the whole run",
            "The test passes because no panic occurred"
          ],
          "answer": 1,
          "explain": "The harness treats Err as a failure and prints the Debug form of the error, which makes ? usable for fallible setup without unwrap noise."
        }
      ],
      "quickbytes": [
        "cargo test parse_duration runs only tests whose path contains that substring.",
        "cargo test -- --nocapture shows stdout from passing tests; the harness swallows it by default.",
        "#[should_panic(expected = \"...\")] checks a substring of the panic message; bare #[should_panic] accepts any panic.",
        "Use assert_eq! on whole values so the failure diff shows what actually changed."
      ],
      "production": [
        "Every public function with branching logic has at least one test per error variant, not just the happy path.",
        "Test modules stay behind #[cfg(test)]; nothing test-only leaks into the release binary.",
        "No test sleeps or binds a fixed port; a unit test that does is misfiled and will flake under parallelism.",
        "CI runs the unit suite on every push and fails on warnings from the test profile."
      ],
      "crates": [
        "tokio",
        "anyhow"
      ],
      "github": [
        {
          "name": "rust-lang/rust (test harness and libtest)",
          "url": "https://github.com/rust-lang/rust"
        },
        {
          "name": "tokio-rs/tokio (async test runtime)",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "pitfall": "A test that asserts on the number of calls to a private helper: the refactor that inlines the helper is correct and observable behavior is unchanged, yet the test fails, and the team learns to update assertions without reading them.",
      "resources": [
        {
          "title": "The Rust Book, chapter 11: writing tests",
          "url": "https://doc.rust-lang.org/book/ch11-00-testing.html",
          "kind": "docs"
        },
        {
          "title": "std::assert_eq! macro documentation",
          "url": "https://doc.rust-lang.org/std/macro.assert_eq.html",
          "kind": "docs"
        },
        {
          "title": "The rustc test harness: #[test] and #[should_panic]",
          "url": "https://doc.rust-lang.org/reference/attributes/testing.html",
          "kind": "docs"
        },
        {
          "title": "Jon Gjengset: Rust streams and testing deep dives (YouTube)",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ]
    },
    {
      "id": "i02",
      "n": 2,
      "title": "Integration tests as separate crates",
      "minutes": 60,
      "level": "core",
      "goal": "Structure tests/ so each file is its own crate that exercises only the public API, share helpers without creating empty test binaries, and run one suite by name.",
      "sections": [
        {
          "h": "Every file in tests/ is a crate",
          "p": [
            "Cargo compiles each top-level file in tests/ into its own binary and links it against your library as an external crate. That is the whole point: the test can only see pub items, so a passing integration test proves the API is usable from outside. It also means compile time and link time are paid per file, which is why a hundred tiny test files is slower than ten grouped ones.",
            "Because the crate is external, `use crate::...` does not work and `use my_crate::...` is mandatory. If a test needs a private helper, the helper is not part of the contract yet; either promote it with a documented pub(crate)-plus-feature story or test the behavior through the public surface."
          ],
          "code": "// tests/common/mod.rs — a module, deliberately not a test file\nuse std::net::TcpListener;\n\npub struct TestServer {\n    pub base_url: String,\n    _worker: std::thread::JoinHandle<()>,\n}\n\nimpl TestServer {\n    /// Starts the real service on an ephemeral port.\n    pub fn spawn() -> Self {\n        let listener = TcpListener::bind(\"127.0.0.1:0\").expect(\"ephemeral port\");\n        let addr = listener.local_addr().expect(\"bound address\");\n        let worker = std::thread::spawn(move || {\n            quote_service::serve(listener).expect(\"server exits cleanly\");\n        });\n        Self { base_url: format!(\"http://{addr}\"), _worker: worker }\n    }\n}\n\n// tests/quote_api.rs — its own crate, public API only\nmod common;\n\n#[test]\nfn health_endpoint_answers_ok() {\n    let server = common::TestServer::spawn();\n    let response = reqwest::blocking::get(format!(\"{}/health\", server.base_url))\n        .expect(\"service is listening\");\n    assert_eq!(response.status(), 200);\n    assert_eq!(response.text().unwrap(), \"ok\");\n}",
          "tip": "Bind 127.0.0.1:0 and read back local_addr(). A fixed port is the single most common cause of integration tests that pass alone and fail in CI."
        },
        {
          "h": "tests/common.rs is a trap; tests/common/mod.rs is not",
          "p": [
            "If you put shared helpers in tests/common.rs, Cargo compiles that file as its own test binary too. It runs zero tests, prints a `running 0 tests` line, and links your entire dependency graph for nothing. Naming it tests/common/mod.rs keeps it out of the binary list while `mod common;` in each test file still resolves it.",
            "The other cost of shared helpers is shared state. A helper that creates one database and hands the same pool to every test turns independent tests into an ordered sequence. Prefer a helper that creates an isolated resource per call, even when that means paying a few hundred milliseconds per test."
          ],
          "code": "quote-service/\n├── src/lib.rs\n├── tests/\n│   ├── common/\n│   │   └── mod.rs        # shared helpers, not a test binary\n│   ├── quote_api.rs      # one crate\n│   └── contract.rs       # another crate\n└── Cargo.toml\n\n# run one integration suite only\ncargo test --test quote_api\n\n# list the binaries Cargo would build, including test targets\ncargo test --no-run --message-format=json | jq -r 'select(.reason==\"compiler-artifact\") | .target.name'",
          "tip": "cargo test --test <name> builds and runs exactly one integration binary, which is the fastest loop while iterating on one endpoint."
        },
        {
          "h": "Slow tests: #[ignore] is a schedule, not a skip",
          "p": [
            "Some integration tests are correct but expensive: a full migration round-trip, a container start, a cross-region call. Marking them #[ignore] keeps the default run fast, but the mark only means something if a scheduled job runs them with --ignored. Otherwise the tests rot silently until someone needs them.",
            "The honest alternative is a feature or a nextest profile: `cargo nextest run --profile slow` selects by name filter, while #[ignore] plus a nightly job with --ignored is the zero-tooling version. Either way the rule is the same: every ignored test appears in a pipeline that actually runs it, and the pipeline is green."
          ],
          "list": [
            "Default `cargo test` stays under a minute so it is run before every commit",
            "Ignored tests run nightly with `cargo test -- --ignored`, and failures page someone",
            "Integration tests assert on observable behavior: status codes, rows, files, not internal calls",
            "Each test file gets its own isolated data, even when that costs a container start"
          ]
        }
      ],
      "exercise": {
        "prompt": "A service exposes `serve(listener)` and a GET /health endpoint returning the body `ok`. Write an integration test that starts the service on an ephemeral port and asserts the status and body, without hardcoding a port.",
        "starter": "// tests/health.rs\n\n#[test]\nfn health_endpoint_answers_ok() {\n    // 1. bind 127.0.0.1:0\n    // 2. read local_addr()\n    // 3. spawn serve(listener) on a thread\n    // 4. GET /health and assert status + body\n}",
        "hint": "TcpListener::bind(\"127.0.0.1:0\") then local_addr() gives you a free port. Spawn the server on a std::thread, format the URL, and request it with any blocking HTTP client.",
        "solution": "// tests/health.rs\nuse std::net::TcpListener;\n\n#[test]\nfn health_endpoint_answers_ok() {\n    let listener = TcpListener::bind(\"127.0.0.1:0\").expect(\"ephemeral port\");\n    let addr = listener.local_addr().expect(\"bound address\");\n\n    let worker = std::thread::spawn(move || {\n        quote_service::serve(listener).expect(\"server exits cleanly\");\n    });\n\n    let response = reqwest::blocking::get(format!(\"http://{addr}/health\"))\n        .expect(\"service is listening\");\n    assert_eq!(response.status(), 200);\n    assert_eq!(response.text().unwrap(), \"ok\");\n\n    // The worker thread is detached here; a real harness would send a shutdown\n    // signal and join it, so a failing assertion cannot leak a listener.\n    drop(worker);\n}"
      },
      "questions": [
        {
          "q": "Why does putting shared test helpers in tests/common.rs waste build time?",
          "options": [
            "Cargo refuses to compile files that contain no #[test]",
            "Cargo compiles it as an additional test binary that runs zero tests but still links the full dependency graph",
            "It is compiled twice, once for each test that uses it",
            "It forces the whole test suite into a single binary"
          ],
          "answer": 1,
          "explain": "Every top-level file in tests/ is a target. tests/common/mod.rs is a module reached via `mod common;`, so it never becomes a target of its own."
        },
        {
          "q": "An integration test in tests/ tries `use crate::config::Settings;` and fails to compile. Why?",
          "options": [
            "Settings is private to the library",
            "The test is a separate crate, so the path must be `use quote_service::config::Settings;`",
            "Integration tests cannot import from the library at all",
            "config is not a valid module name in test crates"
          ],
          "answer": 1,
          "explain": "Each tests/ file is linked as an external crate. `crate::` refers to the test crate itself; the library is addressed by its package name, and only pub items are reachable."
        },
        {
          "q": "What makes #[ignore] on an integration test safe rather than a silent skip?",
          "options": [
            "It still runs on every `cargo test` but reports failures as warnings",
            "A scheduled job runs `cargo test -- --ignored`, so the test is executed somewhere green",
            "Cargo warns when an ignored test has not run for 30 days",
            "It is skipped only on CI, and runs locally"
          ],
          "answer": 1,
          "explain": "The attribute is just a filter. Without a pipeline that passes --ignored, the test is dead code that still compiles and can still be wrong."
        }
      ],
      "quickbytes": [
        "cargo test --test quote_api runs exactly one integration binary.",
        "Bind 127.0.0.1:0 and read local_addr() instead of picking a port number.",
        "Put shared helpers in tests/common/mod.rs, never tests/common.rs.",
        "cargo test --no-run compiles the test binaries without running them; useful to check they still build."
      ],
      "production": [
        "Integration tests hit the real HTTP surface and assert status codes and bodies, not internal function calls.",
        "Every test binds an ephemeral port and creates its own data; no test depends on another's leftovers.",
        "A nightly job runs #[ignore]d tests with --ignored and fails loudly.",
        "Test files are grouped by feature so the number of linked binaries stays small."
      ],
      "crates": [
        "reqwest",
        "tokio",
        "serde_json"
      ],
      "github": [
        {
          "name": "rust-lang/cargo (test targets and the tests/ layout)",
          "url": "https://github.com/rust-lang/cargo"
        },
        {
          "name": "nextest-rs/nextest",
          "url": "https://github.com/nextest-rs/nextest"
        }
      ],
      "pitfall": "A shared TestServer started once in a lazy static and reused by every test: one test's rate-limit state or leftover row changes another test's result, and the suite becomes order-dependent.",
      "resources": [
        {
          "title": "The Cargo Book: test targets and the tests directory",
          "url": "https://doc.rust-lang.org/cargo/reference/cargo-targets.html",
          "kind": "docs"
        },
        {
          "title": "The Rust Book: integration tests",
          "url": "https://doc.rust-lang.org/book/ch11-03-test-organization.html",
          "kind": "docs"
        },
        {
          "title": "nextest: a faster test runner with per-test processes",
          "url": "https://github.com/nextest-rs/nextest",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "i03",
      "n": 3,
      "title": "Doc tests: examples that cannot rot",
      "minutes": 50,
      "level": "core",
      "goal": "Turn every public example into a compiled, runnable doc test, and use no_run, compile_fail and should_panic deliberately instead of writing prose that drifts.",
      "sections": [
        {
          "h": "A fenced block in a doc comment is a test",
          "p": [
            "Rustdoc extracts fenced code blocks from /// and //! comments, wraps each in a main function, links the crate, and runs it under `cargo test`. An example that no longer compiles therefore fails the build, which is the only mechanism that keeps documentation honest across a year of refactors. `cargo test --doc` runs just these.",
            "The cost is build time: every doc test is a separate compilation unit against the crate. A crate with four hundred doc tests pays for it on every CI run, which is why heavy examples are marked no_run or moved to a guide. The default is still the right one for anything a user will copy."
          ],
          "code": "use std::num::ParseIntError;\n\n#[derive(Debug, PartialEq, Eq)]\npub enum AddrError {\n    MissingPort,\n    BadPort(ParseIntError),\n}\n\n/// Splits a `host:port` authority into its parts.\n///\n/// # Examples\n///\n/// ```\n/// # use netaddr::{split_authority, AddrError};\n/// # fn main() -> Result<(), AddrError> {\n/// let (host, port) = split_authority(\"example.com:8080\")?;\n/// assert_eq!(host, \"example.com\");\n/// assert_eq!(port, 8080);\n/// # Ok(())\n/// # }\n/// ```\n///\n/// A missing port is an error, not a default:\n///\n/// ```\n/// # use netaddr::{split_authority, AddrError};\n/// assert!(matches!(split_authority(\"example.com\"), Err(AddrError::MissingPort)));\n/// ```\npub fn split_authority(input: &str) -> Result<(&str, u16), AddrError> {\n    let (host, port) = input.rsplit_once(':').ok_or(AddrError::MissingPort)?;\n    let port = port.parse().map_err(AddrError::BadPort)?;\n    Ok((host, port))\n}",
          "tip": "Lines starting with `# ` are hidden from the rendered docs but still compiled. Use them for imports and the `fn main() -> Result` wrapper so the visible example stays short."
        },
        {
          "h": "Four attributes, four intents",
          "p": [
            "no_run compiles and links the example but does not execute it, which is right for code that opens a socket or needs credentials. ignore skips both compile and run and is almost always a documentation bug: the example is not verified by anything. compile_fail asserts that the snippet does not compile, and should_panic asserts that it panics.",
            "compile_fail is the one people forget. A doc comment claiming \"this fails to compile because the borrow checker rejects it\" is only trustworthy if the compiler is asked to reject it. Without the attribute, a change that makes the snippet compile turns a teaching example into a lie that nobody notices."
          ],
          "code": "/// ```no_run\n/// # use sqlx::PgPool;\n/// # fn main() -> Result<(), sqlx::Error> {\n/// // Compiles, never runs: needs a live database.\n/// let pool = PgPool::connect(\"postgres://localhost/app\")?;\n/// # drop(pool);\n/// # Ok(())\n/// # }\n/// ```\n///\n/// ```compile_fail\n/// // This must NOT compile: the value is moved twice.\n/// let name = String::from(\"ferris\");\n/// let a = name;\n/// let b = name;\n/// ```\n///\n/// ```should_panic\n/// let v: Vec<u8> = Vec::new();\n/// let _ = v[0]; // index out of bounds\n/// ```\npub fn documented_behaviors() {}",
          "tip": "`ignore` is a debt marker. If an example cannot compile, either fix it, mark it no_run, or move it into a prose guide where it is not pretending to be code."
        },
        {
          "h": "Doc tests are also your best API review",
          "p": [
            "Writing the example first forces you to use the function the way a stranger would. If the example needs six lines of setup, three imports and a turbofish, the API is awkward, and you found that out before shipping instead of in a support ticket. This is the cheapest usability test that exists.",
            "One trap: doc tests run as separate binaries and do not share state, so an example that depends on another example's side effects will fail in ways that look random. Keep each block self-contained, and give it a hidden main when it needs `?`."
          ],
          "list": [
            "Every public item with a non-obvious contract gets at least one example",
            "Examples use `?` with a hidden `fn main() -> Result<(), E>` wrapper",
            "no_run for I/O, credentials and long-running servers; ignore almost never",
            "compile_fail for every \"this will not compile\" claim in the docs"
          ]
        }
      ],
      "exercise": {
        "prompt": "Add doc tests to a `parse_port` function: one runnable example showing the happy path with `?`, one showing the error case, and one compile_fail block proving that passing an integer where a &str is expected is rejected.",
        "starter": "pub fn parse_port(input: &str) -> Result<u16, std::num::ParseIntError> {\n    input.parse()\n}\n\n/// Parses a decimal port number.\n///\n/// # Examples\n///\n/// ```\n/// // 1. happy path, using ? inside a hidden main\n/// ```\n///\n/// ```\n/// // 2. error case: \"99999\" does not fit in u16\n/// ```\n///\n/// ```\n/// // 3. compile_fail: parse_port(8080)\n/// ```\npub fn documented() {}",
        "hint": "Wrap the `?` example with `# fn main() -> Result<(), std::num::ParseIntError> { ... # Ok(()) # }`. For the failure case assert is_err(). For the compile_fail block call parse_port(8080) — it must not type-check.",
        "solution": "pub fn parse_port(input: &str) -> Result<u16, std::num::ParseIntError> {\n    input.parse()\n}\n\n/// Parses a decimal port number.\n///\n/// # Examples\n///\n/// ```\n/// # use ports::parse_port;\n/// # fn main() -> Result<(), std::num::ParseIntError> {\n/// assert_eq!(parse_port(\"8080\")?, 8080);\n/// # Ok(())\n/// # }\n/// ```\n///\n/// Out-of-range values are rejected by the type, not silently truncated:\n///\n/// ```\n/// # use ports::parse_port;\n/// assert!(parse_port(\"99999\").is_err());\n/// ```\n///\n/// The argument is text, not a number:\n///\n/// ```compile_fail\n/// # use ports::parse_port;\n/// let _ = parse_port(8080);\n/// ```\npub fn documented() {}"
      },
      "questions": [
        {
          "q": "What does a doc test with the `no_run` attribute do?",
          "options": [
            "Skips compilation and execution entirely",
            "Compiles and links the example but does not execute it",
            "Executes the example but ignores its exit status",
            "Runs the example only on the nightly toolchain"
          ],
          "answer": 1,
          "explain": "no_run keeps the compile-time guarantee, which is the part that catches API drift, while skipping side effects like opening a socket or requiring credentials."
        },
        {
          "q": "A doc comment says a snippet fails to compile. Which attribute makes that claim testable?",
          "options": [
            "should_panic",
            "no_run",
            "compile_fail",
            "ignore"
          ],
          "answer": 2,
          "explain": "compile_fail asserts the snippet is rejected by the compiler. Without it, a snippet that starts compiling passes silently and the teaching claim becomes false."
        },
        {
          "q": "Why does a doc test that uses `?` usually need a hidden `fn main() -> Result<(), E>`?",
          "options": [
            "Rustdoc cannot parse the ? operator",
            "The default wrapper is `fn main()` with no return type, and ? requires a function that returns Result",
            "? is only allowed inside #[test] functions",
            "Hidden lines are required for any doctest that imports something"
          ],
          "answer": 1,
          "explain": "Rustdoc wraps the block in a main with unit return, so `?` has nothing to propagate into. A hidden main returning Result, ending in a hidden `Ok(())`, restores it."
        }
      ],
      "quickbytes": [
        "cargo test --doc runs only documentation tests.",
        "`# ` at the start of a line hides it from rendered docs but keeps it compiled.",
        "cargo test --doc -- --show-output prints output from passing examples.",
        "RUSTDOCFLAGS=\"-D warnings\" fails the build on broken intra-doc links as well."
      ],
      "production": [
        "Every public function has at least one runnable example, not a prose description of one.",
        "no_run is used for anything touching I/O, credentials or a server; ignore is treated as a bug.",
        "The README's main example is included with #![doc = include_str!(\"../README.md\")] so it is tested too.",
        "CI runs cargo test --doc separately so a doc failure is not buried in the unit-test output."
      ],
      "crates": [
        "serde",
        "sqlx"
      ],
      "github": [
        {
          "name": "rust-lang/rust (rustdoc and doc tests)",
          "url": "https://github.com/rust-lang/rust"
        },
        {
          "name": "rust-lang/mdBook",
          "url": "https://github.com/rust-lang/mdBook"
        }
      ],
      "pitfall": "An example marked `ignore` because it needed a database: it stops being compiled, the API it demonstrates is renamed six months later, and the only user-facing sample for that function is now wrong.",
      "resources": [
        {
          "title": "The rustdoc book: documentation tests",
          "url": "https://doc.rust-lang.org/rustdoc/write-documentation/documentation-tests.html",
          "kind": "docs"
        },
        {
          "title": "The rustdoc book: controlling how tests are run",
          "url": "https://doc.rust-lang.org/rustdoc/write-documentation/documentation-tests.html#attributes",
          "kind": "docs"
        },
        {
          "title": "Rust by Example: documentation testing",
          "url": "https://doc.rust-lang.org/rust-by-example/testing/doc_testing.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "i04",
      "n": 4,
      "title": "Property-based testing with proptest",
      "minutes": 85,
      "level": "advanced",
      "goal": "State invariants as properties, generate inputs with proptest strategies, and use shrinking to turn a random failure into a minimal counterexample.",
      "sections": [
        {
          "h": "Examples check one input; properties check all of them",
          "p": [
            "A property says something holds for every input in a domain: decode(encode(x)) == x, sorting is idempotent, a transfer never creates money. proptest generates inputs from a strategy, runs a few hundred cases, and on failure shrinks the input toward the smallest value that still fails. The shrunk counterexample is the output that matters; it is usually three lines long and immediately readable.",
            "The trade-off is the oracle problem. A property is only as strong as the second implementation you compare against, and a property that restates the implementation is a tautology. The good ones come from algebra (associativity, identity, round-trip), from domain rules (balances are conserved), and from differential comparison against a slow but obviously correct version."
          ],
          "code": "use proptest::prelude::*;\n\n#[derive(Debug, Clone, PartialEq, Eq)]\npub struct Frame {\n    pub payload: Vec<u8>,\n}\n\nfn encode(frame: &Frame) -> Vec<u8> {\n    let mut out = Vec::with_capacity(frame.payload.len() + 4);\n    out.extend_from_slice(&(frame.payload.len() as u32).to_be_bytes());\n    out.extend_from_slice(&frame.payload);\n    out\n}\n\nfn decode(bytes: &[u8]) -> Result<Frame, &'static str> {\n    if bytes.len() < 4 {\n        return Err(\"short header\");\n    }\n    let len = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;\n    let payload = bytes.get(4..4 + len).ok_or(\"truncated payload\")?;\n    Ok(Frame { payload: payload.to_vec() })\n}\n\nproptest! {\n    #[test]\n    fn roundtrip_preserves_payload(payload in prop::collection::vec(any::<u8>(), 0..4096)) {\n        let frame = Frame { payload };\n        let decoded = decode(&encode(&frame)).expect(\"encoder output must decode\");\n        prop_assert_eq!(decoded, frame);\n    }\n\n    #[test]\n    fn decoder_never_panics(bytes in prop::collection::vec(any::<u8>(), 0..4096)) {\n        // Ok or Err are both fine; a panic or an infinite loop is not.\n        let _ = decode(&bytes);\n    }\n}",
          "tip": "Commit proptest-regressions/ to version control. A failing seed is worthless if the next run does not replay it."
        },
        {
          "h": "Strategies: constrain the domain, do not filter it",
          "p": [
            "any::<T>() covers the type, which is rarely the domain. A port must be 1..=65535, a currency amount must be a multiple of the minor unit, an order id must be non-empty. Build these with ranges, prop::collection::vec, prop::option and prop_compose!, or derive Arbitrary when the type is simple enough that the derived strategy is the one you want to test.",
            "The tempting shortcut is filtering with prop_assume!. Each rejection throws away a case, and proptest gives up after too many global rejects, reporting a test failure that is really a bad strategy. If the generator cannot produce valid inputs directly, write a constructor that returns them by construction: generate a valid state instead of generating anything and rejecting most of it."
          ],
          "code": "use proptest::prelude::*;\n\n#[derive(Debug, Clone)]\npub struct Transfer {\n    pub amount_cents: i64,\n    pub from: u32,\n    pub to: u32,\n}\n\nprop_compose! {\n    /// Any transfer that a validator should accept: positive amount,\n    /// distinct accounts, amount bounded by a realistic ceiling.\n    pub fn valid_transfer()(amount_cents in 1i64..=1_000_000, from in 1u32..10_000, delta in 1u32..10_000)\n        (amount_cents in Just(amount_cents), from in Just(from), to in Just(from + delta))\n        -> Transfer {\n        Transfer { amount_cents, from, to }\n    }\n}\n\nproptest! {\n    #[test]\n    fn accepted_transfers_preserve_total(t in valid_transfer()) {\n        let before = 1_000_000i64;\n        let after = apply(before, &t);\n        prop_assert_eq!(before, after); // conservation: no money created\n    }\n}\n\nfn apply(total: i64, t: &Transfer) -> i64 {\n    total - t.amount_cents + t.amount_cents\n}",
          "tip": "If a property needs prop_assume!, the strategy is wrong. Restructure the generator so every case is valid by construction."
        },
        {
          "h": "Choosing properties that actually find bugs",
          "p": [
            "The properties with the best hit rate are: round-trip (encode/decode, serialize/parse), invariants (sum preserved, sorted order, no duplicate ids), idempotence (applying twice equals applying once), and oracle comparison against a naive implementation. Metamorphic properties work when no oracle exists: adding an item to a cart must never lower the total.",
            "Run counts matter less than you think. proptest defaults to 256 cases per property, which catches shallow bugs in seconds; deep stateful bugs need state-machine testing, where proptest generates sequences of operations and checks invariants after each step. Reach for that only after simple properties are green, because it multiplies runtime by sequence length."
          ],
          "list": [
            "Round-trip: decode(encode(x)) == x, including empty and maximal inputs",
            "Invariant: a property that must hold before and after every operation",
            "Idempotence: f(f(x)) == f(x) for retries, dedupe and normalization",
            "Differential: compare against a slow reference implementation you trust"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write two proptest properties for a `normalize_email` function that trims whitespace and lowercases: one asserting idempotence, one asserting that the output never contains uppercase ASCII or surrounding whitespace.",
        "starter": "pub fn normalize_email(input: &str) -> String {\n    input.trim().to_ascii_lowercase()\n}\n\nuse proptest::prelude::*;\n\nproptest! {\n    #[test]\n    fn normalize_is_idempotent(input in \".*\") {\n        // normalize(normalize(input)) == normalize(input)\n    }\n\n    #[test]\n    fn output_is_canonical(input in \".*\") {\n        // no uppercase, no leading/trailing whitespace\n    }\n}",
        "hint": "Call normalize twice and compare with prop_assert_eq!. For the second property, assert that the result equals its trimmed lowercase form, and that it contains no ASCII uppercase byte.",
        "solution": "pub fn normalize_email(input: &str) -> String {\n    input.trim().to_ascii_lowercase()\n}\n\nuse proptest::prelude::*;\n\nproptest! {\n    #[test]\n    fn normalize_is_idempotent(input in \".*\") {\n        let once = normalize_email(&input);\n        let twice = normalize_email(&once);\n        prop_assert_eq!(once, twice);\n    }\n\n    #[test]\n    fn output_is_canonical(input in \".*\") {\n        let out = normalize_email(&input);\n        prop_assert!(!out.chars().any(|c| c.is_ascii_uppercase()));\n        prop_assert_eq!(out.trim(), out.as_str());\n    }\n}"
      },
      "questions": [
        {
          "q": "What does shrinking give you after a property fails?",
          "options": [
            "A different random seed to retry the test",
            "A minimal input that still fails, so the counterexample is readable",
            "A smaller test binary that runs faster",
            "A reduced number of cases for the next run"
          ],
          "answer": 1,
          "explain": "proptest re-runs the failing case with progressively simpler inputs and reports the smallest one that still fails, which is usually the actual bug's trigger."
        },
        {
          "q": "A property uses prop_assume!(input.len() > 1000) and the run ends with a 'too many global rejects' failure. What is the fix?",
          "options": [
            "Increase PROPTEST_CASES so enough valid inputs appear",
            "Generate inputs that satisfy the constraint by construction, e.g. a vec with a 1001.. range",
            "Disable shrinking with ProptestConfig::default().shrink_timeout",
            "Wrap the property in catch_unwind"
          ],
          "answer": 1,
          "explain": "Rejection-based filtering wastes generated cases and eventually trips the global reject limit. A strategy whose domain is already valid removes the filtering entirely."
        },
        {
          "q": "Which property is weakest, because it restates the implementation?",
          "options": [
            "decode(encode(x)) == x for a codec",
            "sort(sort(x)) == sort(x)",
            "fn add(a, b) returns a + b",
            "the sum of a cart's line items equals the cart total"
          ],
          "answer": 2,
          "explain": "A property that repeats the body of the function cannot fail unless the body changes. Properties need an independent source of truth: algebra, a reference implementation, or a domain invariant."
        }
      ],
      "quickbytes": [
        "Commit proptest-regressions/ so a found seed is replayed forever.",
        "PROPTEST_CASES=4096 cargo test --release trades minutes for deeper coverage.",
        "prop_assert_eq! reports the shrunk inputs; plain assert_eq! loses the context proptest adds.",
        "Prefer generators that are valid by construction over prop_assume! filters."
      ],
      "production": [
        "At least one property per codec: round-trip with empty, maximal and adversarial payloads.",
        "Strategies live next to the type they generate and are reused across tests.",
        "proptest-regressions/ is committed and reviewed like any other test asset.",
        "Release-mode property runs are part of the nightly job; debug-mode runs cover every PR."
      ],
      "crates": [
        "proptest",
        "arbitrary",
        "serde_json"
      ],
      "github": [
        {
          "name": "proptest-rs/proptest",
          "url": "https://github.com/proptest-rs/proptest"
        },
        {
          "name": "BurntSushi/quickcheck",
          "url": "https://github.com/BurntSushi/quickcheck"
        }
      ],
      "pitfall": "A property that only generates small valid inputs: the off-by-one at the buffer boundary and the overflow at i64::MAX never appear, so the suite is green and the production bug ships.",
      "resources": [
        {
          "title": "proptest crate documentation",
          "url": "https://docs.rs/proptest/latest/proptest/",
          "kind": "docs"
        },
        {
          "title": "proptest::arbitrary: deriving strategies for your types",
          "url": "https://docs.rs/proptest/latest/proptest/arbitrary/index.html",
          "kind": "docs"
        },
        {
          "title": "QuickCheck: a lightweight tool for random testing of Haskell programs (ICFP 2000)",
          "url": "https://dl.acm.org/doi/10.1145/351240.351266",
          "kind": "paper"
        },
        {
          "title": "proptest repository and examples",
          "url": "https://github.com/proptest-rs/proptest",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "i05",
      "n": 5,
      "title": "Fuzzing with cargo-fuzz and arbitrary",
      "minutes": 90,
      "level": "advanced",
      "goal": "Build a coverage-guided fuzz target for a parser, keep it fed with a committed corpus, and turn a crash artifact into a regression test.",
      "sections": [
        {
          "h": "A fuzzer is a property test with a coverage map",
          "p": [
            "libFuzzer mutates a byte buffer, runs the target, and keeps mutations that reach new coverage. That feedback loop finds the inputs a generator never produces: truncated headers, length fields that disagree with the payload, deeply nested structures. cargo-fuzz wraps libFuzzer in a cargo subcommand, so the target is a normal Rust binary compiled with instrumentation.",
            "The target must be total: it may return Err, but it may not panic, abort, or hang. In a library crate, panics are usually reachable from public APIs on malformed input, which is exactly what the fuzzer is there to find. `fuzz_target!` takes a closure over the raw bytes, and `arbitrary` turns those bytes into structured values when you want to fuzz past the parser."
          ],
          "code": "# Cargo.toml for the fuzz crate (created by `cargo fuzz init`)\n[package]\nname = \"parser-fuzz\"\nversion = \"0.0.0\"\npublish = false\n\n[package.metadata]\ncargo-fuzz = true\n\n[dependencies]\nlibfuzzer-sys = \"0.4\"\narbitrary = { version = \"1\", features = [\"derive\"] }\nmy_parser = { path = \"..\" }\n\n[[bin]]\nname = \"parse_header\"\npath = \"fuzz_targets/parse_header.rs\"\ntest = false\ndoc = false\nbench = false\n\n# fuzz/fuzz_targets/parse_header.rs\n#![no_main]\n\nuse arbitrary::Arbitrary;\nuse libfuzzer_sys::fuzz_target;\n\n#[derive(Debug, Arbitrary)]\nstruct Header<'a> {\n    name: &'a str,\n    value: &'a str,\n}\n\nfuzz_target!(|header: Header<'_>| {\n    // Must not panic and must not allocate without bound.\n    if let Ok(parsed) = my_parser::parse_header(header.name, header.value) {\n        let rendered = parsed.to_string();\n        assert!(my_parser::parse_header_line(&rendered).is_ok());\n    }\n});",
          "tip": "Start with `fuzz_target!(|data: &[u8]|)` over the raw parser entry point. Add `arbitrary` only when byte-level mutations stop reaching interesting states."
        },
        {
          "h": "The loop: run, minimize, regress, commit",
          "p": [
            "Run the target with a time budget in CI and interactively while you work. A crash writes an artifact under fuzz/artifacts/<target>/; `cargo fuzz tmin` shrinks it to the smallest input that still crashes, and that file goes into the corpus so the same crash is found in milliseconds on every later run. The regression test is a plain #[test] that feeds the artifact bytes to the parser.",
            "Corpus discipline is what separates a fuzz suite from a toy. Commit fuzz/corpus/<target>/ (it stays small because libFuzzer deduplicates by coverage), and seed it with real samples: captured requests, golden files, and every artifact ever found. A corpus that starts empty rediscovers the same trivial paths on every run."
          ],
          "code": "# scaffold: creates fuzz/ with a Cargo.toml and one target\ncargo install cargo-fuzz\ncargo fuzz init\ncargo fuzz add parse_header\n\n# interactive: runs until you stop it\ncargo fuzz run parse_header\n\n# CI: bounded time, no leak detection surprises, corpus in the repo\ncargo fuzz run parse_header fuzz/corpus/parse_header \\\n  -- -max_total_time=120 -rss_limit_mb=2048 -print_final_stats=1\n\n# minimize a crash, then keep the result as a seed\ncargo fuzz tmin parse_header fuzz/artifacts/parse_header/crash-<hash>\n\n# coverage report for the target\ncargo fuzz coverage parse_header",
          "tip": "Nightly is required: cargo-fuzz builds with -Z sanitizer=address. Pin the toolchain in rust-toolchain.toml so the fuzz job and the normal build cannot drift."
        },
        {
          "h": "What fuzzing does not cover",
          "p": [
            "A fuzzer proves the absence of panics and hangs on the inputs it explored; it does not prove correctness. A parser that returns the wrong value for every input will never crash, and a fuzz target with an `assert!(result.is_ok())` on an API that legitimately returns Err will spend its budget reporting a false positive.",
            "It also struggles with state: an API that requires login, a cursor or a valid checksum needs a harness that constructs that state from the input bytes. That is when `arbitrary` earns its place, and when you should consider a stateful fuzzer instead of pretending a stateless target covers the protocol."
          ],
          "list": [
            "Panics, aborts, integer overflow in debug builds and unbounded allocation are the fuzzer's real targets",
            "A crash artifact becomes a committed seed and a unit test, or it will come back",
            "Cap input size: a parser that allocates 4 GB from a length field is a denial of service, not a curiosity",
            "Fuzz the public entry point, not a private helper the public API cannot reach"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a fuzz target for `parse_header_line(&str) -> Result<Header, ParseError>` that never panics, and add the corpus directory to the run command with a 60-second budget.",
        "starter": "// fuzz/fuzz_targets/parse_header_line.rs\n#![no_main]\n\nuse libfuzzer_sys::fuzz_target;\n\nfuzz_target!(|data: &[u8]| {\n    // 1. only feed valid UTF-8 to the &str API\n    // 2. call the parser and ignore Ok/Err\n    // 3. do not unwrap\n});",
        "hint": "Use std::str::from_utf8(data) and return early on Err. Then call the parser and discard the result: the property is 'no panic, no hang', not 'always Ok'.",
        "solution": "// fuzz/fuzz_targets/parse_header_line.rs\n#![no_main]\n\nuse libfuzzer_sys::fuzz_target;\n\nfuzz_target!(|data: &[u8]| {\n    let Ok(line) = std::str::from_utf8(data) else {\n        return; // the API takes &str, so invalid UTF-8 is out of scope\n    };\n\n    // Ok or Err are both acceptable outcomes. A panic, an abort or a hang\n    // is the bug this target exists to find.\n    let _ = my_parser::parse_header_line(line);\n});\n\n// CI invocation:\n// cargo fuzz run parse_header_line fuzz/corpus/parse_header_line \\\n//   -- -max_total_time=60 -rss_limit_mb=2048"
      },
      "questions": [
        {
          "q": "Why does a fuzz target usually return early on invalid UTF-8 when the API takes &str?",
          "options": [
            "Invalid UTF-8 makes libFuzzer crash",
            "The API cannot receive those bytes, so exploring them wastes the coverage budget",
            "from_utf8 is undefined behavior on invalid input",
            "cargo-fuzz rejects non-UTF-8 corpus files"
          ],
          "answer": 1,
          "explain": "Fuzzing should exercise reachable states. If the only way into the function is a &str, invalid bytes can never occur in production and each one is a wasted execution."
        },
        {
          "q": "What is the purpose of committing fuzz/corpus/<target>/ to the repository?",
          "options": [
            "It stores crash reports for the issue tracker",
            "It preserves coverage-increasing inputs so later runs start from known interesting states",
            "It is required for cargo fuzz to compile the target",
            "It replaces the need for regression tests"
          ],
          "answer": 1,
          "explain": "libFuzzer deduplicates the corpus by coverage, so it stays small. Starting from an empty corpus means rediscovering the same paths on every run."
        },
        {
          "q": "A fuzz target runs for an hour with no crashes. What have you proven?",
          "options": [
            "The parser is correct for all inputs",
            "No panic, abort or hang was found on the explored inputs",
            "The parser handles every malformed input the protocol allows",
            "Nothing, because libFuzzer only finds memory-safety bugs"
          ],
          "answer": 1,
          "explain": "Fuzzing is a search, not a proof. It gives evidence about crashes and hangs on explored inputs; it says nothing about wrong-but-total results."
        }
      ],
      "quickbytes": [
        "cargo fuzz tmin <target> <artifact> shrinks a crash to a minimal reproducer.",
        "RUSTFLAGS must not be set when running cargo fuzz; it needs its own sanitizer flags.",
        "Keep -rss_limit_mb set so an allocation bug is reported as OOM instead of taking down the runner.",
        "Nightly is mandatory: cargo-fuzz needs -Zsanitizer=address."
      ],
      "production": [
        "Every parser and decoder in the public API has a fuzz target with a committed corpus.",
        "CI runs each target for a bounded time on every PR and a longer budget nightly.",
        "Crash artifacts are minimized, committed as seeds, and covered by a plain unit test.",
        "The fuzz toolchain is pinned in rust-toolchain.toml so sanitizer and stable builds do not drift."
      ],
      "crates": [
        "libfuzzer-sys",
        "arbitrary",
        "cargo-fuzz"
      ],
      "github": [
        {
          "name": "rust-fuzz/cargo-fuzz",
          "url": "https://github.com/rust-fuzz/cargo-fuzz"
        },
        {
          "name": "rust-fuzz/arbitrary",
          "url": "https://github.com/rust-fuzz/arbitrary"
        }
      ],
      "pitfall": "A target that asserts every result is Ok: the fuzzer spends its budget on inputs the parser is supposed to reject, and the actual panic inside the error path is never reached.",
      "resources": [
        {
          "title": "libfuzzer-sys crate documentation",
          "url": "https://docs.rs/libfuzzer-sys/latest/libfuzzer_sys/",
          "kind": "docs"
        },
        {
          "title": "arbitrary crate documentation",
          "url": "https://docs.rs/arbitrary/latest/arbitrary/",
          "kind": "docs"
        },
        {
          "title": "cargo-fuzz repository",
          "url": "https://github.com/rust-fuzz/cargo-fuzz",
          "kind": "repo"
        },
        {
          "title": "libFuzzer source in the LLVM monorepo",
          "url": "https://github.com/llvm/llvm-project",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "i06",
      "n": 6,
      "title": "Mutation testing: do your assertions bite?",
      "minutes": 75,
      "level": "advanced",
      "goal": "Use cargo-mutants to find assertions that cannot fail, triage survivors into real gaps versus equivalent mutants, and gate pull requests on the diff only.",
      "sections": [
        {
          "h": "A mutant is a bug the compiler agrees to compile",
          "p": [
            "Mutation testing edits your source mechanically: >= becomes >, && becomes ||, a returned value becomes Default::default(), a subtraction becomes an addition. Then it runs your tests. If the suite still passes, the mutant survived, which means no assertion distinguished the real code from broken code. That is a much sharper statement than line coverage, which only records that a line executed.",
            "Coverage and mutation testing answer different questions. Coverage asks whether a line ran; mutation testing asks whether running it changed any observable outcome. A test that calls a function and asserts nothing gives you full line coverage and a mutation score of zero, and the mutation score is the one that predicts escaped defects."
          ],
          "code": "// Original implementation.\npub fn discount(total_cents: u64, is_member: bool) -> u64 {\n    if is_member && total_cents >= 10_000 {\n        total_cents - total_cents / 10\n    } else {\n        total_cents\n    }\n}\n\n// Mutants cargo-mutants will try against this function:\n//   `>= 10_000`  ->  `> 10_000`   survives unless a test uses exactly 10_000\n//   `&&`         ->  `||`         survives unless a non-member above the threshold is tested\n//   `-`          ->  `+`          survives if tests never assert the returned value\n//   `/ 10`       ->  `/ 1`        survives if the discount amount is never checked\n\n#[test]\nfn member_at_exact_threshold_gets_ten_percent_off() {\n    // Kills both the >= -> > mutant and the - -> + mutant.\n    assert_eq!(discount(10_000, true), 9_000);\n}\n\n#[test]\nfn non_member_above_threshold_pays_full_price() {\n    // Kills the && -> || mutant.\n    assert_eq!(discount(10_000, false), 10_000);\n}",
          "tip": "Mutants are generated from your source, so run this on a clean tree. A dirty working copy makes the reported diff line numbers lie."
        },
        {
          "h": "Running it without burning a day",
          "p": [
            "Every mutant needs a full test run, so the cost is mutants times suite duration. A 40-second suite against 300 mutants is three hours of CPU, which is fine on a nightly machine and unacceptable in a pull-request check. The practical split: nightly runs everything, and the PR gate runs only mutants inside the changed lines.",
            "The `--in-diff` flag reads a unified diff and mutates only the touched code, which typically cuts a PR run to a handful of mutants. Parallelism (`-j`) and a per-mutant timeout keep a hanging test from stalling the run; a mutant that makes tests hang is reported as a timeout, and that is itself a finding about missing timeouts."
          ],
          "code": "# install the tool (binary, not a library dependency)\ncargo install cargo-mutants\n\n# see what would be mutated, without running anything\ncargo mutants --list\n\n# full run: every mutant, 8 in parallel, 60 s budget per mutant\ncargo mutants -j 8 --timeout 60\n\n# pull-request gate: only mutants in lines this branch changed\ngit diff origin/main...HEAD > /tmp/pr.diff\ncargo mutants --in-diff /tmp/pr.diff -j 8 --timeout 60\n\n# nightly: full run, machine-readable output for a dashboard\ncargo mutants --json > mutants.json",
          "tip": "A run that ends with survived mutants exits non-zero, which is what lets CI fail the job. Print the missed-mutant list in the job summary so the author sees the exact line."
        },
        {
          "h": "Triage: three kinds of survivor",
          "p": [
            "Some survivors are real gaps: nobody tested the exact boundary, or nobody asserted the returned value. Fix them with an assertion, not with an exclusion. Some are equivalent mutants: the mutated code computes the same result for every input, so no test can ever kill it, for example replacing a sort with a stable sort on a key that is already unique. Those get an exclusion with a comment explaining why.",
            "The third kind is the interesting one: a survivor that reveals a missing specification. If replacing a multiplication with addition still passes, maybe the test data only uses 0 and 1. The fix is better data, and the survivor just told you where your examples were degenerate. Aim for a high score on changed code rather than a perfect score everywhere; chasing 100% globally means writing tests for equivalent mutants."
          ],
          "list": [
            "Missed: a real assertion gap, fix the test",
            "Caught: the suite noticed, which is the healthy case",
            "Unviable: the mutant did not compile, neither good nor bad",
            "Timeout: the mutant made tests hang, check for missing timeouts",
            "Equivalent: no test can kill it, exclude it with a written reason"
          ]
        }
      ],
      "exercise": {
        "prompt": "This function has two tests and both pass. Predict which mutants survive, then add the minimum assertions that kill the boundary mutant and the arithmetic mutant.",
        "starter": "pub fn shipping_cents(weight_grams: u32) -> u32 {\n    if weight_grams > 1000 {\n        500 + (weight_grams - 1000) / 100 * 10\n    } else {\n        500\n    }\n}\n\n#[test]\nfn heavy_parcel_costs_more() {\n    assert!(shipping_cents(2000) > shipping_cents(500));\n}\n\n// 1. which mutants survive?\n// 2. add exact-value assertions for 1000 g and 2000 g",
        "hint": "`>` -> `>=` survives because nothing tests exactly 1000. The `+` and `/` mutants survive because the test only compares with >. Add assert_eq!(shipping_cents(1000), 500) and assert_eq!(shipping_cents(2000), 600).",
        "solution": "pub fn shipping_cents(weight_grams: u32) -> u32 {\n    if weight_grams > 1000 {\n        500 + (weight_grams - 1000) / 100 * 10\n    } else {\n        500\n    }\n}\n\n#[test]\nfn at_the_boundary_shipping_is_flat() {\n    // Kills `>` -> `>=`.\n    assert_eq!(shipping_cents(1000), 500);\n}\n\n#[test]\nfn heavy_parcel_is_flat_fee_plus_per_100g() {\n    // 500 base + (1000 / 100) * 10 = 600. Kills `+` -> `-` and `/ 100` -> `/ 1`.\n    assert_eq!(shipping_cents(2000), 600);\n}\n\n#[test]\nfn just_over_the_boundary_adds_one_step() {\n    // Kills off-by-one in the subtraction.\n    assert_eq!(shipping_cents(1100), 510);\n}"
      },
      "questions": [
        {
          "q": "A function has 100% line coverage but a mutation score of 20%. What does that combination mean?",
          "options": [
            "The tests are slow and skip some mutants",
            "Every line runs, but most broken variants still pass, so assertions are weak",
            "The mutator is broken and reports false survivors",
            "The function is too simple to mutate"
          ],
          "answer": 1,
          "explain": "Line coverage proves execution; mutation score proves detection. A high-coverage, low-score suite calls code and checks little, which is exactly the pattern that lets regressions through."
        },
        {
          "q": "Why does the pull-request job use cargo mutants --in-diff instead of a full run?",
          "options": [
            "Full runs cannot run in CI",
            "--in-diff mutates only changed lines, so the PR check costs seconds instead of hours",
            "It skips mutants that are equivalent",
            "It runs the tests in parallel while a full run cannot"
          ],
          "answer": 1,
          "explain": "Cost scales with mutants times suite duration. Restricting to the diff keeps the PR feedback loop usable; the exhaustive run belongs on a nightly job."
        },
        {
          "q": "What is an equivalent mutant?",
          "options": [
            "A mutant that fails to compile",
            "A mutant whose behaviour is identical to the original for every input, so no test can distinguish it",
            "A mutant that only differs in formatting",
            "A mutant that survives because the test timed out"
          ],
          "answer": 1,
          "explain": "It is semantically identical to the original. Excluding it with a comment is correct; writing a test to kill it is impossible."
        }
      ],
      "quickbytes": [
        "cargo mutants --list shows the mutants without running them; use it to estimate cost.",
        "cargo mutants -j 8 --timeout 60 bounds both wall time and hanging mutants.",
        "A survived mutant on a boundary usually means no test uses the exact boundary value.",
        "Run mutation testing on changed code per PR, everything nightly."
      ],
      "production": [
        "The PR gate mutates only changed lines; a nightly job runs the full suite and publishes the score.",
        "Every exclusion in the mutants config carries a comment naming the equivalent mutant.",
        "New code is expected to reach a high mutation score on the diff, not just line coverage.",
        "Survivors are triaged within the same sprint, or the score decays and the gate gets disabled."
      ],
      "crates": [
        "cargo-mutants",
        "cargo-nextest"
      ],
      "github": [
        {
          "name": "sourcefrog/cargo-mutants",
          "url": "https://github.com/sourcefrog/cargo-mutants"
        }
      ],
      "pitfall": "Chasing a 100% mutation score across an old crate: the last ten percent is equivalent mutants, and the team spends weeks writing tests that can never fail while real gaps in new code stay unmeasured.",
      "resources": [
        {
          "title": "cargo-mutants: inject bugs and see if your tests catch them",
          "url": "https://github.com/sourcefrog/cargo-mutants",
          "kind": "repo"
        },
        {
          "title": "cargo-mutants book: the --in-diff workflow",
          "url": "https://github.com/sourcefrog/cargo-mutants/blob/main/book/src/in-diff.md",
          "kind": "docs"
        },
        {
          "title": "cargo-mutants on crates.io",
          "url": "https://crates.io/crates/cargo-mutants",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "i07",
      "n": 7,
      "title": "Snapshot testing with insta",
      "minutes": 65,
      "level": "advanced",
      "goal": "Review large expected values as files instead of hand-writing them, redact the non-deterministic parts, and keep snapshot approval out of CI's hands.",
      "sections": [
        {
          "h": "The expected value is a file you review",
          "p": [
            "insta stores the expectation next to the test as a .snap file. The first run writes a .snap.new, the test fails, and `cargo insta review` shows a diff you accept or reject. That turns the awkward part of testing a big JSON payload, a rendered report or a generated config from hand-typing the expected output into approving a diff, which is the same skill as reviewing code.",
            "The macro family matters: assert_snapshot! for Display output, assert_debug_snapshot! for Debug, assert_json_snapshot! for serde types. Inline snapshots, where the expected value is an at-sign string literal right in the source, keep small expectations close to the assertion, which is right for a two-line value and wrong for a two-hundred-line one."
          ],
          "code": "use insta::assert_json_snapshot;\nuse serde_json::json;\n\n#[test]\nfn order_payload_shape_is_stable() {\n    let payload = json!({\n        \"id\": \"018f3c1e-6f2a-7c3b-9d4e-2a1b3c4d5e6f\",\n        \"created_at\": \"2026-01-04T10:00:00Z\",\n        \"total_cents\": 12_500,\n        \"lines\": [{\"sku\": \"A-1\", \"qty\": 2}],\n    });\n\n    // `redactions` feature: replace volatile fields before comparing.\n    assert_json_snapshot!(payload, {\n        \".id\" => \"[uuid]\",\n        \".created_at\" => \"[timestamp]\",\n    });\n}\n\n// tests/snapshots/order_payload_shape_is_stable.snap (after approval)\n// ---\n// source: tests/payload.rs\n// expression: payload\n// ---\n// {\n//   \"id\": \"[uuid]\",\n//   \"created_at\": \"[timestamp]\",\n//   \"total_cents\": 12500,\n//   \"lines\": [ { \"sku\": \"A-1\", \"qty\": 2 } ]\n// }",
          "tip": "Enable the insta features you use: json for assert_json_snapshot!, redactions for the selector syntax. Without them the macro does not exist."
        },
        {
          "h": "Redact everything that moves",
          "p": [
            "A snapshot containing a uuid, a timestamp or a hash fails on every run for a reason that has nothing to do with the code under test, and the failure is indistinguishable from a real regression until someone reads the diff. Redactions replace those values with a stable placeholder before comparison, so the snapshot tests structure and deliberate content rather than the current clock. Round-trip ids, trace ids and durations all belong in the redaction list.",
            "The alternative, sorting and filtering inside the test, hides the shape you wanted to pin. Redaction keeps the field visible with a placeholder, which is a useful reminder that it exists. For values that must be checked exactly, assert them separately with a normal assertion rather than trying to make the snapshot deterministic."
          ],
          "code": "# Cargo.toml\n[dev-dependencies]\ninsta = { version = \"1.49\", features = [\"json\", \"redactions\"] }\n\n# local workflow\ncargo test\ncargo insta review        # accept or reject each pending snapshot\ncargo insta accept        # accept everything that is pending\ncargo insta test --accept # run the suite and take the new snapshots\n\n# CI: never write, never accept\nINSTA_UPDATE=no cargo test\n\n# inspect what is pending without the TUI\ncargo insta pending-snapshots",
          "tip": "INSTA_UPDATE=always in CI turns snapshot tests into assertions that the program produces output. It is the single most common way a snapshot suite silently stops protecting anything."
        },
        {
          "h": "Snapshots are a review artifact, so review them",
          "p": [
            "The value of a snapshot is the human diff. Accepting without reading is worse than not having the test, because the suite now certifies output nobody looked at. Keep snapshots small enough to read in one screen: snapshot one endpoint's payload or one rendered document, not a whole database dump. When a snapshot grows past that, split it or assert the interesting fields directly.",
            "Version-control the .snap files and ignore .snap.new. A .snap.new in a commit means someone approved a change by committing rather than by reviewing, and the next reader cannot tell which of the two files is the intended behavior. Add both patterns to .gitignore and to the repository's review checklist, because the mistake is invisible in a large diff and only surfaces the next time the test fails."
          ],
          "list": [
            ".snap files are committed; .snap.new and .pending-snap are ignored",
            "CI runs with INSTA_UPDATE=no so a missing snapshot fails the build",
            "One snapshot per behavior; a wall of output is a diff nobody reads",
            "Redact ids, timestamps and durations rather than deleting the fields"
          ]
        }
      ],
      "exercise": {
        "prompt": "Snapshot a rendered invoice summary that includes a random order id and a creation timestamp. Redact both fields, then describe the CI configuration that must prevent snapshots from being written during a build.",
        "starter": "use insta::assert_snapshot;\n\n#[test]\nfn invoice_summary_is_stable() {\n    let id = uuid::Uuid::new_v4();\n    let rendered = format!(\"invoice {id}\\ntotal: 125.00 EUR\\nstatus: paid\");\n\n    // 1. redact the uuid\n    // 2. snapshot the rest exactly\n}\n\n// CI: which INSTA_* setting stops snapshot writes?",
        "hint": "assert_json_snapshot! takes a selector map, but plain text needs a filter: insta::with_settings!({filters => vec![(r\"[0-9a-f-]{36}\", \"[uuid]\")]}, { assert_snapshot!(rendered) }). In CI set INSTA_UPDATE=no.",
        "solution": "use insta::{assert_snapshot, with_settings};\n\n#[test]\nfn invoice_summary_is_stable() {\n    let id = uuid::Uuid::new_v4();\n    let rendered = format!(\"invoice {id}\\ntotal: 125.00 EUR\\nstatus: paid\");\n\n    with_settings!({ filters => vec![(r\"[0-9a-f-]{36}\", \"[uuid]\")] }, {\n        assert_snapshot!(rendered);\n    });\n}\n\n// CI job step:\n//   INSTA_UPDATE=no cargo test\n// A missing or changed snapshot then fails the build instead of writing a\n// .snap.new file that nobody reviews."
      },
      "questions": [
        {
          "q": "What does insta write when a snapshot does not match and CI is not detected?",
          "options": [
            "It overwrites the .snap file in place",
            "It writes a .snap.new file next to the old snapshot and fails the test",
            "It prints the diff and exits without touching disk",
            "It stores the new value in the target directory"
          ],
          "answer": 1,
          "explain": "The default INSTA_UPDATE=auto writes pending snapshots as .snap.new for review outside CI, and disables writing when it detects a CI environment."
        },
        {
          "q": "Why is INSTA_UPDATE=always in a CI job dangerous?",
          "options": [
            "It makes the job slower",
            "It rewrites snapshots so the suite passes on any output, and nothing is reviewed",
            "It disables redactions",
            "It fails on missing snapshots instead of creating them"
          ],
          "answer": 1,
          "explain": "The test then asserts only that the code produced something. The regression it was meant to catch passes, and the committed snapshot changes without a reviewer."
        },
        {
          "q": "A snapshot keeps failing because the payload contains a new trace id each run. What is the right fix?",
          "options": [
            "Delete the field from the payload",
            "Add a redaction that replaces the id with a stable placeholder",
            "Sort the JSON keys before snapshotting",
            "Set INSTA_UPDATE=new in CI"
          ],
          "answer": 1,
          "explain": "Redaction keeps the field in the snapshot with a placeholder, so the structure is still pinned while the volatile value stops breaking the comparison."
        }
      ],
      "quickbytes": [
        "cargo insta review walks pending snapshots with a diff and accept/reject keys.",
        "INSTA_UPDATE=no makes CI fail instead of writing new snapshots.",
        "assert_json_snapshot! needs the json feature; selector redactions need redactions.",
        "Commit .snap files, ignore .snap.new."
      ],
      "production": [
        "Snapshot files are reviewed in the pull request like code, never batch-accepted before a release.",
        "CI sets INSTA_UPDATE=no so a missing snapshot is a build failure.",
        "Volatile fields are redacted, not removed, so the payload shape stays pinned.",
        "Snapshots stay small enough to read; large dumps are split per endpoint."
      ],
      "crates": [
        "insta",
        "serde_json",
        "serde"
      ],
      "github": [
        {
          "name": "mitsuhiko/insta",
          "url": "https://github.com/mitsuhiko/insta"
        }
      ],
      "pitfall": "A snapshot of an entire HTTP response including headers and timestamps: it fails on every unrelated dependency bump, so the team runs `cargo insta accept` blindly and the suite stops being read.",
      "resources": [
        {
          "title": "insta crate documentation",
          "url": "https://docs.rs/insta/latest/insta/",
          "kind": "docs"
        },
        {
          "title": "insta repository and snapshot format",
          "url": "https://github.com/mitsuhiko/insta",
          "kind": "repo"
        },
        {
          "title": "cargo-insta on crates.io",
          "url": "https://crates.io/crates/cargo-insta",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "i08",
      "n": 8,
      "title": "Consumer-driven contract testing",
      "minutes": 90,
      "level": "industry",
      "goal": "Write a Pact consumer test that generates a verifiable contract, use matching rules instead of exact values, and explain what provider verification does and does not prove.",
      "sections": [
        {
          "h": "Stubs drift because they encode one team's belief",
          "p": [
            "A hand-written mock of a peer service is a guess about that peer's behavior, frozen at the moment someone wrote it. When the provider renames a field or tightens a validation rule, the consumer's mock keeps returning the old shape and the consumer's tests keep passing. The failure surfaces in staging, after both sides shipped.",
            "A consumer-driven contract fixes the direction of the guess: the consumer writes down the interactions it needs, the file is published, and the provider's CI verifies that it can satisfy them. The consumer keeps testing against a mock (fast), and the provider learns about breakage before deploying, not after."
          ],
          "code": "use pact_consumer::prelude::*;\n\n#[tokio::test]\nasync fn client_parses_a_quote_response() {\n    let mock = PactBuilder::new(\"pricing-client\", \"pricing-service\")\n        .interaction(\"get a quote for a known sku\", \"\", |mut i| {\n            i.given(\"sku A-1 exists with price 1250\");\n            i.request.path(\"/quotes/A-1\");\n            i.response\n                .json_utf8()\n                .json_body(json_pattern!({\n                    \"sku\": like!(\"A-1\"),\n                    \"price_cents\": like!(1250),\n                    \"currency\": term!(\"^[A-Z]{3}$\", \"USD\"),\n                }));\n            i\n        })\n        .start_mock_server(None, None);\n\n    let base = mock.url().to_string();\n    let quote = pricing_client::fetch_quote(&base, \"A-1\").await.unwrap();\n\n    assert_eq!(quote.price_cents, 1250);\n    assert_eq!(quote.currency, \"USD\");\n    // Dropping `mock` verifies that the expected request was actually made.\n}",
          "tip": "The pact file lands in target/pact/ by default. Publish it from CI with a consumer version that identifies the commit, or verification has nothing to check."
        },
        {
          "h": "Matching rules: contract, not fixture",
          "p": [
            "An exact-value contract is a fixture. If the consumer writes that the price is 1250 and the provider returns 1300, verification fails even though the consumer would parse 1300 correctly. Matching rules state the part that matters: any integer for price_cents, a three-letter uppercase code for currency, the literal \"A-1\" for a path segment that must round-trip.",
            "The rule of thumb: use exact values only for things the consumer genuinely depends on (an enum variant, a field name, a path), and type or regex matchers everywhere else. Over-specification is the main reason teams conclude that contract testing is brittle, when the brittleness was authored by hand."
          ],
          "code": "// Too strict: breaks when the provider's real price changes.\njson_pattern!({\n    \"price_cents\": 1250,\n})\n\n// Contract: any integer. The consumer only needs the field to be an integer.\njson_pattern!({\n    \"price_cents\": like!(1250),\n})\n\n// Shape of a list, and a constrained string.\njson_pattern!({\n    \"quotes\": each_like!({\n        \"sku\": like!(\"A-1\"),\n        \"currency\": term!(\"^[A-Z]{3}$\", \"USD\"),\n    }),\n})\n\n// Provider verification (separate binary or CI step):\n//   PACT_URL=https://broker.example.com/pacts/... \\\n//   PACT_PROVIDER_VERSION=$GIT_SHA \\\n//     cargo run --bin verify_pacts",
          "tip": "A contract that matches every possible response protects nothing. Matchers should be as loose as the consumer's parsing and as tight as its logic requires."
        },
        {
          "h": "What verification actually proves",
          "p": [
            "Provider verification replays the recorded requests against a real provider instance with the declared provider states set up, and checks the responses against the matching rules. It proves that the provider can satisfy every interaction its known consumers rely on. It does not prove that the consumer handles a response outside the contract, and it does not replace an integration test for the consumer's own logic.",
            "The operational half is versioning. A pact is a consumer version plus a provider version; the broker tracks which pairs have been verified, and a deploy gate asks whether this consumer version can talk to the provider versions currently in production. Without that gate you have documentation, not a safety mechanism."
          ],
          "list": [
            "Contracts live in a broker, keyed by consumer name and version, not in a shared repository folder",
            "Provider states must be real setup code, not a comment that says 'database has a user'",
            "Verification runs in the provider's pipeline on every change to the API surface",
            "can-i-deploy checks verified pairs before either side ships"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a Pact consumer test for a client that GETs /inventory/SKU-9 and expects a JSON body with `available` (any integer) and `warehouse` (three uppercase letters). Then state the provider-side step that makes the contract meaningful.",
        "starter": "use pact_consumer::prelude::*;\n\n#[tokio::test]\nasync fn client_reads_inventory() {\n    // 1. PactBuilder::new(\"storefront\", \"inventory-service\")\n    // 2. interaction with a given(\"SKU-9 is stocked\")\n    // 3. response json_pattern! with like! and term!\n    // 4. start the mock server and call the client\n}",
        "hint": "Use i.request.path(\"/inventory/SKU-9\") and i.response.json_utf8().json_body(json_pattern!({ \"available\": like!(7), \"warehouse\": term!(\"^[A-Z]{3}$\", \"AMS\") })). Then publish the pact and verify it against the provider.",
        "solution": "use pact_consumer::prelude::*;\n\n#[tokio::test]\nasync fn client_reads_inventory() {\n    let mock = PactBuilder::new(\"storefront\", \"inventory-service\")\n        .interaction(\"read inventory for a stocked sku\", \"\", |mut i| {\n            i.given(\"SKU-9 is stocked in warehouse AMS\");\n            i.request.path(\"/inventory/SKU-9\");\n            i.response.json_utf8().json_body(json_pattern!({\n                \"available\": like!(7),\n                \"warehouse\": term!(\"^[A-Z]{3}$\", \"AMS\"),\n            }));\n            i\n        })\n        .start_mock_server(None, None);\n\n    let base = mock.url().to_string();\n    let inv = storefront::fetch_inventory(&base, \"SKU-9\").await.unwrap();\n    assert!(inv.available >= 0);\n    assert_eq!(inv.warehouse.len(), 3);\n}\n\n// Provider side, without which this is only a mock:\n//   publish the pact to the broker under a consumer version\n//   run pact verification against a real provider with the given state set up\n//   gate deploys with can-i-deploy for the consumer/provider version pair"
      },
      "questions": [
        {
          "q": "What is the essential difference between a hand-written mock and a consumer-driven contract?",
          "options": [
            "Contracts are faster to run",
            "The contract is generated from consumer expectations and then verified against the real provider",
            "Contracts do not need a running service",
            "Mocks cannot represent JSON responses"
          ],
          "answer": 1,
          "explain": "A mock encodes a belief and never checks it. A contract publishes that belief and makes the provider's pipeline prove or break it."
        },
        {
          "q": "Why is an exact price value in a pact body a bad idea?",
          "options": [
            "Pact cannot represent numbers",
            "It fails verification whenever the provider's real data differs, even though the consumer would parse it fine",
            "It makes the pact file larger",
            "It prevents the provider from using HTTPS"
          ],
          "answer": 1,
          "explain": "Exact values turn the contract into a fixture. Matching rules should describe the shape and constraints the consumer depends on."
        },
        {
          "q": "What does successful provider verification prove?",
          "options": [
            "The consumer handles every possible provider response",
            "The provider satisfies every interaction its known consumers declared",
            "The two services are deployed in the same region",
            "The provider's business logic is correct"
          ],
          "answer": 1,
          "explain": "Verification checks declared interactions against a real provider with the stated provider states. It says nothing about responses outside the contract or about the consumer's internal logic."
        }
      ],
      "quickbytes": [
        "Publish pacts with a consumer version tied to the commit, or verification cannot be attributed.",
        "like! for types, term! for formats, exact literals only for values the consumer depends on.",
        "Provider states must run real setup code; a comment is not a state.",
        "Gate deploys with can-i-deploy on the consumer/provider version pair."
      ],
      "production": [
        "Every cross-service call the consumer depends on has a pact interaction, including error responses it handles.",
        "Pacts are published to a broker from CI with a version derived from the commit.",
        "Provider verification runs on every change to routes or serialization, not nightly only.",
        "Deployment gates query verified pairs so an unverified combination cannot ship."
      ],
      "crates": [
        "pact_consumer",
        "reqwest",
        "serde_json",
        "tokio"
      ],
      "github": [
        {
          "name": "pact-foundation/pact-reference",
          "url": "https://github.com/pact-foundation/pact-reference"
        }
      ],
      "pitfall": "Publishing pacts but never verifying them: the consumer keeps a comfortable mock, the provider never learns about the expectation, and the contract is a document nobody executes.",
      "resources": [
        {
          "title": "pact_consumer crate documentation",
          "url": "https://docs.rs/pact_consumer/latest/pact_consumer/",
          "kind": "docs"
        },
        {
          "title": "Pact specification repository",
          "url": "https://github.com/pact-foundation/pact-specification",
          "kind": "repo"
        },
        {
          "title": "Pact reference implementation in Rust",
          "url": "https://github.com/pact-foundation/pact-reference",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "i09",
      "n": 9,
      "title": "Testcontainers: real dependencies, disposable",
      "minutes": 80,
      "level": "advanced",
      "goal": "Run integration tests against a real Postgres in a container, read the mapped host and port instead of guessing, and keep container cost out of the inner loop.",
      "sections": [
        {
          "h": "Why the in-memory fake lies",
          "p": [
            "An in-memory substitute for Postgres shares neither the SQL dialect nor the transaction semantics. It accepts a query your production database rejects, returns rows in a different order, and has no notion of the isolation level your code depends on. Every hour spent making tests pass against the fake is an hour of confidence that does not transfer.",
            "A container gives you the real engine at the cost of a few hundred milliseconds of startup and a Docker dependency in CI. That is the right trade for anything that touches SQL, a broker, object storage or a protocol implementation, and it is why testcontainers exists as a language-agnostic idea with a Rust implementation."
          ],
          "code": "use sqlx::postgres::PgPoolOptions;\nuse testcontainers_modules::{\n    postgres::Postgres,\n    testcontainers::runners::AsyncRunner,\n};\n\n#[tokio::test]\nasync fn orders_roundtrip_through_real_postgres() {\n    let container = Postgres::default().start().await.expect(\"postgres starts\");\n\n    // Never assume 5432: the mapped port is chosen by Docker.\n    let host = container.get_host().await.expect(\"host\");\n    let port = container.get_host_port_ipv4(5432).await.expect(\"mapped port\");\n    let url = format!(\"postgres://postgres:postgres@{host}:{port}/postgres\");\n\n    let pool = PgPoolOptions::new()\n        .max_connections(5)\n        .connect(&url)\n        .await\n        .expect(\"connect to container\");\n\n    sqlx::query(\"create table orders (id bigint primary key, total_cents bigint not null)\")\n        .execute(&pool)\n        .await\n        .unwrap();\n    sqlx::query(\"insert into orders (id, total_cents) values ($1, $2)\")\n        .bind(1_i64)\n        .bind(1_250_i64)\n        .execute(&pool)\n        .await\n        .unwrap();\n\n    let total: i64 = sqlx::query_scalar(\"select total_cents from orders where id = $1\")\n        .bind(1_i64)\n        .fetch_one(&pool)\n        .await\n        .unwrap();\n    assert_eq!(total, 1_250);\n    // `container` drops here, which stops and removes the container.\n}",
          "tip": "testcontainers-modules re-exports testcontainers, so depend on the module crate only. Two direct dependencies on testcontainers at different versions is a type mismatch you cannot fix with a use statement."
        },
        {
          "h": "One container per test, or one per suite",
          "p": [
            "A container per test is the simplest correct model: no shared state, no ordering, full parallelism. It is also the slowest, because each test pays image start plus migration. A container per suite, shared through a fixture, is faster but reintroduces the state coupling that the container was meant to remove.",
            "The middle path is one container with one schema per test: start Postgres once, then create a uniquely named schema or database for each test and drop it afterwards. You keep isolation and pay startup once. Whichever model you pick, the test must not depend on a container from another test file, because Cargo runs test binaries in parallel and the order is not defined."
          ],
          "code": "// Once per test binary, shared through a lazy handle.\nuse std::sync::OnceLock;\nuse testcontainers_modules::{postgres::Postgres, testcontainers::runners::AsyncRunner};\n\nstatic PG_URL: OnceLock<String> = OnceLock::new();\n\npub async fn postgres_url() -> &'static str {\n    if let Some(url) = PG_URL.get() {\n        return url;\n    }\n    let container = Postgres::default().start().await.expect(\"postgres starts\");\n    let host = container.get_host().await.unwrap();\n    let port = container.get_host_port_ipv4(5432).await.unwrap();\n    let url = format!(\"postgres://postgres:postgres@{host}:{port}/postgres\");\n    PG_URL.set(url).expect(\"set once\");\n    // Leak the container handle so it lives for the whole binary; the runtime\n    // removes it when the process exits (TESTCONTAINERS_COMMAND=keep overrides).\n    std::mem::forget(container);\n    PG_URL.get().unwrap()\n}",
          "tip": "TESTCONTAINERS_COMMAND=keep leaves containers running after the test for debugging; remember to clean them up, or CI runners fill with stopped containers."
        },
        {
          "h": "CI cost and readiness",
          "p": [
            "Containers need a Docker daemon. GitHub-hosted Linux runners have one; some Kubernetes-based CI systems do not, and the failure mode is a test that hangs waiting for a socket. Fail fast with a clear message when the daemon is unreachable rather than letting the suite time out.",
            "Readiness matters more than startup. A container is running before Postgres accepts connections, so either use a wait strategy or let the client retry the first connection with a bounded budget. Prefer the client's own connect timeout: it is one mechanism, it is testable, and it does not depend on a module implementing a health check."
          ],
          "list": [
            "Read the mapped host and port from the container; never hardcode localhost:5432",
            "Cache the image in CI so the start cost is unpacking, not pulling",
            "Bound the first connection attempt; a container that never becomes ready must fail the test, not hang the job",
            "Keep the container count per binary small; parallel test binaries each start their own"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a test that starts Postgres in a container, connects with sqlx, creates a table, inserts one row and reads it back. Use the mapped port and assert the value you inserted.",
        "starter": "use sqlx::postgres::PgPoolOptions;\nuse testcontainers_modules::{postgres::Postgres, testcontainers::runners::AsyncRunner};\n\n#[tokio::test]\nasync fn insert_and_read_back() {\n    // 1. start Postgres::default()\n    // 2. get_host() and get_host_port_ipv4(5432)\n    // 3. build the URL and connect\n    // 4. create table, insert, select, assert\n}",
        "hint": "format!(\"postgres://postgres:postgres@{host}:{port}/postgres\") is the default credential pair for the postgres module. Then use sqlx::query and query_scalar as in any other test.",
        "solution": "use sqlx::postgres::PgPoolOptions;\nuse testcontainers_modules::{postgres::Postgres, testcontainers::runners::AsyncRunner};\n\n#[tokio::test]\nasync fn insert_and_read_back() {\n    let container = Postgres::default().start().await.expect(\"postgres starts\");\n    let host = container.get_host().await.unwrap();\n    let port = container.get_host_port_ipv4(5432).await.unwrap();\n    let url = format!(\"postgres://postgres:postgres@{host}:{port}/postgres\");\n\n    let pool = PgPoolOptions::new()\n        .max_connections(2)\n        .connect(&url)\n        .await\n        .expect(\"connect\");\n\n    sqlx::query(\"create table kv (k text primary key, v bigint not null)\")\n        .execute(&pool).await.unwrap();\n    sqlx::query(\"insert into kv (k, v) values ($1, $2)\")\n        .bind(\"answer\").bind(42_i64).execute(&pool).await.unwrap();\n\n    let v: i64 = sqlx::query_scalar(\"select v from kv where k = $1\")\n        .bind(\"answer\").fetch_one(&pool).await.unwrap();\n    assert_eq!(v, 42);\n}"
      },
      "questions": [
        {
          "q": "Why should a testcontainers test read get_host_port_ipv4(5432) instead of connecting to localhost:5432?",
          "options": [
            "Docker maps the container port to a random host port, so 5432 on the host may be unused or taken",
            "Postgres inside the container listens on a random port",
            "sqlx requires an explicit port number",
            "localhost is not routable from tests"
          ],
          "answer": 0,
          "explain": "Docker publishes container ports on host ports chosen at start time. Hardcoding 5432 either collides with a local server or connects to nothing."
        },
        {
          "q": "What happens to the container when ContainerAsync goes out of scope?",
          "options": [
            "It keeps running until CI cleans up",
            "It is stopped and removed, unless TESTCONTAINERS_COMMAND=keep is set",
            "It is paused and reused by the next test",
            "It is committed to a new image"
          ],
          "answer": 1,
          "explain": "The handle implements Drop and removes the container. The keep command exists specifically to override that for debugging."
        },
        {
          "q": "A suite starts one container per test and now takes 12 minutes. What is the first change to consider?",
          "options": [
            "Run the tests serially",
            "Start one container per test binary and give each test its own schema",
            "Replace Postgres with SQLite",
            "Increase the test timeout"
          ],
          "answer": 1,
          "explain": "You can keep isolation without paying image startup per test: one container per binary plus a per-test schema or database removes most of the cost and keeps tests independent."
        }
      ],
      "quickbytes": [
        "testcontainers-modules re-exports testcontainers; do not depend on both directly.",
        "TESTCONTAINERS_COMMAND=keep keeps containers alive after a run for debugging.",
        "Use the mapped port from get_host_port_ipv4, never a fixed number.",
        "Cache images in CI; pulling Postgres on every job dominates the runtime."
      ],
      "production": [
        "Integration tests that touch SQL, a broker or object storage use the real engine in a container.",
        "Every container test reads host and port from the handle and uses ephemeral mapping.",
        "CI checks for a reachable Docker daemon and fails fast with a clear message.",
        "Container startup is bounded by a connect timeout so a broken image fails instead of hanging."
      ],
      "crates": [
        "testcontainers",
        "testcontainers-modules",
        "sqlx",
        "tokio"
      ],
      "github": [
        {
          "name": "testcontainers/testcontainers-rs",
          "url": "https://github.com/testcontainers/testcontainers-rs"
        },
        {
          "name": "testcontainers/testcontainers-rs-modules-community",
          "url": "https://github.com/testcontainers/testcontainers-rs-modules-community"
        }
      ],
      "pitfall": "A shared container started in one test and relied on by another: Cargo runs test binaries in parallel and in no fixed order, so the second test connects to a container that was never started.",
      "resources": [
        {
          "title": "testcontainers crate documentation",
          "url": "https://docs.rs/testcontainers/latest/testcontainers/",
          "kind": "docs"
        },
        {
          "title": "testcontainers-modules: postgres, redis, kafka and more",
          "url": "https://docs.rs/testcontainers-modules/latest/testcontainers_modules/",
          "kind": "docs"
        },
        {
          "title": "testcontainers-rs repository",
          "url": "https://github.com/testcontainers/testcontainers-rs",
          "kind": "repo"
        },
        {
          "title": "Docker: publishing container ports",
          "url": "https://docs.docker.com/engine/network/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "i10",
      "n": 10,
      "title": "Load testing with k6: baselines and gates",
      "minutes": 85,
      "level": "industry",
      "goal": "Model a workload with an arrival-rate scenario, turn latency budgets into thresholds that fail the build, and explain why a laptop load test proves almost nothing.",
      "sections": [
        {
          "h": "Closed loops hide the queue",
          "p": [
            "A load test that runs a fixed number of virtual users, each waiting for its response before sending the next request, measures a closed system. When the server slows down, the users slow down too, so the request rate falls and the server is never asked to keep up. The p99 looks acceptable precisely because the generator stopped pushing.",
            "An arrival-rate scenario fixes the request rate independently of response time, which is what production does: users arrive whether or not the last request finished. In k6 that is the ramping-arrival-rate executor. If the system cannot keep up, requests queue and latency grows, which is the signal you wanted to see. Closed-model results are still useful for capacity planning, but they must not be your regression gate."
          ],
          "code": "import http from 'k6/http';\nimport { check } from 'k6';\n\nexport const options = {\n  scenarios: {\n    quotes: {\n      executor: 'ramping-arrival-rate',\n      startRate: 10,\n      timeUnit: '1s',\n      preAllocatedVUs: 50,\n      maxVUs: 300,\n      stages: [\n        { target: 50, duration: '30s' },   // warm up\n        { target: 200, duration: '2m' },   // steady state\n        { target: 0, duration: '30s' },    // ramp down\n      ],\n    },\n  },\n  thresholds: {\n    http_req_failed: ['rate<0.01'],\n    http_req_duration: ['p(95)<300', 'p(99)<800'],\n    checks: ['rate>0.99'],\n  },\n};\n\nexport default function () {\n  const res = http.get(`${__ENV.BASE_URL}/quotes/A-1`);\n  check(res, { 'status is 200': (r) => r.status === 200 });\n}",
          "tip": "preAllocatedVUs is a floor, not a limit: if the arrival rate outruns the VUs, k6 drops iterations and tells you in the summary. Read that line before trusting the latency numbers."
        },
        {
          "h": "Thresholds are the only part that gates",
          "p": [
            "A k6 run that prints a pretty summary and exits zero is a dashboard. Thresholds turn a metric into an exit code: when a threshold is breached, k6 exits non-zero, which is what lets a CI job fail. Put the budget on the metrics that map to a user promise, usually http_req_duration p95 and the error rate, and keep the set small enough that a failure names one thing.",
            "Regression gates need a reference. Either compare against an absolute budget derived from the SLO, or run against the previous build's baseline and fail on a relative change beyond a tolerance. Absolute budgets catch real user-facing regressions; relative comparisons catch slow drift. Pick one as the merge gate and keep the other as a trend report, because a gate that fires on noise gets muted."
          ],
          "code": "# local: short smoke run\nk6 run --vus 10 --duration 30s load/quotes.js\n\n# CI: full scenario, thresholds decide the exit code\nBASE_URL=https://staging.example.com \\\n  k6 run --summary-export=load/summary.json load/quotes.js\n\n# fail the job explicitly on a threshold breach (k6 already exits 99)\nif [ $? -ne 0 ]; then echo \"load thresholds breached\"; exit 1; fi\n\n# compare two summaries with jq: p95 and error rate\njq -r '.metrics.http_req_duration.values[\"p(95)\"], .metrics.http_req_failed.values.rate' \\\n  load/summary.json",
          "tip": "k6 exits with status 99 when a threshold fails. A wrapper script that swallows the exit code turns the gate back into a dashboard."
        },
        {
          "h": "Reading a load test honestly",
          "p": [
            "Latency distributions have long tails, and at scale the tail dominates: if one request in a hundred fans out to a hundred servers, a slow one is almost guaranteed. The Tail at Scale describes the effect and the mitigations (hedged requests, microsecond-level accounting), and it is the reason a p50 that looks fine can coexist with users who call the service slow.",
            "Practical rules: warm up before measuring, run long enough to include GC and connection churn, test against production-like data volume, and never generate load from the same machine that runs the server. Record the generator's own CPU: if it saturates, you measured k6, not the service."
          ],
          "list": [
            "Report p50, p95 and p99 together; a single average hides the tail that users feel",
            "Keep the dataset production-shaped; a query over 100 rows says nothing about 10 million",
            "Separate the load generator from the target, or you are benchmarking one box against itself",
            "Store every run's summary so a regression has a baseline to be compared with"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a k6 scenario that ramps from 20 to 150 requests per second, asserts p95 under 250 ms and an error rate under 0.5%, and uses an environment variable for the target URL.",
        "starter": "import http from 'k6/http';\nimport { check } from 'k6';\n\nexport const options = {\n  // 1. ramping-arrival-rate with stages\n  // 2. thresholds for p95 and error rate\n};\n\nexport default function () {\n  // 3. GET ${__ENV.BASE_URL}/health and check 200\n}",
        "hint": "executor: 'ramping-arrival-rate' with timeUnit '1s', startRate 20, stages targeting 150. thresholds: http_req_duration ['p(95)<250'] and http_req_failed ['rate<0.005'].",
        "solution": "import http from 'k6/http';\nimport { check } from 'k6';\n\nexport const options = {\n  scenarios: {\n    ramp: {\n      executor: 'ramping-arrival-rate',\n      startRate: 20,\n      timeUnit: '1s',\n      preAllocatedVUs: 40,\n      maxVUs: 250,\n      stages: [\n        { target: 20, duration: '30s' },\n        { target: 150, duration: '2m' },\n      ],\n    },\n  },\n  thresholds: {\n    http_req_duration: ['p(95)<250'],\n    http_req_failed: ['rate<0.005'],\n  },\n};\n\nexport default function () {\n  const res = http.get(`${__ENV.BASE_URL}/health`);\n  check(res, { 'status is 200': (r) => r.status === 200 });\n}"
      },
      "questions": [
        {
          "q": "Why does a fixed-VU test understate latency when the service degrades?",
          "options": [
            "k6 discards slow requests",
            "Virtual users wait for responses, so the request rate falls with throughput and the server is never pushed",
            "Thresholds are disabled in closed models",
            "The generator caches responses"
          ],
          "answer": 1,
          "explain": "In a closed model the generator is throttled by the system under test. An arrival-rate model keeps the offered load fixed, which is what exposes queueing."
        },
        {
          "q": "What makes a k6 run fail a CI job?",
          "options": [
            "Any p99 above 200 ms",
            "A breached threshold, which makes k6 exit non-zero (status 99)",
            "The summary export being missing",
            "More than one scenario in the script"
          ],
          "answer": 1,
          "explain": "Thresholds are assertions on metrics. Without them the run always exits zero and the gate is decorative."
        },
        {
          "q": "A load test shows p50 at 40 ms and p99 at 1.4 s. What is the most useful next question?",
          "options": [
            "Whether the average is acceptable",
            "Which dependency or queue produces the tail, since a fraction of users experience it on every request they make",
            "Whether to increase VUs",
            "Whether to switch the executor"
          ],
          "answer": 1,
          "explain": "The tail is the user-visible symptom, and fan-out amplifies it: a request that touches many backends is slow whenever any one of them is. Find the tail source before tuning the generator."
        }
      ],
      "quickbytes": [
        "k6 exits 99 on a threshold breach; do not wrap it in a script that ignores the status.",
        "ramping-arrival-rate keeps offered load fixed; ramping-vus does not.",
        "--summary-export=summary.json gives you a baseline file to diff across runs.",
        "Read the dropped_iterations metric before believing latency numbers."
      ],
      "production": [
        "Every service has a k6 scenario with thresholds derived from its SLO, run on each merge to main.",
        "Runs execute against staging with production-shaped data, not a laptop against localhost.",
        "Summaries are archived per commit so a regression can be compared with its parent.",
        "The load generator's own CPU and dropped iterations are part of the report, not an afterthought."
      ],
      "crates": [
        "reqwest",
        "tokio",
        "serde_json"
      ],
      "github": [
        {
          "name": "grafana/k6",
          "url": "https://github.com/grafana/k6"
        },
        {
          "name": "grafana/k6-docs",
          "url": "https://github.com/grafana/k6-docs"
        }
      ],
      "pitfall": "Running k6 on the same machine as the service and concluding it scales: the generator and the server compete for the same cores, so both the throughput ceiling and the latency numbers describe the laptop.",
      "resources": [
        {
          "title": "k6: a modern load testing tool",
          "url": "https://github.com/grafana/k6",
          "kind": "repo"
        },
        {
          "title": "k6 documentation source",
          "url": "https://github.com/grafana/k6-docs",
          "kind": "docs"
        },
        {
          "title": "The Tail at Scale (Dean & Barroso, CACM 2013)",
          "url": "https://cacm.acm.org/research/the-tail-at-scale/",
          "kind": "paper"
        }
      ]
    },
    {
      "id": "i11",
      "n": 11,
      "title": "Chaos experiments: hypothesis, blast radius, abort",
      "minutes": 80,
      "level": "industry",
      "goal": "Run a fault injection as a falsifiable experiment with a steady-state definition and an abort switch, using toxiproxy for network faults and Chaos Mesh for cluster-level ones.",
      "sections": [
        {
          "h": "Chaos is an experiment, not an outage",
          "p": [
            "A chaos experiment states a hypothesis about steady state, injects one fault, and asks whether the hypothesis survived. Without the first part you are just breaking things: there is no answer to whether the system behaved correctly, because correct was never defined. The steady-state definition is a small set of metrics with thresholds: checkout success rate above 99.5%, p99 under 800 ms, queue lag under 30 seconds.",
            "Two more properties make it engineering rather than gambling. The blast radius is bounded in advance (one replica, one percent of traffic, a staging namespace), and an abort condition stops the experiment automatically when steady state breaks in a way you did not predict. Netflix's Chaos Monkey and the Kubernetes-native Chaos Mesh both exist to make those bounds explicit and repeatable."
          ],
          "code": "# Experiment card, committed next to the manifests.\nname: payment-latency\nhypothesis: >\n  With 800 ms of downstream latency on payments, checkout still succeeds\n  above 99.5% because the gateway falls back to the queued authorization.\nsteady_state:\n  - checkout_success_rate > 0.995 (5 min window)\n  - checkout_p99_latency_ms < 800\nfault:\n  type: network-delay\n  target: payments-service\n  magnitude: 800ms +/- 50ms\n  duration: 10m\nblast_radius: 1 of 4 replicas, staging namespace only\nabort_if:\n  - checkout_success_rate < 0.98 for 60s\n  - error_budget_burn_rate > 10x\nrollback: delete the NetworkChaos resource; verify pods rejoin within 60s",
          "tip": "Write the hypothesis so it can fail. A statement like the system should be resilient is not a hypothesis; a success-rate threshold over a time window is."
        },
        {
          "h": "Network faults you can reproduce locally",
          "p": [
            "Most interesting failures are network-shaped: latency, connection resets, bandwidth collapse, a peer that accepts connections and never answers. toxiproxy sits between your service and its dependency, and its HTTP API creates proxies and attaches toxics at runtime, so a test can introduce a fault, assert the client's behavior, and remove it, all in one process.",
            "That is the difference between a chaos experiment and a flaky test: the fault is created deliberately, its parameters are known, and it is removed deterministically. Keep the proxy in the test harness, not in production, and use it to prove the timeout, retry and circuit-breaker paths that are otherwise only exercised by accidents."
          ],
          "code": "# create a proxy in front of the payments service\ncurl -s -X POST localhost:8474/proxies -d '{\n  \"name\": \"payments\",\n  \"listen\": \"127.0.0.1:26379\",\n  \"upstream\": \"127.0.0.1:8081\",\n  \"enabled\": true\n}'\n\n# 800 ms of downstream latency, 50 ms jitter\ncurl -s -X POST localhost:8474/proxies/payments/toxics -d '{\n  \"name\": \"latency\",\n  \"type\": \"latency\",\n  \"stream\": \"downstream\",\n  \"attributes\": { \"latency\": 800, \"jitter\": 50 }\n}'\n\n# a peer that accepts the connection and never answers\ncurl -s -X POST localhost:8474/proxies/payments/toxics -d '{\n  \"name\": \"hang\",\n  \"type\": \"timeout\",\n  \"stream\": \"downstream\",\n  \"attributes\": { \"timeout\": 0 }\n}'\n\n# remove the fault and confirm recovery\ncurl -s -X DELETE localhost:8474/proxies/payments/toxics/latency",
          "tip": "Test the hang case, not just the slow case. A timeout toxic exercises the code path where no response ever arrives, which is where missing deadlines turn into leaked tasks."
        },
        {
          "h": "Assert the fallback, not the fault",
          "p": [
            "Injecting a fault proves nothing unless the test asserts what the service did about it. The assertions belong to your own code: the call returned within its deadline, the fallback path was taken, the error was classified as retryable, the request was shed with a 503 instead of queueing until the process died.",
            "Keep the fault injection in the same test as the assertion, with a bounded duration. A fault left active because an assertion panicked will poison every later test in that binary, so use a guard that removes the toxic on drop, and assert on elapsed time with a tolerance rather than an exact number."
          ],
          "code": "// ToxiproxyGuard is a small test helper (about 40 lines) over the toxiproxy\n// HTTP API: it creates the proxy in new(), adds toxics, and deletes them in\n// Drop so a panicking assertion cannot leave the fault attached.\nuse std::time::{Duration, Instant};\n\n#[tokio::test]\nasync fn slow_peer_is_abandoned_at_the_deadline() {\n    let proxy = ToxiproxyGuard::new(\"payments\", \"127.0.0.1:26379\", \"127.0.0.1:8081\")\n        .await\n        .expect(\"proxy created\");\n    proxy.add_latency(Duration::from_millis(800)).await.unwrap();\n\n    let client = PaymentsClient::new(proxy.url(), Duration::from_millis(250));\n\n    let started = Instant::now();\n    let result = client.authorize(\"order-1\", 1_250).await;\n    let elapsed = started.elapsed();\n\n    assert!(result.is_err(), \"deadline must produce an error, not a hang\");\n    assert!(elapsed < Duration::from_millis(600), \"took {elapsed:?}\");\n    assert_eq!(client.last_outcome(), Outcome::DeadlineExceeded);\n\n    // Drop removes the toxic even if an assertion above panicked.\n    drop(proxy);\n}",
          "tip": "A guard that deletes the toxic in Drop is not optional. Without it, one failed assertion leaves 800 ms of latency attached for every subsequent test in the binary."
        }
      ],
      "exercise": {
        "prompt": "Define a chaos experiment for a service whose dependency can become unreachable. Write the hypothesis, the steady-state signal, the fault, the blast radius and the abort condition, then name the assertion your test must make.",
        "starter": "# experiment.md\nname: cache-unreachable\nhypothesis: ???\nsteady_state:\n  - ???\nfault:\n  type: ???\n  target: ???\n  duration: ???\nblast_radius: ???\nabort_if:\n  - ???\nassertion_in_test: ???",
        "hint": "Hypothesis: with Redis unreachable, product pages still render from Postgres within the latency budget. Steady state: page success rate and p99. Fault: timeout toxic on the Redis proxy. Abort: success rate below 99% for a minute.",
        "solution": "# experiment.md\nname: cache-unreachable\nhypothesis: >\n  With Redis unreachable, product pages still render from Postgres and\n  p99 stays under 400 ms, because the cache read is best-effort.\nsteady_state:\n  - page_success_rate > 0.999 (5 min window)\n  - page_p99_latency_ms < 400\nfault:\n  type: timeout toxic (connection accepted, never answered)\n  target: redis proxy in the staging namespace\n  duration: 5m\nblast_radius: staging only, 1 of 3 replicas behind the proxy\nabort_if:\n  - page_success_rate < 0.99 for 60s\n  - any 5xx from the product page handler\nassertion_in_test: >\n  The handler returns 200 within 400 ms and increments the\n  cache_miss_total counter, proving it took the Postgres path instead of\n  blocking on the cache read."
      },
      "questions": [
        {
          "q": "What makes a chaos experiment falsifiable?",
          "options": [
            "Injecting a fault in production",
            "A steady-state hypothesis with numeric thresholds that the fault could break",
            "Using a chaos tool rather than a script",
            "Running it for at least an hour"
          ],
          "answer": 1,
          "explain": "The hypothesis plus thresholds define what correct behavior means during the fault. Without them there is no observation that could refute the claim."
        },
        {
          "q": "Why does a fault-injection test need a guard that removes the fault on drop?",
          "options": [
            "toxiproxy requires explicit cleanup to free ports",
            "A panicking assertion would otherwise leave the fault active for every later test in the binary",
            "The proxy refuses to start twice without cleanup",
            "Toxics expire only when the process exits"
          ],
          "answer": 1,
          "explain": "Cleanup code after the assertion never runs on panic. A Drop guard makes removal unconditional, which keeps a failed test from cascading."
        },
        {
          "q": "Which fault is most likely to expose a missing deadline?",
          "options": [
            "Adding 50 ms of latency",
            "A peer that accepts the connection and never sends a response",
            "Dropping one percent of packets",
            "Restarting the peer quickly"
          ],
          "answer": 1,
          "explain": "A hang never completes, so only an explicit timeout ends the wait. Latency and packet loss eventually resolve, which lets code without deadlines look fine."
        }
      ],
      "quickbytes": [
        "Bound the blast radius before the experiment, not during the incident.",
        "A timeout toxic (accept, never answer) tests deadlines; latency only tests patience.",
        "Remove the fault in a Drop guard so a panic cannot poison later tests.",
        "Assert elapsed time with a tolerance; exact millisecond assertions flake."
      ],
      "production": [
        "Every experiment is a committed card with hypothesis, steady state, blast radius and abort condition.",
        "Faults are injected one at a time so the observed effect has a single cause.",
        "An automated abort removes the fault when steady state degrades beyond the stated bound.",
        "Results are written down: hypothesis, outcome, follow-up ticket. A chaos game day without notes is a rehearsal."
      ],
      "crates": [
        "tokio",
        "reqwest",
        "tracing"
      ],
      "github": [
        {
          "name": "Shopify/toxiproxy",
          "url": "https://github.com/Shopify/toxiproxy"
        },
        {
          "name": "chaos-mesh/chaos-mesh",
          "url": "https://github.com/chaos-mesh/chaos-mesh"
        }
      ],
      "pitfall": "Injecting a fault with no steady-state definition: the service degrades, nobody can say whether that was acceptable, and the experiment produces an argument instead of a finding.",
      "resources": [
        {
          "title": "toxiproxy: a TCP proxy to simulate network conditions",
          "url": "https://github.com/Shopify/toxiproxy",
          "kind": "repo"
        },
        {
          "title": "Chaos Mesh: a chaos engineering platform for Kubernetes",
          "url": "https://github.com/chaos-mesh/chaos-mesh",
          "kind": "repo"
        },
        {
          "title": "Kubernetes documentation: pod disruption budgets",
          "url": "https://kubernetes.io/docs/concepts/workloads/pods/disruptions/",
          "kind": "docs"
        },
        {
          "title": "Netflix Chaos Monkey",
          "url": "https://github.com/Netflix/chaosmonkey",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "i12",
      "n": 12,
      "title": "Coverage with cargo-llvm-cov: useful, not sacred",
      "minutes": 70,
      "level": "advanced",
      "goal": "Produce region and line coverage with cargo-llvm-cov, gate a pull request on the right number, and explain precisely what coverage cannot tell you.",
      "sections": [
        {
          "h": "What instrument-coverage actually records",
          "p": [
            "rustc's -C instrument-coverage inserts counters at basic-block boundaries and writes a profile at exit; cargo-llvm-cov orchestrates the build, runs the tests, and maps counters back to source through LLVM's coverage tools. The result distinguishes regions (spans of code that execute together), lines, and branches, and the region view is usually the honest one: a line with two short-circuit operands can be half-covered while the line metric says it ran.",
            "The numbers are only as good as the profile data. Tests that fork, exec, or exit without flushing can lose counters, and tests run through a wrapper that swallows the profile produce a report that understates coverage. Run coverage with the same test runner you gate on, and treat a sudden drop in a file nobody touched as a tooling problem before treating it as a regression."
          ],
          "code": "rustup component add llvm-tools-preview\ncargo install cargo-llvm-cov\n\n# whole workspace, all features, human-readable summary\ncargo llvm-cov --workspace --all-features\n\n# gate a pull request on line coverage\ncargo llvm-cov --workspace --fail-under-lines 85\n\n# machine-readable for a CI badge or a diff comment\ncargo llvm-cov --workspace --lcov --output-path lcov.info\n\n# ignore generated code and build scripts\ncargo llvm-cov --workspace \\\n  --ignore-filename-regex '(generated|/build\\.rs$)' \\\n  --fail-under-lines 85\n\n# per-file table, useful to find the file dragging the number down\ncargo llvm-cov report --text",
          "tip": "cargo llvm-cov needs the llvm-tools-preview component for the exact toolchain in use. A rustup update silently removes the mismatch only if you re-add it."
        },
        {
          "h": "Gate the diff, not the average",
          "p": [
            "A single workspace-wide percentage is a lagging indicator: it moves slowly, it is dominated by large old files, and it can be satisfied by adding trivial tests in an easy module. The number that changes behavior is coverage of the lines this pull request touched, reported as a comment, with a floor below which the author has to justify the gap.",
            "Absolute thresholds still have a place as a ratchet: fail if total coverage drops by more than a point, rather than fail below a fixed number. That formulation does not require a heroic cleanup to adopt, and it cannot be gamed by deleting tests from a module nobody watches, because deletion lowers the total too."
          ],
          "code": "# .github/workflows/coverage.yml (excerpt)\n- name: Coverage\n  run: |\n    cargo llvm-cov --workspace --all-features --lcov --output-path lcov.info\n    cargo llvm-cov report --text\n\n- name: Ratchet\n  run: |\n    total=$(cargo llvm-cov report --json --summary-only | jq '.data[0].totals.lines.percent')\n    echo \"line coverage: $total\"\n    awk -v t=\"$total\" 'BEGIN { exit (t < 84.0) }'\n\n- name: Upload\n  uses: codecov/codecov-action@v4\n  with:\n    files: lcov.info",
          "tip": "Exclude generated code, vendored crates and build scripts from the denominator. Including them makes the number stable and meaningless at the same time."
        },
        {
          "h": "The blind spot, stated plainly",
          "p": [
            "Coverage measures execution, not verification. A test that calls a function and asserts nothing contributes full line coverage and zero detection, and a suite built that way scores well while letting every mutation through. The two tools are complementary: coverage tells you what never ran, mutation testing tells you what ran without being checked.",
            "Use coverage as a search tool first: open the report, find the untested error branch, write the test. Use it as a gate second, with a ratchet. Do not celebrate 100%: the last few points are usually generated code, defensive unreachable arms, and Drop impls, and time spent there is time not spent on the paths that fail in production."
          ],
          "list": [
            "Untested error branches are the highest-value target in any coverage report",
            "A ratchet (do not drop) beats an absolute floor (reach 90%) for adoption",
            "Generated code and build scripts belong outside the denominator",
            "Coverage without assertions is a number that goes up while quality goes down"
          ]
        }
      ],
      "exercise": {
        "prompt": "Add a coverage job that produces lcov, prints a per-file table, excludes generated code, and fails when line coverage drops below 84 percent. Then explain which metric you would look at first in the report.",
        "starter": "# CI steps\n# 1. install llvm-tools-preview and cargo-llvm-cov\n# 2. run with --lcov --output-path lcov.info\n# 3. exclude generated files\n# 4. fail under 84 percent lines\n\n# First thing to inspect in the report: ???",
        "hint": "cargo llvm-cov --workspace --ignore-filename-regex '(generated|/build\\.rs$)' --lcov --output-path lcov.info, then a separate --fail-under-lines 84 run. Inspect uncovered error branches first.",
        "solution": "- name: Install coverage tooling\n  run: |\n    rustup component add llvm-tools-preview\n    cargo install cargo-llvm-cov --locked\n\n- name: Coverage report\n  run: |\n    cargo llvm-cov --workspace --all-features \\\n      --ignore-filename-regex '(generated|/build\\.rs$)' \\\n      --lcov --output-path lcov.info\n    cargo llvm-cov report --text\n\n- name: Coverage gate\n  run: |\n    cargo llvm-cov --workspace --all-features \\\n      --ignore-filename-regex '(generated|/build\\.rs$)' \\\n      --fail-under-lines 84\n\n# First thing to inspect: the uncovered lines inside error handling and\n# match arms that return early. Those are the paths that only run when\n# something goes wrong in production, which is exactly when they matter."
      },
      "questions": [
        {
          "q": "Why can a line show as covered while a branch on that line never ran?",
          "options": [
            "llvm-cov rounds coverage to whole lines",
            "Short-circuit operators can skip the second operand while the line still executes",
            "Branch coverage is not supported by rustc",
            "Lines with more than one statement are always counted as covered"
          ],
          "answer": 1,
          "explain": "Line counters fire when any part of the line runs. With && or ||, the right operand may never be evaluated, which the region or branch view exposes and the line view hides."
        },
        {
          "q": "What is a coverage ratchet?",
          "options": [
            "A tool that rewrites tests to hit uncovered lines",
            "A gate that fails when coverage decreases relative to the previous baseline",
            "A per-file minimum of 100 percent",
            "A nightly job that deletes uncovered code"
          ],
          "answer": 1,
          "explain": "A ratchet only forbids regression, so it can be adopted on an existing codebase without a cleanup project and still prevents slow decay."
        },
        {
          "q": "A crate reports 92 percent line coverage but a mutation score of 15 percent. What is the likely cause?",
          "options": [
            "The coverage tool is misconfigured",
            "Tests execute code but rarely assert on the results",
            "The crate has too few lines",
            "Mutation testing is incompatible with llvm-cov"
          ],
          "answer": 1,
          "explain": "High execution with low detection is the signature of assertion-free tests. Coverage counted the calls; mutation testing asked whether any call could fail."
        }
      ],
      "quickbytes": [
        "cargo llvm-cov --fail-under-lines N turns the report into an exit code.",
        "--ignore-filename-regex keeps generated code out of the denominator.",
        "cargo llvm-cov report --text gives a per-file table after a run.",
        "Ratchet on total coverage; report diff coverage to the author."
      ],
      "production": [
        "Coverage runs on every PR with generated code and build scripts excluded from the denominator.",
        "The gate is a ratchet plus a diff comment, not a single workspace-wide percentage.",
        "Uncovered error branches are triaged each sprint; they are the report's real signal.",
        "Coverage is paired with a mutation score so execution is not mistaken for verification."
      ],
      "crates": [
        "cargo-llvm-cov",
        "cargo-nextest"
      ],
      "github": [
        {
          "name": "taiki-e/cargo-llvm-cov",
          "url": "https://github.com/taiki-e/cargo-llvm-cov"
        }
      ],
      "pitfall": "Gating on a workspace-wide percentage: teams add assertion-free tests in a large easy module to hit the number, the metric rises, and the untested error paths that actually page people stay untested.",
      "resources": [
        {
          "title": "cargo-llvm-cov: LLVM source-based coverage for Cargo",
          "url": "https://github.com/taiki-e/cargo-llvm-cov",
          "kind": "repo"
        },
        {
          "title": "The rustc book: instrument-coverage",
          "url": "https://doc.rust-lang.org/rustc/instrument-coverage.html",
          "kind": "docs"
        },
        {
          "title": "LLVM source-based code coverage",
          "url": "https://github.com/llvm/llvm-project",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "i13",
      "n": 13,
      "title": "Flaky tests: causes, not retries",
      "minutes": 75,
      "level": "industry",
      "goal": "Diagnose the three dominant sources of flakiness, remove clock and ordering dependence from tests, and use retries as a measurement that triggers quarantine rather than a fix.",
      "sections": [
        {
          "h": "Three sources cover most flakes",
          "p": [
            "Time: a test asserts that something expires after a second and sleeps, so it races the scheduler on a loaded CI box. Order and shared state: a test depends on a row another test created, or on a global that a parallel test mutates. Concurrency and resources: a fixed port, a temp file with a hardcoded name, a thread that has not finished when the assertion runs. Nearly every flake is one of these three wearing a disguise.",
            "The diagnostic is cheap: run the failing test alone, then with the full suite, then with --test-threads=1, then on a loaded machine. Alone-passing and suite-failing is shared state. Failing only under parallelism is a resource collision. Failing only under load is a timing assumption. That sequence tells you which fix to write before you touch the code."
          ],
          "code": "// Flaky: races the wall clock and the scheduler.\n#[tokio::test]\nasync fn token_expires_after_ttl() {\n    let token = issue_token(Duration::from_secs(60));\n    tokio::time::sleep(Duration::from_secs(61)).await; // 61 s of CI time, still racy\n    assert!(!token.is_valid());\n}\n\n// Deterministic: paused time advances only when the test says so.\n#[tokio::test(start_paused = true)]\nasync fn token_expires_after_ttl() {\n    let token = issue_token(Duration::from_secs(60));\n\n    tokio::time::advance(Duration::from_secs(59)).await;\n    assert!(token.is_valid());\n\n    tokio::time::advance(Duration::from_secs(2)).await;\n    assert!(!token.is_valid());\n}",
          "tip": "start_paused = true makes tokio::time::sleep return immediately and advance the clock when the runtime is idle. It removes the sleep from the test and the flake with it."
        },
        {
          "h": "Isolation before cleverness",
          "p": [
            "Shared state is the most common cause and the easiest to remove: every test creates its own data with a unique key, its own temp directory, its own port. Where a global genuinely exists (an environment variable, a metrics registry, a process-wide logger), a serial-testing attribute is honest: it says this test cannot run concurrently, and it costs wall time rather than correctness.",
            "Random seeds are the same category. A test that uses rand::thread_rng and fails once a month is not testing randomness; it is being tested by it. Seed the generator from a fixed value in the test, and let property-based testing own the exploration, because proptest shrinks and records the seed it found."
          ],
          "code": "// Unique, per-test resources instead of shared constants.\nuse tempfile::TempDir;\nuse std::net::TcpListener;\n\n#[test]\nfn writes_report_to_its_own_directory() {\n    let dir = TempDir::new().expect(\"temp dir\");\n    let path = dir.path().join(\"report.json\");\n    write_report(&path, &sample()).expect(\"write\");\n    assert!(path.exists());\n    // TempDir removes the directory on drop, even if the assertion fails.\n}\n\n#[test]\nfn binds_an_ephemeral_port() {\n    let listener = TcpListener::bind(\"127.0.0.1:0\").expect(\"ephemeral\");\n    assert!(listener.local_addr().unwrap().port() > 0);\n}\n\n// When a process-wide resource truly is shared, say so explicitly:\n#[serial_test::serial]\n#[test]\nfn reads_environment_configuration() {\n    // Edition 2024: set_var and remove_var are unsafe precisely because they\n    // race with any thread that reads the environment.\n    unsafe { std::env::set_var(\"APP_MODE\", \"test\") };\n    assert_eq!(load_mode(), Mode::Test);\n    unsafe { std::env::remove_var(\"APP_MODE\") };\n}",
          "tip": "std::env::set_var is process-wide, and unsafe in edition 2024 for exactly that reason. If a test must set one, mark it serial instead of hoping the scheduler cooperates."
        },
        {
          "h": "Retries measure the problem; quarantine fixes it",
          "p": [
            "Automatic retries make a red build green without making the test correct. That can be acceptable as a short-lived measurement: a test that fails one run in fifty and passes on retry is telling you the flake rate, which is data. It becomes harmful the moment the retry is the permanent policy, because the suite now takes longer and the underlying race is still there.",
            "The policy that works: retries are enabled in CI only, every retried test is reported, and a test that needs a retry is quarantined within a week, either fixed or deleted with a tracking issue. A deleted test is honest; a permanently retried test is a false green that teaches the team to ignore failures."
          ],
          "code": "# .config/nextest.toml\n[profile.ci]\nretries = 2\nfail-fast = false\n\n[profile.ci.junit]\npath = \"junit.xml\"\n\n# run with the CI profile\n#   cargo nextest run --profile ci\n#\n# nextest marks a test that passed only after retrying as FLAKY in the\n# summary, which is the signal to quarantine it rather than celebrate.\n\n# reproduce a flake locally, in the order CI uses\ncargo nextest run --profile ci --no-capture <test_name>\ncargo test -- --test-threads=1 <test_name>",
          "tip": "Retries hide flakes from the pass/fail signal but not from the summary. Parse the FLAKY list and file a ticket per test; a number that nobody reads is not a policy."
        }
      ],
      "exercise": {
        "prompt": "This test fails about once in thirty runs on CI. Identify the cause class, rewrite it deterministically, and state what you would do with the retry setting.",
        "starter": "#[tokio::test]\nasync fn cache_entry_expires() {\n    let cache = Cache::new(Duration::from_millis(100));\n    cache.insert(\"k\", \"v\");\n    tokio::time::sleep(Duration::from_millis(120)).await;\n    assert!(cache.get(\"k\").is_none());\n}\n\n// 1. which of the three causes is this?\n// 2. rewrite with paused time\n// 3. what do you do with retries?",
        "hint": "It is a timing assumption: 120 ms of real sleep races the expiry check on a loaded runner. Use #[tokio::test(start_paused = true)] and tokio::time::advance. Keep CI retries as a temporary measurement, then quarantine.",
        "solution": "#[tokio::test(start_paused = true)]\nasync fn cache_entry_expires() {\n    let cache = Cache::new(Duration::from_millis(100));\n    cache.insert(\"k\", \"v\");\n\n    // Just before expiry: still present.\n    tokio::time::advance(Duration::from_millis(99)).await;\n    assert_eq!(cache.get(\"k\"), Some(\"v\"));\n\n    // Just after expiry: gone. No wall-clock sleep, no scheduler race.\n    tokio::time::advance(Duration::from_millis(2)).await;\n    assert!(cache.get(\"k\").is_none());\n}\n\n// Retries: keep them on for one release cycle as a measurement, watch the\n// FLAKY report, and quarantine anything that needs one. The fix above removes\n// the need for this test; the retry policy is for the next one."
      },
      "questions": [
        {
          "q": "A test passes alone and fails in the full suite. Which cause is most likely?",
          "options": [
            "Wall-clock timing",
            "Shared state or ordering between tests",
            "A compiler bug",
            "Insufficient retries"
          ],
          "answer": 1,
          "explain": "Isolation changes the result, which points at state another test left behind: a row, an env var, a global, a file at a fixed path."
        },
        {
          "q": "What does #[tokio::test(start_paused = true)] change?",
          "options": [
            "It disables the test timeout",
            "The runtime starts with a paused clock, so sleep returns when the runtime is idle and advance moves time explicitly",
            "It runs the test on a single thread",
            "It freezes std::time::Instant as well as tokio's clock"
          ],
          "answer": 1,
          "explain": "It pauses tokio's timer. Code using std::time::Instant or SystemTime still sees real time, which is why tests should use tokio::time::Instant where the clock is injected."
        },
        {
          "q": "When are automatic retries defensible?",
          "options": [
            "Whenever the suite is slow",
            "As a temporary measurement of flake rate, with every retried test reported and quarantined",
            "Permanently, because infrastructure is unreliable",
            "Only for integration tests"
          ],
          "answer": 1,
          "explain": "Retries convert a correctness signal into a noise signal. Used briefly and instrumented, they quantify the problem; used permanently, they hide it."
        }
      ],
      "quickbytes": [
        "Reproduce in this order: alone, full suite, --test-threads=1, under load.",
        "tokio::time::advance with start_paused replaces sleeps in async tests.",
        "Bind 127.0.0.1:0 and use TempDir instead of fixed ports and paths.",
        "cargo nextest reports tests that only passed after a retry as FLAKY."
      ],
      "production": [
        "No test sleeps for real time; clock-dependent code takes an injectable clock or uses paused tokio time.",
        "Every test owns its data, port and temp directory; process-wide state is marked serial explicitly.",
        "CI retries are capped and every retried test is reported and quarantined within a week.",
        "Flake rate is tracked per test so a newly flaky test is visible the day it appears."
      ],
      "crates": [
        "tokio",
        "tempfile",
        "serial_test",
        "rand"
      ],
      "github": [
        {
          "name": "nextest-rs/nextest",
          "url": "https://github.com/nextest-rs/nextest"
        },
        {
          "name": "tokio-rs/tokio (paused time)",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "pitfall": "Setting retries = 3 in CI and moving on: the suite now takes three times as long on a bad day, the race is still there, and a genuine regression that fails intermittently gets retried into a green build.",
      "resources": [
        {
          "title": "tokio::time: pause, advance and start_paused",
          "url": "https://docs.rs/tokio/latest/tokio/time/index.html",
          "kind": "docs"
        },
        {
          "title": "nextest configuration: retries and profiles",
          "url": "https://github.com/nextest-rs/nextest",
          "kind": "docs"
        },
        {
          "title": "Simple Testing Can Prevent Most Critical Failures (OSDI 2014)",
          "url": "https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-yuan.pdf",
          "kind": "paper"
        }
      ]
    },
    {
      "id": "i14",
      "n": 14,
      "title": "Mocking with mockall: seams, not stand-ins",
      "minutes": 80,
      "level": "advanced",
      "goal": "Introduce a trait seam for the collaborators you own, express call expectations with mockall, and recognize when a hand-written fake is the better tool.",
      "sections": [
        {
          "h": "A mock is a seam you designed",
          "p": [
            "mockall generates a Mock type from a trait, and each method gets an expectation builder. That only works if the code under test depends on a trait rather than a concrete client, so the real design work happens before the test: introduce a small trait at the boundary, implement it for the real client, and let tests substitute a mock. The trait should be narrow, because every method on it is a method the test must configure.",
            "The generated mock is named Mock plus the trait name, and #[automock] works on most traits and on structs with a single impl block. For traits you do not own (an external crate, a foreign function), use the mock! macro instead, which lets you declare the methods by hand."
          ],
          "code": "use mockall::automock;\n\n#[automock]\npub trait Clock {\n    fn now_millis(&self) -> u64;\n}\n\npub struct RateLimiter<C: Clock> {\n    clock: C,\n    window_ms: u64,\n}\n\nimpl<C: Clock> RateLimiter<C> {\n    pub fn new(clock: C, window_ms: u64) -> Self {\n        Self { clock, window_ms }\n    }\n\n    pub fn allow(&self, last_seen_ms: u64) -> bool {\n        self.clock.now_millis().saturating_sub(last_seen_ms) >= self.window_ms\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn rejects_a_second_request_inside_the_window() {\n        let mut clock = MockClock::new();\n        clock.expect_now_millis().times(1).return_const(1_000u64);\n\n        let limiter = RateLimiter::new(clock, 500);\n        assert!(!limiter.allow(900));\n    }\n}",
          "tip": "Keep the mocked trait small. A ten-method trait means every test configures ten expectations, and the mock becomes harder to maintain than the code it tests."
        },
        {
          "h": "Expectations are assertions about interaction",
          "p": [
            "times(1) asserts the call happened exactly once, never() asserts it did not, and a Sequence asserts order across one or more mocks. Those assertions are worth writing when the interaction is the contract: a commit must follow a write, a cache must not be consulted after a miss, a retry must not fire on a permanent error. They are noise when the interaction is incidental.",
            "Argument matching uses predicates: eq, function, and withf for a closure over references. If a test spends more lines configuring expectations than exercising behavior, the seam is in the wrong place or the collaborator is doing too much, and the test is telling you so."
          ],
          "code": "use mockall::{predicate::eq, Sequence};\n\n// MockStore and MockPayments come from #[automock] on this crate's own Store\n// and Payments traits; only the expectations differ from test to test.\n#[test]\nfn commit_happens_only_after_the_write_succeeds() {\n    let mut store = MockStore::new();\n    let mut seq = Sequence::new();\n\n    store\n        .expect_write()\n        .with(eq(\"order-1\"), eq(1_250_i64))\n        .times(1)\n        .in_sequence(&mut seq)\n        .returning(|_, _| Ok(()));\n\n    store\n        .expect_commit()\n        .times(1)\n        .in_sequence(&mut seq)\n        .returning(|| Ok(()));\n\n    place_order(&mut store, \"order-1\", 1_250).expect(\"order placed\");\n}\n\n#[test]\nfn permanent_error_is_not_retried() {\n    let mut client = MockPayments::new();\n    client\n        .expect_authorize()\n        .times(1) // exactly one attempt: no retry on a 402\n        .returning(|_, _| Err(PaymentError::Declined));\n\n    let err = charge(&mut client, \"order-1\", 1_250).unwrap_err();\n    assert!(matches!(err, PaymentError::Declined));\n}",
          "tip": "If a mock is only ever configured with .returning(...) and no call-count expectation, you wanted a stub. Say so in the test name; do not let the mock imply interaction checking that is not there."
        },
        {
          "h": "When a fake beats a mock",
          "p": [
            "A fake is a small working implementation with real behavior: an in-memory repository, a queue that actually queues, a clock you can set. Fakes test state and outcomes, they survive refactors that change the call sequence, and one fake serves twenty tests. Mocks test interactions, which is what you need when the interaction is the thing that can break.",
            "The failure mode of mocking is testing the mock: a test that asserts the code called save() proves the code called save(), not that anything was saved. If the collaborator has meaningful behavior (filtering, ordering, retries), write a fake. If the collaborator is a boundary with a side effect you cannot reproduce (a payment provider, an email sender), a mock with a call-count expectation is exactly right."
          ],
          "list": [
            "Mock the boundary you do not control: payments, email, clock, external HTTP",
            "Fake the collaborator you do control and whose behavior matters: repositories, queues, caches",
            "Never mock a type from a crate you cannot change; use mock! or wrap it in your own trait",
            "One expectation per behavior; a test that configures five calls is testing the wiring diagram"
          ]
        }
      ],
      "exercise": {
        "prompt": "Given a NotificationSender trait with a single send method, write a test proving that a failed notification does not fail the order, and a second test proving it is attempted exactly once.",
        "starter": "use mockall::automock;\n\n#[automock]\npub trait NotificationSender {\n    fn send(&self, to: &str, body: &str) -> Result<(), SendError>;\n}\n\npub fn place_order(sender: &dyn NotificationSender, order: &Order) -> Result<Receipt, OrderError> {\n    // persists the order, then best-effort notifies\n    todo!()\n}\n\n#[cfg(test)]\nmod tests {\n    // 1. sender returns Err, place_order still returns Ok\n    // 2. sender is called exactly once\n}",
        "hint": "Set expect_send().times(1).returning(|_, _| Err(SendError::Unavailable)) and assert place_order returns Ok. The times(1) is what proves the single attempt; the Ok assertion proves the failure was contained.",
        "solution": "use mockall::automock;\n\n#[automock]\npub trait NotificationSender {\n    fn send(&self, to: &str, body: &str) -> Result<(), SendError>;\n}\n\npub fn place_order(sender: &dyn NotificationSender, order: &Order) -> Result<Receipt, OrderError> {\n    let receipt = persist(order)?;\n    // Best effort: a notification failure must not roll back the order.\n    let _ = sender.send(&order.email, \"order confirmed\");\n    Ok(receipt)\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn notification_failure_does_not_fail_the_order() {\n        let mut sender = MockNotificationSender::new();\n        sender\n            .expect_send()\n            .times(1)\n            .returning(|_, _| Err(SendError::Unavailable));\n\n        let receipt = place_order(&sender, &sample_order()).expect(\"order still placed\");\n        assert!(receipt.id > 0);\n    }\n\n    #[test]\n    fn notification_is_attempted_once_per_order() {\n        let mut sender = MockNotificationSender::new();\n        sender.expect_send().times(1).returning(|_, _| Ok(()));\n\n        place_order(&sender, &sample_order()).expect(\"order placed\");\n        // The expectation is checked when the mock drops; times(1) fails the\n        // test if the sender was called zero or two times.\n    }\n}"
      },
      "questions": [
        {
          "q": "What does times(1) on an expectation assert?",
          "options": [
            "The method returns one value",
            "The method is called exactly once during the test, and the test fails otherwise",
            "The mock can be cloned once",
            "The method runs on one thread"
          ],
          "answer": 1,
          "explain": "Call counts are verified when the mock is dropped or checkpointed. Zero calls or two calls both fail, which is how you assert a retry did not happen."
        },
        {
          "q": "When is a hand-written fake better than a mockall mock?",
          "options": [
            "When the trait has more than one method",
            "When the collaborator's behavior matters and many tests need realistic state",
            "When the collaborator is an external payment API",
            "When the test needs to assert call order"
          ],
          "answer": 1,
          "explain": "A fake implements real behavior once and serves many tests. Mocks are best for boundaries whose interactions, not state, are the contract."
        },
        {
          "q": "A test asserts that repository.save() was called, but save() writes to a fake that silently discards data. What has the test proven?",
          "options": [
            "That the data was persisted",
            "That the code called save(), and nothing about the effect",
            "That the repository is correct",
            "That the transaction committed"
          ],
          "answer": 1,
          "explain": "Interaction assertions verify wiring. Whether persistence works is a property of the repository, which needs its own test against a real database."
        }
      ],
      "quickbytes": [
        "#[automock] on a trait generates MockTrait with one expect_* per method.",
        "A Sequence enforces order across mocks; use it only when order is the contract.",
        "mock! is for external traits and foreign functions that #[automock] cannot see.",
        "A mock with only .returning() is a stub; do not name it as if it checks calls."
      ],
      "production": [
        "Collaborators that cross a process boundary sit behind a narrow trait owned by your crate.",
        "Mocks assert call counts only where the interaction is the contract (retry, commit, notification).",
        "Repositories, queues and caches get fakes with real behavior, not mocks of every method.",
        "No test mocks a type from an external crate directly; it is wrapped in a local trait first."
      ],
      "crates": [
        "mockall",
        "tokio",
        "async-trait"
      ],
      "github": [
        {
          "name": "asomers/mockall",
          "url": "https://github.com/asomers/mockall"
        }
      ],
      "pitfall": "Mocking a whole repository trait with eight methods so that one test can assert a single call: the next change to the trait breaks twenty tests, none of which were testing the change.",
      "resources": [
        {
          "title": "mockall crate documentation",
          "url": "https://docs.rs/mockall/latest/mockall/",
          "kind": "docs"
        },
        {
          "title": "mockall repository and examples",
          "url": "https://github.com/asomers/mockall",
          "kind": "repo"
        },
        {
          "title": "The Rust Book: test doubles and testable design",
          "url": "https://doc.rust-lang.org/book/ch11-00-testing.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "i15",
      "n": 15,
      "title": "Fixtures and builders for readable test data",
      "minutes": 70,
      "level": "core",
      "goal": "Replace copy-pasted setup with rstest fixtures and table cases, and build test data with defaults plus overrides so each test states only what it cares about.",
      "sections": [
        {
          "h": "Fixtures remove setup, not clarity",
          "p": [
            "rstest lets a test declare the values it needs as arguments and resolves them from #[fixture] functions. The fixture can depend on other fixtures, so a database pool, a migrated schema and a seeded tenant compose without a single line of setup in the test body. The test then reads as the behavior it checks.",
            "The trap is a fixture that returns shared mutable state. If two tests receive the same pool and the same seeded rows, they are coupled through the database, and the suite becomes order-dependent. A fixture should create an isolated resource per call, or hand out a handle that namespaces per test."
          ],
          "code": "use rstest::{fixture, rstest};\n\n#[derive(Debug, Clone)]\npub struct Order {\n    pub id: u64,\n    pub sku: String,\n    pub qty: u32,\n    pub discount_bps: u16,\n}\n\nimpl Default for Order {\n    fn default() -> Self {\n        Self { id: 1, sku: \"SKU-1\".into(), qty: 1, discount_bps: 0 }\n    }\n}\n\nimpl Order {\n    pub fn with_qty(mut self, qty: u32) -> Self {\n        self.qty = qty;\n        self\n    }\n\n    pub fn with_discount_bps(mut self, bps: u16) -> Self {\n        self.discount_bps = bps;\n        self\n    }\n}\n\n#[fixture]\nfn order() -> Order {\n    Order::default()\n}\n\n// The unit under test: flat 1_000 cents per unit, discount applied later.\nfn line_total_cents(order: &Order) -> u64 {\n    1_000 * u64::from(order.qty)\n}\n\n#[rstest]\nfn a_default_order_is_a_single_unit(order: Order) {\n    assert_eq!(line_total_cents(&order), 1_000);\n}\n\n#[rstest]\nfn quantity_scales_the_line_total(order: Order) {\n    let order = order.with_qty(3);\n    assert_eq!(line_total_cents(&order), 3_000);\n}",
          "tip": "A builder method per field keeps test data readable: the test states the one value it changes and inherits everything else from Default."
        },
        {
          "h": "Table cases beat a wall of assertions",
          "p": [
            "rstest's #[case] generates one test per row, each with its own name and its own failure. That is strictly better than a loop inside one test, where the first failing row stops the rest and the failure message does not say which input produced it. #[values] does the same for the cross-product of several parameters.",
            "Keep rows to the boundary values and one representative interior value. A table with forty rows usually means the property should be a property test instead: tables are for a handful of named cases a reviewer should read, not for exhaustive coverage."
          ],
          "code": "#[rstest]\n#[case(0, 0)]\n#[case(1, 1_000)]\n#[case(3, 3_000)]\n#[case(1_000, 1_000_000)]\nfn line_total_scales_with_quantity(#[case] qty: u32, #[case] expected: u64) {\n    let order = Order::default().with_qty(qty);\n    assert_eq!(line_total_cents(&order), expected);\n}\n\n// One test per combination of the listed values.\n#[rstest]\nfn discount_never_exceeds_the_total(\n    #[values(0, 1, 500, 9_999, 10_000)] bps: u16,\n    #[values(1, 2, 100)] qty: u32,\n) {\n    let order = Order::default().with_qty(qty).with_discount_bps(bps);\n    assert!(line_total_cents(&order) <= 1_000 * u64::from(qty));\n}",
          "tip": "Each #[case] becomes a separate test in the output, so a failure names the row. A loop inside one #[test] cannot do that."
        },
        {
          "h": "Builders: defaults plus the one thing that matters",
          "p": [
            "A test that constructs a twelve-field struct to check one rule is unreadable and breaks on every field addition. Default plus builder methods fixes both: the struct gets a Default that is valid and boring, and each test overrides only the field under test. When a field is added, Default absorbs it and no test changes.",
            "The rule that keeps this honest: the default must be valid. A Default with a zero quantity or an empty id produces tests that pass for the wrong reason. Make the default a realistic, valid example, and let the test state the deviation."
          ],
          "list": [
            "Default returns a valid, realistic value, not a zeroed struct",
            "Builder methods are named after the field and consume self",
            "Tests override only the fields relevant to the behavior under test",
            "A fixture that needs a database creates its own schema or tenant per call"
          ]
        }
      ],
      "exercise": {
        "prompt": "Turn a test that builds a six-field Order by hand into a fixture plus builder version, and add a table test for three quantity values.",
        "starter": "fn test_order() -> Order {\n    Order {\n        id: 1,\n        sku: \"SKU-1\".to_string(),\n        qty: 1,\n        discount_bps: 0,\n        currency: \"EUR\".to_string(),\n        expedited: false,\n    }\n}\n\n#[test]\nfn total_for_three_units() {\n    let mut order = test_order();\n    order.qty = 3;\n    assert_eq!(line_total_cents(&order), 3_000);\n}\n\n// 1. implement Default for Order\n// 2. add with_qty\n// 3. write a #[rstest] table over qty 0, 1, 3",
        "hint": "impl Default for Order returns the same valid baseline. with_qty(mut self, qty: u32) -> Self sets the field and returns self. Then #[rstest] #[case(0, 0)] #[case(1, 1_000)] #[case(3, 3_000)] fn ...(#[case] qty: u32, #[case] expected: u64).",
        "solution": "impl Default for Order {\n    fn default() -> Self {\n        Self {\n            id: 1,\n            sku: \"SKU-1\".to_string(),\n            qty: 1,\n            discount_bps: 0,\n            currency: \"EUR\".to_string(),\n            expedited: false,\n        }\n    }\n}\n\nimpl Order {\n    pub fn with_qty(mut self, qty: u32) -> Self {\n        self.qty = qty;\n        self\n    }\n}\n\nuse rstest::rstest;\n\n#[rstest]\n#[case(0, 0)]\n#[case(1, 1_000)]\n#[case(3, 3_000)]\nfn line_total_scales_with_quantity(#[case] qty: u32, #[case] expected: u64) {\n    let order = Order::default().with_qty(qty);\n    assert_eq!(line_total_cents(&order), expected);\n}"
      },
      "questions": [
        {
          "q": "Why is a table of #[case] rows better than a loop inside one #[test]?",
          "options": [
            "It runs faster",
            "Each row becomes its own test, so failures name the row and one failure does not stop the others",
            "It allows more than one assertion per test",
            "It removes the need for fixtures"
          ],
          "answer": 1,
          "explain": "rstest generates a separate test function per case. The test name carries the inputs, and the harness reports each independently."
        },
        {
          "q": "What must be true of a Default implementation used as a test-data baseline?",
          "options": [
            "It must set every field to zero or empty",
            "It must produce a valid, realistic value so tests pass for the right reason",
            "It must be derived with #[derive(Default)]",
            "It must match the production default exactly"
          ],
          "answer": 1,
          "explain": "A zeroed baseline makes assertions accidentally true and hides bugs. The default should be a boring but legal example of the type."
        },
        {
          "q": "What is the risk of a fixture that returns a shared database pool with pre-seeded rows?",
          "options": [
            "The fixture is slower to compile",
            "Tests become coupled through shared state and the suite becomes order-dependent",
            "rstest cannot inject it",
            "The pool is dropped too early"
          ],
          "answer": 1,
          "explain": "Two tests mutating the same rows depend on execution order. The fixture should create an isolated schema or tenant per call."
        }
      ],
      "quickbytes": [
        "#[fixture] functions can take other fixtures as arguments.",
        "#[case(...)] generates one test per row; #[values(...)] generates the cross-product.",
        "Default plus with_* builders keeps test data readable as fields are added.",
        "A fixture that returns shared mutable state reintroduces order dependence."
      ],
      "production": [
        "Test data comes from Default plus builders, never from a hand-built struct with twelve fields.",
        "Fixtures create isolated resources per call; no shared pool with seeded rows across tests.",
        "Table cases cover boundaries plus one interior value, not an exhaustive matrix.",
        "Adding a field to a domain type does not require editing every test that builds it."
      ],
      "crates": [
        "rstest",
        "tempfile",
        "sqlx"
      ],
      "github": [
        {
          "name": "la10736/rstest",
          "url": "https://github.com/la10736/rstest"
        }
      ],
      "pitfall": "A Default implementation that returns qty: 0 and an empty sku: half the tests pass because the code short-circuits on empty input, and the discount path is never exercised.",
      "resources": [
        {
          "title": "rstest crate documentation",
          "url": "https://docs.rs/rstest/latest/rstest/",
          "kind": "docs"
        },
        {
          "title": "rstest repository and examples",
          "url": "https://github.com/la10736/rstest",
          "kind": "repo"
        },
        {
          "title": "The Rust Book: test organization and shared helpers",
          "url": "https://doc.rust-lang.org/book/ch11-03-test-organization.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "i16",
      "n": 16,
      "title": "CI test matrices that find real breakage",
      "minutes": 75,
      "level": "industry",
      "goal": "Choose matrix axes that correspond to actual failure modes, test feature combinations with cargo-hack, and keep the pipeline fast enough that people wait for it.",
      "sections": [
        {
          "h": "Every axis must correspond to a failure",
          "p": [
            "A matrix is not a virtue. Each axis multiplies cost, so each one needs a reason: operating systems catch path separators and platform APIs; the minimum supported Rust version catches accidental use of newer language features; feature combinations catch cfg-gated code that only compiles in the configuration nobody builds locally. An axis that has never failed and cannot plausibly fail is spending CI minutes for reassurance.",
            "The minimum supported Rust version deserves special mention because it is the axis teams forget. If Cargo.toml claims rust-version = 1.85 but CI only builds stable, the claim is untested and drifts within weeks. Pin the MSRV job to the exact version and treat a failure there as a release blocker, not a warning."
          ],
          "code": "name: test\non: [push, pull_request]\n\nconcurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\n\njobs:\n  test:\n    strategy:\n      fail-fast: false\n      matrix:\n        os: [ubuntu-latest, macos-latest]\n        # 1.85 is the first edition-2024 toolchain; substitute your own MSRV.\n        rust: [\"1.85.0\", \"stable\"]\n    runs-on: ${{ matrix.os }}\n    steps:\n      - uses: actions/checkout@v4\n      - uses: dtolnay/rust-toolchain@stable\n        with:\n          toolchain: ${{ matrix.rust }}\n      - uses: Swatinem/rust-cache@v2\n      - run: cargo test --workspace --all-targets\n\n  features:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: dtolnay/rust-toolchain@stable\n      - uses: Swatinem/rust-cache@v2\n      - run: cargo install cargo-hack --locked\n      - run: cargo hack test --workspace --feature-powerset --depth 2",
          "tip": "fail-fast: false keeps the whole matrix running so one red cell does not hide the others. With fail-fast on, the first failure cancels the evidence you needed."
        },
        {
          "h": "Feature powersets, with a depth limit",
          "p": [
            "The default build enables default features. Users disable them, or enable one optional feature alone, and that configuration is where the breakage lives: a cfg-gated import that is missing, a trait impl behind the wrong feature, a doc test that only compiles with everything on. `cargo hack --feature-powerset` builds each combination; `--depth 2` limits it to pairs, which catches most real interactions without the exponential blowup.",
            "Combine the powerset with `--all-targets` and a separate doc-test run, because doc tests are compiled per crate and are not part of `cargo test --all-targets` in the same way. If the powerset is still too slow, run it nightly and keep a reduced version (each feature alone) on pull requests."
          ],
          "code": "# every feature alone, then all features together\ncargo hack test --each-feature --workspace\ncargo test --workspace --all-features\n\n# pairs of features: most cfg interactions show up here\ncargo hack test --workspace --feature-powerset --depth 2\n\n# include optional dependencies as features\ncargo hack test --workspace --feature-powerset --optional-deps\n\n# doc tests are a separate compile pass; run them explicitly\ncargo test --workspace --all-features --doc\n\n# what would run, without running it\ncargo hack test --workspace --feature-powerset --depth 2 --dry-run",
          "tip": "--depth 2 is the practical default. Depth 3 on a crate with ten features is a thousand builds, and almost none of them fail for a reason depth 2 missed."
        },
        {
          "h": "Speed is a feature of the pipeline",
          "p": [
            "A pipeline nobody waits for is a pipeline nobody fixes. Three things dominate: rebuilding dependencies on every run (cache them), running tests in one giant job (split by concern so they parallelize), and paying for retries that mask flakes. nextest runs each test in its own process and parallelizes better than the built-in harness, which usually cuts wall time substantially on a large suite.",
            "Set timeouts on every job. A hanging test that burns six hours of runner time is worse than a failing test, because it delays every queued job behind it. And cancel superseded runs: a push to a branch with three more commits behind it does not need to finish."
          ],
          "list": [
            "Cache the registry, the git index and target/ keyed by lockfile hash",
            "Split unit, integration, doc and feature jobs so they run concurrently",
            "Set timeout-minutes on every job; a hang should cost minutes, not hours",
            "Cancel in-progress runs for superseded commits"
          ]
        }
      ],
      "exercise": {
        "prompt": "Design a matrix for a crate that supports Linux and macOS, claims MSRV 1.85, has three optional features, and must stay under ten minutes. Name each axis and justify it, then write the feature job.",
        "starter": "jobs:\n  test:\n    strategy:\n      matrix:\n        os: ???\n        rust: ???\n  features:\n    runs-on: ubuntu-latest\n    steps:\n      # cargo hack feature powerset\n\n# Justify: why each axis exists.",
        "hint": "os: [ubuntu-latest, macos-latest]; rust: [\"1.85.0\", \"stable\"]. Full 2x2 on PRs, macOS only on main if time is tight. Feature job: cargo install cargo-hack then cargo hack test --feature-powerset --depth 2.",
        "solution": "jobs:\n  test:\n    strategy:\n      fail-fast: false\n      matrix:\n        os: [ubuntu-latest, macos-latest]   # path separators, platform APIs\n        rust: [\"1.85.0\", \"stable\"]         # MSRV claim + current compiler\n    runs-on: ${{ matrix.os }}\n    timeout-minutes: 20\n    steps:\n      - uses: actions/checkout@v4\n      - uses: dtolnay/rust-toolchain@stable\n        with:\n          toolchain: ${{ matrix.rust }}\n      - uses: Swatinem/rust-cache@v2\n      - run: cargo test --workspace --all-targets\n\n  features:\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n    steps:\n      - uses: actions/checkout@v4\n      - uses: dtolnay/rust-toolchain@stable\n      - uses: Swatinem/rust-cache@v2\n      - run: cargo install cargo-hack --locked\n      - run: cargo hack test --workspace --feature-powerset --depth 2\n\n  docs:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    steps:\n      - uses: actions/checkout@v4\n      - uses: dtolnay/rust-toolchain@stable\n      - run: cargo test --workspace --all-features --doc\n\n# Axes and why:\n#  ubuntu  - the deployment target, fastest runner\n#  macos   - catches path and platform-API assumptions\n#  1.85.0  - the MSRV the manifest claims; untested claims rot\n#  stable  - what developers actually use\n#  features - cfg-gated code only compiles in some combinations"
      },
      "questions": [
        {
          "q": "Why is an MSRV job necessary if CI already builds on stable?",
          "options": [
            "Stable is slower than the MSRV toolchain",
            "The rust-version claim in Cargo.toml is otherwise untested and drifts as newer language features slip in",
            "MSRV builds catch more bugs",
            "Cargo refuses to build without it"
          ],
          "answer": 1,
          "explain": "A declared minimum version is a promise to downstream users. Only a job pinned to that exact version keeps it true."
        },
        {
          "q": "What does cargo hack test --feature-powerset --depth 2 do?",
          "options": [
            "Runs each test twice for stability",
            "Builds and tests every combination of up to two features",
            "Enables the two most important features only",
            "Runs the test suite on two toolchains"
          ],
          "answer": 1,
          "explain": "It enumerates feature combinations limited to pairs, which catches most cfg-gated breakage without the combinatorial explosion of deeper sets."
        },
        {
          "q": "What is the cost of fail-fast: true on a test matrix?",
          "options": [
            "It makes the matrix slower",
            "The first failing cell cancels the rest, hiding whether other configurations also fail",
            "It disables caching",
            "It skips the MSRV job"
          ],
          "answer": 1,
          "explain": "You want all cells' results from one run. fail-fast: false costs minutes and saves a round trip of discovery."
        }
      ],
      "quickbytes": [
        "cargo hack test --each-feature --workspace checks one feature at a time.",
        "Set timeout-minutes on every job so a hang cannot burn hours.",
        "concurrency.cancel-in-progress saves the whole run for superseded commits.",
        "Doc tests are a separate compile pass: run cargo test --doc explicitly."
      ],
      "production": [
        "Each matrix axis maps to a documented failure mode; axes that never fail are removed.",
        "The MSRV job runs the exact version declared in Cargo.toml and blocks release.",
        "Feature powersets run at depth 2 on PRs and full depth nightly.",
        "Every job has a timeout and superseded runs are cancelled."
      ],
      "crates": [
        "cargo-hack",
        "cargo-nextest",
        "tokio"
      ],
      "github": [
        {
          "name": "taiki-e/cargo-hack",
          "url": "https://github.com/taiki-e/cargo-hack"
        },
        {
          "name": "nextest-rs/nextest",
          "url": "https://github.com/nextest-rs/nextest"
        }
      ],
      "pitfall": "A five-axis matrix that only ever builds with all features enabled: the cfg-gated import that breaks the minimal build reaches users who disabled default features, and CI never saw it.",
      "resources": [
        {
          "title": "cargo-hack: feature powerset testing",
          "url": "https://github.com/taiki-e/cargo-hack",
          "kind": "repo"
        },
        {
          "title": "The Cargo Book: features and feature unification",
          "url": "https://doc.rust-lang.org/cargo/reference/features.html",
          "kind": "docs"
        },
        {
          "title": "The Cargo Book: rust-version and MSRV",
          "url": "https://doc.rust-lang.org/cargo/reference/manifest.html",
          "kind": "docs"
        },
        {
          "title": "nextest: faster test runs with per-test processes",
          "url": "https://github.com/nextest-rs/nextest",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "i17",
      "n": 17,
      "title": "Benchmark-driven testing with criterion",
      "minutes": 85,
      "level": "advanced",
      "goal": "Measure a function's distribution rather than its average, prevent the optimizer from deleting the work, and build a regression gate that does not flake on shared runners.",
      "sections": [
        {
          "h": "Criterion measures a distribution",
          "p": [
            "criterion warms up, samples many iterations, and reports a confidence interval plus an outlier analysis, then compares against the previous run and says whether the change is statistically distinguishable from noise. That comparison is the point: a single timing number on a shared machine is mostly noise, and criterion's job is to tell you when it is not.",
            "The setup is two lines of macros in a bench target with harness = false. Every input must pass through std::hint::black_box, because the optimizer is allowed to precompute a pure function on a constant argument and delete the loop entirely. A benchmark that measures nothing runs very fast and looks like a great optimization."
          ],
          "code": "use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};\nuse std::hint::black_box;\n\nfn bench_decode(c: &mut Criterion) {\n    let mut group = c.benchmark_group(\"decode\");\n\n    for size in [64usize, 1_024, 65_536] {\n        let frame = build_frame(size);\n        group.throughput(Throughput::Bytes(size as u64));\n        group.bench_with_input(BenchmarkId::from_parameter(size), &frame, |b, frame| {\n            b.iter(|| decode(black_box(frame)));\n        });\n    }\n\n    group.finish();\n}\n\ncriterion_group!(benches, bench_decode);\ncriterion_main!(benches);\n\n// Cargo.toml\n// [[bench]]\n// name = \"codec\"\n// harness = false\n//\n// [dev-dependencies]\n// criterion = { version = \"0.8\", features = [\"html_reports\"] }",
          "tip": "criterion 0.8 deprecates its own black_box in favour of std::hint::black_box, which has been stable since Rust 1.66. Use the std one."
        },
        {
          "h": "Baselines, not absolute numbers",
          "p": [
            "Save a named baseline on the branch you consider healthy, then compare against it. criterion reports change percentages with a verdict (improved, regressed, no change) based on whether the confidence intervals overlap, which is a far better gate than comparing two floating point numbers with a threshold you invented.",
            "For CI, remember what a shared runner is: a noisy neighbour machine with variable CPU frequency and steal time. A wall-clock gate there will flake. The stable options are to run benchmarks on a dedicated runner, to gate on instruction counts (a callgrind-based profiler such as iai-callgrind gives deterministic numbers), or to treat wall-clock changes as advisory and gate only on large regressions with a wide tolerance."
          ],
          "code": "# first run: record the baseline\ncargo bench --bench codec -- --save-baseline main\n\n# after the change: compare against it\ncargo bench --bench codec -- --baseline main\n\n# quick local loop: fewer samples, no plots\ncargo bench --bench codec -- --quick\n\n# sample size and measurement time\ncargo bench --bench codec -- --sample-size 50 --measurement-time 10",
          "tip": "--quick is for iterating on the benchmark itself. Never gate on a --quick run: fewer samples means wider intervals and a verdict that swings."
        },
        {
          "h": "Benchmark the thing you are optimizing",
          "p": [
            "Two mistakes dominate. First, measuring setup: constructing the input inside the benchmark loop, so you measure allocation and parsing rather than the function. Use iter_batched when the input must be fresh per iteration, and plain iter when it can be reused. Second, benchmarking a micro-detail while the real cost is a syscall or a lock, which produces a beautiful improvement that does not move the p99.",
            "Tie each benchmark to a decision. If a change cannot plausibly move this number, the benchmark is documentation, not a test. Keep a small set that covers the hot paths you actually tune, and let profiling find the hot path rather than intuition."
          ],
          "list": [
            "black_box every input and every result the optimizer could elide",
            "iter_batched for inputs that must be constructed per iteration",
            "Throughput::Bytes or Elements so the report shows cost per unit, not just per call",
            "Gate on baselines with tolerance; a fixed millisecond threshold on a shared runner flakes"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a criterion benchmark for a `sum_prefix` function over three input sizes, report throughput in bytes, and save a baseline called main. Then explain why a CI gate on absolute milliseconds is a bad idea.",
        "starter": "use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};\nuse std::hint::black_box;\n\nfn bench_sum_prefix(c: &mut Criterion) {\n    // 1. group, three sizes\n    // 2. throughput in bytes\n    // 3. bench_with_input + black_box\n}\n\ncriterion_group!(benches, bench_sum_prefix);\ncriterion_main!(benches);",
        "hint": "group.throughput(Throughput::Bytes(size as u64)) then bench_with_input(BenchmarkId::from_parameter(size), &data, |b, data| b.iter(|| sum_prefix(black_box(data)))). Run with --save-baseline main.",
        "solution": "use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};\nuse std::hint::black_box;\n\nfn bench_sum_prefix(c: &mut Criterion) {\n    let mut group = c.benchmark_group(\"sum_prefix\");\n\n    for size in [1_024usize, 65_536, 1_048_576] {\n        let data: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();\n        group.throughput(Throughput::Bytes(size as u64));\n        group.bench_with_input(BenchmarkId::from_parameter(size), &data, |b, data| {\n            b.iter(|| sum_prefix(black_box(data)));\n        });\n    }\n\n    group.finish();\n}\n\ncriterion_group!(benches, bench_sum_prefix);\ncriterion_main!(benches);\n\n// cargo bench --bench prefix -- --save-baseline main\n//\n// Why not gate on absolute milliseconds in CI: shared runners have variable\n// CPU frequency, noisy neighbours and steal time, so the same commit can\n// move 15% between runs. Gate on a saved baseline with criterion's own\n// statistical verdict, on a dedicated runner, or on deterministic\n// instruction counts."
      },
      "questions": [
        {
          "q": "Why must benchmark inputs go through black_box?",
          "options": [
            "It prevents integer overflow",
            "It stops the optimizer from precomputing the call on a constant input and removing the work",
            "It disables CPU frequency scaling",
            "It makes criterion report confidence intervals"
          ],
          "answer": 1,
          "explain": "Without an opaque barrier the compiler can hoist or eliminate pure computation, so the benchmark measures an empty loop and reports an implausible speedup."
        },
        {
          "q": "When should you use iter_batched instead of iter?",
          "options": [
            "When the benchmark must run on multiple threads",
            "When each iteration needs a freshly constructed input that should not be counted in the measurement",
            "When the function is async",
            "When the input is larger than one cache line"
          ],
          "answer": 1,
          "explain": "iter_batched separates setup from the timed routine, so allocation and construction do not contaminate the number you are trying to track."
        },
        {
          "q": "Why does an absolute millisecond threshold in CI flake?",
          "options": [
            "criterion does not report milliseconds",
            "Shared runners vary in CPU frequency, neighbours and steal time, so run-to-run noise exceeds typical regressions",
            "Cargo rebuilds benchmarks every run",
            "Thresholds are not supported by the bench harness"
          ],
          "answer": 1,
          "explain": "Noise on shared hardware is often larger than the effect you want to detect. Compare against a baseline with statistical tolerance, or use deterministic instruction counts."
        }
      ],
      "quickbytes": [
        "harness = false is required for a criterion bench target.",
        "cargo bench -- --save-baseline main then --baseline main compares runs.",
        "std::hint::black_box replaces the deprecated criterion::black_box.",
        "Throughput::Bytes turns the report into cost per byte, which is comparable across sizes."
      ],
      "production": [
        "Benchmarks exist for the hot paths that profiling identified, not for every public function.",
        "Every benchmarked input and result passes through black_box.",
        "CI compares against a saved baseline with tolerance, or runs on dedicated hardware.",
        "Benchmark regressions of more than the agreed tolerance are investigated before release, not after."
      ],
      "crates": [
        "criterion",
        "tokio",
        "divan"
      ],
      "github": [
        {
          "name": "criterion-rs/criterion.rs",
          "url": "https://github.com/criterion-rs/criterion.rs"
        }
      ],
      "pitfall": "A benchmark that builds its input inside the timed loop: the number tracks allocator behavior and cache warmth more than the function, and an optimization to the function moves it by two percent.",
      "resources": [
        {
          "title": "criterion crate documentation",
          "url": "https://docs.rs/criterion/latest/criterion/",
          "kind": "docs"
        },
        {
          "title": "criterion.rs repository and user guide",
          "url": "https://github.com/criterion-rs/criterion.rs",
          "kind": "repo"
        },
        {
          "title": "std::hint::black_box",
          "url": "https://doc.rust-lang.org/std/hint/fn.black_box.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "i18",
      "n": 18,
      "title": "Golden files for CLI and rendered output",
      "minutes": 65,
      "level": "advanced",
      "goal": "Pin whole-output behavior with trycmd cases, regenerate them deliberately instead of by accident, and keep goldens small enough that a human reviews every diff.",
      "sections": [
        {
          "h": "When the output is the contract",
          "p": [
            "Some behavior is a document: --help text, an error message a script greps, a rendered config, a generated report. Asserting it field by field is both tedious and incomplete, because the thing users depend on is the whole shape. A golden file stores the exact expected output and fails on any difference, which makes it the right tool for output that is meant to be stable and reviewed.",
            "The cost is obvious and must be managed: every intentional change breaks the golden, and the fix is to regenerate. If regeneration is a single command and the diff is small, that is a healthy workflow. If the golden is four hundred lines and regenerating is a ritual, nobody reads the diff and the test becomes a change detector rather than a behavior test."
          ],
          "code": "// tests/cli_tests.rs — one test that runs a herd of cases\n#[test]\nfn cli_tests() {\n    trycmd::TestCases::new()\n        .case(\"tests/cmd/*.trycmd\")\n        .case(\"README.md\"); // examples in the README are tested too\n}\n\n// tests/cmd/add.trycmd — the file itself is the expectation\n// $ mycli add --name ferris\n// added ferris\n//\n// $ mycli add --name \"\"\n// ? failed\n// error: name must not be empty\n//\n// $ mycli list --format json\n// [..]\n// {\"name\": \"ferris\"}\n// [..]",
          "tip": "The `? failed` line asserts a non-zero exit code; `? 2` asserts the exact code. Testing the exit status is half of what a CLI contract means."
        },
        {
          "h": "Elision: keep the golden about the contract",
          "p": [
            "Output contains volatile parts: absolute paths, temp directory names, durations, versions. trycmd supports elision so the golden can assert the stable structure and ignore the rest: `[..]` matches any characters on a line, `...` matches whole lines, `[EXE]` handles the Windows extension, and `[ROOT]` and `[CWD]` normalize paths. Using them keeps a golden portable across machines and operating systems.",
            "Elide aggressively and assert specifically. A golden full of [..] protects almost nothing; a golden with no elision fails on every machine but the author's. The useful middle is: exact text for messages and structure, elision only for values that legitimately vary, and a separate assertion for anything numeric that matters."
          ],
          "code": "# regenerate all expectations from the current binary\nTRYCMD=overwrite cargo test --test cli_tests\n\n# write new expectations into a dump/ directory for review first\nTRYCMD=dump cargo test --test cli_tests\n\n# run a subset by name\ncargo test --test cli_tests -- cli_tests trycmd=add trycmd=list\n\n# debug what trycmd is doing\ncargo test --test cli_tests -F trycmd/debug\n\n# elision tokens inside a .trycmd or .stdout file\n#   [..]      any characters within a line\n#   ...       any number of whole lines\n#   [EXE]     .exe on Windows, nothing elsewhere\n#   [ROOT]    the test's root directory\n#   [CWD]     the current directory under the root",
          "tip": "TRYCMD=overwrite is a deliberate act. If it runs automatically in CI, every golden matches whatever the binary printed, and the suite stops being an assertion."
        },
        {
          "h": "Reviewing a golden diff",
          "p": [
            "Treat a golden diff exactly like a code diff: it is the specification changing. If a PR contains a golden update with no explanation, ask what changed in behavior. The healthy pattern is a golden change accompanied by a sentence in the PR description and, ideally, a changelog entry, because users see this text.",
            "Keep one case per behavior so the diff points at one thing. A single mega-case that runs ten commands and asserts their combined output produces a diff where you cannot tell which command changed, and the reviewer approves it out of exhaustion. Small goldens are the only ones that get read."
          ],
          "list": [
            "One trycmd case per command or error path, not one per binary",
            "Elide paths, timings and versions; assert messages and exit codes exactly",
            "Regeneration is a separate commit or at least a visible diff in the PR",
            "Goldens that no longer describe intended behavior are deleted, not kept green"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a trycmd case for a CLI with two behaviors: a successful `add` printing a confirmation, and an empty name exiting non-zero with an error message. Use elision only where the output is genuinely machine-specific.",
        "starter": "// tests/cli_tests.rs\n#[test]\nfn cli_tests() {\n    // point TestCases at tests/cmd/*.trycmd\n}\n\n// tests/cmd/add.trycmd\n// $ mycli add --name ferris\n// ???\n// $ mycli add --name \"\"\n// ???",
        "hint": "Each command starts with $ and the following lines are the expected stdout/stderr. Use `? failed` after the second command to assert a non-zero exit, then the error text.",
        "solution": "// tests/cli_tests.rs\n#[test]\nfn cli_tests() {\n    trycmd::TestCases::new().case(\"tests/cmd/*.trycmd\");\n}\n\n// tests/cmd/add.trycmd\n// $ mycli add --name ferris\n// added ferris\n//\n// $ mycli add --name \"\"\n// ? failed\n// error: name must not be empty\n//\n// $ mycli list --format json\n// [..]\n// {\"name\": \"ferris\"}\n// [..]\n\n// Regenerate deliberately, never in CI:\n//   TRYCMD=overwrite cargo test --test cli_tests"
      },
      "questions": [
        {
          "q": "What does the line `? failed` in a trycmd case assert?",
          "options": [
            "The command printed the word failed",
            "The command exited with a non-zero status",
            "The test is expected to fail",
            "The command timed out"
          ],
          "answer": 1,
          "explain": "The `?` prefix declares the expected exit status: success by default, failed for non-zero, or an exact code. It is part of the CLI contract."
        },
        {
          "q": "Why should TRYCMD=overwrite never run automatically in CI?",
          "options": [
            "It is slower than the default mode",
            "It rewrites expectations to match whatever the binary produced, so nothing is asserted",
            "It deletes the test cases",
            "It requires a network connection"
          ],
          "answer": 1,
          "explain": "Regeneration is an act of approval. Automating it turns the golden into a recording of current output and removes the failure signal."
        },
        {
          "q": "A golden contains an absolute temp path and fails on every machine but the author's. What is the fix?",
          "options": [
            "Delete the test",
            "Use the [ROOT] or [CWD] elision token so the path is normalized",
            "Run the tests only on that machine",
            "Set a fixed TMPDIR in CI"
          ],
          "answer": 1,
          "explain": "trycmd's elision tokens normalize machine-specific values while keeping the rest of the output exact."
        }
      ],
      "quickbytes": [
        "TRYCMD=overwrite regenerates; TRYCMD=dump writes candidates for review first.",
        "`? failed` asserts a non-zero exit; `? 2` asserts the exact code.",
        "[..] elides within a line, ... elides whole lines, [ROOT] and [CWD] normalize paths.",
        "trycmd can also run the fenced examples in your README."
      ],
      "production": [
        "CLI output and error messages are covered by trycmd cases that assert exit codes.",
        "Goldens are small and one-per-behavior so a diff identifies a single change.",
        "Regeneration is a reviewed change with an explanation, never an automatic CI step.",
        "Machine-specific values are elided with tokens rather than deleted from the output."
      ],
      "crates": [
        "trycmd",
        "assert_cmd",
        "insta"
      ],
      "github": [
        {
          "name": "assert-rs/snapbox (home of trycmd)",
          "url": "https://github.com/assert-rs/snapbox"
        }
      ],
      "pitfall": "One giant golden covering ten commands: a change to one message produces a diff nobody can attribute, and reviewers approve it blind until the golden no longer reflects intended behavior.",
      "resources": [
        {
          "title": "trycmd crate documentation",
          "url": "https://docs.rs/trycmd/latest/trycmd/",
          "kind": "docs"
        },
        {
          "title": "snapbox: the assertion library behind trycmd",
          "url": "https://github.com/assert-rs/snapbox",
          "kind": "repo"
        },
        {
          "title": "assert_cmd: for individual CLI assertions",
          "url": "https://docs.rs/assert_cmd/latest/assert_cmd/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "i19",
      "n": 19,
      "title": "Concurrency testing with loom",
      "minutes": 95,
      "level": "industry",
      "goal": "Model-check a lock-free structure with loom's deterministic scheduler, wire the cfg(loom) type switch, and state the executions loom cannot explore.",
      "sections": [
        {
          "h": "Stress testing samples; loom enumerates",
          "p": [
            "Running a concurrent test a million times samples a few interleavings out of an astronomical space, and the bug lives in the one you did not hit. loom replaces the scheduler and the atomics, then systematically explores the executions allowed by the C11 memory model, using state reduction to avoid re-running equivalent ones. When it finds a failing interleaving it can replay it deterministically.",
            "That determinism is the real feature. A stress-test failure gives you a stack trace and no idea which ordering caused it; a loom failure gives you an execution you can replay with a checkpoint file, then step through with logging enabled."
          ],
          "code": "// src/sync.rs — one module that picks the implementation.\n#[cfg(loom)]\npub(crate) use loom::sync::atomic::{AtomicBool, AtomicUsize, Ordering};\n#[cfg(not(loom))]\npub(crate) use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};\n\n// tests/loom_handoff.rs\n#![cfg(loom)]\n\nuse loom::sync::atomic::{AtomicBool, AtomicUsize, Ordering};\nuse loom::sync::Arc;\nuse loom::thread;\n\n#[test]\nfn a_reader_that_sees_ready_also_sees_the_value() {\n    loom::model(|| {\n        let value = Arc::new(AtomicUsize::new(0));\n        let ready = Arc::new(AtomicBool::new(false));\n\n        let writer = {\n            let value = value.clone();\n            let ready = ready.clone();\n            thread::spawn(move || {\n                value.store(42, Ordering::Release);\n                ready.store(true, Ordering::Release);\n            })\n        };\n\n        if ready.load(Ordering::Acquire) {\n            assert_eq!(value.load(Ordering::Acquire), 42);\n        }\n\n        writer.join().unwrap();\n    });\n}",
          "tip": "Swap both Release/Acquire pairs for Relaxed and re-run: the ordering guarantee is gone, and that is exactly the change loom exists to catch."
        },
        {
          "h": "Running loom is a separate command",
          "p": [
            "loom's types only exist when the loom cfg is set, so loom tests must be compiled with RUSTFLAGS set and a cfg flag defined. Keeping them in a separate integration test file (tests/loom_*.rs) means the normal suite never pays for them and never fails to compile because loom is absent.",
            "The state space explodes with threads and operations, so two knobs matter: MAX_THREADS bounds how many threads loom can model, and the preemption bound (LOOM_MAX_PREEMPTIONS) limits exploration to executions with at most n forced switches. A bound of 2 or 3 catches most real bugs at a fraction of the cost; exhaustive exploration is for small models only."
          ],
          "code": "# run only the loom test, with the cfg set and optimizations on\nRUSTFLAGS=\"--cfg loom\" cargo test --test loom_handoff --release\n\n# bound the search: at most 3 preemptions per execution\nLOOM_MAX_PREEMPTIONS=3 RUSTFLAGS=\"--cfg loom\" \\\n  cargo test --test loom_handoff --release\n\n# replay the exact failing execution\nLOOM_CHECKPOINT_FILE=handoff.json LOOM_CHECKPOINT_INTERVAL=10000 \\\n  RUSTFLAGS=\"--cfg loom\" cargo test --test loom_handoff --release\n\n# then step through it with logging\nLOOM_LOG=trace LOOM_LOCATION=1 LOOM_CHECKPOINT_INTERVAL=1 \\\n  LOOM_CHECKPOINT_FILE=handoff.json RUSTFLAGS=\"--cfg loom\" \\\n  cargo test --test loom_handoff --release",
          "tip": "Run loom in release mode. It executes the closure thousands of times, and the optimized build turns a ten-minute check into a ten-second one."
        },
        {
          "h": "The edges of the model",
          "p": [
            "loom cannot model relaxed-memory reorderings that happen within a single thread, because its scheduler operates between operations, not inside them. It also cannot model syscalls, allocation behavior, or your async runtime: code that awaits inside a loom closure is outside the model. And it caps the number of threads it will explore.",
            "So loom complements rather than replaces other tests. Use it for the small, self-contained primitives you wrote: a lock-free queue, a handoff flag, a reference-counted cache. Use tokio's multi-threaded runtime plus a paused clock and targeted stress loops for runtime-level behavior, and use property tests for the sequential contract of the same type."
          ],
          "list": [
            "Model the primitive, not the whole service; loom closures must be deterministic",
            "Keep loom tests in their own files behind #![cfg(loom)]",
            "Bound preemptions for anything with more than two threads",
            "Pair loom with a stress test and a sequential property test; each catches different bugs"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a loom model that checks a one-shot channel handoff: a writer stores a value and sets a flag, and a reader that observes the flag must observe the value. Then give the command that runs it with a preemption bound of 2.",
        "starter": "// tests/loom_flag.rs\n#![cfg(loom)]\n\nuse loom::sync::atomic::{AtomicBool, AtomicUsize, Ordering};\nuse loom::sync::Arc;\nuse loom::thread;\n\n#[test]\nfn reader_sees_value_when_flag_is_set() {\n    loom::model(|| {\n        // 1. shared AtomicUsize + AtomicBool\n        // 2. writer thread: store value, then flag\n        // 3. reader: if flag, assert value\n        // 4. join\n    });\n}",
        "hint": "Use Ordering::Release for both stores and Ordering::Acquire for both loads. Then run: LOOM_MAX_PREEMPTIONS=2 RUSTFLAGS=\"--cfg loom\" cargo test --test loom_flag --release.",
        "solution": "// tests/loom_flag.rs\n#![cfg(loom)]\n\nuse loom::sync::atomic::{AtomicBool, AtomicUsize, Ordering};\nuse loom::sync::Arc;\nuse loom::thread;\n\n#[test]\nfn reader_sees_value_when_flag_is_set() {\n    loom::model(|| {\n        let value = Arc::new(AtomicUsize::new(0));\n        let ready = Arc::new(AtomicBool::new(false));\n\n        let writer = {\n            let value = value.clone();\n            let ready = ready.clone();\n            thread::spawn(move || {\n                value.store(42, Ordering::Release);\n                ready.store(true, Ordering::Release);\n            })\n        };\n\n        if ready.load(Ordering::Acquire) {\n            assert_eq!(value.load(Ordering::Acquire), 42);\n        }\n\n        writer.join().unwrap();\n    });\n}\n\n// LOOM_MAX_PREEMPTIONS=2 RUSTFLAGS=\"--cfg loom\" \\\n//   cargo test --test loom_flag --release"
      },
      "questions": [
        {
          "q": "What does loom explore that a stress test does not?",
          "options": [
            "More iterations per second",
            "Systematically enumerated interleavings allowed by the memory model, with state reduction",
            "Real hardware memory barriers",
            "Kernel scheduling decisions"
          ],
          "answer": 1,
          "explain": "loom simulates the scheduler and atomics, then enumerates distinct executions rather than sampling. It also replays a failing one deterministically."
        },
        {
          "q": "Why must loom tests be compiled with RUSTFLAGS=\"--cfg loom\"?",
          "options": [
            "loom requires nightly features",
            "The crate's code selects loom's types instead of std's only when that cfg is set",
            "It enables link-time optimization",
            "It turns off debug assertions"
          ],
          "answer": 1,
          "explain": "loom's types only exist in the model. The cfg switches the crate's sync module to them, and the loom test file is excluded entirely otherwise."
        },
        {
          "q": "Which bug is loom least likely to find?",
          "options": [
            "A missing Acquire on a flag read",
            "A deadlock between two mutexes taken in opposite orders",
            "A reordering that is only possible under relaxed ordering within a single thread",
            "A race between a store and a load on the same atomic"
          ],
          "answer": 2,
          "explain": "loom schedules between operations; it cannot emulate a compiler or CPU reordering operations inside one thread, which is a documented limitation of the model."
        }
      ],
      "quickbytes": [
        "RUSTFLAGS=\"--cfg loom\" cargo test --test loom_x --release is the canonical invocation.",
        "LOOM_MAX_PREEMPTIONS=2 or 3 keeps large models tractable.",
        "LOOM_CHECKPOINT_FILE plus LOOM_CHECKPOINT_INTERVAL=1 replays the failing execution.",
        "loom's types must replace std's in the code under test; hidden std atomics are invisible to it."
      ],
      "production": [
        "Every hand-written lock-free primitive has a loom model with a bounded preemption setting.",
        "Loom tests live in separate files behind #![cfg(loom)] and run in a dedicated CI job.",
        "A loom failure is replayed from its checkpoint file before anyone edits the code.",
        "Concurrent types also have a sequential property test and a stress test, since loom cannot model everything."
      ],
      "crates": [
        "loom",
        "tokio",
        "proptest"
      ],
      "github": [
        {
          "name": "tokio-rs/loom",
          "url": "https://github.com/tokio-rs/loom"
        }
      ],
      "pitfall": "A loom test that calls std::sync::Arc while the code under test uses loom's atomics: loom cannot see the hidden synchronization, so it explores orderings that the real code cannot produce and misses ones it can.",
      "resources": [
        {
          "title": "loom crate documentation",
          "url": "https://docs.rs/loom/latest/loom/",
          "kind": "docs"
        },
        {
          "title": "tokio-rs/loom repository",
          "url": "https://github.com/tokio-rs/loom",
          "kind": "repo"
        },
        {
          "title": "The Rust nomicon: atomics and memory ordering",
          "url": "https://doc.rust-lang.org/nomicon/atomics.html",
          "kind": "docs"
        },
        {
          "title": "Jon Gjengset: concurrency and atomics deep dives (YouTube)",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ]
    },
    {
      "id": "i20",
      "n": 20,
      "title": "Test design: one reason to fail",
      "minutes": 60,
      "level": "core",
      "goal": "Design tests that name a rule, fail for one reason, and live at the boundary you own, and recognize the test smells that make a suite expensive to keep.",
      "sections": [
        {
          "h": "A test is a specification with an executable example",
          "p": [
            "The name should state the rule, not the method: two units at ten euros cost twenty euros is a specification; test_line_total is a filing label. Arrange, act, assert, in that order, with no branching. A test containing an if is testing two things and will report one failure for two possible causes.",
            "The strongest suites read as a list of rules the system obeys. When a test fails, the name alone should tell a reader what behavior broke and roughly where to look. If the failure message needs the test body to interpret, the test is under-specified."
          ],
          "code": "// Three behaviors, one failure signal, an assertion on internals.\n#[test]\nfn test_order() {\n    let mut order = Order::default();\n    order.qty = 2;\n    let total = line_total_cents(&order);\n    assert!(total > 0);\n    assert_eq!(order.qty, 2);\n    assert!(format!(\"{:?}\", order).contains(\"SKU-1\"));\n}\n\n// One rule, one reason to fail, a name that states the rule.\n#[test]\nfn two_units_at_ten_euros_cost_twenty_euros() {\n    let order = Order::default().with_qty(2);\n    assert_eq!(line_total_cents(&order), 2_000);\n}",
          "tip": "If you cannot name the test after the rule, you do not yet know what the rule is. Write the name first and let it fail."
        },
        {
          "h": "Test at the boundary you own",
          "p": [
            "The pyramid is a cost model, not a law: many fast unit tests, fewer integration tests, very few end-to-end tests. The reason is feedback time and failure attribution, not purity. A failing unit test points at a function; a failing end-to-end test points at a system and leaves you to bisect. Push each assertion down to the lowest level where it can still fail for the reason you care about.",
            "The exception is the wiring itself. Nothing below end-to-end proves the router is mounted, the migration matches the struct, or the config key is spelled the same on both sides. Those are exactly the bugs that a hundred unit tests cannot see, so every service needs at least one test that goes through its real entry point."
          ],
          "list": [
            "Pure logic and error mapping: unit tests, no I/O",
            "SQL, serialization and protocol handling: integration tests with the real dependency",
            "Wiring, configuration and startup: one smoke test through the real entry point",
            "Do not re-test a dependency's behavior in your suite; test your use of it"
          ]
        },
        {
          "h": "Smells that make a suite expensive",
          "p": [
            "A test that cannot fail is worse than no test: it costs maintenance and grants false confidence. Assertion-free tests, tests that assert a mock was called, tests that restate the implementation, and tests that are always skipped all belong in this category. Delete them or make them assert something a user could observe.",
            "The other expensive smell is duplication of setup without a fixture, which turns every field addition into a fifty-file diff. DAMP (descriptive and meaningful phrases) beats DRY in tests: a little repetition that keeps each test readable is cheaper than an abstraction that hides what the test depends on. Share the setup that is genuinely identical; duplicate the parts that differ."
          ],
          "code": "// Smell: asserts on a log line and a mock call, never on behavior.\n#[test]\nfn processes_payment() {\n    let mut gateway = MockGateway::new();\n    gateway.expect_charge().times(1).returning(|_, _| Ok(()));\n    process(&mut gateway, &sample());\n    assert!(gateway.expectations_satisfied());\n}\n\n// Behavior: the observable outcome, including the failure path.\n#[test]\nfn a_declined_card_leaves_the_order_unpaid() {\n    let mut gateway = MockGateway::new();\n    gateway.expect_charge().returning(|_, _| Err(Declined));\n\n    let outcome = process(&mut gateway, &sample_order()).unwrap();\n\n    assert_eq!(outcome.status, OrderStatus::Unpaid);\n    assert_eq!(outcome.attempts, 1); // no retry on a decline\n}",
          "tip": "A test that has never failed is either guarding something stable or asserting nothing. Mutation testing tells you which within a minute."
        }
      ],
      "exercise": {
        "prompt": "Refactor a test that asserts three unrelated things into tests with one reason to fail each, and give each a name that states the rule. Then say which of them belongs at integration level instead.",
        "starter": "#[test]\nfn test_user() {\n    let user = create_user(\"ada@example.com\", \"\");\n    assert!(user.is_ok() || user.is_err());\n    assert_eq!(user.unwrap().email, \"ada@example.com\");\n    assert!(validate_email(\"not-an-email\").is_err());\n}\n\n// 1. split into one-behavior tests\n// 2. name each after the rule\n// 3. which one needs a real database?",
        "hint": "Three rules: a valid email is stored as given, an empty password is rejected, a malformed email is rejected. The storage assertion is the one that needs the real database (integration); the two validations are unit tests.",
        "solution": "#[test]\nfn a_valid_email_is_stored_verbatim() {\n    let user = create_user(\"ada@example.com\", \"correct horse\").unwrap();\n    assert_eq!(user.email, \"ada@example.com\");\n}\n\n#[test]\nfn an_empty_password_is_rejected() {\n    let err = create_user(\"ada@example.com\", \"\").unwrap_err();\n    assert_eq!(err, CreateUserError::EmptyPassword);\n}\n\n#[test]\nfn a_malformed_email_is_rejected() {\n    assert!(validate_email(\"not-an-email\").is_err());\n}\n\n// Level: the first test asserts what is stored, so it belongs in an\n// integration test against the real database (uniqueness, normalization and\n// constraints live there). The two validation tests are pure and stay unit.\n// The original assert!(user.is_ok() || user.is_err()) asserted nothing at all."
      },
      "questions": [
        {
          "q": "Why is assert!(result.is_ok() || result.is_err()) worthless?",
          "options": [
            "It is slower than assert_eq!",
            "It is a tautology: it passes for every possible value of result",
            "It requires Result to implement Debug",
            "It only works with unit tests"
          ],
          "answer": 1,
          "explain": "Every Result is Ok or Err, so the assertion cannot fail. It contributes coverage and no detection, which is the pattern mutation testing exposes."
        },
        {
          "q": "What does the test pyramid optimize for?",
          "options": [
            "Maximum line coverage",
            "Fast feedback and precise failure attribution, by pushing assertions to the lowest level that can still catch the bug",
            "Fewer total assertions",
            "Running everything end-to-end"
          ],
          "answer": 1,
          "explain": "Unit tests are fast and localize failures; end-to-end tests are slow and blame a system. The shape is a cost model, with a smoke test for wiring."
        },
        {
          "q": "Why is DAMP often better than DRY in tests?",
          "options": [
            "Duplication compiles faster",
            "A test that shows its own data and setup is easier to read and change than one hidden behind shared abstraction",
            "DRY causes flaky tests",
            "DAMP requires fewer assertions"
          ],
          "answer": 1,
          "explain": "Tests are read far more than written, and an abstraction that hides what a test depends on makes failures harder to diagnose. Share only what is genuinely identical."
        }
      ],
      "quickbytes": [
        "Name the test after the rule it enforces, not the method it calls.",
        "One behavior per test: a test with an if is two tests.",
        "Push assertions down to the cheapest level that can still catch the bug.",
        "Delete tests that cannot fail; they cost maintenance and buy nothing."
      ],
      "production": [
        "Test names state a rule, and a failing name tells a reader what broke.",
        "Each service has at least one smoke test through its real entry point for wiring bugs.",
        "Assertion-free tests and mock-only tests are removed during review.",
        "Setup is shared only when identical; differing data is written per test."
      ],
      "crates": [
        "rstest",
        "mockall",
        "insta"
      ],
      "github": [
        {
          "name": "la10736/rstest",
          "url": "https://github.com/la10736/rstest"
        },
        {
          "name": "asomers/mockall",
          "url": "https://github.com/asomers/mockall"
        }
      ],
      "pitfall": "A suite of tests that assert only that calls succeeded: it grows with the code, passes through every regression, and the first real incident is also the first evidence that nothing was checked.",
      "resources": [
        {
          "title": "The Rust Book: writing tests that describe behavior",
          "url": "https://doc.rust-lang.org/book/ch11-01-writing-tests.html",
          "kind": "docs"
        },
        {
          "title": "Simple Testing Can Prevent Most Critical Failures (OSDI 2014)",
          "url": "https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-yuan.pdf",
          "kind": "paper"
        },
        {
          "title": "Jon Gjengset: testing and correctness discussions (YouTube)",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ]
    }
  ]
};
