/**
 * WASM & frontend track.
 *
 * API versions used across the lessons, checked against docs.rs on 2026-11-04:
 * wasm-bindgen 0.2.130 (web-sys 0.3.107, js-sys 0.3.107, wasm-bindgen-futures
 * 0.4.80, wasm-bindgen-test 0.3.80), leptos 0.8.23, leptos_axum 0.8.10,
 * yew 0.23.0, dioxus 0.7.10, wasmtime 50.0.1 with wasmtime-wasi p2, and the
 * workers-rs `worker` crate.
 *
 * Data is JSON-compatible and consumed by the plugin build.
 */
export default {
  "key": "frontend-wasm",
  "prefix": "v",
  "title": "WASM & frontend",
  "blurb": "Rust in the browser and at the edge: wasm-bindgen, Leptos, Yew, Dioxus, web APIs and performance.",
  "level": "industry",
  "project": {
    "title": "Capstone: a WASM dashboard",
    "brief": "Build a reactive operations dashboard in Rust, compiled to WebAssembly. The first paint must come from the server with real data, the client must hydrate the same markup without a mismatch, live metrics must stream in over SSE without blocking the main thread, and the whole thing has to be usable with a keyboard and a screen reader. Ship it under a bundle-size budget enforced in CI.",
    "deliverables": [
      "A Leptos app with a server-rendered shell, server functions, and client hydration from the same component tree.",
      "A streaming metrics channel (SSE or WebSocket) that updates charts without re-rendering the whole page.",
      "An accessibility audit: axe-core clean, keyboard-only pass, announced live-region updates, visible focus.",
      "A bundle-size budget in CI that fails the build above a fixed compressed byte count.",
      "A measurement note: p95 update latency, main-thread long tasks, and wasm transfer size before and after optimization."
    ],
    "stack": [
      "leptos",
      "leptos_axum",
      "wasm-bindgen",
      "web-sys",
      "gloo",
      "serde",
      "tokio"
    ]
  },
  "lessons": [
    {
      "id": "v01",
      "n": 1,
      "title": "WebAssembly: a typed stack machine in a sandbox",
      "minutes": 55,
      "level": "core",
      "goal": "Read what a .wasm module actually contains — typed functions, linear memory, imports and exports — so every later tooling choice stops feeling like magic.",
      "sections": [
        {
          "h": "A module is types, code, and one linear memory",
          "p": [
            "A WebAssembly module is a portable object file, not source code and not machine code for your CPU. Validation happens before execution: a type checker walks every function body and proves stack heights, branch targets and operand types line up. Because validation is total, an engine never has to guess at run time, and it can compile in tiers — baseline quickly, optimizing later — without changing what the program means.",
            "Each module declares types, functions, globals, tables, and memories. Memory is a flat, growable byte array indexed by i32: no pointers, no allocator, no syscalls. Rust's allocator lives inside your module and grows that same array, which is why a Rust wasm binary ships a malloc implementation and why 'out of memory' in the browser usually means linear memory could not grow."
          ],
          "list": [
            "Functions take and return i32, i64, f32, f64 and — with newer proposals — typed references",
            "Imports are the module's declared dependencies; exports are its public API",
            "Linear memory is measured in 64 KiB pages and only ever grows",
            "There is no ambient authority: no files, sockets, clocks or DOM unless the host imports them"
          ],
          "tip": "If you cannot say which values a function pops and pushes, you cannot reason about the code the Rust compiler emits for it."
        },
        {
          "h": "Read a module before you build one",
          "p": [
            "Every instruction consumes and produces typed values on an implicit stack: i32.mul pops two i32 and pushes one. block and loop give branch targets, and br_if pops a condition before branching. Once this is legible, generated Rust stops being opaque: locals become stack slots, struct fields become offsets from a base pointer, and a slice index becomes a compare plus a trap."
          ],
          "code": `(module
  (memory (export "memory") 1)            ;; one 64 KiB page
  (global $next (mut i32) (i32.const 0))

  (func $alloc (param $len i32) (result i32)
    (local $ptr i32)
    (global.get $next)
    (local.tee $ptr)
    (local.get $len)
    (i32.add)
    (global.set $next)
    (local.get $ptr))

  (func (export "sum_squares") (param $n i32) (result i32)
    (local $i i32)
    (local $acc i32)
    (block $done
      (loop $next
        (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $acc
          (i32.add (local.get $acc)
                   (i32.mul (local.get $i) (local.get $i))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next)))
    (local.get $acc)))`,
          "tip": "wasm-tools print (or wasm2wat) shows exactly what you shipped; run it on a release build, where inlining has already happened."
        },
        {
          "h": "The sandbox is the product",
          "p": [
            "The security model is why wasm runs on servers and at the edge. Guest code cannot name a host address; it can only touch its own memory and call imported functions the embedder chose to provide. A bug in the guest produces a trap, not a shell: out-of-bounds access is checked, the guest stack is separate, and the host decides how much CPU and memory an instance may consume.",
            "That is also the honest limitation. The sandbox protects the host from the guest, not the guest from itself, and it is not free: bounds checks and register pressure cost real cycles. The systematic USENIX ATC 2019 study measured WebAssembly running roughly 1.5x slower than native on average, with bounds checking as a leading cause."
          ],
          "code": `// index.js — the host half of the contract
const response = await fetch("/pkg/dashboard_bg.wasm");
const { instance } = await WebAssembly.instantiateStreaming(response, {});

// Exports are plain JS functions; arguments widen to JS numbers.
console.log(instance.exports.sum_squares(10)); // 285

// Imports are where the host hands over authority, one function at a time.
const { instance: clocked } = await WebAssembly.instantiateStreaming(
  fetch("/pkg/clocked_bg.wasm"),
  { env: { now: () => performance.now() } },
);

// Memory is an ArrayBuffer that can detach when it grows — re-read it.
const bytes = new Uint8Array(clocked.exports.memory.buffer, 0, 16);`,
          "tip": "instantiateStreaming requires Content-Type: application/wasm; a server that guesses application/octet-stream silently falls back to a slower path or rejects."
        }
      ],
      "exercise": {
        "prompt": "Write a WAT module that exports a memory and an iterative fib(n: i32) -> i32, then instantiate it from JavaScript and print fib(30). Keep every loop branch explicit so the control flow is visible.",
        "starter": `(module
  ;; 1. export a memory
  ;; 2. fib with locals a, b, i — no recursion
)

// index.js
// 3. instantiate and call fib(30)`,
        "hint": "Keep a = 0, b = 1 and loop n times: t = a; a = b; b = t + b. Export the function with (export \"fib\") and branch back to the loop label.",
        "solution": `(module
  (memory (export "memory") 1)

  (func (export "fib") (param $n i32) (result i32)
    (local $a i32) (local $b i32) (local $t i32) (local $i i32)
    (local.set $b (i32.const 1))
    (block $done
      (loop $loop
        (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $t (local.get $a))
        (local.set $a (local.get $b))
        (local.set $b (i32.add (local.get $t) (local.get $b)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (local.get $a)))

// index.js
const { instance } = await WebAssembly.instantiateStreaming(
  fetch("/fib.wasm"),
  {},
);
console.log(instance.exports.fib(30)); // 832040`
      },
      "production": [
        "Serve .wasm as application/wasm and cache it immutably with a content hash in the filename.",
        "Keep the export surface small and typed; every export is a compatibility promise you now maintain.",
        "Set an explicit maximum memory and CPU budget on the host instead of trusting the guest to be polite.",
        "Pin the wasm-bindgen CLI to the exact crate version in Cargo.lock; a mismatch fails at instantiation."
      ],
      "crates": [
        "wasm-bindgen",
        "web-sys",
        "js-sys"
      ],
      "pitfall": "Serving the module without Content-Type: application/wasm. instantiateStreaming rejects with a MIME-type error, and the fallback path fetches the whole binary before compiling instead of compiling while it downloads.",
      "questions": [
        {
          "q": "Which property is enforced by WebAssembly validation before any instruction runs?",
          "options": [
            "Every memory access is proven in bounds at compile time",
            "Operand types and stack heights match each function signature",
            "Imported functions are guaranteed to be side-effect free",
            "The module cannot allocate more than one 64 KiB page"
          ],
          "answer": 1,
          "explain": "Validation proves the stack machine type-checks: operand types, stack heights, branch targets. Bounds checks are code inserted into the module and executed at run time; imports can do whatever the host allows."
        },
        {
          "q": "You compile a Rust crate to wasm32-unknown-unknown. Where does Vec's memory come from when it grows?",
          "options": [
            "The JavaScript heap, through an ArrayBuffer the engine supplies",
            "A malloc implementation compiled into the module that grows linear memory",
            "An implicit WASI import the browser provides",
            "wasm-bindgen preallocates a fixed 16 MiB arena at startup"
          ],
          "answer": 1,
          "explain": "There is no OS allocator on wasm32-unknown-unknown. Rust ships an allocator inside the module; it hands out offsets into linear memory and calls memory.grow when the heap is exhausted."
        },
        {
          "q": "instantiateStreaming rejects with 'Incorrect response MIME type'. What actually fixes it?",
          "options": [
            "Serve the file with Content-Type: application/wasm",
            "Rename the file so it ends in .wasm32",
            "Pass a Response object instead of the fetch promise",
            "Recompile with --target web instead of --target bundler"
          ],
          "answer": 0,
          "explain": "Streaming instantiation needs the wasm MIME type so the engine can compile while bytes arrive. Changing the target or the filename does not affect the header the server sends."
        }
      ],
      "quickbytes": [
        "wasm-tools print module.wasm shows the real instruction stream — check a release build, not a debug one.",
        "Memory grows in 64 KiB pages, so even a hello-world pays for at least one page.",
        "Treat the .wasm URL as an API: content type, cache headers and filename hash are part of the contract."
      ],
      "github": [
        { "name": "wasm-bindgen — Rust/JS glue for WebAssembly", "url": "https://github.com/wasm-bindgen/wasm-bindgen" },
        { "name": "WebAssembly/spec — reference interpreter and test suite", "url": "https://github.com/WebAssembly/spec" }
      ],
      "resources": [
        {
          "title": "WebAssembly specifications: core spec, JS API, WASI",
          "url": "https://webassembly.org/specs/",
          "kind": "docs"
        },
        {
          "title": "MDN: WebAssembly concepts",
          "url": "https://developer.mozilla.org/en-US/docs/WebAssembly/Concepts",
          "kind": "docs"
        },
        {
          "title": "Bringing the Web up to Speed with WebAssembly (PLDI 2017)",
          "url": "https://dl.acm.org/doi/10.1145/3062341.3062363",
          "kind": "paper"
        },
        {
          "title": "WebAssembly/spec repository",
          "url": "https://github.com/WebAssembly/spec",
          "kind": "repo"
        },
        {
          "title": "Nick Fitzgerald — WebAssembly and Rust talks",
          "url": "https://www.youtube.com/@fitzgen",
          "kind": "video"
        }
      ]
    },
    {
      "id": "v02",
      "n": 2,
      "title": "wasm-bindgen: the glue layer you ship but never read",
      "minutes": 75,
      "level": "core",
      "goal": "Explain what #[wasm_bindgen] generates on both sides of the boundary, and design an exported Rust API that JavaScript can call without leaking handles.",
      "sections": [
        {
          "h": "Two artifacts, one contract",
          "p": [
            "A Rust cdylib compiled to wasm32-unknown-unknown exports raw functions that take and return i32, i64, f32 and f64. Nothing in that binary knows what a string or an object is. wasm-bindgen reads the exported signatures and emits a JavaScript module that allocates strings, runs the marshalling, and keeps a table of Rust-side objects that JavaScript holds as opaque handles.",
            "That is why you ship two files: dashboard_bg.wasm and dashboard.js. The JS half is generated, versioned with the crate, and must match the wasm half exactly. Upgrading the crate without regenerating the JS produces errors such as 'failed to find function __wbindgen_describe' — the two halves disagree about the ABI."
          ],
          "list": [
            "The .wasm is machine code; the .js is the ABI adapter that calls it",
            "The wasm-bindgen CLI version must equal the wasm-bindgen crate version",
            "Each JS-visible struct gets a heap slot and an explicit free() method",
            "--target web, bundler and nodejs emit different adapters from the same wasm"
          ],
          "tip": "Treat pkg/ as a build artifact: regenerate it in CI, never edit it by hand, and never commit it alongside a source change that did not rebuild it."
        },
        {
          "h": "Designing the exported surface",
          "p": [
            "Export few, coarse functions and owned data. Every call pays a JS-to-wasm transition, and every string pays a copy into linear memory; chatty APIs multiply both. When the shape is complex, serialize a DTO with serde-wasm-bindgen rather than exposing five getters that each cross the boundary.",
            "Keep lifetimes out of the API. JavaScript cannot borrow Rust data, so anything borrowed has to be copied; returning a reference is not a thing the boundary can express. Returning Result<T, JsError> is the exception that maps cleanly: it becomes a thrown JS Error on the other side."
          ],
          "code": `use wasm_bindgen::prelude::*;
use serde::Serialize;

#[derive(Serialize)]
struct Snapshot {
    samples: usize,
    p95_ms: f64,
}

#[wasm_bindgen]
pub struct Dashboard {
    samples: Vec<f64>,
}

#[wasm_bindgen]
impl Dashboard {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Dashboard {
        Dashboard { samples: Vec::new() }
    }

    pub fn push(&mut self, value: f64) {
        self.samples.push(value);
    }

    // Result<T, JsError> becomes a thrown JS Error.
    pub fn snapshot(&self) -> Result<JsValue, JsError> {
        let mut sorted = self.samples.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let idx = ((sorted.len().saturating_sub(1)) as f64 * 0.95).round() as usize;
        let p95_ms = sorted.get(idx).copied().unwrap_or(0.0);
        serde_wasm_bindgen::to_value(&Snapshot {
            samples: self.samples.len(),
            p95_ms,
        })
        .map_err(|e| JsError::new(&e.to_string()))
    }
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}`,
          "tip": "#[wasm_bindgen(start)] runs at instantiation: the right place for the panic hook, the wrong place for work that needs a DOM node which may not exist yet."
        },
        {
          "h": "The handle tax",
          "p": [
            "An exported struct is a pointer into wasm memory that JavaScript holds as an opaque object. JavaScript has no destructor, so the Rust value lives until you call free() — or until a FinalizationRegistry gets around to it, which is not a schedule you can test against. In a framework you rarely construct these by hand; in a hand-written binding, every new Dashboard() is a leak until it is freed."
          ],
          "code": `const dashboard = new Dashboard();
dashboard.push(12.5);
dashboard.push(31.0);

console.log(dashboard.snapshot()); // { samples: 2, p95_ms: 31 }
dashboard.free();                  // JS has no Drop; this is mandatory

// If the handle must survive an async boundary, own it explicitly:
class DashboardOwner {
  #handle = new Dashboard();
  get handle() { return this.#handle; }
  dispose() { this.#handle.free(); }
}`,
          "list": [
            "Prefer plain data across the boundary over long-lived handles",
            "Give every handle an owner with an explicit dispose()",
            "Count live handles in a test: create 1000, free them, assert memory returns to baseline",
            "Never free a handle a closure may still call into"
          ]
        }
      ],
      "exercise": {
        "prompt": "Expose a Histogram to JavaScript with a constructor, record(&mut self, f64), a count getter, and to_json() -> Result<JsValue, JsError>. Then call it from JS, read the count, and free the handle.",
        "starter": `use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Histogram {
    // 1. keep a Vec<f64>
}

#[wasm_bindgen]
impl Histogram {
    // 2. constructor
    // 3. record(&mut self, value: f64)
    // 4. #[wasm_bindgen(getter)] pub fn count(&self) -> usize
    // 5. to_json -> Result<JsValue, JsError>
}`,
        "hint": "Mark the constructor with #[wasm_bindgen(constructor)], mark count with #[wasm_bindgen(getter)] so JS reads it as a property, and use serde_wasm_bindgen::to_value with a #[derive(Serialize)] struct.",
        "solution": `use wasm_bindgen::prelude::*;
use serde::Serialize;

#[derive(Serialize)]
struct HistogramJson {
    count: usize,
    values: Vec<f64>,
}

#[wasm_bindgen]
pub struct Histogram {
    values: Vec<f64>,
}

#[wasm_bindgen]
impl Histogram {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Histogram {
        Histogram { values: Vec::new() }
    }

    pub fn record(&mut self, value: f64) {
        self.values.push(value);
    }

    #[wasm_bindgen(getter)]
    pub fn count(&self) -> usize {
        self.values.len()
    }

    pub fn to_json(&self) -> Result<JsValue, JsError> {
        serde_wasm_bindgen::to_value(&HistogramJson {
            count: self.values.len(),
            values: self.values.clone(),
        })
        .map_err(|e| JsError::new(&e.to_string()))
    }
}

// dashboard.js
// const h = new Histogram();
// h.record(12.5);
// h.record(31.0);
// console.log(h.count);       // 2
// console.log(h.to_json());   // { count: 2, values: [...] }
// h.free();`
      },
      "production": [
        "CI regenerates the binding from a clean Cargo.lock and fails if the committed pkg/ differs.",
        "Every exported struct with a lifetime longer than one call has an owner and a dispose path.",
        "The public API returns owned DTOs; no exported function returns a borrowed reference.",
        "The panic hook is installed once at start, so a Rust panic surfaces as a JS error with a stack.",
        "Boundary calls per interaction are counted in review — dozens of tiny getters are a red flag."
      ],
      "crates": [
        "wasm-bindgen",
        "serde-wasm-bindgen",
        "console_error_panic_hook",
        "serde"
      ],
      "pitfall": "A #[wasm_bindgen] struct created once per render and never freed: linear memory climbs until the tab is closed, and Rust's own tooling cannot see it because the values remain reachable from the JS handle table.",
      "questions": [
        {
          "q": "Why must the wasm-bindgen CLI and the wasm-bindgen crate stay on the same version?",
          "options": [
            "The CLI compiles the Rust code and a newer crate would not type-check",
            "The generated JS encodes the exact ABI the wasm exports, so a mismatch breaks marshalling",
            "Cargo refuses to build when a binary dependency has a different minor version",
            "The CLI downloads the wasm32 target, which is versioned together with the crate"
          ],
          "answer": 1,
          "explain": "The JS shim and the wasm agree on exported symbol names, heap layout and marshalling helpers. Regenerating one without the other produces missing-symbol errors at instantiation, not compile time."
        },
        {
          "q": "What does returning Result<T, JsError> from an exported function do in JavaScript?",
          "options": [
            "It returns an object shaped like { ok, err }",
            "It returns undefined and logs the error to the console",
            "It throws a JS Error carrying the message, so callers can try/catch",
            "It traps the wasm instance and requires re-instantiation"
          ],
          "answer": 2,
          "explain": "JsError is the designated error type at the boundary: wasm-bindgen registers it as a thrown JS exception. That is why it should be used for expected failures rather than panicking."
        },
        {
          "q": "You call new Dashboard() in a render function on every keystroke. What is the failure mode?",
          "options": [
            "Rust values accumulate in linear memory until each handle is freed",
            "wasm-bindgen deduplicates identical handles automatically",
            "The JS engine garbage-collects the Rust side immediately",
            "Nothing — Rust's Drop runs when the JS object is collected"
          ],
          "answer": 0,
          "explain": "JavaScript has no destructor that calls into wasm. The generated free() must be invoked, or the Rust allocation stays alive even after the JS wrapper is collected; that is the handle tax."
        }
      ],
      "quickbytes": [
        "Regenerate pkg/ whenever the crate or the CLI changes; never patch the generated JS by hand.",
        "Return owned DTOs through serde-wasm-bindgen instead of exposing many small getters.",
        "Call free() on every exported struct you construct; a test that creates 1000 handles will show the leak.",
        "Keep #[wasm_bindgen(start)] for setup only — it runs before your app has mounted anything."
      ],
      "github": [
        { "name": "wasm-bindgen/wasm-bindgen", "url": "https://github.com/wasm-bindgen/wasm-bindgen" },
        { "name": "wasm-bindgen/wasm-pack", "url": "https://github.com/wasm-bindgen/wasm-pack" }
      ],
      "resources": [
        {
          "title": "wasm-bindgen crate documentation (0.2.130)",
          "url": "https://docs.rs/wasm-bindgen/latest/wasm_bindgen/",
          "kind": "docs"
        },
        {
          "title": "The wasm-bindgen guide",
          "url": "https://wasm-bindgen.github.io/wasm-bindgen/",
          "kind": "docs"
        },
        {
          "title": "serde-wasm-bindgen: typed serialization across the boundary",
          "url": "https://docs.rs/serde-wasm-bindgen/latest/serde_wasm_bindgen/",
          "kind": "docs"
        },
        {
          "title": "wasm-bindgen repository",
          "url": "https://github.com/wasm-bindgen/wasm-bindgen",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "v03",
      "n": 3,
      "title": "JS interop: closures, promises and the JsValue escape hatch",
      "minutes": 80,
      "level": "advanced",
      "goal": "Bind host functions, keep Rust closures alive for exactly as long as their listeners, and drive a JS Promise from a Rust future without blocking the main thread.",
      "sections": [
        {
          "h": "Imports are just functions",
          "p": [
            "An extern block declares what the host will provide, and wasm-bindgen turns each declaration into a real JavaScript call with canonical handling for strings. Namespace attributes let you bind console.log or performance.now directly, while js-sys provides typed wrappers for built-ins like Array, Promise, Uint8Array and Date.",
            "The escape hatch is JsValue: an opaque handle to any JS value. It is cheap to pass and expensive to inspect, because every get or set is a property access across the boundary. Use a typed js-sys wrapper wherever one exists and reserve JsValue for genuinely dynamic data such as structured-clone payloads."
          ],
          "code": `use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = log)]
    fn console_log(s: &str);

    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn performance_now() -> f64;

    #[wasm_bindgen(js_name = structuredClone)]
    fn structured_clone(value: &JsValue) -> JsValue;
}

pub fn element_by_id(id: &str) -> Option<web_sys::HtmlElement> {
    web_sys::window()?
        .document()?
        .get_element_by_id(id)?
        .dyn_into::<web_sys::HtmlElement>()
        .ok()
}

pub fn timed<T>(label: &str, f: impl FnOnce() -> T) -> T {
    let start = performance_now();
    let out = f();
    console_log(&format!("{label}: {:.2} ms", performance_now() - start));
    out
}`,
          "tip": "dyn_into returns Result and dyn_ref returns Option — use the latter when a null is a normal outcome, and handle it instead of unwrapping."
        },
        {
          "h": "Closures have a lifetime, and it is yours",
          "p": [
            "A Rust closure passed to JavaScript must outlive the call that registered it. Closure::new boxes the closure and keeps it alive; if the Closure value is dropped, the JS side still holds a callback pointer into freed memory, and the next event panics or throws. Store the closure in the struct that owns the listener, and drop both together.",
            "For a listener that only ever fires once, Closure::once_into_js hands ownership to JavaScript and needs no bookkeeping. Closure::forget() leaks by design: it is correct for a listener that must live as long as the page, and a bug everywhere else, because nothing can ever unregister it."
          ],
          "code": `use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::EventTarget;

pub struct VisibilityWatcher {
    target: EventTarget,
    // Keep the closure alive exactly as long as the listener is registered.
    on_change: Closure<dyn FnMut(web_sys::Event)>,
}

impl VisibilityWatcher {
    pub fn attach(target: &EventTarget) -> Result<Self, JsValue> {
        let on_change = Closure::<dyn FnMut(web_sys::Event)>::new(move |_ev| {
            let hidden = web_sys::window()
                .and_then(|w| w.document())
                .map(|d| d.hidden())
                .unwrap_or(false);
            if hidden {
                // pause timers, flush buffers, stop polling
            }
        });
        target.add_event_listener_with_callback(
            "visibilitychange",
            on_change.as_ref().unchecked_ref(),
        )?;
        Ok(Self { target: target.clone(), on_change })
    }
}

impl Drop for VisibilityWatcher {
    fn drop(&mut self) {
        let _ = self.target.remove_event_listener_with_callback(
            "visibilitychange",
            self.on_change.as_ref().unchecked_ref(),
        );
    }
}`,
          "tip": "The error 'closure invoked after being dropped' is almost always a Closure that was not stored; it is not a wasm-bindgen bug."
        },
        {
          "h": "Promises are futures, and futures need a driver",
          "p": [
            "wasm-bindgen-futures bridges the two worlds. spawn_local drives a Rust future on the current thread, and JsFuture converts a JS Promise into something awaitable. In 0.4.80 the crate is a thin shim over js_sys::futures: js_sys::Promise implements IntoFuture directly, so a promise can simply be awaited.",
            "There is no thread to block in a browser. A synchronous wait deadlocks the event loop, and a busy loop starves rendering. spawn_local returns immediately, which is why the work must live inside the async block and why errors inside it have to be surfaced explicitly — nobody is awaiting the spawned future."
          ],
          "code": `use wasm_bindgen::JsCast;
use wasm_bindgen_futures::spawn_local;

pub fn load_json(url: &'static str) {
    spawn_local(async move {
        let window = web_sys::window().expect("browser");
        let resp: web_sys::Response = wasm_bindgen_futures::JsFuture::from(
            window.fetch_with_str(url),
        )
        .await
        .expect("network")
        .dyn_into()
        .expect("Response");

        if !resp.ok() {
            web_sys::console::error_1(&format!("HTTP {}", resp.status()).into());
            return;
        }

        let text = wasm_bindgen_futures::JsFuture::from(resp.text().unwrap())
            .await
            .expect("body")
            .as_string()
            .unwrap_or_default();

        let _rows: Vec<Metric> = serde_json::from_str(&text).unwrap_or_default();
    });
}`,
          "list": [
            "spawn_local drives the future on the microtask queue, not a thread",
            "A panic inside a spawned future is not propagated to the caller",
            "Awaiting sequentially serializes requests; use join_all for independent fetches",
            "Always check Response::ok() — fetch resolves on 404 and 500"
          ]
        }
      ],
      "exercise": {
        "prompt": "Attach a click listener to a button that increments a shared counter, keep the closure alive in a struct, and remove the listener in Drop so a test can assert the callback stops firing.",
        "starter": `use std::cell::Cell;
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use web_sys::HtmlElement;

pub struct ClickCounter {
    // hold the element, the closure and the shared count
}

impl ClickCounter {
    pub fn attach(button: &HtmlElement) -> Result<Self, JsValue> {
        // 1. Rc<Cell<u32>>
        // 2. Closure::new(move |_| ...)
        // 3. add_event_listener_with_callback("click", ...)
        todo!()
    }
}`,
        "hint": "Rc<Cell<u32>> moves into the closure, the closure moves into the struct, and Drop calls remove_event_listener_with_callback with the same callback reference.",
        "solution": `use std::cell::Cell;
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::HtmlElement;

pub struct ClickCounter {
    button: HtmlElement,
    count: Rc<Cell<u32>>,
    on_click: Closure<dyn FnMut(web_sys::MouseEvent)>,
}

impl ClickCounter {
    pub fn attach(button: &HtmlElement) -> Result<Self, JsValue> {
        let count = Rc::new(Cell::new(0));
        let seen = count.clone();

        let on_click = Closure::<dyn FnMut(web_sys::MouseEvent)>::new(
            move |_ev: web_sys::MouseEvent| {
                seen.set(seen.get() + 1);
            },
        );

        button.add_event_listener_with_callback(
            "click",
            on_click.as_ref().unchecked_ref(),
        )?;

        Ok(Self { button: button.clone(), count, on_click })
    }

    pub fn count(&self) -> u32 {
        self.count.get()
    }
}

impl Drop for ClickCounter {
    fn drop(&mut self) {
        let _ = self.button.remove_event_listener_with_callback(
            "click",
            self.on_click.as_ref().unchecked_ref(),
        );
    }
}`
      },
      "production": [
        "Every add_event_listener_with_callback has a matching removal in Drop or in a teardown path.",
        "Spawned futures log their own failures; nothing awaits them to surface an error.",
        "Response::ok() is checked before parsing, so a 500 page is not parsed as JSON.",
        "JsValue is confined to the FFI layer and converted to typed data before it reaches app logic."
      ],
      "crates": [
        "wasm-bindgen",
        "wasm-bindgen-futures",
        "js-sys",
        "web-sys"
      ],
      "pitfall": "A JS callback that fires after the Rust owner was dropped: the trap surfaces as 'unreachable executed' or a null function pointer, with a stack that points at the event dispatch and not at the registration site you need to fix.",
      "questions": [
        {
          "q": "What happens if a Closure passed to add_event_listener_with_callback is dropped while the listener is still registered?",
          "options": [
            "JavaScript keeps a strong reference, so the closure stays valid",
            "The next event invokes freed memory, producing a trap or a thrown error",
            "wasm-bindgen automatically unregisters the listener on drop",
            "The closure is moved into the JavaScript heap by value"
          ],
          "answer": 1,
          "explain": "The JS side holds a function pointer into wasm. Dropping the Closure frees its environment, so the next dispatch calls into memory that no longer belongs to the closure."
        },
        {
          "q": "Why is spawn_local the right tool instead of blocking on a future?",
          "options": [
            "It runs the future on a background thread",
            "It schedules the future on the event loop, keeping the main thread responsive",
            "It converts the future into a synchronous Promise",
            "It catches panics and returns them as JsError"
          ],
          "answer": 1,
          "explain": "There is one thread in the browser. Blocking it stops rendering and timers; spawn_local hands the future to the microtask queue and returns immediately. It does not catch panics."
        },
        {
          "q": "A fetch resolves with status 500. What does the Rust code see?",
          "options": [
            "The await returns Err, because HTTP errors reject the promise",
            "The await returns Ok with a Response whose ok() is false",
            "JsFuture panics on non-2xx status codes",
            "The promise never settles until the body is read"
          ],
          "answer": 1,
          "explain": "fetch only rejects on network failure. HTTP status codes resolve normally, so every call site must check Response::ok() or it will happily parse an error page."
        }
      ],
      "quickbytes": [
        "Store every long-lived Closure in the struct that owns the listener, and remove the listener in Drop.",
        "Closure::once_into_js is for one-shot listeners; Closure::forget() leaks and cannot be undone.",
        "js_sys::Promise implements IntoFuture, so promise.await works directly with wasm-bindgen-futures 0.4.80.",
        "Check Response::ok(): fetch rejects on network errors, not on 4xx or 5xx."
      ],
      "github": [
        { "name": "wasm-bindgen/wasm-bindgen — closure and futures support", "url": "https://github.com/wasm-bindgen/wasm-bindgen" },
        { "name": "rustwasm/gloo — ergonomic web APIs on top of web-sys", "url": "https://github.com/rustwasm/gloo" }
      ],
      "resources": [
        {
          "title": "wasm-bindgen-futures: JsFuture, spawn_local, promise interop",
          "url": "https://docs.rs/wasm-bindgen-futures/latest/wasm_bindgen_futures/",
          "kind": "docs"
        },
        {
          "title": "wasm-bindgen closure module",
          "url": "https://docs.rs/wasm-bindgen/latest/wasm_bindgen/closure/index.html",
          "kind": "docs"
        },
        {
          "title": "js-sys: typed bindings for JavaScript built-ins",
          "url": "https://docs.rs/js-sys/latest/js_sys/",
          "kind": "docs"
        },
        {
          "title": "wasm-bindgen repository — internals and issues",
          "url": "https://github.com/wasm-bindgen/wasm-bindgen",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "v04",
      "n": 4,
      "title": "Leptos: fine-grained reactivity without a virtual DOM",
      "minutes": 85,
      "level": "advanced",
      "goal": "Build a component from signals, a memo and an effect, and explain why Leptos patches one DOM node instead of diffing a tree.",
      "sections": [
        {
          "h": "A signal is a cell with subscribers",
          "p": [
            "signal(0) returns a reader and a writer. Reading inside a reactive scope subscribes that scope; writing marks exactly those subscribers dirty and schedules their updates. A view! expression compiles into DOM nodes plus effects, so changing one count touches one text node — there is no tree to diff, and no props to compare.",
            "This is why Leptos code has no dependency arrays. Dependencies are discovered by reading: an effect that calls total() re-runs when anything total() reads changes. The trade-off is that an accidental read inside an effect widens its dependency set, and the reactive graph, not the component tree, becomes the thing you debug."
          ],
          "code": `use leptos::prelude::*;

#[component]
pub fn LatencyCard() -> impl IntoView {
    let (samples, set_samples) = signal(Vec::<f64>::new());
    let (paused, set_paused) = signal(false);

    // Derived state: recomputed only when samples changes.
    let p95 = Memo::new(move |_| {
        let mut v = samples.get();
        if v.is_empty() {
            return 0.0;
        }
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let idx = ((v.len() - 1) as f64 * 0.95).round() as usize;
        v[idx]
    });

    // Side effect, not render logic: runs after the DOM update.
    Effect::new(move |_| {
        if p95.get() > 250.0 {
            leptos::logging::warn!("p95 above budget");
        }
    });

    view! {
        <section class="card" aria-live="polite">
            <h2>"Latency"</h2>
            <p>{move || format!("{:.1} ms p95", p95.get())}</p>
            <button
                aria-pressed=move || paused.get().to_string()
                on:click=move |_| set_paused.update(|p| *p = !*p)
            >
                {move || if paused.get() { "Resume" } else { "Pause" }}
            </button>
        </section>
    }
}`,
          "tip": "Closures that read a signal are what make the DOM reactive; passing a value directly freezes it at render time."
        },
        {
          "h": "Components are functions, props are arguments",
          "p": [
            "A #[component] function takes typed props and returns impl IntoView. Props are ordinary Rust values evaluated by the caller, so reactivity has to be passed in explicitly — either a signal or a closure. Children are a prop too, typed as Children or, when the parent re-renders, as ChildrenFn.",
            "Mounting differs per build target. A client-only app calls mount_to_body(App); a hydrated app calls hydrate_body(App) and expects the server to have produced identical markup. The same component tree serves both, which is the point — but only when rendering is deterministic."
          ],
          "code": `use leptos::prelude::*;

#[component]
pub fn Stat(
    label: &'static str,
    #[prop(into)] value: Signal<String>,
    #[prop(default = "—")] trend: &'static str,
) -> impl IntoView {
    view! {
        <div class="stat">
            <span class="stat-label">{label}</span>
            <strong class="stat-value">{move || value.get()}</strong>
            <span class="stat-trend">{trend}</span>
        </div>
    }
}

#[component]
pub fn Summary() -> impl IntoView {
    let (rps, set_rps) = signal(0u32);
    let value = Signal::derive(move || format!("{rps} req/s"));

    view! {
        <Stat label="Throughput" value=value trend="+4%" />
        <button on:click=move |_| set_rps.update(|n| *n += 1)>"Tick"</button>
    }
}`,
          "list": [
            "Signals are Copy: pass them into closures instead of cloning data",
            "Signal::derive builds a read-only signal from a closure",
            "#[prop(into)] lets callers pass &str or String without wrapping",
            "Prefer ChildrenFn only when the parent may re-render the children"
          ]
        },
        {
          "h": "What fine-grained reactivity costs",
          "p": [
            "Compile time and binary size are the price. Each view! expansion produces monomorphized code, and a mid-sized dashboard commonly lands in the hundreds of kilobytes of wasm before compression. The runtime itself stays small; the generated DOM code does not. That is a deliberate trade — you pay once at build time to avoid diffing at run time — and it stays honest only if the bundle is budgeted in CI.",
            "Debugging also changes shape. There is no React DevTools tree to inspect, so you reason about owners, scopes and which signal triggered which effect. Leptos disposes effects when their owner is dropped — that is why an effect created inside a component stops on unmount, and why an effect created outside any owner never stops."
          ],
          "list": [
            "No virtual DOM: one binding per dynamic node",
            "Dependencies come from reads, not declarations",
            "Derived state belongs in Memo, not in the view body",
            "Every effect needs an owner; a detached effect is a leak"
          ],
          "tip": "When a page feels slow, count effects before optimizing markup: a stray Effect::new inside a list item is a common source of duplicate work."
        }
      ],
      "exercise": {
        "prompt": "Build a filter box and a derived match count. Typing must update the count without re-rendering the whole card, and the count must be announced politely to screen readers.",
        "starter": `use leptos::prelude::*;

#[component]
pub fn IncidentFilter() -> impl IntoView {
    // 1. a signal for the query
    // 2. a Memo over a fixed list of incident titles
    // 3. a view with <input> and an aria-live status line
    todo!()
}`,
        "hint": "query.get() inside the memo is the dependency. Render the status with a closure so it updates in place: move || format!(\"{} matches\", count.get()).",
        "solution": `use leptos::prelude::*;

const TITLES: &[&str] = &[
    "checkout latency spike",
    "kafka consumer lag",
    "tls certificate expiring",
    "disk pressure on node-7",
];

#[component]
pub fn IncidentFilter() -> impl IntoView {
    let (query, set_query) = signal(String::new());

    let matches = Memo::new(move |_| {
        let q = query.get().to_lowercase();
        TITLES
            .iter()
            .filter(|t| q.is_empty() || t.to_lowercase().contains(&q))
            .count()
    });

    view! {
        <label for="incident-query">"Filter incidents"</label>
        <input
            id="incident-query"
            type="search"
            prop:value=move || query.get()
            on:input=move |ev| set_query.set(event_target_value(&ev))
        />
        <p role="status" aria-live="polite">
            {move || format!("{} matches", matches.get())}
        </p>
    }
}`
      },
      "production": [
        "Every long-lived effect is created inside an owner so it is disposed with its component.",
        "Lists render with <For> keyed by a stable id, not by index.",
        "Derived values that are read more than once are Memos, not recomputed in the view.",
        "Interactive controls carry labels, and reactive status text lives in a live region."
      ],
      "crates": [
        "leptos",
        "wasm-bindgen",
        "web-sys",
        "leptos_router"
      ],
      "pitfall": "Calling a plain function inside view! that reads many signals: every ancestor render re-evaluates it, so the browser does far more work than the number of changed values suggests.",
      "questions": [
        {
          "q": "How does an Effect know which signals it depends on?",
          "options": [
            "It re-runs on every signal write in the application",
            "It records the signals read during its last run",
            "Dependencies are declared in the Effect::new argument list",
            "The component passes an explicit dependency tuple"
          ],
          "answer": 1,
          "explain": "Leptos tracks reads inside the reactive scope. That is why a conditional read only subscribes while the branch is taken, and why hiding a read can silently drop a dependency."
        },
        {
          "q": "Why wrap a derived value in Memo instead of recomputing it in the view?",
          "options": [
            "Memo runs on a background thread",
            "Memo caches the value and notifies dependents only when it changes",
            "The view cannot call arbitrary functions",
            "Memo is required for values used in attributes"
          ],
          "answer": 1,
          "explain": "A memo is a cached node in the reactive graph. Recomputing in the view repeats the work on each render and can re-trigger dependent effects even when the value is unchanged."
        },
        {
          "q": "What changes between mount_to_body and hydrate_body?",
          "options": [
            "hydrate_body adopts existing server-rendered DOM and attaches listeners; mount_to_body creates nodes",
            "hydrate_body runs only on the server",
            "mount_to_body requires the ssr feature",
            "They are aliases; the feature flags decide the behavior"
          ],
          "answer": 0,
          "explain": "Hydration walks the existing markup and wires reactivity onto it, which is why the server output must match what the client would render. Mounting builds the DOM from scratch."
        }
      ],
      "quickbytes": [
        "Read a signal inside a closure to keep an attribute reactive; a plain value freezes it.",
        "Use Memo for derived state read more than once, and keep the computation pure.",
        "Effects run after render — put DOM measurement there, not in the view body.",
        "An effect with no owner never stops; create it inside a component or an Owner::new scope."
      ],
      "github": [
        { "name": "leptos-rs/leptos", "url": "https://github.com/leptos-rs/leptos" },
        { "name": "leptos-rs/start-axum — SSR starter template", "url": "https://github.com/leptos-rs/start-axum" }
      ],
      "resources": [
        {
          "title": "leptos crate documentation (0.8.x)",
          "url": "https://docs.rs/leptos/latest/leptos/",
          "kind": "docs"
        },
        {
          "title": "leptos::prelude::signal",
          "url": "https://docs.rs/leptos/latest/leptos/prelude/fn.signal.html",
          "kind": "docs"
        },
        {
          "title": "Leptos repository — examples including todomvc and counters",
          "url": "https://github.com/leptos-rs/leptos",
          "kind": "repo"
        },
        {
          "title": "leptos::view! macro reference",
          "url": "https://docs.rs/leptos/latest/leptos/macro.view.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "v05",
      "n": 5,
      "title": "Yew: virtual DOM, typed props and reducers",
      "minutes": 80,
      "level": "advanced",
      "goal": "Write a Yew function component with PartialEq props and a reducer, and predict exactly when Yew re-renders a child.",
      "sections": [
        {
          "h": "Render is a function of props and state",
          "p": [
            "Yew keeps a virtual DOM. A component returns Html, Yew diffs it against the previous tree, and patches only what changed. That buys React-like ergonomics and component boundaries that are easy to reason about, at the cost of work proportional to the rendered subtree rather than to the changed values.",
            "Re-rendering is gated by PartialEq on props. If the parent renders and the child's props compare equal, the child is skipped entirely. That makes derive(PartialEq) on a Properties struct a performance decision, not boilerplate — and it makes a non-comparable field an accidental always-render."
          ],
          "code": `use yew::prelude::*;

#[derive(Properties, PartialEq)]
pub struct GaugeProps {
    pub label: AttrValue,
    pub value: f64,
    #[prop_or_default]
    pub unit: Option<AttrValue>,
}

#[function_component]
pub fn Gauge(props: &GaugeProps) -> Html {
    let pct = (props.value.clamp(0.0, 1.0) * 100.0).round();
    let unit = props.unit.clone().unwrap_or_else(|| AttrValue::from("%"));

    html! {
        <div class="gauge" role="img"
             aria-label={format!("{}: {} {}", props.label, pct, unit)}>
            <span class="gauge-label">{ props.label.clone() }</span>
            <meter min="0" max="100" value={pct.to_string()}>
                { format!("{pct}{unit}") }
            </meter>
        </div>
    }
}`,
          "tip": "AttrValue is a cheap-to-clone string handle; use it in props instead of String so cloning during render does not allocate."
        },
        {
          "h": "Hooks hold state across renders",
          "p": [
            "use_state returns a handle whose set() schedules a re-render. use_reducer is better when transitions have names: the reducer owns the transition function, and dispatchers can be cloned into children without dragging setters along. use_memo and use_callback exist to keep values and callbacks stable so children can skip renders.",
            "Every hook runs on every render in call order. That is why hooks cannot be called conditionally, and why a callback created inline in html! is a new value on every render — passing it to a memoized child defeats the equality check you just wrote."
          ],
          "code": `use std::rc::Rc;
use yew::prelude::*;

#[derive(Clone, PartialEq)]
pub struct Filters {
    pub query: String,
    pub errors_only: bool,
}

pub enum FilterAction {
    Query(String),
    ToggleErrors,
    Reset,
}

impl Reducible for Filters {
    type Action = FilterAction;

    fn reduce(self: Rc<Self>, action: Self::Action) -> Rc<Self> {
        let mut next = (*self).clone();
        match action {
            FilterAction::Query(q) => next.query = q,
            FilterAction::ToggleErrors => next.errors_only = !next.errors_only,
            FilterAction::Reset => next = Filters { query: String::new(), errors_only: false },
        }
        Rc::new(next)
    }
}

#[function_component]
pub fn FilterBar() -> Html {
    let filters = use_reducer(|| Filters { query: String::new(), errors_only: false });

    let oninput = {
        let filters = filters.clone();
        Callback::from(move |e: InputEvent| {
            let input: web_sys::HtmlInputElement = e.target_unchecked_into();
            filters.dispatch(FilterAction::Query(input.value()));
        })
    };

    html! {
        <label>
            { "Filter" }
            <input type="search" {oninput} value={filters.query.clone()} />
        </label>
    }
}`,
          "list": [
            "Clone handles, never data: UseReducerHandle and Callback are cheap",
            "Derive PartialEq on every Properties struct",
            "Use use_callback when a callback is passed to a child that memoizes",
            "Keep async work in use_effect_with with an explicit dependency tuple"
          ]
        },
        {
          "h": "Boundaries are where the cost lives",
          "p": [
            "A state change re-renders the component that owns the hook, then walks children whose props changed. Too high and you re-render the page; too low and you need callbacks and duplicated fetches. Context solves the plumbing, not the cost: every consumer re-renders when the context value changes, so context is for values that change rarely.",
            "The practical fix for a janky list is almost always to stop re-rendering it. Move per-row state into the row component, pass only the row's data, and give the list a keyed iterator so Yew can match children instead of rebuilding by position."
          ],
          "list": [
            "A context value that changes per keystroke re-renders every consumer",
            "Keyed children let the diff reuse DOM nodes instead of recreating them",
            "Memoize expensive derived rows with use_memo over the row slice",
            "Measure with the browser profiler before restructuring the tree"
          ],
          "tip": "If a parent's state changes and the list re-renders, check the props first: one non-PartialEq field can make every row compare unequal."
        }
      ],
      "exercise": {
        "prompt": "Add a search box that filters a list of incidents. Each row must be its own component taking only the row's data, so typing does not re-render unrelated rows.",
        "starter": `use yew::prelude::*;

#[derive(Clone, PartialEq)]
pub struct Incident {
    pub id: u32,
    pub title: AttrValue,
}

#[function_component]
pub fn IncidentList() -> Html {
    // 1. use_state for the query
    // 2. filter in render
    // 3. a Row component with PartialEq props
    todo!()
}`,
        "hint": "Give Row a Properties struct with a single Incident field and derive PartialEq. AttrValue makes the String comparison cheap, and the key keeps DOM nodes stable.",
        "solution": `use yew::prelude::*;

#[derive(Clone, PartialEq)]
pub struct Incident {
    pub id: u32,
    pub title: AttrValue,
}

#[derive(Properties, PartialEq)]
pub struct RowProps {
    pub incident: Incident,
}

#[function_component]
fn Row(props: &RowProps) -> Html {
    html! {
        <li class="row">
            <span class="id">{ props.incident.id }</span>
            { props.incident.title.clone() }
        </li>
    }
}

#[function_component]
pub fn IncidentList() -> Html {
    let incidents = use_state(|| vec![
        Incident { id: 1, title: AttrValue::from("checkout latency spike") },
        Incident { id: 2, title: AttrValue::from("kafka consumer lag") },
        Incident { id: 3, title: AttrValue::from("disk pressure on node-7") },
    ]);
    let query = use_state(String::new);

    let oninput = {
        let query = query.clone();
        Callback::from(move |e: InputEvent| {
            let input: web_sys::HtmlInputElement = e.target_unchecked_into();
            query.set(input.value());
        })
    };

    let needle = query.to_lowercase();
    let visible: Vec<Incident> = incidents
        .iter()
        .filter(|i| needle.is_empty() || i.title.to_lowercase().contains(&needle))
        .cloned()
        .collect();

    html! {
        <>
            <input type="search" {oninput} value={(*query).clone()} />
            <ul class="incidents">
                { for visible.iter().map(|i| html! {
                    <Row key={i.id} incident={i.clone()} />
                }) }
            </ul>
        </>
    }
}`
      },
      "production": [
        "Properties structs derive PartialEq; anything non-comparable is wrapped in a type that does.",
        "Context carries values that change rarely; per-keystroke state stays local.",
        "Lists use keyed children with stable ids from the server, never array indices.",
        "Callbacks passed to memoized children are created with use_callback, not inline in html!."
      ],
      "crates": [
        "yew",
        "yew-macro",
        "wasm-bindgen",
        "web-sys"
      ],
      "pitfall": "A Properties struct without PartialEq: every parent render re-renders every child, so a keystroke in a search box rebuilds a thousand rows and the profiler blames the diff.",
      "questions": [
        {
          "q": "When does Yew skip re-rendering a child component?",
          "options": [
            "Whenever the parent re-renders, children are always re-rendered",
            "When the child's props compare equal to the previous props",
            "Only when the child has no hooks",
            "When the child returns the same Html value"
          ],
          "answer": 1,
          "explain": "The rendered element carries the props; Yew compares them with PartialEq and skips the child's render and diff when they are equal. Hooks in the child do not change that rule."
        },
        {
          "q": "Why is a Callback created inline in html! a problem for a memoized child?",
          "options": [
            "Inline callbacks cannot capture state",
            "A new Callback value each render makes the props compare unequal",
            "Yew refuses to compile inline callbacks in keyed lists",
            "It moves the closure to the JavaScript heap"
          ],
          "answer": 1,
          "explain": "Callbacks are compared as part of props. Recreating one per render guarantees inequality, so the child re-renders even though nothing it depends on changed. use_callback stabilizes it."
        },
        {
          "q": "What does use_reducer give you that use_state does not?",
          "options": [
            "Shared state across browser tabs",
            "Named transitions in one reduce function plus a dispatch handle children can clone",
            "Automatic persistence to localStorage",
            "Server-side rendering support"
          ],
          "answer": 1,
          "explain": "The reducer centralizes state transitions and hands out a dispatch handle instead of a raw setter. That keeps invariants in one function and lets children trigger actions without owning the state."
        }
      ],
      "quickbytes": [
        "Derive PartialEq on Properties; it is the render gate, not decoration.",
        "AttrValue instead of String in props keeps clones allocation-free.",
        "Keyed children with server ids let the diff move nodes instead of recreating them.",
        "Context that updates per keystroke re-renders every consumer — keep it local."
      ],
      "github": [
        { "name": "yewstack/yew", "url": "https://github.com/yewstack/yew" },
        { "name": "rustwasm/gloo — the web API layer Yew depends on", "url": "https://github.com/rustwasm/gloo" }
      ],
      "resources": [
        {
          "title": "yew crate documentation (0.23.x)",
          "url": "https://docs.rs/yew/latest/yew/",
          "kind": "docs"
        },
        {
          "title": "yew::functional — hooks and function components",
          "url": "https://docs.rs/yew/latest/yew/functional/index.html",
          "kind": "docs"
        },
        {
          "title": "Yew repository — function_todomvc and other examples",
          "url": "https://github.com/yewstack/yew",
          "kind": "repo"
        },
        {
          "title": "gloo documentation — net, timers, events, storage",
          "url": "https://docs.rs/gloo/latest/gloo/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "v06",
      "n": 6,
      "title": "Dioxus: one rsx! tree, several renderers",
      "minutes": 75,
      "level": "advanced",
      "goal": "Build a Dioxus component with Copy signals and typed props, and judge when the cross-platform renderer abstraction actually pays for itself.",
      "sections": [
        {
          "h": "rsx! is a typed builder, not a template",
          "p": [
            "rsx! compiles to a tree of typed element builders. Attributes and children are ordinary Rust expressions, so a conditional child is an if expression rather than a special directive, and a component is any function returning Element. Because the tree is typed, a misspelled attribute is a compile error instead of a silently ignored string.",
            "Dioxus owns a virtual DOM like Yew, but the renderer is swappable: dioxus-web targets the DOM, the desktop renderer embeds a webview, and the same tree can be rendered to a string for SSR. That is the pitch — one codebase, several platforms — and the cost is a layer of indirection between your code and any one platform's API."
          ],
          "code": `use dioxus::prelude::*;

#[derive(Props, Clone, PartialEq)]
struct CardProps {
    title: String,
    #[props(default)]
    subtitle: Option<String>,
}

#[component]
fn MetricCard(props: CardProps) -> Element {
    rsx! {
        article { class: "card",
            h3 { "{props.title}" }
            if let Some(sub) = props.subtitle.as_ref() {
                p { class: "sub", "{sub}" }
            }
        }
    }
}

fn App() -> Element {
    let mut rps = use_signal(|| 0u32);

    rsx! {
        MetricCard {
            title: "Throughput".to_string(),
            subtitle: Some("requests per second".to_string()),
        }
        p { "Current: {rps}" }
        button { onclick: move |_| rps += 1, "Tick" }
    }
}

fn main() {
    dioxus::launch(App);
}`,
          "tip": "#[derive(Props)] plus Clone and PartialEq is the minimum; the framework uses equality to skip re-rendering children."
        },
        {
          "h": "Signals are Copy, so closures stay simple",
          "p": [
            "use_signal returns a Copy handle. Reading it with rps() subscribes the current scope; writing with rps.set(5) or rps += 1 marks subscribers dirty. Because the handle is Copy, closures capture it without cloning and without lifetime fights, which is the main ergonomic difference from Rc<RefCell<...>>.",
            "State that must be shared deeper goes through the context API: provide it at the root, read it below. For collections, the stores feature tracks individual fields so mutating one row does not invalidate a list that renders many rows."
          ],
          "list": [
            "Handles are Copy: move them into closures freely",
            "Reading in a scope is what subscribes that scope",
            "Derived values belong in use_memo, not in the render body",
            "Typed props make the component contract compiler-enforced"
          ],
          "tip": "If a child never updates, check that you passed the signal rather than its current value: a plain u32 captured at render time is a snapshot."
        },
        {
          "h": "The abstraction tax",
          "p": [
            "Cross-platform code means the lowest common denominator for events, assets and routing. Web-specific APIs still need web-sys behind a cfg target gate, so 'one codebase' usually means one component tree and several platform modules. That is a reasonable trade, but it is a trade.",
            "Binary size is the other bill. A web app with three screens still links the runtime, the asset system and the event plumbing. The project's own tiny-dioxus experiment exists because a small app can be made much smaller with care. Measure the shipped bytes before adopting a framework for a marketing page."
          ],
          "list": [
            "Same component tree, platform-specific leaves behind cfg",
            "Hot-patching speeds up the edit loop; it is not a correctness guarantee",
            "Asset handling comes from the framework, not from your bundler",
            "Bundle size is a framework decision you inherit and cannot refactor away"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a StatusBadge component with typed props: a required status string and an optional detail line. Render it three times from App with different statuses, and toggle one of them with a signal.",
        "starter": `use dioxus::prelude::*;

#[derive(Props, Clone, PartialEq)]
struct BadgeProps {
    // status: String
    // detail: Option<String>, defaulted
}

#[component]
fn StatusBadge(props: BadgeProps) -> Element {
    todo!()
}

fn App() -> Element {
    // a signal toggling one badge between "degraded" and "healthy"
    todo!()
}`,
        "hint": "#[props(default)] makes an Option prop optional. Use rsx! with if let Some(detail) to render the second line, and a signal read as {state} inside a string literal.",
        "solution": `use dioxus::prelude::*;

#[derive(Props, Clone, PartialEq)]
struct BadgeProps {
    status: String,
    #[props(default)]
    detail: Option<String>,
}

#[component]
fn StatusBadge(props: BadgeProps) -> Element {
    let class = match props.status.as_str() {
        "healthy" => "badge badge-ok",
        "degraded" => "badge badge-warn",
        _ => "badge badge-bad",
    };

    rsx! {
        div { class: "{class}", role: "status",
            strong { "{props.status}" }
            if let Some(detail) = props.detail.as_ref() {
                span { class: "detail", "{detail}" }
            }
        }
    }
}

fn App() -> Element {
    let mut degraded = use_signal(|| false);
    let status = if degraded() { "degraded" } else { "healthy" };

    rsx! {
        StatusBadge { status: "healthy".to_string(), detail: Some("all checks passing".to_string()) }
        StatusBadge { status: status.to_string() }
        StatusBadge { status: "unavailable".to_string(), detail: Some("api timeout".to_string()) }
        button {
            onclick: move |_| degraded.toggle(),
            "Toggle middle badge"
        }
    }
}`
      },
      "production": [
        "Every component prop struct derives Clone and PartialEq so the renderer can skip unchanged children.",
        "Web-only APIs sit behind cfg(target_arch = \"wasm32\") instead of leaking into shared components.",
        "The bundle budget is measured on the release web build, not on the desktop binary.",
        "Signals are passed instead of values wherever a child must stay reactive."
      ],
      "crates": [
        "dioxus",
        "dioxus-web",
        "wasm-bindgen",
        "web-sys"
      ],
      "pitfall": "Passing a value instead of a signal into a child component: the child renders once with a snapshot and then never updates, which looks like a broken renderer and is actually a captured value.",
      "questions": [
        {
          "q": "What makes a Dioxus signal usable inside a move closure without cloning?",
          "options": [
            "It is Copy, so captures copy the handle",
            "It is Send + Sync and lives in a static",
            "The closure borrows it from a thread-local",
            "The framework wraps every closure in Rc"
          ],
          "answer": 0,
          "explain": "Signal handles are Copy. Moving one into a closure copies the handle while both still refer to the same reactive value, which is why no lifetime annotations are needed."
        },
        {
          "q": "Why derive PartialEq on a Dioxus props struct?",
          "options": [
            "The macro requires it to compile the rsx! call",
            "The renderer compares props to skip re-rendering unchanged children",
            "It enables serialization for server functions",
            "It lets the signal graph detect writes"
          ],
          "answer": 1,
          "explain": "Props equality is the cheap gate before rendering a child subtree. Without it the framework cannot prove the child is unchanged and must render again."
        },
        {
          "q": "What is the honest cost of the multi-renderer abstraction?",
          "options": [
            "Components must be written twice, once per platform",
            "Shared code tends toward the lowest common denominator, with platform code behind cfg gates",
            "The web renderer cannot use web-sys",
            "Signals stop working on desktop"
          ],
          "answer": 1,
          "explain": "You get one component tree, but platform-specific behavior still needs platform modules gated by cfg. The abstraction raises the floor and lowers the ceiling on any single platform."
        }
      ],
      "quickbytes": [
        "Signals are Copy: pass the handle, not the value, or the child freezes.",
        "use_signal + rsx! with {signal} interpolation is the shortest reactive loop in Rust UI.",
        "Gate web-only calls behind cfg(target_arch = \"wasm32\") to keep shared components portable.",
        "Measure the web bundle, not the desktop binary — they have different size floors."
      ],
      "github": [
        { "name": "DioxusLabs/dioxus", "url": "https://github.com/DioxusLabs/dioxus" }
      ],
      "resources": [
        {
          "title": "dioxus crate documentation (0.7.x)",
          "url": "https://docs.rs/dioxus/latest/dioxus/",
          "kind": "docs"
        },
        {
          "title": "Dioxus repository — examples for web, desktop and fullstack",
          "url": "https://github.com/DioxusLabs/dioxus",
          "kind": "repo"
        },
        {
          "title": "Dioxus channel — release walkthroughs and demos",
          "url": "https://www.youtube.com/@DioxusLabs",
          "kind": "video"
        }
      ]
    },
    {
      "id": "v07",
      "n": 7,
      "title": "web-sys: typed bindings and a feature flag per type",
      "minutes": 80,
      "level": "advanced",
      "goal": "Drive the DOM from Rust with web-sys, enable only the features you use, and batch reads and writes so the browser does not reflow on every call.",
      "sections": [
        {
          "h": "Generated from WebIDL, gated by features",
          "p": [
            "web-sys is generated from browser WebIDL: every interface becomes a Rust type, and every method returns a Result or an Option. Because the browser surface is enormous, each type sits behind its own cargo feature. Using HtmlInputElement requires that feature; using its value() also requires the features for the types in the signature.",
            "The result is a feature-flag puzzle rather than an API puzzle. The compiler tells you which type is missing but not which feature provides it. The rule of thumb is that the feature is named after the type, and each method's documentation lists the features it needs. When the error names a type you never wrote, the missing feature is usually one used inside a signature you called, so read that method's docs before guessing."
          ],
          "code": `# Cargo.toml
[dependencies]
wasm-bindgen = "0.2"
web-sys = { version = "0.3", features = [
    "Document",
    "Element",
    "HtmlElement",
    "HtmlInputElement",
    "KeyboardEvent",
    "Window",
] }

# src/lib.rs
use wasm_bindgen::JsCast;

pub fn wire_search() -> Result<(), wasm_bindgen::JsValue> {
    let window = web_sys::window().ok_or("no window")?;
    let document = window.document().ok_or("no document")?;
    let input = document
        .get_element_by_id("search")
        .ok_or("missing #search")?
        .dyn_into::<web_sys::HtmlInputElement>()?;
    input.set_placeholder("Filter incidents");
    input.focus()?;
    Ok(())
}`,
          "tip": "dyn_into returns Result, dyn_ref returns Option. Use dyn_ref when a null is a normal outcome and dyn_into when the wrong type is a bug."
        },
        {
          "h": "Reads, writes and forced reflow",
          "p": [
            "Every getter and setter is a JavaScript call, and some of them are worse than others. Reading offset_width or getBoundingClientRect forces the browser to flush pending style and layout. A loop that reads, writes, then reads again can force dozens of reflows and turn a 200-element list into a 100 ms frame. The cost is not the call itself but the flush it triggers, which can revalidate style for the whole document.",
            "The fix is mechanical: collect every read first, then perform every write, ideally inside a single animation frame. The DOM stays the same; the number of layout flushes drops from N to one. That structural change is usually worth more than any micro-optimization inside the loop itself."
          ],
          "code": `use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

pub fn widen_all(selector: &str) -> Result<(), JsValue> {
    let document = web_sys::window().unwrap().document().unwrap();
    let nodes = document.query_selector_all(selector)?;

    // Pass 1: read everything (one layout flush).
    let mut widths = Vec::with_capacity(nodes.length() as usize);
    for i in 0..nodes.length() {
        let el = nodes
            .item(i)
            .and_then(|n| n.dyn_into::<web_sys::HtmlElement>().ok());
        if let Some(el) = el {
            widths.push(el.offset_width());
        }
    }

    // Pass 2: write once, on the next frame.
    let window = web_sys::window().unwrap();
    let closure = Closure::once(move || {
        for (i, w) in widths.into_iter().enumerate() {
            let el = nodes
                .item(i as u32)
                .and_then(|n| n.dyn_into::<web_sys::HtmlElement>().ok());
            if let Some(el) = el {
                let _ = el.style().set_property("width", &format!("{}px", w + 8));
            }
        }
    });
    window.request_animation_frame(closure.into_js_value().unchecked_ref())?;
    Ok(())
}`,
          "list": [
            "Batch reads, then writes; never alternate inside a loop",
            "Prefer CSS classes over inline style writes for repeated changes",
            "into_js_value hands the closure to JS, so nothing leaks",
            "Cache element handles instead of querying them per frame"
          ]
        },
        {
          "h": "Option and Result are the honest API",
          "p": [
            "The DOM is full of legitimate absence: a missing element, a browser without an API, a canvas context that failed to create. web-sys models that with Option and Result, and unwrapping turns an expected branch into a panic that aborts the whole wasm instance. In a browser this is not a red console line you can click through; the app simply stops.",
            "Keep a thin DOM layer that returns Result<_, AppError> and converts JsValue at the edge. It keeps JavaScript error objects out of domain code and gives you one place to attach context such as the selector that failed. It is also the place to log that context once, instead of at every call site."
          ],
          "tip": "When a web-sys call appears missing, check the feature flag first and the browser support second — the compiler and the docs answer different halves of that question."
        }
      ],
      "exercise": {
        "prompt": "Read the value of an input on click, write it into an output element's text, and toggle a CSS class when the value is empty. Return Result from every DOM call instead of unwrapping.",
        "starter": `use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

pub fn wire_echo() -> Result<(), JsValue> {
    // 1. query #echo-input as HtmlInputElement
    // 2. query #echo-output as HtmlElement
    // 3. on click: read value, write text, toggle class
    todo!()
}`,
        "hint": "Store the closure in a struct or leak it deliberately with into_js_value; the input's value() returns String, and class_list().toggle_with_force(\"empty\", bool) sets the class deterministically.",
        "solution": `use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::{HtmlElement, HtmlInputElement};

pub fn wire_echo() -> Result<(), JsValue> {
    let document = web_sys::window().unwrap().document().unwrap();

    let input = document
        .get_element_by_id("echo-input")
        .ok_or("missing #echo-input")?
        .dyn_into::<HtmlInputElement>()?;

    let output = document
        .get_element_by_id("echo-output")
        .ok_or("missing #echo-output")?
        .dyn_into::<HtmlElement>()?;

    let button = document
        .get_element_by_id("echo-run")
        .ok_or("missing #echo-run")?
        .dyn_into::<HtmlElement>()?;

    let onclick = {
        let input = input.clone();
        let output = output.clone();
        Closure::<dyn FnMut()>::new(move || {
            let value = input.value();
            output.set_text_content(Some(&value));
            let empty = value.trim().is_empty();
            let _ = output.class_list().toggle_with_force("empty", empty);
            let _ = output.set_attribute("aria-invalid", if empty { "true" } else { "false" });
        })
    };

    button.add_event_listener_with_callback("click", onclick.as_ref().unchecked_ref())?;
    onclick.forget(); // page-lifetime listener: intentionally leaked

    Ok(())
}`
      },
      "production": [
        "web-sys features are listed explicitly in Cargo.toml; no glob features in a shipping crate.",
        "DOM reads and writes are batched into a single frame, verified in the Performance panel.",
        "The DOM layer returns Result and converts JsValue once, at the module boundary.",
        "Element lookups happen after mount, never during module initialization."
      ],
      "crates": [
        "web-sys",
        "wasm-bindgen",
        "js-sys"
      ],
      "pitfall": "unwrap() on get_element_by_id during startup: the element is created by the framework after your module initializes, so the first call panics and the entire wasm instance aborts before mounting.",
      "questions": [
        {
          "q": "Why does web-sys put each interface behind a cargo feature?",
          "options": [
            "To enforce browser compatibility at compile time",
            "Because the full generated surface is enormous, so code is compiled only for the types you use",
            "Because WebIDL cannot be represented without feature gates",
            "To prevent unsafe code in the generated bindings"
          ],
          "answer": 1,
          "explain": "The binding set covers the whole web platform. Feature-gating keeps compile time and binary size proportional to what a crate actually touches; the feature names follow the type names."
        },
        {
          "q": "Which pattern avoids forced synchronous layout?",
          "options": [
            "Interleaving offset_height reads and style writes in one loop",
            "Reading all measurements first, then applying all writes in one frame",
            "Forcing a reflow with getBoundingClientRect after each write",
            "Writing styles in a microtask after every read"
          ],
          "answer": 1,
          "explain": "A read after a write forces the browser to flush pending layout so the number is correct. Separating the passes guarantees at most one flush instead of one per element."
        },
        {
          "q": "What does Closure::into_js_value do for a requestAnimationFrame callback?",
          "options": [
            "It copies the closure into the wasm heap",
            "It transfers ownership of the closure to JavaScript, so it can be collected there",
            "It runs the closure immediately and returns its result",
            "It marks the closure as once-only"
          ],
          "answer": 1,
          "explain": "into_js_value returns a JsValue owning the closure, so the browser keeps it alive for the frame and frees it afterwards. forget() would leak instead."
        }
      ],
      "quickbytes": [
        "The feature name is usually the type name; add every type used in a signature, not just the entry point.",
        "Batch DOM reads before writes — one layout flush instead of one per element.",
        "Return Result from the DOM layer and convert JsValue at the edge; unwrap() aborts the instance.",
        "into_js_value for callbacks JS owns, stored Closure for listeners you must remove."
      ],
      "github": [
        { "name": "wasm-bindgen/wasm-bindgen — web-sys lives in crates/web-sys", "url": "https://github.com/wasm-bindgen/wasm-bindgen" },
        { "name": "rustwasm/gloo — higher-level wrappers over web-sys", "url": "https://github.com/rustwasm/gloo" }
      ],
      "resources": [
        {
          "title": "web-sys crate documentation (0.3.107)",
          "url": "https://docs.rs/web-sys/latest/web_sys/",
          "kind": "docs"
        },
        {
          "title": "web_sys::HtmlInputElement",
          "url": "https://docs.rs/web-sys/latest/web_sys/struct.HtmlInputElement.html",
          "kind": "docs"
        },
        {
          "title": "wasm-bindgen repository — the generator behind web-sys",
          "url": "https://github.com/wasm-bindgen/wasm-bindgen",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "v08",
      "n": 8,
      "title": "SSR and hydration: one tree, two runtimes",
      "minutes": 95,
      "level": "industry",
      "goal": "Render Leptos on the server, ship real HTML with embedded data, then hydrate it on the client without a mismatch or a duplicate fetch.",
      "sections": [
        {
          "h": "Two builds, one source",
          "p": [
            "The server build enables the ssr feature; the client build enables hydrate. Both compile the same crate, so a component cannot quietly depend on the wrong runtime — the feature flags decide what the framework does, and the component code stays identical. The server renders to a string; the client adopts that HTML and attaches listeners.",
            "Hydration is strict about shape. The client must produce exactly the nodes the server produced, or it panics, duplicates nodes, or wires listeners to the wrong element. Anything non-deterministic during render — current time, random values, window size, localStorage — breaks that equality."
          ],
          "code": `// app/src/lib.rs
use leptos::prelude::*;
use leptos_meta::{provide_meta_context, MetaTags, Stylesheet, Title};

pub fn shell(options: LeptosOptions) -> impl IntoView {
    view! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8"/>
                <meta name="viewport" content="width=device-width, initial-scale=1"/>
                <HydrationScripts options/>
                <MetaTags/>
            </head>
            <body>
                <App/>
            </body>
        </html>
    }
}

#[component]
pub fn App() -> impl IntoView {
    provide_meta_context();

    view! {
        <Title text="Ops dashboard"/>
        <Stylesheet id="leptos" href="/pkg/dashboard.css"/>
        <main>
            <h1>"Fleet overview"</h1>
            <MetricsTable/>
        </main>
    }
}`,
          "tip": "HydrationScripts must be inside <head>: it emits the script that loads the wasm and the serialized resource data the client will reuse."
        },
        {
          "h": "Wiring axum to the renderer",
          "p": [
            "generate_route_list walks the router in your app and produces the routes axum must serve, so the server never duplicates a route table by hand. leptos_routes then owns rendering for those paths, and file_and_error_handler serves the hashed JS and wasm assets plus a 404 fallback.",
            "Server functions are the other half. A #[server] function runs in-process during SSR and becomes an HTTP endpoint for the client, so the resource that renders on the server does not refetch during hydration — the serialized value is already in the HTML."
          ],
          "code": `use axum::Router;
use leptos::config::get_configuration;
use leptos_axum::{generate_route_list, LeptosRoutes};

#[tokio::main]
async fn main() {
    let conf = get_configuration(Some("Cargo.toml")).unwrap();
    let leptos_options = conf.leptos_options;
    let addr = leptos_options.site_addr;
    let routes = generate_route_list(App);

    let app = Router::new()
        .leptos_routes(&leptos_options, routes, {
            let options = leptos_options.clone();
            move || shell(options.clone())
        })
        .fallback(leptos_axum::file_and_error_handler(shell))
        .with_state(leptos_options);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    println!("listening on {addr}");
    axum::serve(listener, app.into_make_service()).await.unwrap();
}`,
          "list": [
            "get_configuration reads LeptosOptions from Cargo.toml metadata",
            "generate_route_list derives axum routes from the Router in the app",
            "file_and_error_handler serves /pkg assets and the 404 shell",
            "Server functions are registered by the integration, not by a manual route"
          ]
        },
        {
          "h": "The client side of the same app",
          "p": [
            "The client binary is tiny: install the panic hook, then call hydrate_body(App). It looks for the markup the server already produced and attaches behavior to it. If you see duplicated content, the client rendered instead of hydrating — usually because hydrate was not the enabled feature.",
            "Guard platform code with cfg. A window() call during SSR is not a browser call, and it either returns nothing or panics depending on the helper; the safe rule is that any code touching window, document or localStorage lives in an Effect, which only runs on the client, or behind #[cfg(feature = \"hydrate\")]."
          ],
          "code": `// app/src/main.rs — the client entry point
#[cfg(feature = "hydrate")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn hydrate() {
    console_error_panic_hook::set_once();
    leptos::mount::hydrate_body(App);
}

#[cfg(not(feature = "hydrate"))]
fn main() {
    // The server binary uses the axum entry point instead.
}

// Deterministic render: no clock, no randomness, no storage reads.
#[component]
pub fn Uptime(seconds: u64) -> impl IntoView {
    view! { <span class="uptime">{format_duration(seconds)}</span> }
}`,
          "tip": "If hydration panics, diff the first bytes of the served HTML against view-source of the client render: the first divergence is the component that read the environment."
        }
      ],
      "exercise": {
        "prompt": "Add a server function that returns metric rows and a component that renders them inside Suspense. The HTML must already contain the rows, and the client must not refetch them during hydration.",
        "starter": `use leptos::prelude::*;

#[server]
pub async fn metrics() -> Result<Vec<Metric>, ServerFnError> {
    todo!()
}

#[component]
pub fn MetricsTable() -> impl IntoView {
    // 1. Resource::new keyed on ()
    // 2. Suspense with an aria-busy fallback
    // 3. render each row
    todo!()
}`,
        "hint": "Resource::new(|| (), |_| async move { metrics().await }) is enough; Suspense renders the fallback on the server only until the resource resolves, then the data is serialized into the HTML.",
        "solution": `use leptos::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Metric {
    pub name: String,
    pub p95_ms: f64,
}

#[server]
pub async fn metrics() -> Result<Vec<Metric>, ServerFnError> {
    // Server-only: replace with your store or database call.
    Ok(vec![
        Metric { name: "checkout".into(), p95_ms: 182.0 },
        Metric { name: "search".into(), p95_ms: 74.5 },
    ])
}

#[component]
pub fn MetricsTable() -> impl IntoView {
    let rows = Resource::new(|| (), |_| async move { metrics().await });

    view! {
        <Suspense fallback=|| view! { <p aria-busy="true">"Loading metrics…"</p> }>
            {move || rows.get().map(|result| match result {
                Ok(list) => view! {
                    <table>
                        <thead><tr><th>"Route"</th><th>"p95"</th></tr></thead>
                        <tbody>
                            {list.into_iter().map(|m| view! {
                                <tr>
                                    <td>{m.name}</td>
                                    <td>{format!("{:.1} ms", m.p95_ms)}</td>
                                </tr>
                            }).collect_view()}
                        </tbody>
                    </table>
                }.into_any(),
                Err(e) => view! { <p class="error">{e.to_string()}</p> }.into_any(),
            })}
        </Suspense>
    }
}`
      },
      "production": [
        "Render output is deterministic: no clock, randomness or storage reads outside Effects.",
        "The SSR response embeds the same resource data the client would fetch, verified in the HTML.",
        "Server-only dependencies are behind the ssr feature so they never enter the wasm bundle.",
        "A hydration test loads the real server response in a browser and fails on console errors.",
        "Assets are content-hashed, so a stale HTML cannot pair with a new wasm binary."
      ],
      "crates": [
        "leptos",
        "leptos_axum",
        "leptos_meta",
        "axum"
      ],
      "pitfall": "Rendering Date::now() or a random id during SSR: the client computes a different value, hydration sees a text node it did not expect, and the app either panics or silently duplicates the subtree.",
      "questions": [
        {
          "q": "What does hydration do that client-side mounting does not?",
          "options": [
            "It runs the component tree twice",
            "It adopts the server-rendered DOM and attaches reactivity to existing nodes",
            "It downloads the wasm binary before the HTML",
            "It disables server functions on the client"
          ],
          "answer": 1,
          "explain": "Hydration walks the existing tree and binds behavior to it, which is why the client's output must match the server's byte-for-byte in structure."
        },
        {
          "q": "Why does SSR usually avoid a duplicate data fetch on hydration?",
          "options": [
            "The browser caches the server function response in the HTTP cache",
            "Resource data is serialized into the HTML and reused by the client",
            "Server functions are disabled for the first 30 seconds",
            "The client skips rendering components until interaction"
          ],
          "answer": 1,
          "explain": "Leptos serializes resolved resources alongside the markup, so the client can rebuild the same reactive values without calling the endpoint again."
        },
        {
          "q": "Where should a window().inner_width() call live so SSR does not break?",
          "options": [
            "Directly in the component body",
            "Inside an Effect or behind #[cfg(feature = \"hydrate\")]",
            "Inside a server function",
            "In the shell function before rendering"
          ],
          "answer": 1,
          "explain": "Effects only run in the browser, after hydration. Calling browser APIs during render makes the server and client outputs differ, which is exactly what hydration cannot tolerate."
        }
      ],
      "quickbytes": [
        "SSR build enables ssr; client build enables hydrate; never both in one target.",
        "Keep HydrationScripts in <head> — it carries the wasm loader and serialized data.",
        "Any window/document/localStorage access belongs in an Effect or a hydrate-gated module.",
        "generate_route_list keeps axum routes and the Leptos router in sync; do not hand-write them."
      ],
      "github": [
        { "name": "leptos-rs/leptos — SSR and hydration examples", "url": "https://github.com/leptos-rs/leptos" },
        { "name": "tokio-rs/axum", "url": "https://github.com/tokio-rs/axum" }
      ],
      "resources": [
        {
          "title": "leptos_axum: routes, server functions and streaming renders",
          "url": "https://docs.rs/leptos_axum/latest/leptos_axum/",
          "kind": "docs"
        },
        {
          "title": "leptos::mount::hydrate_body",
          "url": "https://docs.rs/leptos/latest/leptos/mount/fn.hydrate_body.html",
          "kind": "docs"
        },
        {
          "title": "Leptos repository — hackernews_axum shows the full wiring",
          "url": "https://github.com/leptos-rs/leptos",
          "kind": "repo"
        },
        {
          "title": "start-axum — SSR starter template",
          "url": "https://github.com/leptos-rs/start-axum",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "v09",
      "n": 9,
      "title": "State management: signals, context and server state",
      "minutes": 85,
      "level": "industry",
      "goal": "Classify state into UI, cache and session, then place each kind where it stays reactive without turning the whole app into one store.",
      "sections": [
        {
          "h": "Classify before you share",
          "p": [
            "Three kinds of state live in a frontend: UI state such as an open panel or draft text, a client cache of server data, and session state such as the signed-in user. They have different lifetimes and different failure modes. Collapsing them into one global store is how a dashboard ends up refetching everything because someone toggled a theme.",
            "The classification is also the placement rule. UI state belongs to the component that renders it, server state belongs in a resource keyed by its inputs, and session state belongs at the root where it changes rarely. Derived values are not state at all: they are memos over the other three."
          ],
          "list": [
            "UI state: local signal, dies with the component",
            "Server state: Resource keyed by inputs, invalidated by refetch",
            "Session state: context at the root, changes rarely",
            "Derived values: Memo, never a second source of truth"
          ]
        },
        {
          "h": "Context is plumbing, not a store",
          "p": [
            "provide_context inserts a value into the owner tree and use_context pulls it out. The value must itself be reactive — an RwSignal, a signal tuple, or a struct of signals. Providing a plain struct gives children a snapshot: they read it once and never update, which is the most common 'context is broken' bug in every Rust UI framework.",
            "Copying signals into a struct is the cheapest way to get a typed, shared handle. The struct is Copy, so passing it costs nothing, and each field keeps its own dependency tracking, so a component that reads only theme does not re-render when the user changes."
          ],
          "code": `use leptos::prelude::*;

#[derive(Clone, Copy, PartialEq, Default)]
pub enum Theme {
    #[default]
    Dark,
    Light,
}

#[derive(Clone, Copy)]
pub struct Session {
    pub user: RwSignal<Option<String>>,
    pub theme: RwSignal<Theme>,
}

#[component]
pub fn Root() -> impl IntoView {
    let session = Session {
        user: RwSignal::new(None),
        theme: RwSignal::new(Theme::default()),
    };
    provide_context(session);
    view! { <Shell/> }
}

#[component]
pub fn Shell() -> impl IntoView {
    let session = use_context::<Session>().expect("Root provides Session");
    let is_dark = move || session.theme.get() == Theme::Dark;

    view! {
        <main class:dark=is_dark>
            <button on:click=move |_| {
                session.theme.update(|t| {
                    *t = if *t == Theme::Dark { Theme::Light } else { Theme::Dark }
                });
            }>"Toggle theme"</button>
        </main>
    }
}`,
          "tip": "If a child renders once and never again, you provided a value; if it re-renders too often, you provided one signal where several would do."
        },
        {
          "h": "Server state has its own rules",
          "p": [
            "A Resource is keyed: the source closure decides when to refetch, and the fetcher is async. Read it with get(), which returns Option<Result<T, E>>, so loading, error and ready are explicit states rather than a boolean you have to keep in sync. Mutations go through an Action or a server function, and freshness comes from refetching, not from writing into the cache.",
            "Do not copy a resource value into a signal to make it easier to use. You then own invalidation by hand and lose the SSR serialization that makes hydration free. If a row needs optimistic updates, keep a separate overlay signal and merge it at render time, so the server remains the source of truth."
          ],
          "code": `use leptos::prelude::*;

#[component]
pub fn Incidents() -> impl IntoView {
    let page = RwSignal::new(1u32);
    let rows = Resource::new(move || page.get(), |p| async move { fetch_page(p).await });

    view! {
        <button on:click=move |_| page.update(|p| *p += 1)>"Next page"</button>
        {move || match rows.get() {
            None => view! { <p aria-busy="true">"Loading…"</p> }.into_any(),
            Some(Err(e)) => view! { <p class="error">{e.to_string()}</p> }.into_any(),
            Some(Ok(list)) => view! {
                <ul>{list.into_iter().map(|r| view! { <li>{r.name}</li> }).collect_view()}</ul>
            }.into_any(),
        }}
    }
}`,
          "list": [
            "Source closure = cache key; if it changes, the resource refetches",
            "Match all three states explicitly so a stale page is impossible",
            "Actions for writes, Resources for reads",
            "Never mirror a resource into a signal without a merge strategy"
          ]
        }
      ],
      "exercise": {
        "prompt": "Provide a session context with a user signal and a theme signal, then build a header that reads only the user. Prove that toggling the theme does not re-render the header.",
        "starter": `use leptos::prelude::*;

#[derive(Clone, Copy)]
pub struct Session {
    pub user: RwSignal<Option<String>>,
    pub theme: RwSignal<bool>, // true = dark
}

#[component]
pub fn Header() -> impl IntoView {
    // read only session.user
    todo!()
}`,
        "hint": "Read session.user inside its own closure so the header's effect depends on user alone. A closure that reads both signals subscribes to both, and the theme toggle will re-run it.",
        "solution": `use leptos::prelude::*;

#[derive(Clone, Copy)]
pub struct Session {
    pub user: RwSignal<Option<String>>,
    pub theme: RwSignal<bool>,
}

#[component]
pub fn Root() -> impl IntoView {
    provide_context(Session {
        user: RwSignal::new(Some("ada".to_string())),
        theme: RwSignal::new(true),
    });
    view! { <Header/> <ThemeToggle/> }
}

#[component]
pub fn Header() -> impl IntoView {
    let session = use_context::<Session>().expect("Root provides Session");

    // Only reads user: the theme toggle cannot invalidate this closure.
    let greeting = move || match session.user.get() {
        Some(name) => format!("Signed in as {name}"),
        None => "Signed out".to_string(),
    };

    view! { <header>{greeting}</header> }
}

#[component]
pub fn ThemeToggle() -> impl IntoView {
    let session = use_context::<Session>().expect("Root provides Session");
    view! {
        <button on:click=move |_| session.theme.update(|t| *t = !*t)>
            "Toggle theme"
        </button>
    }
}`
      },
      "production": [
        "Each context value is a signal or a struct of signals, never a snapshot of data.",
        "Resources are keyed by their real inputs so navigation refetches exactly what changed.",
        "Loading and error states are rendered explicitly, not folded into an empty list.",
        "Session state is provided once at the root and never re-created on navigation."
      ],
      "crates": [
        "leptos",
        "serde"
      ],
      "pitfall": "provide_context with a plain struct: children capture the value at mount, the theme toggle appears to do nothing, and the bug is indistinguishable from a CSS problem until you refresh and see the stored value.",
      "questions": [
        {
          "q": "Why does providing a plain struct through context fail to update the UI?",
          "options": [
            "Context values are cloned and compared by pointer",
            "The struct contains no reactive node, so reads never subscribe to anything",
            "Context is only available during SSR",
            "The struct must implement Default"
          ],
          "answer": 1,
          "explain": "Reactivity lives in signals. A plain struct is a value copied into the owner tree; reading its fields is just reading memory, so no dependency is registered and no update is scheduled."
        },
        {
          "q": "What is the cache key of a Resource?",
          "options": [
            "The fetcher's function pointer",
            "The value returned by its source closure",
            "The component's position in the tree",
            "A hash of the serialized response"
          ],
          "answer": 1,
          "explain": "The source closure is re-run when its dependencies change; a different value means a different resource state and triggers a refetch. That makes the source the cache key."
        },
        {
          "q": "A dashboard refetches all data when the theme changes. What is the likely cause?",
          "options": [
            "The theme signal was passed into the resource's source closure",
            "Resources always refetch on any signal write",
            "The server invalidated its cache",
            "Suspense re-runs every resource on re-render"
          ],
          "answer": 0,
          "explain": "If the source closure reads the theme, theme becomes a dependency and every toggle changes the key. Keep unrelated signals out of source closures."
        }
      ],
      "quickbytes": [
        "Context must carry signals; a plain struct is a snapshot and never updates.",
        "The Resource source closure is the cache key — keep unrelated signals out of it.",
        "Match Option<Result<T, E>> explicitly instead of inventing an isLoading boolean.",
        "Optimistic writes live in an overlay signal merged at render, not in the resource."
      ],
      "github": [
        { "name": "leptos-rs/leptos — reactive graph and context", "url": "https://github.com/leptos-rs/leptos" },
        { "name": "DioxusLabs/dioxus — signals and stores implementation", "url": "https://github.com/DioxusLabs/dioxus" }
      ],
      "resources": [
        {
          "title": "leptos::prelude::Resource",
          "url": "https://docs.rs/leptos/latest/leptos/prelude/struct.Resource.html",
          "kind": "docs"
        },
        {
          "title": "leptos crate documentation — reactivity overview",
          "url": "https://docs.rs/leptos/latest/leptos/",
          "kind": "docs"
        },
        {
          "title": "Leptos repository — counters and parent_child context examples",
          "url": "https://github.com/leptos-rs/leptos",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "v10",
      "n": 10,
      "title": "WASM performance: the boundary is the cost centre",
      "minutes": 90,
      "level": "industry",
      "goal": "Profile a wasm frontend, then cut the three things that actually cost frames: boundary crossings, allocations, and forced layout.",
      "sections": [
        {
          "h": "Native speed is not the goal",
          "p": [
            "Compute inside wasm is close to native, but a browser app spends its time elsewhere: marshalling strings, crossing the JS boundary, allocating, and touching layout. The published systematic comparison measured WebAssembly roughly 1.5x slower than native on average, with bounds checks and register pressure as the leading causes — and a dashboard rarely runs that kind of code at all.",
            "So the first question is not how fast wasm is, but how many times per frame you cross the boundary. A chart that reads ten thousand numbers one getter at a time is slow because of ten thousand crossings, not because of the arithmetic. Count the crossings before you count nanoseconds; that number predicts the frame budget far better than any microbenchmark of pure computation."
          ],
          "list": [
            "One crossing per frame beats one crossing per datum",
            "Strings are copied in and out; send bytes or handles instead",
            "serde_json round-trips allocate on both sides — measure before blaming the framework",
            "Layout reads force reflow, and reflow is the expensive part of a render"
          ],
          "tip": "If you cannot name the number of boundary crossings in an interaction, you do not yet know where its time goes."
        },
        {
          "h": "Measure with the platform, not with vibes",
          "p": [
            "performance.mark and performance.measure put your own spans on the same timeline as the browser's work, so a slow render shows up next to the layout it caused. Wrap the suspicious region rather than the whole handler: a 200 ms handler with a 180 ms mark inside it tells you where to look.",
            "The second measurement is data volume. Count the bytes you move per update and the allocations per row. Passing a Float64Array once is one copy; calling a getter per element is N crossings plus N JS number boxes. Both numbers come from the same place: how much data crosses the boundary per interaction."
          ],
          "code": `use wasm_bindgen::prelude::*;

fn perf() -> web_sys::Performance {
    web_sys::window().unwrap().performance().unwrap()
}

pub fn measure<T>(label: &str, f: impl FnOnce() -> T) -> T {
    let p = perf();
    let _ = p.mark(label);
    let out = f();
    let end = format!("{label}-end");
    let _ = p.mark(&end);
    let _ = p.measure_with_start_and_end(label, label, &end);
    out
}

// One copy of N values instead of N boundary crossings.
pub fn p95_from(buf: &js_sys::Float64Array) -> f64 {
    let mut values = buf.to_vec();
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = ((values.len() - 1) as f64 * 0.95).round() as usize;
    values[idx]
}`,
          "list": [
            "Mark the region you are optimizing, not the whole app",
            "Record interactions, not just page load",
            "Compare p95 frame time before and after each change",
            "Only then touch compiler flags"
          ]
        },
        {
          "h": "Build settings and the long tasks you cannot see",
          "p": [
            "Build settings matter, but they are the last lever. opt-level \"z\" or \"s\", fat LTO, codegen-units = 1 and panic = \"abort\" reduce size; wasm-opt -Oz usually takes another slice after that. What they do not do is fix a loop that formats a string per row.",
            "A 200 ms synchronous render blocks input and appears as a long task, and streaming updates make it worse: if every message re-renders the table, the app runs at the speed of its slowest message. Throttle at the source, coalesce into one animation frame, and virtualize beyond a few hundred rows. Those three changes usually beat any flag."
          ],
          "code": `[profile.release]
opt-level = "z"      # size first; use 3 if a hot loop is arithmetic
lto = "fat"
codegen-units = 1
panic = "abort"
strip = true

# Smaller than any flag: remove unused web-sys features.
# Then measure the result, compressed:
#   wasm-opt -Oz -o out.wasm in.wasm
#   twiggy top -n 20 out.wasm
#   brotli -q 11 -c out.wasm | wc -c`,
          "tip": "panic = \"abort\" removes unwinding machinery, but every panic becomes an unrecoverable instance abort — keep the panic hook installed so you still get a message."
        }
      ],
      "exercise": {
        "prompt": "A chart pulls 10,000 samples with a getter per element. Replace it with a single typed-array transfer, then measure both versions with performance.measure and report the difference.",
        "starter": `use wasm_bindgen::prelude::*;

// Slow: one boundary crossing per element.
pub fn sum_slow(get: &js_sys::Function, len: u32) -> f64 {
    todo!()
}

// Fast: one copy, then pure Rust.
pub fn sum_fast(buf: &js_sys::Float64Array) -> f64 {
    todo!()
}`,
        "hint": "For the slow path, call js_sys::Reflect::get with an index and as_f64(). For the fast path, buf.to_vec() copies once; sum in Rust and return a single f64.",
        "solution": `use wasm_bindgen::prelude::*;

pub fn sum_slow(get: &js_sys::Function, len: u32) -> f64 {
    let this = JsValue::NULL;
    let mut total = 0.0;
    for i in 0..len {
        let idx = JsValue::from_f64(i as f64);
        if let Ok(v) = get.call1(&this, &idx) {
            total += v.as_f64().unwrap_or(0.0);
        }
    }
    total
}

pub fn sum_fast(buf: &js_sys::Float64Array) -> f64 {
    // One copy out of the JS heap, then pure Rust arithmetic.
    buf.to_vec().iter().sum()
}

pub fn run_benchmark(samples: &js_sys::Float64Array) {
    let p = web_sys::window().unwrap().performance().unwrap();
    let _ = p.mark("sum-start");
    let total = sum_fast(samples); // swap in sum_slow to reproduce the slow path
    let _ = p.mark("sum-end");
    let _ = p.measure_with_start_and_end("sum", "sum-start", "sum-end");
    web_sys::console::log_1(&JsValue::from_f64(total));
}`
      },
      "production": [
        "A p95 update-latency budget is measured in CI on a throttled profile, not on a developer laptop.",
        "Every list over a few hundred rows is virtualized or paginated.",
        "Streaming updates are coalesced to one render per animation frame.",
        "The release profile pins opt-level, LTO, codegen-units and panic strategy explicitly.",
        "web-sys features are trimmed; the binary is size-checked after wasm-opt, compressed."
      ],
      "crates": [
        "web-sys",
        "wasm-bindgen",
        "js-sys"
      ],
      "pitfall": "Formatting a string per row inside a render loop: the allocation and the boundary copy dominate the frame, and the profiler shows time in the framework rather than in the loop you wrote.",
      "questions": [
        {
          "q": "A chart with 10,000 points is slow. Which change is most likely to help first?",
          "options": [
            "Switching opt-level from \"z\" to 3",
            "Sending the series as one typed array instead of 10,000 getter calls",
            "Enabling fat LTO",
            "Replacing serde_json with bincode"
          ],
          "answer": 1,
          "explain": "Ten thousand boundary crossings and JS number wrappings dominate. One typed-array copy removes both, and it is measurable. Compiler flags rarely recover that kind of overhead."
        },
        {
          "q": "What does panic = \"abort\" change at runtime?",
          "options": [
            "Panics are converted into JS exceptions",
            "Unwinding machinery is removed, so a panic aborts the wasm instance",
            "Panics are logged and execution continues",
            "It disables bounds checks for speed"
          ],
          "answer": 1,
          "explain": "abort removes the unwinding tables and the recovery path. A panic becomes a trap that kills the instance, which is why the panic hook matters for diagnosing it."
        },
        {
          "q": "Which measurement best captures a dashboard's cost?",
          "options": [
            "Time to first byte of the HTML",
            "Total wasm size after gzip",
            "p95 latency from update received to painted frame",
            "Number of components in the tree"
          ],
          "answer": 2,
          "explain": "Dashboards are judged on how quickly a change becomes visible. Load metrics and byte counts matter, but they do not describe the interaction the user repeats all day."
        }
      ],
      "quickbytes": [
        "Count boundary crossings per frame before touching compiler flags.",
        "Send typed arrays, not per-element getter calls: one copy beats N crossings.",
        "Batch DOM writes into one animation frame; reads first, writes second.",
        "Trim web-sys features, then wasm-opt -Oz, then measure compressed bytes."
      ],
      "github": [
        { "name": "rustwasm/twiggy — code size profiler for wasm", "url": "https://github.com/rustwasm/twiggy" },
        { "name": "WebAssembly/binaryen — the wasm-opt optimizer", "url": "https://github.com/WebAssembly/binaryen" }
      ],
      "resources": [
        {
          "title": "Not So Fast: Analyzing the Performance of WebAssembly vs. Native Code (USENIX ATC 2019)",
          "url": "https://www.usenix.org/conference/atc19/presentation/jangda",
          "kind": "paper"
        },
        {
          "title": "wasm-bindgen-futures and js-sys interop",
          "url": "https://docs.rs/wasm-bindgen-futures/latest/wasm_bindgen_futures/",
          "kind": "docs"
        },
        {
          "title": "web-sys Performance API bindings",
          "url": "https://docs.rs/web-sys/latest/web_sys/",
          "kind": "docs"
        },
        {
          "title": "WebAssembly/binaryen repository",
          "url": "https://github.com/WebAssembly/binaryen",
          "kind": "repo"
        },
        {
          "title": "Wasm I/O conference — performance and tooling talks",
          "url": "https://www.youtube.com/@wasmio",
          "kind": "video"
        }
      ]
    },
    {
      "id": "v11",
      "n": 11,
      "title": "Component testing with wasm-bindgen-test",
      "minutes": 85,
      "level": "industry",
      "goal": "Put DOM-dependent Rust under test in a real headless browser, and keep the slow browser loop for the code that actually needs it.",
      "sections": [
        {
          "h": "Three layers, three tools",
          "p": [
            "Pure logic — parsing, aggregation, formatting — compiles for the host and belongs in ordinary #[test] under cargo test. Code that touches the DOM needs a browser, so it uses #[wasm_bindgen_test] with a runner that can drive one. Flows where the point is that a click produces a visible change belong in Playwright against the built app.",
            "The split matters because the browser loop is slow: every run compiles a wasm binary, boots a browser and streams results back. Putting arithmetic there buys nothing, and putting DOM code in a native test does not even compile, because web-sys only exists for wasm targets. Choose the cheapest layer that can observe the behaviour you care about, and push logic downward until a native test can see it."
          ],
          "list": [
            "cargo test for logic with no browser dependency",
            "#[wasm_bindgen_test] for DOM and web API behavior",
            "wasm-pack test --headless --chrome in CI",
            "Playwright for routing, network and accessibility tooling"
          ],
          "tip": "Keep the pure functions in a module with no web-sys imports; then most of your logic is testable at native speed and the browser suite stays small."
        },
        {
          "h": "Writing a browser test",
          "p": [
            "wasm_bindgen_test_configure!(run_in_browser) tells the runner to execute in a real page instead of Node, which is what gives you document and window. From there the test is ordinary Rust: create a host element, set its HTML, query into it, act, assert, and remove it.",
            "Async tests work too: mark the function async and await a promise. That covers fetch, timers and anything else that resolves later, with the same runner and the same output format as synchronous tests. Reach for it when the behaviour under test is a promise, a timer or a network response."
          ],
          "code": `use wasm_bindgen::JsCast;
use wasm_bindgen_test::*;

wasm_bindgen_test_configure!(run_in_browser);

fn mount(html: &str) -> web_sys::Element {
    let document = web_sys::window().unwrap().document().unwrap();
    let host = document.create_element("div").unwrap();
    host.set_inner_html(html);
    document.body().unwrap().append_child(&host).unwrap();
    host
}

#[wasm_bindgen_test]
fn input_value_is_readable() {
    let host = mount(r#"<input id="q" value="kafka"><p id="status"></p>"#);
    let input = host
        .query_selector("#q").unwrap().unwrap()
        .dyn_into::<web_sys::HtmlInputElement>().unwrap();
    let status = host.query_selector("#status").unwrap().unwrap();

    assert_eq!(input.value(), "kafka");
    status.set_text_content(Some("1 match"));
    assert_eq!(status.text_content().unwrap(), "1 match");

    host.remove();
}

#[wasm_bindgen_test]
async fn awaits_a_promise() {
    let promise = js_sys::Promise::resolve(&JsValue::from(42));
    let value = wasm_bindgen_futures::JsFuture::from(promise).await.unwrap();
    assert_eq!(value.as_f64(), Some(42.0));
}`,
          "list": [
            "run_in_browser is required for any DOM assertion",
            "Mount into a fresh host and remove it at the end",
            "Async tests await real promises, not mocked ones",
            "wasm-pack test --headless --firefox runs the same suite elsewhere"
          ]
        },
        {
          "h": "Assert behavior, not internals",
          "p": [
            "Assert what a user or the accessibility tree can observe: text content, attributes, focus, node counts, whether a listener fired. Do not assert on internal signal values or component state — that couples the test to a rendering strategy you will want to change.",
            "Clean up what you mount. A test that appends to document.body and never removes the node leaks state into the next test in the same page, and the resulting failure depends on execution order, which is the worst kind of flake to debug."
          ],
          "tip": "If a component test needs five assertions about internal state, the component is doing too much; extract the logic into a pure function and test that instead."
        }
      ],
      "exercise": {
        "prompt": "Write a browser test that mounts a search input, types into it by setting value and dispatching an input event, and asserts that a status element updates to the number of matching rows.",
        "starter": `use wasm_bindgen_test::*;
use wasm_bindgen::JsCast;

wasm_bindgen_test_configure!(run_in_browser);

#[wasm_bindgen_test]
fn typing_updates_status() {
    // 1. mount <input id="q"> and <p id="status">
    // 2. set the value and dispatch an "input" event
    // 3. assert the status text
}`,
        "hint": "Create the event with web_sys::Event::new(\"input\"), then input.dispatch_event(&event). Handle the event synchronously in the test so no await is needed.",
        "solution": `use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_test::*;

wasm_bindgen_test_configure!(run_in_browser);

#[wasm_bindgen_test]
fn typing_updates_status() {
    let document = web_sys::window().unwrap().document().unwrap();
    let host = document.create_element("div").unwrap();
    host.set_inner_html(r#"<input id="q" value=""><p id="status">3 matches</p>"#);
    document.body().unwrap().append_child(&host).unwrap();

    let input = host
        .query_selector("#q").unwrap().unwrap()
        .dyn_into::<web_sys::HtmlInputElement>().unwrap();
    let status = host.query_selector("#status").unwrap().unwrap();

    let handler = {
        let status = status.clone();
        Closure::<dyn FnMut(web_sys::Event)>::new(move |_ev| {
            status.set_text_content(Some("1 match"));
        })
    };
    input
        .add_event_listener_with_callback("input", handler.as_ref().unchecked_ref())
        .unwrap();

    input.set_value("kafka");
    let event = web_sys::Event::new("input").unwrap();
    input.dispatch_event(&event).unwrap();

    assert_eq!(status.text_content().unwrap(), "1 match");
    drop(handler);
    host.remove();
}`
      },
      "production": [
        "The browser suite is small and targeted; pure logic is covered by native cargo test.",
        "CI runs wasm-pack test headless with a pinned browser version.",
        "Every mounted host element is removed at the end of its test.",
        "Tests assert observable output, not framework internals."
      ],
      "crates": [
        "wasm-bindgen-test",
        "wasm-bindgen",
        "web-sys",
        "js-sys"
      ],
      "pitfall": "Running DOM tests in the default Node runner: querySelector returns null or the test file fails to instantiate, and the failure looks like a broken component rather than a missing browser.",
      "questions": [
        {
          "q": "What does wasm_bindgen_test_configure!(run_in_browser) change?",
          "options": [
            "It compiles the test for wasm32-wasi",
            "It makes the runner execute the test in a real browser page with DOM access",
            "It enables async test support",
            "It mocks window and document in Node"
          ],
          "answer": 1,
          "explain": "The macro configures the harness to launch a browser instead of the Node runner. Without it, DOM APIs are absent and querySelector cannot work."
        },
        {
          "q": "Why keep arithmetic out of the browser suite?",
          "options": [
            "wasm cannot represent floating point exactly",
            "The browser runner is much slower per test than a native cargo test",
            "wasm-bindgen-test forbids non-DOM assertions",
            "Native tests cannot call wasm-exported functions"
          ],
          "answer": 1,
          "explain": "Every browser run compiles a wasm binary and boots a browser. Pure functions run in milliseconds natively, so the browser suite should be reserved for code that genuinely needs a DOM."
        },
        {
          "q": "A test mounts a host element and never removes it. What is the risk?",
          "options": [
            "The wasm instance leaks memory across runs",
            "Later tests in the same page see leftover DOM and fail order-dependently",
            "The runner refuses to report results",
            "Closures stop being collected"
          ],
          "answer": 1,
          "explain": "Tests share one page. Leftover nodes make selectors ambiguous and results depend on execution order, producing flakes that only reproduce in a full run."
        }
      ],
      "quickbytes": [
        "run_in_browser for DOM, plain cargo test for logic — split the suite, not the assertions.",
        "Mount into a detached host, remove it at the end; do not touch body directly.",
        "Async #[wasm_bindgen_test] functions await real promises without extra setup.",
        "wasm-pack test --headless --chrome is the CI entry point; pin the browser version."
      ],
      "github": [
        { "name": "wasm-bindgen/wasm-bindgen — wasm-bindgen-test lives in crates/test", "url": "https://github.com/wasm-bindgen/wasm-bindgen" },
        { "name": "dequelabs/axe-core — accessibility assertions for the e2e layer", "url": "https://github.com/dequelabs/axe-core" }
      ],
      "resources": [
        {
          "title": "wasm-bindgen-test crate documentation",
          "url": "https://docs.rs/wasm-bindgen-test/latest/wasm_bindgen_test/",
          "kind": "docs"
        },
        {
          "title": "wasm-bindgen-futures — awaiting promises in tests",
          "url": "https://docs.rs/wasm-bindgen-futures/latest/wasm_bindgen_futures/",
          "kind": "docs"
        },
        {
          "title": "wasm-bindgen repository — test runner sources",
          "url": "https://github.com/wasm-bindgen/wasm-bindgen",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "v12",
      "n": 12,
      "title": "Bundling: Trunk, wasm-opt and a size budget",
      "minutes": 80,
      "level": "industry",
      "goal": "Wire the four-stage wasm build, hash the assets, and put a compressed-size budget in CI so the bundle cannot creep.",
      "sections": [
        {
          "h": "Four stages, one directory",
          "p": [
            "A wasm frontend build is four steps, and each is replaceable. cargo builds the cdylib for wasm32-unknown-unknown, wasm-bindgen generates the JS glue, wasm-opt shrinks and optimizes the binary, and a bundler fingerprints and copies assets into dist. Trunk drives all four from an index.html that declares assets with data-trunk links.",
            "Frameworks ship their own orchestrator — cargo-leptos for Leptos, dx for Dioxus — but the stages are the same. Knowing them is what lets you debug a blank page: open the generated index.html, check that the wasm URL resolves, and confirm the MIME type the server returns."
          ],
          "code": `<!-- index.html -->
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>Ops dashboard</title>
    <link data-trunk rel="css" href="styles/app.css"/>
    <link data-trunk rel="rust" data-wasm-opt="z"/>
  </head>
  <body></body>
</html>

# Trunk.toml
[build]
target = "index.html"
dist = "dist"
release = true

[serve]
addresses = ["127.0.0.1"]
port = 8080`,
          "tip": "data-wasm-opt=\"z\" asks Trunk to run wasm-opt at size priority; drop the attribute while debugging, because optimized output is much harder to read in a profiler."
        },
        {
          "h": "A budget is a test",
          "p": [
            "A size budget is only real if it fails a build. Build in release, compress with brotli, compare against a committed number, and exit non-zero above it. Without that, sizes creep by tens of kilobytes per feature and nobody notices until mobile users on a slow connection do.",
            "Track the wasm and the JS separately. A growing glue file usually means duplicated bindings or two wasm-bindgen versions in the dependency graph; cargo tree -i wasm-bindgen finds the second copy, and two copies both ship and both register types. Size regressions are rarely one big dependency; they are five small ones plus a duplicated binding crate, which is why the number must be tracked rather than eyeballed."
          ],
          "code": `# .github/workflows/ci.yml (excerpt)
- name: build
  run: trunk build --release

- name: size budget
  run: |
    set -euo pipefail
    WASM=$(ls dist/*.wasm | head -1)
    JS=$(ls dist/*.js | head -1)
    W=$(brotli -q 11 -c "$WASM" | wc -c | tr -d ' ')
    J=$(brotli -q 11 -c "$JS" | wc -c | tr -d ' ')
    echo "wasm $W bytes (budget 180000), js $J bytes (budget 60000)"
    test "$W" -le 180000
    test "$J" -le 60000`,
          "list": [
            "Budget the compressed bytes, because that is what users download",
            "Fail the build, do not warn; warnings are ignored within a sprint",
            "Check for duplicate wasm-bindgen versions before chasing code size",
            "Record the number in the PR so reviewers see the delta"
          ]
        },
        {
          "h": "Hashing and cache headers",
          "p": [
            "Trunk fingerprints asset names in release builds, so a new deploy cannot serve an old wasm under a cached URL. Keep that behaviour: disabling it for prettier filenames is exactly how you get a bug report that only reproduces before a hard refresh.",
            "Serve the hashed assets with a long immutable cache and the HTML with no-cache. The HTML is the manifest pointing at those assets, so it must revalidate; everything it points at can be cached forever. That split is the whole caching strategy for a static app, and it is what stops a new deploy from serving mixed versions."
          ],
          "list": [
            "Content-hashed filenames for wasm, js and css",
            "Cache-Control: public, max-age=31536000, immutable for hashed assets",
            "Cache-Control: no-cache for index.html",
            "Content-Type: application/wasm for the binary"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a CI step that builds the app, computes the brotli-compressed size of the wasm, prints it, and fails above a budget you choose. Then explain what you would check first if the number jumped by 40 KB in one PR.",
        "starter": `# 1. build
# 2. find the wasm
# 3. compress and count bytes
# 4. compare against a budget`,
        "hint": "brotli -q 11 -c file | wc -c gives the compressed size; set -euo pipefail makes any failing command abort the step. For the jump, check cargo tree -i wasm-bindgen and the diff in web-sys features.",
        "solution": `#!/usr/bin/env bash
set -euo pipefail

BUDGET=\${BUDGET:-180000}

trunk build --release

WASM=$(find dist -maxdepth 1 -name '*.wasm' | head -1)
if [ -z "$WASM" ]; then
  echo "no wasm produced" >&2
  exit 1
fi

BYTES=$(brotli -q 11 -c "$WASM" | wc -c | tr -d ' ')
echo "compressed wasm: $BYTES bytes (budget $BUDGET)"

if [ "$BYTES" -gt "$BUDGET" ]; then
  echo "size budget exceeded by $((BYTES - BUDGET)) bytes" >&2
  # First checks: duplicate wasm-bindgen versions, new web-sys features,
  # a dependency that pulled in std formatting or regex.
  cargo tree -i wasm-bindgen || true
  exit 1
fi`
      },
      "production": [
        "The size budget runs on every PR and blocks merges, not just reports.",
        "Release builds are fingerprinted; HTML is served no-cache.",
        "Only one wasm-bindgen version exists in the dependency graph.",
        "wasm-opt runs in CI with a pinned binaryen version, not a developer's local copy.",
        "The wasm is served as application/wasm with immutable caching."
      ],
      "crates": [
        "wasm-bindgen",
        "web-sys",
        "wasm-opt"
      ],
      "pitfall": "Building with trunk serve in release-like mode locally and never checking the compressed size: the app grows past a megabyte of wasm, and the first person to notice is a user on a mobile connection.",
      "questions": [
        {
          "q": "Which stage turns the Rust cdylib into something a browser can call with strings and objects?",
          "options": [
            "cargo build --target wasm32-unknown-unknown",
            "wasm-bindgen, which generates the JS glue and marshalling",
            "wasm-opt, which optimizes the binary",
            "The bundler, which fingerprints asset names"
          ],
          "answer": 1,
          "explain": "rustc emits raw wasm with numeric exports. wasm-bindgen reads those signatures and generates the JavaScript that allocates strings, converts objects and exposes a usable API."
        },
        {
          "q": "Why budget compressed rather than raw bytes?",
          "options": [
            "Compression is applied before the wasm is compiled",
            "The compressed size is what users actually download over the network",
            "Raw sizes are not reproducible between machines",
            "Brotli changes the runtime behaviour of the module"
          ],
          "answer": 1,
          "explain": "Transfer size is the user-visible cost. Raw size is still useful for spotting code growth, but the budget should track the bytes on the wire."
        },
        {
          "q": "Your bundle grew 40 KB after adding a date field. What do you check first?",
          "options": [
            "Whether the server enabled gzip",
            "Whether a second wasm-bindgen version or a heavy dependency entered the graph",
            "Whether the browser cache is disabled",
            "Whether the wasm MIME type is correct"
          ],
          "answer": 1,
          "explain": "A small feature that adds tens of kilobytes usually pulled in a duplicate binding version or a dependency with formatting, regex or chrono-style data. cargo tree answers it in seconds."
        }
      ],
      "quickbytes": [
        "trunk build --release then brotli -q 11 -c is the number that matters.",
        "cargo tree -i wasm-bindgen finds duplicate glue versions, which double-ship symbols.",
        "Content-hash the wasm and cache it immutably; keep index.html revalidating.",
        "Pin the binaryen/wasm-opt version in CI so output is reproducible."
      ],
      "github": [
        { "name": "trunk-rs/trunk", "url": "https://github.com/trunk-rs/trunk" },
        { "name": "WebAssembly/binaryen", "url": "https://github.com/WebAssembly/binaryen" }
      ],
      "resources": [
        {
          "title": "WebAssembly/binaryen — wasm-opt and friends",
          "url": "https://github.com/WebAssembly/binaryen",
          "kind": "repo"
        },
        {
          "title": "Trunk repository — build pipeline and configuration",
          "url": "https://github.com/trunk-rs/trunk",
          "kind": "repo"
        },
        {
          "title": "wasm-bindgen guide — build targets and output layout",
          "url": "https://wasm-bindgen.github.io/wasm-bindgen/",
          "kind": "docs"
        },
        {
          "title": "MDN: WebAssembly concepts — loading and caching",
          "url": "https://developer.mozilla.org/en-US/docs/WebAssembly/Concepts",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "v13",
      "n": 13,
      "title": "wasm-pack: from crate to npm package",
      "minutes": 70,
      "level": "advanced",
      "goal": "Pick the right build target, read the generated package, and decide when a wasm crate should be published rather than vendored.",
      "sections": [
        {
          "h": "Targets decide who can consume it",
          "p": [
            "wasm-pack runs the build and packages the result as an npm package. The --target flag decides what the generated JavaScript looks like: web expects an explicit init() call and works in a plain module script, bundler emits ESM imports of the .wasm that webpack and Vite understand, and nodejs emits CommonJS that loads the binary synchronously.",
            "Choosing the wrong one is the classic failure. --target bundler in a hand-written script fails because browsers cannot import a .wasm file as a module; --target web in a bundler works but requires the loader to fetch the binary itself. Decide by who imports the package, not by which one you tried first. That decision is much easier to make before the package exists than after a consumer reports a cryptic module-resolution error."
          ],
          "code": `# Produce a browser package with an async init().
wasm-pack build --release --target web --out-dir pkg --out-name dashboard

# What you actually ship:
ls pkg
# dashboard.js       ESM glue with init()
# dashboard_bg.wasm  the module itself
# dashboard.d.ts     generated TypeScript types
# package.json       module/types/files entries

# Run the browser test suite headless.
wasm-pack test --headless --chrome

# Cargo.toml metadata wasm-pack uses
# [package]
# description = "Ops dashboard rendered in Rust"
# license = "MIT OR Apache-2.0"
# repository = "https://github.com/acme/dashboard"
#
# [lib]
# crate-type = ["cdylib", "rlib"]`,
          "tip": "Keep rlib in crate-type: it lets cargo test run your pure logic natively while cdylib produces the wasm artifact."
        },
        {
          "h": "Consuming the package",
          "p": [
            "init() resolves once the wasm is instantiated, so every exported symbol must be used after that await. With --target web, init optionally takes a URL or Request, which is how you point at a CDN, a hashed filename, or a copy served from a different path.",
            "The generated .d.ts is part of the contract. Review it in the same diff as the Rust change: a Struct field that becomes Option<T> changes the TypeScript type, and a consumer's build should fail rather than silently pass undefined. Treat that file as generated API: diff it, review it, never hand-edit it."
          ],
          "code": `import init, { Dashboard } from "./pkg/dashboard.js";

// 1. Instantiate before touching any export.
await init();

const dashboard = new Dashboard();
dashboard.push(12.5);
dashboard.push(31.0);
console.log(dashboard.snapshot()); // { samples: 2, p95_ms: 31 }

// JS has no destructor for the Rust value.
dashboard.free();`,
          "list": [
            "init() is async; nothing exported works before it resolves",
            "Pass an explicit URL when the wasm lives under a hashed name",
            "Always call free() on handles you create",
            "Treat the generated .d.ts as public API"
          ]
        },
        {
          "h": "Publish, or vendor?",
          "p": [
            "wasm-pack publish uploads the generated package, and the registry rejects it without description, license and repository in Cargo.toml. Both the crate version and the wasm-bindgen version are part of the public contract: a consumer taking a new minor gets a different glue ABI, so pin tightly.",
            "For an application you rarely publish. Build pkg/ in CI, treat it as an artifact with a content hash, and deploy it with the app. Publishing is for libraries other teams import, and semver then covers the JS wrapper as well as the Rust API."
          ],
          "list": [
            "Pin wasm-bindgen exactly; the CLI must match the crate",
            "Publish only files listed in package.json files[]",
            "Bump the minor version when the exported API or .d.ts changes",
            "Vendor the pkg/ artifact for apps; publish for libraries"
          ]
        }
      ],
      "exercise": {
        "prompt": "Take a crate with a Counter struct and produce a web-target package. Write the JavaScript that imports it, instantiates it, increments twice, reads the value and frees the handle.",
        "starter": `# 1. build for the web target with an out-dir and out-name
# 2. write the JS that awaits init()

import init, { Counter } from "./pkg/counter.js";`,
        "hint": "The generated default export is the init function; named exports are your #[wasm_bindgen] items. Nothing works before await init() resolves.",
        "solution": `# Build
wasm-pack build --release --target web --out-dir pkg --out-name counter

// main.js
import init, { Counter } from "./pkg/counter.js";

await init(); // fetches and instantiates counter_bg.wasm

const counter = new Counter();
counter.increment();
counter.increment();

console.log(counter.value); // 2
counter.free();

// Rust side that this consumes:
//
// #[wasm_bindgen]
// pub struct Counter { value: u32 }
//
// #[wasm_bindgen]
// impl Counter {
//     #[wasm_bindgen(constructor)]
//     pub fn new() -> Counter { Counter { value: 0 } }
//
//     pub fn increment(&mut self) { self.value += 1; }
//
//     #[wasm_bindgen(getter)]
//     pub fn value(&self) -> u32 { self.value }
// }`
      },
      "production": [
        "The target matches the consumer: web for script tags, bundler for Vite/webpack, nodejs for CommonJS.",
        "Cargo.toml carries description, license and repository before the first publish.",
        "The generated .d.ts is reviewed with the Rust diff for breaking changes.",
        "Handles created in app code are freed deterministically, not left to the collector."
      ],
      "crates": [
        "wasm-bindgen",
        "wasm-pack",
        "serde",
        "serde-wasm-bindgen"
      ],
      "pitfall": "Publishing a --target bundler package that a consumer loads with a plain module script: the browser tries to import the .wasm as a module and fails with a MIME or module-resolution error that points nowhere near the flag.",
      "questions": [
        {
          "q": "What is the difference between --target web and --target bundler?",
          "options": [
            "web produces a WASI module; bundler produces a browser module",
            "web exposes an explicit async init(); bundler emits ESM .wasm imports for the bundler to resolve",
            "web is for Node; bundler is for browsers",
            "They differ only in the output filename"
          ],
          "answer": 1,
          "explain": "The web target expects you to call init() yourself, so it works with plain script modules. The bundler target hands wasm resolution to webpack or Vite, which browsers cannot do natively."
        },
        {
          "q": "Why does every exported call need to wait for init()?",
          "options": [
            "The JS wrappers are generated lazily on first call",
            "The wasm instance and its heap table do not exist until instantiation resolves",
            "init() downloads the TypeScript definitions",
            "init() registers the service worker"
          ],
          "answer": 1,
          "explain": "Exports call into an instance that init() creates. Before it resolves, the glue has no memory or object table, so calls fail or throw."
        },
        {
          "q": "When is publishing with wasm-pack the right call?",
          "options": [
            "For every application, so deploys are reproducible",
            "When another team will import the package and needs semver plus generated types",
            "Only when the crate has no wasm-bindgen exports",
            "Whenever the wasm is larger than 1 MB"
          ],
          "answer": 1,
          "explain": "Publishing creates a public contract: version, glue ABI, TypeScript surface. Applications should vendor a built artifact; libraries that others import are the case where a registry package earns its cost."
        }
      ],
      "quickbytes": [
        "wasm-pack build --target web --out-name app gives you init() plus named exports.",
        "Nothing works before await init(); the instance does not exist yet.",
        "Keep crate-type = [\"cdylib\", \"rlib\"] so native cargo test still runs.",
        "The .d.ts is public API — review it when a Rust signature changes."
      ],
      "github": [
        { "name": "wasm-bindgen/wasm-pack", "url": "https://github.com/wasm-bindgen/wasm-pack" },
        { "name": "wasm-bindgen/wasm-bindgen", "url": "https://github.com/wasm-bindgen/wasm-bindgen" }
      ],
      "resources": [
        {
          "title": "wasm-pack repository — targets, tests and publishing",
          "url": "https://github.com/wasm-bindgen/wasm-pack",
          "kind": "repo"
        },
        {
          "title": "wasm-bindgen crate documentation",
          "url": "https://docs.rs/wasm-bindgen/latest/wasm_bindgen/",
          "kind": "docs"
        },
        {
          "title": "serde-wasm-bindgen for structured payloads",
          "url": "https://docs.rs/serde-wasm-bindgen/latest/serde_wasm_bindgen/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "v14",
      "n": 14,
      "title": "Web Workers: moving work off the main thread",
      "minutes": 90,
      "level": "industry",
      "goal": "Spawn a worker with its own wasm instance, exchange owned data by message, and know what shared memory actually requires.",
      "sections": [
        {
          "h": "The main thread has a deadline",
          "p": [
            "The main thread runs your wasm, the framework's event handlers, style, layout and paint. A long task there delays input and shows up as a dropped frame. A worker gives you a second thread with its own event loop and its own wasm instance: no shared memory by default, and communication only through messages.",
            "That last part is the design constraint. postMessage serializes with the structured clone algorithm, so typed arrays, plain objects, Map, Blob and ArrayBuffer travel, while functions and DOM nodes do not. Transferring an ArrayBuffer moves ownership instead of copying it, which matters once buffers reach megabytes."
          ],
          "list": [
            "A worker has no window and no document; DOM access is impossible",
            "Each worker instantiates its own module and pays its own memory",
            "Structured clone copies; transfer lists move ownership",
            "Worker startup is asynchronous, so message handling must tolerate a warm-up"
          ]
        },
        {
          "h": "Spawning and messaging from Rust",
          "p": [
            "Worker::new_with_options with WorkerType::Module loads an ES module worker, which is what lets the worker script import the wasm glue. Attach the message handler with set_onmessage and keep the closure alive in the struct that owns the worker, exactly as with any other listener.",
            "Send small control messages as strings and bulk data as typed arrays. Reconstructing a Rust type on the other side with serde is convenient for control paths; for hot paths, agree on a binary layout and hand over an ArrayBuffer instead."
          ],
          "code": `use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::{Worker, WorkerOptions, WorkerType};

pub struct Aggregator {
    worker: Worker,
    on_message: Closure<dyn FnMut(web_sys::MessageEvent)>,
}

impl Aggregator {
    pub fn spawn(script: &str) -> Result<Self, JsValue> {
        let options = WorkerOptions::new();
        options.set_type(WorkerType::Module);
        let worker = Worker::new_with_options(script, &options)?;

        let on_message = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(
            move |event: web_sys::MessageEvent| {
                if let Some(text) = event.data().as_string() {
                    leptos::logging::log!("worker: {text}");
                }
            },
        );
        worker.set_onmessage(Some(on_message.as_ref().unchecked_ref()));

        Ok(Self { worker, on_message })
    }

    pub fn send(&self, text: &str) -> Result<(), JsValue> {
        self.worker.post_message(&JsValue::from_str(text))
    }

    pub fn terminate(self) {
        self.worker.terminate();
    }
}`,
          "tip": "Call terminate() instead of dropping the Worker: a dropped handle does not stop the thread, and the worker keeps receiving messages nobody handles."
        },
        {
          "h": "Shared memory is a different tier",
          "p": [
            "The threads proposal adds SharedArrayBuffer and atomics, and browsers only expose them on cross-origin-isolated pages. That means Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp on every response, plus a build with the atomics target features. No headers, no SharedArrayBuffer, regardless of what the Rust code does.",
            "wasm-bindgen-rayon builds a Rayon thread pool on top of that, so par_iter can run across workers inside one wasm module. It is genuinely useful for CPU-bound work and it is a commitment: every page that loads the module must be isolated from cross-origin resources, and every dependency must be built for the atomics target."
          ],
          "code": `# 1. Build for atomics (build-std requires a nightly toolchain).
RUSTFLAGS='-C target-feature=+atomics,+bulk-memory,+mutable-globals' \\
  cargo build --target wasm32-unknown-unknown --release \\
  -Z build-std=std,panic_abort

# 2. The server must send both headers on every response,
#    including the worker script and the wasm binary:
#    Cross-Origin-Opener-Policy: same-origin
#    Cross-Origin-Embedder-Policy: require-corp

# 3. Verify before shipping: in the console,
#    typeof SharedArrayBuffer === "object"  // false means no isolation`,
          "list": [
            "COOP and COEP are all-or-nothing; one missing response disables isolation",
            "Third-party embeds that lack CORP headers will break",
            "A worker still cannot touch the DOM, threads or not",
            "Measure before adopting threads: most UI jank is layout, not compute"
          ]
        }
      ],
      "exercise": {
        "prompt": "Spawn a module worker, send it a JSON string, and log the reply. Keep the worker and its message closure alive in a struct, and terminate it explicitly.",
        "starter": `use wasm_bindgen::prelude::*;
use web_sys::Worker;

pub struct Client {
    // worker + closure
}

impl Client {
    pub fn spawn(url: &str) -> Result<Self, JsValue> {
        // WorkerOptions with WorkerType::Module
        todo!()
    }

    pub fn send(&self, msg: &str) -> Result<(), JsValue> {
        todo!()
    }
}`,
        "hint": "set_onmessage takes Option<&Function>, and the closure must live in the struct or it is dropped as soon as spawn returns.",
        "solution": `use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::{Worker, WorkerOptions, WorkerType};

pub struct Client {
    worker: Worker,
    on_message: Closure<dyn FnMut(web_sys::MessageEvent)>,
}

impl Client {
    pub fn spawn(url: &str) -> Result<Self, JsValue> {
        let options = WorkerOptions::new();
        options.set_type(WorkerType::Module);
        let worker = Worker::new_with_options(url, &options)?;

        let on_message = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(
            move |event: web_sys::MessageEvent| {
                let data = event.data();
                if let Some(text) = data.as_string() {
                    web_sys::console::log_1(&JsValue::from_str(&format!("reply: {text}")));
                }
            },
        );
        worker.set_onmessage(Some(on_message.as_ref().unchecked_ref()));

        Ok(Self { worker, on_message })
    }

    pub fn send(&self, msg: &str) -> Result<(), JsValue> {
        self.worker.post_message(&JsValue::from_str(msg))
    }

    pub fn shutdown(self) {
        self.worker.terminate();
    }
}

// worker.js
// self.onmessage = async (ev) => {
//   const { default: init, aggregate } = await import("./pkg/app.js");
//   await init();
//   self.postMessage(JSON.stringify(aggregate(ev.data)));
// };`
      },
      "production": [
        "Workers are terminated explicitly; no orphan thread keeps processing after unmount.",
        "Bulk data crosses as typed arrays or transferred buffers, not per-element messages.",
        "Any SharedArrayBuffer usage is gated on COOP/COEP headers verified in CI.",
        "The worker's wasm download is budgeted separately from the main module."
      ],
      "crates": [
        "web-sys",
        "wasm-bindgen",
        "wasm-bindgen-rayon"
      ],
      "pitfall": "Using window() inside a worker module: the worker global scope has no window, so the call returns None or throws, and the panic surfaces as an unhandled error with no stack pointing at your code.",
      "questions": [
        {
          "q": "What happens to an ArrayBuffer listed in a postMessage transfer list?",
          "options": [
            "It is copied, and both sides keep a valid buffer",
            "Ownership moves to the receiver, and the sender's buffer becomes detached",
            "It is serialized to JSON automatically",
            "It is placed in shared memory for both threads"
          ],
          "answer": 1,
          "explain": "Transferring avoids the copy by moving ownership. The sender's ArrayBuffer becomes detached, so writing to it afterwards throws or yields a zero-length buffer."
        },
        {
          "q": "Which capability is genuinely unavailable inside a dedicated worker?",
          "options": [
            "fetch()",
            "WebAssembly instantiation",
            "Reading document.cookie",
            "setTimeout"
          ],
          "answer": 2,
          "explain": "Workers have no document. fetch, wasm and timers are all available; DOM and cookie access are not, which is why worker-side code must not share components with the UI."
        },
        {
          "q": "You enable threads but SharedArrayBuffer is undefined in the page. Why?",
          "options": [
            "The wasm module was built without bulk-memory",
            "The page is not cross-origin isolated, so the headers are missing or incomplete",
            "The worker was created without WorkerType::Module",
            "SharedArrayBuffer requires --target bundler"
          ],
          "answer": 1,
          "explain": "Browsers gate SharedArrayBuffer behind COOP: same-origin plus COEP: require-corp on every response. The Rust build can be perfect and the API still stays hidden."
        }
      ],
      "quickbytes": [
        "No window, no document in a worker: keep UI code out of worker modules.",
        "Terminate workers explicitly; dropping the handle does not stop the thread.",
        "Transfer ArrayBuffers instead of copying multi-megabyte payloads.",
        "SharedArrayBuffer needs COOP + COEP on every response, not just the HTML."
      ],
      "github": [
        { "name": "GoogleChromeLabs/wasm-bindgen-rayon", "url": "https://github.com/GoogleChromeLabs/wasm-bindgen-rayon" },
        { "name": "wasm-bindgen/wasm-bindgen — Worker bindings live in web-sys", "url": "https://github.com/wasm-bindgen/wasm-bindgen" }
      ],
      "resources": [
        {
          "title": "web_sys::Worker",
          "url": "https://docs.rs/web-sys/latest/web_sys/struct.Worker.html",
          "kind": "docs"
        },
        {
          "title": "MDN: Using Web Workers",
          "url": "https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers",
          "kind": "docs"
        },
        {
          "title": "wasm-bindgen-rayon crate documentation",
          "url": "https://docs.rs/wasm-bindgen-rayon/latest/wasm_bindgen_rayon/",
          "kind": "docs"
        },
        {
          "title": "wasm-bindgen-rayon repository — isolation requirements",
          "url": "https://github.com/GoogleChromeLabs/wasm-bindgen-rayon",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "v15",
      "n": 15,
      "title": "Canvas and WebGL: drawing from Rust",
      "minutes": 90,
      "level": "industry",
      "goal": "Render a high-density chart on a canvas at the correct device pixel ratio, and keep the animation loop allocation-free.",
      "sections": [
        {
          "h": "Canvas is a surface, not a DOM tree",
          "p": [
            "A canvas is a bitmap you draw into: get a context, issue draw calls, let the browser composite. That makes it right for charts with thousands of points and wrong for anything needing selection, selectable text or CSS styling. Whatever you draw is invisible to the accessibility tree unless you mirror it elsewhere.",
            "Device pixel ratio is the first bug. A canvas sized in CSS pixels looks blurry on a high-density display. Set canvas.width to css_width * dpr, keep the CSS size fixed, and scale the context by dpr so drawing code can keep working in CSS units. Get this wrong and every line looks soft on a retina screen while the code, the data and the layout are all correct."
          ],
          "code": `use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::{CanvasRenderingContext2d, HtmlCanvasElement};

pub fn draw_sparkline(canvas: &HtmlCanvasElement, values: &[f64]) -> Result<(), JsValue> {
    let dpr = web_sys::window().unwrap().device_pixel_ratio();
    let css_w = canvas.client_width() as f64;
    let css_h = canvas.client_height() as f64;

    canvas.set_width((css_w * dpr) as u32);
    canvas.set_height((css_h * dpr) as u32);

    let ctx = canvas
        .get_context("2d")?
        .ok_or("no 2d context")?
        .dyn_into::<CanvasRenderingContext2d>()?;

    ctx.scale(dpr, dpr)?;
    ctx.clear_rect(0.0, 0.0, css_w, css_h);

    let max = values.iter().copied().fold(f64::MIN, f64::max).max(1.0);
    let span = (values.len().max(2) - 1) as f64;

    ctx.set_stroke_style_str("#4ade80");
    ctx.set_line_width(2.0);
    ctx.begin_path();
    for (i, v) in values.iter().enumerate() {
        let x = (i as f64 / span) * css_w;
        let y = css_h - (v / max) * css_h;
        if i == 0 {
            ctx.move_to(x, y);
        } else {
            ctx.line_to(x, y);
        }
    }
    ctx.stroke();
    Ok(())
}`,
          "tip": "Re-setting canvas.width clears the bitmap and resets the transform; do it on resize only, not on every frame."
        },
        {
          "h": "WebGL is a state machine with silent failures",
          "p": [
            "WebGL means compiling shaders, linking a program, uploading buffers, setting uniforms and drawing. web-sys exposes WebGlRenderingContext and WebGl2RenderingContext, but the code is verbose and failures are quiet: a shader that fails to compile returns null, and the reason is only in get_shader_info_log. That silence defines the API: nothing throws, and a black canvas is the only symptom.",
            "Write a small helper that compiles, checks, and returns Result with the log attached. That single function saves hours, because the alternative is a black canvas and no message. It pays for itself the first time a shader fails at 2 a.m., when the only other signal is a black rectangle. Write it before any drawing code."
          ],
          "code": `pub fn compile_shader(
    gl: &web_sys::WebGl2RenderingContext,
    kind: u32,
    source: &str,
) -> Result<web_sys::WebGlShader, String> {
    let shader = gl.create_shader(kind).ok_or("create_shader failed")?;
    gl.shader_source(&shader, source);
    gl.compile_shader(&shader);

    if gl
        .get_shader_parameter(&shader, web_sys::WebGl2RenderingContext::COMPILE_STATUS)
        .as_bool()
        .unwrap_or(false)
    {
        Ok(shader)
    } else {
        Err(gl
            .get_shader_info_log(&shader)
            .unwrap_or_else(|| "unknown shader error".to_string()))
    }
}

pub fn link_program(
    gl: &web_sys::WebGl2RenderingContext,
    vs: &web_sys::WebGlShader,
    fs: &web_sys::WebGlShader,
) -> Result<web_sys::WebGlProgram, String> {
    let program = gl.create_program().ok_or("create_program failed")?;
    gl.attach_shader(&program, vs);
    gl.attach_shader(&program, fs);
    gl.link_program(&program);
    if gl
        .get_program_parameter(&program, web_sys::WebGl2RenderingContext::LINK_STATUS)
        .as_bool()
        .unwrap_or(false)
    {
        Ok(program)
    } else {
        Err(gl.get_program_info_log(&program).unwrap_or_default())
    }
}`,
          "list": [
            "Always check COMPILE_STATUS and LINK_STATUS",
            "Report the info log with the shader source line numbers",
            "Cache programs and buffers; do not rebuild per frame",
            "WebGL2 constants live on WebGl2RenderingContext"
          ]
        },
        {
          "h": "The frame loop, and what you owe accessibility",
          "p": [
            "Animation belongs in requestAnimationFrame: the callback runs before paint, receives a timestamp, and pauses in background tabs. Keep per-frame allocations at zero by reusing buffers, avoiding format! inside the loop, and never reading layout mid-frame. One rAF loop for the page also stops three widgets from each scheduling their own frame work.",
            "For new GPU work, wgpu is often the better bet: one API over WebGPU and native backends, typed pipelines, and validation errors that say what is wrong. It is heavier, and WebGPU is not universally available, so a fallback is part of the design. Either way, a canvas chart needs a text alternative: a summary sentence, and a data table in the DOM when users must inspect values."
          ],
          "list": [
            "One rAF callback drives all animation in the frame",
            "The timestamp argument is the only clock you need",
            "Canvas content is invisible to screen readers — mirror the data",
            "Provide keyboard access to any value a mouse can inspect"
          ],
          "tip": "If a chart must be accessible and has fewer than a few hundred points, an SVG or HTML table may beat canvas on every axis including effort."
        }
      ],
      "exercise": {
        "prompt": "Draw a bar chart on a canvas at the right device pixel ratio, then describe the two DOM elements you would add so the same data is available to a screen reader.",
        "starter": `use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

pub fn draw_bars(canvas: &HtmlCanvasElement, values: &[f64]) -> Result<(), JsValue> {
    // 1. size for devicePixelRatio
    // 2. get the 2d context and scale
    // 3. draw one filled rect per value
    todo!()
}`,
        "hint": "set_fill_style_str picks the colour; fill_rect(x, y, w, h) draws in CSS units once the context is scaled by dpr. For accessibility, a <table> with the same numbers plus an aria-label or a visually-hidden summary is enough.",
        "solution": `use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::{CanvasRenderingContext2d, HtmlCanvasElement};

pub fn draw_bars(canvas: &HtmlCanvasElement, values: &[f64]) -> Result<(), JsValue> {
    let dpr = web_sys::window().unwrap().device_pixel_ratio();
    let css_w = canvas.client_width() as f64;
    let css_h = canvas.client_height() as f64;
    canvas.set_width((css_w * dpr) as u32);
    canvas.set_height((css_h * dpr) as u32);

    let ctx = canvas
        .get_context("2d")?
        .ok_or("no 2d context")?
        .dyn_into::<CanvasRenderingContext2d>()?;
    ctx.scale(dpr, dpr)?;
    ctx.clear_rect(0.0, 0.0, css_w, css_h);

    if values.is_empty() {
        return Ok(());
    }

    let max = values.iter().copied().fold(f64::MIN, f64::max).max(1.0);
    let slot = css_w / values.len() as f64;
    let gap = (slot * 0.2).min(6.0);

    ctx.set_fill_style_str("#60a5fa");
    for (i, v) in values.iter().enumerate() {
        let h = (v / max) * (css_h - 4.0);
        let x = i as f64 * slot + gap / 2.0;
        ctx.fill_rect(x, css_h - h, slot - gap, h);
    }

    // Accessibility mirror (in the DOM, not on the canvas):
    // <figure aria-labelledby="chart-caption">
    //   <figcaption id="chart-caption">Requests per minute, last 24 hours</figcaption>
    //   <table class="visually-hidden"> ... one row per bar ... </table>
    // </figure>
    Ok(())
}`
      },
      "production": [
        "Canvas backing store matches devicePixelRatio, and the transform is reset only on resize.",
        "Shader compile and link failures surface the info log instead of a black canvas.",
        "Animation runs in requestAnimationFrame with zero allocations in the loop.",
        "Every canvas chart has a DOM text alternative with the same numbers.",
        "The render path is profiled with the GPU and paint tracks, not guessed at."
      ],
      "crates": [
        "web-sys",
        "wasm-bindgen",
        "wgpu"
      ],
      "pitfall": "Sizing the canvas in CSS pixels only: the drawing is upscaled by the compositor, text and lines look blurry on every retina display, and the cost shows up as a paint problem rather than a code bug.",
      "questions": [
        {
          "q": "Why multiply the canvas backing-store size by devicePixelRatio?",
          "options": [
            "To reduce the number of draw calls per frame",
            "So one canvas pixel maps to one physical pixel and lines stay sharp",
            "Because WebGL requires power-of-two dimensions",
            "To enable GPU acceleration on high-density displays"
          ],
          "answer": 1,
          "explain": "CSS pixels are logical. Backing the canvas at dpr times the CSS size, then scaling the context by dpr, gives the compositor a 1:1 mapping and avoids blur."
        },
        {
          "q": "A shader fails to compile. What does WebGL give you?",
          "options": [
            "An exception thrown from compile_shader",
            "A null shader plus a message retrievable with get_shader_info_log",
            "A warning in the browser console only",
            "A fallback to the fixed-function pipeline"
          ],
          "answer": 1,
          "explain": "compile_shader returns null on failure and sets no exception. The only diagnosis is polling COMPILE_STATUS and reading the info log, which is why the helper is worth writing first."
        },
        {
          "q": "Which chart is a poor fit for canvas?",
          "options": [
            "A 10,000-point line chart updating every second",
            "A small bar chart whose values must be selectable and readable by a screen reader",
            "A particle animation with thousands of sprites",
            "A heatmap of a large matrix"
          ],
          "answer": 1,
          "explain": "Canvas gives you pixels, not elements: no text selection, no accessibility tree, no per-element focus. For a small accessible chart, SVG or an HTML table is less work and better output."
        }
      ],
      "quickbytes": [
        "canvas.width = CSS width * devicePixelRatio, then ctx.scale(dpr, dpr).",
        "Setting width or height clears the canvas and resets the transform — resize only.",
        "Check COMPILE_STATUS and LINK_STATUS; a null shader never throws.",
        "Canvas is invisible to assistive tech: mirror the numbers in the DOM."
      ],
      "github": [
        { "name": "gfx-rs/wgpu", "url": "https://github.com/gfx-rs/wgpu" },
        { "name": "wasm-bindgen/wasm-bindgen — canvas bindings in web-sys", "url": "https://github.com/wasm-bindgen/wasm-bindgen" }
      ],
      "resources": [
        {
          "title": "web_sys::HtmlCanvasElement",
          "url": "https://docs.rs/web-sys/latest/web_sys/struct.HtmlCanvasElement.html",
          "kind": "docs"
        },
        {
          "title": "MDN: WebGL tutorial",
          "url": "https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/Tutorial",
          "kind": "docs"
        },
        {
          "title": "wgpu crate documentation",
          "url": "https://docs.rs/wgpu/latest/wgpu/",
          "kind": "docs"
        },
        {
          "title": "gfx-rs/wgpu repository",
          "url": "https://github.com/gfx-rs/wgpu",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "v16",
      "n": 16,
      "title": "Accessibility: the semantics you have to render",
      "minutes": 85,
      "level": "industry",
      "goal": "Render correct roles, labels, focus and live regions from Rust components, and audit the result in CI instead of by eye.",
      "sections": [
        {
          "h": "Native elements first, ARIA second",
          "p": [
            "A button rendered as a div with an onclick handler is invisible to a keyboard and to a screen reader. No framework fixes that: view!, html! and rsx! emit exactly the element you name. Start from the native element that already has the behaviour — button, a, label, table — and reach for a role only when no element fits.",
            "The first rule of ARIA is not to use it. A role changes what assistive technology announces, not what the browser does: role=button on a div still does not focus, does not respond to Enter or Space, and has no disabled state. Every role you add is a promise to implement the behaviour yourself, in every browser."
          ],
          "list": [
            "Native elements come with focus, keyboard handling and state",
            "Every input needs a label; a placeholder is not a label",
            "Headings form the outline screen reader users navigate by",
            "Colour alone must never carry meaning"
          ],
          "tip": "Delete the role attribute and ask what breaks. If the answer is 'nothing', the element was already right."
        },
        {
          "h": "Focus is state you manage",
          "p": [
            "Client-side navigation does not reload the page, so focus stays on the link that was clicked and the new content is never announced. After a route change, move focus to the new heading. After a dialog opens, move focus inside it and restore it to the trigger on close. These are explicit DOM calls, not CSS.",
            "The same applies to dynamic content: a table that appears after loading needs focus or an announcement, and a form that submits without navigation needs its error message associated with the field. Frameworks give you the hooks; the decisions are yours."
          ],
          "code": `use leptos::prelude::*;

#[component]
pub fn RouteShell(#[prop(into)] title: String, children: Children) -> impl IntoView {
    // Effects run on the client, after the DOM is updated.
    Effect::new(move |_| {
        let Some(document) = web_sys::window().and_then(|w| w.document()) else {
            return;
        };
        if let Some(heading) = document.get_element_by_id("route-heading") {
            let _ = heading.set_attribute("tabindex", "-1");
            if let Some(el) = heading.dyn_ref::<web_sys::HtmlElement>() {
                let _ = el.focus();
            }
        }
    });

    view! {
        <main>
            <h1 id="route-heading" tabindex="-1">{title}</h1>
            {children()}
        </main>
    }
}`,
          "tip": "tabindex=\"-1\" makes an element programmatically focusable without adding it to the tab order — exactly what a heading needs after navigation."
        },
        {
          "h": "Announce changes without flooding",
          "p": [
            "A live region announces content that changes after the initial render. aria-live=\"polite\" waits for a pause; assertive interrupts. For a streaming dashboard this is a hazard: putting aria-live on a table that updates every second makes a screen reader unusable, because every update queues an announcement.",
            "Announce a summary instead, and throttle it. Expose state as well: aria-busy while loading, aria-invalid plus aria-describedby for a failing field, aria-pressed for a toggle, aria-expanded for a disclosure. Those attributes are the difference between a component that looks right and one that is usable."
          ],
          "code": `view! {
    <section aria-labelledby="metrics-heading">
        <h2 id="metrics-heading">"Live metrics"</h2>

        // One summary line, updated at most once every few seconds.
        <p role="status" aria-live="polite" aria-atomic="true">
            {move || format!(
                "{} req/s, p95 {} ms",
                throttled_rps.get(),
                throttled_p95.get()
            )}
        </p>

        // The table itself is not a live region: it would flood the queue.
        <table aria-busy=move || loading.get().to_string()>
            <caption>"Per-route latency, last 5 minutes"</caption>
            <thead><tr><th scope="col">"Route"</th><th scope="col">"p95"</th></tr></thead>
            <tbody>{/* rows */}</tbody>
        </table>
    </section>
}`,
          "list": [
            "One polite live region per page, carrying a summary",
            "aria-atomic=true so the sentence is read whole, not in fragments",
            "Never put aria-live on a list that re-renders continuously",
            "aria-busy communicates loading without a visual spinner"
          ]
        }
      ],
      "exercise": {
        "prompt": "Make a search field accessible: a real label, an announced result count, and an error message tied to the input when the query is invalid. No divs standing in for controls.",
        "starter": `view! {
    <div class="search">
        // 1. a <label> bound to the input
        // 2. an <input> with aria-invalid and aria-describedby
        // 3. a status line announcing the count
    </div>
}`,
        "hint": "for=id on the label, id on the input, aria-describedby pointing at the error paragraph, and role=status for the count. Only set aria-invalid when the value is actually invalid.",
        "solution": `use leptos::prelude::*;

#[component]
pub fn SearchField() -> impl IntoView {
    let (query, set_query) = signal(String::new());
    let results = Memo::new(move |_| {
        let q = query.get();
        if q.is_empty() { 0 } else { 4 } // placeholder count
    });
    let invalid = move || query.get().len() == 1;

    view! {
        <form class="search" role="search" on:submit=|ev| ev.prevent_default()>
            <label for="incident-search">"Search incidents"</label>

            <input
                id="incident-search"
                type="search"
                autocomplete="off"
                prop:value=move || query.get()
                aria-invalid=move || invalid().to_string()
                aria-describedby="search-error"
                on:input=move |ev| set_query.set(event_target_value(&ev))
            />

            <p id="search-error" class="error" role="alert" hidden=move || !invalid()>
                "Enter at least two characters."
            </p>

            <p role="status" aria-live="polite" aria-atomic="true">
                {move || format!("{} incidents match", results.get())}
            </p>

            <button type="submit">"Search"</button>
        </form>
    }
}`
      },
      "production": [
        "Every interactive element is a native control or has a complete keyboard implementation.",
        "Route changes move focus to the new heading and update the document title.",
        "Live regions announce summaries, throttled, never raw streams of data.",
        "axe-core runs against the built app in CI and fails on new violations.",
        "A keyboard-only and a screen-reader pass are part of the release checklist."
      ],
      "crates": [
        "leptos",
        "web-sys",
        "wasm-bindgen"
      ],
      "pitfall": "aria-live on a region that re-renders every second: the screen reader queues every announcement, and the user hears a backlog that never catches up with what is on screen.",
      "questions": [
        {
          "q": "Why is a div with role=\"button\" and an onclick handler not equivalent to a button?",
          "options": [
            "It cannot receive click events from a mouse",
            "It is not focusable, does not handle Enter/Space, and exposes no disabled state",
            "Screen readers ignore role attributes",
            "It cannot be styled with CSS"
          ],
          "answer": 1,
          "explain": "ARIA changes the announced role, not the behaviour. Focus, keyboard activation and state all have to be implemented, and every one of them is a place to get it wrong."
        },
        {
          "q": "What happens when aria-live=\"polite\" is placed on a large table that updates continuously?",
          "options": [
            "The table is skipped by screen readers",
            "Every update queues an announcement, making the page unusable",
            "The browser throttles announcements automatically",
            "The live region is ignored because tables cannot be live"
          ],
          "answer": 1,
          "explain": "Live regions announce mutations. A streaming table produces a mutation per cell update, so the queue grows faster than it drains. Announce a throttled summary instead."
        },
        {
          "q": "What does tabindex=\"-1\" on a heading accomplish?",
          "options": [
            "It removes the heading from the accessibility tree",
            "It allows programmatic focus without adding the element to the tab order",
            "It makes the heading the first tab stop on the page",
            "It disables keyboard scrolling inside the element"
          ],
          "answer": 1,
          "explain": "Negative tabindex makes an element focusable by script only. That is the standard way to move focus to new content after client-side navigation."
        }
      ],
      "quickbytes": [
        "Native element first; a role without behaviour is a lie to assistive tech.",
        "After client-side navigation, focus the new h1 with tabindex=\"-1\".",
        "One polite live region per page, carrying a throttled summary.",
        "aria-invalid plus aria-describedby belongs on the field, not on the error text alone."
      ],
      "github": [
        { "name": "dequelabs/axe-core", "url": "https://github.com/dequelabs/axe-core" },
        { "name": "leptos-rs/leptos — aria attributes in view!", "url": "https://github.com/leptos-rs/leptos" }
      ],
      "resources": [
        {
          "title": "MDN: ARIA states and properties",
          "url": "https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA",
          "kind": "docs"
        },
        {
          "title": "axe-core repository — automated accessibility rules",
          "url": "https://github.com/dequelabs/axe-core",
          "kind": "repo"
        },
        {
          "title": "web_sys::HtmlElement — focus and attributes",
          "url": "https://docs.rs/web-sys/latest/web_sys/struct.HtmlElement.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "v17",
      "n": 17,
      "title": "PWA: installable, offline and safely updatable",
      "minutes": 85,
      "level": "industry",
      "goal": "Ship a manifest and a versioned service worker that keep the wasm and its JS glue in lockstep across deploys.",
      "sections": [
        {
          "h": "Installable is a manifest plus a worker",
          "p": [
            "A PWA is a normal site with two additions: a manifest describing the app (name, icons, display mode, theme) and a service worker that can answer requests when the network cannot. Neither makes the app faster by itself; installability is a browser decision based on those signals plus HTTPS.",
            "For a wasm app the worker matters more than usual, because the binary is the largest asset. Without a cache strategy every visit re-downloads it. Precache the shell — HTML, JS, wasm, CSS — at install time, then serve from cache and revalidate in the background."
          ],
          "code": `{
  "name": "Ops dashboard",
  "short_name": "Ops",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#0b1220",
  "theme_color": "#0b1220",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}

<!-- index.html head -->
<link rel="manifest" href="/manifest.webmanifest"/>
<meta name="theme-color" content="#0b1220"/>`,
          "tip": "purpose \"any maskable\" needs safe padding: maskable icons are cropped to the platform's shape, so keep the logo inside the middle 80%."
        },
        {
          "h": "Register from Rust, update deliberately",
          "p": [
            "Registration is one call into navigator.serviceWorker. The interesting part is the update flow: a new worker installs in the background and waits while the page keeps running the old one. Calling skipWaiting immediately lets the new worker take over mid-session, where it can serve a wasm binary that does not match the JS already loaded.",
            "The safe pattern is to detect the waiting worker, show a prompt, and reload only when the user accepts. That preserves the HTML/JS/wasm triple, which is exactly the invariant a wasm app needs and exactly what a naive cache-first worker breaks. Reloading without asking is tempting and costs whatever the user was typing; asking keeps the versions consistent for free."
          ],
          "code": `use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use web_sys::ServiceWorkerRegistration;

pub async fn register(path: &str) -> Result<ServiceWorkerRegistration, JsValue> {
    let container = web_sys::window()
        .ok_or("no window")?
        .navigator()
        .service_worker();

    let registration = JsFuture::from(container.register(path)).await?;
    Ok(registration.unchecked_into())
}

/// Call after every registration: a waiting worker means a new deploy.
pub fn prompt_if_waiting(registration: &ServiceWorkerRegistration) -> bool {
    match registration.waiting() {
        Some(worker) => {
            // Show a banner; on accept, tell the worker to take over and reload.
            let _ = worker.post_message(&JsValue::from_str("SKIP_WAITING"));
            true
        }
        None => false,
    }
}`,
          "list": [
            "register() resolves to a registration, not to an active worker",
            "A waiting worker means a new version is installed but not in control",
            "Reload only after the user accepts, so state is not lost mid-edit",
            "Check for updates on visibilitychange, not on every render"
          ]
        },
        {
          "h": "Cache rules that do not break wasm",
          "p": [
            "Cache-first for hashed assets, network-first for HTML and API data, and never cache a response that is not ok. A wasm app adds one constraint: the JS glue and the wasm binary are a matched pair, so they must be versioned together — same cache name, deleted together on activate.",
            "Name the cache after the build, and delete every other cache during activation. That single rule prevents the classic failure where a stale worker serves last week's wasm with this week's glue. It also makes rollbacks safe, because the previous cache was deleted rather than quietly left behind."
          ],
          "code": `const VERSION = "app-2026-11-04";
const SHELL = ["/", "/pkg/app.js", "/pkg/app_bg.wasm", "/styles/app.css"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))),
    ),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isHashed = url.pathname.startsWith("/pkg/");

  if (isHashed) {
    // Immutable assets: cache first, network as a fallback.
    event.respondWith(
      caches.match(event.request).then((hit) => hit || fetch(event.request)),
    );
  }
  // HTML and API requests fall through to the network.
});`,
          "list": [
            "One cache name per build; delete the others on activate",
            "Never cache a non-ok response",
            "Precache the shell, not the whole site",
            "Version the wasm and its glue under the same cache entry"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write the install, activate and fetch handlers for a worker that precaches a wasm app shell and deletes old caches. Then explain what single change would cause the app to break for returning users.",
        "starter": `const VERSION = "app-v1";
const SHELL = [];

self.addEventListener("install", (event) => {
  // precache
});

self.addEventListener("activate", (event) => {
  // delete stale caches
});`,
        "hint": "cache.addAll rejects the whole install if any URL 404s, which is why the shell list must be exact. Deleting caches other than VERSION on activate is what prevents stale wasm.",
        "solution": `const VERSION = "app-v1";
const SHELL = ["/", "/pkg/app.js", "/pkg/app_bg.wasm", "/styles/app.css"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)),
      ),
    ),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith("/pkg/")) return; // HTML stays network-first

  event.respondWith(
    caches.match(event.request).then(async (hit) => {
      if (hit) return hit;
      const response = await fetch(event.request);
      if (response.ok) {
        const cache = await caches.open(VERSION);
        cache.put(event.request, response.clone());
      }
      return response;
    }),
  );
});

// The breaking change: serving app.js from a cache that still holds the
// previous app_bg.wasm. The glue calls a symbol the old binary does not
// export, and only users who visited before the deploy see the failure.`
      },
      "production": [
        "The manifest is served with the correct content type and referenced from every page.",
        "The service worker cache name is derived from the build id.",
        "A waiting worker triggers a prompt; reload happens on user action.",
        "Old caches are deleted on activate, verified in the Application panel.",
        "Offline mode is tested by toggling the network, not by trusting the cache list."
      ],
      "crates": [
        "web-sys",
        "wasm-bindgen",
        "wasm-bindgen-futures",
        "js-sys"
      ],
      "pitfall": "Deploying new HTML while the service worker still serves the previous wasm: the glue looks for an export that no longer exists, and the app fails only for users who visited before the deploy.",
      "questions": [
        {
          "q": "Why is deleting old caches on activate essential for a wasm app?",
          "options": [
            "Caches count against the storage quota per origin",
            "A stale cache can pair old wasm with new glue, breaking the ABI",
            "Browsers refuse to activate a worker with more than one cache",
            "Old caches disable installation prompts"
          ],
          "answer": 1,
          "explain": "The JS glue and the wasm binary are generated together and must be loaded together. Keeping an old cache lets one half be served from an earlier build."
        },
        {
          "q": "What does a waiting service worker indicate?",
          "options": [
            "The worker failed to install",
            "A new version is installed but the old one still controls open pages",
            "The browser is offline",
            "The cache is full"
          ],
          "answer": 1,
          "explain": "Install completed and the worker is waiting for all controlled clients to close — or for a skipWaiting message. That is the moment to offer a reload."
        },
        {
          "q": "Which request is a poor fit for cache-first?",
          "options": [
            "A content-hashed wasm file",
            "The index.html document",
            "A hashed CSS bundle",
            "A content-hashed JS chunk"
          ],
          "answer": 1,
          "explain": "HTML is the manifest pointing at hashed assets; if it is served stale, it points at files a new deploy removed. HTML should be network-first or revalidated."
        }
      ],
      "quickbytes": [
        "Cache name = build id; delete every other cache on activate.",
        "skipWaiting mid-session can swap the wasm under a running page — prompt first.",
        "cache.addAll fails the whole install if one URL 404s.",
        "Precache the shell, leave HTML network-first."
      ],
      "github": [
        { "name": "GoogleChrome/workbox", "url": "https://github.com/GoogleChrome/workbox" },
        { "name": "wasm-bindgen/wasm-bindgen — service worker bindings in web-sys", "url": "https://github.com/wasm-bindgen/wasm-bindgen" }
      ],
      "resources": [
        {
          "title": "MDN: Progressive web apps",
          "url": "https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps",
          "kind": "docs"
        },
        {
          "title": "web_sys::ServiceWorkerContainer",
          "url": "https://docs.rs/web-sys/latest/web_sys/struct.ServiceWorkerContainer.html",
          "kind": "docs"
        },
        {
          "title": "GoogleChrome/workbox — caching strategies",
          "url": "https://github.com/GoogleChrome/workbox",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "v18",
      "n": 18,
      "title": "Edge WASM: request-scoped code at the edge",
      "minutes": 80,
      "level": "industry",
      "goal": "Write a workers-rs handler, then decide from the platform's constraints whether a workload belongs at the edge at all.",
      "sections": [
        {
          "h": "What the edge actually gives you",
          "p": [
            "Edge platforms run your module close to the user, inside a sandbox with a hard CPU budget and no persistent disk. Cloudflare Workers executes wasm compiled from Rust through workers-rs; other platforms run similar models, several of them on wasmtime. The win is latency and isolation, not raw throughput. CPU speed at the edge is unremarkable; what changes is the distance to the user and the fact that every request starts from a known-clean state.",
            "The constraints are the design. No threads, no blocking I/O, no filesystem, a bundle-size limit, and a wall-clock CPU limit per request. Anything needing a connection pool or a native library is a poor fit; anything that is request-scoped transformation, auth, routing or aggregation is a good one. Each constraint removes a category of accidental complexity, and with it a category of workloads that must run somewhere else."
          ],
          "list": [
            "Request-scoped work: transform, authorize, route, aggregate",
            "Not a fit: long-lived connections, native libraries, heavy background jobs",
            "No shared mutable state between requests — use KV, Durable Objects or a database",
            "Cold start is dominated by module instantiation, so size is latency"
          ],
          "tip": "If the workload needs a warm cache and a database pool, a container is usually cheaper than forcing it into an edge isolate."
        },
        {
          "h": "A workers-rs handler",
          "p": [
            "The worker crate exposes an event macro that maps a fetch handler onto the platform's ABI, plus a Router with path parameters. Bindings such as KV namespaces arrive through Env, which is the edge equivalent of dependency injection. That is why the handler signature stays tiny and the platform's types stay out of your domain code.",
            "Keep handlers thin. Parse, call a binding, return a Response; anything more elaborate belongs in a library crate that you can test on the host without deploying. A handler that is unit-testable locally is worth more than one that is five lines shorter."
          ],
          "code": `use worker::*;

#[event(fetch)]
pub async fn main(req: Request, env: Env, _ctx: worker::Context) -> Result<Response> {
    let router = Router::new();

    router
        .get_async("/health", |_req, _ctx| async move { Response::ok("ok") })
        .get_async("/metrics/:route", |_req, ctx| async move {
            let route = ctx.param("route").cloned().unwrap_or_default();
            let kv = ctx.kv("METRICS")?;

            match kv.get(&route).text().await? {
                Some(body) => Response::ok(body),
                None => Response::error("not found", 404),
            }
        })
        .run(req, env)
        .await
}`,
          "list": [
            "Env carries bindings; nothing global goes through a static",
            "Every handler returns Result, and errors become responses",
            "Path parameters arrive through ctx.param",
            "No persistent local state between requests"
          ]
        },
        {
          "h": "Cold start is compile time",
          "p": [
            "On the edge, the first request to a new isolate pays for instantiating the module. Engines compile wasm lazily and cache compiled code, but a large module still costs milliseconds per cold start. Trimming dependencies is the highest-leverage optimization available to you.",
            "Measure at the platform: p50 and p99 in the region your users actually hit, with a cold-isolate test. A local wasmtime run proves the code works; it says nothing about what a cold isolate does under real traffic. Deploy a canary, watch the cold-start tail, then move traffic."
          ],
          "list": [
            "Remove regex, time-zone data and heavy serializers from the request path",
            "Split admin or batch routes into a separate worker",
            "Watch CPU-time errors: they are limits, not bugs, and they surface as platform error pages, not Rust backtraces",
            "Measure p99 cold starts, not just warm p50"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a workers-rs handler with a health route and a route that returns JSON from a KV binding. Explain which part you would move out of the worker if the JSON grew to a multi-megabyte aggregate.",
        "starter": `use worker::*;

#[event(fetch)]
pub async fn main(req: Request, env: Env, _ctx: worker::Context) -> Result<Response> {
    // 1. Router::new()
    // 2. /health -> "ok"
    // 3. /summary/:key -> KV read, JSON response
    todo!()
}`,
        "hint": "ctx.kv(\"METRICS\") gives a KvStore; .get(key).text().await? returns Option<String>. Response::from_json takes a serializable value.",
        "solution": `use serde::Serialize;
use worker::*;

#[derive(Serialize)]
struct Summary {
    key: String,
    rows: usize,
}

#[event(fetch)]
pub async fn main(req: Request, env: Env, _ctx: worker::Context) -> Result<Response> {
    let router = Router::new();

    router
        .get_async("/health", |_req, _ctx| async move { Response::ok("ok") })
        .get_async("/summary/:key", |_req, ctx| async move {
            let key = ctx.param("key").cloned().unwrap_or_default();
            let kv = ctx.kv("METRICS")?;

            let Some(raw) = kv.get(&key).text().await? else {
                return Response::error("not found", 404);
            };

            let rows = raw.lines().count();
            Response::from_json(&Summary { key, rows })
        })
        .run(req, env)
        .await
}

// If the aggregate grew to megabytes, it would move out of the worker:
// a scheduled job writes a precomputed summary to KV or R2, and the edge
// handler only reads that object. Edge CPU is for per-request work, not
// for scanning large datasets on every request.`
      },
      "production": [
        "Handler bundles are size-budgeted; a size regression is treated as a latency regression.",
        "No request path depends on shared mutable state in the isolate.",
        "CPU-time limits are tested with a deliberately worst-case payload.",
        "Cold-start p99 is measured per region, not inferred from local runs."
      ],
      "crates": [
        "worker",
        "worker-macros",
        "serde"
      ],
      "pitfall": "Pulling in a full HTTP client and TLS stack for one upstream call: the module grows past the practical size limit, and every cold start pays to compile code that executes once per request.",
      "questions": [
        {
          "q": "Which workload is the worst fit for an edge wasm isolate?",
          "options": [
            "Rewriting request headers per request",
            "A long-lived process holding a database connection pool",
            "Signing short-lived URLs",
            "Aggregating a few KV reads into one response"
          ],
          "answer": 1,
          "explain": "Isolates are request-scoped and can be discarded at any time; there is no durable process to hold a pool. The other three are per-request transformations, which is what the model is for."
        },
        {
          "q": "Why does module size matter more at the edge than on a normal server?",
          "options": [
            "Edge bandwidth is metered per module",
            "Every cold isolate pays instantiation and compile time, which lands on request latency",
            "The sandbox refuses modules above a fixed instruction count",
            "Large modules cannot use KV bindings"
          ],
          "answer": 1,
          "explain": "A server compiles once and serves for hours. Edge isolates are created and discarded constantly, so instantiation cost recurs and shows up directly in p99 latency."
        },
        {
          "q": "Where should a multi-megabyte aggregate be computed?",
          "options": [
            "Inside the fetch handler, on every request",
            "Ahead of time in a scheduled job or a service, with the edge reading the result",
            "In the client, after the response arrives",
            "In a service worker cache"
          ],
          "answer": 1,
          "explain": "Edge CPU is for per-request work. Precomputing into KV, R2 or a database keeps the handler small, fast and within its CPU budget."
        }
      ],
      "quickbytes": [
        "workers-rs: #[event(fetch)] plus Router, with bindings arriving through Env.",
        "No threads, no filesystem, no durable process — design around that.",
        "Module size is latency: every cold isolate pays to instantiate it.",
        "Measure p99 cold starts per region; local runs do not show them."
      ],
      "github": [
        { "name": "cloudflare/workers-rs", "url": "https://github.com/cloudflare/workers-rs" },
        { "name": "bytecodealliance/wasmtime — the engine behind several edge runtimes", "url": "https://github.com/bytecodealliance/wasmtime" }
      ],
      "resources": [
        {
          "title": "worker crate documentation",
          "url": "https://docs.rs/worker/latest/worker/",
          "kind": "docs"
        },
        {
          "title": "cloudflare/workers-rs repository",
          "url": "https://github.com/cloudflare/workers-rs",
          "kind": "repo"
        },
        {
          "title": "WebAssembly specifications — WASI interfaces used at the edge",
          "url": "https://webassembly.org/specs/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "v19",
      "n": 19,
      "title": "wasmtime: embedding untrusted modules safely",
      "minutes": 100,
      "level": "industry",
      "goal": "Embed a wasm module with wasmtime, give it exactly the imports it needs, and enforce CPU and memory limits that actually stop a hostile guest.",
      "sections": [
        {
          "h": "Four types and one boundary",
          "p": [
            "Engine compiles and owns configuration; Module is a compiled artifact; Store holds an instance's state; Linker resolves imports. Instantiation is cheap once the module is compiled, so a server compiles once and creates a store per request. That is the architecture of nearly every wasm plugin host.",
            "Because wasm cannot name the host, all authority flows through imports. The linker is therefore the security boundary: whatever you do not link, the guest cannot do. Start from an empty linker and add exactly the interfaces a plugin needs, rather than linking a broad WASI context and hoping."
          ],
          "code": `use wasmtime::{Engine, Linker, Module, Store};

pub struct Plugin {
    engine: Engine,
    module: Module,
}

impl Plugin {
    pub fn compile(wasm: &[u8]) -> anyhow::Result<Self> {
        let engine = Engine::default();
        let module = Module::new(&engine, wasm)?;
        Ok(Self { engine, module })
    }

    pub fn call(&self, input: i32) -> anyhow::Result<i32> {
        // No imports linked: this guest can only compute.
        let linker: Linker<()> = Linker::new(&self.engine);
        let mut store = Store::new(&self.engine, ());
        let instance = linker.instantiate(&mut store, &self.module)?;
        let process = instance.get_typed_func::<i32, i32>(&mut store, "process")?;
        process.call(&mut store, input)
    }
}`,
          "tip": "Instantiate per call, compile once. Module is Send + Sync and safe to share; Store owns mutable state and is meant to be short-lived."
        },
        {
          "h": "Fuel, epochs and memory ceilings",
          "p": [
            "An untrusted module containing loop {} will consume a core until something stops it. Wasmtime offers two mechanisms: fuel, a deterministic instruction budget metered by the engine, and epoch interruption, a cheap counter checked at loop backedges so a watchdog thread can preempt execution.",
            "Fuel is deterministic and therefore testable — the same input consumes the same budget. Epochs are cheaper and wall-clock based. Either way, the limit is not a default you can skip: without one, a hostile or simply buggy guest runs until the request times out, if it ever does."
          ],
          "code": `use std::sync::Arc;
use std::time::Duration;
use wasmtime::{Config, Engine, Linker, Module, Store, StoreLimits, StoreLimitsBuilder};

pub fn hardened_engine() -> anyhow::Result<Engine> {
    let mut config = Config::new();
    config.consume_fuel(true);          // deterministic instruction budget
    config.epoch_interruption(true);    // wall-clock preemption
    Engine::new(&config).map_err(Into::into)
}

struct HostState {
    limits: StoreLimits,
}

pub fn run(engine: &Engine, module: &Module, fuel: u64) -> anyhow::Result<i32> {
    let limits = StoreLimitsBuilder::new()
        .memory_size(64 << 20)          // 64 MiB of linear memory
        .instances(1)
        .build();

    let mut store = Store::new(engine, HostState { limits });
    store.set_fuel(fuel)?;
    store.epoch_deadline_trap();
    // The limits must live in the store's data; a temporary would not outlive this call.
    store.limiter(|state| &mut state.limits);

    let linker: Linker<HostState> = Linker::new(engine);
    let instance = linker.instantiate(&mut store, module)?;
    let f = instance.get_typed_func::<i32, i32>(&mut store, "process")?;
    f.call(&mut store, 42)
}

pub fn watchdog(engine: Arc<Engine>) {
    // Bump the epoch periodically; guests with a deadline trap when it passes.
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(50));
        engine.increment_epoch();
    });
}`,
          "list": [
            "Fuel: deterministic, good for tests and per-request budgets",
            "Epochs: cheap, wall-clock, good for hard deadlines",
            "StoreLimits caps memory and instance counts",
            "A limit you never test is a limit that does not work"
          ]
        },
        {
          "h": "Precompile, then deserialize",
          "p": [
            "Compiling on every boot spends milliseconds you may not have. wasmtime compile produces a precompiled artifact, and Module::deserialize loads it without Cranelift. The trade-off is that the artifact is tied to the engine version and target, so it is a build artifact, not a portable library.",
            "Memory also needs a ceiling. A guest that allocates in a loop should get an error from the limiter, not trigger the host's OOM killer. Pair limits with a pooling allocator when you instantiate thousands of short-lived instances, so allocation cost stops dominating."
          ],
          "code": `# AOT compile at build time, ship the .cwasm artifact.
wasmtime compile guest.wasm -o guest.cwasm

# Cross-compile for the architecture your fleet actually runs.
wasmtime compile --target aarch64-unknown-linux-gnu guest.wasm -o guest-arm64.cwasm

# Inspect what the module imports before you link anything.
wasmtime inspect guest.wasm

# Run with a WASI context (preview 2) instead of an empty linker.
wasmtime run --dir ./data guest.wasm

# The engine refuses an artifact built by a different wasmtime version;
# rebuild it in the same pipeline that builds the runtime image.`,
          "tip": "wasmtime inspect lists imports before execution; an unexpected wasi:sockets import is a finding, not a detail."
        }
      ],
      "exercise": {
        "prompt": "Write a runner that enforces a fuel budget and refuses to link any import. Then explain how you would add a single host function that appends a line to a log, without opening any other capability.",
        "starter": `use wasmtime::{Engine, Linker, Module, Store};

pub fn run(engine: &Engine, module: &Module, fuel: u64) -> anyhow::Result<i32> {
    // 1. store with fuel
    // 2. empty linker
    // 3. typed call to "process"
    todo!()
}`,
        "hint": "store.set_fuel(fuel)? before instantiation; Linker::new(&engine) with no additions links nothing, so any import in the module fails instantiation with an unknown-import error.",
        "solution": `use wasmtime::{Caller, Engine, Linker, Module, Store};

pub struct LogOnly;

pub fn run(engine: &Engine, module: &Module, fuel: u64) -> anyhow::Result<i32> {
    let mut store: Store<()> = Store::new(engine, ());
    store.set_fuel(fuel)?;

    let mut linker: Linker<()> = Linker::new(engine);

    // Exactly one capability: append a line to stdout.
    linker.func_wrap("host", "log", |_caller: Caller<'_, ()>, ptr: i32, len: i32| {
        println!("guest log: ptr={ptr} len={len}");
    })?;

    let instance = linker.instantiate(&mut store, module)?;
    let process = instance.get_typed_func::<i32, i32>(&mut store, "process")?;
    process.call(&mut store, 42)
}

// Anything the module imports that is not "host"."log" now fails at
// instantiation with an unknown-import error, which is the intended
// failure mode: deny by default, allow explicitly.`
      },
      "production": [
        "Every guest runs with an explicit fuel or epoch deadline; no unbounded execution path exists.",
        "StoreLimits caps linear memory, table elements and instance count.",
        "The linker is built from an allowlist, and unexpected imports fail instantiation.",
        "Precompiled artifacts are rebuilt per engine version and verified at startup.",
        "A hostile-guest test (infinite loop, huge allocation) runs in CI."
      ],
      "crates": [
        "wasmtime",
        "wasmtime-wasi",
        "anyhow"
      ],
      "pitfall": "No fuel and no epoch deadline: a guest with an infinite loop pins a core, the request never reaches the timeout you believed was protecting you, and the whole worker pool degrades.",
      "questions": [
        {
          "q": "What is the difference between fuel and epoch interruption?",
          "options": [
            "Fuel limits memory; epochs limit instructions",
            "Fuel meters instructions deterministically; epochs preempt on wall-clock deadlines",
            "Fuel only works with WASI; epochs work with core modules",
            "They are two names for the same mechanism"
          ],
          "answer": 1,
          "explain": "Fuel counts work deterministically, which makes budgets reproducible in tests. Epochs are a cheaper counter bumped by a watchdog, suited to hard deadlines."
        },
        {
          "q": "A module imports wasi:sockets, and your linker provides nothing. What happens?",
          "options": [
            "The import silently resolves to a stub that returns an error",
            "Instantiation fails with an unknown-import error",
            "The module runs but networking calls trap at call time",
            "wasmtime links a default socket implementation"
          ],
          "answer": 1,
          "explain": "Imports must be resolved by the linker before instantiation. An unlinked import is a hard error, which is exactly the deny-by-default behaviour you want."
        },
        {
          "q": "Why precompile a module to a .cwasm artifact?",
          "options": [
            "It makes the module portable across wasmtime versions",
            "It avoids Cranelift compilation at startup, at the cost of tying the artifact to the engine version",
            "It compresses the module for smaller downloads",
            "It enables fuel metering"
          ],
          "answer": 1,
          "explain": "Deserializing a precompiled artifact skips codegen, which cuts cold-start latency. The artifact depends on the engine version and target ABI, so it must be rebuilt when either changes."
        }
      ],
      "quickbytes": [
        "Compile once, instantiate per request: Module is shareable, Store is short-lived.",
        "Deny by default: an empty linker means only computation is possible.",
        "Fuel for deterministic budgets, epochs for wall-clock deadlines.",
        "wasmtime inspect lists imports before you run anything."
      ],
      "github": [
        { "name": "bytecodealliance/wasmtime", "url": "https://github.com/bytecodealliance/wasmtime" },
        { "name": "bytecodealliance/wasm-tools", "url": "https://github.com/bytecodealliance/wasm-tools" }
      ],
      "resources": [
        {
          "title": "wasmtime crate documentation — embedding API",
          "url": "https://docs.rs/wasmtime/latest/wasmtime/",
          "kind": "docs"
        },
        {
          "title": "wasmtime::Config — fuel, epochs, limits",
          "url": "https://docs.rs/wasmtime/latest/wasmtime/struct.Config.html",
          "kind": "docs"
        },
        {
          "title": "wasmtime-wasi p2 — WASI 0.2 host implementation",
          "url": "https://docs.rs/wasmtime-wasi/latest/wasmtime_wasi/p2/index.html",
          "kind": "docs"
        },
        {
          "title": "Everything Old is New Again: Binary Security of WebAssembly (USENIX Security 2020)",
          "url": "https://www.usenix.org/conference/usenixsecurity20/presentation/lehmann",
          "kind": "paper"
        },
        {
          "title": "bytecodealliance/wasmtime repository",
          "url": "https://github.com/bytecodealliance/wasmtime",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "v20",
      "n": 20,
      "title": "The component model: WIT, worlds and the canonical ABI",
      "minutes": 110,
      "level": "industry",
      "goal": "Describe a contract in WIT, build a component that implements it, and explain what the canonical ABI replaces.",
      "sections": [
        {
          "h": "The contract moves out of the glue",
          "p": [
            "The component model moves the contract out of generated glue and into WIT: interfaces, records, variants, lists, options and resources. A world lists what a component imports and exports. Two components that speak the same world can be written in different languages and composed without either knowing the other's ABI.",
            "That is the difference from core wasm, where a module exports a function taking i32 and everyone agrees by convention that it is a pointer to a length-prefixed UTF-8 string. The canonical ABI defines those conventions once — string encoding, list layout, ownership, resource handles — so the agreement is checked rather than assumed. The old arrangement works until one side changes a layout, and then it fails with corrupted data instead of a type error."
          ],
          "code": `// wit/dashboard.wit
package acme:dashboard@0.1.0;

interface metrics {
  record sample {
    name: string,
    p95-ms: f64,
    healthy: bool,
  }

  enum error {
    not-found,
    unavailable,
  }

  get-samples: func(limit: u32) -> list<sample>;
  record: func(name: string, latency-ms: f64) -> result<_, error>;
}

world dashboard {
  import log: func(message: string);
  export metrics;
}`,
          "tip": "WIT uses kebab-case names; bindings map them to snake_case in Rust and camelCase in JavaScript, so the wire format stays language-neutral."
        },
        {
          "h": "Building a component",
          "p": [
            "cargo component wraps the usual build and emits a component rather than a core module. For a core module produced by plain rustc, wasm-tools component new wraps it with an adapter that maps preview1 imports onto the component model, which is how existing crates keep working.",
            "Inspect before you integrate. wasm-tools component wit prints the world a component declares, and that output is the fastest way to catch a dependency that quietly widened your interface. Imports you did not plan for mean the contract grew without a review."
          ],
          "code": `# Build a component directly from a Rust crate that has a wit/ folder.
cargo component build --release
# -> target/wasm32-wasip1/release/dashboard.wasm

# Or adapt a core module built by rustc.
wasm-tools component new core.wasm \\
  --adapt wasi_snapshot_preview1=adapter/wasi_snapshot_preview1.wasm \\
  -o dashboard.wasm

# Verify the world the component actually implements.
wasm-tools component wit dashboard.wasm

# Run it on wasmtime; the component-model feature is on by default.
wasmtime run dashboard.wasm`,
          "list": [
            "cargo component for new crates; wasm-tools for existing core modules",
            "The adapter is what keeps preview1 dependencies usable",
            "wasm-tools component wit is the contract diff tool",
            "A component that fails validation never reaches composition"
          ]
        },
        {
          "h": "Host bindings and composition",
          "p": [
            "On the host, wasmtime::component::bindgen! reads the same WIT and generates typed traits, so imports are ordinary Rust methods and exports are typed calls. include_component_type embeds the world's type in the binary, which lets you type-check a component against the expected world without shipping the WIT files.",
            "Composition is where the model pays off: a linker can wire one component's imports to another's exports, so a plugin can consume a logging or HTTP component chosen at deploy time. The security boundary is unchanged — a component can use only what its world imports and the host provides."
          ],
          "code": `use wasmtime::component::{Component, Linker};
use wasmtime::{Engine, Store};

wasmtime::component::bindgen!({
    world: "dashboard",
    path: "wit",
    include_component_type: true,
});

fn main() -> anyhow::Result<()> {
    let engine = Engine::default();
    let component = Component::from_file(&engine, "dashboard.wasm")?;

    let mut linker: Linker<()> = Linker::new(&engine);
    linker.root().func_wrap("log", |_store, (msg,): (String,)| {
        println!("guest: {msg}");
    })?;

    let mut store = Store::new(&engine, ());
    let instance = linker.instantiate(&mut store, &component)?;

    // Typed calls are generated from the world; no pointer arithmetic.
    let _ = &instance;
    Ok(())
}`,
          "tip": "If bindgen! reports a missing world, pass path explicitly — the macro looks for wi/ adjacent to Cargo.toml and requires exactly one world unless you name it."
        }
      ],
      "exercise": {
        "prompt": "Write a WIT world for a plugin that imports a logger and exports a transform function over a list of records. Then show the commands that build it and inspect the resulting world.",
        "starter": `// wit/plugin.wit
package acme:plugin@0.1.0;

interface transform {
  // record input { ... }
  // run: func(rows: list<input>) -> list<input>;
}

world plugin {
  // import log
  // export transform
}`,
        "hint": "Records need named fields with WIT types; the world block lists `import log: func(message: string);` and `export transform;`. Build with cargo component, inspect with wasm-tools component wit.",
        "solution": `// wit/plugin.wit
package acme:plugin@0.1.0;

interface transform {
  record input {
    key: string,
    value: f64,
  }

  run: func(rows: list<input>) -> list<input>;
}

world plugin {
  import log: func(message: string);
  export transform;
}

# Build and inspect
cargo component build --release
wasm-tools component wit target/wasm32-wasip1/release/plugin.wasm

# Expected output: the same package, world plugin, with one import
# (log) and one export (transform). Any extra import is a contract
# change you did not intend.`
      },
      "production": [
        "Every component's world is versioned in its package name, and breaking changes get a new version.",
        "wasm-tools component wit output is diffed in CI to catch accidental interface growth.",
        "Host linkers provide only the imports the world declares, and nothing implicitly.",
        "Adapter versions are pinned alongside the toolchain that produced the core module.",
        "Composition is tested with a component built by a different language when possible."
      ],
      "crates": [
        "wasmtime",
        "wit-bindgen",
        "cargo-component",
        "wasm-tools"
      ],
      "pitfall": "Wrapping a preview1 core module without an adapter: instantiation fails with an unknown import for wasi_snapshot_preview1, and the message names the old ABI rather than the missing adapter.",
      "questions": [
        {
          "q": "What does WIT add that a core wasm export signature does not?",
          "options": [
            "Faster execution through typed instructions",
            "Named types, interfaces and a world that describe imports and exports language-neutrally",
            "Automatic memory management for the guest",
            "A replacement for the wasm binary format"
          ],
          "answer": 1,
          "explain": "A core export is just i32s. WIT declares records, lists, results and resources, plus which of them a component imports and exports, so the contract can be checked instead of assumed."
        },
        {
          "q": "What is the canonical ABI responsible for?",
          "options": [
            "Choosing which language implements the component",
            "Defining how strings, lists, records and resources cross the boundary",
            "Compiling WIT to machine code",
            "Enforcing CPU limits on the guest"
          ],
          "answer": 1,
          "explain": "It fixes the representation and ownership rules once — string encoding, list layout, handle tables — so two components written in different languages agree without custom glue."
        },
        {
          "q": "A preview1 core module fails to instantiate as a component. What is missing?",
          "options": [
            "A fuel budget",
            "An adapter that maps wasi_snapshot_preview1 imports onto the component model",
            "A second world declaration",
            "The include_component_type option"
          ],
          "answer": 1,
          "explain": "Core modules built against preview1 import wasi_snapshot_preview1. wasm-tools component new with --adapt supplies the shim that satisfies those imports in component form."
        }
      ],
      "quickbytes": [
        "cargo component build emits a component; wasm-tools component new adapts a core module.",
        "wasm-tools component wit is the fastest contract diff you can run.",
        "The canonical ABI fixes string, list and resource layout once, for every language.",
        "bindgen! with include_component_type lets you type-check against a world without shipping WIT."
      ],
      "github": [
        { "name": "WebAssembly/component-model", "url": "https://github.com/WebAssembly/component-model" },
        { "name": "bytecodealliance/cargo-component", "url": "https://github.com/bytecodealliance/cargo-component" }
      ],
      "resources": [
        {
          "title": "wasmtime::component — bindgen! and the component API",
          "url": "https://docs.rs/wasmtime/latest/wasmtime/component/",
          "kind": "docs"
        },
        {
          "title": "wasmtime::component::bindgen! macro reference",
          "url": "https://docs.rs/wasmtime/latest/wasmtime/component/macro.bindgen.html",
          "kind": "docs"
        },
        {
          "title": "WebAssembly/component-model specification",
          "url": "https://github.com/WebAssembly/component-model",
          "kind": "repo"
        },
        {
          "title": "bytecodealliance/wit-bindgen",
          "url": "https://github.com/bytecodealliance/wit-bindgen",
          "kind": "repo"
        },
        {
          "title": "Wasm I/O conference — component model talks",
          "url": "https://www.youtube.com/@wasmio",
          "kind": "video"
        }
      ]
    }
  ]
};
