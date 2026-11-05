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
  ],
};
