/**
 * Production web services track.
 *
 * Authored for the Rust Academy plugin. The data shape matches
 * src/data/foundations.mjs and is consumed as plain JSON by the client.
 *
 * Version baseline (checked against crates.io and docs.rs while authoring):
 * axum 0.8.9, tower-http 0.6.8, tokio 1.54, jsonwebtoken 11.1.0, utoipa 6.0,
 * thiserror 2.0. Path captures use the axum 0.8 brace syntax.
 */
export default {
  key: "web",
  prefix: "w",
  title: "Production web services",
  blurb: "Axum 0.8 services that survive real traffic: typed contracts, honest errors, middleware, auth, realtime feeds, stable API contracts, and tests.",
  level: "industry",
  project: {
    title: "Capstone: a hardened task-management API",
    brief: "Ship a versioned HTTP API for tasks: an axum 0.8 router with typed JSON contracts, RFC 9457 errors, traced middleware, JWT auth with roles, a WebSocket and SSE update feed, an OpenAPI document generated from code, and integration tests that run in CI.",
    deliverables: [
      "A router with nested /api/v1 and /api/v2 trees sharing one state type",
      "problem+json responses for every failure the API can produce, with tests per status code",
      "JWT auth with role checks plus a WebSocket and SSE feed backed by one broadcast channel",
      "An OpenAPI document generated from the handler types, served at /openapi.json",
      "oneshot integration tests and a testcontainers-backed repository suite running in CI"
    ],
    stack: [
      "axum",
      "tokio",
      "tower",
      "tower-http",
      "serde",
      "serde_json",
      "thiserror",
      "jsonwebtoken",
      "utoipa",
      "tracing",
      "tracing-subscriber",
      "uuid",
      "sqlx"
    ]
  },
  lessons: [
    {
      id: "w01",
      n: 1,
      title: "Axum 0.8 routing and composition",
      minutes: 60,
      level: "core",
      goal: "Compose routers from nested subtrees, bind path parameters with the brace syntax, and inject shared state without globals.",
      sections: [
        {
          h: "A router is a value you compose",
          p: [
            "Router::new() builds a value that maps a method plus path to a handler. You compose routers with route, nest and merge, then hand the result to axum::serve. There is no global route registry and no startup scan of annotations.",
            "Because the router is a value, main and your integration tests can share one constructor. Keep that constructor free of side effects so every test builds a fresh router over test-specific state."
          ],
          code: `use axum::{routing::get, Router};

async fn health() -> &'static str {
    "ok"
}

fn app() -> Router {
    Router::new()
        .route("/health", get(health))
        .nest("/api/v1", users_api())
}

fn users_api() -> Router {
    Router::new()
        .route("/users", get(list_users))
        .route("/users/{id}", get(get_user))
}

async fn list_users() -> &'static str {
    "[]"
}

async fn get_user(axum::extract::Path(id): axum::extract::Path<u64>) -> String {
    format!("user {id}")
}

#[tokio::main]
async fn main() {
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080")
        .await
        .expect("bind 8080");
    axum::serve(listener, app()).await.expect("serve");
}`
        },
        {
          h: "Path parameters use braces in 0.8",
          p: [
            "axum 0.8 is built on matchit 0.8, which captures segments as {name}. The 0.7 form with a leading colon panics while the router is being built, so the error appears at startup or in the first test rather than under production traffic.",
            "One Path extractor captures several segments at once. A struct with named fields is clearer than a tuple past two parameters, and serde names the field that failed to parse."
          ],
          code: `use axum::{extract::Path, routing::get, Router};
use serde::Deserialize;

#[derive(Deserialize)]
struct UserTeam {
    user_id: u64,
    team_id: u64,
}

async fn show(Path(UserTeam { user_id, team_id }): Path<UserTeam>) -> String {
    format!("user {user_id} in team {team_id}")
}

fn app() -> Router {
    Router::new().route("/users/{user_id}/teams/{team_id}", get(show))
}`,
          tip: "Percent-encoded segments are decoded before deserialization. If the decoded bytes are not valid UTF-8, Path rejects the request with 400 instead of handing you a broken string."
        },
        {
          h: "State is injected, not global",
          p: [
            "Shared dependencies arrive through the State<T> extractor. T must be Clone, so the payload is normally an Arc of cheap handles or a pool type that is itself cheap to clone.",
            "Call .with_state(state) once, after routes are merged. Nested routers inherit the state, which lets subtree functions avoid naming the concrete type while handlers still extract State<AppState>."
          ],
          code: `use axum::{extract::State, routing::get, Router};

#[derive(Clone)]
struct AppState {
    pool: sqlx::PgPool,
    version: &'static str,
}

async fn get_version(State(state): State<AppState>) -> String {
    state.version.to_string()
}

fn app(state: AppState) -> Router {
    Router::new()
        .route("/version", get(get_version))
        .with_state(state)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let pool = sqlx::PgPool::connect(&std::env::var("DATABASE_URL")?).await?;
    let app = app(AppState { pool, version: "1.0.0" });
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await?;
    axum::serve(listener, app).await?;
    Ok(())
}`
        },
        {
          h: "Nesting, merging, and fallbacks",
          p: [
            "nest mounts a subtree under a prefix and strips that prefix before matching inside. merge splices two routers at the same level, which is how you build one router from feature modules that do not share a prefix.",
            "A fallback on a nested router handles misses inside that prefix only. That is how /api can return problem+json 404s while the rest of the site returns HTML, and a method mismatch on an existing path still returns 405 with an Allow header."
          ],
          code: `use axum::{
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json,
    Router,
};

async fn api_not_found() -> impl IntoResponse {
    (StatusCode::NOT_FOUND, Json(serde_json::json!({ "status": 404 })))
}

async fn users() -> &'static str {
    "[]"
}

fn app() -> Router {
    let api = Router::new()
        .route("/users", get(users))
        .fallback(api_not_found);

    Router::new()
        .nest("/api/v1", api)
        .route("/health", get(|| async { "ok" }))
}`,
          tip: "nest strips the prefix, so handler URIs inside the subtree are relative. Build absolute URLs from configuration, not from the nested prefix string you passed in."
        }
      ],
      exercise: {
        prompt: "Extend the router with a nested /api/v1 subtree serving GET /tasks and GET /tasks/{id}, plus a problem+json 404 fallback for that subtree. Handlers may return fixed data.",
        starter: `use axum::{routing::get, Router};

async fn health() -> &'static str { "ok" }

fn app() -> Router {
    // 1. add the health route
    // 2. nest /api/v1 -> tasks_api()
    Router::new()
}

fn tasks_api() -> Router {
    // add /tasks and /tasks/{id}, then a fallback
    Router::new()
}

#[tokio::main]
async fn main() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000").await.unwrap();
    axum::serve(listener, app()).await.unwrap();
}`,
        hint: "Routes belong to the nested router, so tasks_api owns .route(\"/tasks\", get(list_tasks)). The fallback takes a handler such as async fn api_404() -> (StatusCode, Json<serde_json::Value>).",
        solution: `use axum::{
    extract::Path,
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json,
    Router,
};

async fn health() -> &'static str {
    "ok"
}

async fn list_tasks() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "items": [] }))
}

async fn get_task(Path(id): Path<u64>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "id": id, "title": "Ship it" }))
}

async fn api_404() -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({
            "type": "about:blank",
            "title": "Not found",
            "status": 404
        })),
    )
}

fn tasks_api() -> Router {
    Router::new()
        .route("/tasks", get(list_tasks))
        .route("/tasks/{id}", get(get_task))
        .fallback(api_404)
}

fn app() -> Router {
    Router::new()
        .route("/health", get(health))
        .nest("/api/v1", tasks_api())
}

#[tokio::main]
async fn main() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000").await.unwrap();
    axum::serve(listener, app()).await.unwrap();
}`
      },
      questions: [
        {
          q: "Which route string matches /users/42 in axum 0.8?",
          options: ["/users/:id", "/users/{id}", "/users/<id>", "/users/[id]"],
          answer: 1,
          explain: "axum 0.8 uses matchit 0.8, which captures segments with braces. The 0.7 colon syntax panics while the router is built."
        },
        {
          q: "Where should .with_state(state) be called?",
          options: ["On every handler", "Once on the composed router, after routes are added", "Before Router::new()", "Inside a static initializer"],
          answer: 1,
          explain: "State is attached once to the composed router. Nested routers inherit it, and handlers extract State<T>."
        }
      ],
      production: [
        "Keep exactly one app(state) constructor used by both main and every integration test.",
        "Give each mounted prefix its own fallback so API 404s never fall through to an HTML handler.",
        "Treat /tasks and /tasks/ as different routes; decide the convention and test it.",
        "Add a startup check that the state is built once and cloned, not rebuilt per request."
      ],
      crates: ["axum", "tokio", "serde", "serde_json"],
      pitfall: "Copying :id routes from an axum 0.7 tutorial. The router panics while it is built (the capture syntax must be {id}), which is loud in tests but easy to miss if nothing builds the router at startup.",
      quickbytes: [
        "cargo add axum && cargo add tokio --features full; axum 0.8 captures path segments with braces: .route(\"/users/{id}\", get(show)).",
        "Nest strips the prefix and merge splices routers at one level. Give each API subtree its own .fallback(...) that returns problem+json.",
        "Call .with_state(state) once on the composed router after routes are merged; nested routers inherit it and handlers still extract State<AppState>."
      ],
      github: [
        {
          name: "tokio-rs/axum",
          url: "https://github.com/tokio-rs/axum"
        },
        {
          name: "tokio-rs/tokio",
          url: "https://github.com/tokio-rs/tokio"
        }
      ],
      resources: [
        {
          title: "axum 0.8 Path extractor reference",
          url: "https://docs.rs/axum/0.8.9/axum/extract/struct.Path.html",
          kind: "docs"
        },
        {
          title: "axum Router API reference",
          url: "https://docs.rs/axum/0.8.9/axum/struct.Router.html",
          kind: "docs"
        },
        {
          title: "axum repository examples",
          url: "https://github.com/tokio-rs/axum/tree/main/examples",
          kind: "repo"
        },
        {
          title: "Let's Get Rusty - Rust tutorials (YouTube)",
          url: "https://www.youtube.com/@letsgetrusty",
          kind: "video"
        }
      ]
    },
    {
      id: "w02",
      n: 2,
      title: "Extractors and typed request contracts",
      minutes: 75,
      level: "core",
      goal: "Turn handler arguments into typed, validated request contracts, and translate every extractor rejection into your own error envelope.",
      sections: [
        {
          h: "Handler arguments are the contract",
          p: [
            "Every handler argument is an extractor. All but the last must implement FromRequestParts, which borrows from the request without consuming the body; only the final argument may implement FromRequest and take the body.",
            "That single rule explains the most common compile error: placing Json<T> before another extractor. Put the body extractor last, or destructure a tuple where it is the last element."
          ],
          code: `use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CreateTask {
    title: String,
    #[serde(default)]
    priority: u8,
    assignee_email: Option<String>,
}

#[derive(Serialize)]
struct Task {
    id: i64,
    title: String,
    priority: u8,
}

async fn create_task(
    State(state): State<AppState>,
    Path(board_id): Path<i64>,
    Json(body): Json<CreateTask>,
) -> Result<(StatusCode, Json<Task>), ApiError> {
    let task = state.tasks.create(board_id, body).await?;
    Ok((StatusCode::CREATED, Json(task)))
}`
        },
        {
          h: "Query, path, and body are separate types",
          p: [
            "Do not reuse the database row as the request DTO. Query and Path deserialize from strings, so pick strict types (u32, Uuid) rather than String and let serde reject nonsense before your handler runs.",
            "deny_unknown_fields belongs on JSON bodies, not on query structs: clients add cache-busting parameters, and rejecting those turns a harmless request into a 400."
          ],
          code: `use serde::Deserialize;

#[derive(Deserialize)]
struct ListParams {
    #[serde(default = "default_limit")]
    limit: u32,
    after: Option<String>,
    #[serde(default)]
    include_done: bool,
}

fn default_limit() -> u32 {
    50
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CreateTask {
    title: String,
    #[serde(default)]
    priority: u8,
    assignee_email: Option<String>,
}`,
          tip: "Give Query structs a default for every field you can. A missing query parameter is then a normal request, while a missing JSON field stays a rejection."
        },
        {
          h: "A custom extractor for the tenant",
          p: [
            "When every handler needs the same value, extract it once. Implement FromRequestParts, return your own error type, and axum will call IntoResponse on the rejection, so a bad tenant header produces the same problem+json shape as everything else.",
            "Extractors that need state take it through FromRef. That keeps a subtree unaware of the full AppState type while still giving the extractor the data it needs."
          ],
          code: `use axum::{
    extract::FromRequestParts,
    http::request::Parts,
};

#[derive(Clone)]
pub struct Tenant(pub String);

impl<S> FromRequestParts<S> for Tenant
where
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let tenant = parts
            .headers
            .get("x-tenant-id")
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.len() <= 64)
            .ok_or(ApiError::Invalid("missing or invalid x-tenant-id".into()))?;
        Ok(Tenant(tenant.to_owned()))
    }
}

// When the extractor needs configuration, add a bound:
//     Config: FromRef<S>
// and fetch it with Config::from_ref(state) inside from_request_parts.`
        },
        {
          h: "Map rejections instead of accepting defaults",
          p: [
            "axum rejections such as JsonRejection and QueryRejection already carry a status and a text body. That text is fine for debugging and wrong for clients: it does not match your envelope and can drift between axum versions.",
            "Take the rejection as a handler argument of type Result<Json<T>, JsonRejection> and translate it. Extraction happens before the handler body, so you never observe a half-parsed payload."
          ],
          code: `use axum::{
    extract::rejection::JsonRejection,
    http::StatusCode,
    Json,
    response::IntoResponse,
};

async fn create_task(
    payload: Result<Json<CreateTask>, JsonRejection>,
) -> impl IntoResponse {
    let Json(body) = match payload {
        Ok(json) => json,
        Err(rejection) => {
            return ApiError::Invalid(rejection.body_text()).into_response();
        }
    };
    if body.title.trim().is_empty() {
        return ApiError::Invalid("title must not be empty".into()).into_response();
    }
    (StatusCode::CREATED, Json(body.title)).into_response()
}`,
          tip: "Rejections expose status() and body_text(). Log the rejection at debug level and return your own message so internal serde paths do not leak into responses."
        }
      ],
      exercise: {
        prompt: "Add a Pagination query type with a default limit of 50 and a hard cap of 100, plus a validation method that returns a problem+json 422 when limit is out of range. Show the handler signature.",
        starter: `use serde::Deserialize;

#[derive(Deserialize)]
struct Pagination {
    limit: Option<u32>,
    after: Option<String>,
}

// TODO: add a validated() method
// TODO: use Query<Pagination> in a handler and map the error

async fn list_tasks(/* extractors */) -> Result<(), ApiError> {
    todo!()
}`,
        hint: "Unwrap the limit with query.limit.unwrap_or(50), compare against the 1..=100 range, and return ApiError::Unprocessable(String) on failure. The handler keeps Query<Pagination> among the FromRequestParts arguments.",
        solution: `use axum::{
    extract::Query,
    Json,
};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct Pagination {
    limit: Option<u32>,
    after: Option<String>,
}

#[derive(Serialize)]
struct Page<T> {
    items: Vec<T>,
    next_cursor: Option<String>,
}

impl Pagination {
    fn validated(&self) -> Result<u32, ApiError> {
        let limit = self.limit.unwrap_or(50);
        if !(1..=100).contains(&limit) {
            return Err(ApiError::Unprocessable(
                "limit must be between 1 and 100".into(),
            ));
        }
        Ok(limit)
    }
}

async fn list_tasks(
    Query(query): Query<Pagination>,
) -> Result<Json<Page<String>>, ApiError> {
    let _limit = query.validated()?;
    let _after = query.after.as_deref();
    Ok(Json(Page { items: Vec::new(), next_cursor: None }))
}`
      },
      questions: [
        {
          q: "Which handler argument may consume the request body?",
          options: ["Any argument, in any position", "Only the last argument", "Only the first argument", "Only arguments implementing FromRequestParts"],
          answer: 1,
          explain: "Every argument before the last must implement FromRequestParts. The body can be consumed once, so the body extractor goes last."
        },
        {
          q: "Why keep deny_unknown_fields off a Query struct?",
          options: ["It disables serde defaults", "Clients often send extra query parameters and would get 400s", "It fails to compile on query structs", "It makes the struct non-Send"],
          answer: 1,
          explain: "Caches, analytics, and SDKs add query parameters. Strictness belongs on JSON bodies, where unknown fields usually mean a client bug."
        }
      ],
      production: [
        "Keep request DTOs separate from database rows and response DTOs; rename with serde instead of leaking column names.",
        "Cap and validate every page size in one helper so endpoints cannot drift apart.",
        "Return one error envelope for body, query, and path rejections; assert the content-type in tests.",
        "Log rejection bodies at debug level only, and never echo serde internals to clients."
      ],
      crates: ["axum", "serde", "serde_json"],
      pitfall: "Taking Json<T> as a non-final argument: the handler fails to compile with a FromRequest vs FromRequestParts mismatch, and teams work around it by pulling the body out manually instead of moving the extractor last.",
      quickbytes: [
        "Keep the body extractor last: Json<T> is only legal as the final handler argument; everything before it must implement FromRequestParts.",
        "Accept payload: Result<Json<T>, JsonRejection>, then map rejection.body_text() into your own problem+json -- never echo axum's text.",
        "Put #[serde(default)] on every optional query field and keep deny_unknown_fields off Query structs; caches and SDKs add parameters."
      ],
      github: [
        {
          name: "serde-rs/serde",
          url: "https://github.com/serde-rs/serde"
        },
        {
          name: "tokio-rs/axum",
          url: "https://github.com/tokio-rs/axum"
        }
      ],
      resources: [
        {
          title: "axum extractors module",
          url: "https://docs.rs/axum/0.8.9/axum/extract/index.html",
          kind: "docs"
        },
        {
          title: "FromRequestParts trait",
          url: "https://docs.rs/axum/0.8.9/axum/extract/trait.FromRequestParts.html",
          kind: "docs"
        },
        {
          title: "serde container and field attributes",
          url: "https://docs.rs/serde/latest/serde/",
          kind: "docs"
        },
        {
          title: "fasterthanlime - Rust videos (YouTube)",
          url: "https://www.youtube.com/@fasterthanlime",
          kind: "video"
        }
      ]
    },
    {
      id: "w03",
      n: 3,
      title: "Errors as responses with problem+json",
      minutes: 80,
      level: "advanced",
      goal: "Model failures with thiserror, render them as RFC 9457 problem+json with the right status codes, and keep panics out of the request path.",
      sections: [
        {
          h: "One error enum per boundary",
          p: [
            "Handlers return Result<T, ApiError>. The enum models what can go wrong at the HTTP boundary, with variants for not-found, conflicts, invalid input, and an opaque internal variant.",
            "Use thiserror for Display and the ? conversion from infrastructure errors, but do not expose the source error in the response. The transport layer logs the source; the client gets a stable, non-leaking message."
          ],
          code: `use thiserror::Error;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("task {0} not found")]
    NotFound(i64),
    #[error("invalid request: {0}")]
    Invalid(String),
    #[error("unprocessable request: {0}")]
    Unprocessable(String),
    #[error("task {0} changed since it was read")]
    Conflict(i64),
    #[error("unauthorized")]
    Unauthorized,
    #[error("forbidden")]
    Forbidden,
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("internal error")]
    Internal,
}`
        },
        {
          h: "IntoResponse turns the enum into bytes",
          p: [
            "Implement IntoResponse once. Map each variant to a status, a stable type string, a short title, and a detail that is safe to show. RFC 9457 defines the members: type, title, status, detail, and instance.",
            "Set content-type to application/problem+json explicitly. Axum's Json extractor sets application/json, so the media type has to be overwritten after building the response."
          ],
          code: `use axum::{
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use utoipa::ToSchema;

#[derive(Debug, Serialize, ToSchema)]
pub struct Problem {
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    pub status: u16,
    pub detail: String,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, kind, title) = match &self {
            ApiError::NotFound(_) => (StatusCode::NOT_FOUND, "task-not-found", "Task not found"),
            ApiError::Invalid(_) => (StatusCode::BAD_REQUEST, "invalid-request", "Invalid request"),
            ApiError::Unprocessable(_) => (StatusCode::UNPROCESSABLE_ENTITY, "unprocessable", "Unprocessable request"),
            ApiError::Conflict(_) => (StatusCode::CONFLICT, "conflict", "Task changed"),
            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized", "Unauthorized"),
            ApiError::Forbidden => (StatusCode::FORBIDDEN, "forbidden", "Forbidden"),
            ApiError::Database(source) => {
                tracing::error!(error = %source, "database failure");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal", "Internal error")
            }
            ApiError::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "internal", "Internal error"),
        };

        let detail = match &self {
            ApiError::NotFound(id) => format!("task {id} does not exist"),
            ApiError::Invalid(message) | ApiError::Unprocessable(message) => message.clone(),
            ApiError::Conflict(id) => format!("task {id} was modified, refetch and retry"),
            ApiError::Unauthorized | ApiError::Forbidden | ApiError::Internal => {
                "request cannot be completed".to_owned()
            }
            ApiError::Database(_) => "request failed".to_owned(),
        };

        let problem = Problem {
            kind: kind.to_owned(),
            title: title.to_owned(),
            status: status.as_u16(),
            detail,
        };
        let mut response = (status, Json(problem)).into_response();
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/problem+json"),
        );
        response
    }
}`
        },
        {
          h: "The status code is a decision, not a default",
          p: [
            "Pick the code from the semantics of the failure, then keep it stable across releases: clients and dashboards encode behaviour against it. Returning 500 for everything hides retryable failures and pages on-call for user mistakes."
          ],
          code: `// 400 malformed syntax or unparsable input
// 401 missing, expired, or invalid credentials; send WWW-Authenticate
// 403 caller is authenticated but lacks the role or permission
// 404 resource is absent (also used to hide another tenant's resource)
// 409 state conflict: optimistic-lock miss, idempotency-key body mismatch
// 422 syntactically valid but semantically invalid (negative limit)
// 429 rate limited; include Retry-After
// 500 unexpected bug; log with a request id, never show the source
// 503 dependency unavailable; set Retry-After when the outage is bounded`,
          tip: "409 and 422 look interchangeable until a client implements retry. Use 409 for a conflict with current state and 422 for a request that can never succeed as written."
        },
        {
          h: "Panics are not error handling",
          p: [
            "When a handler panics, the request is aborted and the client sees a 500 with no useful body. Side effects already started keep running or get dropped mid-flight, and the panic is only visible if a subscriber or a panic hook captures it.",
            "Indexing, unwrap on a parse, and division by zero are the usual sources. CatchPanicLayer converts a panic into a response so a single bad request does not abort the connection, but it cannot undo partial work."
          ],
          code: `use tower_http::catch_panic::CatchPanicLayer;

let app = app.layer(CatchPanicLayer::new());`,
          tip: "Treat a panic as a bug with a failing test, not as a control path. CatchPanicLayer is a blast door, not a strategy."
        }
      ],
      exercise: {
        prompt: "Add a RateLimited { retry_after_secs: u64 } variant, map it to 429 with a Retry-After header, and make sure the 500 branch logs the source error while the body stays generic.",
        starter: `// Variant to add:
// #[error("rate limited")]
// RateLimited { retry_after_secs: u64 }

// Then extend IntoResponse:
//  - status 429, kind "rate-limited", title "Too many requests"
//  - insert header::RETRY_AFTER with the number of seconds
//  - detail stays short and safe`,
        hint: "Build the response with (status, Json(problem)).into_response(), then use response.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_str(&secs.to_string()).unwrap()) before returning it.",
        solution: `use axum::{
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, kind, title) = match &self {
            ApiError::RateLimited { .. } => {
                (StatusCode::TOO_MANY_REQUESTS, "rate-limited", "Too many requests")
            }
            ApiError::NotFound(_) => (StatusCode::NOT_FOUND, "task-not-found", "Task not found"),
            ApiError::Database(source) => {
                tracing::error!(error = %source, "database failure");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal", "Internal error")
            }
            _ => (StatusCode::INTERNAL_SERVER_ERROR, "internal", "Internal error"),
        };

        let detail = match &self {
            ApiError::RateLimited { retry_after_secs } => {
                format!("retry after {retry_after_secs} seconds")
            }
            _ => "request cannot be completed".to_owned(),
        };

        let problem = Problem {
            kind: kind.to_owned(),
            title: title.to_owned(),
            status: status.as_u16(),
            detail,
        };
        let mut response = (status, Json(problem)).into_response();
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/problem+json"),
        );
        if let ApiError::RateLimited { retry_after_secs } = &self {
            let value = HeaderValue::from_str(&retry_after_secs.to_string())
                .expect("decimal seconds are a valid header value");
            response.headers_mut().insert(header::RETRY_AFTER, value);
        }
        response
    }
}`
      },
      questions: [
        {
          q: "Which status fits a valid request that is semantically impossible, such as limit=1000 with a cap of 100?",
          options: ["400", "409", "422", "500"],
          answer: 2,
          explain: "422 means the request parsed but cannot be processed as written. 400 is malformed syntax and 409 is a conflict with current state."
        },
        {
          q: "What should the client-visible detail say for an internal error?",
          options: ["The sqlx error and the SQL statement", "A generic message, while the source is logged", "A full stack trace", "The database connection string"],
          answer: 1,
          explain: "Internal details leak schema and infrastructure. Log the source with a request id and return a stable message."
        }
      ],
      production: [
        "Keep one module that owns status mapping and test it with a table of variant to status cases.",
        "Log 5xx with the source error and the request id; log 4xx at info level without stack noise.",
        "Never include SQL, connection strings, or upstream responses in a client-visible detail field.",
        "Install a panic hook and CatchPanicLayer, then alert on the panic counter instead of relying on 500 rates."
      ],
      crates: ["thiserror", "axum", "serde", "serde_json", "tracing", "tower-http", "utoipa", "sqlx"],
      pitfall: "Mapping every error to 500 because the error type has a #[from] conversion. Clients cannot tell a retryable 503 from a validation mistake, and on-call gets paged for 422s.",
      quickbytes: [
        "Build the response with (status, Json(problem)).into_response(), then overwrite CONTENT_TYPE with HeaderValue::from_static(\"application/problem+json\").",
        "Status table: 409 for state conflicts, 422 for impossible requests, 429 plus Retry-After, 503 when a bounded dependency outage will clear.",
        "cargo add tower-http --features catch-panic, then .layer(CatchPanicLayer::new()) once; keep a panic hook so the payload is still logged."
      ],
      github: [
        {
          name: "dtolnay/thiserror",
          url: "https://github.com/dtolnay/thiserror"
        },
        {
          name: "tokio-rs/axum",
          url: "https://github.com/tokio-rs/axum"
        }
      ],
      resources: [
        {
          title: "thiserror derive documentation",
          url: "https://docs.rs/thiserror/latest/thiserror/",
          kind: "docs"
        },
        {
          title: "axum IntoResponse trait",
          url: "https://docs.rs/axum/0.8.9/axum/response/trait.IntoResponse.html",
          kind: "docs"
        },
        {
          title: "tower-http CatchPanicLayer",
          url: "https://docs.rs/tower-http/0.6.8/tower_http/catch_panic/struct.CatchPanicLayer.html",
          kind: "docs"
        },
        {
          title: "Jon Gjengset - Rust deep dives (YouTube)",
          url: "https://www.youtube.com/@jonhoo",
          kind: "video"
        },
        {
          title: "Simple Testing Can Prevent Most Critical Failures (OSDI 2014)",
          url: "https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-yuan.pdf",
          kind: "paper"
        }
      ]
    },
    {
      id: "w04",
      n: 4,
      title: "tower and tower-http middleware",
      minutes: 85,
      level: "advanced",
      goal: "Stack request-scoped middleware in a deliberate order: tracing, request IDs, CORS, compression, and a timeout that actually bounds the handler.",
      sections: [
        {
          h: "A layer transforms a service",
          p: [
            "A tower::Layer wraps a service and returns another service. Middleware sees the request on the way in and the response on the way out, which is why auth, timeouts, compression, and tracing are all expressible as layers.",
            "Use tower::ServiceBuilder when order matters. Layers apply in declaration order, so the first layer listed is the outermost: it sees the request first and the response last."
          ],
          code: `use std::time::Duration;
use axum::{http::StatusCode, Router};
use tower::ServiceBuilder;
use tower_http::{
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    timeout::TimeoutLayer,
    trace::TraceLayer,
};

let middleware = ServiceBuilder::new()
    .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
    .layer(TraceLayer::new_for_http())
    .layer(PropagateRequestIdLayer::x_request_id())
    .layer(TimeoutLayer::with_status_code(
        StatusCode::REQUEST_TIMEOUT,
        Duration::from_secs(10),
    ));

let app = Router::new().merge(api).layer(middleware);`,
          tip: "Chained Router::layer calls are easier to get backwards than ServiceBuilder because each call wraps the existing stack. When order is load-bearing, pass one ServiceBuilder."
        },
        {
          h: "What TraceLayer actually does",
          p: [
            "TraceLayer opens a span per request and emits events when the response or failure is classified. It does not print anything by itself: a tracing subscriber with an EnvFilter is what turns those events into logs.",
            "The default classifier records latency and status for every response, including health checks. Customise with DefaultOnResponse and DefaultOnFailure to add method, route, and trace identifiers, and skip noisy probes."
          ],
          code: `use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

tracing_subscriber::registry()
    .with(
        EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "info,tower_http=debug".into()),
    )
    .with(tracing_subscriber::fmt::layer().json())
    .init();`,
          tip: "The json() layer needs the json feature on tracing-subscriber. Structured logs are what let you filter by request id in production instead of grepping free text."
        },
        {
          h: "Request IDs correlate logs across services",
          p: [
            "SetRequestIdLayer generates an id and stores it in the request headers; PropagateRequestIdLayer copies it to the response so a client can quote it in a bug report. Put the set layer outside the trace layer so the span can see the id.",
            "If an ingress proxy already sets X-Request-Id, trust it only when the proxy overwrites client-supplied values. Otherwise a caller controls your correlation id and can pollute the logs."
          ],
          code: `use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use axum::http::HeaderName;

let request_id = HeaderName::from_static("x-request-id");

let layers = tower::ServiceBuilder::new()
    .layer(SetRequestIdLayer::new(request_id.clone(), MakeRequestUuid))
    .layer(PropagateRequestIdLayer::new(request_id));`
        },
        {
          h: "CORS, compression, limits, and timeouts",
          p: [
            "CorsLayer::permissive() is for local development. Production needs an explicit origin list, and allow_credentials only with concrete origins, never with a wildcard. Preflight requests must reach CORS before auth, or browsers see an auth failure instead of a CORS answer.",
            "CompressionLayer negotiates zstd, brotli, or gzip from Accept-Encoding and skips already-compressed bodies. Put the timeout outside every handler-level layer so it bounds the token check and the database call, not just the last function in the chain."
          ],
          code: `use axum::http::{header, HeaderValue};
use tower_http::{
    compression::CompressionLayer,
    cors::{Any, CorsLayer},
    limit::RequestBodyLimitLayer,
};

let cors = CorsLayer::new()
    .allow_origin(HeaderValue::from_static("https://app.example.com"))
    .allow_methods(Any)
    .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE, header::ACCEPT])
    .max_age(std::time::Duration::from_secs(600));

let app = app
    .layer(RequestBodyLimitLayer::new(1024 * 1024))
    .layer(CompressionLayer::new())
    .layer(cors);`,
          tip: "tower-http's TimeoutLayer returns the status you configure with an empty body. If your API contract promises problem+json everywhere, document 408 or map it in a response-shaping layer."
        }
      ],
      exercise: {
        prompt: "Attach a request-ID plus tracing stack and a 5 second timeout to a router whose /slow handler sleeps 10 seconds, then prove with a oneshot test that the response is 408 and not a hung connection.",
        starter: `use axum::{routing::get, Router};

async fn slow() -> &'static str {
    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    "done"
}

fn app() -> Router {
    // add SetRequestIdLayer + TraceLayer, then the timeout last
    Router::new().route("/slow", get(slow))
}`,
        hint: "TimeoutLayer::with_status_code(StatusCode::REQUEST_TIMEOUT, Duration::from_secs(5)) gives the status you assert. In the test, tokio::time::pause plus a short sleep keeps the test fast.",
        solution: `use axum::{http::StatusCode, routing::get, Router};
use std::time::Duration;
use tower::ServiceExt;
use tower_http::{
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    timeout::TimeoutLayer,
    trace::TraceLayer,
};

async fn slow() -> &'static str {
    tokio::time::sleep(Duration::from_secs(10)).await;
    "done"
}

fn app() -> Router {
    let layers = tower::ServiceBuilder::new()
        .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
        .layer(TraceLayer::new_for_http())
        .layer(PropagateRequestIdLayer::x_request_id())
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(5),
        ));

    Router::new().route("/slow", get(slow)).layer(layers)
}

#[tokio::test]
async fn slow_route_times_out() {
    let request = axum::http::Request::builder()
        .uri("/slow")
        .body(axum::body::Body::empty())
        .unwrap();

    let response = app().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::REQUEST_TIMEOUT);
    assert!(response.headers().contains_key("x-request-id"));
}`
      },
      questions: [
        {
          q: "In tower::ServiceBuilder, which layer sees the request first?",
          options: ["The layer declared last", "The layer declared first", "The layer with the longest name", "Order is unspecified"],
          answer: 1,
          explain: "ServiceBuilder applies layers in declaration order, so the first listed is outermost: it sees the request first and the response last."
        },
        {
          q: "Why must the timeout wrap the auth layer?",
          options: ["Otherwise it bounds only the layers inside it", "Otherwise it does nothing at all", "Because tower requires timeouts outermost", "Because auth layers cannot be timed"],
          answer: 0,
          explain: "A timeout covers only what it wraps. If auth runs outside it, a slow token check is unbounded."
        }
      ],
      production: [
        "Order layers deliberately and write a comment explaining why the timeout is outside auth and the database call.",
        "Emit the request id in every log line and return it on every response, including errors.",
        "Set an explicit CORS origin list; allow_credentials with a wildcard origin is rejected by browsers and hides the bug in development.",
        "Cap request bodies below your memory budget and make the limit part of the public API docs."
      ],
      crates: ["tower", "tower-http", "axum", "tracing", "tracing-subscriber"],
      pitfall: "Adding TimeoutLayer with Router::layer after the routes but inside the auth layer. Slow token verification then escapes the timeout, and the p99 alert fires on the auth service instead of the handler.",
      quickbytes: [
        "cargo add tower-http --features trace,request-id,cors,compression,timeout,limit covers the full production middleware set.",
        ".layer(SetRequestIdLayer::x_request_id(MakeRequestUuid)) outside TraceLayer; PropagateRequestIdLayer copies the id onto every response.",
        "In tower::ServiceBuilder the first layer is outermost: it sees the request first and the response last, so list the timeout first."
      ],
      github: [
        {
          name: "tower-rs/tower-http",
          url: "https://github.com/tower-rs/tower-http"
        },
        {
          name: "tower-rs/tower",
          url: "https://github.com/tower-rs/tower"
        }
      ],
      resources: [
        {
          title: "tower-http trace module",
          url: "https://docs.rs/tower-http/0.6.8/tower_http/trace/index.html",
          kind: "docs"
        },
        {
          title: "tower-http CORS layer",
          url: "https://docs.rs/tower-http/0.6.8/tower_http/cors/index.html",
          kind: "docs"
        },
        {
          title: "tower-http timeout module",
          url: "https://docs.rs/tower-http/0.6.8/tower_http/timeout/index.html",
          kind: "docs"
        },
        {
          title: "tower-http request-id module",
          url: "https://docs.rs/tower-http/0.6.8/tower_http/request_id/index.html",
          kind: "docs"
        },
        {
          title: "RustVideos - Rust conference talks (YouTube)",
          url: "https://www.youtube.com/@RustVideos",
          kind: "video"
        }
      ]
    },
    {
      id: "w05",
      n: 5,
      title: "JWT authentication and authorization",
      minutes: 90,
      level: "industry",
      goal: "Issue and verify JWTs with jsonwebtoken 11, enforce roles and object ownership, and understand the token failure modes that matter in production.",
      sections: [
        {
          h: "A JWT is a signed envelope, not a session",
          p: [
            "A JWT is base64url-encoded claims plus a signature. Anyone holding it can read the payload, so claims may contain a subject id, roles, scopes, an issuer, and timestamps, and nothing that would be dangerous if leaked.",
            "Keep access tokens short lived, five to fifteen minutes, and pair them with a refresh token stored in an HttpOnly cookie. Assume a stolen access token is valid until expiry; a short expiry is what limits the damage."
          ],
          code: `// Access token payload, HS256 signed:
// {
//   "sub": "user_42",
//   "roles": ["member"],
//   "iss": "https://auth.example.com",
//   "aud": "tasks-api",
//   "iat": 1767225600,
//   "exp": 1767226500
// }
//
// The signature proves the payload was issued by a holder of the key.
// It says nothing about whether the user is still allowed in.`,
          tip: "Do not put email addresses, plan names, or permission lists in claims you never re-check. A claim is a cached fact that stays true until expiry."
        },
        {
          h: "jsonwebtoken 11 needs a crypto provider",
          p: [
            "In jsonwebtoken 11 the signing backend sits behind a CryptoProvider. Enable the rust_crypto or aws_lc_rs feature and install the provider once at startup; calling encode or decode before it is installed returns a runtime error rather than a compile error.",
            "Pin the algorithm explicitly in both directions. Encoding with HS256 and validating a token whose header says RS256 must fail, not fall back to the header value."
          ],
          code: `use jsonwebtoken::{crypto::rust_crypto, Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub roles: Vec<String>,
    pub aud: String,
    pub iss: String,
    pub iat: usize,
    pub exp: usize,
}

pub fn install_crypto_provider() {
    rust_crypto::DEFAULT_PROVIDER
        .install_default()
        .expect("crypto provider installed twice");
}

pub fn issue_token(secret: &[u8], user_id: &str) -> jsonwebtoken::errors::Result<String> {
    let now = jsonwebtoken::get_current_timestamp() as usize;
    let claims = Claims {
        sub: user_id.to_owned(),
        roles: vec!["member".to_owned()],
        aud: "tasks-api".to_owned(),
        iss: "https://auth.example.com".to_owned(),
        iat: now,
        exp: now + 900,
    };
    jsonwebtoken::encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret),
    )
}`
        },
        {
          h: "Verify, then authorize",
          p: [
            "Verification checks the signature, the issuer, the audience, the expiry, and the algorithm. Only after that do you decide whether the subject may perform the action.",
            "Implement an AuthUser extractor so handlers name the requirement in their signature. Handler code then works with typed claims instead of parsing headers repeatedly."
          ],
          code: `use axum::{
    extract::{FromRef, FromRequestParts},
    http::{header, request::Parts},
};
use jsonwebtoken::{Algorithm, DecodingKey, Validation};

#[derive(Clone)]
pub struct JwtKeys {
    pub secret: Vec<u8>,
}

pub struct AuthUser {
    pub id: String,
    pub roles: Vec<String>,
}

pub fn verify(secret: &[u8], token: &str) -> Result<Claims, ApiError> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_issuer(&["https://auth.example.com"]);
    validation.set_audience(&["tasks-api"]);
    validation.leeway = 30;

    let data = jsonwebtoken::decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret),
        &validation,
    )
    .map_err(|_| ApiError::Unauthorized)?;
    Ok(data.claims)
}

impl<S> FromRequestParts<S> for AuthUser
where
    JwtKeys: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let keys = JwtKeys::from_ref(state);
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .ok_or(ApiError::Unauthorized)?;
        let claims = verify(&keys.secret, token)?;
        Ok(AuthUser { id: claims.sub, roles: claims.roles })
    }
}`,
          tip: "Leeway absorbs clock skew between services. Thirty seconds is plenty; a five-minute leeway quietly extends every token and every revocation delay."
        },
        {
          h: "Authorization is a second decision",
          p: [
            "Authentication answers who is calling. Authorization answers whether this subject may touch this object, and that check belongs next to the data: filter by owner in the query instead of loading first and comparing afterwards.",
            "Return 401 when credentials are missing or invalid and include WWW-Authenticate. Return 403 when the caller is known but insufficiently privileged. For another tenant's object, prefer 404 so the API does not confirm that the id exists."
          ],
          code: `use axum::{extract::State, http::StatusCode, Json};

async fn delete_task(
    AuthUser { id, roles }: AuthUser,
    State(state): State<AppState>,
    axum::extract::Path(task_id): axum::extract::Path<i64>,
) -> Result<StatusCode, ApiError> {
    if !roles.iter().any(|role| role == "admin" || role == "owner") {
        return Err(ApiError::Forbidden);
    }
    // Ownership is enforced in SQL, not after a read:
    // DELETE FROM tasks WHERE id = $1 AND owner_id = $2
    let deleted = state.tasks.delete_owned(task_id, &id).await?;
    if deleted == 0 {
        return Err(ApiError::NotFound(task_id));
    }
    Ok(StatusCode::NO_CONTENT)
}`,
          tip: "Revocation is the hard part. Keep TTLs short, store a jti denylist only for high-value tokens, and rotate signing keys with a kid header rather than keeping one secret forever."
        }
      ],
      exercise: {
        prompt: "Write an AuthUser extractor and a require_role helper, then protect /admin/tasks so it returns 401 without a token and 403 for an authenticated user without the admin role.",
        starter: `use axum::{extract::FromRequestParts, http::request::Parts};

pub struct AuthUser {
    pub id: String,
    pub roles: Vec<String>,
}

// 1. implement FromRequestParts for AuthUser using JwtKeys: FromRef<S>
// 2. add fn require_role(user: &AuthUser, role: &str) -> Result<(), ApiError>
// 3. use both in an /admin/tasks handler`,
        hint: "Strip the Bearer prefix from AUTHORIZATION, call verify, and map any jsonwebtoken error to ApiError::Unauthorized. require_role returns Err(ApiError::Forbidden) when the role is absent.",
        solution: `use axum::{
    extract::FromRequestParts,
    http::{header, request::Parts},
};

pub struct AuthUser {
    pub id: String,
    pub roles: Vec<String>,
}

impl AuthUser {
    pub fn require_role(&self, role: &str) -> Result<(), ApiError> {
        if self.roles.iter().any(|candidate| candidate == role) {
            Ok(())
        } else {
            Err(ApiError::Forbidden)
        }
    }
}

impl<S> FromRequestParts<S> for AuthUser
where
    JwtKeys: axum::extract::FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let keys = JwtKeys::from_ref(state);
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .ok_or(ApiError::Unauthorized)?;
        let claims = verify(&keys.secret, token)?;
        Ok(AuthUser { id: claims.sub, roles: claims.roles })
    }
}

async fn admin_tasks(user: AuthUser) -> Result<&'static str, ApiError> {
    user.require_role("admin")?;
    Ok("[]")
}`
      },
      questions: [
        {
          q: "How do you stop a JWT from becoming a long-lived credential?",
          options: ["Use long expiries and rely on the signature", "Use short access-token TTLs plus refresh tokens", "Store roles in the token and never expire it", "Put the password in the payload"],
          answer: 1,
          explain: "A signed token is valid until it expires, so short TTLs limit the damage of theft. Refresh tokens carry the long-lived session."
        },
        {
          q: "What must jsonwebtoken 11 have before encode or decode works?",
          options: ["An installed CryptoProvider from the rust_crypto or aws_lc_rs feature", "A global signing key", "A tokio runtime", "An include_bytes! call"],
          answer: 0,
          explain: "The signing backend is pluggable. Install DEFAULT_PROVIDER once at startup, or encode and decode fail at runtime."
        }
      ],
      production: [
        "Install the crypto provider once, before the server accepts traffic, and fail startup if installation fails.",
        "Validate issuer, audience, expiry, and algorithm on every token; never derive the validation algorithm from the token header.",
        "Enforce object ownership in the SQL predicate, and return 404 rather than 403 for cross-tenant ids.",
        "Rotate signing keys with a kid header, and keep a denylist only for tokens that must die before expiry."
      ],
      crates: ["jsonwebtoken", "axum", "serde", "serde_json"],
      pitfall: "Skipping the crypto provider install because tests use a mock verifier: the first real token encode in staging panics or errors at runtime, after the auth path looked green in unit tests.",
      quickbytes: [
        "cargo add jsonwebtoken --features rust_crypto, then install rust_crypto::DEFAULT_PROVIDER.install_default() before serving any traffic.",
        "Validation::new(Algorithm::HS256) plus set_issuer, set_audience, and leeway 30; never take the algorithm from the token header.",
        "exp = iat + 900 caps theft damage. Enforce ownership with ... WHERE id = $1 AND owner_id = $2 and return 404 when zero rows change."
      ],
      github: [
        {
          name: "Keats/jsonwebtoken",
          url: "https://github.com/Keats/jsonwebtoken"
        },
        {
          name: "tokio-rs/axum",
          url: "https://github.com/tokio-rs/axum"
        }
      ],
      resources: [
        {
          title: "jsonwebtoken 11 crate documentation",
          url: "https://docs.rs/jsonwebtoken/11.1.0/jsonwebtoken/",
          kind: "docs"
        },
        {
          title: "jsonwebtoken Validation options",
          url: "https://docs.rs/jsonwebtoken/11.1.0/jsonwebtoken/struct.Validation.html",
          kind: "docs"
        },
        {
          title: "jsonwebtoken repository",
          url: "https://github.com/Keats/jsonwebtoken",
          kind: "repo"
        },
        {
          title: "axum FromRequestParts for auth extractors",
          url: "https://docs.rs/axum/0.8.9/axum/extract/trait.FromRequestParts.html",
          kind: "docs"
        },
        {
          title: "Let's Get Rusty - Rust tutorials (YouTube)",
          url: "https://www.youtube.com/@letsgetrusty",
          kind: "video"
        }
      ]
    },
    {
      id: "w06",
      n: 6,
      title: "Realtime with WebSockets and SSE",
      minutes: 90,
      level: "industry",
      goal: "Serve live updates over WebSockets and SSE with one tokio broadcast fan-out, and decide explicitly what happens to slow consumers.",
      sections: [
        {
          h: "Choose the transport before the protocol",
          p: [
            "WebSockets give bidirectional frames over one connection. SSE gives a one-way server stream over plain HTTP, with browser reconnection and Last-Event-ID built into the EventSource API. A feed that only notifies clients usually wants SSE.",
            "Both need heartbeats to survive idle-connection timeouts. A WebSocket Ping every 30 seconds or an SSE keep-alive comment stops a load balancer with a 60 second idle timeout from cutting quiet connections."
          ],
          code: `// WebSocket: client sends messages, server pushes, one TCP connection.
// SSE: server pushes text/event-stream frames, client reconnects on drop.
//
// Browser support: EventSource is built in; WebSocket needs no library either.
// Cost: SSE is one long HTTP response, so it composes with normal proxies and auth.

let app = Router::new()
    .route("/ws", get(ws_handler))
    .route("/events", get(sse_handler));`
        },
        {
          h: "WebSocket upgrade in axum 0.8",
          p: [
            "WebSocketUpgrade consumes the request and gives you the socket inside on_upgrade. Set limits before upgrading: maximum message size, maximum frame size, and a write buffer that matches your fan-out rate.",
            "In axum 0.8 a text message is Message::Text(Utf8Bytes), not a String, which is why the code converts through to_text or uses the Message::text constructor when sending."
          ],
          code: `use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
};
use tokio::sync::broadcast::error::RecvError;

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.max_message_size(64 * 1024)
        .on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: AppState) {
    let mut events = state.events.subscribe();
    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(message)) => {
                    if let Ok(text) = message.to_text() {
                        let _ = state.events.send(text.to_owned());
                    }
                }
                Some(Err(_)) | None => break,
            },
            event = events.recv() => match event {
                Ok(text) => {
                    if socket.send(Message::text(text)).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(skipped)) => {
                    tracing::warn!(skipped, "websocket consumer lagged");
                }
                Err(RecvError::Closed) => break,
            },
        }
    }
}`
        },
        {
          h: "Fan-out with tokio broadcast",
          p: [
            "broadcast::channel(capacity) gives every subscriber its own cursor into a ring buffer. A consumer that falls more than capacity messages behind receives Lagged(n) on the next recv and skips ahead; the publisher is never blocked.",
            "That is the right default for feeds: one slow phone must not stall the writer. Decide the policy explicitly: log and continue for non-critical updates, disconnect the client when it must refetch, or emit a resync event carrying full state."
          ],
          code: `use tokio::sync::broadcast;

#[derive(Clone)]
struct AppState {
    events: broadcast::Sender<String>,
}

#[tokio::main]
async fn main() {
    let (events, _) = broadcast::channel::<String>(256);
    let state = AppState { events };
    // one sender in state; each connection calls state.events.subscribe()
    let _ = state;
}`,
          tip: "Capacity is measured in messages, not bytes. A chat payload of 1 KB with capacity 256 means up to 256 KB buffered per slow subscriber before Lagged kicks in."
        },
        {
          h: "SSE from the same fan-out",
          p: [
            "Sse::new takes a Stream of Result<Event, E> and streams it as text/event-stream. Each connection needs its own receiver, so create it with subscribe() inside the handler, not at router construction time.",
            "Keep-alives are mandatory behind proxies. Add Cache-Control: no-store and disable proxy buffering (for nginx, X-Accel-Buffering: no); otherwise events arrive in one burst when the connection closes."
          ],
          code: `use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::stream;
use std::{convert::Infallible, time::Duration};
use tokio::sync::broadcast::{error::RecvError, Sender};

fn task_events(
    sender: Sender<String>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let receiver = sender.subscribe();
    let events = stream::unfold(receiver, |mut receiver| async move {
        loop {
            match receiver.recv().await {
                Ok(payload) => {
                    let event = Event::default().event("task").data(payload);
                    return Some((Ok(event), receiver));
                }
                Err(RecvError::Lagged(skipped)) => {
                    tracing::warn!(skipped, "sse consumer lagged");
                }
                Err(RecvError::Closed) => return None,
            }
        }
    });

    Sse::new(events).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    )
}`,
          tip: "Last-Event-ID only helps if you keep a replay buffer. Without one, tell clients that a reconnect should refetch state instead of resuming from an id you cannot honour."
        }
      ],
      exercise: {
        prompt: "Implement /ws so every received text is broadcast to all connected clients, and treat a lagged consumer by sending a resync notice and closing the socket. Share one channel through AppState.",
        starter: `use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, State},
    response::IntoResponse,
};
use tokio::sync::broadcast;

#[derive(Clone)]
struct AppState {
    events: broadcast::Sender<String>,
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle(socket, state))
}

async fn handle(_socket: WebSocket, _state: AppState) {
    // subscribe, select over socket.recv() and receiver.recv()
}`,
        hint: "Keep the loop from the lesson. On RecvError::Lagged, send Message::text(\"resync\") then break; on RecvError::Closed just break.",
        solution: `use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
};
use tokio::sync::broadcast::{self, error::RecvError};

#[derive(Clone)]
struct AppState {
    events: broadcast::Sender<String>,
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.max_message_size(64 * 1024)
        .on_upgrade(move |socket| handle(socket, state))
}

async fn handle(mut socket: WebSocket, state: AppState) {
    let mut events = state.events.subscribe();
    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(message)) => {
                    if let Ok(text) = message.to_text() {
                        let _ = state.events.send(text.to_owned());
                    }
                }
                Some(Err(_)) | None => break,
            },
            event = events.recv() => match event {
                Ok(text) => {
                    if socket.send(Message::text(text)).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(skipped)) => {
                    tracing::warn!(skipped, "slow websocket consumer, closing");
                    let _ = socket.send(Message::text("resync")).await;
                    break;
                }
                Err(RecvError::Closed) => break,
            },
        }
    }
}`
      },
      questions: [
        {
          q: "What does a broadcast receiver return when it falls too far behind?",
          options: ["Err(RecvError::Lagged(n))", "Err(RecvError::Closed)", "It blocks the publisher", "A truncated message"],
          answer: 0,
          explain: "The receiver skips ahead and reports how many messages it missed. The publisher is never blocked, which is the point of bounded fan-out."
        },
        {
          q: "Where should the broadcast sender live?",
          options: ["One per WebSocket handler", "In shared state, created once at startup", "In a static mut", "One per request"],
          answer: 1,
          explain: "Every connection subscribes to the same sender. A per-handler channel gives each client a private channel with no fan-out."
        }
      ],
      production: [
        "Create the broadcast channel once in AppState; a per-connection channel silently delivers nothing to other clients.",
        "Send heartbeats below the shortest idle timeout in your infrastructure, and measure the gap after deploys.",
        "Choose the slow-consumer policy in writing: continue with gaps, disconnect, or resync, and instrument lag counters.",
        "Limit WebSocket message size and frame size so one client cannot allocate unbounded memory per message."
      ],
      crates: ["axum", "tokio", "futures-util", "tracing", "serde_json"],
      pitfall: "Building the broadcast channel inside the WebSocket handler. Each connection then owns a private channel, clients appear connected, and nobody receives anybody else's messages.",
      quickbytes: [
        "Create broadcast::channel(256) once in AppState; every connection calls state.events.subscribe() -- never build a channel per handler.",
        "On RecvError::Lagged(n): log n (or send a resync frame) and continue; the publisher is never blocked, so make the policy explicit in code.",
        "SSE needs KeepAlive::new().interval(Duration::from_secs(15)), plus Cache-Control: no-store and X-Accel-Buffering: no behind nginx."
      ],
      github: [
        {
          name: "tokio-rs/tokio",
          url: "https://github.com/tokio-rs/tokio"
        },
        {
          name: "tokio-rs/axum",
          url: "https://github.com/tokio-rs/axum"
        }
      ],
      resources: [
        {
          title: "axum WebSocket module",
          url: "https://docs.rs/axum/0.8.9/axum/extract/ws/index.html",
          kind: "docs"
        },
        {
          title: "axum SSE response",
          url: "https://docs.rs/axum/0.8.9/axum/response/sse/index.html",
          kind: "docs"
        },
        {
          title: "tokio broadcast channel",
          url: "https://docs.rs/tokio/1.54.1/tokio/sync/broadcast/index.html",
          kind: "docs"
        },
        {
          title: "axum websocket example",
          url: "https://github.com/tokio-rs/axum/tree/main/examples/websockets",
          kind: "repo"
        },
        {
          title: "Jon Gjengset - Rust deep dives (YouTube)",
          url: "https://www.youtube.com/@jonhoo",
          kind: "video"
        }
      ]
    },
    {
      id: "w07",
      n: 7,
      title: "API contracts, versioning, and idempotency",
      minutes: 85,
      level: "industry",
      goal: "Generate OpenAPI from the code with utoipa 6, version the surface without breaking clients, and design keyset pagination and idempotent writes.",
      sections: [
        {
          h: "utoipa 6 generates the document from the code",
          p: [
            "utoipa reads types and handler attributes at compile time. ToSchema produces components, the path attribute produces an operation, and the OpenApi derive assembles the document you serve as JSON.",
            "The generated document is only as good as the annotations. Add a test that parses /openapi.json and asserts every public route appears, so a new handler cannot ship undocumented."
          ],
          code: `use axum::{extract::Path, routing::get, Json, Router};
use utoipa::{OpenApi, ToSchema};

#[derive(ToSchema, serde::Serialize, serde::Deserialize)]
struct Task {
    id: i64,
    title: String,
    done: bool,
}

#[utoipa::path(
    get,
    path = "/tasks/{id}",
    params(("id" = i64, Path, description = "Task id")),
    responses(
        (status = 200, description = "Task found", body = Task),
        (status = 404, description = "Task not found", body = Problem)
    )
)]
async fn get_task(Path(id): Path<i64>) -> Result<Json<Task>, ApiError> {
    // Problem is the RFC 9457 body from the errors module; it derives ToSchema.
    Err(ApiError::NotFound(id))
}

#[derive(OpenApi)]
#[openapi(
    paths(get_task),
    components(schemas(Task, Problem)),
    tags((name = "tasks", description = "Task management"))
)]
struct ApiDoc;

fn app() -> Router {
    Router::new()
        .route("/tasks/{id}", get(get_task))
        .route("/openapi.json", get(|| async { Json(ApiDoc::openapi()) }))
}`,
          tip: "utoipa 6 targets OpenAPI 3.2. If a downstream gateway only accepts 3.0, validate the generated document there before assuming it will import."
        },
        {
          h: "Versioning that survives real clients",
          p: [
            "Put the major version in the path: /v1. Inside a version, restrict changes to additive ones: new optional fields, new endpoints, and new response headers. Renaming a field or changing a type is a new major version.",
            "When removal is unavoidable, announce it with Deprecation and Sunset response headers, run both behaviours behind a flag, and delete the old branch only after traffic telemetry shows zero callers."
          ],
          code: `use axum::http::{HeaderValue, Response};

// Additive inside v1: safe.
// Add a field, add an endpoint, add a new optional query parameter.

// Breaking: removal, rename, type change, stricter validation.
// => /v2, or a documented deprecation window.

fn deprecate(mut response: Response<axum::body::Body>, sunset: &'static str) -> Response<axum::body::Body> {
    response.headers_mut().insert(
        axum::http::header::HeaderName::from_static("sunset"),
        HeaderValue::from_static(sunset),
    );
    response
}`,
          tip: "Enum variants are a versioning trap. A client that rejects unknown variants breaks the day you add one; document whether clients must ignore unknown values before you ship one."
        },
        {
          h: "Keyset pagination instead of offsets",
          p: [
            "OFFSET degrades as pages get deeper and skips or repeats rows when writes land between requests. Keyset pagination asks for rows after a cursor: WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT $3.",
            "Return an opaque cursor built from the last row's sort key plus a has_more flag. Index the exact tuple you sort by, and treat a malformed cursor as a 400 with your problem+json envelope."
          ],
          code: `use base64::Engine as _;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct PageQuery {
    limit: Option<u32>,
    after: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Cursor {
    created_at_ms: i64,
    id: i64,
}

fn decode_cursor(raw: &str) -> Result<Cursor, ApiError> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| ApiError::Invalid("after cursor is not valid base64".into()))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::Invalid("after cursor is not valid JSON".into()))
}

fn page_limit(query: &PageQuery) -> Result<u32, ApiError> {
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::Invalid("limit must be between 1 and 100".into()));
    }
    Ok(limit)
}`,
          tip: "Sorting by created_at alone is not stable when two rows share a timestamp. Add the primary key to the sort and to the cursor, or pages will occasionally duplicate a row."
        },
        {
          h: "Idempotency keys for unsafe retries",
          p: [
            "A client that times out after a POST cannot know whether the write happened. Accept an Idempotency-Key header, store the key with a hash of the request body and the stored response, and replay that response on retry.",
            "Make the key unique per tenant in the database so two concurrent retries cannot both insert. The loser reads the existing row and returns the same response. Expire keys after a day and return 422 when the same key arrives with a different body."
          ],
          code: `use axum::http::HeaderMap;

async fn create_task(
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let key = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .filter(|value| (16..=128).contains(&value.len()))
        .ok_or(ApiError::Invalid("idempotency-key header is required".into()))?;

    // Storage contract:
    //   UNIQUE (tenant_id, idempotency_key)
    //   columns: request_hash, status_code, response_json, created_at
    // 1. INSERT ... ON CONFLICT DO NOTHING
    // 2. if inserted, run the write and store the response
    // 3. if not inserted, compare request_hash and replay the stored response
    let _ = (key, state);
    Ok(Json(serde_json::json!({ "status": "stored" })))
}`,
          tip: "Hash the canonicalised body, not the raw bytes: JSON key order and whitespace differ between retries from different SDKs, and a byte hash falsely reports a mismatch."
        }
      ],
      exercise: {
        prompt: "Add a keyset cursor to GET /tasks: accept limit and after, cap the limit at 100, return items plus next_cursor, and reject a bad cursor with a 400 problem+json.",
        starter: `use axum::extract::Query;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct PageQuery {
    limit: Option<u32>,
    after: Option<String>,
}

#[derive(Serialize)]
struct TaskPage {
    items: Vec<String>,
    next_cursor: Option<String>,
}

async fn list_tasks(Query(query): Query<PageQuery>) -> Result<axum::Json<TaskPage>, ApiError> {
    todo!()
}`,
        hint: "Validate the limit, decode the cursor when present, and build next_cursor only when the page is full. Reuse decode_cursor and page_limit from the lesson.",
        solution: `use axum::{extract::Query, Json};
use base64::Engine as _;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct PageQuery {
    limit: Option<u32>,
    after: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Cursor {
    created_at_ms: i64,
    id: i64,
}

#[derive(Serialize)]
struct TaskRow {
    id: i64,
    title: String,
    created_at_ms: i64,
}

#[derive(Serialize)]
struct TaskPage {
    items: Vec<String>,
    next_cursor: Option<String>,
}

fn page_limit(query: &PageQuery) -> Result<usize, ApiError> {
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::Unprocessable(
            "limit must be between 1 and 100".into(),
        ));
    }
    Ok(limit as usize)
}

fn decode_cursor(raw: &str) -> Result<Cursor, ApiError> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| ApiError::Invalid("after is not valid base64".into()))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::Invalid("after is not valid JSON".into()))
}

fn encode_cursor(row: &TaskRow) -> Result<String, ApiError> {
    let cursor = Cursor { created_at_ms: row.created_at_ms, id: row.id };
    let bytes = serde_json::to_vec(&cursor).map_err(|_| ApiError::Internal)?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

async fn list_tasks(
    Query(query): Query<PageQuery>,
) -> Result<Json<TaskPage>, ApiError> {
    let limit = page_limit(&query)?;
    let _cursor = match query.after.as_deref() {
        Some(raw) => Some(decode_cursor(raw)?),
        None => None,
    };

    // Repository call: fetch limit + 1 rows so has_more needs no second query.
    // SELECT id, title, created_at_ms FROM tasks
    // WHERE ($cursor IS NULL OR (created_at_ms, id) < ($1, $2))
    // ORDER BY created_at_ms DESC, id DESC
    // LIMIT $limit + 1
    let mut rows: Vec<TaskRow> = Vec::new();

    let has_more = rows.len() > limit;
    rows.truncate(limit);

    let next_cursor = match (has_more, rows.last()) {
        (true, Some(last)) => Some(encode_cursor(last)?),
        _ => None,
    };

    Ok(Json(TaskPage {
        items: rows.into_iter().map(|row| row.title).collect(),
        next_cursor,
    }))
}`,
      },
      questions: [
        {
          q: "Why does keyset pagination beat OFFSET for deep pages?",
          options: ["It returns fewer columns", "It stays an index range scan and is stable while rows change", "It removes the need for authentication", "It removes the need for indexes"],
          answer: 1,
          explain: "OFFSET scans and discards rows and shifts when data changes. A cursor on the sort key becomes a range scan with stable results."
        },
        {
          q: "What belongs in an idempotency record?",
          options: ["Only the key", "The key, a hash of the request body, and the stored response", "The client IP address", "A copy of the access token"],
          answer: 1,
          explain: "The body hash detects key reuse with a different payload, and the stored response lets a retry replay the original result."
        }
      ],
      production: [
        "Serve the generated OpenAPI document and assert in CI that every registered route appears in it.",
        "Write the versioning policy down: which changes are additive, who approves a major bump, and how long deprecations run.",
        "Keep cursors opaque and validated; never expose a SQL predicate or a raw timestamp to clients.",
        "Enforce idempotency keys with a database constraint, not an in-process map that dies with the pod."
      ],
      crates: ["utoipa", "axum", "serde", "serde_json", "base64"],
      pitfall: "Hand-writing the OpenAPI YAML next to the handlers. It drifts on the first rename, and the discoverability tool that clients trust starts lying about the API.",
      quickbytes: [
        "Cursor = base64url(JSON {created_at_ms, id}); query WHERE (created_at_ms, id) < ($1, $2) ORDER BY created_at_ms DESC, id DESC LIMIT n + 1.",
        "Inside /v1 ship only additive changes; a rename, removal, or type change means /v2 plus Deprecation and Sunset headers with a traffic check.",
        "Idempotency: UNIQUE (tenant_id, idempotency_key), canonical body hash, stored response. Replay it on retry, 422 when the same key has a new body."
      ],
      github: [
        {
          name: "juhaku/utoipa",
          url: "https://github.com/juhaku/utoipa"
        },
        {
          name: "tokio-rs/axum",
          url: "https://github.com/tokio-rs/axum"
        }
      ],
      resources: [
        {
          title: "utoipa 6 crate documentation",
          url: "https://docs.rs/utoipa/6.0.0/utoipa/",
          kind: "docs"
        },
        {
          title: "utoipa path attribute",
          url: "https://docs.rs/utoipa/6.0.0/utoipa/attr.path.html",
          kind: "docs"
        },
        {
          title: "utoipa examples repository",
          url: "https://github.com/juhaku/utoipa/tree/master/examples",
          kind: "repo"
        },
        {
          title: "RustVideos - Rust conference talks (YouTube)",
          url: "https://www.youtube.com/@RustVideos",
          kind: "video"
        },
        {
          title: "Roseau - Source-based API breaking change analysis (ICSME 2025)",
          url: "https://arxiv.org/abs/2507.17369",
          kind: "paper"
        }
      ]
    },
    {
      id: "w08",
      n: 8,
      title: "Testing and hardening HTTP services",
      minutes: 90,
      level: "industry",
      goal: "Test the real router with oneshot, cover SQL with testcontainers, fuzz and load-test the edges, and ship the security headers and body limits production needs.",
      sections: [
        {
          h: "oneshot drives the real router",
          p: [
            "tower::ServiceExt::oneshot calls the router the way hyper does, without binding a port or leaking ports between parallel tests. Build the app from the same constructor production uses, send an http::Request with a Body, and assert on status, headers, and the collected body.",
            "Collecting the body requires http_body_util::BodyExt. Deserialize it instead of comparing strings: JSON field order is not part of the contract, and a body check catches the refactor that returns 200 with an empty payload."
          ],
          code: `use axum::{body::Body, http::Request, Router};
use http_body_util::BodyExt;
use tower::ServiceExt;

async fn call(app: Router, uri: &str) -> (axum::http::StatusCode, serde_json::Value) {
    let response = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn health_returns_ok() {
    let (status, body) = call(app_for_test().await, "/health").await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(body["status"], "ok");
}`,
          tip: "oneshot consumes the router, so clone it with .clone() before each call when a test needs two requests. A Router clone is cheap and shares the same state."
        },
        {
          h: "Cover SQL with testcontainers",
          p: [
            "Unit tests miss transaction and migration bugs. The testcontainers crate starts a Postgres container per test binary, exposes its mapped port, and removes it when the process exits.",
            "Run migrations once at startup, then give each test isolation through a transaction that rolls back or a unique schema. Containers cost seconds, so keep the split deliberate: many oneshot tests over a fake repository for HTTP contracts, a smaller container suite for queries."
          ],
          code: `// Cargo.toml
// [dev-dependencies]
// testcontainers = "..."
// testcontainers-modules = { features = ["postgres"] }
//
// Shape of a container-backed test:
// 1. start the container, read the mapped host port
// 2. build the connection string, run migrations
// 3. build AppState against that pool, run oneshot requests
// 4. drop the container; do not reuse it across test binaries`,
          tip: "Pin the database image tag. A moving postgres:latest turns an unrelated upstream release into a red build with no code change."
        },
        {
          h: "Fuzz the parser, load-test the edge",
          p: [
            "A request body is hostile input. Property-test deserializers and hand-written parsers with cargo-fuzz; serde guarantees no undefined behaviour, not that your validation covers every accepted shape.",
            "Load-test against a staging deployment with a fixed scenario and assert budgets: p99 latency, error rate, and zero unexpected 5xx. Run it after the functional suite so a regression has a commit to blame."
          ],
          code: `// cargo install cargo-fuzz
// cargo fuzz init
// cargo fuzz add parse_task
//
// fuzz/fuzz_targets/parse_task.rs
#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = serde_json::from_slice::<CreateTask>(data);
});`,
          tip: "Fuzzers find crashes, not policy bugs. A payload that parses but violates a business rule is a missing test, not a fuzz target."
        },
        {
          h: "Headers and limits that prevent common failures",
          p: [
            "Add X-Content-Type-Options: nosniff, a Referrer-Policy, and a Content-Security-Policy for browser-facing responses. Send HSTS only when the service is behind TLS it controls, otherwise the header locks users out of the plain-HTTP path.",
            "Cap request bodies with RequestBodyLimitLayer so a huge JSON body is rejected before it is buffered. Strip or redact Authorization and Cookie headers on the way out of logs and traces."
          ],
          code: `use axum::{http::header, Router};
use tower_http::{
    limit::RequestBodyLimitLayer,
    set_header::SetResponseHeaderLayer,
};

fn harden(app: Router) -> Router {
    app.layer(RequestBodyLimitLayer::new(1024 * 1024))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            header::HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::REFERRER_POLICY,
            header::HeaderValue::from_static("no-referrer"),
        ))
}`,
          tip: "Test the headers, not the configuration. One test per security header costs a few lines and catches the layer that was accidentally dropped during a refactor."
        }
      ],
      exercise: {
        prompt: "Write two oneshot tests: one expects a 404 problem+json for an unknown task, one expects a 422 when limit exceeds 100. Deserialize the bodies and assert content-type.",
        starter: `use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use tower::ServiceExt;

async fn json_call(app: axum::Router, uri: &str) -> (axum::http::StatusCode, String, serde_json::Value) {
    let response = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    // collect the body, read content-type, deserialize JSON
    todo!()
}

// #[tokio::test] async fn unknown_task_is_problem_json() { ... }
// #[tokio::test] async fn limit_above_cap_is_unprocessable() { ... }`,
        hint: "Read the content-type header with response.headers().get(header::CONTENT_TYPE). Collect the body with response.into_body().collect().await.unwrap().to_bytes() before turning it into a serde_json::Value.",
        solution: `use axum::{body::Body, http::Request, Router};
use http_body_util::BodyExt;
use tower::ServiceExt;

async fn json_call(
    app: Router,
    uri: &str,
) -> (axum::http::StatusCode, String, serde_json::Value) {
    let response = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();

    let status = response.status();
    let content_type = response
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, content_type, body)
}

// app_for_test() builds the router from the production app() constructor
// over an in-memory repository, so middleware and error mapping are exercised.
#[tokio::test]
async fn unknown_task_is_problem_json() {
    let (status, content_type, body) =
        json_call(app_for_test().await, "/api/v1/tasks/999999").await;
    assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
    assert_eq!(content_type, "application/problem+json");
    assert_eq!(body["status"], 404);
}

#[tokio::test]
async fn limit_above_cap_is_unprocessable() {
    let (status, content_type, body) =
        json_call(app_for_test().await, "/api/v1/tasks?limit=1000").await;
    assert_eq!(status, axum::http::StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(content_type, "application/problem+json");
    assert_eq!(body["status"], 422);
}`
      },
      questions: [
        {
          q: "What does tower::ServiceExt::oneshot give a test?",
          options: ["A random port on localhost", "One call through the real router without binding a socket", "A mocked database", "A load test"],
          answer: 1,
          explain: "oneshot consumes the service for a single request, so tests exercise extractors, layers, and error mapping without networking."
        },
        {
          q: "Which test belongs in the testcontainers suite rather than the oneshot suite?",
          options: ["JSON field naming", "SQL queries and migrations against real Postgres", "404 fallback shapes", "Security headers"],
          answer: 1,
          explain: "Container tests are slower but catch SQL and migration bugs. HTTP contract checks stay in the fast oneshot suite."
        }
      ],
      production: [
        "Build every test from the production app() constructor so middleware and state wiring are covered, not bypassed.",
        "Assert content-type and body shape, not just status codes; a 200 with an empty body must fail the test.",
        "Pin container image tags and run the SQL suite on every PR that touches migrations.",
        "Run a load smoke test in CI against staging and fail the build on p99 or 5xx regressions."
      ],
      crates: ["tower", "http-body-util", "testcontainers", "tower-http", "axum", "serde_json"],
      pitfall: "Testing handlers by calling them as plain functions. The router, extractors, layers, and error conversion are exactly where the bugs live, and a direct call skips all of them.",
      quickbytes: [
        "Build tests from the production app() and drive it with app.clone().oneshot(Request::builder().uri(\"/health\").body(Body::empty())?).",
        "Collect bodies with http_body_util::BodyExt; assert content-type: application/problem+json and body fields, not just the status code.",
        "cargo add --dev testcontainers testcontainers-modules --features testcontainers-modules/postgres; pin the postgres image tag."
      ],
      github: [
        {
          name: "tower-rs/tower",
          url: "https://github.com/tower-rs/tower"
        },
        {
          name: "testcontainers/testcontainers-rs",
          url: "https://github.com/testcontainers/testcontainers-rs"
        }
      ],
      resources: [
        {
          title: "tower ServiceExt oneshot",
          url: "https://docs.rs/tower/latest/tower/trait.ServiceExt.html",
          kind: "docs"
        },
        {
          title: "testcontainers crate documentation",
          url: "https://docs.rs/testcontainers/latest/testcontainers/",
          kind: "docs"
        },
        {
          title: "axum testing example",
          url: "https://github.com/tokio-rs/axum/tree/main/examples/testing",
          kind: "repo"
        },
        {
          title: "tower-http response header layers",
          url: "https://docs.rs/tower-http/0.6.8/tower_http/set_header/index.html",
          kind: "docs"
        },
        {
          title: "fasterthanlime - Rust videos (YouTube)",
          url: "https://www.youtube.com/@fasterthanlime",
          kind: "video"
        }
      ]
    }
  ]
};
