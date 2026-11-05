/**
 * Capstone projects track.
 *
 * Twenty project briefs, each taught through the one engineering decision that
 * decides whether the project ships. Crate versions referenced in the prose:
 * clap 4.6, axum 0.8, tonic 0.14, sqlx 0.9, kube 5.0, wasm-bindgen 0.2,
 * embassy-executor 0.10, candle 0.11, opentelemetry 0.33 / tracing-opentelemetry
 * 0.34, criterion 0.8 / divan 0.1, libfuzzer-sys 0.4, abi_stable 0.11,
 * wasmtime 50, governor 0.10, fred 10.1, object_store 0.14, parquet 60.
 *
 * Data is JSON-compatible and consumed by the plugin build.
 */
export default {
  key: 'projects',
  prefix: 'u',
  title: 'Capstone projects',
  blurb: 'Twenty end-to-end project briefs with architecture, milestones, acceptance criteria and stretch goals.',
  level: 'industry',
  project: {
    title: 'Capstone: ship one project end-to-end',
    brief: 'Pick a brief, write the design doc, build it with tests, benchmark it, deploy it and write the postmortem.',
    deliverables: [
      'Design doc and ADRs',
      'Working implementation with tests',
      'Benchmarks and load results',
      'Deployment and runbook',
    ],
    stack: ['tokio', 'axum', 'sqlx', 'tracing'],
  },
  lessons: [
    {
      id: 'u01',
      n: 1,
      title: 'CLI toolkit: exit codes, error context, and a testable contract',
      minutes: 75,
      level: 'core',
      goal: 'Treat a CLI as a machine interface: one clap definition, exit codes that scripts can branch on, and snapshot tests over stdout, stderr, and status.',
      sections: [
        {
          h: 'The contract is argv, streams, and status',
          p: [
            'A CLI is an API that other programs call without a type system. The caller sees three things: arguments in, bytes on stdout, bytes on stderr, and an integer exit status. Everything else - your module layout, your error enum, whether you used async - is private. Design those four surfaces first and the implementation becomes a detail.',
            'The brief: an inventory reconciliation tool that reads a ledger export and emits either a human report or machine JSON. The failure mode to design against is a pipeline that silently succeeds: `acme reconcile bad.csv | jq .` printing an error message to stdout means jq parses garbage and the shell sees exit 0. Errors go to stderr, data goes to stdout, and a non-zero status says the run failed.',
          ],
          list: [
            'Exit 0: the command ran and produced its output',
            'Exit 2: usage error - clap\'s own convention, do not invent another one',
            'Exit 1: the command ran and failed (IO, parse, invariant violated)',
            'Never write diagnostics to stdout when `--format json` is selected',
          ],
          tip: 'Document the exit codes in the long help text; scripts written against them outlive your README.',
        },
        {
          h: 'One clap definition, parsed once',
          p: [
            'Keep the whole surface in one `#[derive(Parser)]` struct with a `Subcommand` enum. Global flags live on the parent with `global = true`, so `acme --format json reconcile x.csv` and `acme reconcile x.csv --format json` both parse. Parse exactly once in `main`; passing `ArgMatches` down the stack is how CLIs grow two sources of truth.',
            'Use `value_parser` for anything that can fail at parse time - paths, ports, enum choices - so a bad value becomes exit 2 with a usage message instead of a runtime error halfway through a batch. The generated help and shell completions then come from the same definition, which is the only way they stay correct.',
          ],
          code: `use clap::{Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, ValueEnum)]
enum Format {
    Human,
    Json,
}

/// Reconcile a ledger export against the warehouse snapshot.
#[derive(Debug, Parser)]
#[command(name = "acme", version, about, long_about = None)]
struct Cli {
    /// Output format; json is stable and machine-readable.
    #[arg(long, global = true, value_enum, default_value_t = Format::Human)]
    format: Format,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Debug, Subcommand)]
enum Cmd {
    /// Compare a ledger CSV against the warehouse.
    Reconcile {
        #[arg(value_name = "LEDGER")]
        ledger: PathBuf,
        /// Rows per transaction.
        #[arg(long, default_value_t = 1000)]
        batch: usize,
    },
    /// Print the schema version this binary expects.
    Schema,
}`,
          tip: 'value_enum gives you a parse error at exit 2 for free; a String field forces you to validate later, where the status is already 1.',
        },
        {
          h: 'Return ExitCode, not a panic',
          p: [
            'Use `std::process::ExitCode` as the return type of `main` and map your domain error to an integer in one place. `anyhow` at the top, `thiserror` in the library, and `{err:#}` in the format string print the full context chain on one line instead of a bare `No such file or directory`.',
            'The distinction that matters: a *usage* error is the caller\'s fault and deserves exit 2 plus the usage text; a *runtime* error is the world\'s fault and deserves exit 1 plus a cause chain. Collapsing both into 1 forces every wrapper script to parse English on stderr.',
          ],
          code: `use std::process::ExitCode;

fn main() -> ExitCode {
    let cli = Cli::parse();

    match run(cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err:#}");
            ExitCode::from(exit_code(&err))
        }
    }
}

fn exit_code(err: &anyhow::Error) -> u8 {
    match err.downcast_ref::<ReconcileError>() {
        Some(ReconcileError::Usage(_)) => 2,
        Some(ReconcileError::LedgerNotFound(_)) => 3,
        _ => 1,
    }
}

fn run(cli: Cli) -> anyhow::Result<()> {
    match cli.cmd {
        Cmd::Schema => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Cmd::Reconcile { ledger, batch } => reconcile(&ledger, batch, cli.format),
    }
}`,
          tip: 'Downcast in one place and let the rest of the code return anyhow::Result; the exit-code table then lives next to main, where reviewers can see it.',
        },
        {
          h: 'Test the contract, not the internals',
          p: [
            'Unit tests cannot catch a regression in `--help` or an exit code, because they never run the binary. `assert_cmd` runs it, `predicates` asserts on stdout, stderr and `code()`, and `insta` snapshots the help text so a changed flag ordering shows up as a reviewable diff rather than a surprise for users.',
            'Cover four cases per subcommand: success, usage error, missing file, and `--format json` parsing as JSON. If the JSON output is a stable contract, snapshot it too and bump a documented `schema` field when it changes - that is the same additive-versioning discipline you would apply to an HTTP API.',
          ],
          code: `use assert_cmd::Command;
use predicates::prelude::*;

#[test]
fn missing_ledger_is_exit_3_not_a_panic() {
    Command::cargo_bin("acme")
        .unwrap()
        .args(["reconcile", "/nonexistent/ledger.csv"])
        .assert()
        .code(3)
        .stderr(predicate::str::contains("ledger not found"))
        .stdout(predicate::str::is_empty());
}

#[test]
fn unknown_flag_is_exit_2() {
    Command::cargo_bin("acme")
        .unwrap()
        .args(["reconcile", "x.csv", "--nope"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("unexpected argument"));
}

#[test]
fn json_output_is_valid_json() {
    let out = Command::cargo_bin("acme")
        .unwrap()
        .args(["--format", "json", "schema"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let _: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
}`,
          tip: 'assert_cmd resolves the test binary via CARGO_BIN_EXE_, so this only works from integration tests in tests/, not from src/.',
        },
      ],
      exercise: {
        prompt: 'Add a `--fail-fast` flag and a `check` subcommand that exits 4 when the ledger has duplicate ids. Wire the new code through the exit-code table and assert it from an integration test.',
        starter: `#[derive(Debug, Subcommand)]
enum Cmd {
    // TODO: add Check { ledger: PathBuf }
}

// TODO: add ReconcileError::Duplicates(usize) and map it to exit code 4
fn exit_code(err: &anyhow::Error) -> u8 {
    todo!()
}

// TODO: integration test asserting code(4) and the duplicate count on stderr
`,
        hint: 'A new variant in the error enum plus one arm in exit_code is enough; keep the check itself a pure function returning Result<(), ReconcileError> so a unit test can call it without spawning a process.',
        solution: `#[derive(Debug, Subcommand)]
enum Cmd {
    Reconcile { ledger: PathBuf, batch: usize },
    Check { ledger: PathBuf },
    Schema,
}

#[derive(Debug, thiserror::Error)]
enum ReconcileError {
    #[error("usage: {0}")]
    Usage(String),
    #[error("ledger not found: {0}")]
    LedgerNotFound(PathBuf),
    #[error("ledger contains {0} duplicate ids")]
    Duplicates(usize),
}

fn exit_code(err: &anyhow::Error) -> u8 {
    match err.downcast_ref::<ReconcileError>() {
        Some(ReconcileError::Usage(_)) => 2,
        Some(ReconcileError::LedgerNotFound(_)) => 3,
        Some(ReconcileError::Duplicates(_)) => 4,
        None => 1,
    }
}

fn check_duplicates(ids: &[String]) -> Result<(), ReconcileError> {
    let mut seen = std::collections::HashSet::with_capacity(ids.len());
    let dupes = ids.iter().filter(|id| !seen.insert(*id)).count();
    if dupes > 0 {
        return Err(ReconcileError::Duplicates(dupes));
    }
    Ok(())
}

// tests/cli.rs
#[test]
fn duplicates_are_exit_4() {
    assert_cmd::Command::cargo_bin("acme")
        .unwrap()
        .args(["check", "tests/fixtures/duplicates.csv"])
        .assert()
        .code(4)
        .stderr(predicates::str::contains("duplicate ids"));
}`,
      },
      questions: [
        {
          q: 'Your reconcile command fails because the ledger file is missing. Which exit status should the binary return?',
          options: [
            'Exit 0 with an error object in the JSON payload',
            'Exit 1, because the run failed at runtime',
            'Exit 2, because clap reserves 2 for usage errors',
            'Exit 101, matching a Rust panic',
          ],
          answer: 1,
          explain: 'A missing input is a runtime failure, not a malformed command line. Keeping 2 for usage errors and 1 for runtime failures lets wrappers distinguish "you called me wrong" from "the world was wrong".',
        },
        {
          q: 'Why must diagnostics go to stderr rather than stdout?',
          options: [
            'stderr is faster because it is unbuffered',
            'stdout may be piped into another program as data',
            'Rust buffers stdout but not stderr',
            'Terminals only render stderr in color',
          ],
          answer: 1,
          explain: 'stdout is the program\'s output channel and may be consumed by jq or a file. Mixing errors into it corrupts the payload; stderr stays attached to the terminal for the human.',
        },
        {
          q: 'What does an assert_cmd integration test actually exercise that a unit test cannot?',
          options: [
            'The argument parser, the real exit status, and the real stdout/stderr split',
            'Memory safety of the unsafe blocks in the crate',
            'Coverage of private helper functions',
            'Timing behaviour under a paused tokio clock',
          ],
          answer: 0,
          explain: 'It spawns the compiled binary, so it covers clap parsing, ExitCode handling, and which stream each byte went to - the parts a caller can observe.',
        },
      ],
      quickbytes: [
        'clap exits 2 on parse errors and 0 on --help; mirror that split instead of inventing a new numbering.',
        'Print data to stdout and diagnostics to stderr, or every shell pipeline will silently misbehave.',
        'Use `{err:#}` with anyhow to print the whole context chain on one line.',
        'Gate `--format json` output behind a snapshot test; it is a public contract with a version field.',
      ],
      production: [
        'Exit codes are documented in long help and asserted by integration tests per subcommand.',
        'No `unwrap()` outside tests; `expect()` is only allowed for documented programmer invariants.',
        'Shell completions and man pages are generated from the same clap definition in CI.',
        'The JSON output carries an explicit schema version and is parsed back in a test.',
        'CI runs the binary against fixtures for success, usage error, missing file, and duplicate input.',
      ],
      crates: ['clap', 'clap_complete', 'anyhow', 'thiserror'],
      github: [{ name: 'clap - command line argument parser', url: 'https://github.com/clap-rs/clap' }],
      pitfall: 'Returning anyhow::Error from main: Rust prints `Error: <display>` and exits 1 for every failure, so a usage error and a missing file become indistinguishable to the wrapper script.',
      resources: [
        { title: 'clap crate documentation (derive, value parsers, subcommands)', url: 'https://docs.rs/clap/latest/clap/', kind: 'docs' },
        { title: 'clap_complete: generate shell completions from the same definition', url: 'https://docs.rs/clap_complete/latest/clap_complete/', kind: 'docs' },
        { title: 'assert_cmd: run the built binary in integration tests', url: 'https://docs.rs/assert_cmd/latest/assert_cmd/', kind: 'docs' },
        { title: 'clap repository: examples, migration guides, issue tracker', url: 'https://github.com/clap-rs/clap', kind: 'repo' },
      ],
    },
    {
      id: 'u02',
      n: 2,
      title: 'REST API: a typed error boundary in axum 0.8',
      minutes: 90,
      level: 'advanced',
      goal: 'Model every failure as one enum that implements IntoResponse, so status codes, bodies, and logs are decided in a single place instead of leaking out of handlers.',
      sections: [
        {
          h: 'Route shape and the 0.8 path syntax',
          p: [
            'axum 0.8 changed path captures from `:id` to `{id}`. A route written with the old syntax does not error at startup - it is parsed as a literal segment, so `/v1/items/:id` matches a request for the string `:id` and everything else falls through to 404. This is the single most common upgrade bug, and the compiler cannot help, so the first job on an existing service is grepping every route string.',
            'Keep the router boring: one `Router::new().nest("/v1", api())`, state passed as `Arc<AppState>` through `with_state`, and handlers that take extractors in the order body-last. Extractors that touch the body (`Json`, `Bytes`, `Multipart`) must be the final argument, because the body can only be consumed once.',
          ],
          code: `use axum::{extract::{Path, State}, routing::get, Router};
use std::sync::Arc;

pub struct AppState {
    pub pool: sqlx::PgPool,
}

pub fn app(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/items/{id}", get(get_item))
        .route("/items", axum::routing::post(create_item))
        .with_state(state)
}

async fn get_item(
    State(state): State<Arc<AppState>>,
    Path(id): Path<uuid::Uuid>,
) -> Result<axum::Json<Item>, ApiError> {
    let item = sqlx::query_as!(
        Item,
        r#"select id, sku, quantity from items where id = $1"#,
        id
    )
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::not_found("item"))?;

    Ok(axum::Json(item))
}`,
          tip: 'Search for `":` inside route strings after any axum upgrade; the old capture syntax fails silently at request time, not at startup.',
        },
        {
          h: 'One error enum decides status, body, and log level',
          p: [
            'The alternative to a typed error is `(StatusCode, String)` scattered across forty handlers, at which point nobody can answer "which endpoints return 409?". Define `ApiError` with a variant per failure class, implement `IntoResponse` once, and let `?` do the conversion work through `From` impls on sqlx and validation errors.',
            'A useful detail: log at the boundary, not in every handler. `IntoResponse` can emit a `tracing::error!` for 5xx and a `warn!` for 4xx with the request id, which gives exactly one log line per failed request. The body should carry a stable machine code - clients branch on `code`, humans read `message`.',
          ],
          list: [
            '400 for a malformed body, 422 for a well-formed body with invalid fields',
            '404 only when the resource does not exist, never for authorization failures',
            '409 for optimistic-concurrency conflicts and duplicate idempotency keys',
            '503 with Retry-After when a dependency is down, not 500',
          ],
          code: `use axum::{http::{header, StatusCode}, response::{IntoResponse, Response}, Json};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("{entity} not found")]
    NotFound { entity: &'static str },
    #[error("invalid field {field}: {reason}")]
    Invalid { field: &'static str, reason: String },
    #[error("conflict: {0}")]
    Conflict(String),
    #[error(transparent)]
    Db(#[from] sqlx::Error),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl ApiError {
    fn status(&self) -> StatusCode {
        match self {
            ApiError::NotFound { .. } => StatusCode::NOT_FOUND,
            ApiError::Invalid { .. } => StatusCode::UNPROCESSABLE_ENTITY,
            ApiError::Conflict(_) => StatusCode::CONFLICT,
            ApiError::Db(_) | ApiError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status();
        if status.is_server_error() {
            tracing::error!(error = ?self, "request failed");
        } else {
            tracing::warn!(error = %self, "request rejected");
        }
        if status == StatusCode::SERVICE_UNAVAILABLE {
            // callers must not hot-loop on a dependency outage
        }
        let body = Json(json!({
            "error": { "code": status.as_u16(), "message": self.to_string() }
        }));
        (status, [(header::CONTENT_TYPE, "application/json")], body).into_response()
    }
}`,
          tip: 'Never put the underlying sqlx error string in the body: it leaks table names and constraint names to anonymous callers. Log it, return the class.',
        },
        {
          h: 'Keyset pagination and idempotent writes',
          p: [
            '`OFFSET 10000` makes the database walk and discard ten thousand rows, then returns a window that shifts whenever a row is inserted. Keyset pagination - `where (created_at, id) > ($1, $2) order by created_at, id limit $3` - is O(limit) with the right composite index and stable under concurrent writes. Encode the cursor as base64 of the tuple and treat it as opaque.',
            'For POST, accept an `Idempotency-Key` header, store it in a unique index alongside the response, and replay the stored response on retry. A client that times out after your commit will retry, and without this the customer gets charged twice. The uniqueness constraint is the concurrency control; do not check-then-insert.',
          ],
          code: `-- keyset pagination that survives inserts
select id, sku, quantity, created_at
from items
where ($1::timestamptz is null or (created_at, id) > ($1, $2))
order by created_at, id
limit $3;

-- idempotent write: the unique index is the lock
create table idempotency_keys (
    key          text primary key,
    tenant_id    uuid not null,
    request_hash bytea not null,
    status       smallint not null,
    response     jsonb not null,
    created_at   timestamptz not null default now()
);
-- on conflict: return the stored response only if request_hash matches,
-- otherwise 409 - the same key reused with a different payload is a bug.`,
          tip: 'Hash the request body into request_hash; replaying a key with different content must be a 409, not a silently different answer.',
        },
      ],
      exercise: {
        prompt: 'Add a POST /items handler that returns 201 with a Location header, maps a unique-violation to 409, and replays a stored idempotency response when the same key arrives twice.',
        starter: `async fn create_item(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<NewItem>,
) -> Result<impl axum::response::IntoResponse, ApiError> {
    // 1. read Idempotency-Key, hash the body
    // 2. try insert; on unique violation return the stored response
    // 3. return 201 + Location
    todo!()
}`,
        hint: 'Insert the idempotency row and the item in one transaction. Catch sqlx::Error::Database with code 23505 (unique_violation) and decide from the stored row whether to replay or 409.',
        solution: `use axum::http::{header, HeaderMap, StatusCode};

async fn create_item(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<NewItem>,
) -> Result<axum::response::Response, ApiError> {
    let key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .ok_or(ApiError::Invalid { field: "Idempotency-Key", reason: "missing".into() })?;

    let hash = sha256_json(&body);
    let mut tx = state.pool.begin().await?;

    let stored = sqlx::query!(
        "select request_hash, status, response from idempotency_keys
         where key = $1 for update",
        key
    )
    .fetch_optional(&mut *tx)
    .await?;

    if let Some(row) = stored {
        if row.request_hash != hash {
            return Err(ApiError::Conflict("idempotency key reused with a different body".into()));
        }
        let status = StatusCode::from_u16(row.status as u16).unwrap_or(StatusCode::OK);
        return Ok((status, axum::Json(row.response)).into_response());
    }

    let id = uuid::Uuid::new_v4();
    let item = sqlx::query_as!(
        Item,
        "insert into items (id, sku, quantity) values ($1, $2, $3)
         returning id, sku, quantity",
        id,
        body.sku,
        body.quantity
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| match &e {
        sqlx::Error::Database(db) if db.code().as_deref() == Some("23505") => {
            ApiError::Conflict(format!("sku {} already exists", body.sku))
        }
        _ => ApiError::Db(e),
    })?;

    let payload = serde_json::to_value(&item)?;
    sqlx::query!(
        "insert into idempotency_keys (key, tenant_id, request_hash, status, response)
         values ($1, $2, $3, $4, $5)",
        key,
        tenant_id(),
        hash.as_slice(),
        201i16,
        payload
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok((
        StatusCode::CREATED,
        [(header::LOCATION, format!("/v1/items/{}", item.id))],
        axum::Json(item),
    )
        .into_response())
}`,
      },
      questions: [
        {
          q: 'A client sends a well-formed JSON body whose `quantity` field is negative. Which status fits best?',
          options: [
            '400 Bad Request, because the payload was rejected',
            '422 Unprocessable Entity, because the syntax parsed but the semantics are invalid',
            '409 Conflict, because the value conflicts with the schema',
            '500 Internal Server Error, because validation failed in the handler',
          ],
          answer: 1,
          explain: '400 means the request could not be parsed; 422 means it parsed and failed validation. The distinction lets clients decide whether to reserialize or to fix a field.',
        },
        {
          q: 'Why is OFFSET pagination unsafe for a feed that receives inserts?',
          options: [
            'It requires a full table scan on every request regardless of indexes',
            'Rows shift between pages, so clients see duplicates and skips',
            'It cannot be combined with an ORDER BY clause',
            'It always returns at most one page of results',
          ],
          answer: 1,
          explain: 'OFFSET counts rows in a moving result set. An insert before the current window pushes everything down, so page two repeats an item and later pages skip one. Keyset cursors anchor to a value, not a position.',
        },
        {
          q: 'What happens when the same Idempotency-Key arrives with a different request body?',
          options: [
            'Replay the original response, since the key is the identity',
            'Reject with 409, because the key was reused for a different operation',
            'Overwrite the stored row and process the new body',
            'Return 500; this can only happen if the client is buggy',
          ],
          answer: 1,
          explain: 'The key identifies one operation. Same key plus different payload means the client generated a non-unique key, and replaying would hide a real bug; 409 makes it visible.',
        },
      ],
      quickbytes: [
        'axum 0.8 captures use {id}; the old :id syntax matches literally and 404s at runtime.',
        'Implement IntoResponse on one error enum and let `?` convert; log once at that boundary.',
        'Keyset pagination with a composite index beats OFFSET under concurrent writes.',
        'Put the idempotency row in the same transaction as the write; the unique index is the lock.',
      ],
      production: [
        'Every route string was grepped for the old colon capture syntax after the 0.8 upgrade.',
        'The error enum is the only place that maps failures to status codes; handlers return Result<_, ApiError>.',
        '5xx bodies carry no database text; the details are in the log line with the request id.',
        'POST endpoints accept Idempotency-Key and store the request hash with the response.',
        'Pool acquire timeouts are shorter than the request deadline, so saturation produces 503 instead of queueing forever.',
      ],
      crates: ['axum', 'tokio', 'sqlx', 'tower-http'],
      github: [{ name: 'axum - HTTP routing and request handling', url: 'https://github.com/tokio-rs/axum' }],
      pitfall: 'Mapping every database error to 500: a unique-violation is a 409 and a foreign-key violation is a 422, and clients that retry 500s will hammer a conflict they caused themselves.',
      resources: [
        { title: 'axum crate documentation: routing, extractors, state', url: 'https://docs.rs/axum/latest/axum/', kind: 'docs' },
        { title: 'tower-http: middleware for tracing, timeouts, compression, CORS', url: 'https://docs.rs/tower-http/latest/tower_http/', kind: 'docs' },
        { title: 'axum repository: examples for routers, errors and websockets', url: 'https://github.com/tokio-rs/axum', kind: 'repo' },
        { title: 'MDN: HTTP response status codes', url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status', kind: 'docs' },
      ],
    },
    {
      id: 'u03',
      n: 3,
      title: 'gRPC service: server streaming without unbounded buffers',
      minutes: 100,
      level: 'advanced',
      goal: 'Serve a watch stream from a broadcast channel, convert lag into an explicit gap event, and make the client deadline decide when the stream ends.',
      sections: [
        {
          h: 'Why a stream instead of polling',
          p: [
            'A polling endpoint costs one query per client per interval and returns mostly nothing. Server streaming inverts that: the server holds one HTTP/2 stream per client and writes only when state changes. For a control-plane API that pushes config revisions, that is the difference between ten thousand queries per second of pure latency and a few hundred writes.',
            'The price is a long-lived connection on both sides. You inherit flow control, half-close semantics, and the awkward question of what a client missed while it was slow. Design for that last case up front; it is the one that produces silent data loss rather than an error.',
          ],
          code: `syntax = "proto3";

package acme.control.v1;

message WatchRequest {
  string tenant_id = 1;
  int64 from_revision = 2;   // 0 = start from current
}

message Revision {
  int64 revision = 1;
  bytes payload = 2;
  bool gap = 3;              // set when the server dropped intermediate revisions
}

service Config {
  rpc Watch(WatchRequest) returns (stream Revision);
}`,
          tip: 'Include from_revision in the request even if you ignore it on day one; adding it later means every client must reconnect from scratch.',
        },
        {
          h: 'Broadcast to streams, and make lag visible',
          p: [
            'The cheapest fan-out is `tokio::sync::broadcast`: one sender, N receivers, bounded ring buffer. When a receiver falls behind the buffer, `recv()` returns `RecvError::Lagged(n)` and the cursor jumps to the oldest retained value - the receiver is not disconnected, and it does not get the values it missed. Treating Lagged as a fatal error disconnects healthy slow clients; ignoring it silently loses revisions.',
            'The correct handling is domain-specific: send a `Revision { gap: true }` marker and let the client resync from its last known revision, or close the stream with a status that tells the client to refetch. Either way the gap must be observable, otherwise the client believes it has a continuous history.',
          ],
          code: `use async_stream::try_stream;
use tokio::sync::broadcast;
use tokio_stream::Stream;
use tonic::{Request, Response, Status};

pub async fn watch(
    &self,
    req: Request<WatchRequest>,
) -> Result<Response<impl Stream<Item = Result<Revision, Status>>>, Status> {
    let mut rx = self.tx.subscribe();
    let mut last = req.into_inner().from_revision;

    let stream = try_stream! {
        loop {
            match rx.recv().await {
                Ok(rev) if rev.revision > last => {
                    last = rev.revision;
                    yield rev;
                }
                Ok(_) => continue, // already seen
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!(skipped, "watch stream lagged; emitting gap");
                    yield Revision { revision: last, payload: Vec::new().into(), gap: true };
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };

    Ok(Response::new(stream))
}`,
          tip: 'Broadcast capacity is in messages, not bytes. A 1024-slot buffer of 64 KiB revisions is 64 MiB of retained memory per channel.',
        },
        {
          h: 'Deadlines, flow control, and shutdown',
          p: [
            'gRPC sets no deadline by default, so a stream can outlive every operational assumption you have. Clients should call `Request::set_timeout`, and the server should finish cleanly when the client goes away: the stream future is dropped, which is your cancellation signal. Any spawned task holding the receiver must be aborted or it leaks for the process lifetime.',
            'HTTP/2 flow control gives you backpressure for free until it does not: if the client stops reading, `send` awaits once the window is exhausted, and your broadcast receiver stops draining, which is exactly when Lagged starts firing. Cap concurrent streams per connection (`max_concurrent_streams`) and message size (`max_decoding_message_size`) so one client cannot pin an unbounded amount of your memory.',
          ],
          list: [
            'Propagate the caller budget: a watch stream with a deadline must not outlive it',
            'Send keepalives or rely on HTTP/2 pings; idle-timeout proxies will cut silent streams',
            'Drain on shutdown: stop accepting, close senders, let streams end with a status',
            'Never buffer the whole history per subscriber to "make sure" it misses nothing',
          ],
        },
      ],
      exercise: {
        prompt: 'Add a per-tenant revision filter so a subscriber only receives revisions for its own tenant, and emit a gap marker when Lagged is observed. Keep the stream type as `impl Stream<Item = Result<Revision, Status>>`.',
        starter: `pub async fn watch(
    &self,
    req: Request<WatchRequest>,
) -> Result<Response<impl Stream<Item = Result<Revision, Status>>>, Status> {
    let tenant = req.into_inner().tenant_id;
    let mut rx = self.tx.subscribe();
    // TODO: filter by tenant, handle Lagged with a gap
    todo!()
}`,
        hint: 'Subscribe first, then filter inside the stream loop; subscribing later leaves a window where revisions are missed without a gap marker.',
        solution: `use async_stream::try_stream;
use tokio::sync::broadcast;
use tokio_stream::Stream;
use tonic::{Request, Response, Status};

pub async fn watch(
    &self,
    req: Request<WatchRequest>,
) -> Result<Response<impl Stream<Item = Result<Revision, Status>>>, Status> {
    let req = req.into_inner();
    if req.tenant_id.is_empty() {
        return Err(Status::invalid_argument("tenant_id is required"));
    }

    // Subscribe before the first await so no revision can slip between
    // reading the request and attaching to the channel.
    let mut rx = self.tx.subscribe();
    let tenant = req.tenant_id;
    let mut last = req.from_revision;

    let stream = try_stream! {
        loop {
            match rx.recv().await {
                Ok(rev) if rev.tenant_id != tenant => continue,
                Ok(rev) if rev.revision > last => {
                    last = rev.revision;
                    yield rev.into();
                }
                Ok(_) => continue,
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!(%tenant, skipped, "subscriber lagged");
                    yield Revision { revision: last, payload: Vec::new().into(), gap: true };
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };

    Ok(Response::new(stream))
}`,
      },
      questions: [
        {
          q: 'A subscriber receives RecvError::Lagged(500). What actually happened to it?',
          options: [
            'The channel closed and the receiver is now disconnected',
            'It fell behind the ring buffer; 500 values were dropped and its cursor jumped',
            'The sender panicked and no further values will arrive',
            'The receiver missed 500 bytes of a single message',
          ],
          answer: 1,
          explain: 'Lagged carries a count of dropped messages and advances the cursor to the oldest retained value. The receiver stays connected, which is why you must surface the gap yourself.',
        },
        {
          q: 'What happens server-side when a streaming client stops reading?',
          options: [
            'The server drops the stream immediately',
            'send awaits once the HTTP/2 flow-control window is exhausted',
            'Messages are silently written to disk until the client returns',
            'The server starts a new stream from the beginning',
          ],
          answer: 1,
          explain: 'HTTP/2 flow control applies backpressure: writes block when the peer window is full. That blocking is what turns a slow reader into a lagged broadcast receiver.',
        },
        {
          q: 'Why subscribe to the broadcast channel before validating the rest of the request?',
          options: [
            'Because subscribe() is not async and must run before any await',
            'To avoid a window in which revisions arrive between validation and subscription',
            'Because the channel requires exclusive access during validation',
            'It makes no difference; the stream starts at the same point either way',
          ],
          answer: 1,
          explain: 'Any await before subscribe is a gap the client was never told about. Attaching first and filtering second keeps the stream honest about what it missed.',
        },
      ],
      quickbytes: [
        'A broadcast buffer of N messages costs N x message size; size it in bytes, not vibes.',
        'RecvError::Lagged does not disconnect; emit a gap revision or close with a resync status.',
        'Set a client deadline on every streaming call or the stream outlives your deploy.',
        'Cap max_decoding_message_size and max_concurrent_streams per connection.',
      ],
      production: [
        'Every watch stream carries a deadline and is cancelled when the client disconnects.',
        'Lag events are logged with the tenant and the number of skipped revisions.',
        'Broadcast capacity is documented next to the message size it multiplies.',
        'Shutdown stops accepting, drops senders, and lets streams terminate with a status.',
        'A load test holds 5k idle streams and asserts memory stays flat for an hour.',
      ],
      crates: ['tonic', 'tonic-prost', 'tokio', 'async-stream'],
      github: [
        { name: 'tonic (grpc-rust) - gRPC client and server for Rust', url: 'https://github.com/grpc/grpc-rust' },
        { name: 'tokio - broadcast channel and runtime', url: 'https://github.com/tokio-rs/tokio' },
      ],
      pitfall: 'Buffering the entire revision history per subscriber "so nothing is missed": memory grows with history times subscribers, and the process OOMs exactly when a client reconnects and replays.',
      resources: [
        { title: 'tonic crate documentation: streaming RPCs and codegen', url: 'https://docs.rs/tonic/latest/tonic/', kind: 'docs' },
        { title: 'gRPC core concepts: streaming, flow control, deadlines', url: 'https://grpc.io/docs/what-is-grpc/core-concepts/', kind: 'docs' },
        { title: 'tokio::sync::broadcast: Lagged semantics and capacity', url: 'https://docs.rs/tokio/latest/tokio/sync/broadcast/index.html', kind: 'docs' },
        { title: 'async-stream: write a Stream with yield-style code', url: 'https://docs.rs/async-stream/latest/async_stream/', kind: 'docs' },
      ],
    },
    {
      id: 'u04',
      n: 4,
      title: 'Worker queue: claiming jobs with SKIP LOCKED and a lease',
      minutes: 95,
      level: 'advanced',
      goal: 'Build a Postgres-backed job queue whose claim step is one statement, whose retries are bounded, and whose stuck-job recovery does not depend on the worker still running.',
      sections: [
        {
          h: 'The claim is the whole design',
          p: [
            'A queue table plus a polling loop is easy; a queue table that two hundred workers can drain without duplicating work is the actual problem. `SELECT ... FOR UPDATE SKIP LOCKED` is the mechanism: each transaction locks the rows it inspects, and instead of blocking on rows another worker already holds, it skips them and takes the next available batch. Throughput scales with workers because contention disappears.',
            'The claim must also be a *lease*. Marking a row `in_progress` with no expiry means a crashed worker strands that job forever. Store `locked_until = now() + lease` in the same UPDATE that returns the rows, and let the claim query treat an expired lease as claimable. The worker that comes back from a long GC pause will find its job re-claimed by someone else - which is correct, and why handlers must be idempotent.',
          ],
          code: `create table jobs (
    id           uuid primary key,
    kind         text        not null,
    payload      jsonb       not null,
    run_at       timestamptz not null default now(),
    attempts     int         not null default 0,
    locked_until timestamptz,
    locked_by    text,
    last_error   text,
    finished_at  timestamptz
);

-- only unfinished, due jobs are interesting; keep the index small
create index jobs_ready_idx on jobs (run_at) where finished_at is null;

-- one statement claims up to $1 jobs and leases them for $2
with claimed as (
    select id from jobs
    where finished_at is null
      and run_at <= now()
      and (locked_until is null or locked_until < now())
    order by run_at
    limit $1
    for update skip locked
)
update jobs j
set locked_until = now() + $2::interval,
    locked_by    = $3,
    attempts     = j.attempts + 1
from claimed c
where j.id = c.id
returning j.id, j.kind, j.payload, j.attempts;`,
          tip: 'Create the partial index on (run_at) WHERE finished_at IS NULL; a full index on a table that keeps history grows without bound and stops being cached.',
        },
        {
          h: 'Retries, backoff, and the dead-letter path',
          p: [
            'Every failure increments `attempts` (already done by the claim) and reschedules with exponential backoff plus jitter: `run_at = now() + least(2^attempts, 300) seconds * random()`. Without jitter, a downstream outage that fails a thousand jobs retries them in a thundering herd at the same instant, and the dependency falls over again just as it recovers.',
            'When `attempts >= max_attempts`, stop retrying and record the terminal state - a separate `dead_letters` table or a `finished_at` plus `status = \'dead\'`. You need a query for "what is failing" that does not require a running worker, so keep the payload and the last error. Then the operator can inspect, fix, and requeue deliberately.',
          ],
          code: `use std::time::Duration;

const LEASE: &str = "30 seconds";

pub async fn run_worker(pool: sqlx::PgPool, worker_id: String) -> anyhow::Result<()> {
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    loop {
        tick.tick().await;

        let jobs = sqlx::query_as!(
            Job,
            r#"with claimed as (
                   select id from jobs
                   where finished_at is null and run_at <= now()
                     and (locked_until is null or locked_until < now())
                   order by run_at limit $1
                   for update skip locked
               )
               update jobs j
               set locked_until = now() + $2::interval,
                   locked_by = $3, attempts = j.attempts + 1
               from claimed c where j.id = c.id
               returning j.id, j.kind, j.payload, j.attempts, j.max_attempts"#,
            16i64, LEASE, &worker_id
        )
        .fetch_all(&pool)
        .await?;

        for job in jobs {
            match handle(&job).await {
                Ok(()) => finish(&pool, job.id, None).await?,
                Err(err) if job.attempts >= job.max_attempts => {
                    finish(&pool, job.id, Some(err.to_string())).await? // dead letter
                }
                Err(err) => {
                    // 2^n seconds, capped, then jittered by random()
                    let backoff = 2i64.saturating_pow(job.attempts as u32).min(300);
                    sqlx::query!(
                        "update jobs set run_at = now() + make_interval(secs => $2 * random()),
                             locked_until = null, last_error = $3 where id = $1",
                        job.id, backoff as f64, err.to_string()
                    )
                    .execute(&pool)
                    .await?;
                }
            }
        }
    }
}

async fn finish(pool: &sqlx::PgPool, id: uuid::Uuid, err: Option<String>) -> anyhow::Result<()> {
    sqlx::query("update jobs set finished_at = now(), locked_until = null, last_error = $2
                 where id = $1")
        .bind(id)
        .bind(err)
        .execute(pool)
        .await?;
    Ok(())
}`,
          tip: 'Calculate backoff in SQL when you can: it keeps the retry schedule consistent across workers with different clocks and languages.',
        },
        {
          h: 'At-least-once is the guarantee you can actually keep',
          p: [
            'There is no way to atomically commit a database write and an email send. So the contract is at-least-once delivery, and exactly-once *effects* are the handler\'s job: an idempotency key derived from the job id, an UPSERT instead of an INSERT, or a downstream API that accepts a request id. If the handler cannot be made idempotent, the design is wrong, not the queue.',
            'Two operational metrics make the queue debuggable: oldest ready job age (not queue depth - a deep queue draining fast is healthy) and lease expiry rate (jobs whose worker died or stalled). Alert on age. A queue that is empty but whose oldest job is forty minutes old means workers are stuck, not idle.',
          ],
          list: [
            'Metric: age of the oldest unfinished job, alert at 3x p99 processing time',
            'Metric: jobs whose lease expired without completion, alert on any sustained rate',
            'Never delete failed jobs; move them to a dead-letter state with the payload intact',
            'Make the handler idempotent, because the same job will run twice eventually',
          ],
          tip: 'Queue depth is a vanity metric - a 50k backlog draining in seconds is fine. Age is the one that maps to user-visible latency.',
        },
      ],
      exercise: {
        prompt: 'A worker crashes mid-handler. Write the sweeper query that finds jobs whose lease expired, and change the handler contract so a re-run cannot double-charge a customer.',
        starter: `-- 1. find jobs whose lease expired while unfinished
select id, kind, attempts
from jobs
where finished_at is null
  and locked_until < now()
  and ???
order by locked_until
limit 100;

// 2. make the charge handler idempotent
async fn charge(job: &Job) -> anyhow::Result<()> {
    todo!()
}`,
        hint: 'Skip jobs that are still claimable (attempts below max) so the sweeper and the claim path do not fight. For the charge, use a unique key derived from the job id and an UPSERT into a charges table.',
        solution: `-- Jobs whose lease expired and which are not simply waiting for a retry.
-- They are reclaimable already; this query is for observability, not for
-- stealing work (the claim query handles that).
select id, kind, attempts, locked_by, locked_until, last_error
from jobs
where finished_at is null
  and locked_until is not null
  and locked_until < now()
order by locked_until
limit 100;

-- Idempotent charge: the job id is the idempotency key.
create table charges (
    job_id      uuid primary key,
    customer_id uuid        not null,
    amount      bigint      not null,
    created_at  timestamptz not null default now()
);

async fn charge(pool: &sqlx::PgPool, job: &Job) -> anyhow::Result<()> {
    let customer = job.payload["customer_id"].as_str().unwrap();
    let amount = job.payload["amount_minor"].as_i64().unwrap();

    sqlx::query!(
        r#"insert into charges (job_id, customer_id, amount)
           values ($1, $2::uuid, $3)
           on conflict (job_id) do nothing"#,
        job.id,
        customer,
        amount
    )
    .execute(pool)
    .await?;

    Ok(())
}`,
      },
      questions: [
        {
          q: 'What does FOR UPDATE SKIP LOCKED give the claim query?',
          options: [
            'It serialises all workers behind a single row lock',
            'It skips rows locked by another transaction instead of blocking on them',
            'It locks the whole table so no new jobs can be inserted',
            'It guarantees each job runs exactly once',
          ],
          answer: 1,
          explain: 'Skip-locked turns lock contention into work distribution: a worker takes the next free rows immediately. It gives concurrency, not exactly-once semantics.',
        },
        {
          q: 'Why add jitter to the retry backoff?',
          options: [
            'To make logs easier to read',
            'To spread retries so a recovering dependency is not immediately overwhelmed',
            'Because Postgres rounds interval values without it',
            'To reduce the size of the jobs table',
          ],
          answer: 1,
          explain: 'A thousand jobs that failed at the same instant would retry at the same instant. Jitter decorrelates them, which is the difference between a recovering service and a second outage.',
        },
        {
          q: 'Which metric best predicts user-visible pain from a queue?',
          options: [
            'Total rows in the jobs table',
            'Age of the oldest unfinished job',
            'Number of workers currently polling',
            'Bytes stored in the payload column',
          ],
          answer: 1,
          explain: 'Depth says nothing about drain rate. Age measures how long someone has been waiting, which is the thing that shows up as a late email or an unshipped order.',
        },
      ],
      quickbytes: [
        'Claim with one UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED) statement; never select then update.',
        'A lease without an expiry strands jobs forever when a worker dies; store locked_until.',
        'Partial index `WHERE finished_at IS NULL` keeps the hot index small.',
        'At-least-once delivery is the only honest guarantee; make effects idempotent with the job id.',
      ],
      production: [
        'Handlers are idempotent and are tested by delivering the same job twice.',
        'Dead-lettered jobs keep payload, attempts, and last error for inspection and requeue.',
        'Alerts fire on oldest-job age and on lease-expiry rate, not on queue depth.',
        'sqlx compile-time checks use a prepared offline cache so CI builds without a database URL.',
        'A load test with 8 workers and 100k jobs asserts no job is claimed twice while leased.',
      ],
      crates: ['sqlx', 'tokio', 'uuid', 'serde_json'],
      github: [{ name: 'sqlx - async SQL with compile-time checked queries', url: 'https://github.com/transact-rs/sqlx' }],
      pitfall: 'A worker that holds a row lock for the duration of the handler: the transaction stays open across network calls, so the pool starves and every other worker blocks on the table.',
      resources: [
        { title: 'PostgreSQL: SELECT, FOR UPDATE and SKIP LOCKED', url: 'https://www.postgresql.org/docs/current/sql-select.html', kind: 'docs' },
        { title: 'sqlx crate documentation: pools, transactions, query macros', url: 'https://docs.rs/sqlx/latest/sqlx/', kind: 'docs' },
        { title: 'sqlx repository: offline mode and migration tooling', url: 'https://github.com/transact-rs/sqlx', kind: 'repo' },
        { title: 'tokio tutorial: shared state, channels, and graceful shutdown', url: 'https://tokio.rs/tokio/tutorial', kind: 'docs' },
      ],
    },
    {
      id: 'u05',
      n: 5,
      title: 'Realtime gateway: bounded fan-out and slow-consumer policy',
      minutes: 90,
      level: 'advanced',
      goal: 'Upgrade WebSocket connections in axum, fan out with a bounded broadcast channel, and decide per connection what happens when a client cannot keep up.',
      sections: [
        {
          h: 'Authenticate before you upgrade',
          p: [
            'A WebSocket handshake is an HTTP request until it is not. Do the authorization in the request phase - cookie, bearer token, subprotocol - and reject with 401 before `on_upgrade` runs, because once the socket is open the only rejection you have left is a close frame that the client may never read. Decide the topic set at upgrade time from the verified identity. Letting the client `subscribe` to arbitrary topics later re-implements authorization inside a message handler, which is exactly where it will be forgotten.',
            'The gateway brief: push order-status changes to browser dashboards, with one topic per tenant. Ten thousand idle connections must cost approximately nothing, and one stuck browser tab must not be able to slow down a thousand others. That last sentence is the entire design constraint - everything below is about bounding what a single misbehaving client can consume while keeping the happy path allocation-light.',
          ],
          code: `use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, State},
    http::StatusCode,
    response::IntoResponse,
};

async fn upgrades(
    ws: WebSocketUpgrade,
    State(app): State<std::sync::Arc<App>>,
    // a real gateway extracts and verifies a session here
) -> Result<impl IntoResponse, StatusCode> {
    let user = app.sessions.verify_from_headers(/* ... */).await
        .map_err(|_| StatusCode::UNAUTHORIZED)?;

    Ok(ws.on_upgrade(move |socket| handle(socket, app, user.tenant_id)))
}`,
          tip: 'Pass the resolved tenant id into the socket task instead of re-reading headers later; the headers are gone once the connection is upgraded.',
        },
        {
          h: 'Split, then select: three futures per connection',
          p: [
            'A WebSocket is a Sink and a Stream; `socket.split()` gives you both halves so a task can read while another writes. The handler then races three things: inbound messages, the broadcast receiver, and a keepalive interval. When any of them ends, abort the other two - a half-closed socket that nobody polls is a file descriptor leak.',
            'The subtle part is the write side. `sink.send(...)` awaits when the TCP send buffer is full, which means a slow client applies backpressure to *your* task, not to the broadcast channel. That is fine as long as the channel has a bounded capacity and you decide what to do when the receiver lags: send a gap message, drop to a lower update rate, or close with 1011. Silently dropping is the one option that produces a dashboard showing stale data forever.',
          ],
          code: `use axum::extract::ws::{Message, WebSocket};
use futures::{SinkExt, StreamExt};
use tokio::sync::broadcast;
use tokio::time::{interval, Duration, MissedTickBehavior};

async fn handle(mut socket: WebSocket, app: std::sync::Arc<App>, tenant: uuid::Uuid) {
    let (mut sink, mut stream) = socket.split();
    let mut rx = app.hub.subscribe(tenant);
    let mut ping = interval(Duration::from_secs(20));
    ping.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let mut send = tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = rx.recv() => match msg {
                    Ok(text) => {
                        if sink.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(missed)) => {
                        // tell the client it must resync instead of lying
                        let gap = format!(r#"{{"type":"gap","missed":{missed}}}"#);
                        if sink.send(Message::Text(gap.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                _ = ping.tick() => {
                    if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    let mut recv = tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            match msg {
                Message::Close(_) => break,
                Message::Text(_) => { /* commands, or ignore */ }
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = &mut send => recv.abort(),
        _ = &mut recv => send.abort(),
    }
}`,
          tip: 'Set MissedTickBehavior::Delay on the keepalive; Burst (the default) fires the missed ticks back to back after a stall.',
        },
        {
          h: 'Size the buffers with arithmetic, not instinct',
          p: [
            'Memory per idle connection is a handful of kilobytes; memory per lagged connection is the broadcast capacity times the message size, plus the socket buffers. A capacity of 512 with 2 KiB messages is 1 MiB of retained ring buffer per topic, shared by all subscribers - broadcast stores each message once, not once per subscriber - but each socket also holds its own kernel send buffer, which is where ten thousand idle tabs actually hurt.',
            'The honest capacity plan: messages per second times acceptable staleness equals the buffer depth. If you publish ten updates per second and can tolerate ten seconds of staleness before forcing a resync, 100 slots is enough; 10,000 means you are trying to hide a broken consumer. Write the number down next to the constant, because the next person will otherwise change it to 65536.',
          ],
          list: [
            'Broadcast stores each message once; receivers only hold a cursor',
            'The stall cost is per socket send buffer plus your websocket frame buffer',
            'Ping every 20-30 s and close on missed pongs; dead TCP connections look alive for minutes',
            'Set a max frame size and reject oversized inbound messages at the upgrade',
          ],
        },
      ],
      exercise: {
        prompt: 'Add a per-tenant publish path that refuses to queue more than N bytes for a single connection, and close the socket with code 1013 when the client is too far behind.',
        starter: `async fn handle(socket: WebSocket, app: Arc<App>, tenant: Uuid) {
    // 1. track how many gap events this connection has emitted
    // 2. after 3 gaps in a row, close with 1013 (try again later)
    todo!()
}`,
        hint: 'Count consecutive Lagged events in the send task; reset the counter on a successful send. Close with Message::Close(Some(CloseFrame { code: 1013, reason: "slow consumer".into() })).',
        solution: `use axum::extract::ws::{close_code, CloseFrame, Message, WebSocket};
use futures::{SinkExt, StreamExt};
use tokio::sync::broadcast;

const MAX_CONSECUTIVE_GAPS: u8 = 3;

async fn handle(socket: WebSocket, app: std::sync::Arc<App>, tenant: uuid::Uuid) {
    let (mut sink, mut stream) = socket.split();
    let mut rx = app.hub.subscribe(tenant);
    let mut gaps: u8 = 0;

    let mut send = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(text) => {
                    gaps = 0;
                    if sink.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(missed)) => {
                    gaps += 1;
                    if gaps > MAX_CONSECUTIVE_GAPS {
                        let _ = sink
                            .send(Message::Close(Some(CloseFrame {
                                code: close_code::TRY_AGAIN_LATER,
                                reason: "slow consumer".into(),
                            })))
                            .await;
                        break;
                    }
                    let gap = format!(r#"{{"type":"gap","missed":{missed}}}"#);
                    if sink.send(Message::Text(gap.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let mut recv = tokio::spawn(async move {
        while let Some(Ok(_)) = stream.next().await {}
    });

    tokio::select! {
        _ = &mut send => recv.abort(),
        _ = &mut recv => send.abort(),
    }
}`,
      },
      questions: [
        {
          q: 'Why does the broadcast receiver report Lagged instead of just slowing the sender?',
          options: [
            'Because broadcast uses a fixed ring buffer and overwrites the oldest message',
            'Because the sender holds a lock that the receiver must release',
            'Because WebSocket frames cannot be reordered',
            'Because tokio channels are unbounded by default',
          ],
          answer: 0,
          explain: 'A bounded ring buffer drops the oldest entries once full, so a slow receiver\'s cursor falls behind retained data. That is a deliberate trade: publishers never block on the slowest subscriber.',
        },
        {
          q: 'A browser tab stops reading but keeps its TCP connection open. What happens to the gateway task?',
          options: [
            'It keeps buffering in memory without limit',
            'sink.send awaits once the socket buffers fill, so the task stalls',
            'The task panics with a broken pipe immediately',
            'The broadcast channel blocks all other subscribers',
          ],
          answer: 1,
          explain: 'Writes apply backpressure to the writing task. The broadcast channel is unaffected - other subscribers keep receiving - which is exactly why per-connection policy matters.',
        },
        {
          q: 'Where should tenant authorization happen for a WebSocket endpoint?',
          options: [
            'In the first message after the upgrade, so the handshake stays cheap',
            'Before on_upgrade, while the request is still an HTTP request',
            'In a per-message guard inside the receive loop',
            'In the client, by only subscribing to its own topic',
          ],
          answer: 1,
          explain: 'Before the upgrade you can still return 401 and normal HTTP middleware applies. Afterwards the only rejection mechanism is a close frame, and authorization tends to get forgotten.',
        },
      ],
      quickbytes: [
        'Reject unauthenticated upgrades with 401 before on_upgrade; afterwards you only have close codes.',
        'socket.split() plus tokio::select! over send and recv; abort the loser instead of leaking it.',
        'Answer Lagged with an explicit gap message - stale-but-silent is the worst outcome.',
        'MissedTickBehavior::Delay for keepalives, or missed pings fire back to back after a stall.',
      ],
      production: [
        'The socket task aborts both halves when either side ends; no half-open connections accumulate.',
        'Slow-consumer policy is explicit and tested: gap message, then close with 1013.',
        'Keepalive ping interval is shorter than the load balancer idle timeout.',
        'Inbound frame size is capped and oversized messages close the connection.',
        'A 10k-connection load test measures RSS and file descriptors for an hour.',
      ],
      crates: ['axum', 'tokio', 'futures', 'serde_json'],
      github: [{ name: 'axum - WebSocket extractors and routing', url: 'https://github.com/tokio-rs/axum' }],
      pitfall: 'Using an unbounded mpsc channel per connection "to avoid dropping messages": a single slow client can then grow the process until the OOM killer resolves the design debate.',
      resources: [
        { title: 'axum::extract::ws: upgrade, split, and message types', url: 'https://docs.rs/axum/latest/axum/extract/ws/index.html', kind: 'docs' },
        { title: 'tokio broadcast: bounded ring buffer and Lagged', url: 'https://docs.rs/tokio/latest/tokio/sync/broadcast/index.html', kind: 'docs' },
        { title: 'MDN: the WebSocket API and close codes', url: 'https://developer.mozilla.org/en-US/docs/Web/API/WebSocket', kind: 'docs' },
        { title: 'Tokio: graceful shutdown patterns for long-lived connections', url: 'https://tokio.rs/tokio/topics/shutdown', kind: 'docs' },
      ],
    },
    {
      id: 'u06',
      n: 6,
      title: 'Data pipeline: checkpointed commits with conditional puts',
      minutes: 100,
      level: 'advanced',
      goal: 'Stream Parquet in bounded memory and publish results atomically, so a crashed run never leaves a half-visible dataset for downstream readers.',
      sections: [
        {
          h: 'Bounded memory or nothing',
          p: [
            'The pipeline brief: read daily order exports, normalize them, write partitioned Parquet, and let a warehouse job pick up only complete partitions. The naive implementation collects the file into a Vec, which works on the 200 MB dev sample and dies on the 40 GB production export - usually after forty minutes of work.',
            'Arrow and Parquet are designed for streaming. `ParquetRecordBatchReaderBuilder::try_new(file)` inspects the footer, and `.with_batch_size(8192).build()` yields record batches of at most that many rows. Transform batch by batch, and memory is a function of batch size, not file size. Every `collect()` in a pipeline is a bet that the input stays small.',
          ],
          code: `use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

pub fn normalize_file(input: &std::path::Path, batch_size: usize) -> Result<u64, Box<dyn std::error::Error>> {
    let file = std::fs::File::open(input)?;
    let builder = ParquetRecordBatchReaderBuilder::try_new(file)?;

    // the schema check happens once, before any row is read
    let schema = builder.schema().clone();

    let reader = builder.with_batch_size(batch_size).build()?;
    let mut rows = 0u64;

    for batch in reader {
        let batch = batch?;
        rows += batch.num_rows() as u64;

        // transform only the columns you need, in place where the kernel allows
        let _normalized = normalize_batch(&batch)?;
    }

    Ok(rows)
}`,
          tip: 'Batch size trades memory for per-batch overhead; 8k-64k rows is the usual sweet spot for columnar transforms.',
        },
        {
          h: 'Readers see nothing until the commit lands',
          p: [
            'Object stores give you atomic single-object writes and conditional writes, not transactions across objects. So build the commit protocol out of those: write every part file under a fresh run prefix, then write a manifest that lists them. Readers only ever list manifests. A crash before the manifest exists leaves orphaned parts, which is garbage, not corruption - and the garbage collector can find them by prefix.',
            'The conditional put is what prevents two concurrent runs from both declaring victory. `PutMode::Create` fails with `AlreadyExists` if the manifest is there; `PutMode::Update(UpdateVersion { e_tag, version })` fails with `Precondition` if someone changed it since you read it. Both failures mean "re-read and decide", never "retry blindly".',
          ],
          code: `use object_store::{path::Path as ObjPath, ObjectStore, PutMode, PutPayload, UpdateVersion};
use std::sync::Arc;

pub async fn commit_manifest(
    store: &Arc<dyn ObjectStore>,
    run_id: &str,
    parts: Vec<String>,
) -> Result<(), object_store::Error> {
    let path = ObjPath::from(format!("datasets/orders/{run_id}/_COMMIT.json"));
    let body = serde_json::to_vec(&serde_json::json!({
        "run_id": run_id,
        "parts": parts,
        "schema_version": 3,
    }))
    .expect("manifest is serializable");

    loop {
        match store.get(&path).await {
            // manifest already there: only replace it with an explicit update
            Ok(existing) => {
                let etag = existing.meta.e_tag.clone();
                let version = existing.meta.version.clone();
                let mode = PutMode::Update(UpdateVersion { e_tag: etag, version });
                match store.put_opts(&path, PutPayload::from(body.clone()), mode.into()).await {
                    Ok(_) => return Ok(()),
                    Err(object_store::Error::Precondition { .. }) => continue,
                    Err(e) => return Err(e),
                }
            }
            Err(object_store::Error::NotFound { .. }) => {
                match store
                    .put_opts(&path, PutPayload::from(body.clone()), PutMode::Create.into())
                    .await
                {
                    Ok(_) => return Ok(()),
                    Err(object_store::Error::AlreadyExists { .. }) => continue,
                    Err(e) => return Err(e),
                }
            }
            Err(e) => return Err(e),
        }
    }
}`,
          tip: 'Keep the writer single-flight per run_id; the conditional put protects against duplicates, not against two writers fighting over the same prefix.',
        },
        {
          h: 'Reprocessing is the normal case',
          p: [
            'Pipelines rerun. A bug fix, a late-arriving file, a backfill for last quarter - all mean the same partition gets written twice. Deterministic output names (run id plus partition plus a content hash) plus an idempotent manifest make the second run a no-op for readers. If instead you name files by timestamp, every rerun doubles the dataset and the downstream job counts rows twice.',
            'Track three numbers per run and emit them as a record: rows read, rows written, rows quarantined. The quarantined count is the one that catches silent data loss - a parser that drops 3% of lines with a warning is worse than one that fails, because nobody notices until finance reconciles.',
          ],
          list: [
            'Partition by event date, never by ingestion time',
            'Name parts deterministically from (run_id, partition, content hash)',
            'Record rows read / written / quarantined per run and assert read = written + quarantined',
            'Garbage-collect part files whose run has no manifest after 24 hours',
          ],
        },
      ],
      exercise: {
        prompt: 'Add a quarantine path: rows that fail validation go to a separate part file with the failure reason, and the run reports rows_read == rows_written + rows_quarantined.',
        starter: `pub struct RunStats {
    pub read: u64,
    pub written: u64,
    pub quarantined: u64,
}

pub fn normalize_file(input: &Path, batch: usize) -> Result<RunStats, Box<dyn Error>> {
    // TODO: validate each row; collect rejects; assert the identity
    todo!()
}`,
        hint: 'Count per row, not per batch, and make the invariant a debug_assert plus a hard error in release. The quarantine writer takes the same schema plus an `error` column.',
        solution: `pub struct RunStats {
    pub read: u64,
    pub written: u64,
    pub quarantined: u64,
}

pub fn normalize_file(input: &std::path::Path, batch: usize) -> Result<RunStats, Box<dyn std::error::Error>> {
    let file = std::fs::File::open(input)?;
    let builder = parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder::try_new(file)?;
    let reader = builder.with_batch_size(batch).build()?;

    let mut stats = RunStats { read: 0, written: 0, quarantined: 0 };

    for batch in reader {
        let batch = batch?;
        stats.read += batch.num_rows() as u64;

        for row in 0..batch.num_rows() {
            match validate_row(&batch, row) {
                Ok(_) => stats.written += 1,
                Err(reason) => {
                    stats.quarantined += 1;
                    tracing::warn!(row, %reason, "row quarantined");
                }
            }
        }
    }

    if stats.read != stats.written + stats.quarantined {
        return Err(format!(
            "accounting mismatch: read {} != written {} + quarantined {}",
            stats.read, stats.written, stats.quarantined
        )
        .into());
    }

    Ok(stats)
}`,
      },
      questions: [
        {
          q: 'Why write the manifest last instead of appending rows to it as you go?',
          options: [
            'Because JSON cannot be appended to',
            'So a reader never sees a manifest that lists parts which do not exist yet',
            'Because object stores rate-limit repeated writes to one key',
            'To avoid paying for more than one PUT per run',
          ],
          answer: 1,
          explain: 'Objects appear atomically, so a manifest written after all parts is the commit point. Readers that list manifests get all-or-nothing visibility of a run.',
        },
        {
          q: 'You get Error::Precondition from a put_opts with PutMode::Update. What does it mean?',
          options: [
            'The credentials are wrong',
            'The object changed since you read its version, so your write was rejected',
            'The bucket does not exist',
            'The payload exceeded the maximum object size',
          ],
          answer: 1,
          explain: 'Precondition means the version you supplied no longer matches. The correct response is to re-read, merge, and retry - not to force an overwrite.',
        },
        {
          q: 'Which failure does the quarantine counter exist to catch?',
          options: [
            'Slow batches caused by large row groups',
            'Rows silently dropped during parsing, which would otherwise look like success',
            'Schema changes between parquet versions',
            'Duplicate manifests from concurrent runs',
          ],
          answer: 1,
          explain: 'A pipeline that logs "skipped 412 rows" and exits 0 loses data quietly. Accounting for every row turns silent loss into a failed assertion.',
        },
      ],
      quickbytes: [
        'with_batch_size is the memory knob; every collect() is a bet the input stays small.',
        'Parts first, manifest last: the manifest write is the commit point readers observe.',
        'PutMode::Create and PutMode::Update turn concurrent writers into a retry loop, not a race.',
        'Assert rows_read == rows_written + rows_quarantined on every run.',
      ],
      production: [
        'The pipeline reports rows read, written, and quarantined, and fails on any accounting mismatch.',
        'Readers only list committed manifests; orphaned parts are garbage-collected on a schedule.',
        'Object-store writes retry on Precondition/AlreadyExists with bounded attempts, then alert.',
        'Partition pruning is asserted by a query that would be too slow without it.',
        'A rerun of yesterday\'s partition produces identical output names and no duplicate rows downstream.',
      ],
      crates: ['parquet', 'arrow', 'object_store', 'serde_json'],
      github: [
        { name: 'arrow-rs: Arrow and Parquet implementations', url: 'https://github.com/apache/arrow-rs' },
        { name: 'object_store: one API over S3, GCS, Azure and local files', url: 'https://github.com/apache/arrow-rs-object-store' },
      ],
      pitfall: 'Writing part files with timestamp-based names: a rerun doubles the partition, and downstream aggregates silently count every row twice.',
      resources: [
        { title: 'parquet crate: ArrowWriter and ParquetRecordBatchReaderBuilder', url: 'https://docs.rs/parquet/latest/parquet/', kind: 'docs' },
        { title: 'object_store: conditional puts, multipart upload, retries', url: 'https://docs.rs/object_store/latest/object_store/', kind: 'docs' },
        { title: 'object_store repository: store implementations and examples', url: 'https://github.com/apache/arrow-rs-object-store', kind: 'repo' },
      ],
    },
    {
      id: 'u07',
      n: 7,
      title: 'Observability stack: one trace context across every hop',
      minutes: 100,
      level: 'advanced',
      goal: 'Wire tracing and OTLP export so a single request id links HTTP, SQL, and queue work, and keep metric labels out of the cardinality cliff.',
      sections: [
        {
          h: 'Instrument boundaries, not every function',
          p: [
            'A span should represent a unit of work that can fail or be slow on its own: an inbound request, an outbound call, a query, a job execution. Instrumenting every helper produces a trace so deep that the flame graph is unreadable and the exporter becomes the bottleneck. Three levels usually suffice: request, dependency call, and background job.',
            '`#[tracing::instrument]` captures arguments by Debug by default, which is how secrets and 4 MB payloads end up in your tracing backend. Always `skip` non-primitive arguments and attach the fields you actually query on: `tenant_id`, `route`, `status`, `row_count`. Fields are structured; a formatted string is a field you can never aggregate.',
          ],
          code: `use tracing::{field, info_span, Instrument};

pub async fn handler(
    state: std::sync::Arc<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let route = req.uri().path().to_owned();
    let request_id = req
        .headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("generated")
        .to_owned();

    let span = info_span!(
        "http.request",
        http.method = %req.method(),
        http.route = %route,
        request.id = %request_id,
        http.status_code = field::Empty,
    );

    async move {
        let mut res = next.run(req).await;
        // record the status on the span after the handler returns
        tracing::Span::current().record("http.status_code", res.status().as_u16());
        res.headers_mut()
            .insert("x-request-id", request_id.parse().expect("valid header"));
        res
    }
    .instrument(span)
    .await
}`,
          tip: 'field::Empty declares a field you record later; without it, record() silently does nothing and the trace looks complete but is missing the status.',
        },
        {
          h: 'One provider, batch export, honest sampling',
          p: [
            'The subscriber is a stack of layers over one registry: an `EnvFilter`, a formatting layer for local logs, and an OpenTelemetry layer that exports spans. The tracer provider owns the batch processor and the resource attributes; `service.name` is what makes the backend usable, and `service.version` is what makes a regression attributable to a deploy.',
            'Sampling is where observability budgets are won. Head sampling at 100% is fine for a dev cluster and ruinous at 50k requests per second. `ParentBased(TraceIdRatioBased(0.05))` keeps whole traces intact - a child span never overrides its parent\'s decision - so you get complete traces at 5% instead of a random 5% of spans from every trace.',
          ],
          code: `use opentelemetry::trace::TracerProvider as _;
use opentelemetry_sdk::{trace::{SdkTracerProvider, sampler::Sampler}, Resource};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

pub fn init_tracing() -> anyhow::Result<SdkTracerProvider> {
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_tonic()
        .build()?;

    let provider = SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_sampler(Sampler::ParentBased(Box::new(
            Sampler::TraceIdRatioBased(0.05),
        )))
        .with_resource(
            Resource::builder()
                .with_service_name("orders-api")
                .build(),
        )
        .build();

    let tracer = provider.tracer("orders-api");

    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_opentelemetry::layer().with_tracer(tracer))
        .with(tracing_subscriber::fmt::layer())
        .init();

    Ok(provider)
}

// on shutdown: provider.shutdown()?; then the process exits with the buffer flushed`,
          tip: 'Call provider.shutdown() on SIGTERM. A batch processor that is dropped without flushing loses the last few seconds of spans - exactly the ones around the crash.',
        },
        {
          h: 'Cardinality is the cost axis',
          p: [
            'Metrics are cheap per sample and expensive per unique label set. `tenant_id` and `user_id` as labels multiply every series by your customer count, and a metrics backend bills by active series. Put those in spans, where high cardinality is the point, and keep metric labels to bounded sets: route template (not raw path), status class, method, region.',
            'For each dependency, the useful trio is rate, errors, duration - and duration must be a histogram with buckets chosen from your SLO, not the defaults. A p99 estimated from a histogram whose buckets are 1s, 5s, 10s cannot tell you whether you are at 300 ms or 900 ms, which is precisely the range where the SLO lives.',
          ],
          list: [
            'Labels: route template, method, status class, region - never user or tenant ids',
            'Histogram buckets around the SLO, e.g. 50/100/200/400/800 ms for a 500 ms target',
            'Exemplars link a slow bucket to a concrete trace id; enable them on latency histograms',
            'Log the trace id in every error line so a log search reaches the trace in one hop',
          ],
        },
      ],
      exercise: {
        prompt: 'Add a child span around a Postgres query that records the table, the row count, and the error, and make sure the span is a child of the HTTP span.',
        starter: `pub async fn get_order(pool: &sqlx::PgPool, id: uuid::Uuid) -> anyhow::Result<Order> {
    // TODO: child span "db.query" with db.system, db.table, rows.count
    todo!()
}`,
        hint: 'Create the span with tracing::info_span! and drive the future with .instrument(span), not .enter() around an await; entering a span across an await point corrupts the parent chain on a multi-threaded runtime.',
        solution: `use tracing::{field, info_span, Instrument};

pub async fn get_order(pool: &sqlx::PgPool, id: uuid::Uuid) -> anyhow::Result<Order> {
    let span = info_span!(
        "db.query",
        db.system = "postgresql",
        db.table = "orders",
        db.operation = "SELECT",
        rows.count = field::Empty,
        error.type = field::Empty,
    );

    async {
        let row = sqlx::query_as::<_, Order>(
            "select id, customer_id, total_minor, status from orders where id = $1",
        )
        .bind(id)
        .fetch_optional(pool)
        .await;

        match row {
            Ok(Some(order)) => {
                tracing::Span::current().record("rows.count", 1i64);
                Ok(order)
            }
            Ok(None) => {
                tracing::Span::current().record("rows.count", 0i64);
                anyhow::bail!("order {id} not found")
            }
            Err(e) => {
                let kind = e.as_database_error().map(|d| d.code().unwrap_or_default().to_string());
                tracing::Span::current().record("error.type", kind.as_deref().unwrap_or("unknown"));
                Err(e.into())
            }
        }
    }
    .instrument(span)
    .await
}`,
      },
      questions: [
        {
          q: 'Why prefer Sampler::ParentBased over a plain ratio sampler?',
          options: [
            'It samples faster because it skips the trace id hash',
            'It keeps whole traces together by inheriting the root decision',
            'It guarantees at least one span per trace',
            'It reduces the number of exported attributes',
          ],
          answer: 1,
          explain: 'A plain ratio sampler can keep some spans of a trace and drop others, producing partial traces. ParentBased makes every span follow the root decision, so 5% sampling yields complete traces.',
        },
        {
          q: 'Which label set is safe for a request-rate metric?',
          options: [
            'tenant_id, user_id, route',
            'route template, method, status class',
            'full request path, query string',
            'trace_id, span_id',
          ],
          answer: 1,
          explain: 'Series count multiplies across label values. Route templates and status classes are bounded; ids and raw paths are unbounded and will blow up the series count.',
        },
        {
          q: 'What is lost if you drop a batch span processor without calling shutdown()?',
          options: [
            'Nothing, spans are written synchronously',
            'Spans buffered in the exporter, typically the last few seconds including crash-adjacent ones',
            'The sampler configuration',
            'The resource attributes for all future spans',
          ],
          answer: 1,
          explain: 'BatchSpanProcessor buffers and exports on a timer. Dropping the provider skips the final flush, so the spans most relevant to an incident die with the process.',
        },
      ],
      quickbytes: [
        'Field::Empty then Span::current().record(...) - without the declaration, record is a no-op.',
        'instrument(skip(...)) every non-primitive argument or you will export payloads and secrets.',
        'ParentBased(TraceIdRatioBased(0.05)) gives complete traces at 5%, not 5% of every trace.',
        'Histogram buckets come from the SLO, not from the library defaults.',
      ],
      production: [
        'service.name and service.version are resource attributes, so deploy regressions are attributable.',
        'Provider shutdown is wired into SIGTERM handling and flushes before exit.',
        'No metric label has unbounded cardinality; a CI check greps for id-like label names.',
        'Every error log line carries the trace id and the request id.',
        'Sampling ratio is configurable per environment without a rebuild.',
      ],
      crates: ['tracing', 'tracing-subscriber', 'tracing-opentelemetry', 'opentelemetry-otlp'],
      github: [
        { name: 'tracing - structured diagnostics for Rust', url: 'https://github.com/tokio-rs/tracing' },
        { name: 'opentelemetry-rust - OTLP exporters and SDK', url: 'https://github.com/open-telemetry/opentelemetry-rust' },
      ],
      pitfall: 'Calling span.enter() around an .await: the span stays entered on that thread and unrelated tasks inherit it as their parent, producing traces where every request appears to call every query.',
      resources: [
        { title: 'OpenTelemetry: Rust language documentation', url: 'https://opentelemetry.io/docs/languages/rust/', kind: 'docs' },
        { title: 'tracing crate: spans, fields, and instrument', url: 'https://docs.rs/tracing/latest/tracing/', kind: 'docs' },
        { title: 'tracing-opentelemetry: bridging tracing spans into OTLP', url: 'https://docs.rs/tracing-opentelemetry/latest/tracing_opentelemetry/', kind: 'docs' },
        { title: 'Dapper: Google\'s large-scale distributed systems tracing infrastructure', url: 'https://research.google/pubs/dapper-a-large-scale-distributed-systems-tracing-infrastructure/', kind: 'paper' },
      ],
    },
    {
      id: 'u08',
      n: 8,
      title: 'Kubernetes operator: level-triggered reconcile with status',
      minutes: 120,
      level: 'industry',
      goal: 'Write a CRD and a kube 5 controller whose reconcile is idempotent, reports conditions in status, and converges after crashes instead of only after events.',
      sections: [
        {
          h: 'The CRD is the API you will regret',
          p: [
            'An operator is a control loop over a custom resource, which means the CRD becomes a public API the moment someone writes YAML against it. Split it cleanly: `spec` is what the user wants and is immutable-by-convention, `status` is what the controller observed. Never let the controller write spec - that is how you get a resource that disagrees with itself after a partial failure.',
            'In kube 5 the derive generates the CRD, the `Resource` impl, and the accessors. The `status` argument adds a typed status subresource, which matters: writing status through the subresource does not bump the generation, so a controller does not trigger itself in an infinite reconcile loop.',
          ],
          code: `use kube::CustomResource;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(CustomResource, Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[kube(
    group = "acme.dev",
    version = "v1",
    kind = "Database",
    namespaced,
    status = "DatabaseStatus",
    shortname = "db",
    printcolumn = r#"{"name":"Ready","type":"integer","jsonPath":".status.readyReplicas"}"#
)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSpec {
    /// Engine image to run, e.g. postgres:17.
    pub engine: String,
    /// Desired replica count; the controller owns convergence.
    pub replicas: i32,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStatus {
    pub observed_generation: Option<i64>,
    pub ready_replicas: i32,
    pub message: String,
}`,
          tip: 'Set observedGeneration from metadata.generation in every status write; it is how a client knows whether the status reflects the spec it just applied.',
        },
        {
          h: 'Reconcile from observed state, every time',
          p: [
            'The reconcile function receives an object and must produce the world it describes, using whatever already exists. Do not branch on "was this an add or an update" - kube hands you the object because *something* changed, and after a restart the cache replays everything as an add anyway. Read the child resources, diff against desired, patch if needed.',
            'Return `Action::requeue(duration)` for periodic drift checks and `Action::await_change()` when you only care about spec changes. The error policy gets the failed object and decides the backoff; returning a requeue there instead of panicking is what keeps a bad CR from taking down the controller.',
          ],
          code: `use kube::{
    api::{Api, Patch, PatchParams, ResourceExt},
    runtime::controller::{Action, Controller},
    Resource,
};
use std::sync::Arc;
use std::time::Duration;

pub struct Ctx {
    pub client: kube::Client,
}

async fn reconcile(db: Arc<Database>, ctx: Arc<Ctx>) -> Result<Action, kube::Error> {
    let name = db.name_any();
    let ns = db.namespace().unwrap_or_else(|| "default".to_string());
    let desired = db.spec.replicas;

    let sts: Api<k8s_openapi::api::apps::v1::StatefulSet> =
        Api::namespaced(ctx.client.clone(), &ns);

    match sts.get_opt(&name).await? {
        None => {
            let owner = db.controller_owner_ref(&()).map(|o| vec![o]).unwrap_or_default();
            let sts_obj = build_statefulset(&db, &ns, owner);
            sts.create(&Default::default(), &sts_obj).await?;
        }
        Some(existing) => {
            let current = existing.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
            if current != desired {
                let patch = serde_json::json!({ "spec": { "replicas": desired } });
                sts.patch(&name, &PatchParams::default(), &Patch::Merge(&patch)).await?;
            }
        }
    }

    let status = serde_json::json!({
        "observedGeneration": db.metadata.generation,
        "readyReplicas": desired,
        "message": "converged"
    });
    let dbs: Api<Database> = Api::namespaced(ctx.client.clone(), &ns);
    dbs.patch_status(&name, &PatchParams::default(), &Patch::Merge(&status)).await?;

    Ok(Action::requeue(Duration::from_secs(300)))
}

fn error_policy(_db: Arc<Database>, err: &kube::Error, _ctx: Arc<Ctx>) -> Action {
    tracing::error!(%err, "reconcile failed");
    Action::requeue(Duration::from_secs(15))
}`,
          tip: 'Patch, do not replace. A Merge patch only sends the fields you own, so a GitOps tool that added annotations does not get them stripped.',
        },
        {
          h: 'Ownership, finalizers, and the crash window',
          p: [
            'Set owner references on the children you create so Kubernetes garbage-collects them when the custom resource is deleted. Without it, deleting a Database leaves a StatefulSet whose pods keep consuming storage - and the next apply fails because the name is taken.',
            'A finalizer is the only way to run cleanup before the object disappears, and it introduces a crash window you must design for: add the finalizer *before* creating any external resource, then do cleanup, then remove it. If the operator dies between those steps, the new operator re-reads the object, sees the finalizer, and retries the cleanup - which is why cleanup must be idempotent (delete-if-exists, not delete-and-hope).',
          ],
          list: [
            'Add the finalizer first, remove it last; never the other way round',
            'Children carry controller_owner_ref so deletion cascades',
            'Cleanup steps are idempotent and safe to run twice',
            'A stuck finalizer blocks deletion forever - alert on objects in Terminating older than 30 minutes',
          ],
        },
      ],
      exercise: {
        prompt: 'Change the reconciler so it only patches status when something actually changed, and add an `observedGeneration` guard so a stale status write cannot overwrite a newer one.',
        starter: `async fn reconcile(db: Arc<Database>, ctx: Arc<Ctx>) -> Result<Action, kube::Error> {
    // TODO: compare db.status with desired status before patching
    // TODO: skip the write when observed_generation already matches
    todo!()
}`,
        hint: 'Compare the computed status struct to db.status.as_ref(); if equal, return early. For generation, only write when db.metadata.generation differs from status.observed_generation or another status field changed.',
        solution: `async fn reconcile(db: Arc<Database>, ctx: Arc<Ctx>) -> Result<Action, kube::Error> {
    let ns = db.namespace().unwrap_or_else(|| "default".to_string());
    let desired_status = DatabaseStatus {
        observed_generation: db.metadata.generation,
        ready_replicas: db.spec.replicas,
        message: "converged".to_string(),
    };

    let unchanged = db
        .status
        .as_ref()
        .map(|s| s.observed_generation == desired_status.observed_generation
              && s.ready_replicas == desired_status.ready_replicas
              && s.message == desired_status.message)
        .unwrap_or(false);

    if unchanged {
        return Ok(Action::requeue(Duration::from_secs(300)));
    }

    let dbs: Api<Database> = Api::namespaced(ctx.client.clone(), &ns);
    let patch = serde_json::json!({ "status": desired_status });
    dbs.patch_status(&db.name_any(), &PatchParams::default(), &Patch::Merge(&patch))
        .await?;

    Ok(Action::requeue(Duration::from_secs(300)))
}`,
      },
      questions: [
        {
          q: 'Why does the reconciler read existing children instead of tracking what it created in memory?',
          options: [
            'Because the Kubernetes API forbids caching',
            'Because the process may have restarted and memory says nothing about cluster state',
            'Because reads are cheaper than writes',
            'Because controllers must be stateless by convention only',
          ],
          answer: 1,
          explain: 'Level triggering assumes no memory of past events: the object plus cluster state is the entire input. That is what makes a restart converge instead of re-creating everything.',
        },
        {
          q: 'What is the correct order around a finalizer?',
          options: [
            'Create resources, then add the finalizer, then cleanup',
            'Add the finalizer before creating external resources, remove it after cleanup',
            'Add and remove the finalizer in the same reconcile call',
            'Never add a finalizer; owner references are sufficient',
          ],
          answer: 1,
          explain: 'The finalizer must exist before anything needs cleaning up, or a crash in between leaves resources nothing will delete. Owner references cannot cover resources outside the cluster.',
        },
        {
          q: 'You patch the main resource instead of the status subresource to write status. What is the consequence?',
          options: [
            'The patch is rejected with 422',
            'metadata.generation bumps, so status-only updates look like spec changes',
            'The status fields are silently dropped',
            'The controller loses RBAC access',
          ],
          answer: 1,
          explain: 'Generation increments on spec writes. Writing status through the main resource makes every status update look like a new desired state and can loop the controller.',
        },
      ],
      quickbytes: [
        'One CRD field you cannot explain in one sentence is a field you will support forever - cut it.',
        'Return Action::requeue for drift checks, Action::await_change when only spec edits matter.',
        'Merge patches send only the fields you own; Replace patches delete what you forgot to include.',
        'Alert on objects stuck in Terminating; a broken finalizer blocks deletion indefinitely.',
      ],
      production: [
        'The CRD has a status subresource and the controller writes observedGeneration.',
        'Owner references are set on every child so deletion cascades.',
        'Cleanup is idempotent and tested by killing the controller mid-reconcile.',
        'RBAC is scoped to the exact resource kinds and verbs the controller uses.',
        'The controller exposes reconcile error and duration metrics with alerts on sustained errors.',
      ],
      crates: ['kube', 'k8s-openapi', 'schemars', 'serde_json'],
      github: [{ name: 'kube-rs: Kubernetes client and controller runtime', url: 'https://github.com/kube-rs/kube' }],
      pitfall: 'Storing controller state in a HashMap keyed by object uid: after a restart the map is empty, the controller has no idea what it created, and it either duplicates children or never cleans them up.',
      resources: [
        { title: 'kube crate documentation: CustomResource derive and Client', url: 'https://docs.rs/kube/latest/kube/', kind: 'docs' },
        { title: 'kube::runtime::Controller: reconciler, error policy, Action', url: 'https://docs.rs/kube/latest/kube/runtime/struct.Controller.html', kind: 'docs' },
        { title: 'Kubernetes: operator pattern', url: 'https://kubernetes.io/docs/concepts/extend-kubernetes/operator/', kind: 'docs' },
        { title: 'Kubernetes: custom resource definitions and status subresources', url: 'https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/', kind: 'docs' },
      ],
    },
    {
      id: 'u09',
      n: 9,
      title: 'WASM app: the JS boundary is your performance budget',
      minutes: 95,
      level: 'advanced',
      goal: 'Compile Rust to wasm32 with wasm-bindgen, pass typed arrays instead of strings, and measure the copies that dominate a browser workload.',
      sections: [
        {
          h: 'What the target actually gives you',
          p: [
            '`wasm32-unknown-unknown` produces a module with no operating system: no threads, no filesystem, no clock beyond what JS lends you. wasm-bindgen generates the glue that marshals values across the boundary, and wasm-pack or trunk packages the result for the browser. Rust\'s standard library compiles, but `std::thread`, blocking IO, and `SystemTime::now()` either fail or behave differently.',
            'The brief: a client-side log explorer that parses 50 MB of NDJSON and answers filter queries without uploading anything. The parsing is the win - Rust beats JS at byte-level work - but the naive bridge (one `string` per line) costs more in copies than the parsing saves, which is the whole lesson.',
          ],
          list: [
            'Build with `--release` and `wasm-opt -O3`; debug builds are 5-10x larger',
            'Panics become opaque traps without console_error_panic_hook',
            'No threads means no rayon; structure the work as chunked, resumable passes',
            'Measure with performance.now() around the call, not around the whole page load',
          ],
        },
        {
          h: 'Pass bytes, not strings',
          p: [
            'Every `String` argument is a UTF-8 copy from the JS heap into the WASM linear memory, and every returned `String` is copied back. With 500k log lines that is 500k allocations on each side, and the bridge dominates the profile. Taking `&[u8]` lets wasm-bindgen hand you a view over the JS `Uint8Array` - still a copy into linear memory for the call, but one per batch instead of one per record.',
            'The pattern that actually wins: the JS side owns one big `Uint8Array`, hands it to Rust once per batch, and Rust returns an index into a result buffer rather than a fresh array of objects. For structured results, write into a pre-allocated `Vec<u8>` you expose as a pointer plus length, or return a `js_sys::Uint8Array` view and decode in JS with a DataView.',
          ],
          code: `use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Count log levels in an NDJSON chunk without allocating per line.
/// bytes is a view over the caller's Uint8Array - one copy per call.
#[wasm_bindgen]
pub fn count_levels(bytes: &[u8]) -> u32 {
    let mut errors = 0u32;
    for line in bytes.split(|b| *b == b'\\n') {
        if line.windows(7).any(|w| w == b"\\"level\\"") && line.windows(5).any(|w| w == b"error") {
            errors += 1;
        }
    }
    errors
}

/// Parse in place: the caller reuses the same buffer for the next chunk.
#[wasm_bindgen]
pub fn mask_pii(buf: &mut [u8]) {
    for i in 0..buf.len() {
        if buf[i].is_ascii_digit() && i % 4 == 0 {
            buf[i] = b'x';
        }
    }
}`,
          tip: '&[u8] and &mut [u8] map to Uint8Array parameters - the cheapest useful signature wasm-bindgen offers. Start there.',
        },
        {
          h: 'Async is a JS promise, not a thread',
          p: [
            'There is no blocking in the browser main thread that a user will forgive. `wasm_bindgen_futures::JsFuture` bridges a JS Promise into a Rust future, and `spawn_local` runs a future to completion on the microtask queue. Fetching data, reading a File, or waiting on a Web Worker message all go through that bridge.',
            'Run expensive work in a Worker, not on the main thread, and keep the module boundary coarse: one call per chunk, not one call per record. If you need parallelism, the browser primitive is multiple Workers each with their own WASM instance - shared memory needs cross-origin isolation headers that your deployment may not have.',
          ],
          code: `use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;

#[wasm_bindgen]
pub async fn load_log_file(url: String) -> Result<Vec<u8>, JsValue> {
    let window = web_sys::window().ok_or_else(|| JsValue::from_str("no window"))?;
    let resp_value = JsFuture::from(window.fetch_with_str(&url)).await?;
    let resp: web_sys::Response = resp_value.dyn_into()?;

    if !resp.ok() {
        return Err(JsValue::from_str(&format!("HTTP {}", resp.status())));
    }

    let buf = JsFuture::from(resp.array_buffer()?).await?;
    Ok(js_sys::Uint8Array::new(&buf).to_vec())
}`,
          tip: 'resp.array_buffer() gives one copy of the body into JS memory and to_vec() copies again into WASM memory. For large files, stream chunks and process them per chunk.',
        },
      ],
      exercise: {
        prompt: 'Write a wasm-bindgen function that takes a `Uint8Array` of NDJSON and returns the number of distinct level values it finds, without allocating a String per line.',
        starter: `use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn distinct_levels(bytes: &[u8]) -> u32 {
    // TODO: scan for "level" and collect the following token
    todo!()
}`,
        hint: 'Split on newlines, find the `"level"` key, then take the bytes until the closing quote. Map known levels to a bitmask so the function allocates nothing.',
        solution: `use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn distinct_levels(bytes: &[u8]) -> u32 {
    // bit 0 = debug, 1 = info, 2 = warn, 3 = error
    let mut seen: u32 = 0;

    for line in bytes.split(|b| *b == b'\\n') {
        let Some(pos) = find(line, b"\\"level\\"") else { continue };
        let rest = &line[pos + 7..];
        let Some(colon) = rest.iter().position(|b| *b == b':') else { continue };
        let rest = &rest[colon + 1..];
        let Some(open) = rest.iter().position(|b| *b == b'"') else { continue };
        let rest = &rest[open + 1..];
        let Some(close) = rest.iter().position(|b| *b == b'"') else { continue };
        let level = &rest[..close];

        seen |= match level {
            b"debug" => 1,
            b"info" => 2,
            b"warn" => 4,
            b"error" => 8,
            _ => 0,
        };
    }

    seen.count_ones()
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}`,
      },
      questions: [
        {
          q: 'Why is returning a String per parsed record slower than returning a Uint8Array view?',
          options: [
            'Strings are UTF-16 in JS and UTF-8 in Rust, so each record costs two conversions and two allocations',
            'wasm-bindgen cannot return strings at all',
            'Strings are immutable and must be copied on read',
            'Uint8Array is stored outside the WASM linear memory',
          ],
          answer: 0,
          explain: 'Every String crossing the boundary is encoded, copied, and allocated on both sides. For hundreds of thousands of records that bridge dominates; batching into one byte buffer amortizes it.',
        },
        {
          q: 'What does `#[wasm_bindgen(start)]` do?',
          options: [
            'Runs the function when the module is instantiated',
            'Marks the entry point for wasm-opt',
            'Runs the function before every exported call',
            'Registers a Web Worker',
          ],
          answer: 0,
          explain: 'It becomes the module start hook, which is exactly the right place to install a panic hook and a logger once per instance.',
        },
        {
          q: 'A CPU-heavy function freezes the tab. What is the browser-native fix?',
          options: [
            'Increase the WASM memory maximum',
            'Build with -C target-feature=+simd128',
            'Move the work into a Web Worker with its own WASM instance',
            'Call the function inside requestAnimationFrame',
          ],
          answer: 2,
          explain: 'The main thread is shared with rendering. Workers are the only real parallelism the browser offers, and cross-origin isolation is not required unless you need SharedArrayBuffer.',
        },
      ],
      quickbytes: [
        'Signature `fn f(&[u8])` or `fn f(&mut [u8])` beats String in and out for any hot path.',
        'console_error_panic_hook::set_once() in a #[wasm_bindgen(start)] function - always.',
        'Ship release + wasm-opt; unoptimized builds are commonly 5-10x the size.',
        'Verify with performance.now() before and after the call, not with page load time.',
      ],
      production: [
        'Panic hook installed and a global error handler reports traps to telemetry.',
        'The module is built in release with wasm-opt and the size is tracked per commit.',
        'Heavy work runs in a Worker; the main thread never blocks longer than a frame.',
        'Cross-origin headers are only required if SharedArrayBuffer is actually used.',
        'A benchmark asserts the JS/WASM copy time is a minority of total call time.',
      ],
      crates: ['wasm-bindgen', 'web-sys', 'js-sys', 'wasm-bindgen-futures'],
      github: [{ name: 'wasm-bindgen: bindings and JS glue generation', url: 'https://github.com/wasm-bindgen/wasm-bindgen' }],
      pitfall: 'Exposing a struct per record through wasm-bindgen: each field access becomes a JS property lookup through generated getters, and a 100k-row table takes seconds to render.',
      resources: [
        { title: 'wasm-bindgen guide: types, async, and the JS boundary', url: 'https://wasm-bindgen.github.io/wasm-bindgen/', kind: 'docs' },
        { title: 'wasm-bindgen crate documentation', url: 'https://docs.rs/wasm-bindgen/latest/wasm_bindgen/', kind: 'docs' },
        { title: 'WebAssembly: specifications and use cases', url: 'https://webassembly.org/', kind: 'docs' },
        { title: 'Not So Fast: Analyzing the Performance of WebAssembly vs. Native Code (USENIX ATC 2019)', url: 'https://www.usenix.org/conference/atc19/presentation/jangda', kind: 'paper' },
      ],
    },
    {
      id: 'u10',
      n: 10,
      title: 'Embedded firmware: static tasks and bounded channels',
      minutes: 110,
      level: 'advanced',
      goal: 'Structure firmware as embassy tasks with statically allocated memory, communicate through fixed-capacity channels, and keep the watchdog fed without allocating.',
      sections: [
        {
          h: 'The executor fits in the interrupt budget',
          p: [
            'On a Cortex-M part you have tens of kilobytes of RAM and no allocator you want in the hot path. Embassy\'s executor is built for that: tasks are declared at compile time, each gets a `static` sized by the compiler, and the linker errors if the sum does not fit. There is no heap, no task spawn at runtime, and therefore no out-of-memory panic at 3 a.m.',
            '`#[embassy_executor::main]` creates the executor and hands you a `Spawner`. `spawner.spawn(task())` returns a `Result` because a task can only run once unless you declare `pool_size`; calling it twice with the same static is a runtime error you must handle, not ignore. Everything else - the HAL, the clock configuration - is board-specific, which is exactly the part you should keep behind a thin crate boundary.',
          ],
          code: `#![no_std]
#![no_main]

use embassy_executor::Spawner;
use embassy_time::{Duration, Timer};
use defmt::*;
use defmt_rtt as _;
use panic_probe as _;

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    let board = board::init();          // thin, board-specific HAL crate
    info!("firmware {} booting", env!("CARGO_PKG_VERSION"));

    // a task static can only be spawned once; the Result is not optional
    spawner.spawn(sampler(board.sensor)).unwrap();
    spawner.spawn(uplink(board.radio)).unwrap();

    watchdog::start(Duration::from_secs(8));
    loop {
        Timer::after_secs(1).await;
        watchdog::feed();
    }
}`,
          tip: 'Return the error from spawn instead of unwrapping in production: a double spawn becomes a logged fault rather than a silent reset loop.',
        },
        {
          h: 'Channels instead of shared mutability',
          p: [
            'The tempting design is a `static mut` counter guarded by an interrupt-free section, which works until someone adds a second reader. Embassy gives you `embassy_sync::channel::Channel` with a compile-time capacity: `try_send` never blocks and never allocates, and a full channel returns an error you must decide about. That decision - drop the sample, overwrite the oldest, or apply backpressure - is the actual firmware design.',
            'For a sensor loop the honest policy is usually "drop and count": a stale sample is worse than a missing one for a control loop. For commands the policy is the opposite: never drop, and let the producer wait on `send().await`. Same primitive, different capacity and different failure policy, and both are visible in the type.',
          ],
          code: `use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::channel::Channel;
use embassy_time::{Duration, Timer};

#[derive(Clone, Copy, defmt::Format)]
pub struct Sample {
    pub millivolts: u16,
    pub ticks: u32,
}

// capacity is a const generic: memory is reserved at link time
static SAMPLES: Channel<CriticalSectionRawMutex, Sample, 16> = Channel::new();
static DROPPED: core::sync::atomic::AtomicU32 = core::sync::atomic::AtomicU32::new(0);

#[embassy_executor::task]
async fn sampler(mut sensor: board::Sensor) {
    let mut ticks = 0u32;
    loop {
        let millivolts = sensor.read_millivolts().await;
        let sample = Sample { millivolts, ticks };
        ticks = ticks.wrapping_add(1);

        if SAMPLES.try_send(sample).is_err() {
            // the consumer is slower than the sensor: record it, do not block
            DROPPED.fetch_add(1, core::sync::atomic::Ordering::Relaxed);
        }

        Timer::after_millis(100).await;
    }
}`,
          tip: '`try_send` is the right default in an interrupt-driven loop: awaiting a full channel stalls sampling, which is usually worse than losing a sample.',
        },
        {
          h: 'Time, watchdogs, and the cost of logging',
          p: [
            '`embassy_time::Timer` is driven by a hardware tick, and `Timer::after(Duration::from_millis(100))` suspends the task rather than spinning. Durations are computed at runtime; `after_millis` is a convenience wrapper. If your tick rate is 1 kHz, nothing below 1 ms is meaningful, and a `Timer::after_micros(100)` silently rounds to the next tick.',
            'Watchdogs punish the wrong thing. A hardware watchdog fed by a timer interrupt keeps resetting a firmware whose main loop is deadlocked; feed it from the task that must make progress, and only after the work completed. `defmt` logging is cheap compared to `core::fmt`, but each string still costs flash and microseconds - log state transitions, not every loop iteration.',
          ],
          list: [
            'Feed the watchdog from the task that proves liveness, after its work completes',
            'defmt over core::fmt: deferred formatting keeps strings in flash, not RAM',
            'A 1 kHz tick makes sub-millisecond timers meaningless - check the tick rate first',
            'Instrument stack high-water marks in a debug build; the linker does not catch overflow',
          ],
        },
      ],
      exercise: {
        prompt: 'Add a command channel that must never drop messages: an uplink task reads commands from a `Channel` with capacity 4 and calls `send().await` so the producer waits instead of losing data.',
        starter: `use embassy_sync::channel::Channel;
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;

pub enum Command { Transmit, Sleep }

static COMMANDS: Channel<CriticalSectionRawMutex, Command, 4> = Channel::new();

#[embassy_executor::task]
async fn uplink(radio: board::Radio) {
    // TODO: receive forever, handle each command
    todo!()
}`,
        hint: 'Use `COMMANDS.receiver()` inside the task and `receiver().send(cmd).await` from producers. Receiver is not Sync-shared; create it once inside the consuming task.',
        solution: `use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::channel::Channel;

pub enum Command {
    Transmit,
    Sleep,
}

static COMMANDS: Channel<CriticalSectionRawMutex, Command, 4> = Channel::new();

#[embassy_executor::task]
async fn uplink(mut radio: board::Radio) {
    let rx = COMMANDS.receiver();

    loop {
        match rx.receive().await {
            Command::Transmit => radio.transmit(b"ping").await,
            Command::Sleep => radio.sleep().await,
        }
    }
}

// producer side: never drops, waits for room
async fn request_transmit() {
    COMMANDS.sender().send(Command::Transmit).await;
}`,
      },
      questions: [
        {
          q: 'What happens if you spawn the same `#[embassy_executor::task]` twice without pool_size?',
          options: [
            'A second task is allocated on the heap',
            'spawn returns an error, because its static is already in use',
            'The linker rejects the firmware at build time',
            'The second spawn silently replaces the first task',
          ],
          answer: 1,
          explain: 'Each task owns one static future slot. Without pool_size the slot is exclusive, so the second spawn fails at runtime - which is why the Result should be handled.',
        },
        {
          q: 'A control loop must never act on stale sensor data. Which channel policy fits?',
          options: [
            'An unbounded queue so nothing is ever lost',
            'A small bounded channel with try_send, counting drops',
            'A blocking send so the producer waits for the consumer',
            'A static mut shared between the tasks',
          ],
          answer: 1,
          explain: 'Waiting stalls sampling and unbounded queues do not exist without a heap. Dropping the sample and counting it keeps the loop on schedule and makes the overload visible.',
        },
        {
          q: 'Why feed the hardware watchdog from a task rather than from a timer interrupt?',
          options: [
            'Interrupts cannot access the watchdog register',
            'A timer keeps feeding it even when the main logic is deadlocked',
            'Task context has higher priority than interrupts',
            'The watchdog requires an async API',
          ],
          answer: 1,
          explain: 'A watchdog fed by an independent timer measures the timer, not your program. Feeding it after real work completes makes a hung task produce a reset instead of a silent freeze.',
        },
      ],
      quickbytes: [
        'Tasks are statically allocated; the linker tells you when they do not fit, not the runtime.',
        'try_send + a drop counter beats a blocking send in any sampling loop.',
        'Check the tick rate before writing a sub-millisecond timer.',
        'defmt for logs: formats are deferred, so format strings live in flash.',
      ],
      production: [
        'Every spawn Result is handled and logged with defmt rather than unwrapped.',
        'Watchdog feeding is tied to completed work in the task that must make progress.',
        'Channel capacities are documented with the producer rate and consumer rate that justify them.',
        'Stack high-water marks are measured in CI on a debug build of the firmware.',
        'Panic handler writes a fault record to non-volatile memory before reset.',
      ],
      crates: ['embassy-executor', 'embassy-time', 'embassy-sync', 'defmt'],
      github: [{ name: 'embassy: async executor and HALs for embedded Rust', url: 'https://github.com/embassy-rs/embassy' }],
      pitfall: 'A `static mut` counter touched from both a task and an interrupt handler: it compiles, and it corrupts on the first preemption that lands between the read and the write.',
      resources: [
        { title: 'embassy-executor: tasks, spawner, static allocation', url: 'https://docs.rs/embassy-executor/latest/embassy_executor/', kind: 'docs' },
        { title: 'embassy-time: Timer, Duration, and tick rate', url: 'https://docs.rs/embassy-time/latest/embassy_time/', kind: 'docs' },
        { title: 'Embassy book and HAL documentation', url: 'https://docs.embassy.dev/embassy-executor/git/cortex-m/index.html', kind: 'docs' },
        { title: 'embassy repository: examples per board and chip family', url: 'https://github.com/embassy-rs/embassy', kind: 'repo' },
      ],
    },
    {
      id: 'u11',
      n: 11,
      title: 'ML inference server: batching, queueing, and cancellation',
      minutes: 120,
      level: 'industry',
      goal: 'Turn per-request inference into a bounded, time-limited batch queue and cancel work whose caller has already gone away.',
      sections: [
        {
          h: 'One request per forward pass wastes the hardware',
          p: [
            'A transformer forward pass has fixed overhead that dominates at batch size one: kernel launches, weight reads, and memory traffic that would be shared. Serving one request at a time leaves the accelerator busy a fraction of the time. The fix is not "bigger batches" - it is a queue with a *time* bound, so a request waits at most N milliseconds for company and then runs alone if it must.',
            'The two knobs are max batch size and max wait. Max batch size is bounded by memory (attention is quadratic in sequence length, so long prompts shrink the batch); max wait is bounded by your latency SLO. Write both into the config with the arithmetic that produced them, because the next person will otherwise set max wait to a second and wonder why p99 tripled.',
          ],
          code: `use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

pub struct Job {
    pub prompt: Vec<u32>,
    pub max_new_tokens: usize,
    pub reply: oneshot::Sender<anyhow::Result<Vec<u32>>>,
}

pub async fn batcher(
    model: std::sync::Arc<Model>,
    mut rx: mpsc::Receiver<Job>,
    max_batch: usize,
    max_wait: Duration,
) {
    while let Some(first) = rx.recv().await {
        let mut batch = vec![first];
        let deadline = Instant::now() + max_wait;

        while batch.len() < max_batch {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Some(job)) => batch.push(job),
                Ok(None) => break,   // channel closed, drain what we have
                Err(_) => break,     // max_wait elapsed: do not hold the batch longer
            }
        }

        // drop jobs whose caller disconnected before we spent compute on them
        batch.retain(|job| !job.reply.is_closed());

        if let Err(err) = model.run_batch(&mut batch).await {
            tracing::error!(%err, size = batch.len(), "batch failed");
        }
    }
}`,
          tip: 'Check reply.is_closed() before the forward pass, not after: it is the cheapest cancellation signal you will get for free.',
        },
        {
          h: 'Load the weights once, and know what unsafe means here',
          p: [
            'Model loading is a startup cost and a memory decision. `VarBuilder::from_mmaped_safetensors` maps the file instead of reading it, so RSS grows with what is touched rather than with file size, and several processes can share the page cache. It is `unsafe` because the mapping is read-only by contract: if another process truncates or rewrites the file, the mapped pages become invalid and you get SIGBUS, not a Rust error.',
            'Do the warmup forward pass at startup, before readiness flips. The first inference pays for lazy kernel initialisation and page faults, and a load balancer that starts sending traffic one second after the socket opens will attribute that cost to a real user. Tokenizers are similarly stateful: load once, and cap `max_new_tokens` so a single request cannot occupy a worker for minutes.',
          ],
          code: `use candle_core::{DType, Device};
use candle_nn::VarBuilder;

pub fn load_model(dir: &std::path::Path) -> anyhow::Result<Model> {
    let device = Device::Cpu; // or Device::new_cuda(0)? on a GPU host
    let files: Vec<std::path::PathBuf> = vec![dir.join("model.safetensors")];

    // Safety: the safetensors files are immutable for the life of the process.
    // Replacing a model means deploying a new process, never overwriting in place.
    let vb = unsafe {
        VarBuilder::from_mmaped_safetensors(&files, DType::F32, &device)?
    };

    let model = Model::load(vb, &Config::default())?;

    // pay the first-pass cost before readiness flips
    let _ = model.forward(&[1u32], 1)?;
    Ok(model)
}`,
          tip: 'Deploy new weights as a new process with a new path. Overwriting a mapped safetensors file is the one change that turns a hot reload into a SIGBUS.',
        },
        {
          h: 'Backpressure is a queue length, not a promise',
          p: [
            'The queue between HTTP and the batcher is the only place you can absorb a burst, and it is bounded for a reason. When it fills, the correct answer is 503 with Retry-After, not an unbounded channel that grows until the process is killed. The admission decision should be made in microseconds: if the queue is at capacity, reject before parsing the prompt or allocating a KV cache.',
            'Long prompts are the fairness problem. A 32k-token request occupies a batch slot that could have served a hundred short ones, so either token-bucket by prompt length, or reserve capacity separately for long and short queues. Either way, per-tenant quotas stop one customer from consuming the whole queue - the same noisy-neighbour logic as any multi-tenant system, with a GPU as the shared resource.',
          ],
          list: [
            'Bounded queue; reject at capacity with 503 and Retry-After',
            'Cap max_new_tokens per request and per tenant',
            'Queue by prompt token count, not request count, when latency is the SLO',
            'Report queue wait time separately from inference time in the trace',
          ],
        },
      ],
      exercise: {
        prompt: 'Add per-tenant admission: at most N queued jobs per tenant, and requests beyond that get a 429 with a Retry-After header. Keep the batcher unchanged.',
        starter: `pub async fn submit(
    state: Arc<AppState>,
    tenant: TenantId,
    body: GenerateRequest,
) -> Result<Response, ApiError> {
    // TODO: per-tenant counter, decrement when the job finishes
    todo!()
}`,
        hint: 'Use an Arc<AtomicUsize> per tenant in a DashMap, and a guard struct that decrements in Drop so an early return cannot leak the slot.',
        solution: `use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use axum::{http::{header, StatusCode}, response::{IntoResponse, Response}, Json};

pub struct Permit {
    counter: Arc<AtomicUsize>,
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::AcqRel);
    }
}

pub async fn submit(
    state: Arc<AppState>,
    tenant: TenantId,
    body: GenerateRequest,
) -> Result<Response, ApiError> {
    const MAX_QUEUED_PER_TENANT: usize = 8;

    let counter = state.tenant_queue.entry(tenant).or_default().clone();
    let queued = counter.fetch_add(1, Ordering::AcqRel) + 1;
    if queued > MAX_QUEUED_PER_TENANT {
        counter.fetch_sub(1, Ordering::AcqRel);
        return Ok((
            StatusCode::TOO_MANY_REQUESTS,
            [(header::RETRY_AFTER, "1")],
            Json(serde_json::json!({ "error": "queue full for tenant" })),
        )
            .into_response());
    }

    let permit = Permit { counter };
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.jobs.send(Job { prompt: body.prompt, max_new_tokens: body.max_new_tokens, reply: tx })
        .await
        .map_err(|_| ApiError::unavailable("inference queue closed"))?;

    let tokens = rx.await.map_err(|_| ApiError::unavailable("inference cancelled"))??;
    drop(permit);

    Ok(Json(serde_json::json!({ "tokens": tokens })).into_response())
}`,
      },
      questions: [
        {
          q: 'Why does a batch of 8 requests cost far less than 8x a single request?',
          options: [
            'Because the tokenizer caches results across requests',
            'Because per-pass overhead (weight reads, kernel launches) is amortized across the batch',
            'Because attention is linear in batch size',
            'Because the HTTP layer coalesces responses',
          ],
          answer: 1,
          explain: 'Fixed per-pass costs dominate at batch one. Batching shares them, so throughput rises until memory bandwidth or KV-cache capacity becomes the limit.',
        },
        {
          q: 'What is the risk of VarBuilder::from_mmaped_safetensors being unsafe?',
          options: [
            'The weights may be silently converted to f16',
            'Another process can modify or truncate the file, invalidating the mapping',
            'It requires a CUDA device to be present',
            'It allocates twice the model size in RAM',
          ],
          answer: 1,
          explain: 'The mapping assumes the file is immutable. Truncation or in-place rewrite makes pages invalid and the process dies with SIGBUS rather than a Rust error.',
        },
        {
          q: 'The inference queue is full. Which response is correct?',
          options: [
            'Block the request until a slot frees up',
            'Grow the channel and accept the memory increase',
            'Return 503 with Retry-After so the client backs off',
            'Drop the request silently and return 200 with empty tokens',
          ],
          answer: 2,
          explain: 'Bounded queues exist to make overload visible. Blocking turns overload into a timeout storm; growing the channel moves the failure to the OOM killer.',
        },
      ],
      quickbytes: [
        'Batch with a max_wait deadline; never wait indefinitely for a full batch.',
        'reply.is_closed() is a free cancellation check before expensive work.',
        'Warm up with one forward pass before the readiness probe can succeed.',
        'Reject at queue capacity with 503 and Retry-After; measure queue wait separately from inference.',
      ],
      production: [
        'Queue capacity is explicit, and overload returns 503 with Retry-After rather than growing.',
        'Per-tenant quotas bound how much of the queue one customer can occupy.',
        'Model files are immutable per process; weights are replaced by a new deployment.',
        'Traces separate queue wait, prefill, and decode time.',
        'A load test reports tokens/second and p99 latency at 1, 4, and 16 concurrent clients.',
      ],
      crates: ['candle-core', 'candle-nn', 'axum', 'tokio'],
      github: [
        { name: 'candle: minimal ML framework for Rust', url: 'https://github.com/huggingface/candle' },
        { name: 'tokenizers: fast text tokenization', url: 'https://github.com/huggingface/tokenizers' },
      ],
      pitfall: 'An unbounded mpsc queue between HTTP and the model: a traffic spike turns into a multi-gigabyte backlog of prompts, and latency grows until the process is OOM-killed mid-batch.',
      resources: [
        { title: 'candle-core: tensors, devices, and dtypes', url: 'https://docs.rs/candle-core/latest/candle_core/', kind: 'docs' },
        { title: 'candle-nn: VarBuilder and safetensors loading', url: 'https://docs.rs/candle-nn/latest/candle_nn/', kind: 'docs' },
        { title: 'Efficient Memory Management for LLM Serving with PagedAttention', url: 'https://arxiv.org/abs/2309.06180', kind: 'paper' },
        { title: 'candle repository: model examples and benchmarks', url: 'https://github.com/huggingface/candle', kind: 'repo' },
      ],
    },
    {
      id: 'u12',
      n: 12,
      title: 'Event-sourced app: optimistic concurrency on an append-only log',
      minutes: 105,
      level: 'advanced',
      goal: 'Append events with an expected version, let a unique key reject concurrent writers, and build read models that can be rebuilt from the log.',
      sections: [
        {
          h: 'The log is the source of truth',
          p: [
            'In an event-sourced system the current state is a fold over events, and the events table is the only thing you cannot regenerate. That changes what "backup" and "migration" mean: you back up the log, and every read model is a cache with a checkpoint. If a projection is wrong, you fix the code and replay - not write a data-patching script.',
            'The schema is deliberately boring: aggregate id, sequence number, event type, payload, timestamp. The primary key on `(aggregate_id, seq)` is doing three jobs at once - ordering, uniqueness, and the concurrency check. Payloads are JSON or a binary format, and they must be versioned from day one, because the events you write today will be replayed by code you write in three years.',
          ],
          code: `create table events (
    aggregate_id uuid        not null,
    seq          bigint      not null,
    event_type   text        not null,
    payload      jsonb       not null,
    metadata     jsonb       not null default '{}'::jsonb,
    recorded_at  timestamptz not null default now(),
    primary key (aggregate_id, seq)
);

create table snapshots (
    aggregate_id uuid        not null,
    seq          bigint      not null,
    state        jsonb       not null,
    taken_at     timestamptz not null default now(),
    primary key (aggregate_id, seq)
);

create table projection_checkpoints (
    name     text   primary key,
    last_seq bigint not null default 0
);`,
          tip: 'Never update or delete a row in events. Correcting a mistake means appending a compensating event, which keeps the audit trail honest.',
        },
        {
          h: 'The unique key is the concurrency control',
          p: [
            'Two commands for the same aggregate can arrive simultaneously - two browsers, a retry, a stuck queue. Each handler loads the aggregate at version N, decides, and appends at N+1. If both try N+1, the second insert violates the primary key. That violation *is* the optimistic concurrency check: no SELECT FOR UPDATE, no lock held across your decision logic, no distributed mutex.',
            'The handler must treat the violation as a conflict, reload, re-run the decision against fresh state, and retry a bounded number of times. This is why domain rules should be pure functions of (state, command) -> events: replaying the decision after a reload must be deterministic, or the retry produces a different answer each time.',
          ],
          code: `use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum AppendError {
    #[error("version conflict at {0}, reload and retry")]
    Conflict(i64),
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

pub async fn append(
    pool: &PgPool,
    aggregate: Uuid,
    expected: i64,                       // version the handler decided against
    events: &[(String, serde_json::Value)],
) -> Result<i64, AppendError> {
    let mut tx = pool.begin().await?;
    let mut seq = expected;

    for (kind, payload) in events {
        seq += 1;
        let result = sqlx::query(
            "insert into events (aggregate_id, seq, event_type, payload)
             values ($1, $2, $3, $4)",
        )
        .bind(aggregate)
        .bind(seq)
        .bind(kind)
        .bind(payload)
        .execute(&mut *tx)
        .await;

        match result {
            Ok(_) => {}
            Err(sqlx::Error::Database(db)) if db.code().as_deref() == Some("23505") => {
                return Err(AppendError::Conflict(expected)); // tx dropped = rollback
            }
            Err(e) => return Err(AppendError::Db(e)),
        }
    }

    tx.commit().await?;
    Ok(seq)
}`,
          tip: 'Dropping the transaction rolls it back, so an early return on conflict leaves no partial batch - one command appends all its events or none.',
        },
        {
          h: 'Projections: idempotent, checkpointed, replayable',
          p: [
            'A projection reads events in global order and updates a table. It must be idempotent because it will process an event twice: after a crash between the write and the checkpoint, on a rebuild, or when you run a new version beside the old one. The cheap trick is to store the last applied seq per row and use `on conflict ... where excluded.seq > target.seq`.',
            'Snapshots bound replay time. Fold every event for an aggregate with ten thousand events is slow on every command; fold from the snapshot plus the tail instead. Snapshots are disposable - deleting them only costs latency - which is a good property to keep, because it means an incorrect snapshot is a rebuild rather than an incident.',
          ],
          code: `-- idempotent projection update: re-delivery cannot double-apply
insert into orders_read (id, customer_id, total_minor, status, last_seq)
values ($1, $2, $3, $4, $5)
on conflict (id) do update
set customer_id = excluded.customer_id,
    total_minor = excluded.total_minor,
    status      = excluded.status,
    last_seq    = excluded.last_seq
where excluded.last_seq > orders_read.last_seq;

-- advance the checkpoint in the same transaction as the row change
update projection_checkpoints
set last_seq = $1
where name = 'orders_read' and last_seq < $1;`,
          tip: 'Advance the checkpoint in the same transaction as the projection write; a checkpoint ahead of the data silently skips events forever.',
        },
      ],
      exercise: {
        prompt: 'Write a `decide` function that is pure - (state, command) -> Result<Vec<Event>, DomainError> - and a command handler that retries up to three times on conflict, reloading state each time.',
        starter: `pub async fn handle(
    pool: &PgPool,
    id: Uuid,
    cmd: Command,
) -> Result<(), Box<dyn std::error::Error>> {
    // TODO: load, decide, append; retry on AppendError::Conflict
    todo!()
}`,
        hint: 'Loop 0..3: load the aggregate and its version, call decide, append with expected version. On Conflict, continue; on success, return. After the loop, surface a conflict error.',
        solution: `use uuid::Uuid;

pub fn decide(state: &Order, cmd: &Command) -> Result<Vec<Event>, DomainError> {
    match cmd {
        Command::Place { items } if state.status != Status::Draft => {
            Err(DomainError::AlreadyPlaced)
        }
        Command::Place { items } if items.is_empty() => Err(DomainError::EmptyOrder),
        Command::Place { items } => Ok(vec![Event::Placed { items: items.clone() }]),
        Command::Cancel if state.status == Status::Shipped => Err(DomainError::AlreadyShipped),
        Command::Cancel => Ok(vec![Event::Cancelled]),
    }
}

pub async fn handle(
    pool: &sqlx::PgPool,
    id: Uuid,
    cmd: Command,
) -> Result<(), Box<dyn std::error::Error>> {
    for _attempt in 0..3 {
        let (state, version) = load(pool, id).await?;
        let events = decide(&state, &cmd)?;
        if events.is_empty() {
            return Ok(());
        }

        let payloads: Vec<(String, serde_json::Value)> = events
            .iter()
            .map(|e| (e.kind().to_string(), serde_json::to_value(e).unwrap()))
            .collect();

        match append(pool, id, version, &payloads).await {
            Ok(_) => return Ok(()),
            Err(AppendError::Conflict(_)) => continue, // reload and decide again
            Err(e) => return Err(e.into()),
        }
    }

    Err("too many concurrent modifications on this aggregate".into())
}`,
      },
      questions: [
        {
          q: 'What role does the primary key on (aggregate_id, seq) play?',
          options: [
            'It only speeds up reads of a single aggregate',
            'It orders events and rejects a concurrent writer that tries the same next sequence',
            'It deduplicates identical payloads across aggregates',
            'It enforces the event schema version',
          ],
          answer: 1,
          explain: 'The second writer to claim sequence N+1 violates the key, which surfaces as a conflict. That is optimistic concurrency without holding a lock across the decision.',
        },
        {
          q: 'Why must projections be idempotent?',
          options: [
            'Because the event store may reorder events',
            'Because an event can be re-delivered after a crash or during a rebuild',
            'Because SQL does not support transactions on read models',
            'Because checkpoints are optional',
          ],
          answer: 1,
          explain: 'Delivery is at-least-once: a crash between the row write and the checkpoint replays events. Recording last_seq per row and comparing it makes replays harmless.',
        },
        {
          q: 'A snapshot turns out to be wrong. What is the correct response?',
          options: [
            'Update the snapshot rows in place to the corrected values',
            'Delete the snapshot and rebuild it by folding the events',
            'Rewrite the events that produced it',
            'Ignore it; snapshots are only a cache for reads',
          ],
          answer: 1,
          explain: 'Snapshots are derived data. Rebuilding from the log is safe precisely because the log is the source of truth and events are immutable.',
        },
      ],
      quickbytes: [
        'Append with an expected version; the primary key turns a race into a retryable conflict.',
        'One command, one transaction: all its events commit together or none do.',
        'Projection row and checkpoint advance in the same transaction.',
        'Version event payloads now; replaying three-year-old events is the normal case.',
      ],
      production: [
        'Events are append-only; corrections are compensating events, never updates.',
        'Every event type carries a schema version and an upcaster for the previous one.',
        'Projections are rebuildable from zero and the rebuild time is measured.',
        'Snapshots are written every N events and can be deleted without data loss.',
        'Conflict retries are bounded and counted as a metric; sustained conflicts indicate hot aggregates.',
      ],
      crates: ['sqlx', 'serde_json', 'uuid', 'thiserror'],
      github: [
        { name: 'cqrs: CQRS and event sourcing building blocks in Rust', url: 'https://github.com/serverlesstechnology/cqrs' },
        { name: 'sqlx - async SQL with compile-time checked queries', url: 'https://github.com/transact-rs/sqlx' },
      ],
      pitfall: 'Persisting the aggregate in its current-state form instead of appending events: you lose the history the whole design exists to provide, and there is no way to rebuild a projection.',
      resources: [
        { title: 'PostgreSQL: SELECT and row-level locking semantics', url: 'https://www.postgresql.org/docs/current/sql-select.html', kind: 'docs' },
        { title: 'sqlx crate documentation: transactions and query macros', url: 'https://docs.rs/sqlx/latest/sqlx/', kind: 'docs' },
        { title: 'cqrs-es repository: aggregate, store, and query abstractions', url: 'https://github.com/serverlesstechnology/cqrs', kind: 'repo' },
        { title: 'Kafka documentation: the log as a durable ordered substrate', url: 'https://kafka.apache.org/documentation/', kind: 'docs' },
      ],
    },
    {
      id: 'u13',
      n: 13,
      title: 'Multi-tenant SaaS: isolation enforced by Postgres, not by discipline',
      minutes: 110,
      level: 'industry',
      goal: 'Derive the tenant from a verified token, set it on the transaction, and let row-level security make cross-tenant reads impossible even when a query forgets a filter.',
      sections: [
        {
          h: 'Tenant identity comes from the token, never the body',
          p: [
            'Every cross-tenant data leak starts the same way: a `tenant_id` field that the client controls. The tenant must be a claim inside a signed token, verified by middleware, and placed in request extensions as a typed `TenantId` that handlers cannot fabricate. If a handler also accepts a tenant in the body, two sources of truth exist and one of them is attacker-controlled.',
            'The SaaS brief: a project tracker where one deployment serves many customers. Shared tables are the right default - separate databases per tenant only pay off at hundreds of tenants with compliance requirements - but shared tables mean every query is a potential leak, so the filter cannot be a code review convention. It has to be a database policy.',
          ],
          code: `use axum::{extract::FromRequestParts, http::{request::Parts, StatusCode}};

#[derive(Clone, Copy, Debug)]
pub struct TenantId(pub uuid::Uuid);

impl<S: Send + Sync> FromRequestParts<S> for TenantId {
    type Rejection = StatusCode;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        // set by the auth middleware after verifying the JWT signature
        parts
            .extensions
            .get::<TenantId>()
            .copied()
            .ok_or(StatusCode::UNAUTHORIZED)
    }
}

async fn list_projects(
    tenant: TenantId,
    axum::extract::State(state): axum::extract::State<std::sync::Arc<AppState>>,
) -> Result<axum::Json<Vec<Project>>, ApiError> {
    // no tenant_id in the query: the policy supplies it
    let mut tx = tenant_tx(&state.pool, tenant).await?;
    let rows = sqlx::query_as::<_, Project>("select id, name from projects order by name")
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(axum::Json(rows))
}`,
          tip: 'Make TenantId a newtype, not a bare Uuid: a function that takes TenantId cannot be called with a user id by accident.',
        },
        {
          h: 'SET LOCAL is the only safe place for the tenant',
          p: [
            'Row-level security compares a row column against a session setting. Setting it with `SET` on a pooled connection is a disaster: the connection returns to the pool carrying tenant A\'s identity, and the next request from tenant B inherits it. `SET LOCAL` (or `set_config(..., true)`) is transaction-scoped, so the value disappears at commit or rollback - which means every tenant-scoped query must run inside a transaction.',
            'The policy needs `current_setting(\'app.tenant_id\', true)` - the `true` makes it return NULL instead of erroring when unset - and NULL comparison yields no rows, which is the safe default. Add `FORCE ROW LEVEL SECURITY` so the table owner is subject to the policy too; otherwise your migration role and any script connecting as owner bypass isolation entirely.',
          ],
          code: `create table projects (
    id        uuid primary key,
    tenant_id uuid not null,
    name      text not null,
    unique (tenant_id, name)
);

alter table projects enable row level security;
alter table projects force row level security;   -- applies to the owner too

create policy tenant_isolation on projects
    using (tenant_id = current_setting('app.tenant_id', true)::uuid)
    with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- the application role is not the table owner and has no BYPASSRLS
create role app_rw login password '...' noinherit;
grant select, insert, update, delete on projects to app_rw;`,
          tip: 'FORCE ROW LEVEL SECURITY is the line people forget: without it the table owner silently ignores every policy you wrote.',
        },
        {
          h: 'Bind the setting to the transaction, in Rust',
          p: [
            'You cannot parameterise `SET`; it does not accept bind values. `set_config(name, value, is_local)` does, and it is the same mechanism - so the Rust helper is three lines and returns a transaction that already knows its tenant. Every repository function then takes `&mut PgConnection` from that transaction, which makes the tenant scope structural rather than remembered.',
            'Noisy neighbours need the same treatment as the isolation: a per-tenant statement timeout, a per-tenant rate limit, and a per-tenant metric label. Without them, one customer\'s reporting query holds a connection for two minutes and every other tenant sees the pool starve.',
          ],
          code: `use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

pub async fn tenant_tx<'a>(
    pool: &'a PgPool,
    tenant: crate::TenantId,
) -> Result<Transaction<'a, Postgres>, sqlx::Error> {
    let mut tx = pool.begin().await?;

    // is_local = true: the setting dies with this transaction.
    // Never use SET here - the connection returns to the pool still carrying it.
    sqlx::query("select set_config('app.tenant_id', $1, true)")
        .bind(tenant.0.to_string())
        .execute(&mut *tx)
        .await?;

    Ok(tx)
}`,
          tip: 'A tenant-scoped query that accidentally runs outside tenant_tx() returns zero rows instead of everything - fail-closed by construction.',
        },
      ],
      exercise: {
        prompt: 'Add a `statement_timeout` per transaction alongside the tenant setting, and write a test proving that a query without a tenant filter returns zero rows for tenant B.',
        starter: `pub async fn tenant_tx<'a>(pool: &'a PgPool, tenant: TenantId) -> Result<Transaction<'a, Postgres>, sqlx::Error> {
    // TODO: set app.tenant_id and a 5s statement_timeout, both transaction-local
    todo!()
}`,
        hint: 'set_config with is_local=true works for any custom or standard setting, including statement_timeout. Use sqlx::test with two tenants and assert counts.',
        solution: `use sqlx::{PgPool, Postgres, Transaction};

pub async fn tenant_tx<'a>(
    pool: &'a PgPool,
    tenant: crate::TenantId,
) -> Result<Transaction<'a, Postgres>, sqlx::Error> {
    let mut tx = pool.begin().await?;

    sqlx::query("select set_config('app.tenant_id', $1, true)")
        .bind(tenant.0.to_string())
        .execute(&mut *tx)
        .await?;

    sqlx::query("select set_config('statement_timeout', '5s', true)")
        .execute(&mut *tx)
        .await?;

    Ok(tx)
}

#[sqlx::test(fixtures("two_tenants"))]
async fn unset_tenant_reads_nothing(pool: PgPool) -> sqlx::Result<()> {
    // outside tenant_tx: app.tenant_id is unset, so the policy matches nothing
    let count: i64 = sqlx::query_scalar("select count(*) from projects")
        .fetch_one(&pool)
        .await?;
    assert_eq!(count, 0, "RLS must fail closed when no tenant is set");

    let mut tx = tenant_tx(&pool, crate::TenantId(uuid::Uuid::nil())).await?;
    let other: i64 = sqlx::query_scalar("select count(*) from projects")
        .fetch_one(&mut *tx)
        .await?;
    assert_eq!(other, 0);
    Ok(())
}`,
      },
      questions: [
        {
          q: 'Why must the tenant setting use SET LOCAL rather than SET?',
          options: [
            'SET LOCAL is faster because it skips the WAL',
            'SET persists on the pooled connection and leaks the tenant to the next borrower',
            'SET cannot be used inside a transaction',
            'SET LOCAL also encrypts the value in logs',
          ],
          answer: 1,
          explain: 'Connections are reused. A session-level setting survives the return to the pool, so the next request runs as the previous tenant until something overwrites it.',
        },
        {
          q: 'What does `current_setting(\'app.tenant_id\', true)` return when nothing was set?',
          options: [
            'An error that aborts the query',
            'NULL, so the policy matches no rows',
            'The empty string, so the policy matches all rows',
            'The last value used on that connection',
          ],
          answer: 1,
          explain: 'The second argument suppresses the "unrecognized configuration parameter" error. NULL comparison is never true, so an unset tenant sees nothing - fail closed.',
        },
        {
          q: 'Why add FORCE ROW LEVEL SECURITY?',
          options: [
            'It encrypts the table at rest',
            'It makes the policy apply to the table owner as well',
            'It adds an index on the tenant column',
            'It blocks all writes until a policy exists',
          ],
          answer: 1,
          explain: 'Table owners bypass RLS by default. Migration scripts and any process connecting as owner would otherwise read across tenants, which is exactly the case a leak surfaces in.',
        },
      ],
      quickbytes: [
        'Tenant id comes from a verified claim into a newtype; never from a body field.',
        'set_config(name, value, true) is transaction-scoped and accepts binds; SET does neither.',
        'FORCE ROW LEVEL SECURITY, or the owner bypasses every policy.',
        'Fail closed: unset tenant means zero rows, not all rows.',
      ],
      production: [
        'The application role is not the table owner and lacks BYPASSRLS.',
        'Every tenant-scoped query runs inside tenant_tx; a lint or wrapper type enforces it.',
        'Per-tenant statement_timeout and rate limits bound noisy neighbours.',
        'A cross-tenant test suite runs as the app role and asserts zero rows for the other tenant.',
        'Tenant id is a metric label only in aggregates that are already per-tenant billed - never in high-cardinality request metrics.',
      ],
      crates: ['sqlx', 'axum', 'jsonwebtoken', 'uuid'],
      github: [{ name: 'jsonwebtoken: JWT encoding and validation', url: 'https://github.com/Keats/jsonwebtoken' }],
      pitfall: 'A shared helper that builds `WHERE tenant_id = $1` by string concatenation: one query that forgets it leaks another customer\'s data, and no test catches it until a customer does.',
      resources: [
        { title: 'PostgreSQL: row security policies', url: 'https://www.postgresql.org/docs/current/ddl-rowsecurity.html', kind: 'docs' },
        { title: 'PostgreSQL: SET and set_config semantics', url: 'https://www.postgresql.org/docs/current/sql-set.html', kind: 'docs' },
        { title: 'sqlx crate documentation: transactions and pooling', url: 'https://docs.rs/sqlx/latest/sqlx/', kind: 'docs' },
        { title: 'jsonwebtoken crate documentation: claims and validation', url: 'https://docs.rs/jsonwebtoken/latest/jsonwebtoken/', kind: 'docs' },
      ],
    },
    {
      id: 'u14',
      n: 14,
      title: 'Chaos harness: deterministic faults with failpoints and a paused clock',
      minutes: 95,
      level: 'advanced',
      goal: 'Inject named failures behind a compile-time feature and run them under a controlled clock, so a fault test finishes in milliseconds and reproduces exactly.',
      sections: [
        {
          h: 'Failpoints beat random killing',
          p: [
            'Killing a pod at a random moment tests your orchestrator, not your invariants. A failpoint tests one specific transition: "the charge succeeded but the response write failed". The `fail` crate gives you named injection sites compiled out unless the `failpoints` feature is on, configured at runtime through the `FAILPOINTS` environment variable, so the production binary contains no path to inject anything.',
            'Name sites after the boundary they sit on (`charge.after`, `ledger.write.before`), not after the test that uses them. The harness then becomes data: a list of (site, action, expected invariant) rows that runs in CI, and the same list documents every partial-failure window the design admits.',
          ],
          code: `use fail::{fail_point, FailScenario};

#[derive(Debug, thiserror::Error)]
pub enum ChargeError {
    #[error("card declined")]
    Declined,
    #[error("injected fault")]
    Injected,
}

pub fn charge(cents: u64) -> Result<Receipt, ChargeError> {
    // compiled out unless the "failpoints" feature is enabled
    fail_point!("charge.before");

    let receipt = gateway::charge(cents)?;

    // the dangerous window: money moved, our write has not happened yet
    fail_point!("charge.after", |_| Err(ChargeError::Injected));

    Ok(receipt)
}

#[test]
fn crash_between_charge_and_record_does_not_double_bill() {
    // FAILPOINTS is read when the scenario is set up, so set it first
    std::env::set_var("FAILPOINTS", "charge.after=return");
    let scenario = FailScenario::setup();

    let first = charge(1000);
    assert!(first.is_err());

    // retry path must reconcile with the gateway before charging again
    let second = charge(1000);
    assert!(second.is_ok());

    scenario.teardown();
}`,
          tip: 'The closure form of fail_point! supplies the injected value; without it the macro evaluates to () and can only panic or sleep, not return an error.',
        },
        {
          h: 'Control the clock, not the machine',
          p: [
            'Retry budgets, lease expiry, and token-bucket refill are all time-dependent, and testing them with real sleeps makes a suite that takes minutes and flakes on a loaded CI box. `tokio::time::pause()` freezes the clock, and time advances only when the runtime has nothing else to do - so a 30-second backoff completes instantly and deterministically.',
            '`#[tokio::test(start_paused = true)]` opts a single test in. The assertion then becomes exact: after four retries with exponential backoff, the elapsed virtual time is 2+4+8+16 = 30 seconds, not "roughly thirty-ish". A test that asserts `elapsed() <= 60s` passes for a broken implementation that retries forever; assert the boundary.',
          ],
          code: `use std::time::Duration;
use tokio::time::Instant;

#[tokio::test(start_paused = true)]
async fn retry_budget_is_exactly_thirty_seconds() {
    let start = Instant::now();
    let attempts = retry_with_backoff(|| async { Err::<(), _>("boom") }, 4).await;
    let elapsed = start.elapsed();

    assert_eq!(attempts, 4);
    // 2 + 4 + 8 + 16 seconds of virtual time, plus jitter bounded to 10%
    assert!(elapsed >= Duration::from_secs(30), "backoff too aggressive: {elapsed:?}");
    assert!(elapsed < Duration::from_secs(34), "backoff exceeded budget: {elapsed:?}");
}

#[tokio::test(start_paused = true)]
async fn lease_expiry_is_observable_without_sleeping() {
    let lease = Lease::acquire(Duration::from_secs(30));
    tokio::time::advance(Duration::from_secs(31)).await;
    assert!(lease.is_expired());
}`,
          tip: 'start_paused requires tokio features "test-util" and "time"; without test-util the attribute is silently ignored and the test really sleeps.',
        },
        {
          h: 'State a hypothesis, then try to break it',
          p: [
            'A chaos run without a hypothesis is just an outage. Write the steady state first: "no order is charged twice", "every accepted job eventually completes or is dead-lettered", "no request returns 200 with a partial write". Then inject the fault and check the invariant, not the absence of errors.',
            'Two guards keep this from becoming a random-failure generator: one fault at a time (so a failure is attributable) and an abort condition (stop the run if the invariant is violated, rather than continuing to pile on noise). Run it nightly with a wall-clock budget; a harness that takes an hour will be disabled within a month.',
          ],
          list: [
            'One injected fault per scenario; combinations are a separate, deliberate suite',
            'Assert invariants, not error counts - a scenario that errors loudly but correctly is a pass',
            'Time-box the run and fail on timeout, or the harness becomes flaky and gets muted',
            'Every discovered bug becomes a regression scenario with the same failpoint and clock',
          ],
        },
      ],
      exercise: {
        prompt: 'Write a scenario that injects a failure between the database commit and the event publish, and assert that the outbox relay eventually publishes exactly one event.',
        starter: `#[tokio::test(start_paused = true)]
async fn commit_without_publish_is_recovered_by_relay() {
    // TODO: set FAILPOINTS for "outbox.publish.before"
    // TODO: assert exactly one event after the relay runs
    todo!()
}`,
        hint: 'Fail the publish, then drop the writer; the outbox row is still committed. Run the relay with paused time and assert `count(*) from published where order_id = $1` equals one.',
        solution: `#[tokio::test(start_paused = true)]
async fn commit_without_publish_is_recovered_by_relay() {
    std::env::set_var("FAILPOINTS", "outbox.publish.before=return");
    let scenario = fail::FailScenario::setup();
    let (pool, bus) = test_fixtures().await;

    // the transaction commits, then the publish fails
    let order_id = place_order(&pool, &bus).await;
    assert!(order_id.is_err() || bus.published_count().await == 0);

    // the outbox row survived the failed publish
    let pending: i64 = sqlx::query_scalar(
        "select count(*) from outbox where published_at is null",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(pending, 1);

    // relay retries with virtual time; publishing must be idempotent
    tokio::time::advance(Duration::from_secs(5)).await;
    relay_once(&pool, &bus).await.unwrap();
    relay_once(&pool, &bus).await.unwrap(); // double run must not duplicate

    let published = bus.published_count().await;
    assert_eq!(published, 1, "outbox relay must publish exactly once");

    scenario.teardown();
}`,
      },
      questions: [
        {
          q: 'Why compile failpoints behind a feature flag?',
          options: [
            'Because the macro is unstable without it',
            'So production binaries contain no code path that can inject a failure',
            'Because the fail crate cannot be used in tests otherwise',
            'To reduce binary size by more than half',
          ],
          answer: 1,
          explain: 'An injection mechanism reachable in production is an attack surface and an operational hazard. Compiling it out keeps the test-only affordance test-only.',
        },
        {
          q: 'What does #[tokio::test(start_paused = true)] do?',
          options: [
            'Runs the test on a single-threaded runtime',
            'Pauses the clock so time advances only when the runtime is idle',
            'Pauses the test until a debugger attaches',
            'Disables timers entirely for the test',
          ],
          answer: 1,
          explain: 'Paused time makes backoff and expiry deterministic: virtual time jumps forward when nothing is runnable, so a 30-second timeout costs no wall-clock time.',
        },
        {
          q: 'Which assertion makes a chaos scenario meaningful?',
          options: [
            'The number of errors logged stayed below a threshold',
            'The system invariant still holds after the injected fault',
            'The process did not panic during the run',
            'Recovery took less than one second',
          ],
          answer: 1,
          explain: 'Fault injection is about correctness under partial failure. "No panic" passes for a system that silently loses money; an invariant check does not.',
        },
      ],
      quickbytes: [
        'Name failpoints after boundaries (charge.after), never after tests.',
        'Set FAILPOINTS before FailScenario::setup(); the scenario snapshots it.',
        'start_paused makes a 30s backoff test instant and exact - assert the boundary, not "roughly".',
        'One fault per scenario, or you cannot attribute the failure.',
      ],
      production: [
        'Failpoints are behind a non-default feature and absent from release binaries.',
        'Each scenario names a steady-state invariant and a time budget.',
        'The nightly chaos job runs with a wall-clock limit and pages only on invariant violations.',
        'Every bug found by chaos becomes a permanent regression scenario.',
        'Time-dependent logic is tested with paused time, not sleeps.',
      ],
      crates: ['fail', 'tokio', 'tokio-test', 'proptest'],
      github: [{ name: 'fail-rs: failpoints for Rust', url: 'https://github.com/tikv/fail-rs' }],
      pitfall: 'Injecting two faults in one test: the system fails for an unknown reason, the test is muted, and the harness silently stops protecting anything.',
      resources: [
        { title: 'fail crate documentation: fail_point! and FailScenario', url: 'https://docs.rs/fail/latest/fail/', kind: 'docs' },
        { title: 'tokio::time::pause: manual control of the test clock', url: 'https://docs.rs/tokio/latest/tokio/time/fn.pause.html', kind: 'docs' },
        { title: 'fail-rs repository: failpoint syntax and actions', url: 'https://github.com/tikv/fail-rs', kind: 'repo' },
        { title: 'CNCF channel: chaos engineering and resilience talks from KubeCon', url: 'https://www.youtube.com/@cncf', kind: 'video' },
      ],
    },
    {
      id: 'u15',
      n: 15,
      title: 'Benchmark suite: measure the thing that regresses',
      minutes: 90,
      level: 'advanced',
      goal: 'Build a benchmark suite whose numbers survive CI noise: throughput-oriented criterion benches, instruction counts for comparisons, and a report someone can act on.',
      sections: [
        {
          h: 'A benchmark is a question, not a timer',
          p: [
            'Before writing the harness, write the question: "does the new parser reduce time per megabyte at batch size 8k?" A benchmark without a question produces a number nobody can interpret, and the suite rots. Every bench should state its input, its metric (ns/op, bytes/s, allocations), and the threshold at which a regression is worth blocking a merge.',
            'Criterion handles the statistics: warm-up, sample size, outlier detection, and a comparison against the previous run stored in `target/criterion`. `Throughput::Bytes` turns ns/op into MiB/s, which is the number stakeholders actually ask about. The `[[bench]] harness = false` line in Cargo.toml is mandatory - without it libtest runs the benchmark functions once and reports nothing.',
          ],
          code: `use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use std::hint::black_box;
use std::time::Duration;

fn bench_parse(c: &mut Criterion) {
    let input = std::fs::read("fixtures/sample.ndjson").expect("fixture");
    let mut group = c.benchmark_group("parse_ndjson");

    group.throughput(Throughput::Bytes(input.len() as u64));
    group.sample_size(50);
    group.warm_up_time(Duration::from_secs(1));
    group.measurement_time(Duration::from_secs(5));

    for batch in [1024usize, 8192, 65536] {
        group.bench_with_input(
            BenchmarkId::from_parameter(batch),
            &batch,
            |b, &batch| {
                b.iter(|| parse_batched(black_box(&input), black_box(batch)))
            },
        );
    }

    group.finish();
}

criterion_group!(benches, bench_parse);
criterion_main!(benches);`,
          tip: 'std::hint::black_box beats the criterion re-export: same effect, no deprecation warning, and it is what the compiler team maintains.',
        },
        {
          h: 'Wall clock is noisy; instructions are not',
          p: [
            'Shared CI runners have variable clocks, neighbours, and turbo states, so a 5% wall-clock regression is indistinguishable from noise. Instruction counts are stable across machines: `iai-callgrind` runs the benchmark under Valgrind\'s callgrind and reports instructions, cache misses, and estimated cycles. That makes it the right gate for "did this change make the hot path worse", with criterion answering "how fast is it really" on dedicated hardware.',
            'Divan is the pragmatic middle: much lower per-sample overhead than criterion, simple `#[divan::bench]` attributes, and a `--sample-count` flag you can crank on a quiet machine. Use one framework, not three; the cost of a benchmark suite is the maintenance, not the first bench.',
          ],
          code: `// divan: cheap benches with argument matrices
fn main() {
    divan::main();
}

#[divan::bench(args = [1024, 8192, 65536])]
fn parse_batched(bencher: divan::Bencher, batch: usize) {
    let input = divan::black_box(include_bytes!("../fixtures/sample.ndjson"));
    bencher.bench(|| parse_batched(input, batch));
}

#[divan::bench(sample_count = 200, sample_size = 500)]
fn alloc_per_record(bencher: divan::Bencher) {
    bencher
        .counter(divan::counter::ItemsCount::new(1u32))
        .bench(|| divan::black_box(parse_one_line(b"{\\"level\\":\\"info\\"}")));
}`,
          tip: 'Count allocations with a custom global allocator wrapped in a counter; ns/op hides the allocator work that will dominate under real concurrency.',
        },
        {
          h: 'Report honestly or do not report',
          p: [
            'Three habits separate a useful report from a misleading one. First, compare interleaved A/B on the same machine in the same session - two runs an hour apart measure the machine, not the code. Second, report the distribution: p50 and p99 from an hdrhistogram for latency, not the mean, because the mean hides the tail users feel. Third, pin the build: `--release`, the same RUSTFLAGS, the same LTO settings, and record them next to the number.',
            'For a service, the most useful benchmark is a load test with a realistic mix and an open-loop arrival rate. Closed-loop tools under-report because they slow down when the server does, which is the opposite of what happens in production when a queue builds. `oha` or `wrk2`-style constant-rate load tells you where the latency knee is; a criterion microbench tells you which function to fix once you get there.',
          ],
          list: [
            'Interleave A and B runs; never compare against yesterday\'s CI number',
            'Report p50/p99 and throughput at a fixed error rate, not a single mean',
            'Record the exact build profile with the result',
            'Gate merges on instruction counts, publish wall-clock numbers weekly',
          ],
        },
      ],
      exercise: {
        prompt: 'Add a criterion benchmark that measures parse throughput in MiB/s for three batch sizes, plus a callgrind-based instruction-count benchmark for the inner loop.',
        starter: `fn bench_parse(c: &mut Criterion) {
    // TODO: Throughput::Bytes, three batch sizes, bench_with_input
}

criterion_group!(benches, bench_parse);
criterion_main!(benches);`,
        hint: 'Throughput is per-group, so set it once before the loop. For instruction counts, add an iai-callgrind target and compare its output in CI rather than in a dashboard.',
        solution: `use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use std::hint::black_box;
use std::time::Duration;

fn bench_parse(c: &mut Criterion) {
    let input = std::fs::read("fixtures/sample.ndjson").expect("fixture");
    let mut group = c.benchmark_group("parse_ndjson");

    group.throughput(Throughput::Bytes(input.len() as u64));
    group.sample_size(30);
    group.warm_up_time(Duration::from_secs(1));
    group.measurement_time(Duration::from_secs(5));

    for batch in [1024usize, 8192, 65536] {
        group.bench_with_input(BenchmarkId::from_parameter(batch), &batch, |b, &batch| {
            b.iter(|| parse_batched(black_box(&input), black_box(batch)))
        });
    }

    group.finish();
}

criterion_group!(benches, bench_parse);
criterion_main!(benches);

// benches/parse_iai.rs, run with cargo bench --bench parse_iai
// iai-callgrind reports instructions and estimated cycles, which are stable
// across machines; gate merges on a 2% budget there, not on wall clock.`,
      },
      questions: [
        {
          q: 'Why is `harness = false` required for a criterion benchmark target?',
          options: [
            'It disables optimisations so the benchmark is fair',
            'It stops libtest from running the bench functions once with no measurement',
            'It enables the criterion CLI flags',
            'It links the benchmark against the release profile',
          ],
          answer: 1,
          explain: 'The default test harness treats bench functions as tests and runs each once. harness = false hands main() to criterion, which owns warm-up, sampling, and reporting.',
        },
        {
          q: 'A CI run shows a 4% wall-clock regression on a shared runner. What is the sound next step?',
          options: [
            'Block the merge until the number returns',
            'Re-run the instruction-count benchmark, which is stable across machines',
            'Increase the sample size until the regression disappears',
            'Compare against the number from last week\'s run',
          ],
          answer: 1,
          explain: 'Shared runners make small wall-clock differences meaningless. Instruction counts and cache behaviour are stable, so they can distinguish a real regression from a noisy neighbour.',
        },
        {
          q: 'Why does a closed-loop load test understate production latency?',
          options: [
            'It measures CPU time instead of wall time',
            'It slows its request rate when the server slows, hiding queueing',
            'It cannot saturate a keep-alive connection',
            'It reports the mean instead of the median',
          ],
          answer: 1,
          explain: 'Closed-loop clients wait for a response before sending the next request, so the offered load drops exactly when the system is struggling. Open-loop constant arrival exposes the queue.',
        },
      ],
      quickbytes: [
        'Throughput::Bytes turns ns/op into MiB/s - the number people ask for.',
        'harness = false in Cargo.toml, or the bench runs once and reports nothing.',
        'Gate merges on instruction counts; publish wall clock weekly on dedicated hardware.',
        'Interleave A/B runs; cross-day comparisons measure the machine.',
      ],
      production: [
        'Every bench names its input, metric, and the regression threshold that blocks a merge.',
        'CI gates on iai-callgrind instruction counts with a stated budget.',
        'Fixtures are committed and versioned so numbers are comparable across months.',
        'Service benchmarks are open-loop load tests reporting p50/p99 at a fixed error rate.',
        'Build flags (release, LTO, codegen-units) are recorded alongside published results.',
      ],
      crates: ['criterion', 'divan', 'iai-callgrind', 'hdrhistogram'],
      github: [
        { name: 'criterion.rs: statistics-driven benchmarking', url: 'https://github.com/bheisler/criterion.rs' },
        { name: 'divan: simple, fast benchmarking', url: 'https://github.com/nvzqz/divan' },
      ],
      pitfall: 'Benchmarking a function whose result is unused: the optimiser deletes the work, and the benchmark reports that doing nothing takes two nanoseconds.',
      resources: [
        { title: 'criterion crate documentation: groups, throughput, comparison', url: 'https://docs.rs/criterion/latest/criterion/', kind: 'docs' },
        { title: 'divan: attribute-based benchmarks with argument matrices', url: 'https://docs.rs/divan/latest/divan/', kind: 'docs' },
        { title: 'iai-callgrind: instruction-count benchmarks for CI', url: 'https://docs.rs/iai-callgrind/latest/iai_callgrind/', kind: 'docs' },
        { title: 'criterion.rs repository: FAQ on noise, sampling, and reporting', url: 'https://github.com/bheisler/criterion.rs', kind: 'repo' },
      ],
    },
    {
      id: 'u16',
      n: 16,
      title: 'Fuzz target: structured input, invariants, and a growth loop',
      minutes: 90,
      level: 'advanced',
      goal: 'Fuzz a parser through cargo-fuzz with types rather than bytes, assert an invariant instead of just "no panic", and turn every crash into a permanent regression.',
      sections: [
        {
          h: 'A fuzz target is a test that writes itself',
          p: [
            'Random input finds the cases you would never type: truncated headers, a length field of 0xFFFFFFFF, a nesting depth of ten thousand. The harness is `libfuzzer-sys` with a `fuzz_target!` entry point; `cargo fuzz` builds it with the coverage instrumentation that lets libFuzzer learn which byte changes reach new branches. The loop only works because of that feedback - without coverage, random bytes are almost useless on a real format.',
            'Start from a seed corpus: a handful of valid, minimal documents checked into the repository. libFuzzer mutates around them, so it reaches deep states in minutes instead of hours. Add a dictionary of protocol keywords and magic bytes, and the mutation budget is spent on structure rather than on rediscovering your header.',
          ],
          code: `# Cargo.toml of the fuzz crate (generated by \`cargo fuzz init\`)
[package]
name = "acme-fuzz"
version = "0.0.0"
publish = false

[package.metadata]
cargo-fuzz = true

[dependencies]
libfuzzer-sys = "0.4"
arbitrary = { version = "1", features = ["derive"] }
acme-core = { path = ".." }
`,
          tip: 'Commit the corpus. It is the accumulated memory of every bug the target has already found and it makes the first CI run useful.',
        },
        {
          h: 'Fuzz the types, not the bytes',
          p: [
            'Raw-byte targets spend most of their mutations failing the same length check. Deriving `Arbitrary` moves the structural constraints into the generator, so the fuzzer mutates *valid-shaped* values: an enum discriminant, a bounded depth, a length that matches its buffer. You get deeper coverage per execution and you stop rediscovering that a 3-byte input cannot contain a header.',
            'Then assert the property that must hold for every input, not merely the absence of a panic. Round-trip is the classic: `parse(serialize(x)) == x`. Monotonicity, idempotence, and "never allocates more than N times the input length" are all checkable invariants that catch logic bugs a crash detector misses.',
          ],
          code: `#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;

#[derive(Debug, Arbitrary)]
struct FuzzConfig {
    name: String,
    depth: u8,
    flags: Vec<u16>,
    payload: Vec<u8>,
}

fuzz_target!(|cfg: FuzzConfig| {
    // The invariant: whatever serializes must parse back identically.
    if let Ok(bytes) = acme_core::serialize(&cfg) {
        let parsed = acme_core::parse(&bytes).expect("serialized form must parse");
        assert_eq!(parsed, cfg, "round-trip mismatch");

        // A second property: parsing is idempotent on the re-encoded form.
        let again = acme_core::serialize(&parsed).unwrap();
        assert_eq!(bytes, again, "re-encoding changed the bytes");
    }
});`,
          tip: 'Derive Arbitrary on your real config type, not on a copy: a copy stops being updated and the fuzzer silently stops covering new fields.',
        },
        {
          h: 'From crash to regression in one commit',
          p: [
            'When libFuzzer finds something it writes `artifacts/<target>/crash-<hash>` and prints the input. Reproduce it with the exact file, minimize it (`-minimize_crash=1`) so the failing case is three bytes instead of three kilobytes, then add both the minimized input to the corpus and a deterministic unit test that calls the same function. The fuzzer finds it once; the unit test makes sure it stays fixed.',
            'CI runs the target with a time budget: `-max_total_time=900` is a fifteen-minute nightly job, while a per-PR run of sixty seconds catches regressions cheaply. Use the same seed corpus in both. When a target stops finding new coverage, the message is usually "the parser now has an unreachable branch" - treat flat coverage as a prompt to check the target, not as success.',
          ],
          list: [
            'Reproduce with the artifact file before doing anything else',
            'Minimize, then add the input to corpus/ and the test suite',
            'Nightly budget 15 min per target; per-PR smoke 60 s',
            'Watch coverage: flat coverage means the target is no longer reaching new code',
          ],
        },
      ],
      exercise: {
        prompt: 'Write a fuzz target for a length-prefixed binary frame parser that asserts the parser never reads past the declared length and that every accepted frame re-encodes to the same bytes.',
        starter: `#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    // TODO: parse a length-prefixed frame, assert framing invariants
});`,
        hint: 'On success, re-serialize and compare bytes. On failure, assert the error is a typed parse error, not a panic or an index-out-of-bounds. Cap the declared length against the remaining input.',
        solution: `#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    match acme_core::Frame::parse(data) {
        Ok((frame, consumed)) => {
            // a successful parse must not claim more bytes than it was given
            assert!(consumed <= data.len(), "parser consumed {consumed} of {}", data.len());
            assert_eq!(frame.declared_len as usize, frame.body.len(), "length mismatch");

            // and re-encoding must be byte-identical
            let encoded = frame.encode();
            assert_eq!(encoded, data[..consumed], "re-encode differs from input");
        }
        Err(err) => {
            // rejection is fine; only a typed error is fine
            let msg = err.to_string();
            assert!(!msg.is_empty(), "error must carry a message");
        }
    }
});`,
      },
      questions: [
        {
          q: 'Why does libFuzzer need coverage instrumentation?',
          options: [
            'To measure how long each input takes to execute',
            'To learn which mutations reach new code paths and keep those',
            'To deduplicate the seed corpus automatically',
            'To compile the target in release mode',
          ],
          answer: 1,
          explain: 'Coverage feedback is the search signal. Without it, mutation is a random walk; with it, the fuzzer keeps inputs that explore new branches and builds on them.',
        },
        {
          q: 'What is the advantage of deriving Arbitrary for the target input?',
          options: [
            'It makes the fuzzer run faster per execution',
            'Structural constraints move into the generator, so mutations stay valid-shaped',
            'It removes the need for a seed corpus',
            'It guarantees no panics can occur',
          ],
          answer: 1,
          explain: 'Byte-level mutation wastes most executions failing the same validation. Typed generation mutates within the shape of the data and reaches deeper states sooner.',
        },
        {
          q: 'A crash artifact is found. What is the correct first step?',
          options: [
            'Delete it and re-run to see if it reproduces',
            'Reproduce it from the artifact file, then minimize it',
            'Increase the fuzzing time budget to find more crashes',
            'Disable the assertion that failed',
          ],
          answer: 1,
          explain: 'Reproduction proves the artifact is the input; minimization turns a large blob into a readable test case worth committing to the corpus.',
        },
      ],
      quickbytes: [
        'cargo fuzz run <target> corpus/<target> -- -max_total_time=60 for a PR smoke test.',
        'Derive Arbitrary on the real type; a parallel copy drifts and stops covering new fields.',
        'Assert invariants (round-trip, idempotence), not just "did not panic".',
        'Minimize every crash and commit the input to corpus/ plus a unit test.',
      ],
      production: [
        'Each parser has a fuzz target, a committed seed corpus, and a dictionary of keywords.',
        'CI runs a 60 s smoke per PR and a 15 min budget per target nightly.',
        'Every historical crash has a minimized corpus entry and a deterministic unit test.',
        'Targets run under the same feature flags as production parsing paths.',
        'Coverage per target is tracked; a flat trend triggers a target review.',
      ],
      crates: ['libfuzzer-sys', 'arbitrary', 'cargo-fuzz'],
      github: [
        { name: 'cargo-fuzz: coverage-guided fuzzing for Rust', url: 'https://github.com/rust-fuzz/cargo-fuzz' },
        { name: 'arbitrary: structured fuzzing input generation', url: 'https://github.com/rust-fuzz/arbitrary' },
      ],
      pitfall: 'A fuzz target that calls unwrap() on the input it is fuzzing: every execution panics, the fuzzer reports a crash immediately, and the target is disabled before it finds anything real.',
      resources: [
        { title: 'libfuzzer-sys: the fuzz_target! entry point', url: 'https://docs.rs/libfuzzer-sys/latest/libfuzzer_sys/', kind: 'docs' },
        { title: 'arbitrary: derive structured inputs for fuzzing', url: 'https://docs.rs/arbitrary/latest/arbitrary/', kind: 'docs' },
        { title: 'cargo-fuzz repository: corpus, artifacts, coverage', url: 'https://github.com/rust-fuzz/cargo-fuzz', kind: 'repo' },
        { title: 'The Art, Science, and Engineering of Fuzzing: A Survey', url: 'https://arxiv.org/abs/1812.00140', kind: 'paper' },
      ],
    },
    {
      id: 'u17',
      n: 17,
      title: 'Plugin system: native ABI risk versus WASM sandboxing',
      minutes: 115,
      level: 'industry',
      goal: 'Load third-party extension code with an explicit API version and a checksum, and choose between in-process Rust plugins and a WASM sandbox by blast radius.',
      sections: [
        {
          h: 'Two ways to extend, two risk profiles',
          p: [
            'An in-process Rust plugin is a dynamic library loaded into your address space. It is as fast as your own code and as dangerous: a panic across the FFI boundary is undefined behaviour, a segfault takes the host down, and Rust has no stable ABI, so the plugin must be compiled with a compatible toolchain and checked at load time. `abi_stable` exists to make this survivable - `#[derive(StableAbi)]` types carry a layout hash that is verified on load, `RootModule` describes the exported vtable, and `#[sabi_trait]` generates FFI-safe trait objects.',
            'A WASM plugin runs in a sandbox with its own linear memory and no ambient authority. It cannot open a socket, read a file, or corrupt your heap unless you link a host function that lets it. The cost is the boundary: values are copied in and out, and compute runs at a fraction of native speed. The decision is not performance - it is what happens when the plugin is buggy or hostile.',
          ],
          list: [
            'Native plugin: trusted first-party extensions, hot paths, toolchain pinned per release',
            'WASM plugin: anything from a customer, anything multi-tenant, anything you cannot audit',
            'Both need an api_version in the manifest and a checksum verified before load',
            'Neither removes the need for resource limits: CPU, memory, and wall-clock time',
          ],
        },
        {
          h: 'Version negotiation belongs in the manifest',
          p: [
            'Load the manifest before the code, verify the checksum, then compare `api_version` against the range the host supports. Refusing early gives a clean error the operator can read; discovering the mismatch as a missing symbol gives a segfault. Record the plugin name, version, and checksum in a startup log line - when a customer reports weird behaviour, that line is the first thing you will want.',
            'Treat the host API as a public API: additive changes only, and a new major version runs two loader paths side by side during a migration window. A plugin ecosystem is a compatibility promise, and the cheapest time to make that promise explicit is before the first third-party plugin exists.',
          ],
          code: `use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
pub struct PluginManifest {
    pub name: String,
    pub version: String,
    pub api_version: u32,
    pub entrypoint: PathBuf,
    pub sha256: String,
}

pub const SUPPORTED_API: std::ops::RangeInclusive<u32> = 3..=4;

#[derive(Debug, thiserror::Error)]
pub enum PluginError {
    #[error("plugin {name} requires api {found}, host supports {min}..={max}")]
    ApiMismatch { name: String, found: u32, min: u32, max: u32 },
    #[error("checksum mismatch for {0}")]
    Checksum(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub fn verify(manifest: &PluginManifest, dir: &Path) -> Result<(), PluginError> {
    if !SUPPORTED_API.contains(&manifest.api_version) {
        return Err(PluginError::ApiMismatch {
            name: manifest.name.clone(),
            found: manifest.api_version,
            min: *SUPPORTED_API.start(),
            max: *SUPPORTED_API.end(),
        });
    }

    let bytes = std::fs::read(dir.join(&manifest.entrypoint))?;
    let digest = sha256_hex(&bytes);
    if digest != manifest.sha256 {
        return Err(PluginError::Checksum(manifest.name.clone()));
    }

    tracing::info!(
        plugin = %manifest.name,
        version = %manifest.version,
        api = manifest.api_version,
        "plugin verified"
    );
    Ok(())
}`,
          tip: 'Verify the checksum on the bytes you actually load, not on a second read; otherwise the file can change between verification and load.',
        },
        {
          h: 'Sandbox the untrusted case with limits',
          p: [
            'Wasmtime gives you three limits that matter and most embedders forget: fuel (bounded instructions), memory (maximum pages), and epoch interruption (wall-clock cancellation). Without fuel, a plugin with `loop {}` consumes a core forever; without a memory limit, it allocates until the host OOMs. Injecting fuel per call turns "the plugin is slow" into a typed error you can report to the plugin author.',
            'Capabilities are the linker. If the plugin cannot import a function, it cannot perform that effect - so build one linker per trust level and do not expose `wasi` filesystem access to plugins that only transform bytes. That is the entire security model, and it is much easier to audit than a permission table in application code.',
          ],
          code: `use wasmtime::{Caller, Config, Engine, Linker, Module, Store};

pub struct HostState {
    pub tenant: uuid::Uuid,
    pub calls: u32,
}

pub fn build_engine() -> anyhow::Result<Engine> {
    let mut config = Config::new();
    config.consume_fuel(true);          // enable instruction metering
    config.epoch_interruption(true);    // allow wall-clock cancellation
    Ok(Engine::new(&config)?)
}

pub fn instantiate(
    engine: &Engine,
    wasm: &[u8],
    tenant: uuid::Uuid,
    fuel: u64,
) -> anyhow::Result<(Store<HostState>, wasmtime::Instance)> {
    let module = Module::new(engine, wasm)?;
    let mut linker: Linker<HostState> = Linker::new(engine);

    // the only capability this plugin gets: emit a structured log line
    linker.func_wrap("acme", "log", |mut caller: Caller<'_, HostState>, ptr: i32, len: i32| {
        caller.data_mut().calls += 1;
        let _ = (ptr, len); // read from caller.get_export("memory") in a real host
    })?;

    let mut store = Store::new(engine, HostState { tenant, calls: 0 });
    store.set_fuel(fuel)?;
    store.epoch_deadline_trap();

    let instance = linker.instantiate(&mut store, &module)?;
    Ok((store, instance))
}`,
          tip: 'One store per invocation, not per plugin: a store carries mutation, so reusing it leaks state (and fuel accounting) between tenants.',
        },
      ],
      exercise: {
        prompt: 'Add a `max_memory_pages` check to the host: reject a module whose declared memory minimum exceeds the budget before instantiating it, and return a typed error naming the plugin.',
        starter: `pub fn check_limits(module: &wasmtime::Module, max_pages: u64) -> Result<(), PluginError> {
    // TODO: inspect the module's memory export/imports
    todo!()
}`,
        hint: 'Use module.imports()/exports() to find the memory type, or enforce the limit at the Store level via a ResourceLimiter, which also covers memories created at runtime.',
        solution: `use wasmtime::{ResourceLimiter, Store};

pub struct Limits {
    pub max_pages: usize,
}

impl ResourceLimiter for Limits {
    fn memory_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> anyhow::Result<bool> {
        Ok(desired <= self.max_pages * 64 * 1024)
    }

    fn table_growing(
        &mut self,
        _current: u32,
        _desired: u32,
        _maximum: Option<u32>,
    ) -> anyhow::Result<bool> {
        Ok(true)
    }
}

pub fn make_store(
    engine: &wasmtime::Engine,
    limits: Limits,
) -> anyhow::Result<Store<Limits>> {
    let mut store = Store::new(engine, limits);
    // the limiter applies to every memory the guest creates, not just its main one
    store.limiter(|state| state);
    Ok(store)
}`,
      },
      questions: [
        {
          q: 'What does abi_stable check that a plain extern "C" dylib does not?',
          options: [
            'That the plugin was compiled in release mode',
            'That the layout of the types crossing the boundary matches at load time',
            'That the plugin cannot allocate memory',
            'That the plugin has no unsafe code',
          ],
          answer: 1,
          explain: 'Rust has no stable ABI. StableAbi embeds layout information and verifies it on load, turning a silent memory-corruption bug into a load-time error.',
        },
        {
          q: 'Which control prevents a WASM plugin from running forever?',
          options: [
            'Setting a memory maximum',
            'Consuming fuel (or an epoch deadline) so execution is bounded',
            'Rejecting modules above a size threshold',
            'Running the instance on a background thread',
          ],
          answer: 1,
          explain: 'Memory limits bound space, not time. Fuel or epoch interruption bounds how long the guest may execute before the host traps.',
        },
        {
          q: 'Where should plugin capability restrictions live?',
          options: [
            'In the plugin manifest, as a list of permissions',
            'In the linker: only import the host functions the plugin is allowed to call',
            'In a code review checklist for plugin authors',
            'In the WASM module\'s own configuration section',
          ],
          answer: 1,
          explain: 'A plugin can only perform effects for which a host function exists. Building one linker per trust level makes the capability set structural instead of documentary.',
        },
      ],
      quickbytes: [
        'api_version plus checksum in the manifest, verified before any code is mapped or compiled.',
        'Native plugins need abi_stable layout checks; a panic across the FFI boundary is UB.',
        'WASM plugins need fuel, memory limits, and a minimal linker - capability is what you import.',
        'One store per invocation; reused stores leak state between calls and tenants.',
      ],
      production: [
        'Every plugin has a manifest with api_version, checksum, and host compatibility range.',
        'Native plugins are built with a pinned toolchain in CI and load-checked in a smoke test.',
        'WASM plugins run with fuel, memory, and epoch limits, returning typed errors on exhaustion.',
        'The linker exposes only the capabilities the plugin class needs; no ambient WASI access.',
        'Loaded plugins are logged with name, version, and checksum at startup.',
      ],
      crates: ['abi_stable', 'wasmtime', 'serde', 'thiserror'],
      github: [
        { name: 'abi_stable: stable ABI for Rust-to-Rust plugins', url: 'https://github.com/rodrimati1992/abi_stable_crates' },
        { name: 'wasmtime: WebAssembly runtime with sandboxing and limits', url: 'https://github.com/bytecodealliance/wasmtime' },
      ],
      pitfall: 'Loading a native plugin and calling it without any panic containment: a plugin panic unwinds into the host across an FFI boundary, which is undefined behaviour rather than a caught error.',
      resources: [
        { title: 'abi_stable: StableAbi, RootModule, and sabi_trait', url: 'https://docs.rs/abi_stable/latest/abi_stable/', kind: 'docs' },
        { title: 'wasmtime: Engine, Store, Linker, and resource limits', url: 'https://docs.rs/wasmtime/latest/wasmtime/', kind: 'docs' },
        { title: 'wasmtime repository: embedding examples and security model', url: 'https://github.com/bytecodealliance/wasmtime', kind: 'repo' },
        { title: 'Bytecode Alliance channel: Wasmtime, components, and sandboxing talks', url: 'https://www.youtube.com/@bytecodealliance', kind: 'video' },
      ],
    },
    {
      id: 'u18',
      n: 18,
      title: 'Distributed cache: consistent hashing and the hot-key cliff',
      minutes: 110,
      level: 'industry',
      goal: 'Place keys on a ring with replication, fall back on node failure, and stop a single hot key from turning one cache node into the bottleneck.',
      sections: [
        {
          h: 'Modulo hashing reshuffles everything on resize',
          p: [
            '`hash(key) % n` looks fine until n changes: going from 4 nodes to 5 remaps roughly 80% of keys, so every miss arrives at your database at once. Consistent hashing places both keys and nodes on a ring and assigns each key to the next node clockwise; adding a node steals only its neighbours\' share, so roughly 1/n of keys move.',
            'Virtual nodes fix the variance. With one position per node, an unlucky placement gives one node a third of the ring. Adding 100-200 virtual positions per physical node makes the distribution even to within a few percent, and it makes the amount moved on rebalance predictable: new node takes ~1/n, split among the nodes it displaced.',
          ],
          code: `use hashring::HashRing;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Node {
    pub id: String,
    pub addr: String,
}

pub struct Ring {
    ring: HashRing<Node>,
    replicas: usize,
}

impl Ring {
    pub fn new(nodes: &[Node], vnodes: usize) -> Self {
        let mut ring = HashRing::new();
        for node in nodes {
            for v in 0..vnodes {
                ring.add(Node {
                    id: format!("{}#{}", node.id, v),
                    addr: node.addr.clone(),
                });
            }
        }
        Self { ring, replicas: 3 }
    }

    /// Primary plus the next replicas around the ring.
    /// hashring exposes only a single-key lookup, so the walk is built in the
    /// exercise below by probing suffixes and deduplicating by address.
    pub fn primary_for(&self, key: &str) -> Option<String> {
        self.ring.get(&key.to_string()).map(|node| node.addr.clone())
    }
}`,
          tip: 'Hash the vnode id (node#index), not just the node, or all virtual positions collapse onto one point.',
        },
        {
          h: 'Cache-aside with replication and read repair',
          p: [
            'The request path is: look up the replica list, try the primary with a short timeout, fall back to the next replica, and on a read miss populate the node and return the value. The timeout must be much smaller than the caller\'s budget - a cache that adds 500 ms of latency when it is slow has negative value. On a replica hit where the primary disagreed, schedule a repair write; that is read repair, and it is what keeps replicas from drifting permanently.',
            'Invalidation is the hard part. TTL alone gives you bounded staleness but not correctness after a write, so writes should delete the key (not update it) and rely on the next read to repopulate - update-in-place races with a concurrent stale read that then writes the old value back. When you need stronger guarantees, store a version alongside the value and let readers reject anything older than the version they know about.',
          ],
          code: `use std::time::Duration;
use tokio::time::timeout;

pub async fn get_or_load<F, Fut, T>(
    cache: &moka::future::Cache<String, T>,
    ring: &Ring,
    key: String,
    load: F,
) -> anyhow::Result<T>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<T>>,
    T: Clone + Send + Sync + 'static,
{
    // moka's try_get_with runs the initializer at most once per key,
    // which is the single-flight protection against a stampede.
    let value = cache
        .try_get_with(key.clone(), async move {
            // populate from the primary, falling back around the ring
            for addr in ring.replicas_for(&key) {
                match timeout(Duration::from_millis(20), fetch_from(&addr, &key)).await {
                    Ok(Ok(v)) => return Ok::<T, anyhow::Error>(v),
                    _ => continue, // timeout or error: try the next replica
                }
            }
            load().await // cache miss everywhere: go to the source of truth
        })
        .await?;

    Ok(value)
}`,
          tip: 'Set the cache timeout from the caller budget, not from the cache client default: 20 ms is generous for an in-datacentre hop.',
        },
        {
          h: 'Hot keys are a placement problem, not a capacity problem',
          p: [
            'One celebrity user, one popular product, one config key read by every request: consistent hashing sends all of it to a single node, which then melts while the rest of the ring idles. Adding nodes does not help because the key still maps to one place. The fixes are all local replication: cache the value on every node in the request path (a small in-process cache with a short TTL), or split the hot key into N sub-keys with randomised suffixes and reassemble on read.',
            'The other cliff is cold start. After a deploy or a node loss, the ring re-maps and every miss hits the database simultaneously. Jittered TTLs, request coalescing, and a warmup pass are the three standard mitigations, and the ordering matters: coalescing first, since it bounds concurrency regardless of how cold the cache is.',
          ],
          list: [
            'Local L1 cache in front of the ring for keys read on every request',
            'Split hot keys with a random suffix; sum or select on read',
            'Jitter TTLs by +/-10% so expiries do not align',
            'Coalesce concurrent misses per key before they reach the database',
          ],
        },
      ],
      exercise: {
        prompt: 'Implement `replicas_for` so it returns the primary plus the next two distinct physical nodes clockwise from the key, deduplicating by address.',
        starter: `pub fn replicas_for(&self, key: &str) -> Vec<String> {
    // TODO: start at ring.get(key), then continue clockwise
    todo!()
}`,
        hint: 'hashring exposes get() for a single lookup; for a walk you need to hash the key and iterate positions yourself, or probe with key#i suffixes and dedupe. Document which approach you chose.',
        solution: `use std::collections::HashSet;

impl Ring {
    /// Primary plus the next distinct nodes clockwise. Implemented by probing
    /// suffixed keys: cheap, allocation-light, and good enough when vnodes
    /// already smooth the distribution.
    pub fn replicas_for(&self, key: &str) -> Vec<String> {
        let mut seen: HashSet<&str> = HashSet::new();
        let mut out = Vec::with_capacity(self.replicas);

        for probe in 0..(self.replicas * 4) {
            let probe_key = format!("{key}~{}", probe);
            let Some(node) = self.ring.get(&probe_key) else { break };
            if seen.insert(node.addr.as_str()) {
                out.push(node.addr.clone());
                if out.len() == self.replicas {
                    break;
                }
            }
        }

        out
    }
}`,
      },
      questions: [
        {
          q: 'Why does consistent hashing move fewer keys than modulo hashing when a node is added?',
          options: [
            'Because the hash function is faster',
            'Because only the keys between the new node and its predecessor move',
            'Because keys are replicated to every node',
            'Because it uses a larger hash space',
          ],
          answer: 1,
          explain: 'The ring only re-assigns the arc the new node occupies. Modulo remaps almost every key because the divisor changed for all of them.',
        },
        {
          q: 'Why delete a key on write instead of updating it in place?',
          options: [
            'Deletes are cheaper than writes',
            'A concurrent stale read can repopulate the old value after an in-place update',
            'Redis does not support updating existing keys',
            'TTL only applies to deleted keys',
          ],
          answer: 1,
          explain: 'Delete-then-repopulate narrows the race to a miss. An in-place update loses to a reader that fetched the old value just before the write and writes it back afterwards.',
        },
        {
          q: 'A single key saturates one cache node. What actually fixes it?',
          options: [
            'Adding more nodes to the ring',
            'Replicating or sharding that key across many nodes and caching it locally',
            'Increasing the cache node memory',
            'Lowering the TTL for all keys',
          ],
          answer: 1,
          explain: 'Placement sends the hot key to one node no matter how large the ring. Splitting or local caching spreads the read load; adding nodes only helps other keys.',
        },
      ],
      quickbytes: [
        'Use 100+ vnodes per physical node or one unlucky placement owns a third of the ring.',
        'Cache timeouts must be a fraction of the caller budget; a slow cache is worse than no cache.',
        'Delete on write, repopulate on read, and store a version if you need staleness bounds.',
        'Coalesce misses per key before adding nodes - stampedes are a concurrency problem.',
      ],
      production: [
        'Vnode count and replica factor are documented with the measured distribution spread.',
        'Cache calls have explicit timeouts and fall back around the ring on failure.',
        'Hot-key detection exists (per-key request rate) with a documented mitigation.',
        'TTLs are jittered and stampede protection is tested with a cold cache.',
        'Node loss is rehearsed: the ring rebalance keeps p99 within the SLO.',
      ],
      crates: ['hashring', 'moka', 'tokio', 'fred'],
      github: [
        { name: 'hashring-rs: consistent hashing ring', url: 'https://github.com/jeromefroe/hashring-rs' },
        { name: 'moka: concurrent in-memory caches with coalescing', url: 'https://github.com/moka-rs/moka' },
      ],
      pitfall: 'Caching a None or error result with the same TTL as a hit: one transient database error pins a "missing" answer for every caller until the entry expires.',
      resources: [
        { title: 'hashring crate documentation: add, remove, get', url: 'https://docs.rs/hashring/latest/hashring/', kind: 'docs' },
        { title: 'moka: try_get_with and single-flight cache loading', url: 'https://docs.rs/moka/latest/moka/', kind: 'docs' },
        { title: 'In Search of an Understandable Consensus Algorithm (Raft)', url: 'https://raft.github.io/raft.pdf', kind: 'paper' },
        { title: 'redis.io: SET with expiry options', url: 'https://redis.io/docs/latest/commands/set/', kind: 'docs' },
      ],
    },
    {
      id: 'u19',
      n: 19,
      title: 'Rate limiter: GCRA, keyed limits, and honest 429s',
      minutes: 100,
      level: 'advanced',
      goal: 'Enforce per-tenant limits with a GCRA limiter in-process, keep a global limit in Redis, and return a 429 whose Retry-After a client can obey.',
      sections: [
        {
          h: 'Smooth limiting without a window boundary',
          p: [
            'A fixed window counter allows 100 requests at 11:59:59 and another 100 at 12:00:00, so a client can push 200 in two seconds while every window looks compliant. A sliding window fixes the boundary but needs a timestamp per request. GCRA (the generic cell rate algorithm) stores one timestamp per key: it tracks the theoretical arrival time of the next request and rejects anything that would arrive earlier than the configured interval allows.',
            'The two parameters are average rate and burst. Burst is what users experience: a quota of 20/s with burst 20 lets a dashboard load 20 requests at once and then throttles to one every 50 ms. Setting burst to 1 gives perfectly smooth output and terrible bursty-client behaviour, so the burst size is a product decision, not a default to copy.',
          ],
          code: `use governor::{clock::DefaultClock, Quota, RateLimiter};
use nonzero_ext::nonzero;

/// One limiter, keyed by tenant: 20 requests/second average, burst 20.
pub struct TenantLimiter {
    inner: RateLimiter<String, governor::state::keyed::DefaultKeyedStateStore<String>, DefaultClock>,
}

impl TenantLimiter {
    pub fn new() -> Self {
        Self {
            inner: RateLimiter::keyed(Quota::per_second(nonzero!(20u32))),
        }
    }

    /// Weighted check: a bulk endpoint costs more than a single read.
    pub fn check(&self, tenant: &str, cost: u32) -> Result<(), std::time::Duration> {
        let cost = std::num::NonZeroU32::new(cost.max(1)).expect("max(1) is non-zero");
        match self.inner.check_key_n(&tenant.to_string(), cost) {
            Ok(()) => Ok(()),
            Err(not_until) => {
                let now = governor::clock::Clock::now(&DefaultClock::default());
                Err(not_until.wait_time_from(now))
            }
        }
    }
}`,
          tip: 'check_key_n charges n cells atomically; charging n single checks lets a concurrent request slip into the gap between them.',
        },
        {
          h: 'Two tiers: local fast path, global truth',
          p: [
            'Per-instance limiter state is cheap and has no network hop, but with ten replicas a 20/s tenant actually gets 200/s. The usual compromise is a local limiter at limit/replicas plus a Redis check only when the local one is close to exhaustion - most requests never touch Redis, and the global limit still holds. Paying a Redis round trip on every request is how a rate limiter becomes your p99.',
            'The Redis side must be atomic or the check-then-increment race lets twice the limit through under concurrency. A Lua script runs atomically on the server: trim the window, count, compare, and append in one script. Use the sorted-set sliding window when you need accuracy per request; use the two-bucket counter when you need to bound memory on very high-cardinality keys.',
          ],
          code: `-- KEYS[1] = ratelimit:<tenant>:<route>
-- ARGV[1] = limit, ARGV[2] = window_ms, ARGV[3] = now_ms, ARGV[4] = request_id
local key    = KEYS[1]
local limit  = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local now    = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local used = redis.call('ZCARD', key)

if used >= limit then
    -- return the ms until the oldest request leaves the window
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    return -1 * (tonumber(oldest[2]) + window - now)
end

redis.call('ZADD', key, now, ARGV[4])
redis.call('PEXPIRE', key, window)
return limit - used - 1`,
          tip: 'Return the wait time from the script, not a boolean: the caller needs it for Retry-After, and computing it twice invites skew.',
        },
        {
          h: 'A 429 is a contract, not an error page',
          p: [
            'The response must tell the client when to come back. `Retry-After` in seconds is the interoperable form; `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` make the client\'s backoff adaptive instead of binary. Always send the same headers on successful responses too, or clients cannot pace themselves before hitting the wall.',
            'Never retry inside the server on a 429 - the limit exists to shed load, and internal retries convert a fast rejection into a queue that exhausts the pool. Also decide what the key is: per tenant for fairness, per token for abuse, per route for protecting an expensive endpoint. A single global key makes one noisy customer everyone\'s problem.',
          ],
          list: [
            'Retry-After in seconds, rounded up, plus the RateLimit-* headers',
            'Separate limits per route class: reads, writes, expensive exports',
            'Fail open only for the local tier, never for the global one, and log the choice',
            'Alert on the ratio of 429s per tenant; a spike is either abuse or a misconfigured client',
          ],
        },
      ],
      exercise: {
        prompt: 'Add a weighted check so a `/export` request costs 20 cells while `/items` costs 1, and return 429 with Retry-After and RateLimit headers when the tenant is over budget.',
        starter: `pub async fn guard(
    limiter: Arc<TenantLimiter>,
    tenant: String,
    cost: u32,
) -> Result<(), ApiError> {
    // TODO: call check, map Err(wait) to a 429 with Retry-After
    todo!()
}`,
        hint: 'Round the wait duration up to whole seconds (ceiling, not floor) and set it as a string header. Also send RateLimit-Remaining on success so clients can pace themselves.',
        solution: `use axum::http::{header, HeaderValue, StatusCode};

pub async fn guard(
    limiter: std::sync::Arc<TenantLimiter>,
    tenant: String,
    cost: u32,
) -> Result<(), ApiError> {
    match limiter.check(&tenant, cost) {
        Ok(()) => Ok(()),
        Err(wait) => {
            let seconds = wait.as_secs() + u64::from(wait.subsec_nanos() > 0);
            Err(ApiError {
                status: StatusCode::TOO_MANY_REQUESTS,
                headers: vec![
                    (header::RETRY_AFTER, HeaderValue::from_str(&seconds.to_string()).unwrap()),
                ],
                message: format!("rate limit exceeded; retry in {seconds}s"),
            })
        }
    }
}

// the layer adds the informational headers on success as well:
// RateLimit-Limit: 20, RateLimit-Remaining: <n>, RateLimit-Reset: <seconds>`,
      },
      questions: [
        {
          q: 'What does the burst parameter control in a GCRA/token-bucket limiter?',
          options: [
            'The total number of requests allowed per day',
            'How many requests may arrive back to back before the average rate applies',
            'The size of the Redis key',
            'How long a rejected request waits before retrying',
          ],
          answer: 1,
          explain: 'Burst is the bucket depth. It absorbs a legitimate spike (a dashboard loading twenty calls) while the average rate still bounds sustained traffic.',
        },
        {
          q: 'Why run the check-and-increment as a Redis Lua script?',
          options: [
            'Lua is faster than the network',
            'The script executes atomically, so concurrent checks cannot both see the same count',
            'Lua scripts bypass the Redis memory limit',
            'It lets you avoid setting an expiry on the key',
          ],
          answer: 1,
          explain: 'A separate GET then INCR has a race: a hundred concurrent requests can all read the same count and all pass. A script sees a consistent state for its whole execution.',
        },
        {
          q: 'A handler receives 429 from its own limiter. What should the server do?',
          options: [
            'Retry with backoff until the limit resets',
            'Return the 429 to the caller with Retry-After',
            'Increase the limit temporarily for that tenant',
            'Queue the request and process it later',
          ],
          answer: 1,
          explain: 'The point of shedding load is to shed it. Server-side retries turn a fast rejection into a queue, and the queue becomes the outage the limiter was meant to prevent.',
        },
      ],
      quickbytes: [
        'GCRA stores one timestamp per key; fixed windows allow 2x burst at the boundary.',
        'check_key_n charges a weighted cost atomically - never n separate checks.',
        'Retry-After is seconds, rounded up, and belongs on every 429.',
        'Local limiter at limit/replicas, Redis only near exhaustion, or you will rate-limit your own p99.',
      ],
      production: [
        'Limits are defined per route class and per tenant, with burst sizes chosen deliberately.',
        '429 responses carry Retry-After and RateLimit-* headers; clients are documented against them.',
        'The Redis script returns the wait time, and clock skew is bounded by using server time.',
        'The local tier fails open, the global tier fails closed, and both choices are logged.',
        'Dashboards show 429 rate per tenant and per route, with an alert on sustained spikes.',
      ],
      crates: ['governor', 'fred', 'axum', 'nonzero_ext'],
      github: [
        { name: 'governor: GCRA rate limiting for Rust', url: 'https://github.com/boinkor-net/governor' },
        { name: 'fred: a Redis client for Rust', url: 'https://github.com/aembke/fred.rs' },
      ],
      pitfall: 'Rate limiting on the client IP behind a load balancer without reading the forwarded header: every request appears to come from one address and the first busy tenant throttles everyone.',
      resources: [
        { title: 'governor: Quota, RateLimiter, and keyed limiters', url: 'https://docs.rs/governor/latest/governor/', kind: 'docs' },
        { title: 'tower_governor: rate limiting as a tower layer for axum', url: 'https://docs.rs/tower_governor/latest/tower_governor/', kind: 'docs' },
        { title: 'fred: Redis client with Lua script support', url: 'https://docs.rs/fred/latest/fred/', kind: 'docs' },
        { title: 'Redis channel: caching, rate limiting, and Lua patterns', url: 'https://www.youtube.com/@RedisInc', kind: 'video' },
      ],
    },
    {
      id: 'u20',
      n: 20,
      title: 'Log aggregator: durable ingest, time-segmented storage',
      minutes: 120,
      level: 'industry',
      goal: 'Accept logs without dropping them, write time-segmented immutable files, and answer a time-range query by touching only the segments that can contain matches.',
      sections: [
        {
          h: 'Acknowledge only after the bytes are durable',
          p: [
            'Log ingest looks like the easiest endpoint in the system and is the one that loses data. If the handler returns 200 as soon as the record is in an in-memory channel, a crash loses whatever was buffered - and the logs you lose are always the ones around the crash. The honest pipeline is: receive, append to a write-ahead file, fsync (or batch-fsync with a bounded delay), then acknowledge.',
            'Batching is how you afford the fsync. Accumulate records until 1 MB or 50 ms, whichever comes first, then write once and acknowledge the whole batch. A bounded channel between the HTTP handler and the writer applies backpressure: when it is full, return 503 rather than buffering without limit, because an unbounded ingest queue is just a slower way to lose the same data.',
          ],
          code: `use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};

pub struct Ingest {
    tx: mpsc::Sender<Batch>,
}

pub struct Record {
    pub ts_millis: i64,
    pub service: Arc<str>,
    pub level: u8,
    pub line: String,
}

pub struct Batch {
    pub records: Vec<Record>,
    pub ack: oneshot::Sender<()>,
}

impl Ingest {
    /// Returns 503 when the writer cannot keep up: bounded queue, visible
    /// backpressure, no silent buffering.
    pub async fn submit(&self, records: Vec<Record>) -> Result<(), IngestFull> {
        let (ack, done) = oneshot::channel();
        self.tx
            .try_send(Batch { records, ack })
            .map_err(|_| IngestFull)?;
        // the handler awaits durability before returning 200
        done.await.map_err(|_| IngestFull)
    }
}`,
          tip: 'try_send plus an await on the ack gives you overload detection and durability in one path; a plain send hides overload until memory runs out.',
        },
        {
          h: 'Segments beat one big file',
          p: [
            'Append-only segments of a bounded size (say 128 MB) or a bounded time range (one hour) give you three things at once: retention is a directory delete, queries can skip whole segments using min/max timestamps, and a corrupted segment loses one hour instead of everything. The index is small: per segment, the time range, the byte range, and per-column min/max for the fields you filter on.',
            'Store the index separately from the data so a query can plan without opening files. A query for "errors from the checkout service between 10:00 and 10:05" reads the index, discards segments whose time range does not overlap, then reads only the matching byte ranges. Without that pruning, a thirty-day retention means scanning thirty days for a five-minute question - which is exactly how log systems get a reputation for being slow.',
          ],
          code: `use std::io::Write;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SegmentMeta {
    pub path: String,
    pub min_ts: i64,
    pub max_ts: i64,
    pub bytes: u64,
    pub services: Vec<String>,   // sorted, for pruning
    pub levels: u8,              // bitmask of levels present
}

pub struct SegmentWriter {
    file: std::fs::File,
    path: String,
    min_ts: i64,
    max_ts: i64,
    bytes: u64,
    services: std::collections::BTreeSet<String>,
    levels: u8,
    max_bytes: u64,
}

impl SegmentWriter {
    pub fn push(&mut self, rec: &Record) -> std::io::Result<Option<SegmentMeta>> {
        let line = serde_json::to_vec(rec).expect("record is serializable");
        self.file.write_all(&line)?;
        self.file.write_all(b"\\n")?;

        self.min_ts = self.min_ts.min(rec.ts_millis);
        self.max_ts = self.max_ts.max(rec.ts_millis);
        self.bytes += line.len() as u64 + 1;
        self.services.insert(rec.service.to_string());
        self.levels |= 1 << rec.level;

        if self.bytes >= self.max_bytes {
            self.file.sync_all()?;
            return Ok(Some(self.meta()));
        }
        Ok(None)
    }

    fn meta(&self) -> SegmentMeta {
        SegmentMeta {
            path: self.path.clone(),
            min_ts: self.min_ts,
            max_ts: self.max_ts,
            bytes: self.bytes,
            services: self.services.iter().cloned().collect(),
            levels: self.levels,
        }
    }
}`,
          tip: 'fsync at segment close, not per line; the durability unit is the segment, and the WAL covers the window in between.',
        },
        {
          h: 'Query planning and cardinality discipline',
          p: [
            'The planner is thirty lines: filter by time overlap, then by service, then by level bitmask, then read the survivors. Everything else is a full scan and should be rejected with a clear error rather than quietly taking forty seconds. If a query cannot prune to a bounded number of segments, tell the user to narrow the time range - that is a feature, not a limitation.',
            'Cardinality is the cost that kills log systems. Indexing `user_id` or `request_id` turns every unique value into an index entry, so storage grows faster than the logs themselves and compaction never catches up. Index the bounded fields (service, level, region, route template) and let the rest be searchable text within a segment. Drop debug-level logs at the collector in production, not at the query.',
          ],
          list: [
            'Plan by time first; every other filter is secondary',
            'Index only bounded-cardinality fields, keep the rest as searchable payload',
            'Retention is a directory policy per tier: 7 days hot, 90 days cold',
            'Reject unbounded queries with a message that says how to narrow them',
          ],
        },
      ],
      exercise: {
        prompt: 'Write `plan_segments` that selects candidate segments for a query with a time range, a service filter, and a minimum level, and returns an error when more than 20 segments would be scanned.',
        starter: `pub struct Query {
    pub from_ms: i64,
    pub to_ms: i64,
    pub service: Option<String>,
    pub min_level: Option<u8>,
}

pub fn plan_segments(index: &[SegmentMeta], q: &Query) -> Result<Vec<&SegmentMeta>, PlanError> {
    // TODO: prune by time, service, level; cap the number of segments
    todo!()
}`,
        hint: 'Overlap test is `seg.max_ts >= q.from_ms && seg.min_ts <= q.to_ms`. For level, compare bitmasks: reject when no bit at or above min_level is present.',
        solution: `#[derive(Debug, thiserror::Error)]
pub enum PlanError {
    #[error("query would scan {0} segments; narrow the time range to 20 or fewer")]
    TooBroad(usize),
}

pub fn plan_segments<'a>(
    index: &'a [SegmentMeta],
    q: &Query,
) -> Result<Vec<&'a SegmentMeta>, PlanError> {
    let level_mask: u8 = match q.min_level {
        Some(min) => ((1u16 << (min + 1)) - 1) as u8,
        None => u8::MAX,
    };

    let candidates: Vec<&SegmentMeta> = index
        .iter()
        .filter(|seg| seg.max_ts >= q.from_ms && seg.min_ts <= q.to_ms)
        .filter(|seg| match &q.service {
            Some(svc) => seg.services.binary_search(svc).is_ok(),
            None => true,
        })
        .filter(|seg| seg.levels & level_mask != 0)
        .collect();

    if candidates.len() > 20 {
        return Err(PlanError::TooBroad(candidates.len()));
    }
    Ok(candidates)
}`,
      },
      questions: [
        {
          q: 'Why acknowledge an ingest request only after the write is durable?',
          options: [
            'Because HTTP requires a synchronous response',
            'Because a crash between acknowledgement and write loses exactly the logs around the failure',
            'Because batching is impossible otherwise',
            'Because fsync makes the endpoint faster',
          ],
          answer: 1,
          explain: 'The logs most likely to be lost are the ones buffered when the process dies, which are the ones an incident investigation needs. Durability before the ack is the only fix.',
        },
        {
          q: 'What does segment-level min/max timestamps buy the query path?',
          options: [
            'Compression of the timestamp column',
            'The ability to skip segments that cannot contain matches',
            'Exact ordering across services',
            'Automatic index creation',
          ],
          answer: 1,
          explain: 'Pruning turns a retention-wide scan into a handful of file reads. Without it, every query costs the same as a full scan of all retained data.',
        },
        {
          q: 'Why is indexing request_id as a label a mistake?',
          options: [
            'It is not a string field',
            'Its cardinality is unbounded, so every value creates index entries',
            'Labels cannot contain digits',
            'It makes the query planner ignore time ranges',
          ],
          answer: 1,
          explain: 'Index size grows with distinct values. Unbounded fields belong in the searchable payload, not in the index that must stay small to remain useful.',
        },
      ],
      quickbytes: [
        'Ack after fsync, and batch to afford the fsync; 1 MB or 50 ms is a sane trigger.',
        'Bounded queue + try_send + 503 beats an unbounded ingest buffer every time.',
        'Segments by size or hour: retention becomes a delete, queries get pruning.',
        'Index bounded fields only; drop debug logs at the collector.',
      ],
      production: [
        'Ingest acknowledges only after the WAL or segment write is durable.',
        'Ingest queue is bounded and returns 503 with backpressure metrics exposed.',
        'Segments have a published size/time bound and a retention policy per tier.',
        'Queries are rejected when they would scan more than N segments.',
        'Index cardinality is reviewed: only bounded fields are indexed, with a documented list.',
      ],
      crates: ['axum', 'tokio', 'serde_json', 'object_store'],
      github: [
        { name: 'tracing - structured logging and spans for Rust', url: 'https://github.com/tokio-rs/tracing' },
        { name: 'object_store: segment storage over local disk or S3', url: 'https://github.com/apache/arrow-rs-object-store' },
      ],
      pitfall: 'Acking ingest as soon as the record hits an unbounded channel: throughput looks great in the load test, and every incident is missing the logs from the minute before it started.',
      resources: [
        { title: 'tracing crate: structured events, fields, and subscribers', url: 'https://docs.rs/tracing/latest/tracing/', kind: 'docs' },
        { title: 'tracing-subscriber: layered filtering and formatting', url: 'https://docs.rs/tracing-subscriber/latest/tracing_subscriber/', kind: 'docs' },
        { title: 'object_store: durable segment storage with conditional writes', url: 'https://docs.rs/object_store/latest/object_store/', kind: 'docs' },
        { title: 'Kafka documentation: partitioned, ordered, durable logs', url: 'https://kafka.apache.org/documentation/', kind: 'docs' },
      ],
    },
    // __TAIL__
  ],
};
