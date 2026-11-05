/**
 * Data & persistence track.
 *
 * Postgres through SQLx, Redis caching, S3-compatible object storage, and the
 * integrity patterns that keep production data correct under concurrency.
 * Versions referenced: sqlx 0.8.6, redis (redis-rs) 1.8.x, aws-sdk-s3 1.157.
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
          "url": "https://github.com/launchbadge/sqlx"
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
          "url": "https://github.com/launchbadge/sqlx",
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
          "url": "https://github.com/launchbadge/sqlx"
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
          "url": "https://github.com/launchbadge/sqlx",
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
          "url": "https://github.com/launchbadge/sqlx"
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
          "url": "https://github.com/launchbadge/sqlx"
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
          "url": "https://github.com/launchbadge/sqlx"
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
    }
  ]
};
