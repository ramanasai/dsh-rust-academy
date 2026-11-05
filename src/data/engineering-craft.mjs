/**
 * Engineering craft track.
 *
 * Authored for the Rust Academy plugin. Every lesson is plain JSON-compatible
 * data consumed by src/app.js through build.mjs.
 */
export default {
  "key": "engineering-craft",
  "prefix": "ec",
  "title": "Engineering craft",
  "blurb": "How senior engineers work: reviews, RFCs, ADRs, debugging method, incidents, estimation, writing, mentorship and managing technical debt.",
  "level": "industry",
  "project": {
    "title": "Capstone: run a design review and an incident retrospective",
    "brief": "Take a real change in your own service and run it through the full senior-engineer loop: a design review package that names the alternatives and the trade-off you are accepting, an RFC plus the ADR set that records the decision, a rehearsed incident with a live timeline, a blameless postmortem whose action items have owners and dates, and a follow-up plan that says who verifies each item and how. The artifacts matter less than the trail: every claim links to evidence, every decision has a decider, and nothing ends in 'be more careful'.",
    "deliverables": [
      "A design review document with the decision, at least three considered alternatives, the trade-off accepted, and the evidence behind each claim.",
      "An RFC in the rust-lang template shape and a numbered ADR set in docs/adr/ with status lines and supersession links.",
      "A mock incident run with named roles, a timeline captured live as NDJSON, and a comms log with UTC timestamps.",
      "A blameless postmortem with impact in user-minutes, contributing factors instead of a single root cause, and three to five owned action items.",
      "A follow-up plan with owners, dates, a verification method per item, and the metric that shows the item actually landed."
    ],
    "stack": [
      "tracing",
      "tracing-subscriber",
      "serde_json",
      "clap",
      "git2",
      "pulldown-cmark",
      "insta",
      "cargo_metadata"
    ]
  },
  "lessons": [
    {
      "id": "ec01",
      "n": 1,
      "title": "Review that argues about design, not formatting",
      "minutes": 60,
      "level": "core",
      "goal": "Review a Rust diff for the invariant it moves into types, the public surface it makes permanent, and the failure mode it introduces, then write comments a colleague can act on without a meeting.",
      "sections": [
        {
          "h": "Machines review the diff; humans review the decision",
          "p": [
            "rustfmt and clippy already cover formatting, naming, and a long list of known mistakes. A reviewer who repeats them spends a senior engineer's scarce attention on work a CI job does better. What tools cannot see is the decision: which invariant this change moves into the type system, which API becomes permanent, and which failure mode appears at 03:00 when nobody is watching.",
            "A one-line diff can be a design event. Adding a bool parameter to a money movement function changes every call site, permanently, and encodes intent in a positional true. Reviewing that diff as 'looks fine, one line' is how codebases acquire APIs that nobody can read six months later. The comment that helps names the type you want instead: an amount, an overdraft policy, and a result that carries the reason."
          ],
          "list": [
            "Formatting, naming, and known lints belong in CI, not in review comments",
            "Public surface: is every pub item something the team will support forever?",
            "Error paths: can a caller tell a retryable failure from a permanent one?",
            "Observability: if this breaks in production, which signal will show it?"
          ],
          "tip": "Ask what the change makes impossible, not only what it makes possible."
        },
        {
          "h": "Comments the author can act on",
          "p": [
            "Two shapes do most of the work. A blocking comment states the observation, the consequence, and the smallest acceptable change. A question asks about a decision you cannot judge from the diff: why this cache, why this key, why now. Label them, or the author will treat a preference as a veto and a real defect as taste, and the review becomes a negotiation about tone."
          ],
          "code": "// Before: intent lives in a positional bool, and the compiler cannot help.\npub fn transfer(from: &mut Account, to: &mut Account, cents: u64, overdraft: bool) -> bool\n\n// After: money is a type, the outcome is an enum, and misuse does not compile.\n#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]\npub struct Cents(u64);\n\n#[derive(Debug, thiserror::Error)]\npub enum TransferError {\n    #[error(\"insufficient funds: need {needed:?}, available {available:?}\")]\n    InsufficientFunds { needed: Cents, available: Cents },\n    #[error(\"source and destination are the same account\")]\n    SameAccount,\n}\n\n#[derive(Debug, Clone, Copy, PartialEq, Eq)]\npub enum Overdraft {\n    Forbid,\n    Allow { limit: Cents },\n}\n\npub fn transfer(\n    from: &mut Account,\n    to: &mut Account,\n    amount: Cents,\n    overdraft: Overdraft,\n) -> Result<Receipt, TransferError>",
          "tip": "If you cannot say what evidence would change your mind, it is a preference; say so and move on."
        },
        {
          "h": "Split the diff so it can be reviewed",
          "p": [
            "Review quality falls with diff size: a reviewer scanning 1,200 lines is pattern-matching, not reasoning. Split mechanical from semantic: a rename-only commit that reviewers can skim with whitespace ignored, then the behaviour change on top. Mixed together, nobody can verify either, and a later bisect cannot tell you which half introduced the regression.",
            "For libraries, semver is part of the review. Adding a variant to a public enum breaks every downstream exhaustive match; adding one to a non_exhaustive enum does not. cargo-semver-checks turns that reasoning into a CI job, which is where it belongs, so the reviewer can spend the review on whether the new variant is the right model rather than whether it is technically breaking."
          ],
          "tip": "One decision per pull request. If the title needs the word 'and', split it."
        }
      ],
      "exercise": {
        "prompt": "A reviewer writes: 'this boolean will be misused by the next caller'. Replace fn withdraw(&mut self, cents: u64, allow_overdraft: bool) -> bool with a signature where the misuse is a compile error and the reason for failure is returned instead of false.",
        "starter": "#[derive(Debug, Clone, Copy, PartialEq, Eq)]\nstruct Cents(u64);\n\n#[derive(Debug, PartialEq, Eq)]\nenum Policy {\n    Forbid,\n    Allow { limit: Cents },\n}\n\n#[derive(Debug, PartialEq, Eq)]\nenum WithdrawError {\n    // name the two failure modes: not enough money, and beyond the agreed limit\n}\n\nstruct Balance(i64);\n\nimpl Balance {\n    fn withdraw(&mut self, amount: Cents, policy: Policy) -> Result<i64, WithdrawError> {\n        // compute the balance after the withdrawal, then enforce the policy\n        todo!()\n    }\n}\n\nfn main() {\n    // 1. a legal withdrawal returns the new balance\n    // 2. Forbid returns Insufficient when the balance would go negative\n    // 3. Allow { limit } returns LimitExceeded past that limit\n}",
        "hint": "Compute after = self.0 - amount.0 as i64 first. Match on the policy with guards: Forbid if after < 0, Allow { limit } if after < -(limit.0 as i64). No bool parameters, no sentinel return values.",
        "solution": "#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]\nstruct Cents(u64);\n\n#[derive(Debug, PartialEq, Eq)]\nenum Policy {\n    Forbid,\n    Allow { limit: Cents },\n}\n\n#[derive(Debug, PartialEq, Eq)]\nenum WithdrawError {\n    Insufficient { short_by: Cents },\n    LimitExceeded { over_by: Cents },\n}\n\nstruct Balance(i64);\n\nimpl Balance {\n    fn withdraw(&mut self, amount: Cents, policy: Policy) -> Result<i64, WithdrawError> {\n        let after = self.0 - amount.0 as i64;\n\n        match policy {\n            Policy::Forbid if after < 0 => {\n                return Err(WithdrawError::Insufficient {\n                    short_by: Cents(after.unsigned_abs()),\n                });\n            }\n            Policy::Allow { limit } if after < -(limit.0 as i64) => {\n                return Err(WithdrawError::LimitExceeded {\n                    over_by: Cents(after.unsigned_abs() - limit.0),\n                });\n            }\n            _ => {}\n        }\n\n        self.0 = after;\n        Ok(after)\n    }\n}\n\nfn main() {\n    let mut balance = Balance(500);\n\n    assert_eq!(balance.withdraw(Cents(200), Policy::Forbid), Ok(300));\n    assert_eq!(\n        balance.withdraw(Cents(1_000), Policy::Forbid),\n        Err(WithdrawError::Insufficient { short_by: Cents(700) })\n    );\n    assert_eq!(\n        balance.withdraw(Cents(600), Policy::Allow { limit: Cents(250) }),\n        Err(WithdrawError::LimitExceeded { over_by: Cents(50) })\n    );\n    assert_eq!(balance.withdraw(Cents(600), Policy::Allow { limit: Cents(400) }), Ok(-300));\n\n    println!(\"final balance: {}\", balance.0);\n}"
      },
      "questions": [
        {
          "q": "Which fact decides whether adding a variant to a public enum is a semver-breaking change?",
          "options": [
            "Whether the enum is marked #[non_exhaustive]",
            "Whether the crate version is still 0.x, where anything may change",
            "Whether the new variant is added at the end of the declaration",
            "Whether the enum derives Debug and PartialEq"
          ],
          "answer": 0,
          "explain": "non_exhaustive is the promise that lets you add variants later; without it, every downstream exhaustive match stops compiling. Declaration order is irrelevant to matching, and pre-1.0 crates still have a compatibility contract they choose to honour."
        },
        {
          "q": "Which review comment is most useful to the author of a 400-line retry change?",
          "options": [
            "Have you considered using a HashMap here instead?",
            "Blocking: this retry loop has no jitter, so N clients retry in lockstep and re-saturate the dependency; add full jitter and a test that asserts the delays differ.",
            "LGTM, CI is green and the tests pass",
            "nit: the variable name retry_count could be shorter"
          ],
          "answer": 1,
          "explain": "It names the observation, the production consequence, the smallest acceptable change, and how to verify it. The others are a style preference, an unargued suggestion, and a merge decision that outsources judgement to CI."
        },
        {
          "q": "A reviewer cannot articulate what evidence would settle a disagreement about naming. What should they do?",
          "options": [
            "Approve silently and mention it in the next retro",
            "Block the pull request until the author agrees with them",
            "Mark it as a nit or a question, state it once, and let the author decide",
            "Escalate to the team lead so the decision is not delayed"
          ],
          "answer": 2,
          "explain": "A preference with no falsifiable evidence is not a blocking defect. Labelling it and deferring keeps the blocking signal meaningful, which is the only reason the label works at all."
        }
      ],
      "quickbytes": [
        "Move mechanical checks into CI: rustfmt, clippy -D warnings, cargo-semver-checks. Reviewer attention is for decisions.",
        "Prefix comments with blocking: or nit: so the author knows what must change before merge.",
        "Ask for the test that fails on the old code; a test written after the fix proves much less."
      ],
      "production": [
        "CI runs fmt, clippy with -D warnings, and cargo-semver-checks on every pull request that touches a library crate.",
        "Any change to a public signature ships with its call-site migration in the same diff.",
        "New error enums are #[non_exhaustive] or their variants are, decided once and recorded in an ADR.",
        "Reviewers label every comment blocking or nit, and a blocking comment names the evidence that would clear it."
      ],
      "crates": [
        "cargo-semver-checks",
        "cargo-public-api",
        "trybuild",
        "thiserror"
      ],
      "github": [
        {
          "name": "cargo-semver-checks - breaking-change detection in CI",
          "url": "https://github.com/obi1kenobi/cargo-semver-checks"
        },
        {
          "name": "cargo-public-api - diff the public surface a review would change",
          "url": "https://github.com/Enselic/cargo-public-api"
        }
      ],
      "pitfall": "Reviewing only the happy path: the diff passes, then pages someone at 03:00 because the error branch unwraps a value that is None only when the dependency is degraded.",
      "resources": [
        {
          "title": "Kubernetes: Reviewing pull requests (what reviewers are expected to catch)",
          "url": "https://kubernetes.io/docs/contribute/review/reviewing-prs/",
          "kind": "docs"
        },
        {
          "title": "rust-clippy: the lints and their rationale",
          "url": "https://github.com/rust-lang/rust-clippy",
          "kind": "repo"
        },
        {
          "title": "A Systematic Literature Review and Taxonomy of Modern Code Review",
          "url": "https://arxiv.org/abs/2103.08777",
          "kind": "paper"
        },
        {
          "title": "GOTO Conferences: engineering practices and review culture talks",
          "url": "https://www.youtube.com/@GOTO-",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ec02",
      "n": 2,
      "title": "RFCs: from proposal to a decision with a date",
      "minutes": 75,
      "level": "advanced",
      "goal": "Write an RFC that a named decider can accept or reject, run a comment period that converges instead of sprawling, and record the disposition so the next team does not relitigate the same design.",
      "sections": [
        {
          "h": "An RFC is a decision instrument, not proof of diligence",
          "p": [
            "An RFC exists because a change is expensive to reverse and crosses team boundaries. It is not a document that demonstrates you thought hard; it is a request for a decision, with a named decider, a comment window, and one of a small set of dispositions. Rust's published process is the clearest example in the open: a template, a pull request, a final comment period of ten days, and merge, close, or postpone.",
            "The existence of three outcomes matters more than it looks. A process that can only say yes trains authors to write proposals that cannot be refused and reviewers to delay instead of deciding. Postpone is the honest answer when the design is sound but the timing is wrong. Close is the honest answer when the problem is real and the proposed solution is not, and it is only useful if the reasoning is written down."
          ],
          "list": [
            "Name the decider before the first comment, not after the argument",
            "Set the comment window and the date the decision lands",
            "Publish the disposition and the reasoning, including for rejects"
          ],
          "tip": "An RFC with no named decider is a discussion, and discussions do not close."
        },
        {
          "h": "The sections that force the hard questions",
          "p": [
            "The Rust template earns its shape. Guide-level explanation forces you to describe the change to someone who will use it, without implementation detail. Reference-level explanation forces precision about interactions with everything already shipped. Drawbacks is the section that catches authors who have not looked. Rationale and alternatives is where the status quo has to be defended rather than assumed.",
            "Unresolved questions is the honesty valve, and the most abused section. It should contain what the decision can proceed without, and what would change if the answer turns out badly. An empty section means either the design is trivial or the author has not found the questions yet; on a design that touches storage or a public API, it is almost always the second."
          ],
          "code": "---\nfeature: \"deferred-index-maintenance\"\nstart-date: \"2026-03-02\"\nauthor: \"platform-team\"\nstatus: \"proposed\"\n---\n\n# Summary\n\nMove secondary index maintenance out of the write path and into a\nbounded worker, so a slow index cannot extend write latency.\n\n# Motivation\n\np99 write latency tracks index p99 (currently 240 ms at 5% of traffic).\nA single slow index widens the whole write path with no way to shed load.\n\n# Guide-level explanation\n\nIndexes become eventually consistent within a stated budget (2 s p99).\nReads that require read-your-writes use the primary key path.\n\n# Reference-level explanation\n\n- Writes append an index intent row in the same transaction.\n- A worker drains intents with at-least-once semantics and idempotent upserts.\n- Staleness is exported as a metric with a per-index label.\n\n# Drawbacks\n\nReads that depend on a secondary index can observe stale results.\nWe accept this for search; we cannot accept it for authorization checks.\n\n# Rationale and alternatives\n\n1. Do nothing: write amplification grows with each new index.\n2. Per-index timeouts: sheds latency but returns partial writes.\n3. Chosen: intent log plus worker, because it bounds the blast radius.\n\n# Unresolved questions\n\n- Does the authorization path need a synchronous index? (evidence: 3 queries)\n- What is the retention for intents, and who pages on backlog age?\n\n# Future possibilities\n\nReuse the intent log for reindexing without a full table scan.",
          "tip": "Write the Drawbacks section first; it is the one that reveals whether you understand the change."
        },
        {
          "h": "Run the comment period like a meeting with an agenda",
          "p": [
            "Pre-wire the two reviewers whose objection will block you, before the RFC is public. An RFC that surprises the decider in public converts a design review into a negotiation, and negotiations are decided by seniority rather than evidence. When the window opens, summarize each objection in the thread and answer it with a decision or an explicit deferral into Unresolved questions.",
            "Then gate it. Require sign-off from named owners, allow the decider to overrule with a written rationale, and publish that rationale where the next proposal will find it. Consensus is not unanimity: a rule that requires everyone to agree gives any uninterested reviewer a veto that costs nothing to use, which is how design processes quietly stop producing decisions."
          ],
          "list": [
            "Sign-off from named owners, not a thumbs-up count",
            "Blocking objections are listed, answered, or explicitly deferred",
            "The decider records merge, close, or postpone with a reason",
            "Accepted RFC text is append-only; later changes are new RFCs"
          ],
          "tip": "Do not squash or rebase an RFC after review is visible: the comment history is the argument."
        }
      ],
      "exercise": {
        "prompt": "Implement the gate that decides whether a proposal may enter its final comment period: every required reviewer has signed off, no blocking objection is unanswered, and at least one full day has passed since the last substantive change.",
        "starter": "#[derive(Debug, Clone, Copy, PartialEq, Eq)]\nenum Disposition {\n    SignOff,\n    Objection { blocking: bool },\n    Abstain,\n}\n\nstruct Review {\n    reviewer: &'static str,\n    disposition: Disposition,\n}\n\nenum Gate {\n    Ready,\n    WaitingOn(Vec<&'static str>),\n}\n\nfn gate(\n    required: &[&'static str],\n    reviews: &[Review],\n    hours_since_last_change: u64,\n) -> Gate {\n    // 1. every required reviewer must have signed off\n    // 2. any blocking objection means not ready\n    // 3. at least 24 hours must have passed\n    todo!()\n}\n\nfn main() {}",
        "hint": "Build a Vec of reasons and return WaitingOn(reasons) if it is non-empty. A reviewer counts as signed off only with Disposition::SignOff. Check the clock last, so the message names people before it names time.",
        "solution": "#[derive(Debug, Clone, Copy, PartialEq, Eq)]\nenum Disposition {\n    SignOff,\n    Objection { blocking: bool },\n    Abstain,\n}\n\nstruct Review {\n    reviewer: &'static str,\n    disposition: Disposition,\n}\n\nenum Gate {\n    Ready,\n    WaitingOn(Vec<&'static str>),\n}\n\nfn gate(\n    required: &[&'static str],\n    reviews: &[Review],\n    hours_since_last_change: u64,\n) -> Gate {\n    let mut waiting: Vec<&'static str> = Vec::new();\n\n    for reviewer in required {\n        let disposition = reviews\n            .iter()\n            .find(|review| review.reviewer == *reviewer)\n            .map(|review| review.disposition);\n\n        match disposition {\n            Some(Disposition::SignOff) => {}\n            _ => waiting.push(reviewer),\n        }\n    }\n\n    for review in reviews {\n        if let Disposition::Objection { blocking: true } = review.disposition {\n            if !waiting.contains(&review.reviewer) {\n                waiting.push(review.reviewer);\n            }\n        }\n    }\n\n    if hours_since_last_change < 24 {\n        waiting.push(\"last change was less than 24h ago\");\n    }\n\n    if waiting.is_empty() {\n        Gate::Ready\n    } else {\n        Gate::WaitingOn(waiting)\n    }\n}\n\nfn main() {\n    let required = [\"alice\", \"bob\"];\n    let reviews = [\n        Review { reviewer: \"alice\", disposition: Disposition::SignOff },\n        Review { reviewer: \"bob\", disposition: Disposition::Abstain },\n    ];\n\n    match gate(&required, &reviews, 30) {\n        Gate::Ready => println!(\"enter FCP\"),\n        Gate::WaitingOn(reasons) => println!(\"waiting on: {reasons:?}\"),\n    }\n}"
      },
      "questions": [
        {
          "q": "What is the practical purpose of the RFC's Unresolved questions section?",
          "options": [
            "To defer all hard questions until implementation starts",
            "To give reviewers a place to add objections after the decision",
            "To list everything the author has not thought about yet",
            "To name what the decision can proceed without, and what would change if an answer goes badly"
          ],
          "answer": 3,
          "explain": "It bounds the debate: the decider accepts the risk of specific open questions rather than pretending there are none. Listing ignorance is not the point; naming the residual risk is."
        },
        {
          "q": "An RFC has forty comments, two real objections, and no decision after three weeks. What is the correct next move?",
          "options": [
            "Summarize the two blocking objections, restate the trade-off, and ask the named decider for a disposition",
            "Close the RFC as rejected so the team can move on",
            "Keep replying until every commenter agrees with the design",
            "Withdraw the RFC and implement the change without one"
          ],
          "answer": 0,
          "explain": "The process stalled on the disposition step, not the discussion. Summarizing and asking the decider converts accumulated comments into a decision, which is the only thing the RFC was for."
        },
        {
          "q": "Why does the Rust RFC process keep accepted RFCs append-only instead of editing them as the design evolves?",
          "options": [
            "Because the tooling cannot edit merged markdown",
            "Because the accepted text records what was decided at a point in time, so later changes need their own record",
            "Because editing an RFC would break the link from the implementation pull request",
            "Because reviewers vote on the exact text and any edit invalidates the vote"
          ],
          "answer": 1,
          "explain": "A decision record that silently drifts cannot be audited. Substantial changes get a new RFC with a note on the original, which preserves both the original reasoning and the reason it changed."
        }
      ],
      "quickbytes": [
        "Name the decider and the decision date in the first paragraph; everything else is supporting argument.",
        "Write Drawbacks and Alternatives before the design sections; they expose holes while they are still cheap.",
        "One logical change per RFC. Two designs in one document get reviewed as neither."
      ],
      "production": [
        "Every RFC names a decider, a comment window, and the date a disposition lands.",
        "Accepted RFCs are append-only in the repo; superseding proposals link back to them.",
        "The disposition and its rationale are recorded where the next author will search for them.",
        "Blocking objections are tracked to a decision or an explicit deferral, never left as open comments."
      ],
      "crates": [
        "pulldown-cmark",
        "mdbook",
        "serde",
        "anyhow"
      ],
      "github": [
        {
          "name": "rust-lang/mdBook - how the RFC corpus is published and tested",
          "url": "https://github.com/rust-lang/mdBook"
        },
        {
          "name": "pulldown-cmark - parse proposals for the required sections",
          "url": "https://github.com/pulldown-cmark/pulldown-cmark"
        }
      ],
      "pitfall": "An RFC that grows a fourth and fifth design in the comment thread: reviewers argue about different proposals, and the decider postpones because no single design was ever on the table.",
      "resources": [
        {
          "title": "The Rust RFC Book: process, life-cycle, and dispositions",
          "url": "https://rust-lang.github.io/rfcs/",
          "kind": "docs"
        },
        {
          "title": "rust-lang/rfcs: template and the full accepted corpus",
          "url": "https://github.com/rust-lang/rfcs",
          "kind": "repo"
        },
        {
          "title": "Linux kernel: describing changes and posting patches for review",
          "url": "https://docs.kernel.org/process/submitting-patches.html",
          "kind": "docs"
        },
        {
          "title": "GOTO Conferences: design process and architecture decision talks",
          "url": "https://www.youtube.com/@GOTO-",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ec03",
      "n": 3,
      "title": "ADRs: one decision, one file, one status",
      "minutes": 60,
      "level": "core",
      "goal": "Record architecture decisions as immutable numbered ADRs with real consequences, then add a CI check that keeps filenames, statuses, and supersession links honest as the code changes.",
      "sections": [
        {
          "h": "What an ADR is, and what it is not",
          "p": [
            "An architecture decision record captures one decision, the forces that made it necessary, and what it costs. It is not a design document: it does not need diagrams, and it should be short enough to read in two minutes. It is not a wiki page either, because a wiki page has no reviewer, no diff, and no history that anyone reads. The version that survives lives in the repository next to the code it constrains.",
            "The format that spread is Michael Nygard's five fields: title, status, context, decision, consequences. The consequences section is where the honesty lives, because it must say what becomes harder, not only what becomes possible. A record with no negative consequences is a sales pitch, and the next engineer will discover the missing half during an incident."
          ],
          "list": [
            "One decision per file; if it needs 'and', it is two records",
            "Status is one of proposed, accepted, deprecated, superseded",
            "Consequences name what gets harder, not just what gets better",
            "The ADR lives in the repo and is reviewed in a pull request"
          ],
          "tip": "Write the ADR before the implementation lands, not after; the point is to decide, not to document a fait accompli."
        },
        {
          "h": "Number, index, supersede",
          "p": [
            "Use docs/adr/NNNN-slug.md with a monotonic number that is never reused, plus an index table in docs/adr/README.md. Accepted text is append-only: when the decision changes, write a new ADR that says it supersedes the old one, and update the old one's status line and superseded-by pointer. Renumbering or rewriting history destroys the only thing the corpus is for, which is knowing what was believed at the time.",
            "MADR is the variant worth using when the decision is contested, because it adds considered options with pros and cons. Studies of ADR templates compare them on comprehension, usability, and ease of adoption, but no format survives a team that writes three records and stops. Pick one template, enforce a small required set, and let the prose be free."
          ],
          "code": "# docs/adr/0007-bound-index-maintenance-by-worker.md\n\n# 7. Bound index maintenance with an intent-log worker\n\n- Status: accepted\n- Date: 2026-03-09\n- Deciders: platform-team, search-team\n- Supersedes: 0003 (synchronous index writes)\n- Superseded by: -\n\n## Context\n\nWrites fan out to four secondary indexes in the request path. p99 write\nlatency tracks index p99, and one slow index stalls every write. We need a\nbound on write latency that does not depend on index health.\n\n## Decision\n\nWrites append an index intent row in the same transaction. A worker drains\nintents with at-least-once delivery and idempotent upserts. Index staleness\nis exported per index and budgeted at 2 s p99.\n\n## Consequences\n\n- Positive: write latency no longer depends on index latency.\n- Positive: reindexing reuses the same log instead of a table scan.\n- Negative: reads through a secondary index can be up to 2 s stale.\n- Negative: one more worker to run, alert on, and drain during deploys.\n- Negative: authorization checks may not use a secondary index.\n\n## Alternatives considered\n\n1. Per-index timeouts: sheds latency but produces partial writes.\n2. Async replication with no intent log: loses intents on crash.\n"
        },
        {
          "h": "Make the format enforceable, or it rots",
          "p": [
            "A template without a check decays within a quarter: files get named wrong, statuses drift to 'done', supersession links point at records that were renamed. The fix is a small linter in CI that asserts four things: the filename matches the pattern, the required headings exist, the status is in the enum, and every supersedes or superseded-by target resolves to a real file with a reciprocal link.",
            "Keep the required set small. Every additional mandatory heading lowers the chance the record gets written at all, and an unwritten ADR is worse than a sloppy one. Four headings plus a status line is enough to reconstruct the decision later, and the linter can grow once the habit exists."
          ],
          "tip": "Check reciprocity in both directions: a supersedes link with no matching status line is how readers end up implementing the deprecated choice."
        }
      ],
      "exercise": {
        "prompt": "Given the ADR files in a directory, resolve which record is currently in force for a topic: follow superseded-by links until a record is not superseded, and fail loudly if the chain loops or points at a missing file.",
        "starter": "use std::collections::HashMap;\n\nstruct Adr {\n    id: u32,\n    superseded_by: Option<u32>,\n}\n\nfn in_force(adrs: &[Adr], start: u32) -> Result<u32, String> {\n    // follow superseded_by until None; a repeated id is a cycle\n    // a missing target is an error, not a silent stop\n    todo!()\n}\n\nfn main() {}",
        "hint": "Keep a HashMap<u32, &Adr> and a Vec of visited ids. On each hop, look up the target; if absent return Err with both ids, if already visited return Err naming the cycle, otherwise continue. Return the id with no successor.",
        "solution": "use std::collections::HashMap;\n\nstruct Adr {\n    id: u32,\n    superseded_by: Option<u32>,\n}\n\nfn in_force(adrs: &[Adr], start: u32) -> Result<u32, String> {\n    let by_id: HashMap<u32, &Adr> = adrs.iter().map(|adr| (adr.id, adr)).collect();\n    let mut visited: Vec<u32> = Vec::new();\n    let mut current = start;\n\n    loop {\n        if visited.contains(&current) {\n            return Err(format!(\"supersession cycle at ADR {current}: {visited:?}\"));\n        }\n        visited.push(current);\n\n        let adr = by_id\n            .get(&current)\n            .ok_or_else(|| format!(\"ADR {current} does not exist\"))?;\n\n        match adr.superseded_by {\n            None => return Ok(current),\n            Some(next) => current = next,\n        }\n    }\n}\n\nfn main() {\n    let adrs = vec![\n        Adr { id: 3, superseded_by: Some(7) },\n        Adr { id: 7, superseded_by: None },\n        Adr { id: 9, superseded_by: Some(9) },\n        Adr { id: 11, superseded_by: Some(42) },\n    ];\n\n    assert_eq!(in_force(&adrs, 3), Ok(7));\n    assert!(in_force(&adrs, 9).is_err());\n    assert!(in_force(&adrs, 11).is_err());\n    println!(\"in force for 3: {:?}\", in_force(&adrs, 3));\n}"
      },
      "questions": [
        {
          "q": "Why is an accepted ADR edited only by adding a superseding record instead of rewriting the decision?",
          "options": [
            "Because reviewers would have to re-approve every dependent pull request",
            "Because markdown files are append-only in most repository tooling",
            "Because the record's value is what was decided with the information available then, which a rewrite erases",
            "Because changing an accepted ADR would invalidate the code that implements it"
          ],
          "answer": 2,
          "explain": "The corpus is an audit trail of reasoning under uncertainty. Rewriting it makes the team look prescient and hides why the old approach seemed right, which is exactly the context needed to avoid repeating it."
        },
        {
          "q": "Which consequence belongs in the Consequences section of an ADR?",
          "options": [
            "The implementation was merged in pull request 1841",
            "The team prefers Postgres over MySQL for new services",
            "The worker is written in Rust and uses tokio",
            "Reads through a secondary index can now be up to 2 s stale"
          ],
          "answer": 3,
          "explain": "Consequences are the durable trade-offs a future reader must live with. Implementation trivia belongs in the pull request, and preferences without a decision are not decisions."
        },
        {
          "q": "Your ADR linter requires twelve headings and a filled-in risk matrix. What is the most likely outcome?",
          "options": [
            "Fewer decisions recorded at all, because the cost of writing one exceeds its perceived value",
            "More supersession links, because the format makes relationships explicit",
            "Better onboarding, because the records are more complete",
            "Higher quality decisions, because each heading forces thought"
          ],
          "answer": 0,
          "explain": "Mandatory structure is a tax on the habit you are trying to build. Adoption collapses first and quality never gets a chance; start with four required fields and grow the check once writing ADRs is routine."
        }
      ],
      "quickbytes": [
        "docs/adr/NNNN-slug.md, numbers never reused, index table in docs/adr/README.md, reviewed in the same PR as the change.",
        "Put the negative consequences in the record; they are what a future reader needs during an incident.",
        "Lint four things in CI: filename, required headings, status enum, and reciprocal supersession links."
      ],
      "production": [
        "Every architecturally significant decision has an ADR merged before or with the implementation.",
        "Accepted ADRs are immutable; changes create a new record with bidirectional supersession links.",
        "CI fails on a malformed filename, an unknown status, a missing heading, or a dangling supersession target.",
        "The ADR index is generated or checked in CI so it cannot drift from the directory listing."
      ],
      "crates": [
        "pulldown-cmark",
        "walkdir",
        "anyhow",
        "regex"
      ],
      "github": [
        {
          "name": "pulldown-cmark - parse ADR headings for the linter",
          "url": "https://github.com/pulldown-cmark/pulldown-cmark"
        },
        {
          "name": "walkdir - enumerate docs/adr and keep the index honest",
          "url": "https://github.com/BurntSushi/walkdir"
        }
      ],
      "pitfall": "ADRs written after the fact as justification: the corpus fills with tidy decisions that never mention the option the team actually argued about, so nobody consults it before the next decision.",
      "resources": [
        {
          "title": "adr/madr: Markdown Any Decision Records templates",
          "url": "https://github.com/adr/madr",
          "kind": "repo"
        },
        {
          "title": "npryce/adr-tools: numbering, linking, and superseding ADRs",
          "url": "https://github.com/npryce/adr-tools",
          "kind": "repo"
        },
        {
          "title": "One Size Fits All? An Empirical Comparison of ADR Templates",
          "url": "https://arxiv.org/abs/2604.27333",
          "kind": "paper"
        },
        {
          "title": "rust-lang/rfcs: RFCs as the heavyweight cousin of an ADR",
          "url": "https://github.com/rust-lang/rfcs",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "ec04",
      "n": 4,
      "title": "Debug by shrinking: reproduce, minimise, explain",
      "minutes": 90,
      "level": "core",
      "goal": "Turn a vague failure into a deterministic reproduction, shrink it to the smallest input that still fails, and use bisect to find the change that introduced it rather than the change that revealed it.",
      "sections": [
        {
          "h": "The loop: stabilise, reproduce, shrink, explain",
          "p": [
            "Debugging fails most often at the first step, not the hard one. A report that says 'sometimes the sync stalls' is not a bug yet; it is a symptom with no predicate. The work is to build a command that exits non-zero, on demand, and then to shrink its input until the mechanism is visible. Fixing before explaining produces a patch that makes the symptom disappear while the bug moves somewhere quieter.",
            "Write the hypothesis down together with the observation that would falsify it. Without that, you debug your memory of the code, and memory reconstructs a tidier story than what happened. The written hypothesis is also the handoff artifact: it is what lets a colleague pick up the investigation while you sleep, which is the difference between a two-hour outage and a two-day one."
          ],
          "list": [
            "Stabilise: pin the build, the data, the seed, and the clock",
            "Reproduce: one command, deterministic exit code",
            "Shrink: smallest input that still fails",
            "Explain: name the mechanism before writing the fix"
          ],
          "tip": "If the reproduction needs a debugger to observe, it is not reproducible yet."
        },
        {
          "h": "Shrinking is mechanical, so it does not need understanding",
          "p": [
            "Delta debugging works on a predicate, not on insight: you keep a candidate input, try removing chunks, and keep the smaller version whenever the failure still reproduces. Because the predicate does the judging, you can shrink a 4 MB log down to a dozen bytes without knowing why it fails, and the small case usually makes the mechanism obvious. The only requirement is that the predicate is stable and fast enough to run hundreds of times.",
            "In Rust the predicate is a closure that runs the failing path and returns bool, so the same shrinker works for a parser panic, a serialization mismatch, or a numeric overflow. Keep it in a test-support module: the next person who hits the same class of bug inherits a tool instead of a story."
          ],
          "code": "/// Remove chunks of the input while `still_fails` holds, then try single bytes.\n/// Returns the smallest input found, not a proof of minimality.\npub fn shrink(input: &[u8], still_fails: impl Fn(&[u8]) -> bool) -> Vec<u8> {\n    let mut best = input.to_vec();\n    let mut chunk = best.len() / 2;\n\n    while chunk >= 1 {\n        let mut start = 0;\n        while start < best.len() {\n            let end = (start + chunk).min(best.len());\n            let mut candidate = best[..start].to_vec();\n            candidate.extend_from_slice(&best[end..]);\n\n            if !candidate.is_empty() && still_fails(&candidate) {\n                best = candidate;\n            } else {\n                start += chunk;\n            }\n        }\n        chunk /= 2;\n    }\n\n    best\n}\n\n#[cfg(test)]\nmod tests {\n    use super::shrink;\n\n    #[test]\n    fn finds_the_minimal_panicking_prefix() {\n        // The predicate mirrors a parser that panics on a 0xFF byte\n        // only when it is followed by a 0x00 byte.\n        let input = b\"header,more,data,\\xff\\x00,tail\";\n        let smaller = shrink(input, |candidate| {\n            candidate.windows(2).any(|pair| pair == [0xFF, 0x00])\n        });\n        assert_eq!(smaller, vec![0xFF, 0x00]);\n    }\n}",
          "tip": "Shrink against the real code path, not a re-implementation of it; the predicate must fail the same way the production path does."
        },
        {
          "h": "Bisect finds the change, not the cause",
          "p": [
            "git bisect needs a deterministic predicate, which is why shrinking comes first and bisecting second. The subtle part is exit code 125: bisect reads 0 as good, 1 as bad, and 125 as 'cannot test'. If a build failure returns 1, bisect will confidently blame a commit that only broke compilation, and you will spend an afternoon reading the wrong diff. Use a script that returns 125 whenever the tree does not build or the test cannot run.",
            "Bisect also fails on flaky tests, and it fails silently: the commit it names is the noise, not the regression. Run the repro five times and require all five to fail before calling a commit bad. If the test only fails on release builds, bisect with release builds, because debug assertions change timing and the bug may not exist in the profile you are testing."
          ],
          "code": "#!/usr/bin/env bash\n# bisect-repro.sh: exit 0 = good, 1 = bad, 125 = cannot test (skip this commit).\nset -u\n\nif ! cargo build --locked --quiet 2>/dev/null; then\n  echo \"skip: does not build at $(git rev-parse --short HEAD)\"\n  exit 125\nfi\n\n# The failure is timing-sensitive: require 5 failures out of 5.\nfor attempt in 1 2 3 4 5; do\n  if cargo test --locked --quiet --test repro -- --exact stalls 2>/dev/null; then\n    exit 0\n  fi\ndone\n\nexit 1\n\n# git bisect start\n# git bisect bad HEAD\n# git bisect good v1.4.0\n# git bisect run ./bisect-repro.sh",
          "tip": "Log each bisect step: 'git bisect log > bisect.txt' turns the search into evidence you can attach to the issue."
        }
      ],
      "exercise": {
        "prompt": "A failing case arrives as a 2 KB request body and the handler panics. Implement the shrinker, then use it to reduce a synthetic input to two bytes, and assert that the shrunk input still panics the same way.",
        "starter": "pub fn shrink(input: &[u8], still_fails: impl Fn(&[u8]) -> bool) -> Vec<u8> {\n    // 1. try removing chunks, largest first\n    // 2. keep a candidate only if it is non-empty and still_fails\n    // 3. halve the chunk size and repeat until chunk == 1\n    todo!()\n}\n\n#[cfg(test)]\nmod tests {\n    use super::shrink;\n\n    #[test]\n    fn reaches_two_bytes() {\n        let input: Vec<u8> = b\"GET /a?b=c HTTP/1.1\\r\\nX-Bad: \\xff\\x00\\r\\n\\r\\n\".to_vec();\n        let smaller = shrink(&input, |c| c.windows(2).any(|w| w == [0xFF, 0x00]));\n        assert_eq!(smaller.len(), 2);\n    }\n}",
        "hint": "Start with chunk = best.len() / 2 and shrink the chunk each outer pass. When a removal still fails, do not advance start: the slice shifted, so retry the same index against the shorter buffer.",
        "solution": "pub fn shrink(input: &[u8], still_fails: impl Fn(&[u8]) -> bool) -> Vec<u8> {\n    let mut best = input.to_vec();\n    let mut chunk = (best.len() / 2).max(1);\n\n    while chunk >= 1 {\n        let mut start = 0;\n        while start < best.len() {\n            let end = (start + chunk).min(best.len());\n            let mut candidate = best[..start].to_vec();\n            candidate.extend_from_slice(&best[end..]);\n\n            if !candidate.is_empty() && still_fails(&candidate) {\n                best = candidate;\n            } else {\n                start += chunk;\n            }\n        }\n        if chunk == 1 {\n            break;\n        }\n        chunk /= 2;\n    }\n\n    best\n}\n\nfn main() {\n    let input: Vec<u8> = b\"GET /a?b=c HTTP/1.1\\r\\nX-Bad: \\xff\\x00\\r\\nHost: x\\r\\n\\r\\n\".to_vec();\n    let smaller = shrink(&input, |candidate| {\n        candidate.windows(2).any(|pair| pair == [0xFF, 0x00])\n    });\n\n    assert_eq!(smaller, vec![0xFF, 0x00]);\n    assert!(smaller.windows(2).any(|pair| pair == [0xFF, 0x00]));\n    println!(\"{} bytes -> {} bytes\", input.len(), smaller.len());\n}"
      },
      "questions": [
        {
          "q": "Why must a bisect script exit 125 when the tree does not build?",
          "options": [
            "Because 125 is the conventional exit code for a skipped test",
            "Because 1 would tell bisect the commit is bad, so a build-only break looks like the regression",
            "Because bisect retries a failed step up to three times",
            "Because 125 marks the commit as the first bad one"
          ],
          "answer": 1,
          "explain": "Bisect classifies each commit as good, bad, or untestable. A build failure reported as bad moves the search into the wrong half of history and names a commit that only broke compilation."
        },
        {
          "q": "A reproduction fails roughly one run in three. What should you do before bisecting?",
          "options": [
            "Bisect in release mode, where timing is more stable",
            "Bisect anyway and take the first commit that shows any failure",
            "Run the reproduction repeatedly per commit and require consistent failure before classifying a commit",
            "Disable the tests that pass so the run becomes deterministic"
          ],
          "answer": 2,
          "explain": "Bisect assumes a deterministic predicate. With a one-in-three failure rate, the first failing commit is noise; requiring five failures out of five per commit makes the classification trustworthy."
        },
        {
          "q": "What is the main output of shrinking before you understand the root cause?",
          "options": [
            "The exact commit that introduced the defect",
            "A performance profile of the failing path",
            "A proof that no smaller input can fail",
            "A small case whose mechanism is readable, and a predicate that stays usable forever"
          ],
          "answer": 3,
          "explain": "Shrinking is a search over inputs, not a proof. It gives you a case small enough to read and a predicate that later becomes a regression test; attribution comes from bisect and explanation comes from reading the small case."
        }
      ],
      "quickbytes": [
        "No deterministic command, no bug: build the reproduction before touching the code.",
        "Bisect script: 0 good, 1 bad, 125 cannot-test. Never let a build failure return 1.",
        "Require N-out-of-N failures per commit before a timing-sensitive regression is classified."
      ],
      "production": [
        "Every incident reproduction becomes a regression test in the same pull request as the fix.",
        "Bisect scripts are checked in under tools/ so the next investigator reuses them.",
        "Panic handlers capture a backtrace with symbols; RUST_BACKTRACE is set in staging.",
        "Flaky-test reports are triaged as bugs in the test, with the same urgency as the product defect."
      ],
      "crates": [
        "tracing",
        "tracing-subscriber",
        "anyhow",
        "insta"
      ],
      "github": [
        {
          "name": "tokio-rs/tracing - spans and structured fields for investigation",
          "url": "https://github.com/tokio-rs/tracing"
        },
        {
          "name": "mitsuhiko/insta - snapshot tests for reproductions",
          "url": "https://github.com/mitsuhiko/insta"
        }
      ],
      "pitfall": "Bisecting a flaky reproduction: the search returns a plausible-looking commit, the code there is innocent, and the real defect stays in the tree with a new test that passes most of the time.",
      "resources": [
        {
          "title": "std::backtrace::Backtrace - capturing a backtrace deliberately",
          "url": "https://doc.rust-lang.org/std/backtrace/struct.Backtrace.html",
          "kind": "docs"
        },
        {
          "title": "tracing: structured spans and fields in the failing path",
          "url": "https://docs.rs/tracing/latest/tracing/",
          "kind": "docs"
        },
        {
          "title": "tracing-subscriber: EnvFilter for targeted reproduction logging",
          "url": "https://docs.rs/tracing-subscriber/latest/tracing_subscriber/",
          "kind": "docs"
        },
        {
          "title": "Failures and Fixes: A Study of Software System Incident Response",
          "url": "https://arxiv.org/abs/2008.11192",
          "kind": "paper"
        }
      ]
    },
    {
      "id": "ec05",
      "n": 5,
      "title": "Incident command: decide, communicate, record",
      "minutes": 75,
      "level": "advanced",
      "goal": "Run a live incident with named roles, one communication cadence, and a timeline written as it happens, so that mitigation does not depend on one person doing diagnosis, communication, and note-taking at once.",
      "sections": [
        {
          "h": "Roles exist because attention is finite",
          "p": [
            "The incident commander decides and does not debug. That single rule is the difference between a response that converges and one where five engineers edit the same hypothesis while nobody talks to support. The ops lead drives the technical work, the comms lead owns one channel and the status page, and the scribe timestamps events as they happen. On a small team one person may hold two roles, but never all four.",
            "Severity is a contract, not a feeling: it decides who is woken, how often updates are due, and whether a rollback happens without further debate. Write the ladder down in peacetime, with concrete triggers such as error rate above 5% for ten minutes or any data loss. The commander can hand off after about 45 minutes; a tired commander who will not hand off is a second incident."
          ],
          "list": [
            "Commander: decides, sets cadence, owns the rollback call, does not type fixes",
            "Ops lead: runs the investigation and the change to production",
            "Comms lead: one channel, one status page, one voice to stakeholders",
            "Scribe: timeline with UTC timestamps, written live"
          ],
          "tip": "If the commander is also the only person who understands the system, the incident is a staffing finding, not just an outage."
        },
        {
          "h": "Stop the bleeding before you understand the wound",
          "p": [
            "Mitigate first: roll back the deploy, turn the flag off, shift traffic, or scale out. A rollback is one command you rehearsed, so it should be the default move when the change correlation is clear. Fixing forward under pressure is only justified when rollback is impossible, and that impossibility should already be written down as a known risk rather than discovered at 02:40.",
            "Record the decisions, not just the actions: who called the rollback, at what time, and what evidence they had. Six weeks later the interesting question is never what commands ran, it is why the team believed it was safe, and that belief is exactly what the timeline is for. Capture it while it is fresh, because memory rewrites the story into something more coherent than what happened."
          ],
          "code": "use std::time::{Duration, Instant};\n\n#[derive(Debug, Clone, Copy, PartialEq, Eq)]\npub enum Role {\n    Commander,\n    Ops,\n    Comms,\n    Scribe,\n}\n\n#[derive(Debug)]\npub struct Timeline {\n    started: Instant,\n    events: Vec<Event>,\n}\n\n#[derive(Debug)]\npub struct Event {\n    pub elapsed_ms: u128,\n    pub role: Role,\n    pub action: String,\n}\n\nimpl Timeline {\n    pub fn start() -> Self {\n        Self { started: Instant::now(), events: Vec::new() }\n    }\n\n    /// Recording is append-only and monotonic: a timeline that can be edited\n    /// after the fact is a narrative, not evidence.\n    pub fn record(&mut self, role: Role, action: impl Into<String>) -> &Event {\n        let event = Event {\n            elapsed_ms: self.started.elapsed().as_millis(),\n            role,\n            action: action.into(),\n        };\n        self.events.push(event);\n        self.events.last().expect(\"just pushed\")\n    }\n\n    pub fn gap_between(&self, from: Role, to: Role) -> Option<Duration> {\n        let from_index = self.events.iter().position(|event| event.role == from)?;\n        let to_index = self.events.iter().position(|event| event.role == to)?;\n        if from_index >= to_index {\n            return None; // the second role happened first, so there is no gap\n        }\n        Some(Duration::from_millis(\n            (self.events[to_index].elapsed_ms - self.events[from_index].elapsed_ms) as u64,\n        ))\n    }\n}",
          "tip": "Time from detection to first mitigation is the number worth improving; it is usually dominated by 'who is allowed to decide'."
        },
        {
          "h": "Communication is part of the mitigation",
          "p": [
            "One channel, one status page, UTC timestamps, and a fixed cadence: what is known, what is being done, when the next update lands. No speculation about cause, no ETAs you cannot keep, no names. Stakeholders fill silence with worse guesses than the truth, so a short update that says 'we do not know yet, we are rolling back, next update in 20 minutes' is worth more than a long one that speculates.",
            "Keep the customer-facing text and the internal channel separate but consistent. Support needs to know what to tell people, and the difference between 'degraded' and 'down' is a business decision the commander makes with the comms lead, not a phrasing choice made under pressure. After the incident, the cadence record shows whether the team actually communicated or only believed it did."
          ],
          "tip": "Announce the next update time in every update, then meet it even if nothing changed."
        }
      ],
      "exercise": {
        "prompt": "Build the timeline recorder an incident needs: append-only events with role, elapsed milliseconds, and action; reject an out-of-order insert; and report the detection-to-mitigation gap so the retro can act on it.",
        "starter": "use std::time::Instant;\n\n#[derive(Debug, Clone, Copy, PartialEq, Eq)]\nenum Role { Commander, Ops, Comms, Scribe }\n\nstruct Event { elapsed_ms: u128, role: Role, action: String }\n\nstruct Timeline { started: Instant, events: Vec<Event> }\n\nimpl Timeline {\n    fn record(&mut self, role: Role, action: &str) -> Result<(), String> {\n        // elapsed must never go backwards; return Err if it would\n        todo!()\n    }\n\n    fn gap_ms(&self, from: Role, to: Role) -> Option<u128> {\n        // first occurrence of each role, in elapsed order\n        todo!()\n    }\n}\n\nfn main() {}",
        "hint": "For monotonicity, compare the new elapsed value with the last event's before pushing. For the gap, find the first event of each role with position(); use checked_sub so a reversed pair returns None instead of underflowing.",
        "solution": "use std::time::Instant;\n\n#[derive(Debug, Clone, Copy, PartialEq, Eq)]\nenum Role { Commander, Ops, Comms, Scribe }\n\n#[derive(Debug)]\nstruct Event { elapsed_ms: u128, role: Role, action: String }\n\nstruct Timeline { started: Instant, events: Vec<Event> }\n\nimpl Timeline {\n    fn new() -> Self {\n        Self { started: Instant::now(), events: Vec::new() }\n    }\n\n    fn record(&mut self, role: Role, action: &str) -> Result<(), String> {\n        let elapsed_ms = self.started.elapsed().as_millis();\n\n        if let Some(last) = self.events.last() {\n            if elapsed_ms < last.elapsed_ms {\n                return Err(format!(\n                    \"out-of-order event: {elapsed_ms} ms after a {}-ms event\",\n                    last.elapsed_ms\n                ));\n            }\n        }\n\n        self.events.push(Event { elapsed_ms, role, action: action.to_string() });\n        Ok(())\n    }\n\n    fn gap_ms(&self, from: Role, to: Role) -> Option<u128> {\n        let first = self.events.iter().position(|event| event.role == from)?;\n        let next = self.events.iter().position(|event| event.role == to)?;\n        if first >= next {\n            return None;\n        }\n        self.events[next].elapsed_ms.checked_sub(self.events[first].elapsed_ms)\n    }\n\n    fn render(&self) -> String {\n        self.events\n            .iter()\n            .map(|event| format!(\"{:>6} ms  {:?}  {}\\n\", event.elapsed_ms, event.role, event.action))\n            .collect()\n    }\n}\n\nfn main() {\n    let mut timeline = Timeline::new();\n    timeline.record(Role::Comms, \"page acknowledged\").unwrap();\n    timeline.record(Role::Commander, \"declared SEV-2, rollback authorised\").unwrap();\n    timeline.record(Role::Ops, \"rolled back api@1.42.3 to 1.42.1\").unwrap();\n\n    assert!(timeline.gap_ms(Role::Comms, Role::Ops).is_some());\n    assert!(timeline.gap_ms(Role::Ops, Role::Comms).is_none());\n    print!(\"{}\", timeline.render());\n}"
      },
      "questions": [
        {
          "q": "Why should the incident commander not be the person debugging?",
          "options": [
            "Because deciding, coordinating, and communicating consume the attention the debugging needs, and nobody is left to make the rollback call",
            "Because the commander must stay on the bridge and never touch a terminal",
            "Because debugging requires a second pair of eyes by policy",
            "Because commanders are usually less familiar with the code"
          ],
          "answer": 0,
          "explain": "The role exists to protect a scarce resource: attention on decisions. A commander deep in a stack trace stops noticing stakeholder requests, the clock, and the option to roll back."
        },
        {
          "q": "The error rate spiked right after a deploy and rollback takes one command. What is the correct first action?",
          "options": [
            "Read the changed code to confirm the cause before acting",
            "Roll back, then investigate the cause with the pressure off",
            "Scale out capacity in case the deploy was a coincidence",
            "Restart the database to clear any locked state"
          ],
          "answer": 1,
          "explain": "Mitigation buys time. Confirming the cause first lengthens customer impact for information you can gather just as well after the rollback, and the rollback itself is a strong causal test."
        },
        {
          "q": "Which timeline entry is the most valuable six weeks later?",
          "options": [
            "12:04:11 - kubectl apply -f deploy.yaml",
            "12:04 - ops applied the manifest twice and the second apply hung",
            "12:04 - commander authorised rollback because the only change since 11:55 was the deploy, and the previous version was healthy at 11:40",
            "12:05 - team discussed options in the incident channel"
          ],
          "answer": 2,
          "explain": "It records the belief and the evidence behind a decision, which is what later analysis needs. Command output is reproducible; the reasoning that was available at the time is not."
        }
      ],
      "quickbytes": [
        "Name the commander in the first minute; a channel with no owner becomes a group chat.",
        "Rollback is the default mitigation when change correlates; rehearse it until it is one command.",
        "Announce the next update time in every update and meet it, even when nothing has changed."
      ],
      "production": [
        "A severity ladder with concrete triggers is documented and linked from the incident channel topic.",
        "The rollback path is exercised in peacetime at least once a quarter, timed end to end.",
        "Every incident produces a live timeline artifact, not a reconstruction written the next morning.",
        "Comms templates for status page and support exist before they are needed, with UTC timestamps."
      ],
      "crates": [
        "tracing",
        "tracing-subscriber",
        "serde_json",
        "chrono"
      ],
      "github": [
        {
          "name": "tokio-rs/tracing - spans that survive into the incident timeline",
          "url": "https://github.com/tokio-rs/tracing"
        },
        {
          "name": "chronotope/chrono - UTC timestamps for the timeline and comms log",
          "url": "https://github.com/chronotope/chrono"
        }
      ],
      "pitfall": "One engineer holds commander, ops, and scribe at once: mitigation happens late because every minute spent typing a fix is a minute nobody is watching the clock, the status page, or the decision to roll back.",
      "resources": [
        {
          "title": "OpenTelemetry: traces as the shared record of a request",
          "url": "https://opentelemetry.io/docs/concepts/signals/traces/",
          "kind": "docs"
        },
        {
          "title": "tracing: structured events you can timestamp and correlate",
          "url": "https://docs.rs/tracing/latest/tracing/",
          "kind": "docs"
        },
        {
          "title": "Failures and Fixes: A Study of Software System Incident Response",
          "url": "https://arxiv.org/abs/2008.11192",
          "kind": "paper"
        },
        {
          "title": "USENIX Association: SREcon talks on incident response and on-call",
          "url": "https://www.youtube.com/@USENIXorg",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ec06",
      "n": 6,
      "title": "Blameless postmortems that change the system",
      "minutes": 75,
      "level": "advanced",
      "goal": "Write a postmortem that explains the system conditions behind a mistake, and produce three to five action items with owners, dates, and a verification method so the review changes behaviour rather than producing a document.",
      "sections": [
        {
          "h": "Human error is where the analysis stops",
          "p": [
            "If the finding is 'an engineer ran the wrong command', the next engineer will run it too, because the conditions that made it easy are unchanged. Blameless does not mean nobody was involved; it means causality is placed where it can be fixed. The useful question is what made the wrong action available, attractive, and unconfirmed: a command with no dry-run, a flag named like its opposite, a console where production and staging look identical.",
            "The test that separates a system finding from a blame finding is counterfactual: if a different engineer, equally competent and equally tired, had been at the keyboard with the same information, would the same failure be likely? If yes, you have a system condition. If no, you have a genuinely unusual act, and even then the interesting question is what guardrail would have caught it before customers did."
          ],
          "list": [
            "Name the conditions, not the person: missing guardrail, confusing interface, absent alert",
            "Separate detection from causation: why did it take 14 minutes to notice?",
            "Record what went well; it is the part you want to keep",
            "Every finding must be actionable by someone in the room"
          ],
          "tip": "If a finding cannot be fixed by changing a system, a document, or a default, it is not a finding yet."
        },
        {
          "h": "Structure the document so it survives scrutiny",
          "p": [
            "Impact first, in numbers someone can defend: user-minutes of degradation, requests failed, revenue at risk, and the support tickets that never got answered. Then detection, response, and recovery times as separate numbers, because they have different owners and different fixes. Then a timeline that links to the incident channel, then contributing factors, then action items.",
            "Write contributing factors in the plural. A single root cause is usually a story that stops one question too early, and it hides the second condition that made the first one matter. The format that works reads like a mechanism: a latent condition, a trigger, and a missing barrier. Each of the three is separately fixable, which is why the plural framing produces better action items than a single culprit."
          ],
          "code": "# Incident postmortem: checkout write latency, 2026-03-14\n\n## Impact\n- 41 minutes of degraded checkout; 6.2% of writes failed.\n- 1,930 failed orders; 14 support tickets; no data loss.\n\n## Timeline (UTC)\n- 09:12 deploy api@1.42.3 (index maintenance moved into request path)\n- 09:15 p99 write latency 240 ms -> 2.4 s; alert fired at 09:15:40\n- 09:21 commander declared SEV-2, rollback authorised\n- 09:26 rollback complete; latency normal by 09:31\n\n## Contributing factors\n1. The new index path had no per-index timeout, so one slow index\n   consumed the request budget.\n2. The canary carried 0.5% of traffic, below the rate needed to move\n   the p99 alert inside the 10-minute bake window.\n3. Rollback required the on-call to find the previous image tag by hand.\n\n## What went well\n- Alert fired 40 s after the latency change; rollback decision in 6 min.\n\n## Action items\n| # | Action | Owner | Due | Verified by |\n|---|--------|-------|-----|-------------|\n| 1 | Per-index timeout + shed | mei | 03-21 | load test at 5x index latency |\n| 2 | Canary at 5% for write paths | sam | 03-28 | deploy log shows 5% |\n| 3 | One-command rollback to previous tag | ops | 04-04 | rehearsal in staging |\n",
          "tip": "Publish the postmortem to everyone who was paged; the people who need it most are the ones who were asleep."
        },
        {
          "h": "Action items that ship",
          "p": [
            "Three to five items, each with an owner, a date, and a type: prevent, detect, or mitigate. An item without an owner is a wish, and a list of twelve is a list nobody finishes. Put them in the same backlog with the same priority rules as feature work, because otherwise they lose every planning meeting to a launch and reappear verbatim in the next postmortem.",
            "Every item needs a verification method that is not 'we believe it is done': a load test that reproduces the condition, an alert that fires in staging, a rehearsal with a stopwatch. Review the list two weeks later and ask only one question per item: did the verification run? That single habit is what separates organizations whose incident rate falls from organizations that produce excellent prose about the same failure every quarter."
          ],
          "tip": "Cap the list at five. If everything is an action item, nothing is prioritised, and the review becomes a ritual."
        }
      ],
      "exercise": {
        "prompt": "Write the linter that keeps a postmortem blameless: scan the text for blame language ('human error', 'should have', 'careless', 'forgot to') and print each hit with its line number, so the author rewrites the finding as a system condition.",
        "starter": "const BLAME: &[&str] = &[\n    \"human error\",\n    \"should have\",\n    \"careless\",\n    \"forgot to\",\n    \"did not follow\",\n];\n\nstruct Finding<'a> {\n    line: usize,\n    phrase: &'a str,\n}\n\nfn findings<'a>(text: &'a str) -> Vec<Finding<'a>> {\n    // case-insensitive contains; 1-based line numbers\n    todo!()\n}\n\nfn main() {}",
        "hint": "Lowercase a copy of the text once, but keep byte offsets aligned: to_lowercase can change length for non-ASCII, so lowercase each line instead. For each line, check every phrase and push one Finding per (line, phrase).",
        "solution": "const BLAME: &[&str] = &[\n    \"human error\",\n    \"should have\",\n    \"careless\",\n    \"forgot to\",\n    \"did not follow\",\n];\n\n#[derive(Debug, PartialEq, Eq)]\nstruct Finding<'a> {\n    line: usize,\n    phrase: &'a str,\n}\n\nfn findings<'a>(text: &'a str) -> Vec<Finding<'a>> {\n    let mut total = Vec::new();\n\n    for (index, line) in text.lines().enumerate() {\n        let lowered = line.to_lowercase();\n        for phrase in BLAME {\n            if lowered.contains(phrase) {\n                total.push(Finding { line: index + 1, phrase });\n            }\n        }\n    }\n\n    total\n}\n\nfn main() {\n    let draft = \"## Contributing factors\\n\\n1. Human error: the operator applied the wrong manifest.\\n2. The on-call forgot to check the canary dashboard.\\n3. No per-index timeout existed.\";\n\n    let hits = findings(draft);\n    for finding in &hits {\n        println!(\"line {}: '{}' - rewrite as a system condition\", finding.line, finding.phrase);\n    }\n\n    assert_eq!(hits.len(), 2);\n    assert_eq!(hits[0].line, 3);\n}"
      },
      "questions": [
        {
          "q": "Which finding is actually actionable?",
          "options": [
            "The team needs to be more careful during deploys",
            "Human error caused the deployment of a slow index path",
            "The engineer should have known the index was slow",
            "There was no per-index timeout, so one slow index consumed the request budget"
          ],
          "answer": 3,
          "explain": "It names a missing mechanism that can be added and verified. The others describe people or attitudes, which cannot be tested, reviewed, or rolled back."
        },
        {
          "q": "A postmortem has twelve action items. What is the likely consequence?",
          "options": [
            "Most never ship, because the list has no priority and loses to feature work",
            "The team will need a second postmortem to prioritise the first",
            "The incident will not recur, because coverage is broad",
            "All twelve ship because the list makes ownership explicit"
          ],
          "answer": 0,
          "explain": "Long lists fail predictably: nobody tracks twelve items, and the same findings reappear in the next document. Cap at three to five and verify each one."
        },
        {
          "q": "Why record 'what went well' in a postmortem?",
          "options": [
            "To keep the team's morale up during a difficult review",
            "Because the behaviours that limited impact are the ones you want to institutionalise and protect",
            "Because it balances the document so readers finish it",
            "Because blameless reviews must contain at least one positive statement"
          ],
          "answer": 1,
          "explain": "Fast detection and a clean rollback are real capabilities. Naming them lets you keep the practices that worked when reorganisations and staffing change."
        }
      ],
      "quickbytes": [
        "Replace 'who' with 'what made this easy': missing guardrail, confusing default, absent alert.",
        "Three to five action items, each with owner, date, and a verification that is not a belief.",
        "Review the action list two weeks later and ask one question per item: did the verification run?"
      ],
      "production": [
        "Postmortems are published to everyone affected within five working days, including the timeline.",
        "Impact is expressed in user-minutes and failed transactions, not adjectives.",
        "Action items live in the same backlog as feature work with an owner and a due date.",
        "A two-week follow-up check confirms each item's verification actually ran."
      ],
      "crates": [
        "regex",
        "pulldown-cmark",
        "serde",
        "chrono"
      ],
      "github": [
        {
          "name": "pulldown-cmark - parse postmortem markdown for required sections",
          "url": "https://github.com/pulldown-cmark/pulldown-cmark"
        },
        {
          "name": "regex - blame-language patterns for the postmortem linter",
          "url": "https://github.com/rust-lang/regex"
        }
      ],
      "pitfall": "A postmortem that finds 'process was not followed': the action item becomes a reminder to follow the process, nobody changes the tooling, and the same misstep recurs with a different person.",
      "resources": [
        {
          "title": "Failures and Fixes: how incidents are detected, investigated, mitigated",
          "url": "https://arxiv.org/abs/2008.11192",
          "kind": "paper"
        },
        {
          "title": "FaultProfIT: fault-pattern profiling of incident tickets at scale",
          "url": "https://arxiv.org/abs/2402.17583",
          "kind": "paper"
        },
        {
          "title": "OpenTelemetry traces: the evidence a postmortem cites",
          "url": "https://opentelemetry.io/docs/concepts/signals/traces/",
          "kind": "docs"
        },
        {
          "title": "USENIX Association: SREcon postmortem and reliability talks",
          "url": "https://www.youtube.com/@USENIXorg",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ec07",
      "n": 7,
      "title": "Estimates as ranges: reference class and throughput",
      "minutes": 90,
      "level": "advanced",
      "goal": "Forecast from historical throughput rather than intuition, report a range with a stated confidence level, and explain why the single date you were asked for is the least useful number you can give.",
      "sections": [
        {
          "h": "Why the single date is the wrong product",
          "p": [
            "A point estimate is a promise about the future made by someone with no distribution. The inside view reasons forward from the plan and quietly assumes nothing unknown will happen, which is why it is systematically early. The outside view asks a different question: how long did the last eight comparable items actually take, from start to merged and deployed? That question has data behind it, and the data already contains the interruptions you cannot foresee.",
            "Base-rate neglect is the mechanism, and it is well documented in project research: teams anchor on the specifics of this feature and ignore the distribution of everything similar they have done. The biases inventory from that literature, and the outside-view procedure for due diligence, are both worth reading before the next planning round, not after the next slip."
          ],
          "list": [
            "Ask 'when will it be done' and 'how much work is it' as separate questions",
            "Most date slippage is queueing, not effort: measure WIP and cycle time",
            "Report P50 and P85, with the sample the numbers came from",
            "Re-forecast from the same data weekly; do not substitute a new gut feel"
          ],
          "tip": "If you are asked for one date, give the P85 and say what the P50 is; the gap is the honest part."
        },
        {
          "h": "Forecast by simulating throughput",
          "p": [
            "Count items completed per week over the last eight to twelve weeks. Then simulate: repeatedly pick a week's throughput at random, subtract it from the remaining backlog, and record how many weeks it took. Run that ten thousand times and read the percentiles off the resulting distribution. This is a Monte Carlo forecast from your own delivery history, and it needs no estimate for any individual item.",
            "Two properties make it credible. First, it inherits the variation you actually experience, including the week someone was on call and the week a dependency broke. Second, it is cheap to update: a new week of data is one more number, so the forecast improves weekly instead of being renegotiated. Little's law connects the same numbers the other way: average WIP equals throughput times average cycle time, so a team that starts more work without raising throughput is choosing longer cycle time."
          ],
          "code": "/// Deterministic throughput simulation: no RNG dependency, reproducible.\npub struct Forecast {\n    pub p50_weeks: f64,\n    pub p85_weeks: f64,\n    pub p95_weeks: f64,\n}\n\npub fn forecast(backlog_items: usize, weekly_throughput: &[usize], runs: usize) -> Forecast {\n    assert!(!weekly_throughput.is_empty(), \"need at least one week of history\");\n    let mut state: u64 = 0x5DEE_CE66_D1CE_1234; // any fixed seed: reproducible beats random here\n    let mut finishes = Vec::with_capacity(runs);\n\n    for _ in 0..runs {\n        let mut remaining = backlog_items;\n        let mut weeks = 0usize;\n        while remaining > 0 {\n            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);\n            let pick = (state >> 33) as usize % weekly_throughput.len();\n            // A zero-throughput week is real history, keep it: the simulation\n            // must be allowed to model a week where nothing shipped.\n            remaining = remaining.saturating_sub(weekly_throughput[pick]);\n            weeks += 1;\n        }\n        finishes.push(weeks);\n    }\n\n    finishes.sort_unstable();\n    Forecast {\n        p50_weeks: percentile(&finishes, 0.50),\n        p85_weeks: percentile(&finishes, 0.85),\n        p95_weeks: percentile(&finishes, 0.95),\n    }\n}\n\nfn percentile(sorted: &[usize], q: f64) -> f64 {\n    let rank = (q * (sorted.len() - 1) as f64).round() as usize;\n    sorted[rank] as f64\n}",
          "tip": "Include the zero-throughput weeks in the sample. Dropping them is how a forecast becomes a wish."
        },
        {
          "h": "Report it so it can be used",
          "p": [
            "Give the range, the confidence, the sample, and the assumption: '20 items, 8 weeks of history averaging 3.1 items per week, P85 is 9 weeks'. Then commit to the P85 as the plan and name the P50 as the expectation, because a plan at P50 is a coin flip. When a stakeholder needs an earlier date, the conversation becomes concrete: what would have to be true, which is either more throughput or a smaller backlog.",
            "The failure mode to avoid is adding a buffer to each task and calling the sum a range. Buffers per task get consumed by the first task that overruns and are invisible afterwards, so the sum is as wrong as the original point estimate, only later. A distribution over completion, refreshed weekly, is a different kind of object: it degrades gracefully when you are wrong, and it tells you when your throughput assumption has broken."
          ],
          "list": [
            "Publish the sample and the window with every forecast",
            "Commit to P85 for external dates and P50 for internal expectations",
            "Re-run the simulation weekly; a widening P85 is the early warning",
            "Never trade a smaller backlog for the same date without removing scope explicitly"
          ],
          "tip": "A forecast without its sample is a guess with a decimal point."
        }
      ],
      "exercise": {
        "prompt": "Implement throughput forecasting: given weekly completed-item counts and a backlog size, simulate completion 10,000 times with a deterministic generator and return P50, P85, and P95 in weeks. Then show that one zero-throughput week moves the P85.",
        "starter": "pub struct Forecast { pub p50: usize, pub p85: usize, pub p95: usize }\n\npub fn forecast(backlog: usize, weekly: &[usize], runs: usize) -> Forecast {\n    // deterministic LCG, pick a week's throughput each iteration\n    // a week may deliver 0 items; the loop must still terminate\n    todo!()\n}\n\nfn percentile(sorted: &[usize], q: f64) -> usize {\n    let rank = (q * (sorted.len() - 1) as f64).round() as usize;\n    sorted[rank]\n}\n\nfn main() {}",
        "hint": "Use state = state * 6364136223846793005 + 1442695040888963407 with wrapping ops, take (state >> 33) % weekly.len() as the index, and remaining = remaining.saturating_sub(pick) so a zero-delivery week cannot loop forever.",
        "solution": "pub struct Forecast { pub p50: usize, pub p85: usize, pub p95: usize }\n\npub fn forecast(backlog: usize, weekly: &[usize], runs: usize) -> Forecast {\n    assert!(!weekly.is_empty(), \"need at least one week of history\");\n\n    let mut state: u64 = 0x5DEE_CE66_D1CE_1234;\n    let mut finishes = Vec::with_capacity(runs);\n\n    for _ in 0..runs {\n        let mut remaining = backlog;\n        let mut weeks = 0usize;\n\n        while remaining > 0 {\n            state = state\n                .wrapping_mul(6364136223846793005)\n                .wrapping_add(1442695040888963407);\n            let pick = (state >> 33) as usize % weekly.len();\n            remaining = remaining.saturating_sub(weekly[pick]);\n            weeks += 1;\n        }\n\n        finishes.push(weeks);\n    }\n\n    finishes.sort_unstable();\n\n    Forecast {\n        p50: percentile(&finishes, 0.50),\n        p85: percentile(&finishes, 0.85),\n        p95: percentile(&finishes, 0.95),\n    }\n}\n\nfn percentile(sorted: &[usize], q: f64) -> usize {\n    let rank = (q * (sorted.len() - 1) as f64).round() as usize;\n    sorted[rank]\n}\n\nfn main() {\n    let healthy = [4, 3, 5, 3, 4, 2, 5, 4];\n    let with_stall = [4, 3, 5, 0, 4, 2, 5, 4];\n    let backlog = 24;\n\n    let a = forecast(backlog, &healthy, 10_000);\n    let b = forecast(backlog, &with_stall, 10_000);\n\n    println!(\"healthy:   p50 {} p85 {} p95 {}\", a.p50, a.p85, a.p95);\n    println!(\"one stall: p50 {} p85 {} p95 {}\", b.p50, b.p85, b.p95);\n    assert!(b.p85 >= a.p85, \"a stalled week cannot improve the P85\");\n}"
      },
      "questions": [
        {
          "q": "Why does the outside view produce better forecasts than decomposing the work?",
          "options": [
            "Because stakeholders trust historical data more than estimates",
            "Because decomposition takes too long to be useful in planning",
            "Because past comparable items already contain the interruptions and unknowns that the plan silently assumes away",
            "Because engineers are unable to estimate individual tasks accurately"
          ],
          "answer": 2,
          "explain": "The distribution of past delivery already includes sick days, dependency delays, and rework. Decomposition reasons forward from an idealised sequence and systematically omits exactly those."
        },
        {
          "q": "Your team has stable throughput and takes on a second project without adding people. What does Little's law predict?",
          "options": [
            "Throughput rises because parallelism improves",
            "WIP falls because the backlog is prioritised more aggressively",
            "Cycle time stays the same because throughput is unchanged",
            "Cycle time rises, because the same throughput now serves more work in progress"
          ],
          "answer": 3,
          "explain": "Average cycle time equals WIP divided by throughput. Adding work in progress at fixed throughput lengthens every item's cycle time, which is why starting more work rarely finishes more work."
        },
        {
          "q": "Which is the honest way to present a forecast you will be held to?",
          "options": [
            "P85 with the sample and window it came from, plus the throughput assumption",
            "The earliest plausible date, so the team looks ambitious and can explain slippage later",
            "A single date with an implicit buffer baked into each task",
            "P50 as the date, because half the time you will beat it"
          ],
          "answer": 0,
          "explain": "A defensible forecast carries its evidence. The P85 gives an 85% chance of meeting the date, and the sample lets the reader judge whether your history is relevant to their case."
        }
      ],
      "quickbytes": [
        "Collect weekly throughput, not story points; the simulation only needs counts of finished items.",
        "Report P85 with the sample window and assumption; a date without its distribution is a guess.",
        "A widening P85 week over week is the earliest signal that the plan, not the estimate, is wrong."
      ],
      "production": [
        "Weekly completed-item counts are recorded automatically from the tracker, not reconstructed at planning time.",
        "Every external date is quoted at P85 with the sample and window stated alongside it.",
        "WIP is capped per team so cycle time stays predictable when priorities change.",
        "Forecasts are re-run weekly and the trend, not just the number, is reviewed."
      ],
      "crates": [
        "chrono",
        "serde",
        "serde_json",
        "clap"
      ],
      "github": [
        {
          "name": "chrono - date arithmetic for forecast windows",
          "url": "https://github.com/chronotope/chrono"
        },
        {
          "name": "serde - persist throughput history alongside the forecast",
          "url": "https://github.com/serde-rs/serde"
        }
      ],
      "pitfall": "Padding every task estimate and calling the total a range: the first overrun consumes the padding silently, the sum stays as wrong as the original point estimate, and nobody can see it happen.",
      "resources": [
        {
          "title": "Quality Control and Due Diligence in Project Management: taking the outside view",
          "url": "https://arxiv.org/abs/1302.2544",
          "kind": "paper"
        },
        {
          "title": "Top Ten Behavioral Biases in Project Management (base-rate neglect, planning fallacy)",
          "url": "https://arxiv.org/abs/2202.00125",
          "kind": "paper"
        },
        {
          "title": "hdrhistogram: measuring the distribution of real durations instead of averages",
          "url": "https://docs.rs/hdrhistogram/latest/hdrhistogram/",
          "kind": "docs"
        },
        {
          "title": "Google Tech Talks: estimation, forecasting, and measurement talks",
          "url": "https://www.youtube.com/@GoogleTechTalks",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ec08",
      "n": 8,
      "title": "Technical writing a busy reader finishes",
      "minutes": 60,
      "level": "core",
      "goal": "Structure a document so a decision-maker can act on it in two minutes, and write rustdoc, commit messages, and pull request descriptions that answer why before what.",
      "sections": [
        {
          "h": "Bottom line first, evidence second",
          "p": [
            "The reader is either a decision-maker with ninety seconds or a reviewer with a queue of eleven pull requests. Put the ask, the recommendation, and the cost in the first three sentences, then the evidence that supports them, then the detail for whoever implements it. This is the inverted pyramid, and it exists because readers abandon documents at the point where the value stops being obvious.",
            "One idea per paragraph. Concrete nouns, numbers with units, dates with years. 'Latency improved' is not a claim; 'p99 write latency fell from 240 ms to 90 ms over 14 days at 2.1k writes per second' is one, and it can be checked. Passive voice hides who decided, which is precisely the information a decision record exists to preserve."
          ],
          "list": [
            "First three sentences: the ask, the recommendation, the cost",
            "Every claim gets a number, a unit, and a source",
            "One idea per paragraph; a heading per idea is better",
            "Name the decider and the date in the document, not in a follow-up thread"
          ],
          "tip": "Read your first paragraph aloud; if it takes more than fifteen seconds, the document is upside down."
        },
        {
          "h": "Rustdoc is documentation with a compiler attached",
          "p": [
            "The first line of a doc comment is the summary shown in search results and re-export lists, so it has to stand alone as a sentence. The sections that carry weight are Examples, Errors, Panics, and Safety. Clippy's missing_errors_doc and missing_panics_doc lints enforce the middle two, which makes them the cheapest documentation quality gate available in the ecosystem.",
            "Doctests are why rustdoc stays honest: they compile and run under cargo test, so an example that stops working fails CI. Write the example you would want as a user of the function, not the one that demonstrates every field of every struct. A single realistic call with an assertion teaches more than a full constructor dump."
          ],
          "code": "/// Splits a batch into chunks no larger than the backend's statement limit.\n///\n/// # Examples\n///\n/// ```\n/// let rows: Vec<u32> = (1..=7).collect();\n/// let chunks = rust_academy::chunk_rows(&rows, 3);\n/// assert_eq!(chunks.len(), 3);\n/// assert_eq!(chunks[2], vec![7]);\n/// ```\n///\n/// # Errors\n///\n/// Returns [`ChunkError::Empty`] when `rows` is empty and\n/// [`ChunkError::LimitTooLarge`] when `limit` exceeds `MAX_BIND_PARAMS`.\n///\n/// # Panics\n///\n/// Never panics: the input length is checked before slicing.\npub fn chunk_rows<T: Clone>(rows: &[T], limit: usize) -> Result<Vec<Vec<T>>, ChunkError>",
          "tip": "If the first line needs the signature to make sense, it is not a summary."
        },
        {
          "h": "Commits and pull request descriptions",
          "p": [
            "A commit subject is imperative, specific, and under about 72 characters; the body explains why the change is needed, what was rejected, and what the reviewer should look at hardest. The kernel's submitting-patches guide is the best long-form statement of the norm: one logical change per patch, describe the user-visible impact, and do not bury the reasoning in a mailing list thread that nobody will find in two years.",
            "A pull request description is the review's table of contents: what changed, why now, how to verify, and what you are unsure about. The last section is the highest-value line in the document, because it aims the reviewer's attention at the risk instead of at the diff's line count. Reviewers who are told where to look find more, and authors who name their own uncertainty get better design feedback."
          ],
          "tip": "The 'what I am unsure about' paragraph is what turns a review from approval into a design conversation."
        }
      ],
      "exercise": {
        "prompt": "Document a fallible function the way rustdoc rewards: one-sentence summary, an Examples section whose doctest compiles and asserts, and Errors and Panics sections that name the actual conditions.",
        "starter": "// Write the doc comment for this function, then make the example a doctest.\n//\n// fn retry_delay(attempt: u32, base: std::time::Duration) -> Result<std::time::Duration, RetryError>\n//\n// Rules: delay = base * 2^attempt, capped at 30 s; attempt 0 is valid;\n// attempt > 10 returns RetryError::Exhausted; the base must be non-zero.\n\n#[derive(Debug, PartialEq, Eq)]\npub enum RetryError {\n    Exhausted { attempt: u32 },\n    ZeroBase,\n}\n\nfn main() {\n    // 1. write the doc comment above the function\n    // 2. add an Examples section with a doctest\n    // 3. keep the summary to one sentence\n}",
        "hint": "Summary first, then a blank /// line, then # Examples with a fenced block and an assert_eq. # Errors names Exhausted and ZeroBase, # Panics says it never panics. Run cargo test --doc to prove the example.",
        "solution": "//! Retry helpers used by the ingestion client.\n\nuse std::time::Duration;\n\n#[derive(Debug, PartialEq, Eq)]\npub enum RetryError {\n    Exhausted { attempt: u32 },\n    ZeroBase,\n}\n\n/// Returns the exponential backoff delay for `attempt`, capped at 30 seconds.\n///\n/// # Examples\n///\n/// ```\n/// use std::time::Duration;\n/// # use retry_doc::retry_delay;\n/// assert_eq!(retry_delay(0, Duration::from_millis(100)), Ok(Duration::from_millis(100)));\n/// assert_eq!(retry_delay(2, Duration::from_millis(100)), Ok(Duration::from_millis(400)));\n/// assert_eq!(retry_delay(20, Duration::from_millis(100)), Err(retry_doc::RetryError::Exhausted { attempt: 20 }));\n/// ```\n///\n/// # Errors\n///\n/// Returns [`RetryError::ZeroBase`] when `base` is zero, because every delay\n/// would collapse to zero and the retry loop would spin.\n/// Returns [`RetryError::Exhausted`] when `attempt` exceeds 10.\n///\n/// # Panics\n///\n/// Never panics. The exponent is bounded before shifting, so the\n/// multiplication cannot overflow.\npub fn retry_delay(attempt: u32, base: Duration) -> Result<Duration, RetryError> {\n    if base.is_zero() {\n        return Err(RetryError::ZeroBase);\n    }\n    if attempt > 10 {\n        return Err(RetryError::Exhausted { attempt });\n    }\n\n    let millis = base.as_millis().saturating_mul(1u128 << attempt);\n    Ok(Duration::from_millis(millis.min(30_000) as u64))\n}\n\nfn main() {\n    assert_eq!(retry_delay(0, Duration::from_millis(100)), Ok(Duration::from_millis(100)));\n    assert_eq!(retry_delay(3, Duration::from_millis(100)), Ok(Duration::from_millis(800)));\n    assert_eq!(retry_delay(10, Duration::from_millis(100)), Ok(Duration::from_millis(30_000)));\n    assert_eq!(retry_delay(11, Duration::from_millis(100)), Err(RetryError::Exhausted { attempt: 11 }));\n    assert_eq!(retry_delay(1, Duration::ZERO), Err(RetryError::ZeroBase));\n    println!(\"retry_delay: all assertions passed\");\n}"
      },
      "questions": [
        {
          "q": "A design document opens with four paragraphs of background and states the recommendation on page two. What is the primary cost?",
          "options": [
            "The document looks less rigorous to senior engineers",
            "Deciders stop reading before the ask, so the decision moves to a meeting with worse information",
            "The background section will go stale faster than the recommendation",
            "Reviewers cannot comment on individual paragraphs"
          ],
          "answer": 1,
          "explain": "Attention is the scarce input. If the ask is not in the first screen, the decision happens verbally, without the evidence you wrote down, and the document becomes an appendix nobody cites."
        },
        {
          "q": "Which doc-comment first line is correct for a function returning a Result?",
          "options": [
            "This function is used by the ingestion client to compute delays between retries",
            "Returns a Result of Duration or RetryError",
            "Returns the exponential backoff delay for an attempt, capped at 30 seconds",
            "Backoff delay."
          ],
          "answer": 2,
          "explain": "The summary describes what the caller gets, in one standalone sentence, and mentions the cap that callers care about. Restating the return type wastes the only line most readers see."
        },
        {
          "q": "Why does a doctest beat an example in a README for a library function?",
          "options": [
            "Because doctests can access private items",
            "Because README examples cannot be versioned",
            "Because rustdoc renders doctests more prominently",
            "Because the doctest compiles and runs in CI, so a stale example breaks the build instead of misleading a user"
          ],
          "answer": 3,
          "explain": "Executability is the forcing function. A README snippet is prose that can drift silently; a doctest is a test, and tests fail loudly."
        }
      ],
      "quickbytes": [
        "First three sentences: ask, recommendation, cost. Everything after that is support.",
        "Every number gets a unit and a window; 'faster' is not a measurement.",
        "Write the pull request's 'what I am unsure about' paragraph before requesting review."
      ],
      "production": [
        "Library crates enable missing_docs, missing_errors_doc, and missing_panics_doc as warnings at minimum.",
        "Doctests run in CI on every pull request, not only on release branches.",
        "Commit subjects are imperative and under 72 characters; the body carries the why.",
        "Design documents put the ask and the recommendation in the first paragraph."
      ],
      "crates": [
        "doc-comment",
        "pulldown-cmark",
        "trybuild",
        "anyhow"
      ],
      "github": [
        {
          "name": "dtolnay/trybuild - pin the examples that must stop compiling",
          "url": "https://github.com/dtolnay/trybuild"
        },
        {
          "name": "pulldown-cmark - render the documentation you ship",
          "url": "https://github.com/pulldown-cmark/pulldown-cmark"
        }
      ],
      "pitfall": "Documentation that restates the signature: 'returns the delay' above fn retry_delay. It passes a doc lint, teaches nothing, and hides the fact that nobody wrote down the cap, the errors, or the panic behaviour.",
      "resources": [
        {
          "title": "rustdoc: how to write documentation",
          "url": "https://doc.rust-lang.org/rustdoc/how-to-write-documentation.html",
          "kind": "docs"
        },
        {
          "title": "rustdoc: documentation tests",
          "url": "https://doc.rust-lang.org/rustdoc/documentation-tests.html",
          "kind": "docs"
        },
        {
          "title": "Linux kernel: submitting patches and describing changes",
          "url": "https://docs.kernel.org/process/submitting-patches.html",
          "kind": "docs"
        },
        {
          "title": "GOTO Conferences: technical communication and design writing talks",
          "url": "https://www.youtube.com/@GOTO-",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ec09",
      "n": 9,
      "title": "Documentation that fails the build when stale",
      "minutes": 90,
      "level": "advanced",
      "goal": "Make documentation executable or mechanically checked, so drift breaks CI instead of quietly misleading the next on-call engineer at 03:00.",
      "sections": [
        {
          "h": "Docs decay because nothing fails when they are wrong",
          "p": [
            "Prose has no compiler. Every fact duplicated in a README is a fact that will diverge from the code, and the only open question is whether anyone notices before it costs an hour. Three mechanisms keep documentation honest: generate what can be generated, test what can be tested, and delete what has neither an owner nor a test.",
            "Location matters as much as content. Documentation in the repository next to the code gets reviewed in the same pull request, has a diff, and has a blame history. A wiki page has none of those, which is why wikis become archaeology: carefully written, confidently wrong, and nobody knows which parts are current."
          ],
          "list": [
            "Generated: reference docs, config tables, CLI help, OpenAPI from types",
            "Tested: doctests, mdbook test, trybuild snippets, link checks",
            "Owned: a named team and a trigger that forces a re-read",
            "Deleted: anything with none of the above"
          ],
          "tip": "A doc with no owner and no test is not documentation; it is a rumour with formatting."
        },
        {
          "h": "Make the documentation executable",
          "p": [
            "Doctests run under cargo test, mdbook test compiles the code blocks in a book, and trybuild pins compiler error messages so a refactor that changes diagnostics is visible. The strongest move is include_str: make the crate-level docs literally the README, and the README's examples become doctests. One source, two audiences, and no drift possible.",
            "Broken intra-doc links are the other silent decay channel: rename a type and every 'see also' link rots. deny(rustdoc::broken_intra_doc_links) turns that into a build failure, which is worth more than any documentation style guide because it fires on the exact commit that caused the rot rather than in a quarterly audit."
          ],
          "code": "// src/lib.rs\n#![doc = include_str!(\"../README.md\")]\n#![deny(rustdoc::broken_intra_doc_links)]\n#![deny(rustdoc::invalid_html_tags)]\n#![warn(missing_docs)]\n\n//! Implementation notes that should not be in the README.\n//!\n//! The README is the front door: install, first call, and the two\n//! error variants people actually hit. Everything below that line\n//! lives here, where it is versioned with the code.\n\nmod client;\npub use client::{Client, ClientError};\n\n// CI, in the same job that runs the tests:\n// cargo test --doc --all-features\n// RUSTDOCFLAGS=\"-D warnings\" cargo doc --no-deps\n// mdbook test docs",
          "tip": "include_str the README and its code fences become doctests: the fastest way to stop two copies of the install instructions from disagreeing."
        },
        {
          "h": "Ownership, triggers, and deletion",
          "p": [
            "Every durable document needs an owner and a trigger. A runbook's owner is the on-call rota and its trigger is a deploy that changes the failure modes. An architecture page's owner is the team and its trigger is an accepted ADR. An onboarding page's owner is the most recent person onboarded, because they are the only one who remembers what was confusing.",
            "Then delete. A stale document is worse than a missing one because it is trusted: the missing document sends someone to ask, while the stale one sends them confidently into the wrong procedure. When a page has no owner, no test, and no trigger, move the parts that matter into an ADR or a comment and remove the rest. Documentation that cannot be maintained is a liability with a URL."
          ],
          "tip": "Give every runbook a 'last verified' line with a date and a name; anything older than two quarters gets re-read or deleted."
        }
      ],
      "exercise": {
        "prompt": "Write the link checker that keeps intra-doc links honest: extract every [text](target) from a set of markdown files, and report a broken link when a relative target does not resolve to a known file.",
        "starter": "use std::collections::HashSet;\n\nstruct Broken<'a> { file: &'a str, line: usize, target: &'a str }\n\nfn check<'a>(files: &[(&'a str, &'a str)], known: &HashSet<&str>) -> Vec<Broken<'a>> {\n    // 1. find [text](target) on each line\n    // 2. skip absolute http(s) targets\n    // 3. a target with a #fragment is checked on the path part only\n    todo!()\n}\n\nfn main() {}",
        "hint": "Find the '(' after '](' and the matching ')'. Split the target on '#' with .split_once('#') and keep the first part. Treat an empty path (pure fragment) as fine. Report the line number where the link starts.",
        "solution": "use std::collections::HashSet;\n\n#[derive(Debug, PartialEq, Eq)]\nstruct Broken<'a> {\n    file: &'a str,\n    line: usize,\n    target: &'a str,\n}\n\nfn check<'a>(files: &[(&'a str, &'a str)], known: &HashSet<&str>) -> Vec<Broken<'a>> {\n    let mut broken = Vec::new();\n\n    for (name, text) in files {\n        for (index, line) in text.lines().enumerate() {\n            let mut rest = line;\n            while let Some(open) = rest.find(\"](\") {\n                let after = &rest[open + 2..];\n                let Some(close) = after.find(')') else { break };\n                let target = &after[..close];\n                rest = &after[close + 1..];\n\n                if target.starts_with(\"http://\") || target.starts_with(\"https://\") || target.starts_with(\"mailto:\") {\n                    continue;\n                }\n\n                let path = target.split_once('#').map(|(path, _)| path).unwrap_or(target);\n                if path.is_empty() {\n                    continue;\n                }\n\n                if !known.contains(path) {\n                    broken.push(Broken { file: name, line: index + 1, target });\n                }\n            }\n        }\n    }\n\n    broken\n}\n\nfn main() {\n    let known: HashSet<&str> = [\"docs/adr/0007.md\", \"README.md\"].into_iter().collect();\n    let files = [\n        (\"README.md\", \"See [the ADR](docs/adr/0007.md#decision) and [gone](docs/adr/0001.md).\"),\n        (\"docs/adr/0007.md\", \"Back to [readme](README.md).\"),\n    ];\n\n    let broken = check(&files, &known);\n    assert_eq!(broken.len(), 1);\n    assert_eq!(broken[0].target, \"docs/adr/0001.md\");\n    println!(\"broken links: {broken:?}\");\n}"
      },
      "questions": [
        {
          "q": "Why is include_str! of the README into the crate docs stronger than copying the text?",
          "options": [
            "There is one copy, and its code fences run as doctests, so drift breaks the build",
            "It allows the README to use private items in examples",
            "It keeps the README out of the repository",
            "It renders faster in rustdoc because the text is embedded"
          ],
          "answer": 0,
          "explain": "Duplication is the root cause of stale docs. A single embedded copy removes the divergence, and doctests turn the examples into tests that fail when the API changes."
        },
        {
          "q": "A runbook page has no owner and no test. What is the correct disposition?",
          "options": [
            "Leave it in place, since deleting information is risky",
            "Move the parts that matter into a tested artifact or an ADR and delete the rest",
            "Add a warning banner saying the page may be outdated",
            "Move it to the wiki so the repository stays clean"
          ],
          "answer": 1,
          "explain": "Unowned prose is unfalsifiable and trusted. Salvage what has value into something owned and checked; a banner is an admission that nobody will fix it, and moving it to a wiki removes the reviewer."
        },
        {
          "q": "Which check catches a renamed type breaking every 'see also' link?",
          "options": [
            "missing_docs",
            "cargo test --doc",
            "rustdoc::broken_intra_doc_links denied in CI",
            "cargo clippy -- -D warnings"
          ],
          "answer": 2,
          "explain": "Intra-doc links are resolved by rustdoc, so the lint fires on the commit that breaks them. missing_docs only notices absent documentation, and doctests only run code fences."
        }
      ],
      "quickbytes": [
        "cargo test --doc in CI turns examples into tests; do it before writing a style guide.",
        "deny(rustdoc::broken_intra_doc_links) makes renames break the build instead of the reader.",
        "Every runbook carries a last-verified date and a name; re-read or delete after two quarters."
      ],
      "production": [
        "CI runs cargo test --doc, RUSTDOCFLAGS=-D warnings cargo doc --no-deps, and mdbook test.",
        "The crate-level docs embed the README so there is exactly one install instruction.",
        "Every runbook names an owner and carries a last-verified date.",
        "Documentation older than two quarters without an owner is deleted or converted into a tested artifact."
      ],
      "crates": [
        "mdbook",
        "pulldown-cmark",
        "trybuild",
        "anyhow"
      ],
      "github": [
        {
          "name": "rust-lang/mdBook - books whose code blocks are tested",
          "url": "https://github.com/rust-lang/mdBook"
        },
        {
          "name": "pulldown-cmark - parse markdown to check links and headings",
          "url": "https://github.com/pulldown-cmark/pulldown-cmark"
        }
      ],
      "pitfall": "A wiki page with the production runbook: the deploy changes the procedure, nobody edits the page, and the next incident is resolved using a command that no longer exists.",
      "resources": [
        {
          "title": "mdbook crate documentation: build and test a book",
          "url": "https://docs.rs/mdbook/latest/mdbook/",
          "kind": "docs"
        },
        {
          "title": "rustdoc: documentation tests as executable examples",
          "url": "https://doc.rust-lang.org/rustdoc/documentation-tests.html",
          "kind": "docs"
        },
        {
          "title": "rust-lang/mdBook: the tool behind the Rust Book",
          "url": "https://github.com/rust-lang/mdBook",
          "kind": "repo"
        },
        {
          "title": "pulldown-cmark: a pull parser for CommonMark in Rust",
          "url": "https://github.com/pulldown-cmark/pulldown-cmark",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "ec10",
      "n": 10,
      "title": "Onboarding as a product: first PR in week one",
      "minutes": 60,
      "level": "core",
      "goal": "Design an onboarding path with observable gates, remove the single-person dependency from it, and mentor by transferring context and scope rather than by assigning tickets.",
      "sections": [
        {
          "h": "Every question asked twice is a missing artifact",
          "p": [
            "Onboarding is the highest-leverage documentation a team writes, because its bugs are paid for by every new person, forever. The signal is simple: if two people ask how to run the integration tests, the answer belongs in a script, a make target, or a docs page, not in the memory of whoever happened to be online. Fixing the artifact is cheaper than the third answer.",
            "Gates beat impressions. Day one: the environment builds and the test suite passes locally. Week one: one small change merged and deployed to production. Week two: on-call shadow. Month one: ownership of a component. Each gate is observable, so you can tell whether onboarding works instead of whether the new person seems happy, and each one has a named owner who is expected to unblock it."
          ],
          "list": [
            "Day 1: clone, build, test, and run the service locally with one command",
            "Week 1: a real change merged and deployed, reviewed by a mentor",
            "Week 2: on-call shadow, then a debrief on what was confusing",
            "Month 1: named owner of one component, with review support"
          ],
          "tip": "The first task should require reading three modules and changing two, not reading everything."
        },
        {
          "h": "Mentoring transfers context, not tickets",
          "p": [
            "A mentor hands over the why: why the architecture looks like this, which decisions were contested, what the team tried and abandoned. The compressed history already exists in the ADRs and postmortems, so the mentor's first act is to point at them with a specific question to answer, not to schedule a two-hour tour of the codebase.",
            "Then hand over scope. A newcomer who only ever fixes lint warnings learns that they are not trusted; a newcomer who owns a small feature end to end learns the deploy path, the review norms, and the on-call implications in one cycle. Review their pull requests with questions for the first few, then move to approving with comments, then to being reviewed by them, which is the point at which the transfer is complete."
          ],
          "code": "use cargo_metadata::MetadataCommand;\nuse std::path::Path;\nuse walkdir::WalkDir;\n\n/// Finds the highest-signal first tasks in a workspace: crates with no\n/// description, no documentation, or a TODO marker in their source.\n///\n/// The output is deliberately boring: a newcomer should be able to finish\n/// one item in a day and ship it through the whole pipeline.\npub fn first_tasks() -> Result<Vec<(String, u8)>, Box<dyn std::error::Error>> {\n    let metadata = MetadataCommand::new().no_deps().exec()?;\n    let mut scored = Vec::new();\n\n    for package in &metadata.packages {\n        let mut score = 0u8;\n        if package.description.is_none() {\n            score += 3; // cheapest, most visible, teaches the doc conventions\n        }\n        if !package.manifest_path.as_std_path().exists() {\n            continue;\n        }\n        let dir = package.manifest_path.as_std_path().parent().unwrap();\n        let documented = std::fs::read_to_string(dir.join(\"src/lib.rs\"))\n            .map(|text| text.contains(\"//!\"))\n            .unwrap_or(false);\n        if !documented {\n            score += 2;\n        }\n        if todo_count(dir) > 0 {\n            score += 1;\n        }\n        if score > 0 {\n            scored.push((package.name.to_string(), score));\n        }\n    }\n\n    scored.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));\n    Ok(scored)\n}\n\nfn todo_count(dir: &Path) -> usize {\n    WalkDir::new(dir)\n        .into_iter()\n        .filter_map(Result::ok)\n        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == \"rs\"))\n        .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())\n        .map(|text| text.matches(\"TODO\").count())\n        .sum()\n}",
          "tip": "A good first task is finished in a day, touches the real pipeline, and cannot break production."
        },
        {
          "h": "Make the transfer visible so it survives turnover",
          "p": [
            "Sponsorship matters more than advice. Naming someone as the author of a design review, or handing them the RFC to drive, changes what other people expect of them; an hour of career advice does not. Keep a first-timer slot in each design review and rotate who presents, because the person who presents learns the reasoning and the room learns a name.",
            "Measure the things that predict retention and bus factor: time to first merged pull request, time to first on-call shift, documents created by newcomers in month one, and who reviews whom. If the review graph has one node with most of the edges, the onboarding worked for the team's throughput and failed for its resilience, and the next resignation will show you the bill."
          ],
          "tip": "Count reviews per reviewer per quarter; a single dominant reviewer is a bus-factor finding, not a compliment."
        }
      ],
      "exercise": {
        "prompt": "Rank candidate first tasks for a newcomer: score missing crate descriptions highest, then missing docs, then TODO count, and return the top three with a stable tie-break so two runs agree.",
        "starter": "struct Crate {\n    name: &'static str,\n    has_description: bool,\n    has_crate_docs: bool,\n    todos: u32,\n}\n\nfn first_tasks(crates: &[Crate], take: usize) -> Vec<(&'static str, u32)> {\n    // score: description 3, docs 2, each TODO 1 (cap the TODO part at 3)\n    // sort by score descending, then name ascending\n    todo!()\n}\n\nfn main() {}",
        "hint": "Compute (score, name) into a Vec, then sort_by with b.score.cmp(&a.score).then_with(|| a.name.cmp(b.name)). Truncate to take after sorting, not before.",
        "solution": "struct Crate {\n    name: &'static str,\n    has_description: bool,\n    has_crate_docs: bool,\n    todos: u32,\n}\n\nfn score(crate_: &Crate) -> u32 {\n    let mut total = 0;\n    if !crate_.has_description {\n        total += 3;\n    }\n    if !crate_.has_crate_docs {\n        total += 2;\n    }\n    total + crate_.todos.min(3)\n}\n\nfn first_tasks(crates: &[Crate], take: usize) -> Vec<(&'static str, u32)> {\n    let mut scored: Vec<(&'static str, u32)> = crates\n        .iter()\n        .map(|crate_| (crate_.name, score(crate_)))\n        .filter(|(_, total)| *total > 0)\n        .collect();\n\n    scored.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));\n    scored.truncate(take);\n    scored\n}\n\nfn main() {\n    let crates = [\n        Crate { name: \"billing\", has_description: false, has_crate_docs: true, todos: 0 },\n        Crate { name: \"search\", has_description: true, has_crate_docs: true, todos: 4 },\n        Crate { name: \"audit\", has_description: true, has_crate_docs: false, todos: 1 },\n        Crate { name: \"telemetry\", has_description: true, has_crate_docs: true, todos: 0 },\n    ];\n\n    let tasks = first_tasks(&crates, 3);\n    assert_eq!(tasks[0], (\"audit\", 3));\n    assert_eq!(tasks[1], (\"billing\", 3));\n    assert_eq!(tasks[2], (\"search\", 3));\n    assert!(tasks.iter().all(|(name, _)| *name != \"telemetry\"));\n    println!(\"first tasks: {tasks:?}\");\n}"
      },
      "questions": [
        {
          "q": "Two new engineers in a row ask how to run the integration tests. What is the highest-leverage response?",
          "options": [
            "Add it to the onboarding slide deck presented monthly",
            "Assign the next newcomer to document it after they learn",
            "Answer both, since mentoring is part of senior work",
            "Write the answer into the repository as a script or doc, and point the next person there"
          ],
          "answer": 3,
          "explain": "A repeated question is a missing artifact. Answering twice is generous and unscalable; the script or doc fixes it for everyone after, and becomes reviewable as the system changes."
        },
        {
          "q": "Which onboarding gate is the strongest evidence that someone can work independently?",
          "options": [
            "They have a change merged and deployed through the normal pipeline",
            "They have attended three design reviews",
            "They have set up the development environment",
            "They have read the architecture documentation"
          ],
          "answer": 0,
          "explain": "A merged, deployed change exercises the whole system: build, review norms, CI, deploy, and rollback. Reading and attending are inputs; shipping is the observable gate."
        },
        {
          "q": "The review graph shows one engineer reviewing 60% of all pull requests. What does that indicate?",
          "options": [
            "That engineer is the strongest reviewer and should keep the load",
            "A bus factor and a knowledge-transfer risk that onboarding has not addressed",
            "The team is too small to distribute review",
            "Review latency is optimal because one person knows the codebase"
          ],
          "answer": 1,
          "explain": "Review is the main channel for context transfer. A dominant reviewer means everyone else depends on them for correctness and context, so their absence becomes a delivery risk."
        }
      ],
      "quickbytes": [
        "Day 1 gate: clone, build, test, run locally with one command, and it is scripted, not remembered.",
        "Week 1 gate: one small change merged and deployed through the real pipeline.",
        "When you answer a question for the second time, write the artifact in the same hour."
      ],
      "production": [
        "Onboarding gates are documented with owners and a target day for each one.",
        "Environment setup is one command in the repository, tested in CI on a clean checkout.",
        "Each newcomer is assigned a mentor and a first-task list generated from real gaps.",
        "Review-load distribution is reviewed quarterly to find knowledge concentration."
      ],
      "crates": [
        "cargo_metadata",
        "clap",
        "walkdir",
        "anyhow"
      ],
      "github": [
        {
          "name": "oli-obk/cargo_metadata - list workspace crates for first tasks",
          "url": "https://github.com/oli-obk/cargo_metadata"
        },
        {
          "name": "walkdir - walk crate sources for TODO markers",
          "url": "https://github.com/BurntSushi/walkdir"
        }
      ],
      "pitfall": "Onboarding that depends on one patient engineer: the newcomer succeeds, the engineer loses a month of focus, and nothing is written down, so the next hire starts from zero with a resentful mentor.",
      "resources": [
        {
          "title": "rustc-dev-guide: how a large Rust project onboards contributors",
          "url": "https://rustc-dev-guide.rust-lang.org/",
          "kind": "docs"
        },
        {
          "title": "A Case Study of Onboarding in Software Teams: Tasks and Strategies",
          "url": "https://arxiv.org/abs/2103.05055",
          "kind": "paper"
        },
        {
          "title": "rust-lang/rustlings: guided exercises for newcomers",
          "url": "https://github.com/rust-lang/rustlings",
          "kind": "repo"
        },
        {
          "title": "rustc-dev-guide repository: mentoring instructions in issues",
          "url": "https://github.com/rust-lang/rustc-dev-guide",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "ec11",
      "n": 11,
      "title": "Pairing: driver, navigator, and ping-pong",
      "minutes": 45,
      "level": "core",
      "goal": "Run a pairing session that produces design decisions and shared context, use ping-pong to remove negotiation about who decides, and know when pairing costs more than it returns.",
      "sections": [
        {
          "h": "Two roles, one keyboard, explicit handoffs",
          "p": [
            "The driver types; the navigator thinks about the next step, the tests, and the design. Strong-style pairing makes the rule operational: an idea has to pass through someone else's hands to reach the computer, so a senior engineer describing a change hands the keyboard over instead of taking it. That single habit converts a review comment into transferred skill.",
            "Swap every 15 to 25 minutes or at every red-green transition, because handoffs are where the shared model forms. A session where one person typed for two hours produced a change and transferred nothing, which is fine if that was the goal and a waste if it was not. Say the swap out loud: 'take the keyboard, I want to watch this part'."
          ],
          "list": [
            "Driver: types, asks questions, does not defend the code",
            "Navigator: thinks one step ahead, names risks, keeps the test list",
            "Swap at red-green boundaries or every 20 minutes, announced aloud",
            "One screen and one keyboard owner; no silent second editor"
          ],
          "tip": "If the navigator has been silent for ten minutes, the pairing has become spectating."
        },
        {
          "h": "Ping-pong makes the protocol explicit",
          "p": [
            "The navigator writes a failing test and hands over; the driver makes it pass and writes the next failing test. Each person alternately sets the requirement and satisfies it, which removes the negotiation about who decides what to build and keeps both people inside the design instead of one narrating and the other executing.",
            "Keep cycles small: one behaviour per cycle, commit at green. The tests become the durable artifact of the conversation, so the pairing's output is not only the code but a specification the next engineer can read. When a cycle takes more than ten minutes, the step was too large; split it rather than pushing through."
          ],
          "code": "/// Ping-pong cycle: the navigator writes the test, the driver makes it pass.\n#[derive(Debug, PartialEq, Eq)]\npub struct Window {\n    pub start: u32,\n    pub end: u32,\n}\n\n#[derive(Debug, PartialEq, Eq)]\npub enum WindowError {\n    Empty,\n    Inverted { start: u32, end: u32 },\n}\n\n/// Navigator's turn: require inclusive bounds and reject an inverted range.\n#[test]\nfn rejects_inverted_window() {\n    assert_eq!(\n        Window::new(10, 4),\n        Err(WindowError::Inverted { start: 10, end: 4 })\n    );\n}\n\n/// Driver's turn: the smallest implementation that passes, then stop.\nimpl Window {\n    pub fn new(start: u32, end: u32) -> Result<Self, WindowError> {\n        if start > end {\n            return Err(WindowError::Inverted { start, end });\n        }\n        Ok(Self { start, end })\n    }\n}\n\n// Next cycle, navigator again: a zero-width window at the boundary is legal,\n// so add `allows_single_second_window` before writing any more code.",
          "tip": "Write the next failing test before discussing the design; the test is the cheapest design question."
        },
        {
          "h": "When pairing is the wrong tool",
          "p": [
            "Pairing costs roughly two person-hours per hour of work. It pays when the work is ambiguous, when knowledge must transfer, or when correctness matters more than throughput: a migration script, a tricky concurrency fix, a design decision with three plausible shapes. It does not pay for mechanical changes, for work that needs long uninterrupted focus, or across time zones without a written protocol.",
            "Remote pairing fails in specific, fixable ways: a slow connection for one person, one person silent, no agreed handoff signal. Fix them explicitly: one screen share owned by the driver, an 'I am stuck, take over' phrase that is not an admission of failure, breaks every 50 minutes, and a two-line summary in the issue at the end. If the session produced no decision and no commit, it was a meeting, and it should have been an issue comment."
          ],
          "tip": "Book 90 minutes, not a day: pairing fatigue shows up as silent navigators and rushed merges."
        }
      ],
      "exercise": {
        "prompt": "Run one ping-pong cycle: the given test asserts that a window rejects an inverted range, and a second test requires that a zero-width window is legal. Implement the smallest code that passes both, without adding a third behaviour.",
        "starter": "#[derive(Debug, PartialEq, Eq)]\npub struct Window { pub start: u32, pub end: u32 }\n\n#[derive(Debug, PartialEq, Eq)]\npub enum WindowError { Inverted { start: u32, end: u32 } }\n\nimpl Window {\n    pub fn new(start: u32, end: u32) -> Result<Self, WindowError> {\n        todo!()\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn rejects_inverted_window() {\n        assert_eq!(Window::new(10, 4), Err(WindowError::Inverted { start: 10, end: 4 }));\n    }\n\n    #[test]\n    fn allows_zero_width_window() {\n        assert_eq!(Window::new(4, 4), Ok(Window { start: 4, end: 4 }));\n    }\n}",
        "hint": "One branch: if start > end return Err with both bounds. Equal bounds are legal, so the comparison is strict. Resist adding a maximum width check; it is the next cycle's test.",
        "solution": "#[derive(Debug, PartialEq, Eq)]\npub struct Window {\n    pub start: u32,\n    pub end: u32,\n}\n\n#[derive(Debug, PartialEq, Eq)]\npub enum WindowError {\n    Inverted { start: u32, end: u32 },\n}\n\nimpl Window {\n    pub fn new(start: u32, end: u32) -> Result<Self, WindowError> {\n        if start > end {\n            return Err(WindowError::Inverted { start, end });\n        }\n        Ok(Self { start, end })\n    }\n\n    pub fn width(&self) -> u32 {\n        self.end - self.start\n    }\n}\n\nfn main() {\n    assert_eq!(Window::new(10, 4), Err(WindowError::Inverted { start: 10, end: 4 }));\n    assert_eq!(Window::new(4, 4).map(|window| window.width()), Ok(0));\n    assert_eq!(Window::new(1, 5).map(|window| window.width()), Ok(4));\n    println!(\"ping-pong cycle complete: one branch, two tests\");\n}"
      },
      "questions": [
        {
          "q": "What does strong-style pairing require of an idea?",
          "options": [
            "It must be prototyped alone, then demonstrated",
            "It must be written in the issue tracker before being coded",
            "It must pass through someone else's hands before reaching the computer",
            "It must be reviewed by the navigator after the driver implements it"
          ],
          "answer": 2,
          "explain": "The rule forces explanation and handoff, which is where the transfer happens. It also stops the most experienced person from silently taking over the keyboard, which is the usual failure of weak pairing."
        },
        {
          "q": "A ping-pong cycle has run for 25 minutes without reaching green. What should the pair do?",
          "options": [
            "Switch to solo work and reconvene later",
            "Keep going until the test passes, to preserve momentum",
            "Delete the test and pick a simpler requirement for the cycle",
            "Stop, split the behaviour into a smaller test, and restart the cycle"
          ],
          "answer": 3,
          "explain": "A long cycle means the step was too large. Splitting it restores the feedback loop; deleting the test loses the requirement, and going solo abandons the pairing's main benefit."
        },
        {
          "q": "Which task is the worst candidate for a pairing session?",
          "options": [
            "Renaming 40 files with rustfix and no behaviour change",
            "Designing the retry policy for a new dependency",
            "Migrating a schema with a rollback path nobody has rehearsed",
            "A concurrency fix that is hard to reproduce"
          ],
          "answer": 0,
          "explain": "Mechanical, compiler-verified changes do not benefit from a second mind, and they consume two people. Pair on ambiguity, risk, and knowledge transfer instead."
        }
      ],
      "quickbytes": [
        "Swap at red-green boundaries and say it out loud; silent swapping produces two solo sessions.",
        "One behaviour per ping-pong cycle; a cycle longer than ten minutes means the step was too big.",
        "Book 90 minutes and end with a two-line summary in the issue, or the session leaves no trace."
      ],
      "production": [
        "Pairing sessions end with a commit or a written decision, never with 'we talked about it'.",
        "No silent second editor: one screen, one keyboard owner, announced handoffs.",
        "Risky migrations and incident fixes are paired by default, with the pairing agreed before starting.",
        "Remote pairing uses a shared 'I am stuck, take over' signal and a break every 50 minutes."
      ],
      "crates": [
        "cargo-nextest",
        "rstest",
        "insta",
        "trybuild"
      ],
      "github": [
        {
          "name": "nextest-rs/nextest - fast test runs keep ping-pong cycles short",
          "url": "https://github.com/nextest-rs/nextest"
        },
        {
          "name": "mitsuhiko/insta - snapshots as the pair shared specification",
          "url": "https://github.com/mitsuhiko/insta"
        }
      ],
      "pitfall": "Pairing where the senior engineer narrates and occasionally grabs the keyboard: the junior watches a demonstration, the senior ships alone, and the knowledge stays where it was.",
      "resources": [
        {
          "title": "Linux kernel: how development and review are expected to work together",
          "url": "https://docs.kernel.org/process/development-process.html",
          "kind": "docs"
        },
        {
          "title": "A Systematic Literature Review and Taxonomy of Modern Code Review",
          "url": "https://arxiv.org/abs/2103.08777",
          "kind": "paper"
        },
        {
          "title": "GOTO Conferences: pairing, mobbing, and team practice talks",
          "url": "https://www.youtube.com/@GOTO-",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ec12",
      "n": 12,
      "title": "Technical debt you can price and rank",
      "minutes": 75,
      "level": "advanced",
      "goal": "Turn debt from a complaint into a number: principal, interest per quarter, a trigger that forces payment, and a payback ranking that competes with feature work on equal terms.",
      "sections": [
        {
          "h": "Debt is a loan, so price it like one",
          "p": [
            "Principal is what it costs to fix; interest is what every change pays until you do. Interest compounds where the code is hot: the same clumsy abstraction costs far more in a module touched weekly than in one touched yearly, which is why debt registers ranked by smell count produce the wrong order. Deliberate, prudent debt is a tool; the failure mode is debt that nobody wrote down and nobody owns.",
            "Three questions per item: what does it cost per quarter, when does it become urgent, and what is the payback period. Research on temporal discounting in technical-debt decisions shows practitioners systematically undervalue future cost, which is exactly why interest has to be estimated in engineer-days rather than described as messy. A number can be argued with; an adjective cannot."
          ],
          "list": [
            "Principal: engineer-days to remove, including the migration",
            "Interest: engineer-days lost per quarter while it stays",
            "Trigger: the event that forces payment (a launch, a scale target, an audit)",
            "Owner: the person who will notice when the trigger is hit"
          ],
          "tip": "If you cannot name the trigger, you are not planning to pay the debt; you are hoping to."
        },
        {
          "h": "Measure interest, not code smells",
          "p": [
            "Clippy warnings and code-smell counts are not interest, because they do not tell you what the debt costs. Interest shows up as lead time on files in the hot path, defect rate per module, time for a newcomer to make a first change, and incidents traced to the same component. Pick two of those, measure them on the debt item's blast radius, and convert to engineer-days per quarter.",
            "The register belongs in the repository as a file with owner, principal, interest, trigger, and status, reviewed quarterly alongside capacity planning. That placement matters: a spreadsheet owned by one person becomes a private opinion, while a reviewed file becomes a shared constraint that feature work has to argue with."
          ],
          "code": "use std::cmp::Ordering;\n\n#[derive(Debug, Clone)]\npub struct DebtItem {\n    pub id: &'static str,\n    pub principal_days: f64,\n    pub interest_days_per_quarter: f64,\n    pub quarters_until_trigger: f64,\n    pub owner: &'static str,\n}\n\nimpl DebtItem {\n    /// Payback in quarters: how long before the interest saved equals the cost.\n    /// Infinite payback means the debt never pays for itself at this interest rate.\n    pub fn payback_quarters(&self) -> f64 {\n        if self.interest_days_per_quarter <= 0.0 {\n            return f64::INFINITY;\n        }\n        self.principal_days / self.interest_days_per_quarter\n    }\n\n    /// Only pay if the payback lands before the trigger forces the work anyway.\n    pub fn worth_paying(&self) -> bool {\n        self.payback_quarters() <= self.quarters_until_trigger\n    }\n}\n\npub fn ranked(items: &[DebtItem]) -> Vec<&DebtItem> {\n    let mut ranked: Vec<&DebtItem> = items.iter().collect();\n    ranked.sort_by(|a, b| {\n        a.payback_quarters()\n            .partial_cmp(&b.payback_quarters())\n            .unwrap_or(Ordering::Equal)\n            .then_with(|| b.interest_days_per_quarter.partial_cmp(&a.interest_days_per_quarter).unwrap_or(Ordering::Equal))\n    });\n    ranked\n}",
          "tip": "Rank by payback, then filter by whether the payback lands before the trigger. Both numbers, or it is a preference."
        },
        {
          "h": "Pay it down without a debt sprint",
          "p": [
            "Three mechanisms work in practice. The boy-scout rule inside touched code, so debt in the hot path shrinks as features move through it. A standing capacity fraction of ten to twenty percent with a named owner, spent on items from the register rather than on whatever is annoying today. And a targeted refactor attached to a roadmap item, so the business pays for it as part of a feature it already wants.",
            "Avoid the standalone debt sprint. It competes with feature work, loses the scheduling argument, and teaches the team that debt work is not real work; when it does happen, it is a large risky change reviewed in a hurry. Attachment to shipping work is what makes debt reduction survive contact with a roadmap."
          ],
          "tip": "Never say 'we need a quarter to fix the architecture'; say which roadmap item gets cheaper once this item is paid."
        }
      ],
      "exercise": {
        "prompt": "Implement the debt ranking that a planning meeting can act on: compute payback in quarters, mark items worth paying before their trigger, and rank by payback with ties broken by larger quarterly interest.",
        "starter": "struct DebtItem {\n    id: &'static str,\n    principal_days: f64,\n    interest_days_per_quarter: f64,\n    quarters_until_trigger: f64,\n}\n\nimpl DebtItem {\n    fn payback_quarters(&self) -> f64 {\n        // principal / interest; zero interest means never\n        todo!()\n    }\n\n    fn worth_paying(&self) -> bool {\n        todo!()\n    }\n}\n\nfn ranked(items: &[DebtItem]) -> Vec<&DebtItem> {\n    todo!()\n}\n\nfn main() {}",
        "hint": "Return f64::INFINITY when interest is non-positive. worth_paying compares payback with quarters_until_trigger. Use partial_cmp with unwrap_or(Ordering::Equal) so a NaN cannot panic the sort.",
        "solution": "use std::cmp::Ordering;\n\nstruct DebtItem {\n    id: &'static str,\n    principal_days: f64,\n    interest_days_per_quarter: f64,\n    quarters_until_trigger: f64,\n}\n\nimpl DebtItem {\n    fn payback_quarters(&self) -> f64 {\n        if self.interest_days_per_quarter <= 0.0 {\n            return f64::INFINITY;\n        }\n        self.principal_days / self.interest_days_per_quarter\n    }\n\n    fn worth_paying(&self) -> bool {\n        self.payback_quarters() <= self.quarters_until_trigger\n    }\n}\n\nfn ranked(items: &[DebtItem]) -> Vec<&DebtItem> {\n    let mut ranked: Vec<&DebtItem> = items.iter().filter(|item| item.worth_paying()).collect();\n    ranked.sort_by(|a, b| {\n        a.payback_quarters()\n            .partial_cmp(&b.payback_quarters())\n            .unwrap_or(Ordering::Equal)\n            .then_with(|| {\n                b.interest_days_per_quarter\n                    .partial_cmp(&a.interest_days_per_quarter)\n                    .unwrap_or(Ordering::Equal)\n            })\n    });\n    ranked\n}\n\nfn main() {\n    let items = [\n        DebtItem { id: \"hand-rolled-retry\", principal_days: 6.0, interest_days_per_quarter: 4.0, quarters_until_trigger: 2.0 },\n        DebtItem { id: \"legacy-export\", principal_days: 20.0, interest_days_per_quarter: 1.0, quarters_until_trigger: 4.0 },\n        DebtItem { id: \"cosmetic-naming\", principal_days: 3.0, interest_days_per_quarter: 0.0, quarters_until_trigger: 8.0 },\n    ];\n\n    let order: Vec<&str> = ranked(&items).iter().map(|item| item.id).collect();\n    assert_eq!(order, vec![\"hand-rolled-retry\"]);\n    assert!(!items[1].worth_paying());\n    assert_eq!(items[2].payback_quarters(), f64::INFINITY);\n    println!(\"pay now: {order:?}\");\n}"
      },
      "questions": [
        {
          "q": "Two debt items cost six engineer-days to fix. Which one has more interest?",
          "options": [
            "The one with more clippy warnings in its module",
            "The one in the module that changes every week, where every change pays the tax",
            "The one written by the most junior engineer",
            "The one with the older commit date"
          ],
          "answer": 1,
          "explain": "Interest is paid per change, not per line. Debt in a hot path compounds quickly; identical debt in a dormant module may never repay the principal it costs to fix."
        },
        {
          "q": "Why does a standalone quarterly debt sprint usually fail?",
          "options": [
            "Because debt work requires a different review process",
            "Because refactoring without a feature always introduces regressions",
            "Because it competes with feature work, loses the scheduling argument, and is compressed into a rushed large change",
            "Because the team forgets what was refactored by the next quarter"
          ],
          "answer": 2,
          "explain": "A sprint with no shipping outcome is the first thing cut. Attaching debt work to a roadmap item gives it a sponsor and keeps the change small enough to review properly."
        },
        {
          "q": "What is the role of the trigger in a debt register?",
          "options": [
            "It sets the reviewer for the refactor pull request",
            "It marks the item as visible to management",
            "It records when the debt was created",
            "It names the event that forces payment, so the item cannot be deferred forever without an explicit decision"
          ],
          "answer": 3,
          "explain": "Without a trigger, every item is competing on vibes. A trigger turns the decision into a deadline the team can plan around, and makes deferral a choice rather than a default."
        }
      ],
      "quickbytes": [
        "Price debt in engineer-days per quarter; an adjective cannot be ranked or reviewed.",
        "Keep the register in the repo with owner, principal, interest, trigger, and status.",
        "Attach debt work to a roadmap item so the business pays for it as part of something it wants."
      ],
      "production": [
        "A debt register lives in the repository and is reviewed in the quarterly planning meeting.",
        "Every item has an owner, a principal, a quarterly interest estimate, and a trigger.",
        "Debt work is attached to roadmap items or funded from a named capacity fraction.",
        "Interest is measured from lead time, defect rate, or incidents on the affected component, not from lint counts."
      ],
      "crates": [
        "petgraph",
        "serde",
        "chrono",
        "anyhow"
      ],
      "github": [
        {
          "name": "petgraph - find dependency cycles that make debt expensive to unwind",
          "url": "https://github.com/petgraph/petgraph"
        },
        {
          "name": "chronotope/chrono - price interest per quarter",
          "url": "https://github.com/chronotope/chrono"
        }
      ],
      "pitfall": "A debt backlog ranked by code smell: the team fixes the ugliest file first, spends two weeks, and the latency problem that generated the incidents is untouched because it was not the ugliest.",
      "resources": [
        {
          "title": "Temporal Discounting in Technical Debt: how practitioners value the future",
          "url": "https://arxiv.org/abs/1901.07024",
          "kind": "paper"
        },
        {
          "title": "Business-Driven Technical Debt Prioritization: an industrial case study",
          "url": "https://arxiv.org/abs/2010.09711",
          "kind": "paper"
        },
        {
          "title": "petgraph: analyze module and dependency graphs",
          "url": "https://docs.rs/petgraph/latest/petgraph/",
          "kind": "docs"
        },
        {
          "title": "GOTO Conferences: architecture, debt, and maintainability talks",
          "url": "https://www.youtube.com/@GOTO-",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ec13",
      "n": 13,
      "title": "Refactoring under a compiler guarantee",
      "minutes": 90,
      "level": "advanced",
      "goal": "Change structure without changing behaviour: pin current behaviour with tests, transform mechanically, use exhaustiveness and deprecation deliberately, and keep every commit bisectable.",
      "sections": [
        {
          "h": "Refactoring is a claim about behaviour",
          "p": [
            "If behaviour is not pinned by tests, refactor means rewrite and hope. Characterization tests record what the code does today, including the parts you privately consider bugs, and the refactor's diff must leave them untouched. A failing characterization test during a refactor is not a failure of the refactor; it is proof that behaviour changed, which belongs in its own commit with its own review.",
            "Rust gives mechanical leverage that most languages only approximate. Adding an enum variant breaks every exhaustive match at compile time, so the compiler enumerates the call sites you must think about. Type-state makes invalid call orders unrepresentable. rustfix applies compiler-suggested edits across the workspace, which is a rename that cannot miss a file. Use these deliberately rather than treating compiler errors as obstacles."
          ],
          "list": [
            "Characterize: snapshot or assert current behaviour, bugs included",
            "Transform: one mechanical operation per commit, compiler-checked",
            "Deprecate: keep a delegating wrapper for a release, then delete",
            "Verify: semver check for public API, full suite at every commit"
          ],
          "tip": "If the tree is red for a day during a refactor, it is a rewrite with extra steps."
        },
        {
          "h": "Deprecate first, remove later",
          "p": [
            "A deprecation is a migration instruction, not a warning: since, note, and a pointer to the replacement. Keep a delegating wrapper for at least one minor release so downstream has a mechanical path, then delete it in a release you announce. For traits, sealing the trait lets you add methods without committing to downstream implementors, which is often the difference between an additive change and a breaking one.",
            "Public enums are the sharp edge. Adding a variant is breaking unless the enum is non_exhaustive, and removing one is always breaking; cargo-semver-checks will tell you which of your edits crossed that line, and trybuild pins the exact diagnostics of your compile-fail cases so a refactor that quietly changes an error message is visible in review."
          ],
          "code": "// v1.4: keep the old name working while callers migrate.\n#[deprecated(\n    since = \"1.4.0\",\n    note = \"renamed to `compute_checksum`; the old name will be removed in 2.0\"\n)]\npub fn checksum(bytes: &[u8]) -> u64 {\n    compute_checksum(bytes)\n}\n\npub fn compute_checksum(bytes: &[u8]) -> u64 {\n    // Behaviour is byte-identical on purpose: this is a rename, not a fix.\n    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;\n    for byte in bytes {\n        hash ^= u64::from(*byte);\n        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);\n    }\n    hash\n}\n\n// CI, in this order: rename, then verify nothing but the name changed.\n// cargo fix --edition-idioms --allow-dirty --allow-staged\n// cargo semver-checks check-release\n// cargo test --all-features",
          "tip": "Write the delegating wrapper's body as a single call to the new function; any second line of logic will drift."
        },
        {
          "h": "Keep the history usable",
          "p": [
            "One transformation per commit: rename, then move, then change behaviour. Mixing a rename with a behaviour change makes review useless and bisect worse, because git log --follow stops at the rename and the diff no longer lines up with the file you remember. Separate commits are also the reason a refactor can be reverted cleanly when it turns out to have changed something it should not have.",
            "Run the full suite at every commit for a large refactor, and run it with the same feature flags CI uses, since a refactor that only compiles under --all-features is a trap for downstream users. The payoff is that the last commit of the series is boring: the interesting decisions happened in small, reversible steps that each had a green build."
          ],
          "tip": "A refactor series should be revertible one commit at a time; if it is not, the commits are too large."
        }
      ],
      "exercise": {
        "prompt": "Rename a public function without breaking callers: add compute_checksum, keep checksum as a deprecated delegating wrapper, and prove with a test that both produce identical output for the empty input and for embedded zero bytes.",
        "starter": "pub fn checksum(bytes: &[u8]) -> u64 {\n    // existing implementation, byte-identical behaviour required\n    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;\n    for byte in bytes {\n        hash ^= u64::from(*byte);\n        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);\n    }\n    hash\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn old_and_new_agree() {\n        // 1. add compute_checksum\n        // 2. assert equality for b\"\" and for b\"a\\0b\"\n        todo!()\n    }\n}",
        "hint": "Move the body into compute_checksum, make checksum a one-line call with #[deprecated(since, note)], then assert checksum(x) == compute_checksum(x) for the empty slice and for b\"a\\0b\". Silence the deprecation warning in the test with #[allow(deprecated)].",
        "solution": "#[deprecated(\n    since = \"1.4.0\",\n    note = \"renamed to `compute_checksum`; the old name will be removed in 2.0\"\n)]\npub fn checksum(bytes: &[u8]) -> u64 {\n    compute_checksum(bytes)\n}\n\npub fn compute_checksum(bytes: &[u8]) -> u64 {\n    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;\n    for byte in bytes {\n        hash ^= u64::from(*byte);\n        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);\n    }\n    hash\n}\n\nfn main() {\n    #[allow(deprecated)]\n    let old: fn(&[u8]) -> u64 = checksum;\n    let new: fn(&[u8]) -> u64 = compute_checksum;\n\n    for input in [&b\"\"[..], &b\"a\\0b\"[..], &b\"the quick brown fox\"[..]] {\n        assert_eq!(old(input), new(input), \"rename changed behaviour for {input:?}\");\n    }\n\n    assert_ne!(compute_checksum(b\"a\\0b\"), compute_checksum(b\"ab\"));\n    println!(\"rename verified: {} == {}\", old(b\"a\\0b\"), new(b\"a\\0b\"));\n}"
      },
      "questions": [
        {
          "q": "Why must a rename and a behaviour change be separate commits?",
          "options": [
            "Because review and bisect both stop working when the diff mixes mechanical and semantic changes",
            "Because deprecation warnings only appear on renamed items",
            "Because semver checks only run on the last commit of a branch",
            "Because cargo fix refuses to run on a dirty tree"
          ],
          "answer": 0,
          "explain": "Reviewers cannot verify a behaviour change hidden in a 400-file rename, and bisect cannot attribute a regression to either half. Separation keeps each commit falsifiable."
        },
        {
          "q": "What does #[deprecated(since, note)] actually do?",
          "options": [
            "Removes the item at the next minor release",
            "Emits a warning with the note at call sites, giving downstream a migration instruction",
            "Marks the item as unsafe to call",
            "Hides the item from documentation until it is removed"
          ],
          "answer": 1,
          "explain": "Deprecation is advice plus a warning, and it is only useful when the note names the replacement. It removes nothing; the deletion is a separate, announced breaking change."
        },
        {
          "q": "Which change to a public API is breaking even in a minor release?",
          "options": [
            "Adding a doc comment",
            "Adding a method with a default implementation to a public trait",
            "Adding a variant to a public enum without non_exhaustive",
            "Adding a new public function"
          ],
          "answer": 2,
          "explain": "Downstream exhaustive matches stop compiling. A defaulted trait method is only breaking for implementors of a sealed trait, and adding items is additive by definition."
        }
      ],
      "quickbytes": [
        "Characterization test first, rename second, behaviour change third, never in one commit.",
        "Deprecate with a note that names the replacement; keep a one-line delegating wrapper for a release.",
        "Run cargo semver-checks before publishing and trybuild to pin diagnostics."
      ],
      "production": [
        "Public renames ship a deprecated delegating wrapper for at least one minor release.",
        "CI runs cargo semver-checks on every release candidate.",
        "Compile-fail tests under trybuild pin diagnostics that downstream tooling may match on.",
        "A refactor series keeps the suite green at every commit, not only at the branch tip."
      ],
      "crates": [
        "cargo-semver-checks",
        "trybuild",
        "cargo-public-api",
        "rustfix"
      ],
      "github": [
        {
          "name": "obi1kenobi/cargo-semver-checks - detect breaking changes from a real build",
          "url": "https://github.com/obi1kenobi/cargo-semver-checks"
        },
        {
          "name": "dtolnay/trybuild - pin compiler diagnostics as tests",
          "url": "https://github.com/dtolnay/trybuild"
        }
      ],
      "pitfall": "A refactor branch that mixes rename, module move, and a bug fix: review approves all three, the regression cannot be attributed, and reverting the fix also reverts the rename that three other branches already rebased onto.",
      "resources": [
        {
          "title": "The Cargo Book: semver compatibility rules",
          "url": "https://doc.rust-lang.org/cargo/reference/semver.html",
          "kind": "docs"
        },
        {
          "title": "cargo fix: apply compiler-suggested edits across a workspace",
          "url": "https://doc.rust-lang.org/cargo/commands/cargo-fix.html",
          "kind": "docs"
        },
        {
          "title": "trybuild: compile-fail tests that pin error messages",
          "url": "https://docs.rs/trybuild/latest/trybuild/",
          "kind": "docs"
        },
        {
          "title": "cargo-semver-checks: automated breaking-change detection",
          "url": "https://github.com/obi1kenobi/cargo-semver-checks",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "ec14",
      "n": 14,
      "title": "Legacy code: find the seam before the behaviour",
      "minutes": 105,
      "level": "industry",
      "goal": "Make an untested module testable by introducing one seam at a time, characterize what it actually does, and replace it incrementally instead of losing its accumulated bug fixes in a rewrite.",
      "sections": [
        {
          "h": "Legacy means nobody can predict the effect of an edit",
          "p": [
            "Age and style are not the defining property; fear is. A module is legacy when nobody can say what will break if it changes, and that has two causes: no tests, and hidden dependencies on time, network, filesystem, or global state. The order of work is fixed by that diagnosis: create a seam, get a test through the seam, then change behaviour. Any other order produces a change nobody can verify.",
            "A seam is a place where behaviour can be changed without editing the code in place: a trait boundary, an injected parameter, a clock, a client. In Rust the cheapest seam is a generic parameter over a trait with a production implementation and a test implementation. The seam is not architecture for its own sake; it is the minimum cut that makes the module observable."
          ],
          "list": [
            "Identify the hidden inputs: clock, RNG, network, filesystem, environment, globals",
            "Introduce one trait or parameter that makes that input injectable",
            "Write a characterization test that fails if behaviour changes",
            "Only then refactor, in small commits, with the snapshot untouched"
          ],
          "tip": "One seam per change. Two seams in one commit means you cannot tell which one broke the test."
        },
        {
          "h": "Characterize before you judge",
          "p": [
            "Write tests that assert what the code does today. That includes the odd rounding, the swallowed error, the trailing newline, and the special case nobody can explain. Snapshot tests make this cheap for large outputs, and reviewing the snapshot is exactly the act of accepting the current behaviour as the specification, which is a decision worth making explicitly rather than by accident.",
            "Do not fix the bugs you find while characterizing. Note them in the issue, keep the snapshot honest, and fix them in a separate commit with a separate test. Otherwise a failing snapshot cannot tell you whether the refactor regressed or whether you deliberately changed behaviour, and you will spend the rest of the project arguing with your own test suite."
          ],
          "code": "use std::time::{SystemTime, UNIX_EPOCH};\n\n/// Before: the clock is a hidden input, so no test can pin it.\npub fn invoice_is_overdue(due_epoch_s: u64) -> bool {\n    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();\n    now > due_epoch_s\n}\n\n/// The seam: one trait with a production impl and a test impl.\npub trait Clock {\n    fn now_epoch_s(&self) -> u64;\n}\n\npub struct SystemClock;\n\nimpl Clock for SystemClock {\n    fn now_epoch_s(&self) -> u64 {\n        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()\n    }\n}\n\npub fn is_overdue<C: Clock>(clock: &C, due_epoch_s: u64) -> bool {\n    clock.now_epoch_s() > due_epoch_s\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    struct FixedClock(u64);\n\n    impl Clock for FixedClock {\n        fn now_epoch_s(&self) -> u64 {\n            self.0\n        }\n    }\n\n    #[test]\n    fn boundary_is_strictly_after_due() {\n        // Characterization: exactly at the due second is NOT overdue.\n        assert!(!is_overdue(&FixedClock(1_000), 1_000));\n        assert!(is_overdue(&FixedClock(1_001), 1_000));\n    }\n}",
          "tip": "A trait with two implementations is a seam; a trait with one implementation and a mock framework is usually ceremony."
        },
        {
          "h": "Strangle, do not rewrite",
          "p": [
            "Route new call paths to the new implementation, keep the old one behind a flag, and delete it once traffic is zero and the data has migrated. The rewrite is tempting because the old code is unpleasant, but it also contains a decade of bug fixes encoded as special cases that nobody documented; a clean rewrite rediscovers them one incident at a time, and the old system keeps changing while you build the new one.",
            "Migrations need a parity check, not a code review. Run both implementations on the same input in shadow mode and diff the results, with the differences triaged deliberately: each one is either a bug in the new code or a fix you are choosing to make. Retire the check only after a full business cycle has passed, because the cases that differ are usually seasonal or month-end, and the calendar is part of the specification."
          ],
          "tip": "Shadow-mode diffing is the test oracle for a migration; without it the cutover is a coin flip."
        }
      ],
      "exercise": {
        "prompt": "Take a function that reads the system clock internally, introduce a Clock seam with a production implementation and a fixed test implementation, and characterize the boundary: exactly at the due second is not overdue.",
        "starter": "use std::time::{SystemTime, UNIX_EPOCH};\n\npub fn invoice_is_overdue(due_epoch_s: u64) -> bool {\n    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();\n    now > due_epoch_s\n}\n\npub trait Clock { fn now_epoch_s(&self) -> u64; }\n\npub struct SystemClock;\n// 1. implement Clock for SystemClock\n// 2. add is_overdue<C: Clock>(clock: &C, due_epoch_s: u64) -> bool\n// 3. add FixedClock and a test for the boundary\n\nfn main() {}",
        "hint": "Keep the comparison strict so equal timestamps are not overdue. Implement Clock for SystemClock with SystemTime::now().duration_since(UNIX_EPOCH). The test clock is a tuple struct holding the epoch second; no mocking crate needed.",
        "solution": "use std::time::{SystemTime, UNIX_EPOCH};\n\npub trait Clock {\n    fn now_epoch_s(&self) -> u64;\n}\n\npub struct SystemClock;\n\nimpl Clock for SystemClock {\n    fn now_epoch_s(&self) -> u64 {\n        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()\n    }\n}\n\npub struct FixedClock(pub u64);\n\nimpl Clock for FixedClock {\n    fn now_epoch_s(&self) -> u64 {\n        self.0\n    }\n}\n\npub fn is_overdue<C: Clock>(clock: &C, due_epoch_s: u64) -> bool {\n    clock.now_epoch_s() > due_epoch_s\n}\n\nfn main() {\n    assert!(!is_overdue(&FixedClock(1_000), 1_000));\n    assert!(is_overdue(&FixedClock(1_001), 1_000));\n    assert!(!is_overdue(&FixedClock(0), 1_000));\n\n    // Production wiring still uses the real clock.\n    let overdue = is_overdue(&SystemClock, 1);\n    assert!(overdue);\n\n    println!(\"boundary characterized; system clock says overdue = {overdue}\");\n}"
      },
      "questions": [
        {
          "q": "Why characterize current behaviour, including behaviour you consider wrong?",
          "options": [
            "Because snapshot tests are cheaper than assertion tests",
            "Because downstream services depend on the source code",
            "Because changing documented bugs requires legal approval",
            "Because the snapshot is the evidence that a refactor changed nothing, and a deliberate fix must be visible as its own commit"
          ],
          "answer": 3,
          "explain": "The snapshot defines the baseline. If it silently includes your fix, every later failure is ambiguous, and you lose the ability to separate regression from intention."
        },
        {
          "q": "What makes a trait a seam rather than ceremony?",
          "options": [
            "It is injected at a boundary where a hidden input becomes controllable, with a real production impl and a test impl",
            "It is marked pub so downstream can implement it",
            "It is generated by a macro",
            "It has at least three implementations"
          ],
          "answer": 0,
          "explain": "The seam's value is controllability of something previously hidden: time, I/O, randomness. A trait with one implementation and no test double buys nothing but indirection."
        },
        {
          "q": "Why keep a shadow-mode parity check running for a full business cycle?",
          "options": [
            "Because the new implementation needs time to warm its caches",
            "Because differences cluster in month-end, seasonal, and quarterly paths that a short trial never exercises",
            "Because the old implementation must be kept for rollback for a year by policy",
            "Because reviewers need time to read the diff"
          ],
          "answer": 1,
          "explain": "Business calendars are part of the specification: proration, month-end, holidays, and fiscal boundaries produce cases that a two-week trial never sees. Retire the check after the cycle completes."
        }
      ],
      "quickbytes": [
        "Find the hidden inputs first: clock, RNG, network, filesystem, environment. Each one is a seam.",
        "A characterization test should fail on any behaviour change, including changes you intend.",
        "Run old and new in shadow mode and diff outputs; triage each difference as a bug or a decision."
      ],
      "production": [
        "Every legacy module under active change has at least one seam and a characterization test before edits.",
        "Migrations run old and new implementations in shadow mode with a triaged difference report.",
        "The old path is deleted only after traffic is zero and the parity check has survived a business cycle.",
        "Known bugs are recorded in the issue tracker, not fixed silently inside a characterization commit."
      ],
      "crates": [
        "insta",
        "mockall",
        "rstest",
        "anyhow"
      ],
      "github": [
        {
          "name": "mitsuhiko/insta - snapshot characterization for large outputs",
          "url": "https://github.com/mitsuhiko/insta"
        },
        {
          "name": "asomers/mockall - stand in for the seam until the real client is safe",
          "url": "https://github.com/asomers/mockall"
        }
      ],
      "pitfall": "Rewriting the legacy module because the code is unpleasant: the rewrite loses a decade of undocumented special cases, and the team relearns them one production incident at a time while the old system keeps changing.",
      "resources": [
        {
          "title": "insta: snapshot testing and reviewed baselines",
          "url": "https://docs.rs/insta/latest/insta/",
          "kind": "docs"
        },
        {
          "title": "The Rust Book: test organization for characterization suites",
          "url": "https://doc.rust-lang.org/book/ch11-03-test-organization.html",
          "kind": "docs"
        },
        {
          "title": "The Rust Reference: the deprecated attribute and its semantics",
          "url": "https://doc.rust-lang.org/reference/attributes/diagnostics.html",
          "kind": "docs"
        },
        {
          "title": "GOTO Conferences: legacy modernization and strangler-pattern talks",
          "url": "https://www.youtube.com/@GOTO-",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ec15",
      "n": 15,
      "title": "Choosing tests by the failure they must catch",
      "minutes": 90,
      "level": "advanced",
      "goal": "Pick a test type from the failure mode it has to catch: examples for rules, properties for invariants, snapshots for large outputs, benchmarks for regressions, and mutation scores to check the suite would notice.",
      "sections": [
        {
          "h": "A test is an oracle for one class of failure",
          "p": [
            "Every test answers one question, and the question determines the shape. Business rules with a handful of branches want example tests that read like a specification. Invariants over a whole domain want property tests, because the input nobody pictured is where the bug lives. Large structured outputs want snapshots, where reviewing the diff is the specification. Performance and concurrency want benchmarks and model checkers, because a normal assertion cannot see a regression.",
            "The test pyramid is a heuristic about cost, not a law. What matters is the price of the oracle and the fidelity of the environment: an integration test that exercises the real serialization boundary catches bugs unit tests structurally cannot see, while a fast unit test with a fixed clock catches the logic bugs that an end-to-end test discovers only on a bad day. Choose by what can fail, then by what you can afford to run on every commit."
          ],
          "list": [
            "Example test: one rule, one case, minimal setup, reads as documentation",
            "Property test: an invariant over a generated domain, with shrinking",
            "Snapshot: large output whose diff a reviewer must read",
            "Benchmark and model check: regressions in time and interleavings"
          ],
          "tip": "Name the failure mode in the test name; a test called test_2 documents nothing."
        },
        {
          "h": "Properties find the inputs you did not enumerate",
          "p": [
            "A property asserts something true for every input in a domain: decode(encode(x)) == x, sorting is idempotent, a retry never shortens a total budget. The framework generates inputs, shrinks a failure to a small case, and prints the seed so the failure is reproducible. That seed is the regression test, and it is worth committing as a plain example test once the property has done its job.",
            "The bugs that survive example tests are always the ones nobody pictured: empty input, a single element, the maximum, duplicated keys, a zero-length window, bytes that are not UTF-8. Properties cover those by construction, which is why they pay for themselves in parsers, serializers, and anything with arithmetic that can overflow."
          ],
          "code": "use proptest::prelude::*;\n\n// Frame and its encode/decode live in the module under test; the exercise\n// below builds them. The point here is the shape of the two properties.\n/// The invariant that matters for a wire format: anything that encodes\n/// must decode back to an equal value, for every payload including empty.\nproptest! {\n    #[test]\n    fn frame_roundtrips(\n        kind in 0u8..=255,\n        payload in proptest::collection::vec(any::<u8>(), 0..512),\n    ) {\n        let frame = Frame { kind, payload };\n        let bytes = frame.encode();\n        let decoded = Frame::decode(&bytes).expect(\"encode produced an undecodable frame\");\n        prop_assert_eq!(decoded, frame);\n    }\n\n    /// Encoding is deterministic, which is what lets a frame be hashed,\n    /// cached, or compared in a snapshot.\n    #[test]\n    fn encoding_is_stable(\n        kind in 0u8..=255,\n        payload in proptest::collection::vec(any::<u8>(), 0..64),\n    ) {\n        let frame = Frame { kind, payload };\n        prop_assert_eq!(frame.encode(), frame.encode());\n    }\n}",
          "tip": "Commit the seed from a property failure as a plain example test; properties find bugs, examples keep them fixed."
        },
        {
          "h": "Ask whether the suite would notice",
          "p": [
            "Coverage measures which lines ran, not whether a wrong answer would have failed. Mutation testing answers the better question: change a comparison, invert a boolean, delete a branch, and see whether any test goes red. Survivors are the places where your suite is decorative. Run it on the module you are about to refactor rather than on the whole workspace, because it is expensive by design.",
            "Then budget the suite like the permanent cost it is. Every end-to-end test pays runtime and flakiness for as long as the product exists; a slow, flaky test gets ignored, and an ignored test is worse than no test because it trains the team to tolerate red. Delete tests that no longer assert anything, and prefer one integration test at a real boundary over five that mock it."
          ],
          "tip": "A mutation score on the touched module is the cheapest evidence that a refactor is actually covered."
        }
      ],
      "exercise": {
        "prompt": "Write the roundtrip test that an example test misses: encode and decode a length-prefixed frame across payload lengths 0 through 64, including the empty payload, and assert the decoded frame equals the original.",
        "starter": "#[derive(Debug, PartialEq, Eq, Clone)]\nstruct Frame { kind: u8, payload: Vec<u8> }\n\n#[derive(Debug, PartialEq, Eq)]\nenum DecodeError { Truncated, BadLength }\n\nimpl Frame {\n    fn encode(&self) -> Vec<u8> {\n        // kind byte, then u32 big-endian length, then payload\n        todo!()\n    }\n\n    fn decode(bytes: &[u8]) -> Result<Self, DecodeError> {\n        // reject fewer than 5 bytes, and a length that disagrees with the buffer\n        todo!()\n    }\n}\n\nfn main() {\n    // 1. the empty payload must roundtrip\n    // 2. lengths 0..=64 with pseudo-random bytes must all roundtrip\n}",
        "hint": "encode: push kind, extend with (len as u32).to_be_bytes(), extend with payload. decode: check len >= 5, read the u32, require bytes.len() == 5 + len, then copy the tail. The empty payload is 5 bytes and must be legal.",
        "solution": "#[derive(Debug, PartialEq, Eq, Clone)]\nstruct Frame {\n    kind: u8,\n    payload: Vec<u8>,\n}\n\n#[derive(Debug, PartialEq, Eq)]\nenum DecodeError {\n    Truncated,\n    BadLength,\n}\n\nimpl Frame {\n    fn encode(&self) -> Vec<u8> {\n        let mut out = Vec::with_capacity(5 + self.payload.len());\n        out.push(self.kind);\n        out.extend_from_slice(&(self.payload.len() as u32).to_be_bytes());\n        out.extend_from_slice(&self.payload);\n        out\n    }\n\n    fn decode(bytes: &[u8]) -> Result<Self, DecodeError> {\n        if bytes.len() < 5 {\n            return Err(DecodeError::Truncated);\n        }\n        let kind = bytes[0];\n        let len = u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]) as usize;\n        if bytes.len() != 5 + len {\n            return Err(DecodeError::BadLength);\n        }\n        Ok(Self { kind, payload: bytes[5..].to_vec() })\n    }\n}\n\nfn main() {\n    let empty = Frame { kind: 7, payload: Vec::new() };\n    assert_eq!(Frame::decode(&empty.encode()), Ok(empty.clone()));\n\n    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;\n    for len in 0..=64usize {\n        let mut payload = Vec::with_capacity(len);\n        for _ in 0..len {\n            state = state.wrapping_mul(6364136223846793005).wrapping_add(1);\n            payload.push((state >> 40) as u8);\n        }\n\n        let frame = Frame { kind: (len % 251) as u8, payload };\n        assert_eq!(Frame::decode(&frame.encode()), Ok(frame), \"roundtrip failed at len {len}\");\n    }\n\n    assert_eq!(Frame::decode(&[1, 0, 0]), Err(DecodeError::Truncated));\n    println!(\"roundtrip holds for lengths 0..=64, empty payload included\");\n}"
      },
      "questions": [
        {
          "q": "A parser has example tests for typical requests. Which additional test is most likely to find the next bug?",
          "options": [
            "A benchmark proving the parser is fast enough",
            "A second example test with a different typical request",
            "A property test that encodes and decodes arbitrary byte payloads, including empty and maximum length",
            "An integration test that runs the parser against production data"
          ],
          "answer": 2,
          "explain": "Typical inputs are already covered. The failures that survive are boundary and shape cases: empty, maximum, non-UTF-8, duplicated keys. A property covers the domain rather than the examples."
        },
        {
          "q": "What does a mutation-testing survivor tell you?",
          "options": [
            "That the test suite is too slow to run in CI",
            "That the mutant is semantically equivalent and the tool is broken",
            "That the mutated line is unreachable in production",
            "That no test failed when the code's behaviour was changed, so that behaviour is unverified"
          ],
          "answer": 3,
          "explain": "A survivor means the suite did not notice a deliberate defect. Some survivors are equivalent mutants, but the default assumption is a blind spot worth a test."
        },
        {
          "q": "Why is an ignored flaky test worse than a missing test?",
          "options": [
            "Because the team learns to ignore red builds, which erodes every other signal",
            "Because it hides coverage from the report",
            "Because it cannot be deleted later",
            "Because flaky tests consume CI minutes"
          ],
          "answer": 0,
          "explain": "The value of a green build is that red means something. Tolerating a known-flaky red trains everyone to ignore the signal, which is how real failures ship."
        }
      ],
      "quickbytes": [
        "Property test the invariants (roundtrip, idempotence, ordering), example test the rules, snapshot the large outputs.",
        "Run cargo-mutants on the module you are about to refactor, not on the whole workspace.",
        "Every ignored test is a red build the team has learned to ignore; fix or delete it the same week."
      ],
      "production": [
        "Every parser and serializer has a roundtrip property test covering empty and maximum-length inputs.",
        "Mutation testing runs on changed modules in CI or on demand before a refactor.",
        "Flaky tests are quarantined with an owner and a deadline, never silently ignored.",
        "End-to-end tests are limited to real boundaries, with the runtime budget reviewed quarterly."
      ],
      "crates": [
        "proptest",
        "insta",
        "cargo-mutants",
        "criterion"
      ],
      "github": [
        {
          "name": "proptest-rs/proptest - property testing with shrinking",
          "url": "https://github.com/proptest-rs/proptest"
        },
        {
          "name": "sourcefrog/cargo-mutants - find the tests that would not notice",
          "url": "https://github.com/sourcefrog/cargo-mutants"
        }
      ],
      "pitfall": "A suite of example tests with 90% line coverage and no property or boundary cases: the empty payload, the maximum length, and the duplicated key all reach production because nobody wrote the input that was not typical.",
      "resources": [
        {
          "title": "proptest: strategies, shrinking, and reproducible seeds",
          "url": "https://docs.rs/proptest/latest/proptest/",
          "kind": "docs"
        },
        {
          "title": "Practical Mutation Testing at Scale",
          "url": "https://arxiv.org/abs/2102.11378",
          "kind": "paper"
        },
        {
          "title": "cargo-mutants: mutation testing for Rust",
          "url": "https://github.com/sourcefrog/cargo-mutants",
          "kind": "repo"
        },
        {
          "title": "The Rust Book: unit, integration, and documentation tests",
          "url": "https://doc.rust-lang.org/book/ch11-03-test-organization.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "ec16",
      "n": 16,
      "title": "Prioritisation: cost of delay beats priority labels",
      "minutes": 75,
      "level": "industry",
      "goal": "Rank work by cost of delay and duration, cap work in progress so queueing does not eat the plan, and frame every trade-off as the thing that will not happen instead of a label.",
      "sections": [
        {
          "h": "Priority labels collapse under pressure",
          "p": [
            "When everything is P1, the label carries no information and the queue is ordered by whoever escalated most recently. Replace the label with a number that can be argued with: cost of delay, meaning money or risk accrued per week of delay, and duration. Cost of delay divided by duration ranks short, valuable work above long, valuable work, which is usually right because shorter work returns capacity to the queue sooner.",
            "Queueing explains why a busy team feels slower than a less busy one. As utilisation approaches its ceiling, waiting time grows faster than any linear intuition suggests, and the response is almost never more estimates. It is a work-in-progress limit: fewer items in flight means each one finishes sooner, which is why the team that starts less and finishes more looks calm under the same load."
          ],
          "list": [
            "Cost of delay: value or risk per week, in a unit you can defend",
            "Duration: elapsed weeks, including review and deploy, not just coding",
            "CD3: cost of delay divided by duration, the ranking key",
            "WIP limit: the constraint that keeps cycle time from exploding"
          ],
          "tip": "If two items have the same CD3, prefer the one that unblocks other work: its cost of delay is underestimated."
        },
        {
          "h": "Every yes is a no you have not named",
          "p": [
            "A trade-off is only real when the losing option is stated: 'if we do A this quarter, B moves to Q3 and the audit finding stays open'. Without that sentence, the decision is not made; it is deferred to whoever notices the missing work later, usually during an incident or an audit. Naming the loser is uncomfortable, which is exactly why it is the part that makes the decision usable.",
            "Weigh reversibility too. Under uncertainty, prefer bets you can undo: a flag, a pilot, a manual process. Be deliberately slow on one-way doors such as the data model, the public API, or pricing, because those decisions outlive the quarter and their cost is paid by people who were not in the room."
          ],
          "code": "#[derive(Debug, Clone)]\npub struct Candidate {\n    pub id: &'static str,\n    pub value_per_week: f64,\n    pub duration_weeks: f64,\n}\n\nimpl Candidate {\n    /// Cost of delay divided by duration. Short, valuable work first:\n    /// it returns capacity to the queue sooner, which compounds.\n    pub fn cd3(&self) -> f64 {\n        self.value_per_week / self.duration_weeks\n    }\n}\n\n/// Greedy selection under a capacity constraint. Skipping a candidate that\n/// does not fit (instead of stopping) is what keeps small work from being\n/// starved by a large item at the front of the list.\npub fn select(candidates: &[Candidate], capacity_weeks: f64) -> Vec<&Candidate> {\n    let mut ordered: Vec<&Candidate> = candidates.iter().collect();\n    ordered.sort_by(|a, b| {\n        b.cd3()\n            .partial_cmp(&a.cd3())\n            .unwrap_or(std::cmp::Ordering::Equal)\n    });\n\n    let mut remaining = capacity_weeks;\n    let mut chosen = Vec::new();\n\n    for candidate in ordered {\n        if candidate.duration_weeks <= remaining {\n            remaining -= candidate.duration_weeks;\n            chosen.push(candidate);\n        }\n    }\n\n    chosen\n}",
          "tip": "Write the sentence with the loser in it before the planning meeting; if nobody will say it, the decision is not ready."
        },
        {
          "h": "Guard against the biases that order the queue",
          "p": [
            "Sunk cost keeps a failed project funded because stopping admits the earlier spend was wasted. The loudest customer appears representative when they are one data point. Anchoring makes the first number in the room the number everyone argues around. These are documented, predictable biases, and the antidote is procedural: reference-class data, a written pre-mortem, and a rule that a decision can be reopened only with new evidence rather than a new meeting.",
            "A pre-mortem is cheap and unusually effective: assume the quarter failed, and each person writes the reason. The answers surface the risks that politeness suppressed in the planning meeting, and they arrive early enough to change the plan rather than explain it afterwards. Write the reasons down and attach one mitigation to each of the top two."
          ],
          "tip": "Ask 'what would we have to believe for this to be wrong?' before committing capacity, not after."
        }
      ],
      "exercise": {
        "prompt": "Implement CD3 selection under a capacity constraint: rank by value per week divided by duration, skip an item that does not fit without stopping, and report what was left out so the trade-off can be stated in the planning meeting.",
        "starter": "struct Candidate { id: &'static str, value_per_week: f64, duration_weeks: f64 }\n\nimpl Candidate {\n    fn cd3(&self) -> f64 { todo!() }\n}\n\nstruct Plan<'a> {\n    chosen: Vec<&'a Candidate>,\n    skipped: Vec<&'a Candidate>,\n    weeks_used: f64,\n}\n\nfn select<'a>(candidates: &'a [Candidate], capacity_weeks: f64) -> Plan<'a> {\n    todo!()\n}\n\nfn main() {}",
        "hint": "Sort by cd3 descending with partial_cmp and unwrap_or(Ordering::Equal). Walk the sorted list: if duration fits in remaining, take it and subtract; otherwise push to skipped and continue. Never break out of the loop.",
        "solution": "use std::cmp::Ordering;\n\nstruct Candidate {\n    id: &'static str,\n    value_per_week: f64,\n    duration_weeks: f64,\n}\n\nimpl Candidate {\n    fn cd3(&self) -> f64 {\n        self.value_per_week / self.duration_weeks\n    }\n}\n\nstruct Plan<'a> {\n    chosen: Vec<&'a Candidate>,\n    skipped: Vec<&'a Candidate>,\n    weeks_used: f64,\n}\n\nfn select<'a>(candidates: &'a [Candidate], capacity_weeks: f64) -> Plan<'a> {\n    let mut ordered: Vec<&Candidate> = candidates.iter().collect();\n    ordered.sort_by(|a, b| b.cd3().partial_cmp(&a.cd3()).unwrap_or(Ordering::Equal));\n\n    let mut remaining = capacity_weeks;\n    let mut chosen = Vec::new();\n    let mut skipped = Vec::new();\n\n    for candidate in ordered {\n        if candidate.duration_weeks <= remaining {\n            remaining -= candidate.duration_weeks;\n            chosen.push(candidate);\n        } else {\n            skipped.push(candidate);\n        }\n    }\n\n    Plan { chosen, skipped, weeks_used: capacity_weeks - remaining }\n}\n\nfn main() {\n    let work = [\n        Candidate { id: \"audit-fix\", value_per_week: 9_000.0, duration_weeks: 3.0 },\n        Candidate { id: \"checkout-redesign\", value_per_week: 12_000.0, duration_weeks: 8.0 },\n        Candidate { id: \"onboarding-docs\", value_per_week: 1_500.0, duration_weeks: 0.5 },\n        Candidate { id: \"search-index\", value_per_week: 6_000.0, duration_weeks: 4.0 },\n    ];\n\n    let plan = select(&work, 6.0);\n    let ids: Vec<&str> = plan.chosen.iter().map(|c| c.id).collect();\n\n    assert_eq!(ids, vec![\"audit-fix\", \"onboarding-docs\"]);\n    assert!((plan.weeks_used - 3.5).abs() < f64::EPSILON);\n    assert_eq!(plan.skipped.len(), 2);\n    println!(\"chosen: {ids:?}, left out: {:?}\", plan.skipped.iter().map(|c| c.id).collect::<Vec<_>>());\n}"
      },
      "questions": [
        {
          "q": "Why does CD3 rank short, valuable work above long, valuable work with the same total value?",
          "options": [
            "Because short work is easier to estimate accurately",
            "Because finishing sooner returns capacity to the queue and realises the value earlier",
            "Because long work always has hidden dependencies",
            "Because cost of delay is only defined for small items"
          ],
          "answer": 1,
          "explain": "Dividing by duration prices the delay the longer item imposes on everything behind it. The value starts accruing sooner and the team can start the next item sooner."
        },
        {
          "q": "Utilisation on a team rises from 80% to 95% with the same headcount. What should you expect?",
          "options": [
            "The queue shrinks because work is being processed faster",
            "Throughput rises proportionally to utilisation",
            "Waiting time and cycle time rise sharply, so delivery gets later and less predictable",
            "Quality improves because everyone is focused"
          ],
          "answer": 2,
          "explain": "Queues lengthen non-linearly as utilisation approaches the limit. At high utilisation there is no slack to absorb variation, so small delays cascade into long waits."
        },
        {
          "q": "Which planning statement actually makes a trade-off decision?",
          "options": [
            "We need to be more efficient so we can do everything",
            "Let us revisit priorities next month once we have more information",
            "We will prioritise both, with the audit fix slightly ahead",
            "If we take the redesign, the audit fix moves to Q3 and the finding stays open through the next review"
          ],
          "answer": 3,
          "explain": "It names the loser, the consequence, and the time horizon. The others defer the choice, which means someone downstream makes it without the context."
        }
      ],
      "quickbytes": [
        "Replace P1/P2 with cost of delay divided by duration; a ranking key beats a label.",
        "Cap WIP before adding process; queueing, not estimation, is usually the reason dates slip.",
        "State the losing option out loud in the planning note, or the decision is not made."
      ],
      "production": [
        "Work is ranked by a documented cost-of-delay and duration, refreshed each planning cycle.",
        "Work-in-progress limits are enforced per team and visible on the board.",
        "Every committed plan records what was deliberately dropped and why.",
        "Decisions with one-way consequences require a pre-mortem and a named decider."
      ],
      "crates": [
        "serde",
        "clap",
        "chrono"
      ],
      "github": [
        {
          "name": "serde-rs/serde - persist the prioritisation inputs with the plan",
          "url": "https://github.com/serde-rs/serde"
        },
        {
          "name": "chronotope/chrono - quarters, dates, and cost-of-delay windows",
          "url": "https://github.com/chronotope/chrono"
        }
      ],
      "pitfall": "A backlog where every item is P1 and the order is set by the last escalation: the team works on what was shouted about most recently, and the audit finding that nobody shouted about becomes next quarter's incident.",
      "resources": [
        {
          "title": "Top Ten Behavioral Biases in Project Management (sunk cost, anchoring, base rates)",
          "url": "https://arxiv.org/abs/2202.00125",
          "kind": "paper"
        },
        {
          "title": "Business-Driven Technical Debt Prioritization: aligning technical work with business value",
          "url": "https://arxiv.org/abs/2010.09711",
          "kind": "paper"
        },
        {
          "title": "GOTO Conferences: prioritisation, queues, and delivery-flow talks",
          "url": "https://www.youtube.com/@GOTO-",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ec17",
      "n": 17,
      "title": "Product thinking: the engineer's version",
      "minutes": 75,
      "level": "industry",
      "goal": "Connect a change to the behaviour it should alter, instrument it before shipping, and define in advance what result would make you roll it back or delete it.",
      "sections": [
        {
          "h": "Output, outcome, impact",
          "p": [
            "Output is shipped: the endpoint exists, the page renders. Outcome is the behaviour that changed: fewer abandoned checkouts, fewer support tickets asking where the invoice is. Impact is the business number that moves as a result: revenue, retention, cost per order. Engineers are trained to optimise output because it is the part they control and the part that is measurable on the day, which is exactly why it is the part most likely to be mistaken for progress.",
            "Asking which behaviour should change is not a product manager's job being taken over; it is the question that determines the design. If the goal is fewer failed orders, a retry policy and a clearer error message are different features with different costs, and the engineer who knows the goal can pick the cheaper one. Without the goal, the team ships the largest interpretation of the request and calls it thorough."
          ],
          "list": [
            "Write the outcome as a change in user or system behaviour, not a shipped artifact",
            "Name the metric and the segment it applies to",
            "Name the guardrail that must not degrade",
            "Name the date by which the result is judged"
          ],
          "tip": "If you cannot say what user behaviour changes, the feature is a cost with no hypothesis."
        },
        {
          "h": "Instrument before shipping, decide the kill criterion first",
          "p": [
            "A feature flag is not just a rollout mechanism; it is the experiment's control surface. Before the flag goes on, write four things: the success metric, the guardrail metric, the minimum sample size, and the date the experiment ends. The expiry matters most, because flags that outlive their experiment become permanent configuration that nobody dares remove and nobody can explain.",
            "Pre-registering the threshold is what stops the result from being interpreted after the fact. Without it, a flat result becomes 'trending positively' and a bad guardrail becomes 'noise'. The guardrail is the other half: reducing latency by dropping retries looks like a win on the latency dashboard and is a loss on the error-rate dashboard, which is why every success metric needs a counter-metric that would catch the cheap version of the win."
          ],
          "code": "pub struct Experiment {\n    pub flag: &'static str,\n    pub success_metric: &'static str,\n    pub guardrail_metric: &'static str,\n    pub min_samples: u64,\n    pub guardrail_ceiling: f64,\n    pub ends_on_day: u32,\n}\n\npub enum Decision {\n    Hold,\n    Expand,\n    RollBack(&'static str),\n}\n\n/// Pre-registered decision rule: the thresholds are fixed before the data\n/// arrives, so the result cannot be reinterpreted afterwards.\npub fn decide(\n    experiment: &Experiment,\n    samples: u64,\n    guardrail_value: f64,\n    success_delta: f64,\n    day: u32,\n) -> Decision {\n    if day >= experiment.ends_on_day {\n        return Decision::RollBack(\"flag outlived its experiment window\");\n    }\n    if samples < experiment.min_samples {\n        return Decision::Hold;\n    }\n    if guardrail_value > experiment.guardrail_ceiling {\n        return Decision::RollBack(experiment.guardrail_metric);\n    }\n    if success_delta > 0.0 {\n        Decision::Expand\n    } else {\n        Decision::RollBack(experiment.success_metric)\n    }\n}",
          "tip": "An experiment without an end date is a permanent configuration change with extra steps."
        },
        {
          "h": "The permanent cost of a feature",
          "p": [
            "Shipping is the cheap part. A feature then costs configuration combinations, documentation, tests, on-call surface, support scripts, and the cognitive load of everyone who has to decide whether it applies to their case. That cost is paid every quarter for as long as the code exists, and it is invisible in the planning meeting because it arrives after the launch, spread thin across people who never attend.",
            "So ask what would justify deleting it. A feature with no answer to that question has no owner and no sunset, and it will still be there when the team that built it has gone. The engineers who ask this question early are not being obstructive; they are pricing the second and third year of the thing, which is the part the roadmap never shows."
          ],
          "tip": "Every new flag names an owner and an expiry quarter in the pull request description."
        }
      ],
      "exercise": {
        "prompt": "Implement the pre-registered rollout decision: hold while below the minimum sample, roll back when the guardrail is breached, expand only when the success delta is positive, and always roll back once the experiment window has expired.",
        "starter": "struct Experiment {\n    flag: &'static str,\n    min_samples: u64,\n    guardrail_ceiling: f64,\n    ends_on_day: u32,\n}\n\nenum Decision { Hold, Expand, RollBack(&'static str) }\n\nfn decide(experiment: &Experiment, samples: u64, guardrail: f64, success_delta: f64, day: u32) -> Decision {\n    // order matters: expiry, then sample size, then guardrail, then success\n    todo!()\n}\n\nfn main() {}",
        "hint": "Check day >= ends_on_day first so an expired flag cannot be expanded even with great numbers. Then samples < min_samples returns Hold. Then guardrail > ceiling returns RollBack(guardrail_metric). Only then look at success_delta.",
        "solution": "struct Experiment {\n    flag: &'static str,\n    guardrail_metric: &'static str,\n    min_samples: u64,\n    guardrail_ceiling: f64,\n    ends_on_day: u32,\n}\n\n#[derive(Debug, PartialEq, Eq)]\nenum Decision {\n    Hold,\n    Expand,\n    RollBack(&'static str),\n}\n\nfn decide(experiment: &Experiment, samples: u64, guardrail: f64, success_delta: f64, day: u32) -> Decision {\n    if day >= experiment.ends_on_day {\n        return Decision::RollBack(\"experiment window expired\");\n    }\n    if samples < experiment.min_samples {\n        return Decision::Hold;\n    }\n    if guardrail > experiment.guardrail_ceiling {\n        return Decision::RollBack(experiment.guardrail_metric);\n    }\n    if success_delta > 0.0 {\n        Decision::Expand\n    } else {\n        Decision::RollBack(\"success metric did not improve\")\n    }\n}\n\nfn main() {\n    let experiment = Experiment {\n        flag: \"checkout_one_page\",\n        guardrail_metric: \"payment_error_rate\",\n        min_samples: 20_000,\n        guardrail_ceiling: 0.02,\n        ends_on_day: 21,\n    };\n\n    assert_eq!(decide(&experiment, 5_000, 0.01, 0.10, 3), Decision::Hold);\n    assert_eq!(decide(&experiment, 25_000, 0.03, 0.10, 5), Decision::RollBack(\"payment_error_rate\"));\n    assert_eq!(decide(&experiment, 25_000, 0.01, 0.004, 9), Decision::Expand);\n    assert_eq!(decide(&experiment, 25_000, 0.01, 0.0, 12), Decision::RollBack(\"success metric did not improve\"));\n    assert_eq!(decide(&experiment, 99_999, 0.0, 0.5, 21), Decision::RollBack(\"experiment window expired\"));\n\n    println!(\"rollout gate: all five states verified\");\n}"
      },
      "questions": [
        {
          "q": "Which statement describes an outcome rather than an output?",
          "options": [
            "Support tickets asking where the invoice is drop by 40% within two weeks",
            "The frontend bundle is 12 KB smaller",
            "The service now exposes a GET /invoices endpoint",
            "The new invoice page is deployed to all regions"
          ],
          "answer": 0,
          "explain": "An outcome is a change in behaviour with a metric and a window. Deployment, bundle size, and endpoints are outputs: necessary, measurable on the day, and compatible with zero user benefit."
        },
        {
          "q": "Why does every success metric need a guardrail metric?",
          "options": [
            "Because dashboards require at least two charts to be useful",
            "Because the cheapest way to improve most metrics is to degrade something else, and the guardrail makes that trade visible",
            "Because guardrails are required by most experimentation platforms",
            "Because success metrics are usually measured incorrectly"
          ],
          "answer": 1,
          "explain": "Latency improves if you drop retries; conversion improves if you remove a confirmation step. The guardrail is the counter-metric that catches the cheap win before it becomes a support ticket."
        },
        {
          "q": "What is the main risk of a feature flag with no expiry date?",
          "options": [
            "It breaks the experiment's statistical validity",
            "It slows down the configuration service",
            "It becomes permanent configuration that nobody owns, dares remove, or can explain",
            "It cannot be rolled back later"
          ],
          "answer": 2,
          "explain": "Flags that outlive their experiment accumulate as undocumented behaviour. An expiry forces the decision: promote, iterate, or delete."
        }
      ],
      "quickbytes": [
        "Write the outcome as behaviour plus metric plus window before writing the design.",
        "Pre-register success, guardrail, sample size, and end date; the end date is what forces closure.",
        "Ask what would justify deleting the feature in year three; if nothing does, say so now."
      ],
      "production": [
        "Every user-visible change ships behind a flag with an owner and an expiry quarter.",
        "Success and guardrail metrics are defined before rollout, with a minimum sample size.",
        "Flags past their expiry are reported weekly and removed or renewed with a written reason.",
        "Support ticket volume is reviewed alongside the feature's success metric after launch."
      ],
      "crates": [
        "metrics",
        "tracing",
        "serde",
        "clap"
      ],
      "github": [
        {
          "name": "metrics-rs/metrics - counters and histograms for experiment metrics",
          "url": "https://github.com/metrics-rs/metrics"
        },
        {
          "name": "tokio-rs/tracing - correlate the rollout with traces",
          "url": "https://github.com/tokio-rs/tracing"
        }
      ],
      "pitfall": "A shipped feature with no instrumented success metric: the team cannot tell whether it worked, so it stays in the codebase forever, defended by the fact that nobody can prove it failed.",
      "resources": [
        {
          "title": "metrics crate: counters, gauges, and histograms in Rust",
          "url": "https://docs.rs/metrics/latest/metrics/",
          "kind": "docs"
        },
        {
          "title": "metrics-rs/metrics: the facade behind instrumented rollouts",
          "url": "https://github.com/metrics-rs/metrics",
          "kind": "repo"
        },
        {
          "title": "InfoQ: product, delivery, and engineering-leadership talks",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        },
        {
          "title": "Google Tech Talks: measurement, experimentation, and product decisions",
          "url": "https://www.youtube.com/@GoogleTechTalks",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ec18",
      "n": 18,
      "title": "Landing a change in someone else's project",
      "minutes": 75,
      "level": "core",
      "goal": "Contribute to a project you do not own: find the right entry point, match its patch conventions, keep the diff reviewable, and treat review as a negotiation over the project's time.",
      "sections": [
        {
          "h": "Read the project before you read the code",
          "p": [
            "CONTRIBUTING, the issue templates, and the last twenty merged pull requests tell you the real bar, which is often stricter than the written one. Look at review latency, at how many round trips a typical PR takes, and at whether the project prefers discussion first. On projects like Rust, a design change needs an RFC before an implementation, and a pull request that skips that step is closed politely regardless of its quality.",
            "Ask before a large change. A comment saying 'I plan to do X, is that welcome' costs a maintainer thirty seconds and saves you a weekend. The maths is simple: your change is one of hundreds in their queue, and the scarce resource is their attention, so anything you can do to reduce the number of decisions they must make increases the chance your patch lands."
          ],
          "list": [
            "Read CONTRIBUTING and the last merged pull requests, not just the README",
            "Search issues and discussions for the change before writing code",
            "Ask on the issue before any change larger than a bug fix",
            "Check whether the project requires an RFC or a design proposal"
          ],
          "tip": "A one-line comment asking 'is this welcome' is the cheapest step in open source and the most often skipped."
        },
        {
          "h": "Patch etiquette is compression",
          "p": [
            "The kernel's submitting-patches guide is still the best statement of the norm: one logical change per patch, an imperative subject, a body that explains why the change is needed and what it affects, and a sign-off that records the provenance. Unrelated reformatting in the same patch is the classic mistake: it inflates the diff, hides the real change, and forces the reviewer to re-read code they already trust.",
            "Rebase on the target branch before requesting review, and avoid force-pushing while a review is in progress unless the maintainer asked for it; comments attached to lines that moved are how review threads become unreadable. Run the project's CI locally first: formatting, clippy with warnings denied, tests with all features, and a documentation build. Every one of those you can run yourself is attention returned to the project."
          ],
          "code": "#!/usr/bin/env bash\n# .git/hooks/pre-push: match the project's CI before a maintainer spends time.\nset -euo pipefail\n\ncargo fmt --all -- --check\ncargo clippy --all-targets --all-features -- -D warnings\ncargo test --all-features --quiet\nRUSTDOCFLAGS=\"-D warnings\" cargo doc --no-deps --quiet\n\n# Many projects require a Developer Certificate of Origin sign-off per commit.\nupstream=$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || true)\nif [ -n \"$upstream\" ]; then\n  for commit in $(git rev-list --no-merges \"$upstream..HEAD\"); do\n    if ! git log -1 --format=%B \"$commit\" | grep -q '^Signed-off-by: '; then\n      echo \"missing Signed-off-by in $commit\" >&2\n      exit 1\n    fi\n  done\nfi\n\necho \"pre-push checks passed\"",
          "tip": "One logical change per pull request: the diff is the argument, and a mixed diff argues about three things at once."
        },
        {
          "h": "Surviving review without taking it personally",
          "p": [
            "Maintainers are usually volunteers or oversubscribed, and their terse comments are about the patch's cost to the project, not your worth. Answer each comment with a change or a reason. 'Done' is fine; silence is not, because it forces the maintainer to re-check and lengthens the loop. When a maintainer rewrites your patch before merging, that is a compliment to the idea and a statement about the cost of another round trip.",
            "If the change is rejected, ask what would make it acceptable and whether a narrower version would be welcome. A rejection with a reason is useful information about the project's constraints, and the person who responds well to one is remembered when the next opportunity appears. Small, clean contributions compound into review trust, and review trust is what lets a stranger propose a large change later."
          ],
          "tip": "Keep the loop short: respond to every comment, push one fixup commit, and do not rebase mid-review unless asked."
        }
      ],
      "exercise": {
        "prompt": "Write the pre-push hook a first-time contributor should run: formatting check, clippy with warnings denied, tests with all features, a docs build with warnings denied, and a sign-off check on every commit not yet on the upstream branch.",
        "starter": "#!/usr/bin/env bash\n# Save as .git/hooks/pre-push and chmod +x it.\nset -euo pipefail\n\n# 1. cargo fmt --all -- --check\n# 2. cargo clippy --all-targets --all-features -- -D warnings\n# 3. cargo test --all-features --quiet\n# 4. RUSTDOCFLAGS=\"-D warnings\" cargo doc --no-deps --quiet\n# 5. for each commit in @{u}..HEAD: require a Signed-off-by line\n",
        "hint": "Use git rev-parse --abbrev-ref --symbolic-full-name @{u} to find the upstream, guarding for a branch with no upstream via || true. Then loop over git rev-list --no-merges \"$upstream..HEAD\" and grep the commit body for '^Signed-off-by: '.",
        "solution": "#!/usr/bin/env bash\n# .git/hooks/pre-push - mirrors the checks a Rust project runs in CI.\nset -euo pipefail\n\ncargo fmt --all -- --check\ncargo clippy --all-targets --all-features -- -D warnings\ncargo test --all-features --quiet\nRUSTDOCFLAGS=\"-D warnings\" cargo doc --no-deps --quiet\n\nupstream=$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || true)\n\nif [ -z \"$upstream\" ]; then\n  echo \"no upstream configured; skipping sign-off check\" >&2\n  exit 0\nfi\n\nmissing=0\nfor commit in $(git rev-list --no-merges \"$upstream..HEAD\"); do\n  if ! git log -1 --format=%B \"$commit\" | grep -q '^Signed-off-by: '; then\n    echo \"missing Signed-off-by in $commit\" >&2\n    missing=1\n  fi\ndone\n\nif [ \"$missing\" -ne 0 ]; then\n  echo \"amend with: git commit --amend -s --no-edit\" >&2\n  exit 1\nfi\n\necho \"pre-push checks passed\""
      },
      "questions": [
        {
          "q": "You want to refactor a module in a project you do not maintain. What is the best first step?",
          "options": [
            "Fork the project and maintain your own version",
            "Send the patch to the maintainers by email without a pull request",
            "Open the pull request; the diff will speak for itself",
            "Open an issue describing the problem and the proposed shape, and ask whether it is welcome"
          ],
          "answer": 3,
          "explain": "Maintainer attention is the bottleneck, and a large unsolicited refactor asks them to review a decision they did not agree to make. An issue costs a minute and avoids a wasted weekend."
        },
        {
          "q": "Why is unrelated reformatting in a bug-fix patch a problem?",
          "options": [
            "Because it inflates the diff and hides the actual change, forcing reviewers to re-read code they already trust",
            "Because it breaks the project's CI configuration",
            "Because it prevents the patch from being cherry-picked",
            "Because formatting changes are never accepted in open source"
          ],
          "answer": 0,
          "explain": "Review capacity is spent per line of diff. Formatting noise in a semantic patch makes the real change harder to verify and the commit harder to revert or backport."
        },
        {
          "q": "A maintainer rewrites your patch before merging it. How should you read that?",
          "options": [
            "As a rejection of your approach that should be argued in the thread",
            "As acceptance of the idea plus a decision to spend their time rather than another round trip",
            "As a signal that you should stop contributing to this project",
            "As a request to open a follow-up pull request with the same change"
          ],
          "answer": 1,
          "explain": "It is usually the cheapest path to a fix the maintainer wants. Arguing costs another loop; asking what they changed is how you learn the project's conventions for next time."
        }
      ],
      "quickbytes": [
        "Read the last twenty merged PRs; they define the bar more accurately than CONTRIBUTING does.",
        "One logical change per patch, imperative subject, sign-off if the project requires a DCO.",
        "Run the project's CI locally before pushing; every check you skip costs a maintainer a round trip."
      ],
      "production": [
        "Contributions are discussed in an issue before any change larger than a bug fix.",
        "Patches are split by logical change, with no unrelated formatting in a semantic diff.",
        "A pre-push hook mirrors the project's fmt, clippy, test, and doc gates.",
        "Commits carry a Signed-off-by when the project requires a Developer Certificate of Origin."
      ],
      "crates": [
        "cargo-semver-checks",
        "cargo-public-api",
        "cargo-nextest",
        "mdbook"
      ],
      "github": [
        {
          "name": "obi1kenobi/cargo-semver-checks - a project with a public contribution bar",
          "url": "https://github.com/obi1kenobi/cargo-semver-checks"
        },
        {
          "name": "rust-lang/mdBook - docs contributions held to the same CI",
          "url": "https://github.com/rust-lang/mdBook"
        }
      ],
      "pitfall": "A 900-line pull request from an unknown contributor that mixes a rename, a fix, and a new feature: it is closed with 'please split', and the fix that would have been welcome never lands.",
      "resources": [
        {
          "title": "Linux kernel: submitting patches, sign-off, and describing changes",
          "url": "https://docs.kernel.org/process/submitting-patches.html",
          "kind": "docs"
        },
        {
          "title": "The Rust RFC Book: when a change needs a design process first",
          "url": "https://rust-lang.github.io/rfcs/",
          "kind": "docs"
        },
        {
          "title": "firstcontributions/first-contributions: the fork, branch, and PR loop",
          "url": "https://github.com/firstcontributions/first-contributions",
          "kind": "repo"
        },
        {
          "title": "GOTO Conferences: open source maintenance and contribution talks",
          "url": "https://www.youtube.com/@GOTO-",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ec19",
      "n": 19,
      "title": "Career growth through written influence",
      "minutes": 60,
      "level": "industry",
      "goal": "Build evidence of scope, leverage, and durability: artifacts that outlive the sprint, decisions pre-wired with the people who will block them, and a log that makes impact legible without self-promotion.",
      "sections": [
        {
          "h": "Impact is scope times leverage times durability",
          "p": [
            "Scope is what changed because you worked on it, leverage is how many people or systems the change reached, and durability is how long it stays true after you stop maintaining it. A migration that deletes forty thousand lines and removes an on-call rotation beats a feature that ships and is deleted a year later, and the difference is not effort: it is the shape of the effect. Promotion decisions are made on evidence of the next level's scope, not on tenure or volume.",
            "That framing is uncomfortable because it sounds like self-promotion, but the alternative is worse: work whose value is invisible gets allocated to whoever asks, and the person doing the invisible work is assumed to have spare capacity. Writing down what changed and why is how the organization learns what is expensive, which is useful information for everyone, not just for your review."
          ],
          "list": [
            "Scope: the system or team boundary you changed",
            "Leverage: how many people or services the change reached",
            "Durability: what still holds after you move on",
            "Evidence: links to the RFC, the ADR, the postmortem, the diff"
          ],
          "tip": "If your best work this quarter is not written down anywhere, it does not exist at review time."
        },
        {
          "h": "Influence without authority",
          "p": [
            "You cannot decide for another team, but you can make the decision cheap to make. Pre-wire the two people who will block you, one conversation at a time, so the meeting is a confirmation rather than a surprise. Write the one-pager that names the trade-off, the cost, and the thing you are not doing, and let the named decider own the decision. Influence is mostly the work of removing reasons to say no.",
            "This is also how staff-level work happens: the leverage comes from other people adopting your design, not from you implementing it. A document that three teams quote in their own design reviews is worth more than a feature only you can operate, and it scales in a way that your calendar does not."
          ],
          "code": "// Rolling an impact log out of the repository history: the point is not\n// commit count, it is the shape of the work (which areas, which months).\n//\n// git log --no-merges --since=\"6 months ago\" --date=short \\\n//   --pretty=format:'%h|%ad|%s'\n\npub struct MonthSummary {\n    pub month: String,\n    pub commits: usize,\n    pub areas: Vec<String>,\n}\n\npub fn summarize(log: &str) -> Vec<MonthSummary> {\n    let mut months: Vec<MonthSummary> = Vec::new();\n\n    for line in log.lines() {\n        let mut fields = line.splitn(3, '|');\n        let (_hash, date, subject) = match (fields.next(), fields.next(), fields.next()) {\n            (Some(hash), Some(date), Some(subject)) => (hash, date, subject),\n            _ => continue,\n        };\n\n        let month = date.get(..7).unwrap_or(date).to_string();\n        let area = subject\n            .split_once('(')\n            .and_then(|(_, rest)| rest.split_once(')'))\n            .map(|(area, _)| area.to_string())\n            .unwrap_or_else(|| \"core\".to_string());\n\n        match months.iter_mut().find(|entry| entry.month == month) {\n            Some(entry) => {\n                entry.commits += 1;\n                if !entry.areas.contains(&area) {\n                    entry.areas.push(area);\n                }\n            }\n            None => months.push(MonthSummary { month, commits: 1, areas: vec![area] }),\n        }\n    }\n\n    months.sort_by(|a, b| a.month.cmp(&b.month));\n    months\n}",
          "tip": "A design doc that three teams cite is leverage; a feature only you can operate is a second job."
        },
        {
          "h": "Make the invisible work visible",
          "p": [
            "Review, mentoring, and incident work are leverage, and they are invisible in a commit log. Count them: reviews per week, design reviews sponsored, newcomers onboarded, incidents commanded, ADRs authored. These are the numbers that explain why a seemingly unremarkable quarter produced a durable change in how the team works, and without them the person doing the work looks unproductive to anyone reading only the feature list.",
            "Keep a weekly log of five lines: what you decided, what you shipped, what you reviewed, who you unblocked, what you learned. It takes three minutes, and at review time it is the difference between reconstructing a quarter from memory and reading it. The same log is your interview material in two years, which is when the details will have become a story you half-remember."
          ],
          "tip": "Five lines every Friday, with links; memory reconstructs a tidier and less useful quarter than the log."
        }
      ],
      "exercise": {
        "prompt": "Turn a git log dump into an impact summary: one entry per month with the commit count and the distinct conventional-commit areas, sorted by month, skipping lines that do not parse.",
        "starter": "struct MonthSummary { month: String, commits: usize, areas: Vec<String> }\n\nfn summarize(log: &str) -> Vec<MonthSummary> {\n    // input lines look like: abc1234|2026-03-14|feat(checkout): one-page flow\n    // area = text inside the first parentheses; no scope means \"core\"\n    // month = first 7 chars of the date; skip malformed lines\n    todo!()\n}\n\nfn main() {}",
        "hint": "splitn(3, '|') gives hash, date, subject. month = &date[..7]. For the area, split_once('(') then split_once(')') on the remainder; fall back to \"core\". Look up the month entry before pushing a duplicate area.",
        "solution": "use std::collections::BTreeMap;\n\n#[derive(Debug, PartialEq, Eq)]\nstruct MonthSummary {\n    month: String,\n    commits: usize,\n    areas: Vec<String>,\n}\n\nfn summarize(log: &str) -> Vec<MonthSummary> {\n    let mut months: BTreeMap<String, (usize, Vec<String>)> = BTreeMap::new();\n\n    for line in log.lines() {\n        let mut fields = line.splitn(3, '|');\n        let (_hash, date, subject) = match (fields.next(), fields.next(), fields.next()) {\n            (Some(hash), Some(date), Some(subject)) => (hash, date, subject),\n            _ => continue,\n        };\n\n        if date.len() < 7 {\n            continue;\n        }\n        let month = date[..7].to_string();\n\n        let area = subject\n            .split_once('(')\n            .and_then(|(_, rest)| rest.split_once(')'))\n            .map(|(area, _)| area.to_string())\n            .unwrap_or_else(|| \"core\".to_string());\n\n        let entry = months.entry(month).or_insert((0, Vec::new()));\n        entry.0 += 1;\n        if !entry.1.contains(&area) {\n            entry.1.push(area);\n        }\n    }\n\n    months\n        .into_iter()\n        .map(|(month, (commits, areas))| MonthSummary { month, commits, areas })\n        .collect()\n}\n\nfn main() {\n    let log = \"a1b2c3d|2026-01-09|fix(api): reject empty ids\\nd4e5f6a|2026-01-22|feat(api): pagination\\nb7c8d9e|2026-02-03|docs: explain the retry budget\\nbad line\\nf0a1b2c|2026-02-19|chore: bump dependencies\";\n\n    let summary = summarize(log);\n    assert_eq!(summary.len(), 2);\n    assert_eq!(summary[0].month, \"2026-01\");\n    assert_eq!(summary[0].commits, 2);\n    assert_eq!(summary[0].areas, vec![\"api\"]);\n    assert_eq!(summary[1].areas, vec![\"core\"]);\n    println!(\"{summary:?}\");\n}"
      },
      "questions": [
        {
          "q": "Which accomplishment is strongest evidence for a promotion case?",
          "options": [
            "Two years of consistent delivery on the same team",
            "Three features shipped in one quarter",
            "A migration that removed an on-call rotation, with the ADR and the post-incident metrics attached",
            "Being the person who reviews the most pull requests"
          ],
          "answer": 2,
          "explain": "It combines scope, leverage, and durability, with evidence that outlives the quarter. Feature counts measure output, and review volume measures effort, not effect."
        },
        {
          "q": "What does pre-wiring a decision mean?",
          "options": [
            "Getting a verbal approval and skipping the written record",
            "Announcing the decision in the team channel before implementation",
            "Writing the design document before the meeting with all fields complete",
            "Talking to the people who will block the decision before it is proposed publicly, so the meeting confirms rather than debates"
          ],
          "answer": 3,
          "explain": "It removes avoidable surprise and turns a public debate into a confirmation. The written record still matters; pre-wiring is about the order of conversations, not about skipping the decision."
        },
        {
          "q": "Why count reviews, mentoring, and incident command in a weekly log?",
          "options": [
            "Because leverage work is invisible in a commit log and would otherwise read as an unproductive quarter",
            "Because they are easier to measure than shipped features",
            "Because managers only look at numbers",
            "Because those activities are required for promotion at every level"
          ],
          "answer": 0,
          "explain": "The log exists to make durable, multiplying work legible. Without it, the person who unblocked three teams looks like they shipped nothing this quarter."
        }
      ],
      "quickbytes": [
        "Keep a five-line Friday log: decided, shipped, reviewed, unblocked, learned, with links.",
        "Pre-wire the two people who will block the decision before the meeting, one conversation at a time.",
        "Prefer work that stays true after you leave; deletable features are not leverage."
      ],
      "production": [
        "A weekly written log captures decisions, shipped work, reviews, and unblocked people.",
        "Design documents name the decider, the alternatives, and the trade-off accepted.",
        "Mentoring and review load are tracked and reviewed, not assumed to be free.",
        "Promotion cases cite artifacts: ADRs, postmortems, migrations, and the metrics that moved."
      ],
      "crates": [
        "git2",
        "gix",
        "chrono",
        "serde"
      ],
      "github": [
        {
          "name": "rust-lang/git2-rs - read history for an impact log",
          "url": "https://github.com/rust-lang/git2-rs"
        },
        {
          "name": "GitoxideLabs/gitoxide - pure-Rust git with gix for repository analysis",
          "url": "https://github.com/GitoxideLabs/gitoxide"
        }
      ],
      "pitfall": "Waiting for the title before acting at the next level: the work that would justify the promotion is exactly the work nobody assigned, so it never appears in the review packet.",
      "resources": [
        {
          "title": "DevOps Team Structures: how team shape relates to delivery performance",
          "url": "https://arxiv.org/abs/2101.02361",
          "kind": "paper"
        },
        {
          "title": "rustc-dev-guide: a public model of growing contributors into owners",
          "url": "https://rustc-dev-guide.rust-lang.org/",
          "kind": "docs"
        },
        {
          "title": "GOTO Conferences: staff-plus engineering and technical leadership talks",
          "url": "https://www.youtube.com/@GOTO-",
          "kind": "video"
        }
      ]
    },
    {
      "id": "ec20",
      "n": 20,
      "title": "Metrics that do not lie",
      "minutes": 90,
      "level": "industry",
      "goal": "Measure delivery with percentiles and event-derived counts, pair every headline metric with a guardrail, and recognize when a number is being optimised instead of the outcome it stands for.",
      "sections": [
        {
          "h": "Averages hide the failures you care about",
          "p": [
            "Mean latency is a fiction when the distribution is bimodal: a fast cache path and a slow cold path average into a number nobody experiences. Report p50, p95, and p99 from a histogram, and never average percentiles across instances or time windows, because the average of two p99 values is not the p99 of the combined population. Aggregate the underlying histograms first, then compute the percentile once.",
            "Percentiles also need their population named: p99 of all requests is not p99 of requests from paying customers, and the difference decides whether an alert is meaningful. Decide the population, the window, and the minimum sample count before the number goes on a dashboard, because a percentile computed from forty samples is noise with three decimal places."
          ],
          "list": [
            "Histograms, not averages: record the distribution at the source",
            "Aggregate histograms, then compute the percentile, never the reverse",
            "Name the population and the window on the chart itself",
            "Refuse to chart a percentile below a minimum sample count"
          ],
          "tip": "A p99 from forty requests is a rumour; require a minimum sample count or show the count alongside."
        },
        {
          "h": "Derive delivery metrics from events, not surveys",
          "p": [
            "Lead time is commit to deployed, deployment frequency is deploy events per period, change failure rate is the share of deploys that need a hotfix or a rollback, and time to restore is incident start to mitigated. All four are computable from CI, deploy, and incident records, which means they are consistent, auditable, and cheap. If you collect them by asking people how it went, you are measuring memory and optimism.",
            "Each headline metric needs a counter-metric, because the cheapest way to improve any single number is to degrade something adjacent. Deployment frequency without change failure rate rewards reckless releases; change failure rate alone rewards releasing nothing. Lead time without cycle time rewards splitting work into tiny commits that never ship. The pair is the metric; a single number is an invitation to game it."
          ],
          "code": "/// Linear-interpolated percentile over sorted samples.\npub fn percentile(samples: &[u64], q: f64) -> u64 {\n    assert!(!samples.is_empty(), \"percentile of an empty sample\");\n    assert!((0.0..=1.0).contains(&q), \"q must be in 0..=1\");\n\n    let mut sorted = samples.to_vec();\n    sorted.sort_unstable();\n\n    let rank = q * (sorted.len() - 1) as f64;\n    let low = rank.floor() as usize;\n    let high = rank.ceil() as usize;\n\n    if low == high {\n        return sorted[low];\n    }\n\n    let weight = rank - low as f64;\n    let interpolated = sorted[low] as f64 * (1.0 - weight) + sorted[high] as f64 * weight;\n    interpolated.round() as u64\n}\n\npub fn mean(samples: &[u64]) -> f64 {\n    samples.iter().map(|value| *value as f64).sum::<f64>() / samples.len() as f64\n}\n\n// Demonstration on a bimodal distribution: 97 requests at 20 ms and\n// 3 requests at 3,000 ms. The mean reads as acceptable; the tail is\n// what users actually complain about.\n//\n// let mut samples = vec![20u64; 97];\n// samples.extend(std::iter::repeat(3_000).take(3));\n// mean(&samples)              -> 109.4  \"fine, on average\"\n// percentile(&samples, 0.95)  -> 20     \"fine for 95% of requests\"\n// percentile(&samples, 0.99)  -> 3000   \"the actual complaint\"",
          "tip": "Chart the counter-metric next to the headline metric; a dashboard with one number is a target."
        },
        {
          "h": "Reading a dashboard honestly",
          "p": [
            "Segment before you conclude. A flat aggregate can hide one service doubling and another halving, and a median that looks stable can hide a p99 that tripled. Look at trends over weeks rather than single points, annotate deploys and incidents on the chart so the reader can see causality, and give every metric an owner, because an unowned metric is decoration that everyone learns to ignore.",
            "Finally, watch for the metric becoming the goal. When a number is used to evaluate people, it stops describing the system and starts describing what people do to look good: tickets split to raise throughput, incidents reclassified to improve time to restore, tests written to raise coverage. The defence is structural, not moral: pair the metric, keep the raw events, and audit the numbers against a sample of reality once a quarter."
          ],
          "tip": "If a metric is used in performance reviews, assume it is being optimised and audit it against raw events."
        }
      ],
      "exercise": {
        "prompt": "Implement percentile with linear interpolation and a guardrail pair: given deploy outcomes, compute change failure rate and refuse to report it below a minimum sample count, because forty deploys is not a rate.",
        "starter": "struct DeployOutcome { failed: bool }\n\nfn percentile(samples: &[u64], q: f64) -> u64 {\n    // sort a copy, then interpolate between floor and ceil rank\n    todo!()\n}\n\nfn change_failure_rate(deploys: &[DeployOutcome], min_samples: usize) -> Option<f64> {\n    // None when there are fewer than min_samples deploys\n    todo!()\n}\n\nfn main() {}",
        "hint": "For percentile: rank = q * (len - 1), low = floor, high = ceil; if equal return sorted[low], else interpolate and round. For the rate: return None below the minimum, otherwise failures as f64 divided by total.",
        "solution": "struct DeployOutcome {\n    failed: bool,\n}\n\nfn percentile(samples: &[u64], q: f64) -> u64 {\n    assert!(!samples.is_empty(), \"percentile of an empty sample\");\n    assert!((0.0..=1.0).contains(&q), \"q must be in 0..=1\");\n\n    let mut sorted = samples.to_vec();\n    sorted.sort_unstable();\n\n    let rank = q * (sorted.len() - 1) as f64;\n    let low = rank.floor() as usize;\n    let high = rank.ceil() as usize;\n\n    if low == high {\n        return sorted[low];\n    }\n\n    let weight = rank - low as f64;\n    let value = sorted[low] as f64 * (1.0 - weight) + sorted[high] as f64 * weight;\n    value.round() as u64\n}\n\nfn change_failure_rate(deploys: &[DeployOutcome], min_samples: usize) -> Option<f64> {\n    if deploys.len() < min_samples || deploys.is_empty() {\n        return None;\n    }\n    let failed = deploys.iter().filter(|deploy| deploy.failed).count();\n    Some(failed as f64 / deploys.len() as f64)\n}\n\nfn main() {\n    // A bimodal latency distribution: the mean looks acceptable, p99 does not.\n    let mut samples = vec![20u64; 97];\n    samples.extend(std::iter::repeat(3_000).take(3));\n\n    let mean = samples.iter().map(|value| *value as f64).sum::<f64>() / samples.len() as f64;\n    assert!((mean - 109.4).abs() < 0.5);\n    assert_eq!(percentile(&samples, 0.50), 20);\n    assert_eq!(percentile(&samples, 0.95), 20);\n    assert_eq!(percentile(&samples, 0.99), 3_000);\n\n    let deploys = vec![\n        DeployOutcome { failed: false },\n        DeployOutcome { failed: false },\n        DeployOutcome { failed: true },\n        DeployOutcome { failed: false },\n    ];\n\n    assert_eq!(change_failure_rate(&deploys, 10), None);\n    assert_eq!(change_failure_rate(&deploys, 4), Some(0.25));\n\n    println!(\"mean {mean:.1} ms hides p99 {} ms; cfr {:?}\", percentile(&samples, 0.99), change_failure_rate(&deploys, 4));\n}"
      },
      "questions": [
        {
          "q": "Why is averaging p99 values from ten instances wrong?",
          "options": [
            "Because p99 is not a real statistic and cannot be averaged in any case",
            "Because the average of percentiles is not the percentile of the combined population; you must aggregate the histograms first",
            "Because instances with more traffic should be weighted by CPU rather than request count",
            "Because p99 is only defined for a single process"
          ],
          "answer": 1,
          "explain": "Percentiles are not linear functions of the data. Two instances with different traffic profiles produce a combined tail that neither instance shows, and only the underlying distributions can recover it."
        },
        {
          "q": "Deployment frequency rises sharply and change failure rate rises with it. What does the pair indicate?",
          "options": [
            "Nothing: more deploys naturally means more failures in absolute terms",
            "The team is releasing too often and should batch changes",
            "The team is shipping faster at the cost of stability, which is a trade to make explicitly rather than celebrate",
            "The failure rate metric is broken because frequency cannot affect stability"
          ],
          "answer": 2,
          "explain": "Frequency alone would look like improvement. The counter-metric reveals the trade, which is exactly why the pair belongs on one chart and one conversation."
        },
        {
          "q": "A metric is used to evaluate individual engineers. What should you expect?",
          "options": [
            "The team will ask for more metrics to balance it",
            "The number will fall because people are cautious",
            "The metric becomes more accurate because people care about it",
            "The metric stops describing the system and starts describing behaviour aimed at the number"
          ],
          "answer": 3,
          "explain": "This is Goodhart's law in practice. Keep raw events, pair the metric with a counter-metric, and audit samples against reality; structural defences work where exhortation does not."
        }
      ],
      "quickbytes": [
        "Aggregate histograms, then take the percentile; never average percentiles.",
        "Publish delivery metrics as pairs: deployment frequency with change failure rate, lead time with cycle time.",
        "Give every chart an owner, a population, a window, and a minimum sample count."
      ],
      "production": [
        "Latency dashboards use histograms with p50, p95, and p99, plus the request count per window.",
        "The four delivery metrics are computed from CI, deploy, and incident events rather than surveys.",
        "Each headline metric has a counter-metric displayed beside it and reviewed together.",
        "Metrics used in performance discussions are audited against raw events each quarter."
      ],
      "crates": [
        "hdrhistogram",
        "metrics",
        "opentelemetry",
        "tracing"
      ],
      "github": [
        {
          "name": "HdrHistogram/HdrHistogram_rust - record distributions without averaging",
          "url": "https://github.com/HdrHistogram/HdrHistogram_rust"
        },
        {
          "name": "metrics-rs/metrics - counters, gauges, and histograms with a stable facade",
          "url": "https://github.com/metrics-rs/metrics"
        }
      ],
      "pitfall": "A latency dashboard showing the mean: it stays flat while 2% of requests wait three seconds, so the team ships improvements that never reach the users who are complaining.",
      "resources": [
        {
          "title": "hdrhistogram: recording full distributions instead of averages",
          "url": "https://docs.rs/hdrhistogram/latest/hdrhistogram/",
          "kind": "docs"
        },
        {
          "title": "metrics: counters, gauges, and histograms with a stable facade",
          "url": "https://docs.rs/metrics/latest/metrics/",
          "kind": "docs"
        },
        {
          "title": "HdrHistogram_rust: the histogram implementation and its precision guarantees",
          "url": "https://github.com/HdrHistogram/HdrHistogram_rust",
          "kind": "repo"
        },
        {
          "title": "DevOps Team Structures: delivery performance and team shape",
          "url": "https://arxiv.org/abs/2101.02361",
          "kind": "paper"
        }
      ]
    }
  ]
};
