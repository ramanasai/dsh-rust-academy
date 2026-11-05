/**
 * Rust in depth track.
 *
 * Crate versions were read from the crates.io API and the docs.rs release pages
 * current at the time of writing: syn 3.0.9, quote 1.0.47, proc-macro2 1.0.107,
 * nom 8.0.0, bytes 1.12.1, zerocopy 0.8.63, bindgen 0.73.2, thiserror 2.0.21,
 * bumpalo 3.20.3, tokio 1.54.1. Standard library pages were read against
 * stable 1.99.1. Every resource URL was fetched and answered HTTP 200.
 *
 * Anything that is not stable Rust is labelled in the lesson text: portable
 * SIMD, the `Allocator` trait and generic const expressions are still nightly.
 */
export default {
  "key": "rust-advanced",
  "prefix": "r",
  "title": "Rust in depth",
  "blurb": "The language beyond the book: macros, unsafe soundness, FFI, const generics, Pin, async internals and zero-copy design.",
  "level": "industry",
  "project": {
    "title": "Capstone: a zero-copy protocol toolkit",
    "brief": "Build a small wire-protocol library that parses frames without copying payload bytes, hands out borrowed views tied to the input lifetime, and hides its unsafe code behind checked constructors. Add a derive macro that generates the encoding for protocol message types, fuzz the parser until the invariants hold under arbitrary input, and publish the crate with a documented feature-flag and semver policy you can defend in review.",
    "deliverables": [
      "Zero-copy parser with lifetime-safe borrowed views over Bytes and &[u8]",
      "Fuzz targets proving no UB in unsafe blocks, with a seed corpus in CI",
      "Proc-macro derive for the protocol types, with trybuild tests for bad input",
      "Semver and feature-flag policy documented, enforced by cargo-semver-checks",
      "A benchmark showing parse throughput before and after the unsafe fast path"
    ],
    "stack": [
      "bytes",
      "nom",
      "proc-macro2",
      "syn",
      "quote",
      "arbitrary"
    ]
  },
  "lessons": [
    {
      "id": "r01",
      "title": "macro_rules!: fragments, repetition, hygiene",
      "minutes": 55,
      "level": "core",
      "goal": "Match token trees with fragment specifiers, repeat over lists with $(...), and know exactly where macro_rules hygiene protects you and where it does not.",
      "sections": [
        {
          "h": "Match token trees, not types",
          "p": [
            "A declarative macro is a set of rules matched against token trees. Each metavariable carries a fragment specifier that decides how much input it swallows: ident, ty, expr, pat, lifetime, literal, block, item, stmt, or the raw tt. The specifier is a parsing commitment, so expr consumes a whole expression including nested operators, while tt consumes exactly one token tree.",
            "Repetition is written $( ... )SEP* or $( ... )SEP+ with an optional separator, and the body repeats in lockstep. The idiom $(,)? at the end accepts an optional trailing comma, which is what makes a macro feel like real Rust syntax. The expansion must produce a single expression or item, which is why multi-statement macros wrap themselves in a block."
          ],
          "code": "use std::collections::HashMap;\n\n/// Build a map from `key => value` pairs without an intermediate Vec.\nmacro_rules! map_of {\n    () => { HashMap::new() };\n    ($($key:expr => $value:expr),+ $(,)?) => {{\n        let mut map = HashMap::new();\n        $( map.insert($key, $value); )+\n        map\n    }};\n}\n\nfn main() {\n    let ports = map_of! {\n        \"http\" => 80,\n        \"https\" => 443,\n    };\n    assert_eq!(ports[\"https\"], 443);\n    assert!(map_of!().is_empty());\n}",
          "tip": "Pick the loosest specifier that parses your intent. tt defers parsing to the caller's context; expr commits early and then refuses anything that is not an expression."
        },
        {
          "h": "Hygiene: locals yes, items no",
          "p": [
            "macro_rules is hygienic for local variables and labels. Two expansions that both bind __start get distinct syntax contexts, so the caller's __start is untouched and you do not need unique names. This is the opposite of a C preprocessor macro, and it is why macro authors can use readable local names.",
            "Hygiene does not extend to items. A macro that expands to a fn, struct, or const at module scope defines a real item with that name, and invoking it twice in the same module is a duplicate-definition error. Paths are also not hygienic: inside an exported macro, refer to your own crate through $crate:: rather than crate::, because crate:: means the caller's crate."
          ],
          "code": "#[macro_export]\nmacro_rules! timed {\n    ($label:expr, $body:block) => {{\n        let __start = std::time::Instant::now(); // hygienic: no collision\n        let value = (|| $body)();\n        eprintln!(\"{}: {:?}\", $label, __start.elapsed());\n        value\n    }};\n}\n\nfn main() {\n    let __start = 41; // caller's binding, same spelling, different context\n    let answer = timed!(\"compute\", { __start + 1 });\n    assert_eq!(answer, 42);\n}",
          "tip": "Wrap the body in a closure only when you need a value back; a bare block would let a `return` inside the caller's block return from the caller's function."
        },
        {
          "h": "The double-evaluation trap",
          "p": [
            "An expr fragment is expanded text, not a value. If the body mentions $v twice, the caller's expression is compiled twice and runs twice. A macro called as if it were a function can therefore double-charge a card or double-pop a queue while looking completely reasonable at the call site.",
            "The fix is to bind each argument to a local exactly once, at the top of the expansion, then use the local. That also gives the compiler one place to report a type error. For macros that must create new identifiers, macro_rules cannot concatenate names at all; use the paste crate, or accept that a proc macro is the right tool."
          ],
          "code": "macro_rules! clamp {\n    ($v:expr, $lo:expr, $hi:expr) => {{\n        // Bind once: `$v` is syntax. Repeating it repeats the side effect.\n        let v = $v;\n        let lo = $lo;\n        let hi = $hi;\n        v.max(lo).min(hi)\n    }};\n}\n\nfn next() -> i32 {\n    println!(\"evaluated once\");\n    99\n}\n\nfn main() {\n    assert_eq!(clamp!(next(), 0, 10), 10); // prints once, not three times\n}",
          "list": [
            "Use expr for values, ty for types, tt when the grammar must stay open",
            "Repeat with $( ... ),+ and accept a trailing comma with $(,)?",
            "Bind each argument once; never expand the same expr twice",
            "Export with #[macro_export] and reach crate items through $crate::"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write an assert_close! macro that accepts either two float arguments (using a 1e-9 epsilon) or three arguments where the third is an explicit epsilon. Both forms must evaluate each argument exactly once.",
        "starter": "macro_rules! assert_close {\n    // 1. two-argument form: call the three-argument form\n    ($a:expr, $b:expr) => {\n        todo!()\n    };\n    // 2. three-argument form: bind each expr once, compare the delta\n    ($a:expr, $b:expr, $eps:expr) => {\n        todo!()\n    };\n}",
        "hint": "Implement the three-argument arm first, then forward with assert_close!($a, $b, 1e-9). Inside the arm: let a = $a; let b = $b; let eps = $eps; assert!((a - b).abs() <= eps, ...).",
        "solution": "macro_rules! assert_close {\n    ($a:expr, $b:expr) => {\n        assert_close!($a, $b, 1e-9)\n    };\n    ($a:expr, $b:expr, $eps:expr) => {{\n        let a: f64 = $a;\n        let b: f64 = $b;\n        let eps: f64 = $eps;\n        assert!(\n            (a - b).abs() <= eps,\n            \"{} and {} differ by more than {}\",\n            a,\n            b,\n            eps\n        );\n    }};\n}\n\nfn main() {\n    assert_close!(0.1 + 0.2, 0.3);\n    assert_close!(1.0_f64, 1.05, 0.1);\n}"
      },
      "questions": [
        {
          "q": "In the pattern $($field:ident),* $(,)?, what does the trailing $(,)? match?",
          "options": [
            "An optional trailing comma after the last repetition",
            "Exactly one comma, always",
            "Zero or more commas, each of which is captured",
            "A comma that separates the repetition from the body"
          ],
          "answer": 0,
          "explain": "A repetition with a ? suffix matches zero or one time, so $(,)? makes a trailing comma legal but not required. Without it, map_of!{ \"a\" => 1, } would fail to parse."
        },
        {
          "q": "Which construct is NOT protected by macro_rules! hygiene?",
          "options": [
            "A local variable named __start created inside the expansion",
            "A fn item that the expansion defines at module scope",
            "A loop label created inside the expansion",
            "A binding introduced in a nested block of the expansion"
          ],
          "answer": 1,
          "explain": "Hygiene covers local variables and labels. Items are ordinary module-level definitions, so two invocations in the same module collide with a duplicate-definition error."
        },
        {
          "q": "Why does the clamp! example bind $v to a local before using it?",
          "options": [
            "Because an expr fragment is re-expanded at every use, so side effects repeat",
            "Because the borrow checker forbids using an expr fragment twice",
            "Because macros cannot reference the same fragment in two statements",
            "Because binding improves hygiene for the caller's variables"
          ],
          "answer": 0,
          "explain": "The expansion is syntax, so each mention of $v duplicates the caller's expression. Binding to a local makes it one evaluation and one place for the compiler to report a type error."
        }
      ],
      "quickbytes": [
        "cargo expand --lib | less   # see what your macro actually emitted",
        "cargo expand --test api     # expands a specific integration test",
        "Use $crate::path inside an exported macro; crate:: means the caller's crate.",
        "The default recursion_limit is 128; deeply nested macro recursion needs #![recursion_limit = \"256\"]."
      ],
      "production": [
        "Every exported macro reaches sibling items through $crate:: and never through crate:: or a relative path.",
        "Each macro argument is bound to a local once; no expr fragment appears twice in an expansion.",
        "A trailing comma is accepted on every list-style macro, matching std formatting conventions.",
        "Macro-generated code is expanded in review or covered by a test, because users cannot step into it."
      ],
      "crates": [
        "paste",
        "cargo-expand"
      ],
      "github": [
        {
          "name": "dtolnay/paste",
          "url": "https://github.com/dtolnay/paste"
        }
      ],
      "pitfall": "An expr fragment used twice in the expansion compiles silently and evaluates the caller's argument twice, so a macro that looks like a function call double-mutates state or double-charges a request.",
      "resources": [
        {
          "title": "The Rust Reference: macros by example",
          "url": "https://doc.rust-lang.org/reference/macros-by-example.html",
          "kind": "docs"
        },
        {
          "title": "The Rust Reference: macro scoping, hygiene and $crate",
          "url": "https://doc.rust-lang.org/reference/macros.html",
          "kind": "docs"
        },
        {
          "title": "paste: concatenate identifiers inside macro_rules",
          "url": "https://docs.rs/paste/latest/paste/",
          "kind": "docs"
        },
        {
          "title": "dtolnay/paste repository",
          "url": "https://github.com/dtolnay/paste",
          "kind": "repo"
        },
        {
          "title": "Jon Gjengset: Crust of Rust macro streams",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ]
    },
    {
      "id": "r02",
      "title": "Procedural macros: derive, syn, quote",
      "minutes": 80,
      "level": "core",
      "goal": "Build a derive macro that parses real Rust syntax with syn, emits code with quote, and reports mistakes at the right span instead of at the call site.",
      "sections": [
        {
          "h": "A proc-macro crate is a compiler plugin",
          "p": [
            "A procedural macro is a normal Rust crate compiled for the host and loaded into rustc. It is declared with [lib] proc-macro = true, and the only public items it may have are functions marked #[proc_macro], #[proc_macro_derive], or #[proc_macro_attribute]. They take and return proc_macro::TokenStream, which is why the macros run before type checking and cannot see types, only tokens.",
            "Because the macro runs on tokens, it has to parse them. syn turns those tokens into a syntax tree, and quote turns a syntax tree back into tokens. proc-macro2 provides a TokenStream type that works outside the compiler, which is what makes macro logic unit-testable in an ordinary test binary."
          ],
          "code": "# Cargo.toml\n[package]\nname = \"proto-derive\"\nversion = \"0.1.0\"\nedition = \"2024\"\n\n[lib]\nproc-macro = true\n\n[dependencies]\nsyn = { version = \"3\", features = [\"derive\"] }\nquote = \"1\"\nproc-macro2 = \"1\"",
          "tip": "Keep the derive feature set minimal. Every syn feature is extra compile time paid by every crate that depends on your macro."
        },
        {
          "h": "Derive: read the AST, write the impl",
          "p": [
            "A derive receives the item it is attached to as a DeriveInput: the identifier, the generics, and the data. split_for_impl produces the three pieces an impl needs, so generics and where clauses survive instead of being dropped and breaking generic types.",
            "Errors must be spanned. Returning Err from the entry point gives a message with no location; syn::Error::new_spanned attaches it to the tokens that caused it, so the caret lands on the offending field type rather than on the #[derive] line. This single habit is the difference between a macro people trust and one people curse."
          ],
          "code": "use proc_macro::TokenStream;\nuse quote::quote;\nuse syn::{parse_macro_input, Data, DeriveInput, Error, Fields, Type};\n\n#[proc_macro_derive(Encode)]\npub fn derive_encode(input: TokenStream) -> TokenStream {\n    let input = parse_macro_input!(input as DeriveInput);\n    let name = &input.ident;\n    let (impl_generics, ty_generics, where_clause) = input.generics.split_for_impl();\n\n    let Data::Struct(data) = &input.data else {\n        return Error::new_spanned(&input.ident, \"Encode only supports structs\")\n            .to_compile_error()\n            .into();\n    };\n    let Fields::Named(fields) = &data.fields else {\n        return Error::new_spanned(&input.ident, \"Encode needs named fields\")\n            .to_compile_error()\n            .into();\n    };\n\n    let mut writes = Vec::new();\n    for field in &fields.named {\n        let ident = field.ident.as_ref().expect(\"named field\");\n        let ty = &field.ty;\n        let write = match ty {\n            Type::Path(p) if p.path.is_ident(\"u8\") => quote! { out.push(self.#ident); },\n            Type::Path(p) if p.path.is_ident(\"u16\") => quote! {\n                out.extend_from_slice(&self.#ident.to_be_bytes());\n            },\n            _ => {\n                return Error::new_spanned(ty, \"Encode supports only u8 and u16\")\n                    .to_compile_error()\n                    .into();\n            }\n        };\n        writes.push(write);\n    }\n\n    quote! {\n        impl #impl_generics Encode for #name #ty_generics #where_clause {\n            fn encode(&self, out: &mut Vec<u8>) {\n                #(#writes)*\n            }\n        }\n    }\n    .into()\n}",
          "tip": "quote! repeats a Vec with #(#writes)*. Anything you interpolate must implement ToTokens, which is why you collect token streams rather than strings."
        },
        {
          "h": "Test the errors, not only the output",
          "p": [
            "A derive that produces working code on good input is half a macro. The other half is the message a user sees on bad input, and that message is a stable artifact you can regression-test with trybuild: each tests/ui/*.rs file is compiled, expected to fail, and compared against a checked-in .stderr file.",
            "Proc macros have no hygiene at all. Names you emit resolve in the caller's scope, so emit absolute paths such as ::core::primitive::u8 or ::alloc::vec::Vec rather than assuming a prelude. If the macro must name its own crate, resolve the real crate name with proc-macro-crate instead of hard-coding it, because the dependency may be renamed."
          ],
          "code": "// tests/compile_fail.rs\n#[test]\nfn rejects_unsupported_field_types() {\n    let t = trybuild::TestCases::new();\n    t.compile_fail(\"tests/ui/*.rs\"); // each .rs needs a matching .stderr\n}\n\n// tests/ui/f32_field.rs\nuse proto_derive::Encode;\n\n#[derive(Encode)]\nstruct Header {\n    version: u8,\n    weight: f32, // error: Encode supports only u8 and u16\n}\n\nfn main() {}",
          "list": [
            "cargo expand --lib  -  read the generated impl as ordinary Rust",
            "trybuild  -  freeze error messages and spans in tests/ui/*.stderr",
            "Error::new_spanned  -  point the caret at the tokens that are wrong",
            "::core:: and ::alloc::  -  never rely on the caller's prelude"
          ]
        }
      ],
      "exercise": {
        "prompt": "Extend the Encode derive so that a field of type Option<u8> is rejected with a message that names the field and points at its type, rather than falling into the generic unsupported-type arm.",
        "starter": "for field in &fields.named {\n    let ident = field.ident.as_ref().expect(\"named field\");\n    let ty = &field.ty;\n    // 1. detect Type::Path with path is_ident(\"Option\")\n    // 2. build an Error::new_spanned on `ty` that includes the field name\n    // 3. keep the u8 / u16 arms and the catch-all\n}",
        "hint": "Match Type::Path(p) if p.path.is_ident(\"Option\") before the u8 arm, and format! the field name into the message: Error::new_spanned(ty, format!(\"field `{}` is optional; protocol fields are fixed-size\", ident)).",
        "solution": "use proc_macro::TokenStream;\nuse quote::quote;\nuse syn::{parse_macro_input, Data, DeriveInput, Error, Fields, Type};\n\n#[proc_macro_derive(Encode)]\npub fn derive_encode(input: TokenStream) -> TokenStream {\n    let input = parse_macro_input!(input as DeriveInput);\n    let name = &input.ident;\n    let (impl_generics, ty_generics, where_clause) = input.generics.split_for_impl();\n\n    let Data::Struct(data) = &input.data else {\n        return Error::new_spanned(&input.ident, \"Encode only supports structs\")\n            .to_compile_error()\n            .into();\n    };\n    let Fields::Named(fields) = &data.fields else {\n        return Error::new_spanned(&input.ident, \"Encode needs named fields\")\n            .to_compile_error()\n            .into();\n    };\n\n    let mut writes = Vec::new();\n    for field in &fields.named {\n        let ident = field.ident.as_ref().expect(\"named field\");\n        let ty = &field.ty;\n        let write = match ty {\n            Type::Path(p) if p.path.is_ident(\"Option\") => {\n                let message = format!(\n                    \"field `{}` is optional; protocol fields are fixed-size\",\n                    ident\n                );\n                return Error::new_spanned(ty, message).to_compile_error().into();\n            }\n            Type::Path(p) if p.path.is_ident(\"u8\") => quote! { out.push(self.#ident); },\n            Type::Path(p) if p.path.is_ident(\"u16\") => quote! {\n                out.extend_from_slice(&self.#ident.to_be_bytes());\n            },\n            _ => {\n                return Error::new_spanned(ty, \"Encode supports only u8 and u16\")\n                    .to_compile_error()\n                    .into();\n            }\n        };\n        writes.push(write);\n    }\n\n    quote! {\n        impl #impl_generics Encode for #name #ty_generics #where_clause {\n            fn encode(&self, out: &mut ::alloc::vec::Vec<u8>) {\n                #(#writes)*\n            }\n        }\n    }\n    .into()\n}"
      },
      "questions": [
        {
          "q": "Why must a proc-macro crate keep every public item a macro entry point?",
          "options": [
            "Because rustc loads the crate as a plugin and only understands the three proc-macro attributes there",
            "Because proc-macro crates cannot depend on syn",
            "Because TokenStream is not a public type",
            "Because the crate is compiled for the target, not the host"
          ],
          "answer": 0,
          "explain": "A proc-macro crate is a dylib loaded by the compiler. Its exported surface is restricted to the macro entry points; anything else fails to compile rather than being callable at runtime."
        },
        {
          "q": "What does input.generics.split_for_impl() give you, and why does it matter?",
          "options": [
            "The impl generics, type generics and where clause, so a generic input type still gets a valid impl",
            "A clone of the token stream, so the macro can emit it twice",
            "The visibility and attributes of the input item",
            "A hash of the generics used for cache invalidation"
          ],
          "answer": 0,
          "explain": "Without split_for_impl you must paste <T: Bound> yourself, and generic protocol types silently fail to compile. The three returned values slot directly into an impl header."
        },
        {
          "q": "Which error is easier for a user to act on?",
          "options": [
            "Error::new_spanned(ty, \"Encode supports only u8 and u16\")",
            "Error::new(Span::call_site(), \"Encode supports only u8 and u16\")",
            "panic!(\"unsupported field\") inside the macro",
            "Returning an empty TokenStream"
          ],
          "answer": 0,
          "explain": "new_spanned points the caret at the field type the user wrote. call_site and panics point at the derive line or produce an opaque compiler panic, and an empty TokenStream produces a confusing missing-impl error."
        }
      ],
      "quickbytes": [
        "cargo expand --lib proto   # print the generated impl as formatted Rust",
        "proc-macro crates compile for the host, so they cannot use target-only dependencies.",
        "Emit ::core:: and ::alloc:: absolute paths; proc macros have zero hygiene.",
        "Store one .stderr file per failing case and update them with TRYBUILD=overwrite."
      ],
      "production": [
        "Every reject path returns Error::new_spanned at the offending tokens; no macro panics on user input.",
        "Generic inputs go through split_for_impl so bounds and where clauses survive.",
        "trybuild tests with checked-in .stderr files run in CI, so error quality cannot regress silently.",
        "The macro emits absolute ::core:: / ::alloc:: paths and resolves its own crate name via proc-macro-crate."
      ],
      "crates": [
        "syn",
        "quote",
        "proc-macro2",
        "trybuild"
      ],
      "github": [
        {
          "name": "dtolnay/syn",
          "url": "https://github.com/dtolnay/syn"
        },
        {
          "name": "dtolnay/trybuild",
          "url": "https://github.com/dtolnay/trybuild"
        }
      ],
      "pitfall": "Returning Err from a derive entry point without a span produces a bare message with no source location, so users cannot tell which field is wrong and learn to distrust the macro.",
      "resources": [
        {
          "title": "syn: parsing Rust source in proc macros",
          "url": "https://docs.rs/syn/latest/syn/",
          "kind": "docs"
        },
        {
          "title": "quote: quasi-quoting TokenStreams",
          "url": "https://docs.rs/quote/latest/quote/",
          "kind": "docs"
        },
        {
          "title": "proc-macro2: TokenStream outside the compiler",
          "url": "https://docs.rs/proc-macro2/latest/proc_macro2/",
          "kind": "docs"
        },
        {
          "title": "dtolnay/syn repository",
          "url": "https://github.com/dtolnay/syn",
          "kind": "repo"
        },
        {
          "title": "trybuild: compile-fail tests for macros",
          "url": "https://docs.rs/trybuild/latest/trybuild/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "r03",
      "title": "Unsafe is a proof obligation, not an escape hatch",
      "minutes": 70,
      "level": "advanced",
      "goal": "State the invariants the compiler stops checking inside unsafe, encapsulate them behind a checked constructor, and verify the result with Miri instead of hoping.",
      "sections": [
        {
          "h": "What the optimizer still assumes",
          "p": [
            "unsafe does not turn off the optimizer; it transfers a proof obligation to you. A reference must be non-null, aligned, dereferenceable for its whole lifetime, and point at a valid value. A &mut must be unique for its lifetime, so no other reference may touch those bytes while it exists. Breaking any of these is undefined behaviour, and UB is defined by the abstract machine, not by whether the resulting assembly happens to work.",
            "The practical consequence: an unsafe block that is never executed in your tests can still be the bug, because the optimizer may reorder or delete code based on the promises the block made. That is why the question is never whether the code works on x86_64 today, but whether the assumptions hold for every input the safe API accepts."
          ],
          "code": "use std::convert::TryInto;\n\n/// Safe: the length and endianness are pinned here, not at the call site.\npub fn read_u32_le(bytes: &[u8]) -> Option<u32> {\n    let chunk: [u8; 4] = bytes.get(..4)?.try_into().ok()?;\n    Some(u32::from_le_bytes(chunk))\n}\n\nfn main() {\n    assert_eq!(read_u32_le(&[0x01, 0x00, 0x00, 0x00]), Some(1));\n    assert_eq!(read_u32_le(&[0x01, 0x00]), None); // no panic, no UB\n}",
          "tip": "Prefer a checked conversion over transmute even when you are certain of the layout: the certain version is one refactor away from being wrong."
        },
        {
          "h": "Encapsulate the invariant in one type",
          "p": [
            "Unsafe code is sound when every safe constructor establishes the invariant and every mutation preserves it. A type with a field that is always non-empty can expose first() through get_unchecked, because the only ways to build it are a checked constructor and a push. The unsafe block is then one line, the proof is the type invariant, and callers cannot violate it without unsafe of their own.",
            "Document the invariant on the type, not on the unsafe block. A SAFETY comment should state which precondition holds and why, not restate the operation. With the unsafe_op_in_unsafe_fn lint (warn by default in edition 2024) even an unsafe fn needs an inner unsafe block, which keeps the audit surface exactly as wide as the operations that need it."
          ],
          "code": "pub struct NonEmpty<T> {\n    items: Vec<T>,\n}\n\nimpl<T> NonEmpty<T> {\n    /// The only way to build one, so `items` is never empty afterwards.\n    pub fn new(first: T) -> Self {\n        Self { items: vec![first] }\n    }\n\n    pub fn first(&self) -> &T {\n        // SAFETY: `new` seeds the vector and no method removes elements.\n        unsafe { self.items.get_unchecked(0) }\n    }\n\n    pub fn push(&mut self, value: T) {\n        self.items.push(value); // preserves the invariant\n    }\n}\n\nfn main() {\n    let mut list = NonEmpty::new(1);\n    list.push(2);\n    assert_eq!(*list.first(), 1);\n}",
          "tip": "If a struct has no private fields, it cannot have an invariant. Soundness starts with making the invariant impossible to bypass from outside the module."
        },
        {
          "h": "Miri, Send, and the aliasing model",
          "p": [
            "Miri is an interpreter for the Rust abstract machine that ships with the nightly toolchain. It catches use-after-free, out-of-bounds access, misaligned reads, invalid values, and aliasing violations that ordinary tests never observe. Running cargo +nightly miri test over the module that contains your unsafe blocks is the cheapest soundness test that exists.",
            "Send and Sync are unsafe traits because they assert a fact about the type, not a mechanism. A type is Send if moving it between threads is safe and Sync if sharing a reference is; wrapping a non-atomic counter in a struct and implementing Sync for it is a data race with no compiler error. Static assertions stop that from spreading: assert_not_impl_any!(Bad: Send, Sync) fails the build if an accidental auto-impl appears."
          ],
          "code": "# Run the whole suite under the interpreter, with stricter checks:\ncargo +nightly miri test\ncargo +nightly miri test -- -Zmiri-strict-provenance\ncargo +nightly miri test -- -Zmiri-tree-borrows   # newer aliasing model\n\n# Fuzz the safe surface; UB found by fuzzing still needs Miri to explain it:\ncargo +nightly fuzz run parse_frame\n\n# Fail the build if a wrapper silently becomes Send:\nstatic_assertions::assert_not_impl_any!(Counter: Send, Sync);",
          "list": [
            "Miri needs nightly, and it is slow: run it on the modules with unsafe, not the whole workspace",
            "A SAFETY comment states the precondition and why it holds, not what the line does",
            "unsafe impl Send requires a real argument: atomics, a lock, or single-threaded ownership",
            "Fuzzing finds inputs that trigger UB; Miri explains why it is UB"
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement a ByteView<'a> that wraps a &'a [u8] known to be at least 4 bytes long, exposes header() reading a u32 without bounds checks, and cannot be constructed from a shorter slice.",
        "starter": "pub struct ByteView<'a> {\n    bytes: &'a [u8],\n}\n\nimpl<'a> ByteView<'a> {\n    pub fn new(bytes: &'a [u8]) -> Option<Self> {\n        todo!()\n    }\n\n    pub fn header(&self) -> u32 {\n        // read the first four bytes without a bounds check\n        todo!()\n    }\n}",
        "hint": "new returns None when bytes.len() < 4. In header, build a [u8; 4] with ptr::read_unaligned or a TryInto on a get(..4).expect(...) slice, then u32::from_le_bytes. Write the SAFETY comment as a sentence about the constructor.",
        "solution": "pub struct ByteView<'a> {\n    bytes: &'a [u8],\n}\n\nimpl<'a> ByteView<'a> {\n    /// Returns None unless at least four bytes are available. This is the\n    /// only constructor, so `bytes.len() >= 4` holds for every ByteView.\n    pub fn new(bytes: &'a [u8]) -> Option<Self> {\n        (bytes.len() >= 4).then_some(Self { bytes })\n    }\n\n    pub fn header(&self) -> u32 {\n        // SAFETY: the constructor proved len >= 4, and `bytes` is never\n        // shortened or reassigned afterwards.\n        let chunk: [u8; 4] = unsafe { *self.bytes.as_ptr().cast::<[u8; 4]>() };\n        u32::from_le_bytes(chunk)\n    }\n\n    pub fn payload(&self) -> &'a [u8] {\n        &self.bytes[4..]\n    }\n}\n\nfn main() {\n    let view = ByteView::new(&[1, 0, 0, 0, 9]).expect(\"five bytes\");\n    assert_eq!(view.header(), 1);\n    assert_eq!(view.payload(), &[9]);\n    assert!(ByteView::new(&[1, 0]).is_none());\n}"
      },
      "questions": [
        {
          "q": "An unsafe block that is never taken at runtime can still be the source of a miscompilation. Why?",
          "options": [
            "Because its assertions are assumptions the optimizer may use to transform reachable code",
            "Because rustc runs every unsafe block at compile time",
            "Because unsafe blocks disable the borrow checker globally",
            "Because Miri executes unsafe blocks during compilation"
          ],
          "answer": 0,
          "explain": "UB is a property of the abstract machine, and the optimizer is allowed to assume the promises hold. A violated invariant in dead-looking code can still license a transformation elsewhere."
        },
        {
          "q": "Where does a sound wrapper put the check that makes its unsafe block valid?",
          "options": [
            "In every constructor and mutating method, so the type invariant always holds",
            "In the unsafe block itself, before the operation",
            "In a debug_assert! that is compiled out in release",
            "In the caller, documented as a precondition on the safe function"
          ],
          "answer": 0,
          "explain": "A safe function must be sound for every argument it accepts, so the invariant has to be established by construction and preserved by mutation. Checking inside the unsafe block is too late, and debug_assert! disappears in release."
        },
        {
          "q": "Why are Send and Sync unsafe traits?",
          "options": [
            "Because implementing them asserts a thread-safety fact the compiler cannot verify",
            "Because they are only implemented for types containing raw pointers",
            "Because they can only be implemented for types with no fields",
            "Because they change the memory layout of the type"
          ],
          "answer": 0,
          "explain": "The compiler auto-derives both from the fields. Writing unsafe impl overrides that analysis, so you are asserting no data race is possible; a wrong assertion is a real data race with no diagnostic."
        }
      ],
      "quickbytes": [
        "cargo +nightly miri test -- -Zmiri-strict-provenance   # cheapest soundness gate",
        "Add #![deny(unsafe_op_in_unsafe_fn)] and wrap each operation explicitly.",
        "static_assertions::assert_not_impl_any!(T: Send, Sync) catches accidental auto-impls.",
        "A SAFETY comment names the invariant and the code that guarantees it, not the operation."
      ],
      "production": [
        "Every unsafe block has a SAFETY comment that cites the invariant and the constructor that establishes it.",
        "Miri runs over the modules containing unsafe blocks on every pull request, on a pinned nightly.",
        "No unsafe impl Send or Sync exists without a written argument about atomics, locks, or ownership.",
        "Public types either have private fields with a documented invariant or no unsafe invariants at all."
      ],
      "crates": [
        "bytemuck",
        "zerocopy",
        "static_assertions"
      ],
      "github": [
        {
          "name": "rust-lang/miri",
          "url": "https://github.com/rust-lang/miri"
        },
        {
          "name": "Lokathor/bytemuck",
          "url": "https://github.com/Lokathor/bytemuck"
        }
      ],
      "pitfall": "A struct with public fields plus an internal invariant: any caller can break the invariant with safe code, and the get_unchecked in your method becomes UB that no test will reproduce.",
      "resources": [
        {
          "title": "The Rustonomicon: aliasing and validity",
          "url": "https://doc.rust-lang.org/nomicon/aliasing.html",
          "kind": "docs"
        },
        {
          "title": "The Rust Reference: behavior considered undefined",
          "url": "https://doc.rust-lang.org/reference/behavior-considered-undefined.html",
          "kind": "docs"
        },
        {
          "title": "Miri: an interpreter for Rust's abstract machine",
          "url": "https://github.com/rust-lang/miri",
          "kind": "repo"
        },
        {
          "title": "Memory-Safety Challenge Considered Solved? An In-Depth Study with All Rust CVEs",
          "url": "https://arxiv.org/abs/2003.03296",
          "kind": "paper"
        },
        {
          "title": "Kani: A Model Checker for Rust",
          "url": "https://arxiv.org/abs/2607.01504",
          "kind": "paper"
        }
      ]
    },
    {
      "id": "r04",
      "title": "FFI: repr(C), bindgen and ownership across the boundary",
      "minutes": 85,
      "level": "advanced",
      "goal": "Describe a struct the way C sees it, generate bindings at build time, and decide precisely who allocates and who frees every value that crosses the boundary.",
      "sections": [
        {
          "h": "repr(C) is a layout contract, not a decoration",
          "p": [
            "Rust reorders fields by default. #[repr(C)] fixes declaration order and the C alignment rules, which is the only reason a C caller can read your struct. The mirror image matters too: a C struct you import needs the same attribute, and a fieldless Rust enum is not a C enum, because C can pass a discriminant your enum does not have and that is immediate undefined behaviour.",
            "Model C enums as a #[repr(transparent)] newtype over the integer type and convert with TryFrom, returning an error for unknown values. bool is not FFI-safe (it must be 0 or 1); use u8. Option<Box<T>> is not FFI-safe, while Option<&T> is, because a reference has a niche the optimizer can use for None. The improper_ctypes lint exists to catch exactly these mistakes, so do not silence it."
          ],
          "code": "use std::convert::TryFrom;\n\n#[repr(C)]\npub struct RawConfig {\n    pub flags: u32,\n    pub timeout_ms: u32,\n    pub retries: u16,\n    pub mode: u16, // C enum values, validated below\n}\n\npub struct Config {\n    pub flags: u32,\n    pub timeout_ms: u32,\n    pub retries: u16,\n    pub mode: Mode,\n}\n\n#[repr(u16)]\n#[derive(Clone, Copy)]\npub enum Mode {\n    Fast = 0,\n    Durable = 1,\n}\n\nimpl TryFrom<RawConfig> for Config {\n    type Error = &'static str;\n\n    fn try_from(raw: RawConfig) -> Result<Self, Self::Error> {\n        if raw.retries > 8 {\n            return Err(\"retries above 8 are rejected\");\n        }\n        let mode = match raw.mode {\n            0 => Mode::Fast,\n            1 => Mode::Durable,\n            _ => return Err(\"mode is not a known discriminant\"),\n        };\n        Ok(Config { flags: raw.flags, timeout_ms: raw.timeout_ms, retries: raw.retries, mode })\n    }\n}",
          "tip": "Every value arriving from C is untrusted input, even when the caller is your own code: validate the discriminant, the length, and the pointer before you build a safe type."
        },
        {
          "h": "bindgen belongs in build.rs",
          "p": [
            "Hand-writing extern declarations drifts from the header within a week. bindgen parses the C headers at build time and writes a bindings.rs into OUT_DIR, which you include!. Restrict the surface with allowlist_function and allowlist_type: generated bindings for an entire libc are thousands of items and every one of them is an unsafe foreign call you now own.",
            "Follow the -sys naming convention. A foo-sys crate contains only the generated declarations plus the build script that finds or builds libfoo, and a hand-written foo crate wraps it in safe types. That split lets two crates in the same build share one native dependency instead of linking it twice."
          ],
          "code": "// src/lib.rs — one include, generated at build time.\n#![allow(non_upper_case_globals, non_camel_case_types)]\ninclude!(concat!(env!(\"OUT_DIR\"), \"/bindings.rs\"));\n\n// build.rs\nuse std::path::PathBuf;\n\nfn main() {\n    println!(\"cargo::rerun-if-changed=wrapper.h\");\n\n    let bindings = bindgen::Builder::default()\n        .header(\"wrapper.h\")\n        .allowlist_function(\"acme_.*\")\n        .allowlist_type(\"acme_.*\")\n        .derive_default(true)\n        .layout_tests(true) // asserts Rust and C agree on every struct size\n        .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()))\n        .generate()\n        .expect(\"unable to generate bindings\");\n\n    let out = PathBuf::from(std::env::var(\"OUT_DIR\").expect(\"OUT_DIR is set by cargo\"));\n    bindings\n        .write_to_file(out.join(\"bindings.rs\"))\n        .expect(\"could not write bindings\");\n}",
          "tip": "layout_tests(true) emits compile-time size and offset assertions. It is the earliest possible warning that a header changed without your Rust side following."
        },
        {
          "h": "Strings and ownership: one allocator frees",
          "p": [
            "A C string is a pointer to bytes ending in a NUL. CStr::from_ptr borrows it and is unsafe because nothing checks that the pointer is valid, aligned, NUL-terminated inside the allocation, or alive for the borrow. The safe side of that contract is documented on the function: who owns the buffer, how long it lives, and what happens on NULL.",
            "The classic leak and crash pair is CString::into_raw followed by forgetting the matching CString::from_raw, or handing a Rust allocation to C free. Allocate with one allocator and free with the same one. When passing a Rust string out, either lend a pointer valid for the call or return an owned pointer plus an explicit destroy function that reconstructs the CString."
          ],
          "code": "use std::ffi::{c_char, CStr, CString};\n\n/// # Safety\n/// `ptr` must be null or point to a NUL-terminated string that stays valid\n/// for the duration of this call.\npub unsafe fn greet(ptr: *const c_char) -> Option<String> {\n    if ptr.is_null() {\n        return None;\n    }\n    // SAFETY: caller guarantees a NUL-terminated, readable string.\n    let text = unsafe { CStr::from_ptr(ptr) };\n    Some(format!(\"hello, {}\", text.to_string_lossy()))\n}\n\npub fn call_with_rust_string(name: &str) -> Option<String> {\n    let owned = CString::new(name).ok()?; // rejects interior NUL bytes\n    // SAFETY: `owned` outlives the call and is NUL-terminated.\n    unsafe { greet(owned.as_ptr()) }\n}\n\npub fn take_ownership(raw: *mut c_char) -> Option<String> {\n    if raw.is_null() {\n        return None;\n    }\n    // SAFETY: the pointer came from CString::into_raw in this same library.\n    let owned = unsafe { CString::from_raw(raw) };\n    owned.into_string().ok()\n}",
          "list": [
            "CString::new fails on interior NULs; never unwrap it on user input",
            "CStr::from_ptr borrows; the caller keeps the buffer alive",
            "into_raw must be paired with from_raw exactly once, in the same library",
            "Never hand a Rust allocation to free(3) or a C allocation to drop"
          ]
        },
        {
          "h": "Edition 2024: unsafe extern and unwinding",
          "p": [
            "In edition 2024 an extern block is unsafe extern \"C\" { ... }, because a wrong signature is a soundness bug, and functions inside it are unsafe to call by default; mark the ones with no preconditions as pub safe fn. Attributes with safety requirements moved under the unsafe(...) wrapper, so a C entry point is #[unsafe(no_mangle)] rather than #[no_mangle].",
            "Unwinding across a non-unwind ABI is not allowed. Since Rust 1.81 a panic that escapes an extern \"C\" function aborts the process instead of unwinding into C. That is memory-safe, but it is a crash: if the boundary must survive a bad request, catch_unwind inside it and return a status code, and never let a panic be the error channel."
          ],
          "code": "use std::panic::{catch_unwind, AssertUnwindSafe};\n\nunsafe extern \"C\" {\n    // Declared safe: any f64 is a valid argument.\n    pub safe fn sqrt(x: f64) -> f64;\n\n    // Not safe: requires a valid, NUL-terminated pointer.\n    pub fn acme_lookup(name: *const std::ffi::c_char) -> u32;\n}\n\n#[unsafe(no_mangle)]\npub extern \"C\" fn acme_handle(request_id: u64) -> i32 {\n    match catch_unwind(AssertUnwindSafe(|| handle(request_id))) {\n        Ok(Ok(())) => 0,\n        Ok(Err(code)) => code,\n        Err(_) => 2, // a panic is a bug, not a protocol error\n    }\n}\n\nfn handle(request_id: u64) -> Result<(), i32> {\n    if request_id == 0 {\n        return Err(1);\n    }\n    let _ = unsafe { sqrt(request_id as f64) };\n    Ok(())\n}",
          "tip": "String the ABI into the type: a function that returns i32 status codes is reviewable; one that returns a raw pointer and hopes is not."
        }
      ],
      "exercise": {
        "prompt": "Wrap a C function int acme_parse(const char *json, acme_doc **out) so that Rust callers get Result<Doc, ParseError>: check the pointer, convert the C string safely, and never leak the returned document.",
        "starter": "use std::ffi::{c_char, CStr};\n\n#[repr(C)]\npub struct acme_doc {\n    _private: [u8; 0],\n}\n\nunsafe extern \"C\" {\n    pub fn acme_parse(json: *const c_char, out: *mut *mut acme_doc) -> i32;\n    pub fn acme_free(doc: *mut acme_doc);\n}\n\npub fn parse(json: &str) -> Result<Doc, ParseError> {\n    todo!()\n}",
        "hint": "Build a CString first (interior NULs are an input error). Call acme_parse with a null-initialised out pointer inside unsafe; on non-zero status return the error; on success wrap the non-null pointer in a Doc whose Drop calls acme_free.",
        "solution": "use std::ffi::{c_char, CStr, CString};\nuse std::ptr;\n\n#[repr(C)]\npub struct acme_doc {\n    _private: [u8; 0],\n}\n\nunsafe extern \"C\" {\n    pub fn acme_parse(json: *const c_char, out: *mut *mut acme_doc) -> i32;\n    pub fn acme_free(doc: *mut acme_doc);\n    pub fn acme_last_error() -> *const c_char;\n}\n\n#[derive(Debug)]\npub struct ParseError(pub String);\n\npub struct Doc(*mut acme_doc);\n\nimpl Drop for Doc {\n    fn drop(&mut self) {\n        // SAFETY: the pointer came from acme_parse and is freed exactly once.\n        unsafe { acme_free(self.0) };\n    }\n}\n\npub fn parse(json: &str) -> Result<Doc, ParseError> {\n    let input = CString::new(json).map_err(|_| ParseError(\"interior NUL\".into()))?;\n    let mut out: *mut acme_doc = ptr::null_mut();\n\n    // SAFETY: input is NUL-terminated and alive across the call; out points to\n    // a stack slot the callee may write.\n    let status = unsafe { acme_parse(input.as_ptr(), &mut out) };\n\n    if status != 0 {\n        // SAFETY: the library promises a NUL-terminated error string.\n        let message = unsafe { CStr::from_ptr(acme_last_error()) };\n        return Err(ParseError(message.to_string_lossy().into_owned()));\n    }\n    if out.is_null() {\n        return Err(ParseError(\"null document on success\".into()));\n    }\n    Ok(Doc(out))\n}\n\nfn main() {\n    let doc = parse(\"{\\\"a\\\":1}\").expect(\"valid json\");\n    drop(doc); // acme_free runs here\n}"
      },
      "questions": [
        {
          "q": "Why is a fieldless Rust enum unsafe to receive directly from C?",
          "options": [
            "C can pass a discriminant the enum does not define, which is an invalid value and therefore UB",
            "Its layout is unspecified by repr(Rust)",
            "It cannot implement Copy across the boundary",
            "Its size is always 8 bytes, larger than a C enum"
          ],
          "answer": 0,
          "explain": "A Rust enum may only hold declared discriminants. C can send 7 when only 0 and 1 exist, so the safe pattern is a repr(transparent) newtype plus TryFrom validation."
        },
        {
          "q": "What does the call to CStr::from_ptr actually require from the caller?",
          "options": [
            "A valid pointer to a NUL-terminated string that outlives the borrow",
            "A pointer that Rust allocated with CString",
            "A pointer with at least one byte of readable memory",
            "Nothing beyond non-null; the function validates the rest"
          ],
          "answer": 0,
          "explain": "from_ptr is unsafe because it trusts four things at once: non-null, aligned, NUL-terminated, and valid for the whole borrow. A non-null check alone prevents only the most trivial bug."
        },
        {
          "q": "Since Rust 1.81, what happens when a panic escapes an extern \"C\" function?",
          "options": [
            "The process aborts, closing the soundness hole of unwinding into C",
            "The panic is caught and converted into an error code",
            "The panicking thread unwinds into C and C sees it as an exception",
            "The panic is silently ignored and the function returns zero"
          ],
          "answer": 0,
          "explain": "Non-unwind ABIs abort on an uncaught unwind. It is memory-safe but terminal, so a boundary that must survive bad input uses catch_unwind and returns a status code."
        }
      ],
      "quickbytes": [
        "cargo build -vv   # shows the build script output, including bindgen warnings",
        "bindgen --allowlist-function 'acme_.*' wrapper.h -- -Iinclude   # one-off exploration",
        "cbindgen --lang c --crate foo > foo.h   # generate the C header from Rust",
        "Never let a panic be the error channel across extern \"C\"; return a status code."
      ],
      "production": [
        "Every imported C struct has #[repr(C)] and bindgen layout_tests enabled, so size or offset drift fails the build.",
        "Inbound values are validated: discriminants, lengths, NULL pointers, and interior NULs are rejected before a safe type exists.",
        "Each allocation has exactly one owner and one free function, documented on the function that hands the pointer out.",
        "The C entry points return status codes and use catch_unwind; no unwind can escape into the C caller."
      ],
      "crates": [
        "bindgen",
        "cbindgen",
        "libc",
        "cc"
      ],
      "github": [
        {
          "name": "rust-lang/rust-bindgen",
          "url": "https://github.com/rust-lang/rust-bindgen"
        },
        {
          "name": "mozilla/cbindgen",
          "url": "https://github.com/mozilla/cbindgen"
        }
      ],
      "pitfall": "Passing a Rust String or Vec into C code that calls free on it, or handing a malloc-ed buffer to a Rust Box: two allocators, one pointer, a crash inside the allocator that looks like corruption.",
      "resources": [
        {
          "title": "The Rustonomicon: FFI",
          "url": "https://doc.rust-lang.org/nomicon/ffi.html",
          "kind": "docs"
        },
        {
          "title": "Edition Guide: unsafe extern blocks",
          "url": "https://doc.rust-lang.org/edition-guide/rust-2024/unsafe-extern.html",
          "kind": "docs"
        },
        {
          "title": "bindgen user guide and Builder API",
          "url": "https://docs.rs/bindgen/latest/bindgen/",
          "kind": "docs"
        },
        {
          "title": "rust-lang/rust-bindgen repository",
          "url": "https://github.com/rust-lang/rust-bindgen",
          "kind": "repo"
        },
        {
          "title": "A Study of Undefined Behavior Across Foreign Function Boundaries in Rust Libraries",
          "url": "https://arxiv.org/abs/2404.11671",
          "kind": "paper"
        }
      ]
    },
    {
      "id": "r05",
      "title": "no_std: core, alloc, and a panic handler",
      "minutes": 60,
      "level": "advanced",
      "goal": "Split a crate's dependencies into core, alloc and std, provide the panic handler a freestanding binary needs, and keep std out of an embedded build for good.",
      "sections": [
        {
          "h": "core, alloc, std: three tiers, one prelude",
          "p": [
            "std contains core plus OS facilities: threads, files, sockets, time. alloc contains the heap types - Box, Vec, String, Rc - but not the allocator itself, which the final binary must supply. core is dependency-free and always available, even on a target with no operating system.",
            "Adding #![no_std] swaps the prelude for core::prelude and removes the implicit extern crate std, so std::vec::Vec stops resolving. Libraries should still allow the alloc crate explicitly with extern crate alloc and use alloc::vec::Vec, because that keeps the crate usable on a target that has a heap but no OS."
          ],
          "code": "#![no_std]\n\nextern crate alloc;\n\nuse alloc::vec::Vec;\n\npub struct Frame<'a> {\n    pub kind: u8,\n    pub payload: &'a [u8],\n}\n\n/// Splits length-prefixed frames without copying, appending borrowed views.\npub fn split_frames<'a>(mut input: &'a [u8], out: &mut Vec<Frame<'a>>) -> usize {\n    let mut count = 0;\n    while input.len() >= 3 {\n        let len = u16::from_be_bytes([input[1], input[2]]) as usize;\n        let end = 3 + len;\n        if input.len() < end {\n            break;\n        }\n        out.push(Frame { kind: input[0], payload: &input[3..end] });\n        input = &input[end..];\n        count += 1;\n    }\n    count\n}",
          "tip": "Write library crates as no_std plus alloc even when you ship a std binary: it costs one extern crate line and buys the crate an embedded future."
        },
        {
          "h": "The binary supplies panic and allocation",
          "p": [
            "A no_std binary needs a panic handler, because core panics through an unresolved lang item that the final crate must define. Libraries do not define one; if two crates in the graph do, the duplicate lang item error tells you a dependency tried to be a binary.",
            "Targets without an OS also need an entry point, and anything that links alloc needs a #[global_allocator]. On bare metal that is usually a fixed static arena or a bump allocator, because there is no malloc. Build for a real target triple instead of the host, or you will be testing a program that never runs on the device."
          ],
          "code": "#![no_std]\n#![no_main]\n\nuse core::panic::PanicInfo;\n\n#[panic_handler]\nfn panic(_info: &PanicInfo) -> ! {\n    // No unwinding, no stderr. Halt, or reset the board.\n    loop {}\n}\n\n#[unsafe(no_mangle)]\npub extern \"C\" fn acme_tick() -> u32 {\n    42\n}\n\n// Build and inspect:\n//   rustup target add thumbv7em-none-eabihf\n//   cargo build --release --target thumbv7em-none-eabihf\n//   cargo tree -e features -i std     # which dependency pulled std in?",
          "list": [
            "The panic handler belongs in the binary, never in a library crate",
            "A global allocator is required the moment anything links alloc",
            "#[unsafe(no_mangle)] is the edition 2024 spelling of #[no_mangle]",
            "cargo tree -e features -i std names the crate that broke your no_std build"
          ]
        },
        {
          "h": "Feature-gate std instead of duplicating",
          "p": [
            "A crate that supports both a std host tool and an embedded build gates std behind a default feature. The crate root uses #![cfg_attr(not(feature = \"std\"), no_std)], and any use of std is compiled only under that feature. Consumers building for a device pass default-features = false.",
            "Unit tests need std, which is a wrinkle: use #![cfg_attr(not(test), no_std)] so cargo test still links the test harness. Then make CI build the crate twice, once with the default features and once with default-features = false on a no_std target, because a feature unification accident in any transitive dependency only shows up in the second build."
          ],
          "code": "# Cargo.toml\n[features]\ndefault = [\"std\"]\nstd = []\n\n[dependencies]\nserde = { version = \"1\", default-features = false, features = [\"derive\"] }\n\n# src/lib.rs\n#![cfg_attr(not(test), no_std)]\n\n#[cfg(feature = \"std\")]\nextern crate std;\n\nextern crate alloc;\n\n#[cfg(feature = \"std\")]\npub fn log_count(count: usize) {\n    std::eprintln!(\"parsed {} frames\", count);\n}\n\n#[cfg(not(feature = \"std\"))]\npub fn log_count(_count: usize) {}\n\n// CI matrix, both legs required:\n//   cargo build\n//   cargo build --no-default-features --target thumbv7em-none-eabihf",
          "tip": "Every dependency needs default-features = false. One dependency that enables std by default quietly defeats the entire exercise."
        },
        {
          "h": "Floats and formatting without std",
          "p": [
            "core has no f32::sqrt, sin, or cos: those are implemented in terms of a system math library that std links and core does not. On a no_std target you either bring in the libm crate, which vendors those routines in pure Rust, or implement a fixed-point approximation and document its error bound next to the function.",
            "Formatting is available, but allocation-free formatting needs a sink. core::fmt::Write writes into any &mut impl fmt::Write, including a small fixed buffer, which is how embedded code produces log lines without a heap. Everything expensive - floating point, dynamic strings, locking - becomes an explicit choice rather than a default."
          ],
          "code": "#![no_std]\n\nextern crate alloc;\n\nuse core::fmt::{self, Write};\nuse libm::sqrtf;\n\n/// Fixed buffer that discards overflow instead of panicking.\nstruct Buf {\n    bytes: [u8; 96],\n    len: usize,\n}\n\nimpl fmt::Write for Buf {\n    fn write_str(&mut self, s: &str) -> fmt::Result {\n        let end = self.len + s.len();\n        if end > self.bytes.len() {\n            return Err(fmt::Error);\n        }\n        self.bytes[self.len..end].copy_from_slice(s.as_bytes());\n        self.len = end;\n        Ok(())\n    }\n}\n\npub fn report(value: f32) -> (usize, f32) {\n    let mut buf = Buf { bytes: [0; 96], len: 0 };\n    // write! is fallible; ignoring overflow is the policy here.\n    let _ = write!(buf, \"sqrt={}\", sqrtf(value));\n    (buf.len, sqrtf(value))\n}",
          "tip": "core::fmt is allocation-free by design. Reach for format! only when you actually have a heap; the fmt::Write trait works everywhere."
        }
      ],
      "exercise": {
        "prompt": "Take a function that currently returns String and make its crate compile with --no-default-features on a no_std target, returning a borrowed &str error message instead of an allocated one.",
        "starter": "// src/lib.rs\n#![cfg_attr(not(test), no_std)]\n\n#[cfg(feature = \"std\")]\nextern crate std;\n\npub fn describe(kind: u8) -> String {\n    match kind {\n        1 => format!(\"ping {}\", 1),\n        _ => String::from(\"unknown\"),\n    }\n}\n\n// 1. remove the allocation from the signature\n// 2. keep the allocating convenience behind cfg(feature = \"std\")\n// 3. prove it builds with --no-default-features",
        "hint": "Return &'static str from describe and add a separate #[cfg(feature = \"std\")] fn describe_owned that maps it into String. Then run cargo build --no-default-features --target thumbv7em-none-eabihf.",
        "solution": "#![cfg_attr(not(test), no_std)]\n\n#[cfg(feature = \"std\")]\nextern crate std;\n\n/// No allocation: the answer is a borrowed static string.\npub fn describe(kind: u8) -> &'static str {\n    match kind {\n        1 => \"ping\",\n        2 => \"pong\",\n        _ => \"unknown\",\n    }\n}\n\n#[cfg(feature = \"std\")]\npub fn describe_owned(kind: u8) -> std::string::String {\n    std::format!(\"frame: {}\", describe(kind))\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn unknown_kind_is_reported() {\n        assert_eq!(describe(9), \"unknown\");\n    }\n}\n\n// Verified with:\n//   cargo test\n//   cargo build --no-default-features --target thumbv7em-none-eabihf"
      },
      "questions": [
        {
          "q": "Which crate must the final binary provide for a no_std program that never allocates?",
          "options": [
            "A panic handler; a global allocator is only needed once alloc is linked",
            "A global allocator; the panic handler is in core",
            "An entry point only; core supplies panic and allocation",
            "Both a panic handler and a global allocator, always"
          ],
          "answer": 0,
          "explain": "core panics through an unresolved lang item, so the final crate must define #[panic_handler]. Allocation is only required by crates that link alloc."
        },
        {
          "q": "Why does a library crate avoid defining #[panic_handler]?",
          "options": [
            "Because only the final binary may define it; a second definition is a duplicate lang item error",
            "Because libraries cannot use the panic macro",
            "Because the handler needs the std prelude",
            "Because a library panic handler is silently ignored"
          ],
          "answer": 0,
          "explain": "The handler is a lang item resolved once per program. A dependency that defines one collides with the application's handler at link time."
        },
        {
          "q": "A dependency silently re-enables std in your embedded build. What is the fastest way to find it?",
          "options": [
            "cargo tree -e features -i std",
            "cargo check --release",
            "cargo metadata --no-deps",
            "cargo doc --no-deps"
          ],
          "answer": 0,
          "explain": "cargo tree with -e features and -i std inverts the tree and lists every crate that depends on std, with the feature edges that enabled it."
        }
      ],
      "quickbytes": [
        "rustup target add thumbv7em-none-eabihf   # then build with --target",
        "cargo tree -e features -i std   # who re-enabled std?",
        "#![cfg_attr(not(test), no_std)] keeps cargo test working.",
        "Every dependency needs default-features = false or feature unification defeats no_std."
      ],
      "production": [
        "CI builds the crate twice: default features on the host, and --no-default-features on a real no_std target triple.",
        "All dependencies declare default-features = false, and cargo tree confirms nothing pulls std into the embedded build.",
        "The panic handler and global allocator live in the binary crate, with a documented behaviour on panic (halt or reset).",
        "Float math and formatting are explicit choices: libm or a documented approximation, and fmt::Write instead of format!."
      ],
      "crates": [
        "libm",
        "heapless"
      ],
      "github": [
        {
          "name": "rust-lang/libm",
          "url": "https://github.com/rust-lang/libm"
        },
        {
          "name": "rust-embedded/heapless",
          "url": "https://github.com/rust-embedded/heapless"
        }
      ],
      "pitfall": "A single dependency left with default features on enables std transitively, and the failure appears as a wall of unresolved std:: paths only in the embedded CI leg, never on the developer machine.",
      "resources": [
        {
          "title": "core: the dependency-free standard library",
          "url": "https://doc.rust-lang.org/core/",
          "kind": "docs"
        },
        {
          "title": "libm: float math for no_std targets",
          "url": "https://docs.rs/libm/latest/libm/",
          "kind": "docs"
        },
        {
          "title": "rust-lang/libm repository",
          "url": "https://github.com/rust-lang/libm",
          "kind": "repo"
        },
        {
          "title": "The Cargo Book: feature unification",
          "url": "https://doc.rust-lang.org/cargo/reference/features.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "r06",
      "title": "Const generics and compile-time capacities",
      "minutes": 65,
      "level": "advanced",
      "goal": "Parameterize types by a value instead of a type, know which const expressions are stable, and pick between const generics, typenum, and a fixed-size crate.",
      "sections": [
        {
          "h": "A value in the type position",
          "p": [
            "A const parameter is a monomorphization key just like a type parameter: Ring<u8, 16> and Ring<u8, 32> are different types, so each gets its own compiled code and its own inlining opportunities. That is the trade: zero runtime capacity field and perfect bounds information, paid for in code size.",
            "Only integer, bool, and char parameters are stable, and the argument must be a const expression, not a runtime value. N is available inside the impl as a value, so [T; N] and modulo arithmetic work directly, and an associated const can expose it to callers. Because N is part of the type, two capacities cannot be mixed in one array without an explicit conversion."
          ],
          "code": "pub struct Ring<T, const N: usize> {\n    slots: [Option<T>; N],\n    head: usize,\n}\n\nimpl<T, const N: usize> Ring<T, N> {\n    pub const CAPACITY: usize = N;\n\n    pub fn new() -> Self {\n        // A zero-capacity ring has no valid index; reject it loudly, once.\n        assert!(N > 0, \"ring capacity must be non-zero\");\n        Self { slots: std::array::from_fn(|_| None), head: 0 }\n    }\n\n    /// Overwrites the oldest slot and returns what it displaced.\n    pub fn push(&mut self, value: T) -> Option<T> {\n        let slot = &mut self.slots[self.head];\n        self.head = (self.head + 1) % N;\n        slot.replace(value)\n    }\n\n    pub fn len(&self) -> usize {\n        self.slots.iter().filter(|slot| slot.is_some()).count()\n    }\n}\n\nfn main() {\n    let mut ring: Ring<u8, 2> = Ring::new();\n    assert_eq!(ring.push(1), None);\n    assert_eq!(ring.push(2), None);\n    assert_eq!(ring.push(3), Some(1)); // capacity is part of the type\n}",
          "tip": "std::array::from_fn is the stable way to build [T; N] for non-Copy T. It needs no unsafe and no MaybeUninit."
        },
        {
          "h": "Const expressions are still unstable",
          "p": [
            "Adding or subtracting const parameters in a type position, as in [u8; N + 4], needs the generic_const_exprs feature and a where clause proving the expression evaluates. It is nightly-only and marked incomplete, so a production crate cannot rely on it. The stable discipline is to make the caller pass the total length, or to store the payload as a slice.",
            "When arithmetic on capacities is unavoidable today, typenum encodes numbers as types and computes with trait-level operators. It is fully stable and costs nothing at runtime, but it makes signatures substantially noisier and error messages much worse than a const parameter."
          ],
          "code": "// NIGHTLY ONLY - requires a nightly toolchain:\n// #![feature(generic_const_exprs)]\n// #![allow(incomplete_features)]\n//\n// struct Packet<const PAYLOAD: usize>\n// where\n//     [(); PAYLOAD + 4]:,\n// {\n//     bytes: [u8; PAYLOAD + 4],\n// }\n\n// Stable alternative: encode the numbers as types.\nuse typenum::{Sum, U12, U4, U8};\n\ntype HeaderLen = U4;\ntype BodyLen = U8;\ntype FrameLen = Sum<HeaderLen, BodyLen>; // U12, resolved during type checking\n\npub fn frame_len() -> usize {\n    <FrameLen as typenum::Unsigned>::USIZE\n}\n\nfn main() {\n    assert_eq!(frame_len(), 12);\n}",
          "list": [
            "Stable: integer, bool and char const parameters, arrays of [T; N]",
            "Nightly: generic_const_exprs, [T; N + 1], arithmetic in type position",
            "typenum: numbers as types, stable, with much noisier signatures",
            "heapless: fixed-capacity Vec and String built on const-sized storage"
          ]
        },
        {
          "h": "Choosing between const generic and runtime capacity",
          "p": [
            "A const capacity is right when the bound is a protocol constant, a buffer size from a header, or a stack budget - facts known at compile time that the optimizer can use to eliminate checks. It is wrong when the size comes from configuration or from a peer on the network, because every capacity becomes a new monomorphization.",
            "Measure the code-size effect before committing. Ten call sites with ten capacities means ten copies of the whole generic pipeline, including any inlined formatting machinery. A common fix is a thin const-generic wrapper over a non-generic inner function that takes a slice, which keeps the fast path and collapses the duplicated code into one body."
          ],
          "code": "/// Const-generic shell: no allocation, size known to the optimizer.\npub fn checksum_frame<const N: usize>(frame: &[u8; N]) -> u32 {\n    checksum_inner(frame)\n}\n\n/// The only compiled copy of the actual algorithm.\nfn checksum_inner(bytes: &[u8]) -> u32 {\n    let mut hash = 0x811c_9dc5u32;\n    for byte in bytes {\n        hash ^= u32::from(*byte);\n        hash = hash.wrapping_mul(0x0100_0193);\n    }\n    hash\n}\n\nfn main() {\n    let header = [0u8; 4];\n    let body = [1u8; 60];\n    assert_ne!(checksum_frame(&header), checksum_frame(&body));\n}",
          "tip": "The const-generic shell is a type-level convenience, not a performance feature. Put the algorithm in one monomorphic function unless you have a benchmark proving otherwise."
        }
      ],
      "exercise": {
        "prompt": "Write a FixedVec<T, const N: usize> that pushes until full, returns Err(value) when it cannot accept more, and never allocates. Expose capacity() as an associated const.",
        "starter": "pub struct FixedVec<T, const N: usize> {\n    items: [Option<T>; N],\n    len: usize,\n}\n\nimpl<T, const N: usize> FixedVec<T, N> {\n    pub fn new() -> Self {\n        todo!()\n    }\n\n    pub fn push(&mut self, value: T) -> Result<(), T> {\n        todo!()\n    }\n\n    pub fn iter(&self) -> impl Iterator<Item = &T> {\n        todo!()\n    }\n}",
        "hint": "Use std::array::from_fn(|_| None). push takes self.items[self.len].replace(value) when len < N and returns Err(value) otherwise. iter returns the filled prefix without unsafe: self.items[..self.len].iter().filter_map(Option::as_ref).",
        "solution": "pub struct FixedVec<T, const N: usize> {\n    items: [Option<T>; N],\n    len: usize,\n}\n\nimpl<T, const N: usize> FixedVec<T, N> {\n    pub const CAPACITY: usize = N;\n\n    pub fn new() -> Self {\n        Self { items: std::array::from_fn(|_| None), len: 0 }\n    }\n\n    pub fn push(&mut self, value: T) -> Result<(), T> {\n        if self.len == N {\n            return Err(value);\n        }\n        self.items[self.len] = Some(value);\n        self.len += 1;\n        Ok(())\n    }\n\n    pub fn len(&self) -> usize {\n        self.len\n    }\n\n    pub fn is_empty(&self) -> bool {\n        self.len == 0\n    }\n\n    pub fn iter(&self) -> impl Iterator<Item = &T> {\n        // No unsafe and no layout assumption: Option<T> is never reinterpreted.\n        self.items[..self.len].iter().filter_map(Option::as_ref)\n    }\n}\n\nfn main() {\n    let mut list: FixedVec<u8, 3> = FixedVec::new();\n    assert_eq!(list.push(1), Ok(()));\n    assert_eq!(list.push(2), Ok(()));\n    assert_eq!(list.push(3), Ok(()));\n    assert_eq!(list.push(4), Err(4));\n    assert_eq!(list.iter().copied().collect::<Vec<_>>(), vec![1, 2, 3]);\n}"
      },
      "questions": [
        {
          "q": "What is the real cost of Ring<T, const N: usize> compared with a runtime capacity field?",
          "options": [
            "One monomorphized copy of the code per distinct N, paid in compile time and binary size",
            "A runtime branch on every push",
            "A heap allocation for the capacity",
            "Nothing: const generics erase N entirely"
          ],
          "answer": 0,
          "explain": "N is part of the type, so the compiler emits a separate instance per value. The runtime capacity field disappears, but code size and compile time grow with the number of distinct values."
        },
        {
          "q": "Which of these compiles on stable Rust today?",
          "options": [
            "struct Packet<const N: usize> { bytes: [u8; N] }",
            "struct Packet<const N: usize> { bytes: [u8; N + 4] } without a where clause",
            "impl<const N: usize> Packet<N> { const LEN: usize = N + 4; } requiring generic const arithmetic",
            "fn make(n: usize) -> Packet<n> { }"
          ],
          "answer": 0,
          "explain": "Array lengths of the form N are stable. Arithmetic on const parameters in type position needs generic_const_exprs on nightly, and runtime values cannot be const arguments."
        },
        {
          "q": "When is typenum the better choice than a const parameter?",
          "options": [
            "When the value must be computed from other values and the computation must stay on stable Rust",
            "When the value is a runtime configuration setting",
            "When the type must be object-safe",
            "When the capacity is larger than 1024"
          ],
          "answer": 0,
          "explain": "typenum performs arithmetic at the type level with stable traits, so Sum<U4, U8> works without nightly features, at the cost of much noisier signatures."
        }
      ],
      "quickbytes": [
        "std::array::from_fn(|_| value) builds [T; N] without unsafe or MaybeUninit.",
        "assert!(N > 0) in the constructor is the stable guard; const blocks cannot inspect generic parameters.",
        "cargo +nightly rustc -- -Zprint-type-sizes   # find the oversized monomorphizations",
        "Every distinct const argument is a new codegen unit input: count them before shipping."
      ],
      "production": [
        "Const parameters are reserved for values fixed by the protocol or the platform, never for configuration read at startup.",
        "Capacity is exposed as an associated const so callers compare sizes without constructing a value.",
        "Generic wrappers delegate to one monomorphic inner function when a benchmark shows code-size growth.",
        "Nightly-only const expression features are kept out of published crates or behind a documented feature."
      ],
      "crates": [
        "typenum",
        "heapless"
      ],
      "github": [
        {
          "name": "paholg/typenum",
          "url": "https://github.com/paholg/typenum"
        },
        {
          "name": "rust-embedded/heapless",
          "url": "https://github.com/rust-embedded/heapless"
        }
      ],
      "pitfall": "Reaching for [u8; N + 4] in a published crate: it compiles only on nightly with generic_const_exprs, so the crate cannot be built by users on stable and the error looks like a missing where clause.",
      "resources": [
        {
          "title": "RFC 2000: const generics",
          "url": "https://rust-lang.github.io/rfcs/2000-const-generics.html",
          "kind": "docs"
        },
        {
          "title": "The Rust Unstable Book: generic_const_exprs",
          "url": "https://doc.rust-lang.org/nightly/unstable-book/language-features/generic-const-exprs.html",
          "kind": "docs"
        },
        {
          "title": "The Rust Reference: generic parameters",
          "url": "https://doc.rust-lang.org/reference/items/generics.html",
          "kind": "docs"
        },
        {
          "title": "typenum: type-level numbers and arithmetic",
          "url": "https://docs.rs/typenum/latest/typenum/",
          "kind": "docs"
        },
        {
          "title": "paholg/typenum repository",
          "url": "https://github.com/paholg/typenum",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "r07",
      "title": "GATs: traits that lend borrowed data",
      "minutes": 75,
      "level": "advanced",
      "goal": "Use generic associated types to return data borrowed from &self, add the Self: 'a bound the compiler demands, and know why that makes the trait undispatchable behind dyn.",
      "sections": [
        {
          "h": "The problem: an item that borrows the iterator",
          "p": [
            "Iterator::Item is fixed by the impl, so it cannot borrow from the iterator itself. That is fine for owned items and for slices of a buffer the iterator does not own, but it cannot express next(&mut self) -> Option<&[u8]>, where the returned slice points into state that the next call will mutate. Before GATs the workarounds were an allocation per item or a lifetime parameter on the trait, which leaked into every user.",
            "A generic associated type moves the lifetime into the associated type: Item<'a>, chosen by the impl for each borrow. Stabilized in Rust 1.65, this is the only way to write a lending iterator, a parser that hands out borrowed frames, or a decoder whose output borrows from the input and from the decoder state at once."
          ],
          "code": "/// A lending iterator: each item may borrow from the iterator itself.\npub trait LendingIterator {\n    type Item<'a>\n    where\n        Self: 'a;\n\n    fn next(&mut self) -> Option<Self::Item<'_>>;\n}\n\npub struct Lines<'s> {\n    rest: &'s str,\n}\n\nimpl<'s> Lines<'s> {\n    pub fn new(text: &'s str) -> Self {\n        Self { rest: text }\n    }\n}\n\nimpl<'s> LendingIterator for Lines<'s> {\n    type Item<'a>\n        = &'a str\n    where\n        Self: 'a;\n\n    fn next(&mut self) -> Option<&str> {\n        let rest = self.rest;\n        if rest.is_empty() {\n            return None;\n        }\n        let end = rest.find('\\n').unwrap_or(rest.len());\n        let line = &rest[..end];\n        self.rest = if end < rest.len() { &rest[end + 1..] } else { \"\" };\n        Some(line)\n    }\n}\n\nfn main() {\n    let mut lines = Lines::new(\"alpha\\nbeta\");\n    assert_eq!(lines.next(), Some(\"alpha\"));\n    assert_eq!(lines.next(), Some(\"beta\"));\n    assert_eq!(lines.next(), None);\n}",
          "tip": "`type Item<'a> = &'a str where Self: 'a` is the whole trick: the where clause ties the borrow lifetime to the implementor's own lifetime."
        },
        {
          "h": "The where Self: 'a bound is load-bearing",
          "p": [
            "Without where Self: 'a the compiler cannot prove the borrow of self can outlive the item, and it rejects the impl with a message about the lifetime not living long enough. The bound says: for this item to borrow self for 'a, the implementor itself must outlive 'a. Every method that uses the GAT then picks the lifetime naturally from &self or &mut self.",
            "This is also why a lending iterator cannot be collected into a Vec: collecting would require all items to coexist while the iterator keeps mutating. Callers process one item at a time with a loop, which is precisely the constraint that makes the API safe. If you need random access, the right type is a borrowed view struct returned once, not an iterator of borrows."
          ],
          "code": "pub trait Cursor {\n    type View<'a>\n    where\n        Self: 'a;\n\n    /// Borrow the next record in place. The view cannot outlive the cursor.\n    fn next_view(&mut self) -> Option<Self::View<'_>>;\n}\n\npub struct Bytes<'b> {\n    buf: &'b [u8],\n    offset: usize,\n}\n\nimpl<'b> Cursor for Bytes<'b> {\n    type View<'a>\n        = &'a [u8]\n    where\n        Self: 'a;\n\n    fn next_view(&mut self) -> Option<&[u8]> {\n        let start = self.offset;\n        if start >= self.buf.len() {\n            return None;\n        }\n        let end = (start + 4).min(self.buf.len());\n        self.offset = end;\n        Some(&self.buf[start..end])\n    }\n}",
          "tip": "Start from the call site you need: if callers must hold two items at once, a GAT iterator is the wrong shape and a single borrowed view type is the right one."
        },
        {
          "h": "GATs cost you dyn, and that is the trade",
          "p": [
            "A trait with an associated type that has generic parameters cannot be made into a trait object: rustc reports E0038, because the vtable cannot contain an unbounded family of item types. The same restriction applies to return-position impl Trait in traits, which is the other borrowing-safe design that stabilized in Rust 1.75.",
            "So there is a fork in the design. Generic plus GAT gives maximum performance and zero allocation at the cost of monomorphization and no dyn. A dyn-compatible design keeps object safety by making the item type concrete - an owned frame, a &'a [u8] with the lifetime on the trait, or an index into an arena - and pays with a copy or a pointer. Choose based on whether the pipeline needs to be configured at runtime."
          ],
          "code": "// Not allowed: E0038, the trait cannot be made into an object.\n//\n//     let boxed: Box<dyn LendingIterator> = Box::new(Lines::new(\"a\"));\n//\n// Keep dyn by making the item type concrete, then dispatch over the source.\npub enum Source<'s> {\n    Lines(Lines<'s>),\n    Whole(&'s str),\n}\n\npub fn count_lines(source: &mut Source<'_>) -> usize {\n    let mut count = 0;\n    loop {\n        let next = match source {\n            Source::Lines(lines) => lines.next(),\n            Source::Whole(rest) => {\n                let taken = if rest.is_empty() { None } else { Some(*rest) };\n                *rest = \"\";\n                taken\n            }\n        };\n        if next.is_none() {\n            return count;\n        }\n        count += 1;\n    }\n}\n\nfn main() {\n    let mut source = Source::Whole(\"one\\ntwo\\nthree\");\n    assert_eq!(count_lines(&mut source), 1);\n    let mut source = Source::Lines(Lines::new(\"one\\ntwo\\nthree\"));\n    assert_eq!(count_lines(&mut source), 3);\n}",
          "list": [
            "GAT method: no allocation, no dyn, one monomorphization per impl",
            "RPITIT (`-> impl Iterator + '_`) is the other borrowing-safe option since 1.75",
            "dyn needs a concrete item type: owned, indexed, or lifetime-parameterized on the trait",
            "A lending iterator cannot be collected; callers must consume items one at a time"
          ]
        }
      ],
      "exercise": {
        "prompt": "Define a trait RecordSource with a GAT Item<'a> that yields &'a [u8] records, implement it for a struct holding a buffer and an offset, and add a method that counts records without allocating.",
        "starter": "pub trait RecordSource {\n    type Item<'a>\n    where\n        Self: 'a;\n\n    fn next_record(&mut self) -> Option<Self::Item<'_>>;\n}\n\npub struct Chunks<'b> {\n    buf: &'b [u8],\n    offset: usize,\n}\n\n// implement RecordSource for Chunks, then add fn count(&mut self) -> usize",
        "hint": "type Item<'a> = &'a [u8] where Self: 'a. next_record slices two bytes at a time and advances offset. count loops on next_record() until None, incrementing a counter.",
        "solution": "pub trait RecordSource {\n    type Item<'a>\n    where\n        Self: 'a;\n\n    fn next_record(&mut self) -> Option<Self::Item<'_>>;\n}\n\npub struct Chunks<'b> {\n    buf: &'b [u8],\n    offset: usize,\n}\n\nimpl<'b> Chunks<'b> {\n    pub fn new(buf: &'b [u8]) -> Self {\n        Self { buf, offset: 0 }\n    }\n\n    pub fn count(&mut self) -> usize {\n        let mut n = 0;\n        while self.next_record().is_some() {\n            n += 1;\n        }\n        n\n    }\n}\n\nimpl<'b> RecordSource for Chunks<'b> {\n    type Item<'a>\n        = &'a [u8]\n    where\n        Self: 'a;\n\n    fn next_record(&mut self) -> Option<&[u8]> {\n        let start = self.offset;\n        if start >= self.buf.len() {\n            return None;\n        }\n        let end = (start + 2).min(self.buf.len());\n        self.offset = end;\n        Some(&self.buf[start..end])\n    }\n}\n\nfn main() {\n    let mut source = Chunks::new(&[1, 2, 3, 4, 5]);\n    assert_eq!(source.count(), 3);\n}"
      },
      "questions": [
        {
          "q": "What does the where Self: 'a clause on a GAT actually promise?",
          "options": [
            "The implementor outlives the borrow lifetime, so the item may borrow from self",
            "The associated type is Sized for every lifetime",
            "The trait is dyn-compatible for that lifetime",
            "The item is Copy for every lifetime"
          ],
          "answer": 0,
          "explain": "The compiler needs to know the borrowed item cannot outlive the value it borrows from. Self: 'a states that the implementor lives at least as long as the borrow, which is what makes next(&mut self) -> Option<&str> check."
        },
        {
          "q": "Why can a lending iterator not be collected into a Vec<Item>?",
          "options": [
            "Because every item borrows the iterator, which keeps mutating, so the borrows cannot coexist",
            "Because GATs do not implement Iterator",
            "Because Vec requires Copy items",
            "Because the compiler cannot monomorphize Item<'a> for a Vec"
          ],
          "answer": 0,
          "explain": "Collecting requires all items alive simultaneously while the source keeps producing, which would alias the mutable state each item borrows from. That is exactly the situation the GAT design forbids."
        },
        {
          "q": "Which statement about a trait with a GAT is true?",
          "options": [
            "It is not dyn-compatible, so Box<dyn Trait> fails with E0038",
            "It is dyn-compatible as long as the GAT has a default",
            "It is dyn-compatible if every method takes &self",
            "It is dyn-compatible only in edition 2024"
          ],
          "answer": 0,
          "explain": "The reference forbids associated types with generic parameters in dyn-compatible traits: a vtable cannot hold an unbounded family of item types. Use an enum or a concrete item type instead."
        }
      ],
      "quickbytes": [
        "error[E0038] plus a GAT means: design an enum or make the item type concrete.",
        "RPITIT (-> impl Iterator + '_) is stable since 1.75 and also not dyn-compatible.",
        "Write the call site first: two items alive at once means an iterator is the wrong API.",
        "GAT impls repeat the where Self: 'a bound; forgetting it produces a lifetime error at the method."
      ],
      "production": [
        "Borrowing traits document whether the item may outlive the call, and every impl repeats the Self: 'a bound.",
        "No GAT-backed trait is exposed as a public dyn-based API without an enum or adapter escape hatch.",
        "Parsers built on lending items process one record per loop iteration; they never collect into a Vec.",
        "New borrowing traits are compared against RPITIT before committing to a GAT, since RPITIT keeps impls simpler."
      ],
      "crates": [
        "bytes",
        "nom"
      ],
      "github": [
        {
          "name": "tokio-rs/bytes",
          "url": "https://github.com/tokio-rs/bytes"
        },
        {
          "name": "rust-bakery/nom",
          "url": "https://github.com/rust-bakery/nom"
        }
      ],
      "pitfall": "Writing a lending iterator and then trying to store Box<dyn LendingIterator> in a struct field: the trait is not dyn-compatible, and the fix is a design change, not a coercion.",
      "resources": [
        {
          "title": "RFC 1598: generic associated types",
          "url": "https://rust-lang.github.io/rfcs/1598-generic_associated_types.html",
          "kind": "docs"
        },
        {
          "title": "The Rust Reference: associated items",
          "url": "https://doc.rust-lang.org/reference/items/associated-items.html",
          "kind": "docs"
        },
        {
          "title": "bytes: refcounted zero-copy buffers",
          "url": "https://docs.rs/bytes/latest/bytes/",
          "kind": "docs"
        },
        {
          "title": "nom 8: parser combinators over borrowed input",
          "url": "https://docs.rs/nom/latest/nom/",
          "kind": "docs"
        },
        {
          "title": "tokio-rs/bytes repository",
          "url": "https://github.com/tokio-rs/bytes",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "r08",
      "title": "dyn dispatch: vtables, dyn compatibility, cost",
      "minutes": 60,
      "level": "advanced",
      "goal": "Explain what a trait object physically is, which traits qualify as dyn-compatible, and when the indirection is worth it over generics.",
      "sections": [
        {
          "h": "A trait object is a fat pointer",
          "p": [
            "&dyn Trait is two words: a data pointer and a pointer to a static vtable of function pointers. Box<dyn Trait> adds a third indirection, because the box is a pointer to the fat pointer's data. Every method call through the vtable is an indirect call, which the CPU may fail to predict and the optimizer cannot inline unless it can prove the concrete type with a devirtualization pass.",
            "That is the entire cost model. One allocation for Box, one indirection per call, no inlining, no generic specialization. What you buy is a single compiled copy of the calling code and the ability to choose the implementation at runtime - a plugin list, a test double, a handler selected from configuration."
          ],
          "code": "pub trait Sink {\n    fn write(&mut self, chunk: &[u8]) -> usize;\n    fn flush(&mut self) -> bool {\n        true\n    }\n}\n\npub struct Counting {\n    total: usize,\n}\n\nimpl Sink for Counting {\n    fn write(&mut self, chunk: &[u8]) -> usize {\n        self.total += chunk.len();\n        chunk.len()\n    }\n}\n\nfn drain(sink: &mut dyn Sink, chunks: &[&[u8]]) -> usize {\n    chunks.iter().map(|chunk| sink.write(chunk)).sum()\n}\n\nfn main() {\n    use std::mem::size_of;\n    assert_eq!(size_of::<&dyn Sink>(), 2 * size_of::<usize>()); // data + vtable\n\n    let mut sink = Counting { total: 0 };\n    assert_eq!(drain(&mut sink, &[b\"ab\", b\"cde\"]), 5);\n\n    let mut boxed: Box<dyn Sink> = Box::new(Counting { total: 0 });\n    assert_eq!(boxed.write(b\"xyz\"), 3); // dispatched through the vtable\n}",
          "tip": "If you need both the concrete type and the trait object, keep the concrete value and pass &mut concrete as &mut dyn Trait; boxing erases the type you still want."
        },
        {
          "h": "Dyn compatibility has a short list of rules",
          "p": [
            "A trait can be turned into a trait object only if none of its members depend on the concrete Self. No generic methods, no method returning Self, no associated constants, no associated types with generic parameters, and the receiver must be one the vtable can supply: self, &self, &mut self, Box<Self>, Rc<Self>, or Arc<Self>.",
            "The escape hatch is where Self: Sized on an individual method, which exempts it from the vtable so the rest of the trait stays dyn-compatible. That is exactly how Iterator<T> keeps next() callable through dyn while generic adapters like map() are excluded. Terminology note: older documentation says object safe; the reference now says dyn-compatible."
          ],
          "code": "pub trait Store {\n    fn get(&self, key: &str) -> Option<u64>;\n    fn len(&self) -> usize;\n\n    // Not in the vtable: callers must know the concrete type.\n    fn merge(self, other: Self) -> Self\n    where\n        Self: Sized;\n\n    // Also exempt: associated functions without a receiver.\n    fn empty() -> Self\n    where\n        Self: Sized;\n}\n\npub struct Memory {\n    entries: Vec<(String, u64)>,\n}\n\nimpl Store for Memory {\n    fn get(&self, key: &str) -> Option<u64> {\n        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| *v)\n    }\n\n    fn len(&self) -> usize {\n        self.entries.len()\n    }\n\n    fn merge(mut self, other: Self) -> Self {\n        self.entries.extend(other.entries);\n        self\n    }\n\n    fn empty() -> Self {\n        Self { entries: Vec::new() }\n    }\n}\n\nfn describe(store: &dyn Store) -> usize {\n    store.len()\n}",
          "tip": "Put the object-safe minimum on the trait and the generic conveniences in extension traits; that keeps dyn usable without giving up combinators."
        },
        {
          "h": "Upcasting and the choice against generics",
          "p": [
            "Since Rust 1.86 a trait object can be upcast to its supertrait object: &dyn Durable coerces to &dyn Store, and the same works for Box, Arc, and raw pointers. Before that, every supertrait needed a hand-written as_store method, which is why older code is full of them.",
            "The decision between generics and dyn is a decision about who picks the type. Generic code is monomorphized per concrete type, inlines everything, and cannot be reconfigured at runtime. dyn code is compiled once, dispatches at runtime, and cannot use generic methods. A common production shape is dyn at the boundary - plugin registration, CLI subcommands - and generics inside the hot loop."
          ],
          "code": "trait Store {\n    fn len(&self) -> usize;\n}\n\ntrait Durable: Store {\n    fn sync(&self) -> bool;\n}\n\nstruct Disk {\n    blocks: usize,\n}\n\nimpl Store for Disk {\n    fn len(&self) -> usize {\n        self.blocks\n    }\n}\n\nimpl Durable for Disk {\n    fn sync(&self) -> bool {\n        true\n    }\n}\n\nfn report(durable: &dyn Durable) -> usize {\n    let store: &dyn Store = durable; // trait upcasting, Rust 1.86\n    store.len()\n}\n\nfn main() {\n    let disk = Disk { blocks: 7 };\n    assert_eq!(report(&disk), 7);\n\n    let boxed: Box<dyn Durable> = Box::new(disk);\n    let base: Box<dyn Store> = boxed; // also works through smart pointers\n    assert_eq!(base.len(), 7);\n}",
          "list": [
            "dyn: one compiled copy, runtime choice, no generic methods, no inlining",
            "generic: one copy per type, full inlining, no runtime choice",
            "Box<dyn Trait> costs an allocation; &dyn Trait costs only the fat pointer",
            "Upcasting to a supertrait object is stable since 1.86"
          ]
        }
      ],
      "exercise": {
        "prompt": "You have a trait Codec with fn encode(&self, input: &[u8]) -> Vec<u8> and a generic method fn encode_into<T: AsRef<[u8]>>(&self, input: T). Make the trait dyn-compatible without losing the generic method.",
        "starter": "pub trait Codec {\n    fn encode(&self, input: &[u8]) -> Vec<u8>;\n\n    fn encode_into<T: AsRef<[u8]>>(&self, input: T) -> Vec<u8> {\n        self.encode(input.as_ref())\n    }\n}\n\n// 1. identify which item breaks dyn compatibility\n// 2. keep it available without putting it in the vtable\n// 3. write a function taking &dyn Codec",
        "hint": "Add where Self: Sized to the generic method, or move it to an extension trait with a blanket impl. Then fn encode_all(codec: &dyn Codec, inputs: &[&[u8]]) compiles.",
        "solution": "pub trait Codec {\n    fn encode(&self, input: &[u8]) -> Vec<u8>;\n\n    // Exempt from the vtable: generic methods cannot be dispatched.\n    fn encode_into<T: AsRef<[u8]>>(&self, input: T) -> Vec<u8>\n    where\n        Self: Sized,\n    {\n        self.encode(input.as_ref())\n    }\n}\n\n/// Extension trait keeps the generic convenience for dyn callers by taking\n/// plain slices, so no monomorphization is needed at the call boundary.\npub trait CodecExt {\n    fn encode_slices(&self, inputs: &[&[u8]]) -> Vec<Vec<u8>>;\n}\n\nimpl<T: Codec + ?Sized> CodecExt for T {\n    fn encode_slices(&self, inputs: &[&[u8]]) -> Vec<Vec<u8>> {\n        inputs.iter().map(|input| self.encode(input)).collect()\n    }\n}\n\npub struct Reverse;\n\nimpl Codec for Reverse {\n    fn encode(&self, input: &[u8]) -> Vec<u8> {\n        input.iter().rev().copied().collect()\n    }\n}\n\nfn main() {\n    let codec: &dyn Codec = &Reverse;\n    assert_eq!(codec.encode_slices(&[b\"ab\", b\"cd\"]), vec![b\"ba\".to_vec(), b\"dc\".to_vec()]);\n}"
      },
      "questions": [
        {
          "q": "How large is &dyn Sink on a 64-bit target?",
          "options": [
            "Two words: a data pointer and a vtable pointer",
            "One word: a pointer to a heap-allocated object",
            "Three words: data, vtable, and a type id",
            "The size of the largest implementor"
          ],
          "answer": 0,
          "explain": "A trait object reference is a fat pointer holding the address of the value and the address of the static vtable. Box<dyn T> adds one more indirection but keeps the two-word fat pointer inside the box."
        },
        {
          "q": "Which method keeps a trait dyn-compatible?",
          "options": [
            "fn merge(self, other: Self) -> Self where Self: Sized",
            "fn merge(self, other: Self) -> Self",
            "fn empty() -> Self",
            "fn encode<T: AsRef<[u8]>>(&self, input: T) -> Vec<u8>"
          ],
          "answer": 0,
          "explain": "where Self: Sized removes the method from the vtable, so the trait stays dyn-compatible. The others either take or return Self without the exemption, or are generic, which the vtable cannot express."
        },
        {
          "q": "What did trait upcasting in Rust 1.86 remove the need for?",
          "options": [
            "Hand-written as_supertrait methods on every upcastable trait",
            "The requirement that supertraits be dyn-compatible",
            "The vtable lookup on supertrait methods",
            "Box for trait objects"
          ],
          "answer": 0,
          "explain": "Coercing &dyn Sub to &dyn Super is now built in for references, Box, Arc and raw pointers, so the manual upcast method that older code carried is no longer necessary."
        }
      ],
      "quickbytes": [
        "error[E0038] names the exact member that breaks dyn compatibility.",
        "Put where Self: Sized on generic or Self-returning methods instead of splitting the trait.",
        "&dyn Trait avoids the allocation that Box<dyn Trait> requires.",
        "cargo asm --lib 'mycrate::hot_path'   # check that the dyn call was actually devirtualized"
      ],
      "production": [
        "Runtime-selected implementations use &dyn or Arc<dyn> at the boundary; hot loops take a generic parameter.",
        "Generic methods on public traits carry where Self: Sized, and the docs say they are unavailable on trait objects.",
        "Box<dyn Trait> is reserved for owned heterogeneous collections; borrowing call sites pass &dyn to avoid the allocation.",
        "Trait objects never appear in a per-item hot path without a benchmark showing the indirect call is irrelevant."
      ],
      "crates": [
        "dyn-clone",
        "thiserror"
      ],
      "github": [
        {
          "name": "dtolnay/dyn-clone",
          "url": "https://github.com/dtolnay/dyn-clone"
        }
      ],
      "pitfall": "Adding one generic method to a public trait that callers already use as Box<dyn Trait>: the trait stops being dyn-compatible and every downstream trait object fails to compile with E0038.",
      "resources": [
        {
          "title": "The Rust Reference: dyn compatibility",
          "url": "https://doc.rust-lang.org/reference/items/traits.html",
          "kind": "docs"
        },
        {
          "title": "The Rust Reference: trait object types",
          "url": "https://doc.rust-lang.org/reference/types/trait-object.html",
          "kind": "docs"
        },
        {
          "title": "dyn-clone: cloneable trait objects",
          "url": "https://docs.rs/dyn-clone/latest/dyn_clone/",
          "kind": "docs"
        },
        {
          "title": "dtolnay/dyn-clone repository",
          "url": "https://github.com/dtolnay/dyn-clone",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "r09",
      "title": "Variance: why &mut T is invariant",
      "minutes": 65,
      "level": "advanced",
      "goal": "Read a variance off a type's fields, explain the Cell argument for invariance, and choose PhantomData so a wrapper has the variance you intend.",
      "sections": [
        {
          "h": "Lifetimes are the subtyping relation",
          "p": [
            "Rust has exactly one subtyping relation: a longer lifetime is a subtype of a shorter one. &'static str can be used wherever &'a str is expected, because the value is valid for longer than required. A type constructor is covariant in a parameter when it preserves that order, and that is what lets coercion happen silently at call sites and in struct literals.",
            "Covariance is not a language rule you memorize; it is computed from the fields. A struct is covariant in its lifetime if every field is, so &'a T, Box<T>, Vec<T>, and PhantomData<T> are all covariant. That is why returning &'a str from a function that received &'a str always type-checks without annotations."
          ],
          "code": "fn longest<'a>(a: &'a str, b: &'a str) -> &'a str {\n    if a.len() >= b.len() { a } else { b }\n}\n\nfn config() -> &'static str {\n    \"compiled-in default\"\n}\n\nfn main() {\n    let owned = String::from(\"runtime value\");\n    // &'static str coerces to &'a str: covariance in the lifetime.\n    let picked = longest(config(), &owned);\n    assert_eq!(picked, \"runtime value\");\n\n    let static_ref: &'static str = \"forever\";\n    let short_ref: &str = static_ref;\n    assert_eq!(short_ref.len(), 7);\n}",
          "tip": "If a coercion compiles without a cast, the constructor is covariant. If it demands an explicit reborrow, something in the type is invariant or contravariant."
        },
        {
          "h": "Invariance: the Cell argument",
          "p": [
            "&'a mut T is invariant in T. If it were covariant, you could assign a short-lived value through a long-lived mutable reference: shorten a &'static str slot to hold a reference into a stack frame that has already ended, and the long-lived alias now dangles. Interior mutability has the same hazard through a shared reference, so Cell<T>, RefCell<T>, Mutex<T>, and UnsafeCell<T> are all invariant in T.",
            "Function arguments are the third case: fn(T) is contravariant in T, because a function that accepts a long-lived reference can be used where one accepting a short-lived reference is expected. The practical rule is to reason per field: immutable borrow and ownership are covariant, mutable and interior-mutability positions are invariant, argument positions are contravariant."
          ],
          "code": "use std::cell::Cell;\nuse std::marker::PhantomData;\n\n/// Covariant in T, like `fn() -> T`.\npub struct Producer<T> {\n    make: fn() -> T,\n    _variance: PhantomData<fn() -> T>,\n}\n\n/// Contravariant in T, like `fn(T)`.\npub struct Consumer<T> {\n    take: fn(T),\n    _variance: PhantomData<fn(T)>,\n}\n\n/// Invariant in T, like `Cell<T>`: the slot is written through &self.\npub struct Slot<T> {\n    inner: Cell<Option<T>>,\n    _variance: PhantomData<Cell<T>>,\n}\n\nfn main() {\n    let producer = Producer { make: || \"static\", _variance: PhantomData };\n    // Covariance: Producer<&'static str> is a Producer<&str>.\n    let shorter: Producer<&str> = producer;\n    assert_eq!((shorter.make)(), \"static\");\n\n    let slot: Slot<&'static str> = Slot { inner: Cell::new(None), _variance: PhantomData };\n    // Invariance: this line would not compile.\n    // let wider: &Slot<&str> = &slot;\n    let _ = slot;\n}",
          "list": [
            "&'a T, Box<T>, Vec<T>, PhantomData<T>: covariant",
            "&'a mut T, Cell<T>, RefCell<T>, UnsafeCell<T>: invariant",
            "fn(T) is contravariant in T; fn() -> T is covariant",
            "PhantomData<fn(T)> makes a wrapper contravariant without storing a T"
          ]
        },
        {
          "h": "PhantomData is a variance declaration",
          "p": [
            "An unused type parameter is an error, and PhantomData is how you say what the wrapper would have contained. Its argument chooses the variance: PhantomData<T> covariant, PhantomData<&'a mut T> invariant, PhantomData<fn(T)> contravariant. It also affects auto traits and drop check, so the choice is not cosmetic.",
            "Drop check is the second effect. A value with a Drop impl may read its fields while dying, so the compiler requires every generic parameter to strictly outlive the value - Observable auto trait behaviour that PhantomData does not change. The unstable #[may_dangle] attribute is how std's Vec can drop without that requirement. If a wrapper starts rejecting programs that look fine, look at PhantomData and Drop before blaming the borrow checker."
          ],
          "code": "use std::marker::PhantomData;\n\n/// Owns nothing, but behaves as if it held a `&'a T`.\npub struct Token<'a, T> {\n    id: u32,\n    _brand: PhantomData<&'a T>,\n}\n\nimpl<'a, T> Token<'a, T> {\n    pub fn new(id: u32) -> Self {\n        Self { id, _brand: PhantomData }\n    }\n\n    pub fn id(&self) -> u32 {\n        self.id\n    }\n}\n\n/// A mutable brand: invariant, so a Token cannot be widened to a longer life.\npub struct MutToken<'a, T> {\n    id: u32,\n    _brand: PhantomData<&'a mut T>,\n}\n\nfn main() {\n    let token: Token<'static, u8> = Token::new(7);\n    // Covariant: the static token is usable at any shorter lifetime.\n    let short: Token<'_, u8> = token;\n    assert_eq!(short.id(), 7);\n\n    let mut_token: MutToken<'static, u8> = MutToken { id: 9, _brand: PhantomData };\n    let _ = mut_token; // not widened: PhantomData<&'a mut T> is invariant\n}",
          "tip": "When a zero-sized brand type must not be interchangeable across lifetimes, use PhantomData<&'a mut T>; when it must be freely shortened, use PhantomData<&'a T>."
        }
      ],
      "exercise": {
        "prompt": "A wrapper struct Buffer<'a> holds a &'a [u8] plus a PhantomData<Cell<&'a [u8]>>. Explain what the variance of Buffer in 'a is, then change it so Buffer<'static> can be used where Buffer<'short> is expected.",
        "starter": "use std::cell::Cell;\nuse std::marker::PhantomData;\n\npub struct Buffer<'a> {\n    bytes: &'a [u8],\n    _cache: PhantomData<Cell<&'a [u8]>>,\n}\n\n// 1. state the variance caused by Cell\n// 2. pick a marker that makes the struct covariant\n// 3. show the coercion compiling",
        "hint": "Cell<&'a [u8]> is invariant in 'a, so Buffer is invariant and no coercion is possible. Replace the marker with PhantomData<&'a [u8]>: now every field is covariant and Buffer<'static> coerces to Buffer<'short>.",
        "solution": "use std::marker::PhantomData;\n\n/// Covariant in 'a: every field only reads through a shared borrow.\npub struct Buffer<'a> {\n    bytes: &'a [u8],\n    len: usize,\n    // No interior mutability, so no invariance: this marker is covariant.\n    _mark: PhantomData<&'a [u8]>,\n}\n\nimpl<'a> Buffer<'a> {\n    pub fn new(bytes: &'a [u8]) -> Self {\n        Self { bytes, len: bytes.len(), _mark: PhantomData }\n    }\n\n    pub fn len(&self) -> usize {\n        self.len\n    }\n}\n\nfn consume<'short>(buffer: Buffer<'short>) -> usize {\n    buffer.len()\n}\n\nfn main() {\n    static BYTES: &[u8] = b\"static data\";\n    let long: Buffer<'static> = Buffer::new(BYTES);\n\n    // Covariance lets a 'static buffer satisfy a shorter lifetime.\n    assert_eq!(consume(long), 11);\n}"
      },
      "questions": [
        {
          "q": "Why is &'a mut T invariant in T?",
          "options": [
            "Because covariance would let a short-lived reference be stored through a long-lived mutable slot",
            "Because mutable references cannot be copied",
            "Because T may be unsized",
            "Because mutable references have no niche optimisation"
          ],
          "answer": 0,
          "explain": "If &'a mut &'long T accepted a &'short T, the long-lived slot would hold a dangling reference after the short frame ended. Invariance blocks the coercion that would make that possible."
        },
        {
          "q": "Which marker makes a wrapper invariant in 'a without storing anything?",
          "options": [
            "PhantomData<Cell<&'a ()>>",
            "PhantomData<&'a ()>",
            "PhantomData<fn() -> &'a ()>",
            "PhantomData<fn(&'a ())>"
          ],
          "answer": 0,
          "explain": "Cell<T> is invariant in T, so Cell<&'a ()> is invariant in 'a. The shared reference and the return position are covariant; fn(&'a ()) is contravariant."
        },
        {
          "q": "A covariant wrapper suddenly rejects code that used to compile after you add a Drop impl. Why?",
          "options": [
            "Drop check requires generic parameters to strictly outlive the value, because drop may read them",
            "Drop makes the type invariant in every parameter",
            "Drop removes the Copy impl",
            "Drop forces the type to be Send"
          ],
          "answer": 0,
          "explain": "A type with Drop may touch its fields while dying, so the compiler requires the parameters to outlive the value. std uses the unstable #[may_dangle] to opt out where the drop provably does not read them."
        }
      ],
      "quickbytes": [
        "Covariance appears as a silent coercion; invariance appears as a confusing lifetime error.",
        "Interior mutability is the usual cause: Cell, RefCell, Mutex, UnsafeCell are invariant.",
        "PhantomData<&'a mut T> is how you opt into invariance deliberately.",
        "Adding Drop can break callers through drop check even when the variance is unchanged."
      ],
      "production": [
        "Every PhantomData marker is chosen for its variance and auto-trait effect, with a comment saying which one is intended.",
        "Public wrapper types are documented as covariant or invariant in their lifetime parameter, since callers rely on the coercion behaviour.",
        "A new Drop impl on a public generic type is treated as a possible breaking change and reviewed against drop check.",
        "Interior mutability is confined to the smallest possible field so invariance does not spread across the whole API."
      ],
      "crates": [
        "ghost",
        "static_assertions"
      ],
      "github": [
        {
          "name": "dtolnay/ghost",
          "url": "https://github.com/dtolnay/ghost"
        }
      ],
      "pitfall": "Dropping a Cell into a struct that was previously covariant, or adding a Drop impl, silently removes coercions that callers depend on; the break surfaces as a lifetime error in downstream code, not in yours.",
      "resources": [
        {
          "title": "The Rust Reference: subtyping and variance",
          "url": "https://doc.rust-lang.org/reference/subtyping.html",
          "kind": "docs"
        },
        {
          "title": "The Rustonomicon: subtyping and variance",
          "url": "https://doc.rust-lang.org/nomicon/subtyping.html",
          "kind": "docs"
        },
        {
          "title": "The Rustonomicon: PhantomData",
          "url": "https://doc.rust-lang.org/nomicon/phantom-data.html",
          "kind": "docs"
        },
        {
          "title": "ghost: declare the variance you want",
          "url": "https://docs.rs/ghost/latest/ghost/",
          "kind": "docs"
        },
        {
          "title": "dtolnay/ghost repository",
          "url": "https://github.com/dtolnay/ghost",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "r10",
      "title": "Pin: keeping self-references valid",
      "minutes": 80,
      "level": "advanced",
      "goal": "Explain why a move breaks a self-referential value, use Pin<Box<T>> with PhantomPinned to forbid it, and project pinned fields without writing unsafe by hand.",
      "sections": [
        {
          "h": "A move is a memcpy, and pointers do not follow",
          "p": [
            "Rust moves by copying bytes and forgetting the source. For most values that is irrelevant, but a struct that stores a pointer to one of its own fields breaks the moment it moves: the pointer still points at the old address, which now holds a different value or nothing at all. Safe Rust cannot even build such a struct, because the borrow checker refuses a field that borrows a sibling.",
            "Pin is the escape hatch. It is not a field attribute and it does not freeze memory; it is a pointer wrapper whose contract says the pointee will not be moved again until it is dropped. Pin<Box<T>> allocates once and then guarantees that address for the life of the box, which is enough to hold self-referential pointers safely."
          ],
          "code": "use std::marker::PhantomPinned;\nuse std::pin::Pin;\nuse std::ptr;\n\npub struct SelfRef {\n    data: String,\n    ptr: *const String,\n    _pin: PhantomPinned, // makes SelfRef !Unpin\n}\n\nimpl SelfRef {\n    pub fn new(data: String) -> Pin<Box<Self>> {\n        let mut boxed = Box::pin(Self { data, ptr: ptr::null(), _pin: PhantomPinned });\n        // SAFETY: the value lives in this box and is never moved out of it.\n        let this = unsafe { boxed.as_mut().get_unchecked_mut() };\n        this.ptr = &this.data;\n        boxed\n    }\n\n    pub fn data(&self) -> &str {\n        // SAFETY: ptr was set in new() and the pointee has not moved since.\n        unsafe { &*self.ptr }.as_str()\n    }\n}\n\nfn main() {\n    let pinned = SelfRef::new(\"stable\".to_string());\n    assert_eq!(pinned.data(), \"stable\");\n    let moved = pinned; // moving the Pin is fine: the pointee did not move\n    assert_eq!(moved.data(), \"stable\");\n}",
          "tip": "PhantomPinned is the whole trick behind !Unpin: a zero-sized field that tells the compiler this type must never be assumed movable."
        },
        {
          "h": "Unpin is the opt-out, and most types have it",
          "p": [
            "Unpin is an auto trait implemented for almost everything, and it means moving is harmless. Pin<P> only restricts you for !Unpin types: get_mut exists when T: Unpin, and Pin::new refuses a !Unpin value entirely. That is why ordinary structs work with Pin without ceremony and why a self-referential type needs a marker field to opt out.",
            "Pin::new_unchecked is where the proof lives. Its contract has two parts: the pointee is never moved again while pinned, and for a type with Drop, the destructor runs before the memory is reused. Violating the second one is the subtle case - a Drop impl that moves a field out of a pinned struct invalidates every pointer into it, which is why pinning is structural, not shallow."
          ],
          "code": "use std::pin::{pin, Pin};\n\n#[derive(Debug)]\nstruct Config {\n    name: String,\n}\n\nfn main() {\n    // Config is Unpin, so Pin<&mut Config> still hands out &mut Config.\n    let mut config = Config { name: \"edge\".to_string() };\n    let pinned = Pin::new(&mut config);\n    pinned.get_mut().name.push_str(\"-eu\");\n\n    // pin! keeps the value on the stack and shadows the binding that could\n    // move it. Stable since 1.68; no Box, no allocation.\n    let mut value = pin!(Config { name: \"stack\".to_string() });\n    value.as_mut().get_mut().name.push_str(\"-1\");\n    println!(\"{} {}\", config.name, value.name);\n}",
          "list": [
            "T: Unpin means moving is fine; you get get_mut back",
            "PhantomPinned opts a type out of Unpin",
            "Pin<Box<T>> is the stable way to pin on the heap",
            "pin! pins a local on the stack without allocating (1.68)"
          ]
        },
        {
          "h": "Project with pin-project, not with unsafe",
          "p": [
            "An async state machine needs to pin some fields and borrow others mutably. Writing that projection by hand means get_unchecked_mut plus a written argument that you only ever touch unpinned fields through safe references. pin-project derives exactly that code, including the conditional Unpin impl that stays correct when a pinned field is itself !Unpin.",
            "The attribute is a promise: #[pin] on a field means the projection hands out Pin<&mut Field>, and you must never move that field. The generator enforces the rest - Drop on a #[pin_project] type is rejected, because dropping would move the pinned fields. When you only need the projection and no Drop, pin-project-lite does the same with a macro instead of a derive."
          ],
          "code": "use pin_project::pin_project;\nuse std::future::Future;\nuse std::pin::Pin;\nuse std::task::{Context, Poll};\n\n#[pin_project]\nstruct CountPolls<F> {\n    #[pin]\n    inner: F, // the future is pinned, so poll can use Pin<&mut F>\n    polls: usize,\n}\n\nimpl<F: Future> Future for CountPolls<F> {\n    type Output = F::Output;\n\n    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<F::Output> {\n        let this = self.project();\n        *this.polls += 1; // plain &mut usize\n        this.inner.poll(cx) // Pin<&mut F>\n    }\n}\n\nfn main() {\n    let mut future = CountPolls { inner: std::future::ready(7u8), polls: 0 };\n    let mut cx = Context::from_waker(std::task::Waker::noop());\n    let pinned = Pin::new(&mut future);\n    assert_eq!(pinned.poll(&mut cx), Poll::Ready(7));\n}",
          "tip": "Waker::noop() is stable since 1.85 and gives you a Context for tests without building an executor."
        }
      ],
      "exercise": {
        "prompt": "Build a PinnedBox<T> that stores both a value and a pointer to it, is created with Box::pin, and returns &T through the pointer. It must refuse to compile if someone tries to get a &mut out of it.",
        "starter": "use std::marker::PhantomPinned;\nuse std::pin::Pin;\n\npub struct PinnedBox<T> {\n    value: T,\n    ptr: *const T,\n    _pin: PhantomPinned,\n}\n\nimpl<T> PinnedBox<T> {\n    pub fn new(value: T) -> Pin<Box<Self>> {\n        todo!()\n    }\n\n    pub fn get(&self) -> &T {\n        todo!()\n    }\n}",
        "hint": "Box::pin a struct with a null ptr, then use as_mut().get_unchecked_mut() once inside unsafe to set ptr = &this.value. get() dereferences the raw pointer inside unsafe. There is no method returning &mut T, so callers cannot move the value out.",
        "solution": "use std::marker::PhantomPinned;\nuse std::pin::Pin;\nuse std::ptr;\n\npub struct PinnedBox<T> {\n    value: T,\n    ptr: *const T,\n    _pin: PhantomPinned,\n}\n\nimpl<T> PinnedBox<T> {\n    pub fn new(value: T) -> Pin<Box<Self>> {\n        let mut boxed = Box::pin(Self { value, ptr: ptr::null(), _pin: PhantomPinned });\n        // SAFETY: the value is inside this box and is never moved out, so the\n        // address taken here stays valid until the box is dropped.\n        let this = unsafe { boxed.as_mut().get_unchecked_mut() };\n        this.ptr = &this.value;\n        boxed\n    }\n\n    pub fn get(&self) -> &T {\n        // SAFETY: ptr is set in new() and never invalidated while pinned.\n        unsafe { &*self.ptr }\n    }\n}\n\nfn main() {\n    let pinned = PinnedBox::new(String::from(\"hello\"));\n    assert_eq!(pinned.get().as_str(), \"hello\");\n    let moved = pinned; // the Box moves, the String does not\n    assert_eq!(moved.get().as_str(), \"hello\");\n}"
      },
      "questions": [
        {
          "q": "What does Pin<P> actually guarantee?",
          "options": [
            "The pointee will not be moved again before it is dropped",
            "The pointee is allocated on the heap",
            "The pointee is immutable",
            "The pointee cannot be accessed without unsafe"
          ],
          "answer": 0,
          "explain": "Pin is a contract about movement, not about allocation or mutation. Pin<&mut T> gives you &mut T whenever T: Unpin, and Pin<Box<T>> can be built for any T."
        },
        {
          "q": "Why does a self-referential struct need PhantomPinned?",
          "options": [
            "To opt out of the Unpin auto trait so Pin actually restricts moves",
            "To make the struct Send",
            "To give the struct a stable address on the stack",
            "To allow the raw pointer field to exist"
          ],
          "answer": 0,
          "explain": "Nearly every type is Unpin, and Unpin means Pin::get_mut can move the value out. PhantomPinned removes that escape so pinning is meaningful."
        },
        {
          "q": "Why does #[pin_project] reject a type that also implements Drop?",
          "options": [
            "Because Drop could move a pinned field, invalidating pointers into it",
            "Because Drop requires T: Unpin",
            "Because Drop cannot be generated twice",
            "Because pin-project needs to implement Drop itself for bookkeeping"
          ],
          "answer": 0,
          "explain": "The drop guarantee says the destructor runs before the memory is reused, and a destructor that moves pinned fields breaks every self-reference. pin-project refuses rather than generate unsound code."
        }
      ],
      "quickbytes": [
        "Pin::new requires T: Unpin; use Box::pin or pin! for !Unpin types.",
        "Waker::noop() + Context::from_waker gives a test context since 1.85.",
        "Pin::set is the documented way to move a value while pinned - a bug in async code if you reach for it.",
        "If a future holds a self-reference, pin it at the outermost layer, not inside a helper struct."
      ],
      "production": [
        "Self-referential types are constructed only through Pin<Box<T>> and expose no API that returns &mut T.",
        "Pinned structs use pin-project or pin-project-lite rather than hand-written get_unchecked_mut projections.",
        "Every unsafe projection carries a SAFETY comment about the drop guarantee, not just about the current call.",
        "Async code that needs a pinned field is restructured so the pinned layer is at the top of the future, not nested inside a movable struct."
      ],
      "crates": [
        "pin-project",
        "pin-project-lite",
        "futures"
      ],
      "github": [
        {
          "name": "taiki-e/pin-project",
          "url": "https://github.com/taiki-e/pin-project"
        },
        {
          "name": "rust-lang/futures-rs",
          "url": "https://github.com/rust-lang/futures-rs"
        }
      ],
      "pitfall": "Adding a Drop impl to a #[pin_project] type or moving a field out of a pinned struct: the pointers that made it self-referential now dangle, and nothing in the compiler complains at the move site.",
      "resources": [
        {
          "title": "std::pin: types that pin data to a location",
          "url": "https://doc.rust-lang.org/std/pin/index.html",
          "kind": "docs"
        },
        {
          "title": "std::pin::Pin API and the drop guarantee",
          "url": "https://doc.rust-lang.org/std/pin/struct.Pin.html",
          "kind": "docs"
        },
        {
          "title": "pin-project: safe structural pinning",
          "url": "https://docs.rs/pin-project/latest/pin_project/",
          "kind": "docs"
        },
        {
          "title": "taiki-e/pin-project repository",
          "url": "https://github.com/taiki-e/pin-project",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "r11",
      "title": "Async internals: poll, wakers, and cancellation",
      "minutes": 90,
      "level": "advanced",
      "goal": "Implement a Future by hand, wire a waker to an executor loop, and reason about what dropping a half-finished future actually cancels.",
      "sections": [
        {
          "h": "The poll contract in three rules",
          "p": [
            "A future is a state machine with one method: poll takes Pin<&mut Self> and a Context, and returns Poll::Ready(value) or Poll::Pending. The contract has three parts. First, once it returns Ready it must not be polled again, and many futures panic if you do. Second, when returning Pending it must have arranged for the current task to be woken, usually by cloning and storing the waker. Third, a future may be polled again spuriously, so a poll must be idempotent until it makes progress.",
            "The waker is the whole scheduling interface. The executor gives the future a handle that, when woken, puts the task back on the run queue. Everything else - tokio's io driver, timers, channels - is machinery for calling waker.wake at the right moment. If you return Pending without registering, the task is lost: it will never be polled again and there is no error, just a request that hangs."
          ],
          "code": "use std::future::Future;\nuse std::pin::Pin;\nuse std::task::{Context, Poll, Waker};\n\n/// Yields Pending exactly once, then returns the value.\npub struct YieldOnce<T> {\n    value: Option<T>,\n    yielded: bool,\n}\n\nimpl<T> Future for YieldOnce<T> {\n    type Output = T;\n\n    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<T> {\n        // SAFETY: neither field is moved; the value is taken out once.\n        let this = unsafe { self.get_unchecked_mut() };\n        if this.yielded {\n            let value = this.value.take().expect(\"polled after completion\");\n            return Poll::Ready(value);\n        }\n        this.yielded = true;\n        cx.waker().wake_by_ref(); // schedule the next poll before returning\n        Poll::Pending\n    }\n}\n\nfn main() {\n    let waker = Waker::noop();\n    let mut cx = Context::from_waker(waker);\n    let mut future = Box::pin(YieldOnce { value: Some(5), yielded: false });\n    assert!(future.as_mut().poll(&mut cx).is_pending());\n    assert_eq!(future.as_mut().poll(&mut cx), Poll::Ready(5));\n}",
          "tip": "Waker::noop() is stable since 1.85 and removes the need to hand-build a RawWakerVTable in tests."
        },
        {
          "h": "An executor is a loop and a queue",
          "p": [
            "An executor owns a run queue of tasks, polls each ready task once, and parks the thread when the queue is empty. Each task holds its future, and the waker handed to that future carries a pointer back to the task so wake can push it onto the queue. That is the entire architecture; tokio's complexity is in the work-stealing queue and the io and timer drivers, not in the poll loop.",
            "The version below is a correct but deliberately naive executor: its waker does nothing, so it busy-loops with yield_now. It is useful precisely because it makes the contract visible - a future that never wakes still finishes here, which is why this executor would burn a core in production and why real ones park the thread on a condvar or epoll."
          ],
          "code": "use std::future::Future;\nuse std::sync::Arc;\nuse std::task::{Context, Poll, Wake, Waker};\n\nstruct SpinWaker;\n\nimpl Wake for SpinWaker {\n    fn wake(self: Arc<Self>) {}\n}\n\n/// Polls a single future until completion. The waker does nothing, so this\n/// terminates only because the loop re-polls unconditionally. Never ship it.\npub fn block_on<F: Future>(future: F) -> F::Output {\n    let waker: Waker = Waker::from(Arc::new(SpinWaker));\n    let mut cx = Context::from_waker(&waker);\n    let mut future = Box::pin(future);\n\n    loop {\n        match future.as_mut().poll(&mut cx) {\n            Poll::Ready(value) => return value,\n            Poll::Pending => std::thread::yield_now(),\n        }\n    }\n}\n\nfn main() {\n    assert_eq!(block_on(async { 6 * 7 }), 42);\n}",
          "list": [
            "A waker holding a task pointer is what turns wake() into a queue push",
            "Real executors park the thread between wakes; a spinning waker burns a core",
            "spawn requires Send + 'static; !Send futures need a LocalSet",
            "Blocking work belongs in spawn_blocking, never inside an async task"
          ]
        },
        {
          "h": "Cancellation is drop, and it can happen anywhere",
          "p": [
            "Dropping a future is cancellation. The state machine is deallocated at whatever await point it reached, and any partial work is discarded. That is why every await point is a potential inconsistency: dropping a future between taking an item from a queue and writing it to the database loses the item, and the caller never sees an error.",
            "The discipline is cancel safety per await point. Receiving from a channel is cancel-safe because nothing is consumed unless the receive completed. Writing a request and awaiting the reply is not: a tokio::select! that loses the race leaves a request in flight with no correlation. When an operation is not cancel-safe, run it in a spawned task that owns the whole operation and let cancellation detach the task rather than abandon it half-way."
          ],
          "code": "use std::time::Duration;\nuse tokio::time::sleep;\n\n/// Takes whole seconds to finish; safe to await to completion.\nasync fn write_record(record: u64) -> Result<(), String> {\n    sleep(Duration::from_millis(5)).await;\n    if record == 0 {\n        return Err(\"record 0 is reserved\".to_string());\n    }\n    Ok(())\n}\n\n#[tokio::main]\nasync fn main() {\n    // A spawned task is detached from the select! branch below: losing the\n    // race drops the branch future, not the work already in flight.\n    let handle = tokio::spawn(async { write_record(1).await });\n\n    tokio::select! {\n        result = handle => {\n            assert_eq!(result.expect(\"task panicked\"), Ok(()));\n        }\n        _ = sleep(Duration::from_millis(50)) => {\n            panic!(\"the write should have finished first\");\n        }\n    }\n\n    let spawned = tokio::spawn(async { 6 * 7 });\n    assert_eq!(spawned.await.unwrap(), 42);\n}",
          "tip": "If an operation must not be abandoned half-way, spawn it and await the JoinHandle; dropping the handle detaches the task instead of cancelling it."
        }
      ],
      "exercise": {
        "prompt": "Implement a future ReadyOnce that returns Pending on the first poll and wakes itself, then returns its value on the second poll. Then write a block_on loop with a no-op waker that drives it to completion.",
        "starter": "use std::future::Future;\nuse std::pin::Pin;\nuse std::task::{Context, Poll};\n\npub struct ReadyOnce<T> {\n    value: Option<T>,\n    first: bool,\n}\n\nimpl<T> Future for ReadyOnce<T> {\n    type Output = T;\n    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<T> {\n        todo!()\n    }\n}",
        "hint": "On the first poll set first = true, call cx.waker().wake_by_ref(), return Poll::Pending. On the second take the value and return Ready. Get &mut self with get_unchecked_mut inside unsafe, or store the state in a Cell to avoid unsafe entirely.",
        "solution": "use std::future::Future;\nuse std::pin::Pin;\nuse std::sync::Arc;\nuse std::task::{Context, Poll, Wake, Waker};\n\npub struct ReadyOnce<T> {\n    value: Option<T>,\n    first: bool,\n}\n\nimpl<T> Future for ReadyOnce<T> {\n    type Output = T;\n\n    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<T> {\n        // SAFETY: nothing is moved except `value`, taken exactly once.\n        let this = unsafe { self.get_unchecked_mut() };\n        if this.first {\n            return Poll::Ready(this.value.take().expect(\"polled after completion\"));\n        }\n        this.first = true;\n        cx.waker().wake_by_ref();\n        Poll::Pending\n    }\n}\n\nstruct SpinWaker;\n\nimpl Wake for SpinWaker {\n    fn wake(self: Arc<Self>) {}\n}\n\nfn block_on<F: Future>(future: F) -> F::Output {\n    let waker: Waker = Waker::from(Arc::new(SpinWaker));\n    let mut cx = Context::from_waker(&waker);\n    let mut future = Box::pin(future);\n    loop {\n        match future.as_mut().poll(&mut cx) {\n            Poll::Ready(value) => return value,\n            Poll::Pending => std::thread::yield_now(),\n        }\n    }\n}\n\nfn main() {\n    let outcome = block_on(ReadyOnce { value: Some(9), first: false });\n    assert_eq!(outcome, 9);\n}"
      },
      "questions": [
        {
          "q": "A future returns Poll::Pending without arranging a wake. What happens?",
          "options": [
            "The task is never polled again and the request hangs silently",
            "The executor polls it again immediately",
            "The future panics with a diagnostic",
            "The task is cancelled and the JoinHandle returns an error"
          ],
          "answer": 0,
          "explain": "The waker is the only signal that work can progress. Without it the executor parks waiting on nothing; there is no timeout, no error, and no log line unless poll counts are instrumented."
        },
        {
          "q": "Why is dropping a future equivalent to cancelling it?",
          "options": [
            "Because the state machine is deallocated at its current await point and partial work is discarded",
            "Because Drop runs a cancellation hook on the runtime",
            "Because the future's output becomes None",
            "Because the runtime sends a cancel signal to the underlying IO"
          ],
          "answer": 0,
          "explain": "A future is a state machine, and dropping it frees the state. Work already performed stays done, which is why each await point has to be checked for cancel safety."
        },
        {
          "q": "Which operation is safe to put inside a tokio::select! branch?",
          "options": [
            "Receiving one message from a channel, where nothing is consumed unless the receive completes",
            "Sending a request and awaiting its response from a remote service",
            "A multi-step database transaction spread across two awaits",
            "Reading a file across two await points with a cursor held between them"
          ],
          "answer": 0,
          "explain": "A channel receive is cancel-safe: losing the race leaves the message in the channel. The others leave partial state or an in-flight request when the branch future is dropped."
        }
      ],
      "quickbytes": [
        "A future that panics on the second poll is telling you the state machine contract was violated.",
        "cargo expand shows an async fn desugared into its state machine.",
        "spawn needs Send + 'static; use a LocalSet for !Send futures.",
        "Wrap blocking calls in spawn_blocking so they do not stall a runtime worker."
      ],
      "production": [
        "Every custom Future registers the waker before returning Pending, and tests assert the poll count.",
        "Operations that must not be abandoned are spawned and awaited through their JoinHandle, not left inside a select! branch.",
        "Blocking IO runs on spawn_blocking, and worker threads are sized from a measured load, not a guess.",
        "Timeouts and cancellation are tested explicitly, since they are the paths that never occur in a happy-path integration test."
      ],
      "crates": [
        "futures",
        "tokio",
        "pin-project-lite"
      ],
      "github": [
        {
          "name": "rust-lang/futures-rs",
          "url": "https://github.com/rust-lang/futures-rs"
        },
        {
          "name": "tokio-rs/tokio",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "pitfall": "Returning Poll::Pending after an await that consumed an item, with no state saved: the task is dropped or the poll is lost, the item is gone, and the caller sees a timeout rather than a dropped message.",
      "resources": [
        {
          "title": "std::future::Future: the poll contract",
          "url": "https://doc.rust-lang.org/std/future/trait.Future.html",
          "kind": "docs"
        },
        {
          "title": "Making the Tokio scheduler 10x faster",
          "url": "https://tokio.rs/blog/2019-10-scheduler",
          "kind": "docs"
        },
        {
          "title": "Asynchronous Programming in Rust (async book)",
          "url": "https://rust-lang.github.io/async-book/",
          "kind": "docs"
        },
        {
          "title": "rust-lang/futures-rs repository",
          "url": "https://github.com/rust-lang/futures-rs",
          "kind": "repo"
        },
        {
          "title": "Jon Gjengset: Crust of Rust async/await streams",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ]
    },
    {
      "id": "r12",
      "title": "SIMD: target_feature, intrinsics, and the portable gap",
      "minutes": 85,
      "level": "advanced",
      "goal": "Decide when vectorization is worth hand-writing, call x86 intrinsics behind a runtime feature check, and state honestly why portable SIMD is still nightly.",
      "sections": [
        {
          "h": "Exhaust autovectorization before intrinsics",
          "p": [
            "LLVM vectorizes ordinary loops when the trip count and the data layout are visible and there is no aliasing it cannot prove away. Iterating over slices, avoiding early exits inside the hot loop, and compiling with -C target-cpu=native gets most code to within a small factor of hand-written SIMD, with zero unsafe.",
            "Measure before you write intrinsics. A loop that sums f32 squares over a million elements is memory-bound and will show little gain; a loop over data already in L1 with a long dependency chain is where explicit vectors pay. The honest check is the emitted assembly for the function, not intuition about what the compiler should have done."
          ],
          "code": "# Confirm what the compiler emitted before hand-writing anything:\ncargo rustc --release -- --emit asm\ncargo asm --release --lib mycrate::sum_squares\n\n# Let LLVM use the host's full instruction set (build-host only!):\nRUSTFLAGS=\"-C target-cpu=native\" cargo build --release\n\n# A vectorization-friendly loop: no branches, slice inputs, no early exit.\n#[inline]\npub fn sum_squares(input: &[f32]) -> f32 {\n    input.iter().map(|x| x * x).sum()\n}",
          "tip": "-C target-cpu=native produces binaries that may use instructions the deployment CPU lacks. Pin target-cpu for release builds, or use runtime detection instead."
        },
        {
          "h": "core::arch: intrinsics behind a runtime check",
          "p": [
            "Stable Rust exposes target intrinsics in core::arch under the platform module, but they are unsafe: they assume the CPU supports the instruction. #[target_feature(enable = \"avx2\")] compiles a function for that feature, and since the feature is not guaranteed at runtime, calling it is unsafe. is_x86_feature_detected! performs the CPUID check once, caches the result, and is stable.",
            "Keep the unsafe surface tiny: one function per feature set, one dispatcher that checks features and falls back to scalar. Note that avx2 does not imply fma on every CPU, so enabling and detecting both is not pedantry - _mm256_fmadd_ps requires fma. The fallback must be correct on its own, because it is what runs on the oldest machine in the fleet."
          ],
          "code": "#[cfg(target_arch = \"x86_64\")]\nmod avx2 {\n    use std::arch::x86_64::*;\n\n    /// # Safety\n    /// The CPU must support AVX2 and FMA; check both with\n    /// is_x86_feature_detected! before calling.\n    #[target_feature(enable = \"avx2,fma\")]\n    pub unsafe fn sum_squares(input: &[f32]) -> f32 {\n        let mut acc = _mm256_setzero_ps();\n        let mut chunks = input.chunks_exact(8);\n        for chunk in &mut chunks {\n            // SAFETY: chunk holds exactly 8 f32s; unaligned loads are allowed.\n            let values = unsafe { _mm256_loadu_ps(chunk.as_ptr()) };\n            acc = _mm256_fmadd_ps(values, values, acc);\n        }\n        let mut lanes = [0.0f32; 8];\n        // SAFETY: lanes holds 8 f32s, matching the vector width.\n        unsafe { _mm256_storeu_ps(lanes.as_mut_ptr(), acc) };\n        let mut total: f32 = lanes.iter().sum();\n        for rest in chunks.remainder() {\n            total += rest * rest;\n        }\n        total\n    }\n}\n\n#[cfg(target_arch = \"x86_64\")]\npub fn sum_squares(input: &[f32]) -> f32 {\n    if std::arch::is_x86_feature_detected!(\"avx2\") && std::arch::is_x86_feature_detected!(\"fma\") {\n        // SAFETY: both required features were detected at runtime.\n        unsafe { avx2::sum_squares(input) }\n    } else {\n        input.iter().map(|x| x * x).sum()\n    }\n}\n\nfn main() {\n    let data: Vec<f32> = (1..=16).map(|n| n as f32).collect();\n    assert_eq!(sum_squares(&data), 1496.0);\n}",
          "list": [
            "is_x86_feature_detected! is stable and caches the CPUID result",
            "avx2 does not imply fma: enable and detect both",
            "_mm256_loadu_ps tolerates unaligned pointers; the aligned load does not",
            "The scalar fallback must be correct: it runs on the oldest fleet machine"
          ]
        },
        {
          "h": "Portable SIMD is nightly, not stable",
          "p": [
            "std::simd offers f32x8 and friends with a portable API, but it is behind #![feature(portable_simd)] and marked nightly-only in the docs. A published crate cannot use it on stable; it can only offer it behind a feature that requires nightly. The wide and pulp crates emulate much of the same API on stable by dispatching to target intrinsics internally.",
            "The design trade-off is real either way. Portable vectors let one code path compile everywhere, including aarch64 where NEON has different widths. Target intrinsics give exact control - saturating operations, specific lane counts, specific instructions - at the cost of one implementation per architecture. Most production crates ship both: a portable fallback and a #[target_feature] fast path selected at runtime."
          ],
          "code": "// NIGHTLY ONLY: requires #![feature(portable_simd)]\n//\n// use std::simd::{f32x8, SimdFloat};\n//\n// pub fn sum_squares(input: &[f32]) -> f32 {\n//     let mut acc = f32x8::splat(0.0);\n//     for chunk in input.chunks_exact(8) {\n//         let values = f32x8::from_slice(chunk);\n//         acc += values * values;\n//     }\n//     acc.reduce_sum()\n// }\n\n// Stable equivalent with the wide crate: same shape, stable toolchain.\nuse wide::f32x8;\n\npub fn sum_squares_wide(input: &[f32]) -> f32 {\n    let mut acc = f32x8::splat(0.0);\n    let mut chunks = input.chunks_exact(8);\n    for chunk in &mut chunks {\n        let mut lanes = [0.0f32; 8];\n        lanes.copy_from_slice(chunk);\n        let values = f32x8::from(lanes);\n        acc += values * values;\n    }\n    acc.reduce_add() + chunks.remainder().iter().map(|x| x * x).sum::<f32>()\n}\n\nfn main() {\n    let data: Vec<f32> = (1..=16).map(|n| n as f32).collect();\n    assert_eq!(sum_squares_wide(&data), 1496.0);\n}",
          "tip": "wide and pulp compile on stable and select instructions per target. They are the pragmatic choice for a crate that cannot require nightly."
        }
      ],
      "exercise": {
        "prompt": "Write count_byte that counts occurrences of a byte in a &[u8] using AVX2 _mm256_cmpeq_epi8 plus a popcount of the resulting mask, with a scalar fallback selected by is_x86_feature_detected!.",
        "starter": "#[cfg(target_arch = \"x86_64\")]\nmod avx2 {\n    use std::arch::x86_64::*;\n\n    #[target_feature(enable = \"avx2\")]\n    pub unsafe fn count_byte(haystack: &[u8], needle: u8) -> usize {\n        todo!()\n    }\n}",
        "hint": "Broadcast the needle with _mm256_set1_epi8, load 32 bytes with _mm256_loadu_si256, compare with _mm256_cmpeq_epi8, then _mm256_movemask_epi8(...).count_ones(). Handle the remainder with a scalar loop.",
        "solution": "#[cfg(target_arch = \"x86_64\")]\nmod avx2 {\n    use std::arch::x86_64::*;\n\n    /// # Safety\n    /// The CPU must support AVX2.\n    #[target_feature(enable = \"avx2\")]\n    pub unsafe fn count_byte(haystack: &[u8], needle: u8) -> usize {\n        let target = _mm256_set1_epi8(needle as i8);\n        let mut total = 0usize;\n        let mut chunks = haystack.chunks_exact(32);\n\n        for chunk in &mut chunks {\n            // SAFETY: chunk is exactly 32 bytes; unaligned load is allowed.\n            let block = unsafe { _mm256_loadu_si256(chunk.as_ptr().cast()) };\n            let matches = _mm256_cmpeq_epi8(block, target);\n            total += _mm256_movemask_epi8(matches).count_ones() as usize;\n        }\n\n        total + chunks.remainder().iter().filter(|b| **b == needle).count()\n    }\n}\n\n#[cfg(target_arch = \"x86_64\")]\npub fn count_byte(haystack: &[u8], needle: u8) -> usize {\n    if std::arch::is_x86_feature_detected!(\"avx2\") {\n        // SAFETY: the check above guarantees AVX2 is available.\n        unsafe { avx2::count_byte(haystack, needle) }\n    } else {\n        haystack.iter().filter(|b| **b == needle).count()\n    }\n}\n\nfn main() {\n    let data = b\"the quick brown fox jumps over the lazy dog\";\n    assert_eq!(count_byte(data, b'o'), 4);\n    assert_eq!(count_byte(b\"aaaa\", b'a'), 4);\n}"
      },
      "questions": [
        {
          "q": "Why is calling a #[target_feature] function unsafe?",
          "options": [
            "Because the compiler cannot verify the running CPU supports the feature",
            "Because the function may read uninitialized memory",
            "Because target_feature disables bounds checks",
            "Because the function can never be inlined"
          ],
          "answer": 0,
          "explain": "The attribute changes code generation for that function only. Whether the deployed CPU has AVX2 is a runtime fact, which is why is_x86_feature_detected! must gate the call."
        },
        {
          "q": "Which statement about std::simd is accurate today?",
          "options": [
            "It is nightly-only behind #![feature(portable_simd)]",
            "It is stable since 1.75 for f32 vectors",
            "It is stable but only on x86_64",
            "It is available under std::arch::portable"
          ],
          "answer": 0,
          "explain": "The std::simd module is annotated as a nightly-only experimental API. Stable crates use core::arch intrinsics behind runtime detection, or a crate like wide or pulp."
        },
        {
          "q": "You enable only avx2 but call _mm256_fmadd_ps. What is the risk?",
          "options": [
            "FMA is a separate feature, so a CPU with AVX2 but without FMA can raise an illegal instruction",
            "Nothing: avx2 implies fma on every CPU",
            "The compiler rejects the call at compile time",
            "The function silently falls back to scalar multiplication"
          ],
          "answer": 0,
          "explain": "AVX2 and FMA are distinct CPUID bits. Detecting both and enabling both keeps the fast path from executing an instruction the CPU does not implement."
        }
      ],
      "quickbytes": [
        "cargo asm --release mycrate::hot_fn --intel   # what the compiler really emitted",
        "RUSTFLAGS=\"-C target-cpu=native\" helps locally but breaks portable release binaries.",
        "Detect and enable the same feature list: avx2 alone does not give you fma.",
        "Keep one scalar fallback that is correct on its own; it runs on the oldest node."
      ],
      "production": [
        "Release builds pin target-cpu instead of using native, so CI artefacts run on the deployment fleet.",
        "Every #[target_feature] function is gated by a runtime detection check with a scalar fallback behind it.",
        "The SIMD path has a benchmark and an equivalence test against the scalar path on randomized input.",
        "No feature is enabled in the attribute that is not also checked at runtime, including fma and avx512 subfeatures."
      ],
      "crates": [
        "wide",
        "pulp"
      ],
      "github": [
        {
          "name": "rust-lang/stdarch",
          "url": "https://github.com/rust-lang/stdarch"
        }
      ],
      "pitfall": "Distributing a binary built with -C target-cpu=native: it runs in CI and on the developer laptop, then dies with SIGILL on an older production CPU inside a code path nobody tested.",
      "resources": [
        {
          "title": "std::simd: portable SIMD (nightly, portable_simd)",
          "url": "https://doc.rust-lang.org/std/simd/index.html",
          "kind": "docs"
        },
        {
          "title": "std::arch: platform intrinsics",
          "url": "https://doc.rust-lang.org/std/arch/index.html",
          "kind": "docs"
        },
        {
          "title": "is_x86_feature_detected!",
          "url": "https://doc.rust-lang.org/std/arch/macro.is_x86_feature_detected.html",
          "kind": "docs"
        },
        {
          "title": "The Rust Reference: the target_feature attribute",
          "url": "https://doc.rust-lang.org/reference/attributes/codegen.html",
          "kind": "docs"
        },
        {
          "title": "rust-lang/stdarch: the intrinsics implementation",
          "url": "https://github.com/rust-lang/stdarch",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "r13",
      "title": "Zero-copy parsing: borrowed views and validation",
      "minutes": 75,
      "level": "advanced",
      "goal": "Parse frames into views borrowed from the input, know when a refcounted handle beats a reference, and reject malformed lengths before arithmetic can wrap.",
      "sections": [
        {
          "h": "The lifetime is the proof of zero copies",
          "p": [
            "A zero-copy parser returns structs full of references into the caller's buffer. Frame<'a> with a payload: &'a [u8] field is the whole technique: no allocation, no memcpy, and the borrow checker proves the view cannot outlive the bytes. The cost is that the caller must keep the buffer alive, so the API is only usable when the input already lives in memory - a network buffer, a memory-mapped file, a Bytes handle.",
            "Copying is not always wrong. If the caller needs the payload after the buffer is recycled, a copy is the honest cost of ownership. The mistake is copying by default, in every field, and then paying allocation and cache misses for a parse that could have been four slice offsets."
          ],
          "code": "#[derive(Debug, PartialEq)]\npub struct Frame<'a> {\n    pub kind: u8,\n    pub flags: u16,\n    pub payload: &'a [u8],\n}\n\n#[derive(Debug, PartialEq)]\npub enum ParseError {\n    Short,\n    TooLarge,\n    Overflow,\n}\n\n/// Parses one length-prefixed frame. The payload borrows `input`.\npub fn parse_frame(input: &[u8]) -> Result<(Frame<'_>, usize), ParseError> {\n    if input.len() < 5 {\n        return Err(ParseError::Short);\n    }\n    let kind = input[0];\n    let flags = u16::from_be_bytes([input[1], input[2]]);\n    let len = u16::from_be_bytes([input[3], input[4]]) as usize;\n\n    if len > 64 * 1024 {\n        return Err(ParseError::TooLarge);\n    }\n    let end = 5usize.checked_add(len).ok_or(ParseError::Overflow)?;\n    let payload = input.get(5..end).ok_or(ParseError::Short)?;\n\n    Ok((Frame { kind, flags, payload }, end))\n}\n\nfn main() {\n    let bytes = [7u8, 0, 1, 0, 3, b'a', b'b', b'c'];\n    let (frame, consumed) = parse_frame(&bytes).expect(\"well-formed\");\n    assert_eq!(frame.payload, b\"abc\");\n    assert_eq!(consumed, 8);\n}",
          "tip": "checked_add plus get(range) turns two classes of bug - integer wrap and out-of-bounds - into ordinary errors that the caller can handle."
        },
        {
          "h": "When a reference is not enough: Bytes",
          "p": [
            "Borrowed views tie the parser to a single stack frame. Cross-task pipelines need a value that owns the buffer yet hands out cheap subslices, and that is what bytes::Bytes is: a refcounted handle where clone is an atomic increment and split_to is an offset adjustment, not a copy.",
            "Bytes::split_to returns a new handle to the front of the buffer in constant time, so a parser can hand each payload to a worker while the frame header is dropped. The trap is mutation: BytesMut::split gives you a mutable prefix but the shared tail cannot be written until the last handle is dropped, which is exactly the guarantee you want and exactly what surprises people porting code from Vec."
          ],
          "code": "use bytes::{Buf, Bytes};\n\npub struct OwnedFrame {\n    pub kind: u8,\n    pub payload: Bytes, // a refcounted view, not a copy\n}\n\n/// Consumes one frame from the front of `buf`, returning the rest.\npub fn next_frame(mut buf: Bytes) -> Option<(OwnedFrame, Bytes)> {\n    if buf.remaining() < 5 {\n        return None;\n    }\n    let kind = buf.get_u8();\n    let _flags = buf.get_u16();\n    let len = buf.get_u16() as usize;\n\n    if buf.remaining() < len {\n        return None;\n    }\n    let payload = buf.split_to(len); // O(1): same allocation, new view\n    Some((OwnedFrame { kind, payload }, buf))\n}\n\nfn main() {\n    let buf = Bytes::from_static(&[1, 0, 0, 0, 2, b'h', b'i', 9]);\n    let (frame, rest) = next_frame(buf).expect(\"one frame\");\n    assert_eq!(frame.payload, \"hi\".as_bytes());\n    assert_eq!(rest[0], 9);\n}",
          "list": [
            "Bytes::clone is refcounted; the underlying buffer is never copied",
            "split_to(n) is O(1) and returns the first n bytes as a new handle",
            "A BytesMut tail cannot be mutated while any split handle is alive",
            "Borrowed &[u8] views are cheaper still, but cannot cross a task boundary"
          ]
        },
        {
          "h": "Fixed headers: let a derive do the bounds check",
          "p": [
            "A fixed-size header is a layout problem, not a parsing problem. zerocopy derives FromBytes, Immutable, KnownLayout, and Unaligned, and read_from_prefix returns the header plus the remaining bytes or an error - no unsafe in your crate, and the size check is generated from the type.",
            "Two rules keep this honest. Alignment: the wire format has no alignment guarantees, so either derive Unaligned or copy the bytes out. Endianness: a struct field of type u32 reads the machine's byte order, so store the wire bytes as [u8; 4] and convert with from_be_bytes in a method. Getting either wrong produces plausible-looking garbage, not a crash."
          ],
          "code": "use zerocopy::{FromBytes, Immutable, KnownLayout, Unaligned};\n\n#[derive(Debug, FromBytes, Immutable, KnownLayout, Unaligned)]\n#[repr(C)]\npub struct Header {\n    pub magic: [u8; 2],\n    pub version: u8,\n    pub kind: u8,\n    pub length_be: [u8; 4], // network byte order, converted on access\n}\n\nimpl Header {\n    pub fn length(&self) -> u32 {\n        u32::from_be_bytes(self.length_be)\n    }\n}\n\npub fn header(input: &[u8]) -> Option<Header> {\n    // read_from_prefix fails when fewer than 8 bytes remain; ok()? maps that to None.\n    let (header, _rest) = Header::read_from_prefix(input).ok()?;\n    (header.magic == *b\"AC\").then_some(header)\n}\n\nfn main() {\n    let bytes = [b'A', b'C', 1, 2, 0, 0, 0, 40];\n    let header = header(&bytes).expect(\"valid magic\");\n    assert_eq!(header.length(), 40);\n    assert!(header(&bytes[..4]).is_none());\n}",
          "tip": "Deriving Unaligned makes every field access a byte-wise read. That is the correct trade for network data; it is the wrong trade for a hot loop over an aligned buffer you built yourself."
        }
      ],
      "exercise": {
        "prompt": "Write parse_all that repeatedly calls parse_frame and returns a Vec<Frame<'_>> plus a ParseError for a truncated trailing frame. It must not copy any payload bytes.",
        "starter": "pub fn parse_all(input: &[u8]) -> Result<Vec<Frame<'_>>, ParseError> {\n    let mut frames = Vec::new();\n    let mut rest = input;\n    // 1. loop while rest is non-empty\n    // 2. parse_frame(rest)\n    // 3. advance rest by the consumed count\n    todo!()\n}",
        "hint": "let (frame, used) = parse_frame(rest)?; frames.push(frame); rest = &rest[used..];. Frames borrow from the original input, so the Vec<Frame<'_>> lifetime is the input lifetime, not the loop's.",
        "solution": "#[derive(Debug, PartialEq)]\npub struct Frame<'a> {\n    pub kind: u8,\n    pub payload: &'a [u8],\n}\n\n#[derive(Debug, PartialEq)]\npub enum ParseError {\n    Short,\n    TooLarge,\n    Overflow,\n}\n\npub fn parse_frame(input: &[u8]) -> Result<(Frame<'_>, usize), ParseError> {\n    if input.len() < 3 {\n        return Err(ParseError::Short);\n    }\n    let kind = input[0];\n    let len = u16::from_be_bytes([input[1], input[2]]) as usize;\n    if len > 64 * 1024 {\n        return Err(ParseError::TooLarge);\n    }\n    let end = 3usize.checked_add(len).ok_or(ParseError::Overflow)?;\n    let payload = input.get(3..end).ok_or(ParseError::Short)?;\n    Ok((Frame { kind, payload }, end))\n}\n\n/// Every returned frame borrows from `input`; nothing is copied.\npub fn parse_all(input: &[u8]) -> Result<Vec<Frame<'_>>, ParseError> {\n    let mut frames = Vec::new();\n    let mut rest = input;\n    while !rest.is_empty() {\n        let (frame, used) = parse_frame(rest)?;\n        frames.push(frame);\n        rest = &rest[used..];\n    }\n    Ok(frames)\n}\n\nfn main() {\n    let bytes = [1u8, 0, 2, b'h', b'i', 2, 0, 1, b'!'];\n    let frames = parse_all(&bytes).expect(\"two frames\");\n    assert_eq!(frames.len(), 2);\n    assert_eq!(frames[0].payload, b\"hi\");\n    assert_eq!(frames[1].payload, b\"!\");\n    assert!(parse_all(&[1, 0, 9, b'x']).is_err()); // truncated\n}"
      },
      "questions": [
        {
          "q": "What does a parser returning Frame<'a> with borrowed payloads require from the caller?",
          "options": [
            "The input buffer must outlive every returned frame",
            "The input must be heap-allocated",
            "The frames must be consumed before the next parse call",
            "The payload must be ASCII"
          ],
          "answer": 0,
          "explain": "The lifetime in the return type is the input's lifetime, so the borrow checker forces the buffer to outlive the frames. That is the proof that no copy happened."
        },
        {
          "q": "Why is Bytes::split_to(len) described as zero-copy?",
          "options": [
            "It adjusts offsets in a shared allocation and bumps a refcount",
            "It moves the bytes into a new small buffer",
            "It uses the kernel's splice system call",
            "It compresses the payload"
          ],
          "answer": 0,
          "explain": "Both handles point into the same allocation with different windows. The cost is an atomic increment and two pointer updates, independent of payload size."
        },
        {
          "q": "A header struct stores length as u32 and the wire format is big-endian. What goes wrong?",
          "options": [
            "The field reads in host byte order, so little-endian machines see a byte-swapped length",
            "Nothing: repr(C) implies network byte order",
            "The struct becomes misaligned and fails to parse",
            "zerocopy refuses to derive FromBytes for u32 fields"
          ],
          "answer": 0,
          "explain": "Layout and byte order are independent. Storing [u8; 4] and calling u32::from_be_bytes makes the conversion explicit and portable."
        }
      ],
      "quickbytes": [
        "input.get(a..b) plus checked_add turns overflow and truncation into errors instead of panics.",
        "Bytes::split_to(n) is O(1); Bytes::copy_from_slice is O(n). Know which one you called.",
        "Derive Unaligned for wire structs; network buffers have no alignment contract.",
        "cargo +nightly miri test catches the out-of-bounds reads a fuzzer alone would miss."
      ],
      "production": [
        "Parsers return borrowed views by default and copy only where ownership must outlive the input buffer.",
        "Every length read from the wire is range-checked and added with checked arithmetic before slicing.",
        "Fixed headers are parsed with a derived FromBytes plus explicit from_be_bytes accessors, never with transmute.",
        "Fuzzing runs over the parser with arbitrary bytes, and every error variant is reachable from a test."
      ],
      "crates": [
        "bytes",
        "nom",
        "zerocopy"
      ],
      "github": [
        {
          "name": "tokio-rs/bytes",
          "url": "https://github.com/tokio-rs/bytes"
        },
        {
          "name": "google/zerocopy",
          "url": "https://github.com/google/zerocopy"
        }
      ],
      "pitfall": "Computing end = header_len + payload_len as usize and slicing without checked_add: a malicious length wraps on 32-bit targets, the slice panics or the wrong region is parsed, and the fuzzer never ran on that architecture.",
      "resources": [
        {
          "title": "bytes: refcounted byte buffers and Buf/BufMut",
          "url": "https://docs.rs/bytes/latest/bytes/",
          "kind": "docs"
        },
        {
          "title": "zerocopy: safe transmutes and from-bytes parsing",
          "url": "https://docs.rs/zerocopy/latest/zerocopy/",
          "kind": "docs"
        },
        {
          "title": "nom 8: parser combinators over borrowed input",
          "url": "https://docs.rs/nom/latest/nom/",
          "kind": "docs"
        },
        {
          "title": "tokio-rs/bytes repository",
          "url": "https://github.com/tokio-rs/bytes",
          "kind": "repo"
        },
        {
          "title": "google/zerocopy repository",
          "url": "https://github.com/google/zerocopy",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "r14",
      "title": "The type-state pattern: states as types",
      "minutes": 55,
      "level": "advanced",
      "goal": "Encode a lifecycle in the type system so an invalid call order cannot compile, and recognise the cases where a runtime enum is the better design.",
      "sections": [
        {
          "h": "Zero-sized states and a phantom parameter",
          "p": [
            "The type-state pattern makes each lifecycle state a type. Draft and Validated are empty structs used only as a generic parameter, so Request<Draft> and Request<Validated> are different types that share one layout. A transition consumes self and returns the new state, which makes the old value unusable and the order unforgeable.",
            "Because the state is a type parameter, a method implemented only on Request<Validated> simply does not exist on Request<Draft>. Calling send() on a draft is not a runtime error or a panic - it fails to compile with a clear message. The cost is that every state is a distinct type in the API and in error messages."
          ],
          "code": "use std::marker::PhantomData;\n\npub struct Draft;\npub struct Validated;\n\npub struct Request<S> {\n    body: Vec<u8>,\n    // fn() -> S keeps the marker covariant and does not affect auto traits\n    _state: PhantomData<fn() -> S>,\n}\n\n#[derive(Debug)]\npub struct ValidationError(&'static str);\n\nimpl Request<Draft> {\n    pub fn new(body: Vec<u8>) -> Self {\n        Self { body, _state: PhantomData }\n    }\n\n    pub fn validate(self) -> Result<Request<Validated>, ValidationError> {\n        if self.body.is_empty() {\n            return Err(ValidationError(\"empty body\"));\n        }\n        Ok(Request { body: self.body, _state: PhantomData })\n    }\n}\n\nimpl Request<Validated> {\n    pub fn send(&self) -> usize {\n        self.body.len() // reachable only after validate()\n    }\n}\n\nfn main() {\n    let draft = Request::new(vec![1, 2, 3]);\n    // draft.send(); // error[E0599]: no method named `send` on Request<Draft>\n    let ready = draft.validate().expect(\"non-empty body\");\n    assert_eq!(ready.send(), 3);\n}",
          "tip": "PhantomData<fn() -> S> is deliberate: it keeps the marker covariant and leaves Send/Sync to the real fields, unlike PhantomData<S>."
        },
        {
          "h": "Builders are the other half",
          "p": [
            "The same idea applies to configuration: a builder whose type parameter records which required fields are already set. typed-builder derives that, so forgetting a required field is a compile error at the build() call rather than a runtime validation error after startup.",
            "Hand-rolling the builder states works, but the combinatorics explode: three required fields mean eight states and eight impl blocks. Deriving it keeps the API readable and the error message points at the missing method. The pattern is worth it when misconfiguration is expensive - a service that starts with the wrong credentials and fails at the first request."
          ],
          "code": "use typed_builder::TypedBuilder;\n\n#[derive(Debug, TypedBuilder)]\nstruct Connect {\n    host: String,\n    #[builder(default = 443)]\n    port: u16,\n    token: String, // required: build() will not compile without it\n}\n\nfn main() {\n    let config = Connect::builder()\n        .host(\"api.example.com\".to_string())\n        .token(\"secret\".to_string())\n        .build();\n    assert_eq!(config.port, 443);\n\n    // Missing token: the builder type has no build() method yet.\n    // let bad = Connect::builder().host(\"x\".to_string()).build();\n}",
          "list": [
            "Mark required fields by having no default; the builder type enforces them",
            "Defaults belong in the builder, not in a Default impl that hides required fields",
            "Builder errors point at the build() call, so name the fields clearly",
            "Keep the number of required fields small; five states of typing is still five"
          ]
        },
        {
          "h": "Where type-state stops paying",
          "p": [
            "Type-state cannot store mixed states in one collection, cannot be selected at runtime from a config file, and multiplies monomorphizations. A workflow whose next step comes from a queue message must be a runtime enum with a match, and that is not a failure of the pattern - it is the pattern telling you the state is genuinely dynamic.",
            "The production shape is usually both: a type-state front door for the code path you control, and a private runtime state machine for values that arrive from outside. The conversion between them is one function with a match, and that function is the only place where an invalid transition can occur, which makes it the only place you have to test."
          ],
          "code": "#[derive(Debug, Clone, Copy, PartialEq)]\nenum State {\n    Draft,\n    Validated,\n    Sent,\n}\n\nstruct Job {\n    state: State,\n    body: Vec<u8>,\n}\n\nimpl Job {\n    /// The single place where an illegal transition can happen.\n    fn advance(&mut self) -> Result<(), &'static str> {\n        match self.state {\n            State::Draft if self.body.is_empty() => Err(\"empty body\"),\n            State::Draft => {\n                self.state = State::Validated;\n                Ok(())\n            }\n            State::Validated => {\n                self.state = State::Sent;\n                Ok(())\n            }\n            State::Sent => Err(\"already sent\"),\n        }\n    }\n}\n\nfn main() {\n    let mut job = Job { state: State::Draft, body: vec![1] };\n    assert!(job.advance().is_ok());\n    assert!(job.advance().is_ok());\n    assert!(job.advance().is_err());\n}",
          "tip": "If a state arrives in a message from another service, it is data, not a type. Validate it into the type-state API at the boundary."
        }
      ],
      "exercise": {
        "prompt": "Model a database transaction as type-state: a Tx<Open> with execute(&mut self, sql: &str) and commit(self) -> Tx<Committed>, where commit is only callable on an open transaction and execute is not callable after commit.",
        "starter": "use std::marker::PhantomData;\n\npub struct Open;\npub struct Committed;\n\npub struct Tx<S> {\n    statements: Vec<String>,\n    _state: PhantomData<fn() -> S>,\n}\n\n// implement new(), execute(), commit()",
        "hint": "impl Tx<Open> { pub fn new() -> Self; pub fn execute(&mut self, sql: &str); pub fn commit(self) -> Tx<Committed> }. There is no execute on Tx<Committed>, so the compiler enforces the order.",
        "solution": "use std::marker::PhantomData;\n\npub struct Open;\npub struct Committed;\n\npub struct Tx<S> {\n    statements: Vec<String>,\n    _state: PhantomData<fn() -> S>,\n}\n\nimpl Tx<Open> {\n    pub fn new() -> Self {\n        Self { statements: Vec::new(), _state: PhantomData }\n    }\n\n    pub fn execute(&mut self, sql: &str) {\n        self.statements.push(sql.to_string());\n    }\n\n    pub fn commit(self) -> Tx<Committed> {\n        Tx { statements: self.statements, _state: PhantomData }\n    }\n}\n\nimpl Tx<Committed> {\n    pub fn statement_count(&self) -> usize {\n        self.statements.len()\n    }\n}\n\nfn main() {\n    let mut tx = Tx::new();\n    tx.execute(\"INSERT INTO t VALUES (1)\");\n    let done = tx.commit();\n    assert_eq!(done.statement_count(), 1);\n\n    // done.execute(\"x\"); // error[E0599]: no method named `execute`\n    // let _ = done.commit(); // error[E0599]: commit takes Tx<Open>\n}"
      },
      "questions": [
        {
          "q": "What makes send() uncallable on Request<Draft>?",
          "options": [
            "The impl block is only for Request<Validated>, so the method does not exist on other states",
            "A runtime flag is checked inside send()",
            "The Draft type does not implement Send",
            "PhantomData<fn() -> S> removes the method at compile time"
          ],
          "answer": 0,
          "explain": "Inherent methods are looked up per concrete type. Request<Draft> has no method named send, so the compiler rejects the call before any code runs."
        },
        {
          "q": "Why prefer PhantomData<fn() -> S> over PhantomData<S> for a state marker?",
          "options": [
            "It keeps variance covariant and does not change the type's Send/Sync behaviour",
            "It makes the state zero-sized, which PhantomData<S> does not",
            "It allows S to be a trait object",
            "It removes the need for a generic parameter"
          ],
          "answer": 0,
          "explain": "PhantomData<S> behaves as if the type owns an S, affecting auto traits and variance. The fn() -> S form declares only a type-level relationship."
        },
        {
          "q": "Which situation genuinely needs a runtime state enum instead of type-state?",
          "options": [
            "The next state comes from a queue message, so it is only known at runtime",
            "The state machine has three states",
            "The states need different methods",
            "The struct contains a Vec"
          ],
          "answer": 0,
          "explain": "Type-state requires the sequence to be visible to the compiler. A state received from outside is data, so it must be an enum, validated at the boundary before entering the typed API."
        }
      ],
      "quickbytes": [
        "Transitions take self, so the old state cannot be reused after the move.",
        "Commented-out invalid calls in doctests prove the restriction still holds.",
        "typed-builder turns missing required fields into compile errors at build().",
        "Keep the runtime enum private and convert once at the boundary."
      ],
      "production": [
        "Each documented lifecycle transition has a test or doctest that fails to compile when used out of order.",
        "State marker types are private or sealed so downstream crates cannot invent a new state.",
        "Builders enforce required fields at compile time; no runtime validation duplicates what the type can prove.",
        "Runtime state machines keep their transition function in one match, which is the only function carrying transition tests."
      ],
      "crates": [
        "typed-builder",
        "static_assertions"
      ],
      "github": [
        {
          "name": "idanarye/rust-typed-builder",
          "url": "https://github.com/idanarye/rust-typed-builder"
        }
      ],
      "pitfall": "Using the type-state pattern for a state that is read from a config file or a message: the workflow cannot be expressed statically, so the code ends up with a match that reconstructs the type every step, and the pattern buys nothing.",
      "resources": [
        {
          "title": "std::marker::PhantomData",
          "url": "https://doc.rust-lang.org/std/marker/struct.PhantomData.html",
          "kind": "docs"
        },
        {
          "title": "The Rustonomicon: PhantomData",
          "url": "https://doc.rust-lang.org/nomicon/phantom-data.html",
          "kind": "docs"
        },
        {
          "title": "typed-builder: compile-time checked builders",
          "url": "https://docs.rs/typed-builder/latest/typed_builder/",
          "kind": "docs"
        },
        {
          "title": "idanarye/rust-typed-builder repository",
          "url": "https://github.com/idanarye/rust-typed-builder",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "r15",
      "title": "Error design at scale: enums, codes, retries",
      "minutes": 70,
      "level": "industry",
      "goal": "Design a public error enum that can grow without breaking callers, expose stable machine codes, and keep retry decisions and secrets out of Display.",
      "sections": [
        {
          "h": "Library enums, application chains",
          "p": [
            "A library's error is part of its API: callers match on it, so it must be a concrete enum with documented variants. error is thiserror's job - derive Error, annotate Display, and mark the underlying cause with #[source] so the chain is walkable instead of flattened into a string. A binary is the opposite: it aggregates errors from everywhere, so anyhow::Error with context at each boundary is the right tool.",
            "The anti-pattern is a public enum whose variant holds Box<dyn Error>. Now the caller cannot match on anything except the outer shell, and the crate can never add meaning without changing the inner type. If the details are not a stable contract, expose them as a source chain and document that matching stops at your enum."
          ],
          "code": "use std::time::Duration;\nuse thiserror::Error;\n\n#[derive(Debug, Error)]\n#[non_exhaustive] // adding a variant stays a minor change\npub enum StoreError {\n    #[error(\"object {key} not found\")]\n    NotFound { key: String },\n\n    #[error(\"backend timed out after {0:?}\")]\n    Timeout(Duration),\n\n    #[error(\"backend rejected the request\")]\n    Rejected(#[source] BackendError),\n\n    #[error(transparent)]\n    Io(#[from] std::io::Error),\n}\n\n#[derive(Debug, Error)]\n#[error(\"backend status {status}\")]\npub struct BackendError {\n    pub status: u16,\n}\n\nimpl StoreError {\n    /// Stable, machine-readable identifier: log it, alert on it, never parse Display.\n    pub fn code(&self) -> &'static str {\n        match self {\n            Self::NotFound { .. } => \"store.not_found\",\n            Self::Timeout(_) => \"store.timeout\",\n            Self::Rejected(_) => \"store.rejected\",\n            Self::Io(_) => \"store.io\",\n        }\n    }\n\n    pub fn retryable(&self) -> bool {\n        matches!(self, Self::Timeout(_) | Self::Io(_))\n    }\n}",
          "tip": "A #[non_exhaustive] enum still lets callers match, but forces a _ arm - the price of being able to add variants in a minor release."
        },
        {
          "h": "Growth, conversion, and the From trap",
          "p": [
            "Adding a variant to a public enum without non_exhaustive is a breaking change: every exhaustive match downstream stops compiling. With it, the addition is minor, but callers now have a catch-all arm that may silently mis-handle your new case. Document that the catch-all exists and what it means, and give every variant a stable code so monitoring does not depend on match arms.",
            "#[from] generates a From impl, which is convenient and occasionally wrong: it collapses two distinct causes into one variant and loses the distinction that a retry policy needs. A From impl also cannot fail, so it cannot add context. Prefer an explicit constructor that captures the relevant fields, and reserve #[from] for the mechanical io::Error case."
          ],
          "code": "use thiserror::Error;\n\n#[derive(Debug, Error)]\n#[non_exhaustive]\npub enum ApiError {\n    #[error(\"invalid request: {0}\")]\n    Invalid(String),\n\n    #[error(\"unauthorized\")]\n    Unauthorized,\n\n    #[error(transparent)]\n    Store(#[from] StoreError),\n}\n\n#[derive(Debug, Error)]\n#[error(\"store failure: {code}\")]\npub struct StoreError {\n    pub code: &'static str,\n}\n\nimpl ApiError {\n    pub fn status(&self) -> u16 {\n        match self {\n            Self::Invalid(_) => 400,\n            Self::Unauthorized => 401,\n            Self::Store(_) => 503,\n        }\n    }\n\n    pub fn retryable(&self) -> bool {\n        matches!(self, Self::Store(_))\n    }\n}\n\nfn main() {\n    let error = ApiError::from(StoreError { code: \"store.timeout\" });\n    assert_eq!(error.status(), 503);\n    assert!(error.retryable());\n}",
          "list": [
            "Mark public error enums #[non_exhaustive] before 1.0, not after",
            "Give every variant a stable code string; alerting keys on codes, not prose",
            "Use #[from] for mechanical conversions, explicit constructors for semantic ones",
            "Wrap a source with #[source] so the chain survives; never format it into the message"
          ]
        },
        {
          "h": "Redaction and the Display contract",
          "p": [
            "Display is customer-facing text and it ends up in logs, tickets, and HTTP responses. That makes it the most likely place for a secret to leak: a URL containing an API key, a header echo, a token in a query string. Write Display as if it will be printed, and put the full detail - including the source chain - behind Debug or an explicit chain accessor.",
            "Retry classification belongs on the error, not in the caller. A single retryable() method, plus retry_after() where the upstream sent one, keeps every caller from re-deriving the same policy and getting it subtly different. The method must be conservative: retrying a non-idempotent operation on a timeout can duplicate a charge, so the error records whether the request was known to have been applied."
          ],
          "code": "use thiserror::Error;\n\n#[derive(Debug, Error)]\n#[non_exhaustive]\npub enum AuthError {\n    // Never include the token: this string reaches logs.\n    #[error(\"credentials rejected for user {user_id}\")]\n    Rejected { user_id: u64 },\n\n    #[error(\"auth backend unavailable\")]\n    Unavailable(#[source] Box<dyn std::error::Error + Send + Sync>),\n}\n\nimpl AuthError {\n    pub fn retry_after(&self) -> Option<std::time::Duration> {\n        match self {\n            Self::Unavailable(_) => Some(std::time::Duration::from_millis(250)),\n            _ => None,\n        }\n    }\n\n    /// Full detail for operators: Debug, not Display, and not in the HTTP body.\n    pub fn operator_detail(&self) -> String {\n        format!(\"{self:?}\")\n    }\n}\n\nfn main() {\n    let error = AuthError::Rejected { user_id: 42 };\n    assert_eq!(error.to_string(), \"credentials rejected for user 42\");\n    assert!(error.retry_after().is_none());\n    let detail = error.operator_detail();\n    assert!(detail.contains(\"Rejected\"));\n}"
        }
      ],
      "exercise": {
        "prompt": "Given an HTTP client that can fail with a connection reset, a 429, a 500, and a 400, design a ClientError enum with thiserror, a stable code(), and a retryable() that is false for the 400 and true for the other three.",
        "starter": "use thiserror::Error;\n\n#[derive(Debug, Error)]\npub enum ClientError {\n    // 1. connection reset (transient)\n    // 2. rate limited with a retry-after in seconds\n    // 3. server error with a status\n    // 4. bad request with a message from the server\n}\n\nimpl ClientError {\n    pub fn code(&self) -> &'static str { todo!() }\n    pub fn retryable(&self) -> bool { todo!() }\n}",
        "hint": "Four variants: Reset(#[source] std::io::Error), RateLimited { retry_after_s: u64 }, Server { status: u16 }, BadRequest(String). retryable matches the first three; code returns client.reset, client.rate_limited, client.server, client.bad_request.",
        "solution": "use std::time::Duration;\nuse thiserror::Error;\n\n#[derive(Debug, Error)]\n#[non_exhaustive]\npub enum ClientError {\n    #[error(\"connection reset\")]\n    Reset(#[source] std::io::Error),\n\n    #[error(\"rate limited, retry after {retry_after_s}s\")]\n    RateLimited { retry_after_s: u64 },\n\n    #[error(\"server error {status}\")]\n    Server { status: u16 },\n\n    #[error(\"bad request: {0}\")]\n    BadRequest(String),\n}\n\nimpl ClientError {\n    pub fn code(&self) -> &'static str {\n        match self {\n            Self::Reset(_) => \"client.reset\",\n            Self::RateLimited { .. } => \"client.rate_limited\",\n            Self::Server { .. } => \"client.server\",\n            Self::BadRequest(_) => \"client.bad_request\",\n        }\n    }\n\n    pub fn retryable(&self) -> bool {\n        !matches!(self, Self::BadRequest(_))\n    }\n\n    pub fn retry_after(&self) -> Option<Duration> {\n        match self {\n            Self::RateLimited { retry_after_s } => Some(Duration::from_secs(*retry_after_s)),\n            Self::Reset(_) | Self::Server { .. } => Some(Duration::from_millis(100)),\n            Self::BadRequest(_) => None,\n        }\n    }\n}\n\nfn main() {\n    let error = ClientError::RateLimited { retry_after_s: 3 };\n    assert_eq!(error.code(), \"client.rate_limited\");\n    assert!(error.retryable());\n    assert_eq!(error.retry_after(), Some(Duration::from_secs(3)));\n\n    let bad = ClientError::BadRequest(\"missing field\".to_string());\n    assert!(!bad.retryable());\n    assert_eq!(bad.retry_after(), None);\n}"
      },
      "questions": [
        {
          "q": "Why add #[non_exhaustive] to a public error enum?",
          "options": [
            "So new variants can be added in a minor release without breaking downstream matches",
            "So the enum cannot be constructed outside the crate",
            "So the enum gets a stable Display impl",
            "So the error implements std::error::Error automatically"
          ],
          "answer": 0,
          "explain": "Exhaustive matches on a public enum break whenever a variant is added. non_exhaustive forces a wildcard arm, which is what makes additive evolution semver-minor."
        },
        {
          "q": "What is the risk of using #[from] on two different source error types that map to one variant?",
          "options": [
            "The distinction between the causes is lost, so retry policy and diagnostics degrade",
            "The code fails to compile because From can only be derived once",
            "The source chain becomes cyclic",
            "Display starts returning an empty string"
          ],
          "answer": 0,
          "explain": "From collapses each source into the same variant. If the two causes need different retry behaviour or different operator messages, an explicit constructor that keeps them distinct is required."
        },
        {
          "q": "Where should retry classification live?",
          "options": [
            "On the error type, as a single retryable() method used by every caller",
            "In each caller, matching on status codes locally",
            "In the logging layer, by scanning the message text",
            "In the HTTP client's configuration file"
          ],
          "answer": 0,
          "explain": "One method keeps the policy consistent and testable. Duplicated classification per call site drifts, and text scanning is fragile against message changes."
        }
      ],
      "quickbytes": [
        "cargo semver-checks catches a new exhaustive enum variant as a breaking change.",
        "Log error.code(), never a parsed Display string.",
        "Display goes to users and logs: no tokens, no URLs with credentials.",
        "anyhow::Context::context() at each boundary keeps the chain readable in a binary."
      ],
      "production": [
        "Every public error enum is #[non_exhaustive] and every variant has a documented stable code() string.",
        "Display carries no secrets; the full source chain is available through Debug or an explicit accessor.",
        "Retry policy lives in one retryable()/retry_after() implementation with tests for each variant.",
        "Library errors are concrete enums; binaries use anyhow with context added at each layer boundary."
      ],
      "crates": [
        "thiserror",
        "anyhow"
      ],
      "github": [
        {
          "name": "dtolnay/thiserror",
          "url": "https://github.com/dtolnay/thiserror"
        },
        {
          "name": "dtolnay/anyhow",
          "url": "https://github.com/dtolnay/anyhow"
        }
      ],
      "pitfall": "Adding a variant to a public, exhaustive error enum in a patch release: every downstream exhaustive match fails to compile, and the failure surfaces as a broken build in someone else's repository.",
      "resources": [
        {
          "title": "thiserror: derive std::error::Error",
          "url": "https://docs.rs/thiserror/latest/thiserror/",
          "kind": "docs"
        },
        {
          "title": "anyhow: context-carrying application errors",
          "url": "https://docs.rs/anyhow/latest/anyhow/",
          "kind": "docs"
        },
        {
          "title": "The Cargo Book: semver compatibility",
          "url": "https://doc.rust-lang.org/cargo/reference/semver.html",
          "kind": "docs"
        },
        {
          "title": "dtolnay/thiserror repository",
          "url": "https://github.com/dtolnay/thiserror",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "r16",
      "title": "Custom allocators: GlobalAlloc and arenas",
      "minutes": 70,
      "level": "advanced",
      "goal": "Implement a GlobalAlloc wrapper that measures real allocation traffic, swap in a system allocator crate, and use an arena for request-scoped lifetimes.",
      "sections": [
        {
          "h": "GlobalAlloc is the stable hook",
          "p": [
            "Every Box, Vec, and Rc ultimately calls the global allocator, which you can replace with a static that implements GlobalAlloc. The trait has two required unsafe methods: alloc returns a pointer to layout.size() bytes aligned to layout.align(), or null on failure; dealloc receives a pointer and the exact layout it was allocated with. The layout match is not advisory - a mismatch is undefined behaviour inside the allocator.",
            "A wrapper around System is the smallest useful implementation, and it is the one to write first: it measures without changing behaviour. Track allocation count and bytes in atomics, then read them in a test or a metric endpoint. That measurement usually settles arguments about where memory pressure comes from faster than a profiler."
          ],
          "code": "use std::alloc::{GlobalAlloc, Layout, System};\nuse std::sync::atomic::{AtomicUsize, Ordering};\n\npub struct Counting;\n\nstatic ALLOCS: AtomicUsize = AtomicUsize::new(0);\nstatic BYTES: AtomicUsize = AtomicUsize::new(0);\n\nunsafe impl GlobalAlloc for Counting {\n    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {\n        ALLOCS.fetch_add(1, Ordering::Relaxed);\n        BYTES.fetch_add(layout.size(), Ordering::Relaxed);\n        // SAFETY: the exact layout is forwarded to the system allocator.\n        unsafe { System.alloc(layout) }\n    }\n\n    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {\n        // SAFETY: ptr and layout came from this allocator's alloc.\n        unsafe { System.dealloc(ptr, layout) }\n    }\n\n    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {\n        BYTES.fetch_add(new_size.saturating_sub(layout.size()), Ordering::Relaxed);\n        // SAFETY: forwarded unchanged to the system allocator.\n        unsafe { System.realloc(ptr, layout, new_size) }\n    }\n}\n\n#[global_allocator]\nstatic GLOBAL: Counting = Counting;\n\nfn main() {\n    let boxed = Box::new(42u64);\n    assert_eq!(*boxed, 42);\n    assert!(ALLOCS.load(Ordering::Relaxed) >= 1);\n    assert!(BYTES.load(Ordering::Relaxed) >= 8);\n}",
          "tip": "Implement realloc too. The default forwards to alloc plus copy plus dealloc, which doubles the allocation count your instrumentation reports and hides the real traffic."
        },
        {
          "h": "Swapping in a real system allocator",
          "p": [
            "jemalloc and mimalloc reduce fragmentation and lock contention under many threads, and both ship one-line global_allocator hooks. Measuring the difference requires the same workload before and after: peak RSS, allocation count, and wall time. A crate that allocates eight times per request rarely cares; a service with millions of small long-lived objects often does.",
            "Only one global allocator can exist per binary, and it does not apply to threads spawned before it is installed in some configurations. For a library, shipping a global_allocator is rude: it forces a choice on every downstream binary. Leave the hook to the application crate and document the recommended allocator in the README."
          ],
          "code": "use mimalloc::MiMalloc;\n\n// Application-level choice, not a library's business.\n#[global_allocator]\nstatic GLOBAL: MiMalloc = MiMalloc;\n\nfn main() {\n    let mut values = Vec::with_capacity(1024);\n    for i in 0..1024u64 {\n        values.push(i);\n    }\n    assert_eq!(values.len(), 1024);\n}\n\n// Measure, do not assume:\n//   hyperfine --warmup 3 './target/release/app workload.json'\n//   /usr/bin/time -l ./target/release/app workload.json   # macOS peak RSS\n//   /usr/bin/time -v ./target/release/app workload.json   # Linux peak RSS",
          "list": [
            "One global allocator per binary; last one linked wins if two crates set it",
            "Libraries expose an allocator choice, they do not impose one",
            "Peak RSS and allocation count matter more than throughput for most services",
            "A faster allocator does not fix an allocation-per-byte antipattern"
          ]
        },
        {
          "h": "Arenas: free everything at once",
          "p": [
            "A request-scoped workload allocates many small objects and frees them together. An arena turns that into bump allocation: one pointer, one region, and a reset that frees the whole region in constant time. Individual frees disappear, which removes both the allocator bookkeeping and the fragmentation.",
            "The trade is explicit: values in the arena are not dropped individually, so types with destructors either need bumpalo's boxed support or must not need Drop. Lifetimes make this safe - every value handed out borrows the arena, so the borrow checker prevents holding one across the reset. That is the pattern to reach for in a parser or a request handler, and the wrong pattern for long-lived caches."
          ],
          "code": "use bumpalo::Bump;\n\nstruct Request<'a> {\n    arena: &'a Bump,\n}\n\nimpl<'a> Request<'a> {\n    fn new(arena: &'a Bump) -> Self {\n        Self { arena }\n    }\n\n    /// One bump allocation for the whole payload, returned as a view.\n    fn parse(&self, input: &'a [u8]) -> &'a mut [u8] {\n        self.arena.alloc_slice_copy(input)\n    }\n}\n\nfn main() {\n    let arena = Bump::new();\n    {\n        let request = Request::new(&arena);\n        let copy = request.parse(b\"hello\");\n        assert_eq!(copy, b\"hello\");\n        copy[0] = b'H';\n    }\n    assert!(arena.allocated_bytes() > 0);\n\n    arena.reset(); // O(1): everything the request allocated is gone\n    assert_eq!(arena.allocated_bytes(), 0);\n}",
          "tip": "Reset the arena between requests, never mid-request, and never store a borrowed value in something that outlives the reset - the borrow checker will stop you, which is the point."
        }
      ],
      "exercise": {
        "prompt": "Write a BumpAlloc global allocator that hands out 8-byte-aligned slices from a 1 MiB static buffer and returns null when exhausted. It only needs to support allocations of 64 bytes or less.",
        "starter": "use std::alloc::{GlobalAlloc, Layout};\nuse std::cell::UnsafeCell;\nuse std::sync::atomic::{AtomicUsize, Ordering};\n\npub struct BumpAlloc {\n    buffer: UnsafeCell<[u8; 1 << 20]>,\n    offset: AtomicUsize,\n}\n\nunsafe impl GlobalAlloc for BumpAlloc {\n    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {\n        todo!()\n    }\n\n    unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}\n}",
        "hint": "Reject layout.size() > 64 and layout.align() > 8, then fetch_add a rounded-up size with compare_exchange to avoid overrunning. Return buffer.get() as *mut u8 plus the old offset, and null on overflow. dealloc is a no-op: a bump allocator never reclaims individual blocks.",
        "solution": "use std::alloc::{GlobalAlloc, Layout};\nuse std::cell::UnsafeCell;\nuse std::sync::atomic::{AtomicUsize, Ordering};\n\nconst CAPACITY: usize = 1 << 20;\n\npub struct BumpAlloc {\n    buffer: UnsafeCell<[u8; CAPACITY]>,\n    offset: AtomicUsize,\n}\n\n// SAFETY: the buffer is only handed out through alloc(), which reserves a\n// disjoint range before returning a pointer into it.\nunsafe impl Sync for BumpAlloc {}\n\nunsafe impl GlobalAlloc for BumpAlloc {\n    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {\n        if layout.size() > 64 || layout.align() > 8 {\n            return std::ptr::null_mut();\n        }\n        let size = (layout.size() + 7) & !7;\n        let mut current = self.offset.load(Ordering::Relaxed);\n        loop {\n            let next = match current.checked_add(size) {\n                Some(next) if next <= CAPACITY => next,\n                _ => return std::ptr::null_mut(),\n            };\n            match self.offset.compare_exchange_weak(current, next, Ordering::Relaxed, Ordering::Relaxed) {\n                Ok(_) => {\n                    // SAFETY: current..next is a reserved, disjoint range.\n                    let base = self.buffer.get().cast::<u8>();\n                    return unsafe { base.add(current) };\n                }\n                Err(observed) => current = observed,\n            }\n        }\n    }\n\n    unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {\n        // A bump allocator reclaims everything at once, never per block.\n    }\n}\n\nfn main() {\n    // In a real program: #[global_allocator] static A: BumpAlloc = BumpAlloc::new();\n    let alloc = BumpAlloc { buffer: UnsafeCell::new([0; CAPACITY]), offset: AtomicUsize::new(0) };\n    let layout = Layout::from_size_align(16, 8).unwrap();\n    // SAFETY: layout is within the supported limits above.\n    let ptr = unsafe { alloc.alloc(layout) };\n    assert!(!ptr.is_null());\n}"
      },
      "questions": [
        {
          "q": "What does dealloc require about its Layout argument?",
          "options": [
            "It must be the same layout the allocation was made with",
            "It must have size rounded up to the next power of two",
            "It may be any layout as long as the pointer matches",
            "It is ignored by every allocator implementation"
          ],
          "answer": 0,
          "explain": "The allocator uses size and align to return the block to the right bin. A mismatched layout corrupts the allocator's metadata and is undefined behaviour, not a leak."
        },
        {
          "q": "Why should a library crate not install a #[global_allocator]?",
          "options": [
            "Because the binary owns that choice, and a library forcing it breaks downstream builds",
            "Because only binaries can implement GlobalAlloc",
            "Because the attribute is unstable",
            "Because it disables jemalloc"
          ],
          "answer": 0,
          "explain": "Only one global allocator can be linked. A library that sets it silently forces every consumer, and two libraries doing so fail to link."
        },
        {
          "q": "What is the main constraint of arena allocation?",
          "options": [
            "Values are freed together at reset, so they cannot outlive the arena or need individual Drop",
            "Allocations must be smaller than 4 KiB",
            "The arena cannot be used across threads",
            "Every value must implement Copy"
          ],
          "answer": 0,
          "explain": "The arena hands out borrows tied to its lifetime and resets in bulk. That rules out values that must outlive it and makes per-value destructors an explicit choice."
        }
      ],
      "quickbytes": [
        "cargo +nightly rustc --release -- -Zprint-type-sizes   # per-type layout sizes",
        "Implement realloc in a counting allocator or the numbers double-count.",
        "#[global_allocator] is unstable in libraries, acceptable in applications.",
        "Arena reset is O(1); that is the entire performance claim."
      ],
      "production": [
        "Allocation counting or a heap profiler runs in staging, so per-request allocation growth is visible before it is an incident.",
        "The global allocator is chosen by the application crate and recorded in an ADR with the measured RSS and latency numbers.",
        "Arena lifetimes are tied to a request scope and never stored in anything that outlives the reset.",
        "The allocator wrapper forwards realloc and alloc_zeroed rather than relying on the trait defaults."
      ],
      "crates": [
        "bumpalo",
        "mimalloc"
      ],
      "github": [
        {
          "name": "fitzgen/bumpalo",
          "url": "https://github.com/fitzgen/bumpalo"
        },
        {
          "name": "microsoft/mimalloc",
          "url": "https://github.com/microsoft/mimalloc"
        }
      ],
      "pitfall": "Deallocating with a different Layout than the allocation used, or returning a pointer that is not aligned to layout.align(): the allocator's own metadata is corrupted and the crash appears inside malloc, far from the bug.",
      "resources": [
        {
          "title": "std::alloc::GlobalAlloc",
          "url": "https://doc.rust-lang.org/std/alloc/trait.GlobalAlloc.html",
          "kind": "docs"
        },
        {
          "title": "std::alloc::Allocator (nightly)",
          "url": "https://doc.rust-lang.org/std/alloc/trait.Allocator.html",
          "kind": "docs"
        },
        {
          "title": "bumpalo: a fast bump allocation arena",
          "url": "https://docs.rs/bumpalo/latest/bumpalo/",
          "kind": "docs"
        },
        {
          "title": "fitzgen/bumpalo repository",
          "url": "https://github.com/fitzgen/bumpalo",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "r17",
      "title": "Build scripts: codegen, env vars, host vs target",
      "minutes": 50,
      "level": "core",
      "goal": "Emit only the cargo directives you need, bake build metadata into the binary, and stop confusing the host machine with the cross-compilation target.",
      "sections": [
        {
          "h": "stdout is the API",
          "p": [
            "Cargo compiles build.rs for the host, runs it before your crate, and parses stdout for lines beginning with cargo::. Since Cargo 1.77 the directive syntax is cargo::rerun-if-changed=...; the older single-colon form still works for compatibility. A non-zero exit status fails the build, and the script's output is hidden unless you pass -vv.",
            "By default the script re-runs whenever any file in the package changes, which is why every script should emit at least one rerun-if directive. rerun-if-changed watches a path (mtime-based), rerun-if-env-changed watches a variable, and neither is a dependency tracker: if your generator reads a file, you must name that file or the build silently uses stale output."
          ],
          "code": "// build.rs\nuse std::process::Command;\n\nfn main() {\n    println!(\"cargo::rerun-if-changed=proto/frame.proto\");\n    println!(\"cargo::rerun-if-env-changed=ACME_BUILD_ID\");\n\n    // Bake metadata into the crate: read it with env!(\"ACME_GIT_REV\").\n    let rev = Command::new(\"git\")\n        .args([\"rev-parse\", \"--short\", \"HEAD\"])\n        .output()\n        .ok()\n        .filter(|out| out.status.success())\n        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())\n        .unwrap_or_else(|| \"unknown\".to_string());\n    println!(\"cargo::rustc-env=ACME_GIT_REV={rev}\");\n\n    // Custom cfgs must be declared, or unexpected_cfgs warns on every build.\n    println!(\"cargo::rustc-check-cfg=cfg(acme_has_avx2)\");\n    if std::env::var(\"CARGO_CFG_TARGET_ARCH\").as_deref() == Ok(\"x86_64\") {\n        println!(\"cargo::rustc-cfg=acme_has_avx2\");\n    }\n}",
          "tip": "cargo::rustc-check-cfg is respected from Rust 1.80. Without it, every custom cfg produces an unexpected_cfgs warning and CI noise that hides real warnings."
        },
        {
          "h": "Host versus target is the classic bug",
          "p": [
            "cfg!(target_os = \"linux\") inside build.rs asks about the machine running the build, not the machine that will run the binary. Cross-compiling for aarch64 from an x86_64 laptop takes the wrong branch and links the wrong library. The build script must read CARGO_CFG_TARGET_OS, CARGO_CFG_TARGET_ARCH, CARGO_CFG_TARGET_ENV, and friends, which Cargo sets to the target's values.",
            "The same distinction decides which tools you can execute. A build script runs on the host, so it may compile a C library with the target's cross-compiler, but it must not run the produced binary. Anything that probes the target by executing code - configure-style feature tests - breaks under cross-compilation and needs an explicit override variable."
          ],
          "code": "// build.rs - correct target detection\nfn main() {\n    let target_os = std::env::var(\"CARGO_CFG_TARGET_OS\").unwrap_or_default();\n    let target_arch = std::env::var(\"CARGO_CFG_TARGET_ARCH\").unwrap_or_default();\n\n    println!(\"cargo::rustc-check-cfg=cfg(acme_linux_socket)\");\n    if target_os == \"linux\" {\n        println!(\"cargo::rustc-cfg=acme_linux_socket\");\n    }\n\n    // Vendor flags must match the target, not the host.\n    if target_arch == \"aarch64\" {\n        println!(\"cargo::rustc-link-arg=-Wl,--hash-style=gnu\");\n    }\n\n    // Let packagers override a probe that cannot run under cross-compilation.\n    let has_kvm = std::env::var(\"ACME_HAS_KVM\").map(|v| v == \"1\").unwrap_or(false);\n    println!(\"cargo::rustc-check-cfg=cfg(acme_has_kvm)\");\n    if has_kvm {\n        println!(\"cargo::rustc-cfg=acme_has_kvm\");\n    }\n}",
          "list": [
            "cfg! in build.rs reads the host; CARGO_CFG_TARGET_* reads the target",
            "A build script may execute host tools, never the target binary",
            "Declare every custom cfg with cargo::rustc-check-cfg",
            "Provide an env override for any probe that requires running code"
          ]
        },
        {
          "h": "Native linking and DEP_ metadata",
          "p": [
            "For a C dependency, the -sys convention is: a build script links the library with rustc-link-lib and rustc-link-search, the package declares links = \"acme\" so Cargo allows only one package linking that native library, and the script publishes metadata that dependents receive as DEP_ACME_* environment variables.",
            "That metadata channel is how a dependent crate's build script learns where the headers and artefacts actually landed, without hard-coding a path. The cc crate handles the common case of compiling bundled C source, including the jobserver so parallel builds do not oversubscribe the CPU."
          ],
          "code": "# acme-sys/Cargo.toml\n[package]\nname = \"acme-sys\"\nlinks = \"acme\"\nbuild = \"build.rs\"\n\n# acme-sys/build.rs\nfn main() {\n    println!(\"cargo::rerun-if-changed=csrc/acme.c\");\n    println!(\"cargo::rustc-link-lib=static=acme\");\n    println!(\"cargo::rustc-link-search=native=/opt/acme/lib\");\n    println!(\"cargo::metadata=include=/opt/acme/include\"); // -> DEP_ACME_INCLUDE\n}\n\n# consumer/build.rs\nfn main() {\n    let include = std::env::var(\"DEP_ACME_INCLUDE\")\n        .expect(\"acme-sys must be built before this crate\");\n    println!(\"cargo::rerun-if-env-changed=DEP_ACME_INCLUDE\");\n    println!(\"cargo::rustc-env=ACME_INCLUDE={include}\");\n}",
          "tip": "links = \"acme\" also makes the package overridable from .cargo/config.toml, which is how distributors point the build at a system library instead of compiling a vendored copy."
        }
      ],
      "exercise": {
        "prompt": "Write a build script for a crate that generates a Rust file from a JSON schema in schema/, writes it to OUT_DIR, and fails the build with a readable message when the schema file is missing.",
        "starter": "// build.rs\nuse std::path::PathBuf;\n\nfn main() {\n    let out = PathBuf::from(std::env::var(\"OUT_DIR\").expect(\"OUT_DIR\"));\n    let schema = PathBuf::from(\"schema/protocol.json\");\n    // 1. rerun-if-changed on the schema\n    // 2. read it, or fail with a clear message\n    // 3. generate out/protocol.rs and include! it from src/lib.rs\n}",
        "hint": "println!(\"cargo::rerun-if-changed={}\", schema.display()); then std::fs::read_to_string(&schema).unwrap_or_else(|e| panic!(\"cannot read {}: {e}\", schema.display())); write with std::fs::write and include!(concat!(env!(\"OUT_DIR\"), \"/protocol.rs\"));",
        "solution": "// build.rs\nuse std::path::PathBuf;\n\nfn main() {\n    println!(\"cargo::rerun-if-changed=schema/protocol.json\");\n\n    let out_dir = PathBuf::from(std::env::var(\"OUT_DIR\").expect(\"OUT_DIR is set by cargo\"));\n    let schema_path = PathBuf::from(\"schema/protocol.json\");\n    let schema = std::fs::read_to_string(&schema_path).unwrap_or_else(|error| {\n        panic!(\"cannot read {}: {error}\", schema_path.display())\n    });\n\n    // A real generator would parse the schema; this keeps the example honest.\n    let generated = format!(\n        \"pub const SCHEMA_LEN: usize = {};\\npub const SCHEMA_NAME: &str = \\\"protocol\\\";\\n\",\n        schema.len()\n    );\n\n    let target = out_dir.join(\"protocol.rs\");\n    std::fs::write(&target, generated)\n        .unwrap_or_else(|error| panic!(\"cannot write {}: {error}\", target.display()));\n}\n\n// src/lib.rs\n// include!(concat!(env!(\"OUT_DIR\"), \"/protocol.rs\"));\n//\n// fn main() {\n//     assert!(SCHEMA_LEN > 0);\n//     assert_eq!(SCHEMA_NAME, \"protocol\");\n// }"
      },
      "questions": [
        {
          "q": "Which directive makes a build script re-run when a proto file changes?",
          "options": [
            "cargo::rerun-if-changed=proto/frame.proto",
            "cargo::rustc-link-arg=proto/frame.proto",
            "cargo::rustc-env=PROTO=proto/frame.proto",
            "cargo::metadata=proto=proto/frame.proto"
          ],
          "answer": 0,
          "explain": "rerun-if-changed watches the path's mtime. Without it Cargo falls back to watching the whole package, which is slower and still not a guarantee for files outside it."
        },
        {
          "q": "Why does cfg!(target_os = \"linux\") misbehave in build.rs when cross-compiling?",
          "options": [
            "It evaluates the host's cfg, not the target's",
            "It is not allowed in build scripts at all",
            "It only works on nightly",
            "It returns false unless the target is explicitly set in Cargo.toml"
          ],
          "answer": 0,
          "explain": "The build script is compiled and run for the host. Target properties come from CARGO_CFG_TARGET_OS and friends, which Cargo sets per target."
        },
        {
          "q": "What does the links key in a package manifest do?",
          "options": [
            "Declares the native library the package links and enables metadata passing via DEP_* variables",
            "Lists the Rust crates the package links against",
            "Points the linker at a search path",
            "Marks the package as a build dependency"
          ],
          "answer": 0,
          "explain": "links = \"acme\" allows at most one package to link libacme, enables cargo::metadata to reach dependents as DEP_ACME_*, and makes the build overridable for distributors."
        }
      ],
      "quickbytes": [
        "cargo build -vv   # the only way to read build script output",
        "echo \"cargo::rerun-if-changed=build.rs\" silences the whole-package rescan.",
        "CARGO_CFG_TARGET_OS and CARGO_CFG_TARGET_ARCH describe the target, not the host.",
        "cargo::error=MESSAGE fails the build with a readable message (Rust 1.84)."
      ],
      "production": [
        "Every build script emits rerun-if-changed for each input it reads, so incremental builds cannot reuse stale generated output.",
        "Target detection reads CARGO_CFG_TARGET_* and never cfg! or the host triple.",
        "Custom cfgs are declared with cargo::rustc-check-cfg so unexpected_cfgs stays meaningful.",
        "Native dependencies follow the -sys convention with links, and the metadata reaches dependents through DEP_* variables."
      ],
      "crates": [
        "cc",
        "build-rs"
      ],
      "github": [
        {
          "name": "rust-lang/cc-rs",
          "url": "https://github.com/rust-lang/cc-rs"
        }
      ],
      "pitfall": "A build script that emits no rerun-if-changed input: Cargo re-scans the package on every build, and files outside the package (a vendored proto, a system header) change without triggering a rebuild, so the binary silently keeps stale generated code.",
      "resources": [
        {
          "title": "The Cargo Book: build scripts",
          "url": "https://doc.rust-lang.org/cargo/reference/build-scripts.html",
          "kind": "docs"
        },
        {
          "title": "The Cargo Book: build script examples",
          "url": "https://doc.rust-lang.org/cargo/reference/build-script-examples.html",
          "kind": "docs"
        },
        {
          "title": "rust-lang/cc-rs: compile C in build scripts",
          "url": "https://github.com/rust-lang/cc-rs",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "r18",
      "title": "Feature flags and semver discipline",
      "minutes": 60,
      "level": "industry",
      "goal": "Design additive features that survive unification, use dep: and weak features correctly, and know which changes are actually breaking.",
      "sections": [
        {
          "h": "Features are additive, because unification says so",
          "p": [
            "Cargo features are a union, not a choice. If two crates in the graph depend on yours with different features, the build gets both. Mutually exclusive features such as runtime-tokio and runtime-async-std therefore break as soon as a second dependency enables the other one, and the failure is a compile error in someone else's crate. The resolver's version-aware unification (resolver = \"2\" and \"3\") fixes the dev/build/target split, not mutual exclusion.",
            "Additive design means every feature only ever adds capability. A feature must never remove an impl, change a public type, or select one of two backends. If you genuinely need either-or, ship two crates or make the choice a generic parameter, because the graph will eventually enable both."
          ],
          "code": "# Cargo.toml - additive features only\n[features]\ndefault = [\"std\"]\nstd = [\"alloc\", \"serde?/std\"]      # weak: only if serde is already on\nalloc = []\nserde = [\"dep:serde\"]              # dep: hides the implicit feature\n\n[dependencies]\nserde = { version = \"1\", optional = true, default-features = false }\n\n# src/lib.rs\n#![cfg_attr(not(feature = \"std\"), no_std)]\n\n#[cfg(feature = \"alloc\")]\nextern crate alloc;\n\n#[cfg(feature = \"serde\")]\nmod serde_impls {\n    // impls that only exist when the feature is on: purely additive\n}",
          "tip": "serde?/std is a weak activation: it enables serde's std feature only when serde itself is already enabled, so your std feature does not silently pull in an optional dependency."
        },
        {
          "h": "What actually breaks semver",
          "p": [
            "The Cargo semver reference is the authority, and it is longer than most people expect. Adding a public item, adding a variant to a #[non_exhaustive] enum, and adding an inherent method are minor. Adding a variant to an exhaustive enum, adding a required trait method, adding a field to a struct with all-public fields, tightening a generic bound, and changing a trait's associated type are all major, because they break downstream compilation.",
            "An MSRV bump is a semver decision too. Raising the minimum supported Rust version is a minor change by Cargo's rules and a breaking change for anyone on the old toolchain, so it belongs in the changelog with the exact version, and CI should build with that pinned toolchain. Enforce all of this mechanically: cargo-semver-checks compares your public API against the published release, and cargo-hack builds the feature powerset so a combination does not rot."
          ],
          "code": "# CI: fail the build on a semver violation, then prove features compose.\ncargo install cargo-semver-checks --locked\ncargo semver-checks check-release\n\n# Build every meaningful feature combination (bounded, so CI stays fast).\ncargo install cargo-hack --locked\ncargo hack check --feature-powerset --depth 2\n\n# MSRV job: the exact toolchain from the README, not stable.\nrustup toolchain install 1.85.0 --profile minimal\ncargo +1.85.0 check --all-features\n\n# Docs must show the cfg gates, or users cannot tell what is optional.\nRUSTDOCFLAGS=\"--cfg docsrs\" cargo +nightly doc --all-features",
          "list": [
            "Adding a public item: minor. Removing or renaming one: major.",
            "New enum variant: minor only with #[non_exhaustive]",
            "New required trait method: major unless it has a default",
            "Tightening a bound or bumping MSRV: announce it in the changelog"
          ]
        },
        {
          "h": "Test the matrix, not the happy path",
          "p": [
            "Feature bugs are invisible in the default build. The failure appears when a downstream user disables default features, or enables two crates that each turn on a different feature. Two cheap CI jobs catch nearly all of it: build with --no-default-features, and build the powerset with cargo-hack.",
            "Document each feature in the crate docs with a table of what it enables and what it costs, and mark feature-gated items with doc(cfg) so docs.rs shows the badge. A user deciding whether to enable something should not have to read the source."
          ],
          "code": "// src/lib.rs - make the gates visible in documentation\n#![cfg_attr(docsrs, feature(doc_cfg))]\n\n#[cfg(feature = \"serde\")]\n#[cfg_attr(docsrs, doc(cfg(feature = \"serde\")))]\npub fn to_json<T: serde::Serialize>(value: &T) -> String {\n    serde_json::to_string(value).expect(\"serialization is infallible for this type\")\n}\n\n/// # Features\n///\n/// | feature | default | enables |\n/// |---------|---------|---------|\n/// | `std`   | yes     | std + serde/std |\n/// | `alloc` | no      | `alloc` types in no_std builds |\n/// | `serde` | no      | serde impls for the public types |\npub struct Frame {\n    pub kind: u8,\n}\n\nfn main() {\n    // The doc table above is the contract; the cfg gates are the proof.\n    let _ = Frame { kind: 1 };\n}",
          "tip": "docs.rs builds with --all-features by default. A feature that does not compile on its own will break your documentation build before it breaks a user."
        }
      ],
      "exercise": {
        "prompt": "Given a crate with an optional serde dependency and a std feature, restructure the manifest so that (a) no implicit serde feature is exposed, (b) enabling std does not force serde on, and (c) disabling default features still compiles.",
        "starter": "[features]\ndefault = []\nstd = []\n\n[dependencies]\nserde = { version = \"1\", optional = true }",
        "hint": "Use serde = [\"dep:serde\"] to hide the implicit feature, std = [\"alloc\", \"serde?/std\"] for the weak activation, and add #![cfg_attr(not(feature = \"std\"), no_std)] plus a CI job with --no-default-features.",
        "solution": "[features]\ndefault = [\"std\"]\nstd = [\"alloc\", \"serde?/std\"]\nalloc = []\nserde = [\"dep:serde\"]\n\n[dependencies]\nserde = { version = \"1\", optional = true, default-features = false }\n\n# src/lib.rs\n#![cfg_attr(not(feature = \"std\"), no_std)]\n\n#[cfg(feature = \"alloc\")]\nextern crate alloc;\n\n// The derive is conditional; the type is defined once.\n#[cfg_attr(feature = \"serde\", derive(serde::Serialize))]\npub struct Wire {\n    pub kind: u8,\n}\n\npub fn kind_of(wire: &Wire) -> u8 {\n    wire.kind\n}\n\n#[cfg(feature = \"serde\")]\nimpl Wire {\n    pub fn to_json(&self) -> String {\n        serde_json::to_string(self).expect(\"Wire has no failing fields\")\n    }\n}\n\nfn main() {\n    let wire = Wire { kind: 3 };\n    assert_eq!(kind_of(&wire), 3);\n}\n\n// CI, both legs:\n//   cargo check --no-default-features\n//   cargo hack check --feature-powerset --depth 2"
      },
      "questions": [
        {
          "q": "Why are mutually exclusive features such as runtime-tokio / runtime-async-std unsafe to publish?",
          "options": [
            "Feature unification unions them, so a second dependency can enable both and break the build",
            "Cargo rejects manifests with two default features",
            "They make the crate fail to compile on Windows",
            "They disable the resolver"
          ],
          "answer": 0,
          "explain": "Features are additive across the whole graph. Two crates requesting different features get the union, so an either-or design fails in exactly the situation it was meant to avoid."
        },
        {
          "q": "Which change is semver-major for a published crate?",
          "options": [
            "Adding a required method to a public trait that has no default",
            "Adding an inherent method to a public type",
            "Adding a new public module",
            "Adding a variant to a #[non_exhaustive] enum"
          ],
          "answer": 0,
          "explain": "Every external implementor of the trait stops compiling. The other three are additive and allowed in a minor release."
        },
        {
          "q": "What does the dep: prefix in a feature list change?",
          "options": [
            "It enables the optional dependency without exposing an implicit feature of the same name",
            "It marks the dependency as a build dependency",
            "It makes the dependency optional at link time only",
            "It pins the dependency to the exact version"
          ],
          "answer": 0,
          "explain": "Without dep:, an optional dependency automatically creates a feature with its own name. dep: suppresses that so your feature names and dependency names stay decoupled."
        }
      ],
      "quickbytes": [
        "cargo semver-checks check-release   # public API diff against the published version",
        "cargo hack check --feature-powerset --depth 2   # bounded combination testing",
        "cargo check --no-default-features catches the no_std break early.",
        "Every MSRV bump is a changelog entry with the exact toolchain version."
      ],
      "production": [
        "CI runs cargo-semver-checks against the last published version and fails on a major change without a version bump.",
        "Feature powerset checks with cargo hack cover the combinations users actually request, with a bounded depth for runtime.",
        "Every feature is documented in a table with its default state and what it enables or costs.",
        "The MSRV is pinned in CI and tested on every pull request, so a dependency bump cannot silently raise it."
      ],
      "crates": [
        "cargo-semver-checks",
        "cargo-hack",
        "serde"
      ],
      "github": [
        {
          "name": "obi1kenobi/cargo-semver-checks",
          "url": "https://github.com/obi1kenobi/cargo-semver-checks"
        },
        {
          "name": "taiki-e/cargo-hack",
          "url": "https://github.com/taiki-e/cargo-hack"
        }
      ],
      "pitfall": "Shipping runtime-tokio and runtime-async-std as two default-off features: the moment one dependency enables both, the crate compiles both backends and the build fails with conflicting impls that the user cannot fix.",
      "resources": [
        {
          "title": "The Cargo Book: features",
          "url": "https://doc.rust-lang.org/cargo/reference/features.html",
          "kind": "docs"
        },
        {
          "title": "The Cargo Book: semver compatibility",
          "url": "https://doc.rust-lang.org/cargo/reference/semver.html",
          "kind": "docs"
        },
        {
          "title": "cargo-semver-checks: automated API break detection",
          "url": "https://github.com/obi1kenobi/cargo-semver-checks",
          "kind": "repo"
        },
        {
          "title": "cargo-hack: test feature combinations",
          "url": "https://github.com/taiki-e/cargo-hack",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "r19",
      "title": "Generic performance: monomorphization and code size",
      "minutes": 65,
      "level": "industry",
      "goal": "Explain what a generic actually costs in code size, collapse duplicated instantiations behind one inner function, and measure the bloat instead of guessing.",
      "sections": [
        {
          "h": "Zero-cost means zero runtime overhead, not zero code",
          "p": [
            "A generic function is compiled once per concrete type it is called with. That is what makes it fast: the callee sees the real type, inlines, and specializes branches that only one type can take. The bill arrives as binary size and compile time, and on a large codebase it shows up as instruction-cache misses long before it shows up in a benchmark.",
            "The pathological case is a generic pipeline called with twenty types, each inlining a hundred lines of shared machinery. Ten thousand lines of machine code for a function whose behaviour is identical in every instantiation. The fix is not to abandon generics; it is to move the shared work into a non-generic function and keep the generic layer thin."
          ],
          "code": "/// Generic shell: inlines into the caller and sees the concrete type.\n#[inline]\npub fn checksum<T: AsRef<[u8]>>(input: T) -> u32 {\n    checksum_bytes(input.as_ref())\n}\n\n/// One compiled body for every T, because it takes a concrete slice.\n#[inline(never)]\nfn checksum_bytes(bytes: &[u8]) -> u32 {\n    let mut hash = 0x811c_9dc5u32;\n    for byte in bytes {\n        hash ^= u32::from(*byte);\n        hash = hash.wrapping_mul(0x0100_0193);\n    }\n    hash\n}\n\nfn main() {\n    assert_eq!(checksum(\"abc\"), checksum_bytes(b\"abc\"));\n    assert_eq!(checksum(vec![b'a', b'b', b'c']), checksum_bytes(b\"abc\"));\n}",
          "tip": "#[inline] on a thin wrapper is usually redundant - generic functions are already inlinable - but it documents the intent and survives a move to a different codegen unit."
        },
        {
          "h": "The release profile decides how much inlining you get",
          "p": [
            "Inlining across crates needs either #[inline] or LTO, because a generic instantiated in your crate cannot be optimized with knowledge of the defining crate otherwise. codegen-units = 1 gives the optimizer the whole crate at once at the cost of parallelism; thin LTO is the usual middle ground for a binary, and fat LTO is worth measuring rather than assuming.",
            "panic = \"abort\" removes landing pads and typically shrinks a release binary by a noticeable fraction, at the cost of catch_unwind and of unwinding to a supervisor. Every one of these knobs is a measurement, not a default to copy: change one, run the benchmark and the binary-size check, keep it only if the number moved."
          ],
          "code": "# Cargo.toml - a profile you can actually measure\n[profile.release]\nlto = \"thin\"\ncodegen-units = 1\ndebug = 1            # line tables for profiles, not full type info\nstrip = \"none\"\npanic = \"abort\"\n\n# [profile.bench] inherits release; keep debug info for flamegraphs.\n[profile.bench]\ndebug = 1\n\n# Measure the instantiation count, not the vibe:\ncargo install cargo-llvm-lines --locked\ncargo llvm-lines --release | head -20\ncargo llvm-lines --release | sort -n -r | head -10   # worst offenders first",
          "list": [
            "codegen-units = 1 trades parallel codegen for better inlining",
            "panic = \"abort\" removes unwinding; catch_unwind stops working",
            "debug = 1 keeps line tables without the full debug bloat",
            "cargo llvm-lines reports lines of LLVM IR per function, sorted by cost"
          ]
        },
        {
          "h": "Benchmark the abstraction, do not assume it",
          "p": [
            "An iterator chain over a slice usually compiles to the same loop you would have written by hand. Usually is the operative word: an extra allocation, a boxed closure, or a dyn call in the middle changes everything. The way to know is a criterion benchmark with the two implementations side by side and black_box around the inputs.",
            "black_box is not a fairness knob, it is an optimization barrier: it stops the compiler from hoisting the whole computation out of the loop because the result is unused. Wrap the inputs and the output, keep the measurement identical between variants, and report the confidence interval rather than the mean."
          ],
          "code": "use criterion::{criterion_group, criterion_main, Criterion};\n\nfn total_iter(data: &[u32]) -> u64 {\n    data.iter().filter(|v| **v & 1 == 0).map(|v| u64::from(*v)).sum()\n}\n\nfn total_loop(data: &[u32]) -> u64 {\n    let mut sum = 0u64;\n    for value in data {\n        if value & 1 == 0 {\n            sum += u64::from(*value);\n        }\n    }\n    sum\n}\n\nfn bench(c: &mut Criterion) {\n    let data: Vec<u32> = (0..100_000).collect();\n    let mut group = c.benchmark_group(\"filter_sum\");\n    group.bench_function(\"iterator\", |b| {\n        b.iter(|| total_iter(std::hint::black_box(&data)))\n    });\n    group.bench_function(\"loop\", |b| {\n        b.iter(|| total_loop(std::hint::black_box(&data)))\n    });\n    group.finish();\n}\n\ncriterion_group!(benches, bench);\ncriterion_main!(benches);",
          "tip": "If two variants differ by less than a few percent, they are the same code. Check the assembly before writing a comment claiming one is faster."
        }
      ],
      "exercise": {
        "prompt": "Refactor a generic encode<T: AsRef<[u8]>>(value: T) -> Vec<u8> that is instantiated with 12 types into a thin generic wrapper plus one non-generic inner function, then measure the change with cargo llvm-lines.",
        "starter": "#[inline]\npub fn encode<T: AsRef<[u8]>>(value: T) -> Vec<u8> {\n    let bytes = value.as_ref();\n    let mut out = Vec::with_capacity(bytes.len() + 5);\n    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());\n    out.push(1);\n    out.extend_from_slice(bytes);\n    out\n}\n\n// 1. move the body into fn encode_bytes(bytes: &[u8]) -> Vec<u8>\n// 2. keep the generic wrapper #[inline]\n// 3. mark the inner function #[inline(never)] and re-measure",
        "hint": "The wrapper becomes encode(value.as_ref()) and the body moves unchanged into encode_bytes. Run cargo llvm-lines --release twice and compare the total line count and the Copies column for encode.",
        "solution": "#[inline]\npub fn encode<T: AsRef<[u8]>>(value: T) -> Vec<u8> {\n    encode_bytes(value.as_ref())\n}\n\n#[inline(never)]\nfn encode_bytes(bytes: &[u8]) -> Vec<u8> {\n    let mut out = Vec::with_capacity(bytes.len() + 5);\n    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());\n    out.push(1);\n    out.extend_from_slice(bytes);\n    out\n}\n\nfn main() {\n    let from_str = encode(\"hi\");\n    let from_vec = encode(vec![b'h', b'i']);\n    assert_eq!(from_str, from_vec);\n    assert_eq!(from_str, vec![0, 0, 0, 2, 1, b'h', b'i']);\n}\n\n// Measure before and after:\n//   cargo llvm-lines --release | grep encode_bytes\n// Before: one copy per T (Copies column > 1). After: Copies = 1."
      },
      "questions": [
        {
          "q": "What does monomorphization mean for a generic function used with 12 types?",
          "options": [
            "Twelve machine-code copies, each specialized and each inlinable into its caller",
            "One copy with a runtime type tag",
            "One copy plus a vtable per type",
            "Twelve copies only when LTO is enabled"
          ],
          "answer": 0,
          "explain": "The compiler instantiates the generic per concrete type. That is the source of inlining and specialization, and the source of the code-size bill."
        },
        {
          "q": "Why move the shared body into a non-generic inner function?",
          "options": [
            "So the algorithm is compiled once and only the thin wrapper is duplicated per type",
            "Because generic functions cannot be inlined",
            "Because non-generic functions are always faster",
            "Because it removes the need for trait bounds"
          ],
          "answer": 0,
          "explain": "The inner function takes a concrete type such as &[u8], so it has a single instantiation. The generic layer stays small and still inlines the conversion."
        },
        {
          "q": "What is std::hint::black_box for in a benchmark?",
          "options": [
            "It prevents the optimizer from removing work whose result is unused",
            "It makes the code run on a fixed CPU frequency",
            "It disables bounds checks in the measured loop",
            "It forces the function to be inlined"
          ],
          "answer": 0,
          "explain": "black_box is an optimization barrier. Without it the compiler may fold or delete the entire computation, and the benchmark measures nothing."
        }
      ],
      "quickbytes": [
        "cargo llvm-lines --release | sort -n -r | head   # find the most expensive generics",
        "cargo bloat --release --crates   # binary size per crate, when the size is the problem",
        "A few percent difference in a criterion report is noise; check the assembly.",
        "panic = \"abort\" shrinks binaries and removes catch_unwind - decide which you need."
      ],
      "production": [
        "Binary size and compile time are tracked over time, not discovered when the release build times out.",
        "Generic public APIs considered hot have a thin wrapper and one monomorphic inner function, verified with cargo llvm-lines.",
        "Release profile settings (LTO, codegen-units, panic strategy) are recorded with the measurement that justified each one.",
        "Benchmark suites use black_box consistently and are run on the same machine class as the regression baseline."
      ],
      "crates": [
        "cargo-llvm-lines",
        "criterion"
      ],
      "github": [
        {
          "name": "dtolnay/cargo-llvm-lines",
          "url": "https://github.com/dtolnay/cargo-llvm-lines"
        },
        {
          "name": "bheisler/criterion.rs",
          "url": "https://github.com/bheisler/criterion.rs"
        }
      ],
      "pitfall": "A generic pipeline instantiated once per message type, each instantiation inlining the same serde and formatting machinery: the binary grows by megabytes and every change recompiles the whole matrix.",
      "resources": [
        {
          "title": "The Cargo Book: release profiles",
          "url": "https://doc.rust-lang.org/cargo/reference/profiles.html",
          "kind": "docs"
        },
        {
          "title": "The Rust Reference: codegen attributes (#[inline])",
          "url": "https://doc.rust-lang.org/reference/attributes/codegen.html",
          "kind": "docs"
        },
        {
          "title": "cargo-llvm-lines: count LLVM IR per function",
          "url": "https://github.com/dtolnay/cargo-llvm-lines",
          "kind": "repo"
        },
        {
          "title": "criterion: statistics-driven benchmarking",
          "url": "https://docs.rs/criterion/latest/criterion/",
          "kind": "docs"
        },
        {
          "title": "bheisler/criterion.rs repository",
          "url": "https://github.com/bheisler/criterion.rs",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "r20",
      "title": "Profiling type-level abstractions",
      "minutes": 75,
      "level": "industry",
      "goal": "Build a release profile that produces usable symbols, read a flamegraph honestly, and prove that an abstraction was optimized away instead of trusting the claim.",
      "sections": [
        {
          "h": "A profile you can actually read",
          "p": [
            "A stripped release binary with no debug info produces a flamegraph of addresses and a perf report full of unknown symbols. debug = 1 keeps line tables, which is enough for symbolisation and far smaller than full debug info. Keep strip = \"none\" in the profiling profile specifically, and separate that from the shipped profile.",
            "Frame pointers matter on x86_64: without them the unwinder guesses and attributes time to the wrong frame. RUSTFLAGS=\"-C force-frame-pointers=yes\" costs a register and buys a trustworthy stack. On macOS, samply is usually easier than perf, and it opens the result directly in the Firefox profiler."
          ],
          "code": "# Cargo.toml\n[profile.release]\ndebug = 1            # line tables only: enough to symbolise\nstrip = \"none\"\nlto = \"thin\"\n\n# Build a profileable binary and sample it on Linux:\nRUSTFLAGS=\"-C force-frame-pointers=yes\" cargo build --release\nperf record -F 997 -g -- ./target/release/acme serve --once\nperf report --no-children\n\n# Or generate a flamegraph directly:\ncargo install flamegraph --locked\ncargo flamegraph --bin acme -- serve --once\n\n# macOS: samply records and opens the Firefox profiler UI.\ncargo install samply --locked\nsamply record ./target/release/acme serve --once",
          "tip": "Profile a workload that resembles production. A benchmark loop that fits in L1 will show allocator and syscall costs as invisible and mislead you about where the time goes."
        },
        {
          "h": "Reading a flamegraph without lying to yourself",
          "p": [
            "In a flamegraph the horizontal axis is not time - it is the aggregated sample order. Width is total time in a frame, vertical stacking is the call stack, and the widest frame is the answer to where the CPU spent its samples. Time that is not on-CPU, such as blocking IO or waiting on a lock, may not appear at all, which is why a flamegraph can show a fast function in a slow service.",
            "Inlining flattens stacks: a small helper inlined into its caller is attributed to the caller, so a supposedly cheap abstraction can own a wide frame. That is not a bug in the profile, it is the profile telling you the abstraction is real code. Cross-check with off-CPU analysis, and with a benchmark that isolates the operation."
          ],
          "code": "// A measure-then-inspect loop that keeps the abstraction honest.\nuse criterion::{criterion_group, criterion_main, Criterion};\nuse std::hint::black_box;\n\nfn parse_all(data: &[u8]) -> usize {\n    data.split(|byte| *byte == b'\\n').map(|line| line.len()).sum()\n}\n\nfn bench(c: &mut Criterion) {\n    let data = vec![b'x'; 1 << 20];\n    c.bench_function(\"parse_all_1mib\", |b| {\n        b.iter(|| parse_all(black_box(&data)))\n    });\n}\n\ncriterion_group!(benches, bench);\ncriterion_main!(benches);\n\n// Same workload under the sampler, with symbols:\n//   cargo flamegraph --bench parse -- --bench parse_all_1mib\n// Then confirm the hot frame is where you think it is, not in memchr or the\n// allocator. If it is the allocator, the abstraction is not the problem.",
          "list": [
            "Width is samples, not elapsed time; the x-axis order is meaningless",
            "Blocking time may be missing entirely; use off-CPU analysis for waits",
            "Inlined helpers are charged to the caller, so frames are coarser than the source",
            "Always sample the same binary you ship, built with the same profile settings"
          ]
        },
        {
          "h": "Prove the abstraction disappeared",
          "p": [
            "The claim that a type-level abstraction compiles away is testable. cargo asm shows the emitted instructions for one function, and if the iterator chain vanished the assembly contains the loop body with no calls. cargo llvm-lines shows how many instantiations exist, and cargo expand shows what the macro or async desugaring produced.",
            "The failure mode is a call that should not be there: a dyn dispatch inside a loop, a clone inserted by the borrow checker's needs, a Box that could have been a value. These are visible in a diff of the asm before and after a change, which is a far stronger argument in review than a benchmark that moved by two percent."
          ],
          "code": "cargo install cargo-asm --locked\n\n# The abstraction should have no calls left:\ncargo asm --release --lib mycrate::parse_frame\n\n# Count how many copies of a generic were emitted:\ncargo llvm-lines --release | grep -c 'parse_frame'\n\n# See what the macro or async fn expanded to before blaming the optimizer:\ncargo expand --release --lib mycrate::parse_frame\n\n# In-process profiling for services where perf is unavailable (containers):\n#   add the pprof crate behind a feature, sample for 30s, write a protobuf\n#   flamegraph, then open it in the Firefox profiler or speedscope.\ncargo build --release --features profiling",
          "tip": "Keep the profiling-only dependencies behind a feature and never enable them in the shipped binary: a sampling profiler adds its own overhead and its own attack surface."
        }
      ],
      "exercise": {
        "prompt": "A service spends 40 percent of CPU in a function that only calls an iterator chain. Describe and implement the three checks that decide whether the chain itself is the cost or something inside it.",
        "starter": "fn hot(items: &[u64]) -> u64 {\n    items.iter().filter(|v| **v % 3 == 0).map(|v| v * 2).sum()\n}\n\n// 1. cargo asm: is there a call inside the loop?\n// 2. cargo llvm-lines: how many copies exist?\n// 3. criterion: what is the per-item cost, and does it scale linearly?",
        "hint": "Check the asm for call instructions inside the loop (bounds checks, allocation, or a non-inlined helper). llvm-lines tells you whether the generic was duplicated. A criterion bench over 1K, 10K, and 100K elements shows whether cost is linear or dominated by a fixed overhead.",
        "solution": "use criterion::{criterion_group, criterion_main, Criterion};\nuse std::hint::black_box;\n\n/// No allocation, no dyn, no bounds checks: `iter()` over a slice gives the\n/// optimizer all the information it needs.\nfn hot(items: &[u64]) -> u64 {\n    items.iter().filter(|v| **v % 3 == 0).map(|v| v * 2).sum()\n}\n\nfn bench(c: &mut Criterion) {\n    let small: Vec<u64> = (0..1_000).collect();\n    let large: Vec<u64> = (0..100_000).collect();\n\n    c.bench_function(\"hot_1k\", |b| b.iter(|| hot(black_box(&small))));\n    c.bench_function(\"hot_100k\", |b| b.iter(|| hot(black_box(&large))));\n}\n\ncriterion_group!(benches, bench);\ncriterion_main!(benches);\n\nfn main() {\n    // Correctness anchor for the benchmark: the same function, checked.\n    assert_eq!(hot(&[0, 1, 2, 3, 4, 5, 6]), 0 + 4 + 8);\n    assert_eq!(hot(&[]), 0);\n}"
      },
      "questions": [
        {
          "q": "What does the horizontal axis of a flamegraph represent?",
          "options": [
            "Aggregated sample counts in stack order, not chronological time",
            "Wall-clock time from left to right",
            "Thread id",
            "CPU frequency"
          ],
          "answer": 0,
          "explain": "Width is how many samples landed in a frame. The left-to-right order carries no temporal meaning, so you read total width per frame, not position."
        },
        {
          "q": "Why compile the profiling build with -C force-frame-pointers=yes?",
          "options": [
            "Without frame pointers the unwinder can attribute samples to the wrong function",
            "It enables debug assertions",
            "It is required for LTO",
            "It reduces the binary size"
          ],
          "answer": 0,
          "explain": "Stack unwinding needs either frame pointers or unwind tables. Frame pointers make perf's call-graph attribution reliable at the cost of one register."
        },
        {
          "q": "The flamegraph shows a wide frame attributed to a caller, and the helper you suspected does not appear at all. Why?",
          "options": [
            "The helper was inlined into its caller, so its samples are charged there",
            "The helper was optimized out entirely",
            "perf cannot see small functions",
            "The helper runs on another thread"
          ],
          "answer": 0,
          "explain": "Inlining merges frames. That is evidence the abstraction compiled away, and it means profiles are coarser than the source; use cargo asm to see the instructions."
        }
      ],
      "quickbytes": [
        "cargo flamegraph --bench name -- --bench filter   # profile the benchmark, not a guess",
        "perf report --no-children   # children hide attribution; start without them",
        "debug = 1 keeps symbols small enough to ship in a staging build.",
        "Never profile the debug profile: allocation and bounds-check costs are distorted."
      ],
      "production": [
        "A documented profiling recipe exists: exact RUSTFLAGS, profile settings, and the command that produces a flamegraph.",
        "Profiling dependencies are behind a feature and excluded from shipped artefacts.",
        "Hot-path changes are justified with an asm or flamegraph diff, not only with a benchmark delta.",
        "Off-CPU time is measured separately, so lock contention and blocking IO are never mistaken for CPU cost."
      ],
      "crates": [
        "criterion",
        "pprof"
      ],
      "github": [
        {
          "name": "flamegraph-rs/flamegraph",
          "url": "https://github.com/flamegraph-rs/flamegraph"
        },
        {
          "name": "tikv/pprof-rs",
          "url": "https://github.com/tikv/pprof-rs"
        }
      ],
      "pitfall": "Profiling a stripped release build or a debug build: the flamegraph is either full of unknown symbols or dominated by bounds checks and allocator traffic that the real binary never pays, and the optimization work targets the wrong function.",
      "resources": [
        {
          "title": "perf(1) manual page",
          "url": "https://man7.org/linux/man-pages/man1/perf.1.html",
          "kind": "docs"
        },
        {
          "title": "criterion: benchmarking and profiling hooks",
          "url": "https://docs.rs/criterion/latest/criterion/",
          "kind": "docs"
        },
        {
          "title": "flamegraph-rs/flamegraph: cargo flamegraph",
          "url": "https://github.com/flamegraph-rs/flamegraph",
          "kind": "repo"
        },
        {
          "title": "tikv/pprof-rs: in-process CPU profiling",
          "url": "https://github.com/tikv/pprof-rs",
          "kind": "repo"
        },
        {
          "title": "fasterthanlime: Rust performance deep dives",
          "url": "https://www.youtube.com/@fasterthanlime",
          "kind": "video"
        }
      ]
    },
  ]
};
