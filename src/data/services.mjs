/**
 * Microservices & messaging track.
 *
 * API versions used across the lessons: tonic 0.14.x (prost codegen lives in
 * tonic-prost-build / tonic-prost), rdkafka 0.39.x, async-nats 0.51.x
 * (jetstream feature), sqlx 0.9.x (postgres + runtime-tokio), tokio 1.54.x.
 * Later chapters add tower 0.5 (p2c balance), recloser 1.4 (circuit breaker),
 * opentelemetry-otlp 0.33 (OTLP traces), and pact_consumer 1.4 (contracts).
 *
 * Data is JSON-compatible and consumed by the plugin build.
 */
export default {
  "key": "services",
  "title": "Microservices & messaging",
  "blurb": "Design, connect, and operate Rust services: contracts, gRPC, Kafka and NATS, the outbox pattern, sagas, retries, and leases.",
  "level": "industry",
  "prefix": "s",
  "project": {
    "title": "Capstone: an event-driven order platform",
    "brief": "Split a checkout monolith into independently deployable services that exchange versioned events: a gRPC gateway, an order service with a transactional outbox, and an inventory worker with a durable JetStream consumer. Money moves only through a saga with idempotent steps, retry budgets, and a dead-letter path you can actually operate.",
    "deliverables": [
      "A Cargo workspace with contracts, gateway, order-service, and inventory-worker crates pinned to one tonic minor version.",
      "Proto3 contracts with an additive versioning policy and an automated breaking-change check in CI.",
      "Order writes that persist state and outbox rows in one SQLx transaction, relayed to Kafka only after delivery is confirmed.",
      "A durable JetStream inventory consumer with explicit acks, max_deliver, and a dead-letter path for poison messages.",
      "A checkout saga with persisted state, compensating steps, and a sweeper for stale sagas.",
      "An operations README covering health checks, deadlines, retry budgets, and alerts for outbox and consumer lag."
    ],
    "stack": [
      "tonic",
      "tonic-prost",
      "tonic-prost-build",
      "tonic-health",
      "rdkafka",
      "async-nats",
      "sqlx",
      "tokio",
      "tracing",
      "serde",
      "thiserror"
    ]
  },
  "lessons": [
    {
      "id": "s01",
      "n": 1,
      "title": "Service decomposition & API contracts",
      "minutes": 75,
      "level": "advanced",
      "goal": "Draw boundaries around business invariants, define proto3 contracts that can evolve, and lay out a Cargo workspace that keeps services independently deployable.",
      "sections": [
        {
          "h": "Boundaries follow invariants, not layers",
          "p": [
            "A service is a deployment and ownership unit, not a folder. Split where a capability owns its own invariants and its own write model: Orders owns the order state machine, Inventory owns available stock, Payments owns authorizations. If two capabilities must commit in one database transaction, they belong in one service until you are prepared to pay for a saga.",
            "The common failure is splitting by technical layer - a users service, a validation service, a notification service - and then needing four network calls to answer one question. Every boundary turns a compile-time guarantee into a timeout, so each one has to buy independent scaling, independent failure, or independent team ownership. If it buys none of those, merge it back."
          ],
          "list": [
            "One aggregate root per write model: an order and its lines change together",
            "Cross-service reads go through an API or an event, never a shared table",
            "A service owns its schema and ships its own migrations",
            "Extract from a modular monolith after a boundary has proven stable, not before"
          ],
          "tip": "If you cannot name the invariant a service protects in one sentence, you drew a folder, not a boundary."
        },
        {
          "h": "Contracts: proto3 and additive versioning",
          "p": [
            "Write the contract first. Define messages and RPCs in proto3, put the package in a version namespace such as acme.orders.v1, and treat the generated client as the public surface. Fields are forever: never renumber, never change a field type, and reserve both retired numbers and retired names so a later edit cannot quietly reuse them.",
            "Separate the two failure classes in the contract itself. gRPC status codes are the vocabulary: INVALID_ARGUMENT, NOT_FOUND, and ALREADY_EXISTS are permanent and must not be retried; UNAVAILABLE and DEADLINE_EXCEEDED are transient. If a consumer cannot tell them apart, retry policy is guesswork."
          ],
          "code": "syntax = \"proto3\";\n\npackage acme.orders.v1;\n\nimport \"google/protobuf/timestamp.proto\";\n\nmessage Order {\n  string id = 1;\n  string customer_id = 2;\n  int64 total_minor_units = 3; // money in minor units, never float\n  google.protobuf.Timestamp created_at = 4;\n  reserved 5, 6;               // fields deleted in v1.2\n  reserved \"legacy_status\";\n}\n\nmessage PlaceOrderRequest {\n  Order order = 1;\n  string idempotency_key = 2;  // client-supplied, survives retries\n}\n\nmessage PlaceOrderResponse {\n  Order order = 1;\n  bool replayed = 2;           // true when the key was already used\n}\n\nservice Orders {\n  rpc PlaceOrder(PlaceOrderRequest) returns (PlaceOrderResponse);\n}",
          "tip": "Add a new field, a new RPC, or a new enum value. Everything else is a new package version running side by side."
        },
        {
          "h": "A Cargo workspace that enforces the boundary",
          "p": [
            "One repository, one workspace, one Cargo.lock. Put generated protobuf in crates/contracts with no business logic, operational setup in crates/telemetry, and each deployable in services/<name>. Services depend on contracts and telemetry; they never depend on another service's domain crate.",
            "Share the contract and the operational shell; duplicate the domain. A shared domain crate looks tidy until a field rename in Orders forces a rebuild and redeploy of Inventory. Duplicating a sixty-line type per service is cheaper than a release train where every service ships in lock-step.",
            "Pin versions once in workspace.dependencies so a tonic bump is one line, and keep generated code out of the domain crates so the compiler cannot accidentally couple them."
          ],
          "code": "# Cargo.toml (workspace root)\n[workspace]\nresolver = \"3\"\nmembers = [\"crates/contracts\", \"crates/telemetry\", \"services/gateway\", \"services/orders\", \"services/inventory\"]\n\n[workspace.dependencies]\ntonic = \"0.14\"\ntonic-prost = \"0.14\"\ntonic-health = \"0.14\"\nprost = \"0.14\"\ntokio = { version = \"1\", features = [\"macros\", \"rt-multi-thread\", \"signal\", \"time\"] }\ntracing = \"0.1\"\nsqlx = { version = \"0.9\", features = [\"runtime-tokio\", \"postgres\", \"macros\"] }\n\n# services/orders/Cargo.toml\n[dependencies]\ncontracts = { path = \"../../crates/contracts\" }\ntelemetry = { path = \"../../crates/telemetry\" }\ntonic = { workspace = true }\ntokio = { workspace = true }\nsqlx = { workspace = true }\n# NOT: inventory = { path = \"../inventory\" }",
          "tip": "Add a CI check that greps service manifests for paths into another service; dependency rules that are only documented get broken."
        },
        {
          "h": "Decide to split with numbers",
          "p": [
            "Before extracting a service, name the cost you are avoiding: a deploy queue that blocks teams, a scaling profile that differs by orders of magnitude, a compliance boundary, or a failure domain that must be isolated. Then name the cost you are accepting: one more contract to version, one more latency hop, partial failure, and a data migration.",
            "A useful test: could this capability be down for ten minutes without stopping the business? If not, it needs a synchronous dependency and probably belongs in the same process. Event-driven reactions - email, analytics, search indexing - are the easy first extractions because their failures are recoverable and invisible to the buyer."
          ],
          "tip": "Prefer a modular monolith until a boundary has survived a year of changes; extraction is cheap compared with a distributed monolith."
        }
      ],
      "exercise": {
        "prompt": "You inherit a monolith with billing, inventory, shipping, and email modules. Checkout must charge and reserve stock atomically enough to reject a sale, while email only reacts. Sketch the service boundary and write the workspace manifest plus the dependency rules you will enforce.",
        "starter": "# 1. decide: which modules need a synchronous transaction, which can react?\n\n[workspace]\nresolver = \"3\"\nmembers = [\n    # crates/...,\n    # services/...,\n]\n\n[workspace.dependencies]\n# pin tonic, tokio, sqlx once\n",
        "hint": "Checkout mutates billing and inventory, so those stay synchronous (or become saga steps); email is an event reaction. Share contracts and telemetry crates, duplicate domain types, and forbid service-to-service crate paths.",
        "solution": "# Boundary: billing + inventory are the checkout transaction; shipping is a\n# downstream step with compensation; email is an event consumer.\n\n[workspace]\nresolver = \"3\"\nmembers = [\n    \"crates/contracts\",\n    \"crates/telemetry\",\n    \"services/checkout\",\n    \"services/billing\",\n    \"services/inventory\",\n    \"services/email-worker\",\n]\n\n[workspace.dependencies]\ntonic = \"0.14\"\ntonic-prost = \"0.14\"\nprost = \"0.14\"\ntokio = { version = \"1\", features = [\"macros\", \"rt-multi-thread\", \"signal\", \"time\"] }\ntracing = \"0.1\"\nsqlx = { version = \"0.9\", features = [\"runtime-tokio\", \"postgres\", \"macros\"] }\n\n# Rules enforced in CI:\n# 1. A service may depend on crates/contracts and crates/telemetry only.\n# 2. A service owns its database schema; no cross-service joins.\n# 3. checkout talks to billing/inventory over gRPC contracts, never via Rust paths.\n# 4. email-worker consumes events; it must not block checkout."
      },
      "production": [
        "Every service owns its schema and migration set; no production query joins another service's tables.",
        "CI runs a breaking-change check (buf breaking or equivalent) against the published proto package.",
        "Consumer-driven contract tests run against the provider's generated stubs, not a hand-written mock.",
        "A dependency-rule check fails the build when one service imports another service's crate.",
        "Each boundary has an ADR recording what would justify merging the services back."
      ],
      "crates": [
        "tonic",
        "prost",
        "tokio",
        "tracing",
        "serde"
      ],
      "pitfall": "A shared common crate that accumulates domain types and helpers: every field change becomes a lock-step redeploy of all services, silently re-coupling the services you just split.",
      "questions": [
        {
          "q": "Which proto3 change can ship inside the same package version without breaking existing clients?",
          "options": [
            "Renumbering a retired field so its old tag is reused by a new field",
            "Adding a new field with a fresh tag number that has never been used",
            "Changing int64 total_minor_units to double so fractions fit",
            "Renaming a field and giving its old name a different meaning"
          ],
          "answer": 1,
          "explain": "Additive edits - new tags, new RPCs, new enum values - stay wire-compatible. Reusing a tag or changing a field type makes old and new clients decode different data from the same bytes."
        },
        {
          "q": "A caller gets INVALID_ARGUMENT from PlaceOrder. What is the correct handling?",
          "options": [
            "Retry immediately with the same payload in case the server was busy",
            "Retry with exponential backoff until the caller's deadline expires",
            "Fail fast and surface the error; the status is deterministic for this request",
            "Treat it as transient and retry only after the next consumer rebalance"
          ],
          "answer": 2,
          "explain": "INVALID_ARGUMENT means the request itself is wrong: the same bytes fail the same way. Retrying spends budget and delays the alert that would point at the real bug."
        }
      ],
      "quickbytes": [
        "Pin tonic, prost, and sqlx once in [workspace.dependencies]; a version bump then becomes a one-line diff.",
        "Reserve retired proto tags and names in the same commit that deletes the field, and run buf breaking in CI.",
        "If two capabilities must commit in one transaction, keep them in one service until you have budgeted a saga."
      ],
      "github": [
        { "name": "gRPC core (proto conventions, status codes)", "url": "https://github.com/grpc/grpc" },
        { "name": "prost - Protocol Buffers for Rust", "url": "https://github.com/tokio-rs/prost" }
      ],
      "resources": [
        {
          "title": "The Cargo Book: workspaces",
          "url": "https://doc.rust-lang.org/cargo/reference/workspaces.html",
          "kind": "docs"
        },
        {
          "title": "gRPC core concepts: services, methods, and streaming",
          "url": "https://grpc.io/docs/what-is-grpc/core-concepts/",
          "kind": "docs"
        },
        {
          "title": "tonic crate documentation",
          "url": "https://docs.rs/tonic/latest/tonic/",
          "kind": "docs"
        },
        {
          "title": "prost crate documentation",
          "url": "https://docs.rs/prost/latest/prost/",
          "kind": "docs"
        },
        {
          "title": "InfoQ channel: microservice decomposition and API contract talks",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        }
      ]
    },
    {
      "id": "s02",
      "n": 2,
      "title": "gRPC with tonic: codegen, deadlines, health",
      "minutes": 110,
      "level": "advanced",
      "goal": "Generate a tonic 0.14 service from proto3, serve it with health reporting and graceful shutdown, and make every call carry a deadline and a correlation id.",
      "sections": [
        {
          "h": "Proto3 to Rust in build.rs",
          "p": [
            "gRPC codegen runs at build time. Since tonic 0.14 the build story is split into three crates: tonic-prost-build compiles .proto files through prost, tonic-build generates only the service stubs, and tonic-prost provides the ProstCodec at runtime. Tutorials that still call tonic_build::configure().compile_protos(...) do not compile against 0.14 without the compatibility crate.",
            "Keep all tonic crates on the same minor version in workspace.dependencies, and put the build crate under [build-dependencies] so it never leaks into the runtime graph. The file descriptor set is optional but pays for itself when you add reflection or an external schema registry."
          ],
          "code": "# Cargo.toml\n[dependencies]\ntonic = \"0.14\"\ntonic-prost = \"0.14\"\ntonic-health = \"0.14\"\nprost = \"0.14\"\ntokio = { version = \"1\", features = [\"macros\", \"rt-multi-thread\", \"signal\"] }\n\n[build-dependencies]\ntonic-prost-build = \"0.14\"\n\n# build.rs\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    println!(\"cargo:rerun-if-changed=proto/orders.proto\");\n    let out = std::path::PathBuf::from(std::env::var(\"OUT_DIR\")?);\n    tonic_prost_build::configure()\n        .build_server(true)\n        .build_client(true)\n        .file_descriptor_set_path(out.join(\"orders_descriptor.bin\"))\n        .compile_protos(&[\"proto/orders.proto\"], &[\"proto\"])?;\n    Ok(())\n}\n\n# src/lib.rs\npub mod orders {\n    tonic::include_proto!(\"acme.orders.v1\");\n}\n\npub const DESCRIPTOR_SET: &[u8] =\n    tonic::include_file_descriptor_set!(\"orders_descriptor\");",
          "tip": "The include_file_descriptor_set argument is the file stem without .bin - here orders_descriptor, not orders_descriptor.bin."
        },
        {
          "h": "Serving with health and graceful shutdown",
          "p": [
            "A tonic server is built with Server::builder(), and each generated service is added with add_service. Wire the standard gRPC health service in the same builder: load balancers and health-check-aware clients watch the Check and Watch RPCs, so the status must reflect real readiness - migrations applied, pool reachable - not merely that the process is alive.",
            "In tonic-health 0.14, health_reporter() is a plain function returning a HealthReporter and a HealthServer. set_serving is keyed by the generated server type (which implements NamedService), so a typo in the type is a compile error rather than a silent misconfiguration. On shutdown, report NOT_SERVING first, then let serve_with_shutdown drain in-flight work."
          ],
          "code": "use std::net::SocketAddr;\nuse tokio::signal;\nuse tonic::transport::Server;\nuse tonic_health::server::health_reporter;\n\npub async fn serve(addr: SocketAddr, pool: sqlx::PgPool) -> Result<(), Box<dyn std::error::Error>> {\n    let orders = orders::OrderService { pool };\n\n    let (health_reporter, health_service) = health_reporter();\n    health_reporter\n        .set_serving::<orders_server::OrdersServer<orders::OrderService>>()\n        .await;\n\n    Server::builder()\n        .add_service(health_service)\n        .add_service(orders_server::OrdersServer::new(orders))\n        .serve_with_shutdown(addr, async move {\n            let _ = signal::ctrl_c().await;\n            tracing::info!(\"shutdown requested\");\n        })\n        .await?;\n\n    Ok(())\n}",
          "tip": "Set NOT_SERVING before draining. A load balancer that still sees SERVING will keep sending traffic to a process that is about to close its listeners."
        },
        {
          "h": "Deadlines: the only thing that stops a hang",
          "p": [
            "gRPC sets no deadline by default. A client that does not set one can wait effectively forever, and no retry policy ever fires because nothing failed - the call simply hangs. tonic exposes the budget through Request::set_timeout: the client sends a grpc-timeout header and the server sees DEADLINE_EXCEEDED when the budget is gone.",
            "Budget must shrink as the call travels. If the gateway has 800 ms for a request and spent 100 ms, it should give the order service at most 600 ms, not another 800. The gRPC deadline guide describes exactly this: propagate the remaining time, never the absolute timestamp, because two hosts' clocks disagree. On the server side, wrap downstream work in tokio::time::timeout so a slow dependency cannot consume the whole budget silently."
          ],
          "code": "use std::time::Duration;\nuse tonic::Code;\n\npub async fn get_order(\n    client: &mut orders_client::OrdersClient<tonic::transport::Channel>,\n    order_id: String,\n    remaining: Duration,\n) -> Result<Order, FetchError> {\n    let mut req = tonic::Request::new(GetOrderRequest { order_id });\n    req.set_timeout(remaining); // explicit budget per call\n\n    match client.get_order(req).await {\n        Ok(resp) => Ok(resp.into_inner()),\n        Err(status) => match status.code() {\n            Code::Unavailable | Code::DeadlineExceeded => Err(FetchError::Transient(status)),\n            code => Err(FetchError::Permanent(code)),\n        },\n    }\n}",
          "list": [
            "Retry UNAVAILABLE and DEADLINE_EXCEEDED, but only inside the caller's remaining budget",
            "Do not retry INVALID_ARGUMENT, NOT_FOUND, ALREADY_EXISTS, or PERMISSION_DENIED - they are deterministic",
            "A client timeout is not proof the server did nothing; the request may have committed after the deadline"
          ]
        },
        {
          "h": "Interceptors are synchronous, so keep them cheap",
          "p": [
            "A tonic interceptor is a function from Request<()> to Result<Request<()>, Status>, run once per call on the request path. That makes it the right place for header validation, correlation-id insertion, and adding fields to a tracing span. It is the wrong place for a database lookup or an HTTP call: interceptors are synchronous and run on the async executor thread, so blocking there stalls unrelated tasks.",
            "Interceptors compose through the generated code: server-side OrdersServer::with_interceptor(service, interceptor) and client-side OrdersClient::with_interceptor(channel, interceptor). Async middleware - rate limiting, retry, circuit breaking - belongs in a tower Layer applied to the service, where it can await."
          ],
          "code": "use tonic::service::Interceptor;\nuse tonic::{Request, Status};\n\n#[derive(Clone, Default)]\npub struct RequireApiKey {\n    pub expected: String,\n}\n\nimpl Interceptor for RequireApiKey {\n    fn call(&mut self, mut req: Request<()>) -> Result<Request<()>, Status> {\n        let provided = req\n            .metadata()\n            .get(\"x-api-key\")\n            .and_then(|value| value.to_str().ok());\n\n        match provided {\n            Some(key) if key == self.expected => {\n                let request_id = uuid::Uuid::new_v4().to_string();\n                req.metadata_mut().insert(\"x-request-id\", request_id.parse().unwrap());\n                Ok(req)\n            }\n            _ => Err(Status::unauthenticated(\"missing or invalid x-api-key\")),\n        }\n    }\n}",
          "tip": "Interceptors are also the natural place to reject oversized metadata; keep header handling allocation-light because it runs on every call."
        }
      ],
      "exercise": {
        "prompt": "Add a 400 ms deadline and a request-id interceptor to an outbound gRPC call, then classify the returned status as transient or permanent so the caller knows whether a retry is safe.",
        "starter": "use std::time::Duration;\nuse tonic::transport::{Channel, Endpoint};\nuse tonic::{Code, Request};\n\npub async fn call(addr: &'static str, order_id: String) -> Result<Order, String> {\n    let channel = Endpoint::from_static(addr).connect().await.map_err(|e| e.to_string())?;\n    let mut client = orders_client::OrdersClient::new(channel);\n\n    let mut req = Request::new(GetOrderRequest { order_id });\n    // 1. set a 400 ms budget\n    // 2. map status codes into transient vs permanent\n    todo!()\n}",
        "hint": "Set req.set_timeout(Duration::from_millis(400)). Then match status.code(): Unavailable and DeadlineExceeded are transient; everything else is permanent for this call.",
        "solution": "use std::time::Duration;\nuse tonic::transport::Endpoint;\nuse tonic::{Code, Request};\n\npub async fn call(addr: &'static str, order_id: String) -> Result<Order, String> {\n    let channel = Endpoint::from_static(addr)\n        .connect()\n        .await\n        .map_err(|e| format!(\"connect: {e}\"))?;\n    let mut client = orders_client::OrdersClient::new(channel);\n\n    let mut req = Request::new(GetOrderRequest { order_id });\n    req.set_timeout(Duration::from_millis(400));\n\n    match client.get_order(req).await {\n        Ok(resp) => Ok(resp.into_inner().order.expect(\"server always returns an order\")),\n        Err(status) => match status.code() {\n            Code::Unavailable | Code::DeadlineExceeded => Err(format!(\"transient: {}\", status.message())),\n            code => Err(format!(\"permanent {code}: {}\", status.message())),\n        },\n    }\n}"
      },
      "production": [
        "Every outbound RPC sets a deadline smaller than the caller's remaining budget.",
        "The health service reports NOT_SERVING before shutdown, and readiness reflects pool and migration state.",
        "Interceptors stay non-blocking; anything that awaits is a tower layer instead.",
        "Max decoding message size and concurrency limits are set explicitly on the server.",
        "Codegen and runtime crates are pinned to one tonic minor in workspace.dependencies."
      ],
      "crates": [
        "tonic",
        "tonic-prost",
        "tonic-prost-build",
        "tonic-health",
        "prost",
        "tokio",
        "uuid"
      ],
      "pitfall": "A client call with no deadline: a stalled server or a dropped packet leaves the task waiting indefinitely, retries never trigger, and connection pools fill with requests that will never finish.",
      "questions": [
        {
          "q": "What does tonic's Request::set_timeout actually do?",
          "options": [
            "Cancels the server-side task as soon as the budget expires",
            "Sends a grpc-timeout header so both sides bound the call",
            "Retries the call automatically when the deadline is exceeded",
            "Sets the TCP connect timeout used by the channel"
          ],
          "answer": 1,
          "explain": "set_timeout encodes a grpc-timeout header. The client stops waiting and the server observes DEADLINE_EXCEEDED, but the server is not forcibly stopped - the request may still commit."
        },
        {
          "q": "After the health reporter reports NOT_SERVING, what should the process do next?",
          "options": [
            "Exit immediately so no new requests are accepted",
            "Keep the listener open but reject every new RPC forever",
            "Drain in-flight work through serve_with_shutdown, then exit",
            "Report SERVING again as soon as the pool reconnects"
          ],
          "answer": 2,
          "explain": "NOT_SERVING takes the instance out of load-balancer rotation; draining lets in-flight RPCs finish instead of failing mid-write. Exit first and you drop work the balancer already sent."
        }
      ],
      "quickbytes": [
        "Client: req.set_timeout(remaining) on every outbound RPC. Server: tokio::time::timeout around each downstream call.",
        "set_serving::<OrdersServer<_>>() keys on the generated type, so a typo is a compile error - keep it that way.",
        "Report NOT_SERVING before serve_with_shutdown; never close listeners while still advertising SERVING."
      ],
      "github": [
        { "name": "tonic (grpc-rust) - gRPC client and server", "url": "https://github.com/grpc/grpc-rust" },
        { "name": "tokio - async runtime and timers", "url": "https://github.com/tokio-rs/tokio" }
      ],
      "resources": [
        {
          "title": "tonic crate documentation",
          "url": "https://docs.rs/tonic/latest/tonic/",
          "kind": "docs"
        },
        {
          "title": "tonic-health: gRPC health service for tonic",
          "url": "https://docs.rs/tonic-health/latest/tonic_health/",
          "kind": "docs"
        },
        {
          "title": "tonic-prost-build: prost codegen for tonic",
          "url": "https://docs.rs/tonic-prost-build/latest/tonic_prost_build/",
          "kind": "docs"
        },
        {
          "title": "gRPC guide: deadlines and propagation",
          "url": "https://grpc.io/docs/guides/deadlines/",
          "kind": "docs"
        },
        {
          "title": "gRPC channel: deadline propagation, health checking, and interceptors",
          "url": "https://www.youtube.com/@grpcio",
          "kind": "video"
        }
      ]
    },
    {
      "id": "s03",
      "n": 3,
      "title": "Kafka with rdkafka: acks, groups, offsets",
      "minutes": 105,
      "level": "advanced",
      "goal": "Produce with idempotent, fully acknowledged writes; consume in a group with manual offset commits; and explain exactly where duplicates and reordering can appear.",
      "sections": [
        {
          "h": "Producer configs that make acks mean something",
          "p": [
            "acks=all means the leader waits for all in-sync replicas, not just itself. On top of that, enable.idempotence=true gives the producer a sequence number per partition, so retries cannot duplicate or reorder records; it requires acks=all and retries greater than zero, and librdkafka enables those together. message.timeout.ms bounds how long a record may sit locally before delivery is declared failed.",
            "The record key decides the partition, and the partition decides ordering. Key by aggregate id, not by random uuid, if you need all events for one order to arrive in order. The FutureProducer is cheaply cloneable, runs its own polling thread, and returns a delivery result, so a publish is not complete until that result says so."
          ],
          "code": "use rdkafka::config::ClientConfig;\nuse rdkafka::producer::{FutureProducer, FutureRecord};\nuse rdkafka::util::Timeout;\nuse std::time::Duration;\n\npub fn producer() -> Result<FutureProducer, rdkafka::error::KafkaError> {\n    ClientConfig::new()\n        .set(\"bootstrap.servers\", \"localhost:9092\")\n        .set(\"acks\", \"all\")\n        .set(\"enable.idempotence\", \"true\")\n        .set(\"message.timeout.ms\", \"30000\")\n        .set(\"linger.ms\", \"5\")\n        .create()\n}\n\npub async fn publish(\n    producer: &FutureProducer,\n    order_id: &str,\n    payload: &str,\n) -> Result<(), String> {\n    let record = FutureRecord::to(\"orders.events\")\n        .key(order_id)\n        .payload(payload);\n\n    match producer.send(record, Timeout::After(Duration::from_secs(5))).await {\n        Ok((partition, offset)) => {\n            tracing::info!(partition, offset, \"event delivered\");\n            Ok(())\n        }\n        Err((error, _message)) => Err(format!(\"delivery failed: {error}\")),\n    }\n}",
          "tip": "queue timeout and delivery timeout are different: Timeout::After on send covers a full local queue, while message.timeout.ms covers the whole delivery attempt."
        },
        {
          "h": "Consumer groups and partition ownership",
          "p": [
            "A consumer group distributes partitions: each partition is assigned to exactly one consumer in the group at a time, so more consumers than partitions means idle consumers. Ordering is preserved per partition because one consumer processes that partition sequentially.",
            "The StreamConsumer keeps the group protocol alive in the background, but liveness still depends on you polling often enough: if the stream is not polled for max.poll.interval.ms, librdkafka assumes the processing thread is wedged and revokes the assignment. That interval must be larger than your worst-case batch processing time, or a slow handler triggers a rebalance and the work restarts elsewhere."
          ],
          "code": "use rdkafka::config::ClientConfig;\nuse rdkafka::consumer::StreamConsumer;\n\npub fn consumer() -> Result<StreamConsumer, rdkafka::error::KafkaError> {\n    ClientConfig::new()\n        .set(\"bootstrap.servers\", \"localhost:9092\")\n        .set(\"group.id\", \"order-projector\")\n        .set(\"enable.auto.commit\", \"false\")\n        .set(\"enable.auto.offset.store\", \"false\")\n        .set(\"auto.offset.reset\", \"earliest\")\n        .set(\"max.poll.interval.ms\", \"300000\")\n        .create()\n}",
          "list": [
            "group.id is the unit of scaling and of offset storage; changing it replays the topic",
            "auto.offset.reset=earliest can replay everything after a group is new or its offsets expire",
            "Rebalances revoke partitions; commit or finish in-flight work before the assignment changes"
          ]
        },
        {
          "h": "Commit after the effect: at-least-once",
          "p": [
            "Kafka records a consumer group's position in an internal topic. With enable.auto.commit left at its default, offsets are committed on a timer regardless of whether your handler succeeded - a crash between poll and side effect loses messages. Turn auto commit off and commit explicitly after the durable effect.",
            "commit_message commits the given message and, implicitly, every lower offset in that partition. That is correct only if you process a partition in order; committing message 9 while message 7 is still retrying silently marks 7 as done. CommitMode::Async avoids an RTT and is fine for at-least-once because a lost commit only causes redelivery, not loss."
          ],
          "code": "use futures_util::StreamExt;\nuse rdkafka::consumer::{CommitMode, Consumer, StreamConsumer};\nuse rdkafka::message::Message;\n\npub async fn run(consumer: StreamConsumer) -> Result<(), Box<dyn std::error::Error>> {\n    let mut stream = consumer.stream();\n    while let Some(result) = stream.next().await {\n        let message = result?;\n        let key = message.key().map(|k| String::from_utf8_lossy(k).into_owned());\n        let payload = message.payload().unwrap_or_default();\n\n        handle(key, payload).await?; // durable, idempotent effect first\n        consumer.commit_message(&message, CommitMode::Async)?; // then advance\n    }\n    Ok(())\n}",
          "tip": "A duplicate is normal after a crash between the effect and the commit. That is why lesson s05 makes consumers idempotent instead of trying to make the commit atomic."
        },
        {
          "h": "Ordering and duplicates in practice",
          "p": [
            "Kafka guarantees order within a single topic-partition, not across partitions and not globally. With enable.idempotence=false and retries greater than one, a failed batch can be retried after a later batch succeeded, so even one partition can be reordered. Idempotence fixes that by rejecting out-of-sequence retries in the broker.",
            "Growing a topic's partition count changes the key-to-partition mapping for a subset of keys, so per-key order is not preserved across a resize. Treat partition count as a capacity decision made early, and if you must grow, pause producers or route through a versioned topic. Consumers still see duplicates after rebalances, restarts, or reprocessing, so dedupe downstream."
          ],
          "tip": "If two events for the same order must be ordered, they must have the same key and live in the same topic."
        }
      ],
      "exercise": {
        "prompt": "Write a consumer loop that processes each message, commits only after the handler returns Ok, and explains in a comment where a duplicate can still appear.",
        "starter": "use futures_util::StreamExt;\nuse rdkafka::consumer::{CommitMode, Consumer, StreamConsumer};\nuse rdkafka::message::Message;\n\npub async fn run(consumer: StreamConsumer) -> Result<(), Box<dyn std::error::Error>> {\n    let mut stream = consumer.stream();\n    while let Some(result) = stream.next().await {\n        let message = result?;\n        // 1. extract key and payload\n        // 2. handle durably\n        // 3. commit only after the handler succeeded\n    }\n    Ok(())\n}",
        "hint": "Call consumer.commit_message(&message, CommitMode::Async) after handle().await? returns Ok. A crash between the side effect and the commit replays the message.",
        "solution": "use futures_util::StreamExt;\nuse rdkafka::consumer::{CommitMode, Consumer, StreamConsumer};\nuse rdkafka::message::Message;\n\npub async fn run(consumer: StreamConsumer) -> Result<(), Box<dyn std::error::Error>> {\n    let mut stream = consumer.stream();\n    while let Some(result) = stream.next().await {\n        let message = result?;\n        let key = message.key().map(|k| String::from_utf8_lossy(k).into_owned());\n        let payload = message.payload().unwrap_or_default().to_vec();\n\n        // Durable effect first. If this crashes after writing but before the\n        // commit below, the message is redelivered: at-least-once means the\n        // handler must be idempotent (dedupe on message key in Postgres).\n        handle(key.as_deref(), &payload).await?;\n\n        consumer.commit_message(&message, CommitMode::Async)?;\n    }\n    Ok(())\n}\n\nasync fn handle(_key: Option<&str>, _payload: &[u8]) -> Result<(), Box<dyn std::error::Error>> {\n    Ok(())\n}"
      },
      "production": [
        "acks=all and enable.idempotence=true on every producer, verified by a config test rather than a wiki.",
        "enable.auto.commit=false and enable.auto.offset.store=false; commits follow durable side effects.",
        "Alert on consumer-group lag per partition, not just broker health; lag is the first sign of a stuck handler.",
        "max.poll.interval.ms comfortably exceeds p99 batch processing time, and rebalances are logged.",
        "Topic keys are aggregate ids so per-entity ordering survives retries and rebalances."
      ],
      "crates": [
        "rdkafka",
        "tokio",
        "futures-util",
        "serde",
        "serde_json",
        "tracing"
      ],
      "pitfall": "Leaving enable.auto.commit at its default true: offsets advance on a timer whether or not the handler succeeded, so a crash after the poll but before the side effect drops those messages permanently.",
      "questions": [
        {
          "q": "What does enable.idempotence=true on the producer actually guarantee?",
          "options": [
            "Exactly-once delivery to consumers, including their side effects",
            "Per-partition sequence numbers so retries neither duplicate nor reorder",
            "Global ordering across every partition of the topic",
            "Automatic offset commits after each delivered batch"
          ],
          "answer": 1,
          "explain": "Idempotence dedupes producer retries inside one partition. Consumers still see duplicates after rebalances or replays, and side effects still need their own dedupe."
        },
        {
          "q": "With enable.auto.commit=false, when is it safe to commit the offset of message N?",
          "options": [
            "Immediately after poll returns the batch containing N",
            "Before handling N, so that a crash cannot replay it",
            "After the durable effect for N and every lower offset in that partition succeeded",
            "Only after every partition of the topic has been processed"
          ],
          "answer": 2,
          "explain": "commit_message advances past all lower offsets in the partition, so committing early silently marks unprocessed messages as done - that is a lost message, not a duplicate."
        }
      ],
      "quickbytes": [
        "Producer: acks=all, enable.idempotence=true, message.timeout.ms=30000 - assert these in a config test.",
        "Consumer: enable.auto.commit=false and enable.auto.offset.store=false; commit only after the durable effect.",
        "Key records by aggregate id; a group with more consumers than partitions just leaves replicas idle."
      ],
      "github": [
        { "name": "rust-rdkafka - Kafka client for Rust", "url": "https://github.com/fede1024/rust-rdkafka" },
        { "name": "apache/kafka - broker source and protocol docs", "url": "https://github.com/apache/kafka" }
      ],
      "resources": [
        {
          "title": "rdkafka crate documentation",
          "url": "https://docs.rs/rdkafka/latest/rdkafka/",
          "kind": "docs"
        },
        {
          "title": "rdkafka producer module: delivery, configs, transactions",
          "url": "https://docs.rs/rdkafka/latest/rdkafka/producer/index.html",
          "kind": "docs"
        },
        {
          "title": "rdkafka StreamConsumer",
          "url": "https://docs.rs/rdkafka/latest/rdkafka/consumer/stream_consumer/struct.StreamConsumer.html",
          "kind": "docs"
        },
        {
          "title": "Apache Kafka introduction: ordering and replication guarantees",
          "url": "https://kafka.apache.org/intro",
          "kind": "docs"
        },
        {
          "title": "Confluent's Kafka channel: Kafka Summit talks on acks, rebalancing, and exactly-once",
          "url": "https://www.youtube.com/@Confluent",
          "kind": "video"
        }
      ]
    },
    {
      "id": "s04",
      "n": 4,
      "title": "NATS & JetStream with async-nats",
      "minutes": 95,
      "level": "advanced",
      "goal": "Model subjects and streams correctly, build a durable pull consumer with explicit acks, and state plainly what JetStream exactly-once does and does not cover.",
      "sections": [
        {
          "h": "Core NATS is fire-and-forget; JetStream persists",
          "p": [
            "Core NATS publish/subscribe is at-most-once: the client buffers a publish, flushes, and never learns whether a subscriber existed or handled it. That is perfect for telemetry and presence, and wrong for anything that must not be lost. JetStream is the persistence layer: it stores messages for a stream, tracks per-consumer progress, and redelivers until a message is acknowledged or a delivery limit is reached.",
            "Enable the jetstream feature on async-nats and create a context with jetstream::new(client). The context is the handle for stream and consumer management plus publish acknowledgements; it is cheap to clone and should be shared, not recreated per request."
          ],
          "code": "use std::time::Duration;\n\npub async fn connect(url: &str) -> Result<async_nats::jetstream::Context, async_nats::Error> {\n    let client = async_nats::connect(url).await?;\n    let mut jetstream = async_nats::jetstream::new(client);\n    jetstream.set_timeout(Duration::from_secs(5)); // bounds every JS API call\n    Ok(jetstream)\n}",
          "tip": "JetStream API calls are bounded by the context timeout, so an unresponsive server fails fast instead of hanging a request task."
        },
        {
          "h": "Subjects, streams, and retention",
          "p": [
            "Subjects are dot-separated tokens: orders.created.v1.<order-id>. Wildcards are * for one token and > for one or more trailing tokens, so a stream configured with orders.> captures every order subject. Stream config decides what is kept: subjects, retention policy, max_age, storage. Limits retention drops old messages once a limit is hit; Interest retention drops a message once every consumer has acked it.",
            "A stream name is global to the account, and creating a stream that already exists with a different config is an error, not a silent update. Use get_or_create_stream for idempotent startup, and treat stream config as schema: it belongs in code review, not an ad-hoc CLI command in production."
          ],
          "code": "use async_nats::jetstream::stream;\nuse std::time::Duration;\n\npub async fn ensure_stream(\n    jetstream: &async_nats::jetstream::Context,\n) -> Result<async_nats::jetstream::stream::Stream, async_nats::Error> {\n    let stream = jetstream\n        .get_or_create_stream(stream::Config {\n            name: \"ORDERS\".to_string(),\n            subjects: vec![\"orders.>\".to_string()],\n            retention: stream::RetentionPolicy::Limits,\n            max_age: Duration::from_secs(7 * 24 * 60 * 60),\n            ..Default::default()\n        })\n        .await?;\n    Ok(stream)\n}",
          "tip": "Subject hierarchy is your routing table. Put the event type before the id - orders.created.v1.<id> - so a consumer can filter by type without wildcard gymnastics."
        },
        {
          "h": "Durable pull consumers and ack kinds",
          "p": [
            "A consumer is the cursor over a stream. A durable consumer remembers its position across restarts, which is what you want for a worker queue. pull::Config gives you the knobs that matter: ack_policy Explicit means every message is acked individually, ack_wait is how long the server waits before redelivering, max_deliver caps poison-message loops, and max_ack_pending bounds in-flight work.",
            "Ack with ack() when the work is durable, and ack_with(AckKind::Nak(Some(delay))) when it failed but should be retried after a delay. AckKind::Progress reports in-flight progress so a long handler does not trip ack_wait; AckKind::Term terminates the message without redelivery, which is useful for messages that can never succeed."
          ],
          "code": "use async_nats::jetstream::consumer::{self, AckPolicy, PullConsumer};\nuse async_nats::jetstream::AckKind;\nuse bytes::Bytes;\nuse futures_util::StreamExt;\nuse std::time::Duration;\n\npub async fn ensure_consumer(\n    jetstream: &async_nats::jetstream::Context,\n) -> Result<PullConsumer, async_nats::Error> {\n    if let Ok(consumer) = jetstream.get_consumer_from_stream(\"invoice-worker\", \"ORDERS\").await {\n        return Ok(consumer);\n    }\n\n    let consumer = jetstream\n        .create_consumer_on_stream(\n            consumer::pull::Config {\n                durable_name: Some(\"invoice-worker\".to_string()),\n                ack_policy: AckPolicy::Explicit,\n                ack_wait: Duration::from_secs(30),\n                max_deliver: 5,\n                filter_subject: \"orders.created.v1.*\".to_string(),\n                ..Default::default()\n            },\n            \"ORDERS\",\n        )\n        .await?;\n\n    Ok(consumer)\n}\n\npub async fn drain(consumer: PullConsumer) -> Result<(), async_nats::Error> {\n    let mut messages = consumer.fetch().max_messages(32).messages().await?;\n    while let Some(result) = messages.next().await {\n        let message = result?;\n        match handle(message.payload.clone()).await {\n            Ok(()) => message.ack().await?,\n            Err(_transient) => {\n                message.ack_with(AckKind::Nak(Some(Duration::from_secs(10)))).await?;\n            }\n        }\n    }\n    Ok(())\n}\n\nasync fn handle(_payload: Bytes) -> Result<(), String> {\n    Ok(())\n}",
          "tip": "Nak with a delay instead of an immediate retry: an instant redelivery of a failing message is a busy loop against the server."
        },
        {
          "h": "Exactly-once claims, precisely stated",
          "p": [
            "JetStream's default is at-least-once. Two mechanisms sharpen it. First, a publish can carry a unique message id, and the stream drops duplicates with the same id inside its duplicate window - a server-side, time-bounded dedupe. Second, double_ack waits for the server to confirm it persisted the ack, which removes the window where an ack is lost and the message is redelivered.",
            "Neither makes consumer side effects exactly-once. The dedupe window expires, so a replay hours later publishes again; a consumer can crash after the effect and before the ack; and a database write is not part of the JetStream transaction. The honest claim is effectively-once within a configured window, and end-to-end idempotency is still your job."
          ],
          "list": [
            "Duplicate window is bounded time, not bounded forever; size dedupe storage to the replay window you promise",
            "double_ack costs a round trip per message; use it when a lost ack is expensive, not everywhere",
            "Consumer-side dedupe (lesson s05) is what turns at-least-once delivery into at-most-once effects"
          ],
          "tip": "When a vendor says exactly-once, ask two questions: which window, and which side effects are inside it."
        }
      ],
      "exercise": {
        "prompt": "Create a durable pull consumer named billing-worker on the ORDERS stream, filtered to orders.created.v1.*, with explicit acks, a 20 second ack wait, and max_deliver 5. On transient failure, nack with an 8 second delay.",
        "starter": "use async_nats::jetstream::consumer::{self, AckPolicy, PullConsumer};\nuse async_nats::jetstream::AckKind;\nuse std::time::Duration;\n\npub async fn ensure(js: &async_nats::jetstream::Context) -> Result<PullConsumer, async_nats::Error> {\n    // 1. try get_consumer_from_stream(\"billing-worker\", \"ORDERS\")\n    // 2. otherwise create_consumer_on_stream with the required config\n    todo!()\n}",
        "hint": "durable_name: Some(\"billing-worker\"), ack_policy: AckPolicy::Explicit, ack_wait: Duration::from_secs(20), max_deliver: 5, filter_subject: \"orders.created.v1.*\". Retry with AckKind::Nak(Some(Duration::from_secs(8))).",
        "solution": "use async_nats::jetstream::consumer::{self, AckPolicy, PullConsumer};\nuse async_nats::jetstream::AckKind;\nuse std::time::Duration;\n\npub async fn ensure(js: &async_nats::jetstream::Context) -> Result<PullConsumer, async_nats::Error> {\n    if let Ok(consumer) = js.get_consumer_from_stream(\"billing-worker\", \"ORDERS\").await {\n        return Ok(consumer);\n    }\n\n    let consumer = js\n        .create_consumer_on_stream(\n            consumer::pull::Config {\n                durable_name: Some(\"billing-worker\".to_string()),\n                ack_policy: AckPolicy::Explicit,\n                ack_wait: Duration::from_secs(20),\n                max_deliver: 5,\n                filter_subject: \"orders.created.v1.*\".to_string(),\n                max_ack_pending: 64,\n                ..Default::default()\n            },\n            \"ORDERS\",\n        )\n        .await?;\n\n    Ok(consumer)\n}\n\npub async fn retry_later(\n    msg: &async_nats::jetstream::message::Message,\n) -> Result<(), async_nats::Error> {\n    msg.ack_with(AckKind::Nak(Some(Duration::from_secs(8)))).await\n}"
      },
      "production": [
        "ack_wait exceeds p99 handler time; long handlers report progress or split the work.",
        "max_deliver is set per consumer so a poison message cannot loop forever.",
        "max_ack_pending bounds in-flight work, memory, and downstream load.",
        "Every stream has max_age and a retention policy; unbounded JetStream is a disk incident waiting for a date.",
        "Publish with a unique message id and size the duplicate window to the replay you promise."
      ],
      "crates": [
        "async-nats",
        "tokio",
        "futures-util",
        "serde",
        "serde_json",
        "tracing",
        "bytes"
      ],
      "pitfall": "Forgetting to ack under an Explicit ack policy: the message is redelivered until max_deliver, max_ack_pending fills with stuck messages, and the consumer stops making progress while looking healthy.",
      "questions": [
        {
          "q": "Under AckPolicy::Explicit, what happens to a message the handler never acks?",
          "options": [
            "It is dropped once ack_wait elapses",
            "It is redelivered until max_deliver, holding an in-flight slot",
            "The stream deletes it and rewinds the consumer",
            "The consumer silently switches to Interest retention"
          ],
          "answer": 1,
          "explain": "Unacked messages are redelivered up to max_deliver and occupy max_ack_pending slots, so the consumer stalls while still reporting healthy."
        },
        {
          "q": "What does JetStream's duplicate window actually cover?",
          "options": [
            "End-to-end exactly-once effects on the consumer side",
            "Publishes carrying the same message id inside a bounded time window",
            "Acks persisted twice so that a lost ack cannot redeliver",
            "Consumer restarts, which then never replay a message"
          ],
          "answer": 1,
          "explain": "Dedupe is server-side, on publish, and time-bounded. A replay after the window publishes again, and a crash between effect and ack redelivers - consumers still dedupe."
        }
      ],
      "quickbytes": [
        "Share one jetstream::Context and set_timeout on it; every JetStream API call is then bounded.",
        "Nak(Some(delay)) instead of an immediate redelivery; AckKind::Term for messages that can never succeed.",
        "Size max_age and the duplicate window to the replay you are actually willing to promise."
      ],
      "github": [
        { "name": "nats.rs - async-nats client", "url": "https://github.com/nats-io/nats.rs" },
        { "name": "nats-server - JetStream broker", "url": "https://github.com/nats-io/nats-server" }
      ],
      "resources": [
        {
          "title": "async-nats crate documentation",
          "url": "https://docs.rs/async-nats/latest/async_nats/",
          "kind": "docs"
        },
        {
          "title": "async-nats JetStream context API",
          "url": "https://docs.rs/async-nats/latest/async_nats/jetstream/context/struct.Context.html",
          "kind": "docs"
        },
        {
          "title": "async-nats pull consumer configuration",
          "url": "https://docs.rs/async-nats/latest/async_nats/jetstream/consumer/pull/struct.Config.html",
          "kind": "docs"
        },
        {
          "title": "async-nats JetStream message: ack, nak, double ack",
          "url": "https://docs.rs/async-nats/latest/async_nats/jetstream/message/struct.Message.html",
          "kind": "docs"
        },
        {
          "title": "NATS official channel: JetStream and NATS internals talks",
          "url": "https://www.youtube.com/@nats_io",
          "kind": "video"
        }
      ]
    },
    {
      "id": "s05",
      "n": 5,
      "title": "Transactional outbox & idempotent consumers",
      "minutes": 110,
      "level": "industry",
      "goal": "Make a database write and an event publish atomic with the outbox pattern, then make every consumer tolerate the duplicates that pattern implies.",
      "sections": [
        {
          "h": "The dual write problem",
          "p": [
            "A service that changes a row and publishes an event has two systems to write and no shared transaction. Publish-then-commit loses the event when the commit fails; commit-then-publish loses it when the publish fails after the commit; publishing inside the database transaction does not exist because the broker is a different process. Retrying either order just moves the failure window.",
            "The outbox pattern removes the dual write. In the same local transaction that changes the aggregate, insert a row describing the event. The transaction is atomic because it touches one database. A separate relay reads unpublished outbox rows and publishes them; if the relay crashes, it simply publishes again later, which is why the system is at-least-once and consumers must be idempotent."
          ],
          "list": [
            "Publish then commit: crash before commit leaves a phantom event for a sale that never happened",
            "Commit then publish: crash before publish leaves a silent state change that no other service knows about",
            "Outbox: one transaction writes state plus the intent to publish; the relay delivers intents"
          ]
        },
        {
          "h": "The outbox table and the relay",
          "p": [
            "Keep the outbox row small: an id for ordering, a topic, a payload, and a nullable published_at. Claim a batch with SELECT ... FOR UPDATE SKIP LOCKED so several relay instances can run without stepping on each other, publish, and only then mark the rows published. Confirming the broker's delivery before the update is what makes the relay at-least-once instead of lossy.",
            "The simple version holds the transaction while publishing, which is slow but preserves ordering by id. The high-throughput version claims rows (sets a locked_until timestamp), publishes outside the transaction, then marks them, and accepts that a crash during publish produces a duplicate. Both are fine; the wrong one is marking rows first."
          ],
          "code": "// Migration (Postgres), run once:\n// CREATE TABLE outbox (\n//     id BIGSERIAL PRIMARY KEY,\n//     aggregate_type TEXT NOT NULL,\n//     aggregate_id TEXT NOT NULL,\n//     topic TEXT NOT NULL,\n//     event_type TEXT NOT NULL,\n//     payload JSONB NOT NULL,\n//     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),\n//     published_at TIMESTAMPTZ\n// );\n// CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;\n\nuse rdkafka::producer::{FutureProducer, FutureRecord};\nuse rdkafka::util::Timeout;\nuse sqlx::PgPool;\nuse std::time::Duration;\n\n#[derive(sqlx::FromRow)]\nstruct OutboxRow {\n    id: i64,\n    topic: String,\n    payload: String,\n}\n\npub async fn relay_once(\n    pool: &PgPool,\n    producer: &FutureProducer,\n) -> Result<usize, Box<dyn std::error::Error>> {\n    let mut tx = pool.begin().await?;\n    let rows = sqlx::query_as::<_, OutboxRow>(\n        r#\"\n        SELECT id, topic, payload::text AS payload\n        FROM outbox\n        WHERE published_at IS NULL\n        ORDER BY id\n        LIMIT 100\n        FOR UPDATE SKIP LOCKED\n        \"#,\n    )\n    .fetch_all(&mut *tx)\n    .await?;\n\n    for row in &rows {\n        producer\n            .send(\n                FutureRecord::to(&row.topic).payload(&row.payload),\n                Timeout::After(Duration::from_secs(5)),\n            )\n            .await\n            .map_err(|(error, _)| error)?;\n\n        sqlx::query(\"UPDATE outbox SET published_at = now() WHERE id = $1\")\n            .bind(row.id)\n            .execute(&mut *tx)\n            .await?;\n    }\n\n    tx.commit().await?;\n    Ok(rows.len())\n}",
          "tip": "Never update published_at before the broker acknowledges. A crash in that gap means no relay will ever see the row again."
        },
        {
          "h": "Idempotent consumer: dedupe in the same transaction",
          "p": [
            "The relay can publish a duplicate, a broker can redeliver after a rebalance, and a replay can resend a day of events. All three are normal. The consumer fix is a dedupe table keyed by consumer name and message id, written in the same transaction as the side effect: INSERT ... ON CONFLICT DO NOTHING, and if zero rows were inserted, the message was already handled.",
            "Two details make it correct. The message id must be stable across redeliveries - use the producer-assigned id carried in the outbox row, not a random uuid generated on each attempt. And the dedupe rows must be retained longer than the longest possible replay: if you prune them before an offset reset replays old messages, duplicates come back."
          ],
          "code": "use sqlx::PgPool;\n\npub enum Outcome {\n    Processed,\n    Duplicate,\n}\n\npub async fn project(\n    pool: &PgPool,\n    message_id: &str,\n    order_id: &str,\n    new_status: &str,\n) -> Result<Outcome, sqlx::Error> {\n    let mut tx = pool.begin().await?;\n\n    let inserted = sqlx::query(\n        r#\"\n        INSERT INTO processed_messages (consumer, message_id, processed_at)\n        VALUES ($1, $2, now())\n        ON CONFLICT (consumer, message_id) DO NOTHING\n        \"#,\n    )\n    .bind(\"order-projector\")\n    .bind(message_id)\n    .execute(&mut *tx)\n    .await?\n    .rows_affected();\n\n    if inserted == 0 {\n        tx.commit().await?;\n        return Ok(Outcome::Duplicate);\n    }\n\n    sqlx::query(\"UPDATE orders SET status = $1 WHERE id = $2\")\n        .bind(new_status)\n        .bind(order_id)\n        .execute(&mut *tx)\n        .await?;\n\n    tx.commit().await?;\n    Ok(Outcome::Processed)\n}",
          "list": [
            "processed_messages needs PRIMARY KEY (consumer, message_id) or a unique constraint",
            "Prune dedupe rows on a schedule, but always beyond topic retention plus the largest replay you allow",
            "The dedupe insert and the side effect must share one transaction, or the window reopens"
          ]
        },
        {
          "h": "Ordering, lag, and when CDC replaces the relay",
          "p": [
            "Ordering by outbox id gives per-table causal order only if one relay publishes the batch sequentially and consumers stay keyed by aggregate. Parallel relays, or a consumer that fans out across partitions, break that. Monitor outbox lag as now() minus the oldest unpublished created_at, and alert on it like any other SLO: rows silently accumulating mean nobody downstream is being told anything.",
            "Change data capture is the alternative: a connector tails the database log and turns row changes into events. It removes the polling relay and the outbox table, but moves coupling into the connector and its schema assumptions, and it cannot invent an event that was never written. Many teams run CDC for data integration and keep an explicit outbox for business events they own."
          ],
          "tip": "An outbox row is not an audit log if you prune it. If regulators need history, write a separate append-only table."
        }
      ],
      "exercise": {
        "prompt": "In one transaction, apply a payment and append the PaymentCaptured event to the outbox. Then write the consumer entry point that skips a message whose id it has already processed.",
        "starter": "use sqlx::PgPool;\n\npub async fn capture_payment(pool: &PgPool, payment_id: &str, order_id: &str) -> Result<(), sqlx::Error> {\n    let mut tx = pool.begin().await?;\n    // 1. update payments\n    // 2. insert into outbox\n    // 3. commit\n    Ok(())\n}\n\npub async fn handle_event(pool: &PgPool, message_id: &str) -> Result<bool, sqlx::Error> {\n    // return Ok(false) when this is a duplicate\n    todo!()\n}",
        "hint": "Both writes use the same &mut *tx. For dedupe: INSERT INTO processed_messages ... ON CONFLICT DO NOTHING and check rows_affected(); zero means duplicate.",
        "solution": "use sqlx::PgPool;\n\npub async fn capture_payment(pool: &PgPool, payment_id: &str, order_id: &str) -> Result<(), sqlx::Error> {\n    let mut tx = pool.begin().await?;\n\n    sqlx::query(\"UPDATE payments SET status = 'captured' WHERE id = $1\")\n        .bind(payment_id)\n        .execute(&mut *tx)\n        .await?;\n\n    let payload = serde_json::json!({\n        \"payment_id\": payment_id,\n        \"order_id\": order_id,\n        \"amount_minor\": 4999,\n    });\n\n    sqlx::query(\n        r#\"INSERT INTO outbox (aggregate_type, aggregate_id, topic, event_type, payload)\n           VALUES ('payment', $1, 'payments.events', 'PaymentCaptured', $2)\"#,\n    )\n    .bind(payment_id)\n    .bind(payload)\n    .execute(&mut *tx)\n    .await?;\n\n    tx.commit().await\n}\n\npub async fn handle_event(pool: &PgPool, message_id: &str) -> Result<bool, sqlx::Error> {\n    let mut tx = pool.begin().await?;\n    let inserted = sqlx::query(\n        r#\"INSERT INTO processed_messages (consumer, message_id, processed_at)\n           VALUES ('payment-projector', $1, now())\n           ON CONFLICT (consumer, message_id) DO NOTHING\"#,\n    )\n    .bind(message_id)\n    .execute(&mut *tx)\n    .await?\n    .rows_affected();\n\n    if inserted == 0 {\n        tx.commit().await?;\n        return Ok(false);\n    }\n\n    // side effect for this message goes here, in the same tx\n    tx.commit().await?;\n    Ok(true)\n}"
      },
      "production": [
        "The state change and the outbox insert share one transaction and one connection.",
        "The relay marks rows published only after broker acknowledgement; failures leave rows claimable.",
        "Every consumer writes its dedupe row in the same transaction as its side effect.",
        "Dedupe rows outlive the longest replay window (topic retention plus any offset reset you allow).",
        "Outbox lag is an alertable SLO, and the table is pruned by a scheduled job."
      ],
      "crates": [
        "sqlx",
        "tokio",
        "rdkafka",
        "serde",
        "serde_json",
        "uuid",
        "tracing"
      ],
      "pitfall": "Marking the outbox row published before the broker acknowledges: a crash in that gap loses the event permanently, because no relay will ever select the row again.",
      "questions": [
        {
          "q": "The relay publishes to Kafka, then crashes before setting published_at. What is the result?",
          "options": [
            "The event is lost, because the row is now claimed forever",
            "The event is published again later, so consumers must dedupe",
            "Kafka rejects the duplicate using the outbox row id",
            "The broker transaction rolls back the publish"
          ],
          "answer": 1,
          "explain": "Marking published only after the broker acknowledges makes the relay at-least-once: the crash window yields a duplicate, never a loss."
        },
        {
          "q": "Where must the dedupe insert live so that the duplicate window is actually closed?",
          "options": [
            "In its own transaction, before the side effect",
            "In the same transaction as the side effect",
            "In the broker, via a unique record key",
            "In a cache with a short TTL"
          ],
          "answer": 1,
          "explain": "One transaction makes the marker and the effect atomic. Split them and a crash in between reopens the window the dedupe table was meant to close."
        }
      ],
      "quickbytes": [
        "Insert the outbox row in the same transaction as the aggregate update; never publish from inside it.",
        "Relay order: SELECT ... FOR UPDATE SKIP LOCKED, publish, then set published_at. Never mark first.",
        "Dedupe key is (consumer, stable message id); prune only beyond topic retention plus the longest replay."
      ],
      "github": [
        { "name": "sqlx - async SQL toolkit and transactions", "url": "https://github.com/transact-rs/sqlx" },
        { "name": "rust-rdkafka - outbox relay producer", "url": "https://github.com/fede1024/rust-rdkafka" }
      ],
      "resources": [
        {
          "title": "sqlx crate documentation",
          "url": "https://docs.rs/sqlx/latest/sqlx/",
          "kind": "docs"
        },
        {
          "title": "sqlx Transaction: atomic multi-statement writes",
          "url": "https://docs.rs/sqlx/latest/sqlx/struct.Transaction.html",
          "kind": "docs"
        },
        {
          "title": "MillWheel: fault-tolerant stream processing with exactly-once semantics",
          "url": "https://research.google/pubs/millwheel-fault-tolerant-stream-processing-at-internet-scale/",
          "kind": "paper"
        },
        {
          "title": "A Conflict-Free Replicated JSON Datatype: why commutative merges make replays harmless",
          "url": "https://arxiv.org/abs/1608.03960",
          "kind": "paper"
        },
        {
          "title": "Confluent's Kafka channel: exactly-once, transactions, and delivery semantics",
          "url": "https://www.youtube.com/@Confluent",
          "kind": "video"
        }
      ]
    },
    {
      "id": "s06",
      "n": 6,
      "title": "Sagas & workflows: compensation and state",
      "minutes": 105,
      "level": "industry",
      "goal": "Replace a distributed transaction with a persisted saga: explicit states, idempotent steps, compensating actions, and timeouts that survive restarts.",
      "sections": [
        {
          "h": "Orchestration vs choreography",
          "p": [
            "A saga is a sequence of local transactions where each step has a compensating action. Choreography lets each service react to events with no central coordinator: loosely coupled, easy to add a listener, brutal to debug when the chain is five hops long and nobody can answer what state an order is in. Orchestration puts an explicit state machine in one service: it knows the step, the attempt, and the next action, at the cost of a component that must be available.",
            "Choose orchestration when the process has a clear owner and a support team that will be asked 'where is order 123?'. Choose choreography for open-ended reactions - email, analytics, search indexing - where there is no meaningful global state. Do not mix both for the same business process, or you will have two sources of truth for progress."
          ],
          "list": [
            "Orchestration: visible state, central timeout handling, simpler compensation, one more service to run",
            "Choreography: no coordinator, but global state is an emergent property you cannot query",
            "A saga is not a rollback; compensations are new forward actions that must be idempotent"
          ]
        },
        {
          "h": "Persist the state machine",
          "p": [
            "The orchestrator's state must live in its database, not in a task. Store the saga id, the current state, a version, the payload needed to compensate, and updated_at. Every transition is a conditional update: UPDATE sagas SET state=$1, version=version+1 WHERE id=$2 AND state=$3 AND version=$4. If zero rows change, another worker already moved it and yours must re-read instead of guessing.",
            "That compare-and-set is what makes duplicate deliveries and retried workers safe. It also gives you a free audit trail if you append to a saga_events table inside the same transaction, which is what an operator actually needs at 3 a.m."
          ],
          "code": "use sqlx::PgPool;\nuse uuid::Uuid;\n\n#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type)]\n#[sqlx(type_name = \"saga_state\", rename_all = \"snake_case\")]\npub enum SagaState {\n    Started,\n    Reserved,\n    Paid,\n    Completed,\n    Compensating,\n    Failed,\n}\n\npub async fn transition(\n    pool: &PgPool,\n    id: Uuid,\n    expected_version: i64,\n    from: SagaState,\n    to: SagaState,\n) -> Result<bool, sqlx::Error> {\n    let changed = sqlx::query(\n        r#\"UPDATE sagas\n           SET state = $1, version = version + 1, updated_at = now()\n           WHERE id = $2 AND state = $3 AND version = $4\"#,\n    )\n    .bind(to)\n    .bind(id)\n    .bind(from)\n    .bind(expected_version)\n    .execute(pool)\n    .await?\n    .rows_affected();\n\n    Ok(changed == 1)\n}",
          "tip": "The compare-and-set returns zero rows under a retry or a duplicate event. Treat that as 'someone else progressed', never as success."
        },
        {
          "h": "Compensating actions",
          "p": [
            "Every step that cannot be undone by simply deleting a row needs a named compensation: release the reservation, void the authorization, issue a credit. Compensations run in reverse order, must be idempotent, and can themselves fail - a payment provider can be down for an hour. So compensation has its own retry budget and, on exhaustion, a manual-intervention queue rather than a silent stop.",
            "Some steps cannot be compensated at all: sending an email, shipping a parcel, submitting a regulatory filing. Push those steps as late as possible in the saga, after every risky step has succeeded, and document them as irreversible. If an irreversible step fails, the saga is not rolled back; it is escalated, and the customer-visible flow needs a human path."
          ],
          "code": "pub async fn compensate_reservation(\n    inventory: &mut InventoryClient,\n    order_id: &str,\n    reservation_id: &str,\n    attempt: u32,\n) -> Result<(), CompensationError> {\n    // Compensations are keyed by reservation id: sending this twice\n    // releases the same reservation and is a no-op after the first success.\n    match inventory.release(reservation_id).await {\n        Ok(()) => Ok(()),\n        Err(status) if status.code() == tonic::Code::NotFound => Ok(()), // already released\n        Err(status) if attempt < 5 && is_transient(status.code()) => {\n            Err(CompensationError::Retry(status))\n        }\n        Err(status) => Err(CompensationError::NeedsOperator(status.message().to_string())),\n    }\n}\n\nfn is_transient(code: tonic::Code) -> bool {\n    matches!(code, tonic::Code::Unavailable | tonic::Code::DeadlineExceeded)\n}",
          "list": [
            "Name the compensation next to the step when you design the saga, not when it fails",
            "Compensation order is reverse order of execution, and each step must tolerate being called twice",
            "Irreversible steps go last; if one fails, escalate to a human queue instead of pretending to roll back"
          ]
        },
        {
          "h": "Timeouts without in-memory timers",
          "p": [
            "tokio::time::timeout is right for bounding a single step; it is wrong as the only mechanism for the saga, because the future dies with the process. On every restart, in-memory timers vanish and the saga sits in Reserved forever with stock held. The durable timeout is a sweeper: a periodic query for sagas whose state is non-terminal and whose updated_at is older than a per-state threshold.",
            "Two clocks matter. A per-step budget stops a hung RPC quickly and moves the saga to Compensating. A per-saga deadline catches the case where steps keep retrying forever; it should escalate, not loop. Both should be derived from the same stored timestamps so restarts and deploys cannot reset them."
          ],
          "code": "use sqlx::PgPool;\nuse tokio::time::{timeout, Duration};\n\npub async fn run_step_with_budget<F, T>(budget: Duration, step: F) -> Result<T, StepError>\nwhere\n    F: std::future::Future<Output = Result<T, StepError>>,\n{\n    match timeout(budget, step).await {\n        Ok(result) => result,\n        Err(_elapsed) => Err(StepError::TimedOut),\n    }\n}\n\npub async fn sweep_stale(pool: &PgPool) -> Result<u64, sqlx::Error> {\n    let swept = sqlx::query(\n        r#\"UPDATE sagas\n           SET state = 'compensating', version = version + 1, updated_at = now()\n           WHERE state IN ('started', 'reserved', 'paid')\n             AND updated_at < now() - interval '5 minutes'\"#,\n    )\n    .execute(pool)\n    .await?\n    .rows_affected();\n    Ok(swept)\n}",
          "tip": "Sweepers must be idempotent and safe to run on every replica; the conditional UPDATE is the lock, so no leader election is needed."
        }
      ],
      "exercise": {
        "prompt": "Persist a checkout saga and implement step_pay: transition Reserved to Paid, and on a transient payment failure move to Compensating instead of leaving the stock reservation stranded.",
        "starter": "use sqlx::PgPool;\nuse uuid::Uuid;\n\npub enum StepError {\n    Transient,\n    Permanent,\n}\n\npub async fn step_pay(pool: &PgPool, saga_id: Uuid, version: i64, amount_minor: i64) -> Result<(), StepError> {\n    // 1. call the payment provider\n    // 2. on success: transition Reserved -> Paid with compare-and-set\n    // 3. on transient error: transition Reserved -> Compensating\n    todo!()\n}",
        "hint": "Reuse transition(pool, id, version, SagaState::Reserved, SagaState::Paid). If the provider returns a transient error, call transition with Compensating. A false return means another worker already moved the saga.",
        "solution": "use sqlx::PgPool;\nuse uuid::Uuid;\n\n#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type)]\n#[sqlx(type_name = \"saga_state\", rename_all = \"snake_case\")]\npub enum SagaState {\n    Started,\n    Reserved,\n    Paid,\n    Completed,\n    Compensating,\n    Failed,\n}\n\npub enum StepError {\n    Transient,\n    Permanent,\n}\n\nasync fn transition(\n    pool: &PgPool,\n    id: Uuid,\n    version: i64,\n    from: SagaState,\n    to: SagaState,\n) -> Result<bool, sqlx::Error> {\n    let changed = sqlx::query(\n        r#\"UPDATE sagas SET state = $1, version = version + 1, updated_at = now()\n           WHERE id = $2 AND state = $3 AND version = $4\"#,\n    )\n    .bind(to)\n    .bind(id)\n    .bind(from)\n    .bind(version)\n    .execute(pool)\n    .await?\n    .rows_affected();\n    Ok(changed == 1)\n}\n\npub async fn step_pay(\n    pool: &PgPool,\n    saga_id: Uuid,\n    version: i64,\n    amount_minor: i64,\n) -> Result<(), StepError> {\n    match charge(amount_minor).await {\n        Ok(_capture_id) => {\n            let moved = transition(pool, saga_id, version, SagaState::Reserved, SagaState::Paid)\n                .await\n                .map_err(|_| StepError::Transient)?;\n            if !moved {\n                return Err(StepError::Transient); // re-read and retry the step\n            }\n            Ok(())\n        }\n        Err(ChargeError::Transient) => {\n            transition(pool, saga_id, version, SagaState::Reserved, SagaState::Compensating)\n                .await\n                .map_err(|_| StepError::Transient)?;\n            Err(StepError::Transient)\n        }\n        Err(ChargeError::Declined) => {\n            transition(pool, saga_id, version, SagaState::Reserved, SagaState::Failed)\n                .await\n                .map_err(|_| StepError::Transient)?;\n            Err(StepError::Permanent)\n        }\n    }\n}\n\nenum ChargeError {\n    Transient,\n    Declined,\n}\n\nasync fn charge(_amount_minor: i64) -> Result<String, ChargeError> {\n    Ok(String::from(\"capture_123\"))\n}"
      },
      "production": [
        "Saga state is persisted with an optimistic version; in-memory state is never the source of truth.",
        "Every non-reversible step has a named, idempotent compensation defined at design time.",
        "Stuck sagas are found by a sweeper on stale updated_at, not by process-local timers.",
        "The saga id is propagated through every RPC and event so a partial trace can be reconstructed.",
        "Sagas exceeding their deadline go to an operator queue; silent abandonment is a bug."
      ],
      "crates": [
        "sqlx",
        "tokio",
        "serde",
        "serde_json",
        "thiserror",
        "uuid",
        "tracing"
      ],
      "pitfall": "Keeping the saga in memory and scheduling its timeout with tokio::time::sleep: a deploy or crash drops the timer, and the saga is stuck forever holding a stock reservation nobody will release.",
      "questions": [
        {
          "q": "Why must every compensating action be idempotent?",
          "options": [
            "Because the coordinator runs each compensation exactly once",
            "Because retries and duplicate deliveries can run it more than once",
            "Because the database automatically rolls back the first attempt",
            "Because compensations are always executed in parallel"
          ],
          "answer": 1,
          "explain": "Compensations are retried, and the same message can be delivered twice. Releasing the same reservation twice must be a no-op, or stock is credited back twice."
        },
        {
          "q": "A saga transition UPDATE reports zero rows affected. What does that mean?",
          "options": [
            "The database is unavailable and the statement must be retried",
            "Another worker already moved the saga, so re-read before acting",
            "The saga is complete and its row can be deleted",
            "The version column has overflowed its range"
          ],
          "answer": 1,
          "explain": "Zero rows means state or version no longer matched the compare-and-set: a concurrent transition won. Re-read the saga; never treat zero rows as success."
        }
      ],
      "quickbytes": [
        "Transition with UPDATE ... WHERE id=$1 AND state=$2 AND version=$3; zero rows means someone else won.",
        "No in-memory timers: a sweeper on stale updated_at recovers sagas across deploys and crashes.",
        "Define each compensation next to its step, and push irreversible steps such as email or shipment last."
      ],
      "github": [
        { "name": "sqlx - transactions and compare-and-set", "url": "https://github.com/transact-rs/sqlx" },
        { "name": "tokio - timeouts, select, and runtime", "url": "https://github.com/tokio-rs/tokio" }
      ],
      "resources": [
        {
          "title": "Tokio tutorial: select, cancellation, and timeouts",
          "url": "https://tokio.rs/tokio/tutorial/select",
          "kind": "docs"
        },
        {
          "title": "tokio::time: sleep, timeout, interval",
          "url": "https://docs.rs/tokio/latest/tokio/time/index.html",
          "kind": "docs"
        },
        {
          "title": "sqlx crate documentation",
          "url": "https://docs.rs/sqlx/latest/sqlx/",
          "kind": "docs"
        },
        {
          "title": "Camunda channel: saga orchestration, compensation, and workflow engines",
          "url": "https://www.youtube.com/@Camunda",
          "kind": "video"
        }
      ]
    },
    {
      "id": "s07",
      "n": 7,
      "title": "Retries, backoff & dead-letter queues",
      "minutes": 85,
      "level": "industry",
      "goal": "Retry only what is safe to retry, back off with jitter inside a deadline, and route poison messages to a DLQ with enough context to fix them.",
      "sections": [
        {
          "h": "Classify before you retry",
          "p": [
            "Retrying is safe only when the operation is idempotent or carries an idempotency key the server enforces. A timeout is not evidence of failure: the request may have committed and only the response was lost. Retrying a non-idempotent charge on DEADLINE_EXCEEDED is how customers get billed twice. Make the operation idempotent first, then add retries.",
            "Classify errors explicitly. Transient: UNAVAILABLE, DEADLINE_EXCEEDED, connection reset, 429, 503. Permanent: INVALID_ARGUMENT, NOT_FOUND, ALREADY_EXISTS, PERMISSION_DENIED, schema violations, malformed payload. Retrying a permanent error turns one failure into N failures plus load, and delays the alarm that would have shown you the real bug.",
            "Finally, bound the whole attempt sequence by the caller's remaining budget. A retry policy that can run for 30 seconds inside a request with a 2 second deadline is not resilience, it is a queue of doomed work."
          ],
          "list": [
            "Idempotency key on the request, unique constraint on the server, replay returns the original result",
            "Retry only transient codes, and only while budget remains",
            "Every retry emits a metric; a retry rate spike is an incident signal"
          ]
        },
        {
          "h": "Exponential backoff with full jitter",
          "p": [
            "Fixed delays synchronize clients: a thousand replicas retry at the same millisecond and the recovering service falls over again. Exponential backoff spreads attempts over time, and jitter removes the synchronization that remains when clients fail together. Full jitter - sleep a uniform random duration between zero and the capped exponential - is the version that survives a real outage.",
            "Cap the delay, cap the attempts, and cap the total time. The cap should relate to the caller's deadline, not to a number someone liked. For a user-facing request that means a handful of attempts and a small cap; for a background worker it can be minutes, but the attempt count must still end."
          ],
          "code": "use rand::Rng;\nuse std::time::Duration;\n\nconst BASE: Duration = Duration::from_millis(200);\nconst CAP: Duration = Duration::from_secs(10);\n\n/// Full jitter: uniform in [0, min(CAP, BASE * 2^attempt)].\npub fn backoff(attempt: u32) -> Duration {\n    let exp = BASE.saturating_mul(1u32 << attempt.min(10));\n    let capped = exp.min(CAP);\n    let jitter_ms = rand::rng().random_range(0..=capped.as_millis() as u64);\n    Duration::from_millis(jitter_ms)\n}",
          "tip": "Full jitter can produce a near-zero delay. That is fine: the distribution, not every individual wait, is what protects the server."
        },
        {
          "h": "Dead-letter queues with context",
          "p": [
            "A DLQ is where messages go when retrying cannot help. It must carry enough context to act without re-reading the whole system: original topic and partition, original offset, the consumer group, the attempt count, the last error, and the first-seen timestamp. A DLQ without a redrive path is just a slower way to lose data.",
            "Alarm on DLQ depth and on growth rate from the first message. Redrive is a separate, reviewed tool: it resolves the payload against a fixed consumer, rate-limits the replay, and refuses to redrive messages newer than the deployed fix. Never build an automatic loop that alternates between DLQ and main topic without a cap, because that is a poison-message amplifier."
          ],
          "code": "pub async fn send_to_dlq(\n    producer: &rdkafka::producer::FutureProducer,\n    original_topic: &str,\n    partition: i32,\n    offset: i64,\n    attempts: u32,\n    error: &str,\n    payload: &[u8],\n) -> Result<(), String> {\n    let partition = partition.to_string();\n    let offset = offset.to_string();\n    let attempts = attempts.to_string();\n\n    let headers = rdkafka::message::OwnedHeaders::new()\n        .insert(rdkafka::message::Header {\n            key: \"x-original-topic\",\n            value: Some(original_topic.as_bytes()),\n        })\n        .insert(rdkafka::message::Header {\n            key: \"x-original-partition\",\n            value: Some(partition.as_bytes()),\n        })\n        .insert(rdkafka::message::Header {\n            key: \"x-original-offset\",\n            value: Some(offset.as_bytes()),\n        })\n        .insert(rdkafka::message::Header {\n            key: \"x-attempts\",\n            value: Some(attempts.as_bytes()),\n        })\n        .insert(rdkafka::message::Header {\n            key: \"x-last-error\",\n            value: Some(error.as_bytes()),\n        });\n\n    let dlq_topic = format!(\"{original_topic}.dlq\");\n    let record = rdkafka::producer::FutureRecord::to(&dlq_topic)\n        .payload(payload)\n        .headers(headers);\n\n    producer\n        .send(record, rdkafka::util::Timeout::After(std::time::Duration::from_secs(5)))\n        .await\n        .map(|_| ())\n        .map_err(|(error, _)| error.to_string())\n}",
          "tip": "A DLQ message without the original offset cannot be redriven without guessing; write the headers while you still have them."
        },
        {
          "h": "Redelivery limits are broker-specific",
          "p": [
            "Kafka has no native retry topic or DLQ. Producer retries are internal and bounded by delivery.timeout.ms; consumer-side retry is your design. Common options are a retry topic with a delay (retry.5s, retry.30s), a consumer-side attempts table, or blocking the partition briefly and then publishing to the DLQ. Blocking a partition is the simplest and the most dangerous: it stops every key in that partition.",
            "JetStream gives you the knobs directly: max_deliver caps redelivery, ack_wait sets the redelivery timer, and an exhausted message simply stops being delivered - so a consumer must notice the delivery count and forward it to a DLQ itself. Whatever the broker, the invariant is the same: bounded attempts, bounded time, and an explicit terminal destination."
          ],
          "list": [
            "Kafka retry topics preserve ordering by key but multiply partitions and lag to monitor",
            "JetStream max_deliver without a DLQ step means the message is silently dropped after the last attempt",
            "Blocking a partition to retry one message is a last resort, not a default"
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement a bounded retry helper: up to 5 attempts, full-jitter exponential backoff capped at 10 seconds, retry only transient errors, and publish the payload to a DLQ when attempts are exhausted.",
        "starter": "use rand::Rng;\nuse std::time::Duration;\n\npub fn backoff(attempt: u32) -> Duration {\n    // full jitter, base 200ms, cap 10s\n    todo!()\n}\n\npub async fn with_retries<F, Fut, T>(mut op: F, dlq_payload: &[u8]) -> Result<T, String>\nwhere\n    F: FnMut() -> Fut,\n    Fut: std::future::Future<Output = Result<T, RetryError>>,\n{\n    // 5 attempts, sleep backoff between them, DLQ on exhaustion\n    todo!()\n}",
        "hint": "Loop 0..5. On RetryError::Transient and attempts remaining, tokio::time::sleep(backoff(attempt)).await. On the last failure, send_to_dlq(topic, payload) and return Err.",
        "solution": "use rand::Rng;\nuse std::time::Duration;\n\npub fn backoff(attempt: u32) -> Duration {\n    let exp = Duration::from_millis(200).saturating_mul(1u32 << attempt.min(10));\n    let capped = exp.min(Duration::from_secs(10));\n    let jitter_ms = rand::rng().random_range(0..=capped.as_millis() as u64);\n    Duration::from_millis(jitter_ms)\n}\n\npub enum RetryError {\n    Transient(String),\n    Permanent(String),\n}\n\npub async fn with_retries<F, Fut, T>(mut op: F, dlq: &DlqSender) -> Result<T, String>\nwhere\n    F: FnMut() -> Fut,\n    Fut: std::future::Future<Output = Result<T, RetryError>>,\n{\n    let mut last_error = String::from(\"no attempt made\");\n    for attempt in 0..5u32 {\n        match op().await {\n            Ok(value) => return Ok(value),\n            Err(RetryError::Permanent(error)) => {\n                dlq.send(error.as_bytes()).await?;\n                return Err(error);\n            }\n            Err(RetryError::Transient(error)) if attempt + 1 < 5 => {\n                last_error = error;\n                tokio::time::sleep(backoff(attempt)).await;\n            }\n            Err(RetryError::Transient(error)) => {\n                last_error = error;\n                break;\n            }\n        }\n    }\n\n    dlq.send(last_error.as_bytes()).await?;\n    Err(last_error)\n}\n\npub struct DlqSender;\n\nimpl DlqSender {\n    pub async fn send(&self, _payload: &[u8]) -> Result<(), String> {\n        Ok(())\n    }\n}"
      },
      "production": [
        "Only retry operations that are idempotent or carry an enforced idempotency key.",
        "Every retry budget is bounded by the caller's deadline, never by a fixed sleep chain.",
        "Full jitter on every delay; fixed retries synchronize replicas and hammer a recovering service.",
        "Poison messages go to a DLQ with topic, partition, offset, attempts, and last error; depth is alarmed.",
        "Redrive is a reviewed, rate-limited tool, not an automatic loop between DLQ and topic."
      ],
      "crates": [
        "tokio",
        "rand",
        "rdkafka",
        "thiserror",
        "tracing",
        "serde"
      ],
      "pitfall": "Retrying a non-idempotent charge after DEADLINE_EXCEEDED: the first call may have succeeded after the deadline fired, so the retry bills the customer twice with no error anywhere in the logs.",
      "questions": [
        {
          "q": "A charge RPC returns DEADLINE_EXCEEDED. When is a retry safe?",
          "options": [
            "Always: a timeout proves the server did nothing",
            "Only when the charge is idempotent or carries an enforced idempotency key",
            "Always, provided the retry happens within 100 ms",
            "Never: DEADLINE_EXCEEDED is a permanent status"
          ],
          "answer": 1,
          "explain": "A deadline is not proof of failure - the write may have landed after the client stopped waiting. Make the operation idempotent before you retry it."
        },
        {
          "q": "Why prefer full jitter over a fixed exponential delay?",
          "options": [
            "It guarantees a minimum wait between attempts",
            "It decorrelates clients that failed together, avoiding retry storms",
            "It removes the need to cap attempts or total time",
            "It makes retry timing deterministic and easy to assert in tests"
          ],
          "answer": 1,
          "explain": "Randomizing each delay spreads a fleet's retries across time. Fixed delays re-synchronize replicas, so a recovering service is hit by every client at once."
        }
      ],
      "quickbytes": [
        "Retry UNAVAILABLE, DEADLINE_EXCEEDED, 429, and 503; treat INVALID_ARGUMENT, NOT_FOUND, and PERMISSION_DENIED as terminal.",
        "Full jitter: sleep uniform(0, min(cap, base * 2^attempt)); also cap attempts and total time.",
        "DLQ headers: original topic, partition, offset, attempts, last error, first-seen - without them redrive is guesswork."
      ],
      "github": [
        { "name": "rust-rdkafka - producer retries and DLQ publishing", "url": "https://github.com/fede1024/rust-rdkafka" },
        { "name": "rand - jitter source", "url": "https://github.com/rust-random/rand" }
      ],
      "resources": [
        {
          "title": "gRPC guide: retry policy, backoff, and retry throttling",
          "url": "https://grpc.io/docs/guides/retry/",
          "kind": "docs"
        },
        {
          "title": "rdkafka producer module: retries and delivery timeouts",
          "url": "https://docs.rs/rdkafka/latest/rdkafka/producer/index.html",
          "kind": "docs"
        },
        {
          "title": "tokio::time: sleep and timeout primitives",
          "url": "https://docs.rs/tokio/latest/tokio/time/index.html",
          "kind": "docs"
        },
        {
          "title": "The Tail at Scale: why retries and fan-out amplify latency tails",
          "url": "https://research.google/pubs/the-tail-at-scale/",
          "kind": "paper"
        },
        {
          "title": "CNCF channel: KubeCon talks on resilience, retries, and failure injection",
          "url": "https://www.youtube.com/@cncf",
          "kind": "video"
        }
      ]
    },
    {
      "id": "s08",
      "n": 8,
      "title": "Distributed locks, leases & fencing tokens",
      "minutes": 90,
      "level": "industry",
      "goal": "Use Postgres advisory locks and leases without leaking them, critique Redis locks with primary sources, and make stale holders harmless with fencing tokens.",
      "sections": [
        {
          "h": "Postgres advisory locks, and the pool trap",
          "p": [
            "Postgres has two advisory lock scopes. Session-level pg_advisory_lock is held until the same session unlocks it or disconnects, so it is dangerous with a connection pool: if the pooled connection is returned while the lock is held, the lock stays held by a connection that now serves other requests, and no one can tell which one. Transaction-level pg_try_advisory_xact_lock is released automatically at commit or rollback and is the default choice.",
            "The lock key is a bigint you choose - derive it from a stable hash of the resource name, never from a random value. Use the try variant with a bounded retry, not the blocking variant, or a single stuck worker can pin a pool connection forever waiting for a lock it will never get."
          ],
          "code": "use sqlx::{PgPool, Postgres, Transaction};\n\npub async fn acquire_xact_lock(\n    tx: &mut Transaction<'_, Postgres>,\n    lock_key: i64,\n) -> Result<bool, sqlx::Error> {\n    sqlx::query_scalar(\"SELECT pg_try_advisory_xact_lock($1)\")\n        .bind(lock_key)\n        .fetch_one(&mut **tx)\n        .await\n}\n\npub async fn reserve(pool: &PgPool, lock_key: i64, sku: &str) -> Result<bool, sqlx::Error> {\n    let mut tx = pool.begin().await?;\n\n    // The lock dies with this transaction: no session to leak, no unlock to forget.\n    if !acquire_xact_lock(&mut tx, lock_key).await? {\n        tx.rollback().await?;\n        return Ok(false);\n    }\n\n    sqlx::query(\"UPDATE inventory SET reserved = reserved + 1 WHERE sku = $1\")\n        .bind(sku)\n        .execute(&mut *tx)\n        .await?;\n\n    tx.commit().await?;\n    Ok(true)\n}",
          "tip": "Never call blocking pg_advisory_lock without a lock_timeout; a forgotten unlock becomes an outage that outlives the deploy that caused it."
        },
        {
          "h": "Redis locks and Redlock, from the source",
          "p": [
            "The single-instance Redis lock is SET resource_name token NX PX 30000: set if absent, expire after 30s, and store a random token. Release must compare the token before deleting, with a Lua script or the newer DELEX helper, otherwise a client that overran its TTL deletes someone else's lock. The Redis documentation says this plainly, and also says why replication makes the failover version unsound.",
            "Redlock tries to fix that by acquiring on N independent masters and requiring a majority. The Redis page states the remaining assumptions itself: a bounded clock-drift rate across nodes, lock validity computed from elapsed local time, and the warning that Redis does not use a monotonic clock for TTL expiry, so a wall-clock shift can let two clients hold the lock. It also ends with a recommendation to implement fencing tokens and not to assume a lock is retained while the holder is alive. A paused process - GC, VM live migration, SIGSTOP - can wake up after its lease expired and write anyway; no lock protocol that relies on the holder checking time can prevent that."
          ],
          "list": [
            "Async replication failover: client A holds the lock on the master, the master crashes before the write replicates, the replica is promoted, client B acquires the same lock - the Redis docs call this a safety violation",
            "Redlock narrows but does not remove the window; it assumes nodes fail independently and clocks drift slowly",
            "Lease expiry plus a slow holder is the general failure; the fix is fencing, not a better TTL"
          ]
        },
        {
          "h": "Fencing tokens make stale holders harmless",
          "p": [
            "A fencing token is a monotonically increasing number issued on every lock grant. Every write to the protected resource carries the token, and the resource stores the highest token it has seen and rejects anything lower. A holder whose lease expired and who wakes up late is rejected by the storage layer, not by its own clock, so correctness no longer depends on timing.",
            "This turns the lock into a performance optimization: it prevents most concurrent work, while the token enforces the invariant. That is also why the shared resource must be the one validating the token - Postgres rejecting an UPDATE where fence <= last_fence is a real guarantee; a Redis key expiring is not."
          ],
          "code": "use sqlx::PgPool;\n\n/// Returns the new fence, or None when the resource has already seen a newer holder.\npub async fn reserve_with_fence(\n    pool: &PgPool,\n    sku: &str,\n    quantity: i32,\n    fence: i64,\n) -> Result<Option<i64>, sqlx::Error> {\n    let updated = sqlx::query(\n        r#\"UPDATE inventory\n           SET reserved = reserved + $1,\n               last_fence = $2\n           WHERE sku = $3 AND last_fence < $2\"#,\n    )\n    .bind(quantity)\n    .bind(fence)\n    .bind(sku)\n    .execute(pool)\n    .await?\n    .rows_affected();\n\n    Ok((updated == 1).then_some(fence))\n}",
          "tip": "Store the fence in the same row you mutate. Two statements - check fence, then write - reintroduce the race the fence was meant to remove."
        },
        {
          "h": "Lease renewal and the honest limits",
          "p": [
            "A lease is a lock with an expiry, so it needs renewal: renew at roughly one third of the TTL, and treat a failed renewal as loss of the lease immediately - stop work, do not finish the batch, because your successor may already be running. Renewal reduces the chance of a stale holder but cannot eliminate it, which is why the fence stays.",
            "Be honest about what a lock buys. It serializes work and saves wasted effort; it does not make an unsafe operation safe. Idempotent writes plus a fencing token are the invariant; the lock is the optimization that keeps two workers from doing the same thing most of the time. Document any remaining tolerance for a rare double-holder instead of hoping it never happens."
          ],
          "list": [
            "TTL = crash recovery time; shorter TTL means faster failover and more renewals",
            "Renewal failure is lease loss: stop mutating immediately and re-acquire before continuing",
            "The resource validates the fence; the lock service only issues tokens"
          ],
          "tip": "If the write path is idempotent and fenced, a rare double-holder is a performance bug, not a data-corruption incident."
        }
      ],
      "exercise": {
        "prompt": "Implement acquire_lease: take a transaction-scoped advisory lock, bump and return a fencing token, and run a guarded update that rejects any caller whose fence is not newer than the last accepted one.",
        "starter": "use sqlx::PgPool;\n\npub async fn acquire_lease(pool: &PgPool, name: &str) -> Result<Option<i64>, sqlx::Error> {\n    // 1. begin a transaction\n    // 2. pg_try_advisory_xact_lock(hash of name)\n    // 3. UPDATE lock_fences SET fence = fence + 1 ... RETURNING fence\n    todo!()\n}\n\npub async fn guarded_write(pool: &PgPool, name: &str, fence: i64) -> Result<bool, sqlx::Error> {\n    // reject fence <= last_fence in the same statement\n    todo!()\n}",
        "hint": "Use pg_try_advisory_xact_lock(hashtext($1)) and UPDATE lock_fences SET fence = fence + 1 WHERE name = $1 RETURNING fence. For the write, include AND last_fence < $2 in the UPDATE and check rows_affected().",
        "solution": "use sqlx::PgPool;\n\npub async fn acquire_lease(pool: &PgPool, name: &str) -> Result<Option<i64>, sqlx::Error> {\n    let mut tx = pool.begin().await?;\n\n    let acquired: bool = sqlx::query_scalar(\"SELECT pg_try_advisory_xact_lock(hashtext($1))\")\n        .bind(name)\n        .fetch_one(&mut *tx)\n        .await?;\n\n    if !acquired {\n        tx.rollback().await?;\n        return Ok(None);\n    }\n\n    let fence: Option<i64> = sqlx::query_scalar(\n        \"UPDATE lock_fences SET fence = fence + 1 WHERE name = $1 RETURNING fence\",\n    )\n    .bind(name)\n    .fetch_optional(&mut *tx)\n    .await?;\n\n    tx.commit().await?;\n    Ok(fence)\n}\n\npub async fn guarded_write(pool: &PgPool, name: &str, fence: i64) -> Result<bool, sqlx::Error> {\n    let updated = sqlx::query(\n        r#\"UPDATE lock_fences\n           SET last_accepted_at = now()\n           WHERE name = $1 AND last_fence < $2\"#,\n    )\n    .bind(name)\n    .bind(fence)\n    .execute(pool)\n    .await?\n    .rows_affected();\n\n    Ok(updated == 1)\n}"
      },
      "production": [
        "Advisory locks are held on a dedicated connection or transaction; session locks are never taken from a pool checkout that could be returned.",
        "Any correctness-critical section validates a fencing token in the same statement that mutates state.",
        "Leases renew at roughly TTL/3, and a failed renewal stops work immediately.",
        "Redis or Redlock is used only where a rare double-holder is tolerable, and that assumption is documented.",
        "Lock waits are bounded with lock_timeout or the try variants; a stuck worker cannot pin a pool connection forever."
      ],
      "crates": [
        "sqlx",
        "tokio",
        "uuid",
        "thiserror",
        "tracing"
      ],
      "pitfall": "Taking a session-level pg_advisory_lock through a pooled connection and returning the connection to the pool: the lock stays held by that pooled session and every other worker waits forever while the pool reports idle connections.",
      "questions": [
        {
          "q": "A worker's lease expires while it is paused in GC, then it resumes and writes. What prevents corruption?",
          "options": [
            "A shorter TTL on the lock, so the pause is detected sooner",
            "A fencing token that the storage layer checks on every write",
            "Deleting the lock key before the worker writes",
            "Renewing the lease immediately after the write completes"
          ],
          "answer": 1,
          "explain": "Only the resource rejecting stale tokens makes a paused holder harmless. TTLs and renewals rely on the holder's own clock, which is exactly what the pause broke."
        },
        {
          "q": "Why is a session-level pg_advisory_lock dangerous when taken from a pool?",
          "options": [
            "It blocks every other session on the database",
            "The lock survives when the connection returns to the pool, so ownership is unclear",
            "It is released automatically at the end of every statement",
            "It cannot be acquired inside a transaction"
          ],
          "answer": 1,
          "explain": "Pooled connections are reused. A leaked session lock is held by whichever request borrows that connection next, while the pool reports idle connections."
        }
      ],
      "quickbytes": [
        "Use pg_try_advisory_xact_lock(hashtext($1)); it dies with the transaction, so a pool cannot leak it.",
        "Validate the fence in the same UPDATE that mutates state: WHERE last_fence < $2.",
        "Renew leases at about TTL/3; a failed renewal means stop work, not finish the batch."
      ],
      "github": [
        { "name": "sqlx - advisory locks and guarded updates", "url": "https://github.com/transact-rs/sqlx" },
        { "name": "redis - SET NX PX and token-checked release", "url": "https://github.com/redis/redis" }
      ],
      "resources": [
        {
          "title": "Redis docs: distributed locks and the Redlock analysis",
          "url": "https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/",
          "kind": "docs"
        },
        {
          "title": "sqlx crate documentation",
          "url": "https://docs.rs/sqlx/latest/sqlx/",
          "kind": "docs"
        },
        {
          "title": "tokio::time: leases, renewal, and timeouts",
          "url": "https://docs.rs/tokio/latest/tokio/time/index.html",
          "kind": "docs"
        },
        {
          "title": "In Search of an Understandable Consensus Algorithm (Raft paper)",
          "url": "https://raft.github.io/raft.pdf",
          "kind": "paper"
        },
        {
          "title": "John Ousterhout: Raft consensus lecture (CS@Illinois)",
          "url": "https://www.youtube.com/watch?v=vYp4LYbnnW8",
          "kind": "video"
        }
      ]
    },
    {
      "id": "s09",
      "n": 9,
      "title": "Service discovery & client-side load balancing",
      "minutes": 95,
      "level": "advanced",
      "goal": "Resolve instances at runtime, balance gRPC calls per request instead of per connection, and keep endpoint churn from turning into failed calls.",
      "sections": [
        {
          "h": "A ClusterIP balances connections, not requests",
          "p": [
            "A Kubernetes Service is a stable virtual IP, and kube-proxy programs iptables or IPVS rules that choose a backend when a connection is opened. An HTTP/2 gRPC channel opens one long-lived TCP connection and multiplexes every RPC over it, so all of that client's calls land on a single pod until the connection dies. Ten clients can therefore mean ten pods at a tenth of the load each, or all ten pinned to one pod that melts.",
            "The fix is a headless Service (`clusterIP: None`), where DNS returns the addresses of ready pods instead of one virtual IP, plus a client that resolves and balances per request. Decide who balances by asking who knows request cost: only the caller knows a call is a 2 ms lookup or a 400 ms report, so per-request balancing belongs in the client or in an L7 proxy that understands the protocol."
          ],
          "list": [
            "ClusterIP: one backend chosen per connection, invisible to the client",
            "Headless Service: DNS returns ready pod addresses, the client decides",
            "L7 proxy or mesh: per-request choice at the cost of one more network hop",
            "Watch endpoint changes instead of polling DNS; TTL caches serve dead pod IPs"
          ],
          "tip": "If one pod runs at 90% CPU while its siblings idle, suspect a per-connection balancer before you suspect the scheduler."
        },
        {
          "h": "Discovery is a stream, not a lookup",
          "p": [
            "A DNS record survives its TTL, so a pod IP that died thirty seconds ago is still returned until that cache expires, and calls fail in the window. Watching the platform's endpoint list gives you a push instead: addresses appear when a pod becomes ready and disappear before it terminates. gRPC separates these concerns already, with a resolver that emits an address list and a balancer that consumes it.",
            "tonic exposes that model through `Channel::balance_channel`, which hands you a sender of endpoint additions and removals, and the simpler `Channel::balance_list` for a snapshot. Both dial lazily: an address is registered immediately and connected on first use, so a replica that is still booting does not fail startup and becomes usable on its first successful handshake."
          ],
          "code": `use std::time::Duration;
use tonic::transport::{Channel, Endpoint};

/// One channel per caller, built from whatever discovery returned.
/// balance_list dials lazily, so a booting replica is not a startup error.
pub fn channel(addrs: &[String]) -> Channel {
    let endpoints = addrs.iter().map(|addr| {
        Endpoint::from_shared(addr.clone())
            .expect("discovery returned a malformed URI")
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_millis(800))
            .tcp_keepalive(Some(Duration::from_secs(30)))
    });

    Channel::balance_list(endpoints)
}`,
          "tip": "connect_timeout bounds the dial; timeout bounds the RPC. Set both, or a black-holed pod consumes the whole request budget before the first byte."
        },
        {
          "h": "Power of two choices beats round robin",
          "p": [
            "Round robin assumes every request costs the same, so a hot or slow replica still receives its share and gets slower. p2c samples two ready endpoints and sends to the one with fewer in-flight requests, which self-corrects under skew; tower's `Balance` implements it and requires each endpoint service to implement `Load` so it can read that count. At low concurrency p2c degrades toward random, which is still safer than pinning.",
            "Two things break it. Readiness that lies: a pod reporting ready before migrations finish receives traffic and returns 500s, which looks like a balancer bug. And retries that re-pick an endpoint without a budget, which pile load onto the healthy subset and can turn a partial failure into a total one. Balancing is a latency optimisation; correctness still comes from deadlines, idempotency keys, and routing to the right shard."
          ],
          "list": [
            "p2c needs an in-flight count per endpoint, not the pod's CPU usage",
            "Readiness must include migrations and pool state, not just process liveness",
            "Retrying on a different endpoint is safe only with an idempotency key",
            "Alert on per-pod request share: a flat median hides a pinned balancer"
          ]
        }
      ],
      "exercise": {
        "prompt": "Build a channel from a discovery snapshot, plus a refresh step that rebuilds it only when the set of addresses actually changed, so a steady state does not drop the connection pool on every poll.",
        "starter": `use tonic::transport::Channel;

pub struct Resolver {
    endpoints: Vec<String>,
    channel: Channel,
}

impl Resolver {
    pub fn new(endpoints: Vec<String>) -> Self {
        // 1. sort/dedup the snapshot
        // 2. build one balancer over it
        todo!()
    }

    pub fn refresh(&mut self, next: Vec<String>) -> bool {
        // 3. compare as sets; rebuild only on change, return whether you did
        todo!()
    }

    pub fn channel(&self) -> Channel {
        self.channel.clone()
    }
}`,
        "hint": "Normalise both lists with sort + dedup, compare with ==, and only then call Channel::balance_list again. Rebuilding on every poll throws away healthy connections and pays a handshake per request.",
        "solution": `use std::time::Duration;
use tonic::transport::{Channel, Endpoint};

pub struct Resolver {
    endpoints: Vec<String>,
    channel: Channel,
}

fn build(endpoints: &[String]) -> Channel {
    let eps = endpoints.iter().map(|uri| {
        Endpoint::from_shared(uri.clone())
            .expect("discovery returned a malformed URI")
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_millis(800))
    });
    Channel::balance_list(eps)
}

fn normalise(mut next: Vec<String>) -> Vec<String> {
    next.sort();
    next.dedup();
    next
}

impl Resolver {
    pub fn new(endpoints: Vec<String>) -> Self {
        let endpoints = normalise(endpoints);
        let channel = build(&endpoints);
        Self { endpoints, channel }
    }

    /// Returns true when the pool was rebuilt. A steady-state poll must
    /// return false: rebuilding drops healthy HTTP/2 connections.
    pub fn refresh(&mut self, next: Vec<String>) -> bool {
        let next = normalise(next);
        if next == self.endpoints {
            return false;
        }
        self.channel = build(&next);
        self.endpoints = next;
        true
    }

    pub fn channel(&self) -> Channel {
        self.channel.clone()
    }
}`
      },
      "production": [
        "Readiness reflects migrations and database reachability, never just process liveness.",
        "Every endpoint has connect_timeout, a per-RPC timeout, and TCP keepalive set.",
        "Channels are rebuilt on an address-set change, never per request or per poll.",
        "Per-pod request share is a dashboard line, because aggregate latency hides pinning.",
        "Cross-endpoint retries require an idempotency key, not just a transient status code."
      ],
      "crates": [
        "tonic",
        "tower",
        "tokio",
        "tracing"
      ],
      "pitfall": "Rebuilding `Channel::balance_list` on every DNS poll: each rebuild discards the connection pool, so every request pays a fresh TCP and TLS handshake and p99 becomes handshake latency.",
      "questions": [
        {
          "q": "A gRPC client sends all of its traffic to one pod behind a ClusterIP Service. Why?",
          "options": [
          "kube-proxy rewrites each individual RPC to a different backend pod",
          "The HTTP/2 connection is pinned to one backend, and every RPC multiplexes over it",
          "gRPC ignores DNS and connects to the service name as a single host",
          "The client's connection pool defaults to one connection per service"
          ],
          "answer": 1,
          "explain": "A virtual IP picks a backend when the connection is established. One long-lived HTTP/2 connection therefore means one backend, no matter how many requests share it."
        },
        {
          "q": "What does a p2c balancer need from each endpoint to choose well?",
          "options": [
          "A load metric such as the in-flight request count",
          "Static weights declared in the deployment manifest",
          "The pod's CPU usage scraped from the kubelet",
          "A round-robin cursor shared across replicas"
          ],
          "answer": 0,
          "explain": "p2c compares two candidates by observed load, so each endpoint service implements Load. Declared weights cannot react to a slow replica at runtime."
        },
        {
          "q": "Why does `Channel::balance_list` help during a rolling deploy?",
          "options": [
          "It retries failed RPCs on a different endpoint automatically",
          "It caches DNS answers indefinitely so lookups stop",
          "It bypasses TLS for pods that are not ready yet",
          "It registers addresses without blocking startup and dials each on first use"
          ],
          "answer": 3,
          "explain": "Lazy dialling turns a booting replica into a registered-but-unconnected endpoint instead of a startup failure. It does not add retries; those remain the caller's policy."
        }
      ],
      "quickbytes": [
        "Headless Service plus client-side balancing for gRPC; a ClusterIP pins one HTTP/2 connection to one pod.",
        "Rebuild the channel only when the address set changes - a rebuild resets the connection pool.",
        "Set connect_timeout, per-RPC timeout, and TCP keepalive on every Endpoint; missing one hides a failure mode."
      ],
      "github": [
        { "name": "grpc-rust (tonic): channel, resolver, and balancer", "url": "https://github.com/grpc/grpc-rust" },
        { "name": "tower: p2c Balance and Discover", "url": "https://github.com/tower-rs/tower" }
      ],
      "resources": [
        {
          "title": "tonic Channel: balance_list, balance_channel, lazy dialling",
          "url": "https://docs.rs/tonic/latest/tonic/transport/channel/struct.Channel.html",
          "kind": "docs"
        },
        {
          "title": "tower p2c Balance and the Discover trait",
          "url": "https://docs.rs/tower/latest/tower/balance/p2c/struct.Balance.html",
          "kind": "docs"
        },
        {
          "title": "Kubernetes DNS for Services and Pods: headless Services",
          "url": "https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/",
          "kind": "docs"
        },
        {
          "title": "tower: middleware and load balancing in Rust",
          "url": "https://github.com/tower-rs/tower",
          "kind": "repo"
        },
        {
          "title": "CNCF channel: KubeCon talks on service discovery and gRPC balancing",
          "url": "https://www.youtube.com/@cncf",
          "kind": "video"
        }
      ]
    },
    {
      "id": "s10",
      "n": 10,
      "title": "API gateway: edge concerns, not business logic",
      "minutes": 90,
      "level": "industry",
      "goal": "Put authentication, request identity, rate limits, and the root deadline at the edge, and keep business rules next to the data they decide on.",
      "sections": [
        {
          "h": "The edge owns four things",
          "p": [
            "An API gateway terminates TLS, authenticates the caller, assigns a request id, and enforces a coarse rate limit. Those four are genuinely cross-cutting: implemented per service, they drift, and the weakest copy becomes the real policy. Authentication produces a principal - tenant, subject, scopes. Authorization that depends on domain state, such as whether this user may refund this order, belongs in the service that owns the order.",
            "The gateway is also the right place to translate the public contract into internal calls: REST and JSON outside, gRPC inside, with one mapping from status codes to the public error shape. That mapping is part of the contract. An unauthenticated caller must see 401, not a 500 that leaks a tonic status string and a stack trace."
          ],
          "list": [
            "Terminate TLS once at the edge; use mTLS or workload identity behind it",
            "Forward the principal as signed claims, never as a raw header the client can set",
            "Strip inbound X-Forwarded-* and hop-by-hop headers, then set your own",
            "Cap body size and header count before the request reaches a service"
          ],
          "tip": "A gateway that reads a database is a service. A service in the request path of everything is a single point of failure with extra steps."
        },
        {
          "h": "Edge layers, and one budget that shrinks",
          "p": [
            "An edge timeout longer than the client's patience is decoration; one shorter than the work cancels requests that were about to succeed. Set the edge budget first, pass the remainder downstream as a gRPC deadline, and refuse a request whose remaining budget is below the cost of a single useful call instead of spending it on a doomed one.",
            "Retries at the edge are the most dangerous kind, because they multiply traffic before any per-service breaker observes it. A gateway that retries `POST /orders` on a 502 creates two orders unless the client supplied an idempotency key that the service enforces."
          ],
          "code": `use std::time::Duration;

use axum::http::HeaderName;
use axum::routing::post;
use axum::Router;
use tower::ServiceBuilder;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

fn request_id() -> HeaderName {
    HeaderName::from_static("x-request-id")
}

async fn place_order() -> &'static str {
    "accepted"
}

pub fn app() -> Router {
    Router::new().route("/v1/orders", post(place_order)).layer(
        ServiceBuilder::new()
            // Identity first: every log line and quota below depends on it.
            .layer(SetRequestIdLayer::new(request_id(), MakeRequestUuid))
            .layer(PropagateRequestIdLayer::new(request_id()))
            // Whole-request budget, shorter than any client's patience.
            .layer(TimeoutLayer::new(Duration::from_millis(1500)))
            // Refuse oversized bodies before they are buffered in memory.
            .layer(RequestBodyLimitLayer::new(256 * 1024))
            .layer(TraceLayer::new_for_http()),
    )
}`,
          "tip": "Layers run outside-in. Put the request id before tracing so every span and log line already carries it."
        },
        {
          "h": "Composition is not a gateway feature",
          "p": [
            "Aggregation is the gateway's most tempting mistake. A `/checkout` view that fans out to orders, inventory, and pricing and merges JSON puts three dependencies in the request path of every route's deploy, makes the gateway's failure domain the whole product, and makes its latency the slowest hop plus overhead.",
            "Keep the gateway a policy layer: routing, authentication, quotas, observability, protocol translation. If a view genuinely needs composition, give it a backend-for-frontend that owns that UI's contract and can be deployed and scaled with the UI, rather than welding it into the component every team depends on."
          ],
          "list": [
            "Policy at the edge: TLS, authn, quotas, request ids, error mapping",
            "Domain decisions in the owning service: refunds, stock, credit",
            "Composition in a BFF scoped to one client surface",
            "Per-tenant quotas at the edge supplement, never replace, per-service limits"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write the edge budget helper: turn the request's absolute edge deadline into the budget for one downstream gRPC call, capped per call, and refuse to start a call that has less than 50 ms left.",
        "starter": `use std::time::{Duration, Instant};

pub const MIN_USEFUL: Duration = Duration::from_millis(50);
pub const PER_CALL_CAP: Duration = Duration::from_millis(800);

/// Returns None when the remaining budget cannot pay for a useful call.
pub fn remaining_budget(edge_deadline: Instant, now: Instant) -> Option<Duration> {
    // 1. saturating difference
    // 2. floor at MIN_USEFUL, cap at PER_CALL_CAP
    todo!()
}`,
        "hint": "Use edge_deadline.saturating_duration_since(now), return None below MIN_USEFUL, otherwise Some(left.min(PER_CALL_CAP)). Saturating arithmetic matters: a deadline that already passed must not panic.",
        "solution": `use std::time::{Duration, Instant};

pub const MIN_USEFUL: Duration = Duration::from_millis(50);
pub const PER_CALL_CAP: Duration = Duration::from_millis(800);

/// Returns None when the remaining budget cannot pay for a useful call.
/// The cap stops one slow dependency from consuming a budget meant for
/// three sequential calls.
pub fn remaining_budget(edge_deadline: Instant, now: Instant) -> Option<Duration> {
    let left = edge_deadline.saturating_duration_since(now);
    if left < MIN_USEFUL {
        return None;
    }
    Some(left.min(PER_CALL_CAP))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_a_generous_budget() {
        let now = Instant::now();
        let got = remaining_budget(now + Duration::from_secs(5), now).expect("budget");
        assert_eq!(got, PER_CALL_CAP);
    }

    #[test]
    fn refuses_a_spent_budget() {
        let now = Instant::now();
        assert!(remaining_budget(now + Duration::from_millis(10), now).is_none());
    }
}`
      },
      "production": [
        "Inbound identity headers are stripped; the principal is injected from a verified token or signature.",
        "The edge timeout is the smallest budget in the system, and every downstream call gets the remainder.",
        "Retried unsafe methods require a client-supplied idempotency key enforced by the service.",
        "Body size, header count, and connection limits are set at the edge and tested with an oversized request.",
        "The gateway holds no database and no domain rules; a review rejects any new one."
      ],
      "crates": [
        "axum",
        "tower",
        "tower-http",
        "tonic"
      ],
      "pitfall": "Forwarding the caller's `X-User-Id` and `X-Forwarded-For` untouched: a client sets its own identity header, every downstream service trusts it, and authorization is now client-controlled.",
      "questions": [
        {
          "q": "Which decision belongs in the gateway rather than in each service?",
          "options": [
          "Whether this customer may refund order 123",
          "Whether the caller's signed token is valid and unexpired",
          "How much stock to reserve for an SKU",
          "Which saga step runs after payment fails"
          ],
          "answer": 1,
          "explain": "Token validation is identical for every route and has no domain input. Refund eligibility, stock, and saga order need the owning service's state and invariants."
        },
        {
          "q": "Why is retrying `POST /orders` at the edge dangerous?",
          "options": [
          "HTTP/2 forbids retrying requests on a new connection",
          "gRPC metadata cannot carry a retry count",
          "Retries at the edge bypass TLS and lose the client certificate",
          "Without an enforced idempotency key the retry can create a second order"
          ],
          "answer": 3,
          "explain": "A 502 says the response was lost, not that the write failed. Only an idempotency key enforced by the order service makes the retry safe."
        },
        {
          "q": "The gateway has 1500 ms for a request that already spent 200 ms. What budget should the inventory RPC get?",
          "options": [
          "Another 1500 ms, so inventory has a fair chance",
          "5000 ms, so the call cannot fail",
          "The remainder, capped per call - for example 800 ms, not 1300",
          "No deadline; the edge timeout will cancel it"
          ],
          "answer": 2,
          "explain": "Budgets shrink along the call path and each hop is capped. Handing a downstream call a fresh full budget guarantees it can outlive the request it serves."
        }
      ],
      "quickbytes": [
        "Authenticate at the edge, authorize where the data is; never trust an inbound identity header.",
        "The edge timeout is the root budget: propagate the remainder as a gRPC deadline, never a fresh one.",
        "Cap body and header size at the edge; a 10 MB JSON body is a memory incident, not a request."
      ],
      "github": [
        { "name": "tower-http: timeouts, request ids, limits, tracing", "url": "https://github.com/tower-rs/tower-http" },
        { "name": "axum: routing and middleware composition", "url": "https://github.com/tokio-rs/axum" }
      ],
      "resources": [
        {
          "title": "tower-http: timeout, request-id, body limit, trace layers",
          "url": "https://docs.rs/tower-http/latest/tower_http/",
          "kind": "docs"
        },
        {
          "title": "gRPC guide: deadlines and propagation",
          "url": "https://grpc.io/docs/guides/deadlines/",
          "kind": "docs"
        },
        {
          "title": "Kubernetes Ingress: routing and TLS termination at the edge",
          "url": "https://kubernetes.io/docs/concepts/services-networking/ingress/",
          "kind": "docs"
        },
        {
          "title": "tower-http repository",
          "url": "https://github.com/tower-rs/tower-http",
          "kind": "repo"
        },
        {
          "title": "InfoQ channel: gateway, BFF, and API design talks",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        }
      ]
    },
    {
      "id": "s11",
      "n": 11,
      "title": "Circuit breaking between services",
      "minutes": 85,
      "level": "advanced",
      "goal": "Detect a failing dependency from a rolling failure rate, fail fast while it is down, and probe it carefully on the way back.",
      "sections": [
        {
          "h": "Closed, open, half-open",
          "p": [
            "A breaker is a state machine around one dependency. Closed: calls pass and outcomes are recorded. Open: calls fail immediately without touching the network, which protects the caller's budget and gives the dependency room to recover. Half-open: a small number of probes pass; a success closes the breaker, a failure re-opens it for another wait.",
            "The window matters more than the threshold. A lifetime counter opens on a burst of errors from hours ago and stays open; a rolling window of the last N outcomes reflects now. recloser keeps a ring buffer of the last `closed_len` calls and only evaluates the failure rate once that buffer is full, which also prevents opening on the first three requests of a deploy."
          ],
          "list": [
            "Closed: record outcomes, pass traffic",
            "Open: reject immediately, no connection attempt, no deadline spent",
            "Half-open: a bounded probe set decides between closed and open",
            "One breaker per dependency, and per shard when a shard can fail alone"
          ],
          "tip": "If your breaker state is per-process, remember each replica learns about the outage separately; that is fine, but it means recovery is a fleet-wide ramp, not a single switch."
        },
        {
          "h": "Count failures, not everything",
          "p": [
            "Only failures that indicate the dependency is unhealthy should count: `UNAVAILABLE`, connection refused, 503, and timeouts past the budget. `INVALID_ARGUMENT` and `NOT_FOUND` are the caller's fault, and counting them means one client's bad deploy opens the breaker for every other caller of a perfectly healthy service. recloser accepts an `ErrorPredicate`, implemented for `Fn(&E) -> bool`, so a match arm decides what counts.",
            "Tune the threshold against the traffic you actually see. A 50% failure rate over at least 32 calls in the window opens on a real outage; 10% opens on routine noise, and 90% lets a dependency burn the full deadline before anyone reacts."
          ],
          "code": `use std::time::Duration;

use recloser::{AsyncRecloser, Error, Recloser};
use tonic::Code;

/// One breaker per dependency. Reuse it: constructing one per call
/// resets the window and the breaker never opens.
pub fn breaker() -> AsyncRecloser {
    AsyncRecloser::from(
        Recloser::custom()
            .error_rate(0.5)                  // open at 50% failures
            .closed_len(32)                   // ...after 32 outcomes
            .half_open_len(4)                 // 4 probes decide recovery
            .open_wait(Duration::from_secs(10))
            .build(),
    )
}

/// Only transport failures say the dependency is unhealthy.
pub fn is_dependency_failure(code: &Code) -> bool {
    matches!(code, Code::Unavailable | Code::DeadlineExceeded)
}

pub async fn get_order(
    breaker: &AsyncRecloser,
    client: &mut orders_client::OrdersClient<tonic::transport::Channel>,
    order_id: String,
) -> Result<Order, String> {
    let call = client.get_order(GetOrderRequest { order_id });

    match breaker.call(call).await {
        Ok(response) => Ok(response.into_inner().order.expect("order present")),
        Err(Error::Rejected) => Err("orders: breaker open, failing fast".to_string()),
        Err(Error::Inner(status)) => Err(format!("orders: {status}")),
    }
}`,
          "tip": "A breaker you construct per request has no memory. Store it in the client struct, next to the channel it protects."
        },
        {
          "h": "Breakers interact with retries and recovery",
          "p": [
            "A breaker without a retry budget turns one outage into a fast one: every call is rejected cheaply, the caller's retry loop retries, and the retry is rejected too - cheap in latency, expensive in CPU, logs, and alert noise. When the breaker is open, stop the retry loop and return a degraded result or a 503 with `Retry-After`; do not let the loop discover the breaker N times.",
            "Recovery has its own herd. Half-open probes are the thundering herd in miniature, so keep `half_open_len` small and jitter the open window so replicas do not all probe in the same millisecond. Re-opening with the same fixed wait oscillates: back the open window off exponentially while probes keep failing, and reset it after a sustained success."
          ],
          "list": [
            "Retry policy asks the breaker first; an open breaker ends the attempt sequence",
            "Jitter the open window, or every replica probes in lockstep",
            "Decide who owns retries: the client, the mesh, or the gateway - never all three",
            "Emit breaker state transitions as events, and alert on flapping"
          ]
        }
      ],
      "exercise": {
        "prompt": "Configure a synchronous breaker that opens at a 50% failure rate after 32 outcomes and half-opens after 10 seconds, and wrap a fallible call so `INVALID_ARGUMENT` never counts as a dependency failure.",
        "starter": `use std::time::Duration;

use recloser::{Error, Recloser};
use tonic::Code;

pub fn breaker() -> Recloser {
    // error_rate, closed_len, half_open_len, open_wait
    todo!()
}

pub fn is_dependency_failure(code: &Code) -> bool {
    todo!()
}

pub fn call_dependency(
    breaker: &Recloser,
    attempt: impl FnOnce() -> Result<String, Code>,
) -> Result<String, String> {
    // use call_with so only is_dependency_failure is recorded
    todo!()
}`,
        "hint": "Recloser::custom().error_rate(0.5).closed_len(32).half_open_len(4).open_wait(Duration::from_secs(10)).build(). Then breaker.call_with(is_dependency_failure, attempt) and map Error::Rejected and Error::Inner separately.",
        "solution": `use std::time::Duration;

use recloser::{Error, Recloser};
use tonic::Code;

pub fn breaker() -> Recloser {
    Recloser::custom()
        .error_rate(0.5)
        .closed_len(32)
        .half_open_len(4)
        .open_wait(Duration::from_secs(10))
        .build()
}

/// A bad request says nothing about dependency health, so it must not
/// be recorded; enough of them would open the breaker for everyone.
pub fn is_dependency_failure(code: &Code) -> bool {
    matches!(code, Code::Unavailable | Code::DeadlineExceeded)
}

pub fn call_dependency(
    breaker: &Recloser,
    attempt: impl FnOnce() -> Result<String, Code>,
) -> Result<String, String> {
    match breaker.call_with(is_dependency_failure, attempt) {
        Ok(value) => Ok(value),
        Err(Error::Rejected) => Err("dependency open: failing fast".to_string()),
        Err(Error::Inner(code)) => Err(format!("dependency error: {code}")),
    }
}`
      },
      "production": [
        "One long-lived breaker per dependency, stored beside the client, never built per call.",
        "Only transient transport failures count; domain errors never move the state machine.",
        "Open-state responses are immediate and carry Retry-After, so callers stop retrying.",
        "Half-open probe count and open-window jitter are configured explicitly.",
        "State transitions are logged with the dependency name and the observed failure rate."
      ],
      "crates": [
        "recloser",
        "tonic",
        "tokio",
        "tracing"
      ],
      "pitfall": "A single global breaker for a sharded dependency: one failing shard opens the breaker for every shard, converting a partial outage into a total one.",
      "questions": [
        {
          "q": "The breaker is open. What should a call do?",
          "options": [
          "Wait for the open window to elapse, then call normally",
          "Return immediately with a degraded result or a 503 carrying Retry-After",
          "Probe the dependency once on every request",
          "Retry three times with exponential backoff"
          ],
          "answer": 1,
          "explain": "An open breaker exists to stop spending budget and to stop loading a failing dependency. Probing is the half-open state's job, bounded to a few calls."
        },
        {
          "q": "Why must `INVALID_ARGUMENT` not count as a dependency failure?",
          "options": [
          "The transport retries it automatically",
          "It is always followed by an UNAVAILABLE status",
          "gRPC reports it as a successful response with an error field",
          "It says the request is wrong, so counting it would open the breaker against a healthy service"
          ],
          "answer": 3,
          "explain": "Breaker state should describe dependency health. Malformed requests are a client bug, and enough of them would take a healthy dependency out of rotation."
        },
        {
          "q": "Why cap the number of half-open probes?",
          "options": [
          "Each probe is billed twice by the provider",
          "Half-open has no failure accounting",
          "An unbounded probe set is the full load arriving at a dependency that is still recovering",
          "Probes bypass the deadline and hang"
          ],
          "answer": 2,
          "explain": "Half-open is a controlled experiment. Sending full traffic the moment the window expires re-creates the overload that opened the breaker."
        }
      ],
      "quickbytes": [
        "A breaker built per request never opens: it has no window, so store it beside the client.",
        "Record only Unavailable, DeadlineExceeded, and 503; domain errors must not move the state machine.",
        "Jitter the open window and cap half-open probes, or recovery itself becomes a retry storm."
      ],
      "github": [
        { "name": "recloser: concurrent circuit breaker with ring buffers", "url": "https://github.com/lerouxrgd/recloser" },
        { "name": "tower: load shedding, timeouts, and limits", "url": "https://github.com/tower-rs/tower" }
      ],
      "resources": [
        {
          "title": "recloser crate documentation: states, error_rate, AsyncRecloser",
          "url": "https://docs.rs/recloser/latest/recloser/",
          "kind": "docs"
        },
        {
          "title": "tower: load balancing, limits, and load shedding",
          "url": "https://docs.rs/tower/latest/tower/",
          "kind": "docs"
        },
        {
          "title": "recloser source: ring buffers and half-open accounting",
          "url": "https://github.com/lerouxrgd/recloser",
          "kind": "repo"
        },
        {
          "title": "The Tail at Scale: why retries and fan-out amplify latency tails",
          "url": "https://research.google/pubs/the-tail-at-scale/",
          "kind": "paper"
        },
        {
          "title": "CNCF channel: resilience, failure injection, and outage retros",
          "url": "https://www.youtube.com/@cncf",
          "kind": "video"
        }
      ]
    },
    {
      "id": "s12",
      "n": 12,
      "title": "Evolving event schemas without breaking consumers",
      "minutes": 90,
      "level": "advanced",
      "goal": "Classify every schema change as wire-compatible or breaking, encode the policy in CI, and migrate consumers with upcasters instead of a flag day.",
      "sections": [
        {
          "h": "Compatibility is three questions",
          "p": [
            "For a produced event, ask three things: can an old consumer read a new message, can a new consumer read an old message, and does the meaning survive? Protobuf answers the first two mechanically - unknown fields are preserved, missing fields take defaults - and says nothing about the third. Renaming `total_cents` to `total_minor_units` with the same tag is wire-compatible and semantically catastrophic if the unit also changed.",
            "JSON is stricter in one direction and looser in the other. Adding a field is safe only if every consumer ignores unknown fields; making a field required breaks every producer that has not shipped the change yet. Encode the rule in CI - `buf breaking` for protobuf, a golden-message test for JSON payloads - because a policy that lives in a wiki is a policy that gets skipped on the Friday deploy."
          ],
          "list": [
            "Wire-compatible: new field with a fresh tag, new RPC, new enum value with a default arm",
            "Breaking: reuse a tag, change a field's type, remove a required field, redefine a unit",
            "Consumer hazard: strict deserialization turns an additive change into an outage",
            "Gate it: buf breaking against the published package, and a fixture per schema version"
          ]
        },
        {
          "h": "Presence, defaults, and the zero problem",
          "p": [
            "In proto3 a plain scalar has no presence: `total_minor_units = 0` and an absent field serialize identically, so a consumer cannot distinguish \"not sent\" from \"sent zero\". Rules like `if total == 0 { recompute }` are then a silent data bug. Marking the field `optional` restores explicit presence, and prost generates `Option<i64>` for it - a type change that forces every reader to decide.",
            "Defaults also hide additions. A new `currency` field defaulting to an empty string is worse than absent, because `if currency.is_empty()` becomes plausible-looking validation in three services. Make the new field required by contract even when the wire type cannot enforce it, and reject messages that omit it at the consumer boundary."
          ],
          "code": `syntax = "proto3";

package acme.orders.v1;

message OrderPlaced {
  string order_id = 1;
  int64 total_minor_units = 2;
  string currency = 3;             // added in v1.3; never infer it
  optional string coupon_code = 4; // presence matters: absent != ""

  reserved 5, 6;
  reserved "legacy_total", "customer_email";
}`,
          "tip": "Reserve the tag and the name in the same commit that deletes the field. A later edit that reuses tag 5 makes old and new readers decode different data from identical bytes."
        },
        {
          "h": "Upcast on read, not on replay",
          "p": [
            "When a change cannot be additive - a split field, a unit change, an entity rename - do not rewrite history in the topic. Store events as they were written and upcast on read: one pure function per version hop, from a `serde_json::Value` or a schema-tagged envelope to the current type. The chain is unit-testable, and a replay of last year's topic still works.",
            "The version marker belongs inside the payload, not in the topic name. Topic-per-version multiplies partitions, consumers, and lag dashboards, and destroys per-key ordering across versions, which is exactly the ordering you needed. Keep one topic per event type, a `schema_version` field, and a checked-in fixture for every version you have ever written."
          ],
          "code": `use serde_json::Value;

/// v1 stored a bare i64 in cents. v2 makes the unit explicit.
/// Upcasters are total: default what you can, fail only on corruption.
pub fn upcast(mut event: Value) -> Result<Value, String> {
    let version = event
        .get("schema_version")
        .and_then(Value::as_u64)
        .unwrap_or(1);

    if version == 1 {
        event = v1_to_v2(event)?;
    }

    Ok(event)
}

fn v1_to_v2(mut event: Value) -> Result<Value, String> {
    let cents = event["total_cents"].take();
    let Some(cents) = cents.as_i64() else {
        return Err("v1 event without an integer total_cents".to_string());
    };

    event["total_minor_units"] = Value::from(cents);
    event["currency"] = Value::String("USD".to_string());
    event["schema_version"] = Value::from(2);
    Ok(event)
}`,
          "tip": "Test the upcaster against a stored fixture of every version. A fixture you cannot produce is a version you can no longer replay."
        }
      ],
      "exercise": {
        "prompt": "Write an upcaster chain that takes a JSON event with a `schema_version` field, applies one hop per version until it reaches v3, and rejects an unknown future version instead of silently passing it through.",
        "starter": `use serde_json::Value;

pub fn upcast(event: Value) -> Result<Value, String> {
    // 1. read schema_version, defaulting to 1
    // 2. apply v1_to_v2, then v2_to_v3
    // 3. error on versions you do not know
    todo!()
}`,
        "hint": "Loop while version < 3 with a match on the current version. Return Err for anything above 3: a consumer that silently accepts a future schema is a consumer producing wrong data from fields it does not understand.",
        "solution": `use serde_json::Value;

pub fn upcast(mut event: Value) -> Result<Value, String> {
    let mut version = event
        .get("schema_version")
        .and_then(Value::as_u64)
        .unwrap_or(1);

    while version < 3 {
        event = match version {
            1 => v1_to_v2(event)?,
            2 => v2_to_v3(event)?,
            other => return Err(format!("no upcaster from version {other}")),
        };
        version += 1;
    }

    if version > 3 {
        return Err(format!("unsupported future schema version {version}"));
    }

    Ok(event)
}

fn v1_to_v2(mut event: Value) -> Result<Value, String> {
    let cents = event["total_cents"].take();
    let Some(cents) = cents.as_i64() else {
        return Err("v1 event without an integer total_cents".to_string());
    };
    event["total_minor_units"] = Value::from(cents);
    event["currency"] = Value::String("USD".to_string());
    event["schema_version"] = Value::from(2);
    Ok(event)
}

fn v2_to_v3(mut event: Value) -> Result<Value, String> {
    // v3 replaced the free-text status with a small enum.
    let status = event["status"].take();
    let mapped = match status.as_str() {
        Some("paid") => "PAID",
        Some("shipped") => "SHIPPED",
        Some("pending") => "PENDING",
        _ => return Err("v2 event with an unknown status".to_string()),
    };
    event["status"] = Value::String(mapped.to_string());
    event["schema_version"] = Value::from(3);
    Ok(event)
}`
      },
      "production": [
        "CI runs a breaking-change check against the published package before any contract merge.",
        "Retired proto tags and names are reserved in the same commit that removes them.",
        "Every consumer deserializes leniently on unknown fields, and validates required fields itself.",
        "Schema versions live in the payload, with a stored fixture per version and an upcaster test.",
        "A field whose meaning changes gets a new tag, never the old one with a new interpretation."
      ],
      "crates": [
        "prost",
        "serde",
        "serde_json",
        "tonic"
      ],
      "pitfall": "Topic-per-version as the versioning strategy: per-key ordering across versions disappears, every consumer must read N topics, and the old topics are never deleted.",
      "questions": [
        {
          "q": "Which change is safe to ship inside the same protobuf package version?",
          "options": [
          "Reusing tag 5 for a new field after deleting the old one",
          "Adding `optional string coupon_code = 7`, a tag never used before",
          "Changing `int64 total` to `double total` so fractions fit",
          "Renaming a field and giving the old name a different meaning"
          ],
          "answer": 1,
          "explain": "A fresh tag with a new field is additive and decodable by every old reader. Reusing a tag or changing a wire type makes identical bytes decode differently across versions."
        },
        {
          "q": "Why is `#[serde(deny_unknown_fields)]` risky on an event consumer?",
          "options": [
          "Any additive field from a newer producer becomes a hard failure in every stale consumer",
          "It makes deserialization slower",
          "It disables default values for missing fields",
          "It rewrites the payload before validation"
          ],
          "answer": 0,
          "explain": "Producers must be free to add fields. A consumer that rejects unknown fields turns every producer deploy into a potential consumer outage."
        },
        {
          "q": "In proto3, what does an absent `int64 total_minor_units` look like to a consumer?",
          "options": [
          "It deserializes as -1 so absence is detectable",
          "It fails to decode and the record is dropped",
          "It is indistinguishable from a value of 0",
          "It appears as a null pointer and panics"
          ],
          "answer": 2,
          "explain": "Plain proto3 scalars have no presence: 0 and absent are the same bytes. That is why zero-means-recompute logic is a silent data bug, and why `optional` exists."
        }
      ],
      "quickbytes": [
        "Additive only: fresh tags, new RPCs, new enum values with a default arm in every consumer.",
        "Reserve the tag and the name in the same commit that deletes a field, and run buf breaking in CI.",
        "Upcast on read with a payload schema_version and a stored fixture per version; never version by topic."
      ],
      "github": [
        { "name": "buf: protobuf linting and breaking-change detection", "url": "https://github.com/bufbuild/buf" },
        { "name": "protobuf: language guide, wire format, presence", "url": "https://github.com/protocolbuffers/protobuf" }
      ],
      "resources": [
        {
          "title": "prost: generated types, optional fields, and reserved tags",
          "url": "https://docs.rs/prost/latest/prost/",
          "kind": "docs"
        },
        {
          "title": "serde_json: Value manipulation and lenient struct decoding",
          "url": "https://docs.rs/serde_json/latest/serde_json/",
          "kind": "docs"
        },
        {
          "title": "buf: breaking-change policies for protobuf packages",
          "url": "https://github.com/bufbuild/buf",
          "kind": "repo"
        },
        {
          "title": "Protocol Buffers: proto3 language guide and wire format",
          "url": "https://github.com/protocolbuffers/protobuf",
          "kind": "repo"
        },
        {
          "title": "Confluent channel: schema evolution, registries, and compatibility modes",
          "url": "https://www.youtube.com/@Confluent",
          "kind": "video"
        }
      ]
    },
    {
      "id": "s13",
      "n": 13,
      "title": "Consumer lag: measure per partition, scale on it",
      "minutes": 90,
      "level": "industry",
      "goal": "Compute lag from watermarks and positions, alert on the partition that is stuck rather than the group average, and autoscale without exceeding the partition count.",
      "sections": [
        {
          "h": "Lag is per partition, and the average lies",
          "p": [
            "Lag for a partition is the log-end offset minus the group's committed offset: how many records are waiting. A group's headline number is usually a sum, and a sum hides the shape. One partition stuck at 400k records while eleven sit at zero is a different incident from a uniform 30k, and a thirty-second spike during a rebalance is not an incident at all.",
            "Measure time lag too, when record timestamps are trustworthy: now minus the timestamp of the next record to be consumed. Message lag says nothing about seconds when message sizes change or traffic arrives in bursts. A 100k backlog on a 10k/s topic is ten seconds; the same backlog on a 10/s topic is nearly three hours."
          ],
          "list": [
            "Sum of lag: one number for a dashboard, never for an alert",
            "Max per-partition lag: catches the single stuck partition",
            "Time lag: converts records into seconds of delay the customer experiences",
            "Rebalance spikes are expected; a plateau that does not drain is not"
          ],
          "tip": "Alert on lag that has not decreased for ten minutes, not on lag above an absolute number: a busy topic legitimately runs with thousands queued."
        },
        {
          "h": "Reading it from the client",
          "p": [
            "librdkafka knows the assignment and the fetch position; the broker knows the watermarks. `position()` returns the next offset to consume per assigned partition, and `fetch_watermarks(topic, partition, timeout)` returns the low and high watermarks. Lag is `high - position`, and `Offset::to_raw` tells you whether the position is a concrete offset yet.",
            "The committed offset is what survives a restart, so a consumer that has fetched far ahead but commits rarely shows a smaller lag than the group's real exposure. Compute lag only for partitions the consumer currently owns: reporting zero for unassigned partitions during a rebalance is worse than reporting nothing, because it looks like recovery."
          ],
          "code": `use std::time::Duration;

use rdkafka::consumer::{Consumer, StreamConsumer};

#[derive(Debug)]
pub struct PartitionLag {
    pub partition: i32,
    pub lag: i64,
}

/// Lag for the partitions this consumer owns. Partitions without a concrete
/// position (Stored, Invalid) are skipped rather than reported as zero.
pub fn assigned_lag(
    consumer: &StreamConsumer,
    topic: &str,
    timeout: Duration,
) -> Result<Vec<PartitionLag>, rdkafka::error::KafkaError> {
    let mut out = Vec::new();

    for elem in consumer.position()?.elements() {
        let Some(consumed) = elem.offset().to_raw() else {
            continue;
        };
        let (_, high) = consumer.fetch_watermarks(topic, elem.partition(), timeout)?;
        out.push(PartitionLag {
            partition: elem.partition(),
            lag: (high - consumed).max(0),
        });
    }

    Ok(out)
}`,
          "tip": "Watermark calls are broker round trips. Sample them on a timer (10-30 s) and cache the result; a metrics scrape per partition per second is its own traffic problem."
        },
        {
          "h": "Autoscaling with a ceiling",
          "p": [
            "Lag-based autoscaling works because lag is queue depth and queue depth maps to workers. What matters is the mechanics: a scale-up threshold well above steady state, a longer scale-down window because flapping costs more than one extra replica, and a maximum that never exceeds the partition count. Consumers beyond that count sit idle in the group holding no partitions, which looks like capacity and adds nothing.",
            "Never scale on the sum alone. Scale on the number of partitions above a threshold or on max per-partition lag, and cap the step so a poison message inflating one partition does not spawn fifty pods that all block on the same partition. Rebalances pause consumption; a burst after every scale event is expected, so compare lag after the group stabilises."
          ],
          "code": `#[derive(Debug, PartialEq, Eq)]
pub enum Scale {
    Up(u32),
    Hold,
    Down(u32),
}

/// Hysteresis plus a hard ceiling at the partition count: more replicas
/// than partitions cannot help, they just idle in the group.
pub fn decide(current: u32, max_lag: i64, partitions: u32, min: u32, max: u32) -> Scale {
    let ceiling = partitions.min(max).max(min);

    if max_lag > 50_000 && current < ceiling {
        let step = ((max_lag / 50_000) as u32).clamp(1, 2);
        return Scale::Up((current + step).min(ceiling));
    }

    if max_lag < 5_000 && current > min {
        return Scale::Down((current - 1).max(min));
    }

    Scale::Hold
}`,
          "tip": "Two thresholds, not one: scale up above 50k, scale down below 5k. A single threshold flaps on every rebalance."
        }
      ],
      "exercise": {
        "prompt": "Summarise a consumer group's backlog: return the per-partition lag for the partitions this consumer owns, plus the maximum lag, so an alert can fire on the stuck partition rather than the sum.",
        "starter": `use std::time::Duration;

use rdkafka::consumer::StreamConsumer;

#[derive(Debug)]
pub struct LagReport {
    pub per_partition: Vec<(i32, i64)>,
    pub max: i64,
    pub total: i64,
}

pub fn report(
    consumer: &StreamConsumer,
    topic: &str,
    timeout: Duration,
) -> Result<LagReport, rdkafka::error::KafkaError> {
    // 1. position() -> elements
    // 2. fetch_watermarks per partition
    // 3. lag = high - consumed, clamped at 0
    todo!()
}`,
        "hint": "Skip elements whose Offset::to_raw() is None. Clamp negatives with .max(0): a watermark can move backwards during truncation or an unclean leader election.",
        "solution": `use std::time::Duration;

use rdkafka::consumer::{Consumer, StreamConsumer};

#[derive(Debug)]
pub struct LagReport {
    pub per_partition: Vec<(i32, i64)>,
    pub max: i64,
    pub total: i64,
}

pub fn report(
    consumer: &StreamConsumer,
    topic: &str,
    timeout: Duration,
) -> Result<LagReport, rdkafka::error::KafkaError> {
    let mut per_partition = Vec::new();

    for elem in consumer.position()?.elements() {
        let Some(consumed) = elem.offset().to_raw() else {
            continue; // Stored or Invalid: not a concrete offset yet
        };
        let (_, high) = consumer.fetch_watermarks(topic, elem.partition(), timeout)?;
        let lag = (high - consumed).max(0);
        per_partition.push((elem.partition(), lag));
    }

    let max = per_partition.iter().map(|(_, lag)| *lag).max().unwrap_or(0);
    let total = per_partition.iter().map(|(_, lag)| *lag).sum();

    Ok(LagReport {
        per_partition,
        max,
        total,
    })
}`
      },
      "production": [
        "Lag is emitted per partition and per consumer group, with the assigned partition set as the label.",
        "Alerts fire on max per-partition lag and on lag that has not decreased for ten minutes.",
        "Time lag is measured when record timestamps are producer-controlled, and is the SLO customers see.",
        "The autoscaler's maximum equals the partition count, and scale-down has a longer window than scale-up.",
        "Rebalance rate is a dashboard line; frequent rebalances explain lag spikes that look like load."
      ],
      "crates": [
        "rdkafka",
        "tokio",
        "tracing",
        "serde"
      ],
      "pitfall": "Alerting on the group's total lag: a single partition stuck behind a poison message hides inside eleven healthy partitions, and the alert never fires while that key's events age for hours.",
      "questions": [
        {
          "q": "A topic has 12 partitions and the consumer group runs 30 pods. What happens?",
          "options": [
          "18 pods hold no partition and idle, because a partition belongs to one consumer",
          "Each pod receives 0.4 partitions and shares the work",
          "Kafka splits partitions to match the consumer count",
          "The group rebalances into 30 partitions automatically"
          ],
          "answer": 0,
          "explain": "Partition count caps parallelism inside a group. Extra consumers stay in the group without assignments, so they cost money and add nothing."
        },
        {
          "q": "Why alert on max per-partition lag rather than the group sum?",
          "options": [
          "Sums are more expensive for the broker to compute",
          "Sums ignore committed offsets entirely",
          "Max lag is always zero right after a rebalance",
          "One stuck partition can hide inside a healthy sum and never trip an alert"
          ],
          "answer": 3,
          "explain": "Aggregation hides shape. A per-partition maximum (or a count of lagging partitions) surfaces the one key that has stopped being consumed."
        },
        {
          "q": "After a crash, which offset defines where the group resumes?",
          "options": [
          "The last committed offset, because that is the group's durable checkpoint",
          "The crashed client's `position()`, which the broker remembers",
          "The high watermark at the time of the crash",
          "The low watermark of the partition"
          ],
          "answer": 0,
          "explain": "Positions are client-side and die with the process. The committed offset is what the new consumer reads, which is why uncommitted work is reprocessed."
        }
      ],
      "quickbytes": [
        "lag = high watermark - position, per assigned partition; skip partitions without a concrete offset.",
        "Scale to at most the partition count; a second threshold for scale-down stops autoscaler flapping.",
        "Cache watermark samples on a timer; one broker round trip per partition per scrape is real load."
      ],
      "github": [
        { "name": "rust-rdkafka: positions, watermarks, consumer groups", "url": "https://github.com/fede1024/rust-rdkafka" },
        { "name": "apache/kafka: consumer group protocol and offsets", "url": "https://github.com/apache/kafka" }
      ],
      "resources": [
        {
          "title": "rdkafka Consumer: position, fetch_watermarks, pause/resume",
          "url": "https://docs.rs/rdkafka/latest/rdkafka/consumer/trait.Consumer.html",
          "kind": "docs"
        },
        {
          "title": "Apache Kafka introduction: partitions, offsets, consumer groups",
          "url": "https://kafka.apache.org/intro",
          "kind": "docs"
        },
        {
          "title": "Kubernetes Horizontal Pod Autoscaling: behaviour and stabilization windows",
          "url": "https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/",
          "kind": "docs"
        },
        {
          "title": "rust-rdkafka repository",
          "url": "https://github.com/fede1024/rust-rdkafka",
          "kind": "repo"
        },
        {
          "title": "Confluent channel: consumer lag, rebalancing, and autoscaling talks",
          "url": "https://www.youtube.com/@Confluent",
          "kind": "video"
        }
      ]
    },
    {
      "id": "s14",
      "n": 14,
      "title": "Request-reply over a message bus",
      "minutes": 85,
      "level": "advanced",
      "goal": "Implement the inbox pattern with explicit timeouts and error replies, and recognise when messaging is the wrong transport for a synchronous call.",
      "sections": [
        {
          "h": "The inbox pattern",
          "p": [
            "Request-reply over NATS is two publishes. The requester subscribes to a unique inbox subject, publishes the request with `reply` set to that inbox, and waits with a timeout; the responder reads `msg.reply` and publishes the answer there. NATS generates the inbox for you, so you are not hand-rolling correlation ids or leaking a subscription per call.",
            "That is a queue with a return address, not an RPC. There is no connection to fail, no ordering across responders, and no guarantee that the reply outlives the responder's commit. Anything you would not do with an at-least-once queue - retry a charge, assume a single handler, assume ordering - do not do here either."
          ],
          "list": [
            "Requester owns the timeout and the inbox; it never publishes to a request subject twice",
            "Responder publishes to `msg.reply` and treats a missing reply subject as a caller bug",
            "The reply payload needs its own success/error encoding; a bus has no status codes",
            "Duplicate requests are normal: the responder's effect must be idempotent"
          ],
          "tip": "Log the inbox id with the request. It is the only value that ties a timed-out call to the answer that arrived 200 ms too late."
        },
        {
          "h": "The timeout is the contract",
          "p": [
            "`send_request` waits for a bounded time, overridable per request through `Request::timeout`. A responder that runs longer than the caller's timeout has done the work and thrown the answer away - a charge that succeeded while the caller reports failure. The responder's budget must be strictly smaller than the requester's, and the work must be idempotent, because the caller will retry on timeout.",
            "Encode failure in the payload rather than in silence. A bus gives you no 404, so a responder that finds nothing must say so explicitly; otherwise the caller learns only that the deadline passed, which is indistinguishable from an outage and gets retried forever."
          ],
          "code": `use std::time::Duration;

use async_nats::Client;
use bytes::Bytes;
use futures_util::StreamExt;

/// First byte of the reply is the outcome: 0x00 ok, 0x01 handled error.
pub async fn ask(client: &Client, order_id: &str) -> Result<Bytes, String> {
    let request = async_nats::Request::new()
        .payload(Bytes::from(order_id.to_string()))
        .timeout(Some(Duration::from_millis(750)));

    let reply = client
        .send_request("orders.lookup", request)
        .await
        .map_err(|error| format!("no answer: {error}"))?;

    match reply.payload.first() {
        Some(&0) => Ok(reply.payload.slice(1..)),
        Some(&1) => Err(String::from_utf8_lossy(&reply.payload[1..]).into_owned()),
        _ => Err("malformed reply".to_string()),
    }
}

pub async fn serve(client: Client) -> Result<(), async_nats::Error> {
    let mut subscription = client.subscribe("orders.lookup").await?;

    while let Some(message) = subscription.next().await {
        let Some(reply) = message.reply.clone() else {
            tracing::warn!("request without a reply subject");
            continue;
        };

        let mut body = Vec::new();
        match lookup(&message.payload).await {
            Some(order) => {
                body.push(0u8);
                body.extend_from_slice(&order);
            }
            None => {
                body.push(1u8);
                body.extend_from_slice(b"order not found");
            }
        }

        client.publish(reply, Bytes::from(body)).await?;
    }

    Ok(())
}

async fn lookup(_payload: &[u8]) -> Option<Bytes> {
    Some(Bytes::from_static(b"{}"))
}`,
          "tip": "Set the responder's internal deadline below the caller's request timeout. Equal values mean the answer is always produced just after it stops being wanted."
        },
        {
          "h": "Kafka request-reply, and when to refuse it",
          "p": [
            "Kafka has no reply address, so you emulate one: a reply topic, a correlation id header, and a consumer that filters for its own ids. Every requester then reads every reply, or you create a reply topic per instance and multiply topic count. Orphaned replies accumulate, timeouts leave work with nowhere to go, and per-request latency becomes produce plus consume plus rebalance.",
            "Use it when the request must be durable and the caller can be asynchronous: submit returns a correlation id, and the result arrives later as an event. If the caller is blocking on a socket anyway, gRPC with a deadline is faster, typed, traceable with one span, and does not need a garbage-collection strategy for stale replies."
          ],
          "list": [
            "NATS request-reply: low latency, bounded by the request timeout, at-most-once reply",
            "Kafka request-reply: durable and auditable, high and variable latency, needs correlation ids",
            "gRPC: typed, deadline-aware, one connection, best for user-facing synchronous paths",
            "If the answer may arrive after the caller stopped caring, model it as an event, not a reply"
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement the responder so it never publishes to a missing reply subject, returns an explicit error payload for an unknown id, and keeps the requester's timeout strictly larger than the handler budget.",
        "starter": `use std::time::Duration;

use async_nats::Client;
use bytes::Bytes;
use futures_util::StreamExt;

pub async fn serve(client: Client) -> Result<(), async_nats::Error> {
    // 1. subscribe to orders.lookup
    // 2. skip messages without a reply subject
    // 3. encode 0x00 + body for ok, 0x01 + message for an error
    todo!()
}

pub async fn ask(client: &Client, id: &str) -> Result<Bytes, String> {
    // bounded send_request, then decode the first byte
    todo!()
}`,
        "hint": "message.reply is Option<Subject>; clone it before awaiting anything. Use Request::new().payload(...).timeout(Some(Duration::from_millis(750))) and match on the first byte of the reply.",
        "solution": `use std::time::Duration;

use async_nats::Client;
use bytes::Bytes;
use futures_util::StreamExt;

pub async fn serve(client: Client) -> Result<(), async_nats::Error> {
    let mut subscription = client.subscribe("orders.lookup").await?;

    while let Some(message) = subscription.next().await {
        let Some(reply) = message.reply.clone() else {
            tracing::warn!("request without a reply subject");
            continue;
        };

        let mut body = Vec::new();
        match lookup(&message.payload).await {
            Some(order) => {
                body.push(0u8);
                body.extend_from_slice(&order);
            }
            None => {
                body.push(1u8);
                body.extend_from_slice(b"order not found");
            }
        }

        client.publish(reply, Bytes::from(body)).await?;
    }

    Ok(())
}

pub async fn ask(client: &Client, id: &str) -> Result<Bytes, String> {
    let request = async_nats::Request::new()
        .payload(Bytes::from(id.to_string()))
        .timeout(Some(Duration::from_millis(750)));

    let reply = client
        .send_request("orders.lookup", request)
        .await
        .map_err(|error| format!("no answer: {error}"))?;

    match reply.payload.first() {
        Some(&0) => Ok(reply.payload.slice(1..)),
        Some(&1) => Err(String::from_utf8_lossy(&reply.payload[1..]).into_owned()),
        _ => Err("malformed reply".to_string()),
    }
}

async fn lookup(_payload: &[u8]) -> Option<Bytes> {
    Some(Bytes::from_static(b"{}"))
}`
      },
      "production": [
        "Requester timeout is set explicitly per call and is larger than the responder's internal budget.",
        "Responders log and skip messages that carry no reply subject instead of replying to the request subject.",
        "Every reply encodes success and failure, so the caller can distinguish a miss from an outage.",
        "Handler effects are idempotent because a lost reply is retried by the caller.",
        "Kafka-based request-reply has a documented strategy for orphaned replies and correlation-id retention."
      ],
      "crates": [
        "async-nats",
        "bytes",
        "tokio",
        "futures-util"
      ],
      "pitfall": "A responder that publishes its answer after the requester's timeout: the work commits, the reply is discarded, the caller retries, and the operation runs twice with no error in either log.",
      "questions": [
        {
          "q": "A responder publishes to the request subject instead of `msg.reply`. What happens?",
          "options": [
          "NATS routes it back to the requester automatically",
          "The request is redelivered to the same responder",
          "JetStream stores it as a reply and delivers it on the next fetch",
          "Every subscriber of that subject receives it and the requester times out"
          ],
          "answer": 3,
          "explain": "The reply subject is the only address back to that requester. Publishing to the request subject broadcasts a message nobody correlates, and the caller sees a timeout."
        },
        {
          "q": "Why must the responder's work be idempotent?",
          "options": [
          "Core NATS redelivers unacknowledged messages",
          "The caller retries after a timeout, and the first attempt may already have committed",
          "JetStream deduplicates by subject automatically",
          "Replies are at-least-once by default"
          ],
          "answer": 1,
          "explain": "A timeout is not a failure signal. The requester retries, and without deduplication the responder performs the same effect twice."
        },
        {
          "q": "When is Kafka request-reply the right shape?",
          "options": [
          "A 50 ms lookup on a page load",
          "A liveness probe from a load balancer",
          "A synchronous charge inside a checkout request",
          "A durable job submission whose result can arrive later as an event"
          ],
          "answer": 3,
          "explain": "Kafka buys durability and replay at the cost of latency and correlation bookkeeping. That trade pays off only when the caller can be asynchronous."
        }
      ],
      "quickbytes": [
        "Reply to `msg.reply`, never to the request subject; a missing reply subject means the caller is not a requester.",
        "Responder budget < requester timeout, and the effect must be idempotent because timeouts are retried.",
        "Encode success and failure in the reply payload: a bus has no status codes to distinguish a miss from an outage."
      ],
      "github": [
        { "name": "nats.rs: request, inbox, and reply subjects", "url": "https://github.com/nats-io/nats.rs" },
        { "name": "nats-server: core protocol and inbox handling", "url": "https://github.com/nats-io/nats-server" }
      ],
      "resources": [
        {
          "title": "async-nats Client: request, send_request, publish",
          "url": "https://docs.rs/async-nats/latest/async_nats/client/struct.Client.html",
          "kind": "docs"
        },
        {
          "title": "async-nats Request builder: payload, headers, timeout, inbox",
          "url": "https://docs.rs/async-nats/latest/async_nats/client/struct.Request.html",
          "kind": "docs"
        },
        {
          "title": "async-nats Message: subject, reply, payload",
          "url": "https://docs.rs/async-nats/latest/async_nats/message/struct.Message.html",
          "kind": "docs"
        },
        {
          "title": "nats.rs: request, inbox, and reply handling",
          "url": "https://github.com/nats-io/nats.rs",
          "kind": "repo"
        },
        {
          "title": "NATS official channel: request-reply and JetStream patterns",
          "url": "https://www.youtube.com/@nats_io",
          "kind": "video"
        }
      ]
    },
    {
      "id": "s15",
      "n": 15,
      "title": "Operating a dead-letter queue you can drain",
      "minutes": 95,
      "level": "industry",
      "goal": "Separate poison messages from transient outages, run the DLQ as an owned queue with an age SLO, and redrive with an idempotent, rate-limited tool.",
      "sections": [
        {
          "h": "Poison and outage need different destinations",
          "p": [
            "Two failure classes share the retry loop and must not share a destination. A poison message can never be processed: a schema violation, a reference to an entity that does not exist, a handler bug. A dependency outage is transient, and moving those messages to a DLQ converts a ten-minute outage into a manual replay of two hundred thousand records.",
            "So the consumer's error type has to distinguish them, and the routing follows: permanent errors go to the DLQ immediately, exhausted transient failures stay in the retry path and page the owner. Cap attempts by elapsed time as well as count, so a long outage parks messages in a waiting state instead of burning the budget and dumping them into the queue you drain by hand."
          ],
          "list": [
            "Poison: DLQ immediately, with the error and the coordinates",
            "Outage: bounded retry by time, page the owner, never auto-DLQ",
            "Exhausted transient attempts: a separate error class in the same table",
            "Never DLQ a message the handler never attempted to process"
          ],
          "tip": "The test for poison is cheap: would replaying this exact message after a fix succeed? If the answer depends on another service being up, it is an outage."
        },
        {
          "h": "A DLQ is a table with a dashboard",
          "p": [
            "Treat each failure as a row: original topic, partition, offset, key, first seen, attempts, error class, and a status. Depth alone is a weak metric - a queue that receives one message a day and has never been read looks fine - so the SLOs are oldest-message age and growth rate, plus a zero target for the poison class.",
            "The unique key is the original coordinates, which makes recording idempotent: a consumer crash between the publish and the insert produces a duplicate insert that does nothing instead of two rows for one message. Retention on this table outlives the topic; it is your only record of what was dropped."
          ],
          "code": `CREATE TABLE dlq_messages (
    id             BIGSERIAL PRIMARY KEY,
    consumer       TEXT        NOT NULL,
    original_topic TEXT        NOT NULL,
    partition      INT         NOT NULL,
    kafka_offset   BIGINT      NOT NULL,
    message_key    TEXT,
    payload        JSONB       NOT NULL,
    headers        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    error_class    TEXT        NOT NULL CHECK (error_class IN ('poison', 'exhausted')),
    last_error     TEXT        NOT NULL,
    attempts       INT         NOT NULL,
    first_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
    status         TEXT        NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new', 'triaged', 'redriven', 'ignored')),
    UNIQUE (consumer, original_topic, partition, kafka_offset)
);

-- Triage queue: oldest unread first, per consumer.
CREATE INDEX dlq_open_idx ON dlq_messages (consumer, first_seen)
    WHERE status = 'new';`,
          "tip": "Keep the payload as JSONB only if you can query it safely; otherwise store bytes plus a content type. A DLQ that rejects an insert because the payload is not valid JSON cannot record the message that broke JSON parsing."
        },
        {
          "h": "Redrive is a reviewed, rate-limited tool",
          "p": [
            "Redrive republishes a DLQ row to its original topic so the same handler processes it. Three rules make it safe: the handler deduplicates on the original coordinates (which are also the DLQ's unique key), the tool is rate-limited and pausable, and it only touches messages that failed before the fix shipped - anything newer failed for a different reason.",
            "Never redrive automatically in a loop between DLQ and topic. A deterministic failure makes that round trip forever: attempts grow, the dashboard shows activity, and nothing is fixed. Close the loop with a status change and a human decision, and prefer a dry run that reports how many rows would move before moving any."
          ],
          "code": `use std::time::Duration;

use rdkafka::producer::{FutureProducer, FutureRecord};
use rdkafka::util::Timeout;
use sqlx::PgPool;

#[derive(sqlx::FromRow)]
struct DlqRow {
    id: i64,
    original_topic: String,
    message_key: Option<String>,
    payload: String,
}

/// Republish rows that failed before the fix shipped, preserving the key.
/// Run in a paused loop; never as a hot retry.
pub async fn redrive_batch(
    pool: &PgPool,
    producer: &FutureProducer,
    consumer: &str,
    fixed_at: chrono::DateTime<chrono::Utc>,
    batch: i64,
) -> Result<usize, Box<dyn std::error::Error>> {
    let rows: Vec<DlqRow> = sqlx::query_as(
        r#"SELECT id, original_topic, message_key, payload::text AS payload
           FROM dlq_messages
           WHERE consumer = $1 AND status = 'new' AND first_seen < $2
           ORDER BY first_seen
           LIMIT $3
           FOR UPDATE SKIP LOCKED"#,
    )
    .bind(consumer)
    .bind(fixed_at)
    .bind(batch)
    .fetch_all(pool)
    .await?;

    for row in &rows {
        let delivery = match row.message_key.as_deref() {
            Some(key) => {
                let record = FutureRecord::to(&row.original_topic).payload(&row.payload).key(key);
                producer.send(record, Timeout::After(Duration::from_secs(5))).await
            }
            None => {
                let record = FutureRecord::to(&row.original_topic).payload(&row.payload);
                producer.send(record, Timeout::After(Duration::from_secs(5))).await
            }
        };
        delivery.map_err(|(error, _)| error)?;

        sqlx::query("UPDATE dlq_messages SET status = 'redriven' WHERE id = $1")
            .bind(row.id)
            .execute(pool)
            .await?;
    }

    Ok(rows.len())
}`,
          "tip": "Mark redriven only after the broker acknowledges. A crash in that gap republishes later - a duplicate the handler must already tolerate - instead of losing the row."
        }
      ],
      "exercise": {
        "prompt": "Record a failure idempotently: insert a DLQ row keyed by (consumer, topic, partition, offset) and report whether it was new, so a retried consumer does not create two rows for one message.",
        "starter": `use sqlx::PgPool;

pub struct Failure<'a> {
    pub consumer: &'a str,
    pub topic: &'a str,
    pub partition: i32,
    pub offset: i64,
    pub key: Option<&'a str>,
    pub payload: &'a [u8],
    pub error_class: &'a str,
    pub last_error: &'a str,
    pub attempts: i32,
}

/// Returns true when this failure was recorded for the first time.
pub async fn record(pool: &PgPool, failure: Failure<'_>) -> Result<bool, sqlx::Error> {
    // ON CONFLICT DO NOTHING, then check rows_affected
    todo!()
}`,
        "hint": "INSERT ... ON CONFLICT (consumer, original_topic, partition, kafka_offset) DO NOTHING, then rows_affected() == 1 means new. The payload is JSONB, so make the caller's bytes valid JSON or store shredded text explicitly.",
        "solution": `use sqlx::PgPool;

pub struct Failure<'a> {
    pub consumer: &'a str,
    pub topic: &'a str,
    pub partition: i32,
    pub offset: i64,
    pub key: Option<&'a str>,
    pub payload: &'a [u8],
    pub error_class: &'a str,
    pub last_error: &'a str,
    pub attempts: i32,
}

/// Returns true when this failure was recorded for the first time.
pub async fn record(pool: &PgPool, failure: Failure<'_>) -> Result<bool, sqlx::Error> {
    let inserted = sqlx::query(
        r#"INSERT INTO dlq_messages
               (consumer, original_topic, partition, kafka_offset,
                message_key, payload, error_class, last_error, attempts)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (consumer, original_topic, partition, kafka_offset)
           DO NOTHING"#,
    )
    .bind(failure.consumer)
    .bind(failure.topic)
    .bind(failure.partition)
    .bind(failure.offset)
    .bind(failure.key)
    .bind(serde_json::from_slice::<serde_json::Value>(failure.payload).ok())
    .bind(failure.error_class)
    .bind(failure.last_error)
    .bind(failure.attempts)
    .execute(pool)
    .await?
    .rows_affected();

    Ok(inserted == 1)
}`
      },
      "production": [
        "Poison and exhausted-transient failures are separate error classes with separate alert routing.",
        "Oldest-message age and growth rate are alarmable; depth alone is not the SLO.",
        "Recording is idempotent on (consumer, topic, partition, offset), so a crash cannot duplicate a row.",
        "Redrive is rate-limited, dry-runnable, and refuses rows newer than the deployed fix.",
        "Every DLQ row has an owner and a status; a row that stays 'new' for a week is an incident."
      ],
      "crates": [
        "rdkafka",
        "sqlx",
        "chrono",
        "serde_json"
      ],
      "pitfall": "Routing every exhausted retry to a shared DLQ: a twenty-minute dependency outage fills it with transient failures, the real poison messages disappear in the noise, and redrive replays a week of traffic.",
      "questions": [
        {
          "q": "A downstream service returns 503 for forty minutes. Where should its messages go?",
          "options": [
          "The DLQ, so operators can see them",
          "The retry path with a time-bounded budget, because the failure is transient",
          "Dropped after three attempts to protect the topic",
          "A different partition so other keys keep flowing"
          ],
          "answer": 1,
          "explain": "An outage is not a data defect. DLQing it converts a short outage into a large manual replay, and buries genuine poison messages."
        },
        {
          "q": "Why is an automatic DLQ-to-topic redrive loop harmful?",
          "options": [
          "It doubles disk usage on the broker",
          "Kafka forbids republishing to the same topic",
          "It resets consumer group offsets on every pass",
          "A deterministic failure repeats forever and looks like activity while nothing is fixed"
          ],
          "answer": 3,
          "explain": "The loop never changes the outcome for a poison message. Attempts grow, dashboards move, and the fix is still missing."
        },
        {
          "q": "Which metric catches a DLQ nobody reads?",
          "options": [
          "Oldest unread message age and growth rate, not just depth",
          "Average message size",
          "Number of partitions in the DLQ topic",
          "Producer batch size"
          ],
          "answer": 0,
          "explain": "A shallow queue with one week-old message is unread, and depth cannot show that. Age and growth rate are the signals that reflect an abandoned queue."
        }
      ],
      "quickbytes": [
        "Poison goes to the DLQ now; an outage stays in retry with a time budget and an on-call page.",
        "Unique key is (consumer, topic, partition, offset) - it makes recording idempotent and redrive traceable.",
        "Redrive only rows older than the deployed fix, with the original key, and mark them after the broker acks."
      ],
      "github": [
        { "name": "apache/kafka: topics, offsets, and consumer groups", "url": "https://github.com/apache/kafka" },
        { "name": "rust-rdkafka: producer delivery and consumer commits", "url": "https://github.com/fede1024/rust-rdkafka" }
      ],
      "resources": [
        {
          "title": "rdkafka producer: delivery results, timeouts, headers",
          "url": "https://docs.rs/rdkafka/latest/rdkafka/producer/index.html",
          "kind": "docs"
        },
        {
          "title": "Apache Kafka introduction: retention, offsets, delivery semantics",
          "url": "https://kafka.apache.org/intro",
          "kind": "docs"
        },
        {
          "title": "sqlx: transactions, SKIP LOCKED, and row counts",
          "url": "https://docs.rs/sqlx/latest/sqlx/",
          "kind": "docs"
        },
        {
          "title": "apache/kafka repository",
          "url": "https://github.com/apache/kafka",
          "kind": "repo"
        },
        {
          "title": "Confluent channel: error handling, retries, and dead-letter topics",
          "url": "https://www.youtube.com/@Confluent",
          "kind": "video"
        }
      ]
    },
    {
      "id": "s16",
      "n": 16,
      "title": "Trace context propagation across services",
      "minutes": 95,
      "level": "advanced",
      "goal": "Carry a W3C traceparent across gRPC and messaging boundaries without re-rooting the trace, and sample at the collector instead of per service.",
      "sections": [
        {
          "h": "One trace, one sampling decision",
          "p": [
            "A trace is a tree of spans that share a 128-bit trace id; the parent id is what makes it a tree rather than a pile of logs with a common field. W3C trace-context defines the header: `traceparent: 00-<32 hex trace id>-<16 hex parent id>-<2 hex flags>`, where the low bit of the flags byte is the sampled flag. Drop that flag between hops and the collector receives a partial trace that stops at the interesting hop.",
            "Sampling is decided once, at the edge, and inherited. Head sampling at one percent is cheap but blind to errors; tail sampling at the collector buffers a whole trace and keeps it if it errored or exceeded a latency threshold. That is what makes a low sampling rate defensible when you are debugging a customer report."
          ],
          "list": [
            "traceparent is four dash-separated fields; version 00 only",
            "All-zero trace ids and parent ids are invalid and must be rejected",
            "The sampled bit is inherited; a child may not decide to record on its own",
            "Baggage is separate and must never carry secrets or unbounded user data"
          ],
          "tip": "Log the trace id on every error line. It is the cheapest join between a customer complaint and the exact hop that failed."
        },
        {
          "h": "Propagation is metadata, not magic",
          "p": [
            "gRPC metadata and Kafka headers are string maps, so propagation is copying four fields across them and creating a child span on the other side. Two failures dominate in practice: the server mints a fresh trace id because nobody passed one, which turns one request into N unrelated single-hop traces, and the server re-samples independently, so children are recorded while the root is not.",
            "Reject a malformed header rather than replacing it. Inventing a trace id hides the propagation bug and leaves you with traces that look complete and are not. Emit a counter for rejected contexts so the broken hop shows up as a metric instead of as an unreproducible slow request."
          ],
          "code": `use tonic::{Request, Status};

pub const TRACEPARENT: &str = "traceparent";

#[derive(Clone, Debug)]
pub struct TraceContext {
    pub trace_id: String, // 32 lowercase hex
    pub span_id: String,  // 16 lowercase hex
    pub sampled: bool,
}

fn valid_hex(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn all_zero(value: &str) -> bool {
    value.bytes().all(|b| b == b'0')
}

impl TraceContext {
    pub fn to_header(&self) -> String {
        format!("00-{}-{}-{:02x}", self.trace_id, self.span_id, u8::from(self.sampled))
    }

    pub fn from_header(value: &str) -> Option<Self> {
        let mut parts = value.split('-');
        if parts.next()? != "00" {
            return None;
        }
        let trace_id = parts.next()?;
        let span_id = parts.next()?;
        let flags = u8::from_str_radix(parts.next()?, 16).ok()?;

        if !valid_hex(trace_id, 32) || !valid_hex(span_id, 16) {
            return None;
        }
        if all_zero(trace_id) || all_zero(span_id) {
            return None;
        }

        Some(Self {
            trace_id: trace_id.to_string(),
            span_id: span_id.to_string(),
            sampled: flags & 0x01 == 1,
        })
    }
}

pub fn attach(mut req: Request<()>, ctx: &TraceContext) -> Result<Request<()>, Status> {
    let value = ctx
        .to_header()
        .parse()
        .map_err(|_| Status::internal("traceparent is not a valid header value"))?;
    req.metadata_mut().insert(TRACEPARENT, value);
    Ok(req)
}`,
          "tip": "The header must survive the whole chain, including the async hop: when a consumer processes a message, extract traceparent before spawning, or the span starts parentless."
        },
        {
          "h": "Collector, not an exporter per service",
          "p": [
            "Letting every service export directly to a backend means N sets of credentials, N retry policies, and no way to sample by trace. A collector - an agent per node, a gateway per cluster - is one egress with batching, retry, and tail sampling. Point services at the local agent over OTLP and let the gateway decide what is kept.",
            "Record durations from span start and end within one process, never by subtracting wall-clock timestamps taken on two hosts. Clock skew between two VMs can exceed the request duration you are trying to measure, and a negative span duration in a dashboard is the usual symptom."
          ],
          "code": `# otel-collector gateway: keep failures and slow traces, sample the rest
processors:
  tail_sampling:
    decision_wait: 30s
    num_traces: 100000
    policies:
      - name: errors
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: slow
        type: latency
        latency: { threshold_ms: 800 }
      - name: baseline
        type: probabilistic
        probabilistic: { sampling_percentage: 1 }
  batch:
    send_batch_size: 512
    timeout: 5s
exporters:
  otlp:
    endpoint: tempo.observability.svc:4317
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [tail_sampling, batch]
      exporters: [otlp]`,
          "tip": "Tail sampling buffers whole traces in the collector, so size memory to decision_wait times arrival rate. An OOM-killed collector loses every buffered trace."
        }
      ],
      "exercise": {
        "prompt": "Implement traceparent parsing that rejects uppercase hex, zero ids, wrong lengths, and unknown versions, then inject the context into outbound gRPC metadata.",
        "starter": `use tonic::{Request, Status};

pub struct TraceContext {
    pub trace_id: String,
    pub span_id: String,
    pub sampled: bool,
}

impl TraceContext {
    pub fn from_header(value: &str) -> Option<Self> {
        // 00-<32 hex>-<16 hex>-<2 hex>
        todo!()
    }

    pub fn to_header(&self) -> String {
        todo!()
    }
}

pub fn attach(req: Request<()>, ctx: &TraceContext) -> Result<Request<()>, Status> {
    todo!()
}`,
        "hint": "Split on '-', check the version first, validate length and lowercase hex per field, reject all-zero ids, then read the sampled bit as flags & 0x01. Insert with metadata_mut().insert(\"traceparent\", value.parse()?).",
        "solution": `use tonic::{Request, Status};

pub const TRACEPARENT: &str = "traceparent";

pub struct TraceContext {
    pub trace_id: String,
    pub span_id: String,
    pub sampled: bool,
}

fn valid_hex(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn all_zero(value: &str) -> bool {
    value.bytes().all(|b| b == b'0')
}

impl TraceContext {
    pub fn from_header(value: &str) -> Option<Self> {
        let mut parts = value.split('-');
        if parts.next()? != "00" {
            return None;
        }
        let trace_id = parts.next()?;
        let span_id = parts.next()?;
        let flags = u8::from_str_radix(parts.next()?, 16).ok()?;

        if !valid_hex(trace_id, 32) || !valid_hex(span_id, 16) {
            return None;
        }
        if all_zero(trace_id) || all_zero(span_id) {
            return None;
        }

        Some(Self {
            trace_id: trace_id.to_string(),
            span_id: span_id.to_string(),
            sampled: flags & 0x01 == 1,
        })
    }

    pub fn to_header(&self) -> String {
        format!("00-{}-{}-{:02x}", self.trace_id, self.span_id, u8::from(self.sampled))
    }
}

pub fn attach(mut req: Request<()>, ctx: &TraceContext) -> Result<Request<()>, Status> {
    let value = ctx
        .to_header()
        .parse()
        .map_err(|_| Status::internal("traceparent is not a valid header value"))?;
    req.metadata_mut().insert(TRACEPARENT, value);
    Ok(req)
}`
      },
      "production": [
        "Every inbound server extracts traceparent and every outbound client injects it, including message producers.",
        "A malformed context increments a metric and is rejected; nothing silently mints a new trace id.",
        "Sampling is decided at the edge or in the collector, and the sampled flag is propagated unchanged.",
        "Span durations come from one process clock; cross-host timestamp subtraction is banned.",
        "Collector memory is sized for tail-sampling buffers, with an alert before it drops traces."
      ],
      "crates": [
        "tracing",
        "tracing-opentelemetry",
        "opentelemetry",
        "opentelemetry-otlp"
      ],
      "pitfall": "Minting a fresh trace id whenever the inbound traceparent is malformed: every service looks instrumented, and the backend shows N unrelated one-hop traces instead of the request that actually failed.",
      "questions": [
        {
          "q": "A trace stops at the inventory service. What is the most likely cause?",
          "options": [
          "The collector dropped every span from that service",
          "The trace id exceeded the 32-character limit",
          "Sampling was configured at 100 percent",
          "Inventory never extracted traceparent, so its spans started a new root"
          ],
          "answer": 3,
          "explain": "A new root per hop is the classic propagation bug: the work is instrumented, but nothing joins it to the caller's trace."
        },
        {
          "q": "Which sampling keeps error traces while recording little else?",
          "options": [
          "Head sampling at one percent at every service",
          "Sampling by service name in the SDK",
          "Tail sampling in the collector with status_code and latency policies",
          "Clearing the sampled flag on success"
          ],
          "answer": 2,
          "explain": "Tail sampling sees the completed trace, so it can keep all errors and slow traces plus a small baseline. Head sampling decides before the outcome exists."
        },
        {
          "q": "Why is subtracting wall-clock timestamps from two hosts unsafe for span durations?",
          "options": [
          "The W3C format stores no timestamps at all",
          "NTP makes all clocks exactly equal",
          "Spans only record durations, never times",
          "Clock skew between hosts can exceed the span duration being measured"
          ],
          "answer": 3,
          "explain": "Skew of tens of milliseconds is normal and can exceed a fast RPC. Measure each span with one clock, and treat cross-host comparison as an estimate."
        }
      ],
      "quickbytes": [
        "traceparent is `00-<32 hex>-<16 hex>-<2 hex>`; reject all-zero ids and propagate the sampled bit unchanged.",
        "Sampling is one decision inherited by every hop; re-sampling deeper in the graph produces broken traces.",
        "Send OTLP to a local collector and tail-sample at the gateway; per-service exporters multiply credentials and blind spots."
      ],
      "github": [
        { "name": "opentelemetry-rust: API, SDK, and OTLP exporter", "url": "https://github.com/open-telemetry/opentelemetry-rust" },
        { "name": "w3c/trace-context: the traceparent specification", "url": "https://github.com/w3c/trace-context" }
      ],
      "resources": [
        {
          "title": "opentelemetry-otlp: OTLP exporter with the tonic transport",
          "url": "https://docs.rs/opentelemetry-otlp/latest/opentelemetry_otlp/",
          "kind": "docs"
        },
        {
          "title": "tower and tonic metadata: where traceparent travels",
          "url": "https://docs.rs/tonic/latest/tonic/",
          "kind": "docs"
        },
        {
          "title": "OpenTelemetry Rust: instrumentation and propagation",
          "url": "https://github.com/open-telemetry/opentelemetry-rust",
          "kind": "repo"
        },
        {
          "title": "W3C Trace Context specification",
          "url": "https://github.com/w3c/trace-context",
          "kind": "repo"
        },
        {
          "title": "CNCF channel: OpenTelemetry, tail sampling, and tracing at scale",
          "url": "https://www.youtube.com/@cncf",
          "kind": "video"
        }
      ]
    },
    {
      "id": "s17",
      "n": 17,
      "title": "Backpressure: bound the queue, or it bounds you",
      "minutes": 90,
      "level": "advanced",
      "goal": "Turn a slow consumer into a signal the producer can act on, using bounded queues, pause/resume at the broker, and deliberate load shedding.",
      "sections": [
        {
          "h": "An unbounded queue is a memory leak with a scheduler",
          "p": [
            "When a producer outruns a consumer, something must slow down or something must grow. An unbounded channel chooses growth: latency climbs, memory follows, and the process is killed before any saturation metric fires. A bounded channel makes the producer await, which pushes the delay back to whoever can actually fix it, inside a known envelope.",
            "Backpressure only works if the signal has a path. If the producer is an HTTP handler, awaiting the send shows up as latency the client sees. If it is a Kafka consumer, awaiting the send stops polling, and once `max.poll.interval.ms` passes the broker revokes the assignment - a rebalance is a far worse outcome than reading fewer records."
          ],
          "list": [
            "Unbounded: latency and memory grow, failure arrives as an OOM kill",
            "Bounded + await: producer slows, the queue stays inside its envelope",
            "Bounded + try_send: producer sheds, which is honest when waiting is worse",
            "Broker-level: max in-flight and fetch size bound work before it reaches you"
          ],
          "tip": "A queue length metric with no capacity line next to it tells you nothing. Graph depth against the bound, and alert on time-at-capacity."
        },
        {
          "h": "Pause the partition, not the poll loop",
          "p": [
            "For Kafka, the safe place to apply backpressure is the assignment: when in-flight work crosses a high watermark, `pause` the partitions; when it drains below a low watermark, `resume`. The consumer keeps polling, so no rebalance is triggered, and nothing is dropped or skipped - the records simply stay in the log where they are safe.",
            "Pausing is per partition, which is the point. One hot partition can be paused while the rest keep flowing, instead of stopping the whole consumer because a single key is expensive. Use two thresholds: a single watermark flaps between paused and resumed on every record."
          ],
          "code": `use std::sync::atomic::{AtomicUsize, Ordering};

use rdkafka::consumer::{Consumer, StreamConsumer};
use rdkafka::topic_partition_list::TopicPartitionList;

#[derive(Debug, PartialEq, Eq)]
pub enum Flow {
    Running,
    Paused,
}

/// Two watermarks, so the consumer cannot flap between pause and resume.
/// Polling continues while paused: that is what keeps the group alive.
pub fn flow_control(
    consumer: &StreamConsumer,
    in_flight: &AtomicUsize,
    assignment: &TopicPartitionList,
    high: usize,
    low: usize,
) -> Result<Flow, rdkafka::error::KafkaError> {
    let current = in_flight.load(Ordering::Relaxed);

    if current >= high {
        consumer.pause(assignment)?;
        return Ok(Flow::Paused);
    }

    if current <= low {
        consumer.resume(assignment)?;
        return Ok(Flow::Running);
    }

    Ok(Flow::Running)
}`,
          "tip": "Pausing does not free the records already fetched. Bound `max.poll.records` too, or one poll can hand you a batch larger than the queue you just protected."
        },
        {
          "h": "Shed at the edge, wait in the middle",
          "p": [
            "Where you apply backpressure should follow the failure cost. In an internal worker, waiting is cheap: the message stays in the topic and the chain slows down. On a user-facing edge, waiting is expensive and the honest options are shed with a 429 and `Retry-After`, coalesce the work, or serve a degraded response. Buffering past the bound is not one of the options; it only moves the failure later and makes it larger.",
            "A bounded queue with a short wait is a useful middle ground: wait 20 ms for capacity, then shed. That absorbs micro-bursts without letting a stalled downstream convert into an unbounded in-process queue, and the shed count becomes the metric that tells you capacity is short."
          ],
          "code": `use tokio::sync::mpsc;
use tokio::time::{timeout, Duration};

#[derive(Debug, PartialEq, Eq)]
pub enum Enqueue {
    Accepted,
    Shed,
}

/// Absorb a micro-burst, then shed. Waiting forever is an unbounded queue
/// with extra steps; shedding immediately wastes capacity you still have.
pub async fn enqueue(tx: &mpsc::Sender<Vec<u8>>, item: Vec<u8>) -> Enqueue {
    match timeout(Duration::from_millis(20), tx.send(item)).await {
        Ok(Ok(())) => Enqueue::Accepted,
        Ok(Err(_)) => Enqueue::Shed, // receiver dropped
        Err(_) => Enqueue::Shed,     // capacity stayed full for 20 ms
    }
}`,
          "list": [
            "Worker: pause or await, never drop - the topic is the buffer",
            "Edge: shed with 429 and Retry-After once the short wait expires",
            "Broker: bound max in-flight (`max_ack_pending`, `max.poll.records`, fetch size)",
            "Always emit the shed count and the queue depth as first-class metrics"
          ]
        }
      ],
      "exercise": {
        "prompt": "Wire flow control into a consumer loop: track in-flight work in an atomic counter, pause the assignment at 500 in-flight and resume at 100, and keep polling while paused so the group does not rebalance.",
        "starter": `use std::sync::atomic::{AtomicUsize, Ordering};

use rdkafka::consumer::{Consumer, StreamConsumer};
use rdkafka::topic_partition_list::TopicPartitionList;

pub fn flow_control(
    consumer: &StreamConsumer,
    in_flight: &AtomicUsize,
    assignment: &TopicPartitionList,
) -> Result<(), rdkafka::error::KafkaError> {
    // 1. read in_flight
    // 2. pause at >= 500, resume at <= 100
    todo!()
}`,
        "hint": "consumer.pause(assignment)? and consumer.resume(assignment)? take the whole TopicPartitionList. Keep polling either way - pausing only stops delivery of new records, it does not stop the group heartbeat.",
        "solution": `use std::sync::atomic::{AtomicUsize, Ordering};

use rdkafka::consumer::{Consumer, StreamConsumer};
use rdkafka::topic_partition_list::TopicPartitionList;

pub const HIGH: usize = 500;
pub const LOW: usize = 100;

pub fn flow_control(
    consumer: &StreamConsumer,
    in_flight: &AtomicUsize,
    assignment: &TopicPartitionList,
) -> Result<(), rdkafka::error::KafkaError> {
    let current = in_flight.load(Ordering::Relaxed);

    if current >= HIGH {
        // Records stay in the log; nothing is dropped and no rebalance fires.
        consumer.pause(assignment)?;
    } else if current <= LOW {
        consumer.resume(assignment)?;
    }

    Ok(())
}

/// The loop that uses it: poll, process concurrently, and let the counter
/// drive pause/resume. assignment() is refreshed after every rebalance.
pub async fn run(
    consumer: StreamConsumer,
    in_flight: &AtomicUsize,
) -> Result<(), rdkafka::error::KafkaError> {
    loop {
        let assignment = consumer.assignment()?;
        flow_control(&consumer, in_flight, &assignment)?;
        // ... poll, spawn work that increments/decrements in_flight ...
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}`
      },
      "production": [
        "Every in-process queue has a documented bound and a metric for time spent at that bound.",
        "Kafka consumers pause and resume partitions on two watermarks instead of blocking the poll loop.",
        "max.poll.records and max in-flight are sized so one batch cannot exceed the downstream queue.",
        "Edge shedding returns 429 with Retry-After and increments a shed counter that is alerted on.",
        "Broker-side limits (max_ack_pending, prefetch) are configured explicitly, not left to defaults."
      ],
      "crates": [
        "tokio",
        "rdkafka",
        "async-nats",
        "tracing"
      ],
      "pitfall": "Awaiting a slow sink inside the poll loop until max.poll.interval.ms expires: the broker revokes the assignment, the batch is reprocessed from the last commit, and the consumer oscillates between processing and rebalancing.",
      "questions": [
        {
          "q": "A bounded tokio mpsc channel is full and you call `send().await`. What happens?",
          "options": [
          "The task yields until capacity frees, applying backpressure to the producer",
          "The message is dropped and an error is returned immediately",
          "The channel grows to fit the message",
          "The receiver panics with a full-queue error"
          ],
          "answer": 0,
          "explain": "That await is the backpressure. Dropping or growing are the two failure modes it exists to avoid, and both need a deliberate choice instead."
        },
        {
          "q": "Why can unbounded buffering turn a latency problem into an outage?",
          "options": [
          "Buffers cost more CPU per message than direct sends",
          "Kafka rejects batches above the buffer size",
          "It disables the async runtime's timer wheel",
          "Memory grows without limit until the process is killed, and queued work is stale when it runs"
          ],
          "answer": 3,
          "explain": "An unbounded queue converts a throughput deficit into memory growth, and everything it eventually processes is already out of date."
        },
        {
          "q": "Why pause partitions instead of dropping records when the sink is saturated?",
          "options": [
          "Pausing keeps the offset and resumes later, so nothing is lost and no rebalance occurs",
          "Pausing deletes unread records and frees the partition",
          "Pausing resets the consumer group to its earliest offset",
          "Pausing commits the current offset automatically"
          ],
          "answer": 0,
          "explain": "The log is the buffer. Pausing stops delivery while the consumer keeps polling, so the group stays healthy and every record is still there when capacity returns."
        }
      ],
      "quickbytes": [
        "Bound every queue and alert on time-at-capacity; depth alone cannot tell you if the bound is right.",
        "Pause and resume partitions on two watermarks, and keep polling so the group does not rebalance.",
        "At the edge, wait briefly then shed with 429 and Retry-After; never absorb overload into an unbounded buffer."
      ],
      "github": [
        { "name": "tokio: bounded mpsc and timeouts", "url": "https://github.com/tokio-rs/tokio" },
        { "name": "rust-rdkafka: pause, resume, and poll limits", "url": "https://github.com/fede1024/rust-rdkafka" }
      ],
      "resources": [
        {
          "title": "tokio::sync::mpsc: bounded channels and backpressure",
          "url": "https://docs.rs/tokio/latest/tokio/sync/mpsc/index.html",
          "kind": "docs"
        },
        {
          "title": "async-nats pull consumer: max_ack_pending and fetch size",
          "url": "https://docs.rs/async-nats/latest/async_nats/jetstream/consumer/pull/struct.Config.html",
          "kind": "docs"
        },
        {
          "title": "Apache Kafka introduction: polling, consumer groups, delivery",
          "url": "https://kafka.apache.org/intro",
          "kind": "docs"
        },
        {
          "title": "tokio repository: runtime, channels, timers",
          "url": "https://github.com/tokio-rs/tokio",
          "kind": "repo"
        },
        {
          "title": "Confluent channel: consumer poll behaviour and pause/resume patterns",
          "url": "https://www.youtube.com/@Confluent",
          "kind": "video"
        }
      ]
    },
    {
      "id": "s18",
      "n": 18,
      "title": "Multi-region messaging: gateways and geo-affinity",
      "minutes": 105,
      "level": "industry",
      "goal": "Join independent regional clusters with a gateway instead of stretching one cluster, keep steady-state traffic local, and choose an explicit conflict rule for cross-region writes.",
      "sections": [
        {
          "h": "Do not stretch one cluster across the WAN",
          "p": [
            "A cluster assumes low latency and a full mesh: every broker holds a route to every other broker and cluster traffic flows freely between them. Stretch that across regions and replication, acks, and controller traffic all cross the slow link, so a WAN blip becomes a cluster-wide incident and every write pays an inter-region round trip.",
            "The alternative is independent clusters joined by an explicit, limited link. NATS models this with gateways: each cluster keeps its own local route mesh, and a gateway connects cluster to cluster, forwarding a message only when the remote side has expressed interest in that subject. Kafka's equivalent is separate clusters plus selective topic replication, with the offset and ordering consequences that follow."
          ],
          "list": [
            "Routes are intra-cluster and assume proximity; gateways are inter-cluster and assume distance",
            "A gateway carries only subjects the far side subscribes to, so idle subjects cost nothing",
            "Each server opens one gateway connection per remote cluster, not one per remote server",
            "Gateway names must match the remote cluster's name exactly, or that direction silently fails"
          ],
          "tip": "A working cross-region publish does not prove the config is right: gossip can form the super-cluster through the reverse connection while your typo'd name keeps failing in the log."
        },
        {
          "h": "Geo-affinity keeps the steady state local",
          "p": [
            "With the same queue group running in both regions, a message published in east is served by an east worker even though a west worker is eligible. Only when no local subscriber exists does the gateway forward the message. That is the property that keeps cross-region bandwidth for failover instead of paying for it on every message.",
            "It also breaks quietly when you run all workers in one region. Then every message from the other region crosses the gateway in steady state, the slow link carries production load, and the failover path becomes the normal path. Place a queue subscriber for each workload in every region that produces that work."
          ],
          "code": `# east: local routes stay local; the gateway is the only WAN path
server_name: n1-east
listen: 0.0.0.0:4222

cluster {
  name: "east"
  listen: 0.0.0.0:6222
  routes: [ nats-route://n2-east:6222, nats-route://n3-east:6222 ]
}

gateway {
  name: "east"          # must equal the cluster name above
  listen: 0.0.0.0:7222
  gateways: [
    { name: "west", urls: [ nats://n1-west:7322, nats://n2-west:7322 ] }
  ]
}`,
          "tip": "Every east server uses the identical gateway name and remote list; only the listen port differs when several servers share a host."
        },
        {
          "h": "Replication is not a gateway, and writes need a rule",
          "p": [
            "A gateway forwards live interest; it does not copy a stream. A stream's replicas live inside its own cluster, so failing over to another region leaves you without the data unless you replicated it: a mirror or sourced stream, or a consumer that republishes into the other region. Decide per stream whether the second region needs a copy, a read-only mirror, or nothing.",
            "Active-active writes are the hard case. Two regions accepting writes to the same aggregate need a conflict rule: last-write-wins with a trustworthy clock, a region-pinned owner per key, or a merge structure. Pick one, write it in the ADR, and test a partition. \"The database will sort it out\" is how customers get two shipments and one refund."
          ],
          "list": [
            "Ordering is per partition inside a region; a gateway does not create a global order",
            "Consumer group offsets are per cluster; a failover consumer starts where its own group left off",
            "Decide RPO per stream: no copy, async mirror, or a synchronous cross-region write",
            "Region-pinned keys are the cheapest conflict rule; make the pin part of the key"
          ]
        }
      ],
      "exercise": {
        "prompt": "Pin every aggregate to a home region with rendezvous hashing, so adding a third region moves only the keys that belong to it, and refuse to write in a region that is not the key's home.",
        "starter": `pub struct Regions {
    pub local: &'static str,
    pub all: Vec<&'static str>,
}

impl Regions {
    pub fn home_for(&self, key: &str) -> &'static str {
        // highest-random-weight hashing, not modulo
        todo!()
    }

    pub fn is_home(&self, key: &str) -> bool {
        todo!()
    }
}`,
        "hint": "For each region, hash (key, region) and take the maximum. Modulo hashing remaps almost every key when a region is added; rendezvous hashing moves only the keys whose winning region changed.",
        "solution": `use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

pub struct Regions {
    pub local: &'static str,
    pub all: Vec<&'static str>,
}

impl Regions {
    /// Highest-random-weight (rendezvous) hashing. Adding a region moves only
    /// the keys that now prefer it, instead of reshuffling a modulo mapping.
    pub fn home_for(&self, key: &str) -> &'static str {
        self.all
            .iter()
            .copied()
            .max_by_key(|region| {
                let mut hasher = DefaultHasher::new();
                (key, *region).hash(&mut hasher);
                hasher.finish()
            })
            .expect("at least one region")
    }

    pub fn is_home(&self, key: &str) -> bool {
        self.home_for(key) == self.local
    }
}

/// Rejecting a write outside the key's home region is the conflict rule:
/// a cross-region write is a bug, not a merge problem.
pub fn guard_write(regions: &Regions, key: &str) -> Result<(), String> {
    if regions.is_home(key) {
        Ok(())
    } else {
        Err(format!(
            "key {key} belongs to {}, not {}",
            regions.home_for(key),
            regions.local
        ))
    }
}`
      },
      "production": [
        "Each region runs its own cluster; cross-region traffic goes through gateways, never stretched routes.",
        "Gateway names match remote cluster names exactly, and gateway connection errors are alerted on.",
        "A queue-group subscriber exists in every region that produces that workload, so steady state stays local.",
        "Per-stream RPO is documented, and a region-loss drill proves the stated data loss is the real one.",
        "Every aggregate has a documented home region or an explicit conflict rule, tested under partition."
      ],
      "crates": [
        "async-nats",
        "rdkafka",
        "tokio",
        "tracing"
      ],
      "pitfall": "Assuming geo-affinity keeps traffic local while every worker runs in one region: the WAN link carries steady-state load, and the failover path becomes the everyday path.",
      "questions": [
        {
          "q": "What does a NATS gateway forward to another cluster?",
          "options": [
          "Every message published in the local cluster",
          "Only JetStream stream replicas",
          "Only messages published inside a queue group",
          "Only messages whose subject has interest in the remote cluster"
          ],
          "answer": 3,
          "explain": "Interest-based forwarding is why a gateway is cheap across a slow link: a subject nobody far away subscribes to never crosses it."
        },
        {
          "q": "Why is stretching one cluster across two regions worse than joining two clusters with gateways?",
          "options": [
          "Gateways compress inter-region traffic",
          "Routes cannot traverse a WAN at all",
          "Every broker keeps routes to every other, so replication and controller traffic cross the WAN and a blip becomes cluster-wide",
          "JetStream only operates in a single region"
          ],
          "answer": 2,
          "explain": "A route mesh assumes proximity. Stretched, all cluster-internal traffic pays the WAN, and cluster health depends on the link."
        },
        {
          "q": "A stream is replicated inside east. After failing over to west, what is missing?",
          "options": [
          "Nothing: gateways replicate streams automatically",
          "The stream's data, unless you mirrored or republished it into west's cluster",
          "Only consumer group offsets",
          "Only the subject namespace"
          ],
          "answer": 1,
          "explain": "Gateways carry interest and live messages, not stored stream contents. Cross-region durability needs explicit replication and a stated RPO."
        }
      ],
      "quickbytes": [
        "Gateways join clusters; routes build one cluster. Do not stretch a route mesh across a WAN.",
        "Geo-affinity serves locally first and crosses the gateway only when no local worker exists - so place workers in both regions.",
        "Pin each aggregate to a home region; a cross-region write becomes a bug instead of a merge problem."
      ],
      "github": [
        { "name": "nats-server: gateways, super-clusters, JetStream", "url": "https://github.com/nats-io/nats-server" },
        { "name": "nats.rs: client reconnection and server pools", "url": "https://github.com/nats-io/nats.rs" }
      ],
      "resources": [
        {
          "title": "NATS super-clusters: gateways, interest, and geo-affinity",
          "url": "https://docs.nats.io/learn/topologies/super-clusters",
          "kind": "docs"
        },
        {
          "title": "async-nats: connection state, server pools, reconnects",
          "url": "https://docs.rs/async-nats/latest/async_nats/",
          "kind": "docs"
        },
        {
          "title": "Apache Kafka introduction: replication and delivery guarantees",
          "url": "https://kafka.apache.org/intro",
          "kind": "docs"
        },
        {
          "title": "nats-server repository",
          "url": "https://github.com/nats-io/nats-server",
          "kind": "repo"
        },
        {
          "title": "NATS official channel: super-clusters, leaf nodes, and JetStream domains",
          "url": "https://www.youtube.com/@nats_io",
          "kind": "video"
        }
      ]
    },
    {
      "id": "s19",
      "n": 19,
      "title": "Service mesh: what the sidecar does, and what it cannot",
      "minutes": 80,
      "level": "advanced",
      "goal": "Separate the four concerns a mesh actually moves out of your code from the semantics it can never know, and get proxy startup and shutdown ordering right.",
      "sections": [
        {
          "h": "Four concerns move out of the process",
          "p": [
            "A mesh intercepts pod traffic and applies identity (mTLS with a workload certificate), L7 policy (timeouts, retries, traffic split), telemetry (per-hop latency, status, bytes), and authorization (which workload may call which). Moving these out of the application is the whole point: a platform team can enforce mTLS without waiting for forty services to upgrade a TLS library.",
            "What it cannot do is know your semantics. A proxy cannot tell that a retried POST created two orders, that a 200 carried a domain error, or that the handler needed to shrink the deadline. Application deadlines, idempotency keys, and breakers keyed on business errors stay in the service, no matter what the mesh dashboard offers."
          ],
          "list": [
            "Identity: which workload made the call, proven by certificate, not by a header",
            "Policy: timeouts, retries, and traffic split at the proxy",
            "Telemetry: per-hop latency and status without touching application code",
            "Authorization: allowed caller pairs - coarse, and blind to request content"
          ],
          "tip": "mTLS authenticates the workload. It does not authorize the operation; that still needs the service's own rules and the caller's principal."
        },
        {
          "h": "Startup order is the most common mesh failure",
          "p": [
            "If the proxy is a plain container in the pod, it can start after the application and race its first outbound call, producing connection refused at boot and a restart that mysteriously fixes it. A native sidecar - an init container with `restartPolicy: Always` - starts before the application containers and stops after them, which is exactly the ordering a proxy needs.",
            "Shutdown matters as much. A proxy that exits first drops in-flight requests while the pod is still advertised as ready; a readiness probe on the proxy's own admin endpoint makes the pod fail readiness before the application stops accepting work."
          ],
          "code": `apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders
spec:
  replicas: 3
  selector:
    matchLabels: { app: orders }
  template:
    metadata:
      labels: { app: orders }
    spec:
      initContainers:
        # Native sidecar: starts before the app container, stops after it.
        - name: proxy
          image: envoyproxy/envoy
          restartPolicy: Always
          args: ["-c", "/etc/envoy/envoy.yaml"]
          readinessProbe:
            httpGet: { path: /ready, port: 9901 }
      containers:
        - name: app
          image: registry.example.com/orders:1.8.2
          ports:
            - { containerPort: 8080 }
          readinessProbe:
            grpc: { port: 8080 }
          lifecycle:
            preStop:
              exec:
                # Let the proxy drain before the process exits.
                command: ["sleep", "5"]`,
          "tip": "A pod is ready only when both the app and the proxy are ready. If the proxy's readiness is missing from the pod's condition, traffic arrives before the tunnel exists."
        },
        {
          "h": "Adopt it for ownership, not for features",
          "p": [
            "Traffic shifting is a mesh feature, but it only works when the new version's contract is backward compatible and its migrations are additive. The mesh routes bytes; it does not reconcile two schema versions, and a 5% canary that writes with the new schema can corrupt data the old version still reads.",
            "The honest case for a mesh is ownership: enough services and teams that per-service TLS, retries, and telemetry cannot be kept consistent by convention, or a compliance requirement for uniform workload identity. With six services, a shared client library and a good tower stack deliver most of it with one fewer moving part, and one fewer place where a retry policy hides."
          ],
          "list": [
            "Adopt when identity and telemetry must be uniform across many teams",
            "Do not adopt to fix a design problem: the mesh adds a hop, not a transaction",
            "Pick one retry owner - client, gateway, or mesh - and disable the others",
            "Measure the added p99 per hop before and after; proxies are not free"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write the pod spec for a service behind a proxy: the proxy must start first and stop last, the pod must not be ready until the proxy is ready, and the app must drain before exiting.",
        "starter": `apiVersion: apps/v1
kind: Deployment
metadata:
  name: inventory
spec:
  replicas: 2
  selector:
    matchLabels: { app: inventory }
  template:
    metadata:
      labels: { app: inventory }
    spec:
      # 1. proxy as a native sidecar with restartPolicy: Always
      # 2. readiness on both proxy and app
      # 3. preStop drain on the app
      containers: []`,
        "hint": "An initContainer with restartPolicy: Always is a native sidecar in current Kubernetes: it starts before the app containers and terminates after them. Put a readinessProbe on the proxy's admin port and a grpc readinessProbe on the app.",
        "solution": `apiVersion: apps/v1
kind: Deployment
metadata:
  name: inventory
spec:
  replicas: 2
  selector:
    matchLabels: { app: inventory }
  template:
    metadata:
      labels: { app: inventory }
    spec:
      initContainers:
        - name: proxy
          image: envoyproxy/envoy
          restartPolicy: Always
          args: ["-c", "/etc/envoy/envoy.yaml"]
          readinessProbe:
            httpGet: { path: /ready, port: 9901 }
          resources:
            requests: { cpu: 50m, memory: 64Mi }
      containers:
        - name: app
          image: registry.example.com/inventory:2.4.0
          ports:
            - { containerPort: 8080 }
          readinessProbe:
            grpc: { port: 8080 }
          lifecycle:
            preStop:
              exec:
                command: ["sleep", "5"]`
      },
      "production": [
        "The proxy runs as a native sidecar so it starts before and stops after the application container.",
        "Pod readiness requires the proxy to be ready; a missing condition sends traffic before the tunnel exists.",
        "A preStop drain lets in-flight requests finish before the process exits.",
        "Exactly one layer owns retries; the others are configured to zero and that is asserted in config tests.",
        "Per-hop p99 overhead is measured, and the mesh is not adopted to compensate for a missing transaction."
      ],
      "crates": [
        "tonic",
        "tower",
        "tracing",
        "tokio"
      ],
      "pitfall": "Mesh retries layered on application retries: three attempts times three attempts is nine requests for one click, and the dependency's breaker never opens because each proxy sees only its own share.",
      "questions": [
        {
          "q": "What does mTLS in a mesh prove?",
          "options": [
          "That the calling workload is the one named in its certificate",
          "That the caller is authorized for the operation",
          "That the payload was not modified end to end",
          "That the call will be retried on failure"
          ],
          "answer": 0,
          "explain": "mTLS authenticates the workload identity on both ends. Authorization - may this caller refund this order - still belongs to the service and its data."
        },
        {
          "q": "A service sets a 1 s deadline and the mesh retries each call three times. What is the effect?",
          "options": [
          "The deadline is automatically divided into three attempts",
          "The dependency sees up to 4x load while the caller's 1 s budget is consumed by attempts",
          "The mesh disables retries when a deadline is present",
          "The retries run in parallel so latency is unchanged"
          ],
          "answer": 1,
          "explain": "Retries multiply load before the dependency recovers, and the original budget still bounds the caller. One layer should own retries."
        },
        {
          "q": "Which problem does a native sidecar (initContainer with restartPolicy: Always) solve?",
          "options": [
          "It guarantees the proxy starts before and stops after the app container",
          "It reduces proxy memory overhead",
          "It removes the need for mTLS between pods",
          "It lets the proxy skip its readiness probe"
          ],
          "answer": 0,
          "explain": "Ordering is the failure being fixed. Without it, the app races a proxy that is not listening yet, and boot fails in a way a restart hides."
        }
      ],
      "quickbytes": [
        "A mesh moves identity, L7 policy, telemetry, and coarse authz out of the process - never business semantics.",
        "Native sidecars (initContainers with restartPolicy: Always) fix proxy start/stop ordering.",
        "Pick one retry owner across gateway, mesh, and client, and set the other two to zero."
      ],
      "github": [
        { "name": "istio: sidecar and ambient mesh, mTLS, L7 policy", "url": "https://github.com/istio/istio" },
        { "name": "linkerd2: lightweight Rust proxy and control plane", "url": "https://github.com/linkerd/linkerd2" }
      ],
      "resources": [
        {
          "title": "Kubernetes sidecar containers: ordering and lifecycle",
          "url": "https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/",
          "kind": "docs"
        },
        {
          "title": "gRPC guide: deadlines and propagation across hops",
          "url": "https://grpc.io/docs/guides/deadlines/",
          "kind": "docs"
        },
        {
          "title": "istio repository",
          "url": "https://github.com/istio/istio",
          "kind": "repo"
        },
        {
          "title": "linkerd2 repository",
          "url": "https://github.com/linkerd/linkerd2",
          "kind": "repo"
        },
        {
          "title": "CNCF channel: service mesh adoption, mTLS, and ambient mesh talks",
          "url": "https://www.youtube.com/@cncf",
          "kind": "video"
        }
      ]
    },
    {
      "id": "s20",
      "n": 20,
      "title": "Consumer-driven contract tests between services",
      "minutes": 85,
      "level": "advanced",
      "goal": "Replace drifting hand-written mocks with recorded consumer contracts that the provider verifies in its own build, and know exactly what those tests cannot catch.",
      "sections": [
        {
          "h": "Mocks drift; contracts are verified",
          "p": [
            "A hand-written mock of the inventory API encodes what the consumer's author believed on the day they wrote it. When the provider renames a field, the mock still passes and the failure surfaces in staging or in production. A consumer-driven contract flips the direction: the consumer records the request it sends and the response shape it needs, and the provider's build verifies it can satisfy every consumer's file.",
            "Pact is the common implementation. The consumer test runs against a mock server generated from the interaction, records a pact file, and publishes it tagged with the consumer's branch. Provider verification replays each interaction against the real handler with the named provider state set up in its database."
          ],
          "list": [
            "Consumer writes the interaction and the matching rules",
            "Pact file is the artefact; it is versioned and published, not committed as documentation",
            "Provider verification runs in the provider's pipeline, against its real handler",
            "A deploy check answers: can every consumer version in production talk to this provider build"
          ],
          "code": `use pact_consumer::prelude::*;

#[tokio::test]
async fn get_order_returns_a_parsable_order() {
    let mock = PactBuilder::new("checkout-web", "orders-api")
        .interaction("a request for an existing order", "", |mut i| {
            i.given("order 42 exists");
            i.request.path("/v1/orders/42");
            i.response.json_utf8().json_body(json_pattern!({
                "id": like!("42"),
                "status": term!("^(pending|paid|shipped)$", "paid"),
                "total_minor_units": like!(4999),
            }));
            i
        })
        .start_mock_server(None, None);

    let client = OrdersClient::new(mock.path("/v1/orders/42"));
    let order = client.get("42").await.expect("client parses the response");

    assert_eq!(order.status, OrderStatus::Paid);
    // Dropping the mock verifies every interaction was actually exercised.
}`
        },
        {
          "h": "What a contract test can and cannot catch",
          "p": [
            "It catches shape: a removed or renamed field, a changed type, a status code that moved, a field the client requires that is now absent. It does not catch ordering, timing, retries, rate limits, or any change the shape cannot express - prices switching from dollars to cents is wire-compatible and semantically fatal.",
            "That is not a reason to skip contracts; it is a reason to keep them honest. Contracts are the fast per-PR gate that makes mocks unnecessary. Keep a small number of end-to-end checks for the journeys that matter, and a load test against the real dependency, because a contract test would pass while p99 triples."
          ],
          "tip": "Match with `like!` and `term!`, not with literals. A literal id in the pact makes the provider fail the day its fixtures change, which trains the team to ignore the check."
        },
        {
          "h": "Provider states are the hard part",
          "p": [
            "A provider state is a hook: \"order 42 exists\" means the verification run must put the database into that state before replaying the interaction. Vague or shared states make tests pass for reasons unrelated to the interaction, or fail because another test's fixtures leaked. Name each state for the exact data it creates, and make the setup idempotent so parallel runs do not collide.",
            "Version the artefact, not the environment. Publish pacts tagged with the consumer branch, verify against the provider branch that is about to ship, and gate the deploy on that result. Otherwise the mismatch is discovered during the rollout, when the provider is already half-deployed and the consumer's error rate is the only signal."
          ],
          "list": [
            "One state per scenario, named after the data it creates",
            "States are idempotent: re-running setup must not double-create the fixture",
            "Verify against the branch that is shipping, not against main after the fact",
            "For protobuf, the .proto is the contract: `buf breaking` plus generated stubs is your provider check"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a consumer contract for `GET /v1/orders/{id}` that accepts any order id, constrains status to an enum, requires an integer total, and fails if the client stops being able to parse the response.",
        "starter": `use pact_consumer::prelude::*;

#[tokio::test]
async fn get_order_parses_the_response() {
    // 1. PactBuilder::new("checkout-web", "orders-api")
    // 2. interaction with a provider state
    // 3. like!/term! matching rules, not literals
    // 4. start_mock_server, call the client, assert on a parsed field
    todo!()
}`,
        "hint": "Use PactBuilder::new(...).interaction(\"...\", \"\", |mut i| { i.given(\"order 42 exists\"); i.request.path(...); i.response.json_utf8().json_body(json_pattern!({...})); i }).start_mock_server(None, None), then call your client against mock.path(...).",
        "solution": `use pact_consumer::prelude::*;

#[tokio::test]
async fn get_order_parses_the_response() {
    let mock = PactBuilder::new("checkout-web", "orders-api")
        .interaction("a request for an existing order", "", |mut i| {
            i.given("order 42 exists");
            i.request.path("/v1/orders/42");
            i.response.json_utf8().json_body(json_pattern!({
                "id": like!("42"),
                "status": term!("^(pending|paid|shipped)$", "paid"),
                "total_minor_units": like!(4999),
            }));
            i
        })
        .start_mock_server(None, None);

    let client = OrdersClient::new(mock.path("/v1/orders/42"));
    let order = client
        .get("42")
        .await
        .expect("client must parse the contracted response");

    assert_eq!(order.status, OrderStatus::Paid);
    assert_eq!(order.total_minor_units, 4999);

    // Dropping the mock verifies that every interaction was exercised.
    // The generated pact file is published, then replayed by the provider.
}`
      },
      "production": [
        "Every consumer publishes its pact tagged with the branch, and the provider verifies all consumer versions on every build.",
        "Provider states create their own fixtures idempotently and are named after the data they create.",
        "Matching rules (like!, term!) are used instead of literal values that fixtures cannot guarantee.",
        "A deploy gate checks compatibility with the consumer versions currently in production.",
        "Contract tests are complemented by one end-to-end test per critical journey and a load test of the real dependency."
      ],
      "crates": [
        "pact_consumer",
        "serde",
        "serde_json",
        "tokio"
      ],
      "pitfall": "Publishing a pact from a feature branch and verifying it against a production provider: the contract encodes an unreleased expectation, the provider build goes red, and the team disables the check.",
      "questions": [
        {
          "q": "What does a consumer-driven contract test actually verify?",
          "options": [
          "That the provider handles production traffic volumes",
          "That the provider satisfies the exact request and response shapes its consumers recorded",
          "That end-to-end latency meets its SLO",
          "That the provider's database schema matches the consumer's models"
          ],
          "answer": 1,
          "explain": "A contract is a shape agreement per interaction. Load, latency, and data semantics live outside it."
        },
        {
          "q": "Why does a hand-written mock fail to catch provider drift?",
          "options": [
          "The mock encodes the consumer author's assumptions and never executes provider code",
          "Mocks are slower than contract verification",
          "Mocks cannot represent JSON bodies",
          "Mock servers cannot bind a local port in CI"
          ],
          "answer": 0,
          "explain": "Nothing in a hand-written mock runs the provider. The provider can rename a field and the mock keeps answering the old shape."
        },
        {
          "q": "Which failure would a contract test miss?",
          "options": [
          "The provider removed a field the consumer parses",
          "The provider changed a 200 to a 404 on the same path",
          "The provider renamed total to total_minor_units",
          "The provider now applies a per-tenant rate limit of five requests per second"
          ],
          "answer": 3,
          "explain": "Rate limits, ordering, and timing are behaviour, not shape. The other three change the recorded interaction and are exactly what contracts catch."
        }
      ],
      "quickbytes": [
        "Contracts are recorded from the consumer and replayed by the provider's own build - mocks otherwise drift silently.",
        "Match with like! and term!, never literals your provider's fixtures cannot guarantee.",
        "Contracts catch shape, not semantics: keep one end-to-end test per journey and a real load test."
      ],
      "github": [
        { "name": "pact-reference: the Rust Pact implementation", "url": "https://github.com/pact-foundation/pact-reference" },
        { "name": "buf: protobuf contract checks in CI", "url": "https://github.com/bufbuild/buf" }
      ],
      "resources": [
        {
          "title": "pact_consumer: builders, matching rules, message pacts",
          "url": "https://docs.rs/pact_consumer/latest/pact_consumer/",
          "kind": "docs"
        },
        {
          "title": "gRPC core concepts: services, methods, and status codes",
          "url": "https://grpc.io/docs/what-is-grpc/core-concepts/",
          "kind": "docs"
        },
        {
          "title": "pact-reference: Rust consumer and provider libraries",
          "url": "https://github.com/pact-foundation/pact-reference",
          "kind": "repo"
        },
        {
          "title": "buf: breaking-change detection for protobuf contracts",
          "url": "https://github.com/bufbuild/buf",
          "kind": "repo"
        },
        {
          "title": "InfoQ channel: contract testing, Pact, and API compatibility talks",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        }
      ]
    }
  ]
};
