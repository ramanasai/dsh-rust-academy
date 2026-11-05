/**
 * Design principles track.
 *
 * Versions referenced across the lessons: thiserror 2.0.x, serde 1.0.x,
 * axum 0.8.x, sqlx 0.9.x (postgres + runtime-tokio), tokio 1.x,
 * nutype 0.8.x, typed-builder 0.23.x.
 *
 * The track is about judgement, not rules: every lesson names the trade-off
 * and the failure mode that shows up when the principle is applied blindly.
 *
 * Data is JSON-compatible and consumed by the plugin build.
 */
export default {
  key: 'design-principles',
  prefix: 'dp',
  title: 'Design principles',
  blurb: 'Coupling and cohesion, SOLID translated to Rust, type-driven design, invariants, API ergonomics and the judgement calls behind maintainable systems.',
  level: 'industry',
  project: {
    title: 'Capstone: refactor a tangled service by principle',
    brief: 'You inherit an order service where one 900-line module parses HTTP, validates, talks to Postgres, and formats receipts, all through stringly-typed maps. Redesign it in place: draw the before/after module map, move validation to the boundary so invalid values cannot exist inside, replace the error string log with a typed error surface, and write the ADRs for every boundary you keep or move. The code must end up smaller in the hot path than the version you started from.',
    deliverables: [
      'A before/after module map with a coupling analysis: afferent/efferent edges, the shared assumptions removed, and the three you deliberately kept.',
      'Invariants encoded in types (order id, money in minor units, a validated line item) with tests that fail if the constructor guard is removed.',
      'An API ergonomics review of the public surface: parameter types, error variants, and one before/after signature table.',
      'An ADR trail explaining each trade-off: what was merged, what was split, and what would justify reversing the decision.'
    ],
    stack: [
      'serde',
      'thiserror',
      'axum',
      'sqlx',
      'tokio',
      'tracing'
    ]
  },
  lessons: [
    {
      id: 'dp01',
      title: 'Coupling and cohesion: reading a module graph as a change-cost map',
      minutes: 70,
      level: 'core',
      goal: 'Count the assumptions a module makes about its neighbours, separate afferent from efferent coupling, and decide where a boundary pays for itself.',
      sections: [
        {
          h: 'Coupling is a count of assumptions, not imports',
          p: [
            'Two units are coupled when a change in one forces a change in the other. The number that matters is not imports but assumptions: this function assumes that struct exposes a field, that error type still exists, that this call must happen first, that the id is a u64 and not a string. A plain function call is cheap to change because the compiler finds every caller. A public field, a shared table, or a process-wide global is expensive, because the holders of the assumption are invisible from the file you are editing.',
            'Direction matters more than volume. Efferent coupling - what this module depends on - is ordinary and healthy. Afferent coupling - who depends on this module - is what makes an edit expensive, and it is invisible in the file you are looking at. `cargo tree -i -p domain` lists the crates that depend on yours; for a published crate that list extends to users you will never meet. Before widening a signature, ask which of the two counts you are increasing.'
          ],
          list: [
            'Structural: a module names another module type, trait, or feature flag',
            'Temporal: this must be called before that, and nothing in the signature says so',
            'Data: two components agree on a field meaning, encoding, or unit',
            'Semantic: a change in one silently invalidates the other logic with no compile error'
          ],
          tip: 'The cheapest coupling to live with is a call through a narrow, stable interface. The most expensive is a shared assumption that no compiler checks.'
        },
        {
          h: 'Cohesion is one reason to change',
          p: [
            'Cohesion asks whether the parts of a module change for the same reason. A billing module that computes tax, renders a PDF, and sends email has three reasons to change and three audiences; its test needs a mail server. Moving code into one file does not create cohesion, and splitting it into three files does not destroy it. The test is a sentence: name the module job without using the word and.',
            'High cohesion usually looks lopsided - a small public surface over a large private implementation. A module that exports ten functions where every caller uses a different one is a corridor, not a room. A single type with four methods hiding six hundred lines of state machine is cohesive, because there is exactly one reason to open the file and one set of tests that exercise it.'
          ],
          tip: 'If the doc comment for a module needs the word and to describe what it does, it is two modules sharing a filename.'
        },
        {
          h: 'Use the graph the compiler already has',
          p: [
            'You do not need a metrics dashboard to find coupling; the graph is already there. `cargo tree --edges normal` shows crate edges, `cargo modules structure --orphans` prints module edges and flags modules nothing references, and `cargo deny check bans` refuses two versions of the same crate in one graph. None of these see coupling inside a crate, so encode that in visibility: `pub(crate)` by default, with `pub` re-exported only from the crate root.'
          ],
          code: `// BEFORE: the domain cannot exist without the driver, and every
// caller can reach into the row.
pub struct Order {
    pub id: i64,
    pub total_cents: i64,
    pub row: sqlx::postgres::PgRow,
}

// AFTER: the domain owns its shape; the driver is an edge detail.
pub struct Order {
    id: OrderId,
    total: Money,
}

impl Order {
    pub fn id(&self) -> OrderId { self.id }
    pub fn total(&self) -> Money { self.total }
}

// The Postgres repository converts rows at the boundary. Nothing
// outside infra::postgres imports sqlx, so a driver upgrade or a
// column rename touches one module instead of eleven.`,
          tip: 'Delete the public field before you add the accessor. Keeping both keeps both couplings.'
        },
        {
          h: 'Some coupling is the point',
          p: [
            'Zero coupling describes programs that never talk to each other, which is not a system. The target is intentional coupling: every edge buys something nameable, such as one source of truth for an invariant, one implementation of an expensive computation, or one contract where there used to be four copies. The judgement call is the level. Coupling to a stable, narrow interface is cheap; coupling to an unstable detail such as a column name or a constructor argument list is expensive, because the edge changes every time the detail does.'
          ],
          tip: 'Write the reason for each dependency in the module doc comment. A dependency you cannot justify in one clause is usually a copy of code you were avoiding.'
        }
      ],
      exercise: {
        prompt: 'A checkout module reads the tax rate from the environment, writes to Postgres, and formats a receipt. Separate the three reasons to change without adding a framework: make the tax a pure function of data passed in, the write a small trait the caller implements, and the formatting pure. Add one test per seam.',
        starter: `pub struct TaxTable {
    pub rate_bp: u32, // basis points: 825 means 8.25 percent
}

pub fn total_cents(subtotal: u64, table: &TaxTable) -> u64 {
    // 1. pure: no env, no database, no clock
    todo!()
}

pub trait ReceiptSink {
    type Error;
    // 2. the write is a trait; Postgres implements it at the edge
}

pub fn render_receipt(order_id: u64, total_cents: u64) -> String {
    // 3. pure formatting: money in minor units, never floats
    todo!()
}`,
        hint: 'Tax in basis points: subtotal + subtotal * rate_bp / 10_000, all integer maths. The sink takes the already-computed total, so the pure functions stay testable without a database. Implement the sink for an in-memory Vec in the test module.',
        solution: `pub struct TaxTable {
    pub rate_bp: u32,
}

pub fn total_cents(subtotal: u64, table: &TaxTable) -> u64 {
    subtotal + subtotal * u64::from(table.rate_bp) / 10_000
}

pub trait ReceiptSink {
    type Error;
    fn store(&mut self, order_id: u64, total_cents: u64) -> Result<(), Self::Error>;
}

pub fn render_receipt(order_id: u64, total_cents: u64) -> String {
    format!("order {order_id}: {}.{:02}", total_cents / 100, total_cents % 100)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tax_is_integer_math_in_minor_units() {
        let table = TaxTable { rate_bp: 825 };
        assert_eq!(total_cents(10_000, &table), 10_825);
        assert_eq!(render_receipt(7, 10_825), "order 7: 108.25");
    }

    struct InMemory(Vec<(u64, u64)>);

    impl ReceiptSink for InMemory {
        type Error = std::convert::Infallible;

        fn store(&mut self, order_id: u64, total_cents: u64) -> Result<(), Self::Error> {
            self.0.push((order_id, total_cents));
            Ok(())
        }
    }

    #[test]
    fn sink_is_swappable_without_a_database() {
        let mut sink = InMemory(Vec::new());
        sink.store(7, 10_825).unwrap();
        assert_eq!(sink.0, vec![(7, 10_825)]);
    }
}`
      },
      production: [
        'Every module declares its public surface deliberately: pub(crate) internally, pub only through a root re-export.',
        'No domain type exposes a database row, driver error, or HTTP type in a public field or signature.',
        'A CI job runs cargo tree -i for the core crate so reviewers can see new afferent edges in the diff.',
        'Modules that need the word and in their doc comment are split before they grow tests.',
        'Each intentional dependency has one clause in the module docs saying what it buys.'
      ],
      crates: ['cargo-modules', 'cargo-deny', 'serde'],
      pitfall: 'A public struct field that looks harmless becomes the integration point for six call sites; renaming it later is a workspace-wide edit that the compiler forces you to do at the worst possible moment.',
      questions: [
        {
          q: 'Which coupling is hardest to discover and fix when it breaks?',
          options: [
            'A function call that passes an owned struct by value',
            'Two components sharing a database column that both read directly',
            'Depending on std::time::Duration in a public signature',
            'Importing a stable trait from a published crate'
          ],
          answer: 1,
          explain: 'A shared column is an assumption no compiler checks: both sides compile, deploy independently, and disagree at runtime. Function calls and std types are compiler-visible and cheap to change.'
        },
        {
          q: 'A module exports twelve functions and each has exactly one caller in a different module. What does this suggest?',
          options: [
            'The module is highly cohesive because each function is used',
            'It is a corridor: the logic probably belongs behind each caller, not behind one shared facade',
            'It should be published as a crate so the API stabilises',
            'It needs a trait to make the functions object-safe'
          ],
          answer: 1,
          explain: 'Twelve single-consumer exports mean the module is a pass-through. Cohesion is about one reason to change, not about a high call count.'
        },
        {
          q: 'Which is the strongest evidence that billing.rs is cohesive?',
          options: [
            'It is under 200 lines',
            'It has one reason to change: the tax rules',
            'It depends on no other module',
            'It is called from three different places'
          ],
          answer: 1,
          explain: 'Cohesion is measured in reasons to change, not size, import count, or popularity. A file can be large and cohesive, or tiny and a grab bag.'
        }
      ],
      quickbytes: [
        'Count assumptions, not imports: a public field or shared table is a coupling the compiler cannot police.',
        'Ask who depends on this module before changing its signature; cargo tree -i -p <crate> answers it.',
        'Refactor a grab bag by asking which changes travel together, then move the seams, not the files.'
      ],
      github: [
        { name: 'rust-unofficial/patterns - idioms, patterns, and anti-patterns', url: 'https://github.com/rust-unofficial/patterns' },
        { name: 'regexident/cargo-modules - print the module tree and its edges', url: 'https://github.com/regexident/cargo-modules' }
      ],
      resources: [
        {
          title: 'The Rust Book: managing growing projects with packages, crates, and modules',
          url: 'https://doc.rust-lang.org/book/ch07-00-managing-growing-projects-with-packages-crates-and-modules.html',
          kind: 'docs'
        },
        {
          title: 'Rust API Guidelines: future proofing and private fields',
          url: 'https://rust-lang.github.io/api-guidelines/future-proofing.html',
          kind: 'docs'
        },
        {
          title: 'Rust Design Patterns: catalogue of idioms and anti-patterns',
          url: 'https://github.com/rust-unofficial/patterns',
          kind: 'repo'
        },
        {
          title: 'cargo-modules: module graph, orphans, and cycles',
          url: 'https://github.com/regexident/cargo-modules',
          kind: 'repo'
        },
        {
          title: 'Jon Gjengset: Rust design and implementation deep dives',
          url: 'https://www.youtube.com/@jonhoo',
          kind: 'video'
        }
      ]
    },
    {
      id: 'dp02',
      title: 'SOLID translated into Rust: what survives and what does not',
      minutes: 80,
      level: 'core',
      goal: 'Map each SOLID principle onto a Rust mechanism, and pick between enums and trait objects based on who is allowed to add cases.',
      sections: [
        {
          h: 'Single responsibility is a module property',
          p: [
            'SRP says a unit should have one reason to change, not that it should contain one function. In Rust the unit is the module, and the reason to change is usually an external decision: a pricing policy, a wire format, a storage engine. A type that holds both a validated domain value and its serialized form has two reasons to change, which is why `serde` attributes on domain types are a real trade-off rather than a free win.',
            'The practical split is between policy and mechanism. Policy - what a refund means, whether a retry is allowed - changes when the business changes. Mechanism - how bytes are encoded, which HTTP client is used - changes when a dependency does. Keep them in separate modules even when they are twenty lines each, because they are edited by different people on different schedules.'
          ],
          tip: 'A file with one reason to change can still be 800 lines. Size is a readability problem; mixed reasons are a design problem.'
        },
        {
          h: 'Open/closed: choose closed sets or open sets, not both',
          p: [
            'The open/closed principle says a unit should be open for extension and closed for modification. Rust forces you to pick which kind of extension you mean. An enum is closed: adding a variant is a breaking change that produces a compile error at every match, which is exactly what you want for a domain with a known set of cases. A trait is open: downstream crates can add implementations, but adding a required method breaks every implementor, so traits grow through default methods or new supertraits.',
            'The judgement call is who owns the future cases. Payment methods that your billing team ships belong in an enum, where the compiler makes you handle the new case. Extension points that plugin authors ship belong behind a trait, where you accept that you cannot enumerate the implementations. Mixing the two - an enum with a `Custom(Box<dyn Any>)` escape hatch - gives you the costs of both and the guarantees of neither.'
          ],
          list: [
            'Closed set, internal owners: enum, exhaustive match, no wildcard arms',
            'Open set, external owners: trait, object-safe if stored in a collection',
            'Public enum is #[non_exhaustive] if you plan to add variants without a major version',
            'A trait with one implementation is a guess; an enum with one variant is a placeholder'
          ],
          code: `// Closed: adding Card declines to compile until every match handles it.
pub enum PaymentMethod {
    Card { last4: String },
    BankTransfer { iban: String },
}

pub fn fee_bp(method: &PaymentMethod) -> u32 {
    match method {
        PaymentMethod::Card { .. } => 290,
        PaymentMethod::BankTransfer { .. } => 25,
    }
}

// Open: a plugin author can add a method we have never seen.
pub trait PaymentMethodExt {
    fn fee_bp(&self) -> u32;
    fn label(&self) -> &'static str;
}

// The escape hatch is explicit and auditable, not a wildcard.
pub enum ExternalMethod {
    Builtin(PaymentMethod),
    Plugin(Box<dyn PaymentMethodExt + Send + Sync>),
}`,
          tip: 'Every `_ =>` arm on a domain enum is a promise you will remember to revisit it. Prefer the compile error.'
        },
        {
          h: 'Liskov is a behavioural contract the compiler cannot check',
          p: [
            'Substitutability in Rust is syntactic: if `T: Trait`, the compiler accepts it. The behavioural half - that an implementation honours what the trait promises - is enforced only by documentation and tests. The standard library shows the shape of these contracts: `Eq` must be reflexive, symmetric, and transitive, and `Hash` must agree with it, or a `HashMap` silently loses entries. `Ord` must be consistent with `PartialOrd`, and `Display` should be a human-readable rendering that does not lose information users rely on.',
            'For your own traits, write the contract in the trait doc comment and test it generically. A `Repository` trait that promises `save` is idempotent per key needs a test that runs against every implementation, including the in-memory one used in unit tests. If an implementation cannot honour the contract, the trait is wrong: split it rather than documenting an exception that callers must remember.'
          ],
          code: `/// Contract, not suggestion: for the same key, saving twice must leave
/// exactly one record and return the same result.
pub trait Repository {
    type Error;
    fn save(&mut self, key: &str, value: &[u8]) -> Result<(), Self::Error>;
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, Self::Error>;
}

/// Runs the same behavioural suite against every implementation.
pub fn assert_repository_contract<R>(repo: &mut R)
where
    R: Repository,
    R::Error: std::fmt::Debug,
{
    repo.save("k", b"v1").unwrap();
    repo.save("k", b"v2").unwrap();
    assert_eq!(repo.get("k").unwrap().as_deref(), Some(&b"v2"[..]));
}`,
          tip: 'If a trait method can be implemented in a way that breaks callers, the contract belongs in a test every implementor runs.'
        }
      ],
      exercise: {
        prompt: 'A payment enum is matched in four places. Finance wants a closed set they control, but a partner needs to add a wallet method without a release. Keep the enum for the built-ins, add an explicit extension trait for partners, and prove both paths compute a fee without a wildcard arm hiding a missing case.',
        starter: `pub enum PaymentMethod {
    Card { last4: String },
    Transfer { iban: String },
}

pub fn fee_bp(method: &PaymentMethod) -> u32 {
    todo!()
}

pub trait PartnerMethod {
    fn fee_bp(&self) -> u32;
}

// 3. One type that can be either, so callers stay monomorphic.
pub enum AnyMethod<'a> {
    Builtin(&'a PaymentMethod),
    Partner(&'a dyn PartnerMethod),
}

pub fn fee_for(method: AnyMethod<'_>) -> u32 {
    todo!()
}`,
        hint: 'fee_for matches Builtin to fee_bp and Partner to the trait method; no wildcard anywhere. Add a test partner struct with fee_bp() = 100 and assert both branches.',
        solution: `pub enum PaymentMethod {
    Card { last4: String },
    Transfer { iban: String },
}

pub fn fee_bp(method: &PaymentMethod) -> u32 {
    match method {
        PaymentMethod::Card { .. } => 290,
        PaymentMethod::Transfer { .. } => 25,
    }
}

pub trait PartnerMethod {
    fn fee_bp(&self) -> u32;
}

pub enum AnyMethod<'a> {
    Builtin(&'a PaymentMethod),
    Partner(&'a dyn PartnerMethod),
}

pub fn fee_for(method: AnyMethod<'_>) -> u32 {
    match method {
        AnyMethod::Builtin(builtin) => fee_bp(builtin),
        AnyMethod::Partner(partner) => partner.fee_bp(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Wallet;

    impl PartnerMethod for Wallet {
        fn fee_bp(&self) -> u32 {
            100
        }
    }

    #[test]
    fn both_paths_are_fee_bearing() {
        let card = PaymentMethod::Card { last4: "4242".into() };
        let wallet = Wallet;
        assert_eq!(fee_for(AnyMethod::Builtin(&card)), 290);
        assert_eq!(fee_for(AnyMethod::Partner(&wallet)), 100);
    }
}`
      },
      production: [
        'Domain enums have no wildcard arms; a new variant fails the build until every match handles it.',
        'Public enums that may grow are #[non_exhaustive]; internal enums are not, so the compiler stays strict.',
        'Every trait with more than one implementation ships a behavioural contract test that runs against all of them.',
        'No enum carries a dyn Any escape hatch; external extension gets its own trait and its own variant.',
        'SRP reviews name the reason to change out loud before proposing a split.'
      ],
      crates: ['thiserror', 'serde', 'axum'],
      pitfall: 'Adding a wildcard arm to silence a match when a new payment variant lands: the compiler stops helping, and the new method quietly charges zero fees until someone notices in the ledger.',
      questions: [
        {
          q: 'You add a variant to a public enum that downstream crates match on. What breaks?',
          options: [
            'Nothing, as long as the enum derives Debug',
            'Downstream exhaustive matches, unless the enum is #[non_exhaustive] and they already have a wildcard',
            'Only crates that construct the enum, not those that match it',
            'Nothing, because enum layout is stable across versions'
          ],
          answer: 1,
          explain: 'A new variant is a breaking change for exhaustive matches. #[non_exhaustive] forces downstream wildcards from day one, trading compile-time exhaustiveness for future freedom.'
        },
        {
          q: 'Which trait contract does the Rust compiler enforce?',
          options: [
            'That Hash agrees with Eq for every implementation',
            'That Display never loses information',
            'That a Repository save is idempotent',
            'That a type implementing Ord is totally ordered'
          ],
          answer: 3,
          explain: 'The compiler sees the impl block, not its behaviour. Hash/Eq agreement, Display fidelity, and idempotency are documented contracts that only tests can enforce.'
        },
        {
          q: 'When is a trait the wrong tool compared with an enum?',
          options: [
            'When implementors will live in downstream crates you do not control',
            'When the set of cases is known and owned by one team that ships them together',
            'When you need dynamic dispatch over a heterogeneous collection',
            'When implementations need different data layouts'
          ],
          answer: 1,
          explain: 'Traits are for open sets. If one team ships every case on one schedule, an enum gives exhaustiveness checks and better compiler diagnostics for free.'
        }
      ],
      quickbytes: [
        'Enums for closed sets you own; traits for open sets others extend; never both in one type.',
        'Write trait contracts as tests that run against every implementation, not as doc-comment wishes.',
        'Delete wildcard arms on domain enums; the compile error is the review.'
      ],
      github: [
        { name: 'rust-unofficial/patterns - SOLID-adjacent idioms in Rust', url: 'https://github.com/rust-unofficial/patterns' },
        { name: 'rust-lang/api-guidelines - the official API design checklist', url: 'https://github.com/rust-lang/api-guidelines' }
      ],
      resources: [
        {
          title: 'The Rust Book: using trait objects to allow for values of different types',
          url: 'https://doc.rust-lang.org/book/ch17-02-trait-objects.html',
          kind: 'docs'
        },
        {
          title: 'Rust API Guidelines: predictability and only smart pointers implement Deref',
          url: 'https://rust-lang.github.io/api-guidelines/predictability.html',
          kind: 'docs'
        },
        {
          title: 'std::cmp::Ord: the total-order contract implementors must honour',
          url: 'https://doc.rust-lang.org/std/cmp/trait.Ord.html',
          kind: 'docs'
        },
        {
          title: 'Rust API Guidelines repository and issue discussions',
          url: 'https://github.com/rust-lang/api-guidelines',
          kind: 'repo'
        },
        {
          title: 'Jon Gjengset: trait design, object safety, and dispatch',
          url: 'https://www.youtube.com/@jonhoo',
          kind: 'video'
        }
      ]
    },
    {
      id: 'dp03',
      title: 'Composition over inheritance: fields, forwarding, and the Deref trap',
      minutes: 65,
      level: 'core',
      goal: 'Assemble behaviour from owned parts and forwarding impls, and recognise the Deref trick that pretends Rust has subclassing.',
      sections: [
        {
          h: 'Rust has no inheritance, so the question changes',
          p: [
            'The inheritance question - what does this type share with its parent - becomes two Rust questions: what does this type own, and which traits does it implement. Shared behaviour lives either in a generic bound (the caller supplies it), in a composed field (this type delegates to it), or in a default trait method (the implementor overrides it). All three are explicit at the definition site, which is the point: you cannot inherit a method by accident from a base class three levels up.',
            'Composition is the default because Rust makes it cheap. A struct field plus a forwarding impl costs a few lines and gives you a type whose dependencies are visible in its definition. The failure mode of inheritance - the fragile base class, where a parent change silently alters a child - cannot happen through a field, because a field has no behaviour of its own until you delegate to it.'
          ],
          tip: 'Prefer a field plus an explicit method over a base struct with methods; the definition then reads as a list of what the type actually depends on.'
        },
        {
          h: 'Forwarding impls and the delegate macro',
          p: [
            'When a wrapper exists to add one behaviour, it still has to satisfy the trait bounds of everything it wraps. Writing `impl fmt::Display for Wrapper` by hand is three lines and completely transparent. When a newtype must forward ten methods, hand-written forwarding becomes noise; the `delegate` crate generates it with an explicit list, so the forwarded surface stays greppable and the unforwarded methods stay deliberately absent.',
            'Be careful which direction you forward. Forwarding a rich trait like `Deref` or `Borrow` exposes the whole inner API and recreates inheritance with none of its checks. Forwarding a narrow trait like `Display`, `Serialize`, or `AsRef<str>` keeps the wrapper closed: callers can use it where the inner type is accepted, but cannot reach methods you did not choose to expose.'
          ],
          code: `use std::fmt;

pub struct Meters(f64);

// Narrow forwarding: Display only. No Deref, so callers cannot
// reach f64 methods that would bypass the unit.
impl fmt::Display for Meters {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:.2} m", self.0)
    }
}

// Composition: behaviour comes from owned parts, not a base type.
pub struct Checkout<C: Clock, P: Pricing> {
    clock: C,
    pricing: P,
}

impl<C: Clock, P: Pricing> Checkout<C, P> {
    pub fn new(clock: C, pricing: P) -> Self {
        Self { clock, pricing }
    }

    pub fn quote(&self, lines: &[Line]) -> Quote {
        Quote {
            total: self.pricing.total(lines),
            issued_at: self.clock.now(),
        }
    }
}

pub trait Clock {
    fn now(&self) -> std::time::SystemTime;
}

pub trait Pricing {
    fn total(&self, lines: &[Line]) -> u64;
}

pub struct Line {
    pub unit_cents: u64,
    pub quantity: u32,
}

pub struct Quote {
    pub total: u64,
    pub issued_at: std::time::SystemTime,
}`,
          tip: 'Forward one trait at a time and name why. Forwarding everything is inheritance with extra steps and worse errors.'
        },
        {
          h: 'Deref is for smart pointers, not for base classes',
          p: [
            'The tempting shortcut is `impl Deref<Target = Inner>` on a newtype: method resolution then finds the inner methods, so the wrapper appears to inherit them. The cost arrives later. Deref coercion silently converts `&Wrapper` to `&Inner` at call sites, including in code you did not write, so any function taking `&Inner` accepts your wrapper and skips its invariants. The API guidelines state the rule plainly: only smart pointers implement Deref, because only there does the coercion preserve meaning.',
            'There is a second cost: when both the wrapper and the inner type define a method with the same name, resolution picks the wrapper, and a reader cannot tell from the call site which one runs. If you need access to the inner value, expose it through a named, explicit method whose signature states whether it borrows or consumes.'
          ],
          list: [
            'Deref: only for pointers, because coercion is the point',
            'AsRef: for a lossless borrow, when generic code needs it',
            'Into: for an explicit consuming conversion',
            'A named method like into_inner or as_str: when none of the above is semantically true'
          ],
          code: `// Bad: every &UserEmail silently becomes &String, skipping validation
// at any call site that takes &String.
pub struct UserEmail(String);
impl std::ops::Deref for UserEmail {
    type Target = String;
    fn deref(&self) -> &String { &self.0 }
}

// Good: one explicit borrow with a name that promises no validation loss.
impl UserEmail {
    pub fn as_str(&self) -> &str { &self.0 }
}`,
          tip: 'If removing the Deref impl breaks thirty call sites, those call sites were relying on an invariant hole.'
        }
      ],
      exercise: {
        prompt: 'Build a composed Service that owns a Clock and a Store, and a Metered wrapper that forwards only the Service trait while counting calls. No Deref anywhere; the wrapper must not expose store methods it does not own.',
        starter: `use std::sync::atomic::{AtomicU64, Ordering};

pub trait Clock {
    fn now_ms(&self) -> u64;
}

pub trait Store {
    fn put(&mut self, key: &str, value: &str);
}

pub trait Service {
    fn handle(&mut self, key: &str, value: &str) -> u64;
}

pub struct Basic<S: Store, C: Clock> {
    pub store: S,
    pub clock: C,
}

impl<S: Store, C: Clock> Service for Basic<S, C> {
    fn handle(&mut self, key: &str, value: &str) -> u64 {
        // store the value, return the clock reading
        todo!()
    }
}

pub struct Metered<T: Service> {
    pub inner: T,
    pub calls: AtomicU64,
}

impl<T: Service> Service for Metered<T> {
    fn handle(&mut self, key: &str, value: &str) -> u64 {
        todo!()
    }
}`,
        hint: 'Basic::handle calls self.store.put then self.clock.now_ms(). Metered::handle increments calls with fetch_add(1, Ordering::Relaxed) and delegates. Leave Store out of Metered public surface: no Deref, no forwarding impl.',
        solution: `use std::sync::atomic::{AtomicU64, Ordering};

pub trait Clock {
    fn now_ms(&self) -> u64;
}

pub trait Store {
    fn put(&mut self, key: &str, value: &str);
}

pub trait Service {
    fn handle(&mut self, key: &str, value: &str) -> u64;
}

pub struct Basic<S: Store, C: Clock> {
    pub store: S,
    pub clock: C,
}

impl<S: Store, C: Clock> Service for Basic<S, C> {
    fn handle(&mut self, key: &str, value: &str) -> u64 {
        self.store.put(key, value);
        self.clock.now_ms()
    }
}

pub struct Metered<T: Service> {
    pub inner: T,
    pub calls: AtomicU64,
}

impl<T: Service> Service for Metered<T> {
    fn handle(&mut self, key: &str, value: &str) -> u64 {
        self.calls.fetch_add(1, Ordering::Relaxed);
        self.inner.handle(key, value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct VecStore(Vec<(String, String)>);
    impl Store for VecStore {
        fn put(&mut self, key: &str, value: &str) {
            self.0.push((key.to_owned(), value.to_owned()));
        }
    }

    struct FixedClock;
    impl Clock for FixedClock {
        fn now_ms(&self) -> u64 { 1_700_000_000_000 }
    }

    #[test]
    fn composition_wires_without_inheritance() {
        let basic = Basic { store: VecStore(Vec::new()), clock: FixedClock };
        let mut metered = Metered { inner: basic, calls: AtomicU64::new(0) };

        assert_eq!(metered.handle("k", "v"), 1_700_000_000_000);
        metered.handle("k2", "v2");

        assert_eq!(metered.calls.load(Ordering::Relaxed), 2);
        assert_eq!(metered.inner.store.0.len(), 2);
    }
}`
      },
      production: [
        'No Deref impl on a domain newtype; the coercion hole is reviewed as a design bug, not a style nit.',
        'Wrappers forward a named list of traits, and the list is the wrapper documented contract.',
        'A struct definition reads as its dependencies: fields are the collaborators, not a base object.',
        'Generic parameters are used where the caller chooses the implementation; dyn is used only where the set is decided at runtime.',
        'Extension happens by adding a field or a trait impl, never by copying a parent method into a child.'
      ],
      crates: ['delegate', 'serde', 'tracing'],
      pitfall: 'Implementing Deref on a validated newtype so callers can use String methods: every function taking &String now accepts the unvalidated path, and the invariant erodes one call site at a time.',
      questions: [
        {
          q: 'What does impl Deref for a newtype actually give callers?',
          options: [
            'A checked conversion that validates the inner value',
            'Implicit coercion to the inner type, so functions taking &Inner accept the wrapper',
            'A copy of the inner type methods with the wrapper invariants applied',
            'A trait bound that makes the wrapper object-safe'
          ],
          answer: 1,
          explain: 'Deref drives method resolution and coercion. Coercion is exactly the hole: &Wrapper becomes &Inner at call sites that never agreed to accept the wrapper.'
        },
        {
          q: 'A base struct holds shared methods and three structs embed it. What is the Rust-native alternative?',
          options: [
            'Implement Deref on each child so the base methods appear',
            'Put the behaviour in a trait with a default method, or in free functions over the shared data',
            'Use inheritance through a proc macro',
            'Make the base struct generic over its children'
          ],
          answer: 1,
          explain: 'Shared behaviour belongs in a trait or a function taking the shared data. Deref recreates inheritance and its implicit surface; macros do not create subtyping.'
        },
        {
          q: 'When is a wrapper worth writing instead of a type alias?',
          options: [
            'When you need a shorter name for a long generic type',
            'When the wrapper enforces an invariant or adds a behaviour the inner type must not gain',
            'When you want deref access to the inner methods',
            'When the inner type is from the standard library'
          ],
          answer: 1,
          explain: 'A newtype buys a distinct type with its own invariants and trait impls. A type alias buys nothing at the type level; it is the same type with a nickname.'
        }
      ],
      quickbytes: [
        'Compose with fields and forward narrow traits; leave the inner API unreachable unless you mean to publish it.',
        'Never Deref a domain newtype: coercion is an invariant bypass with good manners.',
        'Generic parameters for implementations chosen at compile time; dyn for implementations chosen at runtime.'
      ],
      github: [
        { name: 'kobzol/rust-delegate - explicit method forwarding without Deref', url: 'https://github.com/kobzol/rust-delegate' },
        { name: 'rust-unofficial/patterns - delegation and newtype idioms', url: 'https://github.com/rust-unofficial/patterns' }
      ],
      resources: [
        {
          title: 'Rust API Guidelines: only smart pointers implement Deref and DerefMut',
          url: 'https://rust-lang.github.io/api-guidelines/predictability.html',
          kind: 'docs'
        },
        {
          title: 'The Rust Book: object-oriented features and trait objects',
          url: 'https://doc.rust-lang.org/book/ch18-01-what-is-oo.html',
          kind: 'docs'
        },
        {
          title: 'delegate crate: method forwarding for newtypes',
          url: 'https://docs.rs/delegate/latest/delegate/',
          kind: 'docs'
        },
        {
          title: 'Rust Design Patterns: newtype and delegation patterns',
          url: 'https://github.com/rust-unofficial/patterns',
          kind: 'repo'
        }
      ]
    },
    {
      id: 'dp04',
      title: 'Information hiding: private fields, sealed traits, opaque types',
      minutes: 75,
      level: 'core',
      goal: 'Hide the decision most likely to change, and use visibility, sealed traits, and #[non_exhaustive] to keep the freedom to change it.',
      sections: [
        {
          h: 'Hide the decision, not the code',
          p: [
            'Parnas framed modularisation as information hiding: each module should conceal a design decision likely to change, and expose only what callers must know to use it. The decision might be the storage engine, the wire format, the shape of an id, or the algorithm behind a total. Hiding code without hiding a decision is just a folder. A module that exposes every internal type through `pub` has published its decisions and owes its users compatibility with all of them.',
            'Rust gives three distinct levels of visibility: private to the module, `pub(crate)` within the crate, and `pub` to the world. Most code should live at the first two. The interesting cases are the ones where a type must be public for callers to name it, but its construction must not be: a public struct with private fields keeps the type in every signature while reserving the right to change how it is built.'
          ],
          list: [
            'Private field: callers can hold and pass the value, not forge it',
            'pub(crate): the rest of the crate is one design unit',
            'pub re-export at the crate root: one documented path, internals move freely',
            '#[doc(hidden)] is a social convention, not a visibility boundary'
          ],
          tip: 'The question is never how do I make this private, but which decision am I promising never to revisit.'
        },
        {
          h: 'Sealed traits: public to use, closed to implement',
          p: [
            'A trait can be public so callers can write bounds and call methods, while still being impossible to implement outside your crate. The trick is a supertrait that lives in a private module: `pub trait Store: private::Sealed`. Downstream crates can use `Store` as a bound and call its methods, but they cannot name `Sealed`, so they cannot write an impl. That reserves the right to add methods, change defaults, or rework semantics in a minor release.',
            'Sealing has a real cost: nobody can write a test double for your trait. That is why the pattern belongs on extension points you intend to own - iteration protocols, formatting traits, database driver traits - and not on the repository interface your own tests need to fake. If you want a sealed extension point and testability, provide a public constructor that accepts the behaviour as a closure, or ship the test double yourself behind a feature flag.'
          ],
          code: `mod private {
    pub trait Sealed {}
}

/// Public to use, closed to implement. Adding a method later is
/// not a breaking change because every impl lives in this crate.
pub trait Connection: private::Sealed {
    fn execute(&mut self, sql: &str) -> Result<u64, Error>;
}

pub struct PgConnection {
    // private fields: callers cannot build one with an arbitrary state
    socket: std::net::TcpStream,
}

impl private::Sealed for PgConnection {}

impl Connection for PgConnection {
    fn execute(&mut self, _sql: &str) -> Result<u64, Error> {
        todo!()
    }
}

impl PgConnection {
    /// The only constructor: validates and connects.
    pub fn connect(dsn: &str) -> Result<Self, Error> {
        todo!()
    }
}

#[derive(Debug)]
pub struct Error;`,
          tip: 'Seal traits you own and expect to change. Leave open the traits your own tests must implement, or you will write the double against a wrapper and test nothing.'
        },
        {
          h: 'Non-exhaustive: keep the right to add',
          p: [
            '`#[non_exhaustive]` changes the contract of a public type: downstream crates cannot construct the struct with a literal, cannot match an enum without a wildcard arm, and cannot rely on the exact set of variants. In exchange you can add a field or a variant without a major version. It is the smallest possible information-hiding tool and the one most often forgotten until the first breaking release.',
            'Apply it deliberately. On an error enum it is almost always right, because new failure modes appear. On a config struct with a builder it is usually right. On a plain data transfer type in a service you own end to end it is noise: every construction site in your own crate now needs `..Default::default()`, and you gain freedom you did not need. The rule is to seal what other people consume, not what your own crate constructs in fifty places.'
          ],
          code: `#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum StoreError {
    #[error("key not found: {0}")]
    NotFound(String),
    #[error("connection closed")]
    Closed,
    // A later release can add RateLimited without a major bump.
}

// Non-exhaustive struct: callers cannot construct it directly, so a
// new field is not a breaking change.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct StoreConfig {
    pub path: std::path::PathBuf,
    pub read_only: bool,
}

impl StoreConfig {
    pub fn new(path: impl Into<std::path::PathBuf>) -> Self {
        Self { path: path.into(), read_only: false }
    }
}`,
          tip: 'Add #[non_exhaustive] when the type crosses a crate boundary you do not control, and leave it off for internal plumbing.'
        }
      ],
      exercise: {
        prompt: 'Write a TokenBucket whose refill rate and capacity are private, expose only try_acquire, and seal the Refill trait so downstream code can use it as a bound but cannot implement it. Prove the seal with a comment showing the failed impl.',
        starter: `mod private {
    pub trait Sealed {}
}

pub trait Refill: private::Sealed {
    fn tokens(&self, elapsed_ms: u64) -> u64;
}

pub struct Steady {
    pub per_second: u64,
}

impl private::Sealed for Steady {}

impl Refill for Steady {
    fn tokens(&self, elapsed_ms: u64) -> u64 {
        todo!()
    }
}

pub struct TokenBucket {
    // private: capacity and rate are decisions, not API
}

impl TokenBucket {
    pub fn new(capacity: u64, refill: Steady, now_ms: u64) -> Self {
        todo!()
    }

    pub fn try_acquire(&mut self, now_ms: u64) -> bool {
        todo!()
    }
}`,
        hint: 'Store capacity, available, refill, and last_refill_ms as private fields. On try_acquire compute elapsed from last_refill_ms, add refill.tokens(elapsed) capped at capacity, update the timestamp, then take one token if available.',
        solution: `mod private {
    pub trait Sealed {}
}

pub trait Refill: private::Sealed {
    fn tokens(&self, elapsed_ms: u64) -> u64;
}

pub struct Steady {
    pub per_second: u64,
}

impl private::Sealed for Steady {}

impl Refill for Steady {
    fn tokens(&self, elapsed_ms: u64) -> u64 {
        self.per_second * elapsed_ms / 1_000
    }
}

pub struct TokenBucket {
    capacity: u64,
    available: u64,
    refill: Steady,
    last_refill_ms: u64,
}

impl TokenBucket {
    pub fn new(capacity: u64, refill: Steady, now_ms: u64) -> Self {
        Self { capacity, available: capacity, refill, last_refill_ms: now_ms }
    }

    pub fn try_acquire(&mut self, now_ms: u64) -> bool {
        let elapsed = now_ms.saturating_sub(self.last_refill_ms);
        if elapsed > 0 {
            self.available = (self.available + self.refill.tokens(elapsed)).min(self.capacity);
            self.last_refill_ms = now_ms;
        }
        if self.available > 0 {
            self.available -= 1;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refills_at_the_declared_rate_and_caps_at_capacity() {
        let mut bucket = TokenBucket::new(2, Steady { per_second: 1 }, 0);
        assert!(bucket.try_acquire(0));
        assert!(bucket.try_acquire(0));
        assert!(!bucket.try_acquire(0));

        // One second later, one token is back; capacity still caps at 2.
        assert!(bucket.try_acquire(1_000));
        assert!(!bucket.try_acquire(1_000));
        assert!(bucket.try_acquire(10_000));
    }
}`
      },
      production: [
        'Public structs in a library crate have private fields plus constructors that validate.',
        'Public error enums are #[non_exhaustive]; the wildcard arm exists in downstream code from the first release.',
        'Extension-point traits are sealed unless the test double needs to live outside the crate.',
        'Each crate exposes one documented path to each type through re-exports, so internals can move.',
        'No public function returns a private-module type that leaks a hidden decision, including impl Trait where the trait is unstable.'
      ],
      crates: ['thiserror', 'serde', 'axum'],
      pitfall: 'A public struct with public fields that later needs validation: every construction site in every consumer must be found and updated, and in the meantime half of them still build the invalid state.',
      questions: [
        {
          q: 'What does sealing a trait with a private supertrait actually prevent?',
          options: [
            'Calling the trait methods from downstream crates',
            'Downstream crates writing their own implementations of the trait',
            'Using the trait as a generic bound',
            'Adding methods to the trait in a minor release'
          ],
          answer: 1,
          explain: 'Sealing blocks impls, not use. Callers can still name the trait, call its methods, and use it as a bound; they just cannot add an implementation you would have to keep compatible.'
        },
        {
          q: 'You mark a public struct #[non_exhaustive]. What breaks for downstream crates immediately?',
          options: [
            'They cannot read its public fields',
            'They cannot construct it with a struct literal',
            'They cannot implement traits for it',
            'They cannot match on it'
          ],
          answer: 1,
          explain: 'Non-exhaustive removes literal construction (and matching without a wildcard for enums). Field reads stay available, which is why it is a cheap way to reserve growth.'
        },
        {
          q: 'When is #[doc(hidden)] the wrong tool?',
          options: [
            'When documenting a re-export used by a macro',
            'When you need the compiler to actually prevent downstream use',
            'When hiding an implementation detail from rendered docs',
            'When marking a public item used only by generated code'
          ],
          answer: 1,
          explain: 'doc(hidden) only affects documentation. The item is still public and reachable, so it is a compatibility promise you are pretending not to have made.'
        }
      ],
      quickbytes: [
        'Public type with private fields: callers can pass it around but only you can build it validly.',
        'Seal traits you intend to grow; leave open the traits your tests need to fake.',
        'Add #[non_exhaustive] where the type crosses a crate boundary, not on internal plumbing.'
      ],
      github: [
        { name: 'rust-lang/api-guidelines - private fields, sealed traits, future proofing', url: 'https://github.com/rust-lang/api-guidelines' },
        { name: 'dtolnay/thiserror - opaque error pattern with #[error(transparent)]', url: 'https://github.com/dtolnay/thiserror' }
      ],
      resources: [
        {
          title: 'The Rust Reference: visibility and privacy',
          url: 'https://doc.rust-lang.org/reference/visibility-and-privacy.html',
          kind: 'docs'
        },
        {
          title: 'Rust API Guidelines: sealed traits, private fields, no duplicated bounds',
          url: 'https://rust-lang.github.io/api-guidelines/future-proofing.html',
          kind: 'docs'
        },
        {
          title: 'thiserror: transparent errors that hide the representation',
          url: 'https://docs.rs/thiserror/latest/thiserror/',
          kind: 'docs'
        },
        {
          title: 'Rust API Guidelines repository',
          url: 'https://github.com/rust-lang/api-guidelines',
          kind: 'repo'
        }
      ]
    },
    {
      id: 'dp05',
      title: 'Interface segregation: small traits, honest test doubles',
      minutes: 70,
      level: 'advanced',
      goal: 'Split fat traits into capability traits, keep every method that exists actually implementable, and notice when unimplemented! is hiding a design error.',
      sections: [
        {
          h: 'A fat trait taxes every implementor',
          p: [
            'Interface segregation says no client should depend on methods it does not use. In Rust the cost is visible at the impl site: a trait with fourteen methods forces every implementor to write fourteen bodies, and the ones that do not apply become `unimplemented!()`. That macro is a runtime panic waiting for the first caller who assumes the whole trait works. The compiler cannot tell you which methods are meaningful for a given implementation, because the trait said they all were.',
            'Fat traits also make test doubles expensive. A unit test that needs one method of a fourteen-method repository must stub thirteen. Developers respond by stubbing with panics, which turns an accidentally-called method into a test crash rather than a compile error - better than production, but still a signal the interface is wrong. The smallest interface that satisfies the caller is also the cheapest double to write.'
          ],
          tip: 'Count the unimplemented!() bodies in your trait impls. Each one is a method that does not belong in that trait.'
        },
        {
          h: 'Split by capability, not by entity',
          p: [
            'The usual mistake is to model an entity as one trait: `UserStore` with find, save, delete, list, count, export. But callers need capabilities, not entities. The HTTP handler that renders a profile needs lookup; the signup path needs insert; the admin export needs iteration. Split into `UserLookup`, `UserWrite`, and `UserIter`, and let one Postgres struct implement all three. Callers then depend on the two methods they actually call, and a test double for the profile handler is eight lines.',
            'Rust makes the split cheap because a single type can implement many traits and a generic function can require exactly the combination it needs: `fn render<U: UserLookup>(store: &U)`. If a caller genuinely needs both capabilities, write `U: UserLookup + UserWrite`. The bound is documentation of the dependency, and it is checked at the call site rather than discovered at runtime.'
          ],
          list: [
            'One trait per capability: lookup, write, iterate, not one per table',
            'Compose with bounds: fn f<S: Load + Save>(s: &S)',
            'Keep traits object-safe when a heterogeneous collection is plausible',
            'Implement the narrow traits on one struct rather than one wide trait on many structs'
          ],
          code: `pub trait UserLookup {
    type Error;
    fn find(&self, id: &UserId) -> Result<Option<User>, Self::Error>;
}

pub trait UserWrite {
    type Error;
    fn insert(&mut self, user: &NewUser) -> Result<UserId, Self::Error>;
}

pub trait UserIter {
    type Error;
    fn iter_page(&self, after: Option<UserId>, limit: usize)
        -> Result<Vec<User>, Self::Error>;
}

// One adapter satisfies all three; each caller asks for what it uses.
pub struct PgUsers {
    pool: sqlx::PgPool,
}

impl UserLookup for PgUsers {
    type Error = sqlx::Error;
    fn find(&self, id: &UserId) -> Result<Option<User>, sqlx::Error> {
        todo!()
    }
}

impl UserWrite for PgUsers {
    type Error = sqlx::Error;
    fn insert(&mut self, user: &NewUser) -> Result<UserId, sqlx::Error> {
        todo!()
    }
}

pub struct UserId(pub u64);
pub struct User;
pub struct NewUser;`,
          tip: 'A trait with a single method is not too small; it is a dependency with a name that can be faked in six lines.'
        },
        {
          h: 'Where a wide trait is actually correct',
          p: [
            'Segregation is not a mandate to split everything. Some interfaces are wide because the contract genuinely couples the methods: a database driver, an allocator, an iterator. `std::io::Read` has one required method and a pile of provided ones, which is the other way to keep a rich interface cheap to implement - default everything that can be derived. A wide trait with sensible defaults is a different design from a wide trait with fourteen required bodies.',
            'The judgement call: if every implementor can honour every method, the width is a contract and it is fine. If implementors routinely stub a subset, the width is an accident of how the code grew. Look at the impl bodies, not the trait declaration, to decide which case you are in.'
          ],
          code: `use std::io::{self, Read};

/// Rich but cheap to implement: one required method, the rest provided.
pub struct CountingReader<R> {
    inner: R,
    bytes: u64,
}

impl<R: Read> Read for CountingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.bytes += n as u64;
        Ok(n)
    }
}

impl<R> CountingReader<R> {
    pub fn new(inner: R) -> Self {
        Self { inner, bytes: 0 }
    }
}`,
          tip: 'Wide plus defaults is a toolkit. Wide plus required bodies is a mortgage on every implementor.'
        }
      ],
      exercise: {
        prompt: 'A Notifier trait has send_email, send_sms, send_push, and send_webhook, and every test double panics on three of them. Split it into capability traits, keep one struct that implements all of them, and write a handler bound to only the capability it uses.',
        starter: `pub trait Email {
    type Error;
    fn send_email(&self, to: &str, subject: &str) -> Result<(), Self::Error>;
}

pub trait Sms {
    type Error;
    fn send_sms(&self, to: &str, body: &str) -> Result<(), Self::Error>;
}

// 1. A handler that only emails: depend on Email, nothing else.
pub fn notify_signup<N: Email>(notifier: &N, to: &str) -> Result<(), N::Error> {
    todo!()
}

// 2. One adapter implements both.
pub struct TwilioAndSes {
    pub api_key: String,
}

impl Email for TwilioAndSes {
    type Error = String;
    fn send_email(&self, _to: &str, _subject: &str) -> Result<(), String> {
        todo!()
    }
}

impl Sms for TwilioAndSes {
    type Error = String;
    fn send_sms(&self, _to: &str, _body: &str) -> Result<(), String> {
        todo!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 3. The double implements only what the handler needs.
    struct RecordingEmail(Vec<String>);

    impl Email for RecordingEmail {
        type Error = std::convert::Infallible;
        fn send_email(&self, to: &str, subject: &str) -> Result<(), Self::Error> {
            todo!()
        }
    }
}`,
        hint: 'notify_signup calls notifier.send_email(to, "Welcome"). The double needs interior mutability or a RefCell to record; simplest is to return Ok and assert on a RefCell<Vec<String>>. The point is that the double never mentions SMS.',
        solution: `use std::cell::RefCell;

pub trait Email {
    type Error;
    fn send_email(&self, to: &str, subject: &str) -> Result<(), Self::Error>;
}

pub trait Sms {
    type Error;
    fn send_sms(&self, to: &str, body: &str) -> Result<(), Self::Error>;
}

pub fn notify_signup<N: Email>(notifier: &N, to: &str) -> Result<(), N::Error> {
    notifier.send_email(to, "Welcome aboard")
}

pub struct TwilioAndSes {
    pub api_key: String,
}

impl Email for TwilioAndSes {
    type Error = String;
    fn send_email(&self, to: &str, _subject: &str) -> Result<(), String> {
        if self.api_key.is_empty() {
            return Err(String::from("missing api key"));
        }
        let _ = to;
        Ok(())
    }
}

impl Sms for TwilioAndSes {
    type Error = String;
    fn send_sms(&self, _to: &str, _body: &str) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct RecordingEmail(RefCell<Vec<(String, String)>>);

    impl Email for RecordingEmail {
        type Error = std::convert::Infallible;

        fn send_email(&self, to: &str, subject: &str) -> Result<(), Self::Error> {
            self.0.borrow_mut().push((to.to_owned(), subject.to_owned()));
            Ok(())
        }
    }

    #[test]
    fn handler_only_needs_the_email_capability() {
        let double = RecordingEmail(RefCell::new(Vec::new()));
        notify_signup(&double, "ada@example.com").unwrap();

        let sent = double.0.borrow();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, "ada@example.com");
        assert_eq!(sent[0].1, "Welcome aboard");
    }
}`
      },
      production: [
        'No unimplemented!() in a production trait impl; the method either belongs in the trait or in a narrower one.',
        'Every test double implements only the capability traits its subject actually calls.',
        'Traits with more than five required methods need a written justification in the module docs.',
        'Wide interfaces provide default implementations for everything that can be derived.',
        'Handlers and services state their capability bounds explicitly rather than taking a whole application context.'
      ],
      crates: ['async-trait', 'axum', 'tokio'],
      pitfall: 'One AppContext struct passed to every handler looks like dependency injection but couples every handler to every capability, so a test for one route needs the whole world wired up.',
      questions: [
        {
          q: 'A trait has ten required methods and six impls panic on seven of them. What is the best diagnosis?',
          options: [
            'The impls are lazy and should be filled in',
            'The trait models an entity rather than a capability; callers need narrower traits',
            'The trait should be object-safe so panics are caught earlier',
            'The trait needs #[non_exhaustive] to allow more methods'
          ],
          answer: 1,
          explain: 'Panicking bodies are the compiler asking you to split. Capability traits let each caller depend on what it calls and each double implement only that.'
        },
        {
          q: 'Why is fn render<S: Load + Save>(s: &S) better than fn render(ctx: &AppContext)?',
          options: [
            'It compiles faster because generics are monomorphised',
            'The bound states the real dependency, so the function cannot reach unrelated capabilities',
            'It allows dynamic dispatch at runtime',
            'It avoids the need for error types'
          ],
          answer: 1,
          explain: 'AppContext is a god object: it hands every handler the keys to everything and makes the dependency list invisible. The bound is checked documentation.'
        },
        {
          q: 'Which interface is legitimately wide?',
          options: [
            'A repository trait with one method per SQL statement the app runs',
            'Read, because it has one required method and defaults for the rest',
            'A notifier trait covering email, SMS, push, and webhooks',
            'A UserStore trait with find, save, delete, list, count, and export'
          ],
          answer: 1,
          explain: 'Read is wide because the derived methods are defined in terms of one primitive. Width with defaults is a toolkit; width with required bodies taxes every implementor.'
        }
      ],
      quickbytes: [
        'Split traits by capability; implement all of them on one adapter at the edge.',
        'A test double that stubs nine of ten methods is telling you the trait is too wide.',
        'State bounds on the function, not an AppContext: the signature becomes the dependency list.'
      ],
      github: [
        { name: 'rust-lang/api-guidelines - traits object-safe and generic where possible', url: 'https://github.com/rust-lang/api-guidelines' },
        { name: 'dtolnay/async-trait - object-safe async trait methods when dyn is required', url: 'https://github.com/dtolnay/async-trait' }
      ],
      resources: [
        {
          title: 'Rust API Guidelines: flexibility and object safety',
          url: 'https://rust-lang.github.io/api-guidelines/flexibility.html',
          kind: 'docs'
        },
        {
          title: 'The Rust Book: traits as bounds and as trait objects',
          url: 'https://doc.rust-lang.org/book/ch10-02-traits.html',
          kind: 'docs'
        },
        {
          title: 'async-trait crate: boxing async trait methods for dyn use',
          url: 'https://docs.rs/async-trait/latest/async_trait/',
          kind: 'docs'
        },
        {
          title: 'std::io::Read: one required method, the rest provided',
          url: 'https://doc.rust-lang.org/std/io/trait.Read.html',
          kind: 'docs'
        }
      ]
    },
    {
      id: 'dp06',
      title: 'Dependency inversion: the domain owns the trait, the edge owns the impl',
      minutes: 85,
      level: 'advanced',
      goal: 'Put the interface in the crate that defines the policy, implement it at the edge, and choose static or dynamic dispatch knowing what each costs.',
      sections: [
        {
          h: 'Inversion is about ownership, not about traits',
          p: [
            'Dependency inversion has two halves: high-level policy should not depend on low-level detail, and the abstraction should be owned by the policy. Most Rust codebases get the first half and miss the second. Declaring `trait UserStore` in the Postgres adapter crate and importing it into the domain means the domain still depends on the adapter, only through a trait-shaped hole. When a second adapter appears, the domain gains a dependency on it too.',
            'The test is mechanical: delete the adapter crate from the dependency graph. If the domain still compiles, the abstraction is owned correctly. Concretely that means the trait lives beside the domain types, the adapter has a dependency on the domain, and the binary - not the domain - wires them together. The domain then compiles and tests with no database driver, no HTTP client, and no async runtime feature flags.'
          ],
          list: [
            'Trait in the domain crate: the domain can be tested with a fake that lives in the domain test module',
            'Impl in the adapter crate: the adapter depends on the domain, never the reverse',
            'Wiring in the binary or a composition crate: the only place that names both sides',
            'Domain Cargo.toml has no driver, no HTTP, no async trait boxing unless the domain is genuinely async at its core'
          ],
          tip: 'If the domain crate cannot compile while the database crate is broken, the inversion is cosmetic.'
        },
        {
          h: 'The orphan rule decides where the impl can live',
          p: [
            'Rust only allows an impl if either the trait or the type is local to the crate. That rule stops conflicting impls across the ecosystem, and it shapes dependency inversion in practice: you cannot implement your domain trait for `sqlx::PgPool` because both are foreign to the adapter crate. The fix is a newtype that owns the pool, which is also where connection-pool configuration and retry policy belong.',
            'The same rule bites in the other direction. Implementing `serde::Serialize` for a foreign type requires a local wrapper, so serializing a foreign type in your API forces a newtype - which is usually an improvement, because the wire format becomes a decision you own rather than one the dependency made for you.'
          ],
          code: `// crates/domain/src/orders.rs - the policy owns the interface.
pub trait OrderRepository {
    type Error;
    fn find(&self, id: OrderId) -> Result<Option<Order>, Self::Error>;
    fn save(&mut self, order: &Order) -> Result<(), Self::Error>;
}

// crates/adapters/src/postgres.rs - the edge implements it.
use domain::{Order, OrderId, OrderRepository};

pub struct PgOrders {
    pool: sqlx::PgPool, // private: the pool is not part of the contract
}

impl OrderRepository for PgOrders {
    type Error = sqlx::Error;

    fn find(&self, id: OrderId) -> Result<Option<Order>, sqlx::Error> {
        todo!()
    }

    fn save(&mut self, order: &Order) -> Result<(), sqlx::Error> {
        todo!()
    }
}

// You cannot impl OrderRepository for sqlx::PgPool: both are foreign.
// The newtype is not bureaucracy, it is where pool policy lives.`,
          tip: 'Write the trait first, then the adapter, then the wiring. Writing the adapter first produces a trait shaped like the driver.'
        },
        {
          h: 'Generic or dyn: pick what varies and when',
          p: [
            'A generic parameter is resolved at compile time: the compiler generates one copy of the code per concrete type, inlines across the boundary, and knows the exact error type. That is the right default in a domain crate, where the number of implementations is small and the hot path matters. The costs are binary size, compile time, and error messages that name the full type including every parameter.',
            'A trait object resolves at runtime: one copy of the code, a vtable per call, and the ability to choose an implementation from configuration. It requires object safety - no generic methods, no `Self` by value, associated types pinned. Use it at the composition root when the choice is genuinely dynamic, such as selecting a storage backend from an environment variable, and keep the domain generic so tests stay monomorphic.'
          ],
          code: `pub struct Order;

pub trait OrderRepository {
    type Error;
    fn save(&mut self, order: &Order) -> Result<(), Self::Error>;
}

pub struct RepoError;

// Static: monomorphised, inlined, exact error type, one copy per impl.
pub struct Orders<R: OrderRepository> {
    repo: R,
}

impl<R: OrderRepository<Error = RepoError>> Orders<R> {
    pub fn place(&mut self, order: Order) -> Result<(), RepoError> {
        self.repo.save(&order)
    }
}

// Dynamic: one code path, runtime choice, requires object safety.
pub struct App {
    repo: std::sync::Arc<dyn OrderRepository<Error = RepoError> + Send + Sync>,
}

// Note: an associated type must be named at the dyn site. If the trait
// had a generic method, this line would not compile at all.`,
          tip: 'Default to generic in the core and dyn at the edges. If you reach for dyn in a domain function, first check whether the caller can pass the implementation instead.'
        },
        {
          h: 'Async traits: the object-safety wall',
          p: [
            'Since Rust 1.75, `async fn` is allowed in traits, but such a trait is not dyn-compatible: the compiler cannot know the future size, so `dyn Trait` with an async method does not compile. Generic bounds work fine, which covers most domain code. When you need dynamic dispatch over async behaviour - plugin traits, runtime-selected clients - the `async-trait` macro rewrites each method to return a boxed future, making the trait object-safe at the cost of one allocation per call.',
            'The choice is the same as sync dispatch. Generic async traits for the domain, boxed async traits for the runtime-selected edge. Do not box everything by reflex: an allocation per call is measurable in a hot path, and the macro also changes the trait signature you see in docs.'
          ],
          code: `use async_trait::async_trait;
use std::time::SystemTime;

/// Generic use: native async fn in trait, no allocation.
pub trait Clock {
    async fn now(&self) -> SystemTime;
}

/// Runtime-selected use: boxed futures make the trait dyn-compatible.
#[async_trait]
pub trait PriceSource {
    async fn price(&self, sku: &str) -> Result<u64, PriceError>;
}

pub struct App {
    prices: Box<dyn PriceSource + Send + Sync>,
}

#[derive(Debug)]
pub struct PriceError;`,
          tip: 'Box the future only where dyn is required. A generic async trait costs nothing and produces better error messages.'
        }
      ],
      exercise: {
        prompt: 'Define KeyValue in the domain, implement it twice (in-memory and a deliberately failing one), and run the same behavioural test against both through a generic application type. The domain must not name either implementation.',
        starter: `pub trait KeyValue {
    type Error;
    fn get(&self, key: &str) -> Result<Option<String>, Self::Error>;
    fn put(&mut self, key: &str, value: &str) -> Result<(), Self::Error>;
}

// The application depends on the abstraction only.
pub struct App<K: KeyValue> {
    store: K,
}

impl<K: KeyValue> App<K> {
    pub fn new(store: K) -> Self {
        Self { store }
    }

    pub fn remember(&mut self, key: &str, value: &str) -> Result<(), K::Error> {
        todo!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // 1. InMemory: a Vec of pairs.
    // 2. Broken: put always errors.
    // 3. Run the same assertions against both via a generic fn.
}`,
        hint: 'Exercise the trait through a generic fn <K: KeyValue> contract(app: &mut App<K>). InMemory returns the stored value after put; Broken returns Err on put and the test asserts the error path rather than success.',
        solution: `pub trait KeyValue {
    type Error;
    fn get(&self, key: &str) -> Result<Option<String>, Self::Error>;
    fn put(&mut self, key: &str, value: &str) -> Result<(), Self::Error>;
}

pub struct App<K: KeyValue> {
    store: K,
}

impl<K: KeyValue> App<K> {
    pub fn new(store: K) -> Self {
        Self { store }
    }

    pub fn remember(&mut self, key: &str, value: &str) -> Result<(), K::Error> {
        self.store.put(key, value)
    }

    pub fn recall(&self, key: &str) -> Result<Option<String>, K::Error> {
        self.store.get(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct InMemory(Vec<(String, String)>);

    impl KeyValue for InMemory {
        type Error = std::convert::Infallible;

        fn get(&self, key: &str) -> Result<Option<String>, Self::Error> {
            Ok(self
                .0
                .iter()
                .rev()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone()))
        }

        fn put(&mut self, key: &str, value: &str) -> Result<(), Self::Error> {
            self.0.push((key.to_owned(), value.to_owned()));
            Ok(())
        }
    }

    struct Broken;

    impl KeyValue for Broken {
        type Error = &'static str;

        fn get(&self, _key: &str) -> Result<Option<String>, Self::Error> {
            Err("unavailable")
        }

        fn put(&mut self, _key: &str, _value: &str) -> Result<(), Self::Error> {
            Err("unavailable")
        }
    }

    #[test]
    fn in_memory_round_trips() {
        let mut app = App::new(InMemory::default());
        app.remember("k", "v").unwrap();
        assert_eq!(app.recall("k").unwrap().as_deref(), Some("v"));
    }

    #[test]
    fn failure_is_reported_by_the_abstraction() {
        let mut app = App::new(Broken);
        assert_eq!(app.remember("k", "v"), Err("unavailable"));
        assert_eq!(app.recall("k"), Err("unavailable"));
    }
}`
      },
      production: [
        'The domain crate compiles and its tests pass with every adapter crate removed from the workspace.',
        'No domain type names a driver, HTTP client, or runtime type in a public signature.',
        'Wiring lives in main or a dedicated composition crate; constructors never build their own dependencies.',
        'The generic-versus-dyn choice is recorded in an ADR with the reason (runtime selection or compile-time inlining).',
        'Async traits are generic in the core and boxed only where dyn dispatch is actually required.'
      ],
      crates: ['async-trait', 'sqlx', 'tokio', 'thiserror'],
      pitfall: 'A domain struct whose constructor creates its own connection pool: the dependency is hidden, every test opens a socket, and the inversion exists only on the diagram.',
      questions: [
        {
          q: 'Which arrangement actually inverts the dependency?',
          options: [
            'The adapter crate defines the trait and the domain imports it',
            'The domain defines the trait and the adapter implements it',
            'Both crates depend on a shared traits crate that names the database',
            'The binary defines the trait and passes it to the domain'
          ],
          answer: 1,
          explain: 'Inversion means the policy owns the abstraction. If the adapter owns it, the domain still depends on the adapter through one more indirection.'
        },
        {
          q: 'Why can a native async fn in a trait not be used as dyn Trait?',
          options: [
            'Because async functions cannot be inlined',
            'Because the compiler cannot size the returned future, so the trait is not dyn-compatible',
            'Because async traits require the standard library feature gate',
            'Because dyn dispatch cannot propagate errors'
          ],
          answer: 1,
          explain: 'Object safety requires a known layout. Boxed futures (async-trait) restore it at one allocation per call; generic bounds avoid the issue entirely.'
        },
        {
          q: 'When is Arc<dyn Trait> the better choice than a generic parameter?',
          options: [
            'When the implementation is known at compile time and the call is hot',
            'When the implementation is selected at runtime and stored in shared state',
            'When the trait has generic methods',
            'When you want monomorphisation and smaller binaries'
          ],
          answer: 1,
          explain: 'dyn buys runtime selection and one code path. Generic buys inlining and exact types. Hot paths and known implementations favour generic; configuration and shared state favour dyn.'
        }
      ],
      quickbytes: [
        'Delete the adapter and compile the domain; if it fails, the abstraction is in the wrong crate.',
        'The orphan rule forces a newtype, and the newtype is where adapter configuration belongs.',
        'Generic in the core, dyn at the composition root, boxed futures only where dyn must be async.'
      ],
      github: [
        { name: 'dtolnay/async-trait - object-safe async trait methods', url: 'https://github.com/dtolnay/async-trait' },
        { name: 'rust-lang/api-guidelines - generic parameters and object safety', url: 'https://github.com/rust-lang/api-guidelines' }
      ],
      resources: [
        {
          title: 'Rust API Guidelines: functions minimise assumptions with generics',
          url: 'https://rust-lang.github.io/api-guidelines/flexibility.html',
          kind: 'docs'
        },
        {
          title: 'The Rust Book: trait objects, object safety, and dynamic dispatch',
          url: 'https://doc.rust-lang.org/book/ch17-02-trait-objects.html',
          kind: 'docs'
        },
        {
          title: 'async-trait crate documentation',
          url: 'https://docs.rs/async-trait/latest/async_trait/',
          kind: 'docs'
        },
        {
          title: 'sqlx: pool, connection, and transaction types used in the adapter',
          url: 'https://docs.rs/sqlx/latest/sqlx/',
          kind: 'docs'
        },
        {
          title: 'Rust Foundation: RustConf talks on architecture and API design',
          url: 'https://www.youtube.com/@RustFoundation',
          kind: 'video'
        }
      ]
    },
    {
      id: 'dp07',
      title: 'Type-driven design: the signature is the specification',
      minutes: 80,
      level: 'core',
      goal: 'Move meaning from comments and call-site conventions into types, and use typestate where the order of operations is part of the contract.',
      sections: [
        {
          h: 'Boolean blindness and other lost information',
          p: [
            'A boolean parameter is a type that carries one bit and no meaning. At the call site, `transfer(&from, &to, 10_000, true)` does not say what true is; a reader must open the definition, and a reviewer cannot tell a mistake from a decision. The same loss happens with stringly-typed ids, tuples of positional arguments, and `Option<Option<T>>`, where the compiler knows the shape but not the intent.',
            'Type-driven design replaces the lost information with a type that has exactly one meaning. `Expedited::Yes` instead of true, `OrderId` instead of u64, an enum with a `NotRequested` variant instead of `Option<Option<Reason>>`. The compiler then rejects the argument that was swapped, the id that came from the wrong table, and the state that should not exist. The cost is a few lines of declaration, paid once at the boundary.'
          ],
          list: [
            'Arguments that are always used together belong in a struct',
            'Arguments that can be one of several things belong in an enum',
            'A bool that callers get wrong belongs in a two-variant enum',
            'A parameter that must be checked by every caller belongs in a constructor'
          ],
          code: `mod before {
    // The call site reads like a puzzle and nothing is checked.
    pub fn transfer(
        from: &str,
        to: &str,
        amount: u64,
        expedited: bool,
    ) -> Result<(), String> {
        todo!()
    }

    pub fn call() {
        // true means... something the reader has to look up.
        let _ = transfer("acct_1", "acct_2", 10_000, true);
    }
}

mod after {
    pub struct AccountId(pub String);
    pub struct MinorUnits(pub u64);

    #[derive(Clone, Copy)]
    pub enum Speed {
        Standard,
        Expedited,
    }

    #[derive(Debug)]
    pub struct TransferError;

    // Each argument has one meaning, and the units are in the name.
    pub fn transfer(
        from: &AccountId,
        to: &AccountId,
        amount: MinorUnits,
        speed: Speed,
    ) -> Result<(), TransferError> {
        todo!()
    }

    pub fn call(from: AccountId, to: AccountId) {
        let _ = transfer(&from, &to, MinorUnits(10_000), Speed::Expedited);
    }
}`,
          tip: 'If a reviewer cannot verify a call from the call site alone, the signature is under-specified.'
        },
        {
          h: 'Typestate: protocol order in the type system',
          p: [
            'Some rules are about order: you cannot ship an invoice before issuing it, cannot read from a connection before handshaking. A runtime check (`if !self.issued { return Err(...) }`) puts the rule in every method and turns a programming error into a returned error. Typestate moves the rule into the type: the type parameter changes as the value moves through the protocol, so calling the wrong method is a compile error rather than a test case.',
            'The mechanics are small: a marker type per state, a `PhantomData` field to tie the parameter to the value, and methods implemented only on the state where they make sense. Because methods take `self` by value, the old state is consumed and cannot be used afterwards. No runtime flag, no `Option` to unwrap, no possibility of double-issuing - and error messages that say exactly which state was expected.'
          ],
          code: `use std::marker::PhantomData;

pub struct Draft;
pub struct Issued;

pub struct Invoice<S> {
    customer: String,
    total_cents: u64,
    number: Option<String>,
    _state: PhantomData<S>,
}

impl Invoice<Draft> {
    pub fn new(customer: impl Into<String>, total_cents: u64) -> Self {
        Self {
            customer: customer.into(),
            total_cents,
            number: None,
            _state: PhantomData,
        }
    }

    pub fn issue(self, number: impl Into<String>) -> Invoice<Issued> {
        Invoice {
            customer: self.customer,
            total_cents: self.total_cents,
            number: Some(number.into()),
            _state: PhantomData,
        }
    }
}

impl Invoice<Issued> {
    /// Available only after issuing: no runtime check needed.
    pub fn number(&self) -> &str {
        self.number.as_deref().unwrap_or_default()
    }
}`,
          tip: 'The unwrap_or_default above is unreachable by construction. If your typestate still needs Options and checks, the state is not really in the type.'
        },
        {
          h: 'Where types stop paying for themselves',
          p: [
            'Typestate is not free. Each state is a type, each transition is a method taking self, and errors mention `Invoice<Draft>` in a way that newcomers must learn. It is a poor fit for state that arrives from outside - a database row, a webhook payload - because that state must be parsed and validated at runtime anyway; the type only records that the parse happened. It is also a poor fit for rules that change monthly, because type-level rules are the most expensive kind to change.',
            'A useful heuristic: encode a rule as a type when violating it is a bug that must never ship, and when the rule is stable enough to outlive two refactors. Validate at runtime when the rule is data-driven, tenant-specific, or expected to change. The two compose: parse the outside world into states at the boundary, then use typestate for the operations your own code performs on them.'
          ],
          code: `// Runtime state from outside: parse once into a closed enum.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Status {
    Draft,
    Issued,
    Paid,
}

impl Status {
    pub fn parse(raw: &str) -> Result<Self, UnknownStatus> {
        match raw {
            "draft" => Ok(Self::Draft),
            "issued" => Ok(Self::Issued),
            "paid" => Ok(Self::Paid),
            _ => Err(UnknownStatus(raw.to_owned())),
        }
    }
}

#[derive(Debug)]
pub struct UnknownStatus(pub String);
// Typestate then guards the in-process transitions on this parsed value.`,
          tip: 'Types are for rules that must not be broken. Enums parsed at the boundary are for rules that arrive as data.'
        }
      ],
      exercise: {
        prompt: 'Model a job with two states so that only a queued job can be started, and only a running job can be finished. Use PhantomData, consume self on each transition, and prove the order in a test.',
        starter: `use std::marker::PhantomData;

pub struct Queued;
pub struct Running;

pub struct Job<S> {
    pub id: u64,
    pub attempts: u32,
    _state: PhantomData<S>,
}

impl Job<Queued> {
    pub fn new(id: u64) -> Self {
        todo!()
    }

    /// Consumes the queued job and returns a running one.
    pub fn start(self) -> Job<Running> {
        todo!()
    }
}

impl Job<Running> {
    /// Consumes the running job and returns the attempts count.
    pub fn finish(self) -> u32 {
        todo!()
    }
}`,
        hint: 'new builds Job { id, attempts: 0, _state: PhantomData }. start returns Job::<Running> keeping id and attempts. finish consumes self and returns self.attempts. The test starts then finishes; a commented-out double-finish line documents the compile error.',
        solution: `use std::marker::PhantomData;

pub struct Queued;
pub struct Running;

pub struct Job<S> {
    pub id: u64,
    pub attempts: u32,
    _state: PhantomData<S>,
}

impl Job<Queued> {
    pub fn new(id: u64) -> Self {
        Self { id, attempts: 0, _state: PhantomData }
    }

    pub fn start(self) -> Job<Running> {
        Job {
            id: self.id,
            attempts: self.attempts + 1,
            _state: PhantomData,
        }
    }
}

impl Job<Running> {
    pub fn finish(self) -> u32 {
        self.attempts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_queued_jobs_start_and_only_running_jobs_finish() {
        let job = Job::new(42).start();
        assert_eq!(job.finish(), 1);
        // job.finish();  // does not compile: Job<Running> is consumed
        // Job::<Queued>::new(1).finish(); // does not compile: no method
    }

    #[test]
    fn attempts_are_counted_by_the_transition() {
        let job = Job::new(7).start();
        assert_eq!(job.id, 7);
        assert_eq!(job.attempts, 1);
    }
}`
      },
      production: [
        'No public function takes a bare bool where a two-variant enum would say what the flag means.',
        'Typestate is used for in-process protocol order, and the states are parsed from external data exactly once.',
        'Every PhantomData state field is private, so callers cannot forge a state by constructing the struct.',
        'Signatures name units (MinorUnits, Duration) rather than bare integers with a comment.',
        'Compile-fail tests cover the calls the typestate forbids, so the guarantee is asserted, not assumed.'
      ],
      crates: ['serde', 'thiserror', 'typed-builder'],
      pitfall: 'Making the state field public or deriving Default for a typestate struct: callers can now construct `Invoice<Issued>` without a number, and the compile-time guarantee was decoration.',
      questions: [
        {
          q: 'What does typestate actually buy over a runtime status enum plus checks?',
          options: [
            'Smaller binary size',
            'Illegal call sequences become compile errors instead of runtime errors',
            'Faster execution because no state is stored',
            'Automatic serialization of the state'
          ],
          answer: 1,
          explain: 'A runtime enum still lets you call issue twice if a check is missing. Typestate makes the wrong call unrepresentable, at the cost of more types and wordier errors.'
        },
        {
          q: 'When is a bool parameter acceptable?',
          options: [
            'When only one call site exists today',
            'When the name at the call site makes the meaning unmistakable, as in a private helper with two obvious branches',
            'When the function is public and documented',
            'When the value comes from configuration'
          ],
          answer: 1,
          explain: 'Boolean blindness is about call-site legibility. A private one-line helper called with a literal in one place is fine; a public API used by strangers is where bools go wrong.'
        },
        {
          q: 'Why is typestate a poor fit for a status column read from Postgres?',
          options: [
            'Because Postgres cannot store enums',
            'Because the value arrives at runtime and must be parsed and validated anyway',
            'Because typestate requires async',
            'Because phantom types cannot derive Serialize'
          ],
          answer: 1,
          explain: 'Typestate encodes what your own code does in sequence. External data needs a runtime parse into a closed enum first; the type system cannot know what the row contains.'
        }
      ],
      quickbytes: [
        'Replace a bool with an enum, and a tuple of ids with named types; the call site becomes reviewable.',
        'Typestate: marker types plus PhantomData plus methods that consume self.',
        'Encode stable rules that must never break; validate data-driven rules at the boundary.'
      ],
      github: [
        { name: 'rust-unofficial/patterns - typestate pattern in Rust', url: 'https://github.com/rust-unofficial/patterns' },
        { name: 'rust-lang/api-guidelines - newtypes and custom types over bools', url: 'https://github.com/rust-lang/api-guidelines' }
      ],
      resources: [
        {
          title: 'Rust API Guidelines: type safety, newtypes, and arguments that convey meaning',
          url: 'https://rust-lang.github.io/api-guidelines/type-safety.html',
          kind: 'docs'
        },
        {
          title: 'std::marker::PhantomData',
          url: 'https://doc.rust-lang.org/std/marker/struct.PhantomData.html',
          kind: 'docs'
        },
        {
          title: 'Rust Design Patterns: typestate and session types',
          url: 'https://github.com/rust-unofficial/patterns',
          kind: 'repo'
        },
        {
          title: 'Rust Foundation: RustConf talks on type-level design in practice',
          url: 'https://www.youtube.com/@RustFoundation',
          kind: 'video'
        }
      ]
    },
    {
      id: 'dp08',
      title: 'Newtypes: distinct types for ids, money, and units',
      minutes: 70,
      level: 'core',
      goal: 'Wrap primitives so mixed-up arguments stop compiling, and implement only the conversions that preserve the invariant.',
      sections: [
        {
          h: 'The swapped-argument bug that no test catches',
          p: [
            'Two ids of the same primitive type are interchangeable to the compiler, so `transfer(from, to, amount)` compiles when the caller swaps them, and the bug surfaces as money moving the wrong way. A newtype fixes it at zero runtime cost: `struct AccountId(String)` and `struct OrderId(u64)` are distinct types, and the swap becomes a type error. `#[repr(transparent)]` guarantees the wrapper has the same layout as the inner value, so FFI and benchmarks see no change.',
            'The gain is not only safety; it is documentation at the definition site. A signature full of `String` and `u64` tells a reader nothing about which strings are validated, which numbers are minor units, and which can be negative. A signature of `Amount`, `Currency`, and `AccountId` tells them nearly everything, and the compiler checks that every call agrees.'
          ],
          tip: 'Wrap the primitive that appears twice in a signature. One occurrence is a parameter; two occurrences of the same type are a future swap.'
        },
        {
          h: 'Constructors are the contract',
          p: [
            'A newtype without a validating constructor is just a rename. The constructor decides which values can exist: `TryFrom<u64>` for a non-zero id, `FromStr` for a parsed email, `TryFrom<&str>` for a SKU with a checksum. Once those exist, `Display`, `serde`, and axum extractors can be built on them, and every path into the type goes through one function you can test exhaustively.',
            'Conversion traits send a signal that is easy to get wrong. `From` is infallible: implementing `From<u64> for OrderId` promises every u64 is a valid id, which is false if zero is invalid. `TryFrom` is the honest trait for fallible construction, and it composes with `?`. `FromStr` gives `.parse()` for free and feeds `clap` value parsers; axum path extraction goes through serde instead, so a validated id needs `Deserialize` too. `AsRef<str>` is fine only when the borrow exposes no way to violate the invariant.'
          ],
          list: [
            'TryFrom for fallible construction from a primitive or string',
            'FromStr so .parse() works and Path<T> extracts',
            'Display for the canonical user-facing rendering',
            'Diagnostic-friendly Debug so logs identify the id'
          ],
          code: `use std::num::NonZeroU64;
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(transparent)]
pub struct OrderId(NonZeroU64);

impl OrderId {
    pub fn new(raw: u64) -> Result<Self, InvalidOrderId> {
        NonZeroU64::new(raw).map(Self).ok_or(InvalidOrderId)
    }

    pub fn get(self) -> u64 {
        self.0.get()
    }
}

impl std::fmt::Display for OrderId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl FromStr for OrderId {
    type Err = InvalidOrderId;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        Self::new(raw.parse().map_err(|_| InvalidOrderId)?)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct InvalidOrderId;

impl std::fmt::Display for InvalidOrderId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("order id must be a positive integer")
    }
}

impl std::error::Error for InvalidOrderId {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_is_not_an_id_and_the_niche_is_free() {
        assert!(OrderId::new(0).is_err());
        assert_eq!(OrderId::new(7).unwrap().to_string(), "7");
        // NonZeroU64 lets Option<OrderId> use the null niche.
        assert_eq!(std::mem::size_of::<Option<OrderId>>(), 8);
    }
}`,
          tip: 'If a constructor cannot fail, the type has no invariant and probably does not need to exist.'
        },
        {
          h: 'Serde: transparent on the wire, strict at the door',
          p: [
            'A newtype that serializes as a nested object is a wire-format decision nobody wanted. `#[serde(transparent)]` writes the inner value directly, so the JSON stays `"id": 7`. For deserialization of a validated type, `#[serde(try_from = "u64")]` routes the wire value through `TryFrom`, which means an invalid id in a request body becomes a deserialization error rather than a value that violates the invariant.',
            'The two directions need different machinery. A response serializer cannot fail, so `Serialize` should write the already-valid inner value. A request deserializer must fail, so it has to route through `try_from`. One derive cannot be both transparent and strict, which is why the code below implements the two traits by hand; the `#[serde(into = "String", try_from = "String")]` pair is the shorter alternative when the type is `Clone`. Skip the strict half and you get the classic failure: an id of zero arrives in a webhook, is stored, and only breaks downstream.'
          ],
          code: `use serde::{Deserialize, Serialize};

// Serialize writes the inner string; Deserialize must go through
// TryFrom, otherwise serde reaches the private field directly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sku(String);

impl Sku {
    pub fn parse(raw: &str) -> Result<Self, InvalidSku> {
        let (body, check) = raw.split_once('-').ok_or(InvalidSku)?;
        let expected: u32 = body.bytes().map(u32::from).sum::<u32>() % 97;
        if body.is_empty() || check.parse::<u32>() != Ok(expected) {
            return Err(InvalidSku);
        }
        Ok(Self(raw.to_owned()))
    }
}

impl std::fmt::Display for Sku {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<String> for Sku {
    type Error = InvalidSku;
    fn try_from(raw: String) -> Result<Self, Self::Error> {
        Self::parse(&raw)
    }
}

impl From<Sku> for String {
    fn from(sku: Sku) -> Self {
        sku.0
    }
}

impl Serialize for Sku {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Sku {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::parse(&raw).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Deserialize)]
pub struct LineItem {
    pub sku: Sku, // deserialization goes through Sku::parse
    pub quantity: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub struct InvalidSku;`,
          tip: 'Serialize the valid type as-is; deserialize through a fallible conversion. One direction can fail, the other cannot.'
        }
      ],
      exercise: {
        prompt: 'Build a CustomerId newtype over NonZeroU64 with TryFrom<u64>, FromStr, Display, and a test that zero fails while a valid id round-trips. Then add a second newtype TenantId and a function that takes both, to prove they cannot be swapped.',
        starter: `use std::num::NonZeroU64;
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CustomerId(NonZeroU64);

impl CustomerId {
    pub fn new(raw: u64) -> Result<Self, InvalidId> {
        todo!()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TenantId(NonZeroU64);

#[derive(Debug, PartialEq, Eq)]
pub struct InvalidId;

impl FromStr for CustomerId {
    type Err = InvalidId;
    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        todo!()
    }
}

impl std::fmt::Display for CustomerId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        todo!()
    }
}

/// Both ids in one signature: a swap must not compile.
pub fn scope(tenant: TenantId, customer: CustomerId) -> String {
    format!("{tenant}/{customer}")
}`,
        hint: 'CustomerId::new uses NonZeroU64::new(raw).ok_or(InvalidId). from_str parses to u64 then calls new. Display delegates to the NonZeroU64 inside. Implement TenantId::new the same way and give it Display too.',
        solution: `use std::num::NonZeroU64;
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CustomerId(NonZeroU64);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TenantId(NonZeroU64);

#[derive(Debug, PartialEq, Eq)]
pub struct InvalidId;

impl CustomerId {
    pub fn new(raw: u64) -> Result<Self, InvalidId> {
        NonZeroU64::new(raw).map(Self).ok_or(InvalidId)
    }
}

impl TenantId {
    pub fn new(raw: u64) -> Result<Self, InvalidId> {
        NonZeroU64::new(raw).map(Self).ok_or(InvalidId)
    }
}

impl FromStr for CustomerId {
    type Err = InvalidId;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        Self::new(raw.parse().map_err(|_| InvalidId)?)
    }
}

impl std::fmt::Display for CustomerId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl std::fmt::Display for TenantId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

pub fn scope(tenant: TenantId, customer: CustomerId) -> String {
    format!("{tenant}/{customer}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_is_rejected_and_valid_ids_round_trip() {
        assert_eq!(CustomerId::new(0), Err(InvalidId));
        let id: CustomerId = "42".parse().unwrap();
        assert_eq!(id.to_string(), "42");
        assert_eq!(id, CustomerId::new(42).unwrap());
    }

    #[test]
    fn two_id_types_cannot_be_swapped() {
        let tenant = TenantId::new(1).unwrap();
        let customer = CustomerId::new(2).unwrap();
        assert_eq!(scope(tenant, customer), "1/2");
        // scope(customer, tenant); // does not compile: mismatched types
    }
}`
      },
      production: [
        'Every id type in a public signature is a newtype, not a bare u64 or String.',
        'Validated newtypes expose TryFrom, never an infallible From from the raw primitive.',
        'Wire formats use #[serde(transparent)] for writing and #[serde(try_from)] for reading.',
        'No Deref impl on a validated newtype; borrow through an explicit as_str or get method.',
        'A test asserts the niche optimisation where Option<Id> must stay pointer-sized.'
      ],
      crates: ['serde', 'nutype', 'thiserror', 'uuid'],
      pitfall: 'Deriving Deserialize on a newtype with a private field and no try_from: serde reaches the field directly, so invalid values arrive fully constructed and every invariant check downstream is theatre.',
      questions: [
        {
          q: 'Why prefer TryFrom over From for a validated newtype?',
          options: [
            'TryFrom is faster at runtime',
            'From promises every input is valid, which is false when the constructor validates',
            'From cannot be implemented for primitives',
            'TryFrom is required by serde'
          ],
          answer: 1,
          explain: 'From is an infallibility claim. If zero is invalid, `From<u64>` either lies or panics; TryFrom states the truth and composes with ?.'
        },
        {
          q: 'What does #[serde(transparent)] change?',
          options: [
            'It skips validation during deserialization',
            'It serialises the newtype as its inner value instead of a nested object',
            'It makes the type Copy',
            'It renames the field on the wire'
          ],
          answer: 1,
          explain: 'Transparent affects the representation only. Validation still needs try_from on the deserialization path; transparent alone does not create it.'
        },
        {
          q: 'A struct has two String fields, both account identifiers. What is the concrete benefit of newtyping them?',
          options: [
            'Smaller memory footprint',
            'The compiler rejects a swapped call, and the signature documents which is which',
            'Serialization becomes faster',
            'They become comparable with =='
          ],
          answer: 1,
          explain: 'Newtypes buy distinctness, not speed or size (with repr(transparent) size is unchanged). The win is a compile error at the swap and a self-documenting API.'
        }
      ],
      quickbytes: [
        'Wrap any primitive that appears twice in one signature; that is where swaps happen.',
        'Validate in the constructor; expose TryFrom and FromStr, never From, for fallible types.',
        'serde(transparent) for the wire, serde(try_from) for the door.'
      ],
      github: [
        { name: 'greyblake/nutype - newtypes with generated validation', url: 'https://github.com/greyblake/nutype' },
        { name: 'serde-rs/serde - transparent and try_from container attributes', url: 'https://github.com/serde-rs/serde' }
      ],
      resources: [
        {
          title: 'Rust API Guidelines: newtypes provide static distinctions',
          url: 'https://rust-lang.github.io/api-guidelines/type-safety.html',
          kind: 'docs'
        },
        {
          title: 'std::num::NonZeroU64 and the null niche',
          url: 'https://doc.rust-lang.org/std/num/struct.NonZero.html',
          kind: 'docs'
        },
        {
          title: 'nutype: sanitisation and validation for newtypes',
          url: 'https://docs.rs/nutype/latest/nutype/',
          kind: 'docs'
        },
        {
          title: 'serde: container attributes and field attributes',
          url: 'https://docs.rs/serde/latest/serde/',
          kind: 'docs'
        },
        {
          title: 'nutype repository and test suite',
          url: 'https://github.com/greyblake/nutype',
          kind: 'repo'
        }
      ]
    },
    {
      id: 'dp09',
      title: "Parse, don't validate: one gate at the boundary",
      minutes: 75,
      level: 'advanced',
      goal: 'Replace boolean validation with fallible parsing so invalid values cannot travel, and make the deserializer the single gate.',
      sections: [
        {
          h: 'Validation checks; parsing converts',
          p: [
            'A validation function answers a question and returns the original value untouched: `if !is_valid(&input) { return Err(...) }`, then the raw input continues through the system. The problem is structural - the compiler still sees the raw type, so any later function must either trust the earlier check or repeat it, and one path eventually forgets. The check and the value live in different places, and only discipline connects them.',
            'Parsing returns a different type. `Email::parse(&str) -> Result<Email, Error>` produces a value that could not exist unless the check passed, so downstream functions take `Email` and need no check. The cost moves to the boundary, where it belongs: one function, one set of tests, one error type. Everything inside the boundary operates on values whose invariants are already true.'
          ],
          list: [
            'Validation: returns bool or Result<(), E>; the raw value keeps travelling',
            'Parsing: returns a new type; the invariant is a precondition of every later function',
            'Boundary: HTTP handler, queue consumer, config loader, database row mapper',
            'Interior: no re-validation, no defensive checks, no string parsing'
          ],
          tip: 'If a function takes &str and starts by checking its format, the check belongs in the caller that owns the boundary.'
        },
        {
          h: 'Serde is already a parser; use it',
          p: [
            'Every `#[derive(Deserialize)]` is a parser, and `#[serde(try_from = "RawType")]` lets it be a validating one. The raw shape mirrors the wire format; `TryFrom<RawType>` converts it into the domain type. Deserialization then either yields a valid value or an error with a path to the offending field. The same pattern covers config files, queue messages, and rows mapped with `FromRow` followed by `TryFrom`.',
            'Two attributes make this strict enough to rely on. `#[serde(deny_unknown_fields)]` turns a typo in a config key into an error instead of a silently ignored setting. `#[serde(default)]` on optional fields keeps the raw type convenient without making the domain type optional. Together they mean a successfully deserialized value is valid and complete, not merely syntactically shaped.'
          ],
          code: `use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateUserRaw {
    email: String,
    age: u8,
}

#[derive(Debug, Deserialize)]
#[serde(try_from = "CreateUserRaw")]
pub struct CreateUser {
    email: Email,
    age: Age,
}

impl TryFrom<CreateUserRaw> for CreateUser {
    type Error = InvalidUser;

    fn try_from(raw: CreateUserRaw) -> Result<Self, Self::Error> {
        Ok(Self {
            email: Email::parse(&raw.email)?,
            age: Age::new(raw.age)?,
        })
    }
}

#[derive(Debug)]
pub struct Email(String);

impl Email {
    pub fn parse(raw: &str) -> Result<Self, InvalidUser> {
        if raw.contains('@') && !raw.starts_with('@') {
            Ok(Self(raw.to_owned()))
        } else {
            Err(InvalidUser::Email)
        }
    }
}

#[derive(Debug)]
pub struct Age(u8);

impl Age {
    pub fn new(raw: u8) -> Result<Self, InvalidUser> {
        (13..=120).contains(&raw).then_some(Self(raw)).ok_or(InvalidUser::Age)
    }
}

#[derive(Debug)]
pub enum InvalidUser {
    Email,
    Age,
}`,
          tip: 'Derive Deserialize on the domain type only through try_from. Deriving it directly on private fields makes the parser optional.'
        },
        {
          h: 'Axum extractors: the gate in the signature',
          p: [
            'In axum, an extractor runs before the handler, so if `Json<CreateUser>` succeeds the handler body cannot see an invalid user. The signature is the proof: a reviewer reads the parameter types and knows what has been checked. Custom extractors extend this to headers, API keys, and query parameters, returning a rejection that becomes a 400 or 422 with a machine-readable body.',
            'The anti-pattern is `Json<serde_json::Value>` or `Json<HashMap<String, String>>` in a handler. It compiles, it is flexible, and it moves every parse into the handler body where it will be duplicated by the next endpoint. The second anti-pattern is parsing in the handler and then storing the raw values - the type is valid at the top of the function and gone by the time the repository is called.'
          ],
          code: `use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequest, Request};
use axum::Json;

/// A JSON body that has already passed domain parsing.
pub struct Validated<T>(pub T);

impl<S, T> FromRequest<S> for Validated<T>
where
    S: Send + Sync,
    T: Send,
    Json<T>: FromRequest<S, Rejection = JsonRejection>,
{
    type Rejection = (axum::http::StatusCode, String);

    // axum 0.8 declares from_request as a plain fn returning a future,
    // so the impl returns an async block rather than using async fn.
    fn from_request(
        req: Request,
        state: &S,
    ) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        async move {
            let Json(value) = Json::<T>::from_request(req, state)
                .await
                .map_err(|rejection| {
                    (axum::http::StatusCode::UNPROCESSABLE_ENTITY, rejection.to_string())
                })?;
            Ok(Self(value))
        }
    }
}

/// The handler cannot see an invalid CreateUser: the type forbids it.
pub async fn create_user(Validated(user): Validated<CreateUser>) -> String {
    format!("created {}", user.email.0)
}`,
          tip: 'If the handler signature contains Value, Map, or String where a domain type belongs, the parse has not happened yet.'
        }
      ],
      exercise: {
        prompt: 'Write a Percentage type that can only hold 0 to 100, with a fallible constructor, and a Config parser that returns either a validated Config or a named error. Then show that code receiving a Config cannot construct an invalid percentage.',
        starter: `#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Percentage(u8);

#[derive(Debug, PartialEq, Eq)]
pub enum ConfigError {
    MissingField(&'static str),
    NotANumber { key: &'static str, raw: String },
    OutOfRange { key: &'static str, value: u32 },
}

#[derive(Debug, Clone, Copy)]
pub struct Config {
    percentage: Percentage,
}

impl Config {
    /// Parses the pair (name, value) into a validated Config.
    pub fn from_pairs(pairs: &[(&str, &str)]) -> Result<Self, ConfigError> {
        todo!()
    }

    pub fn percentage(&self) -> Percentage {
        self.percentage
    }
}

impl Percentage {
    pub fn new(raw: u32) -> Result<Self, ConfigError> {
        todo!()
    }
}`,
        hint: 'from_pairs finds the key "percentage", returns MissingField if absent, parses it to u32 mapping a parse failure to NotANumber with the raw input, then calls Percentage::new which returns OutOfRange. Keep the field private so no other module can build a Config with an unchecked percentage.',
        solution: `#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Percentage(u8);

#[derive(Debug, PartialEq, Eq)]
pub enum ConfigError {
    MissingField(&'static str),
    NotANumber { key: &'static str, raw: String },
    OutOfRange { key: &'static str, value: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Config {
    percentage: Percentage,
}

impl Percentage {
    pub fn new(raw: u32) -> Result<Self, ConfigError> {
        u8::try_from(raw)
            .ok()
            .filter(|value| *value <= 100)
            .map(Self)
            .ok_or(ConfigError::OutOfRange { key: "percentage", value: raw })
    }

    pub fn get(self) -> u8 {
        self.0
    }
}

impl Config {
    pub fn from_pairs(pairs: &[(&str, &str)]) -> Result<Self, ConfigError> {
        let raw = pairs
            .iter()
            .find(|(key, _)| *key == "percentage")
            .map(|(_, value)| *value)
            .ok_or(ConfigError::MissingField("percentage"))?;

        let parsed: u32 = raw.trim().parse().map_err(|_| ConfigError::NotANumber {
            key: "percentage",
            raw: raw.to_owned(),
        })?;

        Ok(Self { percentage: Percentage::new(parsed)? })
    }

    pub fn percentage(&self) -> Percentage {
        self.percentage
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_config_and_rejects_invalid() {
        let config = Config::from_pairs(&[("percentage", "40")]).unwrap();
        assert_eq!(config.percentage().get(), 40);

        assert_eq!(
            Config::from_pairs(&[("percentage", "101")]),
            Err(ConfigError::OutOfRange { key: "percentage", value: 101 })
        );
        assert_eq!(
            Config::from_pairs(&[("percentage", "lots")]),
            Err(ConfigError::NotANumber { key: "percentage", raw: "lots".into() })
        );
        assert_eq!(
            Config::from_pairs(&[]),
            Err(ConfigError::MissingField("percentage"))
        );
    }

    #[test]
    fn the_field_is_private_so_no_invalid_value_can_be_built() {
        // Config { percentage: Percentage(200) } would not compile here.
        assert_eq!(Percentage::new(100).unwrap().get(), 100);
        assert!(Percentage::new(101).is_err());
    }
}`
      },
      production: [
        'No domain function re-validates an argument it already received as a validated type.',
        'Request bodies deserialize through #[serde(try_from)] rather than deriving on private fields.',
        'Config loading uses deny_unknown_fields so a typo fails at startup, not silently at runtime.',
        'Handlers take domain types, never serde_json::Value or HashMap<String, String>.',
        'Database rows are converted with TryFrom at the repository boundary, so an invalid stored row is an error, not a live value.'
      ],
      crates: ['serde', 'axum', 'thiserror', 'sqlx'],
      pitfall: 'Validating in the handler and then passing the raw String into the service layer: the check is real, the type is not, and the next endpoint that calls the service skips it.',
      questions: [
        {
          q: 'What is the structural difference between validating and parsing?',
          options: [
            'Parsing is faster because it avoids allocations',
            'Parsing returns a new type whose existence proves the check ran',
            'Validation happens at compile time',
            'Parsing only applies to strings'
          ],
          answer: 1,
          explain: 'The return type is the point. A parsed value carries its invariant; a validated raw value carries only a promise made by one code path.'
        },
        {
          q: 'Why derive Deserialize through #[serde(try_from = "Raw")] instead of on the domain struct directly?',
          options: [
            'It produces smaller JSON',
            'It forces every deserialized value through the validating constructor',
            'It allows unknown fields by default',
            'It removes the need for a Display impl'
          ],
          answer: 1,
          explain: 'Direct derivation populates private fields without validation. try_from makes deserialization a parse, so the only way to exist is valid.'
        },
        {
          q: 'A handler takes Json<CreateUser>, where CreateUser validates in TryFrom. What has the handler proved by its signature alone?',
          options: [
            'That the user is authorised',
            'That the body is well-formed and domain-valid',
            'That the database insert will succeed',
            'That the email is deliverable'
          ],
          answer: 1,
          explain: 'The type proves shape and domain invariants. Authorisation, availability, and deliverability are different concerns with different sources of truth.'
        }
      ],
      quickbytes: [
        'Return a type from the boundary, not a boolean plus the same value.',
        'serde(try_from) for requests, serde(transparent) for responses, deny_unknown_fields for config.',
        'If a signature mentions Value or String where a domain type belongs, the parse moved inside.'
      ],
      github: [
        { name: 'serde-rs/serde - try_from and deny_unknown_fields', url: 'https://github.com/serde-rs/serde' },
        { name: 'tokio-rs/axum - extractors and the rejection model', url: 'https://github.com/tokio-rs/axum' }
      ],
      resources: [
        {
          title: 'serde attributes: container attributes including try_from',
          url: 'https://docs.rs/serde/latest/serde/',
          kind: 'docs'
        },
        {
          title: 'axum extractors and FromRequest',
          url: 'https://docs.rs/axum/latest/axum/extract/index.html',
          kind: 'docs'
        },
        {
          title: 'Rust API Guidelines: functions validate their arguments',
          url: 'https://rust-lang.github.io/api-guidelines/dependability.html',
          kind: 'docs'
        },
        {
          title: 'axum repository: extractor implementations and tests',
          url: 'https://github.com/tokio-rs/axum',
          kind: 'repo'
        }
      ]
    },
    {
      id: 'dp10',
      title: 'Invariants in types: the constructor is the only gate',
      minutes: 85,
      level: 'advanced',
      goal: 'Identify the predicates that must hold for every value, enforce them in one fallible constructor, and make every operation preserve them.',
      sections: [
        {
          h: 'An invariant is a promise the type keeps',
          p: [
            'An invariant is a predicate that is true of every value of a type, at every moment it is observable. `DateRange` has start not after end. `SortedVec` is sorted. `Money` never mixes currencies. The type keeps the promise only if there is exactly one way to create a value and every mutation preserves it - which in Rust means private fields, fallible constructors, no derived `Default` that produces an empty-but-invalid state, and no public field that lets a caller write a broken combination.',
            'Write the invariant in the type doc comment as a sentence you could test. If you cannot state it without the word approximately, it is not an invariant yet. Then write the test that constructs boundary values and asserts the constructor rejects them; the constructor is where the invariant lives, so it is where the tests belong.'
          ],
          list: [
            'Private fields: the only path in is a constructor',
            'Fallible constructor returning a named error per violated rule',
            'No Default derive when the zero value is invalid',
            'Every mutating method re-establishes the invariant before returning'
          ],
          tip: 'A public field on an invariant-bearing type is a hole with a getter attached.'
        },
        {
          h: 'Option soup versus a closed set',
          p: [
            'A struct with three optional fields looks flexible and encodes almost nothing: it can represent zero of the three, all three, or a combination the domain forbids. The type permits illegal states, so every consumer writes defensive branches, and the branches are untested because nobody constructs the weird combinations on purpose. Replacing the options with an enum makes the valid combinations enumerable and the invalid ones unrepresentable.',
            'This is the highest-leverage refactor in most codebases because it usually shrinks the code. `match contact { Email(address) => ..., Phone(number) => ... }` cannot forget a case: adding a variant breaks every match, which is the compiler telling you where the new behaviour belongs. The optional-field version compiles happily and silently does nothing for the new combination.'
          ],
          code: `mod before {
    // Eight combinations, and the domain has three.
    pub struct Contact {
        pub email: Option<String>,
        pub phone: Option<String>,
        pub postal: Option<String>,
    }
}

mod after {
    pub struct Email(pub String);
    pub struct PhoneNumber(pub String);
    pub struct PostalAddress(pub String);

    // Exactly the states the domain has.
    pub enum Contact {
        Email(Email),
        Phone(PhoneNumber),
        Post(PostalAddress),
    }

    // The match cannot silently skip a variant.
    pub fn channel_name(contact: &Contact) -> &'static str {
        match contact {
            Contact::Email(_) => "email",
            Contact::Phone(_) => "sms",
            Contact::Post(_) => "post",
        }
    }
}`,
          tip: 'Count the representable states of a struct with n optional fields: 2^n. If the domain has fewer, the type is lying.'
        },
        {
          h: 'Invariants that operations must maintain',
          p: [
            'Construction is half the job; mutation can break an invariant just as easily. A sorted vector must keep its order on insert, a range must reject a new end before its start, and a counter must not wrap silently in release mode. The compiler will not check these, so each mutating method needs either an operation that is correct by construction (insert at the binary-search position) or a revalidation with a documented failure mode.',
            'Cheap defence in depth: `debug_assert!` at the top of read methods that depend on the invariant. In debug builds a violated invariant panics at the first read, close to the bug; in release it costs nothing. For invariants you cannot afford to break in production, make the violating path return an error instead - but prefer the design where the operation cannot violate it at all.'
          ],
          code: `#[derive(Debug, Clone, Copy)]
pub struct DateRange {
    start: u32, // days since epoch, private
    end: u32,
}

impl DateRange {
    pub fn new(start: u32, end: u32) -> Result<Self, InvalidRange> {
        if start > end {
            return Err(InvalidRange { start, end });
        }
        Ok(Self { start, end })
    }

    pub fn contains(&self, day: u32) -> bool {
        debug_assert!(self.start <= self.end, "invariant broken: {self:?}");
        (self.start..=self.end).contains(&day)
    }

    /// Extends the range; cannot break the invariant.
    pub fn extended_to(self, day: u32) -> Self {
        Self {
            start: self.start.min(day),
            end: self.end.max(day),
        }
    }

    pub fn days(&self) -> u32 {
        (self.end - self.start).saturating_add(1)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct InvalidRange {
    pub start: u32,
    pub end: u32,
}`,
          tip: 'Every mutating method is a chance to re-break the invariant. Prefer methods whose signature makes the bad outcome impossible.'
        }
      ],
      exercise: {
        prompt: 'Implement NonEmpty<T> over a Vec: fallible construction from a Vec, first() that returns &T without unwrapping, push, and a test that the empty case is rejected and the invariant survives mutation.',
        starter: `#[derive(Debug, Clone, PartialEq)]
pub struct NonEmpty<T> {
    // private: no way to build an empty one from outside
}

#[derive(Debug, PartialEq, Eq)]
pub struct Empty;

impl<T> NonEmpty<T> {
    pub fn new(items: Vec<T>) -> Result<Self, Empty> {
        todo!()
    }

    pub fn first(&self) -> &T {
        // no unwrap, no Option: emptiness is impossible
        todo!()
    }

    pub fn push(&mut self, item: T) {
        todo!()
    }

    pub fn len(&self) -> usize {
        todo!()
    }
}`,
        hint: 'Store Vec<T> and reject empty in new. first indexes 0 safely because the invariant holds; push appends; len delegates. Add a test asserting NonEmpty::new(vec![]) is Err(Empty) and that first() still works after push.',
        solution: `#[derive(Debug, Clone, PartialEq)]
pub struct NonEmpty<T> {
    items: Vec<T>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Empty;

impl<T> NonEmpty<T> {
    pub fn new(items: Vec<T>) -> Result<Self, Empty> {
        if items.is_empty() {
            Err(Empty)
        } else {
            Ok(Self { items })
        }
    }

    pub fn first(&self) -> &T {
        // Safe by construction: an empty NonEmpty cannot exist.
        &self.items[0]
    }

    pub fn push(&mut self, item: T) {
        self.items.push(item);
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn iter(&self) -> impl Iterator<Item = &T> {
        self.items.iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_is_rejected_at_construction() {
        assert_eq!(NonEmpty::new(Vec::<u8>::new()), Err(Empty));
        assert_eq!(NonEmpty::new(vec![1]).unwrap().len(), 1);
    }

    #[test]
    fn mutation_preserves_the_invariant() {
        let mut values = NonEmpty::new(vec![1, 2]).unwrap();
        values.push(3);

        assert_eq!(values.first(), &1);
        assert_eq!(values.len(), 3);
        assert_eq!(values.iter().copied().sum::<i32>(), 6);
    }
}`
      },
      production: [
        'Every type with an invariant has private fields and at most one fallible constructor.',
        'No Default derive on a type whose zero value violates its own invariant.',
        'Mutating methods either cannot violate the invariant or return a named error.',
        'Debug assertions on invariant-dependent reads, so violations fail near the bug in debug builds.',
        'Boundary tests cover the empty, zero, equal-endpoints, and maximum cases for every invariant.'
      ],
      crates: ['serde', 'nutype', 'thiserror', 'proptest'],
      pitfall: 'Deriving Default on an invariant-bearing struct so tests can write ..Default::default(): the invalid value now exists in production too, and every method must defend against it.',
      questions: [
        {
          q: 'Which change actually enforces an invariant?',
          options: [
            'Documenting it in the struct doc comment',
            'Making fields private and providing one fallible constructor',
            'Adding a debug_assert in the constructor',
            'Writing a unit test that constructs a valid value'
          ],
          answer: 1,
          explain: 'Documentation and tests are evidence, not enforcement. Private fields plus a single validating constructor are what make an invalid value impossible.'
        },
        {
          q: 'A struct has email: Option<String>, phone: Option<String>, fax: Option<String>. How many states can it represent?',
          options: ['3', '6', '8', '2'],
          answer: 2,
          explain: 'Each optional field doubles the state space: 2^3 = 8, including all-none and all-three. A closed enum can represent exactly the domain cases.'
        },
        {
          q: 'Why is debug_assert! appropriate for an invariant check inside contains()?',
          options: [
            'It runs in release and protects production',
            'It panics close to the bug in debug builds and costs nothing in release',
            'It returns a Result that callers must handle',
            'It disables the borrow checker for that expression'
          ],
          answer: 1,
          explain: 'debug_assert! is compiled out in release. Pair it with a design that cannot violate the invariant, or with a Result when production must not abort.'
        }
      ],
      quickbytes: [
        'State the invariant in one sentence; if you cannot, the type has no contract yet.',
        'Private fields plus one fallible constructor is the whole enforcement mechanism.',
        'Count representable states; if 2^n exceeds the domain, replace the options with an enum.'
      ],
      github: [
        { name: 'greyblake/nutype - generated constructors that enforce invariants', url: 'https://github.com/greyblake/nutype' },
        { name: 'rust-unofficial/patterns - make illegal states unrepresentable', url: 'https://github.com/rust-unofficial/patterns' }
      ],
      resources: [
        {
          title: 'Rust API Guidelines: newtypes hide implementation details',
          url: 'https://rust-lang.github.io/api-guidelines/type-safety.html',
          kind: 'docs'
        },
        {
          title: 'std::num::NonZero: invariants the standard library encodes',
          url: 'https://doc.rust-lang.org/std/num/struct.NonZero.html',
          kind: 'docs'
        },
        {
          title: 'nutype: validation that cannot be bypassed',
          url: 'https://docs.rs/nutype/latest/nutype/',
          kind: 'docs'
        },
        {
          title: 'proptest: property tests for invariant preservation',
          url: 'https://docs.rs/proptest/latest/proptest/',
          kind: 'docs'
        }
      ]
    },
    {
      id: 'dp11',
      title: 'Error design: the failure surface is part of the API',
      minutes: 90,
      level: 'core',
      goal: 'Design one error enum per boundary that says what the caller can do, keep infrastructure errors behind it, and map it once to transport.',
      sections: [
        {
          h: 'One enum per boundary, not per crate',
          p: [
            'An error type is a message to a caller, and different callers can do different things. The HTTP layer needs a status code; the retry loop needs to know whether the failure is transient; the operator needs a source chain for the log; the test needs a variant to match. A single enum can serve all four if it is designed at the boundary where those decisions are made, with variants that name the condition rather than the mechanism.',
            'The common mistake is to let the mechanism leak. `sqlx::Error` in a public signature tells the caller which driver failed, not whether to retry. Worse, it makes the driver part of your API: upgrading sqlx becomes a breaking change. Define a domain error, convert at the repository edge, and keep the driver error as a `#[source]` where logs can reach it and callers cannot match on it.'
          ],
          list: [
            'Variant names describe the condition: NotFound, Conflict, InsufficientStock',
            'A source field carries the mechanism for logs, not for matching',
            'Transient versus permanent is visible in the type or in one documented method',
            'Public error enums are #[non_exhaustive] so new cases are not breaking'
          ],
          tip: 'If a caller has to parse your error message to decide what to do, the type is missing a variant.'
        },
        {
          h: 'thiserror for libraries, anyhow for binaries',
          p: [
            'A library error is a type: callers match on it, so it should be an enum with `thiserror`, one variant per condition, and a `From` impl only where the conversion is lossless. An application error is a report: binaries log it and exit, so `anyhow::Error` with context at each call site is enough. Mixing them - `anyhow` in a library signature - moves the decision to runtime and removes the caller ability to distinguish a conflict from an outage.',
            'The `#[from]` attribute deserves suspicion in a public enum. It generates a blanket conversion that forwards the driver error verbatim, which is fine for `Io` but wrong for a database error that may be a duplicate key or a deadlock. Write the `From` impl by hand, match on the driver code, and decide which domain condition it represents. That function is the only place where driver knowledge is allowed to exist.'
          ],
          code: `use thiserror::Error;

#[derive(Debug, Error)]
#[non_exhaustive]
pub enum OrderError {
    #[error("order {id} not found")]
    NotFound { id: OrderId },

    #[error("order is already {state}")]
    Conflict { state: &'static str },

    #[error("requested {requested}, only {available} available")]
    InsufficientStock { requested: u32, available: u32 },

    #[error("storage temporarily unavailable")]
    Unavailable(#[source] sqlx::Error),

    #[error("unexpected storage error")]
    Unexpected(#[source] sqlx::Error),
}

impl From<sqlx::Error> for OrderError {
    fn from(error: sqlx::Error) -> Self {
        // 23505 is unique_violation: a domain conflict, not an outage.
        let duplicate = matches!(
            &error,
            sqlx::Error::Database(db) if db.code().as_deref() == Some("23505")
        );

        if duplicate {
            return Self::Conflict { state: "duplicate" };
        }

        match error {
            error @ (sqlx::Error::PoolTimedOut | sqlx::Error::Io(_)) => Self::Unavailable(error),
            other => Self::Unexpected(other),
        }
    }
}

impl OrderError {
    pub fn is_transient(&self) -> bool {
        matches!(self, Self::Unavailable(_))
    }
}`,
          tip: 'One hand-written From impl per driver is the seam where infrastructure vocabulary becomes domain vocabulary.'
        },
        {
          h: 'Carry what the caller needs, and nothing else',
          p: [
            'An error that says invalid input forces the caller to reproduce the failure to learn anything. An error that says requested 12, only 3 available lets the caller render a message, adjust an order, or alert on a specific shortage. Include the offending value and the limit, keep identifiers stable and greppable, and never include credentials, tokens, or full payloads - error logs are the most widely read and least carefully protected artifact in most systems.',
            'Map to transport exactly once. An `IntoResponse` impl (or a single `map_err` in the router) turns each variant into a status code and a machine-readable body. Scattering that mapping across handlers guarantees drift: one endpoint returns 400 for a conflict and another 409 for the same condition. The mapping table is design documentation, so keep it in one function and test it.'
          ],
          code: `use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

impl IntoResponse for OrderError {
    fn into_response(self) -> Response {
        let status = match &self {
            OrderError::NotFound { .. } => StatusCode::NOT_FOUND,
            OrderError::Conflict { .. } => StatusCode::CONFLICT,
            OrderError::InsufficientStock { .. } => StatusCode::UNPROCESSABLE_ENTITY,
            OrderError::Unavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            OrderError::Unexpected(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };

        // The body is the same vocabulary as the type; the source stays in logs.
        let body = axum::Json(serde_json::json!({ "error": self.to_string() }));
        (status, body).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transient_is_only_unavailable() {
        assert!(!OrderError::Conflict { state: "paid" }.is_transient());
        assert!(OrderError::Unavailable(sqlx::Error::PoolTimedOut).is_transient());
    }
}`,
          tip: 'The error enum and the status-code table are one design; changing a variant without changing the mapping is a bug waiting for a client.'
        }
      ],
      exercise: {
        prompt: 'Write a ParseQty error enum for a quantity parser: missing value, not a number, and out of range (1 to 999). Implement Display, implement From<ParseIntError>, and add a test per variant. The error must name the offending input.',
        starter: `use std::num::ParseIntError;

#[derive(Debug, PartialEq, Eq)]
pub enum QtyError {
    // 1. missing, not-a-number, out-of-range: three distinct conditions
}

impl std::fmt::Display for QtyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        todo!()
    }
}

impl std::error::Error for QtyError {}

impl From<ParseIntError> for QtyError {
    fn from(_: ParseIntError) -> Self {
        todo!()
    }
}

pub fn parse_qty(raw: Option<&str>) -> Result<u32, QtyError> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    // one test per variant, asserting the message contains the input
}`,
        hint: 'Model Missing as a unit variant, NotANumber(String) to keep the input, and OutOfRange { value: u32, max: u32 }. parse_qty uses ok_or(QtyError::Missing)? then raw.parse::<u32>()? and range check. Display writes a specific sentence per variant.',
        solution: `use std::num::ParseIntError;

#[derive(Debug, PartialEq, Eq)]
pub enum QtyError {
    Missing,
    NotANumber(String),
    OutOfRange { value: u32, max: u32 },
}

impl std::fmt::Display for QtyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing => f.write_str("quantity is required"),
            Self::NotANumber(raw) => write!(f, "quantity {raw:?} is not a number"),
            Self::OutOfRange { value, max } => {
                write!(f, "quantity {value} is out of range 1..={max}")
            }
        }
    }
}

impl std::error::Error for QtyError {}

impl From<ParseIntError> for QtyError {
    fn from(_: ParseIntError) -> Self {
        // The input is attached by the caller that still has it.
        Self::NotANumber(String::from("<unparsed>"))
    }
}

pub fn parse_qty(raw: Option<&str>) -> Result<u32, QtyError> {
    let raw = raw.ok_or(QtyError::Missing)?;
    let value: u32 = raw
        .trim()
        .parse()
        .map_err(|_| QtyError::NotANumber(raw.to_owned()))?;

    if !(1..=999).contains(&value) {
        return Err(QtyError::OutOfRange { value, max: 999 });
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_condition_has_its_own_variant_and_message() {
        assert_eq!(parse_qty(None), Err(QtyError::Missing));
        assert_eq!(
            parse_qty(Some("many")),
            Err(QtyError::NotANumber("many".into()))
        );
        assert_eq!(
            parse_qty(Some("1000")),
            Err(QtyError::OutOfRange { value: 1000, max: 999 })
        );
        assert_eq!(parse_qty(Some("12")).unwrap(), 12);
    }

    #[test]
    fn messages_name_the_input() {
        let error = parse_qty(Some("many")).unwrap_err();
        assert_eq!(error.to_string(), "quantity \\"many\\" is not a number");
    }
}`
      },
      production: [
        'No infrastructure error type appears in a public domain signature; driver errors are sources, not variants callers match.',
        'Every public error enum is #[non_exhaustive] and has a documented transient/permanent classification.',
        'Error messages carry the offending value and limit, and never a token, password, or full request body.',
        'Transport mapping lives in exactly one function and has a test per variant.',
        'Library crates return typed errors; only binaries use anyhow, at the top of main.'
      ],
      crates: ['thiserror', 'anyhow', 'axum', 'sqlx'],
      pitfall: 'Deriving #[from] sqlx::Error into a public enum: every driver error becomes a variant-less blob, callers cannot distinguish a duplicate key from an outage, and the driver version is now part of your API.',
      questions: [
        {
          q: 'Why is sqlx::Error in a public function signature a design problem?',
          options: [
            'It is too large to return',
            'It exposes the storage mechanism and gives the caller no domain vocabulary',
            'It cannot implement std::error::Error',
            'It prevents using the ? operator'
          ],
          answer: 1,
          explain: 'The caller learns which driver failed, not what to do. It also couples your API to the driver version, so an upgrade becomes a breaking change.'
        },
        {
          q: 'Which failure justifies a distinct error variant rather than a source chain alone?',
          options: [
            'The connection string is malformed',
            'A unique constraint rejected the write because the order already exists',
            'The server ran out of file descriptors',
            'A TCP packet was dropped'
          ],
          answer: 1,
          explain: 'A duplicate order is a domain condition the caller can act on. The others are infrastructure conditions that the caller cannot fix and should see as unavailable.'
        },
        {
          q: 'What belongs in an error message returned to an external client?',
          options: [
            'The full SQL statement for debugging',
            'The condition, the offending value, and the limit or expectation',
            'The internal hostname and pool name',
            'The upstream stack trace'
          ],
          answer: 1,
          explain: 'Clients need actionable facts. Internal topology and stack traces belong in logs, and including them in responses is an information leak.'
        }
      ],
      quickbytes: [
        'Design the enum for the caller decision, not for the code path that produced it.',
        'One hand-written From per driver is where infrastructure vocabulary becomes domain vocabulary.',
        'Map error to status once, in one function, with a test per variant.'
      ],
      github: [
        { name: 'dtolnay/thiserror - derive for typed library errors', url: 'https://github.com/dtolnay/thiserror' },
        { name: 'tokio-rs/axum - IntoResponse and the error-handling model', url: 'https://github.com/tokio-rs/axum' }
      ],
      resources: [
        {
          title: 'thiserror crate documentation',
          url: 'https://docs.rs/thiserror/latest/thiserror/',
          kind: 'docs'
        },
        {
          title: 'Rust API Guidelines: error types are meaningful and well-behaved',
          url: 'https://rust-lang.github.io/api-guidelines/interoperability.html',
          kind: 'docs'
        },
        {
          title: 'The Rust Book: recoverable errors with Result',
          url: 'https://doc.rust-lang.org/book/ch09-02-recoverable-errors-with-result.html',
          kind: 'docs'
        },
        {
          title: 'Simple Testing Can Prevent Most Critical Failures (error-handling bugs in production)',
          url: 'https://www.usenix.org/conference/osdi14/technical-sessions/presentation/yuan',
          kind: 'paper'
        }
      ]
    },
    {
      id: 'dp12',
      title: 'Naming: units, verbs, and the conventions std already set',
      minutes: 60,
      level: 'core',
      goal: 'Name types and functions so a call site is readable without the definition, and follow the as/into/to/try conventions callers already know.',
      sections: [
        {
          h: 'Put the unit in the type, or failing that, the suffix',
          p: [
            'A bare `u64` named `timeout` is a unit bug waiting for a caller: seconds, milliseconds, or microseconds, and the compiler accepts all three. `Duration` makes the unit part of the value. When a newtype is too much ceremony - a database column read, a metric - the suffix has to carry it: `timeout_ms`, `created_at`, `size_bytes`, `total_cents`. The rule is that a reader should never have to open the definition to know what a number means.',
            'The same applies to booleans (`is_active`, `has_quota`, `can_retry`) and to collections (`invoices`, not `invoice_list`; `by_id`, not `map`). Vague nouns are the most expensive names because they survive review: `data`, `info`, `payload`, `manager`, `helper`, `util`. Each one is a claim that the contents have no shape worth naming, which is almost never true and always costs the next reader.'
          ],
          list: [
            'Timestamps end in _at; durations end in _ms or use Duration',
            'Money is MinorUnits or _cents, never a bare float',
            'Plural names for collections, singular for a single value',
            'No Manager, Helper, Util, Data, or Info in a public name'
          ],
          tip: 'If renaming a variable to include its unit would have prevented a production incident, the type should have carried it.'
        },
        {
          h: 'Conversion verbs are a contract',
          p: [
            'Rust has a naming convention that encodes cost and ownership, and callers rely on it whether or not you document it. `as_` borrows cheaply and returns a reference. `to_` may allocate and returns an owned or copied value. `into_` consumes self. `try_` returns a Result. Getters drop the `get_` prefix: `len()`, not `get_len()`. Constructors are `new` for the canonical case and `with_` for variants, as in `Vec::with_capacity`.',
            'Breaking these conventions is a small lie in every call site. A `to_string` that blocks on I/O, an `as_slice` that allocates, a `get_user` that returns a Result - each one teaches readers to distrust the name and open the implementation. The API guidelines list these as checkable rules, and clippy has lints for several of them, so there is no reason to invent a dialect.'
          ],
          code: `use std::path::{Path, PathBuf};
use std::time::Duration;

// Before: unit-free, verb-free, and every call site is a guess.
pub fn fetch(url: &str, timeout: u64, retry: bool) -> Result<String, String> {
    todo!()
}

// After: ownership, fallibility, units, and intent are in the signature.
pub fn fetch_typed(url: &Url, timeout: Duration, retries: Retries) -> Result<Body, FetchError> {
    todo!()
}

pub struct Url(String);
pub struct Body(String);
pub struct Retries(u32);
pub struct FetchError;

impl Config {
    // Not get_max_connections: Rust getters drop the prefix.
    pub fn max_connections(&self) -> usize {
        self.max_connections
    }

    // as_: cheap borrow, no allocation, no I/O.
    pub fn as_path(&self) -> &Path {
        &self.path
    }

    // into_: consumes self, transfers ownership.
    pub fn into_path(self) -> PathBuf {
        self.path
    }

    // with_: a variant constructor, chainable.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

pub struct Config {
    max_connections: usize,
    path: PathBuf,
    timeout: Duration,
}`,
          tip: 'A function named as_ that allocates is a bug report waiting to be written by someone profiling.'
        },
        {
          h: 'Symmetry and the ubiquitous language',
          p: [
            'Names that come in pairs should be opposites: open and close, acquire and release, lock and unlock, subscribe and unsubscribe. Asymmetry - `create` and `destroy`, `send` and `recv` - forces readers to remember which word belongs to which direction. Pick the pair early, put it in the module docs, and use it everywhere, including in metric names and log fields, where mismatched vocabulary makes dashboards useless.',
            'Use the domain word, not a synonym. If the business says invoice, do not name the type Bill in one module and Invoice in another; the translation layer becomes a place where bugs hide, and a reader has to build a private glossary. When the domain word is bad - ambiguous or overloaded - rename it in the domain conversation first, then in the code, so the two stay aligned.'
          ],
          tip: 'Search for synonym pairs across modules: bill/invoice, customer/client, order/purchase. Each pair is a translation bug waiting to happen.'
        }
      ],
      exercise: {
        prompt: 'Rename and re-type this API so the signature states ownership, units, fallibility, and intent: fn process(data: String, flag: bool, timeout: u64) -> String. Keep one function, add the types it needs, and show a call site that reads clearly.',
        starter: `// The original signature: four questions at every call site.
pub fn process(data: String, flag: bool, timeout: u64) -> String {
    todo!()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Fast,
    Thorough,
}

// 1. Replace data with the type it actually is.
// 2. Replace flag with Mode.
// 3. Replace timeout with std::time::Duration.
// 4. Return Result instead of a String that might be an error.

pub fn analyse(input: &Input, mode: Mode, budget: std::time::Duration)
    -> Result<Report, AnalyseError>
{
    todo!()
}

pub struct Input(pub String);
pub struct Report(pub String);
pub struct AnalyseError;`,
        hint: 'analyse matches on mode, records the budget in the report, and returns Ok. The point is the signature: &Input says borrowing, Mode says which behaviour, Duration says units, Result says fallible.',
        solution: `use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Fast,
    Thorough,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Input(pub String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub summary: String,
    pub mode: Mode,
    pub budget_ms: u128,
}

#[derive(Debug, PartialEq, Eq)]
pub struct AnalyseError;

pub fn analyse(
    input: &Input,
    mode: Mode,
    budget: Duration,
) -> Result<Report, AnalyseError> {
    if input.0.is_empty() {
        return Err(AnalyseError);
    }

    let summary = match mode {
        Mode::Fast => format!("{} (first pass)", input.0),
        Mode::Thorough => format!("{} (full pass)", input.0),
    };

    Ok(Report {
        summary,
        mode,
        budget_ms: budget.as_millis(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_call_site_reads_like_a_sentence() {
        let input = Input(String::from("ledger"));
        let report = analyse(&input, Mode::Thorough, Duration::from_millis(250)).unwrap();

        assert_eq!(report.mode, Mode::Thorough);
        assert_eq!(report.budget_ms, 250);
        assert!(report.summary.contains("full pass"));
    }

    #[test]
    fn empty_input_is_an_error_not_an_empty_report() {
        assert_eq!(
            analyse(&Input(String::new()), Mode::Fast, Duration::ZERO),
            Err(AnalyseError)
        );
    }
}`
      },
      production: [
        'No public field or parameter carries a bare number whose unit is only in a comment.',
        'All conversion methods follow as_/to_/into_/try_ and the cost they promise.',
        'Getters use the bare noun, not get_; constructors use new and with_.',
        'Paired operations share an opposite pair and the pair appears in logs and metrics.',
        'One domain word per concept across modules; synonym pairs are treated as defects.'
      ],
      crates: ['serde', 'typed-builder', 'tracing'],
      pitfall: 'A timeout parameter documented in seconds but passed milliseconds by one caller: the compiler sees u64 on both sides, the tests use small values, and the bug only appears under load.',
      questions: [
        {
          q: 'Which name promises the wrong cost?',
          options: [
            'fn as_bytes(&self) -> &[u8]',
            'fn as_string(&self) -> String',
            'fn into_inner(self) -> T',
            'fn try_parse(&self) -> Result<T, E>'
          ],
          answer: 1,
          explain: 'as_ promises a cheap borrow. Returning an owned String allocates, so the name should be to_string (or the return should be &str).'
        },
        {
          q: 'Why is a bare u64 timeout risky even when documented?',
          options: [
            'u64 is slower than u32',
            'Callers pass different units and the compiler cannot tell; Duration encodes the unit',
            'u64 cannot be serialized',
            'It overflows after 49 days'
          ],
          answer: 1,
          explain: 'Documentation is not checked. Duration makes the unit part of the value, so a seconds value cannot be passed where milliseconds are expected without a conversion call.'
        },
        {
          q: 'A crate has both Bill and Invoice types for the same concept. What is the concrete cost?',
          options: [
            'Larger binary',
            'Two vocabularies that must be translated, so every handoff is a place for bugs',
            'Slower compilation',
            'Serialization conflicts'
          ],
          answer: 1,
          explain: 'Synonyms create a translation layer nobody owns. Either they are different concepts and should be named so, or one word is correct and the other should disappear.'
        }
      ],
      quickbytes: [
        'Units go in the type; when they cannot, they go in the suffix and the doc comment.',
        'as_ borrows, to_ copies or allocates, into_ consumes, try_ can fail - do not break the promise.',
        'Pick opposite pairs and the domain word once; use them in code, logs, and metrics.'
      ],
      github: [
        { name: 'rust-lang/api-guidelines - naming conventions as checkable rules', url: 'https://github.com/rust-lang/api-guidelines' },
        { name: 'rust-lang/rust-clippy - lints for naming and argument design', url: 'https://github.com/rust-lang/rust-clippy' }
      ],
      resources: [
        {
          title: 'Rust API Guidelines: naming',
          url: 'https://rust-lang.github.io/api-guidelines/naming.html',
          kind: 'docs'
        },
        {
          title: 'Clippy lint list: too_many_arguments, fn_params_excessive_bools, and friends',
          url: 'https://rust-lang.github.io/rust-clippy/master/index.html',
          kind: 'docs'
        },
        {
          title: 'The Rust Book: growing projects and module naming',
          url: 'https://doc.rust-lang.org/book/ch07-00-managing-growing-projects-with-packages-crates-and-modules.html',
          kind: 'docs'
        },
        {
          title: 'Rust API Guidelines repository',
          url: 'https://github.com/rust-lang/api-guidelines',
          kind: 'repo'
        }
      ]
    },
    {
      id: 'dp13',
      title: 'Simplicity: DRY is about knowledge, not identical text',
      minutes: 65,
      level: 'core',
      goal: 'Separate duplicated knowledge from incidental similarity, price an abstraction in concepts, and delete the framework that saved six lines.',
      sections: [
        {
          h: 'Essential and accidental complexity',
          p: [
            'The complexity of a system has two parts. Essential complexity is the problem: tax rules, retries, permissions, the state machine of an order. Accidental complexity is everything the implementation adds: layers, indirection, configuration, the abstraction that exists because two functions looked alike. No process removes essential complexity; a design process makes accidental complexity visible so it can be refused.',
            'The test for accidental complexity is a deletion experiment. Remove the abstraction and see what breaks. If the code gets shorter and clearer, the abstraction was accidental. If it gets duplicated in ways that must change together, the abstraction was carrying knowledge. Most code review arguments about simplicity are actually disagreements about which of these two cases the code is in, and the experiment settles it faster than the argument.'
          ],
          tip: 'Count the concepts a reader must hold to follow a change. That count, not the line count, is the complexity you are paying.'
        },
        {
          h: 'DRY: one source of truth for each piece of knowledge',
          p: [
            'DRY is often read as no two identical blocks, which produces premature abstraction. The principle is that every piece of knowledge should have one authoritative representation. A tax rate repeated in three functions is a DRY violation because the knowledge - the rate and its rounding rule - now has three homes. Two identical two-line formatting snippets in different bounded contexts are not a violation: they look alike but encode different decisions that will diverge.',
            'The rule of three is a practical threshold: the first time, write it; the second time, notice it; the third time, extract it with the axis of variation known. Extracting on the second occurrence guesses the parameter, and the guess is visible in the signature - an `Option<Config>` argument that only one caller passes, or a generic that every caller instantiates with the same type.'
          ],
          list: [
            'Duplicate knowledge: rates, limits, formats, protocol rules - one home',
            'Incidental similarity: two short blocks that happen to look alike - leave them',
            'Third occurrence: extract, now that the variation is known',
            'If the extracted function needs a bool to select behaviour, the axis is probably wrong'
          ],
          code: `// Duplicated knowledge: the rate and the rounding rule live in three places.
pub fn invoice_total(subtotal: u64) -> u64 {
    subtotal + subtotal * 825 / 10_000
}

pub fn quote_total(subtotal: u64) -> u64 {
    subtotal + subtotal * 825 / 10_000
}

// One source of truth, and the rate becomes testable data.
pub struct TaxPolicy {
    pub rate_bp: u32,
}

impl TaxPolicy {
    pub fn total(&self, subtotal: u64) -> u64 {
        subtotal + subtotal * u64::from(self.rate_bp) / 10_000
    }
}

// Incidental similarity in another context: leave these separate.
// They format different documents for different audiences and will diverge.
fn render_receipt_line(qty: u32, unit_cents: u64) -> String {
    format!("{qty} x {}.{:02}", unit_cents / 100, unit_cents % 100)
}

fn render_packing_slip_line(qty: u32, unit_cents: u64) -> String {
    format!("{qty} x {}.{:02}", unit_cents / 100, unit_cents % 100)
}`,
          tip: 'Ask what will force the two copies to change. If the answer is the same rule, merge; if it is the same coincidence, do not.'
        },
        {
          h: 'Price the abstraction before you write it',
          p: [
            'An abstraction costs a trait, a generic parameter, sometimes a lifetime and a box, and a new concept in the reader head. At six call sites with identical shapes it pays. At one call site and two ninety-percent-similar ones it usually does not, and the bill arrives when the next requirement forces a `mode` argument into the middle of it. YAGNI is not an argument against design; it is an argument against designing for a requirement you do not have evidence for.',
            'There is one exception worth naming: irreversible decisions. A wire format, a database schema, a public crate API - these are expensive to change later, so designing them for plausible futures is rational. Internal function signatures are cheap to change, so the default should be the simplest thing that works today, with the freedom to refactor tomorrow.'
          ],
          tip: 'Design the boundaries you cannot change later; keep the interiors boring and editable.'
        }
      ],
      exercise: {
        prompt: 'Three functions compute the same subtotal-plus-tax with the rate inlined. Extract the knowledge into one policy value, then write a second, deliberately separate formatter for a packing slip and explain in a comment why it stays separate.',
        starter: `pub fn invoice_total(subtotal: u64) -> u64 {
    subtotal + subtotal * 825 / 10_000
}

pub fn quote_total(subtotal: u64) -> u64 {
    subtotal + subtotal * 825 / 10_000
}

pub fn deposit_total(subtotal: u64) -> u64 {
    subtotal + subtotal * 825 / 10_000
}

#[derive(Debug, Clone, Copy)]
pub struct TaxPolicy {
    pub rate_bp: u32,
}

impl TaxPolicy {
    pub fn total(&self, subtotal: u64) -> u64 {
        todo!()
    }
}

/// Deliberately not shared with invoice formatting: different audience,
/// different rounding expectations, and it will diverge.
pub fn render_packing_slip_line(qty: u32, unit_cents: u64) -> String {
    todo!()
}`,
        hint: 'TaxPolicy::total is subtotal + subtotal * rate_bp / 10_000 with u64::from. The three wrappers can call TaxPolicy { rate_bp: 825 }.total(subtotal) or be deleted. The packing slip line is its own format string.',
        solution: `#[derive(Debug, Clone, Copy)]
pub struct TaxPolicy {
    pub rate_bp: u32,
}

impl TaxPolicy {
    pub fn total(&self, subtotal: u64) -> u64 {
        subtotal + subtotal * u64::from(self.rate_bp) / 10_000
    }
}

pub const STANDARD_TAX: TaxPolicy = TaxPolicy { rate_bp: 825 };

pub fn invoice_total(subtotal: u64) -> u64 {
    STANDARD_TAX.total(subtotal)
}

pub fn quote_total(subtotal: u64) -> u64 {
    STANDARD_TAX.total(subtotal)
}

pub fn deposit_total(subtotal: u64) -> u64 {
    // Deposits use the same standard rate today; the call site is the seam
    // where a different policy would be passed if that changes.
    STANDARD_TAX.total(subtotal)
}

/// Deliberately not shared with invoice formatting: different audience,
/// different rounding expectations, and it will diverge.
pub fn render_packing_slip_line(qty: u32, unit_cents: u64) -> String {
    format!("{qty} x {}.{:02}", unit_cents / 100, unit_cents % 100)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_policy_drives_all_totals() {
        assert_eq!(invoice_total(10_000), 10_825);
        assert_eq!(quote_total(10_000), 10_825);
        assert_eq!(deposit_total(10_000), 10_825);
        assert_eq!(TaxPolicy { rate_bp: 0 }.total(10_000), 10_000);
    }

    #[test]
    fn packing_slip_is_its_own_format() {
        assert_eq!(render_packing_slip_line(3, 1_299), "3 x 12.99");
    }
}`
      },
      production: [
        'Every rate, limit, and protocol constant has exactly one definition, referenced by tests.',
        'An abstraction with one call site is justified in a comment or deleted.',
        'Extraction happens at the third occurrence, with the axis of variation named in the function signature.',
        'No boolean mode parameter selects between two behaviours inside a shared helper.',
        'Irreversible boundaries (wire formats, schemas, public APIs) are designed deliberately; interiors stay simple.'
      ],
      crates: ['serde', 'thiserror', 'tracing'],
      pitfall: 'A generic Engine<T, C, S> with one instantiation, three phantom parameters, and a trait added to save six duplicated lines: every future change now has to be threaded through machinery that buys nothing.',
      questions: [
        {
          q: 'Two identical ten-line blocks live in different modules and change for different reasons. What should you do?',
          options: [
            'Extract them into a shared helper immediately',
            'Leave them separate; the duplication is incidental, not shared knowledge',
            'Make them generic over a trait to allow both behaviours',
            'Move them into a util module and re-export'
          ],
          answer: 1,
          explain: 'DRY is about knowledge with one authoritative representation. Similar text that changes for different reasons will diverge; merging it creates a false coupling.'
        },
        {
          q: 'When does extracting an abstraction usually pay?',
          options: [
            'On the first occurrence, to avoid future work',
            'On the third occurrence, when the axis of variation is known',
            'Only when the code is longer than fifty lines',
            'Whenever clippy reports duplicated code'
          ],
          answer: 1,
          explain: 'Extracting earlier guesses the parameter. The third occurrence usually reveals what actually varies, so the signature can be right the first time.'
        },
        {
          q: 'Which decision deserves design for a future you do not have yet?',
          options: [
            'A private helper function signature',
            'A public wire format you will have to support for years',
            'The name of a local variable',
            'The order of fields in an internal struct'
          ],
          answer: 1,
          explain: 'YAGNI applies to cheap, reversible decisions. Wire formats and public APIs are expensive to change, so the cost of over-designing them is lower than the cost of a breaking migration.'
        }
      ],
      quickbytes: [
        'DRY guards knowledge, not text: merge when the same rule changes both copies.',
        'Duplicate twice, extract on the third time, when you know what varies.',
        'Design irreversible boundaries; keep reversible interiors boring.'
      ],
      github: [
        { name: 'papers-we-love/papers-we-love - Out of the Tar Pit on accidental complexity', url: 'https://github.com/papers-we-love/papers-we-love' },
        { name: 'rust-unofficial/patterns - anti-patterns including over-abstraction', url: 'https://github.com/rust-unofficial/patterns' }
      ],
      resources: [
        {
          title: 'Out of the Tar Pit: essential and accidental complexity (PDF)',
          url: 'https://github.com/papers-we-love/papers-we-love/blob/main/design/out-of-the-tar-pit.pdf',
          kind: 'paper'
        },
        {
          title: 'Rust API Guidelines: flexibility without speculative generality',
          url: 'https://rust-lang.github.io/api-guidelines/flexibility.html',
          kind: 'docs'
        },
        {
          title: 'Rust Design Patterns: anti-patterns',
          url: 'https://github.com/rust-unofficial/patterns',
          kind: 'repo'
        },
        {
          title: 'Clippy: lints that flag needless complexity',
          url: 'https://rust-lang.github.io/rust-clippy/master/index.html',
          kind: 'docs'
        }
      ]
    },
    {
      id: 'dp14',
      title: 'Least surprise: behave the way the standard library behaves',
      minutes: 65,
      level: 'advanced',
      goal: 'Audit a public type for behaviour that contradicts its name or std conventions, and remove hidden work from Drop, Display, and Clone.',
      sections: [
        {
          h: 'Semantics std has already taught your users',
          p: [
            'Every Rust programmer has expectations baked in by the standard library. `len()` is O(1) and `is_empty()` does not scan. `Index` panics on a missing key while `get` returns `Option`. `From` is infallible and cheap. `Display` is for humans and `Debug` is for developers. `Clone` is visible in the source, so its cost is a choice the caller made. A type that violates one of these is not clever; it is a trap that works until someone reads the definition.',
            'The most common violation is hidden work. `impl From<&str> for Config` that reads a file makes `Config::from("app.toml")` look like a parse and behave like I/O: no error type, no async, no way to test without touching disk. `Display` that performs a network lookup makes `format!` fail silently or panic. The fix is a named method with an honest signature - `Config::load(path) -> Result<Config, ConfigError>` - and a rule that trait impls stay cheap and total.'
          ],
          list: [
            'From: infallible and cheap; anything else gets a named, fallible constructor',
            'Index: may panic; get returns Option - do not invert them',
            'Display: lossless enough to support the user, never a data interchange format',
            'Clone: proportional to visible data, no I/O, no locks held across it'
          ],
          tip: 'If a trait method can surprise a reader who never opens your docs, it will, and the surprise will be at 3am.'
        },
        {
          h: 'Drop cannot say sorry',
          p: [
            '`Drop` runs during unwinding, in a random thread, with no way to report failure. Blocking there can deadlock a runtime; panicking there aborts the process. So anything that must be awaited, flushed, or reported cannot live in `Drop`. A pool that needs to drain, a file that must be fsynced, a message that must be acknowledged - each needs an explicit method, usually consuming `self`, and ideally idempotent so double-shutdown is harmless.',
            'The `#[must_use]` attribute is the other half of the same idea. A guard whose whole purpose is a side effect on drop should be marked `must_use` with a message saying what dropping it does, so `let _ = lock();` becomes a warning instead of a silently released lock. If the only job of a value is to be used, the compiler should complain when it is not.'
          ],
          code: `pub struct Connection {
    socket: std::net::TcpStream,
    shutdown: bool,
}

impl Connection {
    /// Explicit shutdown: can report failure and can be awaited by callers.
    pub async fn shutdown(mut self) -> std::io::Result<()> {
        self.shutdown = true;
        // flush, half-close, wait for peer close...
        Ok(())
    }

    pub fn is_closed(&self) -> bool {
        self.shutdown
    }
}

// No Drop impl that blocks or panics. A dropped connection closes the
// socket lazily; the OS handles the rest. Callers who need a clean
// protocol-level close must call shutdown().await.

#[must_use = "the guard drops at the end of the statement, releasing the lock"]
pub struct Guard<'a> {
    inner: &'a std::sync::Mutex<u32>,
}

impl Guard<'_> {
    pub fn read(&self) -> u32 {
        *self.inner.lock().unwrap()
    }
}`,
          tip: 'If shutdown must be reliable, make it a method that returns Result and mark the type must_use; never rely on Drop for protocol work.'
        },
        {
          h: 'Consistency inside your own crate',
          p: [
            'Surprise is relative: users learn your crate the way they learn std. If `create` is fallible in one module and infallible in another, or if `close` is idempotent for connections but not for files, the inconsistency is the trap. Pick one verb per action, one error style per boundary, one naming scheme per concept, and write it into the crate docs so reviewers can point at it.',
            'Consistency also means the shape of the API mirrors the shape of the domain. A module per aggregate, one constructor per invariant, one error enum per boundary, one place where each status code is chosen. When the structure matches the domain, a reader predicts where a change goes before searching for it - which is the practical definition of a maintainable system.'
          ],
          tip: 'New contributors predict your API from your first three functions. Make those three consistent.'
        }
      ],
      exercise: {
        prompt: 'A Config type implements From<&str> by reading a file and panicking on failure. Replace it with a fallible, named constructor, keep a separate infallible From for the in-memory case, and add a Display impl that cannot fail.',
        starter: `pub struct Config {
    pub name: String,
}

// 1. Remove this impl: it hides I/O and cannot report failure.
impl From<&str> for Config {
    fn from(path: &str) -> Self {
        todo!()
    }
}

impl Config {
    /// Reads and parses a config file. The only I/O entry point.
    pub fn load(path: &str) -> Result<Self, ConfigError> {
        todo!()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl std::fmt::Display for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        todo!()
    }
}`,
        hint: 'load returns Err(ConfigError) when the path is empty or has no stem, Ok with the file stem as name otherwise. From<&str> should be replaced by From<String> (in-memory name, infallible). Display writes the name without allocation.',
        solution: `#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub name: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl Config {
    /// Reads and parses a config file. The only I/O entry point.
    pub fn load(path: &str) -> Result<Self, ConfigError> {
        if path.trim().is_empty() {
            return Err(ConfigError(String::from("path is empty")));
        }
        let stem = std::path::Path::new(path)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .ok_or_else(|| ConfigError(format!("no file name in {path:?}")))?;
        Ok(Self { name: stem.to_owned() })
    }

    pub fn name(&self) -> &str {
        &self.name
    }
}

// Infallible, cheap, no I/O: From is allowed here.
impl From<String> for Config {
    fn from(name: String) -> Self {
        Self { name }
    }
}

impl std::fmt::Display for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_is_fallible_and_reports_why() {
        assert_eq!(Config::load("  ").unwrap_err(), ConfigError("path is empty".into()));
        assert_eq!(Config::load("settings.toml").unwrap().name(), "settings");
    }

    #[test]
    fn conversion_is_infallible_and_allocation_only() {
        let config = Config::from(String::from("in-memory"));
        assert_eq!(config.to_string(), "in-memory");
    }
}`
      },
      production: [
        'No From impl performs I/O, allocates unboundedly, or panics; such constructors are named and return Result.',
        'Drop never blocks on a runtime, never panics, and never performs protocol-level shutdown.',
        'Guards and other drop-side-effect types are #[must_use] with a message explaining the effect.',
        'Index and get keep their std meanings; panicking accessors are documented as such.',
        'One verb per action and one error enum per boundary, stated in the crate docs.'
      ],
      crates: ['thiserror', 'tracing', 'tokio'],
      pitfall: 'A dedicated shutdown that blocks inside Drop: dropping a connection inside the runtime deadlocks the worker, or aborts the process during unwinding, and the failure appears unrelated to the code that dropped it.',
      questions: [
        {
          q: 'Which behaviour belongs in Drop?',
          options: [
            'Flushing a network buffer and reporting the result',
            'Releasing a local lock and freeing memory',
            'Waiting for a peer to acknowledge a close',
            'Retrying a failed write'
          ],
          answer: 1,
          explain: 'Drop cannot report errors, must not block, and must not panic. Local resource release is fine; anything that needs to be awaited or reported belongs in an explicit method.'
        },
        {
          q: 'Why is impl From<&str> for Config that reads a file a design problem?',
          options: [
            'From must be implemented for String instead',
            'From promises an infallible, cheap conversion, but I/O can fail and block',
            'It makes Config impossible to serialize',
            'It violates the orphan rule'
          ],
          answer: 1,
          explain: 'The trait contract is a promise to callers. Doing fallible, blocking work behind an infallible signature removes any way to handle the failure.'
        },
        {
          q: 'A crate indexes a missing key with panic and also offers get returning Option. Is that consistent?',
          options: [
            'No, both should return Option',
            'Yes, it matches std: Index panics, get returns Option',
            'No, both should panic',
            'Only if the type is a map'
          ],
          answer: 1,
          explain: 'Matching std means readers can predict behaviour without documentation. The pair Index/panics and get/Option is the convention they already know.'
        }
      ],
      quickbytes: [
        'From must be infallible and cheap; anything else is a named constructor returning Result.',
        'Drop cannot report, await, or retry; make shutdown an explicit consuming method.',
        'Pick one verb per action and one error enum per boundary, and write it down.'
      ],
      github: [
        { name: 'rust-lang/api-guidelines - predictability and constructor conventions', url: 'https://github.com/rust-lang/api-guidelines' },
        { name: 'tokio-rs/tokio - shutdown patterns that avoid blocking Drop', url: 'https://github.com/tokio-rs/tokio' }
      ],
      resources: [
        {
          title: 'Rust API Guidelines: predictability',
          url: 'https://rust-lang.github.io/api-guidelines/predictability.html',
          kind: 'docs'
        },
        {
          title: 'std::ops::Drop documentation: panics and blocking',
          url: 'https://doc.rust-lang.org/std/ops/trait.Drop.html',
          kind: 'docs'
        },
        {
          title: 'std::convert::From: the infallible conversion contract',
          url: 'https://doc.rust-lang.org/std/convert/trait.From.html',
          kind: 'docs'
        },
        {
          title: 'Rust API Guidelines repository',
          url: 'https://github.com/rust-lang/api-guidelines',
          kind: 'repo'
        }
      ]
    },
    {
      id: 'dp15',
      title: 'Fail-fast: validate at startup, never silently default',
      minutes: 70,
      level: 'core',
      goal: 'Distinguish programmer errors from expected failures, reject bad configuration at boot with a clear message, and keep request paths free of panics.',
      sections: [
        {
          h: 'Two kinds of failure, two mechanisms',
          p: [
            'A panic is for a broken invariant in your code: an index that cannot be out of bounds, a match arm that cannot occur. A Result is for a condition the caller must handle: a missing file, a conflict, a timeout. Using the wrong mechanism is a design error in both directions. `unwrap()` on user input turns a bad request into a crash loop; returning Result for a bug that no caller can fix hides the bug behind an error branch nobody reads.',
            'The useful test is who can act. If the caller can retry, fix the input, or choose another path, return a Result. If nothing can be done except fix the program, panic - and panic early, with a message that names the invariant. Startup is the best place for the second kind: a misconfigured process should refuse to start, loudly, rather than serve traffic with a default that silently changes behaviour.'
          ],
          tip: 'Panic for bugs, return for conditions. A panic in a request path is a bug you chose to discover in production.'
        },
        {
          h: 'Configuration is validated once, at boot',
          p: [
            'Configuration errors are the cheapest production incidents to prevent and the most common to ship. The fix is a single load function that reads every required value, rejects unknown keys, validates ranges and formats, and returns a typed error naming the key. `#[serde(deny_unknown_fields)]` turns a typo into a startup failure instead of a setting that is silently ignored - which is worse than a crash, because the process looks healthy.',
            'The silent default is the enemy. `env::var("DATABASE_URL").unwrap_or_default()` produces an empty string that fails much later with a confusing driver error. `unwrap_or(30)` for a timeout hides the fact that the deployment forgot to set it. Every default must be deliberate, documented, and harmless; a required value with no default must fail at boot with its name in the message.'
          ],
          list: [
            'Parse into a typed Config; never read env vars at call sites',
            'Reject unknown keys and invalid ranges at startup',
            'Name the offending key and the expected shape in the error',
            'Exit non-zero so the orchestrator restarts or alerts instead of serving broken'
          ],
          code: `use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub database_url: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub max_connections: u32,
}

fn default_port() -> u16 {
    8080
}

impl Config {
    pub fn validate(self) -> Result<Self, ConfigError> {
        if !self.database_url.starts_with("postgres://") {
            return Err(ConfigError::Key {
                key: "database_url",
                reason: "must start with postgres://",
            });
        }
        if self.max_connections == 0 || self.max_connections > 512 {
            return Err(ConfigError::Key {
                key: "max_connections",
                reason: "must be in 1..=512",
            });
        }
        Ok(self)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("invalid config key {key}: {reason}")]
    Key { key: &'static str, reason: &'static str },
    #[error("could not read config: {0}")]
    Read(#[from] std::io::Error),
    #[error("could not parse config: {0}")]
    Parse(#[from] serde_json::Error),
}

fn main() -> Result<(), ConfigError> {
    // Fail here, once, before any listener is bound.
    let raw = std::fs::read_to_string("config.json")?;
    let config: Config = serde_json::from_str(&raw)?.validate()?;
    run(config)
}

fn run(_config: Config) -> Result<(), ConfigError> {
    Ok(())
}`,
          tip: 'A process that starts with a bad config is worse than one that refuses to start: the first serves wrong answers, the second pages you once.'
        },
        {
          h: 'Fail fast inside a request, without taking the process down',
          p: [
            'In a request path, fast failure means returning an error immediately instead of continuing with a half-valid value. It does not mean panicking: a panic in a handler unwinds that task, the connection is dropped, and the client sees a reset with no useful body. The `?` operator on a validated type gives the fast path with a proper response, and the type system ensures the failure happens before any write.',
            'One caveat worth knowing: a panic inside a tokio task does not kill the process by default. It aborts the task and surfaces only if someone awaits the JoinHandle. That makes panics in spawned work especially dangerous - they vanish. Log them, propagate them through a JoinHandle, or use a panic hook that records a metric; do not let a supervisor assume a task is healthy because the process is.'
          ],
          code: `use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

pub async fn handler(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::Json(request): axum::Json<CreateOrder>,
) -> Result<axum::Json<OrderView>, AppError> {
    // Fail before any I/O: the type is already validated by Json<T>.
    let order = state
        .orders
        .place(request)
        .await?; // AppError: IntoResponse, no unwrap, no panic

    Ok(axum::Json(order))
}

pub struct AppState {
    pub orders: Orders,
}

pub struct Orders;

impl Orders {
    pub async fn place(&self, _request: CreateOrder) -> Result<OrderView, AppError> {
        Ok(OrderView)
    }
}

pub struct CreateOrder;
pub struct OrderView;

pub struct AppError;

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
    }
}`,
          tip: 'A panic in a spawned task disappears unless you await its JoinHandle. Treat panics as telemetry events, not as control flow.'
        }
      ],
      exercise: {
        prompt: 'Write a startup config loader over key/value pairs that rejects unknown keys, a missing required key, and a port outside 1..=65535, returning an error that names the key. No default for the required value; a documented default only for the optional one.',
        starter: `#[derive(Debug, PartialEq, Eq)]
pub struct Config {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ConfigError {
    Missing(&'static str),
    Unknown(String),
    OutOfRange { key: &'static str, value: String },
}

pub fn load(pairs: &[(&str, &str)]) -> Result<Config, ConfigError> {
    todo!()
}`,
        hint: 'Loop over pairs matching host and port; any other key returns Unknown. Track whether host was seen. Port parses to u16 and must be non-zero. Missing host is Missing("host"). Default port 8080 only when absent.',
        solution: `#[derive(Debug, PartialEq, Eq)]
pub struct Config {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ConfigError {
    Missing(&'static str),
    Unknown(String),
    OutOfRange { key: &'static str, value: String },
}

pub fn load(pairs: &[(&str, &str)]) -> Result<Config, ConfigError> {
    let mut host: Option<String> = None;
    let mut port: u16 = 8080; // documented default, optional key only

    for (key, value) in pairs {
        match *key {
            "host" => host = Some((*value).to_owned()),
            "port" => {
                let parsed: u16 = value
                    .parse()
                    .map_err(|_| ConfigError::OutOfRange { key: "port", value: (*value).to_owned() })?;
                if parsed == 0 {
                    return Err(ConfigError::OutOfRange {
                        key: "port",
                        value: (*value).to_owned(),
                    });
                }
                port = parsed;
            }
            other => return Err(ConfigError::Unknown(other.to_owned())),
        }
    }

    let host = host.ok_or(ConfigError::Missing("host"))?;
    Ok(Config { host, port })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_config_parses_with_the_documented_default() {
        assert_eq!(
            load(&[("host", "0.0.0.0")]).unwrap(),
            Config { host: "0.0.0.0".into(), port: 8080 }
        );
    }

    #[test]
    fn every_bad_shape_fails_at_startup_with_the_key_named() {
        assert_eq!(load(&[]).unwrap_err(), ConfigError::Missing("host"));
        assert_eq!(
            load(&[("host", "h"), ("hots", "typo")]).unwrap_err(),
            ConfigError::Unknown("hots".into())
        );
        assert_eq!(
            load(&[("host", "h"), ("port", "0")]).unwrap_err(),
            ConfigError::OutOfRange { key: "port", value: "0".into() }
        );
    }
}`
      },
      production: [
        'The process validates all configuration before binding a listener and exits non-zero on failure.',
        'Required configuration has no silent default; every default is documented and harmless.',
        'Unknown configuration keys are rejected, so a typo cannot be silently ignored.',
        'No unwrap or expect in a request path; panics there are treated as bugs with metric and alert coverage.',
        'Spawned tasks propagate panics through a JoinHandle or a panic hook; none vanish silently.'
      ],
      crates: ['serde', 'thiserror', 'tracing', 'serde_json'],
      pitfall: 'Reading a required environment variable with unwrap_or_default: the process boots with an empty DSN, every request fails with an unrelated driver error, and the real cause is invisible in logs.',
      questions: [
        {
          q: 'Which failure should panic rather than return Result?',
          options: [
            'A database connection timing out',
            'A validated newtype receiving an impossible value from a bug in your own constructor',
            'A user submitting an empty email',
            'A downstream service returning 503'
          ],
          answer: 1,
          explain: 'Panics are for broken invariants that no caller can fix. Everything a caller can act on - input, timeouts, conflicts - belongs in Result.'
        },
        {
          q: 'Why is a silent default for a required config key worse than a crash at startup?',
          options: [
            'Defaults are slower to parse',
            'The process looks healthy while behaving incorrectly, so the failure surfaces later and elsewhere',
            'serde cannot represent defaults',
            'It breaks the type system'
          ],
          answer: 1,
          explain: 'A crash at boot is one visible event. An empty DSN or zero timeout produces misleading failures much later, often in a different component.'
        },
        {
          q: 'A panic occurs inside a tokio::spawn task. What happens by default?',
          options: [
            'The whole process aborts',
            'The task aborts and the panic surfaces only if the JoinHandle is awaited',
            'The panic is retried automatically',
            'The runtime restarts the task'
          ],
          answer: 1,
          explain: 'Tokio catches the unwind at the task boundary. Without awaiting the JoinHandle, the panic is invisible; a panic hook or an explicit join is required to notice.'
        }
      ],
      quickbytes: [
        'Panic for bugs, Result for conditions; startup is where the first kind should surface.',
        'Reject unknown config keys and required values without defaults, and name the key in the error.',
        'Never unwrap in a handler; a panic there is a reset response with no diagnosis.'
      ],
      github: [
        { name: 'serde-rs/serde - deny_unknown_fields and defaults', url: 'https://github.com/serde-rs/serde' },
        { name: 'rust-lang/api-guidelines - functions validate their arguments', url: 'https://github.com/rust-lang/api-guidelines' }
      ],
      resources: [
        {
          title: 'The Rust Book: to panic! or not to panic!',
          url: 'https://doc.rust-lang.org/book/ch09-03-to-panic-or-not-to-panic.html',
          kind: 'docs'
        },
        {
          title: 'Rust API Guidelines: dependability and argument validation',
          url: 'https://rust-lang.github.io/api-guidelines/dependability.html',
          kind: 'docs'
        },
        {
          title: 'serde attributes: default, deny_unknown_fields',
          url: 'https://docs.rs/serde/latest/serde/',
          kind: 'docs'
        },
        {
          title: 'Simple Testing Can Prevent Most Critical Failures (error paths that were never tested)',
          url: 'https://www.usenix.org/conference/osdi14/technical-sessions/presentation/yuan',
          kind: 'paper'
        }
      ]
    },
    {
      id: 'dp16',
      title: 'Idempotency by design: unique keys and guarded transitions',
      minutes: 90,
      level: 'advanced',
      goal: 'Make duplicate delivery harmless with a claimed key, a stored response, and state transitions that cannot run twice.',
      sections: [
        {
          h: 'The delivery contract decides the design',
          p: [
            'Any system that retries, acknowledges late, or replays a queue delivers duplicates. At-least-once is the default reality; exactly-once exists only inside a single transaction boundary, and every claim otherwise is a boundary someone has not found yet. So the design question is not how to prevent duplicates but what a duplicate does. If the handler is idempotent, a duplicate is a wasted call; if it is not, a duplicate is a double charge.',
            'Idempotence means applying the operation twice has the same effect as applying it once. Some operations are naturally idempotent: set status to paid, write this document, delete this key. Others are not: increment the balance, append the event, send the email. The second category needs either an explicit key that the server remembers, or a formulation that turns the operation into the first category - a guarded transition rather than a blind write.'
          ],
          list: [
            'Natural: PUT a full resource, set a column, delete by id',
            'Not natural: increments, appends, sends, charges',
            'Fix by key: the client supplies an idempotency key, the server stores the outcome',
            'Fix by formulation: UPDATE ... WHERE status = expected, and treat zero rows as already done'
          ],
          tip: 'Ask what happens if this exact request arrives three times in a hundred milliseconds. If the answer is three of anything, the handler is not finished.'
        },
        {
          h: 'Key, claim, store the response',
          p: [
            'An idempotency key is useful only if the server records the decision, not just the row. Claim the key with a unique insert in the same transaction as the effect, perform the effect, then store the response body and status against the key. A replay finds the key already claimed, reads the stored response, and returns it unchanged. The unique index also serialises concurrent duplicates: the second transaction blocks on the index entry until the first commits or aborts, then takes the replay path or proceeds.',
            'Store the request hash with the key. If the same key arrives with a different payload, that is a client bug, and returning the first response silently is worse than a 409: the caller believes a different request succeeded. Also give keys a retention window - long enough to cover the retry horizon, not forever - and delete them on a schedule you can explain.'
          ],
          code: `use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug)]
pub struct StoredResponse {
    pub status: u16,
    pub body: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ChargeError {
    #[error("idempotency key reused with a different payload")]
    KeyReuse,
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

/// Returns the response and whether it was replayed from the key store.
pub async fn charge_idempotent(
    pool: &PgPool,
    key: Uuid,
    request_hash: &str,
    amount_cents: i64,
) -> Result<(StoredResponse, bool), ChargeError> {
    let mut tx = pool.begin().await?;
    let body = String::from("{\\"ok\\":true}");
    // Claim the key and store the ack in one insert. DO NOTHING returns
    // no row when another delivery already claimed the key.
    let claimed: Option<(Uuid,)> = sqlx::query_as(
        "INSERT INTO idempotency_keys (key, request_hash, status, body)
         VALUES ($1, $2, 200, $3)
         ON CONFLICT (key) DO NOTHING
         RETURNING key",
    )
    .bind(key).bind(request_hash).bind(&body)
    .fetch_optional(&mut *tx)
    .await?;

    if claimed.is_none() {
        let (stored_hash, status, stored_body): (String, i32, String) = sqlx::query_as(
            "SELECT request_hash, status, body FROM idempotency_keys WHERE key = $1",
        )
        .bind(key)
        .fetch_one(&mut *tx)
        .await?;
        if stored_hash != request_hash {
            return Err(ChargeError::KeyReuse);
        }
        return Ok((StoredResponse { status: status as u16, body: stored_body }, true));
    }

    // First delivery: the ledger entry commits with the key row. If the
    // response depended on the effect, UPDATE it in this transaction.
    sqlx::query("INSERT INTO ledger (entry_id, amount_cents) VALUES ($1, $2)")
        .bind(Uuid::new_v4()).bind(amount_cents)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((StoredResponse { status: 200, body }, false))
}`,

          tip: 'The key row, the ledger entry, and the stored response must share one transaction. Split them and a crash between steps produces a key with no effect, or an effect with no key.'
        },
        {
          h: 'Guarded transitions beat check-then-write',
          p: [
            'A state machine transition is idempotent if the guard is part of the write. `SELECT status; if pending then UPDATE` has a race between the read and the write: two workers both see pending and both update, and the second overwrites fields the first set. The single-statement form - `UPDATE orders SET status = paid WHERE id = $1 AND status = pending` - lets the database decide: one worker gets rows_affected 1, the other gets 0 and knows the transition already happened.',
            'That zero-rows result is information, not an error. It means already done, or too late, or never existed - distinguish those with a follow-up read only when the caller needs to know which. This is also how you make a consumer restart-safe: replaying the last hundred messages runs each transition, most of them returning zero rows, and the state after the replay equals the state before it.'
          ],
          code: `use sqlx::PgPool;

/// Returns true when this call performed the transition, false when it
/// was already paid (a duplicate) or the order does not exist.
pub async fn mark_paid(pool: &PgPool, order_id: i64) -> Result<bool, sqlx::Error> {
    let updated = sqlx::query(
        "UPDATE orders
            SET status = 'paid', paid_at = now()
          WHERE id = $1 AND status = 'pending'",
    )
    .bind(order_id)
    .execute(pool)
    .await?
    .rows_affected();

    Ok(updated == 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Integration test sketch: call mark_paid twice against the same row
    // and assert (true, false). The second call is the duplicate delivery.
    #[allow(dead_code)]
    fn duplicate_delivery_is_a_noop(pool: &PgPool) -> bool {
        let _ = pool;
        true
    }
}`,
          tip: 'If the guard can be expressed in the WHERE clause, it belongs there. A read followed by a write is two decisions where one would do.'
        }
      ],
      exercise: {
        prompt: 'Implement an in-memory credit ledger where each operation carries a key: the first call credits and records the resulting balance, a replay returns the recorded balance without crediting again, and the same key with a different account is rejected.',
        starter: `use std::collections::HashMap;

#[derive(Debug, PartialEq, Eq)]
pub enum CreditError {
    KeyReuse,
}

#[derive(Default)]
pub struct Ledger {
    balances: HashMap<String, i64>,
    applied: HashMap<String, (String, i64)>,
}

impl Ledger {
    /// Returns (balance_after, replayed).
    pub fn credit(
        &mut self,
        key: &str,
        account: &str,
        cents: i64,
    ) -> Result<(i64, bool), CreditError> {
        todo!()
    }

    pub fn balance(&self, account: &str) -> i64 {
        *self.balances.get(account).unwrap_or(&0)
    }
}`,
        hint: 'Check applied first: if the key exists, compare the stored account and either return (stored_balance, true) or Err(KeyReuse). Otherwise add cents to the balance, record (account, balance_after) under the key, and return (balance_after, false).',
        solution: `use std::collections::HashMap;

#[derive(Debug, PartialEq, Eq)]
pub enum CreditError {
    KeyReuse,
}

#[derive(Default)]
pub struct Ledger {
    balances: HashMap<String, i64>,
    applied: HashMap<String, (String, i64)>,
}

impl Ledger {
    pub fn credit(
        &mut self,
        key: &str,
        account: &str,
        cents: i64,
    ) -> Result<(i64, bool), CreditError> {
        if let Some((stored_account, balance_after)) = self.applied.get(key) {
            if stored_account != account {
                return Err(CreditError::KeyReuse);
            }
            return Ok((*balance_after, true));
        }

        let balance = self.balances.entry(account.to_owned()).or_insert(0);
        *balance += cents;
        let after = *balance;
        self.applied
            .insert(key.to_owned(), (account.to_owned(), after));
        Ok((after, false))
    }

    pub fn balance(&self, account: &str) -> i64 {
        *self.balances.get(account).unwrap_or(&0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_replay_returns_the_original_result_without_crediting() {
        let mut ledger = Ledger::default();

        assert_eq!(ledger.credit("k1", "acct", 500), Ok((500, false)));
        assert_eq!(ledger.credit("k1", "acct", 500), Ok((500, true)));

        assert_eq!(ledger.balance("acct"), 500);
    }

    #[test]
    fn reusing_a_key_for_another_account_is_rejected() {
        let mut ledger = Ledger::default();
        ledger.credit("k1", "acct-a", 500).unwrap();

        assert_eq!(ledger.credit("k1", "acct-b", 500), Err(CreditError::KeyReuse));
        assert_eq!(ledger.balance("acct-b"), 0);
    }
}`
      },
      production: [
        'Every mutating endpoint accepts an idempotency key and stores the response under it in the same transaction as the effect.',
        'Keys are scoped per client and expire on a documented retention window, not kept forever.',
        'A reused key with a different request hash returns 409 rather than the earlier response.',
        'State transitions are single-statement guarded updates; check-then-write is treated as a race.',
        'Consumers are tested by replaying the same batch twice and diffing the resulting state.'
      ],
      crates: ['sqlx', 'uuid', 'thiserror', 'serde'],
      pitfall: 'Writing the idempotency key row in one transaction and the effect in another: a crash between them leaves a key with no effect, so the retry is treated as a replay and the money never moves.',
      questions: [
        {
          q: 'What makes an operation safe to retry after a timeout?',
          options: [
            'A short timeout so the first attempt cannot have completed',
            'An idempotency key enforced by the server, or a formulation that is naturally idempotent',
            'Retrying only once',
            'Logging the request before sending it'
          ],
          answer: 1,
          explain: 'A timeout is not evidence of failure: the first attempt may have committed. Only server-side deduplication or an idempotent formulation makes the retry harmless.'
        },
        {
          q: 'A guarded UPDATE returns rows_affected == 0. What does that mean?',
          options: [
            'The database is unavailable',
            'The transition was already applied, the row is missing, or the guard did not match',
            'The transaction must be rolled back',
            'The query needs a retry'
          ],
          answer: 1,
          explain: 'Zero rows is a valid, informative outcome. Follow up with a read only if the caller must distinguish already-done from never-existed.'
        },
        {
          q: 'Why store the request hash alongside the idempotency key?',
          options: [
            'To speed up the lookup',
            'To detect a key reused with a different payload instead of silently replaying',
            'To encrypt the response',
            'To expire the key automatically'
          ],
          answer: 1,
          explain: 'Same key plus different request is a client bug. Replaying the old response would tell the caller a different operation succeeded.'
        }
      ],
      quickbytes: [
        'Claim the key, perform the effect, and store the response in one transaction.',
        'Prefer UPDATE ... WHERE status = expected over read-then-write; zero rows is an answer.',
        'A key reused with a different payload is a 409, not a replay.'
      ],
      github: [
        { name: 'launchbadge/sqlx - transactions, ON CONFLICT, rows_affected', url: 'https://github.com/launchbadge/sqlx' },
        { name: 'postgres/postgres - unique indexes as the deduplication primitive', url: 'https://github.com/postgres/postgres' }
      ],
      resources: [
        {
          title: 'PostgreSQL: INSERT ... ON CONFLICT and RETURNING',
          url: 'https://www.postgresql.org/docs/current/sql-insert.html',
          kind: 'docs'
        },
        {
          title: 'sqlx: transactions, query_as, and rows_affected',
          url: 'https://docs.rs/sqlx/latest/sqlx/',
          kind: 'docs'
        },
        {
          title: 'PostgreSQL: transaction isolation and unique index behaviour',
          url: 'https://www.postgresql.org/docs/current/transaction-iso.html',
          kind: 'docs'
        },
        {
          title: 'sqlx repository',
          url: 'https://github.com/launchbadge/sqlx',
          kind: 'repo'
        }
      ]
    },
    {
      id: 'dp17',
      title: 'Backpressure: bounded queues, permits, and load shedding',
      minutes: 85,
      level: 'advanced',
      goal: 'Convert overload into an explicit, cheap rejection by bounding concurrency and queue depth, and signal the rejection to the caller.',
      sections: [
        {
          h: 'An unbounded queue moves the failure, it does not remove it',
          p: [
            'When arrivals exceed capacity, something must give: latency, memory, or acceptance. An unbounded queue chooses latency and memory, and it chooses them silently. Requests wait longer and longer while the process consumes more memory per queued item, until the allocator or the OOM killer ends the discussion. The queue made the system look healthy at the moment it became unrecoverable, which is the worst possible time to lie.',
            'Little law makes the trap precise: the number of items in the system equals arrival rate times time in system. If capacity is 200 requests per second and arrivals are 400, the queue grows by 200 every second no matter how fast the code is. The only three options are to increase capacity, reduce arrivals, or reject some. Backpressure is the third option made explicit: a bound, a rejection, and a signal the caller can act on.'
          ],
          list: [
            'Bound the queue; the length is a design parameter, not a default',
            'Bound concurrency separately: queue depth is not worker count',
            'Bound the wait: a permit acquired after the deadline is useless work',
            'Bound the rejection: return 429 with Retry-After, not a hang'
          ],
          tip: 'A queue length alert that never fires is not a sign of health; it is a sign the queue is unbounded.'
        },
        {
          h: 'Semaphores, channels, and permit timeouts',
          p: [
            'A `Semaphore` limits concurrent work: acquire a permit before starting, hold it for the duration, and the permit returns when the guard drops. Acquiring with a timeout is the important detail - a caller that waits two seconds for a permit inside a one-second request has already failed, it just has not noticed. `try_acquire` is the strictest form: if no permit is free right now, reject immediately and let the caller decide whether to queue.',
            'A bounded `mpsc` channel bounds the queue itself. `send().await` applies backpressure to the producer; `try_send` rejects when full. Which one you want depends on who is upstream: a network producer should see the rejection and return 429, while an internal batch producer might legitimately await. Mixing them up is how a slow consumer turns into a memory graph that looks like a ramp.'
          ],
          code: `use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;

#[derive(Debug, PartialEq, Eq)]
pub enum Rejected {
    Timeout,
    Closed,
}

pub struct Worker {
    permits: Arc<Semaphore>,
    budget: Duration,
}

impl Worker {
    pub fn new(max_in_flight: usize, budget: Duration) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(max_in_flight)),
            budget,
        }
    }

    pub async fn submit(&self, job: Job) -> Result<(), Rejected> {
        // Bounded wait: if a permit takes longer than the request budget,
        // the caller is better served by a fast rejection.
        let permit = tokio::time::timeout(
            self.budget,
            self.permits.clone().acquire_owned(),
        )
        .await
        .map_err(|_| Rejected::Timeout)?
        .map_err(|_| Rejected::Closed)?;

        tokio::spawn(async move {
            let _permit = permit; // released when the job completes
            run(job).await;
        });

        Ok(())
    }
}

pub struct Job;
pub async fn run(_job: Job) {}`,
          tip: 'Timeout the permit acquisition, not just the job. Waiting for a slot is part of the request budget.'
        },
        {
          h: 'Shed at the edge and say so',
          p: [
            'Rejection is a product decision, so make it legible. A 429 with `Retry-After` tells the client to back off; a 503 says the whole dependency is down; a queue that silently drops the oldest item tells the client nothing and loses data. Shedding by priority - keep checkout, shed recommendations - is better than shedding randomly, and it requires knowing which traffic is on the critical path.',
            'Autoscaling is not backpressure. Scaling reacts in tens of seconds and can be capped by quota, while overload happens in hundreds of milliseconds. A system that relies on autoscaling alone has an unbounded queue for the gap, and the gap is where the outage lives. Bound first, scale second, and alarm on the rejection rate: a steady 1 percent of 429s under peak is a healthy signal, a sudden 40 percent is an incident.'
          ],
          code: `use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;

pub enum EnqueueError {
    Overloaded,
    Closed,
}

/// Bounded ingress: the capacity is the maximum acceptable backlog.
pub fn enqueue(
    tx: &mpsc::Sender<Job>,
    job: Job,
) -> Result<(), EnqueueError> {
    match tx.try_send(job) {
        Ok(()) => Ok(()),
        Err(TrySendError::Full(_)) => Err(EnqueueError::Overloaded),
        Err(TrySendError::Closed(_)) => Err(EnqueueError::Closed),
    }
}

// At the HTTP edge:
// EnqueueError::Overloaded -> 429 with Retry-After: 1
// EnqueueError::Closed     -> 503, the worker is not running
pub struct Job;`,
          tip: 'Log and meter every rejection with a reason. A rejection you cannot count is a rejection you cannot tune.'
        }
      ],
      exercise: {
        prompt: 'Implement a bounded job queue with a capacity and a permit counter: enqueue rejects when the backlog is full, acquire rejects when no worker slot is free, and releasing a slot lets the next job through. Prove that nothing is silently dropped.',
        starter: `#[derive(Debug, PartialEq, Eq)]
pub enum PushError {
    Full,
    NoCapacity,
}

pub struct Queue {
    capacity: usize,
    backlog: Vec<u32>,
    idle_workers: usize,
}

impl Queue {
    pub fn new(capacity: usize, workers: usize) -> Self {
        todo!()
    }

    /// Accepts a job only if there is backlog room and a worker slot.
    pub fn push(&mut self, job: u32) -> Result<(), PushError> {
        todo!()
    }

    /// A worker finishes one job and becomes idle again.
    pub fn complete(&mut self) -> Option<u32> {
        todo!()
    }

    pub fn backlog(&self) -> usize {
        self.backlog.len()
    }
}`,
        hint: 'push checks backlog.len() < capacity first (Full), then idle_workers > 0 (NoCapacity); on success push the job and decrement idle_workers. complete pops a job and increments idle_workers. Keep the order of checks consistent so the error names the real constraint.',
        solution: `#[derive(Debug, PartialEq, Eq)]
pub enum PushError {
    Full,
    NoCapacity,
}

pub struct Queue {
    capacity: usize,
    backlog: Vec<u32>,
    idle_workers: usize,
}

impl Queue {
    pub fn new(capacity: usize, workers: usize) -> Self {
        Self {
            capacity,
            backlog: Vec::with_capacity(capacity),
            idle_workers: workers,
        }
    }

    pub fn push(&mut self, job: u32) -> Result<(), PushError> {
        if self.backlog.len() >= self.capacity {
            return Err(PushError::Full);
        }
        if self.idle_workers == 0 {
            return Err(PushError::NoCapacity);
        }

        self.backlog.push(job);
        self.idle_workers -= 1;
        Ok(())
    }

    pub fn complete(&mut self) -> Option<u32> {
        let job = self.backlog.pop()?;
        self.idle_workers += 1;
        Some(job)
    }

    pub fn backlog(&self) -> usize {
        self.backlog.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_backlog_is_rejected_not_grown() {
        let mut queue = Queue::new(2, 2);
        assert_eq!(queue.push(1), Ok(()));
        assert_eq!(queue.push(2), Ok(()));
        assert_eq!(queue.push(3), Err(PushError::Full));
        assert_eq!(queue.backlog(), 2);
    }

    #[test]
    fn no_idle_worker_is_a_different_rejection() {
        let mut queue = Queue::new(4, 1);
        assert_eq!(queue.push(1), Ok(()));
        assert_eq!(queue.push(2), Err(PushError::NoCapacity));

        assert_eq!(queue.complete(), Some(1));
        assert_eq!(queue.push(2), Ok(()));
    }

    #[test]
    fn nothing_is_dropped_silently() {
        let mut queue = Queue::new(1, 1);
        queue.push(7).unwrap();
        assert_eq!(queue.push(8), Err(PushError::Full));
        assert_eq!(queue.complete(), Some(7));
    }
}`
      },
      production: [
        'Every queue, channel, and semaphore has an explicit bound with a recorded reason for the number.',
        'Permit acquisition is wrapped in a timeout shorter than the caller remaining budget.',
        'Rejections map to 429 or 503 with Retry-After, and are counted with a reason label.',
        'Backlog depth, permit wait time, and rejection rate are on the same dashboard as latency.',
        'Autoscaling is treated as a capacity response, never as the backpressure mechanism.'
      ],
      crates: ['tokio', 'tower', 'axum', 'tracing'],
      pitfall: 'An unbounded mpsc channel as the ingress queue: memory grows with the backlog, latency grows without bound, and the first observable symptom is an OOM kill that looks unrelated to traffic.',
      questions: [
        {
          q: 'What does an unbounded queue actually change about an overload?',
          options: [
            'It absorbs the overload without cost',
            'It converts a fast rejection into growing latency and memory use until something fails hard',
            'It increases throughput by batching',
            'It moves the load to the database'
          ],
          answer: 1,
          explain: 'The work still exceeds capacity. The queue delays the failure and hides it while latency and memory grow, which makes recovery harder.'
        },
        {
          q: 'Why timeout the permit acquisition and not only the job?',
          options: [
            'Because permits can be lost',
            'Because time spent waiting for a slot is part of the caller budget and may already exceed it',
            'Because the semaphore has no queue',
            'Because acquire_owned is not cancel safe'
          ],
          answer: 1,
          explain: 'A permit granted after the deadline produces work nobody is waiting for. The wait is part of the request, so it is part of the budget.'
        },
        {
          q: 'Which is the correct client signal for shed load?',
          options: [
            '200 with an empty body',
            '429 with Retry-After',
            'A dropped connection',
            '503 for every rejection'
          ],
          answer: 1,
          explain: '429 says the request was rejected for capacity and tells the client when to try again. Dropping connections and 200s both hide the condition and make retry behaviour unpredictable.'
        }
      ],
      quickbytes: [
        'Bound the queue, the concurrency, and the wait; all three are separate design parameters.',
        'Try-send and try-acquire for edge traffic; await only where the producer can genuinely wait.',
        'Meter rejections by reason and alarm on the rate, not only on latency.'
      ],
      github: [
        { name: 'tokio-rs/tokio - Semaphore, bounded mpsc, timeouts', url: 'https://github.com/tokio-rs/tokio' },
        { name: 'tower-rs/tower - ConcurrencyLimit and LoadShed layers', url: 'https://github.com/tower-rs/tower' }
      ],
      resources: [
        {
          title: 'tokio::sync::mpsc: bounded channels and try_send',
          url: 'https://docs.rs/tokio/latest/tokio/sync/mpsc/index.html',
          kind: 'docs'
        },
        {
          title: 'tokio::sync::Semaphore: permits and timeouts',
          url: 'https://docs.rs/tokio/latest/tokio/sync/struct.Semaphore.html',
          kind: 'docs'
        },
        {
          title: 'tower::limit: concurrency and rate limiting middleware',
          url: 'https://docs.rs/tower/latest/tower/limit/index.html',
          kind: 'docs'
        },
        {
          title: 'The Tail at Scale: how fan-out and queueing amplify latency tails',
          url: 'https://research.google/pubs/the-tail-at-scale/',
          kind: 'paper'
        }
      ]
    },
    {
      id: 'dp18',
      title: 'Graceful degradation: degrade features, never correctness',
      minutes: 85,
      level: 'industry',
      goal: 'Define the critical path, put a breaker in front of optional dependencies, and return a degraded result that is explicit and safe.',
      sections: [
        {
          h: 'Decide what must not degrade',
          p: [
            'Degradation is a hierarchy, not a switch. Payment authorisation, balance checks, and access control must be correct or unavailable; there is no acceptable stale answer. Recommendations, avatars, view counts, and search suggestions can be stale, missing, or approximate. Between them sit features like delivery estimates and fraud scores, where a conservative fallback exists but must be labelled. Write this hierarchy down before the incident, because during the incident nobody has time to debate it.',
            'The failure mode to design against is degrading the wrong layer. Serving a cached price during a pricing outage charges the wrong amount; serving a cached balance lets a customer overspend. A safe fallback is conservative by construction: reject the transaction, hide the section, show the last known value with its timestamp, or queue the write for later - each with an explicit signal to the caller and to the dashboard.'
          ],
          list: [
            'Correct or unavailable: money, auth, inventory decrement',
            'Stale with a timestamp: prices shown as estimates, delivery dates, view counts',
            'Optional or absent: recommendations, avatars, related items',
            'Deferred: non-critical writes queued and replayed after recovery'
          ],
          tip: 'If you cannot say which fields are allowed to be stale, you are not ready to degrade; you are ready to guess.'
        },
        {
          h: 'A breaker with explicit states and a probe',
          p: [
            'A circuit breaker stops calling a dependency that is failing, so the failure is fast and the dependency gets room to recover. Model it as three states: closed (calls pass), open (calls fail immediately), half-open (one probe is allowed to test recovery). The transition rules are small - N consecutive failures open it, a cooldown allows a half-open probe, a successful probe closes it, a failed probe reopens it - and they belong in a type with tests, not in a helper function scattered across call sites.',
            'Put the breaker in front of each optional dependency, not around the whole handler. A single global breaker means a slow recommendation service rejects payments. And record the outcome as a type: `Fresh(T)`, `Stale(T)`, `Unavailable` forces the caller to decide what to render, instead of returning `Option<T>` and letting the default be silently wrong.'
          ],
          code: `use std::time::{Duration, Instant};

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome<T> {
    Fresh(T),
    Stale(T),
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Closed,
    Open,
    HalfOpen,
}

pub struct Breaker {
    state: State,
    failures: u32,
    opened_at: Option<Instant>,
    threshold: u32,
    cooldown: Duration,
}

impl Breaker {
    pub fn new(threshold: u32, cooldown: Duration) -> Self {
        let state = State::Closed;
        Self { state, failures: 0, opened_at: None, threshold, cooldown }
    }

    /// Closed passes; open rejects until the cooldown; then one probe.
    pub fn allow(&mut self, now: Instant) -> bool {
        match self.state {
            State::Closed => true,
            State::HalfOpen => false,
            State::Open => {
                let waited = now.saturating_duration_since(self.opened_at.unwrap_or(now));
                if waited < self.cooldown {
                    return false;
                }
                self.state = State::HalfOpen;
                true
            }
        }
    }

    pub fn record(&mut self, ok: bool, now: Instant) {
        if ok {
            self.state = State::Closed;
            self.failures = 0;
            return;
        }
        self.failures += 1;
        if self.state == State::HalfOpen || self.failures >= self.threshold {
            self.state = State::Open;
            self.opened_at = Some(now);
        }
    }
}`,

          tip: 'One breaker per dependency. A breaker around a whole request turns one slow optional call into a total outage.'
        },
        {
          h: 'Fallbacks that stay honest',
          p: [
            'A fallback is only safe when the caller can tell. Return the staleness in the value: an `Outcome::Stale` variant, an `age_ms` field, or a response header. Then the UI can label the estimate, the API can document it, and the metric can count it. Silent fallbacks are how systems end up serving last week prices with full confidence, and the incident review discovers that nobody knows when the cache was last refreshed.',
            'Test the degraded path as a first-class case. Inject a dependency failure in a test, assert the fallback value and its marker, assert the breaker opens after the threshold, and assert that the critical path still rejects rather than returning a fallback. If the only tests exercise the happy path, the fallback code is the least-reviewed code in the system, and it will run for the first time during an outage.'
          ],
          code: `use std::time::Instant;

// Breaker and Outcome are the types built in the previous section.
/// Price lookup with an explicit staleness contract.
pub struct PriceView {
    pub cents: u64,
    pub stale: bool,
}

pub async fn price_or_cached<S: PriceSource>(
    breaker: &mut Breaker,
    source: &S,
    cache: &Cache,
    sku: &str,
) -> Outcome<PriceView> {
    let now = Instant::now();

    if breaker.allow(now) {
        match source.price(sku).await {
            Ok(cents) => {
                breaker.record(true, now);
                cache.put(sku, cents);
                return Outcome::Fresh(PriceView { cents, stale: false });
            }
            Err(_) => breaker.record(false, now),
        }
    }

    match cache.get(sku) {
        Some(cents) => Outcome::Stale(PriceView { cents, stale: true }),
        None => Outcome::Unavailable,
    }
}

pub trait PriceSource {
    async fn price(&self, sku: &str) -> Result<u64, PriceError>;
}

pub struct Cache;
impl Cache {
    pub fn get(&self, _sku: &str) -> Option<u64> { None }
    pub fn put(&self, _sku: &str, _cents: u64) {}
}

#[derive(Debug)]
pub struct PriceError;`,
          tip: 'A fallback that does not tell the caller it is a fallback is indistinguishable from a wrong answer.'
        }
      ],
      exercise: {
        prompt: 'Implement a Breaker that opens after three consecutive failures, allows one probe after a cooldown, closes on a successful probe, and reopens on a failed one. Use a monotonic clock passed in, and test every transition.',
        starter: `use std::time::{Duration, Instant};

#[derive(Debug, PartialEq, Eq)]
pub enum Call {
    Allowed,
    Rejected,
}

pub struct Breaker {
    failures: u32,
    open_until: Option<Instant>,
    probing: bool,
}

impl Breaker {
    pub fn new() -> Self {
        todo!()
    }

    /// Should this call be attempted?
    pub fn check(&mut self, now: Instant) -> Call {
        todo!()
    }

    /// Record the result of an attempted call.
    pub fn record(&mut self, ok: bool, now: Instant) {
        todo!()
    }

    pub fn is_open(&self) -> bool {
        self.open_until.is_some()
    }
}

pub const THRESHOLD: u32 = 3;
pub const COOLDOWN: Duration = Duration::from_secs(5);`,
        hint: 'check: if open_until is Some and now < open_until, Rejected; if elapsed >= COOLDOWN, set probing and Allowed. record: on failure increment failures and, at THRESHOLD or after a failed probe, set open_until = now + COOLDOWN; on success reset failures and clear the open state.',
        solution: `use std::time::{Duration, Instant};

#[derive(Debug, PartialEq, Eq)]
pub enum Call {
    Allowed,
    Rejected,
}

pub const THRESHOLD: u32 = 3;
pub const COOLDOWN: Duration = Duration::from_secs(5);

pub struct Breaker {
    failures: u32,
    open_until: Option<Instant>,
    probing: bool,
}

impl Breaker {
    pub fn new() -> Self {
        Self { failures: 0, open_until: None, probing: false }
    }

    pub fn check(&mut self, now: Instant) -> Call {
        match self.open_until {
            None => Call::Allowed,
            Some(until) if now >= until => {
                self.probing = true;
                Call::Allowed
            }
            Some(_) => Call::Rejected,
        }
    }

    pub fn record(&mut self, ok: bool, now: Instant) {
        if ok {
            self.failures = 0;
            self.probing = false;
            self.open_until = None;
            return;
        }

        // A failed probe reopens immediately; ordinary failures count up.
        if self.probing {
            self.probing = false;
            self.failures = THRESHOLD;
            self.open_until = Some(now + COOLDOWN);
            return;
        }

        self.failures += 1;
        if self.failures >= THRESHOLD {
            self.open_until = Some(now + COOLDOWN);
        }
    }

    pub fn is_open(&self) -> bool {
        self.open_until.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_after_three_failures_and_rejects_until_the_probe() {
        let mut breaker = Breaker::new();
        let start = Instant::now();

        for _ in 0..3 {
            assert_eq!(breaker.check(start), Call::Allowed);
            breaker.record(false, start);
        }

        assert!(breaker.is_open());
        assert_eq!(breaker.check(start + Duration::from_secs(1)), Call::Rejected);

        // Cooldown elapsed: one probe is allowed.
        let probe_at = start + COOLDOWN;
        assert_eq!(breaker.check(probe_at), Call::Allowed);
    }

    #[test]
    fn successful_probe_closes_and_failed_probe_reopens() {
        let mut breaker = Breaker::new();
        let start = Instant::now();
        for _ in 0..3 {
            breaker.check(start);
            breaker.record(false, start);
        }

        let probe_at = start + COOLDOWN;
        assert_eq!(breaker.check(probe_at), Call::Allowed);
        breaker.record(true, probe_at);
        assert!(!breaker.is_open());
        assert_eq!(breaker.check(probe_at), Call::Allowed);

        // Fail again: one failure does not reopen, three do.
        breaker.record(false, probe_at);
        breaker.record(false, probe_at);
        assert!(!breaker.is_open());
        breaker.record(false, probe_at);
        assert!(breaker.is_open());
    }
}`
      },
      production: [
        'A written degradation policy names which fields may be stale and which must fail closed.',
        'Every optional dependency has its own breaker with a tuned threshold and cooldown.',
        'Degraded responses carry an explicit marker (variant, field, or header) and increment a metric.',
        'Failure injection tests exercise the degraded path and the breaker transitions in CI.',
        'Critical-path code has no fallback that could return a plausible but wrong value.'
      ],
      crates: ['tokio', 'axum', 'tracing', 'thiserror'],
      pitfall: 'Caching the last successful price and serving it as current during an outage: the site stays up, the prices are wrong, and nothing in the response tells the buyer or the on-call engineer.',
      questions: [
        {
          q: 'Which feature may safely serve stale data?',
          options: [
            'Account balance before a withdrawal',
            'Recommended products on a product page',
            'Payment authorisation result',
            'Inventory decrement count'
          ],
          answer: 1,
          explain: 'Recommendations are advisory. Balance, payment authorisation, and inventory decrement affect money and correctness, so they must be fresh or unavailable.'
        },
        {
          q: 'Why should the breaker wrap one dependency rather than the whole handler?',
          options: [
            'Because breakers are expensive',
            'Because one failing optional dependency would otherwise reject requests that do not need it',
            'Because the handler has no state',
            'Because only async calls can be broken'
          ],
          answer: 1,
          explain: 'A global breaker couples unrelated capabilities. Per-dependency breakers let recommendations fail while checkout continues.'
        },
        {
          q: 'What must a fallback response include to be safe?',
          options: [
            'A 200 status so clients keep working',
            'An explicit marker that the value is degraded, and its age where relevant',
            'The original error text',
            'A retry loop'
          ],
          answer: 1,
          explain: 'The caller must be able to distinguish fresh from stale. Without the marker the fallback is indistinguishable from a wrong answer and cannot be tested or monitored.'
        }
      ],
      quickbytes: [
        'Write the degradation policy before the incident: correct-or-unavailable versus stale-allowed.',
        'One breaker per dependency; closed, open, half-open with a single probe.',
        'Return Fresh, Stale, or Unavailable; never a bare Option that hides which one it is.'
      ],
      github: [
        { name: 'Netflix/Hystrix - the original circuit breaker and fallback patterns', url: 'https://github.com/Netflix/Hystrix' },
        { name: 'tokio-rs/tokio - timers and timeouts used by breakers', url: 'https://github.com/tokio-rs/tokio' }
      ],
      resources: [
        {
          title: 'AWS Well-Architected: reliability pillar and failure isolation',
          url: 'https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html',
          kind: 'docs'
        },
        {
          title: 'tokio::time: timeouts, intervals, and Instant',
          url: 'https://docs.rs/tokio/latest/tokio/time/index.html',
          kind: 'docs'
        },
        {
          title: 'axum: responses and IntoResponse for degraded results',
          url: 'https://docs.rs/axum/latest/axum/response/index.html',
          kind: 'docs'
        },
        {
          title: 'Hystrix wiki: circuit breaker, fallback, and bulkhead',
          url: 'https://github.com/Netflix/Hystrix/wiki',
          kind: 'repo'
        }
      ]
    },
    {
      id: 'dp19',
      title: 'API ergonomics: make the right call the easy call',
      minutes: 75,
      level: 'advanced',
      goal: 'Design signatures that accept what callers have, return what they need, and explain themselves when a bound is missing.',
      sections: [
        {
          h: 'Accept the general thing, return the specific thing',
          p: [
            'Parameters should be as permissive as the implementation allows, and return types as precise as the caller needs. A function that reads a file should take `impl AsRef<Path>`, so `&str`, `String`, `PathBuf`, and `&Path` all work without a conversion at the call site. A function that stores a string should take `impl Into<String>` if it needs ownership, or `&str` if it does not - and never `&String`, which forces callers to have exactly one type.',
            'The return side is the same principle inverted. Returning `impl Iterator<Item = &T>` lets the caller chain without naming a type and lets you change the concrete iterator later. Returning a `Vec<T>` when a slice would do forces an allocation the caller may not need. The API guidelines call this caller control: the caller decides where to copy and where to place data.'
          ],
          list: [
            'impl AsRef<Path> for paths; &str or impl Into<String> for text',
            '&[T] instead of &Vec<T>; impl Iterator instead of a concrete iterator',
            '&T for read-only parameters, T when ownership is genuinely taken',
            'Option<&T> at boundaries, T inside the domain'
          ],
          tip: 'Every &String, &Vec<T>, or &PathBuf in a public signature is a conversion the caller has to perform for no reason.'
        },
        {
          h: 'Builders when the parameter list stops fitting',
          p: [
            'A function with six parameters is a function whose call sites are unreadable, and a bool or two makes it worse. A builder fixes the call site and gives optional fields somewhere to live. For structs with required fields, `typed-builder` makes the requirement a compile-time property: the builder will not produce the struct until every required field is set, so the `build()` method returns the value directly instead of a Result.',
            'Keep the builder honest with the rest of the design: validate in `build()`, not in each setter, so the error type is one and the checks run once. Use `#[non_exhaustive]` on a config struct that crosses a crate boundary, then adding a field does not break construction. And if the builder has exactly one setter, delete it and take the parameter - builders pay when there are four or more optional knobs, not before.'
          ],
          code: `use std::path::Path;
use std::time::Duration;

#[derive(Debug)]
pub struct Client {
    base_url: String,
    timeout: Duration,
    retries: u32,
}

#[derive(Debug)]
pub struct BuildError;

pub struct ClientBuilder {
    base_url: String,
    timeout: Duration,
    retries: u32,
}

impl Client {
    pub fn builder(base_url: impl Into<String>) -> ClientBuilder {
        ClientBuilder {
            base_url: base_url.into(),
            timeout: Duration::from_secs(2),
            retries: 2,
        }
    }

    /// Accepts anything path-like: no caller-side conversion needed.
    pub async fn upload(&self, path: impl AsRef<Path>) -> Result<(), UploadError> {
        let _path = path.as_ref();
        Ok(())
    }
}

impl ClientBuilder {
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn retries(mut self, retries: u32) -> Self {
        self.retries = retries;
        self
    }

    pub fn build(self) -> Result<Client, BuildError> {
        if self.base_url.is_empty() || !self.base_url.starts_with("https://") {
            return Err(BuildError);
        }
        Ok(Client {
            base_url: self.base_url,
            timeout: self.timeout,
            retries: self.retries,
        })
    }
}

#[derive(Debug)]
pub struct UploadError;`,
          tip: 'Validate in build, once. A builder whose setters each return Result is a builder nobody wants to chain.'
        },
        {
          h: 'Diagnostics are part of the ergonomics',
          p: [
            'The error a user sees when a bound is missing is part of the API. By default the compiler prints the trait and the type, which for a composed generic type can be a paragraph of noise. `#[diagnostic::on_unimplemented]` lets you replace that with a message that names the missing capability and suggests the fix. It is a stable attribute, it costs nothing at runtime, and it turns a support ticket into a self-service answer.',
            'Two smaller tools complete the set. `#[must_use]` on a function or type makes ignoring the result a warning, which is exactly right for builders and guards. Doc examples are compiled and run by `cargo test`, so a doctest is an ergonomics test that cannot rot silently: if the example no longer compiles, the API broke.'
          ],
          code: `#[diagnostic::on_unimplemented(
    message = "{Self} cannot be used as a price source",
    label = "missing implementation of PriceSource",
    note = "implement PriceSource for your type, or wrap it in FixedPrice"
)]
pub trait PriceSource {
    fn price_cents(&self, sku: &str) -> u64;
}

#[must_use = "the builder does nothing until build is called"]
pub struct QueryBuilder {
    limit: usize,
}

impl QueryBuilder {
    pub fn limit(mut self, limit: usize) -> Self {
        self.limit = limit;
        self
    }

    pub fn build(self) -> Query {
        Query { limit: self.limit }
    }
}

pub struct Query {
    pub limit: usize,
}

/// # Examples
///
///     use mycrate::default_query;
///     let query = default_query();
///     assert_eq!(query.limit, 50);
///
pub fn default_query() -> Query {
    Query { limit: 50 }
}`,
          tip: 'Run cargo doc with the lint table from the API guidelines open; every missing item is an ergonomics bug a user will hit.'
        }
      ],
      exercise: {
        prompt: 'Design a Search builder: term is required, limit defaults to 20, sort defaults to Relevance. Accept both &str and String for the term, provide chainable setters, and validate in build so an empty term is rejected once.',
        starter: `#[derive(Debug, PartialEq, Eq)]
pub enum Sort {
    Relevance,
    Newest,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Search {
    term: String,
    limit: usize,
    sort: Sort,
}

#[derive(Debug, PartialEq, Eq)]
pub struct BuildError;

pub struct SearchBuilder {
    term: String,
    limit: usize,
    sort: Sort,
}

impl Search {
    pub fn builder(term: impl Into<String>) -> SearchBuilder {
        todo!()
    }
}

impl SearchBuilder {
    pub fn limit(mut self, limit: usize) -> Self {
        todo!()
    }

    pub fn sort(mut self, sort: Sort) -> Self {
        todo!()
    }

    pub fn build(self) -> Result<Search, BuildError> {
        todo!()
    }
}`,
        hint: 'builder sets term: term.into(), limit: 20, sort: Relevance. limit and sort mutate self and return self. build trims the term and rejects empty or limit == 0, otherwise returns Search.',
        solution: `#[derive(Debug, PartialEq, Eq)]
pub enum Sort {
    Relevance,
    Newest,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Search {
    term: String,
    limit: usize,
    sort: Sort,
}

#[derive(Debug, PartialEq, Eq)]
pub struct BuildError;

pub struct SearchBuilder {
    term: String,
    limit: usize,
    sort: Sort,
}

impl Search {
    pub fn builder(term: impl Into<String>) -> SearchBuilder {
        SearchBuilder {
            term: term.into(),
            limit: 20,
            sort: Sort::Relevance,
        }
    }
}

impl SearchBuilder {
    pub fn limit(mut self, limit: usize) -> Self {
        self.limit = limit;
        self
    }

    pub fn sort(mut self, sort: Sort) -> Self {
        self.sort = sort;
        self
    }

    pub fn build(self) -> Result<Search, BuildError> {
        let term = self.term.trim().to_owned();
        if term.is_empty() || self.limit == 0 {
            return Err(BuildError);
        }
        Ok(Search { term, limit: self.limit, sort: self.sort })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_applied_and_overridable() {
        let defaulted = Search::builder("rust").build().unwrap();
        assert_eq!(defaulted.limit, 20);
        assert_eq!(defaulted.sort, Sort::Relevance);

        let custom = Search::builder(String::from("rust"))
            .limit(5)
            .sort(Sort::Newest)
            .build()
            .unwrap();
        assert_eq!(custom, Search { term: "rust".into(), limit: 5, sort: Sort::Newest });
    }

    #[test]
    fn validation_happens_in_build_once() {
        assert_eq!(Search::builder("   ").build(), Err(BuildError));
        assert_eq!(Search::builder("rust").limit(0).build(), Err(BuildError));
    }
}`
      },
      production: [
        'No public signature takes &String, &Vec<T>, or &PathBuf; generalise to &str, &[T], impl AsRef<Path>.',
        'Functions with more than four parameters use a builder, and validation happens in build once.',
        'Public traits used as bounds carry #[diagnostic::on_unimplemented] messages naming the fix.',
        'Builders and guards are #[must_use]; ignoring them is a warning, not a silent no-op.',
        'Every public item has a doctest that compiles and runs in CI.'
      ],
      crates: ['typed-builder', 'axum', 'serde', 'thiserror'],
      pitfall: 'A builder whose required fields are Options and whose build returns Result: the requirement is discovered at runtime, every call site handles an impossible error, and typed-builder would have made it a compile error.',
      questions: [
        {
          q: 'Which parameter type is the most ergonomic for a path argument?',
          options: [
            '&PathBuf',
            '&Path',
            'impl AsRef<Path>',
            '&String'
          ],
          answer: 2,
          explain: 'AsRef<Path> accepts &str, String, PathBuf, and &Path with no caller conversion. &Path is a close second but still forces a conversion from &str.'
        },
        {
          q: 'When does a builder earn its keep?',
          options: [
            'Whenever a struct has more than one field',
            'When there are several optional knobs and the call site would otherwise be positional and unreadable',
            'Only for public crates',
            'When the type is generic'
          ],
          answer: 1,
          explain: 'A builder pays for its extra type when optional fields and readability justify it. For two required parameters it is indirection without benefit.'
        },
        {
          q: 'What does #[diagnostic::on_unimplemented] change?',
          options: [
            'The trait becomes object-safe',
            'The compiler error shown when a type does not implement the trait',
            'The runtime error when a method panics',
            'The trait is hidden from docs'
          ],
          answer: 1,
          explain: 'It customises the unsatisfied-bound diagnostic with a message, label, and note. It has no effect on runtime or object safety.'
        }
      ],
      quickbytes: [
        'Take impl AsRef/Into at the edge, return impl Iterator or the concrete type the caller needs.',
        'Builders validate once in build; typed-builder turns required fields into compile errors.',
        'Doctests are ergonomics tests: if the example stops compiling, users are already broken.'
      ],
      github: [
        { name: 'idanarye/rust-typed-builder - compile-time checked builders', url: 'https://github.com/idanarye/rust-typed-builder' },
        { name: 'rust-lang/api-guidelines - flexibility and type safety checklist', url: 'https://github.com/rust-lang/api-guidelines' }
      ],
      resources: [
        {
          title: 'Rust API Guidelines: the full checklist',
          url: 'https://rust-lang.github.io/api-guidelines/checklist.html',
          kind: 'docs'
        },
        {
          title: 'Rust API Guidelines: flexibility and caller control',
          url: 'https://rust-lang.github.io/api-guidelines/flexibility.html',
          kind: 'docs'
        },
        {
          title: 'typed-builder crate documentation',
          url: 'https://docs.rs/typed-builder/latest/typed_builder/',
          kind: 'docs'
        },
        {
          title: 'typed-builder repository',
          url: 'https://github.com/idanarye/rust-typed-builder',
          kind: 'repo'
        },
        {
          title: 'Jon Gjengset: API design, builders, and trait bounds in practice',
          url: 'https://www.youtube.com/@jonhoo',
          kind: 'video'
        }
      ]
    },
    {
      id: 'dp20',
      title: 'Design review: a checklist ordered by blast radius',
      minutes: 95,
      level: 'industry',
      goal: 'Run a review that starts at invariants and ends at style, demand evidence for each claim, and encode the checkable rules as compiler lints.',
      sections: [
        {
          h: 'Order the questions by what breaks first',
          p: [
            'A design review that starts with naming and formatting spends its attention on the cheapest problems. Order the questions by blast radius: what invariant does this protect, who can construct the type, what happens when the dependency is down, what does the caller do with the error, can the API be misused without a compile error. Style is real but it is cheap to fix later, and reviewing it first exhausts the reviewers before the expensive questions are asked.',
            'Keep the protocol short enough to run in forty-five minutes: the author presents the change and the invariant in five, reviewers ask the ordered questions for twenty-five, and the remaining fifteen produce decisions. Each answer needs evidence, not assertion: a test that fails when the guard is removed, a compile-fail test for the forbidden call, a diff of the public API, a chart of the failure injection result.'
          ],
          list: [
            'What invariant does this type or module protect, in one sentence?',
            'Can an invalid value exist, and what is the only way to construct one?',
            'What happens when each dependency is slow, down, or lying?',
            'Can a caller misuse this without a compile error, and is that acceptable?',
            'What test fails if the guard, the mapping, or the contract is removed?'
          ],
          tip: 'If an answer is we will add a test later, the review is not finished; the test is the evidence that the design holds.'
        },
        {
          h: 'The decisions that need an ADR',
          p: [
            'Not every review produces an architecture decision record, but every decision that is expensive to reverse should. That means boundaries between crates and services, the choice between an enum and a trait, a public error surface, a wire format, a consistency model, and any deliberate coupling you accepted. The ADR is short: context, the decision, the alternatives considered, the consequences, and the condition that would justify revisiting it.',
            'The last section is the one most ADRs omit and the one that makes the trail useful. A decision without a reversal condition becomes folklore: nobody remembers why, so nobody dares change it. Write the trigger explicitly - if p99 of this call exceeds 50 ms, if a second implementation appears, if the vendor deprecates the API - so a future engineer can recognise the moment the decision expired.'
          ],
          code: `# ADR 014: the domain owns the OrderRepository trait

## Status
Accepted 2026-03-11

## Context
The order service needs persistence, and two adapters are
planned: Postgres now, an in-memory store for tests. The first
draft put the trait in the adapter crate.

## Decision
The trait lives in crates/domain. Adapters implement it. Only the
binary wires a concrete adapter into App.

## Alternatives
- Trait in the adapter crate: rejected, the domain would still
  depend on the adapter.
- Generic functions with no trait: rejected, six call sites would
  repeat the bound and the fake would not be shared.

## Consequences
The domain compiles without sqlx. Tests use InMemoryOrders.
Adding a method to the trait is a breaking change for adapters,
so new methods start with default implementations.

## Revisit if
A second consumer of the trait appears outside this workspace,
or the trait grows past eight methods.`,
          tip: 'Write the reversal condition while the reasoning is fresh; it is the part future readers need most.'
        },
        {
          h: 'Encode the rules the compiler can enforce',
          p: [
            'A checklist that lives only in a document decays. Move every mechanically checkable rule into the build: clippy lints for argument count, error size, and enum layout; `unsafe_code = "forbid"` unless the crate has a documented reason; `cargo public-api` diffed in CI so an accidental breaking change is visible in the pull request; `trybuild` compile-fail tests for the calls the types are supposed to forbid.',
            'What remains is judgement: whether the invariant is the right one, whether the boundary is drawn where change happens, whether the degradation policy is honest. That is what the review is for. The split is the point - machines check the rules so humans can spend the forty-five minutes on the decisions.'
          ],
          code: `# --- Cargo.toml ---
[lints.rust]
unsafe_code = "forbid"

[lints.clippy]
too_many_arguments = "warn"   # signatures that need a builder
large_enum_variant = "warn"   # enum layout hinting at a missing Box
result_large_err = "deny"     # errors carried on every happy path
type_complexity = "warn"      # signatures nobody can read

# --- tests/compile_fail.rs ---
#[test]
fn invalid_values_cannot_be_built() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/ui/*.rs");
}

# --- tests/ui/percentage_over_100.rs ---
use my_crate::Percentage;

fn main() {
    // error[E0423]: cannot initialize a tuple struct with private fields
    let _ = Percentage(101);
}`,
          tip: 'Every rule you can encode as a lint is a rule the reviewer no longer has to remember or argue about.'
        }
      ],
      exercise: {
        prompt: 'Turn three review rules into build failures: forbid unsafe code, deny large errors, and prove with a compile-fail test that a validated type cannot be constructed outside its module. Write the Cargo.toml lints, the trybuild harness, and the UI case.',
        starter: `# Cargo.toml
[lints.rust]
# 1. forbid unsafe in this crate

[lints.clippy]
# 2. deny result_large_err

# src/lib.rs
pub struct Percentage(u8);

impl Percentage {
    pub fn new(raw: u8) -> Result<Self, PercentageError> {
        if raw <= 100 { Ok(Self(raw)) } else { Err(PercentageError::OutOfRange) }
    }

    pub fn get(self) -> u8 {
        self.0
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum PercentageError {
    OutOfRange,
}

# tests/compile_fail.rs
# 3. trybuild harness over tests/ui/*.rs

# tests/ui/percentage_field_is_private.rs
# 4. a case that must fail to compile`,
        hint: 'Set unsafe_code = "forbid" under [lints.rust] and result_large_err = "deny" under [lints.clippy]. The harness is trybuild::TestCases::new().compile_fail("tests/ui/*.rs"). The UI case constructs Percentage(101) directly, which fails because the tuple field is private.',
        solution: `# --- Cargo.toml ---
[lints.rust]
unsafe_code = "forbid"

[lints.clippy]
result_large_err = "deny"
too_many_arguments = "warn"

[dev-dependencies]
trybuild = "1"

# --- src/lib.rs ---
pub struct Percentage(u8);

impl Percentage {
    pub fn new(raw: u8) -> Result<Self, PercentageError> {
        if raw <= 100 {
            Ok(Self(raw))
        } else {
            Err(PercentageError::OutOfRange)
        }
    }

    pub fn get(self) -> u8 {
        self.0
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum PercentageError {
    OutOfRange,
}

# --- tests/compile_fail.rs ---
#[test]
fn invalid_values_cannot_be_built() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/ui/*.rs");
}

# --- tests/ui/percentage_field_is_private.rs ---
use my_crate::Percentage;

fn main() {
    // error[E0423]: cannot initialize a tuple struct which contains private fields
    let _ = Percentage(101);
}

# Run: cargo test --test compile_fail
# trybuild compares the emitted diagnostics with the .stderr files,
# so the guarantee is asserted in CI, not in a review comment.`
      },
      production: [
        'Every design review records the invariant, the construction path, and the dependency failure behaviour.',
        'Each PR that changes a public API includes a cargo public-api diff in its description.',
        'Expensive-to-reverse decisions have an ADR with a written revisit condition.',
        'Mechanically checkable rules live in Cargo lints or compile-fail tests, not in reviewer memory.',
        'Compile-fail tests and public API diffs run on every pull request, not on a release branch.'
      ],
      crates: ['trybuild', 'cargo-public-api', 'serde'],
      pitfall: 'A detailed review checklist in a wiki that nobody opens: the rules that could have been lints stay optional, and the same design defects reappear in the next pull request.',
      questions: [
        {
          q: 'Why order review questions by blast radius rather than by category?',
          options: [
            'Because style is unimportant',
            'Because attention is finite and the expensive-to-reverse questions need it most',
            'Because the compiler checks style',
            'Because reviews must be shorter than thirty minutes'
          ],
          answer: 1,
          explain: 'Style matters but is cheap to fix later. Invariants, boundaries, and failure behaviour are expensive to change, so they get the fresh attention.'
        },
        {
          q: 'What makes an ADR useful a year later?',
          options: [
            'A long justification of the chosen option',
            'The context, the alternatives, the consequences, and the condition that would reverse it',
            'A list of everyone who attended the meeting',
            'A link to the pull request only'
          ],
          answer: 1,
          explain: 'The reversal condition is what future readers need: it tells them when the decision expired, instead of leaving it as folklore nobody dares touch.'
        },
        {
          q: 'Which review rule should become a lint or compile-fail test?',
          options: [
            'Whether the boundary follows the business capability',
            'Whether a validated type can be constructed outside its module',
            'Whether the naming matches the domain language',
            'Whether the degradation policy is correct for the business'
          ],
          answer: 1,
          explain: 'Construction reachability is mechanical, so a compile-fail test proves it on every PR. The others need judgement and belong in the review conversation.'
        }
      ],
      quickbytes: [
        'Ask about invariants and failure modes first; style last, and only if time remains.',
        'Demand evidence: a test that fails when the guard is removed, or a compile-fail case.',
        'Encode every mechanical rule as a lint or trybuild test, then review the judgement calls.'
      ],
      github: [
        { name: 'dtolnay/trybuild - compile-fail tests as design guarantees', url: 'https://github.com/dtolnay/trybuild' },
        { name: 'rust-lang/api-guidelines - the checklist this review is built on', url: 'https://github.com/rust-lang/api-guidelines' }
      ],
      resources: [
        {
          title: 'Rust API Guidelines: the full checklist',
          url: 'https://rust-lang.github.io/api-guidelines/checklist.html',
          kind: 'docs'
        },
        {
          title: 'The Cargo Book: the lints section of the manifest',
          url: 'https://doc.rust-lang.org/cargo/reference/manifest.html',
          kind: 'docs'
        },
        {
          title: 'Clippy lint list: the design lints used here',
          url: 'https://rust-lang.github.io/rust-clippy/master/index.html',
          kind: 'docs'
        },
        {
          title: 'trybuild repository',
          url: 'https://github.com/dtolnay/trybuild',
          kind: 'repo'
        }
      ]
    }
  ]
};
