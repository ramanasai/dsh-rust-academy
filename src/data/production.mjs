/**
 * Production & platform track.
 *
 * The last mile of Rust: telemetry, configuration and secrets, resilience,
 * security hardening, container packaging, Kubernetes runtime behaviour,
 * CI/supply chain, and performance engineering.
 *
 * Version notes verified against docs.rs at the time of writing:
 *   tracing 0.1.x, tracing-subscriber 0.3.x, opentelemetry 0.33.x,
 *   opentelemetry-otlp 0.33.x, tracing-opentelemetry 0.34.x,
 *   metrics 0.24.x, tower 0.5.x, tower-http 0.7.x, governor 0.10.x,
 *   config 0.15.x, secrecy 0.10.x, sqlx 0.9.x, criterion 0.8.x,
 *   cargo-audit 0.22.x, cargo-deny 0.20.x, cargo-cyclonedx 0.5.x.
 */
export default {
  key: "production",
  prefix: "g",
  title: "Production & platform engineering",
  blurb:
    "Run Rust in production: telemetry, layered config and secrets, resilience, security, containers, Kubernetes, supply chain, and the performance loop that keeps latency honest.",
  level: "industry",
  project: {
    title: "Capstone: ship Ledgerline to production",
    brief:
      "Take a Rust HTTP service from cargo run to a running Kubernetes deployment. It must be instrumented with traces and metrics, configured per environment with secrets fetched from a manager, resilient to dependency failures, hardened against injection, shipped as a small distroless image, gated by CI with audit and SBOM, and profiled against a written latency budget.",
    deliverables: [
      "A tracing and metrics bootstrap that exports OTLP and never blocks the request path",
      "Layered configuration for dev, staging and prod, with secrets redacted from every log line",
      "Timeout, jittered retry, circuit-breaker and rate-limit policies on every outbound call",
      "A hardened HTTP surface: validated input, deny-by-default authorization, security headers, strict CORS",
      "A multi-stage image under 40 MB running as non-root with a pinned toolchain",
      "Kubernetes Deployment with startup, readiness and liveness probes, HPA and graceful drain",
      "CI that runs fmt, clippy, tests, cargo-audit, cargo-deny, cross-builds and publishes an SBOM",
      "A benchmark, profile and load-test loop with a documented p99 budget per route",
    ],
    stack: [
      "tokio",
      "axum",
      "tower",
      "tower-http",
      "tracing",
      "tracing-subscriber",
      "opentelemetry",
      "opentelemetry-otlp",
      "metrics",
      "metrics-exporter-prometheus",
      "config",
      "secrecy",
      "sqlx",
      "governor",
      "criterion",
      "pprof",
    ],
  },
  lessons: [
    {
      id: "g01",
      title: "Observability: tracing, JSON logs, OTLP and metrics",
      minutes: 100,
      level: "industry",
      goal:
        "Instrument a service with spans, structured logs, OTLP trace export and RED/USE metrics so on-call can answer what is slow, what is failing and who is calling it.",
      sections: [
        {
          h: "Spans are the unit of production debugging",
          p: [
            "A log line says something happened. A span says it happened inside this request, under this parent, took this long and returned this value. When a request fans out to Postgres, Redis and two upstream APIs, the span tree is the only artifact that reconstructs causality after the fact.",
            "The #[instrument] attribute creates a span named after the function and records arguments as fields. Arguments that are not Debug must be skipped, and large payloads should always be skipped: every field is stored, indexed and billed by your tracing backend.",
          ],
          code: `use tracing::{info, instrument};

#[instrument(skip_all, fields(order.id = %order.id, order.total_cents = order.total_cents))]
pub async fn charge(order: &Order, store: &Store) -> Result<Receipt, ChargeError> {
    info!(attempt = 1, "charging order");
    let receipt = store.charge(order).await?;
    info!(receipt.id = %receipt.id, "charge accepted");
    Ok(receipt)
}`,
          tip:
            "Use skip_all and add only the fields you will actually query. Recording a whole request body as a span field is how secrets and personal data end up in a trace backend.",
        },
        {
          h: "Logs are JSON on stdout, filtered at runtime",
          p: [
            "Containers do not read log files; the runtime captures stdout. Emit one JSON object per line so the pipeline parses fields without regexes, and let the process choose its level from an environment variable so raising verbosity does not need a rebuild.",
            "An EnvFilter with a sane default plus per-crate overrides gives you that control. Pretty output is nice locally and useless in a log pipeline, so keep it behind an explicit development flag rather than as the default.",
          ],
          code: `use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

pub fn init_logging() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,ledger_api=debug,tower_http=debug"));

    tracing_subscriber::registry()
        .with(filter)
        .with(
            fmt::layer()
                .json()
                .with_target(true)
                .with_current_span(true)
                .with_span_list(false),
        )
        .init(); // panics if a global subscriber is already set
}`,
          tip:
            "tracing-subscriber needs the json and env-filter features. In tests, use tracing::subscriber::with_default instead of .init(), because the global subscriber can only be set once per process.",
        },
        {
          h: "Export traces over OTLP without blocking requests",
          p: [
            "OpenTelemetry Rust 0.33 separates the API (opentelemetry), the SDK (opentelemetry_sdk) and the exporter (opentelemetry-otlp). Build one provider at startup, register it globally, and attach a tracing_opentelemetry layer so existing spans become OTel spans without rewriting instrumentation.",
            "The batch span processor owns a bounded queue and a background exporter. When the collector is unreachable, spans are dropped once that queue is full: that is the correct failure mode. A synchronous exporter in the request path, or a shutdown that exits before the final batch flushes, is not.",
          ],
          code: `use opentelemetry::trace::TracerProvider as _;
use opentelemetry_sdk::{trace::SdkTracerProvider, Resource};
use opentelemetry_otlp::WithExportConfig;
use std::time::Duration;
use tracing_subscriber::{layer::SubscriberExt, EnvFilter};

pub fn init_telemetry(service: &str) -> anyhow::Result<SdkTracerProvider> {
    opentelemetry::global::set_text_map_propagator(
        opentelemetry_sdk::propagation::TraceContextPropagator::new(),
    );

    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_tonic()
        .with_endpoint(
            std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
                .unwrap_or_else(|_| "http://otel-collector:4317".to_string()),
        )
        .with_timeout(Duration::from_secs(5))
        .build()?;

    let provider = SdkTracerProvider::builder()
        .with_resource(Resource::builder().with_service_name(service.to_string()).build())
        .with_batch_exporter(exporter)
        .build();

    let tracer = provider.tracer(service.to_string());
    opentelemetry::global::set_tracer_provider(provider.clone());

    let subscriber = tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer().json())
        .with(tracing_opentelemetry::layer().with_tracer(tracer));
    tracing::subscriber::set_global_default(subscriber)?;

    Ok(provider) // keep it alive; call shutdown_with_timeout on exit
}`,
          tip:
            "Cargo: opentelemetry = 0.33, opentelemetry_sdk = 0.33, opentelemetry-otlp = { version = 0.33, features = [trace, grpc-tonic] }, tracing-opentelemetry = 0.34. Pin exact minors: these crates still ship breaking changes.",
        },
        {
          h: "Metrics: RED for services, USE for resources",
          p: [
            "Traces explain one request; metrics explain the fleet. Track RED for everything that serves requests and USE for everything you provision. The metrics facade keeps instrumentation independent of the backend: handlers emit counters and histograms, a recorder such as metrics-exporter-prometheus exposes them for scraping.",
            "Keep labels small and bounded. A label holding the raw URL path, a user id or a trace id multiplies cardinality per request and eventually takes down the metrics backend, not just your dashboard.",
          ],
          list: [
            "Rate: requests per second per route, split by method. This is the denominator for every other signal.",
            "Errors: failures divided by requests, with 4xx and 5xx separated so a client bug is not paged as an outage.",
            "Duration: a histogram in seconds, queried as p50, p95 and p99. Averages hide the tail that users feel.",
            "Utilization: CPU, memory and pool occupancy against the limits you actually set in Kubernetes.",
            "Saturation: queue depth, pool wait time and rejected connections. Saturation rises before latency does.",
          ],
          code: `use metrics::{counter, histogram};
use std::time::Instant;

fn status_class(status: u16) -> &'static str {
    match status {
        200..=299 => "2xx",
        400..=499 => "4xx",
        _ => "5xx",
    }
}

pub fn record_request(route: &'static str, status: u16, started: Instant) {
    counter!("http_requests_total", "route" => route, "status" => status_class(status)).increment(1);
    histogram!("http_request_duration_seconds", "route" => route, "status" => status_class(status))
        .record(started.elapsed().as_secs_f64());
}`,
          tip:
            "Record durations in seconds and sizes in bytes. Prometheus, Grafana dashboards and alert templates all assume base units, and a milliseconds histogram silently breaks every percentile query you inherit.",
        },
      ],
      exercise: {
        prompt:
          "Make handle_refund observable: one span per call carrying the refund id and amount, an outcome log, and a counter that separates accepted from rejected refunds.",
        starter: `use metrics::counter;
use tracing::{info, instrument, warn};

struct Refund {
    id: u64,
    amount_cents: u64,
}

// TODO: add a span with refund.id and refund.amount_cents, skip the fields you do not need
async fn handle_refund(refund: Refund) -> Result<String, String> {
    if refund.amount_cents == 0 {
        // TODO: count a rejected refund and log at warn level
        return Err("zero amount".to_string());
    }
    // TODO: count an accepted refund and log at info level
    Ok(format!("refunded {}", refund.id))
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().json().init();
    println!("{:?}", handle_refund(Refund { id: 7, amount_cents: 1250 }).await);
    println!("{:?}", handle_refund(Refund { id: 8, amount_cents: 0 }).await);
}`,
        hint:
          "Put #[instrument(skip_all, fields(refund.id = refund.id, refund.amount_cents = refund.amount_cents))] on the async fn and call counter!(\"refunds_total\", \"outcome\" => outcome).increment(1) on each branch.",
        solution: `use metrics::counter;
use tracing::{info, instrument, warn};

struct Refund {
    id: u64,
    amount_cents: u64,
}

#[instrument(skip_all, fields(refund.id = refund.id, refund.amount_cents = refund.amount_cents))]
async fn handle_refund(refund: Refund) -> Result<String, String> {
    if refund.amount_cents == 0 {
        counter!("refunds_total", "outcome" => "rejected").increment(1);
        warn!(reason = "zero_amount", "refund rejected");
        return Err("zero amount".to_string());
    }

    counter!("refunds_total", "outcome" => "accepted").increment(1);
    info!(status = "accepted", "refund processed");
    Ok(format!("refunded {}", refund.id))
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().json().init();
    let ok = handle_refund(Refund { id: 7, amount_cents: 1250 }).await;
    let rejected = handle_refund(Refund { id: 8, amount_cents: 0 }).await;
    println!("{ok:?} {rejected:?}");
    // The metrics facade is a no-op until a recorder is installed, so this runs
    // without an exporter. Add metrics-exporter-prometheus to scrape it.
}`,
      },
      questions: [
        {
          q: "A service exports OTLP traces and the collector dies for ten minutes. What keeps request latency unaffected?",
          options: [
            "A synchronous exporter with a generous timeout",
            "The batch span processor's bounded queue, which drops spans when it is full",
            "Sampling every span at 100 percent so the queue never fills",
            "Blocking each request until the export is acknowledged",
          ],
          answer: 1,
          explain:
            "The batch processor owns a bounded queue and a background exporter thread. When the collector is unreachable the queue fills and spans are dropped, which is the intended failure mode. A synchronous exporter or an unbounded queue turns a collector outage into a request-path stall.",
        },
        {
          q: "Why is holding a span.enter() guard across an .await wrong in a multi-threaded runtime?",
          options: [
            "The span is closed as soon as the poll returns Pending",
            "The guard is thread-local, so another task polled on the same worker logs under your span",
            "It forces the future to become !Send and fails to compile in every case",
            "It disables trace-context propagation to outbound HTTP calls",
          ],
          answer: 1,
          explain:
            "Entered spans are stored per thread. A different task resumed on the same worker inherits the wrong current span, which produces interleaved and misattributed logs. Use #[instrument] or future.instrument(span): both attach the span to the future instead of the thread.",
        },
      ],
      production: [
        "Every handler carries a span with route, method, status and a propagated trace id that reaches outbound HTTP and SQL calls",
        "Logs are newline-delimited JSON on stdout; level is controlled by RUST_LOG and never by a rebuild",
        "OTLP uses the batch processor with a bounded queue, so a dead collector drops spans instead of stalling requests",
        "Dashboards show RED per route and USE per instance; alerts fire on error-budget burn, not on a single 5xx",
        "Shutdown stops accepting connections first, then calls provider.shutdown_with_timeout(Duration::from_secs(5))",
      ],
      crates: [
        "tracing",
        "tracing-subscriber",
        "tracing-opentelemetry",
        "opentelemetry",
        "opentelemetry-otlp",
        "opentelemetry_sdk",
        "metrics",
        "metrics-exporter-prometheus",
      ],
      pitfall:
        "Calling span.enter() in an async fn and holding the guard across .await: the guard is thread-local, so another task polled on the same worker logs under your span. Use #[instrument] or .instrument(span), which attach to the future instead of the thread.",
      quickbytes: [
        "RUST_LOG=info,ledger_api=debug,tower_http=debug - change verbosity with an env var and a rollout, never with a rebuild.",
        "Record durations in seconds and sizes in bytes; a millisecond histogram silently breaks every p99 query you inherit.",
        "Point OTEL_EXPORTER_OTLP_ENDPOINT at the collector and call provider.shutdown_with_timeout(5s) on SIGTERM so the last batch flushes.",
      ],
      github: [
        {
          name: "tokio-rs/tracing",
          url: "https://github.com/tokio-rs/tracing",
        },
        {
          name: "open-telemetry/opentelemetry-rust",
          url: "https://github.com/open-telemetry/opentelemetry-rust",
        },
      ],
      resources: [
        {
          title: "tracing: the #[instrument] attribute",
          url: "https://docs.rs/tracing/latest/tracing/attr.instrument.html",
          kind: "docs",
        },
        {
          title: "tracing-subscriber: JSON log formatter",
          url: "https://docs.rs/tracing-subscriber/latest/tracing_subscriber/fmt/format/struct.Json.html",
          kind: "docs",
        },
        {
          title: "opentelemetry-otlp: exporter, endpoints and env vars",
          url: "https://docs.rs/opentelemetry-otlp/latest/opentelemetry_otlp/",
          kind: "docs",
        },
        {
          title: "metrics: counters, gauges and histograms",
          url: "https://docs.rs/metrics/latest/metrics/",
          kind: "docs",
        },
        {
          title: "OpenTelemetry channel: collector, SDK and semantic conventions",
          url: "https://www.youtube.com/@OpenTelemetry",
          kind: "video",
        },
      ],
    },
    {
      id: "g02",
      title: "Configuration and secrets without leaks",
      minutes: 80,
      level: "industry",
      goal:
        "Load typed, layered configuration per environment, validate it at startup, keep secrets out of logs and images, and choose a reload strategy you can roll back.",
      sections: [
        {
          h: "Layer sources; never branch on the environment",
          p: [
            "Environment branching multiplies into if dev { ... } else if staging { ... } inside business logic and drifts within a month. Merge layered sources instead, highest wins, and let the process run exactly the same code everywhere. The config crate makes that ordering explicit and testable.",
            "Keep defaults in the repository, environment overrides in files, and deployment-specific values in environment variables injected by the platform. Anything that differs between two pods of the same deployment is a bug, not configuration.",
          ],
          list: [
            "Built-in defaults: safe values that let the service boot for a smoke test with no external input.",
            "config/default.toml: committed, reviewed, contains no secrets and no environment hosts.",
            "config/{APP_ENV}.toml: staging and production overrides, still secret-free.",
            "APP_* environment variables: the only source of tenant-specific and deployment-specific values.",
            "Command-line flags: operational overrides for debugging, logged at startup so they are visible.",
          ],
          code: `# config/default.toml — committed, no secrets
http_port = 8080
log_level = "info"

[db]
host = "localhost"
pool_size = 10
connect_timeout_ms = 2000`,
          tip:
            "Log which sources were loaded and which keys were overridden, but log key names only. Printing merged values is the fastest way to leak a password into the log pipeline.",
        },
        {
          h: "Parse into a typed struct and fail fast",
          p: [
            "Deserialize once at startup into a struct with deny_unknown_fields, then validate ranges that serde cannot express. A typo in a key or a pool size of zero should abort the process with a non-zero exit and a readable error, not surface as a 500 an hour later under load.",
            "Pass the parsed settings to consumers explicitly, or behind an Arc. Global config getters look convenient until a test needs two different configurations in the same process.",
          ],
          code: `use config::{Config, Environment, File};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub http_port: u16,
    pub db: DbSettings,
    pub log_level: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DbSettings {
    pub host: String,
    pub pool_size: u32,
    pub connect_timeout_ms: u64,
}

pub fn load() -> Result<Settings, config::ConfigError> {
    let env = std::env::var("APP_ENV").unwrap_or_else(|_| "development".to_string());
    let settings: Settings = Config::builder()
        .add_source(File::with_name("config/default").required(true))
        .add_source(File::with_name(&format!("config/{env}")).required(false))
        .add_source(
            Environment::with_prefix("APP")
                .prefix_separator("_")   // APP_HTTP_PORT -> http_port
                .separator("__")         // APP_DB__POOL_SIZE -> db.pool_size
                .try_parsing(true),
        )
        .build()?
        .try_deserialize()?;

    if settings.db.pool_size == 0 || settings.db.pool_size > 128 {
        return Err(config::ConfigError::Message(
            "db.pool_size must be in 1..=128".to_string(),
        ));
    }
    Ok(settings)
}`,
          tip:
            "config 0.15 with the toml and env features: File::with_name resolves config/default.toml and required(false) allows a missing stage file. Env sources need both prefix_separator and separator, or APP_DB__POOL_SIZE never becomes db.pool_size.",
        },
        {
          h: "Secrets are a type, not a string",
          p: [
            "A password that is a String will eventually be printed: by a Debug derive, a panic message, a tracing field or a dump of the config struct in an incident. secrecy's SecretBox makes the value opaque and zeroizes it on drop, and exposing it requires an explicit, greppable call.",
            "Fetch secrets at boot from a manager (Vault, AWS Secrets Manager, GCP Secret Manager) with a workload identity, or mount them from a CSI driver. Never bake them into the image, the ConfigMap, the Dockerfile or a .env file that ships.",
          ],
          code: `use secrecy::{ExposeSecret, SecretString};

pub struct DbConfig {
    pub url: SecretString,
}

impl DbConfig {
    pub async fn connect(&self) -> Result<sqlx::PgPool, sqlx::Error> {
        // The only place the plaintext exists; audit every call to expose_secret.
        let url = self.url.expose_secret();
        sqlx::postgres::PgPoolOptions::new()
            .max_connections(16)
            .connect(url)
            .await
    }
}

impl std::fmt::Debug for DbConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DbConfig").field("url", &"[REDACTED]").finish()
    }
}`,
          tip:
            "secrecy does not protect against a debugger or a core dump. Its job is narrower and more valuable: make accidental leaks through Debug, Display and logs impossible in normal code paths.",
        },
        {
          h: "Reload only what you can roll back",
          p: [
            "Most teams should reload by restarting pods: deploy a new image with new values and let the rollout move traffic. In-process reload is worth it only for values whose change is safe under live traffic, such as log level, feature flags and per-tenant limits.",
            "When you do reload, parse and validate the new configuration first, compare it to the running one, and swap atomically. In-flight requests keep the old Arc, so a bad reload cannot corrupt a request that already started, and a rejected reload leaves the process untouched.",
          ],
          code: `use arc_swap::ArcSwap;
use std::sync::Arc;

pub struct AppState {
    settings: ArcSwap<Settings>,
}

impl AppState {
    /// Called from SIGHUP or a file watch, never from a request path.
    pub fn reload(&self) -> Result<(), ReloadError> {
        let next = load_settings()?;                    // parse + validate first
        let current = self.settings.load();
        if next.db.host != current.db.host {
            return Err(ReloadError::RestartRequired("db.host"));
        }
        self.settings.store(Arc::new(next));            // atomic swap
        tracing::info!("configuration reloaded");
        Ok(())
    }
}`,
          tip:
            "A ConfigMap or Secret volume updates inside the pod within about a minute, but nothing restarts and the process keeps its old copy. Trigger a rollout (checksum annotation or kubectl rollout restart) when values change.",
        },
      ],
      exercise: {
        prompt:
          "Write load() that produces Settings from defaults plus APP_ prefixed environment variables, rejects an unknown key and rejects a pool size of zero. Run it with and without APP_DB__POOL_SIZE set.",
        starter: `use config::Config;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Settings {
    http_port: u16,
    db: DbSettings,
}

#[derive(Debug, Deserialize)]
struct DbSettings {
    pool_size: u32,
}

fn load() -> Result<Settings, Box<dyn std::error::Error>> {
    // TODO: set defaults, add Environment with prefix_separator("_") and separator("__")
    // TODO: reject pool_size == 0
    todo!()
}

fn main() {
    match load() {
        Ok(s) => println!("port={} pool={}", s.http_port, s.db.pool_size),
        Err(e) => eprintln!("config error: {e}"),
    }
}`,
        hint:
          "Config::builder().set_default(\"http_port\", 8080)?.set_default(\"db.pool_size\", 10)? then .add_source(Environment::with_prefix(\"APP\").prefix_separator(\"_\").separator(\"__\").try_parsing(true)).build()?.try_deserialize().",
        solution: `use config::{Config, Environment};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    http_port: u16,
    db: DbSettings,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DbSettings {
    pool_size: u32,
}

fn load() -> Result<Settings, Box<dyn std::error::Error>> {
    let settings: Settings = Config::builder()
        .set_default("http_port", 8080)?
        .set_default("db.pool_size", 10)?
        .add_source(
            Environment::with_prefix("APP")
                .prefix_separator("_")   // APP_HTTP_PORT   -> http_port
                .separator("__")         // APP_DB__POOL_SIZE -> db.pool_size
                .try_parsing(true),
        )
        .build()?
        .try_deserialize()?;

    if settings.db.pool_size == 0 {
        return Err("db.pool_size must be at least 1".into());
    }
    Ok(settings)
}

fn main() {
    // APP_DB__POOL_SIZE=32 APP_HTTP_PORT=9000 cargo run
    // APP_TYPO=1 cargo run  -> unknown field error, process exits non-zero
    match load() {
        Ok(s) => println!("port={} pool={}", s.http_port, s.db.pool_size),
        Err(e) => {
            eprintln!("config error: {e}");
            std::process::exit(1);
        }
    }
}`,
      },
      questions: [
        {
          q: "APP_DB__POOL_SIZE=32 is exported, but db.pool_size still reads the default. What is the most likely cause?",
          options: [
            "try_parsing(true) must be disabled for numeric overrides",
            "The env source is missing separator(\"__\"), so the key lands as db__pool_size instead of db.pool_size",
            "serde renames every nested field, so the variable has to be APP_DBPOOLSIZE",
            "config only reads environment variables for keys that already exist in default.toml",
          ],
          answer: 1,
          explain:
            "With prefix_separator(\"_\") the APP_ prefix is stripped, but nesting is expressed by separator(\"__\"). Without it the whole remainder stays one flat key, try_deserialize finds no db.pool_size, and the default survives while the process looks correctly configured.",
        },
        {
          q: "Which value can be swapped in-process through ArcSwap under live traffic?",
          options: [
            "db.host, because pools reconnect automatically",
            "http_port, because the listener can rebind",
            "Log level and per-tenant rate limits, which are safe to change mid-request",
            "The database password, because secrecy zeroizes the old one",
          ],
          answer: 2,
          explain:
            "Only values whose change is safe under live traffic belong in a hot reload: log level, feature flags, per-tenant limits. A host change invalidates pools and a port change needs a new listener, so both are restart-only and the loader should reject them instead of pretending.",
        },
      ],
      production: [
        "Configuration is parsed once into a typed struct at startup; unknown keys and invalid ranges abort with a non-zero exit code",
        "Secret values are wrapped in secrecy::SecretBox and cannot appear in Debug, Display or tracing fields by accident",
        "Secrets arrive at boot from a manager via workload identity, never from the image, the ConfigMap or a committed .env",
        "A config change triggers a rollout; no pod silently keeps a stale ConfigMap copy",
        "Every reloadable value has a rollback path, and values that cannot be swapped safely are documented as restart-only",
      ],
      crates: ["config", "serde", "secrecy", "arc-swap", "tracing"],
      pitfall:
        "Deriving Debug on the config struct and logging it at startup: the first incident dumps the database password into the log aggregator, where it is retained for the whole retention window and readable by everyone with log access.",
      quickbytes: [
        "APP_DB__POOL_SIZE=32 APP_HTTP_PORT=9000 - prefix_separator(\"_\") plus separator(\"__\") is what turns APP_DB__POOL_SIZE into db.pool_size.",
        "grep -rn \"expose_secret\" src/ - every hit is an audit point; keep them in the connect path, never in handlers or log fields.",
        "kubectl create secret generic ledger-db --from-literal=url=\"$DATABASE_URL\" --dry-run=client -o yaml | kubectl apply -f -",
      ],
      github: [
        {
          name: "rust-cli/config-rs",
          url: "https://github.com/rust-cli/config-rs",
        },
        {
          name: "iqlusioninc/crates (secrecy)",
          url: "https://github.com/iqlusioninc/crates",
        },
      ],
      resources: [
        {
          title: "config: layered configuration sources",
          url: "https://docs.rs/config/latest/config/",
          kind: "docs",
        },
        {
          title: "config on crates.io",
          url: "https://crates.io/crates/config",
          kind: "docs",
        },
        {
          title: "secrecy: redacted secret wrappers",
          url: "https://docs.rs/secrecy/latest/secrecy/",
          kind: "docs",
        },
        {
          title: "Kubernetes Secrets overview",
          url: "https://kubernetes.io/docs/concepts/configuration/secret/",
          kind: "docs",
        },
        {
          title: "HashiCorp channel: Vault, workload identity and secrets engines",
          url: "https://www.youtube.com/@HashiCorp",
          kind: "video",
        },
      ],
    },
    {
      id: "g03",
      title: "Resilience: timeouts, retries, breakers, bulkheads",
      minutes: 90,
      level: "industry",
      goal:
        "Stop a slow or failing dependency from taking down the whole service: budgeted timeouts, jittered retries, a circuit breaker, concurrency bulkheads and rate limits.",
      sections: [
        {
          h: "Timeouts form a budget, not a guess",
          p: [
            "Every hop needs a deadline shorter than its caller's, or a slow dependency converts into an unbounded queue and then into an outage. Write the budget down and enforce it in code, because the alternate reality is that everything waits for the library default, which is often no timeout at all.",
            "Put the timeout outside the retry wrapper, not inside it. If the deadline surrounds all attempts, the final attempt inherits almost no budget; if it wraps each attempt, every attempt gets a real chance and the outer context enforces the ceiling.",
          ],
          list: [
            "Client to edge: 10 s, because a human is waiting and will retry by hand after that.",
            "Edge load balancer to your service: 5 s, leaving headroom for serialization and TCP setup.",
            "Your handler budget: 3 s, so a database call plus two upstream calls can still fit.",
            "Downstream service or database call: 1 s per attempt; the downstream's own budget must be smaller.",
            "Cache lookups: 20-50 ms, and they fail open to the source of truth instead of hanging.",
          ],
          code: `use std::time::Duration;
use tower::ServiceBuilder;
use tower::timeout::TimeoutLayer;

let app = axum::Router::new()
    .route("/relay", axum::routing::post(relay))
    .layer(
        ServiceBuilder::new()
            .layer(TimeoutLayer::new(Duration::from_secs(3)))
            .layer(tower::limit::ConcurrencyLimitLayer::new(256)),
    );`,
          tip:
            "tower's TimeoutLayer requires the timeout feature and only works on a Service that is poll_ready; wrap the innermost call you own, not the whole connection stack, or you will time out on queueing rather than on work.",
        },
        {
          h: "Retries that do not amplify an outage",
          p: [
            "A retry is a bet that the failure was transient. The bet loses badly when the dependency is overloaded: three retries multiply traffic by four exactly when the dependency can least afford it. Retry only idempotent operations, cap attempts at two or three, and add jitter so retries do not arrive in lockstep.",
            "tower's retry layer takes a Policy that decides whether to retry and how long to wait. The wait future is your backoff, which means you control jitter explicitly instead of hoping the default is sensible.",
          ],
          code: `use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tower::retry::Policy;

pub struct JitteredRetry {
    attempts_left: u8,
}

impl<Req: Clone, Res, E> Policy<Req, Res, E> for JitteredRetry {
    type Future = Pin<Box<dyn Future<Output = ()> + Send>>;

    fn retry(&mut self, _req: &mut Req, result: &mut Result<Res, E>) -> Option<Self::Future> {
        if result.is_ok() || self.attempts_left == 0 {
            return None;
        }
        self.attempts_left -= 1;
        let attempt = 3 - self.attempts_left;
        let base_ms = 100u64 << attempt;           // 200 ms, then 400 ms
        let jitter_ms = nanos_since_epoch() % 100;
        Some(Box::pin(tokio::time::sleep(Duration::from_millis(
            base_ms + jitter_ms,
        ))))
    }

    fn clone_request(&mut self, req: &Req) -> Option<Req> {
        Some(req.clone()) // returning None disables retrying entirely
    }
}

fn nanos_since_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0)
}`,
          tip:
            "tower 0.5 also ships retry::budget::Budget: a retry allowance that shrinks when successes are scarce, so a failing dependency stops receiving amplified traffic without you hand-tuning counters.",
        },
        {
          h: "Circuit breakers and bulkheads",
          p: [
            "A circuit breaker stops calling a dependency after repeated failures and fails fast instead of spending the full timeout per request. After a cooldown it lets a single probe through; success closes the circuit, failure opens it again for another cooldown.",
            "A bulkhead bounds concurrency per dependency so one slow upstream cannot consume the shared connection pool and thread pool. Combine them: breaker for broken dependencies, semaphore for merely slow ones, both returning 503 quickly rather than queueing.",
          ],
          code: `use std::sync::atomic::{AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const CLOSED: u8 = 0;
const OPEN: u8 = 1;
const HALF_OPEN: u8 = 2;

pub struct Breaker {
    state: AtomicU8,
    failures: AtomicU32,
    open_until_ms: AtomicU64,
    threshold: u32,
    cooldown: Duration,
}

impl Breaker {
    pub fn allow(&self) -> bool {
        match self.state.load(Ordering::Acquire) {
            CLOSED => true,
            // Exactly one caller wins the OPEN -> HALF_OPEN transition and probes.
            OPEN if now_ms() >= self.open_until_ms.load(Ordering::Acquire) => self
                .state
                .compare_exchange(OPEN, HALF_OPEN, Ordering::AcqRel, Ordering::Acquire)
                .is_ok(),
            _ => false,
        }
    }

    pub fn record(&self, ok: bool) {
        if ok {
            self.failures.store(0, Ordering::Relaxed);
            self.state.store(CLOSED, Ordering::Release);
            return;
        }
        let failures = self.failures.fetch_add(1, Ordering::Relaxed) + 1;
        if failures >= self.threshold && self.state.load(Ordering::Acquire) != OPEN {
            let until = now_ms() + self.cooldown.as_millis() as u64;
            self.open_until_ms.store(until, Ordering::Release);
            self.state.store(OPEN, Ordering::Release);
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}`,
          tip:
            "Keep the breaker per dependency instance, not per process. One breaker shared by all replicas requires shared state (Redis) and usually creates more problems than the failures it prevents.",
        },
        {
          h: "Rate limits and load shedding",
          p: [
            "Rate limits protect the service from its callers; load shedding protects it from itself. governor implements a generic cell rate algorithm in memory, which is enough for per-tenant and per-route limits on a single replica. For a global limit across replicas you need shared state, and you should budget for its latency.",
            "Return 429 for a caller over quota and 503 when you are shedding because your own capacity is gone. Both should include Retry-After so well-behaved clients back off instead of hot-looping.",
          ],
          code: `use std::num::NonZeroU32;
use governor::{Quota, RateLimiter};

// 600 requests per minute per tenant; keyed by the tenant id from verified claims.
let per_tenant = RateLimiter::keyed(Quota::per_minute(NonZeroU32::new(600).unwrap()));

fn check_quota(tenant: &str) -> Result<(), (u16, &'static str)> {
    per_tenant
        .check_key(tenant)
        .map_err(|_| (429, "retry-after: 1"))
}

// Bulkhead: at most 32 concurrent calls to the pricing dependency.
let pricing_permits = std::sync::Arc::new(tokio::sync::Semaphore::new(32));

fn acquire_pricing(permits: &std::sync::Arc<tokio::sync::Semaphore>) -> Result<tokio::sync::OwnedSemaphorePermit, (u16, &'static str)> {
    permits
        .clone()
        .try_acquire_owned()
        .map_err(|_| (503, "pricing capacity exhausted; retry-after: 1"))
}`,
          tip:
            "Rate-limit on the dimension you sell or bill: tenant, API key, or plan tier. Limiting by IP punishes users behind a corporate NAT and does nothing about a single tenant hammering you with many addresses.",
        },
      ],
      exercise: {
        prompt:
          "Implement fetch_with_retry: up to max_attempts calls, no retry on a fatal error, exponential backoff 100/200/400 ms with jitter, and the last error returned when attempts run out.",
        starter: `use std::time::Duration;
use tokio::time::sleep;

#[derive(Debug, PartialEq)]
enum FetchError {
    Transient,
    Fatal,
}

async fn fetch(attempt: u32) -> Result<String, FetchError> {
    if attempt < 3 {
        Err(FetchError::Transient)
    } else {
        Ok("payload".to_string())
    }
}

async fn fetch_with_retry(max_attempts: u32) -> Result<String, FetchError> {
    // TODO: loop, call fetch, return early on Fatal, sleep with backoff on Transient
    todo!()
}

#[tokio::main]
async fn main() {
    assert_eq!(fetch_with_retry(5).await, Ok("payload".to_string()));
    assert_eq!(fetch_with_retry(2).await, Err(FetchError::Transient));
    println!("retry behaviour verified");
}`,
        hint:
          "Track the attempt number, match on fetch(attempt).await, and for Transient compute 100u64 << (attempt - 1) milliseconds plus a jitter of a few milliseconds before sleeping.",
        solution: `use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::time::sleep;

#[derive(Debug, PartialEq)]
enum FetchError {
    Transient,
    Fatal,
}

async fn fetch(attempt: u32) -> Result<String, FetchError> {
    if attempt < 3 {
        Err(FetchError::Transient)
    } else {
        Ok("payload".to_string())
    }
}

fn jitter_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64 % 100)
        .unwrap_or(0)
}

async fn fetch_with_retry(max_attempts: u32) -> Result<String, FetchError> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        match fetch(attempt).await {
            Ok(value) => return Ok(value),
            Err(FetchError::Fatal) => return Err(FetchError::Fatal),
            Err(err) if attempt >= max_attempts => return Err(err),
            Err(_) => {
                let base_ms = 100u64 << (attempt - 1); // 100, 200, 400 ...
                sleep(Duration::from_millis(base_ms.min(2_000) + jitter_ms())).await;
            }
        }
    }
}

#[tokio::main]
async fn main() {
    assert_eq!(fetch_with_retry(5).await, Ok("payload".to_string()));
    assert_eq!(fetch_with_retry(2).await, Err(FetchError::Transient));
    println!("retry behaviour verified");
}`,
      },
      questions: [
        {
          q: "Where does the overall deadline belong relative to a retry wrapper?",
          options: [
            "Inside each attempt, so every retry gets a fresh full timeout",
            "Outside the retry layer, so all attempts share one ceiling",
            "Only in the downstream service, which knows its own capacity",
            "On the load balancer, never in the application",
          ],
          answer: 1,
          explain:
            "The timeout wraps the retry loop. That way the final attempt inherits the remaining budget instead of a fresh one, and the worst case is bounded: retries cannot multiply the caller's deadline. Per-attempt timeouts still sit inside, shorter than the shared ceiling.",
        },
        {
          q: "What does tower's retry::budget::Budget change about retry behaviour?",
          options: [
            "It caps requests per second per tenant with a token bucket",
            "It shrinks the retry allowance when successes are scarce, so a failing dependency receives less amplified traffic",
            "It stores attempt counters in Redis so replicas share one budget",
            "It replaces the circuit breaker with a fixed attempt count",
          ],
          answer: 1,
          explain:
            "Budget is a retry allowance, not a rate limit: successful calls replenish it, failures drain it, and when it is empty the layer stops retrying. Under an outage this removes the retry amplification that turns a degraded dependency into a dead one, without any hand-tuned counters.",
        },
      ],
      production: [
        "Every outbound call has a timeout shorter than its caller's deadline, and the budget is written down next to the code",
        "Retries apply only to idempotent operations, cap at 3 attempts, jitter the backoff and respect a retry budget",
        "The circuit breaker opens after N consecutive failures, probes with exactly one request, and returns 503 with Retry-After",
        "Concurrency bulkheads cap calls per dependency group so one slow upstream cannot exhaust the shared pool",
        "Rate limits are keyed per tenant and per route, and overload sheds load with 429/503 before queues grow unbounded",
      ],
      crates: ["tower", "governor", "tokio", "tokio-util"],
      pitfall:
        "Retrying a request that already committed: a timeout on POST /payments triggers a retry that charges the customer twice. Retries belong to idempotent operations, and the idempotency key must be persisted server-side before the side effect runs.",
      quickbytes: [
        "Cap attempts at 3 and keep the whole retry loop inside the caller's deadline: 100 ms base, full jitter, 1 s ceiling per wait.",
        "Open breaker returns 503 with Retry-After: 1 in microseconds - assert that in a test, not a 3 s hang per queued request.",
        "Key rate limits on tenant or API key, never on client IP: a corporate NAT punishes thousands of innocent callers at once.",
      ],
      github: [
        {
          name: "tower-rs/tower",
          url: "https://github.com/tower-rs/tower",
        },
        {
          name: "boinkor-net/governor",
          url: "https://github.com/boinkor-net/governor",
        },
      ],
      resources: [
        {
          title: "tower::retry: policies, backoff and retry budgets",
          url: "https://docs.rs/tower/latest/tower/retry/index.html",
          kind: "docs",
        },
        {
          title: "tower::timeout: Timeout and TimeoutLayer",
          url: "https://docs.rs/tower/latest/tower/timeout/index.html",
          kind: "docs",
        },
        {
          title: "governor: in-memory rate limiting",
          url: "https://docs.rs/governor/latest/governor/",
          kind: "docs",
        },
        {
          title: "The Tail at Scale (Dean & Barroso): why retries amplify tail latency",
          url: "https://research.google/pubs/the-tail-at-scale/",
          kind: "paper",
        },
        {
          title: "InfoQ channel: production resilience and incident retrospectives",
          url: "https://www.youtube.com/@InfoQ",
          kind: "video",
        },
      ],
    },
    {
      id: "g04",
      title: "Security hardening for HTTP services",
      minutes: 85,
      level: "industry",
      goal:
        "Validate input at the boundary, authorize every object access, set the security headers and CORS policy you actually mean, and keep SQL injection structurally impossible.",
      sections: [
        {
          h: "Validate at the boundary; trust nothing inside",
          p: [
            "Validation is not a function you call in the handler if you remember; it is the only way to construct a domain type. Deserialize into a request struct with deny_unknown_fields, cap the body size, then convert into a validated type whose constructor enforces length, charset and range. Handlers accept the validated type, so an unvalidated value cannot reach business logic.",
            "Return 422 for a semantically invalid body and 400 for malformed JSON. Never let a validation failure become a 500: that hides the real cause and pages the wrong team.",
          ],
          code: `use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateInvoice {
    pub customer_email: String,
    pub amount_cents: u64,
    pub note: Option<String>,
}

impl CreateInvoice {
    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.customer_email.len() > 254 || !self.customer_email.contains('@') {
            return Err(ValidationError::field("customer_email", "invalid email"));
        }
        if self.amount_cents == 0 || self.amount_cents > 100_000_000 {
            return Err(ValidationError::field("amount_cents", "out of range"));
        }
        if self.note.as_deref().map(str::len).unwrap_or(0) > 500 {
            return Err(ValidationError::field("note", "max 500 characters"));
        }
        Ok(())
    }
}`,
          tip:
            "axum applies no body limit by default beyond the extractor limit you configure. Add axum::extract::DefaultBodyLimit::max(64 * 1024) so a 2 GB JSON body cannot exhaust memory before validation runs.",
        },
        {
          h: "Authorization is a separate check from authentication",
          p: [
            "Authentication answers who is calling; authorization answers whether this caller may touch this specific row. The classic failure is object-level: the token is valid, the route is protected, and the handler still trusts a tenant or user id from the request body.",
            "Take identity from verified claims only, check ownership on every object, and return 404 rather than 403 when the object exists but belongs to someone else. A 403 confirms existence and turns your endpoint into an enumeration oracle.",
          ],
          code: `#[derive(Debug, Clone)]
pub struct Claims {
    pub user_id: UserId,
    pub tenant: TenantId,
    pub scope: Scope,
}

pub fn authorize_invoice(claims: &Claims, invoice_tenant: TenantId) -> Result<(), AuthzError> {
    // Tenant comes from the token, never from the path, query or body.
    if claims.tenant != invoice_tenant {
        return Err(AuthzError::NotFound);
    }
    if !claims.scope.allows("invoices:write") {
        return Err(AuthzError::Forbidden);
    }
    Ok(())
}

// At the query layer, the tenant predicate is not optional:
// SELECT ... FROM invoices WHERE id = $1 AND tenant_id = $2`,
          tip:
            "Make the tenant part of the query builder's constructor rather than an optional filter. If a handler physically cannot call the repository without a tenant, IDOR bugs stop being a code-review problem.",
        },
        {
          h: "Security headers and a CORS policy you can defend",
          p: [
            "Browsers enforce a large part of your security posture through response headers. HSTS prevents downgrade for returning visitors, X-Content-Type-Options stops MIME sniffing, a restrictive Content-Security-Policy blocks injected script, and frame-ancestors blocks clickjacking. Set them on every response, including errors.",
            "CORS is not authentication. A wildcard origin with credentials is ignored by browsers, but a wildcard without credentials still lets any site read unauthenticated responses. Allowlist exact origins, methods and headers, and keep max-age short enough that an origin removal takes effect promptly.",
          ],
          code: `use axum::http::{header, HeaderValue, Method};
use tower_http::{cors::CorsLayer, set_header::SetResponseHeaderLayer};

let security_headers = tower::ServiceBuilder::new()
    .layer(SetResponseHeaderLayer::overriding(
        header::STRICT_TRANSPORT_SECURITY,
        HeaderValue::from_static("max-age=63072000; includeSubDomains"),
    ))
    .layer(SetResponseHeaderLayer::overriding(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    ))
    .layer(SetResponseHeaderLayer::overriding(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'"),
    ));

let cors = CorsLayer::new()
    .allow_origin("https://app.example.com".parse::<HeaderValue>().unwrap())
    .allow_methods([Method::GET, Method::POST])
    .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
    .max_age(std::time::Duration::from_secs(600));

let app = axum::Router::new()
    .route("/invoices", axum::routing::post(create_invoice))
    .layer(cors)
    .layer(security_headers);`,
          tip:
            "tower-http 0.7 needs the cors and set-header features. Security headers belong on the router, not on individual handlers, or the one handler you forget becomes the finding in the audit.",
        },
        {
          h: "SQL injection is a formatting bug",
          p: [
            "Injection happens when user input becomes SQL syntax. Bound parameters keep values as values no matter what they contain, and sqlx's query! macro additionally checks the statement against the live schema at compile time, so a renamed column fails the build rather than production.",
            "Identifiers cannot be bound: ORDER BY, column names, table names and direction must come from a server-side allowlist. This is the only place string building in SQL is acceptable, and even there it should be a match over a fixed set.",
          ],
          code: `// BAD: the id is interpolated into SQL
let sql = format!("SELECT * FROM invoices WHERE id = '{id}'");

// GOOD: bound parameters, verified against migrations at compile time
let invoice = sqlx::query_as!(
    Invoice,
    r#"SELECT id, tenant_id, amount_cents FROM invoices WHERE id = $1 AND tenant_id = $2"#,
    invoice_id,
    tenant_id,
)
.fetch_optional(&pool)
.await?;

// Identifiers come from an allowlist, never from the request
let order_by = match sort.as_str() {
    "created_at" => "created_at",
    "amount_cents" => "amount_cents",
    _ => return Err(ApiError::BadRequest("invalid sort")),
};`,
          tip:
            "sqlx 0.9's query! macro needs a live database or a prepared .sqlx cache (cargo sqlx prepare) in CI. Commit that cache, otherwise builds fail in the pipeline with no database available.",
        },
      ],
      exercise: {
        prompt:
          "Implement validate and authorize as pure functions with assertions: an email must contain @ and fit in 254 chars, an amount must be in 1..=100_000_000, and an object from another tenant must return NotFound, not Forbidden.",
        starter: `#[derive(Debug, PartialEq)]
enum Denied {
    InvalidEmail,
    InvalidAmount,
    Forbidden,
    NotFound,
}

fn validate(email: &str, amount_cents: u64) -> Result<(), Denied> {
    // TODO
    todo!()
}

fn authorize(token_tenant: &str, scope: &str, object_tenant: &str) -> Result<(), Denied> {
    // TODO: cross-tenant access is NotFound; missing scope is Forbidden
    todo!()
}

fn main() {
    assert_eq!(validate("a@b.co", 500), Ok(()));
    assert_eq!(authorize("acme", "invoices:write", "globex"), Err(Denied::NotFound));
    println!("checks passed");
}`,
        hint:
          "Check tenant mismatch before scope: an attacker with a read scope should not learn that another tenant's invoice exists, and the ordering is what encodes that decision.",
        solution: `#[derive(Debug, PartialEq)]
enum Denied {
    InvalidEmail,
    InvalidAmount,
    Forbidden,
    NotFound,
}

fn validate(email: &str, amount_cents: u64) -> Result<(), Denied> {
    if email.len() > 254 || !email.contains('@') {
        return Err(Denied::InvalidEmail);
    }
    if amount_cents == 0 || amount_cents > 100_000_000 {
        return Err(Denied::InvalidAmount);
    }
    Ok(())
}

fn authorize(token_tenant: &str, scope: &str, object_tenant: &str) -> Result<(), Denied> {
    if token_tenant != object_tenant {
        return Err(Denied::NotFound); // do not confirm that the object exists
    }
    if scope != "invoices:write" {
        return Err(Denied::Forbidden);
    }
    Ok(())
}

fn main() {
    assert_eq!(validate("a@b.co", 500), Ok(()));
    assert_eq!(validate("nope", 500), Err(Denied::InvalidEmail));
    assert_eq!(validate("a@b.co", 0), Err(Denied::InvalidAmount));
    assert_eq!(authorize("acme", "invoices:write", "acme"), Ok(()));
    assert_eq!(authorize("acme", "invoices:write", "globex"), Err(Denied::NotFound));
    assert_eq!(authorize("acme", "invoices:read", "acme"), Err(Denied::Forbidden));
    println!("all validation and authorization checks passed");
}`,
      },
      questions: [
        {
          q: "A caller authenticated in tenant A requests an invoice id that belongs to tenant B. Which response is correct?",
          options: [
            "403 Forbidden, so the caller learns the object exists but is not theirs",
            "404 Not Found, so the response does not confirm that the object exists",
            "401 Unauthorized, to force re-authentication",
            "200 with an empty body, to avoid leaking anything",
          ],
          answer: 1,
          explain:
            "Cross-tenant access is indistinguishable from a missing row. A 403 turns the endpoint into an enumeration oracle that confirms which ids are real, which is exactly the information an attacker needs to script a breach of a neighbouring tenant.",
        },
        {
          q: "You need a user-selected ORDER BY column. What is the safe construction?",
          options: [
            "Bind it as $1, because the driver escapes identifiers",
            "Escape single quotes by doubling them, then interpolate the value",
            "Match the input against a fixed server-side allowlist and interpolate the matched constant",
            "URL-encode the value before it reaches the query builder",
          ],
          answer: 2,
          explain:
            "Parameters bind values, not syntax: a placeholder cannot stand in for a column name, table or sort direction. The only safe pattern is a match over a fixed set of literals, so arbitrary input never becomes SQL structure and an invalid sort is a 400.",
        },
      ],
      production: [
        "Every handler deserializes into a deny_unknown_fields struct and validates ranges and lengths before touching storage",
        "Authorization checks resource ownership on every request; tenant and user ids from the body or query are ignored",
        "CORS uses an explicit origin allowlist and is never combined with wildcard origins plus credentials",
        "Responses set HSTS, CSP, X-Content-Type-Options and Referrer-Policy; errors never echo SQL, stack traces or paths",
        "SQL uses bound parameters or compile-time-checked macros; ORDER BY and identifiers come from a server allowlist",
      ],
      crates: ["axum", "tower-http", "sqlx", "serde", "tracing"],
      pitfall:
        "Trusting a tenant id from the request body: an authenticated user changes tenant_id and reads another customer's invoices. Tenant identity must come from the verified token and be enforced inside the WHERE clause.",
      quickbytes: [
        "axum: .layer(DefaultBodyLimit::max(64 * 1024)) caps the body before serde allocates it; there is no useful default.",
        "curl -sI https://api.example.com | grep -Ei 'strict-transport|content-security|x-content-type' - headers must also be on errors.",
        "A 422 for a semantically invalid body and a 400 for malformed JSON; a validation failure that returns 500 pages the wrong team.",
      ],
      github: [
        {
          name: "transact-rs/sqlx",
          url: "https://github.com/transact-rs/sqlx",
        },
        {
          name: "tower-rs/tower-http",
          url: "https://github.com/tower-rs/tower-http",
        },
      ],
      resources: [
        {
          title: "sqlx: compile-time checked queries and pools",
          url: "https://docs.rs/sqlx/latest/sqlx/",
          kind: "docs",
        },
        {
          title: "tower-http CORS middleware",
          url: "https://docs.rs/tower-http/latest/tower_http/cors/index.html",
          kind: "docs",
        },
        {
          title: "tower-http response header middleware",
          url: "https://docs.rs/tower-http/latest/tower_http/set_header/index.html",
          kind: "docs",
        },
        {
          title: "transact-rs/sqlx repository and examples",
          url: "https://github.com/transact-rs/sqlx",
          kind: "repo",
        },
        {
          title: "OWASP channel: injection, access control and API security",
          url: "https://www.youtube.com/@OWASPGLOBAL",
          kind: "video",
        },
      ],
    },
    {
      id: "g05",
      title: "Docker packaging: multi-stage, cargo-chef, distroless",
      minutes: 70,
      level: "industry",
      goal:
        "Build a small, reproducible, non-root image: multi-stage layers that cache dependencies, a runtime stage with no toolchain, and a size budget you track.",
      sections: [
        {
          h: "Multi-stage builds keep the toolchain out of production",
          p: [
            "A single-stage Dockerfile that runs cargo build in the final image ships rustc, the crate registry and a full Debian userland, which is a 1.5 GB attack surface for a 20 MB binary. Multi-stage builds separate compilation from runtime: the builder stage has the toolchain, the runtime stage has the binary.",
            "Layer order is the other half. Docker caches each layer until its inputs change, so copying the source before fetching dependencies invalidates the expensive layer on every commit. Copy the manifests and lockfile first, build, then copy the source.",
          ],
          code: `# The expensive, frequently invalidated single-stage version.
FROM rust:1-bookworm
WORKDIR /app
COPY . .                 # any source change invalidates everything below
RUN cargo build --release
CMD ["/app/target/release/api"]`,
          tip:
            "Pin the builder by digest (rust:1-bookworm@sha256:...) when reproducibility matters. A moving tag means two builds of the same commit can produce different binaries.",
        },
        {
          h: "cargo-chef: cache dependency compilation properly",
          p: [
            "cargo-chef splits the build into a recipe step that depends only on Cargo.toml files and Cargo.lock, and a cook step that compiles every dependency. Source changes then recompile only your crates, which is the difference between a 30-second and a 15-minute pipeline.",
            "The planner stage copies the workspace and produces recipe.json. The builder stage copies that one file, runs cook, and only then copies the real source. Keep the runtime stage separate and copy exactly one binary out of it.",
          ],
          code: `# syntax=docker/dockerfile:1
FROM rust:1-bookworm AS chef
WORKDIR /app
RUN cargo install cargo-chef --locked

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json
COPY . .
RUN cargo build --release --locked --bin ledger-api

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=builder /app/target/release/ledger-api /usr/local/bin/ledger-api
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/ledger-api"]`,
          tip:
            "Add a .dockerignore with target, .git, .github, docs and test fixtures. Without it, COPY . . ships your local target directory into the build context and invalidates the recipe layer every time.",
        },
        {
          h: "Runtime stage: distroless, non-root, no shell",
          p: [
            "Distroless cc-debian12 contains glibc, CA certificates and tzdata and nothing else, which is enough for a dynamically linked Rust binary and too little for an attacker to pivot with. The nonroot tag already runs as UID 65532, and an explicit USER documents the intent even when the tag implies it.",
            "Strip symbols in the release profile instead of shipping them. Keep the stripped binary and the separate debug file as build artifacts: you want the symbols when you read a core dump, just not inside the image.",
          ],
          code: `# Cargo.toml
[profile.release]
lto = "thin"
codegen-units = 1
panic = "abort"
strip = "symbols"

# Rough runtime-stage sizes, uncompressed, for a ~15 MB Rust binary:
#   debian:bookworm-slim   ~75 MB   (needs apt for anything, has a shell)
#   distroless cc-debian12 ~25 MB   (glibc + certs, no shell)
#   scratch + musl         ~15 MB   (you must copy CA certs yourself)`,
          tip:
            "Distroless has no shell, so kubectl exec sh and HEALTHCHECK curl do not exist. Use Kubernetes probes against your own /livez endpoint instead of container health checks.",
        },
        {
          h: "Static musl, build caches and the size budget",
          p: [
            "scratch is the smallest possible base, but it requires a fully static binary: build for x86_64-unknown-linux-musl and copy /etc/ssl/certs/ca-certificates.crt yourself, or TLS verification fails at runtime. musl also uses a different allocator and DNS resolver, so benchmark under real concurrency before committing to it.",
            "For BuildKit builds, cache mounts keep the cargo registry and target directory between builds without storing them in a layer. The target cache mount is not part of the image, so anything you need to COPY out must be copied to a stable path inside the same RUN step.",
          ],
          code: `RUN --mount=type=cache,target=/usr/local/cargo/registry \\
    --mount=type=cache,target=/app/target \\
    cargo build --release --locked --bin ledger-api \\
 && cp /app/target/release/ledger-api /app/ledger-api

# Multi-arch build with a registry cache shared between CI runs
docker buildx build \\
  --platform linux/amd64,linux/arm64 \\
  --cache-from type=registry,ref=ghcr.io/acme/ledger-api:buildcache \\
  --cache-to type=registry,ref=ghcr.io/acme/ledger-api:buildcache,mode=max \\
  -t ghcr.io/acme/ledger-api:1.12.0 --push .`,
          tip:
            "Track image size in CI: docker image inspect --format '{{.Size}}' and fail above a documented budget. Rust images creep up when a dependency switches to a heavier TLS stack.",
        },
      ],
      exercise: {
        prompt:
          "Write a Dockerfile for a workspace with two binaries (ledger-api and ledger-migrate) that caches dependencies with cargo-chef, builds with --locked, and ships both binaries as non-root in a distroless image.",
        starter: `# TODO: chef -> planner -> builder -> runtime
FROM rust:1-bookworm AS chef
WORKDIR /app
# TODO: install cargo-chef, prepare recipe, cook, copy source, build both bins
# TODO: runtime stage must be distroless and non-root`,
        hint:
          "cargo chef prepare --recipe-path recipe.json belongs in a planner stage; cargo chef cook --release --recipe-path recipe.json belongs before COPY . . in the builder; both binaries are copied from /app/target/release.",
        solution: `# syntax=docker/dockerfile:1
FROM rust:1-bookworm AS chef
WORKDIR /app
RUN cargo install cargo-chef --locked

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json
COPY . .
RUN cargo build --release --locked --bin ledger-api --bin ledger-migrate

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=builder /app/target/release/ledger-api /usr/local/bin/ledger-api
COPY --from=builder /app/target/release/ledger-migrate /usr/local/bin/ledger-migrate
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/ledger-api"]

# Build and inspect:
#   docker build -t ledger-api:dev .
#   docker run --rm ledger-api:dev --version
#   docker image inspect ledger-api:dev --format '{{.Size}}'`,
      },
      questions: [
        {
          q: "You want the smallest possible runtime image and accept the musl trade-offs. Which base wins?",
          options: [
            "A single-stage rust:1-bookworm image that keeps the toolchain",
            "debian:bookworm-slim with the release binary copied in",
            "scratch with a fully static musl binary and CA certificates copied in",
            "distroless cc-debian12 with the dynamically linked binary",
          ],
          answer: 2,
          explain:
            "Uncompressed the order is roughly 1.5 GB, 75 MB, 25 MB, 15 MB. scratch ships nothing, so the binary must be statically linked and you must copy ca-certificates.crt yourself or every TLS call fails; musl also swaps the allocator and DNS resolver, so re-benchmark.",
        },
        {
          q: "What does `cargo build --release --locked` actually guarantee in CI?",
          options: [
            "Every dependency has been checked against RustSec advisories",
            "Cargo.lock is not modified: if the manifest and lockfile disagree the build fails instead of resolving something new",
            "Only registry crates are compiled, never git dependencies",
            "The output binary is bit-for-bit reproducible across machines",
          ],
          answer: 1,
          explain:
            "--locked turns a stale lockfile into a build error rather than a silent resolution. It says nothing about advisories (cargo-audit), sources (cargo deny) or reproducibility, which needs pinned base digests, a pinned toolchain and a fixed build path.",
        },
      ],
      production: [
        "The final image contains only the binary and CA certificates: no rustc, cargo, git, package manager or shell",
        "Base images are pinned by digest and rebuilt weekly to pick up base OS security patches",
        "Builds use --locked so the CI image cannot silently resolve a different dependency graph than the one tested",
        "Images are scanned (Trivy or Grype) in CI, and a HIGH or CRITICAL finding blocks the release",
        "Image size is measured per commit against a documented budget, so creep shows up in review instead of on release day",
      ],
      crates: ["cargo-chef"],
      pitfall:
        "Copying the whole repository before cargo build: any source change invalidates the dependency layer, so every CI run recompiles the entire dependency graph and the pipeline takes twenty minutes instead of two.",
      quickbytes: [
        "Order: COPY Cargo.toml Cargo.lock, cargo chef cook --release, then COPY src, then cargo build --locked --release.",
        "Add .dockerignore with target/, .git, .github and fixtures; COPY . . otherwise ships your local target dir and busts the recipe layer.",
        "docker image inspect ledger-api:1.12.0 --format '{{.Size}}' in CI, and fail the job above the documented byte budget.",
      ],
      github: [
        {
          name: "LukeMathWalker/cargo-chef",
          url: "https://github.com/LukeMathWalker/cargo-chef",
        },
        {
          name: "GoogleContainerTools/distroless",
          url: "https://github.com/GoogleContainerTools/distroless",
        },
      ],
      resources: [
        {
          title: "Docker docs: multi-stage builds",
          url: "https://docs.docker.com/build/building/multi-stage/",
          kind: "docs",
        },
        {
          title: "cargo-chef: dependency layer caching",
          url: "https://github.com/LukeMathWalker/cargo-chef",
          kind: "repo",
        },
        {
          title: "cargo-chef on crates.io",
          url: "https://crates.io/crates/cargo-chef",
          kind: "docs",
        },
        {
          title: "distroless: minimal runtime bases without a shell",
          url: "https://github.com/GoogleContainerTools/distroless",
          kind: "repo",
        },
        {
          title: "CNCF channel: container builds, signing and supply chain",
          url: "https://www.youtube.com/@CNCF",
          kind: "video",
        },
      ],
    },
    {
      id: "g06",
      title: "Kubernetes runtime: probes, limits, drain, HPA",
      minutes: 80,
      level: "industry",
      goal:
        "Run the service correctly on Kubernetes: three probes with the right semantics, requests and limits sized from measurement, graceful SIGTERM drain, and autoscaling that reacts to real load.",
      sections: [
        {
          h: "Three probes, three different questions",
          p: [
            "A startup probe asks whether the process has finished booting; a readiness probe asks whether it should receive traffic; a liveness probe asks whether the process is still able to make progress. Pointing all three at the same endpoint is the most common way to turn a dependency blip into a restart storm.",
            "Liveness must never touch a dependency. If Postgres is down, your process is still healthy and should keep serving queued work or returning 503; restarting every replica makes the outage worse and destroys in-flight requests.",
          ],
          code: `containers:
  - name: ledger-api
    image: ghcr.io/acme/ledger-api:1.12.0
    ports:
      - { name: http, containerPort: 8080 }
    startupProbe:
      httpGet: { path: /livez, port: http }
      periodSeconds: 2
      failureThreshold: 30        # boot budget: up to 60 s
    readinessProbe:
      httpGet: { path: /readyz, port: http }
      periodSeconds: 5
      failureThreshold: 2         # stops receiving traffic after ~10 s
    livenessProbe:
      httpGet: { path: /livez, port: http }
      periodSeconds: 10
      failureThreshold: 3         # restart after ~30 s of a wedged process`,
          tip:
            "Readiness should fail when the instance cannot serve correctly: migrations not applied, connection pool exhausted, or shutting down. It should pass while a dependency is degraded if your handlers still return useful 503s.",
        },
        {
          h: "Requests, limits and the OOM killer",
          p: [
            "Requests are what the scheduler reserves; limits are what the kernel enforces. Exceeding a memory limit triggers the OOM killer (exit code 137), while exceeding a CPU limit triggers CFS throttling, which shows up as latency tail with no CPU saturation on the dashboard.",
            "Measure the release binary under production-shaped load, then set the memory request near the observed steady state and the limit at peak plus headroom. For Rust services it is often better to set a memory limit and omit a CPU limit, relying on requests plus HPA to bound CPU contention.",
          ],
          code: `resources:
  requests:
    cpu: 250m
    memory: 256Mi
  limits:
    memory: 512Mi
    # No CPU limit: CFS throttling adds p99 latency without
    # protecting any neighbour that requests are not already protecting.

# QoS classes:
#   Guaranteed  -> requests == limits for every container (last to be evicted)
#   Burstable   -> requests < limits (this example)
#   BestEffort  -> no requests or limits (first to be evicted)`,
          tip:
            "Watch container_memory_working_set_bytes against the limit, not container_memory_usage_bytes. The working set is what the OOM killer looks at, and page cache inflates the usage number in a way that causes pointless limit increases.",
        },
        {
          h: "Graceful termination is a race with the endpoint controller",
          p: [
            "On delete, the endpoint controller removes the pod from Service endpoints asynchronously while kubelet already starts termination. If your process exits immediately on SIGTERM, requests routed to it during that window get connection resets, which users see as sporadic 502s during every deploy.",
            "The fix is to keep serving after SIGTERM while readiness fails, wait long enough for endpoint propagation, then drain in-flight requests before exiting. With a distroless image there is no shell and no sleep binary for a preStop hook, so the delay belongs in the application.",
          ],
          code: `use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::signal;

pub static READY: AtomicBool = AtomicBool::new(false);

async fn shutdown() {
    let ctrl_c = async { signal::ctrl_c().await.expect("ctrl_c handler") };
    #[cfg(unix)]
    let term = async {
        let mut s = signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("sigterm handler");
        s.recv().await;
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();

    tokio::select! { _ = ctrl_c => {}, _ = term => {} }

    READY.store(false, Ordering::Release);          // readiness now fails
    tracing::info!("SIGTERM received: draining");
    tokio::time::sleep(Duration::from_secs(5)).await; // endpoint propagation
}

// axum::serve(listener, app).with_graceful_shutdown(shutdown()).await?;`,
          tip:
            "Budget the timings explicitly: 5 s propagation delay plus a drain cap under terminationGracePeriodSeconds (30 s), so the process always exits before SIGKILL arrives.",
        },
        {
          h: "HPA, ConfigMaps and Secrets in practice",
          p: [
            "The HorizontalPodAutoscaler needs metrics-server for CPU and a custom metrics adapter for request-rate scaling. CPU utilization targets work well for CPU-bound handlers; for IO-bound services, scale on in-flight requests or queue depth, because CPU stays flat while latency explodes.",
            "A ConfigMap or Secret volume updates inside the pod eventually, but nothing restarts and the process keeps its parsed copy. Treat config as immutable per rollout: checksum annotation on the pod template or an explicit kubectl rollout restart, plus a PodDisruptionBudget so a rollout or node drain cannot take the whole fleet at once.",
          ],
          code: `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ledger-api
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ledger-api
  minReplicas: 2
  maxReplicas: 20
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 65`,
          tip:
            "Set minReplicas to at least 2 in different zones and add a PodDisruptionBudget with maxUnavailable: 1. A single-replica deployment cannot survive a node drain, no matter how good the probes are.",
        },
      ],
      exercise: {
        prompt:
          "Write the Deployment container spec for a service that boots in up to 45 seconds: startup, readiness and liveness probes with consistent thresholds, resource requests and limits, and a 30-second termination budget.",
        starter: `containers:
  - name: ledger-api
    image: ghcr.io/acme/ledger-api:1.12.0
    ports:
      - { name: http, containerPort: 8080 }
    # TODO: startupProbe with a boot budget >= 45 s
    # TODO: readinessProbe against /readyz, livenessProbe against /livez
    # TODO: resources requests+limits, terminationGracePeriodSeconds: 30`,
        hint:
          "Startup failureThreshold * periodSeconds must cover 45 s, for example 30 * 2s. Liveness failureThreshold 3 * periodSeconds 10 gives a 30 s restart budget without flapping.",
        solution: `spec:
  terminationGracePeriodSeconds: 30
  containers:
    - name: ledger-api
      image: ghcr.io/acme/ledger-api:1.12.0
      ports:
        - { name: http, containerPort: 8080 }
      startupProbe:
        httpGet: { path: /livez, port: http }
        periodSeconds: 2
        failureThreshold: 30        # 60 s boot budget covers a 45 s worst case
      readinessProbe:
        httpGet: { path: /readyz, port: http }
        periodSeconds: 5
        failureThreshold: 2
      livenessProbe:
        httpGet: { path: /livez, port: http }
        periodSeconds: 10
        failureThreshold: 3
      resources:
        requests:
          cpu: 250m
          memory: 256Mi
        limits:
          memory: 512Mi

# Verify after apply:
#   kubectl rollout status deployment/ledger-api
#   kubectl get pods -o custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[0].ready`,
      },
      questions: [
        {
          q: "The liveness probe hits /livez, which runs `SELECT 1` against Postgres. Postgres blips for ten seconds. What happens?",
          options: [
            "Pods stay ready and their handlers return 503 until the database recovers",
            "Every replica fails liveness at once and Kubernetes restarts the whole fleet",
            "Only the pod holding the leader lease is restarted",
            "The Deployment is marked failed and the rollout is rolled back",
          ],
          answer: 1,
          explain:
            "Liveness must only ask whether this process can still make progress. A dependency check converts a shared database blip into a synchronised restart storm: every replica fails within the same probe window, destroying in-flight requests and adding cold starts to an already degraded system.",
        },
        {
          q: "A pod is OOMKilled at a 512Mi limit. Which metric should you compare against the limit before changing anything?",
          options: [
            "container_memory_usage_bytes, including page cache",
            "container_memory_working_set_bytes",
            "container_cpu_cfs_throttled_seconds_total",
            "kube_pod_container_status_restarts_total",
          ],
          answer: 1,
          explain:
            "The OOM killer acts on the working set, not total usage: page cache inflates usage and makes a healthy pod look close to the limit, which is how limits get raised for no reason. Working set growth also tells you whether the leak is real before you spend memory.",
        },
      ],
      production: [
        "Startup probe covers worst-case boot time; liveness checks only the process and its event loop, never a dependency",
        "Memory limits are set from measured peak plus headroom and verified under load, so OOMKilled is treated as a sizing bug",
        "SIGTERM flips readiness off, waits for endpoint propagation, drains in-flight requests and exits before the grace period",
        "HPA targets 60-70 percent CPU with minReplicas of at least 2 and a PodDisruptionBudget allowing one disruption",
        "ConfigMap and Secret changes trigger a rollout via checksum annotation or kubectl rollout restart; no pod runs stale config",
      ],
      crates: ["axum", "tokio"],
      pitfall:
        "Pointing the liveness probe at an endpoint that queries Postgres: a ten-second database blip fails liveness on every replica at once, Kubernetes restarts the entire fleet, and a degraded read path becomes a restart storm.",
      quickbytes: [
        "kubectl get pod ledger-api-0 -o jsonpath='{.status.containerStatuses[0].lastState.terminated.exitCode}' - 137 means OOMKilled, not a crash.",
        "startupProbe 2s x 30 covers a 60s boot; liveness 10s x 3; readiness 5s x 2 so a bad instance leaves the endpoints in ~10s.",
        "terminationGracePeriodSeconds: 30, flip readiness off, sleep 5s for endpoint propagation, then drain and exit before SIGKILL.",
      ],
      github: [
        {
          name: "kubernetes-sigs/metrics-server",
          url: "https://github.com/kubernetes-sigs/metrics-server",
        },
        {
          name: "tokio-rs/tokio",
          url: "https://github.com/tokio-rs/tokio",
        },
      ],
      resources: [
        {
          title: "Kubernetes: configure liveness, readiness and startup probes",
          url: "https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/",
          kind: "docs",
        },
        {
          title: "Kubernetes Secrets",
          url: "https://kubernetes.io/docs/concepts/configuration/secret/",
          kind: "docs",
        },
        {
          title: "Tokio: graceful shutdown",
          url: "https://tokio.rs/tokio/topics/shutdown",
          kind: "docs",
        },
        {
          title: "Kubernetes: requests, limits and QoS classes",
          url: "https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/",
          kind: "docs",
        },
        {
          title: "TechWorld with Nana: Kubernetes probes, HPA and deployments",
          url: "https://www.youtube.com/@TechWorldwithNana",
          kind: "video",
        },
      ],
    },
    {
      id: "g07",
      title: "CI/CD and software supply chain",
      minutes: 85,
      level: "industry",
      goal:
        "Build a pipeline that gates correctness, advisories and licenses before release, cross-compiles the binaries, and publishes artifacts with checksums and an SBOM.",
      sections: [
        {
          h: "A pipeline gates; it does not decorate",
          p: [
            "Ordering is the design: cheap checks first, expensive builds last, and nothing publishes until every gate passes. fmt and clippy take seconds and catch the mistakes a reviewer would otherwise spend attention on; tests take minutes; audit, deny and cross-builds take the longest.",
            "Cache correctly or the pipeline lies. A cache key must include Cargo.lock, the toolchain channel and the target triple; a stale target directory can make a build succeed on artifacts that no longer compile from scratch.",
          ],
          list: [
            "Gate 1: cargo fmt --check and cargo clippy -- -D warnings, no exceptions for new code.",
            "Gate 2: cargo test --workspace --all-features, with the same profile CI will release.",
            "Gate 3: cargo audit for advisories and cargo deny check for licenses, sources and duplicate bans.",
            "Gate 4: cross-compiled release build, smoke-tested with --version before upload.",
            "Gate 5: SBOM generation and artifact attestation, then release.",
          ],
          tip:
            "Run the same three commands locally in a pre-push hook. A 30-second local loop beats a 20-minute CI round trip, and CI becomes the enforcement point instead of the debugging tool.",
        },
        {
          h: "The workflow",
          p: [
            "Pin the runner image, grant the minimum permissions, cancel superseded runs, and let the cache provider do the heavy lifting. The job below is the shape most Rust services need before they need anything more elaborate.",
            "Keep releases in a separate job that only runs on tags and only after the gates pass. A workflow that can publish from a feature branch is one typo away from shipping unreviewed code.",
          ],
          code: `name: ci
on:
  push:
    branches: [main]
    tags: ["v*"]
  pull_request:
permissions:
  contents: read
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt, clippy
      - uses: Swatinem/rust-cache@v2
      - run: cargo fmt --all --check
      - run: cargo clippy --workspace --all-targets --all-features -- -D warnings
      - run: cargo test --workspace --all-features

  supply-chain:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: EmbarkStudios/cargo-deny-action@v2
      - run: cargo install --locked cargo-audit && cargo audit
      - run: cargo install --locked cargo-cyclonedx && cargo cyclonedx --format json
      - uses: actions/upload-artifact@v4
        with:
          name: sbom
          path: "**/*.cdx.json"`,
          tip:
            "actions/checkout@v4, dtolnay/rust-toolchain@stable, Swatinem/rust-cache@v2, cargo-deny-action@v2 and upload-artifact@v4 are the current majors. Pin third-party actions to a commit SHA when your threat model includes tag rewriting.",
        },
        {
          h: "Cross-compilation and release artifacts",
          p: [
            "Static musl binaries run on any Linux without matching glibc, which is what you want for a scratch or distroless image and for artifact users on unknown distros. Build both x86_64 and aarch64 in a matrix; aarch64 is the cheap half of your cloud bill.",
            "cross wraps cargo with a containerised toolchain that provides the linker and sysroot per target, which is far less fragile than hand-installing GCC cross toolchains. cargo-zigbuild is a good alternative when you also need macOS or glibc-versioned targets.",
          ],
          code: `strategy:
  matrix:
    target: [x86_64-unknown-linux-musl, aarch64-unknown-linux-musl]

steps:
  - uses: actions/checkout@v4
  - uses: dtolnay/rust-toolchain@stable
    with:
      targets: \${{ matrix.target }}
  - run: cargo install --locked cross
  - run: cross build --release --locked --target \${{ matrix.target }}
  - run: ./target/\${{ matrix.target }}/release/ledger-api --version
  - run: sha256sum ./target/\${{ matrix.target }}/release/ledger-api > checksums.txt
  - uses: actions/upload-artifact@v4
    with:
      name: ledger-api-\${{ matrix.target }}
      path: |
        ./target/\${{ matrix.target }}/release/ledger-api
        checksums.txt`,
          tip:
            "Smoke-test the cross-compiled binary in the same job that builds it. Discovering at deploy time that a musl build cannot resolve its TLS root certificates is the expensive way to learn.",
        },
        {
          h: "Advisories, licenses and SBOM",
          p: [
            "cargo audit checks Cargo.lock against the RustSec advisory database; cargo deny additionally enforces a license allowlist, bans duplicate crate versions and restricts sources. Both belong in CI and both should fail the build, not warn into a log nobody reads.",
            "An SBOM lets a downstream consumer answer whether a CVE affects them without guessing. cargo-cyclonedx generates CycloneDX JSON from the lockfile, and cargo-auditable embeds the dependency list inside the binary itself so a running artifact can be audited offline.",
          ],
          code: `# deny.toml — start from cargo deny init, then tighten
[advisories]
ignore = []           # empty by default; every exception needs an owner and an expiry

[sources]
unknown-registry = "deny"
unknown-git = "deny"

# CI gates
cargo deny check
cargo audit
cargo cyclonedx --format json
cargo auditable build --release   # SBOM embedded in the binary`,
          tip:
            "Treat an ignored advisory like a production change: an owner, a ticket, an expiry date and a compensating control. A permanent ignore list is how an unpatched RCE survives four quarterly reviews.",
        },
      ],
      exercise: {
        prompt:
          "Harden the workflow: add a release job that runs only on v* tags, depends on the check and supply-chain jobs, builds with --locked, and uploads the binary plus a checksum and the SBOM.",
        starter: `name: release
on:
  push:
    tags: ["v*"]
jobs:
  # TODO: needs [check, supply-chain]
  # TODO: build --release --locked, checksum, upload SBOM as an artifact
  # TODO: fail if any gate job failed`,
        hint:
          "needs: [check, supply-chain] makes the release wait for both; a job that needs a failed job is skipped, not failed, so also require the tag pattern and use a single release job to keep ordering obvious.",
        solution: `name: release
on:
  push:
    tags: ["v*"]

permissions:
  contents: write

jobs:
  check:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: cargo fmt --all --check
      - run: cargo clippy --workspace --all-targets -- -D warnings
      - run: cargo test --workspace --all-features

  supply-chain:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - run: cargo install --locked cargo-audit cargo-deny
      - run: cargo audit
      - run: cargo deny check
      - run: cargo install --locked cargo-cyclonedx && cargo cyclonedx --format json
      - uses: actions/upload-artifact@v4
        with:
          name: sbom
          path: "**/*.cdx.json"

  release:
    needs: [check, supply-chain]
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: cargo build --release --locked --bin ledger-api
      - run: sha256sum target/release/ledger-api > ledger-api.sha256
      - uses: actions/upload-artifact@v4
        with:
          name: release
          path: |
            target/release/ledger-api
            ledger-api.sha256`,
      },
      questions: [
        {
          q: "Which gate order keeps a failing build cheap?",
          options: [
            "Cross-compile every target first, then run fmt and clippy on the result",
            "fmt and clippy, then tests, then audit and deny, then cross-builds, then publish",
            "Audit and publish in parallel, so users get artifacts while checks finish",
            "Run every job concurrently and publish from whichever finishes first",
          ],
          answer: 1,
          explain:
            "A gate that runs in seconds should fail before a gate that runs for twenty minutes, and nothing publishes until every gate passes. Fast checks first is not just ergonomics: it keeps the expensive runners from being the place where a missing semicolon is discovered.",
        },
        {
          q: "`cargo deny check` fails while `cargo audit` passes. What does that tell you?",
          options: [
            "A dependency has a known CVE that RustSec has not published yet",
            "A policy violation: a license outside the allowlist, a banned duplicate version, or a disallowed source",
            "Cargo.lock is out of date with Cargo.toml",
            "The crates.io registry could not be reached",
          ],
          answer: 1,
          explain:
            "The two tools answer different questions. cargo audit compares the lockfile with the RustSec advisory database; cargo deny additionally enforces your license allowlist, duplicate bans and source restrictions. A deny-only failure is a policy decision, so it needs a fix or a documented, owned exception.",
        },
      ],
      production: [
        "CI fails on fmt, clippy warnings, failing tests, advisories and license violations before any artifact is built",
        "Third-party actions are pinned to commit SHAs and updated by Dependabot or Renovate through reviewed pull requests",
        "Every release publishes a checksum, a CycloneDX SBOM and an attested artifact",
        "Cache keys include Cargo.lock, the toolchain channel and the target triple, and a clean build is verified periodically",
        "Cross-compiled binaries are smoke-tested (--version and an integration test) in the job that produces them",
      ],
      crates: ["cargo-audit", "cargo-deny", "cargo-cyclonedx", "cargo-auditable"],
      pitfall:
        "Caching target/ with a key that only names the branch: a stale or poisoned cache makes CI green on code that does not compile from scratch. Include Cargo.lock and the toolchain version, and run a nightly cold build to prove the cache is not load-bearing.",
      quickbytes: [
        "cargo clippy --workspace --all-targets --all-features -- -D warnings takes seconds; make it gate before the twenty-minute cross-build.",
        "Cache key = Cargo.lock hash + toolchain channel + target triple, and keep a nightly cold build that ignores the cache entirely.",
        "cargo cyclonedx --format json for the artifact, cargo auditable build --release so the shipped binary carries its own dependency list.",
      ],
      github: [
        {
          name: "EmbarkStudios/cargo-deny",
          url: "https://github.com/EmbarkStudios/cargo-deny",
        },
        {
          name: "rustsec/rustsec",
          url: "https://github.com/rustsec/rustsec",
        },
      ],
      resources: [
        {
          title: "GitHub Actions dependency caching reference",
          url: "https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching",
          kind: "docs",
        },
        {
          title: "cargo-audit: audit Cargo.lock against RustSec",
          url: "https://docs.rs/cargo-audit/latest/cargo_audit/",
          kind: "docs",
        },
        {
          title: "cargo-deny: licenses, bans, advisories, sources",
          url: "https://docs.rs/cargo-deny/latest/cargo_deny/",
          kind: "docs",
        },
        {
          title: "cargo-cyclonedx: CycloneDX SBOM for Rust",
          url: "https://docs.rs/cargo-cyclonedx/latest/cargo_cyclonedx/",
          kind: "docs",
        },
        {
          title: "GitHub channel: Actions, artifact attestations and supply chain",
          url: "https://www.youtube.com/@GitHub",
          kind: "video",
        },
      ],
    },
    {
      id: "g08",
      title: "Performance engineering: bench, profile, load test",
      minutes: 95,
      level: "industry",
      goal:
        "Replace guesses with measurements: criterion benchmarks with a saved baseline, flamegraphs and pprof from release builds, load tests that find the knee, and the async pitfalls that destroy p99.",
      sections: [
        {
          h: "Set a budget before you profile",
          p: [
            "Performance work without a target becomes endless micro-optimization. Write the budget down per route: for example p99 under 250 ms at 200 requests per second with a 1 percent error rate. Then measure whether you are inside it, and only then ask where the time goes.",
            "Microbenchmarks and load tests answer different questions. criterion measures a function in a controlled process; a load test measures the whole system including the pool, the runtime and the kernel. Quote the right one for the claim you are making.",
          ],
          list: [
            "Latency budget: p50, p95 and p99 per route, in milliseconds, checked against production histograms.",
            "Throughput budget: requests per second per replica at the CPU request you actually allocate.",
            "Resource budget: memory per replica at peak, and the allocation rate per request.",
            "Regression policy: more than 10 percent slower on the stored baseline fails the pull request.",
          ],
          tip:
            "Little's law connects the numbers: concurrency equals throughput times latency. If p99 doubles at constant traffic, the in-flight request count doubles too, and pool exhaustion is the next thing you will see.",
        },
        {
          h: "Criterion: microbenchmarks that survive review",
          p: [
            "A benchmark that is not statistically honest is worse than no benchmark. criterion warms up, samples repeatedly, reports confidence intervals and compares against a stored baseline, which is what lets you claim a 12 percent improvement without being laughed out of review.",
            "Use std::hint::black_box on inputs and outputs. criterion 0.8 deprecated its own re-export in favour of the standard library one, and without it LLVM will happily delete or hoist the work you are trying to measure.",
          ],
          code: `use criterion::{criterion_group, criterion_main, Criterion, Throughput};
use std::hint::black_box;

fn parse_query(input: &str) -> Vec<(String, String)> {
    input
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn bench_parse(c: &mut Criterion) {
    let input = "user_id=42&name=ferris&plan=pro&region=eu-west-1";
    let mut group = c.benchmark_group("parse_query");
    group.throughput(Throughput::Bytes(input.len() as u64));
    group.bench_function("happy_path", |b| {
        b.iter(|| parse_query(black_box(input)))
    });
    group.finish();
}

criterion_group!(benches, bench_parse);
criterion_main!(benches);`,
          tip:
            "Cargo.toml: criterion 0.8 under [dev-dependencies] and [[bench]] name = \"parse_query\", harness = false. Run cargo bench -- --save-baseline main once, then cargo bench -- --baseline main to compare.",
        },
        {
          h: "Profiling: flamegraph and in-process pprof",
          p: [
            "A flamegraph answers which call stacks consume CPU, sampled across the process. Build with a release profile that keeps symbols (debug = 1 or split debuginfo) and profile that binary; a profile of a debug build is a profile of code you do not ship.",
            "cargo flamegraph wraps perf and needs perf_event access on Linux. When you cannot get it, or you need a profile from inside a running service on demand, the pprof crate samples in-process and writes an SVG flamegraph you can attach to an incident ticket.",
          ],
          code: `// Cargo.toml: pprof = { version = "0.15", features = ["flamegraph"] }
use pprof::ProfilerGuardBuilder;

fn profile_workload() {
    let guard = ProfilerGuardBuilder::default()
        .frequency(997)                       // prime, avoids lockstep sampling
        .blocklist(&["libc", "libgcc", "pthread", "vdso"])
        .build()
        .expect("start profiler");

    run_workload();                       // the code under investigation

    let report = guard.report().build().expect("build report");
    let file = std::fs::File::create("flamegraph.svg").expect("create svg");
    report.flamegraph(file).expect("write flamegraph");
}

// Shell:
//   cargo install flamegraph
//   sudo sysctl kernel.perf_event_paranoid=1   # or grant CAP_PERFMON
//   cargo flamegraph --release --bin ledger-api -- --port 8080`,
          tip:
            "Flamegraphs are sampled, so a frame that looks hot may be the caller of a hot function. Read width as total time in that stack, and look for the widest frame that is not a generic inlining wrapper.",
        },
        {
          h: "Load testing, allocations and async traps",
          p: [
            "A load test ramps concurrency until latency leaves the budget or errors appear: that knee is the real capacity of one replica, and it is usually far below the CPU limit. Record latency percentiles, error rate and resource usage together, or you will optimize the wrong axis.",
            "Once throughput is the problem rather than CPU, look at allocations. dhat records every allocation with a stack and shows whether you are allocating per request, per row or per log line. In async code, the most expensive mistakes are not algorithmic; they are runtime misuse.",
          ],
          list: [
            "Blocking work (std::fs, synchronous clients, CPU-heavy parsing) on a worker thread starves the runtime; use spawn_blocking.",
            "Holding a std::sync::Mutex guard across .await makes the future non-Send and serializes the request behind one lock.",
            "Unbounded channels and join_all over unbounded input grow memory until the OOM killer arrives; bound them or use buffer_unordered(n).",
            "One tokio::spawn per request with no cap keeps the runtime busy while memory and latency grow without limit.",
            "Cloning large buffers per task instead of sharing Arc<Bytes>; Bytes clones are refcount bumps, Vec clones are memcpy.",
            "format! and per-request to_string() in hot paths and log fields; precompute static strings and pass &'static str.",
          ],
          code: `# oha: fixed concurrency, fixed duration, latency distribution
oha -z 60s -c 200 --latency http://ledger-api:8080/v1/invoices

# k6: scriptable scenarios with thresholds that fail the run
# script.js: import http from 'k6/http';
#   export const options = { vus: 200, duration: '60s',
#     thresholds: { http_req_duration: ['p(99)<250'] } };
k6 run script.js

# Allocation profiling with dhat (a dev-dependency, never enabled in release)
# #[global_allocator]
# static ALLOC: dhat::Alloc = dhat::Alloc;
# let _profiler = dhat::Profiler::new_heap();`,
          tip:
            "Measure with the same allocator, TLS stack and tokio worker count as production. A load test on a debug build with one worker thread tells you which code is slow, not how the service behaves.",
        },
      ],
      exercise: {
        prompt:
          "Add a criterion benchmark for a string-heavy function: black_box the input, set throughput to bytes, and document the exact commands that save and compare a baseline in CI.",
        starter: `use criterion::{criterion_group, criterion_main, Criterion};

fn normalize(input: &str) -> String {
    input.trim().to_ascii_lowercase().replace(' ', "-")
}

fn bench_normalize(c: &mut Criterion) {
    // TODO: black_box the input, use a benchmark group, add throughput
    todo!()
}

criterion_group!(benches, bench_normalize);
criterion_main!(benches);`,
        hint:
          "group.throughput(Throughput::Bytes(input.len() as u64)); then group.bench_function(\"slug\", |b| b.iter(|| normalize(black_box(input)))). Remember harness = false in Cargo.toml.",
        solution: `use criterion::{criterion_group, criterion_main, Criterion, Throughput};
use std::hint::black_box;

fn normalize(input: &str) -> String {
    input.trim().to_ascii_lowercase().replace(' ', "-")
}

fn bench_normalize(c: &mut Criterion) {
    let input = "  Ledgerline Invoice Export For Acme Corporation  ";
    let mut group = c.benchmark_group("normalize");
    group.throughput(Throughput::Bytes(input.len() as u64));
    group.bench_function("slug", |b| {
        b.iter(|| normalize(black_box(input)))
    });
    group.finish();
}

criterion_group!(benches, bench_normalize);
criterion_main!(benches);

// Cargo.toml
// [dev-dependencies]
// criterion = "0.8"
//
// [[bench]]
// name = "normalize"
// harness = false
//
// Save a baseline once, compare on every pull request:
//   cargo bench -- --save-baseline main
//   cargo bench -- --baseline main
//   cargo bench -- --baseline main --save-baseline pr`,
      },
      questions: [
        {
          q: "A flamegraph of a debug build shows 40 percent of samples in core::fmt. What is wrong with the conclusion that formatting is your bottleneck?",
          options: [
            "Nothing: formatting is single-threaded and always dominates",
            "Debug builds are unoptimized and inline nothing, so the profile says nothing about the code you ship",
            "The sampling frequency was too low to see the real hot path",
            "flamegraph cannot attribute time inside std",
          ],
          answer: 1,
          explain:
            "Without optimizations, generic and formatting code stays out of line and dominates samples. Profile a release build with symbols (debug = 1 or split debuginfo) and the same allocator, TLS stack and worker count as production, or you are optimizing a binary nobody runs.",
        },
        {
          q: "A benchmark gets 3x faster right after you wrap the input and output in black_box. What likely happened?",
          options: [
            "black_box forces an extra copy that warms the cache",
            "The earlier numbers measured work LLVM had hoisted out of the loop or deleted, which is exactly what black_box prevents",
            "criterion's stored baseline was stale and reported the wrong delta",
            "The machine was thermally throttled during the first run",
          ],
          answer: 1,
          explain:
            "LLVM is allowed to observe that the computed value is unused and remove it, or hoist a loop-invariant call. black_box makes the value opaque so the work must happen. If a change that only adds black_box moves the number, the original measurement was never measuring the work.",
        },
      ],
      production: [
        "Every route has a documented p99 budget and an alert when the error-budget burn rate stays above threshold",
        "Benchmarks run on a fixed machine class and compare against a stored baseline; more than 10 percent regression fails the PR",
        "Profiles are captured from release builds with symbols, never from debug builds with unoptimized dependencies",
        "Load tests use production-shaped payloads, ramp to find the knee, and report error rate and p99 alongside requests per second",
        "Allocation profiling and runtime tracing are set up before the incident, so the first investigation is not also the first setup",
      ],
      crates: ["criterion", "pprof", "dhat", "tokio-console"],
      pitfall:
        "Benchmarking without black_box: LLVM hoists or deletes the work, so the benchmark measures an empty loop and shows a spectacular improvement the moment inlining changes. Always black_box inputs and outputs.",
      quickbytes: [
        "cargo bench -- --save-baseline main once, then --baseline main on every PR, and fail on more than 10 percent regression.",
        "cargo flamegraph --release --bin ledger-api - profile the binary you ship; a debug profile is a profile of code you do not run.",
        "oha -z 60s -c 200 --latency <url> ramps until p99 leaves the budget; that knee, not the CPU limit, is per-replica capacity.",
      ],
      github: [
        {
          name: "tikv/pprof-rs",
          url: "https://github.com/tikv/pprof-rs",
        },
        {
          name: "bheisler/criterion.rs",
          url: "https://github.com/bheisler/criterion.rs",
        },
      ],
      resources: [
        {
          title: "criterion: statistics-driven microbenchmarks",
          url: "https://docs.rs/criterion/latest/criterion/",
          kind: "docs",
        },
        {
          title: "pprof: in-process CPU profiler with flamegraphs",
          url: "https://docs.rs/crate/pprof/latest",
          kind: "docs",
        },
        {
          title: "oha: HTTP load generator",
          url: "https://crates.io/crates/oha",
          kind: "docs",
        },
        {
          title: "tikv/pprof-rs: sampling profiler for Rust services",
          url: "https://github.com/tikv/pprof-rs",
          kind: "repo",
        },
        {
          title: "Jon Gjengset channel: Rust internals, async and performance",
          url: "https://www.youtube.com/@jonhoo",
          kind: "video",
        },
      ],
    },
    {
      id: "g09",
      title: "Incident response: severity, roles, blameless review",
      minutes: 75,
      level: "industry",
      goal:
        "Run an incident from first page to written review: a severity ladder that routes, named roles that do not overlap, mitigation before diagnosis, and follow-up actions with owners and dates.",
      sections: [
        {
          h: "Severity is a routing decision, not a feeling",
          p: [
            "Severity decides who is woken, how often customers hear from you, and whether an executive is briefed. It is not a measure of how upset the room is. Write the ladder down, tie each level to observable impact, and declare at the highest plausible level: downgrading a quiet incident is cheap, and discovering at hour three that nobody called the database owner is not.",
            "Tie severity to the error budget rather than to the number of alerts firing. A total outage of a tier-three internal tool is a SEV3; a two percent error rate on checkout, which is a 20x budget burn, is a SEV1. Because the ladder is data, it can be reviewed in a pull request instead of argued about during an incident.",
          ],
          code: `# severity.yaml — routing is data, so it can be reviewed and changed without a deploy
sev1:
  description: "customer-facing outage or risk of data loss"
  page: [primary, secondary, incident-commander]
  declare_within_seconds: 300
  update_every_minutes: 15
  exec_brief: true

sev2:
  description: "degraded for a subset of tenants; SLO burn above 10x"
  page: [primary]
  declare_within_seconds: 900
  update_every_minutes: 30
  exec_brief: false

sev3:
  description: "single tenant broken, workaround exists"
  page: []
  ticket: true
  update_every_minutes: 240`,
          tip:
            "Put the current severity and the next update deadline in the incident channel topic. It removes the most common status question and makes a missed update visible to everyone.",
        },
        {
          h: "Three roles, and the commander does not debug",
          p: [
            "The incident commander coordinates, decides and owns communication; the operations lead runs the technical work, usually by delegating to subject-matter experts; the communications lead writes updates for customers and stakeholders. One person can hold two roles in a small incident, but the commander must not hold the operations role: a commander with a shell open stops coordinating.",
            "Handoffs are where incidents lose twenty minutes. Record commander, severity and the next update time in one place, and read it back during the handoff. The state machine below rejects illegal transitions, so a resolved incident cannot silently reopen without a new declaration and a fresh timeline.",
          ],
          code: `use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Declared,
    Mitigated,
    Resolved,
}

#[derive(Debug)]
pub struct Incident {
    pub phase: Phase,
    pub declared_at: Instant,
    pub commander: String,
    pub mitigated_at: Option<Instant>,
}

impl Incident {
    pub fn declare(commander: &str) -> Self {
        Self {
            phase: Phase::Declared,
            declared_at: Instant::now(),
            commander: commander.to_string(),
            mitigated_at: None,
        }
    }

    pub fn mitigate(&mut self) -> Result<(), &'static str> {
        match self.phase {
            Phase::Declared => {
                self.phase = Phase::Mitigated;
                self.mitigated_at = Some(Instant::now());
                Ok(())
            }
            Phase::Mitigated => Err("already mitigated"),
            Phase::Resolved => Err("cannot mitigate a resolved incident"),
        }
    }

    pub fn resolve(&mut self) -> Result<(), &'static str> {
        match self.phase {
            Phase::Declared => Err("cannot resolve before mitigation"),
            Phase::Mitigated => {
                self.phase = Phase::Resolved;
                Ok(())
            }
            Phase::Resolved => Err("already resolved"),
        }
    }

    pub fn time_to_mitigate(&self) -> Option<std::time::Duration> {
        self.mitigated_at.map(|at| at.duration_since(self.declared_at))
    }
}`,
          tip:
            "Declare a commander within the first five minutes, even if it is the person who noticed. The role can be transferred; an unowned incident cannot.",
        },
        {
          h: "Mitigate first, diagnose second",
          p: [
            "The first question is not why, it is how do we stop the bleeding: roll back the deploy, flip the flag off, fail over the primary, shed the expensive endpoint. Diagnosis continues after customers recover, with the system stable and the timeline preserved. Teams that debug before mitigating turn a ten-minute outage into a ninety-minute one.",
            "Capture the timeline while it happens: first alert, first acknowledgement, each mitigation attempt, recovery, using telemetry timestamps rather than memory. The review is blameless in language but not vague in content: every action gets one accountable person, a ticket and a due date, and the review is published within five business days.",
          ],
          list: [
            "Detected: the alert or customer report, with the timestamp from telemetry rather than from chat.",
            "Declared: severity, commander, incident channel and the first customer-facing update.",
            "Mitigated: the change that restored service, even while the cause is still unknown.",
            "Resolved: error rate and latency back inside the SLO for thirty consecutive minutes.",
            "Reviewed: actions with owner, ticket and date; waivers with an expiry and a compensating control.",
          ],
          code: `use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Postmortem {
    pub title: String,
    pub severity: String,
    pub detected_at: String,
    pub mitigated_at: String,
    pub actions: Vec<Action>,
}

#[derive(Debug, Deserialize)]
pub struct Action {
    pub description: String,
    pub owner: String,   // one accountable person, never a team alias
    pub due: String,     // ISO date, required
    pub ticket: String,
}

pub fn validate(pm: &Postmortem) -> Result<(), Vec<String>> {
    let mut problems = Vec::new();
    if pm.actions.is_empty() {
        problems.push("postmortem has no follow-up actions".to_string());
    }
    for (i, action) in pm.actions.iter().enumerate() {
        if action.owner.trim().is_empty() || action.owner.contains("team") {
            problems.push(format!("actions[{i}]: owner must be one accountable person"));
        }
        if action.due.trim().is_empty() {
            problems.push(format!("actions[{i}]: due date is required"));
        }
        if action.ticket.trim().is_empty() {
            problems.push(format!("actions[{i}]: a ticket is required"));
        }
    }
    if problems.is_empty() { Ok(()) } else { Err(problems) }
}`,
          tip:
            "Reward the person who declared a false alarm. The alternative is a team that waits forty minutes for confirmation while the error budget burns.",
        },
      ],
      exercise: {
        prompt:
          "Implement an incident lifecycle that refuses to resolve before mitigation and records time-to-mitigate in seconds; assert both legal and illegal transitions in main.",
        starter: `#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Declared,
    Mitigated,
    Resolved,
}

struct Incident {
    phase: Phase,
    time_to_mitigate_secs: Option<u64>,
}

impl Incident {
    fn declare() -> Self {
        Self { phase: Phase::Declared, time_to_mitigate_secs: None }
    }

    // TODO: mitigate takes the elapsed seconds, records them and moves to Mitigated
    fn mitigate(&mut self, after_secs: u64) -> Result<(), &'static str> {
        todo!()
    }

    // TODO: resolve only from Mitigated
    fn resolve(&mut self) -> Result<(), &'static str> {
        todo!()
    }
}

fn main() {
    let mut incident = Incident::declare();
    assert!(incident.resolve().is_err());
    incident.mitigate(420).unwrap();
    incident.resolve().unwrap();
    assert_eq!(incident.phase, Phase::Resolved);
    println!("incident lifecycle verified");
}`,
        hint:
          "Match on self.phase in both methods: Declared may only move to Mitigated, Mitigated may move to Resolved, and every attempt to skip a step returns Err with a reason string.",
        solution: `#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Declared,
    Mitigated,
    Resolved,
}

#[derive(Debug)]
struct Incident {
    phase: Phase,
    time_to_mitigate_secs: Option<u64>,
}

impl Incident {
    fn declare() -> Self {
        Self { phase: Phase::Declared, time_to_mitigate_secs: None }
    }

    fn mitigate(&mut self, after_secs: u64) -> Result<(), &'static str> {
        match self.phase {
            Phase::Declared => {
                self.phase = Phase::Mitigated;
                self.time_to_mitigate_secs = Some(after_secs);
                Ok(())
            }
            Phase::Mitigated => Err("already mitigated"),
            Phase::Resolved => Err("cannot mitigate a resolved incident"),
        }
    }

    fn resolve(&mut self) -> Result<(), &'static str> {
        match self.phase {
            Phase::Declared => Err("cannot resolve before mitigation"),
            Phase::Mitigated => {
                self.phase = Phase::Resolved;
                Ok(())
            }
            Phase::Resolved => Err("already resolved"),
        }
    }
}

fn main() {
    let mut incident = Incident::declare();
    assert_eq!(incident.resolve(), Err("cannot resolve before mitigation"));

    incident.mitigate(420).expect("mitigation is legal from declared");
    assert_eq!(incident.time_to_mitigate_secs, Some(420));

    incident.resolve().expect("resolution is legal after mitigation");
    assert_eq!(incident.phase, Phase::Resolved);
    assert_eq!(incident.resolve(), Err("already resolved"));

    println!("mitigated after {:?}s, then resolved", incident.time_to_mitigate_secs);
}`,
      },
      questions: [
        {
          q: "An internal admin tool used by six engineers is completely down. Which severity fits a ladder tied to customer impact?",
          options: [
            "SEV1, because availability is zero",
            "SEV3, because the impact is internal and bounded with a workaround",
            "SEV1 until the cause is known, then downgrade",
            "No incident, because no customer is affected",
          ],
          answer: 1,
          explain:
            "Severity follows impact, and a tool with six internal users and a workaround is a tier-three incident. Declaring high is reversible and declaring low is not, but a ladder that escalates every internal outage destroys the meaning of SEV1 for the incidents that deserve it.",
        },
        {
          q: "During a SEV1 the incident commander starts reading Postgres logs to find the slow query. What is the main risk?",
          options: [
            "The logs may be incomplete without a higher log level",
            "The commander loses the coordination role, so updates, handoffs and decisions stall",
            "Reading logs requires a second approver during an incident",
            "Log lines are not correlated with traces",
          ],
          answer: 1,
          explain:
            "The commander owns coordination, communication and decisions; debugging is the operations lead's job. When the commander starts investigating, customer updates stop, handoffs lose their owner, and two engineers end up repeating the same rollback.",
        },
        {
          q: "What is the correct order for the first fifteen minutes of a customer-facing outage?",
          options: [
            "Diagnose the root cause, then mitigate, then declare",
            "Declare severity and commander, mitigate with rollback or failover, then diagnose",
            "Declare, wait for the deploy pipeline to finish, then roll back",
            "Page the vendor, wait for their update, then declare",
          ],
          answer: 1,
          explain:
            "Declaring starts the clock and assigns the roles; mitigation restores customers before anyone understands the cause. Diagnosis continues on a stable system, and the timeline you captured is what makes the later review possible.",
        },
      ],
      quickbytes: [
        "Declare SEV1 within five minutes and downgrade later; the reverse order costs the first fifteen minutes of every real incident.",
        "One channel, one commander, one timeline: paste the first alert timestamp and the declared severity into the channel topic.",
        "No action item without a named owner and a date; team aliases are where follow-ups go to die.",
      ],
      production: [
        "A written severity ladder maps observable impact to paging, update cadence and executive notification.",
        "Every incident has a named commander, an ops lead and a comms lead, and the commander never debugs.",
        "Mitigation playbooks exist per dependency (rollback, flag off, failover) and are exercised before they are needed.",
        "The timeline is built from telemetry timestamps, and the review is published within five business days.",
        "Follow-up actions have one owner, a ticket and a due date, and open actions resurface at the next review.",
      ],
      crates: ["tracing", "serde", "tokio", "time"],
      github: [
        {
          name: "PagerDuty/incident-response-docs",
          url: "https://github.com/PagerDuty/incident-response-docs",
        },
      ],
      pitfall:
        "Letting the on-call engineer both command and debug: coordination stops, updates stop, and two engineers repeat the same rollback. Assign a commander in the first five minutes, even when that person is not the most senior responder.",
      resources: [
        {
          title: "PagerDuty incident response documentation",
          url: "https://github.com/PagerDuty/incident-response-docs",
          kind: "repo",
        },
        {
          title: "tracing: instrumenting the handlers you read during an incident",
          url: "https://docs.rs/tracing/latest/tracing/attr.instrument.html",
          kind: "docs",
        },
        {
          title: "Tokio: graceful shutdown, so a restart is a mitigation",
          url: "https://tokio.rs/tokio/topics/shutdown",
          kind: "docs",
        },
        {
          title: "InfoQ: on-call, postmortems and production incident talks",
          url: "https://www.youtube.com/@InfoQ",
          kind: "video",
        },
      ],
    },
    {
      id: "g10",
      title: "SLOs and error budgets: burn rate, alerts, policy",
      minutes: 70,
      level: "industry",
      goal:
        "Define an SLI from request data, derive the error budget from a target, alert on multi-window burn rate, and write the policy that decides when shipping stops.",
      sections: [
        {
          h: "One ratio, measured at the server",
          p: [
            "An SLI is a ratio of good events to valid events, computed from data you already emit: requests that returned under 250 ms, requests that did not return 5xx, jobs that finished inside the freshness deadline. Measure at the server, because client-side measurement mixes in the user's network and quietly rewards clients that retry.",
            "An SLO is the target for that ratio over a window, and the error budget is what remains. At 99.9 percent over 30 days the budget is 43 minutes 12 seconds of complete unavailability, or the equivalent spread as a low error rate. That number, not a feeling, decides whether a risky deploy is affordable this week.",
          ],
          code: `use std::time::Duration;

#[derive(Debug, Clone, Copy)]
pub struct Slo {
    pub name: &'static str,
    pub target: f64,      // 0.999 means 99.9 percent
    pub window: Duration,
}

impl Slo {
    /// Seconds of complete failure the budget allows inside the window.
    pub fn budget_seconds(&self) -> f64 {
        self.window.as_secs_f64() * (1.0 - self.target)
    }

    /// Fraction of the budget still unspent, clamped at zero.
    pub fn remaining(&self, bad_seconds: f64) -> f64 {
        let budget = self.budget_seconds();
        if budget <= 0.0 {
            return 0.0;
        }
        ((budget - bad_seconds) / budget).clamp(0.0, 1.0)
    }
}

fn main() {
    let slo = Slo {
        name: "checkout-availability",
        target: 0.999,
        window: Duration::from_secs(30 * 24 * 60 * 60),
    };
    // 43 min 12 s of budget in a 30-day window
    assert!((slo.budget_seconds() - 2592.0).abs() < 1.0);
    assert!((slo.remaining(648.0) - 0.75).abs() < 1e-9);
    println!(
        "budget {:.0}s, {:.0}% remaining",
        slo.budget_seconds(),
        slo.remaining(648.0) * 100.0
    );
}`,
          tip:
            "Quote budgets in minutes, not percentages: 99.9 percent over 30 days is 43m12s, and 99.95 percent is 21m36s. The minutes are what make the trade-off concrete in a planning meeting.",
        },
        {
          h: "Burn rate measures the speed of spending",
          p: [
            "Burn rate is the error rate divided by the budget: a burn rate of 1 spends the whole budget exactly at the end of the window. Alerting on a raw error threshold ignores the budget entirely, while burn rate answers the only question that matters during a release, which is how long until the budget is gone.",
            "Use two windows per alert: a long window for significance and a short one so the alert clears quickly after recovery. A 14.4x burn over one hour consumes two percent of a 30-day budget, which justifies a page; a 6x burn over six hours consumes five percent, which justifies a ticket. Requiring both windows to agree suppresses spikes that resolve themselves.",
          ],
          code: `groups:
  - name: ledger-slo
    interval: 30s
    rules:
      - record: sli:ledger_requests:ratio_5m
        expr: |
          sum(rate(http_requests_total{job="ledger-api",status=~"2..|3.."}[5m]))
          /
          sum(rate(http_requests_total{job="ledger-api"}[5m]))

      - record: sli:ledger_requests:ratio_1h
        expr: |
          sum(rate(http_requests_total{job="ledger-api",status=~"2..|3.."}[1h]))
          /
          sum(rate(http_requests_total{job="ledger-api"}[1h]))

      - alert: LedgerErrorBudgetFastBurn
        expr: |
          (1 - sli:ledger_requests:ratio_5m) > (14.4 * 0.001)
          and
          (1 - sli:ledger_requests:ratio_1h) > (14.4 * 0.001)
        for: 2m
        labels:
          severity: page
        annotations:
          summary: "Ledger burns its 99.9% budget 14.4x too fast"
          runbook: "https://runbooks.example.com/ledger/burn"`,
          tip:
            "The 0.001 in that expression is 1 minus the 99.9 percent target. Change the target and you must change every multiplier, which is a good reason to generate these rules rather than hand-edit them.",
        },
        {
          h: "The policy is what changes behaviour",
          p: [
            "An error budget with no consequence is a dashboard. Write the policy: above fifty percent remaining, ship normally; between twenty-five and fifty, risky changes need a second reviewer and a canary; below twenty-five, only reliability work and explicitly approved exceptions; at zero, feature work stops until the budget recovers.",
            "Exceptions need a named owner and an expiry date, not a team alias and a promise. The policy should also say who can grant an exception and when it is reviewed, because the real failure mode is a permanent exception that silently disables the whole mechanism while the dashboard stays green.",
          ],
          code: `#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum BudgetState {
    Healthy,    // more than 50 percent remaining
    Watch,      // 25 to 50 percent
    Critical,   // above zero, below 25 percent
    Exhausted,  // nothing left
}

pub fn classify(remaining: f64) -> BudgetState {
    match remaining {
        r if r <= 0.0 => BudgetState::Exhausted,
        r if r < 0.25 => BudgetState::Critical,
        r if r <= 0.50 => BudgetState::Watch,
        _ => BudgetState::Healthy,
    }
}

pub fn may_ship_features(state: BudgetState) -> bool {
    matches!(state, BudgetState::Healthy | BudgetState::Watch)
}

pub fn requires_second_review(state: BudgetState) -> bool {
    !matches!(state, BudgetState::Healthy)
}

fn main() {
    assert_eq!(classify(0.62), BudgetState::Healthy);
    assert_eq!(classify(0.30), BudgetState::Watch);
    assert_eq!(classify(0.10), BudgetState::Critical);
    assert_eq!(classify(0.0), BudgetState::Exhausted);
    assert!(may_ship_features(BudgetState::Watch));
    assert!(!may_ship_features(BudgetState::Exhausted));
    assert!(requires_second_review(BudgetState::Critical));
    println!("budget policy: {:?} blocks feature work", classify(0.10));
}`,
          tip:
            "Review the policy with the product owner, not only with SRE. The person who decides to ship despite a burned budget must be the person who agreed what exhaustion means.",
        },
      ],
      exercise: {
        prompt:
          "Implement budget_seconds, burn_rate and a verdict that pages at 14.4x burn, tickets at 6x and stays quiet below that, for a 99.9 percent target over 30 days.",
        starter: `const WINDOW_SECS: f64 = 30.0 * 24.0 * 60.0 * 60.0;
const TARGET: f64 = 0.999;

#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    Quiet,
    Ticket,
    Page,
}

fn budget_seconds() -> f64 {
    // TODO: window multiplied by the allowed error fraction
    todo!()
}

fn burn_rate(error_ratio: f64) -> f64 {
    // TODO: error ratio divided by the allowed error fraction
    todo!()
}

fn verdict(error_ratio: f64) -> Verdict {
    // TODO: page at 14.4x, ticket at 6x
    todo!()
}

fn main() {
    assert!((budget_seconds() - 2592.0).abs() < 1.0);
    assert_eq!(verdict(0.01), Verdict::Ticket);
    assert_eq!(verdict(0.015), Verdict::Page);
    println!("budget {:.0}s", budget_seconds());
}`,
        hint:
          "burn_rate = error_ratio / (1.0 - TARGET). Test the page branch with 0.015 rather than the exact boundary: 0.0144 / 0.001 evaluates to 14.399999999999999 in f64, so a boundary assertion fails for reasons unrelated to your logic.",
        solution: `const WINDOW_SECS: f64 = 30.0 * 24.0 * 60.0 * 60.0;
const TARGET: f64 = 0.999;

#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    Quiet,
    Ticket,
    Page,
}

fn budget_seconds() -> f64 {
    WINDOW_SECS * (1.0 - TARGET)
}

fn burn_rate(error_ratio: f64) -> f64 {
    error_ratio / (1.0 - TARGET)
}

fn verdict(error_ratio: f64) -> Verdict {
    let burn = burn_rate(error_ratio);
    if burn >= 14.4 {
        Verdict::Page
    } else if burn >= 6.0 {
        Verdict::Ticket
    } else {
        Verdict::Quiet
    }
}

fn main() {
    assert!((budget_seconds() - 2592.0).abs() < 1.0);

    // 1 percent errors is a 10x burn: a ticket, not a page
    assert_eq!(verdict(0.01), Verdict::Ticket);
    assert_eq!(verdict(0.015), Verdict::Page);
    assert_eq!(verdict(0.001), Verdict::Quiet);

    println!(
        "budget {:.0}s; 1 percent errors burns {:.1}x",
        budget_seconds(),
        burn_rate(0.01)
    );
}`,
      },
      questions: [
        {
          q: "Your error rate is 0.5 percent against a 99.9 percent SLO. What is the burn rate?",
          options: ["0.5x", "5x", "50x", "500x"],
          answer: 1,
          explain:
            "Burn rate is the observed error rate divided by the allowed error rate: 0.005 / 0.001 = 5. A burn rate of 5 exhausts a 30-day budget in six days, which is why it earns a ticket rather than silence.",
        },
        {
          q: "Why does a burn-rate alert require both a short and a long window?",
          options: [
            "To average the two error rates into a smoother signal",
            "So a brief spike does not page while a sustained burn still does",
            "Because a single Prometheus expression cannot use one window twice",
            "To detect missing scrape targets",
          ],
          answer: 1,
          explain:
            "The long window provides significance and the short window provides fast recovery. With only a short window a transient blip pages; with only a long window a real outage takes too long to fire and the alert stays firing long after recovery.",
        },
        {
          q: "The monthly budget is exhausted. Which response follows the standard policy?",
          options: [
            "Raise the SLO so the budget resets",
            "Keep shipping but add a dashboard panel",
            "Freeze feature work and spend the iteration on reliability, with owned exceptions",
            "Lower the alert threshold so it is harder to exhaust",
          ],
          answer: 2,
          explain:
            "The budget exists to make reliability work negotiable in advance. When it is gone, the policy trades feature delivery for reliability until the window refills; exceptions are allowed but they need an owner and an expiry, otherwise the freeze never ends.",
        },
      ],
      quickbytes: [
        "99.9% over 30 days is 43m12s of budget; 99.95% is 21m36s. Put the minutes in the doc, not just the percentage.",
        "Page at 14.4x burn over 1h and 5m; ticket at 6x over 6h and 30m. Both windows must agree.",
        "An SLO without a release policy is a dashboard; write who approves exceptions and when they expire.",
      ],
      production: [
        "Every user-facing service has one SLI ratio, one target and a documented 30-day window.",
        "Burn-rate alerts pair long and short windows, and page and ticket routes are separate.",
        "A written budget policy defines shipping rules at 50, 25 and 0 percent remaining.",
        "Exceptions are time-boxed, owned by a person, and reviewed at the next reliability review.",
        "The SLO dashboard links the alert, the runbook and the remaining budget for the current window.",
      ],
      crates: ["metrics", "tracing", "serde", "time"],
      github: [
        {
          name: "slok/sloth",
          url: "https://github.com/slok/sloth",
        },
        {
          name: "prometheus/prometheus",
          url: "https://github.com/prometheus/prometheus",
        },
      ],
      pitfall:
        "Averaging latency across every route: checkout at 2 s hides inside a sea of 5 ms health checks, so the SLO reports success while the page customers use is slow. Compute the SLI per route or per user journey.",
      resources: [
        {
          title: "sloth: generate Prometheus SLOs and burn-rate alerts",
          url: "https://github.com/slok/sloth",
          kind: "repo",
        },
        {
          title: "Prometheus: recording rules and alerting rules",
          url: "https://github.com/prometheus/prometheus",
          kind: "repo",
        },
        {
          title: "metrics: counters and histograms behind the SLI",
          url: "https://docs.rs/metrics/latest/metrics/",
          kind: "docs",
        },
        {
          title: "CNCF: SLOs, error budgets and reliability engineering",
          url: "https://www.youtube.com/@CNCF",
          kind: "video",
        },
      ],
    },
    {
      id: "g11",
      title: "Capacity planning, queueing and load shedding",
      minutes: 85,
      level: "industry",
      goal:
        "Turn a latency budget into per-replica capacity, plan headroom for zone failure, and shed load deliberately so overload costs latency on some requests instead of throughput on all of them.",
      sections: [
        {
          h: "Capacity is a throughput at a latency",
          p: [
            "A replica is at capacity when p99 crosses its budget, not when CPU reaches one hundred percent. Measure that point with a ramp test against production-shaped requests, then plan replicas for peak traffic plus headroom for one zone or one replica loss. Two replicas both sitting at ninety percent utilisation are not a highly available service; they are one failure away from an outage.",
            "Little's law ties the numbers together: concurrency equals throughput multiplied by latency. If p99 doubles at a constant request rate, in-flight requests double, and the connection pool is the next thing to run out. That is why a latency regression and a pool-exhaustion incident are often the same event seen from two dashboards.",
          ],
          code: `#[derive(Debug, Clone, Copy)]
pub struct Plan {
    pub peak_rps: f64,
    pub per_replica_rps: f64,   // measured at the p99 budget
    pub headroom: f64,          // 0.30 means plan for 30 percent spare
    pub zones: u32,
}

impl Plan {
    /// Replicas needed to survive the loss of one zone at peak.
    pub fn replicas(&self) -> u32 {
        let usable_per_replica = self.per_replica_rps / (1.0 + self.headroom);
        let needed_after_loss = (self.peak_rps / usable_per_replica).ceil() as u32;
        let total = (needed_after_loss * self.zones).div_ceil(self.zones - 1);
        total.div_ceil(self.zones) * self.zones
    }
}

fn main() {
    let plan = Plan { peak_rps: 4_000.0, per_replica_rps: 600.0, headroom: 0.30, zones: 3 };
    // 9 replicas carry peak with headroom; spread over 3 zones and doubled for
    // one-zone loss: 15 replicas, five per zone, ten left after the loss.
    assert_eq!(plan.replicas(), 15);
    assert!(10.0 * (plan.per_replica_rps / (1.0 + plan.headroom)) >= plan.peak_rps);
    println!("replicas for peak with zone loss: {}", plan.replicas());
}`,
          tip:
            "Record the request mix and payload sizes from the load test next to the plan. A capacity number measured with tiny synthetic payloads is a number about a service you do not run.",
        },
        {
          h: "Bounded queues, deadlines, explicit refusal",
          p: [
            "An unbounded queue does not absorb a spike, it stores the spike as latency and then as timeouts. Under overload your only real options are to serve fewer requests deliberately or to let everything get slower until clients give up. A bounded queue with try_send, a deadline on every job and a rejection path makes that choice explicit and keeps served requests fast.",
            "Shedding must be cheap. Reject before parsing the body, before acquiring a database connection, before doing work you will throw away. Return 503 with Retry-After and increment a counter, because a shed you cannot see looks exactly like a capacity problem from the outside and will be diagnosed as one.",
          ],
          code: `use tokio::sync::mpsc;

#[derive(Debug)]
pub struct Job {
    pub id: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Submit {
    Accepted,
    ShedFull,
    ShedClosed,
}

pub struct BoundedQueue {
    tx: mpsc::Sender<Job>,
}

impl BoundedQueue {
    /// try_send, never send().await: waiting for queue space here just moves
    /// the queue into the request path and converts overload into timeouts.
    pub fn submit(&self, job: Job) -> Submit {
        match self.tx.try_send(job) {
            Ok(()) => Submit::Accepted,
            Err(mpsc::error::TrySendError::Full(_)) => Submit::ShedFull,
            Err(mpsc::error::TrySendError::Closed(_)) => Submit::ShedClosed,
        }
    }
}

pub async fn worker(mut rx: mpsc::Receiver<Job>) {
    while let Some(job) = rx.recv().await {
        process(job).await;
    }
}

async fn process(_job: Job) {
    // The worker runs with a bounded concurrency and a per-job deadline.
}

// At startup: let (tx, rx) = mpsc::channel(64); tokio::spawn(worker(rx));`,
          tip:
            "Queue depth is the leading indicator: alert when it stays above half the bound for a minute, before the first 503 appears and long before latency shows it.",
        },
        {
          h: "Shed by class, and reserve the interactive path",
          p: [
            "Not all traffic is equal. Health checks and checkout should survive a batch import storm, so give each class its own permit pool: interactive gets the majority and never waits behind batch, batch gets the remainder and is the first to be rejected. This is a bulkhead with a business ranking, and it is the difference between slow exports and a checkout outage.",
            "Kubernetes helps at the node level with priority classes and preemption, but it cannot shed a single request and it cannot add capacity faster than a pod can start. Autoscaling handles the sustained trend; admission control handles the spike that arrives in the ninety seconds before new pods are ready.",
          ],
          code: `#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    Interactive,
    Batch,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Admit,
    Shed,
}

pub struct Admission {
    pub interactive_limit: u32,
    pub batch_limit: u32,
    pub interactive_in_flight: u32,
    pub batch_in_flight: u32,
}

impl Admission {
    pub fn decide(&mut self, class: Class) -> Decision {
        match class {
            Class::Interactive if self.interactive_in_flight < self.interactive_limit => {
                self.interactive_in_flight += 1;
                Decision::Admit
            }
            // Batch may borrow nothing from the interactive pool.
            Class::Batch if self.batch_in_flight < self.batch_limit => {
                self.batch_in_flight += 1;
                Decision::Admit
            }
            _ => Decision::Shed,
        }
    }
}

fn main() {
    let mut admission = Admission {
        interactive_limit: 2,
        batch_limit: 1,
        interactive_in_flight: 0,
        batch_in_flight: 0,
    };
    assert_eq!(admission.decide(Class::Batch), Decision::Admit);
    assert_eq!(admission.decide(Class::Interactive), Decision::Admit);
    assert_eq!(admission.decide(Class::Batch), Decision::Shed);
    assert_eq!(admission.decide(Class::Interactive), Decision::Admit);
    println!("batch saturates before interactive, as intended");
}`,
          tip:
            "Make the class an explicit argument at the edge, derived from the route, not from a client header. A header-based class is a header an attacker can set.",
        },
      ],
      exercise: {
        prompt:
          "Implement a token bucket that admits a burst of 10 and refills at 120 requests per second, then show that it rejects instead of queueing once the burst is spent.",
        starter: `#[derive(Debug)]
struct TokenBucket {
    capacity: f64,
    tokens: f64,
    refill_per_sec: f64,
}

impl TokenBucket {
    fn new(capacity: f64, refill_per_sec: f64) -> Self {
        Self { capacity, tokens: capacity, refill_per_sec }
    }

    // TODO: add elapsed * refill rate, capped at capacity
    fn refill(&mut self, elapsed_secs: f64) {
        todo!()
    }

    // TODO: take one token if available, otherwise reject
    fn try_take(&mut self) -> bool {
        todo!()
    }
}

fn main() {
    let mut bucket = TokenBucket::new(10.0, 120.0);
    for _ in 0..10 {
        assert!(bucket.try_take());
    }
    assert!(!bucket.try_take());
    println!("burst exhausted, request rejected");
}`,
        hint:
          "Refill with self.tokens = (self.tokens + elapsed * self.refill_per_sec).min(self.capacity), and take only when tokens are at least 1.0, subtracting exactly one.",
        solution: `#[derive(Debug)]
struct TokenBucket {
    capacity: f64,
    tokens: f64,
    refill_per_sec: f64,
}

impl TokenBucket {
    fn new(capacity: f64, refill_per_sec: f64) -> Self {
        Self { capacity, tokens: capacity, refill_per_sec }
    }

    fn refill(&mut self, elapsed_secs: f64) {
        self.tokens = (self.tokens + elapsed_secs * self.refill_per_sec).min(self.capacity);
    }

    fn try_take(&mut self) -> bool {
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

fn main() {
    let mut bucket = TokenBucket::new(10.0, 120.0);

    for _ in 0..10 {
        assert!(bucket.try_take());
    }
    assert!(!bucket.try_take());     // burst spent: reject, do not queue

    bucket.refill(0.5);              // half a second at 120/s, capped at the burst
    assert!(bucket.try_take());
    assert_eq!(bucket.tokens, 9.0);

    println!("token bucket sheds once the burst is spent");
}`,
      },
      questions: [
        {
          q: "p99 doubles while the request rate stays flat. What does Little's law imply?",
          options: [
            "Throughput must have doubled",
            "In-flight concurrency has roughly doubled, so pools and queues saturate next",
            "CPU must be saturated",
            "The error budget is unaffected",
          ],
          answer: 1,
          explain:
            "Concurrency equals throughput times latency. At constant throughput, doubled latency means twice as many requests in flight, which shows up next as pool wait time, queue depth and timeouts even though request rate never moved.",
        },
        {
          q: "Why use try_send on a bounded queue instead of send().await in the request path?",
          options: [
            "try_send is faster in release builds",
            "Awaiting queue space moves the queue into the request path and converts overload into timeouts",
            "send().await does not work with tokio channels",
            "try_send reserves memory in advance",
          ],
          answer: 1,
          explain:
            "Backpressure that blocks the caller preserves the system but destroys the caller's latency, and every waiting request still holds a connection and a task. Rejecting immediately with 503 and Retry-After keeps the served traffic fast and makes the overload visible.",
        },
        {
          q: "Which plan actually survives the loss of one availability zone at peak?",
          options: [
            "Two replicas at ninety percent utilisation in one zone",
            "Peak plus headroom spread over three zones, with N-1 capacity verified",
            "A memory limit plus the OOM killer",
            "An HPA that adds pods within sixty seconds",
          ],
          answer: 1,
          explain:
            "Zone loss removes a third of the fleet instantly, and the HPA cannot replace it until nodes and images are ready. Sizing for peak with headroom across zones, then checking that the remaining zones can carry the load, is the only plan that survives the first failure.",
        },
      ],
      quickbytes: [
        "Capacity is the rps where p99 leaves the budget; measure the knee, then add 30 percent and one zone of slack.",
        "try_send + 503 + Retry-After: 1 beats a thirty-second queue that every client times out on anyway.",
        "Give batch its own permits; borrowed capacity is how a nightly export takes down checkout.",
      ],
      production: [
        "Per-replica capacity is measured by a ramp test at the production request mix and recorded with the deployment.",
        "Replica count is sized for peak plus headroom and verified against the loss of one zone.",
        "Every request path has a concurrency limit, a bounded wait and a deadline, and overflow returns 503.",
        "Traffic classes have separate permit pools, and batch work cannot borrow interactive capacity.",
        "Shed counters and queue depth sit on the same dashboard as p99, so overload is distinguishable from a slow dependency.",
      ],
      crates: ["tokio", "tower", "governor", "metrics"],
      github: [
        {
          name: "kubernetes/autoscaler",
          url: "https://github.com/kubernetes/autoscaler",
        },
        {
          name: "kubernetes-sigs/metrics-server",
          url: "https://github.com/kubernetes-sigs/metrics-server",
        },
      ],
      pitfall:
        "Adding replicas to a service whose database pool is already saturated: more pods mean more connections competing for the same backend, and the outage gets worse. Bound the pool per replica and check the shared dependency before scaling out.",
      resources: [
        {
          title: "Kubernetes: requests, limits and scheduling behaviour",
          url: "https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/",
          kind: "docs",
        },
        {
          title: "kubernetes/autoscaler: HPA and cluster autoscaler",
          url: "https://github.com/kubernetes/autoscaler",
          kind: "repo",
        },
        {
          title: "The Tail at Scale: why the slowest requests set your capacity",
          url: "https://research.google/pubs/the-tail-at-scale/",
          kind: "paper",
        },
        {
          title: "governor: quotas and rate limiting primitives",
          url: "https://docs.rs/governor/latest/governor/",
          kind: "docs",
        },
        {
          title: "CNCF: autoscaling, capacity and overload control",
          url: "https://www.youtube.com/@CNCF",
          kind: "video",
        },
      ],
    },
    {
      id: "g12",
      title: "Cost engineering: unit economics and right-sizing",
      minutes: 65,
      level: "industry",
      goal:
        "Attribute spend per service and per successful request, right-size from measured usage, and take the cheap wins in order without buying savings with SLO violations.",
      sections: [
        {
          h: "Cost per request is the number you can act on",
          p: [
            "A monthly bill is an outcome, not a lever. Break it into the parts you control: vCPU-hours and GiB-hours for the fleet, storage, egress and managed services per request. Divide by successful requests to get unit cost. A service whose cost per thousand requests doubled after a dependency change is a regression you can review like any other.",
            "Cost belongs in the same review as latency and reliability because the three trade against each other. Halving a CPU request may be free, or it may push the service onto the throttling cliff where p99 doubles and retries add load. Only a measurement in the release environment tells you which one you bought.",
          ],
          code: `#[derive(Debug, Clone, Copy)]
pub struct CostModel {
    pub vcpu_hours: f64,
    pub vcpu_hour_price: f64,
    pub gib_hours: f64,
    pub gib_hour_price: f64,
    pub requests_per_month: f64,
}

impl CostModel {
    pub fn monthly(&self) -> f64 {
        self.vcpu_hours * self.vcpu_hour_price + self.gib_hours * self.gib_hour_price
    }

    pub fn per_million_requests(&self) -> f64 {
        if self.requests_per_month <= 0.0 {
            return 0.0;
        }
        self.monthly() / self.requests_per_month * 1_000_000.0
    }
}

fn main() {
    let model = CostModel {
        vcpu_hours: 3.0 * 730.0,     // 3 vCPU-equivalents, always on
        vcpu_hour_price: 0.031,      // arm64 on-demand, order of magnitude
        gib_hours: 6.0 * 730.0,
        gib_hour_price: 0.004,
        requests_per_month: 400_000_000.0,
    };
    // 67.89 compute + 17.52 memory = 85.41 USD, about 0.21 USD per million requests
    assert!((model.monthly() - 85.41).abs() < 1.0);
    assert!((model.per_million_requests() - 0.2135).abs() < 0.01);
    println!(
        "{:.2} USD/month, {:.4} USD per 1M requests",
        model.monthly(),
        model.per_million_requests()
    );
}`,
          tip:
            "Publish unit cost on the service dashboard next to p99. A number nobody sees during normal work cannot influence the design decisions that create it.",
        },
        {
          h: "Right-size from p95 usage, not from guesses",
          p: [
            "Take the p95 of actual CPU and memory working set over at least fourteen days, including the daily peak, then set requests near that p95 and memory limits at peak plus twenty percent. Requests that are five times usage buy nothing except a worse bin-packing outcome and a larger bill. VPA in recommendation mode produces the same numbers without touching the workload.",
            "The exception is a latency-sensitive service with a hard SLO: keep the CPU headroom that the load test justified, and cut somewhere else. The cheapest capacity is the replica that does not need to exist, followed by the replica on a cheaper architecture, followed by the replica running on spot for interruption-tolerant work.",
          ],
          code: `apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: ledger-api
  namespace: ledger-prod
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ledger-api
  updatePolicy:
    updateMode: "Off"        # recommendation only: humans apply it in review
---
# Values the 14-day recommendation justified, committed to the prod overlay:
#   cpu request   300m    (p95 was 280m at peak traffic)
#   mem request   384Mi   (p95 working set 350Mi)
#   mem limit     640Mi   (peak working set 520Mi plus 20 percent)
# Keep the CPU limit off: CFS throttling adds p99 latency and caps a burst
# that the request already reserves capacity for.`,
          tip:
            "Compare container_memory_working_set_bytes with the limit, not container_memory_usage_bytes: page cache inflates usage and makes a healthy pod look like it needs more memory.",
        },
        {
          h: "Cheap wins, in order, with the SLO as a constraint",
          p: [
            "First remove idle capacity: dev and preview namespaces that run all night, orphaned load balancers, snapshots nobody restores. Then move stateless workloads to arm64 and measure, because the hourly price is lower but the performance is workload-dependent. Then take spot for interruption-tolerant batch with a disruption budget and a drain path. Then attack egress and cross-zone chatter, which stay invisible until the bill arrives.",
            "Never buy a saving with an SLO you have not measured. A spot fleet without a drain path turns a two percent price cut into a page at 3am; a memory limit trimmed to the average working set turns an ordinary traffic peak into an OOMKilled rollout. Savings are only real when the p99 budget still holds afterwards.",
          ],
          code: `#[derive(Debug, Clone, Copy)]
pub struct Flavor {
    pub name: &'static str,
    pub monthly_cost: f64,
    pub p99_ms: f64,
    pub interruption_risk: f64,   // probability per month of losing a replica
}

/// Cheapest flavor that still meets the latency budget.
pub fn choose(flavors: &[Flavor], p99_budget_ms: f64) -> Option<Flavor> {
    flavors
        .iter()
        .copied()
        .filter(|flavor| flavor.p99_ms <= p99_budget_ms)
        .min_by(|a, b| a.monthly_cost.total_cmp(&b.monthly_cost))
}

fn main() {
    let flavors = [
        Flavor { name: "x86 on-demand", monthly_cost: 420.0, p99_ms: 180.0, interruption_risk: 0.0 },
        Flavor { name: "arm64 on-demand", monthly_cost: 336.0, p99_ms: 185.0, interruption_risk: 0.0 },
        Flavor { name: "arm64 spot", monthly_cost: 110.0, p99_ms: 190.0, interruption_risk: 0.40 },
    ];
    let chosen = choose(&flavors, 200.0).expect("one flavor fits the p99 budget");
    assert_eq!(chosen.name, "arm64 spot");
    assert!(chosen.interruption_risk < 0.5, "spot only with a drain path");
    println!("cheapest inside budget: {} at {:.0} USD/month", chosen.name, chosen.monthly_cost);
}`,
          tip:
            "A migration that saves 180 USD per month but costs 120 engineer-hours at 95 USD does not pay back within a year. Put the one-off cost in the proposal, or the cheapest option on paper becomes the most expensive one shipped.",
        },
      ],
      exercise: {
        prompt:
          "A migration costs 120 engineer-hours at 95 USD per hour and saves 180 USD per month. Implement break-even months and the twelve-month net, and assert that it does not pay back within a year.",
        starter: `const HOURLY_RATE: f64 = 95.0;

fn migration_cost(hours: f64) -> f64 {
    // TODO
    todo!()
}

fn break_even_months(hours: f64, monthly_saving: f64) -> f64 {
    // TODO: guard against a non-positive saving
    todo!()
}

fn net_after_months(hours: f64, monthly_saving: f64, months: f64) -> f64 {
    // TODO: savings minus one-off cost
    todo!()
}

fn main() {
    assert!(break_even_months(120.0, 180.0) > 12.0);
    println!("does not pay back in a year");
}`,
        hint:
          "Cost is hours * HOURLY_RATE = 11,400 USD; break-even is cost / monthly_saving. Return f64::INFINITY when the saving is zero or negative so the comparison stays honest.",
        solution: `const HOURLY_RATE: f64 = 95.0;

fn migration_cost(hours: f64) -> f64 {
    hours * HOURLY_RATE
}

fn break_even_months(hours: f64, monthly_saving: f64) -> f64 {
    if monthly_saving <= 0.0 {
        return f64::INFINITY;
    }
    migration_cost(hours) / monthly_saving
}

fn net_after_months(hours: f64, monthly_saving: f64, months: f64) -> f64 {
    monthly_saving * months - migration_cost(hours)
}

fn main() {
    // 120 h at 95 USD is 11,400 USD; at 180 USD per month that is 63.3 months
    assert!((break_even_months(120.0, 180.0) - 63.333).abs() < 0.01);
    assert!(break_even_months(120.0, 180.0) > 12.0);
    assert!(net_after_months(120.0, 180.0, 12.0) < 0.0);

    println!(
        "break-even at {:.1} months, twelve-month net {:.0} USD",
        break_even_months(120.0, 180.0),
        net_after_months(120.0, 180.0, 12.0)
    );
}`,
      },
      questions: [
        {
          q: "A service's p95 CPU is 80m while each replica requests 1000m, across 20 replicas. What is the first, cheapest action?",
          options: [
            "Move the fleet to spot instances",
            "Lower the request toward measured usage, keeping the latency headroom the load test proved",
            "Remove the memory limit",
            "Enable an HPA at 50 percent CPU",
          ],
          answer: 1,
          explain:
            "A request twelve times measured usage reserves capacity nobody consumes and worsens bin-packing across the whole cluster. Right-size the request first, then re-run the load test to confirm p99 still holds before touching the architecture.",
        },
        {
          q: "Why is cost per successful request better than cost per pod-hour?",
          options: [
            "It is easier to compute from the invoice",
            "It normalises for traffic and exposes inefficiency in dependencies, not just fleet size",
            "It ignores fixed costs",
            "It matches the cloud provider's billing unit",
          ],
          answer: 1,
          explain:
            "Cost per pod-hour falls whenever you run fewer pods, even if the service got slower or needed retries. Cost per successful request captures the work actually delivered, so a dependency that doubled CPU per request shows up as a regression.",
        },
        {
          q: "Which saving is most likely to violate the SLO?",
          options: [
            "Deleting idle development namespaces",
            "Trimming a memory limit to the 50th percentile of working set",
            "Moving an interruption-tolerant batch job to spot with a drain path",
            "Moving to arm64 after a benchmark",
          ],
          answer: 1,
          explain:
            "Half of all observations sit above the 50th percentile, so a normal peak becomes an OOMKill. Limits belong at peak working set plus headroom, and the change needs a load test rather than an average.",
        },
      ],
      quickbytes: [
        "Divide the bill by successful requests, not pods: unit cost catches regressions that a flat invoice hides.",
        "p95 usage over 14 days is a request; the single peak you saw once at 03:00 is not.",
        "Delete idle environments before optimising anything: free capacity beats a cheaper instance.",
      ],
      production: [
        "Every service reports monthly cost and cost per million successful requests on its dashboard.",
        "CPU and memory requests are set from 14-day p95 usage, with latency headroom justified by a load test.",
        "Idle dev, preview and orphaned cloud resources are reaped on a schedule, with an owner per namespace.",
        "arm64 and spot adoption is gated on a benchmark and a drain path, never on price alone.",
        "Cost regressions above an agreed percentage are reviewed like latency regressions.",
      ],
      crates: ["metrics", "serde", "tracing", "rust_decimal"],
      github: [
        {
          name: "opencost/opencost",
          url: "https://github.com/opencost/opencost",
        },
        {
          name: "kubernetes/autoscaler",
          url: "https://github.com/kubernetes/autoscaler",
        },
      ],
      pitfall:
        "Cutting memory limits to the average working set: an ordinary traffic peak becomes OOMKilled pods, the deployment rolls back, and the bill does not change. Size limits on peak working set and prove the change with a load test.",
      resources: [
        {
          title: "OpenCost: Kubernetes cost monitoring and allocation",
          url: "https://github.com/opencost/opencost",
          kind: "repo",
        },
        {
          title: "Kubernetes: requests, limits and QoS classes",
          url: "https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/",
          kind: "docs",
        },
        {
          title: "Autoscaler: HPA, VPA and cluster autoscaling",
          url: "https://github.com/kubernetes/autoscaler",
          kind: "repo",
        },
        {
          title: "CNCF: FinOps, cost visibility and efficiency",
          url: "https://www.youtube.com/@CNCF",
          kind: "video",
        },
      ],
    },
    {
      id: "g13",
      title: "Environment parity: one artifact, explicit differences",
      minutes: 70,
      level: "industry",
      goal:
        "Promote one immutable artifact through environments whose differences are enumerated and tested, so a staging pass predicts production instead of describing a parallel universe.",
      sections: [
        {
          h: "Build once, then promote by digest",
          p: [
            "The artifact that passes staging must be the artifact that runs in production: same image digest, same binary, same dependency graph. Rebuilding per environment reintroduces the difference you are trying to eliminate, and a rebuild is exactly where a different toolchain or a drifted lockfile enters. Promote the digest, not the tag.",
            "Everything that legitimately differs goes into a short reviewed list: service endpoints, replica counts and resources, credential references, feature flags that gate unfinished work, and data fixtures. Everything else must be identical, including log format, timeouts, retry policy and the code path that handles the request.",
          ],
          code: `use std::collections::BTreeMap;

pub struct EnvConfig {
    pub name: &'static str,
    pub values: BTreeMap<&'static str, &'static str>,
}

/// The only keys allowed to differ between environments.
pub const ALLOWED_DIFFS: &[&str] = &[
    "db.host",
    "replicas",
    "log_level",
    "feature.checkout_v2",
    "credentials.ref",
];

pub fn check_parity(staging: &EnvConfig, prod: &EnvConfig) -> Result<(), Vec<String>> {
    let mut problems = Vec::new();
    for (key, staging_value) in &staging.values {
        match prod.values.get(key) {
            None => problems.push(format!("{key} exists in {} but not in prod", staging.name)),
            Some(prod_value) if prod_value != staging_value && !ALLOWED_DIFFS.contains(key) => {
                problems.push(format!("{key} differs ({staging_value} vs {prod_value})"));
            }
            Some(_) => {}
        }
    }
    if problems.is_empty() { Ok(()) } else { Err(problems) }
}

fn main() {
    let staging = EnvConfig { name: "staging", values: BTreeMap::from([
        ("db.host", "staging-db"), ("replicas", "2"), ("timeout_ms", "3000"),
    ]) };
    let prod = EnvConfig { name: "prod", values: BTreeMap::from([
        ("db.host", "prod-db"), ("replicas", "12"), ("timeout_ms", "3000"),
    ]) };
    assert!(check_parity(&staging, &prod).is_ok());

    let drifted = EnvConfig { name: "prod", values: BTreeMap::from([
        ("db.host", "prod-db"), ("replicas", "12"), ("timeout_ms", "9000"),
    ]) };
    assert!(check_parity(&staging, &drifted).is_err());
    println!("endpoint and scale may differ; timeout drift is rejected");
}`,
          tip:
            "Run the parity check in CI against the rendered config of both environments, not against the source files. Rendered output is what the process actually loads.",
        },
        {
          h: "Overlays beat copies",
          p: [
            "Two hundred lines of duplicated Deployment YAML per environment guarantees drift: someone fixes a probe in staging and forgets production. Keep one base and per-environment overlays that patch only what differs. The rendered output is then reviewable as a diff, and the difference between environments is exactly the set of patches you wrote.",
            "Keep the environment values in one file per environment and validate the rendered manifest against the same schema in CI. A patch that silently matches nothing is worse than no patch at all, so treat an unmatched patch as a build error rather than a warning nobody reads.",
          ],
          code: `# kustomize/base/kustomization.yaml
resources:
  - deployment.yaml
  - service.yaml
  - hpa.yaml

# kustomize/overlays/prod/kustomization.yaml
namespace: ledger-prod
resources:
  - ../../base
patches:
  - path: replicas-and-resources.yaml
  - path: ingress-host.yaml
images:
  - name: ghcr.io/acme/ledger-api
    newName: ghcr.io/acme/ledger-api
    newTag: "1.12.0"    # promotion writes the digest here; tags are mutable

# kustomize/overlays/prod/replicas-and-resources.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ledger-api
spec:
  replicas: 12
  template:
    spec:
      containers:
        - name: ledger-api
          resources:
            requests: { cpu: 500m, memory: 512Mi }
            limits:   { memory: 1Gi }`,
          tip:
            "Pin the promotion to a digest in the overlay. A tag can be moved in the registry after staging passed, which silently makes production a different artifact than the one you tested.",
        },
        {
          h: "Preview environments and drift detection",
          p: [
            "A preview environment per pull request catches integration problems that unit tests cannot: migrations against a real Postgres, the actual ingress path, the actual secret references. Give each one a TTL, a seeded dataset and a namespace quota, or the preview fleet quietly becomes the largest line on the bill.",
            "Drift is the gap between what the repository says and what the cluster runs. Render the manifests in CI and diff them against the live objects on a schedule: any difference is either a hotfix that must be committed or a manual change that must be reverted. Both outcomes need a human, and both are invisible without the diff.",
          ],
          code: `name: drift
on:
  schedule: [{ cron: "0 6 * * *" }]
  workflow_dispatch:
jobs:
  diff:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: azure/setup-kubectl@v5
      - run: kubectl kustomize kustomize/overlays/prod > rendered.yaml
      - run: |
          kubectl diff -f rendered.yaml > drift.txt || true
          if [ -s drift.txt ]; then
            echo "drift detected between git and the cluster"
            cat drift.txt
            exit 1
          fi`,
          tip:
            "Give preview namespaces a TTL controller and a resource quota. Without both, abandoned environments from closed pull requests will outlive the feature they were built for.",
        },
      ],
      exercise: {
        prompt:
          "Write check_parity that rejects a key present in only one environment and a value that differs outside the allowlist; prove both failures and the passing case in main.",
        starter: `use std::collections::BTreeMap;

const ALLOWED_DIFFS: [&str; 3] = ["db.host", "replicas", "log_level"];

fn check_parity(
    staging: &BTreeMap<String, String>,
    prod: &BTreeMap<String, String>,
) -> Result<(), Vec<String>> {
    // TODO: key missing on one side is a problem
    // TODO: differing value outside ALLOWED_DIFFS is a problem
    todo!()
}

fn main() {
    let staging = BTreeMap::new();
    let prod = BTreeMap::new();
    assert!(check_parity(&staging, &prod).is_ok());
    println!("parity check");
}`,
        hint:
          "Iterate over the staging map with prod.get(key); push a message for None, and for Some where the values differ and ALLOWED_DIFFS does not contain the key. Return Err only when the vector is non-empty.",
        solution: `use std::collections::BTreeMap;

const ALLOWED_DIFFS: [&str; 3] = ["db.host", "replicas", "log_level"];

fn check_parity(
    staging: &BTreeMap<String, String>,
    prod: &BTreeMap<String, String>,
) -> Result<(), Vec<String>> {
    let mut problems = Vec::new();
    for (key, staging_value) in staging {
        match prod.get(key) {
            None => problems.push(format!("{key}: missing in prod")),
            Some(prod_value)
                if prod_value != staging_value && !ALLOWED_DIFFS.contains(&key.as_str()) =>
            {
                problems.push(format!("{key}: {staging_value} vs {prod_value}"));
            }
            Some(_) => {}
        }
    }
    if problems.is_empty() { Ok(()) } else { Err(problems) }
}

fn main() {
    let staging = BTreeMap::from([
        ("db.host".to_string(), "staging-db".to_string()),
        ("replicas".to_string(), "2".to_string()),
        ("timeout_ms".to_string(), "3000".to_string()),
    ]);
    let prod = BTreeMap::from([
        ("db.host".to_string(), "prod-db".to_string()),
        ("replicas".to_string(), "12".to_string()),
        ("timeout_ms".to_string(), "3000".to_string()),
    ]);
    assert!(check_parity(&staging, &prod).is_ok());

    let mut drifted = prod.clone();
    drifted.insert("timeout_ms".to_string(), "9000".to_string());
    assert_eq!(check_parity(&staging, &drifted).unwrap_err().len(), 1);

    let mut missing = prod.clone();
    missing.remove("replicas");
    assert_eq!(check_parity(&staging, &missing).unwrap_err().len(), 1);

    println!("allowed differences pass; timeout drift and a missing key fail");
}`,
      },
      questions: [
        {
          q: "Staging passes and production fails after someone changed a timeout in one overlay. Which rule would have caught it?",
          options: [
            "Replica counts must match across environments",
            "Any key that differs outside the reviewed allowlist fails the parity check",
            "Images must share the same tag",
            "Staging must use production credentials",
          ],
          answer: 1,
          explain:
            "Endpoint, scale and a few flags are legitimate differences; a timeout is behaviour. An allowlist turns that judgement into a check, and the check runs on rendered configuration so it catches an overlay that was never mirrored.",
        },
        {
          q: "Why promote an image digest instead of rebuilding per environment?",
          options: [
            "Digests are shorter to type",
            "A rebuild can change the toolchain, lockfile resolution or base image, so staging no longer tested what production runs",
            "Digests avoid registry rate limits",
            "Kubernetes cannot pull tagged images",
          ],
          answer: 1,
          explain:
            "The point of staging is to test the artifact. Rebuilding introduces a second artifact with the same name, and the difference is invisible until production behaves differently from the environment where it passed.",
        },
        {
          q: "kustomize reports that a patch matched no resource. What should CI do?",
          options: [
            "Warn and continue, patches are best effort",
            "Fail the build, because an unmatched patch means the environment differs from what the overlay claims",
            "Delete the overlay and apply the base",
            "Apply the base twice",
          ],
          answer: 1,
          explain:
            "An unmatched patch is silent drift: the overlay says replicas are 12 and the cluster still runs 2. Failing the build keeps the overlay honest, which is the only reason to have one.",
        },
      ],
      quickbytes: [
        "Promote by digest; a rebuild per environment is a different artifact with the same tag.",
        "Allowlist the differences: endpoints, scale, credential refs, flags. Everything else must be identical.",
        "Run kubectl diff against the live cluster daily; drift is either an uncommitted hotfix or an unauthorised change.",
      ],
      production: [
        "One immutable image digest is promoted from staging to production, and no environment rebuilds from source.",
        "Environment differences are limited to a reviewed allowlist, and a parity check fails the build otherwise.",
        "Overlays patch only what differs, and an unmatched patch is a build error.",
        "Preview environments have a TTL, a namespace quota and seeded data, and are deleted automatically.",
        "A scheduled diff between rendered manifests and the live cluster reports drift to the owning team.",
      ],
      crates: ["config", "serde", "toml", "anyhow"],
      github: [
        {
          name: "kubernetes-sigs/kustomize",
          url: "https://github.com/kubernetes-sigs/kustomize",
        },
        {
          name: "rust-cli/config-rs",
          url: "https://github.com/rust-cli/config-rs",
        },
      ],
      pitfall:
        "Fixing a probe only in the staging overlay: production keeps the old probe for months, and the first rollout after the change restarts every pod at once. Patch the base and keep overlays to values that genuinely differ.",
      resources: [
        {
          title: "config: layered configuration with typed deserialization",
          url: "https://docs.rs/config/latest/config/",
          kind: "docs",
        },
        {
          title: "kustomize: bases, overlays and patches",
          url: "https://github.com/kubernetes-sigs/kustomize",
          kind: "repo",
        },
        {
          title: "config-rs: sources, merging and environment overrides",
          url: "https://github.com/rust-cli/config-rs",
          kind: "repo",
        },
        {
          title: "CNCF: GitOps, environment promotion and drift",
          url: "https://www.youtube.com/@CNCF",
          kind: "video",
        },
      ],
    },
    {
      id: "g14",
      title: "Secret rotation: overlap, dual verification, expiry",
      minutes: 80,
      level: "industry",
      goal:
        "Rotate database credentials, API keys and signing keys on a schedule with overlapping validity and atomic reloads, so rotation never needs a deploy and never fails a request.",
      sections: [
        {
          h: "Rotation needs an overlap, not a flag day",
          p: [
            "A secret replaced in one step has a window where some processes hold the old value and some hold the new one. The only safe pattern is overlap: create the new credential, distribute it, wait until every consumer has it, then revoke the old one. For signing keys, sign with the newest key and verify with the newest and the previous key until the overlap expires.",
            "That means every secret needs a version and an activation time, and every consumer must be able to hold more than one valid value. A keyring with current and previous is the minimum; a database user needs two passwords, or a credential with a short lease that is renewed before it expires.",
          ],
          code: `#[derive(Debug, Clone)]
pub struct Key {
    pub version: u32,
    pub bytes: Vec<u8>,
}

#[derive(Debug)]
pub struct KeyRing {
    pub current: Key,
    pub previous: Option<Key>,
}

impl KeyRing {
    pub fn sign(&self, payload: &[u8]) -> (u32, Vec<u8>) {
        // Toy MAC: the state machine is the point, not the cipher.
        (self.current.version, xor(payload, &self.current.bytes))
    }

    /// Accept the previous key during the overlap window.
    pub fn verify(&self, payload: &[u8], version: u32, tag: &[u8]) -> bool {
        let key = if version == self.current.version {
            Some(&self.current)
        } else {
            self.previous.as_ref().filter(|key| key.version == version)
        };
        match key {
            Some(key) => xor(payload, &key.bytes) == tag,
            None => false,
        }
    }

    pub fn rotate(&mut self, next: Key) {
        self.previous = Some(std::mem::replace(&mut self.current, next));
    }
}

fn xor(payload: &[u8], key: &[u8]) -> Vec<u8> {
    payload.iter().zip(key.iter().cycle()).map(|(a, b)| a ^ b).collect()
}

fn main() {
    let mut ring = KeyRing {
        current: Key { version: 1, bytes: b"k1".to_vec() },
        previous: None,
    };
    let (v1, tag1) = ring.sign(b"invoice:42");

    ring.rotate(Key { version: 2, bytes: b"k2".to_vec() });
    let (v2, _) = ring.sign(b"invoice:42");
    assert_eq!(v2, 2);
    assert!(ring.verify(b"invoice:42", v1, &tag1));      // old token still validates

    ring.rotate(Key { version: 3, bytes: b"k3".to_vec() });
    assert!(!ring.verify(b"invoice:42", v1, &tag1));     // overlap over: v1 is gone
    println!("keyring: overlap closed after two rotations");
}`,
          tip:
            "A real implementation uses HMAC-SHA256 or Ed25519 per version, never a hand-rolled construction. The overlap rule is the same; only the primitive changes.",
        },
        {
          h: "Fetch at boot, refresh on a timer, cache with an expiry",
          p: [
            "A secret fetched once at boot and held forever outlives its rotation. Fetch it through the platform identity, cache it with an expiry slightly shorter than the lease, and refresh in the background before it expires. On refresh failure you must choose: keep serving with the still-valid value, or fail closed. Write that decision down per secret.",
            "Never put the plaintext in a log line, a span field, a panic message or an error string. secrecy makes that hard to do by accident, and zeroize clears the buffer when the value is dropped, which shrinks the window in a core dump. Neither replaces a rotation schedule.",
          ],
          code: `use arc_swap::ArcSwap;
use secrecy::{ExposeSecret, SecretString};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub struct CachedSecret {
    value: SecretString,
    expires_at: Instant,
}

pub struct SecretCache {
    slot: ArcSwap<CachedSecret>,
    ttl: Duration,
}

impl SecretCache {
    pub fn new(initial: SecretString, ttl: Duration) -> Self {
        Self {
            slot: ArcSwap::from_pointee(CachedSecret {
                value: initial,
                expires_at: Instant::now() + ttl,
            }),
            ttl,
        }
    }

    /// In-flight callers keep their snapshot while a refresh swaps in a new one.
    pub fn get(&self) -> Arc<CachedSecret> {
        self.slot.load_full()
    }

    pub fn needs_refresh(&self) -> bool {
        Instant::now() >= self.slot.load().expires_at
    }

    pub fn store(&self, next: SecretString) {
        self.slot.store(Arc::new(CachedSecret {
            value: next,
            expires_at: Instant::now() + self.ttl,
        }));
    }

    pub fn expose(&self) -> String {
        self.get().value.expose_secret().to_string()
    }
}`,
          tip:
            "Set the cache TTL to sixty percent of the lease and refresh in the background. A TTL equal to the lease means a slow refresh leaves live requests holding an expired credential.",
        },
        {
          h: "Rotate the credentials nobody remembers",
          p: [
            "Inventory the secrets before writing a rotation job: database users, TLS certificates, webhook signing secrets, JWT signing keys, object-storage keys, third-party API tokens, CI deploy keys, and the data-encryption keys behind envelope encryption. Each has a different blast radius: a stale TLS certificate breaks every browser, while a stale webhook secret breaks one integration silently.",
            "Automate what the platform can own. cert-manager renews certificates before expiry, a secrets operator syncs a managed value into the cluster, and a rotation controller can update a database password and trigger a reload. For the rest, put the expiry date into monitoring and page the owner a week ahead, not the minute after it fails.",
          ],
          code: `apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: ledger-api
  namespace: ledger-prod
spec:
  secretName: ledger-api-tls
  duration: 2160h          # 90 days
  renewBefore: 360h        # renew 15 days before expiry
  privateKey:
    rotationPolicy: Always # new private key on every renewal, not just a new cert
  dnsNames:
    - api.example.com
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
---
# Verify the renewal path rather than trusting it:
#   kubectl -n ledger-prod get certificate ledger-api
#   kubectl -n ledger-prod describe certificate ledger-api | grep -A2 Events`,
          tip:
            "Rotating the certificate but not the key leaves the old private key valid for the next certificate. Set rotationPolicy: Always unless you have a specific reason to reuse the key.",
        },
      ],
      exercise: {
        prompt:
          "Implement a keyring that signs with the current version, verifies with current and previous, rejects unknown versions, and drops the previous key after the second rotation.",
        starter: `#[derive(Debug, Clone)]
struct Key {
    version: u32,
    bytes: Vec<u8>,
}

#[derive(Debug)]
struct KeyRing {
    current: Key,
    previous: Option<Key>,
}

impl KeyRing {
    // TODO: sign with current, return (version, tag)
    fn sign(&self, payload: &[u8]) -> (u32, Vec<u8>) {
        todo!()
    }

    // TODO: accept current or previous, reject anything else
    fn verify(&self, payload: &[u8], version: u32, tag: &[u8]) -> bool {
        todo!()
    }

    fn rotate(&mut self, next: Key) {
        // TODO: previous becomes the old current
        todo!()
    }
}

fn main() {
    let mut ring = KeyRing {
        current: Key { version: 1, bytes: b"k1".to_vec() },
        previous: None,
    };
    let (v1, tag1) = ring.sign(b"invoice:42");
    ring.rotate(Key { version: 2, bytes: b"k2".to_vec() });
    assert!(ring.verify(b"invoice:42", v1, &tag1));
    println!("old version still verifies during overlap");
}`,
        hint:
          "For verify, pick Some(current) when the version matches, otherwise previous filtered by version; XOR the payload with the chosen key and compare with the tag. rotate uses std::mem::replace to move current into previous.",
        solution: `#[derive(Debug, Clone)]
struct Key {
    version: u32,
    bytes: Vec<u8>,
}

#[derive(Debug)]
struct KeyRing {
    current: Key,
    previous: Option<Key>,
}

impl KeyRing {
    fn sign(&self, payload: &[u8]) -> (u32, Vec<u8>) {
        (self.current.version, xor(payload, &self.current.bytes))
    }

    fn verify(&self, payload: &[u8], version: u32, tag: &[u8]) -> bool {
        let key = if version == self.current.version {
            Some(&self.current)
        } else {
            self.previous.as_ref().filter(|key| key.version == version)
        };
        match key {
            Some(key) => xor(payload, &key.bytes) == tag,
            None => false,
        }
    }

    fn rotate(&mut self, next: Key) {
        self.previous = Some(std::mem::replace(&mut self.current, next));
    }
}

fn xor(payload: &[u8], key: &[u8]) -> Vec<u8> {
    payload
        .iter()
        .zip(key.iter().cycle())
        .map(|(a, b)| a ^ b)
        .collect()
}

fn main() {
    let mut ring = KeyRing {
        current: Key { version: 1, bytes: b"k1".to_vec() },
        previous: None,
    };
    let (v1, tag1) = ring.sign(b"invoice:42");

    ring.rotate(Key { version: 2, bytes: b"k2".to_vec() });
    assert!(ring.verify(b"invoice:42", v1, &tag1));       // overlap window
    assert!(!ring.verify(b"invoice:42", 99, &tag1));     // unknown version

    ring.rotate(Key { version: 3, bytes: b"k3".to_vec() });
    assert!(!ring.verify(b"invoice:42", v1, &tag1));     // v1 dropped

    println!("rotation: current and previous accepted, then only the last two");
}`,
      },
      questions: [
        {
          q: "You rotate a JWT signing key by replacing it everywhere at once. What happens?",
          options: [
            "Tokens become longer",
            "Every token signed with the old key fails validation until it expires, logging out active users",
            "The JWT specification rejects the new key",
            "Rotation has no observable effect",
          ],
          answer: 1,
          explain:
            "Issued tokens are signed with the old key and cannot be re-signed in flight. Without an overlap that accepts the previous key for at least the token lifetime, a key rotation is a forced logout for every active session.",
        },
        {
          q: "A secret is cached with a 5-minute TTL and the credential lease is 60 minutes. What is the residual risk?",
          options: [
            "None, the cache expires first",
            "A revoked credential can still be used for up to 5 minutes, which must fit the blast-radius budget",
            "The process will re-fetch on every request",
            "The lease will expire before the cache",
          ],
          answer: 1,
          explain:
            "Caching means revocation is eventual, not immediate. Five minutes is usually acceptable, but it has to be a deliberate decision recorded with the secret, because it is exactly the window an incident responder cares about.",
        },
        {
          q: "Which rotation requires an overlap window rather than an atomic swap?",
          options: [
            "A database password used by forty running pods",
            "A feature flag",
            "A log level",
            "A replica count",
          ],
          answer: 0,
          explain:
            "Forty pods cannot all switch in the same instant, and the ones that reconnect during the change would fail authentication. Create the new password, roll the fleet, then revoke the old one after the last consumer has switched.",
        },
      ],
      quickbytes: [
        "New credential in, old credential still valid, then revoke: rotation without overlap is an outage with extra steps.",
        "Verify with N and N-1 and sign with N; drop N-1 only after the longest token lifetime has passed.",
        "Alert on certificate and lease expiry a week ahead, to the owning team, not to a shared inbox.",
      ],
      production: [
        "Every secret has a version, an owner, a rotation interval and an expiry alert.",
        "Rotation creates the new value before revoking the old one, with a documented overlap window.",
        "Consumers verify with the current and previous key and sign only with the current key.",
        "Secrets are fetched through workload identity and cached with a TTL shorter than the lease.",
        "TLS certificates and database credentials renew automatically, and a failed renewal pages before expiry.",
      ],
      crates: ["secrecy", "zeroize", "arc-swap", "tokio"],
      github: [
        {
          name: "hashicorp/vault",
          url: "https://github.com/hashicorp/vault",
        },
        {
          name: "external-secrets/external-secrets",
          url: "https://github.com/external-secrets/external-secrets",
        },
      ],
      pitfall:
        "Rotating a database password with a single ALTER USER: pods that reconnect after the change fail authentication, and the rollout cannot finish because the new pods cannot connect either. Always create the overlap first.",
      resources: [
        {
          title: "secrecy: redacted secret wrappers that resist Debug leaks",
          url: "https://docs.rs/secrecy/latest/secrecy/",
          kind: "docs",
        },
        {
          title: "Kubernetes Secrets: mount, update and exposure semantics",
          url: "https://kubernetes.io/docs/concepts/configuration/secret/",
          kind: "docs",
        },
        {
          title: "hashicorp/vault: leases, dynamic credentials and rotation",
          url: "https://github.com/hashicorp/vault",
          kind: "repo",
        },
        {
          title: "HashiCorp: Vault leases, dynamic secrets and PKI",
          url: "https://www.youtube.com/@HashiCorp",
          kind: "video",
        },
      ],
    },
    {
      id: "g15",
      title: "Canary and blue/green with automated metric gates",
      minutes: 75,
      level: "industry",
      goal:
        "Shift traffic in measured steps, gate every step on error rate and latency against the stable fleet, and roll back automatically when the evidence says the new version is worse.",
      sections: [
        {
          h: "Two strategies, two different bets",
          p: [
            "Blue/green runs two complete fleets and switches traffic at the load balancer. Rollback is a switch back and takes seconds, but you pay for double capacity during the change and the database must tolerate both versions at once. Canary runs a small slice of the new version beside the old one and grows it. Rollback is also a traffic shift, but a canary needs enough traffic to produce a signal, which rules it out for low-volume internal services.",
            "Neither strategy fixes a schema change. If the new version writes a column the old version cannot read, a canary corrupts data for the canary's share of requests. Expand and contract the schema first, ship compatible code, and only then use traffic shaping to bound the blast radius.",
          ],
          code: `apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: ledger-api
spec:
  replicas: 12
  strategy:
    canary:
      analysis:
        templates: [{ templateName: ledger-success-rate }]
        startingStep: 1
      steps:
        - setWeight: 5
        - pause: { duration: 5m }
        - setWeight: 25
        - pause: { duration: 10m }
        - setWeight: 50
        - pause: { duration: 10m }
        - setWeight: 100
      trafficRouting:
        nginx:
          stableService: ledger-api-stable
          canaryService: ledger-api-canary`,
          tip:
            "Set the analysis template to read both the canary and the stable service. A template that only queries the canary has no baseline and will promote a version that is uniformly worse.",
        },
        {
          h: "A gate needs a baseline, a sample floor and a delta",
          p: [
            "Comparing the canary to a fixed threshold answers the wrong question: a canary that is three percent worse than the stable fleet is a regression even when it is still inside the SLO. Compare against the stable fleet over the same window, and require a minimum number of requests before the comparison means anything. Twenty requests produce a p99 that is mostly noise.",
            "Gate on the signals that map to user pain: error rate, latency at the percentile you promise, and saturation of pools and CPU. Add one business metric for the endpoint that matters, such as checkout completion. Hold when the sample is too small, promote only when every gate passes, and roll back on a hard failure rather than waiting for the next step.",
          ],
          code: `#[derive(Debug, Clone, Copy)]
pub struct Sample {
    pub requests: u64,
    pub errors: u64,
    pub p99_ms: f64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Promote,
    Hold,
    Rollback,
}

#[derive(Debug, Clone, Copy)]
pub struct Gate {
    pub min_requests: u64,
    pub max_error_rate: f64,
    pub max_p99_ratio: f64,
}

impl Gate {
    pub fn evaluate(&self, canary: Sample, stable: Sample) -> Action {
        if canary.requests < self.min_requests {
            return Action::Hold;               // not enough evidence either way
        }
        let error_rate = canary.errors as f64 / canary.requests as f64;
        if error_rate > self.max_error_rate {
            return Action::Rollback;
        }
        if stable.p99_ms > 0.0 && canary.p99_ms / stable.p99_ms > self.max_p99_ratio {
            return Action::Rollback;
        }
        Action::Promote
    }
}

fn main() {
    let gate = Gate { min_requests: 1_000, max_error_rate: 0.005, max_p99_ratio: 1.10 };
    let stable = Sample { requests: 50_000, errors: 100, p99_ms: 180.0 };

    let small = Sample { requests: 200, errors: 0, p99_ms: 180.0 };
    assert_eq!(gate.evaluate(small, stable), Action::Hold);

    let worse = Sample { requests: 5_000, errors: 10, p99_ms: 230.0 };
    assert_eq!(gate.evaluate(worse, stable), Action::Rollback);   // 1.28x p99

    let good = Sample { requests: 5_000, errors: 5, p99_ms: 190.0 };
    assert_eq!(gate.evaluate(good, stable), Action::Promote);

    println!("gate: hold on a small sample, rollback on a 28 percent p99 regression");
}`,
          tip:
            "Gate on the delta to stable plus an absolute ceiling. The delta catches regressions inside the SLO; the ceiling stops a release during an incident that already broke the baseline.",
        },
        {
          h: "Rollback is a feature you have to exercise",
          p: [
            "An automatic rollback that has never fired is a rumour. Test it in staging by injecting a failing gate, and confirm the abort path stops traffic shifting, scales the canary down and leaves the stable fleet untouched. Time the whole operation: if rollback takes eight minutes, the canary window must be shorter than the budget it is protecting.",
            "Keep the previous version deployable for at least the length of a request and a session. A rollback that cannot read what the new version just wrote is not a rollback, which is the same expand-and-contract discipline applied to the whole release rather than only to the schema.",
          ],
          code: `# Watch the rollout and the analysis run together; the gate result is in the
# analysis run, not in the pod status.
kubectl argo rollouts get rollout ledger-api --watch

# A failed analysis aborts automatically. Trigger it deliberately in a drill:
kubectl argo rollouts abort ledger-api

# Undo the rollout: traffic returns to the stable ReplicaSet.
kubectl argo rollouts undo ledger-api

# Prove the old version can still read what the new one wrote, before you
# rely on undo during an incident.
kubectl exec deploy/ledger-api-stable -- /usr/local/bin/ledger-api --self-check

# Confirm the traffic split you believe you have.
kubectl get svc ledger-api-stable ledger-api-canary -o wide`,
          tip:
            "Record rollback duration in the drill report. It belongs in the same table as restore time, because during an incident it is the number that decides whether you roll back or roll forward.",
        },
      ],
      exercise: {
        prompt:
          "Implement the gate: hold below the minimum sample, roll back when the canary error rate exceeds the threshold or its p99 exceeds 1.1x stable, otherwise promote.",
        starter: `#[derive(Debug, Clone, Copy)]
struct Sample {
    requests: u64,
    errors: u64,
    p99_ms: f64,
}

#[derive(Debug, PartialEq, Eq)]
enum Action {
    Promote,
    Hold,
    Rollback,
}

fn evaluate(canary: Sample, stable: Sample, min_requests: u64) -> Action {
    // TODO: sample floor first, then error rate, then p99 ratio
    todo!()
}

fn main() {
    let stable = Sample { requests: 50_000, errors: 100, p99_ms: 180.0 };
    let small = Sample { requests: 200, errors: 0, p99_ms: 180.0 };
    assert_eq!(evaluate(small, stable, 1_000), Action::Hold);
    println!("gate holds on a small sample");
}`,
        hint:
          "Check canary.requests first and return Hold. Then compute errors / requests and compare with 0.005; then compare canary.p99_ms / stable.p99_ms with 1.10, guarding against a zero stable p99.",
        solution: `#[derive(Debug, Clone, Copy)]
struct Sample {
    requests: u64,
    errors: u64,
    p99_ms: f64,
}

#[derive(Debug, PartialEq, Eq)]
enum Action {
    Promote,
    Hold,
    Rollback,
}

fn evaluate(canary: Sample, stable: Sample, min_requests: u64) -> Action {
    if canary.requests < min_requests {
        return Action::Hold;
    }

    let error_rate = canary.errors as f64 / canary.requests as f64;
    if error_rate > 0.005 {
        return Action::Rollback;
    }

    if stable.p99_ms > 0.0 && canary.p99_ms / stable.p99_ms > 1.10 {
        return Action::Rollback;
    }

    Action::Promote
}

fn main() {
    let stable = Sample { requests: 50_000, errors: 100, p99_ms: 180.0 };

    let small = Sample { requests: 200, errors: 0, p99_ms: 180.0 };
    assert_eq!(evaluate(small, stable, 1_000), Action::Hold);

    let error_spike = Sample { requests: 5_000, errors: 40, p99_ms: 180.0 };
    assert_eq!(evaluate(error_spike, stable, 1_000), Action::Rollback);

    let latency_spike = Sample { requests: 5_000, errors: 0, p99_ms: 200.0 };
    assert_eq!(evaluate(latency_spike, stable, 1_000), Action::Rollback);

    let healthy = Sample { requests: 5_000, errors: 2, p99_ms: 185.0 };
    assert_eq!(evaluate(healthy, stable, 1_000), Action::Promote);

    println!("gate: hold, rollback on errors or latency, promote on healthy traffic");
}`,
      },
      questions: [
        {
          q: "The canary has served 150 requests with zero errors. Why should the gate hold?",
          options: [
            "Zero errors always means success",
            "150 requests cannot distinguish a 0.5 percent error rate from zero, so the sample is too small",
            "The stable fleet has not been measured",
            "Rollouts require exactly 1,000 requests per step",
          ],
          answer: 1,
          explain:
            "At 150 requests, a 0.5 percent error rate would produce fewer than one expected error. Promoting on that evidence is a coin flip; holding until the sample floor is reached costs a few minutes and prevents a fleet-wide regression.",
        },
        {
          q: "Which change is unsafe to validate with a canary?",
          options: [
            "A new timeout",
            "A schema change the old version cannot read",
            "A log level change",
            "A new HTTP route",
          ],
          answer: 1,
          explain:
            "A canary splits traffic, not data. If both versions write to a schema only one understands, the canary's share of requests produces data the stable fleet cannot process, and a rollback does not undo it.",
        },
        {
          q: "Why is blue/green rollback fast?",
          options: [
            "The new fleet is deleted before the switch",
            "Traffic is switched back to the old fleet, which is still running",
            "The database is restored from backup",
            "Pods restart faster in a second ReplicaSet",
          ],
          answer: 1,
          explain:
            "Blue/green keeps both fleets warm and switches at the load balancer, so rollback is a routing change measured in seconds. The cost is double capacity during the change and a database that must serve both versions.",
        },
      ],
      quickbytes: [
        "Gate on the ratio to stable, not on the SLO: a canary can be inside the SLO and still be a 30 percent regression.",
        "Require a sample floor of 1,000+ requests and hold, never promote, when the evidence is thin.",
        "Inject a failing gate in staging once a quarter; an untested rollback is a hope, not a control.",
      ],
      production: [
        "Every canary step gates on error rate and p99 relative to the stable fleet, with a minimum sample size.",
        "A failed gate aborts automatically, and rollback duration is measured against the incident budget.",
        "Schema changes ship expand-first so both versions can read and write during the rollout.",
        "Blue/green keeps the old fleet running until the new one passes the same gates.",
        "The abort path is exercised in staging at least quarterly, with the timing recorded.",
      ],
      crates: ["serde", "metrics", "tracing", "tokio"],
      github: [
        {
          name: "argoproj/argo-rollouts",
          url: "https://github.com/argoproj/argo-rollouts",
        },
        {
          name: "fluxcd/flagger",
          url: "https://github.com/fluxcd/flagger",
        },
      ],
      pitfall:
        "Canarying a breaking schema change: five percent of requests write data the stable version cannot read, so the incident starts before the canary reaches twenty-five percent and a rollback no longer restores consistency.",
      resources: [
        {
          title: "argo-rollouts: canary, blue/green and analysis runs",
          url: "https://github.com/argoproj/argo-rollouts",
          kind: "repo",
        },
        {
          title: "flagger: progressive delivery with metric checks",
          url: "https://github.com/fluxcd/flagger",
          kind: "repo",
        },
        {
          title: "Kubernetes Deployments: rollout and rollback semantics",
          url: "https://kubernetes.io/docs/concepts/workloads/controllers/deployment/",
          kind: "docs",
        },
        {
          title: "CNCF: progressive delivery and deployment safety",
          url: "https://www.youtube.com/@CNCF",
          kind: "video",
        },
      ],
    },
    {
      id: "g16",
      title: "Migration ordering: expand, backfill, contract",
      minutes: 90,
      level: "industry",
      goal:
        "Ship schema changes in steps that old and new code both survive, run them as an idempotent job before the rollout, and backfill large tables without locking production.",
      sections: [
        {
          h: "Two versions of the code, one schema",
          p: [
            "A rolling deploy means the old and new versions run at the same time against the same database, so every migration must be compatible with both. The safe sequence is expand (add a nullable column, a new table, a new index), migrate (dual write, backfill in batches), switch reads, then contract (drop the old column) in a later release, after the old version is gone.",
            "A migration that drops a column in the same release that stops writing it will fail on pods still running the old code, and those pods keep serving traffic until the rollout completes. The rule is boring and absolute: removal is a separate deploy, and only after nothing reads the thing.",
          ],
          code: `-- 0007_expand.sql — deploy 1: old and new code must both work
ALTER TABLE invoices ADD COLUMN currency char(3);

-- CREATE INDEX CONCURRENTLY cannot run inside a transaction. Apply it from a
-- step that does not wrap it, or build a plain index during a maintenance
-- window on a small table.
CREATE INDEX CONCURRENTLY invoices_currency_pending_idx
    ON invoices (id) WHERE currency IS NULL;

-- 0008_backfill.sql — deploy 2: code dual-writes; a job backfills history
UPDATE invoices SET currency = 'USD'
WHERE id IN (
    SELECT id FROM invoices WHERE currency IS NULL LIMIT 1000
);

-- 0009_contract.sql — deploy 4: nothing reads amount_cents anymore
ALTER TABLE invoices DROP COLUMN amount_cents;`,
          tip:
            "Name migrations by version and description, and never edit one after it has run anywhere: sqlx records a hash and fails the deploy when an applied migration changes.",
        },
        {
          h: "Run migrations as a job, before the rollout",
          p: [
            "Running migrations from application startup races every replica against the same DDL. Some block, some fail, and a failed migration leaves a half-applied schema in the middle of a rollout. Run them in a dedicated job that completes before the Deployment is updated, with an advisory lock so two jobs cannot overlap.",
            "sqlx embeds the migration set in the binary and records applied versions in a table, so the job is the same artifact as the service and the history is verified by checksum. A migration that changed after it was applied fails the check, which is exactly what you want: edited history is how two environments silently diverge.",
          ],
          code: `use sqlx::postgres::PgPoolOptions;
use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    let url = match std::env::var("DATABASE_URL") {
        Ok(url) => url,
        Err(_) => {
            eprintln!("DATABASE_URL is required");
            return ExitCode::FAILURE;
        }
    };

    // One connection: the migration job serialises itself, and the advisory
    // lock inside the migrator keeps a second job from running concurrently.
    let pool = match PgPoolOptions::new().max_connections(1).connect(&url).await {
        Ok(pool) => pool,
        Err(error) => {
            eprintln!("connect failed: {error}");
            return ExitCode::FAILURE;
        }
    };

    // Embeds ./migrations at compile time and validates checksums of applied ones.
    match sqlx::migrate!("./migrations").run(&pool).await {
        Ok(()) => {
            println!("migrations applied");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("migration failed: {error}");
            ExitCode::FAILURE
        }
    }
}`,
          tip:
            "Add build.rs with println!(\"cargo:rerun-if-changed=migrations\"). Without it, adding a migration does not recompile the binary and the job silently applies the old embedded set.",
        },
        {
          h: "Backfills are batch jobs with a throttle",
          p: [
            "An UPDATE over ten million rows takes locks, bloats the table and can saturate IO for minutes. Batch it: a thousand rows at a time, ordered by primary key, with a short sleep between batches and a metric for rows remaining. Watch replication lag and lock waits while it runs, and make the job restartable so a crash resumes instead of starting over.",
            "Set lock_timeout and statement_timeout on the session so a blocked statement fails fast instead of queueing every query behind it. For large tables, verify the plan with EXPLAIN, and test the migration against a production-sized snapshot; a backfill that takes forty seconds on a laptop-sized fixture can take four hours in production.",
          ],
          code: `use sqlx::PgPool;
use std::time::Duration;

pub async fn backfill_currency(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let mut total = 0u64;
    loop {
        let rows = sqlx::query(
            r#"
            UPDATE invoices
               SET currency = 'USD'
             WHERE id IN (
                 SELECT id FROM invoices
                  WHERE currency IS NULL
                  ORDER BY id
                  LIMIT 1000
                  FOR UPDATE SKIP LOCKED
             )
            "#,
        )
        .execute(pool)
        .await?
        .rows_affected();

        total += rows;
        metrics::counter!("backfill_rows_total").increment(rows);

        if rows < 1_000 {
            return Ok(total);
        }
        // Give replicas and autovacuum room to breathe between batches.
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}`,
          tip:
            "FOR UPDATE SKIP LOCKED lets concurrent workers share the backfill without blocking each other. Run two or three of them rather than one very large transaction.",
        },
      ],
      exercise: {
        prompt:
          "Order the steps that rename invoices.amount_cents to amount_minor: return them in deployment order and assert that the drop is last and comes after the read switch.",
        starter: `#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Step {
    AddNewColumn,
    DualWrite,
    Backfill,
    SwitchReads,
    StopWritingOld,
    DropOldColumn,
}

fn rename_plan() -> Vec<Step> {
    // TODO: return the six steps in the only safe order
    todo!()
}

fn main() {
    let plan = rename_plan();
    assert_eq!(plan.first(), Some(&Step::AddNewColumn));
    assert_eq!(plan.last(), Some(&Step::DropOldColumn));
    println!("plan has {} steps", plan.len());
}`,
        hint:
          "Add the new column, dual-write, backfill, switch reads, stop writing the old column, then drop it. The drop is a later release than the read switch, not the same one.",
        solution: `#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Step {
    AddNewColumn,
    DualWrite,
    Backfill,
    SwitchReads,
    StopWritingOld,
    DropOldColumn,
}

fn rename_plan() -> Vec<Step> {
    vec![
        Step::AddNewColumn,    // deploy 1: additive, both versions compatible
        Step::DualWrite,       // deploy 2: write both, old readers unaffected
        Step::Backfill,        // job: copy history in batches
        Step::SwitchReads,     // deploy 3: read new, old column still populated
        Step::StopWritingOld,  // deploy 4: nothing writes the old column
        Step::DropOldColumn,   // deploy 5: only after the old version is gone
    ]
}

fn main() {
    let plan = rename_plan();
    assert_eq!(plan.first(), Some(&Step::AddNewColumn));
    assert_eq!(plan.last(), Some(&Step::DropOldColumn));

    let switch_at = plan.iter().position(|step| *step == Step::SwitchReads).unwrap();
    let drop_at = plan.iter().position(|step| *step == Step::DropOldColumn).unwrap();
    assert!(drop_at > switch_at, "the drop must come after the read switch");
    assert!(drop_at - switch_at >= 2, "removal is at least one release later");

    println!("{} steps, drop at {drop_at} after the switch at {switch_at}", plan.len());
}`,
      },
      questions: [
        {
          q: "Why can't you drop the old column in the same deploy that stops using it?",
          options: [
            "Postgres forbids it in a transaction",
            "Pods running the previous version still query it while the rollout completes",
            "The column is required by the index",
            "Dropping a column is not transactional",
          ],
          answer: 1,
          explain:
            "During a rolling deploy, old pods keep serving traffic and issuing queries that reference the column. Dropping it times out those requests and can fail the rollout, which is why removal lives in a later release after the old version is gone.",
        },
        {
          q: "CREATE INDEX CONCURRENTLY fails inside the migration because it runs in a transaction. What is the correct fix?",
          options: [
            "Use a larger instance",
            "Apply the concurrent build from a step that does not wrap it in a transaction",
            "Run the migration twice",
            "Disable the migration lock",
          ],
          answer: 1,
          explain:
            "Postgres refuses CREATE INDEX CONCURRENTLY inside a transaction block. Keep the statement in a non-transactional step, such as a dedicated job or a tool with an explicit non-transactional migration, and do not bury it in a wrapped migration file.",
        },
        {
          q: "A migration file is edited after it was applied to staging. What does sqlx do?",
          options: [
            "Silently re-applies it",
            "Fails validation because the recorded checksum no longer matches",
            "Deletes the migrations table",
            "Skips the migration",
          ],
          answer: 1,
          explain:
            "sqlx stores a hash per applied migration. Editing history is a deploy failure, which protects the invariant that every environment applied the same statements in the same order.",
        },
      ],
      quickbytes: [
        "Add nullable, dual-write, backfill, switch reads, stop writes, drop: removal is a separate deploy.",
        "Migrate in a job with an advisory lock, never from every replica's startup path.",
        "Backfill 1,000 rows per batch with a sleep and a rows-remaining metric; watch replication lag while it runs.",
      ],
      production: [
        "Every schema change follows expand, migrate, switch, contract, with removal in a later release.",
        "Migrations run in a dedicated job that completes before the rollout, serialised by a lock.",
        "Applied migrations are never edited; checksums are verified at deploy time and a mismatch fails the job.",
        "Backfills are batched, restartable, throttled and observed, with lock and statement timeouts set.",
        "Destructive changes require a verified backup and an explicit approval recorded on the deployment.",
      ],
      crates: ["sqlx", "tokio", "tracing", "metrics"],
      github: [
        {
          name: "transact-rs/sqlx",
          url: "https://github.com/transact-rs/sqlx",
        },
      ],
      pitfall:
        "Running migrations on application startup with twelve replicas: all twelve race the same DDL, some block on locks, one fails halfway, and the rollout continues against a partially migrated schema.",
      resources: [
        {
          title: "sqlx::migrate!: embedding the migration set in the binary",
          url: "https://docs.rs/sqlx/latest/sqlx/macro.migrate.html",
          kind: "docs",
        },
        {
          title: "sqlx Migrator: run, run_to, undo and locking",
          url: "https://docs.rs/sqlx/latest/sqlx/migrate/struct.Migrator.html",
          kind: "docs",
        },
        {
          title: "PostgreSQL ALTER TABLE: locks and rewrite behaviour",
          url: "https://www.postgresql.org/docs/current/sql-altertable.html",
          kind: "docs",
        },
        {
          title: "transact-rs/sqlx repository and migration examples",
          url: "https://github.com/transact-rs/sqlx",
          kind: "repo",
        },
        {
          title: "InfoQ: zero-downtime schema migration talks",
          url: "https://www.youtube.com/@InfoQ",
          kind: "video",
        },
      ],
    },
    {
      id: "g17",
      title: "Disaster recovery drills with measured RTO and RPO",
      minutes: 70,
      level: "industry",
      goal:
        "State recovery time and data-loss objectives per data class, then prove them with scheduled restore and failover drills whose timings are recorded and published.",
      sections: [
        {
          h: "RTO and RPO are commitments, not adjectives",
          p: [
            "Recovery time objective is how long the service may be down; recovery point objective is how much data you may lose, expressed as time. They are different numbers with different costs: halving RTO usually means a warm standby and automation, while halving RPO means synchronous replication or more frequent log shipping. Write both per data class, because the ledger and the analytics events do not deserve the same budget.",
            "A backup is not a recovery. The only number that matters is the measured time from declared disaster to verified service, including the parts nobody rehearses: KMS keys in another region, DNS TTLs, IAM roles, Terraform state, and the person who knows the runbook. A dashboard that says the backup succeeded proves a file exists, not that it restores.",
          ],
          code: `#[derive(Debug, Clone, Copy)]
pub struct Objective {
    pub rto_minutes: f64,
    pub rpo_minutes: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct Measurement {
    pub restore_minutes: f64,
    pub data_loss_minutes: f64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Met,
    MissedRto,
    MissedRpo,
    MissedBoth,
}

impl Measurement {
    pub fn grade(&self, objective: Objective) -> Verdict {
        let rto_ok = self.restore_minutes <= objective.rto_minutes;
        let rpo_ok = self.data_loss_minutes <= objective.rpo_minutes;
        match (rto_ok, rpo_ok) {
            (true, true) => Verdict::Met,
            (false, true) => Verdict::MissedRto,
            (true, false) => Verdict::MissedRpo,
            (false, false) => Verdict::MissedBoth,
        }
    }
}

fn main() {
    let ledger = Objective { rto_minutes: 60.0, rpo_minutes: 5.0 };

    let measured = Measurement { restore_minutes: 52.0, data_loss_minutes: 3.5 };
    assert_eq!(measured.grade(ledger), Verdict::Met);

    let bad = Measurement { restore_minutes: 71.0, data_loss_minutes: 12.0 };
    assert_eq!(bad.grade(ledger), Verdict::MissedBoth);

    println!(
        "ledger drill: restore {:.0} min, data loss {:.1} min",
        measured.restore_minutes, measured.data_loss_minutes
    );
}`,
          tip:
            "Grade the drill against the objective, never against the previous drill. Getting better at a missed objective is still missing it, and the report should say so in the first line.",
        },
        {
          h: "Restore into a clean environment and verify the data",
          p: [
            "Restore the production snapshot into a new cluster, point a read-only copy of the service at it, and run the checks that would catch a corrupt or incomplete restore: row counts per table, a checksum of ledger totals, the newest and oldest timestamps, and a handful of known records. Only then measure how long the whole path took, from the decision to the first verified read.",
            "Test the parts that are not the database as well: DNS failover, the load balancer target group, secret availability in the recovery region, the image existing in the registry, and the IAM role the new cluster assumes. Most failed drills fail on these, not on the backup file.",
          ],
          code: `apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: ledger-db-partition
  namespace: ledger-drill
spec:
  action: partition
  mode: all
  selector:
    namespaces: [ledger-drill]
    labelSelectors: { app: ledger-api }
  direction: to
  target:
    selector:
      namespaces: [ledger-drill]
      labelSelectors: { app: postgres }
    mode: all
  duration: "5m"
  scheduler:
    cron: "@every 168h"    # weekly, in the drill namespace only`,
          tip:
            "Run fault injection in a drill namespace that mirrors production, with its own quota. A chaos experiment that defaults into the production namespace is an outage with a YAML file.",
        },
        {
          h: "Game days: hypothesis, blast radius, stop condition",
          p: [
            "A game day is a scheduled experiment with a written hypothesis, a bounded blast radius, a start time, an abort condition and a facilitator. Announce it to support, exclude the payment path unless it is the target, and measure detection, acknowledgement and mitigation times as carefully as you measure the system.",
            "The output is not a green dashboard; it is a list of fixes to runbooks, alerts and automation, each with an owner. A drill that finds nothing is suspicious: either the experiment was too gentle or the observability is too weak to notice. Publish the results, including the misses, so the next drill starts from a higher floor.",
          ],
          code: `drill:
  name: "ledger db failover"
  owner: "payments-sre"
  hypothesis: "failover keeps p99 under 400 ms and loses no committed rows"
  window: "2026-11-12T10:00Z/2026-11-12T11:00Z"
  blast_radius:
    namespaces: [ledger-drill]
    excluded: [payments-checkout]
  steps:
    - { at: "T+0m",  action: "announce in #drills, start the timer, open the dashboards" }
    - { at: "T+5m",  action: "inject the fault; record detection time from the alert" }
    - { at: "T+15m", action: "execute the runbook failover exactly as written" }
    - { at: "T+25m", action: "verify row count and ledger checksum; record RTO and RPO" }
    - { at: "T+40m", action: "restore, confirm steady state, stop the timer" }
  abort_if:
    - "a write error appears outside ledger-drill"
    - "customer-facing error budget burn exceeds 2x"
  follow_ups: []   # filled in the review, each with an owner and a date`,
          tip:
            "Time the runbook as written, including every command someone has to look up. Fixing the runbook after the drill is usually cheaper and more valuable than fixing the system.",
        },
      ],
      exercise: {
        prompt:
          "Implement grade() so a drill is Met only when both measured restore time and data loss are inside their objectives; assert all four verdicts.",
        starter: `#[derive(Debug, Clone, Copy)]
struct Objective {
    rto_minutes: f64,
    rpo_minutes: f64,
}

#[derive(Debug, Clone, Copy)]
struct Measurement {
    restore_minutes: f64,
    data_loss_minutes: f64,
}

#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    Met,
    MissedRto,
    MissedRpo,
    MissedBoth,
}

fn grade(measured: Measurement, objective: Objective) -> Verdict {
    // TODO
    todo!()
}

fn main() {
    let objective = Objective { rto_minutes: 60.0, rpo_minutes: 5.0 };
    let ok = Measurement { restore_minutes: 52.0, data_loss_minutes: 3.5 };
    assert_eq!(grade(ok, objective), Verdict::Met);
    println!("drill met the objective");
}`,
        hint:
          "Compute rto_ok and rpo_ok as two booleans, then match on the pair. Both true is Met; only one true tells you which objective missed; both false is MissedBoth.",
        solution: `#[derive(Debug, Clone, Copy)]
struct Objective {
    rto_minutes: f64,
    rpo_minutes: f64,
}

#[derive(Debug, Clone, Copy)]
struct Measurement {
    restore_minutes: f64,
    data_loss_minutes: f64,
}

#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    Met,
    MissedRto,
    MissedRpo,
    MissedBoth,
}

fn grade(measured: Measurement, objective: Objective) -> Verdict {
    let rto_ok = measured.restore_minutes <= objective.rto_minutes;
    let rpo_ok = measured.data_loss_minutes <= objective.rpo_minutes;
    match (rto_ok, rpo_ok) {
        (true, true) => Verdict::Met,
        (false, true) => Verdict::MissedRto,
        (true, false) => Verdict::MissedRpo,
        (false, false) => Verdict::MissedBoth,
    }
}

fn main() {
    let objective = Objective { rto_minutes: 60.0, rpo_minutes: 5.0 };

    assert_eq!(
        grade(Measurement { restore_minutes: 52.0, data_loss_minutes: 3.5 }, objective),
        Verdict::Met
    );
    assert_eq!(
        grade(Measurement { restore_minutes: 61.0, data_loss_minutes: 3.5 }, objective),
        Verdict::MissedRto
    );
    assert_eq!(
        grade(Measurement { restore_minutes: 52.0, data_loss_minutes: 6.0 }, objective),
        Verdict::MissedRpo
    );
    assert_eq!(
        grade(Measurement { restore_minutes: 61.0, data_loss_minutes: 6.0 }, objective),
        Verdict::MissedBoth
    );

    println!("all four drill verdicts verified");
}`,
      },
      questions: [
        {
          q: "Backups have reported success for ninety days. What has actually been proven?",
          options: [
            "That recovery works inside the RTO",
            "That a file was written; restore time and data loss remain unmeasured",
            "That RPO is zero",
            "That the database is consistent",
          ],
          answer: 1,
          explain:
            "A successful backup proves the job wrote bytes. Only a restore into a clean environment, followed by data verification and timing, proves the recovery objective; until then RTO and RPO are wishes.",
        },
        {
          q: "RPO is 5 minutes and WAL is shipped every 15 minutes. What is the real exposure?",
          options: [
            "5 minutes",
            "Up to 15 minutes of committed transactions, so the objective is not met",
            "Zero, because WAL is continuous",
            "20 minutes",
          ],
          answer: 1,
          explain:
            "Recovery point is bounded by the shipping interval, not by the objective. Either ship more often or relax the RPO in writing; a number in a document that the architecture cannot meet is worse than no number.",
        },
        {
          q: "What is the right blast-radius control for a first game day?",
          options: [
            "Run it in production at peak so the result is realistic",
            "Run it in a dedicated drill namespace with production-shaped data, support notified and an abort condition",
            "Disable alerting so the drill does not page anyone",
            "Skip the runbook so the team improvises",
          ],
          answer: 1,
          explain:
            "A drill is a controlled experiment. The namespace, the quota, the notification and the abort condition are what make it controlled; without them you are simply causing an incident and calling it practice.",
        },
      ],
      quickbytes: [
        "RTO is downtime and RPO is data loss; write both per data class and rehearse the tighter one first.",
        "Restore into a clean cluster and verify row counts and checksums before you time the drill.",
        "Every drill ends with runbook, alert and automation fixes with owners; a drill that finds nothing was too gentle.",
      ],
      production: [
        "Every data class has a written RTO and RPO, approved by the owning team and the business.",
        "Restore drills run at least quarterly into a clean environment, with measured timings recorded.",
        "Recovery dependencies (DNS, KMS, IAM, registry, secrets) are exercised, not assumed.",
        "Game days have a hypothesis, a bounded blast radius, an abort condition and a facilitator.",
        "Drill findings become owned fixes to runbooks, alerts and automation, tracked to closure.",
      ],
      crates: ["serde", "tokio", "tracing", "sqlx"],
      github: [
        {
          name: "chaos-mesh/chaos-mesh",
          url: "https://github.com/chaos-mesh/chaos-mesh",
        },
      ],
      pitfall:
        "Drilling only the database restore: the data comes back in fifty minutes, then DNS still points at the dead region, the KMS key is region-scoped, and the real recovery takes three hours. Rehearse the whole path.",
      resources: [
        {
          title: "Chaos Mesh: fault injection for drills and game days",
          url: "https://github.com/chaos-mesh/chaos-mesh",
          kind: "repo",
        },
        {
          title: "PostgreSQL: continuous archiving and point-in-time recovery",
          url: "https://www.postgresql.org/docs/current/continuous-archiving.html",
          kind: "docs",
        },
        {
          title: "Kubernetes: disruptions, budgets and node drains",
          url: "https://kubernetes.io/docs/concepts/workloads/pods/disruptions/",
          kind: "docs",
        },
        {
          title: "CNCF: chaos engineering and disaster recovery practice",
          url: "https://www.youtube.com/@CNCF",
          kind: "video",
        },
      ],
    },
    {
      id: "g18",
      title: "Patch cadence: SLA triage, rebuilds, expiring exceptions",
      minutes: 65,
      level: "industry",
      goal:
        "Turn vulnerability feeds into a scheduled rebuild-and-redeploy pipeline with severity-based deadlines, an exception process that expires, and evidence that the shipped artifact changed.",
      sections: [
        {
          h: "Patch the artifact, not the repository",
          p: [
            "A merged dependency bump fixes nothing until an image is rebuilt and deployed. Most Rust exposure lives in transitive crates and the base image, so the unit of patching is the artifact digest: SBOM in, advisory match, rebuild, redeploy, verify the digest changed. Track mean time to patch from advisory publication, not from whenever someone noticed the pull request.",
            "Set deadlines by exploitability and exposure rather than by CVSS alone. A critical in a crate that parses untrusted input on an internet-facing service is a 24-hour fix; the same crate behind an internal admin tool with no route from the internet is a week. Write the matrix down so triage is a lookup instead of a debate at 2am.",
          ],
          code: `#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Critical,
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Copy)]
pub struct Context {
    pub internet_facing: bool,
    pub known_exploited: bool,
    pub untrusted_input: bool,
}

/// Hours until the fix must be serving traffic, counted from publication.
pub fn deadline_hours(severity: Severity, context: Context) -> u32 {
    let base = match severity {
        Severity::Critical => 72,
        Severity::High => 168,
        Severity::Medium => 720,
        Severity::Low => 2160,
    };
    if context.known_exploited && context.internet_facing {
        return base.min(24);
    }
    if context.untrusted_input && context.internet_facing {
        return base.min(48);
    }
    base
}

fn main() {
    let exposed = Context { internet_facing: true, known_exploited: true, untrusted_input: true };
    assert_eq!(deadline_hours(Severity::Critical, exposed), 24);
    assert_eq!(deadline_hours(Severity::Low, exposed), 24);  // exploitation beats severity

    let internal = Context { internet_facing: false, known_exploited: false, untrusted_input: false };
    assert_eq!(deadline_hours(Severity::High, internal), 168);

    println!("critical and exploited: {} hours", deadline_hours(Severity::Critical, exposed));
}`,
          tip:
            "Measure the deadline from the advisory timestamp, not from ticket creation. A queue that takes three days to triage has already spent the critical window before anyone looked at the fix.",
        },
        {
          h: "Rebuild on a schedule and prove the delta",
          p: [
            "Weekly rebuilds of the base image pick up operating-system packages you never declared, and grouped dependency updates pick up crates without a pull request per crate. Rebuild with --locked so the graph is exactly the reviewed one, then scan the new image and compare its SBOM with the previous release. A patch deploy that does not change the digest is a no-op you can detect.",
            "Gate the release on critical findings, and make the gate fail closed: if the scanner cannot run, the release does not proceed. Keep the scan output as a build artifact so an auditor can answer which artifact contained which package version at the moment it shipped.",
          ],
          code: `name: patch-rebuild
on:
  schedule: [{ cron: "0 3 * * 1" }]   # weekly, Monday 03:00 UTC
  workflow_dispatch:
permissions:
  contents: read
jobs:
  rebuild:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
      - run: cargo audit
      - run: cargo install --locked cargo-cyclonedx && cargo cyclonedx --format json
      # --pull refreshes the base image; the tag is built from this commit,
      # and the digest printed below is the artifact that must be deployed.
      - run: docker build --pull -t ledger-api:patch .
      - run: docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:latest image --severity CRITICAL,HIGH --exit-code 1 ledger-api:patch
      - run: docker image inspect ledger-api:patch --format '{{index .RepoDigests 0}}'
      - uses: actions/upload-artifact@v4
        with:
          name: sbom
          path: "**/*.cdx.json"`,
          tip:
            "Pin the scanner image by digest and update it deliberately. A scanner on latest can change its advisory database and its findings in the middle of an unrelated release.",
        },
        {
          h: "Exceptions expire, and controls are named",
          p: [
            "Sometimes you cannot patch: the fix is unreleased upstream, the service is frozen for a migration, or the vulnerable path is unreachable but not provably so. Then you take an exception, and an exception without an owner, a reason, a compensating control and an expiry date is just an unpatched system with paperwork.",
            "Model the exception as code and fail the build when it expires, rather than trusting a spreadsheet. Re-check automatically: if the fixed version is published, the exception is invalid even before its date. Compensating controls must be concrete, such as a WAF rule, a feature disabled at the edge, or a network policy that removes the route.",
          ],
          code: `use std::time::{Duration, SystemTime};

#[derive(Debug)]
pub struct Exception {
    pub advisory: String,
    pub owner: String,
    pub control: String,
    pub ticket: String,
    pub expires_at: SystemTime,
}

#[derive(Debug, PartialEq, Eq)]
pub enum State {
    Active,
    Expired,
    Invalid(&'static str),
}

pub fn evaluate(exception: &Exception, now: SystemTime) -> State {
    if exception.owner.trim().is_empty() {
        return State::Invalid("owner is required");
    }
    if exception.control.trim().is_empty() {
        return State::Invalid("compensating control is required");
    }
    if exception.ticket.trim().is_empty() {
        return State::Invalid("follow-up ticket is required");
    }
    if now >= exception.expires_at {
        return State::Expired;
    }
    State::Active
}

fn main() {
    let now = SystemTime::now();
    let exception = Exception {
        advisory: "RUSTSEC-2026-0001".to_string(),
        owner: "ana".to_string(),
        control: "route disabled at the edge".to_string(),
        ticket: "SEC-412".to_string(),
        expires_at: now + Duration::from_secs(14 * 24 * 60 * 60),
    };

    assert_eq!(evaluate(&exception, now), State::Active);

    let later = now + Duration::from_secs(15 * 24 * 60 * 60);
    assert_eq!(evaluate(&exception, later), State::Expired);

    println!("exception active for 14 days, then the build fails");
}`,
          tip:
            "Report every active exception in the monthly security review, with its expiry. An exception nobody sees is an ignore list with better formatting.",
        },
      ],
      exercise: {
        prompt:
          "Implement deadline_hours for the four severities, shortened to 24 hours when a critical is known-exploited and internet-facing, and assert the matrix including an internal case.",
        starter: `#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Severity {
    Critical,
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Copy)]
struct Context {
    internet_facing: bool,
    known_exploited: bool,
    untrusted_input: bool,
}

fn deadline_hours(severity: Severity, context: Context) -> u32 {
    // TODO: 72 / 168 / 720 / 2160, then tighten for exposure
    todo!()
}

fn main() {
    let exposed = Context { internet_facing: true, known_exploited: true, untrusted_input: true };
    assert_eq!(deadline_hours(Severity::Critical, exposed), 24);
    println!("critical and exploited gets 24 hours");
}`,
        hint:
          "Match severity to a base, then take the minimum with 24 when known_exploited and internet_facing, and with 48 when untrusted_input and internet_facing. Exposure only ever shortens the deadline.",
        solution: `#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Severity {
    Critical,
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Copy)]
struct Context {
    internet_facing: bool,
    known_exploited: bool,
    untrusted_input: bool,
}

fn deadline_hours(severity: Severity, context: Context) -> u32 {
    let base = match severity {
        Severity::Critical => 72,
        Severity::High => 168,
        Severity::Medium => 720,
        Severity::Low => 2160,
    };
    if context.known_exploited && context.internet_facing {
        return base.min(24);
    }
    if context.untrusted_input && context.internet_facing {
        return base.min(48);
    }
    base
}

fn main() {
    let exposed = Context { internet_facing: true, known_exploited: true, untrusted_input: true };
    let internal = Context { internet_facing: false, known_exploited: false, untrusted_input: false };

    assert_eq!(deadline_hours(Severity::Critical, exposed), 24);
    assert_eq!(deadline_hours(Severity::Low, exposed), 24);
    assert_eq!(deadline_hours(Severity::High, internal), 168);
    assert_eq!(deadline_hours(Severity::Low, internal), 2160);

    println!("triage matrix verified: exposure shortens the deadline, never extends it");
}`,
      },
      questions: [
        {
          q: "A dependency bump is merged but no image is built. What is the state of production?",
          options: [
            "Patched, because Cargo.lock changed",
            "Still vulnerable: the running artifact was never rebuilt or redeployed",
            "Patched after the next pod restart",
            "Patched only for new pods",
          ],
          answer: 1,
          explain:
            "The lockfile describes a future build. Patching is complete only when a new digest serves traffic and the SBOM of that digest shows the fixed version; until then the vulnerable code is still running.",
        },
        {
          q: "Which exception is acceptable in a real patch process?",
          options: [
            "An ignore with no expiry and no owner",
            "An exception with an owner, a concrete compensating control, a ticket and an expiry that fails the build",
            "A comment in Cargo.toml",
            "Disabling the scanner for the release branch",
          ],
          answer: 1,
          explain:
            "The exception is a decision to accept risk for a bounded period with a mitigation. All four fields make it reviewable; removing any one of them turns the process back into an ignore list.",
        },
        {
          q: "Why compare the SBOM of consecutive releases?",
          options: [
            "To reduce image size",
            "To prove the shipped artifact changed and no vulnerable version silently persisted",
            "To satisfy the registry",
            "To avoid rebuilding",
          ],
          answer: 1,
          explain:
            "The diff answers whether the deploy actually replaced the vulnerable package or merely rebuilt around it. Without it, a green pipeline can hide an unchanged transitive dependency for months.",
        },
      ],
      quickbytes: [
        "Patch the digest: SBOM in, advisory match, rebuild, redeploy, verify the digest changed.",
        "Deadlines: critical 72h, high 7d, medium 30d, low 90d; 24h when known-exploited and internet-facing.",
        "An exception without an owner, a control and an expiry is an unpatched system with paperwork.",
      ],
      production: [
        "Every release publishes an SBOM, and advisories are mapped to shipped digests rather than to the repository.",
        "Patch deadlines are defined by severity and exposure, with 24-hour handling for known-exploited internet-facing issues.",
        "Base images and dependencies are rebuilt weekly, and the scan gate fails closed when the scanner cannot run.",
        "Exceptions carry an owner, a compensating control and an expiry, and an expired exception fails the build.",
        "Mean time to patch is measured from advisory publication to verified deployment and reported monthly.",
      ],
      crates: ["cargo-audit", "cargo-deny", "serde", "time"],
      github: [
        {
          name: "aquasecurity/trivy",
          url: "https://github.com/aquasecurity/trivy",
        },
        {
          name: "rustsec/rustsec",
          url: "https://github.com/rustsec/rustsec",
        },
      ],
      pitfall:
        "Renovate or Dependabot merges a bump, CI goes green, and nothing is deployed: the running image still contains the vulnerable crate. Patching is complete only when a new digest serves traffic.",
      resources: [
        {
          title: "Trivy: image, filesystem and SBOM vulnerability scanning",
          url: "https://github.com/aquasecurity/trivy",
          kind: "repo",
        },
        {
          title: "RustSec advisory database",
          url: "https://github.com/rustsec/rustsec",
          kind: "repo",
        },
        {
          title: "cargo-audit: check the lockfile against RustSec",
          url: "https://docs.rs/cargo-audit/latest/cargo_audit/",
          kind: "docs",
        },
        {
          title: "OWASP: dependency risk, SBOM and vulnerability management",
          url: "https://www.youtube.com/@OWASPGLOBAL",
          kind: "video",
        },
      ],
    },
    {
      id: "g19",
      title: "Service catalogue: ownership, tiers, dependency map",
      minutes: 60,
      level: "industry",
      goal:
        "Give every service one accountable owner, a tier and declared dependencies, generate the catalogue from checked-in manifests, and use the graph to answer blast-radius questions during incidents.",
      sections: [
        {
          h: "Ownership is a rotation, not a team name",
          p: [
            "A catalogue entry with owner: platform-team and no rotation is a dead end at 3am. Record the owning team, the escalation rotation, the runbook URL and the dashboard URL, and require all four to resolve at review time. Ownership changes come through a pull request against the manifest, so the change is dated and reviewable instead of remembered.",
            "Tier is not prestige; it is the set of obligations. Tier one gets an SLO, pagers, a DR drill and a readiness review; tier three gets a runbook and a business-hours contact. The tier decides how much process applies, and a service that quietly serves checkout traffic at tier three is a governance bug you can detect in the build.",
          ],
          code: `use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceManifest {
    pub name: String,
    pub owner_team: String,
    pub oncall_rotation: String,
    pub tier: u8,                  // 1, 2 or 3
    pub slo: Option<String>,
    pub runbook: String,
    pub dashboard: String,
    pub depends_on: Vec<String>,
}

pub fn validate(manifest: &ServiceManifest) -> Result<(), Vec<String>> {
    let mut problems = Vec::new();
    if manifest.oncall_rotation.trim().is_empty() {
        problems.push("oncall_rotation must name a real rotation".to_string());
    }
    if !(1..=3).contains(&manifest.tier) {
        problems.push("tier must be 1, 2 or 3".to_string());
    }
    if manifest.tier == 1 && manifest.slo.is_none() {
        problems.push("tier 1 services must declare an SLO".to_string());
    }
    if !manifest.runbook.starts_with("https://") {
        problems.push("runbook must be an https URL".to_string());
    }
    if !manifest.dashboard.starts_with("https://") {
        problems.push("dashboard must be an https URL".to_string());
    }
    if problems.is_empty() { Ok(()) } else { Err(problems) }
}

fn main() {
    let manifest = ServiceManifest {
        name: "ledger-api".to_string(),
        owner_team: "payments".to_string(),
        oncall_rotation: "payments-primary".to_string(),
        tier: 1,
        slo: Some("checkout-availability 99.9%".to_string()),
        runbook: "https://runbooks.example.com/ledger".to_string(),
        dashboard: "https://grafana.example.com/d/ledger".to_string(),
        depends_on: vec!["ledger-db".to_string(), "pricing-api".to_string()],
    };
    assert!(validate(&manifest).is_ok());

    let mut without_slo = manifest;
    without_slo.slo = None;
    assert!(validate(&without_slo).is_err());
    println!("tier 1 without an SLO is rejected");
}`,
          tip:
            "Require the tier-1 owner to be a rotation that pages, not a distribution list. Test it by opening the escalation policy, not by reading the field.",
        },
        {
          h: "The dependency graph is the incident map",
          p: [
            "Declared dependencies turn a page into a plan: what does this service need, what needs this service, and what is the blast radius if it fails. Reverse dependencies are the harder question and the more useful one during an incident, because they name the teams to notify and the customers who are affected.",
            "Compute reachability in both directions and detect cycles, because a cycle in the declaration usually reflects a real synchronous cycle in the architecture. If service A cannot start without B and B cannot start without A, no deploy order exists, and the graph tells you that before an outage does.",
          ],
          code: `use std::collections::{BTreeMap, BTreeSet, VecDeque};

pub type Graph = BTreeMap<&'static str, Vec<&'static str>>;

/// Everything affected if the origin fails: its callers, transitively.
pub fn blast_radius(dependents: &Graph, origin: &'static str) -> BTreeSet<&'static str> {
    let mut seen = BTreeSet::new();
    let mut queue: VecDeque<&'static str> = VecDeque::from([origin]);

    while let Some(service) = queue.pop_front() {
        if let Some(callers) = dependents.get(service) {
            for &caller in callers {
                if seen.insert(caller) {
                    queue.push_back(caller);
                }
            }
        }
    }
    seen
}

fn main() {
    // Reverse edges: who calls whom.
    let dependents: Graph = BTreeMap::from([
        ("ledger-db", vec!["ledger-api"]),
        ("ledger-api", vec!["checkout", "reporting"]),
        ("pricing-api", vec!["checkout"]),
    ]);

    let affected = blast_radius(&dependents, "ledger-db");
    assert_eq!(affected, BTreeSet::from(["ledger-api", "checkout", "reporting"]));
    println!("a ledger-db failure affects: {affected:?}");
}`,
          tip:
            "Compare declared edges with trace-derived edges monthly. A dependency that only exists in traces is a missing catalogue entry, and it will be missing again at 3am.",
        },
        {
          h: "Generate the catalogue; do not curate it",
          p: [
            "A wiki page with service names rots within a quarter. Put a catalog-info.yaml in the repository, validate it in CI with the same schema the catalogue uses, and publish on merge. Backstage's entity model already carries owner, lifecycle, links and dependencies, so the developer portal and the incident tool read the same file instead of two copies.",
            "Make the pipeline reject a merge that removes a required field rather than letting the catalogue drift. Add the runbook and dashboard links to the entity so on-call reaches them from the page itself, and include the service in an ownership report so an unowned service appears as a finding instead of as a surprise during a review.",
          ],
          code: `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: ledger-api
  description: "Ledgerline billing API"
  annotations:
    backstage.io/techdocs-ref: dir:.
  links:
    - { title: Runbook, url: "https://runbooks.example.com/ledger" }
    - { title: Dashboard, url: "https://grafana.example.com/d/ledger" }
  tags: [rust, tier-1, payments]
spec:
  type: service
  lifecycle: production
  owner: payments
  system: ledgerline
  dependsOn:
    - component:ledger-db
    - component:pricing-api
  providesApis:
    - ledger-api-v1`,
          tip:
            "Validate the entity file in the service's own CI, not only in the portal. A schema error caught at merge time costs minutes; the same error discovered by on-call costs an incident.",
        },
      ],
      exercise: {
        prompt:
          "Implement validate() for a service manifest: tier in 1..=3, tier 1 requires an SLO, the on-call rotation must not be empty, and the runbook must be https; assert one passing and one failing manifest.",
        starter: `struct ServiceManifest {
    name: String,
    oncall_rotation: String,
    tier: u8,
    slo: Option<String>,
    runbook: String,
}

fn validate(manifest: &ServiceManifest) -> Result<(), Vec<String>> {
    // TODO: collect every problem, return Err only when the list is non-empty
    todo!()
}

fn main() {
    let manifest = ServiceManifest {
        name: "ledger-api".to_string(),
        oncall_rotation: "payments-primary".to_string(),
        tier: 1,
        slo: Some("checkout-availability 99.9%".to_string()),
        runbook: "https://runbooks.example.com/ledger".to_string(),
    };
    assert!(validate(&manifest).is_ok());
    println!("manifest valid");
}`,
        hint:
          "Push a message for each violated rule rather than returning early, so one review sees every problem. Check the rotation, the tier range, the tier-1 SLO and the runbook prefix.",
        solution: `struct ServiceManifest {
    name: String,
    oncall_rotation: String,
    tier: u8,
    slo: Option<String>,
    runbook: String,
}

fn validate(manifest: &ServiceManifest) -> Result<(), Vec<String>> {
    let mut problems = Vec::new();

    if manifest.oncall_rotation.trim().is_empty() {
        problems.push("oncall_rotation must name a real rotation".to_string());
    }
    if !(1..=3).contains(&manifest.tier) {
        problems.push("tier must be 1, 2 or 3".to_string());
    }
    if manifest.tier == 1 && manifest.slo.is_none() {
        problems.push("tier 1 services must declare an SLO".to_string());
    }
    if !manifest.runbook.starts_with("https://") {
        problems.push("runbook must be an https URL".to_string());
    }

    if problems.is_empty() { Ok(()) } else { Err(problems) }
}

fn main() {
    let valid = ServiceManifest {
        name: "ledger-api".to_string(),
        oncall_rotation: "payments-primary".to_string(),
        tier: 1,
        slo: Some("checkout-availability 99.9%".to_string()),
        runbook: "https://runbooks.example.com/ledger".to_string(),
    };
    assert!(validate(&valid).is_ok());

    let invalid = ServiceManifest {
        name: "ledger-api".to_string(),
        oncall_rotation: String::new(),
        tier: 4,
        slo: None,
        runbook: "http://wiki/ledger".to_string(),
    };
    let problems = validate(&invalid).unwrap_err();
    assert_eq!(problems.len(), 3, "rotation, tier and runbook are all wrong");

    println!("catalogue validation: {} problems reported at once", problems.len());
}`,
      },
      questions: [
        {
          q: "A catalogue entry lists owner: platform-team with no rotation. What is the operational failure?",
          options: [
            "None, the team owns the service",
            "At 3am nobody is accountable and the page has no escalation path",
            "The catalogue cannot render the page",
            "Tier assignment fails",
          ],
          answer: 1,
          explain:
            "Ownership without a rotation is a label. The incident tool needs a person or a rotation to page; without it the alert lands in a channel where everyone assumes someone else is looking.",
        },
        {
          q: "What does the reverse dependency graph answer during an incident?",
          options: [
            "Which version is deployed",
            "Which services and customers are affected, and whom to notify",
            "Why the service crashed",
            "How to patch the database",
          ],
          answer: 1,
          explain:
            "Forward edges tell you what this service needs; reverse edges tell you who is hurt by its failure. The second is the one that determines notifications, blast radius and whether to fail over or degrade.",
        },
        {
          q: "Why generate the catalogue from a checked-in manifest instead of a wiki?",
          options: [
            "Wikis are slower to load",
            "The manifest is reviewed, versioned and validated in CI, so it cannot silently drift from the code",
            "Backstage requires YAML",
            "It reduces repository size",
          ],
          answer: 1,
          explain:
            "A catalogue is only useful if it is true during an incident. A manifest in the repository moves with the code and fails the build when it is wrong; a wiki page is accurate only on the day it was written.",
        },
      ],
      quickbytes: [
        "Owner, rotation, runbook, dashboard: four links that must resolve, or the entry is not done.",
        "Tier 1 means SLO, pager, DR drill and readiness review; tier decides obligations, not prestige.",
        "Publish the catalogue from catalog-info.yaml on merge; a wiki entry is stale the week after it is written.",
      ],
      production: [
        "Every service has a catalog-info.yaml with owner, rotation, tier, SLO, runbook and dashboard links.",
        "CI validates the manifest and rejects a merge that removes a required field.",
        "Declared dependencies are compared with trace-derived edges, and unexplained differences are reviewed.",
        "An ownership report lists services with no rotation or no recent deploy, and each is assigned an owner.",
        "Blast-radius queries use the catalogue during incidents, and the graph is updated in the same PR as the dependency.",
      ],
      crates: ["serde", "toml", "petgraph", "tracing"],
      github: [
        {
          name: "backstage/backstage",
          url: "https://github.com/backstage/backstage",
        },
      ],
      pitfall:
        "A catalogue that lists services but not dependencies: during an incident nobody can answer what calls the failing service, so notifications go to the wrong teams and the blast radius is discovered by customers.",
      resources: [
        {
          title: "Backstage: software catalog and catalog-info.yaml",
          url: "https://github.com/backstage/backstage",
          kind: "repo",
        },
        {
          title: "serde: derive and validate the manifest schema",
          url: "https://docs.rs/serde/latest/serde/",
          kind: "docs",
        },
        {
          title: "Kubernetes: recommended labels and ownership metadata",
          url: "https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/",
          kind: "docs",
        },
        {
          title: "CNCF: platform engineering and service ownership",
          url: "https://www.youtube.com/@CNCF",
          kind: "video",
        },
      ],
    },
    {
      id: "g20",
      title: "Production readiness review: evidence before launch",
      minutes: 55,
      level: "industry",
      goal:
        "Run a readiness review that demands evidence for observability, capacity, security, data, rollback and on-call, records time-boxed waivers, and blocks launch when the evidence is missing.",
      sections: [
        {
          h: "A review is evidence, not a questionnaire",
          p: [
            "Anyone can tick a box that says monitoring exists. A readiness review asks for the link: the dashboard, the alert, the load test result, the rollback runbook, the on-call rotation, the restore drill. The reviewer opens the link and confirms it shows what the owner claims, which takes minutes per item and catches the difference between configured and working.",
            "Scope it deliberately: a new service, a new data store, a new external dependency, a tier promotion, or a launch with a revenue commitment. A tiny internal tool should not need a two-hour review, and a payment path should not skip one. Record the decision and its date, and re-review after a material architecture change rather than annually by calendar.",
          ],
          code: `#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Area {
    Observability,
    Capacity,
    Security,
    Data,
    Rollback,
    OnCall,
}

#[derive(Debug)]
pub struct Check {
    pub area: Area,
    pub requirement: &'static str,
    pub evidence: Option<&'static str>,   // a link a reviewer can open
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Ready,
    Blocked(Vec<&'static str>),
}

pub fn review(checks: &[Check]) -> Verdict {
    let missing: Vec<&'static str> = checks
        .iter()
        .filter(|check| check.evidence.map(str::is_empty).unwrap_or(true))
        .map(|check| check.requirement)
        .collect();

    if missing.is_empty() { Verdict::Ready } else { Verdict::Blocked(missing) }
}

fn main() {
    let checks = [
        Check {
            area: Area::Observability,
            requirement: "RED dashboard per route",
            evidence: Some("https://grafana.example.com/d/ledger"),
        },
        Check {
            area: Area::Capacity,
            requirement: "ramp test at 2x launch peak",
            evidence: Some("https://ci.example.com/load/812"),
        },
        Check {
            area: Area::Rollback,
            requirement: "rollback rehearsed under 5 minutes",
            evidence: None,
        },
    ];

    match review(&checks) {
        Verdict::Ready => println!("ready"),
        Verdict::Blocked(missing) => {
            assert_eq!(missing, vec!["rollback rehearsed under 5 minutes"]);
            println!("blocked on: {missing:?}");
        }
    }
}`,
          tip:
            "Count a link that returns 404 as missing evidence. A dashboard behind a decommissioned URL is worse than none, because it looks like the work was done.",
        },
        {
          h: "The questions that catch most launches",
          p: [
            "Who gets paged, and what do they see first? What breaks first under load, and what is the measured limit? Can you roll back in five minutes, and has it been done? What is the blast radius if this service or its database disappears? Where do the secrets come from and who can read them? What happens at ten times the launch traffic? How do you restore the data, and when was that tested?",
            "Each question has a verifiable artifact behind it. If the answer is a sentence in a document rather than a link to something running, treat it as unproven. The review is not a search for perfection: it is a search for unknown failure modes, and an honest we have not tested that is worth more than a confident assertion.",
          ],
          code: `readiness:
  service: ledger-api
  tier: 1
  reviewer: "sre-oncall"
  checks:
    - id: obs-red
      requirement: "RED dashboard per route, linked from the alert"
      evidence_kind: dashboard
      evidence: "https://grafana.example.com/d/ledger"
    - id: cap-2x
      requirement: "ramp test at 2x launch peak, p99 inside budget"
      evidence_kind: load_test
      evidence: "https://ci.example.com/load/812"
    - id: rb-5m
      requirement: "rollback rehearsed in staging under 5 minutes"
      evidence_kind: drill
      evidence: null          # blocks launch until a drill run is linked
    - id: oncall
      requirement: "rotation exists with a named secondary"
      evidence_kind: rotation
      evidence: "https://pager.example.com/schedules/payments"`,
          tip:
            "Ask for the artifact, not the answer. The gap between we have alerts and here is the alert that fired in the last game day is where most launch surprises live.",
        },
        {
          h: "Waivers expire and re-reviews have triggers",
          p: [
            "Sometimes you launch with a known gap: a dashboard is missing, a runbook is thin, a dependency has no failover yet. That is a waiver, and a waiver needs an owner, a reason, a compensating control, an expiry date and a follow-up ticket. A waiver without an expiry becomes the permanent state, and the next reviewer inherits an untested assumption.",
            "Re-review on triggers rather than on the calendar: a material architecture change, a new data class, a tier promotion, a failed DR drill, or an incident whose root cause the review should have caught. Record the outcome as an ADR so the next team knows what was accepted, by whom, and why.",
          ],
          code: `use std::time::{Duration, SystemTime};

#[derive(Debug)]
pub struct Waiver {
    pub check_id: &'static str,
    pub owner: &'static str,
    pub reason: &'static str,
    pub control: &'static str,
    pub granted_for: Duration,
    pub ticket: &'static str,
}

#[derive(Debug, PartialEq, Eq)]
pub enum WaiverState {
    Active,
    Expired,
    Invalid(&'static str),
}

pub fn evaluate(waiver: &Waiver, granted_at: SystemTime, now: SystemTime) -> WaiverState {
    if waiver.owner.trim().is_empty() {
        return WaiverState::Invalid("owner is required");
    }
    if waiver.control.trim().is_empty() {
        return WaiverState::Invalid("compensating control is required");
    }
    if waiver.ticket.trim().is_empty() {
        return WaiverState::Invalid("follow-up ticket is required");
    }
    if now.duration_since(granted_at).unwrap_or_default() >= waiver.granted_for {
        return WaiverState::Expired;
    }
    WaiverState::Active
}

fn main() {
    let waiver = Waiver {
        check_id: "rb-5m",
        owner: "ana",
        reason: "rollback drill booked for next sprint",
        control: "deploy freeze during the launch window",
        granted_for: Duration::from_secs(14 * 24 * 60 * 60),
        ticket: "OPS-412",
    };

    let granted_at = SystemTime::now();
    assert_eq!(evaluate(&waiver, granted_at, granted_at), WaiverState::Active);

    let later = granted_at + Duration::from_secs(15 * 24 * 60 * 60);
    assert_eq!(evaluate(&waiver, granted_at, later), WaiverState::Expired);

    println!("waiver: active for 14 days, then the next review blocks");
}`,
          tip:
            "Grant waivers for weeks, not quarters. A fourteen-day waiver gets scheduled because it is imminent; a ninety-day one gets forgotten until it expires during a launch.",
        },
      ],
      exercise: {
        prompt:
          "Implement review(checks) returning Ready only when every check has non-empty evidence, and Blocked with the requirement text of each missing item; assert both outcomes.",
        starter: `struct Check {
    requirement: &'static str,
    evidence: Option<&'static str>,
}

#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    Ready,
    Blocked(Vec<&'static str>),
}

fn review(checks: &[Check]) -> Verdict {
    // TODO: a None or an empty evidence string blocks the launch
    todo!()
}

fn main() {
    let checks = [Check { requirement: "RED dashboard", evidence: Some("https://grafana/d/ledger") }];
    assert_eq!(review(&checks), Verdict::Ready);
    println!("ready");
}`,
        hint:
          "Collect the requirement of every check whose evidence is None or empty, then return Blocked with that vector when it is non-empty. Keep the order of the input so the report matches the checklist.",
        solution: `struct Check {
    requirement: &'static str,
    evidence: Option<&'static str>,
}

#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    Ready,
    Blocked(Vec<&'static str>),
}

fn review(checks: &[Check]) -> Verdict {
    let missing: Vec<&'static str> = checks
        .iter()
        .filter(|check| check.evidence.map(str::is_empty).unwrap_or(true))
        .map(|check| check.requirement)
        .collect();

    if missing.is_empty() { Verdict::Ready } else { Verdict::Blocked(missing) }
}

fn main() {
    let ready = [
        Check { requirement: "RED dashboard", evidence: Some("https://grafana.example.com/d/ledger") },
        Check { requirement: "load test at 2x", evidence: Some("https://ci.example.com/load/812") },
    ];
    assert_eq!(review(&ready), Verdict::Ready);

    let blocked = [
        Check { requirement: "RED dashboard", evidence: Some("https://grafana.example.com/d/ledger") },
        Check { requirement: "rollback drill", evidence: None },
        Check { requirement: "on-call rotation", evidence: Some("") },
    ];
    assert_eq!(
        review(&blocked),
        Verdict::Blocked(vec!["rollback drill", "on-call rotation"])
    );

    println!("readiness: empty evidence blocks the launch");
}`,
      },
      questions: [
        {
          q: "A readiness check says monitoring: yes. What should the reviewer do?",
          options: [
            "Accept it, the owner signed it",
            "Ask for the dashboard and alert links and open them",
            "Run the load test instead",
            "Escalate to the CTO",
          ],
          answer: 1,
          explain:
            "A claim is not evidence. Opening the dashboard and the alert confirms they exist, point at this service and would actually fire; the difference between configured and working is exactly what the review is for.",
        },
        {
          q: "Which gap most deserves a time-boxed waiver instead of blocking the launch?",
          options: [
            "No rollback path for a payment service",
            "A missing per-route dashboard when an alert covers the same failure and the fix is scheduled",
            "No on-call rotation",
            "No restore test for the primary database",
          ],
          answer: 1,
          explain:
            "A waiver is for a bounded gap with a compensating control. Missing rollback, on-call or restore coverage removes the ability to recover from a failure, which is not a gap that a date and a ticket can cover.",
        },
        {
          q: "When should a readiness review be repeated?",
          options: [
            "Every year on a fixed date",
            "After a material architecture change, a tier promotion, or a failed drill",
            "Never, once the service has launched",
            "Only when the service is rewritten",
          ],
          answer: 1,
          explain:
            "Readiness decays when the system changes, not when the calendar does. Triggers catch the change that invalidated the assumptions, while an annual review mostly produces paperwork about a system that no longer exists.",
        },
      ],
      quickbytes: [
        "Every checklist line links to a dashboard, run, drill or rotation the reviewer can open; a sentence is not evidence.",
        "A waiver has an owner, a control, a ticket and an expiry; no expiry means the gap is permanent.",
        "Re-review on triggers (architecture change, tier promotion, failed drill), not on an anniversary.",
      ],
      production: [
        "New tier-1 services and material changes pass a readiness review with linked evidence for every check.",
        "The review covers observability, capacity, security, data recovery, rollback and on-call.",
        "Waivers name an owner, a compensating control, a ticket and an expiry date, and expire automatically.",
        "The outcome and accepted risks are recorded as an ADR with the review date and participants.",
        "Re-review is triggered by architecture change, tier promotion, failed drill or a relevant incident.",
      ],
      crates: ["serde", "time", "anyhow", "tracing"],
      github: [
        {
          name: "kubernetes/enhancements",
          url: "https://github.com/kubernetes/enhancements",
        },
        {
          name: "PagerDuty/incident-response-docs",
          url: "https://github.com/PagerDuty/incident-response-docs",
        },
      ],
      pitfall:
        "Running the review as a box-ticking meeting the week before launch: the checklist is satisfied on paper, the rollback has never been executed, and the first real rollout discovers it in production.",
      resources: [
        {
          title: "kubernetes/enhancements: production readiness review questionnaires",
          url: "https://github.com/kubernetes/enhancements",
          kind: "repo",
        },
        {
          title: "PagerDuty incident response documentation",
          url: "https://github.com/PagerDuty/incident-response-docs",
          kind: "repo",
        },
        {
          title: "Kubernetes: liveness, readiness and startup probes",
          url: "https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/",
          kind: "docs",
        },
        {
          title: "InfoQ: launch reviews, reliability gates and operations",
          url: "https://www.youtube.com/@InfoQ",
          kind: "video",
        },
      ],
    },
  ],
};
