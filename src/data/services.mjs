/**
 * Microservices & messaging track.
 *
 * API versions used across the lessons: tonic 0.14.x (prost codegen lives in
 * tonic-prost-build / tonic-prost), rdkafka 0.39.x, async-nats 0.51.x
 * (jetstream feature), sqlx 0.9.x (postgres + runtime-tokio), tokio 1.54.x.
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
    }
  ]
};
