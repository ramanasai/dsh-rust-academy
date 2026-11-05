/**
 * Security engineering track.
 *
 * API versions verified against docs.rs while authoring:
 *   axum 0.8.x, axum-extra 0.12.x (cookie), tower-http 0.7.x (csrf, limit,
 *   sensitive-headers), argon2 0.6.x (password-hash 0.6, auto-salt
 *   hash_password), jsonwebtoken 11.x, ring 0.17.x, rustls 0.23.x,
 *   tokio-rustls 0.26.x, secrecy 0.10.x (SecretBox/SecretString),
 *   cap-std 4.0.x, subtle 2.6.x.
 *
 * Data is JSON-compatible and consumed by build.mjs.
 */
export default {
  "key": "security",
  "prefix": "h",
  "title": "Security engineering",
  "blurb": "Threat modelling, authentication and authorization, cryptography choices, secrets, supply chain and incident response.",
  "level": "industry",
  "project": {
    "title": "Capstone: a hardened auth service",
    "brief": "Build an OIDC-compatible auth service with secure sessions, key rotation and an audit trail. It must survive the boring attacks - credential stuffing, session fixation, alg confusion, token replay - and prove it with a test suite that runs in CI on every commit. The audit trail has to answer who did what, to which object, from where, and whether it succeeded.",
    "deliverables": [
      "Password and session security: Argon2id hashes with documented parameters, generic login errors, session rotation on privilege change, and HttpOnly/Secure/SameSite cookies.",
      "OIDC discovery and token issuance: /.well-known/openid-configuration, JWKS, authorization-code plus PKCE, ID tokens with iss/aud/nonce/exp validated by the client.",
      "Key rotation and JWKS: two signing keys live at once, kid in every token header, a published key set that overlaps for at least one token lifetime, and a re-encrypt path for data keys.",
      "Security test suite and threat model: one executable test per threat, a STRIDE table in the repository, and a CI job that fails when a threat has no test."
    ],
    "stack": [
      "axum",
      "argon2",
      "jsonwebtoken",
      "ring",
      "tower-http"
    ]
  },
  "lessons": [
    {
      "id": "h01",
      "n": 1,
      "title": "Threat modelling: assets, boundaries, STRIDE",
      "minutes": 75,
      "level": "core",
      "goal": "Produce a threat model that fits in the repository: name the assets, draw the trust boundaries, enumerate threats per element with STRIDE, and rank them so the top three get tests.",
      "sections": [
        {
          "h": "The artifact is a ranked list, not a diagram",
          "p": [
            "A threat model answers three questions in writing: what are we building, what can go wrong, and what are we doing about it. The diagram is scaffolding. The deliverable is a short table of threats, each with a trust boundary, an impact, a mitigation, and an owner. If the output is a picture nobody reads again, you produced documentation, not a model.",
            "Start with assets, not attacks. For an auth service the assets are credentials, session tokens, signing keys, the audit log, and tenant data. Then mark where privilege changes: browser to API, API to database, API to a third-party identity provider, operator to production. Every arrow that crosses one of those lines is where the interesting threats live."
          ],
          "list": [
            "Asset: anything whose disclosure, modification, or loss of availability matters",
            "Boundary: any place where the caller's privilege level differs from the callee's",
            "Threat: a concrete action an actor can take across a boundary, not a category name",
            "Mitigation: a control you can test, not an intention like be careful"
          ]
        },
        {
          "h": "STRIDE per element, not per application",
          "p": [
            "STRIDE is a checklist for asking better questions, not a taxonomy to file tickets under. Apply it element by element: an external entity can be spoofed, a process can be elevated, a data store can be tampered with or read, a data flow can be intercepted or flooded, and any action can be repudiated later. Running it once per boundary crossing finds the threats that a per-application pass averages away.",
            "The useful output of each pass is a sentence with an actor, a capability, and a consequence: an unauthenticated caller can replay a webhook body to trigger a second refund. If the sentence needs the word could, sharpen it until it reads like a bug report. Threats that survive that edit are the ones worth a test."
          ],
          "code": "// tests/threat_model.rs - the model is a table CI can read.\n#[derive(Debug)]\nenum Stride { Spoofing, Tampering, Repudiation, Disclosure, Dos, Elevation }\n\nstruct Threat {\n    id: &'static str,\n    boundary: &'static str,   // where privilege changes\n    stride: Stride,\n    mitigation: &'static str,\n    test: &'static str,       // must exist in tests/security.rs\n}\n\nconst THREATS: &[Threat] = &[\n    Threat { id: \"T-01\", boundary: \"client->api\", stride: Stride::Spoofing,\n             mitigation: \"bearer token verified against JWKS kid\", test: \"rejects_token_from_unknown_kid\" },\n    Threat { id: \"T-02\", boundary: \"api->postgres\", stride: Stride::Tampering,\n             mitigation: \"tenant_id taken from session, never from body\", test: \"cross_tenant_write_is_denied\" },\n    Threat { id: \"T-03\", boundary: \"api->s3\", stride: Stride::Disclosure,\n             mitigation: \"presigned PUT scoped to one key prefix, 60 s ttl\", test: \"presign_cannot_escape_prefix\" },\n];\n\n#[test]\nfn every_threat_has_an_executable_test() {\n    let tests = std::fs::read_to_string(\"tests/security.rs\").unwrap();\n    for t in THREATS {\n        assert!(tests.contains(t.test), \"{} ({:?}) has no test named {}\", t.id, t.stride, t.test);\n    }\n}",
          "tip": "Keeping the table in Rust means a renamed or deleted test breaks the build, which is exactly the pressure you want on a security control."
        },
        {
          "h": "Rank by consequence, then decide what you will not fix",
          "p": [
            "Rank with two axes you can defend: impact if the threat succeeds, and how much work the attack takes. Impact comes from data classification, not vibes - a read of another tenant's audit log is a breach notification, a read of a public marketing page is not. Likelihood comes from exposure: is the endpoint authenticated, internet-facing, or internal-only?",
            "Write down the threats you are accepting, and why. A model where everything is critical is indistinguishable from no model, and it trains the team to ignore the document. Residual risk is a decision with a name attached, reviewed at the next model update, not a silent omission."
          ],
          "list": [
            "Fix now: high impact and cheap for an attacker",
            "Mitigate with a control plus monitoring: high impact, expensive to exploit",
            "Accept in writing: low impact or requires an insider you already trust",
            "Revisit: anything that depends on a vendor you do not control"
          ]
        },
        {
          "h": "Re-run the model when the shape changes",
          "p": [
            "A threat model has triggers, not a schedule. Re-run it when you add an endpoint that touches a new asset, integrate a third party that receives data, add a queue or webhook that carries identity, change how tokens are issued, or move a workload across a network boundary. Those are the moments when the old assumptions quietly stop being true.",
            "Review the diff in the pull request that changes the shape. A new public endpoint should arrive with its threat row and its test, in the same commit, the same way it arrives with a route and a handler. Reviewers can then argue about the threat in the same place they argue about the code, which is the only review that actually happens."
          ],
          "tip": "If the threat model did not change in a quarter when the service gained four endpoints, it is stale; check it against the router."
        }
      ],
      "exercise": {
        "prompt": "An axum service exposes POST /upload (presigned S3 PUT), GET /admin/users, and POST /webhooks/stripe. Write the STRIDE table rows for the three riskiest boundary crossings, each with a concrete mitigation and the name of a test that proves it.",
        "starter": "// tests/threat_model.rs\nstruct Threat {\n    id: &'static str,\n    boundary: &'static str,\n    stride: Stride,\n    mitigation: &'static str,\n    test: &'static str,\n}\n\nconst THREATS: &[Threat] = &[\n    // 1. upload: what can a caller do with a presigned URL?\n    // 2. admin: what stops a normal user from reaching it?\n    // 3. webhook: what stops a replay?\n];",
        "hint": "Upload: a presigned URL scoped to one key prefix, short ttl, content-type and size enforced on read. Admin: role checked server-side per request, 404 for cross-tenant, audit every call. Webhook: HMAC over the raw body with a timestamp window plus an idempotency table on the event id.",
        "solution": "// tests/threat_model.rs\n#[derive(Debug)]\nenum Stride { Spoofing, Tampering, Repudiation, Disclosure, Dos, Elevation }\n\nstruct Threat {\n    id: &'static str,\n    boundary: &'static str,\n    stride: Stride,\n    mitigation: &'static str,\n    test: &'static str,\n}\n\nconst THREATS: &[Threat] = &[\n    Threat {\n        id: \"T-10\",\n        boundary: \"client->s3\",\n        stride: Stride::Elevation,\n        mitigation: \"presign binds one tenant-scoped key prefix and 60 s ttl; server re-checks ownership on read\",\n        test: \"presign_cannot_escape_tenant_prefix\",\n    },\n    Threat {\n        id: \"T-11\",\n        boundary: \"client->admin\",\n        stride: Stride::Elevation,\n        mitigation: \"role loaded from session per request, cross-tenant returns 404, every call audited\",\n        test: \"member_cannot_list_users\",\n    },\n    Threat {\n        id: \"T-12\",\n        boundary: \"stripe->webhook\",\n        stride: Stride::Spoofing,\n        mitigation: \"HMAC-SHA256 over raw body, 5 min timestamp window, event id idempotency table\",\n        test: \"webhook_replay_is_idempotent\",\n    },\n];\n\n#[test]\nfn every_threat_has_an_executable_test() {\n    let tests = std::fs::read_to_string(\"tests/security.rs\").unwrap();\n    for t in THREATS {\n        assert!(tests.contains(t.test), \"{} ({:?}) has no test named {}\", t.id, t.stride, t.test);\n    }\n}"
      },
      "questions": [
        {
          "q": "Which of these is a trust boundary rather than an asset?",
          "options": [
            "The signing key that mints session tokens",
            "The arrow from the browser to the API gateway",
            "The audit log table in Postgres",
            "The tenant identifier column on documents"
          ],
          "answer": 1,
          "explain": "A boundary is a place where the privilege level of the caller differs from the callee. Keys, tables, and columns are assets - things whose disclosure or modification matters."
        },
        {
          "q": "A caller replays a signed webhook body twice and two refunds are issued. Which STRIDE letter does the replay primarily violate, and what is the control?",
          "options": [
            "Repudiation - sign the request so the sender cannot deny it",
            "Tampering - encrypt the payload so it cannot be modified",
            "Spoofing - the replayed request pretends to be a new event; control is a timestamp window plus an idempotency key on the event id",
            "Elevation - the webhook runs with the API's privileges"
          ],
          "answer": 2,
          "explain": "A replay is a spoofing problem: an old, valid message is presented as a fresh one. A timestamp window bounds the replay window and an idempotency table on the provider's event id makes duplicates harmless."
        },
        {
          "q": "Why keep the threat table in a Rust file compiled with the tests?",
          "options": [
            "It runs faster than a Markdown file",
            "It lets the compiler generate mitigations",
            "A renamed or deleted test breaks the build, so the model cannot silently drift from the code",
            "It encrypts the threat names"
          ],
          "answer": 2,
          "explain": "The value is the coupling: the model references test names, and a missing test fails CI. That converts a document into an assertion about the code."
        }
      ],
      "quickbytes": [
        "List assets first; if you cannot name three, you do not yet understand the service.",
        "One sentence per threat: actor, capability, consequence. Rewrite anything containing could.",
        "Put the model next to the code and let CI fail when a referenced test disappears.",
        "Re-run on shape changes: new endpoint, new third party, new queue, new token issuer."
      ],
      "production": [
        "The threat table lives in the repository and is reviewed in the same PR that adds a new boundary crossing.",
        "Every threat above the accepted-risk line names an automated test; the test name is checked in CI.",
        "Accepted risks record who accepted them, why, and when the decision expires.",
        "Data classification drives impact ratings, so a new data field forces a model review.",
        "The model covers operator paths (deploy, database console, break-glass) and not only user traffic."
      ],
      "crates": [
        "axum",
        "tower-http",
        "serde"
      ],
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
      "pitfall": "A threat model produced once in a wiki that lists SQL injection for a service using bound queries, while the actual exposure - a new admin endpoint that checks the role but not the tenant - never appears.",
      "resources": [
        {
          "title": "OWASP threat modelling cheat sheet",
          "url": "https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Threat_Modeling_Cheat_Sheet.md",
          "kind": "docs"
        },
        {
          "title": "OWASP Top 10 project repository",
          "url": "https://github.com/OWASP/Top10",
          "kind": "repo"
        },
        {
          "title": "Advanced cloud privacy threat modeling (arXiv 1601.01500)",
          "url": "https://arxiv.org/abs/1601.01500",
          "kind": "paper"
        },
        {
          "title": "Value Driven Threat Modeling - Avi Douglen, AppSecUSA 2018",
          "url": "https://www.youtube.com/watch?v=3Fl_7FrM_gI",
          "kind": "video"
        },
        {
          "title": "axum crate documentation",
          "url": "https://docs.rs/axum/latest/axum/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "h02",
      "n": 2,
      "title": "OWASP Top 10 mapped to Rust failure modes",
      "minutes": 85,
      "level": "core",
      "goal": "Map each OWASP Top 10 category to the concrete Rust code that still fails it, so you know which classes the language removed and which it merely made less accidental.",
      "sections": [
        {
          "h": "What the borrow checker does and does not buy",
          "p": [
            "Safe Rust eliminates whole classes: use-after-free, double free, most buffer overflows, data races on shared mutable state. Those are real wins. But the Top 10 is mostly about decisions, not memory: who is allowed to read this object, whether this string is SQL or data, whether this dependency is the one you meant to install. No type system checks those for you.",
            "The failure mode is a team that reads safe Rust as secure Rust and stops reviewing input handling. A missing authorization check compiles perfectly, passes clippy, and is exactly as exploitable in Rust as in any other language. Every category below therefore needs a test or a review rule, because none of them is caught by the compiler."
          ],
          "list": [
            "A01 broken access control - language-independent, still the most common finding",
            "A03 injection - prevented only by keeping data out of syntax, not by the type system",
            "A04 insecure design - a threat model gap, not a bug",
            "A08 integrity failures - deserializing untrusted data into privileged types"
          ]
        },
        {
          "h": "A03 in Rust: format! is the injection primitive",
          "p": [
            "SQL injection in Rust looks like string formatting plus a query API that takes the whole string. sqlx will happily execute it. The fix is structural: the statement is a constant, values travel through bind, and the macro form checks the SQL against the live schema at compile time so a typo never becomes a 500.",
            "Command injection has the same shape. Passing a user path to sh -c hands the shell your arguments as syntax; passing it as a separate argument to the program avoids the parser entirely. When a shell is genuinely needed, an allowlist of arguments is the only defensible design."
          ],
          "code": "// BAD: the search string becomes SQL syntax. Rust does not care.\nlet sql = format!(\"SELECT id, email FROM users WHERE email LIKE '%{}%'\", q);\nlet rows = sqlx::query_as::<_, User>(&sql).fetch_all(&pool).await?;\n\n// GOOD: the statement is constant, the value is bound.\nlet rows = sqlx::query_as::<_, User>(\n    \"SELECT id, email FROM users WHERE email LIKE '%' || $1 || '%'\",\n)\n.bind(&q)\n.fetch_all(&pool)\n.await?;\n\n// BEST: checked against the schema at compile time.\nlet rows = sqlx::query_as!(User, r#\"SELECT id, email FROM users WHERE email = $1\"#, email)\n    .fetch_all(&pool)\n    .await?;\n\n// BAD: the shell parses the path as syntax.\nCommand::new(\"sh\").arg(\"-c\").arg(format!(\"convert {} out.png\", user_path));\n\n// GOOD: no shell, one argument, no parsing.\nCommand::new(\"convert\").arg(\"--\").arg(Path::new(&user_path)).arg(\"out.png\");",
          "tip": "Grep the codebase for format! near query, Command, and header construction. Every hit is a review item, not automatically a bug."
        },
        {
          "h": "A04 and A08: design and integrity",
          "p": [
            "Insecure design shows up as a flow that is correct per endpoint but wrong end to end: a password reset that does not invalidate existing sessions, an invite link that never expires, an upload that is validated before a redirect is followed. These are threat-model findings, and they need tests at the flow level rather than the handler level.",
            "Integrity failures usually enter through deserialization. If an untrusted payload can set a field the server is supposed to own - role, tenant_id, is_verified - you have handed over authorization. Deserialize into a narrow request type, not into the database row, and reject unknown fields so a future privileged field cannot be smuggled in by an old client."
          ],
          "code": "#[derive(serde::Deserialize)]\n#[serde(deny_unknown_fields)]\npub struct UpdateProfile {\n    pub display_name: String,\n    // no role, no tenant_id, no email_verified: the server owns those\n}\n\n// The row type is separate from the request type on purpose.\n#[derive(sqlx::FromRow)]\npub struct UserRow {\n    pub id: uuid::Uuid,\n    pub tenant_id: uuid::Uuid,\n    pub role: String,\n    pub display_name: String,\n}",
          "list": [
            "Reject unknown fields on every request body that maps to a privileged record",
            "Bound body size and nesting depth before deserialization, not after",
            "Never deserialize directly into a struct that has a role or tenant field",
            "Treat 4xx from the framework as a signal: log the rejection reason, not the payload"
          ]
        },
        {
          "h": "Turn each category into a CI check",
          "p": [
            "A category you cannot test is a category you are hoping about. Most of the Top 10 can be covered by a small, permanent test suite: a cross-tenant read that must 404, a login that must not reveal whether an account exists, a request body one byte over the limit that must 413, a serialized payload with an extra role field that must 422.",
            "Run those tests against the real router with oneshot or a test server, not against a mock of the handler. The failures you care about live in the layer wiring - a missing middleware, a route registered before the auth layer - and mocks cannot see wiring."
          ],
          "tip": "Keep one test file per category with the category in the test name, so a reviewer can map coverage to the Top 10 at a glance."
        }
      ],
      "exercise": {
        "prompt": "A handler builds a report query with format! from a user-supplied sort column and returns the rows as JSON. Rewrite it so the sort column cannot inject SQL, and add a request type that refuses unknown fields.",
        "starter": "pub async fn report(\n    State(pool): State<PgPool>,\n    Json(req): Json<ReportRequest>,\n) -> Result<Json<Vec<Row>>, StatusCode> {\n    let sql = format!(\"SELECT id, total FROM orders ORDER BY {}\", req.sort);\n    let rows = sqlx::query_as::<_, Row>(&sql)\n        .fetch_all(&pool)\n        .await\n        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;\n    Ok(Json(rows))\n}",
        "hint": "You cannot bind an identifier. Map the user string onto a closed enum of allowed columns and render the SQL fragment from the enum, so the only strings that reach the query are ones you wrote.",
        "solution": "use axum::{extract::State, http::StatusCode, Json};\nuse serde::Deserialize;\nuse sqlx::PgPool;\n\n#[derive(Deserialize)]\n#[serde(deny_unknown_fields, rename_all = \"snake_case\")]\npub enum SortColumn {\n    CreatedAt,\n    Total,\n}\n\nimpl SortColumn {\n    fn as_sql(&self) -> &'static str {\n        match self {\n            SortColumn::CreatedAt => \"created_at\",\n            SortColumn::Total => \"total_minor_units\",\n        }\n    }\n}\n\n#[derive(Deserialize)]\n#[serde(deny_unknown_fields)]\npub struct ReportRequest {\n    pub sort: SortColumn,\n}\n\n#[derive(sqlx::FromRow, serde::Serialize)]\npub struct Row {\n    pub id: uuid::Uuid,\n    pub total_minor_units: i64,\n}\n\npub async fn report(\n    State(pool): State<PgPool>,\n    Json(req): Json<ReportRequest>,\n) -> Result<Json<Vec<Row>>, StatusCode> {\n    // The only strings that can reach the query are the ones in as_sql().\n    let sql = format!(\n        \"SELECT id, total_minor_units FROM orders ORDER BY {} DESC LIMIT 100\",\n        req.sort.as_sql()\n    );\n    let rows = sqlx::query_as::<_, Row>(&sql)\n        .fetch_all(&pool)\n        .await\n        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;\n    Ok(Json(rows))\n}"
      },
      "questions": [
        {
          "q": "Which OWASP Top 10 category is unaffected by Rust's memory safety guarantees?",
          "options": [
            "A03 injection through format!-built SQL",
            "Buffer overflow in unsafe pointer arithmetic",
            "Use-after-free in a dropped Box",
            "Data race on a shared Vec"
          ],
          "answer": 0,
          "explain": "Injection is about data reaching a parser as syntax. Safe Rust prevents the memory-safety options in the other answers but has no opinion about whether a string is SQL or data."
        },
        {
          "q": "Why deserialize into a narrow request struct instead of the database row type?",
          "options": [
            "It is faster to deserialize",
            "It prevents a client from setting server-owned fields such as role or tenant_id",
            "serde cannot deserialize row types",
            "It avoids allocating a String"
          ],
          "answer": 1,
          "explain": "Mass assignment is a design bug: if the request type has the field, the client can set it. A separate type with deny_unknown_fields makes privilege fields unreachable from the wire."
        },
        {
          "q": "A user-supplied sort column must reach an ORDER BY clause. What is the safe pattern?",
          "options": [
            "Escape single quotes in the column name",
            "Bind the column as a query parameter",
            "Map the input onto a closed enum and render SQL from the enum",
            "Base64-encode the column name"
          ],
          "answer": 2,
          "explain": "Identifiers cannot be bound as parameters, so the only safe option is to choose from a fixed set of fragments you wrote. An enum makes any other value unrepresentable."
        }
      ],
      "quickbytes": [
        "Grep for format! within three lines of query, Command, or header: those are your A03 candidates.",
        "Add #[serde(deny_unknown_fields)] to every request type that maps to a privileged record.",
        "Bound request body size in middleware before deserialization, not inside the handler.",
        "Test authorization against the real router; middleware wiring is where the bug lives."
      ],
      "production": [
        "Every query is either a constant string with binds or a compile-time-checked query! macro; format!-built SQL fails review.",
        "No production path spawns a shell; process arguments are passed as separate OsStr values.",
        "Request types are separate from row types, with deny_unknown_fields on privileged payloads.",
        "Body size and nesting limits are enforced by middleware and covered by a test.",
        "The security test suite has at least one test per Top 10 category the service is exposed to."
      ],
      "crates": [
        "axum",
        "sqlx",
        "serde",
        "tower-http"
      ],
      "github": [
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        },
        {
          "name": "launchbadge/sqlx",
          "url": "https://github.com/transact-rs/sqlx"
        }
      ],
      "pitfall": "Assuming safe Rust means secure Rust: a handler that trusts a tenant_id from the JSON body compiles cleanly, passes clippy, and lets any authenticated user read another tenant's orders.",
      "resources": [
        {
          "title": "OWASP Top 10 project repository",
          "url": "https://github.com/OWASP/Top10",
          "kind": "repo"
        },
        {
          "title": "OWASP query parameterization cheat sheet",
          "url": "https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Query_Parameterization_Cheat_Sheet.md",
          "kind": "docs"
        },
        {
          "title": "OWASP input validation cheat sheet",
          "url": "https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Input_Validation_Cheat_Sheet.md",
          "kind": "docs"
        },
        {
          "title": "sqlx crate documentation",
          "url": "https://docs.rs/sqlx/latest/sqlx/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "h03",
      "n": 3,
      "title": "Authentication: a login flow without enumeration",
      "minutes": 95,
      "level": "core",
      "goal": "Implement a login that returns one generic failure, spends the same work whether or not the account exists, and hands off to MFA without creating a second, weaker session path.",
      "sections": [
        {
          "h": "The login transaction",
          "p": [
            "Authentication answers one question: does this person control this account? The implementation is a transaction with four observable outcomes - success, bad credentials, locked, and step-up required - and the security work is mostly in what the caller can learn from each. Every distinguishable outcome that reveals account existence is an enumeration oracle.",
            "Decide the response contract before writing code: one status, one body, one timing profile for bad password, unknown account, and disabled account. Log the difference server-side with the request id, so support can help a locked-out user without the API telling the world who has an account."
          ],
          "list": [
            "Unknown account and wrong password return the same 401 body and the same headers",
            "Do the password hash verification in both cases, against a dummy hash when the user is missing",
            "Count failures per account and per IP, with a lockout that is not itself a denial-of-service tool",
            "Emit an audit event for every attempt, including the failures, with the reason only in the log"
          ]
        },
        {
          "h": "Constant work, not constant time",
          "p": [
            "Perfect constant-time login is not achievable over a network, but you can remove the obvious signal: the 1 ms path for an unknown email versus the 300 ms Argon2 path for a real one. Precompute a real Argon2id hash at boot for a random password, and verify against it when the lookup returns nothing.",
            "Verification is CPU-bound and memory-hard by design, so it belongs on a blocking thread. Running Argon2 directly in an async handler stalls a runtime worker for tens of milliseconds per attempt, which turns a credential-stuffing run into a self-inflicted outage."
          ],
          "code": "use std::sync::Arc;\nuse argon2::{password_hash::{phc::PasswordHash, PasswordVerifier}, Argon2};\nuse axum::{extract::State, http::StatusCode, Json};\nuse serde::Deserialize;\n\n#[derive(Deserialize)]\npub struct Login { pub email: String, pub password: String }\n\npub struct AppState {\n    pub db: sqlx::PgPool,\n    pub dummy_hash: String, // a real Argon2id PHC string for a random password\n}\n\npub async fn login(\n    State(st): State<Arc<AppState>>,\n    Json(body): Json<Login>,\n) -> Result<StatusCode, StatusCode> {\n    let row: Option<(uuid::Uuid, String)> = sqlx::query_as(\n        \"SELECT id, password_hash FROM users WHERE lower(email) = lower($1)\",\n    )\n    .bind(&body.email)\n    .fetch_optional(&st.db)\n    .await\n    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;\n\n    // Always verify exactly once, even when the account does not exist.\n    let stored = row\n        .as_ref()\n        .map(|(_, h)| h.clone())\n        .unwrap_or_else(|| st.dummy_hash.clone());\n    let password = body.password.clone().into_bytes();\n\n    let ok = tokio::task::spawn_blocking(move || {\n        let parsed = PasswordHash::new(&stored).map_err(|_| ())?;\n        Ok::<bool, ()>(Argon2::default().verify_password(&password, &parsed).is_ok())\n    })\n    .await\n    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?\n    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;\n\n    match (ok, row) {\n        (true, Some((user_id, _))) => {\n            // mint a session here (h07); never return the password or hash\n            tracing::info!(%user_id, \"login ok\");\n            Ok(StatusCode::NO_CONTENT)\n        }\n        _ => {\n            tracing::warn!(email_hash = %sha256_hex(&body.email), \"login failed\");\n            Err(StatusCode::UNAUTHORIZED)\n        }\n    }\n}\n\nfn sha256_hex(input: &str) -> String {\n    use ring::digest::{digest, SHA256};\n    digest(&SHA256, input.as_bytes())\n        .as_ref()\n        .iter()\n        .map(|b| format!(\"{b:02x}\"))\n        .collect()\n}",
          "tip": "Hash the email before logging it. You need to correlate attempts, not to build a searchable list of your users in the log pipeline."
        },
        {
          "h": "MFA without a bypass",
          "p": [
            "A second factor is only a control if the first factor alone cannot mint a session. Model it as a state machine: password verified produces a short-lived, single-purpose challenge token that can only be exchanged at the MFA endpoint. If the login endpoint returns a normal session plus a flag the client is asked to respect, you have shipped a suggestion.",
            "Recovery codes are part of the factor. Store them hashed like passwords, invalidate each on use, and rate limit the recovery endpoint at least as hard as login. The same goes for TOTP: reject a code that was already used in the current time step, or a shoulder-surfed code stays valid for the rest of the window."
          ],
          "code": "#[derive(Clone, Copy, PartialEq, Eq)]\npub enum AuthStep { PasswordOk, MfaRequired, Complete }\n\npub struct Challenge {\n    pub user_id: uuid::Uuid,\n    pub expires_at: std::time::Instant,\n    pub used: bool,\n}\n\n// Only this function turns a challenge into a session, and it consumes the challenge.\npub async fn exchange_mfa(\n    state: &AppState,\n    challenge_id: uuid::Uuid,\n    totp: &str,\n) -> Result<uuid::Uuid, StatusCode> {\n    let ch = state\n        .challenges\n        .remove(&challenge_id) // single use, atomic\n        .ok_or(StatusCode::UNAUTHORIZED)?;\n\n    if ch.used || ch.expires_at < std::time::Instant::now() {\n        return Err(StatusCode::UNAUTHORIZED);\n    }\n    if !state.totp.verify(ch.user_id, totp) {\n        return Err(StatusCode::UNAUTHORIZED);\n    }\n    state.sessions.create(ch.user_id).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)\n}",
          "list": [
            "The password-only response carries no session cookie and no bearer token",
            "Challenge tokens are single-use, bound to the user, and expire in minutes",
            "Recovery codes are hashed, single-use, and rate limited like passwords",
            "Every factor change (add, remove, reset) requires re-authentication and sends a notification"
          ]
        }
      ],
      "exercise": {
        "prompt": "Add an enumeration-resistant failure path to a login handler: unknown email, wrong password, and disabled account must be indistinguishable to the caller while the audit log records the true reason. Include the dummy-hash verification and the blocking-thread hop.",
        "starter": "pub async fn login(\n    State(st): State<Arc<AppState>>,\n    Json(body): Json<Login>,\n) -> Result<StatusCode, StatusCode> {\n    // 1. look up the user\n    // 2. always verify once against a real hash\n    // 3. one generic failure, reason only in the log\n    todo!()\n}",
        "hint": "Keep the row as Option, substitute a boot-time dummy hash when it is None, verify inside spawn_blocking, then match on (verified, row) and return UNAUTHORIZED for every non-success arm.",
        "solution": "use std::sync::Arc;\nuse argon2::{password_hash::{phc::PasswordHash, PasswordVerifier}, Argon2};\nuse axum::{extract::State, http::StatusCode, Json};\nuse serde::Deserialize;\n\n#[derive(Deserialize)]\npub struct Login { pub email: String, pub password: String }\n\npub struct AppState { pub db: sqlx::PgPool, pub dummy_hash: String }\n\npub async fn login(\n    State(st): State<Arc<AppState>>,\n    Json(body): Json<Login>,\n) -> Result<StatusCode, StatusCode> {\n    let row: Option<(uuid::Uuid, String, bool)> = sqlx::query_as(\n        \"SELECT id, password_hash, disabled FROM users WHERE lower(email) = lower($1)\",\n    )\n    .bind(&body.email)\n    .fetch_optional(&st.db)\n    .await\n    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;\n\n    let stored = row.as_ref().map(|(_, h, _)| h.clone()).unwrap_or_else(|| st.dummy_hash.clone());\n    let password = body.password.clone().into_bytes();\n\n    let verified = tokio::task::spawn_blocking(move || {\n        let parsed = PasswordHash::new(&stored).map_err(|_| ())?;\n        Ok::<bool, ()>(Argon2::default().verify_password(&password, &parsed).is_ok())\n    })\n    .await\n    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?\n    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;\n\n    let (ok, reason) = match (verified, row.as_ref()) {\n        (true, Some((_, _, false))) => (true, \"ok\"),\n        (true, Some((_, _, true))) => (false, \"disabled\"),\n        (false, Some(_)) => (false, \"bad_password\"),\n        (false, None) => (false, \"unknown_account\"),\n    };\n\n    if ok {\n        return Ok(StatusCode::NO_CONTENT); // session minted in h07\n    }\n    // Same status, same body, same headers for every failure.\n    tracing::warn!(reason, email = %body.email.chars().take(3).collect::<String>(), \"login rejected\");\n    Err(StatusCode::UNAUTHORIZED)\n}"
      },
      "questions": [
        {
          "q": "Why verify the password against a dummy hash when the account does not exist?",
          "options": [
            "To keep the database connection warm",
            "To make the unknown-account path take comparable work, removing a timing oracle for account existence",
            "Because Argon2 requires two verifications per request",
            "To prevent SQL injection"
          ],
          "answer": 1,
          "explain": "Without the dummy verification the unknown-account path returns in about a millisecond while the real path spends tens of milliseconds in Argon2. That difference is measurable and enumerates users."
        },
        {
          "q": "What is wrong with returning a normal session token plus an mfa_required flag from the login endpoint?",
          "options": [
            "Nothing, the client checks the flag",
            "The token is a full session, so the second factor is advisory and any client that ignores the flag bypasses MFA",
            "It makes the token too large",
            "It breaks HTTP caching"
          ],
          "answer": 1,
          "explain": "A control the client enforces is not a control. The password step must yield only a single-use challenge that cannot be exchanged for anything except an MFA-verified session."
        },
        {
          "q": "Where should Argon2 verification run in an axum handler?",
          "options": [
            "Directly in the async handler, it is fast enough",
            "In spawn_blocking or a dedicated thread pool, because it is CPU and memory bound",
            "In a database trigger",
            "In the TLS layer"
          ],
          "answer": 1,
          "explain": "Argon2id at 19 MiB and t=2 blocks its thread for tens of milliseconds. On the async runtime that stalls unrelated tasks, so a burst of login attempts degrades the whole service."
        }
      ],
      "quickbytes": [
        "One 401 body for unknown account, bad password, and disabled account; the reason goes to the log only.",
        "Precompute the dummy hash at boot with the same Argon2 parameters you ship.",
        "spawn_blocking around every password hash and verify call.",
        "A password-only success must return a challenge, never a session."
      ],
      "production": [
        "Login responses are byte-identical for unknown account, wrong password, and disabled account, and a test asserts it.",
        "Per-account and per-IP attempt counters exist, with lockout that a support workflow can release.",
        "Argon2 runs off the async runtime; p99 login latency is monitored against the hash cost.",
        "MFA challenges are single-use, user-bound, and short-lived; exchange is the only path to a session.",
        "Emails are hashed or truncated in logs so the log pipeline is not a user directory."
      ],
      "crates": [
        "argon2",
        "axum",
        "ring",
        "tokio"
      ],
      "github": [
        {
          "name": "RustCrypto/password-hashes",
          "url": "https://github.com/RustCrypto/password-hashes"
        },
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        }
      ],
      "pitfall": "Returning early when the email is not found: the response arrives in about a millisecond while a real account takes tens of milliseconds in Argon2, and that gap is a reliable account enumeration oracle.",
      "resources": [
        {
          "title": "OWASP authentication cheat sheet",
          "url": "https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Authentication_Cheat_Sheet.md",
          "kind": "docs"
        },
        {
          "title": "The 23andMe breach: credential stuffing analysis (arXiv 2502.04303)",
          "url": "https://arxiv.org/abs/2502.04303",
          "kind": "paper"
        },
        {
          "title": "argon2 crate documentation",
          "url": "https://docs.rs/argon2/latest/argon2/",
          "kind": "docs"
        },
        {
          "title": "axum crate documentation",
          "url": "https://docs.rs/axum/latest/axum/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "h04",
      "n": 4,
      "title": "Authorization models: RBAC, ABAC, ReBAC",
      "minutes": 95,
      "level": "advanced",
      "goal": "Pick an authorization model that survives object-level checks and tenant scoping, and implement it as a single deny-by-default decision point instead of scattered role comparisons.",
      "sections": [
        {
          "h": "Three models and the question each answers",
          "p": [
            "Role-based access control answers what kind of user are you. It is cheap to implement and it collapses under object-level questions: an editor of which document, in which workspace? Attribute-based control answers under what conditions, which handles clearance and time-of-day but needs a policy engine and a story for attribute freshness.",
            "Relationship-based control answers how is this user related to this object, and that is the question most multi-tenant APIs actually ask. The Zanzibar design - tuples of object, relation, subject, expanded through a schema - is the reference architecture because it makes the relationship the unit of storage and check."
          ],
          "list": [
            "RBAC: coarse, stable, easy to audit; explodes into role-per-customer at scale",
            "ABAC: expressive, but policies become code and attribute sources become the attack surface",
            "ReBAC: object-level by construction; needs a relationship store and a schema you can review",
            "Most production systems are RBAC for coarse gates plus ReBAC for object access"
          ]
        },
        {
          "h": "One decision point, deny by default",
          "p": [
            "Authorization scattered across handlers is how IDOR happens: the list endpoint filters by tenant, the detail endpoint forgets. Collapse every decision into one function that takes the actor, the action, and the loaded resource, and returns allow or deny. Handlers then have a single line they cannot get subtly wrong.",
            "Deny by default means the match is exhaustive and anything unmatched is a denial. In Rust an exhaustive match over an enum gets you most of the way, and adding a new action breaks the build until every arm is considered - a property worth designing for."
          ],
          "code": "use uuid::Uuid;\n\n#[derive(Clone, Copy, PartialEq, Eq)]\npub enum Role { Member, Admin, Billing }\n\npub struct Actor { pub user_id: Uuid, pub tenant_id: Uuid, pub role: Role }\n\npub struct Document { pub tenant_id: Uuid, pub owner_id: Uuid }\n\n#[derive(Clone, Copy)]\npub enum Action { Read, Update, Delete, Invite }\n\npub enum Denied { NotFound, Forbidden }\n\npub fn authorize(actor: &Actor, action: Action, doc: &Document) -> Result<(), Denied> {\n    // Cross-tenant access is reported as 404 so existence is not leaked.\n    if doc.tenant_id != actor.tenant_id {\n        return Err(Denied::NotFound);\n    }\n\n    let allowed = match (actor.role, action) {\n        (Role::Admin, _) => true,\n        (Role::Member, Action::Read | Action::Update) => doc.owner_id == actor.user_id,\n        (Role::Member, Action::Delete | Action::Invite) => false,\n        (Role::Billing, Action::Read) => true,\n        (Role::Billing, Action::Update | Action::Delete | Action::Invite) => false,\n    };\n\n    if allowed { Ok(()) } else { Err(Denied::Forbidden) }\n}",
          "tip": "Returning 404 for cross-tenant access costs nothing and removes an oracle that tells an attacker which ids exist in other tenants."
        },
        {
          "h": "Tenant scope belongs in the query, not the handler",
          "p": [
            "A decision point that says yes is worthless if the query behind it can still return another tenant's row. Put the tenant predicate in the SQL for every read and write, and treat a missing tenant filter as a bug of the same severity as a missing auth check. Row-level security in Postgres is the belt to that suspenders.",
            "The subtle case is aggregates and counts: a list that filters correctly but a count that does not still leaks the existence of other tenants' data through pagination. Any query that touches a tenant-scoped table needs the predicate, including the ones that only count."
          ],
          "code": "-- Every statement carries the tenant predicate, including counts.\nSELECT id, title\nFROM documents\nWHERE tenant_id = $1 AND owner_id = $2\nORDER BY created_at DESC\nLIMIT 50;\n\n-- Defence in depth: the database refuses cross-tenant rows even if a query forgets.\nALTER TABLE documents ENABLE ROW LEVEL SECURITY;\nCREATE POLICY tenant_isolation ON documents\n    USING (tenant_id = current_setting('app.tenant_id')::uuid);",
          "list": [
            "Set app.tenant_id per connection/transaction from the authenticated session",
            "Never accept tenant_id from the request body or query string",
            "Review every new query for the tenant predicate, including counts and aggregates",
            "Test with two tenants and assert a 404, not just an empty list"
          ]
        },
        {
          "h": "Cache decisions, not permissions",
          "p": [
            "Authorization checks run on every request, so the relationship lookup is on the hot path. Cache the decision keyed by actor, action, and object version, with a short TTL, and invalidate on relationship change. Caching the user's permission set instead is where stale grants come from: the set changes shape per object, and invalidation becomes guesswork.",
            "For revocation that must be immediate - removing someone from a workspace during an incident - skip the cache for that path or bump a global epoch that is part of the cache key. A short TTL is a policy decision about how long a fired contractor keeps access, so write it down."
          ],
          "tip": "Put the decision TTL in config next to the session TTL; both are revocation windows and both get reviewed by the same people."
        }
      ],
      "exercise": {
        "prompt": "Implement authorize for a documents API with three roles and four actions, where cross-tenant access returns NotFound, members can read and update only documents they own, and billing can only read. Add a unit test table covering the deny cases.",
        "starter": "#[derive(Clone, Copy, PartialEq, Eq)]\npub enum Role { Member, Admin, Billing }\npub struct Actor { pub user_id: uuid::Uuid, pub tenant_id: uuid::Uuid, pub role: Role }\npub struct Document { pub tenant_id: uuid::Uuid, pub owner_id: uuid::Uuid }\npub enum Action { Read, Update, Delete, Invite }\n\npub fn authorize(actor: &Actor, action: Action, doc: &Document) -> Result<(), Denied> {\n    todo!()\n}",
        "hint": "Check the tenant first and return NotFound; then an exhaustive match over (role, action); default to false so a new action cannot slip through as allowed.",
        "solution": "use uuid::Uuid;\n\n#[derive(Clone, Copy, PartialEq, Eq, Debug)]\npub enum Role { Member, Admin, Billing }\n\n#[derive(Debug)]\npub struct Actor { pub user_id: Uuid, pub tenant_id: Uuid, pub role: Role }\n\n#[derive(Debug)]\npub struct Document { pub tenant_id: Uuid, pub owner_id: Uuid }\n\n#[derive(Clone, Copy, Debug)]\npub enum Action { Read, Update, Delete, Invite }\n\n#[derive(Debug, PartialEq, Eq)]\npub enum Denied { NotFound, Forbidden }\n\npub fn authorize(actor: &Actor, action: Action, doc: &Document) -> Result<(), Denied> {\n    if doc.tenant_id != actor.tenant_id {\n        return Err(Denied::NotFound);\n    }\n    let allowed = match (actor.role, action) {\n        (Role::Admin, _) => true,\n        (Role::Member, Action::Read | Action::Update) => doc.owner_id == actor.user_id,\n        (Role::Member, Action::Delete | Action::Invite) => false,\n        (Role::Billing, Action::Read) => true,\n        (Role::Billing, Action::Update | Action::Delete | Action::Invite) => false,\n    };\n    if allowed { Ok(()) } else { Err(Denied::Forbidden) }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    fn actor(role: Role) -> Actor {\n        Actor { user_id: Uuid::nil(), tenant_id: Uuid::nil(), role }\n    }\n    fn doc(tenant: Uuid, owner: Uuid) -> Document {\n        Document { tenant_id: tenant, owner_id: owner }\n    }\n\n    #[test]\n    fn cross_tenant_is_not_found_not_forbidden() {\n        let other = Uuid::from_u128(9);\n        assert_eq!(authorize(&actor(Role::Admin), Action::Read, &doc(other, Uuid::nil())),\n                   Err(Denied::NotFound));\n    }\n\n    #[test]\n    fn member_cannot_delete_someone_elses_document() {\n        let owner = Uuid::from_u128(7);\n        assert_eq!(authorize(&actor(Role::Member), Action::Delete, &doc(Uuid::nil(), owner)),\n                   Err(Denied::Forbidden));\n    }\n\n    #[test]\n    fn billing_can_read_but_not_write() {\n        let d = doc(Uuid::nil(), Uuid::nil());\n        assert!(authorize(&actor(Role::Billing), Action::Read, &d).is_ok());\n        assert_eq!(authorize(&actor(Role::Billing), Action::Update, &d), Err(Denied::Forbidden));\n    }\n}"
      },
      "questions": [
        {
          "q": "A list endpoint filters by tenant but the detail endpoint loads by id alone. What class of bug is that?",
          "options": [
            "A SQL injection",
            "Broken object-level authorization (IDOR): the object is fetched without proving the actor may see it",
            "A race condition",
            "A CSRF"
          ],
          "answer": 1,
          "explain": "The actor is authenticated but never authorized against the specific object. Any id from another tenant is readable, which is the classic IDOR pattern in the OWASP Top 10 A01."
        },
        {
          "q": "Why return 404 rather than 403 when a resource exists in another tenant?",
          "options": [
            "404 is faster to serialize",
            "403 tells the caller the object exists, which is an enumeration oracle across tenants",
            "403 breaks HTTP caching",
            "Rust cannot produce a 403"
          ],
          "answer": 1,
          "explain": "The response should not distinguish does not exist from exists but is not yours. Returning 404 for both keeps the tenant boundary invisible."
        },
        {
          "q": "What makes ReBAC a better fit than flat RBAC for a multi-tenant document API?",
          "options": [
            "It needs no database",
            "It stores the user-to-object relationship, which is the actual question being asked, instead of enumerating a role per object",
            "It removes the need for authentication",
            "It is faster to compile"
          ],
          "answer": 1,
          "explain": "RBAC with per-object roles grows one role per document. Relationship tuples express editor-of-this-document directly and answer the check without a combinatorial role space."
        }
      ],
      "quickbytes": [
        "One authorize(actor, action, resource) function; handlers call it and nothing else decides.",
        "Cross-tenant means 404, not 403: do not confirm existence outside the tenant.",
        "Every query on a tenant table carries the tenant predicate, counts included.",
        "Cache the decision with a TTL you would defend to a security reviewer, not the permission set."
      ],
      "production": [
        "A single decision point owns authorization; no handler compares roles inline.",
        "Tenant isolation is enforced in SQL and optionally by row-level security, with a two-tenant test per endpoint.",
        "Decision caching has a documented TTL and an immediate-invalidation path for revocation.",
        "Role and relationship changes emit audit events with actor, target, and before/after.",
        "New actions or roles break the exhaustive match, forcing an explicit decision at compile time."
      ],
      "crates": [
        "axum",
        "sqlx",
        "uuid"
      ],
      "github": [
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        },
        {
          "name": "launchbadge/sqlx",
          "url": "https://github.com/transact-rs/sqlx"
        }
      ],
      "pitfall": "Checking the role at the route layer and never the object: any authenticated member can read any document id in the system, because the only thing that was verified is that they are logged in.",
      "resources": [
        {
          "title": "Zanzibar: Google's Consistent, Global Authorization System (USENIX ATC 2019)",
          "url": "https://www.usenix.org/conference/atc19/presentation/pang",
          "kind": "paper"
        },
        {
          "title": "OWASP authorization cheat sheet",
          "url": "https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Authorization_Cheat_Sheet.md",
          "kind": "docs"
        },
        {
          "title": "OWASP Top 10 project repository",
          "url": "https://github.com/OWASP/Top10",
          "kind": "repo"
        },
        {
          "title": "sqlx crate documentation",
          "url": "https://docs.rs/sqlx/latest/sqlx/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "h05",
      "n": 5,
      "title": "OAuth 2.0 and OIDC: flows, PKCE, token meaning",
      "minutes": 105,
      "level": "advanced",
      "goal": "Choose the right grant for each client type, run authorization code with PKCE correctly, and keep the ID token (who authenticated) separate from the access token (what the API accepts).",
      "sections": [
        {
          "h": "Pick the grant by what the client can keep",
          "p": [
            "A grant is a trust assumption about the client. A browser or a native app cannot keep a secret, so it gets authorization code with PKCE and no client secret. A backend service acting on its own behalf can keep a secret, so it gets client credentials and no user. A TV with no keyboard gets device code. The implicit grant and the resource-owner password grant are gone from current guidance because both expose credentials to parties that should never see them.",
            "The redirect URI is the security boundary of the whole flow. Register exact URIs per environment, require https except for loopback, and reject anything that does not match byte for byte - a wildcard or a prefix match turns your authorization server into an open redirector that leaks codes."
          ],
          "list": [
            "Public client: authorization code + PKCE, no secret, short-lived refresh with rotation",
            "Confidential client: authorization code + PKCE + client authentication",
            "Machine-to-machine: client credentials, scoped narrowly, no refresh token",
            "Never ship a client secret in a mobile app, SPA, or CLI binary - it is extractable"
          ]
        },
        {
          "h": "PKCE closes the code-interception hole",
          "p": [
            "On mobile and desktop, the authorization code comes back through a custom URI scheme that any app on the device can register. Without PKCE, a malicious app that wins the race exchanges the stolen code for tokens. PKCE binds the code to a secret the legitimate client generated and never sent through the browser: the server stores the hash of the verifier when it issues the code, and requires the verifier at exchange.",
            "Use S256, never plain. The verifier must be 43 to 128 characters from the unreserved set, which is why 32 random bytes base64url-encoded is the usual choice. state protects the callback against CSRF and nonce binds the ID token to this particular request; they solve different problems and you need both."
          ],
          "code": "use base64::engine::general_purpose::URL_SAFE_NO_PAD;\nuse base64::Engine;\nuse ring::digest::{digest, SHA256};\nuse ring::rand::{SecureRandom, SystemRandom};\n\npub struct Pkce { pub verifier: String, pub challenge: String }\n\npub fn pkce() -> Result<Pkce, Box<dyn std::error::Error>> {\n    let mut raw = [0u8; 32];\n    SystemRandom::new().fill(&mut raw)?;\n    // 32 bytes -> 43 base64url chars, inside the 43..=128 range PKCE requires.\n    let verifier = URL_SAFE_NO_PAD.encode(raw);\n    let challenge = URL_SAFE_NO_PAD.encode(digest(&SHA256, verifier.as_bytes()).as_ref());\n    Ok(Pkce { verifier, challenge })\n}\n\npub fn authorize_url(\n    issuer: &str,\n    client_id: &str,\n    redirect_uri: &str,\n    state: &str,\n    nonce: &str,\n    challenge: &str,\n) -> Result<String, url::ParseError> {\n    let mut url = url::Url::parse(issuer)?;\n    url.set_path(\"/oauth2/authorize\");\n    url.query_pairs_mut()\n        .append_pair(\"response_type\", \"code\")\n        .append_pair(\"client_id\", client_id)\n        .append_pair(\"redirect_uri\", redirect_uri)\n        .append_pair(\"scope\", \"openid profile email\")\n        .append_pair(\"state\", state)\n        .append_pair(\"nonce\", nonce)\n        .append_pair(\"code_challenge\", challenge)\n        .append_pair(\"code_challenge_method\", \"S256\");\n    Ok(url.to_string())\n}",
          "tip": "Store the verifier server-side keyed by state, not in a cookie the browser can rewrite; the exchange must use the verifier that belongs to that exact authorization request."
        },
        {
          "h": "An ID token is an assertion, not a key",
          "p": [
            "The ID token tells the client what happened during authentication: which issuer, which subject, which client it was minted for, when, and - via nonce - that it belongs to this request. It is for the client. The access token is for the resource server, carries the scopes and audience that server understands, and may be opaque.",
            "Sending an ID token to your API as a bearer token is a category error: its audience is the client application, not the API, so accepting it means accepting tokens minted for a different party. At the API, validate the access token against your own audience and issuer; at the client, validate the ID token against client_id, issuer, nonce, and signature."
          ],
          "code": "#[derive(Debug, serde::Deserialize)]\npub struct IdTokenClaims {\n    pub iss: String,\n    pub sub: String,\n    pub aud: String,          // may be an array in the wild; handle both\n    pub exp: u64,\n    pub iat: u64,\n    pub nonce: Option<String>,\n    pub email: Option<String>,\n    pub email_verified: Option<bool>,\n}\n\npub fn check_id_token(\n    claims: &IdTokenClaims,\n    expected_iss: &str,\n    client_id: &str,\n    expected_nonce: &str,\n    now: u64,\n) -> Result<(), &'static str> {\n    if claims.iss != expected_iss { return Err(\"iss\"); }\n    if claims.aud != client_id { return Err(\"aud\"); }\n    if claims.exp <= now { return Err(\"exp\"); }\n    if claims.nonce.as_deref() != Some(expected_nonce) { return Err(\"nonce\"); }\n    // An unverified email is a string the user typed, nothing more.\n    if claims.email.is_some() && claims.email_verified != Some(true) { return Err(\"email_verified\"); }\n    Ok(())\n}",
          "list": [
            "ID token audience is the client_id; access token audience is the API",
            "Validate the signature against the issuer's JWKS, and pin the issuer string exactly",
            "Treat email as unverified until email_verified is true, or you will let anyone claim any address",
            "Never accept an access token whose aud is not your API, even if the signature is valid"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write the client half of an authorization-code + PKCE flow: generate the verifier and challenge, build the authorize URL, and validate the callback by checking state before exchanging the code. Return a typed error for each failure.",
        "starter": "pub struct PendingAuth { pub state: String, pub nonce: String, pub verifier: String }\n\npub fn begin(issuer: &str, client_id: &str, redirect: &str) -> PendingAuth {\n    todo!()\n}\n\npub fn finish(pending: &PendingAuth, returned_state: &str) -> Result<(), AuthError> {\n    todo!()\n}",
        "hint": "Generate 32 random bytes for the verifier, SHA-256 them for the challenge, and compare state with a constant-time equality check before any network call.",
        "solution": "use base64::engine::general_purpose::URL_SAFE_NO_PAD;\nuse base64::Engine;\nuse ring::digest::{digest, SHA256};\nuse ring::rand::{SecureRandom, SystemRandom};\nuse subtle::ConstantTimeEq;\n\n#[derive(Debug)]\npub enum AuthError { Rng, Parse(url::ParseError), StateMismatch }\n\npub struct PendingAuth { pub state: String, pub nonce: String, pub verifier: String, pub url: String }\n\nfn token(bytes: usize) -> Result<String, AuthError> {\n    let mut raw = vec![0u8; bytes];\n    SystemRandom::new().fill(&mut raw).map_err(|_| AuthError::Rng)?;\n    Ok(URL_SAFE_NO_PAD.encode(raw))\n}\n\npub fn begin(issuer: &str, client_id: &str, redirect: &str) -> Result<PendingAuth, AuthError> {\n    let verifier = token(32)?;\n    let state = token(16)?;\n    let nonce = token(16)?;\n    let challenge = URL_SAFE_NO_PAD.encode(digest(&SHA256, verifier.as_bytes()).as_ref());\n\n    let mut url = url::Url::parse(issuer).map_err(AuthError::Parse)?;\n    url.set_path(\"/oauth2/authorize\");\n    url.query_pairs_mut()\n        .append_pair(\"response_type\", \"code\")\n        .append_pair(\"client_id\", client_id)\n        .append_pair(\"redirect_uri\", redirect)\n        .append_pair(\"scope\", \"openid profile email\")\n        .append_pair(\"state\", &state)\n        .append_pair(\"nonce\", &nonce)\n        .append_pair(\"code_challenge\", &challenge)\n        .append_pair(\"code_challenge_method\", \"S256\");\n\n    Ok(PendingAuth { state, nonce, verifier, url: url.to_string() })\n}\n\npub fn finish(pending: &PendingAuth, returned_state: &str) -> Result<(), AuthError> {\n    // Constant-time compare: the value is not secret, but the habit is free.\n    if pending.state.as_bytes().ct_eq(returned_state.as_bytes()).unwrap_u8() != 1 {\n        return Err(AuthError::StateMismatch);\n    }\n    // Next: POST the code + pending.verifier to /oauth2/token, then validate\n    // the ID token signature, iss, aud, exp and nonce before trusting sub.\n    Ok(())\n}"
      },
      "questions": [
        {
          "q": "What does PKCE actually protect against?",
          "options": [
            "A stolen client secret",
            "Interception of the authorization code by another app on the device or in the browser",
            "SQL injection in the token endpoint",
            "Weak TLS ciphers"
          ],
          "answer": 1,
          "explain": "The code travels through the user agent, where another app can grab it. PKCE makes the code useless without the verifier, which never leaves the legitimate client."
        },
        {
          "q": "An API accepts an ID token as its bearer token. Why is that wrong even with a valid signature?",
          "options": [
            "ID tokens are always encrypted",
            "The ID token's audience is the client application, so the API is accepting a token minted for a different party",
            "ID tokens expire too quickly",
            "ID tokens cannot carry a subject"
          ],
          "answer": 1,
          "explain": "Audience is the whole point of the separation. Accepting an ID token means any client holding one - including one for a different API - can call you."
        },
        {
          "q": "Which redirect URI policy is safe?",
          "options": [
            "Allow any subdomain of your domain",
            "Prefix match on the registered URI",
            "Exact match on a pre-registered https URI, with loopback http allowed for native apps",
            "Allow any URI that returns 200"
          ],
          "answer": 2,
          "explain": "Exact matching is the only policy that does not create an open redirect. Wildcards and prefix matches let an attacker register a path that captures the code."
        }
      ],
      "quickbytes": [
        "Public clients get PKCE and no secret; only confidential clients get a secret.",
        "S256, never plain: the challenge is the base64url SHA-256 of the verifier.",
        "state is callback CSRF, nonce is ID-token binding. Ship both.",
        "Access token aud must equal your API; an ID token's aud is the client."
      ],
      "production": [
        "Redirect URIs are exact-matched per environment and reviewed like firewall rules.",
        "Every authorization request carries state, nonce, and a PKCE challenge; the exchange sends the verifier.",
        "The API validates access-token iss, aud, exp, and scope; it never accepts an ID token.",
        "Refresh tokens rotate on use and are bound to the client, with reuse detection revoking the family.",
        "email_verified is required before an email claim is used for account linking."
      ],
      "crates": [
        "openidconnect",
        "oauth2",
        "ring",
        "url"
      ],
      "github": [
        {
          "name": "ramosbugs/openidconnect-rs",
          "url": "https://github.com/ramosbugs/openidconnect-rs"
        },
        {
          "name": "ramosbugs/oauth2-rs",
          "url": "https://github.com/ramosbugs/oauth2-rs"
        }
      ],
      "pitfall": "Registering a redirect URI with a wildcard or allowing any path under your domain, which turns the authorization server into an open redirector that hands authorization codes to whoever asks.",
      "resources": [
        {
          "title": "The Web SSO Standard OpenID Connect: formal security analysis (arXiv 1704.08539)",
          "url": "https://arxiv.org/abs/1704.08539",
          "kind": "paper"
        },
        {
          "title": "OAuth 2.0 and OpenID Connect (in plain English) - OktaDev",
          "url": "https://www.youtube.com/watch?v=996OiexHze0",
          "kind": "video"
        },
        {
          "title": "openidconnect crate documentation",
          "url": "https://docs.rs/openidconnect/latest/openidconnect/",
          "kind": "docs"
        },
        {
          "title": "oauth2 crate documentation",
          "url": "https://docs.rs/oauth2/latest/oauth2/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "h06",
      "n": 6,
      "title": "JWT internals: header, claims, and the checks people skip",
      "minutes": 95,
      "level": "advanced",
      "goal": "Decode a JWT safely: pin the algorithm, select the key by kid from a trusted set, and enforce aud, iss, exp, and nbf instead of trusting the library defaults.",
      "sections": [
        {
          "h": "Base64 is not encryption",
          "p": [
            "A JWT is three base64url segments joined by dots: header, claims, signature. Anyone holding the token can read the header and the claims - no key required. That is by design, since the resource server must read them, but it means the payload is a public place: no passwords, no internal identifiers you would not put in a URL, no PII you would not log.",
            "The signature covers the encoded header and payload, so any change invalidates it. But the header is attacker-supplied input until verification succeeds, and it names the algorithm and the key id. Everything about how to verify comes from a value the attacker controls, which is why the verifier has to pin both."
          ],
          "list": [
            "Payload is readable by anyone with the token; treat it as public data",
            "alg and kid in the header are untrusted until the signature checks out",
            "A JWT is not a session: it cannot be revoked without a denylist or short expiry",
            "Never put a secret in a claim and assume the signature hides it"
          ]
        },
        {
          "h": "Algorithm confusion and key selection",
          "p": [
            "The classic attack is asking the verifier to check an RS256 token as HS256, using the public key as the HMAC secret. Any verifier that reads alg from the token and picks the primitive accordingly is exploitable. The fix is an allowlist: the verifier states which algorithm it accepts for this issuer, and rejects anything else before looking at a key.",
            "Key selection has the same shape. With a JWKS you choose the key by kid, but only from the set you fetched from the issuer's well-known endpoint, and you must confirm the key's own alg and use fields match. An unknown kid is a rejection, not a reason to try every key."
          ],
          "code": "use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};\nuse std::collections::HashMap;\n\n#[derive(Debug, serde::Deserialize)]\npub struct Claims {\n    pub sub: String,\n    pub iss: String,\n    pub aud: String,\n    pub exp: u64,\n    pub nbf: Option<u64>,\n    pub scope: Option<String>,\n}\n\n#[derive(Debug)]\npub enum AuthError { Malformed, BadAlg, UnknownKid, Invalid }\n\npub struct KeySet(pub HashMap<String, Vec<u8>>); // kid -> Ed25519 public key (DER)\n\npub fn verify(token: &str, keys: &KeySet, api_audience: &str) -> Result<Claims, AuthError> {\n    let header = decode_header(token).map_err(|_| AuthError::Malformed)?;\n\n    // Pin the algorithm before touching a key. No \"none\", no family fallback.\n    if header.alg != Algorithm::EdDSA {\n        return Err(AuthError::BadAlg);\n    }\n    let kid = header.kid.ok_or(AuthError::UnknownKid)?;\n    let key = keys.0.get(&kid).ok_or(AuthError::UnknownKid)?;\n\n    let mut v = Validation::new(Algorithm::EdDSA); // algorithms = [EdDSA]\n    v.set_audience(&[api_audience]);\n    v.set_issuer(&[\"https://auth.example.com\"]);\n    v.set_required_spec_claims(&[\"exp\", \"iss\", \"aud\", \"sub\"]);\n    v.validate_nbf = true; // off by default in jsonwebtoken 11\n    v.leeway = 30;\n\n    decode::<Claims>(token, &DecodingKey::from_ed_der(key), &v)\n        .map(|data| data.claims)\n        .map_err(|_| AuthError::Invalid)\n}",
          "tip": "Set validate_nbf explicitly. jsonwebtoken's Validation::new enables exp but leaves nbf unchecked, so a not-yet-valid token is accepted until you turn it on."
        },
        {
          "h": "The claims that decide whether the token is yours",
          "p": [
            "exp and nbf are clocks; aud and iss are identity. A token signed by your issuer but minted for a different service is a valid token and an invalid credential for you. In jsonwebtoken 11 a token carrying an aud you did not configure is rejected, but a token with no aud at all passes unless you require the claim - so require it and set the expected value.",
            "sub identifies the principal and must be stable; a mutable subject such as an email address breaks every downstream mapping when the user changes it. jti is the handle for revocation and replay detection, and scope or a permissions claim is what the authorization layer should read - not the presence of a token."
          ],
          "code": "// Minimum viable claim set for an access token.\n{\n  \"iss\": \"https://auth.example.com\",\n  \"sub\": \"usr_01J8Z9K3\",\n  \"aud\": \"api.example.com\",\n  \"exp\": 1767225600,\n  \"nbf\": 1767222000,\n  \"iat\": 1767222000,\n  \"jti\": \"01J8Z9K3-4b7c-9f2e\",\n  \"scope\": \"documents:read documents:write\",\n  \"tenant_id\": \"tnt_42\"\n}",
          "list": [
            "sub is an immutable id, never an email or username",
            "aud names the API that should accept the token, one value per audience",
            "exp short for access tokens: minutes, not hours, so revocation is bounded",
            "jti enables a denylist for the short window between revocation and expiry"
          ]
        },
        {
          "h": "Lifetime and revocation, honestly",
          "p": [
            "A stateless token cannot be un-issued. What you can do is bound the damage: short access-token lifetimes, refresh tokens that rotate, and a denylist keyed by jti for the few minutes between a logout or a compromise and natural expiry. The denylist is small because the window is small, which is what makes it affordable.",
            "Refresh tokens are the real credential and deserve the attention: rotate on every use, store only a hash, bind to the client, and revoke the whole family when an already-used token appears again. That reuse detection is the standard signal that a refresh token was stolen."
          ],
          "tip": "Set reject_tokens_expiring_in_less_than to a few seconds so a token that expires mid-flight fails at verification rather than after your handler started work."
        }
      ],
      "exercise": {
        "prompt": "Harden a JWT verification function: reject any algorithm other than EdDSA, reject unknown kid, require iss/aud/exp/sub, enable nbf checking with 30 seconds of leeway, and return a typed error instead of a string.",
        "starter": "pub fn verify(token: &str, jwks: &Jwks, aud: &str) -> Result<Claims, AuthError> {\n    // 1. decode the header without verifying\n    // 2. pin alg, select key by kid\n    // 3. build Validation with the claims you require\n    todo!()\n}",
        "hint": "decode_header first, compare header.alg to Algorithm::EdDSA, look up header.kid in the trusted set, then Validation::new(Algorithm::EdDSA) plus set_audience, set_issuer, set_required_spec_claims and validate_nbf = true.",
        "solution": "use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};\nuse std::collections::HashMap;\n\n#[derive(Debug, serde::Deserialize)]\npub struct Claims {\n    pub sub: String,\n    pub iss: String,\n    pub aud: String,\n    pub exp: u64,\n    pub nbf: Option<u64>,\n}\n\n#[derive(Debug)]\npub enum AuthError { Malformed, BadAlg, UnknownKid, Invalid }\n\npub struct Jwks(pub HashMap<String, Vec<u8>>);\n\npub fn verify(token: &str, jwks: &Jwks, aud: &str) -> Result<Claims, AuthError> {\n    let header = decode_header(token).map_err(|_| AuthError::Malformed)?;\n    if header.alg != Algorithm::EdDSA {\n        return Err(AuthError::BadAlg);\n    }\n    let kid = header.kid.ok_or(AuthError::UnknownKid)?;\n    let key = jwks.0.get(&kid).ok_or(AuthError::UnknownKid)?;\n\n    let mut v = Validation::new(Algorithm::EdDSA);\n    v.set_audience(&[aud]);\n    v.set_issuer(&[\"https://auth.example.com\"]);\n    v.set_required_spec_claims(&[\"exp\", \"iss\", \"aud\", \"sub\"]);\n    v.validate_nbf = true;\n    v.leeway = 30;\n\n    decode::<Claims>(token, &DecodingKey::from_ed_der(key), &v)\n        .map(|d| d.claims)\n        .map_err(|_| AuthError::Invalid)\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn unknown_kid_is_rejected_before_any_crypto() {\n        let jwks = Jwks(HashMap::new());\n        let err = verify(\"a.b.c\", &jwks, \"api.example.com\").unwrap_err();\n        assert!(matches!(err, AuthError::Malformed | AuthError::UnknownKid));\n    }\n}"
      },
      "questions": [
        {
          "q": "Why is reading alg from the token header and trusting it dangerous?",
          "options": [
            "Because base64 is slow",
            "An attacker can switch RS256 to HS256 and have the verifier use the public key as an HMAC secret",
            "Because the header is encrypted",
            "Because alg is not part of the signature"
          ],
          "answer": 1,
          "explain": "The verifier must choose the primitive from its own policy, not from attacker input. Pinning the algorithm to the one the issuer actually uses removes the entire confusion family."
        },
        {
          "q": "A token has a valid signature from your issuer but aud is another service. What should happen?",
          "options": [
            "Accept it, the signature is valid",
            "Reject it: audience is how you know the token was minted for you",
            "Accept it if the sub is a known user",
            "Accept it but strip the scope claim"
          ],
          "answer": 1,
          "explain": "Signature proves who minted the token, not who it was minted for. Without an audience check, every service sharing an issuer can use each other's tokens."
        },
        {
          "q": "In jsonwebtoken 11, which claim does Validation::new check by default?",
          "options": [
            "exp only, with nbf disabled and aud required only if the token carries one",
            "exp, nbf, aud, and iss",
            "iss only",
            "None, validation is opt-in"
          ],
          "answer": 0,
          "explain": "Validation::new requires exp, enables exp checking, leaves validate_nbf false, and rejects an aud-bearing token unless you configure the expected audience. A token with no aud passes unless you add it to required_spec_claims."
        }
      ],
      "quickbytes": [
        "decode_header first, pin alg, then pick the key by kid from a trusted set.",
        "Require aud and iss explicitly; a token without aud passes unless you demand it.",
        "validate_nbf is off by default in jsonwebtoken 11 - turn it on.",
        "Access tokens live minutes; refresh tokens rotate and revoke the family on reuse."
      ],
      "production": [
        "The verifier pins one algorithm per issuer and rejects unknown kid without trying other keys.",
        "iss, aud, exp, nbf, and sub are required claims, with leeway sized to real clock skew.",
        "Access-token lifetime is minutes; a jti denylist covers the revocation window.",
        "Refresh tokens are stored hashed, rotated on use, and reuse revokes the whole family.",
        "JWKS is cached with a TTL and refreshed on unknown kid, never fetched per request."
      ],
      "crates": [
        "jsonwebtoken",
        "serde",
        "ring",
        "tower-http"
      ],
      "github": [
        {
          "name": "Keats/jsonwebtoken",
          "url": "https://github.com/Keats/jsonwebtoken"
        },
        {
          "name": "briansmith/ring",
          "url": "https://github.com/briansmith/ring"
        }
      ],
      "pitfall": "Verifying with Validation::new(alg) but never setting an audience, then minting tokens without an aud claim: any token from the same issuer, including one for a different internal service, is accepted by every API.",
      "resources": [
        {
          "title": "jsonwebtoken Validation: fields and defaults",
          "url": "https://docs.rs/jsonwebtoken/latest/jsonwebtoken/struct.Validation.html",
          "kind": "docs"
        },
        {
          "title": "jsonwebtoken JWK module",
          "url": "https://docs.rs/jsonwebtoken/latest/jsonwebtoken/jwk/index.html",
          "kind": "docs"
        },
        {
          "title": "Keats/jsonwebtoken repository",
          "url": "https://github.com/Keats/jsonwebtoken",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "h07",
      "n": 7,
      "title": "Sessions and cookies: opaque ids and rotation",
      "minutes": 90,
      "level": "core",
      "goal": "Issue server-side sessions with 256-bit ids, set cookie attributes that survive a browser audit, rotate the id on privilege change, and store only a hash of the session id.",
      "sections": [
        {
          "h": "Opaque ids, because revocation has to work",
          "p": [
            "A signed cookie is self-contained and cannot be revoked before it expires without a server-side list, which defeats the point. A session id is an opaque 256-bit random value that means nothing until the server looks it up, so logout, password change, and admin revocation are single row operations.",
            "The trade-off is a lookup per request. That is a primary-key read on a table you control, and you were going to touch the database anyway; if it becomes hot, cache the session row with a short TTL and accept a bounded revocation delay that you document."
          ],
          "list": [
            "Generate at least 128 bits, prefer 256, from the OS CSPRNG",
            "Store a hash of the id so a database leak does not hand over live sessions",
            "Logout deletes the row; password change deletes every row for that user",
            "Never put user data in the cookie: it is a pointer, not a record"
          ]
        },
        {
          "h": "Cookie attributes that matter",
          "p": [
            "HttpOnly keeps the value away from JavaScript, which removes the easiest exfiltration path for an XSS bug. Secure keeps it off plaintext connections. SameSite=Lax blocks the cookie on cross-site POSTs, which is most of CSRF, while still allowing top-level navigation. Path=/ and no Domain attribute keep the cookie on the exact host that set it.",
            "The __Host- prefix is a browser-enforced contract: a cookie named __Host-sid must be Secure, must have Path=/, and must not set Domain. If any of those is violated the browser rejects the cookie, which turns a common misconfiguration into a visible failure instead of a silent downgrade."
          ],
          "code": "use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};\nuse ring::rand::{SecureRandom, SystemRandom};\nuse uuid::Uuid;\n\npub async fn start_session(\n    state: &AppState,\n    user_id: Uuid,\n    jar: CookieJar,\n) -> Result<CookieJar, sqlx::Error> {\n    let mut raw = [0u8; 32];\n    SystemRandom::new().fill(&mut raw).expect(\"os rng\");\n    let sid = hex::encode(raw); // 256 bits, unguessable\n    let sid_hash = sha256_hex(&sid); // what the database stores\n\n    sqlx::query(\n        \"INSERT INTO sessions (id_hash, user_id, idle_expires_at, absolute_expires_at)\\n         VALUES ($1, $2, now() + interval '30 minutes', now() + interval '12 hours')\",\n    )\n    .bind(&sid_hash)\n    .bind(user_id)\n    .execute(&state.db)\n    .await?;\n\n    let cookie = Cookie::build((\"__Host-sid\", sid))\n        .http_only(true)\n        .secure(true)\n        .same_site(SameSite::Lax)\n        .path(\"/\")\n        .max_age(cookie::time::Duration::hours(12))\n        .build();\n\n    Ok(jar.add(cookie))\n}\n\nfn sha256_hex(input: &str) -> String {\n    use ring::digest::{digest, SHA256};\n    digest(&SHA256, input.as_bytes())\n        .as_ref()\n        .iter()\n        .map(|b| format!(\"{b:02x}\"))\n        .collect()\n}",
          "tip": "SameSite=None exists for genuine cross-site cases and requires Secure. If you reach for it, you must add CSRF tokens back, because you just turned off the browser's default protection."
        },
        {
          "h": "Rotation, fixation, and timeouts",
          "p": [
            "Session fixation is an attack where the attacker plants a known session id and waits for the victim to log in, inheriting the authenticated session. The defence is unconditional: on login, and again on any privilege change such as MFA completion or role elevation, issue a new id, delete the old row, and set the new cookie.",
            "Two timeouts, not one. An idle timeout (say 30 minutes) bounds an unattended browser; an absolute timeout (say 12 hours) bounds how long a stolen id stays useful even with activity. Sliding the idle window on each request is fine, but never extend the absolute deadline."
          ],
          "code": "pub async fn rotate(state: &AppState, old_hash: &str, user_id: Uuid) -> Result<String, sqlx::Error> {\n    let mut tx = state.db.begin().await?;\n\n    // Kill the old session first: a failure here must not leave both alive.\n    sqlx::query(\"DELETE FROM sessions WHERE id_hash = $1\")\n        .bind(old_hash)\n        .execute(&mut *tx)\n        .await?;\n\n    let mut raw = [0u8; 32];\n    ring::rand::SystemRandom::new().fill(&mut raw).expect(\"os rng\");\n    let new_sid = hex::encode(raw);\n\n    sqlx::query(\n        \"INSERT INTO sessions (id_hash, user_id, idle_expires_at, absolute_expires_at)\\n         VALUES ($1, $2, now() + interval '30 minutes', now() + interval '12 hours')\",\n    )\n    .bind(sha256_hex(&new_sid))\n    .bind(user_id)\n    .execute(&mut *tx)\n    .await?;\n\n    tx.commit().await?;\n    Ok(new_sid)\n}",
          "list": [
            "Rotate on login, on MFA completion, on password change, on role change",
            "Delete the old session in the same transaction that creates the new one",
            "Idle timeout slides; absolute timeout never does",
            "Show the user their active sessions and let them revoke individual ones"
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement session rotation on privilege change: given the current session id hash and user id, atomically delete the old row, insert a new 256-bit session, and return the new cookie value. Explain in a comment why the delete comes first.",
        "starter": "pub async fn rotate(state: &AppState, old_hash: &str, user_id: Uuid) -> Result<String, sqlx::Error> {\n    // 1. begin transaction\n    // 2. delete old session\n    // 3. insert new session with fresh 256-bit id\n    // 4. commit and return the new id\n    todo!()\n}",
        "hint": "Use a transaction so a crash cannot leave two live sessions for one login. Delete by id_hash, insert the SHA-256 of the new id, and set both idle and absolute deadlines from now.",
        "solution": "use uuid::Uuid;\n\npub struct AppState { pub db: sqlx::PgPool }\n\nfn sha256_hex(input: &str) -> String {\n    use ring::digest::{digest, SHA256};\n    digest(&SHA256, input.as_bytes())\n        .as_ref()\n        .iter()\n        .map(|b| format!(\"{b:02x}\"))\n        .collect()\n}\n\npub async fn rotate(state: &AppState, old_hash: &str, user_id: Uuid) -> Result<String, sqlx::Error> {\n    let mut tx = state.db.begin().await?;\n\n    // Delete first: if the insert fails we want the user logged out, not\n    // holding two valid sessions after a privilege change.\n    sqlx::query(\"DELETE FROM sessions WHERE id_hash = $1\")\n        .bind(old_hash)\n        .execute(&mut *tx)\n        .await?;\n\n    let mut raw = [0u8; 32];\n    ring::rand::SystemRandom::new().fill(&mut raw).expect(\"os rng\");\n    let new_sid = hex::encode(raw);\n\n    sqlx::query(\n        \"INSERT INTO sessions (id_hash, user_id, idle_expires_at, absolute_expires_at)\\n         VALUES ($1, $2, now() + interval '30 minutes', now() + interval '12 hours')\",\n    )\n    .bind(sha256_hex(&new_sid))\n    .bind(user_id)\n    .execute(&mut *tx)\n    .await?;\n\n    tx.commit().await?;\n    Ok(new_sid)\n}\n\n// The handler then sets __Host-sid to new_sid with HttpOnly, Secure,\n// SameSite=Lax, Path=/ and no Domain attribute."
      },
      "questions": [
        {
          "q": "Why store a hash of the session id instead of the id itself?",
          "options": [
            "Hashes are shorter",
            "A database read then does not yield usable session cookies",
            "It makes lookups faster",
            "It allows the id to be longer"
          ],
          "answer": 1,
          "explain": "The hash is enough to look up the row, and a leaked dump or a read-only SQL injection no longer hands the attacker live sessions."
        },
        {
          "q": "What does session fixation require you to do at login?",
          "options": [
            "Extend the session lifetime",
            "Issue a brand-new session id and delete the pre-login one",
            "Rotate the TLS certificate",
            "Rehash the password"
          ],
          "answer": 1,
          "explain": "If the id the browser arrived with survives authentication, an attacker who planted it inherits the session. Rotation at login breaks the attack."
        },
        {
          "q": "What does the __Host- cookie prefix enforce?",
          "options": [
            "The cookie is encrypted",
            "Secure, Path=/, and no Domain attribute, or the browser refuses the cookie",
            "The cookie expires with the session",
            "The cookie is HttpOnly"
          ],
          "answer": 1,
          "explain": "The prefix is a browser-side contract that prevents a subdomain from setting a cookie for the parent host. It complements HttpOnly and SameSite rather than replacing them."
        }
      ],
      "quickbytes": [
        "256-bit ids from the OS CSPRNG, stored as SHA-256 in the database.",
        "__Host- prefix plus HttpOnly, Secure, SameSite=Lax, Path=/, no Domain.",
        "Rotate the id on login and on every privilege change, in one transaction.",
        "Idle timeout slides, absolute timeout does not."
      ],
      "production": [
        "Session ids are 256-bit CSPRNG values and only their hashes are stored.",
        "Cookies use the __Host- prefix with HttpOnly, Secure, SameSite=Lax, and no Domain.",
        "Rotation on login and privilege change is transactional and covered by a test.",
        "Idle and absolute timeouts are both enforced server-side, not just in cookie Max-Age.",
        "Users can list and revoke their own sessions; password change revokes all of them."
      ],
      "crates": [
        "axum-extra",
        "cookie",
        "ring",
        "sqlx"
      ],
      "github": [
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        },
        {
          "name": "briansmith/ring",
          "url": "https://github.com/briansmith/ring"
        }
      ],
      "pitfall": "Keeping the pre-login session id after authentication: an attacker who planted a known id on the victim's browser is now inside an authenticated session, and nothing in the logs shows a break-in.",
      "resources": [
        {
          "title": "OWASP session management cheat sheet",
          "url": "https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Session_Management_Cheat_Sheet.md",
          "kind": "docs"
        },
        {
          "title": "Language-Based Web Session Integrity (arXiv 2001.10405)",
          "url": "https://arxiv.org/abs/2001.10405",
          "kind": "paper"
        },
        {
          "title": "axum-extra cookie module",
          "url": "https://docs.rs/axum-extra/latest/axum_extra/extract/cookie/index.html",
          "kind": "docs"
        },
        {
          "title": "cookie crate documentation",
          "url": "https://docs.rs/cookie/latest/cookie/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "h08",
      "n": 8,
      "title": "Password hashing with Argon2id",
      "minutes": 85,
      "level": "core",
      "goal": "Hash passwords with Argon2id at parameters you can defend, add a pepper without breaking rotation, and rehash on login when the cost parameters change.",
      "sections": [
        {
          "h": "Speed is the vulnerability",
          "p": [
            "A password hash is judged by how many guesses per second an attacker gets with your stolen database. SHA-256 is designed to be fast, so a GPU tries billions of candidates per second and every leaked hash falls quickly. Memory-hard functions make each guess allocate memory, which is exactly what GPUs and ASICs are bad at, and that is the entire design goal of Argon2.",
            "Never design your own construction and never chain hashes to make them slow. Use Argon2id: the hybrid variant that resists GPU cracking while keeping the side-channel resistance of the data-independent mode for the first pass. The library owns the salt generation, the encoding, and the parameter parsing, so the only decisions left are the cost parameters and where the pepper lives."
          ],
          "list": [
            "Argon2id is the default choice; bcrypt only for legacy systems",
            "Salt is per password and stored in the PHC string, so no separate column",
            "Work factor is a budget in milliseconds on your hardware, not a magic number",
            "Rehash on successful login when the parameters change"
          ]
        },
        {
          "h": "Parameters you can defend",
          "p": [
            "OWASP publishes minimum Argon2id configurations that trade memory against iterations at roughly equal strength: 46 MiB with one pass, 19 MiB with two passes, 12 MiB with three, down to 7 MiB with five. Argon2's own defaults are 19 MiB, two passes, one lane - a sane floor, not a ceiling.",
            "Tune by measuring on production hardware: pick the largest memory cost that keeps p99 login latency acceptable under your expected concurrency, then verify that a login flood cannot exhaust memory. Parallelism does not make guessing slower per unit of memory, so do not raise p to look stronger."
          ],
          "code": "use argon2::{\n    password_hash::{phc::PasswordHash, PasswordHasher, PasswordVerifier},\n    Algorithm, Argon2, Params, Version,\n};\n\n/// OWASP minimum: m=19456 KiB (19 MiB), t=2, p=1.\npub fn hasher(pepper: &[u8]) -> Result<Argon2<'_>, argon2::Error> {\n    Argon2::new_with_secret(pepper, Algorithm::Argon2id, Version::V0x13, Params::DEFAULT)\n}\n\npub fn hash_password(pepper: &[u8], password: &str) -> Result<String, Box<dyn std::error::Error>> {\n    let argon2 = hasher(pepper)?;\n    // password-hash 0.6 generates a fresh random salt per call.\n    Ok(argon2.hash_password(password.as_bytes())?.to_string())\n}\n\npub fn verify_password(pepper: &[u8], password: &str, stored: &str) -> bool {\n    let Ok(parsed) = PasswordHash::new(stored) else { return false };\n    let Ok(argon2) = hasher(pepper) else { return false };\n    argon2.verify_password(password.as_bytes(), &parsed).is_ok()\n}",
          "tip": "The PHC string carries algorithm, version, m, t, p and salt, so raising the cost later is a rehash-on-login, not a migration."
        },
        {
          "h": "Pepper and the upgrade path",
          "p": [
            "A pepper is a secret mixed into the hash that is not stored with it. If the database leaks but the application secret does not, offline cracking needs the pepper as well. It is defence in depth, not a substitute for parameters: rotating the pepper means rehashing every password at next login, which is only possible if you can tell which pepper version produced a hash.",
            "Store a hash_params_version integer next to the hash. When the current version is newer, rehash on the next successful login, inside the same transaction that records the login. That one column also documents your parameter history to the next reviewer."
          ],
          "code": "pub const CURRENT_PARAMS_VERSION: i32 = 3; // bump when m/t/p or the pepper changes\n\npub async fn login(\n    state: &AppState,\n    user_id: uuid::Uuid,\n    password: &str,\n    stored_hash: &str,\n    stored_version: i32,\n) -> Result<(), sqlx::Error> {\n    let pepper = state.pepper.expose_secret().as_bytes();\n    let password = password.to_owned();\n    let stored = stored_hash.to_owned();\n    let pepper = pepper.to_vec();\n\n    let ok = tokio::task::spawn_blocking(move || {\n        crate::password::verify_password(&pepper, &password, &stored)\n    })\n    .await\n    .expect(\"blocking task panicked\");\n\n    if !ok {\n        return Ok(()); // caller turns this into the generic 401\n    }\n\n    if stored_version < CURRENT_PARAMS_VERSION {\n        let new_hash = tokio::task::spawn_blocking(move || {\n            crate::password::hash_password(&pepper, &password)\n        })\n        .await\n        .expect(\"blocking task panicked\")\n        .map_err(|_| sqlx::Error::Protocol(\"hash failed\".into()))?;\n\n        sqlx::query(\n            \"UPDATE users SET password_hash = $1, hash_params_version = $2 WHERE id = $3\",\n        )\n        .bind(new_hash)\n        .bind(CURRENT_PARAMS_VERSION)\n        .bind(user_id)\n        .execute(&state.db)\n        .await?;\n    }\n    Ok(())\n}",
          "list": [
            "Pepper lives in KMS or a secret manager, never in the users table",
            "Version the parameters so a rotation is resumable and observable",
            "Rehash only after a successful verification, never on a failed one",
            "Reject passwords over a documented maximum length before hashing"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a password module with hash, verify, and needs_rehash using a version column, a pepper from the secret manager, and spawn_blocking around every Argon2 call. Include a unit test that a hash verifies and that a wrong password fails.",
        "starter": "pub const CURRENT_VERSION: i32 = 1;\n\npub fn hash(pepper: &[u8], password: &str) -> Result<String, Box<dyn std::error::Error>> {\n    todo!()\n}\n\npub fn verify(pepper: &[u8], password: &str, stored: &str) -> bool {\n    todo!()\n}",
        "hint": "Argon2::new_with_secret(pepper, Algorithm::Argon2id, Version::V0x13, Params::DEFAULT), then hash_password(password.as_bytes()) and verify_password against PasswordHash::new(stored).",
        "solution": "use argon2::{\n    password_hash::{phc::PasswordHash, PasswordHasher, PasswordVerifier},\n    Algorithm, Argon2, Params, Version,\n};\n\npub const CURRENT_VERSION: i32 = 1;\n\nfn hasher(pepper: &[u8]) -> Result<Argon2<'_>, argon2::Error> {\n    Argon2::new_with_secret(pepper, Algorithm::Argon2id, Version::V0x13, Params::DEFAULT)\n}\n\npub fn hash(pepper: &[u8], password: &str) -> Result<String, Box<dyn std::error::Error>> {\n    let argon2 = hasher(pepper)?;\n    Ok(argon2.hash_password(password.as_bytes())?.to_string())\n}\n\npub fn verify(pepper: &[u8], password: &str, stored: &str) -> bool {\n    let Ok(parsed) = PasswordHash::new(stored) else { return false };\n    let Ok(argon2) = hasher(pepper) else { return false };\n    argon2.verify_password(password.as_bytes(), &parsed).is_ok()\n}\n\npub fn needs_rehash(stored_version: i32) -> bool {\n    stored_version < CURRENT_VERSION\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn round_trip_and_wrong_password() {\n        let pepper = b\"pepper-from-kms\";\n        let phc = hash(pepper, \"correct horse battery staple\").unwrap();\n        assert!(phc.starts_with(\"$argon2id$v=19$m=19456,t=2,p=1$\"));\n        assert!(verify(pepper, \"correct horse battery staple\", &phc));\n        assert!(!verify(pepper, \"correct horse battery stapl\", &phc));\n    }\n\n    #[test]\n    fn a_different_pepper_fails() {\n        let phc = hash(b\"pepper-a\", \"hunter2\").unwrap();\n        assert!(!verify(b\"pepper-b\", \"hunter2\", &phc));\n    }\n}"
      },
      "questions": [
        {
          "q": "Why is SHA-256 unsuitable for storing passwords?",
          "options": [
            "It produces collisions too easily",
            "It is fast, so a GPU can test billions of candidates per second against a leaked database",
            "It cannot handle non-ASCII input",
            "It is not available in Rust"
          ],
          "answer": 1,
          "explain": "The only defence a hash provides is the cost per guess. A fast hash makes the attacker's cost negligible, which is why memory-hard, tunable functions exist."
        },
        {
          "q": "What does raising Argon2's m_cost buy you?",
          "options": [
            "Faster logins",
            "A larger memory allocation per guess, which reduces GPU and ASIC parallelism",
            "Shorter hashes",
            "Immunity to credential stuffing"
          ],
          "answer": 1,
          "explain": "Memory hardness is the anti-parallelism lever. Each concurrent guess needs its own allocation, so the attacker's hardware budget buys fewer attempts per second."
        },
        {
          "q": "What is the purpose of a pepper?",
          "options": [
            "To make the salt unnecessary",
            "To add a secret not stored with the hash, so a database-only leak is harder to crack",
            "To encrypt the password",
            "To speed up verification"
          ],
          "answer": 1,
          "explain": "A pepper is defence in depth: the attacker needs both the database and the application secret. It does not replace per-password salts or adequate cost parameters."
        }
      ],
      "quickbytes": [
        "Argon2id, m=19456, t=2, p=1 is the floor; tune memory up until p99 login latency says stop.",
        "Every hash and verify goes through spawn_blocking; Argon2 is CPU and memory bound.",
        "Store hash_params_version so a parameter change is a rehash-on-login, not a migration.",
        "Pepper lives in KMS or the secret manager, never in the users table."
      ],
      "production": [
        "Password hashes are Argon2id PHC strings; a test asserts the expected m/t/p prefix.",
        "Argon2 runs on a blocking pool with a bounded concurrency so login floods cannot exhaust memory.",
        "hash_params_version is stored per user and drives rehash-on-login after a parameter change.",
        "The pepper is loaded from a secret manager, versioned, and rotatable without downtime.",
        "Passwords over the documented maximum length are rejected before hashing."
      ],
      "crates": [
        "argon2",
        "tokio",
        "secrecy"
      ],
      "github": [
        {
          "name": "RustCrypto/password-hashes",
          "url": "https://github.com/RustCrypto/password-hashes"
        },
        {
          "name": "iqlusioninc/crates",
          "url": "https://github.com/iqlusioninc/crates"
        }
      ],
      "pitfall": "Hashing on the async runtime: one Argon2id call at 19 MiB blocks a worker for tens of milliseconds, so a few hundred concurrent login attempts starve every other request on the process.",
      "resources": [
        {
          "title": "Open Sesame: The Password Hashing Competition and Argon2 (arXiv 1602.03097)",
          "url": "https://arxiv.org/abs/1602.03097",
          "kind": "paper"
        },
        {
          "title": "Evaluating Argon2 adoption and effectiveness in real-world software (arXiv 2504.17121)",
          "url": "https://arxiv.org/abs/2504.17121",
          "kind": "paper"
        },
        {
          "title": "OWASP password storage cheat sheet",
          "url": "https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Password_Storage_Cheat_Sheet.md",
          "kind": "docs"
        },
        {
          "title": "argon2 crate documentation",
          "url": "https://docs.rs/argon2/latest/argon2/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "h09",
      "n": 9,
      "title": "Cryptographic primitives: AEAD, MAC, KDF, signatures",
      "minutes": 100,
      "level": "advanced",
      "goal": "Pick a primitive by the property you need, use AES-256-GCM with a nonce discipline you can explain, derive per-tenant keys with HKDF, and compare secrets in constant time.",
      "sections": [
        {
          "h": "Choose by property, not by algorithm name",
          "p": [
            "Every crypto requirement is a property, and each property has one right family. Need confidentiality plus tamper detection? That is an AEAD: AES-256-GCM or ChaCha20-Poly1305. Need to prove a message came from someone holding a shared key? That is a MAC, HMAC-SHA-256. Need to turn one secret into many keys? That is a KDF, HKDF. Need to prove authorship to anyone? That is a signature, Ed25519 or ECDSA-P256.",
            "The failures come from using a primitive for a property it does not provide: encrypting without authentication, hashing a password with SHA-256, using a signature where a MAC is enough, or inventing a scheme by combining two primitives yourself. Pick the standard construction that already matches the property, and let the library own the details."
          ],
          "list": [
            "Confidentiality and integrity together: AEAD, never a bare block cipher mode",
            "Message authenticity with a shared key: HMAC, not a hash of key || message",
            "Key separation: HKDF with a distinct info string per purpose",
            "Public verifiability: Ed25519 signatures, never a MAC with a published key"
          ]
        },
        {
          "h": "Nonces: the one rule you cannot break",
          "p": [
            "AES-GCM is broken catastrophically by nonce reuse under the same key: two messages with the same nonce leak the XOR of their plaintexts and, worse, expose the authentication subkey. A 96-bit random nonce is safe for roughly 2^32 messages under one key by the birthday bound, which is fine for a per-tenant key and not fine for a global key on a high-volume path.",
            "Two disciplined options: a per-key counter persisted with the key (never reused across restarts), or a fresh random key per message wrapped by a long-lived KEK. ring forces the decision into the type system with Nonce::assume_unique_for_key - the name is the contract, and violating it is a silent catastrophe rather than a compile error."
          ],
          "code": "use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};\nuse ring::hkdf::{KeyType, Salt, HKDF_SHA256};\nuse ring::rand::{SecureRandom, SystemRandom};\n\nstruct TenantKey([u8; 32]);\nimpl KeyType for TenantKey {\n    fn len(&self) -> usize { 32 }\n}\n\n/// One master secret, one distinct key per tenant and purpose.\npub fn derive_tenant_key(master: &[u8], tenant: &str) -> Result<LessSafeKey, ring::error::Unspecified> {\n    let salt = Salt::new(HKDF_SHA256, b\"acme-doc-encryption-v1\");\n    let prk = salt.extract(master);\n    let okm = prk.expand(&[tenant.as_bytes()], TenantKey([0u8; 32]))?;\n    let mut key = [0u8; 32];\n    okm.fill(&mut key)?;\n    Ok(LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &key)?))\n}\n\npub fn seal(key: &LessSafeKey, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, ring::error::Unspecified> {\n    let mut nonce_bytes = [0u8; NONCE_LEN];\n    SystemRandom::new().fill(&mut nonce_bytes)?;\n    let mut out = plaintext.to_vec();\n    key.seal_in_place_append_tag(\n        Nonce::assume_unique_for_key(nonce_bytes),\n        Aad::from(aad),\n        &mut out,\n    )?;\n    out.extend_from_slice(&nonce_bytes); // ship the nonce with the ciphertext\n    Ok(out)\n}\n\npub fn open(key: &LessSafeKey, sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>, ring::error::Unspecified> {\n    let (ciphertext, nonce_bytes) = sealed.split_at(sealed.len() - NONCE_LEN);\n    let nonce = Nonce::try_assume_unique_for_key(nonce_bytes)?;\n    let mut buf = ciphertext.to_vec();\n    Ok(key.open_in_place(nonce, Aad::from(aad), &mut buf)?.to_vec())\n}",
          "tip": "Bind the record id into the AAD. A ciphertext moved to another row then fails to open, which turns a database-level copy attack into a decryption error."
        },
        {
          "h": "Compare in constant time, or not at all",
          "p": [
            "Comparing a MAC or token with == leaks through timing: the comparison stops at the first differing byte, so an attacker who can measure many attempts learns the value one byte at a time. The fix is a comparison whose running time depends only on the length, which is what subtle::ConstantTimeEq provides.",
            "Use it for MAC verification, for API-key comparison, and for session tokens that are not looked up by hash. Do not use it as a substitute for hashing: if you compare a stored secret, store a hash and compare hashes, so a database read does not yield the credential."
          ],
          "code": "use subtle::ConstantTimeEq;\n\npub fn verify_api_key(provided: &[u8], expected_hash: &[u8]) -> bool {\n    use ring::digest::{digest, SHA256};\n    let candidate = digest(&SHA256, provided);\n    // Both sides are fixed-length digests, so length never varies.\n    candidate.as_ref().ct_eq(expected_hash).unwrap_u8() == 1\n}",
          "list": [
            "MAC verification, API keys, and opaque tokens: constant-time compare",
            "Passwords: a slow hash, then compare the hash outputs",
            "Never branch on secret bytes; never log a partial secret to debug a mismatch",
            "If the comparison result drives an error message, keep the message identical either way"
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement seal and open for small documents using AES-256-GCM with a per-tenant key derived by HKDF, a random 96-bit nonce stored with the ciphertext, and the document id bound as associated data. Show that opening with the wrong document id fails.",
        "starter": "pub fn seal(key: &LessSafeKey, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, ring::error::Unspecified> {\n    todo!()\n}\n\npub fn open(key: &LessSafeKey, sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>, ring::error::Unspecified> {\n    todo!()\n}",
        "hint": "Append the nonce after the tag so the ciphertext length is known, split it back off on open, and pass Aad::from(document_id) on both sides.",
        "solution": "use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};\nuse ring::rand::{SecureRandom, SystemRandom};\n\npub fn seal(key: &LessSafeKey, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, ring::error::Unspecified> {\n    let mut nonce_bytes = [0u8; NONCE_LEN];\n    SystemRandom::new().fill(&mut nonce_bytes)?;\n    let mut out = plaintext.to_vec();\n    key.seal_in_place_append_tag(\n        Nonce::assume_unique_for_key(nonce_bytes),\n        Aad::from(aad),\n        &mut out,\n    )?;\n    out.extend_from_slice(&nonce_bytes);\n    Ok(out)\n}\n\npub fn open(key: &LessSafeKey, sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>, ring::error::Unspecified> {\n    if sealed.len() < NONCE_LEN { return Err(ring::error::Unspecified); }\n    let (ciphertext, nonce_bytes) = sealed.split_at(sealed.len() - NONCE_LEN);\n    let nonce = Nonce::try_assume_unique_for_key(nonce_bytes)?;\n    let mut buf = ciphertext.to_vec();\n    Ok(key.open_in_place(nonce, Aad::from(aad), &mut buf)?.to_vec())\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    fn key() -> LessSafeKey {\n        let k = [7u8; 32];\n        LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &k).unwrap())\n    }\n\n    #[test]\n    fn aad_binds_the_document() {\n        let sealed = seal(&key(), b\"balance: 100\", b\"doc-1\").unwrap();\n        assert_eq!(open(&key(), &sealed, b\"doc-1\").unwrap(), b\"balance: 100\");\n        assert!(open(&key(), &sealed, b\"doc-2\").is_err());\n    }\n}"
      },
      "questions": [
        {
          "q": "Why is AES-256-GCM with a repeated nonce catastrophic rather than merely weak?",
          "options": [
            "It makes the key longer",
            "Reuse leaks the XOR of plaintexts and exposes the authentication subkey, allowing forgery",
            "It slows decryption",
            "It changes the ciphertext length"
          ],
          "answer": 1,
          "explain": "GCM derives its authentication key from the nonce. Reusing a nonce with the same key breaks both confidentiality and integrity, which is why the nonce discipline is the whole game."
        },
        {
          "q": "You need to prove a message came from a service that shares a secret with you. Which primitive?",
          "options": [
            "Ed25519 signature",
            "HMAC-SHA-256 with the shared key",
            "SHA-256 of the message",
            "AES-256-GCM with a fixed nonce"
          ],
          "answer": 1,
          "explain": "A shared key means a MAC. A signature is for public verifiability; a plain hash provides no key binding at all."
        },
        {
          "q": "What does HKDF's info parameter give you?",
          "options": [
            "A random salt",
            "Domain separation: the same master secret yields independent keys per purpose and tenant",
            "Faster derivation",
            "Key compression"
          ],
          "answer": 1,
          "explain": "Distinct info strings produce independent keys from one master. Without separation, a key derived for encryption could be reused where a MAC key was intended."
        }
      ],
      "quickbytes": [
        "AEAD or nothing: a bare CBC mode gives confidentiality and no integrity.",
        "Random 96-bit nonces are safe to about 2^32 messages per key; beyond that, counter or rekey.",
        "Bind record ids as AAD so a ciphertext cannot be moved to another row.",
        "subtle::ct_eq for MAC and token comparisons; Argon2 for passwords."
      ],
      "production": [
        "All symmetric encryption uses an AEAD with a documented nonce strategy and key lifetime.",
        "Keys are derived per tenant and purpose with HKDF and a versioned info string.",
        "Associated data binds each ciphertext to its record identity.",
        "MAC and token comparisons use constant-time equality; a clippy or review rule catches ==",
        "A crypto inventory lists every algorithm, key size, and purpose, so a primitive can be retired."
      ],
      "crates": [
        "ring",
        "subtle",
        "zeroize",
        "secrecy"
      ],
      "github": [
        {
          "name": "briansmith/ring",
          "url": "https://github.com/briansmith/ring"
        },
        {
          "name": "dalek-cryptography/subtle",
          "url": "https://github.com/dalek-cryptography/subtle"
        }
      ],
      "pitfall": "Generating a random 96-bit nonce for AES-GCM under one long-lived global key on a high-volume path: past a few billion messages the birthday bound makes a repeat likely, and a single repeat breaks the key.",
      "resources": [
        {
          "title": "Constant-Time Foundations for the New Spectre Era (arXiv 1910.01755)",
          "url": "https://arxiv.org/abs/1910.01755",
          "kind": "paper"
        },
        {
          "title": "ring AEAD module: LessSafeKey, Nonce, algorithms",
          "url": "https://docs.rs/ring/latest/ring/aead/index.html",
          "kind": "docs"
        },
        {
          "title": "ring HKDF module",
          "url": "https://docs.rs/ring/latest/ring/hkdf/index.html",
          "kind": "docs"
        },
        {
          "title": "subtle: constant-time comparison",
          "url": "https://docs.rs/subtle/latest/subtle/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "h10",
      "n": 10,
      "title": "Key management: envelope encryption and rotation",
      "minutes": 95,
      "level": "advanced",
      "goal": "Design a key hierarchy with a KEK in KMS and per-record data keys, rotate signing and encryption keys with overlapping validity, and make old ciphertext decryptable without a flag day.",
      "sections": [
        {
          "h": "A hierarchy, because one key cannot do everything",
          "p": [
            "Envelope encryption separates the key that protects data from the key that protects keys. Each record gets a data encryption key (DEK); the DEK encrypts the record; a key encryption key (KEK) held in a KMS or HSM wraps the DEK; the wrapped DEK is stored next to the ciphertext. A database leak yields ciphertext and wrapped keys, and unwrapping requires a call the KMS will log, authorize, and can refuse.",
            "The hierarchy also bounds blast radius. One DEK per record means compromising a DEK compromises one record. One KEK per tenant means a tenant offboarding is a single key deletion. A single global key means every compromise is total, and it makes rotation an outage."
          ],
          "list": [
            "Root key: never leaves the HSM or KMS",
            "KEK: per tenant or per environment, used only to wrap and unwrap DEKs",
            "DEK: per record or per batch, used once and stored wrapped",
            "Never cache unwrapped DEKs longer than the operation that needs them"
          ]
        },
        {
          "h": "Rotation with overlapping validity",
          "p": [
            "Rotation is not replacing a key; it is introducing a new key while the old one still decrypts. Every ciphertext and every token carries a key id, so the reader can pick the right key. New writes use the active key, old keys move to decrypt-only, and only after the longest-lived ciphertext or token has expired can a key be destroyed.",
            "For signing keys the same rule applies with a sharper deadline: publish the new public key in the JWKS before you sign with it, keep the old one published for at least one token lifetime plus clock skew, then remove it. A rotation that swaps keys atomically invalidates every live session and every cached JWKS at once."
          ],
          "code": "use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};\nuse ring::rand::{SecureRandom, SystemRandom};\nuse std::collections::HashMap;\n\npub struct Envelope {\n    pub kid: String,\n    pub nonce: [u8; NONCE_LEN],\n    pub ciphertext: Vec<u8>,\n}\n\npub struct KeyRing {\n    active: String,\n    keys: HashMap<String, LessSafeKey>, // active + retiring\n}\n\n#[derive(Debug)]\npub enum KeyError { UnknownKey, Crypto }\n\nimpl KeyRing {\n    pub fn new(active: impl Into<String>, keys: HashMap<String, LessSafeKey>) -> Self {\n        Self { active: active.into(), keys }\n    }\n\n    pub fn encrypt(&self, plaintext: &[u8], aad: &[u8]) -> Result<Envelope, KeyError> {\n        let key = self.keys.get(&self.active).ok_or(KeyError::UnknownKey)?;\n        let mut nonce = [0u8; NONCE_LEN];\n        SystemRandom::new().fill(&mut nonce).map_err(|_| KeyError::Crypto)?;\n        let mut ciphertext = plaintext.to_vec();\n        key.seal_in_place_append_tag(\n            Nonce::assume_unique_for_key(nonce),\n            Aad::from(aad),\n            &mut ciphertext,\n        )\n        .map_err(|_| KeyError::Crypto)?;\n        Ok(Envelope { kid: self.active.clone(), nonce, ciphertext })\n    }\n\n    pub fn decrypt(&self, env: &Envelope, aad: &[u8]) -> Result<Vec<u8>, KeyError> {\n        let key = self.keys.get(&env.kid).ok_or(KeyError::UnknownKey)?;\n        let mut buf = env.ciphertext.clone();\n        let plain = key\n            .open_in_place(Nonce::assume_unique_for_key(env.nonce), Aad::from(aad), &mut buf)\n            .map_err(|_| KeyError::Crypto)?;\n        Ok(plain.to_vec())\n    }\n}",
          "tip": "Keep the retiring keys in the ring, not in a backup file. A key you cannot reach at 3 a.m. is the same as a key you deleted."
        },
        {
          "h": "Re-wrap, do not re-encrypt",
          "p": [
            "Rotating a KEK does not require touching the data: unwrap each DEK with the old KEK and wrap it with the new one. That is a small, online, restartable migration over the key table, not a rewrite of the object store. Rotating a DEK does require re-encrypting the record, so do that lazily on write and track coverage.",
            "Track which keys are still referenced before destroying one. A key with live references is not garbage; a key with none, past its retention window, is. That count is also your evidence during an audit that a retired key can no longer decrypt anything."
          ],
          "list": [
            "KEK rotation: re-wrap DEKs, no data rewrite",
            "DEK rotation: lazy re-encrypt on write, plus a backfill job with progress",
            "Destroy a key only when the reference count is zero and retention allows",
            "Log every unwrap with the caller identity: that log is the audit trail"
          ]
        },
        {
          "h": "Crypto-shredding is a feature, not a hack",
          "p": [
            "If each record's DEK is unique, deleting the key makes the ciphertext permanently unreadable. That is the cleanest way to honour a deletion request in an immutable object store or a backup you cannot rewrite: destroy the key, and the data is gone by construction rather than by a delete statement you hope ran everywhere.",
            "This only works if the key is genuinely unrecoverable: no copies in a backup, no wrapped DEK cached in a service, no HSM export. The deletion procedure has to be tested like any other destructive operation, including a restore drill that proves the old key cannot come back."
          ],
          "tip": "Test crypto-shredding in staging by destroying a key and asserting decryption fails, then restore and assert the key does not reappear."
        }
      ],
      "exercise": {
        "prompt": "Implement a KeyRing that encrypts with the active key and decrypts with any key in the ring, returning the key id inside the envelope. Add a rotation method that promotes a new active key while keeping the old one for decryption.",
        "starter": "pub struct KeyRing { active: String, keys: HashMap<String, LessSafeKey> }\n\nimpl KeyRing {\n    pub fn encrypt(&self, plaintext: &[u8], aad: &[u8]) -> Result<Envelope, KeyError> { todo!() }\n    pub fn decrypt(&self, env: &Envelope, aad: &[u8]) -> Result<Vec<u8>, KeyError> { todo!() }\n    pub fn rotate_to(&mut self, kid: String, key: LessSafeKey) { todo!() }\n}",
        "hint": "Encrypt reads self.active and stamps it into Envelope.kid; decrypt looks up env.kid; rotate_to inserts the new key and swaps the active name, leaving the old key in the map.",
        "solution": "use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};\nuse ring::rand::{SecureRandom, SystemRandom};\nuse std::collections::HashMap;\n\npub struct Envelope { pub kid: String, pub nonce: [u8; NONCE_LEN], pub ciphertext: Vec<u8> }\n\n#[derive(Debug)]\npub enum KeyError { UnknownKey, Crypto }\n\npub struct KeyRing { active: String, keys: HashMap<String, LessSafeKey> }\n\nimpl KeyRing {\n    pub fn new(active: impl Into<String>, keys: HashMap<String, LessSafeKey>) -> Self {\n        Self { active: active.into(), keys }\n    }\n\n    pub fn encrypt(&self, plaintext: &[u8], aad: &[u8]) -> Result<Envelope, KeyError> {\n        let key = self.keys.get(&self.active).ok_or(KeyError::UnknownKey)?;\n        let mut nonce = [0u8; NONCE_LEN];\n        SystemRandom::new().fill(&mut nonce).map_err(|_| KeyError::Crypto)?;\n        let mut ciphertext = plaintext.to_vec();\n        key.seal_in_place_append_tag(\n            Nonce::assume_unique_for_key(nonce), Aad::from(aad), &mut ciphertext,\n        ).map_err(|_| KeyError::Crypto)?;\n        Ok(Envelope { kid: self.active.clone(), nonce, ciphertext })\n    }\n\n    pub fn decrypt(&self, env: &Envelope, aad: &[u8]) -> Result<Vec<u8>, KeyError> {\n        let key = self.keys.get(&env.kid).ok_or(KeyError::UnknownKey)?;\n        let mut buf = env.ciphertext.clone();\n        let plain = key\n            .open_in_place(Nonce::assume_unique_for_key(env.nonce), Aad::from(aad), &mut buf)\n            .map_err(|_| KeyError::Crypto)?;\n        Ok(plain.to_vec())\n    }\n\n    /// New writes use the new key; old ciphertext still decrypts.\n    pub fn rotate_to(&mut self, kid: String, key: LessSafeKey) {\n        self.keys.insert(kid.clone(), key);\n        self.active = kid;\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    fn key(byte: u8) -> LessSafeKey {\n        LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &[byte; 32]).unwrap())\n    }\n\n    #[test]\n    fn old_ciphertext_survives_rotation() {\n        let mut ring = KeyRing::new(\"k1\", HashMap::from([(\"k1\".to_string(), key(1))]));\n        let old = ring.encrypt(b\"before\", b\"rec-1\").unwrap();\n        ring.rotate_to(\"k2\".to_string(), key(2));\n        assert_eq!(ring.decrypt(&old, b\"rec-1\").unwrap(), b\"before\");\n        assert_eq!(ring.encrypt(b\"after\", b\"rec-2\").unwrap().kid, \"k2\");\n    }\n}"
      },
      "questions": [
        {
          "q": "What is the point of envelope encryption?",
          "options": [
            "It compresses ciphertext",
            "Data keys stay small and local while the KEK in KMS is only used to wrap and unwrap them, limiting blast radius and KMS load",
            "It removes the need for nonces",
            "It makes encryption faster than AES"
          ],
          "answer": 1,
          "explain": "You get per-record keys without a KMS call per record operation: wrap once, use the DEK for the data, and keep the root key out of the data path."
        },
        {
          "q": "What must happen before you remove a retired signing key from the JWKS?",
          "options": [
            "Nothing, remove it when the new key is active",
            "Wait at least one token lifetime plus clock skew so tokens signed with it have expired",
            "Restart every service",
            "Delete all sessions"
          ],
          "answer": 1,
          "explain": "Verifiers cache JWKS and tokens carry an exp. Removing a key too early turns valid tokens into verification failures, which looks like an outage to users."
        },
        {
          "q": "How does crypto-shredding delete data that lives in immutable backups?",
          "options": [
            "By overwriting the ciphertext",
            "By destroying the only key that can decrypt it, making the ciphertext permanently unreadable",
            "By expiring the backup",
            "By rotating the KEK"
          ],
          "answer": 1,
          "explain": "If the DEK is unique and genuinely destroyed, the ciphertext is noise. The guarantee depends on there being no surviving copy of the key anywhere."
        }
      ],
      "quickbytes": [
        "Every ciphertext and token carries a kid; readers select by kid, writers use the active key.",
        "Rotate by adding, not swapping: overlap at least one token lifetime.",
        "KEK rotation re-wraps DEKs; DEK rotation re-encrypts data lazily.",
        "Destroy a key only at zero references, and log every unwrap."
      ],
      "production": [
        "Root keys live in KMS or an HSM and never appear in process memory or config.",
        "Every envelope and token carries a key id; unknown kid is a hard failure, not a fallback.",
        "Rotation runbooks cover JWKS overlap, cached verifier keys, and rollback.",
        "A key inventory tracks references, creation, retirement, and destruction dates.",
        "Crypto-shredding is tested in staging, including a restore drill proving the key stays gone."
      ],
      "crates": [
        "ring",
        "rustls",
        "jsonwebtoken",
        "secrecy"
      ],
      "github": [
        {
          "name": "briansmith/ring",
          "url": "https://github.com/briansmith/ring"
        },
        {
          "name": "rustls/rustls",
          "url": "https://github.com/rustls/rustls"
        }
      ],
      "pitfall": "Rotating a signing key by replacing it atomically: every token signed with the old key fails verification, every cached JWKS is stale, and every logged-in user is signed out at the same moment.",
      "resources": [
        {
          "title": "OWASP key management cheat sheet",
          "url": "https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Key_Management_Cheat_Sheet.md",
          "kind": "docs"
        },
        {
          "title": "What are hardware security modules (HSM) - LearnCantrill",
          "url": "https://www.youtube.com/watch?v=szagwwSLbXo",
          "kind": "video"
        },
        {
          "title": "ring AEAD module",
          "url": "https://docs.rs/ring/latest/ring/aead/index.html",
          "kind": "docs"
        },
        {
          "title": "jsonwebtoken JWK module",
          "url": "https://docs.rs/jsonwebtoken/latest/jsonwebtoken/jwk/index.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "h11",
      "n": 11,
      "title": "Secret storage: from env vars to a secret manager",
      "minutes": 80,
      "level": "advanced",
      "goal": "Load secrets in a way that keeps them out of logs, crash dumps, and child processes, wrap them so accidental printing is a compile-time nuisance, and rotate them without a redeploy.",
      "sections": [
        {
          "h": "Environment variables are a floor, not a solution",
          "p": [
            "An environment variable is readable from /proc/<pid>/environ by the same user and by root, inherited by every child process, included in some crash dumps, and printed by any debug endpoint that dumps the environment. It survives in shell history and in the docker inspect output of the container. That is still better than a secret committed to the repository, which is the actual bar it clears.",
            "The next step up is a file the process reads and then closes: a mounted Kubernetes secret, a systemd LoadCredential file, or a tmpfs file with mode 0400. Better still is fetching at boot from a secret manager with a workload identity, so the secret exists in the process's memory only and never in the orchestrator's spec."
          ],
          "list": [
            "Never commit secrets; enable push protection and secret scanning",
            "Prefer workload-identity fetch or a credential file over env vars",
            "Give each service its own credential with the narrowest scope",
            "Assume anything in the environment is visible to a curious process"
          ]
        },
        {
          "h": "Make printing a secret hard",
          "p": [
            "The most common leak is not an attacker; it is a #[derive(Debug)] on a config struct that ends up in a tracing field during an incident. Wrap secrets in a type whose Debug prints a placeholder, whose Display does not exist, and whose contents are only reachable through an explicit expose call that shows up in code review.",
            "secrecy::SecretString and SecretBox do exactly this and zeroize on drop, which removes the secret from memory when the value goes out of scope instead of leaving it in a freed allocation. zeroize on its own is useful for buffers you manage yourself; the wrapper is what makes the default safe."
          ],
          "code": "use secrecy::{ExposeSecret, SecretString};\nuse std::fmt;\n\npub struct DbConfig {\n    pub host: String,\n    pub user: String,\n    pub password: SecretString,\n}\n\nimpl fmt::Debug for DbConfig {\n    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {\n        f.debug_struct(\"DbConfig\")\n            .field(\"host\", &self.host)\n            .field(\"user\", &self.user)\n            .field(\"password\", &\"[redacted]\")\n            .finish()\n    }\n}\n\nimpl DbConfig {\n    pub fn from_env() -> Result<Self, ConfigError> {\n        Ok(Self {\n            host: std::env::var(\"DB_HOST\").map_err(|_| ConfigError::Missing(\"DB_HOST\"))?,\n            user: std::env::var(\"DB_USER\").map_err(|_| ConfigError::Missing(\"DB_USER\"))?,\n            password: SecretString::new(\n                std::env::var(\"DB_PASSWORD\")\n                    .map_err(|_| ConfigError::Missing(\"DB_PASSWORD\"))?\n                    .into_boxed_str(),\n            ),\n        })\n    }\n\n    /// Hand the secret straight to the driver: no format!, no URL string to leak.\n    pub fn connect_options(&self) -> sqlx::postgres::PgConnectOptions {\n        sqlx::postgres::PgConnectOptions::new()\n            .host(&self.host)\n            .username(&self.user)\n            .password(self.password.expose_secret())\n    }\n}",
          "tip": "expose_secret in a function call is auditable. Secret material interpolated into a format! string is not, because the resulting String is a plain allocation nobody redacts."
        },
        {
          "h": "Redact at the transport, not only in your structs",
          "p": [
            "Your structs are not the only place secrets travel. Authorization headers, cookies, and signed URLs pass through tower middleware, and a TraceLayer that logs headers will happily record a bearer token. tower-http's sensitive_headers module marks those headers so tracing and debug output redact them, which covers the paths you did not write.",
            "Log hygiene is a control, not a style preference: logs leave the trust boundary into a pipeline with different access controls and longer retention than the database. Assume anything you log is retained for a year and readable by the observability vendor."
          ],
          "code": "use axum::http::{header, HeaderName};\nuse tower_http::sensitive_headers::SetSensitiveRequestHeadersLayer;\n\npub fn redaction_layer() -> SetSensitiveRequestHeadersLayer {\n    SetSensitiveRequestHeadersLayer::new([\n        header::AUTHORIZATION,\n        header::COOKIE,\n        header::SET_COOKIE,\n        header::PROXY_AUTHORIZATION,\n        HeaderName::from_static(\"x-api-key\"),\n        HeaderName::from_static(\"x-csrf-token\"),\n    ])\n}",
          "list": [
            "Mark Authorization, Cookie, Set-Cookie, and custom key headers as sensitive",
            "Never log request bodies on auth endpoints, even at debug level",
            "Scrub query strings: tokens in URLs end up in access logs and referrers",
            "Set a retention period on logs that is shorter than your database's"
          ]
        },
        {
          "h": "Rotation and blast radius",
          "p": [
            "A secret you cannot rotate is a secret you cannot respond to. Prefer credentials that are short-lived by construction - database IAM auth, workload identity tokens, mTLS - over a static password that lives for years. Where a static secret is unavoidable, support two active values during rotation so a deploy is not required in the same minute as the change.",
            "Scope each secret to one service and one environment. A shared global database password means every compromise is total and every rotation is an outage across teams; per-service roles with narrow grants turn the same incident into a single service's problem."
          ],
          "tip": "Store the secret's name and version in config, not the value: the process resolves it at boot, and rotation becomes a config change plus a restart."
        }
      ],
      "exercise": {
        "prompt": "Write a Config type that loads a database password from a credential file, wraps it in SecretString, implements Debug with redaction, and builds PgConnectOptions without ever formatting the password into a URL. Add a test that the Debug output contains no secret.",
        "starter": "pub struct DbConfig { pub host: String, pub user: String, pub password: secrecy::SecretString }\n\nimpl std::fmt::Debug for DbConfig { /* redacted */ }\n\nimpl DbConfig {\n    pub fn load(path: &std::path::Path) -> Result<Self, Box<dyn std::error::Error>> { todo!() }\n}",
        "hint": "Read the file to a String, trim the trailing newline, SecretString::new(s.into_boxed_str()), and hand expose_secret() directly to PgConnectOptions::password.",
        "solution": "use secrecy::{ExposeSecret, SecretString};\nuse std::fmt;\nuse std::path::Path;\n\npub struct DbConfig {\n    pub host: String,\n    pub user: String,\n    pub password: SecretString,\n}\n\nimpl fmt::Debug for DbConfig {\n    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {\n        f.debug_struct(\"DbConfig\")\n            .field(\"host\", &self.host)\n            .field(\"user\", &self.user)\n            .field(\"password\", &\"[redacted]\")\n            .finish()\n    }\n}\n\nimpl DbConfig {\n    /// Reads a mounted credential file (systemd LoadCredential, k8s secret volume).\n    pub fn load(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {\n        let password = std::fs::read_to_string(path)?.trim_end().to_owned();\n        Ok(Self {\n            host: std::env::var(\"DB_HOST\")?,\n            user: std::env::var(\"DB_USER\")?,\n            password: SecretString::new(password.into_boxed_str()),\n        })\n    }\n\n    pub fn connect_options(&self) -> sqlx::postgres::PgConnectOptions {\n        sqlx::postgres::PgConnectOptions::new()\n            .host(&self.host)\n            .username(&self.user)\n            .password(self.password.expose_secret())\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn debug_never_prints_the_password() {\n        let cfg = DbConfig {\n            host: \"db\".into(),\n            user: \"app\".into(),\n            password: SecretString::new(\"super-secret\".into()),\n        };\n        let rendered = format!(\"{cfg:?}\");\n        assert!(!rendered.contains(\"super-secret\"));\n        assert!(rendered.contains(\"[redacted]\"));\n    }\n}"
      },
      "questions": [
        {
          "q": "Why is an environment variable a weak place for a long-lived secret?",
          "options": [
            "It is encrypted at rest",
            "It is readable from the process environment, inherited by children, and often captured in dumps and inspect output",
            "It cannot be longer than 64 bytes",
            "Rust cannot read it"
          ],
          "answer": 1,
          "explain": "The environment is a convenience channel with wide visibility: other processes under the same user, crash tooling, and orchestration debug commands all see it."
        },
        {
          "q": "What does SecretString buy you over a plain String?",
          "options": [
            "Encryption at rest",
            "A redacted Debug, no Display, explicit expose, and zeroization on drop",
            "Faster access",
            "Automatic rotation"
          ],
          "answer": 1,
          "explain": "The wrapper makes accidental logging a deliberate act and wipes memory when the value drops. It does not encrypt anything or rotate anything."
        },
        {
          "q": "Where should redaction also be applied besides your config structs?",
          "options": [
            "In the database schema",
            "In the HTTP middleware that logs headers and bodies, where tokens travel outside your types",
            "In the TLS handshake",
            "In the Rust compiler"
          ],
          "answer": 1,
          "explain": "TraceLayer and access logs see Authorization and Cookie headers. Marking them sensitive at the transport layer covers the code paths you did not write."
        }
      ],
      "quickbytes": [
        "Credential file with 0400, read once at boot, beats an env var for long-lived secrets.",
        "SecretString + a manual Debug impl makes accidental logging a review finding.",
        "SetSensitiveRequestHeadersLayer for Authorization, Cookie, and API-key headers.",
        "Prefer short-lived workload-identity credentials over static passwords you must rotate."
      ],
      "production": [
        "No secret is present in the repository, image layers, or build args; secret scanning is enforced.",
        "Secrets are fetched with workload identity or mounted as files, not baked into env vars in the orchestrator spec.",
        "Config structs redact secrets in Debug and never format them into connection strings.",
        "HTTP logging marks Authorization, Cookie, and API-key headers as sensitive.",
        "Every secret has an owner, a rotation procedure, and a documented blast radius."
      ],
      "crates": [
        "secrecy",
        "zeroize",
        "tower-http",
        "sqlx"
      ],
      "github": [
        {
          "name": "iqlusioninc/crates",
          "url": "https://github.com/iqlusioninc/crates"
        },
        {
          "name": "RustCrypto/utils",
          "url": "https://github.com/RustCrypto/utils"
        }
      ],
      "pitfall": "A #[derive(Debug)] on the config struct plus a startup log line: the database password is now in the log pipeline with a year of retention and a third-party reader, and nobody notices until an incident review.",
      "resources": [
        {
          "title": "OWASP secrets management cheat sheet",
          "url": "https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Secrets_Management_Cheat_Sheet.md",
          "kind": "docs"
        },
        {
          "title": "Secret Management with HashiCorp Vault - Daniel Bornkessel, GOTO 2018",
          "url": "https://www.youtube.com/watch?v=C2iUSUtr93E",
          "kind": "video"
        },
        {
          "title": "secrecy: SecretBox and SecretString",
          "url": "https://docs.rs/secrecy/latest/secrecy/",
          "kind": "docs"
        },
        {
          "title": "tower-http sensitive headers middleware",
          "url": "https://docs.rs/tower-http/latest/tower_http/sensitive_headers/index.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "h12",
      "n": 12,
      "title": "TLS configuration with rustls",
      "minutes": 85,
      "level": "advanced",
      "goal": "Terminate TLS with rustls defaults, load a certificate chain and key correctly, reload certificates without a restart, and know exactly where the trust boundary sits behind a load balancer.",
      "sections": [
        {
          "h": "The defaults are the policy",
          "p": [
            "rustls ships with a curated cipher suite list, TLS 1.3 plus TLS 1.2, no renegotiation, no compression, and no export ciphers. Hand-picking suites is how teams accidentally remove forward secrecy or add a CBC mode that a scanner flags. The right configuration is the default plus the minimum version you actually need, and a client that cannot speak it is a client you should not be serving.",
            "Choose the crypto provider deliberately. rustls 0.23 can use aws-lc-rs or ring; the choice affects build tooling and FIPS posture, and it must be consistent across every process that verifies a certificate. Install the provider once at startup so a missing provider is a boot failure rather than a panic on the first handshake."
          ],
          "list": [
            "TLS 1.3 and 1.2 only; disable anything older at the listener",
            "Do not hand-pick cipher suites; review the default list instead",
            "Install the crypto provider once, explicitly, at startup",
            "Keep the certificate chain in leaf-to-root order in the PEM file"
          ]
        },
        {
          "h": "Loading the chain and key",
          "p": [
            "The certificate file must contain the leaf first, then intermediates; the root is usually omitted because clients already have it. The key must be PKCS#8 or a type rustls recognizes, and the pair must match - a mismatch fails at load time, which is the good failure mode. Loading a chain with the wrong order produces a handshake that fails on some clients and works on others, which is the worst failure mode.",
            "Certificate renewal is a routine event, so the process must pick up a new certificate without a restart. Either reload the ServerConfig behind an ArcSwap and build a new acceptor, or use a resolver that reads from disk on a schedule. Restarting on renewal couples your availability to a timer you do not control."
          ],
          "code": "use rustls::ServerConfig;\nuse rustls_pemfile::{certs, private_key};\nuse std::fs::File;\nuse std::io::BufReader;\nuse std::sync::Arc;\n\npub fn tls_config(\n    cert_path: &str,\n    key_path: &str,\n) -> Result<Arc<ServerConfig>, Box<dyn std::error::Error>> {\n    // Install once per process; ignore the error if another caller won the race.\n    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();\n\n    let chain = certs(&mut BufReader::new(File::open(cert_path)?))\n        .collect::<Result<Vec<_>, _>>()?;\n    if chain.is_empty() {\n        return Err(\"empty certificate chain\".into());\n    }\n\n    let key = private_key(&mut BufReader::new(File::open(key_path)?))?\n        .ok_or(\"no private key in pem\")?;\n\n    let config = ServerConfig::builder()\n        .with_no_client_auth()\n        .with_single_cert(chain, key)?;\n\n    Ok(Arc::new(config))\n}\n\n// Serving with tokio-rustls:\n// let acceptor = tokio_rustls::TlsAcceptor::from(config);\n// let tls_stream = acceptor.accept(tcp_stream).await?;",
          "tip": "Validate at boot that the certificate's notAfter is in the future and that the chain matches the key; failing at 3 a.m. on renewal is a choice you can avoid."
        },
        {
          "h": "Behind a load balancer, know where TLS ends",
          "p": [
            "If a load balancer terminates TLS, your process sees plaintext HTTP and the security properties move to the balancer: cipher policy, certificate lifecycle, and HSTS. The application must still refuse to trust client-supplied X-Forwarded-Proto for anything security-relevant unless the request came from the balancer, or an attacker can convince you a plaintext request was secure.",
            "For service-to-service traffic inside a cluster, mTLS is the control that turns a network position into an authenticated identity. rustls supports it through with_client_verifier, and the same rule applies as everywhere: the verifier checks a real chain against a real root, never a callback that returns Ok."
          ],
          "code": "# Application-level HSTS belongs on the response, not in the TLS config.\nuse axum::http::{header, HeaderValue};\nuse tower_http::set_header::SetResponseHeaderLayer;\n\npub fn hsts() -> SetResponseHeaderLayer<HeaderValue> {\n    SetResponseHeaderLayer::overriding(\n        header::STRICT_TRANSPORT_SECURITY,\n        HeaderValue::from_static(\"max-age=63072000; includeSubDomains; preload\"),\n    )\n}\n\n// If you terminate TLS in-process, redirect :80 to :443 rather than serving\n// anything over plaintext. HSTS only protects visitors who saw it once.",
          "list": [
            "Trust X-Forwarded-* only from the proxy's address range",
            "Redirect plaintext to HTTPS; do not serve API traffic on port 80",
            "HSTS with a long max-age once you are sure every subdomain is HTTPS",
            "mTLS verifiers must validate a chain, never accept any certificate"
          ]
        },
        {
          "h": "What not to do, in order of frequency",
          "p": [
            "A custom certificate verifier that returns Ok is the most common production TLS bug in Rust services, usually added to make a staging environment work and never removed. The second is disabling hostname verification for an internal service. The third is pinning a leaf certificate and then forgetting, so renewal is an outage.",
            "If an internal service needs to trust a private CA, add the CA to the root store explicitly. That is a configuration change with a review, not a code change that turns verification off. Pin the CA or the intermediate, not the leaf, and keep an overlap window during rotation."
          ],
          "tip": "Grep for dangerous(), with_custom_certificate_verifier, and danger_accept_invalid_certs in CI; any hit outside a test module is a release blocker."
        }
      ],
      "exercise": {
        "prompt": "Write a function that builds a rustls ServerConfig from PEM files, rejects an empty chain, installs the crypto provider once, and returns a typed error. Then describe how you would swap the certificate at runtime without dropping connections.",
        "starter": "pub fn tls_config(cert: &str, key: &str) -> Result<std::sync::Arc<rustls::ServerConfig>, TlsError> {\n    todo!()\n}\n\n// Runtime reload: what do you swap, and what stays alive?",
        "hint": "certs() and private_key() from rustls-pemfile, ServerConfig::builder().with_no_client_auth().with_single_cert(...). For reload, build a new Arc<ServerConfig> and swap it in the acceptor; existing connections keep their negotiated session.",
        "solution": "use rustls::ServerConfig;\nuse rustls_pemfile::{certs, private_key};\nuse std::fs::File;\nuse std::io::BufReader;\nuse std::sync::Arc;\n\n#[derive(Debug)]\npub enum TlsError {\n    Io(std::io::Error),\n    Rustls(rustls::Error),\n    EmptyChain,\n    NoKey,\n}\n\nimpl From<std::io::Error> for TlsError {\n    fn from(e: std::io::Error) -> Self { TlsError::Io(e) }\n}\nimpl From<rustls::Error> for TlsError {\n    fn from(e: rustls::Error) -> Self { TlsError::Rustls(e) }\n}\n\npub fn tls_config(cert: &str, key: &str) -> Result<Arc<ServerConfig>, TlsError> {\n    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();\n\n    let chain = certs(&mut BufReader::new(File::open(cert)?))\n        .collect::<Result<Vec<_>, _>>()?;\n    if chain.is_empty() {\n        return Err(TlsError::EmptyChain);\n    }\n    let key = private_key(&mut BufReader::new(File::open(key)?))?.ok_or(TlsError::NoKey)?;\n\n    let config = ServerConfig::builder()\n        .with_no_client_auth()\n        .with_single_cert(chain, key)?;\n    Ok(Arc::new(config))\n}\n\n// Runtime reload, in outline:\n// 1. build the new Arc<ServerConfig> from the renewed PEM files\n// 2. store it in an ArcSwap<ServerConfig> read by the accept loop\n// 3. the next handshake uses the new config; established connections are untouched\n// 4. keep the old config alive until the last connection using it closes\n\npub struct TlsState {\n    pub config: arc_swap::ArcSwap<ServerConfig>,\n}\n\nimpl TlsState {\n    pub fn reload(&self, cert: &str, key: &str) -> Result<(), TlsError> {\n        let next = tls_config(cert, key)?;\n        self.config.store(next);\n        Ok(())\n    }\n}"
      },
      "questions": [
        {
          "q": "Why is hand-picking rustls cipher suites usually a mistake?",
          "options": [
            "It is not supported",
            "The default list is curated and current; manual lists tend to drop forward secrecy or reintroduce weak modes",
            "It makes compilation slower",
            "It disables TLS 1.3"
          ],
          "answer": 1,
          "explain": "Defaults track best practice and are reviewed by the library's security process. A hand-written list is a snapshot of someone's knowledge that stops being updated."
        },
        {
          "q": "A service sets a custom certificate verifier that always returns Ok to make staging work. What is the production risk?",
          "options": [
            "Slower handshakes",
            "Any attacker with a self-signed certificate can impersonate the upstream; TLS provides no authentication at all",
            "Larger certificates",
            "Nothing, the client still checks the hostname"
          ],
          "answer": 1,
          "explain": "Verification is the only thing that binds the certificate to the host. Turning it off keeps encryption but removes authentication, which is the half that stops impersonation."
        },
        {
          "q": "What is the correct way to trust an internal CA?",
          "options": [
            "Disable hostname verification for that host",
            "Add the private CA to the root store explicitly, with a reviewed configuration change",
            "Pin the leaf certificate",
            "Use plaintext on the internal network"
          ],
          "answer": 1,
          "explain": "Adding the CA keeps full verification, including hostname checks and chain validation. Pinning a leaf makes renewal an outage; disabling verification removes the control entirely."
        }
      ],
      "quickbytes": [
        "rustls defaults plus a minimum version is the whole policy; do not curate suites by hand.",
        "Leaf first, then intermediates, in the PEM chain; root usually omitted.",
        "Install the crypto provider once at startup so a missing provider fails at boot.",
        "Reload certificates by swapping an Arc<ServerConfig>, not by restarting the process."
      ],
      "production": [
        "TLS 1.2 is the floor and TLS 1.3 is enabled; older protocols are refused at the listener.",
        "The certificate chain order and key/cert match are validated at boot.",
        "Certificate renewal reloads configuration without a restart and is alerted before expiry.",
        "X-Forwarded-Proto and X-Forwarded-For are trusted only from known proxy addresses.",
        "CI greps for dangerous(), custom verifiers, and invalid-cert flags outside tests."
      ],
      "crates": [
        "rustls",
        "tokio-rustls",
        "rustls-pemfile",
        "tower-http"
      ],
      "github": [
        {
          "name": "rustls/rustls",
          "url": "https://github.com/rustls/rustls"
        },
        {
          "name": "rustls/pemfile",
          "url": "https://github.com/rustls/pemfile"
        }
      ],
      "pitfall": "Shipping a custom certificate verifier that returns Ok because staging used a self-signed certificate: production now encrypts traffic to anyone who asks, with no authentication of the peer at all.",
      "resources": [
        {
          "title": "The Era of TLS 1.3: Measuring Deployment and Use (arXiv 1907.12762)",
          "url": "https://arxiv.org/abs/1907.12762",
          "kind": "paper"
        },
        {
          "title": "rustls - TLS in Rust (RustNL talk)",
          "url": "https://www.youtube.com/watch?v=YvsGfGDGQMs",
          "kind": "video"
        },
        {
          "title": "rustls documentation",
          "url": "https://docs.rs/rustls/latest/rustls/",
          "kind": "docs"
        },
        {
          "title": "rustls-pemfile documentation",
          "url": "https://docs.rs/rustls-pemfile/latest/rustls_pemfile/",
          "kind": "docs"
        },
        {
          "title": "OWASP transport layer security cheat sheet",
          "url": "https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Transport_Layer_Security_Cheat_Sheet.md",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "h13",
      "n": 13,
      "title": "Input validation: parse into types, never sanitize",
      "minutes": 80,
      "level": "core",
      "goal": "Validate at the boundary by parsing into types that cannot hold invalid values, enforce size limits before parsing, and avoid the canonicalization traps that let a validated string become a different string downstream.",
      "sections": [
        {
          "h": "Parse, do not validate and then forget",
          "p": [
            "A validation function that returns a bool is a suggestion: nothing stops the next line from using the original string. Parsing returns a different type that can only be constructed from valid input, so every function downstream takes the proof instead of a promise. That is the difference between checking and enforcing.",
            "The pattern is a newtype with a fallible constructor. TenantSlug::parse is the only way to make one, its invariants are documented in one place, and a handler that accepts a String has to call it before it can reach the database. When the invariant changes, the compiler shows you every call site."
          ],
          "code": "#[derive(Debug, Clone, PartialEq, Eq)]\npub struct TenantSlug(String);\n\n#[derive(Debug, PartialEq, Eq)]\npub enum InvalidSlug { Empty, TooLong, BadChar }\n\nimpl TenantSlug {\n    pub fn parse(raw: &str) -> Result<Self, InvalidSlug> {\n        let trimmed = raw.trim();\n        if trimmed.is_empty() {\n            return Err(InvalidSlug::Empty);\n        }\n        if trimmed.len() > 63 {\n            return Err(InvalidSlug::TooLong);\n        }\n        let ok = trimmed\n            .bytes()\n            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');\n        if !ok || trimmed.starts_with('-') || trimmed.ends_with('-') {\n            return Err(InvalidSlug::BadChar);\n        }\n        Ok(Self(trimmed.to_owned()))\n    }\n\n    pub fn as_str(&self) -> &str {\n        &self.0\n    }\n}\n\n#[derive(serde::Deserialize)]\npub struct CreateTenant { pub slug: String }\n\n// The handler takes the parsed type, so an invalid slug cannot reach SQL.\npub async fn create_tenant(\n    State(db): State<sqlx::PgPool>,\n    Json(req): Json<CreateTenant>,\n) -> Result<StatusCode, StatusCode> {\n    let slug = TenantSlug::parse(&req.slug).map_err(|_| StatusCode::UNPROCESSABLE_ENTITY)?;\n    sqlx::query(\"INSERT INTO tenants (slug) VALUES ($1)\")\n        .bind(slug.as_str())\n        .execute(&db)\n        .await\n        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;\n    Ok(StatusCode::CREATED)\n}",
          "tip": "If a type can be constructed only through a fallible parse, every use is a validated use. That property is worth more than any number of regex checks."
        },
        {
          "h": "Limits belong before the parser",
          "p": [
            "A validator that runs after deserialization has already paid the cost of deserializing. Bound the body size in middleware, bound nesting depth in the deserializer, and reject oversized strings and arrays before they allocate. A 2 GB JSON body or a deeply nested array is a denial-of-service primitive that no amount of field validation prevents.",
            "serde_json has a recursion limit (128 by default) that turns deep nesting into an error rather than a stack overflow, but it does not bound total size or array length. Those are yours: a max body size on the route, and explicit per-field caps checked by the parsing constructor."
          ],
          "code": "use axum::{routing::post, Router};\nuse tower_http::limit::RequestBodyLimitLayer;\n\npub fn app(state: AppState) -> Router {\n    Router::new()\n        // 64 KiB is generous for JSON APIs and small enough to refuse bombs.\n        .route(\"/tenants\", post(create_tenant).layer(RequestBodyLimitLayer::new(64 * 1024)))\n        .with_state(state)\n}\n\n// Uploads are a separate route with a separate, larger limit and a streaming\n// body reader; never share one global limit that has to be large enough for files.",
          "list": [
            "Body limit per route, not one global number sized for the largest upload",
            "Cap string lengths and array counts in the parsing constructor",
            "Reject unknown content types instead of guessing",
            "Stream file uploads to disk or object storage; never buffer them in memory"
          ]
        },
        {
          "h": "Canonicalization: the same string twice",
          "p": [
            "Path traversal survives naive validation because the same bytes mean different things to different layers: .., %2e%2e, ..%2f, and a Unicode lookalike can all resolve to a parent directory after decoding. The safe design is to never accept a path at all - accept an opaque id and look the path up - and, when you must, decode once, normalize, then verify the result stays inside the root.",
            "The same class appears as double parsing: the frontend validates an email with one regex, the backend with another, and the database with a third, so each layer believes a different string is valid. One parser, one canonical form, and a type that carries it."
          ],
          "code": "use std::path::{Component, Path, PathBuf};\n\n/// Rejects anything that could escape the root after normalization.\npub fn safe_join(root: &Path, user_path: &str) -> Option<PathBuf> {\n    let candidate = Path::new(user_path);\n    if candidate.is_absolute() {\n        return None;\n    }\n    let mut out = root.to_path_buf();\n    for component in candidate.components() {\n        match component {\n            Component::Normal(part) => out.push(part),\n            // ParentDir, RootDir, Prefix: refuse rather than try to resolve.\n            _ => return None,\n        }\n    }\n    Some(out)\n}",
          "list": [
            "Prefer opaque ids over user-supplied paths",
            "Decode exactly once, then reject any component that is not Normal",
            "Store and compare a canonical form (lowercased domain, NFC-normalized name)",
            "Test with percent-encoded, double-encoded, and Unicode variants"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a validated Email newtype whose parser enforces length, a single @, a dot in the domain, and lowercases the result. Then write an axum handler that rejects invalid input with 422 and uses only the parsed value.",
        "starter": "#[derive(Debug, Clone, PartialEq, Eq)]\npub struct Email(String);\n\nimpl Email {\n    pub fn parse(raw: &str) -> Result<Self, InvalidEmail> { todo!() }\n    pub fn as_str(&self) -> &str { &self.0 }\n}",
        "hint": "Trim, reject empty or over 254 bytes, split_once('@'), require non-empty local and a domain containing a dot, reject whitespace, then lowercase the whole thing before storing.",
        "solution": "#[derive(Debug, Clone, PartialEq, Eq)]\npub struct Email(String);\n\n#[derive(Debug, PartialEq, Eq)]\npub enum InvalidEmail { Empty, TooLong, Shape, Whitespace }\n\nimpl Email {\n    pub fn parse(raw: &str) -> Result<Self, InvalidEmail> {\n        let trimmed = raw.trim();\n        if trimmed.is_empty() {\n            return Err(InvalidEmail::Empty);\n        }\n        if trimmed.len() > 254 {\n            return Err(InvalidEmail::TooLong);\n        }\n        if trimmed.chars().any(char::is_whitespace) {\n            return Err(InvalidEmail::Whitespace);\n        }\n        let (local, domain) = trimmed.split_once('@').ok_or(InvalidEmail::Shape)?;\n        if local.is_empty() || !domain.contains('.') || domain.starts_with('.') || domain.ends_with('.') {\n            return Err(InvalidEmail::Shape);\n        }\n        Ok(Self(trimmed.to_lowercase()))\n    }\n\n    pub fn as_str(&self) -> &str {\n        &self.0\n    }\n}\n\npub async fn subscribe(\n    axum::extract::State(db): axum::extract::State<sqlx::PgPool>,\n    axum::Json(req): axum::Json<Subscribe>,\n) -> Result<axum::http::StatusCode, axum::http::StatusCode> {\n    let email = Email::parse(&req.email).map_err(|_| axum::http::StatusCode::UNPROCESSABLE_ENTITY)?;\n    sqlx::query(\"INSERT INTO subscribers (email) VALUES ($1) ON CONFLICT DO NOTHING\")\n        .bind(email.as_str())\n        .execute(&db)\n        .await\n        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;\n    Ok(axum::http::StatusCode::ACCEPTED)\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn normalizes_case_and_rejects_junk() {\n        assert_eq!(Email::parse(\"  Ada@Example.COM \").unwrap().as_str(), \"ada@example.com\");\n        assert_eq!(Email::parse(\"no-at-sign\"), Err(InvalidEmail::Shape));\n        assert_eq!(Email::parse(\"a@b\"), Err(InvalidEmail::Shape));\n        assert_eq!(Email::parse(\"a b@c.com\"), Err(InvalidEmail::Whitespace));\n    }\n}"
      },
      "questions": [
        {
          "q": "Why is a parsing constructor stronger than a validate() that returns bool?",
          "options": [
            "It runs faster",
            "The only way to obtain the type is a successful parse, so downstream code cannot use unvalidated data",
            "It avoids allocations",
            "It produces better error messages"
          ],
          "answer": 1,
          "explain": "A bool can be ignored. A newtype that only exists after parsing makes the invalid state unrepresentable at the type level, which is what the compiler can enforce."
        },
        {
          "q": "Where should a request body size limit be enforced?",
          "options": [
            "Inside the handler after deserialization",
            "In middleware, before the body is read or deserialized",
            "In the database",
            "In the TLS layer"
          ],
          "answer": 1,
          "explain": "By the time a handler runs, the cost has been paid. A body limit layer rejects oversized requests before allocation, which is the only point where it prevents a denial of service."
        },
        {
          "q": "Why does path traversal survive naive checks?",
          "options": [
            "Rust paths cannot be validated",
            "The same bytes decode differently at different layers, so a checked string can normalize into a parent directory",
            "Filesystems ignore ..",
            "Only Windows is affected"
          ],
          "answer": 1,
          "explain": "Percent-encoding, double encoding, and separator variants mean the string you validated is not the path you open. Refusing non-Normal components after a single decode closes it."
        }
      ],
      "quickbytes": [
        "Parse into a newtype; never validate a String and keep using the String.",
        "Body limits per route in middleware, before deserialization.",
        "Refuse path components that are not Normal instead of resolving them.",
        "One parser, one canonical form; test percent-encoded and Unicode variants."
      ],
      "production": [
        "Every externally supplied identifier is parsed into a type with a fallible constructor.",
        "Body size limits are per route, with uploads on a separate streaming path.",
        "String, array, and nesting limits are explicit and covered by tests.",
        "User-supplied paths are rejected in favour of opaque ids, or normalized once and checked.",
        "Validation failures return 4xx with a stable error shape and no echo of the input."
      ],
      "crates": [
        "axum",
        "tower-http",
        "serde",
        "url"
      ],
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
      "pitfall": "Validating a filename with a check for the substring .. and then joining it to a root: a percent-encoded or double-encoded variant passes the check and resolves outside the directory.",
      "resources": [
        {
          "title": "OWASP input validation cheat sheet",
          "url": "https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Input_Validation_Cheat_Sheet.md",
          "kind": "docs"
        },
        {
          "title": "tower-http request body limit middleware",
          "url": "https://docs.rs/tower-http/latest/tower_http/limit/index.html",
          "kind": "docs"
        },
        {
          "title": "axum extractors: typed request contracts",
          "url": "https://docs.rs/axum/latest/axum/extract/index.html",
          "kind": "docs"
        },
        {
          "title": "url crate documentation",
          "url": "https://docs.rs/url/latest/url/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "h14",
      "n": 14,
      "title": "SSRF, CSRF and XSS in a Rust service",
      "minutes": 95,
      "level": "advanced",
      "goal": "Stop a user-supplied URL from reaching your metadata service, enable stateless CSRF protection that survives a proxy, and keep server-rendered admin pages free of injected script.",
      "sections": [
        {
          "h": "SSRF: a URL is an instruction to your network",
          "p": [
            "Any feature that fetches a URL supplied by a user - webhook testing, image import, PDF preview, link unfurling - is a request forgery primitive. The attacker is not trying to read the response; they are trying to make your server issue a request with your credentials and your network position. The classic target is the cloud metadata endpoint at 169.254.169.254, which hands out instance credentials to anything that can reach it.",
            "Blocking localhost by string comparison fails immediately: 127.0.0.1, [::1], 0.0.0.0, decimal and octal encodings, and a DNS name that resolves to an internal address all bypass it. The defensible pattern is an allowlist of hosts, then resolve, then check every resolved address, then connect to the address you checked so DNS cannot change its answer in between."
          ],
          "code": "use std::net::IpAddr;\n\nconst ALLOWED_HOSTS: &[&str] = &[\"images.example.com\", \"cdn.partner.example\"];\n\n#[derive(Debug)]\npub enum FetchError { BadUrl, BadScheme, HostNotAllowed, BlockedIp, Http }\n\nfn blocked(ip: IpAddr) -> bool {\n    match ip {\n        IpAddr::V4(v4) => {\n            v4.is_loopback() || v4.is_private() || v4.is_link_local()\n                || v4.is_unspecified() || v4.is_broadcast()\n        }\n        IpAddr::V6(v6) => v6.is_loopback() || v6.is_unspecified(),\n    }\n}\n\npub async fn safe_fetch(raw: &str) -> Result<String, FetchError> {\n    let url = url::Url::parse(raw).map_err(|_| FetchError::BadUrl)?;\n    if url.scheme() != \"https\" {\n        return Err(FetchError::BadScheme);\n    }\n    let host = url.host_str().ok_or(FetchError::BadUrl)?;\n    if !ALLOWED_HOSTS.contains(&host) {\n        return Err(FetchError::HostNotAllowed);\n    }\n\n    // Resolve once, check every answer, then pin the connection to a checked IP.\n    let addrs: Vec<IpAddr> = tokio::net::lookup_host((host, 443))\n        .await\n        .map_err(|_| FetchError::Http)?\n        .map(|s| s.ip())\n        .collect();\n    if addrs.is_empty() || addrs.iter().any(|ip| blocked(*ip)) {\n        return Err(FetchError::BlockedIp);\n    }\n\n    let client = reqwest::Client::builder()\n        .redirect(reqwest::redirect::Policy::none()) // a redirect can point inward\n        .timeout(std::time::Duration::from_secs(5))\n        .resolve(host, std::net::SocketAddr::new(addrs[0], 443)) // no second DNS lookup\n        .build()\n        .map_err(|_| FetchError::Http)?;\n\n    let body = client.get(url).send().await.map_err(|_| FetchError::Http)?;\n    body.text().await.map_err(|_| FetchError::Http)\n}",
          "tip": "Run outbound fetches through a dedicated egress proxy with its own allowlist. It is the only control that still holds when a new fetch call site forgets the checks."
        },
        {
          "h": "CSRF without token state",
          "p": [
            "CSRF works because a browser attaches cookies to cross-site requests. The modern defence does not need a per-request token: browsers now send Sec-Fetch-Site, and Origin is present on cross-origin POSTs, so a server can reject any state-changing request that is not same-origin. tower-http 0.7 ships this as the csrf feature, matching the scheme Go 1.25 added and Filippo Valsorda's write-up.",
            "The caveat is deployment: the middleware trusts the Origin and Host headers it receives. A reverse proxy that rewrites Host to an internal name, or strips Origin, silently degrades the check. Configure intermediaries to forward both unchanged, and keep SameSite=Lax on session cookies as the second layer."
          ],
          "code": "use tower_http::csrf::CsrfLayer;\n\npub fn csrf_layer() -> CsrfLayer {\n    CsrfLayer::new()\n        .add_trusted_origin(\"https://app.example.com\")\n        .expect(\"trusted origin is a valid URL\")\n        .add_trusted_origin(\"https://admin.example.com\")\n        .expect(\"trusted origin is a valid URL\")\n}\n\n// Router::new().route(\"/transfer\", post(transfer)).layer(csrf_layer())\n//\n// GET, HEAD and OPTIONS always pass. A cross-site POST gets 403, and the\n// rejection reason is attached to the response extensions for your logs.",
          "list": [
            "Reject state changes that are not same-origin; do not rely on the client",
            "Keep SameSite=Lax on session cookies as defence in depth",
            "Forward Origin and Host unchanged through every proxy",
            "Never expose a state-changing GET: prefetchers and scanners will trigger it"
          ]
        },
        {
          "h": "XSS: escape at render, constrain at delivery",
          "p": [
            "A JSON API is not an XSS target, but the admin console that renders user data is. The rule is boring and absolute: template engines that auto-escape by default, and no raw HTML injection point. askama escapes interpolated values in HTML templates; the moment you reach for a filter that marks a value safe, you own the escaping of that value forever.",
            "When users must supply rich HTML, sanitize with a real parser and an allowlist - ammonia does this - and never with regexes. Add a Content-Security-Policy with a per-response nonce for scripts, so an injection that does land cannot execute inline. CSP is a mitigation for the bug you have not found yet, not a substitute for escaping."
          ],
          "code": "use axum::http::{header, HeaderValue};\nuse tower_http::set_header::SetResponseHeaderLayer;\n\npub fn csp(nonce: &str) -> SetResponseHeaderLayer<HeaderValue> {\n    // The nonce must be fresh per response and must match the one in the tag.\n    let policy = format!(\n        \"default-src 'self'; script-src 'self' 'nonce-{nonce}'; object-src 'none'; \\\n         base-uri 'none'; frame-ancestors 'none'\"\n    );\n    SetResponseHeaderLayer::overriding(\n        header::CONTENT_SECURITY_POLICY,\n        HeaderValue::from_str(&policy).expect(\"policy is header-safe\"),\n    )\n}\n\n/// User-supplied rich text: allowlist, never regex. Returns HTML for the template.\npub fn sanitize_comment(html: &str) -> String {\n    ammonia::Builder::default()\n        .tags(std::collections::HashSet::from([\"p\", \"br\", \"em\", \"strong\", \"a\"]))\n        .link_rel(Some(\"noopener noreferrer nofollow\"))\n        .clean(html)\n        .to_string()\n}",
          "list": [
            "Auto-escaping templates; no safe/raw filter on user data",
            "Sanitize user HTML with ammonia and a tag allowlist",
            "CSP with a nonce for scripts, frame-ancestors none for clickjacking",
            "Set X-Content-Type-Options: nosniff on every response"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a safe_fetch function for a webhook-testing feature: https only, host allowlist, resolve-then-check every address against loopback/link-local/private ranges, no redirects, five-second timeout, and the checked IP pinned for the request.",
        "starter": "pub async fn safe_fetch(raw: &str) -> Result<String, FetchError> {\n    // 1. parse and check scheme\n    // 2. allowlist the host\n    // 3. resolve, check every IP, pin one\n    // 4. fetch with redirects disabled and a timeout\n    todo!()\n}",
        "hint": "reqwest::Client::builder().redirect(Policy::none()).timeout(...).resolve(host, ip) pins the address; check v4.is_loopback(), is_private(), is_link_local() and the v6 equivalents.",
        "solution": "use std::net::IpAddr;\n\nconst ALLOWED_HOSTS: &[&str] = &[\"images.example.com\"];\n\n#[derive(Debug)]\npub enum FetchError { BadUrl, BadScheme, HostNotAllowed, BlockedIp, Http }\n\nfn blocked(ip: IpAddr) -> bool {\n    match ip {\n        IpAddr::V4(v4) => {\n            v4.is_loopback() || v4.is_private() || v4.is_link_local()\n                || v4.is_unspecified() || v4.is_broadcast()\n        }\n        IpAddr::V6(v6) => v6.is_loopback() || v6.is_unspecified(),\n    }\n}\n\npub async fn safe_fetch(raw: &str) -> Result<String, FetchError> {\n    let url = url::Url::parse(raw).map_err(|_| FetchError::BadUrl)?;\n    if url.scheme() != \"https\" {\n        return Err(FetchError::BadScheme);\n    }\n    let host = url.host_str().ok_or(FetchError::BadUrl)?;\n    if !ALLOWED_HOSTS.contains(&host) {\n        return Err(FetchError::HostNotAllowed);\n    }\n\n    let addrs: Vec<IpAddr> = tokio::net::lookup_host((host, 443))\n        .await\n        .map_err(|_| FetchError::Http)?\n        .map(|s| s.ip())\n        .collect();\n    if addrs.is_empty() || addrs.iter().any(|ip| blocked(*ip)) {\n        return Err(FetchError::BlockedIp);\n    }\n\n    let client = reqwest::Client::builder()\n        .redirect(reqwest::redirect::Policy::none())\n        .timeout(std::time::Duration::from_secs(5))\n        .resolve(host, std::net::SocketAddr::new(addrs[0], 443))\n        .build()\n        .map_err(|_| FetchError::Http)?;\n\n    client\n        .get(url)\n        .send()\n        .await\n        .map_err(|_| FetchError::Http)?\n        .text()\n        .await\n        .map_err(|_| FetchError::Http)\n}"
      },
      "questions": [
        {
          "q": "Why does blocking the string localhost fail to stop SSRF?",
          "options": [
            "localhost is not a valid host",
            "The same destination is reachable as 127.0.0.1, [::1], 0.0.0.0, encoded forms, or a DNS name that resolves internally",
            "Rust resolves DNS lazily",
            "Only IPv6 is affected"
          ],
          "answer": 1,
          "explain": "String matching sees one spelling of a destination that has many. Resolving and checking the actual IP addresses is the only check that covers the space."
        },
        {
          "q": "What makes tower-http's CSRF layer work without a per-request token?",
          "options": [
            "It encrypts the request",
            "It uses Sec-Fetch-Site and Origin, which browsers attach and scripts cannot forge cross-origin",
            "It relies on cookies being HttpOnly",
            "It stores a token in the session"
          ],
          "answer": 1,
          "explain": "A cross-site page cannot set Origin or Sec-Fetch-Site for your origin, so rejecting non-same-origin state changes blocks the attack without server-side token state."
        },
        {
          "q": "A template marks a user-controlled value as safe HTML. What have you done?",
          "options": [
            "Improved performance",
            "Disabled auto-escaping for that value, so any script in it now runs in the page",
            "Enabled CSP",
            "Sanitized the value"
          ],
          "answer": 1,
          "explain": "The safe marker is a promise that the value is already escaped. On user data it is the XSS bug, unless a real sanitizer with an allowlist produced the HTML."
        }
      ],
      "quickbytes": [
        "Allowlist hosts, resolve, check every IP, then pin the checked IP and disable redirects.",
        "169.254.169.254 is the SSRF jackpot: block link-local and metadata routes at egress too.",
        "CsrfLayer + SameSite=Lax, and make sure proxies forward Origin and Host.",
        "Auto-escaping templates, ammonia for rich text, CSP with a nonce."
      ],
      "production": [
        "Outbound fetches go through an allowlist and an egress proxy with its own deny rules.",
        "Redirects are disabled and timeouts are short on every user-initiated fetch.",
        "CSRF protection is applied to all state-changing routes and proxies preserve Origin/Host.",
        "Server-rendered pages use auto-escaping templates and a CSP with a per-response nonce.",
        "Rich text is sanitized with ammonia and a tag/attribute allowlist, never with regexes."
      ],
      "crates": [
        "tower-http",
        "ammonia",
        "url",
        "reqwest"
      ],
      "github": [
        {
          "name": "tower-rs/tower-http",
          "url": "https://github.com/tower-rs/tower-http"
        },
        {
          "name": "rust-ammonia/ammonia",
          "url": "https://github.com/rust-ammonia/ammonia"
        }
      ],
      "pitfall": "Checking the hostname string and then following redirects: the allowlisted host returns a 302 to http://169.254.169.254/latest/meta-data/ and the client follows it with your instance credentials in scope.",
      "resources": [
        {
          "title": "Artemis: detecting server-side request forgery (arXiv 2502.21026)",
          "url": "https://arxiv.org/abs/2502.21026",
          "kind": "paper"
        },
        {
          "title": "Server-Side Request Forgery (SSRF) - complete guide, Rana Khalil",
          "url": "https://www.youtube.com/watch?v=ih5R_c16bKc",
          "kind": "video"
        },
        {
          "title": "tower-http CSRF middleware",
          "url": "https://docs.rs/tower-http/latest/tower_http/csrf/index.html",
          "kind": "docs"
        },
        {
          "title": "OWASP server-side request forgery prevention cheat sheet",
          "url": "https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.md",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "h15",
      "n": 15,
      "title": "Rate limiting: token buckets and the 429 contract",
      "minutes": 85,
      "level": "advanced",
      "goal": "Implement a token bucket with a defensible burst policy, key limits by the right identity, and return a 429 that clients can actually retry against.",
      "sections": [
        {
          "h": "Know what you are protecting",
          "p": [
            "A rate limit is not one number. Login is limited per account and per IP to slow credential stuffing; password reset is limited per account to stop mail bombs; search is limited per tenant because each query costs CPU; the public API is limited per key because that is what you sold. A single global request-per-second limit protects nothing specific and creates outages for everyone at once.",
            "Decide the failure mode first. For login you would rather reject the thousandth attempt than let an attacker test passwords at speed, so the limit is tight and the window short. For a dashboard export you would rather queue than reject, so the limit is a concurrency cap with backpressure, not a 429."
          ],
          "list": [
            "Key by identity plus route plus cost, not by IP alone",
            "Separate limits for auth, expensive reads, and writes",
            "Prefer backpressure or queueing for batch work, 429 for interactive abuse",
            "Log limit hits with the key and route so you can tune from data"
          ]
        },
        {
          "h": "Algorithms and how each one fails",
          "p": [
            "A fixed window counter is trivial and lets an attacker send two full windows' worth across a boundary. A sliding log is accurate and costs memory proportional to requests. A token bucket stores two numbers per key, allows a burst up to the bucket size, and refills at a steady rate - which is usually what you want, because real clients are bursty and attackers are not.",
            "GCRA is the same idea expressed as a theoretical arrival time, with one timestamp per key and no floating point drift. Whichever you choose, the two numbers that matter are the sustained rate and the allowed burst, and both belong in config with a comment explaining the client behaviour they are sized for."
          ],
          "code": "use std::collections::HashMap;\nuse std::sync::Mutex;\nuse std::time::{Duration, Instant};\n\nstruct Bucket { tokens: f64, last: Instant }\n\npub struct TokenBucket {\n    rate_per_sec: f64,\n    burst: f64,\n    buckets: Mutex<HashMap<String, Bucket>>,\n}\n\nimpl TokenBucket {\n    pub fn new(rate_per_sec: f64, burst: f64) -> Self {\n        Self { rate_per_sec, burst, buckets: Mutex::new(HashMap::new()) }\n    }\n\n    /// Ok(()) when allowed; Err(retry_after) when the caller must wait.\n    pub fn check(&self, key: &str) -> Result<(), Duration> {\n        let now = Instant::now();\n        let mut buckets = self.buckets.lock().expect(\"limiter mutex\");\n        let bucket = buckets\n            .entry(key.to_owned())\n            .or_insert(Bucket { tokens: self.burst, last: now });\n\n        let elapsed = now.duration_since(bucket.last).as_secs_f64();\n        bucket.tokens = (bucket.tokens + elapsed * self.rate_per_sec).min(self.burst);\n        bucket.last = now;\n\n        if bucket.tokens >= 1.0 {\n            bucket.tokens -= 1.0;\n            Ok(())\n        } else {\n            let wait = (1.0 - bucket.tokens) / self.rate_per_sec;\n            Err(Duration::from_secs_f64(wait))\n        }\n    }\n\n    /// Call periodically: without eviction the map is an unbounded allocation.\n    pub fn evict_idle(&self, older_than: Duration) {\n        let now = Instant::now();\n        let mut buckets = self.buckets.lock().expect(\"limiter mutex\");\n        buckets.retain(|_, b| now.duration_since(b.last) < older_than);\n    }\n}",
          "tip": "A per-process limiter multiplies by your replica count. Either divide the configured rate by replicas or move the counter to Redis with an atomic Lua script."
        },
        {
          "h": "Keying: the proxy problem",
          "p": [
            "Behind a load balancer every request appears to come from the balancer's address, so IP-keyed limits either throttle all users together or none. X-Forwarded-For is client-controlled unless a trusted proxy set it, so parsing it naively lets an attacker pick their own key and bypass every limit. Configure the trusted proxy range and read the header only when the immediate peer is in it.",
            "For authenticated routes, key by the user or tenant id from the verified session, not by IP: shared NAT is normal, and one abusive user should not consume the office's budget. For unauthenticated routes, key by IP plus a coarse route bucket, and accept that the identity is approximate."
          ],
          "code": "use std::net::IpAddr;\nuse axum::http::HeaderMap;\n\n/// Returns the client IP only when the peer is a trusted proxy.\npub fn client_ip(headers: &HeaderMap, peer: IpAddr, trusted: &[ipnet::IpNet]) -> IpAddr {\n    let from_trusted_proxy = trusted.iter().any(|net| net.contains(peer));\n    if !from_trusted_proxy {\n        return peer;\n    }\n    headers\n        .get(\"x-forwarded-for\")\n        .and_then(|v| v.to_str().ok())\n        .and_then(|v| v.split(',').next())\n        .and_then(|v| v.trim().parse().ok())\n        .unwrap_or(peer)\n}",
          "list": [
            "Trust X-Forwarded-For only from known proxy ranges",
            "Authenticated requests: key by user or tenant id",
            "Anonymous requests: key by client IP plus route",
            "Never let a client choose its own bucket key"
          ]
        },
        {
          "h": "The 429 contract",
          "p": [
            "A 429 without Retry-After forces clients into retry storms. Send Retry-After in seconds, send RateLimit-Limit, RateLimit-Remaining and RateLimit-Reset so well-behaved clients can self-pace, and document the limits in the API reference. The body should use the same error shape as every other 4xx.",
            "Do not make the limit itself a denial-of-service tool. Locking an account for an hour after five failed logins lets anyone lock anyone out; prefer exponential backoff with a cap, plus a notification to the account owner, plus a support path to unlock."
          ],
          "code": "use axum::http::{header, HeaderValue, StatusCode};\nuse axum::response::{IntoResponse, Response};\nuse std::time::Duration;\n\npub fn too_many_requests(retry_after: Duration, limit: u32) -> Response {\n    let secs = retry_after.as_secs().max(1);\n    let mut response = (StatusCode::TOO_MANY_REQUESTS, \"rate limit exceeded\").into_response();\n    let headers = response.headers_mut();\n    headers.insert(header::RETRY_AFTER, HeaderValue::from(secs));\n    headers.insert(\"ratelimit-limit\", HeaderValue::from(limit));\n    headers.insert(\"ratelimit-reset\", HeaderValue::from(secs));\n    response\n}",
          "tip": "Return the same 429 shape from the edge and the application; clients that special-case one and not the other will retry into the other and multiply load."
        }
      ],
      "exercise": {
        "prompt": "Implement a per-key token bucket limiter with a 10 req/s sustained rate and a burst of 20, plus an eviction method. Then write the response helper that emits 429 with Retry-After computed from the wait time.",
        "starter": "pub struct TokenBucket { /* rate, burst, map */ }\n\nimpl TokenBucket {\n    pub fn new(rate_per_sec: f64, burst: f64) -> Self { todo!() }\n    pub fn check(&self, key: &str) -> Result<(), std::time::Duration> { todo!() }\n    pub fn evict_idle(&self, older_than: std::time::Duration) { todo!() }\n}",
        "hint": "Refill by elapsed * rate capped at burst, subtract one token when available, otherwise compute (1.0 - tokens) / rate as the wait.",
        "solution": "use std::collections::HashMap;\nuse std::sync::Mutex;\nuse std::time::{Duration, Instant};\n\nstruct Bucket { tokens: f64, last: Instant }\n\npub struct TokenBucket {\n    rate_per_sec: f64,\n    burst: f64,\n    buckets: Mutex<HashMap<String, Bucket>>,\n}\n\nimpl TokenBucket {\n    pub fn new(rate_per_sec: f64, burst: f64) -> Self {\n        Self { rate_per_sec, burst, buckets: Mutex::new(HashMap::new()) }\n    }\n\n    pub fn check(&self, key: &str) -> Result<(), Duration> {\n        let now = Instant::now();\n        let mut buckets = self.buckets.lock().expect(\"limiter mutex\");\n        let bucket = buckets\n            .entry(key.to_owned())\n            .or_insert(Bucket { tokens: self.burst, last: now });\n\n        let elapsed = now.duration_since(bucket.last).as_secs_f64();\n        bucket.tokens = (bucket.tokens + elapsed * self.rate_per_sec).min(self.burst);\n        bucket.last = now;\n\n        if bucket.tokens >= 1.0 {\n            bucket.tokens -= 1.0;\n            Ok(())\n        } else {\n            Err(Duration::from_secs_f64((1.0 - bucket.tokens) / self.rate_per_sec))\n        }\n    }\n\n    pub fn evict_idle(&self, older_than: Duration) {\n        let now = Instant::now();\n        let mut buckets = self.buckets.lock().expect(\"limiter mutex\");\n        buckets.retain(|_, b| now.duration_since(b.last) < older_than);\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn burst_then_wait() {\n        let limiter = TokenBucket::new(10.0, 3.0);\n        for _ in 0..3 {\n            assert!(limiter.check(\"user-1\").is_ok());\n        }\n        let wait = limiter.check(\"user-1\").unwrap_err();\n        assert!(wait > Duration::ZERO && wait <= Duration::from_millis(100));\n        // A different key has its own bucket.\n        assert!(limiter.check(\"user-2\").is_ok());\n    }\n}"
      },
      "questions": [
        {
          "q": "What does a token bucket give you that a fixed-window counter does not?",
          "options": [
            "Less memory",
            "A bounded burst plus a steady sustained rate, without the boundary doubling of a fixed window",
            "Immunity to distributed attacks",
            "Exact accounting per request"
          ],
          "answer": 1,
          "explain": "The bucket's capacity is the allowed burst and its refill rate is the sustained rate. A fixed window lets a client send two windows' worth across the boundary."
        },
        {
          "q": "Why is keying by IP behind a load balancer dangerous without trusted-proxy handling?",
          "options": [
            "IPs change too often",
            "Every request appears to come from the balancer, so one bucket is shared by all users or the client can spoof X-Forwarded-For",
            "IPv6 is unsupported",
            "It breaks HTTP/2"
          ],
          "answer": 1,
          "explain": "The header is client-controlled unless a trusted proxy set it. Either you throttle everyone together or an attacker picks a fresh key per request and bypasses the limit."
        },
        {
          "q": "Why prefer exponential backoff over a long account lockout after failed logins?",
          "options": [
            "Backoff is easier to implement",
            "A hard lockout lets anyone lock any account out, turning the control into a denial-of-service tool",
            "Lockouts are illegal",
            "Backoff uses less CPU"
          ],
          "answer": 1,
          "explain": "Account lockout is attacker-triggerable. Backoff with a cap slows guessing without handing an attacker a way to deny access to a known user."
        }
      ],
      "quickbytes": [
        "Key by user or tenant for authenticated routes; IP only for anonymous traffic.",
        "Rate and burst in config, with a comment naming the client behaviour they are sized for.",
        "429 always carries Retry-After; add RateLimit-* headers for well-behaved clients.",
        "Evict idle buckets or the limiter becomes the memory leak that takes you down."
      ],
      "production": [
        "Limits are per route class: auth, expensive reads, writes, and public API keys.",
        "X-Forwarded-For is honoured only from configured proxy ranges.",
        "429 responses carry Retry-After and the same error shape as other 4xx.",
        "Limiter state is either sharded correctly across replicas or held in Redis.",
        "Limit hits are logged with key and route, and dashboards show rejection rate per class."
      ],
      "crates": [
        "axum",
        "governor",
        "ipnet",
        "tower-http"
      ],
      "github": [
        {
          "name": "boinkor-net/governor",
          "url": "https://github.com/boinkor-net/governor"
        },
        {
          "name": "krisprice/ipnet",
          "url": "https://github.com/krisprice/ipnet"
        }
      ],
      "pitfall": "A per-process limiter on a service running six replicas: the effective limit is six times what you configured, and it changes every time the autoscaler adds a pod.",
      "resources": [
        {
          "title": "Rate limiter system design: token bucket, leaky bucket, scaling - ByteByteGo",
          "url": "https://www.youtube.com/watch?v=YXkOdWBwqaA",
          "kind": "video"
        },
        {
          "title": "governor: GCRA rate limiting for Rust",
          "url": "https://docs.rs/governor/latest/governor/",
          "kind": "docs"
        },
        {
          "title": "ipnet: IP network types and containment checks",
          "url": "https://docs.rs/ipnet/latest/ipnet/",
          "kind": "docs"
        },
        {
          "title": "OWASP denial of service cheat sheet",
          "url": "https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Denial_of_Service_Cheat_Sheet.md",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "h16",
      "n": 16,
      "title": "Audit logging: tamper-evident and PII-free",
      "minutes": 90,
      "level": "advanced",
      "goal": "Emit audit events with a stable schema that answer who did what to which object, keep secrets and PII out of them, and make tampering detectable with a hash chain.",
      "sections": [
        {
          "h": "An audit event is a fact, not a log line",
          "p": [
            "Application logs are for debugging and can be sampled, rotated, and rewritten. Audit events are evidence: they answer who performed an action, on which object, when, from where, and whether it succeeded. That difference in purpose drives everything else - schema stability, retention, access control, and integrity.",
            "Use a dedicated sink and a dedicated schema. One JSON object per event with required fields, versioned like an API, written before the response is returned for security-relevant actions. If the audit write fails, the action should fail too, at least for privilege changes and data exports."
          ],
          "list": [
            "Required: event id, timestamp, actor, action, target, outcome, request id, source ip",
            "Write audit events in the same transaction as the change they describe, or immediately after",
            "Separate retention and access from application logs",
            "Never sample, never aggregate, never rewrite an audit event"
          ]
        },
        {
          "h": "What must never appear in the event",
          "p": [
            "An audit log is copied to a SIEM, exported to a data warehouse, and read by people with support access. Passwords, session ids, bearer tokens, full request bodies, and unnecessary PII must not be in it. Record identifiers and a hash or last-four where a human needs to correlate, and put the sensitive detail behind a second access-controlled store if it is needed at all.",
            "The subtle leak is the error path: a failed login audit that includes the attempted password, or a failed payment event that includes the card form. Build the event from an explicit struct with typed fields rather than serializing the request, so adding a field to a request cannot silently add it to the audit trail."
          ],
          "code": "use serde::Serialize;\n\n#[derive(Debug, Clone, Serialize)]\npub struct AuditEvent<'a> {\n    pub id: uuid::Uuid,\n    pub at_unix: i64,\n    pub actor_id: &'a str,\n    pub actor_kind: &'a str,      // user | service | operator\n    pub action: &'a str,          // document.read, user.role_change\n    pub target_kind: &'a str,\n    pub target_id: &'a str,\n    pub outcome: &'a str,         // allow | deny | error\n    pub request_id: &'a str,\n    pub source_ip: std::net::IpAddr,\n    pub prev_hash: String,\n    pub hash: String,\n}\n\nimpl AuditEvent<'_> {\n    /// Hash covers the previous hash and every field, so a deleted or edited\n    /// event breaks the chain at that point.\n    pub fn seal(&mut self) {\n        use ring::digest::{Context, SHA256};\n        let mut ctx = Context::new(&SHA256);\n        ctx.update(self.prev_hash.as_bytes());\n        ctx.update(self.id.as_bytes());\n        ctx.update(&self.at_unix.to_be_bytes());\n        ctx.update(self.actor_id.as_bytes());\n        ctx.update(self.action.as_bytes());\n        ctx.update(self.target_kind.as_bytes());\n        ctx.update(self.target_id.as_bytes());\n        ctx.update(self.outcome.as_bytes());\n        ctx.update(self.request_id.as_bytes());\n        ctx.update(self.source_ip.to_string().as_bytes());\n        self.hash = ctx\n            .finish()\n            .as_ref()\n            .iter()\n            .map(|b| format!(\"{b:02x}\"))\n            .collect();\n    }\n}",
          "tip": "Derive the event from explicit fields, never from the request struct. Serializing the request is how a password field ends up in the audit trail six months later."
        },
        {
          "h": "Hash chains and anchoring",
          "p": [
            "Each event carries the hash of the previous one, so deleting or editing an event breaks the chain and any later verification fails. The chain alone does not stop an attacker who can rewrite the whole table, so anchor it: write the latest hash to a separate system on a schedule - object storage with retention lock, a transparency log, or a second account - and verify continuity from that anchor.",
            "Verification has to be routine, not theoretical. A nightly job that recomputes the chain and alerts on the first mismatch turns tamper evidence into detection, which is the only thing that matters during an incident. Without that job the chain is a design document: it describes what tampering would look like, and nobody would notice it happening."
          ],
          "code": "pub fn verify_chain(events: &[AuditEvent<'_>]) -> Result<(), usize> {\n    let mut expected_prev = String::new();\n    for (index, event) in events.iter().enumerate() {\n        if event.prev_hash != expected_prev {\n            return Err(index);\n        }\n        let mut copy = event.clone();\n        copy.seal();\n        if copy.hash != event.hash {\n            return Err(index);\n        }\n        expected_prev = event.hash.clone();\n    }\n    Ok(())\n}\n\n// Run nightly against the last 24h plus the anchor; alert on the first\n// index where verification fails, and treat it as an incident, not a bug.",
          "list": [
            "Chain every event to its predecessor",
            "Anchor the head hash outside the database on a schedule",
            "Verify nightly and alert on the first mismatch",
            "Give the audit sink its own credentials and write-only access from the app"
          ]
        }
      ],
      "exercise": {
        "prompt": "Define an AuditEvent struct with the required fields, implement seal() so the hash covers prev_hash and all content, and write a verification function that returns the index of the first tampered event.",
        "starter": "#[derive(serde::Serialize)]\npub struct AuditEvent<'a> {\n    pub id: uuid::Uuid,\n    pub actor_id: &'a str,\n    pub action: &'a str,\n    pub target_id: &'a str,\n    pub outcome: &'a str,\n    pub prev_hash: String,\n    pub hash: String,\n}\n\nimpl AuditEvent<'_> {\n    pub fn seal(&mut self) { todo!() }\n}",
        "hint": "Feed prev_hash, then each field in a fixed order, into ring::digest::Context with SHA-256; hex-encode the digest into self.hash. Verify by recomputing and comparing prev links.",
        "solution": "use ring::digest::{Context, SHA256};\n\n#[derive(Debug, Clone, serde::Serialize)]\npub struct AuditEvent<'a> {\n    pub id: uuid::Uuid,\n    pub at_unix: i64,\n    pub actor_id: &'a str,\n    pub action: &'a str,\n    pub target_id: &'a str,\n    pub outcome: &'a str,\n    pub prev_hash: String,\n    pub hash: String,\n}\n\nimpl AuditEvent<'_> {\n    pub fn seal(&mut self) {\n        let mut ctx = Context::new(&SHA256);\n        ctx.update(self.prev_hash.as_bytes());\n        ctx.update(self.id.as_bytes());\n        ctx.update(&self.at_unix.to_be_bytes());\n        ctx.update(self.actor_id.as_bytes());\n        ctx.update(self.action.as_bytes());\n        ctx.update(self.target_id.as_bytes());\n        ctx.update(self.outcome.as_bytes());\n        self.hash = ctx.finish().as_ref().iter().map(|b| format!(\"{b:02x}\")).collect();\n    }\n}\n\nfn hex(bytes: &[u8]) -> String {\n    bytes.iter().map(|b| format!(\"{b:02x}\")).collect()\n}\n\n/// Returns the index of the first event whose chain or hash is broken.\npub fn verify_chain(events: &[AuditEvent<'_>]) -> Result<(), usize> {\n    let mut expected_prev = String::new();\n    for (index, event) in events.iter().enumerate() {\n        if event.prev_hash != expected_prev {\n            return Err(index);\n        }\n        let mut recomputed = AuditEvent {\n            id: event.id,\n            at_unix: event.at_unix,\n            actor_id: event.actor_id,\n            action: event.action,\n            target_id: event.target_id,\n            outcome: event.outcome,\n            prev_hash: event.prev_hash.clone(),\n            hash: String::new(),\n        };\n        recomputed.seal();\n        if recomputed.hash != event.hash {\n            return Err(index);\n        }\n        expected_prev = event.hash.clone();\n    }\n    Ok(())\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn editing_an_event_breaks_the_chain() {\n        let mut first = AuditEvent {\n            id: uuid::Uuid::nil(), at_unix: 1, actor_id: \"u1\", action: \"read\",\n            target_id: \"doc-1\", outcome: \"allow\", prev_hash: String::new(), hash: String::new(),\n        };\n        first.seal();\n        let mut second = AuditEvent {\n            id: uuid::Uuid::nil(), at_unix: 2, actor_id: \"u1\", action: \"write\",\n            target_id: \"doc-1\", outcome: \"allow\", prev_hash: first.hash.clone(), hash: String::new(),\n        };\n        second.seal();\n\n        let mut events = vec![first, second];\n        assert_eq!(verify_chain(&events), Ok(()));\n        events[0].action = \"nothing\";\n        assert_eq!(verify_chain(&events), Err(0));\n    }\n}"
      },
      "questions": [
        {
          "q": "What is the difference between an application log and an audit event?",
          "options": [
            "Audit events are shorter",
            "Audit events are evidence with a stable schema and retention; logs are for debugging and may be sampled",
            "Logs are encrypted, audit events are not",
            "There is no difference"
          ],
          "answer": 1,
          "explain": "The purpose drives the requirements: evidence needs completeness, integrity, and controlled access; debugging output needs volume and cheap search."
        },
        {
          "q": "What does a hash chain over audit events detect?",
          "options": [
            "Confidentiality breaches",
            "Deletion or modification of an event in the middle of the chain",
            "Slow queries",
            "Unauthorized users"
          ],
          "answer": 1,
          "explain": "Each event commits to its predecessor, so removing or editing one breaks every later hash. It does not prevent tampering, which is why the head hash is anchored externally."
        },
        {
          "q": "Why build the audit event from an explicit struct instead of serializing the request?",
          "options": [
            "It is faster",
            "A new field on the request would otherwise silently join the audit trail, including secrets",
            "serde cannot serialize requests",
            "It reduces storage"
          ],
          "answer": 1,
          "explain": "An allowlist of fields is the only way to keep the trail free of secrets and PII as the request type evolves."
        }
      ],
      "quickbytes": [
        "Audit: who, what, which object, when, from where, outcome, request id. Nothing else.",
        "Write the event in the same transaction as the change it describes.",
        "Hash chain plus an external anchor; verify nightly and alert on mismatch.",
        "Never serialize the request into the audit trail."
      ],
      "production": [
        "Audit events go to a dedicated sink with separate retention and write-only credentials.",
        "The event schema is versioned and reviewed; adding a field is a schema change.",
        "Secrets, tokens, passwords, and request bodies are structurally excluded from events.",
        "A nightly verification job recomputes the chain and alerts on the first mismatch.",
        "Access to the audit sink is itself audited, with a short list of humans who can read it."
      ],
      "crates": [
        "ring",
        "serde",
        "serde_json",
        "tracing"
      ],
      "github": [
        {
          "name": "briansmith/ring",
          "url": "https://github.com/briansmith/ring"
        },
        {
          "name": "tokio-rs/tracing",
          "url": "https://github.com/tokio-rs/tracing"
        }
      ],
      "pitfall": "Audit rows in the same table as application data, with the same credentials and no chain: an attacker with SQL access deletes the evidence of their own access and nothing detects it.",
      "resources": [
        {
          "title": "Rethinking tamper-evident logging (arXiv 2509.03821)",
          "url": "https://arxiv.org/abs/2509.03821",
          "kind": "paper"
        },
        {
          "title": "OWASP logging cheat sheet",
          "url": "https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Logging_Cheat_Sheet.md",
          "kind": "docs"
        },
        {
          "title": "tracing crate documentation",
          "url": "https://docs.rs/tracing/latest/tracing/",
          "kind": "docs"
        },
        {
          "title": "ring digest module",
          "url": "https://docs.rs/ring/latest/ring/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "h17",
      "n": 17,
      "title": "Supply chain: cargo-audit, deny, vet, SBOM",
      "minutes": 100,
      "level": "industry",
      "goal": "Treat dependencies as executable code: gate them with advisories, licence and ban policy, record who reviewed what, and ship an SBOM that maps a CVE back to a binary you deployed.",
      "sections": [
        {
          "h": "A dependency runs with your privileges",
          "p": [
            "A crate is not a library in the passive sense. Its build.rs executes on your build machine with your CI credentials, its proc macros execute inside the compiler, and its code runs in production with your service account. A typo-squatted name, a hijacked maintainer account, or a malicious patch release is remote code execution in your pipeline, not a theoretical supply-chain concern.",
            "The controls follow from that: pin with a committed Cargo.lock, review what a new dependency brings transitively, keep the build environment free of long-lived credentials, and make the dependency set a reviewed artifact rather than whatever resolves today. None of those controls is exotic; what fails in practice is applying them only at release time instead of on every pull request."
          ],
          "list": [
            "Commit Cargo.lock for binaries and services; review its diff like code",
            "Run build scripts in CI without cloud credentials; deploy in a separate job",
            "Prefer crates with a visible maintainer history and a security contact",
            "Vendor or mirror if you need builds to survive a registry outage or a yanked release"
          ]
        },
        {
          "h": "Three tools, three different questions",
          "p": [
            "cargo-audit asks is there a known advisory against anything in my lockfile; it reads the RustSec advisory database and fails on vulnerable versions. cargo-deny asks four policy questions - advisories, licences, bans, and registry sources - and is the tool that fits a CI gate because the policy lives in deny.toml next to the code. cargo-vet asks a different question entirely: who reviewed this crate, and what did they conclude.",
            "The combination matters. An advisory feed only knows what is published; vet records your own review of code nobody has filed an advisory against. Neither replaces reading the diff of a new dependency that has publish access to your build."
          ],
          "code": "# deny.toml - policy as code, checked on every PR.\n[graph]\ntargets = [\"x86_64-unknown-linux-gnu\", \"aarch64-unknown-linux-gnu\"]\nall-features = true\n\n[advisories]\nunmaintained = \"all\"\nunsound = \"all\"\nignore = []\n\n[bans]\nmultiple-versions = \"deny\"\nwildcards = \"deny\"\ndeny = [\n    { crate = \"openssl\", use-instead = \"rustls\" },\n    { crate = \"openssl-sys\", use-instead = \"rustls\" },\n]\n\n[sources]\nunknown-registry = \"deny\"\nunknown-git = \"deny\"\n\n[licenses]\nconfidence-threshold = 0.93\nallow = [\n    \"Apache-2.0\",\n    \"Apache-2.0 WITH LLVM-exception\",\n    \"BSD-3-Clause\",\n    \"MIT\",\n    \"ISC\",\n    \"Unicode-3.0\",\n    \"Zlib\",\n]\n\n# CI:\n#   cargo deny check\n#   cargo audit\n#   cargo tree -d          # why are there two versions of this crate?\n#   cargo cyclonedx --format json   # writes an SBOM file next to the manifest",
          "tip": "Start deny.toml with advisories and sources in deny mode and licences as warn; flipping every policy to deny on day one produces a backlog nobody triages."
        },
        {
          "h": "Provenance: from source to the artifact you deployed",
          "p": [
            "An SBOM answers which components are in this binary when a CVE lands. Provenance answers how the binary was built: which commit, which workflow, which builder. SLSA describes the levels, and sigstore/cosign is the usual tool for signing an image or an attestation so a deploy gate can verify it rather than trust it.",
            "The practical sequence is: build in a hermetic CI job with `--locked`, emit an SBOM and a build attestation, sign both, and verify the signature at deploy time against the identity of the workflow, not a long-lived key. That last part is what makes the signature meaningful - a key that any repo can use proves nothing about which repo built the artifact."
          ],
          "list": [
            "Emit an SBOM per release and keep it with the artifact, not in a wiki",
            "Sign images and attestations with workload identity, not a static key",
            "Verify the signer identity at deploy, not just the presence of a signature",
            "Record the commit and toolchain version in the attestation"
          ]
        },
        {
          "h": "Responding to an advisory",
          "p": [
            "An advisory is not an automatic emergency; it is a triage input. Ask three questions: is the vulnerable code path reachable from my code, is the vulnerable version actually in my dependency graph for the target I deploy, and is there a patched release. A vulnerable dev-dependency that only runs tests is different from a vulnerable TLS parser on the request path, and the difference should be written down.",
            "Keep the response boring: a documented SLA by severity, an owner, and a patch-and-release path you have practised. The teams that suffer are the ones discovering during an incident that nobody knows how to ship a dependency bump quickly. A bump that takes four days because the release process is manual is the real vulnerability, not the advisory itself."
          ],
          "tip": "Practise a dependency emergency on a quiet day: pick a crate, bump it, run the full pipeline, and time it. That number is your real response capability."
        }
      ],
      "exercise": {
        "prompt": "Write a deny.toml policy for a service that must use rustls, forbids duplicate major versions, allows only permissive licences, and refuses unknown registries. Then list the CI commands that enforce it and produce an SBOM.",
        "starter": "# deny.toml\n[advisories]\n# ...\n\n[bans]\n# ...\n\n[sources]\n# ...\n\n[licenses]\n# ...",
        "hint": "Use [advisories] with unmaintained/unsound set to all, [bans] with multiple-versions = deny and a deny entry for openssl using { crate = ..., use-instead = ... }, [sources] unknown-registry/unknown-git deny, and [licenses] allow list.",
        "solution": "[graph]\ntargets = [\"x86_64-unknown-linux-gnu\", \"aarch64-unknown-linux-gnu\"]\nall-features = true\n\n[advisories]\nunmaintained = \"all\"\nunsound = \"all\"\nignore = []\n\n[bans]\nmultiple-versions = \"deny\"\nwildcards = \"deny\"\ndeny = [\n    { crate = \"openssl\", use-instead = \"rustls\" },\n    { crate = \"openssl-sys\", use-instead = \"rustls\" },\n]\n\n[sources]\nunknown-registry = \"deny\"\nunknown-git = \"deny\"\n\n[licenses]\nconfidence-threshold = 0.93\nallow = [\n    \"Apache-2.0\",\n    \"Apache-2.0 WITH LLVM-exception\",\n    \"BSD-3-Clause\",\n    \"MIT\",\n    \"ISC\",\n    \"Unicode-3.0\",\n    \"Zlib\",\n]\n\n# CI, in this order:\n# 1. cargo deny check            -> policy gate, fails the PR\n# 2. cargo audit                 -> RustSec advisories against Cargo.lock\n# 3. cargo tree -d               -> inspect duplicate versions\n# 4. cargo cyclonedx --format json    -> an SBOM file next to each manifest\n# 5. cosign attest --predicate sbom.json --type cyclonedx <image>\n# 6. at deploy: cosign verify-attestation --type cyclonedx <image>"
      },
      "questions": [
        {
          "q": "Why is a build.rs in a dependency a security concern?",
          "options": [
            "It slows the build",
            "It executes arbitrary code on the build machine with the CI job's credentials",
            "It cannot be compiled on Windows",
            "It breaks incremental compilation"
          ],
          "answer": 1,
          "explain": "Build scripts run before your code exists. A malicious one can read environment variables, exfiltrate tokens, or patch the artifact - which is why builds should not hold long-lived cloud credentials."
        },
        {
          "q": "What question does cargo-vet answer that cargo-audit does not?",
          "options": [
            "Whether a licence is allowed",
            "Who reviewed a crate's code and what conclusion they recorded, independent of published advisories",
            "Whether the lockfile is current",
            "Which crates are outdated"
          ],
          "answer": 1,
          "explain": "Audit consumes advisories others filed. Vet records your organisation's own review of crates with no advisory, which is the only signal for code nobody has flagged."
        },
        {
          "q": "What makes a signed build attestation meaningful at deploy time?",
          "options": [
            "The signature exists",
            "Verifying that the signer identity is the specific workflow and repository allowed to produce that artifact",
            "The key is long-lived",
            "The attestation is in JSON"
          ],
          "answer": 1,
          "explain": "A signature only proves someone signed. Binding it to a workload identity - this repo, this workflow, this branch - is what stops a different pipeline from producing an accepted artifact."
        }
      ],
      "quickbytes": [
        "cargo deny check in CI, policy in deny.toml next to the code.",
        "cargo tree -d explains duplicate versions before you ban them.",
        "Build jobs hold no long-lived cloud credentials; deploy jobs assume a role via OIDC.",
        "Emit an SBOM per release and verify the signer identity at deploy."
      ],
      "production": [
        "Cargo.lock is committed and reviewed; dependency diffs are part of code review.",
        "cargo deny check and cargo audit run on every PR and block on failure.",
        "Builds run without cloud credentials; deployment uses short-lived federated identity.",
        "Every release ships an SBOM and a signed attestation tied to the workflow identity.",
        "An advisory response SLA exists per severity, with a rehearsed patch-and-release path."
      ],
      "crates": [
        "cargo-audit",
        "cargo-deny",
        "cargo-vet",
        "serde_json"
      ],
      "github": [
        {
          "name": "rustsec/rustsec",
          "url": "https://github.com/rustsec/rustsec"
        },
        {
          "name": "EmbarkStudios/cargo-deny",
          "url": "https://github.com/EmbarkStudios/cargo-deny"
        }
      ],
      "pitfall": "Treating a vulnerable dev-dependency as harmless: it still compiles, its build script still runs in CI with your credentials, and the advisory is still open against your lockfile.",
      "resources": [
        {
          "title": "Backstabber's Knife Collection: open source supply chain attacks (arXiv 2005.09535)",
          "url": "https://arxiv.org/abs/2005.09535",
          "kind": "paper"
        },
        {
          "title": "SLSA, Sigstore, SBOM: what does it all mean? - Abdel Sghiouar, NDC",
          "url": "https://www.youtube.com/watch?v=hF95PiItWtM",
          "kind": "video"
        },
        {
          "title": "cargo-deny repository and configuration reference",
          "url": "https://github.com/EmbarkStudios/cargo-deny",
          "kind": "repo"
        },
        {
          "title": "RustSec advisory database",
          "url": "https://github.com/rustsec/rustsec",
          "kind": "repo"
        },
        {
          "title": "OWASP software supply chain security cheat sheet",
          "url": "https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Software_Supply_Chain_Security_Cheat_Sheet.md",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "h18",
      "n": 18,
      "title": "Sandboxing untrusted work: seccomp and Wasm",
      "minutes": 95,
      "level": "industry",
      "goal": "Isolate code you do not trust by reducing what it can reach: capability-scoped file handles, a syscall allowlist, and a Wasm runtime with fuel and no ambient filesystem or network.",
      "sections": [
        {
          "h": "Isolation is a statement about reachability",
          "p": [
            "A sandbox is not a boolean. It is a claim about what the isolated code can reach: which files, which syscalls, which network destinations, how much CPU and memory, and for how long. Image decoders, PDF renderers, user plugins, and template engines from customers all belong behind such a claim, because they parse attacker-controlled input by definition.",
            "Rust removes memory-safety bugs inside the sandbox, which changes the threat model but does not remove it: a safe-Rust parser can still open any path the process can open, read the environment, and connect anywhere the network allows. The sandbox constrains capabilities, not memory errors."
          ],
          "list": [
            "Name the untrusted input and the component that parses it",
            "Decide which files, syscalls, and destinations that component legitimately needs",
            "Enforce the answer with a mechanism, not a code review convention",
            "Give the sandbox its own resource limits and a hard timeout"
          ]
        },
        {
          "h": "cap-std: drop ambient filesystem authority",
          "p": [
            "Ambient authority is the ability to open any path because the process happens to run as a user who can. cap-std replaces it with directory handles: you open one directory with explicit ambient authority at startup, and every subsequent operation is relative to a handle, so .. cannot climb out of it and an absolute path has no meaning.",
            "That converts a whole class of path-traversal bugs into type errors. The parser is handed a Dir for its scratch space and simply has no way to name /etc/passwd, because names are resolved against the handle rather than the process root."
          ],
          "code": "use cap_std::ambient_authority;\nuse cap_std::fs::Dir;\nuse std::io;\n\n/// The only ambient-authority call in the process, made once at startup.\npub fn open_scratch() -> io::Result<Dir> {\n    Dir::open_ambient_dir(\"/var/app/scratch\", ambient_authority())\n}\n\n/// Everything below is relative to the handle. No absolute paths, no escaping.\npub fn render(root: &Dir, job_id: &str, input: &[u8]) -> io::Result<Vec<u8>> {\n    root.create_dir_all(job_id)?;\n    let job = root.open_dir(job_id)?;\n    job.write(\"input.bin\", input)?;\n\n    // The parser only ever sees `job`, never the process filesystem.\n    let output = run_parser(&job)?;\n    job.write(\"output.bin\", &output)?;\n    Ok(output)\n}\n\nfn run_parser(_dir: &Dir) -> io::Result<Vec<u8>> {\n    // Invoke the parser in-process or as a child with the handle passed down.\n    Ok(Vec::new())\n}",
          "tip": "Keep the ambient-authority call in one function and review every change to it. If it appears in ten places, you have ambient authority with extra steps."
        },
        {
          "h": "seccomp: allowlist the syscalls, then test the real workload",
          "p": [
            "seccomp-bpf filters syscalls in the kernel, so a compromised parser cannot open a socket or exec a shell even if it gains control. The hard part is the allowlist: too tight and your parser fails on a legitimate mmap or futex; too loose and the filter is decoration. Generate the list from a traced run of the real workload, then remove what is clearly unnecessary.",
            "Start in log-only mode, run the full corpus of real inputs, and only then enforce. A seccomp filter that has never seen production input shapes will page you at 2 a.m. with SIGSYS, and the stack trace will be useless because the process is dead."
          ],
          "code": "# Trace the real workload, then build the filter from what it actually used.\nstrace -f -c -o /tmp/syscalls.txt ./image-worker --input corpus/\n\n# seccompiler compiles that JSON description into BPF; the resulting filter is\n# installed with seccompiler::apply_filter(&filter) before the parser starts.\n\n# filter.json (excerpt): allow the syscalls the traced run needed.\n# {\n#   \"main_thread\": {\n#     \"mismatch_action\": { \"errno\": -1 },\n#     \"match_action\": \"allow\",\n#     \"filter\": [\n#       { \"syscall\": \"read\" }, { \"syscall\": \"write\" },\n#       { \"syscall\": \"mmap\" }, { \"syscall\": \"munmap\" },\n#       { \"syscall\": \"futex\" }, { \"syscall\": \"exit_group\" }\n#     ]\n#   }\n# }",
          "list": [
            "Trace first, allowlist second, enforce third",
            "Default action is an error, never allow",
            "Run the filter under the real corpus in staging before production",
            "Pair the filter with no_new_privs and a non-root user; seccomp alone is not a jail"
          ]
        },
        {
          "h": "Wasm: a runtime with no ambient authority by default",
          "p": [
            "A WebAssembly runtime starts with nothing: no filesystem, no sockets, no clock, unless the host links a function that provides it. That default is the strongest property Wasm has for plugin systems. Wasmtime adds fuel metering and epoch interruption, so a plugin that loops forever is stopped by the host instead of pinning a core.",
            "The design rule is that every host function is a capability you grant. Pass a pre-opened directory only if the plugin must read files, expose an HTTP client only if it must call out, and bound memory at instantiation. A plugin API that hands over a generic fetch is an SSRF primitive with extra steps."
          ],
          "code": "use wasmtime::{Config, Engine, Store};\n\npub fn plugin_engine() -> Result<Engine, wasmtime::Error> {\n    let mut config = Config::new();\n    config.consume_fuel(true);          // deterministic CPU budget\n    config.epoch_interruption(true);    // wall-clock escape hatch for runaway code\n    config.wasm_threads(false);         // no shared-memory concurrency in plugins\n    Engine::new(&config)\n}\n\npub fn instantiate(engine: &Engine) -> Result<Store<()>, wasmtime::Error> {\n    let mut store = Store::new(engine, ());\n    store.set_fuel(50_000_000)?;        // ~tens of ms of work\n    store.set_epoch_deadline(1);        // one epoch tick, then trap\n    Ok(store)\n}\n\n// No WASI filesystem or socket is linked unless you add it explicitly.\n// Every host function you expose is a capability: keep the list short and audited.",
          "tip": "Set a memory limit at instantiation as well as fuel. A plugin that allocates until the host OOMs has bypassed your CPU budget entirely."
        }
      ],
      "exercise": {
        "prompt": "Write the sandbox boundary for an image-resizing worker: a cap-std Dir for its scratch space, a documented seccomp allowlist derived from a traced run, a hard timeout, and a note on which capabilities it must not have.",
        "starter": "use cap_std::fs::Dir;\n\npub struct Worker { pub scratch: Dir }\n\nimpl Worker {\n    pub fn open() -> std::io::Result<Self> { todo!() }\n    pub fn process(&self, job_id: &str, input: &[u8]) -> std::io::Result<Vec<u8>> { todo!() }\n}",
        "hint": "Dir::open_ambient_dir(path, ambient_authority()) once; then create_dir_all(job_id), open_dir(job_id), write input, run the decoder with only that Dir. Document: no network, no exec, no environment, 2 s timeout, non-root.",
        "solution": "use cap_std::ambient_authority;\nuse cap_std::fs::Dir;\nuse std::io;\nuse std::time::Duration;\n\npub struct Worker { pub scratch: Dir }\n\nimpl Worker {\n    pub fn open() -> io::Result<Self> {\n        // The single ambient-authority call: one directory, at startup.\n        Ok(Self { scratch: Dir::open_ambient_dir(\"/var/app/scratch\", ambient_authority())? })\n    }\n\n    pub fn process(&self, job_id: &str, input: &[u8]) -> io::Result<Vec<u8>> {\n        self.scratch.create_dir_all(job_id)?;\n        let job = self.scratch.open_dir(job_id)?;\n        job.write(\"input.bin\", input)?;\n\n        // The decoder receives only `job`. It cannot name /etc, a socket, or\n        // the environment. The caller enforces the wall-clock timeout.\n        let output = decode(&job)?;\n        job.write(\"output.bin\", &output)?;\n        Ok(output)\n    }\n}\n\nfn decode(dir: &Dir) -> io::Result<Vec<u8>> {\n    let input = dir.read(\"input.bin\")?;\n    Ok(input) // real implementation calls the decoder with `dir` as its only fs handle\n}\n\npub const TIMEOUT: Duration = Duration::from_secs(2);\n\n// Capabilities this worker must NOT have:\n// - network sockets (seccomp: EPERM on socket/connect)\n// - exec (no fork/execve in the allowlist)\n// - read access outside its scratch Dir\n// - root uid, or any capability beyond the minimum\n// - unlimited memory (cgroup limit + decoder allocation cap)"
      },
      "questions": [
        {
          "q": "What does cap-std's Dir handle actually prevent?",
          "options": [
            "Memory corruption in the parser",
            "Naming any path outside the opened directory, including via .. or absolute paths",
            "CPU exhaustion",
            "Network access"
          ],
          "answer": 1,
          "explain": "Paths are resolved against the handle, not the process root, so the parser has no way to name a file outside it. It says nothing about CPU, memory, or sockets."
        },
        {
          "q": "How should a seccomp allowlist be built?",
          "options": [
            "From a list of syscalls found on a blog",
            "By tracing the real workload, then tightening, and enforcing only after staging validation",
            "By allowing everything except execve",
            "By disabling seccomp in production"
          ],
          "answer": 1,
          "explain": "The allowlist has to match what the code actually needs. Tracing gives you that set; enforcing without a staging pass produces SIGSYS crashes on inputs you did not test."
        },
        {
          "q": "Why is a Wasm plugin safer by default than a dynamically loaded native library?",
          "options": [
            "Wasm code is faster",
            "The runtime provides no filesystem, network, or clock unless the host explicitly links those functions",
            "Wasm cannot loop forever",
            "Wasm is memory-safe, native code is not"
          ],
          "answer": 1,
          "explain": "Default deny on capabilities is the property. Native code inherits the process's authority; a Wasm module starts with none and gains only what the host grants."
        }
      ],
      "quickbytes": [
        "Name the untrusted parser, then deny it files, sockets, exec, and time.",
        "cap-std: one ambient-authority call, then everything relative to a Dir.",
        "seccomp: trace, allowlist, default-deny, validate in staging before enforcing.",
        "Wasm: fuel, epoch deadline, memory cap, and no host functions you did not choose."
      ],
      "production": [
        "Every parser of untrusted input runs with a documented capability set and a hard timeout.",
        "File access goes through directory handles; no component resolves user-supplied absolute paths.",
        "seccomp filters are generated from traced workloads and validated in staging before enforcement.",
        "Wasm plugins run with fuel, an epoch deadline, a memory cap, and an audited host-function list.",
        "Sandbox escapes are treated as critical vulnerabilities with a rollback plan per plugin version."
      ],
      "crates": [
        "cap-std",
        "seccompiler",
        "wasmtime",
        "tokio"
      ],
      "github": [
        {
          "name": "sunfishcode/cap-std",
          "url": "https://github.com/sunfishcode/cap-std"
        },
        {
          "name": "bytecodealliance/wasmtime",
          "url": "https://github.com/bytecodealliance/wasmtime"
        }
      ],
      "pitfall": "A seccomp allowlist copied from a blog and enforced immediately: the first production input takes a code path that needs a syscall you did not allow, the process dies with SIGSYS, and the stack trace tells you nothing.",
      "resources": [
        {
          "title": "Playing in the Sandbox: a study on the usability of seccomp (arXiv 2506.10234)",
          "url": "https://arxiv.org/abs/2506.10234",
          "kind": "paper"
        },
        {
          "title": "Syscall Me by Your Name: sandboxing Wasm programs - Ryan Petrich, CNCF",
          "url": "https://www.youtube.com/watch?v=Uemp_cASATc",
          "kind": "video"
        },
        {
          "title": "cap-std: capability-based filesystem API",
          "url": "https://docs.rs/cap-std/latest/cap_std/",
          "kind": "docs"
        },
        {
          "title": "seccompiler: compile seccomp filters for Rust",
          "url": "https://docs.rs/seccompiler/latest/seccompiler/",
          "kind": "docs"
        },
        {
          "title": "wasmtime crate documentation",
          "url": "https://docs.rs/wasmtime/latest/wasmtime/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "h19",
      "n": 19,
      "title": "Secrets in CI: OIDC and short-lived credentials",
      "minutes": 85,
      "level": "industry",
      "goal": "Remove long-lived cloud keys from CI by federating identity with OIDC, keep secrets out of logs and fork PRs, and make an exposure detectable and rotatable within minutes.",
      "sections": [
        {
          "h": "The static cloud key is the thing to delete",
          "p": [
            "A cloud access key stored as a CI secret is a permanent credential sitting in a system that runs arbitrary code from pull requests. It has no expiry, often no meaningful scope, and it is the single most valuable thing an attacker can take from a build system. OIDC federation replaces it: the CI provider mints a short-lived signed token describing the repository, branch, and workflow, and the cloud assumes a role only if that subject matches the trust policy.",
            "The trust policy is the security boundary, so scope it hard. A subject condition of repo:org/repo:ref:refs/heads/main is a different object from repo:org/repo:*, which lets any branch - including a pull request branch - assume the production role. Review that policy the way you review an IAM grant, because it is one, and it is the grant that decides whether a compromised branch becomes a compromised account."
          ],
          "code": "name: deploy\non:\n  push:\n    branches: [main]\n\npermissions:\n  id-token: write   # mint the OIDC token\n  contents: read\n\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    environment: production   # requires reviewers, separate secrets\n    steps:\n      - uses: actions/checkout@v4\n\n      - uses: aws-actions/configure-aws-credentials@v4\n        with:\n          role-to-assume: arn:aws:iam::123456789012:role/gha-deploy-prod\n          role-session-name: deploy\n          aws-region: eu-west-1\n\n      - run: cargo build --release --locked\n      - run: ./target/release/auth-service --migrate-only\n\n# The IAM role's trust policy pins the subject, not just the account:\n#   \"token.actions.githubusercontent.com:sub\": \"repo:acme/auth:ref:refs/heads/main\"\n#   \"token.actions.githubusercontent.com:aud\": \"sts.amazonaws.com\"",
          "list": [
            "id-token: write only on the job that needs to assume a role",
            "Trust policy pins repo, ref, and audience - never a wildcard subject",
            "Production deploys behind an environment with required reviewers",
            "Build jobs get no cloud credentials; deploy jobs assume a role for minutes"
          ]
        },
        {
          "h": "Masking is not secrecy",
          "p": [
            "CI masking replaces a known secret with *** in logs, but it cannot catch a secret that was transformed: base64-encoded, split, printed by a failing program, or included in an uploaded artifact. A debug step that runs env or set -x in a shell is enough to write the value into a log that many people can read.",
            "Treat the log as public within your organisation. Never echo a secret to debug it, never pass secrets to a step that runs untrusted code, and never let a pull request from a fork execute in a context that has secrets. The pull_request_target event is the classic footgun: it runs with the base repository's secrets and, if it checks out the fork's code, hands them to the attacker."
          ],
          "code": "# BAD: a pull_request_target workflow that checks out and runs fork code.\non: pull_request_target\njobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}   # untrusted code\n      - run: cargo test   # with repository secrets in the environment\n\n# GOOD: a separate workflow file with no secrets in the untrusted job.\n# A second, privileged workflow comments the result back afterwards.\non: pull_request\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: cargo test --locked",
          "list": [
            "Never echo, base64, or cat a secret, even in a failing step",
            "No secrets in jobs that execute fork code",
            "Disable shell tracing around steps that handle credentials",
            "Upload artifacts only from steps that never saw a secret"
          ]
        },
        {
          "h": "Detection, rotation, and the blast radius",
          "p": [
            "Assume a secret will leak and make the leak cheap. Enable secret scanning with push protection so a committed token is blocked before it lands, scan history for what already landed, and give every credential an owner and a rotation procedure that one person can execute under pressure.",
            "Short-lived credentials collapse the blast radius: a token that expires in fifteen minutes is not worth exfiltrating. For the credentials that must be long-lived - a package registry token, a signing key - prefer workload identity or trusted publishing from the registry itself, so there is no static value in CI at all."
          ],
          "tip": "Run a quarterly drill: revoke the CI deploy role's trust policy and confirm the pipeline fails closed, then restore it. A trust policy nobody has tested is a guess."
        }
      ],
      "exercise": {
        "prompt": "Rewrite a deploy workflow to remove a static AWS key: use OIDC with id-token: write, scope the role assumption to a protected environment, and state the exact trust-policy subject condition you would require. Then list two ways a secret could still leak from this workflow.",
        "starter": "name: deploy\non: push\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: aws s3 sync ./dist s3://bucket\n        env:\n          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_KEY }}\n          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET }}",
        "hint": "permissions: id-token: write, an environment with reviewers, configure-aws-credentials with role-to-assume, and a trust policy subject of repo:org/repo:ref:refs/heads/main. Leaks: a later step that echoes the environment, or an artifact built from a step that held credentials.",
        "solution": "name: deploy\non:\n  push:\n    branches: [main]\n\npermissions:\n  id-token: write\n  contents: read\n\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    environment: production\n    steps:\n      - uses: actions/checkout@v4\n\n      - uses: aws-actions/configure-aws-credentials@v4\n        with:\n          role-to-assume: arn:aws:iam::123456789012:role/gha-deploy-prod\n          role-session-name: deploy\n          aws-region: eu-west-1\n\n      - run: cargo build --release --locked\n      - run: aws s3 sync ./dist s3://bucket --delete\n\n# Trust policy subject (exact, no wildcards):\n#   repo:acme/auth:ref:refs/heads/main\n#\n# Two ways this can still leak:\n# 1. A later step runs `env`, `set -x`, or a tool that prints AWS_* variables;\n#    the assumed-role credentials are short-lived but valid for up to an hour.\n# 2. An artifact produced by a step that held credentials is uploaded and\n#    later downloaded by an untrusted job, carrying any secret it captured.\n#\n# Mitigations: no shell tracing around credentialed steps, upload artifacts\n# only from credential-free steps, and keep the role session duration short."
      },
      "questions": [
        {
          "q": "What does OIDC federation remove from CI?",
          "options": [
            "The need for a build step",
            "The long-lived cloud access key, replacing it with a short-lived token scoped by repository and ref",
            "The need for tests",
            "The need for a lockfile"
          ],
          "answer": 1,
          "explain": "The CI provider asserts an identity and the cloud exchanges it for temporary credentials. There is no static key to steal, and the trust policy bounds which workflow can use it."
        },
        {
          "q": "Why is pull_request_target dangerous when it checks out fork code?",
          "options": [
            "It is slower",
            "It runs in the base repository's context with secrets available, so the fork's code can read and exfiltrate them",
            "It cannot access the network",
            "It breaks caching"
          ],
          "answer": 1,
          "explain": "The event exists to let maintainers act on PRs with write access, which means the job holds secrets. Checking out and executing the fork's code in that job hands those secrets to the contributor."
        },
        {
          "q": "What is the strongest trust-policy subject for a production deploy role?",
          "options": [
            "repo:acme/*",
            "repo:acme/auth:*",
            "repo:acme/auth:ref:refs/heads/main",
            "Any subject from the acme organisation"
          ],
          "answer": 2,
          "explain": "Pinning the repository and the exact ref means only a push to main can assume the role. A wildcard ref lets any branch or PR workflow do it."
        }
      ],
      "quickbytes": [
        "Delete static cloud keys; use id-token: write plus a role whose trust policy pins repo and ref.",
        "Production deploys behind an environment with required reviewers.",
        "No secrets in any job that runs fork code; pull_request_target is a trap.",
        "Masking does not survive base64, splitting, or set -x: never print a secret."
      ],
      "production": [
        "No long-lived cloud credentials exist in CI; all cloud access uses federated short-lived roles.",
        "Trust policies pin repository, ref, and audience, with no wildcard subjects.",
        "Secret scanning with push protection is enabled, and history has been scanned.",
        "Every CI secret has an owner, a rotation runbook, and a maximum lifetime.",
        "A revocation drill confirms the pipeline fails closed when credentials are withdrawn."
      ],
      "crates": [
        "serde_json",
        "tracing",
        "axum"
      ],
      "github": [
        {
          "name": "sigstore/cosign",
          "url": "https://github.com/sigstore/cosign"
        },
        {
          "name": "slsa-framework/slsa",
          "url": "https://github.com/slsa-framework/slsa"
        }
      ],
      "pitfall": "A pull_request_target workflow that checks out the contributor's branch and runs cargo test: the fork's build script reads the repository secrets from the environment and posts them to an external host.",
      "resources": [
        {
          "title": "OWASP CI/CD security cheat sheet",
          "url": "https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/CI_CD_Security_Cheat_Sheet.md",
          "kind": "docs"
        },
        {
          "title": "SLSA framework specification",
          "url": "https://github.com/slsa-framework/slsa",
          "kind": "repo"
        },
        {
          "title": "OWASP secrets management cheat sheet",
          "url": "https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Secrets_Management_Cheat_Sheet.md",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "h20",
      "n": 20,
      "title": "Incident response: containment to postmortem",
      "minutes": 110,
      "level": "industry",
      "goal": "Run the first hour of a credential compromise: assign roles, preserve evidence before remediation, revoke sessions and rotate keys with overlap, and turn the timeline into postmortem actions with owners.",
      "sections": [
        {
          "h": "The first ten minutes decide the rest",
          "p": [
            "Declare an incident and name three roles before touching anything: an incident commander who decides, a communications lead who talks to customers and executives, and a scribe who records times and decisions. One person doing all three loses the timeline, and the timeline is what regulators, customers, and the postmortem will need.",
            "Then preserve evidence. Deleting the compromised host or rotating every credential immediately destroys the logs that explain what happened. Snapshot, copy the audit chain and access logs to a separate account, and only then begin remediation. The order is evidence, containment, eradication, recovery - not the other way round."
          ],
          "list": [
            "Assign IC, comms, and scribe explicitly, in writing",
            "Snapshot logs and audit chain to an isolated account before changing anything",
            "Write timestamps as you go; memory reconstructs incidents badly",
            "Decide severity and notification obligations early, not after the fix"
          ]
        },
        {
          "h": "Containment for an auth service",
          "p": [
            "For a credential compromise the containment sequence is specific: revoke all sessions, rotate the signing keys with an overlap window so legitimate clients can refresh, rotate every secret the compromised host could read, and force re-authentication. If the attacker had database access, assume they read the password hashes and force a reset for every account, not just the ones you noticed.",
            "Order matters. Rotating the signing key before you can verify tokens means you cannot tell legitimate traffic from attacker traffic. Revoking sessions before you have the audit trail means you cannot tell which sessions were attacker sessions. Write the sequence into a runbook and test it, because under pressure nobody invents a correct sequence."
          ],
          "code": "use sqlx::PgPool;\nuse uuid::Uuid;\n\n/// Revoke every session for a user and record the action in the audit chain.\npub async fn revoke_user_sessions(\n    db: &PgPool,\n    user_id: Uuid,\n    actor: &str,\n    reason: &str,\n) -> Result<u64, sqlx::Error> {\n    let mut tx = db.begin().await?;\n\n    let affected = sqlx::query(\"DELETE FROM sessions WHERE user_id = $1\")\n        .bind(user_id)\n        .execute(&mut *tx)\n        .await?\n        .rows_affected();\n\n    // Bump a per-user epoch: any token carrying an older epoch is rejected,\n    // even if its signature is still valid.\n    sqlx::query(\"UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1\")\n        .bind(user_id)\n        .execute(&mut *tx)\n        .await?;\n\n    sqlx::query(\n        \"INSERT INTO audit_events (id, at, actor_id, action, target_id, outcome, detail)\\n         VALUES (gen_random_uuid(), now(), $1, 'session.revoke_all', $2, 'allow', $3)\",\n    )\n    .bind(actor)\n    .bind(user_id.to_string())\n    .bind(reason)\n    .execute(&mut *tx)\n    .await?;\n\n    tx.commit().await?;\n    Ok(affected)\n}\n\n/// Global kill switch for a dangerous code path (export, impersonation, invites).\npub struct KillSwitch(std::sync::atomic::AtomicBool);\n\nimpl KillSwitch {\n    pub fn engage(&self) { self.0.store(true, std::sync::atomic::Ordering::SeqCst); }\n    pub fn disengage(&self) { self.0.store(false, std::sync::atomic::Ordering::SeqCst); }\n    pub fn is_engaged(&self) -> bool { self.0.load(std::sync::atomic::Ordering::SeqCst) }\n}",
          "tip": "A per-user session epoch is cheaper than a jti denylist and revokes every outstanding token at once, including ones you never saw."
        },
        {
          "h": "Communication and the postmortem",
          "p": [
            "Regulators and customers need facts and times, not speculation. Say what you know, what you have contained, what you do not know yet, and when the next update will be. A single owned status page beats a dozen contradictory emails, and an update you promised but missed is worse than a slower cadence.",
            "The postmortem is blameless about people and ruthless about systems. Reconstruct the timeline from audit events and logs, identify the control that failed and the detection that was late, and produce a small number of actions with owners and dates. An incident that produces twenty action items produces zero; three that ship are worth more."
          ],
          "code": "# Postmortem skeleton that gets filled, not admired.\n## Summary        one paragraph a customer could read\n## Impact         who, how many, for how long, what data\n## Timeline       UTC timestamps from audit events and logs\n## Detection      what alerted, how long after the first action\n## Root cause     the control that failed, not the person\n## What worked   controls that limited blast radius\n## Actions        3 max, each with owner and date\n## Detection gap  what would have caught this in minutes",
          "list": [
            "Timeline in UTC from evidence, not memory",
            "Root cause names the missing or bypassed control",
            "Three actions maximum, each owned and dated",
            "Detection gap named explicitly, with the alert you will add"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write the containment runbook for a leaked service account that had database access: ordered steps with the evidence preserved first, session revocation, key rotation with overlap, forced password reset, and the audit event emitted for each action.",
        "starter": "# Containment runbook\n1. ...\n\n## Evidence\n## Revocation\n## Rotation\n## Verification",
        "hint": "Order: snapshot logs and audit chain, declare scope, revoke sessions (epoch bump), rotate signing keys with JWKS overlap, rotate DB credentials, force resets, then verify with the audit chain and monitor for re-entry.",
        "solution": "# Containment runbook: leaked service account with database access\n\n## 0. Declare\n- IC, comms, scribe named in the incident channel; severity set.\n- Start a timeline doc; every action gets a UTC timestamp and an actor.\n\n## 1. Preserve evidence (before remediation)\n- Snapshot the database, application logs, and the audit chain to an isolated account.\n- Export the audit chain head hash and store it with the snapshot.\n- Record the compromised account's recent queries and connections.\n\n## 2. Scope\n- List every secret the account could read: DB password, signing keys, API tokens.\n- List every host and job that used it; assume all are compromised.\n\n## 3. Revoke\n- Bump session_epoch for all users; delete sessions for affected accounts.\n- Disable the service account and its tokens at the identity provider.\n- Emit audit events: session.revoke_all, service_account.disable.\n\n## 4. Rotate (with overlap, in this order)\n- New DB credentials; deploy; then revoke the old ones.\n- New signing key: publish in JWKS, start signing, keep the old key published\n  for one token lifetime plus clock skew, then remove it.\n- New API tokens for every consumer of the compromised account.\n\n## 5. Force reset\n- Reset passwords for accounts whose hashes were reachable; invalidate all sessions.\n- Notify account owners out of band; do not rely on email to a possibly compromised inbox.\n\n## 6. Verify and watch\n- Verify the audit chain from the anchor; alert on any gap.\n- Watch for re-entry: new sessions, new tokens, unusual query shapes for 72 hours.\n- Only then close containment and move to eradication and recovery.\n\n## 7. Postmortem\n- Timeline from the preserved evidence; three actions with owners and dates."
      },
      "questions": [
        {
          "q": "Why preserve logs before rotating credentials?",
          "options": [
            "Logs are cheaper to store than credentials",
            "Rotation and cleanup destroy the evidence that explains what happened and what was accessed",
            "Logs are required by law before any change",
            "Rotation makes logs unreadable"
          ],
          "answer": 1,
          "explain": "Snapshots and log copies are the timeline. If remediation removes the host or rotates away the audit trail before capture, the postmortem and any notification become guesswork."
        },
        {
          "q": "What does bumping a per-user session epoch achieve?",
          "options": [
            "It shortens the password",
            "It invalidates every token issued before the bump, even validly signed ones, without maintaining a denylist",
            "It rotates the signing key",
            "It resets the password"
          ],
          "answer": 1,
          "explain": "Tokens carry the epoch they were minted under. A bump makes all older tokens fail the check, which is an immediate, complete revocation for that user."
        },
        {
          "q": "Why rotate the signing key with an overlap rather than swapping it?",
          "options": [
            "Overlap is faster",
            "Clients need to refresh tokens against a published key set; an instant swap invalidates every live session at once",
            "Overlap is required by OIDC",
            "It avoids changing the JWKS URL"
          ],
          "answer": 1,
          "explain": "Verifiers cache the key set. Publishing the new key first and retiring the old one after a token lifetime keeps legitimate users working while the compromised key stops being trusted."
        }
      ],
      "quickbytes": [
        "Evidence, containment, eradication, recovery - in that order, with timestamps.",
        "Sessions first via an epoch bump, then keys with JWKS overlap, then credentials.",
        "Assume every secret the compromised host could read is compromised.",
        "Three postmortem actions with owners and dates beat twenty good intentions."
      ],
      "production": [
        "A written runbook exists for credential compromise, tested at least annually.",
        "Audit logs and chain anchors are copied to an isolated account the production account cannot delete.",
        "Session revocation is one operation (epoch bump) and is covered by a drill.",
        "Signing-key rotation is rehearsed with JWKS overlap and a rollback step.",
        "Postmortems produce at most three owned, dated actions and name the detection gap."
      ],
      "crates": [
        "axum",
        "sqlx",
        "tracing",
        "ring"
      ],
      "github": [
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        },
        {
          "name": "tokio-rs/tracing",
          "url": "https://github.com/tokio-rs/tracing"
        }
      ],
      "pitfall": "Rotating the signing key and deleting the old one in the same deploy: every live session and every cached JWKS breaks at once, and the outage hides the attacker's activity instead of exposing it.",
      "resources": [
        {
          "title": "Security incident response criteria: a practitioner's perspective (arXiv 1508.02526)",
          "url": "https://arxiv.org/abs/1508.02526",
          "kind": "paper"
        },
        {
          "title": "The blameless post mortem - PyGotham 2019",
          "url": "https://www.youtube.com/watch?v=qdvub6KaE28",
          "kind": "video"
        },
        {
          "title": "OWASP logging cheat sheet: what to capture during an incident",
          "url": "https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Logging_Cheat_Sheet.md",
          "kind": "docs"
        },
        {
          "title": "OWASP session management cheat sheet: revocation",
          "url": "https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Session_Management_Cheat_Sheet.md",
          "kind": "docs"
        }
      ]
    },
  ]
};
