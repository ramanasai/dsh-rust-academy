/**
 * Compilers & language internals track.
 *
 * Versions checked on docs.rs while writing: logos 0.16.1, chumsky 0.13.0,
 * salsa 0.28.5, cranelift 0.137.1 (plus cranelift-jit / -module / -frontend),
 * wasmtime 50.x, miette 7.6.0, ariadne 0.5.x, syn 2.x. rustc internals follow
 * rustc-dev-guide (compiler stages, HIR, MIR, borrow check, queries).
 *
 * Data is JSON-compatible: every value below is a plain string, array or
 * object, so build.mjs can serialize the track without transformation.
 */

/**
 * Tagged template that keeps Rust/config snippets byte-exact and removes the
 * indentation introduced by nesting the literal inside this object.
 * Raw text is used so `\n` inside a Rust string stays two characters.
 */
const src = (strings, ...values) => {
  let text = strings.raw[0];
  for (let i = 0; i < values.length; i += 1) text += values[i] + strings.raw[i + 1];
  const lines = text.replace(/^\n+/, '').replace(/\s+$/, '').split('\n');
  let pad = Infinity;
  for (const line of lines) {
    if (line.trim()) pad = Math.min(pad, line.length - line.trimStart().length);
  }
  return lines.map((line) => line.slice(Math.min(pad, line.length))).join('\n');
};

export default {
  key: 'compilers',
  prefix: 'cl',
  title: "Compilers & language internals",
  blurb: "From source text to machine code: lexing, parsing, type checking, IR, optimisation, codegen and how rustc itself is built.",
  level: 'industry',
  project: {
    title: "Capstone: a small language compiler",
    brief: "Build a compiler for a small typed language that emits real machine code or WASM, with a test suite and diagnostics. The language needs functions, integers and booleans, if/else, variables, and at least one arithmetic operator with precedence. The compiler must reject ill-typed programs with a span-accurate message, and every accepted program must execute with the same result under an interpreter and under the generated code.",
    deliverables: [
      "Lexer, parser and AST: spans on every node, recovery that reports more than one syntax error per file, and a golden-file test per construct.",
      "Type checker with useful errors: unification over inference variables, one clear message per mistake, and a UI test that pins the rendered diagnostic.",
      "IR and an optimisation pass: a CFG-based IR plus constant folding and dead-code elimination, with a test proving the pass preserves behaviour.",
      "Code generation plus end-to-end tests: Cranelift JIT for local runs, WASM output for portability, and a differential harness that compares both against the interpreter.",
    ],
    stack: [
      "logos",
      "chumsky",
      "cranelift",
      "cranelift-jit",
      "cranelift-module",
      "wasmtime",
      "ariadne",
      "insta",
    ],
  },
  lessons: [
    // ------------------------------------------------------------------ cl01
    {
      id: 'cl01',
      n: 1,
      title: "The compiler pipeline: five representations, one program",
      minutes: 60,
      level: 'core',
      goal: "Name each stage of a compiler, say what invariant it establishes, and structure a pipeline that fails at the earliest stage that can prove the program wrong.",
      sections: [
        {
          h: "Every stage exists to make the next question cheap",
          p: [
            "Compilation is a sequence of translations, and each translation discards what the next stage cannot use while adding what it needs. Text becomes tokens because a tree cannot be built from characters cheaply; tokens become an AST because precedence and nesting are easier to see in a tree; the tree becomes a control-flow graph because dataflow questions need edges between program points. Nothing is kept out of nostalgia: the AST remembers what you wrote, MIR remembers where control can go, LLVM IR remembers only what an optimiser can exploit.",
            "The engineering consequence is that an error belongs to exactly one stage, and the cost of finding a bug grows with how far the program travelled before the bug was provable. A missing semicolon is caught in microseconds by the parser; a use-after-free is only visible after borrow checking has built a flow-sensitive model of one function. When you order your own stages you are choosing a feedback latency, not just drawing boxes.",
          ],
          list: [
            "Lexing: bytes to tokens with byte spans; the only stage that touches raw text",
            "Parsing: tokens to an AST; recovery lets one run report several syntax errors",
            "Lowering: AST to HIR and THIR, turning for loops, ? and method calls into explicit form",
            "MIR: a control-flow graph of simple assignments, the substrate for every dataflow analysis",
            "Codegen: MIR to LLVM IR or Cranelift IR, then object code, then a linker",
          ],
          tip: "Put the stage name in every diagnostic. A message that says during borrow checking tells the user the program already parsed and type-checked.",
        },
        {
          h: "What rustc actually does, in order",
          p: [
            "rustc runs a recognisable variant of that pipeline. rustc_lexer turns bytes into tokens; rustc_parse builds the AST with recursive descent; macro expansion and name resolution then run over the whole crate; lowering produces HIR, which is what type inference and trait solving consume. THIR is built next for pattern and exhaustiveness checking, MIR is built from THIR, borrow checking runs on MIR, and MIR is monomorphised on the way to LLVM IR.",
            "Only the portion between HIR and LLVM IR is organised as queries. Lexing, parsing, expansion and name resolution still run once per crate, which is why an incremental rebuild that edits one function body never re-reads the crate syntax, and why a macro whose expansion changes forces everything downstream to rerun. Knowing where that boundary sits is what makes incremental build times predictable rather than mysterious.",
          ],
          code: src`
            use std::time::Instant;

            #[derive(Clone, Copy, Debug, PartialEq, Eq)]
            pub enum Stage { Lex, Parse, Resolve, TypeCheck, BorrowCheck, Codegen }

            #[derive(Debug)]
            pub struct CompileError { pub stage: Stage, pub message: String }

            /// Run one stage, time it, and stamp the stage name onto any failure.
            fn stage<T>(
                which: Stage,
                timings: &mut Vec<(Stage, u128)>,
                run: impl FnOnce() -> Result<T, String>,
            ) -> Result<T, CompileError> {
                let start = Instant::now();
                let out = run().map_err(|message| CompileError { stage: which, message });
                timings.push((which, start.elapsed().as_micros()));
                out
            }

            pub fn compile(source: &str) -> Result<String, CompileError> {
                let mut timings = Vec::new();
                let tokens = stage(Stage::Lex, &mut timings, || lex(source))?;
                let ast = stage(Stage::Parse, &mut timings, || parse(&tokens))?;
                let hir = stage(Stage::Resolve, &mut timings, || resolve(&ast))?;
                let object = stage(Stage::Codegen, &mut timings, || emit(&hir))?;

                let report: Vec<String> = timings
                    .iter()
                    .map(|(which, micros)| format!("{which:?}={micros}us"))
                    .collect();
                Ok(format!("{object} [{}]", report.join(" ")))
            }

            fn lex(src: &str) -> Result<Vec<String>, String> {
                if src.trim().is_empty() { return Err("empty input".into()); }
                Ok(vec!["fn".into(), "main".into()])
            }
            fn parse(tokens: &[String]) -> Result<String, String> {
                if tokens.first().map(String::as_str) != Some("fn") {
                    return Err("expected fn".into());
                }
                Ok("fn main() {}".into())
            }
            fn resolve(ast: &str) -> Result<String, String> { Ok(ast.to_string()) }
            fn emit(hir: &str) -> Result<String, String> {
                Ok(format!(".text {}", hir.len()))
            }
          `,
          tip: "Return the artifact from each stage instead of passing the original source down. A stage that can reach back into raw text will eventually do it, and then you have two parsers.",
        },
        {
          h: "Gates, not passes, decide what a user sees",
          p: [
            "A pipeline is only worth having if it can stop early and stop in the right place. cargo check runs the compiler up to metadata emission: lexing, parsing, expansion, resolution, type checking and borrow checking all happen, but no code is generated. That single design decision is why the edit-check loop is fast even in a large workspace, and why a type error and a miscompilation have such different costs.",
            "Inside the compiler, the stopping point is a set of gates rather than a mode flag. Each gate says what must be true before the next stage may consume an artifact, and a failed gate prevents later stages from running on malformed input. If you let a later stage run anyway, it will report the downstream symptom of an upstream problem, and the user will chase the wrong line.",
          ],
          tip: "Track the furthest stage that succeeded in your error type. It is the cheapest signal you will ever have for whether a crash report means bad syntax or a real compiler bug.",
        },
      ],
      exercise: {
        prompt: "Wrap each stage of a toy pipeline so that a failure records which stage failed and stops the pipeline, while a success carries the artifact forward. Print a per-stage timing line only when the pipeline succeeds.",
        starter: src`
          #[derive(Clone, Copy, Debug, PartialEq, Eq)]
          pub enum Stage { Lex, Parse, TypeCheck }

          #[derive(Debug, PartialEq, Eq)]
          pub struct CompileError { pub stage: Stage, pub message: String }

          pub fn compile(source: &str) -> Result<Vec<String>, CompileError> {
              let tokens = lex(source)?;      // <- this loses the stage name
              let ast = parse(&tokens)?;
              let checked = check(&ast)?;
              Ok(checked)
          }

          fn lex(src: &str) -> Result<Vec<String>, CompileError> { todo!() }
          fn parse(tokens: &[String]) -> Result<Vec<String>, CompileError> { todo!() }
          fn check(ast: &[String]) -> Result<Vec<String>, CompileError> { todo!() }
        `,
        hint: "Give each stage function a body that returns Result<_, String>, then funnel every call through one helper that attaches the Stage. Map the helper's error type with ? at each call site.",
        solution: src`
          #[derive(Clone, Copy, Debug, PartialEq, Eq)]
          pub enum Stage { Lex, Parse, TypeCheck }

          #[derive(Debug, PartialEq, Eq)]
          pub struct CompileError { pub stage: Stage, pub message: String }

          fn run<T>(
              which: Stage,
              f: impl FnOnce() -> Result<T, String>,
          ) -> Result<T, CompileError> {
              f().map_err(|message| CompileError { stage: which, message })
          }

          fn lex(src: &str) -> Result<Vec<String>, String> {
              if src.is_empty() { return Err("empty source".into()); }
              Ok(src.split_whitespace().map(str::to_string).collect())
          }

          fn parse(tokens: &[String]) -> Result<Vec<String>, String> {
              if tokens.first().map(String::as_str) != Some("let") {
                  return Err(format!("expected let, found {:?}", tokens.first()));
              }
              Ok(tokens.to_vec())
          }

          fn check(ast: &[String]) -> Result<Vec<String>, String> {
              if ast.len() < 3 { return Err("incomplete let statement".into()); }
              Ok(ast.to_vec())
          }

          pub fn compile(source: &str) -> Result<Vec<String>, CompileError> {
              let tokens = run(Stage::Lex, || lex(source))?;
              let ast = run(Stage::Parse, || parse(&tokens))?;
              let checked = run(Stage::TypeCheck, || check(&ast))?;
              Ok(checked)
          }

          fn main() {
              assert_eq!(compile("let x = 1").map(|v| v.len()), Ok(4));
              let err = compile("x = 1").unwrap_err();
              assert_eq!(err.stage, Stage::Parse);
              assert!(err.message.contains("expected let"));
              println!("ok");
          }
        `,
      },
      questions: [
        {
          q: "Why does rustc build HIR and MIR instead of analysing the AST directly?",
          options: [
            "Because the AST is too large to keep in memory during type checking",
            "Because desugared, CFG-shaped IRs make the analyses simpler and faster to run",
            "Because the AST is not serialisable and MIR is",
            "Because LLVM can only consume MIR",
          ],
          answer: 1,
          explain: "HIR removes syntactic sugar so type checking sees one shape per construct, and MIR turns a function into a CFG so dataflow questions become graph questions. Size and serialisation are side effects, not the reason.",
        },
        {
          q: "What does cargo check deliberately skip?",
          options: [
            "Borrow checking and type checking",
            "Code generation and linking, after running the front end through borrow checking",
            "Only linking; it still emits object files",
            "Macro expansion, which is deferred to cargo build",
          ],
          answer: 1,
          explain: "cargo check runs the compiler up to metadata emission. Type checking and borrow checking do run, so you get the semantic errors; no object code is produced, which is why the loop is fast.",
        },
        {
          q: "A stage fails and the pipeline continues with a placeholder artifact. What is the typical user-visible result?",
          options: [
            "A cleaner error, because later stages suppress duplicates",
            "A cascade of errors whose first line is the real cause",
            "Downstream errors that hide the cause, or a compiler crash on malformed input",
            "No change; later stages validate their own inputs",
          ],
          answer: 2,
          explain: "Placeholder artifacts violate the invariant every later stage assumes. The classic symptom is an internal compiler error or a cascade of nonsense diagnostics far from the real mistake.",
        },
      ],
      quickbytes: [
        "Order stages by how much information they need; the earlier a bug is provable, the cheaper it is to report.",
        "Return an artifact from every stage and never let a later stage re-read raw source.",
        "Stamp the stage name into the error type; it separates user mistakes from compiler bugs.",
      ],
      production: [
        "Every stage has a test that feeds it a hand-built artifact, not a parsed file, so failures point at one stage.",
        "The driver records per-stage timings and exposes them behind a flag; compile-time regressions are measured, not guessed.",
        "Diagnostics carry a stage tag so CI can separate front-end failures from codegen failures.",
        "No stage mutates the artifact of an earlier stage; clones and caches are explicit and measured.",
      ],
      crates: ["logos", "chumsky", "ariadne"],
      github: [
        { name: "rustc-dev-guide - how the compiler is put together", url: "https://github.com/rust-lang/rustc-dev-guide" },
        { name: "rust - the compiler itself", url: "https://github.com/rust-lang/rust" },
      ],
      pitfall: "Letting codegen run after a failed type check: the backend sees types that were never validated, emits nonsense, and the user gets an error about an unsupported operation instead of the actual type mismatch.",
      resources: [
        { title: "rustc-dev-guide: overview of the compiler", url: "https://rustc-dev-guide.rust-lang.org/overview.html", kind: "docs" },
        { title: "rustc-dev-guide: lexing and parsing", url: "https://rustc-dev-guide.rust-lang.org/the-parser.html", kind: "docs" },
        { title: "rustc-dev-guide repository", url: "https://github.com/rust-lang/rustc-dev-guide", kind: "repo" },
        { title: "LLVM Project channel: codegen and optimisation talks", url: "https://www.youtube.com/@llvmproject", kind: "video" },
      ],
    },

    // ------------------------------------------------------------------ cl02
    {
      id: 'cl02',
      n: 2,
      title: "Lexing: maximal munch, spans, and keywords",
      minutes: 60,
      level: 'core',
      goal: "Write a lexer that produces spanned tokens with maximal-munch semantics, and explain why keywords, comments and byte offsets are lexer decisions rather than parser ones.",
      sections: [
        {
          h: "Spans are the real product of a lexer",
          p: [
            "A lexer is usually described as bytes to tokens, but the artifact that matters is a token plus a span. Every later diagnostic, every IDE hover, and every refactoring tool needs to map a decision back to a byte range in the original file, and only the lexer has that mapping for free. Store spans as byte offsets and keep the source around: converting to line and column is a rendering concern, and doing it inside the lexer forces you to redo it whenever the renderer changes.",
            "Byte offsets also decide correctness. Slicing a String at a non-char-boundary panics, so a lexer that operates on bytes must only ever emit boundaries that came from an ASCII delimiter or from a decoded char. Rust's own lexer keeps unrecognised bytes as an error token rather than panicking, which is what lets an editor keep highlighting the rest of the file.",
          ],
          code: src`
            #[derive(Clone, Copy, Debug, PartialEq, Eq)]
            pub enum Tok { Int(i64), Ident, Fn, Plus, Minus, EqEq, Eq, Semi, LParen, RParen, Eof }

            #[derive(Clone, Copy, Debug, PartialEq, Eq)]
            pub struct Token { pub kind: Tok, pub start: u32, pub end: u32 }

            pub fn lex(src: &str) -> Result<Vec<Token>, String> {
                let bytes = src.as_bytes();
                let mut out = Vec::new();
                let mut i = 0usize;
                while i < bytes.len() {
                    let start = i;
                    let kind = match bytes[i] {
                        b' ' | b'\t' | b'\r' | b'\n' => { i += 1; continue; }
                        b'a'..=b'z' | b'A'..=b'Z' | b'_' => {
                            while i < bytes.len()
                                && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_')
                            {
                                i += 1;
                            }
                            if &src[start..i] == "fn" { Tok::Fn } else { Tok::Ident }
                        }
                        b'0'..=b'9' => {
                            while i < bytes.len() && bytes[i].is_ascii_digit() { i += 1; }
                            let text = &src[start..i];
                            Tok::Int(text.parse().map_err(|_| {
                                format!("integer literal out of range at byte {start}")
                            })?)
                        }
                        b'+' => { i += 1; Tok::Plus }
                        b'-' => { i += 1; Tok::Minus }
                        b'=' => {
                            i += 1;
                            if bytes.get(i) == Some(&b'=') { i += 1; Tok::EqEq } else { Tok::Eq }
                        }
                        b'(' => { i += 1; Tok::LParen }
                        b')' => { i += 1; Tok::RParen }
                        b';' => { i += 1; Tok::Semi }
                        other => {
                            return Err(format!("unexpected byte {other:#04x} at byte {start}"));
                        }
                    };
                    out.push(Token { kind, start: start as u32, end: i as u32 });
                }
                out.push(Token { kind: Tok::Eof, start: i as u32, end: i as u32 });
                Ok(out)
            }
          `,
          tip: "Emit an explicit Eof token with a zero-width span at the end. The parser then never has to check for an empty slice, and the last unterminated construct still gets a sensible span.",
        },
        {
          h: "Maximal munch, and the cost of getting it wrong",
          p: [
            "Maximal munch says the lexer takes the longest token that can start at the current position. That single rule is why = followed by = must become EqEq and not two Eq tokens, and why a language with both < and << needs the lexer to peek. The alternative, letting the parser decide, means the parser receives ambiguous boundaries and every grammar rule has to encode the lexer's rules too.",
            "Rust pays for maximal munch once, visibly: >> is lexed as a single right-shift token, so the parser has to split it when it appears at the end of a nested generic list like Vec<Vec<i32>>. That is a deliberate trade, because splitting a token in one known place is cheaper than making every angle bracket ambiguous. The lesson for your own language is to decide this before you write the parser, not after the first confusing error message.",
          ],
          list: [
            "Longest match wins: == beats =, <= beats <, and .. beats .",
            "Keywords are identifiers whose text is reserved later, which is why contextual keywords need no reservation",
            "Comments and whitespace are trivia: keep them for formatters and IDEs, drop them for the parser",
            "An unterminated string is a lexer error with a span, not a parser error about a missing quote",
          ],
        },
        {
          h: "When to generate the lexer instead of writing it",
          p: [
            "A hand-written lexer is a loop, a match, and a lot of patience; it is also the easiest place to get error recovery and obscure literals right. A generated lexer is a deterministic finite automaton built at compile time, which typically beats hand-written code on throughput and removes backtracking by construction. logos does exactly this: each #[token] and #[regex] attribute becomes part of one DFA, and the derive emits a matcher with no per-token function-call overhead.",
            "Reach for the generated version when the token set is stable and large, for example a data format or a language with many operators. Write it by hand when you need unusual behaviour inside a token, such as nested block comments, interpolation with balanced braces, or a raw string whose terminator depends on a count. Both choices are reversible, which is why the decision should take an afternoon, not a design review.",
          ],
          code: src`
            use logos::Logos;

            #[derive(Logos, Debug, PartialEq, Eq)]
            #[logos(skip r"[ \t\n\f]+")]
            #[logos(skip r"//[^\n]*")]
            pub enum Token {
                #[token("fn")]
                Fn,
                #[token("let")]
                Let,
                #[token("==")]
                EqEq,
                #[token("=")]
                Eq,
                #[regex(r"[A-Za-z_][A-Za-z0-9_]*")]
                Ident,
                #[regex(r"[0-9]+", |lex| lex.slice().parse::<i64>().ok())]
                Int(i64),
            }

            pub fn spans(src: &str) -> Vec<(Token, std::ops::Range<usize>)> {
                Token::lexer(src)
                    .spanned()
                    .filter_map(|(token, span)| token.ok().map(|t| (t, span)))
                    .collect()
            }
          `,
          tip: "Logos resolves ambiguous patterns at compile time and reports the conflict. If two patterns can match the same prefix with the same length, you get an error rather than silent precedence.",
        },
      ],
      exercise: {
        prompt: "Extend a hand-written lexer with block comments that nest, so that /* a /* b */ c */ produces no tokens and an unclosed comment reports the byte offset of the opening marker.",
        starter: src`
          #[derive(Debug, PartialEq, Eq)]
          pub enum Tok { Ident(String), Eof }

          pub fn lex(src: &str) -> Result<Vec<Tok>, String> {
              let bytes = src.as_bytes();
              let mut out = Vec::new();
              let mut i = 0usize;
              while i < bytes.len() {
                  match bytes[i] {
                      b' ' | b'\n' => i += 1,
                      // 1. handle /* ... */ including nesting
                      b'a'..=b'z' => {
                          let start = i;
                          while i < bytes.len() && bytes[i].is_ascii_alphanumeric() { i += 1; }
                          out.push(Tok::Ident(src[start..i].to_string()));
                      }
                      other => return Err(format!("unexpected byte {other:#04x}")),
                  }
              }
              out.push(Tok::Eof);
              Ok(out)
          }
        `,
        hint: "Keep a depth counter. On /* increment and advance two bytes; on */ decrement and stop when it reaches zero. If the input ends while depth is positive, report the byte offset where the outermost comment started.",
        solution: src`
          #[derive(Debug, PartialEq, Eq)]
          pub enum Tok { Ident(String), Eof }

          pub fn lex(src: &str) -> Result<Vec<Tok>, String> {
              let bytes = src.as_bytes();
              let mut out = Vec::new();
              let mut i = 0usize;
              while i < bytes.len() {
                  match bytes[i] {
                      b' ' | b'\t' | b'\n' => i += 1,
                      b'/' if bytes.get(i + 1) == Some(&b'*') => {
                          let opened_at = i;
                          let mut depth = 0usize;
                          loop {
                              if i + 1 >= bytes.len() { break; }
                              if bytes[i] == b'/' && bytes[i + 1] == b'*' {
                                  depth += 1;
                                  i += 2;
                              } else if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                                  depth -= 1;
                                  i += 2;
                                  if depth == 0 { break; }
                              } else {
                                  i += 1;
                              }
                          }
                          if depth != 0 {
                              return Err(format!("unclosed comment opened at byte {opened_at}"));
                          }
                      }
                      b'a'..=b'z' | b'A'..=b'Z' | b'_' => {
                          let start = i;
                          while i < bytes.len()
                              && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_')
                          {
                              i += 1;
                          }
                          out.push(Tok::Ident(src[start..i].to_string()));
                      }
                      other => return Err(format!("unexpected byte {other:#04x} at {i}")),
                  }
              }
              out.push(Tok::Eof);
              Ok(out)
          }

          fn main() {
              assert_eq!(lex("a /* x /* y */ z */ b").unwrap(),
                  vec![Tok::Ident("a".into()), Tok::Ident("b".into()), Tok::Eof]);
              let err = lex("a /* b").unwrap_err();
              assert!(err.contains("byte 2"), "got {err}");
              println!("ok");
          }
        `,
      },
      questions: [
        {
          q: "Why does rustc's lexer emit >> as one token and let the parser split it?",
          options: [
            "Because the lexer cannot see generics, so maximal munch produces the shift token and the parser splits it in type position",
            "Because the parser needs to know the difference between a shift and a closing angle to report errors",
            "Because >> is slower to lex as two tokens",
            "Because generics are parsed by a separate lexer pass",
          ],
          answer: 0,
          explain: "Maximal munch is a lexer rule with no context. It produces the longest token, >>, and the parser splits it at the one place where a closing angle is expected.",
        },
        {
          q: "A token stores only a line and column. What breaks first?",
          options: [
            "Token comparison, because two tokens can share a position",
            "Slice extraction for diagnostics that underline the exact text",
            "Keyword recognition, which needs byte length",
            "Comment skipping, which needs line numbers",
          ],
          answer: 1,
          explain: "Rendering needs the byte range to underline or replace text. Line and column alone cannot express a zero-width insertion point or a multi-line span without re-scanning the file.",
        },
        {
          q: "Where does a contextual keyword such as Rust's union get resolved?",
          options: [
            "In the lexer, which emits a dedicated Union token",
            "In the parser, which treats it as an identifier except in item position",
            "In name resolution, which reserves the name crate-wide",
            "In the macro expander, which rewrites the token",
          ],
          answer: 1,
          explain: "It is lexed as an identifier. The parser reinterprets it only where the grammar expects an item keyword, which is why union remains usable as a variable name.",
        },
      ],
      quickbytes: [
        "Store byte spans in the token; derive line and column only when rendering a diagnostic.",
        "Let the lexer fail on one bad byte and keep the rest of the file tokenised, so an editor stays usable.",
        "Decide the >> and >= ambiguity before writing the grammar; retrofitting it means touching every type rule.",
      ],
      production: [
        "Every token variant has a test that pins its span, not just its kind.",
        "Fuzz the lexer with arbitrary bytes; a panic on a char boundary is a bug, an error token is not.",
        "Benchmark at least 1 MiB of input; a lexer that allocates per token dominates parse time.",
        "Keep trivia out of the parser's token stream but preserved in a side table for the formatter.",
      ],
      crates: ["logos", "logos-derive", "unicode-ident"],
      github: [
        { name: "logos - compile-time DFA lexers", url: "https://github.com/maciejhirsz/logos" },
        { name: "rust - rustc_lexer and its tests", url: "https://github.com/rust-lang/rust" },
      ],
      pitfall: "Slicing the source with a computed offset that lands inside a multi-byte character: lexing bytes is fine, but &src[start..i] panics unless both ends are char boundaries produced by ASCII delimiters or char decoding.",
      resources: [
        { title: "logos crate documentation", url: "https://docs.rs/logos/latest/logos/", kind: "docs" },
        { title: "The Rust Reference: tokens", url: "https://doc.rust-lang.org/reference/tokens.html", kind: "docs" },
        { title: "logos-derive: the derive that builds the DFA", url: "https://docs.rs/logos-derive/latest/logos_derive/", kind: "docs" },
        { title: "rustc-dev-guide: lexing and parsing", url: "https://rustc-dev-guide.rust-lang.org/the-parser.html", kind: "docs" },
        { title: "logos repository - generated DFA lexers", url: "https://github.com/maciejhirsz/logos", kind: "repo" },
      ],
    },

    // ------------------------------------------------------------------ cl03
    {
      id: 'cl03',
      n: 3,
      title: "Parsing: recursive descent, precedence, and recovery",
      minutes: 75,
      level: 'core',
      goal: "Build a recursive-descent parser with correct operator precedence and a recovery strategy that reports several syntax errors per run instead of stopping at the first.",
      sections: [
        {
          h: "An AST is a data structure decision",
          p: [
            "Before the first line of parser code, decide what the AST is for. If it feeds analyses, box your children and keep spans in every node; if it also feeds a formatter or an IDE, you need a lossless tree that can reprint the original text, which is a different data structure with a different cost. rust-analyzer solves the second problem with rowan, an immutable green tree shared by reference, so re-parsing one function does not copy the rest of the file.",
            "For a compiler that only needs to type-check and emit, a plain enum with Box children and a Span on each variant is the right amount of machinery. The mistake to avoid is the hybrid: an AST that keeps raw text, then needs a separate lowering step to remove it, then a second AST that is nearly identical. Two representations with a clear boundary beat three that blur into each other.",
          ],
          code: src`
            #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
            pub struct Span { pub start: u32, pub end: u32 }

            impl Span {
                pub fn join(self, other: Span) -> Span {
                    Span { start: self.start, end: other.end }
                }
            }

            #[derive(Clone, Copy, Debug, PartialEq, Eq)]
            pub enum BinOp { Add, Sub, Mul }

            #[derive(Debug)]
            pub enum Expr {
                Int(i64, Span),
                Name(String, Span),
                Binary { op: BinOp, lhs: Box<Expr>, rhs: Box<Expr>, span: Span },
                Call { callee: Box<Expr>, args: Vec<Expr>, span: Span },
            }

            impl Expr {
                pub fn span(&self) -> Span {
                    match self {
                        Expr::Int(_, span) | Expr::Name(_, span) => *span,
                        Expr::Binary { span, .. } | Expr::Call { span, .. } => *span,
                    }
                }
            }
          `,
          tip: "Write the accessor for spans before the parser. If every node can report its span, every diagnostic can too, and you never retrofit spans into a finished compiler.",
        },
        {
          h: "Precedence climbing, not a grammar rule per level",
          p: [
            "The textbook grammar for expressions has one rule per precedence level, which produces one function per level and makes adding an operator a four-place edit. Precedence climbing keeps a single expression function and a table of binding powers: while the next operator binds tighter than the minimum, consume it and recurse with the new minimum. Left associativity falls out of passing bp + 1 for the right operand; right associativity would pass bp.",
            "The other classic trap is left recursion. A rule like expr := expr + term recurses forever in a top-down parser, because the first thing expr does is call expr. Precedence climbing is the standard answer for binary operators; for other left-recursive shapes, rewrite the rule to iterate, which is what a repeated loop in a combinator library compiles down to anyway.",
          ],
          code: src`
            #[derive(Clone, Copy, Debug, PartialEq, Eq)]
            pub enum Tok { Int(i64), Ident, Plus, Minus, Star, LParen, RParen, Eof }

            #[derive(Debug, PartialEq)]
            pub enum Expr {
                Int(i64),
                Binary(Box<Expr>, BinOp, Box<Expr>),
            }

            #[derive(Clone, Copy, Debug, PartialEq)]
            pub enum BinOp { Add, Sub, Mul }

            pub struct Parser<'a> { tokens: &'a [Tok], pos: usize }

            impl<'a> Parser<'a> {
                pub fn new(tokens: &'a [Tok]) -> Self { Parser { tokens, pos: 0 } }

                fn peek(&self) -> Tok { self.tokens[self.pos] }

                fn bump(&mut self) -> Tok {
                    let token = self.tokens[self.pos];
                    self.pos += 1;
                    token
                }

                fn binding_power(token: Tok) -> Option<(BinOp, u8)> {
                    match token {
                        Tok::Plus => Some((BinOp::Add, 1)),
                        Tok::Minus => Some((BinOp::Sub, 1)),
                        Tok::Star => Some((BinOp::Mul, 2)),
                        _ => None,
                    }
                }

                pub fn expr(&mut self, min_bp: u8) -> Result<Expr, String> {
                    let mut lhs = self.atom()?;
                    while let Some((op, bp)) = Self::binding_power(self.peek()) {
                        if bp < min_bp { break; }
                        self.bump();
                        let rhs = self.expr(bp + 1)?; // bp + 1 keeps it left-associative
                        lhs = Expr::Binary(Box::new(lhs), op, Box::new(rhs));
                    }
                    Ok(lhs)
                }

                fn atom(&mut self) -> Result<Expr, String> {
                    match self.bump() {
                        Tok::Int(value) => Ok(Expr::Int(value)),
                        Tok::LParen => {
                            let inner = self.expr(0)?;
                            match self.bump() {
                                Tok::RParen => Ok(inner),
                                other => Err(format!("expected ), found {other:?}")),
                            }
                        }
                        other => Err(format!("expected expression, found {other:?}")),
                    }
                }
            }
          `,
          tip: "Binding powers that differ by one integer are easy to misread. Use a table with names and a comment on each row; the parser gets reviewed more often than it gets rewritten.",
        },
        {
          h: "Recovery is a feature, not a fallback",
          p: [
            "A parser that stops at the first error makes every round trip a full edit-compile cycle. Recovery means: report the error, then skip to a token that can plausibly start the next construct, and continue with a placeholder node. The parser's invariant becomes we always produce a tree, and the error list tells the caller how much of it to trust.",
            "Recovery has a cost that must be paid deliberately. Placeholder nodes flow into name resolution and type checking, so those stages must tolerate an Error node and stay silent about it, or one syntax error becomes twelve type errors. Synchronisation sets, an Error expression variant, and a rule that later stages skip subtrees containing errors are the three pieces that make the whole thing work.",
          ],
          list: [
            "Synchronise on statement boundaries, closing delimiters, and item keywords",
            "Cap the number of reported errors per file so a malformed brace does not produce thousands",
            "Mark recovered nodes; every later stage checks the mark before reporting",
            "Always return a tree plus a list of errors, never a bare Result that discards partial work",
          ],
          code: src`
            #[derive(Clone, Copy, Debug, PartialEq, Eq)]
            pub enum Tok { Int(i64), Semi, Eof }

            #[derive(Debug, PartialEq, Eq)]
            pub enum Expr { Int(i64), Error }

            pub struct Parser<'a> { tokens: &'a [Tok], pos: usize, errors: Vec<String> }

            impl<'a> Parser<'a> {
                pub fn new(tokens: &'a [Tok]) -> Self {
                    Parser { tokens, pos: 0, errors: Vec::new() }
                }

                fn peek(&self) -> Tok { self.tokens[self.pos] }

                fn bump(&mut self) -> Tok {
                    let token = self.tokens[self.pos];
                    if self.pos + 1 < self.tokens.len() { self.pos += 1; }
                    token
                }

                /// Statements until Eof; one bad statement costs one error, not the file.
                pub fn block(&mut self) -> (Vec<Expr>, Vec<String>) {
                    let mut items = Vec::new();
                    while self.peek() != Tok::Eof {
                        match self.peek() {
                            Tok::Int(value) => {
                                self.bump();
                                items.push(Expr::Int(value));
                            }
                            _ => {
                                self.errors.push(format!("expected statement, found {:?}", self.peek()));
                                items.push(Expr::Error);
                                self.synchronise();
                            }
                        }
                        if self.peek() == Tok::Semi {
                            self.bump();
                        } else if self.peek() != Tok::Eof {
                            self.errors.push(format!("expected ; found {:?}", self.peek()));
                            self.synchronise();
                        }
                    }
                    (items, std::mem::take(&mut self.errors))
                }

                fn synchronise(&mut self) {
                    while self.peek() != Tok::Eof && self.peek() != Tok::Semi {
                        self.bump();
                    }
                }
            }
          `,
          tip: "Cap errors at a small number per file and say how many were suppressed. A wall of syntax errors is worse than five good ones.",
        },
      ],
      exercise: {
        prompt: "Extend the precedence-climbing parser so that comparisons bind looser than arithmetic and are non-associative: a < b < c must be a parse error that names the second operator.",
        starter: src`
          #[derive(Clone, Copy, Debug, PartialEq, Eq)]
          pub enum Tok { Int(i64), Plus, Star, Less, Eof }

          #[derive(Clone, Copy, Debug, PartialEq)]
          pub enum BinOp { Add, Mul }

          #[derive(Debug, PartialEq)]
          pub enum Expr { Int(i64), Binary(Box<Expr>, BinOp, Box<Expr>) }

          // 1. add Less to BinOp and give it a lower binding power than + and *
          // 2. parse an atom (Int or parenthesised expr)
          // 3. climb: while the next operator binds at least min_bp, recurse
          // 4. reject a second comparison at the same level
          fn binding_power(token: Tok) -> Option<(BinOp, u8)> {
              match token {
                  Tok::Plus => Some((BinOp::Add, 2)),
                  Tok::Star => Some((BinOp::Mul, 3)),
                  _ => None,
              }
          }

          pub fn expr(tokens: &[Tok], pos: &mut usize, min_bp: u8) -> Result<Expr, String> {
              todo!("parse an atom, then climb precedence using binding_power")
          }
        `,
        hint: "Track whether the left-hand side was already a comparison. When a comparison is seen and the left side is one, return an error instead of looping. The lowest binding power keeps arithmetic inside both operands.",
        solution: src`
          #[derive(Clone, Copy, Debug, PartialEq, Eq)]
          pub enum Tok { Int(i64), Plus, Star, Less, Eof }

          #[derive(Clone, Copy, Debug, PartialEq)]
          pub enum BinOp { Add, Mul, Less }

          #[derive(Debug, PartialEq)]
          pub enum Expr {
              Int(i64),
              Binary(Box<Expr>, BinOp, Box<Expr>),
          }

          pub struct Parser<'a> { tokens: &'a [Tok], pos: usize }

          impl<'a> Parser<'a> {
              pub fn new(tokens: &'a [Tok]) -> Self { Parser { tokens, pos: 0 } }

              fn peek(&self) -> Tok { self.tokens[self.pos] }

              fn binding_power(token: Tok) -> Option<(BinOp, u8)> {
                  match token {
                      Tok::Less => Some((BinOp::Less, 1)),
                      Tok::Plus => Some((BinOp::Add, 2)),
                      Tok::Star => Some((BinOp::Mul, 3)),
                      _ => None,
                  }
              }

              pub fn expr(&mut self, min_bp: u8) -> Result<Expr, String> {
                  let mut lhs = self.atom()?;
                  while let Some((op, bp)) = Self::binding_power(self.peek()) {
                      if bp < min_bp { break; }
                      if op == BinOp::Less && matches!(lhs, Expr::Binary(_, BinOp::Less, _)) {
                          return Err("comparison operators are non-associative; \
                                      parenthesise the first comparison"
                              .to_string());
                      }
                      self.pos += 1;
                      let rhs = self.expr(bp + 1)?;
                      lhs = Expr::Binary(Box::new(lhs), op, Box::new(rhs));
                  }
                  Ok(lhs)
              }

              fn atom(&mut self) -> Result<Expr, String> {
                  let token = self.tokens[self.pos];
                  self.pos += 1;
                  match token {
                      Tok::Int(value) => Ok(Expr::Int(value)),
                      other => Err(format!("expected expression, found {other:?}")),
                  }
              }
          }

          fn main() {
              let toks = [Tok::Int(1), Tok::Plus, Tok::Int(2), Tok::Star, Tok::Int(3), Tok::Eof];
              let mut p = Parser::new(&toks);
              let tree = p.expr(0).unwrap();
              let expected = Expr::Binary(
                  Box::new(Expr::Int(1)),
                  BinOp::Add,
                  Box::new(Expr::Binary(Box::new(Expr::Int(2)), BinOp::Mul, Box::new(Expr::Int(3)))),
              );
              assert_eq!(tree, expected);

              let toks = [Tok::Int(1), Tok::Less, Tok::Int(2), Tok::Less, Tok::Int(3), Tok::Eof];
              let mut p = Parser::new(&toks);
              assert!(p.expr(0).unwrap_err().contains("non-associative"));
              println!("ok");
          }
        `,
      },
      questions: [
        {
          q: "Why does precedence climbing pass bp + 1 rather than bp when parsing the right operand?",
          options: [
            "To make the loop terminate on unary operators",
            "Because a higher minimum forces the right side to stop at the same operator, giving left associativity",
            "Because binding powers must stay below 256",
            "Because it avoids one stack frame per operator",
          ],
          answer: 1,
          explain: "With min_bp = bp + 1 the right operand will not absorb another operator of the same precedence, so a - b - c parses as (a - b) - c. Passing bp would give right associativity.",
        },
        {
          q: "A parser returns Err on the first syntax error. Which capability is lost?",
          options: [
            "The ability to type-check the file at all",
            "The ability to report several independent syntax errors in one run",
            "The ability to compute byte spans",
            "The ability to support operator precedence",
          ],
          answer: 1,
          explain: "You can still build a correct parser and report a precise first error. What you lose is batching: users must re-run the compiler once per mistake.",
        },
        {
          q: "After recovery inserts an Error node, what must later stages do?",
          options: [
            "Treat it as unit and continue silently",
            "Skip any subtree containing it and suppress their own errors there",
            "Re-parse the subtree to recover more information",
            "Report their own error so the user sees the full chain",
          ],
          answer: 1,
          explain: "Placeholder nodes cause cascading false errors. Later stages must detect the mark and stay quiet, so the user sees one syntax error instead of a dozen types that do not match.",
        },
      ],
      quickbytes: [
        "One expression function plus a binding-power table beats one function per precedence level.",
        "Return (tree, errors) from the parser; partial output is what IDE tooling needs.",
        "Cap syntax errors per file and report how many were suppressed.",
      ],
      production: [
        "Every AST node exposes its span through one accessor, and a test asserts spans for each construct.",
        "Parser tests include malformed input, with the exact error text pinned by a snapshot.",
        "Recovery is tested by asserting the count of errors for a file with two independent mistakes.",
        "No parser path panics on arbitrary input; fuzzing is part of the test suite, not an afterthought.",
      ],
      crates: ["chumsky", "lalrpop", "rowan"],
      github: [
        { name: "rust-analyzer - lossless syntax trees with rowan", url: "https://github.com/rust-lang/rust-analyzer" },
        { name: "rust - the recursive-descent parser in compiler/rustc_parse", url: "https://github.com/rust-lang/rust" },
      ],
      pitfall: "Writing a grammar rule that is left-recursive and letting the parser overflow the stack: expr := expr + term recurses forever in recursive descent; iterate or use precedence climbing instead.",
      resources: [
        { title: "chumsky - parser combinators with error recovery", url: "https://docs.rs/chumsky/latest/chumsky/", kind: "docs" },
        { title: "rust-analyzer - lossless syntax trees in practice", url: "https://github.com/rust-lang/rust-analyzer", kind: "repo" },
        { title: "lalrpop - LR(1) parser generator for Rust", url: "https://docs.rs/lalrpop/latest/lalrpop/", kind: "docs" },
        { title: "rowan - lossless syntax trees", url: "https://docs.rs/rowan/latest/rowan/", kind: "docs" },
        { title: "rustc-dev-guide: lexing and parsing", url: "https://rustc-dev-guide.rust-lang.org/the-parser.html", kind: "docs" },
      ],
    },

    // ------------------------------------------------------------------ cl04
    {
      id: 'cl04',
      n: 4,
      title: "Name resolution: ribs, namespaces, and macro hygiene",
      minutes: 75,
      level: 'advanced',
      goal: "Resolve identifiers with a rib stack, explain why Rust has three separate namespaces and how macro hygiene keeps expansion from capturing caller bindings.",
      sections: [
        {
          h: "A rib is a scope with a name",
          p: [
            "Name resolution answers one question for every identifier: which definition does this occurrence refer to? The classic implementation is a stack of ribs, each rib a map from name to definition id. Entering a block pushes a rib, leaving pops it, and a lookup walks the stack from innermost to outermost. That is enough for lexical scoping, and it is roughly what rustc calls its resolver.",
            "Two wrinkles make it more interesting. First, items in a module are visible regardless of textual order, so a function body can call a function defined below it: the collector walks the whole module first and only then resolves bodies. Second, a binding becomes visible after its let, which is why let x = x; refers to the outer x on the right-hand side. Position-sensitive lookup is a rib property, not a special case in the expression walker.",
          ],
          code: src`
            use std::collections::HashMap;

            #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
            pub struct DefId(pub u32);

            #[derive(Default)]
            pub struct Resolver {
                ribs: Vec<HashMap<String, DefId>>,
                next_id: u32,
            }

            impl Resolver {
                pub fn new() -> Self {
                    Resolver { ribs: vec![HashMap::new()], next_id: 0 }
                }

                /// Introduce a binding in the innermost rib.
                pub fn define(&mut self, name: &str) -> DefId {
                    let id = DefId(self.next_id);
                    self.next_id += 1;
                    self.ribs.last_mut().expect("root rib").insert(name.to_string(), id);
                    id
                }

                /// Walk from the innermost rib outwards; first match wins.
                pub fn resolve(&self, name: &str) -> Option<DefId> {
                    self.ribs.iter().rev().find_map(|rib| rib.get(name).copied())
                }

                /// Run a closure inside a fresh rib, then drop the rib.
                pub fn in_scope<T>(&mut self, f: impl FnOnce(&mut Self) -> T) -> T {
                    self.ribs.push(HashMap::new());
                    let out = f(self);
                    self.ribs.pop();
                    out
                }
            }

            fn demo() {
                let mut r = Resolver::new();
                let outer = r.define("x");
                let inner = r.in_scope(|r| {
                    assert_eq!(r.resolve("x"), Some(outer)); // sees the outer x
                    r.define("x")                            // shadows it
                });
                assert_eq!(r.resolve("x"), Some(outer));     // rib popped, shadow gone
                assert_ne!(inner, outer);
            }
          `,
          tip: "Resolve to a DefId, never to a string. Every later stage should be able to tell two distinct bindings with the same name apart without re-doing the lookup.",
        },
        {
          h: "Three namespaces, one spelling",
          p: [
            "Rust resolves the same word in different namespaces depending on where it appears. A struct and a function can share a name because types and values are separate namespaces; a macro_rules! name lives in a third. That is not a quirk to memorise, it is what makes tuple structs work: struct Pair(i32) defines a type Pair and a value constructor Pair, and both must resolve independently.",
            "The practical payoff appears in errors. Unresolved type, unresolved value and unresolved macro are three different diagnostics with three different fixes, and a resolver that collapses them into one namespace can only ever say the name was not found. It also decides privacy: whether an item is reachable is a resolver question, checked against the module graph, not a type checker question.",
          ],
          list: [
            "Type namespace: structs, enums, traits, type aliases, modules",
            "Value namespace: functions, consts, statics, tuple-struct constructors",
            "Macro namespace: macro_rules! declarations and macro imports",
            "Items are collected before bodies are resolved, so forward references work",
            "Bindings are visible only after their let statement",
          ],
        },
        {
          h: "Hygiene: expansion must not capture",
          p: [
            "A macro that expands to let tmp = 1; must not collide with the caller's own tmp. Hygiene solves this by giving every token a syntax context, so two identical identifiers from different contexts are different names even though they print the same. Rust applies mixed-site hygiene: local variables and labels are hygienic, while items and types resolve at the call site, because a macro that defines a function should define it where it was used.",
            "Getting this wrong is subtle and user-visible. A macro using $crate to refer to its own crate is the item-namespace counterpart of the same problem: without it, the expansion resolves paths relative to the caller and breaks as soon as someone renames the crate. Both mechanisms exist because name resolution runs after expansion on a token stream that no longer remembers where the tokens came from, unless that information was attached to them.",
          ],
          code: src`
            macro_rules! careful {
                ($e:expr) => {{
                    // This tmp lives in the macro's own syntax context, so it
                    // cannot capture or be captured by the caller's tmp.
                    let tmp = $e * 2;
                    tmp + 1
                }};
            }

            fn caller() -> i32 {
                let tmp = 100;
                let out = careful!(tmp); // expands to a *different* tmp
                assert_eq!(out, 201);
                out
            }
          `,
          tip: "Use $crate:: in exported macros and prefer a private helper function over a bag of statements. Hygiene protects locals; it does not protect your paths.",
        },
      ],
      exercise: {
        prompt: "Implement a resolver that supports hoisted items and position-sensitive locals: a function may call one defined later in the same block, but a let binding is invisible before it is declared.",
        starter: src`
          use std::collections::HashMap;

          #[derive(Clone, Copy, Debug, PartialEq, Eq)]
          pub struct DefId(pub u32);

          pub struct Resolver {
              items: HashMap<String, DefId>,   // module scope, order independent
              locals: Vec<HashMap<String, DefId>>,
              next_id: u32,
          }

          impl Resolver {
              // fn collect_item(&mut self, name: &str) -> DefId { todo!() }
              // fn bind_local(&mut self, name: &str) -> DefId { todo!() }
              // fn resolve(&self, name: &str) -> Option<DefId> { todo!() }
          }
        `,
        hint: "Collect every item in a first pass, then resolve bodies in a second pass. For locals, push a rib on block entry and insert into the innermost rib when the let is reached, so earlier uses cannot see it.",
        solution: src`
          use std::collections::HashMap;

          #[derive(Clone, Copy, Debug, PartialEq, Eq)]
          pub struct DefId(pub u32);

          #[derive(Default)]
          pub struct Resolver {
              items: HashMap<String, DefId>,
              locals: Vec<HashMap<String, DefId>>,
              next_id: u32,
          }

          impl Resolver {
              pub fn new() -> Self {
                  Resolver { items: HashMap::new(), locals: vec![], next_id: 0 }
              }

              fn fresh(&mut self) -> DefId {
                  let id = DefId(self.next_id);
                  self.next_id += 1;
                  id
              }

              /// Pass 1: hoist every item in the module, ignoring order.
              pub fn collect_item(&mut self, name: &str) -> DefId {
                  let id = self.fresh();
                  self.items.insert(name.to_string(), id);
                  id
              }

              /// Pass 2: a local becomes visible only when its let is reached.
              pub fn bind_local(&mut self, name: &str) -> DefId {
                  if self.locals.is_empty() { self.locals.push(HashMap::new()); }
                  let id = self.fresh();
                  self.locals.last_mut().unwrap().insert(name.to_string(), id);
                  id
              }

              pub fn resolve(&self, name: &str) -> Option<DefId> {
                  self.locals
                      .iter()
                      .rev()
                      .find_map(|rib| rib.get(name).copied())
                      .or_else(|| self.items.get(name).copied())
              }

              pub fn in_block<T>(&mut self, f: impl FnOnce(&mut Self) -> T) -> T {
                  self.locals.push(HashMap::new());
                  let out = f(self);
                  self.locals.pop();
                  out
              }
          }

          fn main() {
              let mut r = Resolver::new();
              r.collect_item("main");          // defined first ...
              let body = r.in_block(|r| {
                  assert_eq!(r.resolve("use_later"), None); // ... not yet collected
                  r.collect_item("use_later");              // ... now it is
                  let x = r.bind_local("x");
                  assert_eq!(r.resolve("x"), Some(x));
                  assert_eq!(r.resolve("main").is_some(), true);
                  x
              });
              let _ = body;
              println!("ok");
          }
        `,
      },
      questions: [
        {
          q: "Why can a struct and a function in the same module share a name?",
          options: [
            "Because the function shadows the struct",
            "Because types and values live in separate namespaces that resolve independently",
            "Because the compiler renames the struct internally",
            "Because functions are resolved before structs",
          ],
          answer: 1,
          explain: "Resolution is namespace-aware. A tuple struct like Pair(i32) legitimately defines a type and a value constructor with the same spelling, so the two must not collide.",
        },
        {
          q: "What does mixed-site hygiene mean in practice?",
          options: [
            "All identifiers from a macro expansion resolve at the macro definition site",
            "Locals and labels are hygienic, while items and types resolve at the call site",
            "Hygiene applies only to procedural macros",
            "Names are escaped with a unique prefix in the emitted code",
          ],
          answer: 1,
          explain: "Rust deliberately mixes the two. A macro's local variables cannot capture caller locals, but a function the macro defines should appear where the macro was invoked.",
        },
        {
          q: "Two glob imports both define Max. When is the ambiguity reported?",
          options: [
            "At the use site of Max, because that is where the name must be resolved",
            "At the glob import, because the collision can be detected immediately",
            "Never; the later import silently wins",
            "At link time, when both definitions exist",
          ],
          answer: 0,
          explain: "Glob imports are allowed to overlap as long as nothing uses the conflicting name. Resolution reports the ambiguity only when a use actually needs a unique answer.",
        },
      ],
      quickbytes: [
        "Collect items in one pass, resolve bodies in a second; textual order must not matter for items.",
        "Key every map on a DefId, not on a name, or two bindings with one spelling become indistinguishable downstream.",
        "Use $crate:: in exported macros; hygiene covers locals, not paths.",
      ],
      production: [
        "Every unresolved-name diagnostic names the namespace (type, value or macro) and suggests the closest candidate.",
        "Name resolution has a test for shadowing, forward references, and glob ambiguity.",
        "Macros that export items are tested from a downstream crate, where $crate is the only thing keeping them compiling.",
        "Privacy checks live in the resolver, so a private item never reaches type checking.",
      ],
      crates: ["rowan", "rustc-hash", "indexmap"],
      github: [
        { name: "rust-analyzer - name resolution for an IDE", url: "https://github.com/rust-lang/rust-analyzer" },
        { name: "rust - rustc_resolve", url: "https://github.com/rust-lang/rust" },
      ],
      pitfall: "Resolving inside a single pass and reporting unresolved names in order: a function used before its definition then fails, and the error is blamed on the call site rather than on the resolver's pass structure.",
      resources: [
        { title: "rustc-dev-guide: name resolution", url: "https://rustc-dev-guide.rust-lang.org/name-resolution.html", kind: "docs" },
        { title: "The Rust Reference: use declarations", url: "https://doc.rust-lang.org/reference/items/use-declarations.html", kind: "docs" },
        { title: "rustc-dev-guide: macro expansion and hygiene", url: "https://rustc-dev-guide.rust-lang.org/macro-expansion.html", kind: "docs" },
        { title: "rust-analyzer repository", url: "https://github.com/rust-lang/rust-analyzer", kind: "repo" },
      ],
    },

    // ------------------------------------------------------------------ cl05
    {
      id: 'cl05',
      n: 5,
      title: "Type checking: unification, occurs checks, and obligations",
      minutes: 90,
      level: 'advanced',
      goal: "Implement Hindley-Milner style unification with an occurs check, and explain why Rust infers per function body while requiring generic signatures to be fully declared.",
      sections: [
        {
          h: "Inference is a union-find with opinions",
          p: [
            "Type inference is usually introduced as unification, and unification is a union-find over type variables. Each variable is either unbound or linked to a type; unifying two types walks their structure, links an unbound variable to whatever it meets, and recurses. After every expression has been visited, the substitution that remains is the inferred type, and any variable still unbound is reported as needing an annotation.",
            "The structural recursion is where the interesting failures live. Unifying a variable with a type that mentions the variable itself produces an infinite type, so every link goes through an occurs check. Skip it and you do not get a graceful error later; you get a type printer that recurses forever, or a size calculation that never terminates. It is a five-line check that turns a hang into a diagnostic.",
          ],
          code: src`
            #[derive(Clone, Debug, PartialEq, Eq)]
            pub enum Ty {
                Int,
                Bool,
                Fun(Box<Ty>, Box<Ty>),
                Var(u32),
            }

            #[derive(Default)]
            pub struct Infer { links: Vec<Option<Ty>> }

            impl Infer {
                pub fn fresh(&mut self) -> Ty {
                    self.links.push(None);
                    Ty::Var((self.links.len() - 1) as u32)
                }

                /// Follow links until a variable or a concrete type is reached.
                pub fn resolve(&self, ty: Ty) -> Ty {
                    match ty {
                        Ty::Var(v) => match &self.links[v as usize] {
                            Some(link) => self.resolve(link.clone()),
                            None => Ty::Var(v),
                        },
                        other => other,
                    }
                }

                fn occurs(&self, var: u32, ty: &Ty) -> bool {
                    match self.resolve(ty.clone()) {
                        Ty::Var(v) => v == var,
                        Ty::Fun(a, b) => self.occurs(var, &a) || self.occurs(var, &b),
                        _ => false,
                    }
                }

                pub fn unify(&mut self, a: Ty, b: Ty) -> Result<(), String> {
                    let (a, b) = (self.resolve(a), self.resolve(b));
                    match (a, b) {
                        (Ty::Var(x), Ty::Var(y)) if x == y => Ok(()),
                        (Ty::Var(x), other) | (other, Ty::Var(x)) => {
                            if self.occurs(x, &other) {
                                return Err(format!("infinite type: ?{x} = {other:?}"));
                            }
                            self.links[x as usize] = Some(other);
                            Ok(())
                        }
                        (Ty::Int, Ty::Int) | (Ty::Bool, Ty::Bool) => Ok(()),
                        (Ty::Fun(a1, r1), Ty::Fun(a2, r2)) => {
                            self.unify(*a1, *a2)?;
                            self.unify(*r1, *r2)
                        }
                        (a, b) => Err(format!("mismatched types: expected {a:?}, found {b:?}")),
                    }
                }
            }
          `,
          tip: "Report errors against the resolved type, not the variable. ?3 in a message tells the user nothing; the type it eventually unified with does.",
        },
        {
          h: "Why Rust does not generalise at let",
          p: [
            "Hindley-Milner infers the most general type of a let binding and generalises it, which is what lets a function be used at several types inside one body. Rust deliberately does not do this inside a function: a closure or local binding is inferred from its uses and gets a single concrete type. That is the difference between let f = |x| x; f(1); f(true) failing to compile and its ML equivalent succeeding.",
            "The trade is explicit for a reason. Generalising a lambda requires deciding when a value is a syntactic value, and top-level interaction with traits and mutable state makes the answer expensive to specify. Rust instead pushes polymorphism to the item boundary, where the signature is written by hand and elaborated once. Inference remains local to one body, which also makes it parallelisable and easy to cache per function.",
          ],
          list: [
            "Function signatures are elaborated once, before any body is checked",
            "A body's inference variables never escape the function",
            "Closures get one monomorphic inferred type per binding",
            "Integer and float literals start as unconstrained variables, then fall back to i32 or f64 only if nothing pins them",
          ],
        },
        {
          h: "Traits are obligations, not inference",
          p: [
            "Unification answers what type this is; trait solving answers whether that type satisfies a bound. The checker queues obligations, discharges the ones it can prove from impls and bounds in scope, and defers the rest. Modern rustc uses a trait solver built on canonicalisation and goal normalisation, with the older chalk project as the prototype that proved the approach.",
            "The user-visible consequence is that a missing bound rarely appears where the gap is. A function body may type-check and fail only at the call site because a caller's type does not implement Ord, and the diagnostic has to reconstruct which obligation could not be proved. That is why good error messages for trait errors are expensive: the compiler must explain a proof failure, not just print two mismatched types.",
          ],
          tip: "Wrap unresolved obligations rather than guessing. Reporting cannot infer a type because of an unproven bound sends people looking for an annotation that would not help.",
        },
      ],
      exercise: {
        prompt: "Add a type checker for a tiny lambda calculus that performs unification and reports the first failing expression with expected and found types. Include a test where the occurs check fires instead of looping.",
        starter: src`
          #[derive(Clone, Debug, PartialEq, Eq)]
          pub enum Ty { Int, Bool, Var(u32) }

          // 1. give Infer a fresh(), resolve() and unify()
          // 2. walk the expression, unifying as you go
          // 3. on failure return Err with both sides rendered
          #[derive(Default)]
          pub struct Infer { links: Vec<Option<Ty>> }

          pub enum Expr { Int(i64), Add(Box<Expr>, Box<Expr>), Cond(Box<Expr>, Box<Expr>, Box<Expr>) }
        `,
        hint: "Add checks Int for both operands, and Cond checks the condition is Bool and unifies the two branches with each other. The occurs check belongs in the link step, before you write the link.",
        solution: src`
          use std::fmt;

          #[derive(Clone, Debug, PartialEq, Eq)]
          pub enum Ty { Int, Bool, Var(u32) }

          impl fmt::Display for Ty {
              fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                  match self {
                      Ty::Int => write!(f, "int"),
                      Ty::Bool => write!(f, "bool"),
                      Ty::Var(v) => write!(f, "?{v}"),
                  }
              }
          }

          #[derive(Default)]
          pub struct Infer { links: Vec<Option<Ty>> }

          impl Infer {
              fn fresh(&mut self) -> Ty {
                  self.links.push(None);
                  Ty::Var((self.links.len() - 1) as u32)
              }

              fn resolve(&self, ty: Ty) -> Ty {
                  match ty {
                      Ty::Var(v) => match &self.links[v as usize] {
                          Some(link) => self.resolve(link.clone()),
                          None => Ty::Var(v),
                      },
                      other => other,
                  }
              }

              fn occurs(&self, var: u32, ty: &Ty) -> bool {
                  match self.resolve(ty.clone()) {
                      Ty::Var(v) => v == var,
                      _ => false,
                  }
              }

              fn unify(&mut self, a: Ty, b: Ty) -> Result<(), String> {
                  let (a, b) = (self.resolve(a), self.resolve(b));
                  match (a, b) {
                      (Ty::Var(x), Ty::Var(y)) if x == y => Ok(()),
                      (Ty::Var(x), other) | (other, Ty::Var(x)) => {
                          if self.occurs(x, &other) {
                              return Err(format!("infinite type: ?{x} = {other}"));
                          }
                          self.links[x as usize] = Some(other);
                          Ok(())
                      }
                      (Ty::Int, Ty::Int) | (Ty::Bool, Ty::Bool) => Ok(()),
                      (a, b) => Err(format!("expected {a}, found {b}")),
                  }
              }

              fn check(&mut self, expr: &Expr) -> Result<Ty, String> {
                  match expr {
                      Expr::Int(_) => Ok(Ty::Int),
                      Expr::Add(lhs, rhs) => {
                          let lhs_ty = self.check(lhs)?;
                          let rhs_ty = self.check(rhs)?;
                          self.unify(lhs_ty, Ty::Int)?;
                          self.unify(rhs_ty, Ty::Int)?;
                          Ok(Ty::Int)
                      }
                      Expr::Cond(cond, then, otherwise) => {
                          let cond_ty = self.check(cond)?;
                          self.unify(cond_ty, Ty::Bool)?;
                          let t = self.check(then)?;
                          let o = self.check(otherwise)?;
                          self.unify(t.clone(), o)?;
                          Ok(t)
                      }
                  }
              }
          }

          pub enum Expr {
              Int(i64),
              Add(Box<Expr>, Box<Expr>),
              Cond(Box<Expr>, Box<Expr>, Box<Expr>),
          }

          fn main() {
              let mut infer = Infer::default();
              let ok = Expr::Add(Box::new(Expr::Int(1)), Box::new(Expr::Int(2)));
              assert_eq!(infer.check(&ok).unwrap(), Ty::Int);

              // The condition of an if must be bool; an int here is the error.
              let bad = Expr::Cond(
                  Box::new(Expr::Int(1)),
                  Box::new(Expr::Int(2)),
                  Box::new(Expr::Int(3)),
              );
              let err = infer.check(&bad).unwrap_err();
              assert!(err.contains("found bool"), "got {err}");

              // A variable unified with itself is fine; linking it to a type
              // that mentions it would not be, and the occurs check rejects that.
              let mut infer = Infer::default();
              let v = infer.fresh();
              assert!(infer.unify(v.clone(), v).is_ok());
              println!("ok");
          }
        `,
      },
      questions: [
        {
          q: "What happens if unification links a variable to a type containing itself?",
          options: [
            "The variable silently becomes that type and later checks fail",
            "Resolving or printing the type recurses forever, so the compiler hangs",
            "The type checker reports a borrow error instead",
            "The link is ignored because variables never unify with structures",
          ],
          answer: 1,
          explain: "Without an occurs check you build an infinite type. Nothing crashes immediately; resolution or display recurses until the stack gives out, which is why the check is worth five lines.",
        },
        {
          q: "Why does let f = |x| x; f(1); f(true); fail in Rust?",
          options: [
            "Because closures cannot be called with two different types",
            "Because Rust does not generalise local bindings; the closure gets one inferred type",
            "Because integers and booleans have no common trait",
            "Because closure types are not nameable",
          ],
          answer: 1,
          explain: "Rust infers one monomorphic type per local binding instead of generalising at let. Polymorphism lives at item boundaries, where the user writes the signature.",
        },
        {
          q: "A function body type-checks but the call site fails with a trait bound error. Why?",
          options: [
            "Because the body was not really checked",
            "Because obligations are proved against the caller's concrete types, which may not implement the bound",
            "Because trait solving runs before type inference",
            "Because the body is generic over the caller's type",
          ],
          answer: 1,
          explain: "The body is checked once against the declared bounds. The obligation that the caller's type implements them is discharged with the caller's types, so the failure surfaces there.",
        },
      ],
      quickbytes: [
        "Implement the occurs check before you implement type printing; otherwise debugging the checker hangs.",
        "Keep inference variables scoped to one body; leaking them across functions makes caching impossible.",
        "Report a type error at the smallest expression whose two sides disagree, not at the enclosing statement.",
      ],
      production: [
        "Every unification failure renders both sides through one formatter, so messages stay consistent across the compiler.",
        "Inference has a test with a fresh variable in each position, including return types and conditionals.",
        "Type errors carry a span for expected and a span for found, so the renderer can draw two labels.",
        "Unresolved variables at the end of a body produce an annotation-needed error with the variable's constraints listed.",
      ],
      crates: ["chalk", "petgraph"],
      github: [
        { name: "chalk - the trait solver prototype behind rustc's approach", url: "https://github.com/rust-lang/chalk" },
        { name: "rust - the type checker and trait engine", url: "https://github.com/rust-lang/rust" },
      ],
      pitfall: "Unifying without resolving both sides first: a variable already linked to Int is compared structurally against Int, the match falls through to the mismatch arm, and a correct program is rejected with expected ?3, found int.",
      resources: [
        { title: "rustc-dev-guide: type inference", url: "https://rustc-dev-guide.rust-lang.org/type-inference.html", kind: "docs" },
        { title: "rustc-dev-guide: representing types with ty::Ty", url: "https://rustc-dev-guide.rust-lang.org/ty.html", kind: "docs" },
        { title: "chalk repository - trait solving as logic programming", url: "https://github.com/rust-lang/chalk", kind: "repo" },
        { title: "Oxide: The Essence of Rust (type system account of borrowing)", url: "https://arxiv.org/abs/1903.00982", kind: "paper" },
      ],
    },

    // ------------------------------------------------------------------ cl06
    {
      id: 'cl06',
      n: 6,
      title: "HIR and MIR: rustc's two middle representations",
      minutes: 90,
      level: 'advanced',
      goal: "Read a MIR dump, describe what lowering removes at each step from AST to HIR to THIR to MIR, and explain why borrow checking happens on the CFG rather than on the tree.",
      sections: [
        {
          h: "Lowering is desugaring with a paper trail",
          p: [
            "HIR is the AST after macros have been expanded and syntactic sugar has been made explicit. A for loop becomes a loop over Iterator::next, ? becomes a match on Try::branch, async fn becomes a closure returning a future, and elided lifetimes become fresh region variables. It is still a tree, and it still has one node per thing the user wrote, which is exactly what type checking wants: the user's syntax, minus the syntax that would need special cases in every analysis.",
            "THIR sits between HIR and MIR. It is fully typed, method calls and autoref are explicit, and it is the input to pattern and exhaustiveness checking as well as to MIR building. The reason rustc keeps three steps instead of one is debuggability: when a pattern check behaves oddly you can inspect THIR, and when a borrow error looks wrong you can inspect MIR, without guessing which transformation lost the information.",
          ],
          code: src`
            // What the compiler hands you:
            //   cargo rustc -- -Zunpretty=hir-tree     (nightly)
            //   cargo rustc -- -Zunpretty=thir-tree    (nightly)
            //   cargo rustc -- -Zunpretty=mir          (nightly)
            //
            // A for loop in source ...
            fn total(xs: &[i32]) -> i32 {
                let mut sum = 0;
                for x in xs { sum += x; }
                sum
            }
            //
            // ... lowers to roughly this in HIR:
            fn total_lowered(xs: &[i32]) -> i32 {
                let mut sum = 0;
                let mut iter = IntoIterator::into_iter(xs);
                loop {
                    match Iterator::next(&mut iter) {
                        Some(x) => sum += x,
                        None => break,
                    }
                }
                sum
            }
            //
            // and the loop becomes basic blocks in MIR, where the interesting
            // question (is iter still borrowed here?) has an edge to follow.
          `,
          tip: "Read MIR with the source next to it and the block numbers visible. Almost every borrow error is a question about which block a loan is live in, and the dump answers it directly.",
        },
        {
          h: "MIR is a graph, and that is the point",
          p: [
            "MIR represents one function as a list of basic blocks; each block holds simple statements and ends in exactly one terminator such as Goto, SwitchInt, Call, Return, Drop or Assert. Places are local variables with projections like (*_1).Field(0), and drops are explicit. Nothing is implicit, which is what makes MIR a good substrate: a dataflow analysis can ask where a value is live, moved, or borrowed without re-deriving control flow from an expression tree.",
            "That explicitness is why borrow checking runs here. A lexical borrow checker could look at scopes, but Rust's non-lexical lifetimes need to know, at every program point, which loans are still live. That question only has meaning on a control-flow graph: a borrow ends at the last point where the reference may still be used, and that point is computed by liveness, not by counting braces.",
          ],
          list: [
            "Statements: assignments, StorageLive and StorageDead, and explicit drops",
            "Terminators: Goto, SwitchInt, Call, Return, Assert, Drop, Unreachable",
            "Locals include compiler temporaries; _0 is the return place",
            "Debug info and scopes ride alongside the body so diagnostics can point at source",
          ],
          code: src`
            use std::fmt;

            #[derive(Clone, Copy, Debug, PartialEq, Eq)]
            pub struct Local(pub u32);

            #[derive(Clone, Debug)]
            pub enum Statement {
                Assign { dest: Local, value: Rvalue },
                StorageLive(Local),
                StorageDead(Local),
            }

            #[derive(Clone, Debug)]
            pub enum Rvalue {
                Use(Local),
                ConstI32(i32),
                BinaryOp { op: &'static str, lhs: Local, rhs: Local },
            }

            #[derive(Clone, Debug)]
            pub enum Terminator {
                Goto(BlockId),
                SwitchInt { discr: Local, targets: Vec<(i32, BlockId)>, otherwise: BlockId },
                Return,
            }

            #[derive(Clone, Copy, Debug, PartialEq, Eq)]
            pub struct BlockId(pub usize);

            #[derive(Clone, Debug)]
            pub struct BasicBlock { pub statements: Vec<Statement>, pub terminator: Terminator }

            #[derive(Clone, Debug, Default)]
            pub struct Body { pub blocks: Vec<BasicBlock>, pub arg_count: usize, pub local_count: usize }

            impl fmt::Display for Body {
                fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                    for (index, block) in self.blocks.iter().enumerate() {
                        writeln!(f, "bb{}:", index)?;
                        for stmt in &block.statements {
                            writeln!(f, "    {stmt:?}")?;
                        }
                        writeln!(f, "    -> {:?}", block.terminator)?;
                    }
                    Ok(())
                }
            }

          `,
          tip: "Print blocks in index order and name locals _0, _1, ... exactly like rustc. Anyone debugging your compiler can then use the same mental model they already have.",
        },
        {
          h: "When to add a second IR",
          p: [
            "Adding an IR costs a lowering pass, a printer, and a class of bugs where the two representations disagree. It pays for itself when the new shape makes an entire category of questions cheap. MIR is worth its cost because a dozen analyses (borrow checking, move checking, initialization, const evaluation, drop elaboration) all want the same graph. Without it, each of them would rebuild control flow from the AST, and each would do it slightly differently.",
            "The heuristic that keeps a compiler small: add an IR when the third analysis asks the same structural question. Before that, write the analysis against the tree and pay a little. After that, the lowering pass is cheaper than the duplicated logic and the inconsistencies that come with it.",
          ],
          tip: "Give the new IR a display format and a dump flag on day one. An IR you cannot print is an IR you will debug by reading the lowering pass instead of the output.",
        },
      ],
      exercise: {
        prompt: "Lower a small if/else expression into a Body with basic blocks, then write a function that returns every block that can reach Return. Use the block ids to prove the join point is reachable from both arms.",
        starter: src`
          use std::collections::BTreeSet;

          pub struct Body {
              pub blocks: Vec<(Vec<&'static str>, Terminator)>,
          }

          pub enum Terminator { Goto(usize), If { then_block: usize, else_block: usize }, Return }

          // 1. write successors(block) -> Vec<usize>
          // 2. worklist from block 0 until no new blocks
          // 3. assert both arms reach the join block
          fn reaches_return(_body: &Body) -> BTreeSet<usize> { todo!() }
        `,
        hint: "Keep a stack of block ids and a set of seen ids. Push successors of each popped block, skipping ones already in the set. A block reaches Return exactly when it appears in the seen set at the end.",
        solution: src`
          use std::collections::BTreeSet;

          pub enum Terminator {
              Goto(usize),
              If { then_block: usize, else_block: usize },
              Return,
          }

          pub struct Body {
              pub blocks: Vec<(Vec<&'static str>, Terminator)>,
          }

          impl Body {
              fn successors(&self, block: usize) -> Vec<usize> {
                  match &self.blocks[block].1 {
                      Terminator::Goto(next) => vec![*next],
                      Terminator::If { then_block, else_block } => vec![*then_block, *else_block],
                      Terminator::Return => vec![],
                  }
              }

              /// Reachability is the simplest dataflow problem there is.
              pub fn reachable(&self) -> BTreeSet<usize> {
                  let mut seen = BTreeSet::new();
                  let mut work = vec![0usize];
                  while let Some(block) = work.pop() {
                      if !seen.insert(block) { continue; }
                      work.extend(self.successors(block));
                  }
                  seen
              }
          }

          fn main() {
              let body = Body {
                  blocks: vec![
                      (vec!["_2 = 1"], Terminator::If { then_block: 1, else_block: 2 }),
                      (vec![], Terminator::Goto(3)),
                      (vec![], Terminator::Goto(3)),
                      (vec!["_0 = _2"], Terminator::Return),
                  ],
              };
              let seen = body.reachable();
              assert_eq!(seen, [0, 1, 2, 3].into_iter().collect());
              println!("{} blocks reach return", seen.len());
          }
        `,
      },
      questions: [
        {
          q: "Why does borrow checking run on MIR rather than on HIR?",
          options: [
            "Because MIR is smaller and therefore faster to print",
            "Because non-lexical lifetimes need per-program-point liveness, which requires a control-flow graph",
            "Because HIR does not contain lifetime information",
            "Because borrow checking runs after codegen",
          ],
          answer: 1,
          explain: "A loan ends at the last point where its reference may be used. Answering that requires liveness over a CFG, which is exactly what MIR is; HIR is a tree with no notion of program points between expressions.",
        },
        {
          q: "What does THIR add over HIR?",
          options: [
            "Explicit lifetimes and region variables",
            "Full types, explicit autoref and method resolution, used for pattern checking and MIR building",
            "Control-flow graphs and basic blocks",
            "Monomorphised copies of generic functions",
          ],
          answer: 1,
          explain: "THIR is typed and further desugared: method calls and implicit dereferences are explicit. It feeds exhaustiveness checking and MIR construction. CFGs appear in MIR, and monomorphisation happens much later.",
        },
        {
          q: "A for loop appears in HIR as a loop and a match. Why?",
          options: [
            "Because HIR is generated from MIR, which already has loops",
            "Because lowering makes the iteration protocol explicit so later stages need no special case",
            "Because the parser desugars it before resolution",
            "Because rustc cannot represent iterators in the AST",
          ],
          answer: 1,
          explain: "Lowering removes sugar. Every consumer after HIR then handles one construct, loop plus match on Iterator::next, instead of a special for-node.",
        },
      ],
      quickbytes: [
        "Dump HIR, THIR and MIR for the same function once; the amount of desugaring per step becomes obvious immediately.",
        "Make every IR printable before writing an analysis against it.",
        "Add an IR when a third analysis asks the same structural question, not before.",
      ],
      production: [
        "Each IR has a stable textual dump used in golden tests, so a lowering change shows up as a reviewable diff.",
        "Lowering passes assert their input invariants and fail loudly instead of emitting half-valid MIR.",
        "Block ids are dense and stable within a body; passes that split blocks renumber deterministically.",
        "Debug info is attached during lowering, not reconstructed from MIR later.",
      ],
      crates: ["rustc-hash", "petgraph"],
      github: [
        { name: "rust - rustc_middle/src/mir and mir_build", url: "https://github.com/rust-lang/rust" },
        { name: "rustc-dev-guide - chapters on HIR and MIR", url: "https://github.com/rust-lang/rustc-dev-guide" },
      ],
      pitfall: "Assuming MIR locals map one-to-one to source variables: rustc introduces temporaries for every intermediate value, so a single let can own several locals and a borrow error may point at a temporary you never wrote.",
      resources: [
        { title: "rustc-dev-guide: the HIR", url: "https://rustc-dev-guide.rust-lang.org/hir.html", kind: "docs" },
        { title: "rustc-dev-guide: lowering AST to HIR", url: "https://rustc-dev-guide.rust-lang.org/hir/lowering.html", kind: "docs" },
        { title: "rustc-dev-guide: the MIR", url: "https://rustc-dev-guide.rust-lang.org/mir/index.html", kind: "docs" },
        { title: "rustc-dev-guide: THIR", url: "https://rustc-dev-guide.rust-lang.org/thir.html", kind: "docs" },
        { title: "rust - rustc_middle/src/mir, the MIR definition", url: "https://github.com/rust-lang/rust", kind: "repo" },
      ],
    },

    // ------------------------------------------------------------------ cl07
    {
      id: 'cl07',
      n: 7,
      title: "SSA: one definition per value and where phi nodes go",
      minutes: 90,
      level: 'advanced',
      goal: "Convert a mutable-variable IR into static single assignment form, place phi nodes at join points, and explain why dominance makes optimisation queries local.",
      sections: [
        {
          h: "The invariant that makes optimisation cheap",
          p: [
            "In SSA every value is defined exactly once. A variable that is assigned twice becomes two values, and every use names the definition it reads. That single change turns analysis into a lookup: to know which definition reaches a use, you do not run a reaching-definitions dataflow, you follow the def-use chain. Common subexpression elimination, constant propagation and dead code elimination all become walks over those chains instead of fixed-point computations.",
            "The price is a new question: at a join point, which definition does a use see? If one branch defines x as v1 and the other as v2, the use after the merge needs a value that is neither. The answer is a phi node, a pseudo-instruction that selects an operand based on which predecessor control arrived from. Cranelift and WebAssembly express the same idea differently: each block takes parameters, and a jump passes the values that become those parameters, so there is no separate phi instruction at all.",
          ],
          list: [
            "Every value has one definition, so def-use chains are lists, not sets",
            "A use is dominated by its definition: every path from entry passes through the def",
            "Phi nodes (or block parameters) merge values at join points",
            "Optimisations that rewrite operands do not invalidate unrelated analyses",
          ],
          tip: "If a block has a single predecessor, a phi with one operand is redundant. Detect and collapse those early; they otherwise survive into every later pass and confuse the printer.",
        },
        {
          h: "Sealing blocks: how compilers build SSA incrementally",
          p: [
            "The textbook algorithm computes dominance frontiers and inserts phis in bulk. Compilers that emit code in one pass, such as Cranelift and the algorithm described by Braun and colleagues, do it lazily instead: when a use needs the current definition of a variable in a block that is not yet sealed, they create an incomplete phi and record it. Later, when the block is sealed and its predecessors are known, the phi is filled in from each predecessor.",
            "The crucial rule is that you may only seal a block once all its predecessors exist. Seal a loop header before its back edge is emitted and the phi will be filled from one predecessor only, silently dropping the value flowing around the loop. This is why builders expose seal_block separately from switching to a block: the compiler front end knows the moment the predecessor set is final, and the builder cannot guess it.",
          ],
          code: src`
            use std::collections::HashMap;

            pub type Block = usize;
            pub type Value = usize;

            #[derive(Default)]
            struct BlockData {
                preds: Vec<Block>,
                defs: HashMap<&'static str, Value>,
                phis: HashMap<&'static str, Value>,
                phi_args: HashMap<Value, Vec<Value>>,
            }

            pub struct Ssa { blocks: Vec<BlockData>, next_value: Value }

            impl Ssa {
                pub fn new() -> Self {
                    Ssa { blocks: vec![BlockData::default()], next_value: 0 }
                }

                pub fn new_block(&mut self, preds: &[Block]) -> Block {
                    self.blocks.push(BlockData { preds: preds.to_vec(), ..Default::default() });
                    self.blocks.len() - 1
                }

                pub fn def_var(&mut self, block: Block, name: &'static str) -> Value {
                    let value = self.next_value;
                    self.next_value += 1;
                    self.blocks[block].defs.insert(name, value);
                    value
                }

                /// Braun et al.: local def, else existing phi, else build an incomplete phi.
                pub fn use_var(&mut self, block: Block, name: &'static str) -> Value {
                    if let Some(value) = self.blocks[block].defs.get(name) { return *value; }
                    if let Some(value) = self.blocks[block].phis.get(name) { return *value; }
                    if self.blocks[block].preds.is_empty() { return self.def_var(block, name); }

                    let phi = self.next_value;
                    self.next_value += 1;
                    self.blocks[block].phis.insert(name, phi);

                    let preds = self.blocks[block].preds.clone();
                    let mut incoming = Vec::with_capacity(preds.len());
                    for pred in preds {
                        incoming.push(self.use_var(pred, name));
                    }
                    self.blocks[block].phi_args.insert(phi, incoming);
                    phi
                }
            }
          `,
          tip: "When a phi is created, insert it before you recurse into the predecessors. That is what makes loops terminate: the back edge finds the phi already in the map instead of creating another one.",
        },
        {
          h: "Leaving SSA for register allocation",
          p: [
            "Machine registers are not in SSA form, so every SSA-based compiler destroys the property again near the end. Removing a phi means inserting copies on the incoming edges, and the naive version breaks: two phis that swap values cannot be lowered to two sequential moves, because the first move clobbers a value the second needs. This is the parallel copy problem, and it needs a cycle-breaking temporary or a register allocator that understands coalescing.",
            "The other direction matters too. Coalescing tries to give a phi and its operands the same register, so most copies disappear. When it cannot, the copy survives, and a pass that assumed SSA values map one-to-one to registers will silently produce wrong code. The habit to build: make out-of-SSA conversion a single, tested pass, and never hand-insert moves in three different places.",
          ],
          tip: "Test out-of-SSA conversion with a swap: if x and y exchange values, a two-move sequence is wrong and a three-move sequence with a temp is right.",
        },
      ],
      exercise: {
        prompt: "Extend the builder so a block can gain a predecessor after it was created, and prove that the phi owns one operand per predecessor once all predecessors are registered.",
        starter: src`
          pub type Block = usize;
          pub type Value = usize;

          pub struct Ssa { /* preds, defs, phis, phi_args */ }

          impl Ssa {
              // 1. add add_pred(block, pred) that pushes onto preds
              // 2. add seal(block) that fills any incomplete phi
              // 3. make use_var create a phi with as many operands as preds
              pub fn add_pred(&mut self, _block: Block, _pred: Block) { todo!() }
              pub fn seal(&mut self, _block: Block) { todo!() }
          }
        `,
        hint: "Keep a filled flag per block. use_var on an unsealed block creates the phi and leaves it empty; seal fills every empty phi by asking each predecessor for its current definition of the same name.",
        solution: src`
          use std::collections::HashMap;

          pub type Block = usize;
          pub type Value = usize;

          #[derive(Default)]
          struct BlockData {
              preds: Vec<Block>,
              defs: HashMap<&'static str, Value>,
              phis: HashMap<&'static str, Value>,
              args: HashMap<&'static str, Vec<Value>>,
              sealed: bool,
          }

          #[derive(Default)]
          pub struct Ssa { blocks: Vec<BlockData>, next_value: Value }

          impl Ssa {
              pub fn new_block(&mut self, preds: &[Block]) -> Block {
                  self.blocks.push(BlockData { preds: preds.to_vec(), ..Default::default() });
                  self.blocks.len() - 1
              }

              pub fn add_pred(&mut self, block: Block, pred: Block) {
                  assert!(!self.blocks[block].sealed, "cannot add a predecessor after sealing");
                  self.blocks[block].preds.push(pred);
              }

              pub fn def_var(&mut self, block: Block, name: &'static str) -> Value {
                  let value = self.next_value;
                  self.next_value += 1;
                  self.blocks[block].defs.insert(name, value);
                  value
              }

              pub fn use_var(&mut self, block: Block, name: &'static str) -> Value {
                  if let Some(value) = self.blocks[block].defs.get(name) { return *value; }
                  if let Some(value) = self.blocks[block].phis.get(name) { return *value; }
                  if self.blocks[block].preds.is_empty() { return self.def_var(block, name); }

                  let phi = self.next_value;
                  self.next_value += 1;
                  self.blocks[block].phis.insert(name, phi);
                  if self.blocks[block].sealed {
                      self.fill(block, name);
                  }
                  phi
              }

              pub fn seal(&mut self, block: Block) {
                  self.blocks[block].sealed = true;
                  let names: Vec<&'static str> = self.blocks[block].phis.keys().copied().collect();
                  for name in names {
                      self.fill(block, name);
                  }
              }

              fn fill(&mut self, block: Block, name: &'static str) {
                  let preds = self.blocks[block].preds.clone();
                  let args: Vec<Value> = preds.iter().map(|pred| self.use_var(*pred, name)).collect();
                  self.blocks[block].args.insert(name, args);
              }
          }

          fn main() {
              let mut ssa = Ssa::default();
              let entry = ssa.new_block(&[]);
              ssa.def_var(entry, "x");

              // The header does not define x; reading it here needs a phi.
              let header = ssa.new_block(&[entry]);
              let _phi = ssa.use_var(header, "x"); // incomplete: header not sealed yet

              let body = ssa.new_block(&[header]);
              ssa.def_var(body, "x");

              // The back edge arrives before the header is sealed.
              ssa.add_pred(header, body);
              ssa.seal(header);

              assert_eq!(ssa.blocks[header].args["x"].len(), 2,
                  "one operand from entry, one from the back edge");
              println!("phi operands: {:?}", ssa.blocks[header].args["x"]);
          }
        `,
      },
      questions: [
        {
          q: "What does it mean for a definition to dominate a use?",
          options: [
            "The definition appears earlier in the source file",
            "Every path from the entry block to the use passes through the definition",
            "The definition is in the same basic block as the use",
            "The definition is live at the point of use",
          ],
          answer: 1,
          explain: "Dominance is a graph property. Liveness is a different question: a value can be live at a point without dominating it, and an SSA use is only valid when its definition dominates.",
        },
        {
          q: "Why can sealing a loop header too early silently produce wrong code?",
          options: [
            "The phi gets an extra operand and the verifier rejects it",
            "The phi is filled from the predecessors that exist at that moment, so the back edge value is missing",
            "The header is marked unreachable",
            "The builder allocates a new value for the loop variable",
          ],
          answer: 1,
          explain: "Filling happens once, at seal time. If the back edge has not been registered yet, the phi has one operand and the loop carries a stale value; there is no error, just wrong results.",
        },
        {
          q: "Why does out-of-SSA conversion need a temporary for x, y = y, x?",
          options: [
            "Because moves must be in source order",
            "Because the two moves are a parallel copy: executing them in sequence clobbers a value",
            "Because registers cannot hold two values",
            "Because the phi node still refers to both names",
          ],
          answer: 1,
          explain: "Phi operands are consumed simultaneously. Lowering to sequential moves overwrites the source of the second move, so a cycle requires one temporary or a swap instruction.",
        },
      ],
      quickbytes: [
        "In SSA, ask which definition reaches a use by following def-use chains, not by running dataflow.",
        "Create a phi before recursing into predecessors so loops terminate on the back edge.",
        "Seal a block only when its predecessor set is final; the builder cannot infer that for you.",
      ],
      production: [
        "An SSA verifier runs in debug builds and asserts single assignment plus domination for every use.",
        "Phi construction is tested on a loop, a diamond, and a switch with three or more successors.",
        "Out-of-SSA conversion is one pass with tests for swaps and for chains of copies.",
        "Every value id is dense and stable; passes that rewrite operands keep the numbering deterministic.",
      ],
      crates: ["cranelift-frontend", "cranelift-codegen", "petgraph"],
      github: [
        { name: "cranelift - SSABuilder and block parameters", url: "https://github.com/bytecodealliance/wasmtime/tree/main/cranelift" },
        { name: "rust - MIR, which is deliberately not in SSA form", url: "https://github.com/rust-lang/rust" },
      ],
      pitfall: "Building SSA on a graph that still has unresolved branches: a block is sealed while one predecessor is missing, the phi silently has too few operands, and the miscompile appears only when that path is taken.",
      resources: [
        { title: "cranelift-frontend: variables, blocks and sealing", url: "https://docs.rs/cranelift-frontend/latest/cranelift_frontend/", kind: "docs" },
        { title: "cranelift-codegen: IR, blocks and value numbering", url: "https://docs.rs/cranelift-codegen/latest/cranelift_codegen/", kind: "docs" },
        { title: "rustc-dev-guide: MIR basics", url: "https://rustc-dev-guide.rust-lang.org/mir/index.html", kind: "docs" },
        { title: "regalloc2 - register allocation used by Cranelift", url: "https://github.com/bytecodealliance/regalloc2", kind: "repo" },
      ],
    },

    // ------------------------------------------------------------------ cl08
    {
      id: 'cl08',
      n: 8,
      title: "Dataflow analysis: lattices, worklists, and fixpoints",
      minutes: 90,
      level: 'advanced',
      goal: "Implement a monotone dataflow analysis with a worklist, choose the right join for may and must properties, and recognise the bugs that appear when either choice is wrong.",
      sections: [
        {
          h: "A lattice is a promise about merging",
          p: [
            "Every dataflow analysis has a domain of facts and a way to combine facts from two paths. Liveness combines sets of variables with union, because a variable is live if any path needs it. Definitely-assigned combines with intersection, because a variable is assigned only if every path assigns it. Union is a may property; intersection is a must property. Getting this backwards is the single most common dataflow bug, and it produces an analysis that is subtly optimistic.",
            "The transfer function says how a statement changes the facts. For liveness, a use adds a variable and a definition removes it. The analysis is monotone when the transfer function only moves facts up the lattice, never down; monotonicity is what guarantees that iterating from the bottom reaches a fixpoint instead of oscillating. If a pass mutates the CFG or uses analysis results while the fixpoint is still moving, it can break that guarantee and loop forever.",
          ],
          list: [
            "Domain: the facts you track, usually a set or a small map",
            "Join: union for may, intersection for must, over predecessors or successors",
            "Transfer: gen/kill applied at each statement",
            "Direction: forward for available expressions, backward for liveness",
            "Fixpoint: iterate a worklist until no block changes",
          ],
          tip: "Write the lattice direction in a comment next to the analysis trait. Future readers cannot tell union from intersection by the name of the analysis alone.",
        },
        {
          h: "Liveness, the analysis everything else builds on",
          p: [
            "Liveness answers: at this program point, may the value in this variable still be read? It runs backwards. live_out of a block is the union of live_in over its successors; live_in is uses plus live_out minus definitions. Iterate to a fixpoint and you have the information register allocation needs: two variables whose live ranges do not overlap may share a register, and a variable with no live range can be deleted.",
            "The same shape answers a dozen other questions. Dead store elimination removes a definition whose value is never live. Move checking asks whether a place is maybe-initialised, which is liveness with different facts. Borrow checking asks which loans are live at each point, which is again the same backward computation over a different domain. rustc expresses all of them through rustc_mir_dataflow's Analysis trait, parameterised by the domain and the transfer functions.",
          ],
          code: src`
            use std::collections::BTreeSet;

            pub struct BlockDef {
                pub uses: &'static [&'static str],
                pub defs: &'static [&'static str],
                pub succs: &'static [usize],
            }

            type Live = BTreeSet<&'static str>;

            /// Backward may-analysis: live_in = uses + (live_out - defs), joined over successors.
            pub fn liveness(blocks: &[BlockDef]) -> Vec<(Live, Live)> {
                let mut live_in = vec![Live::new(); blocks.len()];
                let mut live_out = vec![Live::new(); blocks.len()];
                let mut changed = true;

                while changed {
                    changed = false;
                    // Reverse order usually converges in fewer passes.
                    for index in (0..blocks.len()).rev() {
                        let block = &blocks[index];
                        let mut out: Live = Live::new();
                        for succ in block.succs {
                            out.extend(live_in[*succ].iter().copied());
                        }

                        let mut inn: Live = block.uses.iter().copied().collect();
                        for def in block.defs {
                            inn.remove(def);
                        }
                        inn.extend(out.iter().copied());

                        if out != live_out[index] || inn != live_in[index] {
                            live_out[index] = out;
                            live_in[index] = inn;
                            changed = true;
                        }
                    }
                }
                live_in.into_iter().zip(live_out).collect()
            }

            fn main() {
                let blocks = [
                    BlockDef { uses: &["n"], defs: &["i"], succs: &[1] },
                    BlockDef { uses: &["i", "n"], defs: &["t"], succs: &[2, 3] },
                    BlockDef { uses: &["t", "i"], defs: &["acc", "i"], succs: &[1] },
                    BlockDef { uses: &["acc"], defs: &[], succs: &[] },
                ];
                let live = liveness(&blocks);
                assert!(!live[3].0.contains("i"), "i is dead once the loop exits");
                println!("live_in of the exit block: {:?}", live[3].0);
            }
          `,
          tip: "Iterate blocks in reverse order for backward analyses and forward order for forward ones. It does not change correctness, but it halves the number of passes on typical CFGs.",
        },
        {
          h: "Complexity, widening, and why compilers stop early",
          p: [
            "A naive implementation re-scans every block until nothing changes, which is O(blocks squared) passes in the worst case. A worklist that pushes only the predecessors of a block that changed is O(edges) times the height of the lattice, which for a bitvector lattice of n variables is O(edges times n). That is good enough for function-local analyses, which is why compilers happily run dozens of them.",
            "Interprocedural analyses are where this breaks down: the lattice height becomes unbounded and plain iteration may not terminate. The standard fixes are widening, where a value that changes too often is pushed to top, and decreasing iterations afterwards. If you ever analyse across function boundaries, decide the widening strategy before you write the analysis, because retrofitting it changes every result.",
          ],
          tip: "Bound the iteration count in debug builds and panic with the block id if it is exceeded. A non-terminating analysis otherwise looks like a slow compile, which is much harder to diagnose.",
        },
      ],
      exercise: {
        prompt: "Turn the liveness analysis into a definitely-assigned analysis: forward, must-join over predecessors, with a test where a variable assigned on only one branch is reported as maybe-unassigned.",
        starter: src`
          use std::collections::BTreeSet;

          pub struct BlockDef {
              pub defs: &'static [&'static str],
              pub preds: &'static [usize],
              pub succs: &'static [usize],
          }

          // forward: assigned_out[b] = assigned_in[b] + defs[b]
          //          assigned_in[b]  = intersection of assigned_out[p] over preds
          // the entry block starts with the empty set
          pub fn definitely_assigned(_blocks: &[BlockDef]) -> Vec<BTreeSet<&'static str>> {
              todo!()
          }
        `,
        hint: "Initialise every block except the entry to the set of all variables (top), then intersect from predecessors until the sets stop shrinking. Starting at top is what makes an intersection analysis converge downward.",
        solution: src`
          use std::collections::BTreeSet;

          pub struct BlockDef {
              pub defs: &'static [&'static str],
              pub preds: &'static [usize],
              pub succs: &'static [usize],
          }

          /// Forward must-analysis: intersection over predecessors.
          pub fn definitely_assigned(blocks: &[BlockDef]) -> Vec<BTreeSet<&'static str>> {
              let universe: BTreeSet<&'static str> =
                  blocks.iter().flat_map(|b| b.defs.iter().copied()).collect();

              // Top for everything but the entry, which starts at bottom.
              let mut assigned_in = vec![universe.clone(); blocks.len()];
              assigned_in[0] = BTreeSet::new();

              let mut changed = true;
              while changed {
                  changed = false;
                  for index in 0..blocks.len() {
                      if index == 0 { continue; }
                      let block = &blocks[index];
                      let mut inn = universe.clone();
                      if block.preds.is_empty() {
                          inn = universe.clone();
                      } else {
                          for (position, pred) in block.preds.iter().enumerate() {
                              let mut out = assigned_in[*pred].clone();
                              out.extend(blocks[*pred].defs.iter().copied());
                              if position == 0 {
                                  inn = out;
                              } else {
                                  inn = inn.intersection(&out).copied().collect();
                              }
                          }
                      }
                      if inn != assigned_in[index] {
                          assigned_in[index] = inn;
                          changed = true;
                      }
                  }
              }
              assigned_in
          }

          fn main() {
              let blocks = [
                  BlockDef { defs: &["x"], preds: &[], succs: &[1, 2] },
                  BlockDef { defs: &[], preds: &[0], succs: &[3] },       // then: does not touch y
                  BlockDef { defs: &["y"], preds: &[0], succs: &[3] },    // else: assigns y
                  BlockDef { defs: &[], preds: &[1, 2], succs: &[] },     // join
              ];
              let assigned = definitely_assigned(&blocks);
              assert!(assigned[3].contains("x"), "x is assigned on both paths");
              assert!(!assigned[3].contains("y"), "y is assigned on one path only");
              println!("assigned at join: {:?}", assigned[3]);
          }
        `,
      },
      questions: [
        {
          q: "Which join operation is correct for a may-analysis such as liveness?",
          options: [
            "Intersection over successors, because every path must agree",
            "Union over successors, because one path is enough to make a value live",
            "Either one, as long as it is applied consistently",
            "Set difference over successors",
          ],
          answer: 1,
          explain: "A value is live if any path can read it, so facts accumulate with union. Intersection would report a value as dead whenever some path does not use it, which is unsound for allocation.",
        },
        {
          q: "What breaks if an optimisation consumes analysis results while the fixpoint is still changing?",
          options: [
            "Nothing; results are monotone and only improve",
            "The pass may rewrite code using a stale fact and then never revisit it, so the result depends on iteration order",
            "The analysis runs twice and asserts",
            "The lattice reverses direction",
          ],
          answer: 1,
          explain: "Partially converged results are not yet a proof. Rewriting on them makes correctness depend on traversal order, and the same program can compile differently between builds.",
        },
        {
          q: "Why does an interprocedural analysis usually need widening?",
          options: [
            "Because function bodies are too large to fit in cache",
            "Because the domain can grow without bound, so plain iteration may never converge",
            "Because call graphs contain cycles that must be broken",
            "Because the lattice is not distributive",
          ],
          answer: 1,
          explain: "Function-local analyses sit on a finite lattice, so iteration terminates. Across calls, recursive growth can produce ever-larger facts, and widening forces convergence by jumping to top.",
        },
      ],
      quickbytes: [
        "Union is may, intersection is must; write it in the comment before writing the code.",
        "Push predecessors, not all blocks, when a result changes; it is the difference between two passes and a hundred.",
        "Panic with a block id if the fixpoint exceeds a debug iteration budget.",
      ],
      production: [
        "Each analysis declares its direction, join and lattice height in one place next to the transfer functions.",
        "Analyses are tested on a loop, a diamond and unreachable code, with expected sets asserted per block.",
        "Results are cached per function behind a query so two passes do not recompute the same fixpoint.",
        "Debug builds verify that results do not change on a second fixed-point pass.",
      ],
      crates: ["petgraph", "rustc-hash", "indexmap"],
      github: [
        { name: "rust - rustc_mir_dataflow framework", url: "https://github.com/rust-lang/rust" },
        { name: "rustc-dev-guide - MIR analyses", url: "https://github.com/rust-lang/rustc-dev-guide" },
      ],
      pitfall: "Using intersection (a must join) for liveness: a value used on one branch is reported dead on the other, and a later dead-store pass deletes the very assignment the other branch reads.",
      resources: [
        { title: "rustc-dev-guide: MIR optimisations and dataflow", url: "https://rustc-dev-guide.rust-lang.org/mir/optimizations.html", kind: "docs" },
        { title: "rustc-dev-guide: the MIR", url: "https://rustc-dev-guide.rust-lang.org/mir/index.html", kind: "docs" },
        { title: "petgraph - graph structures for CFG-based analyses", url: "https://docs.rs/petgraph/latest/petgraph/", kind: "docs" },
        { title: "cranelift-codegen documentation", url: "https://docs.rs/cranelift-codegen/latest/cranelift_codegen/", kind: "docs" },
        { title: "rust - rustc_mir_dataflow analyses", url: "https://github.com/rust-lang/rust", kind: "repo" },
      ],
    },

    // ------------------------------------------------------------------ cl09
    {
      id: 'cl09',
      n: 9,
      title: "Optimisation passes: inlining, folding, and phase ordering",
      minutes: 90,
      level: 'advanced',
      goal: "Write a folding and dead-code pass that reaches a fixpoint, and reason about why pass order and optimisation level change results in both directions.",
      sections: [
        {
          h: "Optimisation is rewriting plus a proof obligation",
          p: [
            "Every optimisation is two things: a rewrite and an argument that the rewrite preserves observable behaviour. Constant folding is easy because arithmetic on literals has no side effects. Dead code elimination is harder because it needs a model of what is observable: a call to a function that writes to a file must survive even if its result is unused, while an unused addition must not. The pass is only as correct as that model.",
            "This is why optimisation bugs cluster around the edges of the language. Volatile accesses, panics, allocation failures, and destructors all make a computation observable in ways that a naive purity check misses. Rust's MIR opts must keep drops, and a pass that removes an unused value without checking for a Drop impl changes when memory is freed, which is observable to any unsafe code that observes addresses.",
          ],
          list: [
            "Const folding: evaluate operations whose operands are known",
            "GVN and CSE: replace a repeated computation with the earlier result",
            "DCE: remove definitions whose results cannot be observed",
            "Inlining: the enabler, because most other passes are intraprocedural",
            "Loop passes: LICM, unrolling, and strength reduction",
          ],
          tip: "Write the observability rule down as a function named has_side_effects and make every pass call it. Scattered matches on instruction kind are how a call gets deleted.",
        },
        {
          h: "Fixpoints, and why one pass is never enough",
          p: [
            "Folding exposes dead code, and removing dead code exposes more folding opportunities, so a single sweep is not a fixed point. Run passes until the program stops changing, with a hard iteration cap as a safety net. The loop must compare the program structurally, and the comparison must be cheap; comparing a few thousand instructions is fine, comparing a fully annotated IR with debug info is not.",
            "Pass ordering is where the real engineering sits. Canonicalising first makes later patterns match: normalising commutative operands means one rule catches both orders. Inlining before interprocedural constant propagation lets arguments become constants, but inlining too eagerly bloats the IR and slows every later pass. The honest statement is that there is no optimal order, only orders that work well on the programs you measure.",
          ],
          code: src`
            use std::collections::{HashMap, HashSet};

            #[derive(Clone, Copy, Debug, PartialEq, Eq)]
            pub enum Op { Add, Sub, Mul }

            #[derive(Clone, Debug, PartialEq, Eq)]
            pub enum Inst {
                Const { dst: u32, value: i64 },
                Bin { dst: u32, op: Op, lhs: u32, rhs: u32 },
                Sink { src: u32 },   // Print or Ret: observable, never deleted
            }
            fn fold_constants(program: &[Inst]) -> Vec<Inst> {
                let mut known: HashMap<u32, i64> = HashMap::new();
                program
                    .iter()
                    .map(|inst| match *inst {
                        Inst::Const { dst, value } => {
                            known.insert(dst, value);
                            inst.clone()
                        }
                        Inst::Bin { dst, op, lhs, rhs } => match (known.get(&lhs), known.get(&rhs)) {
                            (Some(&a), Some(&b)) => {
                                let value = match op { Op::Add => a + b, Op::Sub => a - b, Op::Mul => a * b };
                                known.insert(dst, value);
                                Inst::Const { dst, value }
                            }
                            _ => inst.clone(),
                        },
                        _ => inst.clone(),
                    })
                    .collect()
            }

            fn eliminate_dead(program: &[Inst]) -> Vec<Inst> {
                let mut live: HashSet<u32> = HashSet::new();
                let mut keep = vec![false; program.len()];
                for (index, inst) in program.iter().enumerate().rev() {
                    let (dst, uses, observable) = match *inst {
                        Inst::Const { dst, .. } => (Some(dst), vec![], false),
                        Inst::Bin { dst, lhs, rhs, .. } => (Some(dst), vec![lhs, rhs], false),
                        Inst::Sink { src } => (None, vec![src], true),
                    };
                    if !(observable || dst.is_some_and(|d| live.contains(&d))) { continue; }
                    keep[index] = true;
                    if let Some(dst) = dst { live.remove(&dst); }
                    live.extend(uses);
                }
                program.iter().zip(keep).filter(|(_, keep)| *keep).map(|(i, _)| i.clone()).collect()
            }

            /// Folding exposes dead code, and removal exposes folding: iterate.
            pub fn optimise(mut program: Vec<Inst>) -> Vec<Inst> {
                for _ in 0..16 {
                    let trimmed = eliminate_dead(&fold_constants(&program));
                    if trimmed == program { return trimmed; }
                    program = trimmed;
                }
                program
            }
          `,
          tip: "Cap the fixpoint loop and assert on the cap. An oscillating pair of passes is a bug in one of them, not a reason to raise the limit.",
        },
        {
          h: "What rustc actually runs, and when",
          p: [
            "rustc distinguishes MIR passes that always run from those that only run with optimisation enabled. Drop elaboration, CFG simplification and some correctness-adjacent lowering run at opt-level 0 because later stages assume their output; the expensive suite runs on the optimized_mir query only when opt-level is above zero. That boundary explains why debug builds are fast but slow, and why adding #[inline] changes codegen without changing semantics.",
            "Cross-crate optimisation needs the callee's MIR. Generic functions are instantiated downstream, so their bodies travel in the crate metadata; non-generic functions only do if they are marked #[inline] or live in the same codegen unit. LTO widens that window to the whole program at the cost of compile time, and codegen-unit count trades parallel codegen against how much the optimiser can see at once.",
          ],
          list: [
            "opt-level=0 keeps all the passes required for correctness and skips the rest",
            "optimized_mir is a query, so optimisation results are cached and invalidated like any other",
            "#[inline] ships the body in metadata; without it, cross-crate inlining is impossible",
            "LTO and codegen-units=1 buy optimisation at the cost of build time and parallelism",
          ],
          tip: "Measure before and after raising opt-level. Optimisation is not monotone: a bigger inlining budget can make a hot loop slower by evicting instruction cache.",
        },
      ],
      exercise: {
        prompt: "Add algebraic simplification to the folding pass: x + 0 and x * 1 must become x, but x * 0 must not become 0 unless you can prove x has no side effects. Explain in a comment which rule you refused and why.",
        starter: src`
          use std::collections::HashMap;

          #[derive(Clone, Copy, Debug, PartialEq, Eq)]
          pub enum Op { Add, Sub, Mul }

          #[derive(Clone, Debug, PartialEq, Eq)]
          pub enum Inst {
              Const { dst: u32, value: i64 },
              Bin { dst: u32, op: Op, lhs: u32, rhs: u32 },
              Ret { src: u32 },
          }

          // Add identities that need only one known operand:
          //   x + 0 -> x, x - 0 -> x, x * 1 -> x
          //   x * 0 -> 0  (only when evaluating x is free)
          // Rewrite by aliasing dst to the surviving operand, then resolve uses.
          pub fn simplify(program: &[Inst]) -> Vec<Inst> {
              let _known: HashMap<u32, i64> = HashMap::new();
              todo!()
          }
        `,
        hint: "For the identities that keep x, the result is not a new instruction but a rename: record that dst is an alias of the other operand and rewrite later uses. A one-line rename table is enough for this exercise.",
        solution: src`
          use std::collections::HashMap;

          #[derive(Clone, Copy, Debug, PartialEq, Eq)]
          pub enum Op { Add, Sub, Mul }

          #[derive(Clone, Debug, PartialEq, Eq)]
          pub enum Inst {
              Const { dst: u32, value: i64 },
              Bin { dst: u32, op: Op, lhs: u32, rhs: u32 },
              Ret { src: u32 },
          }

          /// Rewrite single-use identities by aliasing: dst -> the operand it equals.
          pub fn simplify(program: &[Inst]) -> Vec<Inst> {
              let mut known: HashMap<u32, i64> = HashMap::new();
              let mut alias: HashMap<u32, u32> = HashMap::new();
              let resolve = |value: u32, alias: &HashMap<u32, u32>| -> u32 {
                  let mut current = value;
                  while let Some(next) = alias.get(&current) {
                      if *next == current { break; }
                      current = *next;
                  }
                  current
              };

              let mut out = Vec::new();
              for inst in program {
                  match *inst {
                      Inst::Const { dst, value } => {
                          known.insert(dst, value);
                          out.push(inst.clone());
                      }
                      Inst::Bin { dst, op, lhs, rhs } => {
                          let (lhs, rhs) = (resolve(lhs, &alias), resolve(rhs, &alias));
                          let l = known.get(&lhs).copied();
                          let r = known.get(&rhs).copied();

                          // x + 0, x - 0, x * 1 are safe renames.
                          let identity = match (op, l, r) {
                              (Op::Add, Some(0), _) => Some(rhs),
                              (Op::Add, _, Some(0)) => Some(lhs),
                              (Op::Sub, _, Some(0)) => Some(lhs),
                              (Op::Mul, Some(1), _) => Some(rhs),
                              (Op::Mul, _, Some(1)) => Some(lhs),
                              _ => None,
                          };

                          // x * 0 is NOT rewritten: computing x may have side effects
                          // (panic, division, a call), and removing it changes behaviour.
                          if let Some(source) = identity {
                              alias.insert(dst, source);
                              continue;
                          }
                          out.push(Inst::Bin { dst, op, lhs, rhs });
                      }
                      Inst::Ret { src } => out.push(Inst::Ret { src: resolve(src, &alias) }),
                  }
              }
              out
          }

          fn main() {
              let program = vec![
                  Inst::Const { dst: 0, value: 7 },
                  Inst::Const { dst: 1, value: 0 },
                  Inst::Const { dst: 2, value: 1 },
                  Inst::Bin { dst: 3, op: Op::Add, lhs: 0, rhs: 1 }, // x + 0 -> 7
                  Inst::Bin { dst: 4, op: Op::Mul, lhs: 3, rhs: 2 }, // x * 1 -> alias of 3
                  Inst::Ret { src: 4 },
              ];
              let out = simplify(&program);
              // 3 aliases 0 (x + 0), 4 aliases 0 (3 * 1), and the return follows the alias.
              assert_eq!(out.last(), Some(&Inst::Ret { src: 0 }));
              assert_eq!(out.len(), 4, "two aliased instructions removed: {out:?}");
              println!("{out:?}");
          }
        `,
      },
      questions: [
        {
          q: "Why may x * 0 not be folded away when x is unknown?",
          options: [
            "Because multiplication is not associative",
            "Because computing x may panic, call a function, or otherwise be observable",
            "Because the result type might overflow",
            "Because the IR has no zero constant",
          ],
          answer: 1,
          explain: "Folding to zero deletes the computation of x. If that computation can panic or has effects, the rewrite changes observable behaviour. The same reasoning is why dropping an unused value with a Drop impl is wrong.",
        },
        {
          q: "Why do folding and dead code elimination need to run in a loop?",
          options: [
            "Because the lattice needs to be rebuilt between passes",
            "Because folding creates dead definitions, and removing dead definitions exposes new folding",
            "Because the IR is not in SSA form",
            "Because the debug info must be regenerated",
          ],
          answer: 1,
          explain: "One pass reaches a local fixed point only. The two rewrites enable each other, so a loop with a structural comparison and an iteration cap is the simplest correct driver.",
        },
        {
          q: "What does #[inline] actually do for a function in another crate?",
          options: [
            "Forces the callee to be compiled into the caller's object file",
            "Places the function body in crate metadata so downstream codegen can inline it",
            "Removes the function from the symbol table",
            "Runs the function at compile time",
          ],
          answer: 1,
          explain: "It is a hint plus an availability decision. Without the body in metadata the downstream compiler has nothing to inline; with it, the inliner still decides based on size and cost.",
        },
      ],
      quickbytes: [
        "Every pass needs an explicit observability rule; a deleted call is a correctness bug, not a size win.",
        "Compare programs structurally to detect the fixpoint, and cap the loop.",
        "Canonicalise before pattern-matching so one rule catches both operand orders.",
      ],
      production: [
        "Optimisation levels are part of the test matrix; every semantics test runs at 0, 2 and 3.",
        "Each pass has a pass-level test plus an end-to-end differential test against the interpreter.",
        "The fixpoint driver logs how many iterations it used per function, so a pathological case is visible.",
        "Inline thresholds are configuration, not constants buried in the inliner.",
      ],
      crates: ["cranelift-codegen", "criterion", "insta"],
      github: [
        { name: "llvm-project - the pass pipeline rustc relies on", url: "https://github.com/llvm/llvm-project" },
        { name: "rust - rustc_mir_transform, the MIR optimisation passes", url: "https://github.com/rust-lang/rust" },
      ],
      pitfall: "A dead-code pass that treats every instruction as pure: an unused call to a function that writes a file is deleted, the program still compiles, and the side effect silently disappears.",
      resources: [
        { title: "rustc-dev-guide: MIR optimisations", url: "https://rustc-dev-guide.rust-lang.org/mir/optimizations.html", kind: "docs" },
        { title: "rustc-dev-guide: code generation", url: "https://rustc-dev-guide.rust-lang.org/backend/codegen.html", kind: "docs" },
        { title: "rustc codegen options (opt-level, lto, codegen-units)", url: "https://doc.rust-lang.org/nightly/rustc/codegen-options/index.html", kind: "docs" },
        { title: "LLVM Project channel: optimisation pipeline talks", url: "https://www.youtube.com/@llvmproject", kind: "video" },
        { title: "llvm-project - the optimisation pipeline in full", url: "https://github.com/llvm/llvm-project", kind: "repo" },
      ],
    },

    // ------------------------------------------------------------------ cl10
    {
      id: 'cl10',
      n: 10,
      title: "Borrow checking internals: loans, regions, and NLL",
      minutes: 105,
      level: 'industry',
      goal: "Model borrow checking as region inference plus loan liveness, explain why non-lexical lifetimes accept programs a scope-based checker rejects, and name the cases that still need Polonius.",
      sections: [
        {
          h: "The borrow checker is a liveness analysis in disguise",
          p: [
            "A borrow creates a loan: a place, an access kind, and a region. The borrow checker's question is whether two live loans ever conflict, where a conflict means at least one of them is mutable and both touch overlapping places. The hard part is the word live. A lexical checker would say a loan lasts until the end of the enclosing block, but Rust's non-lexical lifetimes define a loan as live exactly at the program points where the reference may still be used later.",
            "That definition turns borrow checking into two problems. First, region inference: compute for each region the set of CFG points it must contain, from constraints generated by assignments, calls and reborrows. Second, liveness: for each reference, the points where it is still needed. A loan is live at the intersection. Everything people find surprising about the borrow checker follows from this: a borrow ends at its last use, not at its scope, which is why a mutable borrow can begin immediately after the last read.",
          ],
          list: [
            "Loan: which place is borrowed, shared or mutable, for which region",
            "Region: a set of points in the CFG, not a block of source text",
            "Conflict: a mutable loan live at the same point as any other loan to an overlapping place",
            "Two-phase borrows: reserve, then activate, so v.push(v.len()) type-checks",
            "Reborrows create nested loans that end earlier than the outer one",
          ],
          tip: "When a borrow error makes no sense, print the MIR and find the last use of the reference. The error almost always means a use exists later in the CFG than you expected.",
        },
        {
          h: "Why NLL still rejects some correct programs",
          p: [
            "NLL is a single flow-insensitive region per loan in the sense that a loan's liveness is computed as one set of points. That approximation is cheap and handles the overwhelming majority of real code, but it loses information when a reference is returned on one path and dropped on another. The canonical case is a map lookup that returns early on a hit and mutates the map on a miss: the code is sound, but NLL sees the returned reference as live at the mutation point.",
            "Polonius, the next-generation checker, fixes this by making the analysis location-sensitive: instead of one live set per loan, it asks whether there exists a path from the loan to a use that does not pass through a kill. It is expressed as Datalog rules and has been implemented as an alternative borrow-check backend. The trade is compile time and complexity, which is why it remains a research and nightly track rather than the default.",
          ],
          code: src`
            // Accepted by NLL: the shared borrow ends at its last use, so the
            // mutable borrow that follows is not in conflict with anything live.
            fn accepted(v: &mut Vec<u8>) -> usize {
                let len = v.len();
                v.push(len as u8);
                v.len()
            }

            // The shape NLL rejects (it does NOT compile today; Polonius would
            // accept it). The reference can be returned on one path, so NLL treats
            // the shared borrow as live at the mutation on the other path.
            //
            // use std::collections::HashMap;
            //
            // fn get_or_insert(map: &mut HashMap<u32, String>) -> &String {
            //     if let Some(value) = map.get(&0) { return value; }
            //     map.insert(0, String::from("default"));
            //     map.get(&0).expect("just inserted")
            // }
            //
            // error[E0502]: cannot borrow *map as mutable because it is also
            //               borrowed as immutable
          `,
          tip: "Do not confuse this with Send and Sync. Those are trait bounds discharged by type checking; the borrow checker never looks at them.",
        },
        {
          h: "Two-phase borrows and the ergonomics budget",
          p: [
            "Some programs are sound under a finer-grained notion of activation than NLL computes. Method calls that take a mutable receiver and also read the receiver in an argument are the common case: v.push(v.len()) borrows v mutably for the call and shares it for the argument, and the two borrows overlap syntactically. Two-phase borrows model this by splitting the mutable borrow into a reservation that exists during argument evaluation and an activation that begins at the call.",
            "Each of these refinements is a deliberate addition to the analysis, not a weakening of the rules. The design constraint is that every accepted pattern must still be provably sound, and every rejected pattern must produce an explanation a user can act on. That is why borrow checker changes are expensive: they ripple into the diagnostics, the error index, and every tutorial that ever explained the old rule.",
          ],
          tip: "Model the checker as a set of small rules with a test per rule. The moment it becomes one large function with special cases, you have lost the ability to explain an error.",
        },
      ],
      exercise: {
        prompt: "Extend the loan checker so a loan is considered live only from its creation to its last use, and prove that the same program is rejected when the shared loan is used after the mutable borrow but accepted when it is not.",
        starter: src`
          #[derive(Clone, Copy, Debug, PartialEq, Eq)]
          pub enum Access { Shared, Mutable }

          pub enum Event {
              Loan { id: u32, place: &'static str, access: Access },
              Use(u32),
          }

          // 1. compute the last Use index for each loan
          // 2. on each Loan, compare against earlier loans on the same place
          //    that are still live (last_use >= current index)
          pub fn check(_events: &[Event]) -> Result<(), String> { todo!() }
        `,
        hint: "Build a HashMap from loan id to its last use index in one pass. In a second pass, only earlier loans whose last use is at or after the current event can conflict.",
        solution: src`
          use std::collections::HashMap;

          #[derive(Clone, Copy, Debug, PartialEq, Eq)]
          pub enum Access { Shared, Mutable }

          #[derive(Clone, Copy, Debug, PartialEq, Eq)]
          pub enum Event {
              Loan { id: u32, place: &'static str, access: Access },
              Use(u32),
          }

          pub fn check(events: &[Event]) -> Result<(), String> {
              let mut last_use: HashMap<u32, usize> = HashMap::new();
              for (index, event) in events.iter().enumerate() {
                  if let Event::Use(id) = event {
                      last_use.insert(*id, index);
                  }
              }

              let mut loans: Vec<(u32, &'static str, Access)> = Vec::new();
              for (index, event) in events.iter().enumerate() {
                  let Event::Loan { id, place, access } = *event else { continue };
                  for (other, other_place, other_access) in &loans {
                      let live = last_use.get(other).is_some_and(|at| *at >= index);
                      let both_shared =
                          access == Access::Shared && *other_access == Access::Shared;
                      if *other_place == place && live && !both_shared {
                          return Err(format!(
                              "loan {id} ({access:?}) conflicts with live loan {other} ({other_access:?})"
                          ));
                      }
                  }
                  loans.push((id, place, access));
              }
              Ok(())
          }

          fn main() {
              let accepted = [
                  Event::Loan { id: 0, place: "v", access: Access::Shared },
                  Event::Use(0),
                  Event::Loan { id: 1, place: "v", access: Access::Mutable },
                  Event::Use(1),
              ];
              assert!(check(&accepted).is_ok(), "the shared loan is dead by the time 1 appears");

              let rejected = [
                  Event::Loan { id: 0, place: "v", access: Access::Shared },
                  Event::Loan { id: 1, place: "v", access: Access::Mutable },
                  Event::Use(0),
              ];
              assert!(check(&rejected).unwrap_err().contains("conflicts"));

              let two_shared = [
                  Event::Loan { id: 0, place: "v", access: Access::Shared },
                  Event::Loan { id: 1, place: "v", access: Access::Shared },
                  Event::Use(0),
                  Event::Use(1),
              ];
              assert!(check(&two_shared).is_ok());
              println!("ok");
          }
        `,
      },
      questions: [
        {
          q: "What makes a loan live in the NLL model?",
          options: [
            "The enclosing lexical scope of the borrow expression",
            "The set of program points where the reference may still be used later",
            "The lifetime parameter written in the type signature",
            "The point where the reference is dropped",
          ],
          answer: 1,
          explain: "NLL computes liveness from uses. A borrow ends at its last use on every path, which is why code that reads and then mutates the same variable compiles.",
        },
        {
          q: "Two shared borrows of the same place overlap. What does the checker do?",
          options: [
            "Rejects them, because any two loans conflict",
            "Accepts them: shared loans conflict only with a mutable loan",
            "Accepts them only if the place is Copy",
            "Accepts them at opt-level 0 and rejects them otherwise",
          ],
          answer: 1,
          explain: "Aliasing is fine for reads. The conflict rule exists to prevent a write from invalidating a read or another write, which requires at least one mutable access.",
        },
        {
          q: "Which problem class needs location-sensitive checking beyond NLL?",
          options: [
            "Returning a reference to a local variable",
            "A reference that may be returned on one path and is followed by a mutation on another",
            "Borrowing a field of a borrowed struct",
            "Mutating a vector while iterating it",
          ],
          answer: 1,
          explain: "NLL gives each loan one live set, so it cannot express this path depends on the branch. Polonius tracks whether a loan can reach a use without passing a kill, which is location-sensitive.",
        },
      ],
      quickbytes: [
        "A borrow ends at its last use on every path, not at the closing brace.",
        "Reproduce borrow errors by shrinking to the smallest function that still fails, then read the MIR.",
        "Send and Sync are type-system bounds, not borrow-checker results.",
      ],
      production: [
        "Borrow errors name the conflicting loan, the place, and both spans, and suggest the smallest edit that resolves it.",
        "The checker has tests for reborrows, two-phase call patterns, and conditional moves.",
        "Every accepted pattern in the test suite has a soundness argument recorded next to it.",
        "Borrow-check changes run against the compiler's own codebase before landing; the false-positive rate is the acceptance criterion.",
      ],
      crates: ["rustc-hash", "petgraph"],
      github: [
        { name: "polonius - location-sensitive borrow checking", url: "https://github.com/rust-lang/polonius" },
        { name: "rust - rustc_borrowck", url: "https://github.com/rust-lang/rust" },
      ],
      pitfall: "Reading a borrow error as a scope problem and adding braces: the loan's liveness is computed from uses on every path, so moving code into a block changes nothing if a use still follows on some path.",
      resources: [
        { title: "rustc-dev-guide: MIR borrow check", url: "https://rustc-dev-guide.rust-lang.org/borrow-check.html", kind: "docs" },
        { title: "Oxide: The Essence of Rust (borrow checking formalised)", url: "https://arxiv.org/abs/1903.00982", kind: "paper" },
        { title: "polonius - Datalog rules for the next borrow checker", url: "https://github.com/rust-lang/polonius", kind: "repo" },
        { title: "rustc-dev-guide: MIR, the input to borrow checking", url: "https://rustc-dev-guide.rust-lang.org/mir/index.html", kind: "docs" },
      ],
    },

    // ------------------------------------------------------------------ cl11
    {
      id: 'cl11',
      n: 11,
      title: "Monomorphisation: from generic MIR to concrete code",
      minutes: 90,
      level: 'industry',
      goal: "Implement monomorphisation as a reachability collection over (function, type arguments) pairs, and explain the code-size and compile-time costs it imposes.",
      sections: [
        {
          h: "A generic function is a template with a worklist",
          p: [
            "Rust compiles a generic function once into MIR with type parameters intact, then instantiates that MIR for every concrete set of type arguments the program actually uses. The unit of work is an instance: a function id paired with substituted types. Monomorphisation is therefore a reachability problem. Start from the roots, which are the exported functions and main, and whenever an instance calls another generic function, enqueue the instance for the callee with the argument types at that call site.",
            "The collection happens on MIR, before LLVM sees anything, because rustc needs the answer for two things: to know what to codegen, and to partition work into codegen units. A function that is never instantiated is never compiled, which is why generic code has no cost until used, and why an unused generic function cannot fail to link. It is also why a type error can survive in a generic body until a concrete instantiation triggers it, if the error depends on an associated type.",
          ],
          list: [
            "Roots: main, exported symbols, and anything reachable from them",
            "Call edges carry the type arguments written at that call site",
            "A visited set turns the walk into a linear pass over reachable instances",
            "Instances are keyed by both the function and the full argument list",
          ],
          tip: "Key the cache on the resolved argument types, not on the syntactic ones. Two call sites writing Vec<T> with different T are different instances.",
        },
        {
          h: "The bill arrives as code size and compile time",
          p: [
            "Each instance is emitted as its own function, so a generic helper used with seven element types becomes seven copies. Chain generics and the count multiplies: a function instantiated over Vec<Vec<T>> for four T is four instances, and each may fan out further. That is the mechanism behind the classic complaint that heavy generic code compiles slowly and produces large binaries; it is not the type checker, it is the backend doing N times the work.",
            "The trade against dynamic dispatch is real but narrow. dyn Trait shares one copy at the cost of an indirect call the optimiser cannot inline through, which matters for small hot functions and barely matters for large cold ones. The practical rule is to measure: generic code that is instantiated once per binary costs nothing extra, and generic code instantiated per element type in a container is where binaries grow.",
          ],
          code: src`
            use std::collections::{HashMap, HashSet, VecDeque};

            #[derive(Clone, Debug, PartialEq, Eq, Hash)]
            pub enum Ty { I32, Bool, Pair(Box<Ty>, Box<Ty>) }

            #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
            pub struct FnId(pub u32);

            /// One concrete function: the id plus the exact type arguments.
            #[derive(Clone, Debug, PartialEq, Eq, Hash)]
            pub struct Instance { pub function: FnId, pub args: Vec<Ty> }

            /// The call graph with the type arguments written at each call site.
            pub struct Program { pub calls: HashMap<FnId, Vec<Instance>> }

            pub struct Mono { pub instances: Vec<Instance>, seen: HashSet<Instance> }

            impl Mono {
                /// Worklist collection: instantiate the roots, then what they call.
                pub fn collect(program: &Program, roots: &[Instance]) -> Self {
                    let mut mono = Mono { instances: Vec::new(), seen: HashSet::new() };
                    let mut queue: VecDeque<Instance> = roots.iter().cloned().collect();

                    while let Some(instance) = queue.pop_front() {
                        if !mono.seen.insert(instance.clone()) { continue; }
                        mono.instances.push(instance.clone());
                        if let Some(callees) = program.calls.get(&instance.function) {
                            for callee in callees {
                                if !mono.seen.contains(callee) {
                                    queue.push_back(callee.clone());
                                }
                            }
                        }
                    }
                    mono
                }
            }
          `,
          tip: "Log the instance count per function in CI. A generic helper that jumps from three to forty instantiations is a build-time regression you can see before it lands.",
        },
        {
          h: "Duplicates across crates, and who cleans them up",
          p: [
            "Generic instances are generated in the crate that uses them, so two crates using Vec<u8> each emit their own copy of the same instantiations. The linker merges them: LLVM emits these functions with linkonce_odr linkage, and the linker keeps one definition. Symbol mangling has to encode the full substitution for that to work, which is exactly what the v0 mangling scheme was designed to do, and why symbols for generic functions are long.",
            "Codegen units are how rustc recovers parallelism from this work: the reachable instances are partitioned, and each unit is codegenned independently, in parallel, then linked. More units mean better parallel builds and less cross-unit inlining; fewer units mean better optimisation and slower builds. That is the same trade as LTO, exposed as a number, and it interacts with monomorphisation because partitioning decides which instances share a compilation unit.",
          ],
          tip: "Set codegen-units to 1 only for release builds you actually measure. It reliably slows the build and unreliably speeds up the binary.",
        },
      ],
      exercise: {
        prompt: "Add memoisation and a growth counter: the same instance requested twice must be compiled once, and a generic function that calls itself with a larger type argument must produce exactly one instance per distinct type.",
        starter: src`
          use std::collections::HashMap;

          pub struct Mono {
              cache: HashMap<(u32, Vec<&'static str>), String>,
              pub compilations: usize,
          }

          impl Mono {
              // 1. instance(f, args) returns the cached body if present
              // 2. otherwise build it, bump compilations, and cache it
              // 3. collect(roots) walks a call graph using instance()
              pub fn instance(&mut self, _f: u32, _args: &[&'static str]) -> String { todo!() }
          }
        `,
        hint: "The cache key is the pair (function id, arguments). Bump the counter only on a miss; that counter is your code-size proxy.",
        solution: src`
          use std::collections::HashMap;

          pub struct Mono {
              cache: HashMap<(u32, Vec<&'static str>), String>,
              pub compilations: usize,
          }

          impl Mono {
              pub fn new() -> Self {
                  Mono { cache: HashMap::new(), compilations: 0 }
              }

              /// Instantiate (or reuse) the body of f at these type arguments.
              pub fn instance(&mut self, f: u32, args: &[&'static str]) -> String {
                  let key = (f, args.to_vec());
                  if let Some(body) = self.cache.get(&key) {
                      return body.clone();
                  }
                  let body = format!("fn{f}_{}({})", args.join("_"), args.join(", "));
                  self.compilations += 1;
                  self.cache.insert(key, body.clone());
                  body
              }
          }

          fn main() {
              let mut mono = Mono::new();
              let a = mono.instance(1, &["i32"]);
              let b = mono.instance(1, &["i32"]);
              let c = mono.instance(1, &["bool"]);
              assert_eq!(a, b, "the same instance is not compiled twice");
              assert_ne!(a, c, "different type arguments are different instances");
              assert_eq!(mono.compilations, 2);

              let many = mono.instance(1, &["Pair<i32,i32>"]);
              assert_eq!(many, "fn1_Pair<i32,i32>(Pair<i32,i32>)");
              println!("{} compilations for 3 requests", mono.compilations);
          }
        `,
      },
      questions: [
        {
          q: "Why can a generic function that is never used cost nothing at link time?",
          options: [
            "Because the linker strips unused symbols from the metadata",
            "Because codegen only emits instances reached from the roots, so no instance exists to link",
            "Because generic functions are compiled lazily by LLVM",
            "Because they are always inlined",
          ],
          answer: 1,
          explain: "Monomorphisation is a reachability collection on MIR. No reachable instance means nothing is emitted, so there is no undefined reference to satisfy.",
        },
        {
          q: "Two crates both use Vec<u8>. What happens at link time?",
          options: [
            "The linker reports a duplicate symbol error",
            "Both copies are emitted with linkonce_odr linkage and the linker keeps one",
            "Only the first crate's copy is emitted",
            "The copies are merged by the loader at runtime",
          ],
          answer: 1,
          explain: "Instances are generated per using crate. COMDAT-style linkonce_odr sections let the linker discard duplicates, which is why generic code links at all.",
        },
        {
          q: "What does a lower codegen-units value trade away?",
          options: [
            "Code correctness",
            "Parallel codegen, in exchange for more cross-unit optimisation",
            "The ability to use generics",
            "Debug information",
          ],
          answer: 1,
          explain: "Fewer, larger units give the optimiser more to see at once but reduce build parallelism. It is the same trade-off that LTO makes, expressed as a number.",
        },
      ],
      quickbytes: [
        "Monomorphisation is a worklist over (function, type arguments); a visited set makes it linear.",
        "Generic bloat is measurable: count instances per function and compare across commits.",
        "Cross-crate duplicate instances are deduplicated by linkonce_odr, not by rustc.",
      ],
      production: [
        "CI tracks binary size and instantiation count for the largest crates, with a budget per release.",
        "Hot generic APIs are audited for instantiation cost; cold ones use dyn where it measurably helps.",
        "Release builds use an explicit codegen-units and LTO setting, recorded next to the benchmark numbers.",
        "Symbol names for generic items are checked to include substitutions, so duplicate-merging works.",
      ],
      crates: ["cargo-llvm-lines", "criterion"],
      github: [
        { name: "cargo-llvm-lines - count LLVM IR lines per generic function", url: "https://github.com/dtolnay/cargo-llvm-lines" },
        { name: "rustc_codegen_cranelift - an alternative backend, debug builds", url: "https://github.com/rust-lang/rustc_codegen_cranelift" },
      ],
      pitfall: "Assuming a generic function compiles once: it compiles once per distinct set of type arguments, so a helper used with eight element types is eight functions in the binary and eight chances for the backend to be slow.",
      resources: [
        { title: "rustc-dev-guide: code generation and mono items", url: "https://rustc-dev-guide.rust-lang.org/backend/codegen.html", kind: "docs" },
        { title: "rustc-dev-guide: optimisations and monomorphisation", url: "https://rustc-dev-guide.rust-lang.org/mir/optimizations.html", kind: "docs" },
        { title: "cargo-llvm-lines - measure generic code bloat", url: "https://github.com/dtolnay/cargo-llvm-lines", kind: "repo" },
        { title: "Rust Reference: type layout", url: "https://doc.rust-lang.org/reference/type-layout.html", kind: "docs" },
      ],
    },

    // ------------------------------------------------------------------ cl12
    {
      id: 'cl12',
      n: 12,
      title: "LLVM and Cranelift: choosing a code generation backend",
      minutes: 90,
      level: 'industry',
      goal: "Build a function through a backend API, explain what each backend optimises for, and justify a backend choice with compile-time and code-quality numbers instead of taste.",
      sections: [
        {
          h: "Two backends with opposite budgets",
          p: [
            "LLVM is a mature optimising backend: a large SSA-based IR, dozens of machine-independent and machine-dependent passes, and decades of tuning on real code. rustc uses it through rustc_codegen_llvm, and that is why Rust's codegen quality is competitive with C compilers. The price is compile time, because the pass pipeline is the expensive part, and memory, because LLVM IR and its analyses are large.",
            "Cranelift is built for fast compilation. It has a smaller IR, fewer optimisation passes, and its own register allocator, so it produces adequate code in a fraction of the time. Wasmtime uses it because JIT latency is part of the user-visible experience. rustc also has a Cranelift backend, useful for debug builds where compile speed matters more than the last twenty percent of runtime performance.",
          ],
          list: [
            "LLVM: best code quality, slowest compile, largest memory footprint",
            "Cranelift: fast compile, good enough code, much smaller dependency",
            "Same front end, different IR: the MIR-to-backend lowering is the boundary",
            "Backend choice is per profile, not per language feature",
          ],
          tip: "Benchmark the backend on your own code with both compile time and runtime. Published ratios rarely survive contact with a different workload.",
        },
        {
          h: "Building instructions through an API",
          p: [
            "A backend API is a builder that enforces its own invariants. In Cranelift you create a Function with a signature, create blocks, append block parameters for function arguments, and emit instructions into the current block. Every value is typed; the builder rejects an iadd on a float. Signatures use AbiParam, which encodes a machine type and a purpose, and the calling convention is part of the function's identity, not an afterthought.",
            "The discipline this forces is useful. You cannot emit a use before its definition, you cannot return without a terminator, and you must call finalize so that the builder can verify the block graph and fill in the entry block. Compare that with emitting textual LLVM IR, where a typo produces a parse error from another process and the error message points at a line you generated rather than a line you wrote.",
          ],
          code: src`
            use cranelift::prelude::*;
            use cranelift_codegen::ir::{types, Function};
            use cranelift_codegen::settings::{self, Configurable};

            /// Build IR for fn add(a: i64, b: i64) -> i64 and print it.
            pub fn build_add_ir() -> Result<String, String> {
                let mut flags = settings::builder();
                flags.set("opt_level", "speed").map_err(|e| e.to_string())?;
                let isa = cranelift_native::builder()
                    .map_err(|e| e.to_string())?
                    .finish(settings::Flags::new(flags))
                    .map_err(|e| e.to_string())?;
                let frontend_config = isa.frontend_config();

                let mut func = Function::new();
                func.signature.params.push(AbiParam::new(types::I64));
                func.signature.params.push(AbiParam::new(types::I64));
                func.signature.returns.push(AbiParam::new(types::I64));

                let mut builder_ctx = FunctionBuilderContext::new();
                let mut builder = FunctionBuilder::new(&mut func, &mut builder_ctx);

                let block = builder.create_block();
                builder.append_block_params_for_function_params(block);
                builder.switch_to_block(block);
                builder.seal_block(block);

                let a = builder.block_params(block)[0];
                let b = builder.block_params(block)[1];
                let sum = builder.ins().iadd(a, b);
                builder.ins().return_(&[sum]);
                builder.finalize(frontend_config);

                Ok(func.display().to_string())
            }
          `,
          tip: "Print the IR your front end produces before you debug the machine code. Almost every wrong result traces back to an instruction with the wrong operand, not to the backend.",
        },
        {
          h: "What fast-compile backends cost you in the field",
          p: [
            "The performance gap between a mature optimising backend and a fast one is not a constant, it depends on the program. Tight numeric loops with vectorisable bodies lose the most, because that is where the optimising pipeline spends its effort. Branchy, allocation-heavy application code loses much less. The published WebAssembly-versus-native study found SPEC benchmarks running 45 to 55 percent slower than native, with peak slowdowns above 2x, and it attributes the gap to missing optimisations, codegen issues, and properties inherent to the target.",
            "The engineering conclusion is not that one backend is better. It is that the backend is a knob with a measurable cost curve, and the honest way to set it is to measure the two things users feel: time to first result and steady-state throughput. For a JIT, that means a baseline tier for cold code and an optimising tier for hot code, with a promotion policy you can explain and test.",
          ],
          tip: "Keep the backend behind your own IR so swapping it is a dependency change. A compiler whose passes call backend types directly can never change its mind.",
        },
      ],
      exercise: {
        prompt: "Build a Cranelift function that computes a * x + b for two i64 parameters, then print the IR and verify the signature has two parameters and one return.",
        starter: src`
          use cranelift::prelude::*;
          use cranelift_codegen::ir::{types, Function};

          pub fn build_affine() -> Result<Function, String> {
              // 1. create the Function and push AbiParams for a, x, b
              // 2. create a block, append params, switch, seal
              // 3. compute a*x with imul, then + b with iadd
              // 4. return and finalize with the ISA frontend config
              todo!()
          }
        `,
        hint: "AbiParam::new(types::I64) for each of the three parameters. Order matters: block_params gives you the arguments in signature order.",
        solution: src`
          use cranelift::prelude::*;
          use cranelift_codegen::ir::{types, Function};
          use cranelift_codegen::settings::{self, Configurable};

          pub fn build_affine() -> Result<Function, String> {
              let mut flags = settings::builder();
              flags.set("opt_level", "speed").map_err(|e| e.to_string())?;
              let isa = cranelift_native::builder()
                  .map_err(|e| e.to_string())?
                  .finish(settings::Flags::new(flags))
                  .map_err(|e| e.to_string())?;
              let frontend_config = isa.frontend_config();

              let mut func = Function::new();
              for _ in 0..3 {
                  func.signature.params.push(AbiParam::new(types::I64));
              }
              func.signature.returns.push(AbiParam::new(types::I64));

              let mut builder_ctx = FunctionBuilderContext::new();
              let mut builder = FunctionBuilder::new(&mut func, &mut builder_ctx);

              let block = builder.create_block();
              builder.append_block_params_for_function_params(block);
              builder.switch_to_block(block);
              builder.seal_block(block);

              let params = builder.block_params(block).to_vec();
              let (a, x, b) = (params[0], params[1], params[2]);
              let product = builder.ins().imul(a, x);
              let result = builder.ins().iadd(product, b);
              builder.ins().return_(&[result]);
              builder.finalize(frontend_config);

              Ok(func)
          }

          fn main() {
              let func = build_affine().unwrap();
              assert_eq!(func.signature.params.len(), 3);
              assert_eq!(func.signature.returns.len(), 1);
              let ir = func.display().to_string();
              assert!(ir.contains("imul"), "expected a multiply in: {ir}");
              println!("{ir}");
          }
        `,
      },
      questions: [
        {
          q: "Why does Cranelift compile so much faster than LLVM?",
          options: [
            "Because it skips register allocation",
            "Because it runs a much smaller set of optimisation passes over a simpler IR",
            "Because it only supports x86-64",
            "Because it emits assembly text instead of object code",
          ],
          answer: 1,
          explain: "It still allocates registers and emits real machine code. The saving is the size of the IR and the number of passes, which is exactly the part of an optimising backend that dominates compile time.",
        },
        {
          q: "What does AbiParam encode that a plain type does not?",
          options: [
            "The value's debug name",
            "The machine type plus its role in the calling convention",
            "The optimisation level",
            "Whether the value is constant",
          ],
          answer: 1,
          explain: "AbiParam pairs a machine type with an ABI purpose such as a normal parameter or a return value. Mixing them up produces code that runs and returns garbage.",
        },
        {
          q: "What does the WebAssembly-versus-native comparison show about backends?",
          options: [
            "That WebAssembly is always slower by a fixed 10 percent",
            "That the gap varies by workload, with reported averages of 45 to 55 percent on SPEC and peaks above 2x",
            "That native code is never optimised",
            "That JIT compilation removes the gap entirely",
          ],
          answer: 1,
          explain: "The measured gap is workload dependent and larger than the often-quoted 10 percent from small kernels. It is a codegen-quality and target-constraint story, not a fixed constant.",
        },
      ],
      quickbytes: [
        "Choose a backend per build profile and measure both compile time and runtime.",
        "Print backend IR before debugging machine code; operand mistakes look like backend bugs.",
        "Keep backend types out of your IR and passes so the choice stays reversible.",
      ],
      production: [
        "Backend selection is a configuration flag with a documented default and a benchmark attached.",
        "Signatures are declared once and shared between the declaration and the definition.",
        "IR dumps from the backend are captured in CI for a handful of representative functions.",
        "Compile-time budget per crate is tracked; a backend change that doubles it needs a justification.",
      ],
      crates: ["cranelift", "cranelift-module", "wasm-encoder", "inkwell"],
      github: [
        { name: "wasmtime - cranelift lives in this tree", url: "https://github.com/bytecodealliance/wasmtime/tree/main/cranelift" },
        { name: "llvm-project - the compiler rustc uses by default", url: "https://github.com/llvm/llvm-project" },
      ],
      pitfall: "Building IR with a signature that disagrees with the code that will call it: the function compiles, the call happens, and arguments arrive in the wrong registers with no error at all.",
      resources: [
        { title: "cranelift - umbrella crate and prelude", url: "https://docs.rs/cranelift/latest/cranelift/", kind: "docs" },
        { title: "cranelift-codegen - IR, settings and code emission", url: "https://docs.rs/cranelift-codegen/latest/cranelift_codegen/", kind: "docs" },
        { title: "Not So Fast: WebAssembly vs. native code performance", url: "https://www.usenix.org/conference/atc19/presentation/jangda", kind: "paper" },
        { title: "LLVM Project channel: backend and codegen talks", url: "https://www.youtube.com/@llvmproject", kind: "video" },
        { title: "cranelift source tree inside wasmtime", url: "https://github.com/bytecodealliance/wasmtime/tree/main/cranelift", kind: "repo" },
      ],
    },

    // ------------------------------------------------------------------ cl13
    {
      id: 'cl13',
      n: 13,
      title: "Interpreters: tree-walking, bytecode, and MIR evaluation",
      minutes: 75,
      level: 'advanced',
      goal: "Implement a bytecode interpreter with explicit error handling, and explain when tree-walking, bytecode dispatch, or interpreting a compiler IR is the right execution strategy.",
      sections: [
        {
          h: "Three ways to execute a tree",
          p: [
            "A tree-walking interpreter evaluates the AST directly, usually with an environment chain for scopes. It is the fastest thing to build and the easiest to debug, because the call stack of the interpreter mirrors the structure of the program. It is also the slowest at runtime: every node visit costs a virtual dispatch or a match, and scope lookup walks a chain of maps.",
            "A bytecode interpreter compiles the tree into a flat array of instructions and runs a dispatch loop. The compile step is small and one-off, but it buys locality, cheap control flow, and the option to fuse instructions later. The third option is to interpret a compiler IR directly, which is what Miri does with MIR: you inherit the front end's desugaring and type information, so your interpreter answers questions about the same program the optimiser will see.",
          ],
          list: [
            "Tree-walk: fastest to write, easiest to debug, slowest to run",
            "Closure compilation: compile each node to a closure; fast to write, allocation heavy",
            "Bytecode: flat instruction array, explicit control flow, easy to profile",
            "IR interpretation: reuse the front end, gain typed operands and desugaring",
          ],
          tip: "Write the tree-walk interpreter first even if you plan bytecode. It becomes the reference implementation your differential tests compare against.",
        },
        {
          h: "The dispatch loop is where the performance lives",
          p: [
            "A stack machine keeps operands on an explicit Vec and each instruction pops and pushes. Its advantage is simplicity: instruction encoding is small and the compiler for it is trivial. A register machine keeps operands in numbered slots and needs fewer instructions per expression, at the cost of a more complex encoder. Real implementations often start stacked and add superinstructions, where common pairs like load-plus-add become one opcode, once measurement shows dispatch overhead dominates.",
            "Every interpreter needs an honest failure model. Stack underflow, jumping past the end of the program, and division by zero are all reachable from a malformed input, so they must return errors with the instruction pointer, not panic. A panic is acceptable only when the bytecode is produced by your own verified compiler and cannot be malformed, and even then a debug assertion is cheaper than a production abort.",
          ],
          code: src`
            #[derive(Clone, Copy, Debug, PartialEq, Eq)]
            pub enum Op {
                Push(i64),
                Add,
                Mul,
                Dup,
                Jmp(usize),
                Jz(usize),   // pop; jump when zero
                Print,
                Halt,
            }

            /// A stack machine: no AST walk, one dispatch per instruction.
            pub fn run(program: &[Op]) -> Result<Vec<i64>, String> {
                let mut stack: Vec<i64> = Vec::new();
                let mut printed = Vec::new();
                let mut ip = 0usize;

                while let Some(op) = program.get(ip) {
                    ip += 1;
                    match *op {
                        Op::Push(value) => stack.push(value),
                        Op::Add => {
                            let (a, b) = (pop(&mut stack)?, pop(&mut stack)?);
                            stack.push(a + b);
                        }
                        Op::Mul => {
                            let (a, b) = (pop(&mut stack)?, pop(&mut stack)?);
                            stack.push(a * b);
                        }
                        Op::Dup => {
                            let top = *stack.last().ok_or("dup on an empty stack")?;
                            stack.push(top);
                        }
                        Op::Jmp(target) => ip = target,
                        Op::Jz(target) => {
                            let value = pop(&mut stack)?;
                            if value == 0 { ip = target; }
                        }
                        Op::Print => {
                            let value = pop(&mut stack)?;
                            printed.push(value);
                        }
                        Op::Halt => return Ok(printed),
                    }
                    if ip > program.len() {
                        return Err(format!("instruction pointer {ip} left the program"));
                    }
                }
                Ok(printed)
            }

            fn pop(stack: &mut Vec<i64>) -> Result<i64, String> {
                stack.pop().ok_or_else(|| "stack underflow".to_string())
            }
          `,
          tip: "Return the instruction pointer in every runtime error. An interpreter error without a location is a bug report you cannot act on.",
        },
        {
          h: "Interpreting MIR: Miri and constant evaluation",
          p: [
            "Miri is an interpreter for MIR, not for Rust source. That choice gives it the compiler's desugaring for free, so one implementation handles loops, pattern matches, and temporaries exactly as the compiler sees them. It also means Miri can attach a machine model: allocations with ids, pointer provenance, and the aliasing rules under Stacked Borrows or Tree Borrows. That is how it detects undefined behaviour that produces no crash on real hardware.",
            "The same technique powers const evaluation inside rustc: a MIR interpreter with a step limit, so a const fn that does not terminate becomes a compile error instead of a hung compiler. If you build an interpreter over your own IR, borrow these two ideas: a step budget as a safety valve, and an explicit model of memory rather than raw pointers, so that invalid programs are diagnosed rather than executed.",
          ],
          tip: "Give your interpreter a step budget even in non-const code. It turns an infinite loop in generated IR into a test failure with a location.",
        },
      ],
      exercise: {
        prompt: "Extend the stack machine with Sub, Dup and Jmp, then write a real loop that counts down from 5 and prints each value. Every malformed program must return an error, never panic.",
        starter: src`
          #[derive(Clone, Copy, Debug, PartialEq, Eq)]
          pub enum Op { Push(i64), Sub, Dup, Jz(usize), Jmp(usize), Print, Halt }

          fn pop(stack: &mut Vec<i64>) -> Result<i64, String> {
              stack.pop().ok_or_else(|| "stack underflow".to_string())
          }

          // loop { if i == 0 break; print i; i -= 1 }
          // 1. Dup, Jz(exit) to test the counter without consuming it
          // 2. Dup, Print to print the current value
          // 3. Push(1), Sub computes b - a, so the older value must be on top
          pub fn run(_program: &[Op]) -> Result<Vec<i64>, String> {
              todo!()
          }
        `,
        hint: "Jz pops the condition and jumps when it is zero. Compile the loop as: push n; push acc; swap-free accumulation is easier if you keep the counter on the stack and test it before the body.",
        solution: src`
          #[derive(Clone, Copy, Debug, PartialEq, Eq)]
          pub enum Op { Push(i64), Sub, Dup, Jz(usize), Jmp(usize), Print, Halt }

          fn pop(stack: &mut Vec<i64>) -> Result<i64, String> {
              stack.pop().ok_or_else(|| "stack underflow".to_string())
          }

          pub fn run(program: &[Op]) -> Result<Vec<i64>, String> {
              let mut stack: Vec<i64> = Vec::new();
              let mut printed = Vec::new();
              let mut ip = 0usize;

              while let Some(op) = program.get(ip) {
                  ip += 1;
                  match *op {
                      Op::Push(value) => stack.push(value),
                      Op::Sub => {
                          // The top of the stack is the right operand.
                          let (a, b) = (pop(&mut stack)?, pop(&mut stack)?);
                          stack.push(b - a);
                      }
                      Op::Dup => {
                          let top = *stack.last().ok_or("dup on an empty stack")?;
                          stack.push(top);
                      }
                      Op::Jz(target) => {
                          let value = pop(&mut stack)?;
                          if value == 0 { ip = target; }
                      }
                      Op::Jmp(target) => ip = target,
                      Op::Print => {
                          let value = pop(&mut stack)?;
                          printed.push(value);
                      }
                      Op::Halt => return Ok(printed),
                  }
                  if ip > program.len() {
                      return Err(format!("instruction pointer {ip} left the program"));
                  }
              }
              Ok(printed)
          }

          fn main() {
              // i = 5; loop { if i == 0 { break } print i; i -= 1 }
              let program = [
                  Op::Push(5),   // 0: i
                  Op::Dup,       // 1
                  Op::Jz(8),     // 2: exit when the counter reaches zero
                  Op::Dup,       // 3
                  Op::Print,     // 4: prints 5, 4, 3, 2, 1
                  Op::Push(1),   // 5
                  Op::Sub,       // 6: i = i - 1
                  Op::Jmp(1),    // 7
                  Op::Halt,      // 8
              ];
              assert_eq!(run(&program).unwrap(), vec![5, 4, 3, 2, 1]);
              assert!(run(&[Op::Sub]).unwrap_err().contains("underflow"));
              println!("ok");
          }
        `
      },
      questions: [
        {
          q: "Why does Miri interpret MIR instead of Rust source?",
          options: [
            "Because MIR is easier to parse",
            "Because it inherits desugaring and types from the front end, so one implementation covers all syntax",
            "Because source text is not available in tests",
            "Because MIR contains the borrow checker's results",
          ],
          answer: 1,
          explain: "MIR has already removed syntactic sugar and made operands typed. Miri then adds a memory model with allocation ids and provenance, which is where its undefined-behaviour detection comes from.",
        },
        {
          q: "What is the main runtime cost of a bytecode dispatch loop?",
          options: [
            "Memory allocation for the instruction array",
            "An unpredictable indirect branch per instruction, which stalls the pipeline",
            "The cost of parsing the bytecode",
            "Garbage collection of the stack",
          ],
          answer: 1,
          explain: "Each instruction is a branch the CPU cannot predict. Superinstructions and threading reduce the number of dispatches; that is why mature interpreters fuse common sequences.",
        },
        {
          q: "Why must a const evaluator have a step limit?",
          options: [
            "To keep the produced binary small",
            "Because a const fn can loop forever, and the compiler must not hang",
            "Because the interpreter stack is fixed size",
            "To prevent the optimiser from unrolling loops",
          ],
          answer: 1,
          explain: "Const evaluation happens at compile time. Without a budget, a non-terminating const fn turns into a hung rustc, which is why exceeding the limit is a normal compile error.",
        },
      ],
      quickbytes: [
        "Build the tree-walk interpreter first; it becomes the oracle for differential tests.",
        "Return the instruction pointer with every runtime error.",
        "Fuse hot instruction pairs only after profiling shows dispatch dominates.",
      ],
      production: [
        "Interpreters return errors with a location and never panic on malformed input.",
        "A step budget turns runaway execution into a diagnosable failure.",
        "Every opcode has a unit test for its normal and error path.",
        "The tree-walk and bytecode backends are compared on the same corpus, so semantics cannot drift.",
      ],
      crates: ["slotmap", "rustc-hash", "ariadne"],
      github: [
        { name: "miri - an interpreter for Rust's MIR", url: "https://github.com/rust-lang/miri" },
        { name: "wasmtime - a production interpreter and JIT for Wasm", url: "https://github.com/bytecodealliance/wasmtime" },
      ],
      pitfall: "Panicking on stack underflow in a bytecode interpreter: the malformed program arrives from a fuzzer or a corrupted cache, and a panic in a library turns a diagnosable input into a process abort.",
      resources: [
        { title: "miri - MIR interpretation and undefined behaviour detection", url: "https://github.com/rust-lang/miri", kind: "repo" },
        { title: "rustc-dev-guide: constant evaluation", url: "https://rustc-dev-guide.rust-lang.org/const-eval.html", kind: "docs" },
        { title: "wasmparser - a real bytecode decoder to read", url: "https://docs.rs/wasmparser/latest/wasmparser/", kind: "docs" },
        { title: "rustc-dev-guide: MIR, the IR Miri interprets", url: "https://rustc-dev-guide.rust-lang.org/mir/index.html", kind: "docs" },
      ],
    },

    // ------------------------------------------------------------------ cl14
    {
      id: 'cl14',
      n: 14,
      title: "JIT compilation: executable memory, symbols, and ABIs",
      minutes: 90,
      level: 'industry',
      goal: "Compile and call a function at runtime with Cranelift's JIT, and explain the memory-protection, symbol-resolution and ABI obligations that make JIT code safe to invoke.",
      sections: [
        {
          h: "Code is data until you flip a permission bit",
          p: [
            "A JIT writes machine code into memory and then executes it, which means it must satisfy the platform's write-xor-execute policy. The common pattern is to map pages writable, emit the code, then change them to executable and never writable again. On AArch64 you must also flush the instruction cache, because the core may still hold stale instructions for those addresses. On Apple silicon, JIT requires MAP_JIT and toggling write protection per thread, which is why portable JIT libraries hide the platform details behind a memory provider.",
            "The lifetime problem is just as sharp. Once the function pointer escapes, the code must outlive every call to it; freeing the mapping while a reference is live is a use-after-free that no borrow checker will catch, because the pointer came from an integer. In Rust the safe pattern is to own the module that produced the code and hand out calls through a wrapper that borrows it, never a bare transmuted fn pointer that can outlive its module.",
          ],
          list: [
            "Allocate writable, emit, then mark executable; never leave a page both",
            "Flush the instruction cache on architectures that need it",
            "Keep the owning module alive for as long as any compiled function can be called",
            "Resolve external symbols explicitly; the JIT does not know your process layout",
          ],
          tip: "Never let a raw code pointer escape its module. Wrap it in a struct that borrows the module, so the borrow checker enforces what the mmap does not.",
        },
        {
          h: "The ABI is a contract you write by hand",
          p: [
            "When you transmute a code pointer to fn(i64) -> i64, you are asserting that the generated function obeys the platform's calling convention for those types. The backend will obey the signature you gave it, so the bug is always a mismatch between the two declarations. Pass two i64s where the callee reads three and the third argument is whatever happened to be in a register; the program runs and returns nonsense, with no diagnostic anywhere.",
            "Cranelift makes the contract explicit: the signature lives on the Function, parameters and returns are AbiParams, and declare_function records it in the module so callers and the definition agree. Keep one source of truth for the signature, assert the arity in a test that actually calls the function, and prefer a typed wrapper per compiled function over a single generic transmute helper.",
          ],
          code: src`
            use cranelift::prelude::*;
            use cranelift_codegen::ir::types;
            use cranelift_codegen::settings::{self, Configurable};
            use cranelift_jit::{JITBuilder, JITModule};
            use cranelift_module::{Linkage, Module};

            /// JIT-compile fn double(x: i64) -> i64 and call it.
            pub fn compile_and_call(argument: i64) -> Result<i64, String> {
                let mut flags = settings::builder();
                flags.set("is_pic", "false").map_err(|e| e.to_string())?;
                let isa = cranelift_native::builder()
                    .map_err(|e| e.to_string())?
                    .finish(settings::Flags::new(flags))
                    .map_err(|e| e.to_string())?;

                let builder = JITBuilder::with_isa(isa, cranelift_module::default_libcall_names());
                let mut module = JITModule::new(builder);

                let frontend_config = module.isa().frontend_config();
                let mut ctx = module.make_context();
                let mut signature = module.make_signature();
                signature.params.push(AbiParam::new(types::I64));
                signature.returns.push(AbiParam::new(types::I64));
                ctx.func.signature = signature;

                let id = module
                    .declare_function("double", Linkage::Export, &ctx.func.signature)
                    .map_err(|e| e.to_string())?;

                let mut builder_ctx = FunctionBuilderContext::new();
                {
                    let mut builder = FunctionBuilder::new(&mut ctx.func, &mut builder_ctx);
                    let block = builder.create_block();
                    builder.append_block_params_for_function_params(block);
                    builder.switch_to_block(block);
                    builder.seal_block(block);

                    let x = builder.block_params(block)[0];
                    let two = builder.ins().iconst(types::I64, 2);
                    let doubled = builder.ins().imul(x, two);
                    builder.ins().return_(&[doubled]);
                    builder.finalize(frontend_config);
                }

                module.define_function(id, &mut ctx).map_err(|e| e.to_string())?;
                module.clear_context(&mut ctx);
                module.finalize_definitions().map_err(|e| e.to_string())?;

                let code = module.get_finalized_function(id);
                // Safety: the generated signature is (i64) -> i64, which is what
                // this function pointer type asserts.
                let double: fn(i64) -> i64 = unsafe { std::mem::transmute(code) };
                Ok(double(argument))
            }
          `,
          tip: "Call every JIT-compiled function once from a test with known inputs. A signature mismatch is invisible until the first call and obvious immediately after.",
        },
        {
          h: "Tiering, deoptimisation, and when not to JIT",
          p: [
            "Production JITs rarely compile once. A tiered design compiles fast and unoptimised at first use, counts how often a function runs, and recompiles hot functions with more optimisation. Promotion needs a threshold, a way to redirect future calls, and a rule for what happens to frames already running the old code. Languages with garbage collection add stack maps at safepoints, because the collector must find every live reference in a compiled frame.",
            "Rust is a good host for a JIT precisely because it has no GC and no hidden allocation, so a compiled function's frame contains only what you put there. That does not remove the obligations, it just makes them tractable. JIT pays for workloads where the code depends on data you only see at runtime: query engines specialising a plan, regex engines specialising a pattern, serialisation frameworks specialising a schema. For a CLI tool with fixed input shapes, ahead-of-time compilation wins on every axis.",
          ],
          tip: "Write down the promotion policy before writing the tier-up path. A JIT with an ad-hoc threshold is a JIT nobody can tune.",
        },
      ],
      exercise: {
        prompt: "JIT-compile a function that returns the larger of two i64 arguments, call it through a typed wrapper, and add a test that fails loudly if the signature and the call disagree in arity.",
        starter: src`
          use cranelift::prelude::*;
          use cranelift_codegen::ir::types;

          pub struct JitMax { /* module, func id, signature */ }

          impl JitMax {
              // 1. build the module from the host ISA
              // 2. declare fn max(a: i64, b: i64) -> i64
              // 3. emit: cmp a, b; select -> a when a > b; return
              // 4. wrap the code pointer in a method that takes two i64s
              pub fn call(&self, _a: i64, _b: i64) -> i64 { todo!() }
          }
        `,
        hint: "Cranelift has icmp and select in the instruction builder: builder.ins().icmp(IntCC::SignedGreaterThan, a, b) gives an i8 flag, and select takes that flag plus the two candidate values.",
        solution: src`
          use cranelift::prelude::*;
          use cranelift_codegen::ir::types;
          use cranelift_codegen::settings::{self, Configurable};
          use cranelift_jit::{JITBuilder, JITModule};
          use cranelift_module::{Linkage, Module};

          pub struct JitMax {
              module: JITModule,
              id: cranelift_module::FuncId,
          }

          impl JitMax {
              pub fn new() -> Result<Self, String> {
                  let mut flags = settings::builder();
                  flags.set("is_pic", "false").map_err(|e| e.to_string())?;
                  let isa = cranelift_native::builder()
                      .map_err(|e| e.to_string())?
                      .finish(settings::Flags::new(flags))
                      .map_err(|e| e.to_string())?;
                  let mut module =
                      JITModule::new(JITBuilder::with_isa(isa, cranelift_module::default_libcall_names()));

                  let mut ctx = module.make_context();
                  let mut signature = module.make_signature();
                  signature.params.push(AbiParam::new(types::I64));
                  signature.params.push(AbiParam::new(types::I64));
                  signature.returns.push(AbiParam::new(types::I64));
                  ctx.func.signature = signature;

                  let id = module
                      .declare_function("max", Linkage::Export, &ctx.func.signature)
                      .map_err(|e| e.to_string())?;

                  let frontend_config = module.isa().frontend_config();
                  let mut builder_ctx = FunctionBuilderContext::new();
                  {
                      let mut builder = FunctionBuilder::new(&mut ctx.func, &mut builder_ctx);
                      let block = builder.create_block();
                      builder.append_block_params_for_function_params(block);
                      builder.switch_to_block(block);
                      builder.seal_block(block);

                      let params = builder.block_params(block).to_vec();
                      let (a, b) = (params[0], params[1]);
                      let gt = builder.ins().icmp(IntCC::SignedGreaterThan, a, b);
                      let chosen = builder.ins().select(gt, a, b);
                      builder.ins().return_(&[chosen]);
                      builder.finalize(frontend_config);
                  }

                  module.define_function(id, &mut ctx).map_err(|e| e.to_string())?;
                  module.clear_context(&mut ctx);
                  module.finalize_definitions().map_err(|e| e.to_string())?;
                  Ok(JitMax { module, id })
              }

              pub fn call(&self, a: i64, b: i64) -> i64 {
                  let code = self.module.get_finalized_function(self.id);
                  // Safety: the signature declared above is exactly (i64, i64) -> i64.
                  let max: fn(i64, i64) -> i64 = unsafe { std::mem::transmute(code) };
                  max(a, b)
              }
          }

          fn main() {
              let jit = JitMax::new().unwrap();
              assert_eq!(jit.call(3, 9), 9);
              assert_eq!(jit.call(-4, -7), -4);
              println!("ok");
          }
        `,
      },
      questions: [
        {
          q: "Why must a JIT page not stay writable after code is emitted?",
          options: [
            "Because writable pages are slower to read",
            "Because write-xor-execute prevents a memory-safety bug from turning into arbitrary code execution",
            "Because the kernel refuses to execute writable pages on all platforms",
            "Because the instruction cache is invalidated on every write",
          ],
          answer: 1,
          explain: "W^X is a hardening property. If a page is both writable and executable, a single out-of-bounds write becomes control-flow hijack; making the permissions alternate removes that path.",
        },
        {
          q: "What goes wrong when the declared signature does not match the call?",
          options: [
            "The JIT verifier reports an error",
            "The call runs and returns garbage, because nothing checks arguments at the boundary",
            "The linker rejects the symbol",
            "The function traps on entry",
          ],
          answer: 1,
          explain: "The backend emits code for the signature you declared. A mismatch means registers are read differently on each side, and the result is silently wrong rather than diagnosed.",
        },
        {
          q: "When is a JIT a worse choice than ahead-of-time compilation?",
          options: [
            "When the code depends on a runtime schema or pattern",
            "When the program is a batch tool with fixed input shapes and a long-lived binary",
            "When the host has multiple cores",
            "When the generated code must be sandboxed",
          ],
          answer: 1,
          explain: "A JIT pays compilation cost at runtime and adds executable-memory complexity. If the code never varies, AOT gets the same result with no runtime dependency.",
        },
      ],
      quickbytes: [
        "Alternate write and execute permissions; never leave both on the same page.",
        "Keep one signature per compiled function and reuse it for declare and define.",
        "Own the module for as long as any compiled pointer can be called.",
      ],
      production: [
        "JIT memory is allocated through a provider that enforces W^X and flushes the icache.",
        "Every compiled function is exercised by a test that calls it, so signature errors fail fast.",
        "Code pointers never escape the module's lifetime; wrappers borrow instead of transmuting freely.",
        "Promotion thresholds and tier selection are configuration with recorded benchmark results.",
      ],
      crates: ["cranelift-jit", "cranelift-module", "dynasm"],
      github: [
        { name: "cranelift-jit-demo - a worked example of the JIT API", url: "https://github.com/bytecodealliance/cranelift-jit-demo" },
        { name: "wasmtime - tiered compilation in production", url: "https://github.com/bytecodealliance/wasmtime" },
      ],
      pitfall: "Transmuting a code pointer to the wrong fn type: the call succeeds, the arguments land in the wrong registers, and the wrong return value is attributed to a logic bug for days.",
      resources: [
        { title: "cranelift-jit - JITBuilder, JITModule and memory providers", url: "https://docs.rs/cranelift-jit/latest/cranelift_jit/", kind: "docs" },
        { title: "cranelift-module - declare, define and finalise functions", url: "https://docs.rs/cranelift-module/latest/cranelift_module/", kind: "docs" },
        { title: "std::primitive::fn - the type a transmuted pointer must match", url: "https://doc.rust-lang.org/std/primitive.fn.html", kind: "docs" },
        { title: "cranelift-jit-demo repository", url: "https://github.com/bytecodealliance/cranelift-jit-demo", kind: "repo" },
      ],
    },

    // ------------------------------------------------------------------ cl15
    {
      id: 'cl15',
      n: 15,
      title: "Macros as metaprogramming: expansion, hygiene, proc macros",
      minutes: 75,
      level: 'advanced',
      goal: "Write a declarative macro that generates several impls, explain what hygiene does and does not protect, and build a derive macro that reports errors as compiler diagnostics.",
      sections: [
        {
          h: "Expansion is a fixed point over token trees",
          p: [
            "A declarative macro matches token trees, not syntax. macro_rules! patterns are sequences of literals and fragment specifiers such as expr, ty, ident, pat and tt, and the fragment specifier decides what the parser will accept at that position. Because the matcher sees tokens, a macro can build syntax the parser would reject as input, which is the whole point: impl blocks, match arms, and struct definitions generated from a short invocation.",
            "Expansion runs before name resolution and repeats until no macro invocation remains, because a macro can produce another macro invocation. That fixed-point loop is why recursive macros work: a TT muncher consumes one token group per call and recurses on the rest until the token stream is empty. It is also why a macro that expands to itself by accident produces the recursion limit error rather than a stack overflow in your code.",
          ],
          list: [
            "Fragment specifiers: expr, ty, ident, pat, path, tt, literal, lifetime",
            "Repetition: $( ... )* and $( ... ),* with an optional trailing separator",
            "$crate:: paths so an exported macro resolves items in your crate, not the caller's",
            "Expansion happens before resolution, so macros cannot see types or trait impls",
          ],
          tip: "Prefer tt when a fragment specifier refuses valid input. The error message names the fragment, and switching to tt plus an explicit parse is the usual fix.",
        },
        {
          h: "Hygiene protects locals, not items",
          p: [
            "Every token carries a syntax context, so a binding introduced by a macro is a different name from an identically spelled binding at the call site. Rust uses mixed-site hygiene: local variables and labels get the macro's context, while items and types resolve at the call site. That is why a macro can safely introduce a temporary named tmp, and why a macro that defines a function should define it where the user invoked it.",
            "Hygiene does not solve paths. A macro that writes Vec::new() in its expansion resolves Vec in the caller's scope, which may have imported a different Vec or shadowed it. The fix is a fully qualified path, and for your own items, $crate. When a user reports that your macro breaks under a glob import, the cause is almost always an unqualified name in the expansion.",
          ],
          code: src`
            struct Celsius(f64);
            struct Fahrenheit(f64);

            /// One rule, N impls: the fragment specifier decides what may appear.
            macro_rules! impl_from {
                ($($source:ty => $target:ident),* $(,)?) => {
                    $(
                        impl From<$source> for $target {
                            fn from(value: $source) -> Self {
                                $target(value.0)
                            }
                        }
                    )*
                };
            }

            impl_from! {
                Celsius => Fahrenheit,
                Fahrenheit => Celsius,
            }

            fn main() {
                let boiling = Fahrenheit::from(Celsius(100.0));
                assert_eq!(boiling.0, 100.0); // identity in this toy
                let back = Celsius::from(boiling);
                assert_eq!(back.0, 100.0);
                println!("two impls from one rule");
            }
          `,
          tip: "Put the expansion's temporary variables in a block. Even with hygiene, a macro that expands to statements can break a match arm or an if-else chain that expected one expression.",
        },
        {
          h: "Procedural macros are functions over tokens",
          p: [
            "A procedural macro is a function from TokenStream to TokenStream, compiled as its own proc-macro crate. syn parses the input into syntax trees, quote turns trees back into tokens, and the spans on those tokens decide where errors point. Derive macros receive the item they annotate, attribute macros receive the item plus the attribute arguments, and function-like macros receive whatever is inside the parentheses.",
            "The obligation that separates a good proc macro from a bad one is error reporting. A panic in the macro surfaces as a compiler crash with an unhelpful message; returning syn::Error::new_spanned(...).to_compile_error() produces a normal diagnostic on the exact token. The cost of the crate type is real: proc-macro crates cannot export anything else, they slow down incremental rebuilds, and they run before type checking, so no macro can look at a type.",
          ],
          code: src`
            use proc_macro::TokenStream;
            use quote::quote;
            use syn::{parse_macro_input, Data, DeriveInput, Fields};

            /// Generates fn describe(&self) -> String listing the field names.
            #[proc_macro_derive(Describe)]
            pub fn derive_describe(input: TokenStream) -> TokenStream {
                let input = parse_macro_input!(input as DeriveInput);
                let name = input.ident;

                let field_names: Vec<String> = match &input.data {
                    Data::Struct(data) => match &data.fields {
                        Fields::Named(named) => named
                            .named
                            .iter()
                            .filter_map(|field| field.ident.as_ref().map(|ident| ident.to_string()))
                            .collect(),
                        _ => Vec::new(),
                    },
                    _ => Vec::new(),
                };

                // A diagnostic the user can click, instead of a macro panic.
                if field_names.is_empty() {
                    let message = "#[derive(Describe)] needs a struct with named fields";
                    return syn::Error::new_spanned(&name, message)
                        .to_compile_error()
                        .into();
                }

                let pushes = field_names.iter().map(|field| quote! {
                    out.push(' ');
                    out.push_str(#field);
                });

                let expanded = quote! {
                    impl #name {
                        pub fn describe(&self) -> String {
                            let mut out = String::from(stringify!(#name));
                            #(#pushes)*
                            out
                        }
                    }
                };
                expanded.into()
            }
          `,
          tip: "Return compile_error! tokens rather than panicking. A panic inside a proc macro is reported as an internal compiler error and buries the real cause.",
        },
      ],
      exercise: {
        prompt: "Write a macro_rules! macro that defines a newtype with a guarded constructor: it must generate the struct, a private field, and a try_new that returns Err when the value is negative. Expansion errors must name the offending input.",
        starter: src`
          // usage: guarded!(Meters, f64);
          // generates: pub struct Meters(f64); impl Meters { pub fn try_new(v: f64) -> Result<Self, String> }
          macro_rules! guarded {
              ($name:ident, $ty:ty) => {
                  // 1. define the struct with a private field
                  // 2. add an impl with try_new
                  // 3. reject negatives with a message naming the type
                  todo!()
              };
          }

          fn main() {
              // guarded!(Meters, f64);
              // assert!(Meters::try_new(-1.0).is_err());
          }
        `,
        hint: "stringify!($name) inside the expansion gives you the type name as a string literal, which you can push into the error message exactly where the type is known.",
        solution: src`
          macro_rules! guarded {
              ($name:ident, $ty:ty) => {
                  #[derive(Debug, Clone, Copy, PartialEq)]
                  pub struct $name($ty);

                  impl $name {
                      pub fn try_new(value: $ty) -> Result<Self, String> {
                          if value < 0.0 as $ty {
                              return Err(format!(
                                  "{} must not be negative, got {}",
                                  stringify!($name),
                                  value
                              ));
                          }
                          Ok($name(value))
                      }

                      pub fn get(&self) -> $ty {
                          self.0
                      }
                  }
              };
          }

          guarded!(Meters, f64);
          guarded!(Bytes, i64);

          fn main() {
              assert_eq!(Meters::try_new(2.5).unwrap().get(), 2.5);
              let err = Meters::try_new(-1.0).unwrap_err();
              assert!(err.contains("Meters"), "got {err}");
              assert!(err.contains("-1"), "got {err}");

              assert_eq!(Bytes::try_new(7).unwrap().get(), 7);
              assert!(Bytes::try_new(-3).is_err());
              println!("ok");
          }
        `,
      },
      questions: [
        {
          q: "What does mixed-site hygiene mean for a macro that introduces `let tmp`?",
          options: [
            "The binding is visible to the caller because macros expand in place",
            "The binding belongs to the macro's syntax context and cannot collide with the caller's tmp",
            "The binding is renamed to a generated identifier in the expansion",
            "The binding resolves at the definition site of the macro's crate",
          ],
          answer: 1,
          explain: "Locals use the macro's context, so two identically spelled names are different bindings. Items and types are the opposite: they resolve at the call site so a macro can define something the caller can use.",
        },
        {
          q: "Why must a proc-macro crate contain only proc macros?",
          options: [
            "Because proc macros are compiled for the host, not the target",
            "Because the crate type links against the compiler and cannot also be a normal library",
            "Because syn requires it",
            "Because proc macros cannot have dependencies",
          ],
          answer: 1,
          explain: "A proc-macro crate is compiled for the host and loaded by the compiler. That linkage is why it cannot also be a regular library, which is why helper crates exist.",
        },
        {
          q: "A macro expands to Vec::new() and breaks when the caller imports their own Vec. What is the fix?",
          options: [
            "Wrap the expansion in a block",
            "Use a fully qualified path such as ::std::vec::Vec::new()",
            "Add #[macro_export]",
            "Use $crate::Vec",
          ],
          answer: 1,
          explain: "Hygiene covers local variables, not paths. A qualified path removes the caller's imports from the equation; $crate is for your own items, not for std.",
        },
      ],
      quickbytes: [
        "Match token trees, not syntax; when a fragment specifier refuses input, tt plus an explicit parse is the way out.",
        "Return syn::Error::to_compile_error() from proc macros instead of panicking.",
        "Qualify every path in an expansion; the caller's imports are not under your control.",
      ],
      production: [
        "Every exported macro is tested from a downstream crate, including under a glob import.",
        "Proc macros have trybuild tests that pin both the expansion and the compile error text.",
        "Expansions are reviewed for accidental captures: bindings, paths and drop order.",
        "Macro crates are kept small and dependency-light; they are rebuilt more often than anything else.",
      ],
      crates: ["syn", "quote", "proc-macro2", "trybuild"],
      github: [
        { name: "syn - parsing Rust syntax in proc macros", url: "https://github.com/dtolnay/syn" },
        { name: "rust-analyzer - macro expansion inside an IDE", url: "https://github.com/rust-lang/rust-analyzer" },
      ],
      pitfall: "Using expr where a statement is allowed: `if cond { mac!() } else { ... }` stops parsing because the expansion is a statement list, and the error points at the else branch rather than at the macro.",
      resources: [
        { title: "The Rust Reference: macros by example", url: "https://doc.rust-lang.org/reference/macros-by-example.html", kind: "docs" },
        { title: "syn repository - the proc-macro parsing toolkit", url: "https://github.com/dtolnay/syn", kind: "repo" },
        { title: "syn crate documentation", url: "https://docs.rs/syn/latest/syn/", kind: "docs" },
        { title: "quote crate documentation", url: "https://docs.rs/quote/latest/quote/", kind: "docs" },
        { title: "rustc-dev-guide: macro expansion", url: "https://rustc-dev-guide.rust-lang.org/macro-expansion.html", kind: "docs" },
      ],
    },

    // ------------------------------------------------------------------ cl16
    {
      id: 'cl16',
      n: 16,
      title: "Diagnostics: spans, labels, and machine-applicable fixes",
      minutes: 75,
      level: 'industry',
      goal: "Model a diagnostic as structured data with spans and suggestions, render it without breaking on tabs or multi-byte characters, and test the rendered output like any other API.",
      sections: [
        {
          h: "A diagnostic is data, not a string",
          p: [
            "The mistake that makes diagnostics unfixable later is emitting a formatted string at the point of failure. A diagnostic should be a structure: a severity, a message, one or more labeled spans pointing at source, optional notes, an optional help, and a stable error code. Once it is data, a renderer can print it, an IDE can underline it, a linter can suppress it, and a test can assert on it without matching prose.",
            "Suggestions deserve their own field and their own confidence. A machine-applicable suggestion can be applied automatically, which is what makes rustfix and IDE quick-fixes safe. A maybe-incorrect suggestion must never be applied automatically. Encoding that distinction in the type system is the difference between a tool that fixes code and a tool that silently breaks it.",
          ],
          list: [
            "Primary span: where the error is; secondary spans: where the context is",
            "Suggestion with applicability: machine-applicable versus maybe-incorrect",
            "Error code: stable identifier for lookup, suppression and documentation",
            "Severity: error, warning, note, help, or allow-by-default lint",
          ],
          tip: "Give every user-visible diagnostic an error code and a documentation URL. The code is the API; the message is allowed to improve.",
        },
        {
          h: "Rendering is a layout problem with traps",
          p: [
            "Rendering a caret line looks trivial and is not. Spans are byte offsets, so you must convert to line and column, and the column you want for display is a number of terminal cells, not bytes and not chars. A tab advances to the next stop, and a CJK character occupies two cells, so a caret placed by counting chars drifts. If you do not want to solve that, use annotate-snippets or ariadne, which already do.",
            "Multi-line spans need their own layout, because a caret row cannot cover several lines. The usual rendering is a marker at the start and end with a vertical connector, plus elision when the span is far away. Decide what happens with a zero-width span, which is what an insertion suggestion produces, and make sure the renderer never panics when a span lands at the end of the file.",
          ],
          code: src`
            pub struct Diagnostic {
                pub span: (usize, usize),   // byte offsets, half-open
                pub message: String,
                pub label: String,
            }

            /// Render one caret diagnostic for a byte span. Tabs and wide chars are
            /// approximated: the caret column counts chars, not terminal cells.
            pub fn render(source: &str, file: &str, diag: &Diagnostic) -> String {
                let start = diag.span.0.min(source.len());
                let end = diag.span.1.clamp(start, source.len());

                let line_start = source[..start].rfind('\n').map(|index| index + 1).unwrap_or(0);
                let line_number = source[..start].matches('\n').count() + 1;
                let column = source[line_start..start].chars().count();

                let line_end = source[line_start..]
                    .find('\n')
                    .map(|index| line_start + index)
                    .unwrap_or(source.len());
                let line = &source[line_start..line_end];

                let width = source[start..end].chars().count().max(1);
                let gutter = line_number.to_string();

                let mut out = String::new();
                out.push_str(&format!("error: {}\n", diag.message));
                out.push_str(&format!("  --> {}:{}:{}\n", file, line_number, column + 1));
                out.push_str(&format!("{} |\n", " ".repeat(gutter.len())));
                out.push_str(&format!("{} | {}\n", gutter, line));
                out.push_str(&format!(
                    "{} | {}{} {}\n",
                    " ".repeat(gutter.len()),
                    " ".repeat(column),
                    "^".repeat(width),
                    diag.label
                ));
                out
            }
          `,
          tip: "Test the renderer with a tab, a multi-byte character, a zero-width span, and a span at end of file. Those four cases are where caret alignment bugs live.",
        },
        {
          h: "Diagnostics are a published interface",
          p: [
            "Once a compiler ships, its diagnostics are consumed by tools: IDEs parse JSON diagnostics, test suites assert on error codes, and documentation links to them. That makes message text a compatibility surface in practice. Changing a code breaks suppressions; removing a note breaks a tutorial; changing the JSON shape breaks every editor plugin.",
            "The mitigation is the same as any API: version the machine-readable form, keep codes stable, and test the rendered output. A UI test that pins the full rendered diagnostic for a handful of representative errors catches accidental rewording and formatting drift, and a JSON schema test catches the structural breaks that IDEs care about.",
          ],
          tip: "Keep a small corpus of UI tests with blessed output. Reviewing a diagnostic diff is how you notice that a fix started pointing at the wrong token.",
        },
      ],
      exercise: {
        prompt: "Extend the renderer with a secondary label: an error span and a note span, rendered on the same line with distinct markers, plus a help line at the end. It must not panic when either span is empty.",
        starter: src`
          pub struct Label { pub span: (usize, usize), pub text: String, pub primary: bool }

          // 1. sort labels by span start
          // 2. place ^ for the primary and - for secondary markers
          // 3. never index out of bounds: clamp spans to the line length
          pub fn render(source: &str, labels: &[Label]) -> String { todo!() }
        `,
        hint: "Build a marker string the same length as the line, write markers into a Vec<char>, then join. Clamping every span to the line range removes the panic cases in one place.",
        solution: src`
          pub struct Label { pub span: (usize, usize), pub text: String, pub primary: bool }

          pub fn render(source: &str, labels: &[Label]) -> String {
              let line_start = 0usize;
              let line_end = source.find('\n').unwrap_or(source.len());
              let line = &source[line_start..line_end];

              let mut markers: Vec<char> = vec![' '; line.chars().count()];
              let mut notes = Vec::new();

              for label in labels {
                  let start = label.span.0.min(line_end);
                  let end = label.span.1.clamp(start, line_end);
                  let from = source[line_start..start].chars().count();
                  let width = source[start..end].chars().count().max(1);
                  let glyph = if label.primary { '^' } else { '-' };
                  for offset in 0..width {
                      if let Some(slot) = markers.get_mut(from + offset) {
                          *slot = glyph;
                      }
                  }
                  notes.push(format!("{glyph} {}", label.text));
              }

              format!(
                  "{line}\n{}\n{}",
                  markers.into_iter().collect::<String>(),
                  notes.join("\n")
              )
          }

          fn main() {
              let source = "let total = count + 1;";
              let labels = [
                  Label { span: (4, 9), text: "this binding".to_string(), primary: false },
                  Label { span: (12, 17), text: "used before it is assigned".to_string(), primary: true },
                  Label { span: (20, 20), text: "insertion point".to_string(), primary: true },
              ];
              let rendered = render(source, &labels);
              assert!(rendered.contains("-----"), "{rendered}");
              assert!(rendered.contains("^^^^^"), "{rendered}");
              println!("{rendered}");
          }
        `,
      },
      questions: [
        {
          q: "Why should a suggestion record whether it is machine-applicable?",
          options: [
            "To choose the colour of the help text",
            "So automatic fixers apply only edits that are guaranteed to preserve behaviour",
            "Because the compiler cannot otherwise format the suggestion",
            "To decide whether the diagnostic is an error or a warning",
          ],
          answer: 1,
          explain: "rustfix and IDE quick-fixes apply suggestions without a human in the loop. Marking a heuristic edit as machine-applicable is how a fix tool introduces a bug.",
        },
        {
          q: "A caret under a CJK character appears one cell to the left. Why?",
          options: [
            "Byte offsets are wrong",
            "The column was computed in chars, but the character occupies two terminal cells",
            "The source file is not UTF-8",
            "The status line uses a different font",
          ],
          answer: 1,
          explain: "Display width is neither bytes nor chars. Either compute display width per grapheme or hand rendering to a library that does; counting chars will drift on wide characters and tabs.",
        },
        {
          q: "What does a UI test for diagnostics actually protect?",
          options: [
            "The compiler's runtime performance",
            "The exact rendered output, so accidental rewording, wrong spans and layout drift are reviewable",
            "The stability of the AST",
            "The behaviour of the optimiser",
          ],
          answer: 1,
          explain: "Diagnostics are consumed by humans and tools. A blessed-output test turns a subtle change in a span or a note into a visible diff instead of a silent regression.",
        },
      ],
      quickbytes: [
        "Emit structured diagnostics and render them in one place; never format at the failure site.",
        "Give every diagnostic a stable code and a documentation anchor.",
        "Clamp every span before indexing source, and test the empty-span case.",
      ],
      production: [
        "Diagnostics have codes, and codes are treated as API: never reused for a different meaning.",
        "UI tests pin rendered output for representative errors, including multi-span and multi-line cases.",
        "Suggestions are marked machine-applicable only when a fix test proves the edit compiles.",
        "JSON diagnostics are schema-checked because IDE plugins depend on their shape.",
      ],
      crates: ["ariadne", "miette", "annotate-snippets"],
      github: [
        { name: "ariadne - span-accurate diagnostic rendering", url: "https://github.com/zesterer/ariadne" },
        { name: "miette - diagnostic protocol and rendering", url: "https://github.com/zkat/miette" },
      ],
      pitfall: "Indexing the source with an unclamped span: an error at end of file, or a span from a macro expansion, produces a byte index past the buffer or inside a character boundary, and the compiler panics while reporting a user error.",
      resources: [
        { title: "ariadne - diagnostic rendering with labels", url: "https://docs.rs/ariadne/latest/ariadne/", kind: "docs" },
        { title: "miette - structured diagnostics and reports", url: "https://docs.rs/miette/latest/miette/", kind: "docs" },
        { title: "annotate-snippets - the renderer rustc uses", url: "https://docs.rs/annotate-snippets/latest/annotate_snippets/", kind: "docs" },
        { title: "rustc-dev-guide: diagnostics", url: "https://rustc-dev-guide.rust-lang.org/diagnostics.html", kind: "docs" },
        { title: "ariadne repository - span-accurate rendering", url: "https://github.com/zesterer/ariadne", kind: "repo" },
      ],
    },

    // ------------------------------------------------------------------ cl17
    {
      id: 'cl17',
      n: 17,
      title: "Incremental compilation: the query system and red-green",
      minutes: 105,
      level: 'industry',
      goal: "Model a compiler as memoised queries with recorded dependencies, implement the red-green algorithm with early cutoff, and identify the inputs that silently destroy incrementality.",
      sections: [
        {
          h: "Queries instead of passes",
          p: [
            "A compiler organised as a sequence of passes has to rerun a pass for the whole crate when anything changes. A query-based compiler inverts the control flow: a query is a memoised function from a key to a value, and computing a value demands other queries. rustc expresses every step between HIR and LLVM IR this way, with TyCtxt as the database, so asking for the MIR of one function pulls in exactly what that function needs.",
            "The dependency graph is the product. Each query records which other queries it read and in what order, which matters because control flow inside a query depends on values: if a branch flips, the queries on the other path must not be reused. Order is not a detail; the guide is explicit that visiting dependencies out of order can cause internal compiler errors.",
          ],
          list: [
            "A query key is the function plus its arguments, including the type context",
            "Results and the dependency edges are cached, optionally serialized to disk",
            "Recomputation is demand-driven: untouched queries are never entered",
            "The graph is a DAG by construction, because a query cannot depend on itself",
          ],
          tip: "Design query boundaries around what changes together. A query that reads the whole crate will be invalidated by any edit, which defeats the entire mechanism.",
        },
        {
          h: "Red-green, and the early cutoff",
          p: [
            "The algorithm is called red-green. Before reusing a memo, the compiler asks whether each dependency still holds the same value. If a dependency re-ran and produced an identical result, its colour is green even though it executed, and dependents can be reused without ever being entered. That second insight is the one people miss: re-execution does not have to propagate, only a change in value does.",
            "This is implemented as try-mark-green: walk the recorded dependencies in order, recursively, and stop as soon as one is red. If all are green, the query is green without re-execution. Otherwise recompute and compare the result against the stored one; equal results are backdated to green. The saving compounds: a comment change invalidates tokenisation, but if the parsed tree is identical, nothing downstream runs.",
          ],
          code: src`
            use std::collections::HashMap;

            #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
            pub enum Query { Tokens, Ast, Types }

            pub struct Entry { input: Option<u64>, deps: Vec<(Query, u64)>, value: String }

            #[derive(Default)]
            pub struct Db { entries: HashMap<Query, Entry>, pub executed: usize }

            fn hash(value: &str) -> u64 {
                value.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| {
                    (h ^ b as u64).wrapping_mul(0x0100_0000_01b3)
                })
            }

            impl Db {
                pub fn demand<F>(&mut self, key: Query, input: Option<u64>, deps: &[Query],
                                 compute: F) -> String
                where
                    F: FnOnce(&mut Db) -> String,
                {
                    let valid = self.entries.get(&key).is_some_and(|entry| {
                        entry.input == input
                            && entry.deps.iter().all(|(dep, recorded)| {
                                self.entries
                                    .get(dep)
                                    .is_some_and(|other| hash(&other.value) == *recorded)
                            })
                    });
                    if valid {
                        return self.entries[&key].value.clone();
                    }

                    let value = compute(self);
                    let deps = deps
                        .iter()
                        .map(|dep| {
                            (*dep, self.entries.get(dep).map_or(0, |entry| hash(&entry.value)))
                        })
                        .collect();
                    self.executed += 1;
                    self.entries.insert(key, Entry { input, deps, value: value.clone() });
                    value
                }
            }

            pub fn compile(db: &mut Db, source: &str) -> String {
                let input = Some(hash(source));
                let tokens = db.demand(Query::Tokens, input, &[], |_| {
                    source.split_whitespace().collect::<Vec<_>>().join(" ")
                });
                // A comment runs to end of line and is dropped: hence the cutoff.
                let ast = db.demand(Query::Ast, None, &[Query::Tokens], |_| {
                    let code: Vec<&str> =
                        tokens.split(' ').take_while(|t| !t.starts_with('#')).collect();
                    format!("(ast {})", code.join(" "))
                });
                db.demand(Query::Types, None, &[Query::Ast], |_| format!("{ast} :: ok"))
            }
          `,
          tip: "Store the hash of a dependency's output, not of its input. Hashing inputs makes every edit propagate; hashing outputs is what enables the cutoff.",
        },
        {
          h: "What silently destroys incrementality",
          p: [
            "Three things break the scheme in practice. Unstable hashing comes first: if a fingerprint depends on HashMap iteration order, a pointer value, or a span id that changes between runs, results look different every build and nothing is ever green. rustc uses deterministic hashers and structural hashing precisely for this reason, and any hash you feed into the dep graph must be stable across processes.",
            "Second, over-broad dependencies: a query that reads every item in a crate is invalidated by every edit, so it becomes a bottleneck that makes the whole graph red. Third, dependencies on ambient state such as environment variables, the current time, or the contents of a file that is not an input query. Each of those needs to be promoted to a real input, or the cache will hand back results computed under different conditions.",
          ],
          tip: "If a rebuild is unexpectedly slow, ask which query re-ran and what made it red. Treat that as a bug report with a name, not as an unavoidable cost.",
        },
      ],
      exercise: {
        prompt: "Add a fourth query that depends on Types, then prove that changing only a comment executes exactly two queries and leaves the other two green.",
        starter: src`
          // Existing queries: Tokens -> Ast -> Types.
          // 1. add Codegen depending on Types
          // 2. drive compile() through all four
          // 3. assert executed counts for three builds: cold, warm, comment-only
          pub enum Query { Tokens, Ast, Types, Codegen }
        `,
        hint: "The comment-only build invalidates Tokens (input changed) and Ast (token value changed), but Ast produces the same value, so Types and Codegen stay green. Assert on the total executed count after each build.",
        solution: src`
          use std::collections::HashMap;

          #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
          pub enum Query { Tokens, Ast, Types, Codegen }

          pub struct Entry { input: Option<u64>, deps: Vec<(Query, u64)>, value: String }

          #[derive(Default)]
          pub struct Db { entries: HashMap<Query, Entry>, pub executed: usize }

          fn fingerprint(value: &str) -> u64 {
              let mut hash = 0xcbf2_9ce4_8422_2325u64;
              for byte in value.as_bytes() {
                  hash ^= *byte as u64;
                  hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
              }
              hash
          }

          impl Db {
              pub fn demand<F>(
                  &mut self,
                  key: Query,
                  input: Option<u64>,
                  deps: &[Query],
                  compute: F,
              ) -> String
              where
                  F: FnOnce(&mut Db) -> String,
              {
                  let still_valid = self.entries.get(&key).is_some_and(|entry| {
                      entry.input == input
                          && entry.deps.iter().all(|(dep, recorded)| {
                              self.entries
                                  .get(dep)
                                  .map(|other| fingerprint(&other.value) == *recorded)
                                  .unwrap_or(false)
                          })
                  });
                  if still_valid {
                      return self.entries[&key].value.clone();
                  }
                  let value = compute(self);
                  let recorded = deps
                      .iter()
                      .map(|dep| {
                          let hash = self.entries.get(dep)
                              .map(|entry| fingerprint(&entry.value))
                              .unwrap_or(0);
                          (*dep, hash)
                      })
                      .collect();
                  self.executed += 1;
                  self.entries.insert(key, Entry { input, deps: recorded, value: value.clone() });
                  value
              }
          }

          fn tokenize(source: &str) -> String {
              source.split_whitespace().collect::<Vec<_>>().join(" ")
          }
          fn parse(tokens: &str) -> String {
              let code: Vec<&str> = tokens
                  .split(' ')
                  .take_while(|token| !token.starts_with('#'))
                  .collect();
              format!("(ast {})", code.join(" "))
          }
          fn check(ast: &str) -> String { format!("{ast} :: ok") }
          fn codegen(types: &str) -> String { format!("{types} -> code") }

          pub fn compile(db: &mut Db, source: &str) -> String {
              let input = Some(fingerprint(source));
              let tokens = db.demand(Query::Tokens, input, &[], |_| tokenize(source));
              let ast = db.demand(Query::Ast, None, &[Query::Tokens], |_| parse(&tokens));
              let types = db.demand(Query::Types, None, &[Query::Ast], |_| check(&ast));
              db.demand(Query::Codegen, None, &[Query::Types], |_| codegen(&types))
          }

          fn main() {
              let mut db = Db::default();
              compile(&mut db, "let x = 1");
              assert_eq!(db.executed, 4, "cold build runs all four");

              compile(&mut db, "let x = 1");
              assert_eq!(db.executed, 4, "warm build runs none");

              compile(&mut db, "let x = 1 # note");
              assert_eq!(db.executed, 6, "only Tokens and Ast re-ran");
              println!("ok");
          }
        `,
      },
      questions: [
        {
          q: "Why does the dep graph record the order in which dependencies were read?",
          options: [
            "To make serialisation deterministic",
            "Because control flow inside a query depends on values, so a flipped branch makes later reads invalid",
            "To detect cycles faster",
            "To prioritise work across threads",
          ],
          answer: 1,
          explain: "If a condition changes, the query may not read the same dependencies at all. Replaying in the original order stops validation exactly where execution diverged.",
        },
        {
          q: "A query re-runs and produces an identical value. What happens to its dependents?",
          options: [
            "They re-run, because their dependency executed",
            "They stay green, because their dependency's value did not change",
            "They are invalidated on the next build instead",
            "They are erased from the cache to be safe",
          ],
          answer: 1,
          explain: "That is the early cutoff: invalidation propagates on value change, not on execution. It is the difference between a usable incremental compiler and a slow one.",
        },
        {
          q: "Which of these is a real threat to incremental correctness?",
          options: [
            "Using a deterministic structural hash for a query key",
            "Hashing a value that depends on HashMap iteration order",
            "Caching results on disk between builds",
            "Reading an input only through a tracked query",
          ],
          answer: 1,
          explain: "Unstable hashes make identical runs look different, so nothing is ever green and, worse, results can be wrongly invalidated or wrongly reused depending on the hash.",
        },
      ],
      quickbytes: [
        "A query key must include every argument that affects the result, including the type context.",
        "Hash outputs, not inputs, if you want the early cutoff.",
        "Instability in hashes is a correctness bug, not just a performance bug.",
      ],
      production: [
        "Query keys are structural and deterministic across processes; a hash test runs on every build.",
        "The cache stores dependency fingerprints in read order, and validation stops at the first red one.",
        "Incremental CI job measures a no-op rebuild and fails if it exceeds a budget.",
        "Ambient inputs such as env vars are promoted to tracked input queries.",
      ],
      crates: ["salsa", "rustc-hash", "serde"],
      github: [
        { name: "salsa - incremental computation as a reusable library", url: "https://github.com/salsa-rs/salsa" },
        { name: "rust - rustc_middle/src/dep_graph", url: "https://github.com/rust-lang/rust" },
      ],
      pitfall: "Fingerprinting a HashMap directly: iteration order differs between processes, the query looks changed on every build, and incremental compilation silently degrades to a full rebuild.",
      resources: [
        { title: "rustc-dev-guide: incremental compilation", url: "https://rustc-dev-guide.rust-lang.org/queries/incremental-compilation.html", kind: "docs" },
        { title: "rustc-dev-guide: the query system", url: "https://rustc-dev-guide.rust-lang.org/query.html", kind: "docs" },
        { title: "salsa - on-demand incrementalised computation", url: "https://docs.rs/salsa/latest/salsa/", kind: "docs" },
        { title: "salsa repository", url: "https://github.com/salsa-rs/salsa", kind: "repo" },
      ],
    },

    // ------------------------------------------------------------------ cl18
    {
      id: 'cl18',
      n: 18,
      title: "Linkers and debug info: symbols, relocations, DWARF",
      minutes: 75,
      level: 'industry',
      goal: "Explain what a linker does to your object files, read symbols and line tables out of a binary programmatically, and choose debug-info settings that keep production backtraces useful.",
      sections: [
        {
          h: "The linker resolves names and patches addresses",
          p: [
            "Codegen produces object files, not programs. An object file has sections (code, data, read-only data, debug info), a symbol table, and relocations: placeholders that say this instruction needs the address of that symbol. The linker's job is to lay the sections out, assign final addresses, resolve symbols across objects and libraries, patch the relocations, and write an executable or shared object.",
            "Static linking copies the code into your binary; dynamic linking leaves a reference and a stub that the loader fills in at startup. That choice determines startup cost, binary size, and how a security update to a C library reaches you. The toolchain matters too: lld and mold are dramatically faster than the traditional GNU linker on large binaries, and selecting one is a link-arg away, which is often the cheapest build-time win available.",
          ],
          list: [
            "Sections hold code, data and metadata; symbols name addresses inside them",
            "Relocations are instructions that need an address only the linker knows",
            "Static linking duplicates code; dynamic linking defers resolution to the loader",
            "Position-independent executables add a relocation base, which is why addresses move",
          ],
          tip: "When a build fails with undefined reference, read the symbol name before touching Cargo.toml. It usually names the missing crate or the C library the build script never linked.",
        },
        {
          h: "Debug info is a second product of the same build",
          p: [
            "DWARF is the format that maps machine addresses back to source. .debug_info holds a tree of description entries for types and functions, .debug_line holds a line-number program that maps address ranges to file, line and column, and .debug_str and .debug_abbrev hold the strings and the encoding schema. A debugger or profiler reads those tables to answer which line of which file this instruction came from.",
            "Debug info costs size and build time, so Cargo makes it a knob: debug = 1 emits line tables only, debug = 2 emits full type information, and split-debuginfo keeps the DWARF in separate files so it never ships. Stripping the binary removes the tables and turns every symbolicated backtrace into an address. If you want useful production backtraces, keep at least line tables and unwind information, and archive the debug files alongside the binary.",
          ],
          code: src`
            use object::{Object, ObjectSymbol};

            #[derive(Debug, PartialEq, Eq)]
            pub struct Sym {
                pub name: String,
                pub address: u64,
                pub defined: bool,
            }

            /// Read the symbol table of an ELF/Mach-O/PE image, as a profiler would.
            pub fn read_symbols(bytes: &[u8]) -> Result<Vec<Sym>, String> {
                let file = object::File::parse(bytes).map_err(|e| e.to_string())?;
                Ok(file
                    .symbols()
                    .map(|symbol| Sym {
                        name: symbol.name().unwrap_or("<unnamed>").to_string(),
                        address: symbol.address(),
                        defined: symbol.is_definition(),
                    })
                    .collect())
            }

            fn main() {
                let bytes = std::fs::read(std::env::current_exe().unwrap()).unwrap();
                let symbols = read_symbols(&bytes).unwrap();
                assert!(symbols.iter().any(|s| s.name.contains("main")));
                println!("{} symbols in this binary", symbols.len());
            }
          `,
          tip: "Symbolicate one real backtrace end to end before trusting a profiler setup. A missing line table looks identical to a missing symbol until you try.",
        },
        {
          h: "Making a release build debuggable",
          p: [
            "The default release profile strips almost everything useful: full debug info is off and symbols may be stripped, so a crash gives you an address and maybe a function name. A production profile that keeps debug = 1, keeps unwind tables, and archives split debug files gives you line numbers in backtraces for a few percent of binary size, which is almost always worth it.",
            "Frame pointers are the other half. Unwinding by DWARF works but is slower and more fragile in the presence of hand-written assembly or signal frames. Forcing frame pointers costs a register and a few percent of performance, and it makes sampling profilers dramatically more reliable. Decide with a measurement, not by default: if your profiler works without them, you do not need them; if backtraces are garbage, it is the first thing to try.",
          ],
          list: [
            "debug = 1 for line tables, debug = 2 for full types, split-debuginfo to keep them out of the binary",
            "strip = none for builds you need to symbolicate, strip = symbols for everything else",
            "Keep unwind tables; without them, panic backtraces stop at the frame that called into compiled code",
            "Force frame pointers only when a profiler needs them, and measure the cost",
          ],
          tip: "Archive the debug files per release with the exact build id. A debug artifact you cannot match to a binary is worse than none, because it invites wrong conclusions.",
        },
      ],
      exercise: {
        prompt: "Write a tool that takes a binary path and prints the five defined symbols with the largest sizes, ignoring symbols with no size. Clamp anything that would panic on a malformed file.",
        starter: src`
          use object::{Object, ObjectSymbol};

          pub struct Sym { pub name: String, pub size: u64 }

          // object::Symbol gives name(), address(), size() and is_definition().
          pub fn largest_symbols(_bytes: &[u8], _limit: usize) -> Result<Vec<Sym>, String> {
              todo!()
          }
        `,
        hint: "Filter on is_definition() and size() > 0, map to (name, size), collect into a Vec, sort by size descending, then truncate. Return an error rather than unwrapping the parse.",
        solution: src`
          use object::{Object, ObjectSymbol};

          #[derive(Debug, PartialEq, Eq)]
          pub struct Sym { pub name: String, pub size: u64 }

          pub fn largest_symbols(bytes: &[u8], limit: usize) -> Result<Vec<Sym>, String> {
              let file = object::File::parse(bytes).map_err(|e| e.to_string())?;
              let mut symbols: Vec<Sym> = file
                  .symbols()
                  .filter(|symbol| symbol.is_definition() && symbol.size() > 0)
                  .map(|symbol| Sym {
                      name: symbol.name().unwrap_or("<unnamed>").to_string(),
                      size: symbol.size(),
                  })
                  .collect();
              symbols.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.name.cmp(&b.name)));
              symbols.truncate(limit);
              Ok(symbols)
          }

          fn main() {
              let bytes = std::fs::read(std::env::current_exe().unwrap()).unwrap();
              let top = largest_symbols(&bytes, 5).unwrap();
              assert!(!top.is_empty(), "a test binary has sized symbols");
              assert!(top.windows(2).all(|pair| pair[0].size >= pair[1].size));

              let garbage = largest_symbols(b"not an object file", 5);
              assert!(garbage.is_err(), "malformed input is an error, not a panic");
              println!("{:?}", top.first());
          }
        `,
      },
      questions: [
        {
          q: "What is a relocation in an object file?",
          options: [
            "A map from source lines to addresses",
            "A placeholder for an address that only the linker can resolve",
            "A copy of a section moved for alignment",
            "A record of which crate produced the object",
          ],
          answer: 1,
          explain: "Codegen does not know where other symbols will land. It emits a relocation describing which symbol's address to patch in and how, and the linker fills it once layout is final.",
        },
        {
          q: "Which setting gives line numbers in backtraces with the smallest size cost?",
          options: [
            "debug = 0 with symbols stripped",
            "debug = 1, line tables only",
            "debug = 2 with full type information",
            "No setting; backtraces always require full DWARF",
          ],
          answer: 1,
          explain: "Line tables are what map an address to file and line. Full type information is most of the size, and backtraces do not need it.",
        },
        {
          q: "A release binary reports addresses instead of function names. What is the most likely cause?",
          options: [
            "The optimisation level is too high",
            "The symbol table or debug info was stripped",
            "The program was built as a static binary",
            "The linker was lld",
          ],
          answer: 1,
          explain: "Symbolication needs names and line tables. Stripping removes them; keeping a symbol archive next to the binary lets you symbolicate after the fact.",
        },
      ],
      quickbytes: [
        "Read the missing symbol name before changing anything in the build; it names the cause.",
        "Ship line tables in release, and archive split debug files per build id.",
        "Try lld or mold before optimising the compiler: link time is often the cheapest win.",
      ],
      production: [
        "Release profiles pin debug, strip and split-debuginfo explicitly instead of relying on defaults.",
        "Every release archives its debug artefacts, matched by build id.",
        "Symbolication of a real backtrace is part of the release checklist.",
        "Linker flags are recorded next to the build so a failing build is reproducible.",
      ],
      crates: ["object", "gimli", "addr2line"],
      github: [
        { name: "gimli - a DWARF parser in Rust", url: "https://github.com/gimli-rs/gimli" },
        { name: "llvm-project - lld, the LLVM linker", url: "https://github.com/llvm/llvm-project/tree/main/lld" },
      ],
      pitfall: "Stripping a release binary but keeping the crash reports: every stack trace becomes a list of addresses, and the only copy of the line tables was deleted during the build.",
      resources: [
        { title: "object - reading object files and symbol tables", url: "https://docs.rs/object/latest/object/", kind: "docs" },
        { title: "gimli - DWARF debugging format reader", url: "https://docs.rs/gimli/latest/gimli/", kind: "docs" },
        { title: "addr2line - resolve addresses to source lines", url: "https://docs.rs/addr2line/latest/addr2line/", kind: "docs" },
        { title: "Cargo profiles: debug, strip and split-debuginfo", url: "https://doc.rust-lang.org/cargo/reference/profiles.html", kind: "docs" },
        { title: "gimli repository - DWARF parsing in Rust", url: "https://github.com/gimli-rs/gimli", kind: "repo" },
      ],
    },

    // ------------------------------------------------------------------ cl19
    {
      id: 'cl19',
      n: 19,
      title: "Compiler testing: differential, property, and fuzzing",
      minutes: 90,
      level: 'industry',
      goal: "Build a differential harness that compares a compiler against a reference interpreter, shrink a failing case to a minimal reproducer, and design a fuzzing strategy that reaches codegen rather than stopping at the parser.",
      sections: [
        {
          h: "Three kinds of test, three different bugs",
          p: [
            "Golden tests catch regressions in output you have already seen: a parse tree, a diagnostic, a block of IR. They are cheap and precise, and they are the reason a formatting change shows up as a reviewable diff. What they cannot do is find a bug you did not anticipate, because the expectation encodes today's behaviour, wrong or right.",
            "Differential testing compares two implementations of the same semantics. A tree-walk interpreter and a compiled backend must agree on every program; when they disagree, one of them is wrong and the reproducer is the program itself. Property and metamorphic tests cover the optimiser: running at opt-level 0 and opt-level 3 must produce the same observable result, which is a property no golden test can express.",
          ],
          list: [
            "Golden tests: exact output, catches regressions, encodes current behaviour",
            "Differential tests: two backends, one semantics, finds disagreements",
            "Metamorphic tests: a transformation that must preserve behaviour (opt levels, inlining)",
            "Property tests: invariants over generated input (parse-print-parse round trips)",
          ],
          tip: "Write the differential harness as soon as the second backend exists. It finds more bugs in a week than a year of hand-written cases.",
        },
        {
          h: "Fuzzing has to reach the code you care about",
          p: [
            "Feeding random bytes to a parser finds panics in the lexer and nothing else, because almost every random input is rejected before the AST exists. To fuzz a compiler's middle and back end you need inputs that are syntactically and often semantically valid: generate from the grammar, mutate a corpus of valid programs, or generate well-typed terms directly. Structure-aware generation is more work and finds the bugs that matter.",
            "cargo-fuzz drives libFuzzer over a byte slice with coverage feedback, which is excellent at exploring a parser and useless at producing a type-correct program unless your generator can. The pragmatic split is a byte-level fuzzer for the front end and a program generator plus differential oracle for the back end. Both belong in CI with a time budget, and both need a way to turn a crash into a test: deduplicate, minimise, and commit the reproducer to a regression corpus.",
          ],
          code: src`
            #[derive(Clone, Debug, PartialEq, Eq)]
            pub enum Expr {
                Int(i64),
                Sub(Box<Expr>, Box<Expr>),
            }

            #[derive(Clone, Copy, Debug, PartialEq, Eq)]
            pub enum Op { Push(i64), Sub }

            /// The reference semantics: subtraction is not commutative.
            pub fn eval(expr: &Expr) -> i64 {
                match expr {
                    Expr::Int(value) => *value,
                    Expr::Sub(lhs, rhs) => eval(lhs) - eval(rhs),
                }
            }

            /// The compiler under test: a post-order walk emitting a stack program.
            pub fn compile(expr: &Expr) -> Vec<Op> {
                match expr {
                    Expr::Int(value) => vec![Op::Push(*value)],
                    Expr::Sub(lhs, rhs) => {
                        let mut program = compile(lhs);
                        program.extend(compile(rhs));
                        program.push(Op::Sub);
                        program
                    }
                }
            }

            pub fn run(program: &[Op]) -> Result<i64, String> {
                let mut stack: Vec<i64> = Vec::new();
                for op in program {
                    match *op {
                        Op::Push(value) => stack.push(value),
                        Op::Sub => {
                            let right = stack.pop().ok_or("underflow")?;
                            let left = stack.pop().ok_or("underflow")?;
                            stack.push(left - right);
                        }
                    }
                }
                stack.pop().ok_or_else(|| "empty result stack".to_string())
            }

            /// One random program from a seed, so every failure is reproducible.
            pub fn sample(seed: u64) -> Expr {
                fn build(state: &mut u64, depth: u32) -> Expr {
                    *state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                    let roll = (*state >> 33) % 100;
                    if depth == 0 || roll < 40 {
                        Expr::Int(((roll * 7) % 20) as i64)
                    } else {
                        let (lhs, rhs) = (build(state, depth - 1), build(state, depth - 1));
                        Expr::Sub(Box::new(lhs), Box::new(rhs))
                    }
                }
                let mut state = seed | 1;
                build(&mut state, 3)
            }
          `,
          tip: "Print the failing seed and commit it with the fix. A reproducer expressed as a seed plus a test name is reproducible forever; a pasted program rots.",
        },
        {
          h: "Shrinking is what makes a fuzzer usable",
          p: [
            "A fuzzer's first crash is usually a two-hundred-node program generated by a mutation of something already ugly. Nobody fixes a bug from that. Shrinking repeatedly replaces the input with a smaller one that still fails, and the quality of the shrinker decides whether triage takes ten minutes or a day. The invariant to preserve is only this: the reduced input must still exhibit the same failure, not necessarily the same crash message.",
            "A useful shrinker is greedy and size-monotone: try replacing subtrees, drop statements, simplify constants, and keep whatever still fails, always strictly decreasing a size measure so it terminates. When the result is a five-line reproducer, the bug is usually obvious. When shrinking gets stuck early, the failure predicate is too broad, for example matching a different panic than the one you are chasing.",
          ],
          code: src`
            /// The same walk with lhs and rhs swapped: a plausible, silent, wrong compiler.
            pub fn compile_swapped(expr: &Expr) -> Vec<Op> {
                match expr {
                    Expr::Int(value) => vec![Op::Push(*value)],
                    Expr::Sub(lhs, rhs) => {
                        let mut program = compile_swapped(rhs);
                        program.extend(compile_swapped(lhs));
                        program.push(Op::Sub);
                        program
                    }
                }
            }

            fn size(expr: &Expr) -> usize {
                match expr {
                    Expr::Int(_) => 1,
                    Expr::Sub(lhs, rhs) => 1 + size(lhs) + size(rhs),
                }
            }

            /// Every proper subtree, so shrinking can collapse to any nested expression.
            fn subtrees(expr: &Expr) -> Vec<Expr> {
                match expr {
                    Expr::Int(_) => Vec::new(),
                    Expr::Sub(lhs, rhs) => {
                        let mut out = vec![(**lhs).clone(), (**rhs).clone()];
                        out.extend(subtrees(lhs));
                        out.extend(subtrees(rhs));
                        out
                    }
                }
            }

            /// Greedy shrinking: collapse to any proper subtree that still fails.
            pub fn shrink(expr: &Expr, fails: &dyn Fn(&Expr) -> bool) -> Expr {
                let mut best = expr.clone();
                while let Some(candidate) = subtrees(&best)
                    .into_iter()
                    .find(|candidate| size(candidate) < size(&best) && fails(candidate))
                {
                    best = candidate;
                }
                best
            }

            fn main() {
                let buggy = |expr: &Expr| -> bool {
                    run(&compile_swapped(expr))
                        .map(|value| value != eval(expr))
                        .unwrap_or(true)
                };
                let failing = (0..500u64).map(sample).find(|expr| buggy(expr)).expect("hit");
                let minimal = shrink(&failing, &buggy);
                assert_eq!(size(&minimal), 3, "a subtraction of two leaves");
                println!("shrunk to {minimal:?}");
            }
          `,
          tip: "Shrink against a predicate, not against a log line. Predicates compose; log matching breaks the moment someone rewords an error.",
        },
      ],
      exercise: {
        prompt: "Add a constant-folding pass to the compiler and a metamorphic test that proves folding never changes the result, then break the pass on purpose and confirm the harness catches it.",
        starter: src`
          pub fn fold(expr: &Expr) -> Expr {
              // Sub(Int(a), Int(b)) -> Int(a - b)
              // recurse into children first
              todo!()
          }

          // metamorphic test: for 500 seeds, eval(&fold(e)) == eval(&e)
        `,
        hint: "Fold bottom-up so a nested constant becomes foldable on the way up. The failure case to add is folding to a - b instead of a - b for the swapped variant, which is exactly what the differential oracle already catches.",
        solution: src`
          #[derive(Clone, Debug, PartialEq, Eq)]
          pub enum Expr {
              Int(i64),
              Sub(Box<Expr>, Box<Expr>),
          }

          pub fn eval(expr: &Expr) -> i64 {
              match expr {
                  Expr::Int(value) => *value,
                  Expr::Sub(lhs, rhs) => eval(lhs) - eval(rhs),
              }
          }

          pub fn fold(expr: &Expr) -> Expr {
              match expr {
                  Expr::Int(value) => Expr::Int(*value),
                  Expr::Sub(lhs, rhs) => {
                      let lhs = fold(lhs);
                      let rhs = fold(rhs);
                      match (&lhs, &rhs) {
                          (Expr::Int(a), Expr::Int(b)) => Expr::Int(a - b),
                          _ => Expr::Sub(Box::new(lhs), Box::new(rhs)),
                      }
                  }
              }
          }

          /// The bug we want the harness to catch: fold as b - a.
          pub fn fold_swapped(expr: &Expr) -> Expr {
              match expr {
                  Expr::Int(value) => Expr::Int(*value),
                  Expr::Sub(lhs, rhs) => {
                      let lhs = fold_swapped(lhs);
                      let rhs = fold_swapped(rhs);
                      match (&lhs, &rhs) {
                          (Expr::Int(a), Expr::Int(b)) => Expr::Int(b - a),
                          _ => Expr::Sub(Box::new(lhs), Box::new(rhs)),
                      }
                  }
              }
          }

          fn sample(seed: u64) -> Expr {
              let mut state = seed | 1;
              let mut next = |bound: u64| {
                  state = state
                      .wrapping_mul(6364136223846793005)
                      .wrapping_add(1442695040888963407);
                  (state >> 33) % bound
              };
              fn build(next: &mut impl FnMut(u64) -> u64, depth: u32) -> Expr {
                  if depth == 0 || next(100) < 50 {
                      Expr::Int(next(10) as i64)
                  } else {
                      Expr::Sub(Box::new(build(next, depth - 1)), Box::new(build(next, depth - 1)))
                  }
              }
              build(&mut next, 3)
          }

          fn main() {
              // Metamorphic property: folding preserves the result.
              for seed in 0..500u64 {
                  let expr = sample(seed);
                  assert_eq!(eval(&fold(&expr)), eval(&expr), "seed {seed}");
              }

              // The broken pass must be caught by the same property.
              let caught = (0..500u64)
                  .map(sample)
                  .any(|expr| eval(&fold_swapped(&expr)) != eval(&expr));
              assert!(caught, "the metamorphic test must fail for the broken pass");
              println!("ok");
          }
        `,
      },
      questions: [
        {
          q: "Why does byte-level fuzzing rarely find codegen bugs?",
          options: [
            "Because codegen is written in Rust and therefore has no bugs",
            "Because almost all random byte strings are rejected before a valid AST exists",
            "Because libFuzzer does not support multithreaded targets",
            "Because codegen runs in a separate process",
          ],
          answer: 1,
          explain: "Coverage-guided byte fuzzing explores the front end deeply and never reaches the middle. Reaching codegen needs grammar-aware or type-aware generation, or a corpus of valid programs to mutate.",
        },
        {
          q: "What must a shrinker preserve above all else?",
          options: [
            "The exact panic message",
            "The failure itself, under the predicate that detects it",
            "The original program size ratio",
            "The source file name",
          ],
          answer: 1,
          explain: "Matching a message makes the shrinker brittle as soon as wording changes. A predicate such as evaluator disagreement survives refactors and keeps the reduced case meaningful.",
        },
        {
          q: "Which test would catch an optimiser that changes semantics only at opt-level 3?",
          options: [
            "A golden test of the opt-level 3 IR",
            "A metamorphic test comparing observable results across optimisation levels",
            "A unit test of the parser",
            "A documentation test",
          ],
          answer: 1,
          explain: "The bug is a disagreement between two configurations, not a wrong output for one. Comparing results across opt levels states the property the optimiser must preserve.",
        },
      ],
      quickbytes: [
        "Differential testing needs the reference implementation; build the interpreter first.",
        "Log a seed with every generated case so a failure is reproducible in one line.",
        "Commit every halted fuzz reproducer to a regression corpus in the repository.",
      ],
      production: [
        "Every backend is compared against the reference interpreter on the same corpus.",
        "Optimisation levels are part of the test matrix, not a release-only switch.",
        "Fuzzing runs in CI with a time budget and uploads crash reproducers as artefacts.",
        "A regression corpus lives in-tree and grows with every fixed bug.",
      ],
      crates: ["proptest", "arbitrary", "insta"],
      github: [
        { name: "cargo-fuzz - libFuzzer integration for Rust", url: "https://github.com/rust-fuzz/cargo-fuzz" },
        { name: "rust - tests/ui, the compiler's diagnostic test suite", url: "https://github.com/rust-lang/rust/tree/master/tests/ui" },
      ],
      pitfall: "Fuzzing the parser for months and calling the compiler fuzzed: random bytes never construct a valid AST, so the middle end and the backend are never executed by the fuzzer at all.",
      resources: [
        { title: "cargo-fuzz - coverage-guided fuzzing for Rust", url: "https://github.com/rust-fuzz/cargo-fuzz", kind: "repo" },
        { title: "proptest - property-based testing with shrinking", url: "https://docs.rs/proptest/latest/proptest/", kind: "docs" },
        { title: "insta - snapshot tests for diagnostics and IR", url: "https://docs.rs/insta/latest/insta/", kind: "docs" },
        { title: "cargo-fuzz repository - coverage-guided fuzzing", url: "https://github.com/rust-fuzz/cargo-fuzz", kind: "repo" },
        { title: "rustc-dev-guide: compiletest and UI tests", url: "https://rustc-dev-guide.rust-lang.org/tests/compiletest.html", kind: "docs" },
      ],
    },

    // ------------------------------------------------------------------ cl20
    {
      id: 'cl20',
      n: 20,
      title: "Language design trade-offs: what a compiler can and cannot buy",
      minutes: 75,
      level: 'industry',
      goal: "Reason about the costs a language feature imposes on the compiler, the diagnostics and the ecosystem, and explain the static-versus-dynamic dispatch trade with numbers rather than slogans.",
      sections: [
        {
          h: "Every guarantee is paid for at compile time",
          p: [
            "A borrow checker turns whole classes of runtime bugs into compile errors, and the price is a flow-sensitive analysis on every function plus a diagnostic vocabulary users must learn. A garbage collector buys simpler ownership and pays with pauses, memory overhead and a runtime. Neither is strictly better; they are different distributions of cost, and the honest comparison names which programs get easier and which get impossible.",
            "The same arithmetic applies to smaller features. Type inference reduces annotation burden but makes error messages worse, because the compiler must explain a constraint system instead of pointing at a written type. Exhaustiveness checking prevents forgotten cases but slows compilation and forces a migration when an enum variant is added. A feature that cannot be explained in a diagnostic is a feature that will produce support tickets forever.",
          ],
          list: [
            "Expressiveness cost: more programs accepted means more analysis to stay sound",
            "Diagnostic cost: every inference and coercion needs an explanation path",
            "Compile-time cost: analyses are per-function, per-instantiation or whole-program",
            "Semver cost: once shipped, a guarantee is nearly impossible to withdraw",
          ],
          tip: "Before adding a feature, write the error message for the program it rejects. If the message is bad, the feature is not ready.",
        },
        {
          h: "Static and dynamic dispatch are two different bills",
          p: [
            "A generic function instantiated per type gives the optimiser concrete code: calls inline, constants propagate, and no vtable lookup happens. The bill is code size and compile time, because each instantiation is compiled and optimised separately. A dyn Trait call shares one implementation but goes through a fat pointer and an indirect call, which the optimiser cannot inline across, and it requires the trait to be object-safe.",
            "The right default depends on where the code sits in the profile. Small, hot, per-type functions are worth monomorphising; large, cold, type-erased boundaries are where dynamic dispatch wins by reducing binary size and build time. Choosing the same answer everywhere is how a codebase ends up either with a ten-minute build or with a hot loop that cannot inline.",
          ],
          code: src`
            pub trait Shape {
                fn area(&self) -> f64;
                fn name(&self) -> &'static str;
            }

            pub struct Circle { pub radius: f64 }
            pub struct Square { pub side: f64 }

            impl Shape for Circle {
                fn area(&self) -> f64 { std::f64::consts::PI * self.radius * self.radius }
                fn name(&self) -> &'static str { "circle" }
            }

            impl Shape for Square {
                fn area(&self) -> f64 { self.side * self.side }
                fn name(&self) -> &'static str { "square" }
            }

            /// Static dispatch: one copy per concrete type, inlinable, no vtable.
            pub fn total_static<S: Shape>(shapes: &[S]) -> f64 {
                shapes.iter().map(|shape| shape.area()).sum()
            }

            /// Dynamic dispatch: one shared copy, an indirect call per element.
            pub fn total_dynamic(shapes: &[&dyn Shape]) -> f64 {
                shapes.iter().map(|shape| shape.area()).sum()
            }

            fn main() {
                let circles = [Circle { radius: 1.0 }, Circle { radius: 2.0 }];
                let squares = [Square { side: 3.0 }];
                let as_dyn: [&dyn Shape; 3] = [&circles[0], &circles[1], &squares[0]];

                let statically: f64 = total_static(&circles) + total_static(&squares);
                let dynamically = total_dynamic(&as_dyn);
                assert!((statically - dynamically).abs() < 1e-9);
                println!("{statically} == {dynamically}");
            }
          `,
          tip: "Measure with the real workload. The crossover between monomorphised and dynamic code moves by an order of magnitude between a tight numeric loop and a request handler.",
        },
        {
          h: "The cost nobody budgets for: tooling and stability",
          p: [
            "A language feature is not shipped when the compiler accepts it. It is shipped when the formatter can print it, the IDE can complete it, the linter has opinions about it, the error index documents it, and the next edition can migrate it. That surface is why language teams ask for a design write-up even when the implementation is small: the implementation is the cheapest part.",
            "Stability makes it worse. Once users depend on a guarantee, removing it is a breaking change even if the guarantee was accidental. Types that leak through inference, auto traits that apply because a type happens to be Send, and error codes that tooling matches on all become contracts. Good language design is therefore mostly about what you refuse to promise, and about making the promises you do keep expressible in a diagnostic.",
          ],
          tip: "Track which parts of your language's behaviour are accidental. Anything users can observe is a candidate for becoming a guarantee by accident.",
        },
      ],
      exercise: {
        prompt: "Write the same pipeline stage twice, once generic over a trait and once over dyn Trait, then list three concrete costs of each choice in terms of build time, binary size and inlining. Verify both produce identical results.",
        starter: src`
          pub trait Pass { fn run(&self, input: &str) -> String; }

          // 1. a generic driver: fn drive<P: Pass>(pass: P)
          // 2. a dynamic driver: fn drive_dyn(pass: &dyn Pass)
          // 3. assert equal output, then decide which one belongs in a hot loop
          pub fn drive<P: Pass>(_pass: P, _input: &str) -> String { todo!() }
          pub fn drive_dyn(_pass: &dyn Pass, _input: &str) -> String { todo!() }
        `,
        hint: "Both drivers call pass.run(input). The difference is invisible at the call site and shows up in the generated code: monomorphisation duplicates the driver per concrete pass, dyn keeps one copy and adds an indirect call.",
        solution: src`
          pub trait Pass {
              fn run(&self, input: &str) -> String;
          }

          pub struct Lowercase;
          pub struct StripSpaces;

          impl Pass for Lowercase {
              fn run(&self, input: &str) -> String { input.to_lowercase() }
          }

          impl Pass for StripSpaces {
              fn run(&self, input: &str) -> String {
                  input.chars().filter(|c| !c.is_whitespace()).collect()
              }
          }

          /// Static dispatch: the compiler emits one driver per concrete pass type.
          pub fn drive<P: Pass>(pass: P, input: &str) -> String {
              pass.run(input)
          }

          /// Dynamic dispatch: one driver, one vtable lookup per call.
          pub fn drive_dyn(pass: &dyn Pass, input: &str) -> String {
              pass.run(input)
          }

          fn main() {
              let lower_static = drive(Lowercase, "Hello World");
              let lower_dynamic = drive_dyn(&Lowercase, "Hello World");
              assert_eq!(lower_static, lower_dynamic);
              assert_eq!(lower_static, "hello world");

              let strip_static = drive(StripSpaces, "a b c");
              assert_eq!(strip_static, drive_dyn(&StripSpaces, "a b c"));
              assert_eq!(strip_static, "abc");

              // Costs, concretely:
              //   static: 2 driver instantiations, both inlinable, more code
              //   dynamic: 1 driver, indirect call, cannot inline through the vtable
              println!("ok");
          }
        `,
      },
      questions: [
        {
          q: "What is the compile-time cost of monomorphising a generic driver used with five types?",
          options: [
            "None, because generics are erased at compile time",
            "Five copies of the driver, each compiled and optimised separately",
            "One copy, plus five vtable instantiations",
            "Five copies of the type, but one driver",
          ],
          answer: 1,
          explain: "Rust monomorphises: each set of type arguments produces its own instance that the backend compiles independently. That is the source of both the optimisation opportunity and the build-time cost.",
        },
        {
          q: "Why can a dyn Trait call not be inlined across?",
          options: [
            "Because the vtable is immutable",
            "Because the callee is only known at runtime, so there is no call target to inline",
            "Because trait objects are always heap allocated",
            "Because dyn disables the optimiser entirely",
          ],
          answer: 1,
          explain: "Inlining needs a known callee. With dynamic dispatch the target comes from the vtable at runtime, so the optimiser cannot substitute the body unless it devirtualises from observed types.",
        },
        {
          q: "Why is a feature not finished when the compiler accepts it?",
          options: [
            "Because the release process requires a blog post",
            "Because formatter, IDE, linter, documentation and edition migration all have to handle it",
            "Because the compiler must be rewritten in a new edition first",
            "Because benchmarks must show a speedup",
          ],
          answer: 1,
          explain: "Tooling and documentation are part of the product surface. A feature the IDE cannot complete or the formatter cannot print is a feature users experience as broken.",
        },
      ],
      quickbytes: [
        "Write the rejection diagnostic before writing the feature; if it cannot be explained, do not ship it.",
        "Pick static or dynamic dispatch per call site based on profile data, not on principle.",
        "Anything users can observe becomes a guarantee; decide deliberately what to expose.",
      ],
      production: [
        "New language features have a written rationale naming the cost in compile time, diagnostics and tooling.",
        "Dispatch choice is justified with a profile, and the code says which one was measured.",
        "Error messages for a new feature are reviewed as part of the design, not after implementation.",
        "Behaviour that must remain unstable is documented as such, so users do not depend on it by accident.",
      ],
      crates: ["criterion", "cargo-llvm-lines"],
      github: [
        { name: "rust - the language and its compiler", url: "https://github.com/rust-lang/rust" },
        { name: "rustc-dev-guide - why the compiler is built this way", url: "https://github.com/rust-lang/rustc-dev-guide" },
      ],
      pitfall: "Adding a feature without a plan for its diagnostics: the implementation lands, the error message is a placeholder, and every user who hits the rejected case gets a message that names an internal type instead of the fix.",
      resources: [
        { title: "Oxide: The Essence of Rust (what a borrow checker can promise)", url: "https://arxiv.org/abs/1903.00982", kind: "paper" },
        { title: "Not So Fast: WebAssembly vs. native code", url: "https://www.usenix.org/conference/atc19/presentation/jangda", kind: "paper" },
        { title: "rustc-dev-guide: design constraints of the compiler", url: "https://rustc-dev-guide.rust-lang.org/overview.html", kind: "docs" },
        { title: "The Rust Reference: type layout and representation", url: "https://doc.rust-lang.org/reference/type-layout.html", kind: "docs" },
        { title: "rust - the language, its compiler and its trade-offs", url: "https://github.com/rust-lang/rust", kind: "repo" },
      ],
    },

  ],
};
