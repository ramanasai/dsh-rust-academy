// Add canonical references to the fundamentals track (idempotent).
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const file = path.resolve(here, '..', 'src', 'data', 'foundations.mjs');
const mod = await import(new URL('file://' + file).href + '?v=' + Date.now());
const track = mod.default;

const BOOK = 'https://doc.rust-lang.org/book/';
const RESOURCES = {
  l01: [
    { title: 'The Rust Book — Getting started', url: BOOK + 'ch01-00-getting-started.html' },
    { title: 'The Cargo Book — Getting started', url: 'https://doc.rust-lang.org/cargo/getting-started/index.html' },
  ],
  l02: [
    { title: 'The Rust Book — Data types', url: BOOK + 'ch03-02-data-types.html' },
    { title: 'Rust by Example — Primitives', url: 'https://doc.rust-lang.org/rust-by-example/primitives.html' },
  ],
  l03: [
    { title: 'The Rust Book — Control flow', url: BOOK + 'ch03-05-control-flow.html' },
    { title: 'std — std::process::exit', url: 'https://doc.rust-lang.org/std/process/fn.exit.html' },
  ],
  l04: [
    { title: 'The Rust Book — Functions', url: BOOK + 'ch03-03-how-functions-work.html' },
    { title: 'The Rust Book — Generic functions', url: BOOK + 'ch10-01-syntax.html' },
  ],
  l05: [
    { title: 'The Rust Book — Storing UTF-8 text', url: BOOK + 'ch08-02-strings.html' },
    { title: 'std — String', url: 'https://doc.rust-lang.org/std/string/struct.String.html' },
  ],
  l06: [
    { title: 'The Rust Book — What is ownership?', url: BOOK + 'ch04-01-what-is-ownership.html' },
    { title: 'The Rustonomicon — Ownership', url: 'https://doc.rust-lang.org/nomicon/ownership.html' },
  ],
  l07: [
    { title: 'The Rust Book — References and borrowing', url: BOOK + 'ch04-02-references-and-borrowing.html' },
    { title: 'The Rustonomicon — Aliasing', url: 'https://doc.rust-lang.org/nomicon/aliasing.html' },
  ],
  l08: [
    { title: 'The Rust Book — The Slice type', url: BOOK + 'ch04-03-slices.html' },
    { title: 'std — Primitive slice', url: 'https://doc.rust-lang.org/std/primitive.slice.html' },
  ],
  l09: [
    { title: 'The Rust Book — Using structs', url: BOOK + 'ch05-00-structs.html' },
    { title: 'The Rust Book — Method syntax', url: BOOK + 'ch05-03-method-syntax.html' },
  ],
  l10: [
    { title: 'The Rust Book — Enums and pattern matching', url: BOOK + 'ch06-00-enums.html' },
    { title: 'std — Option', url: 'https://doc.rust-lang.org/std/option/index.html' },
  ],
  l11: [
    { title: 'The Rust Book — Error handling', url: BOOK + 'ch09-00-error-handling.html' },
    { title: 'std — Result', url: 'https://doc.rust-lang.org/std/result/index.html' },
  ],
  l12: [
    { title: 'The Rust Book — Generic types, traits and lifetimes', url: BOOK + 'ch10-00-generics.html' },
    { title: 'The Rust Book — Traits', url: BOOK + 'ch10-02-traits.html' },
  ],
  l13: [
    { title: 'The Rust Book — Functional features: iterators and closures', url: BOOK + 'ch13-00-functional-features.html' },
    { title: 'std — Iterator', url: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html' },
  ],
  l14: [
    { title: 'The Rust Book — Packages, crates and modules', url: BOOK + 'ch07-00-managing-growing-projects-with-packages-crates-and-modules.html' },
    { title: 'The Cargo Book', url: 'https://doc.rust-lang.org/cargo/' },
  ],
  l15: [
    { title: 'The Rust Book — Common collections', url: BOOK + 'ch08-00-common-collections.html' },
    { title: 'std — Collections', url: 'https://doc.rust-lang.org/std/collections/index.html' },
  ],
  l16: [
    { title: 'The Rust Book — An I/O project', url: BOOK + 'ch12-00-an-io-project.html' },
    { title: 'std — fs::read_to_string', url: 'https://doc.rust-lang.org/std/fs/fn.read_to_string.html' },
  ],
  l17: [
    { title: 'The Rust Book — Fearless concurrency', url: BOOK + 'ch16-00-concurrency.html' },
    { title: 'std — Threads', url: 'https://doc.rust-lang.org/std/thread/index.html' },
  ],
  l18: [
    { title: 'Tokio tutorial', url: 'https://tokio.rs/tokio/tutorial' },
    { title: 'Asynchronous Programming in Rust', url: 'https://rust-lang.github.io/async-book/' },
  ],
  l19: [
    { title: 'The Rust Book — Validating references with lifetimes', url: BOOK + 'ch10-03-lifetime-syntax.html' },
    { title: 'The Rust Book — Smart pointers', url: BOOK + 'ch15-00-smart-pointers.html' },
  ],
  l20: [
    { title: 'The Rust Book — Writing automated tests', url: BOOK + 'ch11-00-testing.html' },
    { title: 'Clippy documentation', url: 'https://doc.rust-lang.org/clippy/' },
  ],
};

let updated = 0;
for (const lesson of track.lessons) {
  const resources = RESOURCES[lesson.id];
  if (!resources) continue;
  lesson.resources = resources;
  updated += 1;
}
track.level = 'core';

fs.writeFileSync(file, '/**\n * Rust fundamentals track.\n *\n * Authored for the Rust Academy plugin. Every lesson is plain JSON-compatible\n * data consumed by src/app.js through build.mjs.\n */\nexport default ' + JSON.stringify(track, null, 2) + ';\n');
console.log('enriched ' + updated + ' foundations lessons with canonical references');
