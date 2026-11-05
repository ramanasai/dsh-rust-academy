/**
 * Interview prep track.
 *
 * Authored for the Rust Academy plugin. Every lesson is plain JSON-compatible
 * data consumed by src/app.js through build.mjs.
 */
export default {
  "key": "interview-prep",
  "prefix": "t",
  "title": "Interview prep",
  "blurb": "Rust-specific interview questions, DSA drills, system design prompts, debugging scenarios and mock interviews.",
  "level": "industry",
  "project": {
    "title": "Capstone: a personal interview drill plan",
    "brief": "Assemble a 4-week plan with drills, mock interviews and scoring rubrics tailored to senior Rust roles. Every week pairs a question category with a timed drill, a scored mock loop, and a written remediation step for the weakest dimension. The plan has to survive contact with a real calendar: 90 focused minutes a day, four days a week, with one full mock on the weekend.",
    "deliverables": [
      "Weekly drill schedule: four weeks, four sessions per week, each with a category, a timebox and a concrete artifact to produce.",
      "Scoring rubrics per topic: a 1-4 scale per dimension (correctness, trade-off reasoning, communication) with anchored descriptors.",
      "Mock interview transcripts with feedback: at least three 45-minute loops, annotated with what scored well and what was missed.",
      "Weak-area remediation plan: the two lowest-scoring dimensions, the specific drill that fixes each, and a re-test date.",
      "A criterion benchmark and a proptest suite that back the performance and testing answers with your own numbers."
    ],
    "stack": [
      "cargo",
      "criterion",
      "proptest",
      "tokio",
      "thiserror"
    ]
  },
  "lessons": [
    {
      "id": "t01",
      "title": "Ownership questions: trace the value, name the rule",
      "minutes": 60,
      "level": "core",
      "goal": "Answer ownership questions by tracing owner, borrows and drop point on the actual code, then naming the rule that decides the fix.",
      "sections": [
        {
          "h": "The three-line trace that answers most ownership questions",
          "p": [
            "Interviewers rarely ask you to define ownership. They hand you code that does not compile and watch how you read the error. The reliable method is a trace: for each binding write down who owns the value, which borrows are live, and where the value is dropped. Ninety seconds of tracing beats ten minutes of definitions because the interviewer can follow your reasoning and correct it.",
            "The trace also produces the fix. If a move happens before a later use, exactly one of three things is true: the use can move earlier, the callee can take a reference, or you clone deliberately. Saying 'clone, because the owner outlives the call and the payload is 40 bytes' is a senior answer. Cloning silently, then explaining it only when challenged, is not."
          ],
          "code": "#[derive(Debug)]\nstruct Line { sku: String, qty: u32 }\n\n#[derive(Debug)]\nstruct Order { id: u64, lines: Vec<Line> }\n\n// Takes ownership: the caller loses the order.\nfn total(order: Order) -> u64 {\n    order.lines.iter().map(|l| u64::from(l.qty)).sum()\n}\n\n// Borrows: the caller keeps the order.\nfn total_ref(order: &Order) -> u64 {\n    order.lines.iter().map(|l| u64::from(l.qty)).sum()\n}\n\nfn main() {\n    let order = Order {\n        id: 7,\n        lines: vec![Line { sku: \"A-1\".into(), qty: 2 }],\n    };\n\n    let by_value = total(order);   // order is moved here\n    // println!(\"{order:?}\");      // E0382: borrow of moved value\n\n    let by_ref = total_ref(&order); // fine, order still owned by main\n    println!(\"{by_value} {by_ref} {order:?}\");\n}",
          "tip": "Say the error code out loud. E0382 is use-after-move, E0507 is move-out-of-borrow, E0499 is two mutable borrows. Naming the class proves you have seen it before."
        },
        {
          "h": "Partial moves and the mem::take idiom",
          "p": [
            "A field can be moved out of a struct you own, but not out of a borrowed one. That is why a method taking &mut self cannot return self.lines by value: the compiler sees a hole in a borrowed place. The idiomatic repair is std::mem::take, which swaps in Default::default() and returns the original. For Vec and String it is O(1) and it keeps the field non-optional.",
            "The alternative is Option<Vec<Line>>, which makes the hole visible in the type and forces every reader to handle None. Pick the Option when the field is genuinely optional, and mem::take when the field always exists and you are handing the value off exactly once. Interviewers like this answer because it shows you know both the escape hatch and its cost."
          ],
          "code": "struct Frame { payload: Vec<u8>, seq: u64 }\n\nimpl Frame {\n    // Move the buffer out without cloning and without Option.\n    fn take_payload(&mut self) -> Vec<u8> {\n        std::mem::take(&mut self.payload)\n    }\n\n    // Or lend it, if the caller only reads.\n    fn payload(&self) -> &[u8] {\n        &self.payload\n    }\n}\n\nfn main() {\n    let mut f = Frame { payload: vec![1, 2, 3], seq: 9 };\n    let bytes = f.take_payload();\n    assert_eq!(bytes, vec![1, 2, 3]);\n    assert!(f.payload().is_empty()); // the field is still usable\n    assert_eq!(f.seq, 9);\n}"
        },
        {
          "h": "When clone is the right answer",
          "p": [
            "Clone is a design decision, not a code smell. It is correct when the value is small and Copy-like but happens to allocate, when the two owners genuinely need independent lifetimes, or when the alternative is an Arc that adds contention to a hot path. It is wrong when it hides a boundary you have not thought about, such as cloning a request body per retry attempt.",
            "A useful interview move is to price the clone out loud. A 200-byte struct cloned once per request at 10k requests per second is 2 MB/s of allocator traffic, which is fine. A 1 MB response body cloned per hop is not. Stating the arithmetic turns a style opinion into an engineering decision, which is the thing being evaluated."
          ],
          "tip": "If you cannot say why a clone is acceptable in one sentence, it is probably hiding a lifetime problem you should fix instead."
        }
      ],
      "exercise": {
        "prompt": "This struct cannot hand out its buffer by value through a borrow. Fix it twice: once with std::mem::take, once by returning a slice. Keep both compiling and say which the caller should prefer.",
        "starter": "struct Frame { payload: Vec<u8>, seq: u64 }\n\nimpl Frame {\n    fn into_payload(&mut self) -> Vec<u8> {\n        self.payload // E0507: cannot move out of borrowed content\n    }\n}\n\nfn main() {\n    let mut f = Frame { payload: vec![1, 2, 3], seq: 1 };\n    let p = f.into_payload();\n    println!(\"{p:?} {}\", f.seq);\n}",
        "hint": "mem::take swaps in Vec::default() and returns the old buffer in O(1). Returning &[u8] avoids the hand-off entirely when the caller only reads; reach for take only when ownership must actually transfer.",
        "solution": "struct Frame { payload: Vec<u8>, seq: u64 }\n\nimpl Frame {\n    fn take_payload(&mut self) -> Vec<u8> {\n        std::mem::take(&mut self.payload)\n    }\n\n    fn payload(&self) -> &[u8] {\n        &self.payload\n    }\n}\n\nfn main() {\n    let mut f = Frame { payload: vec![1, 2, 3], seq: 1 };\n\n    // Read-only caller: borrow, no allocation, no state change.\n    assert_eq!(f.payload(), &[1, 2, 3]);\n\n    // Ownership must move: take, and the frame stays valid but empty.\n    let owned = f.take_payload();\n    assert_eq!(owned, vec![1, 2, 3]);\n    assert!(f.payload().is_empty());\n    assert_eq!(f.seq, 1);\n}"
      },
      "questions": [
        {
          "q": "After `let b = a;` where `a: String`, what is the state of `a`?",
          "options": [
            "It still holds the original string and b holds a copy",
            "It is moved and cannot be used again unless reassigned",
            "It becomes an empty String automatically",
            "It is borrowed by b for the rest of the scope"
          ],
          "answer": 1,
          "explain": "String is not Copy, so the assignment moves the value. The compiler tracks the move and rejects later uses of a with E0382. Reassigning a is legal because the binding itself still exists."
        },
        {
          "q": "Which statement about moving a field out of a borrowed struct is correct?",
          "options": [
            "Any field can be moved out of &mut self as long as it is not Copy",
            "Only fields that implement Default can be moved out",
            "A field cannot be moved out of a borrowed place; use mem::take or restructure the API",
            "Moving out is allowed if the struct implements Drop"
          ],
          "answer": 2,
          "explain": "The borrow guarantees the place stays valid for its lifetime, so moving a field out would leave a hole. mem::take replaces the field with Default and returns the original, preserving the invariant."
        },
        {
          "q": "A reviewer flags `body.clone()` in a request handler. Which response is the strongest engineering answer?",
          "options": [
            "Cloning is always cheaper than an Arc, so it is fine",
            "It depends: state the size and the per-second rate, and show the alternative's cost",
            "Replace every clone with Rc<RefCell<_>> to avoid allocation",
            "Add #[inline] so the compiler removes the clone"
          ],
          "answer": 1,
          "explain": "Clone cost is a function of payload size and call rate. Pricing it (bytes times requests per second) and comparing with the alternative turns a style debate into a decision the reviewer can check."
        }
      ],
      "quickbytes": [
        "Trace owner, borrows, drop point before answering; the fix usually falls out of the trace.",
        "mem::take swaps in Default::default() and returns the original in O(1) for Vec and String.",
        "E0382 is use-after-move, E0507 is move-out-of-borrow, E0499 is two live &mut borrows.",
        "Price a clone as bytes times calls per second before defending or deleting it."
      ],
      "production": [
        "Run clippy with -W clippy::redundant_clone; it catches clones whose result is never used.",
        "Prefer &str and &[T] in function parameters so callers decide whether to allocate.",
        "Use mem::take in Drop-adjacent hand-off code to avoid Option wrappers that leak into the API.",
        "Review any clone inside a retry loop: it usually multiplies allocation by the attempt count."
      ],
      "crates": [
        "bytes",
        "smallvec"
      ],
      "github": [
        {
          "name": "tokio-rs/bytes - cheap, shareable byte buffers",
          "url": "https://github.com/tokio-rs/bytes"
        },
        {
          "name": "servo/rust-smallvec - inline storage instead of cloning",
          "url": "https://github.com/servo/rust-smallvec"
        }
      ],
      "pitfall": "Returning &str from a function that builds a String. The compiler error points at the return type, but the real bug is that the owner dies at the end of the function; return String or Cow instead.",
      "resources": [
        {
          "title": "The Rust Book: Understanding Ownership",
          "url": "https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html",
          "kind": "docs"
        },
        {
          "title": "The Rustonomicon: ownership and borrowing beyond the book",
          "url": "https://doc.rust-lang.org/nomicon/",
          "kind": "docs"
        },
        {
          "title": "rust-lang/book: the ownership chapter source",
          "url": "https://github.com/rust-lang/book",
          "kind": "repo"
        },
        {
          "title": "Jon Gjengset: Considering Rust",
          "url": "https://www.youtube.com/watch?v=DnT-LUQgc7s",
          "kind": "video"
        }
      ]
    },
    {
      "id": "t02",
      "title": "Lifetime questions: elision, 'static, and the real error",
      "minutes": 60,
      "level": "core",
      "goal": "Read a lifetime error as a constraint problem: apply elision, explain what a 'static bound actually promises, and use HRTB only when a closure needs it.",
      "sections": [
        {
          "h": "Elision is a rule, not a guess",
          "p": [
            "Lifetime elision has three rules. Each input reference gets its own lifetime. If there is exactly one input lifetime, it is assigned to every output reference. If one input is &self or &mut self, its lifetime is assigned to the output. The compiler applies these mechanically, so an error usually means the output depends on two inputs and you must say which one.",
            "When you do need a name, the signature is the documentation. `fn longest<'a>(x: &'a str, y: &'a str) -> &'a str` promises that the result lives no longer than the shorter of the two inputs. That promise is what makes the body legal and what lets the caller reason about the return value without reading the function."
          ],
          "code": "// One input lifetime: elision makes this equivalent to\n// fn first_word<'a>(s: &'a str) -> &'a str\nfn first_word(s: &str) -> &str {\n    s.split_whitespace().next().unwrap_or(\"\")\n}\n\n// Two input lifetimes: the output must name which one it borrows.\nfn longest<'a>(x: &'a str, y: &'a str) -> &'a str {\n    if x.len() >= y.len() { x } else { y }\n}\n\n// A struct that borrows must carry the lifetime parameter.\nstruct Excerpt<'a> {\n    text: &'a str,\n}\n\nimpl<'a> Excerpt<'a> {\n    fn first_line(&self) -> &'a str {\n        // Elision rule 3: the output borrows from self, but the data\n        // itself lives for 'a, so returning &'a str is legal here.\n        self.text.lines().next().unwrap_or(\"\")\n    }\n}\n\nfn main() {\n    let owned = String::from(\"alpha beta\");\n    let ex = Excerpt { text: &owned };\n    println!(\"{} {}\", first_word(&owned), ex.first_line());\n    println!(\"{}\", longest(\"ab\", \"cde\"));\n}",
          "tip": "If adding a lifetime annotation does not change what callers may do, delete it. Unnecessary annotations are noise that makes reviewers look for a constraint that is not there."
        },
        {
          "h": "What 'static actually promises",
          "p": [
            "'static on a reference means the borrow is valid for the whole program: string literals, leaked allocations, or data in a static. 'static on a type parameter means something weaker and more useful: the type contains no borrows shorter than 'static, so it can be stored or sent anywhere. A Vec<String> is 'static even though it is dropped long before the program ends.",
            "That distinction explains the classic interview follow-up. Box<dyn Error> defaults to Box<dyn Error + 'static>, which is why returning an error that borrows a local fails. The fix is to own the data, not to leak it. If someone proposes Box::leak to satisfy a 'static bound, the bound is usually wrong or the data should be owned."
          ],
          "code": "use std::borrow::Cow;\n\n// 'static here means: no borrowed data with a shorter lifetime.\nfn spawnable<T: Send + 'static>(value: T) -> T { value }\n\nfn main() {\n    // Borrowed for the whole program: a literal.\n    let s: &'static str = \"compiled into the binary\";\n\n    // 'static as a bound: owned data qualifies, no leak required.\n    let owned = spawnable(String::from(\"owned and movable\"));\n    assert_eq!(owned.len(), 16);\n\n    // Cow lets one type cover both borrowed and owned cases.\n    let borrowed: Cow<'static, str> = Cow::Borrowed(s);\n    let built: Cow<'static, str> = Cow::Owned(format!(\"{s}!\"));\n    assert!(matches!(borrowed, Cow::Borrowed(_)));\n    assert!(matches!(built, Cow::Owned(_)));\n\n    // This would not compile: the error borrows a local.\n    // fn bad() -> Box<dyn std::error::Error> {\n    //     let local = String::from(\"x\");\n    //     Err(local.parse::<u8>().unwrap_err().into())\n    // }\n}",
          "tip": "When a 'static bound appears, ask whether the value is borrowed from the program or merely owned. Nine times out of ten it is owned and no lifetime annotation is needed at all."
        },
        {
          "h": "HRTB: when a closure must work for any lifetime",
          "p": [
            "A function generic over a closure that receives a reference needs the bound to hold for every lifetime, not for one chosen by the caller. Writing `F: Fn(&'a str)` with an outer 'a is the common mistake: it pins the closure to a single lifetime. `for<'a> Fn(&'a str)` is a higher-ranked trait bound and says the closure must accept any borrow.",
            "In practice `Fn(&str)` is already sugar for the higher-ranked form, which is why most code never spells for<'a>. You meet the explicit form in library signatures, in trait objects like `dyn for<'a> Fn(&'a str)`, and when a compiler suggestion tells you to add it. Being able to explain the difference is a reliable senior signal."
          ],
          "code": "// Fn(&str) desugars to for<'a> Fn(&'a str): works with any borrow.\nfn apply_all<F>(items: &[String], f: F) -> Vec<usize>\nwhere\n    F: Fn(&str) -> usize,\n{\n    items.iter().map(|s| f(s.as_str())).collect()\n}\n\n// The explicit higher-ranked form, needed for trait objects.\nfn boxed() -> Box<dyn for<'a> Fn(&'a str) -> usize> {\n    Box::new(str::len)\n}\n\nfn main() {\n    let items = vec![String::from(\"ab\"), String::from(\"cdef\")];\n    assert_eq!(apply_all(&items, str::len), vec![2, 4]);\n\n    let f = boxed();\n    assert_eq!(f(\"hello\"), 5);\n}"
        }
      ],
      "exercise": {
        "prompt": "Write a parser struct that borrows its input, then make it usable from a function that returns it without leaking. Fix the lifetime error and explain why 'static on the struct would be wrong.",
        "starter": "struct Parser<'a> {\n    input: &'a str,\n    pos: usize,\n}\n\nimpl<'a> Parser<'a> {\n    fn new(input: &'a str) -> Self {\n        Parser { input, pos: 0 }\n    }\n\n    fn rest(&self) -> &str {\n        &self.input[self.pos..] // does this compile as written?\n    }\n}\n\nfn build() -> Parser<'static> {\n    let owned = String::from(\"1,2,3\");\n    Parser::new(&owned) // E0597: owned does not live long enough\n}",
        "hint": "The struct cannot outlive the String it borrows. Either return the Parser from a function that receives the &str, or make the struct own a String. 'static would compile only by leaking, which trades a compile error for a permanent allocation.",
        "solution": "struct Parser<'a> {\n    input: &'a str,\n    pos: usize,\n}\n\nimpl<'a> Parser<'a> {\n    fn new(input: &'a str) -> Self {\n        Parser { input, pos: 0 }\n    }\n\n    // Elision rule 3 ties this to &self, which is what we want.\n    fn rest(&self) -> &str {\n        &self.input[self.pos..]\n    }\n\n    fn next_field(&mut self) -> Option<&'a str> {\n        let start = self.pos;\n        let end = self.input[start..].find(',').map_or(self.input.len(), |i| start + i);\n        if start == end { return None; }\n        self.pos = (end + 1).min(self.input.len());\n        Some(&self.input[start..end])\n    }\n}\n\n// Borrow from a caller-owned string: no 'static, no leak.\nfn parse(input: &str) -> Vec<&str> {\n    let mut p = Parser::new(input);\n    let mut out = vec![];\n    while let Some(f) = p.next_field() { out.push(f); }\n    out\n}\n\n// Own the data when the struct must outlive the call.\nstruct OwnedParser { input: String }\n\nfn main() {\n    let owned = String::from(\"1,2,3\");\n    assert_eq!(parse(&owned), vec![\"1\", \"2\", \"3\"]);\n    let p = OwnedParser { input: owned };\n    assert_eq!(p.input.len(), 5);\n}"
      },
      "questions": [
        {
          "q": "Given `fn f(a: &str, b: &str) -> &str`, what does the compiler report?",
          "options": [
            "It compiles and ties the output to a",
            "It compiles and ties the output to the shorter of a and b",
            "It errors: elision cannot pick between two input lifetimes",
            "It compiles and returns a 'static reference"
          ],
          "answer": 2,
          "explain": "Elision assigns one lifetime per input, so the output is ambiguous when there are two inputs and no self. The fix is an explicit 'a on the inputs the output depends on."
        },
        {
          "q": "What does `T: 'static` mean for a generic type parameter?",
          "options": [
            "T is stored in static memory",
            "T contains no borrows shorter than 'static, so it can be kept indefinitely",
            "T can never be dropped",
            "T must be a reference with a program-long lifetime"
          ],
          "answer": 1,
          "explain": "The bound constrains what T may borrow, not how long the value lives. String and Vec<u8> satisfy it, and both are dropped normally."
        },
        {
          "q": "Why is `F: for<'a> Fn(&'a str)` different from `F: Fn(&'a str)` with an outer 'a?",
          "options": [
            "They are identical; the compiler normalises both",
            "The higher-ranked form requires the closure to accept any borrow; the outer 'a pins it to one lifetime",
            "The higher-ranked form only works with trait objects",
            "The outer 'a form is required for closures that return values"
          ],
          "answer": 1,
          "explain": "for<'a> quantifies inside the bound, so the closure must work for every input lifetime. Naming an outer 'a fixes a single lifetime chosen by the caller, which is rarely what a callback needs."
        }
      ],
      "quickbytes": [
        "Elision: one input lifetime goes to the output; &self wins when present.",
        "'static on a type means no short borrows inside, not immortal values.",
        "Fn(&str) is already sugar for for<'a> Fn(&'a str); spell it out only for trait objects or clarity.",
        "Never leak to satisfy a lifetime: own the data or shorten the borrow instead."
      ],
      "production": [
        "Prefer owning types in public structs; borrowing structs infect every caller with a lifetime parameter.",
        "Use Cow<'static, str> for configuration values that are sometimes literals and sometimes built.",
        "Run cargo doc and check that every lifetime parameter has a sentence explaining what it ties together.",
        "Reject Box::leak in review unless the value is genuinely process-lifetime, such as a parsed config."
      ],
      "crates": [
        "serde",
        "clap"
      ],
      "github": [
        {
          "name": "rust-lang/book - lifetimes chapter",
          "url": "https://github.com/rust-lang/book"
        },
        {
          "name": "serde-rs/serde - zero-copy deserialization with borrowed data",
          "url": "https://github.com/serde-rs/serde"
        }
      ],
      "pitfall": "Adding a lifetime parameter to a struct to fix one error, then discovering every function that touches the struct needs the same parameter. Owning the field is usually the smaller change.",
      "resources": [
        {
          "title": "The Rust Reference: lifetime elision",
          "url": "https://doc.rust-lang.org/reference/lifetime-elision.html",
          "kind": "docs"
        },
        {
          "title": "The Rustonomicon: lifetimes",
          "url": "https://doc.rust-lang.org/nomicon/lifetimes.html",
          "kind": "docs"
        },
        {
          "title": "rust-lang/book - the lifetimes chapter",
          "url": "https://github.com/rust-lang/book",
          "kind": "repo"
        },
        {
          "title": "Jon Gjengset channel: Crust of Rust, lifetimes and variance",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ]
    },
    {
      "id": "t03",
      "title": "Async questions: the future that is not Send",
      "minutes": 75,
      "level": "advanced",
      "goal": "Diagnose the two async errors interviewers plant: a !Send future held across await, and a select! branch that silently loses data.",
      "sections": [
        {
          "h": "Why spawn demands Send + 'static",
          "p": [
            "tokio::spawn hands the future to the runtime, which may resume it on a different worker thread and after the spawning stack frame is gone. That is exactly why the bound is `Future + Send + 'static`. When the compiler says the future is not Send, it is telling you a value held across an await point is not safe to move between threads.",
            "The most common culprit is a std::sync::MutexGuard. The guard is deliberately !Send, because unlocking a mutex from a different thread than the one that locked it is undefined for some implementations. Holding it across .await makes the whole future !Send. The fix is to shrink the guard's scope so it is dropped before the await, or to use tokio::sync::Mutex when the critical section genuinely must span an await."
          ],
          "code": "use std::sync::{Arc, Mutex};\nuse tokio::sync::Mutex as AsyncMutex;\n\nstruct Cache { hits: u64 }\n\n// Broken: the std guard lives across .await, so the future is !Send.\nasync fn bad(cache: Arc<Mutex<Cache>>, db: &Db) -> u64 {\n    let mut guard = cache.lock().unwrap();\n    let value = db.fetch().await; // guard still alive here\n    guard.hits += 1;\n    value\n}\n\n// Fixed: the guard is dropped before the await.\nasync fn good(cache: Arc<Mutex<Cache>>, db: &Db) -> u64 {\n    let value = db.fetch().await;\n    {\n        let mut guard = cache.lock().unwrap();\n        guard.hits += 1;\n    } // guard dropped here\n    value\n}\n\n// Alternative: an async mutex, only when the await must be inside the lock.\nasync fn held(cache: Arc<AsyncMutex<Cache>>) -> u64 {\n    let mut guard = cache.lock().await;\n    guard.hits += 1;\n    guard.hits\n}\n\nstruct Db;\nimpl Db { async fn fetch(&self) -> u64 { 1 } }\n\n#[tokio::main]\nasync fn main() {\n    let cache = Arc::new(Mutex::new(Cache { hits: 0 }));\n    let db = Db;\n    assert_eq!(good(cache.clone(), &db).await, 1);\n    assert_eq!(cache.lock().unwrap().hits, 1);\n\n    let async_cache = Arc::new(AsyncMutex::new(Cache { hits: 0 }));\n    assert_eq!(held(async_cache).await, 1);\n}",
          "tip": "The compiler points at the spawn call, not at the guard. Search the async fn for `lock()` and for `MutexGuard` before you read the rest of the error."
        },
        {
          "h": "Cancellation: select! drops the loser",
          "p": [
            "tokio::select! polls branches on the current task and, when one completes, drops the others. Dropping a future is cancellation, and it happens at the await point where the future was suspended. Whether that is safe depends entirely on the future: the tokio docs list mpsc::Receiver::recv and TcpListener::accept as cancel safe, while read_exact, read_to_end, write_all and Mutex::lock are not.",
            "The failure is quiet. A select loop that reads a framed message with read_exact and also watches a shutdown signal will lose the partially read bytes when shutdown fires mid-message. The fix is to keep the read future outside the select, or to use a codec that buffers state across polls, or to accept the loss because shutdown means the connection dies anyway and say so explicitly."
          ],
          "code": "use tokio::io::AsyncReadExt;\nuse tokio::net::TcpStream;\nuse tokio::sync::mpsc;\n\n// Not cancel safe: a dropped read_exact loses the bytes it consumed.\nasync fn lossy(mut stream: TcpStream, mut shutdown: mpsc::Receiver<()>) {\n    let mut buf = [0u8; 4];\n    loop {\n        tokio::select! {\n            r = stream.read_exact(&mut buf) => {\n                if r.is_err() { break; }\n            }\n            _ = shutdown.recv() => break,\n        }\n    }\n}\n\n// Cancel safe: recv is documented to lose nothing when dropped.\nasync fn safe(mut rx: mpsc::Receiver<Vec<u8>>, mut shutdown: mpsc::Receiver<()>) {\n    loop {\n        tokio::select! {\n            biased;\n            _ = shutdown.recv() => break,\n            msg = rx.recv() => match msg {\n                Some(bytes) => { let _ = bytes; }\n                None => break,\n            },\n        }\n    }\n}\n\n#[tokio::main]\nasync fn main() {\n    let (_tx, rx) = mpsc::channel::<Vec<u8>>(8);\n    let (sd_tx, sd_rx) = mpsc::channel::<()>(1);\n    drop(sd_tx);\n    safe(rx, sd_rx).await;\n}",
          "tip": "Add `biased;` when one branch must win, and put the shutdown branch first. Without it the choice is random and a saturated stream can starve the signal."
        },
        {
          "h": "Blocking inside async, and what it costs",
          "p": [
            "The runtime multiplexes many tasks onto a small pool of worker threads, typically one per core. A blocking call parks a worker, and every task assigned to that worker waits with it. At 8 workers, eight concurrent blocking calls remove all capacity while the process still reports idle CPU if the block is IO wait.",
            "The fix is tokio::task::spawn_blocking for file and CPU work that cannot be made async, and chunking plus yield_now for long CPU loops that must stay on the runtime. The follow-up question is always about the blocking pool: it is separate, it grows on demand up to a large cap, and it is not a place to put unbounded queueing work."
          ],
          "code": "use std::time::Duration;\nuse tokio::task;\n\n// Blocks a worker: std::fs and heavy CPU do not yield.\nasync fn bad(path: String) -> std::io::Result<usize> {\n    let meta = std::fs::metadata(&path)?;\n    Ok(meta.len() as usize)\n}\n\n// Offloads to the blocking pool and keeps the worker free.\nasync fn good(path: String) -> std::io::Result<usize> {\n    task::spawn_blocking(move || {\n        let meta = std::fs::metadata(&path)?;\n        Ok(meta.len() as usize)\n    })\n    .await\n    .expect(\"blocking task panicked\")\n}\n\n// A long CPU loop that must stay on the runtime: yield periodically.\nasync fn sum_in_chunks(data: &[u64]) -> u64 {\n    let mut total = 0;\n    for chunk in data.chunks(4096) {\n        total += chunk.iter().sum::<u64>();\n        tokio::task::yield_now().await;\n    }\n    total\n}\n\n#[tokio::main]\nasync fn main() {\n    let _ = good(\"Cargo.toml\".into()).await;\n    let data: Vec<u64> = (0..100_000).collect();\n    assert_eq!(sum_in_chunks(&data).await, data.iter().sum::<u64>());\n    tokio::time::sleep(Duration::from_millis(1)).await;\n}"
        }
      ],
      "exercise": {
        "prompt": "This handler holds a std MutexGuard across an await and is spawned with tokio::spawn, so it fails the Send bound. Fix it without changing the public signature, then explain when tokio::sync::Mutex would be the right choice instead.",
        "starter": "use std::sync::{Arc, Mutex};\n\nstruct Metrics { requests: u64 }\n\nasync fn handle(state: Arc<Mutex<Metrics>>, db: Db) -> Result<(), String> {\n    let mut m = state.lock().map_err(|_| \"poisoned\")?;\n    m.requests += 1;\n    let row = db.load().await.map_err(|e| e.to_string())?;\n    m.requests += row as u64;\n    Ok(())\n}\n\nstruct Db;\nimpl Db { async fn load(&self) -> Result<u32, std::io::Error> { Ok(1) } }\n\nfn main() {\n    let state = Arc::new(Mutex::new(Metrics { requests: 0 }));\n    tokio::spawn(handle(state, Db)); // future is not Send\n}",
        "hint": "Do the await first, then take the lock for the shortest possible window. Only reach for tokio::sync::Mutex if the critical section must include the await, for example a check-then-write that must be atomic across IO.",
        "solution": "use std::sync::{Arc, Mutex};\nuse tokio::sync::Mutex as AsyncMutex;\n\nstruct Metrics { requests: u64 }\nstruct Db;\nimpl Db { async fn load(&self) -> Result<u32, std::io::Error> { Ok(1) } }\n\n// Option A: std mutex, guard never crosses an await. Preferred for\n// short critical sections with no IO inside.\nasync fn handle(state: Arc<Mutex<Metrics>>, db: Db) -> Result<(), String> {\n    let row = db.load().await.map_err(|e| e.to_string())?;\n    {\n        let mut m = state.lock().map_err(|_| \"poisoned\".to_string())?;\n        m.requests += 1 + u64::from(row);\n    }\n    Ok(())\n}\n\n// Option B: async mutex, used only when the IO must be inside the lock.\nasync fn handle_held(state: Arc<AsyncMutex<Metrics>>, db: Db) -> Result<(), String> {\n    let mut m = state.lock().await;\n    let row = db.load().await.map_err(|e| e.to_string())?;\n    m.requests += 1 + u64::from(row);\n    Ok(())\n}\n\n#[tokio::main]\nasync fn main() {\n    let state = Arc::new(Mutex::new(Metrics { requests: 0 }));\n    handle(state.clone(), Db).await.unwrap();\n    assert_eq!(state.lock().unwrap().requests, 2);\n\n    let held = Arc::new(AsyncMutex::new(Metrics { requests: 0 }));\n    handle_held(held.clone(), Db).await.unwrap();\n    assert_eq!(held.lock().await.requests, 2);\n}"
      },
      "questions": [
        {
          "q": "Why does holding a std::sync::MutexGuard across .await make the future !Send?",
          "options": [
            "The guard borrows the mutex, and borrows cannot cross await points",
            "The guard is !Send, so a future that stores it across a suspension point cannot be moved between threads",
            "std mutexes are not usable in async code at all",
            "The guard holds a raw pointer, which is never Send"
          ],
          "answer": 1,
          "explain": "A future that holds a !Send value across an await becomes !Send itself. The guard is !Send because unlocking must happen on the locking thread for some implementations."
        },
        {
          "q": "A select! loop reads messages with read_exact and also waits on a shutdown channel. What is the bug?",
          "options": [
            "read_exact is not cancel safe, so a shutdown that wins the race loses buffered bytes",
            "shutdown channels cannot be used inside select!",
            "read_exact panics when polled twice",
            "The loop needs biased; to compile"
          ],
          "answer": 0,
          "explain": "The tokio docs list read_exact as not cancellation safe: dropping the future discards the partial read. If losing the message matters, keep the read outside the select or use a buffering codec."
        },
        {
          "q": "What is the actual cost of calling std::fs::read_to_string inside an async handler?",
          "options": [
            "It returns an error because async contexts forbid std::fs",
            "It blocks a runtime worker, so every task scheduled on that worker stalls behind it",
            "It silently spawns a blocking thread for you",
            "It is free because the runtime detects blocking calls"
          ],
          "answer": 1,
          "explain": "There is no detection. The worker thread parks in the syscall, and tasks assigned to it cannot make progress. spawn_blocking moves the work to the blocking pool instead."
        }
      ],
      "quickbytes": [
        "tokio::spawn requires Future + Send + 'static; the first error is usually a guard held across .await.",
        "read_exact, read_to_end, write_all and Mutex::lock are not cancel safe; mpsc::recv and accept are.",
        "Use tokio::sync::Mutex only when the critical section must contain an await.",
        "spawn_blocking for files and CPU; yield_now in chunks for long loops that must stay on the runtime."
      ],
      "production": [
        "Add #![deny(clippy::await_holding_lock)] so a guard across an await fails the build instead of review.",
        "Wrap every select! branch that can lose data in a comment stating whether cancellation is acceptable.",
        "Set a bounded blocking pool expectation in your capacity model; spawn_blocking queues without limit.",
        "Instrument task poll time; a worker pegged at 100% with flat throughput is the signature of a blocking call."
      ],
      "crates": [
        "tokio",
        "tokio-util",
        "futures"
      ],
      "github": [
        {
          "name": "tokio-rs/tokio - runtime, select! and cancellation docs",
          "url": "https://github.com/tokio-rs/tokio"
        },
        {
          "name": "tokio-rs/console - inspect tasks that block a worker",
          "url": "https://github.com/tokio-rs/console"
        }
      ],
      "pitfall": "Holding a std MutexGuard across .await compiles fine in a non-spawned function and only fails when the future must be Send, so the error appears far from the cause.",
      "resources": [
        {
          "title": "tokio::select! - fairness and the cancellation-safety table",
          "url": "https://docs.rs/tokio/latest/tokio/macro.select.html",
          "kind": "docs"
        },
        {
          "title": "tokio::task::spawn - the Send + 'static requirement",
          "url": "https://docs.rs/tokio/latest/tokio/task/fn.spawn.html",
          "kind": "docs"
        },
        {
          "title": "tokio::task::spawn_blocking",
          "url": "https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html",
          "kind": "docs"
        },
        {
          "title": "The Tokio tutorial",
          "url": "https://tokio.rs/tokio/tutorial",
          "kind": "docs"
        },
        {
          "title": "tokio-rs/tokio repository",
          "url": "https://github.com/tokio-rs/tokio",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "t04",
      "title": "Concurrency puzzles: publish data with the right ordering",
      "minutes": 75,
      "level": "advanced",
      "goal": "Choose an atomic ordering by naming the happens-before edge you need, then find deadlocks by lock order rather than by luck.",
      "sections": [
        {
          "h": "Relaxed counts, Release and Acquire publishes",
          "p": [
            "A counter needs no ordering, only atomicity, so Relaxed is correct and fastest. Publication is different: one thread writes data and then sets a flag, and another thread reads the flag and then the data. Without an edge between those operations the reader may see the flag before the data, because both the compiler and the CPU may reorder independent accesses.",
            "Release on the store and Acquire on the load create that edge. Release means every write before it is visible to any thread that performs an Acquire load of the same location and observes the stored value. SeqCst adds a single total order across all SeqCst operations, which is rarely needed and measurably slower on x86 and much slower on ARM. If you cannot name the edge, you probably want a mutex or a channel."
          ],
          "code": "use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};\nuse std::sync::OnceLock;\n\n// Counting: atomicity is enough, no ordering required.\nstatic REQUESTS: AtomicU64 = AtomicU64::new(0);\n\nfn count() {\n    REQUESTS.fetch_add(1, Ordering::Relaxed);\n}\n\n// Publishing: the flag must not become visible before the payload.\nstruct Slot {\n    payload: OnceLock<Vec<u8>>,\n    ready: AtomicBool,\n}\n\nimpl Slot {\n    fn new() -> Self {\n        Slot { payload: OnceLock::new(), ready: AtomicBool::new(false) }\n    }\n\n    fn publish(&self, bytes: Vec<u8>) {\n        self.payload.set(bytes).ok().expect(\"published twice\");\n        // Release: the set() above happens-before any Acquire load\n        // that observes true.\n        self.ready.store(true, Ordering::Release);\n    }\n\n    fn consume(&self) -> Option<&[u8]> {\n        if self.ready.load(Ordering::Acquire) {\n            self.payload.get().map(Vec::as_slice)\n        } else {\n            None\n        }\n    }\n}\n\nfn main() {\n    count();\n    assert_eq!(REQUESTS.load(Ordering::Relaxed), 1);\n\n    let slot = Slot::new();\n    assert!(slot.consume().is_none());\n    slot.publish(vec![1, 2, 3]);\n    assert_eq!(slot.consume(), Some(&[1u8, 2, 3][..]));\n}",
          "tip": "Ordering::Relaxed on a flag that guards data is the single most common lock-free bug. If a flag means the data is ready, the store is Release and the load is Acquire."
        },
        {
          "h": "Deadlock is a lock-order bug, not a lock-count bug",
          "p": [
            "Two threads that take the same two mutexes in opposite orders will deadlock under the right interleaving, no matter how short the critical sections are. The fix is a global order: every path that needs both locks takes A then B, and the rule is written down next to the types. try_lock with a timeout turns a hang into an error you can log and alert on.",
            "std::sync::Mutex also poisons on panic: the next lock() returns Err, and unwrap turns that into a second panic that hides the first. Decide explicitly whether your data is still valid after a panic. For counters and caches it usually is, and `unwrap_or_else(PoisonError::into_inner)` is the honest choice; for invariants that a panic may have broken, fail closed."
          ],
          "code": "use parking_lot::Mutex;\nuse std::sync::Arc;\nuse std::time::Duration;\n\nstruct Accounts { a: u64, b: u64 }\n\n// Every transfer takes the locks in address order: lower first.\nfn transfer(x: &Mutex<Accounts>, y: &Mutex<Accounts>, amount: u64) -> bool {\n    let (first, second) = if std::ptr::from_ref(x) < std::ptr::from_ref(y) {\n        (x, y)\n    } else {\n        (y, x)\n    };\n\n    // parking_lot: try_lock returns Option, not a poisoned Result.\n    let mut g1 = match first.try_lock() {\n        Some(g) => g,\n        None => return false, // contended: caller retries\n    };\n    let mut g2 = match second.try_lock_for(Duration::from_millis(50)) {\n        Some(g) => g,\n        None => return false,\n    };\n\n    g1.a += amount;\n    g2.b += amount;\n    true\n}\n\nfn main() {\n    let x = Arc::new(Mutex::new(Accounts { a: 0, b: 0 }));\n    let y = Arc::new(Mutex::new(Accounts { a: 0, b: 0 }));\n    assert!(transfer(&x, &y, 5));\n    assert_eq!(x.lock().a, 5); // parking_lot does not poison\n}",
          "tip": "try_lock_for is parking_lot, not std. std gives you try_lock plus a poisoned Result; parking_lot gives you a timeout and no poisoning, which is why it shows up in lock-ordering answers."
        },
        {
          "h": "Let loom enumerate the interleavings",
          "p": [
            "Concurrency bugs hide in interleavings you will not hit by running the test a million times. loom replaces the scheduler and the atomics, then explores the possible executions systematically. It is intrusive: the code under test must use loom types behind a cfg, so the usual pattern is a small `sync` module that re-exports either loom or std.",
            "Run it separately with RUSTFLAGS=\"--cfg loom\" and --release, because loom executes the closure thousands of times. Set LOOM_MAX_PREEMPTIONS=2 or 3 to bound the search: the loom docs note that two or three pre-emptions catch most bugs while keeping the state space tractable. A failing model prints the exact interleaving, which is the whole point."
          ],
          "code": "// tests/loom_counter.rs\n// Run: RUSTFLAGS=\"--cfg loom\" cargo test --test loom_counter --release\n#![cfg(loom)]\n\nuse loom::sync::atomic::{AtomicUsize, Ordering};\nuse loom::sync::Arc;\n\n#[test]\nfn increments_are_not_lost() {\n    loom::model(|| {\n        let counter = Arc::new(AtomicUsize::new(0));\n        let a = counter.clone();\n        let b = counter.clone();\n\n        let t1 = loom::thread::spawn(move || {\n            a.fetch_add(1, Ordering::Relaxed);\n        });\n        let t2 = loom::thread::spawn(move || {\n            b.fetch_add(1, Ordering::Relaxed);\n        });\n\n        t1.join().unwrap();\n        t2.join().unwrap();\n        assert_eq!(counter.load(Ordering::Relaxed), 2);\n    });\n}\n\n// Cargo.toml\n// [target.'cfg(loom)'.dependencies]\n// loom = \"0.7\"",
          "tip": "Bound the search: LOOM_MAX_PREEMPTIONS=3 RUSTFLAGS=\"--cfg loom\" cargo test --release. Unbounded models of real code do not finish."
        }
      ],
      "exercise": {
        "prompt": "This hand-off uses Relaxed on the flag, so the reader can observe ready == true before the payload write is visible. Fix the orderings, then add a loom model that would have caught the original bug.",
        "starter": "use std::sync::atomic::{AtomicBool, Ordering};\n\nstatic READY: AtomicBool = AtomicBool::new(false);\nstatic mut PAYLOAD: u64 = 0;\n\nfn publish(v: u64) {\n    unsafe { PAYLOAD = v };\n    READY.store(true, Ordering::Relaxed);\n}\n\nfn consume() -> Option<u64> {\n    if READY.load(Ordering::Relaxed) {\n        Some(unsafe { PAYLOAD })\n    } else {\n        None\n    }\n}\n\nfn main() {\n    publish(42);\n    assert_eq!(consume(), Some(42));\n}",
        "hint": "Release on the store and Acquire on the load, and explain the edge in one sentence. The static mut version needs unsafe; prefer OnceLock so the compiler enforces write-once.",
        "solution": "use std::sync::atomic::{AtomicBool, Ordering};\nuse std::sync::OnceLock;\n\nstruct Slot {\n    payload: OnceLock<u64>,\n    ready: AtomicBool,\n}\n\nimpl Slot {\n    fn new() -> Self {\n        Slot { payload: OnceLock::new(), ready: AtomicBool::new(false) }\n    }\n\n    fn publish(&self, v: u64) -> bool {\n        if self.payload.set(v).is_err() { return false; }\n        // Release: the payload write is visible to any thread whose\n        // Acquire load observes the stored true.\n        self.ready.store(true, Ordering::Release);\n        true\n    }\n\n    fn consume(&self) -> Option<u64> {\n        // Acquire pairs with the Release store above.\n        if self.ready.load(Ordering::Acquire) {\n            self.payload.get().copied()\n        } else {\n            None\n        }\n    }\n}\n\nfn main() {\n    let slot = Slot::new();\n    assert!(slot.consume().is_none());\n    assert!(slot.publish(42));\n    assert!(!slot.publish(43)); // write-once is enforced\n    assert_eq!(slot.consume(), Some(42));\n}\n\n// Loom model for the same protocol:\n//\n// #![cfg(loom)]\n// use loom::sync::atomic::{AtomicBool, Ordering};\n// use loom::sync::Arc;\n//\n// #[test]\n// fn reader_never_sees_data_before_flag() {\n//     loom::model(|| {\n//         let flag = Arc::new(AtomicBool::new(false));\n//         let f2 = flag.clone();\n//         let writer = loom::thread::spawn(move || {\n//             f2.store(true, Ordering::Release);\n//         });\n//         if flag.load(Ordering::Acquire) { /* payload read is valid */ }\n//         writer.join().unwrap();\n//     });\n// }"
      },
      "questions": [
        {
          "q": "Which ordering pair publishes a buffer to another thread correctly?",
          "options": [
            "Relaxed store, Relaxed load, because atomics are always coherent",
            "Release store, Acquire load, so the data write happens-before the read",
            "SeqCst store, Relaxed load, which is enough on x86",
            "Acquire store, Release load, because the load must not reorder"
          ],
          "answer": 1,
          "explain": "Release on the publishing store and Acquire on the observing load establish the happens-before edge that makes the payload visible. Relaxed gives atomicity only, and Acquire/Release are named for the operation, not the access."
        },
        {
          "q": "Two threads deadlock on two mutexes taken in opposite orders. What actually fixes it?",
          "options": [
            "Shorter critical sections",
            "A global lock order enforced at every call site, plus try_lock timeouts to surface violations",
            "Replacing both with RwLock",
            "Running the work on a single thread"
          ],
          "answer": 1,
          "explain": "Deadlock needs a cycle in the wait-for graph. A consistent order removes the cycle by construction; timeouts turn any remaining violation into an observable error instead of a hang."
        },
        {
          "q": "What does loom require that a normal stress test does not?",
          "options": [
            "Code under test must use loom's sync types, selected behind a cfg flag",
            "Tests must run on a single core",
            "All atomics must be SeqCst",
            "The test must avoid spawning threads"
          ],
          "answer": 0,
          "explain": "loom intercepts loads, stores and thread spawns, so it only sees operations that go through its replacement types. The usual pattern is a sync module that re-exports loom types under cfg(loom) and std types otherwise."
        }
      ],
      "quickbytes": [
        "Relaxed for counters, Release/Acquire for publication, SeqCst only when you need a total order.",
        "Deadlock is a lock-order cycle: pick an order, document it next to the types, enforce it in review.",
        "std Mutex poisons on panic; parking_lot does not and adds try_lock_for.",
        "RUSTFLAGS=\"--cfg loom\" cargo test --release with LOOM_MAX_PREEMPTIONS=3 for tractable models."
      ],
      "production": [
        "Write the lock order as a comment on the struct that owns the mutexes, not in a wiki nobody opens.",
        "Alert on try_lock timeout counters; a rising rate is an early deadlock or contention signal.",
        "Keep critical sections free of IO and logging so a slow disk cannot hold a lock.",
        "Run loom models in CI on the concurrency primitives only, never on the whole service."
      ],
      "crates": [
        "loom",
        "parking_lot",
        "crossbeam"
      ],
      "github": [
        {
          "name": "tokio-rs/loom - permutation testing for concurrent code",
          "url": "https://github.com/tokio-rs/loom"
        },
        {
          "name": "Amanieu/parking_lot - no-poison mutexes with timeouts",
          "url": "https://github.com/Amanieu/parking_lot"
        }
      ],
      "pitfall": "Using Ordering::Relaxed for a flag that signals data is ready. It compiles, passes on x86 most of the time, and fails on ARM or under an aggressive optimiser.",
      "resources": [
        {
          "title": "std::sync::atomic::Ordering - what each ordering guarantees",
          "url": "https://doc.rust-lang.org/std/sync/atomic/enum.Ordering.html",
          "kind": "docs"
        },
        {
          "title": "The Rustonomicon: atomics and memory ordering",
          "url": "https://doc.rust-lang.org/nomicon/atomics.html",
          "kind": "docs"
        },
        {
          "title": "loom - model checking, checkpoints and pre-emption bounds",
          "url": "https://docs.rs/loom/latest/loom/",
          "kind": "docs"
        },
        {
          "title": "tokio-rs/loom repository",
          "url": "https://github.com/tokio-rs/loom",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "t05",
      "title": "DSA drills: an LRU cache without a linked list",
      "minutes": 90,
      "level": "advanced",
      "goal": "Implement O(1) LRU in safe Rust with a slab and an index map, and state the invariants before writing a line of code.",
      "sections": [
        {
          "h": "The textbook answer fights Rust",
          "p": [
            "The classic LRU is a hash map plus a doubly linked list of nodes. In C that is twenty lines. In Rust the list needs either raw pointers and unsafe, or Rc<RefCell<Node>> with Weak back-pointers, which is slow, easy to get wrong, and produces a cache that allocates twice per insert.",
            "The interview-safe answer is a slab: keep nodes in a Vec and link them by usize index. Indices are Copy, they do not borrow, and a Vec reallocation does not invalidate them. The hash map stores key to index, and the free list recycles slots so memory is bounded by capacity. This is the same layout real caches use, and it demonstrates that you can pick a data structure that fits the language."
          ],
          "code": "use std::collections::HashMap;\n\nconst NIL: usize = usize::MAX;\n\nstruct Node<K, V> {\n    key: K,\n    value: V,\n    prev: usize,\n    next: usize,\n}\n\npub struct Lru<K, V> {\n    map: HashMap<K, usize>,\n    nodes: Vec<Option<Node<K, V>>>,\n    free: Vec<usize>,\n    head: usize, // most recently used\n    tail: usize, // least recently used\n    cap: usize,\n}\n\nimpl<K: Eq + std::hash::Hash + Clone, V> Lru<K, V> {\n    pub fn new(cap: usize) -> Self {\n        assert!(cap > 0, \"capacity must be non-zero\");\n        Lru { map: HashMap::with_capacity(cap), nodes: Vec::with_capacity(cap),\n              free: Vec::new(), head: NIL, tail: NIL, cap }\n    }\n\n    pub fn len(&self) -> usize { self.map.len() }\n    pub fn is_empty(&self) -> bool { self.map.is_empty() }\n}",
          "tip": "Say why you are not using a linked list before the interviewer asks. Choosing a layout that fits the borrow checker is the skill being tested, not memorising the C version."
        },
        {
          "h": "get and put in constant time",
          "p": [
            "Two private helpers carry the invariants. `unlink(i)` removes a node from the recency list and repairs its neighbours. `push_front(i)` inserts at the head. With those, get is a map lookup plus unlink plus push_front, and put is either an update, an insert, or an eviction of the tail followed by an insert. Every operation is O(1) expected, O(cap) space.",
            "The detail that separates a working answer from a broken one is the eviction path: you must remove the evicted key from the map, unlink the tail, and push the slot onto the free list before reusing it. Miss any one and you get either a stale map entry or a node reachable from two places, which shows up as a wrong eviction order rather than a crash."
          ],
          "code": "    fn unlink(&mut self, i: usize) {\n        let (prev, next) = {\n            let n = self.nodes[i].as_ref().expect(\"live node\");\n            (n.prev, n.next)\n        };\n        if prev == NIL { self.head = next } else {\n            self.nodes[prev].as_mut().unwrap().next = next;\n        }\n        if next == NIL { self.tail = prev } else {\n            self.nodes[next].as_mut().unwrap().prev = prev;\n        }\n    }\n\n    fn push_front(&mut self, i: usize) {\n        let old_head = self.head;\n        {\n            let n = self.nodes[i].as_mut().expect(\"live node\");\n            n.prev = NIL;\n            n.next = old_head;\n        }\n        if old_head != NIL {\n            self.nodes[old_head].as_mut().unwrap().prev = i;\n        }\n        self.head = i;\n        if self.tail == NIL { self.tail = i; }\n    }\n\n    fn alloc(&mut self, key: K, value: V) -> usize {\n        let node = Node { key, value, prev: NIL, next: NIL };\n        match self.free.pop() {\n            Some(i) => { self.nodes[i] = Some(node); i }\n            None => { self.nodes.push(Some(node)); self.nodes.len() - 1 }\n        }\n    }\n\n    pub fn get(&mut self, key: &K) -> Option<&V> {\n        let i = *self.map.get(key)?;\n        self.unlink(i);\n        self.push_front(i);\n        self.nodes[i].as_ref().map(|n| &n.value)\n    }",
          "tip": "Draw the list with head and tail on the whiteboard before coding. Half of LRU bugs are tail updates on a one-element list."
        },
        {
          "h": "Evict, then prove it with tests",
          "p": [
            "A cache is only correct if the eviction order matches the access order. Write the test first: insert three keys with capacity two, touch the oldest, insert a fourth, assert that the untouched key is the one that disappeared. That single test catches the missing map removal, the missing unlink, and a tail that points at a freed slot.",
            "The same structure extends to the follow-ups interviewers actually ask. TTL is a second map from key to expiry plus a check on get. Sharding is an array of Lru behind a hash of the key. Metrics are counters incremented in get and in the eviction branch. If you can name the extension without restructuring, you have picked the right representation."
          ],
          "code": "    pub fn put(&mut self, key: K, value: V) {\n        if let Some(&i) = self.map.get(&key) {\n            self.nodes[i].as_mut().unwrap().value = value;\n            self.unlink(i);\n            self.push_front(i);\n            return;\n        }\n        if self.map.len() == self.cap {\n            let victim = self.tail;\n            let victim_key = self.nodes[victim].as_ref().unwrap().key.clone();\n            self.unlink(victim);\n            self.map.remove(&victim_key);\n            self.nodes[victim] = None;\n            self.free.push(victim);\n        }\n        let i = self.alloc(key.clone(), value);\n        self.map.insert(key, i);\n        self.push_front(i);\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::Lru;\n\n    #[test]\n    fn evicts_least_recently_used() {\n        let mut c = Lru::new(2);\n        c.put(\"a\", 1);\n        c.put(\"b\", 2);\n        assert_eq!(c.get(&\"a\"), Some(&1)); // a is now most recent\n        c.put(\"c\", 3);                     // evicts b, not a\n        assert_eq!(c.get(&\"b\"), None);\n        assert_eq!(c.get(&\"a\"), Some(&1));\n        assert_eq!(c.get(&\"c\"), Some(&3));\n        assert_eq!(c.len(), 2);\n    }\n}"
        }
      ],
      "exercise": {
        "prompt": "Extend the slab LRU with a peek_lru() that returns the least-recently-used key without changing recency, and a resize() that shrinks capacity by evicting in order. Add a test that proves order is preserved.",
        "starter": "// Starting from the Lru in this lesson, add:\nimpl<K: Eq + std::hash::Hash + Clone, V> Lru<K, V> {\n    pub fn peek_lru(&self) -> Option<&K> {\n        todo!() // must not touch head/tail or the map\n    }\n\n    pub fn resize(&mut self, new_cap: usize) {\n        todo!() // evict from the tail until len <= new_cap\n    }\n}",
        "hint": "peek_lru reads the tail node's key through the slab and returns a shared reference; it must not call unlink or push_front. resize loops on the same eviction path put already uses, then sets self.cap.",
        "solution": "use std::collections::HashMap;\n\nconst NIL: usize = usize::MAX;\n\nstruct Node<K, V> { key: K, value: V, prev: usize, next: usize }\n\npub struct Lru<K, V> {\n    map: HashMap<K, usize>,\n    nodes: Vec<Option<Node<K, V>>>,\n    free: Vec<usize>,\n    head: usize,\n    tail: usize,\n    cap: usize,\n}\n\nimpl<K: Eq + std::hash::Hash + Clone, V> Lru<K, V> {\n    pub fn new(cap: usize) -> Self {\n        assert!(cap > 0);\n        Lru { map: HashMap::new(), nodes: Vec::new(), free: Vec::new(),\n              head: NIL, tail: NIL, cap }\n    }\n\n    fn unlink(&mut self, i: usize) {\n        let (prev, next) = { let n = self.nodes[i].as_ref().unwrap(); (n.prev, n.next) };\n        if prev == NIL { self.head = next } else { self.nodes[prev].as_mut().unwrap().next = next; }\n        if next == NIL { self.tail = prev } else { self.nodes[next].as_mut().unwrap().prev = prev; }\n    }\n\n    fn push_front(&mut self, i: usize) {\n        let old = self.head;\n        { let n = self.nodes[i].as_mut().unwrap(); n.prev = NIL; n.next = old; }\n        if old != NIL { self.nodes[old].as_mut().unwrap().prev = i; }\n        self.head = i;\n        if self.tail == NIL { self.tail = i; }\n    }\n\n    fn alloc(&mut self, key: K, value: V) -> usize {\n        let node = Node { key, value, prev: NIL, next: NIL };\n        match self.free.pop() {\n            Some(i) => { self.nodes[i] = Some(node); i }\n            None => { self.nodes.push(Some(node)); self.nodes.len() - 1 }\n        }\n    }\n\n    fn evict_one(&mut self) -> bool {\n        if self.tail == NIL { return false; }\n        let victim = self.tail;\n        let key = self.nodes[victim].as_ref().unwrap().key.clone();\n        self.unlink(victim);\n        self.map.remove(&key);\n        self.nodes[victim] = None;\n        self.free.push(victim);\n        true\n    }\n\n    pub fn get(&mut self, key: &K) -> Option<&V> {\n        let i = *self.map.get(key)?;\n        self.unlink(i);\n        self.push_front(i);\n        self.nodes[i].as_ref().map(|n| &n.value)\n    }\n\n    pub fn put(&mut self, key: K, value: V) {\n        if let Some(&i) = self.map.get(&key) {\n            self.nodes[i].as_mut().unwrap().value = value;\n            self.unlink(i);\n            self.push_front(i);\n            return;\n        }\n        while self.map.len() >= self.cap { self.evict_one(); }\n        let i = self.alloc(key.clone(), value);\n        self.map.insert(key, i);\n        self.push_front(i);\n    }\n\n    // Reads the tail without changing recency.\n    pub fn peek_lru(&self) -> Option<&K> {\n        if self.tail == NIL { return None; }\n        self.nodes[self.tail].as_ref().map(|n| &n.key)\n    }\n\n    pub fn resize(&mut self, new_cap: usize) {\n        assert!(new_cap > 0);\n        self.cap = new_cap;\n        while self.map.len() > self.cap { self.evict_one(); }\n    }\n}\n\n#[test]\nfn peek_does_not_reorder_and_resize_evicts_in_order() {\n    let mut c = Lru::new(3);\n    c.put(\"a\", 1); c.put(\"b\", 2); c.put(\"c\", 3);\n    assert_eq!(c.peek_lru(), Some(&\"a\"));\n    assert_eq!(c.peek_lru(), Some(&\"a\")); // still the LRU\n    c.resize(1);\n    assert_eq!(c.len(), 1);\n    assert_eq!(c.peek_lru(), Some(&\"c\")); // newest survives\n}"
      },
      "questions": [
        {
          "q": "Why is a slab of indices preferred over Rc<RefCell<Node>> for an LRU in Rust?",
          "options": [
            "It avoids per-node reference counting and the runtime borrow checks, and indices do not invalidate on Vec growth",
            "It is the only way to get O(1) operations",
            "RefCell cannot be used in single-threaded code",
            "It removes the need for a hash map"
          ],
          "answer": 0,
          "explain": "Indices are plain integers: no allocation per link, no RefCell borrow bookkeeping, and no aliasing problems. A Vec reallocation moves the nodes but leaves the indices valid."
        },
        {
          "q": "During eviction, which step is most often forgotten?",
          "options": [
            "Setting head to the new node",
            "Removing the evicted key from the hash map and recycling the slot",
            "Recomputing the length",
            "Clearing the node's prev pointer"
          ],
          "answer": 1,
          "explain": "A stale map entry keeps the evicted key reachable and returns a freed index on the next get. The symptom is wrong eviction order or a panic on unwrap of a None slot."
        },
        {
          "q": "What is the expected complexity of get on this structure?",
          "options": [
            "O(1) expected: one hash lookup plus constant pointer rewiring",
            "O(log n) because of the Vec",
            "O(n) because unlink scans for the node",
            "O(cap) because the free list is scanned"
          ],
          "answer": 0,
          "explain": "The map gives the node index in expected O(1), and unlink/push_front touch a constant number of fields. The Vec is only indexed, never scanned."
        }
      ],
      "quickbytes": [
        "Slab plus index map beats a linked list in Rust: no unsafe, no Rc, O(1) throughout.",
        "Write the eviction-order test before the implementation; it catches three bugs at once.",
        "Every eviction must remove the map entry, unlink the node and recycle the slot.",
        "State capacity, recency invariant and complexity out loud before typing."
      ],
      "production": [
        "Use a proven cache crate (moka, lru) in production; hand-rolled LRU is a drill, not a deliverable.",
        "Bound memory by bytes as well as by entries; a capacity of 10k large values is still an OOM.",
        "Expose hit rate and eviction count as metrics; a cache with no hit-rate signal cannot be tuned.",
        "Decide the concurrency story up front: sharded locks beat one global mutex under read-heavy load."
      ],
      "crates": [
        "hashbrown",
        "moka",
        "lru"
      ],
      "github": [
        {
          "name": "rust-lang/hashbrown - the hash map behind std",
          "url": "https://github.com/rust-lang/hashbrown"
        },
        {
          "name": "moka-rs/moka - concurrent cache with TinyLFU",
          "url": "https://github.com/moka-rs/moka"
        }
      ],
      "pitfall": "Forgetting to remove the evicted key from the map. The cache keeps returning a value for a key that is no longer in the list, and the slot is later reused by another key.",
      "resources": [
        {
          "title": "std::collections::HashMap",
          "url": "https://doc.rust-lang.org/std/collections/struct.HashMap.html",
          "kind": "docs"
        },
        {
          "title": "hashbrown - the raw table implementation",
          "url": "https://docs.rs/hashbrown/latest/hashbrown/",
          "kind": "docs"
        },
        {
          "title": "rust-lang/hashbrown repository",
          "url": "https://github.com/rust-lang/hashbrown",
          "kind": "repo"
        },
        {
          "title": "RustFest talks: data structures and systems programming",
          "url": "https://www.youtube.com/@rustfest",
          "kind": "video"
        }
      ]
    },
    {
      "id": "t06",
      "title": "System design: sizing a webhook delivery pipeline",
      "minutes": 90,
      "level": "industry",
      "goal": "Run a system design prompt from requirements to numbers to components, and defend the retry and dedup design with arithmetic instead of adjectives.",
      "sections": [
        {
          "h": "Numbers first, boxes second",
          "p": [
            "The prompt: deliver customer webhooks for a platform that emits 10k events per second at peak, with at-least-once delivery, three retries with backoff, and 24 hours of replay. Before drawing anything, convert that into storage and concurrency. At 400 bytes per event, 10k per second is 4 MB/s, about 345 GB per day before replication; three replicas make it a terabyte, which changes the retention conversation.",
            "Concurrency follows from Little's law: workers needed equals arrival rate times time in system, divided by target utilisation. At 10k per second with a 250 ms p99 delivery and 70% utilisation, that is 10_000 * 0.25 / 0.7, roughly 3,570 in-flight deliveries. Saying that number out loud, and showing the formula, is what distinguishes a design answer from a diagram."
          ],
          "code": "// Capacity arithmetic you can defend on a whiteboard.\nfn main() {\n    let peak_rps: f64 = 10_000.0;\n    let bytes_per_event: f64 = 400.0;\n    let p99_secs: f64 = 0.250;\n    let utilisation: f64 = 0.70;\n    let replicas: f64 = 3.0;\n\n    let ingest_mb_s = peak_rps * bytes_per_event / 1_000_000.0;\n    let per_day_gb = ingest_mb_s * 86_400.0 / 1_000.0;\n    let replicated_tb = per_day_gb * replicas / 1_000.0;\n\n    // Little's law: L = lambda * W, then divide by target utilisation.\n    let in_flight = peak_rps * p99_secs / utilisation;\n\n    println!(\"ingest {ingest_mb_s:.1} MB/s\");\n    println!(\"one day  {per_day_gb:.0} GB, {replicated_tb:.1} TB with {replicas} replicas\");\n    println!(\"in-flight deliveries: {in_flight:.0}\");\n\n    assert!((in_flight - 3_571.0).abs() < 2.0);\n    assert!(per_day_gb > 300.0 && per_day_gb < 400.0);\n}",
          "tip": "Round aggressively and label units. An interviewer cares that you know why the number matters, not that you can multiply four digits in your head."
        },
        {
          "h": "The pipeline and its failure modes",
          "p": [
            "Ingest authenticates the producer, assigns an event id, writes to a durable partitioned log, and returns 202 only after the write is acknowledged. Workers read a partition, resolve the destination and its secret, sign the payload, POST it with a timeout, and record the outcome. A scheduler drives retries from a persisted next_attempt_at, and a dead-letter path takes events that exhausted their budget.",
            "The two hard parts are ordering and duplication. Ordering per destination is achievable by partitioning on destination id and processing one partition per worker with bounded parallelism. Duplication is unavoidable with at-least-once, so every delivery carries an idempotency key and receivers are told to dedupe on it. Retries need jitter, otherwise a destination that comes back after an outage receives its entire backlog in one synchronised burst."
          ],
          "code": "use std::time::Duration;\n\n#[derive(Clone, Copy)]\nstruct Backoff { base: Duration, cap: Duration }\n\nimpl Backoff {\n    // Full jitter: uniform in [0, min(cap, base * 2^attempt)).\n    fn delay(&self, attempt: u32, rand: f64) -> Duration {\n        let exp = self.base.saturating_mul(1u32 << attempt.min(10));\n        let ceiling = exp.min(self.cap);\n        ceiling.mul_f64(rand.clamp(0.0, 1.0))\n    }\n}\n\nfn main() {\n    let b = Backoff { base: Duration::from_secs(1), cap: Duration::from_secs(300) };\n\n    // attempt 0..3 ceilings: 1s, 2s, 4s (jittered below each).\n    assert!(b.delay(0, 1.0) <= Duration::from_secs(1));\n    assert!(b.delay(1, 1.0) <= Duration::from_secs(2));\n    assert!(b.delay(2, 1.0) <= Duration::from_secs(4));\n\n    // The cap holds no matter how many attempts have failed.\n    assert!(b.delay(30, 1.0) <= Duration::from_secs(300));\n\n    // Total budget for 3 retries stays under 7 seconds plus jitter.\n    let total: Duration = (0..3).map(|a| b.delay(a, 1.0)).sum();\n    assert!(total <= Duration::from_secs(7));\n}",
          "tip": "Full jitter, not exponential backoff alone. The point of jitter is to spread a recovering destination's backlog across the retry window."
        },
        {
          "h": "What the interviewer is scoring",
          "p": [
            "Four things get scored: requirements clarified, capacity arithmetic, failure handling, and operability. Requirements means asking about ordering, payload size, tenant isolation and what the customer contract actually promises. Failure handling means naming the partial-write window, the poison message, and the destination that is down for an hour without letting its backlog starve other destinations.",
            "Operability is where senior candidates separate. What is the SLI: delivery latency p99, success rate per destination, retry depth? What pages a human: DLQ depth above zero for fifteen minutes, or a partition consumer lagging past five minutes. What is the rollout: shadow traffic, then 1% of destinations, then a per-tenant kill switch. Each of those is a sentence, and each one is worth more than another box on the diagram."
          ],
          "tip": "Keep a per-destination concurrency limit and a circuit breaker. One slow customer must not consume the worker pool that every other customer shares."
        }
      ],
      "exercise": {
        "prompt": "Recompute the pipeline for 25k events per second, 1 KB payloads, a 400 ms p99 and 65% target utilisation, with 7-day retention and two replicas. Write the arithmetic as code with assertions, then state which number forces a design change.",
        "starter": "fn main() {\n    let rps = 25_000.0;\n    let bytes = 1_024.0;\n    let p99 = 0.400;\n    let util = 0.65;\n    let days = 7.0;\n    let replicas = 2.0;\n\n    // TODO: ingest MB/s, retained TB, in-flight workers.\n    // TODO: assert the values you will quote.\n}",
        "hint": "MB/s = rps * bytes / 1e6. Retained TB = MB/s * 86_400 * days * replicas / 1e6. In-flight = rps * p99 / util. The retained volume is the number that usually forces tiered storage or a shorter replay window.",
        "solution": "fn main() {\n    let rps: f64 = 25_000.0;\n    let bytes: f64 = 1_024.0;\n    let p99: f64 = 0.400;\n    let util: f64 = 0.65;\n    let days: f64 = 7.0;\n    let replicas: f64 = 2.0;\n\n    let ingest_mb_s = rps * bytes / 1_000_000.0;          // 25.6 MB/s\n    let retained_gb = ingest_mb_s * 86_400.0 * days * replicas / 1_000.0;\n    let in_flight = rps * p99 / util;                     // Little's law\n\n    println!(\"ingest {ingest_mb_s:.1} MB/s\");\n    println!(\"retained {:.1} TB\", retained_gb / 1_000.0);\n    println!(\"in-flight {in_flight:.0}\");\n\n    assert!((ingest_mb_s - 25.6).abs() < 0.1);\n    // 25.6 MB/s * 86400 * 7 * 2 = ~31 TB: the design change.\n    assert!(retained_gb / 1_000.0 > 30.0);\n    assert!((in_flight - 15_385.0).abs() < 5.0);\n\n    // 15k concurrent deliveries does not fit one worker pool: shard by\n    // destination and cap per-destination concurrency. 31 TB retained\n    // forces tiered storage or a shorter replay window.\n}"
      },
      "questions": [
        {
          "q": "Why is full jitter preferred over plain exponential backoff for webhook retries?",
          "options": [
            "It guarantees the retry eventually succeeds",
            "It spreads a recovering destination's backlog across the window instead of retrying in lockstep",
            "It reduces the total number of retries",
            "It removes the need for a dead-letter queue"
          ],
          "answer": 1,
          "explain": "Without jitter, every failed delivery for a destination retries at the same offsets and re-creates the outage. Randomising the delay decorrelates the burst."
        },
        {
          "q": "At-least-once delivery means duplicates are guaranteed. What is the correct receiver contract?",
          "options": [
            "The receiver dedupes on a stable idempotency key supplied by the sender",
            "The sender retries until it receives a 200, which makes delivery exactly-once",
            "The receiver ignores duplicates because they are rare",
            "The queue removes duplicates before delivery"
          ],
          "answer": 0,
          "explain": "Exactly-once delivery is not achievable across an untrusted network. The practical answer is at-least-once plus a stable key the receiver can use to make the effect idempotent."
        },
        {
          "q": "Which signal most directly detects one destination starving the shared worker pool?",
          "options": [
            "Total events ingested per second",
            "Per-destination in-flight count and delivery latency, with a breaker tripping on sustained failure",
            "The size of the dead-letter queue alone",
            "The number of partitions in the log"
          ],
          "answer": 1,
          "explain": "Aggregate throughput hides the problem: the pool is busy, so totals look healthy while one destination consumes the capacity. Per-destination concurrency and latency expose it, and a breaker contains it."
        }
      ],
      "quickbytes": [
        "Convert requirements to MB/s, TB retained and in-flight workers before drawing components.",
        "Little's law: workers = arrival rate * time in system / target utilisation.",
        "Partition on destination id for ordering; dedupe on an idempotency key for duplicates.",
        "Full jitter on retries, a per-destination breaker, and a DLQ depth alert above zero."
      ],
      "production": [
        "Persist next_attempt_at so retries survive a worker restart; in-memory timers lose the backlog.",
        "Cap per-destination concurrency so one slow customer cannot exhaust the shared pool.",
        "Sign payloads with a rotating secret and include a timestamp to bound replay.",
        "Alert on DLQ depth and per-partition consumer lag, not on total throughput."
      ],
      "crates": [
        "axum",
        "tokio",
        "governor",
        "serde"
      ],
      "github": [
        {
          "name": "tokio-rs/axum - the ingest HTTP layer",
          "url": "https://github.com/tokio-rs/axum"
        },
        {
          "name": "boinkor-net/governor - rate limiting for per-destination caps",
          "url": "https://github.com/boinkor-net/governor"
        }
      ],
      "pitfall": "Returning 202 before the durable write is acknowledged. A crash then loses events the producer was told were accepted, and no retry can recover them.",
      "resources": [
        {
          "title": "axum - routing, extractors and shared state",
          "url": "https://docs.rs/axum/latest/axum/",
          "kind": "docs"
        },
        {
          "title": "governor - token buckets and quota semantics",
          "url": "https://docs.rs/governor/latest/governor/",
          "kind": "docs"
        },
        {
          "title": "The Tokio tutorial - shared state and channels",
          "url": "https://tokio.rs/tokio/tutorial",
          "kind": "docs"
        },
        {
          "title": "tokio-rs/axum repository",
          "url": "https://github.com/tokio-rs/axum",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "t07",
      "title": "Debugging: the task that never yields",
      "minutes": 75,
      "level": "advanced",
      "goal": "Turn a p99 latency regression into a per-task measurement, identify a blocking call on a runtime worker, and fix it without hiding the symptom.",
      "sections": [
        {
          "h": "Symptom to hypothesis in three measurements",
          "p": [
            "The scenario: after a release, p99 latency goes from 40 ms to 900 ms while throughput stays flat and CPU sits at one core, not eight. The first instinct, more load, is wrong because throughput did not move. Three measurements settle it: per-core utilisation, in-flight requests, and task poll time. One pegged core plus flat throughput points at a single task monopolising a worker.",
            "Rank hypotheses before touching code. A blocking call inside async, a lock held too long, a synchronous DNS lookup, a large JSON parse, and a log line that flushes to disk all produce the same shape. The way to distinguish them is a profile of the worker threads, not a reading of the source. Interviewers want to hear that order: measure, rank, then bisect by reverting one change at a time."
          ],
          "tip": "Say what would falsify each hypothesis. If no measurement could change your mind, you are guessing, and the interviewer can tell."
        },
        {
          "h": "tokio-console shows the busy task",
          "p": [
            "console-subscriber instruments the runtime and exposes task state over gRPC: poll count, busy time, idle time, and what a task is waiting on. It requires the tokio_unstable cfg flag, so it belongs in a debug or staging build, not in the release artefact you ship. With it, a task that accumulates 400 ms of busy time per poll is visible immediately.",
            "Read the columns carefully. High poll count with low busy time is a wakeup storm, usually a channel or timer that fires too often. Low poll count with high busy time is work that does not yield, which is the blocking-call case. A task that never appears at all is worse: it was spawned and dropped, or it is stuck in a future that nothing polls."
          ],
          "code": "# Cargo.toml\n# [dependencies]\n# tokio = { version = \"1.54\", features = [\"full\", \"tracing\"] }\n# console-subscriber = \"0.5\"\n\n# Run with the unstable cfg so the runtime emits task events:\n# RUSTFLAGS=\"--cfg tokio_unstable\" cargo run --bin server\n# Then: tokio-console http://127.0.0.1:6669\n\n#[tokio::main]\nasync fn main() {\n    console_subscriber::init(); // gRPC server on 127.0.0.1:6669\n\n    // Deliberately bad: parses a 20 MB JSON body on a worker thread.\n    let bad = tokio::spawn(async {\n        let body = std::fs::read_to_string(\"/tmp/big.json\").unwrap();\n        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();\n        parsed.as_object().map(|o| o.len()).unwrap_or(0)\n    });\n\n    let _ = bad.await;\n}",
          "tip": "Instrument in staging with the same workload shape as production. A console session on an idle process shows you nothing but idle tasks."
        },
        {
          "h": "Fix the cause, then make it stay fixed",
          "p": [
            "For file and CPU work, spawn_blocking moves the task to a separate pool sized for blocking calls. For a long loop that must stay on the runtime, chunk it and yield_now between chunks so other tasks on that worker get a turn. For genuinely parallel CPU work, rayon is a better fit than either, because it has a work-stealing pool built for it.",
            "Then prevent the regression. Add a load test to CI with a p99 budget, so a blocking call fails a gate instead of paging someone at 3 a.m. Add a tracing span around the handler so the slow phase is attributable. The interview answer is incomplete without this step: fixing the bug is table stakes, making the class of bug visible is the senior part."
          ],
          "code": "use tokio::task;\n\n// Off the runtime: file IO and JSON parsing both block.\nasync fn parse_body(path: String) -> usize {\n    task::spawn_blocking(move || {\n        let body = std::fs::read_to_string(path)?;\n        let parsed: serde_json::Value = serde_json::from_str(&body)?;\n        Ok::<usize, Box<dyn std::error::Error + Send + Sync>>(\n            parsed.as_object().map(|o| o.len()).unwrap_or(0),\n        )\n    })\n    .await\n    .expect(\"blocking task panicked\")\n    .unwrap_or(0)\n}\n\n// On the runtime, but cooperative: yields between chunks.\nasync fn checksum(data: &[u8]) -> u64 {\n    let mut acc = 0u64;\n    for chunk in data.chunks(64 * 1024) {\n        acc = acc.wrapping_add(chunk.iter().map(|b| u64::from(*b)).sum::<u64>());\n        tokio::task::yield_now().await;\n    }\n    acc\n}\n\n#[tokio::main]\nasync fn main() {\n    let n = parse_body(\"/tmp/big.json\".into()).await;\n    let sum = checksum(&vec![7u8; 1 << 20]).await;\n    println!(\"{n} {sum}\");\n}",
          "tip": "A p99 budget in CI is the only reliable defence. Blocking calls pass code review because they look like ordinary function calls."
        }
      ],
      "exercise": {
        "prompt": "A handler compiles a regex on every request and reads a config file from disk. Both block the worker. Rewrite it so the regex is compiled once and the file read is offloaded, then name the metric that would have caught the regression.",
        "starter": "use axum::{extract::Query, routing::get, Router};\nuse std::collections::HashMap;\n\nasync fn search(Query(params): Query<HashMap<String, String>>) -> String {\n    let pattern = params.get(\"q\").cloned().unwrap_or_default();\n    let re = regex::Regex::new(&pattern).unwrap();      // compiles per request\n    let config = std::fs::read_to_string(\"config.toml\").unwrap(); // blocks\n    format!(\"{} {}\", re.is_match(&config), config.len())\n}\n\n#[tokio::main]\nasync fn main() {\n    let app = Router::new().route(\"/search\", get(search));\n    let listener = tokio::net::TcpListener::bind(\"127.0.0.1:3000\").await.unwrap();\n    axum::serve(listener, app).await.unwrap();\n}",
        "hint": "Compile the regex once behind OnceLock, or take it from shared state built at startup. Move the file read to spawn_blocking, or better, read it once at startup and store the parsed config.",
        "solution": "use axum::{extract::Query, routing::get, Router};\nuse std::collections::HashMap;\nuse std::sync::OnceLock;\n\n// Compiled once for the process; the pattern must be static for this\n// to be sound, so a fixed allowlist is the realistic production shape.\nstatic EMAIL: OnceLock<regex::Regex> = OnceLock::new();\n\nfn email_re() -> &'static regex::Regex {\n    EMAIL.get_or_init(|| regex::Regex::new(r\"^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$\").unwrap())\n}\n\nasync fn search(Query(params): Query<HashMap<String, String>>) -> String {\n    let candidate = params.get(\"q\").cloned().unwrap_or_default();\n    // No compilation, no blocking IO on the worker.\n    format!(\"{}\", email_re().is_match(&candidate))\n}\n\n// Startup work belongs in main, before the listener is bound.\nfn load_config() -> String {\n    std::fs::read_to_string(\"config.toml\").unwrap_or_default()\n}\n\n#[tokio::main]\nasync fn main() {\n    let config = tokio::task::spawn_blocking(load_config)\n        .await\n        .expect(\"config task panicked\");\n    assert!(config.len() < 1_000_000);\n\n    let app = Router::new().route(\"/search\", get(search));\n    let listener = tokio::net::TcpListener::bind(\"127.0.0.1:3000\").await.unwrap();\n    axum::serve(listener, app).await.unwrap();\n}"
      },
      "questions": [
        {
          "q": "p99 latency rises 20x, throughput is flat, and exactly one core is at 100%. What is the most likely cause?",
          "options": [
            "The database is saturated",
            "One task is doing blocking or CPU-heavy work on a runtime worker",
            "The load balancer is dropping connections",
            "The channel capacity is too large"
          ],
          "answer": 1,
          "explain": "Flat throughput rules out added demand, and a single pegged core rules out a shared dependency. The shape is work that does not yield, so tasks queued on that worker stall behind it."
        },
        {
          "q": "In tokio-console, a task shows a very high poll count with low busy time. What does that suggest?",
          "options": [
            "A blocking syscall inside the task",
            "A wakeup storm from a timer or channel firing too often",
            "The task panicked and was restarted",
            "The runtime has too many worker threads"
          ],
          "answer": 1,
          "explain": "Many cheap polls mean the task is woken repeatedly and does little each time. Look for a short interval, a busy channel, or a select! that always has a ready branch."
        },
        {
          "q": "Why must console-subscriber be used with the tokio_unstable cfg flag?",
          "options": [
            "The task instrumentation APIs are still unstable and gated behind that cfg",
            "It requires nightly Rust",
            "It changes the scheduler to single-threaded",
            "It disables work stealing"
          ],
          "answer": 0,
          "explain": "The runtime emits task lifecycle events only when built with tokio_unstable. That is also why the instrumentation belongs in staging builds rather than the shipped artefact."
        }
      ],
      "quickbytes": [
        "Flat throughput plus one pegged core means work that does not yield, not added load.",
        "High poll count with low busy time is a wakeup storm; low polls with high busy time is blocking work.",
        "RUSTFLAGS=\"--cfg tokio_unstable\" plus console-subscriber in staging, never in the release build.",
        "Add a CI load test with a p99 budget; review cannot catch a blocking call by inspection."
      ],
      "production": [
        "Keep a staging build with task instrumentation so the next regression is diagnosable in minutes.",
        "Give every request handler a tracing span with a phase attribute so slow phases are attributable.",
        "Bound JSON parse size and reject oversized bodies before they reach a worker thread.",
        "Alert on p99 against an SLO, not on CPU; CPU is a cause and latency is the symptom users feel."
      ],
      "crates": [
        "tokio",
        "console-subscriber",
        "axum",
        "regex"
      ],
      "github": [
        {
          "name": "tokio-rs/console - the tokio-console client and subscriber",
          "url": "https://github.com/tokio-rs/console"
        },
        {
          "name": "tokio-rs/tokio - runtime instrumentation hooks",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "pitfall": "Diagnosing a latency regression by reading code. Blocking calls look identical to normal calls at the call site; only a per-task measurement or a thread profile separates them.",
      "resources": [
        {
          "title": "console-subscriber - setup and tokio_unstable",
          "url": "https://docs.rs/console-subscriber/latest/console_subscriber/",
          "kind": "docs"
        },
        {
          "title": "tokio::task::spawn_blocking",
          "url": "https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html",
          "kind": "docs"
        },
        {
          "title": "tokio-rs/console repository",
          "url": "https://github.com/tokio-rs/console",
          "kind": "repo"
        },
        {
          "title": "Rust conference talk archive: production debugging stories",
          "url": "https://www.youtube.com/@rustvideos",
          "kind": "video"
        }
      ]
    },
    {
      "id": "t08",
      "title": "Code review: the five findings senior reviewers name",
      "minutes": 60,
      "level": "advanced",
      "goal": "Audit a Rust diff for the five defects that actually cause incidents, and deliver each finding with a severity and a smallest-fix suggestion.",
      "sections": [
        {
          "h": "Review the contract, then the body",
          "p": [
            "A useful review order is signature, then error paths, then the happy path. Signatures tell you what the caller can do wrong: a &String parameter forces an allocation at every call site, and a public struct with public fields cannot add a field without a breaking change. Error paths tell you what happens when the world misbehaves, which is where most production defects live.",
            "In a Rust service the five findings that recur are: unwrap on anything that can fail under load, a blocking call inside async, an unbounded channel or queue, a query without a limit, and a clone that turns an O(1) hand-off into an O(n) copy. None of them are style. Each has a failure mode you can describe in one sentence, which is exactly how you should write the comment."
          ],
          "list": [
            "unwrap or expect on a lock, a parse, or a channel send in a request path",
            "std::fs, std::net::ToSocketAddrs or a large JSON parse inside async",
            "unbounded channel, unbounded Vec accumulator, or a query with no LIMIT",
            "&String, &Vec<T> and &PathBuf parameters that should be &str, &[T], &Path",
            "clone of a large payload inside a retry loop or per-connection setup"
          ],
          "tip": "If you can only leave one comment, leave the one about the failure mode you can describe concretely. Reviewers who list ten style nits get ignored."
        },
        {
          "h": "Severity, evidence, smallest fix",
          "p": [
            "Every comment gets a severity: blocker (will page someone), should-fix (will rot into a blocker), or nit (take it or leave it). Then evidence: the line, the condition that triggers it, and the consequence. Then the smallest fix that removes the risk, not a rewrite. A reviewer who rewrites the PR in comments costs more time than the bug.",
            "This structure also protects you. Saying 'this unwrap panics if the lock is poisoned, and poisoning happens when any handler panics while holding it, so one bad request turns every later request into a 500' is checkable. Saying 'unwraps are bad' is an opinion, and opinions lose arguments with authors under deadline."
          ],
          "code": "// BEFORE: five findings in twenty lines. CACHE and TEMPLATE are\n// process-wide statics defined elsewhere in the module.\nasync fn get_user(db: &sqlx::PgPool, id: String) -> String {\n    let row = sqlx::query(\"SELECT name FROM users WHERE id = $1\")\n        .bind(&id)\n        .fetch_one(db)\n        .await\n        .unwrap();                       // 1 blocker: panics on no row\n    let cache = CACHE.lock().unwrap();   // 2 blocker: poison cascades\n    let _ = cache;\n    let body = std::fs::read_to_string(\"templates/user.html\").unwrap(); // 3 blocker: blocking IO\n    let (tx, _rx) = std::sync::mpsc::channel();  // 4 should-fix: never drained\n    tx.send(row.get::<String, _>(\"name\")).unwrap();\n    body                                   // 5 should-fix: &String param above\n}\n\n// AFTER: same shape, each finding addressed.\nasync fn get_user(db: &sqlx::PgPool, id: &str) -> Result<String, AppError> {\n    let name: String = sqlx::query_scalar(\"SELECT name FROM users WHERE id = $1 LIMIT 1\")\n        .bind(id)\n        .fetch_optional(db)\n        .await?\n        .ok_or(AppError::NotFound)?;\n\n    // Poisoning is contained: the cache holds no invariant a panic breaks.\n    let cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());\n    let _ = cache;\n\n    // Template read once at startup, not per request.\n    let body = TEMPLATE.get().ok_or(AppError::NotReady)?;\n    Ok(body.replace(\"{{name}}\", &name))\n}",
          "tip": "Quote the trigger, not the rule. 'This panics when the row is missing' beats 'avoid unwrap' in every review thread."
        },
        {
          "h": "What not to comment on",
          "p": [
            "Formatting, import order, and naming that clippy or rustfmt already enforce are noise; automate them and spend the review budget on semantics. The same goes for personal preferences that the codebase has not standardised, such as iterator chains versus loops. A review that mixes blockers with preferences teaches the author to skim.",
            "Two exceptions are worth the space. A missing test for the bug being fixed is a blocker, because the fix will regress. A public API change with no changelog entry is a should-fix, because downstream users cannot discover it. Both are cheap to check and expensive to miss."
          ],
          "tip": "Run cargo clippy --all-targets -- -D warnings in CI so the review never spends a human on what a tool can decide."
        }
      ],
      "exercise": {
        "prompt": "Review this handler and produce exactly five findings, each with a severity, the triggering condition, and the smallest fix. Then state which one you would fix first and why.",
        "starter": "use std::collections::HashMap;\nuse std::sync::Mutex;\n\nstatic CACHE: Mutex<Option<HashMap<String, Vec<u8>>>> = Mutex::new(None);\n\nasync fn fetch_all(db: &sqlx::PgPool, tenant: String) -> Vec<u8> {\n    let rows = sqlx::query(\"SELECT payload FROM events WHERE tenant_id = $1\")\n        .bind(&tenant)\n        .fetch_all(db)\n        .await\n        .unwrap();\n\n    let mut out = Vec::new();\n    for r in rows {\n        let id: String = r.get(\"id\");\n        let one = sqlx::query(\"SELECT body FROM bodies WHERE id = $1\")\n            .bind(&id)\n            .fetch_one(db)\n            .await\n            .unwrap();\n        out.extend_from_slice(one.get::<Vec<u8>, _>(\"body\"));\n    }\n\n    let mut guard = CACHE.lock().unwrap();\n    *guard = Some(HashMap::new());\n    out\n}",
        "hint": "Look for: unwrap on fetch, N+1 query inside the loop, unbounded Vec accumulation, &String/tenant by value, and a global cache overwritten on every call. Rank by blast radius, not by line number.",
        "solution": "// Findings, ranked by blast radius:\n//\n// 1. BLOCKER  fetch_all().unwrap() - any DB hiccup or missing table panics\n//    the handler. Trigger: transient connection error. Fix: return Result and\n//    map sqlx::Error into AppError.\n//\n// 2. BLOCKER  N+1 query inside the loop - one round trip per row, so latency\n//    scales with tenant size. Trigger: a tenant with 50k events. Fix: join or\n//    use WHERE id = ANY($1).\n//\n// 3. SHOULD-FIX  unbounded out Vec - memory grows with tenant history.\n//    Trigger: a large tenant. Fix: stream with a cursor or paginate.\n//\n// 4. SHOULD-FIX  tenant: String by value - forces a clone per call.\n//    Fix: tenant: &str.\n//\n// 5. SHOULD-FIX  CACHE overwritten with an empty map on every call, under a\n//    global lock. Trigger: any traffic. Fix: remove it or make it a real cache\n//    keyed by tenant, and do not hold the lock across IO.\n\nuse sqlx::PgPool;\n\n#[derive(Debug)]\nenum AppError { Db(sqlx::Error) }\n\nimpl From<sqlx::Error> for AppError {\n    fn from(e: sqlx::Error) -> Self { AppError::Db(e) }\n}\n\nasync fn fetch_all(db: &PgPool, tenant: &str) -> Result<Vec<u8>, AppError> {\n    // One round trip instead of N+1, with an explicit bound.\n    let rows: Vec<(String, Vec<u8>)> = sqlx::query_as(\n        \"SELECT e.id, b.body\n           FROM events e\n           JOIN bodies b ON b.id = e.id\n          WHERE e.tenant_id = $1\n          ORDER BY e.id\n          LIMIT 10000\",\n    )\n    .bind(tenant)\n    .fetch_all(db)\n    .await?;\n\n    let mut out = Vec::with_capacity(rows.len() * 256);\n    for (_, body) in rows {\n        out.extend_from_slice(&body);\n    }\n    Ok(out)\n}"
      },
      "questions": [
        {
          "q": "Which finding is a blocker rather than a preference?",
          "options": [
            "Iterator chains used where a for loop would read better",
            "An unbounded channel fed by an external producer",
            "Import ordering that differs from the rest of the file",
            "A comment that restates the function name"
          ],
          "answer": 1,
          "explain": "An unbounded queue turns a slow consumer into an OOM kill under sustained load. The others are style and belong to rustfmt, clippy or nobody."
        },
        {
          "q": "What makes a review comment actionable?",
          "options": [
            "It cites the team style guide",
            "It names the triggering condition, the consequence, and the smallest fix",
            "It is left as a question so the author decides",
            "It links to a full rewrite in a branch"
          ],
          "answer": 1,
          "explain": "Trigger, consequence and minimal fix let the author verify the claim and act without a meeting. Questions and rewrites shift the work back onto the reviewer or the author without resolving the risk."
        },
        {
          "q": "Why is `tenant: String` in a hot path a finding worth raising?",
          "options": [
            "String is not Send, so the handler cannot be spawned",
            "It forces every caller to allocate or clone, and &str would borrow instead",
            "String cannot be used in SQL bind parameters",
            "It prevents the function from being async"
          ],
          "answer": 1,
          "explain": "Taking ownership when the callee only reads pushes a clone onto every call site. &str accepts both &String and &str through deref coercion, so it is strictly more flexible."
        }
      ],
      "quickbytes": [
        "Review order: signature, error paths, happy path.",
        "Every comment: severity, trigger, consequence, smallest fix.",
        "Blockers are unwrap in request paths, blocking IO in async, and unbounded queues.",
        "Automate formatting and lints so review time goes to semantics."
      ],
      "production": [
        "Make clippy -D warnings and rustfmt --check required CI jobs so style never reaches review.",
        "Require a regression test with every bug fix; a fix without a test is a future incident.",
        "Flag public API changes without a changelog entry as should-fix.",
        "Track review latency; a PR that waits three days costs more than most of its nits."
      ],
      "crates": [
        "clippy",
        "axum",
        "sqlx"
      ],
      "github": [
        {
          "name": "rust-lang/rust-clippy - the lints that should replace review nits",
          "url": "https://github.com/rust-lang/rust-clippy"
        },
        {
          "name": "rust-lang/api-guidelines - the contract rules behind signature comments",
          "url": "https://github.com/rust-lang/api-guidelines"
        }
      ],
      "pitfall": "Leaving twelve comments where three are blockers. The author fixes the formatting and misses the unwrap, because severity was never stated.",
      "resources": [
        {
          "title": "Clippy lint list",
          "url": "https://doc.rust-lang.org/clippy/",
          "kind": "docs"
        },
        {
          "title": "Rust API guidelines",
          "url": "https://rust-lang.github.io/api-guidelines/",
          "kind": "docs"
        },
        {
          "title": "rust-lang/rust-clippy repository",
          "url": "https://github.com/rust-lang/rust-clippy",
          "kind": "repo"
        },
        {
          "title": "EuroRust talks: API and library design",
          "url": "https://www.youtube.com/@eurorust",
          "kind": "video"
        }
      ]
    },
    {
      "id": "t09",
      "title": "Behavioural stories: quantify the incident, own the action",
      "minutes": 45,
      "level": "advanced",
      "goal": "Build four rehearsed stories with numbers and a clear first-person action, then answer the follow-up that probes what you would change.",
      "sections": [
        {
          "h": "Four stories cover most senior loops",
          "p": [
            "Almost every behavioural question maps to one of four stories: a technical disagreement you resolved, a failure you owned, a migration you drove, and a person you made more effective. Prepare one of each and you can answer conflict, failure, ambiguity, leadership and influence questions by re-angling the same material. Preparing twelve half-stories is worse than preparing four complete ones.",
            "The Rust-specific angle matters. Disagreement stories are stronger when they are about a real trade-off, such as async versus threads for a workload, or whether an unsafe block was justified by a measurable win. Migration stories are stronger with a before-and-after number: build times, allocation rate, p99, incident count. Vague enthusiasm about Rust is not evidence."
          ],
          "list": [
            "Disagreement: you argued for a design and changed someone's mind, or changed yours",
            "Failure: you shipped a bug, found it, contained it, and removed the class",
            "Migration: you moved a service or module and measured the outcome",
            "Mentoring: someone you unblocked, with what they can now do alone"
          ],
          "tip": "Rehearse each story to 90 seconds. Longer and you lose the interviewer; shorter and you have not shown the reasoning."
        },
        {
          "h": "Situation, decision, evidence, change",
          "p": [
            "The STAR frame is fine but it lets people spend two minutes on situation and ten seconds on what they did. Invert it: one sentence of context, two sentences on the decision and the alternatives you rejected, one sentence of evidence, one sentence on what you would do differently. That is a 90-second answer that contains a decision, which is the thing being assessed.",
            "Evidence is where most candidates collapse. 'It got much faster' is not evidence. 'p99 dropped from 380 ms to 90 ms after we moved the JSON parse off the runtime, measured over a week at 8k rps' is evidence, and it invites a technical follow-up you can handle. Keep three numbers per story: baseline, change, outcome."
          ],
          "code": "# stories.toml - one file, four entries, rehearsed out loud.\n[[story]]\nkind = \"disagreement\"\nhook = \"Team wanted threads; I argued for async on a 10k-connection gateway.\"\ndecision = \"Measured both: 2.1 GB RSS with threads at 10k conns vs 180 MB with tokio.\"\nalternatives_rejected = [\"thread-per-connection\", \"blocking pool with 512 workers\"]\nevidence = \"Memory per connection fell 91%; p99 unchanged at 12 ms.\"\nwhat_i_would_change = \"Benchmarked two weeks earlier instead of arguing from first principles.\"\n\n[[story]]\nkind = \"failure\"\nhook = \"A missing LIMIT on an export endpoint took the primary down.\"\ndecision = \"Killed the endpoint, added a 10k row cap, then a streaming cursor.\"\nevidence = \"MTTR 34 min; the same query now runs in 2.4 s on 1.2M rows.\"\nwhat_i_would_change = \"Added the query-count check to CI the same day, not the next sprint.\"\n\n[[story]]\nkind = \"migration\"\nhook = \"Moved the ingest path from a Python worker to Rust.\"\ndecision = \"Rewrote one stage behind a queue, shadow-compared outputs for a week.\"\nevidence = \"Throughput 4.5k to 22k events/s; CPU cost per event down 63%.\"\nwhat_i_would_change = \"Instrumented the queue depth first; we found the real bottleneck late.\"\n\n[[story]]\nkind = \"mentoring\"\nhook = \"A new hire shipped three unsound unsafe blocks in a week.\"\ndecision = \"Paired on a safe alternative, then wrote the unsafe review checklist together.\"\nevidence = \"Unsafe blocks in the crate went from 14 to 3, all with safety comments.\"\nwhat_i_would_change = \"Made the checklist a PR template item from day one.\"",
          "tip": "Write the numbers down before the interview. Recalled numbers sound approximate; written numbers sound like you were there."
        },
        {
          "h": "The follow-ups that decide the level",
          "p": [
            "After the story, expect three probes: what did you personally do, what did you get wrong, and what would you do differently. The first punishes 'we' answers. The second tests honesty under mild pressure, and refusing to name a mistake reads as low self-awareness. The third is the senior filter, because it requires a generalisation, not a confession.",
            "A good generalisation names a process change, not a personality trait. 'I now benchmark before arguing' or 'we added a query-count assertion to CI' is checkable and reusable. 'I learned to communicate better' is neither. If you can connect the story to something you now do by default, you have answered the question behind the question."
          ],
          "tip": "Never blame a colleague by name or team. Describe the disagreement as a difference in information, then show how you closed it."
        }
      ],
      "exercise": {
        "prompt": "Write your failure story as a stories.toml entry with a baseline number, the change, the outcome, and one process change you made afterwards. Then deliver it out loud in under 90 seconds.",
        "starter": "[[story]]\nkind = \"failure\"\nhook = \"\"\ndecision = \"\"\nevidence = \"\"\nwhat_i_would_change = \"\"",
        "hint": "Pick a real incident with a measurable symptom. The decision should be what you did in the first ten minutes; the evidence needs a before and after; the change must be a process you still follow.",
        "solution": "[[story]]\nkind = \"failure\"\nhook = \"A retry loop without jitter re-created an outage at 09:05 on a Monday.\"\n\ndecision = \"\"\"\nI disabled the retry storm by flipping the feature flag, then replaced the\nfixed 1s retry with full jitter and a per-destination breaker. I wrote the\nincident note while the timeline was still fresh.\n\"\"\"\n\nalternatives_rejected = [\n  \"Raising the retry budget, which would have amplified the burst\",\n  \"Turning retries off entirely, which would have dropped 40k events\",\n]\n\nevidence = \"\"\"\nBaseline: 38k retries per minute against one degraded provider, p99 14 s.\nAfter: 4.1k retries per minute, p99 180 ms, zero duplicate deliveries.\nThe breaker tripped twice in the next month and both times recovered in under 30 s.\n\"\"\"\n\nwhat_i_would_change = \"\"\"\nI now put jitter in every retry implementation and add a retry-rate panel to the\ndashboard before the feature ships, not after it pages someone.\n\"\"\""
      },
      "questions": [
        {
          "q": "What is the most common failure in a behavioural answer?",
          "options": [
            "Using the STAR structure",
            "Spending most of the time on context and almost none on the decision and evidence",
            "Naming the technologies involved",
            "Talking about a team rather than a solo project"
          ],
          "answer": 1,
          "explain": "Interviewers score the decision and its evidence. A long situation section with no decision reads as a bystander account, even when the STAR labels are present."
        },
        {
          "q": "Which evidence is strongest for a performance migration story?",
          "options": [
            "It felt much faster after the rewrite",
            "p99 fell from 380 ms to 90 ms at 8k rps over a week, with the same error rate",
            "The new code is idiomatic Rust",
            "The team preferred the new implementation"
          ],
          "answer": 1,
          "explain": "A baseline, a post-change number, a load level and a duration make the claim checkable. The others are impressions or opinions."
        },
        {
          "q": "How should you answer 'what would you do differently'?",
          "options": [
            "Say you would not change anything, since the outcome was good",
            "Name a concrete process change you now apply by default",
            "Describe a personality flaw you are working on",
            "Blame the missing monitoring from another team"
          ],
          "answer": 1,
          "explain": "The question tests generalisation. A process change is specific, reusable and verifiable; refusing the question signals low self-awareness and blaming others signals low ownership."
        }
      ],
      "quickbytes": [
        "Four stories: disagreement, failure, migration, mentoring. Rehearse each to 90 seconds.",
        "One sentence of context, two on the decision, one on evidence, one on what you would change.",
        "Keep three numbers per story: baseline, change, outcome.",
        "Replace every 'we' with what you personally did, without diminishing the team."
      ],
      "production": [
        "Keep a private story bank with numbers, reviewed before each interview loop.",
        "Write the incident timeline within 24 hours; the numbers are unrecoverable later.",
        "Convert every failure story into a process artefact you can point at.",
        "Never disclose a colleague's name or a customer's identity in a story."
      ],
      "crates": [
        "serde",
        "toml"
      ],
      "github": [
        {
          "name": "rust-lang/rfcs - how a disagreement becomes a written decision",
          "url": "https://github.com/rust-lang/rfcs"
        }
      ],
      "pitfall": "Preparing one polished story and reusing it for every question. The conflict question then gets a migration answer, and the interviewer marks down listening.",
      "resources": [
        {
          "title": "Rust RFCs: written technical disagreement in practice",
          "url": "https://github.com/rust-lang/rfcs",
          "kind": "repo"
        },
        {
          "title": "Rust conference talk archive",
          "url": "https://www.youtube.com/@rustvideos",
          "kind": "video"
        },
        {
          "title": "Rust Foundation channel: project and community talks",
          "url": "https://www.youtube.com/@RustFoundation",
          "kind": "video"
        },
        {
          "title": "The Rust Programming Language: shared vocabulary for stories",
          "url": "https://doc.rust-lang.org/book/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "t10",
      "title": "Take-home: the four-hour scope",
      "minutes": 60,
      "level": "industry",
      "goal": "Spend a four-hour take-home budget where graders actually look, and document the scope you deliberately cut.",
      "sections": [
        {
          "h": "Read the rubric before the prompt",
          "p": [
            "Take-homes are graded against a rubric you are rarely shown, but the weights are predictable: does it build and run from a clean checkout, are the core behaviours correct, are there tests that would catch a regression, is the README honest about limits, and did the candidate stay in scope. A smaller complete solution beats a larger broken one every time, because the first thing a grader does is run it.",
            "The most common self-inflicted wound is an ambitious architecture. A take-home that ships a workspace with six crates, a trait abstraction per layer, and no working binary reads as poor judgement, not as seniority. Seniority is visible in the decisions you did not make and can explain: no database because the spec did not need persistence, no Docker because the grader runs cargo run."
          ],
          "tip": "Run the exact commands in your README from a fresh clone in a temp directory. If cargo test fails there, nothing else in the submission matters."
        },
        {
          "h": "The four-hour timebox",
          "p": [
            "Twenty minutes: read the prompt twice, write the acceptance criteria as a checklist, and decide the cut line. Hundred and ten minutes: build the smallest thing that satisfies every criterion, with the happy path working end to end. Sixty minutes: tests for the behaviours you would be embarrassed to break, plus one error path. Thirty minutes: README, including how to run it, what it does, what it does not do. Twenty minutes: review your own diff and delete anything unused.",
            "The order matters. README last means it describes what you built; README first means you promised features you will not finish. Tests before the polish pass means the grader sees a working core rather than a beautiful skeleton. If you run out of time, cut the last item, never the second."
          ],
          "code": "# The repository a grader wants to see, in 20 lines of layout.\ntakehome/\n  Cargo.toml          # [package] + clap, serde, thiserror; no workspace\n  README.md           # run, test, scope, limits, next steps\n  src/\n    main.rs           # arg parsing + exit codes only\n    lib.rs            # testable core, no IO\n    dedup.rs          # the interesting logic\n  tests/\n    cli.rs            # end-to-end: run the binary, assert stdout/exit code\n  fixtures/\n    sample.log        # small, committed, deterministic\n\n# Cargo.toml\n[package]\nname = \"logdedup\"\nversion = \"0.1.0\"\nedition = \"2024\"\n\n[dependencies]\nclap = { version = \"4\", features = [\"derive\"] }\nserde = { version = \"1\", features = [\"derive\"] }\nserde_json = \"1\"\nthiserror = \"2\"\n\n# README skeleton, written at minute 200 not minute 10.\n# ## Run\n# cargo run -- --input fixtures/sample.log --window 60\n# ## Test\n# cargo test\n# ## Scope\n# Deduplicates by (source, message) within a sliding window.\n# ## Not implemented\n# No persistence, no clustering, no auth. See \"next steps\".",
          "tip": "Put the interesting logic in lib.rs behind a pure function. It makes tests fast and shows the grader you separate policy from IO."
        },
        {
          "h": "What to skip, and how to say it",
          "p": [
            "Skip authentication, metrics, Docker, CI configuration, and any UI, unless the prompt names them. Each is a day of work that demonstrates nothing the rubric rewards, and each is a surface where a broken half-implementation loses points. Skip speculative abstraction too: a trait with one implementor is a guess, not a design.",
            "Say what you skipped in the README under a heading like 'Deliberately out of scope', with one line of reasoning each. That converts a missing feature into a judgement call, which is what you want the grader to evaluate. Then add a short 'next steps' list that shows you know what production would require: persistence, backpressure, observability, and the failure modes you would test next."
          ],
          "tip": "A 'what I would do with another day' section is worth more than the feature itself, because it demonstrates the trade-off reasoning the interview is testing."
        }
      ],
      "exercise": {
        "prompt": "The prompt: build a CLI that reads a JSONL event log and prints the top 10 duplicate (source, message) pairs within a 60-second window. Write the acceptance checklist, the four-hour schedule, and the README scope section before writing any code.",
        "starter": "# acceptance.md\n- [ ] reads JSONL from a file or stdin\n- [ ] groups by (source, message) inside a 60s window\n- [ ] prints top 10 by count, ties broken deterministically\n- [ ] exit code 2 on malformed input, with line number on stderr\n- [ ] cargo test passes from a clean clone\n\n# schedule\n# 0:00-0:20  read + checklist + cut line\n# 0:20-2:10  happy path\n# ...\n",
        "hint": "The window is the only hard part. Decide whether it is a fixed tumbling window or a sliding one, write that decision down, and test the boundary at exactly 60 seconds.",
        "solution": "# acceptance.md\n- [ ] reads JSONL from a file path or stdin\n- [ ] groups by (source, message) within a sliding 60s window\n- [ ] prints top 10 by count, ties broken by first-seen timestamp then message\n- [ ] exit code 0 on success, 2 on malformed JSON with the line number on stderr\n- [ ] cargo test passes from a clean clone in under 10 seconds\n- [ ] no panics on empty input, duplicate timestamps, or out-of-order events\n\n# schedule (240 minutes)\n# 0:00-0:20   read prompt twice, write the checklist above, set the cut line\n# 0:20-1:00   parse + window data structure, unit tests for the window edges\n# 1:00-2:10   CLI wiring, output formatting, error path with line numbers\n# 2:10-3:10   integration test that runs the binary, plus a fixture with 10k lines\n# 3:10-3:40   README: run, test, scope, out-of-scope, next steps\n# 3:40-4:00   fresh-clone check, delete dead code, final read of the diff\n\n# README scope section\n## What it does\nStreams JSONL events, keeps a sliding 60-second window per (source, message)\npair, and prints the ten pairs with the most occurrences.\n\n## Deliberately out of scope\n- No persistence: the spec is a one-shot batch read, so state dies with the process.\n- No parallelism: 10k lines run in 12 ms single-threaded; adding threads would add\n  a failure mode without a measurable win.\n- No Docker or CI config: the grader runs cargo run and cargo test.\n\n## Next steps with another day\n- Bound memory with a per-pair count cap and a reservoir for long windows.\n- Add a criterion benchmark for the 1M-line case before optimising anything.\n- Replace the Vec scan with a binary heap once pairs exceed ~100k."
      },
      "questions": [
        {
          "q": "What do take-home graders check first?",
          "options": [
            "The number of design patterns used",
            "That it builds and runs from a clean checkout",
            "The commit count",
            "Whether async is used"
          ],
          "answer": 1,
          "explain": "A submission that does not run cannot be evaluated on anything else. The README commands must work from a fresh clone, which is why the last 20 minutes go to that check."
        },
        {
          "q": "Which is the strongest signal of seniority in a take-home?",
          "options": [
            "A workspace with one crate per layer",
            "A small complete solution plus a documented decision to cut scope",
            "Extensive use of traits for future extensibility",
            "A Dockerfile and a GitHub Actions matrix"
          ],
          "answer": 1,
          "explain": "Scope discipline plus explicit reasoning demonstrates judgement. Speculative structure and unrequested infrastructure add failure surface without demonstrating anything the rubric rewards."
        },
        {
          "q": "Why does a trait with a single implementor hurt a take-home?",
          "options": [
            "Traits cannot be tested",
            "It adds indirection for a variation that does not exist, and the grader reads it as guessing",
            "It prevents the code from compiling without generics",
            "It forces dynamic dispatch, which is slower"
          ],
          "answer": 1,
          "explain": "Abstraction is justified by a second implementation or a real seam for tests. One implementor is a guess about future requirements, and reviewers read guesses as a lack of confidence in the design."
        }
      ],
      "quickbytes": [
        "Twenty minutes of checklist before any code; it sets the cut line.",
        "lib.rs for pure logic, main.rs for args and exit codes; tests get fast.",
        "Write the README at minute 200, not minute 10, so it describes reality.",
        "Document what you skipped and why; a cut you can defend is a senior signal."
      ],
      "production": [
        "Verify from a fresh clone in a temp directory before submitting.",
        "Use deterministic fixtures; a take-home that fails on a different machine reads as flaky.",
        "Return meaningful exit codes and write errors to stderr, not stdout.",
        "Cap runtime on large inputs so a grader's 1M-line test does not hang the review."
      ],
      "crates": [
        "clap",
        "serde_json",
        "thiserror",
        "criterion"
      ],
      "github": [
        {
          "name": "clap-rs/clap - derive-based CLI parsing",
          "url": "https://github.com/clap-rs/clap"
        },
        {
          "name": "serde-rs/json - JSONL parsing",
          "url": "https://github.com/serde-rs/json"
        }
      ],
      "pitfall": "Building the abstraction layer first. Two hours later there is a beautiful trait hierarchy and no working command, which is the most common take-home rejection.",
      "resources": [
        {
          "title": "clap derive tutorial",
          "url": "https://docs.rs/clap/latest/clap/",
          "kind": "docs"
        },
        {
          "title": "serde_json - streaming and value parsing",
          "url": "https://docs.rs/serde_json/latest/serde_json/",
          "kind": "docs"
        },
        {
          "title": "clap-rs/clap repository",
          "url": "https://github.com/clap-rs/clap",
          "kind": "repo"
        },
        {
          "title": "criterion - the benchmark you cite in next steps",
          "url": "https://docs.rs/criterion/latest/criterion/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "t11",
      "title": "Benchmarking: why your bench beats production",
      "minutes": 75,
      "level": "industry",
      "goal": "Write a criterion benchmark that survives scrutiny, name the four ways microbenchmarks lie, and choose between a microbenchmark and a load test.",
      "sections": [
        {
          "h": "criterion 0.8: the parts that matter",
          "p": [
            "criterion runs your closure many times, discards warm-up iterations, and reports a confidence interval rather than a single number. Three details decide whether the result means anything. black_box stops the optimiser from deleting work whose result is unused. iter_batched separates setup from the measured region. Throughput turns time per iteration into elements or bytes per second, which is the number you actually report.",
            "Use std::hint::black_box, not the criterion re-export: criterion::black_box is deprecated in 0.8 and the standard library version is what the docs now use. Set sample_size when the measurement is slow, and never compare two runs from different machines or different CPU governor settings. A 5% difference between laptops is noise, and criterion will tell you so if you read the interval."
          ],
          "code": "use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};\nuse std::collections::{BTreeMap, HashMap};\nuse std::hint::black_box;\n\nfn keys(n: usize) -> Vec<u64> {\n    (0..n as u64).map(|i| i.wrapping_mul(0x9E37_79B9_7F4A_7C15)).collect()\n}\n\nfn lookup(c: &mut Criterion) {\n    let mut group = c.benchmark_group(\"lookup\");\n    group.sample_size(50);\n\n    for n in [1_000usize, 100_000] {\n        let ks = keys(n);\n        let hash: HashMap<u64, u64> = ks.iter().map(|k| (*k, *k)).collect();\n        let tree: BTreeMap<u64, u64> = ks.iter().map(|k| (*k, *k)).collect();\n\n        group.throughput(Throughput::Elements(n as u64));\n        group.bench_with_input(BenchmarkId::new(\"hashmap\", n), &ks, |b, ks| {\n            b.iter(|| {\n                let mut hits = 0u64;\n                for k in ks {\n                    if black_box(hash.get(black_box(k))).is_some() { hits += 1; }\n                }\n                hits\n            })\n        });\n        group.bench_with_input(BenchmarkId::new(\"btreemap\", n), &ks, |b, ks| {\n            b.iter(|| {\n                let mut hits = 0u64;\n                for k in ks {\n                    if black_box(tree.get(black_box(k))).is_some() { hits += 1; }\n                }\n                hits\n            })\n        });\n    }\n    group.finish();\n}\n\ncriterion_group!(benches, lookup);\ncriterion_main!(benches);\n\n// Cargo.toml\n// [dev-dependencies]\n// criterion = \"0.8\"\n//\n// [[bench]]\n// name = \"lookup\"\n// harness = false",
          "tip": "harness = false is required. Without it the built-in test harness swallows your main and criterion reports nothing."
        },
        {
          "h": "Four ways a benchmark lies",
          "p": [
            "First, dead code elimination: a result nobody reads is work the optimiser may delete, which is what black_box prevents. Second, hot data: a 10k-entry map fits in L2, so the benchmark measures cache hits rather than the production miss path. Third, timed setup: cloning the input inside the measured closure charges the clone to your algorithm, which is what iter_batched exists to fix. Fourth, wrong unit: nanoseconds per call tells you nothing about a service whose p99 includes queueing.",
            "There is a fifth that is really a specification bug: benchmarking the wrong workload. Sorting already-sorted data, hashing sequential keys, or parsing a schema you designed to be easy all produce numbers that do not transfer. The defence is to derive the input from a production sample and to state the shape in the benchmark name, so nobody quotes the number for a workload you never measured."
          ],
          "code": "use criterion::{criterion_group, criterion_main, BatchSize, Criterion};\nuse std::hint::black_box;\n\nfn parse(input: &str) -> usize {\n    input.split(',').filter(|s| !s.is_empty()).count()\n}\n\nfn parse_bench(c: &mut Criterion) {\n    // Representative input, not a hand-written ideal case.\n    let sample = \"alpha,beta,gamma,delta,epsilon,\".repeat(200);\n\n    c.bench_function(\"parse/csv/1200_fields\", |b| {\n        // Setup is outside the measured region: no clone charged to parse.\n        b.iter_batched(\n            || sample.clone(),\n            |owned| parse(black_box(&owned)),\n            BatchSize::SmallInput,\n        )\n    });\n\n    // The wrong version: clone timed inside the closure.\n    c.bench_function(\"parse/csv/with_clone\", |b| {\n        b.iter(|| parse(black_box(sample.clone().as_str())))\n    });\n}\n\ncriterion_group!(benches, parse_bench);\ncriterion_main!(benches);",
          "tip": "If two variants differ by less than about 5%, report it as a tie. Quoting a 2% win from one machine is how benchmark-driven development gets a bad name."
        },
        {
          "h": "Microbenchmark or load test",
          "p": [
            "A microbenchmark answers 'how long does this function take'. A load test answers 'what does a user experience at this rate'. They are not substitutes: a service can have fast functions and terrible p99 because of queueing, lock contention, or connection pool exhaustion. For an interview, say which question you are answering before you quote a number.",
            "For load tests, report p50, p95 and p99 with the rate and the concurrency, and say whether the client was the bottleneck. A closed-loop client with 50 workers measures latency at concurrency 50, not capacity. For capacity, hold a target rate with an open-loop generator and watch error rate and queue depth as you climb. The two numbers, latency at a fixed rate and maximum sustainable rate, are what a design review needs."
          ],
          "tip": "Quote the environment with every number: CPU model, core count, Rust version, and whether it was release mode. A debug-build benchmark is off by 10x to 50x."
        }
      ],
      "exercise": {
        "prompt": "Write a criterion benchmark that compares Vec::contains against HashSet::contains for 10k lookups over 1k elements, with setup excluded and throughput reported. Then state which result would not transfer to production and why.",
        "starter": "use criterion::{criterion_group, criterion_main, Criterion};\n\nfn bench(c: &mut Criterion) {\n    // TODO: build the data outside the closure\n    // TODO: use black_box so the result is not optimised away\n    // TODO: set Throughput::Elements and read elements/second\n}\n\ncriterion_group!(benches, bench);\ncriterion_main!(benches);",
        "hint": "1k u64 elements fit in L1/L2, so the Vec scan will look far better than it does on a 1M-element set in production. Say that out loud: the benchmark measures the hot-cache case.",
        "solution": "use criterion::{criterion_group, criterion_main, Criterion, Throughput};\nuse std::collections::HashSet;\nuse std::hint::black_box;\n\nfn bench(c: &mut Criterion) {\n    let n = 1_000usize;\n    let data: Vec<u64> = (0..n as u64).map(|i| i.wrapping_mul(0x9E37_79B9)).collect();\n    let set: HashSet<u64> = data.iter().copied().collect();\n    let probes: Vec<u64> = (0..10_000u64).map(|i| i.wrapping_mul(31)).collect();\n\n    let mut g = c.benchmark_group(\"contains\");\n    g.throughput(Throughput::Elements(probes.len() as u64));\n\n    g.bench_function(\"vec_scan_1k\", |b| {\n        b.iter(|| {\n            let mut hits = 0usize;\n            for p in &probes {\n                if black_box(data.contains(black_box(p))) { hits += 1; }\n            }\n            hits\n        })\n    });\n\n    g.bench_function(\"hashset_1k\", |b| {\n        b.iter(|| {\n            let mut hits = 0usize;\n            for p in &probes {\n                if black_box(set.contains(black_box(p))) { hits += 1; }\n            }\n            hits\n        })\n    });\n\n    g.finish();\n}\n\ncriterion_group!(benches, bench);\ncriterion_main!(benches);\n\n// Reading the output: criterion reports time per batch and, because\n// Throughput is set, elements per second. The Vec scan wins here because\n// 1k u64 (8 KB) fits in L1. At 1M elements (8 MB) the scan becomes\n// memory-bound and the hash set wins by an order of magnitude. Quote the\n// size with the result or the number is meaningless."
      },
      "questions": [
        {
          "q": "Why is std::hint::black_box needed in a criterion benchmark?",
          "options": [
            "It pins the thread to one core for stable timing",
            "It hides the value from the optimiser so the computation is not eliminated or hoisted",
            "It flushes the CPU cache between iterations",
            "It disables the test harness"
          ],
          "answer": 1,
          "explain": "Without an opaque use, LLVM may delete a pure computation whose result is discarded, so you measure an empty loop. black_box forces the value to be materialised."
        },
        {
          "q": "A benchmark clones its input inside the measured closure. What is the consequence?",
          "options": [
            "The clone is optimised away automatically",
            "The clone's cost is charged to the algorithm, inflating the result",
            "criterion detects and subtracts it",
            "The benchmark fails to compile"
          ],
          "answer": 1,
          "explain": "Everything inside the closure is measured. iter_batched moves setup outside the timed region; otherwise you are benchmarking the allocator as much as the code."
        },
        {
          "q": "What does a closed-loop load test with 50 workers actually measure?",
          "options": [
            "Maximum sustainable throughput",
            "Latency at concurrency 50, not capacity",
            "The p99 of a single request in isolation",
            "The database's query throughput"
          ],
          "answer": 1,
          "explain": "Closed-loop clients wait for each response, so the offered rate is whatever the system can absorb at that concurrency. Capacity needs an open-loop generator at a target rate."
        }
      ],
      "quickbytes": [
        "criterion = \"0.8\" with harness = false, or your bench main never runs.",
        "std::hint::black_box on inputs and outputs; criterion::black_box is deprecated.",
        "iter_batched keeps setup out of the measured region.",
        "Report p50/p95/p99 with rate and concurrency; a mean hides the queueing."
      ],
      "production": [
        "Store benchmark baselines in CI and fail on a regression above a stated threshold.",
        "Pin the CPU governor and disable turbo for comparable runs, or accept 5-10% noise.",
        "Benchmark in release mode with the same feature flags as production.",
        "Keep a load-test scenario per critical endpoint; microbenchmarks cannot see queueing."
      ],
      "crates": [
        "criterion",
        "hyperfine"
      ],
      "github": [
        {
          "name": "criterion-rs/criterion.rs - statistical microbenchmarks",
          "url": "https://github.com/criterion-rs/criterion.rs"
        },
        {
          "name": "sharkdp/hyperfine - wall-clock CLI benchmarks",
          "url": "https://github.com/sharkdp/hyperfine"
        }
      ],
      "pitfall": "Benchmarking with a debug build or with the input cloned inside the timed closure. Both produce numbers that are wrong by an order of magnitude in opposite directions.",
      "resources": [
        {
          "title": "criterion 0.8: measurement and analysis",
          "url": "https://docs.rs/criterion/latest/criterion/",
          "kind": "docs"
        },
        {
          "title": "criterion::Bencher - iter, iter_batched, iter_custom",
          "url": "https://docs.rs/criterion/latest/criterion/struct.Bencher.html",
          "kind": "docs"
        },
        {
          "title": "std::hint::black_box",
          "url": "https://doc.rust-lang.org/std/hint/fn.black_box.html",
          "kind": "docs"
        },
        {
          "title": "criterion-rs/criterion.rs repository",
          "url": "https://github.com/criterion-rs/criterion.rs",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "t12",
      "title": "Error handling: the library boundary rule",
      "minutes": 60,
      "level": "advanced",
      "goal": "Split typed library errors from opaque application errors, encode retryability in the type, and preserve the source chain through every conversion.",
      "sections": [
        {
          "h": "thiserror inside, anyhow at the edge",
          "p": [
            "A library that returns anyhow::Error forces every caller to downcast to learn what happened. A library that returns a thiserror enum lets callers match on variants, and the compiler enforces that they handle new ones unless the enum is non_exhaustive. The rule is: typed errors for anything a caller may branch on, opaque errors for the top of the program where the only action is log and exit.",
            "The boundary is usually a binary's main, an HTTP handler, or a job runner. There, anyhow with context is the right tool: it captures a chain of messages, prints a readable cause chain, and costs the caller nothing because nobody matches on it. Mixing the two is fine and common: the enum converts into anyhow at the edge with a From impl that thiserror generates for you."
          ],
          "code": "use thiserror::Error;\n\n#[derive(Debug, Error)]\n#[non_exhaustive]\npub enum StoreError {\n    #[error(\"order {id} not found\")]\n    NotFound { id: u64 },\n\n    #[error(\"version conflict: expected {expected}, found {found}\")]\n    Conflict { expected: u64, found: u64 },\n\n    #[error(\"storage unavailable\")]\n    Unavailable(#[source] sqlx::Error),\n\n    #[error(\"invariant broken: {0}\")]\n    Corrupt(String),\n}\n\nimpl StoreError {\n    /// Only these may be retried by the caller without a code change.\n    pub fn retryable(&self) -> bool {\n        matches!(self, StoreError::Unavailable(_) | StoreError::Conflict { .. })\n    }\n}\n\n// At the edge: anyhow, with context the operator can act on.\nuse anyhow::Context;\n\npub async fn load_order(pool: &sqlx::PgPool, id: u64) -> anyhow::Result<()> {\n    let row: Option<(u64,)> = sqlx::query_as(\"SELECT version FROM orders WHERE id = $1\")\n        .bind(id as i64)\n        .fetch_optional(pool)\n        .await\n        .context(\"querying order version\")?;\n\n    let (version,) = row.with_context(|| format!(\"order {id} not found\"))?;\n    println!(\"order {id} at version {version}\");\n    Ok(())\n}",
          "tip": "#[non_exhaustive] on the public enum is what lets you add a variant in a minor release without breaking downstream matches."
        },
        {
          "h": "Put retryability in the type, not in a string",
          "p": [
            "The worst error-handling pattern in production Rust is matching on message text. A log line changes, a driver rewords an error, and retry logic silently starts retrying a permanent failure. Encode the decision as a method on the enum, and write the mapping once where the variant is created. Then a retry wrapper can call err.retryable() without knowing anything about the database.",
            "Classify by cause, not by severity. NotFound, InvalidInput and PermissionDenied are permanent. Unavailable, DeadlineExceeded and Conflict are transient, where Conflict means the caller should re-read and retry. Everything else defaults to permanent, because retrying an unknown failure multiplies the damage. The default direction matters: unknown means do not retry."
          ],
          "code": "use std::time::Duration;\n\n#[derive(Debug, Clone, Copy, PartialEq, Eq)]\npub enum Disposition { Retry, ReRead, Fail }\n\npub trait Classify { fn disposition(&self) -> Disposition; }\n\nimpl Classify for StoreError {\n    fn disposition(&self) -> Disposition {\n        match self {\n            StoreError::Unavailable(_) => Disposition::Retry,\n            StoreError::Conflict { .. } => Disposition::ReRead,\n            _ => Disposition::Fail,\n        }\n    }\n}\n\npub async fn with_retry<T, F, Fut>(mut op: F, attempts: u32) -> Result<T, StoreError>\nwhere\n    F: FnMut() -> Fut,\n    Fut: std::future::Future<Output = Result<T, StoreError>>,\n{\n    let mut last = None;\n    for attempt in 0..attempts {\n        match op().await {\n            Ok(v) => return Ok(v),\n            Err(e) => {\n                let d = e.disposition();\n                if d == Disposition::Fail { return Err(e); }\n                last = Some(e);\n                if attempt + 1 < attempts {\n                    tokio::time::sleep(Duration::from_millis(50 * 2u64.pow(attempt))).await;\n                }\n            }\n        }\n    }\n    Err(last.expect(\"loop ran at least once\"))\n}",
          "tip": "Log the disposition once at the retry site, not inside every operation. Duplicated logging is how a transient blip becomes 40k log lines."
        },
        {
          "h": "Keep the chain, keep the context",
          "p": [
            "Every conversion that drops the source is a debugging session you will pay for later. thiserror's #[source] and #[from] preserve it, and #[error(transparent)] forwards both Display and source for wrapper types. At the edge, anyhow's .context() adds a layer without losing the cause, and the default Debug output prints the whole chain.",
            "One anti-pattern to name in an interview: mapping every error to a String. It compiles, it reads fine, and it destroys the type information a caller needs to decide whether to retry. The second anti-pattern is logging an error at every layer as it propagates, which produces five log lines for one failure and hides where it originated. Log once, at the boundary that decides."
          ],
          "code": "use std::io;\n\n#[derive(Debug, thiserror::Error)]\npub enum ConfigError {\n    #[error(\"cannot read {path}\")]\n    Read {\n        path: String,\n        #[source]\n        source: io::Error,\n    },\n\n    #[error(\"invalid toml\")]\n    Parse(#[from] toml::de::Error),\n}\n\nfn load(path: &str) -> Result<(), ConfigError> {\n    let text = std::fs::read_to_string(path)\n        .map_err(|source| ConfigError::Read { path: path.into(), source })?;\n    let _value: toml::Value = toml::from_str(&text)?; // uses #[from]\n    Ok(())\n}\n\nfn main() -> anyhow::Result<()> {\n    load(\"config.toml\").map_err(|e| {\n        // Print the full chain once, at the edge.\n        eprintln!(\"{e}\");\n        let mut src = std::error::Error::source(&e);\n        while let Some(s) = src {\n            eprintln!(\"  caused by: {s}\");\n            src = s.source();\n        }\n        e\n    })?;\n    Ok(())\n}"
        }
      ],
      "exercise": {
        "prompt": "Refactor this stringly-typed error into a thiserror enum with a retryable classification, keep the source chain, and convert it to anyhow at main without losing the cause.",
        "starter": "fn fetch(url: &str) -> Result<Vec<u8>, String> {\n    let body = std::fs::read(url).map_err(|e| format!(\"read failed: {e}\"))?;\n    if body.is_empty() {\n        return Err(\"empty body\".to_string());\n    }\n    Ok(body)\n}\n\nfn main() {\n    match fetch(\"data.bin\") {\n        Ok(b) => println!(\"{}\", b.len()),\n        Err(e) => eprintln!(\"error: {e}\"),\n    }\n}",
        "hint": "Two variants: Io with #[source], and Empty with no source. Add fn retryable(&self) -> bool returning true only for Io. At main, use anyhow::Result and .context() so the cause chain prints.",
        "solution": "use anyhow::Context;\nuse thiserror::Error;\n\n#[derive(Debug, Error)]\npub enum FetchError {\n    #[error(\"reading {path}\")]\n    Io {\n        path: String,\n        #[source]\n        source: std::io::Error,\n    },\n\n    #[error(\"empty body from {path}\")]\n    Empty { path: String },\n}\n\nimpl FetchError {\n    pub fn retryable(&self) -> bool {\n        // Empty is permanent: the resource exists but has no content.\n        matches!(self, FetchError::Io { .. })\n    }\n}\n\nfn fetch(path: &str) -> Result<Vec<u8>, FetchError> {\n    let body = std::fs::read(path)\n        .map_err(|source| FetchError::Io { path: path.to_string(), source })?;\n    if body.is_empty() {\n        return Err(FetchError::Empty { path: path.to_string() });\n    }\n    Ok(body)\n}\n\nfn main() -> anyhow::Result<()> {\n    let body = fetch(\"data.bin\").with_context(|| \"loading data.bin for startup\")?;\n    println!(\"{}\", body.len());\n    Ok(())\n}\n\n// The anyhow Debug output keeps the chain:\n// Error: loading data.bin for startup\n// Caused by:\n//     0: reading data.bin\n//     1: No such file or directory (os error 2)"
      },
      "questions": [
        {
          "q": "When should a library return a thiserror enum instead of anyhow::Error?",
          "options": [
            "Always, because anyhow is only for tests",
            "When callers need to branch on the failure kind, such as retry versus fail",
            "When the error is only logged",
            "When the library has fewer than three error cases"
          ],
          "answer": 1,
          "explain": "Typed errors exist so callers can match. anyhow is the better choice when the only consumer is a boundary that logs and exits, because downcasting is fragile and verbose."
        },
        {
          "q": "Why is matching on error message text for retry decisions dangerous?",
          "options": [
            "It is slower than matching an enum",
            "Messages change between versions and drivers, so retry behaviour silently changes with them",
            "It cannot be done in Rust without regex",
            "It always retries permanent failures"
          ],
          "answer": 1,
          "explain": "Text is not a contract. A reworded message or a new driver version flips the decision without a compile error, which is exactly the class of bug that pages someone at night."
        },
        {
          "q": "What does #[error(transparent)] do?",
          "options": [
            "Hides the error from logs",
            "Forwards Display and source to the inner error, useful for opaque public wrappers",
            "Converts any error into anyhow::Error",
            "Marks the variant as deprecated"
          ],
          "answer": 1,
          "explain": "Transparent keeps the representation private while the public type delegates formatting and source, so the inner enum can change without a breaking change."
        }
      ],
      "quickbytes": [
        "Typed errors for callers that branch; anyhow for mains, handlers and job runners.",
        "Put retryability in a method on the enum; never match on message text.",
        "Unknown failures default to non-retryable; retrying the unknown multiplies damage.",
        "Log once at the boundary, with the full source chain, not at every layer."
      ],
      "production": [
        "Mark public error enums #[non_exhaustive] so new variants are a minor release.",
        "Attach a stable error code to each variant for dashboards and client contracts.",
        "Never include secrets, tokens or full URLs in Display output.",
        "Add a test per variant that asserts both the Display text and the source chain."
      ],
      "crates": [
        "thiserror",
        "anyhow",
        "sqlx"
      ],
      "github": [
        {
          "name": "dtolnay/thiserror - derive(Error) with source chains",
          "url": "https://github.com/dtolnay/thiserror"
        },
        {
          "name": "dtolnay/anyhow - context at the application edge",
          "url": "https://github.com/dtolnay/anyhow"
        }
      ],
      "pitfall": "Mapping every error to String to satisfy a single return type. It compiles, and it destroys the information a caller needs to decide whether to retry.",
      "resources": [
        {
          "title": "thiserror - #[from], #[source] and transparent",
          "url": "https://docs.rs/thiserror/latest/thiserror/",
          "kind": "docs"
        },
        {
          "title": "anyhow - context, downcasting and the cause chain",
          "url": "https://docs.rs/anyhow/latest/anyhow/",
          "kind": "docs"
        },
        {
          "title": "dtolnay/thiserror repository",
          "url": "https://github.com/dtolnay/thiserror",
          "kind": "repo"
        },
        {
          "title": "The Rust Book: error handling",
          "url": "https://doc.rust-lang.org/book/ch09-00-error-handling.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "t13",
      "title": "API design: what actually counts as breaking",
      "minutes": 60,
      "level": "industry",
      "goal": "Classify API changes against semver by asking what a downstream crate can no longer compile, then design a surface that can grow.",
      "sections": [
        {
          "h": "The semver test: does downstream code stop compiling",
          "p": [
            "A change is breaking if existing correct downstream code fails to compile or changes behaviour. Adding a variant to a public enum breaks exhaustive matches, which is why public enums should be #[non_exhaustive]. Adding a required method to a public trait breaks every implementor, so either give it a default or ship a new trait. Adding a field to a public struct breaks struct literals unless the struct is non_exhaustive too.",
            "The subtle ones are worth memorising. Changing a generic bound to be stricter is breaking even though the signature looks similar. Changing a return type from T to impl Trait is breaking for anyone who named the type. Removing a public item is obviously breaking, but so is adding a variant to an error enum, which is why the non_exhaustive attribute exists. Cargo's semver reference lists the full set."
          ],
          "list": [
            "Breaking: new enum variant without non_exhaustive, new trait method without a default",
            "Breaking: stricter generic bounds, changed return type, removed or renamed public item",
            "Non-breaking: new free function, new inherent method, new impl of an existing trait",
            "Non-breaking: new field on a non_exhaustive struct, new variant on a non_exhaustive enum"
          ],
          "tip": "When in doubt, ask whether a downstream exhaustive match or struct literal would still compile. If not, it is a major version."
        },
        {
          "h": "Design the surface for the caller",
          "p": [
            "Take the most general borrowed type in arguments and the most specific owned type in returns. &str accepts &String and &str; &[T] accepts &Vec<T>, &[T] and arrays; impl AsRef<Path> accepts both paths and strings. Returning String rather than &str avoids forcing a lifetime on the caller. The Rust API guidelines call this flexibility in, specificity out, and it is the single highest-yield review rule.",
            "For optional configuration, a builder beats a fifteen-argument constructor, and a builder with consuming self (fn timeout(mut self, d: Duration) -> Self) chains without borrow headaches. For extension points, a sealed trait lets you add methods later without breaking implementors, at the cost of preventing downstream implementations. Say that trade-off out loud in an interview: sealing is a commitment to your own roadmap."
          ],
          "code": "pub mod limits {\n    // Sealed: downstream cannot implement, so we can add methods later.\n    mod private { pub trait Sealed {} }\n\n    pub trait Policy: private::Sealed {\n        fn allow(&self, cost: u32) -> bool;\n    }\n\n    pub struct TokenBucket { pub tokens: u32 }\n\n    impl private::Sealed for TokenBucket {}\n\n    impl Policy for TokenBucket {\n        fn allow(&self, cost: u32) -> bool { self.tokens >= cost }\n    }\n}\n\n// Flexible in, specific out.\npub fn join_paths(base: impl AsRef<std::path::Path>, name: &str) -> String {\n    base.as_ref().join(name).to_string_lossy().into_owned()\n}\n\n#[derive(Debug, Clone)]\n#[non_exhaustive]\npub struct ClientConfig {\n    pub timeout_ms: u64,\n    pub retries: u32,\n}\n\nimpl Default for ClientConfig {\n    fn default() -> Self { Self { timeout_ms: 1_000, retries: 2 } }\n}\n\npub struct ClientBuilder(ClientConfig);\n\nimpl ClientBuilder {\n    pub fn new() -> Self { Self(ClientConfig::default()) }\n    pub fn timeout_ms(mut self, ms: u64) -> Self { self.0.timeout_ms = ms; self }\n    pub fn retries(mut self, n: u32) -> Self { self.0.retries = n; self }\n    pub fn build(self) -> ClientConfig { self.0 }\n}\n\nfn main() {\n    let cfg = ClientBuilder::new().timeout_ms(250).retries(0).build();\n    assert_eq!(cfg.timeout_ms, 250);\n    assert!(join_paths(\"/tmp\", \"x\").ends_with(\"x\"));\n}",
          "tip": "A public struct with public fields cannot add a field without a major release. Make it non_exhaustive or keep the fields private behind accessors."
        },
        {
          "h": "Deprecate, don't delete",
          "p": [
            "Removing a function in a minor release is a supply-chain incident for someone. Mark it #[deprecated(since = \"1.4.0\", note = \"use Client::connect_with\")], keep it working, and let the note carry the migration. The compiler then delivers your migration guide at the exact call site, which no changelog can match.",
            "Two release-discipline habits make this survivable. First, keep a changelog entry per user-visible change, including behaviour changes that do not alter signatures. Second, test the public API as a downstream crate would: a small `tests/public_api.rs` that imports only public items catches accidental breakage that unit tests inside the module cannot see."
          ],
          "code": "/// Connect with the default configuration.\n#[deprecated(since = \"1.4.0\", note = \"use Client::connect_with(ClientConfig::default())\")]\npub fn connect(url: &str) -> Result<Client, Error> {\n    connect_with(url, ClientConfig::default())\n}\n\npub fn connect_with(url: &str, cfg: ClientConfig) -> Result<Client, Error> {\n    let _ = (url, cfg);\n    Ok(Client)\n}\n\npub struct Client;\n#[derive(Debug)]\npub struct Error;\n#[derive(Debug, Clone, Default)]\npub struct ClientConfig;\n\nfn main() {\n    let c = connect_with(\"postgres://localhost/app\", ClientConfig::default());\n    assert!(c.is_ok());\n}",
          "tip": "Deprecation notes are read more than docs. Put the exact replacement expression in the note, not a link."
        }
      ],
      "exercise": {
        "prompt": "You maintain a crate whose public API is `pub enum Event { Start, Stop }` and `pub trait Sink { fn write(&mut self, e: &Event); }`. Classify each proposed change as major or minor, and rewrite the API so both changes become minor.",
        "starter": "pub enum Event { Start, Stop }\n\npub trait Sink {\n    fn write(&mut self, e: &Event);\n}\n\n// Proposed:\n// 1. add Event::Pause\n// 2. add fn flush(&mut self) to Sink\n// 3. add a field to a public config struct\n// Which are breaking today, and what makes them non-breaking?",
        "hint": "Mark the enum non_exhaustive and give flush a default implementation (or seal the trait). A public struct needs non_exhaustive or private fields before it can gain a field.",
        "solution": "// Classification with the current API:\n// 1. Event::Pause            MAJOR - downstream exhaustive matches break.\n// 2. Sink::flush             MAJOR - every implementor must add the method.\n// 3. field on public struct  MAJOR - downstream struct literals break.\n\n// Rewritten so future additions are minor:\n#[non_exhaustive]\n#[derive(Debug, Clone, Copy, PartialEq, Eq)]\npub enum Event { Start, Stop, Pause }\n\npub trait Sink {\n    fn write(&mut self, e: &Event);\n\n    /// Defaulted so existing implementors keep compiling.\n    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }\n}\n\n#[derive(Debug, Clone)]\n#[non_exhaustive]\npub struct Config {\n    pub buffer: usize,\n}\n\nimpl Default for Config {\n    fn default() -> Self { Self { buffer: 4096 } }\n}\n\nfn main() {\n    let mut sink = VecSink::default();\n    sink.write(&Event::Start);\n    sink.flush().unwrap();\n    assert_eq!(sink.events, vec![Event::Start]);\n}\n\n#[derive(Default)]\nstruct VecSink { events: Vec<Event> }\n\nimpl Sink for VecSink {\n    fn write(&mut self, e: &Event) { self.events.push(*e); }\n}"
      },
      "questions": [
        {
          "q": "Which change is breaking for a public enum without #[non_exhaustive]?",
          "options": [
            "Adding a new variant",
            "Adding a doc comment to an existing variant",
            "Changing a variant's Debug output",
            "Adding an inherent method that returns the variant name"
          ],
          "answer": 0,
          "explain": "Downstream exhaustive matches stop compiling when a variant is added. non_exhaustive forces downstream to include a wildcard arm, which makes the addition a minor change."
        },
        {
          "q": "What does `impl AsRef<Path>` in an argument position buy you?",
          "options": [
            "It copies the path into an owned PathBuf",
            "It accepts &str, String, Path and PathBuf without the caller allocating",
            "It makes the function generic over the filesystem",
            "It enables const evaluation"
          ],
          "answer": 1,
          "explain": "AsRef is implemented by all the common path-like types, so one signature serves every caller and the conversion happens at the boundary without an extra allocation at the call site."
        },
        {
          "q": "What is the main cost of sealing a public trait?",
          "options": [
            "It cannot have default methods",
            "Downstream crates can no longer implement it, so you own every implementation",
            "It requires unsafe code",
            "It cannot be used as a trait object"
          ],
          "answer": 1,
          "explain": "Sealing trades extensibility for the freedom to add methods without a breaking change. That is the right trade for a policy or config trait and the wrong one for a trait meant as an extension point."
        }
      ],
      "quickbytes": [
        "Breaking means downstream code stops compiling, not that the diff looks big.",
        "Public enums and structs should be #[non_exhaustive] unless you promise exhaustiveness.",
        "Flexible in, specific out: impl AsRef in arguments, owned types in returns.",
        "Deprecate with the exact replacement expression in the note."
      ],
      "production": [
        "Run a downstream smoke crate against the published API in CI; unit tests cannot see breakage.",
        "Keep a changelog entry for behaviour changes, not just signature changes.",
        "Seal traits that are policy hooks; leave extension traits open and document the commitment.",
        "Gate new APIs behind a feature flag for one release before making them default."
      ],
      "crates": [
        "cargo-semver-checks",
        "semver",
        "clap"
      ],
      "github": [
        {
          "name": "rust-lang/api-guidelines - the rules behind these reviews",
          "url": "https://github.com/rust-lang/api-guidelines"
        },
        {
          "name": "obi1kenobi/cargo-semver-checks - automate the classification",
          "url": "https://github.com/obi1kenobi/cargo-semver-checks"
        }
      ],
      "pitfall": "Adding a variant to a public error enum in a patch release. Every downstream exhaustive match breaks, and the failure appears in their build, not yours.",
      "resources": [
        {
          "title": "The Cargo Book: semver compatibility",
          "url": "https://doc.rust-lang.org/cargo/reference/semver.html",
          "kind": "docs"
        },
        {
          "title": "Rust API guidelines",
          "url": "https://rust-lang.github.io/api-guidelines/",
          "kind": "docs"
        },
        {
          "title": "rust-lang/api-guidelines repository",
          "url": "https://github.com/rust-lang/api-guidelines",
          "kind": "repo"
        },
        {
          "title": "EuroRust talks: API and library design",
          "url": "https://www.youtube.com/@eurorust",
          "kind": "video"
        }
      ]
    },
    {
      "id": "t14",
      "title": "Database questions: N+1 queries and pool arithmetic",
      "minutes": 75,
      "level": "industry",
      "goal": "Detect an N+1 by counting queries, size a connection pool from throughput and latency, and keep transactions short enough to retry.",
      "sections": [
        {
          "h": "Find the N+1 by counting, not by reading",
          "p": [
            "An N+1 hides in a loop that looks necessary. You fetch 200 orders, then fetch the customer for each one, and the code reads fine while issuing 201 round trips. At 1 ms per round trip that is 200 ms of latency added to a request that should take 5 ms, and it scales with the result set, so it degrades exactly when traffic is highest.",
            "The detection method is a query counter, not a code review. Enable sqlx's statement logging in staging, run one request, and count the lines. Then read the plan: EXPLAIN ANALYZE on the batched version shows whether the join uses an index or degenerates into a sequential scan. The fix is a join or a single `WHERE id = ANY($1)` with the ids collected first, which is also easier to cache."
          ],
          "code": "// N+1: one query per order, latency scales with the result set.\nasync fn slow(pool: &sqlx::PgPool) -> sqlx::Result<Vec<(i64, String)>> {\n    let ids: Vec<(i64,)> = sqlx::query_as(\"SELECT id FROM orders LIMIT 200\")\n        .fetch_all(pool).await?;\n    let mut out = Vec::with_capacity(ids.len());\n    for (id,) in ids {\n        let (name,): (String,) =\n            sqlx::query_as(\"SELECT name FROM customers WHERE id = $1\")\n                .bind(id).fetch_one(pool).await?;\n        out.push((id, name));\n    }\n    Ok(out)\n}\n\n// One round trip, index-friendly, bounded.\nasync fn fast(pool: &sqlx::PgPool) -> sqlx::Result<Vec<(i64, String)>> {\n    sqlx::query_as(\n        \"SELECT o.id, c.name\n           FROM orders o\n           JOIN customers c ON c.id = o.customer_id\n          ORDER BY o.id\n          LIMIT 200\",\n    )\n    .fetch_all(pool)\n    .await\n}",
          "tip": "Set log_statement = 'all' in a local Postgres for one debugging session. Counting lines in the log is faster than reasoning about the ORM."
        },
        {
          "h": "Pool sizing is Little's law, not a guess",
          "p": [
            "A connection pool is a queue with a service time. If a request holds a connection for 3 ms and you serve 2,000 requests per second, you need about 6 connections busy on average; at 50% utilisation for headroom, 12. Setting max_connections to 100 does not make the database faster, it moves the queue into the database where it holds locks and memory.",
            "The two settings that prevent outages are acquire_timeout and statement_timeout. Without an acquire timeout, requests queue indefinitely and the service reports high latency with no errors, which is the worst failure shape. Without a statement timeout, one bad query holds a connection until the client gives up, and the pool drains. Both should be shorter than the caller's deadline, so the failure surfaces as a fast 503 rather than a slow 200."
          ],
          "code": "use sqlx::postgres::PgPoolOptions;\nuse std::time::Duration;\n\n#[tokio::main]\nasync fn main() -> anyhow::Result<()> {\n    let pool = PgPoolOptions::new()\n        // 12 busy at 50% utilisation for 2k rps x 3 ms.\n        .max_connections(24)\n        .min_connections(4)\n        // Fail fast instead of queueing behind a saturated pool.\n        .acquire_timeout(Duration::from_millis(250))\n        .idle_timeout(Duration::from_secs(600))\n        .max_lifetime(Duration::from_secs(1_800))\n        .connect(\"postgres://app@localhost/app\")\n        .await?;\n\n    // Statement timeout is per session; set it once per connection.\n    sqlx::query(\"SET statement_timeout = '2s'\")\n        .execute(&pool)\n        .await?;\n\n    let ids: Vec<i64> = vec![1, 2, 3];\n    let rows: Vec<(i64, String)> = sqlx::query_as(\n        \"SELECT id, name FROM users WHERE id = ANY($1)\",\n    )\n    .bind(&ids)\n    .fetch_all(&pool)\n    .await?;\n\n    println!(\"{} rows\", rows.len());\n    Ok(())\n}",
          "tip": "The database has a connection limit too. Ten pods with max_connections 24 need 240 server slots; size the server before you scale the deployment."
        },
        {
          "h": "Short transactions, explicit retries",
          "p": [
            "A transaction holds locks and a connection. Doing an HTTP call inside one is the classic way to turn a slow third party into a database outage, because the lock is held for the duration of the call. Keep the transaction to the writes it must make atomic, do IO before or after, and use SELECT ... FOR UPDATE only where the invariant requires it.",
            "At SERIALIZABLE or REPEATABLE READ, Postgres can abort a transaction with a serialization failure, which is a retryable error rather than a bug. The retry must re-run the whole transaction, not just the failed statement, and it must be bounded. The same shape applies to deadlocks, which the database resolves by aborting one participant; catching SQLSTATE 40001 and 40P01 and retrying twice with jitter covers most contention."
          ],
          "code": "use sqlx::{Postgres, Transaction};\nuse std::time::Duration;\n\nasync fn transfer(\n    tx: &mut Transaction<'_, Postgres>,\n    from: i64,\n    to: i64,\n    amount: i64,\n) -> sqlx::Result<()> {\n    // Lock in a deterministic order to avoid deadlocks between transfers.\n    let (a, b) = if from < to { (from, to) } else { (to, from) };\n    sqlx::query(\"SELECT id FROM accounts WHERE id = ANY($1) ORDER BY id FOR UPDATE\")\n        .bind(&[a, b])\n        .execute(&mut **tx)\n        .await?;\n\n    let updated = sqlx::query(\n        \"UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND balance >= $1\",\n    )\n    .bind(amount)\n    .bind(from)\n    .execute(&mut **tx)\n    .await?\n    .rows_affected();\n\n    if updated == 0 { return Err(sqlx::Error::RowNotFound); }\n\n    sqlx::query(\"UPDATE accounts SET balance = balance + $1 WHERE id = $2\")\n        .bind(amount)\n        .bind(to)\n        .execute(&mut **tx)\n        .await?;\n    Ok(())\n}\n\nasync fn with_serializable_retry<T, F, Fut>(pool: &sqlx::PgPool, mut op: F) -> sqlx::Result<T>\nwhere\n    F: FnMut(Transaction<'_, Postgres>) -> Fut,\n    Fut: std::future::Future<Output = (Transaction<'_, Postgres>, sqlx::Result<T>)>,\n{\n    for attempt in 0..3u32 {\n        let tx = pool.begin().await?;\n        let (tx, result) = op(tx).await;\n        match result {\n            Ok(v) => { tx.commit().await?; return Ok(v); }\n            Err(sqlx::Error::Database(e))\n                if matches!(e.code().as_deref(), Some(\"40001\") | Some(\"40P01\")) =>\n            {\n                tx.rollback().await.ok();\n                tokio::time::sleep(Duration::from_millis(20 * 2u64.pow(attempt))).await;\n            }\n            Err(e) => { tx.rollback().await.ok(); return Err(e); }\n        }\n    }\n    Err(sqlx::Error::PoolTimedOut)\n}"
        }
      ],
      "exercise": {
        "prompt": "A list endpoint issues 1 query plus one per row and runs at 800 rps with a 4 ms average connection hold. Rewrite it as one query, then compute a pool size with 50% headroom and set the timeouts. State what happens when the pool saturates.",
        "starter": "// 1. rewrite: SELECT ... FROM a JOIN b ON ... WHERE a.tenant = $1 LIMIT 200\n// 2. pool math: busy = rps * hold_secs; max = busy / target_utilisation\n// 3. timeouts: acquire < caller deadline; statement < acquire + hold\nfn main() {\n    let rps = 800.0;\n    let hold_secs = 0.004;\n    // TODO: compute busy and max_connections\n}",
        "hint": "busy = 800 * 0.004 = 3.2 connections. At 50% utilisation that is 6.4, round to 7. If the N+1 remains, hold time is 200x higher and the pool needs hundreds of connections, which is the real argument for the rewrite.",
        "solution": "use sqlx::postgres::PgPoolOptions;\nuse std::time::Duration;\n\nfn pool_math(rps: f64, hold_secs: f64, target_utilisation: f64) -> (f64, u32) {\n    let busy = rps * hold_secs;\n    let max = (busy / target_utilisation).ceil() as u32;\n    (busy, max.max(1))\n}\n\n#[tokio::main]\nasync fn main() -> anyhow::Result<()> {\n    let (busy, max) = pool_math(800.0, 0.004, 0.5);\n    assert!((busy - 3.2).abs() < 1e-9);\n    assert_eq!(max, 7);\n\n    // With the N+1 still in place, hold time is ~201x: 0.804 s per request.\n    let (busy_n1, max_n1) = pool_math(800.0, 0.804, 0.5);\n    assert!(busy_n1 > 600.0 && max_n1 > 1_200); // not a pool you can run\n\n    let pool = PgPoolOptions::new()\n        .max_connections(max)\n        .acquire_timeout(Duration::from_millis(250))\n        .connect(\"postgres://app@localhost/app\")\n        .await?;\n\n    sqlx::query(\"SET statement_timeout = '2s'\").execute(&pool).await?;\n\n    let rows: Vec<(i64, String)> = sqlx::query_as(\n        \"SELECT o.id, c.name\n           FROM orders o\n           JOIN customers c ON c.id = o.customer_id\n          WHERE o.tenant_id = $1\n          ORDER BY o.id\n          LIMIT 200\",\n    )\n    .bind(1i64)\n    .fetch_all(&pool)\n    .await?;\n\n    println!(\"{} rows with a pool of {}\", rows.len(), max);\n    Ok(())\n}\n\n// Saturation behaviour: once all 7 connections are busy, callers wait up to\n// acquire_timeout (250 ms) and then get PoolTimedOut, which the handler maps\n// to 503. Without that timeout they would wait for the full request deadline\n// and the p99 would rise with no error signal at all."
      },
      "questions": [
        {
          "q": "How do you prove an endpoint has an N+1 problem?",
          "options": [
            "Read the handler and look for a loop",
            "Count the SQL statements issued for one request in staging logging",
            "Check the CPU usage of the database",
            "Run cargo clippy"
          ],
          "answer": 1,
          "explain": "A query counter turns suspicion into a number. Loops that issue queries are sometimes unavoidable; a count shows whether this one is 201 round trips or 2."
        },
        {
          "q": "What is the main risk of setting max_connections far higher than the workload needs?",
          "options": [
            "It increases per-query latency in the client",
            "It pushes the queue into the database, where connections hold memory and locks",
            "It breaks transaction isolation",
            "It disables prepared statements"
          ],
          "answer": 1,
          "explain": "The pool does not create capacity. Extra connections increase contention inside the server and can hit its own connection limit, moving the bottleneck without removing it."
        },
        {
          "q": "A transaction fails with SQLSTATE 40001 under SERIALIZABLE. What is the correct response?",
          "options": [
            "Retry the failed statement only",
            "Roll back and retry the entire transaction, bounded, with jitter",
            "Ignore it, because the write eventually applies",
            "Downgrade the isolation level permanently"
          ],
          "answer": 1,
          "explain": "Serialization failure means the snapshot is invalid, so the whole unit of work must re-run. Retrying one statement would operate on a stale view."
        }
      ],
      "quickbytes": [
        "Count queries per request in staging; an N+1 is a number, not an opinion.",
        "busy = rps x hold seconds; max_connections = busy / target utilisation.",
        "acquire_timeout shorter than the caller deadline turns saturation into a fast 503.",
        "SQLSTATE 40001 and 40P01 are retryable: roll back and re-run the whole transaction."
      ],
      "production": [
        "Set statement_timeout per session so a runaway query cannot hold a pooled connection.",
        "Alert on pool acquire latency, not just on query latency.",
        "Never perform network IO inside a transaction that holds row locks.",
        "Keep a slow-query log with a threshold; it finds N+1s that tracing misses."
      ],
      "crates": [
        "sqlx",
        "tokio",
        "anyhow"
      ],
      "github": [
        {
          "name": "launchbadge/sqlx - pool, transactions and query macros",
          "url": "https://github.com/transact-rs/sqlx"
        },
        {
          "name": "postgres/postgres - the server and its isolation semantics",
          "url": "https://github.com/postgres/postgres"
        }
      ],
      "pitfall": "Holding a transaction open across an HTTP call. The row locks stay held for the duration of the network round trip, and every concurrent writer queues behind it.",
      "resources": [
        {
          "title": "sqlx - pools, acquire_timeout and transactions",
          "url": "https://docs.rs/sqlx/latest/sqlx/",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: transaction isolation",
          "url": "https://www.postgresql.org/docs/current/transaction-iso.html",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL: EXPLAIN and query planning",
          "url": "https://www.postgresql.org/docs/current/using-explain.html",
          "kind": "docs"
        },
        {
          "title": "launchbadge/sqlx repository",
          "url": "https://github.com/transact-rs/sqlx",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "t15",
      "title": "Distributed systems: the quorum answer that scores",
      "minutes": 75,
      "level": "industry",
      "goal": "Derive quorum behaviour from R and W instead of reciting CAP, then place idempotency and fencing where they actually prevent corruption.",
      "sections": [
        {
          "h": "R + W > N buys overlap, not linearizability",
          "p": [
            "With N replicas, writing to W and reading from R, R + W > N guarantees that every read quorum intersects every write quorum, so a read sees the latest acknowledged write. That is a useful property and it is not the same as linearizability: without a leader or a consensus round, two concurrent writes can still be ordered differently by different readers.",
            "The interview answer that scores names what the arithmetic does and does not give you. With N=3, W=2, R=2 you tolerate one node failure for both reads and writes. With W=3, R=1 you tolerate no write failures and read stale data from any single node. With W=1, R=1 you have availability and no read-your-writes. Pick the pair from the failure budget, not from a preference."
          ],
          "code": "#[derive(Debug, Clone, Copy, PartialEq, Eq)]\npub struct Quorum { pub n: u32, pub r: u32, pub w: u32 }\n\nimpl Quorum {\n    pub fn new(n: u32, r: u32, w: u32) -> Result<Self, &'static str> {\n        if n == 0 || r == 0 || w == 0 { return Err(\"replication factors must be positive\"); }\n        if r > n || w > n { return Err(\"quorum larger than replica set\"); }\n        Ok(Self { n, r, w })\n    }\n\n    /// True when every read quorum intersects every write quorum.\n    pub fn overlaps(&self) -> bool { self.r + self.w > self.n }\n\n    /// Failures tolerated while still accepting writes.\n    pub fn write_faults(&self) -> u32 { self.n - self.w }\n\n    /// Failures tolerated while still serving reads.\n    pub fn read_faults(&self) -> u32 { self.n - self.r }\n}\n\nfn main() {\n    let rf3 = Quorum::new(3, 2, 2).unwrap();\n    assert!(rf3.overlaps());\n    assert_eq!((rf3.write_faults(), rf3.read_faults()), (1, 1));\n\n    // Fast writes, no read-your-writes guarantee.\n    let fast = Quorum::new(3, 1, 1).unwrap();\n    assert!(!fast.overlaps());\n    assert_eq!(fast.write_faults(), 2);\n\n    // All writes synchronous: no write fault tolerance at all.\n    let strict = Quorum::new(3, 1, 3).unwrap();\n    assert!(strict.overlaps());\n    assert_eq!(strict.write_faults(), 0);\n\n    assert!(Quorum::new(3, 4, 1).is_err());\n}",
          "tip": "Say the failure budget before the numbers: one node down, reads must still be fresh. Then the pair follows, and the interviewer sees the reasoning instead of a memorised triple."
        },
        {
          "h": "Idempotency is a data model decision",
          "p": [
            "At-least-once delivery plus a retry budget means duplicates are normal. The only reliable defence is a stable key that the write path enforces in the same transaction as the effect: a unique index on idempotency_key, and a response stored alongside so a replay returns the original result rather than a second side effect. Deduplicating in the client is not a defence, because the client is the thing that retries.",
            "The retry budget is part of the design, not an afterthought. If every layer retries three times and a request crosses four layers, one user action becomes eighty-one attempts. Cap retries at one layer, propagate a deadline, and let the innermost layer fail fast when the deadline has passed. This is the argument for a deadline-aware client rather than a fixed timeout per hop."
          ],
          "code": "use std::time::{Duration, Instant};\n\n/// Propagated across hops; every layer checks the same absolute deadline.\n#[derive(Debug, Clone, Copy)]\npub struct Deadline { at: Instant }\n\nimpl Deadline {\n    pub fn after(d: Duration) -> Self { Self { at: Instant::now() + d } }\n    pub fn remaining(&self) -> Option<Duration> {\n        let now = Instant::now();\n        if now >= self.at { None } else { Some(self.at - now) }\n    }\n    pub fn expired(&self) -> bool { self.remaining().is_none() }\n}\n\n/// Retry at exactly one layer, bounded by the deadline.\npub async fn with_budget<T, F, Fut>(\n    deadline: Deadline,\n    mut op: F,\n    max_attempts: u32,\n) -> Result<T, &'static str>\nwhere\n    F: FnMut() -> Fut,\n    Fut: std::future::Future<Output = Result<T, &'static str>>,\n{\n    for attempt in 0..max_attempts {\n        match op().await {\n            Ok(v) => return Ok(v),\n            Err(e) => {\n                if attempt + 1 == max_attempts { return Err(e); }\n                let Some(left) = deadline.remaining() else { return Err(\"deadline exceeded\"); };\n                let backoff = Duration::from_millis(20 * 2u64.pow(attempt)).min(left / 2);\n                tokio::time::sleep(backoff).await;\n            }\n        }\n    }\n    Err(\"exhausted\")\n}\n\n#[tokio::main]\nasync fn main() {\n    let d = Deadline::after(Duration::from_millis(500));\n    let mut calls = 0;\n    let r: Result<u8, &str> = with_budget(d, || {\n        calls += 1;\n        let n = calls;\n        // async move: the future owns n instead of borrowing calls,\n        // so the closure can stay FnMut.\n        async move { if n < 3 { Err(\"transient\") } else { Ok(7) } }\n    }, 5).await;\n    assert_eq!(r, Ok(7));\n    assert!(!d.expired());\n}",
          "tip": "A deadline that travels with the request is worth more than any retry count. A layer cannot retry past a deadline it cannot see."
        },
        {
          "h": "Clocks lie, leases need fences",
          "p": [
            "Wall clocks jump: NTP steps them, virtual machines pause, and a lease that relies on local time can expire early or late. A worker that believes it still holds a lease after a stop-the-world pause will write over the new holder's data. Timeouts detect slowness; they cannot prevent two writers.",
            "The fix is a fencing token: the lock service issues a monotonically increasing number on each acquisition, and every write carries it. Storage rejects any write whose token is lower than the highest it has seen. Now a paused worker's write is not a correctness problem, it is a rejected request. This is the same argument as a compare-and-swap on a version column, generalised to an external lease."
          ],
          "code": "/// Storage-side guard: the fence is checked in the same statement\n/// that mutates the row, so no read-then-write window exists.\npub async fn guarded_write(\n    pool: &sqlx::PgPool,\n    key: &str,\n    fence: i64,\n    value: &[u8],\n) -> sqlx::Result<bool> {\n    let updated = sqlx::query(\n        \"UPDATE slots\n            SET value = $3, fence = $2\n          WHERE key = $1 AND fence < $2\",\n    )\n    .bind(key)\n    .bind(fence)\n    .bind(value)\n    .execute(pool)\n    .await?\n    .rows_affected();\n    Ok(updated == 1)\n}\n\n#[tokio::main]\nasync fn main() -> sqlx::Result<()> {\n    let pool = sqlx::PgPool::connect(\"postgres://app@localhost/app\").await?;\n\n    // Holder 1 acquires fence 7 and writes: accepted.\n    assert!(guarded_write(&pool, \"job-42\", 7, b\"v1\").await?);\n\n    // Holder 1 pauses, lease expires, holder 2 acquires fence 8.\n    assert!(guarded_write(&pool, \"job-42\", 8, b\"v2\").await?);\n\n    // Holder 1 resumes with the stale fence: rejected, no corruption.\n    assert!(!guarded_write(&pool, \"job-42\", 7, b\"v1-again\").await?);\n    Ok(())\n}",
          "tip": "Validate the fence in the same UPDATE that writes the data. A separate SELECT to check the fence reintroduces the race you were preventing."
        }
      ],
      "exercise": {
        "prompt": "A team runs N=5 with R=1 and W=1 for a payments ledger and is surprised by stale reads after a write. Compute the failure modes, propose a quorum pair with a stated failure budget, and explain what still is not guaranteed.",
        "starter": "struct Quorum { n: u32, r: u32, w: u32 }\n\nfn main() {\n    // Current: N=5, R=1, W=1\n    // TODO: does it overlap? what does a read see after an acknowledged write?\n    // TODO: propose (N, R, W) for \"survive 1 node loss, read-your-writes\".\n    // TODO: what is still not guaranteed even with R + W > N?\n}",
        "hint": "R + W = 2 <= 5, so quorums need not intersect. For one-node tolerance with read-your-writes, N=5 R=3 W=3 works. Overlap still does not give you linearizability or protection from a stale replica serving a read during a partition.",
        "solution": "#[derive(Debug, Clone, Copy)]\nstruct Quorum { n: u32, r: u32, w: u32 }\n\nimpl Quorum {\n    fn overlaps(&self) -> bool { self.r + self.w > self.n }\n    fn write_faults(&self) -> u32 { self.n - self.w }\n    fn read_faults(&self) -> u32 { self.n - self.r }\n}\n\nfn main() {\n    let current = Quorum { n: 5, r: 1, w: 1 };\n    assert!(!current.overlaps());\n    // A read can hit any of 4 replicas that did not receive the write.\n    assert_eq!(current.write_faults(), 4);\n    assert_eq!(current.read_faults(), 4);\n\n    // Survive one node loss for reads and writes, and guarantee overlap.\n    let proposed = Quorum { n: 5, r: 3, w: 3 };\n    assert!(proposed.overlaps());\n    assert_eq!(proposed.write_faults(), 2);\n    assert_eq!(proposed.read_faults(), 2);\n\n    // What is still not guaranteed:\n    // 1. Linearizability - two concurrent writes can be ordered differently\n    //    by different read quorums without a leader or consensus round.\n    // 2. Availability under a partition - a minority side cannot assemble a\n    //    quorum, so it rejects writes (this is the C in CAP, per operation).\n    // 3. Protection from a stale read during a partial write, unless the\n    //    write is acknowledged only after W replicas persist it.\n    //\n    // For a payments ledger the honest answer is a single-writer-per-shard\n    // log (Raft) plus idempotency keys, not quorum tuning on a KV store.\n}"
      },
      "questions": [
        {
          "q": "What does R + W > N actually guarantee?",
          "options": [
            "Linearizable reads and writes",
            "Every read quorum intersects every write quorum, so a read sees the latest acknowledged write",
            "That the system stays available during a partition",
            "That writes are durable on all replicas"
          ],
          "answer": 1,
          "explain": "The inequality is a set-intersection argument. It does not order concurrent writes, and it does not preserve availability when a quorum cannot be assembled."
        },
        {
          "q": "Why is a fencing token required in addition to a lease timeout?",
          "options": [
            "Timeouts are too short for slow networks",
            "A paused holder can resume after expiry and write; the fence makes storage reject the stale write",
            "Fencing tokens encrypt the write payload",
            "Leases cannot be renewed"
          ],
          "answer": 1,
          "explain": "A timeout only tells the new holder that it may proceed. It cannot stop the old holder, which is why the resource itself must reject writes carrying an older token."
        },
        {
          "q": "A request crosses four layers that each retry three times. What is the worst-case amplification?",
          "options": [
            "4 attempts",
            "12 attempts",
            "81 attempts",
            "3 attempts, because retries are deduplicated"
          ],
          "answer": 2,
          "explain": "Retries multiply across layers: 3^4. That is why retries belong at one layer and why a propagated deadline matters more than a retry count."
        }
      ],
      "quickbytes": [
        "R + W > N gives quorum overlap, not linearizability and not partition availability.",
        "Pick the pair from the failure budget: N=5, R=3, W=3 survives two node losses for each operation.",
        "Idempotency belongs in the write path as a unique key plus a stored response.",
        "Retry at one layer only; propagate a deadline so inner layers can fail fast."
      ],
      "production": [
        "Store idempotency keys with a unique index and the original response, in the same transaction as the effect.",
        "Validate fencing tokens inside the mutating statement, never in a preceding read.",
        "Use monotonic clocks for elapsed time and wall clocks only for timestamps you display.",
        "Cap retries at one layer and make the deadline an explicit field on the request context."
      ],
      "crates": [
        "openraft",
        "sqlx",
        "tokio"
      ],
      "github": [
        {
          "name": "databendlabs/openraft - Raft in Rust, with the paper's rules",
          "url": "https://github.com/databendlabs/openraft"
        },
        {
          "name": "launchbadge/sqlx - fenced conditional updates",
          "url": "https://github.com/transact-rs/sqlx"
        }
      ],
      "pitfall": "Checking a lease or fence with a SELECT and then writing in a separate statement. The gap between them is exactly the race the fence was supposed to close.",
      "resources": [
        {
          "title": "In Search of an Understandable Consensus Algorithm (Raft)",
          "url": "https://raft.github.io/raft.pdf",
          "kind": "paper"
        },
        {
          "title": "The Raft consensus site - visualisation and resources",
          "url": "https://raft.github.io/",
          "kind": "docs"
        },
        {
          "title": "Spanner: Google's Globally-Distributed Database",
          "url": "https://research.google/pubs/spanner-googles-globally-distributed-database-2/",
          "kind": "paper"
        },
        {
          "title": "Diego Ongaro: Designing for Understandability - The Raft Consensus Algorithm",
          "url": "https://www.youtube.com/watch?v=vYp4LYbnnW8",
          "kind": "video"
        },
        {
          "title": "databendlabs/openraft repository",
          "url": "https://github.com/databendlabs/openraft",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "t16",
      "title": "Security questions: token validation on the whiteboard",
      "minutes": 60,
      "level": "industry",
      "goal": "Validate a JWT by pinning the algorithm, requiring audience and issuer, and treating every claim as untrusted input until the signature verifies.",
      "sections": [
        {
          "h": "The three checks people skip",
          "p": [
            "Most JWT incidents come from three omissions, not from broken cryptography. First, the algorithm is taken from the token header instead of pinned by the verifier, which enables algorithm-confusion attacks. Second, the audience and issuer are not checked, so a token minted for a different service is accepted. Third, expiry is checked but the clock skew allowance is either zero, causing spurious rejections, or enormous, extending a stolen token's life.",
            "The order matters too: verify the signature first, then read claims. Parsing the payload to make a decision before verification is the same bug as trusting a password field before hashing. A library that returns claims only from a successful decode enforces this by construction, which is why you use one instead of hand-rolling base64 and HMAC."
          ],
          "code": "use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};\nuse serde::{Deserialize, Serialize};\n\n#[derive(Debug, Serialize, Deserialize)]\nstruct Claims {\n    sub: String,\n    aud: String,\n    iss: String,\n    exp: usize,\n    scope: Vec<String>,\n}\n\nfn verify(token: &str, secret: &[u8]) -> Result<Claims, jsonwebtoken::errors::Error> {\n    // Algorithm pinned by the verifier, never read from the header.\n    let mut v = Validation::new(Algorithm::HS256);\n\n    // A token for another service must not be accepted here.\n    v.set_audience(&[\"api.acme.internal\"]);\n    v.set_issuer(&[\"https://auth.acme.internal\"]);\n    v.set_required_spec_claims(&[\"exp\", \"iss\", \"aud\"]);\n\n    // 30 s of clock skew, not 30 minutes.\n    v.leeway = 30;\n    v.validate_nbf = true;\n    // Reject tokens that expire while in flight.\n    v.reject_tokens_expiring_in_less_than = 5;\n\n    let data = decode::<Claims>(token, &DecodingKey::from_secret(secret), &v)?;\n    Ok(data.claims)\n}\n\nfn main() {\n    let claims = Claims {\n        sub: \"user-1\".into(),\n        aud: \"api.acme.internal\".into(),\n        iss: \"https://auth.acme.internal\".into(),\n        exp: 4_102_444_800,\n        scope: vec![\"orders:read\".into()],\n    };\n    let token = jsonwebtoken::encode(\n        &jsonwebtoken::Header::new(Algorithm::HS256),\n        &claims,\n        &jsonwebtoken::EncodingKey::from_secret(b\"dev-only-secret\"),\n    ).unwrap();\n\n    assert_eq!(verify(&token, b\"dev-only-secret\").unwrap().sub, \"user-1\");\n    // Wrong key, wrong audience, or an expired token all fail here.\n    assert!(verify(&token, b\"other-secret\").is_err());\n}",
          "tip": "Set required_spec_claims to exp, iss and aud. Without it, a token that simply omits aud passes the audience check."
        },
        {
          "h": "Algorithm confusion and key rotation",
          "p": [
            "In the classic confusion attack the verifier is configured for RS256 and reads alg from the header. The attacker signs an HS256 token using the service's public RSA key as the HMAC secret, and a naive verifier that dispatches on the header accepts it, because the public key is public. Pinning the algorithm to a single value in the verifier removes the attack entirely.",
            "Key rotation is the operational half. Publish keys with a kid header and a JWKS endpoint, cache the key set with a short TTL, and refresh on an unknown kid rather than rejecting immediately. During rotation, accept the previous key for at least the token lifetime, otherwise every session expires at the moment you rotate. None of this is exotic; it is the difference between a working auth system and one that pages you monthly."
          ],
          "code": "// Key selection by kid, with a cache and an explicit refresh path.\nuse std::collections::HashMap;\nuse std::sync::RwLock;\n\nstruct KeySet {\n    by_kid: RwLock<HashMap<String, Vec<u8>>>,\n    ttl_secs: u64,\n}\n\nimpl KeySet {\n    fn new(ttl_secs: u64) -> Self {\n        Self { by_kid: RwLock::new(HashMap::new()), ttl_secs }\n    }\n\n    fn insert(&self, kid: &str, secret: Vec<u8>) {\n        self.by_kid.write().unwrap().insert(kid.to_string(), secret);\n    }\n\n    /// Look up, and on a miss refresh once before failing.\n    fn resolve(&self, kid: &str) -> Option<Vec<u8>> {\n        if let Some(k) = self.by_kid.read().unwrap().get(kid) {\n            return Some(k.clone());\n        }\n        self.refresh();\n        self.by_kid.read().unwrap().get(kid).cloned()\n    }\n\n    fn refresh(&self) {\n        // In production: GET the JWKS endpoint with a short timeout,\n        // parse n/e per kid, and respect the Cache-Control max-age.\n        let _ = self.ttl_secs;\n        self.insert(\"2026-11\", b\"rotated-secret\".to_vec());\n    }\n}\n\nfn main() {\n    let set = KeySet::new(300);\n    set.insert(\"2026-10\", b\"previous-secret\".to_vec());\n    assert!(set.resolve(\"2026-10\").is_some());\n    // Unknown kid triggers one refresh, then succeeds if the key exists.\n    assert!(set.resolve(\"2026-11\").is_some());\n    assert!(set.resolve(\"never-issued\").is_none());\n}",
          "tip": "Never log the token or the Authorization header. Log the kid, the subject and the failure reason; that is enough to debug a rotation."
        },
        {
          "h": "Constant time, and the checks that are not about crypto",
          "p": [
            "Comparing a MAC, an API key or a reset token with == leaks timing information proportional to the matching prefix. Use a constant-time comparison for any secret comparison, and never for password hashes, where the stored hash comparison must also be constant time. In Rust that is subtle::ConstantTimeEq or the library's own constant-time check; write it once in a helper so nobody reimplements it.",
            "The rest of the whiteboard answer is authorisation. A verified token proves who the caller is, not what they may do. Check scope or role per route, and check object ownership per record, because the common real bug is a valid token reading another tenant's row by id. Rate-limit the verification path too: signature verification is cheap, but an unauthenticated endpoint that verifies 50k tokens per second is a CPU exhaustion vector."
          ],
          "code": "use subtle::ConstantTimeEq;\n\n/// Compare a presented secret with the stored one without leaking\n/// the length of the matching prefix through timing.\nfn secret_eq(presented: &[u8], stored: &[u8]) -> bool {\n    if presented.len() != stored.len() {\n        return false;\n    }\n    presented.ct_eq(stored).into()\n}\n\n/// Authorisation is separate from authentication: a valid token is not\n/// a permission slip for this object.\nfn can_read(claims_tenant: &str, claims_scope: &[String], row_tenant: &str) -> bool {\n    claims_scope.iter().any(|s| s == \"orders:read\") && claims_tenant == row_tenant\n}\n\nfn main() {\n    assert!(secret_eq(b\"correct-horse\", b\"correct-horse\"));\n    assert!(!secret_eq(b\"correct-horsf\", b\"correct-horse\"));\n    assert!(!secret_eq(b\"short\", b\"correct-horse\"));\n\n    let scope = vec![\"orders:read\".to_string()];\n    assert!(can_read(\"t-1\", &scope, \"t-1\"));\n    assert!(!can_read(\"t-1\", &scope, \"t-2\")); // cross-tenant read blocked\n}"
        }
      ],
      "exercise": {
        "prompt": "This verifier accepts the algorithm from the token header, does not check audience, and allows 24 hours of clock skew. Harden it and explain which attack each change closes.",
        "starter": "use jsonwebtoken::{decode, DecodingKey, Validation};\n\nfn verify(token: &str, secret: &[u8]) -> Result<Claims, jsonwebtoken::errors::Error> {\n    let mut v = Validation::default();   // allows HS256 only, aud unchecked\n    v.leeway = 86_400;\n    v.validate_aud = false;\n    decode::<Claims>(token, &DecodingKey::from_secret(secret), &v).map(|d| d.claims)\n}\n\n#[derive(Debug, serde::Deserialize)]\nstruct Claims { sub: String }",
        "hint": "Validation::new(Algorithm::HS256) pins the algorithm; set_audience plus required claims closes cross-service token reuse; a 30-60 s leeway bounds the window in which an expired token still works.",
        "solution": "use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};\nuse serde::{Deserialize, Serialize};\n\n#[derive(Debug, Serialize, Deserialize)]\nstruct Claims {\n    sub: String,\n    aud: String,\n    iss: String,\n    exp: usize,\n}\n\nfn verify(token: &str, secret: &[u8]) -> Result<Claims, jsonwebtoken::errors::Error> {\n    // 1. Pin the algorithm: closes algorithm-confusion (alg = none, or\n    //    HS256 signed with an RSA public key).\n    let mut v = Validation::new(Algorithm::HS256);\n\n    // 2. Require and check aud/iss: closes cross-service token reuse.\n    v.set_audience(&[\"api.acme.internal\"]);\n    v.set_issuer(&[\"https://auth.acme.internal\"]);\n    v.set_required_spec_claims(&[\"exp\", \"iss\", \"aud\"]);\n\n    // 3. Bound clock skew to 30 s: an expired token works for 30 s, not a day.\n    v.leeway = 30;\n    v.validate_nbf = true;\n\n    let data = decode::<Claims>(token, &DecodingKey::from_secret(secret), &v)?;\n    Ok(data.claims)\n}\n\nfn main() {\n    let claims = Claims {\n        sub: \"user-1\".into(),\n        aud: \"api.acme.internal\".into(),\n        iss: \"https://auth.acme.internal\".into(),\n        exp: 4_102_444_800,\n    };\n    let token = jsonwebtoken::encode(\n        &jsonwebtoken::Header::new(Algorithm::HS256),\n        &claims,\n        &jsonwebtoken::EncodingKey::from_secret(b\"s3cret\"),\n    ).unwrap();\n\n    assert!(verify(&token, b\"s3cret\").is_ok());\n    assert!(verify(&token, b\"wrong\").is_err());\n}"
      },
      "questions": [
        {
          "q": "What makes algorithm confusion possible?",
          "options": [
            "Using HS256 instead of RS256",
            "The verifier choosing the algorithm from the token header instead of pinning it",
            "Tokens that are too long",
            "Missing rate limiting on the login endpoint"
          ],
          "answer": 1,
          "explain": "If the verifier dispatches on the header alg, an attacker can present an HS256 token signed with the service's public RSA key. Pinning the expected algorithm makes the header value irrelevant."
        },
        {
          "q": "Why set required_spec_claims to include aud?",
          "options": [
            "It makes tokens smaller",
            "Without it, a token that omits aud passes the audience check entirely",
            "It enables key rotation",
            "It changes the signature algorithm"
          ],
          "answer": 1,
          "explain": "Audience validation only runs when the claim is present. Requiring it turns omission into a rejection, which closes the cross-service token reuse path."
        },
        {
          "q": "A token verifies successfully. What else must be checked before returning a record?",
          "options": [
            "Nothing, the signature proves authorisation",
            "That the caller's scope permits the action and the record belongs to the caller's tenant",
            "That the token was issued in the last hour",
            "That the kid matches the newest key"
          ],
          "answer": 1,
          "explain": "Authentication answers who the caller is. Authorisation is a separate check per action and per object, and the missing object check is the most common real-world data leak."
        }
      ],
      "quickbytes": [
        "Pin the algorithm in the verifier; never dispatch on the header alg.",
        "Require exp, iss and aud, and keep leeway at 30-60 seconds.",
        "Compare secrets in constant time; compare password hashes through the hasher.",
        "Authentication is not authorisation: check scope and object ownership separately."
      ],
      "production": [
        "Cache JWKS with a short TTL and refresh on an unknown kid instead of rejecting.",
        "Accept the previous signing key for at least one token lifetime during rotation.",
        "Never log tokens, Authorization headers or full claim sets; log sub, kid and failure reason.",
        "Rate-limit token verification so unauthenticated traffic cannot burn CPU on signatures."
      ],
      "crates": [
        "jsonwebtoken",
        "subtle",
        "axum"
      ],
      "github": [
        {
          "name": "Keats/jsonwebtoken - decode, Validation and key types",
          "url": "https://github.com/Keats/jsonwebtoken"
        },
        {
          "name": "dalek-cryptography/subtle - constant-time comparisons",
          "url": "https://github.com/dalek-cryptography/subtle"
        }
      ],
      "pitfall": "Parsing the JWT payload with base64 before verifying the signature, then using a field from it. The payload is attacker-controlled until the signature checks out.",
      "resources": [
        {
          "title": "jsonwebtoken::Validation - every check and its default",
          "url": "https://docs.rs/jsonwebtoken/latest/jsonwebtoken/struct.Validation.html",
          "kind": "docs"
        },
        {
          "title": "jsonwebtoken crate documentation",
          "url": "https://docs.rs/jsonwebtoken/latest/jsonwebtoken/",
          "kind": "docs"
        },
        {
          "title": "Keats/jsonwebtoken repository",
          "url": "https://github.com/Keats/jsonwebtoken",
          "kind": "repo"
        },
        {
          "title": "RustSec advisory database - the failure modes in the wild",
          "url": "https://github.com/rustsec/advisory-db",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "t17",
      "title": "Performance: profile first, then remove work",
      "minutes": 75,
      "level": "industry",
      "goal": "Answer a performance question with a profile and a measurement, and pick the fix from the five categories that actually move Rust workloads.",
      "sections": [
        {
          "h": "The first sentence is always about measurement",
          "p": [
            "When an interviewer asks how you would make something faster, the wrong first move is a suggestion. The right first move is a question: what is the current number, and what is the target. Without those, optimisation is a guess with a benchmark attached. Then profile: perf record on Linux, cargo flamegraph for a quick flame graph, and an allocation profiler when the suspicion is allocator traffic.",
            "Read the profile before the source. A flame graph that is 40% in memcpy points at copies, not at algorithms. A flat profile spread across many small frames often means poor cache locality or bounds checking, not a missing data structure. The point of the exercise is to replace your intuition with the machine's, and then to say which evidence changed your mind."
          ],
          "code": "# 1. A reproducible load, not a vibe.\ncargo build --release\nhyperfine --warmup 3 './target/release/server --bench-mode' --runs 10\n\n# 2. CPU profile of the hot path.\ncargo install flamegraph\ncargo flamegraph --bin server -- --bench-mode\n# Linux alternative with call graphs and off-CPU time:\nperf record -g --call-graph dwarf -F 999 ./target/release/server --bench-mode\nperf report --stdio | head -40\n\n# 3. Allocation profile: count, not guesswork.\n#    heaptrack (Linux) or DHAT via valgrind --tool=dhat.\nheaptrack ./target/release/server --bench-mode\nheaptrack_print heaptrack.server.*.zst | head -30\n\n# 4. Compare before and after with the same binary, same machine.\ncriterion::Bencher::iter_batched keeps setup out of the measured region.",
          "tip": "Record the profile with release builds and production-like input sizes. A debug profile optimises the wrong code and an L1-sized input hides the memory bottleneck."
        },
        {
          "h": "The five fixes that actually move Rust workloads",
          "p": [
            "First, allocation: replace per-item Vec::new with a reused buffer, reserve with_capacity, and use SmallVec for short-lived small collections. Second, copies: borrow instead of clone, use Cow for sometimes-owned data, and use Bytes for cheap shared slices. Third, syscalls: batch writes, use buffered IO, and avoid a stat per file. Fourth, hashing: the default SipHash is DoS-resistant but slow, and a fast hasher is a legitimate win for integer keys in a trusted map.",
            "Fifth, contention: a global mutex on a hot counter serialises every core. Shard it, use per-thread accumulators flushed periodically, or an atomic with Relaxed ordering. Ordering these by expected impact is itself the answer: measure, attribute the time to a category, fix the largest, re-measure. If the profile says the time is in the kernel, the fix is batching or io_uring, not a better algorithm."
          ],
          "code": "use std::borrow::Cow;\nuse std::collections::HashMap;\n\n// Before: one allocation per call and a copy of every key.\nfn normalize_bad(input: &str) -> String {\n    input.trim().to_lowercase().replace(' ', \"-\")\n}\n\n// After: no allocation when the input is already normalized.\nfn normalize(input: &str) -> Cow<'_, str> {\n    let trimmed = input.trim();\n    if trimmed.bytes().all(|b| b.is_ascii_lowercase() || b == b'-') {\n        Cow::Borrowed(trimmed)\n    } else {\n        Cow::Owned(trimmed.to_lowercase().replace(' ', \"-\"))\n    }\n}\n\nfn main() {\n    // Reuse one buffer instead of allocating per row.\n    let mut out = String::with_capacity(4 * 1024);\n    for i in 0..1_000 {\n        out.push_str(&i.to_string());\n        out.push(',');\n    }\n    assert!(out.len() > 1_000);\n\n    // Reserve when the size is known: one allocation, no rehash growth.\n    let mut counts: HashMap<&str, u32> = HashMap::with_capacity(64);\n    for key in [\"a\", \"b\", \"a\"] {\n        *counts.entry(key).or_insert(0) += 1;\n    }\n    assert_eq!(counts[\"a\"], 2);\n\n    assert!(matches!(normalize(\" already-done \"), Cow::Borrowed(_)));\n    assert!(matches!(normalize(\"Not Done\"), Cow::Owned(_)));\n}",
          "tip": "If more than a third of the profile is in the allocator or memcpy, fix allocation and copying before touching the algorithm."
        },
        {
          "h": "Prove the win, then stop",
          "p": [
            "A performance claim needs three numbers: the baseline, the change, and the measurement conditions. Use a criterion benchmark for the function and a load test for the service, because they answer different questions. A 30% microbenchmark win that does not move p99 is a 30% win on a component that was not the bottleneck, and saying so is more impressive than the optimisation.",
            "Know when to stop. Optimisation has a cost in complexity, and complexity has a cost in incidents. If the target is met, stop and write down what you measured, on what hardware, with which build profile. The next engineer will otherwise re-litigate the same change from intuition, and you will have traded a maintainable design for a number nobody can reproduce."
          ],
          "tip": "Report the delta and the confidence interval. If the interval includes zero, you have not shown an improvement, you have shown noise."
        }
      ],
      "exercise": {
        "prompt": "This function allocates a String per line and clones every key. Reduce allocations without changing the signature, then state what you would measure to prove the win.",
        "starter": "fn index_lines(input: &str) -> std::collections::HashMap<String, usize> {\n    let mut map = std::collections::HashMap::new();\n    for (i, line) in input.lines().enumerate() {\n        let key = line.trim().to_string();\n        if key.is_empty() { continue; }\n        map.insert(key, i);\n    }\n    map\n}",
        "hint": "One allocation per key is unavoidable if the map owns keys, but you can reserve capacity from the line count. The bigger win is skipping the intermediate String when the key is empty, and returning &str keys with a lifetime when the caller's input outlives the map.",
        "solution": "use std::collections::HashMap;\n\n// Same signature, fewer allocations: reserve up front, avoid the\n// temporary String for blank lines, and do not re-allocate the key twice.\nfn index_lines(input: &str) -> HashMap<String, usize> {\n    let mut map = HashMap::with_capacity(input.lines().count());\n    for (i, line) in input.lines().enumerate() {\n        let trimmed = line.trim();\n        if trimmed.is_empty() {\n            continue; // no allocation for skipped lines\n        }\n        map.insert(trimmed.to_owned(), i);\n    }\n    map\n}\n\n// If the caller's input outlives the map, borrow instead of owning:\nfn index_borrowed(input: &str) -> HashMap<&str, usize> {\n    let mut map = HashMap::with_capacity(input.lines().count());\n    for (i, line) in input.lines().enumerate() {\n        let trimmed = line.trim();\n        if !trimmed.is_empty() {\n            map.insert(trimmed, i);\n        }\n    }\n    map\n}\n\nfn main() {\n    let text = \"alpha\\n\\nbeta\\n gamma \";\n    let owned = index_lines(text);\n    assert_eq!(owned.len(), 3);\n    assert_eq!(owned[\"gamma\"], 3);\n\n    let borrowed = index_borrowed(text);\n    assert_eq!(borrowed.len(), 3);\n\n    // What to measure: allocations per call (heaptrack), ns per line at\n    // 1k/100k/1M lines (criterion), and RSS for the borrowed version.\n    // The owned version allocates once per key; the borrowed version\n    // allocates only the map. Quote both, and say which one the caller\n    // can actually use given the lifetime.\n}"
      },
      "questions": [
        {
          "q": "A flame graph shows 45% of samples in memcpy. What is the most likely fix?",
          "options": [
            "Replace the hash map with a B-tree",
            "Remove copies: borrow instead of clone and use shared buffers",
            "Add more worker threads",
            "Switch to a faster allocator"
          ],
          "answer": 1,
          "explain": "memcpy time is copying, not lookup or scheduling. Reducing clones, using Cow or Bytes, and passing slices addresses the attributed cost; changing the data structure does not."
        },
        {
          "q": "When is a faster non-cryptographic hasher a legitimate choice?",
          "options": [
            "Always, because SipHash is legacy",
            "For integer keys in maps that are not fed by untrusted input",
            "For password hashing",
            "For any map reachable from a network request"
          ],
          "answer": 1,
          "explain": "SipHash's cost buys collision resistance against adversarial keys. Dropping it is safe only when the keys are trusted and the map is hot enough for hashing to matter."
        },
        {
          "q": "A microbenchmark improves 30% but service p99 does not move. What is the correct conclusion?",
          "options": [
            "The benchmark is wrong",
            "The optimised component was not on the critical path",
            "The service needs more replicas",
            "p99 is the wrong metric"
          ],
          "answer": 1,
          "explain": "Amdahl's law in practice: improving a component that consumes a small share of request time changes the total by that share. The microbenchmark is valid, just not where the time goes."
        }
      ],
      "quickbytes": [
        "Ask for the current number and the target before suggesting a change.",
        "cargo flamegraph for shape, perf for call graphs, heaptrack for allocation counts.",
        "If allocator plus memcpy is over a third of the profile, fix copies before algorithms.",
        "Report baseline, delta and conditions; if the interval includes zero, it is noise."
      ],
      "production": [
        "Keep a criterion benchmark per hot function and a load test per critical endpoint.",
        "Profile release builds with production-sized inputs, on the deployment CPU class.",
        "Track allocations per request as a metric; it moves before latency does.",
        "Write the measurement conditions next to the optimisation, or it will be re-litigated."
      ],
      "crates": [
        "criterion",
        "smallvec",
        "bytes",
        "rustc-hash"
      ],
      "github": [
        {
          "name": "flamegraph-rs/flamegraph - cargo flamegraph",
          "url": "https://github.com/flamegraph-rs/flamegraph"
        },
        {
          "name": "tokio-rs/bytes - cheap shared slices instead of copies",
          "url": "https://github.com/tokio-rs/bytes"
        }
      ],
      "pitfall": "Optimising based on a debug-build profile. Debug builds inline nothing, so the profile points at code that disappears entirely in release.",
      "resources": [
        {
          "title": "criterion - measurement model and reporting",
          "url": "https://docs.rs/criterion/latest/criterion/",
          "kind": "docs"
        },
        {
          "title": "std::hint::black_box - what it does and does not guarantee",
          "url": "https://doc.rust-lang.org/std/hint/fn.black_box.html",
          "kind": "docs"
        },
        {
          "title": "flamegraph-rs/flamegraph repository",
          "url": "https://github.com/flamegraph-rs/flamegraph",
          "kind": "repo"
        },
        {
          "title": "hyperfine - repeatable wall-clock comparisons",
          "url": "https://github.com/sharkdp/hyperfine",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "t18",
      "title": "Testing: the plan a senior writes in ten minutes",
      "minutes": 75,
      "level": "industry",
      "goal": "Assign each risk to the test level that can catch it, write a property test for an invariant, and use loom instead of sleeping to find races.",
      "sections": [
        {
          "h": "Pick the level from the risk",
          "p": [
            "A test plan is a mapping from risks to levels. Pure logic gets unit tests. Parsing, serialisation and normalisation get property tests, because the input space is the problem. Database queries get integration tests against a real engine, since a mock cannot tell you the SQL is invalid. Concurrency gets loom. Capacity and degradation get a load test. Anything that only a human can judge, such as a CLI's help text, gets a golden test.",
            "The failure mode to avoid is the inverted pyramid: hundreds of end-to-end tests that take forty minutes and fail for environmental reasons. Each one is slow, flaky, and tells you little about which component broke. Two integration tests that cover the wiring plus a property test on the core algorithm will catch more real bugs than twenty end-to-end scripts."
          ],
          "list": [
            "Unit: pure functions, error mapping, state machines",
            "Property: round-trip, idempotence, ordering, invariants over generated input",
            "Integration: SQL against Postgres, HTTP through the router, migrations",
            "loom: lock-free structures, hand-off protocols, once-init paths",
            "Load and soak: p99 budget, memory growth, connection pool behaviour"
          ],
          "tip": "Name the risk in the test name. test_rejects_expired_token_at_leeway_boundary tells the next engineer what breaks if it is deleted."
        },
        {
          "h": "Property tests find the input you did not imagine",
          "p": [
            "Example-based tests encode the cases you thought of. Property tests encode the rule and let the framework search for a counterexample, then shrink it to a minimal failing input. The highest-value properties are round-trips (encode then decode returns the original), invariants (merged ranges never overlap), idempotence (applying twice equals applying once), and equivalence with a slow reference implementation.",
            "proptest generates values from strategies and, on failure, writes a regression file so the case is replayed. That file is the artefact to commit: it turns a discovered counterexample into a permanent test. Watch for two traps. Generators that mostly produce trivial values prove nothing, and properties that assert too little, such as checking only that the function does not panic, catch only crashes."
          ],
          "code": "use proptest::prelude::*;\n\nfn merge_ranges(mut v: Vec<(u32, u32)>) -> Vec<(u32, u32)> {\n    if v.is_empty() { return v; }\n    for r in &mut v { if r.0 > r.1 { std::mem::swap(&mut r.0, &mut r.1); } }\n    v.sort_unstable();\n    let mut out = Vec::with_capacity(v.len());\n    let (mut start, mut end) = v[0];\n    for (a, b) in v.into_iter().skip(1) {\n        if a <= end.saturating_add(1) {\n            end = end.max(b);\n        } else {\n            out.push((start, end));\n            start = a;\n            end = b;\n        }\n    }\n    out.push((start, end));\n    out\n}\n\nproptest! {\n    #[test]\n    fn merged_is_sorted_disjoint_and_covers_every_input(\n        input in prop::collection::vec((0u32..10_000, 0u32..10_000), 0..64)\n    ) {\n        let normalized: Vec<(u32, u32)> = input\n            .iter()\n            .map(|&(a, b)| (a.min(b), a.max(b)))\n            .collect();\n        let out = merge_ranges(normalized.clone());\n\n        // Sorted by start.\n        prop_assert!(out.windows(2).all(|w| w[0].0 <= w[1].0));\n\n        // Disjoint and non-adjacent.\n        prop_assert!(out.windows(2).all(|w| w[0].1.saturating_add(1) < w[1].0));\n\n        // Every input point is covered by some output range.\n        for &(a, b) in &normalized {\n            for p in [a, b] {\n                prop_assert!(out.iter().any(|&(s, e)| s <= p && p <= e));\n            }\n        }\n    }\n}\n\nfn main() {\n    assert_eq!(merge_ranges(vec![(1, 3), (2, 5)]), vec![(1, 5)]);\n    assert_eq!(merge_ranges(vec![(1, 1), (3, 3)]), vec![(1, 1), (3, 3)]);\n}",
          "tip": "Commit proptest-regressions/ to the repository. A counterexample that is not committed will be rediscovered by someone else, or not at all."
        },
        {
          "h": "Concurrency needs a model, not a sleep",
          "p": [
            "Sleeping in a concurrency test makes it slow and still not deterministic: the failing interleaving may be one in a million. loom explores the interleavings under a model of the C11 memory order, so a bug in a hand-off protocol fails reliably instead of intermittently. The cost is intrusiveness: the code under test must use loom's types behind cfg(loom), which is why you model the primitive, not the service.",
            "Keep the model small. Two threads and one atomic is usually enough to find the missing Acquire. Bound the search with LOOM_MAX_PREEMPTIONS=2 or 3 and run it in release mode, because the model executes thousands of permutations. A loom test that takes four minutes in CI will be disabled within a month, so budget it as a nightly job rather than a per-commit gate."
          ],
          "code": "// tests/loom_handoff.rs\n// RUSTFLAGS=\"--cfg loom\" cargo test --test loom_handoff --release\n#![cfg(loom)]\n\nuse loom::sync::atomic::{AtomicBool, AtomicUsize, Ordering};\nuse loom::sync::Arc;\n\n#[test]\nfn consumer_never_reads_before_publish() {\n    loom::model(|| {\n        let ready = Arc::new(AtomicBool::new(false));\n        let value = Arc::new(AtomicUsize::new(0));\n\n        let (r, v) = (ready.clone(), value.clone());\n        let producer = loom::thread::spawn(move || {\n            v.store(42, Ordering::Relaxed);\n            r.store(true, Ordering::Release);\n        });\n\n        // Consumer: Acquire pairs with the producer's Release.\n        if ready.load(Ordering::Acquire) {\n            let seen = value.load(Ordering::Relaxed);\n            assert_eq!(seen, 42, \"consumer observed the flag before the value\");\n        }\n\n        producer.join().unwrap();\n    });\n}\n\n// If the store is Relaxed, loom finds the interleaving where the flag is\n// visible and the value is still 0. That failure is the whole point.",
          "tip": "Run loom with LOOM_MAX_PREEMPTIONS=3 in a nightly job; a four-minute model on every commit gets switched off within a month."
        }
      ],
      "exercise": {
        "prompt": "Write a property test for a function that deduplicates a Vec<String> while preserving first-occurrence order. Assert the properties that matter, not just that it does not panic.",
        "starter": "fn dedup_keep_order(items: Vec<String>) -> Vec<String> {\n    let mut seen = std::collections::HashSet::new();\n    items.into_iter().filter(|s| seen.insert(s.clone())).collect()\n}\n\n// TODO: proptest with a vec of short strings.\n// Properties: no duplicates, order matches first occurrence, same length\n// as the set of distinct values, and every input element is represented.",
        "hint": "Generate strings from a small alphabet so duplicates actually occur; a generator with 26^n possibilities will almost never produce a collision and the test will prove nothing.",
        "solution": "use proptest::prelude::*;\nuse std::collections::HashSet;\n\nfn dedup_keep_order(items: Vec<String>) -> Vec<String> {\n    let mut seen = HashSet::new();\n    items.into_iter().filter(|s| seen.insert(s.clone())).collect()\n}\n\nproptest! {\n    #[test]\n    fn dedup_preserves_first_occurrence_order(\n        // Small alphabet: duplicates are frequent, so the property bites.\n        items in prop::collection::vec(\"[abc]{1,3}\", 0..40)\n    ) {\n        let out = dedup_keep_order(items.clone());\n\n        // 1. No duplicates in the output.\n        let unique: HashSet<&String> = out.iter().collect();\n        prop_assert_eq!(unique.len(), out.len());\n\n        // 2. Output equals the distinct set in first-occurrence order.\n        let mut expected: Vec<String> = Vec::new();\n        let mut seen = HashSet::new();\n        for s in &items {\n            if seen.insert(s.clone()) { expected.push(s.clone()); }\n        }\n        prop_assert_eq!(&out, &expected);\n\n        // 3. Every input element appears in the output.\n        for s in &items {\n            prop_assert!(out.iter().any(|o| o == s));\n        }\n\n        // 4. Length equals the number of distinct inputs.\n        prop_assert_eq!(out.len(), items.iter().collect::<HashSet<_>>().len());\n    }\n\n    // Idempotence: applying twice changes nothing.\n    #[test]\n    fn dedup_is_idempotent(items in prop::collection::vec(\"[abc]{1,3}\", 0..40)) {\n        let once = dedup_keep_order(items);\n        let twice = dedup_keep_order(once.clone());\n        prop_assert_eq!(once, twice);\n    }\n}\n\nfn main() {\n    assert_eq!(\n        dedup_keep_order(vec![\"a\".into(), \"b\".into(), \"a\".into()]),\n        vec![\"a\".to_string(), \"b\".to_string()]\n    );\n}"
      },
      "questions": [
        {
          "q": "Which risk is a property test best at catching?",
          "options": [
            "A missing database index",
            "A normalisation function that fails on an input shape you did not think of",
            "A race between two threads",
            "A regression in CLI help text"
          ],
          "answer": 1,
          "explain": "Property tests search a generated input space and shrink failures. Races need loom, query plans need integration tests, and rendered text needs a golden test."
        },
        {
          "q": "Why generate strings from a small alphabet in a dedup property test?",
          "options": [
            "It makes the test compile faster",
            "Duplicates must actually occur for the property to exercise the dedup path",
            "proptest cannot generate long strings",
            "It avoids Unicode handling"
          ],
          "answer": 1,
          "explain": "With a large alphabet, collisions are vanishingly rare, so the generated cases are almost all duplicate-free and the property never tests the interesting branch."
        },
        {
          "q": "What is the main cost of using loom?",
          "options": [
            "It only works on nightly Rust",
            "The code under test must use loom's sync types behind a cfg, so it is intrusive",
            "It requires a GPU",
            "It disables the borrow checker"
          ],
          "answer": 1,
          "explain": "loom intercepts operations through its own types. That means a cfg-selected sync module and modelling small primitives rather than whole services."
        }
      ],
      "quickbytes": [
        "Map each risk to a level: unit, property, integration, loom, load.",
        "Property tests for round-trip, idempotence, ordering and invariants.",
        "Commit proptest-regressions/ so counterexamples become permanent tests.",
        "LOOM_MAX_PREEMPTIONS=3, release mode, nightly job; never per-commit."
      ],
      "production": [
        "Run integration tests against the real database version you deploy, via testcontainers.",
        "Make flaky tests a build failure, not a retry; retries hide real races.",
        "Keep the property suite under a minute by bounding generator sizes in CI.",
        "Assert on behaviour and error codes, not on log strings or internal call order."
      ],
      "crates": [
        "proptest",
        "loom",
        "insta",
        "tokio"
      ],
      "github": [
        {
          "name": "proptest-rs/proptest - strategies, shrinking, regressions",
          "url": "https://github.com/proptest-rs/proptest"
        },
        {
          "name": "tokio-rs/loom - deterministic concurrency models",
          "url": "https://github.com/tokio-rs/loom"
        }
      ],
      "pitfall": "A property test whose generator almost never produces the interesting input. It runs a thousand cases, proves nothing, and gives false confidence.",
      "resources": [
        {
          "title": "proptest - strategies and the regressions file",
          "url": "https://docs.rs/proptest/latest/proptest/",
          "kind": "docs"
        },
        {
          "title": "loom - model checking with pre-emption bounds",
          "url": "https://docs.rs/loom/latest/loom/",
          "kind": "docs"
        },
        {
          "title": "proptest-rs/proptest repository",
          "url": "https://github.com/proptest-rs/proptest",
          "kind": "repo"
        },
        {
          "title": "Simple Testing Can Prevent Most Critical Failures (OSDI 2014)",
          "url": "https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-yuan.pdf",
          "kind": "paper"
        }
      ]
    },
    {
      "id": "t19",
      "title": "Rust trivia: ten answers that separate levels",
      "minutes": 45,
      "level": "advanced",
      "goal": "Answer the fast factual questions precisely, including drop order, niche layout, overflow behaviour and object safety, without hedging.",
      "sections": [
        {
          "h": "Drop order, Copy, and layout",
          "p": [
            "Locals drop in reverse declaration order; struct fields drop in declaration order; tuple elements in order; array elements first to last. A value that is moved does not run its destructor at the old location. These four rules explain every drop-order puzzle, and the reference states them explicitly. If you remember only one, remember that fields drop in declaration order while locals drop in reverse, because that asymmetry is the usual trick.",
            "Copy is a marker for types whose duplication is a memcpy with no destructor: integers, bool, char, references, and tuples or arrays of Copy types. Clone is a method that may allocate. A type cannot be both Drop and Copy, because copying would run the destructor twice. Layout trivia follows from niche optimisation: Option<&T>, Option<Box<T>> and Option<NonZeroU32> are the same size as the inner type, because the null or zero value encodes None."
          ],
          "code": "use std::mem::size_of;\n\nstruct Loud(&'static str);\nimpl Drop for Loud {\n    fn drop(&mut self) { println!(\"drop {}\", self.0); }\n}\n\nstruct Pair { first: Loud, second: Loud }\n\nfn main() {\n    // Locals: reverse declaration order -> b then a.\n    let _a = Loud(\"local a\");\n    let _b = Loud(\"local b\");\n\n    // Fields: declaration order -> first then second.\n    let _p = Pair { first: Loud(\"field first\"), second: Loud(\"field second\") };\n\n    // Niche optimisation: no extra tag word for Option<&T>.\n    assert_eq!(size_of::<&u64>(), size_of::<Option<&u64>>());\n    assert_eq!(size_of::<Box<u64>>(), size_of::<Option<Box<u64>>>());\n    assert_eq!(size_of::<u32>(), size_of::<Option<std::num::NonZeroU32>>());\n\n    // But Option<u64> needs a tag: no niche in a full-range integer.\n    assert_eq!(size_of::<Option<u64>>(), 2 * size_of::<u64>());\n\n    // Copy types are duplicated bitwise; String is Clone, not Copy.\n    let n: u32 = 5;\n    let m = n;\n    assert_eq!((n, m), (5, 5));\n    let s = String::from(\"hi\");\n    let t = s.clone();\n    assert_eq!(s, t);\n}",
          "tip": "Say the rule, then the exception. 'Fields drop in declaration order, unlike locals, which drop in reverse' is a complete answer in one sentence."
        },
        {
          "h": "Overflow, panics, and release builds",
          "p": [
            "In debug builds, integer overflow panics. In release builds it wraps by default, because the overflow check costs a branch per operation. That difference means a test that passes in debug can produce a silently wrong number in production, which is the worst possible failure shape. If the value must not wrap, use checked_add, saturating_add or wrapping_add explicitly and make the intent visible.",
            "Panics unwind by default, running destructors, and can be caught with catch_unwind if the closure is UnwindSafe. With panic = abort, no destructors run and catch_unwind cannot help. A panic in a spawned tokio task does not kill the process: the JoinHandle returns a JoinError, which is why unawaited spawns swallow panics silently. Both facts come up in interviews because both cause real incidents."
          ],
          "code": "fn main() {\n    // Debug: panics. Release: wraps. Never rely on the default.\n    let max = u8::MAX;\n    let wrapped = max.wrapping_add(1);\n    assert_eq!(wrapped, 0);\n\n    // Make the intent explicit at the call site.\n    assert_eq!(max.checked_add(1), None);\n    assert_eq!(max.saturating_add(1), u8::MAX);\n\n    // Overflow checks can be forced on in release per profile:\n    // [profile.release]\n    // overflow-checks = true\n\n    // catch_unwind requires UnwindSafe and does nothing under panic=abort.\n    let result = std::panic::catch_unwind(|| {\n        let v: Vec<u8> = Vec::new();\n        v[0] // panics: index out of bounds\n    });\n    assert!(result.is_err());\n\n    // A panicking spawned task surfaces only if you await the handle.\n    let rt = tokio::runtime::Runtime::new().unwrap();\n    let err = rt.block_on(async {\n        let h = tokio::spawn(async { panic!(\"boom\") });\n        h.await.unwrap_err()\n    });\n    assert!(err.is_panic());\n}",
          "tip": "Set overflow-checks = true in the release profile for money, counters and anything security-relevant. The branch is cheap next to a silent wrong answer."
        },
        {
          "h": "Dispatch, object safety, and ?Sized",
          "p": [
            "impl Trait in argument position is generic: one instantiation per concrete type, statically dispatched. dyn Trait is a fat pointer with a vtable: one instantiation, dynamically dispatched, and the only option for heterogeneous collections. impl Trait in return position hides the concrete type, which is convenient and is a breaking change to un-hide later. Generic code is faster and bigger; dyn code is smaller and prevents inlining across the boundary.",
            "A trait is object safe if it has no generic methods, no methods returning Self by value, no associated constants, and no static methods without a Self: Sized bound. ?Sized relaxes the implicit Sized bound so a function can accept str, [T] or dyn Trait behind a reference. Those two facts answer most of the follow-ups, and saying 'object safety' rather than 'it does not work with dyn' signals that you know the rule rather than the symptom."
          ],
          "code": "trait Shape {\n    fn area(&self) -> f64;\n    // Object safe: &self receiver, no generics, no Self return.\n    fn name(&self) -> &'static str { \"shape\" }\n}\n\nstruct Circle(f64);\nstruct Square(f64);\n\nimpl Shape for Circle {\n    fn area(&self) -> f64 { std::f64::consts::PI * self.0 * self.0 }\n    fn name(&self) -> &'static str { \"circle\" }\n}\n\nimpl Shape for Square {\n    fn area(&self) -> f64 { self.0 * self.0 }\n}\n\n// Static dispatch: monomorphised per type.\nfn total_static<S: Shape>(shapes: &[S]) -> f64 {\n    shapes.iter().map(|s| s.area()).sum()\n}\n\n// Dynamic dispatch: one function, heterogeneous collection.\nfn total_dyn(shapes: &[Box<dyn Shape>]) -> f64 {\n    shapes.iter().map(|s| s.area()).sum()\n}\n\n// ?Sized: accept unsized types behind a reference.\nfn describe<T: ?Sized + std::fmt::Debug>(value: &T) -> String {\n    format!(\"{value:?}\")\n}\n\nfn main() {\n    let circles = vec![Circle(1.0), Circle(2.0)];\n    assert!(total_static(&circles) > 15.0);\n\n    let mixed: Vec<Box<dyn Shape>> = vec![Box::new(Circle(1.0)), Box::new(Square(3.0))];\n    assert!(total_dyn(&mixed) > 12.0);\n\n    assert_eq!(describe(\"text\"), \"\\\"text\\\"\");\n    assert_eq!(describe(&[1, 2][..]), \"[1, 2]\");\n}"
        }
      ],
      "exercise": {
        "prompt": "Predict the exact output of the drop-order program, then verify by running it. Then answer: why can a type not implement both Copy and Drop, and what is the size of Option<Box<()>>?",
        "starter": "struct Tag(&'static str);\nimpl Drop for Tag { fn drop(&mut self) { println!(\"{}\", self.0); } }\n\nstruct Holder { a: Tag, b: Tag }\n\nfn main() {\n    let _x = Tag(\"x\");\n    let _h = Holder { a: Tag(\"a\"), b: Tag(\"b\") };\n    let _y = Tag(\"y\");\n    // Predict the print order before running.\n}",
        "hint": "Locals drop in reverse declaration order, so y, then h, then x. Inside h, fields drop in declaration order, so a then b. The output is y, a, b, x.",
        "solution": "struct Tag(&'static str);\nimpl Drop for Tag { fn drop(&mut self) { println!(\"{}\", self.0); } }\n\nstruct Holder { a: Tag, b: Tag }\n\nfn main() {\n    let _x = Tag(\"x\");\n    let _h = Holder { a: Tag(\"a\"), b: Tag(\"b\") };\n    let _y = Tag(\"y\");\n    // Output: y, a, b, x\n    //\n    // y and x are locals, dropped in reverse declaration order.\n    // Inside Holder, fields drop in declaration order: a then b.\n}\n\n// Why Copy and Drop are mutually exclusive:\n// Copy means duplication is a bitwise memcpy that leaves the source usable.\n// Drop means the value owns a resource released exactly once. A Copy type\n// could be duplicated and both copies dropped, releasing the resource twice.\n//\n// size_of::<Option<Box<()>>>() == size_of::<Box<()>>() == 8 on 64-bit:\n// Box's non-null pointer is a niche, so None is encoded as the null pointer\n// and no tag word is needed."
      },
      "questions": [
        {
          "q": "In `let a = Tag(\"a\"); let b = Tag(\"b\");`, which drops first?",
          "options": [
            "a, because it was declared first",
            "b, because locals drop in reverse declaration order",
            "Both at the same time",
            "The order is unspecified"
          ],
          "answer": 1,
          "explain": "Locals drop in reverse order of declaration. Struct fields are the opposite: they drop in declaration order, which is the asymmetry these questions test."
        },
        {
          "q": "What is size_of::<Option<&u64>>() on a 64-bit target?",
          "options": [
            "16, because Option adds a tag byte plus padding",
            "8, because the null pointer is a niche encoding None",
            "4, because references are compressed",
            "Unspecified and not stable across compilations"
          ],
          "answer": 1,
          "explain": "A reference is never null, so None can reuse the null bit pattern. Option<&T>, Option<Box<T>> and Option<NonZeroU32> are all niche-optimised to the same size as the inner type."
        },
        {
          "q": "Which method prevents a trait from being used as dyn Trait?",
          "options": [
            "A method taking &self",
            "A generic method such as fn parse<T>(&self)",
            "A method with a default implementation",
            "A method returning &str"
          ],
          "answer": 1,
          "explain": "Generic methods make a trait not object safe because the vtable cannot contain an unbounded set of instantiations. &self receivers and default methods are fine."
        },
        {
          "q": "Integer overflow in a release build without overflow-checks does what?",
          "options": [
            "Panics like in debug",
            "Wraps around, silently producing a wrong value",
            "Returns an Err from the operation",
            "Traps at the CPU level"
          ],
          "answer": 1,
          "explain": "Release builds disable overflow checks by default and wrap. Use checked_, saturating_ or wrapping_ to make the intent explicit, or enable overflow-checks in the profile."
        }
      ],
      "quickbytes": [
        "Locals drop in reverse declaration order; struct fields drop in declaration order.",
        "A type cannot be both Copy and Drop: duplication would double-free.",
        "Option<&T>, Option<Box<T>> and Option<NonZeroU32> are niche-optimised, no tag word.",
        "Release overflow wraps by default; set overflow-checks = true where it matters."
      ],
      "production": [
        "Enable overflow-checks in release for money, counters and security-sensitive arithmetic.",
        "Await spawned JoinHandles, or a panicking task disappears without a log line.",
        "Avoid panic = abort in services that rely on catch_unwind for request isolation.",
        "Use #[repr(C)] only at FFI boundaries; elsewhere let the compiler choose layout."
      ],
      "crates": [
        "tokio",
        "bytemuck",
        "zerocopy"
      ],
      "github": [
        {
          "name": "rust-lang/reference - drop scopes and destructors",
          "url": "https://github.com/rust-lang/reference"
        },
        {
          "name": "rust-lang/rust - the niche-optimisation implementation",
          "url": "https://github.com/rust-lang/rust"
        }
      ],
      "pitfall": "Assuming a debug build's panic on overflow will also happen in production. Release wraps silently, and the wrong number propagates into billing or rate limits.",
      "resources": [
        {
          "title": "The Rust Reference: destructors and drop scopes",
          "url": "https://doc.rust-lang.org/reference/destructors.html",
          "kind": "docs"
        },
        {
          "title": "The Rustonomicon: data layout and repr",
          "url": "https://doc.rust-lang.org/nomicon/",
          "kind": "docs"
        },
        {
          "title": "rust-lang/reference repository",
          "url": "https://github.com/rust-lang/reference",
          "kind": "repo"
        },
        {
          "title": "Visualizing memory layout of Rust's data types",
          "url": "https://www.youtube.com/watch?v=rDoqT-a6UFg",
          "kind": "video"
        }
      ]
    },
    {
      "id": "t20",
      "title": "Mock interviews: running the 45-minute loop",
      "minutes": 90,
      "level": "industry",
      "goal": "Run three timed mock loops against an anchored rubric, score every dimension, and convert the weakest score into a specific drill.",
      "sections": [
        {
          "h": "Three loops, three rubrics",
          "p": [
            "A senior Rust loop usually has three shapes. The screening is 30 minutes of language depth: ownership, lifetimes, async, and one small coding exercise. The systems loop is 45 minutes on a design prompt with capacity numbers and failure modes. The debugging loop is 45 minutes on a broken service, where the interviewer watches how you form and discard hypotheses. Each shape scores different behaviour, so practising only coding is a partial preparation.",
            "Run each mock with a timer, a real interviewer or a recording, and a rubric filled in immediately afterwards. The value is not the score, it is the delta between what you thought you said and what the interviewer heard. Recording yourself is uncomfortable and is the fastest feedback loop available: you will hear the filler, the missing trade-off, and the answer you abandoned halfway."
          ],
          "list": [
            "Screening: 30 min, language depth plus one 20-line exercise",
            "Systems: 45 min, requirements, numbers, components, failure modes",
            "Debugging: 45 min, reproduce, measure, bisect, fix, prevent",
            "Behavioural: 30 min, four stories with numbers and a process change"
          ],
          "tip": "Book the mock with someone who will interrupt you. Interviews interrupt, and a mock that lets you monologue trains the wrong habit."
        },
        {
          "h": "Score dimensions, not vibes",
          "p": [
            "A rubric that produces a number you can act on needs three or four dimensions and anchored descriptors. Correctness: did the answer hold up under a follow-up. Trade-off reasoning: did you name the alternative and the cost. Communication: could the interviewer follow without interrupting to re-orient. Pace: did you leave time for the follow-up questions.",
            "Anchor each level with behaviour, not adjectives. A 4 in trade-off reasoning is 'named two alternatives, quantified the difference, and stated when the rejected one would win'. A 2 is 'named a technology without a reason'. With anchors, two interviewers score the same transcript similarly, which is what makes the rubric useful for self-review rather than flattering."
          ],
          "code": "# rubric.toml - score 1..4 per dimension, anchors written as behaviour.\n[dimensions.correctness]\nweight = 0.35\nanchors = { \"1\" = \"answer does not compile or is unsound\", \"2\" = \"works for the happy path only\", \"3\" = \"handles the follow-up on errors\", \"4\" = \"states invariants and proves them under a hostile input\" }\n\n[dimensions.tradeoffs]\nweight = 0.30\nanchors = { \"1\" = \"one option, no reason\", \"2\" = \"names a technology without cost\", \"3\" = \"names an alternative and its cost\", \"4\" = \"quantifies both and says when the rejected one wins\" }\n\n[dimensions.communication]\nweight = 0.20\nanchors = { \"1\" = \"interviewer had to re-orient repeatedly\", \"2\" = \"answer arrives late\", \"3\" = \"structure is followable\", \"4\" = \"signposts, checks in, and invites the follow-up\" }\n\n[dimensions.pace]\nweight = 0.15\nanchors = { \"1\" = \"ran out of time before the core\", \"2\" = \"rushed the end\", \"3\" = \"finished with time for one follow-up\", \"4\" = \"reserved time and used it to deepen the answer\" }\n\n# Hire bar for senior: no dimension below 2, weighted mean >= 3.0,\n# and tradeoffs >= 3. Anything else is a specific drill, not a rejection.\n[pass]\nmin_dimension = 2\nweighted_mean = 3.0",
          "tip": "Score immediately after the mock, before discussing it. Discussing first contaminates the score with the other person's framing."
        },
        {
          "h": "A transcript excerpt, and the feedback it earns",
          "p": [
            "Interviewer: 'This handler is 900 ms at p99 and the CPU is at 12%. Where do you look first?' Weak answer: 'I would add caching.' It is a solution with no measurement, and the CPU number contradicts it. Strong answer: '12% CPU with 900 ms means we are waiting, not computing. I would check the dependency latency and the pool acquire time first, then the runtime for tasks waiting on a lock.'",
            "The strong answer does three things in three sentences: it reads the evidence, it ranks two hypotheses, and it names the measurement that would separate them. That is the whole debugging rubric. The feedback for the weak answer is not 'know more about profiling', it is a drill: five symptoms, five first measurements, written down, until the reflex is to ask for a number before proposing a fix."
          ],
          "code": "# mock log - one line per question, scored the same evening.\n[[mock]]\ndate = \"2026-11-02\"\nloop = \"debugging\"\ninterviewer = \"staff engineer, payments\"\n\n[[mock.turns]]\nq = \"p99 900ms, CPU 12%, where do you look?\"\nscore = { correctness = 3, tradeoffs = 2, communication = 3, pace = 3 }\nnote = \"Read the evidence correctly, but proposed a fix before naming a measurement.\"\ndrill = \"Five symptom-to-first-measurement pairs, written from memory, twice this week.\"\n\n[[mock.turns]]\nq = \"How would you prove the fix worked?\"\nscore = { correctness = 4, tradeoffs = 3, communication = 4, pace = 3 }\nnote = \"Named a p99 budget in CI and a load test at the same rate; strongest answer of the loop.\"\ndrill = \"None. Reuse this framing in the systems loop.\"\n\n[[mock.summary]]\nweighted = 2.95\nweakest = \"tradeoffs\"\nnext_mock = \"2026-11-09, systems loop, same interviewer\"",
          "tip": "Every mock ends with one drill and one date. A score with no scheduled drill is a feeling, not a plan."
        }
      ],
      "exercise": {
        "prompt": "Run a 45-minute debugging mock on the '900 ms at p99, 12% CPU' prompt with a partner. Record it, score all four dimensions with the rubric, and write the one drill you will do before the next mock.",
        "starter": "# mock-plan.md\n- prompt: p99 900 ms, CPU 12%, throughput flat\n- timebox: 45 min (5 read, 10 clarify, 20 diagnose, 10 follow-ups)\n- rubric: correctness 35%, tradeoffs 30%, communication 20%, pace 15%\n- recording: yes\n- TODO: score immediately after, before discussing\n- TODO: one drill + one date",
        "hint": "The correct first move is to separate waiting from computing: dependency latency, pool acquire time, lock waits, runtime task state. If your answer proposes a fix in the first minute, the trade-off score is capped at 2.",
        "solution": "# mock-plan.md (filled in after the run)\n\n## Prompt\np99 900 ms, CPU 12%, throughput flat, error rate flat.\n\n## What a 4 looks like\n- Correctness: separates waiting from computing, names pool acquire time and\n  dependency latency as the two candidates, and says which measurement\n  distinguishes them.\n- Trade-offs: names caching as an option and rejects it *because* CPU is 12%,\n  so the cost is not compute.\n- Communication: signposts (\"three hypotheses, I will rank them\"), checks in.\n- Pace: leaves 10 minutes for the follow-up on proving the fix.\n\n## Score\ncorrectness 3, tradeoffs 2, communication 3, pace 3 -> weighted 2.75\n\n## Feedback\nProposed a fix before naming a measurement. The evidence reading was correct\nand the follow-up on proving the fix was strong.\n\n## Drill (before 2026-11-09)\nWrite five symptom-to-first-measurement pairs from memory, twice this week:\n1. high CPU, flat throughput -> per-task poll time, blocking call\n2. low CPU, high p99 -> dependency latency, pool acquire time, lock waits\n3. rising RSS -> allocation rate, cache growth, unbounded queue depth\n4. errors after deploy -> error-code delta by route, not log volume\n5. flat p50, spiky p99 -> GC-free but queueing: concurrency and pool size\n\n## Next mock\n2026-11-09, systems loop, same interviewer, same rubric."
      },
      "questions": [
        {
          "q": "What is the purpose of anchored descriptors in an interview rubric?",
          "options": [
            "To make the rubric longer and more official",
            "To make two scorers produce the same score from the same transcript",
            "To replace the interviewer's judgement entirely",
            "To rank candidates against each other"
          ],
          "answer": 1,
          "explain": "Anchors describe observable behaviour per level, so scoring is reproducible. Without them, a 3 means whatever the scorer felt that day and the feedback is not actionable."
        },
        {
          "q": "In a debugging mock, what does 900 ms p99 with 12% CPU tell you first?",
          "options": [
            "The service needs more CPU",
            "The time is spent waiting, so look at dependencies, pool acquire time and lock waits",
            "The load balancer is misconfigured",
            "The code needs more caching"
          ],
          "answer": 1,
          "explain": "Low CPU with high latency is a waiting problem. Caching is a compute or IO-reduction answer and does not follow from the evidence, which is why proposing it first caps the trade-off score."
        },
        {
          "q": "What makes mock-interview feedback actionable?",
          "options": [
            "A single overall score out of ten",
            "One dimension, one observed behaviour, one drill, one date",
            "A list of every topic to study",
            "A comparison with other candidates"
          ],
          "answer": 1,
          "explain": "A specific behaviour tied to a specific drill and a re-test date produces change. A broad study list produces anxiety and no measurable improvement."
        }
      ],
      "quickbytes": [
        "Three loops: 30-min screening, 45-min systems, 45-min debugging; rehearse each shape.",
        "Four dimensions with behavioural anchors: correctness, trade-offs, communication, pace.",
        "Score before discussing; discussion contaminates the score.",
        "Every mock ends with one drill and one re-test date."
      ],
      "production": [
        "Record the mock and review it within 24 hours, while the memory is accurate.",
        "Use the same rubric across mocks so week-over-week deltas are comparable.",
        "Book the next mock before leaving the current one; unscheduled practice does not happen.",
        "Keep a transcript log with scores so the remediation plan cites evidence, not impressions."
      ],
      "crates": [
        "serde",
        "toml",
        "criterion",
        "proptest"
      ],
      "github": [
        {
          "name": "criterion-rs/criterion.rs - the benchmark you cite in a performance answer",
          "url": "https://github.com/criterion-rs/criterion.rs"
        },
        {
          "name": "proptest-rs/proptest - the property test you cite in a testing answer",
          "url": "https://github.com/proptest-rs/proptest"
        }
      ],
      "pitfall": "Practising only the coding loop. Senior loops fail more often on trade-off reasoning and debugging narration than on syntax, and those are the two nobody rehearses.",
      "resources": [
        {
          "title": "Jon Gjengset: Considering Rust - the depth interviewers probe",
          "url": "https://www.youtube.com/watch?v=DnT-LUQgc7s",
          "kind": "video"
        },
        {
          "title": "Diego Ongaro: Designing for Understandability - The Raft Consensus Algorithm",
          "url": "https://www.youtube.com/watch?v=vYp4LYbnnW8",
          "kind": "video"
        },
        {
          "title": "Rust conference talk archive",
          "url": "https://www.youtube.com/@rustvideos",
          "kind": "video"
        },
        {
          "title": "In Search of an Understandable Consensus Algorithm (Raft)",
          "url": "https://raft.github.io/raft.pdf",
          "kind": "paper"
        },
        {
          "title": "The Cargo Book: semver compatibility - the API loop's source of truth",
          "url": "https://doc.rust-lang.org/cargo/reference/semver.html",
          "kind": "docs"
        }
      ]
    }
  ]
};
