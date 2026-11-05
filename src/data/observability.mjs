/**
 * Observability & reliability track.
 *
 * API versions verified against docs.rs / official docs:
 *   tracing 0.1.44, tracing-subscriber 0.3.23,
 *   opentelemetry 0.33.1, opentelemetry_sdk 0.33.1, opentelemetry-otlp 0.33.1,
 *   tracing-opentelemetry 0.34.0, metrics 0.24.6,
 *   metrics-exporter-prometheus 0.18.3, prometheus 0.14.0,
 *   pprof 0.15.0, console-subscriber 0.5.0.
 *
 * The OpenTelemetry Rust crates are released in lockstep: keep
 * opentelemetry, opentelemetry_sdk, opentelemetry-otlp and
 * tracing-opentelemetry on matching minors or the types will not unify.
 *
 * Data is JSON-compatible and consumed by the plugin build.
 */
export default {
  "key": "observability",
  "prefix": "j",
  "title": "Observability & reliability",
  "blurb": "Logs, metrics, traces, SLOs, alerting and the operational practices that let you debug production quickly.",
  "level": "industry",
  "project": {
    "title": "Capstone: an observability pipeline",
    "brief": "Instrument one Rust service end-to-end - traces, metrics and structured logs - export it over OTLP through a Collector, then define SLIs, SLOs and burn-rate alerts that actually catch failures you inject on purpose. Every claim in the incident drill has to be provable from telemetry you shipped.",
    "deliverables": [
      "A telemetry crate that builds the OTLP trace and metric pipelines once, tags every signal with resource attributes (service.name, service.version, deployment.environment.name), and flushes on shutdown.",
      "One trace per request that crosses at least two services, with span kinds, low-cardinality names, and a trace id visible in every log line.",
      "RED metrics per route plus USE metrics per resource, exported as Prometheus histograms with buckets chosen around the SLO threshold.",
      "A Grafana (or equivalent) dashboard whose top row answers: is it broken, how bad, since when, and which version.",
      "SLO definitions with recording rules, and multi-window burn-rate alert rules that page only on user-visible symptoms, each with a runbook link.",
      "A failure-injection drill: kill a dependency, add 800 ms of latency, and return 5% errors - then show which alert fired, how long it took, and what the trace and exemplar pointed at."
    ],
    "stack": [
      "tracing",
      "tracing-subscriber",
      "opentelemetry",
      "opentelemetry_sdk",
      "opentelemetry-otlp",
      "tracing-opentelemetry",
      "metrics",
      "metrics-exporter-prometheus",
      "prometheus",
      "pprof"
    ]
  },
  "lessons": [
    {
      "id": "j01",
      "n": 1,
      "title": "Logging: from println! to leveled events",
      "minutes": 60,
      "level": "core",
      "goal": "Replace println! with tracing events, choose a level per case, and install one subscriber in the binary that filters by module without a rebuild.",
      "sections": [
        {
          "h": "println! has no level, no target, and no off switch",
          "p": [
            "println! writes a formatted string to stdout. It has no level, no timestamp, no target, and no way to turn it off in production short of shipping a new binary. The moment an incident starts you need to raise verbosity for one module without drowning in the other forty, and a println! cannot give you that.",
            "It also destroys the fields. A line like 'order 8812 failed' cannot be filtered by order id, counted by failure kind, or joined to a trace, because the id is fused into prose. Anything you intend to keep in production should be an event with named fields."
          ]
        },
        {
          "h": "Events are instants, spans are intervals",
          "p": [
            "tracing has two primitives. An event is a point in time with a level, a target, and fields. A span is an interval with a start and an end that can nest inside other spans, so spans carry causality that a flat log stream cannot express.",
            "Libraries only emit; the binary installs a subscriber. That split is why a crate can depend on tracing without forcing a logging backend on you, and why the same instrumentation can print to stdout in a test and export OTLP in production with no call-site changes."
          ],
          "tip": "Never call set_global_default from a library. Two libraries that both do it make the binary panic on startup."
        },
        {
          "h": "Levels are a contract with the on-call engineer",
          "p": [
            "A level is not a severity you feel; it is a promise about who reacts. If an error! fires and nothing breaks, it is not an error, and the team learns to ignore the level that is supposed to wake them up.",
            "Volume is the second half of the contract. One info! inside a loop over 50,000 rows turns a 2 KB request into megabytes of logs, and log volume is billed per gigabyte at ingest and again at query time. A useful rule: if an event fires more than once per request, it belongs at debug, or it should be an aggregated counter instead of a line."
          ],
          "list": [
            "error: a human must act now; the request or the system is failing",
            "warn: degraded but handled - a retry succeeded, a fallback engaged, a budget is nearly spent",
            "info: state transitions worth one line per request, never one per row",
            "debug and trace: developer detail, off in production unless you are actively debugging"
          ]
        },
        {
          "h": "What never goes in a log line",
          "p": [
            "Tokens, passwords, session cookies, card numbers, and full request bodies do not belong in logs, because logs are copied to a cheaper system with weaker access control and a longer retention than the database they came from. Log the identifier and the shape, not the payload.",
            "Redact at the emit site. A pipeline filter is a second line of defence, not the first: by the time the collector sees the field, it is already on disk in the shipper's buffer and in every error report that quoted it."
          ]
        }
      ],
      "exercise": {
        "prompt": "Convert this println!-based charge function to tracing: one level per outcome, structured fields instead of interpolation, and a subscriber that reads RUST_LOG with a safe default of info.",
        "starter": "pub fn charge(order_id: &str, attempt: u32) -> Result<(), String> {\n    println!(\"charging order {} attempt {}\", order_id, attempt);\n    if attempt > 3 {\n        println!(\"giving up on order {}\", order_id);\n        return Err(\"retries exhausted\".into());\n    }\n    if attempt == 1 {\n        println!(\"first attempt failed for {}\", order_id);\n    }\n    Ok(())\n}",
        "hint": "info! for the accepted charge, warn! for the recovered first attempt, error! for exhausted retries. Pass order_id and attempt as fields, not as format arguments, and install fmt() with an EnvFilter defaulting to info.",
        "solution": "use tracing::{error, info, warn};\nuse tracing_subscriber::EnvFilter;\n\npub fn init_logging() {\n    let filter = EnvFilter::try_from_default_env()\n        .unwrap_or_else(|_| EnvFilter::new(\"info,checkout=debug,sqlx=warn\"));\n    tracing_subscriber::fmt()\n        .with_env_filter(filter)\n        .with_target(true)\n        .init();\n}\n\npub fn charge(order_id: &str, attempt: u32) -> Result<(), String> {\n    if attempt > 3 {\n        error!(order_id, attempt, \"charge retries exhausted\");\n        return Err(\"retries exhausted\".into());\n    }\n    if attempt == 1 {\n        warn!(order_id, attempt, \"charge attempt failed, retrying\");\n    }\n    info!(order_id, attempt, \"charge accepted\");\n    Ok(())\n}"
      },
      "questions": [
        {
          "q": "Why does tracing split emitting (macros) from collecting (subscriber)?",
          "options": [
            "So libraries can emit events without choosing a backend",
            "Because spans need an async runtime to exist",
            "To make formatting faster than println!",
            "To stay compatible with the log crate"
          ],
          "answer": 0,
          "explain": "Libraries depend on tracing only; the binary decides whether events go to stdout, JSON, or OTLP. That is why instrumentation survives a change of vendor with no call-site edits."
        },
        {
          "q": "A payment attempt times out, the retry succeeds, and the user never notices. Which level fits?",
          "options": [
            "error",
            "warn",
            "info",
            "trace"
          ],
          "answer": 1,
          "explain": "warn means degraded but handled. error is reserved for outcomes a human must act on; firing error here trains the team to ignore the level that matters."
        },
        {
          "q": "An info! sits inside a loop that runs 50,000 times per request. What is the realistic consequence?",
          "options": [
            "The log volume and ingest bill dominate the request cost",
            "tracing drops the duplicates automatically",
            "The event is silently downgraded to debug",
            "Nothing, because field values are lazily formatted"
          ],
          "answer": 0,
          "explain": "Each iteration is a distinct event, so volume scales with rows, not requests. Emit one summary event with a count instead of one event per row."
        }
      ],
      "quickbytes": [
        "RUST_LOG=info,checkout=debug raises verbosity for one crate without a rebuild.",
        "Log identifiers and counts; never tokens, card numbers, or request bodies.",
        "One event per state transition beats ten events per step.",
        "An error! nobody acts on is worse than no error! at all."
      ],
      "production": [
        "The binary installs exactly one subscriber at startup; no library calls set_global_default.",
        "The default filter is info and is overridable by RUST_LOG; trace is never the production default.",
        "No secret or PII appears in a field; redaction happens at the emit site.",
        "Log volume has an owner and a monthly budget, measured per service.",
        "Failure events carry the error chain and a request id, not just a message."
      ],
      "crates": [
        "tracing",
        "tracing-subscriber",
        "tracing-appender"
      ],
      "github": [
        {
          "name": "tokio-rs/tracing",
          "url": "https://github.com/tokio-rs/tracing"
        }
      ],
      "pitfall": "Calling an expensive function inside the event, such as serde_json::to_string(&payload): the call is evaluated before the macro can decide the event is filtered out, so you pay serialization on every request even when debug is off.",
      "resources": [
        {
          "title": "tracing crate documentation",
          "url": "https://docs.rs/tracing/latest/tracing/",
          "kind": "docs"
        },
        {
          "title": "tracing-subscriber: layers, filters, EnvFilter",
          "url": "https://docs.rs/tracing-subscriber/latest/tracing_subscriber/",
          "kind": "docs"
        },
        {
          "title": "tracing-appender: non-blocking file writers",
          "url": "https://docs.rs/tracing-appender/latest/tracing_appender/",
          "kind": "docs"
        },
        {
          "title": "Jon Gjengset: Rust streams and long-form systems talks",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ]
    },
    {
      "id": "j02",
      "n": 2,
      "title": "Structured logging: one JSON object per event",
      "minutes": 65,
      "level": "core",
      "goal": "Emit machine-readable logs with stable field names, flatten spans into the event, and keep every record on a single line a collector can parse.",
      "sections": [
        {
          "h": "A log line is a row, not a sentence",
          "p": [
            "Human-readable logs work until you need to answer a question across a million lines: how many payments failed with a timeout in the last hour, grouped by merchant? With prose you grep and count by eye. With fields you filter and aggregate, which is the only thing that scales past a single incident.",
            "The rule that follows is simple: the message stays constant and the values move into fields. 'payment failed' plus error.kind=timeout plus merchant.id is queryable; 'payment failed for merchant 91 with timeout' is a sentence you will never aggregate. Pick the message once, and let the fields carry everything that varies between occurrences."
          ],
          "tip": "Log like you will query it. If you cannot write the query you want, the field is missing."
        },
        {
          "h": "Field names are an API",
          "p": [
            "Field names are consumed by dashboards, alerts, and saved queries, so renaming one silently breaks all of them. Namespace them the way the OpenTelemetry semantic conventions do: http.route, http.response.status_code, db.system, order.id, error.type. A dotted namespace also keeps related keys adjacent in a schema browser, which is how the next engineer discovers that error.type already exists.",
            "Never interpolate a value into a key. A field named user.8812 or error.timeout is a new column per occurrence, which means no query can ever find all of them and the index explodes. If you need to distinguish two cases, add a second field with a bounded value instead of minting a new key for every one of them."
          ],
          "list": [
            "Dotted, namespaced keys: order.id, http.route, db.operation",
            "Stable across releases; treat a rename as a breaking change",
            "Values are typed: numbers stay numbers, booleans stay booleans",
            "One key per concept; do not ship status, status_code, and code for the same thing"
          ]
        },
        {
          "h": "JSON on stdout, one line per event",
          "p": [
            "In a container, stdout is the transport: the runtime collects it, ships it, and rotates it. Write newline-delimited JSON, never pretty-printed JSON, and never a stack trace spread across forty lines, because a line-oriented shipper will store forty partial records.",
            "tracing-subscriber's json formatter does this with flatten_event, which lifts the event fields to the top level instead of nesting them under a fields object. That single flag is the difference between a query that reads error.type and one that reads fields.error.type."
          ],
          "code": "use tracing_subscriber::{fmt, prelude::*, EnvFilter};\n\npub fn init_json_logs() -> Result<(), Box<dyn std::error::Error>> {\n    let filter = EnvFilter::try_from_default_env()\n        .unwrap_or_else(|_| EnvFilter::new(\"info\"));\n\n    tracing_subscriber::registry()\n        .with(filter)\n        .with(\n            fmt::layer()\n                .json()\n                .flatten_event(true)      // error.type at the top level\n                .with_current_span(true)  // trace_id, span_id\n                .with_span_list(false)    // skip the full ancestor list\n                .with_target(true),\n        )\n        .init();\n\n    Ok(())\n}\n\n#[tracing::instrument(skip(payload), fields(order.id = %order_id))]\npub fn handle_payment(order_id: &str, payload: &[u8]) -> Result<(), String> {\n    let result = authorize(payload);\n    if let Err(err) = &result {\n        tracing::error!(\n            error = %err,\n            error.type = \"authorization_failed\",\n            payload.bytes = payload.len(),\n            \"payment authorization failed\"\n        );\n    }\n    result\n}\n\nfn authorize(_payload: &[u8]) -> Result<(), String> {\n    Err(\"upstream timeout\".to_string())\n}",
          "tip": "Keep span_list off at high volume: the ancestor list repeats the whole call stack on every event."
        },
        {
          "h": "Span fields versus event fields",
          "p": [
            "A field recorded on a span appears on every event inside it and on the exported span itself, so put request-scoped identity there: order.id, tenant.id, http.route. Put outcome-scoped facts on the event: error.type, retry.attempt, rows.affected. That split keeps the span small and the event specific, and it means a change to a span attribute does not require touching every log call in the handler.",
            "With flatten_event and with_current_span enabled, one record carries both halves, and you can pivot from a log line to the trace without a join, because trace_id is a first-class column. That pivot is the difference between knowing a request failed and knowing which of its four downstream calls was the reason it failed."
          ]
        }
      ],
      "exercise": {
        "prompt": "Rewrite this log call as a structured event with stable field names, then configure a JSON subscriber that puts trace_id and the event fields at the top level. Assert that the rendered record parses as one JSON object.",
        "starter": "pub fn ship(order_id: &str, carrier: &str, err: &str) {\n    tracing::info!(\n        \"shipping label for order {} via {} failed because {}\",\n        order_id, carrier, err\n    );\n}",
        "hint": "Message constant, values in fields: order.id, carrier, error. Put the failure at error! and add error.type as a bounded value, not the raw error string.",
        "solution": "use tracing_subscriber::{fmt, prelude::*, EnvFilter};\n\npub fn init() {\n    tracing_subscriber::registry()\n        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(\"info\")))\n        .with(\n            fmt::layer()\n                .json()\n                .flatten_event(true)\n                .with_current_span(true)\n                .with_span_list(false),\n        )\n        .init();\n}\n\npub fn ship(order_id: &str, carrier: &str, err: &dyn std::error::Error) {\n    tracing::error!(\n        order.id = %order_id,\n        carrier = %carrier,\n        error = %err,\n        error.type = \"label_creation_failed\",\n        \"shipping label creation failed\"\n    );\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn record_has_stable_keys() {\n        let record = serde_json::json!({\n            \"message\": \"shipping label creation failed\",\n            \"order.id\": \"o-1\",\n            \"error.type\": \"label_creation_failed\"\n        });\n        assert!(record.get(\"order.id\").is_some());\n        assert!(record.get(\"error.type\").is_some());\n    }\n}"
      },
      "questions": [
        {
          "q": "Why should the message stay constant while values move into fields?",
          "options": [
            "So queries can filter and aggregate by value instead of pattern-matching prose",
            "Because JSON cannot contain numbers",
            "Because tracing forbids format arguments",
            "To reduce the number of log levels needed"
          ],
          "answer": 0,
          "explain": "A constant message plus typed fields is a table row. Interpolated prose forces every consumer to re-parse strings and breaks as soon as wording changes."
        },
        {
          "q": "What does flatten_event change about the emitted JSON?",
          "options": [
            "It lifts event fields to the top level instead of nesting them under fields",
            "It merges all spans into one record",
            "It drops the timestamp to save bytes",
            "It converts numbers to strings for compatibility"
          ],
          "answer": 0,
          "explain": "Without it, queries read fields.error.type; with it, they read error.type. That flat namespace is what makes dashboards and alerts portable."
        },
        {
          "q": "A stack trace is written with a multi-line Debug format into stdout. What breaks?",
          "options": [
            "A line-oriented shipper stores it as many partial records",
            "The log level is rejected by the collector",
            "tracing refuses to compile the format string",
            "Nothing, collectors reassemble multi-line records by default"
          ],
          "answer": 0,
          "explain": "Container log collectors are line-oriented. Format the chain into one field, escaped, so one event stays one record."
        }
      ],
      "quickbytes": [
        "Constant message, variable fields: 'payment failed' plus error.type, never a sentence.",
        "Namespaced dotted keys (http.route, order.id) survive renames and match semantic conventions.",
        "Newline-delimited JSON only; pretty printing breaks line-oriented shippers.",
        "flatten_event(true) plus with_current_span(true) makes logs joinable to traces."
      ],
      "production": [
        "Every service emits JSON with the same core keys: timestamp, level, target, message, trace_id.",
        "Field names are documented and treated as a breaking change when renamed.",
        "Log records stay on one line; error chains are escaped into a single field.",
        "Logs go to stdout and are shipped by the platform, never written to a local file by the app.",
        "A redaction review is part of the review checklist for new fields."
      ],
      "crates": [
        "tracing",
        "tracing-subscriber",
        "serde_json"
      ],
      "github": [
        {
          "name": "tokio-rs/tracing",
          "url": "https://github.com/tokio-rs/tracing"
        }
      ],
      "pitfall": "Renaming a field like status to status_code during a refactor: every dashboard and saved query that filtered on the old key silently returns nothing, and the gap is discovered during the next incident rather than in CI.",
      "resources": [
        {
          "title": "tracing-subscriber JSON formatter options",
          "url": "https://docs.rs/tracing-subscriber/latest/tracing_subscriber/fmt/index.html",
          "kind": "docs"
        },
        {
          "title": "OpenTelemetry semantic conventions: general attributes",
          "url": "https://opentelemetry.io/docs/specs/semconv/general/attributes/",
          "kind": "docs"
        },
        {
          "title": "tokio-rs/tracing repository and examples",
          "url": "https://github.com/tokio-rs/tracing",
          "kind": "repo"
        },
        {
          "title": "Jon Gjengset: Rust streams and long-form systems talks",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ]
    },
    {
      "id": "j03",
      "n": 3,
      "title": "Metrics: counters, gauges, histograms",
      "minutes": 70,
      "level": "core",
      "goal": "Pick the right instrument for each question, install one recorder, and choose histogram buckets that can actually resolve your SLO threshold.",
      "sections": [
        {
          "h": "Three instruments, three questions",
          "p": [
            "A counter answers how many, and only goes up. A gauge answers what is the value right now and can move both ways. A histogram answers how were the values distributed, and is the only one of the three that can tell you about a tail.",
            "Most bad dashboards come from using the wrong one. Request totals are counters, in-flight requests are gauges, and latency is a histogram. A counter that goes down is a lie that will break every rate() you write on top of it."
          ],
          "list": [
            "counter: requests, errors, bytes, retries - monotonic, reset only on restart",
            "gauge: queue depth, pool connections in use, cache size, temperature",
            "histogram: durations, payload sizes, batch sizes, queue wait time"
          ]
        },
        {
          "h": "Never average a latency",
          "p": [
            "Averages hide the thing you care about. With 1% of requests at 3 seconds and 99% at 50 ms, the mean is 79 ms and looks healthy while one user in a hundred waits three seconds. The average of a histogram is also not the average latency: it is a weighted mean of samples, and it cannot be re-derived per route after the fact.",
            "Compute quantiles from buckets, or use native histograms, and always look at p99 and p999 next to the median. If the p99 is bad and the p50 is fine, you have a tail problem - a slow dependency, a lock, a garbage collection pause - not a capacity problem."
          ]
        },
        {
          "h": "The facade and the recorder",
          "p": [
            "The metrics crate is a facade: macros emit into a global recorder, and until you install one, every emission is a no-op that costs an atomic load. That is deliberate, so libraries can emit metrics without knowing the backend. The catch is that the recorder is global and can be installed only once: a second install returns an error, and there is no supported way to swap it at runtime.",
            "Install the recorder once, as early as possible, and keep the handle. metrics-exporter-prometheus installs a Prometheus recorder and returns a handle whose render() produces the text exposition, which you serve from your own /metrics route so it shares the app's listener and auth."
          ],
          "code": "use metrics::{counter, describe_counter, describe_histogram, gauge, histogram, Unit};\nuse metrics_exporter_prometheus::{Matcher, PrometheusHandle, PrometheusBuilder};\nuse std::time::Instant;\n\npub fn install() -> PrometheusHandle {\n    describe_counter!(\"checkout_requests_total\", \"Checkout requests by route and result.\");\n    describe_histogram!(\n        \"checkout_request_duration_seconds\",\n        Unit::Seconds,\n        \"End-to-end checkout latency.\"\n    );\n\n    PrometheusBuilder::new()\n        .set_buckets_for_metric(\n            Matcher::Full(\"checkout_request_duration_seconds\".to_string()),\n            &[0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1.0, 2.5, 5.0],\n        )\n        .expect(\"non-empty bucket list\")\n        .install_recorder()\n        .expect(\"recorder installed once at startup\")\n}\n\npub fn handle_checkout(route: &'static str, result: &'static str) {\n    let started = Instant::now();\n    counter!(\"checkout_requests_total\", \"route\" => route, \"result\" => result)\n        .increment(1);\n    histogram!(\"checkout_request_duration_seconds\", \"route\" => route)\n        .record(started.elapsed().as_secs_f64());\n    gauge!(\"checkout_inflight_requests\").increment(1.0);\n    // ... do the work, then decrement ...\n}",
          "tip": "Call install_recorder once in main. A second install fails, and a recorder installed after the first metric is recorded loses everything before it."
        },
        {
          "h": "Buckets are a contract, not a default",
          "p": [
            "A histogram is a set of counters, one per bucket boundary, plus sum and count. Quantiles are interpolated from those buckets, so a bucket layout that is too coarse near your threshold produces a p99 you cannot trust. If the SLO is 300 ms, you need boundaries at 100, 200, 250, 300, 400, and 500 ms, not at 1, 2, and 5 seconds.",
            "Every boundary also multiplies series count, so ten buckets per route per status is ten times the storage of one. Choose boundaries around the decisions you will make - the SLO threshold, the timeout, the alert condition - and leave the rest coarse."
          ],
          "list": [
            "Put at least two boundaries around the SLO threshold, one on each side",
            "Add a boundary just under the client timeout so you can see timeouts forming",
            "Keep the count near ten; more resolution costs series, not accuracy",
            "Set buckets per metric name, not globally - queue depth and latency need different shapes"
          ]
        }
      ],
      "exercise": {
        "prompt": "Instrument a queue worker with three instruments: jobs_total split by result, queue_depth as a gauge, and job_duration_seconds as a histogram with buckets around a 2 s SLO. Then render the exposition and assert the expected series appear.",
        "starter": "use metrics::{counter, gauge, histogram};\nuse std::time::Instant;\n\npub fn run_job(kind: &'static str) -> Result<(), String> {\n    let started = Instant::now();\n    // 1. count the job by result\n    // 2. record duration in seconds\n    // 3. update queue depth\n    let _ = started;\n    Ok(())\n}\n\n// Assert with: handle.render().contains(\"jobs_total{result=\\\"ok\\\"}\")",
        "hint": "counters and histograms take labels as key => value pairs. Use result=\"ok\" and result=\"error\" so the two outcomes are separate series, and set the gauge to the current depth rather than incrementing it forever.",
        "solution": "use metrics::{counter, describe_histogram, gauge, histogram, Unit};\nuse metrics_exporter_prometheus::{Matcher, PrometheusBuilder};\nuse std::time::Instant;\n\npub fn install() -> metrics_exporter_prometheus::PrometheusHandle {\n    describe_histogram!(\"job_duration_seconds\", Unit::Seconds, \"Worker job latency.\");\n    PrometheusBuilder::new()\n        .set_buckets_for_metric(\n            Matcher::Full(\"job_duration_seconds\".to_string()),\n            &[0.05, 0.1, 0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 5.0],\n        )\n        .expect(\"buckets\")\n        .install_recorder()\n        .expect(\"installed once\")\n}\n\npub fn run_job(kind: &'static str, queue_depth: usize) -> Result<(), String> {\n    let started = Instant::now();\n    gauge!(\"queue_depth\").set(queue_depth as f64);\n\n    let outcome = do_work(kind);\n    let result = if outcome.is_ok() { \"ok\" } else { \"error\" };\n\n    counter!(\"jobs_total\", \"kind\" => kind, \"result\" => result).increment(1);\n    histogram!(\"job_duration_seconds\", \"kind\" => kind)\n        .record(started.elapsed().as_secs_f64());\n    outcome\n}\n\nfn do_work(_kind: &str) -> Result<(), String> {\n    Ok(())\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn renders_expected_series() {\n        let handle = install();\n        let _ = run_job(\"thumbnail\", 3);\n        let body = handle.render();\n        assert!(body.contains(\"jobs_total{kind=\\\"thumbnail\\\",result=\\\"ok\\\"}\"));\n        assert!(body.contains(\"job_duration_seconds_bucket\"));\n    }\n}"
      },
      "questions": [
        {
          "q": "Which instrument for the number of jobs currently waiting in a queue?",
          "options": [
            "A gauge",
            "A counter",
            "A histogram",
            "A summary"
          ],
          "answer": 0,
          "explain": "The value goes up and down as workers drain the queue, so it is a gauge. A counter would only ever grow and could not tell you the current depth."
        },
        {
          "q": "Why is the mean latency of a histogram a poor health signal?",
          "options": [
            "It is dominated by the many fast samples and hides a slow tail",
            "It cannot be computed from bucket counts",
            "It is always lower than the median",
            "Histograms do not record sums"
          ],
          "answer": 0,
          "explain": "With 99% of traffic at 50 ms and 1% at 3 s, the mean stays near 79 ms. Only p99 or p999 exposes the users who are actually suffering."
        },
        {
          "q": "Your SLO threshold is 300 ms. Which bucket set is most useful?",
          "options": [
            "0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 1.0 seconds",
            "1, 2, 5, 10 seconds",
            "0.3 seconds only",
            "0.001, 0.002, 0.004 seconds"
          ],
          "answer": 0,
          "explain": "Quantiles are interpolated from bucket boundaries, so resolution has to sit around the decision point. Boundaries at 1 s and above cannot distinguish 250 ms from 900 ms."
        }
      ],
      "quickbytes": [
        "Counters only go up; the moment one decreases, every rate() on it lies.",
        "Record durations in seconds with a unit suffix (_seconds), never milliseconds in one service and seconds in another.",
        "Set buckets per metric name; a single global layout fits nothing.",
        "Install the recorder in main before the first request, and keep the handle for /metrics."
      ],
      "production": [
        "Every metric has a unit in its name and a description registered at startup.",
        "Latency is always a histogram, never a gauge of the last request.",
        "Bucket boundaries are reviewed against the SLO and the client timeout.",
        "The /metrics route is bound to the internal listener or protected by auth, never public.",
        "Cardinality per metric has a documented ceiling and an alert when it is approached."
      ],
      "crates": [
        "metrics",
        "metrics-exporter-prometheus",
        "prometheus"
      ],
      "github": [
        {
          "name": "metrics-rs/metrics",
          "url": "https://github.com/metrics-rs/metrics"
        }
      ],
      "pitfall": "Installing the recorder after the server has already started: every emission before the install goes to the no-op recorder and is lost, so the first minutes of a deploy look like zero traffic rather than an instrumentation bug.",
      "resources": [
        {
          "title": "metrics crate: instrument types and recording",
          "url": "https://docs.rs/metrics/latest/metrics/",
          "kind": "docs"
        },
        {
          "title": "metrics-exporter-prometheus: builder and bucket config",
          "url": "https://docs.rs/metrics-exporter-prometheus/latest/metrics_exporter_prometheus/",
          "kind": "docs"
        },
        {
          "title": "metrics-rs/metrics repository",
          "url": "https://github.com/metrics-rs/metrics",
          "kind": "repo"
        },
        {
          "title": "prometheus crate: histograms and text exposition",
          "url": "https://docs.rs/prometheus/latest/prometheus/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "j04",
      "n": 4,
      "title": "Distributed tracing: one trace, many services",
      "minutes": 80,
      "level": "core",
      "goal": "Model a request as a tree of spans, instrument I/O boundaries rather than functions, and read a trace to find which hop burned the latency.",
      "sections": [
        {
          "h": "Metrics say something is slow; traces say where",
          "p": [
            "A latency histogram tells you that checkout's p99 doubled at 14:02. It cannot tell you whether the database, the payment provider, or your own retry loop is responsible, because a metric is an aggregate with the request identity thrown away. A trace keeps the identity and the structure.",
            "A trace is the record of one request's journey: which service, which operation, how long, in what order, and what the parent-child relationships were. When you have that, finding the culprit is a matter of reading a waterfall instead of forming hypotheses."
          ]
        },
        {
          "h": "A trace is a tree of spans",
          "p": [
            "Every span carries a trace id shared by the whole request and a span id unique to itself, plus the id of its parent. The root span has no parent. Those three fields are the entire data model: a backend reconstructs the tree from them, and a log line that carries the trace id can be placed on it.",
            "A span also has a name, a start and end time, a kind, and attributes. Duration comes from the timestamps, so a span is not a timer you start and stop - it is an interval recorded by the instrumentation, which is why clock skew between hosts shows up as negative or impossible children."
          ],
          "list": [
            "trace_id: 16 bytes, identical across every span in the request",
            "span_id: 8 bytes, unique per operation",
            "parent_span_id: what makes the tree a tree",
            "attributes: bounded, low-cardinality facts about the operation"
          ]
        },
        {
          "h": "Instrument boundaries, not functions",
          "p": [
            "The instinct is to put a span on every function. The result is a 400-span trace where 380 spans are pure computation that took microseconds, and the three that matter are invisible. A trace earns its keep when each span is a boundary you might have to blame: an HTTP call, a query, a cache lookup, a queue publish, a lock wait.",
            "A useful test: if the operation cannot fail independently or cannot be slow independently, it does not need a span. Depth is cheap, but noise is expensive, and a trace backend bills per span while an on-call engineer pays for it in reading time. Two or three spans of real I/O per request is a healthy trace; forty spans usually means someone instrumented a call graph instead of a system."
          ],
          "code": "use sqlx::PgPool;\nuse tracing::Instrument;\n\npub async fn place_order(pool: &PgPool, order_id: &str) -> Result<(), Box<dyn std::error::Error>> {\n    // A span per I/O boundary, attached to the future - never entered across .await.\n    let customer = sqlx::query_scalar::<_, String>(\"SELECT customer_id FROM orders WHERE id = $1\")\n        .bind(order_id)\n        .fetch_one(pool)\n        .instrument(tracing::info_span!(\n            \"db.query\",\n            db.system = \"postgresql\",\n            db.operation = \"SELECT\",\n            db.collection.name = \"orders\"\n        ))\n        .await?;\n\n    let auth = authorize(&customer, order_id)\n        .instrument(tracing::info_span!(\n            \"payment.authorize\",\n            \"otel.kind\" = \"client\",\n            peer.service = \"payments.internal\"\n        ))\n        .await?;\n\n    tracing::info!(order.id = %order_id, authorized = auth, \"order placed\");\n    Ok(())\n}\n\nasync fn authorize(_customer: &str, _order_id: &str) -> Result<bool, Box<dyn std::error::Error>> {\n    Ok(true)\n}",
          "tip": "Attach spans with .instrument(span) on the future. Span::enter guards held across .await attach the span to whatever task the executor schedules next."
        },
        {
          "h": "What Dapper taught everyone",
          "p": [
            "Google's Dapper paper described the design most tracing systems still follow: propagate a trace id through RPC headers, sample aggressively, and keep per-span overhead low enough that instrumentation can be on by default. The paper's own measurement was that the cost was small enough to run continuously rather than only during incidents.",
            "The other lesson is cultural: because the trace id travelled with the request, logs and traces could be joined, and debugging stopped being a search through per-host files. That is why the trace id in your log line matters more than the prettiness of your waterfall."
          ]
        }
      ],
      "exercise": {
        "prompt": "Instrument a three-hop path - handler, database query, outbound HTTP call - so each hop is its own span, the tree nests correctly, and the total is attributable. Use .instrument() on the futures, not entered guards.",
        "starter": "pub async fn handler(pool: &PgPool, id: &str) -> Result<(), Error> {\n    // 1. root span for the request\n    // 2. span around the query\n    // 3. span around the outbound call\n    todo!()\n}",
        "hint": "Create the root span with info_span! and instrument the whole handler future with it, then instrument each awaited call with a child span. Set otel.kind=client on the outbound call and db.system on the query.",
        "solution": "use sqlx::PgPool;\nuse tracing::Instrument;\n\n#[derive(Debug)]\npub struct Error;\n\npub async fn handler(pool: &PgPool, id: &str) -> Result<(), Error> {\n    let root = tracing::info_span!(\n        \"http.request\",\n        \"otel.kind\" = \"server\",\n        \"http.request.method\" = \"GET\",\n        \"http.route\" = \"/orders/{id}\",\n        order.id = %id\n    );\n\n    async move {\n        let owner: String = sqlx::query_scalar(\"SELECT customer_id FROM orders WHERE id = $1\")\n            .bind(id)\n            .fetch_one(pool)\n            .instrument(tracing::info_span!(\n                \"db.query\",\n                db.system = \"postgresql\",\n                db.operation = \"SELECT\"\n            ))\n            .await\n            .map_err(|_| Error)?;\n\n        let _ = call_inventory(&owner)\n            .instrument(tracing::info_span!(\n                \"inventory.reserve\",\n                \"otel.kind\" = \"client\",\n                peer.service = \"inventory\"\n            ))\n            .await?;\n\n        Ok(())\n    }\n    .instrument(root)\n    .await\n}\n\nasync fn call_inventory(_owner: &str) -> Result<(), Error> {\n    Ok(())\n}"
      },
      "questions": [
        {
          "q": "Which three fields let a backend rebuild a trace as a tree?",
          "options": [
            "trace_id, span_id, parent_span_id",
            "service.name, host.name, timestamp",
            "request_id, user_id, session_id",
            "span name, duration, status"
          ],
          "answer": 0,
          "explain": "The tree is derived entirely from a shared trace id, a unique span id, and the parent pointer. Names and timestamps are presentation, not structure."
        },
        {
          "q": "Why is a span on every function a bad idea?",
          "options": [
            "Hundreds of microsecond spans bury the few hops that can actually be slow",
            "The compiler cannot inline instrumented functions",
            "tracing limits a trace to ten spans",
            "Spans on pure functions are always dropped by the exporter"
          ],
          "answer": 0,
          "explain": "Signal density is the point. If an operation cannot fail or be slow independently, its span adds cost and noise without adding an answer."
        },
        {
          "q": "What goes wrong when you hold a Span::enter guard across an .await?",
          "options": [
            "The span stays entered on the executor thread and mislabels unrelated work",
            "The span is never exported",
            "The future stops being Send and the task cannot spawn",
            "The span id is duplicated for the next task"
          ],
          "answer": 0,
          "explain": "Entering is thread-local. A task that yields while entered leaves the span attached to whatever the executor polls next, so unrelated work appears inside your request."
        }
      ],
      "quickbytes": [
        "One span per I/O boundary: HTTP, query, cache, publish, lock. Nothing else.",
        "Use .instrument(span) on futures; reserve enter() for synchronous blocks.",
        "The trace id belongs in every log line, not just in the trace backend.",
        "Span names stay low-cardinality; ids go in attributes."
      ],
      "production": [
        "Every inbound request has a root span carrying http.route and the method.",
        "Outbound calls are client spans with peer.service so dependencies are identifiable.",
        "Trace ids appear in structured logs, so a log search can pivot to a trace.",
        "Span count per request has a budget; a regression is caught in load tests, not in the bill.",
        "Instrumentation lives in the library or middleware, not copy-pasted into handlers."
      ],
      "crates": [
        "tracing",
        "tracing-opentelemetry",
        "opentelemetry",
        "sqlx"
      ],
      "github": [
        {
          "name": "open-telemetry/opentelemetry-rust",
          "url": "https://github.com/open-telemetry/opentelemetry-rust"
        },
        {
          "name": "tokio-rs/tracing",
          "url": "https://github.com/tokio-rs/tracing"
        }
      ],
      "pitfall": "Putting the raw URL in the span name, like GET /orders/8f3a-...: every request creates a new span name, so the backend's operation list becomes unbounded and grouping by operation stops working.",
      "resources": [
        {
          "title": "Dapper, a Large-Scale Distributed Systems Tracing Infrastructure",
          "url": "https://research.google/pubs/dapper-a-large-scale-distributed-systems-tracing-infrastructure/",
          "kind": "paper"
        },
        {
          "title": "OpenTelemetry: traces concept and span model",
          "url": "https://opentelemetry.io/docs/concepts/signals/traces/",
          "kind": "docs"
        },
        {
          "title": "tracing: Instrument and span attachment",
          "url": "https://docs.rs/tracing/latest/tracing/trait.Instrument.html",
          "kind": "docs"
        },
        {
          "title": "open-telemetry/opentelemetry-rust repository",
          "url": "https://github.com/open-telemetry/opentelemetry-rust",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "j05",
      "n": 5,
      "title": "OpenTelemetry in Rust: the SDK and OTLP export",
      "minutes": 90,
      "level": "advanced",
      "goal": "Build the OTLP trace pipeline once, attach resource attributes that identify the process, and shut it down so the last batch is not lost.",
      "sections": [
        {
          "h": "Three crates, one pipeline",
          "p": [
            "OpenTelemetry in Rust is split into an API crate (opentelemetry), an SDK crate (opentelemetry_sdk), and exporters (opentelemetry-otlp). Application code should only need the API; the binary configures the SDK and the exporter. tracing-opentelemetry is the bridge that turns tracing spans into OTel spans so you instrument once.",
            "The reason to take on this stack is portability. Your spans go out as OTLP - a protobuf over gRPC or HTTP - to a Collector, and the Collector decides whether they land in Jaeger, Tempo, or a vendor. Switching backends becomes a Collector config change instead of a code change."
          ],
          "tip": "The OTel Rust crates are versioned in lockstep. A 0.33 opentelemetry with a 0.32 sdk is a type error, not a warning, so pin them together in workspace.dependencies."
        },
        {
          "h": "Resource attributes are how a span says who it is",
          "p": [
            "A span with no resource is anonymous: the backend knows an operation was slow but not which service, which version, or which environment. service.name is required by the specification, and service.version plus deployment.environment.name are what let you answer 'did this start with the deploy?' without joining anything.",
            "Set them once in the provider, not per span. Per-span copies cost bytes on every span, and the one span you forget becomes the one you cannot attribute during an incident. A hardcoded per-span copy also drifts: the single place someone typed production by hand is the place that will be wrong in staging."
          ],
          "list": [
            "service.name: stable, unique, and matching your dashboards (checkout, not checkout-svc-v2)",
            "service.version: the git sha or semver of the running build",
            "deployment.environment.name: production, staging, or a per-PR preview name",
            "host.name / k8s.pod.name: usually added by a detector or the Collector, not hand-written"
          ]
        },
        {
          "h": "Batch by default, flush on shutdown",
          "p": [
            "The batch span processor buffers spans and exports them in groups, which is what makes tracing affordable: one gRPC round trip per few hundred spans instead of one per span. The cost is that spans live in memory for up to the batch timeout, so a process that exits abruptly takes the last window with it.",
            "Call shutdown() on the provider at the end of main, and give the process a bounded grace period. A rolling deploy that drops 10 seconds of traces every time is a rolling deploy that hides its own regressions. The batch processor also drops spans when its queue is full, which is the right behaviour under overload, but it means export failures must be visible as a metric rather than as a silent absence."
          ],
          "code": "use std::time::Duration;\nuse opentelemetry::{global, trace::TracerProvider as _, KeyValue};\nuse opentelemetry_otlp::{SpanExporter, WithExportConfig};\nuse opentelemetry_sdk::trace::SdkTracerProvider;\nuse opentelemetry_sdk::Resource;\nuse tracing_subscriber::{prelude::*, EnvFilter};\n\npub struct Telemetry {\n    provider: SdkTracerProvider,\n}\n\npub fn init(service: &'static str, version: &'static str, env: &'static str) -> Telemetry {\n    let resource = Resource::builder()\n        .with_service_name(service)\n        .with_attribute(KeyValue::new(\"service.version\", version))\n        .with_attribute(KeyValue::new(\"deployment.environment.name\", env))\n        .build();\n\n    let exporter = SpanExporter::builder()\n        .with_tonic()\n        .with_endpoint(\"http://otel-collector:4317\")\n        .with_timeout(Duration::from_secs(5))\n        .build()\n        .expect(\"otlp span exporter\");\n\n    let provider = SdkTracerProvider::builder()\n        .with_resource(resource)\n        .with_batch_exporter(exporter)\n        .build();\n\n    global::set_tracer_provider(provider.clone());\n    let tracer = provider.tracer(service);\n\n    tracing_subscriber::registry()\n        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(\"info\")))\n        .with(tracing_opentelemetry::layer().with_tracer(tracer))\n        .with(tracing_subscriber::fmt::layer().json())\n        .init();\n\n    Telemetry { provider }\n}\n\nimpl Drop for Telemetry {\n    fn drop(&mut self) {\n        // Flush the last batch; ignore the error during shutdown.\n        let _ = self.provider.shutdown();\n    }\n}",
          "tip": "In tests use a simple exporter instead of the batch one: it exports on span end, so an assertion cannot race the background thread."
        },
        {
          "h": "Environment variables are part of the contract",
          "p": [
            "The OTLP exporter reads OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS, and OTEL_EXPORTER_OTLP_COMPRESSION, with signal-specific variables winning over the generic ones and programmatic builder calls winning over both. That ordering is documented, and it is the reason a single binary can serve every environment without a rebuild.",
            "That precedence is what makes one binary work in every environment: bake a sane default endpoint, let the platform override it, and never recompile to point at a different Collector. It also lets the platform team redirect a whole cluster at a new Collector with a config change instead of a coordinated release across twenty services."
          ]
        }
      ],
      "exercise": {
        "prompt": "Write telemetry::init that reads the OTLP endpoint from the environment, tags the resource with service name, version and environment, and returns a guard whose Drop flushes the provider.",
        "starter": "use opentelemetry_sdk::trace::SdkTracerProvider;\n\npub fn init() -> SdkTracerProvider {\n    // 1. build the resource with service.name / service.version\n    // 2. build the OTLP exporter from OTEL_EXPORTER_OTLP_ENDPOINT\n    // 3. return the provider so the caller can shut it down\n    todo!()\n}",
        "hint": "std::env::var(\"OTEL_EXPORTER_OTLP_ENDPOINT\") with a localhost fallback, Resource::builder().with_service_name(..).with_attribute(..), then SdkTracerProvider::builder().with_resource(..).with_batch_exporter(..).build().",
        "solution": "use std::time::Duration;\nuse opentelemetry::{global, trace::TracerProvider as _, KeyValue};\nuse opentelemetry_otlp::{SpanExporter, WithExportConfig};\nuse opentelemetry_sdk::{trace::SdkTracerProvider, Resource};\n\npub fn init(service: &'static str, version: &'static str, env: &'static str) -> SdkTracerProvider {\n    let endpoint = std::env::var(\"OTEL_EXPORTER_OTLP_ENDPOINT\")\n        .unwrap_or_else(|_| \"http://127.0.0.1:4317\".to_string());\n\n    let resource = Resource::builder()\n        .with_service_name(service)\n        .with_attribute(KeyValue::new(\"service.version\", version))\n        .with_attribute(KeyValue::new(\"deployment.environment.name\", env))\n        .build();\n\n    let exporter = SpanExporter::builder()\n        .with_tonic()\n        .with_endpoint(endpoint)\n        .with_timeout(Duration::from_secs(5))\n        .build()\n        .expect(\"valid otlp endpoint\");\n\n    let provider = SdkTracerProvider::builder()\n        .with_resource(resource)\n        .with_batch_exporter(exporter)\n        .build();\n\n    global::set_tracer_provider(provider.clone());\n    provider\n}\n\npub fn install_subscriber(provider: &SdkTracerProvider, service: &'static str) {\n    use tracing_subscriber::prelude::*;\n\n    let filter = tracing_subscriber::EnvFilter::try_from_default_env()\n        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(\"info\"));\n\n    tracing_subscriber::registry()\n        .with(filter)\n        .with(tracing_opentelemetry::layer().with_tracer(provider.tracer(service)))\n        .with(tracing_subscriber::fmt::layer().json())\n        .init();\n}\n\npub fn shutdown(provider: SdkTracerProvider) {\n    let _ = provider.shutdown();\n}"
      },
      "questions": [
        {
          "q": "Why export through an OTLP Collector instead of straight to a backend?",
          "options": [
            "The Collector decouples the app's wire format from the backend, so switching vendors is a config change",
            "OTLP cannot be parsed by tracing backends directly",
            "The SDK requires a Collector to assign trace ids",
            "Collectors are the only way to get resource attributes"
          ],
          "answer": 0,
          "explain": "The app speaks OTLP; the Collector speaks OTLP on both sides and translates to whatever backend you run. Batching, sampling and redaction also move out of the process."
        },
        {
          "q": "Which resource attribute does the specification require?",
          "options": [
            "service.name",
            "host.name",
            "telemetry.sdk.version",
            "cloud.region"
          ],
          "answer": 0,
          "explain": "service.name is the identity every backend groups by. Without it spans are anonymous and no service map or per-service SLO can be built."
        },
        {
          "q": "What is lost when a process exits without calling provider.shutdown()?",
          "options": [
            "The spans still buffered in the batch processor",
            "Every span from the whole process lifetime",
            "The resource attributes of exported spans",
            "The trace ids of child spans"
          ],
          "answer": 0,
          "explain": "The batch processor holds spans until a size or time threshold. shutdown() drains and exports that buffer; without it, the last window disappears on every deploy."
        }
      ],
      "quickbytes": [
        "Keep opentelemetry, opentelemetry_sdk, opentelemetry-otlp and tracing-opentelemetry on the same minor.",
        "service.name plus service.version is what makes 'did the deploy cause this' answerable.",
        "Always shut the provider down; a bounded grace period in the pod spec makes it possible.",
        "OTEL_EXPORTER_OTLP_ENDPOINT is the one knob every environment should be able to override."
      ],
      "production": [
        "The OTLP endpoint comes from the environment, with a localhost default for development.",
        "Resource attributes include service.name, service.version and deployment.environment.name.",
        "Shutdown flushes the provider with a timeout inside the pod's termination grace period.",
        "Export failures are logged once, not per batch, and never block request handling.",
        "A Collector sits between the app and the backend; the app never knows the vendor."
      ],
      "crates": [
        "opentelemetry",
        "opentelemetry_sdk",
        "opentelemetry-otlp",
        "tracing-opentelemetry"
      ],
      "github": [
        {
          "name": "open-telemetry/opentelemetry-rust",
          "url": "https://github.com/open-telemetry/opentelemetry-rust"
        }
      ],
      "pitfall": "Building the exporter inside an async task that never finishes, or calling shutdown from a signal handler that then exits immediately: the flush is cut off mid-export and the spans that would explain the crash are exactly the ones lost.",
      "resources": [
        {
          "title": "opentelemetry-otlp: exporters, transports, env vars",
          "url": "https://docs.rs/opentelemetry-otlp/latest/opentelemetry_otlp/",
          "kind": "docs"
        },
        {
          "title": "opentelemetry_sdk: providers and batch processing",
          "url": "https://docs.rs/opentelemetry_sdk/latest/opentelemetry_sdk/",
          "kind": "docs"
        },
        {
          "title": "OpenTelemetry resource semantic conventions",
          "url": "https://opentelemetry.io/docs/specs/semconv/resource/",
          "kind": "docs"
        },
        {
          "title": "open-telemetry/opentelemetry-rust repository",
          "url": "https://github.com/open-telemetry/opentelemetry-rust",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "j06",
      "n": 6,
      "title": "Span design: names, kinds, status, attributes",
      "minutes": 70,
      "level": "advanced",
      "goal": "Name spans by operation, set the kind so the service graph is correct, mark status only for real failures, and keep attributes bounded.",
      "sections": [
        {
          "h": "The name is the operation, not the instance",
          "p": [
            "Span names are grouped and counted, so the name has to be the same for every instance of the same operation. GET /orders/{id} is an operation; GET /orders/8f3a-4c2e is an instance. The first gives you a latency distribution per route, the second gives you a million groups of one.",
            "Use the templated route where your framework provides one, and put the concrete path, the id, and the query in attributes. If you need a display name that includes data, tracing-opentelemetry lets you override the exported name with the otel.name field while the tracing span name stays stable."
          ],
          "code": "use tracing::field;\n\npub fn server_span(method: &str, route: &str, path: &str) -> tracing::Span {\n    let name = format!(\"{method} {route}\");\n    tracing::info_span!(\n        \"http.request\",\n        \"otel.name\" = %name,          // GET /orders/{id} - low cardinality\n        \"otel.kind\" = \"server\",\n        \"http.request.method\" = %method,\n        \"http.route\" = %route,\n        \"url.path\" = %path,           // the instance lives in an attribute\n        \"http.response.status_code\" = field::Empty,\n        \"error.type\" = field::Empty\n    )\n}",
          "tip": "If your span list has more than a few hundred distinct names per service, you are naming spans with data."
        },
        {
          "h": "Kind tells the backend how to draw the edge",
          "p": [
            "Span kind is not cosmetic. A server span marks where a request enters your process; a client span marks a call leaving it. Backends build the service map and the dependency graph by matching client spans to server spans across services, and a missing or wrong kind makes a service appear to call itself or to have no callers.",
            "internal is the default and is right for work inside the process. Getting the kind wrong is not a display bug: a backend cannot pair a client span that claims to be internal, so the dependency vanishes from the service map and the latency gets attributed to the caller itself, which is the one place it did not happen."
          ],
          "list": [
            "server: inbound HTTP or gRPC handler",
            "client: outbound HTTP, gRPC, or database call",
            "producer / consumer: queue publish and queue receive",
            "internal: everything else - in-process work, scheduled jobs"
          ]
        },
        {
          "h": "Status is for failure, not for opinion",
          "p": [
            "Set otel.status_code to error only when the operation failed in a way that matters to the caller. A 404 or a validation rejection is a successful handling of a bad request, not an error span; marking it as one inflates your error rate and makes the SLO meaningless. A 500 or a timeout is an error.",
            "Alongside the status, record error.type as a bounded value: timeout, unavailable, invalid_response. The raw error message goes in a separate field, because error.type is what you group and alert on and it must not have one value per message. Group by error.type and you get a stable list of failure modes; group by the message and you get a thousand rows describing the same bug."
          ],
          "code": "pub fn record_outcome(span: &tracing::Span, status: u16, error: Option<&str>) {\n    span.record(\"http.response.status_code\", status);\n    if status >= 500 {\n        span.record(\"otel.status_code\", \"error\");\n        span.record(\"error.type\", error.unwrap_or(\"upstream_error\"));\n    } else if status >= 400 {\n        // Client errors are handled, not failures: keep the span status unset.\n        span.record(\"error.type\", \"client_error\");\n    }\n}",
          "tip": "If your error rate is dominated by 4xx, the SLO will never fire for a real outage. Split client and server errors before computing the ratio."
        },
        {
          "h": "Attributes: semantic, bounded, and small",
          "p": [
            "Use the OpenTelemetry semantic conventions for anything the conventions cover: http.request.method, http.route, db.system, messaging.destination.name. Every backend, dashboard template, and Collector processor already understands those keys; a custom key gets no help from any of them. The payoff is not aesthetic, it is that your instrumentation composes with tooling you did not write.",
            "Keep attributes to facts you would filter on, and never attach a request or response body. The SDK enforces count and value-length limits by dropping the excess, silently, so an oversized attribute does not error - it just disappears, usually the one you needed."
          ]
        }
      ],
      "exercise": {
        "prompt": "This span is unusable: the name is the raw URL, it carries the whole request body, and it never records an outcome. Rewrite it with a templated name, a server kind, semantic-convention attributes, and an outcome recorded at the end.",
        "starter": "let span = tracing::info_span!(\n    \"request\",\n    url = %raw_url,\n    body = %String::from_utf8_lossy(&body),\n    headers = ?headers\n);\nhandle(req).await?;",
        "hint": "Name it with method plus the templated route, move the body out entirely, use http.request.method, http.route, url.path, and declare http.response.status_code as field::Empty so you can record it after the handler.",
        "solution": "use tracing::field;\n\npub async fn handle(req: Request) -> Result<Response, Error> {\n    let route = matched_route(&req);        // \"/orders/{id}\", not the raw path\n    let name = format!(\"{} {}\", req.method(), route);\n\n    let span = tracing::info_span!(\n        \"http.request\",\n        \"otel.name\" = %name,\n        \"otel.kind\" = \"server\",\n        \"http.request.method\" = %req.method(),\n        \"http.route\" = %route,\n        \"url.path\" = %req.uri().path(),\n        \"http.response.status_code\" = field::Empty,\n        \"error.type\" = field::Empty\n    );\n\n    let _guard = span.enter();\n    let response = process(req).await?;\n    span.record(\"http.response.status_code\", response.status().as_u16());\n    Ok(response)\n}\n\nfn matched_route(_req: &Request) -> &'static str {\n    \"/orders/{id}\"\n}\n\nfn process(_req: Request) -> impl std::future::Future<Output = Result<Response, Error>> {\n    async { Ok(Response::new()) }\n}\n\npub struct Request;\npub struct Response;\nimpl Request {\n    fn method(&self) -> &'static str { \"GET\" }\n    fn uri(&self) -> http::Uri { \"https://api.example.com/orders/42\".parse().unwrap() }\n}\nimpl Response {\n    fn new() -> Self { Response }\n    fn status(&self) -> http::StatusCode { http::StatusCode::OK }\n}\n#[derive(Debug)]\npub struct Error;"
      },
      "questions": [
        {
          "q": "Which span name will keep the operation list bounded?",
          "options": [
            "GET /orders/{id}",
            "GET /orders/8f3a-4c2e-9b71",
            "GET /orders?id=8f3a",
            "orders-service-request-8f3a"
          ],
          "answer": 0,
          "explain": "The templated route is shared by every request to that endpoint, so latency aggregates per operation. The others create one group per request id."
        },
        {
          "q": "An outbound HTTP call to the payment provider is recorded with kind internal. What breaks?",
          "options": [
            "The backend cannot pair it with the callee's server span, so the dependency edge is missing",
            "The span is rejected by the OTLP exporter",
            "The span loses its attributes",
            "The trace id is regenerated"
          ],
          "answer": 0,
          "explain": "Service maps are built by matching client spans to server spans. With internal, the call looks like local work and the payment service appears to have no caller."
        },
        {
          "q": "A request returns 422 because the client sent an invalid field. What should the span status be?",
          "options": [
            "Unset: the request was handled correctly, it is a client error",
            "Error: any non-2xx is a failure",
            "Error, but with a warn log instead of error",
            "Ok, and the status code attribute should be omitted"
          ],
          "answer": 0,
          "explain": "Status error means the service failed to do its job. A rejected bad request is the service doing its job; record error.type=client_error and keep the SLO clean."
        }
      ],
      "quickbytes": [
        "Name spans after the operation, put the instance in attributes.",
        "Server and client kinds are what make the service map work.",
        "error status only for failures the caller experienced, never for 4xx.",
        "error.type must be a bounded enum; the raw message belongs elsewhere."
      ],
      "production": [
        "A lint or review check rejects span names containing ids, uuids, or query strings.",
        "Every inbound handler sets kind=server; every outbound call sets kind=client and peer.service.",
        "Span status is derived from one shared helper, not decided per handler.",
        "Attributes follow semantic-convention keys where a convention exists.",
        "No request or response bodies are attached to spans; a size limit is enforced in code review."
      ],
      "crates": [
        "tracing",
        "tracing-opentelemetry",
        "opentelemetry",
        "http"
      ],
      "github": [
        {
          "name": "open-telemetry/opentelemetry-rust",
          "url": "https://github.com/open-telemetry/opentelemetry-rust"
        },
        {
          "name": "tokio-rs/tracing",
          "url": "https://github.com/tokio-rs/tracing"
        }
      ],
      "pitfall": "Recording the status code with span.record after the span has been closed, or on a span handle that was never the one entered: the record is silently dropped and every request looks successful in the trace backend while the metrics show 500s.",
      "resources": [
        {
          "title": "OpenTelemetry trace semantic conventions",
          "url": "https://opentelemetry.io/docs/specs/semconv/general/trace/",
          "kind": "docs"
        },
        {
          "title": "tracing-opentelemetry: otel.name, otel.kind, otel.status_code",
          "url": "https://docs.rs/tracing-opentelemetry/latest/tracing_opentelemetry/",
          "kind": "docs"
        },
        {
          "title": "OpenTelemetry: traces concept",
          "url": "https://opentelemetry.io/docs/concepts/signals/traces/",
          "kind": "docs"
        },
        {
          "title": "OpenTelemetry channel: specification and implementation talks",
          "url": "https://www.youtube.com/@OpenTelemetry",
          "kind": "video"
        }
      ]
    },
    {
      "id": "j07",
      "n": 7,
      "title": "Context propagation: traceparent across boundaries",
      "minutes": 75,
      "level": "advanced",
      "goal": "Inject and extract W3C trace context at every boundary, and stop losing spans when work moves to a spawned task, a thread, or a queue.",
      "sections": [
        {
          "h": "One header carries the whole trace",
          "p": [
            "W3C trace context defines traceparent: a version, a 32-hex trace id, a 16-hex parent span id, and flags where the low bit means sampled. A real value looks like 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01. The receiving service makes its span a child of that parent span id.",
            "tracestate travels alongside it for vendor-specific data, and baggage carries application key-values. Neither is a trust boundary: any client can send any trace id, so never use baggage for authorization and never let an inbound trace id overwrite your own root decision about sampling."
          ]
        },
        {
          "h": "Inject on the way out, extract on the way in",
          "p": [
            "A propagator does both halves. On the client, inject the current context into the outgoing headers. On the server, extract the incoming headers into a Context and set it as the parent of the request span. If you do only one half, you get two traces instead of one.",
            "Set the global propagator once at startup with TraceContextPropagator, so every library that injects uses the same format. Do it before the server starts accepting requests, because the propagator is read on every inject and extract, and a late install leaves the first requests of a deploy as separate traces. Mixing B3 and W3C in one fleet is how traces stop at a service boundary."
          ],
          "code": "use http::HeaderMap;\nuse opentelemetry::global;\nuse opentelemetry::trace::TraceContextExt;\nuse opentelemetry_http::{HeaderExtractor, HeaderInjector};\nuse tracing_opentelemetry::OpenTelemetrySpanExt;\n\npub fn install_propagator() {\n    global::set_text_map_propagator(opentelemetry_sdk::propagation::TraceContextPropagator::new());\n}\n\npub fn continue_trace(headers: &HeaderMap) -> tracing::Span {\n    let parent = global::get_text_map_propagator(|prop| prop.extract(&HeaderExtractor(headers)));\n    let span = tracing::info_span!(\"http.request\", \"otel.kind\" = \"server\");\n    span.set_parent(parent);\n    span\n}\n\npub fn inject_into(headers: &mut HeaderMap) {\n    let cx = tracing::Span::current().context();\n    global::get_text_map_propagator(|prop| prop.inject_context(&cx, &mut HeaderInjector(headers)));\n}\n\npub fn trace_id_of_current_span() -> String {\n    tracing::Span::current()\n        .context()\n        .span()\n        .span_context()\n        .trace_id()\n        .to_string()\n}",
          "tip": "If a service in the middle of your call graph was written in another language, check that it speaks W3C. A single B3-only hop breaks the trace for everything behind it."
        },
        {
          "h": "Where context dies in async Rust",
          "p": [
            "The current span is a thread-local. tokio::spawn moves the future to another thread and polls it there, with no span entered, so every event inside the task is parentless. The same happens with std::thread::spawn, spawn_blocking, and any worker pool that does not carry the span.",
            "The fix is to capture the span before spawning and attach it to the future: let span = Span::current(); tokio::spawn(async move { ... }.instrument(span)). For channels, capture the span on the producer side and attach it on the consumer side, because a channel carries bytes, not context."
          ],
          "code": "use http::HeaderMap;\nuse tracing::Instrument;\n\npub fn spawn_with_context<F>(fut: F) -> tokio::task::JoinHandle<()>\nwhere\n    F: std::future::Future<Output = ()> + Send + 'static,\n{\n    // Capture before the move: inside the task, the current span is gone.\n    let span = tracing::Span::current();\n    tokio::spawn(async move { fut.await }.instrument(span))\n}\n\npub fn enqueue_with_context(queue: &Queue, payload: Vec<u8>) {\n    let ctx = tracing::Span::current().context();\n    let mut headers = HeaderMap::new();\n\n    opentelemetry::global::get_text_map_propagator(|prop| {\n        prop.inject_context(&ctx, &mut opentelemetry_http::HeaderInjector(&mut headers));\n    });\n\n    queue.publish(payload, headers);\n}\n\npub struct Queue;\nimpl Queue {\n    pub fn publish(&self, _payload: Vec<u8>, _headers: HeaderMap) {}\n}",
          "tip": "Any place you write tokio::spawn is a place to ask whether the new task should inherit the span. Usually yes; for background work that outlives the request, usually no."
        },
        {
          "h": "Propagation across queues and batches",
          "p": [
            "An async message has no request to hang the trace from, so you have a choice: continue the producer's trace as a child, or start a new trace and link it to the producer's span. Continuing is simpler and shows the causal chain; linking is more accurate when the consumer runs minutes later and the two should not share a latency budget.",
            "Whichever you pick, write the headers into the message envelope, not into the payload the business logic parses. A schema change to add trace headers is a version bump; an envelope field is invisible to consumers that do not care."
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a function that extracts traceparent from incoming headers, starts the request span as its child, and then runs work on a spawned task that keeps the same trace id.",
        "starter": "pub async fn handle(headers: HeaderMap) -> String {\n    // 1. extract the parent context\n    // 2. start a span and set it as the parent\n    // 3. spawn work that stays in the same trace\n    // 4. return the trace id\n    todo!()\n}",
        "hint": "extract with the global propagator and HeaderExtractor, set_parent on the span, capture Span::current() before tokio::spawn and instrument the task with it, then read the trace id from span.context().span().span_context().",
        "solution": "use http::HeaderMap;\nuse opentelemetry::global;\nuse opentelemetry::trace::TraceContextExt;\nuse opentelemetry_http::HeaderExtractor;\nuse tracing::Instrument;\nuse tracing_opentelemetry::OpenTelemetrySpanExt;\n\npub async fn handle(headers: HeaderMap) -> String {\n    let parent = global::get_text_map_propagator(|prop| prop.extract(&HeaderExtractor(&headers)));\n\n    let span = tracing::info_span!(\"http.request\", \"otel.kind\" = \"server\");\n    span.set_parent(parent);\n\n    let trace_id = span.context().span().span_context().trace_id().to_string();\n\n    let child = span.clone();\n    tokio::spawn(\n        async move {\n            tracing::info!(\"background work\");\n        }\n        .instrument(child),\n    )\n    .await\n    .expect(\"task joins\");\n\n    trace_id\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn traceparent_parses() {\n        let value = \"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01\";\n        let parts: Vec<&str> = value.split('-').collect();\n        assert_eq!(parts.len(), 4);\n        assert_eq!(parts[1].len(), 32);\n        assert_eq!(parts[2].len(), 16);\n        assert_eq!(parts[3], \"01\");\n    }\n}"
      },
      "questions": [
        {
          "q": "What does the flags field 01 at the end of traceparent mean?",
          "options": [
            "The sampled bit is set, so the caller recorded this trace",
            "The trace is the root of a new trace",
            "The trace id is compressed",
            "The request is retried"
          ],
          "answer": 0,
          "explain": "The low bit of the flags byte is the sampled flag. A downstream service must respect it: sampling again would either duplicate or drop half of an already-sampled trace."
        },
        {
          "q": "You call tokio::spawn without capturing the current span. What do the events inside the task look like?",
          "options": [
            "They are emitted with no parent span, so they are not attached to the request trace",
            "They inherit the span from the thread that polls them",
            "They panic because no span is entered",
            "They are buffered until a span is entered"
          ],
          "answer": 0,
          "explain": "The current span is thread-local and the executor polls the task on an arbitrary worker with no span entered, so the work becomes an orphan."
        },
        {
          "q": "Is it safe to read an authorization decision from baggage?",
          "options": [
            "No, baggage is client-controlled and must never be trusted for authorization",
            "Yes, because baggage is signed by the sender",
            "Yes, if the values are set by an upstream service",
            "Only if the transport is mTLS"
          ],
          "answer": 0,
          "explain": "Baggage is just headers. Anyone who can reach your endpoint can set them, so authorization has to come from a verified token, never from propagated metadata."
        }
      ],
      "quickbytes": [
        "Inject on the client, extract on the server; doing one half gives you two traces.",
        "Set the propagator globally at startup so every library agrees on the format.",
        "Capture Span::current() before tokio::spawn and instrument the task with it.",
        "Queues carry bytes, not context: put trace headers in the envelope."
      ],
      "production": [
        "The global propagator is set to W3C trace context, and every service in the graph supports it.",
        "Inbound traceparent is validated: wrong length or all-zero ids are treated as absent.",
        "Every tokio::spawn site either inherits the span deliberately or is documented as background work.",
        "Queue producers write trace headers into the message envelope.",
        "Trace ids from inbound requests are never trusted for sampling decisions on their own."
      ],
      "crates": [
        "opentelemetry",
        "opentelemetry_sdk",
        "opentelemetry-http",
        "tracing-opentelemetry"
      ],
      "github": [
        {
          "name": "open-telemetry/opentelemetry-rust",
          "url": "https://github.com/open-telemetry/opentelemetry-rust"
        }
      ],
      "pitfall": "Extracting the parent context but never calling set_parent: the span is created as a new root, the incoming traceparent is silently ignored, and every service appears to start its own trace so the waterfall always has depth one.",
      "resources": [
        {
          "title": "OpenTelemetry: context propagation",
          "url": "https://opentelemetry.io/docs/concepts/context-propagation/",
          "kind": "docs"
        },
        {
          "title": "opentelemetry-http: header injectors and extractors",
          "url": "https://docs.rs/opentelemetry-http/latest/opentelemetry_http/",
          "kind": "docs"
        },
        {
          "title": "tracing-opentelemetry: set_parent and OpenTelemetrySpanExt",
          "url": "https://docs.rs/tracing-opentelemetry/latest/tracing_opentelemetry/trait.OpenTelemetrySpanExt.html",
          "kind": "docs"
        },
        {
          "title": "OpenTelemetry channel: specification and implementation talks",
          "url": "https://www.youtube.com/@OpenTelemetry",
          "kind": "video"
        }
      ]
    },
    {
      "id": "j08",
      "n": 8,
      "title": "RED and USE: four metrics per component",
      "minutes": 65,
      "level": "advanced",
      "goal": "Choose RED for request-driven components and USE for resources, then pick the specific metrics that make each component diagnosable.",
      "sections": [
        {
          "h": "Two methods, two kinds of component",
          "p": [
            "RED - rate, errors, duration - describes a component that handles requests. It answers: how many per second, how many failed, and how slow were the successful ones. It is the right frame for an HTTP handler, a gRPC method, or a job consumer.",
            "USE - utilization, saturation, errors - describes a resource. It answers: how much of it is busy, how much work is queued waiting for it, and how often does it fail. It is the right frame for a connection pool, a disk, a CPU, or a bounded channel."
          ],
          "list": [
            "Request path: RED. The unit is a request and the user is waiting.",
            "Resource: USE. The unit is capacity and the user is queued.",
            "Both are needed for a full picture: RED tells you the symptom, USE tells you the cause"
          ]
        },
        {
          "h": "Applying the method to real components",
          "p": [
            "A database connection pool is not a request handler, so RED alone will not explain it: you need utilization (checked-out connections over max), saturation (time spent waiting for a checkout), and errors (checkout timeouts). That last one is usually the first symptom of exhaustion.",
            "A queue consumer is both: RED for the processing (rate of messages handled, error ratio, processing duration) and USE for the queue (depth, age of the oldest message, consumer concurrency in use). Depth alone is misleading when the arrival rate is spiky; age is what tells you whether users are waiting."
          ],
          "code": "use metrics::{counter, gauge, histogram};\n\n/// RED for one handled request.\npub fn record_red(route: &'static str, status: u16, elapsed_s: f64) {\n    counter!(\"http_requests_total\", \"route\" => route, \"status\" => status.to_string())\n        .increment(1);\n    histogram!(\"http_request_duration_seconds\", \"route\" => route).record(elapsed_s);\n}\n\n/// USE for the database pool.\npub fn record_pool(in_use: u32, max: u32, wait_s: f64, timeouts: u64) {\n    gauge!(\"db_pool_connections_in_use\").set(in_use as f64);\n    gauge!(\"db_pool_connections_max\").set(max as f64);\n    histogram!(\"db_pool_checkout_wait_seconds\").record(wait_s);\n    counter!(\"db_pool_checkout_timeouts_total\").absolute(timeouts);\n}\n\n/// USE for a queue.\npub fn record_queue(depth: u64, oldest_age_s: f64) {\n    gauge!(\"queue_depth\").set(depth as f64);\n    gauge!(\"queue_oldest_message_age_seconds\").set(oldest_age_s);\n}",
          "tip": "Absolute values for gauges: set the current count, do not increment and decrement, or a single missed decrement leaves the gauge wrong forever."
        },
        {
          "h": "Duration is a distribution, and the tail is the product",
          "p": [
            "The D in RED is a histogram, not an average, because the users who hurt are in the tail. The Tail at Scale paper makes the compounding argument precise: a request that fans out to 100 servers waits for the slowest of 100, so a per-server p99 becomes the median of the whole request. Tail latency is not an edge case at scale; it is the common case.",
            "That is why fan-out services need a p999 view and why retries make it worse: a retry multiplies the chance of hitting the slow path, and a retry storm converts a small tail into an outage. Alert on the tail you promise in the SLO, and watch the retry counter next to it."
          ]
        },
        {
          "h": "The metric everyone forgets is saturation",
          "p": [
            "Utilization without saturation is a trap: a pool at 95% utilization may be perfectly healthy if checkouts are instant, and a pool at 60% may be in trouble if every checkout waits 200 ms. Saturation - the queue, the wait, the age - is what turns utilization into a prediction instead of a number.",
            "If you only have room for three metrics on a resource, choose saturation over utilization. It is closer to the user, it moves before errors appear, and it is the number that tells you to scale out before the p99 does."
          ]
        }
      ],
      "exercise": {
        "prompt": "Classify these four components and pick a method for each: an HTTP handler, a Postgres pool, a Redis cache client, and an SQS-style queue consumer. Then write the emission code for the queue consumer, covering both request and resource views.",
        "starter": "// handler     -> ?\n// pg pool     -> ?\n// redis       -> ?\n// queue       -> ?\n\npub fn record_consumer(batch: usize, elapsed_s: f64, ok: bool, depth: u64, age_s: f64) {\n    todo!()\n}",
        "hint": "The handler is RED. The pool is USE (utilization, checkout wait, timeouts). Redis is USE plus a RED view of cache hits and latency. The consumer needs both: RED for processing, USE for queue depth and oldest-message age.",
        "solution": "use metrics::{counter, gauge, histogram};\n\n// handler -> RED\n// pg pool -> USE (in_use/max, checkout wait, timeouts)\n// redis   -> USE (connections, latency) + RED (hit ratio, errors)\n// queue   -> RED for processing, USE for the queue itself\n\npub fn record_consumer(batch: usize, elapsed_s: f64, ok: bool, depth: u64, age_s: f64) {\n    let result = if ok { \"ok\" } else { \"error\" };\n\n    // RED: how much work, how fast, how often it fails.\n    counter!(\"consumer_messages_total\", \"result\" => result).increment(batch as u64);\n    histogram!(\"consumer_batch_duration_seconds\").record(elapsed_s);\n\n    // USE: how much is waiting, and how stale it is.\n    gauge!(\"queue_depth\").set(depth as f64);\n    gauge!(\"queue_oldest_message_age_seconds\").set(age_s);\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn age_beats_depth_as_a_signal() {\n        // Depth 10 with 5 consumers is healthy; depth 10 with a 4 minute old\n        // message means the consumers are stuck.\n        let depth = 10_u64;\n        let age_s = 240.0_f64;\n        assert!(depth < 100 && age_s > 60.0);\n    }\n}"
      },
      "questions": [
        {
          "q": "Which set is USE, not RED?",
          "options": [
            "Utilization, saturation, errors",
            "Rate, errors, duration",
            "Requests, retries, timeouts",
            "Hits, misses, evictions"
          ],
          "answer": 0,
          "explain": "USE describes a resource: how busy it is, how much work waits for it, how often it fails. RED describes a request path."
        },
        {
          "q": "Why is a connection pool at 60% utilization possibly unhealthy?",
          "options": [
            "Saturation can be high while utilization is moderate, so checkouts wait",
            "Utilization is computed from the wrong denominator",
            "Pools always report utilization incorrectly",
            "Because 60% is below the autoscaling threshold"
          ],
          "answer": 0,
          "explain": "Utilization is an average over time and hides bursts. If checkouts queue for 200 ms, the pool is a bottleneck regardless of the average occupancy."
        },
        {
          "q": "What does the Tail at Scale argument imply for a service that fans out to 100 backends?",
          "options": [
            "The slowest of 100 responses dominates, so the request's p50 approaches the backend's p99",
            "Averages become more reliable as fan-out grows",
            "Retries reduce tail latency without side effects",
            "Per-backend p99 is irrelevant once you have 100 of them"
          ],
          "answer": 0,
          "explain": "Waiting for all 100 means the maximum matters. A 1% slow path per backend becomes roughly a 63% chance that at least one is slow, so the tail becomes the typical experience."
        }
      ],
      "quickbytes": [
        "RED for request paths, USE for resources; a component can need both.",
        "Saturation predicts outages; utilization only describes them.",
        "Gauges use set(), never increment/decrement, so a missed update cannot drift.",
        "Put the retry counter next to the latency panel: retries hide and then amplify tail latency."
      ],
      "production": [
        "Every service has RED metrics per route with the status class as a label.",
        "Every bounded resource exposes utilization, saturation, and errors.",
        "Latency panels show p50, p99 and p999, never a mean.",
        "Queue consumers expose oldest-message age, not just depth.",
        "Dashboard panels name the method they implement, so the next engineer knows what is missing."
      ],
      "crates": [
        "metrics",
        "metrics-exporter-prometheus",
        "prometheus"
      ],
      "github": [
        {
          "name": "metrics-rs/metrics",
          "url": "https://github.com/metrics-rs/metrics"
        }
      ],
      "pitfall": "Exposing only utilization for a pool: at 55% average occupancy the dashboard is green while checkout waits climb, because the average hides the bursts that queue requests behind a saturated pool.",
      "resources": [
        {
          "title": "The Tail at Scale",
          "url": "https://research.google/pubs/the-tail-at-scale/",
          "kind": "paper"
        },
        {
          "title": "OpenTelemetry metrics semantic conventions",
          "url": "https://opentelemetry.io/docs/specs/semconv/general/metrics/",
          "kind": "docs"
        },
        {
          "title": "metrics crate: gauges, counters, histograms",
          "url": "https://docs.rs/metrics/latest/metrics/",
          "kind": "docs"
        },
        {
          "title": "metrics-rs/metrics repository",
          "url": "https://github.com/metrics-rs/metrics",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "j09",
      "n": 9,
      "title": "SLIs and SLOs: measuring what users feel",
      "minutes": 85,
      "level": "advanced",
      "goal": "Define an SLI as a ratio of good events to valid events, pin it to a window and a data source, and turn it into an SLO you can compute from Prometheus.",
      "sections": [
        {
          "h": "An SLI is a ratio, measured where the user is",
          "p": [
            "An SLI is good events divided by valid events. Availability is successful requests over all valid requests; latency is requests faster than a threshold over all requests. Written as a ratio it is a number between 0 and 1 that you can average, alert on, and compare across services, which is why every serious SLO framework uses this shape.",
            "Measure it as close to the user as you can. A server-side SLI counts requests that reached your handler; it does not count the ones the load balancer refused because every backend was busy. If your only SLI is inside the process, an outage that prevents requests from arriving looks like a quiet, healthy service."
          ],
          "list": [
            "Availability: non-5xx responses / all valid responses",
            "Latency: responses under the threshold / all responses",
            "Freshness (for pipelines): records delivered within N minutes / records expected",
            "Quality (for data): records passing validation / records processed"
          ]
        },
        {
          "h": "The window and the target are part of the definition",
          "p": [
            "99.9% means nothing until you say over what. A rolling 28-day window is the common choice because it matches how people think about a month of reliability and it moves smoothly instead of resetting on the first of the month. A calendar window is easier to report but creates a cliff where the budget refills overnight.",
            "You also have to define valid. A 400 caused by a malformed client request is not a failure of your service, and counting it as one lets a broken integration burn your budget. Write the exclusions down explicitly, with the exact matcher, so the definition cannot drift between the document and the query."
          ],
          "code": "groups:\n  - name: slo.checkout\n    interval: 30s\n    rules:\n      # Denominator: all valid requests. 4xx from clients is excluded by design.\n      - record: slo:checkout_requests:rate5m\n        expr: sum(rate(http_requests_total{job=\"checkout\",status!~\"4..\"}[5m]))\n\n      # Numerator complement: server-side failures only.\n      - record: slo:checkout_bad:rate5m\n        expr: sum(rate(http_requests_total{job=\"checkout\",status=~\"5..\"}[5m]))\n\n      - record: slo:checkout_availability:ratio5m\n        expr: 1 - (slo:checkout_bad:rate5m / slo:checkout_requests:rate5m)\n\n      # Latency SLI: proportion of requests under 300 ms, read from buckets.\n      - record: slo:checkout_latency_ok:ratio5m\n        expr: |\n          sum(rate(http_request_duration_seconds_bucket{job=\"checkout\",le=\"0.3\"}[5m]))\n          /\n          sum(rate(http_request_duration_seconds_count{job=\"checkout\"}[5m]))",
          "tip": "The latency SLI reads the le=0.3 bucket, so the histogram must actually have a 0.3 boundary. If it does not, the ratio silently interpolates from the wrong bucket."
        },
        {
          "h": "Averages are not SLIs",
          "p": [
            "The claim that average latency is 80 ms is not an SLI, because it cannot tell you how many users were slow. The SLI shape forces the question you actually care about: what fraction of users got a response in under 300 ms? That number moves when the tail moves, and it is bounded, so a target on it is meaningful.",
            "The same argument applies to error rates expressed per minute. A minute is not a user. If one minute has 3 errors out of 10 requests and the next has 3 out of 10,000, the per-minute series looks identical while the user experience is not."
          ]
        },
        {
          "h": "Write the SLO down, with the query",
          "p": [
            "An SLO document that does not contain the query is a wish. The document should name the SLI, the exact PromQL or recording rule, the target, the window, the exclusions, the owner, and what happens when the budget is gone. Anything less and two engineers will compute two different numbers in the same incident review.",
            "Keep one SLO per user journey, not per endpoint. Checkout is a journey with several endpoints; a per-endpoint SLO tells you a route is slow but not whether anyone could buy anything. It also fragments the budget: ten endpoints each at 99.9% look healthy while the journey they compose is already at 99%."
          ]
        }
      ],
      "exercise": {
        "prompt": "Write two SLOs for checkout - availability and latency - as recording rules plus a one-paragraph definition each. Include the exact matchers, the window, and the exclusions, and state the target.",
        "starter": "groups:\n  - name: slo.checkout\n    rules:\n      # 1. availability ratio\n      # 2. latency ratio at 300 ms\n      # 3. document: target, window, exclusions, owner",
        "hint": "Exclude 4xx from the denominator, count only 5xx as bad, and read the latency numerator from the le=0.3 bucket. Use a rolling 28-day window and say so in the definition.",
        "solution": "groups:\n  - name: slo.checkout\n    interval: 30s\n    rules:\n      - record: slo:checkout_requests:rate5m\n        expr: sum(rate(http_requests_total{job=\"checkout\",status!~\"4..\"}[5m]))\n\n      - record: slo:checkout_bad:rate5m\n        expr: sum(rate(http_requests_total{job=\"checkout\",status=~\"5..\"}[5m]))\n\n      - record: slo:checkout_availability:ratio5m\n        expr: 1 - (slo:checkout_bad:rate5m / slo:checkout_requests:rate5m)\n\n      - record: slo:checkout_latency_ok:ratio5m\n        expr: |\n          sum(rate(http_request_duration_seconds_bucket{job=\"checkout\",le=\"0.3\"}[5m]))\n          /\n          sum(rate(http_request_duration_seconds_count{job=\"checkout\"}[5m]))\n\n# SLO 1 - Availability\n#   SLI:   1 - (5xx rate / valid request rate)\n#   Valid: all requests except 4xx (client errors are not service failures)\n#   Target: 99.9% over a rolling 28 days\n#   Owner: checkout team\n#\n# SLO 2 - Latency\n#   SLI:   proportion of requests completing in under 300 ms\n#   Target: 99% over a rolling 28 days\n#   Owner: checkout team\n#\n# Both are computed from the recording rules above, never from an ad-hoc query."
      },
      "questions": [
        {
          "q": "What is the correct denominator for a checkout availability SLI?",
          "options": [
            "All valid requests, excluding 4xx client errors",
            "All requests including 4xx and 5xx",
            "Only requests that returned 200",
            "All requests the load balancer received, including rejected ones"
          ],
          "answer": 0,
          "explain": "Client errors are not service failures, so including them lets a broken integration burn the budget. Whether to include load-balancer rejections depends on where you measure; pick one and document it."
        },
        {
          "q": "Why is a rolling 28-day window usually preferred to a calendar month?",
          "options": [
            "The budget moves smoothly instead of resetting to full on the first of the month",
            "Prometheus cannot compute calendar months",
            "It makes the target easier to hit",
            "It removes the need for exclusions"
          ],
          "answer": 0,
          "explain": "A calendar window creates a cliff: burn the budget early and the first of the month erases the evidence. A rolling window keeps the recent past visible at all times."
        },
        {
          "q": "Which statement is a valid latency SLI?",
          "options": [
            "The proportion of requests completing in under 300 ms",
            "The average latency of all requests",
            "The p99 latency sampled every minute",
            "The slowest request in the last hour"
          ],
          "answer": 0,
          "explain": "An SLI is a ratio of good events to valid events. A proportion is bounded, comparable, and moves when the tail moves; an average hides the tail entirely."
        }
      ],
      "quickbytes": [
        "SLI = good events / valid events; if you cannot write it as a ratio, it is not an SLI.",
        "Measure at the edge you promise, not the layer you own.",
        "The window and exclusions belong in the same document as the target.",
        "Latency SLIs read the le bucket at the SLO threshold; make sure that boundary exists."
      ],
      "production": [
        "Each user journey has one availability and one latency SLO, with the query in the document.",
        "SLIs are recorded by recording rules, so every dashboard and alert uses the same number.",
        "Exclusions are explicit matchers, reviewed when a new client integration ships.",
        "The SLO owner is a team, not an individual, and appears in the alert routing.",
        "SLO queries are tested against a known-good window before they are trusted."
      ],
      "crates": [
        "metrics",
        "metrics-exporter-prometheus",
        "prometheus"
      ],
      "github": [
        {
          "name": "prometheus/prometheus",
          "url": "https://github.com/prometheus/prometheus"
        }
      ],
      "pitfall": "Defining the SLI at the database layer because it is easy to query: the database can be perfectly healthy while the service in front of it times out, so the SLO reports 100% during a total outage.",
      "resources": [
        {
          "title": "prometheus/prometheus: recording rules and configuration",
          "url": "https://github.com/prometheus/prometheus",
          "kind": "repo"
        },
        {
          "title": "OpenTelemetry metrics semantic conventions",
          "url": "https://opentelemetry.io/docs/specs/semconv/general/metrics/",
          "kind": "docs"
        },
        {
          "title": "Honeycomb: observability engineering talks",
          "url": "https://www.youtube.com/@honeycombio",
          "kind": "video"
        },
        {
          "title": "prometheus crate: histogram buckets and exposition",
          "url": "https://docs.rs/prometheus/latest/prometheus/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "j10",
      "n": 10,
      "title": "Error budgets: spending reliability deliberately",
      "minutes": 65,
      "level": "advanced",
      "goal": "Convert an SLO into minutes of allowed failure, compute burn rate from counters, and attach a policy that says what happens when the budget is gone.",
      "sections": [
        {
          "h": "The budget is the SLO inverted",
          "p": [
            "A 99.9% target over 30 days allows 0.1% of the window to fail. In time that is 43 minutes and 12 seconds out of 43,200 minutes. At 99.95% it is 21 minutes 36 seconds; at 99% it is 7 hours 12 minutes. Writing the number in minutes changes the conversation, because everyone knows what 43 minutes of checkout being down means.",
            "The budget is not a target to spend. It is the amount of unreliability you have decided the product can absorb, and having it written down is what lets a team ship a risky change on purpose instead of by accident."
          ],
          "list": [
            "99% over 30 days: 7h 12m of allowed failure",
            "99.9% over 30 days: 43m 12s",
            "99.95% over 30 days: 21m 36s",
            "99.99% over 30 days: 4m 19s - and every dependency must be better than that"
          ]
        },
        {
          "h": "Burn rate turns the budget into a signal",
          "p": [
            "Burn rate is the observed error rate divided by the error rate the SLO allows. A burn rate of 1 means you will exhaust the budget exactly at the end of the window. A burn rate of 14.4 means you are spending the 30-day budget 14.4 times faster than planned, so it runs out in about two days.",
            "That is why burn rate beats a raw error-rate threshold. The same 0.5% error rate is fine for a 99% SLO and catastrophic for a 99.99% one, and burn rate encodes the difference without a per-service constant that nobody remembers to update."
          ],
          "code": "pub struct Slo {\n    pub target: f64,\n    pub window_days: f64,\n}\n\nimpl Slo {\n    /// Fraction of the window that may fail, e.g. 0.001 for 99.9%.\n    pub fn error_budget(&self) -> f64 {\n        1.0 - self.target\n    }\n\n    /// Allowed failure time across the whole window.\n    pub fn allowed_failure_seconds(&self) -> f64 {\n        self.window_days * 86_400.0 * self.error_budget()\n    }\n\n    /// Observed error ratio divided by the allowed ratio.\n    pub fn burn_rate(&self, observed_error_ratio: f64) -> f64 {\n        observed_error_ratio / self.error_budget()\n    }\n\n    /// Fraction of the budget still unspent, clamped to [0, 1].\n    pub fn budget_remaining(&self, bad_events: u64, valid_events: u64) -> f64 {\n        if valid_events == 0 {\n            return 1.0;\n        }\n        let spent = (bad_events as f64 / valid_events as f64) / self.error_budget();\n        (1.0 - spent).clamp(0.0, 1.0)\n    }\n\n    /// Time to exhaustion at the current burn rate, in hours.\n    pub fn hours_to_exhaustion(&self, observed_error_ratio: f64) -> f64 {\n        let burn = self.burn_rate(observed_error_ratio);\n        if burn <= 0.0 {\n            return f64::INFINITY;\n        }\n        (self.window_days * 24.0) / burn\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::Slo;\n\n    #[test]\n    fn budget_matches_the_arithmetic() {\n        let slo = Slo { target: 0.999, window_days: 30.0 };\n        assert!((slo.allowed_failure_seconds() - 2_592.0).abs() < 0.5); // 43m12s\n\n        // 14.4x burn: the 30-day budget is gone in ~50 hours.\n        assert!((slo.hours_to_exhaustion(0.0144) - 50.0).abs() < 0.1);\n\n        // Half the budget spent.\n        let remaining = slo.budget_remaining(500, 1_000_000);\n        assert!((remaining - 0.5).abs() < 0.01);\n    }\n}",
          "tip": "14.4 is not magic: it is 2% of a 30-day budget consumed in one hour, chosen so a fast burn pages long before the budget is gone."
        },
        {
          "h": "Policy is the part teams skip",
          "p": [
            "A budget with no policy is a dashboard nobody acts on. The policy says: when more than 50% of the budget is spent in a window, reliability work takes priority over new features for the next sprint; when the budget is exhausted, feature launches for that service stop until the SLO is met again, unless an exception is signed by the service owner and recorded.",
            "The policy only works if it is agreed before the incident. Written during an outage, it reads as a punishment, and the first exception becomes the norm. Put it in the same document as the SLO, name the person who can grant an exception, and review it quarterly, because a policy nobody remembers is indistinguishable from no policy at all."
          ]
        },
        {
          "h": "The budget is shared, and so is the blame",
          "p": [
            "If checkout calls four dependencies, each with a 99.95% SLO, the composition cannot beat 99.8% even when every service hits its target. Serial dependencies multiply: 0.999 raised to the fourth power is about 0.996. Budgets have to be allocated across the dependency tree, not set independently by each team.",
            "That allocation is a design decision. Either a dependency gets a tighter SLO, or the caller gets a fallback, or the user-facing target is looser. Pretending every service is 99.99% and hoping is how a 43-minute budget disappears in a ten-minute dependency outage."
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement the error-budget math for a configurable SLO: allowed failure time, burn rate, remaining budget, and hours to exhaustion. Add a test that pins 99.9% over 30 days to 43m12s and a 14.4x burn to roughly 50 hours.",
        "starter": "pub struct Slo { pub target: f64, pub window_days: f64 }\n\nimpl Slo {\n    pub fn allowed_failure_seconds(&self) -> f64 { todo!() }\n    pub fn burn_rate(&self, observed: f64) -> f64 { todo!() }\n    pub fn budget_remaining(&self, bad: u64, valid: u64) -> f64 { todo!() }\n}",
        "hint": "error_budget = 1 - target. allowed_failure = window_days * 86400 * error_budget. burn = observed / error_budget. hours to exhaustion = window_hours / burn. Clamp remaining to [0,1].",
        "solution": "#[derive(Debug, Clone, Copy)]\npub struct Slo {\n    pub target: f64,\n    pub window_days: f64,\n}\n\nimpl Slo {\n    pub fn error_budget(&self) -> f64 {\n        1.0 - self.target\n    }\n\n    pub fn allowed_failure_seconds(&self) -> f64 {\n        self.window_days * 86_400.0 * self.error_budget()\n    }\n\n    pub fn burn_rate(&self, observed_error_ratio: f64) -> f64 {\n        observed_error_ratio / self.error_budget()\n    }\n\n    pub fn budget_remaining(&self, bad_events: u64, valid_events: u64) -> f64 {\n        if valid_events == 0 {\n            return 1.0;\n        }\n        let spent = (bad_events as f64 / valid_events as f64) / self.error_budget();\n        (1.0 - spent).clamp(0.0, 1.0)\n    }\n\n    pub fn hours_to_exhaustion(&self, observed_error_ratio: f64) -> f64 {\n        let burn = self.burn_rate(observed_error_ratio);\n        if burn <= 0.0 {\n            f64::INFINITY\n        } else {\n            (self.window_days * 24.0) / burn\n        }\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::Slo;\n\n    #[test]\n    fn p99_9_over_30_days_is_43_minutes() {\n        let slo = Slo { target: 0.999, window_days: 30.0 };\n        let seconds = slo.allowed_failure_seconds();\n        assert!((seconds - 2_592.0).abs() < 0.5);\n        assert_eq!((seconds / 60.0).round() as u64, 43);\n    }\n\n    #[test]\n    fn fast_burn_exhausts_in_two_days() {\n        let slo = Slo { target: 0.999, window_days: 30.0 };\n        assert!((slo.burn_rate(0.0144) - 14.4).abs() < 1e-9);\n        assert!((slo.hours_to_exhaustion(0.0144) - 50.0).abs() < 0.1);\n    }\n\n    #[test]\n    fn half_the_budget_is_half() {\n        let slo = Slo { target: 0.999, window_days: 30.0 };\n        assert!((slo.budget_remaining(500, 1_000_000) - 0.5).abs() < 0.01);\n    }\n}"
      },
      "questions": [
        {
          "q": "A 99.9% SLO over 30 days allows how much failure time?",
          "options": [
            "About 43 minutes",
            "About 7 hours",
            "About 4 minutes",
            "About 21 minutes"
          ],
          "answer": 0,
          "explain": "30 days is 43,200 minutes, and 0.1% of that is 43.2 minutes. 7h12m is 99%, 21m36s is 99.95%, and 4m19s is 99.99%."
        },
        {
          "q": "What does a burn rate of 6 mean?",
          "options": [
            "The budget is being consumed six times faster than the window allows",
            "Six percent of requests are failing",
            "The SLO target is 6%",
            "The service has six hours left"
          ],
          "answer": 0,
          "explain": "Burn rate compares the observed error ratio to the allowed ratio. Six times faster means a 30-day budget is gone in five days at that rate."
        },
        {
          "q": "Why must budgets be allocated across a dependency tree?",
          "options": [
            "Serial dependencies multiply, so independent 99.99% targets still compose to a worse user-facing number",
            "Because Prometheus cannot aggregate across services",
            "Because each service has its own error budget by law",
            "Because burn rate is additive"
          ],
          "answer": 0,
          "explain": "Four serial dependencies at 99.99% each compose to roughly 99.96%, and at 99.95% each to about 99.8%. The user-facing target has to be derived, not assumed."
        }
      ],
      "quickbytes": [
        "Write the budget in minutes; nobody argues about what 43 minutes means.",
        "Burn rate = observed error ratio / allowed error ratio.",
        "14.4x over one hour consumes 2% of a 30-day budget.",
        "No policy, no budget: decide the freeze rule before the incident."
      ],
      "production": [
        "Every SLO has a published budget in minutes and a named policy owner.",
        "Burn rate is computed from recording rules, not recomputed in each dashboard.",
        "Budget exhaustion triggers a documented freeze, with a recorded exception path.",
        "Dependency budgets are allocated from the user-facing target, not set independently.",
        "The budget policy is reviewed at the same cadence as the SLO targets."
      ],
      "crates": [
        "prometheus",
        "metrics",
        "serde"
      ],
      "github": [
        {
          "name": "prometheus/prometheus",
          "url": "https://github.com/prometheus/prometheus"
        }
      ],
      "pitfall": "Computing the budget from the total number of requests ever served instead of a window: the ratio converges to a lifetime average, so a catastrophic week disappears into a year of healthy traffic and the budget never appears to run out.",
      "resources": [
        {
          "title": "prometheus/prometheus: recording and alerting rules",
          "url": "https://github.com/prometheus/prometheus",
          "kind": "repo"
        },
        {
          "title": "OpenTelemetry metrics semantic conventions",
          "url": "https://opentelemetry.io/docs/specs/semconv/general/metrics/",
          "kind": "docs"
        },
        {
          "title": "Honeycomb: observability engineering talks",
          "url": "https://www.youtube.com/@honeycombio",
          "kind": "video"
        },
        {
          "title": "metrics crate: counters for good and bad events",
          "url": "https://docs.rs/metrics/latest/metrics/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "j11",
      "n": 11,
      "title": "Alerting: burn rates, runbooks, and silence",
      "minutes": 80,
      "level": "industry",
      "goal": "Page only on user-visible symptoms, use multi-window burn rates to catch both fast and slow burns, and make every alert carry a runbook and an owner.",
      "sections": [
        {
          "h": "Alert on symptoms, not causes",
          "p": [
            "A page should mean a human is needed now because users are affected. Disk at 70% is a cause, not a symptom: it may never fill, and the action can wait for business hours. Checkout error budget burning 14x is a symptom, and it is worth waking someone.",
            "Cause-based paging is how teams end up with 40 alerts a week and an on-call who reflexively acknowledges without reading. A good test for any proposed alert: if it fires, what will the on-call do in the next five minutes? If the honest answer is nothing, it is a dashboard panel or a ticket, not a page."
          ],
          "list": [
            "Page: SLO burn, total outage, data loss, security event",
            "Ticket: capacity trends, certificate expiry in a week, a single failing replica",
            "Never page: a retry that succeeded, a cron that ran late, a build failure on main"
          ]
        },
        {
          "h": "Multi-window burn rate: fast and slow",
          "p": [
            "A single threshold cannot distinguish a ten-minute outage from a slow bleed, because the window that makes the fast burn visible is too noisy to catch the slow one. The standard answer is two windows per alert: a long window that confirms the problem is real, and a short window that confirms it is still happening, both required to fire.",
            "The canonical set is 14.4x over 1 hour with a 5 minute short window for a page, 6x over 6 hours with a 30 minute short window for a second page, and 1x over 3 days with a 6 hour short window for a ticket. Each number corresponds to consuming 2%, 5%, and 10% of a 30-day budget."
          ],
          "code": "groups:\n  - name: slo.checkout.burn\n    rules:\n      - alert: CheckoutAvailabilityBurnFast\n        # 0.001 is the allowed error ratio for a 99.9% SLO.\n        expr: |\n          (slo:checkout_bad:ratio1h > (14.4 * 0.001))\n          and\n          (slo:checkout_bad:ratio5m > (14.4 * 0.001))\n        for: 2m\n        labels:\n          severity: page\n          team: checkout\n        annotations:\n          summary: \"checkout burning 14.4x its availability budget\"\n          description: \"1h burn above 0.0144; budget gone in ~2 days at this rate.\"\n          runbook_url: \"https://runbooks.internal/checkout/availability\"\n\n      - alert: CheckoutAvailabilityBurnSlow\n        expr: |\n          (slo:checkout_bad:ratio6h > (6 * 0.001))\n          and\n          (slo:checkout_bad:ratio30m > (6 * 0.001))\n        for: 15m\n        labels:\n          severity: page\n          team: checkout\n        annotations:\n          summary: \"checkout burning 6x its availability budget\"\n          runbook_url: \"https://runbooks.internal/checkout/availability\"\n\n      - alert: CheckoutAvailabilityBudgetTight\n        expr: |\n          (slo:checkout_bad:ratio3d > (1 * 0.001))\n          and\n          (slo:checkout_bad:ratio6h > (1 * 0.001))\n        for: 1h\n        labels:\n          severity: ticket\n          team: checkout\n        annotations:\n          summary: \"checkout on track to miss its 28-day availability SLO\"\n          runbook_url: \"https://runbooks.internal/checkout/availability\"",
          "tip": "The for: clause suppresses the first minutes of noise. Two minutes for a fast burn, fifteen for a slow one, an hour for a ticket."
        },
        {
          "h": "Every alert needs an owner and a runbook",
          "p": [
            "An alert without a runbook is a puzzle delivered at 3 a.m. The runbook does not need to be long: what the alert means, the three queries to run first, the likely causes in order, and the safe mitigation with the exact command. Link it from the annotation so the on-call does not have to search.",
            "The owner label decides who is woken. Without it, routing falls back to whoever configured the integration, which is usually the person who left. Make team ownership a required label, and fail CI when an alert rule has no runbook_url.",
            "Inhibition rules matter too: if the whole cluster is down, do not send forty per-service pages. Inhibition expresses the dependency between alerts - while the cluster-level alert fires, the per-service pages add no decision and only add noise. One high-level page and one summary ticket is a better night for everyone."
          ]
        },
        {
          "h": "Alert fatigue is a production bug",
          "p": [
            "Track pages per week per on-call and treat a rising number as a defect, because the cost is not the interruption, it is the desensitisation. A team that gets twenty pages a week stops reading them, and the one that mattered looks like the nineteen that did not.",
            "Every page should be actionable, and every action taken should be recorded in the incident or the alert's history. Alerts that fire and are closed with no action should be deleted or converted into tickets; an alert nobody acts on is worse than no alert, because it teaches the team to ignore the channel."
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a page-level and a ticket-level alert for checkout availability from the 99.9% SLO. Use two windows per alert, add severity and team labels, a runbook link, and a for: that suppresses flapping.",
        "starter": "groups:\n  - name: slo.checkout.burn\n    rules:\n      - alert: CheckoutAvailabilityBurnFast\n        expr: |\n          # long window AND short window\n        labels:\n          severity: ?\n        annotations:\n          runbook_url: ?",
        "hint": "Page at 14.4x with 1h and 5m windows, ticket at 1x with 3d and 6h windows. Both conditions must hold, or the alert fires on a single spike.",
        "solution": "groups:\n  - name: slo.checkout.burn\n    rules:\n      - alert: CheckoutAvailabilityBurnFast\n        expr: |\n          (slo:checkout_bad:ratio1h > (14.4 * 0.001))\n          and\n          (slo:checkout_bad:ratio5m > (14.4 * 0.001))\n        for: 2m\n        labels:\n          severity: page\n          team: checkout\n        annotations:\n          summary: \"checkout burning 14.4x its availability budget\"\n          runbook_url: \"https://runbooks.internal/checkout/availability\"\n\n      - alert: CheckoutAvailabilityBudgetTight\n        expr: |\n          (slo:checkout_bad:ratio3d > (1 * 0.001))\n          and\n          (slo:checkout_bad:ratio6h > (1 * 0.001))\n        for: 1h\n        labels:\n          severity: ticket\n          team: checkout\n        annotations:\n          summary: \"checkout on track to miss its 28-day availability SLO\"\n          runbook_url: \"https://runbooks.internal/checkout/availability\"\n\n# CI check: every alert must have labels.team and annotations.runbook_url.\n# A rule without either fails the rules test before it reaches production."
      },
      "questions": [
        {
          "q": "Why does a burn-rate alert use two windows instead of one?",
          "options": [
            "The long window proves the burn is real, the short window proves it is still happening",
            "Prometheus requires two windows for any alert",
            "The short window is used for the ticket and the long one for the page",
            "Two windows double the alert's sensitivity to noise"
          ],
          "answer": 0,
          "explain": "A short-only alert flaps on every spike; a long-only alert keeps paging after the incident is over. Requiring both gives fast detection and fast reset."
        },
        {
          "q": "Disk usage on one replica hits 70%. What should it be?",
          "options": [
            "A ticket or nothing at all - it is a cause, not a user-visible symptom",
            "A page, because disk can fill",
            "A page only if the replica is in production",
            "An alert that pages after one minute"
          ],
          "answer": 0,
          "explain": "Pages are for user-visible pain. Capacity trends belong in a ticket, unless the trend predicts exhaustion inside the response window."
        },
        {
          "q": "What is the main cost of a noisy alert set?",
          "options": [
            "Desensitisation: the team stops reading pages, so the real one is missed",
            "Higher Prometheus storage usage",
            "Slower rule evaluation",
            "Alertmanager drops rules after a threshold"
          ],
          "answer": 0,
          "explain": "The damage is human. Twenty pages a week trains an on-call to acknowledge without investigating, which is exactly the behaviour that turns a small outage into a long one."
        }
      ],
      "quickbytes": [
        "Page on symptoms; put causes in tickets.",
        "14.4x/1h + 5m to page, 6x/6h + 30m to escalate, 1x/3d + 6h to ticket.",
        "Every alert needs labels.team and annotations.runbook_url, enforced in CI.",
        "Delete alerts that get acknowledged and closed with no action."
      ],
      "production": [
        "Every page maps to a user-visible symptom and has a runbook link.",
        "Alert rules are tested in CI, including a check for owner and runbook annotations.",
        "Inhibition rules collapse a cluster-wide failure into one page.",
        "Pages per week per team are tracked and reviewed at the reliability retro.",
        "Every alert has a documented action; alerts without one are removed."
      ],
      "crates": [
        "prometheus",
        "metrics",
        "tracing"
      ],
      "github": [
        {
          "name": "prometheus/prometheus",
          "url": "https://github.com/prometheus/prometheus"
        }
      ],
      "pitfall": "Alerting on a raw error count instead of a rate: a fixed threshold fires at 3 a.m. when traffic is low and stays silent at peak when the same absolute number is meaningless, so the alert is both noisy and wrong.",
      "resources": [
        {
          "title": "prometheus/prometheus: alerting rules",
          "url": "https://github.com/prometheus/prometheus/blob/main/docs/configuration/alerting_rules.md",
          "kind": "repo"
        },
        {
          "title": "prometheus/prometheus: recording rules",
          "url": "https://github.com/prometheus/prometheus/blob/main/docs/configuration/recording_rules.md",
          "kind": "repo"
        },
        {
          "title": "Honeycomb: observability engineering talks",
          "url": "https://www.youtube.com/@honeycombio",
          "kind": "video"
        },
        {
          "title": "OpenTelemetry metrics semantic conventions",
          "url": "https://opentelemetry.io/docs/specs/semconv/general/metrics/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "j12",
      "n": 12,
      "title": "Dashboards: one screen, four questions",
      "minutes": 60,
      "level": "advanced",
      "goal": "Design a service dashboard that answers is it broken, how bad, who is affected, and since when - with queries and rate windows that are correct.",
      "sections": [
        {
          "h": "A dashboard is an argument, not a gallery",
          "p": [
            "Most dashboards are a wall of forty panels because each was added during a different incident and none was removed. The result is that nobody looks at any of them: the information is technically present and practically invisible. The fix is a deletion pass, not a redesign - every panel has to answer a question someone actually asked during an incident.",
            "A service dashboard should make one argument in the first row - is this service healthy right now - and then let you drill into the part that is not. Everything else belongs in a linked dashboard or an ad-hoc query, not on the front page."
          ],
          "list": [
            "Is it broken? SLO burn rate, single number, coloured by threshold",
            "How bad? Error ratio and the p99 against the SLO threshold",
            "Who is affected? The same ratios split by route and by client",
            "Since when? Deploy markers and config-change annotations on the same axis"
          ]
        },
        {
          "h": "Top row: traffic, errors, latency, saturation",
          "p": [
            "The four-panel top row works because it maps to RED and USE at a glance: requests per second, error ratio, latency quantiles, and saturation of the tightest resource. All four on the same time range and the same step, so a spike lines up vertically without mental arithmetic.",
            "Resist the temptation to put CPU first. CPU is a cause; if the service is healthy and CPU is high, that is a capacity note, not an incident. The top row should start with what users experience. The one exception is a service whose only failure mode is saturation, and even then the first panel is the queue depth users feel, not the CPU behind it."
          ]
        },
        {
          "h": "Rate windows must respect the scrape interval",
          "p": [
            "A rate() over a window shorter than four scrape intervals produces gaps and wild spikes, because some windows contain one sample and some contain none. With a 15 second scrape, a one-minute rate is the minimum sane choice, and five minutes is the usual default for a dashboard.",
            "Grafana exposes this as a variable that expands to a window derived from the scrape interval and the panel resolution; Prometheus's own guidance is the same. Hard-coding rate(x[1m]) against a 30 second scrape is a classic source of phantom spikes that send people chasing ghosts."
          ],
          "code": "{\n  \"title\": \"checkout - service health\",\n  \"panels\": [\n    {\n      \"title\": \"Availability SLO burn (1h)\",\n      \"type\": \"stat\",\n      \"targets\": [{ \"expr\": \"slo:checkout_bad:ratio1h / 0.001\" }],\n      \"thresholds\": { \"mode\": \"absolute\", \"steps\": [\n        { \"color\": \"green\", \"value\": null },\n        { \"color\": \"orange\", \"value\": 6 },\n        { \"color\": \"red\", \"value\": 14.4 }\n      ]}\n    },\n    {\n      \"title\": \"Traffic and errors by route\",\n      \"type\": \"timeseries\",\n      \"targets\": [\n        { \"expr\": \"sum by (route) (rate(http_requests_total{job=\\\"checkout\\\"}[$__rate_interval]))\", \"legendFormat\": \"{{route}} rps\" },\n        { \"expr\": \"sum by (route) (rate(http_requests_total{job=\\\"checkout\\\",status=~\\\"5..\\\"}[$__rate_interval]))\", \"legendFormat\": \"{{route}} 5xx\" }\n      ]\n    },\n    {\n      \"title\": \"Latency p50 / p99 vs 300 ms SLO\",\n      \"type\": \"timeseries\",\n      \"targets\": [\n        { \"expr\": \"histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{job=\\\"checkout\\\"}[$__rate_interval])))\", \"legendFormat\": \"p99\" },\n        { \"expr\": \"histogram_quantile(0.50, sum by (le) (rate(http_request_duration_seconds_bucket{job=\\\"checkout\\\"}[$__rate_interval])))\", \"legendFormat\": \"p50\" }\n      ]\n    }\n  ]\n}",
          "tip": "Put the SLO threshold on the latency panel as a constant line. A p99 panel without the target forces the reader to remember the number, and they will not."
        },
        {
          "h": "Dashboards as code, or they rot",
          "p": [
            "A dashboard edited in the UI is a document with no history and no review. Store the JSON in the repository, generate it from a template per service, and let the same recording rules back every panel so a query change is one commit.",
            "One dashboard per service, plus one per user journey that links to them. The journey dashboard answers whether users can buy; the service dashboards answer why they cannot. Anything that fits neither is an ad-hoc query with a saved link."
          ]
        }
      ],
      "exercise": {
        "prompt": "Define the four top-row panels for a checkout service: availability burn, traffic, error ratio, and p99 against a 300 ms SLO. Use the rate interval variable, not a hard-coded window, and explain what each panel answers.",
        "starter": "panels:\n  - title: ?\n    expr: ?\n  # traffic, errors, latency, saturation",
        "hint": "Availability from the SLO recording rule divided by 0.001, traffic from rate(http_requests_total), errors as a ratio, latency from histogram_quantile over the le buckets, all with $__rate_interval.",
        "solution": "# Top row, left to right. Every panel uses the same time range and step.\npanels:\n  - title: \"Availability burn (1h, x budget)\"\n    answers: \"Is it broken right now, and how fast are we spending?\"\n    expr: slo:checkout_bad:ratio1h / 0.001\n    thresholds: [1, 6, 14.4]\n\n  - title: \"Traffic by route\"\n    answers: \"Did the request volume change, or did the failure rate?\"\n    expr: sum by (route) (rate(http_requests_total{job=\"checkout\"}[$__rate_interval]))\n\n  - title: \"Error ratio by route\"\n    answers: \"How bad is it, and which route is responsible?\"\n    expr: |\n      sum by (route) (rate(http_requests_total{job=\"checkout\",status=~\"5..\"}[$__rate_interval]))\n      /\n      sum by (route) (rate(http_requests_total{job=\"checkout\",status!~\"4..\"}[$__rate_interval]))\n\n  - title: \"Latency p50 / p99 vs 300 ms SLO\"\n    answers: \"Are users waiting, and is it the tail or the whole distribution?\"\n    expr: histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{job=\"checkout\"}[$__rate_interval])))\n    threshold_line: 0.3\n\n# Below the fold: per-dependency latency, pool saturation, deploy annotations.\n# Everything else is a link, not a panel."
      },
      "questions": [
        {
          "q": "Why is rate(x[1m]) risky against a 30 second scrape interval?",
          "options": [
            "Some windows contain two samples and some contain one, producing gaps and spikes",
            "Prometheus rejects windows shorter than five minutes",
            "The counter resets every minute",
            "It always returns zero"
          ],
          "answer": 0,
          "explain": "A rate needs enough samples to be stable. With a 30 second scrape, a one-minute window holds two points at best and one at worst, so the extrapolation swings wildly."
        },
        {
          "q": "What belongs in the first row of a service dashboard?",
          "options": [
            "Traffic, errors, latency, saturation",
            "CPU, memory, disk, network",
            "Every endpoint's p99",
            "The deploy log"
          ],
          "answer": 0,
          "explain": "The first row answers whether users are affected. Host metrics are causes, and they belong below the fold or on the resource dashboard."
        },
        {
          "q": "Why store dashboards as JSON in the repository?",
          "options": [
            "They become reviewable and reproducible, and can be generated per service",
            "Grafana cannot save dashboards otherwise",
            "JSON is faster to render than the UI format",
            "It removes the need for recording rules"
          ],
          "answer": 0,
          "explain": "A dashboard edited in the UI has no history and no review. Versioned JSON plus a template means a query change is a commit and a rollout, not a mystery edit at 2 a.m."
        }
      ],
      "quickbytes": [
        "Top row answers is it broken, how bad, who, since when - nothing else.",
        "Use $__rate_interval or at least four scrape intervals; never a hard-coded 1m.",
        "Put the SLO threshold on the latency panel as a constant line.",
        "One dashboard per service plus one per journey; everything else is a link."
      ],
      "production": [
        "The service dashboard's first row is traffic, errors, latency, and saturation.",
        "All rate windows derive from the scrape interval, not from a literal.",
        "Deploy and config-change annotations share the time axis with the panels.",
        "Dashboard JSON lives in the repository and is deployed through CI.",
        "Each panel states the question it answers in its title or description."
      ],
      "crates": [
        "metrics",
        "metrics-exporter-prometheus",
        "prometheus"
      ],
      "github": [
        {
          "name": "prometheus/prometheus",
          "url": "https://github.com/prometheus/prometheus"
        }
      ],
      "pitfall": "A dashboard whose panels use three different rate windows and two different time ranges: during an incident the graphs disagree with each other, and the team spends the first ten minutes arguing about which one is correct.",
      "resources": [
        {
          "title": "Grafana: dashboards and observability talks",
          "url": "https://www.youtube.com/@Grafana",
          "kind": "video"
        },
        {
          "title": "prometheus/prometheus: querying basics and functions",
          "url": "https://github.com/prometheus/prometheus",
          "kind": "repo"
        },
        {
          "title": "OpenTelemetry metrics semantic conventions",
          "url": "https://opentelemetry.io/docs/specs/semconv/general/metrics/",
          "kind": "docs"
        },
        {
          "title": "metrics-exporter-prometheus: exposition and naming",
          "url": "https://docs.rs/metrics-exporter-prometheus/latest/metrics_exporter_prometheus/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "j13",
      "n": 13,
      "title": "Profiling: where the CPU actually went",
      "minutes": 75,
      "level": "advanced",
      "goal": "Capture an in-process CPU profile with pprof, read a flame graph without misinterpreting it, and expose profiling on demand instead of permanently.",
      "sections": [
        {
          "h": "Metrics tell you it is slow; a profile tells you what is hot",
          "p": [
            "A CPU profile is a statistical sample of the stack, taken at a fixed frequency - 99 or 100 Hz is typical. Each sample records which function was running, and the aggregation of thousands of samples approximates where the time went. It is not an exact accounting, and it does not need to be: a function that owns 40% of the width owns roughly 40% of the CPU.",
            "That is different from tracing. A trace tells you a request was slow; a profile tells you the process spent 40% of its time in one serialization routine across all requests. Use traces for a specific request, profiles for the process as a whole."
          ]
        },
        {
          "h": "pprof in process, with a guard",
          "p": [
            "The pprof crate installs a signal-based sampler in your process. ProfilerGuardBuilder sets the frequency and a blocklist of frames to drop (libc, libgcc, pthread, vdso), and profiling continues until the guard is dropped. report() then builds an aggregated report, which can be rendered as a flame graph.",
            "Symbolization needs debug information, so profile a release build with debug symbols or a separate symbol file, not a stripped binary. On Linux the sampler needs permission to use perf events, which perf_event_paranoid controls; in a container that often means a capability, not root."
          ],
          "code": "use pprof::ProfilerGuardBuilder;\nuse std::fs::File;\nuse std::time::Duration;\n\n/// Capture N seconds of CPU samples and write a flame graph SVG.\npub fn capture(seconds: u64, out: &str) -> Result<(), Box<dyn std::error::Error>> {\n    let guard = ProfilerGuardBuilder::default()\n        .frequency(99)\n        .blocklist(&[\"libc\", \"libgcc\", \"pthread\", \"vdso\"])\n        .build()?;\n\n    std::thread::sleep(Duration::from_secs(seconds));\n\n    let report = guard.report().build()?;\n    let file = File::create(out)?;\n    report.flamegraph(file)?;\n\n    Ok(())\n}",
          "tip": "99 Hz rather than 1000: the sampler's own cost is proportional to frequency, and 99 Hz is plenty to rank functions by share."
        },
        {
          "h": "Reading a flame graph honestly",
          "p": [
            "Width is the share of samples, and the bottom of the graph is the entry point, so a wide frame anywhere is expensive. A tall stack is not automatically a problem: deep recursion that is cheap costs nothing, while one wide leaf frame that nobody expected is usually the answer.",
            "The trap is looking only at leaves. A wide frame with narrow children means the function itself is hot; a narrow frame with a wide child means the cost is downstream, and optimizing the parent is wasted work. Click through to self time before you rewrite anything."
          ],
          "list": [
            "Wide leaf: the function itself is the cost - start here",
            "Narrow parent, wide child: follow the child, not the parent",
            "Wide but expected: allocation, hashing, syscalls - confirm with a counter before optimizing",
            "Flat profile with no obvious hotspot: you are probably looking at off-CPU time, not CPU"
          ]
        },
        {
          "h": "On-CPU only: the blind spot",
          "p": [
            "A CPU profiler samples running threads. A task blocked on a mutex, a socket, or a full channel is not running, so it contributes nothing to the profile while being exactly the reason the request is slow. A profile that shows an idle process during a latency incident is not a broken profiler; it is telling you the problem is waiting, not computing.",
            "For async Rust, pair the CPU profile with tokio-console, which shows per-task poll times and busy/idle state. A task that is polled for 2 ms and then idle for 800 ms waiting on a lock looks healthy in a flame graph and terrible in the console."
          ],
          "code": "// Cargo.toml: console-subscriber = \"0.5\", tokio with features = [\"full\", \"tracing\"]\n// .cargo/config.toml:\n//   [build]\n//   rustflags = [\"--cfg\", \"tokio_unstable\"]\n\nfn main() {\n    // Requires tokio_unstable at build time; serves the console on 127.0.0.1:6669.\n    console_subscriber::init();\n\n    tokio::runtime::Builder::new_multi_thread()\n        .enable_all()\n        .build()\n        .expect(\"runtime\")\n        .block_on(async_main());\n}\n\nasync fn async_main() {\n    // Tasks that stall on locks or channels show up here with long idle times,\n    // which a CPU flame graph can never show.\n}",
          "tip": "tokio-console needs tokio_unstable and the tokio tracing feature; without both, the console starts and shows nothing."
        }
      ],
      "exercise": {
        "prompt": "Add an on-demand profiling endpoint: authenticated, capped at 30 seconds, writing a flame graph named after service, version and timestamp, and refusing concurrent captures.",
        "starter": "pub async fn profile_handler(seconds: Option<u64>) -> Result<String, String> {\n    // 1. authorize\n    // 2. cap the duration\n    // 3. refuse if a capture is already running\n    // 4. return the artifact path\n    todo!()\n}",
        "hint": "Use an AtomicBool compare_exchange as the single-capture guard, clamp the duration to at most 30, and put the version in the filename so a profile can be matched to a deploy.",
        "solution": "use pprof::ProfilerGuardBuilder;\nuse std::fs::File;\nuse std::sync::atomic::{AtomicBool, Ordering};\nuse std::time::{Duration, SystemTime, UNIX_EPOCH};\n\nstatic CAPTURING: AtomicBool = AtomicBool::new(false);\n\npub fn capture(service: &str, version: &str, requested_s: u64) -> Result<String, String> {\n    if CAPTURING\n        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)\n        .is_err()\n    {\n        return Err(\"a capture is already running\".to_string());\n    }\n    // Always release the flag, even on the error paths below.\n    struct Release;\n    impl Drop for Release {\n        fn drop(&mut self) {\n            CAPTURING.store(false, Ordering::Release);\n        }\n    }\n    let _release = Release;\n\n    let seconds = requested_s.clamp(1, 30);\n    let guard = ProfilerGuardBuilder::default()\n        .frequency(99)\n        .blocklist(&[\"libc\", \"libgcc\", \"pthread\", \"vdso\"])\n        .build()\n        .map_err(|e| format!(\"sampler: {e}\"))?;\n\n    std::thread::sleep(Duration::from_secs(seconds));\n\n    let report = guard.report().build().map_err(|e| format!(\"report: {e}\"))?;\n    let ts = SystemTime::now()\n        .duration_since(UNIX_EPOCH)\n        .map_err(|e| format!(\"clock: {e}\"))?\n        .as_secs();\n    let path = format!(\"/var/lib/profiles/{service}-{version}-{ts}.svg\");\n\n    let file = File::create(&path).map_err(|e| format!(\"create: {e}\"))?;\n    report.flamegraph(file).map_err(|e| format!(\"flamegraph: {e}\"))?;\n\n    Ok(path)\n}"
      },
      "questions": [
        {
          "q": "In a flame graph, what does the width of a frame represent?",
          "options": [
            "The share of samples in which that frame appeared on the stack",
            "How many times the function was called",
            "The wall-clock duration of one call",
            "The depth of the call stack"
          ],
          "answer": 0,
          "explain": "A flame graph is built from sampled stacks, so width is proportional to time on CPU. Call counts are a different measurement and are not recoverable from the graph."
        },
        {
          "q": "Why is 99 Hz a better default than 1000 Hz for an in-process profiler?",
          "options": [
            "The sampler's overhead scales with frequency, and 99 Hz is enough to rank functions",
            "1000 Hz exceeds the kernel timer resolution",
            "99 Hz captures more stack frames per sample",
            "Higher frequencies lose symbols"
          ],
          "answer": 0,
          "explain": "Signal-based sampling costs CPU and perturbates the workload. At 99 Hz a 30 second capture still yields about 3,000 samples, which is plenty for ranking."
        },
        {
          "q": "During a latency incident the CPU profile shows an almost idle process. What is the likely explanation?",
          "options": [
            "The time is off-CPU: waiting on locks, I/O, or channels",
            "The profiler failed to attach",
            "The binary lacks debug symbols",
            "The workload is CPU bound but the sample rate is too low"
          ],
          "answer": 0,
          "explain": "CPU sampling only sees running threads. Blocked tasks are invisible to it, which is why tokio-console's idle times are the right second tool for async stalls."
        }
      ],
      "quickbytes": [
        "Profile a release build with debug symbols, never a stripped one.",
        "Look at self time before rewriting a wide frame with wide children.",
        "99 Hz is the default for a reason; raise it only for a short, targeted capture.",
        "A profile is on-CPU only: pair it with tokio-console for waiting."
      ],
      "production": [
        "Profiling is exposed on an authenticated internal endpoint, never on the public listener.",
        "Captures are capped in duration and limited to one at a time.",
        "Artifacts are named with service, version and timestamp, and retained for a bounded period.",
        "Linux deployments grant the perf capability explicitly rather than running as root.",
        "Profiles are part of the release checklist for services with a CPU regression history."
      ],
      "crates": [
        "pprof",
        "console-subscriber",
        "tokio"
      ],
      "github": [
        {
          "name": "tikv/pprof-rs",
          "url": "https://github.com/tikv/pprof-rs"
        },
        {
          "name": "tokio-rs/console",
          "url": "https://github.com/tokio-rs/console"
        }
      ],
      "pitfall": "Profiling a debug build: unoptimized code inlines nothing and every iterator is a separate frame, so the flame graph shows a plausible-looking hotspot that does not exist in the release binary you actually run.",
      "resources": [
        {
          "title": "pprof crate: guards, reports, flame graphs",
          "url": "https://docs.rs/pprof/latest/pprof/",
          "kind": "docs"
        },
        {
          "title": "tikv/pprof-rs repository",
          "url": "https://github.com/tikv/pprof-rs",
          "kind": "repo"
        },
        {
          "title": "console-subscriber: tokio-console instrumentation",
          "url": "https://docs.rs/console-subscriber/latest/console_subscriber/",
          "kind": "docs"
        },
        {
          "title": "Jon Gjengset: Rust performance and internals talks",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ]
    },
    {
      "id": "j14",
      "n": 14,
      "title": "Continuous profiling: always-on, low overhead",
      "minutes": 70,
      "level": "industry",
      "goal": "Sample profiles on a schedule, tag them by version, and diff two builds to find the regression that a one-off capture would miss.",
      "sections": [
        {
          "h": "From a capture to a time series of stacks",
          "p": [
            "A one-off profile answers a question you already had. Continuous profiling answers the question you did not know to ask: which function got slower after Tuesday's release, across every replica, without anyone reproducing it locally. The unit of storage stops being a file and becomes a (stack, version, timestamp) aggregate.",
            "The design that works is boring: sample for ten seconds every minute, aggregate by stack, label with service.name, service.version and the pod, and keep a bounded retention. Ten seconds in sixty gives roughly 16% of the CPU time as samples while costing about a sixth of an always-on profiler."
          ]
        },
        {
          "h": "The overhead budget is the design constraint",
          "p": [
            "Continuous profiling is only acceptable if nobody can measure it: a target under 1% CPU, and no visible p99 change. That rules out 1000 Hz, and it usually rules out 99 Hz for the whole fleet. 19 to 49 Hz over short windows is the usual compromise.",
            "Measure the profiler itself before rolling it out. Run a load test with the sampler on and off, compare throughput and p99, and record the numbers next to the feature flag. A profiler that costs 5% CPU is a 5% capacity cut nobody approved."
          ],
          "code": "use pprof::ProfilerGuardBuilder;\nuse std::fs::File;\nuse std::time::{Duration, SystemTime, UNIX_EPOCH};\n\n/// 10 seconds of sampling every minute, at 49 Hz, tagged by version.\npub fn spawn_sampler(service: &'static str, version: &'static str, dir: &'static str) {\n    std::thread::spawn(move || loop {\n        let guard = match ProfilerGuardBuilder::default()\n            .frequency(49)\n            .blocklist(&[\"libc\", \"libgcc\", \"pthread\", \"vdso\"])\n            .build()\n        {\n            Ok(guard) => guard,\n            Err(_) => {\n                std::thread::sleep(Duration::from_secs(60));\n                continue;\n            }\n        };\n\n        std::thread::sleep(Duration::from_secs(10));\n\n        if let Ok(report) = guard.report().build() {\n            let ts = SystemTime::now()\n                .duration_since(UNIX_EPOCH)\n                .map(|d| d.as_secs())\n                .unwrap_or_default();\n            let path = format!(\"{dir}/{service}-{version}-{ts}.svg\");\n            if let Ok(file) = File::create(&path) {\n                let _ = report.flamegraph(file);\n            }\n        }\n\n        std::thread::sleep(Duration::from_secs(50));\n    });\n}",
          "tip": "Aggregate before you store. Ten thousand identical stacks should be one row with a count, not ten thousand files."
        },
        {
          "h": "What the diff is for",
          "p": [
            "The payoff is the version diff: take the top stacks for version A and version B over the same traffic shape and compare shares. A function that went from 3% to 18% of samples after a deploy is a regression you can name, with a stack, in minutes.",
            "This is also how you catch death by a thousand cuts. Nobody notices a 2% regression per release, but six releases later the service is 15% slower and the flame graph looks completely different from the one in the runbook."
          ],
          "list": [
            "Compare like with like: same route mix, same traffic level, same duration",
            "Normalize by total samples, not absolute counts",
            "Keep the build id or version in the label, or the diff is meaningless",
            "Retain enough history to cover a full release cycle, not forever"
          ]
        },
        {
          "h": "Shipping and retention",
          "p": [
            "Profile artifacts are small compared to traces - tens of kilobytes compressed per capture - but the count multiplies by replicas and minutes. Upload them to object storage with a lifecycle rule, or send them to a profiling backend, and keep raw captures for days and aggregates for months.",
            "The OpenTelemetry profiles signal exists and is still experimental in the ecosystem; until it settles, the pragmatic path is pprof's protobuf format plus your own labels, and a Collector pipeline that carries only the label set you need. That is not a reason to wait: the pprof format is stable enough to store, and the labels you attach now are the ones a future pipeline will expect."
          ]
        }
      ],
      "exercise": {
        "prompt": "Build a continuous sampler: 10 seconds of sampling per minute at 49 Hz, artifacts named by service, version and timestamp, a hard cap on retained files, and a feature flag that can disable it without a redeploy.",
        "starter": "pub fn spawn_sampler(service: &'static str, version: &'static str) {\n    // 1. loop: sample 10s, sleep 50s\n    // 2. name the artifact with service + version + ts\n    // 3. prune old files\n    // 4. check the enable flag each iteration\n    todo!()\n}",
        "hint": "Check the flag at the top of each iteration so disabling takes effect within a minute. Prune by sorting the directory entries and deleting the oldest beyond the cap.",
        "solution": "use pprof::ProfilerGuardBuilder;\nuse std::fs;\nuse std::path::PathBuf;\nuse std::sync::atomic::{AtomicBool, Ordering};\nuse std::time::{Duration, SystemTime, UNIX_EPOCH};\n\npub static PROFILING_ENABLED: AtomicBool = AtomicBool::new(true);\nconst MAX_ARTIFACTS: usize = 500;\n\npub fn spawn_sampler(service: &'static str, version: &'static str, dir: &'static str) {\n    std::thread::spawn(move || loop {\n        if !PROFILING_ENABLED.load(Ordering::Relaxed) {\n            std::thread::sleep(Duration::from_secs(60));\n            continue;\n        }\n\n        if let Ok(guard) = ProfilerGuardBuilder::default()\n            .frequency(49)\n            .blocklist(&[\"libc\", \"libgcc\", \"pthread\", \"vdso\"])\n            .build()\n        {\n            std::thread::sleep(Duration::from_secs(10));\n\n            if let Ok(report) = guard.report().build() {\n                let ts = SystemTime::now()\n                    .duration_since(UNIX_EPOCH)\n                    .map(|d| d.as_secs())\n                    .unwrap_or_default();\n                let path = format!(\"{dir}/{service}-{version}-{ts}.svg\");\n                if let Ok(file) = fs::File::create(&path) {\n                    let _ = report.flamegraph(file);\n                }\n                prune(dir, MAX_ARTIFACTS);\n            }\n        }\n\n        std::thread::sleep(Duration::from_secs(50));\n    });\n}\n\nfn prune(dir: &str, keep: usize) {\n    let mut files: Vec<PathBuf> = match fs::read_dir(dir) {\n        Ok(entries) => entries.filter_map(|e| e.ok().map(|e| e.path())).collect(),\n        Err(_) => return,\n    };\n    if files.len() <= keep {\n        return;\n    }\n    files.sort();\n    let excess = files.len() - keep;\n    for path in files.into_iter().take(excess) {\n        let _ = fs::remove_file(path);\n    }\n}"
      },
      "questions": [
        {
          "q": "What overhead should a continuous profiler target?",
          "options": [
            "Under about 1% CPU, with no measurable p99 change",
            "Under 10% CPU, since profiles are valuable",
            "Whatever the sampler defaults to",
            "Zero, which is why it runs on a separate host"
          ],
          "answer": 0,
          "explain": "Always-on telemetry has to be invisible in the capacity plan. If it costs 5% CPU, it is a 5% fleet reduction that nobody signed off on."
        },
        {
          "q": "Why does the artifact name need the service version?",
          "options": [
            "So profiles can be diffed across releases to find a regression",
            "Because the filesystem requires unique names",
            "So the profiler can symbolize the stack",
            "To make the file smaller"
          ],
          "answer": 0,
          "explain": "A profile without a version is a picture of an unknown binary. The version label is what turns a pile of flame graphs into a before/after comparison."
        },
        {
          "q": "Why aggregate stacks before storing?",
          "options": [
            "Thousands of identical stacks become one row with a count, which is what the diff needs",
            "Because pprof cannot store individual samples",
            "To avoid needing symbol information",
            "Because the exporter rejects duplicate files"
          ],
          "answer": 0,
          "explain": "The query is how did the share of this stack change. Aggregation by stack and version answers it directly and keeps storage proportional to distinct stacks, not to time."
        }
      ],
      "quickbytes": [
        "10 seconds per minute at 49 Hz is the usual continuous default.",
        "Always label with service.version; a profile without a version cannot be diffed.",
        "Normalize by total samples when comparing two captures.",
        "Keep raw captures for days, aggregates for months, and prune automatically."
      ],
      "production": [
        "The sampler is behind a runtime flag and can be disabled without a redeploy.",
        "Measured overhead is documented and reviewed against the capacity plan.",
        "Artifacts carry service, version and timestamp, and are pruned by a retention rule.",
        "Aggregates, not raw files, are retained long term.",
        "A version diff is part of the release review for latency-sensitive services."
      ],
      "crates": [
        "pprof",
        "tokio",
        "tracing"
      ],
      "github": [
        {
          "name": "tikv/pprof-rs",
          "url": "https://github.com/tikv/pprof-rs"
        }
      ],
      "pitfall": "Sampling every replica at 99 Hz around the clock: the aggregate CPU cost is invisible per pod and significant per fleet, and it shows up as an unexplained capacity gap months later.",
      "resources": [
        {
          "title": "pprof crate: reports and flame graph output",
          "url": "https://docs.rs/pprof/latest/pprof/",
          "kind": "docs"
        },
        {
          "title": "tikv/pprof-rs repository",
          "url": "https://github.com/tikv/pprof-rs",
          "kind": "repo"
        },
        {
          "title": "OpenTelemetry: profiles signal",
          "url": "https://opentelemetry.io/docs/concepts/signals/profiles/",
          "kind": "docs"
        },
        {
          "title": "Jon Gjengset: Rust performance and internals talks",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ]
    },
    {
      "id": "j15",
      "n": 15,
      "title": "Exemplars: from a latency bucket to a trace",
      "minutes": 70,
      "level": "industry",
      "goal": "Attach trace ids to histogram buckets, render them in the exposition format, and jump from a slow bucket to the exact request that filled it.",
      "sections": [
        {
          "h": "The gap between a bucket and a request",
          "p": [
            "A histogram bucket tells you that 4% of requests took between 500 ms and 1 s. It does not tell you which requests, which user, or which dependency was slow. Metrics are aggregated by design, so the individual request is gone by the time the bucket increments.",
            "An exemplar closes that gap. It is a small piece of metadata attached to a bucket: the value that was recorded, a timestamp, and a set of labels - conventionally trace_id. The metrics system keeps a few per bucket for a short time, so a query can show a sample request alongside the aggregate."
          ]
        },
        {
          "h": "The exposition format",
          "p": [
            "OpenMetrics carries exemplars as a comment after the bucket value: the bucket line, then a hash, then a label set in braces, the observed value, and an epoch timestamp. Prometheus stores them when exemplar storage is enabled, and Grafana renders them as clickable links to the trace.",
            "Two constraints matter in practice. The exemplar is attached to a bucket, not to the histogram, so you need to know which bucket boundary you are annotating. And the trace id must be the sampled one - linking to a trace that was never recorded is worse than no link."
          ],
          "code": "# OpenMetrics exposition with an exemplar on one bucket\n# HELP http_request_duration_seconds End-to-end request latency.\n# TYPE http_request_duration_seconds histogram\nhttp_request_duration_seconds_bucket{route=\"/checkout\",le=\"0.1\"} 1712\nhttp_request_duration_seconds_bucket{route=\"/checkout\",le=\"0.25\"} 1806\nhttp_request_duration_seconds_bucket{route=\"/checkout\",le=\"0.5\"} 1841\nhttp_request_duration_seconds_bucket{route=\"/checkout\",le=\"1.0\"} 1902 # {trace_id=\"4bf92f3577b34da6a3ce929d0e0e4736\"} 0.812 1712345678.123\nhttp_request_duration_seconds_bucket{route=\"/checkout\",le=\"+Inf\"} 1930\nhttp_request_duration_seconds_sum{route=\"/checkout\"} 412.77\nhttp_request_duration_seconds_count{route=\"/checkout\"} 1930\nhttp_request_duration_seconds_bucket{route=\"/cart\",le=\"0.1\"} 554\nhttp_request_duration_seconds_bucket{route=\"/cart\",le=\"0.5\"} 601\nhttp_request_duration_seconds_bucket{route=\"/cart\",le=\"+Inf\"} 610\nhttp_request_duration_seconds_count{route=\"/cart\"} 610",
          "tip": "The exemplar value must fall inside the bucket it annotates, or a correct backend will discard it as inconsistent."
        },
        {
          "h": "Rust reality: you render them yourself",
          "p": [
            "As of prometheus 0.14 and metrics-exporter-prometheus 0.18, neither exposes an exemplar API in its public surface: the text encoders emit the bucket lines without the comment. So the working pattern is to keep a bounded ring of recent observations per bucket, keyed by trace id, and append the exemplar line yourself when you serve /metrics.",
            "Bounded is the important word. Eight to sixteen entries per bucket per route is enough for a scrape to catch one, and anything larger turns a metrics endpoint into a memory leak with a Prometheus content type. A scrape happens every fifteen to sixty seconds, so the newest entry is nearly always the one a dashboard needs."
          ],
          "code": "use std::collections::HashMap;\nuse std::sync::Mutex;\n\n#[derive(Default)]\npub struct Exemplars {\n    // route -> bucket upper bound (as string) -> recent (trace_id, value)\n    inner: Mutex<HashMap<String, HashMap<String, Vec<(String, f64)>>>>,\n}\n\nimpl Exemplars {\n    pub fn record(&self, route: &str, bucket: &str, trace_id: &str, value: f64) {\n        let mut guard = self.inner.lock().expect(\"exemplar lock\");\n        let buckets = guard.entry(route.to_string()).or_default();\n        let entries = buckets.entry(bucket.to_string()).or_default();\n        entries.push((trace_id.to_string(), value));\n        if entries.len() > 8 {\n            entries.remove(0);\n        }\n    }\n\n    /// Render the OpenMetrics exemplar comment for one bucket, if any sample exists.\n    pub fn render(&self, route: &str, bucket: &str, now_epoch: f64) -> Option<String> {\n        let guard = self.inner.lock().ok()?;\n        let (trace_id, value) = guard.get(route)?.get(bucket)?.last()?;\n        Some(format!(\n            \"# {{trace_id=\\\"{trace_id}\\\"}} {value} {now_epoch}\"\n        ))\n    }\n}",
          "tip": "Attach the exemplar at the same call site that records the histogram, so the trace id is the one on the current span."
        },
        {
          "h": "What exemplars are not",
          "p": [
            "An exemplar is not a sampling mechanism and not a substitute for traces. It is one pointer per bucket, kept for minutes, and it may point at a request that is no longer interesting by the time you click. If you need the distribution of slow requests, that is trace sampling with a tail policy.",
            "It is also not an aggregation input. Never compute an average or a quantile from exemplars: they are a biased sample chosen by whichever request happened to be last, and treating them as data produces confident nonsense. Treat an exemplar as a pointer with a short lifetime, and let the trace hold the detail."
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement a bounded exemplar store: record (route, bucket, trace_id, value), keep at most 8 per bucket, and render the OpenMetrics comment for a given bucket. Add a test that checks the rendered line has the trace id, the value and a timestamp.",
        "starter": "pub struct Exemplars { /* ... */ }\n\nimpl Exemplars {\n    pub fn record(&self, route: &str, bucket: &str, trace_id: &str, value: f64) { todo!() }\n    pub fn render(&self, route: &str, bucket: &str, now: f64) -> Option<String> { todo!() }\n}",
        "hint": "A Mutex around a nested HashMap, a Vec capped at 8 with remove(0), and format! producing # {trace_id=\"...\"} value timestamp.",
        "solution": "use std::collections::HashMap;\nuse std::sync::Mutex;\n\n#[derive(Default)]\npub struct Exemplars {\n    inner: Mutex<HashMap<String, HashMap<String, Vec<(String, f64)>>>>,\n}\n\nimpl Exemplars {\n    pub fn record(&self, route: &str, bucket: &str, trace_id: &str, value: f64) {\n        let mut guard = self.inner.lock().expect(\"exemplar lock\");\n        let entries = guard\n            .entry(route.to_string())\n            .or_default()\n            .entry(bucket.to_string())\n            .or_default();\n        entries.push((trace_id.to_string(), value));\n        if entries.len() > 8 {\n            entries.remove(0);\n        }\n    }\n\n    pub fn render(&self, route: &str, bucket: &str, now_epoch: f64) -> Option<String> {\n        let guard = self.inner.lock().ok()?;\n        let (trace_id, value) = guard.get(route)?.get(bucket)?.last()?;\n        Some(format!(\"# {{trace_id=\\\"{trace_id}\\\"}} {value} {now_epoch}\"))\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::Exemplars;\n\n    #[test]\n    fn renders_one_openmetrics_exemplar() {\n        let store = Exemplars::default();\n        store.record(\"/checkout\", \"1.0\", \"4bf92f3577b34da6a3ce929d0e0e4736\", 0.812);\n        let line = store.render(\"/checkout\", \"1.0\", 1_712_345_678.123).unwrap();\n        assert!(line.starts_with(\"# {trace_id=\\\"4bf9\"));\n        assert!(line.contains(\"0.812\"));\n        assert!(line.ends_with(\"1712345678.123\"));\n    }\n\n    #[test]\n    fn keeps_only_the_last_eight() {\n        let store = Exemplars::default();\n        for i in 0..20 {\n            store.record(\"/checkout\", \"1.0\", &format!(\"trace-{i}\"), 0.9);\n        }\n        let line = store.render(\"/checkout\", \"1.0\", 0.0).unwrap();\n        assert!(line.contains(\"trace-19\"));\n    }\n}"
      },
      "questions": [
        {
          "q": "What does an exemplar attach to?",
          "options": [
            "A specific histogram bucket, with a value, a timestamp and labels such as trace_id",
            "The whole metric family, once per scrape",
            "The span, replacing its attributes",
            "The counter, as a monotonic delta"
          ],
          "answer": 0,
          "explain": "The exemplar annotates one bucket with one representative observation. That is what lets a UI show a sample request next to the bucket that grew."
        },
        {
          "q": "Why must an exemplar's value fall inside the bucket it annotates?",
          "options": [
            "A backend will treat an out-of-range exemplar as inconsistent and discard it",
            "The value is used to recompute the bucket count",
            "It changes the histogram's sum",
            "Prometheus rejects the whole scrape"
          ],
          "answer": 0,
          "explain": "The exemplar claims this observation landed in this bucket. If the value contradicts that, the data is self-inconsistent and a correct implementation drops it."
        },
        {
          "q": "Which use of exemplars is wrong?",
          "options": [
            "Computing the p99 from the exemplar values",
            "Linking a slow bucket to a trace in a dashboard",
            "Keeping the last few trace ids per bucket",
            "Rendering them only when exemplar storage is enabled"
          ],
          "answer": 0,
          "explain": "Exemplars are a handful of biased samples kept briefly. Quantiles must come from the bucket counts, never from the exemplar values."
        }
      ],
      "quickbytes": [
        "One exemplar per bucket per scrape is enough; keep the ring small.",
        "Attach the trace id from the current span at the histogram call site.",
        "The value must be inside the bucket, or the backend drops it.",
        "Never compute quantiles from exemplars; use the bucket counts."
      ],
      "production": [
        "Exemplar storage is enabled in Prometheus before dashboards link to traces.",
        "Only sampled traces are used as exemplars, so every link resolves.",
        "The exemplar ring is bounded per route and bucket, and its size is documented.",
        "The /metrics handler appends exemplar comments only for buckets that have one.",
        "Dashboards link bucket to trace, and the link is tested after a deploy."
      ],
      "crates": [
        "metrics",
        "metrics-exporter-prometheus",
        "prometheus",
        "tracing"
      ],
      "github": [
        {
          "name": "prometheus/prometheus",
          "url": "https://github.com/prometheus/prometheus"
        },
        {
          "name": "metrics-rs/metrics",
          "url": "https://github.com/metrics-rs/metrics"
        }
      ],
      "pitfall": "Attaching the trace id of an unsampled request: the exemplar renders, the dashboard links, and the click lands on a trace that was never recorded, which teaches the team that the feature does not work.",
      "resources": [
        {
          "title": "OpenTelemetry specification: exemplars in the metrics SDK",
          "url": "https://github.com/open-telemetry/opentelemetry-specification",
          "kind": "repo"
        },
        {
          "title": "prometheus/prometheus repository",
          "url": "https://github.com/prometheus/prometheus",
          "kind": "repo"
        },
        {
          "title": "prometheus crate: text exposition and encoders",
          "url": "https://docs.rs/prometheus/latest/prometheus/",
          "kind": "docs"
        },
        {
          "title": "Grafana: exemplars and trace linking",
          "url": "https://www.youtube.com/@Grafana",
          "kind": "video"
        }
      ]
    },
    {
      "id": "j16",
      "n": 16,
      "title": "Sampling: head, tail, and what you lose",
      "minutes": 85,
      "level": "industry",
      "goal": "Sample at the root with a parent-based ratio, add tail sampling for errors and slow traces, and know exactly which questions sampling makes unanswerable.",
      "sections": [
        {
          "h": "Head sampling: decide once, at the root",
          "p": [
            "A head sampler decides when the trace starts, before any of the work has happened. TraceIdRatioBased hashes the trace id, so the decision is deterministic and consistent: every service that sees the same trace id makes the same choice without coordinating. ParentBased wraps it and honours the parent's decision for everything below the root.",
            "That combination is the default for a reason. It is O(1), it needs no buffering, and it produces complete traces rather than random holes. What it cannot do is know that the request it just dropped was about to fail."
          ],
          "code": "use opentelemetry_sdk::trace::{Sampler, SdkTracerProvider};\n\npub fn provider_with_sampling(ratio: f64) -> SdkTracerProvider {\n    SdkTracerProvider::builder()\n        // Root spans: sample the ratio. Children: inherit the parent's decision.\n        .with_sampler(Sampler::ParentBased(Box::new(Sampler::TraceIdRatioBased(ratio))))\n        .build()\n}\n\n#[cfg(test)]\nmod tests {\n    use super::provider_with_sampling;\n\n    #[test]\n    fn builds_with_any_ratio_in_range() {\n        for ratio in [0.0, 0.01, 0.1, 1.0] {\n            let _provider = provider_with_sampling(ratio);\n        }\n    }\n}",
          "tip": "Set the ratio on the entry service only, or on all services with ParentBased. Two independent ratio samplers in the same trace produce partial traces."
        },
        {
          "h": "Tail sampling: decide after you know",
          "p": [
            "A tail sampler buffers all spans of a trace until the trace is complete, then decides. That means it can keep 100% of traces with an error, 100% of traces slower than 500 ms, and 1% of everything else - the exact policy a head sampler cannot express.",
            "The cost is structural. All spans of a trace must reach the same collector instance, so the load balancer has to route by trace id, and the collector has to hold every in-flight trace in memory for decision_wait. That memory is the limit on how much traffic one collector can tail-sample."
          ],
          "code": "# otel-collector config: tail sampling after a trace-id-aware load balancer\nprocessors:\n  tail_sampling:\n    decision_wait: 10s\n    num_traces: 100000\n    policies:\n      - name: errors\n        type: status_code\n        status_code:\n          status_codes: [ERROR]\n      - name: slow\n        type: latency\n        latency:\n          threshold_ms: 500\n      - name: baseline\n        type: probabilistic\n        probabilistic:\n          sampling_percentage: 1\n\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: [tail_sampling, batch]\n      exporters: [otlp]",
          "tip": "decision_wait must exceed your slowest trace. A 3 second wait on a 5 second request decides on an incomplete trace and drops the very spans you wanted."
        },
        {
          "h": "The combination that works",
          "p": [
            "Head sample lightly at the edge - 5 to 10% - to cut volume before it crosses the network, then tail sample in the Collector to keep every error and every slow trace. You get full fidelity where it matters and a statistical baseline everywhere else.",
            "Do the arithmetic before you ship it. At 1,000 requests per second, a 5% head rate is 50 traces per second; if 1% error and 0.5% slow traces survive tail sampling, you add about 15 per second. The exact numbers matter because the baseline is what your dashboards and your cost model both depend on."
          ],
          "list": [
            "Head 5-10% at the edge to reduce network and collector load",
            "Tail keep: errors, slow, and a small probabilistic baseline",
            "Never sample the same trace twice at different ratios",
            "Record the effective rate so the volume is explainable"
          ]
        },
        {
          "h": "What sampling makes unanswerable",
          "p": [
            "Sampled traces cannot answer how many. If you keep 5% of traces, a count of 40 error spans is an estimate with a wide interval, and a spike from 40 to 44 is noise. Counts belong in metrics, which are cheap and complete; traces explain the shape of a failure once metrics have told you there is one.",
            "Span-level sampling is worse than trace-level sampling. Dropping individual spans produces traces with holes, where a missing child looks like time spent in the parent. A trace with holes is worse than no trace at all, because it looks complete: the reader draws the wrong conclusion with full confidence."
          ]
        }
      ],
      "exercise": {
        "prompt": "Configure parent-based head sampling at 5% in Rust and a Collector tail-sampling policy that keeps all errors, all traces over 500 ms, and 1% of the rest. Then estimate the retained volume for 1,000 rps with 1% errors and 0.5% slow traces.",
        "starter": "// Rust: SdkTracerProvider::builder().with_sampler(..)\n// Collector: processors.tail_sampling.policies\n// Estimate: 1000 rps * 0.05 = ?",
        "hint": "Head: ParentBased(TraceIdRatioBased(0.05)). Tail: status_code ERROR, latency 500ms, probabilistic 1%. Remember tail only sees what head kept, so errors are already 5% sampled.",
        "solution": "// ---- Rust: decide at the root, inherit below ----\nuse opentelemetry_sdk::trace::{Sampler, SdkTracerProvider};\n\npub fn provider() -> SdkTracerProvider {\n    SdkTracerProvider::builder()\n        .with_sampler(Sampler::ParentBased(Box::new(Sampler::TraceIdRatioBased(0.05))))\n        .build()\n}\n\n// ---- Collector: keep what matters, sample the rest ----\n// processors:\n//   tail_sampling:\n//     decision_wait: 10s\n//     num_traces: 100000\n//     policies:\n//       - name: errors\n//         type: status_code\n//         status_code: { status_codes: [ERROR] }\n//       - name: slow\n//         type: latency\n//         latency: { threshold_ms: 500 }\n//       - name: baseline\n//         type: probabilistic\n//         probabilistic: { sampling_percentage: 1 }\n//\n// ---- Volume estimate at 1,000 rps ----\n// Head keeps 5%              ->  50 traces/s reach the collector\n// Of those, 1% are errors    ->  ~0.5 traces/s kept by the error policy\n// Of those, 0.5% are slow    ->  ~0.25 traces/s kept by the latency policy\n// Baseline 1% of the 50      ->  ~0.5 traces/s\n// Total retained             ->  ~1.25 traces/s, ~108k traces/day\n//\n// Note: tail policies only see head-sampled traces, so the error policy\n// retains 1% of 5%, not 1% of all traffic. Raise the head ratio if you\n// need every error."
      },
      "questions": [
        {
          "q": "What does ParentBased add on top of TraceIdRatioBased?",
          "options": [
            "Children inherit the parent's sampling decision instead of re-rolling",
            "It samples faster by skipping the hash",
            "It samples errors at 100% automatically",
            "It stores the trace id in the baggage"
          ],
          "answer": 0,
          "explain": "Without ParentBased, each service re-rolls and traces end up with holes. With it, the root decides once and every downstream span follows."
        },
        {
          "q": "Where must tail sampling run?",
          "options": [
            "In a Collector that sees every span of a trace, with routing by trace id",
            "In each service's SDK before export",
            "In the backend after ingestion",
            "In the load balancer"
          ],
          "answer": 0,
          "explain": "A tail decision needs the whole trace. That requires all spans to reach the same collector instance, which means trace-id-aware routing and in-memory buffering."
        },
        {
          "q": "Why should counts never be derived from sampled traces?",
          "options": [
            "Sampling makes counts estimates with wide error bars; metrics are complete and cheap",
            "Traces do not carry timestamps",
            "Span counts are not exported",
            "Sampling only keeps successful traces"
          ],
          "answer": 0,
          "explain": "At 5% sampling a count of 40 spans could be 800 or 1,200. Metrics answer how many; traces answer what happened in the ones you kept."
        }
      ],
      "quickbytes": [
        "ParentBased(TraceIdRatioBased) at the root, inherit everywhere below.",
        "Tail sampling needs trace-id routing and memory for decision_wait.",
        "decision_wait must exceed the slowest trace you care about.",
        "Sample whole traces, never individual spans."
      ],
      "production": [
        "The sampling ratio is set in one place per environment and recorded in the runbook.",
        "Tail sampling sits behind a trace-id-aware load balancer, with memory limits sized for decision_wait.",
        "Error and latency policies are reviewed when the SLO thresholds change.",
        "Dashboards label sampled data as sampled; counts come from metrics.",
        "A monthly check confirms retained volume matches the predicted effective rate."
      ],
      "crates": [
        "opentelemetry",
        "opentelemetry_sdk",
        "opentelemetry-otlp",
        "tracing-opentelemetry"
      ],
      "github": [
        {
          "name": "open-telemetry/opentelemetry-rust",
          "url": "https://github.com/open-telemetry/opentelemetry-rust"
        },
        {
          "name": "open-telemetry/opentelemetry-collector-contrib",
          "url": "https://github.com/open-telemetry/opentelemetry-collector-contrib"
        }
      ],
      "pitfall": "Running a 10% ratio sampler in every service without ParentBased: each hop re-rolls independently, so a trace that survived the edge has a 90% chance of losing its downstream spans, and the waterfall shows a missing child as time spent in the parent.",
      "resources": [
        {
          "title": "OpenTelemetry: sampling concepts",
          "url": "https://opentelemetry.io/docs/concepts/sampling/",
          "kind": "docs"
        },
        {
          "title": "opentelemetry_sdk Sampler: AlwaysOn, ParentBased, TraceIdRatioBased",
          "url": "https://docs.rs/opentelemetry_sdk/latest/opentelemetry_sdk/trace/enum.Sampler.html",
          "kind": "docs"
        },
        {
          "title": "Collector contrib: tail sampling processor",
          "url": "https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/tailsamplingprocessor",
          "kind": "repo"
        },
        {
          "title": "OpenTelemetry channel: collector and sampling talks",
          "url": "https://www.youtube.com/@OpenTelemetry",
          "kind": "video"
        }
      ]
    },
    {
      "id": "j17",
      "n": 17,
      "title": "Cardinality control: the metric that ate the TSDB",
      "minutes": 75,
      "level": "industry",
      "goal": "Compute series count as a product of label values, enforce bounded label sets in Rust, and drop high-cardinality attributes before they reach storage.",
      "sections": [
        {
          "h": "Cardinality is a product, not a count",
          "p": [
            "Every distinct combination of label values is a separate time series, and each series costs memory in the head block, a chunk on disk, and an entry in every index. A metric with route (10 values), status (5), region (4) and version (3) has 600 series, which is nothing. Add user_id with a million values and it is 600 million.",
            "That multiplication is why one careless label takes down a monitoring stack. The failure is not gradual: the head block grows until the process is killed, and the restart replays the WAL and dies again, so the whole cluster loses observability at the moment you need it."
          ],
          "list": [
            "Safe: route templates, status classes, region, version, method, result enums",
            "Unsafe: user ids, request ids, raw paths, emails, session ids, error messages",
            "Borderline: build ids (bounded per deploy, unbounded over a year) - expire them",
            "Never: anything an external client controls the shape of"
          ]
        },
        {
          "h": "Enforce bounded labels in the type system",
          "p": [
            "The cheapest place to stop cardinality is at the call site, and Rust makes that easy: a closed enum with a fixed label() method cannot grow a new value by accident. Anything that arrives from outside - a path, a header, an error string - is mapped into the enum, with an explicit Other bucket.",
            "The Other bucket is the important part. Without it, the first unmapped path becomes a new series; with it, every surprise collapses into one, and the rate of other tells you whether the mapping needs work. Alert on the share of other rather than on its count: a rising share means a route shipped without a mapping, which is a review problem, not a metrics problem."
          ],
          "code": "use metrics::{counter, histogram};\n\n#[derive(Clone, Copy, Debug, PartialEq, Eq)]\npub enum Route {\n    Checkout,\n    Cart,\n    Catalog,\n    Other,\n}\n\nimpl Route {\n    /// Map an untrusted path onto a closed set of label values.\n    pub fn from_path(path: &str) -> Self {\n        match path {\n            \"/checkout\" => Route::Checkout,\n            \"/cart\" => Route::Cart,\n            \"/catalog\" => Route::Catalog,\n            _ => Route::Other,\n        }\n    }\n\n    pub fn label(self) -> &'static str {\n        match self {\n            Route::Checkout => \"checkout\",\n            Route::Cart => \"cart\",\n            Route::Catalog => \"catalog\",\n            Route::Other => \"other\",\n        }\n    }\n}\n\npub fn record(route: Route, status: u16, elapsed_s: f64) {\n    counter!(\n        \"http_requests_total\",\n        \"route\" => route.label(),\n        \"status\" => status_class(status)\n    )\n    .increment(1);\n    histogram!(\"http_request_duration_seconds\", \"route\" => route.label()).record(elapsed_s);\n}\n\nfn status_class(status: u16) -> &'static str {\n    match status {\n        200..=299 => \"2xx\",\n        300..=399 => \"3xx\",\n        400..=499 => \"4xx\",\n        _ => \"5xx\",\n    }\n}",
          "tip": "A closed enum plus an Other bucket gives you a hard ceiling: series count is bounded by the enum, not by traffic."
        },
        {
          "h": "Drop it at the edge, not at the database",
          "p": [
            "Labels you cannot control at the source - SDK attributes from a library, headers added by a mesh - have to be dropped in the pipeline. The Collector's attributes processor deletes or hashes specific keys before the data is exported, which keeps the cost out of the backend entirely.",
            "Relabelling at scrape time in Prometheus is the last resort: it works, but the series were already created in the exporter, so memory and CPU were already spent. Do it at the Collector when you can, and keep a metric_relabel_configs drop rule for anything that slips through."
          ],
          "code": "processors:\n  attributes/drop_high_cardinality:\n    actions:\n      - key: user.email\n        action: delete\n      - key: http.request.header.x-request-id\n        action: delete\n      - key: db.statement\n        action: delete   # parameters make this unbounded\n      - key: deployment.id\n        action: hash     # keep the ability to group without the raw value\n\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: [attributes/drop_high_cardinality, batch]\n      exporters: [otlp]",
          "tip": "Hash rather than delete when you still need to correlate: a hash keeps the grouping power and drops the cardinality of the raw value."
        },
        {
          "h": "Watch the series count like a capacity metric",
          "p": [
            "Prometheus exposes prometheus_tsdb_head_series, and most managed backends expose an equivalent. Alert on its growth rate, not just its absolute value, because a runaway label shows up as a steep slope long before the process dies. A slope alert catches the bad deploy in minutes; a memory threshold fires after the damage is already done.",
            "Track series per metric too. One metric with a million series is a bug; ten thousand metrics with a hundred series each is a design. Most backends expose a per-metric series count, and sorting by it is the fastest way to find the call site that needs a bounded enum instead of a string."
          ]
        }
      ],
      "exercise": {
        "prompt": "A metric is labelled with the raw request path and the user id, producing millions of series. Rewrite it with bounded labels, add the mapping test, and add a Collector rule that drops the user id from traces.",
        "starter": "counter!(\"http_requests_total\",\n    \"path\" => req.uri().path().to_string(),\n    \"user\" => user_id,\n    \"status\" => status.to_string()\n).increment(1);",
        "hint": "Replace path with a closed Route enum plus an Other bucket, replace the raw status with a 2xx/4xx/5xx class, and remove the user label entirely - user-level questions belong in traces or logs.",
        "solution": "use metrics::counter;\n\n#[derive(Clone, Copy)]\npub enum Route {\n    Checkout,\n    Cart,\n    Other,\n}\n\nimpl Route {\n    pub fn from_path(path: &str) -> Self {\n        match path {\n            \"/checkout\" => Route::Checkout,\n            \"/cart\" => Route::Cart,\n            _ => Route::Other,\n        }\n    }\n\n    pub fn label(self) -> &'static str {\n        match self {\n            Route::Checkout => \"checkout\",\n            Route::Cart => \"cart\",\n            Route::Other => \"other\",\n        }\n    }\n}\n\npub fn status_class(status: u16) -> &'static str {\n    match status {\n        200..=299 => \"2xx\",\n        300..=399 => \"3xx\",\n        400..=499 => \"4xx\",\n        _ => \"5xx\",\n    }\n}\n\npub fn record(path: &str, status: u16) {\n    // No user label: per-user questions belong in traces, not in a counter.\n    counter!(\n        \"http_requests_total\",\n        \"route\" => Route::from_path(path).label(),\n        \"status\" => status_class(status)\n    )\n    .increment(1);\n}\n\n// Collector side:\n// processors:\n//   attributes/drop_user:\n//     actions:\n//       - key: enduser.id\n//         action: delete\n\n#[cfg(test)]\nmod tests {\n    use super::Route;\n\n    #[test]\n    fn worst_case_series_is_bounded() {\n        // 3 routes x 4 status classes = 12 series, regardless of traffic.\n        let routes = 3;\n        let classes = 4;\n        assert_eq!(routes * classes, 12);\n\n        let mut distinct = std::collections::HashSet::new();\n        for path in [\"/checkout\", \"/cart\", \"/nope\", \"/checkout/42\"] {\n            distinct.insert(Route::from_path(path).label());\n        }\n        assert_eq!(distinct.len(), 3);\n    }\n}"
      },
      "questions": [
        {
          "q": "A counter has labels route (10), status (5) and user_id (1,000,000). How many series?",
          "options": [
            "50,000,000",
            "1,000,015",
            "15",
            "5,000,000"
          ],
          "answer": 0,
          "explain": "Cardinality multiplies: 10 x 5 x 1,000,000. That is why a single high-cardinality label dominates everything else on the metric."
        },
        {
          "q": "Which label is safe to add to a production metric?",
          "options": [
            "The templated route, from a closed set",
            "The raw request path",
            "The user's email address",
            "The error message string"
          ],
          "answer": 0,
          "explain": "Templated routes come from a bounded set. Paths, emails and error strings are unbounded, so each new value creates a series that never goes away."
        },
        {
          "q": "Why prefer dropping an attribute in the Collector over relabelling at scrape time?",
          "options": [
            "The cost is avoided before the backend ever stores or indexes the series",
            "Prometheus cannot drop labels",
            "Collectors compress better than Prometheus",
            "Relabelling changes the metric name"
          ],
          "answer": 0,
          "explain": "By the time Prometheus relabels, the series already existed in the exporter and the storage work was done. Dropping in the Collector keeps the cardinality out of the system."
        }
      ],
      "quickbytes": [
        "Series = product of label values; one unbounded label multiplies everything else.",
        "Map untrusted input into a closed enum with an explicit Other bucket.",
        "Hash a high-cardinality attribute if you still need to group by it.",
        "Alert on the growth rate of prometheus_tsdb_head_series, not only its value."
      ],
      "production": [
        "Every metric's label set is documented, with a maximum series estimate.",
        "Route labels come from a closed enum; unmapped paths collapse into other.",
        "The Collector deletes or hashes known high-cardinality attributes before export.",
        "A per-metric series count is reviewed monthly, with a growth alert.",
        "A load test asserts the series count does not grow with unique request ids."
      ],
      "crates": [
        "metrics",
        "metrics-exporter-prometheus",
        "prometheus",
        "opentelemetry"
      ],
      "github": [
        {
          "name": "prometheus/prometheus",
          "url": "https://github.com/prometheus/prometheus"
        },
        {
          "name": "metrics-rs/metrics",
          "url": "https://github.com/metrics-rs/metrics"
        }
      ],
      "pitfall": "Labelling a metric with the request path because it is convenient in the handler: every 404 from a scanner and every id in a URL becomes a permanent series, and the TSDB dies weeks later with no obvious cause.",
      "resources": [
        {
          "title": "OpenTelemetry metrics semantic conventions: attribute guidance",
          "url": "https://opentelemetry.io/docs/specs/semconv/general/metrics/",
          "kind": "docs"
        },
        {
          "title": "OpenTelemetry Collector configuration: processors",
          "url": "https://opentelemetry.io/docs/collector/configuration/",
          "kind": "docs"
        },
        {
          "title": "prometheus/prometheus repository",
          "url": "https://github.com/prometheus/prometheus",
          "kind": "repo"
        },
        {
          "title": "Grafana: cardinality and metrics cost talks",
          "url": "https://www.youtube.com/@Grafana",
          "kind": "video"
        }
      ]
    },
    {
      "id": "j18",
      "n": 18,
      "title": "Incident response: the first ten minutes",
      "minutes": 70,
      "level": "industry",
      "goal": "Declare early, assign roles, stop the bleeding before diagnosing, and run the incident from one written timeline instead of five side channels.",
      "sections": [
        {
          "h": "Declare, then debug",
          "p": [
            "The most common failure in incident response is not technical: it is a team of five people debugging silently in five threads, none of whom has told the customer or the account manager what is happening. Declaring an incident early costs nothing and can always be downgraded; declaring late costs the first thirty minutes, which are the ones that matter.",
            "A declaration is three facts: what is broken for users, who is coordinating, and where the updates are. Severity levels should be defined before the incident - typically SEV1 for total loss of a core journey, SEV2 for partial degradation, SEV3 for a workaround existing - so nobody negotiates severity while the site is down."
          ],
          "list": [
            "Incident commander: decides, does not debug - one person, named out loud",
            "Operations lead: runs the technical work and reports to the commander",
            "Communications lead: status page, support, and executives on a fixed cadence",
            "Scribe: keeps the timeline in the channel, with UTC timestamps"
          ]
        },
        {
          "h": "Stop the bleeding before you understand it",
          "p": [
            "Rollback, feature-flag off, or scale out - in that order, because they are the reversible actions with the highest expected value. Understanding can wait sixty seconds; a bad deploy serving errors cannot. The instinct to find the root cause first is what turns a five-minute incident into a fifty-minute one.",
            "Check the recent-change list before you theorize: what deployed, what config changed, what certificate expired, what traffic pattern shifted. Most incidents are a change plus a missing guardrail, and the change is usually in the last hour. If nothing changed, the next candidates are capacity, a dependency outage, and an untested traffic shape, in that order of cheapness to rule out."
          ],
          "code": "# 1. Roll back the most recent deploy (reversible, fastest).\nkubectl rollout undo deployment/checkout -n prod\nkubectl rollout status deployment/checkout -n prod --timeout=180s\n\n# 2. Or disable the feature flag if the change is behind one.\ncurl -sS -X PATCH \"$FLAGS_URL/api/flags/checkout.new_pricing\" \\\n  -H \"authorization: Bearer $FLAGS_TOKEN\" \\\n  -d '{\"enabled\": false}'\n\n# 3. Scale out only if the symptom is saturation, not a bad build.\nkubectl scale deployment/checkout -n prod --replicas=12\n\n# 4. Confirm from the user's side, not from the pod's side.\ncurl -sS -o /dev/null -w '%{http_code} %{time_total}\\n' \\\n  https://api.example.com/checkout/health\n\n# 5. Record each action in the incident channel with a UTC timestamp.",
          "tip": "Write the rollback command in the runbook, with the exact deployment name. At 3 a.m. nobody should be composing kubectl from memory."
        },
        {
          "h": "Communication is a deliverable",
          "p": [
            "The status page should update on a fixed cadence - every fifteen minutes for a SEV1 - even when the update is nothing has changed. Silence is read as incompetence, and the support team will invent an explanation if you do not give them one.",
            "Internal communication belongs in one channel with one thread per topic. Five parallel threads guarantee that two people will apply conflicting mitigations, and the timeline will be unusable in the postmortem. The scribe's timeline is the artefact the postmortem is written from, and a timeline reconstructed from memory a day later is fiction with timestamps."
          ]
        },
        {
          "h": "The instrumentation that earns its keep",
          "p": [
            "Three things turn an incident from archaeology into reading: a deploy marker on every dashboard, a version label on every metric and span, and a runbook with commands that are copy-pasteable. Without the deploy marker you cannot line up the error spike with the release; without the version label you cannot tell whether the new pods are worse.",
            "Expose a deploy timestamp as a gauge - something like checkout_deploy_timestamp_seconds{version=...} - and let the dashboard annotate it. It is ten lines of code and it answers the first question of every incident. The same marker makes a canary decision obvious: if the error ratio rises exactly at the marker, the canary failed regardless of what the logs say."
          ]
        }
      ],
      "exercise": {
        "prompt": "Write the runbook for a checkout 5xx spike: six ordered steps with exact commands, a decision point, an escalation path, and the signals that confirm recovery.",
        "starter": "# Runbook: checkout 5xx spike\n1. Confirm\n2. ?\n3. ?\n# ... six steps, then escalation and recovery criteria",
        "hint": "Confirm from the user side first, then check recent deploys, roll back or flag off, verify, communicate on a cadence, and escalate to the database owner if the 5xx correlates with query latency.",
        "solution": "# Runbook: checkout 5xx spike (SEV2 unless the whole journey is down)\n\n## 1. Confirm the symptom from the user's side\ncurl -sS -o /dev/null -w '%{http_code} %{time_total}\\n' https://api.example.com/checkout\n# Check the dashboard: error ratio by route, and whether it is one route or all.\n\n## 2. Check recent changes (last 60 minutes)\nkubectl rollout history deployment/checkout -n prod\n# Also: config map changes, certificate expiry, upstream status page.\n\n## 3. Stop the bleeding\nkubectl rollout undo deployment/checkout -n prod\nkubectl rollout status deployment/checkout -n prod --timeout=180s\n# If the change is behind a flag: disable the flag instead.\n\n## 4. Verify the mitigation\n# Error ratio back under 1% for 5 minutes, p99 under 300 ms, queue depth flat.\n\n## 5. Communicate\n# Status page update now, then every 15 minutes, even if nothing changed.\n# One channel, one thread per topic, UTC timestamps on every action.\n\n## 6. Escalate if not mitigated in 15 minutes\n# - Database owner if query latency correlates with the 5xx spike\n# - Platform on-call if the nodes or the mesh are involved\n# - Incident commander hands over explicitly; never assume.\n\n## Recovery criteria\n# - 5xx ratio under 0.1% for 15 consecutive minutes\n# - No new error types in the logs for 15 minutes\n# - Error budget burn back under 1x\n\n## Follow-up\n# Open the postmortem within 24 hours; link this runbook in the ticket."
      },
      "questions": [
        {
          "q": "What is the first action when a deploy is suspected of causing errors?",
          "options": [
            "Roll it back - the reversible action with the highest expected value",
            "Read the source diff to find the bug",
            "Add more logging and wait for data",
            "Scale out to absorb the errors"
          ],
          "answer": 0,
          "explain": "Mitigation before diagnosis. A rollback is reversible and fast; reading a diff while users are failing converts a short outage into a long one."
        },
        {
          "q": "Why does the incident commander not debug?",
          "options": [
            "Coordination is a full-time job, and mixing it with debugging loses both",
            "The commander lacks production access",
            "Debugging is reserved for the most senior engineer",
            "The commander must stay off the call to avoid bias"
          ],
          "answer": 0,
          "explain": "Someone has to track actions, decisions and comms. When the commander dives into logs, decisions stop being made and the timeline stops being written."
        },
        {
          "q": "What does a deploy marker on the dashboard give you during an incident?",
          "options": [
            "It lines the symptom up with the release, answering whether the change caused it",
            "It rolls back automatically when errors rise",
            "It replaces the need for a version label",
            "It reduces the error rate by isolating traffic"
          ],
          "answer": 0,
          "explain": "The first question of most incidents is what changed. A vertical line at the deploy time answers it in one glance instead of a search through the release log."
        }
      ],
      "quickbytes": [
        "Declare early; downgrade later. Silence is the expensive option.",
        "Rollback, flag off, scale - in that order, before root-cause work.",
        "One channel, one thread per topic, UTC timestamps on every action.",
        "A deploy marker is ten lines of code and answers the first question."
      ],
      "production": [
        "Severity definitions and the declaration path are documented and practised.",
        "Every service has a runbook with copy-pasteable rollback and verification commands.",
        "Dashboards annotate deploys, and metrics and spans carry the version label.",
        "Status page updates follow a fixed cadence, including no-change updates.",
        "Incident roles are assigned by name in the channel at declaration time."
      ],
      "crates": [
        "tracing",
        "metrics",
        "opentelemetry"
      ],
      "github": [
        {
          "name": "prometheus/prometheus",
          "url": "https://github.com/prometheus/prometheus"
        },
        {
          "name": "tokio-rs/tracing",
          "url": "https://github.com/tokio-rs/tracing"
        }
      ],
      "pitfall": "Debugging before mitigating because the rollback might lose a feature: the team spends twenty minutes reading traces while every request fails, and the rollback happens anyway with twenty extra minutes of budget spent.",
      "resources": [
        {
          "title": "USENIX: systems operations and failure analysis talks",
          "url": "https://www.youtube.com/@USENIX",
          "kind": "video"
        },
        {
          "title": "Honeycomb: incident response and observability talks",
          "url": "https://www.youtube.com/@honeycombio",
          "kind": "video"
        },
        {
          "title": "tracing: events and spans for incident timelines",
          "url": "https://docs.rs/tracing/latest/tracing/",
          "kind": "docs"
        },
        {
          "title": "prometheus/prometheus repository",
          "url": "https://github.com/prometheus/prometheus",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "j19",
      "n": 19,
      "title": "Postmortems: blameless, specific, actionable",
      "minutes": 65,
      "level": "industry",
      "goal": "Write a postmortem that quantifies impact, explains the contributing factors, and produces action items that change the system rather than the people.",
      "sections": [
        {
          "h": "Blameless means systems, not silence",
          "p": [
            "A blameless postmortem does not omit that a person ran the command. It omits the framing that the person was the cause. The useful question is why the system made that command easy to run, hard to notice, and slow to reverse - because the next engineer will face the same system.",
            "Human error is a starting point, not a conclusion. If the action item is be more careful, the analysis stopped too early. If it is make the destructive path require confirmation and add an alert on the resulting signal, the analysis produced something that survives contact with a tired human."
          ]
        },
        {
          "h": "The structure that survives review",
          "p": [
            "Impact first, in units the business understands: how many users, for how long, how much of the error budget, and which journeys. Then a timeline in UTC with one line per event, including the detection and the first mitigation, because those two timestamps are what you are trying to shrink.",
            "After the timeline: contributing factors (plural - incidents rarely have one), what went well, what went badly, and action items with an owner and a date. The what went well section is not decoration; it is how you learn which safeguards actually worked."
          ],
          "code": "---\nid: PM-2026-014\ntitle: Checkout 5xx spike after pricing deploy\nseverity: SEV2\ndetected_at: 2026-03-11T14:02:00Z\nmitigated_at: 2026-03-11T14:45:00Z\nduration_minutes: 43\nslo_impact: \"0.10% of the 28-day availability budget\"\nusers_affected: \"~12,400 checkout attempts\"\nowner: checkout-team\n---\n\n## Impact\nCheckout returned 502 for 43 minutes. 12,400 attempts failed; no orders were\ndouble-charged. The error budget for the 28-day window was 100% consumed.\n\n## Timeline (UTC)\n14:02 First 5xx spike; alert CheckoutAvailabilityBurnFast fires at 14:04.\n14:06 Incident declared, IC and comms assigned.\n14:11 Recent deploy (13:58, new pricing rule) identified.\n14:14 Rollback started.\n14:19 Rollback complete; error rate falling.\n14:45 Error ratio under 0.1% for 15 minutes; incident closed.\n\n## Contributing factors\n- The new pricing rule made an upstream call per line item, multiplying fan-out.\n- No load test covered a cart with more than 20 line items.\n- The 5xx alert existed but had no runbook link, delaying the first action.\n\n## What went well\n- Burn-rate alert fired in 2 minutes, before support noticed.\n- Rollback was a single documented command and worked first time.\n\n## Action items\n- [ ] Cap per-request fan-out and add a load test at 100 line items - @ana - 2026-03-25\n- [ ] Add runbook_url to every alert rule, enforced in CI - @sam - 2026-03-18\n- [ ] Add a deploy marker annotation to the checkout dashboard - @ana - 2026-03-18",
          "tip": "Timestamps in UTC, always. A timeline in three time zones is a timeline nobody can follow in the review."
        },
        {
          "h": "Action items that change something",
          "p": [
            "A good action item is a diff, a test, an alert, or a removal. It has an owner, a date, and a way to verify it landed. A bad one is a verb with no object: improve monitoring, increase awareness, add more logging - none of which can be reviewed or closed.",
            "Cap the list. Five real action items that ship beat twenty that are copied into the next postmortem. If the list is long, rank by expected reduction in detection or mitigation time, and drop the rest with a note explaining why."
          ],
          "list": [
            "Adds a test or a guardrail that would have caught this specific failure",
            "Removes a footgun, not just documents it",
            "Improves detection time or mitigation time, measurably",
            "Has one owner and one date, and appears in the normal backlog"
          ]
        },
        {
          "h": "Close the loop in public",
          "p": [
            "Publish the postmortem internally, review the action items at 30 days, and report the completion rate. A postmortem whose items are 20% complete after a quarter is a signal that the team is too busy fighting fires to prevent them - which is itself worth escalating.",
            "Share the ones that generalise. A missing timeout in one service is usually a missing timeout in four; a fan-out problem in checkout is a pattern the platform team should fix once. Publishing internally with action items attached is how one team's incident becomes an organisation-level guardrail instead of a local anecdote."
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a postmortem for a 43-minute checkout outage that consumed the full 28-day error budget: impact, UTC timeline, three contributing factors, what went well, and three action items with owners and dates.",
        "starter": "---\nid: PM-?\nseverity: ?\n---\n\n## Impact\n## Timeline\n## Contributing factors\n## Action items",
        "hint": "Quantify impact in users and budget, keep the timeline to the events that changed the outcome, and make each action item a concrete change with one owner and a date.",
        "solution": "---\nid: PM-2026-014\ntitle: Checkout 5xx spike after pricing deploy\nseverity: SEV2\ndetected_at: 2026-03-11T14:02:00Z\nmitigated_at: 2026-03-11T14:45:00Z\nduration_minutes: 43\nslo_impact: \"100% of the 28-day availability budget\"\nusers_affected: \"~12,400 checkout attempts\"\nowner: checkout-team\n---\n\n## Impact\nCheckout returned 502 for 43 minutes. 12,400 attempts failed, no orders were\ndouble-charged, and the 28-day availability budget was fully consumed.\n\n## Timeline (UTC)\n14:02 First 5xx spike.\n14:04 Burn-rate alert fires (2 minutes to detection).\n14:06 Incident declared; IC and comms assigned.\n14:11 Deploy at 13:58 identified as the only recent change.\n14:14 Rollback started.\n14:19 Rollback complete; error ratio falling.\n14:45 Error ratio under 0.1% for 15 minutes; incident closed.\n\n## Contributing factors\n- The pricing rule issued one upstream call per line item, multiplying fan-out.\n- No load test covered carts with more than 20 line items.\n- The alert had no runbook link, so the first action took five extra minutes.\n\n## What went well\n- Detection in 2 minutes, before any customer report.\n- The documented rollback worked on the first attempt.\n\n## Action items\n- [ ] Cap per-request fan-out; add a 100-line-item load test - @ana - 2026-03-25\n- [ ] Require runbook_url on every alert rule in CI - @sam - 2026-03-18\n- [ ] Annotate deploys on the checkout dashboard - @ana - 2026-03-18"
      },
      "questions": [
        {
          "q": "Which action item is actually actionable?",
          "options": [
            "Add a load test with 100 line items and cap fan-out per request, owner and date set",
            "Be more careful when changing pricing rules",
            "Improve monitoring around checkout",
            "Add more logging to the pricing service"
          ],
          "answer": 0,
          "explain": "It names a change, a verification, an owner and a date. The others are verbs without objects - impossible to review, close, or prove."
        },
        {
          "q": "What does blameless mean in practice?",
          "options": [
            "Explain why the system made the mistake easy, rather than naming a person as the cause",
            "Never record who performed an action",
            "Exclude the timeline to avoid embarrassment",
            "Assign action items to the team instead of individuals"
          ],
          "answer": 0,
          "explain": "Names and actions stay in the record. What goes away is the causal story that ends at a human, because it produces no change to the system."
        },
        {
          "q": "Why is detection time tracked separately from mitigation time?",
          "options": [
            "They are fixed by different work: alerting and SLOs versus rollback speed and runbooks",
            "Detection is always shorter than mitigation",
            "Detection time is not actionable",
            "Only mitigation counts against the error budget"
          ],
          "answer": 0,
          "explain": "Splitting them tells you which investment pays: better burn-rate alerts, or a faster, safer rollback path. One number hides both."
        }
      ],
      "quickbytes": [
        "Impact in users and budget, timeline in UTC, factors in plural.",
        "An action item is a diff, a test, an alert, or a removal - with an owner and a date.",
        "Cap the list at five and rank by detection or mitigation time saved.",
        "Review action items at 30 days and publish the completion rate."
      ],
      "production": [
        "Every SEV1 and SEV2 produces a postmortem within five business days.",
        "Postmortems quantify impact in users and error budget, not adjectives.",
        "Action items are filed in the normal backlog with owners and dates.",
        "Completion rate is reviewed monthly by the engineering leads.",
        "Recurring contributing factors trigger a platform-level fix, not a third local one."
      ],
      "crates": [
        "tracing",
        "metrics",
        "serde"
      ],
      "github": [
        {
          "name": "tokio-rs/tracing",
          "url": "https://github.com/tokio-rs/tracing"
        }
      ],
      "pitfall": "Writing the postmortem as a narrative of who did what, with action items like improve communication: the document is read once, nothing changes, and the same incident recurs with different names in the timeline.",
      "resources": [
        {
          "title": "USENIX: systems operations and failure analysis talks",
          "url": "https://www.youtube.com/@USENIX",
          "kind": "video"
        },
        {
          "title": "Honeycomb: observability and incident review talks",
          "url": "https://www.youtube.com/@honeycombio",
          "kind": "video"
        },
        {
          "title": "tracing: structured events for timelines",
          "url": "https://docs.rs/tracing/latest/tracing/",
          "kind": "docs"
        },
        {
          "title": "prometheus/prometheus: recording rules for impact numbers",
          "url": "https://github.com/prometheus/prometheus",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "j20",
      "n": 20,
      "title": "Observability cost: volume, cardinality, retention",
      "minutes": 70,
      "level": "industry",
      "goal": "Model what telemetry costs per signal, cut the volume that carries no information, and protect the signals you would page on.",
      "sections": [
        {
          "h": "Four drivers, in order of leverage",
          "p": [
            "Cost is volume times price, and volume has four independent multipliers: how many events you emit, how many labels each carries, how long you keep them, and how many copies the pipeline makes. Cardinality is usually the largest, because it multiplies storage and index cost at the same time.",
            "Most teams start with retention because it is a single slider, and it is usually the wrong first move: halving retention halves storage but doubles the number of incidents you cannot investigate. Cutting duplicate and valueless events is cheaper and loses nothing."
          ],
          "list": [
            "Volume: events per request, spans per trace, debug logs in production",
            "Cardinality: series per metric, labels per span",
            "Retention: days of hot storage per signal",
            "Copies: replicas, cross-region replication, and egress between zones"
          ]
        },
        {
          "h": "The levers, cheapest first",
          "p": [
            "Drop what nobody queries. Health checks, readiness probes, and static asset requests are usually a third of the traffic and none of the information. Filtering them at the Collector costs one config block and removes the volume before it is stored.",
            "Then reduce duplication: one span per boundary instead of per function, one log line per state change instead of per step, and structured fields instead of a formatted message repeated in three places. Only after that should you touch sampling, and only after sampling should you touch retention."
          ],
          "code": "processors:\n  memory_limiter:\n    check_interval: 1s\n    limit_mib: 4000\n    spike_limit_mib: 800\n\n  filter/drop_probes:\n    error_mode: ignore\n    traces:\n      span:\n        - 'name == \"GET /healthz\"'\n        - 'name == \"GET /readyz\"'\n    metrics:\n      datapoint:\n        - 'metric.name == \"http_requests_total\" and attributes[\"route\"] == \"healthz\"'\n\n  batch:\n    send_batch_size: 8192\n    timeout: 5s\n\nexporters:\n  otlp:\n    endpoint: otelcol-backend:4317\n    compression: zstd\n\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: [memory_limiter, filter/drop_probes, batch]\n      exporters: [otlp]",
          "tip": "memory_limiter first in the pipeline: without it, a traffic spike makes the Collector OOM and you lose the telemetry exactly when the incident starts."
        },
        {
          "h": "Unit economics, measured not guessed",
          "p": [
            "Convert every signal to a unit price: cost per million spans, per gigabyte of logs ingested, per thousand active series per month. Then multiply by the actual volume from a normal week. The number that surprises people is almost always series, because a single label change can multiply it by ten.",
            "Once you have the unit prices, the conversation changes from reduce observability to this dashboard costs more than the service it monitors. That is a decision someone can make, and it is usually the right one to make in favour of the dashboard - but only when it is visible."
          ]
        },
        {
          "h": "Do not cut the signal you will page on",
          "p": [
            "The error spans, the SLO recording rules, the alert-relevant metrics, and the logs from the failure path are the last things to cut. A cost programme that removes the ability to debug an outage has traded a recurring bill for a recurring incident, and the incident is more expensive.",
            "The safe cuts are duplicates, noise, and unused data: health checks, debug logs in production, spans that wrap pure functions, metrics nobody has queried in ninety days, and retention on high-volume low-value signals. If a cut would make a runbook step impossible, it is not a cut, it is a gamble."
          ],
          "list": [
            "Cut: health-check traffic, debug logs in prod, unused metrics, per-function spans",
            "Keep: error traces, SLO rules, page-worthy metrics, failure-path logs",
            "Sample: successful traces, high-volume access logs",
            "Archive: anything needed only for audit, at cold-storage prices"
          ]
        }
      ],
      "exercise": {
        "prompt": "Estimate the monthly cost of three signals - 2 TB of logs, 40 million spans, 5 million active series - using per-unit prices, then propose cuts that remove at least 40% of the bill without losing error traces or SLO metrics.",
        "starter": "logs:  2 TB/month  x $?/GB  = ?\nspans: 40M/month   x $?/M   = ?\nseries: 5M active   x $?/1k  = ?\n\n# cuts: ?",
        "hint": "Health checks and debug logs typically remove a third of log volume; dropping per-function spans and filtering probes removes a similar share of spans; series is dominated by one or two high-cardinality labels.",
        "solution": "# Unit prices are illustrative; substitute your contract rates.\nlogs:   2,000 GB  x $0.50/GB   = $1,000\nspans:  40 M      x $0.30/M    = $   12\nseries: 5,000 k   x $0.02/k/mo = $  100\n                                  ------\ntotal                             $1,112\n\n# The surprise: series and logs dominate; span count is cheap by comparison.\n\n# Cuts, in order of leverage:\n1. Filter probe traffic at the Collector (healthz/readyz)  -> ~30% of logs\n2. Drop debug-level logs in production (RUST_LOG=info)     -> ~15% of logs\n3. Drop per-function spans; keep one per I/O boundary      -> ~40% of spans\n4. Remove one unbounded label from the top series metric   -> ~60% of series\n5. Keep error traces at 100% and tail-sample the rest      -> no loss of signal\n\n# Resulting bill:\nlogs:   2,000 * 0.55 = 1,100 GB  x $0.50 = $550\nspans:  40 * 0.60    = 24 M      x $0.30 = $  7\nseries: 5,000 * 0.40 = 2,000 k   x $0.02 = $ 40\n                                           -----\ntotal                                       $597   (-46%)\n\n# Nothing that a runbook needs was removed: error traces, SLO rules and\n# failure-path logs are untouched."
      },
      "questions": [
        {
          "q": "Which lever usually reduces cost the most for the least loss of signal?",
          "options": [
            "Dropping duplicate and valueless volume such as probe traffic and debug logs",
            "Halving retention on every signal",
            "Sampling all traces to 1%",
            "Removing dashboards"
          ],
          "answer": 0,
          "explain": "Probe traffic and debug logs carry almost no information and are often a third of the volume. Cutting them costs nothing in diagnostic power, unlike retention or sampling."
        },
        {
          "q": "Why is cardinality often the dominant cost?",
          "options": [
            "It multiplies storage and index cost, and one label change can multiply it by ten",
            "Series are stored uncompressed",
            "Cardinality is billed per query",
            "Every series requires a separate connection"
          ],
          "answer": 0,
          "explain": "A series costs memory, disk and index entries, and it persists until it goes stale. A single unbounded label can outweigh every other optimisation combined."
        },
        {
          "q": "Which signal should never be part of a cost-cutting pass?",
          "options": [
            "Error traces and the metrics behind the SLO alerts",
            "Health-check spans",
            "Debug logs in production",
            "Metrics nobody has queried in ninety days"
          ],
          "answer": 0,
          "explain": "Those are the signals the runbook depends on. Cutting them trades a recurring bill for a recurring incident, which is the more expensive of the two."
        }
      ],
      "quickbytes": [
        "Cost = volume x cardinality x retention x copies; attack the biggest multiplier.",
        "Filter health checks and probe traffic at the Collector before anything else.",
        "Compute cost per million spans, per GB of logs, per thousand series, then compare.",
        "Never cut error traces or SLO metrics to save money."
      ],
      "production": [
        "Every signal has an owner and a monthly volume budget.",
        "The Collector filters probe and health-check traffic before export.",
        "Retention differs per signal and is justified by what the runbooks need.",
        "Compression and batching are enabled on every exporter.",
        "A quarterly review compares cost per signal against query usage."
      ],
      "crates": [
        "opentelemetry-otlp",
        "metrics",
        "tracing",
        "prometheus"
      ],
      "github": [
        {
          "name": "open-telemetry/opentelemetry-collector-contrib",
          "url": "https://github.com/open-telemetry/opentelemetry-collector-contrib"
        },
        {
          "name": "prometheus/prometheus",
          "url": "https://github.com/prometheus/prometheus"
        }
      ],
      "pitfall": "Cutting retention on traces first because it is one slider: the bill drops, and the next incident is investigated with six hours of history, which is not enough to compare against last week's baseline.",
      "resources": [
        {
          "title": "OpenTelemetry Collector configuration: processors and exporters",
          "url": "https://opentelemetry.io/docs/collector/configuration/",
          "kind": "docs"
        },
        {
          "title": "open-telemetry/opentelemetry-collector-contrib: filter and sampling processors",
          "url": "https://github.com/open-telemetry/opentelemetry-collector-contrib",
          "kind": "repo"
        },
        {
          "title": "prometheus/prometheus: retention and storage",
          "url": "https://github.com/prometheus/prometheus",
          "kind": "repo"
        },
        {
          "title": "Grafana: metrics cost and cardinality talks",
          "url": "https://www.youtube.com/@Grafana",
          "kind": "video"
        }
      ]
    }
  ]
};
