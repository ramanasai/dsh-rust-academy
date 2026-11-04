/**
 * Rust Academy — a Client-only Harness plugin.
 *
 * Registers two things in the Web UI:
 *   - `sidebar.panellist` id `rust-academy`  → the icon in the left sidebar
 *   - `main` key `rust-academy`              → the page shown when it is selected
 *
 * Everything renders with React from the browser module table and styles itself
 * only with `--dsw-alias-*` theme tokens. Progress is stored in localStorage.
 */
window.__ModuleLoader__.load({
  id: '@local/rust-academy',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;

    const NS = 'rust-academy';
    const PROGRESS_KEY = 'dsh.rust-academy.progress.v1';
    const LAST_KEY = 'dsh.rust-academy.last.v1';

    // ------------------------------------------------------------------ i18n

    const DICT = {
      'panel.title': 'Rust Academy',
      'panel.tagline': 'From zero to systems, one lesson at a time',
      'tab.course': 'Course',
      'tab.cheatsheet': 'Cheatsheet',
      'progress.label': '{done} of {total} lessons',
      'action.markComplete': 'Mark complete',
      'action.completed': 'Completed',
      'action.reset': 'Reset',
      'action.confirmReset': 'Reset progress?',
      'action.copy': 'Copy',
      'action.copyPrompt': 'Copy tutor prompt',
      'action.askInChat': 'Ask in chat',
      'action.showHint': 'Show hint',
      'action.hideHint': 'Hide hint',
      'action.showSolution': 'Show solution',
      'action.hideSolution': 'Hide solution',
      'lesson.of': 'Lesson {n} of {total}',
      'lesson.minutes': '{n} min',
      'lesson.goal': 'Goal',
      'lesson.prev': 'Previous',
      'lesson.next': 'Next',
      'exercise.title': 'Your turn',
      'exercise.starter': 'Starter',
      'exercise.solution': 'Solution',
      'cheatsheet.subtitle': 'The syntax you will reach for most often.',
      'toast.copied': 'Copied to clipboard',
      'toast.copyFailed': 'Clipboard unavailable',
      'toast.reset': 'Progress reset',
      'stage.label': 'Stage {n}',
    };

    let localeService = null;
    let layoutService = null;
    let boundTranslate = null;

    function interpolate(text, vars) {
      if (!vars) return text;
      return String(text).replace(/\{(\w+)\}/g, (whole, key) => (
        vars[key] === undefined || vars[key] === null ? whole : String(vars[key])
      ));
    }

    function t(key, vars) {
      let text = null;
      if (boundTranslate) {
        try { text = boundTranslate(key); } catch (error) { text = null; }
      }
      if (text === null || text === undefined || text === key || text === '') {
        text = Object.prototype.hasOwnProperty.call(DICT, key) ? DICT[key] : key;
      }
      return interpolate(text, vars);
    }

    /** Re-render when the active locale or its dictionaries change. */
    function useRevision() {
      const [revision, setRevision] = useState(0);
      useEffect(() => {
        if (!localeService) return undefined;
        let live = true;
        const off = localeService.subscribe(() => {
          if (live) setRevision((value) => value + 1);
        });
        return () => { live = false; off(); };
      }, []);
      return revision;
    }

    // --------------------------------------------------------------- storage

    function readJson(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
      } catch (error) {
        return fallback;
      }
    }

    function writeJson(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch (error) {
        /* storage can be unavailable; progress is best effort */
      }
    }

    // --------------------------------------------------------------- content

    const STAGES = [
      { title: 'Foundations', blurb: 'Programs, types, control flow, functions, text.' },
      { title: 'Ownership', blurb: 'Rust\'s defining idea: moves, borrows, and slices.' },
      { title: 'Data modelling', blurb: 'Structs, enums, Option and Result.' },
      { title: 'Abstraction', blurb: 'Traits, generics, closures, iterators, modules.' },
      { title: 'Real programs', blurb: 'Collections, files, arguments, a complete CLI.' },
      { title: 'Concurrency', blurb: 'Threads, channels, shared state, async with Tokio.' },
      { title: 'Systems & mastery', blurb: 'Lifetimes, smart pointers, tests, idiomatic Rust.' },
    ];

    const LESSONS = [
      {
        id: 'l01', n: 1, stage: 0, title: 'Hello, Cargo & Variables', minutes: 30,
        goal: 'Run your first Rust program with Cargo and bind values to names.',
        sections: [
          {
            h: 'Cargo is your workshop',
            p: ['A Rust project is a folder with a Cargo.toml manifest. Cargo compiles the code, runs it, tests it, and downloads dependencies. These four commands cover most of your day:'],
            code: `cargo new hello       # create a project
cargo run             # compile + run
cargo check           # find errors fast, without a binary
cargo test            # run tests`,
            tip: 'While you edit, run cargo check rather than cargo run: it is much faster and gives you the same compiler errors.',
          },
          {
            h: 'The shape of a program',
            p: ['Every binary starts at a function named main. Statements end with a semicolon. println! prints a line of text.'],
            code: `fn main() {
    println!("Hello, Rust!");
}`,
            tip: 'The ! means println is a macro, not a function. You will meet more macros later; for now just remember the bang.',
          },
          {
            h: 'let binds a value',
            p: ['Bindings are created with let. The compiler infers the type from the value, so you rarely write it out.'],
            code: `fn main() {
    let name = "Ferris";
    let year = 2015;
    println!("{} was born in {}", name, year);
}`,
            tip: 'Each {} in a format string is filled by the next argument, in order.',
          },
        ],
        exercise: {
          prompt: 'Print one line that includes your name and how many lessons you plan to finish this week.',
          starter: `fn main() {
    // 1. bind a name
    // 2. bind a lesson count
    // 3. print both with println!
}`,
          hint: 'println!("{} will finish {} lessons this week!", name, lessons) — placeholders are filled left to right.',
          solution: `fn main() {
    let name = "Sai";
    let lessons = 5;
    println!("{} will finish {} lessons this week!", name, lessons);
}`,
        },
      },
      {
        id: 'l02', n: 2, stage: 0, title: 'Types & Mutability', minutes: 35,
        goal: 'Know Rust\'s scalar types, and when a binding needs mut.',
        sections: [
          {
            h: 'Every value has a type',
            p: ['Rust is statically typed, but it infers types from how a value is used. When inference is not enough, annotate with a colon:'],
            code: `let count = 3;              // i32, the default integer
let ratio: f64 = 0.75;      // 64-bit float
let ready = true;           // bool
let letter = 'R';           // char, single quotes
let label = "Rust";         // &str, borrowed text`,
            tip: 'Integers come in i8/i16/i32/i64/i128, their unsigned u* twins, and isize/usize for indexing.',
          },
          {
            h: 'Immutability is the default',
            p: ['A binding cannot be reassigned unless you opt in with mut. This is a feature: most values never change, and the compiler enforces it.'],
            code: `let x = 5;
// x = 6;                  // error: cannot assign twice to immutable binding
let mut y = 5;
y = 6;                     // fine
let z = 5;
let z = z + 1;             // shadowing: a NEW binding, also fine`,
          },
          {
            h: 'Constants',
            p: ['const values are known at compile time, must be annotated, and live for the whole program.'],
            code: `const MAX_POINTS: u32 = 100_000;

fn main() {
    println!("max = {}", MAX_POINTS);
}`,
          },
        ],
        exercise: {
          prompt: 'The program below does not compile. Make the smallest change so it prints area = 22.5.',
          starter: `fn main() {
    let width = 4.5;
    let height = 3.0;
    height = 5.0;            // fix me
    let area = width * height;
    println!("area = {}", area);
}`,
          hint: 'Bindings are immutable unless declared mut. Change the declaration of height.',
          solution: `fn main() {
    let width = 4.5;
    let mut height = 3.0;
    height = 5.0;
    let area = width * height;
    println!("area = {}", area);
}`,
        },
      },
      {
        id: 'l03', n: 3, stage: 0, title: 'Control Flow', minutes: 40,
        goal: 'Branch with if and match, and loop with for, while and loop.',
        sections: [
          {
            h: 'if is an expression',
            p: ['An if block evaluates to a value, so it can initialise a binding. Both arms must have the same type.'],
            code: `let n = 7;
let kind = if n % 2 == 0 { "even" } else { "odd" };
println!("{} is {}", n, kind);`,
          },
          {
            h: 'Three loops',
            p: ['loop repeats until you break. while repeats while a condition holds. for walks an iterator, which is what you want most of the time.'],
            code: `for i in 0..3 {            // 0, 1, 2
    println!("i = {}", i);
}

let mut count = 0;
while count < 3 {
    count += 1;
}

loop {
    break;                    // exit
}`,
          },
          {
            h: 'match is exhaustive',
            p: ['match compares a value against patterns and must cover every possibility. The compiler rejects a match that misses a case.'],
            code: `let n = 2;
match n {
    1 => println!("one"),
    2 | 3 => println!("two or three"),
    other => println!("something else: {}", other),
}`,
            tip: 'The _ pattern matches anything and ignores the value; a name like other matches anything and binds it.',
          },
        ],
        exercise: {
          prompt: 'Use a for loop to sum the even numbers from 1 to 10, then print the total.',
          starter: `fn main() {
    let mut total = 0;
    // loop over 1..=10, add only the even numbers
    println!("total = {}", total);
}`,
          hint: 'Inside the loop, if n % 2 == 0 { total += n; } — or filter with (1..=10).filter(|n| n % 2 == 0).',
          solution: `fn main() {
    let mut total = 0;
    for n in 1..=10 {
        if n % 2 == 0 {
            total += n;
        }
    }
    println!("total = {}", total);   // 30
}`,
        },
      },
      {
        id: 'l04', n: 4, stage: 0, title: 'Functions & Expressions', minutes: 35,
        goal: 'Split work into typed functions and understand expression bodies.',
        sections: [
          {
            h: 'Functions take typed parameters',
            p: ['Parameters need explicit types; the return type follows an arrow. The last expression of a block is its value, so a function body can be a single expression without return.'],
            code: `fn add(a: i32, b: i32) -> i32 {
    a + b                 // no semicolon: this is the return value
}

fn main() {
    println!("{}", add(2, 3));
}`,
            tip: 'A semicolon turns an expression into a statement that produces (). Adding one after a + b would be a type error.',
          },
          {
            h: 'Statements and early return',
            p: ['Use return when you need to leave early. Statements before the tail expression run first.'],
            code: `fn sign(n: i32) -> &'static str {
    if n < 0 {
        return "negative";
    }
    if n == 0 {
        return "zero";
    }
    "positive"
}`,
          },
          {
            h: 'Functions own their parameters',
            p: ['Passing a String by value moves it into the function. Passing a reference borrows it, which is usually what you want (Lesson 7).'],
            code: `fn shout(text: &str) {
    println!("{}!", text.to_uppercase());
}

fn main() {
    let word = String::from("hello");
    shout(&word);          // borrow
    println!("{}", word);  // still usable
}`,
          },
        ],
        exercise: {
          prompt: 'Write fn is_even(n: i32) -> bool, then print whether 42 is even.',
          starter: `fn is_even(n: i32) -> bool {
    // return true when n is divisible by 2
}

fn main() {
    println!("42 is even: {}", is_even(42));
}`,
          hint: 'The body can be the expression n % 2 == 0.',
          solution: `fn is_even(n: i32) -> bool {
    n % 2 == 0
}

fn main() {
    println!("42 is even: {}", is_even(42));
}`,
        },
      },
      {
        id: 'l05', n: 5, stage: 0, title: 'Strings & Text', minutes: 30,
        goal: 'Tell borrowed &str from owned String and inspect text safely.',
        sections: [
          {
            h: '&str and String',
            p: ['&str is borrowed text you do not own. String is owned, growable heap text. String literals are &str; build a String when you need to change it.'],
            code: `let literal = "hello";                 // &str
let mut owned = String::from("hello"); // String
owned.push_str(" world");
println!("{}", owned);                 // hello world
println!("{}", literal.len());         // 5 (bytes)`,
            tip: 'len() counts bytes, not characters. Use chars().count() for characters.',
          },
          {
            h: 'Formatting',
            p: ['format! builds a new String; println! writes to stdout. {:?} prints the debug form of a value.'],
            code: `let name = "Ferris";
let age = 10;
let line = format!("{} is {} years old", name, age);
println!("{:?}", line);`,
          },
          {
            h: 'Inspecting text',
            p: ['These methods return new values; they do not mutate the original unless it is a &mut String.'],
            code: `let s = "  Rust is fun  ";
println!("{}", s.trim());                 // Rust is fun
println!("{}", s.trim().to_uppercase());  // RUST IS FUN
for word in s.split_whitespace() {
    println!("{}", word);
}`,
          },
        ],
        exercise: {
          prompt: 'Count how many vowels (a, e, i, o, u) are in a string and print the count.',
          starter: `fn main() {
    let text = "Rust is fun to learn";
    let mut vowels = 0;
    // count the vowels
    println!("vowels = {}", vowels);
}`,
          hint: 'Iterate text.chars() and match the lowercase character against the five vowels.',
          solution: `fn main() {
    let text = "Rust is fun to learn";
    let mut vowels = 0;
    for ch in text.chars() {
        match ch.to_ascii_lowercase() {
            'a' | 'e' | 'i' | 'o' | 'u' => vowels += 1,
            _ => {}
        }
    }
    println!("vowels = {}", vowels);
}`,
        },
      },
      {
        id: 'l06', n: 6, stage: 1, title: 'Ownership & Moves', minutes: 45,
        goal: 'Understand why a value has exactly one owner, and when to clone.',
        sections: [
          {
            h: 'Each value has one owner',
            p: ['Stack values are copied. Heap values (String, Vec) have a single owner, and assigning one moves ownership: the old binding can no longer be used.'],
            code: `let a = String::from("hello");
let b = a;                  // ownership moves to b
// println!("{}", a);       // error: value borrowed after move
println!("{}", b);          // fine`,
            tip: 'The compiler is not being fussy: two owners would mean two frees, which is exactly the double-free bug Rust prevents.',
          },
          {
            h: 'clone and Copy',
            p: ['clone() makes a deep copy of heap data. Types like i32, bool and char are Copy: assignment copies them and the original stays usable.'],
            code: `let a = String::from("hello");
let b = a.clone();          // deep copy
println!("{} {}", a, b);    // both usable

let x = 5;
let y = x;                  // copied, because i32 is Copy
println!("{} {}", x, y);`,
          },
          {
            h: 'Ownership moves into functions',
            p: ['Passing a value by value moves it. If the function does not give it back, the caller cannot use it again.'],
            code: `fn consume(s: String) {
    println!("{}", s);
}                           // s is dropped here

fn main() {
    let text = String::from("bye");
    consume(text);
    // println!("{}", text); // error: moved
}`,
          },
        ],
        exercise: {
          prompt: 'The program below fails to compile. Fix it so both values print, without removing the final println.',
          starter: `fn main() {
    let a = String::from("hello");
    let b = a;
    println!("{} {}", a, b);   // fix me
}`,
          hint: 'a was moved into b. Either clone a, or print a before the move.',
          solution: `fn main() {
    let a = String::from("hello");
    let b = a.clone();
    println!("{} {}", a, b);
}`,
        },
      },
      {
        id: 'l07', n: 7, stage: 1, title: 'Borrowing & References', minutes: 45,
        goal: 'Use & and &mut to lend values without moving them.',
        sections: [
          {
            h: 'Borrow instead of moving',
            p: ['A reference lets a function read a value without taking ownership. The owner keeps the value.'],
            code: `fn length(s: &String) -> usize {
    s.len()
}

fn main() {
    let text = String::from("rust");
    let n = length(&text);
    println!("{} has {} bytes", text, n);   // text still owned here
}`,
          },
          {
            h: 'Mutable borrows are exclusive',
            p: ['At any moment you may have either many immutable references or exactly one mutable reference — never both. This rule is what makes data races impossible.'],
            code: `let mut s = String::from("rust");
let r1 = &s;
let r2 = &s;
println!("{} {}", r1, r2);   // many shared borrows: fine

let m = &mut s;
m.push_str("!");
// println!("{}", r1);       // error: cannot borrow s while mutably borrowed`,
            tip: 'Borrows end at their last use (non-lexical lifetimes), so code often compiles even when a variable stays in scope.',
          },
          {
            h: 'The rules in one line',
            p: ['Many readers or one writer. No value is used after its owner dies. References always point at valid data.'],
            code: `fn main() {
    let mut numbers = vec![1, 2, 3];
    for n in &numbers {
        println!("{}", n);
    }
    numbers.push(4);          // fine: the shared borrows are over
    println!("{:?}", numbers);
}`,
          },
        ],
        exercise: {
          prompt: 'The snippet has a borrow conflict. Reorder or narrow the borrow so it compiles.',
          starter: `fn main() {
    let mut s = String::from("rust");
    let r = &mut s;
    s.push_str("!");          // conflict: s is mutably borrowed
    r.push_str("?");
    println!("{}", r);
}`,
          hint: 'While r is alive, use r instead of s. Call r.push_str("!") and print r.',
          solution: `fn main() {
    let mut s = String::from("rust");
    let r = &mut s;
    r.push_str("!");
    println!("{}", r);
}`,
        },
      },
      {
        id: 'l08', n: 8, stage: 1, title: 'Slices', minutes: 30,
        goal: 'Point at part of a collection without copying it.',
        sections: [
          {
            h: 'A slice is a view',
            p: ['A slice is a reference to a contiguous run of elements. It knows its length but owns nothing.'],
            code: `let v = vec![10, 20, 30, 40];
let middle = &v[1..3];        // [20, 30]
println!("{:?}", middle);

let text = String::from("hello world");
let hello = &text[..5];
println!("{}", hello);`,
            tip: 'Slicing a String by byte index panics if the index is not a char boundary. Prefer split/char_indices for user text.',
          },
          {
            h: 'String slices in signatures',
            p: ['Take &str rather than &String: &str accepts both string literals and borrowed Strings, so the function is more flexible.'],
            code: `fn first_word(s: &str) -> &str {
    for (i, ch) in s.char_indices() {
        if ch == ' ' {
            return &s[..i];
        }
    }
    s
}

fn main() {
    println!("{}", first_word("hello world"));
}`,
          },
          {
            h: 'Why slices are safe',
            p: ['A slice keeps the borrow alive, so the owner cannot be mutated or dropped while the slice is in use.'],
            code: `fn main() {
    let mut data = vec![1, 2, 3];
    let head = &data[0];
    // data.push(4);          // error: cannot mutate while borrowed
    println!("{}", head);
}`,
          },
        ],
        exercise: {
          prompt: 'Write fn first_word(s: &str) -> &str that returns the text before the first space.',
          starter: `fn first_word(s: &str) -> &str {
    // return the slice before the first space
}

fn main() {
    println!("{}", first_word("borrow the data"));
}`,
          hint: 'Loop over s.char_indices(), return &s[..i] when you find a space, and return s if there is none.',
          solution: `fn first_word(s: &str) -> &str {
    for (i, ch) in s.char_indices() {
        if ch == ' ' {
            return &s[..i];
        }
    }
    s
}

fn main() {
    println!("{}", first_word("borrow the data"));
}`,
        },
      },
      {
        id: 'l09', n: 9, stage: 2, title: 'Structs & Methods', minutes: 40,
        goal: 'Group related data and attach behaviour to it.',
        sections: [
          {
            h: 'Define a struct',
            p: ['Structs name a set of fields. The field-init shorthand reuses a variable with the same name.'],
            code: `struct User {
    name: String,
    active: bool,
}

fn main() {
    let name = String::from("Ferris");
    let user = User { name, active: true };
    println!("{} {}", user.name, user.active);
}`,
          },
          {
            h: 'Methods live in impl',
            p: ['Methods take self, &self or &mut self. Associated functions have no self and are called with ::.'],
            code: `struct Rectangle {
    width: u32,
    height: u32,
}

impl Rectangle {
    fn area(&self) -> u32 {
        self.width * self.height
    }

    fn square(size: u32) -> Rectangle {
        Rectangle { width: size, height: size }
    }
}

fn main() {
    let r = Rectangle::square(4);
    println!("{}", r.area());      // 16
}`,
          },
          {
            h: 'Deriving common traits',
            p: ['derive asks the compiler to generate standard implementations for you.'],
            code: `#[derive(Debug, Clone, PartialEq)]
struct Point {
    x: i32,
    y: i32,
}

fn main() {
    let p = Point { x: 1, y: 2 };
    println!("{:?}", p);
    assert_eq!(p, p.clone());
}`,
          },
        ],
        exercise: {
          prompt: 'Add a can_hold method that returns true when self is big enough to contain another rectangle.',
          starter: `struct Rectangle {
    width: u32,
    height: u32,
}

impl Rectangle {
    fn area(&self) -> u32 {
        self.width * self.height
    }
    // add can_hold(&self, other: &Rectangle) -> bool
}

fn main() {
    let a = Rectangle { width: 10, height: 8 };
    let b = Rectangle { width: 4, height: 3 };
    println!("can hold: {}", a.can_hold(&b));
}`,
          hint: 'Compare both dimensions: self.width >= other.width && self.height >= other.height.',
          solution: `struct Rectangle {
    width: u32,
    height: u32,
}

impl Rectangle {
    fn area(&self) -> u32 {
        self.width * self.height
    }

    fn can_hold(&self, other: &Rectangle) -> bool {
        self.width >= other.width && self.height >= other.height
    }
}

fn main() {
    let a = Rectangle { width: 10, height: 8 };
    let b = Rectangle { width: 4, height: 3 };
    println!("can hold: {}", a.can_hold(&b));
}`,
        },
      },
      {
        id: 'l10', n: 10, stage: 2, title: 'Enums & Pattern Matching', minutes: 45,
        goal: 'Model alternatives with data, and destructure them with match.',
        sections: [
          {
            h: 'Enums hold data',
            p: ['An enum value is exactly one of its variants, and each variant can carry its own data.'],
            code: `enum Message {
    Quit,
    Move { x: i32, y: i32 },
    Write(String),
}

fn main() {
    let m = Message::Move { x: 3, y: 4 };
    match m {
        Message::Quit => println!("quit"),
        Message::Move { x, y } => println!("move to {}, {}", x, y),
        Message::Write(text) => println!("write {}", text),
    }
}`,
          },
          {
            h: 'Option is an enum',
            p: ['Option<T> is Some(T) or None. It replaces null: the compiler forces you to handle the empty case.'],
            code: `fn half(n: i32) -> Option<i32> {
    if n % 2 == 0 { Some(n / 2) } else { None }
}

fn main() {
    match half(10) {
        Some(v) => println!("half = {}", v),
        None => println!("odd"),
    }

    if let Some(v) = half(8) {
        println!("half = {}", v);
    }
}`,
          },
          {
            h: 'match can bind and guard',
            p: ['Patterns can bind parts of a value and add conditions with if.'],
            code: `let pair = (0, 5);
match pair {
    (0, y) => println!("on the y axis at {}", y),
    (x, 0) => println!("on the x axis at {}", x),
    (x, y) if x == y => println!("diagonal at {}", x),
    (x, y) => println!("somewhere at {}, {}", x, y),
}`,
          },
        ],
        exercise: {
          prompt: 'Model a Shape enum with Circle(f64) and Rectangle(f64, f64), then compute the area in a match.',
          starter: `enum Shape {
    Circle(f64),
    Rectangle(f64, f64),
}

fn area(shape: &Shape) -> f64 {
    // match on the shape
}

fn main() {
    println!("{}", area(&Shape::Circle(2.0)));
    println!("{}", area(&Shape::Rectangle(3.0, 4.0)));
}`,
          hint: 'std::f64::consts::PI is available. Match Circle(r) => PI * r * r and Rectangle(w, h) => w * h.',
          solution: `enum Shape {
    Circle(f64),
    Rectangle(f64, f64),
}

fn area(shape: &Shape) -> f64 {
    match shape {
        Shape::Circle(r) => std::f64::consts::PI * r * r,
        Shape::Rectangle(w, h) => w * h,
    }
}

fn main() {
    println!("{}", area(&Shape::Circle(2.0)));
    println!("{}", area(&Shape::Rectangle(3.0, 4.0)));
}`,
        },
      },
      {
        id: 'l11', n: 11, stage: 2, title: 'Option, Result & Error Handling', minutes: 50,
        goal: 'Handle absence and failure explicitly instead of crashing.',
        sections: [
          {
            h: 'Option: a value may be absent',
            p: ['Use Option combinators to avoid nested matches. unwrap_or supplies a default; map transforms the value when present.'],
            code: `let maybe: Option<i32> = Some(3);
println!("{}", maybe.unwrap_or(0));       // 3
println!("{}", maybe.map(|n| n * 2).unwrap_or(0)); // 6

let empty: Option<i32> = None;
println!("{}", empty.unwrap_or(-1));      // -1`,
            tip: 'unwrap() panics on None. It is fine in prototypes and tests, but libraries should return Option or Result.',
          },
          {
            h: 'Result: an operation may fail',
            p: ['Result<T, E> is Ok(T) or Err(E). Parsing is the classic example.'],
            code: `let good = "42".parse::<i32>();
let bad = "nope".parse::<i32>();

match good {
    Ok(n) => println!("parsed {}", n),
    Err(e) => println!("failed: {}", e),
}

println!("{:?}", bad.is_err());`,
          },
          {
            h: 'The ? operator',
            p: ['Inside a function returning Result, ? returns early on Err and unwraps on Ok. main can return Result too.'],
            code: `use std::num::ParseIntError;

fn double(text: &str) -> Result<i32, ParseIntError> {
    let n: i32 = text.parse()?;   // early-returns the error
    Ok(n * 2)
}

fn main() -> Result<(), ParseIntError> {
    println!("{}", double("21")?);
    Ok(())
}`,
          },
        ],
        exercise: {
          prompt: 'Write fn parse_positive(text: &str) -> Result<u32, String> that parses and rejects zero.',
          starter: `fn parse_positive(text: &str) -> Result<u32, String> {
    // parse as u32, then reject 0 with a useful message
}

fn main() {
    println!("{:?}", parse_positive("7"));
    println!("{:?}", parse_positive("0"));
    println!("{:?}", parse_positive("x"));
}`,
          hint: 'Use text.parse::<u32>().map_err(|e| e.to_string())? and then check the value.',
          solution: `fn parse_positive(text: &str) -> Result<u32, String> {
    let n = text.parse::<u32>().map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(String::from("must be greater than zero"));
    }
    Ok(n)
}

fn main() {
    println!("{:?}", parse_positive("7"));
    println!("{:?}", parse_positive("0"));
    println!("{:?}", parse_positive("x"));
}`,
        },
      },
      {
        id: 'l12', n: 12, stage: 3, title: 'Traits & Generics', minutes: 50,
        goal: 'Share behaviour with traits and write code over many types.',
        sections: [
          {
            h: 'Traits describe behaviour',
            p: ['A trait is a set of methods a type promises to provide. Implementations are separate from the type.'],
            code: `trait Summary {
    fn summarize(&self) -> String;
}

struct Article {
    title: String,
}

impl Summary for Article {
    fn summarize(&self) -> String {
        format!("{} (article)", self.title)
    }
}`,
          },
          {
            h: 'Default methods',
            p: ['Traits may provide default bodies; implementors override only what they need.'],
            code: `trait Greet {
    fn name(&self) -> String;
    fn greet(&self) -> String {
        format!("Hello, {}!", self.name())
    }
}

struct Bot;
impl Greet for Bot {
    fn name(&self) -> String { String::from("Ferris") }
}

fn main() {
    println!("{}", Bot.greet());
}`,
          },
          {
            h: 'Generics with bounds',
            p: ['A generic function works for many types as long as they satisfy the bounds you declare.'],
            code: `fn largest<T: PartialOrd + Copy>(list: &[T]) -> T {
    let mut biggest = list[0];
    for &item in list {
        if item > biggest {
            biggest = item;
        }
    }
    biggest
}

fn main() {
    println!("{}", largest(&[3, 9, 2]));
    println!("{}", largest(&[1.5, 0.5]));
}`,
          },
        ],
        exercise: {
          prompt: 'Define a trait Area with fn area(&self) -> f64, implement it for Rectangle, and print the area through a generic function.',
          starter: `trait Area {
    fn area(&self) -> f64;
}

struct Rectangle {
    width: f64,
    height: f64,
}

// implement Area for Rectangle

fn print_area<T: Area>(shape: &T) {
    println!("area = {}", shape.area());
}

fn main() {
    print_area(&Rectangle { width: 3.0, height: 4.0 });
}`,
          hint: 'impl Area for Rectangle { fn area(&self) -> f64 { self.width * self.height } }',
          solution: `trait Area {
    fn area(&self) -> f64;
}

struct Rectangle {
    width: f64,
    height: f64,
}

impl Area for Rectangle {
    fn area(&self) -> f64 {
        self.width * self.height
    }
}

fn print_area<T: Area>(shape: &T) {
    println!("area = {}", shape.area());
}

fn main() {
    print_area(&Rectangle { width: 3.0, height: 4.0 });
}`,
        },
      },
      {
        id: 'l13', n: 13, stage: 3, title: 'Closures & Iterators', minutes: 45,
        goal: 'Write concise data pipelines with closures and iterator adapters.',
        sections: [
          {
            h: 'Closures capture their environment',
            p: ['A closure is an inline function that can use variables from the surrounding scope.'],
            code: `fn main() {
    let factor = 3;
    let scale = |n: i32| n * factor;
    println!("{}", scale(7));       // 21
}`,
          },
          {
            h: 'Iterator chains',
            p: ['Iterator adapters are lazy: nothing runs until a consumer such as sum, collect or count pulls values.'],
            code: `let numbers = vec![1, 2, 3, 4, 5, 6];

let total: i32 = numbers
    .iter()
    .filter(|n| *n % 2 == 0)
    .map(|n| n * n)
    .sum();

println!("{}", total);             // 4 + 16 + 36 = 56`,
            tip: 'Prefer iterator chains to manual index loops: they state intent, avoid off-by-one bugs, and optimise well.',
          },
          {
            h: 'Collect into a new collection',
            p: ['collect turns an iterator back into a Vec, HashMap, String and more; annotate the target type.'],
            code: `let words = vec!["rust", "is", "fun"];
let loud: Vec<String> = words
    .iter()
    .map(|w| w.to_uppercase())
    .collect();
println!("{:?}", loud);`,
          },
        ],
        exercise: {
          prompt: 'Using iterators, sum the squares of the even numbers in the vector.',
          starter: `fn main() {
    let numbers = vec![1, 2, 3, 4, 5, 6];
    let total: i32 = 0;   // replace with an iterator chain
    println!("total = {}", total);
}`,
          hint: 'numbers.iter().filter(|n| *n % 2 == 0).map(|n| n * n).sum()',
          solution: `fn main() {
    let numbers = vec![1, 2, 3, 4, 5, 6];
    let total: i32 = numbers
        .iter()
        .filter(|n| *n % 2 == 0)
        .map(|n| n * n)
        .sum();
    println!("total = {}", total);   // 56
}`,
        },
      },
      {
        id: 'l14', n: 14, stage: 3, title: 'Modules, Crates & Cargo', minutes: 35,
        goal: 'Split code across modules and pull in third-party crates.',
        sections: [
          {
            h: 'Modules organise code',
            p: ['mod declares a namespace; pub makes an item visible outside it. use brings a path into scope.'],
            code: `mod geometry {
    pub fn area(w: f64, h: f64) -> f64 {
        w * h
    }
}

use geometry::area;

fn main() {
    println!("{}", area(3.0, 4.0));
}`,
          },
          {
            h: 'Files and crates',
            p: ['A package has a library (src/lib.rs) or a binary (src/main.rs), and any number of extra binaries in src/bin/. A dependency is a crate from crates.io, declared in Cargo.toml.'],
            code: `cargo add serde --features derive
cargo add tokio --features full`,
          },
          {
            h: 'Dependencies in Cargo.toml',
            p: ['The manifest records versions; Cargo.lock pins exact builds for reproducibility.'],
            code: `[package]
name = "my-cli"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }`,
          },
        ],
        exercise: {
          prompt: 'Move a helper function into a module named text, make it public, and call it from main with a use path.',
          starter: `fn shout(s: &str) -> String {
    s.to_uppercase()
}

fn main() {
    println!("{}", shout("hello"));
}`,
          hint: 'Wrap the function in mod text { pub fn shout(...) } and add use text::shout;',
          solution: `mod text {
    pub fn shout(s: &str) -> String {
        s.to_uppercase()
    }
}

use text::shout;

fn main() {
    println!("{}", shout("hello"));
}`,
        },
      },
      {
        id: 'l15', n: 15, stage: 4, title: 'Collections in Depth', minutes: 40,
        goal: 'Choose the right collection and use the HashMap entry API.',
        sections: [
          {
            h: 'Vec and HashMap',
            p: ['Vec is a growable array. HashMap stores key-value pairs with fast lookup.'],
            code: `use std::collections::HashMap;

fn main() {
    let mut scores: HashMap<String, i32> = HashMap::new();
    scores.insert(String::from("ferris"), 10);

    match scores.get("ferris") {
        Some(score) => println!("score = {}", score),
        None => println!("unknown player"),
    }
}`,
          },
          {
            h: 'The entry API',
            p: ['entry handles "insert if missing" in one step, which is the usual counting pattern.'],
            code: `use std::collections::HashMap;

fn main() {
    let words = ["rust", "is", "fun", "rust"];
    let mut counts: HashMap<&str, i32> = HashMap::new();
    for word in words {
        *counts.entry(word).or_insert(0) += 1;
    }
    println!("{:?}", counts);      // {"fun": 1, "is": 1, "rust": 2}
}`,
          },
          {
            h: 'Choosing a collection',
            p: ['Vec: ordered list, index access. HashMap: key-value with unordered iteration. HashSet: membership tests. BTreeMap: sorted keys. VecDeque: push/pop at both ends.'],
            code: `let mut seen = std::collections::HashSet::new();
seen.insert("a");
println!("{}", seen.contains("a"));   // true`,
          },
        ],
        exercise: {
          prompt: 'Count how many times each word appears in a sentence and print the map.',
          starter: `use std::collections::HashMap;

fn main() {
    let sentence = "the quick brown fox jumps over the lazy dog the end";
    let mut counts: HashMap<&str, i32> = HashMap::new();
    // fill counts using split_whitespace and entry
    println!("{:?}", counts);
}`,
          hint: 'for word in sentence.split_whitespace() { *counts.entry(word).or_insert(0) += 1; }',
          solution: `use std::collections::HashMap;

fn main() {
    let sentence = "the quick brown fox jumps over the lazy dog the end";
    let mut counts: HashMap<&str, i32> = HashMap::new();
    for word in sentence.split_whitespace() {
        *counts.entry(word).or_insert(0) += 1;
    }
    println!("{:?}", counts);
}`,
        },
      },
      {
        id: 'l16', n: 16, stage: 4, title: 'Files, I/O & a CLI Tool', minutes: 50,
        goal: 'Read files, accept arguments, and return exit codes.',
        sections: [
          {
            h: 'Read a file',
            p: ['std::fs::read_to_string reads a whole file into a String and returns a Result.'],
            code: `use std::fs;

fn main() -> std::io::Result<()> {
    let text = fs::read_to_string("Cargo.toml")?;
    println!("{} bytes", text.len());
    Ok(())
}`,
          },
          {
            h: 'Arguments and exit codes',
            p: ['env::args yields the program name first, then the arguments. Return a non-zero status on failure.'],
            code: `use std::process;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = match args.next() {
        Some(path) => path,
        None => {
            eprintln!("usage: counter <file>");
            process::exit(2);
        }
    };
    println!("reading {}", path);
}`,
          },
          {
            h: 'A tiny wc',
            p: ['Combining the pieces gives a real tool: read, count, print.'],
            code: `use std::fs;

fn main() -> std::io::Result<()> {
    let path = std::env::args().nth(1).unwrap_or_else(|| String::from("Cargo.toml"));
    let text = fs::read_to_string(&path)?;
    let lines = text.lines().count();
    let words = text.split_whitespace().count();
    println!("{} {} {}", lines, words, path);
    Ok(())
}`,
          },
        ],
        exercise: {
          prompt: 'Write a program that prints the number of lines in the file passed as the first argument.',
          starter: `use std::fs;

fn main() -> std::io::Result<()> {
    // read the first argument, then print the line count
    Ok(())
}`,
          hint: 'let path = std::env::args().nth(1).unwrap_or_default(); then fs::read_to_string(path)?.lines().count().',
          solution: `use std::fs;

fn main() -> std::io::Result<()> {
    let path = std::env::args().nth(1).unwrap_or_else(|| String::from("Cargo.toml"));
    let text = fs::read_to_string(path)?;
    println!("{} lines", text.lines().count());
    Ok(())
}`,
        },
      },
      {
        id: 'l17', n: 17, stage: 5, title: 'Threads, Channels & Shared State', minutes: 50,
        goal: 'Run work in parallel and share data without data races.',
        sections: [
          {
            h: 'thread::spawn',
            p: ['A spawned thread runs a closure. move transfers captured values into it; join waits for it to finish.'],
            code: `use std::thread;

fn main() {
    let handle = thread::spawn(|| {
        println!("from another thread");
    });
    handle.join().unwrap();
    println!("from main");
}`,
          },
          {
            h: 'Channels',
            p: ['mpsc is a multi-producer, single-consumer channel. Sending moves the value across threads.'],
            code: `use std::sync::mpsc;
use std::thread;

fn main() {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        tx.send(42).unwrap();
    });
    println!("got {}", rx.recv().unwrap());
}`,
          },
          {
            h: 'Shared state',
            p: ['Arc lets several threads share ownership; Mutex allows one thread at a time to mutate the value inside.'],
            code: `use std::sync::{Arc, Mutex};
use std::thread;

fn main() {
    let shared = Arc::new(Mutex::new(Vec::new()));
    let mut handles = Vec::new();
    for n in 0..3 {
        let clone = Arc::clone(&shared);
        handles.push(thread::spawn(move || {
            clone.lock().unwrap().push(n);
        }));
    }
    for handle in handles {
        handle.join().unwrap();
    }
    println!("{:?}", shared.lock().unwrap());
}`,
            tip: 'The compiler will not let you send a plain Rc or &mut across threads: the same ownership rules that prevent use-after-free also prevent data races.',
          },
        ],
        exercise: {
          prompt: 'Spawn two threads that each push a number into a shared Vec, join them, then print the Vec.',
          starter: `use std::sync::{Arc, Mutex};
use std::thread;

fn main() {
    let shared = Arc::new(Mutex::new(Vec::new()));
    // spawn two threads, each pushing one number
}`,
          hint: 'Clone the Arc per thread, move it in, lock and push, then join both handles.',
          solution: `use std::sync::{Arc, Mutex};
use std::thread;

fn main() {
    let shared = Arc::new(Mutex::new(Vec::new()));
    let mut handles = Vec::new();
    for n in [1, 2] {
        let clone = Arc::clone(&shared);
        handles.push(thread::spawn(move || {
            clone.lock().unwrap().push(n);
        }));
    }
    for handle in handles {
        handle.join().unwrap();
    }
    println!("{:?}", shared.lock().unwrap());
}`,
        },
      },
      {
        id: 'l18', n: 18, stage: 5, title: 'Async & Tokio Basics', minutes: 55,
        goal: 'Write async functions and run them concurrently on a Tokio runtime.',
        sections: [
          {
            h: 'async fn returns a future',
            p: ['Calling an async function does nothing until the future is awaited. This lets one thread juggle many pending tasks.'],
            code: `async fn fetch(url: &str) -> String {
    format!("body of {}", url)
}

#[tokio::main]
async fn main() {
    let body = fetch("https://example.com").await;
    println!("{}", body);
}`,
            tip: 'Add tokio with features = ["full"] to Cargo.toml; #[tokio::main] builds the runtime for you.',
          },
          {
            h: 'Concurrency with join!',
            p: ['Awaiting one future at a time is sequential. join! polls several at once and waits for all of them.'],
            code: `use tokio::time::{sleep, Duration};

async fn task(id: u32) -> u32 {
    sleep(Duration::from_millis(100)).await;
    id * 10
}

#[tokio::main]
async fn main() {
    let (a, b) = tokio::join!(task(1), task(2));
    println!("{} {}", a, b);
}`,
          },
          {
            h: 'Async rules of thumb',
            p: ['Never block inside an async task: use async versions of I/O, or spawn_blocking. Prefer tokio::spawn for fire-and-forget work and keep shared state behind Arc<Mutex<_>> or channels.'],
            code: `let handle = tokio::spawn(async {
    1 + 1
});
println!("{}", handle.await.unwrap());`,
          },
        ],
        exercise: {
          prompt: 'Write an async function that sleeps 50ms and returns a number; run two of them concurrently with join!.',
          starter: `use tokio::time::{sleep, Duration};

async fn work(id: u32) -> u32 {
    // sleep, then return id * 2
}

#[tokio::main]
async fn main() {
    // use tokio::join! to run two work calls together
}`,
          hint: 'sleep(Duration::from_millis(50)).await; then return id * 2. let (a, b) = tokio::join!(work(1), work(2));',
          solution: `use tokio::time::{sleep, Duration};

async fn work(id: u32) -> u32 {
    sleep(Duration::from_millis(50)).await;
    id * 2
}

#[tokio::main]
async fn main() {
    let (a, b) = tokio::join!(work(1), work(2));
    println!("{} {}", a, b);
}`,
        },
      },
      {
        id: 'l19', n: 19, stage: 6, title: 'Lifetimes & Smart Pointers', minutes: 55,
        goal: 'Annotate how long references live, and pick the right pointer.',
        sections: [
          {
            h: 'Lifetimes tie references together',
            p: ['A lifetime annotation names a relationship: the returned reference lives no longer than its inputs. You rarely need one, but you must recognise it.'],
            code: `fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {
    if x.len() >= y.len() { x } else { y }
}

fn main() {
    let a = String::from("long string");
    let b = "short";
    println!("{}", longest(&a, b));
}`,
            tip: 'Elision covers the common cases: one input reference means the output borrows from it; &self means the output borrows from self.',
          },
          {
            h: 'Ownership beyond the stack',
            p: ['Box puts a value on the heap. Rc shares ownership between several owners on one thread. RefCell moves borrow checking to runtime for interior mutability.'],
            code: `use std::rc::Rc;
use std::cell::RefCell;

fn main() {
    let boxed = Box::new(5);
    println!("{}", boxed);

    let shared = Rc::new(String::from("data"));
    let second = Rc::clone(&shared);
    println!("{} {}", shared, second);

    let cell = RefCell::new(1);
    *cell.borrow_mut() += 1;
    println!("{}", cell.borrow());
}`,
          },
          {
            h: 'Choosing a pointer',
            p: ['Box<T>: single owner, heap allocation. Rc<T>: shared, immutable, single thread. Arc<T>: shared across threads. RefCell<T>: runtime-checked mutation behind a shared reference. Mutex<T>: cross-thread mutation.'],
            code: `use std::sync::{Arc, Mutex};

let shared = Arc::new(Mutex::new(0));
*shared.lock().unwrap() += 1;
println!("{}", shared.lock().unwrap());`,
          },
        ],
        exercise: {
          prompt: 'Implement longest with an explicit lifetime and call it with two string slices.',
          starter: `fn longest(x: &str, y: &str) -> &str {
    if x.len() >= y.len() { x } else { y }
}

fn main() {
    println!("{}", longest("alpha", "beta"));
}`,
          hint: 'Add <\'a> after the function name and mark x, y and the return type with &\'a str.',
          solution: `fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {
    if x.len() >= y.len() { x } else { y }
}

fn main() {
    println!("{}", longest("alpha", "beta"));
}`,
        },
      },
      {
        id: 'l20', n: 20, stage: 6, title: 'Testing, Errors & Idiomatic Rust', minutes: 45,
        goal: 'Test what you build and write code other Rust programmers expect.',
        sections: [
          {
            h: 'Unit tests live beside the code',
            p: ['A #[cfg(test)] module compiles only for tests. assert_eq! reports both sides when it fails.'],
            code: `pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_numbers() {
        assert_eq!(add(2, 3), 5);
    }
}`,
          },
          {
            h: 'Errors with context',
            p: ['Libraries define precise error enums (thiserror); applications add context to any error (anyhow). Both use ? in the same way.'],
            code: `use anyhow::{Context, Result};

fn load(path: &str) -> Result<String> {
    std::fs::read_to_string(path)
        .with_context(|| format!("could not read {}", path))
}`,
          },
          {
            h: 'Idiomatic habits',
            p: ['Run cargo fmt and cargo clippy often. Prefer iterator chains to index loops. Avoid unwrap in library code. Take &str instead of &String, and &[T] instead of &Vec<T>. Write the test first when a bug is reported.'],
            code: `cargo fmt
cargo clippy -- -D warnings
cargo test`,
          },
        ],
        exercise: {
          prompt: 'Write two unit tests for a function that multiplies two numbers: one normal case and one with zero.',
          starter: `fn multiply(a: i32, b: i32) -> i32 {
    a * b
}

#[cfg(test)]
mod tests {
    use super::*;

    // add #[test] functions here
}`,
          hint: 'Inside mod tests use super::*; each test is a #[test] fn with assert_eq!.',
          solution: `fn multiply(a: i32, b: i32) -> i32 {
    a * b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multiplies_numbers() {
        assert_eq!(multiply(3, 4), 12);
    }

    #[test]
    fn multiplies_by_zero() {
        assert_eq!(multiply(99, 0), 0);
    }
}`,
        },
      },
    ];

    const LESSON_BY_ID = {};
    LESSONS.forEach((lesson) => { LESSON_BY_ID[lesson.id] = lesson; });
    const TOTAL = LESSONS.length;

    const CHEATSHEET = [
      {
        title: 'Cargo commands',
        items: [
          { name: 'new project', code: 'cargo new app' },
          { name: 'run binary', code: 'cargo run --bin name' },
          { name: 'fast check', code: 'cargo check' },
          { name: 'tests', code: 'cargo test' },
          { name: 'lint', code: 'cargo clippy -- -D warnings' },
          { name: 'format', code: 'cargo fmt' },
          { name: 'add crate', code: 'cargo add serde --features derive' },
        ],
      },
      {
        title: 'Bindings & types',
        items: [
          { name: 'immutable', code: 'let x = 5;' },
          { name: 'mutable', code: 'let mut y = 5;\ny += 1;' },
          { name: 'annotated', code: 'let ratio: f64 = 0.5;' },
          { name: 'constant', code: 'const MAX: u32 = 100_000;' },
          { name: 'shadowing', code: 'let x = 5;\nlet x = x + 1;' },
          { name: 'tuple', code: 'let pair = (1, "two");\nprintln!("{}", pair.0);' },
        ],
      },
      {
        title: 'Control flow',
        items: [
          { name: 'if expression', code: 'let kind = if n > 0 { "pos" } else { "neg" };' },
          { name: 'for range', code: 'for i in 0..3 { println!("{}", i); }' },
          { name: 'while', code: 'while n < 3 { n += 1; }' },
          { name: 'loop + break', code: 'loop { break 42; }' },
          { name: 'match', code: 'match n {\n    1 => "one",\n    _ => "other",\n}' },
        ],
      },
      {
        title: 'Functions',
        items: [
          { name: 'definition', code: 'fn add(a: i32, b: i32) -> i32 {\n    a + b\n}' },
          { name: 'early return', code: 'if n < 0 { return 0; }' },
          { name: 'take a slice', code: 'fn total(values: &[i32]) -> i32' },
          { name: 'take text', code: 'fn shout(text: &str) -> String' },
        ],
      },
      {
        title: 'Ownership & borrowing',
        items: [
          { name: 'borrow', code: 'let n = s.len(); // s: &String' },
          { name: 'mutable borrow', code: 'let r = &mut s;\nr.push_str("!");' },
          { name: 'clone', code: 'let copy = s.clone();' },
          { name: 'slice', code: 'let head = &v[..2];' },
          { name: 'string slice', code: 'fn first_word(s: &str) -> &str' },
        ],
      },
      {
        title: 'Structs & enums',
        items: [
          { name: 'struct', code: 'struct Point { x: i32, y: i32 }' },
          { name: 'impl', code: 'impl Point {\n    fn norm(&self) -> i32 { self.x + self.y }\n}' },
          { name: 'enum with data', code: 'enum Shape {\n    Circle(f64),\n    Rect(f64, f64),\n}' },
          { name: 'derive', code: '#[derive(Debug, Clone, PartialEq)]' },
        ],
      },
      {
        title: 'Errors',
        items: [
          { name: 'Option', code: 'let n = maybe.unwrap_or(0);' },
          { name: 'Result', code: 'let n: i32 = "42".parse()?;' },
          { name: 'match result', code: 'match res {\n    Ok(v) => println!("{}", v),\n    Err(e) => eprintln!("{}", e),\n}' },
          { name: 'main returns Result', code: 'fn main() -> Result<(), Box<dyn Error>>' },
        ],
      },
      {
        title: 'Collections',
        items: [
          { name: 'Vec', code: 'let mut v = vec![1, 2, 3];\nv.push(4);' },
          { name: 'HashMap entry', code: '*counts.entry(word).or_insert(0) += 1;' },
          { name: 'HashSet', code: 'seen.insert("a");\nseen.contains("a");' },
          { name: 'iterate', code: 'for (i, item) in v.iter().enumerate()' },
        ],
      },
      {
        title: 'Iterators',
        items: [
          { name: 'map', code: 'v.iter().map(|n| n * 2).collect::<Vec<_>>()' },
          { name: 'filter', code: 'v.iter().filter(|n| **n > 0)' },
          { name: 'sum', code: 'let total: i32 = v.iter().sum();' },
          { name: 'chain', code: 'v.iter().filter(|n| **n % 2 == 0).map(|n| n * n).sum::<i32>()' },
        ],
      },
      {
        title: 'Traits & generics',
        items: [
          { name: 'trait', code: 'trait Area { fn area(&self) -> f64; }' },
          { name: 'impl trait', code: 'impl Area for Rect {\n    fn area(&self) -> f64 { self.w * self.h }\n}' },
          { name: 'generic bound', code: 'fn print_all<T: std::fmt::Debug>(items: &[T])' },
          { name: 'default method', code: 'trait Greet {\n    fn name(&self) -> String;\n    fn greet(&self) -> String { format!("hi {}", self.name()) }\n}' },
        ],
      },
      {
        title: 'Concurrency',
        items: [
          { name: 'spawn', code: 'let handle = std::thread::spawn(|| 1 + 1);\nhandle.join().unwrap();' },
          { name: 'channel', code: 'let (tx, rx) = std::sync::mpsc::channel();' },
          { name: 'shared state', code: 'let shared = Arc::new(Mutex::new(Vec::new()));' },
          { name: 'async main', code: '#[tokio::main]\nasync fn main() { }' },
          { name: 'join futures', code: 'let (a, b) = tokio::join!(one(), two());' },
        ],
      },
      {
        title: 'Testing',
        items: [
          { name: 'test module', code: '#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn works() {\n        assert_eq!(add(2, 3), 5);\n    }\n}' },
          { name: 'assertions', code: 'assert!(x > 0);\nassert_eq!(a, b);' },
          { name: 'should panic', code: '#[test]\n#[should_panic]\nfn rejects_empty() { }' },
        ],
      },
    ];

    // -------------------------------------------------------------- rendering

    const KW = new Set([
      'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else',
      'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop',
      'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static',
      'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while',
    ]);
    const TYPES = new Set([
      'i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'u8', 'u16', 'u32', 'u64', 'u128',
      'usize', 'f32', 'f64', 'bool', 'char', 'str', 'String', 'Vec', 'Option', 'Result',
      'Box', 'Rc', 'Arc', 'RefCell', 'Mutex', 'HashMap', 'HashSet', 'BTreeMap', 'VecDeque',
    ]);

    const TOKEN_RE = /(\/\/[^\n]*)|("(?:\\.|[^"\\])*")|('(?:\\.|[^'\\])'?)|(\b\d[\d_]*(?:\.\d+)?(?:[iu](?:8|16|32|64|128|size)|f(?:32|64))?\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|([^\sA-Za-z0-9_]+)/g;

    function highlightRust(code) {
      const nodes = [];
      let match;
      let index = 0;
      TOKEN_RE.lastIndex = 0;
      while ((match = TOKEN_RE.exec(code)) !== null) {
        index += 1;
        if (match[1]) {
          nodes.push(h('span', { key: index, className: 'ra-tok-com' }, match[1]));
        } else if (match[2] || match[3]) {
          nodes.push(h('span', { key: index, className: 'ra-tok-str' }, match[2] || match[3]));
        } else if (match[4]) {
          nodes.push(h('span', { key: index, className: 'ra-tok-num' }, match[4]));
        } else if (match[5]) {
          const word = match[5];
          if (KW.has(word)) {
            nodes.push(h('span', { key: index, className: 'ra-tok-kw' }, word));
          } else if (TYPES.has(word) || /^[A-Z]/.test(word)) {
            nodes.push(h('span', { key: index, className: 'ra-tok-ty' }, word));
          } else {
            nodes.push(word);
          }
        } else {
          nodes.push(match[6] || match[7] || '');
        }
      }
      return nodes;
    }

    function copyText(text) {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(text);
      }
      return Promise.reject(new Error('clipboard unavailable'));
    }

    function tutorPrompt(lesson) {
      return [
        'You are my Rust tutor. I am working through Lesson ' + lesson.n + ': "' + lesson.title + '".',
        'Goal of the lesson: ' + lesson.goal,
        'The course project is the Cargo project at rust-course/ (examples in src/bin/, notes in lessons/).',
        'Teach it interactively: 1) explain the key idea in five short sentences,',
        '2) give me one tiny code snippet and ask me to predict its output,',
        '3) then give me two exercises and wait for my answers. Do not reveal full solutions until I have tried.',
      ].join('\n');
    }

    function CrabMark({ size = 24, filled = false }) {
      if (!filled) {
        return h('svg', {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          'aria-hidden': true, focusable: false, style: { display: 'block' },
        },
          h('ellipse', { cx: 12, cy: 14.5, rx: 6.4, ry: 4.4, stroke: 'currentColor', strokeWidth: 1.6 }),
          h('path', { d: 'M9.4 11.4 L9 9.2 M14.6 11.4 L15 9.2', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
          h('circle', { cx: 9, cy: 8.4, r: 1.7, stroke: 'currentColor', strokeWidth: 1.6 }),
          h('circle', { cx: 15, cy: 8.4, r: 1.7, stroke: 'currentColor', strokeWidth: 1.6 }),
          h('path', { d: 'M5.9 12.6 C4 11.6 3 9.6 4.2 8.2 c1.2-1.3 3.4-.6 3.4 1.1', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
          h('path', { d: 'M18.1 12.6 C20 11.6 21 9.6 19.8 8.2 c-1.2-1.3-3.4-.6-3.4 1.1', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
          h('path', { d: 'M7.6 18 L6 20.4 M10.6 19.2 L9.8 21.4 M16.4 18 L18 20.4 M13.4 19.2 L14.2 21.4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' })
        );
      }
      return h('svg', {
        width: size, height: size, viewBox: '0 0 64 64',
        'aria-hidden': true, focusable: false, style: { display: 'block' },
      },
        h('g', { fill: 'none', stroke: '#7a2a1b', strokeWidth: 3, strokeLinecap: 'round' },
          h('path', { d: 'M20 46 L12 54' }),
          h('path', { d: 'M27 49 L23 58' }),
          h('path', { d: 'M44 46 L52 54' }),
          h('path', { d: 'M37 49 L41 58' }),
          h('path', { d: 'M25 28 L24 24' }),
          h('path', { d: 'M39 28 L40 24' })
        ),
        h('g', { fill: '#ce422b', stroke: '#7a2a1b', strokeWidth: 3, strokeLinejoin: 'round' },
          h('path', { d: 'M15 30c-4-1-7-5-6-8 1-4 6-4 8-2 1 2 1 4 0 5 3 0 4 2 4 4z' }),
          h('path', { d: 'M49 30c4-1 7-5 6-8-1-4-6-4-8-2-1 2-1 4 0 5-3 0-4 2-4 4z' }),
          h('ellipse', { cx: 32, cy: 38, rx: 17, ry: 12 })
        ),
        h('circle', { cx: 24, cy: 21, r: 5.5, fill: '#ffffff', stroke: '#7a2a1b', strokeWidth: 3 }),
        h('circle', { cx: 40, cy: 21, r: 5.5, fill: '#ffffff', stroke: '#7a2a1b', strokeWidth: 3 }),
        h('circle', { cx: 24, cy: 22, r: 2.2, fill: '#2b1a16' }),
        h('circle', { cx: 40, cy: 22, r: 2.2, fill: '#2b1a16' }),
        h('path', { d: 'M28 38 q4 3 8 0', fill: 'none', stroke: '#7a2a1b', strokeWidth: 3, strokeLinecap: 'round' })
      );
    }

    function CodeBlock({ code, lang, caption, onCopy }) {
      return h('div', { className: 'ra-codeblock' },
        h('div', { className: 'ra-codeblock-bar' },
          h('span', { className: 'ra-codeblock-lang' }, caption || lang || 'rust'),
          h('button', {
            type: 'button',
            className: 'ra-ghost ra-copy',
            onClick: () => onCopy(code),
            title: t('action.copy'),
          }, t('action.copy'))
        ),
        h('pre', { className: 'ra-pre' },
          h('code', null, lang === 'rust' ? highlightRust(code) : code)
        )
      );
    }

    const CSS = `
.ra-root{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;}
.ra-header{display:flex;align-items:center;gap:12px;padding:16px 20px 12px;}
.ra-brand{display:flex;align-items:center;gap:11px;min-width:0;}
.ra-title{font-size:16px;font-weight:650;letter-spacing:-.01em;line-height:1.2;}
.ra-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.3;margin-top:2px;}
.ra-header-spacer{flex:1 1 auto;}
.ra-progress{display:flex;flex-direction:column;gap:5px;align-items:flex-end;min-width:132px;}
.ra-progress-label{font-size:11.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
.ra-progress-track{width:132px;height:5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;}
.ra-progress-fill{height:100%;background:var(--dsw-alias-brand-primary);border-radius:999px;transition:width .25s ease;}
.ra-tabs{display:flex;align-items:center;gap:6px;padding:0 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.ra-tab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;padding:6px 11px;border-radius:8px;cursor:pointer;}
.ra-tab:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}
.ra-tab.is-active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600;}
.ra-tab:focus-visible,.ra-lesson:focus-visible,.ra-ghost:focus-visible,.ra-primary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}
.ra-tabs-spacer{flex:1 1 auto;}
.ra-body{flex:1 1 auto;min-height:0;display:flex;}
.ra-nav{width:272px;flex:0 0 272px;overflow-y:auto;border-right:1px solid var(--dsw-alias-border-l1);padding:12px 10px 28px;}
.ra-stage{margin:0 0 16px;}
.ra-stage-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:6px 8px;font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);}
.ra-stage-count{font-variant-numeric:tabular-nums;letter-spacing:0;}
.ra-lesson{display:flex;align-items:center;gap:9px;width:100%;appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;padding:7px 8px;border-radius:8px;cursor:pointer;}
.ra-lesson:hover{background:var(--dsw-alias-bg-layer-1);}
.ra-lesson.is-active{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1);}
.ra-lesson-num{flex:0 0 21px;height:21px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:10.5px;font-variant-numeric:tabular-nums;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);}
.ra-lesson.is-done .ra-lesson-num{background:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-bg-base);}
.ra-lesson-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;}
.ra-lesson-min{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
.ra-article{flex:1 1 auto;min-width:0;overflow-y:auto;padding:26px 34px 72px;}
.ra-article-inner{max-width:760px;margin:0 auto;}
.ra-crumbs{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);margin-bottom:10px;}
.ra-lesson-head{display:flex;align-items:flex-start;gap:16px;}
.ra-lesson-head h1{margin:0;font-size:22px;line-height:1.25;font-weight:650;letter-spacing:-.015em;flex:1 1 auto;}
.ra-lesson-meta{display:flex;align-items:center;gap:10px;margin-top:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary);}
.ra-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10.5px;}
.ra-goal{margin:14px 0 22px;padding:12px 14px;border-left:3px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);border-radius:0 8px 8px 0;color:var(--dsw-alias-label-primary);}
.ra-goal b{color:var(--dsw-alias-label-secondary);font-weight:600;font-size:11px;letter-spacing:.07em;text-transform:uppercase;display:block;margin-bottom:3px;}
.ra-section{margin:0 0 20px;}
.ra-section h2{margin:22px 0 8px;font-size:15px;font-weight:650;letter-spacing:-.01em;}
.ra-section p{margin:0 0 9px;color:var(--dsw-alias-label-primary);}
.ra-section ul{margin:6px 0 12px;padding-left:18px;color:var(--dsw-alias-label-primary);}
.ra-section li{margin:3px 0;}
.ra-tip{display:flex;gap:8px;margin:10px 0 14px;padding:9px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);font-size:12.5px;color:var(--dsw-alias-label-secondary);}
.ra-tip-mark{color:var(--dsw-alias-state-warn-primary);font-weight:700;}
.ra-codeblock{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;overflow:hidden;margin:10px 0 14px;}
.ra-codeblock-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:5px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);}
.ra-codeblock-lang{font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);}
.ra-pre{margin:0;padding:12px 14px;overflow-x:auto;font:12px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-primary);tab-size:4;}
.ra-pre code{font:inherit;}
.ra-tok-kw{color:var(--dsw-alias-brand-primary);}
.ra-tok-str{color:var(--dsw-alias-state-success-primary);}
.ra-tok-num{color:var(--dsw-alias-state-warn-primary);}
.ra-tok-com{color:var(--dsw-alias-label-secondary);font-style:italic;}
.ra-tok-ty{color:var(--dsw-alias-label-primary);font-weight:600;}
.ra-ghost{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;padding:3px 9px;border-radius:7px;cursor:pointer;}
.ra-ghost:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}
.ra-primary{appearance:none;border:1px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font:inherit;font-size:12px;font-weight:600;padding:6px 12px;border-radius:8px;cursor:pointer;}
.ra-primary:hover{filter:brightness(1.06);}
.ra-complete{flex:0 0 auto;margin-top:2px;}
.ra-complete.is-done{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);}
.ra-exercise{margin:26px 0 0;padding:16px 18px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}
.ra-exercise-head{display:flex;align-items:center;gap:9px;margin-bottom:8px;}
.ra-badge{font-size:10px;letter-spacing:.09em;text-transform:uppercase;font-weight:700;color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:3px 9px;}
.ra-exercise-prompt{margin:0 0 10px;font-size:13px;}
.ra-exercise-actions{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 10px;}
.ra-hint{margin:0 0 10px;padding:9px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12.5px;}
.ra-lesson-foot{display:flex;align-items:center;gap:10px;margin-top:28px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1);}
.ra-lesson-foot .ra-spacer{flex:1 1 auto;}
.ra-cheat{flex:1 1 auto;min-height:0;overflow-y:auto;padding:24px 34px 72px;}
.ra-cheat-inner{max-width:980px;margin:0 auto;}
.ra-cheat-head h1{margin:0 0 4px;font-size:20px;font-weight:650;letter-spacing:-.015em;}
.ra-cheat-head p{margin:0 0 20px;color:var(--dsw-alias-label-secondary);font-size:12.5px;}
.ra-cheat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;align-items:start;}
.ra-cheat-group{border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;}
.ra-cheat-group h2{margin:0;padding:9px 13px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);}
.ra-cheat-item{padding:9px 13px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.ra-cheat-item:last-child{border-bottom:0;}
.ra-cheat-name{font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:4px;}
.ra-cheat-code{margin:0;overflow-x:auto;font:11.5px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-primary);white-space:pre;}
.ra-toast{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);z-index:80;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:7px 15px;font-size:12px;}
@media (max-width:820px){
  .ra-nav{width:224px;flex-basis:224px;}
  .ra-article{padding:20px 18px 56px;}
  .ra-cheat{padding:20px 18px 56px;}
  .ra-lesson-head{flex-direction:column;gap:8px;}
}
`;

    function TabButton({ active, children, onClick }) {
      return h('button', {
        type: 'button',
        className: 'ra-tab' + (active ? ' is-active' : ''),
        onClick,
        'aria-pressed': active,
      }, children);
    }

    function LessonNav({ selectedId, done, onSelect }) {
      return h('nav', { className: 'ra-nav', 'aria-label': t('panel.title') },
        STAGES.map((stage, stageIndex) => {
          const lessons = LESSONS.filter((lesson) => lesson.stage === stageIndex);
          const completed = lessons.filter((lesson) => done[lesson.id]).length;
          return h('div', { className: 'ra-stage', key: stage.title },
            h('div', { className: 'ra-stage-head' },
              h('span', null, t('stage.label', { n: stageIndex + 1 }) + ' · ' + stage.title),
              h('span', { className: 'ra-stage-count' }, completed + '/' + lessons.length)
            ),
            lessons.map((lesson) => h('button', {
              type: 'button',
              key: lesson.id,
              className: 'ra-lesson'
                + (lesson.id === selectedId ? ' is-active' : '')
                + (done[lesson.id] ? ' is-done' : ''),
              onClick: () => onSelect(lesson.id),
              'aria-current': lesson.id === selectedId ? 'page' : undefined,
            },
              h('span', { className: 'ra-lesson-num' }, done[lesson.id] ? '✓' : String(lesson.n)),
              h('span', { className: 'ra-lesson-title' }, lesson.title),
              h('span', { className: 'ra-lesson-min' }, t('lesson.minutes', { n: lesson.minutes }))
            ))
          );
        })
      );
    }

    function Article({ lesson, done, onToggleDone, onCopy, onPrev, onNext, prev, next }) {
      const [hintOpen, setHintOpen] = useState(false);
      const [solutionOpen, setSolutionOpen] = useState(false);

      useEffect(() => {
        setHintOpen(false);
        setSolutionOpen(false);
      }, [lesson.id]);

      const exercise = lesson.exercise;
      const stage = STAGES[lesson.stage];

      return h('article', { className: 'ra-article' },
        h('div', { className: 'ra-article-inner' },
          h('div', { className: 'ra-crumbs' }, stage.title + ' · ' + t('lesson.of', { n: lesson.n, total: TOTAL })),
          h('div', { className: 'ra-lesson-head' },
            h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
              h('h1', null, lesson.title),
              h('div', { className: 'ra-lesson-meta' },
                h('span', { className: 'ra-chip' }, t('lesson.minutes', { n: lesson.minutes })),
                h('span', { className: 'ra-chip' }, stage.title)
              )
            ),
            h('button', {
              type: 'button',
              className: 'ra-ghost ra-complete' + (done ? ' is-done' : ''),
              onClick: onToggleDone,
              'aria-pressed': !!done,
            }, done ? '✓ ' + t('action.completed') : t('action.markComplete'))
          ),
          h('div', { className: 'ra-goal' },
            h('b', null, t('lesson.goal')),
            lesson.goal
          ),
          lesson.sections.map((section, index) => h('section', { className: 'ra-section', key: index },
            h('h2', null, section.h),
            section.p.map((paragraph, pIndex) => h('p', { key: pIndex }, paragraph)),
            section.list ? h('ul', null, section.list.map((item, lIndex) => h('li', { key: lIndex }, item))) : null,
            section.code ? h(CodeBlock, { code: section.code, lang: 'rust', onCopy }) : null,
            section.tip ? h('div', { className: 'ra-tip' },
              h('span', { className: 'ra-tip-mark' }, '!'),
              h('span', null, section.tip)
            ) : null
          )),
          h('section', { className: 'ra-exercise' },
            h('div', { className: 'ra-exercise-head' },
              h('span', { className: 'ra-badge' }, t('exercise.title'))
            ),
            h('p', { className: 'ra-exercise-prompt' }, exercise.prompt),
            h(CodeBlock, { code: exercise.starter, lang: 'rust', caption: t('exercise.starter'), onCopy }),
            h('div', { className: 'ra-exercise-actions' },
              h('button', {
                type: 'button',
                className: 'ra-ghost',
                onClick: () => setHintOpen((value) => !value),
                'aria-expanded': hintOpen,
              }, hintOpen ? t('action.hideHint') : t('action.showHint')),
              h('button', {
                type: 'button',
                className: 'ra-ghost',
                onClick: () => setSolutionOpen((value) => !value),
                'aria-expanded': solutionOpen,
              }, solutionOpen ? t('action.hideSolution') : t('action.showSolution')),
              h('button', {
                type: 'button',
                className: 'ra-ghost',
                onClick: () => onCopy(tutorPrompt(lesson)),
              }, t('action.copyPrompt'))
            ),
            hintOpen ? h('p', { className: 'ra-hint' }, exercise.hint) : null,
            solutionOpen ? h(CodeBlock, { code: exercise.solution, lang: 'rust', caption: t('exercise.solution'), onCopy }) : null
          ),
          h('div', { className: 'ra-lesson-foot' },
            prev ? h('button', { type: 'button', className: 'ra-ghost', onClick: () => onPrev(prev.id) }, '← ' + t('lesson.prev')) : null,
            h('span', { className: 'ra-spacer' }),
            next ? h('button', { type: 'button', className: 'ra-primary', onClick: () => onNext(next.id) }, t('lesson.next') + ' →') : null
          )
        )
      );
    }

    function Cheatsheet({ onCopy }) {
      return h('div', { className: 'ra-cheat' },
        h('div', { className: 'ra-cheat-inner' },
          h('div', { className: 'ra-cheat-head' },
            h('h1', null, t('tab.cheatsheet')),
            h('p', null, t('cheatsheet.subtitle'))
          ),
          h('div', { className: 'ra-cheat-grid' },
            CHEATSHEET.map((group) => h('section', { className: 'ra-cheat-group', key: group.title },
              h('h2', null, group.title),
              group.items.map((item) => h('div', { className: 'ra-cheat-item', key: item.name },
                h('div', { className: 'ra-cheat-name' }, item.name),
                h('pre', { className: 'ra-cheat-code' }, highlightRust(item.code))
              ))
            ))
          )
        )
      );
    }

    function Panel() {
      useRevision();

      const [tab, setTab] = useState('course');
      const [selectedId, setSelectedId] = useState(() => {
        const last = readJson(LAST_KEY, null);
        return last && last.id && LESSON_BY_ID[last.id] ? last.id : LESSONS[0].id;
      });
      const [done, setDone] = useState(() => readJson(PROGRESS_KEY, {}));
      const [toast, setToast] = useState('');
      const [confirmReset, setConfirmReset] = useState(false);

      useEffect(() => {
        if (!toast) return undefined;
        const id = setTimeout(() => setToast(''), 2000);
        return () => clearTimeout(id);
      }, [toast]);

      const lesson = LESSON_BY_ID[selectedId] || LESSONS[0];
      const doneCount = LESSONS.filter((item) => done[item.id]).length;
      const percent = TOTAL === 0 ? 0 : Math.round((doneCount / TOTAL) * 100);
      const previous = lesson.n > 1 ? LESSONS[lesson.n - 2] : null;
      const following = lesson.n < TOTAL ? LESSONS[lesson.n] : null;

      function flash(message) {
        setToast(message);
      }

      function copy(text) {
        copyText(text).then(
          () => flash(t('toast.copied')),
          () => flash(t('toast.copyFailed'))
        );
      }

      function selectLesson(id) {
        setSelectedId(id);
        writeJson(LAST_KEY, { id });
      }

      function toggleDone() {
        setDone((current) => {
          const next = Object.assign({}, current);
          if (next[lesson.id]) delete next[lesson.id];
          else next[lesson.id] = true;
          writeJson(PROGRESS_KEY, next);
          return next;
        });
      }

      function resetProgress() {
        if (!confirmReset) {
          setConfirmReset(true);
          return;
        }
        setDone({});
        writeJson(PROGRESS_KEY, {});
        setConfirmReset(false);
        flash(t('toast.reset'));
      }

      function askInChat() {
        copy(tutorPrompt(lesson));
        if (layoutService && typeof layoutService.selectPanel === 'function') {
          layoutService.selectPanel('conversation');
        }
      }

      return h('div', { className: 'ra-root' },
        h('style', null, CSS),
        h('header', { className: 'ra-header' },
          h('div', { className: 'ra-brand' },
            h(CrabMark, { size: 30, filled: true }),
            h('div', null,
              h('div', { className: 'ra-title' }, t('panel.title')),
              h('div', { className: 'ra-sub' }, t('panel.tagline'))
            )
          ),
          h('div', { className: 'ra-header-spacer' }),
          h('div', { className: 'ra-progress' },
            h('div', { className: 'ra-progress-label' }, t('progress.label', { done: doneCount, total: TOTAL })),
            h('div', { className: 'ra-progress-track', role: 'progressbar', 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 },
              h('div', { className: 'ra-progress-fill', style: { width: percent + '%' } })
            )
          )
        ),
        h('div', { className: 'ra-tabs' },
          h(TabButton, { active: tab === 'course', onClick: () => setTab('course') }, t('tab.course')),
          h(TabButton, { active: tab === 'cheatsheet', onClick: () => setTab('cheatsheet') }, t('tab.cheatsheet')),
          h('div', { className: 'ra-tabs-spacer' }),
          tab === 'course' && doneCount > 0
            ? h('button', { type: 'button', className: 'ra-ghost', onClick: resetProgress },
                confirmReset ? t('action.confirmReset') : t('action.reset'))
            : null,
          h('button', { type: 'button', className: 'ra-primary', onClick: askInChat }, t('action.askInChat'))
        ),
        tab === 'course'
          ? h('div', { className: 'ra-body' },
              h(LessonNav, { selectedId, done, onSelect: selectLesson }),
              h(Article, {
                lesson,
                done: !!done[lesson.id],
                onToggleDone: toggleDone,
                onCopy: copy,
                onPrev: selectLesson,
                onNext: selectLesson,
                prev: previous,
                next: following,
              })
            )
          : h(Cheatsheet, { onCopy: copy }),
        toast ? h('div', { className: 'ra-toast', role: 'status' }, toast) : null
      );
    }

    function SidebarIcon({ size = 20, active = false }) {
      return h('span', {
        className: 'ra-sidebar-icon',
        style: { display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: active ? 1 : 0.9 },
      }, h(CrabMark, { size }));
    }

    // ----------------------------------------------------------------- plugin

    return {
      inject: ['slots'],
      apply(ctx) {
        localeService = ctx.get('locale') || null;
        layoutService = ctx.get('layout') || null;

        if (localeService) {
          ctx.effect(() => localeService.register(NS, 'en', DICT));
          try {
            boundTranslate = localeService.bind(NS);
          } catch (error) {
            boundTranslate = null;
          }
        }

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'rust-academy',
          order: 20,
          label: () => t('panel.title'),
        }, SidebarIcon));

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'rust-academy',
        }, Panel));
      },
    };
  },
});
