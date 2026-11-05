/**
 * Rust Academy — reference data.
 *
 * CHEATSHEET: paste-ready snippets for the crates used across the curriculum:
 * services (axum 0.8, tokio 1.x, sqlx 0.8, tower-http 0.6, tonic 0.14,
 * rdkafka 0.39, async-nats 0.51, redis 1.x, OpenTelemetry 0.33), embedded
 * (embedded-hal 1.0, embassy-executor 0.10, rtic 2.4, defmt 1.x), WebAssembly
 * (wasm-bindgen 0.2, web-sys, leptos 0.8), ML inference (candle 0.11, ort 2.0,
 * tokenizers 0.23, burn) and data engineering (arrow/parquet 60, polars 0.55,
 * object_store 0.14).
 *
 * BLUEPRINTS: whole-system architectures — stack, ordered request/event flow,
 * production checklist and the lessons that build each piece.
 *
 * Everything here is plain JSON-serializable data: the build embeds it and the
 * panel renders it. No imports, no side effects.
 */

export const CHEATSHEET = [
  {
    title: 'Cargo & workspace',
    items: [
      {
        name: 'workspace layout',
        code: `# Cargo.toml (repo root)
[workspace]
resolver = "2"
members = ["crates/api", "crates/worker", "crates/core"]

[workspace.dependencies]
# pinned to the APIs taught in this course; run "cargo add <crate> --dry-run"
# to see what is current before you upgrade a major line
axum = "0.8"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
sqlx = { version = "0.8", features = ["runtime-tokio", "tls-rustls", "postgres", "uuid", "time", "migrate"] }
tower-http = { version = "0.6", features = ["trace", "cors", "timeout", "compression-gzip"] }`,
      },
      {
        name: 'one version per dependency',
        code: `# crates/api/Cargo.toml — inherit the workspace version
[dependencies]
axum.workspace = true
tokio.workspace = true
serde.workspace = true
core = { path = "../core" }`,
      },
      {
        name: 'release profile for services',
        code: `[profile.release]
lto = "thin"          # cross-crate inlining without full-LTO build times
codegen-units = 1     # slower build, faster binary
strip = "symbols"     # smaller image; strip debuginfo, keep line tables in a separate file
# do NOT set panic = "abort" if you rely on catch_unwind / tower catch-panic`,
      },
      {
        name: 'audit the dependency graph',
        code: `cargo tree -d                      # duplicate versions of the same crate
cargo install cargo-deny
cargo deny check advisories bans licenses sources
cargo install cargo-audit
cargo audit                        # RustSec advisory database`,
      },
      {
        name: 'check the resolved version first',
        code: `# --dry-run prints what cargo would resolve; nothing is written
cargo add axum --dry-run
cargo add sqlx --features runtime-tokio,tls-rustls,postgres
cargo update -p tokio
cargo update --dry-run`,
      },
      {
        name: 'feature-gate optional dependencies',
        code: `[features]
default = []
otel = ["dep:tracing-opentelemetry", "dep:opentelemetry-otlp"]

[dependencies]
tracing-opentelemetry = { version = "0.34", optional = true }
opentelemetry-otlp = { version = "0.33", optional = true }`,
      },
    ],
  },
  {
    title: 'Axum 0.8 routing & handlers',
    items: [
      {
        name: 'routes with {id} path params + state',
        code: `use axum::{extract::{Path, State}, routing::{get, post}, Json, Router};
use uuid::Uuid;

let app = Router::new()
    .route("/users", post(create_user))
    .route("/users/{id}", get(get_user))
    .route("/users/{id}/orders/{order_id}", get(get_order))
    .with_state(state);

async fn get_user(State(db): State<PgPool>, Path(id): Path<Uuid>) -> Result<Json<User>, AppError> {
    let user = sqlx::query_as::<_, User>("select id, email from users where id = $1")
        .bind(id)
        .fetch_optional(&db)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(user))
}`,
      },
      {
        name: 'error type that becomes a response',
        code: `use axum::{http::StatusCode, response::{IntoResponse, Response}, Json};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("not found")] NotFound,
    #[error("invalid input: {0}")] BadRequest(String),
    #[error(transparent)] Db(#[from] sqlx::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match &self {
            AppError::NotFound => StatusCode::NOT_FOUND,
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Db(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, Json(serde_json::json!({ "error": self.to_string() }))).into_response()
    }
}`,
      },
      {
        name: 'middleware stack (tower / tower-http 0.6)',
        code: `use std::time::Duration;
use axum::http::StatusCode;
use tower::ServiceBuilder;
use tower_http::{cors::CorsLayer, timeout::TimeoutLayer, trace::TraceLayer};

let app = Router::new()
    .route("/healthz", get(|| async { "ok" }))
    .merge(api_routes)
    .layer(
        ServiceBuilder::new()
            .layer(TraceLayer::new_for_http())
            // tower-http 0.6.7+: TimeoutLayer::new is deprecated, pick the status
            .layer(TimeoutLayer::with_status_code(
                StatusCode::GATEWAY_TIMEOUT,
                Duration::from_secs(10),
            ))
            .layer(CorsLayer::permissive()),
    );`,
      },
      {
        name: 'serve with graceful shutdown',
        code: `let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await?;

axum::serve(listener, app)
    .with_graceful_shutdown(async move {
        // SIGINT in dev; wire SIGTERM with tokio::signal::unix in production
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;`,
      },
      {
        name: 'WebSocket route (ws feature)',
        code: `use axum::{extract::ws::{WebSocket, WebSocketUpgrade}, response::Response, routing::any};

async fn ws_handler(ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(handle_socket)
}

async fn handle_socket(mut socket: WebSocket) {
    while let Some(msg) = socket.recv().await {
        let Ok(msg) = msg else { return };       // client disconnected
        if socket.send(msg).await.is_err() {
            return;
        }
    }
}

// Router::new().route("/ws", any(ws_handler))`,
      },
      {
        name: 'extractor order and JSON bodies',
        code: `use axum::{extract::{Extension, State}, http::StatusCode, Json};

// AuthUser is your own extension type, inserted by the auth middleware.
pub struct AuthUser { pub id: uuid::Uuid }

// Body-consuming extractors (Json, Form, Multipart) MUST be the last argument.
async fn create_order(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Json(payload): Json<CreateOrder>,
) -> Result<(StatusCode, Json<Order>), AppError> {
    let order = state.orders.create(user.id, payload).await?;
    Ok((StatusCode::CREATED, Json(order)))
}`,
      },
    ],
  },
  {
    title: 'Serde & validation',
    items: [
      {
        name: 'strict input struct',
        code: `use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
pub struct CreateAccount {
    pub email: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default = "default_plan")]
    pub plan: String,
}

fn default_plan() -> String { "free".into() }`,
      },
      {
        name: 'output struct that hides fields',
        code: `#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub id: uuid::Uuid,
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing)]
    pub password_hash: String,
}`,
      },
      {
        name: 'validate the payload before the DB',
        code: `use validator::Validate;

#[derive(Debug, Deserialize, Validate)]
pub struct Signup {
    #[validate(email)]
    pub email: String,
    #[validate(length(min = 12, max = 128))]
    pub password: String,
}

// in the handler:
payload.validate().map_err(|e| AppError::BadRequest(e.to_string()))?;`,
      },
      {
        name: 'internally tagged event enum',
        code: `#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OrderEvent {
    Created { order_id: uuid::Uuid, total_cents: i64 },
    Cancelled { order_id: uuid::Uuid, reason: String },
}

// {"type":"created","order_id":"...","total_cents":1999}`,
      },
      {
        name: 'field-level JSON errors',
        code: `use serde_path_to_error as path;

// serde's own error has no JSON path; this points at the offending field.
let mut de = serde_json::Deserializer::from_slice(&body);
let payload: CreateOrder = path::deserialize(&mut de)
    .map_err(|e| AppError::BadRequest(format!("{} at {}", e, e.path())))?;`,
      },
    ],
  },
  {
    title: 'SQLx (Postgres)',
    items: [
      {
        name: 'pool with timeouts',
        code: `use sqlx::postgres::PgPoolOptions;
use std::time::Duration;

let pool = PgPoolOptions::new()
    .max_connections(20)
    .min_connections(2)
    .acquire_timeout(Duration::from_secs(3))   // backpressure, not endless queueing
    .idle_timeout(Duration::from_secs(600))
    .max_lifetime(Duration::from_secs(1800))
    .connect(&std::env::var("DATABASE_URL")?)
    .await?;`,
      },
      {
        name: 'typed row mapping',
        code: `#[derive(Debug, sqlx::FromRow)]
struct User {
    id: uuid::Uuid,
    email: String,
}

let user = sqlx::query_as::<_, User>("select id, email from users where id = $1")
    .bind(id)
    .fetch_one(&pool)
    .await?;`,
      },
      {
        name: 'transaction (drop = rollback)',
        code: `let mut tx = pool.begin().await?;

sqlx::query("update accounts set balance_cents = balance_cents - $1 where id = $2")
    .bind(cents).bind(from)
    .execute(&mut *tx).await?;

sqlx::query("update accounts set balance_cents = balance_cents + $1 where id = $2")
    .bind(cents).bind(to)
    .execute(&mut *tx).await?;

tx.commit().await?;   // dropping without commit rolls back`,
      },
      {
        name: 'compile-time checked queries + migrations',
        code: `// Needs DATABASE_URL at build time, or a committed .sqlx/ from:
//   cargo sqlx prepare
let row = sqlx::query!("select id, email from users where email = $1", email)
    .fetch_optional(&pool)
    .await?;

// apply embedded migrations at startup (single-replica bootstrap or a Job)
sqlx::migrate!("./migrations").run(&pool).await?;`,
      },
      {
        name: 'keyset pagination',
        code: `// Stable under inserts and no OFFSET scan: the index does the work.
let rows = sqlx::query_as::<_, User>(
    "select id, email, created_at from users
     where (created_at, id) < ($1, $2)
     order by created_at desc, id desc
     limit $3",
)
.bind(cursor_created_at)
.bind(cursor_id)
.bind(limit)
.fetch_all(&pool)
.await?;`,
      },
      {
        name: 'bulk insert in one round trip',
        code: `let ids: Vec<uuid::Uuid> = items.iter().map(|i| i.id).collect();
let payloads: Vec<String> = items.iter().map(|i| i.payload.clone()).collect();

sqlx::query(
    "insert into events (id, payload)
     select * from unnest($1::uuid[], $2::text[])
     on conflict (id) do nothing",
)
.bind(&ids)
.bind(&payloads)
.execute(&pool)
.await?;`,
      },
    ],
  },
  {
    title: 'Redis',
    items: [
      {
        name: 'async connection + cache write',
        code: `use redis::AsyncCommands;

let client = redis::Client::open(std::env::var("REDIS_URL")?)?;
let mut conn = client.get_multiplexed_async_connection().await?;

// multiplexed connections are cheap to clone; no pool needed for async
let _: () = conn.set_ex("session:42", token, 900).await?;
let cached: Option<String> = conn.get("session:42").await?;`,
      },
      {
        name: 'cache-aside with explicit TTL',
        code: `let key = format!("tenant:{tenant_id}:user:{id}");

if let Some(json) = redis::cmd("GET")
    .arg(&key)
    .query_async::<Option<String>>(&mut conn)
    .await?
{
    return Ok(serde_json::from_str(&json)?);
}

let user = load_from_db(&pool, tenant_id, id).await?;
let _: () = redis::cmd("SET")
    .arg(&key)
    .arg(serde_json::to_string(&user)?)
    .arg("EX").arg(300)
    .query_async(&mut conn)
    .await?;`,
      },
      {
        name: 'atomic rate limit with a Lua script',
        code: `let script = redis::Script::new(
    r#"
    local current = redis.call('INCR', KEYS[1])
    if current == 1 then
        redis.call('PEXPIRE', KEYS[1], ARGV[1])
    end
    return current
    "#,
);

let count: i64 = script
    .key(format!("rl:{user_id}"))
    .arg(60_000)
    .invoke_async(&mut conn)
    .await?;

if count > 100 {
    return Err(AppError::TooManyRequests);
}`,
      },
      {
        name: 'distributed lock (SET NX PX + owner token)',
        code: `let token = uuid::Uuid::new_v4().to_string();
let acquired: Option<String> = redis::cmd("SET")
    .arg(&lock_key)
    .arg(&token)
    .arg("NX").arg("PX").arg(30_000)
    .query_async(&mut conn)
    .await?;
if acquired.is_none() {
    return Err(AppError::Locked);
}

// Release only if we still own it. A bare DEL can delete someone else's lock.
let released: i64 = redis::Script::new(
    r#"
    if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
    end
    return 0
    "#,
)
.key(&lock_key)
.arg(&token)
.invoke_async(&mut conn)
.await?;
debug_assert_eq!(released, 1);`,
      },
      {
        name: 'pub/sub across replicas (RESP3)',
        code: `use redis::AsyncCommands;

let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
let config = redis::AsyncConnectionConfig::new().set_push_sender(tx);
let mut conn = client
    .get_multiplexed_async_connection_with_config(&config)
    .await?;

conn.subscribe(&["orders.created", "orders.cancelled"]).await?;

while let Some(push) = rx.recv().await {
    // redis::PushInfo: decode the payload with FromRedisValue, then fan out locally
    tracing::debug!(?push, "redis push message");
}`,
      },
    ],
  },
  {
    title: 'tonic / gRPC',
    items: [
      {
        name: 'build.rs codegen (tonic 0.14)',
        code: `// Cargo.toml
// [dependencies] tonic = "0.14", prost = "0.14"
// [build-dependencies] tonic-prost-build = "0.14"

fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_prost_build::configure()
        .build_client(true)
        .build_server(true)
        .compile_protos(&["proto/orders.proto"], &["proto"])?;
    Ok(())
}`,
      },
      {
        name: 'service impl with Status mapping',
        code: `use tonic::{Request, Response, Status};

#[tonic::async_trait]
impl Orders for OrdersService {
    async fn get_order(
        &self,
        request: Request<GetOrderRequest>,
    ) -> Result<Response<Order>, Status> {
        let id = uuid::Uuid::parse_str(&request.into_inner().id)
            .map_err(|_| Status::invalid_argument("id must be a UUID"))?;

        let order = self.store.load(id).await
            .map_err(|e| Status::internal(e.to_string()))?
            .ok_or_else(|| Status::not_found("order not found"))?;

        Ok(Response::new(order.into()))
    }
}`,
      },
      {
        name: 'server with health + graceful shutdown',
        code: `use tonic::transport::Server;
use tonic_health::server::health_reporter;

let (mut reporter, health_service) = health_reporter();
// flips grpc.health.v1 to SERVING for this service
reporter.set_serving::<OrdersServer<OrdersService>>().await;

Server::builder()
    .add_service(health_service)
    .add_service(OrdersServer::new(service))
    .serve_with_shutdown(addr, async {
        let _ = tokio::signal::ctrl_c().await;
        // flip to NOT_SERVING here before draining in real code
    })
    .await?;`,
      },
      {
        name: 'client with connect + call deadlines',
        code: `use std::time::Duration;
use tonic::transport::{Channel, Endpoint};

let channel: Channel = Endpoint::from_shared(std::env::var("ORDERS_URL")?)?
    .connect_timeout(Duration::from_secs(2))
    .timeout(Duration::from_secs(2))   // per-attempt deadline
    .connect()
    .await?;

let mut client = OrdersClient::new(channel)
    .max_decoding_message_size(8 * 1024 * 1024);

let order = client.get_order(GetOrderRequest { id }).await?.into_inner();`,
      },
      {
        name: 'server-streaming RPC',
        code: `use tokio_stream::wrappers::ReceiverStream;

type WatchStream = ReceiverStream<Result<OrderEvent, Status>>;

#[tonic::async_trait]
impl Orders for OrdersService {
    type WatchStream = WatchStream;

    async fn watch(
        &self,
        request: Request<WatchRequest>,
    ) -> Result<Response<Self::WatchStream>, Status> {
        let (tx, rx) = tokio::sync::mpsc::channel(64);
        let mut updates = self.subscribe(request.into_inner().tenant_id).await?;
        tokio::spawn(async move {
            while let Some(event) = updates.recv().await {
                if tx.send(Ok(event)).await.is_err() { break; }
            }
        });
        Ok(Response::new(ReceiverStream::new(rx)))
    }
}`,
      },
      {
        name: 'metadata interceptor for auth/tracing',
        code: `use tonic::{service::Interceptor, Request, Status};

#[derive(Clone)]
struct Auth { token: String }

impl Interceptor for Auth {
    fn call(&mut self, mut req: Request<()>) -> Result<Request<()>, Status> {
        req.metadata_mut().insert(
            "authorization",
            format!("Bearer {}", self.token).parse().unwrap(),
        );
        Ok(req)
    }
}

let client = OrdersClient::with_interceptor(channel, Auth { token });`,
      },
    ],
  },
  {
    title: 'Kafka with rdkafka',
    items: [
      {
        name: 'idempotent producer, keyed records',
        code: `use rdkafka::config::ClientConfig;
use rdkafka::producer::{FutureProducer, FutureRecord};
use rdkafka::util::Timeout;

let producer: FutureProducer = ClientConfig::new()
    .set("bootstrap.servers", &brokers)
    .set("enable.idempotence", "true")   // no duplicates on internal retry
    .set("acks", "all")
    .set("linger.ms", "5")
    .set("message.timeout.ms", "5000")
    .create()?;

let record = FutureRecord::to("orders.events")
    .key(&order_id.to_string())   // same key -> same partition -> ordering
    .payload(&serde_json::to_vec(&event)?);

producer
    .send(record, Timeout::After(std::time::Duration::from_secs(5)))
    .await
    .map_err(|(err, _msg)| err)?;`,
      },
      {
        name: 'at-least-once consumer (commit after work)',
        code: `use futures_util::StreamExt;
use rdkafka::consumer::{CommitMode, Consumer, StreamConsumer};

let consumer: StreamConsumer = ClientConfig::new()
    .set("bootstrap.servers", &brokers)
    .set("group.id", "billing")
    .set("enable.auto.commit", "false")   // never commit before the side effect
    .set("auto.offset.reset", "earliest")
    .set("isolation.level", "read_committed")
    .create()?;
consumer.subscribe(&["orders.events"])?;

let mut stream = consumer.stream();
while let Some(result) = stream.next().await {
    let msg = result?;
    handle(&msg).await?;
    consumer.commit_message(&msg, CommitMode::Async)?;
}`,
      },
      {
        name: 'dead-letter after handler failure',
        code: `use rdkafka::message::{Header, Message, OwnedHeaders};

async fn handle_or_dlq(
    msg: &rdkafka::message::BorrowedMessage<'_>,
    producer: &FutureProducer,
) -> anyhow::Result<()> {
    match handle(msg).await {
        Ok(()) => Ok(()),
        Err(_err) => {
            let mut headers = OwnedHeaders::new();
            headers = headers.insert(Header { key: "x-error", value: Some(b"handler-failed") });

            producer
                .send(
                    FutureRecord::to("orders.events.dlq")
                        .payload(msg.payload().unwrap_or_default())
                        .headers(headers),
                    Timeout::After(std::time::Duration::from_secs(5)),
                )
                .await
                .map_err(|(e, _)| e)?;
            Ok(())
        }
    }
}`,
      },
      {
        name: 'replay one partition',
        code: `use rdkafka::consumer::{CommitMode, Consumer};
use rdkafka::{Offset, TopicPartitionList};

// Rewind a partition to the beginning: useful for replaying a bug fix.
let mut tpl = TopicPartitionList::new();
tpl.add_partition_offset("orders.events", 0, Offset::Beginning)?;
consumer.assign(&tpl)?;

// Graceful shutdown: stop polling and commit the final state synchronously.
consumer.unsubscribe()?;
consumer.commit_consumer_state(CommitMode::Sync)?;`,
      },
    ],
  },
  {
    title: 'NATS with async-nats',
    items: [
      {
        name: 'connect, publish, flush',
        code: `let client = async_nats::connect_with_options(
    std::env::var("NATS_URL")?,
    async_nats::ConnectOptions::new().retry_on_initial_connect(),
)
.await?;

client.publish("orders.created", payload.into()).await?;
client.flush().await?;   // don't exit before the internal buffer drains`,
      },
      {
        name: 'headers (dedupe + tracing ids)',
        code: `let mut headers = async_nats::HeaderMap::new();
headers.insert("Nats-Msg-Id", "order-7f3c1a");   // server-side dedupe window

client
    .publish_with_headers("orders.created", headers, payload.into())
    .await?;`,
      },
      {
        name: 'JetStream stream + durable consumer',
        code: `use futures_util::StreamExt;

// async-nats = { version = "0.51", features = ["jetstream"] }
let js = async_nats::jetstream::new(client);

let stream = js
    .get_or_create_stream(async_nats::jetstream::stream::Config {
        name: "ORDERS".to_string(),
        subjects: vec!["orders.>".to_string()],
        ..Default::default()
    })
    .await?;

let consumer = stream
    .get_or_create_consumer(
        "billing",
        async_nats::jetstream::consumer::pull::Config {
            durable_name: Some("billing".to_string()),
            ..Default::default()
        },
    )
    .await?;

let mut messages = consumer.messages().await?;
while let Some(message) = messages.next().await {
    let message = message?;
    handle(&message.payload).await?;
    message.ack().await?;
}`,
      },
      {
        name: 'request/reply and KV',
        code: `// Core NATS request/reply: one call, one response.
let reply = client.request("orders.lookup", key.into()).await?;
let order: Order = serde_json::from_slice(&reply.payload)?;

// Key-value store on top of JetStream (last value wins, revision-checked).
let kv = js.get_key_value("config").await?;
let flags = kv.get("feature.flags").await?;

if let Some(flags) = flags {
    let flags: FeatureFlags = serde_json::from_slice(&flags)?;
    tracing::info!(?flags, "loaded remote config");
}`,
      },
    ],
  },
  {
    title: 'Tokio tasks & cancellation',
    items: [
      {
        name: 'JoinSet for a batch of tasks',
        code: `use tokio::task::JoinSet;

let mut set = JoinSet::new();
for job in jobs {
    set.spawn(async move { process(job).await });
}

while let Some(result) = set.join_next().await {
    match result {
        Ok(Ok(())) => {}
        Ok(Err(err)) => tracing::warn!(%err, "job failed"),
        Err(join_err) => tracing::error!(%join_err, "job panicked"),
    }
}`,
      },
      {
        name: 'CancellationToken + select',
        code: `use tokio::select;
use tokio_util::sync::CancellationToken;

let token = CancellationToken::new();
let worker = token.clone();

let handle = tokio::spawn(async move {
    loop {
        select! {
            _ = worker.cancelled() => break,
            msg = rx.recv() => match msg {
                Some(msg) => handle(msg).await,
                None => break,
            },
        }
    }
});

token.cancel();      // from the signal handler
handle.await?;      // wait for the flush`,
      },
      {
        name: 'TaskTracker drains in-flight work',
        code: `use tokio_util::task::TaskTracker;

let tracker = TaskTracker::new();
for connection in listener_loop() {
    tracker.spawn(serve_connection(connection));
}

tracker.close();       // no new tasks accepted
tracker.wait().await;  // resolves after every spawned task finishes`,
      },
      {
        name: 'bounded concurrency with a semaphore',
        code: `use std::sync::Arc;
use tokio::sync::Semaphore;

let limit = Arc::new(Semaphore::new(32));   // max concurrent outbound calls

for id in ids {
    let permit = limit.clone().acquire_owned().await?;
    tokio::spawn(async move {
        let _permit = permit;   // released on drop
        let _ = fetch_and_store(id).await;
    });
}`,
      },
      {
        name: 'never block a worker thread',
        code: `// CPU-heavy or blocking FFI work belongs on the blocking pool.
let hash = tokio::task::spawn_blocking(move || expensive_hash(&input)).await??;

// File I/O: use tokio::fs / AsyncRead, not std::fs inside an async fn.
let body = tokio::fs::read_to_string("config.toml").await?;`,
      },
      {
        name: 'timeout around any upstream call',
        code: `use tokio::time::{timeout, Duration};

match timeout(Duration::from_millis(250), cache.get(&key)).await {
    Ok(Ok(value)) => value,
    Ok(Err(err)) => return Err(err.into()),
    Err(_elapsed) => return Err(AppError::UpstreamTimeout),
}`,
      },
    ],
  },
  {
    title: 'Processes, signals & shutdown',
    items: [
      {
        name: 'SIGTERM + SIGINT',
        code: `use tokio::signal::unix::{signal, SignalKind};

let mut sigterm = signal(SignalKind::terminate())?;
let mut sigint = signal(SignalKind::interrupt())?;

tokio::select! {
    _ = sigterm.recv() => tracing::info!("SIGTERM received"),
    _ = sigint.recv() => tracing::info!("SIGINT received"),
}`,
      },
      {
        name: 'shutdown order matters',
        code: `// 1. stop accepting new work
token.cancel();                 // tell background tasks
drop(listener);                 // close the accept loop

// 2. drain in-flight work
tracker.close();
tracker.wait().await;

// 3. release resources, then flush telemetry
pool.close().await;             // sqlx: waits for checked-out connections
tracer_provider.shutdown()?;    // last spans are not lost`,
      },
      {
        name: 'subprocess with timeout + kill_on_drop',
        code: `use std::process::Stdio;
use tokio::process::Command;

let mut child = Command::new("ffmpeg")
    .args(["-i", input, "-f", "null", "-"])
    .stdout(Stdio::null())
    .stderr(Stdio::piped())
    .kill_on_drop(true)          // orphan-proof if the future is dropped
    .spawn()?;

let status = tokio::time::timeout(std::time::Duration::from_secs(300), child.wait()).await??;
anyhow::ensure!(status.success(), "ffmpeg exited with {status}");`,
      },
      {
        name: 'stream a child\'s stdout',
        code: `use tokio::io::{AsyncBufReadExt, BufReader};

let stdout = child.stdout.take().expect("stdout piped");
let mut lines = BufReader::new(stdout).lines();

while let Some(line) = lines.next_line().await? {
    if let Some(rest) = line.strip_prefix("progress=") {
        metrics.set_progress(rest);
    }
}

let status = child.wait().await?;`,
      },
      {
        name: 'supervisor loop with capped backoff',
        code: `let mut delay = std::time::Duration::from_millis(200);

loop {
    let mut child = spawn_worker()?;

    tokio::select! {
        status = child.wait() => {
            tracing::warn!(?status, "worker exited; restarting");
            delay = (delay * 2).min(std::time::Duration::from_secs(30));
        }
        _ = token.cancelled() => {
            child.kill().await?;
            break;
        }
    }

    tokio::time::sleep(delay).await;
}`,
      },
    ],
  },
  {
    title: 'Observability (tracing + metrics)',
    items: [
      {
        name: 'subscriber with env filter',
        code: `use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

tracing_subscriber::registry()
    .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,tower_http=debug".into()))
    .with(fmt::layer())
    .init();`,
      },
      {
        name: 'production JSON logs',
        code: `use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

let fmt_layer = fmt::layer()
    .json()                // one object per line for the log pipeline
    .with_current_span(true)
    .with_target(true);

tracing_subscriber::registry()
    .with(EnvFilter::try_from_env("RUST_LOG")?)
    .with(fmt_layer)
    .init();`,
      },
      {
        name: '#[instrument] with useful fields',
        code: `#[tracing::instrument(
    skip(pool, payload),
    fields(order.id = %order_id, user.id = %user_id)
)]
async fn create_order(
    pool: &sqlx::PgPool,
    user_id: uuid::Uuid,
    order_id: uuid::Uuid,
    payload: CreateOrder,
) -> Result<Order, AppError> {
    // every event inside carries order.id, user.id and the trace/span ids
    let order = insert_order(pool, order_id, payload).await?;
    Ok(order)
}`,
      },
      {
        name: 'OTLP trace pipeline (tonic exporter)',
        code: `use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::SpanExporter;
use opentelemetry_sdk::{trace::SdkTracerProvider, Resource};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

let exporter = SpanExporter::builder()
    .with_tonic()
    .with_endpoint("http://otel-collector:4317")
    .build()?;

let tracer_provider = SdkTracerProvider::builder()
    .with_batch_exporter(exporter)
    .with_resource(Resource::builder().with_service_name("orders-api").build())
    .build();

let tracer = tracer_provider.tracer("orders-api");
tracing_subscriber::registry()
    .with(tracing_opentelemetry::layer().with_tracer(tracer))
    .with(tracing_subscriber::fmt::layer())
    .init();

// on shutdown: tracer_provider.shutdown()?;`,
      },
      {
        name: 'RED metrics: counter + histogram',
        code: `use opentelemetry::{global, KeyValue};

let meter = global::meter("orders-api");
let requests = meter.u64_counter("http.server.requests").build();
let latency = meter.f64_histogram("http.server.duration_ms").build();

requests.add(1, &[
    KeyValue::new("route", "/orders"),
    KeyValue::new("status", "200"),
]);
latency.record(12.4, &[KeyValue::new("route", "/orders")]);`,
      },
      {
        name: 'log context, record errors once',
        code: `// Structured fields are searchable; keep PII out of them.
tracing::info!(
    order.id = %order_id,
    amount_cents = order.total_cents,
    customer.tier = %tier,
    "order accepted"
);

// Error path: one event with the error field, linked to the active span.
tracing::error!(error = %err, error.kind = "db", "order insert failed");`,
      },
    ],
  },
  {
    title: 'Config & secrets',
    items: [
      {
        name: 'layered config with figment',
        code: `use figment::{providers::{Env, Format, Serialized, Toml}, Figment};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Config {
    pub database_url: String,
    #[serde(default = "default_port")]
    pub port: u16,
}
fn default_port() -> u16 { 8080 }

impl Default for Config {
    fn default() -> Self {
        Self { database_url: String::new(), port: default_port() }
    }
}

let config: Config = Figment::new()
    .merge(Serialized::defaults(Config::default()))
    .merge(Toml::file("config.toml"))
    .merge(Env::prefixed("APP_").split("__"))   // APP_DATABASE__URL overrides
    .extract()?;`,
      },
      {
        name: 'fail fast on a missing secret',
        code: `use anyhow::Context;

fn required(name: &str) -> anyhow::Result<String> {
    std::env::var(name).with_context(|| format!("{name} must be set"))
}

let jwt_secret = required("JWT_SECRET")?;
anyhow::ensure!(jwt_secret.len() >= 32, "JWT_SECRET must be at least 32 bytes");`,
      },
      {
        name: 'a Debug impl that redacts',
        code: `pub struct DatabaseConfig {
    pub url: String,
    pub password: Option<String>,
}

impl std::fmt::Debug for DatabaseConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DatabaseConfig")
            .field("url", &"<redacted>")
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}`,
      },
      {
        name: 'validate config at startup',
        code: `#[derive(Debug, serde::Deserialize, validator::Validate)]
pub struct Config {
    #[validate(url)]
    pub database_url: String,
    #[validate(range(min = 1, max = 65535))]
    pub port: u16,
    #[validate(range(min = 1, max = 1000))]
    pub max_db_connections: u32,
}

let config: Config = figment.extract()?;
config.validate()?;   // fail at boot, not on the first request`,
      },
      {
        name: 'no silent defaults for credentials',
        code: `// 12-factor: config arrives from the environment; the image holds no secrets.
let config = Config {
    database_url: required("DATABASE_URL")?,
    jwt_secret: required("JWT_SECRET")?,
    redis_url: required("REDIS_URL")?,
    // optional tuning knobs may default; credentials may not
    port: std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080),
};`,
      },
    ],
  },
  {
    title: 'Resilience',
    items: [
      {
        name: 'retry with exponential backoff',
        code: `use std::time::Duration;
use backon::{ExponentialBuilder, Retryable};

let body = (|| async { client.get(&url).send().await?.error_for_status() })
    .retry(
        ExponentialBuilder::default()
            .with_min_delay(Duration::from_millis(100))
            .with_max_delay(Duration::from_secs(5))
            .with_max_times(5),
    )
    .notify(|err, delay| tracing::warn!(%err, ?delay, "retrying upstream"))
    .await?;`,
      },
      {
        name: 'circuit breaker',
        code: `use std::sync::atomic::{AtomicU32, Ordering};

pub struct Breaker {
    failures: AtomicU32,
}

impl Breaker {
    pub fn allow(&self) -> bool {
        self.failures.load(Ordering::Relaxed) < 5
    }

    pub fn record(&self, ok: bool) {
        if ok {
            self.failures.store(0, Ordering::Relaxed);
        } else {
            self.failures.fetch_add(1, Ordering::Relaxed);
        }
    }
}`,
      },
      {
        name: 'retry only idempotent operations',
        code: `// Safe to replay: idempotency key sent with every attempt.
let request = || client.post(&url).header("Idempotency-Key", &key).json(&order).send();

// Every attempt also gets a deadline: no unbounded awaits.
let response = request
    .retry(ExponentialBuilder::default().with_max_times(3))
    .await?;

// Never blind-retry a non-idempotent call whose success you can't observe.`,
      },
      {
        name: 'idempotency key table',
        code: `// The unique index does the dedupe; the row records the outcome.
let inserted = sqlx::query(
    "insert into idempotency_keys (key, request_hash, status)
     values ($1, $2, 'in_progress')
     on conflict (key) do nothing
     returning key",
)
.bind(&key)
.bind(&request_hash)
.fetch_optional(&pool)
.await?;

if inserted.is_none() {
    // A previous attempt owns this key: return the stored response.
    return load_stored_response(&pool, &key).await;
}`,
      },
      {
        name: 'bulkheads per dependency',
        code: `// One slow dependency must not consume every connection in the process.
pub struct Bulkheads {
    pub payments: Arc<tokio::sync::Semaphore>,
    pub search: Arc<tokio::sync::Semaphore>,
}

let _permit = state.bulkheads.payments.clone()
    .try_acquire_owned()
    .map_err(|_| AppError::Overloaded)?;   // fail fast instead of queueing forever`,
      },
      {
        name: 'degrade instead of failing',
        code: `match primary.load(id).await {
    Ok(value) => Ok(value),
    Err(err) => {
        tracing::warn!(%err, "primary failed, serving cache");
        cache.get(id).await?.ok_or(AppError::Unavailable)
    }
}`,
      },
    ],
  },
  {
    title: 'Security',
    items: [
      {
        name: 'hash passwords with Argon2',
        code: `use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};

let salt = SaltString::generate(&mut OsRng);
let hash = Argon2::default()
    .hash_password(password.as_bytes(), &salt)?
    .to_string();

// verify a login attempt
let parsed = PasswordHash::new(&hash)?;
let ok = Argon2::default()
    .verify_password(attempt.as_bytes(), &parsed)
    .is_ok();`,
      },
      {
        name: 'JWT encode/decode',
        code: `use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};

#[derive(serde::Serialize, serde::Deserialize)]
struct Claims { sub: String, exp: usize, tenant: String }

let now = chrono::Utc::now().timestamp() as usize;
let claims = Claims { sub: user_id.to_string(), exp: now + 900, tenant };
let token = encode(&Header::default(), &claims, &EncodingKey::from_secret(secret))?;

let data = decode::<Claims>(
    &token,
    &DecodingKey::from_secret(secret),
    &Validation::new(Algorithm::HS256),
)?;`,
      },
      {
        name: 'constant-time secret comparison',
        code: `use subtle::ConstantTimeEq;

// API keys / webhook signatures: compare without leaking timing information.
let expected = api_key_from_db.as_bytes();
let provided = header_value.as_bytes();

if provided.ct_eq(expected).unwrap_u8() == 1 {
    // authenticated
} else {
    // reject; do not log either value
}`,
      },
      {
        name: 'CORS with an explicit allow-list',
        code: `use axum::http::{header, HeaderValue, Method};
use tower_http::cors::CorsLayer;

let cors = CorsLayer::new()
    .allow_origin("https://app.example.com".parse::<HeaderValue>()?)
    .allow_methods([Method::GET, Method::POST])
    .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);

let app = Router::new().route("/api/orders", get(list)).layer(cors);`,
      },
      {
        name: 'bind every value, never format SQL',
        code: `// WRONG: string-built SQL is injection by construction.
let sql = format!("select * from users where email = '{email}'");

// RIGHT: bind values; identifiers come from an allow-list, never the request.
sqlx::query_as::<_, User>("select id, email from users where email = $1")
    .bind(email)
    .fetch_one(&pool)
    .await?;`,
      },
      {
        name: 'mark credential headers sensitive',
        code: `use axum::http::header;
use tower_http::sensitive_headers::SetSensitiveRequestHeadersLayer;

// TraceLayer and friends then redact these headers instead of logging them.
let app = Router::new().merge(routes).layer(
    SetSensitiveRequestHeadersLayer::new([header::AUTHORIZATION, header::COOKIE]),
);`,
      },
    ],
  },
  {
    title: 'Testing',
    items: [
      {
        name: '#[tokio::test]',
        code: `#[tokio::test]
async fn parses_order() {
    let order: Order = serde_json::from_str(FIXTURE).unwrap();
    assert_eq!(order.items.len(), 2);
    assert!(order.total_cents > 0);
}`,
      },
      {
        name: 'call the router without a socket',
        code: `use axum::{body::Body, http::{Request, StatusCode}};
use tower::ServiceExt;   // for oneshot()

#[tokio::test]
async fn rejects_bad_payload() {
    let app = app(pool()).await;      // Router
    let request = Request::builder()
        .method("POST")
        .uri("/users")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"email":"not-an-email"}"#))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}`,
      },
      {
        name: 'sqlx::test gives each test a database',
        code: `// Migrations run automatically; the database is dropped afterwards.
#[sqlx::test(migrations = "./migrations")]
async fn unique_email_is_enforced(pool: sqlx::PgPool) {
    sqlx::query("insert into users (id, email) values (gen_random_uuid(), 'a@b.c')")
        .execute(&pool).await.unwrap();

    let err = sqlx::query("insert into users (id, email) values (gen_random_uuid(), 'a@b.c')")
        .execute(&pool).await.unwrap_err();

    assert!(matches!(err, sqlx::Error::Database(_)));
}`,
      },
      {
        name: 'property tests',
        code: `use proptest::prelude::*;

proptest! {
    #[test]
    fn parser_never_panics(input in ".*") {
        let _ = parse_order(&input);
    }

    #[test]
    fn amounts_roundtrip(amount in 0i64..1_000_000) {
        let encoded = encode(amount);
        prop_assert_eq!(decode(&encoded), Ok(amount));
    }
}`,
      },
      {
        name: 'integration test on an ephemeral port',
        code: `async fn spawn(app: axum::Router) -> std::net::SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    addr
}`,
      },
      {
        name: 'deterministic timeouts with paused time',
        code: `#[tokio::test(start_paused = true)]
async fn deadline_is_enforced() {
    let result = tokio::time::timeout(std::time::Duration::from_millis(100), async {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    })
    .await;

    assert!(result.is_err());   // virtual clock: instant test, no flake
}`,
      },
    ],
  },
  {
    title: 'Docker & Kubernetes',
    items: [
      {
        name: 'multi-stage Dockerfile',
        code: `# syntax=docker/dockerfile:1
FROM rust:1-bookworm AS builder
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates

RUN --mount=type=cache,target=/usr/local/cargo/registry \\
    --mount=type=cache,target=/src/target \\
    cargo build --release --locked --bin api \\
 && cp /src/target/release/api /usr/local/bin/api

FROM gcr.io/distroless/cc-debian12
COPY --from=builder /usr/local/bin/api /api
USER nonroot:nonroot
ENTRYPOINT ["/api"]`,
      },
      {
        name: 'immutable tags + deploy-arch build',
        code: `# Build for the cluster architecture and tag with the commit, not "latest".
docker buildx build \\
  --platform linux/amd64 \\
  -t registry.example.com/api:$(git rev-parse --short HEAD) \\
  --push .

# Run the exact artifact locally with the same env contract.
docker run --rm -p 8080:8080 \\
  -e RUST_LOG=info -e DATABASE_URL=postgres://localhost/app \\
  registry.example.com/api:abc1234`,
      },
      {
        name: 'three probes, three jobs',
        code: `# deployment.yaml (excerpt)
containers:
  - name: api
    image: registry.example.com/api:1.4.2
    ports: [{ containerPort: 8080 }]
    startupProbe:                    # slow boot is fine: gates the other two
      httpGet: { path: /healthz, port: 8080 }
      periodSeconds: 2
      failureThreshold: 30
    readinessProbe:                  # stop routing when dependencies fail
      httpGet: { path: /readyz, port: 8080 }
      periodSeconds: 5
    livenessProbe:                   # restart only when truly wedged
      httpGet: { path: /healthz, port: 8080 }
      periodSeconds: 10
      failureThreshold: 3`,
      },
      {
        name: 'termination that drains',
        code: `terminationGracePeriodSeconds: 30
containers:
  - name: api
    lifecycle:
      preStop:
        exec:
          command: ["sleep", "5"]   # let endpoints converge before SIGTERM lands`,
      },
      {
        name: 'rolling update + disruption budget',
        code: `strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 1
    maxUnavailable: 0        # never dip below the desired replica count
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: api }
spec:
  minAvailable: 1
  selector:
    matchLabels: { app: api }`,
      },
      {
        name: 'locked-down pod + resources',
        code: `securityContext:
  runAsNonRoot: true
  runAsUser: 65532
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities: { drop: ["ALL"] }
resources:
  requests: { cpu: "100m", memory: "128Mi" }
  limits:   { memory: "256Mi" }   # memory limit yes, CPU limit no: avoid throttling`,
      },
    ],
  },
  {
    title: 'Performance',
    items: [
      {
        name: 'criterion benchmark',
        code: `use criterion::{criterion_group, criterion_main, Criterion};
use std::hint::black_box;

fn bench_parse(c: &mut Criterion) {
    let input = std::fs::read_to_string("fixtures/orders.json").unwrap();
    c.bench_function("parse_orders", |b| {
        b.iter(|| parse_orders(black_box(&input)))
    });
}

criterion_group!(benches, bench_parse);
criterion_main!(benches);`,
      },
      {
        name: 'flamegraph the release binary',
        code: `cargo install flamegraph
cargo flamegraph --bin api -- --config config.toml

# or sample with perf and inspect the report
perf record -F 999 -g -- ./target/release/api
perf report --no-children`,
      },
      {
        name: 'read the query plan, then index',
        code: `-- Find the sequential scan before adding an index.
explain (analyze, buffers, format text)
select id, email from users
where tenant_id = $1
order by created_at desc
limit 50;

-- CONCURRENTLY keeps writes flowing while the index builds.
create index concurrently if not exists users_tenant_created_idx
    on users (tenant_id, created_at desc);`,
      },
      {
        name: 'stop reallocating per iteration',
        code: `// Reuse one buffer instead of allocating a String per row.
let mut buf = String::with_capacity(4096);
for record in records {
    buf.clear();
    writeln!(&mut buf, "{}\\t{}", record.id, record.total_cents)?;
    writer.write_all(buf.as_bytes()).await?;
}`,
      },
      {
        name: 'size the runtime, move CPU work off it',
        code: `#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> anyhow::Result<()> {
    // CPU-bound work goes to the blocking pool; workers stay responsive.
    let hash = tokio::task::spawn_blocking(move || expensive_hash(input)).await??;
    tracing::info!(%hash, "computed");
    Ok(())
}`,
      },
      {
        name: 'swap in mimalloc for allocation-heavy servers',
        code: `// Cargo.toml: mimalloc = { version = "0.1", default-features = false }

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() {
    // A faster allocator is a free win when the profile is dominated by
    // many small allocations; measure before and after.
}`,
      },
    ],
  },
  {
    title: 'Embedded Rust (no_std)',
    items: [
      {
        name: 'no_std crate skeleton',
        code: `# Cargo.toml - a bare-metal binary for a Cortex-M board
[package]
name = "sensor-node"
version = "0.1.0"
edition = "2024"

[dependencies]
cortex-m = "0.7"
cortex-m-rt = "0.7"
panic-halt = "1"
defmt = "1"
defmt-rtt = "1"
embedded-hal = "1.0"

[profile.release]
opt-level = "s"
lto = true
codegen-units = 1
debug = true          # keep symbols for probe-rs / defmt`,
      },
      {
        name: 'entry point + panic/log handlers',
        code: `#![no_std]
#![no_main]

use cortex_m_rt::entry;
use panic_halt as _;   // panic handler: halt the core, no unwinding
use defmt_rtt as _;    // defmt transport over RTT

#[entry]
fn main() -> ! {
    defmt::info!("boot: build {}", 42u32);
    loop {
        cortex_m::asm::wfi();   // sleep until the next interrupt
    }
}`,
      },
      {
        name: 'embedded-hal 1.0 driver traits',
        code: `use embedded_hal::delay::DelayNs;
use embedded_hal::digital::OutputPin;
use embedded_hal::i2c::I2c;

// Generic over any HAL implementation: one driver, every chip.
pub fn blink<P: OutputPin, D: DelayNs>(led: &mut P, delay: &mut D) -> Result<(), P::Error> {
    led.set_high()?;
    delay.delay_ms(500);
    led.set_low()?;
    delay.delay_ms(500);
    Ok(())
}

pub fn read_temp<I: I2c>(bus: &mut I, addr: u8) -> Result<[u8; 2], I::Error> {
    let mut raw = [0u8; 2];
    bus.write_read(addr, &[0x00], &mut raw)?;
    Ok(raw)
}`,
      },
      {
        name: 'defmt structured logging',
        code: `#[derive(defmt::Format)]
pub struct Reading {
    pub channel: u8,
    pub millivolts: u32,
}

pub fn log(reading: &Reading) {
    defmt::info!("adc {} = {} mV", reading.channel, reading.millivolts);
}

// Format strings stay on the host: only a string index and the binary
// arguments travel over RTT, so logging is cheap on a 64 MHz core.`,
      },
      {
        name: 'RTIC: static priorities, no locks',
        code: `#[rtic::app(device = stm32f4xx_hal::pac, peripherals = true)]
mod app {
    use super::*;

    #[shared]
    struct Shared {
        samples: u32,
    }

    #[local]
    struct Local {}

    #[init]
    fn init(_: init::Context) -> (Shared, Local) {
        (Shared { samples: 0 }, Local {})
    }

    #[task(binds = TIM2, shared = [samples])]
    fn tick(mut cx: tick::Context) {
        cx.shared.samples.lock(|s| *s += 1);
    }
}`,
      },
      {
        name: 'Embassy: async tasks + timers',
        code: `use embassy_executor::Spawner;
use embassy_time::{Duration, Timer};

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    // Tasks are statically allocated: no heap, no dynamic dispatch.
    spawner.spawn(heartbeat()).unwrap();

    loop {
        Timer::after(Duration::from_secs(60)).await;
    }
}

#[embassy_executor::task]
async fn heartbeat() {
    loop {
        defmt::info!("alive");
        Timer::after(Duration::from_secs(5)).await;
    }
}`,
      },
    ],
  },
  {
    title: 'WASM & frontend',
    items: [
      {
        name: 'export Rust to JavaScript',
        code: `use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn slugify(input: &str) -> String {
    input.to_lowercase().replace(' ', "-")
}

#[wasm_bindgen]
pub struct Counter {
    value: i32,
}

#[wasm_bindgen]
impl Counter {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self { value: 0 }
    }

    pub fn inc(&mut self) -> i32 {
        self.value += 1;
        self.value
    }
}`,
      },
      {
        name: 'web-sys: touch the DOM',
        code: `use wasm_bindgen::prelude::*;
use web_sys::{Document, Element, Window};

#[wasm_bindgen(start)]
pub fn start() -> Result<(), JsValue> {
    let window: Window = web_sys::window()
        .ok_or_else(|| JsValue::from_str("no window"))?;
    let document: Document = window
        .document()
        .ok_or_else(|| JsValue::from_str("no document"))?;
    let root: Element = document
        .get_element_by_id("app")
        .ok_or_else(|| JsValue::from_str("missing #app"))?;

    root.set_text_content(Some("hello from Rust"));
    Ok(())
}`,
      },
      {
        name: 'Leptos component (fine-grained reactivity)',
        code: `use leptos::prelude::*;

#[component]
pub fn Counter(initial: i32) -> impl IntoView {
    let (count, set_count) = signal(initial);

    view! {
        <button on:click=move |_| set_count.update(|n| *n += 1)>
            "count: " {count}
        </button>
    }
}`,
      },
      {
        name: 'mount the app, readable panics',
        code: `use leptos::{mount::mount_to_body, prelude::*};

fn main() {
    // A Rust panic becomes a console.error with a backtrace instead of a
    // silent trap that only shows "unreachable executed".
    console_error_panic_hook::set_once();
    mount_to_body(|| view! { <Counter initial=0 /> });
}`,
      },
      {
        name: 'wasm-pack build & test',
        code: `# --target web emits an ES module plus .d.ts; no bundler required
wasm-pack build crates/web --target web --release

# --target bundler integrates with webpack/vite (npm publish layout)
wasm-pack build crates/web --target bundler --release

# run wasm-bindgen-test suites in headless Chrome
wasm-pack test --headless --chrome crates/web`,
      },
      {
        name: 'async interop: browser fetch',
        code: `use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[wasm_bindgen]
pub async fn fetch_text(url: String) -> Result<String, JsValue> {
    let window = web_sys::window()
        .ok_or_else(|| JsValue::from_str("no window"))?;
    let response: web_sys::Response = JsFuture::from(window.fetch_with_str(&url))
        .await?
        .dyn_into()?;
    let text = JsFuture::from(response.text()?).await?;
    text.as_string()
        .ok_or_else(|| JsValue::from_str("body is not a string"))
}`,
      },
    ],
  },
  {
    title: 'AI/ML inference',
    items: [
      {
        name: 'candle tensors & matmul',
        code: `use candle_core::{Device, Tensor};

let dev = Device::Cpu;
let a = Tensor::arange(0f32, 6f32, &dev)?.reshape((2, 3))?;
let b = Tensor::arange(0f32, 12f32, &dev)?.reshape((3, 4))?;
let c = a.matmul(&b)?;

println!("dims: {:?}", c.dims());
println!("values: {:?}", c.to_vec2::<f32>()?);`,
      },
      {
        name: 'tokenize text for a model',
        code: `use tokenizers::Tokenizer;

// tokenizer.json is the file Hugging Face ships next to the weights.
let tokenizer = Tokenizer::from_file("artifacts/tokenizer.json")?;
let encoding = tokenizer.encode("ship it today", true)?;

println!("ids: {:?}", encoding.get_ids());
println!("mask: {:?}", encoding.get_attention_mask());
println!("tokens: {:?}", encoding.get_tokens());`,
      },
      {
        name: 'ONNX Runtime inference (ort 2.0)',
        code: `use ort::session::Session;

let mut session = Session::builder()?
    .commit_from_file("artifacts/model.onnx")?;

let outputs = session.run(ort::inputs![
    "input_ids" => ids,
    "attention_mask" => mask,
])?;

let logits = outputs["logits"].try_extract_tensor::<f32>()?;
println!("logits shape: {:?}", logits.shape());`,
      },
      {
        name: 'Burn module definition',
        code: `use burn::nn::{Linear, LinearConfig};
use burn::prelude::*;

#[derive(Module, Debug)]
pub struct Classifier<B: Backend> {
    head: Linear<B>,
}

impl<B: Backend> Classifier<B> {
    pub fn new(device: &B::Device) -> Self {
        Self { head: LinearConfig::new(768, 10).init(device) }
    }

    pub fn forward(&self, x: Tensor<B, 2>) -> Tensor<B, 2> {
        self.head.forward(x)
    }
}`,
      },
      {
        name: 'exact vector search (cosine top-k)',
        code: `/// Brute-force top-k: exact, dependency-free, fine up to ~100k vectors.
pub fn top_k(query: &[f32], docs: &[(u64, Vec<f32>)], k: usize) -> Vec<(u64, f32)> {
    let qn = query.iter().map(|x| x * x).sum::<f32>().sqrt();

    let mut scored: Vec<(u64, f32)> = docs
        .iter()
        .map(|(id, v)| {
            let dot: f32 = query.iter().zip(v).map(|(a, b)| a * b).sum();
            let dn = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            (*id, dot / (qn * dn).max(f32::EPSILON))
        })
        .collect();

    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    scored.truncate(k);
    scored
}`,
      },
      {
        name: 'dynamic batching with a channel',
        code: `struct Job {
    input: Vec<f32>,
    reply: tokio::sync::oneshot::Sender<Vec<f32>>,
}

async fn batch_loop(
    mut rx: tokio::sync::mpsc::Receiver<Job>,
    max_batch: usize,
    mut infer: impl FnMut(&[Vec<f32>]) -> Vec<Vec<f32>>,
) {
    while let Some(first) = rx.recv().await {
        let mut batch = vec![first];

        // Drain whatever arrives inside the window, up to the batch cap.
        while batch.len() < max_batch {
            match tokio::time::timeout(std::time::Duration::from_millis(5), rx.recv()).await {
                Ok(Some(job)) => batch.push(job),
                _ => break,
            }
        }

        let inputs: Vec<Vec<f32>> = batch.iter().map(|j| j.input.clone()).collect();
        for (job, out) in batch.into_iter().zip(infer(&inputs)) {
            let _ = job.reply.send(out);
        }
    }
}`,
      },
    ],
  },
  {
    title: 'Algorithms & data structures',
    items: [
      {
        name: 'petgraph: shortest path + topo sort',
        code: `use petgraph::algo::{dijkstra, toposort};
use petgraph::graph::{DiGraph, NodeIndex};
use std::collections::HashMap;

let mut g: DiGraph<&str, u32> = DiGraph::new();
let api = g.add_node("api");
let db = g.add_node("db");
let cache = g.add_node("cache");
g.add_edge(api, db, 5);
g.add_edge(api, cache, 1);
g.add_edge(cache, db, 1);

let dist: HashMap<NodeIndex, u32> = dijkstra(&g, api, None, |e| *e.weight());
assert_eq!(dist[&db], 2);

let order = toposort(&g, None)?;   // Err(Cycle) if the graph is not a DAG
assert_eq!(order.len(), 3);`,
      },
      {
        name: 'BinaryHeap as a priority queue',
        code: `use std::cmp::Ordering;
use std::collections::BinaryHeap;

#[derive(Eq, PartialEq)]
struct Job {
    priority: u8,
    id: u64,
}

impl Ord for Job {
    fn cmp(&self, other: &Self) -> Ordering {
        self.priority
            .cmp(&other.priority)
            .then_with(|| other.id.cmp(&self.id))
    }
}

impl PartialOrd for Job {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

let mut heap = BinaryHeap::new();
heap.push(Job { priority: 1, id: 7 });
heap.push(Job { priority: 9, id: 8 });
assert_eq!(heap.pop().unwrap().id, 8);   // max-heap: highest priority first`,
      },
      {
        name: 'smallvec: stack storage for small sets',
        code: `use smallvec::{smallvec, SmallVec};

// Up to four elements live inline in the struct: no allocation.
let mut ids: SmallVec<[u64; 4]> = smallvec![1, 2, 3];
assert!(!ids.spilled());

ids.push(4);
assert!(!ids.spilled());

ids.push(5);      // first allocation happens here
assert!(ids.spilled());`,
      },
      {
        name: 'hashbrown entry map',
        code: `use hashbrown::HashMap;

// hashbrown is the implementation behind std's HashMap, with a fast default
// hasher and extra APIs that std keeps unstable.
let mut counts: HashMap<String, u32> = HashMap::with_capacity(1024);
for token in tokens {
    *counts.entry(token).or_insert(0) += 1;
}

let mut order: Vec<(String, u32)> = counts.into_iter().collect();
order.sort_unstable_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));`,
      },
      {
        name: 'roaring bitmaps for set algebra',
        code: `use roaring::RoaringBitmap;

let mut active = RoaringBitmap::new();
active.insert(1);
active.insert(42);
active.insert_range(100..200);

let mut paid = RoaringBitmap::new();
paid.insert_range(150..250);

let both = &active & &paid;   // intersection, compressed
assert!(both.contains(175));
assert!(!both.contains(120));
assert_eq!(active.len(), 102);`,
      },
      {
        name: 'sort, dedupe, binary search',
        code: `// Sort once, then every lookup is O(log n) instead of O(n).
let mut ids: Vec<u64> = rows.iter().map(|r| r.id).collect();
ids.sort_unstable();
ids.dedup();                       // O(n) after the sort

match ids.binary_search(&target) {
    Ok(idx) => println!("found at {idx}"),
    Err(idx) => println!("would insert at {idx}"),
}`,
      },
    ],
  },
  {
    title: 'Data engineering',
    items: [
      {
        name: 'build an Arrow RecordBatch',
        code: `use std::sync::Arc;
use arrow::array::{Float64Array, RecordBatch, StringArray};

let tenant: Arc<dyn arrow::array::Array> =
    Arc::new(StringArray::from(vec!["acme", "acme", "globex"]));
let amount: Arc<dyn arrow::array::Array> =
    Arc::new(Float64Array::from(vec![10.0, 2.5, 99.0]));

let batch = RecordBatch::try_from_iter([("tenant", tenant), ("amount", amount)])?;
assert_eq!(batch.num_columns(), 2);
assert_eq!(batch.num_rows(), 3);`,
      },
      {
        name: 'write and read Parquet',
        code: `use std::fs::File;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use parquet::arrow::ArrowWriter;

// Write: columnar + compressed; close() flushes the footer.
let mut writer = ArrowWriter::try_new(File::create("events.parquet")?, batch.schema(), None)?;
writer.write(&batch)?;
writer.close()?;

// Read: batch-sized streaming, never load the whole file.
let reader = ParquetRecordBatchReaderBuilder::try_new(File::open("events.parquet")?)?
    .with_batch_size(8192)
    .build()?;
for batch in reader {
    println!("rows: {}", batch?.num_rows());
}`,
      },
      {
        name: 'polars lazy aggregation',
        code: `use polars::prelude::*;

// Polars is synchronous: call it inside spawn_blocking from async code.
let report = LazyFrame::scan_parquet("lake/events/*.parquet", Default::default())?
    .filter(col("event").eq(lit("order_paid")))
    .group_by([col("tenant")])
    .agg([
        col("amount_cents").sum().alias("gross_cents"),
        col("amount_cents").mean().alias("avg_cents"),
        len().alias("orders"),
    ])
    .collect()?;

println!("{:?}", report.head(Some(5)));`,
      },
      {
        name: 'atomic lake writes through object_store',
        code: `use bytes::Bytes;
use object_store::aws::AmazonS3Builder;
use object_store::{path::Path, ObjectStore, PutPayload};

let store = AmazonS3Builder::from_env()
    .with_bucket_name("analytics-lake")
    .build()?;

let staging = Path::from("staging/run=42/part-0.parquet");
store
    .put(&staging, PutPayload::from(Bytes::from(bytes)))
    .await?;

// Promote only after the upload succeeded: readers never see partial data.
let final_path = Path::from("events/date=2026-11-04/part-0.parquet");
store.copy(&staging, &final_path).await?;
store.delete(&staging).await?;`,
      },
      {
        name: 'dedupe CDC rows before compaction',
        code: `use std::collections::HashMap;

// Merge a change stream into the latest row per key, keeping the highest LSN.
let mut latest: HashMap<String, Change> = HashMap::new();
for change in changes {
    latest
        .entry(change.key.clone())
        .and_modify(|prev| {
            if change.lsn > prev.lsn {
                *prev = change.clone();
            }
        })
        .or_insert(change);
}

let mut rows: Vec<Change> = latest.into_values().collect();
rows.sort_unstable_by(|a, b| a.key.cmp(&b.key));   // deterministic file layout`,
      },
      {
        name: 'column pruning on read',
        code: `use std::fs::File;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use parquet::arrow::ProjectionMask;

// Decode only the columns the query needs: fewer bytes, less CPU.
let builder = ParquetRecordBatchReaderBuilder::try_new(File::open("events.parquet")?)?;
let mask = ProjectionMask::leaves(builder.parquet_schema(), [0, 3]);
let reader = builder
    .with_projection(mask)
    .with_batch_size(4096)
    .build()?;`,
      },
    ],
  },
  {
    title: 'Security engineering',
    items: [
      {
        name: 'verify a password, upgrade old hashes',
        code: `use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, SaltString};
use argon2::{Argon2, PasswordVerifier};

let parsed = PasswordHash::new(&stored_hash)?;
let ok = Argon2::default()
    .verify_password(attempt.as_bytes(), &parsed)
    .is_ok();

// Migrate old parameters on successful login instead of forcing a reset.
if ok && parsed.algorithm.as_str() != "argon2id" {
    let salt = SaltString::generate(&mut OsRng);
    let new_hash = Argon2::default()
        .hash_password(attempt.as_bytes(), &salt)?
        .to_string();
    store_hash(&new_hash).await?;
}`,
      },
      {
        name: 'OIDC token validation with JWKS',
        code: `use jsonwebtoken::{decode, decode_header, jwk::JwkSet, DecodingKey, Validation};

// 1. Fetch the issuer's keys once and cache them (refresh on unknown kid).
let jwks: JwkSet = reqwest::get(format!("{issuer}/.well-known/jwks.json"))
    .await?
    .json()
    .await?;

// 2. Pick the key the token was signed with.
let header = decode_header(token)?;
let jwk = jwks
    .find(&header.kid.unwrap_or_default())
    .ok_or("unknown signing key")?;
let key = DecodingKey::from_jwk(jwk)?;

// 3. Check signature AND issuer/audience/expiry, not just the signature.
let mut validation = Validation::new(header.alg);
validation.set_issuer(&[issuer]);
validation.set_audience(&[audience]);
let claims = decode::<Claims>(token, &key, &validation)?;`,
      },
      {
        name: 'rustls server config from PEM',
        code: `use std::sync::Arc;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::ServerConfig;

let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut cert_reader)
    .collect::<Result<Vec<_>, _>>()?;
let key: PrivateKeyDer<'static> = rustls_pemfile::private_key(&mut key_reader)?
    .ok_or("no private key")?;

// TLS 1.2 + 1.3 by default; pin 1.3-only by editing the protocol versions.
// With more than one crypto provider compiled in, install a default first:
// rustls::crypto::ring::default_provider().install_default().unwrap();
let config = ServerConfig::builder()
    .with_no_client_auth()
    .with_single_cert(certs, key)?;

let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));`,
      },
      {
        name: 'ring HMAC for webhook signatures',
        code: `use ring::hmac;

// Verify a webhook signature over the exact raw body bytes.
fn verify_webhook(secret: &[u8], body: &[u8], signature: &[u8]) -> Result<(), AppError> {
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret);
    hmac::verify(&key, body, signature).map_err(|_| AppError::Unauthorized)
}

// Producing a signature for outgoing calls:
let tag = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, secret), body);
let header = hex::encode(tag.as_ref());`,
      },
      {
        name: 'security headers with tower-http',
        code: `use axum::http::{header, HeaderValue};
use tower::ServiceBuilder;
use tower_http::set_header::SetResponseHeaderLayer;

let app = Router::new().merge(routes).layer(
    ServiceBuilder::new()
        .layer(SetResponseHeaderLayer::overriding(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=63072000; includeSubDomains; preload"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        )),
);`,
      },
      {
        name: 'zeroize secrets',
        code: `use zeroize::{Zeroize, Zeroizing};

// Wiped on drop; Debug output is redacted by the wrapper.
let api_key: Zeroizing<String> = Zeroizing::new(std::env::var("PAYMENTS_API_KEY")?);

#[derive(Debug)]
struct SessionKey(String);

impl Drop for SessionKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}`,
      },
    ],
  },

];

export const BLUEPRINTS = [
  {
    id: 'tenant-saas-api',
    title: 'Multi-tenant SaaS API',
    level: 'industry',
    summary:
      'One axum service serves many tenants. A JWT access token carries the tenant claim, every query filters by tenant_id, Redis caches per-tenant lookups, and a bounded Postgres pool is the backpressure valve. The blueprint shows exactly where tenancy must be enforced so one customer can never read another customer\'s rows.',
    stack: ['axum', 'tower-http', 'sqlx', 'redis', 'jsonwebtoken', 'tokio'],
    flow: [
      '1. The edge terminates TLS and forwards the Authorization header; tower-http traces the request and applies a request timeout.',
      '2. An extractor verifies the JWT, rejects expired or wrong-audience tokens, and places tenant_id and user_id into request extensions.',
      '3. Handlers get the PgPool and a tenant-scoped repository; every SQL statement binds tenant_id from the token, never from the body or path.',
      '4. Reads check Redis under a tenant-prefixed key; writes invalidate that key only after the transaction commits.',
      '5. The pool (max_connections + acquire_timeout) limits concurrency; a fast 503 is better than an unbounded queue when the database is saturated.',
      '6. /healthz reports process liveness; /readyz checks Postgres and Redis before the pod is added to the load balancer.',
    ],
    components: [
      { name: 'API edge', role: 'routing, extractors, middleware, graceful shutdown', crates: ['axum', 'tower-http', 'tokio'] },
      { name: 'Auth', role: 'password hashing, JWT issue and verification, tenant claims', crates: ['argon2', 'jsonwebtoken'] },
      { name: 'Persistence', role: 'tenant-scoped repositories, transactions, migrations', crates: ['sqlx'] },
      { name: 'Cache', role: 'per-tenant read cache with explicit TTLs', crates: ['redis'] },
    ],
    checklist: [
      'tenant_id comes from the verified token claim, never from a path parameter or request body alone.',
      'Every tenant-owned table has tenant_id in its primary lookup index, and repository tests cover cross-tenant access.',
      'JWT keys rotate, access tokens are short-lived (minutes), and refresh tokens can be revoked.',
      'Pool size, acquire_timeout, statement timeouts and per-tenant rate limits are configured and load-tested.',
      'Integration tests hit the router as two tenants and assert that cross-tenant reads return 404 with no data.',
    ],
    lessons: ['w01', 'w02', 'w05', 'd01', 'd04'],
    resources: [
      { title: 'axum crate documentation', url: 'https://docs.rs/axum/latest/axum/', kind: 'docs' },
      { title: 'SQLx 0.8 documentation', url: 'https://docs.rs/sqlx/0.8/sqlx/', kind: 'docs' },
      { title: 'redis-rs crate documentation', url: 'https://docs.rs/redis/latest/redis/', kind: 'docs' },
    ],
  },
  {
    id: 'event-driven-orders',
    title: 'Event-driven order service (Kafka + outbox)',
    level: 'industry',
    summary:
      'Orders are committed to Postgres together with an outbox row in a single transaction. A relay publishes outbox rows to Kafka with an idempotent, keyed producer. Consumers commit offsets only after their side effect and dedupe by event id, so retries and rebalances never double-charge a customer.',
    stack: ['axum', 'sqlx', 'rdkafka', 'tokio', 'serde', 'uuid'],
    flow: [
      '1. The API writes the order and an outbox row in one Postgres transaction; the HTTP response never waits for the broker.',
      '2. A relay task claims pending outbox rows with SELECT ... FOR UPDATE SKIP LOCKED and publishes them with an idempotent producer.',
      '3. Records are keyed by order_id, so all events for one order land on the same partition and stay ordered.',
      '4. On broker ack the outbox row is marked sent; a crashed relay simply republishes, so consumers dedupe by event id.',
      '5. Consumers run with enable.auto.commit=false, apply the side effect, record the event id in a dedupe table, then commit the offset.',
      '6. A handler that keeps failing is published to a DLQ topic with an error header and its offset is committed, so the partition keeps moving.',
    ],
    components: [
      { name: 'Outbox relay', role: 'claims and publishes pending rows, marks them sent', crates: ['sqlx', 'rdkafka', 'tokio'] },
      { name: 'Consumers', role: 'at-least-once processing with dedupe and manual commits', crates: ['rdkafka', 'tokio', 'serde'] },
      { name: 'Dedupe store', role: 'unique (consumer, event_id) rows that make replays safe', crates: ['sqlx'] },
      { name: 'DLQ', role: 'terminal failures parked for inspection and replay', crates: ['rdkafka'] },
    ],
    checklist: [
      'The outbox row and the business write share one transaction; the relay is the only Kafka producer on the write path.',
      'Consumers are provably idempotent: replay the same event twice in a test and assert a single side effect.',
      'enable.idempotence=true, acks=all and a bounded message.timeout.ms are set on every producer.',
      'Consumer lag, relay backlog and DLQ depth are metrics with alerts; nothing fails silently.',
      'Offsets are committed only after the side effect, and shutdown/rebalance flushes in-flight work first.',
    ],
    lessons: ['s03', 's05', 's07', 'd07', 'p02'],
    resources: [
      { title: 'rdkafka (rust-rdkafka) documentation', url: 'https://docs.rs/rdkafka/latest/rdkafka/', kind: 'docs' },
      { title: 'Apache Kafka introduction and concepts', url: 'https://kafka.apache.org/intro/', kind: 'docs' },
    ],
  },
  {
    id: 'realtime-gateway',
    title: 'Realtime gateway (WebSockets + broadcast)',
    level: 'industry',
    summary:
      'A dedicated WebSocket tier holds long-lived connections and fans out live updates. In-process fan-out uses a tokio broadcast channel with an explicit lag policy; cross-replica fan-out goes through Redis pub/sub. Slow clients are dropped, not buffered forever, and shutdown closes sockets cleanly.',
    stack: ['axum', 'tokio', 'tokio-util', 'redis', 'jsonwebtoken', 'serde_json'],
    flow: [
      '1. A client upgrades GET /ws with a JWT; axum WebSocketUpgrade hands the socket to a dedicated connection task.',
      '2. The task subscribes to a tokio::sync::broadcast channel for its tenant; a receiver that falls behind gets RecvError::Lagged and is disconnected.',
      '3. Each replica keeps a local broadcast sender per channel, so in-process publishers fan out without any network hop.',
      '4. A Redis subscription bridges cross-replica messages into the local broadcast; keys are namespaced by tenant and channel.',
      '5. Heartbeats and a per-connection write timeout evict dead sockets; a CancellationToken closes every socket on shutdown.',
      '6. Presence and typing events stay best-effort; durable state lives in Postgres, not in the socket tier.',
    ],
    components: [
      { name: 'Gateway', role: 'upgrade, auth, per-connection task, heartbeats', crates: ['axum', 'tokio', 'tokio-util'] },
      { name: 'Fan-out', role: 'local broadcast per tenant channel with bounded buffers', crates: ['tokio'] },
      { name: 'Backplane', role: 'cross-replica pub/sub bridge', crates: ['redis'] },
      { name: 'Auth', role: 'token validation before upgrade and expiry enforcement', crates: ['jsonwebtoken'] },
    ],
    checklist: [
      'Every channel is bounded and Lagged is handled explicitly; an unbounded queue is a memory leak with a schedule.',
      'Concurrent connections per pod are capped and the proxy sheds load before the process runs out of memory.',
      'Auth happens before the upgrade, and connections are closed when the token reaches expiry.',
      'Shutdown cancels the token, sends close frames, and drains connections inside the grace period.',
      'A load test with deliberately slow consumers keeps the process under its memory limit.',
    ],
    lessons: ['w06', 'w05', 'd04', 'p02', 'l18'],
    resources: [
      { title: 'axum WebSocket module', url: 'https://docs.rs/axum/latest/axum/extract/ws/', kind: 'docs' },
      { title: 'tokio::sync::broadcast (lag semantics)', url: 'https://docs.rs/tokio/latest/tokio/sync/broadcast/index.html', kind: 'docs' },
      { title: 'redis-rs pub/sub and RESP3', url: 'https://docs.rs/redis/latest/redis/', kind: 'docs' },
    ],
  },
  {
    id: 'grpc-service-mesh',
    title: 'gRPC service mesh (tonic + health + deadlines)',
    level: 'industry',
    summary:
      'Internal services talk gRPC over HTTP/2 with tonic. Protos are compiled in build.rs, every server exposes the standard health service, every call carries a deadline, metadata propagates auth and trace context, and Kubernetes probes drive rollout decisions from real readiness.',
    stack: ['tonic', 'tonic-health', 'prost', 'tokio', 'tracing', 'tower'],
    flow: [
      '1. Protos live in a shared location and tonic-prost-build generates client and server stubs in build.rs for each service.',
      '2. Each service registers grpc.health.v1 and reports NOT_SERVING before it stops accepting work during shutdown.',
      '3. Clients dial with connect_timeout and set a per-call timeout, so the deadline travels with the request into downstream calls.',
      '4. Interceptors attach auth metadata and the current trace context; servers map domain errors onto tonic Status codes.',
      '5. Retries are limited to idempotent methods with a bounded policy; a deadline-exceeded storm is not retried blindly.',
      '6. Kubernetes probes call the health service and rolling updates rely on serve_with_shutdown for a clean drain.',
    ],
    components: [
      { name: 'Codegen', role: 'proto compilation in build.rs for clients and servers', crates: ['tonic-prost-build', 'prost'] },
      { name: 'Servers', role: 'service impls, health reporting, graceful stop', crates: ['tonic', 'tonic-health', 'tokio'] },
      { name: 'Clients', role: 'channels, deadlines, metadata interceptors', crates: ['tonic', 'tower'] },
      { name: 'Telemetry', role: 'spans per RPC, propagation to the collector', crates: ['tracing', 'tracing-opentelemetry', 'opentelemetry-otlp'] },
    ],
    checklist: [
      'Every RPC has a deadline and a max message size; oversized requests fail with RESOURCE_EXHAUSTED.',
      'Domain errors map to the right Status code (NOT_FOUND, INVALID_ARGUMENT, UNAVAILABLE) and never leak internal strings.',
      'Health reflects real readiness (pool, downstreams), not merely that the process is running.',
      'Trace context and request metadata propagate through every hop, with a configured sampling rate per environment.',
      'Graceful shutdown flips health first, waits for in-flight RPCs, then stops the server.',
    ],
    lessons: ['s02', 's01', 'g01', 'l12'],
    resources: [
      { title: 'tonic crate documentation', url: 'https://docs.rs/tonic/latest/tonic/', kind: 'docs' },
      { title: 'gRPC health checking guide', url: 'https://grpc.io/docs/guides/health-checking/', kind: 'docs' },
    ],
  },
  {
    id: 'batch-etl-worker',
    title: 'Batch ETL worker (bounded pool + object storage)',
    level: 'industry',
    summary:
      'A one-shot worker takes a job id, lists input objects from object storage, and streams them through a bounded pool of transforms with CPU work on the blocking pool. Subprocesses are killed on drop and on timeout. Outputs appear at their final keys only after success, and a rerun is safe.',
    stack: ['tokio', 'aws-sdk-s3', 'serde_json', 'clap', 'tokio-util'],
    flow: [
      '1. A scheduler or queue message hands the worker a job id; the binary is a one-shot process with a hard deadline and an idempotent job key.',
      '2. The job lists input objects and feeds keys into a bounded channel; the worker-pool size is the concurrency limit.',
      '3. Workers stream each object instead of buffering it, and move CPU-heavy transforms to spawn_blocking.',
      '4. External tools run as subprocesses with kill_on_drop and a timeout, with stderr captured into the failure record.',
      '5. Outputs are written to a temporary key and only moved to the final key after success, so partial files are never visible.',
      '6. The job records per-item outcomes, retries only failed items, and emits a summary metric plus a report artifact.',
    ],
    components: [
      { name: 'Orchestrator', role: 'job parsing, deadline, bounded dispatch, progress', crates: ['tokio', 'clap'] },
      { name: 'Storage', role: 'streamed reads/writes, temp key + atomic move', crates: ['aws-sdk-s3'] },
      { name: 'Transform', role: 'pure transforms, subprocess adapters', crates: ['tokio', 'serde_json'] },
      { name: 'Checkpoint', role: 'per-item status so reruns skip completed work', crates: ['sqlx'] },
    ],
    checklist: [
      'The job is idempotent and resumable: a rerun produces identical outputs and skips completed items.',
      'Memory is bounded by streaming and channel capacity, not by dataset size; verify against a large fixture.',
      'Subprocesses cannot outlive the worker, and non-zero exit codes fail the item with captured stderr.',
      'Partial output is never published: temp key plus atomic move, or a completion manifest.',
      'Poison items go to a dead-letter path with a reason instead of failing the whole batch.',
    ],
    lessons: ['p01', 'p03', 'd06', 'p07'],
    resources: [
      { title: 'tokio asynchronous runtime documentation', url: 'https://docs.rs/tokio/latest/tokio/', kind: 'docs' },
      { title: 'AWS SDK for Rust: S3 client', url: 'https://docs.rs/aws-sdk-s3/latest/aws_sdk_s3/', kind: 'docs' },
    ],
  },
  {
    id: 'job-scheduler-supervisor',
    title: 'Job scheduler & supervisor (leader election)',
    level: 'industry',
    summary:
      'Cron-style jobs run under a supervisor with one owner. Replicas contend for a fenced lease, only the leader triggers runs, and each run is recorded by (job, scheduled_at) so a duplicate tick cannot double-send. Shutdown stops new claims, cancels in-flight jobs at checkpoints, releases the lease, and exits.',
    stack: ['tokio', 'tokio-util', 'sqlx', 'kube', 'serde'],
    flow: [
      '1. Every replica runs the scheduler loop, but only the replica holding a current lease triggers jobs; followers stand by and renew.',
      '2. Leader election uses a Kubernetes Lease or a Postgres advisory lock with a TTL, and the fence token is passed to every job.',
      '3. A supervisor owns one CancellationToken per job and restarts failed runs with capped exponential backoff while recording state.',
      '4. Runs are recorded under a unique (job, scheduled_at) key, so a missed or duplicated trigger cannot double-charge or double-send.',
      '5. On SIGTERM the leader stops claiming new runs, cancels in-flight jobs at safe checkpoints, releases the lease, and exits.',
      '6. Missed schedules after downtime are either explicitly caught up or skipped; the policy is part of the job spec, not an accident.',
    ],
    components: [
      { name: 'Scheduler', role: 'cron ticks, lease check, run dispatch', crates: ['tokio', 'tokio-cron-scheduler'] },
      { name: 'Election', role: 'fenced leadership with TTL and fast release', crates: ['kube', 'sqlx'] },
      { name: 'Supervisor', role: 'per-job cancellation, backoff, restart policy', crates: ['tokio', 'tokio-util'] },
      { name: 'Run store', role: 'durable run history keyed by job + scheduled time', crates: ['sqlx'] },
    ],
    checklist: [
      'Only one replica executes a given scheduled run: the lease or lock is verified before any side effect.',
      'Every job has a timeout, cancellation points, and a max-concurrent-runs rule; one hung job cannot block the tick.',
      'Run history is durable with (job, scheduled_at) uniqueness, retry counts and last error visible on a dashboard.',
      'Leader loss and graceful shutdown both stop new claims before in-flight work is cancelled, and release the lease quickly.',
      'Time assumptions are documented: UTC everywhere, DST-safe cron evaluation, explicit missed-run policy.',
    ],
    lessons: ['p05', 'p04', 'p02', 's08'],
    resources: [
      { title: 'Tokio graceful shutdown guide', url: 'https://tokio.rs/tokio/topics/shutdown', kind: 'docs' },
      { title: 'tokio_util CancellationToken', url: 'https://docs.rs/tokio-util/latest/tokio_util/sync/struct.CancellationToken.html', kind: 'docs' },
    ],
  },
  {
    id: 'observability-platform',
    title: 'Observability wiring (tracing + OTLP + metrics)',
    level: 'industry',
    summary:
      'Instrument every service once: one tracing subscriber with a JSON log layer and an OpenTelemetry trace layer, OTLP export to a collector, semantic-convention span names, RED/USE metrics, and SLO-based alerts that page on user-visible symptoms instead of CPU spikes.',
    stack: ['tracing', 'tracing-subscriber', 'tracing-opentelemetry', 'opentelemetry-otlp', 'axum', 'tokio'],
    flow: [
      '1. Initialize one tracing subscriber with an EnvFilter, a JSON fmt layer for logs, and an OpenTelemetry layer for traces.',
      '2. Export traces and metrics over OTLP to the collector; the app knows only the endpoint and its resource attributes.',
      '3. Span names follow semantic conventions (HTTP route, RPC method, DB statement), so dashboards work across services.',
      '4. Metrics cover RED (rate, errors, duration) and USE (utilisation, saturation, errors) plus pool and queue depth.',
      '5. Dashboards and alerts are provisioned as code and tied to SLOs, not hand-built per environment.',
      '6. Shutdown flushes the batch span and metric processors before exit so the last seconds of telemetry are not lost.',
    ],
    components: [
      { name: 'Instrumentation', role: 'spans, events, request metrics in the service', crates: ['tracing', 'tracing-subscriber', 'tower-http'] },
      { name: 'Trace export', role: 'OTLP gRPC/HTTP span pipeline to the collector', crates: ['opentelemetry-otlp', 'tracing-opentelemetry'] },
      { name: 'Metric export', role: 'periodic OTLP metric reader, resource attributes', crates: ['opentelemetry-otlp', 'opentelemetry'] },
      { name: 'Service framing', role: 'routes, extractors, health endpoints for scrapes', crates: ['axum', 'tower-http'] },
    ],
    checklist: [
      'Trace, metric and log correlation works: the trace id appears in logs and the dashboard links to the trace.',
      'Cardinality is controlled: no user ids, raw paths or other unbounded values in metric attributes.',
      'OTLP export failures never block the request path; batching, retries and bounded queues are configured.',
      'Sampling is deliberate (head or tail), and error requests are always sampled.',
      'Alerts page on SLO burn and user-visible symptoms, not on a single 5xx or a CPU threshold.',
    ],
    lessons: ['g01', 'w04', 'g08'],
    resources: [
      { title: 'opentelemetry-otlp exporter documentation', url: 'https://docs.rs/opentelemetry-otlp/latest/opentelemetry_otlp/', kind: 'docs' },
      { title: 'tracing-opentelemetry layer documentation', url: 'https://docs.rs/tracing-opentelemetry/latest/tracing_opentelemetry/', kind: 'docs' },
    ],
  },
  {
    id: 'zero-downtime-deploy',
    title: 'Zero-downtime deployment (Docker + Kubernetes)',
    level: 'industry',
    summary:
      'Ship a static binary in a small image, roll it out with Kubernetes probes that tell the truth, and drain connections on SIGTERM. With maxUnavailable=0, honest readiness and backward-compatible migrations, a deploy drops zero requests and rollback is one tag away.',
    stack: ['axum', 'tokio', 'tower-http', 'serde', 'sqlx'],
    flow: [
      '1. CI builds the binary in a multi-stage Docker image, tags it immutably with the commit sha, and scans it before pushing.',
      '2. Kubernetes rolls the Deployment with maxSurge=1 and maxUnavailable=0; new pods must pass startup and readiness before traffic arrives.',
      '3. Readiness reports whether the pool, migrations and caches are usable; liveness is a cheap check that only catches a wedged process.',
      '4. On SIGTERM the app reports not-ready, stops accepting new requests, drains in-flight work, flushes telemetry, and exits 0.',
      '5. A generous terminationGracePeriodSeconds plus a preStop sleep covers the time endpoints take to converge across the cluster.',
      '6. Rollback is redeploying the previous immutable tag; schema changes use expand/contract so both versions can run during the rollout.',
    ],
    components: [
      { name: 'HTTP surface', role: 'routes, extractors, /healthz and /readyz endpoints', crates: ['axum', 'tower-http'] },
      { name: 'Shutdown', role: 'SIGTERM handling, cancellation, drain, telemetry flush', crates: ['tokio', 'tokio-util'] },
      { name: 'Dependencies', role: 'pool readiness, migrations, dependency health checks', crates: ['sqlx', 'redis'] },
      { name: 'Release', role: 'immutable tags, expand/contract migrations, rollback drill', crates: ['sqlx'] },
    ],
    checklist: [
      'Probes are distinct and honest: startup for slow boots, readiness for traffic, liveness only for wedged processes.',
      'A load test during a rolling update shows zero 5xx responses and no connection resets.',
      'Migrations run as a separate job and are backward compatible; new code starts against the old schema.',
      'terminationGracePeriodSeconds exceeds the longest in-flight request plus drain time, and preStop covers endpoint lag.',
      'The previous image tag is still deployable, and the rollback command is documented and rehearsed.',
    ],
    lessons: ['g05', 'g06', 'g07', 'p04'],
    resources: [
      { title: 'Kubernetes liveness, readiness and startup probes', url: 'https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/', kind: 'docs' },
      { title: 'Docker build best practices', url: 'https://docs.docker.com/build/building/best-practices/', kind: 'docs' },
      { title: 'Tokio graceful shutdown guide', url: 'https://tokio.rs/tokio/topics/shutdown', kind: 'docs' },
    ],
  },
  {
    id: 'wasm-edge-dashboard',
    title: 'WASM edge dashboard (Leptos + SSR)',
    level: 'industry',
    summary:
      'A Leptos dashboard that ships as WebAssembly but still paints on the first request: axum serves the rendered shell with embedded initial data, and only interactive islands hydrate in the browser. wasm-bindgen provides typed JS boundaries, web-sys covers browser APIs, and CI holds a hard size budget for the wasm entry chunk.',
    stack: ['leptos', 'wasm-bindgen', 'web-sys', 'axum', 'serde'],
    flow: [
      '1. axum serves the shell HTML with the initial data embedded as JSON, so the first paint needs no WebAssembly at all.',
      '2. Leptos hydrates the shell in the browser; only interactive islands load their wasm chunks, so static pages stay cheap.',
      '3. wasm-bindgen exports typed functions and structs, and its generated .d.ts gives TypeScript callers real signatures.',
      '4. web-sys covers the browser edge: fetch, WebSocket, localStorage and canvas, each behind a typed wrapper.',
      '5. wasm-pack builds for the chosen target (web or bundler), wasm-opt shrinks the result, and assets are content-hashed and served immutable.',
      '6. Errors and panics are captured by the panic hook and reported to the error endpoint with the release id, not just printed to the console.',
    ],
    components: [
      { name: 'UI', role: 'components, signals, routing, hydration', crates: ['leptos', 'leptos_router'] },
      { name: 'JS boundary', role: 'typed exports, DOM and browser APIs', crates: ['wasm-bindgen', 'web-sys'] },
      { name: 'Server', role: 'shell HTML, JSON API, static asset serving', crates: ['axum', 'serde'] },
      { name: 'Build', role: 'target selection, size optimisation, hashed assets', crates: ['wasm-pack', 'wasm-bindgen'] },
    ],
    checklist: [
      'The initial HTML renders without wasm, and a hydration failure degrades to a working page instead of a blank screen.',
      'The wasm entry chunk is size-budgeted in CI and the budget is enforced on every PR, not just reviewed by eye.',
      'All JS interop is typed: raw JsValue values never leak into component or business logic.',
      'Panics are captured by console_error_panic_hook and shipped to the error endpoint with the release id.',
      'Assets are content-hashed and cached immutably, while the shell HTML is always revalidated.',
    ],
    lessons: ['v01', 'v02', 'v03', 'v05'],
    resources: [
      { title: 'wasm-bindgen crate documentation', url: 'https://docs.rs/wasm-bindgen/latest/wasm_bindgen/', kind: 'docs' },
      { title: 'Leptos crate documentation', url: 'https://docs.rs/leptos/latest/leptos/', kind: 'docs' },
    ],
  },
  {
    id: 'ml-inference-service',
    title: 'ML inference service (batching + vector search)',
    level: 'industry',
    summary:
      'A model-serving service behind axum: tokenize, coalesce requests into short batches, run one forward pass, and return embeddings or logits. Models load once at startup and warm up before readiness. Embeddings are normalized and searched with exact cosine top-k until recall and latency numbers justify an approximate index.',
    stack: ['axum', 'candle-core', 'ort', 'tokenizers', 'tokio', 'serde'],
    flow: [
      '1. Startup loads the tokenizer and the model once, runs a dummy batch to warm up, and only then reports ready.',
      '2. Requests arrive on axum and are pushed as (input, oneshot) jobs into a bounded channel; each handler awaits its reply.',
      '3. A batcher task drains up to N jobs or waits a few milliseconds, then runs a single forward pass for the whole batch.',
      '4. The tokenizer enforces truncation and a max sequence length before inference, bounding compute per request.',
      '5. Embeddings are normalized and written to the index; queries compute cosine top-k over the searched partition.',
      '6. Backpressure is explicit: a full queue returns 429 with Retry-After, and per-request deadlines cancel work that no longer matters.',
    ],
    components: [
      { name: 'API', role: 'validation, deadlines, backpressure, streaming responses', crates: ['axum', 'serde', 'tokio'] },
      { name: 'Tokenizer', role: 'truncation, padding, special tokens', crates: ['tokenizers'] },
      { name: 'Runtime', role: 'model loading, batched forward passes', crates: ['candle-core', 'ort'] },
      { name: 'Index', role: 'normalized embeddings, cosine top-k, rebuild path', crates: ['candle-core'] },
    ],
    checklist: [
      'Model and tokenizer are versioned artifacts, and every response and span reports the model hash.',
      'Batching is bounded by both max batch size and max wait, and queue depth is a metric with an alert.',
      'Latency is measured per stage (tokenize, queue, infer, search) with per-endpoint p99 budgets.',
      'Inputs are length-capped and validated so one request cannot exhaust memory or the accelerator queue.',
      'The index has a rebuild path and a recall/latency benchmark before exact search is replaced by approximate search.',
    ],
    lessons: ['o01', 'o04', 'o05'],
    resources: [
      { title: 'candle-core crate documentation', url: 'https://docs.rs/candle-core/latest/candle_core/', kind: 'docs' },
      { title: 'ort (ONNX Runtime) crate documentation', url: 'https://docs.rs/ort/latest/ort/', kind: 'docs' },
      { title: 'Hugging Face tokenizers crate documentation', url: 'https://docs.rs/tokenizers/latest/tokenizers/', kind: 'docs' },
    ],
  },
  {
    id: 'embedded-telemetry-gateway',
    title: 'Embedded telemetry gateway (firmware to cloud)',
    level: 'industry',
    summary:
      'Firmware samples sensors under a real-time executive and sends framed telemetry to a gateway, which validates, dedupes and batches frames before publishing them to the cloud. Rust shares the frame crate between both sides, so the encoder on the device and the decoder in the gateway are the same code under a conformance corpus.',
    stack: ['embedded-hal', 'embassy-executor', 'rtic', 'defmt', 'tokio', 'async-nats'],
    flow: [
      '1. Firmware samples through embedded-hal traits on an interrupt-driven executive (RTIC or Embassy) and timestamps every frame.',
      '2. Frames carry a compact header (device id, sequence, CRC) and are queued in static buffers; the hot path allocates nothing.',
      '3. The radio or serial link transports length-prefixed frames with a CRC; the gateway re-syncs on corruption instead of dropping the stream.',
      '4. The gateway decodes with the same frame crate the firmware uses, validates ranges, and dedupes by (device id, sequence).',
      '5. Valid frames are batched for a short window, then published to NATS or Kafka, or written to object storage; acks flow back to the device.',
      '6. Fleet operations: signed OTA updates with A/B rollback, defmt over RTT in the lab, and device health exported as metrics.',
    ],
    components: [
      { name: 'Firmware', role: 'sensor sampling, timers, radio driver', crates: ['embedded-hal', 'embassy-executor', 'rtic'] },
      { name: 'Wire format', role: 'compact frames, CRC, versioning, shared codec', crates: ['serde'] },
      { name: 'Gateway', role: 'framing, validation, dedupe, batching', crates: ['tokio'] },
      { name: 'Cloud sink', role: 'durable publish, backpressure, device acks', crates: ['async-nats'] },
    ],
    checklist: [
      'The hot path allocates nothing, and queue sizes are static so stack and RAM bounds are provable.',
      'Every frame carries a sequence number and CRC; the gateway dedupes and reports gaps instead of silently dropping data.',
      'OTA images and configuration are signed and verified before activation, with an A/B slot and a tested rollback.',
      'Firmware and gateway share the frame crate plus a conformance corpus, so both sides decode identically.',
      'Watchdog and brown-out behaviour are defined: the device reboots into a safe state and never blocks an interrupt.',
    ],
    lessons: ['x01', 'x02', 'x03', 'x04'],
    resources: [
      { title: 'embedded-hal 1.0 crate documentation', url: 'https://docs.rs/embedded-hal/latest/embedded_hal/', kind: 'docs' },
      { title: 'embassy-executor crate documentation', url: 'https://docs.rs/embassy-executor/latest/embassy_executor/', kind: 'docs' },
      { title: 'RTIC real-time framework documentation', url: 'https://docs.rs/rtic/latest/rtic/', kind: 'docs' },
    ],
  },
  {
    id: 'analytics-lakehouse',
    title: 'Analytics lakehouse (CDC to Parquet to Polars)',
    level: 'industry',
    summary:
      'CDC events land in an object-store lake as partitioned Parquet, and Rust jobs compact and transform them with Arrow and Polars. Writes are atomic: data is uploaded to a staging key and promoted only after validation. Queries prune partitions and columns, and the same code runs on local disk in tests and object storage in production.',
    stack: ['arrow', 'parquet', 'polars', 'object_store', 'sqlx', 'tokio'],
    flow: [
      '1. A CDC connector reads the Postgres logical replication slot or a Debezium topic and hands change events to the ingestion job.',
      '2. Ingestion dedupes by primary key keeping the highest LSN, validates the schema, and builds Arrow record batches.',
      '3. A Parquet writer lands staging files under date=YYYY-MM-DD/hour=HH with row groups sized for scans; a manifest commits only after the upload.',
      '4. Compaction merges small files per partition and drops superseded keys, keeping file counts and metadata predictable.',
      '5. Transform jobs read with column projection and predicate pushdown, run lazy Polars aggregations, and write the curated zone.',
      '6. Readers query the curated Parquet through Polars or an external engine, with a catalog holding schema versions and partition bounds.',
    ],
    components: [
      { name: 'Ingestion', role: 'CDC consumption, dedupe by LSN, schema validation', crates: ['tokio', 'serde'] },
      { name: 'Storage', role: 'staging keys, atomic promote, compaction', crates: ['object_store', 'parquet'] },
      { name: 'Transform', role: 'lazy aggregations, joins, schema evolution', crates: ['polars', 'arrow'] },
      { name: 'Catalog', role: 'table metadata, partition bounds, job checkpoints', crates: ['sqlx'] },
    ],
    checklist: [
      'Writes are atomic: a file or manifest becomes visible only after validation, never half-written.',
      'Partitioning matches the dominant query filters, and compaction keeps small files and file counts bounded.',
      'Schema evolution is additive and versioned; readers tolerate new nullable columns and unknown fields.',
      'Job checkpoints make reruns idempotent and replayable from a known offset or LSN.',
      'Cost is monitored: bytes scanned per query, files per partition, and alerting on failed or lagging jobs.',
    ],
    lessons: ['m01', 'm02', 'm03', 'm05'],
    resources: [
      { title: 'arrow crate documentation', url: 'https://docs.rs/arrow/latest/arrow/', kind: 'docs' },
      { title: 'parquet crate documentation', url: 'https://docs.rs/parquet/latest/parquet/', kind: 'docs' },
      { title: 'Polars crate documentation', url: 'https://docs.rs/polars/latest/polars/', kind: 'docs' },
    ],
  },

];
