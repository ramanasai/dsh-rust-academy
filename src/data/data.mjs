/**
 * Data & persistence track.
 *
 * Authored for the Rust Academy plugin. Every lesson is plain JSON-compatible
 * data consumed by src/app.js through build.mjs.
 */
export default {
  "key": "data",
  "prefix": "d",
  "title": "Data & persistence",
  "blurb": "Postgres with SQLx, Redis caching, S3 object storage, and the outbox, idempotency and partitioning patterns that keep production data correct.",
  "level": "industry",
  "project": {
    "title": "Capstone: a durable media library service",
    "brief": "Build the persistence layer of a service that stores media assets: Postgres owns the metadata, S3-compatible object storage owns the bytes, Redis absorbs read load, and every state change is published through a transactional outbox so downstream consumers never observe a write that did not commit.",
    "deliverables": [
      "A SQLx repository layer with compile-time checked queries, migrations, and a CI job that fails on schema drift",
      "A Redis cache-aside layer with jittered TTLs, post-commit invalidation, and single-flight protection on hot keys",
      "Presigned upload/download endpoints plus a multipart path that streams and cleans up aborted uploads",
      "An outbox relay with idempotent consumers, an audit log, and monthly partitions with a retention drop",
      "An EXPLAIN ANALYZE runbook proving keyset pagination and eliminating N+1 queries"
    ],
    "stack": [
      "sqlx",
      "redis",
      "aws-sdk-s3",
      "aws-config",
      "axum",
      "tokio",
      "uuid",
      "serde"
    ]
  },
  "lessons": [
    {
      "id": "d01",
      "n": 1,
      "title": "SQLx 0.8 foundations: pools, checked queries, migrations",
      "minutes": 75,
      "level": "core",
      "goal": "Own one sized connection pool, write SQL that the compiler checks, and keep migrations and CI honest.",
      "sections": [
        {
          "h": "One pool per process, sized against Postgres",
          "p": [
            "A PgPool is an Arc of a connection queue. Build it once at startup, clone it into handlers, and never open a connection per request: connecting costs a TCP handshake, TLS, authentication and a Postgres backend process fork. The pool's job is to bound concurrency at the database, which is the resource that actually runs out.",
            "max_connections is per process, so the number that matters is replicas × max_connections plus migrations and operators, and it must stay below the server's max_connections. acquire_timeout is the backpressure valve: without it, requests queue inside the pool until your HTTP timeout fires, and every layer above thinks the database is slow when the pool is simply saturated."
          ],
          "code": "use std::time::Duration;\nuse sqlx::postgres::PgPoolOptions;\n\n/// Build this once in main(), then clone the pool into every handler.\npub async fn connect(database_url: &str) -> Result<sqlx::PgPool, sqlx::Error> {\n    PgPoolOptions::new()\n        .max_connections(16)                                  // per process, not per request\n        .min_connections(4)                                   // warm connections, no cold-start spikes\n        .acquire_timeout(Duration::from_secs(3))              // fail fast instead of queueing forever\n        .max_lifetime(Duration::from_secs(30 * 60))           // retire sessions, release server memory\n        .idle_timeout(Duration::from_secs(5 * 60))\n        .connect(database_url)\n        .await\n}\n",
          "tip": "If you run behind PgBouncer in transaction mode, disable sqlx prepared-statement reuse: the same statement can land on a different backend. Keep max_connections small and let the proxy do the multiplexing."
        },
        {
          "h": "query! type-checks your SQL against the real schema",
          "p": [
            "The sqlx macros do not parse SQL. They connect to DATABASE_URL at build time, prepare the statement, and read back the parameter and column types, producing a real Rust struct. A renamed column or a changed type becomes a compile error instead of a 03:00 runtime error.",
            "Use query_as! when you want a named struct you can return from a function, and query_scalar! for a single value. Postgres cannot infer NOT NULL for expressions, so count(*) arrives as Option<i64>; the `AS \"count!\"` override forces non-null and documents the assumption in the SQL itself."
          ],
          "code": "use sqlx::PgPool;\nuse uuid::Uuid;\n\n#[derive(Debug)]\npub struct Account {\n    pub id: Uuid,\n    pub email: String,\n}\n\npub async fn find(pool: &PgPool, id: Uuid) -> sqlx::Result<Option<Account>> {\n    sqlx::query_as!(\n        Account,\n        r#\"SELECT id, email FROM accounts WHERE id = $1\"#,\n        id\n    )\n    .fetch_optional(pool)\n    .await\n}\n\npub async fn count(pool: &PgPool) -> sqlx::Result<i64> {\n    // count(*) is an expression, so Postgres marks it nullable. `!` overrides it.\n    sqlx::query_scalar!(r#\"SELECT count(*) AS \"count!\" FROM accounts\"#)\n        .fetch_one(pool)\n        .await\n}\n"
        },
        {
          "h": "Migrations are versioned files, run before traffic",
          "p": [
            "sqlx::migrate! embeds the migrations directory into the binary, so the schema the code was compiled against travels with it. Each file is checksummed in _sqlx_migrations; editing an applied file is an error by design, because production may already depend on it. Add a new file instead.",
            "Run migrations as a dedicated step before rolling out new instances rather than on every app boot. sqlx takes an advisory lock so concurrent runs serialize, but you still do not want sixteen replicas racing an index build while the load balancer is sending them requests."
          ],
          "code": "// main.rs — run this before the HTTP listener binds.\npub async fn migrate(pool: &sqlx::PgPool) -> anyhow::Result<()> {\n    sqlx::migrate!(\"./migrations\").run(pool).await?;\n    Ok(())\n}\n",
          "list": [
            "Name files with an ordered prefix: 20240115_0001_create_accounts.sql",
            "Forward-only: write a new migration to undo a mistake, never edit an applied one",
            "Keep DDL out of the request path; migrations run once, not per connection",
            "Prefer CREATE INDEX CONCURRENTLY in its own migration file, outside a transaction block"
          ],
          "tip": "sqlx wraps each migration in a transaction unless you add `-- no-transaction` at the top of the file, which CONCURRENTLY requires."
        },
        {
          "h": "Offline mode keeps CI builds working",
          "p": [
            "query! needs a database at build time, which a build agent usually does not have. Offline mode replaces that dependency with a committed cache: cargo sqlx prepare connects once and writes one JSON description per query into .sqlx/.",
            "Commit .sqlx/ and build in CI without DATABASE_URL set. The macros read the cache whenever DATABASE_URL is absent, so a clean checkout compiles with no network and no database."
          ],
          "list": [
            "After changing any query: cargo sqlx prepare (with DATABASE_URL pointed at a migrated DB)",
            "Commit the regenerated .sqlx/ directory alongside the code change, in the same commit",
            "In CI: cargo sqlx prepare --check against a migrated, disposable database to detect drift",
            "Building without DATABASE_URL is what actually exercises the cache; leaving it set silently hides a stale .sqlx/",
            "Feature flags must match between prepare and build (uuid, chrono, json), or the cached types will not line up"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write find_account returning None when the row is absent, and count_accounts returning an i64, both checked by the compiler. Then explain why count needs a nullability override.",
        "starter": "use sqlx::PgPool;\nuse uuid::Uuid;\n\npub struct Account {\n    pub id: Uuid,\n    pub email: String,\n}\n\npub async fn find_account(pool: &PgPool, id: Uuid) -> sqlx::Result<Option<Account>> {\n    // use query_as! + fetch_optional\n    todo!()\n}\n\npub async fn count_accounts(pool: &PgPool) -> sqlx::Result<i64> {\n    // use query_scalar! + fetch_one\n    todo!()\n}\n",
        "hint": "fetch_optional returns Option<T> and is the only method that tolerates zero rows. For the count, add `AS \"count!\"` so the macro emits i64 instead of Option<i64>.",
        "solution": "use sqlx::PgPool;\nuse uuid::Uuid;\n\npub struct Account {\n    pub id: Uuid,\n    pub email: String,\n}\n\npub async fn find_account(pool: &PgPool, id: Uuid) -> sqlx::Result<Option<Account>> {\n    sqlx::query_as!(\n        Account,\n        r#\"SELECT id, email FROM accounts WHERE id = $1\"#,\n        id\n    )\n    .fetch_optional(pool)\n    .await\n}\n\npub async fn count_accounts(pool: &PgPool) -> sqlx::Result<i64> {\n    sqlx::query_scalar!(r#\"SELECT count(*) AS \"count!\" FROM accounts\"#)\n        .fetch_one(pool)\n        .await\n}\n\n// count(*) is never NULL at runtime, but Postgres reports expression columns as\n// nullable, so the macro would otherwise produce Option<i64>.\n"
      },
      "production": [
        "Set max_connections on each process so that replicas × max_connections stays below the server limit, with headroom for migrations and operators",
        "Set acquire_timeout below the request deadline, so a saturated pool returns an error instead of a wave of client timeouts",
        "Run migrations as a separate deploy step before new instances start, never inside request handlers",
        "Commit .sqlx/ and build CI with DATABASE_URL unset, so a stale query cache fails the build rather than production",
        "Keep max_lifetime under any proxy or load-balancer idle timeout, so half-open server sessions are retired rather than reused"
      ],
      "crates": [
        "sqlx",
        "tokio",
        "uuid"
      ],
      "pitfall": "Without an offline cache or a migrated build database, query! compiles against whatever local schema you happen to have. It validates types, not migration state, so a column added by an unapplied migration compiles locally and fails as a runtime 42703 at deploy time.",
      "resources": [
        {
          "title": "sqlx::query! macro reference (compile-time checked SQL, offline mode)",
          "url": "https://docs.rs/sqlx/0.8.6/sqlx/macro.query.html",
          "kind": "docs"
        },
        {
          "title": "sqlx::query_as! macro reference (named struct mapping)",
          "url": "https://docs.rs/sqlx/0.8.6/sqlx/macro.query_as.html",
          "kind": "docs"
        },
        {
          "title": "PoolOptions: max_connections, acquire_timeout, max_lifetime",
          "url": "https://docs.rs/sqlx/0.8.6/sqlx/pool/struct.PoolOptions.html",
          "kind": "docs"
        },
        {
          "title": "sqlx on crates.io (0.8.x release line)",
          "url": "https://crates.io/crates/sqlx",
          "kind": "docs"
        },
        {
          "title": "SQLx is my favorite PostgreSQL driver to use with Rust (Dreams of Code)",
          "url": "https://www.youtube.com/watch?v=TCERYbgvbq0",
          "kind": "video"
        }
      ],
      "github": [
        {
          "name": "sqlx",
          "url": "https://github.com/transact-rs/sqlx"
        },
        {
          "name": "tokio",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "quickbytes": [
        "Budget replicas x (max_connections + side connections) below the server max_connections, with headroom for migrations.",
        "Set acquire_timeout under the request deadline so a saturated pool fails fast instead of queueing.",
        "cargo sqlx prepare --check in CI, then build with DATABASE_URL unset to prove .sqlx/ is current."
      ],
      "questions": [
        {
          "q": "A service runs 12 replicas; each builds PgPoolOptions::new().max_connections(20) and keeps 2 background workers connected. Postgres max_connections is 200. What happens as traffic grows?",
          "options": [
            "Connections are refused: 12 x 22 = 264 exceeds 200, and no pool can absorb the excess",
            "sqlx shrinks each pool to 200/12 so the fleet total always fits the server",
            "Postgres multiplexes the extra clients onto shared backends, so only latency rises",
            "acquire_timeout raises the server limit whenever the pool saturates"
          ],
          "answer": 0,
          "explain": "max_connections is per process, per pool. The number that matters is replicas x (pool + side connections) against the server limit, with headroom for migrations and operators."
        },
        {
          "q": "sqlx::query_scalar!(\"SELECT count(*) FROM accounts\") yields Option<i64> instead of i64. What is the correct fix?",
          "options": [
            "Cast to ::int8, because Postgres reports count as int4 and sqlx maps int4 as nullable",
            "SELECT count(*) AS \"count!\" - the override tells the macro the expression is not null",
            "Add .fetch_optional() so the macro can infer a non-null scalar",
            "Delete .sqlx/ and re-run cargo sqlx prepare to refresh cached nullability"
          ],
          "answer": 1,
          "explain": "Postgres marks expression columns nullable, so the macro emits Option<i64>. The AS \"count!\" override lives in the SQL the compiler reads and documents the assumption next to it."
        }
      ]
    },
    {
      "id": "d02",
      "n": 2,
      "title": "Transactions, row locks and isolation levels",
      "minutes": 90,
      "level": "advanced",
      "goal": "Group writes atomically, choose the weakest isolation level that is still correct, and retry the failures Postgres expects you to retry.",
      "sections": [
        {
          "h": "A transaction is a guard object",
          "p": [
            "pool.begin() checks out a connection and returns a Transaction that dereferences to that connection. Queries take it as `&mut *tx`. commit() consumes the guard; dropping it without committing issues a rollback, which is a safety net rather than a plan.",
            "Call rollback() explicitly on the paths you know about. You get the error if the rollback itself fails, and the intent is readable to the next person: nothing after this point was meant to be persisted. Starting a transaction from `&mut *tx` creates a savepoint, which lets you roll back part of the work without losing the outer transaction."
          ],
          "code": "use sqlx::PgPool;\n\npub async fn transfer(pool: &PgPool, from: i64, to: i64, cents: i64) -> sqlx::Result<()> {\n    let mut tx = pool.begin().await?;\n\n    // conditional UPDATE: the check and the write are one atomic statement\n    let debited = sqlx::query(\n        \"UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND balance >= $1\",\n    )\n    .bind(cents)\n    .bind(from)\n    .execute(&mut *tx)\n    .await?\n    .rows_affected();\n\n    if debited == 0 {\n        tx.rollback().await?;\n        return Err(sqlx::Error::RowNotFound);\n    }\n\n    sqlx::query(\"UPDATE accounts SET balance = balance + $1 WHERE id = $2\")\n        .bind(cents)\n        .bind(to)\n        .execute(&mut *tx)\n        .await?;\n\n    tx.commit().await?;\n    Ok(())\n}\n"
        },
        {
          "h": "SELECT ... FOR UPDATE and lock ordering",
          "p": [
            "FOR UPDATE takes a row-level lock that lasts until the transaction ends. It is the tool for read-modify-write flows where the decision depends on the current value and a conditional UPDATE cannot express it, such as reserving the oldest queued job or validating a state machine transition.",
            "Every lock you take is a deadlock candidate. Postgres detects cycles and aborts one transaction, but the fix is structural: acquire rows in a deterministic order (ascending id, or one parent row first) so a cycle cannot form. For queue tables, FOR UPDATE SKIP LOCKED lets N workers claim disjoint rows instead of all blocking on the head of the line."
          ],
          "code": "use sqlx::{PgPool, Postgres, Transaction};\n\n#[derive(Debug, sqlx::FromRow)]\npub struct Job {\n    pub id: uuid::Uuid,\n    pub payload: serde_json::Value,\n}\n\npub async fn claim_one(pool: &PgPool) -> sqlx::Result<Option<Job>> {\n    let mut tx: Transaction<'_, Postgres> = pool.begin().await?;\n\n    // SKIP LOCKED: each worker gets a different row; nobody waits on the head\n    let job = sqlx::query_as::<_, Job>(\n        r#\"SELECT id, payload FROM jobs\n           WHERE status = 'queued'\n           ORDER BY created_at\n           LIMIT 1\n           FOR UPDATE SKIP LOCKED\"#,\n    )\n    .fetch_optional(&mut *tx)\n    .await?;\n\n    if let Some(job) = &job {\n        sqlx::query(\"UPDATE jobs SET status = 'running', started_at = now() WHERE id = $1\")\n            .bind(job.id)\n            .execute(&mut *tx)\n            .await?;\n    }\n\n    tx.commit().await?;\n    Ok(job)\n}\n"
        },
        {
          "h": "Isolation: pay only for the anomalies you must prevent",
          "p": [
            "READ COMMITTED is the default and is per statement: each statement sees a snapshot taken when it starts, so two statements in one transaction can see different data. That is enough for single-row conditional writes and not enough for multi-statement invariants.",
            "REPEATABLE READ takes one snapshot for the whole transaction and, in Postgres, also prevents phantom reads. If a row you try to update changed after that snapshot, Postgres raises a serialization failure (SQLSTATE 40001) instead of silently overwriting. SERIALIZABLE adds predicate-lock tracking on top, catches read/write cycles that snapshot isolation misses, and is only usable if the application retries on 40001.",
            "Choose the weakest level that makes your invariant true, and treat a 40001 as a normal control-flow event, not an exception."
          ],
          "code": "use sqlx::PgPool;\n\npub async fn close_period(pool: &PgPool, period: &str) -> sqlx::Result<()> {\n    let mut tx = pool.begin().await?;\n\n    // Must be the first statement in the transaction.\n    sqlx::query(\"SET TRANSACTION ISOLATION LEVEL REPEATABLE READ\")\n        .execute(&mut *tx)\n        .await?;\n\n    let open: i64 = sqlx::query_scalar(\n        \"SELECT count(*) FROM ledger_entries WHERE period = $1 AND settled_at IS NULL\",\n    )\n    .bind(period)\n    .fetch_one(&mut *tx)\n    .await?;\n\n    if open > 0 {\n        tx.rollback().await?;\n        return Err(sqlx::Error::RowNotFound);\n    }\n\n    sqlx::query(\"UPDATE periods SET closed_at = now() WHERE name = $1\")\n        .bind(period)\n        .execute(&mut *tx)\n        .await?;\n\n    tx.commit().await?;\n    Ok(())\n}\n",
          "tip": "Set the level per transaction with SET TRANSACTION, or per session with the connect option -c default_transaction_isolation=serializable. Never mix the two in one code path."
        },
        {
          "h": "Retry loops for deadlocks and serialization failures",
          "p": [
            "Two SQLSTATEs mean retry: 40P01 (deadlock detected) and 40001 (could not serialize access). Anything else, including unique violations and constraint errors, means the request is wrong and retrying will just fail again more slowly.",
            "The whole transaction must be re-runnable: re-read every value inside the closure, never capture a snapshot from the previous attempt. Bound the attempts, add jitter so a thundering herd does not re-collide in lockstep, and only retry the transaction, not an enclosing operation that may have already caused side effects."
          ],
          "code": "use std::future::Future;\nuse std::time::Duration;\n\npub fn is_retryable(err: &sqlx::Error) -> bool {\n    match err.as_database_error().and_then(|e| e.code()) {\n        Some(code) => code.as_ref() == \"40001\" || code.as_ref() == \"40P01\",\n        None => false,\n    }\n}\n\npub async fn run_with_retry<T, F, Fut>(mut op: F, attempts: u32) -> sqlx::Result<T>\nwhere\n    F: FnMut() -> Fut,\n    Fut: Future<Output = sqlx::Result<T>>,\n{\n    let mut backoff = Duration::from_millis(20);\n\n    for attempt in 1..=attempts {\n        match op().await {\n            Ok(value) => return Ok(value),\n            Err(err) if is_retryable(&err) && attempt < attempts => {\n                tokio::time::sleep(backoff).await;\n                backoff = (backoff * 2).min(Duration::from_millis(500));\n            }\n            Err(err) => return Err(err),\n        }\n    }\n\n    unreachable!(\"loop always returns on the last attempt\")\n}\n"
        }
      ],
      "exercise": {
        "prompt": "Implement reserve(pool, sku, qty) that decrements stock only when enough remains, and returns Ok(false) when it does not. It must be correct with 50 concurrent callers and must not read stock before writing it.",
        "starter": "use sqlx::PgPool;\n\npub async fn reserve(pool: &PgPool, sku: &str, qty: i32) -> sqlx::Result<bool> {\n    // One conditional UPDATE inside a transaction. Check rows_affected.\n    todo!()\n}\n",
        "hint": "UPDATE stock SET available = available - $2 WHERE sku = $1 AND available >= $2 returns rows_affected() == 0 when the guard fails. Roll back and return false.",
        "solution": "use sqlx::PgPool;\n\npub async fn reserve(pool: &PgPool, sku: &str, qty: i32) -> sqlx::Result<bool> {\n    let mut tx = pool.begin().await?;\n\n    let changed = sqlx::query(\n        \"UPDATE stock SET available = available - $2 \\\n         WHERE sku = $1 AND available >= $2\",\n    )\n    .bind(sku)\n    .bind(qty)\n    .execute(&mut *tx)\n    .await?\n    .rows_affected();\n\n    if changed == 0 {\n        tx.rollback().await?;\n        return Ok(false);\n    }\n\n    tx.commit().await?;\n    Ok(true)\n}\n\n// The guard and the write are a single statement, so a concurrent reservation\n// either sees the pre-decrement value and fails the guard, or runs after the\n// first one commits. Read-then-write under READ COMMITTED would oversell.\n"
      },
      "production": [
        "Keep transactions short: never await an HTTP call, an object-storage upload, or user input while holding one; idle-in-transaction blocks vacuum",
        "Retry only 40P01 and 40001, with a bounded attempt count and jittered backoff, and make the transaction body re-runnable from scratch",
        "Acquire row locks in a deterministic order everywhere, so deadlocks are impossible rather than merely retried",
        "Prefer one conditional UPDATE ... WHERE guard over SELECT-then-UPDATE; the single statement is atomic under READ COMMITTED",
        "Set statement_timeout and idle_in_transaction_session_timeout on the application role so one bad code path cannot pin a connection and a lock forever"
      ],
      "crates": [
        "sqlx",
        "tokio",
        "serde_json"
      ],
      "pitfall": "SELECT balance followed by UPDATE ... SET balance = $new under READ COMMITTED loses updates: two requests read 100, both write 90, and one decrement vanishes. The snapshot is per statement, so the second UPDATE never re-checks what it read.",
      "resources": [
        {
          "title": "sqlx Transaction: commit, rollback, savepoints, Drop semantics",
          "url": "https://docs.rs/sqlx/0.8.6/sqlx/struct.Transaction.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: transaction isolation levels and serialization failures",
          "url": "https://www.postgresql.org/docs/current/transaction-iso.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: explicit locking, row locks, deadlocks, advisory locks",
          "url": "https://www.postgresql.org/docs/current/explicit-locking.html",
          "kind": "docs"
        },
        {
          "title": "sqlx on GitHub: source, issues and release notes",
          "url": "https://github.com/transact-rs/sqlx",
          "kind": "repo"
        },
        {
          "title": "PGConf NYC 2022: Understanding Transaction Isolation for App Developers",
          "url": "https://www.youtube.com/watch?v=uJpKJulnLyY",
          "kind": "video"
        }
      ],
      "github": [
        {
          "name": "sqlx",
          "url": "https://github.com/transact-rs/sqlx"
        }
      ],
      "quickbytes": [
        "Retry only SQLSTATE 40001 and 40P01; unique violations and constraint errors will fail again.",
        "Take row locks in a deterministic order (ascending id, or parent first) so deadlocks cannot form.",
        "SET TRANSACTION ISOLATION LEVEL must be the first statement in the transaction."
      ],
      "questions": [
        {
          "q": "Under READ COMMITTED, two transactions both SELECT balance (100), then both run UPDATE accounts SET balance = 90 WHERE id = 1 and commit. What is the final balance?",
          "options": [
            "100 - the first UPDATE is rolled back because the row changed underneath it",
            "90 - the second write overwrites the first, so one decrement is lost",
            "80 - the second transaction re-reads the row after the lock and applies its own decrement",
            "The second UPDATE fails with a serialization error (40001), leaving 90"
          ],
          "answer": 1,
          "explain": "READ COMMITTED re-evaluates the WHERE against the newest row version, but SET balance = 90 is absolute. Two writers both write 90. Use SET balance = balance - $1 so the decrement is relative."
        },
        {
          "q": "Worker A runs SELECT ... FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED and holds its transaction open. What does worker B see?",
          "options": [
            "It receives the same row, so both workers must dedupe the job",
            "It gets a deadlock error (40P01) because both read the same table",
            "It skips A's locked row and claims the next unlocked job, or gets None if none is free",
            "It blocks on A's row until A commits, then receives the same job"
          ],
          "answer": 2,
          "explain": "SKIP LOCKED makes claims disjoint: waiters never block on the head of the queue and never receive a row another worker holds. That is what lets N workers drain one queue table."
        }
      ]
    },
    {
      "id": "d03",
      "n": 3,
      "title": "Repository and domain boundaries",
      "minutes": 70,
      "level": "advanced",
      "goal": "Keep SQL in one layer, make ids impossible to confuse, and test business rules without a database.",
      "sections": [
        {
          "h": "Newtype ids make argument swaps a compile error",
          "p": [
            "Two uuid::Uuid arguments in a row are interchangeable to the compiler, so find_account(account_id, tenant_id) silently works when the caller swaps them and returns the wrong row or no row. A transparent newtype costs nothing at runtime and turns that class of bug into a type error.",
            "sqlx::Type with #[sqlx(transparent)] generates Encode and Decode for the wrapped type, so the newtype binds as a plain uuid in SQL. Derive Hash and Eq as well: you will want them the moment ids become map or set keys."
          ],
          "code": "use uuid::Uuid;\n\n#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, sqlx::Type)]\n#[sqlx(transparent)]\npub struct AccountId(Uuid);\n\n#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, sqlx::Type)]\n#[sqlx(transparent)]\npub struct TenantId(Uuid);\n\nimpl AccountId {\n    pub fn new() -> Self {\n        // time-ordered UUIDs keep B-tree inserts local; enable uuid's `v7` feature\n        Self(Uuid::now_v7())\n    }\n}\n\nimpl From<Uuid> for AccountId {\n    fn from(value: Uuid) -> Self {\n        Self(value)\n    }\n}\n\n// With both ids as distinct types, this cannot be called with the arguments swapped.\npub async fn load(tenant: TenantId, account: AccountId) -> sqlx::Result<()> {\n    let _ = (tenant, account);\n    Ok(())\n}\n"
        },
        {
          "h": "Rows are a storage detail; the domain is the contract",
          "p": [
            "A struct that mirrors the table couples every handler to column names, nullability and database representation. Migrations then ripple through the API layer, and a nullable column forces Option into code that has already validated the invariant.",
            "Keep two types: a private Row with FromRow that matches the SELECT list exactly, and a public domain type whose constructors enforce invariants. A TryFrom between them is the single place where storage rules become business rules, and it is trivially unit-testable."
          ],
          "code": "use chrono::{DateTime, Utc};\n\n#[derive(sqlx::FromRow)]\nstruct AccountRow {\n    id: uuid::Uuid,\n    email: String,\n    created_at: DateTime<Utc>,\n}\n\npub struct Email(String);\n\nimpl Email {\n    pub fn parse(raw: String) -> Result<Self, ValidationError> {\n        if raw.contains('@') && raw.len() <= 254 {\n            Ok(Self(raw))\n        } else {\n            Err(ValidationError::Email)\n        }\n    }\n}\n\n#[derive(Debug, Clone)]\npub struct Account {\n    pub id: AccountId,\n    pub email: Email,\n    pub created_at: DateTime<Utc>,\n}\n\n#[derive(Debug, thiserror::Error)]\npub enum ValidationError {\n    #[error(\"invalid email\")]\n    Email,\n}\n\nimpl TryFrom<AccountRow> for Account {\n    type Error = ValidationError;\n\n    fn try_from(row: AccountRow) -> Result<Self, Self::Error> {\n        Ok(Self {\n            id: AccountId::from(row.id),\n            email: Email::parse(row.email)?,\n            created_at: row.created_at,\n        })\n    }\n}\n"
        },
        {
          "h": "Handlers depend on a trait, not on PgPool",
          "p": [
            "If every handler takes &PgPool, every handler owns SQL, and the business rule in the middle can only be tested against a real database. Push queries behind a repository trait whose methods speak domain types; the handler then depends on behaviour, and the adapter is the only file that knows about Postgres.",
            "Native async fn in traits (Rust 1.75+) is enough for the generic form: handlers take `&impl AccountRepo` or a generic parameter. That form is monomorphized and not dyn-compatible, so return-position impl trait in traits blocks `Box<dyn AccountRepo>`. If you need runtime polymorphism, use the async-trait crate or return boxed futures."
          ],
          "code": "use std::future::Future;\n\npub trait AccountRepo {\n    fn find(&self, id: AccountId) -> impl Future<Output = anyhow::Result<Option<Account>>> + Send;\n    fn save(&self, account: &Account) -> impl Future<Output = anyhow::Result<()>> + Send;\n}\n\n// Prod adapter: the only place in the service that writes SQL for accounts.\npub struct PgAccountRepo {\n    pool: sqlx::PgPool,\n}\n\nimpl AccountRepo for PgAccountRepo {\n    fn find(&self, id: AccountId) -> impl Future<Output = anyhow::Result<Option<Account>>> + Send {\n        let pool = self.pool.clone();\n        async move {\n            let row = sqlx::query_as::<_, AccountRow>(\n                \"SELECT id, email, created_at FROM accounts WHERE id = $1\",\n            )\n            .bind(id)\n            .fetch_optional(&pool)\n            .await?;\n\n            match row {\n                Some(row) => Ok(Some(Account::try_from(row)?)),\n                None => Ok(None),\n            }\n        }\n    }\n\n    fn save(&self, _account: &Account) -> impl Future<Output = anyhow::Result<()>> + Send {\n        async { Ok(()) }\n    }\n}\n"
        },
        {
          "h": "Test the domain with a fake, the SQL with a database",
          "p": [
            "The fake repository is a HashMap behind a Mutex; it makes business rules testable in microseconds and forces the trait to stay small, because every method is one you must implement twice. Keep it in cfg(test) or a test-support module so it cannot be reached from production code.",
            "The SQL itself still needs a real Postgres. sqlx::test provisions a fresh database per test, applies your migrations, and drops it afterwards, so tests stay independent and parallel-safe. Do not try to fake SQL: the bugs you need to catch are exactly the ones a fake cannot reproduce."
          ],
          "code": "use std::collections::HashMap;\nuse std::sync::Mutex;\n\n#[derive(Default)]\npub struct FakeAccounts {\n    rows: Mutex<HashMap<AccountId, Account>>,\n}\n\nimpl AccountRepo for FakeAccounts {\n    fn find(&self, id: AccountId) -> impl Future<Output = anyhow::Result<Option<Account>>> + Send {\n        let found = self.rows.lock().unwrap().get(&id).cloned();\n        async move { Ok(found) }\n    }\n\n    fn save(&self, account: &Account) -> impl Future<Output = anyhow::Result<()>> + Send {\n        self.rows.lock().unwrap().insert(account.id, account.clone());\n        async { Ok(()) }\n    }\n}\n\n#[tokio::test]\nasync fn missing_account_is_none() {\n    let repo = FakeAccounts::default();\n    assert!(repo.find(AccountId::new()).await.unwrap().is_none());\n}\n",
          "tip": "Keep the repository trait narrow. A trait with twelve methods and a generic filter parameter is a sign that query logic leaked upward instead of staying in the adapter."
        }
      ],
      "exercise": {
        "prompt": "Add a ProjectId newtype and a Project domain type with a validated non-empty name, plus a FromRow row struct and the TryFrom mapping. Then write one fake-repo unit test for the name validation.",
        "starter": "use uuid::Uuid;\n\n#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, sqlx::Type)]\n#[sqlx(transparent)]\npub struct ProjectId(Uuid);\n\n#[derive(sqlx::FromRow)]\npub struct ProjectRow {\n    pub id: Uuid,\n    pub name: String,\n}\n\npub struct Project {\n    pub id: ProjectId,\n    pub name: String,\n}\n\n// TODO: impl TryFrom<ProjectRow> for Project, rejecting empty names.\n// TODO: one #[test] that an empty name fails.\n",
        "hint": "Trim the name, reject it when empty, then build the domain value. In the test, construct ProjectRow directly — no database needed, because TryFrom is pure.",
        "solution": "use uuid::Uuid;\n\n#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, sqlx::Type)]\n#[sqlx(transparent)]\npub struct ProjectId(Uuid);\n\n#[derive(sqlx::FromRow)]\npub struct ProjectRow {\n    pub id: Uuid,\n    pub name: String,\n}\n\npub struct Project {\n    pub id: ProjectId,\n    pub name: String,\n}\n\n#[derive(Debug, PartialEq, Eq, thiserror::Error)]\n#[error(\"project name must not be empty\")]\npub struct EmptyName;\n\nimpl TryFrom<ProjectRow> for Project {\n    type Error = EmptyName;\n\n    fn try_from(row: ProjectRow) -> Result<Self, Self::Error> {\n        let name = row.name.trim().to_owned();\n        if name.is_empty() {\n            return Err(EmptyName);\n        }\n        Ok(Self {\n            id: ProjectId::from(row.id),\n            name,\n        })\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn rejects_empty_name() {\n        let row = ProjectRow {\n            id: Uuid::nil(),\n            name: \"   \".to_owned(),\n        };\n        assert_eq!(Project::try_from(row).unwrap_err(), EmptyName);\n    }\n}\n"
      },
      "production": [
        "Give every entity id its own newtype with a transparent sqlx::Type impl; never let two ids share a parameter position",
        "Keep row structs private to the repository module and expose only domain types, so column renames and nullability cannot leak into handlers",
        "Make the repository trait small and behaviour-oriented (find, save, list_for_tenant) rather than a generic query proxy",
        "Test invariants against a fake repository, and test SQL against real Postgres with sqlx::test; do not try to fake SQL",
        "Return domain errors (typed, with thiserror) from the adapter and keep sqlx::Error out of the public API boundary"
      ],
      "crates": [
        "sqlx",
        "uuid",
        "thiserror",
        "chrono"
      ],
      "pitfall": "Exposing the FromRow struct as the public type makes every nullable column a permanent Option in your API: once handlers branch on Some/None, a later NOT NULL migration cannot simplify the code, and the storage representation becomes the contract.",
      "resources": [
        {
          "title": "sqlx::query_as!: mapping SELECT columns to a named struct",
          "url": "https://docs.rs/sqlx/0.8.6/sqlx/macro.query_as.html",
          "kind": "docs"
        },
        {
          "title": "sqlx::postgres: PgPool, PgRow, type mappings and PgHasArrayType",
          "url": "https://docs.rs/sqlx/0.8.6/sqlx/postgres/index.html",
          "kind": "docs"
        },
        {
          "title": "sqlx on crates.io (0.8.x release line)",
          "url": "https://crates.io/crates/sqlx",
          "kind": "docs"
        },
        {
          "title": "sqlx on GitHub: source, issues and release notes",
          "url": "https://github.com/transact-rs/sqlx",
          "kind": "repo"
        },
        {
          "title": "Rust Data Modelling Without Classes (No Boilerplate)",
          "url": "https://www.youtube.com/watch?v=z-0-bbc80JM",
          "kind": "video"
        }
      ],
      "github": [
        {
          "name": "sqlx",
          "url": "https://github.com/transact-rs/sqlx"
        },
        {
          "name": "uuid",
          "url": "https://github.com/uuid-rs/uuid"
        }
      ],
      "quickbytes": [
        "#[sqlx(transparent)] on a newtype binds as the inner uuid with no runtime cost.",
        "Keep the repository trait to domain verbs; a generic filter argument means SQL leaked upward.",
        "sqlx::test provisions a fresh migrated database per test; fakes are for rules, not SQL."
      ],
      "questions": [
        {
          "q": "pub async fn load(tenant: TenantId, account: AccountId) is called as load(account_id, tenant_id). What does the transparent newtype change?",
          "options": [
            "It still compiles, but sqlx binds the wrong parameter types at runtime",
            "Nothing - #[sqlx(transparent)] erases the distinction when binding",
            "It becomes a compile error, because TenantId and AccountId are distinct types",
            "It panics at runtime when the loaded row belongs to a different tenant"
          ],
          "answer": 2,
          "explain": "Newtypes are checked by the compiler and cost nothing at runtime; the transparent attribute only changes how they encode. A swapped argument stops being a wrong-row bug and becomes a type error."
        },
        {
          "q": "Why keep a private Row struct with FromRow and map it to a public domain type with TryFrom, instead of deriving FromRow on the public type?",
          "options": [
            "sqlx::FromRow cannot be derived for a type that is public outside the crate",
            "query_as! only accepts row structs declared in the same module as the query",
            "Domain types cannot implement Display, so a FromRow derive would not compile",
            "Column names and nullability stop leaking; TryFrom is the single place invariants are enforced"
          ],
          "answer": 3,
          "explain": "The Row mirrors the table, the domain type is the contract. TryFrom is pure, so validation is unit-testable without Postgres and a later column rename stays inside the adapter."
        }
      ]
    },
    {
      "id": "d04",
      "n": 4,
      "title": "Redis caching: cache-aside, TTLs and stampedes",
      "minutes": 80,
      "level": "advanced",
      "goal": "Cache reads without turning Redis into a single point of failure, and invalidate in an order that cannot resurrect stale data.",
      "sections": [
        {
          "h": "Cache-aside, with the outage path designed first",
          "p": [
            "Cache-aside is three lines: read the key, on a miss query the source of truth, write the result back with a TTL. It is popular because the cache can die and the service still works, but only if you write the error path deliberately. A Redis timeout must degrade to a database read, not a 500.",
            "redis-rs 1.x gives you aio::ConnectionManager, which wraps a multiplexed connection, clones cheaply, pipelines concurrent commands and reconnects in the background. Clone it into handlers instead of putting a single Connection behind a Mutex: a mutex serializes every cache call in the process and turns Redis into a global bottleneck."
          ],
          "code": "use redis::AsyncCommands;\n\npub async fn account_email(\n    cache: &redis::aio::ConnectionManager,\n    pool: &sqlx::PgPool,\n    id: uuid::Uuid,\n) -> anyhow::Result<String> {\n    let key = format!(\"v1:account:email:{id}\");\n    let mut conn = cache.clone(); // cheap: clone the multiplexed handle\n\n    match conn.get::<_, Option<String>>(&key).await {\n        Ok(Some(email)) => return Ok(email),\n        Ok(None) => {}\n        // A cache outage must not become a request outage.\n        Err(err) => tracing::warn!(%err, \"cache read failed, falling back to postgres\"),\n    }\n\n    let email: String = sqlx::query_scalar(\"SELECT email FROM accounts WHERE id = $1\")\n        .bind(id)\n        .fetch_one(pool)\n        .await?;\n\n    // (key, value, seconds); the TTL is the only thing preventing permanent staleness\n    if let Err(err) = conn.set_ex::<_, _, ()>(&key, &email, 300u64).await {\n        tracing::warn!(%err, \"cache write failed\");\n    }\n\n    Ok(email)\n}\n"
        },
        {
          "h": "TTLs need jitter, not a constant",
          "p": [
            "A fixed TTL synchronizes the fleet. Deploy a thousand keys at 10:00 and at 10:05 they all expire within the same few milliseconds; the resulting miss storm is indistinguishable from a cold start and can take the database down. Spread expiries by deriving a small offset from the key itself.",
            "Deriving the jitter from the key rather than a random number has two advantages: the same key gets the same TTL on every replica, and a retried request does not extend or shorten an existing key's life. Keep the base TTL short for values that change often and long for immutable lookups, and always set one: a key without a TTL is stale data with a countdown that never started."
          ],
          "code": "use std::time::Duration;\n\n/// 300s +/- 10%, derived from the key so every replica agrees and retries are stable.\npub fn ttl_for(key: &str, base_secs: u64) -> u64 {\n    let spread = base_secs / 10;\n    if spread == 0 {\n        return base_secs;\n    }\n\n    let hash = key.bytes().fold(0xcbf2_9ce4_8422_2325u64, |acc, byte| {\n        (acc ^ byte as u64).wrapping_mul(0x0000_0100_0000_01b3)\n    });\n\n    base_secs - spread + (hash % (2 * spread + 1))\n}\n\npub fn account_ttl(key: &str) -> Duration {\n    Duration::from_secs(ttl_for(key, 300))\n}\n\n#[test]\nfn jitter_stays_within_ten_percent() {\n    for key in [\"v1:account:a\", \"v1:account:b\", \"v1:account:c\"] {\n        assert!((270..=330).contains(&ttl_for(key, 300)));\n    }\n}\n"
        },
        {
          "h": "Invalidate after commit, never before",
          "p": [
            "Deleting the key before the transaction commits opens a window: another reader misses, reloads the row with the old value, and writes it back. The commit then lands, but the cache now holds pre-commit data, and nothing will correct it until the TTL expires. That is why the delete goes after commit, and why it is worth making the invalidation failure loud but non-fatal.",
            "Invalidation is also the reason to version the key prefix. Renaming v1:account:{id} to v2: changes the meaning of the value; an old v1 entry read by new code is a deserialization bug or worse. Deploy the new prefix, let the old keys expire, and delete them explicitly only when you know no old replica is still serving."
          ],
          "code": "use redis::AsyncCommands;\nuse std::time::Duration;\n\npub async fn rename_account(\n    pool: &sqlx::PgPool,\n    cache: &redis::aio::ConnectionManager,\n    id: uuid::Uuid,\n    email: &str,\n) -> anyhow::Result<()> {\n    // 1. Make the change durable first.\n    let mut tx = pool.begin().await?;\n    sqlx::query(\"UPDATE accounts SET email = $1 WHERE id = $2\")\n        .bind(email)\n        .bind(id)\n        .execute(&mut *tx)\n        .await?;\n    tx.commit().await?;\n\n    // 2. Only then invalidate. Time-box it: a slow cache must not fail the write.\n    let key = format!(\"v1:account:email:{id}\");\n    let mut conn = cache.clone();\n    let _ = tokio::time::timeout(Duration::from_millis(50), conn.del::<_, ()>(&key)).await;\n\n    Ok(())\n}\n"
        },
        {
          "h": "Stampede protection with a single-flight lock",
          "p": [
            "When a hot key expires, every concurrent request misses at once and they all query the database for the same row. A SET NX lock elects one rebuilder; the losers wait briefly and re-read the cache, or serve a stale copy from a separate grace key and let the winner refresh it.",
            "The lock must expire, or a crashed process wedges the key until someone intervenes; five seconds is generous for one row lookup. Do not over-engineer the release path: the TTL is the correctness mechanism, and a compare-and-delete Lua script is only an optimization to let the next waiter proceed sooner."
          ],
          "code": "use redis::{AsyncCommands, ExistenceCheck, SetExpiry, SetOptions};\n\n/// Returns true when this caller may rebuild the key.\npub async fn try_acquire_refresh_lock(\n    conn: &mut redis::aio::ConnectionManager,\n    key: &str,\n) -> redis::RedisResult<bool> {\n    let lock = format!(\"lock:{key}\");\n    let token = uuid::Uuid::new_v4().to_string();\n\n    // SET lock <token> NX EX 5: one winner, and the lock cannot outlive 5s\n    let won: Option<String> = conn\n        .set_options(\n            &lock,\n            &token,\n            SetOptions::default()\n                .conditional_set(ExistenceCheck::NX)\n                .with_expiration(SetExpiry::EX(5)),\n        )\n        .await?;\n\n    Ok(won.is_some())\n}\n",
          "tip": "Losers should sleep 20-50ms and re-read the cache rather than query the database. If they still miss, the lock holder probably failed; add a short stale-while-revalidate grace window so latency stays flat."
        }
      ],
      "exercise": {
        "prompt": "Implement cached_email: cache-aside with a jittered TTL, one Postgres fallback, and no path where a Redis error returns an error to the caller. Report the hit or miss to tracing.",
        "starter": "use redis::AsyncCommands;\n\npub async fn cached_email(\n    cache: &redis::aio::ConnectionManager,\n    pool: &sqlx::PgPool,\n    id: uuid::Uuid,\n) -> anyhow::Result<String> {\n    // 1. GET v1:account:email:{id}\n    // 2. on miss: SELECT email FROM accounts WHERE id = $1\n    // 3. SET EX with a jittered TTL derived from the key\n    todo!()\n}\n",
        "hint": "Clone the ConnectionManager per call. Match on Ok(Some) / Ok(None) / Err, log the Err and continue to Postgres. Use set_ex with ttl_for(&key, 300).",
        "solution": "use redis::AsyncCommands;\n\npub async fn cached_email(\n    cache: &redis::aio::ConnectionManager,\n    pool: &sqlx::PgPool,\n    id: uuid::Uuid,\n) -> anyhow::Result<String> {\n    let key = format!(\"v1:account:email:{id}\");\n    let mut conn = cache.clone();\n\n    match conn.get::<_, Option<String>>(&key).await {\n        Ok(Some(email)) => {\n            tracing::info!(%id, \"cache hit\");\n            return Ok(email);\n        }\n        Ok(None) => tracing::info!(%id, \"cache miss\"),\n        Err(err) => tracing::warn!(%err, \"cache unavailable; reading postgres\"),\n    }\n\n    let email: String = sqlx::query_scalar(\"SELECT email FROM accounts WHERE id = $1\")\n        .bind(id)\n        .fetch_one(pool)\n        .await?;\n\n    let ttl = ttl_for(&key, 300);\n    if let Err(err) = conn.set_ex::<_, _, ()>(&key, &email, ttl).await {\n        tracing::warn!(%err, \"cache write failed; serving the fresh value anyway\");\n    }\n\n    Ok(email)\n}\n"
      },
      "production": [
        "Treat Redis as unavailable by design: every cache call has a timeout and a database fallback, and a cache outage never becomes a 5xx",
        "Invalidate or rewrite keys only after the database transaction commits, so a concurrent reader cannot repopulate pre-commit data",
        "Version cache keys (v1:, v2:) whenever the cached shape or meaning changes, so rollouts cannot decode old values as new ones",
        "Jitter every TTL by 5-10% and alert on hit ratio: a sudden drop is usually an invalidation bug, not a traffic change",
        "Use ConnectionManager or MultiplexedConnection, never one Connection behind a Mutex, and set a connect/response timeout so a hung Redis does not hang the pool"
      ],
      "crates": [
        "redis",
        "sqlx",
        "tokio",
        "tracing"
      ],
      "pitfall": "Caching a negative result with the normal TTL turns a race into an outage: a signup request checks the email, finds nothing, caches `absent` for five minutes, and the account created one second later is invisible to every login attempt until the key expires.",
      "resources": [
        {
          "title": "redis-rs async module: ConnectionManager, MultiplexedConnection",
          "url": "https://docs.rs/redis/latest/redis/aio/index.html",
          "kind": "docs"
        },
        {
          "title": "redis::aio::ConnectionManager: reconnect behaviour and configuration",
          "url": "https://docs.rs/redis/latest/redis/aio/struct.ConnectionManager.html",
          "kind": "docs"
        },
        {
          "title": "Redis SET: NX, EX, GET options in detail",
          "url": "https://redis.io/docs/latest/commands/set/",
          "kind": "docs"
        },
        {
          "title": "Scaling Memcache at Facebook (USENIX NSDI 13): leases and stampede control",
          "url": "https://www.usenix.org/conference/nsdi13/technical-sessions/presentation/nishtala",
          "kind": "paper"
        },
        {
          "title": "Cache-Aside Pattern + Stampede Protection, step by step (Milan Jovanovic)",
          "url": "https://www.youtube.com/watch?v=CVQz0E33ft4",
          "kind": "video"
        }
      ],
      "github": [
        {
          "name": "redis-rs",
          "url": "https://github.com/redis-rs/redis-rs"
        }
      ],
      "quickbytes": [
        "A Redis timeout must fall through to Postgres; a cache error is never a 5xx.",
        "Jitter TTLs by 5-10% from a hash of the key, so replicas agree and retries are stable.",
        "Invalidate the key after COMMIT, never before, or a reader can repopulate stale data."
      ],
      "questions": [
        {
          "q": "rename_account commits the new email and then deletes the cache key. If the delete ran before the commit instead, what breaks?",
          "options": [
            "Redis rejects DEL inside a transaction, so the email update is lost entirely",
            "The delete and the commit deadlock, and Postgres aborts the write",
            "The key is deleted twice, so every subsequent read misses and the hit ratio collapses",
            "A reader misses, reloads the pre-commit row, writes it back, and the cache stays stale until the TTL"
          ],
          "answer": 3,
          "explain": "Invalidation must follow the commit. Deleting first opens a window where a concurrent reader repopulates the old value after the delete, and only expiry repairs it."
        },
        {
          "q": "A hot key expires and 500 requests miss in the same instant. Which mechanism actually bounds the database load?",
          "options": [
            "SET lock <token> NX EX 5 elects one rebuilder; the losers wait and re-read the cache",
            "A longer TTL, because fewer expiries mean fewer misses",
            "A larger Postgres pool, so all 500 reloads complete in parallel",
            "Pipelining the GETs on one multiplexed connection"
          ],
          "answer": 0,
          "explain": "Single-flight collapses the herd into one source query. A longer TTL only delays the same expiry, and a bigger pool moves the overload into Postgres instead of removing it."
        }
      ]
    },
    {
      "id": "d05",
      "n": 5,
      "title": "Query performance: keyset pagination, EXPLAIN, indexes",
      "minutes": 90,
      "level": "advanced",
      "goal": "Replace OFFSET paging with a stable cursor, read a query plan without guessing, and delete N+1 queries before they multiply.",
      "sections": [
        {
          "h": "OFFSET is linear work for a constant result",
          "p": [
            "OFFSET 100000 does not jump to row 100000. Postgres produces the first 100020 rows and throws 100000 away, so page depth costs the same as reading the whole prefix. It is also unstable: insert one row above the current page and every later row shifts down, so the next page repeats a row; delete one and a row is skipped. Both pages look valid.",
            "Keyset pagination encodes the last row you saw and asks for rows strictly after it. With a composite index matching (created_at DESC, id DESC) the scan starts at the cursor and reads only the page. The id tiebreaker is not optional: several rows can share a timestamp, and without it the cursor is ambiguous and rows can repeat or vanish."
          ],
          "code": "use chrono::{DateTime, Utc};\n\n#[derive(Debug, sqlx::FromRow)]\npub struct PostRow {\n    pub id: uuid::Uuid,\n    pub author_id: uuid::Uuid,\n    pub title: String,\n    pub created_at: DateTime<Utc>,\n}\n\npub async fn feed(\n    pool: &sqlx::PgPool,\n    cursor: Option<(DateTime<Utc>, uuid::Uuid)>,\n    limit: i64,\n) -> sqlx::Result<Vec<PostRow>> {\n    match cursor {\n        Some((created_at, id)) => {\n            // Row-value comparison is index-usable and matches ORDER BY exactly.\n            sqlx::query_as::<_, PostRow>(\n                r#\"SELECT id, author_id, title, created_at\n                   FROM posts\n                   WHERE (created_at, id) < ($1, $2)\n                   ORDER BY created_at DESC, id DESC\n                   LIMIT $3\"#,\n            )\n            .bind(created_at)\n            .bind(id)\n            .bind(limit)\n            .fetch_all(pool)\n            .await\n        }\n        None => {\n            sqlx::query_as::<_, PostRow>(\n                r#\"SELECT id, author_id, title, created_at\n                   FROM posts\n                   ORDER BY created_at DESC, id DESC\n                   LIMIT $1\"#,\n            )\n            .bind(limit)\n            .fetch_all(pool)\n            .await\n        }\n    }\n}\n"
        },
        {
          "h": "Read the plan, not the query",
          "p": [
            "EXPLAIN ANALYZE executes the statement and shows, per node, the estimated rows, the actual rows, the loops and the buffers touched. The numbers to distrust are the estimates: when a node says rows=1 and the actual is rows=48000, the planner chose a nested loop for the wrong reason and the fix is usually a missing or non-matching index, or stale statistics.",
            "Three signals cover most slow queries: a Seq Scan on a large table, a Sort node whose method is external merge (spilling to disk), and a nested loop with a high loops count doing thousands of index lookups. Buffers: shared read tells you the page cache miss cost; Rows Removed by Filter tells you the index was not selective enough for the predicate."
          ],
          "code": "-- always ANALYZE on real data volumes; BUFFERS shows the I/O the planner assumed\nEXPLAIN (ANALYZE, BUFFERS)\nSELECT id, title\nFROM posts\nWHERE (created_at, id) < ('2026-04-01 00:00:00+00', '018f3b1e-0000-7000-8000-000000000000')\nORDER BY created_at DESC, id DESC\nLIMIT 20;\n",
          "list": [
            "Index Scan using posts_feed_idx, with the LIMIT applied above it and no Sort node",
            "actual rows close to the estimate; a 1000x gap means outdated statistics or a bad plan",
            "Buffers: shared hit dominates after warmup; large read counts mean cold cache, not a bad query",
            "No Rows Removed by Filter: the index did the filtering, the heap fetch did not",
            "loops=1 on every node; loops in the thousands means a nested loop over too many outer rows"
          ]
        },
        {
          "h": "Indexes are shaped by the predicate",
          "p": [
            "A composite index is only usable if the query constrains its leading columns in order. (created_at DESC, id DESC) serves the feed query; a separate index on created_at alone would require a sort of all rows sharing that timestamp. Ordering inside the index must match the ORDER BY, or Postgres adds a Sort on top of the scan.",
            "Partial indexes are the cheapest win on soft-deletable tables: WHERE deleted_at IS NULL makes the index a fraction of the table and keeps dead rows out of the hot path. Covering indexes with INCLUDE let a scan answer from the index alone (Index Only Scan) when the extra columns are payload, not predicates. Every index also costs writes and cache space, so check pg_stat_user_indexes.idx_scan before adding another."
          ],
          "code": "-- matches the keyset predicate and its ORDER BY, so the plan has no Sort\nCREATE INDEX CONCURRENTLY posts_feed_idx\n    ON posts (created_at DESC, id DESC);\n\n-- soft-deleted rows are most of the table; keep them out of the hot index\nCREATE INDEX CONCURRENTLY posts_visible_idx\n    ON posts (created_at DESC, id DESC)\n    WHERE deleted_at IS NULL;\n\n-- index-only scan: the page query never touches the heap\nCREATE INDEX CONCURRENTLY posts_cover_idx\n    ON posts (created_at DESC, id DESC) INCLUDE (title);\n",
          "tip": "CREATE INDEX CONCURRENTLY cannot run inside a transaction block. In sqlx, that means its own migration file with `-- no-transaction` as the first line."
        },
        {
          "h": "Kill N+1 with set-based fetches",
          "p": [
            "The classic N+1 is a loop that queries inside a loop: 50 posts, then one author lookup per post, 51 round trips. On a LAN the latency is tolerable; across an availability zone with TLS, it is the whole request budget. Fetch the distinct parent ids once with = ANY($1) and join in memory.",
            "Batch deliberately: chunk huge id lists (a few thousand ids per statement) to keep the parameter count and plan sane, and keep the mapping step explicit so a missing parent is a visible error rather than a silent empty field. One query returning 50 rows and one returning 12 is always cheaper than 51 queries returning one row each."
          ],
          "code": "use std::collections::HashMap;\n\n#[derive(Debug, sqlx::FromRow)]\npub struct AuthorRow {\n    pub id: uuid::Uuid,\n    pub name: String,\n}\n\npub async fn authors_for(\n    pool: &sqlx::PgPool,\n    posts: &[PostRow],\n) -> sqlx::Result<HashMap<uuid::Uuid, String>> {\n    let mut ids: Vec<uuid::Uuid> = posts.iter().map(|post| post.author_id).collect();\n    ids.sort_unstable();\n    ids.dedup();\n\n    // One round trip, independent of the page size.\n    let rows = sqlx::query_as::<_, AuthorRow>(\n        \"SELECT id, name FROM authors WHERE id = ANY($1)\",\n    )\n    .bind(&ids)\n    .fetch_all(pool)\n    .await?;\n\n    Ok(rows.into_iter().map(|row| (row.id, row.name)).collect())\n}\n"
        }
      ],
      "exercise": {
        "prompt": "Write feed_page(pool, cursor, limit) returning the rows plus the cursor for the next page. A row inserted between two page reads must not be duplicated, and a deleted row must not cause a skip.",
        "starter": "pub async fn feed_page(\n    pool: &sqlx::PgPool,\n    cursor: Option<(chrono::DateTime<chrono::Utc>, uuid::Uuid)>,\n    limit: i64,\n) -> sqlx::Result<(Vec<PostRow>, Option<(chrono::DateTime<chrono::Utc>, uuid::Uuid)>)> {\n    // reuse the WHERE (created_at, id) < ($1, $2) pattern, then build the next\n    // cursor from the last row returned\n    todo!()\n}\n",
        "hint": "Fetch all rows, then take last().map(|row| (row.created_at, row.id)). Return None when fewer than `limit` rows came back, or when the page is empty.",
        "solution": "use chrono::{DateTime, Utc};\n\npub async fn feed_page(\n    pool: &sqlx::PgPool,\n    cursor: Option<(DateTime<Utc>, uuid::Uuid)>,\n    limit: i64,\n) -> sqlx::Result<(Vec<PostRow>, Option<(DateTime<Utc>, uuid::Uuid)>)> {\n    let rows = feed(pool, cursor, limit).await?;\n\n    let next = rows.last().map(|row| (row.created_at, row.id));\n    Ok((rows, next))\n}\n\n// The cursor is the last row's sort key. Because the predicate is strict (<),\n// the next page starts after it, so an insert above the cursor shifts nothing\n// into or out of the page we already returned.\n"
      },
      "production": [
        "Paginate with (sort_key, id) cursors; never let a request specify an offset beyond a few hundred rows",
        "Prove each hot query with EXPLAIN (ANALYZE, BUFFERS): index scan, no Sort, no Rows Removed by Filter, actual rows near the estimate",
        "Match composite index order to the predicate and ORDER BY, use partial indexes for soft deletes, and INCLUDE payload columns for index-only scans",
        "Check pg_stat_user_indexes.idx_scan before adding an index and remove unused ones; every index is write amplification and cache pressure",
        "Batch child lookups with = ANY($1) in chunks, so a 50-row page costs two queries instead of fifty-one"
      ],
      "crates": [
        "sqlx",
        "uuid",
        "chrono"
      ],
      "pitfall": "OFFSET pagination silently duplicates and skips rows: insert one row above the current page and every later row shifts down by one, so page 2 repeats the last row of page 1, and the API has no way to tell because both pages are internally valid.",
      "resources": [
        {
          "title": "PostgreSQL: using EXPLAIN and EXPLAIN ANALYZE (actual rows, buffers, loops)",
          "url": "https://www.postgresql.org/docs/current/using-explain.html",
          "kind": "docs"
        },
        {
          "title": "sqlx::query_as!: binding arrays and mapping rows to structs",
          "url": "https://docs.rs/sqlx/0.8.6/sqlx/macro.query_as.html",
          "kind": "docs"
        },
        {
          "title": "sqlx on crates.io (0.8.x release line)",
          "url": "https://crates.io/crates/sqlx",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: CREATE INDEX, CONCURRENTLY, INCLUDE and index-only scans",
          "url": "https://www.postgresql.org/docs/current/sql-createindex.html",
          "kind": "docs"
        },
        {
          "title": "Keyset Pagination in Practice: cursors, previous page, filters (PostgreSQL)",
          "url": "https://www.youtube.com/watch?v=gcld3wi7hto",
          "kind": "video"
        }
      ],
      "github": [
        {
          "name": "sqlx",
          "url": "https://github.com/transact-rs/sqlx"
        }
      ],
      "quickbytes": [
        "WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT $3 matches the composite index.",
        "CREATE INDEX CONCURRENTLY needs its own migration file starting with -- no-transaction.",
        "Check pg_stat_user_indexes.idx_scan before adding an index, and drop the ones nothing reads."
      ],
      "questions": [
        {
          "q": "The cursor is (created_at, id) with WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC. Why include id rather than comparing created_at alone?",
          "options": [
            "Timestamps collide; without the tiebreaker the strict comparison is ambiguous and rows repeat or vanish",
            "Postgres requires the ORDER BY to include the primary key before it will use an index scan",
            "id makes the cursor tamper-proof, since clients could otherwise edit the timestamp",
            "It lets the query use OFFSET internally while returning keyset-shaped results"
          ],
          "answer": 0,
          "explain": "Rows can share created_at, so a timestamp-only cursor has no total order. The composite comparison plus the matching index makes page two start strictly after the last row of page one."
        },
        {
          "q": "EXPLAIN ANALYZE shows a nested loop with loops=48000; the planner estimated 1 row per loop and 50 outer rows, but the outer node actually produced 48000. What is the first fix?",
          "options": [
            "Add a LIMIT, because the plan is correct and the query simply returns too many rows",
            "Refresh statistics and check the predicate index; a bad cardinality estimate chose the loop shape",
            "Raise work_mem so the nested loop can spill its intermediate rows to disk",
            "Raise shared_buffers, because loops counts buffer misses rather than iterations"
          ],
          "answer": 1,
          "explain": "A 1000x estimate gap means the planner picked the join shape on wrong row counts. ANALYZE and a matching index fix the estimate; memory settings do not change how many rows it thinks exist."
        }
      ]
    },
    {
      "id": "d06",
      "n": 6,
      "title": "Object storage: presigned URLs, multipart, streaming",
      "minutes": 100,
      "level": "industry",
      "goal": "Move large objects without buffering them in memory, let clients transfer bytes directly, and clean up the uploads that fail.",
      "sections": [
        {
          "h": "One client for the process, a stream for the body",
          "p": [
            "aws-sdk-s3's Client owns a connection pool and its construction is expensive, so build it once at startup and pass a reference or clone it into handlers. The operation builders are cheap; the client is not.",
            "The body of an upload is a ByteStream, which can wrap memory, a file handle, or an HTTP body. ByteStream::from_path streams from disk and is retryable: on a retried request the SDK reopens the file and can resume from a partial write. Collecting a 2 GiB object into a Vec<u8> first is how a single upload turns into an OOM kill of the whole process."
          ],
          "code": "use anyhow::Result;\nuse aws_sdk_s3::primitives::ByteStream;\nuse aws_sdk_s3::Client;\n\n/// Construct Client once at startup: it owns a connection pool.\npub async fn put_file(\n    client: &Client,\n    bucket: &str,\n    key: &str,\n    path: &std::path::Path,\n) -> Result<()> {\n    client\n        .put_object()\n        .bucket(bucket)\n        .key(key)\n        .body(ByteStream::from_path(path).await?)\n        .send()\n        .await?;\n\n    Ok(())\n}\n",
          "tip": "Add a checksum when you upload (CRC32C is the AWS default recommendation) so a corrupted transfer fails at the API instead of being discovered by a user."
        },
        {
          "h": "Presigned URLs put the bytes on the client",
          "p": [
            "Presigning produces a URL that carries a SigV4 signature, so the holder can perform exactly one operation on exactly one key until it expires. Use it for uploads too: the browser or mobile client PUTs straight to storage, and your service never proxies gigabytes or holds a request open.",
            "Only operations that support presigning have the .presigned() method, and it replaces .send(). PresigningConfig::expires_in caps the lifetime, but the effective expiry is the earlier of that and the expiry of the credentials that signed the URL. Keep it at 5-15 minutes, and treat the URL as a secret: it is a bearer token for that object and it ends up in browser history and proxy logs."
          ],
          "code": "use anyhow::{Context, Result};\nuse aws_sdk_s3::presigning::PresigningConfig;\nuse std::time::Duration;\n\npub async fn download_url(\n    client: &aws_sdk_s3::Client,\n    bucket: &str,\n    key: &str,\n) -> Result<String> {\n    let config = PresigningConfig::expires_in(Duration::from_secs(300))\n        .context(\"invalid presigning duration\")?;\n\n    let request = client\n        .get_object()\n        .bucket(bucket)\n        .key(key)\n        .presigned(config)\n        .await?;\n\n    // method() is \"GET\"; any extra headers() must be sent with the request.\n    Ok(request.uri().to_string())\n}\n"
        },
        {
          "h": "Multipart for anything large or resumable",
          "p": [
            "A single PUT is fine for small objects; multipart splits the object into parts that can be uploaded in parallel, retried independently, and resumed. Each part except the last must be at least 5 MiB and there can be at most 10,000 parts, so part size is a function of object size, not a constant you pick casually.",
            "Complete the upload with the ETag of every part, in part-number order. If anything fails before completion, abort the upload: unfinished multipart parts are billed as storage, do not appear in object listings, and silently accumulate. A lifecycle rule that aborts incomplete uploads after a few days is not optional in production."
          ],
          "code": "use anyhow::{anyhow, Result};\nuse aws_sdk_s3::primitives::ByteStream;\nuse aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart};\nuse aws_sdk_s3::Client;\n\npub async fn upload_large(\n    client: &Client,\n    bucket: &str,\n    key: &str,\n    data: &[u8],\n) -> Result<()> {\n    let created = client\n        .create_multipart_upload()\n        .bucket(bucket)\n        .key(key)\n        .send()\n        .await?;\n    let upload_id = created.upload_id().ok_or_else(|| anyhow!(\"missing upload_id\"))?;\n\n    let part_size = 8 * 1024 * 1024; // 5 MiB minimum for every part except the last\n    let mut parts = Vec::new();\n\n    for (index, chunk) in data.chunks(part_size).enumerate() {\n        let part_number = index as i32 + 1;\n        let part = client\n            .upload_part()\n            .bucket(bucket)\n            .key(key)\n            .upload_id(upload_id)\n            .part_number(part_number)\n            .body(ByteStream::from(chunk.to_vec()))\n            .send()\n            .await?;\n\n        parts.push(\n            CompletedPart::builder()\n                .part_number(part_number)\n                .set_e_tag(part.e_tag().map(str::to_owned))\n                .build(),\n        );\n    }\n\n    let completed = CompletedMultipartUpload::builder()\n        .set_parts(Some(parts))\n        .build();\n\n    client\n        .complete_multipart_upload()\n        .bucket(bucket)\n        .key(key)\n        .upload_id(upload_id)\n        .multipart_upload(completed)\n        .send()\n        .await?;\n\n    Ok(())\n}\n"
        },
        {
          "h": "Stream downloads; never collect them",
          "p": [
            "A GetObject response body is itself a ByteStream. Converting it with into_async_read and handing it to an HTTP body streams the object through your service with flat memory, which is the difference between serving a 4 GiB video and dying on it. body.collect() does the opposite: it reads everything into memory before your handler returns.",
            "Better still, skip the proxy: redirect the client to a short-lived presigned GET and let storage serve the bytes. When you must proxy (authorisation checks per byte range, or a private network path), keep the stream and forward the Content-Length and Accept-Ranges headers so clients can resume."
          ],
          "code": "use anyhow::Result;\nuse aws_sdk_s3::Client;\nuse tokio_util::io::ReaderStream;\n\npub async fn download(\n    client: &Client,\n    bucket: &str,\n    key: &str,\n) -> Result<axum::body::Body> {\n    let object = client.get_object().bucket(bucket).key(key).send().await?;\n\n    // Memory stays flat: the SDK yields chunks, ReaderStream forwards them.\n    let stream = ReaderStream::new(object.body.into_async_read());\n    Ok(axum::body::Body::from_stream(stream))\n}\n",
          "tip": "If you also need the object size for Content-Length, call head_object first (one small request) rather than buffering the body to measure it."
        }
      ],
      "exercise": {
        "prompt": "Implement presign_upload returning a URL and method a browser can use to PUT a file for ten minutes. The upload must be constrained to a content type and must not grant read access.",
        "starter": "use anyhow::Result;\n\npub async fn presign_upload(\n    client: &aws_sdk_s3::Client,\n    bucket: &str,\n    key: &str,\n    content_type: &str,\n) -> Result<(String, String)> {\n    // PresigningConfig::expires_in(Duration::from_secs(600))\n    // client.put_object()...content_type(content_type).presigned(config)\n    todo!()\n}\n",
        "hint": "put_object is presignable. Attach .content_type(...) before .presigned(config), then return (request.method().to_owned(), request.uri().to_owned()).",
        "solution": "use anyhow::{Context, Result};\nuse aws_sdk_s3::presigning::PresigningConfig;\nuse std::time::Duration;\n\npub async fn presign_upload(\n    client: &aws_sdk_s3::Client,\n    bucket: &str,\n    key: &str,\n    content_type: &str,\n) -> Result<(String, String)> {\n    let config = PresigningConfig::expires_in(Duration::from_secs(600))\n        .context(\"invalid presigning duration\")?;\n\n    let request = client\n        .put_object()\n        .bucket(bucket)\n        .key(key)\n        .content_type(content_type) // becomes a signed header the client must send\n        .presigned(config)\n        .await?;\n\n    Ok((request.method().to_owned(), request.uri().to_owned()))\n}\n\n// The URL only permits PUT on this one key; it grants no read access and\n// expires in ten minutes (or earlier if the signing credentials expire first).\n"
      },
      "production": [
        "Presign server-side with 5-15 minute expiry, log every issuance, and treat the URL as a bearer token; it lands in browser history and proxy logs",
        "Block public access at the account and bucket level; grant reads through presigned GETs or a CDN with origin access control, never a public-read ACL",
        "Add a lifecycle rule that aborts incomplete multipart uploads after a few days, and abort explicitly on every error path",
        "Stream both directions (ByteStream::from_path, into_async_read); collecting a body puts the object size in the critical path of your RSS",
        "Pin part size from object size (>= 5 MiB, <= 10,000 parts) and set a checksum at create_multipart_upload time so corruption fails loudly"
      ],
      "crates": [
        "aws-sdk-s3",
        "aws-config",
        "tokio",
        "tokio-util"
      ],
      "pitfall": "An aborted upload that is never aborted leaves its parts billed as storage forever: they are invisible to list_objects, so the only way to find them is list_multipart_uploads or a lifecycle rule that would have cleaned them up.",
      "resources": [
        {
          "title": "aws_sdk_s3::presigning: presigned requests and configuration",
          "url": "https://docs.rs/aws-sdk-s3/latest/aws_sdk_s3/presigning/index.html",
          "kind": "docs"
        },
        {
          "title": "PresigningConfig: expires_in and credential-expiry precedence",
          "url": "https://docs.rs/aws-sdk-s3/latest/aws_sdk_s3/presigning/struct.PresigningConfig.html",
          "kind": "docs"
        },
        {
          "title": "ByteStream: from_path, collect, into_async_read",
          "url": "https://docs.rs/aws-sdk-s3/latest/aws_sdk_s3/primitives/struct.ByteStream.html",
          "kind": "docs"
        },
        {
          "title": "aws_sdk_s3::Client: operation builders and construction guidance",
          "url": "https://docs.rs/aws-sdk-s3/latest/aws_sdk_s3/struct.Client.html",
          "kind": "docs"
        },
        {
          "title": "Amazon S3 Presigned URLs: uploads and downloads tutorial (Milan Jovanovic)",
          "url": "https://www.youtube.com/watch?v=V2arOZ72d6M",
          "kind": "video"
        }
      ],
      "github": [
        {
          "name": "aws-sdk-rust",
          "url": "https://github.com/awslabs/aws-sdk-rust"
        }
      ],
      "quickbytes": [
        "ByteStream::from_path streams from disk and is retryable; body.collect() puts the object in RAM.",
        "Presign for 5-15 minutes and log every issuance; the URL is a bearer token that lands in proxy logs.",
        "Abort failed multipart uploads explicitly, and add a lifecycle rule for the ones you miss."
      ],
      "questions": [
        {
          "q": "You presign a PUT with .content_type(\"image/png\"). The browser uploads without sending a Content-Type header. What does S3 do?",
          "options": [
            "Accepts it, and fails only when the object is later downloaded",
            "Rejects it with 403 SignatureDoesNotMatch, because a signed header is missing",
            "Accepts it and stores the object as application/octet-stream",
            "Accepts it and rewrites the stored content type to image/png"
          ],
          "answer": 1,
          "explain": "Headers attached before .presigned() are part of the SigV4 signature. The client must send exactly those headers, so return them alongside the URL and document the requirement."
        },
        {
          "q": "A process uploads 40 parts, then crashes before complete_multipart_upload and nobody aborts. What is the state of that upload?",
          "options": [
            "The object appears with size 0 and can be replaced by an ordinary PUT",
            "The parts are merged by the next complete_multipart_upload call from any client that knows the key",
            "Parts are billed as storage and stay invisible to list_objects until a lifecycle rule aborts the upload",
            "S3 discards incomplete multipart uploads automatically after 24 hours"
          ],
          "answer": 2,
          "explain": "Incomplete uploads persist indefinitely and are only visible via list_multipart_uploads. Abort on every error path, and add AbortIncompleteMultipartUpload so a crash cannot leak storage forever."
        }
      ]
    },
    {
      "id": "d07",
      "n": 7,
      "title": "Integrity under concurrency: outbox, idempotency, retention",
      "minutes": 110,
      "level": "industry",
      "goal": "Make retries safe by construction, publish events only from committed state, and retire data without a billion-row DELETE.",
      "sections": [
        {
          "h": "Idempotency keys make retries free",
          "p": [
            "Networks retry. A client that times out after your commit will send the same request again, and without a key it creates a second order. An idempotency key is a client-generated identifier stored with the response it produced: the first request inserts the key, later requests with the same key replay the stored response instead of doing the work again.",
            "Store a hash of the request alongside the key. The same key with a different body is a client bug, and silently replaying the first response would hide it. The insert is an INSERT ... ON CONFLICT DO NOTHING so two concurrent retries cannot both believe they are first; whichever row wins, the loser reads the stored response."
          ],
          "code": "use serde_json::Value;\nuse sqlx::PgPool;\nuse uuid::Uuid;\n\npub enum Recorded {\n    Fresh,\n    Replay(Value),\n    Conflict,\n}\n\npub async fn record(\n    pool: &PgPool,\n    user_id: Uuid,\n    key: &str,\n    request_hash: &str,\n    response: &Value,\n) -> sqlx::Result<Recorded> {\n    let mut tx = pool.begin().await?;\n\n    let inserted = sqlx::query(\n        \"INSERT INTO idempotency_keys (key, user_id, request_hash, response)\n         VALUES ($1, $2, $3, $4)\n         ON CONFLICT (key, user_id) DO NOTHING\",\n    )\n    .bind(key)\n    .bind(user_id)\n    .bind(request_hash)\n    .bind(response)\n    .execute(&mut *tx)\n    .await?\n    .rows_affected();\n\n    if inserted == 1 {\n        tx.commit().await?;\n        return Ok(Recorded::Fresh);\n    }\n\n    let stored: Option<(String, Value)> = sqlx::query_as::<_, (String, Value)>(\n        \"SELECT request_hash, response FROM idempotency_keys\n         WHERE key = $1 AND user_id = $2\",\n    )\n    .bind(key)\n    .bind(user_id)\n    .fetch_optional(&mut *tx)\n    .await?;\n\n    tx.rollback().await?;\n\n    match stored {\n        Some((hash, value)) if hash == request_hash => Ok(Recorded::Replay(value)),\n        Some(_) => Ok(Recorded::Conflict),\n        None => Ok(Recorded::Fresh),\n    }\n}\n"
        },
        {
          "h": "The transactional outbox",
          "p": [
            "A database commit and a broker publish cannot be made atomic, so any code that does both has a failure mode: commit then crash and the event is lost, publish then rollback and the event is a lie. The outbox removes the choice by writing the event into a table inside the same transaction as the state change. Both become visible at the same instant, or neither does.",
            "A separate relay reads the outbox and publishes. Delivery becomes at-least-once, which is a weaker but honest guarantee: the relay can crash after publishing and before marking, so the same event can be published twice. Consumers dedupe on the outbox row id; that is the contract, and it is the same contract every mature event system offers."
          ],
          "code": "use sqlx::PgPool;\nuse uuid::Uuid;\n\n/// The commit is the boundary: order row and outbox row become visible together.\npub async fn place_order(\n    pool: &PgPool,\n    order_id: Uuid,\n    payload: serde_json::Value,\n) -> sqlx::Result<()> {\n    let mut tx = pool.begin().await?;\n\n    sqlx::query(\"INSERT INTO orders (id, payload) VALUES ($1, $2)\")\n        .bind(order_id)\n        .bind(&payload)\n        .execute(&mut *tx)\n        .await?;\n\n    sqlx::query(\"INSERT INTO outbox (topic, payload) VALUES ('orders.created', $1)\")\n        .bind(&payload)\n        .execute(&mut *tx)\n        .await?;\n\n    tx.commit().await?;\n    Ok(())\n}\n"
        },
        {
          "h": "The relay: claim, publish, mark",
          "p": [
            "Several relay replicas must not publish the same row, so the claim uses FOR UPDATE SKIP LOCKED: each relay locks a disjoint batch and the others move on to later rows. Marking sent in the same transaction keeps the row from being re-claimed immediately after a rollback.",
            "The residual duplicate is unavoidable and acceptable: if the process dies between publish and commit, the row is claimed again and published twice. Consumers must therefore be idempotent. If throughput matters more than holding a transaction across a network call, claim and commit first, publish, then mark in a second transaction, and accept a wider duplicate window."
          ],
          "code": "use sqlx::PgPool;\n\n#[derive(Debug, sqlx::FromRow)]\npub struct OutboxRow {\n    pub id: i64,\n    pub topic: String,\n    pub payload: serde_json::Value,\n}\n\npub async fn relay_batch(pool: &PgPool, limit: i64) -> sqlx::Result<usize> {\n    let mut tx = pool.begin().await?;\n\n    let rows = sqlx::query_as::<_, OutboxRow>(\n        r#\"SELECT id, topic, payload FROM outbox\n           WHERE sent_at IS NULL\n           ORDER BY id\n           LIMIT $1\n           FOR UPDATE SKIP LOCKED\"#,\n    )\n    .bind(limit)\n    .fetch_all(&mut *tx)\n    .await?;\n\n    for row in &rows {\n        // publish(&row.topic, &row.payload).await?;  // at-least-once\n    }\n\n    let ids: Vec<i64> = rows.iter().map(|row| row.id).collect();\n\n    sqlx::query(\"UPDATE outbox SET sent_at = now() WHERE id = ANY($1)\")\n        .bind(&ids)\n        .execute(&mut *tx)\n        .await?;\n\n    tx.commit().await?;\n    Ok(rows.len())\n}\n",
          "tip": "Index the outbox on (id) WHERE sent_at IS NULL so the relay query stays an index scan, and prune sent rows on a schedule rather than letting the table grow forever."
        },
        {
          "h": "Audit in the same transaction, version every row you edit",
          "p": [
            "An audit row written after the change in a separate transaction can disagree with the change it describes: the audit insert fails, the edit stands, and the history is wrong. Write the audit row in the same transaction and make the table append-only at the privilege level by revoking UPDATE and DELETE from the application role.",
            "For editor flows, optimistic concurrency beats a lock: every row carries a version, the UPDATE includes WHERE version = $n, and rows_affected() == 0 means someone else won and the client must reload. That single check prevents the lost-update bug without holding a row lock across a user's think time."
          ],
          "code": "use sqlx::PgPool;\n\npub async fn update_price(\n    pool: &PgPool,\n    sku: &str,\n    price_cents: i64,\n    expected_version: i32,\n) -> sqlx::Result<bool> {\n    let mut tx = pool.begin().await?;\n\n    let updated = sqlx::query(\n        \"UPDATE products\n         SET price_cents = $1, version = version + 1\n         WHERE sku = $2 AND version = $3\",\n    )\n    .bind(price_cents)\n    .bind(sku)\n    .bind(expected_version)\n    .execute(&mut *tx)\n    .await?\n    .rows_affected();\n\n    if updated == 0 {\n        tx.rollback().await?;\n        return Ok(false); // stale version: the client must reload and retry\n    }\n\n    sqlx::query(\n        \"INSERT INTO audit_log (actor, action, entity, before, after)\n         VALUES (current_user, 'product.price_changed', $1, $2, $3)\",\n    )\n    .bind(sku)\n    .bind(serde_json::json!({ \"version\": expected_version }))\n    .bind(serde_json::json!({ \"price_cents\": price_cents, \"version\": expected_version + 1 }))\n    .execute(&mut *tx)\n    .await?;\n\n    tx.commit().await?;\n    Ok(true)\n}\n"
        },
        {
          "h": "Retention: partition, detach, drop",
          "p": [
            "Retention by DELETE rewrites every row, produces dead tuples that vacuum must chase, and a single statement over a billion rows may run for hours while holding locks and WAL. Range partitioning turns retention into metadata: dropping a partition is a file unlink, and DETACH PARTITION CONCURRENTLY removes it from the parent with a much lighter lock if you want to archive it first.",
            "Pruning only works if queries filter on the partition key, so partition by the column your access pattern already constrains (usually created_at). Create partitions ahead of time, never rely on a DEFAULT partition as a landing zone during normal operation, and resist over-partitioning: each partition costs planning time and per-session metadata, and thousands of them hurt more than they help."
          ],
          "code": "-- Range partition by month; every query must filter on created_at to prune.\nCREATE TABLE events (\n    id         bigint GENERATED ALWAYS AS IDENTITY,\n    tenant_id  uuid NOT NULL,\n    kind       text NOT NULL,\n    payload    jsonb NOT NULL,\n    created_at timestamptz NOT NULL DEFAULT now()\n) PARTITION BY RANGE (created_at);\n\nCREATE TABLE events_2026_04 PARTITION OF events\n    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');\n\n-- Retention without a DELETE: detach (light lock), archive, then drop.\nALTER TABLE events DETACH PARTITION events_2025_04 CONCURRENTLY;\nDROP TABLE events_2025_04;\n"
        }
      ],
      "exercise": {
        "prompt": "Implement relay_batch(pool, limit) that claims at most `limit` unsent outbox rows with SKIP LOCKED, publishes each, marks them sent, and returns the count. Two relay replicas must never claim the same row.",
        "starter": "use sqlx::PgPool;\n\npub async fn relay_batch(pool: &PgPool, limit: i64) -> anyhow::Result<usize> {\n    // SELECT ... WHERE sent_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED\n    // publish each row, then UPDATE ... SET sent_at = now() WHERE id = ANY($1)\n    todo!()\n}\n",
        "hint": "Claim rows inside one transaction, publish in the loop, then mark all of them sent in the same transaction. Binding Vec<i64> with = ANY($1) becomes an int8[] parameter.",
        "solution": "use anyhow::Result;\nuse sqlx::PgPool;\n\n#[derive(Debug, sqlx::FromRow)]\npub struct OutboxRow {\n    pub id: i64,\n    pub topic: String,\n    pub payload: serde_json::Value,\n}\n\nasync fn publish(_topic: &str, _payload: &serde_json::Value) -> Result<()> {\n    Ok(())\n}\n\npub async fn relay_batch(pool: &PgPool, limit: i64) -> Result<usize> {\n    let mut tx = pool.begin().await?;\n\n    let rows = sqlx::query_as::<_, OutboxRow>(\n        r#\"SELECT id, topic, payload FROM outbox\n           WHERE sent_at IS NULL\n           ORDER BY id\n           LIMIT $1\n           FOR UPDATE SKIP LOCKED\"#,\n    )\n    .bind(limit)\n    .fetch_all(&mut *tx)\n    .await?;\n\n    for row in &rows {\n        publish(&row.topic, &row.payload).await?;\n    }\n\n    if !rows.is_empty() {\n        let ids: Vec<i64> = rows.iter().map(|row| row.id).collect();\n        sqlx::query(\"UPDATE outbox SET sent_at = now() WHERE id = ANY($1)\")\n            .bind(&ids)\n            .execute(&mut *tx)\n            .await?;\n    }\n\n    tx.commit().await?;\n    Ok(rows.len())\n}\n\n// SKIP LOCKED gives each relay replica a disjoint batch, so the same row is\n// never published by two workers at once. A crash after publish and before\n// commit re-delivers the batch: consumers dedupe on id, which is why delivery\n// is at-least-once rather than exactly-once.\n"
      },
      "production": [
        "Write the outbox row in the same transaction as the state change; never publish inside a transaction, because a broker cannot participate in a rollback",
        "Make every consumer idempotent and dedupe on the outbox row id: at-least-once is the strongest contract an outbox plus a broker can offer",
        "Store the original response body with the idempotency key and replay it verbatim; recomputing can return a different answer than the first call",
        "Use WHERE version = $n plus a rows_affected check for editor flows, instead of read-modify-write or a row lock held across user think time",
        "Partition append-only tables by time and retire data with DETACH/DROP; alert when the newest partition is missing or filling faster than the retention window assumes"
      ],
      "crates": [
        "sqlx",
        "uuid",
        "serde_json",
        "tokio"
      ],
      "pitfall": "Publishing to the broker inside the transaction is the classic outbox bug: Kafka or SQS cannot be rolled back. Consumers react to an order that the database then rolls back, and the two systems diverge permanently with no record of what went wrong.",
      "resources": [
        {
          "title": "PostgreSQL: table partitioning, pruning and DETACH PARTITION",
          "url": "https://www.postgresql.org/docs/current/ddl-partitioning.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: isolation levels, snapshots and commit visibility",
          "url": "https://www.postgresql.org/docs/current/transaction-iso.html",
          "kind": "docs"
        },
        {
          "title": "sqlx Transaction: commit, rollback and Drop behaviour",
          "url": "https://docs.rs/sqlx/0.8.6/sqlx/struct.Transaction.html",
          "kind": "docs"
        },
        {
          "title": "sqlx on crates.io (0.8.x release line)",
          "url": "https://crates.io/crates/sqlx",
          "kind": "docs"
        },
        {
          "title": "What is the Transactional Outbox Pattern? (Confluent)",
          "url": "https://www.youtube.com/watch?v=5YLpjPmsPCA",
          "kind": "video"
        }
      ],
      "github": [
        {
          "name": "sqlx",
          "url": "https://github.com/transact-rs/sqlx"
        }
      ],
      "quickbytes": [
        "INSERT ... ON CONFLICT (key, user_id) DO NOTHING makes the second concurrent retry a reader of the stored response.",
        "Consumers dedupe on the outbox row id; the relay promises at-least-once, never exactly-once.",
        "Retire time-series data with DETACH PARTITION CONCURRENTLY then DROP, not a billion-row DELETE."
      ],
      "questions": [
        {
          "q": "An order commits, then the service crashes before publishing to the broker. With the transactional outbox, what happens instead?",
          "options": [
            "The relay rolls the order back once it notices the event was never published",
            "The client's retry publishes the event, so the outbox only matters for auditing",
            "The event row committed with the order, so the relay publishes it after restart",
            "The broker replays the missing event from the database transaction log"
          ],
          "answer": 2,
          "explain": "The outbox makes the state change and the event one commit. Publishing after commit without an outbox is exactly the lost-event window the pattern removes."
        },
        {
          "q": "A retry arrives with the same Idempotency-Key but a request body whose hash differs from the stored one. What should the service return?",
          "options": [
            "The stored response from the first request, so the call stays idempotent",
            "A fresh execution that overwrites the stored key with the new body",
            "A 500, because the unique constraint will raise a database error",
            "A conflict (409/422): the same key with a different payload is a client bug, not a replay"
          ],
          "answer": 3,
          "explain": "Replaying a response for a different request hides a real bug. Compare the stored request hash and reject the mismatch while the key is still live."
        }
      ]
    },
    {
      "id": "d08",
      "n": 8,
      "title": "Read replicas: routing reads and a lag budget",
      "minutes": 80,
      "level": "industry",
      "goal": "Send reads to standbys deliberately, keep a lag budget, and recover read-your-writes without pushing every request to the primary.",
      "sections": [
        {
          "h": "A standby replays WAL; it does not run your workload for free",
          "p": [
            "Streaming replication ships WAL records to a standby, which replays them block by block. The standby is a real Postgres server, but it is in recovery: SELECT and COPY TO work, while INSERT, DDL, nextval and even temporary tables do not. The only transactions you can start are read-only.",
            "So every read has to be classified before it is routed. A feed page, a report or a search query is a good candidate. A read that gates a write is not: checking whether an email exists before inserting it, or re-reading a row you just committed, can observe the pre-commit state for as long as the standby is behind."
          ],
          "code": "-- On the standby: how far behind is replay?\nSELECT\n    pg_last_wal_receive_lsn()                       AS received,\n    pg_last_wal_replay_lsn()                        AS replayed,\n    pg_wal_lsn_diff(pg_last_wal_receive_lsn(),\n                    pg_last_wal_replay_lsn())       AS lag_bytes;\n\n-- On the primary: per-standby progress and any replay conflicts\nSELECT application_name, state, sent_lsn, replay_lsn, replay_lag\nFROM pg_stat_replication;\n",
          "tip": "pg_last_xact_replay_timestamp() measures the age of the last replayed commit, so it grows without bound on an idle primary. Alert on byte lag from a heartbeat table, not on that timestamp."
        },
        {
          "h": "Two pools, one decision point",
          "p": [
            "Build a writer pool and a replica pool at startup and put the choice behind two methods, so it is visible at every call site. A struct with read() and write() accessors stops the accidental replica write that fails at 03:00 with 'cannot execute INSERT in a read-only transaction'.",
            "Size the pools separately, and remember that failover promotes a standby and demotes the old primary. Code that hardcodes which URL is writable keeps writing to a server that is now read-only, so the decision has to be a function of the current role rather than of a static config line."
          ],
          "code": "use sqlx::PgPool;\n\n#[derive(Clone)]\npub struct Db {\n    primary: PgPool,\n    replica: PgPool,\n}\n\nimpl Db {\n    /// Reads that tolerate a few hundred milliseconds of staleness.\n    pub fn read(&self) -> &PgPool {\n        &self.replica\n    }\n\n    /// Anything that precedes a write, or follows one in the same request.\n    pub fn write(&self) -> &PgPool {\n        &self.primary\n    }\n\n    /// Read-after-write: fall back when the replica is visibly behind.\n    pub async fn read_fresh(&self) -> &PgPool {\n        let lag: Result<Option<f64>, sqlx::Error> = sqlx::query_scalar(\n            \"SELECT extract(epoch FROM now() - pg_last_xact_replay_timestamp())::float8\",\n        )\n        .fetch_one(&self.replica)\n        .await;\n\n        match lag {\n            Ok(Some(secs)) if secs < 0.5 => &self.replica,\n            // An unmeasurable replica is an unproven replica.\n            _ => &self.primary,\n        }\n    }\n}\n"
        },
        {
          "h": "Read-your-writes with an LSN token",
          "p": [
            "A user saves a profile change, then the next GET hits a replica 300 ms behind and shows the old name. Sticky routing is the simple fix: send that user's reads to the primary for a short window. It is correct, and it spends primary capacity on every active session.",
            "The cheaper fix is an LSN token. At commit, read pg_current_wal_lsn() and return it to the client as an opaque cursor. On the next read, poll the replica until its replay LSN has passed that value, bounded by a small budget; if the replica is too far behind, read the primary instead of blocking. The token is per-write, so an idle user costs nothing."
          ],
          "code": "use sqlx::PgPool;\nuse std::time::Duration;\n\n/// Returns the pool that has provably replayed `target`, or the primary.\npub async fn wait_for_lsn<'a>(\n    replica: &'a PgPool,\n    primary: &'a PgPool,\n    target: &str,\n    budget: Duration,\n) -> sqlx::Result<&'a PgPool> {\n    let deadline = tokio::time::Instant::now() + budget;\n\n    loop {\n        // Negative diff means replay has reached the commit we care about.\n        let behind: Option<bool> = sqlx::query_scalar(\n            \"SELECT pg_wal_lsn_diff($1::pg_lsn, pg_last_wal_replay_lsn()) > 0\",\n        )\n        .bind(target)\n        .fetch_optional(replica)\n        .await?;\n\n        if behind == Some(false) {\n            return Ok(replica);\n        }\n        if tokio::time::Instant::now() >= deadline {\n            return Ok(primary);\n        }\n        tokio::time::sleep(Duration::from_millis(25)).await;\n    }\n}\n",
          "tip": "Return the LSN in a response header and store it client-side; the next request sends it back. Never block a request on a replica that keeps falling behind: fall back, and count the fallbacks as a metric."
        },
        {
          "h": "Failover moves the goalposts",
          "p": [
            "When the primary dies, the promoted standby becomes writable and the other standbys follow a new timeline. Every process still holds pools built for the old topology. Connections to a demoted server fail with SQLSTATE 25006 (read-only SQL transaction), and retrying them against the same pool keeps failing.",
            "Handle the role change at the connection layer. Put target_session_attrs=read-write on the writer DSN (tokio-postgres exposes it as TargetSessionAttrs) so a new connection only lands on a writable server, and recycle the pool when a statement returns 25006. Failover should be a runbook with a known step, not an improvised restart."
          ],
          "list": [
            "Write DSN: target_session_attrs=read-write, so a demoted server never accepts new writes",
            "On 25006: close and rebuild the pool once, then fail the request rather than retrying in place",
            "Alert on byte lag and on pg_stat_database_conflicts; wall-clock lag lies on an idle primary",
            "Keep hot_standby_feedback off unless long standby reports are a product requirement"
          ],
          "tip": "A promoted standby keeps the same hostname in most managed offerings. Code that caches 'this URL is the writer' at boot will be wrong for the rest of the process lifetime."
        }
      ],
      "exercise": {
        "prompt": "Implement route(db, needs_fresh) -> &PgPool: use the replica when some staleness is acceptable, the primary when it is not, and fall back to the primary whenever the replica's lag cannot be measured or exceeds 2 seconds.",
        "starter": "use sqlx::PgPool;\n\npub struct Db {\n    pub primary: PgPool,\n    pub replica: PgPool,\n}\n\npub async fn route(db: &Db, needs_fresh: bool) -> &PgPool {\n    // measure replay lag on the replica, then decide\n    todo!()\n}\n",
        "hint": "Query extract(epoch FROM now() - pg_last_xact_replay_timestamp())::float8 on the replica. Any error, NULL or value >= 2.0 means freshness is unproven, so return the primary.",
        "solution": "use sqlx::PgPool;\n\npub struct Db {\n    pub primary: PgPool,\n    pub replica: PgPool,\n}\n\npub async fn route(db: &Db, needs_fresh: bool) -> &PgPool {\n    if needs_fresh {\n        return &db.primary;\n    }\n\n    let lag: Result<Option<f64>, sqlx::Error> = sqlx::query_scalar(\n        \"SELECT extract(epoch FROM now() - pg_last_xact_replay_timestamp())::float8\",\n    )\n    .fetch_one(&db.replica)\n    .await;\n\n    match lag {\n        Ok(Some(secs)) if secs < 2.0 => &db.replica,\n        // The timestamp is NULL before the first replayed commit, and grows\n        // without bound on an idle primary: neither proves freshness.\n        _ => &db.primary,\n    }\n}\n"
      },
      "production": [
        "Route only reads that tolerate staleness to replicas; any read that precedes or follows a write in the same request goes to the primary",
        "Return the commit LSN from writes and wait for it on the next read, with a 100-250ms budget and a primary fallback",
        "Alert on byte lag between receive and replay LSN, plus pg_stat_database_conflicts, instead of wall-clock lag alone",
        "Set target_session_attrs=read-write on the writer DSN and rebuild the pool once on SQLSTATE 25006 after a failover",
        "Size replica pools separately from the writer and keep hot_standby_feedback off unless standby reports are a product requirement"
      ],
      "crates": [
        "sqlx",
        "tokio",
        "thiserror"
      ],
      "github": [
        {
          "name": "sqlx",
          "url": "https://github.com/transact-rs/sqlx"
        },
        {
          "name": "postgres",
          "url": "https://github.com/postgres/postgres"
        }
      ],
      "pitfall": "Routing a read that gates a write to a replica creates a check-then-act race across servers: the existence check misses a row committed 200 ms ago, the INSERT proceeds, and the unique constraint surfaces as a 500 instead of a clean 409.",
      "resources": [
        {
          "title": "PostgreSQL: hot standby, read-only transactions and replay conflicts",
          "url": "https://www.postgresql.org/docs/current/hot-standby.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: pg_stat_replication and monitoring replication lag",
          "url": "https://www.postgresql.org/docs/current/monitoring-stats.html",
          "kind": "docs"
        },
        {
          "title": "postgres/postgres: WAL replay and hot standby source",
          "url": "https://github.com/postgres/postgres",
          "kind": "repo"
        },
        {
          "title": "Amazon Aurora: Design Considerations for High Throughput Cloud-Native Relational Databases",
          "url": "https://dl.acm.org/doi/10.1145/3035918.3056101",
          "kind": "paper"
        },
        {
          "title": "Beyond Postgres is up: detecting failures before they become incidents",
          "url": "https://www.youtube.com/watch?v=i0KYXxkQZJE",
          "kind": "video"
        }
      ],
      "quickbytes": [
        "A standby is read-only: INSERT, DDL, nextval and temp tables all fail there.",
        "Compare pg_last_wal_replay_lsn() against the commit LSN; wall-clock lag misleads on an idle primary.",
        "SQLSTATE 25006 means the writer pool is pointed at a demoted server: rebuild it, do not retry the statement."
      ],
      "questions": [
        {
          "q": "A user saves a profile change, and the next GET reads a replica that is 400 ms behind and returns the old value. Which fix addresses the cause?",
          "options": [
            "Increase the replica pool size so the read is served faster",
            "Wait for the replica to replay that write's LSN, or route that read to the primary",
            "Add an index on accounts.id so the replica lookup is cheaper",
            "Turn on hot_standby_feedback so the replica stays current"
          ],
          "answer": 1,
          "explain": "Staleness is a property of replay position, not of capacity. Either prove the replica has passed the commit LSN or read the primary; a bigger pool only serves the stale row sooner."
        },
        {
          "q": "pg_last_xact_replay_timestamp() reports six hours of lag on a primary that has taken no writes since the morning. What is happening?",
          "options": [
            "Replay is stuck and the standby needs a restart",
            "The standby clock has drifted, so the interval is meaningless",
            "The function measures the age of the last replayed commit, so an idle primary inflates it",
            "hot_standby_feedback is delaying cleanup on the primary"
          ],
          "answer": 2,
          "explain": "The function is a timestamp of the last replayed commit, not a delay measurement. Use byte lag between receive and replay LSN, or a heartbeat table, for alerts."
        },
        {
          "q": "After failover, a service holding the old writer pool starts returning errors. Which SQLSTATE identifies the read-only-transaction case, and what is the right reaction?",
          "options": [
            "40001 - retry the transaction with backoff",
            "25006 - rebuild the pool so new connections find the writable server",
            "57P01 - reconnect immediately to the same host and retry forever",
            "42P01 - run migrations, because the table is missing on the new primary"
          ],
          "answer": 1,
          "explain": "25006 is read_only_sql_transaction, raised when a write reaches a server in recovery. Retrying against the same pool repeats the failure; the topology changed, so the pool must too."
        }
      ]
    },
    {
      "id": "d09",
      "n": 9,
      "title": "Logical replication and change data capture",
      "minutes": 100,
      "level": "industry",
      "goal": "Stream committed row changes into another system at-least-once, keep the replication slot from filling the disk, and own the schema on both sides.",
      "sections": [
        {
          "h": "A slot is a promise to keep WAL",
          "p": [
            "Logical decoding turns WAL into row-level changes. A replication slot records how far a consumer has confirmed, and Postgres will not recycle WAL past that point until the slot advances. That is the safety property and the operational hazard at once: an abandoned slot on a busy primary fills pg_wal until the server panics.",
            "Set wal_level = logical, which needs a restart, and size max_replication_slots and max_wal_senders for every consumer plus headroom for failover. Then alert on slot lag in bytes. A slot that exists and is idle is more dangerous than one that does not exist, because nothing looks broken until the disk is full."
          ],
          "code": "-- wal_level only changes at server start.\nALTER SYSTEM SET wal_level = 'logical';\nALTER SYSTEM SET max_replication_slots = 10;   -- consumers + failover headroom\nALTER SYSTEM SET max_wal_senders = 10;\n\n-- Publish only the tables and operations the consumer handles.\nCREATE PUBLICATION orders_cdc\n    FOR TABLE orders, order_lines\n    WITH (publish = 'insert, update, delete');\n\n-- Row filters (PG 15+) let one publication serve a regional consumer.\nCREATE PUBLICATION eu_orders_cdc\n    FOR TABLE orders WHERE (region = 'eu');\n\nSELECT * FROM pg_create_logical_replication_slot('orders_slot', 'pgoutput');\n\nSELECT slot_name, plugin, active, wal_status,\n       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained\nFROM pg_replication_slots;\n",
          "tip": "Debug a stalled consumer with pg_logical_slot_peek_changes, which does not consume. pg_logical_slot_get_changes does consume, and a crash before your sink commits loses those changes."
        },
        {
          "h": "Replica identity decides what can be decoded",
          "p": [
            "An UPDATE or DELETE must be turned into a row the consumer can identify. By default Postgres uses the primary key, and a table without one cannot publish updates or deletes at all: the change is skipped and the publisher logs why. The fix is not to guess. Add a primary key, or declare a unique index as the replica identity, before the table joins a publication.",
            "REPLICA IDENTITY FULL writes the entire old row into WAL so consumers can match on any column. It works, and it multiplies WAL volume for wide rows. Use it for small keyless tables such as an append-only audit feed, and add a real key when the table is large or hot."
          ],
          "code": "-- No primary key, no identity: UPDATE and DELETE cannot be decoded.\nALTER TABLE audit_events REPLICA IDENTITY FULL;   -- old row included in WAL\n\n-- A unique index is cheaper: only the key columns are logged.\nCREATE UNIQUE INDEX shipments_number_key ON shipments (number);\nALTER TABLE shipments REPLICA IDENTITY USING INDEX shipments_number_key;\n\n-- The publication must agree: a column list (PG 15+) must include the key.\nCREATE PUBLICATION shipments_cdc\n    FOR TABLE shipments (id, number, status)\n    WITH (publish = 'insert, update, delete');\n",
          "tip": "REPLICA IDENTITY FULL on a table with large text or bytea columns can double WAL volume, because the old row is logged in full for every update."
        },
        {
          "h": "The consumer owns delivery semantics",
          "p": [
            "A slot gives at-least-once, because acknowledging the LSN and committing your sink are separate writes. If the process dies after the sink commit and before the acknowledgement, the batch is replayed. Design for that: idempotent upserts keyed by primary key, or a dedupe table keyed by relation, key and LSN.",
            "Commit downstream first, then advance the checkpoint. Advancing first turns a crash into silent data loss. Send feedback regularly as well: wal_sender_timeout closes a replication connection that stops responding, and the slot then grows for the entire reconnect. Monitor the consumer's own lag, not just whether the slot exists."
          ],
          "code": "use pgwire_replication::{Lsn, ReplicationClient, ReplicationConfig, ReplicationEvent};\n\npub async fn consume(\n    host: &str,\n    slot: &str,\n    publication: &str,\n    checkpoint: Lsn,\n) -> anyhow::Result<()> {\n    let config = ReplicationConfig::new(host, \"cdc_reader\", \"secret\", \"app\", slot, publication)\n        .with_start_lsn(checkpoint);\n\n    let mut client = ReplicationClient::connect(config).await?;\n    let mut batch = Vec::new();\n\n    while let Some(event) = client.recv().await? {\n        match event {\n            // Raw pgoutput payload for one row change.\n            ReplicationEvent::XLogData { data, .. } => batch.push(data),\n            // A transaction boundary is the only meaningful batch edge.\n            ReplicationEvent::Commit { .. } => {\n                apply_batch(&batch).await?;       // idempotent sink write\n                store_checkpoint(&batch).await?;  // only after the sink commits\n                batch.clear();\n            }\n            ReplicationEvent::KeepAlive { .. } => {}\n            _ => {}\n        }\n    }\n\n    Ok(())\n}\n\n// apply_batch and store_checkpoint are your sink; both must be crash-safe.\n"
        },
        {
          "h": "DDL is not in the stream",
          "p": [
            "Logical replication publishes row changes and nothing else. A new column, a dropped column, a type change or a new table is invisible to the consumer, and a table added to a publication streams from the next change with no initial copy. Whatever the sink needs, your migration pipeline has to deliver separately.",
            "Treat the sink schema as a second deployment target: ship additive changes to both sides, keep old columns readable until every consumer has moved, and record the applied version next to the LSN checkpoint. When the two drift, the failure appears as a decode error on the first row with an unexpected shape, far from the migration that caused it."
          ],
          "list": [
            "Add columns on both sides first; consumers ignore them until they use them",
            "Never drop a published column until every consumer has stopped reading it",
            "A table added to a publication has no initial copy: backfill it explicitly",
            "Record the replicated schema version beside the checkpoint, not in a wiki"
          ],
          "tip": "pgoutput sends relation metadata once per session. A consumer that caches it must handle a Relation message arriving mid-stream after a schema change, or it keeps decoding with the old column order."
        }
      ],
      "exercise": {
        "prompt": "Implement drain_slot(pool, slot, max) that reads at most max pending changes from an existing logical slot, oldest first, and returns the LSN as text plus the payload. Then explain what the call does to the slot.",
        "starter": "use sqlx::PgPool;\n\n#[derive(Debug, sqlx::FromRow)]\npub struct Change {\n    pub lsn: String,\n    pub data: String,\n}\n\npub async fn drain_slot(pool: &PgPool, slot: &str, max: i32) -> sqlx::Result<Vec<Change>> {\n    // pg_logical_slot_get_changes(slot, upto_lsn, upto_nchanges)\n    todo!()\n}\n",
        "hint": "pg_logical_slot_get_changes(slot, NULL, max) consumes up to max changes; NULL upto_lsn means everything available now. Cast lsn::text so sqlx can decode pg_lsn without a custom type.",
        "solution": "use sqlx::PgPool;\n\n#[derive(Debug, sqlx::FromRow)]\npub struct Change {\n    pub lsn: String,\n    pub data: String,\n}\n\npub async fn drain_slot(pool: &PgPool, slot: &str, max: i32) -> sqlx::Result<Vec<Change>> {\n    sqlx::query_as::<_, Change>(\n        r#\"SELECT lsn::text AS lsn, data\n           FROM pg_logical_slot_get_changes($1, NULL, $2)\"#,\n    )\n    .bind(slot)\n    .bind(max)\n    .fetch_all(pool)\n    .await\n}\n\n// _get_changes consumes: the slot's confirmed_flush_lsn moves to the last\n// returned change when the call's transaction commits. A crash before your\n// sink commits therefore loses those changes. Production CDC streams through\n// a replication protocol client and confirms the LSN only after the sink is\n// durable, which is why delivery is at-least-once rather than at-most-once.\n"
      },
      "production": [
        "Treat every replication slot as a pager duty item: alert on retained bytes and on pg_replication_slots.wal_status reaching unreserved",
        "Give every published table a primary key or an explicit REPLICA IDENTITY, and verify it in CI before the publication is created",
        "Commit the sink first and advance the checkpoint second; dedupe on (relation, key, lsn) so replay is harmless",
        "Ship DDL to the sink through the migration pipeline, additive first, with the schema version recorded beside the checkpoint",
        "Send standby status updates on a timer; a silent consumer holds WAL for the whole wal_sender_timeout window"
      ],
      "crates": [
        "pgwire-replication",
        "sqlx",
        "tokio",
        "serde_json"
      ],
      "github": [
        {
          "name": "pgwire-replication",
          "url": "https://github.com/vnvo/pgwire-replication"
        },
        {
          "name": "debezium",
          "url": "https://github.com/debezium/debezium"
        }
      ],
      "pitfall": "A replication slot that no consumer acknowledges is a disk-filling timer: Postgres refuses to recycle WAL from restart_lsn, pg_wal grows until the filesystem fills, and the primary panics with no committed transaction lost but the database offline.",
      "resources": [
        {
          "title": "PostgreSQL: logical replication, publications and subscriptions",
          "url": "https://www.postgresql.org/docs/current/logical-replication.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: logical decoding examples with pg_logical_slot_get_changes",
          "url": "https://www.postgresql.org/docs/current/logicaldecoding-example.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: logical replication restrictions and conflict handling",
          "url": "https://www.postgresql.org/docs/current/logical-replication-restrictions.html",
          "kind": "docs"
        },
        {
          "title": "pgwire-replication: pgoutput client for Rust (ReplicationClient, Lsn)",
          "url": "https://docs.rs/pgwire-replication/latest/pgwire_replication/",
          "kind": "docs"
        },
        {
          "title": "Hanging hundreds of Postgres shutdowns with a simple CDC plugin",
          "url": "https://www.youtube.com/watch?v=l-_13Exydg4",
          "kind": "video"
        }
      ],
      "quickbytes": [
        "wal_level = logical needs a restart; the slot it enables never stops holding WAL until it is dropped.",
        "A table with no primary key cannot publish UPDATE or DELETE until you set a replica identity.",
        "Commit the sink, then the LSN. The other order turns a crash into silent data loss."
      ],
      "questions": [
        {
          "q": "A consumer has been offline for three days on a primary taking 20 GB of WAL per day. What is the immediate consequence?",
          "options": [
            "Postgres recycles the WAL after the next checkpoint regardless of the slot",
            "The slot retains WAL from restart_lsn, so pg_wal keeps growing until the disk fills",
            "The primary stops accepting writes until the consumer reconnects",
            "The slot is dropped automatically after wal_sender_timeout"
          ],
          "answer": 1,
          "explain": "A slot pins WAL from restart_lsn until confirmed_flush_lsn advances. Nothing reclaims it, and the eventual failure is a full filesystem and a PANIC shutdown."
        },
        {
          "q": "A table has no primary key and is in a publication with publish = 'update'. What happens to UPDATEs?",
          "options": [
            "They replicate using every column as the identity automatically",
            "They are silently published as INSERTs",
            "They cannot be decoded, because the old row cannot be identified, until you set a replica identity",
            "They replicate only if the table has a BRIN index"
          ],
          "answer": 2,
          "explain": "Decoding an UPDATE needs the old row's identity. Without a primary key or REPLICA IDENTITY FULL, Postgres cannot produce it and the change is not published."
        },
        {
          "q": "The consumer commits to its sink, then crashes before advancing the LSN checkpoint. What does the replayed batch do?",
          "options": [
            "It is skipped, because the slot saw the sink commit",
            "It is replayed, so the sink must absorb duplicates idempotently",
            "It corrupts the slot and requires pg_replication_slot_advance to repair",
            "It forces a full resync from the initial snapshot"
          ],
          "answer": 1,
          "explain": "Acknowledgement and sink commit are separate writes, so the window is unavoidable. Delete-and-insert by key or dedupe on (relation, key, lsn) makes replay a no-op."
        }
      ]
    },
    {
      "id": "d10",
      "n": 10,
      "title": "Migrations at scale: locks, batches, rollback",
      "minutes": 90,
      "level": "industry",
      "goal": "Ship schema changes to one database or a thousand without an outage, bound the lock wait, and know what a rollback can actually restore.",
      "sections": [
        {
          "h": "Every migration is a lock decision",
          "p": [
            "Postgres DDL takes a lock, and the lock you queue behind is the outage. ALTER TABLE ... ADD COLUMN needs ACCESS EXCLUSIVE for a moment; if a long SELECT is running, the ALTER waits, and every query behind it waits too, because ACCESS EXCLUSIVE conflicts with every other mode. Requests time out while the table is technically idle.",
            "Set lock_timeout on the migration session so the ALTER fails fast instead of building a convoy, and retry with jitter. Most large tables can take the common changes without a rewrite: a nullable column, a column with a non-volatile default (PG 11+), and a constraint added as NOT VALID are all metadata-only."
          ],
          "code": "-- migrations/20260412_0003_add_region.sql\n-- sqlx wraps this file in one transaction, so SET LOCAL applies to it alone.\nSET LOCAL lock_timeout = '3s';\nSET LOCAL statement_timeout = '30s';\n\nALTER TABLE orders ADD COLUMN IF NOT EXISTS region text;\n\n-- Metadata only: not enforced against existing rows yet.\nALTER TABLE orders\n    ADD CONSTRAINT orders_region_known\n    CHECK (region IS NULL OR region IN ('eu', 'us', 'apac')) NOT VALID;\n\n-- One scan, under SHARE UPDATE EXCLUSIVE: reads and writes continue.\nALTER TABLE orders VALIDATE CONSTRAINT orders_region_known;\n",
          "tip": "If a migration keeps hitting lock_timeout, the problem is not the migration: something is holding a long transaction. Look in pg_stat_activity before raising the timeout."
        },
        {
          "h": "Backfills are jobs, not migrations",
          "p": [
            "An UPDATE over 40 million rows holds one transaction open: the table doubles in size, WAL balloons, replicas fall hours behind, and a rollback discards all of it. Batch by primary key, commit each batch, and let the job be resumable from the data rather than from a checkpoint you have to maintain.",
            "The self-healing predicate is WHERE new_col IS NULL ORDER BY id LIMIT n. Every batch is small, idempotent and safe to rerun, and a crash costs one batch. Sleep between batches so autovacuum and replicas keep up, and use replication lag as the throttle signal instead of a fixed sleep."
          ],
          "code": "use sqlx::PgPool;\nuse std::time::Duration;\n\n/// Backfill one batch; returns how many rows this batch changed.\npub async fn backfill_batch(pool: &PgPool, batch: i64) -> sqlx::Result<u64> {\n    let updated = sqlx::query(\n        r#\"UPDATE orders\n           SET region = COALESCE(region, 'us')\n           WHERE id IN (\n               SELECT id FROM orders WHERE region IS NULL ORDER BY id LIMIT $1\n           )\"#,\n    )\n    .bind(batch)\n    .execute(pool)\n    .await?\n    .rows_affected();\n\n    Ok(updated)\n}\n\npub async fn backfill_all(pool: &PgPool) -> sqlx::Result<()> {\n    loop {\n        if backfill_batch(pool, 1_000).await? == 0 {\n            return Ok(());\n        }\n        tokio::time::sleep(Duration::from_millis(50)).await;\n    }\n}\n"
        },
        {
          "h": "What a rollback actually restores",
          "p": [
            "One DDL statement is transactional, and a migration file is transactional only if every statement in it is. CREATE INDEX CONCURRENTLY cannot run inside a transaction, so a file containing it needs -- no-transaction, and a failure halfway leaves the index invalid while earlier statements stay committed. That is where 'just roll back' stops being true.",
            "Applied migrations are forward-only. A down file is a development convenience, not a recovery plan: by the time you notice, rows may already use the new column, and reversing it destroys data you cannot reconstruct. The real rollback for a destructive mistake is a restore to a point in time, rehearsed before you need it."
          ],
          "code": "-- migrations/20260412_0004_orders_region_idx.sql\n-- no-transaction\n\n-- CONCURRENTLY cannot run inside a transaction block, so this file opts out.\nCREATE INDEX CONCURRENTLY IF NOT EXISTS orders_region_idx\n    ON orders (region, created_at DESC);\n\n-- After any failure, an index can be left INVALID: find it, drop it, re-run.\nSELECT c.relname AS index_name, i.indisvalid, i.indisready\nFROM pg_index i\nJOIN pg_class c ON c.oid = i.indexrelid\nWHERE NOT i.indisvalid;\n",
          "tip": "An INVALID index is still maintained on writes and still ignored by the planner: pure cost. Drop it before re-running the concurrent build."
        },
        {
          "h": "The same migration, many databases",
          "p": [
            "One service with one database is the easy case. With a database per tenant, a migration is a fleet operation: a runner that applies version N to every database, records per-database state, caps concurrency, and stops on the first failure instead of racing ahead. Canary a small slice and compare error rates and lock waits before widening.",
            "Keep one migration directory in the binary, never a per-tenant fork. Anything tenant-specific belongs in data or configuration, or you will spend years reconciling divergent schemas. Record (database, version, applied_at, checksum) centrally so a drifted tenant is a query result rather than an archaeology project."
          ],
          "list": [
            "Canary a small set of databases, wait one deploy window, then widen",
            "Cap concurrency so the fleet does not saturate shared storage",
            "Abort the run on the first checksum mismatch and page a human",
            "Store per-database version and duration, and alert on stragglers"
          ],
          "tip": "A fleet runner that retries forever hides a schema that cannot migrate. Fail the run, keep the per-database record, and let a human decide on the outlier."
        }
      ],
      "exercise": {
        "prompt": "Implement migrate_with_lock_timeout(pool, ddl) that runs one DDL statement with a 2s lock_timeout, retries up to five times with exponential backoff on SQLSTATE 55P03, and returns how many attempts it used.",
        "starter": "use sqlx::PgPool;\n\npub async fn migrate_with_lock_timeout(pool: &PgPool, ddl: &str) -> sqlx::Result<u32> {\n    // SET LOCAL lock_timeout inside a transaction, then execute the DDL.\n    todo!()\n}\n",
        "hint": "SET LOCAL applies only inside a transaction and reverts at commit, which is exactly what a migration wants. 55P03 is lock_not_available; every other error should surface immediately.",
        "solution": "use sqlx::PgPool;\nuse std::time::Duration;\n\npub async fn migrate_with_lock_timeout(pool: &PgPool, ddl: &str) -> sqlx::Result<u32> {\n    let mut attempt = 0;\n    let mut backoff = Duration::from_millis(100);\n\n    loop {\n        attempt += 1;\n        let mut tx = pool.begin().await?;\n\n        // SET LOCAL dies with this transaction, so the next caller is unaffected.\n        sqlx::query(\"SET LOCAL lock_timeout = '2s'\")\n            .execute(&mut *tx)\n            .await?;\n\n        match sqlx::query(ddl).execute(&mut *tx).await {\n            Ok(_) => {\n                tx.commit().await?;\n                return Ok(attempt);\n            }\n            Err(err) if is_lock_timeout(&err) && attempt < 5 => {\n                tx.rollback().await?;\n                tokio::time::sleep(backoff).await;\n                backoff *= 2;\n            }\n            Err(err) => return Err(err),\n        }\n    }\n}\n\nfn is_lock_timeout(err: &sqlx::Error) -> bool {\n    err.as_database_error()\n        .and_then(|e| e.code())\n        .map(|code| code.as_ref() == \"55P03\")\n        .unwrap_or(false)\n}\n"
      },
      "production": [
        "Set lock_timeout (2-5s) and statement_timeout on every migration session, and retry 55P03 with backoff instead of raising the timeout",
        "Put CONCURRENTLY in its own -- no-transaction file and check pg_index for INVALID indexes after any failure",
        "Backfill in batches of 1k-10k by primary key, with the work predicate in the WHERE so the job resumes without a checkpoint table",
        "Keep one forward-only migration directory per service with a checksum guard in CI; never edit an applied file",
        "For fleets, canary a small set of databases, cap concurrency, and abort the whole run on the first checksum or lock failure"
      ],
      "crates": [
        "sqlx",
        "tokio",
        "refinery"
      ],
      "github": [
        {
          "name": "refinery",
          "url": "https://github.com/rust-db/refinery"
        },
        {
          "name": "sqlx",
          "url": "https://github.com/transact-rs/sqlx"
        }
      ],
      "pitfall": "Raising lock_timeout to get a stuck migration through converts a 3-second error into a table outage: the ALTER queues behind a long query, and every request behind the ALTER queues too.",
      "resources": [
        {
          "title": "PostgreSQL: ALTER TABLE and the lock level of each form",
          "url": "https://www.postgresql.org/docs/current/sql-altertable.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: explicit locking and lock compatibility",
          "url": "https://www.postgresql.org/docs/current/explicit-locking.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: constraints, NOT VALID and VALIDATE CONSTRAINT",
          "url": "https://www.postgresql.org/docs/current/ddl-constraints.html",
          "kind": "docs"
        },
        {
          "title": "refinery: SQL migration toolkit for Rust with versioned up/down files",
          "url": "https://docs.rs/refinery/latest/refinery/",
          "kind": "docs"
        },
        {
          "title": "refinery on GitHub: migration runner and CLI",
          "url": "https://github.com/rust-db/refinery",
          "kind": "repo"
        }
      ],
      "quickbytes": [
        "ACCESS EXCLUSIVE conflicts with everything: one queued ALTER blocks every reader behind it.",
        "ADD CONSTRAINT ... NOT VALID is metadata only; VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE.",
        "CONCURRENTLY cannot run in a transaction: its own file, -- no-transaction, and check for INVALID after failure."
      ],
      "questions": [
        {
          "q": "A migration runs ALTER TABLE orders ADD COLUMN region text while a 40-minute analytics SELECT holds the table. What do other sessions see?",
          "options": [
            "They continue normally, because ADD COLUMN of a nullable column does not lock",
            "They queue behind the ALTER's ACCESS EXCLUSIVE request, so the table is unusable until the SELECT finishes",
            "They are cancelled immediately by Postgres to protect the migration",
            "They see the new column as NULL until the migration commits"
          ],
          "answer": 1,
          "explain": "The ALTER waits behind the SELECT, and ACCESS EXCLUSIVE conflicts with every other lock mode, so all later queries queue behind the ALTER. lock_timeout turns that into a fast, retryable failure."
        },
        {
          "q": "You put CREATE INDEX CONCURRENTLY inside a migration that sqlx wraps in a transaction. What happens?",
          "options": [
            "The index is built, but without the concurrent optimization",
            "Postgres errors: CREATE INDEX CONCURRENTLY cannot run inside a transaction block",
            "sqlx silently splits the file into statements and runs them separately",
            "The migration succeeds and the index is marked invalid until the next VACUUM"
          ],
          "answer": 1,
          "explain": "CONCURRENTLY needs its own transaction lifecycle. The migration must be in a file starting with -- no-transaction, and a failure leaves an INVALID index to drop and rebuild."
        },
        {
          "q": "A teammate edits an already-applied migration file to add an index. What breaks on the next deploy?",
          "options": [
            "Nothing, because sqlx compares only the filename",
            "The migration runs again and creates a duplicate index",
            "The checksum in _sqlx_migrations no longer matches, so the migrator refuses to run",
            "The database rolls back to the previous version automatically"
          ],
          "answer": 2,
          "explain": "Applied migrations are immutable by design: each file is checksummed, and an edit is detected as tampering rather than silently applied. Add a new file instead."
        }
      ]
    },
    {
      "id": "d11",
      "n": 11,
      "title": "Connection pool sizing under real load",
      "minutes": 85,
      "level": "industry",
      "goal": "Size pools from measured concurrency rather than from max_connections, and use timeouts so saturation becomes a fast failure instead of a queue.",
      "sections": [
        {
          "h": "Little's law, not intuition",
          "p": [
            "Concurrency equals arrival rate times service time. At 800 database operations per second and 25 ms each, roughly twenty operations are in flight at any instant; a pool of 20 covers that, and a pool of 200 makes nothing faster, because the database is already the constraint.",
            "Every connection is a server process with its own memory and a share of the lock table. Past the point where CPU is saturated, more backends increase context switching and contention and reduce throughput. Choose the smallest pool that keeps acquire wait under a few milliseconds at p99, then verify by measuring."
          ],
          "code": "use std::time::Duration;\n\n#[derive(Debug, PartialEq)]\npub struct PoolPlan {\n    pub concurrent_ops: f64,\n    pub per_process: u32,\n    pub acquire_timeout: Duration,\n}\n\n/// rps: database operations per second at peak. p99: how long one holds a connection.\npub fn plan(rps: f64, p99: Duration, headroom: f64, replicas: u32) -> PoolPlan {\n    let concurrent = rps * p99.as_secs_f64();\n    let per_process = (concurrent * headroom / replicas as f64).ceil().max(2.0);\n\n    PoolPlan {\n        concurrent_ops: concurrent,\n        per_process: per_process as u32,\n        // Fail before the caller's deadline, not after it.\n        acquire_timeout: p99\n            .mul_f64(4.0)\n            .clamp(Duration::from_millis(50), Duration::from_millis(750)),\n    }\n}\n\n#[test]\nfn eight_hundred_rps_at_25ms_needs_about_thirty() {\n    let plan = plan(800.0, Duration::from_millis(25), 1.5, 1);\n    assert_eq!(plan.concurrent_ops, 20.0);\n    assert_eq!(plan.per_process, 30);\n}\n"
        },
        {
          "h": "PgBouncer changes what a connection is",
          "p": [
            "In transaction pooling mode, PgBouncer hands a server connection to whichever client needs one for the duration of a transaction. Two hundred idle workers can share twenty backends, which is how several services fit into one max_connections. The price is that session state is a lie: a SET that outlives its transaction, a prepared statement name, a LISTEN, an advisory lock or a temp table may land somewhere else.",
            "sqlx prepares statements and caches them per connection. Behind transaction pooling, disable that cache or the next execution can reference a prepared statement the current backend has never seen, producing 'prepared statement \"...\" does not exist' under load. Anything session-scoped must become explicit and transaction-scoped."
          ],
          "code": "use sqlx::postgres::{PgConnectOptions, PgPoolOptions};\nuse std::time::Duration;\n\npub async fn connect_through_pgbouncer(dsn: &str) -> Result<sqlx::PgPool, sqlx::Error> {\n    // No server-side statement cache: the backend can change per transaction.\n    let options = dsn\n        .parse::<PgConnectOptions>()?\n        .statement_cache_capacity(0)\n        .application_name(\"orders-api\");\n\n    PgPoolOptions::new()\n        .max_connections(16)\n        .min_connections(4)\n        .acquire_timeout(Duration::from_millis(250))\n        .test_before_acquire(true)\n        .connect_with(options)\n        .await\n}\n",
          "tip": "In transaction mode PgBouncer also breaks LISTEN/NOTIFY, advisory locks held across statements, and cursors outside a transaction. Keep those on a direct connection or remove them."
        },
        {
          "h": "Timeouts are the shape of backpressure",
          "p": [
            "A pool without acquire_timeout converts saturation into unbounded queueing: requests wait inside the pool until the client gives up, and dashboards show a slow database that is actually idle. Set acquire_timeout below the request deadline, and statement_timeout on the role so one runaway query cannot pin its connection for a minute.",
            "Two more matter. idle_in_transaction_session_timeout kills a connection that opened a transaction and then awaited something slow, which otherwise blocks vacuum and holds locks. tcp_user_timeout, or keepalives, reclaims a connection to a host that vanished without a FIN, which is what a failed load balancer looks like from the client side."
          ],
          "code": "-- Timeouts belong to the application role, so every connection inherits them.\nALTER ROLE orders_api SET statement_timeout = '5s';\nALTER ROLE orders_api SET idle_in_transaction_session_timeout = '10s';\nALTER ROLE orders_api SET lock_timeout = '2s';\nALTER ROLE orders_api CONNECTION LIMIT 50;   -- per role, across all databases\n\n-- Saturation view; other roles' rows need pg_read_all_stats or superuser.\nSELECT state, count(*) AS backends, max(now() - state_change) AS longest\nFROM pg_stat_activity\nWHERE usename = 'orders_api'\nGROUP BY state\nORDER BY backends DESC;\n",
          "tip": "CONNECTION LIMIT is a per-role cap, not a per-database one: two services sharing a role share the limit, and the second one fails to connect at the worst moment."
        },
        {
          "h": "Measure the pool itself",
          "p": [
            "Pool metrics answer the question the database cannot: how long a caller waited before it got a connection. Track size, idle, in-use and an acquire-wait histogram. A pool that is fully busy with 50 ms waits needs a smaller query or a bigger pool; a pool that is 60 percent busy with 1 ms waits is right-sized, whatever the CPU graph suggests.",
            "Correlate with the server. pg_stat_database gives transactions per second and a rollback ratio; a rising rollback ratio usually means timeouts or serialization retries, not bad SQL. deadpool exposes the same shape through pool.status(), with size, available and waiting counts, if you are not on sqlx."
          ],
          "code": "use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};\nuse tokio_postgres::NoTls;\n\npub fn build_pool(dsn: &str, max_size: usize) -> anyhow::Result<Pool> {\n    let pg_config: tokio_postgres::Config = dsn.parse()?;\n    let manager = Manager::from_config(\n        pg_config,\n        NoTls,\n        ManagerConfig { recycling_method: RecyclingMethod::Fast },\n    );\n\n    Ok(Pool::builder(manager).max_size(max_size).build()?)\n}\n\n/// `waiting` is the number that predicts a latency incident.\npub fn saturation(pool: &Pool) -> (usize, usize, usize) {\n    let status = pool.status();\n    (status.size, status.available, status.waiting)\n}\n"
        }
      ],
      "exercise": {
        "prompt": "Implement plan(rps, p99, replicas) returning concurrent operations, a per-process pool size capped at 40, and an acquire timeout no greater than a quarter of the request budget. Then implement saturated(status) for deadpool's (size, available, waiting) tuple.",
        "starter": "use std::time::Duration;\n\npub struct Plan {\n    pub concurrent_ops: f64,\n    pub per_process: u32,\n    pub acquire_timeout: Duration,\n}\n\npub fn plan(rps: f64, p99: Duration, replicas: u32) -> Plan {\n    // concurrent = rps * p99, then divide by replicas and cap at 40\n    todo!()\n}\n\npub fn saturated((size, available, waiting): (usize, usize, usize)) -> bool {\n    todo!()\n}\n",
        "hint": "concurrent_ops = rps * p99.as_secs_f64(). per_process = ceil(concurrent * 1.5 / replicas), clamped to 2..=40. Treat any waiting count above zero at p99 as saturation.",
        "solution": "use std::time::Duration;\n\npub struct Plan {\n    pub concurrent_ops: f64,\n    pub per_process: u32,\n    pub acquire_timeout: Duration,\n}\n\npub fn plan(rps: f64, p99: Duration, replicas: u32) -> Plan {\n    let concurrent_ops = rps * p99.as_secs_f64();\n    let per_process = (concurrent_ops * 1.5 / replicas.max(1) as f64).ceil() as u32;\n\n    Plan {\n        concurrent_ops,\n        per_process: per_process.clamp(2, 40),\n        // A quarter of the p99 service time leaves room for the query itself.\n        acquire_timeout: p99.div_f64(4.0).clamp(\n            Duration::from_millis(25),\n            Duration::from_millis(500),\n        ),\n    }\n}\n\npub fn saturated((_size, available, waiting): (usize, usize, usize)) -> bool {\n    // Zero available connections with waiters is the onset of a queue.\n    available == 0 && waiting > 0\n}\n\n// The cap matters more than the formula: 40 backends per process times 30 pods\n// is already 1,200 server processes competing for the same CPU.\n"
      },
      "production": [
        "Size from measured concurrency (rps x p99 service time), cap per process, and multiply by replicas before comparing to max_connections",
        "Set acquire_timeout below the request deadline and statement_timeout on the role, so saturation fails fast instead of queueing",
        "Disable sqlx's statement cache behind transaction-mode PgBouncer and keep session-scoped features on a direct connection",
        "Alert on pool wait time and waiting count, not on connection count alone; idle connections are not the problem",
        "Set idle_in_transaction_session_timeout and tcp_user_timeout so half-dead sessions cannot hold locks or slots"
      ],
      "crates": [
        "sqlx",
        "deadpool-postgres",
        "tokio-postgres",
        "tokio"
      ],
      "github": [
        {
          "name": "deadpool",
          "url": "https://github.com/deadpool-rs/deadpool"
        },
        {
          "name": "sqlx",
          "url": "https://github.com/transact-rs/sqlx"
        }
      ],
      "pitfall": "A single Connection behind a Mutex serializes every query in the process: throughput collapses under concurrency that a pool of eight would have served, and the queue looks exactly like a slow database.",
      "resources": [
        {
          "title": "PostgreSQL: connections and authentication settings (max_connections)",
          "url": "https://www.postgresql.org/docs/current/runtime-config-connection.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: monitoring activity, pg_stat_activity and wait events",
          "url": "https://www.postgresql.org/docs/current/monitoring-stats.html",
          "kind": "docs"
        },
        {
          "title": "deadpool-postgres: pool, Manager and status metrics",
          "url": "https://docs.rs/deadpool-postgres/latest/deadpool_postgres/",
          "kind": "docs"
        },
        {
          "title": "sqlx PgPoolOptions: max_connections, acquire_timeout, test_before_acquire",
          "url": "https://docs.rs/sqlx/0.8.6/sqlx/postgres/type.PgPoolOptions.html",
          "kind": "docs"
        },
        {
          "title": "When Your Benchmarks Argue Against You",
          "url": "https://www.youtube.com/watch?v=weV_lbhP4As",
          "kind": "video"
        }
      ],
      "quickbytes": [
        "Concurrency = rps x p99 service time; that number, not max_connections, is your pool size.",
        "Acquire timeouts fire inside the pool, where the database cannot see them: export wait time as a metric.",
        "Transaction-mode PgBouncer plus sqlx statement cache equals 'prepared statement does not exist' under load."
      ],
      "questions": [
        {
          "q": "A service runs at 600 database operations per second, each holding a connection for 20 ms, across 4 replicas. What is the per-replica pool size before headroom?",
          "options": [
            "3 connections, because 600 / 4 / 50",
            "12 connections, because 600 x 0.020 = 12 concurrent operations split over 4 replicas",
            "150 connections, because 600 / 4",
            "20 connections, because each replica needs the full p99 concurrency"
          ],
          "answer": 1,
          "explain": "600 x 0.020 s = 12 operations in flight overall, so three per replica covers the average; add headroom for the p99 and bursts, not for the peak request rate alone."
        },
        {
          "q": "Behind PgBouncer in transaction mode, queries start failing with 'prepared statement \"sqlx_s_1\" does not exist'. What is the cause?",
          "options": [
            "PgBouncer's query cache is full and must be flushed",
            "sqlx cached a prepared statement on a backend that the next transaction was not routed to",
            "Postgres deallocated the statement because of a DDL change",
            "The pool's min_connections is set too low"
          ],
          "answer": 1,
          "explain": "Transaction pooling does not pin a client to a backend, so server-side prepared statements cannot be relied on. statement_cache_capacity(0) makes sqlx send unnamed statements instead."
        },
        {
          "q": "A pool is raised from 20 to 300 connections and throughput falls. What is the most likely reason?",
          "options": [
            "Postgres multiplexes backends, so the extra connections idle",
            "More backends mean more per-process memory, context switching and lock contention on the same CPU",
            "sqlx throttles pools above 100 connections by default",
            "The pool's acquire_timeout starts rejecting queries at 300"
          ],
          "answer": 1,
          "explain": "Each connection is an OS process with its own memory and lock-table share. Beyond CPU saturation, adding backends reduces throughput; the constraint is the machine, not the pool."
        }
      ]
    },
    {
      "id": "d12",
      "n": 12,
      "title": "Time-series ingest, partitioning and rollups",
      "minutes": 95,
      "level": "industry",
      "goal": "Ingest high-rate timestamped rows without rewriting them, keep only the partitions you need, and answer dashboards from pre-aggregated data.",
      "sections": [
        {
          "h": "The write path is the design",
          "p": [
            "A metrics table is append-only, narrow, and written far more than it is read. That inverts the usual advice: index count matters more than index cleverness, because every index is another insert per row. Keep only the columns the queries need, put series identity in two or three columns, and let the timestamp be the partition key.",
            "Round trips dominate at high rates. Batch a thousand points into one statement with UNNEST, or stream with COPY, instead of one INSERT per point. Use the same statement for retries with ON CONFLICT (series_id, ts) DO UPDATE, so a replayed batch cannot create duplicate points."
          ],
          "code": "use sqlx::PgPool;\nuse uuid::Uuid;\n\npub struct Point {\n    pub series_id: Uuid,\n    pub ts: chrono::DateTime<chrono::Utc>,\n    pub value: f64,\n}\n\npub async fn insert_points(pool: &PgPool, points: &[Point]) -> sqlx::Result<u64> {\n    let series: Vec<Uuid> = points.iter().map(|p| p.series_id).collect();\n    let ts: Vec<chrono::DateTime<chrono::Utc>> = points.iter().map(|p| p.ts).collect();\n    let values: Vec<f64> = points.iter().map(|p| p.value).collect();\n\n    sqlx::query(\n        r#\"INSERT INTO metrics (series_id, ts, value)\n           SELECT * FROM UNNEST($1::uuid[], $2::timestamptz[], $3::float8[])\n           ON CONFLICT (series_id, ts) DO UPDATE SET value = EXCLUDED.value\"#,\n    )\n    .bind(&series)\n    .bind(&ts)\n    .bind(&values)\n    .execute(pool)\n    .await\n    .map(|done| done.rows_affected())\n}\n"
        },
        {
          "h": "Partition by time and size the chunks",
          "p": [
            "Range partitioning by day or week turns retention and bulk deletes into metadata operations, and keeps each index small enough to stay in memory. Target partitions of a few gigabytes; a partition per hour on a modest table gives thousands of relations, and planning time becomes the bottleneck before scanning does.",
            "Pruning only happens when the query constrains the partition key: WHERE ts >= now() - interval '1 hour' prunes, while WHERE series_id = $1 alone inspects every partition. For the time column, BRIN is often the right index: hundreds of kilobytes covering months of naturally ordered data, where a B-tree would be gigabytes."
          ],
          "code": "CREATE TABLE metrics (\n    series_id uuid NOT NULL,\n    ts        timestamptz NOT NULL,\n    value     double precision NOT NULL\n) PARTITION BY RANGE (ts);\n\nCREATE TABLE metrics_2026_04_01 PARTITION OF metrics\n    FOR VALUES FROM ('2026-04-01') TO ('2026-04-02');\n\n-- BRIN is tiny and effective because inserts arrive in time order.\nCREATE INDEX metrics_ts_brin ON metrics USING BRIN (ts)\n    WITH (pages_per_range = 32);\n\n-- Point lookups by series still want a B-tree, built per partition.\nCREATE INDEX metrics_series_ts ON metrics (series_id, ts DESC);\n",
          "tip": "BRIN degrades badly when inserts arrive out of order, because each page range then holds scattered timestamps. Check correlation before choosing it: SELECT correlation FROM pg_stats WHERE tablename = 'metrics'."
        },
        {
          "h": "Rollups beat scanning raw points",
          "p": [
            "A dashboard that scans a month of raw points does millions of rows of work to draw sixty pixels. Pre-aggregate into a rollup keyed by (series_id, bucket), storing count and sum rather than an average, because averages do not compose: the mean of per-minute means is not the mean of the hour.",
            "Refresh incrementally and only over closed buckets, because the current minute is incomplete. TimescaleDB continuous aggregates with a refresh policy do this for you; on plain Postgres, a rollup table plus an upsert over the last N closed buckets is the same idea with more moving parts, since a materialized view can only be refreshed as a whole."
          ],
          "code": "CREATE TABLE metrics_hourly (\n    series_id uuid NOT NULL,\n    bucket    timestamptz NOT NULL,\n    samples   bigint NOT NULL,\n    total     double precision NOT NULL,\n    lo        double precision NOT NULL,\n    hi        double precision NOT NULL,\n    PRIMARY KEY (series_id, bucket)\n);\n\n-- Recompute only closed buckets; the last two are still moving.\nINSERT INTO metrics_hourly (series_id, bucket, samples, total, lo, hi)\nSELECT series_id,\n       date_trunc('hour', ts) AS bucket,\n       count(*), sum(value), min(value), max(value)\nFROM metrics\nWHERE ts >= now() - interval '3 hours'\n  AND ts <  date_trunc('hour', now())\nGROUP BY series_id, date_trunc('hour', ts)\nON CONFLICT (series_id, bucket) DO UPDATE\nSET samples = EXCLUDED.samples,\n    total   = EXCLUDED.total,\n    lo      = EXCLUDED.lo,\n    hi      = EXCLUDED.hi;\n\n-- Averages are derived at read time, never stored pre-averaged.\nSELECT series_id, bucket, total / samples AS avg_value\nFROM metrics_hourly\nWHERE bucket >= now() - interval '24 hours';\n"
        },
        {
          "h": "Late data and retention",
          "p": [
            "Sensors buffer and clocks drift, so a point can arrive for a bucket that was already rolled up. Partition by event time, not arrival time, so the row lands in the right partition, then re-refresh the affected buckets. Decide a lateness horizon of an hour or a day and reject or divert points beyond it explicitly, rather than letting them silently distort history.",
            "Retention is a DROP, not a DELETE: detach the oldest partition and drop it, which is a metadata operation instead of a billion-row vacuum. Keep rollups longer than raw data, and monitor the retention job like a backup, because a retention job that stops is a disk-full incident with a delay."
          ],
          "list": [
            "Partition by event time, so a late point still lands in its own day",
            "Refresh only closed buckets, and re-refresh when a late point arrives",
            "Drop raw partitions on a schedule; keep hourly rollups far longer",
            "Alert when the newest partition is missing or the oldest was not dropped"
          ],
          "tip": "Create partitions ahead of time with pg_partman or a cron job. A DEFAULT partition as a landing zone hides the day you forgot, and moving rows out of it later takes an ACCESS EXCLUSIVE lock."
        }
      ],
      "exercise": {
        "prompt": "Implement insert_batch(pool, points) as one statement using UNNEST, idempotent on (series_id, ts), returning rows affected. Then implement expired_partitions(pool, before) returning the child partition names whose upper bound is older than `before`.",
        "starter": "use sqlx::PgPool;\nuse uuid::Uuid;\n\npub struct Point {\n    pub series_id: Uuid,\n    pub ts: chrono::DateTime<chrono::Utc>,\n    pub value: f64,\n}\n\npub async fn insert_batch(pool: &PgPool, points: &[Point]) -> sqlx::Result<u64> {\n    // one INSERT ... SELECT FROM UNNEST(...) ON CONFLICT (series_id, ts)\n    todo!()\n}\n\npub async fn expired_partitions(pool: &PgPool, before: &str) -> sqlx::Result<Vec<String>> {\n    // pg_inherits + pg_class, upper bound from pg_get_expr(c.relpartbound, c.oid)\n    todo!()\n}\n",
        "hint": "Bind three parallel arrays and cast them in SQL: $1::uuid[], $2::timestamptz[], $3::float8[]. For partitions, join pg_inherits to pg_class and extract the upper bound from pg_get_expr(c.relpartbound, c.oid) with a regexp match against TO ('...').",
        "solution": "use sqlx::PgPool;\nuse uuid::Uuid;\n\npub struct Point {\n    pub series_id: Uuid,\n    pub ts: chrono::DateTime<chrono::Utc>,\n    pub value: f64,\n}\n\npub async fn insert_batch(pool: &PgPool, points: &[Point]) -> sqlx::Result<u64> {\n    let series: Vec<Uuid> = points.iter().map(|p| p.series_id).collect();\n    let ts: Vec<chrono::DateTime<chrono::Utc>> = points.iter().map(|p| p.ts).collect();\n    let values: Vec<f64> = points.iter().map(|p| p.value).collect();\n\n    sqlx::query(\n        r#\"INSERT INTO metrics (series_id, ts, value)\n           SELECT * FROM UNNEST($1::uuid[], $2::timestamptz[], $3::float8[])\n           ON CONFLICT (series_id, ts) DO UPDATE SET value = EXCLUDED.value\"#,\n    )\n    .bind(&series)\n    .bind(&ts)\n    .bind(&values)\n    .execute(pool)\n    .await\n    .map(|done| done.rows_affected())\n}\n\npub async fn expired_partitions(pool: &PgPool, before: &str) -> sqlx::Result<Vec<String>> {\n    sqlx::query_scalar(\n        r#\"SELECT c.relname\n           FROM pg_inherits i\n           JOIN pg_class c ON c.oid = i.inhrelid\n           WHERE i.inhparent = 'metrics'::regclass\n             AND (regexp_match(pg_get_expr(c.relpartbound, c.oid),\n                               'TO \\(''([^'']+)''\\)'))[1]::timestamptz <= $1::timestamptz\"#,\n    )\n    .bind(before)\n    .fetch_all(pool)\n    .await\n}\n\n// Dropping the returned partitions is the retention job: ALTER TABLE ... DETACH\n// first if you want to archive them, then DROP. Never DELETE the rows.\n"
      },
      "production": [
        "Partition by event time on day or week boundaries sized to a few GB, and pre-create partitions before they are needed",
        "Batch ingest through UNNEST or COPY with ON CONFLICT on (series_id, ts), so retries and late duplicates are idempotent",
        "Use BRIN for append-ordered timestamps and a B-tree on (series_id, ts) for point lookups; verify correlation before choosing BRIN",
        "Store count and sum in rollups, derive averages at read time, and refresh only buckets that are closed",
        "Retire raw partitions with DETACH and DROP on a monitored schedule, keeping rollups longer than raw data"
      ],
      "crates": [
        "sqlx",
        "uuid",
        "chrono",
        "tokio"
      ],
      "github": [
        {
          "name": "timescaledb",
          "url": "https://github.com/timescale/timescaledb"
        },
        {
          "name": "pg_partman",
          "url": "https://github.com/pgpartman/pg_partman"
        }
      ],
      "pitfall": "A dashboard query that filters only on series_id scans every partition: pruning needs a predicate on the partition key, so the index on (series_id, ts) is used partition by partition until the whole table has been read.",
      "resources": [
        {
          "title": "PostgreSQL: table partitioning, pruning and partition maintenance",
          "url": "https://www.postgresql.org/docs/current/ddl-partitioning.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: BRIN indexes and pages_per_range",
          "url": "https://www.postgresql.org/docs/current/brin.html",
          "kind": "docs"
        },
        {
          "title": "timescaledb: hypertables, continuous aggregates and retention policies",
          "url": "https://github.com/timescale/timescaledb",
          "kind": "repo"
        },
        {
          "title": "pg_partman: partition creation and retention automation",
          "url": "https://github.com/pgpartman/pg_partman",
          "kind": "repo"
        },
        {
          "title": "How to Use Continuous Aggregates in TimescaleDB to Keep Device Telemetry Dashboards Fast",
          "url": "https://www.youtube.com/watch?v=7HRl6HnbNDw",
          "kind": "video"
        }
      ],
      "quickbytes": [
        "Batch points with UNNEST and ON CONFLICT (series_id, ts); one INSERT per point is a round-trip tax.",
        "A partition key missing from the WHERE clause means every partition is scanned.",
        "Store count and sum, never a precomputed average: averages do not compose across buckets."
      ],
      "questions": [
        {
          "q": "A dashboard averages the per-hour avg_value column to get a daily average. Why is the number wrong?",
          "options": [
            "Because date_trunc loses the timezone offset",
            "Because the mean of hourly means weights quiet and busy hours equally, so it is not the mean of the day",
            "Because double precision cannot represent an average",
            "Because the rollup refreshed before the bucket closed"
          ],
          "answer": 1,
          "explain": "Averages do not compose. Store sum and count per bucket, then divide total sums by total counts at read time to get the true mean."
        },
        {
          "q": "You add WHERE series_id = $1 to a query against a table partitioned by day. What does the planner do?",
          "options": [
            "Prunes to the partitions containing that series",
            "Scans every partition, because pruning requires a constraint on ts",
            "Rejects the query, because the partition key is missing",
            "Uses the BRIN index on ts to skip partitions"
          ],
          "answer": 1,
          "explain": "Partition pruning is driven by constraints on the partition key. Without a ts predicate, every partition is fair game, and the per-series index only helps inside each one."
        },
        {
          "q": "When is a BRIN index on the timestamp column the wrong choice?",
          "options": [
            "When the table is append-only and rows arrive in time order",
            "When rows arrive out of order, so each page range holds scattered timestamps",
            "When the table has more than a million rows",
            "When queries also filter on series_id"
          ],
          "answer": 1,
          "explain": "BRIN relies on physical correlation between value and block position. Random-ordered inserts destroy that correlation and the index stops excluding ranges."
        }
      ]
    },
    {
      "id": "d13",
      "n": 13,
      "title": "Full-text search: tsvector, GIN and ranking",
      "minutes": 85,
      "level": "advanced",
      "goal": "Build search that is index-backed and stably ordered, and know when a dedicated search engine is the honest answer.",
      "sections": [
        {
          "h": "Store the document, index the lexemes",
          "p": [
            "to_tsvector(config, text) normalizes case, stems, drops stop words and records positions. The result is what an index can match; the original text stays for display and for ts_headline. Generate it in the table so it cannot drift from the source columns.",
            "A generated column needs an immutable expression, so pass the configuration explicitly: the two-argument to_tsvector is immutable, while the one-argument form depends on default_text_search_config and is not. Use websearch_to_tsquery for user input: it understands quoted phrases, OR and leading minus, and it cannot raise a syntax error the way to_tsquery can."
          ],
          "code": "ALTER TABLE notes\n    ADD COLUMN search tsvector\n    GENERATED ALWAYS AS (\n        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||\n        setweight(to_tsvector('english', coalesce(body, '')), 'B')\n    ) STORED;\n\nCREATE INDEX notes_search_idx ON notes USING GIN (search);\n\n-- websearch_to_tsquery accepts raw user input without a syntax error.\nSELECT n.id, n.title, ts_rank_cd(n.search, q.query) AS rank\nFROM notes n, websearch_to_tsquery('english', $1) AS q(query)\nWHERE n.search @@ q.query\n  AND n.tenant_id = $2\nORDER BY rank DESC, n.id DESC\nLIMIT 20;\n\n-- Snippets are expensive: build them only for the rows you return.\nSELECT ts_headline('english', body, q.query,\n                   'StartSel=<b>, StopSel=</b>, MaxFragments=2')\nFROM notes n, websearch_to_tsquery('english', $1) AS q(query)\nWHERE n.search @@ q.query\nLIMIT 10;\n",
          "tip": "to_tsquery('english', 'foo (bar') raises a syntax error on user input, which becomes a 500. websearch_to_tsquery is designed for text typed by a person."
        },
        {
          "h": "GIN is fast to search and expensive to update",
          "p": [
            "GIN builds an inverted list per lexeme, so a multi-word query intersects posting lists instead of scanning rows. The cost lands on writes: each insert touches many index entries, buffered in a pending list when fastupdate is on. That list is why a burst of writes can make searches briefly slower, and why gin_clean_pending_list exists.",
            "GIN does not store weight labels, so a query that filters on weights must fetch the heap row to recheck. GiST is lossy by design and cheaper to update; it suits write-heavy text and very large vocabularies, at the price of false positives that Postgres resolves by rechecking the heap."
          ],
          "code": "-- Default: fast reads, heavier writes.\nCREATE INDEX notes_search_idx ON notes USING GIN (search);\n\n-- Write-heavy table: bound the pending list and clean it on a schedule.\nALTER INDEX notes_search_idx SET (fastupdate = on, gin_pending_list_limit = '8MB');\nSELECT gin_clean_pending_list('notes_search_idx');\n\n-- GiST: lossy, cheaper to update, tolerant of a very large vocabulary.\nCREATE INDEX notes_search_gist ON notes USING GIST (search);\n\n-- Which one is the planner actually choosing?\nEXPLAIN (ANALYZE, BUFFERS)\nSELECT id FROM notes WHERE search @@ websearch_to_tsquery('english', 'wal replay');\n",
          "tip": "CREATE INDEX CONCURRENTLY does not block writes, but it takes longer, needs its own transaction, and leaves an INVALID index if it fails. Check pg_index before trusting it."
        },
        {
          "h": "Rank is not a sort key you can paginate on",
          "p": [
            "ts_rank_cd scores by cover density, so many rows share the same score, especially short documents. Paging with OFFSET on a score silently reorders as data changes. Paginate on (rank, id) with a strict row comparison, and compute rank once per row instead of twice.",
            "Ranking is only as good as the weights and the query. Weights A to D let a title match outrank a body match, and normalization flags damp long documents. None of that produces a total order, so the id tiebreaker is mandatory, exactly as for any other keyset cursor."
          ],
          "code": "-- Keyset pagination over (rank, id): pass the last row's values back in.\nWITH q AS (SELECT websearch_to_tsquery('english', $1) AS query)\nSELECT n.id, n.title, ts_rank_cd(n.search, q.query, 32) AS rank\nFROM notes n, q\nWHERE n.search @@ q.query\n  AND n.tenant_id = $5\n  AND ($2::real IS NULL\n       OR (ts_rank_cd(n.search, q.query, 32), n.id) < ($2::real, $3::uuid))\nORDER BY rank DESC, n.id DESC\nLIMIT $4;\n"
        },
        {
          "h": "Where Postgres search stops",
          "p": [
            "Postgres gives you one dictionary set per language, four weight labels and a handful of rank functions. There is no typo tolerance unless you add pg_trgm, whose trigram indexes are large and slower than GIN on lexemes; there is no faceting, no per-field boosting beyond the weights, and no distributed index.",
            "The break-even is the query mix. If people type exact words in a known language and the corpus fits one database, Postgres is excellent and removes an entire consistency problem. If they need fuzzy matching, synonyms, multi-language relevance or search across shards, use a dedicated engine, treat Postgres as the source of truth, and measure the indexing lag."
          ],
          "list": [
            "pg_trgm serves LIKE '%term%' and typo tolerance through gin_trgm_ops",
            "unaccent must be applied to both the document and the query, or they disagree",
            "ts_headline only for the page you return, never across the whole result set"
          ],
          "tip": "A generated tsvector column cannot depend on unaccent unless the extension's function is marked immutable in an immutable wrapper, which is why most teams apply unaccent in an expression index instead."
        }
      ],
      "exercise": {
        "prompt": "Write search_notes(pool, tenant, query, limit) returning (id, title, rank) ordered by rank with a deterministic tiebreaker, using websearch_to_tsquery and a GIN index. Explain in one comment why the tiebreaker cannot be dropped.",
        "starter": "use sqlx::PgPool;\nuse uuid::Uuid;\n\n#[derive(Debug, sqlx::FromRow)]\npub struct Hit {\n    pub id: Uuid,\n    pub title: String,\n    pub rank: f32,\n}\n\npub async fn search_notes(\n    pool: &PgPool,\n    tenant: Uuid,\n    query: &str,\n    limit: i64,\n) -> sqlx::Result<Vec<Hit>> {\n    // search @@ websearch_to_tsquery(...) ORDER BY rank DESC, id DESC\n    todo!()\n}\n",
        "hint": "Put the tsquery in the FROM clause as a function call and alias its column, so the same value is used in WHERE and ORDER BY. ts_rank_cd returns real, which maps to f32.",
        "solution": "use sqlx::PgPool;\nuse uuid::Uuid;\n\n#[derive(Debug, sqlx::FromRow)]\npub struct Hit {\n    pub id: Uuid,\n    pub title: String,\n    pub rank: f32,\n}\n\npub async fn search_notes(\n    pool: &PgPool,\n    tenant: Uuid,\n    query: &str,\n    limit: i64,\n) -> sqlx::Result<Vec<Hit>> {\n    sqlx::query_as::<_, Hit>(\n        r#\"SELECT n.id, n.title, ts_rank_cd(n.search, q.query) AS rank\n           FROM notes n, websearch_to_tsquery('english', $1) AS q(query)\n           WHERE n.tenant_id = $2\n             AND n.search @@ q.query\n           ORDER BY rank DESC, n.id DESC\n           LIMIT $3\"#,\n    )\n    .bind(query)\n    .bind(tenant)\n    .bind(limit)\n    .fetch_all(pool)\n    .await\n}\n\n// ts_rank_cd returns ties constantly: many documents score identically, so\n// without id the sort order (and therefore any keyset page) is unstable.\n"
      },
      "production": [
        "Generate the tsvector column from an explicitly configured to_tsvector so the expression stays immutable and cannot drift",
        "Index with GIN for read-heavy search; watch gin_pending_list_limit and clean the pending list on write-heavy tables",
        "Use websearch_to_tsquery for anything typed by a user, and never interpolate raw input into to_tsquery",
        "Paginate on (rank, id), not OFFSET on rank, and compute the rank expression once per row",
        "Budget for pg_trgm or a dedicated engine when typo tolerance or multi-language relevance is a requirement, not an afterthought"
      ],
      "crates": [
        "sqlx",
        "uuid",
        "serde_json"
      ],
      "github": [
        {
          "name": "postgres",
          "url": "https://github.com/postgres/postgres"
        },
        {
          "name": "rum",
          "url": "https://github.com/postgrespro/rum"
        }
      ],
      "pitfall": "A GIN index cannot answer a predicate that extracts text: WHERE body ILIKE '%rust%' or (search_tsv->>'x') = 'y' bypasses the index entirely and seq scans the table, no matter how the index was declared.",
      "resources": [
        {
          "title": "PostgreSQL: controlling text search, websearch_to_tsquery and ranking",
          "url": "https://www.postgresql.org/docs/current/textsearch-controls.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: preferred index types for text search (GIN vs GiST)",
          "url": "https://www.postgresql.org/docs/current/textsearch-indexes.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: pg_trgm, similarity and trigram indexes",
          "url": "https://www.postgresql.org/docs/current/pgtrgm.html",
          "kind": "docs"
        },
        {
          "title": "RUM: inverted index with ranking and phrase support for PostgreSQL",
          "url": "https://github.com/postgrespro/rum",
          "kind": "repo"
        }
      ],
      "quickbytes": [
        "Pass the text search config explicitly or the generated column is not immutable and will not compile.",
        "GIN stores lexemes, not weights: a weight-filtered query rechecks every candidate row.",
        "ts_rank_cd ties constantly; add id to ORDER BY or your pages will not be stable."
      ],
      "questions": [
        {
          "q": "Why does a query with ts_rank_cd(search, query) in a weight-restricted predicate (search @@ query AND search @@ 'foo:1') need a heap fetch that a plain lexeme match would not?",
          "options": [
            "Because GIN indexes only store lexemes, not weight labels, so weights must be rechecked against the row",
            "Because ts_rank_cd is not immutable and cannot be indexed",
            "Because GIN indexes are always lossy for multi-word queries",
            "Because tsvector columns are stored out of line in TOAST"
          ],
          "answer": 0,
          "explain": "The GIN index stores words without position or weight labels. Any weight-sensitive condition has to be rechecked on the heap row after the index narrows the candidates."
        },
        {
          "q": "A search box passes raw user input to to_tsquery('english', $1). A user types 'rust (async'. What happens?",
          "options": [
            "The query returns no rows",
            "Postgres raises a syntax error, which surfaces as a 500 unless handled",
            "The parser silently drops the unbalanced parenthesis",
            "The query falls back to a trigram scan"
          ],
          "answer": 1,
          "explain": "to_tsquery requires valid tsquery syntax. websearch_to_tsquery is built for human input and will not raise on the same string."
        },
        {
          "q": "Two searches for the same term return the same 20 documents in a different order across requests. What is the missing piece?",
          "options": [
            "A GIN index instead of GiST",
            "A deterministic tiebreaker on a unique column in ORDER BY",
            "A lower default_statistics_target",
            "A larger work_mem for the sort"
          ],
          "answer": 1,
          "explain": "Rank scores tie constantly, and ties are returned in whatever order the scan produced. Adding id (or another unique key) to ORDER BY makes the result a total order."
        }
      ]
    },
    {
      "id": "d14",
      "n": 14,
      "title": "JSONB modelling: containment, GIN and expression indexes",
      "minutes": 80,
      "level": "advanced",
      "goal": "Model semi-structured attributes so the queries you actually run are index-backed, and keep document updates from becoming a contention point.",
      "sections": [
        {
          "h": "jsonb is a document, not an escape from schema",
          "p": [
            "jsonb stores a decomposed binary value: keys deduplicated, key order discarded, numbers held as numeric. It validates JSON syntax and nothing else, so the shape of your documents is enforced by application code or by CHECK constraints, and both drift unless they are written down and tested. The database will happily store a string where the application expects an object.",
            "The cost is update amplification. Every UPDATE writes a new row version with a new copy of the whole document, TOAST included. A large document mutated on every request is a row-lock hotspot and a WAL generator. Keep documents atomic and small, and promote anything you filter, join or sort on into a real column."
          ],
          "code": "CREATE TABLE orders (\n    id          uuid PRIMARY KEY,\n    tenant_id   uuid NOT NULL,\n    status      text NOT NULL,\n    total_cents bigint NOT NULL,\n    -- Everything queried lives in a column; attributes hold the rest.\n    attributes  jsonb NOT NULL DEFAULT '{}'::jsonb,\n    CONSTRAINT attributes_is_object CHECK (jsonb_typeof(attributes) = 'object')\n);\n\nCREATE INDEX orders_tenant_total_idx ON orders (tenant_id, total_cents DESC);\n\n-- Optional keys: index the expression, not the whole document.\nCREATE INDEX orders_attributes_gin\n    ON orders USING GIN (attributes jsonb_path_ops);\n"
        },
        {
          "h": "Containment is the operator GIN knows",
          "p": [
            "GIN on jsonb indexes keys and values, so @> (contains) is served directly. There are two operator classes. jsonb_ops indexes keys and values separately and supports ?, ?| and ?&; jsonb_path_ops hashes each value with its key path, giving a smaller and more selective index for @>, @? and @@, at the cost of the key-exists operators and of any entry for empty structures.",
            "Choose jsonb_path_ops unless you need the key-exists operators. Then write queries as containment rather than extraction: attributes @> '{\"priority\":\"high\"}' can use the index, while attributes->>'priority' = 'high' cannot, and will seq scan a large table. The difference is one operator, and it is invisible in a code review."
          ],
          "code": "-- Served by the GIN index: containment of a sub-document.\nSELECT id FROM orders\nWHERE attributes @> '{\"priority\": \"high\", \"channel\": \"web\"}';\n\n-- Not served: extraction produces text, which the jsonb GIN index does not cover.\nSELECT id FROM orders WHERE attributes->>'priority' = 'high';\n\n-- Fix the second query with an expression B-tree index instead.\nCREATE INDEX orders_priority_idx ON orders ((attributes->>'priority'));\n\n-- jsonb_path_ops cannot answer key-existence at all; jsonb_ops can.\nSELECT id FROM orders WHERE attributes ? 'discount_code';\n"
        },
        {
          "h": "Nested arrays and jsonpath",
          "p": [
            "Containment is nested, so @> can match inside an array of sub-objects without unnesting. When the predicate is beyond containment, jsonpath gives you a filter language: @? tests existence, @@ tests a predicate, and both use a GIN index for the accessor chains they contain.",
            "Unnesting with jsonb_array_elements is sometimes necessary, but it multiplies rows and defeats index-only paths. If a query needs a lateral join over an array on every request, that array is a table trying to get out: model it relationally and keep JSONB for the residual."
          ],
          "code": "-- Nested containment: any tag object with both fields.\nSELECT id FROM orders\nWHERE attributes @> '{\"tags\": [{\"kind\": \"fraud\", \"level\": 2}]}';\n\n-- jsonpath: items priced over 100; indexable for the $.items[*].price chain.\nSELECT id FROM orders\nWHERE attributes @? '$.items[*] ? (@.price > 100)';\n\n-- Unnest only when you must; the row multiplication is real.\nSELECT o.id, item->>'sku' AS sku\nFROM orders o, jsonb_array_elements(o.attributes->'items') AS item\nWHERE o.tenant_id = $1;\n",
          "tip": "jsonb_path_ops creates no index entries for value-less structures like {\"a\": {}}. A query that searches for exactly that shape falls back to a full index scan."
        },
        {
          "h": "Reading jsonb from Rust without lying to the compiler",
          "p": [
            "sqlx maps serde_json::Value to jsonb and back, and sqlx::types::Json<T> wraps a typed struct. The trap is evolution: a struct with required fields breaks the first time a producer adds or renames a key, and the failure is a decode error at read time rather than a compile error.",
            "Decide the compatibility rule before you need it: additive-only keys, #[serde(default)] on anything optional, and an explicit version field when the shape really changes. Then a producer can ship first and consumers can catch up, which is the same expand-and-contract discipline as a column migration."
          ],
          "code": "use serde::{Deserialize, Serialize};\nuse sqlx::types::Json;\nuse std::collections::BTreeMap;\n\n#[derive(Debug, Serialize, Deserialize)]\npub struct Attributes {\n    pub priority: String,\n    #[serde(default)]\n    pub channel: Option<String>,\n    /// Unknown keys are preserved on read, so producers can add fields first.\n    #[serde(flatten)]\n    pub extra: BTreeMap<String, serde_json::Value>,\n}\n\npub async fn attributes(pool: &sqlx::PgPool, id: uuid::Uuid) -> sqlx::Result<Option<Attributes>> {\n    let row: Option<Json<Attributes>> =\n        sqlx::query_scalar(\"SELECT attributes FROM orders WHERE id = $1\")\n            .bind(id)\n            .fetch_optional(pool)\n            .await?;\n\n    Ok(row.map(|json| json.0))\n}\n"
        }
      ],
      "exercise": {
        "prompt": "Write paid_orders(pool, tenant, min_total_cents) returning ids of orders whose attributes contain status = paid and whose total is at least the threshold, plus the two indexes that serve it. Say which predicate each index handles.",
        "starter": "use sqlx::PgPool;\nuse uuid::Uuid;\n\npub async fn paid_orders(\n    pool: &PgPool,\n    tenant: Uuid,\n    min_total_cents: i64,\n) -> sqlx::Result<Vec<Uuid>> {\n    // tenant + total range + attributes @> '{\"status\":\"paid\"}'\n    todo!()\n}\n",
        "hint": "Write the containment check as attributes @> '{\"status\": \"paid\"}' so GIN can serve it, and add (tenant_id, total_cents DESC) for the equality and range. The planner picks one and rechecks the other.",
        "solution": "use sqlx::PgPool;\nuse uuid::Uuid;\n\npub async fn paid_orders(\n    pool: &PgPool,\n    tenant: Uuid,\n    min_total_cents: i64,\n) -> sqlx::Result<Vec<Uuid>> {\n    sqlx::query_scalar::<_, Uuid>(\n        r#\"SELECT id FROM orders\n           WHERE tenant_id = $1\n             AND total_cents >= $2\n             AND attributes @> '{\"status\": \"paid\"}'\n           ORDER BY total_cents DESC\"#,\n    )\n    .bind(tenant)\n    .bind(min_total_cents)\n    .fetch_all(pool)\n    .await\n}\n\n// Indexes:\n//   orders (tenant_id, total_cents DESC) - serves the tenant equality, the range\n//     and the ORDER BY, so the sort is free once the scan starts at the right row.\n//   GIN (attributes jsonb_path_ops) - serves the containment predicate.\n// The planner uses one to narrow and rechecks the other on the heap; two\n// narrower partial indexes (per large tenant) usually beat one wide index.\n"
      },
      "production": [
        "Keep documents small and atomic; every update rewrites the whole value, TOAST included, and locks the row",
        "Promote fields used in WHERE, JOIN or ORDER BY into columns with their own indexes; JSONB holds the residual attributes",
        "Use jsonb_path_ops for containment-heavy workloads and jsonb_ops only when key-existence operators are required",
        "Add a CHECK on jsonb_typeof and treat the document shape as an additive-only contract in serde",
        "Verify with EXPLAIN that the chosen index is used; a containment query that rechecks every row is worse than a column"
      ],
      "crates": [
        "sqlx",
        "serde_json",
        "serde",
        "uuid"
      ],
      "github": [
        {
          "name": "serde_json",
          "url": "https://github.com/serde-rs/json"
        },
        {
          "name": "sqlx",
          "url": "https://github.com/transact-rs/sqlx"
        }
      ],
      "pitfall": "Two operator classes look interchangeable until a query uses ?: jsonb_path_ops supports only @>, @? and @@, so key-existence checks silently fall back to a sequential scan after a migration to the smaller index.",
      "resources": [
        {
          "title": "PostgreSQL: json and jsonb, containment, indexing and subscripting",
          "url": "https://www.postgresql.org/docs/current/datatype-json.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: JSON functions and operators (@>, @?, jsonb_path_query)",
          "url": "https://www.postgresql.org/docs/current/functions-json.html",
          "kind": "docs"
        },
        {
          "title": "sqlx::types::Json: typed jsonb encoding and decoding",
          "url": "https://docs.rs/sqlx/0.8.6/sqlx/types/struct.Json.html",
          "kind": "docs"
        },
        {
          "title": "serde_json: the Value type sqlx maps jsonb to",
          "url": "https://github.com/serde-rs/json",
          "kind": "repo"
        }
      ],
      "quickbytes": [
        "Containment (@>) is indexable; extraction (->>) is not, unless you index the expression itself.",
        "jsonb_path_ops is smaller and more selective but gives up ?, ?| and ?&.",
        "Every jsonb UPDATE rewrites the whole document: keep it small or it becomes a lock hotspot."
      ],
      "questions": [
        {
          "q": "A team switches a GIN index from jsonb_ops to jsonb_path_ops for size. Which query stops being index-backed?",
          "options": [
            "attributes @> '{\"status\":\"paid\"}'",
            "attributes @? '$.items[*] ? (@.price > 100)'",
            "attributes ? 'discount_code'",
            "attributes @@ '$.total > 100'"
          ],
          "answer": 2,
          "explain": "jsonb_path_ops hashes values with their key path and does not index keys separately, so the key-existence operator ? has no index support and falls back to a scan."
        },
        {
          "q": "Orders carry a 40 KB jsonb document that is updated on every status change. What is the main cost?",
          "options": [
            "Each update rewrites the entire document as a new row version, producing WAL and TOAST churn",
            "jsonb updates are blocked until the GIN pending list is flushed",
            "jsonb values are stored out of line and cannot be updated at all",
            "The GIN index is rebuilt on every update"
          ],
          "answer": 0,
          "explain": "Postgres has no in-place document edit: an UPDATE writes a new tuple with a fresh copy of the value. Large, frequently mutated documents amplify WAL and vacuum work."
        },
        {
          "q": "Why does WHERE attributes->>'priority' = 'high' ignore a GIN index on attributes?",
          "options": [
            "Because ->> returns text, so the predicate is on a different expression than the indexed column",
            "Because text comparison is not supported by GIN",
            "Because the index was created without a WHERE clause",
            "Because jsonb keys are case-sensitive"
          ],
          "answer": 0,
          "explain": "Indexes match expressions, not intentions. The index covers the jsonb column; the predicate is on a text expression, so either rewrite it as containment or index ((attributes->>'priority'))."
        }
      ]
    },
    {
      "id": "d15",
      "n": 15,
      "title": "Multi-tenant isolation with row-level security",
      "minutes": 100,
      "level": "industry",
      "goal": "Make the database, not every handler, responsible for tenant scoping, and make the tenant setting impossible to leak across pooled connections.",
      "sections": [
        {
          "h": "A policy cannot be forgotten",
          "p": [
            "Tenant scoping in WHERE clauses fails the same way every time: one new endpoint, one maintenance script, one admin tool, and a tenant sees another tenant's rows. Row-level security moves the rule into the database, where it applies to every statement issued by that role, including the ones you did not write and the ones you will write next quarter.",
            "Two defaults defeat it. The table owner bypasses policies unless you FORCE ROW LEVEL SECURITY, and roles with BYPASSRLS, including superusers, bypass them always. The application must connect as a role that is neither, and the migration role that owns the tables must be a different role."
          ],
          "code": "CREATE TABLE invoices (\n    id          uuid PRIMARY KEY,\n    tenant_id   uuid NOT NULL,\n    total_cents bigint NOT NULL\n);\n\nCREATE INDEX invoices_tenant_idx ON invoices (tenant_id, id);\n\nALTER TABLE invoices ENABLE ROW LEVEL SECURITY;\n-- The owner is the migration role; it must not silently bypass the policy.\nALTER TABLE invoices FORCE ROW LEVEL SECURITY;\n\nCREATE POLICY invoices_tenant_isolation ON invoices\n    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)\n    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);\n\nGRANT SELECT, INSERT, UPDATE, DELETE ON invoices TO app_role;\n",
          "tip": "current_setting('app.tenant_id', true) returns NULL when the setting is missing, so the comparison is NULL and no rows match. Failing closed is the point; do not COALESCE it to a default tenant."
        },
        {
          "h": "The tenant lives in the transaction, not the session",
          "p": [
            "With a pool, a session-level SET outlives the request: the next request on that connection inherits tenant A's id and silently reads tenant A's data. SET LOCAL is scoped to the transaction and reverts at commit, which is what you want, and it means the setting must be made inside the same transaction as the queries.",
            "SET LOCAL cannot take a bind parameter, so a tenant id interpolated into SQL is an injection risk. Use set_config('app.tenant_id', $1, true), which is an ordinary function call with a parameter and the same transaction-local semantics. If the setting is missing the policy matches nothing, so the failure mode is a blank response rather than a cross-tenant read."
          ],
          "code": "use sqlx::{PgPool, Postgres, Transaction};\nuse uuid::Uuid;\n\n/// One transaction, one tenant. Queries run on the returned transaction run\n/// under the policy without needing their own WHERE tenant_id clause.\npub async fn begin_tenant(\n    pool: &PgPool,\n    tenant: Uuid,\n) -> sqlx::Result<Transaction<'static, Postgres>> {\n    let mut tx = pool.begin().await?;\n\n    // set_config(..., is_local = true) is SET LOCAL with a bind parameter.\n    sqlx::query(\"SELECT set_config('app.tenant_id', $1, true)\")\n        .bind(tenant.to_string())\n        .execute(&mut *tx)\n        .await?;\n\n    Ok(tx)\n}\n\npub async fn count_invoices(pool: &PgPool, tenant: Uuid) -> sqlx::Result<i64> {\n    let mut tx = begin_tenant(pool, tenant).await?;\n\n    // No WHERE clause: the policy supplies it.\n    let count = sqlx::query_scalar::<_, i64>(\"SELECT count(*) FROM invoices\")\n        .fetch_one(&mut *tx)\n        .await?;\n\n    tx.commit().await?;\n    Ok(count)\n}\n"
        },
        {
          "h": "Policies must be cheap and complete",
          "p": [
            "The policy expression runs for every row before your own predicates, so it must be indexable. Equality on tenant_id with an index on (tenant_id, id) keeps plans as index scans; a subquery or a function call per row turns every query into a scan with a filter.",
            "Cover all four commands. USING filters what SELECT, UPDATE and DELETE can see; WITH CHECK validates rows that INSERT or UPDATE writes. A policy without WITH CHECK lets a tenant insert a row stamped with another tenant's id, which is data corruption today and a cross-tenant read the moment a query runs without the policy."
          ],
          "code": "-- A second table with different read and write rules: no ALL policy here,\n-- so these are the only policies that apply.\nCREATE POLICY payments_read ON payments\n    FOR SELECT\n    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);\n\nCREATE POLICY payments_insert ON payments\n    FOR INSERT\n    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);\n\n-- Restrictive policies are ANDed with the permissive ones.\nCREATE POLICY payments_sane_total ON payments\n    AS RESTRICTIVE\n    FOR INSERT\n    WITH CHECK (total_cents > 0 AND total_cents < 100_000_000);\n",
          "tip": "Permissive policies are ORed. Adding a second FOR SELECT policy that is also permissive widens access instead of narrowing it; use AS RESTRICTIVE for extra conditions."
        },
        {
          "h": "Prove isolation, then keep proving it",
          "p": [
            "A policy is only correct if it fails closed. Test it with two tenants in CI: as tenant A, every table must return zero rows belonging to tenant B, including through joins and through every ORM path. Then test the negative: with app.tenant_id unset, queries must return nothing rather than everything.",
            "Add a startup assertion that the connected role is not superuser, does not have rolbypassrls, and does not own the tables, because one deployment with the wrong DSN silently disables all of it. Remember the documented gaps too: TRUNCATE and referential-integrity checks bypass policies."
          ],
          "code": "-- Startup check: refuse to serve if the role can bypass every policy.\nSELECT rolsuper, rolbypassrls\nFROM pg_roles\nWHERE rolname = current_user;\n\n-- And refuse to serve if it owns the tenant tables.\nSELECT count(*) AS owned_tables\nFROM pg_class c\nJOIN pg_roles r ON r.oid = c.relowner\nWHERE r.rolname = current_user AND c.relkind = 'r';\n\n-- What is enforced right now.\nSELECT tablename, policyname, cmd, qual, with_check\nFROM pg_policies\nWHERE tablename = 'invoices';\n"
        }
      ],
      "exercise": {
        "prompt": "Add a projects table with RLS that fails closed: SELECT sees only the current tenant's rows, INSERT rejects rows for another tenant, and a session with no app.tenant_id sees nothing. Write the SQL and a Rust helper that sets the tenant for exactly one transaction.",
        "starter": "use sqlx::{PgPool, Postgres, Transaction};\nuse uuid::Uuid;\n\n// TODO: SQL for the table, ENABLE + FORCE RLS, SELECT and INSERT policies,\n// and the grants for app_role.\n\npub async fn begin_tenant(\n    pool: &PgPool,\n    tenant: Uuid,\n) -> sqlx::Result<Transaction<'static, Postgres>> {\n    // set_config('app.tenant_id', $1, true) inside a fresh transaction\n    todo!()\n}\n",
        "hint": "Both policies compare tenant_id to current_setting('app.tenant_id', true)::uuid. The INSERT needs WITH CHECK, the SELECT needs USING, and FORCE ROW LEVEL SECURITY keeps the owner subject to both.",
        "solution": "use sqlx::{PgPool, Postgres, Transaction};\nuse uuid::Uuid;\n\n// CREATE TABLE projects (\n//     id uuid PRIMARY KEY,\n//     tenant_id uuid NOT NULL,\n//     name text NOT NULL\n// );\n// CREATE INDEX projects_tenant_idx ON projects (tenant_id, id);\n// ALTER TABLE projects ENABLE ROW LEVEL SECURITY;\n// ALTER TABLE projects FORCE ROW LEVEL SECURITY;\n//\n// CREATE POLICY projects_read ON projects FOR SELECT\n//     USING (tenant_id = current_setting('app.tenant_id', true)::uuid);\n// CREATE POLICY projects_write ON projects FOR INSERT\n//     WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);\n//\n// GRANT SELECT, INSERT, UPDATE, DELETE ON projects TO app_role;\n\npub async fn begin_tenant(\n    pool: &PgPool,\n    tenant: Uuid,\n) -> sqlx::Result<Transaction<'static, Postgres>> {\n    let mut tx = pool.begin().await?;\n\n    sqlx::query(\"SELECT set_config('app.tenant_id', $1, true)\")\n        .bind(tenant.to_string())\n        .execute(&mut *tx)\n        .await?;\n\n    Ok(tx)\n}\n\n// Missing setting means NULL, which matches no rows and rejects every insert:\n// the failure mode is \"sees nothing\", never \"sees everything\".\n"
      },
      "production": [
        "Connect the application as a role that is neither superuser nor BYPASSRLS, and own the tables with a separate migration role under FORCE ROW LEVEL SECURITY",
        "Set the tenant with set_config(..., true) inside the transaction that runs the queries; never with a session-level SET",
        "Give every tenant table both USING and WITH CHECK policies, and reserve AS RESTRICTIVE for additional constraints",
        "Add a two-tenant isolation test to CI that also asserts the unset-setting case returns zero rows",
        "Assert at startup that the connected role cannot bypass RLS and does not own the tables, and fail the boot if it can"
      ],
      "crates": [
        "sqlx",
        "uuid",
        "tokio"
      ],
      "github": [
        {
          "name": "sqlx",
          "url": "https://github.com/transact-rs/sqlx"
        },
        {
          "name": "postgres",
          "url": "https://github.com/postgres/postgres"
        }
      ],
      "pitfall": "A session-level SET app.tenant_id on a pooled connection survives the request: the next request gets that connection, skips its own SET on an early-return path, and reads another tenant's rows with no error anywhere.",
      "resources": [
        {
          "title": "PostgreSQL: row security policies, FORCE and policy interaction",
          "url": "https://www.postgresql.org/docs/current/ddl-rowsecurity.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: CREATE POLICY syntax, USING, WITH CHECK, RESTRICTIVE",
          "url": "https://www.postgresql.org/docs/current/sql-createpolicy.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: row_security setting and client connection defaults",
          "url": "https://www.postgresql.org/docs/current/runtime-config-client.html",
          "kind": "docs"
        },
        {
          "title": "sqlx Transaction: lifetime and commit semantics for per-request settings",
          "url": "https://docs.rs/sqlx/0.8.6/sqlx/struct.Transaction.html",
          "kind": "docs"
        },
        {
          "title": "sqlx on GitHub: pools, transactions and query macros",
          "url": "https://github.com/transact-rs/sqlx",
          "kind": "repo"
        }
      ],
      "quickbytes": [
        "SET LOCAL is transaction-scoped; a session-level SET leaks the tenant to the next request on that connection.",
        "Table owners bypass RLS unless FORCE ROW LEVEL SECURITY is set; superusers and BYPASSRLS roles always bypass.",
        "An unset app.tenant_id yields NULL, so the policy matches nothing: fail closed by default."
      ],
      "questions": [
        {
          "q": "A handler sets app.tenant_id with SET on a pooled connection, returns early on a validation error before setting it again, and a later request reads the previous tenant's rows. What is the fix?",
          "options": [
            "Increase the pool size so connections are less likely to be reused",
            "Use SET LOCAL or set_config(..., true) inside the request's transaction so it reverts at commit",
            "Add WITH CHECK to the SELECT policy",
            "Grant BYPASSRLS to the application role so the policy is consistent"
          ],
          "answer": 1,
          "explain": "Session state survives the request on a pooled connection. Transaction-local settings are cleared at commit or rollback, so the next borrower starts clean."
        },
        {
          "q": "Policies are defined and ENABLE ROW LEVEL SECURITY is set, but the application still sees every tenant's rows. What is the most likely cause?",
          "options": [
            "The policies were created without a TO clause",
            "The application connects as the table owner (or a superuser), which bypasses RLS unless FORCE is set",
            "The index on tenant_id is missing",
            "The policies are permissive and therefore ignored"
          ],
          "answer": 1,
          "explain": "Owners bypass policies by default, and superusers and BYPASSRLS roles always do. FORCE ROW LEVEL SECURITY plus a non-owner application role closes both paths."
        },
        {
          "q": "A query runs with no app.tenant_id set at all. What does the policy return?",
          "options": [
            "Every row, because the predicate is NULL and NULL is not false",
            "No rows, because the comparison evaluates to NULL and rows are not visible",
            "An error, because current_setting with missing_ok = true raises",
            "The rows of the tenant with the lowest id"
          ],
          "answer": 1,
          "explain": "The predicate is NULL, which does not pass the policy check, so no rows are visible. That is the intended fail-closed behaviour and the reason not to COALESCE a default."
        }
      ]
    },
    {
      "id": "d16",
      "n": 16,
      "title": "Backup and restore drills you can prove",
      "minutes": 95,
      "level": "industry",
      "goal": "Run backups that can actually restore, measure the restore, and detect the silent archive failures before an incident does.",
      "sections": [
        {
          "h": "Two kinds of backup, two different promises",
          "p": [
            "pg_dump produces a logical snapshot: portable across versions, selectable per table, and useless for point-in-time recovery because it contains no WAL. A base backup plus archived WAL reproduces the whole cluster at any instant, including the mistake you want to undo. Most teams need both: physical for disaster recovery, logical for a single-table rescue or a version upgrade rehearsal.",
            "Neither is a backup until it has been restored. The usual failure is not a corrupt file but a chain that looks complete: a base backup from Tuesday, WAL starting Wednesday, and a gap nobody noticed until the restore stopped forty minutes in."
          ],
          "code": "# pgbackrest.conf - one stanza per cluster, repository off the database host.\n[global]\nrepo1-path=/var/lib/pgbackrest\nrepo1-retention-full=4\nrepo1-cipher-type=aes-256-cbc\nstart-fast=y\narchive-async=y\n\n[prod]\npg1-path=/var/lib/postgresql/18/main\n\n# --- commands ---\npgbackrest --stanza=prod --type=full backup          # weekly full\npgbackrest --stanza=prod --type=diff backup          # nightly differential\npg_dump -Fc -d app -t public.orders -f orders.dump   # one table, for a rescue\n"
        },
        {
          "h": "WAL archiving fails silently",
          "p": [
            "archive_command runs for every completed segment, and it must exit non-zero on failure so Postgres retries. A command that swallows errors, such as a cp into a full disk or a script that exits 0 after a failed upload, tells Postgres the segment is safe and it is recycled. That is silent, unbounded data loss.",
            "Watch the archiver itself: failed_count, last_failed_wal, and the age of last_archived_time. If archiving stalls, pg_wal grows until the filesystem fills and Postgres panics; that is a crash loop, not a warning. archive_timeout forces a segment switch so a quiet cluster does not hold hours of WAL unarchived."
          ],
          "code": "-- The archiver's own view: failures and staleness, not just \"is it on\".\nSELECT archived_count,\n       failed_count,\n       last_archived_wal,\n       now() - last_archived_time AS since_last_archive,\n       last_failed_wal,\n       last_failed_time\nFROM pg_stat_archiver;\n\n-- How much WAL is waiting to be archived.\nSELECT count(*) AS segments, pg_size_pretty(sum(size)) AS pending\nFROM pg_ls_archive_statusdir()\nWHERE name LIKE '%.ready';\n\nSHOW archive_mode;\nSHOW archive_command;\nSHOW archive_timeout;\n",
          "tip": "Test archive_command by making it fail on purpose, once, and confirming failed_count moves and pg_wal grows. An archiver you have never seen fail is an archiver you do not understand."
        },
        {
          "h": "A drill is a timed restore into an isolated place",
          "p": [
            "Write the drill before the incident: restore the newest base backup into a scratch host, replay WAL to a chosen recovery_target_time, start the server, and run verification queries. Time the whole thing, because the number the business cares about is recovery time, not backup duration.",
            "Isolate the restore. It contains every credential hash, every role and every row the production cluster had at that moment, so it must not be reachable from the application's network or DSN. Restore to a new timeline, promote only when the checks pass, and rotate anything the restored cluster could expose."
          ],
          "code": "# Restore the newest backup and replay WAL up to a chosen instant.\npgbackrest --stanza=prod --type=time \\\n  --target=\"2026-04-12 09:41:00+00\" \\\n  --target-action=promote \\\n  restore\n\n# Stop the restored cluster before anyone reaches it, if the target was wrong.\npg_ctl -D /var/lib/postgresql/18/main stop -m fast\n\n# Verify on the restored cluster before it joins a network.\npsql -c \"SELECT pg_is_in_recovery(), pg_last_wal_replay_lsn();\"\npsql -c \"SELECT count(*), max(created_at) FROM orders;\"\npsql -c \"SELECT count(*) FROM accounts WHERE email IS NULL;\"\n"
        },
        {
          "h": "Verify the artifacts, not the job status",
          "p": [
            "A green backup job means the copy finished, not that the copy is usable. pg_verifybackup checks a base backup against its manifest and exits non-zero on mismatch; pgbackrest check validates the archive chain and repository configuration. Run both on a schedule and alert on exit codes, not on the presence of files.",
            "Keep the drill honest by asserting data: a known row count and a known maximum timestamp from a canary table, failing if either is missing. A restore that starts but silently loses the last hour of WAL is worse than a failed restore, because it looks like success."
          ],
          "code": "pg_verifybackup /var/backups/base/20260412\n\npgbackrest --stanza=prod check\npgbackrest --stanza=prod info --output=json\n\n# The drill asserts data, not just process exit codes.\npsql -tAc \"SELECT count(*) FROM drill_canary\"        # expect a fixed number\npsql -tAc \"SELECT max(updated_at) FROM drill_canary\" # expect within the RPO\npg_controldata | grep -E 'Database cluster state|Latest checkpoint'\n\n# A restore that finished but replayed nothing looks like this:\npsql -tAc \"SELECT pg_last_wal_replay_lsn(), pg_last_xact_replay_timestamp()\"\n",
          "tip": "Record the drill duration for every run, not just pass or fail. A restore that takes 40 minutes when the RTO is 30 passes silently until the day you need it."
        }
      ],
      "exercise": {
        "prompt": "Implement verify_restore(pool, expected_rows, rpo) that accepts a restored cluster only when it is out of recovery, the canary table has exactly expected_rows rows, and its newest updated_at is within rpo of now. Return a struct with the evidence, not just a bool.",
        "starter": "use sqlx::PgPool;\nuse std::time::Duration;\n\npub struct DrillReport {\n    pub in_recovery: bool,\n    pub canary_rows: i64,\n    pub canary_age_secs: f64,\n}\n\npub async fn verify_restore(\n    pool: &PgPool,\n    expected_rows: i64,\n    rpo: Duration,\n) -> sqlx::Result<DrillReport> {\n    // three checks: recovery state, row count, staleness\n    todo!()\n}\n",
        "hint": "SELECT pg_is_in_recovery() returns bool. For the age, extract(epoch FROM now() - max(updated_at))::float8 returns a value sqlx can decode as f64.",
        "solution": "use sqlx::PgPool;\nuse std::time::Duration;\n\n#[derive(Debug)]\npub struct DrillReport {\n    pub in_recovery: bool,\n    pub canary_rows: i64,\n    pub canary_age_secs: f64,\n}\n\nimpl DrillReport {\n    pub fn passes(&self, expected_rows: i64, rpo: Duration) -> bool {\n        !self.in_recovery\n            && self.canary_rows == expected_rows\n            && self.canary_age_secs <= rpo.as_secs_f64()\n    }\n}\n\npub async fn verify_restore(\n    pool: &PgPool,\n    expected_rows: i64,\n    rpo: Duration,\n) -> sqlx::Result<DrillReport> {\n    let in_recovery: bool = sqlx::query_scalar(\"SELECT pg_is_in_recovery()\")\n        .fetch_one(pool)\n        .await?;\n\n    let (canary_rows, canary_age_secs): (i64, f64) = sqlx::query_as(\n        r#\"SELECT count(*),\n                  extract(epoch FROM now() - max(updated_at))::float8\n           FROM drill_canary\"#,\n    )\n    .fetch_one(pool)\n    .await?;\n\n    let report = DrillReport { in_recovery, canary_rows, canary_age_secs };\n\n    if report.passes(expected_rows, rpo) {\n        Ok(report)\n    } else {\n        // Return the evidence with the failure: a bare bool cannot be debugged.\n        Err(sqlx::Error::Protocol(format!(\"restore check failed: {report:?}\")))\n    }\n}\n\n// An empty canary table makes max(updated_at) NULL, so the age decode fails\n// before the comparison does. That is also a failed drill, not a passing one.\n"
      },
      "production": [
        "Take base backups plus continuous WAL archiving for disaster recovery, and keep pg_dump for single-table rescues and upgrade rehearsals",
        "Make archive_command exit non-zero on every failure, and alert on pg_stat_archiver.failed_count and the age of last_archived_time",
        "Drill a timed restore into an isolated network weekly, and record the duration against the RTO rather than a pass/fail",
        "Run pg_verifybackup and pgbackrest check on a schedule, and alert on their exit codes",
        "Assert a canary row count and freshness after every restore, and rotate every credential the restored cluster contains"
      ],
      "crates": [
        "sqlx",
        "tokio",
        "chrono"
      ],
      "github": [
        {
          "name": "pgbackrest",
          "url": "https://github.com/pgbackrest/pgbackrest"
        },
        {
          "name": "wal-g",
          "url": "https://github.com/wal-g/wal-g"
        }
      ],
      "pitfall": "An archive_command that exits 0 after a failed upload tells Postgres the segment is archived, so it is recycled; the backup set then has a hole that nobody notices until a restore stops at that LSN.",
      "resources": [
        {
          "title": "PostgreSQL: continuous archiving, PITR, recovery targets and timelines",
          "url": "https://www.postgresql.org/docs/current/continuous-archiving.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: pg_basebackup options and verification",
          "url": "https://www.postgresql.org/docs/current/app-pgbasebackup.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: pg_verifybackup against a backup manifest",
          "url": "https://www.postgresql.org/docs/current/app-pgverifybackup.html",
          "kind": "docs"
        },
        {
          "title": "pgBackRest: backup, restore and archive verification",
          "url": "https://github.com/pgbackrest/pgbackrest",
          "kind": "repo"
        },
        {
          "title": "WAL-G: archival and restoration for PostgreSQL",
          "url": "https://github.com/wal-g/wal-g",
          "kind": "repo"
        }
      ],
      "quickbytes": [
        "pg_dump cannot do point-in-time recovery: it has no WAL, only a consistent snapshot.",
        "archive_command must fail loudly; a silent success recycles WAL you will need.",
        "A drill that only checks exit codes proves nothing: assert a canary row count and timestamp."
      ],
      "questions": [
        {
          "q": "An operator drops a table at 09:15 and you need the database as of 09:14. Which backup can do it?",
          "options": [
            "The nightly pg_dump, restored and filtered to 09:14",
            "A base backup plus archived WAL, replayed to recovery_target_time = 09:14",
            "The streaming replica, which is 200 ms behind",
            "A filesystem snapshot from the previous night"
          ],
          "answer": 1,
          "explain": "Only physical backup plus WAL supports replay to an arbitrary instant. A dump is a single logical snapshot with no notion of time between dumps, and a replica has already replayed the drop."
        },
        {
          "q": "pg_stat_archiver shows failed_count = 0 but last_archived_time is six hours old on a cluster writing 20 GB of WAL a day. What is the risk?",
          "options": [
            "None, because no failures were recorded",
            "WAL is not reaching the archive: pg_wal grows until the disk fills, and the restore chain has a gap",
            "The standby will promote itself when the archive is stale",
            "Postgres will switch to logical replication automatically"
          ],
          "answer": 1,
          "explain": "Zero failures can mean the archiver never ran, or archive_timeout is too long, or segments are not completing. The pending .ready files and the growth of pg_wal are the real signal."
        },
        {
          "q": "You restore production into a scratch host for a drill and hand it to the QA team. What must happen first?",
          "options": [
            "Nothing, as long as the host is on a private subnet",
            "Isolate it from application credentials, and rotate every secret the restored cluster contains",
            "Run VACUUM FULL to remove dead tuples from the copied data",
            "Promote it and point the staging DSN at it"
          ],
          "answer": 1,
          "explain": "The restore contains production password hashes, API keys in tables, and every role. It is a copy of production, not a sanitized dataset, so network isolation and credential rotation come before anyone connects."
        }
      ]
    },
    {
      "id": "d17",
      "n": 17,
      "title": "Data lifecycle: retention, erasure and proof",
      "minutes": 85,
      "level": "industry",
      "goal": "Delete a subject's data from every store that holds it, keep the deletion auditable, and retire data without a billion-row DELETE.",
      "sections": [
        {
          "h": "Enumerate the copies first",
          "p": [
            "A deletion request is not one DELETE. The subject's data exists in the primary tables, in audit rows, in the outbox and event log, in Redis, in the search index, in object storage, in the warehouse, and in every backup taken since the account was created. The database is the easy part; the copies you forgot are the compliance failure.",
            "Model erasure as a workflow with a row per subject and per system: requested, in progress, done, or blocked by a legal hold. Fan out to consumers through the outbox you already have, make each consumer idempotent, and retry until every system acknowledges. That record is also your evidence."
          ],
          "code": "CREATE TABLE erasure_requests (\n    id           uuid PRIMARY KEY,\n    subject_hash bytea NOT NULL,          -- salted hash; never the raw email\n    requested_at timestamptz NOT NULL DEFAULT now(),\n    completed_at timestamptz,\n    scope        text[] NOT NULL,\n    CONSTRAINT scope_known CHECK (\n        scope <@ ARRAY['profile', 'orders', 'events', 'search', 'objects']\n    )\n);\n\nCREATE TABLE erasure_tasks (\n    request_id uuid NOT NULL REFERENCES erasure_requests (id) ON DELETE CASCADE,\n    system     text NOT NULL,\n    status     text NOT NULL DEFAULT 'pending',\n    attempts   int  NOT NULL DEFAULT 0,\n    last_error text,\n    PRIMARY KEY (request_id, system)\n);\n"
        },
        {
          "h": "Delete, anonymize, or destroy the key",
          "p": [
            "Hard delete is the honest choice when there is no lawful basis to keep the data. Anonymization is the choice when aggregates or history matter: replace direct identifiers, keep the facts, and make re-identification impossible rather than merely inconvenient. Hashing an email without a secret salt is reversible with a rainbow table.",
            "Backups are the case that breaks the simple answer. You cannot run DELETE inside an immutable archive, so the standard is a bounded retention window in which the data ages out, documented and enforced. If that window is unacceptable, encrypt per subject with a key you can destroy: crypto-shredding makes the ciphertext useless without rewriting history."
          ],
          "code": "-- Anonymize in place: keep the order history, lose the person.\nUPDATE customers\nSET email     = NULL,\n    full_name = 'erased',\n    phone     = NULL,\n    erased_at = now()\nWHERE id = $1;\n\n-- Direct identifiers also live in payloads: scrub the audit copy.\nUPDATE audit_log\nSET actor = 'erased',\n    detail = detail - 'email' - 'phone'\nWHERE subject_id = $1;\n\n-- A salted hash is the identifier you keep in the ledger.\nSELECT encode(digest($1 || $2, 'sha256'), 'hex');  -- pgcrypto: id || salt\n"
        },
        {
          "h": "Batch the deletes, then vacuum",
          "p": [
            "A single DELETE of five million rows is a long transaction: it holds a snapshot that stops vacuum everywhere, writes gigabytes of WAL, and pushes replicas hours behind. Delete in batches by primary key, commit each batch, and let autovacuum catch up; for an entire tenant, drop its partition instead.",
            "Do not forget the derived stores. A cache entry with a TTL is not deleted, only hidden for a while; a search document is a copy. Delete keys explicitly, delete documents explicitly, and list those systems in the erasure tasks so the gap is visible rather than assumed."
          ],
          "code": "use sqlx::PgPool;\n\npub async fn erase_orders(pool: &PgPool, customer: uuid::Uuid, batch: i64) -> sqlx::Result<u64> {\n    let mut total = 0;\n\n    loop {\n        let n = sqlx::query(\n            r#\"DELETE FROM orders\n               WHERE id IN (\n                   SELECT id FROM orders WHERE customer_id = $1 LIMIT $2\n               )\"#,\n        )\n        .bind(customer)\n        .bind(batch)\n        .execute(pool)\n        .await?\n        .rows_affected();\n\n        total += n;\n        if n == 0 {\n            return Ok(total);\n        }\n    }\n}\n\n// Each batch commits on its own, so vacuum can advance between them and a\n// crash resumes from where it stopped instead of restarting the whole job.\n",
          "tip": "Deleting a whole tenant? Detach and drop its partition: the same result in milliseconds, no dead tuples, and no long transaction holding back vacuum."
        },
        {
          "h": "Prove it, and test the proof",
          "p": [
            "The answer to a regulator is a record: request id, scope, systems, timestamps, and any exception. Store a salted hash of the subject identifier so the ledger is not itself a copy of the data you promised to erase, and keep the salt in a secret manager with a documented rotation.",
            "Then test it end to end: create a subject, populate every store, erase, and assert that every read path returns nothing, including the cached one and the search one. A test that checks only the primary table proves the easy half and gives false confidence about the half that matters."
          ],
          "list": [
            "The erasure test populates cache and search, not just Postgres",
            "The ledger stores a salted hash, never the raw identifier",
            "The backup retention window is documented and enforced by policy",
            "Legal holds are an explicit status, not a silent skip"
          ],
          "tip": "Hash with a per-tenant salt. A single global salt turns the ledger into a join key that re-identifies subjects across requests."
        }
      ],
      "exercise": {
        "prompt": "Implement erase_subject(pool, subject, salt) that deletes orders and profile rows in batches, writes an erasure_requests row keyed by a salted hash, and returns per-table counts. It must be safe to run twice.",
        "starter": "use sqlx::PgPool;\nuse uuid::Uuid;\n\npub struct EraseReport {\n    pub request_id: Uuid,\n    pub orders: u64,\n    pub profiles: u64,\n}\n\npub async fn erase_subject(\n    pool: &PgPool,\n    subject: Uuid,\n    salt: &str,\n) -> sqlx::Result<EraseReport> {\n    // 1. upsert the request row (ON CONFLICT DO NOTHING)\n    // 2. delete from orders and profiles in batches\n    todo!()\n}\n",
        "hint": "Use encode(digest($1 || $2, 'sha256'), 'hex') for the hash and ON CONFLICT (id) DO NOTHING so a retry reuses the same request row. Loop the deletes until rows_affected is zero.",
        "solution": "use sqlx::PgPool;\nuse uuid::Uuid;\n\npub struct EraseReport {\n    pub request_id: Uuid,\n    pub orders: u64,\n    pub profiles: u64,\n}\n\npub async fn erase_subject(\n    pool: &PgPool,\n    subject: Uuid,\n    salt: &str,\n) -> sqlx::Result<EraseReport> {\n    let request_id = Uuid::now_v7();\n\n    sqlx::query(\n        r#\"INSERT INTO erasure_requests (id, subject_hash, scope)\n           VALUES ($1, digest($2 || $3, 'sha256'), ARRAY['profile', 'orders'])\n           ON CONFLICT (id) DO NOTHING\"#,\n    )\n    .bind(request_id)\n    .bind(subject.to_string())\n    .bind(salt)\n    .execute(pool)\n    .await?;\n\n    let orders = erase_batched(pool, \"orders\", subject, 5_000).await?;\n    let profiles = erase_batched(pool, \"profiles\", subject, 5_000).await?;\n\n    sqlx::query(\"UPDATE erasure_requests SET completed_at = now() WHERE id = $1\")\n        .bind(request_id)\n        .execute(pool)\n        .await?;\n\n    Ok(EraseReport { request_id, orders, profiles })\n}\n\nasync fn erase_batched(\n    pool: &PgPool,\n    table: &str,\n    subject: Uuid,\n    batch: i64,\n) -> sqlx::Result<u64> {\n    // table is a compile-time constant at every call site; never user input.\n    let sql = format!(\n        \"DELETE FROM {table} WHERE id IN (\n             SELECT id FROM {table} WHERE subject_id = $1 LIMIT $2\n         )\"\n    );\n\n    let mut total = 0;\n    loop {\n        let n = sqlx::query(&sql)\n            .bind(subject)\n            .bind(batch)\n            .execute(pool)\n            .await?\n            .rows_affected();\n\n        total += n;\n        if n == 0 {\n            return Ok(total);\n        }\n    }\n}\n\n// Re-running is safe: every DELETE is keyed by subject_id and the ledger insert\n// is idempotent on the request id. Each batch commits on its own so vacuum can\n// advance, and digest() comes from the pgcrypto extension.\n"
      },
      "production": [
        "Keep an explicit inventory of every store holding personal data, and drive erasure from a task row per system rather than a checklist",
        "Batch deletes by primary key, commit each batch, and drop partitions for whole-tenant erasure instead of deleting rows",
        "Store a salted hash of the subject in the erasure ledger; never store the raw identifier in the audit trail",
        "Document and enforce a backup retention window, and use per-subject keys when the window is shorter than the obligation",
        "Test erasure end to end against every read path, including cache and search, and treat a legal hold as a status rather than a skip"
      ],
      "crates": [
        "sqlx",
        "uuid",
        "serde_json"
      ],
      "github": [
        {
          "name": "pg_partman",
          "url": "https://github.com/pgpartman/pg_partman"
        },
        {
          "name": "pgaudit",
          "url": "https://github.com/pgaudit/pgaudit"
        }
      ],
      "pitfall": "An erasure job that deletes the row but leaves the cache entry and the search document has not erased anything: both are copies, both are readable, and neither appears in the row count you report as evidence.",
      "resources": [
        {
          "title": "PostgreSQL: routine vacuuming, dead tuples and bloat",
          "url": "https://www.postgresql.org/docs/current/routine-vacuuming.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: table partitioning, DETACH and DROP for bulk retention",
          "url": "https://www.postgresql.org/docs/current/ddl-partitioning.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: pgcrypto digest and encryption functions",
          "url": "https://www.postgresql.org/docs/current/pgcrypto.html",
          "kind": "docs"
        },
        {
          "title": "pg_partman: automated partition retention for time-series tables",
          "url": "https://github.com/pgpartman/pg_partman",
          "kind": "repo"
        }
      ],
      "quickbytes": [
        "Erasure is a per-system workflow, not a DELETE: cache, search, object storage and backups are copies too.",
        "Store a salted hash in the ledger; the ledger must not become another copy of the data you erased.",
        "Batch deletes by primary key; a five-million-row DELETE holds a snapshot that stops vacuum everywhere."
      ],
      "questions": [
        {
          "q": "A customer exercises erasure and the primary tables are cleaned within an hour. What is the correct statement about backups?",
          "options": [
            "Backups must be edited in place to remove the rows before the next restore",
            "Immutable backups age out on a documented retention window, which bounds how long the data can reappear",
            "Backups are exempt from erasure in every jurisdiction",
            "Restoring a backup re-creates the obligation only if the customer asks again"
          ],
          "answer": 1,
          "explain": "You cannot delete from an immutable archive, so the obligation is met with a bounded retention window plus a documented process, or with per-subject encryption keys you can destroy."
        },
        {
          "q": "Why is hashing an email with SHA-256 and no salt a poor anonymization?",
          "options": [
            "SHA-256 is not collision resistant",
            "The space of email addresses is small enough to enumerate, so the hash is reversible by brute force",
            "Postgres cannot index a hash",
            "Hashes are stored in plaintext by pgcrypto"
          ],
          "answer": 1,
          "explain": "Unsalted hashes of low-entropy identifiers are reversible by enumeration. A secret salt, or a keyed hash, removes that attack and keeps the value usable for matching."
        },
        {
          "q": "A nightly job DELETEs 3 million rows in one transaction. What breaks first?",
          "options": [
            "The replicas, because WAL volume and the long snapshot delay cleanup on the primary",
            "The unique indexes, which are rebuilt after each DELETE",
            "The GIN indexes, which lose entries permanently",
            "The query planner, which refuses to plan against a table with dead tuples"
          ],
          "answer": 0,
          "explain": "One transaction produces a huge WAL burst and holds a snapshot that prevents vacuum from advancing anywhere. Batching keeps WAL bounded and lets cleanup keep up."
        }
      ]
    },
    {
      "id": "d18",
      "n": 18,
      "title": "Zero-downtime schema evolution: expand and contract",
      "minutes": 100,
      "level": "industry",
      "goal": "Change column shapes while two application versions serve traffic, and keep every intermediate schema state readable by the release you might roll back to.",
      "sections": [
        {
          "h": "Two binaries, one schema",
          "p": [
            "A rolling deploy means version N and N+1 both serve traffic against the same database. Any migration that only works with the new code is an outage with extra steps. The constraint is compatibility, not speed: every schema state must be readable and writable by the previous release.",
            "That rule produces the whole method. Add before you remove, write both before you read either, and drop only after the old code is gone from every environment, including the rollback target. Renames are the canonical trap: ALTER TABLE ... RENAME COLUMN takes milliseconds and breaks every pod still running the old binary."
          ],
          "code": "-- The trap, and why it is never a one-step migration.\nALTER TABLE users RENAME COLUMN name TO display_name;  -- instant, and instantly fatal\n\n-- What the old binary sends after that statement:\nINSERT INTO users (name) VALUES ($1);\n-- ERROR: column \"name\" of relation \"users\" does not exist\n\n-- What the new binary sends before every replica has the change:\nINSERT INTO users (display_name) VALUES ($1);\n-- ERROR: column \"display_name\" of relation \"users\" does not exist\n"
        },
        {
          "h": "Replacing a column in five steps",
          "p": [
            "Step one adds the new column, nullable, with no default that would rewrite the table. Step two makes the application write both columns in one transaction, so no new row is missing either value. Step three backfills history in batches. Step four switches reads to the new column behind a flag. Step five stops writing the old one, and a later release drops it.",
            "Each step is independently deployable and reversible, which is the point: at any moment you can stop and roll back to the previous release without losing data. The backfill is the long pole, so it runs as a job with progress rather than inside a migration."
          ],
          "code": "-- release N: expand, nothing reads the new column yet\nALTER TABLE users ADD COLUMN display_name text;\n\n-- release N+1: dual write, in one statement so neither column can be stale\nUPDATE users SET name = $1, display_name = $1 WHERE id = $2;\n\n-- backfill job: resumable, idempotent, batched\nUPDATE users\nSET display_name = name\nWHERE id IN (\n    SELECT id FROM users WHERE display_name IS NULL ORDER BY id LIMIT 5000\n);\n\n-- release N+2: reads move to display_name behind a flag; writes still go to both\n\n-- release N+3: stop writing name, then drop it after the rollback window\nALTER TABLE users DROP COLUMN name;\n",
          "tip": "Never deploy the drop in the same release that stops using the column. The previous release is your rollback target, and it reads that column."
        },
        {
          "h": "Constraints and types without the long lock",
          "p": [
            "A validated constraint needs a full scan, and ADD CONSTRAINT ... CHECK takes ACCESS EXCLUSIVE while it performs it. Split the work: add the constraint NOT VALID, which is a brief lock and no scan, then VALIDATE CONSTRAINT, which takes SHARE UPDATE EXCLUSIVE and lets reads and writes continue. After a validated CHECK, SET NOT NULL can skip its own scan.",
            "Type changes are the expensive case: ALTER COLUMN TYPE rewrites the table under ACCESS EXCLUSIVE. The zero-downtime version is the five-step replacement with a new column and an explicit cast during dual write. Enums have their own rule: since PG 12 you can ADD VALUE inside a transaction, but you cannot use the new value until that transaction commits."
          ],
          "code": "-- Brief ACCESS EXCLUSIVE, no scan.\nALTER TABLE orders\n    ADD CONSTRAINT orders_total_positive CHECK (total_cents > 0) NOT VALID;\n\n-- SHARE UPDATE EXCLUSIVE: reads and writes continue while it scans.\nALTER TABLE orders VALIDATE CONSTRAINT orders_total_positive;\n\n-- With a validated CHECK, SET NOT NULL no longer scans the table (PG 12+).\nALTER TABLE orders ALTER COLUMN total_cents SET NOT NULL;\n\n-- Enum: add in one transaction, use it in the next.\nALTER TYPE order_status ADD VALUE IF NOT EXISTS 'refunded';\n",
          "tip": "Adding a foreign key? Index the referencing column first, or every parent DELETE and UPDATE scans the child table; then add it NOT VALID and validate separately."
        },
        {
          "h": "Contract is a separate release",
          "p": [
            "The instinct is to drop the old column in the same release that stops using it. Do not: the previous release is still your rollback target and it reads that column. Wait at least one full deploy cycle plus the rollback window, confirm no query in pg_stat_statements touches it, then drop.",
            "Dropping is irreversible, so treat it as a data migration. If the values are expensive to reconstruct, archive them first with CREATE TABLE ... AS SELECT, or keep them in a shadow table for a quarter. A dropped column is also a dropped explanation: the next person cannot see why it existed."
          ],
          "list": [
            "Additive first, destructive last, always in separate releases",
            "Dual-write inside one statement or one transaction, never in two",
            "Switch reads behind a flag so a rollback is a flag flip",
            "Drop only after the rollback target no longer reads the column"
          ],
          "tip": "Search pg_stat_statements for the old column name before dropping it. An analytics job you forgot about is the most common reason a 'dead' column is still being read."
        }
      ],
      "exercise": {
        "prompt": "Write the migration sequence that renames orders.customer_ref to customer_id without downtime, including the dual-write statement, and state which release ships each step. Then add the NOT VALID plus VALIDATE pair that makes customer_id NOT NULL safely.",
        "starter": "-- release ?: expand\nALTER TABLE orders ADD COLUMN customer_id uuid;\n\n-- release ?: dual write\n-- TODO\n\n-- release ?: backfill (a job, batched)\n-- TODO\n\n-- release ?: contract\nALTER TABLE orders DROP COLUMN customer_ref;\n\n-- constraint without a long lock\n-- TODO\n",
        "hint": "Expand ships before any code reads customer_id; dual write ships next; backfill runs as a job; reads switch behind a flag; the drop ships at least one release after the last writer of customer_ref is gone. NOT VALID first, then VALIDATE, then SET NOT NULL.",
        "solution": "-- release N (expand): no code reads or writes it yet\nALTER TABLE orders ADD COLUMN customer_id uuid;\n\n-- release N+1 (dual write): one statement, so the two columns cannot diverge\nUPDATE orders SET customer_ref = $1, customer_id = $1 WHERE id = $2;\n\n-- job (backfill): resumable and idempotent\nUPDATE orders\nSET customer_id = customer_ref\nWHERE id IN (\n    SELECT id FROM orders WHERE customer_id IS NULL ORDER BY id LIMIT 5000\n);\n\n-- release N+2: reads move to customer_id behind a flag; writes still dual\n\n-- release N+3 (contract): only after the rollback target stopped writing it\nALTER TABLE orders DROP COLUMN customer_ref;\n\n-- NOT NULL without a long ACCESS EXCLUSIVE scan\nALTER TABLE orders\n    ADD CONSTRAINT orders_customer_id_present CHECK (customer_id IS NOT NULL) NOT VALID;\nALTER TABLE orders VALIDATE CONSTRAINT orders_customer_id_present;\nALTER TABLE orders ALTER COLUMN customer_id SET NOT NULL;\n\n-- Note: RENAME COLUMN would have been one line and would have broken every\n-- instance of the previous release still serving traffic.\n"
      },
      "production": [
        "Ship every schema change so the previous release can still read and write it; treat the rollback target as a supported client",
        "Replace columns in five steps (add, dual write, backfill, switch reads, drop) and never rename in place under live traffic",
        "Use NOT VALID plus VALIDATE CONSTRAINT for checks and foreign keys, and index the referencing column before adding the FK",
        "Gate the drop behind a full deploy cycle plus the rollback window, after confirming nothing reads the column",
        "Add enum values in one transaction and use them only after it commits; prefer a lookup table when values churn"
      ],
      "crates": [
        "sqlx",
        "tokio",
        "uuid"
      ],
      "github": [
        {
          "name": "sqlx",
          "url": "https://github.com/transact-rs/sqlx"
        },
        {
          "name": "refinery",
          "url": "https://github.com/rust-db/refinery"
        }
      ],
      "pitfall": "ALTER TABLE ... RENAME COLUMN succeeds instantly and breaks every instance of the previous release still running, because the old binary's INSERT and SELECT still use the old name; the error appears only on the pods that have not rolled yet.",
      "resources": [
        {
          "title": "PostgreSQL: ALTER TABLE forms, rewrites and lock levels",
          "url": "https://www.postgresql.org/docs/current/sql-altertable.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: constraints, NOT VALID and VALIDATE CONSTRAINT",
          "url": "https://www.postgresql.org/docs/current/ddl-constraints.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: ALTER TYPE, enum values and transaction restrictions",
          "url": "https://www.postgresql.org/docs/current/sql-altertype.html",
          "kind": "docs"
        },
        {
          "title": "sqlx migrations: versioned files and checksums",
          "url": "https://docs.rs/sqlx/0.8.6/sqlx/migrate/struct.Migrator.html",
          "kind": "docs"
        },
        {
          "title": "refinery: versioned SQL migrations with explicit up steps",
          "url": "https://github.com/rust-db/refinery",
          "kind": "repo"
        }
      ],
      "quickbytes": [
        "Two releases run at once, so every schema state must satisfy the previous binary too.",
        "RENAME COLUMN is instant and breaks old pods; replace it with add, dual write, backfill, switch, drop.",
        "NOT VALID plus VALIDATE takes SHARE UPDATE EXCLUSIVE, so writes continue during the scan."
      ],
      "questions": [
        {
          "q": "During a rolling deploy, one pod runs the old binary and one runs the new. You renamed users.name to display_name. What happens?",
          "options": [
            "Both pods work, because Postgres keeps a synonym for the old name",
            "The old pod fails with 'column name does not exist' until it is replaced or rolled back",
            "The rename blocks until all pods disconnect",
            "The new pod fails, because the migration has not been applied to its connection"
          ],
          "answer": 1,
          "explain": "A rename is a metadata change with no compatibility layer. Old queries reference a column that no longer exists, which is why renames are done as add, dual write, backfill, switch, drop."
        },
        {
          "q": "Which pair of statements adds a CHECK constraint to a large live table with the least blocking?",
          "options": [
            "ADD CONSTRAINT ... CHECK (expr) with no options",
            "ADD CONSTRAINT ... CHECK (expr) NOT VALID, then VALIDATE CONSTRAINT",
            "ADD CONSTRAINT ... CHECK (expr) DEFERRABLE, then COMMIT",
            "CREATE INDEX on the expression, then ADD CONSTRAINT"
          ],
          "answer": 1,
          "explain": "NOT VALID takes ACCESS EXCLUSIVE only briefly and skips the scan; VALIDATE takes SHARE UPDATE EXCLUSIVE, which does not block reads or writes, and checks rows as it goes."
        },
        {
          "q": "You run ALTER TYPE order_status ADD VALUE 'refunded' and then insert a row with that value in the same transaction. What happens?",
          "options": [
            "It works, because ADD VALUE is transactional",
            "It fails: a new enum value cannot be used until the transaction that added it commits",
            "It works only if the enum has fewer than 10 values",
            "It fails because ADD VALUE is never allowed inside a transaction"
          ],
          "answer": 1,
          "explain": "Since PG 12 the value can be added inside a transaction, but it is not usable until commit. Split it into two transactions, or use a lookup table for values that change often."
        }
      ]
    },
    {
      "id": "d19",
      "n": 19,
      "title": "Query plan regression tests that catch the 100x",
      "minutes": 85,
      "level": "industry",
      "goal": "Turn plan shape and estimate accuracy into tests that fail in CI, and detect the plan flips that only appear once data grows.",
      "sections": [
        {
          "h": "Assert shape, never cost",
          "p": [
            "Costs are estimates produced from statistics, and they change with a Postgres minor version, a different default_statistics_target, and the order rows happened to be inserted. A test that asserts total cost fails on Tuesdays for reasons nobody can reproduce. Assert what determines performance: node types on the critical path, the index chosen, the join algorithm, and the estimate-to-actual ratio.",
            "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) gives structured output you can normalize and diff. Strip the timings and the costs, keep the node types, relation names, index names and row counts, and you have a snapshot that means something in review. A plan shape diff is a design change, and it should be read like one."
          ],
          "code": "-- Wrap EXPLAIN so a test can call it with a parameter.\nCREATE OR REPLACE FUNCTION plan_of(query text) RETURNS json\nLANGUAGE plpgsql AS $$\nDECLARE result json;\nBEGIN\n    EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' || query INTO result;\n    RETURN result;\nEND $$;\n\n-- Test helpers only: this executes the statement it is given.\nSELECT plan_of('SELECT id FROM orders ORDER BY created_at DESC LIMIT 20');\n",
          "tip": "EXPLAIN ANALYZE runs the query. Never point plan_of at a write statement or at production; restrict it to the test database and read-only SQL."
        },
        {
          "h": "Seed data that makes the plan real",
          "p": [
            "On ten rows Postgres seq scans everything and every plan test passes. A meaningful fixture has production-shaped cardinality and skew: a million orders, one tenant with a hundred times the rows of the rest, and timestamps spread over a year. Generate it deterministically with generate_series so the numbers are reproducible.",
            "Run ANALYZE before EXPLAIN, or the planner works from default estimates and the test measures nothing. sqlx::test creates a migrated database per test but does not seed it; seed in a fixture that runs once per database, with a template database as the cheap way, and keep the generator in the repo next to the migrations."
          ],
          "code": "INSERT INTO orders (id, tenant_id, created_at, total_cents)\nSELECT gen_random_uuid(),\n       (ARRAY['11111111-1111-7111-8111-111111111111'::uuid,\n              '22222222-2222-7222-8222-222222222222'])[1 + (i % 2)],\n       now() - (i || ' minutes')::interval,\n       (i * 37) % 100000\nFROM generate_series(1, 200000) AS i;\n\n-- Skew matters more than volume: one tenant holds most of the rows.\nINSERT INTO orders (id, tenant_id, created_at, total_cents)\nSELECT gen_random_uuid(),\n       '33333333-3333-7333-8333-333333333333',\n       now() - (i || ' seconds')::interval,\n       100\nFROM generate_series(1, 400000) AS i;\n\nANALYZE orders;\n"
        },
        {
          "h": "Golden plans with a tolerance, not an equality",
          "p": [
            "Snapshot the normalized shape and diff it in review, the way you diff a public API. A changed plan is not automatically wrong, since a new index or better statistics can improve it, but it must be explained in the pull request instead of discovered in production.",
            "Add a second assertion that catches trouble earlier: per node, compare estimated rows to actual rows. A ratio above ten is the leading indicator of a plan that will flip as the data grows, even when today's plan is fine. Alert on the ratio, review the shape."
          ],
          "code": "use serde_json::Value;\n\n/// Collect node type, relation and index: the parts a plan regression changes.\npub fn plan_shape(plan: &Value) -> Vec<String> {\n    fn walk(node: &Value, out: &mut Vec<String>) {\n        let kind = node[\"Node Type\"].as_str().unwrap_or(\"?\");\n        let relation = node[\"Relation Name\"].as_str().unwrap_or(\"\");\n        let index = node[\"Index Name\"].as_str().unwrap_or(\"\");\n        out.push(format!(\"{kind}|{relation}|{index}\"));\n\n        if let Some(children) = node[\"Plans\"].as_array() {\n            for child in children {\n                walk(child, out);\n            }\n        }\n    }\n\n    let mut out = Vec::new();\n    // EXPLAIN (FORMAT JSON) returns an array whose single element holds \"Plan\".\n    if let Some(root) = plan.get(0).and_then(|entry| entry.get(\"Plan\")) {\n        walk(root, &mut out);\n    }\n    out\n}\n\n#[test]\nfn feed_query_uses_the_composite_index() {\n    let raw = std::fs::read_to_string(\"tests/plans/feed.json\").unwrap();\n    let plan: Value = serde_json::from_str(&raw).unwrap();\n    let shape = plan_shape(&plan);\n\n    assert!(shape.iter().any(|node| node.contains(\"orders_feed_idx\")));\n    assert!(!shape.iter().any(|node| node.starts_with(\"Seq Scan|orders|\")));\n}\n"
        },
        {
          "h": "Catch the regressions production actually has",
          "p": [
            "Your test suite covers the queries you thought of. auto_explain covers the rest: enable log_analyze and log_buffers above a duration threshold and sample it, so a query that flips from index scan to seq scan shows up in the logs with its plan attached.",
            "pg_stat_statements gives the trend: total_exec_time and mean_exec_time per queryid, plus rows and calls. A regression is a shift in the ratio rather than a single slow sample, so compare windows. It is cumulative since the last reset, which makes the first alert after a restart noise."
          ],
          "code": "# postgresql.conf\nshared_preload_libraries = 'pg_stat_statements, auto_explain'\npg_stat_statements.max = 10000\npg_stat_statements.track = 'top'\n\nauto_explain.log_min_duration = '500ms'\nauto_explain.log_analyze = on\nauto_explain.log_buffers = on\nauto_explain.log_nested_statements = off\nauto_explain.sample_rate = 0.1\n\n# Then compare equal windows per queryid:\n#   SELECT queryid, calls, mean_exec_time, rows FROM pg_stat_statements\n#   ORDER BY total_exec_time DESC LIMIT 20;\n",
          "tip": "Compare equal-length windows for pg_stat_statements deltas, and record the reset time. Comparing a 24-hour window with a 5-minute one invents regressions."
        }
      ],
      "exercise": {
        "prompt": "Implement estimate_gap(plan) returning (node path, estimate, actual, ratio) for every plan node whose actual rows are more than ten times the estimate. Use it to fail a CI test when a join's cardinality estimate drifts.",
        "starter": "use serde_json::Value;\n\npub struct Gap {\n    pub node: String,\n    pub estimated: f64,\n    pub actual: f64,\n    pub ratio: f64,\n}\n\npub fn estimate_gap(plan: &Value) -> Vec<Gap> {\n    // walk \"Plan\", comparing \"Plan Rows\" with \"Actual Rows\"\n    todo!()\n}\n",
        "hint": "Each node has Plan Rows and Actual Rows; with loops > 1 the actual per-loop figure is Actual Rows. Skip nodes below a floor (say 1000 estimated rows) so tiny tables do not dominate.",
        "solution": "use serde_json::Value;\n\npub struct Gap {\n    pub node: String,\n    pub estimated: f64,\n    pub actual: f64,\n    pub ratio: f64,\n}\n\npub fn estimate_gap(plan: &Value) -> Vec<Gap> {\n    fn walk(node: &Value, path: &str, out: &mut Vec<Gap>) {\n        let kind = node[\"Node Type\"].as_str().unwrap_or(\"?\");\n        let here = format!(\"{path}/{kind}\");\n\n        let estimated = node[\"Plan Rows\"].as_f64().unwrap_or(0.0);\n        let actual = node[\"Actual Rows\"].as_f64().unwrap_or(0.0);\n\n        // Ignore small nodes: a 200x miss on 5 rows changes nothing.\n        if estimated >= 1000.0 && actual > estimated * 10.0 {\n            out.push(Gap {\n                node: here.clone(),\n                estimated,\n                actual,\n                ratio: actual / estimated,\n            });\n        }\n\n        if let Some(children) = node[\"Plans\"].as_array() {\n            for child in children {\n                walk(child, &here, out);\n            }\n        }\n    }\n\n    let mut out = Vec::new();\n    if let Some(root) = plan.get(0).and_then(|entry| entry.get(\"Plan\")) {\n        walk(root, \"\", &mut out);\n    }\n    out\n}\n\n// A ratio above 10 on a node with real cardinality is the signal: the planner\n// chose a join shape or an index on a row count it does not have.\n"
      },
      "production": [
        "Assert plan shape (node types, relations, indexes) in CI and review the diff like an API change; never assert planner costs",
        "Seed fixtures with production cardinality and skew, and run ANALYZE before every EXPLAIN, or the test measures nothing",
        "Fail the build when estimated-to-actual rows drift by more than 10x on any node above a thousand rows",
        "Enable auto_explain above a duration threshold with log_analyze and log_buffers so production plans land in the logs",
        "Track pg_stat_statements over equal windows and alert on mean_exec_time shifts per queryid, not on single slow samples"
      ],
      "crates": [
        "sqlx",
        "serde_json",
        "tokio"
      ],
      "github": [
        {
          "name": "pgtap",
          "url": "https://github.com/theory/pgtap"
        },
        {
          "name": "postgres",
          "url": "https://github.com/postgres/postgres"
        }
      ],
      "pitfall": "A plan test seeded with ten rows passes forever: Postgres seq scans a ten-row table regardless of indexes, so the assertion never exercises the plan that production runs at a million rows.",
      "resources": [
        {
          "title": "PostgreSQL: using EXPLAIN, ANALYZE, BUFFERS and JSON output",
          "url": "https://www.postgresql.org/docs/current/using-explain.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: auto_explain, log_analyze and sample_rate",
          "url": "https://www.postgresql.org/docs/current/auto-explain.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: pg_stat_statements and per-queryid timing",
          "url": "https://www.postgresql.org/docs/current/pgstatstatements.html",
          "kind": "docs"
        },
        {
          "title": "pgTAP: unit tests and assertions inside PostgreSQL",
          "url": "https://github.com/theory/pgtap",
          "kind": "repo"
        },
        {
          "title": "6 Signs Postgres Tuning Won't Fix Your Performance Problems",
          "url": "https://www.youtube.com/watch?v=Fj9W0Akt93Q",
          "kind": "video"
        }
      ],
      "quickbytes": [
        "Assert node types and index names, never planner costs: costs change with statistics and versions.",
        "Seed with production cardinality and skew, then ANALYZE; small fixtures make every plan test vacuous.",
        "An estimate/actual ratio above 10 is the leading indicator of the plan that flips next month."
      ],
      "questions": [
        {
          "q": "Why does asserting EXPLAIN's total cost in CI produce flaky failures?",
          "options": [
            "Costs are estimates derived from statistics and vary with data distribution, settings and Postgres versions",
            "EXPLAIN costs are random numbers regenerated on every call",
            "Costs are only available with ANALYZE, which cannot run in CI",
            "Costs depend on the client's timezone"
          ],
          "answer": 0,
          "explain": "Cost is a planner estimate, not a measurement. Node types, chosen indexes and the estimate-to-actual gap are stable enough to assert; cost is not."
        },
        {
          "q": "A plan test seeds 20 rows, asserts an Index Scan, and passes locally but the production query seq scans. What is the flaw?",
          "options": [
            "The test database has different shared_buffers",
            "At 20 rows the planner correctly prefers a seq scan, so the fixture cannot reproduce production plans",
            "ANALYZE was run too many times",
            "The test needs FORMAT JSON instead of FORMAT TEXT"
          ],
          "answer": 1,
          "explain": "Plan choice depends on cardinality. Without production-shaped volume and skew, the test asserts a plan that will never be chosen on real data."
        },
        {
          "q": "EXPLAIN ANALYZE on a query with a DELETE in it is scheduled as a nightly production check. What is wrong?",
          "options": [
            "Nothing, as long as the transaction is rolled back",
            "ANALYZE executes the statement, so the check actually deletes rows",
            "ANALYZE refuses to plan writes, so the job always fails",
            "It takes an ACCESS EXCLUSIVE lock that blocks all writes"
          ],
          "answer": 1,
          "explain": "EXPLAIN ANALYZE runs the query to collect actual row counts. Plan tests must be restricted to read-only statements, which is why the helper should live in a test-only schema."
        }
      ]
    },
    {
      "id": "d20",
      "n": 20,
      "title": "Application-side sharding: routing and resharding",
      "minutes": 110,
      "level": "industry",
      "goal": "Split one Postgres into many by a key every query already knows, and move tenants between shards without a maintenance window.",
      "sections": [
        {
          "h": "The shard key is the architecture",
          "p": [
            "A shard key is only viable if essentially every query already constrains it. tenant_id works when the product is tenant-scoped; user_id works when nothing is shared between users. Choose it, then count the queries that cannot supply it: those become scatter-gather, and their cost grows with the number of shards.",
            "Hashing spreads load evenly and makes resharding a data-movement problem. Ranges give locality, by time or by region, and put the newest data on one shard, which is either exactly what retention wants or exactly the hotspot you did not want. Decide which, explicitly, and write it down."
          ],
          "code": "CREATE TABLE shard_map (\n    tenant_id uuid PRIMARY KEY,\n    shard_id  smallint NOT NULL,\n    version   bigint NOT NULL,\n    moved_at  timestamptz\n);\n\n-- Small, read-mostly, heavily cached: the directory is not a data store.\nSELECT shard_id, version FROM shard_map WHERE tenant_id = $1;\n\n-- Every tenant-scoped table carries the key, so a shard can be validated.\nCREATE TABLE orders (\n    id        uuid PRIMARY KEY,\n    tenant_id uuid NOT NULL,\n    total_cents bigint NOT NULL\n);\nCREATE INDEX orders_tenant_idx ON orders (tenant_id, id);\n"
        },
        {
          "h": "Routing tables are data, versioned",
          "p": [
            "The mapping belongs in a small, highly available directory database, not in a config file that needs a deploy to change. Cache it in-process with a short TTL and a version stamp, so a cutover is detected without a restart and a stale replica cannot serve an old mapping forever.",
            "Consistent hashing with virtual nodes limits how much data moves when a shard is added, but it hides which tenant lives where, which you will want at 02:00. Explicit tenant-to-shard rows plus rendezvous hashing for the default case gives even spread and a debuggable exception path for the whale tenant that needs its own shard."
          ],
          "code": "use uuid::Uuid;\n\n/// Highest-random-weight: adding a shard moves roughly 1/N of the keys.\npub fn default_shard(tenant: Uuid, shards: &[u16]) -> u16 {\n    let key = tenant.as_u128();\n\n    shards\n        .iter()\n        .copied()\n        .max_by_key(|shard| {\n            let mut x = key ^ (*shard as u128).wrapping_mul(0x9e37_79b9_7f4a_7c15);\n            x ^= x >> 33;\n            x = x.wrapping_mul(0xff51_afd7_ed55_8ccd);\n            x ^= x >> 33;\n            x\n        })\n        .expect(\"at least one shard configured\")\n}\n\n#[test]\nfn a_whale_tenant_can_be_pinned() {\n    let whale = Uuid::now_v7();\n    // The map is checked first; the hash is only the default for new tenants.\n    assert_eq!(default_shard(whale, &[1, 2, 3]), default_shard(whale, &[1, 2, 3]));\n}\n"
        },
        {
          "h": "Cross-shard work is the tax",
          "p": [
            "No cross-shard joins in the request path, and no distributed transactions unless you are prepared to run two-phase commit and its failure modes. Multi-shard effects go through per-shard idempotent writes plus an outbox or saga with an explicit compensating action: the same machinery as before, now with a network between the steps.",
            "Global identity needs a plan too. Per-shard sequences collide or require a coordinator, so use UUIDv7, which is time-ordered and index-friendly, or a snowflake-style id with the shard id in its bits. Sortable ids keep B-tree inserts local instead of scattering them across pages."
          ],
          "code": "use futures::future::join_all;\nuse sqlx::PgPool;\nuse std::time::Duration;\n\n/// Bounded fanout: one slow shard must not hold the whole response.\npub async fn counts(shards: &[PgPool]) -> Vec<Result<i64, sqlx::Error>> {\n    let futures = shards.iter().map(|pool| async move {\n        tokio::time::timeout(\n            Duration::from_millis(300),\n            sqlx::query_scalar::<_, i64>(\"SELECT count(*) FROM orders\").fetch_one(pool),\n        )\n        .await\n        .unwrap_or(Err(sqlx::Error::PoolTimedOut))\n    });\n\n    join_all(futures).await\n}\n",
          "tip": "Return partial results with an explicit incomplete flag rather than a 500. A dashboard that says '3 of 8 shards responded' is more useful than one that shows nothing."
        },
        {
          "h": "Resharding is a migration with a cutover",
          "p": [
            "Dual-write to the old and new shard, backfill by keyset, compare counts and checksums, then flip the mapping version. Keep dual-writing for a rollback window, then stop. Every step must be resumable and observable: a reshard that runs for a week is normal, a reshard you cannot pause is not.",
            "Watch the connection arithmetic. Eight shards times twenty connections times six pods is 960 backends before a single request is served, so the pool budget is divided by shard count or the shards need a proxy. Failure isolation is the other half: one shard down must degrade a slice of tenants, not the whole product."
          ],
          "list": [
            "Count the queries that cannot supply the shard key before committing to it",
            "Cache the map with a version; flip the version rather than redeploying code",
            "Dual-write, backfill, verify, flip, keep dual-write for a rollback window, then stop",
            "Divide the pool budget by shard count, and bound every fanout with a timeout"
          ],
          "tip": "Validate the shard key on write: a row whose tenant_id hashes to a different shard than the connection is corruption that only shows up at the next reshard."
        }
      ],
      "exercise": {
        "prompt": "Implement default_shard(tenant, shards) with rendezvous hashing, plus a test proving that growing from three shards to four moves roughly a quarter of a thousand tenant ids and leaves the rest in place.",
        "starter": "use uuid::Uuid;\n\npub fn default_shard(tenant: Uuid, shards: &[u16]) -> u16 {\n    // highest random weight over shards\n    todo!()\n}\n\n#[test]\nfn adding_a_shard_moves_about_a_quarter() {\n    // 1000 deterministic uuids, compare [1,2,3] with [1,2,3,4]\n}\n",
        "hint": "For each shard, mix the tenant bits with the shard id (splitmix-style), then take the shard with the maximum hash. Count how many tenants changed shard between the two configurations.",
        "solution": "use uuid::Uuid;\n\npub fn default_shard(tenant: Uuid, shards: &[u16]) -> u16 {\n    let key = tenant.as_u128();\n\n    shards\n        .iter()\n        .copied()\n        .max_by_key(|shard| {\n            let mut x = key ^ (*shard as u128).wrapping_mul(0x9e37_79b9_7f4a_7c15);\n            x ^= x >> 33;\n            x = x.wrapping_mul(0xff51_afd7_ed55_8ccd);\n            x ^= x >> 33;\n            x\n        })\n        .expect(\"at least one shard configured\")\n}\n\n#[test]\nfn adding_a_shard_moves_about_a_quarter() {\n    let tenants: Vec<Uuid> = (0..1000).map(|_| Uuid::now_v7()).collect();\n\n    let before = [1u16, 2, 3];\n    let after = [1u16, 2, 3, 4];\n\n    let moved = tenants\n        .iter()\n        .filter(|tenant| default_shard(**tenant, &before) != default_shard(**tenant, &after))\n        .count();\n\n    // Rendezvous hashing only moves the keys that now prefer the new shard.\n    assert!((150..=350).contains(&moved), \"moved {moved} of 1000\");\n}\n\n// With N shards, adding one moves about 1/(N+1) of the keys. Consistent\n// hashing gives the same property with more machinery; this has no state to\n// keep in sync and is trivial to reimplement in another language.\n"
      },
      "production": [
        "Choose a shard key that every query already constrains, and count the scatter-gather queries before committing",
        "Keep the tenant-to-shard map in a highly available directory with a version stamp, cached briefly in-process",
        "Never run cross-shard transactions in a request path; use per-shard idempotent writes plus an outbox or saga",
        "Generate ids with UUIDv7 or a shard-aware snowflake so no shard needs a coordinator for uniqueness",
        "Reshard with dual-write, keyset backfill, checksum comparison and a version flip, keeping dual-write through the rollback window"
      ],
      "crates": [
        "sqlx",
        "uuid",
        "futures",
        "tokio"
      ],
      "github": [
        {
          "name": "citus",
          "url": "https://github.com/citusdata/citus"
        },
        {
          "name": "vitess",
          "url": "https://github.com/vitessio/vitess"
        }
      ],
      "pitfall": "Per-shard sequences as primary keys collide the first time a tenant moves shard, and the collision surfaces during the reshard rather than at insert time, when the data is already split across two databases.",
      "resources": [
        {
          "title": "PostgreSQL: postgres_fdw for cross-shard reads and foreign tables",
          "url": "https://www.postgresql.org/docs/current/postgres-fdw.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: declarative partitioning as a single-node alternative to sharding",
          "url": "https://www.postgresql.org/docs/current/ddl-partitioning.html",
          "kind": "docs"
        },
        {
          "title": "citus: distributed PostgreSQL, sharding and colocation",
          "url": "https://github.com/citusdata/citus",
          "kind": "repo"
        },
        {
          "title": "vitess: sharding and routing at scale, as a design reference",
          "url": "https://github.com/vitessio/vitess",
          "kind": "repo"
        }
      ],
      "quickbytes": [
        "A query without the shard key becomes a scatter-gather; count those before you shard, not after.",
        "Use UUIDv7 or shard-aware ids: per-shard sequences collide as soon as data moves.",
        "Connections multiply by shard count: eight shards times twenty connections times six pods is 960 backends."
      ],
      "questions": [
        {
          "q": "Why do per-shard sequences fail as a primary-key strategy once you reshard?",
          "options": [
            "Sequences cannot be created on a shard that is read-only",
            "Two shards generate the same value, so moving a tenant produces duplicate keys",
            "Postgres limits a sequence to 2^31 values per shard",
            "Sequences are not WAL-logged, so they reset after a failover"
          ],
          "answer": 1,
          "explain": "Each shard starts its own counter, so shard 1 and shard 2 both emit 1, 2, 3. A globally unique, sortable id (UUIDv7 or a shard-aware snowflake) removes the coordination entirely."
        },
        {
          "q": "A dashboard query joins orders and customers without tenant_id. After sharding into eight databases, what happens?",
          "options": [
            "Postgres rewrites the query to use the shard map automatically",
            "The application must query all eight shards and merge, so cost and failure surface grow with shard count",
            "The query fails because foreign keys cannot cross databases",
            "The query reads the directory database instead"
          ],
          "answer": 1,
          "explain": "Without the shard key, routing is impossible: the request becomes a scatter-gather with bounded fanout, per-shard timeouts and partial results. That is the tax a shard key is meant to avoid."
        },
        {
          "q": "Eight shards, six pods, and a pool of twenty per process. What must change?",
          "options": [
            "Nothing: pools are per database, so the total is unchanged",
            "The pool budget is divided by shard count, or a proxy is introduced, because 960 backends exceed the servers' limits",
            "max_connections must be raised to 960 on every shard",
            "Sharding removes the need for connection pooling"
          ],
          "answer": 1,
          "explain": "Each shard holds its own connections, so pods x shards x pool multiplies. Divide the per-process budget by shard count or put a pooler in front of each shard."
        }
      ]
    }
  ]
};
