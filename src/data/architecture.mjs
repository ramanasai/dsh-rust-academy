/**
 * Architecture & design track.
 *
 * Authored for the Rust Academy plugin. Every lesson is plain JSON-compatible
 * data consumed by src/app.js through build.mjs.
 */
export default {
  "key": "architecture",
  "prefix": "q",
  "title": "Architecture & design",
  "blurb": "Domain-driven design, hexagonal boundaries, modular monoliths, CQRS, event sourcing and multi-tenant SaaS patterns.",
  "level": "industry",
  "project": {
    "title": "Capstone: a multi-tenant SaaS backend",
    "brief": "Build one deployable backend that serves many tenants without leaking between them: a domain crate with no I/O, ports and adapters for HTTP and Postgres, CQRS reads projected from the write model, idempotent command handling keyed per tenant, row-level security as a second line of defence, and an ADR trail plus a capacity model that explains every limit you shipped.",
    "deliverables": [
      "A Cargo workspace split into domain, application, adapters and a single binary, with a CI check that fails when the domain crate gains an I/O dependency.",
      "Tenant isolation with tests: a request carrying tenant A can never read or mutate tenant B rows, proven by an integration test that runs the same query under both tenants and by a Postgres RLS policy that stays enabled.",
      "CQRS read models: at least one projection table rebuilt from the write model by a command you can run on demand, with a watermark that makes the rebuild idempotent.",
      "Idempotent command handling: one key table scoped by tenant, request fingerprint comparison, replayed responses, and a concurrent-retry test that inserts the same order twice.",
      "A written ADR trail for the boundary, isolation, and consistency decisions, each with the option you rejected and the consequence you accepted.",
      "A capacity model: measured p99, Little law arithmetic for in-flight requests, pool and concurrency limits derived from it, and the load-test command that produced the numbers."
    ],
    "stack": [
      "axum",
      "sqlx",
      "tower",
      "serde",
      "uuid"
    ]
  },
  "lessons": [
    {
      "id": "q01",
      "title": "Bounded contexts and the ubiquitous language",
      "minutes": 75,
      "level": "core",
      "goal": "Split a sprawling model into bounded contexts with explicit relationships, and put the shared vocabulary into newtypes so the compiler keeps it honest.",
      "sections": [
        {
          "h": "A model is valid only inside its context",
          "p": [
            "The word order means three different things in one company. Sales records a commitment, billing records a payable amount with tax lines, fulfilment records parcels with a delivery window. If one Order struct grows fields for all three, every team edits the same type, every migration touches every team, and a validation added for invoicing silently rejects a shipment.",
            "A bounded context is the boundary inside which one model and one vocabulary stay consistent. Contexts relate explicitly: a shared kernel is code two teams co-own and change together, a customer/supplier link means one context consumes another published contract, and separate ways means duplicated models with a translation at the edge. Naming the relationship is the deliverable, because it decides who may break whom."
          ],
          "list": [
            "Sales, billing, and fulfilment each own a model of an order and their own id type",
            "Contexts exchange contracts or events, never tables and never Rust structs",
            "A shared kernel is a liability with a named owner and a review rule",
            "Draw the context map before the first crate exists, not after the first rewrite"
          ],
          "tip": "If two teams cannot agree on the meaning of one field, they are in two contexts. Stop sharing the type."
        },
        {
          "h": "The ubiquitous language lands in the type system",
          "p": [
            "Vocabulary survives only if the compiler enforces it. Give every identifier its own newtype so an InvoiceId cannot be passed where a CustomerId belongs, and give money an explicit unit so a float never enters an accounting path. Names in code, names in the glossary, and names in conversation have to match, or the glossary becomes a document nobody opens.",
            "The uuid crate 1.29 generates version 7 identifiers behind the v7 feature: time-ordered, index-friendly, and produced by Uuid::now_v7(). Ordering matters for Postgres B-tree locality because new rows land near the end of the index instead of scattering across it. Implement Display and FromStr once per id type, and deliberately skip Deref to the inner value."
          ],
          "code": "use uuid::Uuid;\n\n#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]\npub struct OrderId(Uuid);\n\nimpl OrderId {\n    pub fn new() -> Self {\n        // v7: timestamp-prefixed, so inserts stay at the right edge of the index.\n        Self(Uuid::now_v7())\n    }\n}\n\n#[derive(Clone, Copy, PartialEq, Eq)]\npub enum Currency {\n    Eur,\n    Usd,\n}\n\n/// Money is minor units plus currency. There is no f64 constructor on purpose.\n#[derive(Clone, Copy, PartialEq, Eq)]\npub struct Money {\n    minor_units: i64,\n    currency: Currency,\n}\n\nimpl Money {\n    pub fn new(minor_units: i64, currency: Currency) -> Self {\n        Self { minor_units, currency }\n    }\n\n    pub fn checked_add(self, other: Self) -> Option<Self> {\n        (self.currency == other.currency)\n            .then(|| self.minor_units.checked_add(other.minor_units))\n            .flatten()\n            .map(|sum| Self { minor_units: sum, currency: self.currency })\n    }\n}",
          "tip": "Do not implement Deref<Target = Uuid> on id newtypes. It re-opens exactly the accidental mixing the newtype exists to prevent."
        },
        {
          "h": "The anti-corruption layer translates, it never guesses",
          "p": [
            "Upstream systems speak their own language: a payment processor has a dozen statuses, a legacy ERP has numeric codes. An anti-corruption layer converts that vocabulary into domain enums at the adapter boundary and fails loudly on unknown input. A match arm that maps anything unknown to Pending looks robust until a chargeback arrives and is quietly treated as unfinished work.",
            "The ACL is also the cheapest place to absorb upstream change. When a processor adds a status, one adapter changes and one test fails on an exhaustive match. Keep the mapping table-driven so it is reviewable in a diff, and log the raw upstream value next to the translated one so an incident can be reconstructed from logs alone."
          ],
          "code": "#[derive(Debug, thiserror::Error)]\npub enum AclError {\n    #[error(\"payout provider returned unknown status {0}\")]\n    UnknownStatus(String),\n    #[error(\"payout amount is negative: {0}\")]\n    NegativeAmount(i64),\n}\n\npub enum PayoutState {\n    Queued,\n    Paid,\n    Returned,\n}\n\n/// The only place that knows the provider vocabulary.\npub fn translate_state(raw: &str, amount_minor: i64) -> Result<PayoutState, AclError> {\n    if amount_minor < 0 {\n        return Err(AclError::NegativeAmount(amount_minor));\n    }\n    match raw {\n        \"queued\" | \"pending\" => Ok(PayoutState::Queued),\n        \"paid\" | \"settled\" => Ok(PayoutState::Paid),\n        \"returned\" | \"reversed\" => Ok(PayoutState::Returned),\n        other => Err(AclError::UnknownStatus(other.to_owned())),\n    }\n}",
          "tip": "An unknown foreign status is an error, not a default. The default hides money."
        }
      ],
      "exercise": {
        "prompt": "A marketplace has catalog, pricing, and payouts, and all three describe a product. Write the context map as three small crates that share only an opaque ProductId, and add an ACL that translates a payout status string into a domain enum and rejects anything unknown.",
        "starter": "// crates/catalog/src/lib.rs\npub struct ProductId(uuid::Uuid);\npub struct Product { /* title, description, images */ }\n\n// crates/pricing/src/lib.rs\npub struct PriceBook { /* prices keyed by ProductId */ }\n\n// crates/payouts/src/lib.rs\npub struct Balance { /* available, pending */ }\n\n// TODO: translate payout provider status -> domain enum, unknown = error",
        "hint": "Catalog owns descriptive text, pricing owns price books, payouts owns balances. Share only the opaque id, and make the translation match exhaustive with an Unknown(error) arm plus a test that feeds a bogus status.",
        "solution": "// crates/shared-ids/src/lib.rs  (shared kernel: one type, no behaviour)\n#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]\npub struct ProductId(pub uuid::Uuid);\n\n// crates/catalog/src/lib.rs\nuse shared_ids::ProductId;\npub struct Product { pub id: ProductId, pub title: String }\n\n// crates/pricing/src/lib.rs\nuse shared_ids::ProductId;\npub struct PriceBook { pub entries: Vec<(ProductId, i64)> }\n\n// crates/payouts/src/lib.rs\nuse shared_ids::ProductId;\n\n#[derive(Debug, PartialEq, Eq)]\npub enum PayoutState { Queued, Paid, Returned }\n\n#[derive(Debug, PartialEq, Eq, thiserror::Error)]\n#[error(\"unknown payout status: {0}\")]\npub struct UnknownStatus(pub String);\n\npub fn translate(raw: &str) -> Result<PayoutState, UnknownStatus> {\n    match raw {\n        \"queued\" | \"pending\" => Ok(PayoutState::Queued),\n        \"paid\" | \"settled\" => Ok(PayoutState::Paid),\n        \"returned\" | \"reversed\" => Ok(PayoutState::Returned),\n        other => Err(UnknownStatus(other.to_owned())),\n    }\n}\n\n#[test]\nfn unknown_status_is_rejected() {\n    assert_eq!(translate(\"held_by_risk\"), Err(UnknownStatus(\"held_by_risk\".into())));\n}"
      },
      "production": [
        "Every context owns its schema and its migrations; no production query joins another context tables.",
        "The context map lives in the repository as an ADR or a README table, with the relationship type named per edge.",
        "A shared kernel crate has one named owning team and a CODEOWNERS entry that requires their review.",
        "Foreign enums never cross into the domain crate; an exhaustive ACL match is the only translator.",
        "A CI check fails when a new cross-context path dependency appears in Cargo.toml."
      ],
      "crates": [
        "uuid",
        "thiserror",
        "serde"
      ],
      "github": [
        {
          "name": "uuid-rs/uuid",
          "url": "https://github.com/uuid-rs/uuid"
        },
        {
          "name": "ddd-by-examples/library",
          "url": "https://github.com/ddd-by-examples/library"
        }
      ],
      "pitfall": "A shared types crate that every context imports: one field rename becomes a workspace-wide release, and the contexts you separated re-couple at the speed of a commit.",
      "questions": [
        {
          "q": "Which signal most strongly indicates that two capabilities belong in different bounded contexts?",
          "options": [
            "They are owned by different teams and use conflicting definitions of the same business term",
            "They are deployed as separate binaries today",
            "They happen to live in different database schemas",
            "They were written by different people in the same quarter"
          ],
          "answer": 0,
          "explain": "Conflicting meaning plus separate ownership is the actual boundary condition. Deployment, schemas, and authorship are consequences that can be changed; a term that means two things cannot be merged into one model."
        },
        {
          "q": "A payout provider returns a status string the domain has never seen. What should the anti-corruption layer do?",
          "options": [
            "Map it to Pending so processing continues",
            "Return an explicit error and raise it to an alert with the raw value",
            "Retry the webhook until the provider sends a known status",
            "Drop the event and log at debug level"
          ],
          "answer": 1,
          "explain": "Unknown upstream state is unmodelled business reality. Mapping it to Pending invents a fact about money. Failing loudly with the raw value makes the gap visible and forces a deliberate mapping change."
        },
        {
          "q": "Why prefer Uuid::now_v7 over new_v4 for aggregate identifiers stored in Postgres?",
          "options": [
            "v7 values are shorter on the wire",
            "v7 values are time-ordered, so inserts stay near the end of the B-tree instead of scattering",
            "v7 values are cryptographically signed and therefore tamper-proof",
            "v7 values remove the possibility of collisions entirely"
          ],
          "answer": 1,
          "explain": "Random v4 keys write into random leaf pages, which dirties the whole index. Time-ordered v7 keys concentrate writes at the right edge, which keeps the working set small and improves cache hit rate."
        }
      ],
      "quickbytes": [
        "Name the context in every crate and every schema: orders_billing, orders_fulfilment, never just orders.",
        "One id type per context; if you need to cross contexts, carry the opaque id and translate at the edge.",
        "Keep the glossary next to the code that implements it; a wiki page drifts within a sprint."
      ],
      "resources": [
        {
          "title": "docs.rs: uuid 1.29, v4 and v7 generation",
          "url": "https://docs.rs/uuid/latest/uuid/",
          "kind": "docs"
        },
        {
          "title": "thiserror: derive Error for domain error enums",
          "url": "https://docs.rs/thiserror/latest/thiserror/",
          "kind": "docs"
        },
        {
          "title": "Domain-Driven Design by example: strategic and tactical patterns",
          "url": "https://github.com/ddd-by-examples/library",
          "kind": "repo"
        },
        {
          "title": "The Cargo Book: workspaces as context boundaries",
          "url": "https://doc.rust-lang.org/cargo/reference/workspaces.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "q02",
      "title": "Hexagonal ports and adapters",
      "minutes": 85,
      "level": "core",
      "goal": "Put every I/O decision behind a port trait the domain owns, implement it in adapters, and keep the domain crate free of sqlx and axum.",
      "sections": [
        {
          "h": "The dependency arrow points inward",
          "p": [
            "Hexagonal architecture is one rule with a large consequence: the application core defines the interfaces it needs, and everything external implements them. The domain crate declares OrderRepository, Clock, and PaymentGateway; Postgres, chrono, and the processor client live in crates that depend on the core, never the other way around. The compiler then enforces the architecture instead of a diagram doing it.",
            "Two kinds of ports share the vocabulary. Driven ports are what the core needs from the world (load, save, charge, now). Driving ports are how the world reaches the core (HTTP handlers, queue consumers, CLI commands). Adapters implement driven ports and call driving ones. Keep ports shaped by what one use case needs, not by what one table looks like."
          ],
          "list": [
            "Domain crate dependencies: uuid, thiserror, serde at most; no sqlx, no axum, no reqwest",
            "A port method takes domain types and returns domain types, plus a domain-level error",
            "Adapters translate infrastructure errors into port errors at the boundary",
            "If a use case needs a new field, change the port deliberately, not the schema"
          ],
          "tip": "If you cannot write the use case test with only the core crate and a Vec-backed fake, the port is too wide or it leaks infrastructure."
        },
        {
          "h": "Async ports and the dyn-compatibility tax",
          "p": [
            "Since Rust 1.75 you can write async fn in a trait, but such a trait is not dyn compatible: the compiler cannot build a vtable for a method returning an anonymous future. Storing Arc<dyn OrderRepository> in application state therefore needs type erasure, which is exactly what async-trait 0.1.92 provides by rewriting each method to return Pin<Box<dyn Future + Send>>.",
            "That is one allocation per port call. Against a Postgres round trip it is noise, so take the boxing and keep the wiring simple. The alternative, making every use case generic over R: OrderRepository, removes the allocation but pushes the type parameter through every struct, handler, and test until the handler signatures become unreadable."
          ],
          "code": "use std::sync::Arc;\nuse async_trait::async_trait;\nuse uuid::Uuid;\n\n#[derive(Clone, Copy, PartialEq, Eq, Debug)]\npub struct OrderId(pub Uuid);\n\n#[derive(Debug, thiserror::Error)]\npub enum RepoError {\n    #[error(\"order {0:?} changed concurrently\")]\n    Conflict(OrderId),\n    #[error(\"storage unavailable: {0}\")]\n    Unavailable(String),\n}\n\n/// Driven port: owned by the core, implemented by the SQL adapter.\n#[async_trait]\npub trait OrderRepository: Send + Sync {\n    async fn load(&self, id: OrderId) -> Result<Option<Order>, RepoError>;\n    async fn save(&self, order: &Order, expected_version: u32) -> Result<(), RepoError>;\n}\n\npub struct AppState {\n    pub orders: Arc<dyn OrderRepository>,\n}",
          "tip": "Bound ports with Send + Sync when handlers are spawned on the multithreaded runtime; drop to #[async_trait(?Send)] only for single-threaded tests."
        },
        {
          "h": "Adapters absorb the mess, including error translation",
          "p": [
            "SQL, retries, connection pools, and JSON mapping belong in the adapter. The important discipline is the last one hundred lines: translating infrastructure failures into port errors. A unique-violation on the version column is a Conflict the use case can retry; a pool timeout is Unavailable; a decoding bug is a panic-worthy invariant violation, not a user error.",
            "Match on the database error code rather than the message text. Postgres reports unique_violation as SQLSTATE 23505, which sqlx exposes through the database error. String matching breaks on the first locale change or server upgrade, and it fails silently by classifying a conflict as retryable-unavailable, which turns a lost update into a retry storm."
          ],
          "code": "use sqlx::{PgPool, Row};\n\npub struct PgOrderRepository {\n    pool: PgPool,\n}\n\n#[async_trait::async_trait]\nimpl OrderRepository for PgOrderRepository {\n    async fn load(&self, id: OrderId) -> Result<Option<Order>, RepoError> {\n        let row = sqlx::query(\"SELECT id, version, status FROM orders WHERE id = $1\")\n            .bind(id.0)\n            .fetch_optional(&self.pool)\n            .await\n            .map_err(|e| RepoError::Unavailable(e.to_string()))?;\n        row.map(|row| {\n            Ok(Order {\n                id: OrderId(row.get(\"id\")),\n                version: row.get::<i32, _>(\"version\") as u32,\n                status: row.get(\"status\"),\n            })\n        })\n        .transpose()\n    }\n\n    async fn save(&self, order: &Order, expected_version: u32) -> Result<(), RepoError> {\n        let affected = sqlx::query(\n            \"UPDATE orders SET status = $2, version = version + 1\n             WHERE id = $1 AND version = $3\",\n        )\n        .bind(order.id.0)\n        .bind(&order.status)\n        .bind(expected_version as i32)\n        .execute(&self.pool)\n        .await\n        .map_err(|e| RepoError::Unavailable(e.to_string()))?\n        .rows_affected();\n\n        if affected == 0 {\n            return Err(RepoError::Conflict(order.id));\n        }\n        Ok(())\n    }\n}",
          "tip": "A zero rows_affected on a version-guarded UPDATE is the optimistic concurrency signal; never treat it as success."
        }
      ],
      "exercise": {
        "prompt": "Take a use case that places an order and needs the current time for a price-expiry check. Add a Clock port, a SystemClock adapter, and a FixedClock test double, then write a test that proves an expired quote is rejected without touching a database.",
        "starter": "pub struct PlaceOrder { /* what does it need? */ }\n\n// TODO: define a Clock port, implement it twice, and test expiry with the fake.\nimpl PlaceOrder {\n    pub async fn execute(&self) -> Result<(), ()> {\n        todo!()\n    }\n}",
        "hint": "The port returns a domain type (time::OffsetDateTime or std::time::SystemTime wrapped in your own newtype). The fixed clock returns a constant, so the expiry test needs no sleeping and no database.",
        "solution": "use std::sync::Arc;\nuse async_trait::async_trait;\n\n#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]\npub struct Timestamp(pub i64); // unix seconds\n\n#[async_trait]\npub trait Clock: Send + Sync {\n    fn now(&self) -> Timestamp;\n}\n\npub struct SystemClock;\nimpl Clock for SystemClock {\n    fn now(&self) -> Timestamp {\n        Timestamp(\n            std::time::SystemTime::now()\n                .duration_since(std::time::UNIX_EPOCH)\n                .expect(\"clock before 1970\")\n                .as_secs() as i64,\n        )\n    }\n}\n\npub struct FixedClock(pub Timestamp);\nimpl Clock for FixedClock {\n    fn now(&self) -> Timestamp { self.0 }\n}\n\npub struct Quote { pub expires_at: Timestamp }\n\n#[derive(Debug, PartialEq, Eq)]\npub enum PlaceError { QuoteExpired }\n\npub struct PlaceOrder {\n    pub clock: Arc<dyn Clock>,\n}\n\nimpl PlaceOrder {\n    pub fn execute(&self, quote: Quote) -> Result<Timestamp, PlaceError> {\n        let now = self.clock.now();\n        if quote.expires_at < now {\n            return Err(PlaceError::QuoteExpired);\n        }\n        Ok(now)\n    }\n}\n\n#[test]\nfn expired_quote_is_rejected() {\n    let use_case = PlaceOrder { clock: Arc::new(FixedClock(Timestamp(1_000))) };\n    let quote = Quote { expires_at: Timestamp(999) };\n    assert_eq!(use_case.execute(quote), Err(PlaceError::QuoteExpired));\n}"
      },
      "production": [
        "The domain crate manifest lists no persistence, HTTP, or telemetry dependency, and CI fails if one appears.",
        "Every driven port has at least one fake in tests and one real adapter in production; a port with only a fake is dead weight.",
        "Adapters translate SQLSTATE codes, not error strings, into port errors.",
        "Handlers depend on use cases, and use cases depend on ports; no handler imports sqlx directly.",
        "Port traits stay under about five methods, or every adapter grows unimplemented!() branches."
      ],
      "crates": [
        "async-trait",
        "sqlx",
        "thiserror",
        "uuid"
      ],
      "github": [
        {
          "name": "dtolnay/async-trait",
          "url": "https://github.com/dtolnay/async-trait"
        },
        {
          "name": "launchbadge/sqlx",
          "url": "https://github.com/transact-rs/sqlx"
        }
      ],
      "pitfall": "A port that returns sqlx::Error, or a repository method that takes a query object: the domain now depends on the driver in everything but the manifest, and the hexagon is decorative.",
      "questions": [
        {
          "q": "Why does storing Arc<dyn OrderRepository> require async-trait rather than a plain async fn in a trait?",
          "options": [
            "Plain async fn in traits requires nightly Rust",
            "A trait with async methods is not dyn compatible, so no vtable can be built for dyn Trait",
            "Arc cannot hold types that contain futures",
            "async fn in traits cannot return Result types"
          ],
          "answer": 1,
          "explain": "Async fn in traits stabilized in 1.75, but the returned future is anonymous, which breaks object safety. async-trait boxes the future behind a concrete type so dyn works."
        },
        {
          "q": "A version-guarded UPDATE affects zero rows. What does the adapter return?",
          "options": [
            "Ok(()) because the row may not need changing",
            "RepoError::Conflict so the use case can reload and retry",
            "RepoError::Unavailable so the caller retries with backoff",
            "A panic, because concurrent writes are impossible in Postgres"
          ],
          "answer": 1,
          "explain": "Zero rows means the expected version is gone: someone else wrote first. That is a conflict to reload and re-decide, not a transient outage and definitely not success."
        },
        {
          "q": "Which dependency is legitimate inside the domain crate of a hexagonal design?",
          "options": [
            "axum, so the domain can implement IntoResponse for its errors",
            "sqlx, so aggregates can load their own children",
            "thiserror, so domain errors implement std::error::Error",
            "tower-http, so the domain can add a trace layer"
          ],
          "answer": 2,
          "explain": "thiserror is a pure derive over std traits and adds no I/O. The others drag request or database types into the model, which is precisely what ports are meant to prevent."
        }
      ],
      "quickbytes": [
        "One allocation per port call from async-trait is cheaper than the coupling you would accept to avoid it.",
        "Write the fake adapter first; if it is awkward to build, the port is wrong.",
        "Keep the composition root in a single main.rs so wiring is reviewable in one screen."
      ],
      "resources": [
        {
          "title": "docs.rs: async-trait and the dyn-compatibility gap",
          "url": "https://docs.rs/async-trait/latest/async_trait/",
          "kind": "docs"
        },
        {
          "title": "docs.rs: sqlx 0.9 pools, transactions and error types",
          "url": "https://docs.rs/sqlx/latest/sqlx/",
          "kind": "docs"
        },
        {
          "title": "sqlx repository: query macros and migrations",
          "url": "https://github.com/transact-rs/sqlx",
          "kind": "repo"
        },
        {
          "title": "Hexagonal architecture example with strategic and tactical DDD",
          "url": "https://github.com/ddd-by-examples/library",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "q03",
      "title": "Clean architecture: use cases and the composition root",
      "minutes": 70,
      "level": "core",
      "goal": "Separate use-case orchestration from transport and storage, then construct every dependency in one place so tests and production share the same wiring.",
      "sections": [
        {
          "h": "The dependency rule, expressed in manifests",
          "p": [
            "Clean architecture adds one rule to the hexagonal shape: source-code dependencies point inward, layer by layer. Transport adapters depend on application use cases, use cases depend on domain types, and the domain depends on nothing. In Rust the rule is visible in four Cargo.toml files, which is the only architecture diagram that cannot drift.",
            "The practical split is crates/domain, crates/application, crates/adapters, and a binary crate. The binary is the only crate allowed to depend on all three. When someone needs a new HTTP field, the change lands in adapters; when a rule changes, it lands in domain and application. Each change has one home, and a reviewer can see which layer moved from the file path."
          ],
          "code": "# Cargo.toml (workspace)\n[workspace]\nresolver = \"3\"\nmembers = [\"crates/domain\", \"crates/application\", \"crates/adapters\", \"apps/api\"]\n\n# crates/domain/Cargo.toml\n[dependencies]\nuuid = { version = \"1\", features = [\"v7\", \"serde\"] }\nthiserror = \"2\"\n\n# crates/application/Cargo.toml\n[dependencies]\ndomain = { path = \"../domain\" }\nasync-trait = \"0.1\"\n\n# crates/adapters/Cargo.toml\n[dependencies]\napplication = { path = \"../application\" }\nsqlx = { version = \"0.9\", features = [\"runtime-tokio\", \"postgres\", \"macros\"] }\naxum = \"0.8\"",
          "tip": "Add a CI check that greps crates/domain/Cargo.toml for sqlx, axum, tower, reqwest. Rules that live only in a wiki are broken within a quarter."
        },
        {
          "h": "A use case is a struct with an execute method",
          "p": [
            "Model each use case as a small struct holding the ports it needs, with one execute method. That gives you a named unit for authorisation, transaction scope, and metrics, and it keeps the HTTP handler to three lines: parse, call, map. Handlers that assemble queries and business rules cannot be tested without a server.",
            "The use case returns application errors, not HTTP status codes. Map them once in the adapter with a single match: validation becomes 400, not-found becomes 404, conflict becomes 409, and anything unknown becomes 500 with a correlation id in the body and the detail in the log. That mapping is the transport layer only job."
          ],
          "code": "use std::sync::Arc;\nuse domain::{Order, OrderId, Quantity};\n\npub struct PlaceOrder {\n    pub orders: Arc<dyn OrderRepository>,\n    pub pricing: Arc<dyn PricingPort>,\n}\n\n#[derive(Debug, thiserror::Error)]\npub enum PlaceOrderError {\n    #[error(\"quantity must be positive\")]\n    EmptyQuantity,\n    #[error(\"pricing unavailable\")]\n    PricingDown,\n    #[error(\"order {0:?} not found\")]\n    NotFound(OrderId),\n}\n\nimpl PlaceOrder {\n    pub async fn execute(&self, sku: String, qty: u32) -> Result<OrderId, PlaceOrderError> {\n        let quantity = Quantity::new(qty).map_err(|_| PlaceOrderError::EmptyQuantity)?;\n        let unit_price = self\n            .pricing\n            .price_of(&sku)\n            .await\n            .map_err(|_| PlaceOrderError::PricingDown)?;\n\n        let order = Order::place(sku, quantity, unit_price);\n        self.orders.save(&order, 0).await.map_err(|e| match e {\n            RepoError::Conflict(_) => PlaceOrderError::PricingDown,\n            RepoError::Unavailable(_) => PlaceOrderError::PricingDown,\n        })?;\n        Ok(order.id)\n    }\n}",
          "tip": "If execute() needs more than about forty lines, it is orchestrating two use cases; split it before the tests get hard."
        },
        {
          "h": "The composition root is the only place that knows concrete types",
          "p": [
            "Construct everything once, in main, and pass it down as trait objects. That single function is the map of the system: what database, which clients, which decorators wrap which port. It is also the only place where a missing environment variable should be fatal, because every other component receives a working dependency.",
            "Avoid the service-locator shortcut of a global registry keyed by type. It compiles, but it hides the dependency graph, makes every test order-dependent, and turns a wiring mistake into a runtime panic. A build_app(deps) function returning a Router gives integration tests the same graph as production with a fake adapter swapped in."
          ],
          "code": "use std::sync::Arc;\nuse anyhow::Context;\n\n#[tokio::main]\nasync fn main() -> anyhow::Result<()> {\n    let database_url = std::env::var(\"DATABASE_URL\").context(\"DATABASE_URL missing\")?;\n    let pool = sqlx::postgres::PgPoolOptions::new()\n        .max_connections(32)\n        .connect(&database_url)\n        .await?;\n\n    // The only place in the program that names a concrete adapter.\n    let orders: Arc<dyn OrderRepository> = Arc::new(PgOrderRepository::new(pool.clone()));\n    let pricing: Arc<dyn PricingPort> = Arc::new(HttpPricingClient::from_env()?);\n\n    let place_order = Arc::new(PlaceOrder { orders, pricing });\n    let app = build_app(place_order);\n\n    let listener = tokio::net::TcpListener::bind(\"0.0.0.0:8080\").await?;\n    axum::serve(listener, app).await?;\n    Ok(())\n}\n\npub fn build_app(place_order: Arc<PlaceOrder>) -> axum::Router {\n    axum::Router::new()\n        .route(\"/orders\", axum::routing::post(handlers::place_order))\n        .with_state(place_order)\n}",
          "tip": "Take the listener address and pool size from config, but construct clients eagerly so a bad endpoint fails at boot rather than on the first request."
        }
      ],
      "exercise": {
        "prompt": "Move an HTTP handler that currently opens a transaction and validates a coupon into a use case with two ports: CouponValidator and OrderRepository. Keep the handler to parsing and error mapping, and write a test that runs the use case with both fakes.",
        "starter": "async fn place_order(Json(req): Json<PlaceReq>, State(pool): State<PgPool>) -> Result<Json<OrderId>, StatusCode> {\n    // TODO: extract validation into a port, persistence into a repository,\n    // and leave only parsing + status mapping here.\n    todo!()\n}",
        "hint": "The use case owns the sequence: validate coupon, build order, save. The handler owns the HTTP contract: JSON in, status code out, and one match over the application error enum.",
        "solution": "use std::sync::Arc;\n\npub struct Coupon { pub code: String, pub percent_off: u8 }\n\n#[async_trait::async_trait]\npub trait CouponValidator: Send + Sync {\n    async fn validate(&self, code: &str) -> Result<Coupon, String>;\n}\n\npub struct PlaceOrderWithCoupon {\n    pub coupons: Arc<dyn CouponValidator>,\n    pub orders: Arc<dyn OrderRepository>,\n}\n\n#[derive(Debug, thiserror::Error)]\npub enum Error {\n    #[error(\"invalid coupon\")]\n    InvalidCoupon,\n    #[error(\"storage conflict, retry\")]\n    Conflict,\n}\n\nimpl PlaceOrderWithCoupon {\n    pub async fn execute(&self, sku: String, qty: u32, code: String) -> Result<OrderId, Error> {\n        let coupon = self.coupons.validate(&code).await.map_err(|_| Error::InvalidCoupon)?;\n        let order = Order::place_discounted(sku, qty, coupon.percent_off);\n        self.orders\n            .save(&order, 0)\n            .await\n            .map_err(|e| match e {\n                RepoError::Conflict(_) => Error::Conflict,\n                RepoError::Unavailable(_) => Error::Conflict,\n            })?;\n        Ok(order.id)\n    }\n}\n\n// Handler: no business logic, only contract mapping.\nasync fn place_order(\n    State(use_case): State<Arc<PlaceOrderWithCoupon>>,\n    Json(req): Json<PlaceReq>,\n) -> Result<Json<OrderId>, (StatusCode, &'static str)> {\n    use_case\n        .execute(req.sku, req.qty, req.coupon)\n        .await\n        .map(Json)\n        .map_err(|e| match e {\n            Error::InvalidCoupon => (StatusCode::BAD_REQUEST, \"invalid coupon\"),\n            Error::Conflict => (StatusCode::CONFLICT, \"try again\"),\n        })\n}"
      },
      "production": [
        "Each use case is one struct with one execute method and an explicit error enum; handlers contain no domain branching.",
        "The composition root is a single function that reads config, builds adapters, and returns the router.",
        "Application errors map to status codes in exactly one place per transport.",
        "No global mutable registry, lazy static client, or ambient database handle exists in the codebase.",
        "Integration tests call build_app with fake adapters, so wiring bugs surface without a database."
      ],
      "crates": [
        "axum",
        "async-trait",
        "thiserror",
        "sqlx"
      ],
      "github": [
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        },
        {
          "name": "dtolnay/async-trait",
          "url": "https://github.com/dtolnay/async-trait"
        }
      ],
      "pitfall": "Routers built inside tests with a different wiring path than main: production-only panics such as a missing extension appear after deploy, never in CI.",
      "questions": [
        {
          "q": "Where should the decision \"RepoError::Conflict becomes HTTP 409\" live?",
          "options": [
            "In the domain aggregate, so it is decided once",
            "In the use case, which returns application errors",
            "In the HTTP adapter, mapping application errors to status codes",
            "In the database, via a constraint name"
          ],
          "answer": 2,
          "explain": "The domain has no notion of HTTP. The use case speaks in application errors so other transports can map them differently, and the adapter owns the status code table."
        },
        {
          "q": "What is the main risk of a global service locator for dependencies?",
          "options": [
            "It is slower than passing Arc values",
            "It hides the dependency graph and turns wiring mistakes into runtime failures",
            "It cannot hold trait objects",
            "It prevents using async functions"
          ],
          "answer": 1,
          "explain": "A registry compiles regardless of whether the key was ever registered. The failure appears at request time, in production, and tests become order dependent."
        },
        {
          "q": "Which crate may the composition root depend on that the domain must not?",
          "options": [
            "thiserror",
            "uuid",
            "sqlx",
            "serde"
          ],
          "answer": 2,
          "explain": "The composition root exists to name concrete infrastructure, so sqlx belongs there. The domain may use pure data and error derives, but never a driver."
        }
      ],
      "quickbytes": [
        "One handler, one job: deserialize, call execute, map the error. Anything longer is a use case hiding in the transport.",
        "Return application errors from use cases; let each transport own its status-code table.",
        "Construct eagerly in main and fail fast: a missing env var should stop the process, not the third request."
      ],
      "resources": [
        {
          "title": "tokio-rs/axum: routers, state and layer ordering",
          "url": "https://github.com/tokio-rs/axum",
          "kind": "repo"
        },
        {
          "title": "docs.rs: axum 0.8 state, extractors and responses",
          "url": "https://docs.rs/axum/latest/axum/",
          "kind": "docs"
        },
        {
          "title": "The Cargo Book: workspace dependency inheritance",
          "url": "https://doc.rust-lang.org/cargo/reference/workspaces.html",
          "kind": "docs"
        },
        {
          "title": "sqlx: transactions, pool configuration and compile-time checked queries",
          "url": "https://docs.rs/sqlx/latest/sqlx/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "q04",
      "title": "Modular monolith: seams inside one deployable",
      "minutes": 80,
      "level": "core",
      "goal": "Keep one binary and one transaction while making module boundaries a compile error, then decide per use case where shared transactions are worth it.",
      "sections": [
        {
          "h": "One binary, seams the compiler enforces",
          "p": [
            "A modular monolith keeps one deployable but refuses to let modules reach into each other. In Rust the cheapest real enforcement is a workspace of module crates linked into a single binary: orders, billing, and inventory are separate crates, a module may use another module published facade, and Cargo rejects everything else. You keep one transaction, one deploy, and one on-call rotation without giving up the seam that makes later extraction possible.",
            "Inside one crate you can approximate this with visibility: a module exposes a facade struct and keeps rows and helpers private. That is weaker, because pub(crate) still lets any module reach the SQL and reviewers miss it in a large diff. Separate crates turn the boundary into a compile error, and a compile error is the only architecture rule that survives a deadline."
          ],
          "list": [
            "One binary, several module crates, one Cargo.lock and one release cadence",
            "Each module owns its schema and ships its own migrations",
            "Cross-module calls go through a facade or an event, never through a shared table",
            "A module never gains a dependency on another module internal crate"
          ],
          "code": "# Cargo.toml\n[workspace]\nresolver = \"3\"\nmembers = [\n    \"crates/orders\",      # orders-api (facade) + orders-impl\n    \"crates/inventory\",\n    \"crates/billing\",\n    \"apps/server\",        # depends on all facades, nothing else\n]\n\n# crates/orders/Cargo.toml\n[package]\nname = \"orders\"\n[dependencies]\nuuid = { version = \"1\", features = [\"v7\"] }\nthiserror = \"2\"\n# deliberately absent: inventory, billing\n\n# crates/orders/src/lib.rs\nmod inner; // private: rows, SQL, invariants\n\npub struct OrdersModule {\n    inner: inner::OrdersImpl,   // private field, private type\n}\n\nimpl OrdersModule {\n    /// Facade: the only public surface other modules may call.\n    pub async fn place(&self, cmd: PlaceOrder) -> Result<OrderId, PlaceOrderError> {\n        self.inner.place(cmd).await\n    }\n}",
          "tip": "Name the facade type after the module (OrdersModule) and keep the implementation module private; then grepping for orders_impl in other crates finds violations fast."
        },
        {
          "h": "The monolith advantage is a transaction",
          "p": [
            "The reason to stay in one process is the transaction. Reserving stock and creating an order can commit together, so there is no compensation, no saga, and no eventual-consistency bug at three in the morning. A modular monolith should spend that advantage where an invariant genuinely spans modules, and use events everywhere else so the transactional core stays small and fast.",
            "Decide per use case, not per architecture. Checkout may need one transaction across orders and stock; sending a receipt does not. Wrapping the receipt send in the same transaction turns an email outage into a checkout outage, which is precisely the coupling the module boundary exists to keep local."
          ],
          "code": "use sqlx::{PgPool, Postgres, Transaction};\n\npub async fn place_order(\n    pool: &PgPool,\n    orders: &OrdersModule,\n    inventory: &InventoryModule,\n    cmd: PlaceOrder,\n) -> Result<OrderId, PlaceOrderError> {\n    // One transaction across two modules: allowed because both are in-process.\n    let mut tx: Transaction<'_, Postgres> = pool.begin().await?;\n    let reservation = inventory\n        .reserve_in(&mut tx, &cmd.sku, cmd.qty)\n        .await\n        .map_err(|_| PlaceOrderError::OutOfStock)?;\n    let order_id = orders.create_in(&mut tx, cmd, reservation.id).await?;\n    tx.commit().await?;\n\n    // Reactions happen after commit, never inside it.\n    tracing::info!(?order_id, \"order committed; receipt job enqueued\");\n    Ok(order_id)\n}",
          "tip": "Pass &mut Transaction into module functions instead of letting a module open its own transaction; nested transactions are savepoints and do not give you what you expect."
        },
        {
          "h": "In-process events, and the point where they are not enough",
          "p": [
            "An in-process broadcast channel is a fine bus for reactions that may be dropped, such as warming a cache or refreshing a dashboard. It is the wrong bus for anything that must happen, because a restart loses the queue and a lagging receiver silently skips messages: tokio::sync::broadcast drops the oldest entries and reports Lagged.",
            "The moment a reaction matters, write an outbox row in the same transaction and let a relay publish it. The monolith has exactly the same durability problem as microservices, just a cheaper fix: no broker to operate, one table to poll, one worker to supervise. Treating lag as data loss from day one keeps the choice honest."
          ],
          "code": "use tokio::sync::broadcast;\n\n#[derive(Clone, Debug)]\npub enum DomainEvent {\n    OrderPlaced { order_id: uuid::Uuid },\n    OrderCancelled { order_id: uuid::Uuid },\n}\n\npub struct EventBus {\n    tx: broadcast::Sender<DomainEvent>,\n}\n\nimpl EventBus {\n    pub fn new(capacity: usize) -> Self {\n        let (tx, _rx) = broadcast::channel(capacity);\n        Self { tx }\n    }\n\n    /// Best-effort fan-out. Losing an event here must be acceptable.\n    pub fn publish(&self, event: DomainEvent) {\n        if self.tx.send(event).is_err() {\n            tracing::debug!(\"no subscribers for domain event\");\n        }\n    }\n}\n\npub fn spawn_cache_warmer(bus: &EventBus) {\n    let mut rx = bus.tx.subscribe();\n    tokio::spawn(async move {\n        loop {\n            match rx.recv().await {\n                Ok(DomainEvent::OrderPlaced { order_id }) => {\n                    tracing::debug!(%order_id, \"warming order cache\");\n                }\n                Ok(_) => {}\n                Err(broadcast::error::RecvError::Lagged(n)) => {\n                    // Data loss by design: acceptable only for best-effort work.\n                    tracing::warn!(skipped = n, \"event bus lagged\");\n                }\n                Err(broadcast::error::RecvError::Closed) => break,\n            }\n        }\n    });\n}",
          "tip": "If a Lagged warning would page someone, the reaction belongs in an outbox, not on a broadcast channel."
        }
      ],
      "exercise": {
        "prompt": "Split checkout into two module crates, orders and inventory. Decide which steps share the database transaction and which become events, then write the workspace manifest and the facade signatures that make the boundary compile-enforced.",
        "starter": "# Cargo.toml\n[workspace]\nmembers = [\"crates/orders\", \"crates/inventory\", \"apps/server\"]\n\n// TODO: facade signatures for reserve + create, and the event that fires after commit",
        "hint": "Reserve and create must commit together to avoid selling stock you do not have. The receipt and the analytics ping happen after commit through an outbox row, not inside the transaction.",
        "solution": "// crates/inventory/src/lib.rs\npub struct InventoryModule { pool: sqlx::PgPool }\n\n#[derive(Debug, thiserror::Error)]\npub enum ReserveError {\n    #[error(\"insufficient stock\")]\n    OutOfStock,\n    #[error(\"storage: {0}\")]\n    Storage(String),\n}\n\nimpl InventoryModule {\n    pub async fn reserve_in(\n        &self,\n        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,\n        sku: &str,\n        qty: u32,\n    ) -> Result<Reservation, ReserveError> {\n        let row = sqlx::query(\n            \"UPDATE stock SET reserved = reserved + $2\n             WHERE sku = $1 AND available >= $2\n             RETURNING id\",\n        )\n        .bind(sku)\n        .bind(qty as i32)\n        .fetch_optional(&mut **tx)\n        .await\n        .map_err(|e| ReserveError::Storage(e.to_string()))?;\n        row.map(|r| Reservation { id: sqlx::Row::get(&r, \"id\") })\n            .ok_or(ReserveError::OutOfStock)\n    }\n}\n\n// crates/orders/src/lib.rs\nimpl OrdersModule {\n    pub async fn create_in(\n        &self,\n        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,\n        cmd: PlaceOrder,\n        reservation: uuid::Uuid,\n    ) -> Result<OrderId, PlaceOrderError> {\n        let id = OrderId(uuid::Uuid::now_v7());\n        sqlx::query(\"INSERT INTO orders (id, sku, qty, reservation_id) VALUES ($1,$2,$3,$4)\")\n            .bind(id.0).bind(cmd.sku).bind(cmd.qty as i32).bind(reservation)\n            .execute(&mut **tx)\n            .await\n            .map_err(|e| PlaceOrderError::Storage(e.to_string()))?;\n        Ok(id)\n    }\n}\n\n// apps/server/src/main.rs — the only crate that depends on both facades\nlet inventory = InventoryModule::new(pool.clone());\nlet orders = OrdersModule::new(pool.clone());\nlet order_id = place_order(&pool, &orders, &inventory, cmd).await?;"
      },
      "production": [
        "A CI dependency check fails when one module crate depends on another module internal crate instead of its facade.",
        "Every module owns its tables and migrations; a query joining two modules is a design review item, not a code review comment.",
        "Reactions that must not be lost write an outbox row inside the same transaction and are published by a relay.",
        "The workspace has one Cargo.lock and one release tag; version skew between modules is impossible by construction.",
        "A written ADR records which use cases intentionally share a transaction and what would justify extracting them."
      ],
      "crates": [
        "sqlx",
        "tokio",
        "axum"
      ],
      "github": [
        {
          "name": "kgrzybek/modular-monolith-with-ddd",
          "url": "https://github.com/kgrzybek/modular-monolith-with-ddd"
        },
        {
          "name": "launchbadge/sqlx",
          "url": "https://github.com/transact-rs/sqlx"
        }
      ],
      "pitfall": "A shared models crate that both modules import for their rows: the boundary exists in the workspace layout, but every schema change is still a lock-step edit of two modules.",
      "questions": [
        {
          "q": "Why do separate module crates enforce a modular monolith better than modules in one crate?",
          "options": [
            "Separate crates compile faster",
            "Cargo rejects a dependency on a private internal crate, so a boundary violation is a build failure",
            "Separate crates cannot share a database pool",
            "Module crates get separate runtimes automatically"
          ],
          "answer": 1,
          "explain": "pub(crate) is a soft boundary that reviewers can miss. A missing dependency edge in Cargo.toml is a hard error at build time, which is what an architecture rule needs."
        },
        {
          "q": "Which step should NOT be inside the checkout transaction?",
          "options": [
            "Reserving stock for the ordered quantity",
            "Inserting the order row",
            "Sending the confirmation email",
            "Writing the outbox row for the receipt job"
          ],
          "answer": 2,
          "explain": "An email provider outage must not roll back a paid order. Enqueue an outbox row in the transaction, then send outside it."
        },
        {
          "q": "An in-process broadcast subscriber reports Lagged. What does that mean for the consumer?",
          "options": [
            "Messages were dropped because the receiver fell behind",
            "The channel is closed and will never deliver again",
            "The sender panicked and the message was retried",
            "The receiver was paused by the runtime for too long and resumed exactly where it stopped"
          ],
          "answer": 0,
          "explain": "broadcast keeps a bounded ring; a slow receiver loses the oldest entries and is told how many. For must-not-lose work that is unacceptable, which is why the outbox exists."
        }
      ],
      "quickbytes": [
        "One binary, one Cargo.lock, N module crates: you keep the deploy simplicity and get compile-enforced seams.",
        "Pass &mut Transaction into module functions so the caller owns commit and rollback.",
        "Best-effort reactions on broadcast, must-happen reactions in an outbox. Decide per reaction, not per project."
      ],
      "resources": [
        {
          "title": "Full modular monolith with DDD: module boundaries and integration events",
          "url": "https://github.com/kgrzybek/modular-monolith-with-ddd",
          "kind": "repo"
        },
        {
          "title": "The Cargo Book: workspace members and path dependencies",
          "url": "https://doc.rust-lang.org/cargo/reference/workspaces.html",
          "kind": "docs"
        },
        {
          "title": "docs.rs: sqlx transactions and the Executor trait",
          "url": "https://docs.rs/sqlx/latest/sqlx/",
          "kind": "docs"
        },
        {
          "title": "docs.rs: tokio sync, broadcast channel semantics",
          "url": "https://docs.rs/tokio/latest/tokio/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "q05",
      "title": "Microservice boundaries: the extraction test",
      "minutes": 90,
      "level": "advanced",
      "goal": "Decide whether to extract a service with four measurable criteria, recognise the distributed monolith signature, and extract only across a seam that already exists.",
      "sections": [
        {
          "h": "The distributed monolith has a signature",
          "p": [
            "A system that was split but never decoupled has a recognizable signature: one user action triggers five synchronous calls, two services write the same table, and a field change needs a coordinated release. The network did not create independence; it added latency, partial failure, and a deploy order. If a typical change still touches three services, the split bought nothing and cost plenty.",
            "The opposite failure is refusing to split anything, which caps scaling and puts unrelated failure domains in one blast radius. Extraction is justified when it buys one of four things: independent scaling, an isolated failure domain, a compliance boundary, or a deploy cadence that no longer fits one queue. Write the justification down, because the cost is permanent and the benefit should have a number."
          ],
          "list": [
            "Symptom: every feature branch touches the same three services in lock step",
            "Symptom: a shared database with cross-service joins or foreign keys",
            "Symptom: synchronous call chains deeper than two hops on a user path",
            "Symptom: a deploy order documented in a runbook because services must ship together"
          ],
          "tip": "Count the services a typical pull request touches. If the median is above two, you have a distributed monolith, and merging is cheaper than another extraction."
        },
        {
          "h": "Four numbers, one decision",
          "p": [
            "Measure change coupling from history, scaling ratio from production metrics, failure isolation as a yes/no requirement, and transaction span as the set of invariants that must hold immediately. Three of the four pointing the same way is a decision; any single metric alone is an opinion dressed as analysis.",
            "Change coupling is the cheapest to compute: for each commit, list the touched paths, count pairs, and divide by the number of commits. A pair that co-changes in more than roughly a third of commits is one module pretending to be two, and a network boundary will convert every one of those commits into a release train."
          ],
          "code": "#[derive(Debug, Clone, Copy)]\npub struct ExtractionScore {\n    /// Share of commits in the last 180 days touching both modules (0.0 - 1.0).\n    pub co_change: f64,\n    /// Peak resource multiple between the modules, e.g. 12.0 for 12x CPU.\n    pub scaling_ratio: f64,\n    /// Does the business require this capability to fail independently?\n    pub needs_failure_isolation: bool,\n    /// Does one invariant need both modules inside a single commit?\n    pub shares_transaction: bool,\n}\n\nimpl ExtractionScore {\n    pub fn verdict(&self) -> &'static str {\n        let mut extract = 0;\n        let mut keep = 0;\n\n        if self.co_change < 0.30 { extract += 1 } else { keep += 1 }\n        if self.scaling_ratio >= 5.0 { extract += 1 } else { keep += 1 }\n        if self.needs_failure_isolation { extract += 1 } else { keep += 1 }\n        if self.shares_transaction { keep += 2 } else { extract += 1 }\n\n        if extract >= 3 && keep <= 1 { \"extract\" } else { \"keep in the monolith\" }\n    }\n}\n\n#[test]\nfn checkout_and_stock_stay_together() {\n    let score = ExtractionScore {\n        co_change: 0.62,\n        scaling_ratio: 1.4,\n        needs_failure_isolation: false,\n        shares_transaction: true,\n    };\n    assert_eq!(score.verdict(), \"keep in the monolith\");\n}",
          "tip": "Weight the transaction test heaviest: an invariant that needs both modules means every extraction buys a saga and an eventual-consistency incident surface."
        },
        {
          "h": "Extract only across a seam that already exists",
          "p": [
            "The precondition for extraction is a facade with a versioned contract: the module owns its tables, callers use commands and queries that return DTOs, and no one reads its rows directly. Then extraction replaces a function call with a client and the contract tests keep passing. Without that seam you are not extracting a service, you are splitting a database and hoping.",
            "Run the new path behind a flag with shadow reads: call the extracted service and compare its result with the in-process path for a week, logging differences. If you cannot run both paths side by side, you do not have a seam yet, and the first production incident will be the comparison."
          ],
          "code": "use async_trait::async_trait;\n\n/// Existing in-process facade, already used by the monolith.\n#[async_trait]\npub trait StockService: Send + Sync {\n    async fn available(&self, sku: &str) -> Result<u32, StockError>;\n}\n\n/// Phase 1: call both, serve the monolith answer, log divergence.\npub struct ShadowStock {\n    pub primary: std::sync::Arc<dyn StockService>,\n    pub shadow: std::sync::Arc<dyn StockService>,\n}\n\n#[async_trait]\nimpl StockService for ShadowStock {\n    async fn available(&self, sku: &str) -> Result<u32, StockError> {\n        let served = self.primary.available(sku).await;\n        if let Ok(shadowed) = self.shadow.available(sku).await {\n            match &served {\n                Ok(value) if *value != shadowed => {\n                    tracing::warn!(sku, monolith = value, service = shadowed, \"stock divergence\");\n                }\n                _ => {}\n            }\n        }\n        served\n    }\n}",
          "tip": "Shadow traffic must never write. Read-only shadowing catches mapping bugs without risking double reservations."
        }
      ],
      "exercise": {
        "prompt": "Score three candidate boundaries in an order platform: notifications, search indexing, and payments. Fill the four criteria for each, run the verdict, and justify the one you would extract first.",
        "starter": "let notifications = ExtractionScore { co_change: 0.04, scaling_ratio: 6.0, needs_failure_isolation: false, shares_transaction: false };\nlet search = ExtractionScore { co_change: 0.08, scaling_ratio: 9.0, needs_failure_isolation: false, shares_transaction: false };\nlet payments = ExtractionScore { co_change: 0.35, scaling_ratio: 1.2, needs_failure_isolation: true, shares_transaction: true };\n\n// TODO: run verdict() for each, then argue which one ships first.",
        "hint": "Notifications and search both extract cleanly; payments carries a compliance boundary but also a transaction. Start with the boundary that has the lowest cost and an existing seam, then use that muscle for the risky one.",
        "solution": "// Notifications: low coupling, no shared transaction, 6x fan-out -> extract. Small,\n// reversible, and it rehearses the extraction mechanics on a low-risk path.\n// Search: low coupling + 9x scaling -> the strongest economic case, shipped second.\n// Payments: needs isolation (compliance) but shares a transaction; extract only after\n// the ledger is its own aggregate, otherwise you get a saga on the money path.\n\nfn rank(candidates: &[(&str, ExtractionScore)]) -> Vec<(&str, &'static str)> {\n    let mut scored: Vec<_> = candidates\n        .iter()\n        .map(|(name, score)| (*name, score.verdict()))\n        .collect();\n    scored.sort_by_key(|(_, verdict)| *verdict != \"extract\");\n    scored\n}\n\n#[test]\nfn notifications_ships_first_then_search() {\n    let candidates = [\n        (\"notifications\", ExtractionScore { co_change: 0.04, scaling_ratio: 6.0, needs_failure_isolation: false, shares_transaction: false }),\n        (\"search\", ExtractionScore { co_change: 0.08, scaling_ratio: 9.0, needs_failure_isolation: false, shares_transaction: false }),\n        (\"payments\", ExtractionScore { co_change: 0.35, scaling_ratio: 1.2, needs_failure_isolation: true, shares_transaction: true }),\n    ];\n    let ranked = rank(&candidates);\n    assert_eq!(ranked[0].0, \"notifications\");\n    assert_eq!(ranked[1].0, \"search\");\n    assert!(ranked.iter().any(|(name, verdict)| *name == \"payments\" && *verdict != \"extract\"));\n}"
      },
      "production": [
        "Every extracted service has a written justification naming scaling, failure isolation, compliance, or deploy cadence, plus the accepted cost.",
        "No two services share a writable table; shared reads go through an API or a projection owned by one service.",
        "A contract test suite runs against the extracted service before traffic moves, and the in-process path stays deployable for one release.",
        "The median pull request touches at most two services; a higher number triggers a boundary review.",
        "Each service has its own SLO, on-call owner, and runbook; if it cannot be paged separately, it is not a service yet."
      ],
      "crates": [
        "async-trait",
        "axum",
        "tower",
        "serde"
      ],
      "github": [
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        },
        {
          "name": "dtolnay/async-trait",
          "url": "https://github.com/dtolnay/async-trait"
        }
      ],
      "pitfall": "Extracting a module whose callers still read its tables: the service owns a schema it cannot change, and every migration becomes a cross-team negotiation with a deploy freeze.",
      "questions": [
        {
          "q": "A pair of modules co-changes in 62 percent of commits and shares an invariant that must hold immediately. What does the extraction test say?",
          "options": [
            "Extract now, then fix the coupling with events",
            "Keep them together until the invariant and the change pattern are separated",
            "Extract only the read path and leave writes in the monolith",
            "Extract and add a distributed transaction coordinator"
          ],
          "answer": 1,
          "explain": "High co-change means one conceptual module, and a shared immediate invariant means every split buys a saga. Extraction would add coordination cost without buying independence."
        },
        {
          "q": "What is the safest first step when moving a capability to its own service?",
          "options": [
            "Move the database first so the service owns its schema immediately",
            "Shadow the new path read-only and compare results while the old path still serves",
            "Switch 10 percent of write traffic and watch the error rate",
            "Delete the in-process implementation so nobody can call it"
          ],
          "answer": 1,
          "explain": "Read-only shadowing exposes mapping and contract bugs without risking double writes. Write cutovers come after the new path agrees with the old one."
        },
        {
          "q": "Which shared resource most reliably re-couples services after extraction?",
          "options": [
            "A shared protobuf contract crate",
            "A shared writable database schema",
            "A shared tracing collector",
            "A shared CI pipeline"
          ],
          "answer": 1,
          "explain": "A shared writable schema means neither service can migrate alone. Contracts, telemetry, and CI are shared infrastructure, not shared state."
        }
      ],
      "quickbytes": [
        "Measure co-change: git log --name-only --since=\"180 days ago\" then count path pairs; over 30 percent is one module.",
        "Extract the capability that scales differently, not the one that is easiest to draw on a slide.",
        "Keep the old path deployable for one release; rollback beats a hotfix under pressure."
      ],
      "resources": [
        {
          "title": "Microservices: yesterday, today, and tomorrow (arXiv:1606.04036)",
          "url": "https://arxiv.org/abs/1606.04036",
          "kind": "paper"
        },
        {
          "title": "tokio-rs/axum: building the HTTP surface of an extracted service",
          "url": "https://github.com/tokio-rs/axum",
          "kind": "repo"
        },
        {
          "title": "docs.rs: async-trait for swappable service ports",
          "url": "https://docs.rs/async-trait/latest/async_trait/",
          "kind": "docs"
        },
        {
          "title": "InfoQ: architecture and microservices conference talks",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        }
      ]
    },
    {
      "id": "q06",
      "title": "CQRS: separate write and read models",
      "minutes": 85,
      "level": "advanced",
      "goal": "Split a write model that protects invariants from a read model shaped for screens, and keep the projection idempotent and rebuildable.",
      "sections": [
        {
          "h": "One model cannot serve both",
          "p": [
            "The write model exists to protect invariants: narrow rows, short transactions, and locks held for milliseconds. The read model exists to answer a screen: wide rows, pre-joined, sorted the way the page needs. Forcing one schema to do both gives you read queries that fight write locks and write transactions that maintain indexes nobody queries.",
            "CQRS splits the two and connects them with events or with a projection written in the same transaction. It is a per-context decision, not a top-level architecture. Apply it to the two or three aggregates where reads and writes genuinely diverge, and leave ordinary CRUD tables alone; a split you cannot justify with a query plan is just extra tables."
          ],
          "list": [
            "Write side: one aggregate, one transaction, no joins, no reporting columns",
            "Read side: one table per screen or endpoint, denormalized on purpose",
            "The connection is an event or a projection, never a shared mutable row",
            "Reads never write; if a read needs to record something, it is a command"
          ],
          "tip": "If the read model is a SELECT of the write tables with one join, keep it. CQRS pays off when the projection needs reshaping, not when it needs a WHERE clause."
        },
        {
          "h": "Synchronous projections versus relayed ones",
          "p": [
            "A synchronous projection updates the read table inside the write transaction. Reads are immediately consistent, the code is one function, and the cost is that the write path now maintains a second schema and holds locks a little longer. For low-volume aggregates this is the right default, because it removes an entire class of stale-read bugs.",
            "A relayed projection commits the event and updates the read model later. Writes get faster and the read side scales independently, but reads lag and you now own a watermark, a retry policy, and a rebuild. Choose it when the write rate or the projection cost makes the in-transaction version unacceptable, and say so in the ADR."
          ],
          "code": "use sqlx::{PgPool, Postgres, Transaction};\n\npub enum OrderEvent {\n    Placed { order_id: uuid::Uuid, total_minor: i64, version: i32 },\n    Cancelled { order_id: uuid::Uuid, version: i32 },\n}\n\n/// Synchronous projection: same transaction as the write, so the guard is free.\npub async fn project(tx: &mut Transaction<'_, Postgres>, event: &OrderEvent) -> sqlx::Result<()> {\n    match event {\n        OrderEvent::Placed { order_id, total_minor, version } => {\n            sqlx::query(\n                \"INSERT INTO order_summary (order_id, total_minor, status, last_version)\n                 VALUES ($1, $2, 'placed', $3)\n                 ON CONFLICT (order_id) DO UPDATE\n                 SET total_minor = EXCLUDED.total_minor,\n                     status = EXCLUDED.status,\n                     last_version = EXCLUDED.last_version\n                 WHERE order_summary.last_version < EXCLUDED.last_version\",\n            )\n            .bind(order_id)\n            .bind(total_minor)\n            .bind(version)\n            .execute(&mut **tx)\n            .await?;\n        }\n        OrderEvent::Cancelled { order_id, version } => {\n            sqlx::query(\n                \"UPDATE order_summary SET status = 'cancelled', last_version = $2\n                 WHERE order_id = $1 AND last_version < $2\",\n            )\n            .bind(order_id)\n            .bind(version)\n            .execute(&mut **tx)\n            .await?;\n        }\n    }\n    Ok(())\n}",
          "tip": "The last_version guard makes redelivery and out-of-order delivery harmless. Without it, a late Cancelled can overwrite a later Placed."
        },
        {
          "h": "Rebuild is a feature, and lag is an SLI",
          "p": [
            "A projection must be disposable. Keep a rebuild command that truncates the read table and replays from the event log or from the write model, and run it in staging on every schema change. If a rebuild takes six hours, you have found a capacity problem before it finds you, and you know the read model is too expensive to own.",
            "Monitor lag as a first-class metric: the age difference between the newest committed write and the projection watermark. Alert on age, not on row count, because a backlog of a thousand events is fine if it is two seconds old and alarming if it is twenty minutes old. Expose the watermark in the health endpoint so an operator can see it without a database console."
          ],
          "code": "/// Rebuild is intentionally boring: truncate, replay in batches, publish watermark.\npub async fn rebuild_order_summary(pool: &PgPool) -> anyhow::Result<()> {\n    let mut tx = pool.begin().await?;\n    sqlx::query(\"TRUNCATE order_summary\").execute(&mut *tx).await?;\n    tx.commit().await?;\n\n    let mut last_seen: i64 = 0;\n    loop {\n        let rows = sqlx::query_as::<_, (i64, uuid::Uuid, i64, String)>(\n            \"SELECT seq, order_id, total_minor, status FROM order_events\n             WHERE seq > $1 ORDER BY seq LIMIT 500\",\n        )\n        .bind(last_seen)\n        .fetch_all(pool)\n        .await?;\n        if rows.is_empty() {\n            break;\n        }\n        for (seq, order_id, total_minor, status) in &rows {\n            sqlx::query(\n                \"INSERT INTO order_summary (order_id, total_minor, status, last_version)\n                 VALUES ($1, $2, $3, $4)\n                 ON CONFLICT (order_id) DO UPDATE\n                 SET total_minor = EXCLUDED.total_minor, status = EXCLUDED.status,\n                     last_version = EXCLUDED.last_version\",\n            )\n            .bind(order_id)\n            .bind(total_minor)\n            .bind(status)\n            .bind(seq)\n            .execute(pool)\n            .await?;\n            last_seen = *seq;\n        }\n    }\n    tracing::info!(last_seen, \"order_summary rebuilt\");\n    Ok(())\n}",
          "tip": "Give projections a monotonic sequence from the log, not a wall-clock timestamp; two events in the same millisecond will otherwise apply in arbitrary order."
        }
      ],
      "exercise": {
        "prompt": "Add a read model for a dashboard that needs order count, gross total, and last order time per customer. Decide synchronous or relayed, then write the projection and the query that serves it.",
        "starter": "CREATE TABLE customer_dashboard (\n    customer_id uuid PRIMARY KEY,\n    order_count  bigint NOT NULL DEFAULT 0,\n    gross_minor  bigint NOT NULL DEFAULT 0,\n    last_order_at timestamptz\n);\n\n// TODO: projection update on OrderPlaced, and the read query.",
        "hint": "This projection is cheap and serves a high-traffic screen, so a synchronous update in the same transaction works. Use an upsert with an increment rather than a recomputation, and keep the version guard.",
        "solution": "pub async fn project_order_placed(\n    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,\n    customer_id: uuid::Uuid,\n    total_minor: i64,\n    placed_at: chrono::DateTime<chrono::Utc>,\n) -> sqlx::Result<()> {\n    sqlx::query(\n        \"INSERT INTO customer_dashboard (customer_id, order_count, gross_minor, last_order_at)\n         VALUES ($1, 1, $2, $3)\n         ON CONFLICT (customer_id) DO UPDATE\n         SET order_count = customer_dashboard.order_count + 1,\n             gross_minor = customer_dashboard.gross_minor + EXCLUDED.gross_minor,\n             last_order_at = GREATEST(customer_dashboard.last_order_at, EXCLUDED.last_order_at)\",\n    )\n    .bind(customer_id)\n    .bind(total_minor)\n    .bind(placed_at)\n    .execute(&mut **tx)\n    .await?;\n    Ok(())\n}\n\n#[derive(sqlx::FromRow, serde::Serialize)]\npub struct DashboardRow {\n    pub customer_id: uuid::Uuid,\n    pub order_count: i64,\n    pub gross_minor: i64,\n    pub last_order_at: Option<chrono::DateTime<chrono::Utc>>,\n}\n\npub async fn dashboard(\n    pool: &sqlx::PgPool,\n    customer_id: uuid::Uuid,\n) -> sqlx::Result<Option<DashboardRow>> {\n    sqlx::query_as::<_, DashboardRow>(\n        \"SELECT customer_id, order_count, gross_minor, last_order_at\n         FROM customer_dashboard WHERE customer_id = $1\",\n    )\n    .bind(customer_id)\n    .fetch_optional(pool)\n    .await\n}"
      },
      "production": [
        "Every projection carries a watermark or version column, and every update is guarded so replay is idempotent.",
        "A rebuild command exists, runs in CI against a production-sized snapshot, and its duration is tracked.",
        "Projection lag age is exported as a metric and alerted on, not derived from a row count.",
        "Read endpoints have their own indexes and are never served by joining write tables in production.",
        "The command path and the query path have separate tests; a query test asserts shape and ordering, not business rules."
      ],
      "crates": [
        "sqlx",
        "serde",
        "uuid",
        "axum"
      ],
      "github": [
        {
          "name": "serverlesstechnology/cqrs (cqrs-es)",
          "url": "https://github.com/serverlesstechnology/cqrs"
        },
        {
          "name": "launchbadge/sqlx",
          "url": "https://github.com/transact-rs/sqlx"
        }
      ],
      "pitfall": "A projection that recomputes aggregates with COUNT and SUM on every event: it works at a thousand rows, then the write path spends its budget scanning the read table inside a transaction.",
      "questions": [
        {
          "q": "What does the last_version guard on a projection buy you?",
          "options": [
            "It prevents the write model from committing twice",
            "It makes redelivery and out-of-order application harmless",
            "It guarantees the read model is instantly consistent",
            "It removes the need for a rebuild command"
          ],
          "answer": 1,
          "explain": "The guard rejects events older than what the projection already applied. Redelivery becomes a no-op and late messages cannot rewind state."
        },
        {
          "q": "When is a relayed (asynchronous) projection the better choice than a synchronous one?",
          "options": [
            "When the read model must be exactly consistent with the write at all times",
            "When the projection cost or write rate makes in-transaction maintenance too expensive",
            "When there is only one consumer of the read model",
            "When the team has no message broker experience"
          ],
          "answer": 1,
          "explain": "Relayed projections trade consistency for write throughput and independent scaling. Exactly-consistent reads point the other way, toward the same transaction."
        },
        {
          "q": "Which signal should page an operator for a lagging projection?",
          "options": [
            "The number of pending events exceeds one thousand",
            "The age of the oldest unapplied event exceeds the freshness SLO",
            "The projection table has grown past one million rows",
            "The relay process restarted at least once today"
          ],
          "answer": 1,
          "explain": "Counts mean nothing without a rate. Age directly expresses user-visible staleness, which is what the SLO is written in."
        }
      ],
      "quickbytes": [
        "Use a monotonic sequence from the log as the projection version; wall-clock timestamps tie under load.",
        "A projection that cannot be rebuilt is a second source of truth, and now you have two.",
        "Keep reads off the write tables in production; if the query needs a join, project it instead."
      ],
      "resources": [
        {
          "title": "cqrs-es: aggregates, events and views in Rust",
          "url": "https://docs.rs/cqrs-es/latest/cqrs_es/",
          "kind": "docs"
        },
        {
          "title": "serverlesstechnology/cqrs: framework source and demo app",
          "url": "https://github.com/serverlesstechnology/cqrs",
          "kind": "repo"
        },
        {
          "title": "PostgreSQL: INSERT ... ON CONFLICT upsert semantics",
          "url": "https://www.postgresql.org/docs/current/sql-insert.html",
          "kind": "docs"
        },
        {
          "title": "docs.rs: sqlx query_as, FromRow and transactions",
          "url": "https://docs.rs/sqlx/latest/sqlx/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "q07",
      "title": "Event sourcing: the log is the source of truth",
      "minutes": 100,
      "level": "advanced",
      "goal": "Store state as an append-only stream guarded by expected versions, fold it back into an aggregate, and handle snapshots, upcasting and erasure without rewriting history.",
      "sections": [
        {
          "h": "State is a fold over events",
          "p": [
            "Instead of storing a current row and overwriting it, event sourcing appends every state change as an immutable event and derives the current state by folding the stream in order. The write model becomes append-only, history is queryable as data, and debugging means reading the events that produced a state instead of guessing from a snapshot and a log line.",
            "The cost is real: every event schema lives forever, there is no ad-hoc UPDATE to fix a mistake, and the fold has to be replayed whenever its logic changes. Adopt it for aggregates where history is the business value, such as a ledger, a subscription lifecycle, or an order state machine, and leave lookup tables as ordinary rows."
          ],
          "list": [
            "Append only: no UPDATE, no DELETE, one row per state transition",
            "The event carries the intent (OrderPlaced) not the diff (status := placed)",
            "Current state is derived; the log is what you back up and replicate",
            "A mistake is corrected by a compensating event, not by editing history"
          ],
          "tip": "If nobody will ever ask what happened and when, you do not need event sourcing; you need an updated_at column."
        },
        {
          "h": "Optimistic concurrency on the stream",
          "p": [
            "Appends are guarded by an expected version. A unique key on (aggregate_id, version) makes Postgres the arbiter: the second writer with the same expected version collides, the use case reloads and re-decides, and no lock was ever taken. The check costs one index lookup and removes the lost-update class of bugs entirely.",
            "Detect the collision with ON CONFLICT DO NOTHING and rows_affected, not by parsing an error string. Then the same code path works for a single insert and a batch: if any row in the batch was rejected, roll the whole transaction back and report a conflict so the caller retries from a fresh load."
          ],
          "code": "use sqlx::{PgPool, Postgres, Transaction};\nuse uuid::Uuid;\n\n#[derive(Debug, thiserror::Error)]\npub enum AppendError {\n    #[error(\"order {0} was modified concurrently; reload and retry\")]\n    Conflict(Uuid),\n    #[error(\"storage: {0}\")]\n    Storage(String),\n}\n\npub async fn append(\n    pool: &PgPool,\n    order_id: Uuid,\n    expected_version: u32,\n    events: &[OrderEvent],\n) -> Result<(), AppendError> {\n    let mut tx: Transaction<'_, Postgres> = pool\n        .begin()\n        .await\n        .map_err(|e| AppendError::Storage(e.to_string()))?;\n\n    for (offset, event) in events.iter().enumerate() {\n        let version = expected_version as i64 + offset as i64 + 1;\n        let inserted = sqlx::query(\n            \"INSERT INTO order_events (order_id, version, kind, payload)\n             VALUES ($1, $2, $3, $4)\n             ON CONFLICT (order_id, version) DO NOTHING\",\n        )\n        .bind(order_id)\n        .bind(version)\n        .bind(event.kind())\n        .bind(serde_json::to_value(event).map_err(|e| AppendError::Storage(e.to_string()))?)\n        .execute(&mut *tx)\n        .await\n        .map_err(|e| AppendError::Storage(e.to_string()))?\n        .rows_affected();\n\n        if inserted == 0 {\n            tx.rollback().await.ok();\n            return Err(AppendError::Conflict(order_id));\n        }\n    }\n\n    tx.commit().await.map_err(|e| AppendError::Storage(e.to_string()))\n}",
          "tip": "Bind the version as the expected value plus the event offset, not as a value read earlier in the function; a batch must be contiguous."
        },
        {
          "h": "Snapshots, upcasting and erasure",
          "p": [
            "A snapshot is a cache, never a source of truth: store (aggregate_id, version, state_bytes) and load the tail after it. Snapshots keep load time bounded for long streams, but deleting the event log because a snapshot exists converts a reproducible history into an unrecoverable one.",
            "Two maintenance mechanisms carry the weight. Upcasting: each stored payload keeps a schema version, and a chain of pure functions migrates v1 to v3 at read time. Crypto-shredding: encrypt personal fields per subject so destroying the key satisfies an erasure request while the append-only log stays intact. A DELETE on the log is a lie that returns at the next replay."
          ],
          "code": "pub struct Snapshot {\n    pub version: u32,\n    pub state: OrderState,\n}\n\npub async fn load(\n    pool: &PgPool,\n    order_id: Uuid,\n) -> Result<Order, LoadError> {\n    let snapshot: Option<(i32, serde_json::Value)> = sqlx::query_as(\n        \"SELECT version, state FROM order_snapshots WHERE order_id = $1\",\n    )\n    .bind(order_id)\n    .fetch_optional(pool)\n    .await?;\n\n    let (mut version, mut state) = match snapshot {\n        Some((v, json)) => (v as u32, serde_json::from_value(json)?),\n        None => (0, OrderState::default()),\n    };\n\n    let rows: Vec<(i32, i32, String, serde_json::Value)> = sqlx::query_as(\n        \"SELECT version, schema_version, kind, payload FROM order_events\n         WHERE order_id = $1 AND version > $2 ORDER BY version\",\n    )\n    .bind(order_id)\n    .bind(version as i32)\n    .fetch_all(pool)\n    .await?;\n\n    for (v, schema_version, kind, payload) in rows {\n        let event = upcast(kind.as_str(), schema_version, payload)?;\n        state.apply(&event);\n        version = v as u32;\n    }\n\n    Ok(Order { id: order_id, state, version })\n}\n\n/// Old payloads are migrated at read time; the log is never rewritten.\nfn upcast(kind: &str, schema_version: i32, payload: serde_json::Value) -> Result<OrderEvent, LoadError> {\n    let mut value = payload;\n    if kind == \"OrderPlaced\" && schema_version == 1 {\n        // v1 had no currency field; the business only sold in EUR then.\n        value[\"currency\"] = serde_json::json!(\"EUR\");\n    }\n    serde_json::from_value::<OrderEvent>(value).map_err(LoadError::from)\n}",
          "tip": "Write the upcaster on the day the schema changes, not five years later; the field meanings you need are only obvious while the change is fresh."
        }
      ],
      "exercise": {
        "prompt": "Implement a fold for an order stream with three events: Placed, LineAdded, Cancelled. Add the append path with an expected version and a test that two concurrent appends at version 3 produce exactly one conflict.",
        "starter": "pub enum OrderEvent {\n    Placed { total_minor: i64 },\n    LineAdded { sku: String, qty: u32 },\n    Cancelled { reason: String },\n}\n\n// TODO: impl OrderEvent { fn apply(&self, state: &mut OrderState) }\n// TODO: append with expected_version, unique (order_id, version)",
        "hint": "Fold in stream order and reject transitions that are illegal for the current state (adding a line after Cancelled). The concurrency test needs two connections and the same expected version, not two sequential calls.",
        "solution": "#[derive(Default, Debug, PartialEq)]\npub struct OrderState {\n    pub total_minor: i64,\n    pub lines: Vec<(String, u32)>,\n    pub cancelled: bool,\n}\n\nimpl OrderEvent {\n    pub fn apply(&self, state: &mut OrderState) -> Result<(), &'static str> {\n        match self {\n            OrderEvent::Placed { total_minor } => {\n                if state.total_minor != 0 || !state.lines.is_empty() {\n                    return Err(\"order already placed\");\n                }\n                state.total_minor = *total_minor;\n            }\n            OrderEvent::LineAdded { sku, qty } => {\n                if state.cancelled {\n                    return Err(\"cannot add a line to a cancelled order\");\n                }\n                state.lines.push((sku.clone(), *qty));\n            }\n            OrderEvent::Cancelled { .. } => {\n                if state.cancelled {\n                    return Err(\"already cancelled\");\n                }\n                state.cancelled = true;\n            }\n        }\n        Ok(())\n    }\n}\n\npub fn fold(events: &[OrderEvent]) -> Result<OrderState, &'static str> {\n    let mut state = OrderState::default();\n    for event in events {\n        event.apply(&mut state)?;\n    }\n    Ok(state)\n}\n\n#[sqlx::test]\nasync fn concurrent_append_conflicts(pool: sqlx::PgPool) -> sqlx::Result<()> {\n    let id = uuid::Uuid::now_v7();\n    let events = [OrderEvent::Placed { total_minor: 100 }];\n    append(&pool, id, 0, &events).await.unwrap();\n\n    let (first, second) = tokio::join!(\n        append(&pool, id, 1, &[OrderEvent::LineAdded { sku: \"A\".into(), qty: 1 }]),\n        append(&pool, id, 1, &[OrderEvent::LineAdded { sku: \"B\".into(), qty: 1 }]),\n    );\n\n    let conflicts = [first, second].iter().filter(|r| matches!(r, Err(AppendError::Conflict(_)))).count();\n    assert_eq!(conflicts, 1, \"exactly one writer must win version 2\");\n    Ok(())\n}"
      },
      "production": [
        "Every aggregate stream has a unique (aggregate_id, version) constraint; the append path never issues an UPDATE.",
        "Event payloads carry a schema version and every historical version has an upcaster with a test against a stored fixture.",
        "Snapshots are written on a version threshold and can be deleted without data loss; a rebuild test proves it.",
        "Personal data is encrypted per subject so erasure revokes a key rather than mutating the log.",
        "Stream length and load time are measured per aggregate; a stream that needs a snapshot is flagged before it needs an outage."
      ],
      "crates": [
        "sqlx",
        "serde",
        "serde_json",
        "uuid"
      ],
      "github": [
        {
          "name": "serverlesstechnology/cqrs (event sourcing model)",
          "url": "https://github.com/serverlesstechnology/cqrs"
        },
        {
          "name": "message-db/message-db",
          "url": "https://github.com/message-db/message-db"
        }
      ],
      "pitfall": "Storing the diff instead of the intent: an event that says status := cancelled cannot be replayed after the enum gains a state, and the history becomes unreadable exactly when you need it.",
      "questions": [
        {
          "q": "How does an event-sourced append detect a concurrent writer without taking a lock?",
          "options": [
            "It reads the row with SELECT FOR UPDATE first",
            "It inserts with a unique (aggregate_id, version) key and reports a conflict when zero rows are inserted",
            "It compares wall-clock timestamps on the events",
            "It relies on the application to serialize writes"
          ],
          "answer": 1,
          "explain": "The unique index is the arbiter. Two writers with the same expected version cannot both insert; the loser gets rows_affected == 0 and retries from a fresh load."
        },
        {
          "q": "What is the correct role of a snapshot in an event-sourced system?",
          "options": [
            "It replaces the log once it is written",
            "It caps load time and can be deleted and rebuilt from the log",
            "It stores the diff so replays are faster",
            "It is the only copy that must be backed up"
          ],
          "answer": 1,
          "explain": "A snapshot is a materialized fold at a version. The log remains authoritative, so losing snapshots costs time, not data."
        },
        {
          "q": "An old event payload lacks a field that the current enum requires. What is the standard remedy?",
          "options": [
            "Rewrite the stored rows in a migration",
            "Upcast the payload at read time based on its stored schema version",
            "Ignore the old events and start a new stream",
            "Make the field optional forever in the domain type"
          ],
          "answer": 1,
          "explain": "Rewriting history is both risky and lossy. Upcasting keeps the log immutable and concentrates the migration logic in one tested function."
        }
      ],
      "quickbytes": [
        "One event per state transition, named in the past tense; resist the urge to batch unrelated changes into one event.",
        "Version guard plus unique index beats SELECT FOR UPDATE: no locks, same guarantee.",
        "Snapshot at a version threshold and keep the upcaster next to the event it migrates."
      ],
      "resources": [
        {
          "title": "message-db: a Postgres event store schema and message contract",
          "url": "https://github.com/message-db/message-db",
          "kind": "repo"
        },
        {
          "title": "cqrs-es: aggregate, event and view traits in Rust",
          "url": "https://docs.rs/cqrs-es/latest/cqrs_es/",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: INSERT ... ON CONFLICT for conflict detection",
          "url": "https://www.postgresql.org/docs/current/sql-insert.html",
          "kind": "docs"
        },
        {
          "title": "docs.rs: serde_json for versioned event payloads",
          "url": "https://docs.rs/serde_json/latest/serde_json/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "q08",
      "title": "API gateway: edge policy, not edge logic",
      "minutes": 75,
      "level": "core",
      "goal": "Put authentication, limits, deadlines and request ids in one edge layer ordered correctly, and keep business rules out of it.",
      "sections": [
        {
          "h": "What belongs at the edge",
          "p": [
            "The gateway terminates client connections, authenticates, applies per-tenant rate and body limits, sets deadlines, assigns request ids, normalises headers, and routes to the right service. These are policy decisions that must be uniform. Anything that decides whether an order is valid, or what a price is, belongs in the service that owns that invariant.",
            "A gateway also concentrates failure. If it holds a fixed upstream connection pool and no deadline, one slow service consumes every connection and the gateway becomes the outage. Give it its own SLO, its own saturation metric, and enough headroom that it is never the first component to fall over."
          ],
          "list": [
            "Belongs at the edge: authentication, authorisation coarse checks, quotas, body limits, deadlines, request ids, CORS",
            "Belongs in a service: validation of business fields, pricing, inventory decisions, state machines",
            "Belongs in neither: a second copy of the domain model that drifts from the real one",
            "Always at the edge: a response header carrying the request id the logs use"
          ],
          "tip": "If a rule at the gateway has a unit test with business vocabulary in it, move the rule inward; the gateway only knows about requests."
        },
        {
          "h": "Layer order is the actual contract",
          "p": [
            "In tower, the outermost layer sees the request first and the response last. Put request-id and trace outermost so every inner layer and handler logs the same id, put the timeout outside authentication so a hanging identity provider is bounded, and put the body limit before handlers so a large upload is rejected before it is parsed.",
            "axum has two similar methods with different reach. Router::layer applies to every request that reaches the router; route_layer applies only where a route matched, which the documentation frames as deliberate: an authorisation layer should not turn a 404 into a 401. At a gateway that is a policy decision. If the fallback reveals routes, build metadata, or proxied content, authenticate it with layer; a static 404 does not need auth. Either way, add the layer after the routes exist."
          ],
          "code": "use axum::{Router, routing::get};\nuse tower::ServiceBuilder;\nuse tower_http::{\n    limit::RequestBodyLimitLayer,\n    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},\n    timeout::TimeoutLayer,\n    trace::TraceLayer,\n};\nuse std::time::Duration;\n\npub fn app(state: AppState) -> Router {\n    let policy = ServiceBuilder::new()\n        // Outermost first: id, then trace, then timeout, then body limit.\n        .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))\n        .layer(PropagateRequestIdLayer::x_request_id())\n        .layer(TraceLayer::new_for_http())\n        .layer(TimeoutLayer::new(Duration::from_secs(10)))\n        .layer(RequestBodyLimitLayer::new(256 * 1024));\n\n    Router::new()\n        .route(\"/v1/orders\", get(list_orders).post(place_order))\n        .route(\"/v1/orders/{id}\", get(get_order))\n        .layer(policy)\n        .layer(axum::middleware::from_fn_with_state(state.clone(), auth))\n        .with_state(state)\n}",
          "tip": "A timeout inside the auth layer does not bound the handler, and a timeout inside the handler does not bound the body read. Place each deadline outside the work it must bound."
        },
        {
          "h": "Header hygiene at the trust boundary",
          "p": [
            "Clients can send X-Forwarded-For, X-Request-Id, and anything else. The edge must overwrite those headers rather than append to them, and it may only trust a forwarding header that came from the load balancer, verified by source address or by a shared secret that is stripped before the request leaves the edge. An identity header accepted from a client is an authentication bypass with extra steps.",
            "Overwrite, then propagate: the generated id goes into the response and into every upstream call, and the tenant id comes from the validated token, never from a header or a query parameter. When a support ticket quotes the id, you should be able to find the full request path in one search."
          ],
          "code": "use axum::{\n    extract::{Request, State},\n    http::{header, HeaderValue, StatusCode},\n    middleware::Next,\n    response::Response,\n};\n\n/// Runs at the edge. Overwrites client-supplied routing headers instead of trusting them.\npub async fn auth(State(state): State<AppState>, mut req: Request, next: Next) -> Result<Response, StatusCode> {\n    let token = req\n        .headers()\n        .get(header::AUTHORIZATION)\n        .and_then(|value| value.to_str().ok())\n        .and_then(|value| value.strip_prefix(\"Bearer \"))\n        .ok_or(StatusCode::UNAUTHORIZED)?;\n\n    let claims = state.tokens.verify(token).await.map_err(|_| StatusCode::UNAUTHORIZED)?;\n\n    // Never read tenant from a header; it comes from the verified token.\n    req.extensions_mut().insert(TenantId(claims.tenant_id));\n    req.headers_mut().insert(\n        \"x-tenant-id\",\n        HeaderValue::from_str(&claims.tenant_id.to_string()).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,\n    );\n    // Drop client-supplied identity hints entirely.\n    req.headers_mut().remove(\"x-user-id\");\n\n    Ok(next.run(req).await)\n}",
          "tip": "Treat every inbound header not in an explicit allowlist as hostile; strip it at the edge so services never have to ask where it came from."
        }
      ],
      "exercise": {
        "prompt": "A gateway currently authenticates only on matched routes and forwards the client X-Request-Id. Fix the router so auth covers unmatched paths, generate the id at the edge, propagate it upstream and back, and bound the whole request at eight seconds.",
        "starter": "let app = Router::new()\n    .route(\"/v1/orders\", get(list_orders))\n    .route_layer(from_fn(auth)) // TODO: what does this miss?\n    .layer(PropagateRequestIdLayer::x_request_id()); // TODO: who sets it?",
        "hint": "route_layer only runs for matched routes, so a 404 bypasses auth. Use layer after all routes are added, set the id before propagating it, and wrap the timeout outermost so it bounds auth as well.",
        "solution": "use std::time::Duration;\nuse axum::{Router, routing::get};\nuse tower_http::{\n    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},\n    timeout::TimeoutLayer,\n    trace::TraceLayer,\n};\n\nlet app = Router::new()\n    .route(\"/v1/orders\", get(list_orders))\n    .route(\"/v1/orders/{id}\", get(get_order))\n    // Policy layers are added after every route exists.\n    .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))\n    .layer(PropagateRequestIdLayer::x_request_id())\n    .layer(TraceLayer::new_for_http())\n    .layer(TimeoutLayer::new(Duration::from_secs(8)))\n    // Auth with layer(), not route_layer(), so unmatched paths are authenticated too.\n    .layer(axum::middleware::from_fn_with_state(state.clone(), auth))\n    .with_state(state);\n\n// Test: an unauthenticated request to /v1/nope must return 401, not 404.\n#[tokio::test]\nasync fn unknown_path_requires_auth() {\n    let response = app(state).oneshot(Request::get(\"/v1/nope\").body(Body::empty()).unwrap()).await.unwrap();\n    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);\n}"
      },
      "production": [
        "The layer versus route_layer choice for auth is documented per service, and a test pins the status an unauthenticated request gets on an unknown path.",
        "Every request carries an edge-generated id that appears in the response header, the access log, and upstream calls.",
        "Body size and request timeout limits are configured per route class, not globally at a value that breaks uploads.",
        "The gateway exports saturation, upstream error rate, and p99 by route; it has its own SLO and on-call owner.",
        "Client-supplied identity and forwarding headers are stripped or overwritten at the edge, and only the load balancer is trusted."
      ],
      "crates": [
        "axum",
        "tower",
        "tower-http"
      ],
      "github": [
        {
          "name": "tower-rs/tower-http",
          "url": "https://github.com/tower-rs/tower-http"
        },
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        }
      ],
      "pitfall": "Registering routes after calling layer: axum applies middleware only to routes that exist at the time of the call, so a route added later is silently unauthenticated and invisible to the tracing layer.",
      "questions": [
        {
          "q": "Why does route_layer behave differently from layer for authentication?",
          "options": [
            "route_layer runs asynchronously and layer does not",
            "route_layer only runs for requests that matched a route, so unmatched paths bypass it",
            "route_layer cannot access request extensions",
            "layer cannot be applied to a Router with state"
          ],
          "answer": 1,
          "explain": "The restriction is documented and intentional: running auth on unmatched paths turns a 404 into a 401. A gateway that proxies or reveals anything on the fallback should use layer and authenticate everything; a static 404 does not need it."
        },
        {
          "q": "Where should the request timeout sit relative to authentication?",
          "options": [
            "Inside the handler, so it only bounds database calls",
            "Outside authentication, so a slow identity provider cannot hold the connection indefinitely",
            "Inside the body-limit layer, so large bodies time out sooner",
            "It should not exist; clients set their own deadlines"
          ],
          "answer": 1,
          "explain": "A deadline only bounds work it wraps. Placing the timeout outside auth covers token verification, routing, and the handler in one budget."
        },
        {
          "q": "What should the gateway do with an inbound X-Forwarded-For header from an untrusted client?",
          "options": [
            "Append the peer address to the end of the list",
            "Overwrite it with the address it observed, trusting nothing from the client",
            "Forward it unchanged so services can log the original client",
            "Reject the request with 400"
          ],
          "answer": 1,
          "explain": "Appending preserves attacker-controlled entries that later parsers may trust. Overwriting at the first trusted hop is the only reliable option."
        }
      ],
      "quickbytes": [
        "Attach edge policy with layer() after all routes exist; route_layer silently skips unmatched paths.",
        "Generate the request id at the edge, overwrite any client value, and propagate it both ways.",
        "Tenant and user identity come from a verified token, never from a header the client can set."
      ],
      "resources": [
        {
          "title": "docs.rs: tower-http request-id, timeout, trace and limit layers",
          "url": "https://docs.rs/tower-http/latest/tower_http/",
          "kind": "docs"
        },
        {
          "title": "tower-rs/tower: ServiceBuilder and layer composition",
          "url": "https://github.com/tower-rs/tower",
          "kind": "repo"
        },
        {
          "title": "docs.rs: axum Router, layer and route_layer",
          "url": "https://docs.rs/axum/latest/axum/",
          "kind": "docs"
        },
        {
          "title": "docs.rs: tower ConcurrencyLimit and RateLimit",
          "url": "https://docs.rs/tower/latest/tower/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "q09",
      "title": "Backend for frontend: shaped payloads, honest degradation",
      "minutes": 80,
      "level": "advanced",
      "goal": "Build a per-client composition layer that aggregates services with per-section deadlines and degrades instead of failing the whole screen.",
      "sections": [
        {
          "h": "One backend per client, not one API for all",
          "p": [
            "A mobile home screen needs six fields from three services. A web dashboard needs forty from the same three, plus a permissions view. Without a BFF, that aggregation lives in each client, so every service change is a client release and every client platform reimplements the same fallbacks and retries.",
            "The BFF is a thin composition layer with no domain rules. Its test is simple: if a change alters business state, it belongs in a service; if it only changes the shape, ordering, or combination of a payload, it belongs in the BFF. The moment a BFF starts enforcing an invariant, you have two services that disagree about the business."
          ],
          "list": [
            "One BFF per client class (web, iOS, Android, partner API), not one per service",
            "The BFF owns payload shape, field selection, pagination defaults, and section composition",
            "Services stay client-agnostic and never grow a \"mobile\" endpoint",
            "BFF code is small enough to delete and rewrite when the client redesigns"
          ],
          "tip": "Count the BFF lines that would break if the domain rules changed. If more than a handful, business logic has leaked outward."
        },
        {
          "h": "Aggregation with partial failure",
          "p": [
            "tokio::try_join! returns on the first error, which is right for an invariant that spans both calls and wrong for a screen composed of independent sections. A recommendation service timing out should blank the recommendation rail, not the whole page. Use join! with per-section Results, or wrap each section in its own timeout and keep the error as data.",
            "Each downstream call gets a slice of the client budget, not the whole thing. If the budget is 800 ms and the page needs two sequential waves, each call gets roughly 300 ms with margin. Encode the budget in one place, subtract what has already elapsed, and never pass a fresh full timeout to each hop."
          ],
          "code": "use std::time::Duration;\nuse tokio::time::timeout;\n\n#[derive(serde::Serialize)]\npub struct HomeScreen {\n    pub account: AccountSection,\n    pub orders: Vec<OrderCard>,\n    pub recommendations: Option<Vec<Recommendation>>,\n    pub degraded: Vec<&'static str>,\n}\n\npub async fn home(\n    services: &Services,\n    tenant: TenantId,\n    user: UserId,\n) -> Result<HomeScreen, ApiError> {\n    let budget = Duration::from_millis(300);\n\n    // Account is required for the page to make sense.\n    let account = timeout(budget, services.accounts.summary(tenant, user))\n        .await\n        .map_err(|_| ApiError::UpstreamTimeout)?\n        .map_err(ApiError::Upstream)?;\n\n    // Orders and recommendations degrade independently.\n    let (orders, recommendations) = tokio::join!(\n        timeout(budget, services.orders.recent(tenant, user, 5)),\n        timeout(budget, services.recommendations.for_user(tenant, user)),\n    );\n\n    let mut degraded = Vec::new();\n    let orders = match orders {\n        Ok(Ok(rows)) => rows,\n        _ => {\n            degraded.push(\"orders\");\n            Vec::new()\n        }\n    };\n    let recommendations = match recommendations {\n        Ok(Ok(rows)) => Some(rows),\n        _ => {\n            degraded.push(\"recommendations\");\n            None\n        }\n    };\n\n    Ok(HomeScreen { account, orders, recommendations, degraded })\n}",
          "tip": "Return a degraded[] array with the section names. The client can render a skeleton for exactly those instead of guessing from nulls."
        },
        {
          "h": "Sessions, tokens and short-lived caches",
          "p": [
            "The browser BFF holds an HttpOnly, SameSite cookie session and exchanges it for on-behalf-of service tokens. Forwarding the raw access token to every downstream service spreads a credential that no service needs, and it makes revocation a coordinated problem across five teams.",
            "The BFF is also the correct place for a short-lived per-user response cache keyed by (tenant, user, section), because it sees the client cadence. Keep the TTL in seconds, invalidate on the write path that the client just performed, and never share an entry across tenants even if the user id collides."
          ],
          "code": "#[derive(Clone)]\npub struct BffCache {\n    inner: moka::future::Cache<(TenantId, UserId, &'static str), serde_json::Value>,\n}\n\nimpl BffCache {\n    pub fn new() -> Self {\n        Self {\n            inner: moka::future::Cache::builder()\n                .max_capacity(20_000)\n                .time_to_live(std::time::Duration::from_secs(15))\n                .build(),\n        }\n    }\n\n    /// Cache key includes tenant: a user id is unique per tenant, not globally.\n    pub async fn section<F, T>(&self, tenant: TenantId, user: UserId, name: &'static str, load: F) -> Option<T>\n    where\n        F: std::future::Future<Output = Option<T>>,\n        T: serde::Serialize + serde::de::DeserializeOwned,\n    {\n        let value = self\n            .inner\n            .get_with((tenant, user, name), async {\n                match load.await {\n                    Some(value) => serde_json::to_value(value).unwrap_or(serde_json::Value::Null),\n                    None => serde_json::Value::Null,\n                }\n            })\n            .await;\n        serde_json::from_value(value).ok()\n    }\n}",
          "tip": "Key BFF caches by tenant even when user ids are UUIDs: one tenant migration or id reuse turns a shared key into a cross-tenant data leak."
        }
      ],
      "exercise": {
        "prompt": "A web dashboard composes profile, invoices, and usage. Make the page return in under 600 ms with profile required and the other two optional, expose which sections degraded, and give each call its own budget.",
        "starter": "pub struct Dashboard { /* profile, invoices, usage */ }\n\npub async fn dashboard(services: &Services, user: UserId) -> Result<Dashboard, ApiError> {\n    // TODO: required call with timeout, then join the optional ones\n    todo!()\n}",
        "hint": "Profiles first with a 200 ms budget, then run invoices and usage concurrently with 250 ms each, leaving margin. Represent each optional section as Option plus a degraded list.",
        "solution": "#[derive(serde::Serialize)]\npub struct Dashboard {\n    pub profile: Profile,\n    pub invoices: Option<Vec<Invoice>>,\n    pub usage: Option<Usage>,\n    pub degraded: Vec<&'static str>,\n}\n\npub async fn dashboard(services: &Services, user: UserId) -> Result<Dashboard, ApiError> {\n    let profile = tokio::time::timeout(\n        std::time::Duration::from_millis(200),\n        services.profiles.get(user),\n    )\n    .await\n    .map_err(|_| ApiError::UpstreamTimeout)?\n    .map_err(ApiError::Upstream)?;\n\n    let (invoices, usage) = tokio::join!(\n        tokio::time::timeout(std::time::Duration::from_millis(250), services.billing.invoices(user)),\n        tokio::time::timeout(std::time::Duration::from_millis(250), services.metering.usage(user)),\n    );\n\n    let mut degraded = Vec::new();\n    let invoices = invoices.ok().and_then(Result::ok).or_else(|| {\n        degraded.push(\"invoices\");\n        None\n    });\n    let usage = usage.ok().and_then(Result::ok).or_else(|| {\n        degraded.push(\"usage\");\n        None\n    });\n\n    Ok(Dashboard { profile, invoices, usage, degraded })\n}"
      },
      "production": [
        "Every BFF section has an explicit budget, and the sum of section budgets plus margin fits inside the client timeout.",
        "Optional sections degrade to null plus a degraded[] entry; the page never 500s because a recommendation service is slow.",
        "The BFF holds no business invariant; a rule change never requires a BFF release.",
        "Per-user caches are keyed by tenant and user, have a TTL under a minute, and are invalidated by the write paths the client triggers.",
        "Downstream tokens are obtained on behalf of the user, and the raw client token is never forwarded to services that do not need it."
      ],
      "crates": [
        "axum",
        "serde",
        "tokio",
        "moka"
      ],
      "github": [
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        },
        {
          "name": "moka-rs/moka",
          "url": "https://github.com/moka-rs/moka"
        }
      ],
      "pitfall": "Using try_join! for independent screen sections: one slow recommendation service turns a partial page into a full-page error, and the retry storm makes the slow service slower.",
      "questions": [
        {
          "q": "Which responsibility belongs in a BFF rather than in a domain service?",
          "options": [
            "Deciding that an invoice cannot be issued before a subscription is active",
            "Trimming and combining service responses for one client screen",
            "Enforcing that stock cannot go negative",
            "Computing tax for a jurisdiction"
          ],
          "answer": 1,
          "explain": "Payload shape and composition are client concerns. Invariants and calculations stay in the service that owns the data, or they will diverge per client."
        },
        {
          "q": "What is the advantage of join! with per-section timeouts over try_join! for a page composed of independent sections?",
          "options": [
            "join! is faster because it uses fewer threads",
            "A failing section does not cancel or fail the sections that could have rendered",
            "try_join! cannot be used with timeouts",
            "join! automatically retries failed futures"
          ],
          "answer": 1,
          "explain": "try_join! short-circuits on the first error. For independent sections you want all results so the page can render what is available and mark the rest degraded."
        },
        {
          "q": "Why must a BFF response cache include the tenant in the key even when user ids are UUIDs?",
          "options": [
            "Because UUIDs collide across tenants by design",
            "Because tenant scoping is a security property; id uniqueness is an assumption you should not rely on across a migration",
            "Because moka requires composite keys",
            "Because the HTTP cache varies by tenant header only"
          ],
          "answer": 1,
          "explain": "Cross-tenant leaks are the failure you cannot recover from. Including the tenant makes the key correct by construction rather than by a global uniqueness assumption."
        }
      ],
      "quickbytes": [
        "One BFF per client class; services stay client-agnostic and never grow a mobile variant.",
        "Give each section its own budget inside the client timeout, and return which sections degraded.",
        "Session cookie at the BFF, on-behalf-of tokens downstream; never forward the raw client credential everywhere."
      ],
      "resources": [
        {
          "title": "docs.rs: axum handlers, state and extractors for aggregation endpoints",
          "url": "https://docs.rs/axum/latest/axum/",
          "kind": "docs"
        },
        {
          "title": "docs.rs: tokio join!, try_join! and timeouts",
          "url": "https://docs.rs/tokio/latest/tokio/",
          "kind": "docs"
        },
        {
          "title": "moka: concurrent cache with TTL and eviction for response caching",
          "url": "https://docs.rs/moka/latest/moka/",
          "kind": "docs"
        },
        {
          "title": "moka-rs/moka: TinyLFU admission and eviction implementation",
          "url": "https://github.com/moka-rs/moka",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "q10",
      "title": "Saga orchestration with a persisted state machine",
      "minutes": 110,
      "level": "advanced",
      "goal": "Coordinate a multi-service business process with a durable saga row, compare-and-set step transitions, and compensations that survive crashes and retries.",
      "sections": [
        {
          "h": "Orchestration buys operability, choreography buys decoupling",
          "p": [
            "In choreography each service reacts to another service event and nobody owns the whole flow. It decouples services beautifully and destroys operability: when a refund is stuck, there is no single place to look, only six event logs to correlate by hand. Orchestration puts a coordinator in front, and one row answers where the order is and what it is waiting for.",
            "The coordinator is a coupling point, so keep it thin. It invokes commands that services own and records their outcomes; it must not decide prices, stock levels, or credit rules, because that logic already exists inside a service. A coordinator with business rules is a distributed monolith with a new name."
          ],
          "list": [
            "Steps are commands owned by services; the saga only sequences and records them",
            "Every step is idempotent by contract, because it will be retried",
            "Every step has a deadline; an expired step drives compensation, not an infinite retry",
            "The pivot step is the point of no return; compensations after it are business-level reversals"
          ],
          "tip": "If you cannot draw the saga as a state machine with named transitions, the process is not understood well enough to automate."
        },
        {
          "h": "Persist the step, never the stack",
          "p": [
            "A saga survives a deploy, a crash, and a two-day supplier delay, so its state cannot live in a coroutine. Store a row with the current step, status, attempt count, deadline, and a JSON payload of what the steps need. A worker claims work with SELECT ... FOR UPDATE SKIP LOCKED, and multiple workers scale without coordination.",
            "Every transition is a compare-and-set on the expected step. If a worker crashes after charging a card but before writing the new step, the retry re-reads the row and stays on the charge step, and idempotency at the service keeps the charge from repeating. Without the expected-step guard, two workers can both advance the saga and the second overwrites the first."
          ],
          "code": "CREATE TABLE sagas (\n    id              uuid PRIMARY KEY,\n    tenant_id       uuid NOT NULL,\n    kind            text NOT NULL,\n    step            text NOT NULL,          -- reserve, charge, ship, done, compensating\n    status          text NOT NULL,          -- running, completed, failed, needs_intervention\n    attempts        int  NOT NULL DEFAULT 0,\n    deadline_at     timestamptz NOT NULL,\n    next_attempt_at timestamptz NOT NULL DEFAULT now(),\n    payload         jsonb NOT NULL\n);\n\nCREATE INDEX sagas_due ON sagas (next_attempt_at) WHERE status = 'running';\n\n-- Claim one due saga per worker without blocking peers.\nSELECT id FROM sagas\nWHERE status = 'running' AND next_attempt_at <= now()\nORDER BY next_attempt_at\nLIMIT 1\nFOR UPDATE SKIP LOCKED;",
          "tip": "A partial index on the due predicate keeps the claim query fast when most rows are completed; the table grows, the working set does not."
        },
        {
          "h": "Compensation is a step with its own failure modes",
          "p": [
            "Compensate in reverse order and only for steps that committed. Each compensation must be idempotent because the original step may have partially succeeded: a refund endpoint that keys on (payment_id, reason) can be called twice safely, while one that inserts a refund row cannot.",
            "A failing compensation must not retry forever. Cap attempts, then move the saga to needs_intervention and put it in a queue a human reads, with the payload and the last error attached. Infinite compensation retries look resilient in a dashboard and hide money that never came back."
          ],
          "code": "impl Saga {\n    /// Compare-and-set: only the worker holding the expected step advances it.\n    pub async fn advance(\n        pool: &sqlx::PgPool,\n        id: uuid::Uuid,\n        expected: Step,\n        next: Step,\n    ) -> sqlx::Result<bool> {\n        let affected = sqlx::query(\n            \"UPDATE sagas\n                SET step = $3, attempts = 0, next_attempt_at = now() + interval '30 seconds'\n              WHERE id = $1 AND step = $2 AND status = 'running'\",\n        )\n        .bind(id)\n        .bind(expected.as_str())\n        .bind(next.as_str())\n        .execute(pool)\n        .await?\n        .rows_affected();\n        Ok(affected == 1)\n    }\n\n    pub async fn fail_step(pool: &sqlx::PgPool, id: uuid::Uuid, error: &str) -> sqlx::Result<()> {\n        sqlx::query(\n            \"UPDATE sagas\n                SET attempts = attempts + 1,\n                    status = CASE WHEN attempts + 1 >= 5 THEN 'needs_intervention' ELSE 'running' END,\n                    next_attempt_at = now() + (interval '1 minute' * power(2, attempts + 1)),\n                    payload = jsonb_set(payload, '{last_error}', to_jsonb($2::text))\n              WHERE id = $1\",\n        )\n        .bind(id)\n        .bind(error)\n        .execute(pool)\n        .await?;\n        Ok(())\n    }\n}",
          "tip": "Store the last error inside the saga payload: when it lands in the intervention queue, the operator needs the failure reason without joining five logs."
        }
      ],
      "exercise": {
        "prompt": "Model a three-step fulfilment saga: reserve stock, charge card, create shipment. Reserve must roll back on a failed charge, and a failed shipment must trigger a refund. Write the step enum, the transition table, and the compensation order.",
        "starter": "enum Step { ReserveStock, ChargeCard, CreateShipment, CompensateCharge, CompensateReserve, Done, NeedsIntervention }\n\n// TODO: which transitions are legal, what does each compensate, and what is the pivot?",
        "hint": "The pivot is charge success: before it, compensations are free releases; after it, they are refunds that move money and need idempotency keys. Encode the legal transitions in one function and test that an illegal one is rejected.",
        "solution": "#[derive(Clone, Copy, PartialEq, Eq, Debug)]\npub enum Step {\n    ReserveStock,\n    ChargeCard,\n    CreateShipment,\n    ReleaseStock,\n    RefundCharge,\n    Done,\n    NeedsIntervention,\n}\n\nimpl Step {\n    pub fn next_on_success(self) -> Option<Step> {\n        match self {\n            Step::ReserveStock => Some(Step::ChargeCard),\n            Step::ChargeCard => Some(Step::CreateShipment),\n            Step::CreateShipment => Some(Step::Done),\n            _ => None,\n        }\n    }\n\n    /// Reverse order, only steps that committed.\n    pub fn compensate_after(self) -> Option<Step> {\n        match self {\n            Step::CreateShipment => Some(Step::RefundCharge),\n            Step::ChargeCard => Some(Step::ReleaseStock),\n            _ => None,\n        }\n    }\n\n    pub fn is_terminal(self) -> bool {\n        matches!(self, Step::Done | Step::NeedsIntervention)\n    }\n}\n\n#[test]\nfn refund_follows_release() {\n    assert_eq!(Step::CreateShipment.compensate_after(), Some(Step::RefundCharge));\n    assert_eq!(Step::RefundCharge.compensate_after(), None);\n    assert!(Step::Done.is_terminal());\n}"
      },
      "production": [
        "Every saga row records the current step, attempt count, deadline, and last error; there is no in-memory saga state.",
        "Step transitions use compare-and-set on the expected step; a test runs two workers and asserts exactly one advancement.",
        "Each step declares a deadline, and an expired deadline enters the compensation path rather than retrying indefinitely.",
        "Compensations are idempotent by contract and capped at a small attempt count, after which the saga is parked for a human.",
        "A dashboard lists sagas in needs_intervention with age and step, and the queue has an owner."
      ],
      "crates": [
        "sqlx",
        "tokio",
        "serde",
        "uuid"
      ],
      "github": [
        {
          "name": "launchbadge/sqlx",
          "url": "https://github.com/transact-rs/sqlx"
        },
        {
          "name": "serverlesstechnology/cqrs",
          "url": "https://github.com/serverlesstechnology/cqrs"
        }
      ],
      "pitfall": "Keeping saga state in the coroutine that started it: the process restarts during a deploy, the future is dropped mid-step, and the card is charged with no record that shipment is owed.",
      "questions": [
        {
          "q": "Why is a compare-and-set on the expected step necessary when several workers poll the saga table?",
          "options": [
            "It makes the query faster by using the primary key",
            "It ensures only one worker advances a saga from a given step, so a crash-retry cannot double-apply",
            "It prevents the saga row from being deleted",
            "It orders compensations automatically"
          ],
          "answer": 1,
          "explain": "SKIP LOCKED prevents simultaneous claims, but a crash releases the lock while the row still says the old step. The expected-step guard makes the retry safe."
        },
        {
          "q": "What distinguishes the pivot step in a saga?",
          "options": [
            "It is the step that takes the longest",
            "It is the point after which compensation becomes a business reversal rather than a free rollback",
            "It is the only step that can fail",
            "It is the step that must run in the same process as the coordinator"
          ],
          "answer": 1,
          "explain": "Before the pivot, compensations release reservations. After it, money or goods have moved, so compensation is a refund or return with its own rules and idempotency requirements."
        },
        {
          "q": "A compensation has failed five times. What should the coordinator do?",
          "options": [
            "Retry with exponential backoff indefinitely",
            "Mark the saga needs_intervention with the payload and last error, and alert the owning team",
            "Delete the saga so the queue stays clean",
            "Restart the saga from the first step"
          ],
          "answer": 1,
          "explain": "Unlimited retries hide a real-world failure that a human must resolve. Parking the saga preserves the evidence and makes the backlog visible."
        }
      ],
      "quickbytes": [
        "One row per saga with step, deadline, attempts, and last error; a coroutine is not a state machine.",
        "Claim with FOR UPDATE SKIP LOCKED, advance with compare-and-set on the expected step.",
        "Cap compensation attempts; a queue a human reads beats an infinite retry loop."
      ],
      "resources": [
        {
          "title": "docs.rs: sqlx transactions and row locking queries",
          "url": "https://docs.rs/sqlx/latest/sqlx/",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: SELECT ... FOR UPDATE SKIP LOCKED for job queues",
          "url": "https://www.postgresql.org/docs/current/sql-select.html",
          "kind": "docs"
        },
        {
          "title": "launchbadge/sqlx: async Postgres driver and pool",
          "url": "https://github.com/transact-rs/sqlx",
          "kind": "repo"
        },
        {
          "title": "PostgreSQL: explicit locking and transaction isolation",
          "url": "https://www.postgresql.org/docs/current/transaction-iso.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "q11",
      "title": "Multi-tenancy: isolation you can prove",
      "minutes": 100,
      "level": "industry",
      "goal": "Pick an isolation model deliberately, then enforce tenant scoping twice: in the query path and in Postgres row-level security that survives a code mistake.",
      "sections": [
        {
          "h": "Three models, three bills",
          "p": [
            "Silo gives each tenant a database or instance: strongest isolation, per-tenant restore and export, and an operational bill that grows linearly with customers. Pool shares schema and rows with a tenant_id on every table: cheapest to run, and it makes a missing filter a cross-tenant data breach. Bridge, one schema per tenant in a shared database, sits between them and complicates migrations.",
            "Choose with four facts: what the contract or regulator demands, how skewed tenant sizes are, whether per-tenant restore is a sold feature, and how many tenants you expect. A common end state is pool as the default with the largest tenants promoted to silo, which means the isolation boundary must be expressible per tenant rather than baked into the code."
          ],
          "list": [
            "Pool: one schema, tenant_id everywhere, RLS as the second line of defence",
            "Silo: separate database, simplest security story, hardest fleet operations",
            "Bridge: schema per tenant, good for hundreds of tenants with per-tenant export",
            "Whichever you pick, the tenant id comes from the verified token, never the request body"
          ],
          "tip": "Write the isolation test before the first table: two tenants, same resource id, assert each sees only its own rows. Retrofitting that test finds bugs you shipped months ago."
        },
        {
          "h": "Defence in depth with row-level security",
          "p": [
            "Every query filters by tenant, and Postgres enforces the filter again with a policy. Set the tenant at the start of each transaction with set_config(app.tenant_id, $1, true); the third argument true makes the setting transaction-local, which matters because connections are pooled and a leaked setting would silently scope the next request to the previous tenant.",
            "The pitfalls are documented and easy to hit. A table owner bypasses RLS unless the table is altered with FORCE ROW LEVEL SECURITY, and superusers or roles with BYPASSRLS always bypass it. If your integration tests run as the owner, the policy is not being tested at all, which is why tenant tests must connect with the application role."
          ],
          "code": "ALTER TABLE orders ENABLE ROW LEVEL SECURITY;\nALTER TABLE orders FORCE ROW LEVEL SECURITY;   -- applies to the owner too\n\nCREATE POLICY orders_tenant_isolation ON orders\n    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)\n    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);\n\n-- Application path: tenant is set for the transaction only.\nBEGIN;\nSELECT set_config('app.tenant_id', '3f1c9a52-0000-7000-8000-000000000001', true);\nSELECT id, total_minor FROM orders;      -- only rows of that tenant\nINSERT INTO orders (id, tenant_id, total_minor) VALUES (gen_random_uuid(), current_setting('app.tenant_id')::uuid, 4200);\nCOMMIT;   -- setting expires with the transaction\n\n-- Test role must not be the table owner, or the policy never runs.\nCREATE ROLE app_rw NOLOGIN;\nGRANT SELECT, INSERT, UPDATE, DELETE ON orders TO app_rw;",
          "tip": "current_setting(..., true) returns NULL when unset, and NULL comparison filters everything out. Fail-closed is the behaviour you want; verify it with a test that forgets to set the tenant."
        },
        {
          "h": "Noisy neighbours, quotas and tenant-aware telemetry",
          "p": [
            "Shared infrastructure means one tenant can starve the rest. Enforce per-tenant concurrency and request rates at the edge, cap connections per tenant for expensive paths, and give interactive traffic priority over bulk exports. These limits belong in configuration with a default and explicit overrides for the tenants that paid for more.",
            "Put the tenant id on every log line, span, and metric, but do not make it a high-cardinality metric label. Log it, and add it as a trace attribute; for metrics, aggregate per plan tier and keep per-tenant dashboards on sampled data. A metric with one series per tenant will melt the scrape endpoint long before the database notices."
          ],
          "code": "use axum::{\n    extract::FromRequestParts,\n    http::{request::Parts, StatusCode},\n};\n\n#[derive(Clone, Copy, Debug)]\npub struct TenantId(pub uuid::Uuid);\n\nimpl<S: Send + Sync> FromRequestParts<S> for TenantId {\n    type Rejection = (StatusCode, &'static str);\n\n    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {\n        // Inserted by the auth layer after token verification; never parsed from a header.\n        parts\n            .extensions\n            .get::<TenantId>()\n            .copied()\n            .ok_or((StatusCode::UNAUTHORIZED, \"missing tenant context\"))\n    }\n}\n\n/// One transaction, tenant set before any query runs.\npub async fn with_tenant<'a>(\n    pool: &'a sqlx::PgPool,\n    tenant: TenantId,\n) -> sqlx::Result<sqlx::Transaction<'a, sqlx::Postgres>> {\n    let mut tx = pool.begin().await?;\n    sqlx::query(\"SELECT set_config('app.tenant_id', $1, true)\")\n        .bind(tenant.0.to_string())\n        .execute(&mut *tx)\n        .await?;\n    Ok(tx)\n}",
          "tip": "Scope the tenant setting at transaction start in one helper so no query can run before it; a SET LOCAL repeated at the top of every function will be missing from exactly the path that needed it."
        }
      ],
      "exercise": {
        "prompt": "Add tenant isolation to an orders table: schema change, RLS policies for read and write, a transaction helper that sets the tenant, and an integration test proving a second tenant sees zero rows and cannot insert a row claiming the first tenant.",
        "starter": "-- TODO: tenant_id column, ENABLE + FORCE RLS, policy with USING and WITH CHECK\n-- TODO: test as app_rw, not as the table owner",
        "hint": "WITH CHECK is what blocks the forged insert; USING only filters reads. FORCE ROW LEVEL SECURITY is what makes the policy apply to the owner, which is why a migration test as owner proves nothing.",
        "solution": "ALTER TABLE orders ADD COLUMN tenant_id uuid NOT NULL;\nCREATE INDEX orders_tenant_created ON orders (tenant_id, created_at DESC);\n\nALTER TABLE orders ENABLE ROW LEVEL SECURITY;\nALTER TABLE orders FORCE ROW LEVEL SECURITY;\n\nCREATE POLICY orders_read ON orders FOR SELECT\n    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);\n\nCREATE POLICY orders_write ON orders FOR INSERT\n    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);\n\nCREATE POLICY orders_update ON orders FOR UPDATE\n    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)\n    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);\n\n-- Integration test (connects as app_rw):\nlet mut tx = with_tenant(&pool, TenantId(tenant_a)).await?;\nlet visible: i64 = sqlx::query_scalar(\"SELECT count(*) FROM orders\")\n    .fetch_one(&mut *tx).await?;\nassert_eq!(visible, 0, \"tenant A must not see tenant B rows\");\n\nlet forged = sqlx::query(\n    \"INSERT INTO orders (id, tenant_id, total_minor) VALUES (gen_random_uuid(), $1, 100)\",\n)\n.bind(tenant_b)                     // forging another tenant\n.execute(&mut *tx)\n.await;\nassert!(forged.is_err(), \"WITH CHECK must reject a foreign tenant id\");"
      },
      "production": [
        "Every tenant-scoped table has tenant_id NOT NULL, an index leading with tenant_id, and ENABLE plus FORCE row level security.",
        "The tenant is set per transaction in one helper before any query, using the transaction-local form of set_config.",
        "Integration tests connect as the application role, not the table owner, and assert both zero cross-tenant reads and rejected cross-tenant writes.",
        "Tenant id appears in logs and traces but not as an unbounded metric label; per-tenant dashboards use sampled or aggregated data.",
        "Per-tenant quotas exist for request rate, concurrency, and bulk jobs, with documented overrides for large customers."
      ],
      "crates": [
        "sqlx",
        "axum",
        "uuid",
        "tower"
      ],
      "github": [
        {
          "name": "launchbadge/sqlx",
          "url": "https://github.com/transact-rs/sqlx"
        },
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        }
      ],
      "pitfall": "Setting the tenant with a plain SET on a pooled connection: the setting survives the transaction, the connection returns to the pool, and the next tenant request reads the previous tenant rows.",
      "questions": [
        {
          "q": "Why does set_config take a third argument of true in the tenant helper?",
          "options": [
            "It makes the setting apply only to the current transaction, so a pooled connection cannot leak it",
            "It enables row-level security for the session",
            "It grants the app role permission to change settings",
            "It caches the value for faster reads"
          ],
          "answer": 0,
          "explain": "The is_local flag scopes the setting to the transaction. With pooled connections, a session-scoped value survives into the next request and becomes a cross-tenant leak."
        },
        {
          "q": "A table owner runs a query against a table with RLS enabled and no FORCE clause. What happens?",
          "options": [
            "The policy applies because RLS is enabled",
            "The owner bypasses the policies and sees all rows",
            "The query fails with a permission error",
            "The policy applies only to SELECT statements"
          ],
          "answer": 1,
          "explain": "Owners bypass RLS unless FORCE ROW LEVEL SECURITY is set. Tests run as the owner therefore cannot detect a missing tenant filter."
        },
        {
          "q": "Which policy clause stops a request from inserting a row that belongs to another tenant?",
          "options": [
            "USING, because it filters visible rows",
            "WITH CHECK, because it validates rows being written",
            "A unique index on tenant_id",
            "GRANT SELECT on the table to the app role"
          ],
          "answer": 1,
          "explain": "USING filters reads and the rows an UPDATE can see; WITH CHECK validates the new row values on INSERT and UPDATE. You need both for complete isolation."
        }
      ],
      "quickbytes": [
        "Tenant comes from the verified token, never from a body field, query parameter, or header.",
        "FORCE ROW LEVEL SECURITY plus a test as the app role; owner-run tests prove nothing.",
        "A missing tenant setting yields NULL and filters everything: fail-closed is the default you want."
      ],
      "resources": [
        {
          "title": "PostgreSQL: row security policies, FORCE and WITH CHECK",
          "url": "https://www.postgresql.org/docs/current/ddl-rowsecurity.html",
          "kind": "docs"
        },
        {
          "title": "AWS SaaS Lens: tenant isolation models and pooled infrastructure",
          "url": "https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/saas-lens.html",
          "kind": "docs"
        },
        {
          "title": "docs.rs: sqlx pool and transaction handling",
          "url": "https://docs.rs/sqlx/latest/sqlx/",
          "kind": "docs"
        },
        {
          "title": "launchbadge/sqlx: pool behaviour and connection lifecycle",
          "url": "https://github.com/transact-rs/sqlx",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "q12",
      "title": "Idempotency by design, not by hope",
      "minutes": 85,
      "level": "advanced",
      "goal": "Make every mutating endpoint safe to retry with a tenant-scoped key table, a request fingerprint, and a stored response that replays instead of re-executing.",
      "sections": [
        {
          "h": "At-least-once is the only delivery guarantee you get",
          "p": [
            "Clients time out and retry, load balancers retry, queues redeliver, and mobile networks duplicate requests without telling anyone. Every one of those paths assumes a retry is safe. If the endpoint is not idempotent, the outcome is a double order, a double charge, or a duplicate shipment, and the frequency of that bug scales with your traffic.",
            "There are two ways to be safe. Natural idempotency keys the write on a business identifier the client already owns, such as an order id generated by the client, so the second attempt becomes an upsert. A key table covers the rest: the client sends an Idempotency-Key, and the server records the key, the request fingerprint, and the response."
          ],
          "list": [
            "Prefer natural keys: the client-generated id is already unique and meaningful",
            "For everything else, require an Idempotency-Key from clients that retry",
            "Scope the key by tenant and route, or one tenant can replay another tenant request",
            "Never implement idempotency as a SELECT followed by an INSERT: the race is the bug"
          ],
          "tip": "If the client cannot retry meaningfully, do not invent a key; fix the client contract instead."
        },
        {
          "h": "The key table protocol",
          "p": [
            "Insert the key row in the same transaction as the effect, with a unique constraint on (tenant_id, route, key). The insert is the lock: a concurrent duplicate blocks on the unique index, then reads the committed row. That removes the check-then-act race without any application-level mutex.",
            "On conflict, compare the stored request fingerprint. Same key and same body replays the stored response with the original status; same key and different body is a client error, not a replay, because two different requests are claiming one identity. A row with no response yet means the first attempt is still running, so answer 409 with Retry-After instead of starting the work twice."
          ],
          "code": "CREATE TABLE idempotency_keys (\n    tenant_id      uuid        NOT NULL,\n    route          text        NOT NULL,\n    key            text        NOT NULL,\n    request_hash   bytea       NOT NULL,\n    status_code    smallint,\n    response_body  jsonb,\n    created_at     timestamptz NOT NULL DEFAULT now(),\n    PRIMARY KEY (tenant_id, route, key)\n);\n\npub async fn execute_once<F, Fut>(\n    pool: &sqlx::PgPool,\n    tenant: uuid::Uuid,\n    route: &str,\n    key: &str,\n    request_hash: &[u8],\n    effect: F,\n) -> Result<(u16, serde_json::Value), ApiError>\nwhere\n    F: FnOnce(sqlx::Transaction<'_, sqlx::Postgres>) -> Fut,\n    Fut: std::future::Future<Output = Result<(u16, serde_json::Value), ApiError>>,\n{\n    let mut tx = pool.begin().await?;\n\n    let inserted = sqlx::query(\n        \"INSERT INTO idempotency_keys (tenant_id, route, key, request_hash)\n         VALUES ($1, $2, $3, $4)\n         ON CONFLICT (tenant_id, route, key) DO NOTHING\",\n    )\n    .bind(tenant)\n    .bind(route)\n    .bind(key)\n    .bind(request_hash)\n    .execute(&mut *tx)\n    .await?\n    .rows_affected();\n\n    if inserted == 0 {\n        let existing: Option<(Vec<u8>, Option<i16>, Option<serde_json::Value>)> = sqlx::query_as(\n            \"SELECT request_hash, status_code, response_body FROM idempotency_keys\n             WHERE tenant_id = $1 AND route = $2 AND key = $3\",\n        )\n        .bind(tenant).bind(route).bind(key)\n        .fetch_optional(&mut *tx)\n        .await?;\n\n        return match existing {\n            Some((hash, _, _)) if hash != request_hash => Err(ApiError::KeyReuse),\n            Some((_, Some(code), Some(body))) => Ok((code as u16, body)),\n            Some(_) => Err(ApiError::InProgress),\n            None => Err(ApiError::Conflict),\n        };\n    }\n\n    let (code, body) = effect(tx).await?;\n    Ok((code, body))\n}",
          "tip": "Commit the key row and the effect together. If they can diverge, a crash between them either double-executes or permanently blocks the key."
        },
        {
          "h": "Bounded scope, bounded lifetime",
          "p": [
            "Keys are not permanent. Give them a retention window that matches the longest plausible client retry, commonly twenty-four hours, and delete older rows in a scheduled job. Store response bodies only below a size cap; an endpoint returning a megabyte should store a reference or nothing at all.",
            "Do not apply idempotency keys to GET or to pure reads, and do not let an internal service reuse a client key without namespacing it. The failure mode to avoid is a key space so broad that a legitimate second purchase with the same payload is silently swallowed as a replay months later."
          ],
          "code": "-- Retention: delete keys older than the retry horizon, in small batches.\nDELETE FROM idempotency_keys\nWHERE ctid IN (\n    SELECT ctid FROM idempotency_keys\n    WHERE created_at < now() - interval '24 hours'\n    LIMIT 5000\n);\n\n-- Fingerprint: hash the canonical body, not the raw bytes (field order varies).\npub fn fingerprint<T: serde::Serialize>(body: &T) -> Result<Vec<u8>, serde_json::Error> {\n    use sha2::{Digest, Sha256};\n    let canonical = serde_json::to_vec(body)?;\n    Ok(Sha256::digest(&canonical).to_vec())\n}",
          "tip": "Hash a canonical serialization. Hashing raw request bytes makes a client that reorders JSON keys look like a different request and turns a replay into a 409."
        }
      ],
      "exercise": {
        "prompt": "Add idempotent payment creation: table, unique key, fingerprint comparison, and a test that sends the same request twice and gets one payment plus the same response, then sends a different body with the same key and gets a client error.",
        "starter": "// TODO: schema for idempotency_keys scoped by tenant and route\n// TODO: execute_once wrapper with INSERT ... ON CONFLICT DO NOTHING\n// TODO: three tests: replay, key reuse with different body, concurrent duplicate",
        "hint": "The concurrent test needs two tasks and a real database. Assert that the payments table has exactly one row and that both callers saw the same payment id.",
        "solution": "#[sqlx::test]\nasync fn replay_returns_the_same_payment(pool: sqlx::PgPool) -> anyhow::Result<()> {\n    let tenant = uuid::Uuid::now_v7();\n    let request = CreatePayment { amount_minor: 2500, currency: \"EUR\".into() };\n    let hash = fingerprint(&request)?;\n\n    let first = create_payment_once(&pool, tenant, \"k-1\", &hash, &request).await?;\n    let second = create_payment_once(&pool, tenant, \"k-1\", &hash, &request).await?;\n\n    assert_eq!(first.body[\"id\"], second.body[\"id\"]);\n    let count: i64 = sqlx::query_scalar(\"SELECT count(*) FROM payments WHERE tenant_id = $1\")\n        .bind(tenant)\n        .fetch_one(&pool)\n        .await?;\n    assert_eq!(count, 1, \"the retry must not create a second payment\");\n    Ok(())\n}\n\n#[sqlx::test]\nasync fn same_key_different_body_is_rejected(pool: sqlx::PgPool) -> anyhow::Result<()> {\n    let tenant = uuid::Uuid::now_v7();\n    let a = CreatePayment { amount_minor: 2500, currency: \"EUR\".into() };\n    let b = CreatePayment { amount_minor: 9900, currency: \"EUR\".into() };\n\n    create_payment_once(&pool, tenant, \"k-2\", &fingerprint(&a)?, &a).await?;\n    let err = create_payment_once(&pool, tenant, \"k-2\", &fingerprint(&b)?, &b).await;\n    assert!(matches!(err, Err(ApiError::KeyReuse)));\n    Ok(())\n}\n\n#[sqlx::test]\nasync fn concurrent_duplicates_create_one_payment(pool: sqlx::PgPool) -> anyhow::Result<()> {\n    let tenant = uuid::Uuid::now_v7();\n    let request = CreatePayment { amount_minor: 500, currency: \"EUR\".into() };\n    let hash = fingerprint(&request)?;\n\n    let (a, b) = tokio::join!(\n        create_payment_once(&pool, tenant, \"k-3\", &hash, &request),\n        create_payment_once(&pool, tenant, \"k-3\", &hash, &request),\n    );\n\n    let one_created = [&a, &b].iter().filter(|r| r.is_ok()).count();\n    assert!(one_created <= 2); // at least one succeeds; the other either replays or gets InProgress\n    let count: i64 = sqlx::query_scalar(\"SELECT count(*) FROM payments WHERE tenant_id = $1\")\n        .bind(tenant).fetch_one(&pool).await?;\n    assert_eq!(count, 1);\n    Ok(())\n}"
      },
      "production": [
        "Every mutating endpoint that clients may retry requires an Idempotency-Key and stores it with the effect in one transaction.",
        "Keys are unique per tenant and route, and a fingerprint mismatch returns 409 rather than replaying another request response.",
        "In-flight keys return 409 with Retry-After instead of blocking a worker indefinitely.",
        "A retention job deletes keys older than the documented horizon, and stored response bodies are size-capped.",
        "Tests cover replay, key reuse with a different body, and two concurrent duplicates against a real database."
      ],
      "crates": [
        "sqlx",
        "uuid",
        "serde",
        "sha2"
      ],
      "github": [
        {
          "name": "launchbadge/sqlx",
          "url": "https://github.com/transact-rs/sqlx"
        },
        {
          "name": "uuid-rs/uuid",
          "url": "https://github.com/uuid-rs/uuid"
        }
      ],
      "pitfall": "Checking for an existing key with SELECT and inserting after the effect: two concurrent requests both pass the check, both create the order, and the unique index fires after the damage.",
      "questions": [
        {
          "q": "Why is INSERT ... ON CONFLICT DO NOTHING correct where a SELECT-then-INSERT is not?",
          "options": [
            "It is faster in all cases",
            "The unique index serialises concurrent duplicates, so the check and the claim are one atomic step",
            "It avoids taking any lock",
            "It automatically returns the previous response"
          ],
          "answer": 1,
          "explain": "Check-then-act leaves a window between the two statements. The insert with a conflict clause is a single atomic attempt to claim the key."
        },
        {
          "q": "Same key, different request body. What is the correct response?",
          "options": [
            "Replay the first response, because the key is what matters",
            "Reject with a client error: the key was already used for a different request",
            "Overwrite the stored response with the new one",
            "Delete the key and process the new request"
          ],
          "answer": 1,
          "explain": "The key identifies one request. A different body under the same key is an integration bug, and silently replaying the old response hides it."
        },
        {
          "q": "Why must the key include the tenant and the route?",
          "options": [
            "To keep the index smaller",
            "So one tenant cannot replay another tenant key and two endpoints cannot collide",
            "Because UUID keys are not unique",
            "Because HTTP caching requires it"
          ],
          "answer": 1,
          "explain": "Keys are client-chosen strings, so collisions across tenants or routes are inevitable. Scoping makes the key unique in the domain where it is meaningful."
        }
      ],
      "quickbytes": [
        "The unique index on (tenant, route, key) is the lock; no mutex or advisory lock needed for the common case.",
        "Store the response with the key so a retry costs one row read instead of re-running the business logic.",
        "Hash a canonical body: a client that reorders JSON keys must not look like a new request."
      ],
      "resources": [
        {
          "title": "PostgreSQL: ON CONFLICT and unique index guarantees",
          "url": "https://www.postgresql.org/docs/current/sql-insert.html",
          "kind": "docs"
        },
        {
          "title": "docs.rs: sqlx transactions for key-plus-effect atomicity",
          "url": "https://docs.rs/sqlx/latest/sqlx/",
          "kind": "docs"
        },
        {
          "title": "uuid: generating client and server identifiers, v7 ordering",
          "url": "https://docs.rs/uuid/latest/uuid/",
          "kind": "docs"
        },
        {
          "title": "launchbadge/sqlx: query and transaction API used in the key table",
          "url": "https://github.com/transact-rs/sqlx",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "q13",
      "title": "Caching strategy: staleness is the currency",
      "minutes": 80,
      "level": "advanced",
      "goal": "Set a staleness budget per read path, use a cache-aside design that survives stampedes, and put invalidation on the write path where it can be reasoned about.",
      "sections": [
        {
          "h": "A cache is a trade, priced in staleness",
          "p": [
            "A cache buys latency and database load and pays with staleness and a second place where data lives. It does not fix a missing index, a bad query plan, or an N+1 loop; caching a slow query makes a slow query with a smaller bill. Decide the staleness budget per read path before choosing a mechanism: a product description tolerates minutes, a stock count tolerates none.",
            "Cache-aside is the default shape: read the cache, on a miss load from the database, insert, return. Writes invalidate after the transaction commits. The storage library is the easy part. The part that decides whether the system behaves is what happens on a miss under load, and whether the invalidation is ordered correctly against the commit."
          ],
          "list": [
            "One staleness budget per read path, written down next to the endpoint",
            "Cache keys include tenant and a schema version so a deploy can invalidate a class at once",
            "Invalidate after commit; never before, and never from inside a rolled-back transaction",
            "Do not cache authorisation decisions; compute them per request from verified claims"
          ],
          "tip": "If nobody can state the staleness budget, the answer is zero and the correct cache is no cache."
        },
        {
          "h": "Stampedes, penetration, and coalescing",
          "p": [
            "A hot key expiring under load sends every concurrent request to the database at once, which is the moment the database can least afford it. moka handles the common case with get_with: concurrent loads for the same key are coalesced into one future, so one query runs and the rest await its result. Jittered TTLs spread expiry across time so the herd is smaller in the first place.",
            "A different failure is penetration: requests for identifiers that do not exist never hit a cache that only stores successes, so a scanning client turns cache misses into a database query every time. Cache negative results briefly, five to thirty seconds, and make sure a later create invalidates that key. Both fixes are cheap; both are invisible until traffic doubles."
          ],
          "code": "use std::time::Duration;\nuse moka::future::Cache;\n\n#[derive(Clone, Copy, PartialEq, Eq, Hash)]\npub struct ProductKey {\n    pub tenant: uuid::Uuid,\n    pub product: uuid::Uuid,\n}\n\npub struct ProductCache {\n    inner: Cache<ProductKey, Option<ProductView>>,\n}\n\nimpl ProductCache {\n    pub fn new() -> Self {\n        Self {\n            inner: Cache::builder()\n                .max_capacity(50_000)\n                .time_to_live(Duration::from_secs(60))\n                .time_to_idle(Duration::from_secs(20))\n                .build(),\n        }\n    }\n\n    /// get_with coalesces concurrent loads for the same key into one future,\n    /// so an expiring hot key produces one database query, not hundreds.\n    pub async fn get(\n        &self,\n        key: ProductKey,\n        load: impl std::future::Future<Output = Option<ProductView>>,\n    ) -> Option<ProductView> {\n        self.inner.get_with(key, load).await\n    }\n\n    /// Negative results are cached too: a missing id must not query on every request.\n    pub async fn invalidate(&self, key: ProductKey) {\n        self.inner.invalidate(&key).await;\n    }\n}",
          "tip": "time_to_idle protects memory from a long tail of keys that were read once; time_to_live bounds staleness. They answer different questions, so set both."
        },
        {
          "h": "Invalidation belongs on the write path",
          "p": [
            "Delete the key after the transaction commits, not before and not inside. Deleting inside a transaction that later rolls back leaves the cache empty for no reason; deleting before commit opens a window where a reader repopulates the cache from the pre-commit snapshot, and the stale value outlives the write that was supposed to invalidate it.",
            "With several instances, a local cache cannot be invalidated by deleting in one process. Either publish an invalidation message that every instance consumes, or accept a short TTL as the real invalidation mechanism and size it to the staleness budget. Say which one you chose; a cache that relies on a publish that can be dropped is a TTL cache with extra steps."
          ],
          "code": "pub async fn update_price(\n    pool: &sqlx::PgPool,\n    cache: &ProductCache,\n    key: ProductKey,\n    new_price: i64,\n) -> Result<(), sqlx::Error> {\n    let mut tx = pool.begin().await?;\n    sqlx::query(\"UPDATE products SET price_minor = $2 WHERE id = $1 AND tenant_id = $3\")\n        .bind(key.product)\n        .bind(new_price)\n        .bind(key.tenant)\n        .execute(&mut *tx)\n        .await?;\n    // Outbox row so the read model and other instances learn about the change.\n    sqlx::query(\n        \"INSERT INTO outbox (topic, payload) VALUES ('product.updated', jsonb_build_object('id', $1))\",\n    )\n    .bind(key.product)\n    .execute(&mut *tx)\n    .await?;\n    tx.commit().await?;\n\n    // After commit: the only correct ordering.\n    cache.invalidate(key).await;\n    Ok(())\n}",
          "tip": "If the invalidation must be reliable across instances, emit it through the outbox in the same transaction; a best-effort delete after commit is fine only when the TTL is the real bound."
        }
      ],
      "exercise": {
        "prompt": "A product page reads three things: product details, price, and stock. Give each a staleness budget, decide which to cache and where, and implement the cache for the one you keep with stampede protection and invalidation on write.",
        "starter": "struct ProductPage { details: ProductDetails, price: Price, stock: u32 }\n\n// TODO: budgets, cache keys, invalidation points, and what happens on a miss",
        "hint": "Details tolerate a minute, price tolerates seconds, stock should be read live or reserved transactionally. Cache details and price with a composite key including tenant and version; do not cache stock.",
        "solution": "#[derive(Clone, Copy, PartialEq, Eq, Hash)]\nstruct PageKey { tenant: uuid::Uuid, product: uuid::Uuid, version: u8 }\n\nconst CACHE_VERSION: u8 = 3; // bump to invalidate every entry after a shape change\n\nasync fn product_page(\n    pool: &sqlx::PgPool,\n    cache: &ProductCache,\n    tenant: uuid::Uuid,\n    product: uuid::Uuid,\n) -> anyhow::Result<ProductPage> {\n    let key = PageKey { tenant, product, version: CACHE_VERSION };\n\n    let details_and_price = cache\n        .inner\n        .get_with(key, async {\n            sqlx::query_as::<_, (String, String, i64)>(\n                \"SELECT title, description, price_minor FROM products\n                 WHERE tenant_id = $1 AND id = $2\",\n            )\n            .bind(tenant)\n            .bind(product)\n            .fetch_optional(pool)\n            .await\n            .ok()\n            .flatten()\n        })\n        .await\n        .ok_or_else(|| anyhow::anyhow!(\"product not found\"))?;\n\n    // Stock is not cached: the number must be true when the page renders.\n    let stock: i64 = sqlx::query_scalar(\n        \"SELECT available FROM stock WHERE tenant_id = $1 AND product_id = $2\",\n    )\n    .bind(tenant)\n    .bind(product)\n    .fetch_one(pool)\n    .await?;\n\n    Ok(ProductPage {\n        details: ProductDetails { title: details_and_price.0, description: details_and_price.1 },\n        price: Price { minor: details_and_price.2 },\n        stock: stock as u32,\n    })\n}\n\n// Invalidation: on title/description/price update, delete the composite key after commit;\n// on a schema change of the page shape, bump CACHE_VERSION instead of scanning keys."
      },
      "production": [
        "Each cached read path documents its staleness budget and the mechanism that enforces it (TTL, idle timeout, or explicit invalidation).",
        "Cache keys include tenant and a version component so a deploy can invalidate a whole class of entries without a scan.",
        "Concurrent loads for one key are coalesced, and TTLs carry jitter so hot keys do not expire together.",
        "Negative results have their own short TTL, and a later create deletes the negative entry.",
        "Invalidation happens after commit and its cross-instance delivery mechanism is stated explicitly, with TTL as the backstop."
      ],
      "crates": [
        "moka",
        "sqlx",
        "tokio",
        "serde"
      ],
      "github": [
        {
          "name": "moka-rs/moka",
          "url": "https://github.com/moka-rs/moka"
        },
        {
          "name": "launchbadge/sqlx",
          "url": "https://github.com/transact-rs/sqlx"
        }
      ],
      "pitfall": "A cache key that omits the tenant: two customers share an entry, and the first request after a deploy decides which customer sees the other product details.",
      "questions": [
        {
          "q": "What does moka get_with do that a plain get-then-insert does not?",
          "options": [
            "It makes the cache distributed across instances",
            "It coalesces concurrent loads for the same key so only one future runs",
            "It guarantees the value cannot be stale",
            "It invalidates dependent keys automatically"
          ],
          "answer": 1,
          "explain": "The single-flight behaviour is the point: on a miss under load, one loader runs and the others await its result, which is what prevents a stampede on a hot key."
        },
        {
          "q": "Why is invalidating the cache inside the write transaction dangerous?",
          "options": [
            "The cache call would block the transaction forever",
            "A reader can repopulate from the pre-commit snapshot and the stale value survives the write",
            "It always causes a deadlock with the database",
            "The cache library refuses calls inside a transaction"
          ],
          "answer": 1,
          "explain": "There is a window between the delete and the commit where a concurrent read refills the cache with the old row. Deleting after commit removes that window."
        },
        {
          "q": "Which read path should not be cached at all?",
          "options": [
            "A product description rendered on a catalog page",
            "A currency table that changes weekly",
            "An authorisation decision about the current user request",
            "A public category tree"
          ],
          "answer": 2,
          "explain": "Authorisation depends on the exact request and on revocation timing. Caching it turns a policy change or a revocation into a stale grant, which is a security incident."
        }
      ],
      "quickbytes": [
        "Set time_to_live for staleness and time_to_idle for memory; they are not the same knob.",
        "Include tenant and a version prefix in every key; bump the version to invalidate a class after a deploy.",
        "Cache negatives for seconds, not minutes, and delete them when the entity is created."
      ],
      "resources": [
        {
          "title": "docs.rs: moka caches, TinyLFU admission, TTL and TTI",
          "url": "https://docs.rs/moka/latest/moka/",
          "kind": "docs"
        },
        {
          "title": "The Tail at Scale: why tail latency makes caching and hedging necessary",
          "url": "https://research.google/pubs/the-tail-at-scale/",
          "kind": "paper"
        },
        {
          "title": "moka-rs/moka: cache policies and eviction implementation",
          "url": "https://github.com/moka-rs/moka",
          "kind": "repo"
        },
        {
          "title": "docs.rs: sqlx outbox insert in the same transaction as the write",
          "url": "https://docs.rs/sqlx/latest/sqlx/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "q14",
      "title": "Consistency boundaries: one transaction, one aggregate",
      "minutes": 95,
      "level": "industry",
      "goal": "Draw aggregate boundaries where an invariant must hold immediately, choose isolation and locking per query, and handle read-your-writes without lying to the user.",
      "sections": [
        {
          "h": "The aggregate is the transaction boundary",
          "p": [
            "An aggregate is the smallest set of objects that must be consistent at every instant. Invariants that must never be observed broken live inside it, and one business operation commits exactly one aggregate. Cross-aggregate consistency is eventual, expressed as an event or a saga, and the design work is deciding which invariants genuinely need instant consistency.",
            "Big aggregates are a trap. Making the customer aggregate include every order makes every order insert contend on one row, and optimistic versioning turns ordinary parallel checkout into a conflict storm. Split by the invariant that must hold, not by the object graph that looks tidy in a diagram."
          ],
          "list": [
            "Inside one aggregate: totals equal the sum of lines, status transitions are legal, balances never go negative",
            "Across aggregates: eventual, with an event and a compensating action",
            "A transaction spans one aggregate plus its outbox rows, never two aggregates",
            "If a use case needs two aggregates to agree instantly, the boundary is probably wrong"
          ],
          "tip": "Write the invariant as an assertion and find the smallest set of rows it reads. That set is the aggregate, not the diagram from the whiteboard."
        },
        {
          "h": "Isolation and locking are per-query decisions",
          "p": [
            "Postgres defaults to READ COMMITTED, where each statement sees a fresh snapshot. That is fine for single-statement writes but wrong for check-then-act: two sessions can both read a balance, both decide it is sufficient, and both write. The fix is to make the decision inside one statement, or to take an explicit lock on the rows involved.",
            "Prefer the atomic statement: UPDATE stock SET reserved = reserved + $2 WHERE sku = $1 AND available - reserved >= $2 RETURNING id tells you in one round trip whether the reservation succeeded, with no window at all. When the logic is too complex for one statement, SELECT ... FOR UPDATE the specific rows and keep the transaction short. Reach for SERIALIZABLE only for multi-row invariants, and be ready to retry on SQLSTATE 40001."
          ],
          "code": "/// One statement decides, reserves, and reports. No read-then-write window.\npub async fn reserve(\n    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,\n    sku: &str,\n    qty: i32,\n) -> Result<uuid::Uuid, ReserveError> {\n    let row = sqlx::query(\n        \"UPDATE stock\n            SET reserved = reserved + $2\n          WHERE sku = $1 AND available - reserved >= $2\n          RETURNING reservation_id\",\n    )\n    .bind(sku)\n    .bind(qty)\n    .fetch_optional(&mut **tx)\n    .await\n    .map_err(|e| ReserveError::Storage(e.to_string()))?;\n\n    row.map(|r| sqlx::Row::get(&r, \"reservation_id\"))\n        .ok_or(ReserveError::InsufficientStock)\n}\n\n/// The same transaction writes the aggregate and its outbox row.\npub async fn place_order(pool: &sqlx::PgPool, cmd: PlaceOrder) -> anyhow::Result<uuid::Uuid> {\n    let mut tx = pool.begin().await?;\n    let reservation = reserve(&mut tx, &cmd.sku, cmd.qty as i32).await?;\n\n    let order_id = uuid::Uuid::now_v7();\n    sqlx::query(\"INSERT INTO orders (id, sku, qty, reservation_id) VALUES ($1,$2,$3,$4)\")\n        .bind(order_id)\n        .bind(&cmd.sku)\n        .bind(cmd.qty as i32)\n        .bind(reservation)\n        .execute(&mut *tx)\n        .await?;\n\n    sqlx::query(\"INSERT INTO outbox (topic, payload) VALUES ('order.placed', $1)\")\n        .bind(serde_json::json!({ \"order_id\": order_id }))\n        .execute(&mut *tx)\n        .await?;\n\n    tx.commit().await?;\n    Ok(order_id)\n}",
          "tip": "If a transaction holds a row lock while making a network call, the lock lifetime is now bounded by the slowest third party. Never call out inside a transaction."
        },
        {
          "h": "Read-your-writes across replicas",
          "p": [
            "Once reads move to a replica, a user who just saved a change can reload and see the old value. That is not a rounding error to the user; it looks like the save failed, so they save again, which is how duplicate records appear in systems with correct idempotency and no consistency plan.",
            "Fix it deliberately. Route the first read after a write to the primary for a bounded window, or return the committed version with the write and let the read wait until the replica has caught up to that version. A sticky session without a version check only helps until the connection rebalances."
          ],
          "code": "/// Reads wait until the replica has applied at least the version the client saw.\npub async fn get_order_read_your_writes(\n    primary: &sqlx::PgPool,\n    replica: &sqlx::PgPool,\n    order_id: uuid::Uuid,\n    min_version: i64,\n) -> anyhow::Result<Option<OrderRow>> {\n    for attempt in 0..5 {\n        let row = sqlx::query_as::<_, OrderRow>(\n            \"SELECT id, status, version FROM orders WHERE id = $1\",\n        )\n        .bind(order_id)\n        .fetch_optional(replica)\n        .await?;\n\n        match row {\n            Some(row) if row.version >= min_version => return Ok(Some(row)),\n            _ if attempt == 4 => break,\n            _ => tokio::time::sleep(std::time::Duration::from_millis(20 * (attempt + 1))).await,\n        }\n    }\n\n    // Last resort: read the primary rather than showing stale data.\n    let row = sqlx::query_as::<_, OrderRow>(\n        \"SELECT id, status, version FROM orders WHERE id = $1\",\n    )\n    .bind(order_id)\n    .fetch_optional(primary)\n    .await?;\n    Ok(row)\n}",
          "tip": "Return the written version in the write response. Without it the client cannot tell the read path what it must wait for, and the fallback becomes guesswork."
        }
      ],
      "exercise": {
        "prompt": "A transfer moves money between two accounts. Decide the aggregate boundary, make the debit safe under concurrency, and explain what happens if the credit fails after the debit commits.",
        "starter": "// TODO: is a transfer one aggregate or two? Write the SQL that cannot overdraw.\n// TODO: what compensates a committed debit when the credit fails?",
        "hint": "Two accounts are two aggregates; a single UPDATE across both rows is a transaction, but the invariant \"balance never negative\" belongs to each account row. Use a conditional UPDATE per account in one transaction, or model a transfer aggregate with a ledger.",
        "solution": "-- Debit: the balance check lives in the WHERE clause, so no window exists.\nUPDATE accounts\n   SET balance_minor = balance_minor - $2\n WHERE id = $1 AND balance_minor >= $2\nRETURNING balance_minor;\n\n-- Credit in the same transaction; if it affects zero rows, roll the debit back.\nUPDATE accounts SET balance_minor = balance_minor + $2 WHERE id = $3;\n\n-- Both statements in one transaction: the invariant spans the pair for this operation,\n-- but the aggregate is each account row (its own balance is never negative).\n\n-- If the credit must happen later (external bank), the debit commits first and the\n-- saga compensates with a reverse entry, not with an UPDATE that erases history:\nINSERT INTO ledger (account_id, amount_minor, kind, transfer_id)\nVALUES ($1, $2, 'reversal', $3);\n\n-- Concurrency test: two debits of 60 from a balance of 100 must yield one success.\nlet a = debit(&pool, acct, 60).await;\nlet b = debit(&pool, acct, 60).await;\nassert_eq!([&a, &b].iter().filter(|r| r.is_ok()).count(), 1);\nlet balance: i64 = sqlx::query_scalar(\"SELECT balance_minor FROM accounts WHERE id = $1\")\n    .bind(acct).fetch_one(&pool).await?;\nassert_eq!(balance, 40);"
      },
      "production": [
        "Each transaction commits one aggregate plus its outbox rows; a test asserts no transaction touches two aggregate roots.",
        "Balance and stock decisions are expressed as conditional single statements, not read-then-write sequences.",
        "Row locks are held only for the duration of local statements; no network call happens inside a transaction.",
        "Writes return the committed version, and reads that must be fresh can wait for that version or fall back to the primary.",
        "Serializable transactions, where used, have a bounded retry loop keyed on SQLSTATE 40001 and a metric for retry rate."
      ],
      "crates": [
        "sqlx",
        "serde_json",
        "uuid",
        "tokio"
      ],
      "github": [
        {
          "name": "launchbadge/sqlx",
          "url": "https://github.com/transact-rs/sqlx"
        },
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        }
      ],
      "pitfall": "Reading a balance, checking it in Rust, then updating: two concurrent checkouts both pass the check and the balance goes negative, and the database was never asked whether the write was legal.",
      "questions": [
        {
          "q": "Why is UPDATE ... WHERE balance >= $2 RETURNING safer than SELECT then UPDATE?",
          "options": [
            "It uses fewer network round trips and therefore less lock contention, which is the whole guarantee",
            "The decision and the write happen in one statement, so no concurrent transaction can interleave between them",
            "It automatically retries on deadlock",
            "It places a table-level lock on the accounts table"
          ],
          "answer": 1,
          "explain": "The predicate is evaluated as part of the write against the current row version. There is no window for another session to change the row between check and write."
        },
        {
          "q": "What is the cost of making an aggregate too large?",
          "options": [
            "More tables and slower migrations",
            "Contention on a single row or version, turning parallel work into conflicts and retries",
            "The database cannot enforce foreign keys",
            "Events become impossible to publish"
          ],
          "answer": 1,
          "explain": "Every write to any part of a large aggregate contends on the same version or lock. Small aggregates let unrelated operations proceed in parallel."
        },
        {
          "q": "A user saves a change and immediately reloads through a replica. What is the standard mitigation?",
          "options": [
            "Increase the replica count",
            "Return the committed version and let the read wait for the replica to reach it, falling back to the primary",
            "Cache the write result in the replica",
            "Disable replicas for that endpoint permanently"
          ],
          "answer": 1,
          "explain": "Waiting on a version token is precise: it costs latency only when the replica is behind, and it preserves the guarantee the user expects."
        }
      ],
      "quickbytes": [
        "One transaction, one aggregate, plus its outbox rows. Anything more is a saga waiting to be discovered.",
        "Put the invariant in the WHERE clause; a conditional UPDATE is the cheapest lock in Postgres.",
        "Never make a network call while holding a row lock; the lock outlives your timeout and blocks everyone."
      ],
      "resources": [
        {
          "title": "PostgreSQL: transaction isolation levels and serialization failures",
          "url": "https://www.postgresql.org/docs/current/transaction-iso.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: SELECT ... FOR UPDATE and row locking clauses",
          "url": "https://www.postgresql.org/docs/current/sql-select.html",
          "kind": "docs"
        },
        {
          "title": "The Raft consensus paper: linearizable state machines under failure",
          "url": "https://raft.github.io/raft.pdf",
          "kind": "paper"
        },
        {
          "title": "docs.rs: sqlx transactions, isolation and retries",
          "url": "https://docs.rs/sqlx/latest/sqlx/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "q15",
      "title": "Contract-first APIs from Rust types",
      "minutes": 80,
      "level": "advanced",
      "goal": "Generate an OpenAPI document from Rust types, commit it as the reviewed contract, and use it to catch breaking wire changes before clients do.",
      "sections": [
        {
          "h": "Generate from code, review the artifact",
          "p": [
            "A contract that lives only in prose drifts on the first refactor. Derive it from the types instead: utoipa 6 generates an OpenAPI 3.1 document from structs and handlers, so a field rename, a new required property, or a changed error type appears in the generated file. The generation is code-first; the discipline is spec-first.",
            "Commit the generated openapi.json and diff it in CI. That single artifact gives clients something stable to build against, makes wire changes visible in review, and lets you answer what changed in the last release without reading the diff of twenty files. A generated spec that is never committed is documentation, not a contract."
          ],
          "list": [
            "The spec is generated, committed, and diffed; an unexplained diff fails review",
            "DTOs are separate types from domain aggregates, so the wire shape can evolve independently",
            "Every response type appears in the spec, including error shapes",
            "A breaking change requires a new version, not a note in a changelog"
          ],
          "tip": "Keep DTOs in the adapter crate. If the OpenAPI types are the domain types, every schema decision becomes a domain refactor."
        },
        {
          "h": "Evolution rules that keep clients compiling",
          "p": [
            "Safe changes are additive: a new optional field, a new endpoint, a new error code that clients are told to ignore if unknown. Breaking changes remove or rename a field, change a type, tighten validation, make an optional field required, or repurpose an existing code. The last one is the most common accident because it passes every compile check.",
            "Two rules prevent most incidents. Treat unknown enum values as forward compatible on the client, and document that requirement in the spec description rather than assuming it. And never reuse a name for a different meaning in the same version: a field called status that switches from a string to an object breaks every generated client at once."
          ],
          "code": "use utoipa::{OpenApi, ToSchema};\n\n#[derive(serde::Deserialize, ToSchema)]\n#[schema(example = json!({\"sku\": \"sku-1\", \"quantity\": 2}))]\npub struct PlaceOrderRequest {\n    pub sku: String,\n    #[schema(minimum = 1, maximum = 100)]\n    pub quantity: u32,\n    /// Optional; defaults to EUR. Adding optional fields is a safe change.\n    pub currency: Option<String>,\n}\n\n#[derive(serde::Serialize, ToSchema)]\npub struct OrderResponse {\n    pub id: uuid::Uuid,\n    pub status: OrderStatus,\n}\n\n#[derive(serde::Serialize, ToSchema)]\n#[serde(rename_all = \"snake_case\")]\npub enum OrderStatus {\n    Placed,\n    Cancelled,\n}\n\n#[utoipa::path(\n    post,\n    path = \"/v1/orders\",\n    request_body = PlaceOrderRequest,\n    responses(\n        (status = 201, description = \"Order accepted\", body = OrderResponse),\n        (status = 409, description = \"Idempotency key reused with a different body\", body = Problem),\n        (status = 422, description = \"Validation failed\", body = Problem),\n    )\n)]\npub async fn place_order(/* ... */) {}\n\n#[derive(OpenApi)]\n#[openapi(paths(place_order), components(schemas(PlaceOrderRequest, OrderResponse, OrderStatus, Problem)))]\npub struct ApiDoc;",
          "tip": "Keep the example in the schema: it is the fastest way for a client author to see the intended shape, and it fails review when it stops matching."
        },
        {
          "h": "Errors are part of the contract",
          "p": [
            "Clients do not branch on prose, they branch on codes. Return a stable problem document (RFC 9457 style) with type, title, status, code, and detail, and enumerate code as a schema enum so adding a new one shows up as a spec diff rather than a surprise in production.",
            "The rule that saves the most support time: never change the meaning of an existing code, and never put variable content in a code. For example, use order_not_found with the id in detail, not order_42_not_found. Clients that switch on the code keep working; dashboards group correctly; and alerts can key on a stable value."
          ],
          "code": "use axum::{http::StatusCode, response::{IntoResponse, Response}, Json};\nuse serde::Serialize;\nuse utoipa::ToSchema;\n\n#[derive(Serialize, ToSchema)]\n#[serde(rename_all = \"snake_case\")]\npub enum ErrorCode {\n    ValidationFailed,\n    OrderNotFound,\n    IdempotencyKeyReuse,\n    RateLimited,\n}\n\n#[derive(Serialize, ToSchema)]\npub struct Problem {\n    /// Stable URI identifying the problem type.\n    pub r#type: String,\n    pub title: String,\n    pub status: u16,\n    pub code: ErrorCode,\n    pub detail: String,\n}\n\n#[derive(Debug, thiserror::Error)]\npub enum ApiError {\n    #[error(\"order {0} not found\")]\n    OrderNotFound(uuid::Uuid),\n    #[error(\"idempotency key reused with a different body\")]\n    KeyReuse,\n}\n\nimpl IntoResponse for ApiError {\n    fn into_response(self) -> Response {\n        let (status, code, detail) = match self {\n            ApiError::OrderNotFound(id) => (\n                StatusCode::NOT_FOUND,\n                ErrorCode::OrderNotFound,\n                format!(\"no order with id {id}\"),\n            ),\n            ApiError::KeyReuse => (\n                StatusCode::CONFLICT,\n                ErrorCode::IdempotencyKeyReuse,\n                \"the same Idempotency-Key was used with a different request body\".to_owned(),\n            ),\n        };\n        let body = Problem {\n            r#type: format!(\"https://errors.example.com/{}\", code_tag(&code)),\n            title: status.canonical_reason().unwrap_or(\"error\").to_owned(),\n            status: status.as_u16(),\n            code,\n            detail,\n        };\n        (status, Json(body)).into_response()\n    }\n}\n\nfn code_tag(code: &ErrorCode) -> &'static str {\n    match code {\n        ErrorCode::ValidationFailed => \"validation_failed\",\n        ErrorCode::OrderNotFound => \"order_not_found\",\n        ErrorCode::IdempotencyKeyReuse => \"idempotency_key_reuse\",\n        ErrorCode::RateLimited => \"rate_limited\",\n    }\n}",
          "tip": "Add a test that serializes every API error variant and asserts the code string; renaming a variant then breaks a test instead of a client integration."
        }
      ],
      "exercise": {
        "prompt": "Given a handler that returns an order, add a utoipa schema and path, generate openapi.json from a small binary, and add a CI step that fails when the committed spec differs from the generated one.",
        "starter": "// TODO: derive ToSchema for the request/response, annotate the path,\n// TODO: add src/bin/dump_openapi.rs and a CI diff step.",
        "hint": "The binary prints ApiDoc::openapi().to_pretty_json() to stdout. Redirect it to openapi.json, then run git diff --exit-code openapi.json in CI so any uncommitted wire change fails the build.",
        "solution": "// src/bin/dump_openapi.rs\nuse api::ApiDoc;\nuse utoipa::OpenApi;\n\nfn main() {\n    println!(\"{}\", ApiDoc::openapi().to_pretty_json().expect(\"serializable\"));\n}\n\n# CI step\ncargo run --quiet --bin dump_openapi > /tmp/openapi.json\ndiff -u openapi.json /tmp/openapi.json\n# exit code 1 on any difference, so a wire change must be committed and reviewed\n\n// The diff is the review artifact: a removed field or a new required property\n// is visible as a one-line change instead of hiding in a derive."
      },
      "production": [
        "openapi.json is generated by a dedicated binary, committed, and diffed in CI; an uncommitted wire change fails the build.",
        "Request and response DTOs live in the adapter layer and are distinct types from domain aggregates.",
        "Every error response uses one problem document shape with an enumerated code, and codes never change meaning.",
        "Unknown enum values are tolerated by clients, and that requirement is documented in the spec description.",
        "Removing or renaming a field requires a new API version plus a deprecation window, not a changelog note."
      ],
      "crates": [
        "utoipa",
        "serde",
        "axum",
        "schemars"
      ],
      "github": [
        {
          "name": "juhaku/utoipa",
          "url": "https://github.com/juhaku/utoipa"
        },
        {
          "name": "OAI/OpenAPI-Specification",
          "url": "https://github.com/OAI/OpenAPI-Specification"
        }
      ],
      "pitfall": "Deriving the OpenAPI schema directly from the domain aggregate: a database-driven refactor silently changes the public wire format, and the generated spec is the last place anyone looks.",
      "questions": [
        {
          "q": "Which change is safe inside an existing API version?",
          "options": [
            "Renaming a response field to match internal naming",
            "Adding a new optional request field with a documented default",
            "Making an optional request field required",
            "Changing an integer field to a string to allow leading zeros"
          ],
          "answer": 1,
          "explain": "Additive optional fields do not break existing clients. Renames, type changes, and tightened requirements all change the bytes or the accepted set."
        },
        {
          "q": "Why commit the generated OpenAPI document instead of generating it on demand?",
          "options": [
            "Because generation is slow at runtime",
            "Because the diff makes wire changes reviewable and gives clients a stable artifact to build against",
            "Because utoipa can only run in a binary",
            "Because the spec cannot be serialized to JSON otherwise"
          ],
          "answer": 1,
          "explain": "A committed spec is a contract with history. The diff is the review, and clients can pin a version rather than chasing a moving endpoint."
        },
        {
          "q": "What is wrong with an error code such as order_42_not_found?",
          "options": [
            "It is too long for a log line",
            "It embeds variable data, so clients cannot switch on it and dashboards cannot group it",
            "It breaks JSON serialization",
            "It leaks the order id, which is a security issue"
          ],
          "answer": 1,
          "explain": "Codes must be a small stable set. Variable content belongs in detail, where it can be read without affecting program logic."
        }
      ],
      "quickbytes": [
        "Dump the spec in CI and diff it; a generated document nobody commits is just documentation.",
        "Keep DTOs separate from aggregates so the wire format is a deliberate choice.",
        "Enumerate error codes and never rename one; clients switch on strings they cannot recompile."
      ],
      "resources": [
        {
          "title": "docs.rs: utoipa 6 OpenAPI 3.1 generation from Rust types",
          "url": "https://docs.rs/utoipa/latest/utoipa/",
          "kind": "docs"
        },
        {
          "title": "OpenAPI Specification repository: versions and change rules",
          "url": "https://github.com/OAI/OpenAPI-Specification",
          "kind": "repo"
        },
        {
          "title": "docs.rs: schemars for JSON Schema generation from Rust",
          "url": "https://docs.rs/schemars/latest/schemars/",
          "kind": "docs"
        },
        {
          "title": "docs.rs: axum IntoResponse for problem-document error mapping",
          "url": "https://docs.rs/axum/latest/axum/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "q16",
      "title": "API versioning and a deprecation you can measure",
      "minutes": 75,
      "level": "advanced",
      "goal": "Choose a versioning mechanism by its operational cost, run two versions from one binary, and retire a version only when telemetry proves nobody calls it.",
      "sections": [
        {
          "h": "Three mechanisms, three bills",
          "p": [
            "A URL prefix such as /v1 is explicit, routable at the edge, visible in logs and dashboards, and trivial to cache. It also bakes the version into every client and tempts big-bang rewrites: the moment v2 exists, the pressure is to move everything rather than to evolve v1 additively. For public HTTP APIs the visibility usually wins.",
            "A custom header or media type keeps URLs stable and allows per-field negotiation, which is elegant and expensive: routing needs a header match, access logs need the header copied, and every cache key must vary on it. Use header versioning when the transport already supports it well, such as internal gRPC packages, and pick one mechanism rather than a mixture nobody can describe."
          ],
          "list": [
            "Public HTTP: major version in the path, additive changes inside it",
            "Internal RPC: version in the package name, so two packages coexist without routing tricks",
            "One mechanism per surface; a header version and a path version together is a support ticket generator",
            "Never version per endpoint; a version is a whole surface contract"
          ],
          "tip": "Version the surface, not the route. Per-endpoint versions produce a matrix of combinations nobody can test."
        },
        {
          "h": "Two versions, one domain",
          "p": [
            "A new version is an adapter, not a fork. Keep the domain and use cases shared, and give each version its own DTOs and handlers that map into the same commands. That keeps fixes flowing to both versions and makes the diff between v1 and v2 exactly the wire shape, which is what reviewers need to see.",
            "Mount each version as a nested router so middleware can differ without duplicating the policy stack. The version boundary is also the natural place for version-specific metrics, which is what lets you say with a number whether a version is still in use rather than asking the biggest customer what they think."
          ],
          "code": "use axum::{Router, routing::{get, post}};\n\npub fn app(state: AppState) -> Router {\n    let v1 = Router::new()\n        .route(\"/orders\", post(v1::place_order))\n        .route(\"/orders/{id}\", get(v1::get_order))\n        // v1 marks the endpoint deprecated but keeps serving it.\n        .layer(axum::middleware::from_fn(deprecation_notice));\n\n    let v2 = Router::new()\n        .route(\"/orders\", post(v2::place_order))\n        .route(\"/orders/{id}\", get(v2::get_order));\n\n    Router::new()\n        .nest(\"/v1\", v1)\n        .nest(\"/v2\", v2)\n        .with_state(state)\n}\n\n/// RFC 8594 Sunset plus the IETF httpapi Deprecation field.\nasync fn deprecation_notice(req: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {\n    let mut response = next.run(req).await;\n    let headers = response.headers_mut();\n    headers.insert(\"deprecation\", \"Fri, 01 May 2026 00:00:00 GMT\".parse().unwrap());\n    headers.insert(\"sunset\", \"Sat, 01 Aug 2026 00:00:00 GMT\".parse().unwrap());\n    headers.insert(\"link\", \"</v2/orders>; rel=\\\"successor-version\\\"\".parse().unwrap());\n    response\n}",
          "tip": "Return Sunset as an HTTP date, not a duration; clients and proxies parse dates, and a date is unambiguous across time zones."
        },
        {
          "h": "Retire on evidence, not on a deadline",
          "p": [
            "Deprecation is a campaign with telemetry: label request counts by version and by client id, publish the sunset date, watch usage fall, then remove. Without per-version metrics the removal is a guess, and the guess is usually wrong for one integration that runs quarterly.",
            "Give a support window you can defend, commonly one major version and six to twelve months, and keep the old version inside the same deploy so a fix ships to both. When usage reaches zero and stays there through a full business cycle, delete the adapter, the DTOs, and the tests in one commit with the metrics attached."
          ],
          "code": "// Metrics label per version: this is the evidence that a version is unused.\nuse std::sync::atomic::{AtomicU64, Ordering};\n\npub struct VersionUsage {\n    v1_requests: AtomicU64,\n    v2_requests: AtomicU64,\n}\n\nimpl VersionUsage {\n    pub fn record(&self, version: u8) {\n        match version {\n            1 => self.v1_requests.fetch_add(1, Ordering::Relaxed),\n            _ => self.v2_requests.fetch_add(1, Ordering::Relaxed),\n        };\n    }\n\n    /// Read by the retirement decision, not by a guess.\n    pub fn v1_total(&self) -> u64 {\n        self.v1_requests.load(Ordering::Relaxed)\n    }\n}",
          "tip": "Break usage down by client id, not just by version: one integration can be 80 percent of v1 traffic and it will not read your changelog."
        }
      ],
      "exercise": {
        "prompt": "Add a v2 endpoint that renames total to total_minor and returns currency as an object, keep v1 working from the same use case, and add deprecation headers plus a per-version counter. Explain when you would delete v1.",
        "starter": "// v1: { \"total\": 4200, \"currency\": \"EUR\" }\n// v2: { \"total\": { \"amount_minor\": 4200, \"currency\": \"EUR\" } }\n\n// TODO: two DTOs, one use case, two handlers, nested routers, deprecation headers.",
        "hint": "Both handlers call the same PlaceOrder use case and map its result into their own DTO. Delete v1 only when its counter is flat at zero across a full quarter and the largest client has confirmed the migration in writing.",
        "solution": "#[derive(serde::Serialize)]\nstruct OrderV1 { id: uuid::Uuid, total: i64, currency: String }\n\n#[derive(serde::Serialize)]\nstruct MoneyV2 { amount_minor: i64, currency: String }\n#[derive(serde::Serialize)]\nstruct OrderV2 { id: uuid::Uuid, total: MoneyV2 }\n\nasync fn v1_get_order(\n    State(uc): State<std::sync::Arc<GetOrder>>,\n    Path(id): Path<uuid::Uuid>,\n) -> Result<Json<OrderV1>, ApiError> {\n    let order = uc.execute(id).await?;\n    Ok(Json(OrderV1 {\n        id: order.id,\n        total: order.total_minor,\n        currency: order.currency.to_string(),\n    }))\n}\n\nasync fn v2_get_order(\n    State(uc): State<std::sync::Arc<GetOrder>>,\n    Path(id): Path<uuid::Uuid>,\n) -> Result<Json<OrderV2>, ApiError> {\n    let order = uc.execute(id).await?;\n    Ok(Json(OrderV2 {\n        id: order.id,\n        total: MoneyV2 { amount_minor: order.total_minor, currency: order.currency.to_string() },\n    }))\n}\n\n// Retirement criteria, written down before v2 ships:\n// 1. v1 request counter is zero for 90 consecutive days.\n// 2. No client id appears in v1 logs for 30 days.\n// 3. The largest integration confirms in writing that it calls v2 in production.\n// 4. The v1 adapter, DTOs, tests and docs are deleted in one commit."
      },
      "production": [
        "One versioning mechanism per surface, documented, with a support window stated in the API docs.",
        "Deprecated versions carry Sunset and Deprecation headers plus a successor link, and those headers are tested.",
        "Request counts are labelled by version and client id, and the retirement decision cites that data.",
        "Two versions share the domain and use cases; only DTOs and handlers differ.",
        "Removing a version deletes its adapters, DTOs, tests, and docs in a single reviewed commit."
      ],
      "crates": [
        "axum",
        "tower",
        "serde",
        "utoipa"
      ],
      "github": [
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        },
        {
          "name": "juhaku/utoipa",
          "url": "https://github.com/juhaku/utoipa"
        }
      ],
      "pitfall": "A header-based version that is not part of the cache key: the CDN serves v1 responses to v2 clients, and the bug looks like data corruption rather than routing.",
      "questions": [
        {
          "q": "What is the main operational advantage of a path version over a header version?",
          "options": [
            "It allows finer-grained negotiation per field",
            "It is visible and routable in logs, metrics, and cache keys without extra configuration",
            "It is the only mechanism allowed by OpenAPI",
            "It removes the need for a deprecation process"
          ],
          "answer": 1,
          "explain": "Path versions are observable by default. Header versions need every layer, including the CDN and the access log, to be taught about the header."
        },
        {
          "q": "Why mount versions as nested routers instead of duplicating each handler with an if on the version?",
          "options": [
            "Nested routers are faster at runtime",
            "Each version gets its own DTOs, middleware, and metrics while sharing the use cases",
            "axum cannot route on headers",
            "It avoids the need for tests"
          ],
          "answer": 1,
          "explain": "Nesting makes the version boundary a structural boundary. Branching inside a handler mixes two contracts in one function and makes the deprecation diff unreadable."
        },
        {
          "q": "When is it safe to delete a deprecated version?",
          "options": [
            "Immediately after the sunset date passes",
            "When per-version telemetry shows zero traffic through a full business cycle and the remaining clients have confirmed migration",
            "After the changelog announces it",
            "When the code becomes hard to maintain"
          ],
          "answer": 1,
          "explain": "A date is a promise, not evidence. Quarterly integrations can be silent for months, so removal needs measured absence plus explicit confirmation."
        }
      ],
      "quickbytes": [
        "Sunset headers take an HTTP date; clients and proxies cannot agree on a relative duration.",
        "One versioning mechanism per surface; mixing path and header versions multiplies the test matrix.",
        "Label metrics by version and client id; retire on measured zero, not on the calendar."
      ],
      "resources": [
        {
          "title": "docs.rs: axum nested routers and middleware",
          "url": "https://docs.rs/axum/latest/axum/",
          "kind": "docs"
        },
        {
          "title": "docs.rs: utoipa generating a spec per version",
          "url": "https://docs.rs/utoipa/latest/utoipa/",
          "kind": "docs"
        },
        {
          "title": "OpenAPI Specification: versioning guidance in the spec repository",
          "url": "https://github.com/OAI/OpenAPI-Specification",
          "kind": "repo"
        },
        {
          "title": "Semantic Versioning: what major, minor and patch mean for a contract",
          "url": "https://github.com/semver/semver",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "q17",
      "title": "Capacity planning with Little law",
      "minutes": 90,
      "level": "industry",
      "goal": "Derive concurrency, pool size and limits from throughput and latency, then verify the model with a load test at twice the expected peak.",
      "sections": [
        {
          "h": "Concurrency is a computed number",
          "p": [
            "Little law says the average number of items in a system equals arrival rate times time in system: L = lambda times W. At 300 requests per second and 120 ms per request, 36 requests are in flight on average. That single number sizes the connection pool, the worker concurrency, and the limit you put in front of the service.",
            "The average hides the tail, which is where capacity actually runs out. If the p99 is 900 ms and traffic is bursty, the in-flight count during a burst is far above 36, and the pool queue becomes the latency. Plan with the p99 in-flight estimate and a headroom factor, then confirm with a load test rather than trusting the arithmetic."
          ],
          "list": [
            "In-flight average: requests per second x average latency in seconds",
            "In-flight at p99: requests per second x p99 latency, which is the number that fills the pool",
            "Pool connections must be at least the in-flight estimate for the database portion of a request",
            "Keep utilisation under about 70 percent; queueing delay grows sharply above it"
          ],
          "tip": "Compute both numbers and design for the p99 one. A pool sized to the average is a pool that queues during every incident."
        },
        {
          "h": "Limits are capacity decisions, not safety rails",
          "p": [
            "A concurrency limit is the maximum number of requests the service will admit at once. Set it below the pool size, so requests queue in one place with one timeout, rather than waiting invisibly on a database connection. When the limit is reached, the correct behaviour is a fast 503 with Retry-After, not an unbounded queue that converts overload into timeouts and client retries.",
            "Postgres has a hard ceiling on connections, and each one costs memory on the server. A pool of 32 per instance times 20 instances is 640 connections, which many instances of a managed database will refuse. Use a pooler for many small services, keep transactions short, and remember that a connection held while waiting on a third-party call is a connection unavailable for real work."
          ],
          "code": "use std::time::Duration;\nuse tower::ServiceBuilder;\nuse tower::limit::ConcurrencyLimitLayer;\nuse tower_http::timeout::TimeoutLayer;\n\n/// Numbers from the model, not from a feeling.\npub struct Capacity {\n    pub target_rps: f64,\n    pub p99_seconds: f64,\n    pub headroom: f64,\n}\n\nimpl Capacity {\n    /// Requests in flight at p99, with headroom.\n    pub fn in_flight(&self) -> f64 {\n        self.target_rps * self.p99_seconds * self.headroom\n    }\n\n    /// Pool size: only the fraction of a request that touches the database counts.\n    pub fn pool_size(&self, db_fraction: f64) -> u32 {\n        (self.in_flight() * db_fraction).ceil().max(4.0) as u32\n    }\n}\n\n#[test]\nfn checkout_capacity_model() {\n    let capacity = Capacity { target_rps: 300.0, p99_seconds: 0.9, headroom: 2.0 };\n    // 300 rps x 0.9 s x 2 = 540 in flight at p99 under headroom.\n    assert_eq!(capacity.in_flight(), 540.0);\n    // 60 percent of a checkout request talks to Postgres: 324 connections is far\n    // too many for one instance, which is the signal to add a pooler or split reads.\n    assert_eq!(capacity.pool_size(0.6), 324);\n}\n\npub fn layers() -> impl tower::Layer<axum::routing::Route> + Clone {\n    ServiceBuilder::new()\n        .layer(ConcurrencyLimitLayer::new(256)) // queue at the edge, one timeout\n        .layer(TimeoutLayer::new(Duration::from_millis(1_500)))\n}",
          "tip": "If the computed pool size exceeds what the database allows, the answer is not a bigger pool; it is fewer round trips, a pooler, or a read replica."
        },
        {
          "h": "Load test, then model growth",
          "p": [
            "A model without a measurement is a hypothesis. Run a load test at the expected peak, then at twice the peak, and record throughput, p99, error rate, and database connection wait time. The point of the second run is not to pass; it is to see whether overload produces fast failures or a slow collapse.",
            "Keep the test reproducible: same instance size, same data volume, same query mix, and a fixed duration long enough for caches and pools to reach steady state. Then write the numbers into the repository next to the limits, so the next person changing a pool size knows which experiment produced the current one."
          ],
          "code": "# Find the sustainable rate at a 300 ms p99 target, then push to 2x.\noha -z 5m -c 200 --latency-correction https://api.example.com/v1/orders\n\n# Read the shape, not just the average: p50, p99, and the error breakdown.\n# Then check the database side while it runs:\npsql -c \"SELECT state, count(*) FROM pg_stat_activity GROUP BY state;\"\npsql -c \"SELECT wait_event_type, wait_event, count(*) FROM pg_stat_activity GROUP BY 1,2;\"\n\n# Capacity record kept in the repo (docs/capacity.md):\n# 2026-10-14  c7g.2xlarge, 32 pool, 256 concurrency\n#   300 rps -> p50 40 ms, p99 210 ms, 0 errors\n#   600 rps -> p50 65 ms, p99 480 ms, 0.4% 503 (concurrency limit), db wait 12%\n#   first bottleneck: pool queue at 640 rps, not CPU",
          "tip": "Record the first bottleneck in the capacity note. It tells the next person which limit to raise and which one will immediately become the problem."
        }
      ],
      "exercise": {
        "prompt": "A checkout service must handle 200 rps with a 400 ms p99, and 45 percent of a request spends time in Postgres. Compute in-flight at 2x headroom, choose a concurrency limit and pool size, then write the load-test command that would falsify the model.",
        "starter": "// 200 rps * 0.4 s * 2 = ?\n// db share 0.45\n// TODO: choose limit and pool, and the falsifying experiment",
        "hint": "In-flight at p99 with headroom is 160. Put the concurrency limit above that (192) and the pool at the database share (72), then test at 400 rps and watch connection wait, not only latency.",
        "solution": "let capacity = Capacity { target_rps: 200.0, p99_seconds: 0.4, headroom: 2.0 };\nassert_eq!(capacity.in_flight(), 160.0);      // 200 * 0.4 * 2\nassert_eq!(capacity.pool_size(0.45), 72);     // 160 * 0.45 rounded up\n\n// Concurrency limit 192: above the modelled in-flight, below the point where\n// the queue dominates the latency budget.\n// Pool 72: the database share of 160 in-flight, rounded up.\n//\n// Falsifying experiment: 400 rps for 5 minutes with 200 connections.\n// Expectations if the model holds: p99 under 400 ms, no 503 until 192 in flight,\n// pg_stat_activity shows at most 72 active connections and little lock wait.\n// If p99 crosses the SLO at 250 rps, the model is wrong: re-measure latency\n// per query and check whether the pool queue, not the database, is the limit."
      },
      "production": [
        "The service has a documented capacity model: target rps, p99, headroom, computed in-flight, pool size, and concurrency limit.",
        "Concurrency limits sit below the pool size so overload queues in one place and fails fast with 503 and Retry-After.",
        "A load test at twice the expected peak is part of the release checklist, and its numbers are committed with the limits.",
        "Database connection totals across all instances stay under the server limit, with a pooler where they do not.",
        "Connection wait time and pool saturation are alerted on, not just request latency."
      ],
      "crates": [
        "tower",
        "tower-http",
        "axum",
        "sqlx"
      ],
      "github": [
        {
          "name": "hatoo/oha",
          "url": "https://github.com/hatoo/oha"
        },
        {
          "name": "tower-rs/tower",
          "url": "https://github.com/tower-rs/tower"
        }
      ],
      "pitfall": "Sizing the pool to the average in-flight count: the pool looks fine at 300 rps and becomes the entire p99 at 500, and the fix is blamed on the database.",
      "questions": [
        {
          "q": "With 200 requests per second and a 400 ms p99, what is the in-flight count before headroom?",
          "options": [
            "8",
            "80",
            "200",
            "500"
          ],
          "answer": 1,
          "explain": "L = lambda times W = 200 x 0.4 = 80 requests in flight at p99. Adding a 2x headroom gives 160."
        },
        {
          "q": "Why set the concurrency limit below the database pool size?",
          "options": [
            "Because Postgres rejects connections above 100",
            "So excess requests queue in one place with one timeout rather than waiting invisibly for a connection",
            "Because tower cannot limit concurrency above the pool size",
            "To make the p50 latency lower"
          ],
          "answer": 1,
          "explain": "Two queues with different timeouts are impossible to reason about. One admission queue with a fast 503 gives predictable behaviour under overload."
        },
        {
          "q": "What is the purpose of load testing at twice the expected peak?",
          "options": [
            "To prove the service can run at that rate",
            "To observe whether overload degrades into fast failures or a slow collapse that multiplies retries",
            "To satisfy a compliance requirement",
            "To choose the database instance size"
          ],
          "answer": 1,
          "explain": "Overload behaviour is a design property. Fast rejection is recoverable; timeouts and retries create a feedback loop that takes the service down."
        }
      ],
      "quickbytes": [
        "L = lambda x W: 300 rps at 120 ms is 36 in flight, and the p99 number is the one that sizes the pool.",
        "Keep utilisation near 70 percent; p99 grows faster than linearly above it.",
        "Count total connections across instances against the database limit before adding replicas."
      ],
      "resources": [
        {
          "title": "The Tail at Scale: tail latency and why averages mislead capacity plans",
          "url": "https://research.google/pubs/the-tail-at-scale/",
          "kind": "paper"
        },
        {
          "title": "docs.rs: tower ConcurrencyLimit and timeouts",
          "url": "https://docs.rs/tower/latest/tower/",
          "kind": "docs"
        },
        {
          "title": "hatoo/oha: HTTP load generator used for the falsifying experiment",
          "url": "https://github.com/hatoo/oha",
          "kind": "repo"
        },
        {
          "title": "docs.rs: sqlx pool sizing and acquire timeouts",
          "url": "https://docs.rs/sqlx/latest/sqlx/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "q18",
      "title": "Architecture decision records that get read",
      "minutes": 60,
      "level": "core",
      "goal": "Record one decision per file with the options you rejected, keep the status lifecycle honest, and make the archive checkable in CI.",
      "sections": [
        {
          "h": "A decision record, not a design document",
          "p": [
            "An ADR records one decision, the forces that made it necessary, the options considered, and the consequences accepted. It is not a design document and not meeting minutes. Two pages is already long. The audience is the engineer who asks in eighteen months why this boundary exists, and the reviewer who wants to know what was rejected and why.",
            "Write one when a decision is expensive to reverse, crosses team boundaries, or will be cited in reviews: technology choices, service boundaries, consistency models, security trade-offs, and deliberate deviations from the platform standard. Routine implementation choices do not need a record; an archive of forty trivial ADRs is as useless as none."
          ],
          "list": [
            "One decision per record, with the alternatives and why they lost",
            "Consequences include the bad ones; an ADR with no downside is marketing",
            "Accepted records are immutable; a reversal is a new record that supersedes the old one",
            "Link every record to the code it governs, and the code back to the record"
          ],
          "tip": "If you cannot name the alternative you rejected, you have written a justification, not a decision record."
        },
        {
          "h": "MADR structure and an honest status",
          "p": [
            "MADR 4.0.0 provides a skeleton that fits in a page: front matter with status and date, Context and Problem Statement, Decision Drivers, Considered Options, Decision Outcome with justification, and Consequences. The statuses are proposed, accepted, rejected, deprecated, and superseded, and the last two are how history stays readable instead of being rewritten.",
            "Tooling keeps the format consistent. The adrs crate 0.13 initialises a decision log, creates numbered records in Nygard or MADR format, lists, links and supersedes them, and runs a doctor health check. It stays adr-tools compatible, so an existing doc/adr directory with plain markdown keeps working while the team migrates."
          ],
          "code": "# 0007-isolate-tenants-with-row-level-security.md\n---\nstatus: accepted\ndate: 2026-09-14\ndeciders: platform, data\nconsulted: security\n---\n\n# Isolate tenants with row-level security\n\n## Context and Problem Statement\n\nTenants share one Postgres schema. Two incidents traced to a missing\ntenant filter in a reporting query. Separate databases per tenant would\nremove the class of bug but multiply migration work and cost for 4,000\nsmall accounts.\n\n## Decision Drivers\n\n- A missing filter must not become a data breach\n- Migrations must stay a single run for the default tier\n- Large accounts may be promoted to dedicated databases later\n\n## Considered Options\n\n1. Application-level filter only\n2. Shared schema with RLS enforced by policy\n3. Database per tenant\n\n## Decision Outcome\n\nChosen: option 2. Every tenant table carries tenant_id, RLS is enabled and\nforced, and the tenant is set per transaction from the verified token.\n\n## Consequences\n\n- Good: a forgotten filter returns zero rows instead of another tenant rows\n- Bad: every query pays for an extra predicate; policies must be reviewed in migrations\n- Bad: the table owner bypasses RLS, so tests must connect as the app role\n\n## Links\n\n- Supersedes: none\n- Related: ADR-0003 (tenant identity from tokens)",
          "tip": "Put the bad consequences in the record. They are what a future reader needs when deciding whether the decision still holds."
        },
        {
          "h": "Make the archive checkable",
          "p": [
            "An archive decays unless CI reads it. Check that every record has a status and a date, that numbers are unique, and that a superseded record names its successor. The adrs doctor command covers the structural rules the tool knows about; a small xtask covers the checks specific to your template, and both belong in the pull request pipeline.",
            "Reference records from code so the reasoning is one hop away: a comment such as // see ADR-0007 next to the RLS helper turns a mysterious predicate into a documented decision. Link in the other direction as well, from the record to the crate or migration it produced, so a reader can see the decision and its implementation together."
          ],
          "code": "// Local workflow\n// adrs init                      # creates doc/adr with a template\n// adrs new \"Isolate tenants with row-level security\"\n// adrs new --format madr \"Use outbox for cross-context events\"\n// adrs list --status proposed    # review queue\n// adrs doctor                    # structural checks\n//\n// CI-specific rules live in a small xtask:\n// cargo run -p xtask -- adr-check\n// xtask/src/main.rs\nuse anyhow::{bail, Context, Result};\nuse std::{collections::HashSet, fs};\n\nfn main() -> Result<()> {\n    let mut seen = HashSet::new();\n    for entry in fs::read_dir(\"doc/adr\").context(\"doc/adr missing\")? {\n        let path = entry?.path();\n        if path.extension().and_then(|e| e.to_str()) != Some(\"md\") {\n            continue;\n        }\n        let name = path.file_name().unwrap().to_string_lossy().to_string();\n        let number = name.split('-').next().unwrap_or_default().to_owned();\n        if !seen.insert(number.clone()) {\n            bail!(\"duplicate ADR number {number} in {name}\");\n        }\n        let body = fs::read_to_string(&path)?;\n        let head = body.split(\"---\").nth(1).unwrap_or_default();\n        for key in [\"status:\", \"date:\"] {\n            if !head.contains(key) {\n                bail!(\"{name}: front matter missing {key}\");\n            }\n        }\n        if head.contains(\"status: superseded\") && !body.contains(\"superseded-by:\") {\n            bail!(\"{name}: superseded record does not name its successor\");\n        }\n    }\n    println!(\"{} ADRs checked\", seen.len());\n    Ok(())\n}",
          "tip": "Run the archive check only on pull requests that touch doc/adr; a failing check on an unrelated feature branch trains people to ignore it."
        }
      ],
      "exercise": {
        "prompt": "Write an ADR for choosing a modular monolith over microservices for a five-team product, with three considered options, the drivers, and at least two negative consequences. Then add the CI check that would keep the archive valid.",
        "starter": "# 0011-<title>.md\n---\nstatus: proposed\ndate: <today>\n---\n\n## Context and Problem Statement\n\n## Considered Options\n\n## Decision Outcome\n\n## Consequences",
        "hint": "Drivers should be measurable: deploy frequency, team count, transaction needs, operational headcount. The negative consequences are the interesting part: shared release train, one blast radius, and the discipline needed to keep module seams.",
        "solution": "---\nstatus: accepted\ndate: 2026-10-02\ndeciders: architecture, platform\n---\n\n# Keep a modular monolith until extraction criteria are met\n\n## Context and Problem Statement\n\nFive teams share one checkout domain. Two teams already deploy daily; the\nothers weekly. A proposal to split into six services would add four new\ndeployables, a broker, and a saga on the money path.\n\n## Decision Drivers\n\n- Checkout needs one transaction across orders and stock\n- Team count (5) is below the point where deploy queues hurt\n- Operational headcount is two people, not a platform org\n\n## Considered Options\n\n1. Six microservices with a saga on checkout\n2. Modular monolith: one deployable, module crates, in-process events\n3. Three services split by scaling profile only\n\n## Decision Outcome\n\nChosen: option 2. Module boundaries are enforced by separate crates in one\nworkspace; extraction requires all four criteria in the extraction lesson to pass.\n\n## Consequences\n\n- Good: checkout keeps one transaction and no compensation logic\n- Good: one deployable matches the two-person on-call rotation\n- Bad: a release train for all five teams until extraction happens\n- Bad: module seams need CI enforcement or they erode under deadline pressure\n\n## Links\n\n- Related: ADR-0004 (outbox for cross-module events)\n- Revisit when: any module exceeds 3x the deploy frequency of the others"
      },
      "production": [
        "Every significant decision has an ADR with status, date, options, outcome, and both positive and negative consequences.",
        "Accepted records are never edited; reversals create a new record with a supersedes link.",
        "CI runs structural checks (status and date present, no duplicate numbers, links resolve) on changes under doc/adr.",
        "Code that embodies a decision links to its ADR, and the ADR links back to the crate or migration.",
        "The review queue of proposed ADRs is visible in the team ritual, not buried in a folder."
      ],
      "crates": [
        "adrs",
        "anyhow"
      ],
      "github": [
        {
          "name": "joshrotenberg/adrs",
          "url": "https://github.com/joshrotenberg/adrs"
        },
        {
          "name": "adr/madr",
          "url": "https://github.com/adr/madr"
        }
      ],
      "pitfall": "Editing an accepted ADR to match what was built: the archive now claims the team decided something it never discussed, and the next reader trusts a fabricated rationale.",
      "questions": [
        {
          "q": "What belongs in an ADR that a design document would not need?",
          "options": [
            "Diagrams of every component",
            "The options that were rejected and the consequences accepted",
            "A complete API reference",
            "The sprint plan that delivered the change"
          ],
          "answer": 1,
          "explain": "The decision is only meaningful against its alternatives. Recording what lost, and why, is what stops the same debate from recurring."
        },
        {
          "q": "A decision changes six months later. What happens to the original record?",
          "options": [
            "Edit it so the archive reflects current reality",
            "Leave it intact and write a new record that supersedes it",
            "Delete it to avoid confusion",
            "Move it to an archive folder without a link"
          ],
          "answer": 1,
          "explain": "Immutability is what makes the archive trustworthy. A superseding record preserves both the original reasoning and the reason it stopped applying."
        },
        {
          "q": "Why check ADR structure in CI rather than in review?",
          "options": [
            "Reviewers cannot read markdown",
            "Mechanical properties such as status, dates, and link resolution are cheap to check and easy to forget",
            "CI can judge whether a decision was correct",
            "It removes the need for a tech lead"
          ],
          "answer": 1,
          "explain": "CI cannot judge the decision, but it can guarantee the record is complete and linked. That is exactly the part humans skip under deadline."
        }
      ],
      "quickbytes": [
        "adrs init, adrs new, adrs doctor: the three commands that keep a decision log usable.",
        "One decision per file; a record covering four choices will be stale in three of them.",
        "Supersede, never edit: the history of why something stopped being true is the valuable part."
      ],
      "resources": [
        {
          "title": "MADR: Markdown Architectural Decision Records templates",
          "url": "https://github.com/adr/madr",
          "kind": "repo"
        },
        {
          "title": "adrs: command line tool for ADR logs, Nygard and MADR formats",
          "url": "https://docs.rs/crate/adrs/latest",
          "kind": "docs"
        },
        {
          "title": "joshrotenberg/adrs: implementation and doctor rules",
          "url": "https://github.com/joshrotenberg/adrs",
          "kind": "repo"
        },
        {
          "title": "InfoQ: architecture practice talks on decisions and enablement",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        }
      ]
    },
    {
      "id": "q19",
      "title": "Managing technical debt as an interest rate",
      "minutes": 70,
      "level": "industry",
      "goal": "Price debt by the interest it charges, measure it with cheap proxies, and pay it down through triggers and budgeted slices instead of arguments.",
      "sections": [
        {
          "h": "Debt is a decision with an interest rate",
          "p": [
            "The metaphor is financial: a shortcut is borrowed capacity, and the interest is the extra cost every future change pays. The useful distinction is deliberate versus inadvertent and prudent versus reckless. A deliberate, prudent shortcut, written down and scheduled, is a financing decision; an accident nobody noticed is an unmanaged liability with compounding interest.",
            "Interest has measurable proxies: deploy duration, change failure rate, onboarding time to first production change, the number of files a typical change touches, and incidents attributable to one component. If you cannot name the interest, you have a preference, not debt, and preferences should not compete with reliability work for the same budget."
          ],
          "list": [
            "Deliberate and prudent: ship the simple version, record the limit, schedule the follow-up",
            "Deliberate and reckless: skip the tenant filter to hit a date",
            "Inadvertent and prudent: the domain changed under a design that was right last year",
            "Inadvertent and reckless: nobody knows why this module exists and everyone is afraid to touch it"
          ],
          "tip": "Ask what the debt charges per month in engineer hours. A number that small is often cheaper to keep paying than to remove."
        },
        {
          "h": "Measure proxies instead of arguing",
          "p": [
            "Four cheap signals cover most of it: build and test duration trend, duplicate dependency versions from cargo tree -d, the age of TODO and FIXME markers via git blame, and churn hotspots where many commits touch files that also attract defects. None of them is a perfect metric, and together they point at the same two or three modules every time.",
            "Architecture-specific debt is countable too. Cross-module imports that bypass a facade, handlers that hold a PgPool directly instead of calling a use case, adapter files that keep growing, and crates with no owner are all greppable. A rule in CI converts each one from a review opinion into a number that either passes or fails."
          ],
          "code": "# deny.toml: dependency-level debt that fails the build\n[bans]\nmultiple-versions = \"deny\"   # duplicate majors slow builds and inflate audits\n\n[licenses]\nallow = [\"MIT\", \"Apache-2.0\", \"BSD-3-Clause\", \"Unicode-3.0\"]\n\n[advisories]\nyanked = \"deny\"\n\n# Local signals worth running before a debt review\ncargo tree -d                                  # duplicate crate versions\ngit log --since=\"6 months ago\" --numstat --format=   | awk 'NF==3 { files[$3]++; churn[$3]+=$1+$2 } END { for (f in churn) print churn[f], files[f], f }'   | sort -rn | head -20                        # churn hotspots\ngit log -1 --format=%cr -- path/to/module.rs   # age of the last real change\ngrep -rn \"see ADR-\" crates/ | wc -l            # decisions still referenced",
          "tip": "Run the churn report before planning a refactor. The hotspot list and the team intuition usually agree, and when they do not, the discrepancy is the interesting finding."
        },
        {
          "h": "Pay it down in slices, attached to triggers",
          "p": [
            "Budget a slice of every iteration, commonly ten to twenty percent, and attach paydown to a trigger rather than a mood: when a file exceeds a violation count, when a duplicate major appears, when p99 crosses a threshold, when a second team needs to change the module. Triggers make the work predictable and stop it from depending on who is loudest in planning.",
            "Write each item as a small record with an owner, the interest it charges, and the metric that will prove it is paid. Close it with the before-and-after number. A debt register that reads as a list of complaints gets ignored; one that shows avoided hours and avoided incidents gets funded."
          ],
          "code": "| id | item | interest | owner | trigger | metric |\n|----|------|----------|-------|---------|--------|\n| D-14 | orders module imports inventory tables directly | every schema change needs two reviews | @orders | next inventory migration | cross-module SQL count: 7 -> 0 |\n| D-21 | two major versions of a base64 crate in the graph | +40s build, duplicate audit surface | @platform | any dependency PR | cargo tree -d: 2 -> 0 |\n| D-22 | checkout handler holds a PgPool and skips the use case | no test coverage, tenant filter easy to miss | @checkout | next checkout change | handlers with PgPool: 4 -> 0 |",
          "tip": "Give every debt item a metric with a current value and a target. An item without a number cannot be closed, only discussed."
        }
      ],
      "exercise": {
        "prompt": "Take one module in a codebase you know and write three debt items in the register format: the interest, the trigger, and the metric with a current value. Then decide which one you would not pay down, and why.",
        "starter": "| id | item | interest | owner | trigger | metric |\n|----|------|----------|-------|---------|--------|\n| D-01 | | | | | |",
        "hint": "The best first item is usually the one that blocks other changes, not the ugliest code. The item you would not pay is the one whose interest is lower than the cost of the change, and saying so is part of the discipline.",
        "solution": "| id | item | interest | owner | trigger | metric |\n|----|------|----------|-------|---------|--------|\n| D-01 | report query joins orders and inventory tables | blocks every inventory migration; 2 incidents last quarter | @data | next inventory migration | cross-schema joins: 3 -> 0 |\n| D-02 | no integration test for tenant scoping | every release needs a manual check; one near miss | @platform | next auth change | tenant isolation tests: 0 -> 4 |\n| D-03 | hand-rolled retry in three adapters | inconsistent backoff, one retries 4xx | @orders | next adapter change | retry implementations: 3 -> 1 |\n\nNot paying down: the duplicated currency list in two services. The interest is\nnear zero because the list changes yearly and the code paths never meet. Removing\nit would cost a shared crate and a release train: a negative return, so it stays\nrecorded and unowned."
      },
      "production": [
        "A debt register exists with owner, interest, trigger, and a metric that has a current value and a target.",
        "cargo deny runs in CI so duplicate majors, yanked crates, and license drift fail the build instead of accumulating.",
        "A fixed slice of each iteration is reserved for paydown, and the slice is tracked like feature work, not borrowed back silently.",
        "Architecture rules (facade-only imports, no PgPool in handlers) are enforced by CI rather than by review memory.",
        "Each closed debt item records the before-and-after metric, so the register shows avoided cost rather than activity."
      ],
      "crates": [
        "cargo-deny",
        "cargo-tree",
        "thiserror"
      ],
      "github": [
        {
          "name": "EmbarkStudios/cargo-deny",
          "url": "https://github.com/EmbarkStudios/cargo-deny"
        },
        {
          "name": "kgrzybek/modular-monolith-with-ddd",
          "url": "https://github.com/kgrzybek/modular-monolith-with-ddd"
        }
      ],
      "pitfall": "A refactor quarter that pauses features: debt is paid in one heroic batch, the register is emptied, and the same shortcuts return within two releases because the rules that caused them are still unenforced.",
      "questions": [
        {
          "q": "Which debt item should be paid first?",
          "options": [
            "The ugliest file in the repository",
            "The one whose interest blocks other changes or causes incidents",
            "The one that is quickest to fix so the register looks better",
            "The oldest item on the list"
          ],
          "answer": 1,
          "explain": "Priority follows interest, not aesthetics. Debt that blocks migrations or causes incidents charges every sprint; ugly code nobody touches charges nothing."
        },
        {
          "q": "Why run cargo deny check bans in CI instead of reviewing dependencies manually?",
          "options": [
            "It is the only way to see the dependency graph",
            "Duplicate majors and license drift are mechanical, and mechanical rules are forgotten exactly when the team is busy",
            "It replaces the need for an audit",
            "It makes builds faster"
          ],
          "answer": 1,
          "explain": "A dependency policy that lives in a review checklist is enforced until the first deadline. A failing check is enforced every time."
        },
        {
          "q": "What makes a debt register item closable?",
          "options": [
            "An owner and a due date",
            "A metric with a current value, a target, and evidence recorded when it is closed",
            "A link to the commit that introduced the shortcut",
            "Approval from the architecture group"
          ],
          "answer": 1,
          "explain": "Without a number, the item can only be debated. With one, completion is observable and the avoided cost can be reported."
        }
      ],
      "quickbytes": [
        "cargo tree -d lists duplicate crate versions; deny the ones that matter instead of reading the list every quarter.",
        "Attach paydown to triggers, not to planning arguments; triggers fire whether or not someone remembers.",
        "Record the before-and-after metric for every closed item, or the register becomes a list of good intentions."
      ],
      "resources": [
        {
          "title": "Business-Driven Technical Debt Prioritization: An Industrial Case Study (arXiv:2010.09711)",
          "url": "https://arxiv.org/abs/2010.09711",
          "kind": "paper"
        },
        {
          "title": "EmbarkStudios/cargo-deny: dependency policy as code",
          "url": "https://github.com/EmbarkStudios/cargo-deny",
          "kind": "repo"
        },
        {
          "title": "The Cargo Book: workspace lints for consistent enforcement",
          "url": "https://doc.rust-lang.org/cargo/reference/workspaces.html",
          "kind": "docs"
        },
        {
          "title": "Clippy documentation: lint categories for mechanically enforced cleanup",
          "url": "https://doc.rust-lang.org/clippy/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "q20",
      "title": "Team topologies and the architecture they produce",
      "minutes": 65,
      "level": "industry",
      "goal": "Design team boundaries that produce the architecture you want, keep cognitive load per team bounded, and enforce ownership with CODEOWNERS and CI.",
      "sections": [
        {
          "h": "Conway law, used on purpose",
          "p": [
            "Architecture mirrors the communication structure of the organisation that built it. You can fight that or use it: the inverse Conway maneuver designs team boundaries so the architecture you want becomes the path of least resistance. Four stream-aligned teams each owning a bounded context will produce four contexts whether or not a diagram says otherwise.",
            "Team Topologies names four team types and three interaction modes. Stream-aligned teams own a flow of business value; a platform team provides internal services that reduce load; an enabling team raises capability temporarily; a complicated-subsystem team exists because a component needs specialists. The modes are collaboration, X-as-a-service, and facilitating, and naming the mode makes expectations explicit."
          ],
          "list": [
            "One stream-aligned team per bounded context, with the context in its name",
            "A platform team owns the paved road: templates, CI, telemetry, deploy, and dependency policy",
            "Enabling teams are temporary by design; a permanent enabling team is a consultancy with a budget",
            "Write the team API: what this team provides, what it needs, and how to request it"
          ],
          "tip": "If two teams must collaborate on every change, either the boundary is wrong or the interaction mode is mislabelled; X-as-a-service with a stable contract is the cheaper default."
        },
        {
          "h": "Cognitive load is the real constraint",
          "p": [
            "A team can own one or two bounded contexts well. Beyond that, ownership becomes shallow: reviews get rubber-stamped, on-call pages route to whoever is awake, and the model lives in one person head. The architecture drifts not because people stopped caring but because nobody holds enough context to notice the drift.",
            "Measure the load with things you already have: time from joining to first production deploy, services per on-call rotation, pages per week per team, and the number of repositories a typical change touches. A team whose first deploy takes three weeks is not slow; it is carrying load the platform should absorb with a template, a pipeline, and a telemetry crate wired in by default."
          ],
          "code": "// A team API, written down and reviewed like code.\npub struct TeamApi {\n    pub name: &'static str,\n    pub context: &'static str,\n    pub provides: &'static [&'static str],\n    pub requires: &'static [&'static str],\n    pub interaction: Interaction,\n}\n\npub enum Interaction {\n    /// Runs the service for consumers behind a contract.\n    XAsAService,\n    /// Joint work for a bounded period, with an exit date.\n    Collaboration { until: &'static str },\n    /// Raises capability, then leaves.\n    Facilitating { until: &'static str },\n}\n\npub const ORDERS_TEAM: TeamApi = TeamApi {\n    name: \"orders\",\n    context: \"order lifecycle and pricing commitments\",\n    provides: &[\"orders HTTP API v1\", \"OrderPlaced event\", \"on-call for orders\"],\n    requires: &[\"postgres platform\", \"paved-road crate template\", \"identity tokens\"],\n    interaction: Interaction::XAsAService,\n};",
          "tip": "Give collaboration an exit date in the same sentence that creates it. Open-ended collaboration is how two teams become one team with two managers."
        },
        {
          "h": "Ownership the tooling can enforce",
          "p": [
            "CODEOWNERS maps paths to teams, so review routing follows the context map instead of individual memory. A crate with no owner is a crate with no on-call, and it will be discovered during an incident. Pair the mapping with the workspace dependency rules from the modular monolith lesson: the Cargo graph should be drawable as the team graph, or one of the two is wrong.",
            "Check the mapping in CI. Every crate appears in CODEOWNERS, every deployable has an on-call entry, every ADR names a decision owner. The checks are cheap, they fail loudly, and they catch the exact moment a service is created without a team or a team is renamed without its ownership moving."
          ],
          "code": "# .github/CODEOWNERS -- paths map to bounded contexts, not individuals.\n/crates/orders/         @acme/orders\n/crates/inventory/      @acme/inventory\n/crates/billing/        @acme/billing\n/crates/telemetry/      @acme/platform\n/crates/shared-ids/     @acme/platform @acme/orders @acme/inventory\n/doc/adr/               @acme/architecture\n/.github/workflows/     @acme/platform\n\n# CI: ownership must cover every crate.\nset -e\nfor manifest in crates/*/Cargo.toml; do\n  crate=$(basename \"$(dirname \"$manifest\")\")\n  grep -q \"^/crates/$crate/\" .github/CODEOWNERS || {\n    echo \"crate $crate has no owner in CODEOWNERS\"\n    exit 1\n  }\ndone\n# Every service in the on-call map must exist, and every service must be mapped.\nfor svc in $(ls services); do\n  grep -q \"^$svc:\" ops/oncall.yaml || { echo \"no on-call for $svc\"; exit 1; }\ndone",
          "tip": "Require owner review for the shared kernel only. Requiring it everywhere turns CODEOWNERS into a queue that people route around with admin merges."
        }
      ],
      "exercise": {
        "prompt": "For a product with catalog, checkout, billing, and a shared telemetry crate, write the team API for checkout and the CODEOWNERS file. Then state which interaction mode you would use between checkout and the platform team, and why.",
        "starter": "# TODO: TeamApi for checkout, CODEOWNERS mapping crates to teams,\n# TODO: interaction mode with platform + an exit condition if collaboration",
        "hint": "Checkout consumes a contract from billing and a paved road from platform; both are X-as-a-service. Collaboration only makes sense for a bounded migration, and it needs an exit date in the same sentence.",
        "solution": "pub const CHECKOUT_TEAM: TeamApi = TeamApi {\n    name: \"checkout\",\n    context: \"cart to paid order, including payment attempts\",\n    provides: &[\"checkout HTTP API\", \"OrderPlaced event\", \"on-call for checkout\"],\n    requires: &[\"orders API\", \"payments API\", \"paved-road template\", \"identity tokens\"],\n    // Platform: X-as-a-service. Billing: X-as-a-service behind a versioned contract.\n    interaction: Interaction::XAsAService,\n};\n\n# .github/CODEOWNERS\n/crates/catalog/    @acme/catalog\n/crates/checkout/   @acme/checkout\n/crates/billing/    @acme/billing\n/crates/telemetry/  @acme/platform\n\n# Why: checkout calls billing through a versioned API and needs no joint work.\n# Collaboration would only be chosen for a time-boxed migration, e.g. moving\n# payment attempts into billing: Collaboration { until: \"2026-Q3\" } with an\n# explicit exit review. Open-ended collaboration would merge the two contexts\n# in practice while the diagram still shows two teams."
      },
      "production": [
        "Every crate and service has a team owner in CODEOWNERS, and CI fails when a crate or deployable has none.",
        "Each team owns at most two bounded contexts; a third triggers a platform or enabling-team conversation rather than silent overload.",
        "The platform team ships a paved road (crate template, CI, telemetry, deploy, dependency policy) that new services use by default.",
        "Onboarding time to first production deploy is measured per team and treated as a platform metric.",
        "Interaction modes are written down with exit dates for collaboration and facilitating engagements."
      ],
      "crates": [
        "cargo-deny",
        "tracing",
        "axum",
        "sqlx"
      ],
      "github": [
        {
          "name": "EmbarkStudios/cargo-deny",
          "url": "https://github.com/EmbarkStudios/cargo-deny"
        },
        {
          "name": "kgrzybek/modular-monolith-with-ddd",
          "url": "https://github.com/kgrzybek/modular-monolith-with-ddd"
        }
      ],
      "pitfall": "A CODEOWNERS file that still names people who left: reviews are requested from nobody, changes merge with one approval, and ownership exists only on paper during the incident review.",
      "questions": [
        {
          "q": "What makes a stream-aligned team boundary credible?",
          "options": [
            "It maps to a folder in the repository",
            "It owns a bounded context end to end, including on-call, deploy, and the data it writes",
            "It has more engineers than the other teams",
            "It reports directly to the CTO"
          ],
          "answer": 1,
          "explain": "Ownership means operating the thing: deploy, on-call, schema, and contract. A team that only writes code for a context owns a queue, not a boundary."
        },
        {
          "q": "Why is open-ended collaboration between two teams a warning sign?",
          "options": [
            "Collaboration is always more expensive than a contract",
            "Sustained collaboration blurs ownership until the two contexts behave as one without merging officially",
            "It violates the Team Topologies book",
            "It prevents using CODEOWNERS"
          ],
          "answer": 1,
          "explain": "Collaboration is appropriate for bounded work such as a migration. Without an exit date, boundaries erode and neither team can be accountable for the contract."
        },
        {
          "q": "Which metric best exposes cognitive overload in a team?",
          "options": [
            "Lines of code per sprint",
            "Time from joining to first production deploy, plus services per on-call rotation",
            "Number of pull requests reviewed",
            "Story points completed"
          ],
          "answer": 1,
          "explain": "Both numbers describe how much context a team must hold and how much surface it operates. High values indicate load the platform should absorb."
        }
      ],
      "quickbytes": [
        "Name teams after bounded contexts, not after technologies; a team called \"the Kafka team\" is a platform component with a headcount.",
        "Give every collaboration an exit date in the same sentence that starts it.",
        "Check CODEOWNERS coverage in CI: a crate without an owner is an incident waiting for a rotation."
      ],
      "resources": [
        {
          "title": "Code Ownership: Principles, Differences, and Associations with Software Quality (arXiv:2408.12807)",
          "url": "https://arxiv.org/abs/2408.12807",
          "kind": "paper"
        },
        {
          "title": "EmbarkStudios/cargo-deny: platform policy enforced for every team",
          "url": "https://github.com/EmbarkStudios/cargo-deny",
          "kind": "repo"
        },
        {
          "title": "The Cargo Book: workspace layout that mirrors team boundaries",
          "url": "https://doc.rust-lang.org/cargo/reference/workspaces.html",
          "kind": "docs"
        },
        {
          "title": "Full modular monolith with DDD: one module per team-owned context",
          "url": "https://github.com/kgrzybek/modular-monolith-with-ddd",
          "kind": "repo"
        }
      ]
    }
  ]
};
