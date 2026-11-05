/**
 * Rust Academy reference data: the cheatsheet and the architecture blueprints.
 *
 * Plain JSON-compatible data consumed by src/app.js through build.mjs.
 */
export const CHEATSHEET = [
  {
    "title": "Cargo & workspace",
    "items": [
      {
        "name": "workspace layout",
        "code": "# Cargo.toml (repo root)\n[workspace]\nresolver = \"2\"\nmembers = [\"crates/api\", \"crates/worker\", \"crates/core\"]\n\n[workspace.dependencies]\n# pinned to the APIs taught in this course; run \"cargo add <crate> --dry-run\"\n# to see what is current before you upgrade a major line\naxum = \"0.8\"\ntokio = { version = \"1\", features = [\"full\"] }\nserde = { version = \"1\", features = [\"derive\"] }\nsqlx = { version = \"0.8\", features = [\"runtime-tokio\", \"tls-rustls\", \"postgres\", \"uuid\", \"time\", \"migrate\"] }\ntower-http = { version = \"0.6\", features = [\"trace\", \"cors\", \"timeout\", \"compression-gzip\"] }"
      },
      {
        "name": "one version per dependency",
        "code": "# crates/api/Cargo.toml — inherit the workspace version\n[dependencies]\naxum.workspace = true\ntokio.workspace = true\nserde.workspace = true\ncore = { path = \"../core\" }"
      },
      {
        "name": "release profile for services",
        "code": "[profile.release]\nlto = \"thin\"          # cross-crate inlining without full-LTO build times\ncodegen-units = 1     # slower build, faster binary\nstrip = \"symbols\"     # smaller image; strip debuginfo, keep line tables in a separate file\n# do NOT set panic = \"abort\" if you rely on catch_unwind / tower catch-panic"
      },
      {
        "name": "audit the dependency graph",
        "code": "cargo tree -d                      # duplicate versions of the same crate\ncargo install cargo-deny\ncargo deny check advisories bans licenses sources\ncargo install cargo-audit\ncargo audit                        # RustSec advisory database"
      },
      {
        "name": "check the resolved version first",
        "code": "# --dry-run prints what cargo would resolve; nothing is written\ncargo add axum --dry-run\ncargo add sqlx --features runtime-tokio,tls-rustls,postgres\ncargo update -p tokio\ncargo update --dry-run"
      },
      {
        "name": "feature-gate optional dependencies",
        "code": "[features]\ndefault = []\notel = [\"dep:tracing-opentelemetry\", \"dep:opentelemetry-otlp\"]\n\n[dependencies]\ntracing-opentelemetry = { version = \"0.34\", optional = true }\nopentelemetry-otlp = { version = \"0.33\", optional = true }"
      }
    ]
  },
  {
    "title": "Axum 0.8 routing & handlers",
    "items": [
      {
        "name": "routes with {id} path params + state",
        "code": "use axum::{extract::{Path, State}, routing::{get, post}, Json, Router};\nuse uuid::Uuid;\n\nlet app = Router::new()\n    .route(\"/users\", post(create_user))\n    .route(\"/users/{id}\", get(get_user))\n    .route(\"/users/{id}/orders/{order_id}\", get(get_order))\n    .with_state(state);\n\nasync fn get_user(State(db): State<PgPool>, Path(id): Path<Uuid>) -> Result<Json<User>, AppError> {\n    let user = sqlx::query_as::<_, User>(\"select id, email from users where id = $1\")\n        .bind(id)\n        .fetch_optional(&db)\n        .await?\n        .ok_or(AppError::NotFound)?;\n    Ok(Json(user))\n}"
      },
      {
        "name": "error type that becomes a response",
        "code": "use axum::{http::StatusCode, response::{IntoResponse, Response}, Json};\n\n#[derive(Debug, thiserror::Error)]\npub enum AppError {\n    #[error(\"not found\")] NotFound,\n    #[error(\"invalid input: {0}\")] BadRequest(String),\n    #[error(transparent)] Db(#[from] sqlx::Error),\n}\n\nimpl IntoResponse for AppError {\n    fn into_response(self) -> Response {\n        let status = match &self {\n            AppError::NotFound => StatusCode::NOT_FOUND,\n            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,\n            AppError::Db(_) => StatusCode::INTERNAL_SERVER_ERROR,\n        };\n        (status, Json(serde_json::json!({ \"error\": self.to_string() }))).into_response()\n    }\n}"
      },
      {
        "name": "middleware stack (tower / tower-http 0.6)",
        "code": "use std::time::Duration;\nuse axum::http::StatusCode;\nuse tower::ServiceBuilder;\nuse tower_http::{cors::CorsLayer, timeout::TimeoutLayer, trace::TraceLayer};\n\nlet app = Router::new()\n    .route(\"/healthz\", get(|| async { \"ok\" }))\n    .merge(api_routes)\n    .layer(\n        ServiceBuilder::new()\n            .layer(TraceLayer::new_for_http())\n            // tower-http 0.6.7+: TimeoutLayer::new is deprecated, pick the status\n            .layer(TimeoutLayer::with_status_code(\n                StatusCode::GATEWAY_TIMEOUT,\n                Duration::from_secs(10),\n            ))\n            .layer(CorsLayer::permissive()),\n    );"
      },
      {
        "name": "serve with graceful shutdown",
        "code": "let listener = tokio::net::TcpListener::bind(\"0.0.0.0:8080\").await?;\n\naxum::serve(listener, app)\n    .with_graceful_shutdown(async move {\n        // SIGINT in dev; wire SIGTERM with tokio::signal::unix in production\n        let _ = tokio::signal::ctrl_c().await;\n    })\n    .await?;"
      },
      {
        "name": "WebSocket route (ws feature)",
        "code": "use axum::{extract::ws::{WebSocket, WebSocketUpgrade}, response::Response, routing::any};\n\nasync fn ws_handler(ws: WebSocketUpgrade) -> Response {\n    ws.on_upgrade(handle_socket)\n}\n\nasync fn handle_socket(mut socket: WebSocket) {\n    while let Some(msg) = socket.recv().await {\n        let Ok(msg) = msg else { return };       // client disconnected\n        if socket.send(msg).await.is_err() {\n            return;\n        }\n    }\n}\n\n// Router::new().route(\"/ws\", any(ws_handler))"
      },
      {
        "name": "extractor order and JSON bodies",
        "code": "use axum::{extract::{Extension, State}, http::StatusCode, Json};\n\n// AuthUser is your own extension type, inserted by the auth middleware.\npub struct AuthUser { pub id: uuid::Uuid }\n\n// Body-consuming extractors (Json, Form, Multipart) MUST be the last argument.\nasync fn create_order(\n    State(state): State<AppState>,\n    Extension(user): Extension<AuthUser>,\n    Json(payload): Json<CreateOrder>,\n) -> Result<(StatusCode, Json<Order>), AppError> {\n    let order = state.orders.create(user.id, payload).await?;\n    Ok((StatusCode::CREATED, Json(order)))\n}"
      }
    ]
  },
  {
    "title": "Serde & validation",
    "items": [
      {
        "name": "strict input struct",
        "code": "use serde::{Deserialize, Serialize};\n\n#[derive(Debug, Deserialize)]\n#[serde(deny_unknown_fields, rename_all = \"snake_case\")]\npub struct CreateAccount {\n    pub email: String,\n    #[serde(default)]\n    pub display_name: Option<String>,\n    #[serde(default = \"default_plan\")]\n    pub plan: String,\n}\n\nfn default_plan() -> String { \"free\".into() }"
      },
      {
        "name": "output struct that hides fields",
        "code": "#[derive(Serialize)]\n#[serde(rename_all = \"camelCase\")]\npub struct AccountView {\n    pub id: uuid::Uuid,\n    pub email: String,\n    #[serde(skip_serializing_if = \"Option::is_none\")]\n    pub display_name: Option<String>,\n    #[serde(skip_serializing)]\n    pub password_hash: String,\n}"
      },
      {
        "name": "validate the payload before the DB",
        "code": "use validator::Validate;\n\n#[derive(Debug, Deserialize, Validate)]\npub struct Signup {\n    #[validate(email)]\n    pub email: String,\n    #[validate(length(min = 12, max = 128))]\n    pub password: String,\n}\n\n// in the handler:\npayload.validate().map_err(|e| AppError::BadRequest(e.to_string()))?;"
      },
      {
        "name": "internally tagged event enum",
        "code": "#[derive(Debug, Serialize, Deserialize)]\n#[serde(tag = \"type\", rename_all = \"snake_case\")]\npub enum OrderEvent {\n    Created { order_id: uuid::Uuid, total_cents: i64 },\n    Cancelled { order_id: uuid::Uuid, reason: String },\n}\n\n// {\"type\":\"created\",\"order_id\":\"...\",\"total_cents\":1999}"
      },
      {
        "name": "field-level JSON errors",
        "code": "use serde_path_to_error as path;\n\n// serde's own error has no JSON path; this points at the offending field.\nlet mut de = serde_json::Deserializer::from_slice(&body);\nlet payload: CreateOrder = path::deserialize(&mut de)\n    .map_err(|e| AppError::BadRequest(format!(\"{} at {}\", e, e.path())))?;"
      }
    ]
  },
  {
    "title": "SQLx (Postgres)",
    "items": [
      {
        "name": "pool with timeouts",
        "code": "use sqlx::postgres::PgPoolOptions;\nuse std::time::Duration;\n\nlet pool = PgPoolOptions::new()\n    .max_connections(20)\n    .min_connections(2)\n    .acquire_timeout(Duration::from_secs(3))   // backpressure, not endless queueing\n    .idle_timeout(Duration::from_secs(600))\n    .max_lifetime(Duration::from_secs(1800))\n    .connect(&std::env::var(\"DATABASE_URL\")?)\n    .await?;"
      },
      {
        "name": "typed row mapping",
        "code": "#[derive(Debug, sqlx::FromRow)]\nstruct User {\n    id: uuid::Uuid,\n    email: String,\n}\n\nlet user = sqlx::query_as::<_, User>(\"select id, email from users where id = $1\")\n    .bind(id)\n    .fetch_one(&pool)\n    .await?;"
      },
      {
        "name": "transaction (drop = rollback)",
        "code": "let mut tx = pool.begin().await?;\n\nsqlx::query(\"update accounts set balance_cents = balance_cents - $1 where id = $2\")\n    .bind(cents).bind(from)\n    .execute(&mut *tx).await?;\n\nsqlx::query(\"update accounts set balance_cents = balance_cents + $1 where id = $2\")\n    .bind(cents).bind(to)\n    .execute(&mut *tx).await?;\n\ntx.commit().await?;   // dropping without commit rolls back"
      },
      {
        "name": "compile-time checked queries + migrations",
        "code": "// Needs DATABASE_URL at build time, or a committed .sqlx/ from:\n//   cargo sqlx prepare\nlet row = sqlx::query!(\"select id, email from users where email = $1\", email)\n    .fetch_optional(&pool)\n    .await?;\n\n// apply embedded migrations at startup (single-replica bootstrap or a Job)\nsqlx::migrate!(\"./migrations\").run(&pool).await?;"
      },
      {
        "name": "keyset pagination",
        "code": "// Stable under inserts and no OFFSET scan: the index does the work.\nlet rows = sqlx::query_as::<_, User>(\n    \"select id, email, created_at from users\n     where (created_at, id) < ($1, $2)\n     order by created_at desc, id desc\n     limit $3\",\n)\n.bind(cursor_created_at)\n.bind(cursor_id)\n.bind(limit)\n.fetch_all(&pool)\n.await?;"
      },
      {
        "name": "bulk insert in one round trip",
        "code": "let ids: Vec<uuid::Uuid> = items.iter().map(|i| i.id).collect();\nlet payloads: Vec<String> = items.iter().map(|i| i.payload.clone()).collect();\n\nsqlx::query(\n    \"insert into events (id, payload)\n     select * from unnest($1::uuid[], $2::text[])\n     on conflict (id) do nothing\",\n)\n.bind(&ids)\n.bind(&payloads)\n.execute(&pool)\n.await?;"
      }
    ]
  },
  {
    "title": "Redis",
    "items": [
      {
        "name": "async connection + cache write",
        "code": "use redis::AsyncCommands;\n\nlet client = redis::Client::open(std::env::var(\"REDIS_URL\")?)?;\nlet mut conn = client.get_multiplexed_async_connection().await?;\n\n// multiplexed connections are cheap to clone; no pool needed for async\nlet _: () = conn.set_ex(\"session:42\", token, 900).await?;\nlet cached: Option<String> = conn.get(\"session:42\").await?;"
      },
      {
        "name": "cache-aside with explicit TTL",
        "code": "let key = format!(\"tenant:{tenant_id}:user:{id}\");\n\nif let Some(json) = redis::cmd(\"GET\")\n    .arg(&key)\n    .query_async::<Option<String>>(&mut conn)\n    .await?\n{\n    return Ok(serde_json::from_str(&json)?);\n}\n\nlet user = load_from_db(&pool, tenant_id, id).await?;\nlet _: () = redis::cmd(\"SET\")\n    .arg(&key)\n    .arg(serde_json::to_string(&user)?)\n    .arg(\"EX\").arg(300)\n    .query_async(&mut conn)\n    .await?;"
      },
      {
        "name": "atomic rate limit with a Lua script",
        "code": "let script = redis::Script::new(\n    r#\"\n    local current = redis.call('INCR', KEYS[1])\n    if current == 1 then\n        redis.call('PEXPIRE', KEYS[1], ARGV[1])\n    end\n    return current\n    \"#,\n);\n\nlet count: i64 = script\n    .key(format!(\"rl:{user_id}\"))\n    .arg(60_000)\n    .invoke_async(&mut conn)\n    .await?;\n\nif count > 100 {\n    return Err(AppError::TooManyRequests);\n}"
      },
      {
        "name": "distributed lock (SET NX PX + owner token)",
        "code": "let token = uuid::Uuid::new_v4().to_string();\nlet acquired: Option<String> = redis::cmd(\"SET\")\n    .arg(&lock_key)\n    .arg(&token)\n    .arg(\"NX\").arg(\"PX\").arg(30_000)\n    .query_async(&mut conn)\n    .await?;\nif acquired.is_none() {\n    return Err(AppError::Locked);\n}\n\n// Release only if we still own it. A bare DEL can delete someone else's lock.\nlet released: i64 = redis::Script::new(\n    r#\"\n    if redis.call('GET', KEYS[1]) == ARGV[1] then\n        return redis.call('DEL', KEYS[1])\n    end\n    return 0\n    \"#,\n)\n.key(&lock_key)\n.arg(&token)\n.invoke_async(&mut conn)\n.await?;\ndebug_assert_eq!(released, 1);"
      },
      {
        "name": "pub/sub across replicas (RESP3)",
        "code": "use redis::AsyncCommands;\n\nlet (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();\nlet config = redis::AsyncConnectionConfig::new().set_push_sender(tx);\nlet mut conn = client\n    .get_multiplexed_async_connection_with_config(&config)\n    .await?;\n\nconn.subscribe(&[\"orders.created\", \"orders.cancelled\"]).await?;\n\nwhile let Some(push) = rx.recv().await {\n    // redis::PushInfo: decode the payload with FromRedisValue, then fan out locally\n    tracing::debug!(?push, \"redis push message\");\n}"
      }
    ]
  },
  {
    "title": "tonic / gRPC",
    "items": [
      {
        "name": "build.rs codegen (tonic 0.14)",
        "code": "// Cargo.toml\n// [dependencies] tonic = \"0.14\", prost = \"0.14\"\n// [build-dependencies] tonic-prost-build = \"0.14\"\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    tonic_prost_build::configure()\n        .build_client(true)\n        .build_server(true)\n        .compile_protos(&[\"proto/orders.proto\"], &[\"proto\"])?;\n    Ok(())\n}"
      },
      {
        "name": "service impl with Status mapping",
        "code": "use tonic::{Request, Response, Status};\n\n#[tonic::async_trait]\nimpl Orders for OrdersService {\n    async fn get_order(\n        &self,\n        request: Request<GetOrderRequest>,\n    ) -> Result<Response<Order>, Status> {\n        let id = uuid::Uuid::parse_str(&request.into_inner().id)\n            .map_err(|_| Status::invalid_argument(\"id must be a UUID\"))?;\n\n        let order = self.store.load(id).await\n            .map_err(|e| Status::internal(e.to_string()))?\n            .ok_or_else(|| Status::not_found(\"order not found\"))?;\n\n        Ok(Response::new(order.into()))\n    }\n}"
      },
      {
        "name": "server with health + graceful shutdown",
        "code": "use tonic::transport::Server;\nuse tonic_health::server::health_reporter;\n\nlet (mut reporter, health_service) = health_reporter();\n// flips grpc.health.v1 to SERVING for this service\nreporter.set_serving::<OrdersServer<OrdersService>>().await;\n\nServer::builder()\n    .add_service(health_service)\n    .add_service(OrdersServer::new(service))\n    .serve_with_shutdown(addr, async {\n        let _ = tokio::signal::ctrl_c().await;\n        // flip to NOT_SERVING here before draining in real code\n    })\n    .await?;"
      },
      {
        "name": "client with connect + call deadlines",
        "code": "use std::time::Duration;\nuse tonic::transport::{Channel, Endpoint};\n\nlet channel: Channel = Endpoint::from_shared(std::env::var(\"ORDERS_URL\")?)?\n    .connect_timeout(Duration::from_secs(2))\n    .timeout(Duration::from_secs(2))   // per-attempt deadline\n    .connect()\n    .await?;\n\nlet mut client = OrdersClient::new(channel)\n    .max_decoding_message_size(8 * 1024 * 1024);\n\nlet order = client.get_order(GetOrderRequest { id }).await?.into_inner();"
      },
      {
        "name": "server-streaming RPC",
        "code": "use tokio_stream::wrappers::ReceiverStream;\n\ntype WatchStream = ReceiverStream<Result<OrderEvent, Status>>;\n\n#[tonic::async_trait]\nimpl Orders for OrdersService {\n    type WatchStream = WatchStream;\n\n    async fn watch(\n        &self,\n        request: Request<WatchRequest>,\n    ) -> Result<Response<Self::WatchStream>, Status> {\n        let (tx, rx) = tokio::sync::mpsc::channel(64);\n        let mut updates = self.subscribe(request.into_inner().tenant_id).await?;\n        tokio::spawn(async move {\n            while let Some(event) = updates.recv().await {\n                if tx.send(Ok(event)).await.is_err() { break; }\n            }\n        });\n        Ok(Response::new(ReceiverStream::new(rx)))\n    }\n}"
      },
      {
        "name": "metadata interceptor for auth/tracing",
        "code": "use tonic::{service::Interceptor, Request, Status};\n\n#[derive(Clone)]\nstruct Auth { token: String }\n\nimpl Interceptor for Auth {\n    fn call(&mut self, mut req: Request<()>) -> Result<Request<()>, Status> {\n        req.metadata_mut().insert(\n            \"authorization\",\n            format!(\"Bearer {}\", self.token).parse().unwrap(),\n        );\n        Ok(req)\n    }\n}\n\nlet client = OrdersClient::with_interceptor(channel, Auth { token });"
      }
    ]
  },
  {
    "title": "Kafka with rdkafka",
    "items": [
      {
        "name": "idempotent producer, keyed records",
        "code": "use rdkafka::config::ClientConfig;\nuse rdkafka::producer::{FutureProducer, FutureRecord};\nuse rdkafka::util::Timeout;\n\nlet producer: FutureProducer = ClientConfig::new()\n    .set(\"bootstrap.servers\", &brokers)\n    .set(\"enable.idempotence\", \"true\")   // no duplicates on internal retry\n    .set(\"acks\", \"all\")\n    .set(\"linger.ms\", \"5\")\n    .set(\"message.timeout.ms\", \"5000\")\n    .create()?;\n\nlet record = FutureRecord::to(\"orders.events\")\n    .key(&order_id.to_string())   // same key -> same partition -> ordering\n    .payload(&serde_json::to_vec(&event)?);\n\nproducer\n    .send(record, Timeout::After(std::time::Duration::from_secs(5)))\n    .await\n    .map_err(|(err, _msg)| err)?;"
      },
      {
        "name": "at-least-once consumer (commit after work)",
        "code": "use futures_util::StreamExt;\nuse rdkafka::consumer::{CommitMode, Consumer, StreamConsumer};\n\nlet consumer: StreamConsumer = ClientConfig::new()\n    .set(\"bootstrap.servers\", &brokers)\n    .set(\"group.id\", \"billing\")\n    .set(\"enable.auto.commit\", \"false\")   // never commit before the side effect\n    .set(\"auto.offset.reset\", \"earliest\")\n    .set(\"isolation.level\", \"read_committed\")\n    .create()?;\nconsumer.subscribe(&[\"orders.events\"])?;\n\nlet mut stream = consumer.stream();\nwhile let Some(result) = stream.next().await {\n    let msg = result?;\n    handle(&msg).await?;\n    consumer.commit_message(&msg, CommitMode::Async)?;\n}"
      },
      {
        "name": "dead-letter after handler failure",
        "code": "use rdkafka::message::{Header, Message, OwnedHeaders};\n\nasync fn handle_or_dlq(\n    msg: &rdkafka::message::BorrowedMessage<'_>,\n    producer: &FutureProducer,\n) -> anyhow::Result<()> {\n    match handle(msg).await {\n        Ok(()) => Ok(()),\n        Err(_err) => {\n            let mut headers = OwnedHeaders::new();\n            headers = headers.insert(Header { key: \"x-error\", value: Some(b\"handler-failed\") });\n\n            producer\n                .send(\n                    FutureRecord::to(\"orders.events.dlq\")\n                        .payload(msg.payload().unwrap_or_default())\n                        .headers(headers),\n                    Timeout::After(std::time::Duration::from_secs(5)),\n                )\n                .await\n                .map_err(|(e, _)| e)?;\n            Ok(())\n        }\n    }\n}"
      },
      {
        "name": "replay one partition",
        "code": "use rdkafka::consumer::{CommitMode, Consumer};\nuse rdkafka::{Offset, TopicPartitionList};\n\n// Rewind a partition to the beginning: useful for replaying a bug fix.\nlet mut tpl = TopicPartitionList::new();\ntpl.add_partition_offset(\"orders.events\", 0, Offset::Beginning)?;\nconsumer.assign(&tpl)?;\n\n// Graceful shutdown: stop polling and commit the final state synchronously.\nconsumer.unsubscribe()?;\nconsumer.commit_consumer_state(CommitMode::Sync)?;"
      }
    ]
  },
  {
    "title": "NATS with async-nats",
    "items": [
      {
        "name": "connect, publish, flush",
        "code": "let client = async_nats::connect_with_options(\n    std::env::var(\"NATS_URL\")?,\n    async_nats::ConnectOptions::new().retry_on_initial_connect(),\n)\n.await?;\n\nclient.publish(\"orders.created\", payload.into()).await?;\nclient.flush().await?;   // don't exit before the internal buffer drains"
      },
      {
        "name": "headers (dedupe + tracing ids)",
        "code": "let mut headers = async_nats::HeaderMap::new();\nheaders.insert(\"Nats-Msg-Id\", \"order-7f3c1a\");   // server-side dedupe window\n\nclient\n    .publish_with_headers(\"orders.created\", headers, payload.into())\n    .await?;"
      },
      {
        "name": "JetStream stream + durable consumer",
        "code": "use futures_util::StreamExt;\n\n// async-nats = { version = \"0.51\", features = [\"jetstream\"] }\nlet js = async_nats::jetstream::new(client);\n\nlet stream = js\n    .get_or_create_stream(async_nats::jetstream::stream::Config {\n        name: \"ORDERS\".to_string(),\n        subjects: vec![\"orders.>\".to_string()],\n        ..Default::default()\n    })\n    .await?;\n\nlet consumer = stream\n    .get_or_create_consumer(\n        \"billing\",\n        async_nats::jetstream::consumer::pull::Config {\n            durable_name: Some(\"billing\".to_string()),\n            ..Default::default()\n        },\n    )\n    .await?;\n\nlet mut messages = consumer.messages().await?;\nwhile let Some(message) = messages.next().await {\n    let message = message?;\n    handle(&message.payload).await?;\n    message.ack().await?;\n}"
      },
      {
        "name": "request/reply and KV",
        "code": "// Core NATS request/reply: one call, one response.\nlet reply = client.request(\"orders.lookup\", key.into()).await?;\nlet order: Order = serde_json::from_slice(&reply.payload)?;\n\n// Key-value store on top of JetStream (last value wins, revision-checked).\nlet kv = js.get_key_value(\"config\").await?;\nlet flags = kv.get(\"feature.flags\").await?;\n\nif let Some(flags) = flags {\n    let flags: FeatureFlags = serde_json::from_slice(&flags)?;\n    tracing::info!(?flags, \"loaded remote config\");\n}"
      }
    ]
  },
  {
    "title": "Tokio tasks & cancellation",
    "items": [
      {
        "name": "JoinSet for a batch of tasks",
        "code": "use tokio::task::JoinSet;\n\nlet mut set = JoinSet::new();\nfor job in jobs {\n    set.spawn(async move { process(job).await });\n}\n\nwhile let Some(result) = set.join_next().await {\n    match result {\n        Ok(Ok(())) => {}\n        Ok(Err(err)) => tracing::warn!(%err, \"job failed\"),\n        Err(join_err) => tracing::error!(%join_err, \"job panicked\"),\n    }\n}"
      },
      {
        "name": "CancellationToken + select",
        "code": "use tokio::select;\nuse tokio_util::sync::CancellationToken;\n\nlet token = CancellationToken::new();\nlet worker = token.clone();\n\nlet handle = tokio::spawn(async move {\n    loop {\n        select! {\n            _ = worker.cancelled() => break,\n            msg = rx.recv() => match msg {\n                Some(msg) => handle(msg).await,\n                None => break,\n            },\n        }\n    }\n});\n\ntoken.cancel();      // from the signal handler\nhandle.await?;      // wait for the flush"
      },
      {
        "name": "TaskTracker drains in-flight work",
        "code": "use tokio_util::task::TaskTracker;\n\nlet tracker = TaskTracker::new();\nfor connection in listener_loop() {\n    tracker.spawn(serve_connection(connection));\n}\n\ntracker.close();       // no new tasks accepted\ntracker.wait().await;  // resolves after every spawned task finishes"
      },
      {
        "name": "bounded concurrency with a semaphore",
        "code": "use std::sync::Arc;\nuse tokio::sync::Semaphore;\n\nlet limit = Arc::new(Semaphore::new(32));   // max concurrent outbound calls\n\nfor id in ids {\n    let permit = limit.clone().acquire_owned().await?;\n    tokio::spawn(async move {\n        let _permit = permit;   // released on drop\n        let _ = fetch_and_store(id).await;\n    });\n}"
      },
      {
        "name": "never block a worker thread",
        "code": "// CPU-heavy or blocking FFI work belongs on the blocking pool.\nlet hash = tokio::task::spawn_blocking(move || expensive_hash(&input)).await??;\n\n// File I/O: use tokio::fs / AsyncRead, not std::fs inside an async fn.\nlet body = tokio::fs::read_to_string(\"config.toml\").await?;"
      },
      {
        "name": "timeout around any upstream call",
        "code": "use tokio::time::{timeout, Duration};\n\nmatch timeout(Duration::from_millis(250), cache.get(&key)).await {\n    Ok(Ok(value)) => value,\n    Ok(Err(err)) => return Err(err.into()),\n    Err(_elapsed) => return Err(AppError::UpstreamTimeout),\n}"
      }
    ]
  },
  {
    "title": "Processes, signals & shutdown",
    "items": [
      {
        "name": "SIGTERM + SIGINT",
        "code": "use tokio::signal::unix::{signal, SignalKind};\n\nlet mut sigterm = signal(SignalKind::terminate())?;\nlet mut sigint = signal(SignalKind::interrupt())?;\n\ntokio::select! {\n    _ = sigterm.recv() => tracing::info!(\"SIGTERM received\"),\n    _ = sigint.recv() => tracing::info!(\"SIGINT received\"),\n}"
      },
      {
        "name": "shutdown order matters",
        "code": "// 1. stop accepting new work\ntoken.cancel();                 // tell background tasks\ndrop(listener);                 // close the accept loop\n\n// 2. drain in-flight work\ntracker.close();\ntracker.wait().await;\n\n// 3. release resources, then flush telemetry\npool.close().await;             // sqlx: waits for checked-out connections\ntracer_provider.shutdown()?;    // last spans are not lost"
      },
      {
        "name": "subprocess with timeout + kill_on_drop",
        "code": "use std::process::Stdio;\nuse tokio::process::Command;\n\nlet mut child = Command::new(\"ffmpeg\")\n    .args([\"-i\", input, \"-f\", \"null\", \"-\"])\n    .stdout(Stdio::null())\n    .stderr(Stdio::piped())\n    .kill_on_drop(true)          // orphan-proof if the future is dropped\n    .spawn()?;\n\nlet status = tokio::time::timeout(std::time::Duration::from_secs(300), child.wait()).await??;\nanyhow::ensure!(status.success(), \"ffmpeg exited with {status}\");"
      },
      {
        "name": "stream a child's stdout",
        "code": "use tokio::io::{AsyncBufReadExt, BufReader};\n\nlet stdout = child.stdout.take().expect(\"stdout piped\");\nlet mut lines = BufReader::new(stdout).lines();\n\nwhile let Some(line) = lines.next_line().await? {\n    if let Some(rest) = line.strip_prefix(\"progress=\") {\n        metrics.set_progress(rest);\n    }\n}\n\nlet status = child.wait().await?;"
      },
      {
        "name": "supervisor loop with capped backoff",
        "code": "let mut delay = std::time::Duration::from_millis(200);\n\nloop {\n    let mut child = spawn_worker()?;\n\n    tokio::select! {\n        status = child.wait() => {\n            tracing::warn!(?status, \"worker exited; restarting\");\n            delay = (delay * 2).min(std::time::Duration::from_secs(30));\n        }\n        _ = token.cancelled() => {\n            child.kill().await?;\n            break;\n        }\n    }\n\n    tokio::time::sleep(delay).await;\n}"
      }
    ]
  },
  {
    "title": "Observability (tracing + metrics)",
    "items": [
      {
        "name": "subscriber with env filter",
        "code": "use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};\n\ntracing_subscriber::registry()\n    .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| \"info,tower_http=debug\".into()))\n    .with(fmt::layer())\n    .init();"
      },
      {
        "name": "production JSON logs",
        "code": "use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};\n\nlet fmt_layer = fmt::layer()\n    .json()                // one object per line for the log pipeline\n    .with_current_span(true)\n    .with_target(true);\n\ntracing_subscriber::registry()\n    .with(EnvFilter::try_from_env(\"RUST_LOG\")?)\n    .with(fmt_layer)\n    .init();"
      },
      {
        "name": "#[instrument] with useful fields",
        "code": "#[tracing::instrument(\n    skip(pool, payload),\n    fields(order.id = %order_id, user.id = %user_id)\n)]\nasync fn create_order(\n    pool: &sqlx::PgPool,\n    user_id: uuid::Uuid,\n    order_id: uuid::Uuid,\n    payload: CreateOrder,\n) -> Result<Order, AppError> {\n    // every event inside carries order.id, user.id and the trace/span ids\n    let order = insert_order(pool, order_id, payload).await?;\n    Ok(order)\n}"
      },
      {
        "name": "OTLP trace pipeline (tonic exporter)",
        "code": "use opentelemetry::trace::TracerProvider as _;\nuse opentelemetry_otlp::SpanExporter;\nuse opentelemetry_sdk::{trace::SdkTracerProvider, Resource};\nuse tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};\n\nlet exporter = SpanExporter::builder()\n    .with_tonic()\n    .with_endpoint(\"http://otel-collector:4317\")\n    .build()?;\n\nlet tracer_provider = SdkTracerProvider::builder()\n    .with_batch_exporter(exporter)\n    .with_resource(Resource::builder().with_service_name(\"orders-api\").build())\n    .build();\n\nlet tracer = tracer_provider.tracer(\"orders-api\");\ntracing_subscriber::registry()\n    .with(tracing_opentelemetry::layer().with_tracer(tracer))\n    .with(tracing_subscriber::fmt::layer())\n    .init();\n\n// on shutdown: tracer_provider.shutdown()?;"
      },
      {
        "name": "RED metrics: counter + histogram",
        "code": "use opentelemetry::{global, KeyValue};\n\nlet meter = global::meter(\"orders-api\");\nlet requests = meter.u64_counter(\"http.server.requests\").build();\nlet latency = meter.f64_histogram(\"http.server.duration_ms\").build();\n\nrequests.add(1, &[\n    KeyValue::new(\"route\", \"/orders\"),\n    KeyValue::new(\"status\", \"200\"),\n]);\nlatency.record(12.4, &[KeyValue::new(\"route\", \"/orders\")]);"
      },
      {
        "name": "log context, record errors once",
        "code": "// Structured fields are searchable; keep PII out of them.\ntracing::info!(\n    order.id = %order_id,\n    amount_cents = order.total_cents,\n    customer.tier = %tier,\n    \"order accepted\"\n);\n\n// Error path: one event with the error field, linked to the active span.\ntracing::error!(error = %err, error.kind = \"db\", \"order insert failed\");"
      }
    ]
  },
  {
    "title": "Config & secrets",
    "items": [
      {
        "name": "layered config with figment",
        "code": "use figment::{providers::{Env, Format, Serialized, Toml}, Figment};\n\n#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]\npub struct Config {\n    pub database_url: String,\n    #[serde(default = \"default_port\")]\n    pub port: u16,\n}\nfn default_port() -> u16 { 8080 }\n\nimpl Default for Config {\n    fn default() -> Self {\n        Self { database_url: String::new(), port: default_port() }\n    }\n}\n\nlet config: Config = Figment::new()\n    .merge(Serialized::defaults(Config::default()))\n    .merge(Toml::file(\"config.toml\"))\n    .merge(Env::prefixed(\"APP_\").split(\"__\"))   // APP_DATABASE__URL overrides\n    .extract()?;"
      },
      {
        "name": "fail fast on a missing secret",
        "code": "use anyhow::Context;\n\nfn required(name: &str) -> anyhow::Result<String> {\n    std::env::var(name).with_context(|| format!(\"{name} must be set\"))\n}\n\nlet jwt_secret = required(\"JWT_SECRET\")?;\nanyhow::ensure!(jwt_secret.len() >= 32, \"JWT_SECRET must be at least 32 bytes\");"
      },
      {
        "name": "a Debug impl that redacts",
        "code": "pub struct DatabaseConfig {\n    pub url: String,\n    pub password: Option<String>,\n}\n\nimpl std::fmt::Debug for DatabaseConfig {\n    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {\n        f.debug_struct(\"DatabaseConfig\")\n            .field(\"url\", &\"<redacted>\")\n            .field(\"password\", &self.password.as_ref().map(|_| \"<redacted>\"))\n            .finish()\n    }\n}"
      },
      {
        "name": "validate config at startup",
        "code": "#[derive(Debug, serde::Deserialize, validator::Validate)]\npub struct Config {\n    #[validate(url)]\n    pub database_url: String,\n    #[validate(range(min = 1, max = 65535))]\n    pub port: u16,\n    #[validate(range(min = 1, max = 1000))]\n    pub max_db_connections: u32,\n}\n\nlet config: Config = figment.extract()?;\nconfig.validate()?;   // fail at boot, not on the first request"
      },
      {
        "name": "no silent defaults for credentials",
        "code": "// 12-factor: config arrives from the environment; the image holds no secrets.\nlet config = Config {\n    database_url: required(\"DATABASE_URL\")?,\n    jwt_secret: required(\"JWT_SECRET\")?,\n    redis_url: required(\"REDIS_URL\")?,\n    // optional tuning knobs may default; credentials may not\n    port: std::env::var(\"PORT\").ok().and_then(|p| p.parse().ok()).unwrap_or(8080),\n};"
      }
    ]
  },
  {
    "title": "Resilience",
    "items": [
      {
        "name": "retry with exponential backoff",
        "code": "use std::time::Duration;\nuse backon::{ExponentialBuilder, Retryable};\n\nlet body = (|| async { client.get(&url).send().await?.error_for_status() })\n    .retry(\n        ExponentialBuilder::default()\n            .with_min_delay(Duration::from_millis(100))\n            .with_max_delay(Duration::from_secs(5))\n            .with_max_times(5),\n    )\n    .notify(|err, delay| tracing::warn!(%err, ?delay, \"retrying upstream\"))\n    .await?;"
      },
      {
        "name": "circuit breaker",
        "code": "use std::sync::atomic::{AtomicU32, Ordering};\n\npub struct Breaker {\n    failures: AtomicU32,\n}\n\nimpl Breaker {\n    pub fn allow(&self) -> bool {\n        self.failures.load(Ordering::Relaxed) < 5\n    }\n\n    pub fn record(&self, ok: bool) {\n        if ok {\n            self.failures.store(0, Ordering::Relaxed);\n        } else {\n            self.failures.fetch_add(1, Ordering::Relaxed);\n        }\n    }\n}"
      },
      {
        "name": "retry only idempotent operations",
        "code": "// Safe to replay: idempotency key sent with every attempt.\nlet request = || client.post(&url).header(\"Idempotency-Key\", &key).json(&order).send();\n\n// Every attempt also gets a deadline: no unbounded awaits.\nlet response = request\n    .retry(ExponentialBuilder::default().with_max_times(3))\n    .await?;\n\n// Never blind-retry a non-idempotent call whose success you can't observe."
      },
      {
        "name": "idempotency key table",
        "code": "// The unique index does the dedupe; the row records the outcome.\nlet inserted = sqlx::query(\n    \"insert into idempotency_keys (key, request_hash, status)\n     values ($1, $2, 'in_progress')\n     on conflict (key) do nothing\n     returning key\",\n)\n.bind(&key)\n.bind(&request_hash)\n.fetch_optional(&pool)\n.await?;\n\nif inserted.is_none() {\n    // A previous attempt owns this key: return the stored response.\n    return load_stored_response(&pool, &key).await;\n}"
      },
      {
        "name": "bulkheads per dependency",
        "code": "// One slow dependency must not consume every connection in the process.\npub struct Bulkheads {\n    pub payments: Arc<tokio::sync::Semaphore>,\n    pub search: Arc<tokio::sync::Semaphore>,\n}\n\nlet _permit = state.bulkheads.payments.clone()\n    .try_acquire_owned()\n    .map_err(|_| AppError::Overloaded)?;   // fail fast instead of queueing forever"
      },
      {
        "name": "degrade instead of failing",
        "code": "match primary.load(id).await {\n    Ok(value) => Ok(value),\n    Err(err) => {\n        tracing::warn!(%err, \"primary failed, serving cache\");\n        cache.get(id).await?.ok_or(AppError::Unavailable)\n    }\n}"
      }
    ]
  },
  {
    "title": "Security",
    "items": [
      {
        "name": "hash passwords with Argon2",
        "code": "use argon2::{\n    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},\n    Argon2,\n};\n\nlet salt = SaltString::generate(&mut OsRng);\nlet hash = Argon2::default()\n    .hash_password(password.as_bytes(), &salt)?\n    .to_string();\n\n// verify a login attempt\nlet parsed = PasswordHash::new(&hash)?;\nlet ok = Argon2::default()\n    .verify_password(attempt.as_bytes(), &parsed)\n    .is_ok();"
      },
      {
        "name": "JWT encode/decode",
        "code": "use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};\n\n#[derive(serde::Serialize, serde::Deserialize)]\nstruct Claims { sub: String, exp: usize, tenant: String }\n\nlet now = chrono::Utc::now().timestamp() as usize;\nlet claims = Claims { sub: user_id.to_string(), exp: now + 900, tenant };\nlet token = encode(&Header::default(), &claims, &EncodingKey::from_secret(secret))?;\n\nlet data = decode::<Claims>(\n    &token,\n    &DecodingKey::from_secret(secret),\n    &Validation::new(Algorithm::HS256),\n)?;"
      },
      {
        "name": "constant-time secret comparison",
        "code": "use subtle::ConstantTimeEq;\n\n// API keys / webhook signatures: compare without leaking timing information.\nlet expected = api_key_from_db.as_bytes();\nlet provided = header_value.as_bytes();\n\nif provided.ct_eq(expected).unwrap_u8() == 1 {\n    // authenticated\n} else {\n    // reject; do not log either value\n}"
      },
      {
        "name": "CORS with an explicit allow-list",
        "code": "use axum::http::{header, HeaderValue, Method};\nuse tower_http::cors::CorsLayer;\n\nlet cors = CorsLayer::new()\n    .allow_origin(\"https://app.example.com\".parse::<HeaderValue>()?)\n    .allow_methods([Method::GET, Method::POST])\n    .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);\n\nlet app = Router::new().route(\"/api/orders\", get(list)).layer(cors);"
      },
      {
        "name": "bind every value, never format SQL",
        "code": "// WRONG: string-built SQL is injection by construction.\nlet sql = format!(\"select * from users where email = '{email}'\");\n\n// RIGHT: bind values; identifiers come from an allow-list, never the request.\nsqlx::query_as::<_, User>(\"select id, email from users where email = $1\")\n    .bind(email)\n    .fetch_one(&pool)\n    .await?;"
      },
      {
        "name": "mark credential headers sensitive",
        "code": "use axum::http::header;\nuse tower_http::sensitive_headers::SetSensitiveRequestHeadersLayer;\n\n// TraceLayer and friends then redact these headers instead of logging them.\nlet app = Router::new().merge(routes).layer(\n    SetSensitiveRequestHeadersLayer::new([header::AUTHORIZATION, header::COOKIE]),\n);"
      }
    ]
  },
  {
    "title": "Testing",
    "items": [
      {
        "name": "#[tokio::test]",
        "code": "#[tokio::test]\nasync fn parses_order() {\n    let order: Order = serde_json::from_str(FIXTURE).unwrap();\n    assert_eq!(order.items.len(), 2);\n    assert!(order.total_cents > 0);\n}"
      },
      {
        "name": "call the router without a socket",
        "code": "use axum::{body::Body, http::{Request, StatusCode}};\nuse tower::ServiceExt;   // for oneshot()\n\n#[tokio::test]\nasync fn rejects_bad_payload() {\n    let app = app(pool()).await;      // Router\n    let request = Request::builder()\n        .method(\"POST\")\n        .uri(\"/users\")\n        .header(\"content-type\", \"application/json\")\n        .body(Body::from(r#\"{\"email\":\"not-an-email\"}\"#))\n        .unwrap();\n\n    let response = app.oneshot(request).await.unwrap();\n    assert_eq!(response.status(), StatusCode::BAD_REQUEST);\n}"
      },
      {
        "name": "sqlx::test gives each test a database",
        "code": "// Migrations run automatically; the database is dropped afterwards.\n#[sqlx::test(migrations = \"./migrations\")]\nasync fn unique_email_is_enforced(pool: sqlx::PgPool) {\n    sqlx::query(\"insert into users (id, email) values (gen_random_uuid(), 'a@b.c')\")\n        .execute(&pool).await.unwrap();\n\n    let err = sqlx::query(\"insert into users (id, email) values (gen_random_uuid(), 'a@b.c')\")\n        .execute(&pool).await.unwrap_err();\n\n    assert!(matches!(err, sqlx::Error::Database(_)));\n}"
      },
      {
        "name": "property tests",
        "code": "use proptest::prelude::*;\n\nproptest! {\n    #[test]\n    fn parser_never_panics(input in \".*\") {\n        let _ = parse_order(&input);\n    }\n\n    #[test]\n    fn amounts_roundtrip(amount in 0i64..1_000_000) {\n        let encoded = encode(amount);\n        prop_assert_eq!(decode(&encoded), Ok(amount));\n    }\n}"
      },
      {
        "name": "integration test on an ephemeral port",
        "code": "async fn spawn(app: axum::Router) -> std::net::SocketAddr {\n    let listener = tokio::net::TcpListener::bind(\"127.0.0.1:0\").await.unwrap();\n    let addr = listener.local_addr().unwrap();\n    tokio::spawn(async move {\n        axum::serve(listener, app).await.unwrap();\n    });\n    addr\n}"
      },
      {
        "name": "deterministic timeouts with paused time",
        "code": "#[tokio::test(start_paused = true)]\nasync fn deadline_is_enforced() {\n    let result = tokio::time::timeout(std::time::Duration::from_millis(100), async {\n        tokio::time::sleep(std::time::Duration::from_secs(5)).await;\n    })\n    .await;\n\n    assert!(result.is_err());   // virtual clock: instant test, no flake\n}"
      }
    ]
  },
  {
    "title": "Docker & Kubernetes",
    "items": [
      {
        "name": "multi-stage Dockerfile",
        "code": "# syntax=docker/dockerfile:1\nFROM rust:1-bookworm AS builder\nWORKDIR /src\nCOPY Cargo.toml Cargo.lock ./\nCOPY crates ./crates\n\nRUN --mount=type=cache,target=/usr/local/cargo/registry \\\n    --mount=type=cache,target=/src/target \\\n    cargo build --release --locked --bin api \\\n && cp /src/target/release/api /usr/local/bin/api\n\nFROM gcr.io/distroless/cc-debian12\nCOPY --from=builder /usr/local/bin/api /api\nUSER nonroot:nonroot\nENTRYPOINT [\"/api\"]"
      },
      {
        "name": "immutable tags + deploy-arch build",
        "code": "# Build for the cluster architecture and tag with the commit, not \"latest\".\ndocker buildx build \\\n  --platform linux/amd64 \\\n  -t registry.example.com/api:$(git rev-parse --short HEAD) \\\n  --push .\n\n# Run the exact artifact locally with the same env contract.\ndocker run --rm -p 8080:8080 \\\n  -e RUST_LOG=info -e DATABASE_URL=postgres://localhost/app \\\n  registry.example.com/api:abc1234"
      },
      {
        "name": "three probes, three jobs",
        "code": "# deployment.yaml (excerpt)\ncontainers:\n  - name: api\n    image: registry.example.com/api:1.4.2\n    ports: [{ containerPort: 8080 }]\n    startupProbe:                    # slow boot is fine: gates the other two\n      httpGet: { path: /healthz, port: 8080 }\n      periodSeconds: 2\n      failureThreshold: 30\n    readinessProbe:                  # stop routing when dependencies fail\n      httpGet: { path: /readyz, port: 8080 }\n      periodSeconds: 5\n    livenessProbe:                   # restart only when truly wedged\n      httpGet: { path: /healthz, port: 8080 }\n      periodSeconds: 10\n      failureThreshold: 3"
      },
      {
        "name": "termination that drains",
        "code": "terminationGracePeriodSeconds: 30\ncontainers:\n  - name: api\n    lifecycle:\n      preStop:\n        exec:\n          command: [\"sleep\", \"5\"]   # let endpoints converge before SIGTERM lands"
      },
      {
        "name": "rolling update + disruption budget",
        "code": "strategy:\n  type: RollingUpdate\n  rollingUpdate:\n    maxSurge: 1\n    maxUnavailable: 0        # never dip below the desired replica count\n---\napiVersion: policy/v1\nkind: PodDisruptionBudget\nmetadata: { name: api }\nspec:\n  minAvailable: 1\n  selector:\n    matchLabels: { app: api }"
      },
      {
        "name": "locked-down pod + resources",
        "code": "securityContext:\n  runAsNonRoot: true\n  runAsUser: 65532\n  readOnlyRootFilesystem: true\n  allowPrivilegeEscalation: false\n  capabilities: { drop: [\"ALL\"] }\nresources:\n  requests: { cpu: \"100m\", memory: \"128Mi\" }\n  limits:   { memory: \"256Mi\" }   # memory limit yes, CPU limit no: avoid throttling"
      }
    ]
  },
  {
    "title": "Performance",
    "items": [
      {
        "name": "criterion benchmark",
        "code": "use criterion::{criterion_group, criterion_main, Criterion};\nuse std::hint::black_box;\n\nfn bench_parse(c: &mut Criterion) {\n    let input = std::fs::read_to_string(\"fixtures/orders.json\").unwrap();\n    c.bench_function(\"parse_orders\", |b| {\n        b.iter(|| parse_orders(black_box(&input)))\n    });\n}\n\ncriterion_group!(benches, bench_parse);\ncriterion_main!(benches);"
      },
      {
        "name": "flamegraph the release binary",
        "code": "cargo install flamegraph\ncargo flamegraph --bin api -- --config config.toml\n\n# or sample with perf and inspect the report\nperf record -F 999 -g -- ./target/release/api\nperf report --no-children"
      },
      {
        "name": "read the query plan, then index",
        "code": "-- Find the sequential scan before adding an index.\nexplain (analyze, buffers, format text)\nselect id, email from users\nwhere tenant_id = $1\norder by created_at desc\nlimit 50;\n\n-- CONCURRENTLY keeps writes flowing while the index builds.\ncreate index concurrently if not exists users_tenant_created_idx\n    on users (tenant_id, created_at desc);"
      },
      {
        "name": "stop reallocating per iteration",
        "code": "// Reuse one buffer instead of allocating a String per row.\nlet mut buf = String::with_capacity(4096);\nfor record in records {\n    buf.clear();\n    writeln!(&mut buf, \"{}\\t{}\", record.id, record.total_cents)?;\n    writer.write_all(buf.as_bytes()).await?;\n}"
      },
      {
        "name": "size the runtime, move CPU work off it",
        "code": "#[tokio::main(flavor = \"multi_thread\", worker_threads = 4)]\nasync fn main() -> anyhow::Result<()> {\n    // CPU-bound work goes to the blocking pool; workers stay responsive.\n    let hash = tokio::task::spawn_blocking(move || expensive_hash(input)).await??;\n    tracing::info!(%hash, \"computed\");\n    Ok(())\n}"
      },
      {
        "name": "swap in mimalloc for allocation-heavy servers",
        "code": "// Cargo.toml: mimalloc = { version = \"0.1\", default-features = false }\n\n#[global_allocator]\nstatic GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;\n\nfn main() {\n    // A faster allocator is a free win when the profile is dominated by\n    // many small allocations; measure before and after.\n}"
      }
    ]
  },
  {
    "title": "Embedded Rust (no_std)",
    "items": [
      {
        "name": "no_std crate skeleton",
        "code": "# Cargo.toml - a bare-metal binary for a Cortex-M board\n[package]\nname = \"sensor-node\"\nversion = \"0.1.0\"\nedition = \"2024\"\n\n[dependencies]\ncortex-m = \"0.7\"\ncortex-m-rt = \"0.7\"\npanic-halt = \"1\"\ndefmt = \"1\"\ndefmt-rtt = \"1\"\nembedded-hal = \"1.0\"\n\n[profile.release]\nopt-level = \"s\"\nlto = true\ncodegen-units = 1\ndebug = true          # keep symbols for probe-rs / defmt"
      },
      {
        "name": "entry point + panic/log handlers",
        "code": "#![no_std]\n#![no_main]\n\nuse cortex_m_rt::entry;\nuse panic_halt as _;   // panic handler: halt the core, no unwinding\nuse defmt_rtt as _;    // defmt transport over RTT\n\n#[entry]\nfn main() -> ! {\n    defmt::info!(\"boot: build {}\", 42u32);\n    loop {\n        cortex_m::asm::wfi();   // sleep until the next interrupt\n    }\n}"
      },
      {
        "name": "embedded-hal 1.0 driver traits",
        "code": "use embedded_hal::delay::DelayNs;\nuse embedded_hal::digital::OutputPin;\nuse embedded_hal::i2c::I2c;\n\n// Generic over any HAL implementation: one driver, every chip.\npub fn blink<P: OutputPin, D: DelayNs>(led: &mut P, delay: &mut D) -> Result<(), P::Error> {\n    led.set_high()?;\n    delay.delay_ms(500);\n    led.set_low()?;\n    delay.delay_ms(500);\n    Ok(())\n}\n\npub fn read_temp<I: I2c>(bus: &mut I, addr: u8) -> Result<[u8; 2], I::Error> {\n    let mut raw = [0u8; 2];\n    bus.write_read(addr, &[0x00], &mut raw)?;\n    Ok(raw)\n}"
      },
      {
        "name": "defmt structured logging",
        "code": "#[derive(defmt::Format)]\npub struct Reading {\n    pub channel: u8,\n    pub millivolts: u32,\n}\n\npub fn log(reading: &Reading) {\n    defmt::info!(\"adc {} = {} mV\", reading.channel, reading.millivolts);\n}\n\n// Format strings stay on the host: only a string index and the binary\n// arguments travel over RTT, so logging is cheap on a 64 MHz core."
      },
      {
        "name": "RTIC: static priorities, no locks",
        "code": "#[rtic::app(device = stm32f4xx_hal::pac, peripherals = true)]\nmod app {\n    use super::*;\n\n    #[shared]\n    struct Shared {\n        samples: u32,\n    }\n\n    #[local]\n    struct Local {}\n\n    #[init]\n    fn init(_: init::Context) -> (Shared, Local) {\n        (Shared { samples: 0 }, Local {})\n    }\n\n    #[task(binds = TIM2, shared = [samples])]\n    fn tick(mut cx: tick::Context) {\n        cx.shared.samples.lock(|s| *s += 1);\n    }\n}"
      },
      {
        "name": "Embassy: async tasks + timers",
        "code": "use embassy_executor::Spawner;\nuse embassy_time::{Duration, Timer};\n\n#[embassy_executor::main]\nasync fn main(spawner: Spawner) {\n    // Tasks are statically allocated: no heap, no dynamic dispatch.\n    spawner.spawn(heartbeat()).unwrap();\n\n    loop {\n        Timer::after(Duration::from_secs(60)).await;\n    }\n}\n\n#[embassy_executor::task]\nasync fn heartbeat() {\n    loop {\n        defmt::info!(\"alive\");\n        Timer::after(Duration::from_secs(5)).await;\n    }\n}"
      }
    ]
  },
  {
    "title": "WASM & frontend",
    "items": [
      {
        "name": "export Rust to JavaScript",
        "code": "use wasm_bindgen::prelude::*;\n\n#[wasm_bindgen]\npub fn slugify(input: &str) -> String {\n    input.to_lowercase().replace(' ', \"-\")\n}\n\n#[wasm_bindgen]\npub struct Counter {\n    value: i32,\n}\n\n#[wasm_bindgen]\nimpl Counter {\n    #[wasm_bindgen(constructor)]\n    pub fn new() -> Self {\n        Self { value: 0 }\n    }\n\n    pub fn inc(&mut self) -> i32 {\n        self.value += 1;\n        self.value\n    }\n}"
      },
      {
        "name": "web-sys: touch the DOM",
        "code": "use wasm_bindgen::prelude::*;\nuse web_sys::{Document, Element, Window};\n\n#[wasm_bindgen(start)]\npub fn start() -> Result<(), JsValue> {\n    let window: Window = web_sys::window()\n        .ok_or_else(|| JsValue::from_str(\"no window\"))?;\n    let document: Document = window\n        .document()\n        .ok_or_else(|| JsValue::from_str(\"no document\"))?;\n    let root: Element = document\n        .get_element_by_id(\"app\")\n        .ok_or_else(|| JsValue::from_str(\"missing #app\"))?;\n\n    root.set_text_content(Some(\"hello from Rust\"));\n    Ok(())\n}"
      },
      {
        "name": "Leptos component (fine-grained reactivity)",
        "code": "use leptos::prelude::*;\n\n#[component]\npub fn Counter(initial: i32) -> impl IntoView {\n    let (count, set_count) = signal(initial);\n\n    view! {\n        <button on:click=move |_| set_count.update(|n| *n += 1)>\n            \"count: \" {count}\n        </button>\n    }\n}"
      },
      {
        "name": "mount the app, readable panics",
        "code": "use leptos::{mount::mount_to_body, prelude::*};\n\nfn main() {\n    // A Rust panic becomes a console.error with a backtrace instead of a\n    // silent trap that only shows \"unreachable executed\".\n    console_error_panic_hook::set_once();\n    mount_to_body(|| view! { <Counter initial=0 /> });\n}"
      },
      {
        "name": "wasm-pack build & test",
        "code": "# --target web emits an ES module plus .d.ts; no bundler required\nwasm-pack build crates/web --target web --release\n\n# --target bundler integrates with webpack/vite (npm publish layout)\nwasm-pack build crates/web --target bundler --release\n\n# run wasm-bindgen-test suites in headless Chrome\nwasm-pack test --headless --chrome crates/web"
      },
      {
        "name": "async interop: browser fetch",
        "code": "use wasm_bindgen::prelude::*;\nuse wasm_bindgen_futures::JsFuture;\n\n#[wasm_bindgen]\npub async fn fetch_text(url: String) -> Result<String, JsValue> {\n    let window = web_sys::window()\n        .ok_or_else(|| JsValue::from_str(\"no window\"))?;\n    let response: web_sys::Response = JsFuture::from(window.fetch_with_str(&url))\n        .await?\n        .dyn_into()?;\n    let text = JsFuture::from(response.text()?).await?;\n    text.as_string()\n        .ok_or_else(|| JsValue::from_str(\"body is not a string\"))\n}"
      }
    ]
  },
  {
    "title": "AI/ML inference",
    "items": [
      {
        "name": "candle tensors & matmul",
        "code": "use candle_core::{Device, Tensor};\n\nlet dev = Device::Cpu;\nlet a = Tensor::arange(0f32, 6f32, &dev)?.reshape((2, 3))?;\nlet b = Tensor::arange(0f32, 12f32, &dev)?.reshape((3, 4))?;\nlet c = a.matmul(&b)?;\n\nprintln!(\"dims: {:?}\", c.dims());\nprintln!(\"values: {:?}\", c.to_vec2::<f32>()?);"
      },
      {
        "name": "tokenize text for a model",
        "code": "use tokenizers::Tokenizer;\n\n// tokenizer.json is the file Hugging Face ships next to the weights.\nlet tokenizer = Tokenizer::from_file(\"artifacts/tokenizer.json\")?;\nlet encoding = tokenizer.encode(\"ship it today\", true)?;\n\nprintln!(\"ids: {:?}\", encoding.get_ids());\nprintln!(\"mask: {:?}\", encoding.get_attention_mask());\nprintln!(\"tokens: {:?}\", encoding.get_tokens());"
      },
      {
        "name": "ONNX Runtime inference (ort 2.0)",
        "code": "use ort::session::Session;\n\nlet mut session = Session::builder()?\n    .commit_from_file(\"artifacts/model.onnx\")?;\n\nlet outputs = session.run(ort::inputs![\n    \"input_ids\" => ids,\n    \"attention_mask\" => mask,\n])?;\n\nlet logits = outputs[\"logits\"].try_extract_tensor::<f32>()?;\nprintln!(\"logits shape: {:?}\", logits.shape());"
      },
      {
        "name": "Burn module definition",
        "code": "use burn::nn::{Linear, LinearConfig};\nuse burn::prelude::*;\n\n#[derive(Module, Debug)]\npub struct Classifier<B: Backend> {\n    head: Linear<B>,\n}\n\nimpl<B: Backend> Classifier<B> {\n    pub fn new(device: &B::Device) -> Self {\n        Self { head: LinearConfig::new(768, 10).init(device) }\n    }\n\n    pub fn forward(&self, x: Tensor<B, 2>) -> Tensor<B, 2> {\n        self.head.forward(x)\n    }\n}"
      },
      {
        "name": "exact vector search (cosine top-k)",
        "code": "/// Brute-force top-k: exact, dependency-free, fine up to ~100k vectors.\npub fn top_k(query: &[f32], docs: &[(u64, Vec<f32>)], k: usize) -> Vec<(u64, f32)> {\n    let qn = query.iter().map(|x| x * x).sum::<f32>().sqrt();\n\n    let mut scored: Vec<(u64, f32)> = docs\n        .iter()\n        .map(|(id, v)| {\n            let dot: f32 = query.iter().zip(v).map(|(a, b)| a * b).sum();\n            let dn = v.iter().map(|x| x * x).sum::<f32>().sqrt();\n            (*id, dot / (qn * dn).max(f32::EPSILON))\n        })\n        .collect();\n\n    scored.sort_by(|a, b| b.1.total_cmp(&a.1));\n    scored.truncate(k);\n    scored\n}"
      },
      {
        "name": "dynamic batching with a channel",
        "code": "struct Job {\n    input: Vec<f32>,\n    reply: tokio::sync::oneshot::Sender<Vec<f32>>,\n}\n\nasync fn batch_loop(\n    mut rx: tokio::sync::mpsc::Receiver<Job>,\n    max_batch: usize,\n    mut infer: impl FnMut(&[Vec<f32>]) -> Vec<Vec<f32>>,\n) {\n    while let Some(first) = rx.recv().await {\n        let mut batch = vec![first];\n\n        // Drain whatever arrives inside the window, up to the batch cap.\n        while batch.len() < max_batch {\n            match tokio::time::timeout(std::time::Duration::from_millis(5), rx.recv()).await {\n                Ok(Some(job)) => batch.push(job),\n                _ => break,\n            }\n        }\n\n        let inputs: Vec<Vec<f32>> = batch.iter().map(|j| j.input.clone()).collect();\n        for (job, out) in batch.into_iter().zip(infer(&inputs)) {\n            let _ = job.reply.send(out);\n        }\n    }\n}"
      }
    ]
  },
  {
    "title": "Algorithms & data structures",
    "items": [
      {
        "name": "petgraph: shortest path + topo sort",
        "code": "use petgraph::algo::{dijkstra, toposort};\nuse petgraph::graph::{DiGraph, NodeIndex};\nuse std::collections::HashMap;\n\nlet mut g: DiGraph<&str, u32> = DiGraph::new();\nlet api = g.add_node(\"api\");\nlet db = g.add_node(\"db\");\nlet cache = g.add_node(\"cache\");\ng.add_edge(api, db, 5);\ng.add_edge(api, cache, 1);\ng.add_edge(cache, db, 1);\n\nlet dist: HashMap<NodeIndex, u32> = dijkstra(&g, api, None, |e| *e.weight());\nassert_eq!(dist[&db], 2);\n\nlet order = toposort(&g, None)?;   // Err(Cycle) if the graph is not a DAG\nassert_eq!(order.len(), 3);"
      },
      {
        "name": "BinaryHeap as a priority queue",
        "code": "use std::cmp::Ordering;\nuse std::collections::BinaryHeap;\n\n#[derive(Eq, PartialEq)]\nstruct Job {\n    priority: u8,\n    id: u64,\n}\n\nimpl Ord for Job {\n    fn cmp(&self, other: &Self) -> Ordering {\n        self.priority\n            .cmp(&other.priority)\n            .then_with(|| other.id.cmp(&self.id))\n    }\n}\n\nimpl PartialOrd for Job {\n    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {\n        Some(self.cmp(other))\n    }\n}\n\nlet mut heap = BinaryHeap::new();\nheap.push(Job { priority: 1, id: 7 });\nheap.push(Job { priority: 9, id: 8 });\nassert_eq!(heap.pop().unwrap().id, 8);   // max-heap: highest priority first"
      },
      {
        "name": "smallvec: stack storage for small sets",
        "code": "use smallvec::{smallvec, SmallVec};\n\n// Up to four elements live inline in the struct: no allocation.\nlet mut ids: SmallVec<[u64; 4]> = smallvec![1, 2, 3];\nassert!(!ids.spilled());\n\nids.push(4);\nassert!(!ids.spilled());\n\nids.push(5);      // first allocation happens here\nassert!(ids.spilled());"
      },
      {
        "name": "hashbrown entry map",
        "code": "use hashbrown::HashMap;\n\n// hashbrown is the implementation behind std's HashMap, with a fast default\n// hasher and extra APIs that std keeps unstable.\nlet mut counts: HashMap<String, u32> = HashMap::with_capacity(1024);\nfor token in tokens {\n    *counts.entry(token).or_insert(0) += 1;\n}\n\nlet mut order: Vec<(String, u32)> = counts.into_iter().collect();\norder.sort_unstable_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));"
      },
      {
        "name": "roaring bitmaps for set algebra",
        "code": "use roaring::RoaringBitmap;\n\nlet mut active = RoaringBitmap::new();\nactive.insert(1);\nactive.insert(42);\nactive.insert_range(100..200);\n\nlet mut paid = RoaringBitmap::new();\npaid.insert_range(150..250);\n\nlet both = &active & &paid;   // intersection, compressed\nassert!(both.contains(175));\nassert!(!both.contains(120));\nassert_eq!(active.len(), 102);"
      },
      {
        "name": "sort, dedupe, binary search",
        "code": "// Sort once, then every lookup is O(log n) instead of O(n).\nlet mut ids: Vec<u64> = rows.iter().map(|r| r.id).collect();\nids.sort_unstable();\nids.dedup();                       // O(n) after the sort\n\nmatch ids.binary_search(&target) {\n    Ok(idx) => println!(\"found at {idx}\"),\n    Err(idx) => println!(\"would insert at {idx}\"),\n}"
      }
    ]
  },
  {
    "title": "Data engineering",
    "items": [
      {
        "name": "build an Arrow RecordBatch",
        "code": "use std::sync::Arc;\nuse arrow::array::{Float64Array, RecordBatch, StringArray};\n\nlet tenant: Arc<dyn arrow::array::Array> =\n    Arc::new(StringArray::from(vec![\"acme\", \"acme\", \"globex\"]));\nlet amount: Arc<dyn arrow::array::Array> =\n    Arc::new(Float64Array::from(vec![10.0, 2.5, 99.0]));\n\nlet batch = RecordBatch::try_from_iter([(\"tenant\", tenant), (\"amount\", amount)])?;\nassert_eq!(batch.num_columns(), 2);\nassert_eq!(batch.num_rows(), 3);"
      },
      {
        "name": "write and read Parquet",
        "code": "use std::fs::File;\nuse parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;\nuse parquet::arrow::ArrowWriter;\n\n// Write: columnar + compressed; close() flushes the footer.\nlet mut writer = ArrowWriter::try_new(File::create(\"events.parquet\")?, batch.schema(), None)?;\nwriter.write(&batch)?;\nwriter.close()?;\n\n// Read: batch-sized streaming, never load the whole file.\nlet reader = ParquetRecordBatchReaderBuilder::try_new(File::open(\"events.parquet\")?)?\n    .with_batch_size(8192)\n    .build()?;\nfor batch in reader {\n    println!(\"rows: {}\", batch?.num_rows());\n}"
      },
      {
        "name": "polars lazy aggregation",
        "code": "use polars::prelude::*;\n\n// Polars is synchronous: call it inside spawn_blocking from async code.\nlet report = LazyFrame::scan_parquet(\"lake/events/*.parquet\", Default::default())?\n    .filter(col(\"event\").eq(lit(\"order_paid\")))\n    .group_by([col(\"tenant\")])\n    .agg([\n        col(\"amount_cents\").sum().alias(\"gross_cents\"),\n        col(\"amount_cents\").mean().alias(\"avg_cents\"),\n        len().alias(\"orders\"),\n    ])\n    .collect()?;\n\nprintln!(\"{:?}\", report.head(Some(5)));"
      },
      {
        "name": "atomic lake writes through object_store",
        "code": "use bytes::Bytes;\nuse object_store::aws::AmazonS3Builder;\nuse object_store::{path::Path, ObjectStore, PutPayload};\n\nlet store = AmazonS3Builder::from_env()\n    .with_bucket_name(\"analytics-lake\")\n    .build()?;\n\nlet staging = Path::from(\"staging/run=42/part-0.parquet\");\nstore\n    .put(&staging, PutPayload::from(Bytes::from(bytes)))\n    .await?;\n\n// Promote only after the upload succeeded: readers never see partial data.\nlet final_path = Path::from(\"events/date=2026-11-04/part-0.parquet\");\nstore.copy(&staging, &final_path).await?;\nstore.delete(&staging).await?;"
      },
      {
        "name": "dedupe CDC rows before compaction",
        "code": "use std::collections::HashMap;\n\n// Merge a change stream into the latest row per key, keeping the highest LSN.\nlet mut latest: HashMap<String, Change> = HashMap::new();\nfor change in changes {\n    latest\n        .entry(change.key.clone())\n        .and_modify(|prev| {\n            if change.lsn > prev.lsn {\n                *prev = change.clone();\n            }\n        })\n        .or_insert(change);\n}\n\nlet mut rows: Vec<Change> = latest.into_values().collect();\nrows.sort_unstable_by(|a, b| a.key.cmp(&b.key));   // deterministic file layout"
      },
      {
        "name": "column pruning on read",
        "code": "use std::fs::File;\nuse parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;\nuse parquet::arrow::ProjectionMask;\n\n// Decode only the columns the query needs: fewer bytes, less CPU.\nlet builder = ParquetRecordBatchReaderBuilder::try_new(File::open(\"events.parquet\")?)?;\nlet mask = ProjectionMask::leaves(builder.parquet_schema(), [0, 3]);\nlet reader = builder\n    .with_projection(mask)\n    .with_batch_size(4096)\n    .build()?;"
      }
    ]
  },
  {
    "title": "Security engineering",
    "items": [
      {
        "name": "verify a password, upgrade old hashes",
        "code": "use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, SaltString};\nuse argon2::{Argon2, PasswordVerifier};\n\nlet parsed = PasswordHash::new(&stored_hash)?;\nlet ok = Argon2::default()\n    .verify_password(attempt.as_bytes(), &parsed)\n    .is_ok();\n\n// Migrate old parameters on successful login instead of forcing a reset.\nif ok && parsed.algorithm.as_str() != \"argon2id\" {\n    let salt = SaltString::generate(&mut OsRng);\n    let new_hash = Argon2::default()\n        .hash_password(attempt.as_bytes(), &salt)?\n        .to_string();\n    store_hash(&new_hash).await?;\n}"
      },
      {
        "name": "OIDC token validation with JWKS",
        "code": "use jsonwebtoken::{decode, decode_header, jwk::JwkSet, DecodingKey, Validation};\n\n// 1. Fetch the issuer's keys once and cache them (refresh on unknown kid).\nlet jwks: JwkSet = reqwest::get(format!(\"{issuer}/.well-known/jwks.json\"))\n    .await?\n    .json()\n    .await?;\n\n// 2. Pick the key the token was signed with.\nlet header = decode_header(token)?;\nlet jwk = jwks\n    .find(&header.kid.unwrap_or_default())\n    .ok_or(\"unknown signing key\")?;\nlet key = DecodingKey::from_jwk(jwk)?;\n\n// 3. Check signature AND issuer/audience/expiry, not just the signature.\nlet mut validation = Validation::new(header.alg);\nvalidation.set_issuer(&[issuer]);\nvalidation.set_audience(&[audience]);\nlet claims = decode::<Claims>(token, &key, &validation)?;"
      },
      {
        "name": "rustls server config from PEM",
        "code": "use std::sync::Arc;\nuse rustls::pki_types::{CertificateDer, PrivateKeyDer};\nuse rustls::ServerConfig;\n\nlet certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut cert_reader)\n    .collect::<Result<Vec<_>, _>>()?;\nlet key: PrivateKeyDer<'static> = rustls_pemfile::private_key(&mut key_reader)?\n    .ok_or(\"no private key\")?;\n\n// TLS 1.2 + 1.3 by default; pin 1.3-only by editing the protocol versions.\n// With more than one crypto provider compiled in, install a default first:\n// rustls::crypto::ring::default_provider().install_default().unwrap();\nlet config = ServerConfig::builder()\n    .with_no_client_auth()\n    .with_single_cert(certs, key)?;\n\nlet acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));"
      },
      {
        "name": "ring HMAC for webhook signatures",
        "code": "use ring::hmac;\n\n// Verify a webhook signature over the exact raw body bytes.\nfn verify_webhook(secret: &[u8], body: &[u8], signature: &[u8]) -> Result<(), AppError> {\n    let key = hmac::Key::new(hmac::HMAC_SHA256, secret);\n    hmac::verify(&key, body, signature).map_err(|_| AppError::Unauthorized)\n}\n\n// Producing a signature for outgoing calls:\nlet tag = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, secret), body);\nlet header = hex::encode(tag.as_ref());"
      },
      {
        "name": "security headers with tower-http",
        "code": "use axum::http::{header, HeaderValue};\nuse tower::ServiceBuilder;\nuse tower_http::set_header::SetResponseHeaderLayer;\n\nlet app = Router::new().merge(routes).layer(\n    ServiceBuilder::new()\n        .layer(SetResponseHeaderLayer::overriding(\n            header::STRICT_TRANSPORT_SECURITY,\n            HeaderValue::from_static(\"max-age=63072000; includeSubDomains; preload\"),\n        ))\n        .layer(SetResponseHeaderLayer::overriding(\n            header::X_CONTENT_TYPE_OPTIONS,\n            HeaderValue::from_static(\"nosniff\"),\n        ))\n        .layer(SetResponseHeaderLayer::overriding(\n            header::X_FRAME_OPTIONS,\n            HeaderValue::from_static(\"DENY\"),\n        )),\n);"
      },
      {
        "name": "zeroize secrets",
        "code": "use zeroize::{Zeroize, Zeroizing};\n\n// Wiped on drop; Debug output is redacted by the wrapper.\nlet api_key: Zeroizing<String> = Zeroizing::new(std::env::var(\"PAYMENTS_API_KEY\")?);\n\n#[derive(Debug)]\nstruct SessionKey(String);\n\nimpl Drop for SessionKey {\n    fn drop(&mut self) {\n        self.0.zeroize();\n    }\n}"
      }
    ]
  },
  {
    "title": "Rust fundamentals",
    "items": [
      {
        "name": "immutable by default",
        "code": "let answer = 42;\nlet mut counter = 0;\ncounter += 1;"
      },
      {
        "name": "ownership move vs borrow",
        "code": "let owned = String::from(\"hi\");\nlet moved = owned;           // owned is invalid now\nlet borrowed: &str = &moved;  // borrow instead of moving"
      },
      {
        "name": "iterators",
        "code": "let total: i32 = (1..=5)\n    .filter(|n| n % 2 == 0)\n    .map(|n| n * n)\n    .sum();"
      },
      {
        "name": "Result with ?",
        "code": "fn parse(s: &str) -> Result<i32, std::num::ParseIntError> {\n    let n: i32 = s.parse()?;\n    Ok(n * 2)\n}"
      },
      {
        "name": "match and Option",
        "code": "match map.get(\"key\") {\n    Some(value) => println!(\"{}\", value),\n    None => println!(\"missing\"),\n}"
      },
      {
        "name": "derive common traits",
        "code": "#[derive(Debug, Clone, PartialEq, Eq)]\nstruct User { id: u64, name: String }"
      }
    ]
  },
  {
    "title": "Rust in depth",
    "items": [
      {
        "name": "declarative macro",
        "code": "macro_rules! map_of {\n    ($($k:expr => $v:expr),+ $(,)?) => {{\n        let mut map = std::collections::HashMap::new();\n        $( map.insert($k, $v); )+\n        map\n    }};\n}"
      },
      {
        "name": "unsafe with a safety comment",
        "code": "// SAFETY: index is checked against slice.len() above.\nlet value = unsafe { *slice.as_ptr().add(index) };"
      },
      {
        "name": "const generics",
        "code": "fn zeros<const N: usize>() -> [f64; N] {\n    [0.0; N]\n}"
      },
      {
        "name": "GAT (lending iterator)",
        "code": "trait Lend {\n    type Item<'a> where Self: 'a;\n    fn next(&mut self) -> Option<Self::Item<'_>>;\n}"
      },
      {
        "name": "feature gate",
        "code": "#[cfg(feature = \"serde\")]\nimpl serde::Serialize for Config { /* ... */ }"
      },
      {
        "name": "type state",
        "code": "struct Draft;\nstruct Published;\nstruct Post<State> { body: String, _state: std::marker::PhantomData<State> }"
      }
    ]
  },
  {
    "title": "Data structures",
    "items": [
      {
        "name": "VecDeque as queue",
        "code": "use std::collections::VecDeque;\nlet mut q = VecDeque::with_capacity(8);\nq.push_back(1);\nq.push_front(0);\nassert_eq!(q.pop_front(), Some(0));"
      },
      {
        "name": "SmallVec inline storage",
        "code": "use smallvec::SmallVec;\nlet mut v: SmallVec<[u8; 16]> = SmallVec::new();\nv.push(1);  // no heap allocation until 17 bytes"
      },
      {
        "name": "Bytes zero-copy slice",
        "code": "use bytes::Bytes;\nlet buf = Bytes::from_static(b\"hello world\");\nlet word = buf.slice(0..5);  // shares the allocation"
      },
      {
        "name": "binary heap",
        "code": "use std::collections::BinaryHeap;\nlet mut heap = BinaryHeap::new();\nheap.push(3);\nheap.push(1);\nassert_eq!(heap.pop(), Some(3));"
      },
      {
        "name": "hashbrown reserve",
        "code": "use hashbrown::HashMap;\nlet mut map: HashMap<&str, u32> = HashMap::with_capacity(64);\nmap.reserve(128);"
      },
      {
        "name": "roaring bitmap",
        "code": "use roaring::RoaringBitmap;\nlet mut ids = RoaringBitmap::new();\nids.insert(42);\nassert!(ids.contains(42));"
      }
    ]
  },
  {
    "title": "Database internals",
    "items": [
      {
        "name": "keyset pagination",
        "code": "SELECT id, created_at\nFROM orders\nWHERE (created_at, id) < ($1, $2)\nORDER BY created_at DESC, id DESC\nLIMIT 50;"
      },
      {
        "name": "explain with buffers",
        "code": "EXPLAIN (ANALYZE, BUFFERS)\nSELECT * FROM orders WHERE tenant_id = $1;"
      },
      {
        "name": "covering index",
        "code": "CREATE INDEX CONCURRENTLY idx_orders_tenant_created\nON orders (tenant_id, created_at DESC, id DESC)\nINCLUDE (status);"
      },
      {
        "name": "advisory lock",
        "code": "SELECT pg_try_advisory_xact_lock(42);"
      },
      {
        "name": "repeatable read",
        "code": "BEGIN ISOLATION LEVEL REPEATABLE READ;\n-- snapshot is fixed for the whole transaction\nCOMMIT;"
      },
      {
        "name": "range partition",
        "code": "CREATE TABLE events_2026 PARTITION OF events\nFOR VALUES FROM ('2026-01-01') TO ('2027-01-01');"
      }
    ]
  },
  {
    "title": "Distributed systems",
    "items": [
      {
        "name": "fenced lease claim",
        "code": "UPDATE jobs\nSET owner = $1, fence = fence + 1, lease_until = now() + interval '30 seconds'\nWHERE id = $2 AND (lease_until < now() OR owner = $1)\nRETURNING fence;"
      },
      {
        "name": "transactional outbox",
        "code": "WITH inserted AS (\n    INSERT INTO orders (id, total) VALUES ($1, $2) RETURNING id\n)\nINSERT INTO outbox (id, topic, payload)\nSELECT gen_random_uuid(), 'orders', to_jsonb(inserted) FROM inserted;"
      },
      {
        "name": "idempotency key",
        "code": "INSERT INTO idempotency (key, request_hash)\nVALUES ($1, $2)\nON CONFLICT (key) DO NOTHING\nRETURNING key;"
      },
      {
        "name": "vector-clock merge",
        "code": "fn merge(a: &mut HashMap<String, u64>, b: &HashMap<String, u64>) {\n    for (node, counter) in b {\n        let slot = a.entry(node.clone()).or_default();\n        *slot = (*slot).max(*counter);\n    }\n}"
      },
      {
        "name": "reject stale term",
        "code": "if msg.term < self.current_term {\n    return Err(RaftError::StaleTerm);\n}"
      },
      {
        "name": "quorum size",
        "code": "fn quorum(nodes: usize) -> usize {\n    nodes / 2 + 1\n}"
      }
    ]
  },
  {
    "title": "Networking",
    "items": [
      {
        "name": "TCP listener",
        "code": "let listener = tokio::net::TcpListener::bind(\"0.0.0.0:8080\").await?;\nloop {\n    let (socket, peer) = listener.accept().await?;\n    tokio::spawn(handle(socket, peer));\n}"
      },
      {
        "name": "disable Nagle",
        "code": "stream.set_nodelay(true)?;"
      },
      {
        "name": "connect with timeout",
        "code": "let stream = tokio::time::timeout(\n    Duration::from_secs(5),\n    TcpStream::connect(addr),\n).await??;"
      },
      {
        "name": "DNS resolution",
        "code": "let addrs: Vec<SocketAddr> = tokio::net::lookup_host((\"example.com\", 443))\n    .await?\n    .collect();"
      },
      {
        "name": "rustls server config",
        "code": "let config = rustls::ServerConfig::builder()\n    .with_no_client_auth()\n    .with_single_cert(certs, key)?;"
      },
      {
        "name": "HTTP/1.1 headers",
        "code": "GET /v1/orders HTTP/1.1\nHost: api.example.com\nAccept: application/json\nAuthorization: Bearer <token>"
      }
    ]
  },
  {
    "title": "Systems programming",
    "items": [
      {
        "name": "SIGTERM handler",
        "code": "let mut term = tokio::signal::unix::signal(SignalKind::terminate())?;\nterm.recv().await;"
      },
      {
        "name": "mmap a file",
        "code": "use memmap2::Mmap;\nlet file = std::fs::File::open(\"data.bin\")?;\nlet map = unsafe { Mmap::map(&file)? };"
      },
      {
        "name": "process limit (cgroup v2)",
        "code": "std::fs::write(\"/sys/fs/cgroup/demo/pids.max\", \"64\")?;\nstd::fs::write(\"/sys/fs/cgroup/demo/memory.max\", \"268435456\")?;"
      },
      {
        "name": "fork via nix",
        "code": "use nix::unistd::{fork, ForkResult};\nmatch unsafe { fork() }? {\n    ForkResult::Child => { /* child */ }\n    ForkResult::Parent { child } => { /* parent */ }\n}"
      },
      {
        "name": "unix socket",
        "code": "let listener = tokio::net::UnixListener::bind(\"/tmp/app.sock\")?;\nlet (stream, _addr) = listener.accept().await?;"
      },
      {
        "name": "eBPF program load (aya)",
        "code": "let mut bpf = aya::Bpf::load(aya::include_bytes_aligned!(concat!(env!(\"OUT_DIR\"), \"/bpf\")))?;"
      }
    ]
  },
  {
    "title": "Architecture",
    "items": [
      {
        "name": "hexagonal port",
        "code": "#[async_trait::async_trait]\npub trait OrderRepository: Send + Sync {\n    async fn save(&self, order: &Order) -> anyhow::Result<()>;\n}"
      },
      {
        "name": "CQRS read model",
        "code": "pub struct OrderView {\n    pub id: uuid::Uuid,\n    pub status: String,\n    pub total_cents: i64,\n}"
      },
      {
        "name": "domain event",
        "code": "pub enum OrderEvent {\n    Placed { id: uuid::Uuid },\n    Cancelled { id: uuid::Uuid, reason: String },\n}"
      },
      {
        "name": "newtype identifier",
        "code": "#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]\npub struct TenantId(pub uuid::Uuid);"
      },
      {
        "name": "use case function",
        "code": "pub async fn place_order(\n    repo: &impl OrderRepository,\n    cmd: PlaceOrder,\n) -> anyhow::Result<uuid::Uuid> { /* ... */ }"
      },
      {
        "name": "idempotent command",
        "code": "let inserted = repo\n    .insert_idempotent(&cmd.key, &cmd.hash)\n    .await?;\nif !inserted { return repo.find_by_key(&cmd.key).await; }"
      }
    ]
  },
  {
    "title": "API design",
    "items": [
      {
        "name": "cursor pagination",
        "code": "GET /v1/orders?limit=50&after=eyJpZCI6MTIzfQ\n\n{\n  \"items\": [],\n  \"next_cursor\": \"eyJpZCI6MTczfQ\"\n}"
      },
      {
        "name": "problem+json error",
        "code": "HTTP/1.1 409 Conflict\nContent-Type: application/problem+json\n\n{\n  \"type\": \"https://example.com/errors/conflict\",\n  \"title\": \"Conflict\",\n  \"status\": 409,\n  \"detail\": \"Order already shipped\"\n}"
      },
      {
        "name": "idempotency key",
        "code": "POST /v1/payments HTTP/1.1\nIdempotency-Key: 9f1c2b7e-4a3d-4c1e-9b0a-2f6d8e5c1a77"
      },
      {
        "name": "media type versioning",
        "code": "Accept: application/vnd.acme.v2+json"
      },
      {
        "name": "conditional GET",
        "code": "GET /v1/orders/42 HTTP/1.1\nIf-None-Match: \"etag-abc\"\n\nHTTP/1.1 304 Not Modified"
      },
      {
        "name": "rate limited",
        "code": "HTTP/1.1 429 Too Many Requests\nRetry-After: 30\nX-RateLimit-Remaining: 0"
      }
    ]
  },
  {
    "title": "Performance engineering",
    "items": [
      {
        "name": "criterion benchmark",
        "code": "use criterion::{black_box, criterion_group, criterion_main, Criterion};\n\nfn bench(c: &mut Criterion) {\n    c.bench_function(\"parse\", |b| b.iter(|| parse(black_box(input))));\n}\ncriterion_group!(benches, bench);\ncriterion_main!(benches);"
      },
      {
        "name": "flamegraph",
        "code": "cargo install flamegraph\ncargo flamegraph --bin api -- --port 8080"
      },
      {
        "name": "pprof guard",
        "code": "let guard = pprof::ProfilerGuard::new(100)?;\n// ... run workload ...\nlet report = guard.report().build()?;"
      },
      {
        "name": "load test with oha",
        "code": "oha -z 30s -c 50 --latency http://127.0.0.1:8080/health"
      },
      {
        "name": "release profile",
        "code": "[profile.release]\nlto = \"thin\"\ncodegen-units = 1\nstrip = true"
      },
      {
        "name": "global allocator",
        "code": "#[global_allocator]\nstatic GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;"
      }
    ]
  },
  {
    "title": "Concurrency patterns",
    "items": [
      {
        "name": "scoped threads",
        "code": "std::thread::scope(|scope| {\n    scope.spawn(|| work(\"a\"));\n    scope.spawn(|| work(\"b\"));\n});  // joins automatically"
      },
      {
        "name": "bounded mpsc",
        "code": "let (tx, mut rx) = tokio::sync::mpsc::channel::<Job>(256);\nwhile let Some(job) = rx.recv().await {\n    process(job).await;\n}"
      },
      {
        "name": "select with cancellation",
        "code": "tokio::select! {\n    _ = token.cancelled() => break,\n    Some(job) = rx.recv() => process(job).await,\n}"
      },
      {
        "name": "atomic counter",
        "code": "use std::sync::atomic::{AtomicU64, Ordering};\nstatic REQUESTS: AtomicU64 = AtomicU64::new(0);\nREQUESTS.fetch_add(1, Ordering::Relaxed);"
      },
      {
        "name": "semaphore backpressure",
        "code": "let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(32));\nlet permit = sem.clone().acquire_owned().await?;\n// permit is released on drop"
      },
      {
        "name": "loom model check",
        "code": "loom::model(|| {\n    let flag = loom::sync::atomic::AtomicBool::new(false);\n    // exercise the concurrent algorithm\n});"
      }
    ]
  },
  {
    "title": "Design principles",
    "items": [
      {
        "name": "parse, don’t validate",
        "code": "pub struct Email(String);\n\nimpl TryFrom<String> for Email {\n    type Error = InvalidEmail;\n    fn try_from(value: String) -> Result<Self, Self::Error> {\n        if value.contains('@') { Ok(Email(value)) } else { Err(InvalidEmail) }\n    }\n}"
      },
      {
        "name": "make illegal states unrepresentable",
        "code": "enum Connection {\n    Disconnected,\n    Connecting { attempt: u8 },\n    Ready { stream: TcpStream },\n}"
      },
      {
        "name": "accept abstractions, return concretes",
        "code": "fn total(prices: impl IntoIterator<Item = u64>) -> u64 {\n    prices.into_iter().sum()\n}"
      },
      {
        "name": "small trait, explicit errors",
        "code": "pub trait Clock {\n    fn now(&self) -> std::time::Instant;\n}"
      },
      {
        "name": "composition over inheritance",
        "code": "struct Service {\n    repo: Arc<dyn OrderRepository>,\n    clock: Arc<dyn Clock>,\n}"
      },
      {
        "name": "document invariants",
        "code": "/// # Panics\n/// Panics if `capacity` is zero.\npub fn new(capacity: usize) -> Self { assert!(capacity > 0); /* ... */ }"
      }
    ]
  },
  {
    "title": "Debugging & troubleshooting",
    "items": [
      {
        "name": "backtrace everywhere",
        "code": "RUST_BACKTRACE=full RUST_LIB_BACKTRACE=1 ./target/debug/api"
      },
      {
        "name": "gdb session",
        "code": "rust-gdb --args target/debug/api --port 8080\n(gdb) break handlers::create_order\n(gdb) run"
      },
      {
        "name": "bisect a regression",
        "code": "git bisect start\ngit bisect bad\ngit bisect good v1.4.0\n# git bisect run cargo test --quiet"
      },
      {
        "name": "instrument an async fn",
        "code": "#[tracing::instrument(skip(pool))]\nasync fn create_order(pool: &PgPool, input: NewOrder) -> Result<Order> {\n    // ...\n}"
      },
      {
        "name": "core dump",
        "code": "ulimit -c unlimited\n# reproduce the crash, then:\ncoredumpctl gdb ./target/debug/api"
      },
      {
        "name": "log with spans",
        "code": "let span = tracing::info_span!(\"job\", id = %job.id);\nlet _guard = span.enter();"
      }
    ]
  },
  {
    "title": "Compilers",
    "items": [
      {
        "name": "expand macros",
        "code": "cargo install cargo-expand\ncargo expand --bin api handlers::create"
      },
      {
        "name": "dump MIR (nightly)",
        "code": "rustc -Zunpretty=mir src/main.rs 2>&1 | less"
      },
      {
        "name": "dump HIR (nightly)",
        "code": "rustc -Zunpretty=hir-tree src/main.rs 2>&1 | less"
      },
      {
        "name": "clippy with deny",
        "code": "cargo clippy --all-targets -- -D warnings"
      },
      {
        "name": "cross target",
        "code": "rustup target add x86_64-unknown-linux-musl\ncargo build --release --target x86_64-unknown-linux-musl"
      },
      {
        "name": "compile timings",
        "code": "cargo build --timings\n# writes target/cargo-timings/cargo-timing.html"
      }
    ]
  },
  {
    "title": "Interview prep",
    "items": [
      {
        "name": "ownership: move, borrow, mutate",
        "code": "fn takes(v: Vec<u8>) {}            // moved in, dropped here\nfn borrow(v: &Vec<u8>) {}          // caller keeps ownership\nfn borrow_mut(v: &mut Vec<u8>) {}  // exclusive for the call\n\nlet mut v = vec![1, 2, 3];\nborrow(&v);\nborrow_mut(&mut v);\ntakes(v);                          // v is gone after this line: E0382"
      },
      {
        "name": "lifetimes: what the return borrows",
        "code": "struct Parser { input: String }\n\nimpl Parser {\n    // The returned &str borrows self, not a temporary from split().\n    fn first_word(&self) -> &str {\n        self.input.split_whitespace().next().unwrap_or(\"\")\n    }\n}\n\n// Returning a slice of a local String instead is E0515."
      },
      {
        "name": "complexity cheat lines",
        "code": "// Vec::push             amortized O(1)    | Vec::insert          O(n)\n// HashMap::get          O(1) expected      | BTreeMap::get        O(log n)\n// BinaryHeap::push      O(log n)           | sort_unstable        O(n log n)\n// VecDeque::pop_front   O(1)               | Vec::remove(0)        O(n)\n// Arc::clone            O(1) atomic        | Mutex::lock          O(1) uncontended"
      },
      {
        "name": "system design: rate limiter at 50k rps",
        "code": "// - one Redis round trip on the hot path; Lua makes INCR + PEXPIRE atomic\n// - key = tenant:route; limit and burst live in config, not in code\n// - local token bucket absorbs Redis latency for low-risk routes\n// - decide fail-open vs fail-closed per route, and record the choice\n// - measure 429 rate, added p99, and Redis error rate per tenant"
      },
      {
        "name": "concurrency: Send vs Sync",
        "code": "fn assert_send<T: Send>() {}\nfn assert_sync<T: Sync>() {}\n\nassert_send::<std::sync::Arc<std::sync::Mutex<Vec<u8>>>>();\nassert_sync::<std::sync::Arc<std::sync::Mutex<Vec<u8>>>>();\n\n// Rc<T>: neither. Cell<T>: Send, not Sync. Mutex<T>: Sync when T: Send."
      },
      {
        "name": "debugging: p99 regression script",
        "code": "// p99 up, throughput flat, one core pegged:\n// 1. per-core CPU and run-queue depth, not total CPU\n// 2. task poll/busy time before reading any source\n// 3. bisect by reverting one change at a time\n// 4. add a CI p99 budget so the class of bug fails a gate next time"
      }
    ]
  },
  {
    "title": "Engineering craft",
    "items": [
      {
        "name": "code review checklist",
        "code": "// [blocking] invariant: what breaks if this is wrong? is it in the type?\n// [blocking] authority: who can construct it? is the field private?\n// [blocking] failure: what does the caller do with every error variant?\n// [blocking] rollback: can this deploy be undone without data loss?\n// [question]  why this cache, key, or timeout, and what invalidates it?\n// [nit]       naming and formatting: rustfmt and clippy already review it"
      },
      {
        "name": "ADR skeleton",
        "code": "# 0012 Use an outbox for cross-context events\n\n## Status\nProposed 2026-11-05\n\n## Context\nOrder commits must publish an event even when the broker is down.\n\n## Decision\nWrite the event to an outbox row in the same transaction; a relay publishes it.\n\n## Alternatives\n- Publish inline: rejected, broker downtime fails checkout.\n- CDC only: rejected, no schema-level ordering guarantee.\n\n## Consequences\n- Good: no dual-write window.\n- Bad: one more table and a relay to supervise.\n\n## Revisit if\nThe broker exposes a transactional publish API we can adopt."
      },
      {
        "name": "incident timeline template",
        "code": "// 14:02 alert: checkout p99 > 2s, burn rate 14x over 5m\n// 14:04 incident commander named; status page updated\n// 14:09 hypothesis: connection pool exhausted after the 14:00 deploy\n// 14:16 mitigation: roll back the deploy; pool saturation clears\n// 14:31 error rate back under SLO; keep watching for 30m\n// 15:10 postmortem owner named; action items filed with dates"
      },
      {
        "name": "estimation heuristics",
        "code": "// 1 engineer-day = 4 focused hours after meetings and review\n// double the estimate for work that crosses a service boundary\n// add one week per new external dependency, not per API call\n// give a range (best / likely / worst), never a single date\n// a migration touching two datastores is two projects, not one\n// unknown unknowns: add 30% and name the assumption in the plan"
      },
      {
        "name": "review comment that can be acted on",
        "code": "// [blocking] withdraw returns bool, so the caller cannot tell\n// \"insufficient funds\" from \"limit exceeded\". Return\n// Result<i64, WithdrawError> with one variant per reason, so the\n// match at the call site proves the failure was handled."
      }
    ]
  },
  {
    "title": "Projects",
    "items": [
      {
        "name": "project skeleton commands",
        "code": "cargo new --lib crates/core\ncargo new --lib crates/api\ncargo new --bin apps/server\ncargo add --package api axum tokio --features tokio/full\ncargo test --workspace\ncargo clippy --workspace --all-targets -- -D warnings"
      },
      {
        "name": "acceptance criteria template",
        "code": "- [ ] Given <input>, when <action>, then <observable result>\n- [ ] Failure path returns the documented error and status code\n- [ ] p99 stays under the budget at 2x expected peak\n- [ ] No new secret, unbounded queue, or blocking call on the runtime\n- [ ] Rollback is one command and does not lose committed data"
      },
      {
        "name": "benchmark harness (criterion)",
        "code": "use criterion::{black_box, criterion_group, criterion_main, Criterion};\n\nfn bench_parse(c: &mut Criterion) {\n    let input = std::fs::read_to_string(\"fixtures/sample.json\").unwrap();\n    c.bench_function(\"parse/sample\", |b| b.iter(|| parse(black_box(&input))));\n}\n\ncriterion_group!(benches, bench_parse);\ncriterion_main!(benches);"
      },
      {
        "name": "deployment checklist",
        "code": "# build once, deploy the same digest everywhere\ndocker build --platform linux/amd64 -t api:$GIT_SHA .\ndocker push registry.example.com/api:$GIT_SHA\n\n# canary 5% for 10m, then 50%, then 100%\nkubectl set image deploy/api api=registry.example.com/api:$GIT_SHA\nkubectl rollout status deploy/api --timeout=5m\nkubectl rollout undo deploy/api"
      },
      {
        "name": "load test with a budget",
        "code": "oha -z 60s -c 50 --latency http://127.0.0.1:8080/health\n\n# pass only when p99 < 300 ms and the error rate is < 0.1%\n# compare against the previous release, not against zero load\n# keep the command in the repo so the budget is reproducible"
      },
      {
        "name": "CI acceptance gate",
        "code": "# .github/workflows/ci.yml (excerpt)\n- run: cargo fmt --check\n- run: cargo clippy --workspace --all-targets -- -D warnings\n- run: cargo test --workspace --locked\n- run: cargo deny check advisories bans licenses sources\n- run: cargo bench --no-run   # benches must at least compile"
      }
    ]
  }
];

export const BLUEPRINTS = [
  {
    "id": "tenant-saas-api",
    "title": "Multi-tenant SaaS API",
    "level": "industry",
    "summary": "One axum service serves many tenants. A JWT access token carries the tenant claim, every query filters by tenant_id, Redis caches per-tenant lookups, and a bounded Postgres pool is the backpressure valve. The blueprint shows exactly where tenancy must be enforced so one customer can never read another customer's rows.",
    "stack": [
      "axum",
      "tower-http",
      "sqlx",
      "redis",
      "jsonwebtoken",
      "tokio"
    ],
    "flow": [
      "1. The edge terminates TLS and forwards the Authorization header; tower-http traces the request and applies a request timeout.",
      "2. An extractor verifies the JWT, rejects expired or wrong-audience tokens, and places tenant_id and user_id into request extensions.",
      "3. Handlers get the PgPool and a tenant-scoped repository; every SQL statement binds tenant_id from the token, never from the body or path.",
      "4. Reads check Redis under a tenant-prefixed key; writes invalidate that key only after the transaction commits.",
      "5. The pool (max_connections + acquire_timeout) limits concurrency; a fast 503 is better than an unbounded queue when the database is saturated.",
      "6. /healthz reports process liveness; /readyz checks Postgres and Redis before the pod is added to the load balancer."
    ],
    "components": [
      {
        "name": "API edge",
        "role": "routing, extractors, middleware, graceful shutdown",
        "crates": [
          "axum",
          "tower-http",
          "tokio"
        ]
      },
      {
        "name": "Auth",
        "role": "password hashing, JWT issue and verification, tenant claims",
        "crates": [
          "argon2",
          "jsonwebtoken"
        ]
      },
      {
        "name": "Persistence",
        "role": "tenant-scoped repositories, transactions, migrations",
        "crates": [
          "sqlx"
        ]
      },
      {
        "name": "Cache",
        "role": "per-tenant read cache with explicit TTLs",
        "crates": [
          "redis"
        ]
      }
    ],
    "checklist": [
      "tenant_id comes from the verified token claim, never from a path parameter or request body alone.",
      "Every tenant-owned table has tenant_id in its primary lookup index, and repository tests cover cross-tenant access.",
      "JWT keys rotate, access tokens are short-lived (minutes), and refresh tokens can be revoked.",
      "Pool size, acquire_timeout, statement timeouts and per-tenant rate limits are configured and load-tested.",
      "Integration tests hit the router as two tenants and assert that cross-tenant reads return 404 with no data."
    ],
    "lessons": [
      "w01",
      "w02",
      "w05",
      "d01",
      "d04"
    ],
    "resources": [
      {
        "title": "axum crate documentation",
        "url": "https://docs.rs/axum/latest/axum/",
        "kind": "docs"
      },
      {
        "title": "SQLx 0.8 documentation",
        "url": "https://docs.rs/sqlx/0.8/sqlx/",
        "kind": "docs"
      },
      {
        "title": "redis-rs crate documentation",
        "url": "https://docs.rs/redis/latest/redis/",
        "kind": "docs"
      }
    ]
  },
  {
    "id": "event-driven-orders",
    "title": "Event-driven order service (Kafka + outbox)",
    "level": "industry",
    "summary": "Orders are committed to Postgres together with an outbox row in a single transaction. A relay publishes outbox rows to Kafka with an idempotent, keyed producer. Consumers commit offsets only after their side effect and dedupe by event id, so retries and rebalances never double-charge a customer.",
    "stack": [
      "axum",
      "sqlx",
      "rdkafka",
      "tokio",
      "serde",
      "uuid"
    ],
    "flow": [
      "1. The API writes the order and an outbox row in one Postgres transaction; the HTTP response never waits for the broker.",
      "2. A relay task claims pending outbox rows with SELECT ... FOR UPDATE SKIP LOCKED and publishes them with an idempotent producer.",
      "3. Records are keyed by order_id, so all events for one order land on the same partition and stay ordered.",
      "4. On broker ack the outbox row is marked sent; a crashed relay simply republishes, so consumers dedupe by event id.",
      "5. Consumers run with enable.auto.commit=false, apply the side effect, record the event id in a dedupe table, then commit the offset.",
      "6. A handler that keeps failing is published to a DLQ topic with an error header and its offset is committed, so the partition keeps moving."
    ],
    "components": [
      {
        "name": "Outbox relay",
        "role": "claims and publishes pending rows, marks them sent",
        "crates": [
          "sqlx",
          "rdkafka",
          "tokio"
        ]
      },
      {
        "name": "Consumers",
        "role": "at-least-once processing with dedupe and manual commits",
        "crates": [
          "rdkafka",
          "tokio",
          "serde"
        ]
      },
      {
        "name": "Dedupe store",
        "role": "unique (consumer, event_id) rows that make replays safe",
        "crates": [
          "sqlx"
        ]
      },
      {
        "name": "DLQ",
        "role": "terminal failures parked for inspection and replay",
        "crates": [
          "rdkafka"
        ]
      }
    ],
    "checklist": [
      "The outbox row and the business write share one transaction; the relay is the only Kafka producer on the write path.",
      "Consumers are provably idempotent: replay the same event twice in a test and assert a single side effect.",
      "enable.idempotence=true, acks=all and a bounded message.timeout.ms are set on every producer.",
      "Consumer lag, relay backlog and DLQ depth are metrics with alerts; nothing fails silently.",
      "Offsets are committed only after the side effect, and shutdown/rebalance flushes in-flight work first."
    ],
    "lessons": [
      "s03",
      "s05",
      "s07",
      "d07",
      "p02"
    ],
    "resources": [
      {
        "title": "rdkafka (rust-rdkafka) documentation",
        "url": "https://docs.rs/rdkafka/latest/rdkafka/",
        "kind": "docs"
      },
      {
        "title": "Apache Kafka introduction and concepts",
        "url": "https://kafka.apache.org/intro/",
        "kind": "docs"
      }
    ]
  },
  {
    "id": "realtime-gateway",
    "title": "Realtime gateway (WebSockets + broadcast)",
    "level": "industry",
    "summary": "A dedicated WebSocket tier holds long-lived connections and fans out live updates. In-process fan-out uses a tokio broadcast channel with an explicit lag policy; cross-replica fan-out goes through Redis pub/sub. Slow clients are dropped, not buffered forever, and shutdown closes sockets cleanly.",
    "stack": [
      "axum",
      "tokio",
      "tokio-util",
      "redis",
      "jsonwebtoken",
      "serde_json"
    ],
    "flow": [
      "1. A client upgrades GET /ws with a JWT; axum WebSocketUpgrade hands the socket to a dedicated connection task.",
      "2. The task subscribes to a tokio::sync::broadcast channel for its tenant; a receiver that falls behind gets RecvError::Lagged and is disconnected.",
      "3. Each replica keeps a local broadcast sender per channel, so in-process publishers fan out without any network hop.",
      "4. A Redis subscription bridges cross-replica messages into the local broadcast; keys are namespaced by tenant and channel.",
      "5. Heartbeats and a per-connection write timeout evict dead sockets; a CancellationToken closes every socket on shutdown.",
      "6. Presence and typing events stay best-effort; durable state lives in Postgres, not in the socket tier."
    ],
    "components": [
      {
        "name": "Gateway",
        "role": "upgrade, auth, per-connection task, heartbeats",
        "crates": [
          "axum",
          "tokio",
          "tokio-util"
        ]
      },
      {
        "name": "Fan-out",
        "role": "local broadcast per tenant channel with bounded buffers",
        "crates": [
          "tokio"
        ]
      },
      {
        "name": "Backplane",
        "role": "cross-replica pub/sub bridge",
        "crates": [
          "redis"
        ]
      },
      {
        "name": "Auth",
        "role": "token validation before upgrade and expiry enforcement",
        "crates": [
          "jsonwebtoken"
        ]
      }
    ],
    "checklist": [
      "Every channel is bounded and Lagged is handled explicitly; an unbounded queue is a memory leak with a schedule.",
      "Concurrent connections per pod are capped and the proxy sheds load before the process runs out of memory.",
      "Auth happens before the upgrade, and connections are closed when the token reaches expiry.",
      "Shutdown cancels the token, sends close frames, and drains connections inside the grace period.",
      "A load test with deliberately slow consumers keeps the process under its memory limit."
    ],
    "lessons": [
      "w06",
      "w05",
      "d04",
      "p02",
      "l18"
    ],
    "resources": [
      {
        "title": "axum WebSocket module",
        "url": "https://docs.rs/axum/latest/axum/extract/ws/",
        "kind": "docs"
      },
      {
        "title": "tokio::sync::broadcast (lag semantics)",
        "url": "https://docs.rs/tokio/latest/tokio/sync/broadcast/index.html",
        "kind": "docs"
      },
      {
        "title": "redis-rs pub/sub and RESP3",
        "url": "https://docs.rs/redis/latest/redis/",
        "kind": "docs"
      }
    ]
  },
  {
    "id": "grpc-service-mesh",
    "title": "gRPC service mesh (tonic + health + deadlines)",
    "level": "industry",
    "summary": "Internal services talk gRPC over HTTP/2 with tonic. Protos are compiled in build.rs, every server exposes the standard health service, every call carries a deadline, metadata propagates auth and trace context, and Kubernetes probes drive rollout decisions from real readiness.",
    "stack": [
      "tonic",
      "tonic-health",
      "prost",
      "tokio",
      "tracing",
      "tower"
    ],
    "flow": [
      "1. Protos live in a shared location and tonic-prost-build generates client and server stubs in build.rs for each service.",
      "2. Each service registers grpc.health.v1 and reports NOT_SERVING before it stops accepting work during shutdown.",
      "3. Clients dial with connect_timeout and set a per-call timeout, so the deadline travels with the request into downstream calls.",
      "4. Interceptors attach auth metadata and the current trace context; servers map domain errors onto tonic Status codes.",
      "5. Retries are limited to idempotent methods with a bounded policy; a deadline-exceeded storm is not retried blindly.",
      "6. Kubernetes probes call the health service and rolling updates rely on serve_with_shutdown for a clean drain."
    ],
    "components": [
      {
        "name": "Codegen",
        "role": "proto compilation in build.rs for clients and servers",
        "crates": [
          "tonic-prost-build",
          "prost"
        ]
      },
      {
        "name": "Servers",
        "role": "service impls, health reporting, graceful stop",
        "crates": [
          "tonic",
          "tonic-health",
          "tokio"
        ]
      },
      {
        "name": "Clients",
        "role": "channels, deadlines, metadata interceptors",
        "crates": [
          "tonic",
          "tower"
        ]
      },
      {
        "name": "Telemetry",
        "role": "spans per RPC, propagation to the collector",
        "crates": [
          "tracing",
          "tracing-opentelemetry",
          "opentelemetry-otlp"
        ]
      }
    ],
    "checklist": [
      "Every RPC has a deadline and a max message size; oversized requests fail with RESOURCE_EXHAUSTED.",
      "Domain errors map to the right Status code (NOT_FOUND, INVALID_ARGUMENT, UNAVAILABLE) and never leak internal strings.",
      "Health reflects real readiness (pool, downstreams), not merely that the process is running.",
      "Trace context and request metadata propagate through every hop, with a configured sampling rate per environment.",
      "Graceful shutdown flips health first, waits for in-flight RPCs, then stops the server."
    ],
    "lessons": [
      "s02",
      "s01",
      "g01",
      "l12"
    ],
    "resources": [
      {
        "title": "tonic crate documentation",
        "url": "https://docs.rs/tonic/latest/tonic/",
        "kind": "docs"
      },
      {
        "title": "gRPC health checking guide",
        "url": "https://grpc.io/docs/guides/health-checking/",
        "kind": "docs"
      }
    ]
  },
  {
    "id": "batch-etl-worker",
    "title": "Batch ETL worker (bounded pool + object storage)",
    "level": "industry",
    "summary": "A one-shot worker takes a job id, lists input objects from object storage, and streams them through a bounded pool of transforms with CPU work on the blocking pool. Subprocesses are killed on drop and on timeout. Outputs appear at their final keys only after success, and a rerun is safe.",
    "stack": [
      "tokio",
      "aws-sdk-s3",
      "serde_json",
      "clap",
      "tokio-util"
    ],
    "flow": [
      "1. A scheduler or queue message hands the worker a job id; the binary is a one-shot process with a hard deadline and an idempotent job key.",
      "2. The job lists input objects and feeds keys into a bounded channel; the worker-pool size is the concurrency limit.",
      "3. Workers stream each object instead of buffering it, and move CPU-heavy transforms to spawn_blocking.",
      "4. External tools run as subprocesses with kill_on_drop and a timeout, with stderr captured into the failure record.",
      "5. Outputs are written to a temporary key and only moved to the final key after success, so partial files are never visible.",
      "6. The job records per-item outcomes, retries only failed items, and emits a summary metric plus a report artifact."
    ],
    "components": [
      {
        "name": "Orchestrator",
        "role": "job parsing, deadline, bounded dispatch, progress",
        "crates": [
          "tokio",
          "clap"
        ]
      },
      {
        "name": "Storage",
        "role": "streamed reads/writes, temp key + atomic move",
        "crates": [
          "aws-sdk-s3"
        ]
      },
      {
        "name": "Transform",
        "role": "pure transforms, subprocess adapters",
        "crates": [
          "tokio",
          "serde_json"
        ]
      },
      {
        "name": "Checkpoint",
        "role": "per-item status so reruns skip completed work",
        "crates": [
          "sqlx"
        ]
      }
    ],
    "checklist": [
      "The job is idempotent and resumable: a rerun produces identical outputs and skips completed items.",
      "Memory is bounded by streaming and channel capacity, not by dataset size; verify against a large fixture.",
      "Subprocesses cannot outlive the worker, and non-zero exit codes fail the item with captured stderr.",
      "Partial output is never published: temp key plus atomic move, or a completion manifest.",
      "Poison items go to a dead-letter path with a reason instead of failing the whole batch."
    ],
    "lessons": [
      "p01",
      "p03",
      "d06",
      "p07"
    ],
    "resources": [
      {
        "title": "tokio asynchronous runtime documentation",
        "url": "https://docs.rs/tokio/latest/tokio/",
        "kind": "docs"
      },
      {
        "title": "AWS SDK for Rust: S3 client",
        "url": "https://docs.rs/aws-sdk-s3/latest/aws_sdk_s3/",
        "kind": "docs"
      }
    ]
  },
  {
    "id": "job-scheduler-supervisor",
    "title": "Job scheduler & supervisor (leader election)",
    "level": "industry",
    "summary": "Cron-style jobs run under a supervisor with one owner. Replicas contend for a fenced lease, only the leader triggers runs, and each run is recorded by (job, scheduled_at) so a duplicate tick cannot double-send. Shutdown stops new claims, cancels in-flight jobs at checkpoints, releases the lease, and exits.",
    "stack": [
      "tokio",
      "tokio-util",
      "sqlx",
      "kube",
      "serde"
    ],
    "flow": [
      "1. Every replica runs the scheduler loop, but only the replica holding a current lease triggers jobs; followers stand by and renew.",
      "2. Leader election uses a Kubernetes Lease or a Postgres advisory lock with a TTL, and the fence token is passed to every job.",
      "3. A supervisor owns one CancellationToken per job and restarts failed runs with capped exponential backoff while recording state.",
      "4. Runs are recorded under a unique (job, scheduled_at) key, so a missed or duplicated trigger cannot double-charge or double-send.",
      "5. On SIGTERM the leader stops claiming new runs, cancels in-flight jobs at safe checkpoints, releases the lease, and exits.",
      "6. Missed schedules after downtime are either explicitly caught up or skipped; the policy is part of the job spec, not an accident."
    ],
    "components": [
      {
        "name": "Scheduler",
        "role": "cron ticks, lease check, run dispatch",
        "crates": [
          "tokio",
          "tokio-cron-scheduler"
        ]
      },
      {
        "name": "Election",
        "role": "fenced leadership with TTL and fast release",
        "crates": [
          "kube",
          "sqlx"
        ]
      },
      {
        "name": "Supervisor",
        "role": "per-job cancellation, backoff, restart policy",
        "crates": [
          "tokio",
          "tokio-util"
        ]
      },
      {
        "name": "Run store",
        "role": "durable run history keyed by job + scheduled time",
        "crates": [
          "sqlx"
        ]
      }
    ],
    "checklist": [
      "Only one replica executes a given scheduled run: the lease or lock is verified before any side effect.",
      "Every job has a timeout, cancellation points, and a max-concurrent-runs rule; one hung job cannot block the tick.",
      "Run history is durable with (job, scheduled_at) uniqueness, retry counts and last error visible on a dashboard.",
      "Leader loss and graceful shutdown both stop new claims before in-flight work is cancelled, and release the lease quickly.",
      "Time assumptions are documented: UTC everywhere, DST-safe cron evaluation, explicit missed-run policy."
    ],
    "lessons": [
      "p05",
      "p04",
      "p02",
      "s08"
    ],
    "resources": [
      {
        "title": "Tokio graceful shutdown guide",
        "url": "https://tokio.rs/tokio/topics/shutdown",
        "kind": "docs"
      },
      {
        "title": "tokio_util CancellationToken",
        "url": "https://docs.rs/tokio-util/latest/tokio_util/sync/struct.CancellationToken.html",
        "kind": "docs"
      }
    ]
  },
  {
    "id": "observability-platform",
    "title": "Observability wiring (tracing + OTLP + metrics)",
    "level": "industry",
    "summary": "Instrument every service once: one tracing subscriber with a JSON log layer and an OpenTelemetry trace layer, OTLP export to a collector, semantic-convention span names, RED/USE metrics, and SLO-based alerts that page on user-visible symptoms instead of CPU spikes.",
    "stack": [
      "tracing",
      "tracing-subscriber",
      "tracing-opentelemetry",
      "opentelemetry-otlp",
      "axum",
      "tokio"
    ],
    "flow": [
      "1. Initialize one tracing subscriber with an EnvFilter, a JSON fmt layer for logs, and an OpenTelemetry layer for traces.",
      "2. Export traces and metrics over OTLP to the collector; the app knows only the endpoint and its resource attributes.",
      "3. Span names follow semantic conventions (HTTP route, RPC method, DB statement), so dashboards work across services.",
      "4. Metrics cover RED (rate, errors, duration) and USE (utilisation, saturation, errors) plus pool and queue depth.",
      "5. Dashboards and alerts are provisioned as code and tied to SLOs, not hand-built per environment.",
      "6. Shutdown flushes the batch span and metric processors before exit so the last seconds of telemetry are not lost."
    ],
    "components": [
      {
        "name": "Instrumentation",
        "role": "spans, events, request metrics in the service",
        "crates": [
          "tracing",
          "tracing-subscriber",
          "tower-http"
        ]
      },
      {
        "name": "Trace export",
        "role": "OTLP gRPC/HTTP span pipeline to the collector",
        "crates": [
          "opentelemetry-otlp",
          "tracing-opentelemetry"
        ]
      },
      {
        "name": "Metric export",
        "role": "periodic OTLP metric reader, resource attributes",
        "crates": [
          "opentelemetry-otlp",
          "opentelemetry"
        ]
      },
      {
        "name": "Service framing",
        "role": "routes, extractors, health endpoints for scrapes",
        "crates": [
          "axum",
          "tower-http"
        ]
      }
    ],
    "checklist": [
      "Trace, metric and log correlation works: the trace id appears in logs and the dashboard links to the trace.",
      "Cardinality is controlled: no user ids, raw paths or other unbounded values in metric attributes.",
      "OTLP export failures never block the request path; batching, retries and bounded queues are configured.",
      "Sampling is deliberate (head or tail), and error requests are always sampled.",
      "Alerts page on SLO burn and user-visible symptoms, not on a single 5xx or a CPU threshold."
    ],
    "lessons": [
      "g01",
      "w04",
      "g08"
    ],
    "resources": [
      {
        "title": "opentelemetry-otlp exporter documentation",
        "url": "https://docs.rs/opentelemetry-otlp/latest/opentelemetry_otlp/",
        "kind": "docs"
      },
      {
        "title": "tracing-opentelemetry layer documentation",
        "url": "https://docs.rs/tracing-opentelemetry/latest/tracing_opentelemetry/",
        "kind": "docs"
      }
    ]
  },
  {
    "id": "zero-downtime-deploy",
    "title": "Zero-downtime deployment (Docker + Kubernetes)",
    "level": "industry",
    "summary": "Ship a static binary in a small image, roll it out with Kubernetes probes that tell the truth, and drain connections on SIGTERM. With maxUnavailable=0, honest readiness and backward-compatible migrations, a deploy drops zero requests and rollback is one tag away.",
    "stack": [
      "axum",
      "tokio",
      "tower-http",
      "serde",
      "sqlx"
    ],
    "flow": [
      "1. CI builds the binary in a multi-stage Docker image, tags it immutably with the commit sha, and scans it before pushing.",
      "2. Kubernetes rolls the Deployment with maxSurge=1 and maxUnavailable=0; new pods must pass startup and readiness before traffic arrives.",
      "3. Readiness reports whether the pool, migrations and caches are usable; liveness is a cheap check that only catches a wedged process.",
      "4. On SIGTERM the app reports not-ready, stops accepting new requests, drains in-flight work, flushes telemetry, and exits 0.",
      "5. A generous terminationGracePeriodSeconds plus a preStop sleep covers the time endpoints take to converge across the cluster.",
      "6. Rollback is redeploying the previous immutable tag; schema changes use expand/contract so both versions can run during the rollout."
    ],
    "components": [
      {
        "name": "HTTP surface",
        "role": "routes, extractors, /healthz and /readyz endpoints",
        "crates": [
          "axum",
          "tower-http"
        ]
      },
      {
        "name": "Shutdown",
        "role": "SIGTERM handling, cancellation, drain, telemetry flush",
        "crates": [
          "tokio",
          "tokio-util"
        ]
      },
      {
        "name": "Dependencies",
        "role": "pool readiness, migrations, dependency health checks",
        "crates": [
          "sqlx",
          "redis"
        ]
      },
      {
        "name": "Release",
        "role": "immutable tags, expand/contract migrations, rollback drill",
        "crates": [
          "sqlx"
        ]
      }
    ],
    "checklist": [
      "Probes are distinct and honest: startup for slow boots, readiness for traffic, liveness only for wedged processes.",
      "A load test during a rolling update shows zero 5xx responses and no connection resets.",
      "Migrations run as a separate job and are backward compatible; new code starts against the old schema.",
      "terminationGracePeriodSeconds exceeds the longest in-flight request plus drain time, and preStop covers endpoint lag.",
      "The previous image tag is still deployable, and the rollback command is documented and rehearsed."
    ],
    "lessons": [
      "g05",
      "g06",
      "g07",
      "p04"
    ],
    "resources": [
      {
        "title": "Kubernetes liveness, readiness and startup probes",
        "url": "https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/",
        "kind": "docs"
      },
      {
        "title": "Docker build best practices",
        "url": "https://docs.docker.com/build/building/best-practices/",
        "kind": "docs"
      },
      {
        "title": "Tokio graceful shutdown guide",
        "url": "https://tokio.rs/tokio/topics/shutdown",
        "kind": "docs"
      }
    ]
  },
  {
    "id": "wasm-edge-dashboard",
    "title": "WASM edge dashboard (Leptos + SSR)",
    "level": "industry",
    "summary": "A Leptos dashboard that ships as WebAssembly but still paints on the first request: axum serves the rendered shell with embedded initial data, and only interactive islands hydrate in the browser. wasm-bindgen provides typed JS boundaries, web-sys covers browser APIs, and CI holds a hard size budget for the wasm entry chunk.",
    "stack": [
      "leptos",
      "wasm-bindgen",
      "web-sys",
      "axum",
      "serde"
    ],
    "flow": [
      "1. axum serves the shell HTML with the initial data embedded as JSON, so the first paint needs no WebAssembly at all.",
      "2. Leptos hydrates the shell in the browser; only interactive islands load their wasm chunks, so static pages stay cheap.",
      "3. wasm-bindgen exports typed functions and structs, and its generated .d.ts gives TypeScript callers real signatures.",
      "4. web-sys covers the browser edge: fetch, WebSocket, localStorage and canvas, each behind a typed wrapper.",
      "5. wasm-pack builds for the chosen target (web or bundler), wasm-opt shrinks the result, and assets are content-hashed and served immutable.",
      "6. Errors and panics are captured by the panic hook and reported to the error endpoint with the release id, not just printed to the console."
    ],
    "components": [
      {
        "name": "UI",
        "role": "components, signals, routing, hydration",
        "crates": [
          "leptos",
          "leptos_router"
        ]
      },
      {
        "name": "JS boundary",
        "role": "typed exports, DOM and browser APIs",
        "crates": [
          "wasm-bindgen",
          "web-sys"
        ]
      },
      {
        "name": "Server",
        "role": "shell HTML, JSON API, static asset serving",
        "crates": [
          "axum",
          "serde"
        ]
      },
      {
        "name": "Build",
        "role": "target selection, size optimisation, hashed assets",
        "crates": [
          "wasm-pack",
          "wasm-bindgen"
        ]
      }
    ],
    "checklist": [
      "The initial HTML renders without wasm, and a hydration failure degrades to a working page instead of a blank screen.",
      "The wasm entry chunk is size-budgeted in CI and the budget is enforced on every PR, not just reviewed by eye.",
      "All JS interop is typed: raw JsValue values never leak into component or business logic.",
      "Panics are captured by console_error_panic_hook and shipped to the error endpoint with the release id.",
      "Assets are content-hashed and cached immutably, while the shell HTML is always revalidated."
    ],
    "lessons": [
      "v01",
      "v02",
      "v03",
      "v05"
    ],
    "resources": [
      {
        "title": "wasm-bindgen crate documentation",
        "url": "https://docs.rs/wasm-bindgen/latest/wasm_bindgen/",
        "kind": "docs"
      },
      {
        "title": "Leptos crate documentation",
        "url": "https://docs.rs/leptos/latest/leptos/",
        "kind": "docs"
      }
    ]
  },
  {
    "id": "ml-inference-service",
    "title": "ML inference service (batching + vector search)",
    "level": "industry",
    "summary": "A model-serving service behind axum: tokenize, coalesce requests into short batches, run one forward pass, and return embeddings or logits. Models load once at startup and warm up before readiness. Embeddings are normalized and searched with exact cosine top-k until recall and latency numbers justify an approximate index.",
    "stack": [
      "axum",
      "candle-core",
      "ort",
      "tokenizers",
      "tokio",
      "serde"
    ],
    "flow": [
      "1. Startup loads the tokenizer and the model once, runs a dummy batch to warm up, and only then reports ready.",
      "2. Requests arrive on axum and are pushed as (input, oneshot) jobs into a bounded channel; each handler awaits its reply.",
      "3. A batcher task drains up to N jobs or waits a few milliseconds, then runs a single forward pass for the whole batch.",
      "4. The tokenizer enforces truncation and a max sequence length before inference, bounding compute per request.",
      "5. Embeddings are normalized and written to the index; queries compute cosine top-k over the searched partition.",
      "6. Backpressure is explicit: a full queue returns 429 with Retry-After, and per-request deadlines cancel work that no longer matters."
    ],
    "components": [
      {
        "name": "API",
        "role": "validation, deadlines, backpressure, streaming responses",
        "crates": [
          "axum",
          "serde",
          "tokio"
        ]
      },
      {
        "name": "Tokenizer",
        "role": "truncation, padding, special tokens",
        "crates": [
          "tokenizers"
        ]
      },
      {
        "name": "Runtime",
        "role": "model loading, batched forward passes",
        "crates": [
          "candle-core",
          "ort"
        ]
      },
      {
        "name": "Index",
        "role": "normalized embeddings, cosine top-k, rebuild path",
        "crates": [
          "candle-core"
        ]
      }
    ],
    "checklist": [
      "Model and tokenizer are versioned artifacts, and every response and span reports the model hash.",
      "Batching is bounded by both max batch size and max wait, and queue depth is a metric with an alert.",
      "Latency is measured per stage (tokenize, queue, infer, search) with per-endpoint p99 budgets.",
      "Inputs are length-capped and validated so one request cannot exhaust memory or the accelerator queue.",
      "The index has a rebuild path and a recall/latency benchmark before exact search is replaced by approximate search."
    ],
    "lessons": [
      "o01",
      "o04",
      "o05"
    ],
    "resources": [
      {
        "title": "candle-core crate documentation",
        "url": "https://docs.rs/candle-core/latest/candle_core/",
        "kind": "docs"
      },
      {
        "title": "ort (ONNX Runtime) crate documentation",
        "url": "https://docs.rs/ort/latest/ort/",
        "kind": "docs"
      },
      {
        "title": "Hugging Face tokenizers crate documentation",
        "url": "https://docs.rs/tokenizers/latest/tokenizers/",
        "kind": "docs"
      }
    ]
  },
  {
    "id": "embedded-telemetry-gateway",
    "title": "Embedded telemetry gateway (firmware to cloud)",
    "level": "industry",
    "summary": "Firmware samples sensors under a real-time executive and sends framed telemetry to a gateway, which validates, dedupes and batches frames before publishing them to the cloud. Rust shares the frame crate between both sides, so the encoder on the device and the decoder in the gateway are the same code under a conformance corpus.",
    "stack": [
      "embedded-hal",
      "embassy-executor",
      "rtic",
      "defmt",
      "tokio",
      "async-nats"
    ],
    "flow": [
      "1. Firmware samples through embedded-hal traits on an interrupt-driven executive (RTIC or Embassy) and timestamps every frame.",
      "2. Frames carry a compact header (device id, sequence, CRC) and are queued in static buffers; the hot path allocates nothing.",
      "3. The radio or serial link transports length-prefixed frames with a CRC; the gateway re-syncs on corruption instead of dropping the stream.",
      "4. The gateway decodes with the same frame crate the firmware uses, validates ranges, and dedupes by (device id, sequence).",
      "5. Valid frames are batched for a short window, then published to NATS or Kafka, or written to object storage; acks flow back to the device.",
      "6. Fleet operations: signed OTA updates with A/B rollback, defmt over RTT in the lab, and device health exported as metrics."
    ],
    "components": [
      {
        "name": "Firmware",
        "role": "sensor sampling, timers, radio driver",
        "crates": [
          "embedded-hal",
          "embassy-executor",
          "rtic"
        ]
      },
      {
        "name": "Wire format",
        "role": "compact frames, CRC, versioning, shared codec",
        "crates": [
          "serde"
        ]
      },
      {
        "name": "Gateway",
        "role": "framing, validation, dedupe, batching",
        "crates": [
          "tokio"
        ]
      },
      {
        "name": "Cloud sink",
        "role": "durable publish, backpressure, device acks",
        "crates": [
          "async-nats"
        ]
      }
    ],
    "checklist": [
      "The hot path allocates nothing, and queue sizes are static so stack and RAM bounds are provable.",
      "Every frame carries a sequence number and CRC; the gateway dedupes and reports gaps instead of silently dropping data.",
      "OTA images and configuration are signed and verified before activation, with an A/B slot and a tested rollback.",
      "Firmware and gateway share the frame crate plus a conformance corpus, so both sides decode identically.",
      "Watchdog and brown-out behaviour are defined: the device reboots into a safe state and never blocks an interrupt."
    ],
    "lessons": [
      "x01",
      "x02",
      "x03",
      "x04"
    ],
    "resources": [
      {
        "title": "embedded-hal 1.0 crate documentation",
        "url": "https://docs.rs/embedded-hal/latest/embedded_hal/",
        "kind": "docs"
      },
      {
        "title": "embassy-executor crate documentation",
        "url": "https://docs.rs/embassy-executor/latest/embassy_executor/",
        "kind": "docs"
      },
      {
        "title": "RTIC real-time framework documentation",
        "url": "https://docs.rs/rtic/latest/rtic/",
        "kind": "docs"
      }
    ]
  },
  {
    "id": "analytics-lakehouse",
    "title": "Analytics lakehouse (CDC to Parquet to Polars)",
    "level": "industry",
    "summary": "CDC events land in an object-store lake as partitioned Parquet, and Rust jobs compact and transform them with Arrow and Polars. Writes are atomic: data is uploaded to a staging key and promoted only after validation. Queries prune partitions and columns, and the same code runs on local disk in tests and object storage in production.",
    "stack": [
      "arrow",
      "parquet",
      "polars",
      "object_store",
      "sqlx",
      "tokio"
    ],
    "flow": [
      "1. A CDC connector reads the Postgres logical replication slot or a Debezium topic and hands change events to the ingestion job.",
      "2. Ingestion dedupes by primary key keeping the highest LSN, validates the schema, and builds Arrow record batches.",
      "3. A Parquet writer lands staging files under date=YYYY-MM-DD/hour=HH with row groups sized for scans; a manifest commits only after the upload.",
      "4. Compaction merges small files per partition and drops superseded keys, keeping file counts and metadata predictable.",
      "5. Transform jobs read with column projection and predicate pushdown, run lazy Polars aggregations, and write the curated zone.",
      "6. Readers query the curated Parquet through Polars or an external engine, with a catalog holding schema versions and partition bounds."
    ],
    "components": [
      {
        "name": "Ingestion",
        "role": "CDC consumption, dedupe by LSN, schema validation",
        "crates": [
          "tokio",
          "serde"
        ]
      },
      {
        "name": "Storage",
        "role": "staging keys, atomic promote, compaction",
        "crates": [
          "object_store",
          "parquet"
        ]
      },
      {
        "name": "Transform",
        "role": "lazy aggregations, joins, schema evolution",
        "crates": [
          "polars",
          "arrow"
        ]
      },
      {
        "name": "Catalog",
        "role": "table metadata, partition bounds, job checkpoints",
        "crates": [
          "sqlx"
        ]
      }
    ],
    "checklist": [
      "Writes are atomic: a file or manifest becomes visible only after validation, never half-written.",
      "Partitioning matches the dominant query filters, and compaction keeps small files and file counts bounded.",
      "Schema evolution is additive and versioned; readers tolerate new nullable columns and unknown fields.",
      "Job checkpoints make reruns idempotent and replayable from a known offset or LSN.",
      "Cost is monitored: bytes scanned per query, files per partition, and alerting on failed or lagging jobs."
    ],
    "lessons": [
      "m01",
      "m02",
      "m03",
      "m05"
    ],
    "resources": [
      {
        "title": "arrow crate documentation",
        "url": "https://docs.rs/arrow/latest/arrow/",
        "kind": "docs"
      },
      {
        "title": "parquet crate documentation",
        "url": "https://docs.rs/parquet/latest/parquet/",
        "kind": "docs"
      },
      {
        "title": "Polars crate documentation",
        "url": "https://docs.rs/polars/latest/polars/",
        "kind": "docs"
      }
    ]
  }
];
