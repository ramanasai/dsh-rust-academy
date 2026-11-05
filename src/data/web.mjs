/**
 * Production web services track.
 *
 * Authored for the Rust Academy plugin. Every lesson is plain JSON-compatible
 * data consumed by src/app.js through build.mjs.
 */
export default {
  "key": "web",
  "prefix": "w",
  "title": "Production web services",
  "blurb": "Axum 0.8 services that survive real traffic: typed contracts, honest errors, middleware, auth, realtime feeds, stable API contracts, and tests.",
  "level": "industry",
  "project": {
    "title": "Capstone: a hardened task-management API",
    "brief": "Ship a versioned HTTP API for tasks: an axum 0.8 router with typed JSON contracts, RFC 9457 errors, traced middleware, JWT auth with roles, a WebSocket and SSE update feed, an OpenAPI document generated from code, and integration tests that run in CI.",
    "deliverables": [
      "A router with nested /api/v1 and /api/v2 trees sharing one state type",
      "problem+json responses for every failure the API can produce, with tests per status code",
      "JWT auth with role checks plus a WebSocket and SSE feed backed by one broadcast channel",
      "An OpenAPI document generated from the handler types, served at /openapi.json",
      "oneshot integration tests and a testcontainers-backed repository suite running in CI"
    ],
    "stack": [
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
  "lessons": [
    {
      "id": "w01",
      "n": 1,
      "title": "Axum 0.8 routing and composition",
      "minutes": 60,
      "level": "core",
      "goal": "Compose routers from nested subtrees, bind path parameters with the brace syntax, and inject shared state without globals.",
      "sections": [
        {
          "h": "A router is a value you compose",
          "p": [
            "Router::new() builds a value that maps a method plus path to a handler. You compose routers with route, nest and merge, then hand the result to axum::serve. There is no global route registry and no startup scan of annotations.",
            "Because the router is a value, main and your integration tests can share one constructor. Keep that constructor free of side effects so every test builds a fresh router over test-specific state."
          ],
          "code": "use axum::{routing::get, Router};\n\nasync fn health() -> &'static str {\n    \"ok\"\n}\n\nfn app() -> Router {\n    Router::new()\n        .route(\"/health\", get(health))\n        .nest(\"/api/v1\", users_api())\n}\n\nfn users_api() -> Router {\n    Router::new()\n        .route(\"/users\", get(list_users))\n        .route(\"/users/{id}\", get(get_user))\n}\n\nasync fn list_users() -> &'static str {\n    \"[]\"\n}\n\nasync fn get_user(axum::extract::Path(id): axum::extract::Path<u64>) -> String {\n    format!(\"user {id}\")\n}\n\n#[tokio::main]\nasync fn main() {\n    let listener = tokio::net::TcpListener::bind(\"0.0.0.0:8080\")\n        .await\n        .expect(\"bind 8080\");\n    axum::serve(listener, app()).await.expect(\"serve\");\n}"
        },
        {
          "h": "Path parameters use braces in 0.8",
          "p": [
            "axum 0.8 is built on matchit 0.8, which captures segments as {name}. The 0.7 form with a leading colon panics while the router is being built, so the error appears at startup or in the first test rather than under production traffic.",
            "One Path extractor captures several segments at once. A struct with named fields is clearer than a tuple past two parameters, and serde names the field that failed to parse."
          ],
          "code": "use axum::{extract::Path, routing::get, Router};\nuse serde::Deserialize;\n\n#[derive(Deserialize)]\nstruct UserTeam {\n    user_id: u64,\n    team_id: u64,\n}\n\nasync fn show(Path(UserTeam { user_id, team_id }): Path<UserTeam>) -> String {\n    format!(\"user {user_id} in team {team_id}\")\n}\n\nfn app() -> Router {\n    Router::new().route(\"/users/{user_id}/teams/{team_id}\", get(show))\n}",
          "tip": "Percent-encoded segments are decoded before deserialization. If the decoded bytes are not valid UTF-8, Path rejects the request with 400 instead of handing you a broken string."
        },
        {
          "h": "State is injected, not global",
          "p": [
            "Shared dependencies arrive through the State<T> extractor. T must be Clone, so the payload is normally an Arc of cheap handles or a pool type that is itself cheap to clone.",
            "Call .with_state(state) once, after routes are merged. Nested routers inherit the state, which lets subtree functions avoid naming the concrete type while handlers still extract State<AppState>."
          ],
          "code": "use axum::{extract::State, routing::get, Router};\n\n#[derive(Clone)]\nstruct AppState {\n    pool: sqlx::PgPool,\n    version: &'static str,\n}\n\nasync fn get_version(State(state): State<AppState>) -> String {\n    state.version.to_string()\n}\n\nfn app(state: AppState) -> Router {\n    Router::new()\n        .route(\"/version\", get(get_version))\n        .with_state(state)\n}\n\n#[tokio::main]\nasync fn main() -> anyhow::Result<()> {\n    let pool = sqlx::PgPool::connect(&std::env::var(\"DATABASE_URL\")?).await?;\n    let app = app(AppState { pool, version: \"1.0.0\" });\n    let listener = tokio::net::TcpListener::bind(\"0.0.0.0:8080\").await?;\n    axum::serve(listener, app).await?;\n    Ok(())\n}"
        },
        {
          "h": "Nesting, merging, and fallbacks",
          "p": [
            "nest mounts a subtree under a prefix and strips that prefix before matching inside. merge splices two routers at the same level, which is how you build one router from feature modules that do not share a prefix.",
            "A fallback on a nested router handles misses inside that prefix only. That is how /api can return problem+json 404s while the rest of the site returns HTML, and a method mismatch on an existing path still returns 405 with an Allow header."
          ],
          "code": "use axum::{\n    http::StatusCode,\n    response::IntoResponse,\n    routing::get,\n    Json,\n    Router,\n};\n\nasync fn api_not_found() -> impl IntoResponse {\n    (StatusCode::NOT_FOUND, Json(serde_json::json!({ \"status\": 404 })))\n}\n\nasync fn users() -> &'static str {\n    \"[]\"\n}\n\nfn app() -> Router {\n    let api = Router::new()\n        .route(\"/users\", get(users))\n        .fallback(api_not_found);\n\n    Router::new()\n        .nest(\"/api/v1\", api)\n        .route(\"/health\", get(|| async { \"ok\" }))\n}",
          "tip": "nest strips the prefix, so handler URIs inside the subtree are relative. Build absolute URLs from configuration, not from the nested prefix string you passed in."
        }
      ],
      "exercise": {
        "prompt": "Extend the router with a nested /api/v1 subtree serving GET /tasks and GET /tasks/{id}, plus a problem+json 404 fallback for that subtree. Handlers may return fixed data.",
        "starter": "use axum::{routing::get, Router};\n\nasync fn health() -> &'static str { \"ok\" }\n\nfn app() -> Router {\n    // 1. add the health route\n    // 2. nest /api/v1 -> tasks_api()\n    Router::new()\n}\n\nfn tasks_api() -> Router {\n    // add /tasks and /tasks/{id}, then a fallback\n    Router::new()\n}\n\n#[tokio::main]\nasync fn main() {\n    let listener = tokio::net::TcpListener::bind(\"127.0.0.1:3000\").await.unwrap();\n    axum::serve(listener, app()).await.unwrap();\n}",
        "hint": "Routes belong to the nested router, so tasks_api owns .route(\"/tasks\", get(list_tasks)). The fallback takes a handler such as async fn api_404() -> (StatusCode, Json<serde_json::Value>).",
        "solution": "use axum::{\n    extract::Path,\n    http::StatusCode,\n    response::IntoResponse,\n    routing::get,\n    Json,\n    Router,\n};\n\nasync fn health() -> &'static str {\n    \"ok\"\n}\n\nasync fn list_tasks() -> Json<serde_json::Value> {\n    Json(serde_json::json!({ \"items\": [] }))\n}\n\nasync fn get_task(Path(id): Path<u64>) -> Json<serde_json::Value> {\n    Json(serde_json::json!({ \"id\": id, \"title\": \"Ship it\" }))\n}\n\nasync fn api_404() -> impl IntoResponse {\n    (\n        StatusCode::NOT_FOUND,\n        Json(serde_json::json!({\n            \"type\": \"about:blank\",\n            \"title\": \"Not found\",\n            \"status\": 404\n        })),\n    )\n}\n\nfn tasks_api() -> Router {\n    Router::new()\n        .route(\"/tasks\", get(list_tasks))\n        .route(\"/tasks/{id}\", get(get_task))\n        .fallback(api_404)\n}\n\nfn app() -> Router {\n    Router::new()\n        .route(\"/health\", get(health))\n        .nest(\"/api/v1\", tasks_api())\n}\n\n#[tokio::main]\nasync fn main() {\n    let listener = tokio::net::TcpListener::bind(\"127.0.0.1:3000\").await.unwrap();\n    axum::serve(listener, app()).await.unwrap();\n}"
      },
      "questions": [
        {
          "q": "Which route string matches /users/42 in axum 0.8?",
          "options": [
            "/users/:id",
            "/users/{id}",
            "/users/<id>",
            "/users/[id]"
          ],
          "answer": 1,
          "explain": "axum 0.8 uses matchit 0.8, which captures segments with braces. The 0.7 colon syntax panics while the router is built."
        },
        {
          "q": "Where should .with_state(state) be called?",
          "options": [
            "On every handler",
            "Once on the composed router, after routes are added",
            "Before Router::new()",
            "Inside a static initializer"
          ],
          "answer": 1,
          "explain": "State is attached once to the composed router. Nested routers inherit it, and handlers extract State<T>."
        }
      ],
      "production": [
        "Keep exactly one app(state) constructor used by both main and every integration test.",
        "Give each mounted prefix its own fallback so API 404s never fall through to an HTML handler.",
        "Treat /tasks and /tasks/ as different routes; decide the convention and test it.",
        "Add a startup check that the state is built once and cloned, not rebuilt per request."
      ],
      "crates": [
        "axum",
        "tokio",
        "serde",
        "serde_json"
      ],
      "pitfall": "Copying :id routes from an axum 0.7 tutorial. The router panics while it is built (the capture syntax must be {id}), which is loud in tests but easy to miss if nothing builds the router at startup.",
      "quickbytes": [
        "cargo add axum && cargo add tokio --features full; axum 0.8 captures path segments with braces: .route(\"/users/{id}\", get(show)).",
        "Nest strips the prefix and merge splices routers at one level. Give each API subtree its own .fallback(...) that returns problem+json.",
        "Call .with_state(state) once on the composed router after routes are merged; nested routers inherit it and handlers still extract State<AppState>."
      ],
      "github": [
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        },
        {
          "name": "tokio-rs/tokio",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "resources": [
        {
          "title": "axum 0.8 Path extractor reference",
          "url": "https://docs.rs/axum/0.8.9/axum/extract/struct.Path.html",
          "kind": "docs"
        },
        {
          "title": "axum Router API reference",
          "url": "https://docs.rs/axum/0.8.9/axum/struct.Router.html",
          "kind": "docs"
        },
        {
          "title": "axum repository examples",
          "url": "https://github.com/tokio-rs/axum/tree/main/examples",
          "kind": "repo"
        },
        {
          "title": "Let's Get Rusty - Rust tutorials (YouTube)",
          "url": "https://www.youtube.com/@letsgetrusty",
          "kind": "video"
        }
      ]
    },
    {
      "id": "w02",
      "n": 2,
      "title": "Extractors and typed request contracts",
      "minutes": 75,
      "level": "core",
      "goal": "Turn handler arguments into typed, validated request contracts, and translate every extractor rejection into your own error envelope.",
      "sections": [
        {
          "h": "Handler arguments are the contract",
          "p": [
            "Every handler argument is an extractor. All but the last must implement FromRequestParts, which borrows from the request without consuming the body; only the final argument may implement FromRequest and take the body.",
            "That single rule explains the most common compile error: placing Json<T> before another extractor. Put the body extractor last, or destructure a tuple where it is the last element."
          ],
          "code": "use axum::{\n    extract::{Path, State},\n    http::StatusCode,\n    Json,\n};\nuse serde::{Deserialize, Serialize};\n\n#[derive(Deserialize)]\n#[serde(deny_unknown_fields, rename_all = \"camelCase\")]\nstruct CreateTask {\n    title: String,\n    #[serde(default)]\n    priority: u8,\n    assignee_email: Option<String>,\n}\n\n#[derive(Serialize)]\nstruct Task {\n    id: i64,\n    title: String,\n    priority: u8,\n}\n\nasync fn create_task(\n    State(state): State<AppState>,\n    Path(board_id): Path<i64>,\n    Json(body): Json<CreateTask>,\n) -> Result<(StatusCode, Json<Task>), ApiError> {\n    let task = state.tasks.create(board_id, body).await?;\n    Ok((StatusCode::CREATED, Json(task)))\n}"
        },
        {
          "h": "Query, path, and body are separate types",
          "p": [
            "Do not reuse the database row as the request DTO. Query and Path deserialize from strings, so pick strict types (u32, Uuid) rather than String and let serde reject nonsense before your handler runs.",
            "deny_unknown_fields belongs on JSON bodies, not on query structs: clients add cache-busting parameters, and rejecting those turns a harmless request into a 400."
          ],
          "code": "use serde::Deserialize;\n\n#[derive(Deserialize)]\nstruct ListParams {\n    #[serde(default = \"default_limit\")]\n    limit: u32,\n    after: Option<String>,\n    #[serde(default)]\n    include_done: bool,\n}\n\nfn default_limit() -> u32 {\n    50\n}\n\n#[derive(Deserialize)]\n#[serde(deny_unknown_fields, rename_all = \"camelCase\")]\nstruct CreateTask {\n    title: String,\n    #[serde(default)]\n    priority: u8,\n    assignee_email: Option<String>,\n}",
          "tip": "Give Query structs a default for every field you can. A missing query parameter is then a normal request, while a missing JSON field stays a rejection."
        },
        {
          "h": "A custom extractor for the tenant",
          "p": [
            "When every handler needs the same value, extract it once. Implement FromRequestParts, return your own error type, and axum will call IntoResponse on the rejection, so a bad tenant header produces the same problem+json shape as everything else.",
            "Extractors that need state take it through FromRef. That keeps a subtree unaware of the full AppState type while still giving the extractor the data it needs."
          ],
          "code": "use axum::{\n    extract::FromRequestParts,\n    http::request::Parts,\n};\n\n#[derive(Clone)]\npub struct Tenant(pub String);\n\nimpl<S> FromRequestParts<S> for Tenant\nwhere\n    S: Send + Sync,\n{\n    type Rejection = ApiError;\n\n    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {\n        let tenant = parts\n            .headers\n            .get(\"x-tenant-id\")\n            .and_then(|value| value.to_str().ok())\n            .map(str::trim)\n            .filter(|value| !value.is_empty() && value.len() <= 64)\n            .ok_or(ApiError::Invalid(\"missing or invalid x-tenant-id\".into()))?;\n        Ok(Tenant(tenant.to_owned()))\n    }\n}\n\n// When the extractor needs configuration, add a bound:\n//     Config: FromRef<S>\n// and fetch it with Config::from_ref(state) inside from_request_parts."
        },
        {
          "h": "Map rejections instead of accepting defaults",
          "p": [
            "axum rejections such as JsonRejection and QueryRejection already carry a status and a text body. That text is fine for debugging and wrong for clients: it does not match your envelope and can drift between axum versions.",
            "Take the rejection as a handler argument of type Result<Json<T>, JsonRejection> and translate it. Extraction happens before the handler body, so you never observe a half-parsed payload."
          ],
          "code": "use axum::{\n    extract::rejection::JsonRejection,\n    http::StatusCode,\n    Json,\n    response::IntoResponse,\n};\n\nasync fn create_task(\n    payload: Result<Json<CreateTask>, JsonRejection>,\n) -> impl IntoResponse {\n    let Json(body) = match payload {\n        Ok(json) => json,\n        Err(rejection) => {\n            return ApiError::Invalid(rejection.body_text()).into_response();\n        }\n    };\n    if body.title.trim().is_empty() {\n        return ApiError::Invalid(\"title must not be empty\".into()).into_response();\n    }\n    (StatusCode::CREATED, Json(body.title)).into_response()\n}",
          "tip": "Rejections expose status() and body_text(). Log the rejection at debug level and return your own message so internal serde paths do not leak into responses."
        }
      ],
      "exercise": {
        "prompt": "Add a Pagination query type with a default limit of 50 and a hard cap of 100, plus a validation method that returns a problem+json 422 when limit is out of range. Show the handler signature.",
        "starter": "use serde::Deserialize;\n\n#[derive(Deserialize)]\nstruct Pagination {\n    limit: Option<u32>,\n    after: Option<String>,\n}\n\n// TODO: add a validated() method\n// TODO: use Query<Pagination> in a handler and map the error\n\nasync fn list_tasks(/* extractors */) -> Result<(), ApiError> {\n    todo!()\n}",
        "hint": "Unwrap the limit with query.limit.unwrap_or(50), compare against the 1..=100 range, and return ApiError::Unprocessable(String) on failure. The handler keeps Query<Pagination> among the FromRequestParts arguments.",
        "solution": "use axum::{\n    extract::Query,\n    Json,\n};\nuse serde::{Deserialize, Serialize};\n\n#[derive(Deserialize)]\nstruct Pagination {\n    limit: Option<u32>,\n    after: Option<String>,\n}\n\n#[derive(Serialize)]\nstruct Page<T> {\n    items: Vec<T>,\n    next_cursor: Option<String>,\n}\n\nimpl Pagination {\n    fn validated(&self) -> Result<u32, ApiError> {\n        let limit = self.limit.unwrap_or(50);\n        if !(1..=100).contains(&limit) {\n            return Err(ApiError::Unprocessable(\n                \"limit must be between 1 and 100\".into(),\n            ));\n        }\n        Ok(limit)\n    }\n}\n\nasync fn list_tasks(\n    Query(query): Query<Pagination>,\n) -> Result<Json<Page<String>>, ApiError> {\n    let _limit = query.validated()?;\n    let _after = query.after.as_deref();\n    Ok(Json(Page { items: Vec::new(), next_cursor: None }))\n}"
      },
      "questions": [
        {
          "q": "Which handler argument may consume the request body?",
          "options": [
            "Any argument, in any position",
            "Only the last argument",
            "Only the first argument",
            "Only arguments implementing FromRequestParts"
          ],
          "answer": 1,
          "explain": "Every argument before the last must implement FromRequestParts. The body can be consumed once, so the body extractor goes last."
        },
        {
          "q": "Why keep deny_unknown_fields off a Query struct?",
          "options": [
            "It disables serde defaults",
            "Clients often send extra query parameters and would get 400s",
            "It fails to compile on query structs",
            "It makes the struct non-Send"
          ],
          "answer": 1,
          "explain": "Caches, analytics, and SDKs add query parameters. Strictness belongs on JSON bodies, where unknown fields usually mean a client bug."
        }
      ],
      "production": [
        "Keep request DTOs separate from database rows and response DTOs; rename with serde instead of leaking column names.",
        "Cap and validate every page size in one helper so endpoints cannot drift apart.",
        "Return one error envelope for body, query, and path rejections; assert the content-type in tests.",
        "Log rejection bodies at debug level only, and never echo serde internals to clients."
      ],
      "crates": [
        "axum",
        "serde",
        "serde_json"
      ],
      "pitfall": "Taking Json<T> as a non-final argument: the handler fails to compile with a FromRequest vs FromRequestParts mismatch, and teams work around it by pulling the body out manually instead of moving the extractor last.",
      "quickbytes": [
        "Keep the body extractor last: Json<T> is only legal as the final handler argument; everything before it must implement FromRequestParts.",
        "Accept payload: Result<Json<T>, JsonRejection>, then map rejection.body_text() into your own problem+json -- never echo axum's text.",
        "Put #[serde(default)] on every optional query field and keep deny_unknown_fields off Query structs; caches and SDKs add parameters."
      ],
      "github": [
        {
          "name": "serde-rs/serde",
          "url": "https://github.com/serde-rs/serde"
        },
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        }
      ],
      "resources": [
        {
          "title": "axum extractors module",
          "url": "https://docs.rs/axum/0.8.9/axum/extract/index.html",
          "kind": "docs"
        },
        {
          "title": "FromRequestParts trait",
          "url": "https://docs.rs/axum/0.8.9/axum/extract/trait.FromRequestParts.html",
          "kind": "docs"
        },
        {
          "title": "serde container and field attributes",
          "url": "https://docs.rs/serde/latest/serde/",
          "kind": "docs"
        },
        {
          "title": "fasterthanlime - Rust videos (YouTube)",
          "url": "https://www.youtube.com/@fasterthanlime",
          "kind": "video"
        }
      ]
    },
    {
      "id": "w03",
      "n": 3,
      "title": "Errors as responses with problem+json",
      "minutes": 80,
      "level": "advanced",
      "goal": "Model failures with thiserror, render them as RFC 9457 problem+json with the right status codes, and keep panics out of the request path.",
      "sections": [
        {
          "h": "One error enum per boundary",
          "p": [
            "Handlers return Result<T, ApiError>. The enum models what can go wrong at the HTTP boundary, with variants for not-found, conflicts, invalid input, and an opaque internal variant.",
            "Use thiserror for Display and the ? conversion from infrastructure errors, but do not expose the source error in the response. The transport layer logs the source; the client gets a stable, non-leaking message."
          ],
          "code": "use thiserror::Error;\n\n#[derive(Debug, Error)]\npub enum ApiError {\n    #[error(\"task {0} not found\")]\n    NotFound(i64),\n    #[error(\"invalid request: {0}\")]\n    Invalid(String),\n    #[error(\"unprocessable request: {0}\")]\n    Unprocessable(String),\n    #[error(\"task {0} changed since it was read\")]\n    Conflict(i64),\n    #[error(\"unauthorized\")]\n    Unauthorized,\n    #[error(\"forbidden\")]\n    Forbidden,\n    #[error(\"database error: {0}\")]\n    Database(#[from] sqlx::Error),\n    #[error(\"internal error\")]\n    Internal,\n}"
        },
        {
          "h": "IntoResponse turns the enum into bytes",
          "p": [
            "Implement IntoResponse once. Map each variant to a status, a stable type string, a short title, and a detail that is safe to show. RFC 9457 defines the members: type, title, status, detail, and instance.",
            "Set content-type to application/problem+json explicitly. Axum's Json extractor sets application/json, so the media type has to be overwritten after building the response."
          ],
          "code": "use axum::{\n    http::{header, HeaderValue, StatusCode},\n    response::{IntoResponse, Response},\n    Json,\n};\nuse serde::Serialize;\nuse utoipa::ToSchema;\n\n#[derive(Debug, Serialize, ToSchema)]\npub struct Problem {\n    #[serde(rename = \"type\")]\n    pub kind: String,\n    pub title: String,\n    pub status: u16,\n    pub detail: String,\n}\n\nimpl IntoResponse for ApiError {\n    fn into_response(self) -> Response {\n        let (status, kind, title) = match &self {\n            ApiError::NotFound(_) => (StatusCode::NOT_FOUND, \"task-not-found\", \"Task not found\"),\n            ApiError::Invalid(_) => (StatusCode::BAD_REQUEST, \"invalid-request\", \"Invalid request\"),\n            ApiError::Unprocessable(_) => (StatusCode::UNPROCESSABLE_ENTITY, \"unprocessable\", \"Unprocessable request\"),\n            ApiError::Conflict(_) => (StatusCode::CONFLICT, \"conflict\", \"Task changed\"),\n            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, \"unauthorized\", \"Unauthorized\"),\n            ApiError::Forbidden => (StatusCode::FORBIDDEN, \"forbidden\", \"Forbidden\"),\n            ApiError::Database(source) => {\n                tracing::error!(error = %source, \"database failure\");\n                (StatusCode::INTERNAL_SERVER_ERROR, \"internal\", \"Internal error\")\n            }\n            ApiError::Internal => (StatusCode::INTERNAL_SERVER_ERROR, \"internal\", \"Internal error\"),\n        };\n\n        let detail = match &self {\n            ApiError::NotFound(id) => format!(\"task {id} does not exist\"),\n            ApiError::Invalid(message) | ApiError::Unprocessable(message) => message.clone(),\n            ApiError::Conflict(id) => format!(\"task {id} was modified, refetch and retry\"),\n            ApiError::Unauthorized | ApiError::Forbidden | ApiError::Internal => {\n                \"request cannot be completed\".to_owned()\n            }\n            ApiError::Database(_) => \"request failed\".to_owned(),\n        };\n\n        let problem = Problem {\n            kind: kind.to_owned(),\n            title: title.to_owned(),\n            status: status.as_u16(),\n            detail,\n        };\n        let mut response = (status, Json(problem)).into_response();\n        response.headers_mut().insert(\n            header::CONTENT_TYPE,\n            HeaderValue::from_static(\"application/problem+json\"),\n        );\n        response\n    }\n}"
        },
        {
          "h": "The status code is a decision, not a default",
          "p": [
            "Pick the code from the semantics of the failure, then keep it stable across releases: clients and dashboards encode behaviour against it. Returning 500 for everything hides retryable failures and pages on-call for user mistakes."
          ],
          "code": "// 400 malformed syntax or unparsable input\n// 401 missing, expired, or invalid credentials; send WWW-Authenticate\n// 403 caller is authenticated but lacks the role or permission\n// 404 resource is absent (also used to hide another tenant's resource)\n// 409 state conflict: optimistic-lock miss, idempotency-key body mismatch\n// 422 syntactically valid but semantically invalid (negative limit)\n// 429 rate limited; include Retry-After\n// 500 unexpected bug; log with a request id, never show the source\n// 503 dependency unavailable; set Retry-After when the outage is bounded",
          "tip": "409 and 422 look interchangeable until a client implements retry. Use 409 for a conflict with current state and 422 for a request that can never succeed as written."
        },
        {
          "h": "Panics are not error handling",
          "p": [
            "When a handler panics, the request is aborted and the client sees a 500 with no useful body. Side effects already started keep running or get dropped mid-flight, and the panic is only visible if a subscriber or a panic hook captures it.",
            "Indexing, unwrap on a parse, and division by zero are the usual sources. CatchPanicLayer converts a panic into a response so a single bad request does not abort the connection, but it cannot undo partial work."
          ],
          "code": "use tower_http::catch_panic::CatchPanicLayer;\n\nlet app = app.layer(CatchPanicLayer::new());",
          "tip": "Treat a panic as a bug with a failing test, not as a control path. CatchPanicLayer is a blast door, not a strategy."
        }
      ],
      "exercise": {
        "prompt": "Add a RateLimited { retry_after_secs: u64 } variant, map it to 429 with a Retry-After header, and make sure the 500 branch logs the source error while the body stays generic.",
        "starter": "// Variant to add:\n// #[error(\"rate limited\")]\n// RateLimited { retry_after_secs: u64 }\n\n// Then extend IntoResponse:\n//  - status 429, kind \"rate-limited\", title \"Too many requests\"\n//  - insert header::RETRY_AFTER with the number of seconds\n//  - detail stays short and safe",
        "hint": "Build the response with (status, Json(problem)).into_response(), then use response.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_str(&secs.to_string()).unwrap()) before returning it.",
        "solution": "use axum::{\n    http::{header, HeaderValue, StatusCode},\n    response::{IntoResponse, Response},\n    Json,\n};\n\nimpl IntoResponse for ApiError {\n    fn into_response(self) -> Response {\n        let (status, kind, title) = match &self {\n            ApiError::RateLimited { .. } => {\n                (StatusCode::TOO_MANY_REQUESTS, \"rate-limited\", \"Too many requests\")\n            }\n            ApiError::NotFound(_) => (StatusCode::NOT_FOUND, \"task-not-found\", \"Task not found\"),\n            ApiError::Database(source) => {\n                tracing::error!(error = %source, \"database failure\");\n                (StatusCode::INTERNAL_SERVER_ERROR, \"internal\", \"Internal error\")\n            }\n            _ => (StatusCode::INTERNAL_SERVER_ERROR, \"internal\", \"Internal error\"),\n        };\n\n        let detail = match &self {\n            ApiError::RateLimited { retry_after_secs } => {\n                format!(\"retry after {retry_after_secs} seconds\")\n            }\n            _ => \"request cannot be completed\".to_owned(),\n        };\n\n        let problem = Problem {\n            kind: kind.to_owned(),\n            title: title.to_owned(),\n            status: status.as_u16(),\n            detail,\n        };\n        let mut response = (status, Json(problem)).into_response();\n        response.headers_mut().insert(\n            header::CONTENT_TYPE,\n            HeaderValue::from_static(\"application/problem+json\"),\n        );\n        if let ApiError::RateLimited { retry_after_secs } = &self {\n            let value = HeaderValue::from_str(&retry_after_secs.to_string())\n                .expect(\"decimal seconds are a valid header value\");\n            response.headers_mut().insert(header::RETRY_AFTER, value);\n        }\n        response\n    }\n}"
      },
      "questions": [
        {
          "q": "Which status fits a valid request that is semantically impossible, such as limit=1000 with a cap of 100?",
          "options": [
            "400",
            "409",
            "422",
            "500"
          ],
          "answer": 2,
          "explain": "422 means the request parsed but cannot be processed as written. 400 is malformed syntax and 409 is a conflict with current state."
        },
        {
          "q": "What should the client-visible detail say for an internal error?",
          "options": [
            "The sqlx error and the SQL statement",
            "A generic message, while the source is logged",
            "A full stack trace",
            "The database connection string"
          ],
          "answer": 1,
          "explain": "Internal details leak schema and infrastructure. Log the source with a request id and return a stable message."
        }
      ],
      "production": [
        "Keep one module that owns status mapping and test it with a table of variant to status cases.",
        "Log 5xx with the source error and the request id; log 4xx at info level without stack noise.",
        "Never include SQL, connection strings, or upstream responses in a client-visible detail field.",
        "Install a panic hook and CatchPanicLayer, then alert on the panic counter instead of relying on 500 rates."
      ],
      "crates": [
        "thiserror",
        "axum",
        "serde",
        "serde_json",
        "tracing",
        "tower-http",
        "utoipa",
        "sqlx"
      ],
      "pitfall": "Mapping every error to 500 because the error type has a #[from] conversion. Clients cannot tell a retryable 503 from a validation mistake, and on-call gets paged for 422s.",
      "quickbytes": [
        "Build the response with (status, Json(problem)).into_response(), then overwrite CONTENT_TYPE with HeaderValue::from_static(\"application/problem+json\").",
        "Status table: 409 for state conflicts, 422 for impossible requests, 429 plus Retry-After, 503 when a bounded dependency outage will clear.",
        "cargo add tower-http --features catch-panic, then .layer(CatchPanicLayer::new()) once; keep a panic hook so the payload is still logged."
      ],
      "github": [
        {
          "name": "dtolnay/thiserror",
          "url": "https://github.com/dtolnay/thiserror"
        },
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        }
      ],
      "resources": [
        {
          "title": "thiserror derive documentation",
          "url": "https://docs.rs/thiserror/latest/thiserror/",
          "kind": "docs"
        },
        {
          "title": "axum IntoResponse trait",
          "url": "https://docs.rs/axum/0.8.9/axum/response/trait.IntoResponse.html",
          "kind": "docs"
        },
        {
          "title": "tower-http CatchPanicLayer",
          "url": "https://docs.rs/tower-http/0.6.8/tower_http/catch_panic/struct.CatchPanicLayer.html",
          "kind": "docs"
        },
        {
          "title": "Jon Gjengset - Rust deep dives (YouTube)",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        },
        {
          "title": "Simple Testing Can Prevent Most Critical Failures (OSDI 2014)",
          "url": "https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-yuan.pdf",
          "kind": "paper"
        }
      ]
    },
    {
      "id": "w04",
      "n": 4,
      "title": "tower and tower-http middleware",
      "minutes": 85,
      "level": "advanced",
      "goal": "Stack request-scoped middleware in a deliberate order: tracing, request IDs, CORS, compression, and a timeout that actually bounds the handler.",
      "sections": [
        {
          "h": "A layer transforms a service",
          "p": [
            "A tower::Layer wraps a service and returns another service. Middleware sees the request on the way in and the response on the way out, which is why auth, timeouts, compression, and tracing are all expressible as layers.",
            "Use tower::ServiceBuilder when order matters. Layers apply in declaration order, so the first layer listed is the outermost: it sees the request first and the response last."
          ],
          "code": "use std::time::Duration;\nuse axum::{http::StatusCode, Router};\nuse tower::ServiceBuilder;\nuse tower_http::{\n    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},\n    timeout::TimeoutLayer,\n    trace::TraceLayer,\n};\n\nlet middleware = ServiceBuilder::new()\n    .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))\n    .layer(TraceLayer::new_for_http())\n    .layer(PropagateRequestIdLayer::x_request_id())\n    .layer(TimeoutLayer::with_status_code(\n        StatusCode::REQUEST_TIMEOUT,\n        Duration::from_secs(10),\n    ));\n\nlet app = Router::new().merge(api).layer(middleware);",
          "tip": "Chained Router::layer calls are easier to get backwards than ServiceBuilder because each call wraps the existing stack. When order is load-bearing, pass one ServiceBuilder."
        },
        {
          "h": "What TraceLayer actually does",
          "p": [
            "TraceLayer opens a span per request and emits events when the response or failure is classified. It does not print anything by itself: a tracing subscriber with an EnvFilter is what turns those events into logs.",
            "The default classifier records latency and status for every response, including health checks. Customise with DefaultOnResponse and DefaultOnFailure to add method, route, and trace identifiers, and skip noisy probes."
          ],
          "code": "use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};\n\ntracing_subscriber::registry()\n    .with(\n        EnvFilter::try_from_default_env()\n            .unwrap_or_else(|_| \"info,tower_http=debug\".into()),\n    )\n    .with(tracing_subscriber::fmt::layer().json())\n    .init();",
          "tip": "The json() layer needs the json feature on tracing-subscriber. Structured logs are what let you filter by request id in production instead of grepping free text."
        },
        {
          "h": "Request IDs correlate logs across services",
          "p": [
            "SetRequestIdLayer generates an id and stores it in the request headers; PropagateRequestIdLayer copies it to the response so a client can quote it in a bug report. Put the set layer outside the trace layer so the span can see the id.",
            "If an ingress proxy already sets X-Request-Id, trust it only when the proxy overwrites client-supplied values. Otherwise a caller controls your correlation id and can pollute the logs."
          ],
          "code": "use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};\nuse axum::http::HeaderName;\n\nlet request_id = HeaderName::from_static(\"x-request-id\");\n\nlet layers = tower::ServiceBuilder::new()\n    .layer(SetRequestIdLayer::new(request_id.clone(), MakeRequestUuid))\n    .layer(PropagateRequestIdLayer::new(request_id));"
        },
        {
          "h": "CORS, compression, limits, and timeouts",
          "p": [
            "CorsLayer::permissive() is for local development. Production needs an explicit origin list, and allow_credentials only with concrete origins, never with a wildcard. Preflight requests must reach CORS before auth, or browsers see an auth failure instead of a CORS answer.",
            "CompressionLayer negotiates zstd, brotli, or gzip from Accept-Encoding and skips already-compressed bodies. Put the timeout outside every handler-level layer so it bounds the token check and the database call, not just the last function in the chain."
          ],
          "code": "use axum::http::{header, HeaderValue};\nuse tower_http::{\n    compression::CompressionLayer,\n    cors::{Any, CorsLayer},\n    limit::RequestBodyLimitLayer,\n};\n\nlet cors = CorsLayer::new()\n    .allow_origin(HeaderValue::from_static(\"https://app.example.com\"))\n    .allow_methods(Any)\n    .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE, header::ACCEPT])\n    .max_age(std::time::Duration::from_secs(600));\n\nlet app = app\n    .layer(RequestBodyLimitLayer::new(1024 * 1024))\n    .layer(CompressionLayer::new())\n    .layer(cors);",
          "tip": "tower-http's TimeoutLayer returns the status you configure with an empty body. If your API contract promises problem+json everywhere, document 408 or map it in a response-shaping layer."
        }
      ],
      "exercise": {
        "prompt": "Attach a request-ID plus tracing stack and a 5 second timeout to a router whose /slow handler sleeps 10 seconds, then prove with a oneshot test that the response is 408 and not a hung connection.",
        "starter": "use axum::{routing::get, Router};\n\nasync fn slow() -> &'static str {\n    tokio::time::sleep(std::time::Duration::from_secs(10)).await;\n    \"done\"\n}\n\nfn app() -> Router {\n    // add SetRequestIdLayer + TraceLayer, then the timeout last\n    Router::new().route(\"/slow\", get(slow))\n}",
        "hint": "TimeoutLayer::with_status_code(StatusCode::REQUEST_TIMEOUT, Duration::from_secs(5)) gives the status you assert. In the test, tokio::time::pause plus a short sleep keeps the test fast.",
        "solution": "use axum::{http::StatusCode, routing::get, Router};\nuse std::time::Duration;\nuse tower::ServiceExt;\nuse tower_http::{\n    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},\n    timeout::TimeoutLayer,\n    trace::TraceLayer,\n};\n\nasync fn slow() -> &'static str {\n    tokio::time::sleep(Duration::from_secs(10)).await;\n    \"done\"\n}\n\nfn app() -> Router {\n    let layers = tower::ServiceBuilder::new()\n        .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))\n        .layer(TraceLayer::new_for_http())\n        .layer(PropagateRequestIdLayer::x_request_id())\n        .layer(TimeoutLayer::with_status_code(\n            StatusCode::REQUEST_TIMEOUT,\n            Duration::from_secs(5),\n        ));\n\n    Router::new().route(\"/slow\", get(slow)).layer(layers)\n}\n\n#[tokio::test]\nasync fn slow_route_times_out() {\n    let request = axum::http::Request::builder()\n        .uri(\"/slow\")\n        .body(axum::body::Body::empty())\n        .unwrap();\n\n    let response = app().oneshot(request).await.unwrap();\n    assert_eq!(response.status(), StatusCode::REQUEST_TIMEOUT);\n    assert!(response.headers().contains_key(\"x-request-id\"));\n}"
      },
      "questions": [
        {
          "q": "In tower::ServiceBuilder, which layer sees the request first?",
          "options": [
            "The layer declared last",
            "The layer declared first",
            "The layer with the longest name",
            "Order is unspecified"
          ],
          "answer": 1,
          "explain": "ServiceBuilder applies layers in declaration order, so the first listed is outermost: it sees the request first and the response last."
        },
        {
          "q": "Why must the timeout wrap the auth layer?",
          "options": [
            "Otherwise it bounds only the layers inside it",
            "Otherwise it does nothing at all",
            "Because tower requires timeouts outermost",
            "Because auth layers cannot be timed"
          ],
          "answer": 0,
          "explain": "A timeout covers only what it wraps. If auth runs outside it, a slow token check is unbounded."
        }
      ],
      "production": [
        "Order layers deliberately and write a comment explaining why the timeout is outside auth and the database call.",
        "Emit the request id in every log line and return it on every response, including errors.",
        "Set an explicit CORS origin list; allow_credentials with a wildcard origin is rejected by browsers and hides the bug in development.",
        "Cap request bodies below your memory budget and make the limit part of the public API docs."
      ],
      "crates": [
        "tower",
        "tower-http",
        "axum",
        "tracing",
        "tracing-subscriber"
      ],
      "pitfall": "Adding TimeoutLayer with Router::layer after the routes but inside the auth layer. Slow token verification then escapes the timeout, and the p99 alert fires on the auth service instead of the handler.",
      "quickbytes": [
        "cargo add tower-http --features trace,request-id,cors,compression,timeout,limit covers the full production middleware set.",
        ".layer(SetRequestIdLayer::x_request_id(MakeRequestUuid)) outside TraceLayer; PropagateRequestIdLayer copies the id onto every response.",
        "In tower::ServiceBuilder the first layer is outermost: it sees the request first and the response last, so list the timeout first."
      ],
      "github": [
        {
          "name": "tower-rs/tower-http",
          "url": "https://github.com/tower-rs/tower-http"
        },
        {
          "name": "tower-rs/tower",
          "url": "https://github.com/tower-rs/tower"
        }
      ],
      "resources": [
        {
          "title": "tower-http trace module",
          "url": "https://docs.rs/tower-http/0.6.8/tower_http/trace/index.html",
          "kind": "docs"
        },
        {
          "title": "tower-http CORS layer",
          "url": "https://docs.rs/tower-http/0.6.8/tower_http/cors/index.html",
          "kind": "docs"
        },
        {
          "title": "tower-http timeout module",
          "url": "https://docs.rs/tower-http/0.6.8/tower_http/timeout/index.html",
          "kind": "docs"
        },
        {
          "title": "tower-http request-id module",
          "url": "https://docs.rs/tower-http/0.6.8/tower_http/request_id/index.html",
          "kind": "docs"
        },
        {
          "title": "RustVideos - Rust conference talks (YouTube)",
          "url": "https://www.youtube.com/@RustVideos",
          "kind": "video"
        }
      ]
    },
    {
      "id": "w05",
      "n": 5,
      "title": "JWT authentication and authorization",
      "minutes": 90,
      "level": "industry",
      "goal": "Issue and verify JWTs with jsonwebtoken 11, enforce roles and object ownership, and understand the token failure modes that matter in production.",
      "sections": [
        {
          "h": "A JWT is a signed envelope, not a session",
          "p": [
            "A JWT is base64url-encoded claims plus a signature. Anyone holding it can read the payload, so claims may contain a subject id, roles, scopes, an issuer, and timestamps, and nothing that would be dangerous if leaked.",
            "Keep access tokens short lived, five to fifteen minutes, and pair them with a refresh token stored in an HttpOnly cookie. Assume a stolen access token is valid until expiry; a short expiry is what limits the damage."
          ],
          "code": "// Access token payload, HS256 signed:\n// {\n//   \"sub\": \"user_42\",\n//   \"roles\": [\"member\"],\n//   \"iss\": \"https://auth.example.com\",\n//   \"aud\": \"tasks-api\",\n//   \"iat\": 1767225600,\n//   \"exp\": 1767226500\n// }\n//\n// The signature proves the payload was issued by a holder of the key.\n// It says nothing about whether the user is still allowed in.",
          "tip": "Do not put email addresses, plan names, or permission lists in claims you never re-check. A claim is a cached fact that stays true until expiry."
        },
        {
          "h": "jsonwebtoken 11 needs a crypto provider",
          "p": [
            "In jsonwebtoken 11 the signing backend sits behind a CryptoProvider. Enable the rust_crypto or aws_lc_rs feature and install the provider once at startup; calling encode or decode before it is installed returns a runtime error rather than a compile error.",
            "Pin the algorithm explicitly in both directions. Encoding with HS256 and validating a token whose header says RS256 must fail, not fall back to the header value."
          ],
          "code": "use jsonwebtoken::{crypto::rust_crypto, Algorithm, EncodingKey, Header};\nuse serde::{Deserialize, Serialize};\n\n#[derive(Debug, Serialize, Deserialize)]\npub struct Claims {\n    pub sub: String,\n    pub roles: Vec<String>,\n    pub aud: String,\n    pub iss: String,\n    pub iat: usize,\n    pub exp: usize,\n}\n\npub fn install_crypto_provider() {\n    rust_crypto::DEFAULT_PROVIDER\n        .install_default()\n        .expect(\"crypto provider installed twice\");\n}\n\npub fn issue_token(secret: &[u8], user_id: &str) -> jsonwebtoken::errors::Result<String> {\n    let now = jsonwebtoken::get_current_timestamp() as usize;\n    let claims = Claims {\n        sub: user_id.to_owned(),\n        roles: vec![\"member\".to_owned()],\n        aud: \"tasks-api\".to_owned(),\n        iss: \"https://auth.example.com\".to_owned(),\n        iat: now,\n        exp: now + 900,\n    };\n    jsonwebtoken::encode(\n        &Header::new(Algorithm::HS256),\n        &claims,\n        &EncodingKey::from_secret(secret),\n    )\n}"
        },
        {
          "h": "Verify, then authorize",
          "p": [
            "Verification checks the signature, the issuer, the audience, the expiry, and the algorithm. Only after that do you decide whether the subject may perform the action.",
            "Implement an AuthUser extractor so handlers name the requirement in their signature. Handler code then works with typed claims instead of parsing headers repeatedly."
          ],
          "code": "use axum::{\n    extract::{FromRef, FromRequestParts},\n    http::{header, request::Parts},\n};\nuse jsonwebtoken::{Algorithm, DecodingKey, Validation};\n\n#[derive(Clone)]\npub struct JwtKeys {\n    pub secret: Vec<u8>,\n}\n\npub struct AuthUser {\n    pub id: String,\n    pub roles: Vec<String>,\n}\n\npub fn verify(secret: &[u8], token: &str) -> Result<Claims, ApiError> {\n    let mut validation = Validation::new(Algorithm::HS256);\n    validation.set_issuer(&[\"https://auth.example.com\"]);\n    validation.set_audience(&[\"tasks-api\"]);\n    validation.leeway = 30;\n\n    let data = jsonwebtoken::decode::<Claims>(\n        token,\n        &DecodingKey::from_secret(secret),\n        &validation,\n    )\n    .map_err(|_| ApiError::Unauthorized)?;\n    Ok(data.claims)\n}\n\nimpl<S> FromRequestParts<S> for AuthUser\nwhere\n    JwtKeys: FromRef<S>,\n    S: Send + Sync,\n{\n    type Rejection = ApiError;\n\n    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {\n        let keys = JwtKeys::from_ref(state);\n        let token = parts\n            .headers\n            .get(header::AUTHORIZATION)\n            .and_then(|value| value.to_str().ok())\n            .and_then(|value| value.strip_prefix(\"Bearer \"))\n            .ok_or(ApiError::Unauthorized)?;\n        let claims = verify(&keys.secret, token)?;\n        Ok(AuthUser { id: claims.sub, roles: claims.roles })\n    }\n}",
          "tip": "Leeway absorbs clock skew between services. Thirty seconds is plenty; a five-minute leeway quietly extends every token and every revocation delay."
        },
        {
          "h": "Authorization is a second decision",
          "p": [
            "Authentication answers who is calling. Authorization answers whether this subject may touch this object, and that check belongs next to the data: filter by owner in the query instead of loading first and comparing afterwards.",
            "Return 401 when credentials are missing or invalid and include WWW-Authenticate. Return 403 when the caller is known but insufficiently privileged. For another tenant's object, prefer 404 so the API does not confirm that the id exists."
          ],
          "code": "use axum::{extract::State, http::StatusCode, Json};\n\nasync fn delete_task(\n    AuthUser { id, roles }: AuthUser,\n    State(state): State<AppState>,\n    axum::extract::Path(task_id): axum::extract::Path<i64>,\n) -> Result<StatusCode, ApiError> {\n    if !roles.iter().any(|role| role == \"admin\" || role == \"owner\") {\n        return Err(ApiError::Forbidden);\n    }\n    // Ownership is enforced in SQL, not after a read:\n    // DELETE FROM tasks WHERE id = $1 AND owner_id = $2\n    let deleted = state.tasks.delete_owned(task_id, &id).await?;\n    if deleted == 0 {\n        return Err(ApiError::NotFound(task_id));\n    }\n    Ok(StatusCode::NO_CONTENT)\n}",
          "tip": "Revocation is the hard part. Keep TTLs short, store a jti denylist only for high-value tokens, and rotate signing keys with a kid header rather than keeping one secret forever."
        }
      ],
      "exercise": {
        "prompt": "Write an AuthUser extractor and a require_role helper, then protect /admin/tasks so it returns 401 without a token and 403 for an authenticated user without the admin role.",
        "starter": "use axum::{extract::FromRequestParts, http::request::Parts};\n\npub struct AuthUser {\n    pub id: String,\n    pub roles: Vec<String>,\n}\n\n// 1. implement FromRequestParts for AuthUser using JwtKeys: FromRef<S>\n// 2. add fn require_role(user: &AuthUser, role: &str) -> Result<(), ApiError>\n// 3. use both in an /admin/tasks handler",
        "hint": "Strip the Bearer prefix from AUTHORIZATION, call verify, and map any jsonwebtoken error to ApiError::Unauthorized. require_role returns Err(ApiError::Forbidden) when the role is absent.",
        "solution": "use axum::{\n    extract::FromRequestParts,\n    http::{header, request::Parts},\n};\n\npub struct AuthUser {\n    pub id: String,\n    pub roles: Vec<String>,\n}\n\nimpl AuthUser {\n    pub fn require_role(&self, role: &str) -> Result<(), ApiError> {\n        if self.roles.iter().any(|candidate| candidate == role) {\n            Ok(())\n        } else {\n            Err(ApiError::Forbidden)\n        }\n    }\n}\n\nimpl<S> FromRequestParts<S> for AuthUser\nwhere\n    JwtKeys: axum::extract::FromRef<S>,\n    S: Send + Sync,\n{\n    type Rejection = ApiError;\n\n    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {\n        let keys = JwtKeys::from_ref(state);\n        let token = parts\n            .headers\n            .get(header::AUTHORIZATION)\n            .and_then(|value| value.to_str().ok())\n            .and_then(|value| value.strip_prefix(\"Bearer \"))\n            .ok_or(ApiError::Unauthorized)?;\n        let claims = verify(&keys.secret, token)?;\n        Ok(AuthUser { id: claims.sub, roles: claims.roles })\n    }\n}\n\nasync fn admin_tasks(user: AuthUser) -> Result<&'static str, ApiError> {\n    user.require_role(\"admin\")?;\n    Ok(\"[]\")\n}"
      },
      "questions": [
        {
          "q": "How do you stop a JWT from becoming a long-lived credential?",
          "options": [
            "Use long expiries and rely on the signature",
            "Use short access-token TTLs plus refresh tokens",
            "Store roles in the token and never expire it",
            "Put the password in the payload"
          ],
          "answer": 1,
          "explain": "A signed token is valid until it expires, so short TTLs limit the damage of theft. Refresh tokens carry the long-lived session."
        },
        {
          "q": "What must jsonwebtoken 11 have before encode or decode works?",
          "options": [
            "An installed CryptoProvider from the rust_crypto or aws_lc_rs feature",
            "A global signing key",
            "A tokio runtime",
            "An include_bytes! call"
          ],
          "answer": 0,
          "explain": "The signing backend is pluggable. Install DEFAULT_PROVIDER once at startup, or encode and decode fail at runtime."
        }
      ],
      "production": [
        "Install the crypto provider once, before the server accepts traffic, and fail startup if installation fails.",
        "Validate issuer, audience, expiry, and algorithm on every token; never derive the validation algorithm from the token header.",
        "Enforce object ownership in the SQL predicate, and return 404 rather than 403 for cross-tenant ids.",
        "Rotate signing keys with a kid header, and keep a denylist only for tokens that must die before expiry."
      ],
      "crates": [
        "jsonwebtoken",
        "axum",
        "serde",
        "serde_json"
      ],
      "pitfall": "Skipping the crypto provider install because tests use a mock verifier: the first real token encode in staging panics or errors at runtime, after the auth path looked green in unit tests.",
      "quickbytes": [
        "cargo add jsonwebtoken --features rust_crypto, then install rust_crypto::DEFAULT_PROVIDER.install_default() before serving any traffic.",
        "Validation::new(Algorithm::HS256) plus set_issuer, set_audience, and leeway 30; never take the algorithm from the token header.",
        "exp = iat + 900 caps theft damage. Enforce ownership with ... WHERE id = $1 AND owner_id = $2 and return 404 when zero rows change."
      ],
      "github": [
        {
          "name": "Keats/jsonwebtoken",
          "url": "https://github.com/Keats/jsonwebtoken"
        },
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        }
      ],
      "resources": [
        {
          "title": "jsonwebtoken 11 crate documentation",
          "url": "https://docs.rs/jsonwebtoken/11.1.0/jsonwebtoken/",
          "kind": "docs"
        },
        {
          "title": "jsonwebtoken Validation options",
          "url": "https://docs.rs/jsonwebtoken/11.1.0/jsonwebtoken/struct.Validation.html",
          "kind": "docs"
        },
        {
          "title": "jsonwebtoken repository",
          "url": "https://github.com/Keats/jsonwebtoken",
          "kind": "repo"
        },
        {
          "title": "axum FromRequestParts for auth extractors",
          "url": "https://docs.rs/axum/0.8.9/axum/extract/trait.FromRequestParts.html",
          "kind": "docs"
        },
        {
          "title": "Let's Get Rusty - Rust tutorials (YouTube)",
          "url": "https://www.youtube.com/@letsgetrusty",
          "kind": "video"
        }
      ]
    },
    {
      "id": "w06",
      "n": 6,
      "title": "Realtime with WebSockets and SSE",
      "minutes": 90,
      "level": "industry",
      "goal": "Serve live updates over WebSockets and SSE with one tokio broadcast fan-out, and decide explicitly what happens to slow consumers.",
      "sections": [
        {
          "h": "Choose the transport before the protocol",
          "p": [
            "WebSockets give bidirectional frames over one connection. SSE gives a one-way server stream over plain HTTP, with browser reconnection and Last-Event-ID built into the EventSource API. A feed that only notifies clients usually wants SSE.",
            "Both need heartbeats to survive idle-connection timeouts. A WebSocket Ping every 30 seconds or an SSE keep-alive comment stops a load balancer with a 60 second idle timeout from cutting quiet connections."
          ],
          "code": "// WebSocket: client sends messages, server pushes, one TCP connection.\n// SSE: server pushes text/event-stream frames, client reconnects on drop.\n//\n// Browser support: EventSource is built in; WebSocket needs no library either.\n// Cost: SSE is one long HTTP response, so it composes with normal proxies and auth.\n\nlet app = Router::new()\n    .route(\"/ws\", get(ws_handler))\n    .route(\"/events\", get(sse_handler));"
        },
        {
          "h": "WebSocket upgrade in axum 0.8",
          "p": [
            "WebSocketUpgrade consumes the request and gives you the socket inside on_upgrade. Set limits before upgrading: maximum message size, maximum frame size, and a write buffer that matches your fan-out rate.",
            "In axum 0.8 a text message is Message::Text(Utf8Bytes), not a String, which is why the code converts through to_text or uses the Message::text constructor when sending."
          ],
          "code": "use axum::{\n    extract::{\n        ws::{Message, WebSocket, WebSocketUpgrade},\n        State,\n    },\n    response::IntoResponse,\n};\nuse tokio::sync::broadcast::error::RecvError;\n\nasync fn ws_handler(\n    ws: WebSocketUpgrade,\n    State(state): State<AppState>,\n) -> impl IntoResponse {\n    ws.max_message_size(64 * 1024)\n        .on_upgrade(move |socket| handle_socket(socket, state))\n}\n\nasync fn handle_socket(mut socket: WebSocket, state: AppState) {\n    let mut events = state.events.subscribe();\n    loop {\n        tokio::select! {\n            incoming = socket.recv() => match incoming {\n                Some(Ok(message)) => {\n                    if let Ok(text) = message.to_text() {\n                        let _ = state.events.send(text.to_owned());\n                    }\n                }\n                Some(Err(_)) | None => break,\n            },\n            event = events.recv() => match event {\n                Ok(text) => {\n                    if socket.send(Message::text(text)).await.is_err() {\n                        break;\n                    }\n                }\n                Err(RecvError::Lagged(skipped)) => {\n                    tracing::warn!(skipped, \"websocket consumer lagged\");\n                }\n                Err(RecvError::Closed) => break,\n            },\n        }\n    }\n}"
        },
        {
          "h": "Fan-out with tokio broadcast",
          "p": [
            "broadcast::channel(capacity) gives every subscriber its own cursor into a ring buffer. A consumer that falls more than capacity messages behind receives Lagged(n) on the next recv and skips ahead; the publisher is never blocked.",
            "That is the right default for feeds: one slow phone must not stall the writer. Decide the policy explicitly: log and continue for non-critical updates, disconnect the client when it must refetch, or emit a resync event carrying full state."
          ],
          "code": "use tokio::sync::broadcast;\n\n#[derive(Clone)]\nstruct AppState {\n    events: broadcast::Sender<String>,\n}\n\n#[tokio::main]\nasync fn main() {\n    let (events, _) = broadcast::channel::<String>(256);\n    let state = AppState { events };\n    // one sender in state; each connection calls state.events.subscribe()\n    let _ = state;\n}",
          "tip": "Capacity is measured in messages, not bytes. A chat payload of 1 KB with capacity 256 means up to 256 KB buffered per slow subscriber before Lagged kicks in."
        },
        {
          "h": "SSE from the same fan-out",
          "p": [
            "Sse::new takes a Stream of Result<Event, E> and streams it as text/event-stream. Each connection needs its own receiver, so create it with subscribe() inside the handler, not at router construction time.",
            "Keep-alives are mandatory behind proxies. Add Cache-Control: no-store and disable proxy buffering (for nginx, X-Accel-Buffering: no); otherwise events arrive in one burst when the connection closes."
          ],
          "code": "use axum::response::sse::{Event, KeepAlive, Sse};\nuse futures_util::stream;\nuse std::{convert::Infallible, time::Duration};\nuse tokio::sync::broadcast::{error::RecvError, Sender};\n\nfn task_events(\n    sender: Sender<String>,\n) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {\n    let receiver = sender.subscribe();\n    let events = stream::unfold(receiver, |mut receiver| async move {\n        loop {\n            match receiver.recv().await {\n                Ok(payload) => {\n                    let event = Event::default().event(\"task\").data(payload);\n                    return Some((Ok(event), receiver));\n                }\n                Err(RecvError::Lagged(skipped)) => {\n                    tracing::warn!(skipped, \"sse consumer lagged\");\n                }\n                Err(RecvError::Closed) => return None,\n            }\n        }\n    });\n\n    Sse::new(events).keep_alive(\n        KeepAlive::new()\n            .interval(Duration::from_secs(15))\n            .text(\"keep-alive\"),\n    )\n}",
          "tip": "Last-Event-ID only helps if you keep a replay buffer. Without one, tell clients that a reconnect should refetch state instead of resuming from an id you cannot honour."
        }
      ],
      "exercise": {
        "prompt": "Implement /ws so every received text is broadcast to all connected clients, and treat a lagged consumer by sending a resync notice and closing the socket. Share one channel through AppState.",
        "starter": "use axum::{\n    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, State},\n    response::IntoResponse,\n};\nuse tokio::sync::broadcast;\n\n#[derive(Clone)]\nstruct AppState {\n    events: broadcast::Sender<String>,\n}\n\nasync fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {\n    ws.on_upgrade(move |socket| handle(socket, state))\n}\n\nasync fn handle(_socket: WebSocket, _state: AppState) {\n    // subscribe, select over socket.recv() and receiver.recv()\n}",
        "hint": "Keep the loop from the lesson. On RecvError::Lagged, send Message::text(\"resync\") then break; on RecvError::Closed just break.",
        "solution": "use axum::{\n    extract::{\n        ws::{Message, WebSocket, WebSocketUpgrade},\n        State,\n    },\n    response::IntoResponse,\n};\nuse tokio::sync::broadcast::{self, error::RecvError};\n\n#[derive(Clone)]\nstruct AppState {\n    events: broadcast::Sender<String>,\n}\n\nasync fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {\n    ws.max_message_size(64 * 1024)\n        .on_upgrade(move |socket| handle(socket, state))\n}\n\nasync fn handle(mut socket: WebSocket, state: AppState) {\n    let mut events = state.events.subscribe();\n    loop {\n        tokio::select! {\n            incoming = socket.recv() => match incoming {\n                Some(Ok(message)) => {\n                    if let Ok(text) = message.to_text() {\n                        let _ = state.events.send(text.to_owned());\n                    }\n                }\n                Some(Err(_)) | None => break,\n            },\n            event = events.recv() => match event {\n                Ok(text) => {\n                    if socket.send(Message::text(text)).await.is_err() {\n                        break;\n                    }\n                }\n                Err(RecvError::Lagged(skipped)) => {\n                    tracing::warn!(skipped, \"slow websocket consumer, closing\");\n                    let _ = socket.send(Message::text(\"resync\")).await;\n                    break;\n                }\n                Err(RecvError::Closed) => break,\n            },\n        }\n    }\n}"
      },
      "questions": [
        {
          "q": "What does a broadcast receiver return when it falls too far behind?",
          "options": [
            "Err(RecvError::Lagged(n))",
            "Err(RecvError::Closed)",
            "It blocks the publisher",
            "A truncated message"
          ],
          "answer": 0,
          "explain": "The receiver skips ahead and reports how many messages it missed. The publisher is never blocked, which is the point of bounded fan-out."
        },
        {
          "q": "Where should the broadcast sender live?",
          "options": [
            "One per WebSocket handler",
            "In shared state, created once at startup",
            "In a static mut",
            "One per request"
          ],
          "answer": 1,
          "explain": "Every connection subscribes to the same sender. A per-handler channel gives each client a private channel with no fan-out."
        }
      ],
      "production": [
        "Create the broadcast channel once in AppState; a per-connection channel silently delivers nothing to other clients.",
        "Send heartbeats below the shortest idle timeout in your infrastructure, and measure the gap after deploys.",
        "Choose the slow-consumer policy in writing: continue with gaps, disconnect, or resync, and instrument lag counters.",
        "Limit WebSocket message size and frame size so one client cannot allocate unbounded memory per message."
      ],
      "crates": [
        "axum",
        "tokio",
        "futures-util",
        "tracing",
        "serde_json"
      ],
      "pitfall": "Building the broadcast channel inside the WebSocket handler. Each connection then owns a private channel, clients appear connected, and nobody receives anybody else's messages.",
      "quickbytes": [
        "Create broadcast::channel(256) once in AppState; every connection calls state.events.subscribe() -- never build a channel per handler.",
        "On RecvError::Lagged(n): log n (or send a resync frame) and continue; the publisher is never blocked, so make the policy explicit in code.",
        "SSE needs KeepAlive::new().interval(Duration::from_secs(15)), plus Cache-Control: no-store and X-Accel-Buffering: no behind nginx."
      ],
      "github": [
        {
          "name": "tokio-rs/tokio",
          "url": "https://github.com/tokio-rs/tokio"
        },
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        }
      ],
      "resources": [
        {
          "title": "axum WebSocket module",
          "url": "https://docs.rs/axum/0.8.9/axum/extract/ws/index.html",
          "kind": "docs"
        },
        {
          "title": "axum SSE response",
          "url": "https://docs.rs/axum/0.8.9/axum/response/sse/index.html",
          "kind": "docs"
        },
        {
          "title": "tokio broadcast channel",
          "url": "https://docs.rs/tokio/1.54.1/tokio/sync/broadcast/index.html",
          "kind": "docs"
        },
        {
          "title": "axum websocket example",
          "url": "https://github.com/tokio-rs/axum/tree/main/examples/websockets",
          "kind": "repo"
        },
        {
          "title": "Jon Gjengset - Rust deep dives (YouTube)",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ]
    },
    {
      "id": "w07",
      "n": 7,
      "title": "API contracts, versioning, and idempotency",
      "minutes": 85,
      "level": "industry",
      "goal": "Generate OpenAPI from the code with utoipa 6, version the surface without breaking clients, and design keyset pagination and idempotent writes.",
      "sections": [
        {
          "h": "utoipa 6 generates the document from the code",
          "p": [
            "utoipa reads types and handler attributes at compile time. ToSchema produces components, the path attribute produces an operation, and the OpenApi derive assembles the document you serve as JSON.",
            "The generated document is only as good as the annotations. Add a test that parses /openapi.json and asserts every public route appears, so a new handler cannot ship undocumented."
          ],
          "code": "use axum::{extract::Path, routing::get, Json, Router};\nuse utoipa::{OpenApi, ToSchema};\n\n#[derive(ToSchema, serde::Serialize, serde::Deserialize)]\nstruct Task {\n    id: i64,\n    title: String,\n    done: bool,\n}\n\n#[utoipa::path(\n    get,\n    path = \"/tasks/{id}\",\n    params((\"id\" = i64, Path, description = \"Task id\")),\n    responses(\n        (status = 200, description = \"Task found\", body = Task),\n        (status = 404, description = \"Task not found\", body = Problem)\n    )\n)]\nasync fn get_task(Path(id): Path<i64>) -> Result<Json<Task>, ApiError> {\n    // Problem is the RFC 9457 body from the errors module; it derives ToSchema.\n    Err(ApiError::NotFound(id))\n}\n\n#[derive(OpenApi)]\n#[openapi(\n    paths(get_task),\n    components(schemas(Task, Problem)),\n    tags((name = \"tasks\", description = \"Task management\"))\n)]\nstruct ApiDoc;\n\nfn app() -> Router {\n    Router::new()\n        .route(\"/tasks/{id}\", get(get_task))\n        .route(\"/openapi.json\", get(|| async { Json(ApiDoc::openapi()) }))\n}",
          "tip": "utoipa 6 targets OpenAPI 3.2. If a downstream gateway only accepts 3.0, validate the generated document there before assuming it will import."
        },
        {
          "h": "Versioning that survives real clients",
          "p": [
            "Put the major version in the path: /v1. Inside a version, restrict changes to additive ones: new optional fields, new endpoints, and new response headers. Renaming a field or changing a type is a new major version.",
            "When removal is unavoidable, announce it with Deprecation and Sunset response headers, run both behaviours behind a flag, and delete the old branch only after traffic telemetry shows zero callers."
          ],
          "code": "use axum::http::{HeaderValue, Response};\n\n// Additive inside v1: safe.\n// Add a field, add an endpoint, add a new optional query parameter.\n\n// Breaking: removal, rename, type change, stricter validation.\n// => /v2, or a documented deprecation window.\n\nfn deprecate(mut response: Response<axum::body::Body>, sunset: &'static str) -> Response<axum::body::Body> {\n    response.headers_mut().insert(\n        axum::http::header::HeaderName::from_static(\"sunset\"),\n        HeaderValue::from_static(sunset),\n    );\n    response\n}",
          "tip": "Enum variants are a versioning trap. A client that rejects unknown variants breaks the day you add one; document whether clients must ignore unknown values before you ship one."
        },
        {
          "h": "Keyset pagination instead of offsets",
          "p": [
            "OFFSET degrades as pages get deeper and skips or repeats rows when writes land between requests. Keyset pagination asks for rows after a cursor: WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT $3.",
            "Return an opaque cursor built from the last row's sort key plus a has_more flag. Index the exact tuple you sort by, and treat a malformed cursor as a 400 with your problem+json envelope."
          ],
          "code": "use base64::Engine as _;\nuse serde::{Deserialize, Serialize};\n\n#[derive(Deserialize)]\nstruct PageQuery {\n    limit: Option<u32>,\n    after: Option<String>,\n}\n\n#[derive(Serialize, Deserialize)]\nstruct Cursor {\n    created_at_ms: i64,\n    id: i64,\n}\n\nfn decode_cursor(raw: &str) -> Result<Cursor, ApiError> {\n    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD\n        .decode(raw)\n        .map_err(|_| ApiError::Invalid(\"after cursor is not valid base64\".into()))?;\n    serde_json::from_slice(&bytes)\n        .map_err(|_| ApiError::Invalid(\"after cursor is not valid JSON\".into()))\n}\n\nfn page_limit(query: &PageQuery) -> Result<u32, ApiError> {\n    let limit = query.limit.unwrap_or(50);\n    if !(1..=100).contains(&limit) {\n        return Err(ApiError::Invalid(\"limit must be between 1 and 100\".into()));\n    }\n    Ok(limit)\n}",
          "tip": "Sorting by created_at alone is not stable when two rows share a timestamp. Add the primary key to the sort and to the cursor, or pages will occasionally duplicate a row."
        },
        {
          "h": "Idempotency keys for unsafe retries",
          "p": [
            "A client that times out after a POST cannot know whether the write happened. Accept an Idempotency-Key header, store the key with a hash of the request body and the stored response, and replay that response on retry.",
            "Make the key unique per tenant in the database so two concurrent retries cannot both insert. The loser reads the existing row and returns the same response. Expire keys after a day and return 422 when the same key arrives with a different body."
          ],
          "code": "use axum::http::HeaderMap;\n\nasync fn create_task(\n    headers: HeaderMap,\n    State(state): State<AppState>,\n) -> Result<Json<serde_json::Value>, ApiError> {\n    let key = headers\n        .get(\"idempotency-key\")\n        .and_then(|value| value.to_str().ok())\n        .filter(|value| (16..=128).contains(&value.len()))\n        .ok_or(ApiError::Invalid(\"idempotency-key header is required\".into()))?;\n\n    // Storage contract:\n    //   UNIQUE (tenant_id, idempotency_key)\n    //   columns: request_hash, status_code, response_json, created_at\n    // 1. INSERT ... ON CONFLICT DO NOTHING\n    // 2. if inserted, run the write and store the response\n    // 3. if not inserted, compare request_hash and replay the stored response\n    let _ = (key, state);\n    Ok(Json(serde_json::json!({ \"status\": \"stored\" })))\n}",
          "tip": "Hash the canonicalised body, not the raw bytes: JSON key order and whitespace differ between retries from different SDKs, and a byte hash falsely reports a mismatch."
        }
      ],
      "exercise": {
        "prompt": "Add a keyset cursor to GET /tasks: accept limit and after, cap the limit at 100, return items plus next_cursor, and reject a bad cursor with a 400 problem+json.",
        "starter": "use axum::extract::Query;\nuse serde::{Deserialize, Serialize};\n\n#[derive(Deserialize)]\nstruct PageQuery {\n    limit: Option<u32>,\n    after: Option<String>,\n}\n\n#[derive(Serialize)]\nstruct TaskPage {\n    items: Vec<String>,\n    next_cursor: Option<String>,\n}\n\nasync fn list_tasks(Query(query): Query<PageQuery>) -> Result<axum::Json<TaskPage>, ApiError> {\n    todo!()\n}",
        "hint": "Validate the limit, decode the cursor when present, and build next_cursor only when the page is full. Reuse decode_cursor and page_limit from the lesson.",
        "solution": "use axum::{extract::Query, Json};\nuse base64::Engine as _;\nuse serde::{Deserialize, Serialize};\n\n#[derive(Deserialize)]\nstruct PageQuery {\n    limit: Option<u32>,\n    after: Option<String>,\n}\n\n#[derive(Serialize, Deserialize)]\nstruct Cursor {\n    created_at_ms: i64,\n    id: i64,\n}\n\n#[derive(Serialize)]\nstruct TaskRow {\n    id: i64,\n    title: String,\n    created_at_ms: i64,\n}\n\n#[derive(Serialize)]\nstruct TaskPage {\n    items: Vec<String>,\n    next_cursor: Option<String>,\n}\n\nfn page_limit(query: &PageQuery) -> Result<usize, ApiError> {\n    let limit = query.limit.unwrap_or(50);\n    if !(1..=100).contains(&limit) {\n        return Err(ApiError::Unprocessable(\n            \"limit must be between 1 and 100\".into(),\n        ));\n    }\n    Ok(limit as usize)\n}\n\nfn decode_cursor(raw: &str) -> Result<Cursor, ApiError> {\n    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD\n        .decode(raw)\n        .map_err(|_| ApiError::Invalid(\"after is not valid base64\".into()))?;\n    serde_json::from_slice(&bytes)\n        .map_err(|_| ApiError::Invalid(\"after is not valid JSON\".into()))\n}\n\nfn encode_cursor(row: &TaskRow) -> Result<String, ApiError> {\n    let cursor = Cursor { created_at_ms: row.created_at_ms, id: row.id };\n    let bytes = serde_json::to_vec(&cursor).map_err(|_| ApiError::Internal)?;\n    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))\n}\n\nasync fn list_tasks(\n    Query(query): Query<PageQuery>,\n) -> Result<Json<TaskPage>, ApiError> {\n    let limit = page_limit(&query)?;\n    let _cursor = match query.after.as_deref() {\n        Some(raw) => Some(decode_cursor(raw)?),\n        None => None,\n    };\n\n    // Repository call: fetch limit + 1 rows so has_more needs no second query.\n    // SELECT id, title, created_at_ms FROM tasks\n    // WHERE ($cursor IS NULL OR (created_at_ms, id) < ($1, $2))\n    // ORDER BY created_at_ms DESC, id DESC\n    // LIMIT $limit + 1\n    let mut rows: Vec<TaskRow> = Vec::new();\n\n    let has_more = rows.len() > limit;\n    rows.truncate(limit);\n\n    let next_cursor = match (has_more, rows.last()) {\n        (true, Some(last)) => Some(encode_cursor(last)?),\n        _ => None,\n    };\n\n    Ok(Json(TaskPage {\n        items: rows.into_iter().map(|row| row.title).collect(),\n        next_cursor,\n    }))\n}"
      },
      "questions": [
        {
          "q": "Why does keyset pagination beat OFFSET for deep pages?",
          "options": [
            "It returns fewer columns",
            "It stays an index range scan and is stable while rows change",
            "It removes the need for authentication",
            "It removes the need for indexes"
          ],
          "answer": 1,
          "explain": "OFFSET scans and discards rows and shifts when data changes. A cursor on the sort key becomes a range scan with stable results."
        },
        {
          "q": "What belongs in an idempotency record?",
          "options": [
            "Only the key",
            "The key, a hash of the request body, and the stored response",
            "The client IP address",
            "A copy of the access token"
          ],
          "answer": 1,
          "explain": "The body hash detects key reuse with a different payload, and the stored response lets a retry replay the original result."
        }
      ],
      "production": [
        "Serve the generated OpenAPI document and assert in CI that every registered route appears in it.",
        "Write the versioning policy down: which changes are additive, who approves a major bump, and how long deprecations run.",
        "Keep cursors opaque and validated; never expose a SQL predicate or a raw timestamp to clients.",
        "Enforce idempotency keys with a database constraint, not an in-process map that dies with the pod."
      ],
      "crates": [
        "utoipa",
        "axum",
        "serde",
        "serde_json",
        "base64"
      ],
      "pitfall": "Hand-writing the OpenAPI YAML next to the handlers. It drifts on the first rename, and the discoverability tool that clients trust starts lying about the API.",
      "quickbytes": [
        "Cursor = base64url(JSON {created_at_ms, id}); query WHERE (created_at_ms, id) < ($1, $2) ORDER BY created_at_ms DESC, id DESC LIMIT n + 1.",
        "Inside /v1 ship only additive changes; a rename, removal, or type change means /v2 plus Deprecation and Sunset headers with a traffic check.",
        "Idempotency: UNIQUE (tenant_id, idempotency_key), canonical body hash, stored response. Replay it on retry, 422 when the same key has a new body."
      ],
      "github": [
        {
          "name": "juhaku/utoipa",
          "url": "https://github.com/juhaku/utoipa"
        },
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        }
      ],
      "resources": [
        {
          "title": "utoipa 6 crate documentation",
          "url": "https://docs.rs/utoipa/6.0.0/utoipa/",
          "kind": "docs"
        },
        {
          "title": "utoipa path attribute",
          "url": "https://docs.rs/utoipa/6.0.0/utoipa/attr.path.html",
          "kind": "docs"
        },
        {
          "title": "utoipa examples repository",
          "url": "https://github.com/juhaku/utoipa/tree/master/examples",
          "kind": "repo"
        },
        {
          "title": "RustVideos - Rust conference talks (YouTube)",
          "url": "https://www.youtube.com/@RustVideos",
          "kind": "video"
        },
        {
          "title": "Roseau - Source-based API breaking change analysis (ICSME 2025)",
          "url": "https://arxiv.org/abs/2507.17369",
          "kind": "paper"
        }
      ]
    },
    {
      "id": "w08",
      "n": 8,
      "title": "Testing and hardening HTTP services",
      "minutes": 90,
      "level": "industry",
      "goal": "Test the real router with oneshot, cover SQL with testcontainers, fuzz and load-test the edges, and ship the security headers and body limits production needs.",
      "sections": [
        {
          "h": "oneshot drives the real router",
          "p": [
            "tower::ServiceExt::oneshot calls the router the way hyper does, without binding a port or leaking ports between parallel tests. Build the app from the same constructor production uses, send an http::Request with a Body, and assert on status, headers, and the collected body.",
            "Collecting the body requires http_body_util::BodyExt. Deserialize it instead of comparing strings: JSON field order is not part of the contract, and a body check catches the refactor that returns 200 with an empty payload."
          ],
          "code": "use axum::{body::Body, http::Request, Router};\nuse http_body_util::BodyExt;\nuse tower::ServiceExt;\n\nasync fn call(app: Router, uri: &str) -> (axum::http::StatusCode, serde_json::Value) {\n    let response = app\n        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())\n        .await\n        .unwrap();\n    let status = response.status();\n    let bytes = response.into_body().collect().await.unwrap().to_bytes();\n    (status, serde_json::from_slice(&bytes).unwrap())\n}\n\n#[tokio::test]\nasync fn health_returns_ok() {\n    let (status, body) = call(app_for_test().await, \"/health\").await;\n    assert_eq!(status, axum::http::StatusCode::OK);\n    assert_eq!(body[\"status\"], \"ok\");\n}",
          "tip": "oneshot consumes the router, so clone it with .clone() before each call when a test needs two requests. A Router clone is cheap and shares the same state."
        },
        {
          "h": "Cover SQL with testcontainers",
          "p": [
            "Unit tests miss transaction and migration bugs. The testcontainers crate starts a Postgres container per test binary, exposes its mapped port, and removes it when the process exits.",
            "Run migrations once at startup, then give each test isolation through a transaction that rolls back or a unique schema. Containers cost seconds, so keep the split deliberate: many oneshot tests over a fake repository for HTTP contracts, a smaller container suite for queries."
          ],
          "code": "// Cargo.toml\n// [dev-dependencies]\n// testcontainers = \"...\"\n// testcontainers-modules = { features = [\"postgres\"] }\n//\n// Shape of a container-backed test:\n// 1. start the container, read the mapped host port\n// 2. build the connection string, run migrations\n// 3. build AppState against that pool, run oneshot requests\n// 4. drop the container; do not reuse it across test binaries",
          "tip": "Pin the database image tag. A moving postgres:latest turns an unrelated upstream release into a red build with no code change."
        },
        {
          "h": "Fuzz the parser, load-test the edge",
          "p": [
            "A request body is hostile input. Property-test deserializers and hand-written parsers with cargo-fuzz; serde guarantees no undefined behaviour, not that your validation covers every accepted shape.",
            "Load-test against a staging deployment with a fixed scenario and assert budgets: p99 latency, error rate, and zero unexpected 5xx. Run it after the functional suite so a regression has a commit to blame."
          ],
          "code": "// cargo install cargo-fuzz\n// cargo fuzz init\n// cargo fuzz add parse_task\n//\n// fuzz/fuzz_targets/parse_task.rs\n#![no_main]\nuse libfuzzer_sys::fuzz_target;\n\nfuzz_target!(|data: &[u8]| {\n    let _ = serde_json::from_slice::<CreateTask>(data);\n});",
          "tip": "Fuzzers find crashes, not policy bugs. A payload that parses but violates a business rule is a missing test, not a fuzz target."
        },
        {
          "h": "Headers and limits that prevent common failures",
          "p": [
            "Add X-Content-Type-Options: nosniff, a Referrer-Policy, and a Content-Security-Policy for browser-facing responses. Send HSTS only when the service is behind TLS it controls, otherwise the header locks users out of the plain-HTTP path.",
            "Cap request bodies with RequestBodyLimitLayer so a huge JSON body is rejected before it is buffered. Strip or redact Authorization and Cookie headers on the way out of logs and traces."
          ],
          "code": "use axum::{http::header, Router};\nuse tower_http::{\n    limit::RequestBodyLimitLayer,\n    set_header::SetResponseHeaderLayer,\n};\n\nfn harden(app: Router) -> Router {\n    app.layer(RequestBodyLimitLayer::new(1024 * 1024))\n        .layer(SetResponseHeaderLayer::overriding(\n            header::X_CONTENT_TYPE_OPTIONS,\n            header::HeaderValue::from_static(\"nosniff\"),\n        ))\n        .layer(SetResponseHeaderLayer::overriding(\n            header::REFERRER_POLICY,\n            header::HeaderValue::from_static(\"no-referrer\"),\n        ))\n}",
          "tip": "Test the headers, not the configuration. One test per security header costs a few lines and catches the layer that was accidentally dropped during a refactor."
        }
      ],
      "exercise": {
        "prompt": "Write two oneshot tests: one expects a 404 problem+json for an unknown task, one expects a 422 when limit exceeds 100. Deserialize the bodies and assert content-type.",
        "starter": "use axum::{body::Body, http::Request};\nuse http_body_util::BodyExt;\nuse tower::ServiceExt;\n\nasync fn json_call(app: axum::Router, uri: &str) -> (axum::http::StatusCode, String, serde_json::Value) {\n    let response = app\n        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())\n        .await\n        .unwrap();\n    // collect the body, read content-type, deserialize JSON\n    todo!()\n}\n\n// #[tokio::test] async fn unknown_task_is_problem_json() { ... }\n// #[tokio::test] async fn limit_above_cap_is_unprocessable() { ... }",
        "hint": "Read the content-type header with response.headers().get(header::CONTENT_TYPE). Collect the body with response.into_body().collect().await.unwrap().to_bytes() before turning it into a serde_json::Value.",
        "solution": "use axum::{body::Body, http::Request, Router};\nuse http_body_util::BodyExt;\nuse tower::ServiceExt;\n\nasync fn json_call(\n    app: Router,\n    uri: &str,\n) -> (axum::http::StatusCode, String, serde_json::Value) {\n    let response = app\n        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())\n        .await\n        .unwrap();\n\n    let status = response.status();\n    let content_type = response\n        .headers()\n        .get(axum::http::header::CONTENT_TYPE)\n        .and_then(|value| value.to_str().ok())\n        .unwrap_or_default()\n        .to_owned();\n    let bytes = response.into_body().collect().await.unwrap().to_bytes();\n    let body = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);\n    (status, content_type, body)\n}\n\n// app_for_test() builds the router from the production app() constructor\n// over an in-memory repository, so middleware and error mapping are exercised.\n#[tokio::test]\nasync fn unknown_task_is_problem_json() {\n    let (status, content_type, body) =\n        json_call(app_for_test().await, \"/api/v1/tasks/999999\").await;\n    assert_eq!(status, axum::http::StatusCode::NOT_FOUND);\n    assert_eq!(content_type, \"application/problem+json\");\n    assert_eq!(body[\"status\"], 404);\n}\n\n#[tokio::test]\nasync fn limit_above_cap_is_unprocessable() {\n    let (status, content_type, body) =\n        json_call(app_for_test().await, \"/api/v1/tasks?limit=1000\").await;\n    assert_eq!(status, axum::http::StatusCode::UNPROCESSABLE_ENTITY);\n    assert_eq!(content_type, \"application/problem+json\");\n    assert_eq!(body[\"status\"], 422);\n}"
      },
      "questions": [
        {
          "q": "What does tower::ServiceExt::oneshot give a test?",
          "options": [
            "A random port on localhost",
            "One call through the real router without binding a socket",
            "A mocked database",
            "A load test"
          ],
          "answer": 1,
          "explain": "oneshot consumes the service for a single request, so tests exercise extractors, layers, and error mapping without networking."
        },
        {
          "q": "Which test belongs in the testcontainers suite rather than the oneshot suite?",
          "options": [
            "JSON field naming",
            "SQL queries and migrations against real Postgres",
            "404 fallback shapes",
            "Security headers"
          ],
          "answer": 1,
          "explain": "Container tests are slower but catch SQL and migration bugs. HTTP contract checks stay in the fast oneshot suite."
        }
      ],
      "production": [
        "Build every test from the production app() constructor so middleware and state wiring are covered, not bypassed.",
        "Assert content-type and body shape, not just status codes; a 200 with an empty body must fail the test.",
        "Pin container image tags and run the SQL suite on every PR that touches migrations.",
        "Run a load smoke test in CI against staging and fail the build on p99 or 5xx regressions."
      ],
      "crates": [
        "tower",
        "http-body-util",
        "testcontainers",
        "tower-http",
        "axum",
        "serde_json"
      ],
      "pitfall": "Testing handlers by calling them as plain functions. The router, extractors, layers, and error conversion are exactly where the bugs live, and a direct call skips all of them.",
      "quickbytes": [
        "Build tests from the production app() and drive it with app.clone().oneshot(Request::builder().uri(\"/health\").body(Body::empty())?).",
        "Collect bodies with http_body_util::BodyExt; assert content-type: application/problem+json and body fields, not just the status code.",
        "cargo add --dev testcontainers testcontainers-modules --features testcontainers-modules/postgres; pin the postgres image tag."
      ],
      "github": [
        {
          "name": "tower-rs/tower",
          "url": "https://github.com/tower-rs/tower"
        },
        {
          "name": "testcontainers/testcontainers-rs",
          "url": "https://github.com/testcontainers/testcontainers-rs"
        }
      ],
      "resources": [
        {
          "title": "tower ServiceExt oneshot",
          "url": "https://docs.rs/tower/latest/tower/trait.ServiceExt.html",
          "kind": "docs"
        },
        {
          "title": "testcontainers crate documentation",
          "url": "https://docs.rs/testcontainers/latest/testcontainers/",
          "kind": "docs"
        },
        {
          "title": "axum testing example",
          "url": "https://github.com/tokio-rs/axum/tree/main/examples/testing",
          "kind": "repo"
        },
        {
          "title": "tower-http response header layers",
          "url": "https://docs.rs/tower-http/0.6.8/tower_http/set_header/index.html",
          "kind": "docs"
        },
        {
          "title": "fasterthanlime - Rust videos (YouTube)",
          "url": "https://www.youtube.com/@fasterthanlime",
          "kind": "video"
        }
      ]
    },
    {
      "id": "w09",
      "n": 9,
      "title": "Header-based versioning and content negotiation",
      "minutes": 75,
      "level": "advanced",
      "goal": "Negotiate a major API version from Accept, answer 406 instead of guessing, and make every cache key on the choice.",
      "sections": [
        {
          "h": "Version in the path or in the media type",
          "p": [
            "A path prefix such as /v1 is coarse, visible in logs, and trivially cacheable: every cache keys on the URL alone. Media-type versioning keeps one URL per resource and puts the version in the representation, which is what content negotiation was designed for. Both work; mixing them in one API does not.",
            "The mechanism is the Accept header. A client lists representations it can parse, optionally with q-values, and the server picks one it can produce. The response must echo the exact chosen media type in Content-Type, and must declare Vary: Accept so shared caches stop treating /tasks/42 as a single resource."
          ],
          "code": "GET /tasks/42 HTTP/1.1\nHost: api.example.com\nAccept: application/vnd.acme+json; version=2,\n        application/vnd.acme+json; version=1; q=0.8\n\nHTTP/1.1 200 OK\nContent-Type: application/vnd.acme+json; version=2\nVary: Accept\nCache-Control: private, max-age=30\n\n{\"id\":42,\"title\":\"Ship it\",\"labels\":[]}",
          "tip": "A version parameter the server ignores is worse than no versioning: the client believes it negotiated v2 while parsing a v1 body. Reject what you cannot represent."
        },
        {
          "h": "Parse the header defensively",
          "p": [
            "Accept is a comma-separated list of media ranges, each with optional parameters. Split on commas, then on semicolons, and read only the parameters you define: version selects a major, q orders preferences, everything else is ignored. A malformed q must not become q=1.",
            "Map the parsed major to an explicit enum. That forces a compile error when a new version is added and prevents a stray version=99 from falling through to a default handler that happens to serialize the latest shape. A client that sends only */*, as curl does by default, must get the documented default rather than a 406."
          ],
          "code": "use axum::{\n    extract::FromRequestParts,\n    http::{header, request::Parts},\n};\n\n#[derive(Clone, Copy, Debug, PartialEq, Eq)]\npub enum ApiVersion {\n    V1,\n    V2,\n}\n\nimpl ApiVersion {\n    const fn media_type(self) -> &'static str {\n        match self {\n            ApiVersion::V1 => \"application/vnd.acme+json; version=1\",\n            ApiVersion::V2 => \"application/vnd.acme+json; version=2\",\n        }\n    }\n\n    const fn from_major(major: u8) -> Option<Self> {\n        match major {\n            1 => Some(ApiVersion::V1),\n            2 => Some(ApiVersion::V2),\n            _ => None,\n        }\n    }\n}\nfn negotiate(accept: Option<&str>) -> Option<ApiVersion> {\n    let mut best: Option<(f32, ApiVersion)> = None;\n    for item in accept?.split(',') {\n        let mut params = item.split(';');\n        let media = params.next().unwrap_or_default().trim();\n        if media == \"*/*\" || media == \"application/*\" {\n            best.get_or_insert((0.1, ApiVersion::V1));\n            continue;\n        }\n        if media != \"application/vnd.acme+json\" && media != \"application/json\" {\n            continue;\n        }\n        let (mut major, mut quality) = (1u8, 1.0f32);\n        for param in params {\n            let Some((key, value)) = param.split_once('=') else {\n                continue;\n            };\n            let value = value.trim().trim_matches('\"');\n            match key.trim() {\n                \"version\" => major = value.parse().unwrap_or(u8::MAX),\n                \"q\" => quality = value.parse().unwrap_or(0.0),\n                _ => {}\n            }\n        }\n        let Some(version) = ApiVersion::from_major(major) else {\n            continue;\n        };\n        if quality > 0.0 && best.map_or(true, |(best_q, _)| quality > best_q) {\n            best = Some((quality, version));\n        }\n    }\n    best.map(|(_, version)| version)\n}",
          "tip": "q=0 means 'not acceptable', not 'lowest priority'. Dropping the item is correct; treating it as a weak preference sends a representation the client explicitly refused."
        },
        {
          "h": "The choice must reach the response and the cache",
          "p": [
            "The extractor below returns your error type, so an unknown major becomes a 406 problem+json that lists the supported versions. The handler then receives ApiVersion and must serialize the matching shape, not the newest struct with fields omitted. Both branches deserve a test that asserts the exact media type, because a missing parameter is invisible to JSON clients.",
            "Content-Type on the response is the negotiated media type, including the version parameter. Writes are a separate negotiation: the request body's Content-Type must match the version being written, and a mismatch is 415, not 406, because the body is in a format you cannot process."
          ],
          "code": "use axum::{\n    extract::{FromRequestParts, Path},\n    http::{header, request::Parts, HeaderValue},\n    response::{IntoResponse, Response},\n    Json,\n};\n\nasync fn get_task(version: ApiVersion, Path(id): Path<i64>) -> Response {\n    let body = match version {\n        ApiVersion::V1 => serde_json::json!({ \"id\": id, \"title\": \"Ship it\" }),\n        ApiVersion::V2 => serde_json::json!({ \"id\": id, \"title\": \"Ship it\", \"labels\": [] }),\n    };\n    let mut response = Json(body).into_response();\n    response.headers_mut().insert(\n        header::CONTENT_TYPE,\n        HeaderValue::from_static(version.media_type()),\n    );\n    response.headers_mut().insert(\n        header::VARY,\n        HeaderValue::from_static(\"accept\"),\n    );\n    response\n}\n\nimpl<S> FromRequestParts<S> for ApiVersion\nwhere\n    S: Send + Sync,\n{\n    type Rejection = ApiError;\n\n    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {\n        let accept = parts\n            .headers\n            .get(header::ACCEPT)\n            .and_then(|value| value.to_str().ok());\n        negotiate(accept).ok_or(ApiError::NotAcceptable)\n    }\n}",
          "tip": "Set Vary in a layer, not per handler. A handler that returns early on 404 or 500 skips its own header code, and that error response is exactly the one a CDN likes to cache."
        }
      ],
      "exercise": {
        "prompt": "Implement ApiVersion::from_major, make the extractor answer 406 with a problem+json body listing the supported majors, and add a test proving a version=3 request never reaches the handler.",
        "starter": "use axum::{\n    extract::FromRequestParts,\n    http::{request::Parts, StatusCode},\n    response::{IntoResponse, Response},\n    Json,\n};\n\n#[derive(Clone, Copy)]\npub enum ApiVersion {\n    V1,\n    V2,\n}\n\nimpl ApiVersion {\n    // TODO: from_major(1) -> V1, from_major(2) -> V2, everything else -> None\n}\n\n// TODO: implement FromRequestParts for ApiVersion with Rejection = Response,\n// returning a 406 problem+json when the version is unknown.\n\nasync fn get_task(_version: ApiVersion) -> &'static str {\n    \"ok\"\n}",
        "hint": "Use Rejection = Response and build the 406 with (StatusCode::NOT_ACCEPTABLE, Json(json!({...}))).into_response(). In the test, send Accept: application/vnd.acme+json; version=3 through oneshot and assert 406.",
        "solution": "use axum::{\n    body::Body,\n    extract::FromRequestParts,\n    http::{header, request::Parts, Request, StatusCode},\n    response::{IntoResponse, Response},\n    Json,\n};\nuse tower::ServiceExt;\n\n#[derive(Clone, Copy)]\npub enum ApiVersion {\n    V1,\n    V2,\n}\n\nimpl ApiVersion {\n    const fn from_major(major: u8) -> Option<Self> {\n        match major {\n            1 => Some(ApiVersion::V1),\n            2 => Some(ApiVersion::V2),\n            _ => None,\n        }\n    }\n}\n\nfn unsupported() -> Response {\n    let body = serde_json::json!({\n        \"type\": \"https://api.example.com/problems/not-acceptable\",\n        \"title\": \"Unsupported API version\",\n        \"status\": 406,\n        \"detail\": \"supported versions: 1, 2\"\n    });\n    (StatusCode::NOT_ACCEPTABLE, Json(body)).into_response()\n}\n\nimpl<S> FromRequestParts<S> for ApiVersion\nwhere\n    S: Send + Sync,\n{\n    type Rejection = Response;\n\n    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {\n        let accept = parts\n            .headers\n            .get(header::ACCEPT)\n            .and_then(|value| value.to_str().ok())\n            .unwrap_or(\"application/vnd.acme+json; version=1\");\n        let major = accept\n            .split(',')\n            .flat_map(|item| item.split(';').skip(1))\n            .find_map(|param| param.trim().strip_prefix(\"version=\"))\n            .and_then(|value| value.trim_matches('\"').parse::<u8>().ok());\n        major.and_then(ApiVersion::from_major).ok_or_else(unsupported)\n    }\n}\n\nasync fn get_task(version: ApiVersion) -> Response {\n    let body = match version {\n        ApiVersion::V1 => serde_json::json!({ \"id\": 1 }),\n        ApiVersion::V2 => serde_json::json!({ \"id\": 1, \"labels\": [] }),\n    };\n    (StatusCode::OK, Json(body)).into_response()\n}\n\nfn app() -> axum::Router {\n    axum::Router::new().route(\"/tasks\", axum::routing::get(get_task))\n}\n\n#[tokio::test]\nasync fn unknown_version_is_not_acceptable() {\n    let request = Request::builder()\n        .uri(\"/tasks\")\n        .header(header::ACCEPT, \"application/vnd.acme+json; version=3\")\n        .body(Body::empty())\n        .unwrap();\n    let response = app().oneshot(request).await.unwrap();\n    assert_eq!(response.status(), StatusCode::NOT_ACCEPTABLE);\n}"
      },
      "questions": [
        {
          "q": "A client asks for version=9, which this server does not implement. What is the correct answer?",
          "options": [
            "200 with the newest representation",
            "406 listing the supported representations",
            "415 because the version is unsupported",
            "400 because the header is malformed"
          ],
          "answer": 1,
          "explain": "406 means the server cannot produce any representation the client accepts. 415 is about the request body's media type; 400 would mean the header itself could not be parsed."
        },
        {
          "q": "Why must a negotiated response carry Vary: Accept?",
          "options": [
            "It instructs shared caches to key on Accept",
            "It enables gzip compression",
            "It is required by HTTP/1.1 for JSON",
            "It prevents cross-origin reads"
          ],
          "answer": 0,
          "explain": "Without Vary, a CDN keys on the URL alone and can serve the v1 body to a client that asked for v2. Vary makes the representation part of the cache key."
        }
      ],
      "quickbytes": [
        "Vendor media type: application/vnd.acme+json; version=2. Echo it in Content-Type and add Vary: Accept on every response, errors included.",
        "Parse Accept by splitting on commas then semicolons, and treat q=0 as unacceptable. Never fall back to the latest version for an unknown major.",
        "Unknown representation on a read is 406; a request body in a media type you cannot process is 415. Keep the two separate in your status table."
      ],
      "production": [
        "Set Vary: Accept in one middleware so 404s and 500s are covered, not only successful handler responses.",
        "Keep an explicit enum of supported majors and a test per version that asserts the exact Content-Type.",
        "Document the default version used when Accept is absent, and make that default stable for the life of the major.",
        "Log the negotiated version per request so you can see which clients still pin v1 before removing it."
      ],
      "crates": [
        "axum",
        "http",
        "serde_json",
        "tower-http"
      ],
      "pitfall": "Returning the newest JSON shape for any Accept value because the extractor only checks the prefix. Clients pinned to v1 parse an object with new fields, and the mismatch shows up as a deserialization bug in their code, not yours.",
      "github": [
        {
          "name": "hyperium/headers",
          "url": "https://github.com/hyperium/headers"
        },
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        }
      ],
      "resources": [
        {
          "title": "MDN: HTTP content negotiation",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Content_negotiation",
          "kind": "docs"
        },
        {
          "title": "axum FromRequestParts trait",
          "url": "https://docs.rs/axum/0.8.9/axum/extract/trait.FromRequestParts.html",
          "kind": "docs"
        },
        {
          "title": "hyperium/headers typed header crate",
          "url": "https://github.com/hyperium/headers",
          "kind": "repo"
        },
        {
          "title": "RustVideos - Rust conference talks (YouTube)",
          "url": "https://www.youtube.com/@RustVideos",
          "kind": "video"
        }
      ]
    },
    {
      "id": "w10",
      "n": 10,
      "title": "Multipart uploads and streaming request bodies",
      "minutes": 85,
      "level": "industry",
      "goal": "Accept large uploads without buffering them in memory, enforce per-route caps, and stream files back with backpressure.",
      "sections": [
        {
          "h": "Multipart is a stream of fields",
          "p": [
            "axum's Multipart extractor lives behind the multipart feature and must be the last handler argument, because it consumes the body. Each Field is a stream: chunk() yields Bytes until the field is exhausted, so a 300 MB video never has to exist in memory at once.",
            "file_name and content_type are client-supplied metadata, not facts. Store under a server-generated key, decide the stored content type from your allowlist, and never build a filesystem path from the uploaded name. Keep the original name in a database column for display only, escaped at render time."
          ],
          "code": "use axum::{\n    extract::{DefaultBodyLimit, Multipart},\n    http::StatusCode,\n    routing::post,\n    Router,\n};\nuse tokio::io::AsyncWriteExt;\n\nconst MAX_UPLOAD: usize = 20 * 1024 * 1024;\n\nasync fn upload(mut multipart: Multipart) -> Result<StatusCode, ApiError> {\n    let mut stored = 0;\n    while let Some(mut field) = multipart\n        .next_field()\n        .await\n        .map_err(|_| ApiError::Invalid(\"malformed multipart body\".into()))?\n    {\n        if field.name() != Some(\"file\") {\n            continue;\n        }\n        if field.content_type() != Some(\"application/pdf\") {\n            return Err(ApiError::UnsupportedMedia);\n        }\n        let key = uuid::Uuid::new_v4();\n        let path = std::path::Path::new(\"/var/lib/uploads\").join(key.to_string());\n        let mut file = tokio::fs::File::create(&path)\n            .await\n            .map_err(|_| ApiError::Internal)?;\n        let mut written = 0usize;\n        while let Some(chunk) = field\n            .chunk()\n            .await\n            .map_err(|_| ApiError::Invalid(\"upload truncated\".into()))?\n        {\n            written += chunk.len();\n            if written > MAX_UPLOAD {\n                let _ = tokio::fs::remove_file(&path).await;\n                return Err(ApiError::PayloadTooLarge);\n            }\n            file.write_all(&chunk)\n                .await\n                .map_err(|_| ApiError::Internal)?;\n        }\n        file.flush().await.map_err(|_| ApiError::Internal)?;\n        stored += 1;\n        tracing::info!(%key, bytes = written, \"upload stored\");\n    }\n    if stored == 0 {\n        return Err(ApiError::Invalid(\"expected a file field\".into()));\n    }\n    Ok(StatusCode::CREATED)\n}",
          "tip": "Delete the partial file on every error path. An aborted 20 MB upload that leaves a file behind is how a disk fills up months later with no obvious owner."
        },
        {
          "h": "Body limits are per route, with one global backstop",
          "p": [
            "axum caps bodies at 2 MB by default, and Multipart inherits that cap. DefaultBodyLimit::max on a route changes the cap for extractors that opt into it, which is how one endpoint accepts 20 MB while a JSON endpoint stays at 64 KB.",
            "tower-http's RequestBodyLimitLayer applies before any extractor sees the body, including third-party ones that ignore DefaultBodyLimit. Use it as the outer ceiling, and keep the per-route limits below it so a mistake in one route cannot raise the global budget. Keep both numbers next to each other in configuration; limits that drift apart are a bug waiting for the next upload size change."
          ],
          "code": "use axum::{extract::DefaultBodyLimit, routing::post, Router};\nuse tower_http::limit::RequestBodyLimitLayer;\n\nfn app() -> Router {\n    let json_routes = Router::new()\n        .route(\"/tasks\", post(create_task))\n        .layer(DefaultBodyLimit::max(64 * 1024));\n\n    let upload_routes = Router::new()\n        .route(\"/uploads\", post(upload))\n        .layer(DefaultBodyLimit::max(21 * 1024 * 1024));\n\n    Router::new()\n        .merge(json_routes)\n        .merge(upload_routes)\n        .layer(RequestBodyLimitLayer::new(25 * 1024 * 1024))\n}",
          "tip": "Content-Length is a claim. Count the bytes you actually read, because a chunked request has no length and an attacker can send a small header with a huge body."
        },
        {
          "h": "Downloads stream with backpressure",
          "p": [
            "The same rule applies in reverse: do not read a file into a Vec to return it. Body::from_stream over tokio_util::io::ReaderStream sends chunks as the client consumes them, so a slow client applies backpressure instead of pinning the file in memory.",
            "Set Content-Length when the file size is known so clients can show progress, and set Content-Disposition with a sanitized fixed name. If you need byte-range requests, handle Range and 206 explicitly or serve immutable objects from object storage instead. For range support, prefer a 206 implementation with If-Range validation over naive byte slicing."
          ],
          "code": "use axum::{\n    body::Body,\n    extract::Path,\n    http::{header, HeaderValue},\n    response::Response,\n};\nuse tokio_util::io::ReaderStream;\n\nasync fn download(Path(key): Path<String>) -> Result<Response, ApiError> {\n    let path = std::path::Path::new(\"/var/lib/uploads\").join(&key);\n    let file = tokio::fs::File::open(&path)\n        .await\n        .map_err(|_| ApiError::NotFound)?;\n    let len = file.metadata().await.map_err(|_| ApiError::Internal)?.len();\n\n    let mut response = Response::new(Body::from_stream(ReaderStream::new(file)));\n    response.headers_mut().insert(\n        header::CONTENT_TYPE,\n        HeaderValue::from_static(\"application/pdf\"),\n    );\n    response.headers_mut().insert(\n        header::CONTENT_LENGTH,\n        HeaderValue::from_str(&len.to_string()).expect(\"decimal length\"),\n    );\n    response.headers_mut().insert(\n        header::CONTENT_DISPOSITION,\n        HeaderValue::from_static(\"attachment\"),\n    );\n    Ok(response)\n}",
          "tip": "A streamed response cannot change its status after the first chunk. Validate authorization and existence before constructing the body, or the client gets a 200 that fails halfway."
        }
      ],
      "exercise": {
        "prompt": "Cap an upload at three fields, reject any text field longer than 200 characters with 422, and report the bytes received. Keep the file field streaming to disk.",
        "starter": "use axum::{extract::Multipart, http::StatusCode, Json};\n\nconst MAX_FIELDS: usize = 3;\nconst MAX_TEXT: usize = 200;\n\nasync fn upload(mut multipart: Multipart) -> Result<StatusCode, ApiError> {\n    // 1. count fields, reject the fourth\n    // 2. text fields: field.text() and check chars().count()\n    // 3. file fields: stream chunks, do not call bytes()\n    todo!()\n}",
        "hint": "Call field.file_name().is_none() to tell text from file before consuming the field. Return ApiError::Unprocessable with a message naming the limit; keep the byte counter across chunks.",
        "solution": "use axum::{extract::Multipart, http::StatusCode, Json};\n\nconst MAX_FIELDS: usize = 3;\nconst MAX_TEXT: usize = 200;\n\nasync fn upload(\n    mut multipart: Multipart,\n) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {\n    let mut fields = 0;\n    let mut bytes = 0usize;\n\n    while let Some(mut field) = multipart\n        .next_field()\n        .await\n        .map_err(|_| ApiError::Invalid(\"malformed multipart body\".into()))?\n    {\n        fields += 1;\n        if fields > MAX_FIELDS {\n            return Err(ApiError::Unprocessable(format!(\n                \"at most {MAX_FIELDS} fields are accepted\"\n            )));\n        }\n\n        if field.file_name().is_none() {\n            let text = field\n                .text()\n                .await\n                .map_err(|_| ApiError::Invalid(\"unreadable text field\".into()))?;\n            if text.chars().count() > MAX_TEXT {\n                return Err(ApiError::Unprocessable(format!(\n                    \"text fields are limited to {MAX_TEXT} characters\"\n                )));\n            }\n        } else {\n            while let Some(chunk) = field\n                .chunk()\n                .await\n                .map_err(|_| ApiError::Invalid(\"upload truncated\".into()))?\n            {\n                bytes += chunk.len();\n            }\n        }\n    }\n\n    Ok((StatusCode::CREATED, Json(serde_json::json!({ \"bytes\": bytes }))))\n}"
      },
      "questions": [
        {
          "q": "Where must Multipart appear in a handler's argument list?",
          "options": [
            "First, before State",
            "Last, because it consumes the body",
            "Anywhere, extractors are order-independent",
            "Only in handlers without State"
          ],
          "answer": 1,
          "explain": "Multipart implements FromRequest, not FromRequestParts. The body can be consumed once, so it must be the final argument."
        },
        {
          "q": "Why is field.bytes().await dangerous for a 300 MB upload?",
          "options": [
            "It rejects files above 2 MB",
            "It buffers the whole field in memory",
            "It bypasses authentication",
            "It cannot read binary data"
          ],
          "answer": 1,
          "explain": "bytes() collects the entire field. Streaming with chunk() keeps memory bounded and lets you abort as soon as the byte cap is crossed."
        }
      ],
      "quickbytes": [
        "Stream uploads with field.chunk() and count bytes yourself; the 2 MB default from DefaultBodyLimit applies to Multipart until you raise it per route.",
        "RequestBodyLimitLayer is the global backstop; DefaultBodyLimit::max on a route sets the tighter budget for that endpoint.",
        "Serve downloads with Body::from_stream(ReaderStream::new(file)) plus a known Content-Length, and validate before the first chunk is written."
      ],
      "production": [
        "Spool uploads to a directory with a size quota and delete partial files on every error path.",
        "Allowlist content types and re-check magic bytes before the file is served back to anyone.",
        "Keep the global body limit below the process memory budget, and alarm when 413 rates spike.",
        "Test a truncated upload and a chunked request without Content-Length, not just the happy path."
      ],
      "crates": [
        "axum",
        "tokio",
        "tokio-util",
        "uuid"
      ],
      "pitfall": "Raising the body limit to 100 MB so uploads stop failing, then calling field.bytes().await in the handler: peak memory becomes concurrent uploads times 100 MB, and the process dies under a load that the old limit used to reject cheaply.",
      "github": [
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        },
        {
          "name": "tokio-rs/tokio",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "resources": [
        {
          "title": "axum Multipart extractor",
          "url": "https://docs.rs/axum/0.8.9/axum/extract/struct.Multipart.html",
          "kind": "docs"
        },
        {
          "title": "axum multipart Field API",
          "url": "https://docs.rs/axum/0.8.9/axum/extract/multipart/struct.Field.html",
          "kind": "docs"
        },
        {
          "title": "MDN: Content-Disposition",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Disposition",
          "kind": "docs"
        },
        {
          "title": "tokio-util ReaderStream",
          "url": "https://docs.rs/tokio-util/latest/tokio_util/io/struct.ReaderStream.html",
          "kind": "docs"
        },
        {
          "title": "tokio-rs/axum examples",
          "url": "https://github.com/tokio-rs/axum/tree/main/examples",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "w11",
      "n": 11,
      "title": "Per-tenant rate limits and quotas",
      "minutes": 85,
      "level": "industry",
      "goal": "Enforce a keyed token bucket before the handler, return honest 429 metadata, and keep quota accounting correct across replicas.",
      "sections": [
        {
          "h": "A limiter is a keyed token bucket",
          "p": [
            "Rate limiting needs a key and a bucket. The key is usually the tenant or API key; the bucket has a burst size and a refill rate. governor implements GCRA, so a burst of 20 requests can pass instantly and then the caller settles to the sustained rate.",
            "Key on something you authenticated. Keying on an X-Tenant-Id header before authentication lets a caller rotate the header and multiply its allowance. Hash the API key with blake3 before using it as a map key so a heap dump does not expose live credentials."
          ],
          "code": "use axum::{routing::get, Router};\nuse tower_governor::{\n    governor::GovernorConfigBuilder,\n    key_extractor::KeyExtractor,\n    GovernorLayer,\n};\n\n#[derive(Clone)]\nstruct TenantKey;\n\nimpl KeyExtractor for TenantKey {\n    type Key = String;\n\n    fn extract<T>(\n        &self,\n        req: &axum::http::Request<T>,\n    ) -> Result<Self::Key, tower_governor::GovernorError> {\n        req.headers()\n            .get(\"x-api-key\")\n            .and_then(|value| value.to_str().ok())\n            .map(|key| blake3::hash(key.as_bytes()).to_hex().to_string())\n            .ok_or(tower_governor::GovernorError::UnableToExtractKey)\n    }\n}\n\nfn app() -> Router {\n    let config = GovernorConfigBuilder::default()\n        .per_millisecond(600) // one token every 600 ms = 100 req/min\n        .burst_size(20)\n        .key_extractor(TenantKey)\n        .finish()\n        .expect(\"valid quota\");\n\n    Router::new()\n        .route(\"/tasks\", get(list_tasks))\n        .layer(GovernorLayer::new(config))\n}",
          "tip": "tower_governor's per_second(n) means one token every n seconds, not n tokens per second. For 100 req/min use per_millisecond(600); the naming is a classic source of a limit that is wrong by orders of magnitude."
        },
        {
          "h": "Across replicas, the counter must be shared",
          "p": [
            "An in-process bucket is exact and fast, but each replica has its own. With ten replicas, a 100 req/min tenant can send 1000. Either divide the limit by the replica count and accept the approximation, or move the counter to Redis or Postgres.",
            "A fixed window is one INCR plus an expiry, and it must be atomic: two commands leave a key with no TTL if the process dies between them, which leaks memory forever. The Lua script below is one round trip and one atomic unit."
          ],
          "code": "-- KEYS[1] = quota:{tenant}:{window_start}\n-- ARGV[1] = limit, ARGV[2] = window in milliseconds\nlocal used = redis.call(\"INCR\", KEYS[1])\nif used == 1 then\n  redis.call(\"PEXPIRE\", KEYS[1], ARGV[2])\nend\nlocal ttl = redis.call(\"PTTL\", KEYS[1])\nreturn {\n  used <= tonumber(ARGV[1]) and 1 or 0,\n  math.max(0, tonumber(ARGV[1]) - used),\n  math.max(0, ttl)\n}",
          "tip": "A fixed window admits up to twice the limit at a boundary: 100 requests at 12:00:59 and 100 more at 12:01:00. Use a sliding window or a token bucket when the budget protects a downstream system."
        },
        {
          "h": "429 is a contract, quotas are a ledger",
          "p": [
            "A rate limit is temporary and retryable, so it is 429 with Retry-After and RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset. A monthly quota that is exhausted is a billing state, not a burst: return a distinct problem type and do not invite a retry before the period resets.",
            "Emit headers on allowed responses too. Clients that only learn the limit when they hit it have to guess, and SDKs implement retry with the wrong jitter. Include the reset as a Unix timestamp, not a duration, so a retry can be scheduled without clock drift compounding."
          ],
          "code": "use axum::http::{HeaderName, HeaderValue};\n\npub struct QuotaHeaders {\n    pub limit: u64,\n    pub remaining: u64,\n    pub reset_after_secs: u64,\n}\n\nfn stamp(mut response: axum::response::Response, quota: &QuotaHeaders) -> axum::response::Response {\n    let headers = response.headers_mut();\n    for (name, value) in [\n        (\"ratelimit-limit\", quota.limit),\n        (\"ratelimit-remaining\", quota.remaining),\n    ] {\n        headers.insert(\n            HeaderName::from_static(name),\n            HeaderValue::from_str(&value.to_string()).expect(\"decimal\"),\n        );\n    }\n    headers.insert(\n        HeaderName::from_static(\"retry-after\"),\n        HeaderValue::from_str(&quota.reset_after_secs.to_string()).expect(\"decimal\"),\n    );\n    response\n}",
          "tip": "Do not count rejected requests against a monthly quota, but do count them in your rate-limit metrics. Otherwise a retry storm consumes the customer's plan."
        }
      ],
      "exercise": {
        "prompt": "Implement TenantKey so the limiter keys on a hashed API key, configure 100 requests/minute with a burst of 20, and prove with a test that the 21st immediate request returns 429.",
        "starter": "use tower_governor::{governor::GovernorConfigBuilder, key_extractor::KeyExtractor, GovernorLayer};\n\n#[derive(Clone)]\nstruct TenantKey;\n\n// TODO: impl KeyExtractor for TenantKey, key = blake3 hash of x-api-key\n// TODO: build the config at 100/min with burst 20\n// TODO: #[tokio::test] send 21 requests, assert the last is 429",
        "hint": "Return GovernorError::UnableToExtractKey when the header is missing. Build the router with the layer once and clone it per request with tower::ServiceExt::oneshot, so all 21 calls share one limiter.",
        "solution": "use axum::{body::Body, http::Request, routing::get, Router};\nuse tower::ServiceExt;\nuse tower_governor::{\n    governor::GovernorConfigBuilder, key_extractor::KeyExtractor, GovernorLayer,\n};\n\n#[derive(Clone)]\nstruct TenantKey;\n\nimpl KeyExtractor for TenantKey {\n    type Key = String;\n\n    fn extract<T>(\n        &self,\n        req: &Request<T>,\n    ) -> Result<Self::Key, tower_governor::GovernorError> {\n        req.headers()\n            .get(\"x-api-key\")\n            .and_then(|value| value.to_str().ok())\n            .map(|key| blake3::hash(key.as_bytes()).to_hex().to_string())\n            .ok_or(tower_governor::GovernorError::UnableToExtractKey)\n    }\n}\n\nfn app() -> Router {\n    let config = GovernorConfigBuilder::default()\n        .per_millisecond(600)\n        .burst_size(20)\n        .key_extractor(TenantKey)\n        .finish()\n        .expect(\"valid quota\");\n    Router::new().route(\"/tasks\", get(|| async { \"[]\" })).layer(GovernorLayer::new(config))\n}\n\n#[tokio::test]\nasync fn burst_then_too_many_requests() {\n    let app = app();\n    let mut last = None;\n    for _ in 0..21 {\n        let request = Request::builder()\n            .uri(\"/tasks\")\n            .header(\"x-api-key\", \"test-key\")\n            .body(Body::empty())\n            .unwrap();\n        last = Some(app.clone().oneshot(request).await.unwrap().status());\n    }\n    assert_eq!(last, Some(axum::http::StatusCode::TOO_MANY_REQUESTS));\n}"
      },
      "questions": [
        {
          "q": "What does GovernorConfigBuilder::per_second(100) configure?",
          "options": [
            "100 requests per second",
            "One request every 100 seconds",
            "A 100 second burst window",
            "100 requests per minute"
          ],
          "answer": 1,
          "explain": "The argument is a period in seconds for one token, despite the name. per_millisecond(600) gives 100 requests per minute."
        },
        {
          "q": "Why is a fixed-window counter a poor fit for protecting a downstream service?",
          "options": [
            "It cannot be stored in Redis",
            "It allows up to twice the limit across a window boundary",
            "It requires a database per tenant",
            "It rejects all bursts"
          ],
          "answer": 1,
          "explain": "Two windows back to back can each admit the full limit. A sliding window or token bucket smooths that boundary."
        }
      ],
      "quickbytes": [
        "Key the limiter on an authenticated identity, hash it before storage, and never trust a tenant header that arrives before auth.",
        "Per-replica buckets multiply the limit by the replica count; move the counter to Redis with one atomic Lua script when the limit is a real budget.",
        "Return 429 with Retry-After for bursts, and a separate problem type for an exhausted monthly quota that no retry can fix."
      ],
      "production": [
        "Publish the limit, the window, and the burst in the API docs and in response headers on success as well as failure.",
        "Alert on the ratio of 429s per tenant; a single customer hitting 40 percent is a support ticket, not a capacity problem.",
        "Load-test the limiter itself: hashing and lookups must stay cheap under the traffic they are meant to reject.",
        "Expire limiter state, and monitor its size; an unbounded map keyed by a client-controlled value is a memory leak."
      ],
      "crates": [
        "tower-governor",
        "governor",
        "blake3",
        "axum"
      ],
      "pitfall": "Configuring the limiter with per_second(100) expecting 100 requests per second. The real rate is one request every 100 seconds, the endpoint is effectively down, and the config reads as if it were correct.",
      "github": [
        {
          "name": "benwis/tower-governor",
          "url": "https://github.com/benwis/tower-governor"
        },
        {
          "name": "antifuchs/governor",
          "url": "https://github.com/boinkor-net/governor"
        }
      ],
      "resources": [
        {
          "title": "tower_governor crate documentation",
          "url": "https://docs.rs/tower_governor/0.8.0/tower_governor/",
          "kind": "docs"
        },
        {
          "title": "governor Quota API",
          "url": "https://docs.rs/governor/0.10.0/governor/struct.Quota.html",
          "kind": "docs"
        },
        {
          "title": "Designing Scalable Rate Limiting Systems (arXiv)",
          "url": "https://arxiv.org/abs/2602.11741",
          "kind": "paper"
        },
        {
          "title": "benwis/tower-governor repository",
          "url": "https://github.com/benwis/tower-governor",
          "kind": "repo"
        },
        {
          "title": "RustVideos - Rust conference talks (YouTube)",
          "url": "https://www.youtube.com/@RustVideos",
          "kind": "video"
        }
      ]
    },
    {
      "id": "w12",
      "n": 12,
      "title": "ETag, Cache-Control, and conditional requests",
      "minutes": 80,
      "level": "advanced",
      "goal": "Serve repeat reads from client and edge caches with correct validators, and never send a 304 that disagrees with the body.",
      "sections": [
        {
          "h": "Two caches, two sets of directives",
          "p": [
            "A browser cache and a CDN are different trust domains. private means only the end client may store the response; s-maxage overrides max-age for shared caches; stale-while-revalidate lets an edge serve a stale copy while it refreshes. Choose per endpoint, not per service.",
            "no-cache does not mean do not cache: it means revalidate before reuse. no-store is the directive that forbids writing the response to disk at all, and it is the only correct choice for tokens or one-time links. A response carrying Set-Cookie or Authorization must never be stored by a shared cache without an explicit public directive and a review."
          ],
          "code": "// Public list endpoint: 5 min in browsers, 60 s at the edge.\n// Cache-Control: public, max-age=300, s-maxage=60, stale-while-revalidate=30\n\n// Per-user data: the browser may store it, a shared cache may not.\n// Cache-Control: private, max-age=60\n\n// Tokens, one-time links, anything secret: never store.\n// Cache-Control: no-store\n\n// no-cache = store, but revalidate every time.\n// no-store  = do not write it anywhere.\n\n// Authenticated responses need this too: a shared cache will not reuse a\n// response to a request with Authorization unless you say public.",
          "tip": "A CDN that sees no Cache-Control may still apply a heuristic freshness lifetime. Be explicit on every response you care about; silence is a policy you did not choose."
        },
        {
          "h": "Validators turn a hit into a 304",
          "p": [
            "An ETag is an opaque validator for a representation. Derive it from the bytes you are about to send, or from a version column that changes on every write, and keep it stable while the body is unchanged. A hash of the serialized body is the honest option.",
            "On a conditional GET the client sends If-None-Match with one or more validators, including weak ones prefixed W/. If any match, return 304 with the ETag and Cache-Control and no body. Do not run the query twice to decide, and do not send a 304 when the representation differs."
          ],
          "code": "use axum::{\n    extract::{Path, State},\n    http::{header, HeaderMap, HeaderValue, StatusCode},\n    response::{IntoResponse, Response},\n    Json,\n};\n\nasync fn get_task(\n    State(state): State<AppState>,\n    Path(id): Path<i64>,\n    headers: HeaderMap,\n) -> Result<Response, ApiError> {\n    let task = state.tasks.get(id).await?.ok_or(ApiError::NotFound(id))?;\n    let body = serde_json::to_vec(&task).map_err(|_| ApiError::Internal)?;\n    let etag = format!(\"\\\"{}-{}\\\"\", task.version, blake3::hash(&body).to_hex());\n\n    // If-None-Match uses the weak comparison function: W/ prefixes are ignored.\n    let normalize = |value: &str| value.trim().trim_start_matches(\"W/\").to_owned();\n    let matches = headers\n        .get_all(header::IF_NONE_MATCH)\n        .iter()\n        .filter_map(|value| value.to_str().ok())\n        .flat_map(|value| value.split(','))\n        .any(|candidate| normalize(candidate) == normalize(&etag));\n\n    let mut response = if matches {\n        StatusCode::NOT_MODIFIED.into_response()\n    } else {\n        ([(header::CONTENT_TYPE, \"application/json\")], body).into_response()\n    };\n    response.headers_mut().insert(\n        header::ETAG,\n        HeaderValue::from_str(&etag).expect(\"hex and digits\"),\n    );\n    response.headers_mut().insert(\n        header::CACHE_CONTROL,\n        HeaderValue::from_static(\"private, max-age=60\"),\n    );\n    Ok(response)\n}",
          "tip": "A 304 must carry the same ETag and Cache-Control as the 200 it replaces. Some clients drop the stored entry when a validator goes missing from the 304."
        },
        {
          "h": "Writes invalidate, and compression changes the bytes",
          "p": [
            "If-Match on a write is optimistic concurrency control: the client sends the validator it read, and the update applies only when the version still matches. Zero rows updated is 412 Precondition Failed, not 500, and not a silent overwrite. A stale If-Match must never be retried blindly; the client re-reads the resource and resubmits with the new validator.",
            "Then the validator must change. Bumping a version column inside the same UPDATE makes the next GET produce a new ETag without a purge, and the CDN revalidates instead of serving the old body. The trap is computing a strong ETag before CompressionLayer rewrites the bytes: the same URL then has one validator and several representations."
          ],
          "code": "use axum::{\n    extract::{Path, State},\n    http::{header, HeaderMap, StatusCode},\n    response::{IntoResponse, Response},\n};\n\nasync fn update_task(\n    State(state): State<AppState>,\n    Path(id): Path<i64>,\n    headers: HeaderMap,\n    Json(patch): Json<PatchTask>,\n) -> Result<Response, ApiError> {\n    let expected: i64 = headers\n        .get(header::IF_MATCH)\n        .and_then(|value| value.to_str().ok())\n        .and_then(|value| value.trim_matches('\"').parse().ok())\n        .ok_or(ApiError::PreconditionRequired)?;\n\n    let updated = state.tasks.update_if_version(id, expected, patch).await?;\n    if !updated {\n        return Err(ApiError::PreconditionFailed);\n    }\n    Ok(StatusCode::NO_CONTENT.into_response())\n}\n\n// SQL: UPDATE tasks SET title = $1, version = version + 1, updated_at = now()\n//      WHERE id = $2 AND version = $3\n// Zero rows means the client's validator is stale.",
          "tip": "Pick one style and keep it: weak ETags (W/) when intermediaries transform the body, strong ETags only when the bytes are byte-identical for every client."
        }
      ],
      "exercise": {
        "prompt": "Return 304 when If-None-Match matches the current ETag, and 412 when If-Match does not match on a write. Keep both responses problem+json and cacheable per the rules above.",
        "starter": "use axum::http::{header, HeaderMap, StatusCode};\n\nfn etag_for(version: i64, body: &[u8]) -> String {\n    // TODO: version + blake3 hash of the body\n    todo!()\n}\n\nasync fn get_task(headers: HeaderMap) -> StatusCode {\n    // TODO: compare If-None-Match, return 304 or 200\n    todo!()\n}\n\nasync fn update_task(headers: HeaderMap) -> StatusCode {\n    // TODO: missing If-Match -> 428, mismatch -> 412\n    todo!()\n}",
        "hint": "For a GET, a match is 304 with no body. For a write, a missing If-Match is 428 Precondition Required and a present but stale one is 412; do not treat them as the same error.",
        "solution": "use axum::http::{header, HeaderMap, StatusCode};\n\nfn etag_for(version: i64, body: &[u8]) -> String {\n    format!(\"\\\"{}-{}\\\"\", version, blake3::hash(body).to_hex())\n}\n\nfn if_none_match(headers: &HeaderMap, etag: &str) -> bool {\n    headers\n        .get_all(header::IF_NONE_MATCH)\n        .iter()\n        .filter_map(|value| value.to_str().ok())\n        .flat_map(|value| value.split(','))\n        .any(|candidate| candidate.trim().trim_start_matches(\"W/\") == etag.trim_start_matches(\"W/\"))\n}\n\nasync fn get_task(headers: HeaderMap) -> StatusCode {\n    let body = br#\"{\"id\":1,\"title\":\"Ship it\"}\"#;\n    let etag = etag_for(7, body);\n    if if_none_match(&headers, &etag) {\n        StatusCode::NOT_MODIFIED\n    } else {\n        StatusCode::OK\n    }\n}\n\nasync fn update_task(headers: HeaderMap) -> Result<StatusCode, StatusCode> {\n    let Some(raw) = headers\n        .get(header::IF_MATCH)\n        .and_then(|value| value.to_str().ok())\n    else {\n        return Err(StatusCode::PRECONDITION_REQUIRED);\n    };\n    let expected: i64 = raw\n        .trim_matches('\"')\n        .parse()\n        .map_err(|_| StatusCode::BAD_REQUEST)?;\n    if expected != 7 {\n        return Err(StatusCode::PRECONDITION_FAILED);\n    }\n    Ok(StatusCode::NO_CONTENT)\n}"
      },
      "questions": [
        {
          "q": "What is the difference between no-cache and no-store?",
          "options": [
            "They are synonyms",
            "no-cache stores but revalidates; no-store forbids storage",
            "no-store only applies to CDNs",
            "no-cache disables ETags"
          ],
          "answer": 1,
          "explain": "no-cache permits storage with mandatory revalidation. no-store forbids writing the response anywhere, which is what secrets require."
        },
        {
          "q": "Why can a strong ETag be wrong when CompressionLayer is enabled?",
          "options": [
            "Compression strips the ETag header",
            "The same URL then has several byte representations with one validator",
            "Gzip changes the status code",
            "ETags cannot contain hex"
          ],
          "answer": 1,
          "explain": "A strong validator promises byte equality. gzip, brotli, and identity produce different bytes for the same resource, so either vary the ETag by encoding or use a weak validator."
        }
      ],
      "quickbytes": [
        "Set Cache-Control explicitly per endpoint: public with s-maxage for shared lists, private for user data, no-store for anything secret.",
        "Return 304 with the same ETag and Cache-Control and no body; compare every If-None-Match entry, including weak and comma-separated values.",
        "Bump a version column in the same UPDATE that changes the row, so the next GET has a new ETag and caches revalidate without a manual purge."
      ],
      "production": [
        "Never cache an authenticated response in a shared cache unless you have deliberately marked it public and stripped per-user data.",
        "Assert content-length is absent or zero on 304 responses in tests; a body on a 304 breaks some clients.",
        "Monitor cache hit ratio and 304 rate per route; a sudden drop in 304s usually means the validator changes on every request.",
        "Test with compression on and off, since the encoded representation is what actually reaches the client."
      ],
      "crates": [
        "axum",
        "http",
        "blake3",
        "tower-http"
      ],
      "pitfall": "Deriving the ETag from updated_at at one-second precision. Two edits inside the same second produce the same validator, so clients keep a stale body and every conditional request returns 304.",
      "github": [
        {
          "name": "tower-rs/tower-http",
          "url": "https://github.com/tower-rs/tower-http"
        },
        {
          "name": "hyperium/http",
          "url": "https://github.com/hyperium/http"
        }
      ],
      "resources": [
        {
          "title": "MDN: ETag header",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/ETag",
          "kind": "docs"
        },
        {
          "title": "MDN: conditional requests",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Conditional_requests",
          "kind": "docs"
        },
        {
          "title": "MDN: Cache-Control",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control",
          "kind": "docs"
        },
        {
          "title": "tower-rs/tower-http repository",
          "url": "https://github.com/tower-rs/tower-http",
          "kind": "repo"
        },
        {
          "title": "Jon Gjengset - Rust deep dives (YouTube)",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ]
    },
    {
      "id": "w13",
      "n": 13,
      "title": "Background jobs triggered by HTTP handlers",
      "minutes": 90,
      "level": "industry",
      "goal": "Hand work off from a request without losing it: commit a job row in the same transaction and let workers claim it with SKIP LOCKED.",
      "sections": [
        {
          "h": "tokio::spawn is not a queue",
          "p": [
            "Spawning a task from a handler is fast and survives nothing. A deploy, a panic, or a node eviction drops the work with no record that it existed, and there is no retry, no backpressure, and no way to answer the client's question about progress.",
            "Use spawn only for work whose loss is invisible: a cache warm, a metric flush. Anything the response promised, such as an email, an invoice, or an export, must be durable before the 202 is written. That means a row in the same transaction as the business change."
          ],
          "code": "use axum::http::{header, HeaderMap, HeaderValue, StatusCode};\n\nasync fn request_export(\n    State(state): State<AppState>,\n    AuthUser { id, .. }: AuthUser,\n) -> Result<(StatusCode, HeaderMap), ApiError> {\n    let mut tx = state.pool.begin().await?;\n    let job_id: i64 = sqlx::query_scalar(\n        \"INSERT INTO jobs (kind, payload, tenant_id)\n         VALUES ($1, $2, $3) RETURNING id\",\n    )\n    .bind(\"export\")\n    .bind(serde_json::json!({ \"user_id\": id }))\n    .bind(&id)\n    .fetch_one(&mut *tx)\n    .await?;\n    tx.commit().await?;\n\n    let mut headers = HeaderMap::new();\n    headers.insert(\n        header::LOCATION,\n        HeaderValue::from_str(&format!(\"/jobs/{job_id}\")).expect(\"path\"),\n    );\n    Ok((StatusCode::ACCEPTED, headers))\n}",
          "tip": "The 202 belongs after COMMIT, never before. A client that receives 202 and then sees no job row has no way to distinguish your bug from its own retry."
        },
        {
          "h": "Claim work with SKIP LOCKED",
          "p": [
            "A worker claims a batch by updating rows it selects in one statement. FOR UPDATE SKIP LOCKED makes concurrent workers step over locked rows instead of blocking, so throughput scales with the number of workers and no job is delivered twice while a claim is held.",
            "Claim quickly, then do the slow work outside the transaction. The lock is a lease, not a guarantee: if the worker dies mid-job, the row becomes claimable again after the lease expires and the job runs a second time. That is what at-least-once means in practice."
          ],
          "code": "#[derive(sqlx::FromRow)]\nstruct Job {\n    id: i64,\n    kind: String,\n    payload: serde_json::Value,\n    attempts: i32,\n}\n\nasync fn claim(pool: &sqlx::PgPool, limit: i64) -> Result<Vec<Job>, sqlx::Error> {\n    sqlx::query_as::<_, Job>(\n        \"UPDATE jobs SET locked_at = now(), attempts = attempts + 1\n         WHERE id IN (\n             SELECT id FROM jobs\n             WHERE completed_at IS NULL\n               AND run_at <= now()\n               AND (locked_at IS NULL OR locked_at < now() - interval '5 minutes')\n             ORDER BY id\n             LIMIT $1\n             FOR UPDATE SKIP LOCKED\n         )\n         RETURNING id, kind, payload, attempts\",\n    )\n    .bind(limit)\n    .fetch_all(pool)\n    .await\n}",
          "tip": "A lease that is shorter than your slowest job causes duplicate execution; longer than your restart budget delays recovery. Measure the p99 job duration and set the lease above it."
        },
        {
          "h": "Retries, backoff, and dead letters",
          "p": [
            "Every attempt updates attempts, run_at, and last_error. Backoff is exponential with jitter so a failing dependency does not get a synchronized retry wave. After a fixed number of attempts the job moves to a failed state that a human can inspect and replay.",
            "The operational signal is the age of the oldest unfinished job, not the count of jobs. A queue with ten thousand jobs that are all fresh is healthy; one job that has been pending for an hour is an incident."
          ],
          "code": "fn backoff_seconds(attempt: i32) -> i64 {\n    let base = 2i64.saturating_pow(attempt.clamp(1, 10) as u32);\n    let jitter = (uuid::Uuid::new_v4().as_u128() % 1000) as i64;\n    (base * 5 + jitter).min(3600)\n}\n\nasync fn finish(\n    pool: &sqlx::PgPool,\n    job: &Job,\n    outcome: Result<(), String>,\n) -> sqlx::Result<()> {\n    match outcome {\n        Ok(()) => {\n            sqlx::query(\"UPDATE jobs SET completed_at = now(), locked_at = NULL WHERE id = $1\")\n                .bind(job.id)\n                .execute(pool)\n                .await?;\n        }\n        Err(error) if job.attempts >= 8 => {\n            sqlx::query(\n                \"UPDATE jobs SET failed_at = now(), locked_at = NULL, last_error = $2\n                 WHERE id = $1\",\n            )\n            .bind(job.id)\n            .bind(error)\n            .execute(pool)\n            .await?;\n        }\n        Err(error) => {\n            sqlx::query(\n                \"UPDATE jobs SET locked_at = NULL, last_error = $3,\n                 run_at = now() + ($2::bigint * interval '1 second')\n                 WHERE id = $1\",\n            )\n            .bind(job.id)\n            .bind(backoff_seconds(job.attempts))\n            .bind(error)\n            .execute(pool)\n            .await?;\n        }\n    }\n    Ok(())\n}",
          "tip": "Make the handler idempotent with a natural key, typically the job id plus step name. At-least-once delivery is a property of the queue; exactly-once effects are a property of your handler."
        }
      ],
      "exercise": {
        "prompt": "Write the claim query and the retry update for a jobs table. Explain in comments what two workers polling at the same instant observe, and why the lease column exists.",
        "starter": "// jobs(id, kind, payload, attempts, run_at, locked_at, completed_at, failed_at, last_error)\nasync fn claim(pool: &sqlx::PgPool, limit: i64) -> Result<Vec<Job>, sqlx::Error> {\n    // 1. select claimable rows with FOR UPDATE SKIP LOCKED\n    // 2. stamp locked_at and increment attempts in the same statement\n    todo!()\n}\n\nasync fn reschedule(pool: &sqlx::PgPool, job: &Job, error: String) -> sqlx::Result<()> {\n    // TODO: clear the lock, set last_error, push run_at into the future\n    todo!()\n}",
        "hint": "Wrap the SELECT in an UPDATE ... WHERE id IN (...) RETURNING so the claim is atomic. Use a lease window in the WHERE clause to recover rows from dead workers.",
        "solution": "#[derive(sqlx::FromRow)]\nstruct Job {\n    id: i64,\n    kind: String,\n    payload: serde_json::Value,\n    attempts: i32,\n}\n\n// Two workers polling together: the first to reach the row locks it inside the\n// UPDATE; the second sees the locked row and SKIP LOCKED steps over it, so each\n// row is claimed exactly once per lease window. locked_at is the lease: if the\n// holder dies, the row becomes claimable again after five minutes.\nasync fn claim(pool: &sqlx::PgPool, limit: i64) -> Result<Vec<Job>, sqlx::Error> {\n    sqlx::query_as::<_, Job>(\n        \"UPDATE jobs SET locked_at = now(), attempts = attempts + 1\n         WHERE id IN (\n             SELECT id FROM jobs\n             WHERE completed_at IS NULL\n               AND failed_at IS NULL\n               AND run_at <= now()\n               AND (locked_at IS NULL OR locked_at < now() - interval '5 minutes')\n             ORDER BY id\n             LIMIT $1\n             FOR UPDATE SKIP LOCKED\n         )\n         RETURNING id, kind, payload, attempts\",\n    )\n    .bind(limit)\n    .fetch_all(pool)\n    .await\n}\n\nasync fn reschedule(pool: &sqlx::PgPool, job: &Job, error: String) -> sqlx::Result<()> {\n    let delay = (2i64.saturating_pow(job.attempts.clamp(1, 10) as u32) * 5).min(3600);\n    sqlx::query(\n        \"UPDATE jobs SET locked_at = NULL, last_error = $2,\n         run_at = now() + ($3::bigint * interval '1 second')\n         WHERE id = $1\",\n    )\n    .bind(job.id)\n    .bind(error)\n    .bind(delay)\n    .execute(pool)\n    .await?;\n    Ok(())\n}"
      },
      "questions": [
        {
          "q": "What does FOR UPDATE SKIP LOCKED buy a job queue?",
          "options": [
            "It guarantees the job runs once",
            "It lets concurrent workers claim different rows without blocking",
            "It orders jobs by priority",
            "It removes the need for a lease"
          ],
          "answer": 1,
          "explain": "SKIP LOCKED turns row locks into a work-distribution mechanism. It does not give exactly-once execution; a dead worker's row becomes claimable again."
        },
        {
          "q": "Which metric best detects a stalled worker?",
          "options": [
            "Total jobs enqueued",
            "Age of the oldest unfinished job",
            "Number of workers running",
            "Average payload size"
          ],
          "answer": 1,
          "explain": "Queue depth stays green while one old job rots. The age of the oldest claimable job catches a stalled worker or a poison message immediately."
        }
      ],
      "quickbytes": [
        "Insert the job row in the same transaction as the business change, then return 202 with a Location header after the commit succeeds.",
        "Claim with UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING, and treat locked_at as a lease with an expiry.",
        "Backoff with jitter, cap attempts, and alert on the age of the oldest unfinished job rather than on queue depth."
      ],
      "production": [
        "Make every handler idempotent under the job id, because the queue will deliver some jobs twice.",
        "Keep the claim transaction short; never hold a row lock while calling an external service.",
        "Ship a replay path for dead-lettered jobs before you need it at 2 a.m.",
        "Give workers their own connection pool budget so a job backlog cannot starve request handlers."
      ],
      "crates": [
        "sqlx",
        "tokio",
        "serde_json",
        "uuid"
      ],
      "pitfall": "Enqueuing with tokio::spawn after the response is written. The client gets a 202, the pod is replaced during the next rollout, and the job never existed anywhere.",
      "github": [
        {
          "name": "launchbadge/sqlx",
          "url": "https://github.com/transact-rs/sqlx"
        },
        {
          "name": "tokio-rs/tokio",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "resources": [
        {
          "title": "sqlx crate documentation",
          "url": "https://docs.rs/sqlx/latest/sqlx/",
          "kind": "docs"
        },
        {
          "title": "tokio::task::spawn",
          "url": "https://docs.rs/tokio/1.54.1/tokio/task/fn.spawn.html",
          "kind": "docs"
        },
        {
          "title": "launchbadge/sqlx repository",
          "url": "https://github.com/transact-rs/sqlx",
          "kind": "repo"
        },
        {
          "title": "tokio-rs/tokio repository",
          "url": "https://github.com/tokio-rs/tokio",
          "kind": "repo"
        },
        {
          "title": "fasterthanlime - Rust videos (YouTube)",
          "url": "https://www.youtube.com/@fasterthanlime",
          "kind": "video"
        }
      ]
    },
    {
      "id": "w14",
      "n": 14,
      "title": "RED metrics and W3C trace propagation",
      "minutes": 90,
      "level": "industry",
      "goal": "Instrument every request with rate, errors, and duration keyed by route template, and carry one trace id across hops without cardinality blowups.",
      "sections": [
        {
          "h": "Three signals answer the first two questions",
          "p": [
            "For every route, record rate (requests per second), errors (failures per second, or a ratio), and duration (a histogram). That triad tells you whether the service is broken and whether it is slow, without reading a single log line. Instrument the server side; a client-side timer measures the network, not the queue you own.",
            "Take the route template from MatchedPath, not from the URI. The template is bounded by your router; the URI is bounded by your users. Record seconds, not milliseconds, and size the buckets around the SLO you actually promise. The same rule applies to the exporter: one scrape endpoint per process, with a low-cardinality job label."
          ],
          "code": "use std::time::Instant;\nuse axum::{\n    extract::{MatchedPath, Request},\n    middleware::Next,\n    response::Response,\n};\n\npub async fn track_red(req: Request, next: Next) -> Response {\n    let route = req\n        .extensions()\n        .get::<MatchedPath>()\n        .map(|matched| matched.as_str().to_owned())\n        .unwrap_or_else(|| \"unmatched\".to_owned());\n    let method = req.method().clone();\n    let started = Instant::now();\n\n    let response = next.run(req).await;\n\n    let class = match response.status().as_u16() / 100 {\n        2 => \"2xx\",\n        3 => \"3xx\",\n        4 => \"4xx\",\n        _ => \"5xx\",\n    };\n    metrics::counter!(\n        \"http_requests_total\",\n        \"route\" => route.clone(),\n        \"method\" => method.to_string(),\n        \"status\" => class,\n    )\n    .increment(1);\n    metrics::histogram!(\"http_request_duration_seconds\", \"route\" => route)\n        .record(started.elapsed().as_secs_f64());\n    response\n}",
          "tip": "A histogram recorded as a gauge, or in milliseconds while the buckets are in seconds, is worse than no metric: the dashboard is green and the p99 is wrong by a factor of 1000."
        },
        {
          "h": "Cardinality is the failure mode",
          "p": [
            "Every unique combination of label values is a separate time series. A label containing the raw path, a user id, an email, or an error string creates series faster than the scrape interval can absorb, and the metrics backend falls over during the incident it was meant to explain.",
            "Keep label values bounded: route templates, methods, status classes, and a small enum of error kinds. If you need per-request detail, put it in a trace or a log line keyed by trace id, where the cost is per event rather than per series."
          ],
          "code": "use axum::http::Request;\n\n// BAD: one series per task id and per user, forever.\nfn record_by_path(request: &Request<axum::body::Body>) {\n    metrics::counter!(\"http_requests_total\", \"path\" => request.uri().path().to_owned())\n        .increment(1);\n}\n\n// GOOD: bounded label sets, keyed by the route template.\nfn record_by_route(route: &'static str, status_class: &'static str) {\n    metrics::counter!(\n        \"http_requests_total\",\n        \"route\" => route,\n        \"status\" => status_class,\n    )\n    .increment(1);\n}\n\n// Error kinds stay an enum, never a formatted message.\n#[derive(Clone, Copy)]\nenum ErrorKind {\n    Validation,\n    NotFound,\n    Conflict,\n    Internal,\n}",
          "tip": "Estimate series count before shipping a label: routes times methods times statuses times error kinds. If the product is larger than a few thousand, the label is a bug."
        },
        {
          "h": "One trace id across every hop",
          "p": [
            "W3C trace context puts the identity in a traceparent header: version, 32 hex trace id, 16 hex parent id, and flags. The sampled flag is the last field, so 01 means the caller recorded this trace and you should too.",
            "Validate before trusting it. Reject non-hex ids, wrong lengths, and the all-zero trace id, which the specification forbids. When the header is missing, generate a trace id; when you call downstream, send a new parent id so the child span links to your span rather than to the caller's."
          ],
          "code": "use axum::http::{HeaderMap, HeaderValue};\n\n#[derive(Clone, Debug)]\npub struct TraceContext {\n    pub trace_id: String,\n    pub parent_id: String,\n    pub sampled: bool,\n}\n\npub fn parse_traceparent(headers: &HeaderMap) -> Option<TraceContext> {\n    let raw = headers.get(\"traceparent\")?.to_str().ok()?;\n    let mut parts = raw.split('-');\n    let version = parts.next()?;\n    let trace_id = parts.next()?;\n    let parent_id = parts.next()?;\n    let flags = parts.next()?;\n    if version.len() != 2\n        || trace_id.len() != 32\n        || parent_id.len() != 16\n        || flags.len() != 2\n    {\n        return None;\n    }\n    if !trace_id.bytes().all(|byte| byte.is_ascii_hexdigit())\n        || trace_id.bytes().all(|byte| byte == b'0')\n        || !parent_id.bytes().all(|byte| byte.is_ascii_hexdigit())\n    {\n        return None;\n    }\n    Some(TraceContext {\n        trace_id: trace_id.to_owned(),\n        parent_id: parent_id.to_owned(),\n        sampled: u8::from_str_radix(flags, 16).ok()? & 1 == 1,\n    })\n}\n\npub fn outbound_traceparent(trace_id: &str, span_id: &str) -> HeaderValue {\n    HeaderValue::from_str(&format!(\"00-{trace_id}-{span_id}-01\"))\n        .expect(\"hex ids are valid header values\")\n}",
          "tip": "Echo the trace id on the response, in a header and in the problem+json body's instance field. A user pasting one string into a support ticket saves an hour of log archaeology."
        }
      ],
      "exercise": {
        "prompt": "Bucket status codes into 2xx/3xx/4xx/5xx labels, add an http_errors_total counter for 5xx only, and prove parse_traceparent rejects an all-zero trace id.",
        "starter": "fn status_class(status: axum::http::StatusCode) -> &'static str {\n    // TODO: map the hundreds digit, default to \"5xx\"\n    todo!()\n}\n\nfn parse_traceparent(raw: &str) -> Option<(String, String, bool)> {\n    // TODO: length and hex checks, reject all-zero trace id\n    todo!()\n}\n\n#[test]\nfn zero_trace_id_is_rejected() {\n    // TODO: 00-00000000000000000000000000000000-...-01 must be None\n}",
        "hint": "Check field lengths first, then hex validity, then reject a trace id that is all zeros. The sampled bit is the low bit of the flags byte parsed as hex.",
        "solution": "use axum::http::StatusCode;\n\nfn status_class(status: StatusCode) -> &'static str {\n    match status.as_u16() / 100 {\n        2 => \"2xx\",\n        3 => \"3xx\",\n        4 => \"4xx\",\n        _ => \"5xx\",\n    }\n}\n\nfn parse_traceparent(raw: &str) -> Option<(String, String, bool)> {\n    let mut parts = raw.split('-');\n    let version = parts.next()?;\n    let trace_id = parts.next()?;\n    let parent_id = parts.next()?;\n    let flags = parts.next()?;\n    if version.len() != 2\n        || trace_id.len() != 32\n        || parent_id.len() != 16\n        || flags.len() != 2\n    {\n        return None;\n    }\n    let is_hex = |value: &str| value.bytes().all(|byte| byte.is_ascii_hexdigit());\n    if !is_hex(trace_id) || !is_hex(parent_id) || !is_hex(flags) {\n        return None;\n    }\n    if trace_id.bytes().all(|byte| byte == b'0') {\n        return None;\n    }\n    let sampled = u8::from_str_radix(flags, 16).ok()? & 1 == 1;\n    Some((trace_id.to_owned(), parent_id.to_owned(), sampled))\n}\n\nfn record(response_status: StatusCode, route: &str) {\n    let class = status_class(response_status);\n    metrics::counter!(\"http_requests_total\", \"route\" => route.to_owned(), \"status\" => class)\n        .increment(1);\n    if class == \"5xx\" {\n        metrics::counter!(\"http_errors_total\", \"route\" => route.to_owned()).increment(1);\n    }\n}\n\n#[test]\nfn zero_trace_id_is_rejected() {\n    let raw = \"00-00000000000000000000000000000000-00f067aa0ba902b7-01\";\n    assert!(parse_traceparent(raw).is_none());\n}"
      },
      "questions": [
        {
          "q": "Which label value keeps a request metric series count bounded?",
          "options": [
            "The raw URI including ids",
            "The MatchedPath route template",
            "The user email",
            "The error message"
          ],
          "answer": 1,
          "explain": "The template set is defined by the router. Raw paths, users, and messages grow without bound and turn one metric into millions of series."
        },
        {
          "q": "What does the sampled flag in traceparent indicate?",
          "options": [
            "The request succeeded",
            "The caller recorded this trace and expects you to as well",
            "The trace id is encrypted",
            "The request is a retry"
          ],
          "answer": 1,
          "explain": "The low bit of the flags byte is the sampling decision propagated by the caller. It is a cost decision, not a success or security signal."
        }
      ],
      "quickbytes": [
        "Label on route, method, and status class; record durations in seconds with buckets around your SLO, and keep error kinds as a small enum.",
        "Validate traceparent: 2/32/16/2 hex fields, lower-case hex, reject the all-zero trace id, and read sampling from the low bit of the flags byte.",
        "Put trace ids in logs, responses, and problem+json instance fields so one string connects a support ticket to a trace and a metric spike."
      ],
      "production": [
        "Cap and review label values in CI; a new metric with an unbounded label should fail review, not production.",
        "Propagate traceparent on every outbound call, including database and queue clients where the library supports it.",
        "Alert on error rate and p99 per route, not on aggregate CPU: a single broken route hides behind a healthy average.",
        "Sample at the edge, not in the middle: a trace that starts sampled and loses the flag downstream is unreadable."
      ],
      "crates": [
        "metrics",
        "metrics-exporter-prometheus",
        "tracing",
        "axum"
      ],
      "pitfall": "Labeling a counter with req.uri().path(). One crawl over /tasks/1 through /tasks/500000 creates half a million time series, and the metrics backend runs out of memory during the incident you needed it for.",
      "github": [
        {
          "name": "metrics-rs/metrics",
          "url": "https://github.com/metrics-rs/metrics"
        },
        {
          "name": "open-telemetry/opentelemetry-rust",
          "url": "https://github.com/open-telemetry/opentelemetry-rust"
        }
      ],
      "resources": [
        {
          "title": "metrics crate documentation",
          "url": "https://docs.rs/metrics/latest/metrics/",
          "kind": "docs"
        },
        {
          "title": "metrics-exporter-prometheus",
          "url": "https://docs.rs/metrics-exporter-prometheus/latest/metrics_exporter_prometheus/",
          "kind": "docs"
        },
        {
          "title": "open-telemetry/opentelemetry-rust",
          "url": "https://github.com/open-telemetry/opentelemetry-rust",
          "kind": "repo"
        },
        {
          "title": "Estimation from Partially Sampled Distributed Traces (arXiv)",
          "url": "https://arxiv.org/abs/2107.07703",
          "kind": "paper"
        },
        {
          "title": "Grafana Labs (YouTube)",
          "url": "https://www.youtube.com/@GrafanaLabs",
          "kind": "video"
        }
      ]
    },
    {
      "id": "w15",
      "n": 15,
      "title": "Graceful shutdown for in-flight requests",
      "minutes": 75,
      "level": "industry",
      "goal": "Stop accepting work on SIGTERM, drain in-flight requests, and cut long-lived streams before the orchestrator sends SIGKILL.",
      "sections": [
        {
          "h": "What with_graceful_shutdown actually does",
          "p": [
            "with_graceful_shutdown stops the accept loop when the future resolves and waits for open connections to finish. It does not cancel running handlers, does not wait for tasks you spawned, and does not impose a deadline. Those are your job. Cancellation is cooperative, so every long loop needs a select on the token or a bounded timeout.",
            "Send the shutdown signal from one place: ctrl_c for local runs, SIGTERM for containers, and a CancellationToken that every subsystem observes. A second signal should exit immediately, because an operator asking twice means the drain is stuck. Log the signal you received and the drain start time; that pair explains most deploy-time 502 spikes."
          ],
          "code": "use std::time::Duration;\nuse tokio_util::sync::CancellationToken;\n\nasync fn shutdown_signal(token: CancellationToken) {\n    let ctrl_c = async {\n        tokio::signal::ctrl_c().await.expect(\"ctrl-c handler\");\n    };\n    #[cfg(unix)]\n    let terminate = async {\n        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())\n            .expect(\"sigterm handler\")\n            .recv()\n            .await;\n    };\n    #[cfg(not(unix))]\n    let terminate = std::future::pending::<()>();\n\n    tokio::select! {\n        _ = ctrl_c => {},\n        _ = terminate => {},\n    }\n    token.cancel();\n}\n\n#[tokio::main]\nasync fn main() -> anyhow::Result<()> {\n    let shutdown = CancellationToken::new();\n    let worker = tokio::spawn(worker_loop(shutdown.clone()));\n    let listener = tokio::net::TcpListener::bind(\"0.0.0.0:8080\").await?;\n    let app = app(AppState { shutdown: shutdown.clone() });\n\n    axum::serve(listener, app)\n        .with_graceful_shutdown(shutdown_signal(shutdown.clone()))\n        .await?;\n\n    if tokio::time::timeout(Duration::from_secs(15), worker)\n        .await\n        .is_err()\n    {\n        tracing::warn!(\"worker did not stop within 15s\");\n    }\n    Ok(())\n}",
          "tip": "Bind the listener before building the app only if startup can fail fast; either way, log the bound address so a failed deploy is distinguishable from a slow one."
        },
        {
          "h": "Long-lived connections never finish on their own",
          "p": [
            "SSE, WebSockets, and long polls hold a connection open indefinitely. Graceful shutdown will wait for them forever, the orchestrator will SIGKILL at the end of the grace period, and every one of those clients loses the connection without warning. A load balancer keeps the connection open as long as bytes flow, so keep-alive traffic does not help.",
            "Give each stream a child token and end it deliberately: send a final event telling the client to reconnect, then return. The client reconnects to another pod, and the draining pod actually exits. Track the active stream count and log it at shutdown; a non-zero count after the deadline names the endpoint that ignored the token."
          ],
          "code": "use std::{convert::Infallible, time::Duration};\nuse axum::response::sse::{Event, Sse};\nuse futures_util::Stream;\nuse tokio_stream::wrappers::ReceiverStream;\n\nfn sse_stream(state: AppState) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {\n    let (tx, rx) = tokio::sync::mpsc::channel(16);\n    let token = state.shutdown.child_token();\n    tokio::spawn(async move {\n        let mut tick = tokio::time::interval(Duration::from_secs(15));\n        loop {\n            tokio::select! {\n                _ = token.cancelled() => {\n                    let _ = tx\n                        .send(Ok(Event::default().event(\"shutdown\").data(\"reconnect\")))\n                        .await;\n                    break;\n                }\n                _ = tick.tick() => {\n                    if tx\n                        .send(Ok(Event::default().comment(\"keep-alive\")))\n                        .await\n                        .is_err()\n                    {\n                        break;\n                    }\n                }\n            }\n        }\n    });\n    Sse::new(ReceiverStream::new(rx))\n}",
          "tip": "A WebSocket needs the same treatment: send a close frame with a reason on shutdown instead of dropping the TCP connection. Clients can then distinguish a deploy from a network failure."
        },
        {
          "h": "Drain inside the orchestrator's budget",
          "p": [
            "The deadline chain is what makes shutdown safe: Kubernetes stops routing new traffic when the readiness probe fails, preStop gives in-flight connections time to leave the load balancer, and terminationGracePeriodSeconds must exceed the longest request plus the queue drain. Read all three numbers from one config file and test the inequality in CI.",
            "If terminationGracePeriodSeconds is 30, a 5 second preStop plus a 25 second request timeout consumes the whole budget and leaves nothing for the drain. Either raise the budget or lower the request timeout; they are one number, decided together. A request still running when SIGKILL lands is worse than a rejected one: the client cannot tell whether the write committed."
          ],
          "code": "spec:\n  terminationGracePeriodSeconds: 45\n  containers:\n    - name: api\n      readinessProbe:\n        httpGet:\n          path: /ready\n          port: 8080\n        periodSeconds: 2\n        failureThreshold: 1\n      lifecycle:\n        preStop:\n          exec:\n            # Give the load balancer time to stop sending new connections.\n            command: [\"sleep\", \"5\"]",
          "tip": "Flip /ready to 503 as the first action on SIGTERM and keep it 503 while draining. The probe is the only signal the ingress understands."
        }
      ],
      "exercise": {
        "prompt": "Wire a CancellationToken into AppState, make /ready return 503 once it is cancelled, and start the server with with_graceful_shutdown. Add a test for the readiness flip.",
        "starter": "use axum::{extract::State, http::StatusCode, routing::get, Router};\nuse tokio_util::sync::CancellationToken;\n\n#[derive(Clone)]\nstruct AppState {\n    shutdown: CancellationToken,\n}\n\nasync fn ready(State(state): State<AppState>) -> StatusCode {\n    // TODO: 503 after cancellation, 200 before\n    todo!()\n}\n\nfn app(state: AppState) -> Router {\n    Router::new().route(\"/ready\", get(ready)).with_state(state)\n}",
        "hint": "Use state.shutdown.is_cancelled() for the check. In the test, build the app with a token, assert 200, cancel the token, then assert 503 with oneshot.",
        "solution": "use axum::{\n    body::Body,\n    extract::State,\n    http::{Request, StatusCode},\n    routing::get,\n    Router,\n};\nuse tokio_util::sync::CancellationToken;\nuse tower::ServiceExt;\n\n#[derive(Clone)]\nstruct AppState {\n    shutdown: CancellationToken,\n}\n\nasync fn ready(State(state): State<AppState>) -> StatusCode {\n    if state.shutdown.is_cancelled() {\n        StatusCode::SERVICE_UNAVAILABLE\n    } else {\n        StatusCode::OK\n    }\n}\n\nfn app(state: AppState) -> Router {\n    Router::new().route(\"/ready\", get(ready)).with_state(state)\n}\n\n#[tokio::test]\nasync fn readiness_flips_after_cancellation() {\n    let shutdown = CancellationToken::new();\n    let app = app(AppState { shutdown: shutdown.clone() });\n\n    let response = app\n        .clone()\n        .oneshot(Request::builder().uri(\"/ready\").body(Body::empty()).unwrap())\n        .await\n        .unwrap();\n    assert_eq!(response.status(), StatusCode::OK);\n\n    shutdown.cancel();\n    let response = app\n        .oneshot(Request::builder().uri(\"/ready\").body(Body::empty()).unwrap())\n        .await\n        .unwrap();\n    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);\n}"
      },
      "questions": [
        {
          "q": "What does axum's with_graceful_shutdown wait for?",
          "options": [
            "All spawned tasks in the process",
            "Open connections to finish after the accept loop stops",
            "The database pool to close",
            "The next scrape interval"
          ],
          "answer": 1,
          "explain": "It stops accepting and waits on open connections. It does not track tokio::spawn tasks, cancel handlers, or enforce a deadline."
        },
        {
          "q": "Why must SSE handlers observe the shutdown token?",
          "options": [
            "Otherwise the stream sends invalid events",
            "They never complete on their own, so the drain waits forever",
            "Because SSE forbids keep-alives",
            "Because the client closes first"
          ],
          "answer": 1,
          "explain": "A never-ending response keeps its connection open, so graceful shutdown blocks until the orchestrator kills the process."
        }
      ],
      "quickbytes": [
        "Handle ctrl_c and SIGTERM in one future, cancel a CancellationToken, and pass child tokens to workers and streams.",
        "SSE and WebSocket handlers must end on cancellation with a final event or close frame; otherwise the drain hangs until SIGKILL.",
        "Keep terminationGracePeriodSeconds above request timeout plus drain time, and flip readiness to 503 before draining."
      ],
      "production": [
        "Test shutdown in CI by sending SIGTERM while a slow request is in flight and asserting it completes.",
        "Log the drain duration per deploy; a rising number means a stream or worker is not observing the token.",
        "Never start new background work after cancellation; guard the queue consumer with the same token.",
        "Make the second signal a hard exit, and document that behaviour for on-call."
      ],
      "crates": [
        "axum",
        "tokio",
        "tokio-util",
        "tokio-stream"
      ],
      "pitfall": "Relying on graceful shutdown while an SSE feed never ends. The pod ignores SIGTERM for the full grace period, then every live client is disconnected at once when the process is killed.",
      "github": [
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        },
        {
          "name": "tokio-rs/tokio",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "resources": [
        {
          "title": "axum Serve and graceful shutdown",
          "url": "https://docs.rs/axum/0.8.9/axum/serve/struct.Serve.html",
          "kind": "docs"
        },
        {
          "title": "tokio Unix signal handling",
          "url": "https://docs.rs/tokio/1.54.1/tokio/signal/unix/fn.signal.html",
          "kind": "docs"
        },
        {
          "title": "axum graceful-shutdown example",
          "url": "https://github.com/tokio-rs/axum/tree/main/examples/graceful-shutdown",
          "kind": "repo"
        },
        {
          "title": "tokio-util CancellationToken",
          "url": "https://docs.rs/tokio-util/latest/tokio_util/sync/struct.CancellationToken.html",
          "kind": "docs"
        },
        {
          "title": "Jon Gjengset - Rust deep dives (YouTube)",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ]
    },
    {
      "id": "w16",
      "n": 16,
      "title": "Deprecation and Sunset headers on a live API",
      "minutes": 65,
      "level": "advanced",
      "goal": "Announce and enforce an endpoint sunset with machine-readable headers, telemetry on remaining callers, and a hard 410 on the day it lands.",
      "sections": [
        {
          "h": "Three headers, three different jobs",
          "p": [
            "Deprecation marks the start of the warning period and carries a structured-field date: an @ followed by Unix seconds. Sunset carries an HTTP-date for the moment the endpoint stops working. Link with rel=deprecation points at the human explanation. Both are response headers, so they travel with the payload instead of living in a document a client may never read.",
            "Send both on every response from the deprecated route, including 4xx and 5xx. A client that only sees the header on the happy path will not discover the deadline while it is debugging failures, and the deadline is exactly when it matters. Clients that cannot parse the header still see it in logs and can alert on the route."
          ],
          "code": "use std::time::{Duration, SystemTime, UNIX_EPOCH};\nuse axum::{\n    extract::Request,\n    http::{HeaderName, HeaderValue},\n    middleware::Next,\n    response::Response,\n};\n\npub async fn deprecated(req: Request, next: Next) -> Response {\n    let now = SystemTime::now()\n        .duration_since(UNIX_EPOCH)\n        .expect(\"clock after 1970\")\n        .as_secs();\n    let sunset = SystemTime::now() + Duration::from_secs(90 * 24 * 3600);\n\n    let mut response = next.run(req).await;\n    let headers = response.headers_mut();\n    headers.insert(\n        HeaderName::from_static(\"deprecation\"),\n        HeaderValue::from_str(&format!(\"@{now}\")).expect(\"digits\"),\n    );\n    headers.insert(\n        HeaderName::from_static(\"sunset\"),\n        HeaderValue::from_str(&httpdate::fmt_http_date(sunset)).expect(\"http date\"),\n    );\n    headers.insert(\n        HeaderName::from_static(\"link\"),\n        HeaderValue::from_static(\n            \"</docs/deprecations>; rel=\\\"deprecation\\\"; type=\\\"text/html\\\"\",\n        ),\n    );\n    response\n}",
          "tip": "Deprecation takes @seconds, Sunset takes a date string. Swapping them produces headers that parse as nothing and clients that ignore the warning entirely."
        },
        {
          "h": "A timeline with teeth",
          "p": [
            "Announce at T-90 with headers, a changelog entry, and a direct message to the top callers by traffic. At T-30 run a brownout: return 410 for a short, announced window each day so integrations that swallow logs fail in a test window instead of at the deadline.",
            "At T-0 remove the handler. Keep the path returning 410 with a problem+json body that names the replacement for at least a year. A 404 looks transient to retry middleware and to SDKs, so the old path keeps generating traffic and support tickets."
          ],
          "code": "use axum::{\n    http::{header, StatusCode},\n    response::IntoResponse,\n    Json,\n};\n\nasync fn retired() -> impl IntoResponse {\n    (\n        StatusCode::GONE,\n        [(header::CONTENT_TYPE, \"application/problem+json\")],\n        Json(serde_json::json!({\n            \"type\": \"https://api.example.com/problems/endpoint-retired\",\n            \"title\": \"Endpoint retired\",\n            \"status\": 410,\n            \"detail\": \"Use /v2/tasks. This endpoint was retired on 2026-03-01.\",\n            \"see\": \"https://api.example.com/docs/deprecations\"\n        })),\n    )\n}",
          "tip": "Put the replacement URL in the body and in a Link header with rel=successor-version. Clients that only log headers still get a pointer they can automate against."
        },
        {
          "h": "Remove the code, keep the path reserved",
          "p": [
            "Deleting the route and releasing the URL for reuse is how a retired endpoint silently becomes a different resource. Reserve the path, keep the 410 handler tiny, and delete the implementation in the same release that stops writing to the old tables.",
            "Track callers by API key and by client version before the deadline, not after. A dashboard that shows zero traffic on v1 is the only evidence that removal is safe; a spike in 410s afterwards is a migration you did not finish."
          ],
          "code": "use axum::{\n    routing::{any, get},\n    Router,\n};\n\nfn app(state: AppState) -> Router {\n    let retired_routes = Router::new()\n        .route(\"/tasks\", any(retired))\n        .route(\"/tasks/{id}\", any(retired))\n        .fallback(retired);\n\n    Router::new()\n        .nest(\"/v1\", retired_routes)\n        .nest(\"/v2\", tasks_v2())\n        .route(\"/ready\", get(|| async { \"ok\" }))\n        .with_state(state)\n}",
          "tip": "Block writes first, then reads. A write against a retired endpoint creates data the replacement cannot see, which is worse than a read failure."
        }
      ],
      "exercise": {
        "prompt": "Apply the deprecation middleware to a v1 subtree with one live route and one retired route, then test that both the 200 and the 410 carry Deprecation and Sunset.",
        "starter": "use axum::{routing::get, Router};\n\nasync fn list_tasks() -> &'static str {\n    \"[]\"\n}\n\nasync fn retired() -> axum::http::StatusCode {\n    axum::http::StatusCode::GONE\n}\n\nfn app() -> Router {\n    // TODO: build the v1 router with /tasks and /exports\n    // TODO: apply middleware::from_fn(deprecated) to v1 only\n    // TODO: /v2/tasks stays undecorated\n    Router::new()\n}",
        "hint": "Router::layer applies only to routes already added, so build the v1 router, add the layer, then nest it into the parent. Assert both headers on the 200 and on the 410 with oneshot.",
        "solution": "use axum::{\n    body::Body,\n    http::{HeaderName, Request, StatusCode},\n    middleware,\n    routing::get,\n    Router,\n};\nuse tower::ServiceExt;\n\nasync fn list_tasks() -> &'static str {\n    \"[]\"\n}\n\nasync fn retired() -> StatusCode {\n    StatusCode::GONE\n}\n\nasync fn deprecated(\n    request: Request,\n    next: middleware::Next,\n) -> axum::response::Response {\n    let mut response = next.run(request).await;\n    response.headers_mut().insert(\n        HeaderName::from_static(\"deprecation\"),\n        \"@1735689600\".parse().expect(\"structured field date\"),\n    );\n    response.headers_mut().insert(\n        HeaderName::from_static(\"sunset\"),\n        \"Thu, 01 Jan 2026 00:00:00 GMT\".parse().expect(\"http date\"),\n    );\n    response\n}\n\nfn app() -> Router {\n    let v1 = Router::new()\n        .route(\"/tasks\", get(list_tasks))\n        .route(\"/exports\", get(retired))\n        .layer(middleware::from_fn(deprecated));\n\n    Router::new().nest(\"/v1\", v1).route(\"/v2/tasks\", get(list_tasks))\n}\n\n#[tokio::test]\nasync fn both_v1_responses_carry_the_headers() {\n    for uri in [\"/v1/tasks\", \"/v1/exports\"] {\n        let response = app()\n            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())\n            .await\n            .unwrap();\n        assert!(response\n            .headers()\n            .contains_key(HeaderName::from_static(\"deprecation\")));\n        assert!(response\n            .headers()\n            .contains_key(HeaderName::from_static(\"sunset\")));\n    }\n}"
      },
      "questions": [
        {
          "q": "What value format does the Deprecation header use?",
          "options": [
            "An HTTP-date",
            "An @ followed by Unix seconds",
            "An ISO 8601 timestamp with a Z suffix",
            "A version number"
          ],
          "answer": 1,
          "explain": "Deprecation uses a structured-field date: @1688169599. Sunset uses an HTTP-date, which is why the two look different on purpose."
        },
        {
          "q": "Why return 410 instead of 404 for a retired endpoint?",
          "options": [
            "410 is cacheable and 404 is not",
            "410 states the resource is permanently gone, so retries and SDKs stop treating it as transient",
            "404 leaks the route table",
            "410 disables authentication"
          ],
          "answer": 1,
          "explain": "404 is ambiguous: the id may exist later. 410 is permanent and explicit, and it is the status clients and gateways treat as a migration signal."
        }
      ],
      "quickbytes": [
        "Deprecation: @<unix seconds>, Sunset: <HTTP-date>, and Link: <docs>; rel=\"deprecation\" on every response from the old route, errors included.",
        "Run a brownout before the sunset date so integrations fail in an announced window rather than at the deadline.",
        "Return 410 problem+json with the replacement URL after removal, and reserve the path so it can never become a different resource."
      ],
      "production": [
        "Track calls per API key and client version on the deprecated route, and publish the countdown.",
        "Keep the 410 handler after the implementation is deleted; removing the route turns a clear signal into a 404.",
        "Put deadline dates in code and tests so a release cannot silently move the sunset.",
        "Never reuse a retired path for a new resource; old clients will call it with the old shape."
      ],
      "crates": [
        "axum",
        "tower-http",
        "httpdate",
        "serde_json"
      ],
      "pitfall": "Announcing the sunset only in a changelog and docs. Machine clients never read either, traffic does not move, and the deadline slips because nobody can prove who still calls the endpoint.",
      "github": [
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        },
        {
          "name": "tower-rs/tower-http",
          "url": "https://github.com/tower-rs/tower-http"
        }
      ],
      "resources": [
        {
          "title": "MDN: HTTP headers reference",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers",
          "kind": "docs"
        },
        {
          "title": "http crate header constants",
          "url": "https://docs.rs/http/latest/http/header/index.html",
          "kind": "docs"
        },
        {
          "title": "A First Look at the Deprecation of RESTful APIs (arXiv)",
          "url": "https://arxiv.org/abs/2008.12808",
          "kind": "paper"
        },
        {
          "title": "tower-rs/tower-http repository",
          "url": "https://github.com/tower-rs/tower-http",
          "kind": "repo"
        },
        {
          "title": "RustVideos - Rust conference talks (YouTube)",
          "url": "https://www.youtube.com/@RustVideos",
          "kind": "video"
        }
      ]
    },
    {
      "id": "w17",
      "n": 17,
      "title": "Security headers and CSP for API surfaces",
      "minutes": 70,
      "level": "industry",
      "goal": "Set a deny-by-default CSP where browsers execute anything, isolation headers everywhere else, and roll it out in report-only first.",
      "sections": [
        {
          "h": "JSON is not HTML, but headers still apply",
          "p": [
            "APIs mostly return JSON, so a document-level policy seems irrelevant until someone opens an endpoint in a browser tab, an error page renders as HTML, or a mislabelled body is sniffed as markup. nosniff, frame-ancestors, and a restrictive default-src close those paths cheaply.",
            "HSTS is different: it is a promise that this host will never speak plain HTTP again, and preload puts that promise in browsers. Send it only on TLS you control, and includeSubDomains only when every subdomain is ready, because the header cannot be recalled quickly."
          ],
          "code": "use axum::{\n    http::{header, HeaderName, HeaderValue},\n    Router,\n};\nuse tower_http::set_header::SetResponseHeaderLayer;\n\nfn harden(app: Router) -> Router {\n    app.layer(SetResponseHeaderLayer::overriding(\n        header::STRICT_TRANSPORT_SECURITY,\n        HeaderValue::from_static(\"max-age=63072000; includeSubDomains\"),\n    ))\n    .layer(SetResponseHeaderLayer::overriding(\n        HeaderName::from_static(\"cross-origin-resource-policy\"),\n        HeaderValue::from_static(\"same-origin\"),\n    ))\n    .layer(SetResponseHeaderLayer::overriding(\n        header::CONTENT_SECURITY_POLICY,\n        HeaderValue::from_static(\"default-src 'none'; frame-ancestors 'none'; base-uri 'none'\"),\n    ))\n}",
          "tip": "Apply these in one layer on the composed router. Headers set inside handlers are missing exactly on the 404 and 500 responses that scanners and attackers probe first."
        },
        {
          "h": "The docs UI is the real browser surface",
          "p": [
            "Swagger UI and Scalar need script, style, and often an inline bootstrap object. A policy of default-src 'none' breaks them, and the usual fix, adding 'unsafe-inline', hands the page to any injected string. Serve docs from a separate origin with no cookies, or give them a nonce.",
            "A nonce is generated per response, put in the header and in the script tag. When a nonce or hash is present, browsers ignore 'unsafe-inline', so keeping it in the policy buys nothing and hides the fact that injection is still blocked."
          ],
          "code": "use axum::{\n    extract::Request,\n    http::{HeaderName, HeaderValue},\n    middleware::Next,\n    response::Response,\n};\n\n#[derive(Clone)]\npub struct Nonce(pub String);\n\npub async fn csp_with_nonce(mut request: Request, next: Next) -> Response {\n    let nonce = uuid::Uuid::new_v4().simple().to_string();\n    let policy = format!(\n        \"default-src 'self'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'\"\n    );\n\n    request.extensions_mut().insert(Nonce(nonce));\n    let mut response = next.run(request).await;\n    response.headers_mut().insert(\n        HeaderName::from_static(\"content-security-policy\"),\n        HeaderValue::from_str(&policy).expect(\"ascii policy\"),\n    );\n    response\n}",
          "tip": "Templating engines escape the nonce attribute like any other string. If the nonce is generated inside the HTML renderer instead of the middleware, the header and the tag can disagree and the page silently blocks its own script."
        },
        {
          "h": "Report before you enforce",
          "p": [
            "Content-Security-Policy-Report-Only sends violation reports without blocking, which is the only sane way to learn what a third-party widget or an SDK actually loads. Start with the directives that break the least: object-src, base-uri, and frame-ancestors before script-src. Reporting-Endpoints names the collector, and report-to references that name; report-uri remains for older browsers.",
            "Treat the collector as an untrusted public endpoint: cap the body, rate-limit it, and never echo its contents into logs unescaped. Then enforce, keeping the report-only policy around to catch the next integration that quietly adds a script. Keep that report-only policy in production for a quarter after enforcement; it is your regression detector."
          ],
          "code": "use axum::{\n    http::{HeaderName, HeaderValue},\n    routing::post,\n    Router,\n};\nuse tower_http::set_header::SetResponseHeaderLayer;\n\nfn app() -> Router {\n    Router::new()\n        .route(\"/csp-report\", post(collect_report))\n        .layer(SetResponseHeaderLayer::overriding(\n            HeaderName::from_static(\"content-security-policy-report-only\"),\n            HeaderValue::from_static(\n                \"default-src 'self'; script-src 'self'; report-to csp; report-uri /csp-report\",\n            ),\n        ))\n        .layer(SetResponseHeaderLayer::overriding(\n            HeaderName::from_static(\"reporting-endpoints\"),\n            HeaderValue::from_static(\"csp=\\\"/csp-report\\\"\"),\n        ))\n}",
          "tip": "CSP reports arrive as POSTs with a JSON body and no auth. A loop that logs every field verbatim is a log-injection and disk-fill vector; store a sampled count by directive instead."
        }
      ],
      "exercise": {
        "prompt": "Add a report-only CSP plus Cross-Origin-Resource-Policy: same-origin to a router, and test that both headers appear on a 404 response as well as a 200.",
        "starter": "use axum::{routing::get, Router};\n\nfn app() -> Router {\n    // TODO: add both headers with SetResponseHeaderLayer\n    Router::new().route(\"/ok\", get(|| async { \"ok\" }))\n}\n\n// TODO: #[tokio::test] assert both headers on /ok and /missing",
        "hint": "Layer on the composed router so the fallback 404 is covered. Read the headers with response.headers().get(HeaderName::from_static(\"content-security-policy-report-only\")).",
        "solution": "use axum::{\n    body::Body,\n    http::{HeaderName, Request, StatusCode},\n    routing::get,\n    Router,\n};\nuse tower::ServiceExt;\nuse tower_http::set_header::SetResponseHeaderLayer;\n\nfn app() -> Router {\n    Router::new().route(\"/ok\", get(|| async { \"ok\" })).layer(\n        tower::ServiceBuilder::new()\n            .layer(SetResponseHeaderLayer::overriding(\n                HeaderName::from_static(\"cross-origin-resource-policy\"),\n                \"same-origin\".parse().expect(\"valid header\"),\n            ))\n            .layer(SetResponseHeaderLayer::overriding(\n                HeaderName::from_static(\"content-security-policy-report-only\"),\n                \"default-src 'none'; frame-ancestors 'none'\"\n                    .parse()\n                    .expect(\"valid header\"),\n            )),\n    )\n}\n\n#[tokio::test]\nasync fn headers_survive_a_404() {\n    for uri in [\"/ok\", \"/missing\"] {\n        let response = app()\n            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())\n            .await\n            .unwrap();\n        assert_eq!(\n            response.status() == StatusCode::OK,\n            uri == \"/ok\",\n            \"unexpected status for {uri}\"\n        );\n        assert!(response\n            .headers()\n            .contains_key(HeaderName::from_static(\"cross-origin-resource-policy\")));\n        assert!(response\n            .headers()\n            .contains_key(HeaderName::from_static(\"content-security-policy-report-only\")));\n    }\n}"
      },
      "questions": [
        {
          "q": "When is includeSubDomains on HSTS a mistake?",
          "options": [
            "When the API returns JSON",
            "When some subdomains still serve plain HTTP",
            "When the certificate is RSA",
            "When the response is cached"
          ],
          "answer": 1,
          "explain": "The directive forces HTTPS for every subdomain. One internal host without TLS becomes unreachable, and browsers cache the policy for max-age."
        },
        {
          "q": "What happens to 'unsafe-inline' when a nonce is present?",
          "options": [
            "It takes precedence",
            "Browsers ignore it, so the nonce controls execution",
            "It disables the nonce",
            "It only affects styles"
          ],
          "answer": 1,
          "explain": "CSP3 ignores 'unsafe-inline' when a nonce or hash is present. Adding it to silence errors is ineffective and hides that scripts are still blocked."
        }
      ],
      "quickbytes": [
        "Put security headers in one layer on the composed router, then assert them on a 404 and a 500, not only on a 200.",
        "Docs UIs get their own origin and a nonce-based policy; JSON endpoints get default-src 'none'; frame-ancestors 'none'.",
        "Ship Content-Security-Policy-Report-Only with Reporting-Endpoints first, and treat the collector as a public, rate-limited, untrusted endpoint."
      ],
      "production": [
        "Never send HSTS preload until every subdomain is HTTPS-only; the removal takes months.",
        "Keep a test per security header so a refactor cannot drop one silently.",
        "Cap and rate-limit the CSP report collector; it is unauthenticated by design.",
        "Review CSP violations weekly during rollout; a directive that never fires may be wrong, not just clean."
      ],
      "crates": [
        "tower-http",
        "axum",
        "http",
        "uuid"
      ],
      "pitfall": "Making the docs UI work by adding 'unsafe-inline' and a wildcard source to the policy. The scanner sees a CSP header and goes green, while the policy permits exactly the injection it was supposed to stop.",
      "github": [
        {
          "name": "w3c/webappsec-csp",
          "url": "https://github.com/w3c/webappsec-csp"
        },
        {
          "name": "tower-rs/tower-http",
          "url": "https://github.com/tower-rs/tower-http"
        }
      ],
      "resources": [
        {
          "title": "MDN: Content-Security-Policy",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy",
          "kind": "docs"
        },
        {
          "title": "MDN: CSP frame-ancestors",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors",
          "kind": "docs"
        },
        {
          "title": "MDN: Cross-Origin-Resource-Policy",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Resource-Policy",
          "kind": "docs"
        },
        {
          "title": "w3c/webappsec-csp specification",
          "url": "https://github.com/w3c/webappsec-csp",
          "kind": "repo"
        },
        {
          "title": "RustVideos - Rust conference talks (YouTube)",
          "url": "https://www.youtube.com/@RustVideos",
          "kind": "video"
        }
      ]
    },
    {
      "id": "w18",
      "n": 18,
      "title": "Contract tests and open-model load tests",
      "minutes": 95,
      "level": "industry",
      "goal": "Freeze the wire contract with schema assertions and snapshots, then run an arrival-rate load test with budgets that fail CI.",
      "sections": [
        {
          "h": "Assert the published schema, not a copied string",
          "p": [
            "A contract test checks what clients actually depend on: status codes, field names, types, and required members. The OpenAPI document you generate already encodes that, so validate real responses against the response schema instead of maintaining a second set of assertions by hand.",
            "Read the schema out of the document at test time, so a route that vanishes from the specification fails the test. Additive fields pass, which is the point of additive versioning; a rename, a removal, or a type change fails before a client discovers it."
          ],
          "code": "use serde_json::Value;\n\nfn response_schema(document: &Value, path: &str, method: &str, status: &str) -> Value {\n    document[\"paths\"][path][method][\"responses\"][status][\"content\"]\n        [\"application/json\"][\"schema\"]\n        .clone()\n}\n\n#[tokio::test]\nasync fn get_task_matches_the_published_contract() {\n    let document: Value =\n        serde_json::from_str(include_str!(\"../openapi.json\")).expect(\"openapi.json\");\n    let schema = response_schema(&document, \"/tasks/{id}\", \"get\", \"200\");\n    assert!(!schema.is_null(), \"response schema missing from the document\");\n\n    let body = get_json(\"/api/v1/tasks/1\").await;\n    jsonschema::validate(&schema, &body).expect(\"response violates the contract\");\n}",
          "tip": "Generate openapi.json in CI, commit it, and diff it against main. A schema change then shows up as a reviewable artifact instead of a runtime surprise."
        },
        {
          "h": "Snapshots catch what schemas allow",
          "p": [
            "A schema that only types a field as string cannot catch a default flipping from null to empty, a timestamp changing format, or an enum gaining a value. A JSON snapshot records the whole body and fails on any change, intended or not.",
            "Redact ids, timestamps, and personal data, or the snapshot fails on every run and gets deleted within a week. Treat a failing snapshot as a question: did the contract change on purpose, and who agreed to it? A snapshot nobody reviews is a rubber stamp, so keep the object small and the redactions obvious."
          ],
          "code": "#[tokio::test]\nasync fn task_shape_is_stable() {\n    let body = get_json(\"/api/v1/tasks/1\").await;\n    insta::assert_json_snapshot!(body, {\n        \".id\" => \"[id]\",\n        \".createdAt\" => \"[timestamp]\",\n        \".owner.email\" => \"[email]\",\n    });\n}\n\n// cargo insta review   -> accept or reject the diff\n// the .snap file is committed next to the test",
          "tip": "Snapshot one representative object, not a list of twenty. A large snapshot nobody reviews is a big red diff that people approve without reading."
        },
        {
          "h": "Load tests need an open model and a budget",
          "p": [
            "A closed-model test with a fixed number of virtual users applies backpressure: when the server slows down, clients wait and send less, so the reported latency looks fine while real users queue. An arrival-rate model keeps the pressure constant and exposes the queue.",
            "Thresholds are the assertion. Set p99, error rate, and a floor on successful checks, run against staging with production-shaped data, and compare against the previous commit. A load test without a threshold is a graph nobody looks at after the first week."
          ],
          "code": "import http from \"k6/http\";\nimport { check } from \"k6\";\n\nexport const options = {\n  scenarios: {\n    browse: {\n      executor: \"constant-arrival-rate\",\n      rate: 200,\n      timeUnit: \"1s\",\n      duration: \"5m\",\n      preAllocatedVUs: 50,\n      maxVUs: 400,\n    },\n  },\n  thresholds: {\n    http_req_failed: [\"rate<0.001\"],\n    http_req_duration: [\"p(99)<300\"],\n    checks: [\"rate>0.99\"],\n  },\n};\n\nexport default function () {\n  const response = http.get(__ENV.BASE_URL + \"/api/v1/tasks?limit=20\");\n  check(response, { \"status is 200\": (r) => r.status === 200 });\n}",
          "tip": "Warm up for at least a minute before the measured window. Connection pools, JIT, and caches make the first thirty seconds of any load test a different system."
        }
      ],
      "exercise": {
        "prompt": "Write a contract test that validates a 422 problem+json body against the error schema and asserts invalid-params is an array of objects with name and reason.",
        "starter": "use serde_json::Value;\n\nfn error_schema(document: &Value) -> Value {\n    // TODO: read components.schemas.Problem from the OpenAPI document\n    todo!()\n}\n\n#[tokio::test]\nasync fn validation_errors_match_the_contract() {\n    // TODO: request /api/v1/tasks with an invalid body, validate the 422 body\n}",
        "hint": "Use jsonschema::validate(&schema, &body) and assert body[\"invalid-params\"][0][\"name\"] is a string. A 422 without the extension member is a contract failure even when the status is right.",
        "solution": "use serde_json::Value;\n\nfn error_schema(document: &Value) -> Value {\n    document[\"components\"][\"schemas\"][\"Problem\"].clone()\n}\n\nfn app_body() -> Value {\n    serde_json::json!({\n        \"type\": \"https://api.example.com/problems/invalid-request\",\n        \"title\": \"Request validation failed\",\n        \"status\": 422,\n        \"detail\": \"one or more fields are invalid\",\n        \"invalid-params\": [\n            { \"name\": \"title\", \"reason\": \"length must be between 1 and 200\" },\n            { \"name\": \"priority\", \"reason\": \"must be between 0 and 5\" }\n        ]\n    })\n}\n\n#[test]\nfn validation_errors_match_the_contract() {\n    let document = serde_json::json!({\n        \"components\": {\n            \"schemas\": {\n                \"Problem\": {\n                    \"type\": \"object\",\n                    \"required\": [\"type\", \"title\", \"status\", \"detail\", \"invalid-params\"],\n                    \"properties\": {\n                        \"type\": { \"type\": \"string\" },\n                        \"title\": { \"type\": \"string\" },\n                        \"status\": { \"type\": \"integer\" },\n                        \"detail\": { \"type\": \"string\" },\n                        \"invalid-params\": {\n                            \"type\": \"array\",\n                            \"items\": {\n                                \"type\": \"object\",\n                                \"required\": [\"name\", \"reason\"],\n                                \"properties\": {\n                                    \"name\": { \"type\": \"string\" },\n                                    \"reason\": { \"type\": \"string\" }\n                                }\n                            }\n                        }\n                    }\n                }\n            }\n        }\n    });\n\n    let body = app_body();\n    let schema = error_schema(&document);\n    jsonschema::validate(&schema, &body).expect(\"problem+json does not match the contract\");\n\n    let params = body[\"invalid-params\"].as_array().expect(\"array\");\n    assert_eq!(params.len(), 2);\n    assert!(params.iter().all(|param| param[\"name\"].is_string()));\n}"
      },
      "questions": [
        {
          "q": "Why is a closed-model load test misleading?",
          "options": [
            "It cannot measure status codes",
            "Clients slow down when the server slows, hiding queueing",
            "It requires a production database",
            "It only measures uploads"
          ],
          "answer": 1,
          "explain": "With a fixed user count and think time, a slow server reduces offered load. An arrival-rate model keeps sending at the target rate and exposes the queue."
        },
        {
          "q": "What does an OpenAPI schema assertion catch that a status-code assertion misses?",
          "options": [
            "Server panics",
            "Renamed or removed fields and type changes clients depend on",
            "Slow queries",
            "TLS misconfiguration"
          ],
          "answer": 1,
          "explain": "The status can be 200 while the body is wrong. Validating against the published schema checks names, types, and required members."
        }
      ],
      "quickbytes": [
        "Validate real responses against the OpenAPI response schema with jsonschema::validate, reading the schema from the committed document.",
        "Snapshot a representative body with ids and timestamps redacted, and commit the .snap files next to the test.",
        "Load-test with constant-arrival-rate and thresholds (p99, error rate, checks), then compare the run against the previous commit."
      ],
      "production": [
        "Run the contract suite on every PR that touches a handler, a DTO, or the OpenAPI document.",
        "Fail the build when the generated document loses a path or a required property, not when it gains one.",
        "Keep load tests out of the unit-test job; run them against staging on a schedule and before releases.",
        "Record the commit in the load-test report so a regression has an owner."
      ],
      "crates": [
        "jsonschema",
        "insta",
        "serde_json",
        "tokio"
      ],
      "pitfall": "Load-testing with ten virtual users and a one-second think time, then publishing p99 from that run. The client paced itself, the server never queued, and the numbers are a property of the test, not the service.",
      "github": [
        {
          "name": "Stranger6667/jsonschema",
          "url": "https://github.com/Stranger6667/jsonschema"
        },
        {
          "name": "mitsuhiko/insta",
          "url": "https://github.com/mitsuhiko/insta"
        }
      ],
      "resources": [
        {
          "title": "jsonschema crate documentation",
          "url": "https://docs.rs/jsonschema/latest/jsonschema/",
          "kind": "docs"
        },
        {
          "title": "insta snapshot testing",
          "url": "https://docs.rs/insta/latest/insta/",
          "kind": "docs"
        },
        {
          "title": "grafana/k6 load testing",
          "url": "https://github.com/grafana/k6",
          "kind": "repo"
        },
        {
          "title": "PonyTail: Profiling and Improving Service Tail Latency (arXiv)",
          "url": "https://arxiv.org/abs/2610.04615",
          "kind": "paper"
        },
        {
          "title": "hatoo/oha HTTP load generator",
          "url": "https://github.com/hatoo/oha",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "w19",
      "n": 19,
      "title": "X-Forwarded-* and trusted proxy boundaries",
      "minutes": 75,
      "level": "industry",
      "goal": "Derive the real client address from proxy headers only when the hop is trusted, and take the rightmost untrusted entry instead of the leftmost.",
      "sections": [
        {
          "h": "Every proxy appends, so position is trust",
          "p": [
            "X-Forwarded-For is a comma-separated chain that each proxy appends to. The leftmost entry is whatever the client claimed; the rightmost is the address the proxy nearest to you actually saw. If your edge appends instead of overwriting, the left side of the header is attacker-controlled.",
            "Forwarded is the RFC 7239 alternative with for=, proto=, and by= parameters, including quoted IPv6 addresses. X-Real-IP and CF-Connecting-IP are single-value vendor variants. The socket peer address is the only value that did not travel through the network as a header."
          ],
          "code": "Client 203.0.113.9 -> CDN 198.51.100.7 -> nginx 10.0.0.5 -> app\n\nX-Forwarded-For: 203.0.113.9, 198.51.100.7\nX-Forwarded-Proto: https\nX-Real-IP: 203.0.113.9\n\nPeer address seen by the app: 10.0.0.5\nTrusted CIDRs: 10.0.0.0/8, 198.51.100.0/24\nDerived client: 203.0.113.9\n\nSame request with a client-supplied prefix:\nX-Forwarded-For: 1.2.3.4, 203.0.113.9, 198.51.100.7\nDerived client: 203.0.113.9\n1.2.3.4 is never reached because the walk starts at the right.",
          "tip": "Log the peer address and the derived client address separately. When they disagree in a way the trust list cannot explain, either a proxy changed or someone is probing your header handling."
        },
        {
          "h": "Walk right to left, skipping trusted hops",
          "p": [
            "The algorithm is short: if the socket peer is not in a trusted CIDR, ignore every forwarded header and use the peer. Otherwise walk the chain from the right, skip addresses inside trusted ranges, and return the first untrusted one.",
            "Walking from the right is what makes a client-supplied prefix harmless. The client can prepend any address it likes, and the loop still stops at the first hop your infrastructure did not add. Trust the list, not the length: a chain of ten trusted proxies still resolves to the peer when no untrusted hop exists."
          ],
          "code": "use std::net::{IpAddr, SocketAddr};\nuse ipnet::IpNet;\n\npub fn client_ip(peer: SocketAddr, forwarded_for: Option<&str>, trusted: &[IpNet]) -> IpAddr {\n    let is_trusted = |ip: &IpAddr| trusted.iter().any(|net| net.contains(ip));\n\n    if !is_trusted(&peer.ip()) {\n        return peer.ip();\n    }\n    let Some(header) = forwarded_for else {\n        return peer.ip();\n    };\n\n    let mut hops: Vec<IpAddr> = header\n        .split(',')\n        .filter_map(|part| part.trim().parse().ok())\n        .collect();\n    hops.push(peer.ip());\n\n    for hop in hops.iter().rev() {\n        if !is_trusted(hop) {\n            return *hop;\n        }\n    }\n    peer.ip()\n}",
          "tip": "Parsing with .ok() and filtering silently drops invalid entries. Count the drops and log them: a malformed entry in the chain is either a broken proxy or an injection attempt."
        },
        {
          "h": "Proto and host are also claims",
          "p": [
            "X-Forwarded-Proto drives redirects and the Secure flag on cookies; X-Forwarded-Host drives absolute URLs in responses and emails. A spoofed proto can downgrade a redirect to http, and a spoofed host turns a password-reset link into a phishing link. If the edge overwrites both headers the derived values are safe; if it forwards them they are requests, not facts.",
            "axum-client-ip 1.x dropped leftmost extraction and exposes one extractor per source, mounted as an extension. Pick the source that matches your edge, and remember ConnectInfo only works when the server is built with into_make_service_with_connect_info. The crate's release notes record that the leftmost variants were removed after a rightmost-extraction bug, which is a good reason to be on 1.x."
          ],
          "code": "use axum::{routing::get, Router};\nuse axum_client_ip::{ClientIp, ClientIpSource};\nuse std::net::SocketAddr;\n\nasync fn me(ClientIp(ip): ClientIp) -> String {\n    ip.to_string()\n}\n\nfn app() -> Router {\n    Router::new()\n        .route(\"/me\", get(me))\n        .layer(ClientIpSource::RightmostXForwardedFor.into_extension())\n}\n\n#[tokio::main]\nasync fn main() {\n    let listener = tokio::net::TcpListener::bind(\"0.0.0.0:8080\")\n        .await\n        .expect(\"bind 8080\");\n    axum::serve(\n        listener,\n        app().into_make_service_with_connect_info::<SocketAddr>(),\n    )\n    .await\n    .expect(\"serve\");\n}",
          "tip": "Build absolute URLs from configured public base URLs, never from X-Forwarded-Host. The header is input; the base URL is configuration."
        }
      ],
      "exercise": {
        "prompt": "Implement client_ip so an untrusted peer ignores X-Forwarded-For entirely, and test a spoofed leftmost entry plus a trusted multi-hop chain.",
        "starter": "use std::net::{IpAddr, SocketAddr};\nuse ipnet::IpNet;\n\nfn client_ip(peer: SocketAddr, forwarded_for: Option<&str>, trusted: &[IpNet]) -> IpAddr {\n    // TODO: 1. untrusted peer -> peer.ip()\n    // TODO: 2. walk from the right, skip trusted, return first untrusted\n    todo!()\n}\n\n#[test]\nfn spoofed_prefix_is_ignored() {\n    // TODO: peer 10.0.0.5, XFF \"1.2.3.4, 203.0.113.9\", trusted 10.0.0.0/8\n}",
        "hint": "Push the peer onto the end of the parsed list and iterate in reverse. If every hop is trusted, fall back to the peer instead of returning an internal address.",
        "solution": "use std::net::{IpAddr, SocketAddr};\nuse ipnet::IpNet;\n\nfn client_ip(peer: SocketAddr, forwarded_for: Option<&str>, trusted: &[IpNet]) -> IpAddr {\n    let is_trusted = |ip: &IpAddr| trusted.iter().any(|net| net.contains(ip));\n\n    if !is_trusted(&peer.ip()) {\n        return peer.ip();\n    }\n    let Some(header) = forwarded_for else {\n        return peer.ip();\n    };\n\n    let mut hops: Vec<IpAddr> = header\n        .split(',')\n        .filter_map(|part| part.trim().parse().ok())\n        .collect();\n    hops.push(peer.ip());\n\n    for hop in hops.iter().rev() {\n        if !is_trusted(hop) {\n            return *hop;\n        }\n    }\n    peer.ip()\n}\n\n#[test]\nfn spoofed_prefix_is_ignored() {\n    let trusted = vec![\"10.0.0.0/8\".parse::<IpNet>().expect(\"cidr\")];\n    let peer: SocketAddr = \"10.0.0.5:443\".parse().expect(\"peer\");\n    let derived = client_ip(peer, Some(\"1.2.3.4, 203.0.113.9\"), &trusted);\n    assert_eq!(derived, \"203.0.113.9\".parse::<IpAddr>().expect(\"ip\"));\n}\n\n#[test]\nfn untrusted_peer_is_used_directly() {\n    let trusted = vec![\"10.0.0.0/8\".parse::<IpNet>().expect(\"cidr\")];\n    let peer: SocketAddr = \"203.0.113.9:443\".parse().expect(\"peer\");\n    let derived = client_ip(peer, Some(\"198.51.100.7\"), &trusted);\n    assert_eq!(derived, \"203.0.113.9\".parse::<IpAddr>().expect(\"ip\"));\n}"
      },
      "questions": [
        {
          "q": "Which X-Forwarded-For entry is trustworthy when the nearest proxy appends?",
          "options": [
            "The leftmost",
            "The rightmost, when the peer is a trusted proxy",
            "The one with the highest port",
            "All of them"
          ],
          "answer": 1,
          "explain": "Each proxy appends the address it saw, so the rightmost is the nearest trustworthy observation. The left side can be client-supplied."
        },
        {
          "q": "What should happen when the socket peer is not in the trusted CIDR list?",
          "options": [
            "Use the leftmost forwarded entry",
            "Ignore forwarded headers and use the peer address",
            "Reject the request with 403",
            "Trust the Forwarded header instead"
          ],
          "answer": 1,
          "explain": "If the direct connection is not from a proxy you control, nothing in the headers is verifiable. The socket address is the only fact."
        }
      ],
      "quickbytes": [
        "Append-only XFF means left is client data and right is proxy data; walk from the right and stop at the first untrusted hop.",
        "Load trusted proxy CIDRs from configuration and fail startup when an empty list is used in production.",
        "Build redirects and absolute URLs from configured base URLs, never from X-Forwarded-Proto or X-Forwarded-Host.",
        "Log peer and derived client separately so a spoofing attempt is visible instead of silently trusted."
      ],
      "production": [
        "Write a table-driven test per hop: direct client, one proxy, two proxies, spoofed prefix, trusted peer with no header.",
        "Keep the trust list in infrastructure config, not in code, and review changes to it like a firewall rule.",
        "Rate-limit by the derived client address, but keep the peer address for network-level blocks.",
        "Never use a forwarded header to decide whether a request is internal or authenticated."
      ],
      "crates": [
        "axum-client-ip",
        "ipnet",
        "axum",
        "tower-http"
      ],
      "pitfall": "Reading the leftmost X-Forwarded-For entry. Anyone can send the header themselves, claim 127.0.0.1 or a victim's address, and bypass per-IP limits or poison audit logs.",
      "github": [
        {
          "name": "imbolc/axum-client-ip",
          "url": "https://github.com/imbolc/axum-client-ip"
        },
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        }
      ],
      "resources": [
        {
          "title": "MDN: X-Forwarded-For",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Forwarded-For",
          "kind": "docs"
        },
        {
          "title": "MDN: Forwarded header",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Forwarded",
          "kind": "docs"
        },
        {
          "title": "axum-client-ip crate documentation",
          "url": "https://docs.rs/axum-client-ip/latest/axum_client_ip/",
          "kind": "docs"
        },
        {
          "title": "imbolc/axum-client-ip repository",
          "url": "https://github.com/imbolc/axum-client-ip",
          "kind": "repo"
        },
        {
          "title": "ipnet crate documentation",
          "url": "https://docs.rs/ipnet/latest/ipnet/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "w20",
      "n": 20,
      "title": "Request validation that emits problem details",
      "minutes": 80,
      "level": "advanced",
      "goal": "Validate bodies once with typed rules, report every failing field as an RFC 9457 extension member, and keep 400 for syntax versus 422 for semantics.",
      "sections": [
        {
          "h": "serde is syntax, validation is semantics",
          "p": [
            "Deserialization proves the body is JSON with the right shape. It cannot know that a title must be one to two hundred characters, that a priority is between zero and five, or that a due date is in the future. Those rules belong in one typed validator at the boundary.",
            "Reject unknown fields on write bodies so a typo becomes an error instead of a silently ignored field. Count characters for limits users can see and bytes for limits storage enforces, and trim before measuring so a title of spaces is not accepted as two hundred characters."
          ],
          "code": "use garde::Validate;\nuse serde::Deserialize;\n\n#[derive(Debug, Deserialize, Validate)]\n#[serde(deny_unknown_fields, rename_all = \"camelCase\")]\npub struct CreateTask {\n    #[garde(length(min = 1, max = 200))]\n    pub title: String,\n    #[garde(range(min = 0, max = 5))]\n    pub priority: u8,\n    #[garde(email)]\n    pub assignee_email: Option<String>,\n}\n\npub fn parse(body: CreateTask) -> Result<CreateTask, ApiError> {\n    body.validate(&())\n        .map_err(|report| ApiError::Validation(invalid_params(&report)))?;\n    Ok(body)\n}",
          "tip": "Validate the same rules in the database as constraints. The validator exists to produce a good error message; the constraint is what makes the invariant true under a race."
        },
        {
          "h": "One error body with invalid-params",
          "p": [
            "RFC 9457 defines type, title, status, detail, and instance, and allows extension members. Add invalid-params as an array of objects with name and reason, so a client can highlight fields without parsing an English sentence. Keep the type URI stable across releases; clients key error handling on it, not on the prose title.",
            "Report every failure in one response. A client that fixes one field per round trip costs a support cycle per field, and the second error is usually the one that gets misread. Cap the number of reported fields at something sane, and sort them by path so responses are comparable across runs."
          ],
          "code": "#[derive(Debug, serde::Serialize)]\npub struct Problem {\n    #[serde(rename = \"type\")]\n    pub kind: String,\n    pub title: String,\n    pub status: u16,\n    pub detail: String,\n    pub invalid_params: Vec<InvalidParam>,\n}\n\n#[derive(Debug, serde::Serialize)]\npub struct InvalidParam {\n    pub name: String,\n    pub reason: String,\n}\n\npub fn invalid_params(report: &garde::Report) -> Vec<InvalidParam> {\n    report\n        .iter()\n        .map(|(path, error)| InvalidParam {\n            name: path.to_string(),\n            reason: error.to_string(),\n        })\n        .collect()\n}",
          "tip": "Never echo the rejected value. A validation error on an email or a token is a log line and a response body that now contains personal data."
        },
        {
          "h": "Keep the status table honest",
          "p": [
            "400 means the bytes did not parse: malformed JSON, wrong content type, a body over the limit. 422 means it parsed and broke a rule. 409 means it conflicts with current state, such as a duplicate slug. Collapsing all three into 400 makes retries and client messaging guesswork.",
            "The framework's own rejections are part of the contract. Body-too-large, unsupported media type, and query parse failures must be mapped into the same problem+json shape, with the same content type, or clients need two parsers. A single mapper in the error module is cheaper than teaching every handler to build the same JSON."
          ],
          "code": "use axum::{\n    http::{header, HeaderValue, StatusCode},\n    response::{IntoResponse, Response},\n    Json,\n};\n\npub fn validation_response(params: Vec<InvalidParam>) -> Response {\n    let problem = Problem {\n        kind: \"https://api.example.com/problems/invalid-request\".to_owned(),\n        title: \"Request validation failed\".to_owned(),\n        status: 422,\n        detail: \"one or more fields are invalid\".to_owned(),\n        invalid_params: params,\n    };\n    let mut response = (StatusCode::UNPROCESSABLE_ENTITY, Json(problem)).into_response();\n    response.headers_mut().insert(\n        header::CONTENT_TYPE,\n        HeaderValue::from_static(\"application/problem+json\"),\n    );\n    response\n}",
          "tip": "Read the RFC 9457 members once and reuse the type everywhere: the same Problem struct should serialize 404s, 409s, 429s, and 422s. One shape, one parser on the client."
        }
      ],
      "exercise": {
        "prompt": "Map a garde report into invalid-params, return 422 with the problem+json content type, and test that two invalid fields produce two entries.",
        "starter": "use garde::Validate;\n\n#[derive(Validate)]\nstruct CreateTask {\n    #[garde(length(min = 1, max = 200))]\n    title: String,\n    #[garde(range(min = 0, max = 5))]\n    priority: u8,\n}\n\nfn invalid_params(report: &garde::Report) -> Vec<(String, String)> {\n    // TODO: (path, error) for each entry\n    todo!()\n}",
        "hint": "report.iter() yields (&Path, &Error). Convert both with to_string(); do not stop at the first error, or the client fixes one field per attempt.",
        "solution": "use garde::Validate;\n\n#[derive(Debug, Validate)]\nstruct CreateTask {\n    #[garde(length(min = 1, max = 200))]\n    title: String,\n    #[garde(range(min = 0, max = 5))]\n    priority: u8,\n}\n\n#[derive(Debug, serde::Serialize)]\nstruct InvalidParam {\n    name: String,\n    reason: String,\n}\n\nfn invalid_params(report: &garde::Report) -> Vec<InvalidParam> {\n    report\n        .iter()\n        .map(|(path, error)| InvalidParam {\n            name: path.to_string(),\n            reason: error.to_string(),\n        })\n        .collect()\n}\n\n#[test]\nfn two_bad_fields_produce_two_entries() {\n    let body = CreateTask {\n        title: String::new(),\n        priority: 9,\n    };\n    let report = body.validate(&()).expect_err(\"both fields are invalid\");\n    assert_eq!(report.iter().count(), 2);\n\n    let params = invalid_params(&report);\n    assert_eq!(params.len(), 2);\n    assert!(params.iter().any(|param| param.name == \"title\"));\n    assert!(params.iter().any(|param| param.name == \"priority\"));\n}"
      },
      "questions": [
        {
          "q": "Which status fits a body that parsed as JSON but has priority=9 when the range is 0-5?",
          "options": [
            "400",
            "409",
            "422",
            "500"
          ],
          "answer": 2,
          "explain": "422 means the syntax is valid and the semantics are not. 400 is for unparsable input and 409 is a conflict with current state."
        },
        {
          "q": "Why report all invalid fields in one response?",
          "options": [
            "It reduces response size",
            "Clients can fix the form in one pass instead of one field per round trip",
            "It changes the status code",
            "It avoids database writes"
          ],
          "answer": 1,
          "explain": "A single aggregated report is one interaction. Returning the first error turns a five-field form into five submit-and-retry cycles."
        }
      ],
      "quickbytes": [
        "Derive Validate on request DTOs with deny_unknown_fields; keep business invariants in database constraints as well.",
        "Return 422 with invalid-params as an array of {name, reason}; never echo the rejected value into the body or logs.",
        "Map JsonRejection, body-limit, and query-parse failures into the same problem+json type so clients need one parser."
      ],
      "production": [
        "Keep one Problem type across every status code and assert its content type in tests.",
        "Test the boundary cases: empty string, 200 characters, 201 characters, unknown field, wrong type.",
        "Log validation failures by field name and rule, not by value, and watch for a spike after a client release.",
        "Document every rule in the OpenAPI schema so generated clients validate before sending."
      ],
      "crates": [
        "garde",
        "serde",
        "serde_json",
        "serde_path_to_error"
      ],
      "pitfall": "Validating only in the frontend, or only after the insert. Invalid rows reach the database, every downstream consumer has to defend against them, and the API that promised 422 returns 500 instead.",
      "github": [
        {
          "name": "jprochazk/garde",
          "url": "https://github.com/jprochazk/garde"
        },
        {
          "name": "Keats/validator",
          "url": "https://github.com/Keats/validator"
        }
      ],
      "resources": [
        {
          "title": "garde validation crate",
          "url": "https://docs.rs/garde/latest/garde/",
          "kind": "docs"
        },
        {
          "title": "serde_path_to_error",
          "url": "https://docs.rs/serde_path_to_error/latest/serde_path_to_error/",
          "kind": "docs"
        },
        {
          "title": "jprochazk/garde repository",
          "url": "https://github.com/jprochazk/garde",
          "kind": "repo"
        },
        {
          "title": "Keats/validator repository",
          "url": "https://github.com/Keats/validator",
          "kind": "repo"
        },
        {
          "title": "Let's Get Rusty - Rust tutorials (YouTube)",
          "url": "https://www.youtube.com/@letsgetrusty",
          "kind": "video"
        }
      ]
    }
  ]
};
