/**
 * Rust fundamentals track.
 *
 * Authored for the Rust Academy plugin. Every lesson is plain JSON-compatible
 * data consumed by src/app.js through build.mjs.
 */
export default {
  "key": "foundations",
  "prefix": "l",
  "title": "Rust fundamentals",
  "blurb": "The language itself: ownership, types, traits, async basics, and the habits that make Rust code maintainable.",
  "level": "core",
  "project": {
    "title": "Capstone: a production-grade CLI toolkit",
    "brief": "Build a small but complete command-line toolkit that reads files, validates input, reports errors with context, is covered by tests, and ships as a single binary.",
    "deliverables": [
      "A clap-based CLI with subcommands and helpful --help output",
      "Errors that carry context and exit with meaningful codes",
      "Unit and integration tests, formatted and clippy-clean",
      "A GitHub Actions workflow that builds and tests on every push"
    ],
    "stack": [
      "clap",
      "anyhow",
      "thiserror",
      "serde",
      "tracing"
    ]
  },
  "lessons": [
    {
      "id": "l01",
      "n": 1,
      "title": "Hello, Cargo & Variables",
      "minutes": 30,
      "goal": "Run your first Rust program with Cargo and bind values to names.",
      "sections": [
        {
          "h": "Cargo is your workshop",
          "p": [
            "A Rust project is a folder with a Cargo.toml manifest. Cargo compiles the code, runs it, tests it, and downloads dependencies. These four commands cover most of your day:"
          ],
          "code": "cargo new hello       # create a project\ncargo run             # compile + run\ncargo check           # find errors fast, without a binary\ncargo test            # run tests",
          "tip": "While you edit, run cargo check rather than cargo run: it is much faster and gives you the same compiler errors."
        },
        {
          "h": "The shape of a program",
          "p": [
            "Every binary starts at a function named main. Statements end with a semicolon. println! prints a line of text."
          ],
          "code": "fn main() {\n    println!(\"Hello, Rust!\");\n}",
          "tip": "The ! means println is a macro, not a function. You will meet more macros later; for now just remember the bang."
        },
        {
          "h": "let binds a value",
          "p": [
            "Bindings are created with let. The compiler infers the type from the value, so you rarely write it out."
          ],
          "code": "fn main() {\n    let name = \"Ferris\";\n    let year = 2015;\n    println!(\"{} was born in {}\", name, year);\n}",
          "tip": "Each {} in a format string is filled by the next argument, in order."
        }
      ],
      "exercise": {
        "prompt": "Print one line that includes your name and how many lessons you plan to finish this week.",
        "starter": "fn main() {\n    // 1. bind a name\n    // 2. bind a lesson count\n    // 3. print both with println!\n}",
        "hint": "println!(\"{} will finish {} lessons this week!\", name, lessons) — placeholders are filled left to right.",
        "solution": "fn main() {\n    let name = \"Sai\";\n    let lessons = 5;\n    println!(\"{} will finish {} lessons this week!\", name, lessons);\n}"
      },
      "level": "core",
      "questions": [
        {
          "q": "What does cargo check do compared with cargo run?",
          "options": [
            "It compiles and executes the binary",
            "It type-checks and compiles without producing a runnable binary, so it is faster",
            "It formats the source and runs the tests",
            "It downloads dependencies but does not compile"
          ],
          "answer": 1,
          "explain": "cargo check runs the compiler front end and reports errors without the codegen/link step, so it is the fastest edit loop. cargo run compiles and executes."
        },
        {
          "q": "Given let name = \"Ferris\"; what is the type of name?",
          "options": [
            "String",
            "&str",
            "char",
            "Vec<u8>"
          ],
          "answer": 1,
          "explain": "String literals have type &'static str, a borrowed view of text baked into the binary. Build a String with String::from or to_string when you need ownership."
        }
      ],
      "quickbytes": [
        "Use cargo check for the fastest error loop; cargo run only when you need to execute.",
        "println! is a macro: the ! is mandatory and each {} is filled left to right.",
        "cargo new hello --bin scaffolds a binary; --lib scaffolds a library crate."
      ],
      "github": [
        {
          "name": "rust-lang/cargo",
          "url": "https://github.com/rust-lang/cargo"
        },
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        }
      ],
      "resources": [
        {
          "title": "The Rust Book — Getting started",
          "url": "https://doc.rust-lang.org/book/ch01-00-getting-started.html",
          "kind": "docs"
        },
        {
          "title": "The Cargo Book — Getting started",
          "url": "https://doc.rust-lang.org/cargo/getting-started/index.html",
          "kind": "docs"
        },
        {
          "title": "Let's Get Rusty - Rust tutorials (YouTube)",
          "url": "https://www.youtube.com/@letsgetrusty",
          "kind": "video"
        },
        {
          "title": "Rustlings practice exercises on GitHub",
          "url": "https://github.com/rust-lang/rustlings",
          "kind": "repo"
        }
      ],
      "crates": [
        "clap"
      ],
      "production": [
        "Commit Cargo.lock for binaries so builds are reproducible.",
        "Run cargo build --locked in CI to catch dependency drift."
      ]
    },
    {
      "id": "l02",
      "n": 2,
      "title": "Types & Mutability",
      "minutes": 35,
      "goal": "Know Rust's scalar types, and when a binding needs mut.",
      "sections": [
        {
          "h": "Every value has a type",
          "p": [
            "Rust is statically typed, but it infers types from how a value is used. When inference is not enough, annotate with a colon:"
          ],
          "code": "let count = 3;              // i32, the default integer\nlet ratio: f64 = 0.75;      // 64-bit float\nlet ready = true;           // bool\nlet letter = 'R';           // char, single quotes\nlet label = \"Rust\";         // &str, borrowed text",
          "tip": "Integers come in i8/i16/i32/i64/i128, their unsigned u* twins, and isize/usize for indexing."
        },
        {
          "h": "Immutability is the default",
          "p": [
            "A binding cannot be reassigned unless you opt in with mut. This is a feature: most values never change, and the compiler enforces it."
          ],
          "code": "let x = 5;\n// x = 6;                  // error: cannot assign twice to immutable binding\nlet mut y = 5;\ny = 6;                     // fine\nlet z = 5;\nlet z = z + 1;             // shadowing: a NEW binding, also fine"
        },
        {
          "h": "Constants",
          "p": [
            "const values are known at compile time, must be annotated, and live for the whole program."
          ],
          "code": "const MAX_POINTS: u32 = 100_000;\n\nfn main() {\n    println!(\"max = {}\", MAX_POINTS);\n}"
        }
      ],
      "exercise": {
        "prompt": "The program below does not compile. Make the smallest change so it prints area = 22.5.",
        "starter": "fn main() {\n    let width = 4.5;\n    let height = 3.0;\n    height = 5.0;            // fix me\n    let area = width * height;\n    println!(\"area = {}\", area);\n}",
        "hint": "Bindings are immutable unless declared mut. Change the declaration of height.",
        "solution": "fn main() {\n    let width = 4.5;\n    let mut height = 3.0;\n    height = 5.0;\n    let area = width * height;\n    println!(\"area = {}\", area);\n}"
      },
      "level": "core",
      "questions": [
        {
          "q": "Which snippet compiles and increments x?",
          "options": [
            "let x = 5; x += 1;",
            "let mut x = 5; x += 1;",
            "const x: i32 = 5; x += 1;",
            "let x: i32 = 5; x = 6;"
          ],
          "answer": 1,
          "explain": "Bindings are immutable by default. mut opts into reassignment; const values are fixed at compile time and still cannot be reassigned."
        },
        {
          "q": "What happens with let z = 5; let z = z + 1;?",
          "options": [
            "Compile error: cannot assign twice to an immutable binding",
            "A new binding shadows the old one, so z is 6",
            "The original binding is mutated in place and stays 5",
            "It panics at runtime"
          ],
          "answer": 1,
          "explain": "Shadowing creates a brand-new binding that hides the previous one; unlike mut, it can even change the type. The old binding is simply no longer reachable by that name."
        }
      ],
      "quickbytes": [
        "Default integer type is i32 and default float is f64; annotate when inference is ambiguous.",
        "Shadowing with let can change a binding's type; mut only allows reassignment.",
        "Integer literals accept underscores: 100_000; usize is the type used for indexing."
      ],
      "github": [
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        },
        {
          "name": "rust-lang/rustlings",
          "url": "https://github.com/rust-lang/rustlings"
        }
      ],
      "resources": [
        {
          "title": "The Rust Book — Data types",
          "url": "https://doc.rust-lang.org/book/ch03-02-data-types.html",
          "kind": "docs"
        },
        {
          "title": "Rust by Example — Primitives",
          "url": "https://doc.rust-lang.org/rust-by-example/primitives.html",
          "kind": "docs"
        },
        {
          "title": "Let's Get Rusty - Rust tutorials (YouTube)",
          "url": "https://www.youtube.com/@letsgetrusty",
          "kind": "video"
        }
      ],
      "crates": [
        "anyhow"
      ],
      "production": [
        "Annotate public function signatures; let inference handle locals.",
        "Run cargo clippy and fix numeric cast lints before merging."
      ]
    },
    {
      "id": "l03",
      "n": 3,
      "title": "Control Flow",
      "minutes": 40,
      "goal": "Branch with if and match, and loop with for, while and loop.",
      "sections": [
        {
          "h": "if is an expression",
          "p": [
            "An if block evaluates to a value, so it can initialise a binding. Both arms must have the same type."
          ],
          "code": "let n = 7;\nlet kind = if n % 2 == 0 { \"even\" } else { \"odd\" };\nprintln!(\"{} is {}\", n, kind);"
        },
        {
          "h": "Three loops",
          "p": [
            "loop repeats until you break. while repeats while a condition holds. for walks an iterator, which is what you want most of the time."
          ],
          "code": "for i in 0..3 {            // 0, 1, 2\n    println!(\"i = {}\", i);\n}\n\nlet mut count = 0;\nwhile count < 3 {\n    count += 1;\n}\n\nloop {\n    break;                    // exit\n}"
        },
        {
          "h": "match is exhaustive",
          "p": [
            "match compares a value against patterns and must cover every possibility. The compiler rejects a match that misses a case."
          ],
          "code": "let n = 2;\nmatch n {\n    1 => println!(\"one\"),\n    2 | 3 => println!(\"two or three\"),\n    other => println!(\"something else: {}\", other),\n}",
          "tip": "The _ pattern matches anything and ignores the value; a name like other matches anything and binds it."
        }
      ],
      "exercise": {
        "prompt": "Use a for loop to sum the even numbers from 1 to 10, then print the total.",
        "starter": "fn main() {\n    let mut total = 0;\n    // loop over 1..=10, add only the even numbers\n    println!(\"total = {}\", total);\n}",
        "hint": "Inside the loop, if n % 2 == 0 { total += n; } — or filter with (1..=10).filter(|n| n % 2 == 0).",
        "solution": "fn main() {\n    let mut total = 0;\n    for n in 1..=10 {\n        if n % 2 == 0 {\n            total += n;\n        }\n    }\n    println!(\"total = {}\", total);   // 30\n}"
      },
      "level": "core",
      "questions": [
        {
          "q": "What does let kind = if n % 2 == 0 { \"even\" } else { \"odd\" }; demonstrate about if?",
          "options": [
            "if is only a statement, so this line cannot compile",
            "if is an expression, and both arms must produce the same type",
            "The else branch is optional even when the if produces a value",
            "The braces around each arm are optional in Rust"
          ],
          "answer": 1,
          "explain": "An if block evaluates to a value, so it can initialise a binding. Both arms must have the same type because the compiler needs one type for the result."
        },
        {
          "q": "A match over an i32 covers only 1 and 2. What does the compiler do?",
          "options": [
            "It compiles and falls through to the first arm at runtime",
            "It fails to compile until every value is covered, for example with other => or _ =>",
            "It compiles but panics when an uncovered value appears",
            "It inserts a default arm returning ()"
          ],
          "answer": 1,
          "explain": "match is exhaustive: the compiler rejects a match that misses a case. Add a catch-all arm such as _ => or a binding like other =>."
        }
      ],
      "quickbytes": [
        "0..3 stops before 3; 0..=3 includes 3.",
        "match must be exhaustive: use _ to ignore the fallback value or a name to bind it.",
        "loop is the only loop that can return a value: break 42;"
      ],
      "github": [
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        },
        {
          "name": "rust-lang/rustlings",
          "url": "https://github.com/rust-lang/rustlings"
        }
      ],
      "resources": [
        {
          "title": "The Rust Book — Control flow",
          "url": "https://doc.rust-lang.org/book/ch03-05-control-flow.html",
          "kind": "docs"
        },
        {
          "title": "std — std::process::exit",
          "url": "https://doc.rust-lang.org/std/process/fn.exit.html",
          "kind": "docs"
        },
        {
          "title": "Let's Get Rusty - Rust tutorials (YouTube)",
          "url": "https://www.youtube.com/@letsgetrusty",
          "kind": "video"
        }
      ],
      "crates": [
        "itertools"
      ],
      "production": [
        "Prefer for loops and iterators over manual index arithmetic.",
        "Deny clippy::needless_range_loop so index bugs are caught."
      ]
    },
    {
      "id": "l04",
      "n": 4,
      "title": "Functions & Expressions",
      "minutes": 35,
      "goal": "Split work into typed functions and understand expression bodies.",
      "sections": [
        {
          "h": "Functions take typed parameters",
          "p": [
            "Parameters need explicit types; the return type follows an arrow. The last expression of a block is its value, so a function body can be a single expression without return."
          ],
          "code": "fn add(a: i32, b: i32) -> i32 {\n    a + b                 // no semicolon: this is the return value\n}\n\nfn main() {\n    println!(\"{}\", add(2, 3));\n}",
          "tip": "A semicolon turns an expression into a statement that produces (). Adding one after a + b would be a type error."
        },
        {
          "h": "Statements and early return",
          "p": [
            "Use return when you need to leave early. Statements before the tail expression run first."
          ],
          "code": "fn sign(n: i32) -> &'static str {\n    if n < 0 {\n        return \"negative\";\n    }\n    if n == 0 {\n        return \"zero\";\n    }\n    \"positive\"\n}"
        },
        {
          "h": "Functions own their parameters",
          "p": [
            "Passing a String by value moves it into the function. Passing a reference borrows it, which is usually what you want (Lesson 7)."
          ],
          "code": "fn shout(text: &str) {\n    println!(\"{}!\", text.to_uppercase());\n}\n\nfn main() {\n    let word = String::from(\"hello\");\n    shout(&word);          // borrow\n    println!(\"{}\", word);  // still usable\n}"
        }
      ],
      "exercise": {
        "prompt": "Write fn is_even(n: i32) -> bool, then print whether 42 is even.",
        "starter": "fn is_even(n: i32) -> bool {\n    // return true when n is divisible by 2\n}\n\nfn main() {\n    println!(\"42 is even: {}\", is_even(42));\n}",
        "hint": "The body can be the expression n % 2 == 0.",
        "solution": "fn is_even(n: i32) -> bool {\n    n % 2 == 0\n}\n\nfn main() {\n    println!(\"42 is even: {}\", is_even(42));\n}"
      },
      "level": "core",
      "questions": [
        {
          "q": "Why does fn add(a: i32, b: i32) -> i32 { a + b; } fail to compile?",
          "options": [
            "The function is missing the return keyword",
            "The semicolon turns a + b into a statement, so the body evaluates to ()",
            "a and b must be declared mut",
            "The return type should be ()"
          ],
          "answer": 1,
          "explain": "The last expression of a block is its value. A trailing semicolon discards that value and makes the block evaluate to (), which mismatches i32."
        },
        {
          "q": "shout takes &str, yet shout(&word) compiles when word is a String. Why?",
          "options": [
            "shout copies the String into the function",
            "&String coerces to &str through deref coercion at the call site",
            "&String and &str are the same type in Rust",
            "shout moves word because it takes a reference"
          ],
          "answer": 1,
          "explain": "Deref coercion turns &String into &str when the parameter is &str. That is why APIs should accept &str: they work with both literals and borrowed Strings."
        }
      ],
      "quickbytes": [
        "The final expression without a semicolon is the return value; a trailing semicolon yields ().",
        "Use return only for early exits; the tail expression is the idiomatic ending.",
        "Accept &str in parameters so both string literals and &String callers work."
      ],
      "github": [
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        },
        {
          "name": "rust-lang/rustlings",
          "url": "https://github.com/rust-lang/rustlings"
        }
      ],
      "resources": [
        {
          "title": "The Rust Book — Functions",
          "url": "https://doc.rust-lang.org/book/ch03-03-how-functions-work.html",
          "kind": "docs"
        },
        {
          "title": "The Rust Book — Generic functions",
          "url": "https://doc.rust-lang.org/book/ch10-01-syntax.html",
          "kind": "docs"
        },
        {
          "title": "Let's Get Rusty - Rust tutorials (YouTube)",
          "url": "https://www.youtube.com/@letsgetrusty",
          "kind": "video"
        }
      ],
      "crates": [
        "anyhow"
      ],
      "production": [
        "Keep functions small and return Result instead of panicking.",
        "Enable clippy::too_many_arguments and clippy::type_complexity."
      ]
    },
    {
      "id": "l05",
      "n": 5,
      "title": "Strings & Text",
      "minutes": 30,
      "goal": "Tell borrowed &str from owned String and inspect text safely.",
      "sections": [
        {
          "h": "&str and String",
          "p": [
            "&str is borrowed text you do not own. String is owned, growable heap text. String literals are &str; build a String when you need to change it."
          ],
          "code": "let literal = \"hello\";                 // &str\nlet mut owned = String::from(\"hello\"); // String\nowned.push_str(\" world\");\nprintln!(\"{}\", owned);                 // hello world\nprintln!(\"{}\", literal.len());         // 5 (bytes)",
          "tip": "len() counts bytes, not characters. Use chars().count() for characters."
        },
        {
          "h": "Formatting",
          "p": [
            "format! builds a new String; println! writes to stdout. {:?} prints the debug form of a value."
          ],
          "code": "let name = \"Ferris\";\nlet age = 10;\nlet line = format!(\"{} is {} years old\", name, age);\nprintln!(\"{:?}\", line);"
        },
        {
          "h": "Inspecting text",
          "p": [
            "These methods return new values; they do not mutate the original unless it is a &mut String."
          ],
          "code": "let s = \"  Rust is fun  \";\nprintln!(\"{}\", s.trim());                 // Rust is fun\nprintln!(\"{}\", s.trim().to_uppercase());  // RUST IS FUN\nfor word in s.split_whitespace() {\n    println!(\"{}\", word);\n}"
        }
      ],
      "exercise": {
        "prompt": "Count how many vowels (a, e, i, o, u) are in a string and print the count.",
        "starter": "fn main() {\n    let text = \"Rust is fun to learn\";\n    let mut vowels = 0;\n    // count the vowels\n    println!(\"vowels = {}\", vowels);\n}",
        "hint": "Iterate text.chars() and match the lowercase character against the five vowels.",
        "solution": "fn main() {\n    let text = \"Rust is fun to learn\";\n    let mut vowels = 0;\n    for ch in text.chars() {\n        match ch.to_ascii_lowercase() {\n            'a' | 'e' | 'i' | 'o' | 'u' => vowels += 1,\n            _ => {}\n        }\n    }\n    println!(\"vowels = {}\", vowels);\n}"
      },
      "level": "core",
      "questions": [
        {
          "q": "What does println!(\"{}\", \"héllo\".len()) print?",
          "options": [
            "5, because len counts characters",
            "6, because é takes two bytes in UTF-8",
            "7, because the string is padded",
            "It panics because the text is not ASCII"
          ],
          "answer": 1,
          "explain": "String::len returns the length in UTF-8 bytes. é is encoded as two bytes, so héllo is 6 bytes; chars().count() would return 5."
        },
        {
          "q": "Which line creates owned, growable text?",
          "options": [
            "let s = \"hi\";",
            "let s = String::from(\"hi\");",
            "let s = 'hi';",
            "let s = b\"hi\";"
          ],
          "answer": 1,
          "explain": "String::from allocates an owned String on the heap that you can grow with push_str. A bare literal is &str, 'hi' is not a valid char, and b\"hi\" is a byte string."
        }
      ],
      "quickbytes": [
        "len() counts UTF-8 bytes; chars().count() counts characters.",
        "Byte-slicing a String panics off a char boundary; prefer char_indices() or split().",
        "format! returns a new String; println! writes to stdout; {:?} prints Debug output."
      ],
      "github": [
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        },
        {
          "name": "rust-lang/rustlings",
          "url": "https://github.com/rust-lang/rustlings"
        }
      ],
      "resources": [
        {
          "title": "The Rust Book — Storing UTF-8 text",
          "url": "https://doc.rust-lang.org/book/ch08-02-strings.html",
          "kind": "docs"
        },
        {
          "title": "std — String",
          "url": "https://doc.rust-lang.org/std/string/struct.String.html",
          "kind": "docs"
        },
        {
          "title": "Let's Get Rusty - Rust tutorials (YouTube)",
          "url": "https://www.youtube.com/@letsgetrusty",
          "kind": "video"
        }
      ],
      "crates": [
        "regex"
      ],
      "production": [
        "Never slice user text by byte offsets; use char_indices or split.",
        "Treat len() as bytes and chars().count() as characters in APIs."
      ]
    },
    {
      "id": "l06",
      "n": 6,
      "title": "Ownership & Moves",
      "minutes": 45,
      "goal": "Understand why a value has exactly one owner, and when to clone.",
      "sections": [
        {
          "h": "Each value has one owner",
          "p": [
            "Stack values are copied. Heap values (String, Vec) have a single owner, and assigning one moves ownership: the old binding can no longer be used."
          ],
          "code": "let a = String::from(\"hello\");\nlet b = a;                  // ownership moves to b\n// println!(\"{}\", a);       // error: value borrowed after move\nprintln!(\"{}\", b);          // fine",
          "tip": "The compiler is not being fussy: two owners would mean two frees, which is exactly the double-free bug Rust prevents."
        },
        {
          "h": "clone and Copy",
          "p": [
            "clone() makes a deep copy of heap data. Types like i32, bool and char are Copy: assignment copies them and the original stays usable."
          ],
          "code": "let a = String::from(\"hello\");\nlet b = a.clone();          // deep copy\nprintln!(\"{} {}\", a, b);    // both usable\n\nlet x = 5;\nlet y = x;                  // copied, because i32 is Copy\nprintln!(\"{} {}\", x, y);"
        },
        {
          "h": "Ownership moves into functions",
          "p": [
            "Passing a value by value moves it. If the function does not give it back, the caller cannot use it again."
          ],
          "code": "fn consume(s: String) {\n    println!(\"{}\", s);\n}                           // s is dropped here\n\nfn main() {\n    let text = String::from(\"bye\");\n    consume(text);\n    // println!(\"{}\", text); // error: moved\n}"
        }
      ],
      "exercise": {
        "prompt": "The program below fails to compile. Fix it so both values print, without removing the final println.",
        "starter": "fn main() {\n    let a = String::from(\"hello\");\n    let b = a;\n    println!(\"{} {}\", a, b);   // fix me\n}",
        "hint": "a was moved into b. Either clone a, or print a before the move.",
        "solution": "fn main() {\n    let a = String::from(\"hello\");\n    let b = a.clone();\n    println!(\"{} {}\", a, b);\n}"
      },
      "level": "core",
      "questions": [
        {
          "q": "What happens here? let a = String::from(\"hi\"); let b = a; println!(\"{}\", a);",
          "options": [
            "It prints hi twice, because String is Copy",
            "It fails to compile: a was moved into b, so a is no longer valid",
            "It compiles but panics at runtime",
            "It fails because b must be declared mut"
          ],
          "answer": 1,
          "explain": "Assigning a String moves ownership to b and invalidates a. Fix it with a.clone() for a deep copy, or print a before the move."
        },
        {
          "q": "Why does Rust allow only one owner for heap data?",
          "options": [
            "To avoid allocating the value twice",
            "Two owners could each free the same allocation, causing a double free",
            "Because String does not implement Copy",
            "So that a garbage collector can reclaim memory"
          ],
          "answer": 1,
          "explain": "Ownership is what lets Rust insert a single drop per value. Two owners would mean two frees of the same allocation, the classic double-free bug."
        }
      ],
      "quickbytes": [
        "Assigning a String or Vec moves it; i32, bool and char are Copy and get copied.",
        "clone() is a deep copy: reach for it only when two owners are genuinely needed.",
        "Passing a value to a function moves it unless the parameter is a reference."
      ],
      "github": [
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        },
        {
          "name": "rust-lang/nomicon",
          "url": "https://github.com/rust-lang/nomicon"
        }
      ],
      "resources": [
        {
          "title": "The Rust Book — What is ownership?",
          "url": "https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html",
          "kind": "docs"
        },
        {
          "title": "The Rustonomicon — Ownership",
          "url": "https://doc.rust-lang.org/nomicon/ownership.html",
          "kind": "docs"
        },
        {
          "title": "Jon Gjengset - Rust deep dives (YouTube)",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        },
        {
          "title": "A Grounded Conceptual Model for Ownership Types in Rust (OOPSLA 2023)",
          "url": "https://arxiv.org/abs/2309.04134",
          "kind": "paper"
        }
      ],
      "crates": [
        "serde"
      ],
      "production": [
        "Do not clone() to silence borrow errors; redesign ownership instead.",
        "Take &str and &[T] in functions so ownership stays with the caller."
      ]
    },
    {
      "id": "l07",
      "n": 7,
      "title": "Borrowing & References",
      "minutes": 45,
      "goal": "Use & and &mut to lend values without moving them.",
      "sections": [
        {
          "h": "Borrow instead of moving",
          "p": [
            "A reference lets a function read a value without taking ownership. The owner keeps the value."
          ],
          "code": "fn length(s: &String) -> usize {\n    s.len()\n}\n\nfn main() {\n    let text = String::from(\"rust\");\n    let n = length(&text);\n    println!(\"{} has {} bytes\", text, n);   // text still owned here\n}"
        },
        {
          "h": "Mutable borrows are exclusive",
          "p": [
            "At any moment you may have either many immutable references or exactly one mutable reference — never both. This rule is what makes data races impossible."
          ],
          "code": "let mut s = String::from(\"rust\");\nlet r1 = &s;\nlet r2 = &s;\nprintln!(\"{} {}\", r1, r2);   // many shared borrows: fine\n\nlet m = &mut s;\nm.push_str(\"!\");\n// println!(\"{}\", r1);       // error: cannot borrow s while mutably borrowed",
          "tip": "Borrows end at their last use (non-lexical lifetimes), so code often compiles even when a variable stays in scope."
        },
        {
          "h": "The rules in one line",
          "p": [
            "Many readers or one writer. No value is used after its owner dies. References always point at valid data."
          ],
          "code": "fn main() {\n    let mut numbers = vec![1, 2, 3];\n    for n in &numbers {\n        println!(\"{}\", n);\n    }\n    numbers.push(4);          // fine: the shared borrows are over\n    println!(\"{:?}\", numbers);\n}"
        }
      ],
      "exercise": {
        "prompt": "The snippet has a borrow conflict. Reorder or narrow the borrow so it compiles.",
        "starter": "fn main() {\n    let mut s = String::from(\"rust\");\n    let r = &mut s;\n    s.push_str(\"!\");          // conflict: s is mutably borrowed\n    r.push_str(\"?\");\n    println!(\"{}\", r);\n}",
        "hint": "While r is alive, use r instead of s. Call r.push_str(\"!\") and print r.",
        "solution": "fn main() {\n    let mut s = String::from(\"rust\");\n    let r = &mut s;\n    r.push_str(\"!\");\n    println!(\"{}\", r);\n}"
      },
      "level": "core",
      "questions": [
        {
          "q": "Which set of borrows may exist at the same time?",
          "options": [
            "Many shared references plus one mutable reference",
            "Either many shared references or exactly one mutable reference",
            "Two mutable references at the same time",
            "A mutable reference and a shared reference if neither is printed"
          ],
          "answer": 1,
          "explain": "The aliasing rule is many readers XOR one writer. Shared borrows can coexist; a mutable borrow is exclusive while it is live."
        },
        {
          "q": "Why is numbers.push(4) allowed after for n in &numbers { ... }?",
          "options": [
            "Vec is Copy, so the loop worked on a copy",
            "The shared borrows end at their last use, so push is allowed afterwards",
            "for loops do not borrow their iterator",
            "push takes &mut self and the borrow checker ignores it"
          ],
          "answer": 1,
          "explain": "Non-lexical lifetimes end a borrow at its last use. Once the loop is done the shared borrows are over, so an exclusive borrow for push is legal."
        }
      ],
      "quickbytes": [
        "Many shared borrows or one mutable borrow, never both at the same time.",
        "Borrows end at their last use (NLL), not at the closing brace of the block.",
        "Prefer &T, &str and &[T] in signatures; take ownership only when you need it."
      ],
      "github": [
        {
          "name": "rust-lang/nomicon",
          "url": "https://github.com/rust-lang/nomicon"
        },
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        }
      ],
      "resources": [
        {
          "title": "The Rust Book — References and borrowing",
          "url": "https://doc.rust-lang.org/book/ch04-02-references-and-borrowing.html",
          "kind": "docs"
        },
        {
          "title": "The Rustonomicon — Aliasing",
          "url": "https://doc.rust-lang.org/nomicon/aliasing.html",
          "kind": "docs"
        },
        {
          "title": "Jon Gjengset - Rust deep dives (YouTube)",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        },
        {
          "title": "The Usability of Ownership (HATRA @ SPLASH 2020)",
          "url": "https://arxiv.org/abs/2011.06171",
          "kind": "paper"
        }
      ],
      "crates": [
        "serde"
      ],
      "production": [
        "Keep mutable borrows short; a block often ends them earlier.",
        "Return references tied to inputs instead of cloning data."
      ]
    },
    {
      "id": "l08",
      "n": 8,
      "title": "Slices",
      "minutes": 30,
      "goal": "Point at part of a collection without copying it.",
      "sections": [
        {
          "h": "A slice is a view",
          "p": [
            "A slice is a reference to a contiguous run of elements. It knows its length but owns nothing."
          ],
          "code": "let v = vec![10, 20, 30, 40];\nlet middle = &v[1..3];        // [20, 30]\nprintln!(\"{:?}\", middle);\n\nlet text = String::from(\"hello world\");\nlet hello = &text[..5];\nprintln!(\"{}\", hello);",
          "tip": "Slicing a String by byte index panics if the index is not a char boundary. Prefer split/char_indices for user text."
        },
        {
          "h": "String slices in signatures",
          "p": [
            "Take &str rather than &String: &str accepts both string literals and borrowed Strings, so the function is more flexible."
          ],
          "code": "fn first_word(s: &str) -> &str {\n    for (i, ch) in s.char_indices() {\n        if ch == ' ' {\n            return &s[..i];\n        }\n    }\n    s\n}\n\nfn main() {\n    println!(\"{}\", first_word(\"hello world\"));\n}"
        },
        {
          "h": "Why slices are safe",
          "p": [
            "A slice keeps the borrow alive, so the owner cannot be mutated or dropped while the slice is in use."
          ],
          "code": "fn main() {\n    let mut data = vec![1, 2, 3];\n    let head = &data[0];\n    // data.push(4);          // error: cannot mutate while borrowed\n    println!(\"{}\", head);\n}"
        }
      ],
      "exercise": {
        "prompt": "Write fn first_word(s: &str) -> &str that returns the text before the first space.",
        "starter": "fn first_word(s: &str) -> &str {\n    // return the slice before the first space\n}\n\nfn main() {\n    println!(\"{}\", first_word(\"borrow the data\"));\n}",
        "hint": "Loop over s.char_indices(), return &s[..i] when you find a space, and return s if there is none.",
        "solution": "fn first_word(s: &str) -> &str {\n    for (i, ch) in s.char_indices() {\n        if ch == ' ' {\n            return &s[..i];\n        }\n    }\n    s\n}\n\nfn main() {\n    println!(\"{}\", first_word(\"borrow the data\"));\n}"
      },
      "level": "core",
      "questions": [
        {
          "q": "let v = vec![10, 20, 30, 40]; let middle = &v[1..3]; What is middle?",
          "options": [
            "[10, 20]",
            "[20, 30]",
            "[30, 40]",
            "It panics because the range is invalid"
          ],
          "answer": 1,
          "explain": "The range 1..3 is half-open: it selects indexes 1 and 2, so the slice is [20, 30]. A slice is a borrowed view with a length, not a copy."
        },
        {
          "q": "Why can &text[..5] panic even when 5 <= text.len()?",
          "options": [
            "Because 5 is not a char boundary in text",
            "Because String indexing always needs usize",
            "Because the slice is immutable",
            "Because text is empty"
          ],
          "answer": 0,
          "explain": "String slicing works on byte offsets and panics if the offset splits a multi-byte character. Use char_indices or split for user text."
        }
      ],
      "quickbytes": [
        "&v[1..3] is a view into v: no copy and no allocation, just a borrow.",
        "Take &str instead of &String and &[T] instead of &Vec<T> for flexible APIs.",
        "A slice keeps its owner borrowed, so no mutation or drop while it is alive."
      ],
      "github": [
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        },
        {
          "name": "rust-lang/rustlings",
          "url": "https://github.com/rust-lang/rustlings"
        }
      ],
      "resources": [
        {
          "title": "The Rust Book — The Slice type",
          "url": "https://doc.rust-lang.org/book/ch04-03-slices.html",
          "kind": "docs"
        },
        {
          "title": "std — Primitive slice",
          "url": "https://doc.rust-lang.org/std/primitive.slice.html",
          "kind": "docs"
        },
        {
          "title": "fasterthanlime - Rust videos (YouTube)",
          "url": "https://www.youtube.com/@fasterthanlime",
          "kind": "video"
        }
      ],
      "crates": [
        "memchr"
      ],
      "production": [
        "Use &str and &[T] in public APIs to accept borrowed views.",
        "Document byte-index assumptions for any String slicing."
      ]
    },
    {
      "id": "l09",
      "n": 9,
      "title": "Structs & Methods",
      "minutes": 40,
      "goal": "Group related data and attach behaviour to it.",
      "sections": [
        {
          "h": "Define a struct",
          "p": [
            "Structs name a set of fields. The field-init shorthand reuses a variable with the same name."
          ],
          "code": "struct User {\n    name: String,\n    active: bool,\n}\n\nfn main() {\n    let name = String::from(\"Ferris\");\n    let user = User { name, active: true };\n    println!(\"{} {}\", user.name, user.active);\n}"
        },
        {
          "h": "Methods live in impl",
          "p": [
            "Methods take self, &self or &mut self. Associated functions have no self and are called with ::."
          ],
          "code": "struct Rectangle {\n    width: u32,\n    height: u32,\n}\n\nimpl Rectangle {\n    fn area(&self) -> u32 {\n        self.width * self.height\n    }\n\n    fn square(size: u32) -> Rectangle {\n        Rectangle { width: size, height: size }\n    }\n}\n\nfn main() {\n    let r = Rectangle::square(4);\n    println!(\"{}\", r.area());      // 16\n}"
        },
        {
          "h": "Deriving common traits",
          "p": [
            "derive asks the compiler to generate standard implementations for you."
          ],
          "code": "#[derive(Debug, Clone, PartialEq)]\nstruct Point {\n    x: i32,\n    y: i32,\n}\n\nfn main() {\n    let p = Point { x: 1, y: 2 };\n    println!(\"{:?}\", p);\n    assert_eq!(p, p.clone());\n}"
        }
      ],
      "exercise": {
        "prompt": "Add a can_hold method that returns true when self is big enough to contain another rectangle.",
        "starter": "struct Rectangle {\n    width: u32,\n    height: u32,\n}\n\nimpl Rectangle {\n    fn area(&self) -> u32 {\n        self.width * self.height\n    }\n    // add can_hold(&self, other: &Rectangle) -> bool\n}\n\nfn main() {\n    let a = Rectangle { width: 10, height: 8 };\n    let b = Rectangle { width: 4, height: 3 };\n    println!(\"can hold: {}\", a.can_hold(&b));\n}",
        "hint": "Compare both dimensions: self.width >= other.width && self.height >= other.height.",
        "solution": "struct Rectangle {\n    width: u32,\n    height: u32,\n}\n\nimpl Rectangle {\n    fn area(&self) -> u32 {\n        self.width * self.height\n    }\n\n    fn can_hold(&self, other: &Rectangle) -> bool {\n        self.width >= other.width && self.height >= other.height\n    }\n}\n\nfn main() {\n    let a = Rectangle { width: 10, height: 8 };\n    let b = Rectangle { width: 4, height: 3 };\n    println!(\"can hold: {}\", a.can_hold(&b));\n}"
      },
      "level": "advanced",
      "questions": [
        {
          "q": "Why is Rectangle::square(4) called with :: and not .?",
          "options": [
            "It is a method, so it needs an instance",
            "It is an associated function without self, so it is called on the type",
            "It mutates the Rectangle in place",
            "It is a trait method that must be imported"
          ],
          "answer": 1,
          "explain": "Associated functions live in impl but take no self, so they are called through the type with ::. Methods take self, &self or &mut self and use dot syntax."
        },
        {
          "q": "What does #[derive(Debug, Clone, PartialEq)] do?",
          "options": [
            "It runs trait implementations at runtime via reflection",
            "It asks the compiler to generate those trait implementations",
            "It makes every struct field public",
            "It enables struct inheritance"
          ],
          "answer": 1,
          "explain": "derive is a macro that generates impls of Debug, Clone, PartialEq and similar traits at compile time, saving boilerplate."
        }
      ],
      "quickbytes": [
        "Choose the weakest receiver that works: &self, then &mut self, then self.",
        "Field-init shorthand User { name, active: true } reuses a local variable named name.",
        "Derive Debug early; {:?} is the quickest way to inspect a struct."
      ],
      "github": [
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        },
        {
          "name": "rust-lang/rustlings",
          "url": "https://github.com/rust-lang/rustlings"
        }
      ],
      "resources": [
        {
          "title": "The Rust Book — Using structs",
          "url": "https://doc.rust-lang.org/book/ch05-00-structs.html",
          "kind": "docs"
        },
        {
          "title": "The Rust Book — Method syntax",
          "url": "https://doc.rust-lang.org/book/ch05-03-method-syntax.html",
          "kind": "docs"
        },
        {
          "title": "Let's Get Rusty - Rust tutorials (YouTube)",
          "url": "https://www.youtube.com/@letsgetrusty",
          "kind": "video"
        }
      ],
      "crates": [
        "serde"
      ],
      "production": [
        "Derive Debug/Clone/PartialEq only when actually needed.",
        "Keep behaviour on the type that owns the data; avoid anemic structs."
      ]
    },
    {
      "id": "l10",
      "n": 10,
      "title": "Enums & Pattern Matching",
      "minutes": 45,
      "goal": "Model alternatives with data, and destructure them with match.",
      "sections": [
        {
          "h": "Enums hold data",
          "p": [
            "An enum value is exactly one of its variants, and each variant can carry its own data."
          ],
          "code": "enum Message {\n    Quit,\n    Move { x: i32, y: i32 },\n    Write(String),\n}\n\nfn main() {\n    let m = Message::Move { x: 3, y: 4 };\n    match m {\n        Message::Quit => println!(\"quit\"),\n        Message::Move { x, y } => println!(\"move to {}, {}\", x, y),\n        Message::Write(text) => println!(\"write {}\", text),\n    }\n}"
        },
        {
          "h": "Option is an enum",
          "p": [
            "Option<T> is Some(T) or None. It replaces null: the compiler forces you to handle the empty case."
          ],
          "code": "fn half(n: i32) -> Option<i32> {\n    if n % 2 == 0 { Some(n / 2) } else { None }\n}\n\nfn main() {\n    match half(10) {\n        Some(v) => println!(\"half = {}\", v),\n        None => println!(\"odd\"),\n    }\n\n    if let Some(v) = half(8) {\n        println!(\"half = {}\", v);\n    }\n}"
        },
        {
          "h": "match can bind and guard",
          "p": [
            "Patterns can bind parts of a value and add conditions with if."
          ],
          "code": "let pair = (0, 5);\nmatch pair {\n    (0, y) => println!(\"on the y axis at {}\", y),\n    (x, 0) => println!(\"on the x axis at {}\", x),\n    (x, y) if x == y => println!(\"diagonal at {}\", x),\n    (x, y) => println!(\"somewhere at {}, {}\", x, y),\n}"
        }
      ],
      "exercise": {
        "prompt": "Model a Shape enum with Circle(f64) and Rectangle(f64, f64), then compute the area in a match.",
        "starter": "enum Shape {\n    Circle(f64),\n    Rectangle(f64, f64),\n}\n\nfn area(shape: &Shape) -> f64 {\n    // match on the shape\n}\n\nfn main() {\n    println!(\"{}\", area(&Shape::Circle(2.0)));\n    println!(\"{}\", area(&Shape::Rectangle(3.0, 4.0)));\n}",
        "hint": "std::f64::consts::PI is available. Match Circle(r) => PI * r * r and Rectangle(w, h) => w * h.",
        "solution": "enum Shape {\n    Circle(f64),\n    Rectangle(f64, f64),\n}\n\nfn area(shape: &Shape) -> f64 {\n    match shape {\n        Shape::Circle(r) => std::f64::consts::PI * r * r,\n        Shape::Rectangle(w, h) => w * h,\n    }\n}\n\nfn main() {\n    println!(\"{}\", area(&Shape::Circle(2.0)));\n    println!(\"{}\", area(&Shape::Rectangle(3.0, 4.0)));\n}"
      },
      "level": "advanced",
      "questions": [
        {
          "q": "What does Option<T> guarantee that a null pointer does not?",
          "options": [
            "Option is a nullable pointer that can be dereferenced blindly",
            "The compiler forces you to handle both Some and None before using the value",
            "None is the same as 0",
            "unwrap is the only way to read an Option"
          ],
          "answer": 1,
          "explain": "Option is an enum with a Some and a None case, so the type system makes the absent case explicit; there is no implicit null to forget."
        },
        {
          "q": "A match on Message lists only Quit and Move, omitting Write. What happens?",
          "options": [
            "The program panics at runtime when Write occurs",
            "The match fails to compile until every variant is covered",
            "The omitted variant is silently ignored",
            "The compiler picks the first arm as a default"
          ],
          "answer": 1,
          "explain": "Enums are matched exhaustively, so a missing variant is a compile error. Add the Write arm or a _ fallback if you truly ignore it."
        }
      ],
      "quickbytes": [
        "Option replaces null: the compiler forces you to handle None.",
        "if let Some(v) = value { ... } is the one-arm shortcut for a full match.",
        "Match guards add conditions: (x, y) if x == y => ..."
      ],
      "github": [
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        },
        {
          "name": "rust-lang/rustlings",
          "url": "https://github.com/rust-lang/rustlings"
        }
      ],
      "resources": [
        {
          "title": "The Rust Book — Enums and pattern matching",
          "url": "https://doc.rust-lang.org/book/ch06-00-enums.html",
          "kind": "docs"
        },
        {
          "title": "std — Option",
          "url": "https://doc.rust-lang.org/std/option/index.html",
          "kind": "docs"
        },
        {
          "title": "Let's Get Rusty - Rust tutorials (YouTube)",
          "url": "https://www.youtube.com/@letsgetrusty",
          "kind": "video"
        }
      ],
      "crates": [
        "serde"
      ],
      "production": [
        "Model states as enums so impossible states cannot be constructed.",
        "Prefer exhaustive matches over _ so new variants fail compilation."
      ]
    },
    {
      "id": "l11",
      "n": 11,
      "title": "Option, Result & Error Handling",
      "minutes": 50,
      "goal": "Handle absence and failure explicitly instead of crashing.",
      "sections": [
        {
          "h": "Option: a value may be absent",
          "p": [
            "Use Option combinators to avoid nested matches. unwrap_or supplies a default; map transforms the value when present."
          ],
          "code": "let maybe: Option<i32> = Some(3);\nprintln!(\"{}\", maybe.unwrap_or(0));       // 3\nprintln!(\"{}\", maybe.map(|n| n * 2).unwrap_or(0)); // 6\n\nlet empty: Option<i32> = None;\nprintln!(\"{}\", empty.unwrap_or(-1));      // -1",
          "tip": "unwrap() panics on None. It is fine in prototypes and tests, but libraries should return Option or Result."
        },
        {
          "h": "Result: an operation may fail",
          "p": [
            "Result<T, E> is Ok(T) or Err(E). Parsing is the classic example."
          ],
          "code": "let good = \"42\".parse::<i32>();\nlet bad = \"nope\".parse::<i32>();\n\nmatch good {\n    Ok(n) => println!(\"parsed {}\", n),\n    Err(e) => println!(\"failed: {}\", e),\n}\n\nprintln!(\"{:?}\", bad.is_err());"
        },
        {
          "h": "The ? operator",
          "p": [
            "Inside a function returning Result, ? returns early on Err and unwraps on Ok. main can return Result too."
          ],
          "code": "use std::num::ParseIntError;\n\nfn double(text: &str) -> Result<i32, ParseIntError> {\n    let n: i32 = text.parse()?;   // early-returns the error\n    Ok(n * 2)\n}\n\nfn main() -> Result<(), ParseIntError> {\n    println!(\"{}\", double(\"21\")?);\n    Ok(())\n}"
        }
      ],
      "exercise": {
        "prompt": "Write fn parse_positive(text: &str) -> Result<u32, String> that parses and rejects zero.",
        "starter": "fn parse_positive(text: &str) -> Result<u32, String> {\n    // parse as u32, then reject 0 with a useful message\n}\n\nfn main() {\n    println!(\"{:?}\", parse_positive(\"7\"));\n    println!(\"{:?}\", parse_positive(\"0\"));\n    println!(\"{:?}\", parse_positive(\"x\"));\n}",
        "hint": "Use text.parse::<u32>().map_err(|e| e.to_string())? and then check the value.",
        "solution": "fn parse_positive(text: &str) -> Result<u32, String> {\n    let n = text.parse::<u32>().map_err(|e| e.to_string())?;\n    if n == 0 {\n        return Err(String::from(\"must be greater than zero\"));\n    }\n    Ok(n)\n}\n\nfn main() {\n    println!(\"{:?}\", parse_positive(\"7\"));\n    println!(\"{:?}\", parse_positive(\"0\"));\n    println!(\"{:?}\", parse_positive(\"x\"));\n}"
      },
      "level": "advanced",
      "questions": [
        {
          "q": "Inside fn double(text: &str) -> Result<i32, ParseIntError>, what does the ? after text.parse() do on Err?",
          "options": [
            "It panics with the error message",
            "It returns early with the error, converted into the function's error type",
            "It retries the parse operation",
            "It logs the error and continues with a default value"
          ],
          "answer": 1,
          "explain": "? unwraps Ok and early-returns Err, applying From so the error converts to the function's error type. That is why main can return Result too."
        },
        {
          "q": "let maybe: Option<i32> = None; maybe.map(|n| n * 2).unwrap_or(0) evaluates to what?",
          "options": [
            "0",
            "None",
            "It panics because map cannot run on None",
            "2"
          ],
          "answer": 0,
          "explain": "map leaves None untouched, and unwrap_or(0) turns the None into 0. With Some(3) the chain would give 6."
        }
      ],
      "quickbytes": [
        "unwrap() panics on None/Err; unwrap_or(default) is total and safer in libraries.",
        "Libraries: a precise error enum with thiserror. Applications: anyhow with context.",
        "main can return Result<(), E>, so ? works at the top level too."
      ],
      "github": [
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        },
        {
          "name": "rust-lang/rustlings",
          "url": "https://github.com/rust-lang/rustlings"
        }
      ],
      "resources": [
        {
          "title": "The Rust Book — Error handling",
          "url": "https://doc.rust-lang.org/book/ch09-00-error-handling.html",
          "kind": "docs"
        },
        {
          "title": "std — Result",
          "url": "https://doc.rust-lang.org/std/result/index.html",
          "kind": "docs"
        },
        {
          "title": "fasterthanlime - Rust videos (YouTube)",
          "url": "https://www.youtube.com/@fasterthanlime",
          "kind": "video"
        }
      ],
      "crates": [
        "thiserror",
        "anyhow"
      ],
      "production": [
        "Use thiserror for library errors and anyhow at application boundaries.",
        "Never unwrap in request paths; map errors to responses."
      ]
    },
    {
      "id": "l12",
      "n": 12,
      "title": "Traits & Generics",
      "minutes": 50,
      "goal": "Share behaviour with traits and write code over many types.",
      "sections": [
        {
          "h": "Traits describe behaviour",
          "p": [
            "A trait is a set of methods a type promises to provide. Implementations are separate from the type."
          ],
          "code": "trait Summary {\n    fn summarize(&self) -> String;\n}\n\nstruct Article {\n    title: String,\n}\n\nimpl Summary for Article {\n    fn summarize(&self) -> String {\n        format!(\"{} (article)\", self.title)\n    }\n}"
        },
        {
          "h": "Default methods",
          "p": [
            "Traits may provide default bodies; implementors override only what they need."
          ],
          "code": "trait Greet {\n    fn name(&self) -> String;\n    fn greet(&self) -> String {\n        format!(\"Hello, {}!\", self.name())\n    }\n}\n\nstruct Bot;\nimpl Greet for Bot {\n    fn name(&self) -> String { String::from(\"Ferris\") }\n}\n\nfn main() {\n    println!(\"{}\", Bot.greet());\n}"
        },
        {
          "h": "Generics with bounds",
          "p": [
            "A generic function works for many types as long as they satisfy the bounds you declare."
          ],
          "code": "fn largest<T: PartialOrd + Copy>(list: &[T]) -> T {\n    let mut biggest = list[0];\n    for &item in list {\n        if item > biggest {\n            biggest = item;\n        }\n    }\n    biggest\n}\n\nfn main() {\n    println!(\"{}\", largest(&[3, 9, 2]));\n    println!(\"{}\", largest(&[1.5, 0.5]));\n}"
        }
      ],
      "exercise": {
        "prompt": "Define a trait Area with fn area(&self) -> f64, implement it for Rectangle, and print the area through a generic function.",
        "starter": "trait Area {\n    fn area(&self) -> f64;\n}\n\nstruct Rectangle {\n    width: f64,\n    height: f64,\n}\n\n// implement Area for Rectangle\n\nfn print_area<T: Area>(shape: &T) {\n    println!(\"area = {}\", shape.area());\n}\n\nfn main() {\n    print_area(&Rectangle { width: 3.0, height: 4.0 });\n}",
        "hint": "impl Area for Rectangle { fn area(&self) -> f64 { self.width * self.height } }",
        "solution": "trait Area {\n    fn area(&self) -> f64;\n}\n\nstruct Rectangle {\n    width: f64,\n    height: f64,\n}\n\nimpl Area for Rectangle {\n    fn area(&self) -> f64 {\n        self.width * self.height\n    }\n}\n\nfn print_area<T: Area>(shape: &T) {\n    println!(\"area = {}\", shape.area());\n}\n\nfn main() {\n    print_area(&Rectangle { width: 3.0, height: 4.0 });\n}"
      },
      "level": "advanced",
      "questions": [
        {
          "q": "In fn largest<T: PartialOrd + Copy>(list: &[T]) -> T, why is the Copy bound needed?",
          "options": [
            "Copy lets the function allocate T on the heap",
            "Values are copied out of the slice, so T must be Copy or borrowed",
            "PartialOrd requires Copy as a supertrait",
            "Copy is needed to print T with {}"
          ],
          "answer": 1,
          "explain": "The body copies list[0] and each item out of the borrowed slice. Without Copy you would need to borrow, for example return &T or take T by value from an owned collection."
        },
        {
          "q": "A trait defines fn greet(&self) with a default body. An implementor supplies only name. What happens?",
          "options": [
            "The type fails to compile until greet is implemented",
            "The default body is used, so only name must be implemented",
            "greet returns an empty String",
            "The trait must be marked #[derive(Default)]"
          ],
          "answer": 1,
          "explain": "Default methods are inherited automatically; implementors override only the methods whose behaviour differs. That is the main reason to give traits default bodies."
        }
      ],
      "quickbytes": [
        "Implement only what differs when a trait provides default method bodies.",
        "Bounds can be inline (T: Area) or moved to a where clause when they get long.",
        "Generic functions are monomorphised: one specialised copy per concrete type."
      ],
      "github": [
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        },
        {
          "name": "rust-lang/rustlings",
          "url": "https://github.com/rust-lang/rustlings"
        }
      ],
      "resources": [
        {
          "title": "The Rust Book — Generic types, traits and lifetimes",
          "url": "https://doc.rust-lang.org/book/ch10-00-generics.html",
          "kind": "docs"
        },
        {
          "title": "The Rust Book — Traits",
          "url": "https://doc.rust-lang.org/book/ch10-02-traits.html",
          "kind": "docs"
        },
        {
          "title": "Jon Gjengset - Rust deep dives (YouTube)",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ],
      "crates": [
        "thiserror"
      ],
      "production": [
        "Prefer generic bounds over dyn unless dynamic dispatch is required.",
        "Keep traits small and document their contract."
      ]
    },
    {
      "id": "l13",
      "n": 13,
      "title": "Closures & Iterators",
      "minutes": 45,
      "goal": "Write concise data pipelines with closures and iterator adapters.",
      "sections": [
        {
          "h": "Closures capture their environment",
          "p": [
            "A closure is an inline function that can use variables from the surrounding scope."
          ],
          "code": "fn main() {\n    let factor = 3;\n    let scale = |n: i32| n * factor;\n    println!(\"{}\", scale(7));       // 21\n}"
        },
        {
          "h": "Iterator chains",
          "p": [
            "Iterator adapters are lazy: nothing runs until a consumer such as sum, collect or count pulls values."
          ],
          "code": "let numbers = vec![1, 2, 3, 4, 5, 6];\n\nlet total: i32 = numbers\n    .iter()\n    .filter(|n| *n % 2 == 0)\n    .map(|n| n * n)\n    .sum();\n\nprintln!(\"{}\", total);             // 4 + 16 + 36 = 56",
          "tip": "Prefer iterator chains to manual index loops: they state intent, avoid off-by-one bugs, and optimise well."
        },
        {
          "h": "Collect into a new collection",
          "p": [
            "collect turns an iterator back into a Vec, HashMap, String and more; annotate the target type."
          ],
          "code": "let words = vec![\"rust\", \"is\", \"fun\"];\nlet loud: Vec<String> = words\n    .iter()\n    .map(|w| w.to_uppercase())\n    .collect();\nprintln!(\"{:?}\", loud);"
        }
      ],
      "exercise": {
        "prompt": "Using iterators, sum the squares of the even numbers in the vector.",
        "starter": "fn main() {\n    let numbers = vec![1, 2, 3, 4, 5, 6];\n    let total: i32 = 0;   // replace with an iterator chain\n    println!(\"total = {}\", total);\n}",
        "hint": "numbers.iter().filter(|n| *n % 2 == 0).map(|n| n * n).sum()",
        "solution": "fn main() {\n    let numbers = vec![1, 2, 3, 4, 5, 6];\n    let total: i32 = numbers\n        .iter()\n        .filter(|n| *n % 2 == 0)\n        .map(|n| n * n)\n        .sum();\n    println!(\"total = {}\", total);   // 56\n}"
      },
      "level": "advanced",
      "questions": [
        {
          "q": "Given let it = numbers.iter().map(|n| n * n); when does the map closure actually run?",
          "options": [
            "Immediately, and it builds a new Vec",
            "Only when a consumer such as collect, sum or a for loop pulls values",
            "At compile time, because the iterator is constant",
            "It never runs until you call .next() on the vector itself"
          ],
          "answer": 1,
          "explain": "Iterator adapters are lazy: map and filter only describe work. A consumer drives the chain, which is why a bare chain without collect or sum does nothing."
        },
        {
          "q": "Why does let loud: Vec<String> = words.iter().map(|w| w.to_uppercase()).collect(); need the annotation?",
          "options": [
            "collect always returns Vec, so the annotation is only documentation",
            "collect can build many collection types, so the target type must be known",
            "The annotation is required to infer the closure argument type",
            "Without it, collect allocates on the stack"
          ],
          "answer": 1,
          "explain": "collect is generic over the target collection (Vec, HashMap, String, ...). Annotate the binding or use .collect::<Vec<_>>() so the compiler knows which FromIterator impl to use."
        }
      ],
      "quickbytes": [
        "Adapters are lazy; sum, collect, count and for loops are the consumers that run them.",
        "Annotate collect's target: let v: Vec<_> = ... or .collect::<Vec<_>>().",
        "Prefer iterator chains to manual index loops; they avoid off-by-one bugs."
      ],
      "github": [
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        },
        {
          "name": "rust-lang/rustlings",
          "url": "https://github.com/rust-lang/rustlings"
        }
      ],
      "resources": [
        {
          "title": "The Rust Book — Functional features: iterators and closures",
          "url": "https://doc.rust-lang.org/book/ch13-00-functional-features.html",
          "kind": "docs"
        },
        {
          "title": "std — Iterator",
          "url": "https://doc.rust-lang.org/std/iter/trait.Iterator.html",
          "kind": "docs"
        },
        {
          "title": "Jon Gjengset - Rust deep dives (YouTube)",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ],
      "crates": [
        "itertools"
      ],
      "production": [
        "Prefer iterator chains to manual loops and annotate collect().",
        "Benchmark hot iterator chains before adding complexity."
      ]
    },
    {
      "id": "l14",
      "n": 14,
      "title": "Modules, Crates & Cargo",
      "minutes": 35,
      "goal": "Split code across modules and pull in third-party crates.",
      "sections": [
        {
          "h": "Modules organise code",
          "p": [
            "mod declares a namespace; pub makes an item visible outside it. use brings a path into scope."
          ],
          "code": "mod geometry {\n    pub fn area(w: f64, h: f64) -> f64 {\n        w * h\n    }\n}\n\nuse geometry::area;\n\nfn main() {\n    println!(\"{}\", area(3.0, 4.0));\n}"
        },
        {
          "h": "Files and crates",
          "p": [
            "A package has a library (src/lib.rs) or a binary (src/main.rs), and any number of extra binaries in src/bin/. A dependency is a crate from crates.io, declared in Cargo.toml."
          ],
          "code": "cargo add serde --features derive\ncargo add tokio --features full"
        },
        {
          "h": "Dependencies in Cargo.toml",
          "p": [
            "The manifest records versions; Cargo.lock pins exact builds for reproducibility."
          ],
          "code": "[package]\nname = \"my-cli\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[dependencies]\nserde = { version = \"1\", features = [\"derive\"] }"
        }
      ],
      "exercise": {
        "prompt": "Move a helper function into a module named text, make it public, and call it from main with a use path.",
        "starter": "fn shout(s: &str) -> String {\n    s.to_uppercase()\n}\n\nfn main() {\n    println!(\"{}\", shout(\"hello\"));\n}",
        "hint": "Wrap the function in mod text { pub fn shout(...) } and add use text::shout;",
        "solution": "mod text {\n    pub fn shout(s: &str) -> String {\n        s.to_uppercase()\n    }\n}\n\nuse text::shout;\n\nfn main() {\n    println!(\"{}\", shout(\"hello\"));\n}"
      },
      "level": "advanced",
      "questions": [
        {
          "q": "A helper sits inside mod text. What is needed before main can call shout(\"hello\")?",
          "options": [
            "A private fn is visible to main as long as use text::shout; is present",
            "The function must be pub, and main needs use text::shout; to shorten the path",
            "You need extern crate text; in main.rs",
            "The function must be declared const fn"
          ],
          "answer": 1,
          "explain": "Items are private to their module by default, so shout needs pub. use text::shout; then brings the path into scope; calling text::shout directly would work too."
        },
        {
          "q": "What is Cargo.lock for?",
          "options": [
            "It lists your source files so cargo can rebuild them",
            "It pins exact resolved dependency versions for reproducible builds",
            "It replaces Cargo.toml for applications",
            "It records which Rust edition you use"
          ],
          "answer": 1,
          "explain": "Cargo.toml records version requirements; Cargo.lock records the exact resolved versions, so every build and machine uses the same dependency graph. Commit it for binaries."
        }
      ],
      "quickbytes": [
        "pub opens an item to its parent module; use only shortens the path to it.",
        "cargo add serde --features derive edits Cargo.toml and resolves the version for you.",
        "A file in src/bin/ becomes another binary with no manifest changes."
      ],
      "github": [
        {
          "name": "rust-lang/cargo",
          "url": "https://github.com/rust-lang/cargo"
        },
        {
          "name": "serde-rs/serde",
          "url": "https://github.com/serde-rs/serde"
        }
      ],
      "resources": [
        {
          "title": "The Rust Book — Packages, crates and modules",
          "url": "https://doc.rust-lang.org/book/ch07-00-managing-growing-projects-with-packages-crates-and-modules.html",
          "kind": "docs"
        },
        {
          "title": "The Cargo Book",
          "url": "https://doc.rust-lang.org/cargo/",
          "kind": "docs"
        },
        {
          "title": "Let's Get Rusty - Rust tutorials (YouTube)",
          "url": "https://www.youtube.com/@letsgetrusty",
          "kind": "video"
        },
        {
          "title": "Rust standard library source code on GitHub",
          "url": "https://github.com/rust-lang/rust",
          "kind": "repo"
        }
      ],
      "crates": [
        "cargo-nextest"
      ],
      "production": [
        "Keep a workspace with shared lints and dependency versions.",
        "Run cargo deny and cargo audit in CI for crate hygiene."
      ]
    },
    {
      "id": "l15",
      "n": 15,
      "title": "Collections in Depth",
      "minutes": 40,
      "goal": "Choose the right collection and use the HashMap entry API.",
      "sections": [
        {
          "h": "Vec and HashMap",
          "p": [
            "Vec is a growable array. HashMap stores key-value pairs with fast lookup."
          ],
          "code": "use std::collections::HashMap;\n\nfn main() {\n    let mut scores: HashMap<String, i32> = HashMap::new();\n    scores.insert(String::from(\"ferris\"), 10);\n\n    match scores.get(\"ferris\") {\n        Some(score) => println!(\"score = {}\", score),\n        None => println!(\"unknown player\"),\n    }\n}"
        },
        {
          "h": "The entry API",
          "p": [
            "entry handles \"insert if missing\" in one step, which is the usual counting pattern."
          ],
          "code": "use std::collections::HashMap;\n\nfn main() {\n    let words = [\"rust\", \"is\", \"fun\", \"rust\"];\n    let mut counts: HashMap<&str, i32> = HashMap::new();\n    for word in words {\n        *counts.entry(word).or_insert(0) += 1;\n    }\n    println!(\"{:?}\", counts);      // {\"fun\": 1, \"is\": 1, \"rust\": 2}\n}"
        },
        {
          "h": "Choosing a collection",
          "p": [
            "Vec: ordered list, index access. HashMap: key-value with unordered iteration. HashSet: membership tests. BTreeMap: sorted keys. VecDeque: push/pop at both ends."
          ],
          "code": "let mut seen = std::collections::HashSet::new();\nseen.insert(\"a\");\nprintln!(\"{}\", seen.contains(\"a\"));   // true"
        }
      ],
      "exercise": {
        "prompt": "Count how many times each word appears in a sentence and print the map.",
        "starter": "use std::collections::HashMap;\n\nfn main() {\n    let sentence = \"the quick brown fox jumps over the lazy dog the end\";\n    let mut counts: HashMap<&str, i32> = HashMap::new();\n    // fill counts using split_whitespace and entry\n    println!(\"{:?}\", counts);\n}",
        "hint": "for word in sentence.split_whitespace() { *counts.entry(word).or_insert(0) += 1; }",
        "solution": "use std::collections::HashMap;\n\nfn main() {\n    let sentence = \"the quick brown fox jumps over the lazy dog the end\";\n    let mut counts: HashMap<&str, i32> = HashMap::new();\n    for word in sentence.split_whitespace() {\n        *counts.entry(word).or_insert(0) += 1;\n    }\n    println!(\"{:?}\", counts);\n}"
      },
      "level": "industry",
      "questions": [
        {
          "q": "What does *counts.entry(word).or_insert(0) += 1; do when word is absent?",
          "options": [
            "It panics because the key is missing",
            "It inserts 0, then returns a &mut i32 that the += updates to 1",
            "It returns Option<&i32> and never inserts",
            "It replaces any existing value with 0"
          ],
          "answer": 1,
          "explain": "entry finds or creates the slot, or_insert supplies the default, and the expression yields &mut V. Dereferencing it lets += update the stored count in one pass."
        },
        {
          "q": "What iteration order does a std HashMap guarantee?",
          "options": [
            "Insertion order",
            "Sorted key order",
            "Unspecified, so never rely on it",
            "Reverse insertion order"
          ],
          "answer": 2,
          "explain": "HashMap iteration order is unspecified and can change between runs. Use BTreeMap when you need sorted keys, or sort a Vec of entries before printing."
        }
      ],
      "quickbytes": [
        "entry().or_insert() does the lookup and insert in one pass, with no double hashing.",
        "HashMap iteration order is unspecified; use BTreeMap when you need sorted keys.",
        "VecDeque is the queue for pushes and pops at both ends; HashSet for membership."
      ],
      "github": [
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        }
      ],
      "resources": [
        {
          "title": "The Rust Book — Common collections",
          "url": "https://doc.rust-lang.org/book/ch08-00-common-collections.html",
          "kind": "docs"
        },
        {
          "title": "std — Collections",
          "url": "https://doc.rust-lang.org/std/collections/index.html",
          "kind": "docs"
        },
        {
          "title": "Jon Gjengset - Rust deep dives (YouTube)",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        },
        {
          "title": "hashbrown SwissTable map source on GitHub",
          "url": "https://github.com/rust-lang/hashbrown",
          "kind": "repo"
        }
      ],
      "crates": [
        "indexmap"
      ],
      "production": [
        "Choose HashMap for lookups and BTreeMap for ordered iteration.",
        "Reserve capacity up front when the size is known."
      ]
    },
    {
      "id": "l16",
      "n": 16,
      "title": "Files, I/O & a CLI Tool",
      "minutes": 50,
      "goal": "Read files, accept arguments, and return exit codes.",
      "sections": [
        {
          "h": "Read a file",
          "p": [
            "std::fs::read_to_string reads a whole file into a String and returns a Result."
          ],
          "code": "use std::fs;\n\nfn main() -> std::io::Result<()> {\n    let text = fs::read_to_string(\"Cargo.toml\")?;\n    println!(\"{} bytes\", text.len());\n    Ok(())\n}"
        },
        {
          "h": "Arguments and exit codes",
          "p": [
            "env::args yields the program name first, then the arguments. Return a non-zero status on failure."
          ],
          "code": "use std::process;\n\nfn main() {\n    let mut args = std::env::args().skip(1);\n    let path = match args.next() {\n        Some(path) => path,\n        None => {\n            eprintln!(\"usage: counter <file>\");\n            process::exit(2);\n        }\n    };\n    println!(\"reading {}\", path);\n}"
        },
        {
          "h": "A tiny wc",
          "p": [
            "Combining the pieces gives a real tool: read, count, print."
          ],
          "code": "use std::fs;\n\nfn main() -> std::io::Result<()> {\n    let path = std::env::args().nth(1).unwrap_or_else(|| String::from(\"Cargo.toml\"));\n    let text = fs::read_to_string(&path)?;\n    let lines = text.lines().count();\n    let words = text.split_whitespace().count();\n    println!(\"{} {} {}\", lines, words, path);\n    Ok(())\n}"
        }
      ],
      "exercise": {
        "prompt": "Write a program that prints the number of lines in the file passed as the first argument.",
        "starter": "use std::fs;\n\nfn main() -> std::io::Result<()> {\n    // read the first argument, then print the line count\n    Ok(())\n}",
        "hint": "let path = std::env::args().nth(1).unwrap_or_default(); then fs::read_to_string(path)?.lines().count().",
        "solution": "use std::fs;\n\nfn main() -> std::io::Result<()> {\n    let path = std::env::args().nth(1).unwrap_or_else(|| String::from(\"Cargo.toml\"));\n    let text = fs::read_to_string(path)?;\n    println!(\"{} lines\", text.lines().count());\n    Ok(())\n}"
      },
      "level": "industry",
      "questions": [
        {
          "q": "std::env::args() yields the program name first. What does args().nth(1) return?",
          "options": [
            "The first user argument, because index 0 is the program name",
            "The program name again",
            "The current working directory",
            "The path to Cargo.toml"
          ],
          "answer": 0,
          "explain": "The iterator starts with the executable path at index 0, so nth(1) (or skip(1).next()) is the first argument the user typed."
        },
        {
          "q": "fn main() -> std::io::Result<()> returns Err(e). What does the process do?",
          "options": [
            "It panics with the error",
            "The runtime prints the error's Debug form to stderr and exits with a failure status",
            "It ignores the error and exits 0",
            "It hangs until you call process::exit yourself"
          ],
          "answer": 1,
          "explain": "A non-zero-terminating main returning Err reports the error via Debug and exits non-zero, which is why ? is convenient in small CLI tools."
        }
      ],
      "quickbytes": [
        "read_to_string returns a Result: propagate with ? instead of unwrap in real tools.",
        "eprintln! writes to stderr; process::exit(2) signals a usage error.",
        "args().nth(1) is the first user argument; nth(0) is the program name."
      ],
      "github": [
        {
          "name": "BurntSushi/ripgrep",
          "url": "https://github.com/BurntSushi/ripgrep"
        },
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        }
      ],
      "resources": [
        {
          "title": "The Rust Book — An I/O project",
          "url": "https://doc.rust-lang.org/book/ch12-00-an-io-project.html",
          "kind": "docs"
        },
        {
          "title": "std — fs::read_to_string",
          "url": "https://doc.rust-lang.org/std/fs/fn.read_to_string.html",
          "kind": "docs"
        },
        {
          "title": "fasterthanlime - Rust videos (YouTube)",
          "url": "https://www.youtube.com/@fasterthanlime",
          "kind": "video"
        },
        {
          "title": "clap argument parser source on GitHub",
          "url": "https://github.com/clap-rs/clap",
          "kind": "repo"
        }
      ],
      "crates": [
        "clap"
      ],
      "production": [
        "Return non-zero exit codes on failure and write errors to stderr.",
        "Use clap for argument parsing instead of manual args()."
      ]
    },
    {
      "id": "l17",
      "n": 17,
      "title": "Threads, Channels & Shared State",
      "minutes": 50,
      "goal": "Run work in parallel and share data without data races.",
      "sections": [
        {
          "h": "thread::spawn",
          "p": [
            "A spawned thread runs a closure. move transfers captured values into it; join waits for it to finish."
          ],
          "code": "use std::thread;\n\nfn main() {\n    let handle = thread::spawn(|| {\n        println!(\"from another thread\");\n    });\n    handle.join().unwrap();\n    println!(\"from main\");\n}"
        },
        {
          "h": "Channels",
          "p": [
            "mpsc is a multi-producer, single-consumer channel. Sending moves the value across threads."
          ],
          "code": "use std::sync::mpsc;\nuse std::thread;\n\nfn main() {\n    let (tx, rx) = mpsc::channel();\n    thread::spawn(move || {\n        tx.send(42).unwrap();\n    });\n    println!(\"got {}\", rx.recv().unwrap());\n}"
        },
        {
          "h": "Shared state",
          "p": [
            "Arc lets several threads share ownership; Mutex allows one thread at a time to mutate the value inside."
          ],
          "code": "use std::sync::{Arc, Mutex};\nuse std::thread;\n\nfn main() {\n    let shared = Arc::new(Mutex::new(Vec::new()));\n    let mut handles = Vec::new();\n    for n in 0..3 {\n        let clone = Arc::clone(&shared);\n        handles.push(thread::spawn(move || {\n            clone.lock().unwrap().push(n);\n        }));\n    }\n    for handle in handles {\n        handle.join().unwrap();\n    }\n    println!(\"{:?}\", shared.lock().unwrap());\n}",
          "tip": "The compiler will not let you send a plain Rc or &mut across threads: the same ownership rules that prevent use-after-free also prevent data races."
        }
      ],
      "exercise": {
        "prompt": "Spawn two threads that each push a number into a shared Vec, join them, then print the Vec.",
        "starter": "use std::sync::{Arc, Mutex};\nuse std::thread;\n\nfn main() {\n    let shared = Arc::new(Mutex::new(Vec::new()));\n    // spawn two threads, each pushing one number\n}",
        "hint": "Clone the Arc per thread, move it in, lock and push, then join both handles.",
        "solution": "use std::sync::{Arc, Mutex};\nuse std::thread;\n\nfn main() {\n    let shared = Arc::new(Mutex::new(Vec::new()));\n    let mut handles = Vec::new();\n    for n in [1, 2] {\n        let clone = Arc::clone(&shared);\n        handles.push(thread::spawn(move || {\n            clone.lock().unwrap().push(n);\n        }));\n    }\n    for handle in handles {\n        handle.join().unwrap();\n    }\n    println!(\"{:?}\", shared.lock().unwrap());\n}"
      },
      "level": "industry",
      "questions": [
        {
          "q": "Why use Arc<Mutex<T>> instead of Rc<RefCell<T>> when several threads mutate shared data?",
          "options": [
            "Arc is faster than Rc even in single-threaded code",
            "Rc is not Send, so the compiler rejects it across threads; Arc is atomic and Mutex serialises mutation",
            "RefCell panics whenever it is cloned",
            "Mutex makes the inner Vec immutable"
          ],
          "answer": 1,
          "explain": "Rc's reference count is not atomic, so it cannot cross threads; the compiler enforces this through Send/Sync. Arc makes sharing safe and Mutex makes mutation exclusive."
        },
        {
          "q": "What does move do in thread::spawn(move || { ... })?",
          "options": [
            "It copies every captured value",
            "It moves captured values into the closure, which is required when the thread may outlive the current scope",
            "It makes the closure run on the main thread",
            "It has no effect on ownership"
          ],
          "answer": 1,
          "explain": "A spawned thread can outlive the stack frame that created it, so captured values must be owned by the closure. move transfers those values instead of borrowing them."
        }
      ],
      "quickbytes": [
        "Send and Sync are enforced by the compiler; a rejected thread is a prevented data race.",
        "mpsc::send moves the value across threads; recv blocks until a value arrives.",
        "Arc::clone(&x) bumps the reference count; x.clone() would deep-copy the inner value."
      ],
      "github": [
        {
          "name": "crossbeam-rs/crossbeam",
          "url": "https://github.com/crossbeam-rs/crossbeam"
        }
      ],
      "resources": [
        {
          "title": "The Rust Book — Fearless concurrency",
          "url": "https://doc.rust-lang.org/book/ch16-00-concurrency.html",
          "kind": "docs"
        },
        {
          "title": "std — Threads",
          "url": "https://doc.rust-lang.org/std/thread/index.html",
          "kind": "docs"
        },
        {
          "title": "Jon Gjengset - Rust deep dives (YouTube)",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        },
        {
          "title": "Rust standard library source code on GitHub",
          "url": "https://github.com/rust-lang/rust",
          "kind": "repo"
        }
      ],
      "crates": [
        "crossbeam"
      ],
      "production": [
        "Prefer channels over shared state when possible.",
        "Keep lock scopes short and never hold a Mutex across await."
      ]
    },
    {
      "id": "l18",
      "n": 18,
      "title": "Async & Tokio Basics",
      "minutes": 55,
      "goal": "Write async functions and run them concurrently on a Tokio runtime.",
      "sections": [
        {
          "h": "async fn returns a future",
          "p": [
            "Calling an async function does nothing until the future is awaited. This lets one thread juggle many pending tasks."
          ],
          "code": "async fn fetch(url: &str) -> String {\n    format!(\"body of {}\", url)\n}\n\n#[tokio::main]\nasync fn main() {\n    let body = fetch(\"https://example.com\").await;\n    println!(\"{}\", body);\n}",
          "tip": "Add tokio with features = [\"full\"] to Cargo.toml; #[tokio::main] builds the runtime for you."
        },
        {
          "h": "Concurrency with join!",
          "p": [
            "Awaiting one future at a time is sequential. join! polls several at once and waits for all of them."
          ],
          "code": "use tokio::time::{sleep, Duration};\n\nasync fn task(id: u32) -> u32 {\n    sleep(Duration::from_millis(100)).await;\n    id * 10\n}\n\n#[tokio::main]\nasync fn main() {\n    let (a, b) = tokio::join!(task(1), task(2));\n    println!(\"{} {}\", a, b);\n}"
        },
        {
          "h": "Async rules of thumb",
          "p": [
            "Never block inside an async task: use async versions of I/O, or spawn_blocking. Prefer tokio::spawn for fire-and-forget work and keep shared state behind Arc<Mutex<_>> or channels."
          ],
          "code": "let handle = tokio::spawn(async {\n    1 + 1\n});\nprintln!(\"{}\", handle.await.unwrap());"
        }
      ],
      "exercise": {
        "prompt": "Write an async function that sleeps 50ms and returns a number; run two of them concurrently with join!.",
        "starter": "use tokio::time::{sleep, Duration};\n\nasync fn work(id: u32) -> u32 {\n    // sleep, then return id * 2\n}\n\n#[tokio::main]\nasync fn main() {\n    // use tokio::join! to run two work calls together\n}",
        "hint": "sleep(Duration::from_millis(50)).await; then return id * 2. let (a, b) = tokio::join!(work(1), work(2));",
        "solution": "use tokio::time::{sleep, Duration};\n\nasync fn work(id: u32) -> u32 {\n    sleep(Duration::from_millis(50)).await;\n    id * 2\n}\n\n#[tokio::main]\nasync fn main() {\n    let (a, b) = tokio::join!(work(1), work(2));\n    println!(\"{} {}\", a, b);\n}"
      },
      "level": "industry",
      "questions": [
        {
          "q": "What happens when you call an async fn without .await or spawning it?",
          "options": [
            "The future runs immediately and returns its output",
            "An async fn returns a future that does nothing until it is awaited or polled",
            "The call blocks the thread until the future finishes",
            "The compiler rejects calling an async fn without .await"
          ],
          "answer": 1,
          "explain": "async fn returns a future; the body only advances when a runtime polls it. Forgetting .await is a common bug because the code compiles with an unused-future warning."
        },
        {
          "q": "Why is std::thread::sleep bad inside a Tokio task?",
          "options": [
            "It is fine because each task has its own OS thread",
            "It blocks the runtime worker thread, starving other tasks scheduled on it",
            "It panics when called from async context",
            "Tokio automatically moves blocking calls to another thread"
          ],
          "answer": 1,
          "explain": "Async tasks share a small pool of worker threads, so a blocking call stalls every task on that thread. Use tokio::time::sleep or tokio::task::spawn_blocking for blocking work."
        }
      ],
      "quickbytes": [
        "An async fn returns a future; nothing runs until it is awaited or spawned.",
        "tokio::join! polls several futures concurrently; tokio::spawn runs an independent task.",
        "Never block a runtime thread: use async I/O or tokio::task::spawn_blocking."
      ],
      "github": [
        {
          "name": "tokio-rs/tokio",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "resources": [
        {
          "title": "Tokio tutorial",
          "url": "https://tokio.rs/tokio/tutorial",
          "kind": "docs"
        },
        {
          "title": "Asynchronous Programming in Rust",
          "url": "https://rust-lang.github.io/async-book/",
          "kind": "docs"
        },
        {
          "title": "Jon Gjengset - Rust deep dives (YouTube)",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        },
        {
          "title": "Rust standard library source code on GitHub",
          "url": "https://github.com/rust-lang/rust",
          "kind": "repo"
        }
      ],
      "crates": [
        "tokio"
      ],
      "production": [
        "Never block inside async; use spawn_blocking for CPU work.",
        "Set timeouts on every network call and propagate cancellation."
      ]
    },
    {
      "id": "l19",
      "n": 19,
      "title": "Lifetimes & Smart Pointers",
      "minutes": 55,
      "goal": "Annotate how long references live, and pick the right pointer.",
      "sections": [
        {
          "h": "Lifetimes tie references together",
          "p": [
            "A lifetime annotation names a relationship: the returned reference lives no longer than its inputs. You rarely need one, but you must recognise it."
          ],
          "code": "fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {\n    if x.len() >= y.len() { x } else { y }\n}\n\nfn main() {\n    let a = String::from(\"long string\");\n    let b = \"short\";\n    println!(\"{}\", longest(&a, b));\n}",
          "tip": "Elision covers the common cases: one input reference means the output borrows from it; &self means the output borrows from self."
        },
        {
          "h": "Ownership beyond the stack",
          "p": [
            "Box puts a value on the heap. Rc shares ownership between several owners on one thread. RefCell moves borrow checking to runtime for interior mutability."
          ],
          "code": "use std::rc::Rc;\nuse std::cell::RefCell;\n\nfn main() {\n    let boxed = Box::new(5);\n    println!(\"{}\", boxed);\n\n    let shared = Rc::new(String::from(\"data\"));\n    let second = Rc::clone(&shared);\n    println!(\"{} {}\", shared, second);\n\n    let cell = RefCell::new(1);\n    *cell.borrow_mut() += 1;\n    println!(\"{}\", cell.borrow());\n}"
        },
        {
          "h": "Choosing a pointer",
          "p": [
            "Box<T>: single owner, heap allocation. Rc<T>: shared, immutable, single thread. Arc<T>: shared across threads. RefCell<T>: runtime-checked mutation behind a shared reference. Mutex<T>: cross-thread mutation."
          ],
          "code": "use std::sync::{Arc, Mutex};\n\nlet shared = Arc::new(Mutex::new(0));\n*shared.lock().unwrap() += 1;\nprintln!(\"{}\", shared.lock().unwrap());"
        }
      ],
      "exercise": {
        "prompt": "Implement longest with an explicit lifetime and call it with two string slices.",
        "starter": "fn longest(x: &str, y: &str) -> &str {\n    if x.len() >= y.len() { x } else { y }\n}\n\nfn main() {\n    println!(\"{}\", longest(\"alpha\", \"beta\"));\n}",
        "hint": "Add <'a> after the function name and mark x, y and the return type with &'a str.",
        "solution": "fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {\n    if x.len() >= y.len() { x } else { y }\n}\n\nfn main() {\n    println!(\"{}\", longest(\"alpha\", \"beta\"));\n}"
      },
      "level": "industry",
      "questions": [
        {
          "q": "In fn longest<'a>(x: &'a str, y: &'a str) -> &'a str, what does 'a express?",
          "options": [
            "The returned reference lives forever",
            "The output lives no longer than the shorter of the two inputs",
            "The inputs are allocated on the heap",
            "x and y become mutable"
          ],
          "answer": 1,
          "explain": "Lifetime annotations describe relationships, not durations: the result may only be used while both inputs are alive, so effectively as long as the shorter one. They never change how long values live."
        },
        {
          "q": "Which pointer lets you share ownership of a value across threads?",
          "options": [
            "Rc<T>, because it is cheaper",
            "Arc<T>, because Rc is not thread-safe (not Send/Sync)",
            "Box<T>, because it is heap allocated",
            "RefCell<T>, because it allows mutation"
          ],
          "answer": 1,
          "explain": "Rc's count is non-atomic and its type is not Send, so the compiler rejects it across threads. Arc uses atomic counts and is the shared-ownership choice for threads."
        }
      ],
      "quickbytes": [
        "Lifetime annotations describe relationships; they never extend how long data lives.",
        "Box = one heap owner; Rc = shared on one thread; Arc = shared across threads.",
        "RefCell moves borrow checks to runtime; borrow_mut() panics if already borrowed."
      ],
      "github": [
        {
          "name": "rust-lang/nomicon",
          "url": "https://github.com/rust-lang/nomicon"
        },
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        }
      ],
      "resources": [
        {
          "title": "The Rust Book — Validating references with lifetimes",
          "url": "https://doc.rust-lang.org/book/ch10-03-lifetime-syntax.html",
          "kind": "docs"
        },
        {
          "title": "The Rust Book — Smart pointers",
          "url": "https://doc.rust-lang.org/book/ch15-00-smart-pointers.html",
          "kind": "docs"
        },
        {
          "title": "Jon Gjengset - Rust deep dives (YouTube)",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        },
        {
          "title": "Oxide: The Essence of Rust (arXiv preprint)",
          "url": "https://arxiv.org/abs/1903.00982",
          "kind": "paper"
        }
      ],
      "crates": [
        "thiserror"
      ],
      "production": [
        "Box recursively sized types; share only with Rc/Arc when real.",
        "Avoid RefCell in async code; prefer message passing."
      ]
    },
    {
      "id": "l20",
      "n": 20,
      "title": "Testing, Errors & Idiomatic Rust",
      "minutes": 45,
      "goal": "Test what you build and write code other Rust programmers expect.",
      "sections": [
        {
          "h": "Unit tests live beside the code",
          "p": [
            "A #[cfg(test)] module compiles only for tests. assert_eq! reports both sides when it fails."
          ],
          "code": "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn adds_numbers() {\n        assert_eq!(add(2, 3), 5);\n    }\n}"
        },
        {
          "h": "Errors with context",
          "p": [
            "Libraries define precise error enums (thiserror); applications add context to any error (anyhow). Both use ? in the same way."
          ],
          "code": "use anyhow::{Context, Result};\n\nfn load(path: &str) -> Result<String> {\n    std::fs::read_to_string(path)\n        .with_context(|| format!(\"could not read {}\", path))\n}"
        },
        {
          "h": "Idiomatic habits",
          "p": [
            "Run cargo fmt and cargo clippy often. Prefer iterator chains to index loops. Avoid unwrap in library code. Take &str instead of &String, and &[T] instead of &Vec<T>. Write the test first when a bug is reported."
          ],
          "code": "cargo fmt\ncargo clippy -- -D warnings\ncargo test"
        }
      ],
      "exercise": {
        "prompt": "Write two unit tests for a function that multiplies two numbers: one normal case and one with zero.",
        "starter": "fn multiply(a: i32, b: i32) -> i32 {\n    a * b\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    // add #[test] functions here\n}",
        "hint": "Inside mod tests use super::*; each test is a #[test] fn with assert_eq!.",
        "solution": "fn multiply(a: i32, b: i32) -> i32 {\n    a * b\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn multiplies_numbers() {\n        assert_eq!(multiply(3, 4), 12);\n    }\n\n    #[test]\n    fn multiplies_by_zero() {\n        assert_eq!(multiply(99, 0), 0);\n    }\n}"
      },
      "level": "industry",
      "questions": [
        {
          "q": "When is a #[cfg(test)] mod tests compiled?",
          "options": [
            "Into every build, including cargo run",
            "Only when the crate is built for testing, such as cargo test",
            "Only in release builds",
            "Never; it is documentation only"
          ],
          "answer": 1,
          "explain": "cfg(test) is set only for the test profile, so the module costs nothing in a normal build. Unit tests live beside the code and can access private items."
        },
        {
          "q": "What does cargo clippy -- -D warnings change?",
          "options": [
            "It enables every clippy lint, including pedantic ones",
            "It turns warnings into errors, so lint warnings fail the build",
            "It disables clippy and runs rustfmt instead",
            "It runs the tests and prints warnings"
          ],
          "answer": 1,
          "explain": "The arguments after -- go to clippy itself, and -D warnings denies every warning. That makes CI fail on new lints instead of letting them accumulate."
        }
      ],
      "quickbytes": [
        "cargo test runs unit tests, tests/ integration tests and doc tests.",
        "assert_eq! prints both values on failure; assert! is for plain booleans.",
        "cargo clippy -- -D warnings makes lint warnings fail CI; cargo fmt settles style."
      ],
      "github": [
        {
          "name": "rust-lang/rust-clippy",
          "url": "https://github.com/rust-lang/rust-clippy"
        },
        {
          "name": "dtolnay/thiserror",
          "url": "https://github.com/dtolnay/thiserror"
        }
      ],
      "resources": [
        {
          "title": "The Rust Book — Writing automated tests",
          "url": "https://doc.rust-lang.org/book/ch11-00-testing.html",
          "kind": "docs"
        },
        {
          "title": "Clippy documentation",
          "url": "https://doc.rust-lang.org/clippy/",
          "kind": "docs"
        },
        {
          "title": "fasterthanlime - Rust videos (YouTube)",
          "url": "https://www.youtube.com/@fasterthanlime",
          "kind": "video"
        },
        {
          "title": "anyhow error type source code on GitHub",
          "url": "https://github.com/dtolnay/anyhow",
          "kind": "repo"
        }
      ],
      "crates": [
        "proptest"
      ],
      "production": [
        "Test behaviour, not implementation, and run cargo test in CI.",
        "Deny warnings with RUSTFLAGS=\"-D warnings\" on the CI matrix."
      ]
    }
  ]
};
