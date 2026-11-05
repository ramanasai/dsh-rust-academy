/**
 * API design track.
 *
 * Authored for the Rust Academy plugin. Every lesson is plain JSON-compatible
 * data consumed by src/app.js through build.mjs.
 */
export default {
  "key": "api-design",
  "prefix": "ap",
  "title": "API design",
  "blurb": "REST, RPC and GraphQL trade-offs, versioning, pagination, errors, idempotency, SDKs and developer experience.",
  "level": "industry",
  "project": {
    "title": "Capstone: design and ship a public API contract",
    "brief": "Design and ship one versioned public API that another team can adopt without a call: an OpenAPI 3.1 contract generated from axum handlers, a problem+json error model with stable codes, cursor pagination on every list, idempotent writes, a deprecation policy with real dates, and a generated client you compile in CI.",
    "deliverables": [
      "An OpenAPI 3.1 document generated from the handlers, snapshotted in tests, and served at /openapi.json.",
      "A problem+json error envelope with a documented code catalog and a JSON Pointer for every field error.",
      "Cursor pagination plus filtering and sorting with documented defaults, maxima, and invalid-cursor behaviour.",
      "An idempotency-key store in Postgres with replay, in-flight rejection, payload-mismatch detection, and a 24 hour TTL.",
      "A versioning and deprecation plan that names an owner, a date, and the sunset mechanics for every retired route.",
      "A progenitor-generated client plus contract tests that fail the build when the published spec drifts from the code."
    ],
    "stack": [
      "axum",
      "tower-http",
      "utoipa",
      "utoipa-axum",
      "serde",
      "serde_json",
      "sqlx",
      "progenitor"
    ]
  },
  "lessons": [
    {
      "id": "ap01",
      "title": "Resources, actions, and addressable state",
      "minutes": 60,
      "level": "core",
      "goal": "Choose between a noun-shaped resource and a verb-shaped command by asking what the client must address, retry, and observe after the call.",
      "sections": [
        {
          "h": "A resource is a thing you can address",
          "p": [
            "A URI identifies a resource; methods transfer representations of it. That is the whole of REST's leverage. Because `GET /orders/ord_123` names a thing, a proxy can cache it, a client can retry it, logs can aggregate it, and authorization can be decided before the body is read. The moment the path contains a verb - `POST /orders/updateStatus` - every intermediary has to treat the call as an opaque, unsafe write that it cannot cache, retry, or reason about.",
            "Actions still exist. Refunding a payment, cancelling an order, replaying a webhook: none of these is a field update, and pretending otherwise produces `PATCH {\"status\": \"cancelled\"}` with four side effects behind it. The fix is to name the action as a resource: `POST /orders/{id}/cancellation` returns 201 with a cancellation object you can GET, retry, and audit. The action becomes a noun, the verb is the method, and the side effect gets an identity."
          ],
          "list": [
            "Collection URIs are plural nouns: /orders, /orders/{id}, /orders/{id}/line-items",
            "The verb lives in the method, never in a path segment",
            "A command that changes state gets its own sub-resource and a Location header",
            "Long-running work returns 202 plus an operation resource the client can poll"
          ],
          "tip": "If an endpoint name contains a verb, ask what object the call creates. Usually the honest answer is a resource you forgot to model."
        },
        {
          "h": "The verb-in-the-path failure modes",
          "p": [
            "`POST /updateOrderStatus?id=42&status=shipped` fails in four measurable ways. It is an unsafe method doing a state transition, so no client can retry it safely and no gateway can rate-limit it by method. Authorization requires parsing the body to learn whether the caller may *ship*, not merely whether they may write orders. The response is usually `200 {\"ok\": true}`, which tells a generated SDK nothing about the resulting state. And analytics cannot count shipments without decoding payloads.",
            "The same endpoint also collapses genuinely different transitions into one code path. Cancelling and shipping have different preconditions, different audit requirements, and different downstream effects. When they share a handler you get a status column that any caller can set to any value, plus one branch of validation that quietly accepts the other operation's inputs."
          ],
          "code": "use axum::extract::{Path, State};\nuse axum::http::{header, StatusCode};\nuse axum::response::{IntoResponse, Response};\nuse axum::routing::{get, post};\nuse axum::{Json, Router};\nuse serde::{Deserialize, Serialize};\n\npub fn router() -> Router<AppState> {\n    Router::new()\n        .route(\"/v1/orders\", post(create_order).get(list_orders))\n        .route(\"/v1/orders/{id}\", get(get_order))\n        // A command modelled as a resource: creates a cancellation you can GET.\n        .route(\"/v1/orders/{id}/cancellation\", post(request_cancellation))\n        // Work that outlives the request: 202 plus an operation to poll.\n        .route(\"/v1/orders/{id}/export\", post(start_export))\n        .route(\"/v1/operations/{id}\", get(get_operation))\n}\n\n#[derive(Deserialize)]\npub struct CancellationRequest {\n    pub reason: CancellationReason,\n    #[serde(default)]\n    pub note: Option<String>,\n}\n\n#[derive(Serialize)]\npub struct Cancellation {\n    pub id: String,\n    pub order_id: String,\n    pub state: CancellationState,\n}\n\npub async fn request_cancellation(\n    State(state): State<AppState>,\n    Path(order_id): Path<String>,\n    Json(body): Json<CancellationRequest>,\n) -> Response {\n    match state.orders.request_cancellation(&order_id, body).await {\n        Ok(cancellation) => (\n            StatusCode::CREATED,\n            [(header::LOCATION, format!(\"/v1/orders/{order_id}/cancellation/{}\", cancellation.id))],\n            Json(cancellation),\n        )\n            .into_response(),\n        Err(OrderError::NotFound) => StatusCode::NOT_FOUND.into_response(),\n        Err(OrderError::AlreadyShipped) => StatusCode::CONFLICT.into_response(),\n        Err(error) => error.into_response(),\n    }\n}",
          "tip": "Created resources get 201 and a Location header. A 201 without Location forces the client to re-read the collection to discover what it just made."
        },
        {
          "h": "When an action endpoint is the right call",
          "p": [
            "Two cases justify a verb-shaped endpoint. The first is an operation that touches many aggregates and has no single owning object - `POST /admin/reindex`, `POST /billing/close-period`. Model the *run* rather than the request: return an operation id, a state, and a timestamp. The second is a legacy integration you cannot change; wrap it at the edge with a shape you control, and never let it define your internal contract.",
            "Even then, keep the resource discipline. Every action returns a body with an id, a state, and a way to observe progress. `202 Accepted` with `Location: /v1/operations/{id}` and a terminal state of `succeeded` or `failed` is the difference between a job you can operate and a request that either hangs or lies about having completed."
          ],
          "tip": "Return 202 only when you can name the operation. A 202 with no Location is a 500 that has not happened yet."
        }
      ],
      "exercise": {
        "prompt": "A legacy `POST /orders/setStatus` accepts any status for any order. Replace it with resource-shaped endpoints for shipment and cancellation plus a read-only status projection, and write the router and the cancellation handler with explicit status codes.",
        "starter": "use axum::routing::{get, post};\nuse axum::Router;\n\npub fn router() -> Router<AppState> {\n    Router::new()\n        // 1. collection and item resources\n        // 2. one POST per state transition, each creating a sub-resource\n        // 3. a read-only projection the UI can poll\n        todo!()\n}",
        "hint": "Two POSTs that create sub-resources return 201 plus Location; the projection is a GET. Return 404 for an unknown order, 409 when the transition is illegal from the current state, and 422 when the payload is well formed but the request is not permitted.",
        "solution": "use axum::extract::{Path, State};\nuse axum::http::{header, StatusCode};\nuse axum::response::{IntoResponse, Response};\nuse axum::routing::{get, post};\nuse axum::{Json, Router};\n\npub fn router() -> Router<AppState> {\n    Router::new()\n        .route(\"/v1/orders/{id}\", get(get_order))\n        .route(\"/v1/orders/{id}/status\", get(get_status))\n        .route(\"/v1/orders/{id}/shipment\", post(create_shipment))\n        .route(\"/v1/orders/{id}/cancellation\", post(request_cancellation))\n}\n\npub async fn request_cancellation(\n    State(state): State<AppState>,\n    Path(id): Path<String>,\n    Json(body): Json<CancellationRequest>,\n) -> Response {\n    match state.orders.request_cancellation(&id, body).await {\n        Ok(cancellation) => (\n            StatusCode::CREATED,\n            [(header::LOCATION, format!(\"/v1/orders/{id}/cancellation/{}\", cancellation.id))],\n            Json(cancellation),\n        )\n            .into_response(),\n        Err(OrderError::NotFound) => StatusCode::NOT_FOUND.into_response(),\n        Err(OrderError::IllegalTransition { .. }) => StatusCode::CONFLICT.into_response(),\n        Err(OrderError::NotCancellable { .. }) => StatusCode::UNPROCESSABLE_ENTITY.into_response(),\n        Err(error) => error.into_response(),\n    }\n}\n\npub async fn get_status(\n    State(state): State<AppState>,\n    Path(id): Path<String>,\n) -> Result<Json<StatusProjection>, OrderError> {\n    Ok(Json(state.orders.status_projection(&id).await?))\n}"
      },
      "questions": [
        {
          "q": "Which change most improves an endpoint like POST /orders/updateStatus?",
          "options": [
            "Add a request-id header so retries become detectable",
            "Model the transition as a sub-resource the client creates and can later GET",
            "Return 200 with the whole order in the body instead of {ok: true}",
            "Move the status into the query string so the request body stays empty"
          ],
          "answer": 1,
          "explain": "Addressability is what buys retry safety, caching, audit, and per-action authorization. A richer response body helps debugging but leaves the write opaque and unaddressable, so nothing else improves."
        },
        {
          "q": "Why does GET /orders/{id} still beat POST /orders/get for a read?",
          "options": [
            "GET is faster because handlers skip request-body parsing",
            "GET is defined as safe, so clients, proxies, and crawlers may retry it freely",
            "POST cannot return a 404 for a missing resource",
            "GET allows larger response payloads than POST"
          ],
          "answer": 1,
          "explain": "Speed is not the point. Safety is a promise that the method has no side effects, which is what lets intermediaries cache and retry it. POST forces every caller to treat a read as an unsafe write."
        },
        {
          "q": "When is 202 Accepted with an operation resource the right answer?",
          "options": [
            "Whenever the handler takes longer than 100 milliseconds",
            "When the work outlives the request and you can name an operation whose state the client can poll",
            "When the client did not send an Idempotency-Key header",
            "When the response body would exceed the gateway's size limit"
          ],
          "answer": 1,
          "explain": "202 promises that the request was accepted and that its outcome is observable elsewhere. Without an operation resource the client has no way to learn the result, so the 202 becomes a lost write with a receipt."
        }
      ],
      "quickbytes": [
        "Put the verb in the method and the noun in the path; a command sub-resource gives a side effect an identity.",
        "201 must carry Location; 202 must carry a pollable operation, or it is a dropped write.",
        "If a transition has different preconditions, it deserves its own endpoint, not a status column."
      ],
      "production": [
        "Every state transition has its own command endpoint with documented preconditions and a 409 path.",
        "Long-running operations expose /v1/operations/{id} with a terminal state and a created_at timestamp.",
        "Route inventory is generated from the router so an unauthenticated or undocumented path is a build failure.",
        "Command endpoints are idempotent or require an Idempotency-Key; none is silently replayable."
      ],
      "crates": [
        "axum",
        "serde",
        "serde_json",
        "tower-http"
      ],
      "github": [
        {
          "name": "axum - routing, extractors, and the Router API",
          "url": "https://github.com/tokio-rs/axum"
        },
        {
          "name": "googleapis - resource-oriented HTTP annotations for real APIs",
          "url": "https://github.com/googleapis/googleapis"
        }
      ],
      "pitfall": "`POST /orders/{id}/cancel` implemented as `UPDATE orders SET status = 'cancelled'` with the refund published afterwards: a flaky mobile client retries, the status update is a no-op the second time, and a second refund goes out because nothing in the path was idempotent.",
      "resources": [
        {
          "title": "MDN: HTTP request methods and their safety guarantees",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Methods",
          "kind": "docs"
        },
        {
          "title": "axum routing module: path syntax and method routers",
          "url": "https://docs.rs/axum/latest/axum/routing/index.html",
          "kind": "docs"
        },
        {
          "title": "googleapis: canonical resource-oriented API definitions",
          "url": "https://github.com/googleapis/googleapis",
          "kind": "repo"
        },
        {
          "title": "InfoQ: API design and platform engineering talks",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ap02",
      "title": "REST semantics: safety, idempotency, status codes",
      "minutes": 70,
      "level": "core",
      "goal": "Apply the method contract precisely - safe versus idempotent, 201/202/204/409/412 - and use ETag preconditions to stop lost updates.",
      "sections": [
        {
          "h": "Safe, idempotent, and neither",
          "p": [
            "Safe means the client did not ask for a state change; idempotent means N identical requests leave the server in the same state as one. GET, HEAD, OPTIONS, and TRACE are both. PUT and DELETE are idempotent but not safe: the second DELETE may return 404 while the state is identical, which is why the *effect* is what the definition covers, not the status code. POST is neither, and that single fact is the reason idempotency keys exist.",
            "PATCH is the trap. JSON Merge Patch (RFC 7396) is idempotent because it describes the desired state. JSON Patch (RFC 6902) is a list of operations applied in order, so `{\"op\": \"add\", \"path\": \"/tags/-\", \"value\": \"rush\"}` appends a second tag when replayed. If your PATCH is a command list, either require an idempotency key or rename it POST and stop pretending."
          ],
          "list": [
            "Safe: GET, HEAD, OPTIONS - no state change may be observable",
            "Idempotent: PUT, DELETE, JSON Merge Patch - replay converges",
            "Neither: POST, and any PATCH that applies relative operations",
            "A GET that writes analytics or touches a cache is still safe; a GET that sends an email is a bug"
          ]
        },
        {
          "h": "Status codes are the contract",
          "p": [
            "Clients, SDKs, retry policies, and dashboards all branch on the status line before they parse a byte of JSON. That makes it the most expensive part of the API to get wrong. 201 means created and must carry Location; 202 means accepted and must carry a way to observe the outcome; 204 means no body, and returning one anyway breaks strict clients. 409 means the request conflicts with current state; 422 means the syntax was fine and the semantics were not.",
            "Two more distinctions pay for themselves. 404 and 410 differ in intent: 404 is 'no such resource, maybe a typo', 410 is 'this existed and is gone, stop asking'. 412 and 428 differ in diagnosis: 412 says your precondition failed, 428 says you forgot to send one. Choose deliberately, document the table, and never return 200 with an error object inside - generated clients will report success and your dashboards will call it uptime."
          ],
          "code": "use axum::http::StatusCode;\nuse axum::response::{IntoResponse, Response};\n/// One place where a domain outcome becomes an HTTP status.\n/// Keeping this exhaustive is what stops handlers inventing 200-with-error.\npub fn status_for(outcome: &Outcome) -> StatusCode {\n    match outcome {\n        Outcome::Created { .. } => StatusCode::CREATED,             // 201 + Location\n        Outcome::Accepted { .. } => StatusCode::ACCEPTED,           // 202 + operation\n        Outcome::Updated => StatusCode::OK,\n        Outcome::Deleted => StatusCode::NO_CONTENT,                 // 204, no body\n        Outcome::Validation { .. } => StatusCode::UNPROCESSABLE_ENTITY, // 422\n        Outcome::Malformed => StatusCode::BAD_REQUEST,              // 400\n        Outcome::Conflict { .. } => StatusCode::CONFLICT,           // 409\n        Outcome::PreconditionFailed => StatusCode::PRECONDITION_FAILED, // 412\n        Outcome::Gone { .. } => StatusCode::GONE,                   // 410\n        Outcome::RateLimited { .. } => StatusCode::TOO_MANY_REQUESTS,   // 429 + Retry-After\n        Outcome::Internal => StatusCode::INTERNAL_SERVER_ERROR,\n    }\n}\n\npub fn to_response(outcome: Outcome) -> Response {\n    let status = status_for(&outcome);\n    if status == StatusCode::NO_CONTENT {\n        return status.into_response();\n    }\n    (status, axum::Json(outcome.body())).into_response()\n}",
          "tip": "Write the status table into the OpenAPI document as explicit responses. A 4xx that only exists in code is a 4xx your SDK does not model."
        },
        {
          "h": "Preconditions: ETag, If-None-Match, If-Match",
          "p": [
            "A GET that returns `ETag: \"7\"` lets the client cache and revalidate: the next request sends `If-None-Match: \"7\"` and gets a bodyless 304 when nothing changed. The same validator, used in reverse, fixes the lost-update problem. A client that read version 7 sends `If-Match: \"7\"` on the write; if the stored version has moved, the server returns 412 and no write happens. Without it, two editors silently overwrite each other and the last writer wins.",
            "Derive the validator from the representation - a version column, or a hash of the serialized body - not from `updated_at` at second resolution, which collides under load. Decide whether the precondition is optional (412 when stale) or mandatory (428 when missing); mandatory is correct for money and inventory, optional is friendlier for drafts. The cost is one extra round trip per write, which is cheaper than a reconciliation job."
          ],
          "code": "use axum::extract::{Path, State};\nuse axum::http::{header, HeaderMap, StatusCode};\nuse axum::response::{IntoResponse, Response};\nuse axum::Json;\nuse sqlx::PgPool;\n\npub async fn get_order(\n    State(pool): State<PgPool>,\n    Path(id): Path<String>,\n    headers: HeaderMap,\n) -> Response {\n    let Some(order) = load_order(&pool, &id).await.ok().flatten() else {\n        return StatusCode::NOT_FOUND.into_response();\n    };\n\n    // Strong validator from the representation's version, never from a clock.\n    let etag = format!(\"\\\"{}\\\"\", order.version);\n    let fresh = headers\n        .get(header::IF_NONE_MATCH)\n        .and_then(|value| value.to_str().ok())\n        .is_some_and(|value| value.split(',').any(|tag| tag.trim() == etag));\n\n    if fresh {\n        return (StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response();\n    }\n    (\n        StatusCode::OK,\n        [\n            (header::ETAG, etag),\n            (header::CACHE_CONTROL, \"private, max-age=0, must-revalidate\".to_string()),\n        ],\n        Json(order),\n    )\n        .into_response()\n}\n\npub async fn replace_order(\n    State(pool): State<PgPool>,\n    Path(id): Path<String>,\n    headers: HeaderMap,\n    Json(input): Json<OrderInput>,\n) -> Response {\n    let Some(raw) = headers.get(header::IF_MATCH).and_then(|v| v.to_str().ok()) else {\n        return StatusCode::PRECONDITION_REQUIRED.into_response(); // 428\n    };\n    let Ok(expected) = raw.trim_matches('\"').parse::<i64>() else {\n        return StatusCode::BAD_REQUEST.into_response();\n    };\n\n    match compare_and_swap(&pool, &id, expected, input).await {\n        Ok(Some(order)) => (\n            StatusCode::OK,\n            [(header::ETAG, format!(\"\\\"{}\\\"\", order.version))],\n            Json(order),\n        )\n            .into_response(),\n        Ok(None) => StatusCode::PRECONDITION_FAILED.into_response(), // 412\n        Err(error) => error.into_response(),\n    }\n}",
          "tip": "A 304 must not include a body or a Content-Length. Some proxies will happily cache the empty response and hand it out as a real answer."
        }
      ],
      "exercise": {
        "prompt": "Implement conditional update for /v1/orders/{id}: require If-Match, return 428 when it is missing, 412 when the version no longer matches, and refresh the ETag on success. Explain in a comment why the validator comes from the version column.",
        "starter": "use axum::extract::{Path, State};\nuse axum::http::{header, HeaderMap, StatusCode};\nuse axum::response::{IntoResponse, Response};\nuse axum::Json;\n\npub async fn replace_order(\n    State(pool): State<PgPool>,\n    Path(id): Path<String>,\n    headers: HeaderMap,\n    Json(input): Json<OrderInput>,\n) -> Response {\n    // 1. read If-Match, 428 when absent\n    // 2. parse the version out of the quoted tag\n    // 3. compare-and-swap in one statement\n    todo!()\n}",
        "hint": "Read header::IF_MATCH, trim the surrounding quotes, parse as i64, then run `UPDATE orders SET ... , version = version + 1 WHERE id = $1 AND version = $2 RETURNING version`. Zero rows means someone else won.",
        "solution": "use axum::extract::{Path, State};\nuse axum::http::{header, HeaderMap, StatusCode};\nuse axum::response::{IntoResponse, Response};\nuse axum::Json;\nuse sqlx::PgPool;\n\npub async fn replace_order(\n    State(pool): State<PgPool>,\n    Path(id): Path<String>,\n    headers: HeaderMap,\n    Json(input): Json<OrderInput>,\n) -> Response {\n    let Some(raw) = headers.get(header::IF_MATCH).and_then(|v| v.to_str().ok()) else {\n        return StatusCode::PRECONDITION_REQUIRED.into_response();\n    };\n\n    // The validator is the version column, not updated_at: two writes inside\n    // the same second would share a timestamp and the precondition would lie.\n    let Ok(expected) = raw.trim_matches('\"').parse::<i64>() else {\n        return StatusCode::BAD_REQUEST.into_response();\n    };\n\n    let updated = sqlx::query_as::<_, (i64,)>(\n        r#\"UPDATE orders\n              SET shipping_address = $3,\n                  version = version + 1,\n                  updated_at = now()\n            WHERE id = $1 AND version = $2\n        RETURNING version\"#,\n    )\n    .bind(&id)\n    .bind(expected)\n    .bind(&input.shipping_address)\n    .fetch_optional(&pool)\n    .await;\n\n    match updated {\n        Ok(Some((version,))) => (\n            StatusCode::OK,\n            [(header::ETAG, format!(\"\\\"{version}\\\"\"))],\n        )\n            .into_response(),\n        Ok(None) => StatusCode::PRECONDITION_FAILED.into_response(),\n        Err(error) => error.into_response(),\n    }\n}"
      },
      "questions": [
        {
          "q": "A client retries a PATCH that sends a JSON Patch body adding an element to an array. Why is the retry unsafe?",
          "options": [
            "PATCH is never idempotent because it always replaces the whole resource",
            "The operations are relative to current state, so replaying them applies the change twice",
            "PATCH responses cannot be cached, so the client never learns the first attempt succeeded",
            "The server rejects a repeated PATCH with 409 by definition"
          ],
          "answer": 1,
          "explain": "JSON Patch is a script, not a desired state. Replaying an add appends again. JSON Merge Patch is idempotent because it states the resulting value instead of a delta."
        },
        {
          "q": "What does returning 422 instead of 400 tell the client?",
          "options": [
            "The body was not valid JSON and must be re-encoded",
            "The syntax parsed but a semantic rule rejected it, so the same payload will fail identically",
            "The request should be retried once the server finishes reindexing",
            "The client is missing an Authorization header"
          ],
          "answer": 1,
          "explain": "422 separates parse failures from rule failures. Both are permanent for that payload, but the distinction tells the developer whether to fix encoding or fix the value."
        },
        {
          "q": "Why prefer 428 Precondition Required over a plain 409 when If-Match is missing?",
          "options": [
            "428 is cacheable, so the client avoids a second request",
            "428 names the missing precondition, so the client knows exactly how to fix the call",
            "409 is reserved for database deadlocks and cannot be used by APIs",
            "428 tells the client to retry immediately with the same payload"
          ],
          "answer": 1,
          "explain": "409 describes a state conflict the client cannot diagnose. 428 says the request lacks a precondition header, which is actionable without reading your documentation."
        }
      ],
      "quickbytes": [
        "PUT and DELETE are idempotent, POST is not; if a PATCH replays a delta, it is a POST wearing a PATCH label.",
        "201 needs Location, 202 needs an operation, 204 must have no body.",
        "Put If-Match on every money or inventory write; 428 when it is missing beats 412 after the fact."
      ],
      "production": [
        "Every endpoint's 2xx and 4xx responses are enumerated in the OpenAPI document, not just the happy path.",
        "ETags derive from a representation version or content hash, never from a second-resolution timestamp.",
        "No handler returns 200 with an error payload; a lint or a response-type wrapper makes that impossible.",
        "Locations in 201 responses are absolute or clearly relative, and resolve to the created resource.",
        "304 responses are verified to carry no body, because proxies will cache whatever you send."
      ],
      "crates": [
        "axum",
        "http",
        "serde",
        "sqlx"
      ],
      "github": [
        {
          "name": "http - StatusCode and header types used by axum and tonic",
          "url": "https://github.com/hyperium/http"
        },
        {
          "name": "axum - extractors and response types",
          "url": "https://github.com/tokio-rs/axum"
        }
      ],
      "pitfall": "Deriving the ETag from `updated_at` truncated to seconds: two writers inside the same second receive the same validator, both pass If-Match, and one update is silently overwritten while the API reports two successes.",
      "resources": [
        {
          "title": "MDN: HTTP response status codes",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status",
          "kind": "docs"
        },
        {
          "title": "MDN: ETag header and validator semantics",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/ETag",
          "kind": "docs"
        },
        {
          "title": "MDN: If-Match and conditional requests",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/If-Match",
          "kind": "docs"
        },
        {
          "title": "MDN: HTTP caching guide",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching",
          "kind": "docs"
        },
        {
          "title": "hyperium/http - the status and header primitives",
          "url": "https://github.com/hyperium/http",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "ap03",
      "title": "RPC and gRPC contract design",
      "minutes": 90,
      "level": "advanced",
      "goal": "Decide when RPC beats REST, shape request and response messages that can grow, and map domain failures onto gRPC status codes with explicit retry semantics.",
      "sections": [
        {
          "h": "What gRPC optimises, and what it costs",
          "p": [
            "gRPC is HTTP/2 plus protobuf plus generated stubs plus a deadline mechanism. It wins on internal service-to-service calls: a typed contract compiled on both ends, multiplexed streams over one connection, payloads far smaller than JSON, first-class deadlines, and bidirectional streaming. It also wins on failure vocabulary, because the status enum forces you to say whether a failure is the caller's fault or the server's state.",
            "The costs are real and usually understated. A gRPC endpoint is not curl-able, so debugging needs reflection, grpcurl, or the .proto itself. Browsers cannot speak it without grpc-web or a proxy. Load balancers and mTLS terminators must understand HTTP/2 end to end. Binary frames are awkward in logs and packet captures. And every stub upgrade couples producers and consumers more tightly than a JSON field ever does."
          ],
          "list": [
            "RPC: both ends are yours, call volume is high, or you need streaming and deadlines",
            "HTTP+JSON: public consumers, cacheable reads, CDN delivery, or partners who debug with curl",
            "Rule of thumb: the further the consumer is from your repository, the more human-readable HTTP you want",
            "Never expose the same surface twice; pick a primary and treat the other as a generated facade"
          ],
          "tip": "A JSON gateway in front of gRPC is not free: it is a second contract with its own error mapping, and it will drift unless it is generated."
        },
        {
          "h": "Messages are not your domain model",
          "p": [
            "Every RPC gets its own request and response message, even when the response is only the entity. Reusing the entity as the request looks tidy until you need to add a field mask, an idempotency key, or a cancellation reason: those fields then appear on the resource that every reader and every cache also sees. Additive fields are cheap on a request message and expensive on a shared entity, because the entity's shape is a compatibility decision for every consumer at once.",
            "proto3 cannot tell absent from zero for a scalar. `int32 quantity = 3` in an update message means both 'leave it alone' and 'set it to zero', and the server cannot recover the intent. Either mark the field `optional` to get explicit presence, or accept a `google.protobuf.FieldMask` and apply only the paths the client lists. Enums need a zero `_UNSPECIFIED` member, and deleting a field means reserving both its number and its name in the same commit, or a future edit will reuse the tag with a different type and corrupt old clients."
          ],
          "code": "syntax = \"proto3\";\n\npackage acme.orders.v2;\n\nimport \"google/protobuf/field_mask.proto\";\nimport \"google/protobuf/timestamp.proto\";\n\nmessage Order {\n  string id = 1;\n  string tenant_id = 2;\n  int64 total_minor_units = 3;   // money in minor units, never double\n  string currency = 4;           // ISO 4217, uppercase\n  OrderStatus status = 5;\n  google.protobuf.Timestamp created_at = 6;\n  reserved 7, 8;                 // retired fields: numbers stay burned\n  reserved \"legacy_status\";      // and so do names\n}\n\nenum OrderStatus {\n  ORDER_STATUS_UNSPECIFIED = 0;  // proto3 enums must start at zero\n  ORDER_STATUS_PENDING = 1;\n  ORDER_STATUS_PAID = 2;\n  ORDER_STATUS_SHIPPED = 3;\n  ORDER_STATUS_CANCELLED = 4;\n}\n\n// One request message per RPC. The entity is a field, never the request.\nmessage UpdateOrderRequest {\n  string id = 1;\n  Order order = 2;                     // only paths in the mask are applied\n  google.protobuf.FieldMask update_mask = 3;\n  string idempotency_key = 4;\n  string request_id = 5;\n}\n\nmessage UpdateOrderResponse {\n  Order order = 1;\n  bool replayed = 2;                   // true when the key was already used\n}\n\nservice Orders {\n  rpc UpdateOrder(UpdateOrderRequest) returns (UpdateOrderResponse);\n}",
          "tip": "Reserve tags and names in the commit that deletes them. A reused tag with a different type is undetectable at compile time and catastrophic at decode time on old clients."
        },
        {
          "h": "Errors: status codes plus structured detail",
          "p": [
            "A gRPC status is a sixteen-value enum and a string. That is not enough for a client to act on. INVALID_ARGUMENT and FAILED_PRECONDITION both mean 'do not retry'; ABORTED means 'the state moved, re-read and retry'; UNAVAILABLE and DEADLINE_EXCEEDED mean 'retry with backoff'; RESOURCE_EXHAUSTED means 'slow down or wait for the quota window'. If each handler decides for itself, the same domain failure returns different codes on different days and retry policies become guesswork.",
            "Two rules keep the mapping honest. Convert domain errors to Status in exactly one place - a `From<OrderError> for Status` impl - and never build `Status::internal` from a formatted database error, because that string ends up in client logs and stack traces. When the client needs more than a code, attach structured detail: the field name, the violated rule, and a request id, rather than a sentence the client has to parse."
          ],
          "code": "use tonic::{Code, Status};\n\n#[derive(Debug, thiserror::Error)]\npub enum OrderError {\n    #[error(\"order {0} does not exist\")]\n    NotFound(String),\n    #[error(\"order {0} already shipped\")]\n    AlreadyShipped(String),\n    #[error(\"quantity must be positive\")]\n    InvalidQuantity,\n    #[error(\"version conflict\")]\n    VersionConflict,\n    #[error(\"database unavailable\")]\n    Unavailable,\n}\n\n// The single place a domain failure becomes a retry decision for the client.\nimpl From<OrderError> for Status {\n    fn from(error: OrderError) -> Self {\n        match error {\n            // Permanent: the same request fails the same way.\n            OrderError::NotFound(id) => Status::not_found(format!(\"order {id} does not exist\")),\n            OrderError::AlreadyShipped(id) => {\n                Status::failed_precondition(format!(\"order {id} already shipped\"))\n            }\n            OrderError::InvalidQuantity => Status::invalid_argument(\"quantity must be positive\"),\n            // Retryable, but only after re-reading state.\n            OrderError::VersionConflict => Status::aborted(\"concurrent update; re-read and retry\"),\n            // Retryable with backoff, ideally inside the caller's deadline.\n            OrderError::Unavailable => Status::unavailable(\"database unavailable; retry with backoff\"),\n        }\n    }\n}\n\n/// Clients branch on the code, never on the message text.\npub fn is_retryable(code: Code) -> bool {\n    matches!(\n        code,\n        Code::Unavailable | Code::DeadlineExceeded | Code::ResourceExhausted | Code::Aborted\n    )\n}",
          "tip": "Keep `Code::Internal` for genuine bugs only. Every time a business rule returns INTERNAL, an alert fires and an on-call engineer learns to ignore the alert."
        }
      ],
      "exercise": {
        "prompt": "You own a pricing service called over gRPC by four internal teams. Classify these outcomes as retryable or permanent and map each to a status code: unknown SKU, negative quantity, price list not yet published, optimistic-lock conflict, database failover, caller over quota.",
        "starter": "use tonic::{Code, Status};\n\n#[derive(Debug, thiserror::Error)]\npub enum PricingError {\n    UnknownSku(String),\n    NegativeQuantity,\n    PriceListNotPublished,\n    VersionConflict,\n    DatabaseUnavailable,\n    OverQuota,\n}\n\nimpl From<PricingError> for Status {\n    fn from(error: PricingError) -> Self {\n        // map each outcome, then decide retryability\n        todo!()\n    }\n}",
        "hint": "Unknown SKU is NOT_FOUND and permanent. Negative quantity is INVALID_ARGUMENT. An unpublished price list is FAILED_PRECONDITION (the state must change first). The lock conflict is ABORTED. Failover is UNAVAILABLE. Being over quota is RESOURCE_EXHAUSTED, which is retryable only after the window resets.",
        "solution": "use tonic::{Code, Status};\n\n#[derive(Debug, thiserror::Error)]\npub enum PricingError {\n    UnknownSku(String),\n    NegativeQuantity,\n    PriceListNotPublished,\n    VersionConflict,\n    DatabaseUnavailable,\n    OverQuota,\n}\n\nimpl From<PricingError> for Status {\n    fn from(error: PricingError) -> Self {\n        match error {\n            PricingError::UnknownSku(sku) => Status::not_found(format!(\"unknown sku {sku}\")),\n            PricingError::NegativeQuantity => Status::invalid_argument(\"quantity must be positive\"),\n            PricingError::PriceListNotPublished => {\n                Status::failed_precondition(\"price list not published yet\")\n            }\n            PricingError::VersionConflict => Status::aborted(\"version conflict; re-read then retry\"),\n            PricingError::DatabaseUnavailable => Status::unavailable(\"database failover in progress\"),\n            PricingError::OverQuota => Status::resource_exhausted(\"quota exceeded; retry after reset\"),\n        }\n    }\n}\n\n/// ABORTED means the request was well formed but the state moved: re-read first.\n/// RESOURCE_EXHAUSTED is only retryable after the quota window, which is why the\n/// server must also return a retry hint in metadata (retry-after-ms).\npub fn retry_after(code: Code) -> Option<std::time::Duration> {\n    match code {\n        Code::Unavailable | Code::DeadlineExceeded => Some(std::time::Duration::from_millis(200)),\n        Code::Aborted => None, // retry needs fresh state, not a delay\n        Code::ResourceExhausted => Some(std::time::Duration::from_secs(30)),\n        _ => None,\n    }\n}"
      },
      "questions": [
        {
          "q": "Why is reusing the Order entity as the UpdateOrder request message a trap?",
          "options": [
            "protobuf cannot nest one message inside another",
            "Request-only fields such as a field mask or idempotency key then leak onto the shared resource",
            "It makes the encoded payload larger than a wrapper message",
            "Field numbers would collide with the response message"
          ],
          "answer": 1,
          "explain": "A wrapper costs one level of nesting and buys you a place to put request-scoped fields. On the entity, every request-only field becomes part of what readers and caches must understand."
        },
        {
          "q": "A call fails with FAILED_PRECONDITION. What should the client do?",
          "options": [
            "Retry with exponential backoff until the deadline expires",
            "Retry immediately with a longer deadline",
            "Stop and change something: the server state does not allow the call yet",
            "Treat it as success, since the request was validated"
          ],
          "answer": 2,
          "explain": "FAILED_PRECONDITION means the request is understood but the current state forbids it - an unpublished price list, an order already shipped. Retrying the identical request just burns budget."
        },
        {
          "q": "What does `optional int32 quantity = 3` give you that `int32 quantity = 3` does not?",
          "options": [
            "A smaller wire representation",
            "Explicit presence, so zero and absent are distinguishable",
            "Automatic validation that the value is positive",
            "Backwards compatibility with proto2 required fields"
          ],
          "answer": 1,
          "explain": "Without presence, a zero and an omitted field decode identically, so an update cannot express 'leave it alone'. Presence is what makes partial updates safe without a field mask."
        }
      ],
      "quickbytes": [
        "One request message per RPC; keep the entity as a field so request-only fields have somewhere to live.",
        "Reserve retired tags and names in the same commit that deletes the field.",
        "Map domain errors to Status once, and mark ABORTED as 're-read then retry', not 'wait then retry'."
      ],
      "production": [
        "Every RPC has a documented status-code table, and the client's retry policy is derived from it, not guessed.",
        "No handler returns INTERNAL for a business rule; a grep for Status::internal is part of review.",
        "Field masks are validated against an allowlist so a client cannot write server-owned fields.",
        "Proto packages are versioned (acme.orders.v2) and breaking-change checks run in CI before merge.",
        "Every outbound call carries a deadline smaller than the caller's remaining budget."
      ],
      "crates": [
        "tonic",
        "prost",
        "tonic-prost-build",
        "tokio"
      ],
      "github": [
        {
          "name": "grpc-rust - tonic's client, server, and codegen",
          "url": "https://github.com/grpc/grpc-rust"
        },
        {
          "name": "grpc - status code definitions and protocol specification",
          "url": "https://github.com/grpc/grpc"
        }
      ],
      "pitfall": "An update message with plain `int32 quantity` where zero means both 'unchanged' and 'set to zero': a client that wants to clear a field sends 0, the server cannot tell the difference, and every unreleased order silently gains a zero quantity.",
      "resources": [
        {
          "title": "gRPC status codes and their retry semantics",
          "url": "https://grpc.io/docs/guides/status-codes/",
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
          "title": "grpc-rust: tonic examples and transport internals",
          "url": "https://github.com/grpc/grpc-rust",
          "kind": "repo"
        },
        {
          "title": "gRPC channel: protocol, deadlines, and streaming talks",
          "url": "https://www.youtube.com/@grpcio",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ap04",
      "title": "GraphQL trade-offs: what a query language costs",
      "minutes": 85,
      "level": "advanced",
      "goal": "Judge when a query language pays for itself, and defend the endpoint with depth, complexity, pagination, and per-request batching before it becomes a database amplifier.",
      "sections": [
        {
          "h": "What a query language buys",
          "p": [
            "GraphQL moves response shaping to the client. One request returns exactly the fields a screen needs, including nested objects, so a mobile client stops making four round trips to render one view. The schema is introspectable, so codegen, validation, and mock servers all derive from one artifact. Fields can be deprecated individually, which removes the versioned-URL treadmill from the client's roadmap.",
            "It also makes the contract explicit in a way REST rarely manages. A REST payload is whatever the handler serialized; a GraphQL schema is a typed graph that the server validates every query against before running a resolver. That validation is free correctness, and it is the strongest argument for GraphQL on a product with many heterogeneous clients and a wide, evolving read surface."
          ],
          "tip": "Count clients before adopting it. Two clients with stable screens rarely repay the schema, resolver, and cost-analysis work GraphQL demands."
        },
        {
          "h": "What it costs, in latency and in operations",
          "p": [
            "Every field is a resolver, and every resolver is a query unless you batch. A query asking for 50 orders with their customer produces 51 database round trips; DataLoader collapses them per request tick, but only for the fields you remembered to batch. Caching is per field, and most clients POST, so a CDN sees an opaque body - persisted queries and GET-with-hash are how production deployments recover HTTP caching. Errors arrive inside a 200 with a `data: null` payload.",
            "The empirical picture is nuanced. A controlled experiment with 22 participants implementing eight queries found GraphQL took a median 6 minutes against REST's 9, with the gap widening as REST endpoints accumulated parameters (arXiv:2003.04761). That measures query-writing effort, not server cost, cache hit rate, or operational burden - the parts that dominate your bill."
          ],
          "list": [
            "N+1 resolvers: batch per request with DataLoader and still put a limit on fan-out",
            "No free HTTP caching: persisted queries, GET with a query hash, or a CDN that understands your envelope",
            "Authorization per field, not per route: a resolver that forgets a check leaks through a nested field",
            "Cost-based rate limiting, because one cheap-looking query can request ten thousand nodes",
            "Status is 200 for business errors, so every client must inspect the errors array"
          ]
        },
        {
          "h": "Defending the endpoint",
          "p": [
            "An unprotected GraphQL endpoint is a query planner that clients control. Set a maximum depth so fragment recursion terminates, a maximum complexity so a single request cannot request the whole database, and require pagination arguments on every list field. Turn introspection off for private APIs and behind an allowlist for public ones, since the schema is a map of your internal model. Put a per-request timeout under the HTTP timeout so a slow resolver cannot hold a connection open.",
            "Persisted queries are the single highest-leverage control. When the server only executes hashes it has seen before, the client cannot invent a new expensive shape, the request becomes a cacheable GET, and the payload shrinks to 20 bytes. That is why the largest public GraphQL deployments ship an allowlist rather than an open query surface."
          ],
          "code": "use async_graphql::{Context, EmptySubscription, Object, Result, Schema};\nuse async_graphql_axum::{GraphQLRequest, GraphQLResponse};\nuse axum::extract::State;\n\npub type ApiSchema = Schema<Query, Mutation, EmptySubscription>;\n\npub fn schema(pool: sqlx::PgPool) -> ApiSchema {\n    Schema::build(Query, Mutation, EmptySubscription)\n        .limit_depth(12)       // fragment bombs die here, not in Postgres\n        .limit_complexity(500) // summed before execution, so cost is refused early\n        .data(pool)\n        .finish()\n}\n\npub struct Query;\n\n#[Object]\nimpl Query {\n    /// Cursor paginated, and `first` is clamped so no client can ask for the table.\n    async fn orders(\n        &self,\n        ctx: &Context<'_>,\n        first: Option<i32>,\n        after: Option<String>,\n    ) -> Result<OrderConnection> {\n        let pool = ctx.data_unchecked::<sqlx::PgPool>();\n        let limit = first.unwrap_or(20).clamp(1, 100) as i64;\n        let rows = fetch_page(pool, after.as_deref(), limit).await?;\n        Ok(OrderConnection::from_rows(rows, limit))\n    }\n}\n\npub async fn graphql_handler(\n    State(schema): State<ApiSchema>,\n    req: GraphQLRequest,\n) -> GraphQLResponse {\n    schema.execute(req.into_inner()).await.into()\n}",
          "tip": "Set limits in the schema builder, not in resolvers. A limit applied after the query is planned has already paid the planning cost you were trying to avoid."
        }
      ],
      "exercise": {
        "prompt": "A product team wants GraphQL over an existing REST catalog of 40 endpoints. Write the schema builder with depth and complexity limits, add a paginated list field, and justify in comments which two REST endpoints you would keep as REST.",
        "starter": "use async_graphql::{EmptySubscription, Object, Schema};\n\npub struct Query;\n\n#[Object]\nimpl Query {\n    // add a paginated list field with a clamped page size\n}\n\npub fn schema() -> Schema<Query, async_graphql::EmptyMutation, EmptySubscription> {\n    // add depth and complexity limits\n    todo!()\n}",
        "hint": "Use Schema::build(...).limit_depth(12).limit_complexity(500).data(pool).finish(). Keep file download and webhook registration as REST: one needs byte-range streaming, the other needs a URL the third party can POST to.",
        "solution": "use async_graphql::{Context, EmptyMutation, EmptySubscription, Object, Result, Schema};\n\npub type ApiSchema = Schema<Query, EmptyMutation, EmptySubscription>;\n\npub fn schema(pool: sqlx::PgPool) -> ApiSchema {\n    Schema::build(Query, EmptyMutation, EmptySubscription)\n        .limit_depth(12)\n        .limit_complexity(500)\n        .data(pool)\n        .finish()\n}\n\npub struct Query;\n\n#[Object]\nimpl Query {\n    async fn products(\n        &self,\n        ctx: &Context<'_>,\n        first: Option<i32>,\n        after: Option<String>,\n    ) -> Result<ProductConnection> {\n        let pool = ctx.data_unchecked::<sqlx::PgPool>();\n        let limit = first.unwrap_or(20).clamp(1, 100) as i64;\n        let rows = load_products(pool, after.as_deref(), limit).await?;\n        Ok(ProductConnection::from_rows(rows, limit))\n    }\n}\n\n// Kept as REST on purpose:\n// 1. GET /v1/files/{id}/content streams bytes with range support; GraphQL\n//    scalars would buffer the whole object into memory.\n// 2. POST /v1/webhooks is called by third parties, who get a URL and an HMAC\n//    secret, not a GraphQL client.\nfn _kept_as_rest() {}"
      },
      "questions": [
        {
          "q": "A GraphQL response arrives with HTTP 200 and `{\"data\": null, \"errors\": [...]}`. What must the client do?",
          "options": [
            "Treat it as success because the status line was 2xx",
            "Treat it as a failure: check errors and branch on their extension codes",
            "Retry immediately, since a null data field means the server was busy",
            "Ignore it and re-send the query as a mutation"
          ],
          "answer": 1,
          "explain": "GraphQL puts business and validation failures in the body while keeping a 200 because partial data may still be present. A client that trusts the status line will render empty pages as if they were successful."
        },
        {
          "q": "What does DataLoader actually fix?",
          "options": [
            "It caches responses at the CDN so repeated queries cost nothing",
            "It batches per-request resolver calls into fewer queries, but fan-out and indexing are still yours",
            "It enforces query depth and complexity limits for you",
            "It converts POST requests into cacheable GETs"
          ],
          "answer": 1,
          "explain": "DataLoader coalesces resolver calls within one request tick. It removes the 1-per-item query pattern, not the underlying cost of loading many rows or the need for pagination."
        },
        {
          "q": "Which is the strongest reason to choose GraphQL for a public API?",
          "options": [
            "It removes the need to version the API",
            "Many heterogeneous clients need different subsets of a deeply connected read model",
            "It is faster than JSON over HTTP because payloads are smaller",
            "It gives you one endpoint, which is simpler to secure"
          ],
          "answer": 1,
          "explain": "GraphQL pays off when clients legitimately need different shapes of a connected graph. Fewer endpoints is an aesthetic gain, and one endpoint is harder to authorize and rate-limit, not easier."
        }
      ],
      "quickbytes": [
        "Limit depth and complexity in Schema::build; a resolver-level check runs after the expensive planning you wanted to prevent.",
        "DataLoader batches per request tick; it does not fix unbounded fan-out, so cap list sizes anyway.",
        "Persisted queries give you back HTTP caching, payload size, and a shape allowlist in one move."
      ],
      "production": [
        "Depth and complexity limits are configured and tested with a hostile query in CI.",
        "Every list field takes pagination arguments and has a documented default and maximum page size.",
        "Introspection is disabled or allowlisted outside development, and persisted queries are the production path.",
        "Authorization is enforced in resolvers with a shared guard, not in the HTTP layer above the schema.",
        "Per-request timeouts are shorter than the load-balancer idle timeout, and slow resolvers are traced."
      ],
      "crates": [
        "async-graphql",
        "async-graphql-axum",
        "axum",
        "sqlx"
      ],
      "github": [
        {
          "name": "async-graphql - schema, resolvers, DataLoader, limits",
          "url": "https://github.com/async-graphql/async-graphql"
        },
        {
          "name": "async-graphql examples - axum integration and subscriptions",
          "url": "https://github.com/async-graphql/examples"
        }
      ],
      "pitfall": "Shipping without a depth limit: a client sends a recursive fragment that expands to thousands of nodes, one HTTP request pins a database connection for thirty seconds, and the autoscaler adds replicas that all run the same query.",
      "resources": [
        {
          "title": "REST vs GraphQL: A Controlled Experiment (arXiv:2003.04761)",
          "url": "https://arxiv.org/abs/2003.04761",
          "kind": "paper"
        },
        {
          "title": "async-graphql crate documentation",
          "url": "https://docs.rs/async-graphql/latest/async_graphql/",
          "kind": "docs"
        },
        {
          "title": "async-graphql-axum: GraphQL over axum",
          "url": "https://docs.rs/async-graphql-axum/latest/async_graphql_axum/",
          "kind": "docs"
        },
        {
          "title": "async-graphql repository and integration examples",
          "url": "https://github.com/async-graphql/async-graphql",
          "kind": "repo"
        },
        {
          "title": "GOTO: architecture and API design conference talks",
          "url": "https://www.youtube.com/@GOTO-",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ap05",
      "title": "Schema design: ids, money, time, and open enums",
      "minutes": 80,
      "level": "advanced",
      "goal": "Pick wire types that do not need a v2: opaque ids, integer money, RFC 3339 timestamps, open enums, and explicit presence for patches.",
      "sections": [
        {
          "h": "Four type choices that decide your compatibility",
          "p": [
            "Identifiers belong on the wire as opaque strings. A `u64` id above 2^53-1 cannot be represented in a JavaScript `number`, so a browser client silently rounds `9007199254740993` to `9007199254740992` and then edits the wrong record. Sequential integers also publish your order volume and invite enumeration. Use a ULID or UUIDv7 rendered as a string: sortable, opaque, and safe in every JSON parser.",
            "Money is an integer in minor units plus an ISO 4217 code. Floating point cannot represent 0.10, so totals drift and reconciliation becomes an investigation; `f64` also invites mixing currencies because the unit is only in the field name. Timestamps are RFC 3339 in UTC with an explicit offset and at least millisecond precision - never bare epoch numbers whose unit lives only in a document. A seconds-versus-milliseconds mix-up has taken down more than one spacecraft."
          ],
          "list": [
            "id: opaque string (ULID, UUIDv7), never a language-native integer",
            "money: i64 minor units plus an uppercase ISO 4217 currency",
            "time: RFC 3339 UTC with an offset and milliseconds, named created_at / updated_at",
            "enums: additive and open, with a documented rule for unknown values"
          ],
          "tip": "If a field's unit is not in its name, someone will send the wrong one. total_minor_units beats total; duration_ms beats duration."
        },
        {
          "h": "Open enums and tolerant readers",
          "p": [
            "Deriving Deserialize on a string enum makes every value you did not enumerate a parse failure. The day the server adds `partially_refunded`, every older client throws instead of showing a status it does not recognise. Servers must be allowed to add enum values; clients must treat unknown values as opaque and render them or map them to a generic label.",
            "serde's `#[serde(other)]` cannot express this for an externally tagged string enum, so write the two impls or use a newtype. The version below keeps the original string in an `Other` variant so an older service can round-trip a value it does not understand instead of erasing it. Write the rule in the spec as well, because the client's behaviour is part of the contract."
          ],
          "code": "use serde::{Deserialize, Deserializer, Serialize, Serializer};\n\n/// Open enum: unknown values survive a round trip instead of failing the parse.\n#[derive(Debug, Clone, PartialEq, Eq)]\npub enum OrderStatus {\n    Pending,\n    Paid,\n    Shipped,\n    Cancelled,\n    Refunded,\n    Other(String),\n}\n\nimpl Serialize for OrderStatus {\n    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {\n        let raw = match self {\n            Self::Pending => \"pending\",\n            Self::Paid => \"paid\",\n            Self::Shipped => \"shipped\",\n            Self::Cancelled => \"cancelled\",\n            Self::Refunded => \"refunded\",\n            Self::Other(raw) => raw.as_str(),\n        };\n        serializer.serialize_str(raw)\n    }\n}\n\nimpl<'de> Deserialize<'de> for OrderStatus {\n    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {\n        let raw = String::deserialize(deserializer)?;\n        Ok(match raw.as_str() {\n            \"pending\" => Self::Pending,\n            \"paid\" => Self::Paid,\n            \"shipped\" => Self::Shipped,\n            \"cancelled\" => Self::Cancelled,\n            \"refunded\" => Self::Refunded,\n            _ => Self::Other(raw),\n        })\n    }\n}",
          "tip": "Document the client rule too: 'treat unknown enum values as opaque and do not fail the request'. A server-side guarantee without a client-side rule is half a contract."
        },
        {
          "h": "Absent, null, and value are three states",
          "p": [
            "A PATCH body needs three outcomes per field: leave it alone, clear it, set it. `Option<T>` gives you two, so `{\"note\": null}` and `{}` both deserialize to `None` and the client cannot express 'clear the note'. The usual fix is `Option<Option<T>>` with a deserializer that only runs when the key is present, which turns absent into `None`, null into `Some(None)`, and a value into `Some(Some(value))`.",
            "Decide the response side too. Either always emit optional fields, including null, or omit them consistently with `skip_serializing_if`. Mixing the two makes the same resource change shape between requests, and a strict generated client in another language will fail to deserialize the first time a field appears."
          ],
          "code": "use serde::{Deserialize, Deserializer, Serialize};\n\n#[derive(Debug, Deserialize)]\npub struct UpdateOrder {\n    // Absent field -> None (leave alone). Present null -> Some(None) (clear).\n    // Present value -> Some(Some(value)) (set).\n    #[serde(default, deserialize_with = \"present_or_null\")]\n    pub shipping_address: Option<Option<Address>>,\n    #[serde(default, deserialize_with = \"present_or_null\")]\n    pub note: Option<Option<String>>,\n}\n\nfn present_or_null<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>\nwhere\n    D: Deserializer<'de>,\n    T: Deserialize<'de>,\n{\n    // Only called when the key exists, so wrapping in Some records presence.\n    Option::<T>::deserialize(deserializer).map(Some)\n}\n\n#[derive(Debug, Serialize)]\npub struct Order {\n    pub id: String,\n    pub total_minor_units: i64,\n    pub currency: String,\n    // Emitted as null when absent: the shape is stable across responses.\n    pub note: Option<String>,\n}\n\n#[derive(Debug, Deserialize, Serialize)]\npub struct Address {\n    pub line1: String,\n    pub country: String,\n}",
          "tip": "Test the three-state patch explicitly: send `{}`, `{\"note\": null}`, and `{\"note\": \"rush\"}` and assert three different outcomes."
        }
      ],
      "exercise": {
        "prompt": "Define the wire types for a refund: an opaque id, an amount in minor units with a currency, an RFC 3339 timestamp, and a status that tolerates values added by a newer server without failing the parse.",
        "starter": "use serde::{Deserialize, Serialize};\n\n#[derive(Debug, Serialize, Deserialize)]\npub struct Refund {\n    // id: opaque string\n    // amount: integer minor units + ISO 4217 currency\n    // created_at: RFC 3339 timestamp\n    // status: open enum\n}\n",
        "hint": "Use a String id, i64 minor units plus a String currency, chrono::DateTime<Utc> with the chrono feature on serde, and a custom Deserialize on the status so unknown strings become Other(String) instead of a parse error.",
        "solution": "use chrono::{DateTime, Utc};\nuse serde::{Deserialize, Deserializer, Serialize, Serializer};\n\n#[derive(Debug, Serialize, Deserialize)]\npub struct Refund {\n    pub id: String,                    // ULID: sortable, opaque, JSON-safe\n    pub amount_minor_units: i64,       // 1050 == 10.50\n    pub currency: String,              // ISO 4217, uppercase\n    pub created_at: DateTime<Utc>,     // RFC 3339 on the wire\n    pub status: RefundStatus,\n}\n\n#[derive(Debug, Clone, PartialEq, Eq)]\npub enum RefundStatus {\n    Pending,\n    Succeeded,\n    Failed,\n    Other(String),\n}\n\nimpl Serialize for RefundStatus {\n    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {\n        serializer.serialize_str(match self {\n            Self::Pending => \"pending\",\n            Self::Succeeded => \"succeeded\",\n            Self::Failed => \"failed\",\n            Self::Other(raw) => raw.as_str(),\n        })\n    }\n}\n\nimpl<'de> Deserialize<'de> for RefundStatus {\n    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {\n        let raw = String::deserialize(deserializer)?;\n        Ok(match raw.as_str() {\n            \"pending\" => Self::Pending,\n            \"succeeded\" => Self::Succeeded,\n            \"failed\" => Self::Failed,\n            _ => Self::Other(raw),\n        })\n    }\n}"
      },
      "questions": [
        {
          "q": "A response returns `\"id\": 9007199254740993`. A browser client reads it with JSON.parse. What happens?",
          "options": [
            "The value is rejected and the fetch throws a parse error",
            "The number is rounded to 9007199254740992 and the client addresses the wrong record",
            "The value arrives as a string, so it stays exact",
            "The browser throws a RangeError only when the value is used in a URL"
          ],
          "answer": 1,
          "explain": "JSON numbers become IEEE-754 doubles in JavaScript, so integers above 2^53-1 lose precision silently. Opaque string ids avoid the whole class of bug, and stop you leaking volume."
        },
        {
          "q": "Why is `total: f64` a poor wire type for money?",
          "options": [
            "JSON cannot represent floating point numbers larger than one million",
            "Binary floating point cannot represent values like 0.10 exactly, so sums drift",
            "f64 is not supported by serde_json",
            "It compresses worse than an integer"
          ],
          "answer": 1,
          "explain": "0.10 has no exact binary representation. Rounding errors accumulate across line items and tax, and reconciliation fails by cents that nobody can reproduce."
        },
        {
          "q": "With `note: Option<String>` how does the server distinguish `{}` from `{\"note\": null}`?",
          "options": [
            "It cannot; both deserialize to None, which is why a tri-state field is needed",
            "serde preserves the distinction automatically for Option fields",
            "It compares the raw body length",
            "It reads the Content-Length header"
          ],
          "answer": 0,
          "explain": "Option collapses absent and null. `Option<Option<T>>` with a deserializer that only runs when the key is present restores the three-state behaviour a PATCH needs."
        }
      ],
      "quickbytes": [
        "Ids are opaque strings; u64 above 2^53-1 silently rounds in every JavaScript client.",
        "Money is i64 minor units plus an ISO 4217 code, and the unit belongs in the field name.",
        "Write the open-enum impl by hand: serde's `other` attribute cannot express it for string enums."
      ],
      "production": [
        "Every id field is a string in the published schema, and a lint rejects integer ids.",
        "Money is validated as minor units with a currency, and no endpoint accepts floats for amounts.",
        "Timestamps are RFC 3339 with an offset; a schema test rejects integer timestamp fields.",
        "Optional response fields are uniformly present-as-null or uniformly omitted, documented in the spec.",
        "Every enum has a documented unknown-value rule for clients, tested by a fixture with an invented value."
      ],
      "crates": [
        "serde",
        "serde_json",
        "utoipa",
        "uuid"
      ],
      "github": [
        {
          "name": "serde - derive, attributes, and the open-enum escape hatch",
          "url": "https://github.com/serde-rs/serde"
        },
        {
          "name": "utoipa - schema generation from the same Rust types",
          "url": "https://github.com/juhaku/utoipa"
        }
      ],
      "pitfall": "Mixing `skip_serializing_if = \"Option::is_none\"` on some optional fields with always-present nulls on others: the same resource changes shape between responses, and a strict generated client fails the first time a field appears.",
      "resources": [
        {
          "title": "MDN: Number.MAX_SAFE_INTEGER and JSON number precision",
          "url": "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/MAX_SAFE_INTEGER",
          "kind": "docs"
        },
        {
          "title": "serde documentation: attributes, enums, and deserializers",
          "url": "https://docs.rs/serde/latest/serde/",
          "kind": "docs"
        },
        {
          "title": "utoipa ToSchema: how Rust types become JSON Schema",
          "url": "https://docs.rs/utoipa/latest/utoipa/derive.ToSchema.html",
          "kind": "docs"
        },
        {
          "title": "serde repository and attribute reference",
          "url": "https://github.com/serde-rs/serde",
          "kind": "repo"
        },
        {
          "title": "uuid crate: UUIDv7 for sortable opaque identifiers",
          "url": "https://docs.rs/uuid/latest/uuid/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "ap06",
      "title": "Error models: one envelope, stable codes",
      "minutes": 75,
      "level": "industry",
      "goal": "Ship a single problem+json error contract with machine-readable codes, field pointers, correct status mapping, and no internal detail leaking to clients.",
      "sections": [
        {
          "h": "One envelope for every failure",
          "p": [
            "Problem Details for HTTP APIs (RFC 9457) defines the shape almost everyone reinvents: `type` is a URI identifying the problem kind, `title` is a short human summary, `status` repeats the HTTP code, `detail` explains this occurrence, and `instance` points at the request. The media type is `application/problem+json`. Adopting it means clients, gateways, and support tooling parse one shape instead of one per endpoint.",
            "Two members carry the operational weight. `type` is a stable identifier that resolves to documentation, and an added `code` field gives SDKs a snake_case constant to branch on. `detail` is prose for a human and may be reworded at any time; nothing in the contract may depend on its text. Field-level failures go in an `errors` array of `{pointer, code, detail}`, where pointer is a JSON Pointer (RFC 6901) such as `/items/0/quantity`, not a bespoke path syntax."
          ],
          "list": [
            "type: https://api.acme.dev/problems/validation-failed - resolves to docs",
            "code: validation_failed - stable, greppable, safe to branch on",
            "errors[].pointer: /items/0/quantity - RFC 6901, so clients can locate the field",
            "request id: return it in x-request-id so a body stays stable and cacheable",
            "detail: human prose, never localized server-side, never parsed by clients"
          ]
        },
        {
          "h": "Mapping failures to statuses",
          "p": [
            "Malformed syntax is 400; a well-formed body that violates a rule is 422; a body that conflicts with stored state is 409. Missing or invalid credentials are 401 with `WWW-Authenticate`; authenticated-but-not-allowed is 403. A uniqueness violation is 409 with a code, never 500 - a 500 tells clients to retry and pages an engineer for a user typing a duplicate email. A downstream timeout is 504 or 503 with `Retry-After`, not 500.",
            "There is one deliberate ambiguity worth deciding in writing: for object-level authorization, 403 confirms the object exists and 404 hides it. Most public APIs return 404 for another tenant's resource to avoid an existence oracle, and document that choice. Whichever you pick, be consistent, because a client that sees both will assume the 403 path is a bug."
          ],
          "tip": "A 4xx must be actionable by the caller and a 5xx must be actionable by you. If neither is true, the status is wrong.",
          "code": "use serde::Serialize;\n\n#[derive(Debug, thiserror::Error)]\npub enum ApiError {\n    #[error(\"validation failed\")]\n    Validation(Vec<FieldError>),\n    #[error(\"not found\")]\n    NotFound,\n    #[error(\"conflict: {code}\")]\n    Conflict { code: &'static str },\n    #[error(\"rate limited\")]\n    RateLimited { retry_after_secs: u64 },\n    #[error(\"internal\")]\n    Internal,\n}\n\n#[derive(Debug, Serialize)]\npub struct FieldError {\n    pub pointer: String, // RFC 6901: /items/0/quantity\n    pub code: &'static str,\n    pub detail: String,\n}\n\n#[derive(Debug, Serialize)]\npub struct Problem {\n    #[serde(rename = \"type\")]\n    pub kind: String,\n    pub title: &'static str,\n    pub status: u16,\n    pub detail: String,\n    #[serde(skip_serializing_if = \"Vec::is_empty\")]\n    pub errors: Vec<FieldError>,\n}\n"
        },
        {
          "h": "Implementation: one enum, one conversion",
          "p": [
            "Errors become a contract at the point where a domain failure turns into bytes, so put every conversion in one `IntoResponse` impl. Handlers then return `Result<Json<T>, ApiError>` and cannot invent a different body or a 200-with-error. The database layer converts into the same enum, which is where unique-violation and foreign-key detection belongs - not in each handler.",
            "Log the cause, return the code. `tracing::error!` gets the full `sqlx::Error` with the request id attached by middleware; the response gets `type`, `code`, and a detail written for a developer at 2am. Test the mapping as data: a table of `(variant, status, code)` asserted in one unit test is what keeps a refactor from silently turning a 409 into a 500."
          ],
          "code": "use axum::http::{header, HeaderValue, StatusCode};\nuse axum::response::{IntoResponse, Response};\nuse axum::Json;\n\nimpl IntoResponse for ApiError {\n    fn into_response(self) -> Response {\n        let (status, code, title) = match &self {\n            Self::Validation(_) => (StatusCode::UNPROCESSABLE_ENTITY, \"validation_failed\", \"Validation failed\"),\n            Self::NotFound => (StatusCode::NOT_FOUND, \"not_found\", \"Resource not found\"),\n            Self::Conflict { .. } => (StatusCode::CONFLICT, \"conflict\", \"Conflicting state\"),\n            Self::RateLimited { .. } => (StatusCode::TOO_MANY_REQUESTS, \"rate_limited\", \"Too many requests\"),\n            Self::Internal => (StatusCode::INTERNAL_SERVER_ERROR, \"internal\", \"Internal error\"),\n        };\n\n        let errors = match &self {\n            Self::Validation(errors) => errors.clone(),\n            _ => Vec::new(),\n        };\n        if status.is_server_error() {\n            // The cause goes to the log with the request id, never into the body.\n            tracing::error!(error = %self, \"request failed\");\n        }\n\n        let problem = Problem {\n            kind: format!(\"https://api.acme.dev/problems/{code}\"),\n            title,\n            status: status.as_u16(),\n            detail: self.to_string(),\n            errors,\n        };\n        let mut response = Json(problem).into_response();\n        *response.status_mut() = status;\n        response.headers_mut().insert(\n            header::CONTENT_TYPE,\n            HeaderValue::from_static(\"application/problem+json\"),\n        );\n        if let Self::RateLimited { retry_after_secs } = self {\n            let value = HeaderValue::from_str(&retry_after_secs.to_string()).expect(\"digits\");\n            response.headers_mut().insert(header::RETRY_AFTER, value);\n        }\n        response\n    }\n}\n\nimpl From<sqlx::Error> for ApiError {\n    fn from(error: sqlx::Error) -> Self {\n        if let sqlx::Error::Database(db) = &error {\n            // Postgres unique_violation is a client conflict, not a server bug.\n            if db.code().as_deref() == Some(\"23505\") {\n                return Self::Conflict { code: \"already_exists\" };\n            }\n        }\n        tracing::error!(error = %error, \"database failure\");\n        Self::Internal\n    }\n}\n",
          "tip": "`detail: self.to_string()` is fine only when the Display impl never includes a database message. Keep Display for thiserror variants, and log the source separately."
        }
      ],
      "exercise": {
        "prompt": "Add a duplicate-email failure to a signup endpoint: return 409 with a stable code and a field pointer, map a malformed JSON body to 400, and make sure a database outage returns 503 with Retry-After rather than 500.",
        "starter": "use axum::http::StatusCode;\nuse axum::response::{IntoResponse, Response};\n\npub enum SignupError {\n    DuplicateEmail,\n    MalformedBody,\n    DatabaseDown,\n}\n\nimpl IntoResponse for SignupError {\n    fn into_response(self) -> Response {\n        // 409 / 400 / 503, each with a stable code and problem+json\n        todo!()\n    }\n}",
        "hint": "Duplicate email is a conflict about stored state, so 409 with a pointer at /email. Malformed JSON never reaches your handler in axum; use a custom Json extractor rejection to map it to 400. A pool timeout or connection refusal is 503 plus Retry-After: 5.",
        "solution": "use axum::http::{header, HeaderValue, StatusCode};\nuse axum::response::{IntoResponse, Response};\nuse axum::Json;\nuse serde::Serialize;\n\npub enum SignupError {\n    DuplicateEmail,\n    MalformedBody { detail: String },\n    DatabaseDown,\n}\n\n#[derive(Serialize)]\nstruct Problem {\n    #[serde(rename = \"type\")]\n    kind: String,\n    title: &'static str,\n    status: u16,\n    detail: String,\n    #[serde(skip_serializing_if = \"Option::is_none\")]\n    pointer: Option<&'static str>,\n}\n\nimpl IntoResponse for SignupError {\n    fn into_response(self) -> Response {\n        let (status, code, title, detail, pointer) = match self {\n            SignupError::DuplicateEmail => (\n                StatusCode::CONFLICT,\n                \"email_taken\",\n                \"Email already registered\",\n                \"An account with this email already exists.\".to_string(),\n                Some(\"/email\"),\n            ),\n            SignupError::MalformedBody { detail } => (\n                StatusCode::BAD_REQUEST,\n                \"malformed_body\",\n                \"Malformed request body\",\n                detail,\n                None,\n            ),\n            SignupError::DatabaseDown => (\n                StatusCode::SERVICE_UNAVAILABLE,\n                \"database_unavailable\",\n                \"Temporarily unavailable\",\n                \"Retry after the indicated delay.\".to_string(),\n                None,\n            ),\n        };\n\n        let problem = Problem {\n            kind: format!(\"https://api.acme.dev/problems/{code}\"),\n            title,\n            status: status.as_u16(),\n            detail,\n            pointer,\n        };\n\n        let mut response = Json(problem).into_response();\n        *response.status_mut() = status;\n        response.headers_mut().insert(\n            header::CONTENT_TYPE,\n            HeaderValue::from_static(\"application/problem+json\"),\n        );\n        if status == StatusCode::SERVICE_UNAVAILABLE {\n            response\n                .headers_mut()\n                .insert(header::RETRY_AFTER, HeaderValue::from_static(\"5\"));\n        }\n        response\n    }\n}"
      },
      "questions": [
        {
          "q": "Which member of a problem+json body should a generated SDK branch on?",
          "options": [
            "detail, because it explains what went wrong",
            "title, because it is stable across occurrences",
            "type (or the extension code), because it is the stable machine-readable identifier",
            "status, because it is the only member the HTTP layer validates"
          ],
          "answer": 2,
          "explain": "detail and title are prose for humans and will be reworded. type is a documented identifier and code is its constant form; those are what a client can safely switch on."
        },
        {
          "q": "A user signs up with an email that already exists. Which response is correct?",
          "options": [
            "500, because the insert threw a database error",
            "409 with code email_taken and a pointer at /email",
            "422 with detail 'internal server error'",
            "200 with {\"success\": false}"
          ],
          "answer": 1,
          "explain": "A unique violation is a conflict about stored state, so 409 with a machine-readable code. 500 tells clients to retry and pages an engineer for a normal user action."
        },
        {
          "q": "Why return 404 rather than 403 for another tenant's resource?",
          "options": [
            "404 is faster because the authorization check can be skipped",
            "404 avoids confirming that the resource exists, removing an existence oracle",
            "403 is deprecated by RFC 9457",
            "403 requires a response body while 404 does not"
          ],
          "answer": 1,
          "explain": "A 403 confirms the object exists and leaks ids across tenants. The trade-off is debuggability, so document the choice and log the denial server-side."
        }
      ],
      "quickbytes": [
        "One envelope, one IntoResponse impl: handlers return Result<_, ApiError> and cannot invent a body.",
        "Unique violation is 409, not 500; a 5xx is a promise that you are being paged.",
        "Pointers are RFC 6901 JSON Pointers so clients can highlight the exact field."
      ],
      "production": [
        "The error code catalog is generated from the enum and published next to the API docs.",
        "A table-driven test asserts status and code for every ApiError variant.",
        "No 5xx response body contains a database message, hostname, or stack trace.",
        "429 and 503 responses carry Retry-After, and clients are tested against it.",
        "x-request-id is set by middleware on every response and logged with the cause."
      ],
      "crates": [
        "axum",
        "thiserror",
        "serde",
        "sqlx"
      ],
      "github": [
        {
          "name": "http - StatusCode and header primitives",
          "url": "https://github.com/hyperium/http"
        },
        {
          "name": "axum - IntoResponse and extractor rejections",
          "url": "https://github.com/tokio-rs/axum"
        }
      ],
      "pitfall": "Returning `detail: error.to_string()` for a `sqlx::Error`: the message names the table, the constraint, and sometimes the failing value, so the body becomes both a leak and an accidental contract that clients start parsing.",
      "resources": [
        {
          "title": "MDN: HTTP status codes and their intended use",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status",
          "kind": "docs"
        },
        {
          "title": "MDN: Content-Type and media type parameters",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Type",
          "kind": "docs"
        },
        {
          "title": "axum response module: IntoResponse and response parts",
          "url": "https://docs.rs/axum/latest/axum/response/index.html",
          "kind": "docs"
        },
        {
          "title": "hyperium/http - the status type behind every response",
          "url": "https://github.com/hyperium/http",
          "kind": "repo"
        },
        {
          "title": "InfoQ: API error handling and platform reliability talks",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ap07",
      "title": "Pagination: offset, cursor, and keyset",
      "minutes": 85,
      "level": "industry",
      "goal": "Implement keyset pagination with an opaque, versioned cursor and a unique tie-breaker, and explain exactly which rows offset pagination loses.",
      "sections": [
        {
          "h": "Offset scans, and it lies",
          "p": [
            "`OFFSET 100000` asks the database to produce and discard a hundred thousand rows before it returns the first useful one. The cost grows with the page number, so the query that took 8 ms in staging times out when a customer scripts through the whole table. Page numbers also invite 'jump to page 5000' interfaces that are unusable for everyone, including the person who built them.",
            "Worse than the cost is the instability. Any insert or delete before the current window shifts every later row by one: page four repeats a row that page three already returned, and a different row is never returned at all. Offset is acceptable for small, bounded collections - an admin table, a report over a frozen snapshot - where the client genuinely needs page numbers. Say that in the documentation, and cap the offset."
          ],
          "tip": "If you cannot state whether the collection is stable during a scan, you cannot offer offset pagination."
        },
        {
          "h": "Keyset: order, compare, limit plus one",
          "p": [
            "Keyset pagination replaces the page number with a position. Order by a unique tuple, then filter with `WHERE (created_at, id) < ($1, $2)` and the same ORDER BY. A composite index seeks straight to that position, so page ten thousand costs the same as page one. The tuple must be unique: rows that share a timestamp will straddle a page boundary and be skipped or duplicated, so the tie-breaker belongs in the index, not in a comment.",
            "Fetch `LIMIT n + 1`, return n rows, and set `next_cursor` from the last returned row. The extra row is how you answer 'is there more' without a COUNT, and `has_more` is the only honest summary a cursor API can give cheaply. A total count is a full scan; if a UI insists on one, compute it approximately, cache it, and label it as an estimate."
          ],
          "list": [
            "Cursor = base64url(JSON{version, sort, directory, filter_hash, last_key...})",
            "Reject a cursor whose filter hash or sort does not match the current query: 400 invalid_cursor",
            "Version the cursor payload so you can change the shape without a new API version",
            "`next_cursor: null` must mean 'no more rows' - test that it does under concurrent writes"
          ],
          "code": "use base64::engine::general_purpose::URL_SAFE_NO_PAD;\nuse base64::Engine as _;\nuse chrono::{DateTime, Utc};\nuse serde::{Deserialize, Serialize};\n\n/// Opaque to clients: the encoding may change without a new API version.\n#[derive(Debug, Serialize, Deserialize)]\nstruct Cursor {\n    v: u8,                 // bump on shape change; stale cursors get 400\n    created_at: DateTime<Utc>,\n    id: String,\n    sort: String,          // \"created_at:desc\"\n    filter: String,        // hash of the filters this page was built with\n}\n\nfn encode(cursor: &Cursor) -> String {\n    URL_SAFE_NO_PAD.encode(serde_json::to_vec(cursor).expect(\"cursor is serializable\"))\n}\n\nfn decode(raw: &str) -> Option<Cursor> {\n    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(raw).ok()?).ok()\n}\n\n#[derive(Debug, Deserialize)]\npub struct ListQuery {\n    pub tenant_id: String,\n    pub limit: Option<u32>,\n    pub cursor: Option<String>,\n}\n\n#[derive(Debug, Serialize)]\npub struct Page<T> {\n    pub data: Vec<T>,\n    pub next_cursor: Option<String>,\n    pub has_more: bool,\n}"
        },
        {
          "h": "The query behind the cursor",
          "p": [
            "The cursor is opaque so clients cannot build one by hand, and versioned so a schema change produces a clean 400 rather than a confusing page. The filter hash is what catches the common client bug of paginating while changing the filter - without it, page two silently mixes two different result sets and the user sees duplicates that no amount of retrying fixes.",
            "Known limits worth documenting: a cursor over a read replica can serve a page from a lagging snapshot; a cursor over a mutable sort key (like `total_minor_units`) can repeat rows when a value changes mid-scan; and a cursor with no retention statement becomes a support ticket when someone resumes a week later."
          ],
          "code": "use axum::extract::{Query, State};\nuse axum::http::StatusCode;\nuse axum::response::{IntoResponse, Response};\nuse axum::Json;\nuse sqlx::PgPool;\n\npub async fn list_orders(State(pool): State<PgPool>, Query(query): Query<ListQuery>) -> Response {\n    let limit = query.limit.unwrap_or(20).clamp(1, 100) as i64;\n    let filter = filter_hash(&query.tenant_id);\n\n    let after = match query.cursor.as_deref().map(decode) {\n        Some(Some(cursor))\n            if cursor.v == 1 && cursor.sort == \"created_at:desc\" && cursor.filter == filter =>\n        {\n            Some(cursor)\n        }\n        Some(_) => return StatusCode::BAD_REQUEST.into_response(), // invalid_cursor\n        None => None,\n    };\n\n    // LIMIT n+1 answers \"is there another page\" without a COUNT(*).\n    let rows = sqlx::query_as::<_, OrderRow>(\n        r#\"SELECT id, created_at, total_minor_units, currency\n             FROM orders\n            WHERE tenant_id = $1\n              AND ($2::timestamptz IS NULL OR (created_at, id) < ($2, $3))\n            ORDER BY created_at DESC, id DESC\n            LIMIT $4\"#,\n    )\n    .bind(&query.tenant_id)\n    .bind(after.as_ref().map(|cursor| cursor.created_at))\n    .bind(after.as_ref().map(|cursor| cursor.id.clone()))\n    .bind(limit + 1)\n    .fetch_all(&pool)\n    .await;\n\n    let Ok(mut rows) = rows else {\n        return StatusCode::INTERNAL_SERVER_ERROR.into_response();\n    };\n    let has_more = rows.len() as i64 > limit;\n    rows.truncate(limit as usize);\n    let next_cursor = rows.last().map(|row| {\n        encode(&Cursor {\n            v: 1,\n            created_at: row.created_at,\n            id: row.id.clone(),\n            sort: \"created_at:desc\".to_string(),\n            filter,\n        })\n    });\n\n    Json(Page { data: rows, next_cursor, has_more }).into_response()\n}",
          "tip": "Keep the cursor out of the URL path. It belongs in the query string so it is cacheable per page and never logged as part of the route."
        }
      ],
      "exercise": {
        "prompt": "Write the cursor type and the list handler for orders ordered by created_at descending, including a tie-breaker, a has_more flag computed without COUNT, and a 400 for a cursor built with a different filter.",
        "starter": "use serde::{Deserialize, Serialize};\nuse sqlx::PgPool;\n\n#[derive(Serialize, Deserialize)]\nstruct Cursor {\n    // version, created_at, id, sort, filter hash\n}\n\npub async fn list(pool: &PgPool, tenant: &str, cursor: Option<String>) -> Result<(), sqlx::Error> {\n    // 1. decode and validate the cursor\n    // 2. SELECT ... WHERE (created_at, id) < ($2, $3) ORDER BY created_at DESC, id DESC LIMIT n+1\n    todo!()\n}",
        "hint": "Bind the cursor values as nullable parameters so the first page needs no special SQL branch, fetch limit + 1 rows, truncate to limit, and build next_cursor from the last row you actually returned.",
        "solution": "use base64::engine::general_purpose::URL_SAFE_NO_PAD;\nuse base64::Engine as _;\nuse chrono::{DateTime, Utc};\nuse serde::{Deserialize, Serialize};\nuse sqlx::PgPool;\n\n#[derive(Debug, Serialize, Deserialize)]\npub struct Cursor {\n    pub v: u8,\n    pub created_at: DateTime<Utc>,\n    pub id: String,\n    pub filter: String,\n}\n\npub struct Page<T> {\n    pub data: Vec<T>,\n    pub next_cursor: Option<String>,\n    pub has_more: bool,\n}\n\nimpl Cursor {\n    pub fn encode(&self) -> String {\n        URL_SAFE_NO_PAD.encode(serde_json::to_vec(self).expect(\"serializable\"))\n    }\n\n    pub fn decode(raw: &str) -> Option<Self> {\n        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(raw).ok()?).ok()\n    }\n}\n\npub async fn list(\n    pool: &PgPool,\n    tenant: &str,\n    cursor: Option<String>,\n    limit: i64,\n) -> Result<Page<OrderRow>, sqlx::Error> {\n    let filter = filter_hash(tenant);\n    let after = match cursor.as_deref().map(Cursor::decode) {\n        Some(Some(c)) if c.v == 1 && c.filter == filter => Some(c),\n        Some(_) => return Ok(Page { data: Vec::new(), next_cursor: None, has_more: false }),\n        None => None,\n    };\n\n    let mut rows = sqlx::query_as::<_, OrderRow>(\n        r#\"SELECT id, created_at, total_minor_units, currency\n             FROM orders\n            WHERE tenant_id = $1\n              AND ($2::timestamptz IS NULL OR (created_at, id) < ($2, $3))\n            ORDER BY created_at DESC, id DESC\n            LIMIT $4\"#,\n    )\n    .bind(tenant)\n    .bind(after.as_ref().map(|c| c.created_at))\n    .bind(after.as_ref().map(|c| c.id.clone()))\n    .bind(limit + 1)\n    .fetch_all(pool)\n    .await?;\n\n    let has_more = rows.len() as i64 > limit;\n    rows.truncate(limit as usize);\n    let next_cursor = rows.last().map(|row| {\n        Cursor {\n            v: 1,\n            created_at: row.created_at,\n            id: row.id.clone(),\n            filter: filter.clone(),\n        }\n        .encode()\n    });\n\n    Ok(Page { data: rows, next_cursor, has_more })\n}"
      },
      "questions": [
        {
          "q": "A client paginates a live feed with OFFSET. Why does it see the same row twice?",
          "options": [
            "The database reuses row versions after an update",
            "An insert or delete before the current window shifts every later row by one",
            "OFFSET is applied before the ORDER BY, so ordering is unstable",
            "The HTTP cache serves the previous page for the next offset"
          ],
          "answer": 1,
          "explain": "Offset counts rows in the current result set. Rows entering or leaving before the window move every later row, so page boundaries no longer align and rows repeat or vanish."
        },
        {
          "q": "Why must the keyset tuple include a unique tie-breaker such as id?",
          "options": [
            "The database requires an ORDER BY clause to be unique",
            "Rows sharing the sort value have no defined order, so they can be skipped or repeated at a page boundary",
            "It makes the composite index smaller",
            "It lets clients build the cursor themselves"
          ],
          "answer": 1,
          "explain": "A non-unique sort key leaves ties unordered between queries. With a strict comparison on that key, every tied row on the boundary is either returned twice or never returned."
        },
        {
          "q": "A cursor was issued for a query with filter status=paid, and is now sent with status=refunded. What should happen?",
          "options": [
            "Return page one of the new filter, silently ignoring the cursor",
            "Return 400 invalid_cursor, because the cursor does not describe this query",
            "Return 409 and ask the client to retry with a fresh cursor",
            "Accept it and continue from the stored position, mixing both result sets"
          ],
          "answer": 1,
          "explain": "A cursor is a position inside one specific result set. Applying it to a different filter produces gaps and duplicates that look like data loss, so reject it explicitly."
        }
      ],
      "quickbytes": [
        "Keyset pagination: ORDER BY a unique tuple, compare with a row constructor, fetch LIMIT n+1.",
        "Cursor payload: version, sort, filter hash, last key - base64url encoded and opaque.",
        "has_more is free; total_count is a table scan. Do not put a COUNT(*) on a hot list endpoint."
      ],
      "production": [
        "Every list endpoint documents order, tie-breaker, default limit, maximum limit, and cursor retention.",
        "Invalid or stale cursors return 400 with code invalid_cursor, never a silently wrong page.",
        "The keyset query is verified with EXPLAIN to use the composite index rather than a sort.",
        "Pagination tests cover rows with identical timestamps and concurrent inserts between pages.",
        "No list endpoint exposes an unbounded limit, and clamping is visible in the response."
      ],
      "crates": [
        "sqlx",
        "base64",
        "serde",
        "serde_json"
      ],
      "github": [
        {
          "name": "sqlx - row types, query_as, and Postgres binds",
          "url": "https://github.com/transact-rs/sqlx"
        },
        {
          "name": "axum - Query extractor and response types",
          "url": "https://github.com/tokio-rs/axum"
        }
      ],
      "pitfall": "A cursor that stores only `created_at`: rows sharing a timestamp straddle every page boundary, so some orders are returned on two consecutive pages and others are never returned at all, and no test notices because fixtures use distinct timestamps.",
      "resources": [
        {
          "title": "MDN: Link header and rel=next pagination",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Link",
          "kind": "docs"
        },
        {
          "title": "sqlx crate documentation",
          "url": "https://docs.rs/sqlx/latest/sqlx/",
          "kind": "docs"
        },
        {
          "title": "axum extract module: Query and path parameters",
          "url": "https://docs.rs/axum/latest/axum/extract/index.html",
          "kind": "docs"
        },
        {
          "title": "sqlx repository: Postgres type mappings and query macros",
          "url": "https://github.com/transact-rs/sqlx",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "ap08",
      "title": "Filtering, sorting, and sparse fields",
      "minutes": 70,
      "level": "industry",
      "goal": "Design a filter grammar that is documented, indexed, and impossible to inject through, and decide when a field list is worth the cache-key complexity.",
      "sections": [
        {
          "h": "A grammar small enough to document",
          "p": [
            "Pick the syntax once and write it down: repeated parameters for OR sets (`status=paid&status=refunded`), suffixed comparisons for ranges (`created_after`, `created_before`), `sort=-created_at` for order, and `fields=id,total` for sparsecity. Repeated parameters compose with every HTTP client and sidestep the escaping problem of comma-separated values that can themselves contain commas.",
            "Every filter needs four documented facts: its type, its allowed values, whether an index backs it, and what happens when it is not indexed. A filter that forces a sequential scan over fifty million rows is an outage waiting for a popular dashboard, so either add the index, restrict the time range, or reject the parameter with 400 and say why."
          ],
          "list": [
            "Repeated parameters for OR sets, suffixed names for ranges, one sort parameter with a sign",
            "Bound and documented defaults for limit, sort, and time range",
            "A 400 that names the offending parameter and lists the valid values",
            "An allowlist of sortable and filterable fields, checked before any SQL is built"
          ],
          "code": "use chrono::{DateTime, Utc};\nuse serde::Deserialize;\n\n#[derive(Debug, Clone, Copy, Deserialize)]\n#[serde(rename_all = \"snake_case\")]\npub enum SortBy { CreatedAt, Total, Status }\n\n#[derive(Debug, Clone, Copy, Deserialize)]\n#[serde(rename_all = \"lowercase\")]\npub enum Direction { Asc, Desc }\n\n#[derive(Debug, Deserialize)]\npub struct OrderQuery {\n    #[serde(default)]\n    pub status: Vec<String>, // repeated: ?status=paid&status=refunded\n    pub created_after: Option<DateTime<Utc>>,\n    pub created_before: Option<DateTime<Utc>>,\n    pub sort: Option<SortBy>,\n    pub order: Option<Direction>,\n    pub limit: Option<u32>,\n    pub fields: Option<String>, // \"id,total_minor_units\"\n}\n\npub fn validate(query: &OrderQuery) -> Result<(), String> {\n    const ALLOWED_FIELDS: [&str; 4] = [\"id\", \"status\", \"total_minor_units\", \"created_at\"];\n    if let Some(fields) = &query.fields {\n        let unknown: Vec<&str> = fields\n            .split(',')\n            .map(str::trim)\n            .filter(|field| !ALLOWED_FIELDS.contains(field))\n            .collect();\n        if !unknown.is_empty() {\n            return Err(format!(\"unknown fields: {unknown:?}\"));\n        }\n    }\n    if query.limit.unwrap_or(25) > 100 {\n        return Err(\"limit must be <= 100\".to_string());\n    }\n    Ok(())\n}"
        },
        {
          "h": "Never interpolate, always map",
          "p": [
            "Bound parameters cannot be identifiers. `ORDER BY $1` is a syntax error, and `format!` with a client-supplied column is injection with extra steps. The safe pattern is an exhaustive match from a deserialized enum to a `&'static str`: the compiler then forces you to handle a new sort option instead of silently emitting a query that sorts by nothing.",
            "The same reasoning applies to operators. Do not accept `filter=total>100` and parse the comparison; expose `min_total` and `max_total` and bind the values. Structured parameters are easier to validate, easier to document, and cannot smuggle a semicolon through a numeric field. Log the rejected parameter name, not just 'bad request'."
          ],
          "code": "use axum::extract::{Query, State};\nuse axum::http::StatusCode;\nuse axum::response::{IntoResponse, Response};\nuse axum::Json;\nuse sqlx::{PgPool, Postgres, QueryBuilder};\n\n/// Static SQL fragments only: client input never reaches the ORDER BY text.\nfn order_by(sort: Option<SortBy>, direction: Option<Direction>) -> &'static str {\n    match (sort.unwrap_or(SortBy::CreatedAt), direction.unwrap_or(Direction::Desc)) {\n        (SortBy::CreatedAt, Direction::Desc) => \"created_at DESC, id DESC\",\n        (SortBy::CreatedAt, Direction::Asc) => \"created_at ASC, id ASC\",\n        (SortBy::Total, Direction::Desc) => \"total_minor_units DESC, id DESC\",\n        (SortBy::Total, Direction::Asc) => \"total_minor_units ASC, id ASC\",\n        (SortBy::Status, Direction::Desc) => \"status DESC, id DESC\",\n        (SortBy::Status, Direction::Asc) => \"status ASC, id ASC\",\n    }\n}\n\npub async fn list_orders(\n    State(pool): State<PgPool>,\n    principal: Principal,\n    Query(query): Query<OrderQuery>,\n) -> Response {\n    if let Err(message) = validate(&query) {\n        return (StatusCode::BAD_REQUEST, message).into_response();\n    }\n\n    let limit = query.limit.unwrap_or(25).clamp(1, 100) as i64;\n    let mut builder = QueryBuilder::<Postgres>::new(\n        \"SELECT id, status, total_minor_units, currency, created_at FROM orders WHERE tenant_id = \",\n    );\n    builder.push_bind(principal.tenant_id.as_str());\n    if !query.status.is_empty() {\n        builder.push(\" AND status = ANY(\").push_bind(&query.status).push(\")\");\n    }\n    if let Some(after) = query.created_after {\n        builder.push(\" AND created_at >= \").push_bind(after);\n    }\n    if let Some(before) = query.created_before {\n        builder.push(\" AND created_at < \").push_bind(before);\n    }\n    builder.push(\" ORDER BY \").push(order_by(query.sort, query.order));\n    builder.push(\" LIMIT \").push_bind(limit + 1);\n\n    match builder.build_query_as::<OrderRow>().fetch_all(&pool).await {\n        Ok(rows) => Json(rows).into_response(),\n        Err(error) => error.into_response(),\n    }\n}",
          "tip": "A rejected parameter should name itself and list the valid values. 'invalid request' turns a five-second fix into a support ticket."
        },
        {
          "h": "Sparse fieldsets and the cache-key tax",
          "p": [
            "`fields=id,total,currency` shrinks payloads and serialization time, and it is genuinely useful on wide resources. The cost is that the response schema now varies per request, which confuses naive generated clients and multiplies the cache-key space: every distinct field list is a separate entry, so a CDN hit rate falls as clients pick different subsets.",
            "Two rules keep it sane. Always include the identifying fields (`id`, and `type` on a polymorphic resource) regardless of the list, and cap the number of fields. If your consumers mostly want two or three combinations, offer named views - `view=summary|detail` - instead of an open field list; the cache stays warm and the contract stays enumerable."
          ],
          "tip": "Sparse fieldsets are a bandwidth optimisation, not an authorization mechanism. Fields the caller may not see must be removed by policy, not by omission."
        }
      ],
      "exercise": {
        "prompt": "Add sorting by total and status to an orders list: validate the sort parameter against an enum, keep the id tie-breaker, reject unknown fields with a message naming them, and clamp the limit to 100.",
        "starter": "use serde::Deserialize;\n\n#[derive(Debug, Clone, Copy, Deserialize)]\n#[serde(rename_all = \"snake_case\")]\npub enum SortBy { CreatedAt, Total, Status }\n\n#[derive(Debug, Clone, Copy, Deserialize)]\n#[serde(rename_all = \"lowercase\")]\npub enum Direction { Asc, Desc }\n\npub fn order_by(sort: SortBy, direction: Direction) -> &'static str {\n    // one arm per combination, every one ending with the id tie-breaker\n    todo!()\n}",
        "hint": "Deserialize into an enum with serde's rename_all so unknown values are rejected during extraction, then match the enum to a &'static str. Always append `, id DESC` so equal values have a total order.",
        "solution": "use serde::Deserialize;\n\n#[derive(Debug, Clone, Copy, Deserialize)]\n#[serde(rename_all = \"snake_case\")]\npub enum SortBy {\n    CreatedAt,\n    Total,\n    Status,\n}\n\n#[derive(Debug, Clone, Copy, Deserialize)]\n#[serde(rename_all = \"lowercase\")]\npub enum Direction {\n    Asc,\n    Desc,\n}\n\n#[derive(Debug, Deserialize)]\npub struct Query {\n    pub sort: Option<SortBy>,\n    pub order: Option<Direction>,\n    pub limit: Option<u32>,\n}\n\npub fn order_by(sort: SortBy, direction: Direction) -> &'static str {\n    match (sort, direction) {\n        (SortBy::CreatedAt, Direction::Desc) => \"created_at DESC, id DESC\",\n        (SortBy::CreatedAt, Direction::Asc) => \"created_at ASC, id ASC\",\n        (SortBy::Total, Direction::Desc) => \"total_minor_units DESC, id DESC\",\n        (SortBy::Total, Direction::Asc) => \"total_minor_units ASC, id ASC\",\n        (SortBy::Status, Direction::Desc) => \"status DESC, id DESC\",\n        (SortBy::Status, Direction::Asc) => \"status ASC, id ASC\",\n    }\n}\n\npub fn clamped_limit(limit: Option<u32>) -> i64 {\n    limit.unwrap_or(25).clamp(1, 100) as i64\n}"
      },
      "questions": [
        {
          "q": "Why can't ORDER BY be fixed by binding a parameter?",
          "options": [
            "Postgres does not allow parameters in any clause after WHERE",
            "A bound parameter is a value; a column name is an identifier, so it must come from a static allowlist",
            "Binding is slower than string interpolation for sorting",
            "ORDER BY parameters only work with prepared statements"
          ],
          "answer": 1,
          "explain": "Parameters substitute values, never syntax. The only safe route from client input to an identifier is an exhaustive match to a static string, which also gives you compile-time coverage of new sort options."
        },
        {
          "q": "Why prefer repeated parameters (`status=a&status=b`) over a comma-separated value?",
          "options": [
            "Repeated parameters are compressed better by HTTP/2",
            "Every HTTP client already encodes them, and values containing commas stay unambiguous",
            "Comma-separated values cannot be cached",
            "Repeated parameters are required by RFC 9457"
          ],
          "answer": 1,
          "explain": "CSV needs an escaping rule the moment a value can contain a comma, and every client invents a different one. Repeated parameters delegate encoding to the client library."
        },
        {
          "q": "A filter parameter has no supporting index on a 50M row table. What is the responsible choice?",
          "options": [
            "Ship it and let the query planner decide at runtime",
            "Index it, restrict it to a bounded range, or reject it with a documented 400",
            "Cache the result for an hour and accept the first slow call",
            "Move the filter to the request body so it is not logged"
          ],
          "answer": 1,
          "explain": "An unindexed public filter lets one client scan the table at will. Index it, bound it, or refuse it - but decide deliberately and say so in the docs."
        }
      ],
      "quickbytes": [
        "Map client sort input through an enum to a static SQL fragment; never format an identifier.",
        "Always add an id tie-breaker so equal sort values have a total order.",
        "Sparse fieldsets multiply cache keys; consider named views before an open field list."
      ],
      "production": [
        "Every filterable and sortable field is documented with its index status.",
        "Unknown filter or sort values return 400 naming the parameter and the valid values.",
        "The generated SQL for each sort/filter combination is covered by a query-plan test.",
        "Limit is clamped server-side and the effective limit is echoed in the response.",
        "Fields the caller may not see are removed by policy, never by client omission."
      ],
      "crates": [
        "sqlx",
        "serde",
        "axum",
        "chrono"
      ],
      "github": [
        {
          "name": "sqlx - QueryBuilder and Postgres array binds",
          "url": "https://github.com/transact-rs/sqlx"
        },
        {
          "name": "axum - Query extractor with serde deserialization",
          "url": "https://github.com/tokio-rs/axum"
        }
      ],
      "pitfall": "Accepting `sort` as a raw string and formatting it into `ORDER BY`: an attacker sends `sort=id; DROP TABLE orders--`, and even without that, an unhandled value produces a query with no ordering at all, so pagination silently becomes random.",
      "resources": [
        {
          "title": "sqlx crate documentation",
          "url": "https://docs.rs/sqlx/latest/sqlx/",
          "kind": "docs"
        },
        {
          "title": "axum extract module: typed query parameters",
          "url": "https://docs.rs/axum/latest/axum/extract/index.html",
          "kind": "docs"
        },
        {
          "title": "sqlx repository: QueryBuilder and array encoding",
          "url": "https://github.com/transact-rs/sqlx",
          "kind": "repo"
        },
        {
          "title": "ByteByteGo: database indexing and query planning explainers",
          "url": "https://www.youtube.com/@ByteByteGo",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ap09",
      "title": "Idempotency keys and safe retries",
      "minutes": 95,
      "level": "industry",
      "goal": "Make POST safe to retry by storing a keyed response, rejecting payload reuse, and knowing precisely which failures a client may retry.",
      "sections": [
        {
          "h": "The ambiguous timeout",
          "p": [
            "A client POSTs a payment; the connection dies after thirty seconds with no response. The client cannot conclude the write failed, because no response is not a failure and a 504 from a proxy does not mean the server did nothing. Retrying may double-charge; not retrying may lose the order. Nothing on the server side can fix this without a key the client controls.",
            "The key turns the second attempt into a lookup. `Idempotency-Key` carries a client-generated value, documented with its scope, lifetime, and replay behaviour. GET, PUT, and DELETE do not need it - they are already defined as idempotent - so the header is for POST and for PATCH requests that replay a list of operations."
          ],
          "tip": "If your POST can charge a card, create a shipment, or send an email, it needs an idempotency story before it needs a rate limit."
        },
        {
          "h": "What the server stores, and the four outcomes",
          "p": [
            "One row per (scope, key) holds the key, the tenant, a fingerprint of the request, a state, the stored status and body, and timestamps. `UNIQUE(scope, key)` is the concurrency control: the insert either claims the key or reveals that somebody else already holds it, and no advisory lock is required to get that right.",
            "There are exactly four outcomes. No row: execute and record. Row in flight: return 409 with `Retry-After` so the client does not run the operation twice. Row completed with the same fingerprint: replay the stored status and body, and mark it with `Idempotent-Replayed: true`. Row with a different fingerprint: refuse with 422 and code `idempotency_key_reuse`, because reusing a key for a different payload is a client bug that must never be silently executed."
          ],
          "list": [
            "Scope the key to (account, endpoint) so two endpoints cannot collide",
            "Fingerprint = method + path + hash of the raw body; store the hash, not the body",
            "Store the response in the same transaction as the effect, or a crash between them re-executes",
            "TTL of 24 hours covers retries and reloads; purge expired rows in a background job"
          ],
          "code": "use sqlx::PgPool;\n\npub enum Begin {\n    /// Key is new: this caller owns the operation and must complete it.\n    Fresh,\n    /// Completed earlier with an identical request: replay the stored response.\n    Replay { status: u16, body: serde_json::Value },\n    /// Another request with this key is still running.\n    InFlight,\n    /// Same key, different payload: a client bug, never executed.\n    Mismatch,\n}\n\npub async fn begin(\n    pool: &PgPool,\n    scope: &str,\n    key: &str,\n    fingerprint: &str,\n) -> sqlx::Result<Begin> {\n    // The unique index on (scope, key) is the whole concurrency control.\n    let inserted = sqlx::query(\n        r#\"INSERT INTO idempotency_keys (scope, key, fingerprint, state)\n           VALUES ($1, $2, $3, 'in_flight')\n           ON CONFLICT (scope, key) DO NOTHING\"#,\n    )\n    .bind(scope)\n    .bind(key)\n    .bind(fingerprint)\n    .execute(pool)\n    .await?\n    .rows_affected();\n\n    if inserted == 1 {\n        return Ok(Begin::Fresh);\n    }\n\n    let row: (String, String, Option<i16>, Option<serde_json::Value>) = sqlx::query_as(\n        \"SELECT fingerprint, state, status, body FROM idempotency_keys WHERE scope = $1 AND key = $2\",\n    )\n    .bind(scope)\n    .bind(key)\n    .fetch_one(pool)\n    .await?;\n\n    if row.0 != fingerprint {\n        return Ok(Begin::Mismatch);\n    }\n    match (row.2, row.3) {\n        (Some(status), Some(body)) => Ok(Begin::Replay { status: status as u16, body }),\n        _ => Ok(Begin::InFlight),\n    }\n}"
        },
        {
          "h": "Recording the response atomically",
          "p": [
            "The effect and the record must commit together. If the charge commits and the process dies before the response row is updated, the retry finds an in-flight row that never resolves, or an expired key that executes again - and the customer is charged twice by a system that looked correct in every unit test it had.",
            "Two guards make the record safe. The completion update fires only while the row is still in flight, so a duplicate completion cannot overwrite a response that a client may already have replayed. And the in-flight state needs an expiry, because a crashed process otherwise holds the key forever; a sweeper that expires rows older than a few minutes returns them to a retryable state instead of a permanent 409."
          ],
          "code": "/// Called inside the same transaction that performs the effect.\npub async fn complete(\n    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,\n    scope: &str,\n    key: &str,\n    status: u16,\n    body: &serde_json::Value,\n) -> sqlx::Result<()> {\n    // Only an in-flight row may be completed: a duplicate completion must not\n    // overwrite the response that clients may already have replayed.\n    sqlx::query(\n        r#\"UPDATE idempotency_keys\n              SET state = 'completed', status = $3, body = $4, completed_at = now()\n            WHERE scope = $1 AND key = $2 AND state = 'in_flight'\"#,\n    )\n    .bind(scope)\n    .bind(key)\n    .bind(status as i16)\n    .bind(body)\n    .execute(&mut **tx)\n    .await?;\n    Ok(())\n}",
          "tip": "Expire in-flight rows, not completed ones. A key that completed is worth replaying for the full TTL; a key stuck in flight is worth forgetting quickly."
        },
        {
          "h": "Client side, where most of it goes wrong",
          "p": [
            "The key is generated once per logical operation, before the first attempt, and reused for every retry. Generating it inside the retry loop - the default in several HTTP clients - makes each attempt unique and removes the protection entirely, while the code still looks correct. SDKs should accept a key from the caller or derive it from a stable operation id such as the cart id plus a timestamp bucket.",
            "Retry only what is safe to retry: connection errors, timeouts, 429, 503, and 5xx *when the request carries a key*. Never retry 400, 401, 403, 404, 409, or 422 - they are deterministic for that payload. Cap attempts at three or four, honour `Retry-After`, add full jitter, and keep the whole sequence inside the user's deadline rather than the client's default."
          ],
          "tip": "Return 409 for in-flight instead of blocking. A held connection per duplicate is how one stuck request becomes a thread-pool outage."
        }
      ],
      "exercise": {
        "prompt": "Implement the replay path of a POST /v1/payments handler: claim the key, reject a payload mismatch, replay a stored response with Idempotent-Replayed, and return 409 for an in-flight duplicate.",
        "starter": "use axum::http::StatusCode;\nuse axum::response::{IntoResponse, Response};\n\npub async fn create_payment(key: &str, fingerprint: &str, body: serde_json::Value) -> Response {\n    match begin(pool(), \"payments\", key, fingerprint).await {\n        // four outcomes, four responses\n        todo!()\n    }\n}",
        "hint": "Fresh executes and then calls complete in the same transaction. Replay returns the stored status and body plus an Idempotent-Replayed header. InFlight returns 409 with Retry-After: 1. Mismatch returns 422 with code idempotency_key_reuse.",
        "solution": "use axum::http::{header, HeaderValue, StatusCode};\nuse axum::response::{IntoResponse, Response};\nuse axum::Json;\n\npub async fn create_payment(\n    pool: &sqlx::PgPool,\n    key: &str,\n    fingerprint: &str,\n    body: serde_json::Value,\n) -> Response {\n    match begin(pool, \"payments\", key, fingerprint).await {\n        Ok(Begin::Fresh) => {\n            let mut tx = match pool.begin().await {\n                Ok(tx) => tx,\n                Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),\n            };\n            // Charge and record the response in one transaction: a crash\n            // between them would let a retry charge twice.\n            let charge = charge_card(&mut tx, &body).await;\n            let Ok(response_body) = charge else {\n                return StatusCode::PAYMENT_REQUIRED.into_response();\n            };\n            let status = 201u16;\n            if complete_in_tx(&mut tx, \"payments\", key, status, &response_body).await.is_err() {\n                return StatusCode::INTERNAL_SERVER_ERROR.into_response();\n            }\n            if tx.commit().await.is_err() {\n                return StatusCode::INTERNAL_SERVER_ERROR.into_response();\n            }\n            (StatusCode::CREATED, Json(response_body)).into_response()\n        }\n        Ok(Begin::Replay { status, body }) => {\n            let mut response = Json(body).into_response();\n            *response.status_mut() =\n                StatusCode::from_u16(status).unwrap_or(StatusCode::OK);\n            response.headers_mut().insert(\n                \"idempotent-replayed\",\n                HeaderValue::from_static(\"true\"),\n            );\n            response\n        }\n        Ok(Begin::InFlight) => {\n            let mut response = StatusCode::CONFLICT.into_response();\n            response\n                .headers_mut()\n                .insert(header::RETRY_AFTER, HeaderValue::from_static(\"1\"));\n            response\n        }\n        Ok(Begin::Mismatch) => (\n            StatusCode::UNPROCESSABLE_ENTITY,\n            Json(serde_json::json!({\n                \"type\": \"https://api.acme.dev/problems/idempotency_key_reuse\",\n                \"title\": \"Idempotency key reused with a different payload\",\n                \"status\": 422\n            })),\n        )\n            .into_response(),\n        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),\n    }\n}\n\nasync fn complete_in_tx(\n    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,\n    scope: &str,\n    key: &str,\n    status: u16,\n    body: &serde_json::Value,\n) -> Result<(), sqlx::Error> {\n    sqlx::query(\n        r#\"UPDATE idempotency_keys\n              SET state = 'completed', status = $3, body = $4, completed_at = now()\n            WHERE scope = $1 AND key = $2\"#,\n    )\n    .bind(scope)\n    .bind(key)\n    .bind(status as i16)\n    .bind(body)\n    .execute(&mut **tx)\n    .await?;\n    Ok(())\n}\n\nasync fn charge_card(\n    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,\n    body: &serde_json::Value,\n) -> Result<serde_json::Value, sqlx::Error> {\n    let _ = (tx, body);\n    Ok(serde_json::json!({ \"id\": \"pay_1\", \"status\": \"succeeded\" }))\n}"
      },
      "questions": [
        {
          "q": "A POST /payments times out at the client. The retry arrives with the same key, but the server had already charged and failed to send the response. What must the server do?",
          "options": [
            "Charge again, then detect the duplicate during reconciliation",
            "Replay the stored 201 and body without executing the charge again",
            "Return 409 because the key was already used",
            "Return 500 so the client knows the outcome is unknown"
          ],
          "answer": 1,
          "explain": "That is exactly the case the store exists for: the key completed, so the recorded response is the truth. Charging again is the double-charge the header was meant to prevent."
        },
        {
          "q": "The same key arrives with a different request body. What is the correct behaviour?",
          "options": [
            "Execute it, since the key is only a hint",
            "Replay the earlier response as if the bodies matched",
            "Reject with 422 and a stable idempotency_key_reuse code, executing nothing",
            "Overwrite the stored response with the new one"
          ],
          "answer": 2,
          "explain": "A key identifies one logical operation. Reusing it for a different payload is a client bug; silently executing or silently replaying both hide it until the data is already wrong."
        },
        {
          "q": "Where should an SDK generate the idempotency key?",
          "options": [
            "Inside the retry loop, once per attempt, using a fresh UUID",
            "Once per logical operation, before the first attempt, reused across all retries",
            "On the server, derived from the request body hash",
            "Only when the client library detects a network error"
          ],
          "answer": 1,
          "explain": "A new key per attempt makes every retry a new operation, which is the failure the header exists to prevent. The caller or the SDK's operation wrapper must own the key's lifetime."
        }
      ],
      "quickbytes": [
        "UNIQUE(scope, key) plus ON CONFLICT DO NOTHING is the whole concurrency control for idempotency.",
        "Four outcomes: fresh, replay, in-flight 409, payload mismatch 422. Never a fifth 'execute again anyway'.",
        "Record the response inside the same transaction as the effect, or a crash reopens the double-charge window."
      ],
      "production": [
        "Every non-idempotent endpoint documents whether it accepts Idempotency-Key and how long keys are retained.",
        "Replays return the original status and body plus Idempotent-Replayed: true, so clients can log them.",
        "Expired keys are purged by a scheduled job and the retention window is published.",
        "The client retry policy is tested to reuse the key across attempts and to honour Retry-After.",
        "Request fingerprints are stored as hashes, so the table never holds card data or personal information."
      ],
      "crates": [
        "sqlx",
        "uuid",
        "serde_json",
        "sha2"
      ],
      "github": [
        {
          "name": "sqlx - transactions and ON CONFLICT handling",
          "url": "https://github.com/transact-rs/sqlx"
        },
        {
          "name": "stripe/openapi - a large public API that documents idempotency keys",
          "url": "https://github.com/stripe/openapi"
        }
      ],
      "pitfall": "Generating the idempotency key inside the SDK's retry loop: every attempt carries a new key, the server sees three unrelated operations, and the customer is charged three times by code that looks like it implements retries correctly.",
      "resources": [
        {
          "title": "MDN: Idempotency-Key header",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Idempotency-Key",
          "kind": "docs"
        },
        {
          "title": "stripe/openapi - idempotency documented in a real public contract",
          "url": "https://github.com/stripe/openapi",
          "kind": "repo"
        },
        {
          "title": "sqlx crate documentation: transactions and query_as",
          "url": "https://docs.rs/sqlx/latest/sqlx/",
          "kind": "docs"
        },
        {
          "title": "InfoQ: payments, retries, and exactly-once architecture talks",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ap10",
      "title": "Versioning and compatibility",
      "minutes": 90,
      "level": "industry",
      "goal": "Choose a versioning scheme for your audience, define breaking change precisely, and run two wire shapes over one domain model without forking the codebase.",
      "sections": [
        {
          "h": "Three schemes and what each one costs",
          "p": [
            "A path version (`/v1`) is visible in access logs, CDN rules, gateway routing, and every curl example. It costs duplicate route trees and a v1 that nobody wants to touch. A media-type version (`Accept: application/vnd.acme.v2+json`) keeps URIs clean and versions individual requests, but it is invisible in dashboards, needs `Vary: Accept` on every cache, and silently serves v1 to any client that forgets the header.",
            "A date-based version pins each account to a behaviour snapshot, so changes ship behind a per-tenant switch instead of a new URL. That is the most flexible and the most expensive: the compatibility layer never dies and the test matrix becomes version times endpoint. Choose by audience. Public developers who paste curl commands want a path; internal services with generated clients want additive evolution and a proto package bump."
          ],
          "list": [
            "Path: simplest routing and observability, most visible to users, easiest to document",
            "Media type: cleanest URIs, hardest to see in logs and to route at the edge",
            "Date-based: finest control, permanent compatibility code and a combinatorial test matrix",
            "None: only viable when every client is generated from your schema and deployed on your schedule"
          ],
          "tip": "Version the API, not the deployment. A v2 that reuses the v1 database columns is a facade; a v2 with its own writer is a migration."
        },
        {
          "h": "Define breaking precisely, then write it down",
          "p": [
            "Adding an optional request field is safe. Adding a required request field, removing or renaming a response field, tightening validation, changing an error code or status, changing the default sort or page size, or changing an id format are all breaking. Adding a response field is safe only if clients ignore unknown fields, which is a rule you must state and test, not assume.",
            "Adding an enum value is the subtle one. It is additive by most definitions and breaking for any client that deserializes into a closed enum - including every client generated from a schema that lists the values. That is why open-enum handling is a documented client obligation, and why a schema diff that adds a value should show up in review with a note about clients."
          ],
          "code": "mod v1 {\n    use serde::{Deserialize, Serialize};\n\n    #[derive(Serialize, Deserialize)]\n    pub struct Order {\n        pub id: String,\n        pub total_cents: i64, // v1 shipped minor units as cents\n        pub status: String,\n    }\n}\n\nmod v2 {\n    use serde::{Deserialize, Serialize};\n\n    #[derive(Serialize, Deserialize)]\n    pub struct Order {\n        pub id: String,\n        pub total: Money, // v2 pairs the amount with a currency\n        pub status: String,\n    }\n\n    #[derive(Serialize, Deserialize)]\n    pub struct Money {\n        pub amount_minor_units: i64,\n        pub currency: String,\n    }\n}\n\n// One domain type, two wire shapes, conversion at the edge.\npub struct DomainOrder {\n    pub id: String,\n    pub total_minor_units: i64,\n    pub currency: String,\n    pub status: String,\n}\n\nimpl From<DomainOrder> for v1::Order {\n    fn from(o: DomainOrder) -> Self {\n        Self { id: o.id, total_cents: o.total_minor_units, status: o.status }\n    }\n}\n\nimpl From<DomainOrder> for v2::Order {\n    fn from(o: DomainOrder) -> Self {\n        Self {\n            id: o.id,\n            total: v2::Money { amount_minor_units: o.total_minor_units, currency: o.currency },\n            status: o.status,\n        }\n    }\n}\n\npub fn router() -> axum::Router<AppState> {\n    axum::Router::new()\n        .nest(\"/v1\", crate::routes::v1::router())\n        .nest(\"/v2\", crate::routes::v2::router())\n}",
          "tip": "Freeze v1 by forbidding new features, not by forbidding fixes. A v1 that cannot receive a security patch becomes the reason to sunset it."
        },
        {
          "h": "Why aliases on a shared struct fail",
          "p": [
            "The tempting shortcut is one struct with `#[serde(alias = \"total_cents\")]` and `skip_serializing_if`, so both versions round-trip through the same type. It fails in three ways: you cannot tell which shape a request used, so authorization and validation diverge silently; removing a field from v1 becomes impossible without touching v2; and the OpenAPI generator documents one shape that matches neither version exactly.",
            "Separate DTOs per version are more code and less ambiguity. The duplication is bounded - a version only changes when the API changes - and the conversion functions are the single place where semantics are translated. A missing field in a conversion is a compile error, which is exactly the feedback you want when v2 adds a required concept."
          ],
          "tip": "If v1 and v2 share a handler, you have one API with two names. Keep the adapter thin and the domain wide."
        }
      ],
      "exercise": {
        "prompt": "A v1 endpoint returns `total_cents` and v2 must return `total: {amount_minor_units, currency}`. Write both DTOs, the conversion from one domain type, and the nested router that serves both prefixes.",
        "starter": "use axum::Router;\n\nmod v1 {\n    // total_cents\n}\n\nmod v2 {\n    // total: Money\n}\n\npub struct DomainOrder {\n    pub id: String,\n    pub total_minor_units: i64,\n    pub currency: String,\n}\n\npub fn router(state: AppState) -> Router<AppState> {\n    // nest both versions\n    todo!()\n}",
        "hint": "Implement From<DomainOrder> for each DTO, then nest two routers under /v1 and /v2. Do not give v2 an alias to total_cents; the shapes must be independent so v1 can be frozen.",
        "solution": "use axum::Router;\n\npub mod v1 {\n    use serde::Serialize;\n\n    #[derive(Serialize)]\n    pub struct Order {\n        pub id: String,\n        pub total_cents: i64,\n        pub status: String,\n    }\n}\n\npub mod v2 {\n    use serde::Serialize;\n\n    #[derive(Serialize)]\n    pub struct Order {\n        pub id: String,\n        pub total: Money,\n        pub status: String,\n    }\n\n    #[derive(Serialize)]\n    pub struct Money {\n        pub amount_minor_units: i64,\n        pub currency: String,\n    }\n}\n\npub struct DomainOrder {\n    pub id: String,\n    pub total_minor_units: i64,\n    pub currency: String,\n    pub status: String,\n}\n\nimpl From<DomainOrder> for v1::Order {\n    fn from(order: DomainOrder) -> Self {\n        Self {\n            id: order.id,\n            total_cents: order.total_minor_units,\n            status: order.status,\n        }\n    }\n}\n\nimpl From<DomainOrder> for v2::Order {\n    fn from(order: DomainOrder) -> Self {\n        Self {\n            id: order.id,\n            total: v2::Money {\n                amount_minor_units: order.total_minor_units,\n                currency: order.currency,\n            },\n            status: order.status,\n        }\n    }\n}\n\npub fn router() -> Router<AppState> {\n    Router::new()\n        .nest(\"/v1\", v1::router())\n        .nest(\"/v2\", v2::router())\n}"
      },
      "questions": [
        {
          "q": "Which change is breaking for a client that deserializes responses strictly?",
          "options": [
            "Adding a new optional field to a response object",
            "Removing a field the client reads, or adding a value to an enum it matches exhaustively",
            "Adding a new endpoint under a new path",
            "Adding a new optional header to a response"
          ],
          "answer": 1,
          "explain": "Unknown optional fields are ignorable, but a removed field or a new enum value is not. That is why the client tolerance rules belong in the published contract."
        },
        {
          "q": "What is the strongest practical argument for path versioning over media-type versioning?",
          "options": [
            "It transfers fewer bytes on the wire",
            "Version is visible in logs, CDN rules, gateway routing, and every example URL",
            "It is the only scheme allowed by OpenAPI 3.1",
            "It removes the need for a deprecation policy"
          ],
          "answer": 1,
          "explain": "Content negotiation is invisible to most infrastructure and to most humans debugging at 2am. Visibility is worth more than URI purity for a public API."
        },
        {
          "q": "Why is one shared struct with serde aliases the wrong way to support v1 and v2?",
          "options": [
            "Aliases are not supported by serde_json",
            "It hides which wire shape a request used, blocks removing v1 fields, and documents a shape that matches neither version",
            "It doubles the compiled binary size",
            "It prevents the use of OpenAPI generation"
          ],
          "answer": 1,
          "explain": "Two DTOs plus conversions are more lines and far less ambiguity. The conversion is also where a compile error catches a missing new field."
        }
      ],
      "quickbytes": [
        "Adding an optional request field is safe; adding a required one, tightening validation, or changing a default is not.",
        "Two DTOs and a From impl beat one struct with aliases; the compiler then finds what the alias hid.",
        "A frozen version still gets security fixes and a named owner, or it becomes the reason for an emergency migration."
      ],
      "production": [
        "The compatibility rules are published: which changes are additive and what clients must tolerate.",
        "A schema diff in CI flags removed fields, new enum values, and changed defaults before merge.",
        "Every version has an owner, a lifetime, and an entry in the deprecation plan.",
        "v1 and v2 have separate integration tests generated from their own spec versions.",
        "No handler is shared between versions except through the domain type and explicit conversion."
      ],
      "crates": [
        "axum",
        "serde",
        "utoipa",
        "serde_json"
      ],
      "github": [
        {
          "name": "OpenAPI-Specification - versioning and compatibility guidance",
          "url": "https://github.com/OAI/OpenAPI-Specification"
        },
        {
          "name": "axum - nested routers for versioned prefixes",
          "url": "https://github.com/tokio-rs/axum"
        }
      ],
      "pitfall": "Shipping v2 and freezing v1 in the same release with no owner: six months later a security fix lands in the v2 handler only, and the v1 adapter quietly keeps the vulnerable path alive because nobody remembers it exists.",
      "resources": [
        {
          "title": "Breaking Changes in Software Ecosystems: A Systematic Literature Review",
          "url": "https://arxiv.org/abs/2605.24397",
          "kind": "paper"
        },
        {
          "title": "OpenAPI Specification repository",
          "url": "https://github.com/OAI/OpenAPI-Specification",
          "kind": "repo"
        },
        {
          "title": "utoipa crate documentation: generating versioned documents",
          "url": "https://docs.rs/utoipa/latest/utoipa/",
          "kind": "docs"
        },
        {
          "title": "MDN: content negotiation and the Accept header",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Content_negotiation",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "ap11",
      "title": "Deprecation: sunset with evidence",
      "minutes": 60,
      "level": "industry",
      "goal": "Run a deprecation you can defend: attribute traffic per consumer, announce with headers and dates, brown out, and retire only when the data says it is safe.",
      "sections": [
        {
          "h": "You cannot sunset what you cannot measure",
          "p": [
            "The first deliverable is attribution, not an email. Every request must carry an API key, client id, or OAuth client, so you can answer 'which consumers called /v1/orders/search in the last thirty days, and how many times'. Without that number, a sunset is a guess that breaks a partner at 3am and turns a planned migration into an incident review.",
            "Then publish the plan: deprecation date, sunset date, replacement endpoint, and a migration guide with a diff of the two responses. Six months is a defensible floor for a public API; ninety days is workable for internal services. Anything shorter needs the affected consumers named in the announcement, because 'we told everyone' is not evidence."
          ],
          "list": [
            "Attribute every request to a consumer before announcing anything",
            "Publish deprecation date, sunset date, replacement, and a migration diff",
            "Name the metric that ends the deprecation: zero requests from the top N consumers for 14 days",
            "Keep a written exception path for consumers who cannot migrate in time"
          ],
          "tip": "A deprecation without a named owner is a wish. Put the owner and the sunset date in the same document as the API inventory."
        },
        {
          "h": "Headers, brownouts, and the formats nobody remembers",
          "p": [
            "Three headers carry the signal, in three different formats. `Deprecation` takes a structured-field date (`@1782864000`), `Sunset` takes an HTTP-date (`Wed, 31 Dec 2026 23:59:59 GMT`), and `Link: <https://docs.acme.dev/migrate/v2>; rel=\"deprecation\"` points at the guide. Clients need a worked example of all three, because getting the format wrong means the header is silently ignored.",
            "A brownout is a scheduled window - one hour a week, announced in advance - where the deprecated route returns 410. It surfaces consumers who ignored the email while the blast radius is still controlled, and it converts a vague risk into a list of client ids. Add the route to your synthetic monitoring so the brownout itself is testable, and skip it for endpoints that are load-bearing for payments."
          ],
          "code": "use axum::http::{header, HeaderName, HeaderValue};\nuse axum::middleware::Next;\nuse axum::response::Response;\nuse axum::extract::Request;\n\n/// Applied only to routes scheduled for removal.\npub async fn deprecation_headers(request: Request, next: Next) -> Response {\n    let mut response = next.run(request).await;\n    let headers = response.headers_mut();\n\n    // RFC 9745: Structured Fields date, Unix seconds with a leading @.\n    headers.insert(\n        HeaderName::from_static(\"deprecation\"),\n        HeaderValue::from_static(\"@1782864000\"),\n    );\n    // RFC 8594: IMF-fixdate, not the same format as the header above.\n    headers.insert(\n        HeaderName::from_static(\"sunset\"),\n        HeaderValue::from_static(\"Wed, 31 Dec 2026 23:59:59 GMT\"),\n    );\n    headers.insert(\n        header::LINK,\n        HeaderValue::from_static(\n            \"<https://docs.acme.dev/migrate/orders-v2>; rel=\\\"deprecation\\\"\",\n        ),\n    );\n    headers.insert(\n        HeaderName::from_static(\"x-api-version-status\"),\n        HeaderValue::from_static(\"deprecated\"),\n    );\n    response\n}\n\n/// The replacement route, mounted alongside during the migration window.\npub fn deprecation_layers(state: AppState) -> axum::Router<AppState> {\n    use axum::middleware;\n    let deprecated = axum::Router::new()\n        .route(\"/v1/orders/search\", axum::routing::get(crate::routes::v1::search))\n        .layer(middleware::from_fn(deprecation_headers))\n        .with_state(state.clone());\n\n    axum::Router::new()\n        .merge(deprecated)\n        .nest(\"/v2\", crate::routes::v2::router().with_state(state))\n}",
          "tip": "Validate header formats in a test against the published examples. A malformed Deprecation header is worse than none: tooling reports the route as fine."
        },
        {
          "h": "After sunset: 410, not 404",
          "p": [
            "When the date arrives, the route returns `410 Gone` with a body naming the replacement and linking the guide. Not 404: clients treat 404 as a typo, retry, or fall back to a default behaviour, while 410 is unambiguous and cacheable. Keep the route registered so you serve the 410 yourself instead of letting the framework render a 404 page.",
            "Remove the code only after the headers, documentation, changelog, SDK, and OpenAPI document all agree. Archive the retired contract in the repository so a customer can still read what they integrated against, and delete the old tests last - they are the only proof of what the endpoint used to do."
          ],
          "list": [
            "410 with a pointer to the replacement, cached aggressively",
            "Route stays registered until the last consumer is gone",
            "Old contract archived under docs/retired/ for support and audits",
            "Post-mortem note if the sunset broke someone: what the telemetry missed"
          ]
        }
      ],
      "exercise": {
        "prompt": "Add deprecation signalling to GET /v1/orders/search: emit Deprecation, Sunset, and a Link to the migration guide, and return 410 with a replacement pointer once the sunset date has passed.",
        "starter": "use axum::http::StatusCode;\nuse axum::response::{IntoResponse, Response};\n\npub async fn search() -> Response {\n    // 1. before sunset: 200 + deprecation headers\n    // 2. after sunset: 410 with a body pointing at /v2/orders\n    todo!()\n}",
        "hint": "Compare Utc::now() against a const sunset timestamp. Before it, insert the three headers on the response; after it, return GONE with a JSON body containing the replacement path and the migration URL.",
        "solution": "use axum::http::{header, HeaderName, HeaderValue, StatusCode};\nuse axum::response::{IntoResponse, Response};\nuse axum::Json;\nuse chrono::{DateTime, TimeZone, Utc};\n\nconst SUNSET_AT: i64 = 1_782_864_000; // 2026-12-31T23:59:59Z, published up front\n\npub async fn search() -> Response {\n    let sunset = Utc.timestamp_opt(SUNSET_AT, 0).single().expect(\"valid timestamp\");\n    if Utc::now() >= sunset {\n        return (\n            StatusCode::GONE,\n            Json(serde_json::json!({\n                \"type\": \"https://api.acme.dev/problems/gone\",\n                \"title\": \"This endpoint was retired\",\n                \"status\": 410,\n                \"replacement\": \"/v2/orders?q=...\",\n                \"guide\": \"https://docs.acme.dev/migrate/orders-v2\"\n            })),\n        )\n            .into_response();\n    }\n\n    let mut response = Json(serde_json::json!({ \"data\": [] })).into_response();\n    let headers = response.headers_mut();\n    headers.insert(\n        HeaderName::from_static(\"deprecation\"),\n        HeaderValue::from_str(&format!(\"@{SUNSET_AT}\")).expect(\"digits\"),\n    );\n    headers.insert(\n        HeaderName::from_static(\"sunset\"),\n        HeaderValue::from_str(\n            &DateTime::<Utc>::from_timestamp(SUNSET_AT, 0)\n                .expect(\"valid\")\n                .format(\"%a, %d %b %Y %H:%M:%S GMT\")\n                .to_string(),\n        )\n        .expect(\"http-date\"),\n    );\n    headers.insert(\n        header::LINK,\n        HeaderValue::from_static(\n            \"<https://docs.acme.dev/migrate/orders-v2>; rel=\\\"deprecation\\\"\",\n        ),\n    );\n    response\n}"
      },
      "questions": [
        {
          "q": "What must exist before you can decide a sunset date defensibly?",
          "options": [
            "A migration guide and a changelog entry",
            "Per-consumer traffic attribution for the endpoint you plan to remove",
            "A new major version of the SDK",
            "A signed contract with every consumer"
          ],
          "answer": 1,
          "explain": "Without attribution you do not know who is affected, so the date is a guess. The guide and changelog are necessary but cannot tell you whether it is safe to turn the endpoint off."
        },
        {
          "q": "Why return 410 Gone rather than 404 after a sunset?",
          "options": [
            "410 is required by RFC 9457 for retired endpoints",
            "410 states the resource existed and is gone, so clients do not retry or fall back as if the URL were mistyped",
            "404 cannot carry a response body",
            "410 is cached less aggressively, which surfaces the error sooner"
          ],
          "answer": 1,
          "explain": "404 suggests a typo and invites retries or default behaviour. 410 is explicit, cacheable, and can carry the replacement pointer in the body."
        },
        {
          "q": "What is the point of a scheduled brownout during deprecation?",
          "options": [
            "To test whether the replacement endpoint can handle the traffic",
            "To surface consumers who ignored the announcement, while the failure window is controlled",
            "To satisfy a legal requirement before removing an endpoint",
            "To reduce infrastructure cost during the migration"
          ],
          "answer": 1,
          "explain": "A brownout converts a vague risk into a list of client ids. It is a discovery tool, deliberately bounded, and it must be announced with the same care as the sunset."
        }
      ],
      "quickbytes": [
        "Deprecation takes `@<unix seconds>`, Sunset takes an HTTP-date; three headers, three formats.",
        "Publish the metric that ends the deprecation, or it never ends.",
        "410 with a replacement pointer beats 404; keep the route registered so you control the body."
      ],
      "production": [
        "Every deprecated endpoint emits Deprecation, Sunset, and a Link header, verified by a test.",
        "Traffic attribution per consumer is queryable before any deprecation is announced.",
        "Brownout windows are scheduled, announced, and excluded from SLO calculations.",
        "Retired contracts are archived in the repository and linked from the changelog.",
        "Removal is gated on zero traffic from named consumers for 14 consecutive days."
      ],
      "crates": [
        "axum",
        "tower-http",
        "chrono",
        "serde_json"
      ],
      "github": [
        {
          "name": "tower-http - the middleware layers this pattern builds on",
          "url": "https://github.com/tower-rs/tower-http"
        },
        {
          "name": "axum - per-route layers and nested routers",
          "url": "https://github.com/tokio-rs/axum"
        }
      ],
      "pitfall": "Sunsetting on the announced date without checking attribution headers: the partner who integrated in 2021 never received the email, their jobs fail at midnight, and the fix is a rollback that costs more than the migration ever saved.",
      "resources": [
        {
          "title": "Why and How Java Developers Break APIs (arXiv:1801.05198)",
          "url": "https://arxiv.org/abs/1801.05198",
          "kind": "paper"
        },
        {
          "title": "tower-http documentation: layers for headers and tracing",
          "url": "https://docs.rs/tower-http/latest/tower_http/",
          "kind": "docs"
        },
        {
          "title": "tower-http repository",
          "url": "https://github.com/tower-rs/tower-http",
          "kind": "repo"
        },
        {
          "title": "InfoQ: API lifecycle and deprecation practice talks",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ap12",
      "title": "Authentication and authorization boundaries",
      "minutes": 85,
      "level": "industry",
      "goal": "Put authentication in one extractor, enforce tenancy inside every query, and make a handler that forgets authorization fail to compile.",
      "sections": [
        {
          "h": "Two different questions, asked in that order",
          "p": [
            "Authentication answers who is calling. Authorization answers what this principal may do to this object. Conflating them produces route-level checks that pass for any authenticated caller, so tenant A can read tenant B's order by guessing an id - the classic IDOR. The object check belongs in the query, as `WHERE id = $1 AND tenant_id = $2`, not in an `if` after the fetch.",
            "Three credential types have to resolve to one `Principal`. An API key identifies an application: no user, no delegation, coarse scopes. OAuth2 client credentials identify a service. A user token carries a subject, a tenant, and scopes. Handlers should not care which arrived, only what the principal is allowed to do, so the extraction layer normalizes them."
          ],
          "list": [
            "API keys: identify an app, must never appear in a query string (logs and referrers)",
            "Client credentials: service identity, short-lived, rotated automatically",
            "User tokens: subject plus tenant plus scopes, validated on every request",
            "All three produce the same Principal type, so authorization is written once"
          ]
        },
        {
          "h": "Validating a token is not checking a signature",
          "p": [
            "A signature only proves the token was minted by whoever holds the key. You must also pin the algorithm, verify `iss` and `aud`, enforce `exp` and `nbf` with under a minute of leeway, and reject a token whose `kid` is unknown instead of falling back to the first key. Letting the token choose its own algorithm is how `alg: none` and HS/RS confusion attacks work.",
            "jsonwebtoken 11 moves the cryptography behind a provider feature: enable exactly one of `aws_lc_rs` or `rust_crypto`, and pin it in workspace dependencies so two crates in the graph cannot disagree. Cache the decoded JWKS by `kid`, refresh in the background, and keep the key parsing out of the per-request path."
          ],
          "code": "use axum::extract::FromRequestParts;\nuse axum::http::request::Parts;\nuse axum::http::{header, StatusCode};\nuse jsonwebtoken::{decode, Algorithm, Validation};\nuse serde::Deserialize;\n\n#[derive(Debug, Clone, Deserialize)]\npub struct Claims {\n    pub sub: String,\n    pub tenant_id: String,\n    pub scope: String,\n    pub exp: usize,\n}\n\n#[derive(Debug, Clone)]\npub struct Principal {\n    pub subject: String,\n    pub tenant_id: String,\n    pub scopes: Vec<String>,\n}\n\nimpl Principal {\n    pub fn require(&self, scope: &str) -> Result<(), (StatusCode, &'static str)> {\n        if self.scopes.iter().any(|held| held == scope) {\n            Ok(())\n        } else {\n            Err((StatusCode::FORBIDDEN, \"missing required scope\"))\n        }\n    }\n}\n\nimpl FromRequestParts<AppState> for Principal {\n    type Rejection = (StatusCode, &'static str);\n\n    async fn from_request_parts(\n        parts: &mut Parts,\n        state: &AppState,\n    ) -> Result<Self, Self::Rejection> {\n        let token = parts\n            .headers\n            .get(header::AUTHORIZATION)\n            .and_then(|value| value.to_str().ok())\n            .and_then(|value| value.strip_prefix(\"Bearer \"))\n            .ok_or((StatusCode::UNAUTHORIZED, \"missing bearer token\"))?;\n        // The algorithm is pinned by the server; the token cannot choose it.\n        let mut validation = Validation::new(Algorithm::RS256);\n        validation.set_audience(&[\"https://api.acme.dev\"]);\n        validation.set_issuer(&[\"https://acme.eu.auth0.com/\"]);\n        validation.leeway = 30;\n\n        let claims = decode::<Claims>(token, &state.decoding_key, &validation)\n            .map_err(|_| (StatusCode::UNAUTHORIZED, \"invalid token\"))?\n            .claims;\n        Ok(Self {\n            subject: claims.sub,\n            tenant_id: claims.tenant_id,\n            scopes: claims.scope.split_whitespace().map(str::to_owned).collect(),\n        })\n    }\n}",
          "tip": "Return 404 for another tenant's object, and log the denial. The client learns nothing; your audit trail learns everything."
        },
        {
          "h": "Make the boundary a type, not a habit",
          "p": [
            "Because `Principal` is an extractor, a handler that forgot authentication does not compile: the argument list demands it. That is a stronger guarantee than a middleware list or a code-review checklist, and it survives the refactor that moves a route between routers. The same idea covers scopes: `principal.require(\"orders:write\")?` as the first statement is visible, greppable, and testable.",
            "Tenant identity comes from the principal, never from the body or the query. If a request contains a `tenant_id` field, ignore it or reject it with 422; accepting it silently is how cross-tenant bugs begin. Background jobs that reuse service code should construct an explicit service principal rather than carrying a bypass flag that someone will eventually expose."
          ],
          "tip": "A `#[allow(clippy::too_many_arguments)]` handler with no Principal is a public endpoint. Grep for handlers whose arguments lack the extractor.",
          "code": "use axum::extract::{Path, State};\nuse axum::http::StatusCode;\nuse axum::Json;\n\npub async fn get_order(\n    State(state): State<AppState>,\n    principal: Principal,\n    Path(id): Path<String>,\n) -> Result<Json<OrderRow>, (StatusCode, &'static str)> {\n    principal.require(\"orders:read\")?;\n\n    // Tenancy lives in the predicate. A post-fetch check is a race with a leak.\n    let order = sqlx::query_as::<_, OrderRow>(\n        \"SELECT id, total_minor_units, currency FROM orders WHERE id = $1 AND tenant_id = $2\",\n    )\n    .bind(&id)\n    .bind(&principal.tenant_id)\n    .fetch_optional(&state.pool)\n    .await\n    .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, \"database error\"))?\n    .ok_or((StatusCode::NOT_FOUND, \"order not found\"))?;\n\n    Ok(Json(order))\n}"
        }
      ],
      "exercise": {
        "prompt": "Write a Principal extractor that accepts a bearer token, validates issuer, audience, and expiry with RS256 pinned, and exposes require(scope). Then write a handler whose SQL filters by the principal's tenant.",
        "starter": "use axum::extract::FromRequestParts;\nuse axum::http::request::Parts;\nuse axum::http::StatusCode;\n\npub struct Principal {\n    pub tenant_id: String,\n    pub scopes: Vec<String>,\n}\n\nimpl FromRequestParts<AppState> for Principal {\n    type Rejection = (StatusCode, &'static str);\n\n    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {\n        // 1. strip the Bearer prefix\n        // 2. decode with pinned algorithm, audience, issuer\n        // 3. build the principal\n        todo!()\n    }\n}",
        "hint": "Validation::new(Algorithm::RS256), set_audience, set_issuer, leeway 30. Map any decode error to 401 without echoing the library message, and split the space-separated scope claim into a Vec.",
        "solution": "use axum::extract::FromRequestParts;\nuse axum::http::request::Parts;\nuse axum::http::{header, StatusCode};\nuse jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};\nuse serde::Deserialize;\n\n#[derive(Deserialize)]\npub struct Claims {\n    pub sub: String,\n    pub tenant_id: String,\n    pub scope: String,\n    pub exp: usize,\n}\n\npub struct Principal {\n    pub subject: String,\n    pub tenant_id: String,\n    pub scopes: Vec<String>,\n}\n\nimpl Principal {\n    pub fn require(&self, scope: &str) -> Result<(), (StatusCode, &'static str)> {\n        if self.scopes.iter().any(|held| held == scope) {\n            Ok(())\n        } else {\n            Err((StatusCode::FORBIDDEN, \"missing required scope\"))\n        }\n    }\n}\n\nimpl FromRequestParts<AppState> for Principal {\n    type Rejection = (StatusCode, &'static str);\n\n    async fn from_request_parts(\n        parts: &mut Parts,\n        state: &AppState,\n    ) -> Result<Self, Self::Rejection> {\n        let token = parts\n            .headers\n            .get(header::AUTHORIZATION)\n            .and_then(|value| value.to_str().ok())\n            .and_then(|value| value.strip_prefix(\"Bearer \"))\n            .ok_or((StatusCode::UNAUTHORIZED, \"missing bearer token\"))?;\n\n        let mut validation = Validation::new(Algorithm::RS256);\n        validation.set_audience(&[\"https://api.acme.dev\"]);\n        validation.set_issuer(&[\"https://acme.eu.auth0.com/\"]);\n        validation.leeway = 30;\n\n        let claims = decode::<Claims>(token, &state.decoding_key, &validation)\n            .map_err(|_| (StatusCode::UNAUTHORIZED, \"invalid token\"))?\n            .claims;\n\n        Ok(Self {\n            subject: claims.sub,\n            tenant_id: claims.tenant_id,\n            scopes: claims.scope.split_whitespace().map(str::to_owned).collect(),\n        })\n    }\n}\n\n// The handler cannot be written without a Principal, which is the point:\n// forgetting authentication is a compile error, not a security review finding.\npub async fn handler(\n    principal: Principal,\n    axum::extract::State(state): axum::extract::State<AppState>,\n) -> Result<axum::Json<Vec<OrderRow>>, (StatusCode, &'static str)> {\n    principal.require(\"orders:read\")?;\n    let rows = sqlx::query_as::<_, OrderRow>(\n        \"SELECT id, total_minor_units, currency FROM orders WHERE tenant_id = $1 LIMIT 100\",\n    )\n    .bind(&principal.tenant_id)\n    .fetch_all(&state.pool)\n    .await\n    .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, \"database error\"))?;\n    Ok(axum::Json(rows))\n}"
      },
      "questions": [
        {
          "q": "Where must the tenant id used for authorization come from?",
          "options": [
            "The request body, so clients can act on behalf of other tenants",
            "The query string, so it appears in access logs",
            "The validated token, bound into every query as a predicate",
            "A header the client sets, validated against the token's subject"
          ],
          "answer": 2,
          "explain": "Anything the client can set is attacker-controlled. The tenant claim from a validated token is the only value that can be trusted, and it must appear in the SQL predicate, not in a post-fetch check."
        },
        {
          "q": "What does an API key prove compared with a user token?",
          "options": [
            "That a specific end user authorized the call",
            "That an application is calling; it carries no user identity or delegated authority",
            "That the caller has every scope the API defines",
            "Nothing, because API keys are equivalent to passwords and must be avoided"
          ],
          "answer": 1,
          "explain": "An API key is an application credential. It says which app is calling, not who the user is, so object-level checks and user consent still have to exist."
        },
        {
          "q": "Why pin the verification algorithm instead of reading it from the token header?",
          "options": [
            "It makes verification slightly faster",
            "The header is attacker-controlled, so trusting it enables alg:none and key-confusion attacks",
            "jsonwebtoken cannot parse the header otherwise",
            "It allows the server to rotate keys without a redeploy"
          ],
          "answer": 1,
          "explain": "The token chooses its own algorithm only if you let it. Pinning RS256 and the matching key type removes the class of attacks where a public key is reinterpreted as an HMAC secret."
        }
      ],
      "quickbytes": [
        "Principal as an extractor makes a handler without authentication fail to compile.",
        "Tenant predicate in the SQL, never a post-fetch if; the if loses races.",
        "Pin the algorithm, check iss/aud/exp, and reject unknown kids rather than falling back."
      ],
      "production": [
        "Every handler that touches tenant data takes a Principal and filters by it in SQL.",
        "JWT validation pins the algorithm, audience, issuer, and leeway under 60 seconds.",
        "A cross-tenant access test exists per resource type and runs in CI.",
        "Credentials never appear in query strings, and access logs redact Authorization.",
        "Denials are audited with principal, resource, and request id, and 404 is returned for other tenants' objects."
      ],
      "crates": [
        "jsonwebtoken",
        "axum",
        "tower",
        "serde"
      ],
      "github": [
        {
          "name": "jsonwebtoken - JWT encoding, decoding, and JWKS handling",
          "url": "https://github.com/Keats/jsonwebtoken"
        },
        {
          "name": "axum - FromRequestParts and middleware",
          "url": "https://github.com/tokio-rs/axum"
        }
      ],
      "pitfall": "Authorizing the route but not the object: `GET /orders/{id}` checks that the caller has the orders:read scope, then fetches by id alone, so any authenticated tenant can read any order by guessing a ULID that leaked in a support email.",
      "resources": [
        {
          "title": "MDN: Authorization header and bearer credentials",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Authorization",
          "kind": "docs"
        },
        {
          "title": "jsonwebtoken crate documentation",
          "url": "https://docs.rs/jsonwebtoken/latest/jsonwebtoken/",
          "kind": "docs"
        },
        {
          "title": "axum middleware module: from_fn and state",
          "url": "https://docs.rs/axum/latest/axum/middleware/index.html",
          "kind": "docs"
        },
        {
          "title": "jsonwebtoken repository",
          "url": "https://github.com/Keats/jsonwebtoken",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "ap13",
      "title": "Rate limiting and quotas",
      "minutes": 80,
      "level": "industry",
      "goal": "Pick a limiting algorithm, decide where the counter lives, and return 429 responses that tell the client exactly how long to wait.",
      "sections": [
        {
          "h": "Algorithms and what each one actually enforces",
          "p": [
            "A fixed window is the cheapest and the least honest: a client can send the full allowance at 12:00:59 and again at 12:01:00, so a 100-per-minute limit permits 200 requests in two seconds. A sliding-window log is exact and stores a timestamp per request. A token bucket allows a burst up to the bucket size and refills at a steady rate, and GCRA expresses that same policy as one 'theoretical arrival time' value per key, which is why it is cheap to keep.",
            "Choose by the sentence you want to be true. 'No more than 100 requests in any sixty seconds' is a sliding log. 'Twenty burst, then two per second sustained' is a token bucket. 'Never more than eight concurrent requests against a slow downstream' is not rate limiting at all - it is a concurrency limit, and confusing the two gives you a limiter that permits a hundred slow requests and takes the dependency down anyway."
          ],
          "list": [
            "Fixed window: cheapest, allows a 2x burst at the boundary, fine for coarse abuse protection",
            "Token bucket / GCRA: burst plus sustained rate, one small value per key",
            "Sliding log: exact, memory proportional to the request rate, use for small expensive surfaces",
            "Concurrency limit: protects a dependency from parallelism, not from volume"
          ],
          "tip": "Write the policy as a sentence first, then pick the algorithm that makes exactly that sentence true."
        },
        {
          "h": "Where the counter lives",
          "p": [
            "An in-process limiter is fast, needs no network hop, and enforces its limit per replica: with eight pods, the effective limit is eight times what you configured. That is usually acceptable for abuse protection, but it must be documented, because a customer will measure it and file a bug. Exact global quotas need a shared counter in Redis or Postgres and pay a round trip per request, plus a new question: when the limiter is unavailable, do you fail open and lose protection, or fail closed and take the API down?",
            "Limit by credential, not by address, once you have credentials. IPs are shared by offices, carriers, and CI runners, so one noisy neighbour throttles everyone behind the same NAT, while an attacker with rotating IPs is unaffected. If you must limit by IP, be explicit about forwarded-header trust: `SmartIpKeyExtractor` reads `X-Forwarded-For`, which is only meaningful when your edge strips client-supplied values."
          ],
          "code": "use axum::Router;\nuse tower_governor::governor::GovernorConfigBuilder;\nuse tower_governor::key_extractor::SmartIpKeyExtractor;\nuse tower_governor::GovernorLayer;\n\npub fn limited(router: Router<AppState>) -> Router<AppState> {\n    // Trusted forwarded headers only: the edge must overwrite X-Forwarded-For.\n    let per_client = GovernorConfigBuilder::default()\n        .per_second(2)          // sustained refill rate\n        .burst_size(20)         // allow a short burst, then throttle\n        .key_extractor(SmartIpKeyExtractor)\n        .use_headers()          // RateLimit-* headers on every response\n        .finish()\n        .expect(\"valid governor config\");\n\n    // Expensive endpoints get their own, tighter bucket.\n    let per_export = GovernorConfigBuilder::default()\n        .per_second(1)\n        .burst_size(2)\n        .use_headers()\n        .finish()\n        .expect(\"valid governor config\");\n\n    router\n        .route_layer(GovernorLayer::new(per_export))\n        .layer(GovernorLayer::new(per_client))\n}\n\n// The limiter needs connect info, or every request shares one bucket:\n// axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())",
          "tip": "Share one GovernorConfig instance across the router. Building a second identical config creates a second independent limiter, and the effective limit doubles."
        },
        {
          "h": "Headers, 429, and honesty about the window",
          "p": [
            "A 429 must say when to come back. `Retry-After` is seconds or an HTTP-date; the limit headers tell the client what is left. Pick one naming convention - the IETF `RateLimit-Limit`/`Remaining`/`Reset` trio or the widely deployed `X-RateLimit-*` - document it, and be consistent, because SDKs hard-code whichever they saw first. A 429 without Retry-After produces an immediate retry storm, and a one-second Retry-After on a monthly quota produces two and a half million pointless requests.",
            "Cost-based limits keep the budget meaningful. Give every operation a weight in a published table - list 1, detail 1, export 50, bulk import 100 - and debit the bucket by weight instead of by request. Without weights, a single 200 MB export costs the same as a health check and the limiter protects nothing that matters."
          ],
          "tip": "Return the same 429 shape as your problem+json errors, with the quota window and the reset time in the body."
        }
      ],
      "exercise": {
        "prompt": "Implement a cost-aware token bucket: claim(now, cost) returns Ok(()) or Err(wait) so the caller can set Retry-After, and refill is time-based rather than a timer per key.",
        "starter": "use std::time::{Duration, Instant};\n\npub struct TokenBucket {\n    capacity: f64,\n    tokens: f64,\n    refill_per_second: f64,\n    last: Instant,\n}\n\nimpl TokenBucket {\n    pub fn claim(&mut self, now: Instant, cost: f64) -> Result<(), Duration> {\n        // 1. refill since `last`\n        // 2. take cost if enough, else compute the wait\n        todo!()\n    }\n}",
        "hint": "Refill by elapsed.as_secs_f64() * refill_per_second, capped at capacity. If tokens < cost, wait = (cost - tokens) / refill_per_second and return it as Duration::from_secs_f64.",
        "solution": "use std::time::{Duration, Instant};\n\npub struct TokenBucket {\n    capacity: f64,\n    tokens: f64,\n    refill_per_second: f64,\n    last: Instant,\n}\n\nimpl TokenBucket {\n    pub fn new(capacity: f64, refill_per_second: f64, now: Instant) -> Self {\n        Self { capacity, tokens: capacity, refill_per_second, last: now }\n    }\n\n    pub fn claim(&mut self, now: Instant, cost: f64) -> Result<(), Duration> {\n        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();\n        self.tokens = (self.tokens + elapsed * self.refill_per_second).min(self.capacity);\n        self.last = now;\n\n        if self.tokens >= cost {\n            self.tokens -= cost;\n            return Ok(());\n        }\n\n        // Never return zero: a client that retries immediately is a busy loop.\n        let wait_secs = ((cost - self.tokens) / self.refill_per_second).max(0.001);\n        Err(Duration::from_secs_f64(wait_secs))\n    }\n}\n\npub fn retry_after_header(wait: Duration) -> String {\n    // Round up: advising a shorter wait than the bucket allows causes retries\n    // that are guaranteed to fail.\n    format!(\"{}\", wait.as_secs() + u64::from(wait.subsec_nanos() > 0))\n}"
      },
      "questions": [
        {
          "q": "A fixed-window limiter allows 100 requests per minute. A client sends 100 at 12:00:59 and 100 at 12:01:00. What happens and why?",
          "options": [
            "The second batch is rejected because the window is rolling",
            "All 200 succeed in about two seconds, because each window is counted independently",
            "The limiter blocks the client for the next minute",
            "The client is throttled to one request per second for the next hour"
          ],
          "answer": 1,
          "explain": "Fixed windows reset at boundaries, so traffic can double at the seam. A token bucket smooths the same limit over time; a sliding log is exact at the cost of storing timestamps."
        },
        {
          "q": "Eight replicas each run an in-process limiter configured at 100 requests per minute. What is the effective limit?",
          "options": [
            "100 per minute, because the configuration is identical",
            "About 800 per minute, because each replica counts separately",
            "100 per second, because the window is per replica",
            "It depends on the load balancer's algorithm only"
          ],
          "answer": 1,
          "explain": "Per-process counters are per-process. That is fine for abuse protection if documented, but it is not a quota; a real quota needs a shared store and a fail-open or fail-closed decision."
        },
        {
          "q": "Why is `Retry-After: 1` on a monthly quota a bug?",
          "options": [
            "Retry-After must always be an HTTP-date, never seconds",
            "It tells clients to retry a request that cannot succeed for weeks, producing a retry storm",
            "It disables caching for the response",
            "It conflicts with the RateLimit-Reset header"
          ],
          "answer": 1,
          "explain": "Retry-After is a promise about when the request can succeed. Lying about it converts one rejected request into millions; for a monthly quota, return the reset time or a much larger delay."
        }
      ],
      "quickbytes": [
        "State the policy as a sentence, then pick the algorithm that makes it true; 2x bursts at window edges are a design choice, not a bug.",
        "In-process limiters multiply by replica count; document it or move the counter to a shared store.",
        "Never return a Retry-After shorter than the time the limit actually needs."
      ],
      "production": [
        "Limits are set per credential class, with separate buckets for expensive operations.",
        "429 responses carry Retry-After and consistent limit headers on every response, not only on rejection.",
        "The multi-replica multiplier is documented, or quotas are enforced in a shared store.",
        "Limiter failure behaviour (fail open or closed) is chosen deliberately and tested.",
        "Forwarded-header trust is configured at the edge; client-supplied X-Forwarded-For is stripped."
      ],
      "crates": [
        "tower-governor",
        "governor",
        "tower",
        "axum"
      ],
      "github": [
        {
          "name": "tower-governor - per-key rate limiting layer",
          "url": "https://github.com/benwis/tower-governor"
        },
        {
          "name": "governor - the quota and GCRA implementation underneath",
          "url": "https://github.com/boinkor-net/governor"
        }
      ],
      "pitfall": "Deploying the limiter without `into_make_service_with_connect_info::<SocketAddr>()`: the peer-IP extractor finds nothing, every request falls into one shared bucket, and a single client's traffic throttles the entire API while the per-key dashboards look flat.",
      "resources": [
        {
          "title": "Designing Scalable Rate Limiting Systems (arXiv:2602.11741)",
          "url": "https://arxiv.org/abs/2602.11741",
          "kind": "paper"
        },
        {
          "title": "tower_governor documentation: keys, headers, and presets",
          "url": "https://docs.rs/tower_governor/latest/tower_governor/",
          "kind": "docs"
        },
        {
          "title": "MDN: 429 Too Many Requests",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/429",
          "kind": "docs"
        },
        {
          "title": "MDN: Retry-After header",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Retry-After",
          "kind": "docs"
        },
        {
          "title": "tower-governor repository: custom key extractors",
          "url": "https://github.com/benwis/tower-governor",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "ap14",
      "title": "Bulk and batch endpoints",
      "minutes": 65,
      "level": "advanced",
      "goal": "Separate bulk jobs from batches of independent calls, choose partial versus all-or-nothing semantics, and bound the work a single request can create.",
      "sections": [
        {
          "h": "Bulk and batch are different products",
          "p": [
            "A bulk operation is one change applied to many items: import ten thousand SKUs, reprice a catalog. It is a job, so it returns 202 with an operation id, reports progress, and produces a result file. A batch is N independent calls packed into one HTTP request to save round trips: reserve stock for twelve carts. It is a latency optimisation, so it returns per-item outcomes in one synchronous response.",
            "Mixing them produces an endpoint that is both slow and hard to retry: it takes minutes, holds a connection open past every proxy timeout, and when it fails you cannot tell which items landed. If the work takes more than a few seconds, it is a bulk job with an operation resource, not a bigger batch."
          ],
          "tip": "The tell is the error path: if you cannot describe per-item failure, you are building a job.",
          "code": "use serde::{Deserialize, Serialize};\n\nconst MAX_ITEMS: usize = 100;\n\n#[derive(Debug, Deserialize)]\npub struct BatchRequest {\n    pub items: Vec<BatchItem>,\n}\n\n#[derive(Debug, Deserialize)]\npub struct BatchItem {\n    pub id: String, // client-supplied, echoed back to match results\n    pub sku: String,\n    pub quantity: i64,\n}\n\n#[derive(Debug, Serialize)]\n#[serde(tag = \"status\", rename_all = \"snake_case\")]\npub enum ItemOutcome {\n    Ok { id: String, reservation_id: String },\n    Failed { id: String, code: &'static str, detail: String },\n}\n\n#[derive(Debug, Serialize)]\npub struct BatchResponse {\n    pub results: Vec<ItemOutcome>,\n    pub succeeded: usize,\n    pub failed: usize,\n}"
        },
        {
          "h": "Partial success, stated up front",
          "p": [
            "Decide per endpoint and publish it. All-or-nothing means one transaction: any failure rolls back the batch and the response names the item that failed. Partial means independent execution: the response carries one outcome per item, a summary count, and errors keyed by a client-supplied item id. Partial is right for messy imports where the client wants the good rows to land; all-or-nothing is right when the items form one logical change.",
            "Never return 200 with a body that silently dropped items. And be careful with 207 Multi-Status: it is a WebDAV code that many SDKs, proxies, and dashboards treat as plain success, so the caller's UI says 'imported 100' while seven failed. A plain 200 with an explicit, well-documented per-item result array is easier to consume correctly, and either way the response shape must make dropping errors hard."
          ],
          "list": [
            "Cap items per request (100) and bytes per body (1 MiB); reject with 413 or 400",
            "Require a client-supplied item id and echo it, so matching does not depend on order",
            "Deduplicate item ids inside one request and reject duplicates explicitly",
            "Make each item idempotent, so a retried batch does not create duplicates"
          ],
          "code": "use axum::extract::State;\nuse axum::http::StatusCode;\nuse axum::response::{IntoResponse, Response};\nuse axum::Json;\nuse std::collections::HashSet;\n\npub async fn create_reservations(\n    State(state): State<AppState>,\n    Json(body): Json<BatchRequest>,\n) -> Response {\n    if body.items.is_empty() || body.items.len() > MAX_ITEMS {\n        return (StatusCode::BAD_REQUEST, format!(\"items must be 1..={MAX_ITEMS}\")).into_response();\n    }\n\n    let mut seen = HashSet::with_capacity(body.items.len());\n    if let Some(duplicate) = body.items.iter().find(|item| !seen.insert(item.id.as_str())) {\n        return (StatusCode::UNPROCESSABLE_ENTITY, format!(\"duplicate item id {}\", duplicate.id))\n            .into_response();\n    }\n\n    let mut results = Vec::with_capacity(body.items.len());\n    for item in body.items {\n        match state.inventory.reserve(&item.sku, item.quantity).await {\n            Ok(reservation_id) => results.push(ItemOutcome::Ok { id: item.id, reservation_id }),\n            Err(error) => results.push(ItemOutcome::Failed {\n                id: item.id,\n                code: error.code(),\n                detail: error.to_string(),\n            }),\n        }\n    }\n\n    let failed = results\n        .iter()\n        .filter(|outcome| matches!(outcome, ItemOutcome::Failed { .. }))\n        .count();\n    let response = BatchResponse {\n        succeeded: results.len() - failed,\n        failed,\n        results,\n    };\n\n    // 200 plus explicit per-item outcomes. If you choose 207 instead, document it\n    // loudly: many clients and proxies collapse it to plain success.\n    Json(response).into_response()\n}"
        },
        {
          "h": "Bounding the work, bounding the blast radius",
          "p": [
            "A batch endpoint is a multiplier: one request can be a hundred writes, so it bypasses the per-request rate limit unless the limit is cost-weighted. Debit the limiter by item count, cap concurrency inside the handler, and run items sequentially if the downstream cannot take the parallelism - a batch that fans out to a hundred concurrent database writes is an outage generator disguised as an optimisation.",
            "Ordering is not guaranteed and should not be implied. If two items in one batch touch the same row, the result depends on execution order; either reject duplicates of the same resource or document that the last write wins. When order genuinely matters, it is a bulk job with an explicit sequence, not a batch."
          ],
          "tip": "Debit the rate limiter by item count, not by request. Otherwise one batch call is a hundred free writes."
        }
      ],
      "exercise": {
        "prompt": "Add all-or-nothing semantics to a batch that reserves stock for several carts: run inside one transaction, roll back on the first failure, and return the failing item id with a 409.",
        "starter": "pub async fn reserve_all(pool: &sqlx::PgPool, items: &[BatchItem]) -> Result<(), BatchError> {\n    // 1. begin a transaction\n    // 2. reserve each item, return the first failure with its id\n    // 3. commit only if every item succeeded\n    todo!()\n}",
        "hint": "Iterate inside one `tx`, mapping the first error to BatchError::Item { id, code }, and let the transaction drop (rollback) on the early return. Commit explicitly only after the loop finishes.",
        "solution": "use sqlx::PgPool;\n\npub struct BatchItem {\n    pub id: String,\n    pub sku: String,\n    pub quantity: i64,\n}\n\n#[derive(Debug, thiserror::Error)]\npub enum BatchError {\n    #[error(\"item {id} failed: {code}\")]\n    Item { id: String, code: &'static str },\n    #[error(\"database error\")]\n    Database(#[from] sqlx::Error),\n}\n\npub async fn reserve_all(pool: &PgPool, items: &[BatchItem]) -> Result<(), BatchError> {\n    let mut tx = pool.begin().await?;\n\n    for item in items {\n        let updated = sqlx::query(\n            r#\"UPDATE inventory\n                  SET reserved = reserved + $1\n                WHERE sku = $2 AND available >= $1\"#,\n        )\n        .bind(item.quantity)\n        .bind(&item.sku)\n        .execute(&mut *tx)\n        .await?\n        .rows_affected();\n\n        if updated == 0 {\n            // Dropping `tx` rolls back every earlier reservation, so the\n            // client never observes a half-applied batch.\n            return Err(BatchError::Item { id: item.id.clone(), code: \"insufficient_stock\" });\n        }\n    }\n\n    tx.commit().await?;\n    Ok(())\n}"
      },
      "questions": [
        {
          "q": "Why is a 207 Multi-Status response risky for a batch endpoint?",
          "options": [
            "207 is not a valid HTTP status code in HTTP/2",
            "Many SDKs and proxies treat any 2xx as full success, so per-item failures are silently ignored",
            "207 cannot carry a JSON body",
            "207 disables caching for the entire API"
          ],
          "answer": 1,
          "explain": "207 exists in WebDAV and is poorly modelled outside it. If you use it, the per-item errors must be impossible to miss; a plain 200 with a documented result array is often easier to consume correctly."
        },
        {
          "q": "A batch of 100 writes runs inside one transaction and item 37 fails. What is the consequence?",
          "options": [
            "Items 1-36 commit and 37-100 are skipped",
            "All 100 roll back, including the 36 that would have succeeded",
            "The transaction retries item 37 automatically",
            "The database commits 99 of them and reports one error"
          ],
          "answer": 1,
          "explain": "That is what all-or-nothing means, and it is a legitimate choice - but it must be documented, because clients often expect partial success and will not retry the good rows."
        },
        {
          "q": "What ordering guarantee should a batch endpoint document?",
          "options": [
            "Items execute in array order, sequentially",
            "Items execute in reverse order so later items win",
            "None: items are independent and may run concurrently",
            "Ordering follows the client's Idempotency-Key values"
          ],
          "answer": 2,
          "explain": "Batches are for independent operations. If order matters, the items are not independent and the endpoint should be a bulk job with explicit sequencing."
        }
      ],
      "quickbytes": [
        "Bulk is a job (202 + operation); batch is a latency trick (200 + per-item results).",
        "Echo a client-supplied item id so results can be matched without relying on order.",
        "Debit the cost limiter by item count, or batch becomes a rate-limit bypass."
      ],
      "production": [
        "Batch size and body size are capped and enforced before any database work.",
        "Per-item outcomes are explicit, counted, and impossible to mistake for overall success.",
        "Each item is idempotent or carries its own idempotency key, so a retried batch is safe.",
        "Internal concurrency is bounded, and the cost limiter is debited by item count.",
        "All-or-nothing batches document their rollback behaviour and are tested with a mid-batch failure."
      ],
      "crates": [
        "axum",
        "serde",
        "serde_json",
        "sqlx"
      ],
      "github": [
        {
          "name": "axum - JSON extractors and response composition",
          "url": "https://github.com/tokio-rs/axum"
        },
        {
          "name": "OpenAPI-Specification - documenting per-item response shapes",
          "url": "https://github.com/OAI/OpenAPI-Specification"
        }
      ],
      "pitfall": "A batch endpoint that opens a transaction per request and holds it while calling a downstream service for each item: one slow dependency turns a 100-item batch into a multi-minute lock holder, and every concurrent batch queues behind it.",
      "resources": [
        {
          "title": "MDN: 207 Multi-Status",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/207",
          "kind": "docs"
        },
        {
          "title": "axum crate documentation",
          "url": "https://docs.rs/axum/latest/axum/",
          "kind": "docs"
        },
        {
          "title": "axum repository: JSON extraction and custom rejections",
          "url": "https://github.com/tokio-rs/axum",
          "kind": "repo"
        },
        {
          "title": "InfoQ: bulk data and integration API talks",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ap15",
      "title": "Streaming APIs: SSE, WebSocket, and gRPC streams",
      "minutes": 90,
      "level": "advanced",
      "goal": "Pick a transport for the direction and shape of your data, keep the connection alive through proxies, and make resume and lag handling explicit.",
      "sections": [
        {
          "h": "Pick by direction and by infrastructure",
          "p": [
            "Server-Sent Events carry server-to-client text over ordinary HTTP: automatic reconnection, `Last-Event-ID` resume, ordinary bearer auth, and proxies that already understand the protocol. WebSocket gives you a bidirectional channel but hands you heartbeats, reconnection, backpressure, and auth refresh, and it no longer looks like HTTP to your gateway. gRPC server streaming gives typed messages and HTTP/2 flow control, at the price of gRPC-capable infrastructure end to end.",
            "Most realtime features are read-only feeds - order status, prices, notifications - and SSE is the right default for them. Choose WebSocket when the client must send messages on the same channel (collaborative editing, terminal sessions), and long polling only when nothing else survives the network in front of you."
          ],
          "list": [
            "SSE: one-way, reconnects itself, cacheable-free, works through most corporate proxies",
            "WebSocket: two-way, you own liveness and resume, not HTTP-semantic",
            "gRPC streams: typed and flow-controlled, needs HTTP/2 end to end",
            "Long polling: universal fallback, one request per message, expensive at scale"
          ],
          "tip": "If the client never sends a message on the channel, SSE is almost always less code and fewer incidents."
        },
        {
          "h": "Keeping a stream alive through the middleboxes",
          "p": [
            "Load balancers and reverse proxies close idle connections, commonly at sixty seconds. Send an SSE comment or a `retry:` line every fifteen to thirty seconds, set `Cache-Control: no-cache`, and disable response buffering - nginx needs `X-Accel-Buffering: no`, and some CDNs need explicit configuration not to coalesce the body. Without that you get a silent reconnect every minute and a reconnect storm after each deploy.",
            "Detect disconnects by dropping the stream rather than polling a flag: axum cancels the response future when the client goes away, so a `Drop` guard is the place to unsubscribe and stop database polling. Bound the per-connection buffer as well, because a slow client that never reads must not make the server hold a day of events in memory."
          ]
        },
        {
          "h": "Resume, ordering, and lag",
          "p": [
            "Give every event an `id`. On reconnect the browser sends `Last-Event-ID` and the server replays from a bounded store: five minutes or a thousand events, whichever is smaller. When the client is too far behind, send a `resync` event and let it refetch state instead of pretending the stream was continuous.",
            "Ordering is per stream key only. If two events for the same order can be produced concurrently, attach a monotonically increasing sequence per key and let the client discard out-of-order arrivals. In tokio, a lagging `broadcast` subscriber receives `RecvError::Lagged(n)`; that must trigger a resync, because those n events are gone and no retry will bring them back."
          ],
          "code": "use axum::extract::{Path, State};\nuse axum::response::sse::{Event, KeepAlive, Sse};\nuse futures_util::stream::{Stream, StreamExt};\nuse std::convert::Infallible;\nuse std::time::Duration;\nuse tokio_stream::wrappers::errors::BroadcastStreamRecvError;\nuse tokio_stream::wrappers::BroadcastStream;\n\npub async fn order_events(\n    State(state): State<AppState>,\n    Path(order_id): Path<String>,\n) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {\n    let receiver = state.events.subscribe(&order_id);\n\n    let stream = BroadcastStream::new(receiver).filter_map(move |message| async move {\n        match message {\n            Ok(event) => Event::default()\n                .id(event.seq.to_string())\n                .event(event.kind)\n                .json_data(event.payload)\n                .ok()\n                .map(Ok),\n            // Events were dropped for this subscriber. Tell the client to\n            // refetch instead of leaving a silent hole in the stream.\n            Err(BroadcastStreamRecvError::Lagged(missed)) => Some(Ok(Event::default()\n                .event(\"resync\")\n                .data(format!(\"{{\\\"missed\\\":{missed}}}\")))),\n            Err(_) => None,\n        }\n    });\n\n    Sse::new(stream).keep_alive(\n        KeepAlive::new()\n            .interval(Duration::from_secs(15))\n            .text(\"ping\"),\n    )\n}\n\n// The handler above is mounted as a normal GET route:\n// .route(\"/v1/orders/{id}/events\", get(order_events))\n// Proxies in front of it must stream responses: disable buffering and set\n// a read timeout longer than the longest expected quiet period.",
          "tip": "Put the resume buffer behind an interface. When you outgrow the in-memory ring, swapping in Postgres or Redis should not change the event contract."
        }
      ],
      "exercise": {
        "prompt": "Implement an SSE endpoint that emits order status events with ids, sends a keep-alive every 15 seconds, and emits a resync event when a subscriber falls behind the broadcast buffer.",
        "starter": "use axum::response::sse::{Event, Sse};\nuse futures_util::stream::Stream;\nuse std::convert::Infallible;\n\npub async fn events() -> Sse<impl Stream<Item = Result<Event, Infallible>>> {\n    // 1. subscribe to the broadcast channel\n    // 2. map events to Event with .id() and .event()\n    // 3. map Lagged(_) to a resync event\n    // 4. attach KeepAlive::new().interval(15s)\n    todo!()\n}",
        "hint": "BroadcastStream yields Result<_, BroadcastStreamRecvError>. Use filter_map with an async block: Ok(event) becomes Some(Ok(Event...)), Lagged(missed) becomes Some(Ok(resync)), Closed becomes None.",
        "solution": "use axum::extract::State;\nuse axum::response::sse::{Event, KeepAlive, Sse};\nuse futures_util::stream::{Stream, StreamExt};\nuse std::convert::Infallible;\nuse std::time::Duration;\nuse tokio_stream::wrappers::errors::BroadcastStreamRecvError;\nuse tokio_stream::wrappers::BroadcastStream;\n\npub async fn events(\n    State(state): State<AppState>,\n) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {\n    let receiver = state.events.subscribe(\"orders\");\n\n    let stream = BroadcastStream::new(receiver).filter_map(|message| async move {\n        match message {\n            Ok(event) => Some(Ok(Event::default()\n                .id(event.seq.to_string())\n                .event(\"order_status\")\n                .json_data(event.payload)\n                .expect(\"payload is serializable\"))),\n            Err(BroadcastStreamRecvError::Lagged(missed)) => Some(Ok(Event::default()\n                .event(\"resync\")\n                .data(format!(\"{{\\\"missed\\\":{missed}}}\")))),\n            Err(_) => None,\n        }\n    });\n\n    Sse::new(stream).keep_alive(\n        KeepAlive::new()\n            .interval(Duration::from_secs(15))\n            .text(\"ping\"),\n    )\n}"
      },
      "questions": [
        {
          "q": "An SSE endpoint works locally but disconnects every 60 seconds in production. What is the first thing to fix?",
          "options": [
            "Replace SSE with WebSocket, which has no idle timeout",
            "Send a keep-alive comment every 15-30 seconds and disable proxy response buffering",
            "Increase the server's TCP backlog",
            "Add a Content-Length header so the proxy knows when the stream ends"
          ],
          "answer": 1,
          "explain": "The 60-second value is a load-balancer idle timeout. Keep-alives keep the connection active, and buffering must be disabled or events arrive in bursts - or not at all."
        },
        {
          "q": "A tokio broadcast subscriber returns Lagged(42). What does it mean and what should the endpoint do?",
          "options": [
            "The subscriber was slow to start; wait for it to catch up",
            "Forty-two events were dropped for that subscriber, so emit a resync signal and let it refetch",
            "The channel is closed and the client should reconnect immediately",
            "The server is overloaded and should shed the connection"
          ],
          "answer": 1,
          "explain": "Broadcast buffers are bounded and drop for slow receivers. Those events are gone; the only correct response is to tell the client its view is stale so it can refetch."
        },
        {
          "q": "When is WebSocket the right choice over SSE?",
          "options": [
            "When the payloads are JSON",
            "When the client must send messages on the same long-lived channel",
            "When you need lower latency than HTTP allows",
            "When the server must push updates to many clients"
          ],
          "answer": 1,
          "explain": "Bidirectionality is the differentiator. For pure server push, SSE gives you reconnection and HTTP semantics for free, and lower latency is not a real distinction on the same network."
        }
      ],
      "quickbytes": [
        "SSE for server push, WebSocket for two-way, gRPC streams when both ends are yours and typed.",
        "Keep-alive every 15-30s and buffering off; the 60s disconnect is a proxy timeout, not a bug in your code.",
        "Give every event an id, bound the replay window, and turn Lagged into a resync."
      ],
      "production": [
        "Every stream emits heartbeats faster than the shortest idle timeout in the path.",
        "Proxy and CDN buffering are disabled and verified by observing event timing, not by reading config.",
        "Events carry ids, and resume from Last-Event-ID is bounded and tested.",
        "Per-connection buffers are bounded, and a slow client cannot grow server memory.",
        "Disconnect handling stops upstream polling, verified by a metric on active subscriptions."
      ],
      "crates": [
        "axum",
        "tokio",
        "tokio-stream",
        "futures-util"
      ],
      "github": [
        {
          "name": "axum - Sse, KeepAlive, and streaming responses",
          "url": "https://github.com/tokio-rs/axum"
        },
        {
          "name": "eventsource-stream - client-side SSE parsing with resume",
          "url": "https://github.com/jpopesculian/eventsource-stream"
        }
      ],
      "pitfall": "Streaming through a proxy that buffers the response: events are generated every second but arrive in one burst when the connection closes, so clients show nothing for a minute and then apply a hundred stale updates at once.",
      "resources": [
        {
          "title": "MDN: Using server-sent events",
          "url": "https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events",
          "kind": "docs"
        },
        {
          "title": "axum response::sse module",
          "url": "https://docs.rs/axum/latest/axum/response/sse/index.html",
          "kind": "docs"
        },
        {
          "title": "tokio broadcast channel: lagging receivers and capacity",
          "url": "https://docs.rs/tokio/latest/tokio/sync/broadcast/index.html",
          "kind": "docs"
        },
        {
          "title": "eventsource-stream repository",
          "url": "https://github.com/jpopesculian/eventsource-stream",
          "kind": "repo"
        },
        {
          "title": "CNCF: streaming, messaging, and eventing talks",
          "url": "https://www.youtube.com/@CNCF",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ap16",
      "title": "Webhooks that survive retries",
      "minutes": 85,
      "level": "industry",
      "goal": "Deliver at-least-once with signatures over raw bytes, idempotent receivers, an honest retry schedule, and a delivery log the customer can replay.",
      "sections": [
        {
          "h": "The delivery contract, written honestly",
          "p": [
            "A webhook is an at-least-once, unordered, sometimes duplicated delivery. You cannot promise exactly-once across a network and a customer's process, and you should not imply ordering across endpoints. What you can promise: a stable event id, an event type, `occurred_at`, a per-subject version or sequence, a signature, and a bounded retry schedule. Receivers deduplicate on the event id and discard stale events by comparing the version.",
            "Define the response contract as well. Any 2xx means delivered. 410 means the endpoint is gone, so disable the subscription. Other 4xx are permanent for that payload - retry a couple of times, then disable and notify. 5xx and timeouts are retried with backoff. Without this table, every integration invents its own retry behaviour and the support queue fills with questions about missing events. If a subscription is disabled without a notification, the customer discovers the failure during month-end reconciliation, which is the most expensive possible moment to learn that a feed stopped."
          ],
          "tip": "Send the event id in the body as well as the header. Receivers store the body, and a header-only id disappears the moment someone logs only the payload."
        },
        {
          "h": "Sign the raw bytes, then parse",
          "p": [
            "The Standard Webhooks scheme signs `id.timestamp.body` with HMAC-SHA256 and puts the base64 result in `webhook-signature` as `v1,<signature>`, alongside `webhook-id` and `webhook-timestamp`. Verify with a constant-time comparison, reject timestamps more than five minutes old so a captured delivery cannot be replayed, and read the body as bytes before any JSON parsing.",
            "Signing a re-serialized body is the classic failure. Key order, whitespace, and unicode escaping all change under a parse-and-reserialize round trip, so a valid delivery fails verification - or, if you verify the normalized form, the signature no longer covers what your parser actually sees, which is a request-smuggling surface rather than a bug. Keep the raw bytes and hash those.",
            "During rotation, publish two active secrets and accept a signature that matches either; the header may carry multiple space-separated signatures. Retire the old secret only after every endpoint has acknowledged deliveries signed with the new one. Treat the two-secret window as a required phase rather than an optimisation: a rotation that retires the old secret while an endpoint still verifies with it produces 401s that look exactly like a customer outage."
          ],
          "code": "use axum::http::HeaderMap;\nuse base64::engine::general_purpose::STANDARD;\nuse base64::Engine as _;\nuse hmac::{Hmac, Mac};\nuse sha2::Sha256;\nuse std::time::{SystemTime, UNIX_EPOCH};\nuse subtle::ConstantTimeEq;\n\ntype HmacSha256 = Hmac<Sha256>;\n\n#[derive(Debug, thiserror::Error)]\npub enum WebhookError {\n    #[error(\"missing signature headers\")]\n    MissingHeaders,\n    #[error(\"timestamp outside the tolerance window\")]\n    Stale,\n    #[error(\"signature did not match\")]\n    BadSignature,\n}\n\npub fn verify(secrets: &[&[u8]], headers: &HeaderMap, raw_body: &[u8]) -> Result<(), WebhookError> {\n    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());\n    let id = header(\"webhook-id\").ok_or(WebhookError::MissingHeaders)?;\n    let timestamp = header(\"webhook-timestamp\").ok_or(WebhookError::MissingHeaders)?;\n    let signature = header(\"webhook-signature\").ok_or(WebhookError::MissingHeaders)?;\n\n    let sent_at: i64 = timestamp.parse().map_err(|_| WebhookError::Stale)?;\n    let now = SystemTime::now()\n        .duration_since(UNIX_EPOCH)\n        .expect(\"clock is after 1970\")\n        .as_secs() as i64;\n    if (now - sent_at).abs() > 300 {\n        return Err(WebhookError::Stale); // replay window: five minutes\n    }\n\n    for secret in secrets {\n        let mut mac = HmacSha256::new_from_slice(secret).expect(\"HMAC accepts any key length\");\n        mac.update(id.as_bytes());\n        mac.update(b\".\");\n        mac.update(timestamp.as_bytes());\n        mac.update(b\".\");\n        mac.update(raw_body); // never a re-serialized body\n        let expected = mac.finalize().into_bytes();\n\n        for candidate in signature.split(' ') {\n            let Some(encoded) = candidate.strip_prefix(\"v1,\") else { continue };\n            let Ok(decoded) = STANDARD.decode(encoded) else { continue };\n            if decoded[..].ct_eq(&expected[..]).into() {\n                return Ok(());\n            }\n        }\n    }\n\n    Err(WebhookError::BadSignature)\n}",
          "tip": "Take the body as `Bytes` in the handler, verify, and only then call `serde_json::from_slice`. Extracting `Json<T>` first gives you a parsed body and no raw bytes."
        },
        {
          "h": "Ack fast, persist first, retry with evidence",
          "p": [
            "The receiver's order is: read raw bytes, verify, insert the event id into a dedupe table, return 2xx, then process asynchronously. Acknowledging before persisting loses events on a crash. Processing before acknowledging holds the sender's connection until your slowest side effect finishes, which triggers the sender's timeout and produces a duplicate you then have to dedupe anyway.",
            "The sender's side needs the same discipline. Backoff with jitter and a cap - roughly one minute, five minutes, thirty minutes, two hours, six hours, up to 24 to 72 hours - one in-flight delivery per endpoint if order matters, a circuit breaker so one dead endpoint does not slow the fan-out, and a delivery log with the request, the response status, and a replay button. Disabling after sustained failure without notifying anyone is how a customer discovers the problem when their finance reconciliation fails."
          ],
          "list": [
            "Receiver: raw bytes → verify → insert event id (unique) → 2xx → process",
            "Sender: jittered exponential backoff, bounded total window, per-endpoint breaker",
            "Delivery log with request/response bodies, redacted, retained for the retry window",
            "Manual replay by event id, because the customer's bug is usually on their side"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write the receiver: verify a Standard Webhooks signature over the raw body with a five-minute replay window, deduplicate by event id, and acknowledge before doing the slow work.",
        "starter": "use axum::body::Bytes;\nuse axum::http::HeaderMap;\nuse axum::response::Response;\n\npub async fn receive(headers: HeaderMap, body: Bytes) -> Response {\n    // 1. verify(secrets, &headers, &body)\n    // 2. insert the event id into deliveries(event_id UNIQUE)\n    // 3. return 200 and enqueue processing\n    todo!()\n}",
        "hint": "Extract the raw `Bytes`, verify before any parsing, then `INSERT ... ON CONFLICT (event_id) DO NOTHING`; if rows_affected is 0 the event is a duplicate and should still return 200. Enqueue to an outbox row committed with the insert.",
        "solution": "use axum::body::Bytes;\nuse axum::http::{HeaderMap, StatusCode};\nuse axum::response::{IntoResponse, Response};\nuse sqlx::PgPool;\n\npub async fn receive(\n    pool: &PgPool,\n    secrets: &[&[u8]],\n    headers: HeaderMap,\n    body: Bytes,\n) -> Response {\n    if verify(secrets, &headers, &body).is_err() {\n        // 401, not 400: the payload may be fine, the credential is not.\n        return StatusCode::UNAUTHORIZED.into_response();\n    }\n\n    let Some(event_id) = headers.get(\"webhook-id\").and_then(|v| v.to_str().ok()) else {\n        return StatusCode::BAD_REQUEST.into_response();\n    };\n\n    // Insert and enqueue in one transaction: the event is durable before the\n    // sender receives a 2xx, so a crash cannot lose an acknowledged delivery.\n    let mut tx = match pool.begin().await {\n        Ok(tx) => tx,\n        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),\n    };\n\n    let inserted = sqlx::query(\n        r#\"INSERT INTO webhook_events (event_id, payload)\n           VALUES ($1, $2)\n           ON CONFLICT (event_id) DO NOTHING\"#,\n    )\n    .bind(event_id)\n    .bind(body.as_ref())\n    .execute(&mut *tx)\n    .await;\n\n    match inserted {\n        Ok(result) if result.rows_affected() == 1 => {\n            let _ = sqlx::query(\"INSERT INTO webhook_queue (event_id) VALUES ($1)\")\n                .bind(event_id)\n                .execute(&mut *tx)\n                .await;\n        }\n        // Duplicate delivery: still a success from the sender's point of view.\n        Ok(_) => return StatusCode::OK.into_response(),\n        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),\n    }\n\n    if tx.commit().await.is_err() {\n        return StatusCode::INTERNAL_SERVER_ERROR.into_response();\n    }\n    StatusCode::OK.into_response()\n}"
      },
      "questions": [
        {
          "q": "You verify the signature against `serde_json::to_string(&payload)` instead of the raw body. What happens?",
          "options": [
            "Nothing, JSON serialization is deterministic in serde",
            "Verification fails whenever key order, whitespace, or escaping differs from the sender's bytes",
            "The signature becomes stronger because it covers normalized data",
            "The request is rejected with 413"
          ],
          "answer": 1,
          "explain": "serde_json preserves struct order but not arbitrary incoming order, and escaping can differ. Signatures cover bytes, so normalization breaks them - or worse, verifies something the parser never sees."
        },
        {
          "q": "Why acknowledge a webhook before running the slow business logic?",
          "options": [
            "Because the sender retries only on 5xx, so speed does not matter",
            "Because a slow ack hits the sender's timeout, which produces a duplicate delivery for work already in progress",
            "Because HTTP requires a response within 100 ms",
            "Because the payload is discarded after the response"
          ],
          "answer": 1,
          "explain": "Timeouts are indistinguishable from failures at the sender, so it retries. Persist the event, ack, then process - that ordering gives you at-least-once without holding the sender's connection."
        },
        {
          "q": "What must a timestamp in the signature scheme prevent?",
          "options": [
            "Clock skew between sender and receiver",
            "Replay of a captured delivery long after it was sent",
            "Delivery of events out of order",
            "Signature collisions between two events"
          ],
          "answer": 1,
          "explain": "Including the timestamp in the signed content and rejecting old timestamps bounds the replay window. Without it, a captured request can be resent forever and passes verification."
        }
      ],
      "quickbytes": [
        "Sign id.timestamp.raw_body with HMAC-SHA256; verify with constant-time compare and a five-minute window.",
        "Receiver order: verify, persist with a unique event id, ack, then process.",
        "Publish the response table (2xx/410/4xx/5xx) or every integrator invents a different retry policy."
      ],
      "production": [
        "Every delivery carries a stable event id, a type, occurred_at, and a version or sequence.",
        "Signatures are verified over raw bytes, and the replay window is under ten minutes.",
        "Secret rotation supports two active secrets and is exercised in a test.",
        "Delivery logs retain request and response for the full retry window with redacted payloads.",
        "Endpoints that fail repeatedly are disabled with a notification, never silently dropped."
      ],
      "crates": [
        "hmac",
        "sha2",
        "subtle",
        "base64"
      ],
      "github": [
        {
          "name": "standard-webhooks - the signature scheme and reference implementations",
          "url": "https://github.com/standard-webhooks/standard-webhooks"
        },
        {
          "name": "RustCrypto MACs - hmac and constant-time verification",
          "url": "https://github.com/RustCrypto/MACs"
        }
      ],
      "pitfall": "Returning 200 immediately and then doing the work in the request task with no persistence: the process restarts mid-handler, the sender believes delivery succeeded, and the event is gone with no retry and no record.",
      "resources": [
        {
          "title": "Standard Webhooks specification and reference code",
          "url": "https://github.com/standard-webhooks/standard-webhooks",
          "kind": "repo"
        },
        {
          "title": "hmac crate documentation",
          "url": "https://docs.rs/hmac/latest/hmac/",
          "kind": "docs"
        },
        {
          "title": "RustCrypto MACs repository",
          "url": "https://github.com/RustCrypto/MACs",
          "kind": "repo"
        },
        {
          "title": "base64 crate: engines and padding rules",
          "url": "https://docs.rs/base64/latest/base64/",
          "kind": "docs"
        },
        {
          "title": "InfoQ: webhook reliability and event-driven integration talks",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ap17",
      "title": "SDK design: generated clients people keep",
      "minutes": 80,
      "level": "industry",
      "goal": "Generate the wire layer from the spec, hand-write the ergonomics, and make retries, timeouts, pagination, and errors behave the way callers assume.",
      "sections": [
        {
          "h": "What belongs to the generator, and what does not",
          "p": [
            "Generate types, serialization, URL construction, auth headers, and one method per operation. Hand-write the retry policy, pagination iterators, error classification, and the configuration surface. A generator that also owns policy is impossible to change without regenerating, while hand-written serialization drifts from the published spec within a release or two.",
            "progenitor reads an OpenAPI 3.0.x document and emits a `Client` with a method per operation, `Stream`s for paginated interfaces, a positional or builder argument style, tag-separated extension traits, pre- and post-hooks for headers and logging, and a configurable default timeout. That is a solid baseline; the missing twenty percent is where your product's opinions belong."
          ],
          "code": "progenitor::generate_api!(\n    spec = \"openapi.json\",\n    interface = Builder,\n    tags = Separate,\n    derives = [schemars::JsonSchema],\n    timeout = 30, // seconds, applied to the underlying reqwest client\n    pre_hook = (|request: &mut reqwest::Request| {\n        request.headers_mut().insert(\n            \"user-agent\",\n            reqwest::header::HeaderValue::from_static(concat!(\n                \"acme-rust/\",\n                env!(\"CARGO_PKG_VERSION\")\n            )),\n        );\n    }),\n);\n\n// Generated at compile time from the checked-in spec: if the spec is not a\n// valid OpenAPI 3.0.x document, this crate does not build. That is the point.\nfn client(base_url: &str) -> Client {\n    Client::new(base_url)\n}",
          "tip": "Check the spec into the SDK repository and regenerate in CI. Fetching it at build time makes builds non-reproducible and turns an API outage into an SDK release failure."
        },
        {
          "h": "Ergonomics that decide adoption",
          "p": [
            "Errors should be a typed enum exposing the status, the parsed problem body, the request id, and an `is_retryable()` predicate - not a formatted string. Timeouts should be configurable and finite by default. Pagination should be an iterator or stream, so callers never write a cursor loop by hand. Auth should support refresh without reconstructing the client, and the base URL must be settable for staging, tests, and self-hosted deployments.",
            "Retries deserve the most care. Default them off for POST unless the caller supplies an idempotency key, on for GET, with full jitter, three or four attempts, and `Retry-After` honoured over any computed delay. Then add the one convenience that prevents the most damage: a helper that generates the key once per logical operation and reuses it across attempts, because the retry loop is exactly where callers get it wrong."
          ],
          "code": "use std::time::Duration;\n\n#[derive(Debug, thiserror::Error)]\npub enum SdkError {\n    #[error(\"transport error: {0}\")]\n    Transport(#[from] reqwest::Error),\n    #[error(\"api error {status}: {code}\")]\n    Api {\n        status: u16,\n        code: String,\n        request_id: Option<String>,\n        retry_after: Option<Duration>,\n    },\n}\n\nimpl SdkError {\n    pub fn is_retryable(&self) -> bool {\n        match self {\n            Self::Transport(error) => error.is_timeout() || error.is_connect(),\n            Self::Api { status, .. } => matches!(*status, 429 | 500 | 502 | 503 | 504),\n        }\n    }\n\n    pub fn retry_after(&self) -> Option<Duration> {\n        if let Self::Api { retry_after, .. } = self { *retry_after } else { None }\n    }\n}\n\npub struct RetryPolicy { pub max_attempts: u32, pub base: Duration, pub cap: Duration }\n\nimpl RetryPolicy {\n    /// `attempt` receives the idempotency key and MUST reuse it on every call.\n    pub async fn run<T, F, Fut>(&self, key: &str, mut attempt: F) -> Result<T, SdkError>\n    where\n        F: FnMut(&str) -> Fut,\n        Fut: std::future::Future<Output = Result<T, SdkError>>,\n    {\n        let mut tries = 0;\n        loop {\n            tries += 1;\n            match attempt(key).await {\n                Ok(value) => return Ok(value),\n                Err(error) if tries < self.max_attempts && error.is_retryable() => {\n                    tokio::time::sleep(self.delay(tries, error.retry_after())).await;\n                }\n                Err(error) => return Err(error),\n            }\n        }\n    }\n\n    fn delay(&self, tries: u32, retry_after: Option<Duration>) -> Duration {\n        // A server-provided delay always wins over a computed one.\n        if let Some(after) = retry_after {\n            return after.min(self.cap);\n        }\n        let ceiling = self.base.saturating_mul(1u32 << tries.min(6)).min(self.cap);\n        ceiling.mul_f64(rand::random::<f64>()) // full jitter\n    }\n}",
          "tip": "Log every retry with attempt number, status, and computed delay. A silent retry loop is indistinguishable from a slow API in a customer's traces."
        },
        {
          "h": "Versioning the SDK against the API",
          "p": [
            "The crate version follows semver for the Rust API; the API version it targets is a separate, documented window. A patch release that follows a server change is fine as long as it does not break compilation; a new required field is a minor or major depending on whether callers construct the struct. Say which, in the changelog, every time.",
            "Test the SDK against a recorded mock of the previous API version, not only against today's server. That catches accidental dependence on a field that was added last week and would break every customer still talking to an older deployment. Pin an MSRV, run it in CI, and keep the generated code in its own module so `git blame` points at the spec change rather than a hand edit."
          ],
          "list": [
            "Crate version: semver for the Rust surface; API version: separately documented",
            "Changelog distinguishes wire-contract changes from Rust API changes",
            "Contract tests run against today's spec and the previous version's fixture",
            "Generated code is isolated; the spec file is the reviewable artifact"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a retry policy for an SDK: max four attempts, full jitter, honour Retry-After, retry only retryable errors, and take the idempotency key from the caller so every attempt reuses it.",
        "starter": "use std::time::Duration;\n\npub struct RetryPolicy {\n    pub max_attempts: u32,\n    pub base: Duration,\n    pub cap: Duration,\n}\n\nimpl RetryPolicy {\n    pub async fn run<T, F, Fut>(&self, key: &str, attempt: F) -> Result<T, SdkError>\n    where\n        F: FnMut(&str) -> Fut,\n        Fut: std::future::Future<Output = Result<T, SdkError>>,\n    {\n        todo!()\n    }\n}",
        "hint": "Loop with an attempt counter, call attempt(key), and on a retryable error sleep min(retry_after, cap) or base * 2^attempt * rand(). Return the error immediately when the counter hits max_attempts or the error is permanent.",
        "solution": "use std::time::Duration;\n\npub struct RetryPolicy {\n    pub max_attempts: u32,\n    pub base: Duration,\n    pub cap: Duration,\n}\n\nimpl RetryPolicy {\n    pub async fn run<T, F, Fut>(&self, key: &str, mut attempt: F) -> Result<T, SdkError>\n    where\n        F: FnMut(&str) -> Fut,\n        Fut: std::future::Future<Output = Result<T, SdkError>>,\n    {\n        let mut tries = 0;\n        loop {\n            tries += 1;\n            match attempt(key).await {\n                Ok(value) => return Ok(value),\n                Err(error) if tries < self.max_attempts && error.is_retryable() => {\n                    let delay = match error.retry_after() {\n                        Some(after) => after.min(self.cap),\n                        None => {\n                            let ceiling = self\n                                .base\n                                .saturating_mul(1u32 << tries.min(6))\n                                .min(self.cap);\n                            ceiling.mul_f64(rand::random::<f64>())\n                        }\n                    };\n                    tracing::warn!(\n                        attempt = tries,\n                        delay_ms = delay.as_millis() as u64,\n                        \"retrying request\"\n                    );\n                    tokio::time::sleep(delay).await;\n                }\n                Err(error) => return Err(error),\n            }\n        }\n    }\n}"
      },
      "questions": [
        {
          "q": "Where should the idempotency key for a POST be created in an SDK?",
          "options": [
            "Inside the retry loop, one fresh key per attempt",
            "Once per logical operation, before the first attempt, and passed to every retry",
            "By the server, derived from the request body",
            "Only when the caller opts into retries at the transport level"
          ],
          "answer": 1,
          "explain": "The key must be stable across attempts or it protects nothing. Passing it into the retry function makes that impossible to get wrong."
        },
        {
          "q": "Which behaviour should an SDK have by default for a POST without an idempotency key?",
          "options": [
            "Retry three times with backoff, like GET",
            "Do not retry automatically; surface the ambiguous error to the caller",
            "Retry only on 500, since duplicates are harmless",
            "Retry once immediately, then give up"
          ],
          "answer": 1,
          "explain": "A retried POST without a key can duplicate a side effect. Automatic retries are only safe when the operation is idempotent by method or by key."
        },
        {
          "q": "Why expose pagination as a `Stream` rather than a function returning a page?",
          "options": [
            "Streams are faster because they avoid allocations",
            "Callers stop hand-rolling cursor loops, which is where termination and filter-change bugs live",
            "A page cannot be serialized without a stream",
            "It lets the server push new pages without a request"
          ],
          "answer": 1,
          "explain": "The cursor loop is boilerplate that every caller writes slightly wrong. A stream owns termination (`next_cursor: null`) and surfaces invalid-cursor errors in one place."
        }
      ],
      "quickbytes": [
        "Generate the wire layer, hand-write the policy: retries, pagination, errors, config.",
        "Retry-After beats computed backoff, and full jitter beats a fixed multiplier.",
        "Check the spec into the SDK and regenerate in CI; build-time fetching makes builds non-reproducible."
      ],
      "production": [
        "The SDK compiles against the checked-in spec, and a spec change that breaks codegen fails the build.",
        "Errors are typed with status, code, request id, and an is_retryable predicate.",
        "Retries are disabled by default for non-idempotent calls and honour Retry-After when enabled.",
        "Pagination is exposed as a stream with documented termination and invalid-cursor behaviour.",
        "The SDK is tested against a fixture of the previous API version and a pinned MSRV."
      ],
      "crates": [
        "progenitor",
        "reqwest",
        "tokio",
        "thiserror"
      ],
      "github": [
        {
          "name": "progenitor - OpenAPI client generation for Rust",
          "url": "https://github.com/oxidecomputer/progenitor"
        },
        {
          "name": "reqwest - the HTTP client the generated code uses",
          "url": "https://github.com/seanmonstar/reqwest"
        }
      ],
      "pitfall": "An SDK that retries POST three times by default without generating an idempotency key: packet loss creates three orders, and the customer's support ticket says your API is duplicating data.",
      "resources": [
        {
          "title": "progenitor crate documentation",
          "url": "https://docs.rs/progenitor/latest/progenitor/",
          "kind": "docs"
        },
        {
          "title": "progenitor generate_api! options: hooks, interface, tags, timeout",
          "url": "https://docs.rs/progenitor/latest/progenitor/macro.generate_api.html",
          "kind": "docs"
        },
        {
          "title": "progenitor repository and example specifications",
          "url": "https://github.com/oxidecomputer/progenitor",
          "kind": "repo"
        },
        {
          "title": "reqwest documentation: timeouts, retries, and connection pools",
          "url": "https://docs.rs/reqwest/latest/reqwest/",
          "kind": "docs"
        },
        {
          "title": "GOTO: client library and SDK design talks",
          "url": "https://www.youtube.com/@GOTO-",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ap18",
      "title": "OpenAPI as a build artifact",
      "minutes": 75,
      "level": "industry",
      "goal": "Generate the spec from the handlers, snapshot it in tests, serve it from the same router, and treat a diff in the published document as a reviewable contract change.",
      "sections": [
        {
          "h": "Code-first, spec-first, or the honest middle",
          "p": [
            "Code-first keeps types and documentation in one place: `#[utoipa::path]` on the handler, `ToSchema` on the type, and `OpenApiRouter::routes!` collecting both the route and its documentation, so a handler is either wired and documented or absent. Spec-first lets you review the contract before writing code and generate stubs and clients, but it drifts from the server unless the server is generated from it or contract-tested against it.",
            "The middle path is what most teams can actually sustain: generate the document from the code, snapshot it in tests, publish the artifact, and generate clients from the artifact. Drift then has three chances to fail - the snapshot diff, the client compile, and the deployment check - instead of one review that everyone is too busy to do."
          ],
          "tip": "A spec that is not regenerated in CI is documentation, not a contract. The build has to be able to fail on a diff."
        },
        {
          "h": "The 3.1 details that change tooling behaviour",
          "p": [
            "OpenAPI 3.1 aligns with JSON Schema 2020-12: nullability is `type: [\"string\", \"null\"]` rather than a `nullable` flag, `examples` is an array, `webhooks` is a top-level field, and `jsonSchemaDialect` is settable. That is better modelling, and it breaks tooling: progenitor targets 3.0.x, so a 3.1-only document may fail to generate a client. Know which version each consumer of the artifact actually supports.",
            "Document the parts clients need beyond the happy path: the problem+json error component with its stable `type` values, the security scheme, the `Idempotency-Key` header parameter, pagination request and response shapes, rate-limit headers, and the deprecation headers. A document with only 200 responses is a brochure, and the generated client will have no error surface at all."
          ],
          "list": [
            "Every endpoint documents at least one 4xx with a problem+json schema",
            "Reusable components for Error, Page, and the idempotency header parameter",
            "Servers list includes the sandbox, because examples are run against it",
            "Version and generator are pinned, and the artefact records both"
          ]
        },
        {
          "h": "Serve it, snapshot it, diff it",
          "p": [
            "Serve `/openapi.json` from the same router that serves the API, built once at startup, so the published document cannot describe an older deployment. Snapshot it with insta: the snapshot file is the reviewed contract, and a field rename shows up as a readable diff in the pull request. Then make CI regenerate the document and fail when the working tree changes.",
            "Add the checks that catch lies. A test that every registered route appears in the document and every documented path is registered catches the most common drift. A codegen test that compiles a client from the artifact proves the document is machine-consumable. And an example test that asserts the documented request bodies deserialize into the handler's types catches the spec that says `string` where the code wants an object."
          ],
          "code": "use axum::{routing::get, Json, Router};\nuse utoipa::OpenApi;\nuse utoipa_axum::router::OpenApiRouter;\nuse utoipa_axum::routes;\n\npub fn api_router(state: AppState) -> Router {\n    // routes! collects the handler AND its #[utoipa::path] documentation.\n    let (router, openapi) = OpenApiRouter::new()\n        .routes(routes!(list_orders, create_order, get_order))\n        .split_for_parts();\n    // Built once at startup: the served document cannot lag the deployment.\n    let spec = openapi.clone();\n\n    router\n        .route(\n            \"/openapi.json\",\n            get(move || {\n                let spec = spec.clone();\n                async move { Json(spec) }\n            }),\n        )\n        .with_state(state)\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn contract_changes_are_reviewed_as_a_diff() {\n        let (_, openapi) = OpenApiRouter::new()\n            .routes(routes!(list_orders, create_order, get_order))\n            .split_for_parts();\n        insta::assert_json_snapshot!(\n            \"openapi\",\n            serde_json::to_value(&openapi).expect(\"the document is serializable\")\n        );\n    }\n\n    const ROUTES: [&str; 3] = [\"/orders\", \"/orders/{id}\", \"/orders/{id}/items\"];\n    #[test]\n    fn documented_paths_match_the_registered_set() {\n        let (_, openapi) = OpenApiRouter::new()\n            .routes(routes!(list_orders, create_order, get_order))\n            .split_for_parts();\n        let document = serde_json::to_value(&openapi).expect(\"serializable\");\n        let mut documented: Vec<&str> = document[\"paths\"]\n            .as_object()\n            .expect(\"paths object\")\n            .keys()\n            .map(String::as_str)\n            .collect();\n        documented.sort_unstable();\n        // ROUTES lives beside the router; this fails when only one side moves.\n        let mut registered = ROUTES.to_vec();\n        registered.sort_unstable();\n        assert_eq!(documented, registered);\n    }\n}",
          "tip": "Keep the snapshot file in the repository and review its diff like code. A 400-line snapshot change in a feature PR is the cheapest breaking-change detector you will ever get."
        }
      ],
      "exercise": {
        "prompt": "Expose the generated OpenAPI document at /openapi.json, and add a test that fails when the document no longer matches the committed snapshot.",
        "starter": "use axum::{routing::get, Json, Router};\n\npub fn api_router(state: AppState) -> Router {\n    let (router, openapi) = OpenApiRouter::new()\n        .routes(routes!(list_orders, get_order))\n        .split_for_parts();\n    // 1. serve openapi at /openapi.json\n    // 2. add a snapshot test\n    todo!()\n}",
        "hint": "Clone the OpenApi into the closure that serves the route, then use insta::assert_json_snapshot! with serde_json::to_value. Run `cargo insta review` to accept an intended change, and never accept one by deleting the snapshot.",
        "solution": "use axum::{routing::get, Json, Router};\nuse utoipa::OpenApi;\nuse utoipa_axum::router::OpenApiRouter;\nuse utoipa_axum::routes;\n\npub fn api_router(state: AppState) -> Router {\n    let (router, openapi) = OpenApiRouter::new()\n        .routes(routes!(list_orders, get_order))\n        .split_for_parts();\n\n    let spec = openapi.clone();\n    router\n        .route(\n            \"/openapi.json\",\n            get(move || {\n                let spec = spec.clone();\n                async move { Json(spec) }\n            }),\n        )\n        .with_state(state)\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn openapi_snapshot_is_reviewed() {\n        let (_, openapi) = OpenApiRouter::new()\n            .routes(routes!(list_orders, get_order))\n            .split_for_parts();\n        insta::assert_json_snapshot!(\n            \"openapi\",\n            serde_json::to_value(&openapi).expect(\"serializable\")\n        );\n    }\n\n    #[test]\n    fn spec_declares_problem_json_errors() {\n        let (_, openapi) = OpenApiRouter::new()\n            .routes(routes!(list_orders, get_order))\n            .split_for_parts();\n        let json = serde_json::to_value(&openapi).expect(\"serializable\");\n        assert!(\n            json[\"components\"][\"schemas\"][\"Problem\"].is_object(),\n            \"every endpoint must reference the shared Problem schema\"\n        );\n    }\n}"
      },
      "questions": [
        {
          "q": "The spec is generated from the handlers. What can still be wrong?",
          "options": [
            "Nothing, generation guarantees the document matches runtime behaviour",
            "Annotations can lie: missing 4xx responses, stale examples, undocumented headers, wrong content types",
            "Only the version field can drift",
            "The paths are correct but the server always returns different status codes"
          ],
          "answer": 1,
          "explain": "Generation guarantees the document matches your annotations, not your behaviour. Contract tests that assert documented responses and example bodies are what close the gap."
        },
        {
          "q": "Why snapshot the generated document in the repository?",
          "options": [
            "Snapshots make the test suite faster",
            "The diff becomes the reviewed record of a contract change",
            "insta is required to serve the document at runtime",
            "It removes the need for API versioning"
          ],
          "answer": 1,
          "explain": "A reviewed diff is how a removed field or changed default gets noticed before it ships. The snapshot is the contract's history, and deleting it to make CI pass removes that history."
        },
        {
          "q": "You publish an OpenAPI 3.1 document, but your client generator targets 3.0.x. What is the likely outcome?",
          "options": [
            "The generator upgrades itself and emits 3.1 types",
            "Client generation fails or silently mis-models 3.1-only constructs such as type arrays for nullability",
            "The document is automatically down-converted by the server",
            "Nothing changes, since 3.0 and 3.1 are wire-compatible"
          ],
          "answer": 1,
          "explain": "3.1 changes the schema dialect. Tools that predate it treat type arrays and webhooks as unknown constructs, so know which version each consumer supports before publishing."
        }
      ],
      "quickbytes": [
        "Generate, snapshot, serve from the same router: three independent chances to catch drift.",
        "A spec with only 200 responses gives every generated client an empty error surface.",
        "Pin the OpenAPI version your generators consume; 3.1 features can break 3.0-only tooling."
      ],
      "production": [
        "The document is generated in CI and the build fails on an uncommitted diff.",
        "Every route in the router appears in the document, and every documented path exists.",
        "Every endpoint declares at least one 4xx with the shared problem+json schema.",
        "A client is generated from the artifact as part of the build, proving it is machine-consumable.",
        "The served document is built once at startup from the same router that serves traffic."
      ],
      "crates": [
        "utoipa",
        "utoipa-axum",
        "axum",
        "insta"
      ],
      "github": [
        {
          "name": "utoipa - compile-time OpenAPI generation",
          "url": "https://github.com/juhaku/utoipa"
        },
        {
          "name": "OpenAPI-Specification - the 3.1 schema and guidance",
          "url": "https://github.com/OAI/OpenAPI-Specification"
        }
      ],
      "pitfall": "Maintaining a hand-edited openapi.yaml next to the code: it is correct on the day it is written, drifts within a sprint, and every generated client calls routes that were renamed months ago while nobody reads the pull request that changed them.",
      "resources": [
        {
          "title": "utoipa crate documentation",
          "url": "https://docs.rs/utoipa/latest/utoipa/",
          "kind": "docs"
        },
        {
          "title": "utoipa-axum - OpenApiRouter and routes!",
          "url": "https://docs.rs/utoipa-axum/latest/utoipa_axum/",
          "kind": "docs"
        },
        {
          "title": "OpenAPI Specification repository",
          "url": "https://github.com/OAI/OpenAPI-Specification",
          "kind": "repo"
        },
        {
          "title": "insta - snapshot testing for the generated document",
          "url": "https://docs.rs/insta/latest/insta/",
          "kind": "docs"
        },
        {
          "title": "utoipa repository: examples for axum and actix-web",
          "url": "https://github.com/juhaku/utoipa",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "ap19",
      "title": "Developer experience: time to first 200",
      "minutes": 60,
      "level": "core",
      "goal": "Measure and shrink the path from signup to a successful write, and make every published example executable in CI so the docs cannot rot.",
      "sections": [
        {
          "h": "The one metric worth optimising",
          "p": [
            "Time to first successful write: signup, key, copy the curl, receive a 201 with a real object. Target under five minutes with no human in the loop. Measure the share of new keys that reach a non-GET success within 24 hours, plus the p50 and p90 of that first success. NPS tells you how people feel about the API; this tells you whether they got it working.",
            "Every step that needs a human - a sales call, manual key approval, a sandbox that must be provisioned - is a step where a large fraction of developers leave and never come back. Sandbox keys that never expire, deterministic fixture data, and no real money are not politeness; they are the difference between an evaluation and an abandoned tab."
          ],
          "tip": "Watch a stranger integrate with your API once a quarter. The friction they hit is not in your documentation, because they never got that far."
        },
        {
          "h": "Errors and examples are the documentation",
          "p": [
            "The error message is documentation at the exact moment someone needs it. Name the field, the rule, the documentation link, and the request id: `items[0].quantity` must be at least 1 (docs: /docs/orders#quantity), request id 01J8Z... is a fix. `invalid request` is a support ticket that costs you twenty minutes and the customer a day.",
            "Every published example must run in CI against the sandbox, or it is prose that will be wrong within a quarter. Execute the quickstart, the curl snippets in the reference, and the SDK sample in a nightly job; a failing documentation example should block a release just like a failing test. Then track 4xx responses by endpoint and error code - the most frequent confusing error is your next documentation page, and it is a better roadmap than any survey."
          ],
          "code": "#[tokio::test]\nasync fn quickstart_from_the_docs_still_works() {\n    let base = std::env::var(\"ACME_BASE_URL\").expect(\"set ACME_BASE_URL to the sandbox\");\n    let key = std::env::var(\"ACME_TEST_KEY\").expect(\"sandbox keys never expire\");\n\n    let client = reqwest::Client::builder()\n        .timeout(std::time::Duration::from_secs(5))\n        .build()\n        .expect(\"client builds\");\n\n    // Byte for byte the snippet printed in the quickstart, including the header.\n    let response = client\n        .post(format!(\"{base}/v1/orders\"))\n        .bearer_auth(&key)\n        .header(\"Idempotency-Key\", \"quickstart-demo-1\")\n        .json(&serde_json::json!({\n            \"items\": [{ \"sku\": \"sku_demo\", \"quantity\": 1 }]\n        }))\n        .send()\n        .await\n        .expect(\"sandbox reachable\");\n\n    assert_eq!(response.status(), 201, \"the docs promise 201 plus Location\");\n    assert!(response.headers().contains_key(\"location\"));\n    let order: serde_json::Value = response.json().await.expect(\"json body\");\n    assert!(order[\"id\"].is_string());\n\n    // Replaying the same request must return the same order, not a second one.\n    let replay = client\n        .post(format!(\"{base}/v1/orders\"))\n        .bearer_auth(&key)\n        .header(\"Idempotency-Key\", \"quickstart-demo-1\")\n        .json(&serde_json::json!({\n            \"items\": [{ \"sku\": \"sku_demo\", \"quantity\": 1 }]\n        }))\n        .send()\n        .await\n        .expect(\"sandbox reachable\");\n\n    assert_eq!(replay.status(), 201);\n    let replayed: serde_json::Value = replay.json().await.expect(\"json body\");\n    assert_eq!(replayed[\"id\"], order[\"id\"], \"a replayed key must not create a second order\");\n}",
          "tip": "Print the request id in every error message and put it in the copyable text. Customers paste it into tickets, and your logs become searchable instead of a guessing game."
        },
        {
          "h": "The surface around the endpoint",
          "p": [
            "Integrators need more than a route: a status page with history, a changelog with an RSS feed, deprecation notices surfaced in the dashboard rather than only in email, the OpenAPI document, a Postman collection, and SDKs in the languages your customers actually use. Add webhook replay in the dashboard so a customer can debug their own handler without opening a ticket.",
            "Treat support as a measurement channel. Tag every ticket with endpoint and error code, review the top five each month, and fix the contract rather than the individual case. If three customers misread the same field, the field's name is wrong; if four hit the same 422, the validation message is wrong. That loop is the whole of developer experience, and it compounds."
          ],
          "list": [
            "Sandbox with deterministic fixtures, non-expiring test keys, and a nightly reset",
            "Changelog with RSS, plus deprecation notices in the dashboard",
            "Status page with incident history, linked from every error page",
            "Webhook replay and delivery logs visible to the customer",
            "A docs example test in the release pipeline"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write the CI test that executes your published quickstart: create an order in the sandbox, assert 201 and a Location header, then replay the same idempotency key and assert the same order id.",
        "starter": "#[tokio::test]\nasync fn quickstart_from_the_docs_still_works() {\n    // 1. read base URL and test key from the environment\n    // 2. POST the exact documented body with an Idempotency-Key\n    // 3. assert 201 + Location, then replay and assert the same id\n}",
        "hint": "Use reqwest::Client with a short timeout, bearer_auth for the key, and serde_json::json! for the body. Assert on the status and the Location header, then reuse the same key for the second call and compare ids.",
        "solution": "#[tokio::test]\nasync fn quickstart_from_the_docs_still_works() {\n    let base = std::env::var(\"ACME_BASE_URL\").expect(\"set ACME_BASE_URL\");\n    let key = std::env::var(\"ACME_TEST_KEY\").expect(\"set ACME_TEST_KEY\");\n\n    let client = reqwest::Client::builder()\n        .timeout(std::time::Duration::from_secs(5))\n        .build()\n        .expect(\"client builds\");\n\n    let body = serde_json::json!({\n        \"items\": [{ \"sku\": \"sku_demo\", \"quantity\": 1 }]\n    });\n\n    let first = client\n        .post(format!(\"{base}/v1/orders\"))\n        .bearer_auth(&key)\n        .header(\"Idempotency-Key\", \"docs-quickstart-1\")\n        .json(&body)\n        .send()\n        .await\n        .expect(\"sandbox reachable\");\n\n    assert_eq!(first.status(), 201, \"the quickstart promises 201\");\n    assert!(first.headers().contains_key(\"location\"), \"201 must carry Location\");\n    let order: serde_json::Value = first.json().await.expect(\"json body\");\n\n    let second = client\n        .post(format!(\"{base}/v1/orders\"))\n        .bearer_auth(&key)\n        .header(\"Idempotency-Key\", \"docs-quickstart-1\")\n        .json(&body)\n        .send()\n        .await\n        .expect(\"sandbox reachable\");\n\n    assert_eq!(second.status(), 201, \"a replay returns the stored response\");\n    let replayed: serde_json::Value = second.json().await.expect(\"json body\");\n    assert_eq!(replayed[\"id\"], order[\"id\"], \"replay must not create a second order\");\n    assert!(\n        second.headers().get(\"idempotent-replayed\").is_some(),\n        \"replays are marked so support can recognise them\"\n    );\n}"
      },
      "questions": [
        {
          "q": "Which metric best captures whether your API is actually adoptable?",
          "options": [
            "Monthly active API keys",
            "The share of new keys that reach a successful non-GET call within 24 hours, and the time it took",
            "Average developer NPS from the quarterly survey",
            "Number of SDK downloads from the registry"
          ],
          "answer": 1,
          "explain": "Keys and downloads measure intent. A key that never makes a successful write measures a broken onboarding path, which is the thing you can fix."
        },
        {
          "q": "A validation failure returns `{\"error\": \"invalid request\"}`. What is missing?",
          "options": [
            "A different HTTP status code",
            "The field pointer, the violated rule, a documentation link, and a request id",
            "A stack trace so the developer can see where it failed",
            "The full request body echoed back for debugging"
          ],
          "answer": 1,
          "explain": "The developer already knows the request failed. They need to know which field, which rule, where to read more, and what to quote to support - without leaking internals."
        },
        {
          "q": "Why must documentation examples run in CI?",
          "options": [
            "Because documentation builds require network access",
            "Because examples are code and rot silently; a test is the only thing that notices",
            "Because the OpenAPI generator validates examples",
            "Because SDKs are generated from the documentation site"
          ],
          "answer": 1,
          "explain": "A stale example is indistinguishable from a wrong API until someone runs it. Executing the quickstart nightly turns a support ticket into a failed build."
        }
      ],
      "quickbytes": [
        "Optimise signup-to-first-201; every human step in that path loses a large share of evaluators.",
        "Error messages need field, rule, doc link, and request id; anything less becomes a ticket.",
        "Run the quickstart in CI against the sandbox - documentation that is not executed is fiction."
      ],
      "production": [
        "A nightly job executes the quickstart and every reference example against the sandbox.",
        "Test keys never expire and the sandbox data resets on a published schedule.",
        "4xx rates are broken down by endpoint and error code, and the top confusing error is reviewed monthly.",
        "Every error response includes a request id and a documentation link.",
        "The changelog and deprecation notices are surfaced in the dashboard, not only in email."
      ],
      "crates": [
        "reqwest",
        "tokio",
        "serde_json",
        "axum"
      ],
      "github": [
        {
          "name": "reqwest - the client used by the docs smoke test",
          "url": "https://github.com/seanmonstar/reqwest"
        },
        {
          "name": "axum - the server behind the sandbox",
          "url": "https://github.com/tokio-rs/axum"
        }
      ],
      "pitfall": "A quickstart that creates a real charge with a production key: the first thing a new developer does is spend money, and the second thing is file a ticket asking how to undo it.",
      "resources": [
        {
          "title": "reqwest documentation: client builder, timeouts, and JSON",
          "url": "https://docs.rs/reqwest/latest/reqwest/",
          "kind": "docs"
        },
        {
          "title": "reqwest repository",
          "url": "https://github.com/seanmonstar/reqwest",
          "kind": "repo"
        },
        {
          "title": "MDN: CORS guide, the first wall a browser integrator hits",
          "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS",
          "kind": "docs"
        },
        {
          "title": "Google Developers: API onboarding and developer experience talks",
          "url": "https://www.youtube.com/@GoogleDevelopers",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ap20",
      "title": "The API review checklist",
      "minutes": 70,
      "level": "industry",
      "goal": "Run a launch gate of at most fifteen items, each backed by an automated check or a named owner, and retire a checklist that nobody can fail.",
      "sections": [
        {
          "h": "Fifteen items, each with evidence",
          "p": [
            "A checklist earns its keep only if every line is falsifiable. Each item states what must be true and how a reviewer knows: a test name, a CI job, a link in the pull request, or a named owner's written answer. If nothing can fail the item, delete it - an unverifiable checkbox trains people to click through the whole document, which is worse than having none.",
            "Cover the surface once: contract, semantics, errors, pagination, limits, auth, idempotency, compatibility, observability, docs, SDK, launch. Twelve to fifteen lines total; if it grows past that, split it into a design review and a launch review rather than adding a page nobody reads."
          ],
          "list": [
            "Every route is documented, authenticated, and has an owner and an SLO",
            "Every 4xx has a stable code, a problem+json body, and a documentation link",
            "Every list endpoint documents default and maximum page size, order, and cursor behaviour",
            "Every mutating endpoint documents idempotency behaviour and requires a key or is naturally idempotent",
            "Every response schema is additive-only since the last release, or the version is bumped",
            "The spec snapshot diff was reviewed by someone who is not the author",
            "A generated client compiles from the published spec",
            "Errors, latency, and 4xx rates are on a dashboard before launch, not after the first incident"
          ]
        },
        {
          "h": "Automate the mechanical half",
          "p": [
            "Most items are checks, not opinions. A spec snapshot diff catches unannounced contract changes. Google's api-linter encodes hundreds of resource and naming rules against the OpenAPI or proto document. A codegen job proves the spec is machine-consumable. Route and spec parity tests catch the endpoint that exists in one and not the other. An error-code catalog test fails when a new code appears without documentation.",
            "What remains is judgement: whether a change is breaking for your actual consumers, whether the abstraction matches the domain, whether the field name means what a customer will assume. Those belong in the pull request as a written answer, backed by traffic data from the deprecation dashboards, not in a checkbox."
          ],
          "code": "name: api-contract\non: [pull_request]\n\njobs:\n  contract:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n\n      - name: Contract tests and spec snapshot\n        run: cargo test --locked -p acme-api -- contract openapi\n\n      - name: Lint the document against resource-design rules\n        run: |\n          go install github.com/googleapis/api-linter/cmd/api-linter@latest\n          api-linter --config .api-linter.yaml openapi.json\n\n      - name: A spec that cannot generate a client is not shippable\n        run: cargo test --locked -p acme-sdk -- generate_client\n\n      - name: Fail on unreviewed contract drift\n        run: git diff --exit-code -- openapi.json\n\n      - name: Error codes are documented\n        run: cargo test --locked -p acme-api -- error_catalog",
          "tip": "Put the snapshot diff in the pull request description with a one-line summary. Reviewers read a summary; they skip a 400-line JSON blob."
        },
        {
          "h": "Waivers, and the review after launch",
          "p": [
            "A waiver is a dated exception with an owner, a reason, and a follow-up ticket. Without an expiry it is a permanent hole with a paper trail that looks like process. Count open waivers and their age as a health metric; more than a handful, or any older than a quarter, means the checklist no longer matches how the team builds software.",
            "Then review thirty days after launch with data: 4xx rate by endpoint, top error codes, p99 latency, support tickets, and whether anyone calls the endpoint at all. Deprecate or delete what nobody uses - most APIs die of accumulation rather than of any single bad decision, and the cheapest time to remove a surface is while its author still remembers why it exists."
          ],
          "list": [
            "Waiver: owner, reason, expiry, ticket - all four or it is not a waiver",
            "30-day review: error rates, latency, tickets, and actual usage",
            "Delete unused endpoints; an unused surface still needs auth, docs, and on-call",
            "Retire checklist items that no longer correspond to a real risk"
          ]
        }
      ],
      "exercise": {
        "prompt": "Turn your capstone API into a launch gate: write the CI job that runs contract tests, spec snapshot, lint, and client generation, then list the three items that still need a human sign-off and why.",
        "starter": "name: api-contract\non: [pull_request]\njobs:\n  contract:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      # 1. contract tests\n      # 2. api-linter\n      # 3. client generation\n      # 4. drift check\n",
        "hint": "Steps run in order and fail the job on a non-zero exit. `git diff --exit-code` is the drift check; filter it to the generated spec path so unrelated files do not fail the build. Human items: breaking-change judgement, naming, and SLO ownership.",
        "solution": "name: api-contract\non: [pull_request]\n\njobs:\n  contract:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n\n      - name: Contract tests\n        run: cargo test --locked -p acme-api -- contract\n\n      - name: Spec snapshot is reviewed\n        run: cargo test --locked -p acme-api -- openapi\n\n      - name: Resource-design lint\n        run: |\n          go install github.com/googleapis/api-linter/cmd/api-linter@latest\n          api-linter --config .api-linter.yaml openapi.json\n\n      - name: Generated client compiles from the published spec\n        run: cargo test --locked -p acme-sdk -- generate_client\n\n      - name: No unreviewed contract drift\n        run: |\n          git add -A openapi.json\n          git diff --cached --exit-code -- openapi.json\n\n# Three items still need a human:\n# 1. Breaking-change judgement against real consumer traffic, not against the diff.\n# 2. Naming and abstraction review: does the field mean what a customer will assume?\n# 3. SLO and on-call owner: who is paged when this endpoint's p99 doubles?"
      },
      "questions": [
        {
          "q": "Which checklist item cannot be automated?",
          "options": [
            "Every documented path exists in the router",
            "The spec snapshot has no unreviewed diff",
            "Whether a change is breaking for your actual consumers",
            "Every 4xx uses the shared problem+json schema"
          ],
          "answer": 2,
          "explain": "Parsers and diffs can tell you what changed. Only a person with traffic data and product context can say whether that change breaks the customers you have."
        },
        {
          "q": "A waiver with no expiry date is best described as what?",
          "options": [
            "A pragmatic exception that keeps delivery moving",
            "A permanent hole with paperwork that makes it look governed",
            "A requirement for SOC 2 compliance",
            "An accepted risk owned by the security team"
          ],
          "answer": 1,
          "explain": "No expiry means nobody revisits it. Waivers need owner, reason, expiry, and a ticket, or they quietly become the design."
        },
        {
          "q": "What is the point of a 30-day post-launch review?",
          "options": [
            "To confirm the launch checklist was followed",
            "To look at error rates, latency, tickets, and real usage, and delete what nobody calls",
            "To upgrade the API version once traffic stabilises",
            "To hand ownership to the support team"
          ],
          "answer": 1,
          "explain": "Launch is a hypothesis. Thirty days of data tells you whether the surface earns its maintenance cost, and removal is cheapest while the context is fresh."
        }
      ],
      "quickbytes": [
        "Twelve to fifteen falsifiable items beat forty aspirational ones; delete any line nothing can fail.",
        "Automate spec diff, lint, parity, and codegen; reserve humans for intent and consumer impact.",
        "A waiver needs an owner, a reason, an expiry, and a ticket - otherwise it is the new design."
      ],
      "production": [
        "The checklist is at most fifteen items, each with a CI check or a named owner.",
        "Contract drift, lint, and client generation run on every pull request.",
        "Waivers are tracked with expiry dates and reviewed quarterly.",
        "Every endpoint has an owner, an SLO, and a dashboard before it serves production traffic.",
        "A 30-day review decides keep, fix, or delete, and unused endpoints are removed."
      ],
      "crates": [
        "utoipa",
        "progenitor",
        "insta",
        "axum"
      ],
      "github": [
        {
          "name": "api-linter - automated resource and naming rules",
          "url": "https://github.com/googleapis/api-linter"
        },
        {
          "name": "microsoft/api-guidelines - a published, reviewable API style guide",
          "url": "https://github.com/microsoft/api-guidelines"
        }
      ],
      "pitfall": "A checklist that grows to eighty items after three incidents: nobody reads it, reviewers approve in seconds, and the one item that would have caught the next outage is buried on page four.",
      "resources": [
        {
          "title": "api-linter - lint OpenAPI and proto against resource-design rules",
          "url": "https://github.com/googleapis/api-linter",
          "kind": "repo"
        },
        {
          "title": "Microsoft REST API guidelines",
          "url": "https://github.com/microsoft/api-guidelines",
          "kind": "repo"
        },
        {
          "title": "utoipa crate documentation",
          "url": "https://docs.rs/utoipa/latest/utoipa/",
          "kind": "docs"
        },
        {
          "title": "InfoQ: API governance and platform review talks",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        }
      ]
    }
  ]
};
