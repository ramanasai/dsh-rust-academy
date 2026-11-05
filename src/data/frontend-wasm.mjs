/**
 * WASM & frontend track.
 *
 * Authored for the Rust Academy plugin. Every lesson is plain JSON-compatible
 * data consumed by src/app.js through build.mjs.
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
          "code": "(module\n  (memory (export \"memory\") 1)            ;; one 64 KiB page\n  (global $next (mut i32) (i32.const 0))\n\n  (func $alloc (param $len i32) (result i32)\n    (local $ptr i32)\n    (global.get $next)\n    (local.tee $ptr)\n    (local.get $len)\n    (i32.add)\n    (global.set $next)\n    (local.get $ptr))\n\n  (func (export \"sum_squares\") (param $n i32) (result i32)\n    (local $i i32)\n    (local $acc i32)\n    (block $done\n      (loop $next\n        (br_if $done (i32.ge_s (local.get $i) (local.get $n)))\n        (local.set $acc\n          (i32.add (local.get $acc)\n                   (i32.mul (local.get $i) (local.get $i))))\n        (local.set $i (i32.add (local.get $i) (i32.const 1)))\n        (br $next)))\n    (local.get $acc)))",
          "tip": "wasm-tools print (or wasm2wat) shows exactly what you shipped; run it on a release build, where inlining has already happened."
        },
        {
          "h": "The sandbox is the product",
          "p": [
            "The security model is why wasm runs on servers and at the edge. Guest code cannot name a host address; it can only touch its own memory and call imported functions the embedder chose to provide. A bug in the guest produces a trap, not a shell: out-of-bounds access is checked, the guest stack is separate, and the host decides how much CPU and memory an instance may consume.",
            "That is also the honest limitation. The sandbox protects the host from the guest, not the guest from itself, and it is not free: bounds checks and register pressure cost real cycles. The systematic USENIX ATC 2019 study measured WebAssembly running roughly 1.5x slower than native on average, with bounds checking as a leading cause."
          ],
          "code": "// index.js — the host half of the contract\nconst response = await fetch(\"/pkg/dashboard_bg.wasm\");\nconst { instance } = await WebAssembly.instantiateStreaming(response, {});\n\n// Exports are plain JS functions; arguments widen to JS numbers.\nconsole.log(instance.exports.sum_squares(10)); // 285\n\n// Imports are where the host hands over authority, one function at a time.\nconst { instance: clocked } = await WebAssembly.instantiateStreaming(\n  fetch(\"/pkg/clocked_bg.wasm\"),\n  { env: { now: () => performance.now() } },\n);\n\n// Memory is an ArrayBuffer that can detach when it grows — re-read it.\nconst bytes = new Uint8Array(clocked.exports.memory.buffer, 0, 16);",
          "tip": "instantiateStreaming requires Content-Type: application/wasm; a server that guesses application/octet-stream silently falls back to a slower path or rejects."
        }
      ],
      "exercise": {
        "prompt": "Write a WAT module that exports a memory and an iterative fib(n: i32) -> i32, then instantiate it from JavaScript and print fib(30). Keep every loop branch explicit so the control flow is visible.",
        "starter": "(module\n  ;; 1. export a memory\n  ;; 2. fib with locals a, b, i — no recursion\n)\n\n// index.js\n// 3. instantiate and call fib(30)",
        "hint": "Keep a = 0, b = 1 and loop n times: t = a; a = b; b = t + b. Export the function with (export \"fib\") and branch back to the loop label.",
        "solution": "(module\n  (memory (export \"memory\") 1)\n\n  (func (export \"fib\") (param $n i32) (result i32)\n    (local $a i32) (local $b i32) (local $t i32) (local $i i32)\n    (local.set $b (i32.const 1))\n    (block $done\n      (loop $loop\n        (br_if $done (i32.ge_s (local.get $i) (local.get $n)))\n        (local.set $t (local.get $a))\n        (local.set $a (local.get $b))\n        (local.set $b (i32.add (local.get $t) (local.get $b)))\n        (local.set $i (i32.add (local.get $i) (i32.const 1)))\n        (br $loop)))\n    (local.get $a)))\n\n// index.js\nconst { instance } = await WebAssembly.instantiateStreaming(\n  fetch(\"/fib.wasm\"),\n  {},\n);\nconsole.log(instance.exports.fib(30)); // 832040"
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
        {
          "name": "wasm-bindgen — Rust/JS glue for WebAssembly",
          "url": "https://github.com/wasm-bindgen/wasm-bindgen"
        },
        {
          "name": "WebAssembly/spec — reference interpreter and test suite",
          "url": "https://github.com/WebAssembly/spec"
        }
      ],
      "resources": [
        {
          "title": "WebAssembly specifications: core spec, JS API, WASI",
          "url": "https://webassembly.org/specs/",
          "kind": "docs"
        },
        {
          "title": "MDN: WebAssembly concepts",
          "url": "https://developer.mozilla.org/en-US/docs/WebAssembly/Guides/Concepts",
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
          "code": "use wasm_bindgen::prelude::*;\nuse serde::Serialize;\n\n#[derive(Serialize)]\nstruct Snapshot {\n    samples: usize,\n    p95_ms: f64,\n}\n\n#[wasm_bindgen]\npub struct Dashboard {\n    samples: Vec<f64>,\n}\n\n#[wasm_bindgen]\nimpl Dashboard {\n    #[wasm_bindgen(constructor)]\n    pub fn new() -> Dashboard {\n        Dashboard { samples: Vec::new() }\n    }\n\n    pub fn push(&mut self, value: f64) {\n        self.samples.push(value);\n    }\n\n    // Result<T, JsError> becomes a thrown JS Error.\n    pub fn snapshot(&self) -> Result<JsValue, JsError> {\n        let mut sorted = self.samples.clone();\n        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));\n        let idx = ((sorted.len().saturating_sub(1)) as f64 * 0.95).round() as usize;\n        let p95_ms = sorted.get(idx).copied().unwrap_or(0.0);\n        serde_wasm_bindgen::to_value(&Snapshot {\n            samples: self.samples.len(),\n            p95_ms,\n        })\n        .map_err(|e| JsError::new(&e.to_string()))\n    }\n}\n\n#[wasm_bindgen(start)]\npub fn start() {\n    console_error_panic_hook::set_once();\n}",
          "tip": "#[wasm_bindgen(start)] runs at instantiation: the right place for the panic hook, the wrong place for work that needs a DOM node which may not exist yet."
        },
        {
          "h": "The handle tax",
          "p": [
            "An exported struct is a pointer into wasm memory that JavaScript holds as an opaque object. JavaScript has no destructor, so the Rust value lives until you call free() — or until a FinalizationRegistry gets around to it, which is not a schedule you can test against. In a framework you rarely construct these by hand; in a hand-written binding, every new Dashboard() is a leak until it is freed."
          ],
          "code": "const dashboard = new Dashboard();\ndashboard.push(12.5);\ndashboard.push(31.0);\n\nconsole.log(dashboard.snapshot()); // { samples: 2, p95_ms: 31 }\ndashboard.free();                  // JS has no Drop; this is mandatory\n\n// If the handle must survive an async boundary, own it explicitly:\nclass DashboardOwner {\n  #handle = new Dashboard();\n  get handle() { return this.#handle; }\n  dispose() { this.#handle.free(); }\n}",
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
        "starter": "use wasm_bindgen::prelude::*;\n\n#[wasm_bindgen]\npub struct Histogram {\n    // 1. keep a Vec<f64>\n}\n\n#[wasm_bindgen]\nimpl Histogram {\n    // 2. constructor\n    // 3. record(&mut self, value: f64)\n    // 4. #[wasm_bindgen(getter)] pub fn count(&self) -> usize\n    // 5. to_json -> Result<JsValue, JsError>\n}",
        "hint": "Mark the constructor with #[wasm_bindgen(constructor)], mark count with #[wasm_bindgen(getter)] so JS reads it as a property, and use serde_wasm_bindgen::to_value with a #[derive(Serialize)] struct.",
        "solution": "use wasm_bindgen::prelude::*;\nuse serde::Serialize;\n\n#[derive(Serialize)]\nstruct HistogramJson {\n    count: usize,\n    values: Vec<f64>,\n}\n\n#[wasm_bindgen]\npub struct Histogram {\n    values: Vec<f64>,\n}\n\n#[wasm_bindgen]\nimpl Histogram {\n    #[wasm_bindgen(constructor)]\n    pub fn new() -> Histogram {\n        Histogram { values: Vec::new() }\n    }\n\n    pub fn record(&mut self, value: f64) {\n        self.values.push(value);\n    }\n\n    #[wasm_bindgen(getter)]\n    pub fn count(&self) -> usize {\n        self.values.len()\n    }\n\n    pub fn to_json(&self) -> Result<JsValue, JsError> {\n        serde_wasm_bindgen::to_value(&HistogramJson {\n            count: self.values.len(),\n            values: self.values.clone(),\n        })\n        .map_err(|e| JsError::new(&e.to_string()))\n    }\n}\n\n// dashboard.js\n// const h = new Histogram();\n// h.record(12.5);\n// h.record(31.0);\n// console.log(h.count);       // 2\n// console.log(h.to_json());   // { count: 2, values: [...] }\n// h.free();"
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
        {
          "name": "wasm-bindgen/wasm-bindgen",
          "url": "https://github.com/wasm-bindgen/wasm-bindgen"
        },
        {
          "name": "wasm-bindgen/wasm-pack",
          "url": "https://github.com/wasm-bindgen/wasm-pack"
        }
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
          "code": "use wasm_bindgen::prelude::*;\nuse wasm_bindgen::JsCast;\n\n#[wasm_bindgen]\nextern \"C\" {\n    #[wasm_bindgen(js_namespace = console, js_name = log)]\n    fn console_log(s: &str);\n\n    #[wasm_bindgen(js_namespace = performance, js_name = now)]\n    fn performance_now() -> f64;\n\n    #[wasm_bindgen(js_name = structuredClone)]\n    fn structured_clone(value: &JsValue) -> JsValue;\n}\n\npub fn element_by_id(id: &str) -> Option<web_sys::HtmlElement> {\n    web_sys::window()?\n        .document()?\n        .get_element_by_id(id)?\n        .dyn_into::<web_sys::HtmlElement>()\n        .ok()\n}\n\npub fn timed<T>(label: &str, f: impl FnOnce() -> T) -> T {\n    let start = performance_now();\n    let out = f();\n    console_log(&format!(\"{label}: {:.2} ms\", performance_now() - start));\n    out\n}",
          "tip": "dyn_into returns Result and dyn_ref returns Option — use the latter when a null is a normal outcome, and handle it instead of unwrapping."
        },
        {
          "h": "Closures have a lifetime, and it is yours",
          "p": [
            "A Rust closure passed to JavaScript must outlive the call that registered it. Closure::new boxes the closure and keeps it alive; if the Closure value is dropped, the JS side still holds a callback pointer into freed memory, and the next event panics or throws. Store the closure in the struct that owns the listener, and drop both together.",
            "For a listener that only ever fires once, Closure::once_into_js hands ownership to JavaScript and needs no bookkeeping. Closure::forget() leaks by design: it is correct for a listener that must live as long as the page, and a bug everywhere else, because nothing can ever unregister it."
          ],
          "code": "use wasm_bindgen::prelude::*;\nuse wasm_bindgen::JsCast;\nuse web_sys::EventTarget;\n\npub struct VisibilityWatcher {\n    target: EventTarget,\n    // Keep the closure alive exactly as long as the listener is registered.\n    on_change: Closure<dyn FnMut(web_sys::Event)>,\n}\n\nimpl VisibilityWatcher {\n    pub fn attach(target: &EventTarget) -> Result<Self, JsValue> {\n        let on_change = Closure::<dyn FnMut(web_sys::Event)>::new(move |_ev| {\n            let hidden = web_sys::window()\n                .and_then(|w| w.document())\n                .map(|d| d.hidden())\n                .unwrap_or(false);\n            if hidden {\n                // pause timers, flush buffers, stop polling\n            }\n        });\n        target.add_event_listener_with_callback(\n            \"visibilitychange\",\n            on_change.as_ref().unchecked_ref(),\n        )?;\n        Ok(Self { target: target.clone(), on_change })\n    }\n}\n\nimpl Drop for VisibilityWatcher {\n    fn drop(&mut self) {\n        let _ = self.target.remove_event_listener_with_callback(\n            \"visibilitychange\",\n            self.on_change.as_ref().unchecked_ref(),\n        );\n    }\n}",
          "tip": "The error 'closure invoked after being dropped' is almost always a Closure that was not stored; it is not a wasm-bindgen bug."
        },
        {
          "h": "Promises are futures, and futures need a driver",
          "p": [
            "wasm-bindgen-futures bridges the two worlds. spawn_local drives a Rust future on the current thread, and JsFuture converts a JS Promise into something awaitable. In 0.4.80 the crate is a thin shim over js_sys::futures: js_sys::Promise implements IntoFuture directly, so a promise can simply be awaited.",
            "There is no thread to block in a browser. A synchronous wait deadlocks the event loop, and a busy loop starves rendering. spawn_local returns immediately, which is why the work must live inside the async block and why errors inside it have to be surfaced explicitly — nobody is awaiting the spawned future."
          ],
          "code": "use wasm_bindgen::JsCast;\nuse wasm_bindgen_futures::spawn_local;\n\npub fn load_json(url: &'static str) {\n    spawn_local(async move {\n        let window = web_sys::window().expect(\"browser\");\n        let resp: web_sys::Response = wasm_bindgen_futures::JsFuture::from(\n            window.fetch_with_str(url),\n        )\n        .await\n        .expect(\"network\")\n        .dyn_into()\n        .expect(\"Response\");\n\n        if !resp.ok() {\n            web_sys::console::error_1(&format!(\"HTTP {}\", resp.status()).into());\n            return;\n        }\n\n        let text = wasm_bindgen_futures::JsFuture::from(resp.text().unwrap())\n            .await\n            .expect(\"body\")\n            .as_string()\n            .unwrap_or_default();\n\n        let _rows: Vec<Metric> = serde_json::from_str(&text).unwrap_or_default();\n    });\n}",
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
        "starter": "use std::cell::Cell;\nuse std::rc::Rc;\nuse wasm_bindgen::prelude::*;\nuse web_sys::HtmlElement;\n\npub struct ClickCounter {\n    // hold the element, the closure and the shared count\n}\n\nimpl ClickCounter {\n    pub fn attach(button: &HtmlElement) -> Result<Self, JsValue> {\n        // 1. Rc<Cell<u32>>\n        // 2. Closure::new(move |_| ...)\n        // 3. add_event_listener_with_callback(\"click\", ...)\n        todo!()\n    }\n}",
        "hint": "Rc<Cell<u32>> moves into the closure, the closure moves into the struct, and Drop calls remove_event_listener_with_callback with the same callback reference.",
        "solution": "use std::cell::Cell;\nuse std::rc::Rc;\nuse wasm_bindgen::prelude::*;\nuse wasm_bindgen::JsCast;\nuse web_sys::HtmlElement;\n\npub struct ClickCounter {\n    button: HtmlElement,\n    count: Rc<Cell<u32>>,\n    on_click: Closure<dyn FnMut(web_sys::MouseEvent)>,\n}\n\nimpl ClickCounter {\n    pub fn attach(button: &HtmlElement) -> Result<Self, JsValue> {\n        let count = Rc::new(Cell::new(0));\n        let seen = count.clone();\n\n        let on_click = Closure::<dyn FnMut(web_sys::MouseEvent)>::new(\n            move |_ev: web_sys::MouseEvent| {\n                seen.set(seen.get() + 1);\n            },\n        );\n\n        button.add_event_listener_with_callback(\n            \"click\",\n            on_click.as_ref().unchecked_ref(),\n        )?;\n\n        Ok(Self { button: button.clone(), count, on_click })\n    }\n\n    pub fn count(&self) -> u32 {\n        self.count.get()\n    }\n}\n\nimpl Drop for ClickCounter {\n    fn drop(&mut self) {\n        let _ = self.button.remove_event_listener_with_callback(\n            \"click\",\n            self.on_click.as_ref().unchecked_ref(),\n        );\n    }\n}"
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
        {
          "name": "wasm-bindgen/wasm-bindgen — closure and futures support",
          "url": "https://github.com/wasm-bindgen/wasm-bindgen"
        },
        {
          "name": "rustwasm/gloo — ergonomic web APIs on top of web-sys",
          "url": "https://github.com/ranile/gloo"
        }
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
          "code": "use leptos::prelude::*;\n\n#[component]\npub fn LatencyCard() -> impl IntoView {\n    let (samples, set_samples) = signal(Vec::<f64>::new());\n    let (paused, set_paused) = signal(false);\n\n    // Derived state: recomputed only when samples changes.\n    let p95 = Memo::new(move |_| {\n        let mut v = samples.get();\n        if v.is_empty() {\n            return 0.0;\n        }\n        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));\n        let idx = ((v.len() - 1) as f64 * 0.95).round() as usize;\n        v[idx]\n    });\n\n    // Side effect, not render logic: runs after the DOM update.\n    Effect::new(move |_| {\n        if p95.get() > 250.0 {\n            leptos::logging::warn!(\"p95 above budget\");\n        }\n    });\n\n    view! {\n        <section class=\"card\" aria-live=\"polite\">\n            <h2>\"Latency\"</h2>\n            <p>{move || format!(\"{:.1} ms p95\", p95.get())}</p>\n            <button\n                aria-pressed=move || paused.get().to_string()\n                on:click=move |_| set_paused.update(|p| *p = !*p)\n            >\n                {move || if paused.get() { \"Resume\" } else { \"Pause\" }}\n            </button>\n        </section>\n    }\n}",
          "tip": "Closures that read a signal are what make the DOM reactive; passing a value directly freezes it at render time."
        },
        {
          "h": "Components are functions, props are arguments",
          "p": [
            "A #[component] function takes typed props and returns impl IntoView. Props are ordinary Rust values evaluated by the caller, so reactivity has to be passed in explicitly — either a signal or a closure. Children are a prop too, typed as Children or, when the parent re-renders, as ChildrenFn.",
            "Mounting differs per build target. A client-only app calls mount_to_body(App); a hydrated app calls hydrate_body(App) and expects the server to have produced identical markup. The same component tree serves both, which is the point — but only when rendering is deterministic."
          ],
          "code": "use leptos::prelude::*;\n\n#[component]\npub fn Stat(\n    label: &'static str,\n    #[prop(into)] value: Signal<String>,\n    #[prop(default = \"—\")] trend: &'static str,\n) -> impl IntoView {\n    view! {\n        <div class=\"stat\">\n            <span class=\"stat-label\">{label}</span>\n            <strong class=\"stat-value\">{move || value.get()}</strong>\n            <span class=\"stat-trend\">{trend}</span>\n        </div>\n    }\n}\n\n#[component]\npub fn Summary() -> impl IntoView {\n    let (rps, set_rps) = signal(0u32);\n    let value = Signal::derive(move || format!(\"{rps} req/s\"));\n\n    view! {\n        <Stat label=\"Throughput\" value=value trend=\"+4%\" />\n        <button on:click=move |_| set_rps.update(|n| *n += 1)>\"Tick\"</button>\n    }\n}",
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
        "starter": "use leptos::prelude::*;\n\n#[component]\npub fn IncidentFilter() -> impl IntoView {\n    // 1. a signal for the query\n    // 2. a Memo over a fixed list of incident titles\n    // 3. a view with <input> and an aria-live status line\n    todo!()\n}",
        "hint": "query.get() inside the memo is the dependency. Render the status with a closure so it updates in place: move || format!(\"{} matches\", count.get()).",
        "solution": "use leptos::prelude::*;\n\nconst TITLES: &[&str] = &[\n    \"checkout latency spike\",\n    \"kafka consumer lag\",\n    \"tls certificate expiring\",\n    \"disk pressure on node-7\",\n];\n\n#[component]\npub fn IncidentFilter() -> impl IntoView {\n    let (query, set_query) = signal(String::new());\n\n    let matches = Memo::new(move |_| {\n        let q = query.get().to_lowercase();\n        TITLES\n            .iter()\n            .filter(|t| q.is_empty() || t.to_lowercase().contains(&q))\n            .count()\n    });\n\n    view! {\n        <label for=\"incident-query\">\"Filter incidents\"</label>\n        <input\n            id=\"incident-query\"\n            type=\"search\"\n            prop:value=move || query.get()\n            on:input=move |ev| set_query.set(event_target_value(&ev))\n        />\n        <p role=\"status\" aria-live=\"polite\">\n            {move || format!(\"{} matches\", matches.get())}\n        </p>\n    }\n}"
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
        {
          "name": "leptos-rs/leptos",
          "url": "https://github.com/leptos-rs/leptos"
        },
        {
          "name": "leptos-rs/start-axum — SSR starter template",
          "url": "https://github.com/leptos-rs/start-axum"
        }
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
          "code": "use yew::prelude::*;\n\n#[derive(Properties, PartialEq)]\npub struct GaugeProps {\n    pub label: AttrValue,\n    pub value: f64,\n    #[prop_or_default]\n    pub unit: Option<AttrValue>,\n}\n\n#[function_component]\npub fn Gauge(props: &GaugeProps) -> Html {\n    let pct = (props.value.clamp(0.0, 1.0) * 100.0).round();\n    let unit = props.unit.clone().unwrap_or_else(|| AttrValue::from(\"%\"));\n\n    html! {\n        <div class=\"gauge\" role=\"img\"\n             aria-label={format!(\"{}: {} {}\", props.label, pct, unit)}>\n            <span class=\"gauge-label\">{ props.label.clone() }</span>\n            <meter min=\"0\" max=\"100\" value={pct.to_string()}>\n                { format!(\"{pct}{unit}\") }\n            </meter>\n        </div>\n    }\n}",
          "tip": "AttrValue is a cheap-to-clone string handle; use it in props instead of String so cloning during render does not allocate."
        },
        {
          "h": "Hooks hold state across renders",
          "p": [
            "use_state returns a handle whose set() schedules a re-render. use_reducer is better when transitions have names: the reducer owns the transition function, and dispatchers can be cloned into children without dragging setters along. use_memo and use_callback exist to keep values and callbacks stable so children can skip renders.",
            "Every hook runs on every render in call order. That is why hooks cannot be called conditionally, and why a callback created inline in html! is a new value on every render — passing it to a memoized child defeats the equality check you just wrote."
          ],
          "code": "use std::rc::Rc;\nuse yew::prelude::*;\n\n#[derive(Clone, PartialEq)]\npub struct Filters {\n    pub query: String,\n    pub errors_only: bool,\n}\n\npub enum FilterAction {\n    Query(String),\n    ToggleErrors,\n    Reset,\n}\n\nimpl Reducible for Filters {\n    type Action = FilterAction;\n\n    fn reduce(self: Rc<Self>, action: Self::Action) -> Rc<Self> {\n        let mut next = (*self).clone();\n        match action {\n            FilterAction::Query(q) => next.query = q,\n            FilterAction::ToggleErrors => next.errors_only = !next.errors_only,\n            FilterAction::Reset => next = Filters { query: String::new(), errors_only: false },\n        }\n        Rc::new(next)\n    }\n}\n\n#[function_component]\npub fn FilterBar() -> Html {\n    let filters = use_reducer(|| Filters { query: String::new(), errors_only: false });\n\n    let oninput = {\n        let filters = filters.clone();\n        Callback::from(move |e: InputEvent| {\n            let input: web_sys::HtmlInputElement = e.target_unchecked_into();\n            filters.dispatch(FilterAction::Query(input.value()));\n        })\n    };\n\n    html! {\n        <label>\n            { \"Filter\" }\n            <input type=\"search\" {oninput} value={filters.query.clone()} />\n        </label>\n    }\n}",
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
        "starter": "use yew::prelude::*;\n\n#[derive(Clone, PartialEq)]\npub struct Incident {\n    pub id: u32,\n    pub title: AttrValue,\n}\n\n#[function_component]\npub fn IncidentList() -> Html {\n    // 1. use_state for the query\n    // 2. filter in render\n    // 3. a Row component with PartialEq props\n    todo!()\n}",
        "hint": "Give Row a Properties struct with a single Incident field and derive PartialEq. AttrValue makes the String comparison cheap, and the key keeps DOM nodes stable.",
        "solution": "use yew::prelude::*;\n\n#[derive(Clone, PartialEq)]\npub struct Incident {\n    pub id: u32,\n    pub title: AttrValue,\n}\n\n#[derive(Properties, PartialEq)]\npub struct RowProps {\n    pub incident: Incident,\n}\n\n#[function_component]\nfn Row(props: &RowProps) -> Html {\n    html! {\n        <li class=\"row\">\n            <span class=\"id\">{ props.incident.id }</span>\n            { props.incident.title.clone() }\n        </li>\n    }\n}\n\n#[function_component]\npub fn IncidentList() -> Html {\n    let incidents = use_state(|| vec![\n        Incident { id: 1, title: AttrValue::from(\"checkout latency spike\") },\n        Incident { id: 2, title: AttrValue::from(\"kafka consumer lag\") },\n        Incident { id: 3, title: AttrValue::from(\"disk pressure on node-7\") },\n    ]);\n    let query = use_state(String::new);\n\n    let oninput = {\n        let query = query.clone();\n        Callback::from(move |e: InputEvent| {\n            let input: web_sys::HtmlInputElement = e.target_unchecked_into();\n            query.set(input.value());\n        })\n    };\n\n    let needle = query.to_lowercase();\n    let visible: Vec<Incident> = incidents\n        .iter()\n        .filter(|i| needle.is_empty() || i.title.to_lowercase().contains(&needle))\n        .cloned()\n        .collect();\n\n    html! {\n        <>\n            <input type=\"search\" {oninput} value={(*query).clone()} />\n            <ul class=\"incidents\">\n                { for visible.iter().map(|i| html! {\n                    <Row key={i.id} incident={i.clone()} />\n                }) }\n            </ul>\n        </>\n    }\n}"
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
        {
          "name": "yewstack/yew",
          "url": "https://github.com/yewstack/yew"
        },
        {
          "name": "rustwasm/gloo — the web API layer Yew depends on",
          "url": "https://github.com/ranile/gloo"
        }
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
          "code": "use dioxus::prelude::*;\n\n#[derive(Props, Clone, PartialEq)]\nstruct CardProps {\n    title: String,\n    #[props(default)]\n    subtitle: Option<String>,\n}\n\n#[component]\nfn MetricCard(props: CardProps) -> Element {\n    rsx! {\n        article { class: \"card\",\n            h3 { \"{props.title}\" }\n            if let Some(sub) = props.subtitle.as_ref() {\n                p { class: \"sub\", \"{sub}\" }\n            }\n        }\n    }\n}\n\nfn App() -> Element {\n    let mut rps = use_signal(|| 0u32);\n\n    rsx! {\n        MetricCard {\n            title: \"Throughput\".to_string(),\n            subtitle: Some(\"requests per second\".to_string()),\n        }\n        p { \"Current: {rps}\" }\n        button { onclick: move |_| rps += 1, \"Tick\" }\n    }\n}\n\nfn main() {\n    dioxus::launch(App);\n}",
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
        "starter": "use dioxus::prelude::*;\n\n#[derive(Props, Clone, PartialEq)]\nstruct BadgeProps {\n    // status: String\n    // detail: Option<String>, defaulted\n}\n\n#[component]\nfn StatusBadge(props: BadgeProps) -> Element {\n    todo!()\n}\n\nfn App() -> Element {\n    // a signal toggling one badge between \"degraded\" and \"healthy\"\n    todo!()\n}",
        "hint": "#[props(default)] makes an Option prop optional. Use rsx! with if let Some(detail) to render the second line, and a signal read as {state} inside a string literal.",
        "solution": "use dioxus::prelude::*;\n\n#[derive(Props, Clone, PartialEq)]\nstruct BadgeProps {\n    status: String,\n    #[props(default)]\n    detail: Option<String>,\n}\n\n#[component]\nfn StatusBadge(props: BadgeProps) -> Element {\n    let class = match props.status.as_str() {\n        \"healthy\" => \"badge badge-ok\",\n        \"degraded\" => \"badge badge-warn\",\n        _ => \"badge badge-bad\",\n    };\n\n    rsx! {\n        div { class: \"{class}\", role: \"status\",\n            strong { \"{props.status}\" }\n            if let Some(detail) = props.detail.as_ref() {\n                span { class: \"detail\", \"{detail}\" }\n            }\n        }\n    }\n}\n\nfn App() -> Element {\n    let mut degraded = use_signal(|| false);\n    let status = if degraded() { \"degraded\" } else { \"healthy\" };\n\n    rsx! {\n        StatusBadge { status: \"healthy\".to_string(), detail: Some(\"all checks passing\".to_string()) }\n        StatusBadge { status: status.to_string() }\n        StatusBadge { status: \"unavailable\".to_string(), detail: Some(\"api timeout\".to_string()) }\n        button {\n            onclick: move |_| degraded.toggle(),\n            \"Toggle middle badge\"\n        }\n    }\n}"
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
        {
          "name": "DioxusLabs/dioxus",
          "url": "https://github.com/DioxusLabs/dioxus"
        }
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
          "code": "# Cargo.toml\n[dependencies]\nwasm-bindgen = \"0.2\"\nweb-sys = { version = \"0.3\", features = [\n    \"Document\",\n    \"Element\",\n    \"HtmlElement\",\n    \"HtmlInputElement\",\n    \"KeyboardEvent\",\n    \"Window\",\n] }\n\n# src/lib.rs\nuse wasm_bindgen::JsCast;\n\npub fn wire_search() -> Result<(), wasm_bindgen::JsValue> {\n    let window = web_sys::window().ok_or(\"no window\")?;\n    let document = window.document().ok_or(\"no document\")?;\n    let input = document\n        .get_element_by_id(\"search\")\n        .ok_or(\"missing #search\")?\n        .dyn_into::<web_sys::HtmlInputElement>()?;\n    input.set_placeholder(\"Filter incidents\");\n    input.focus()?;\n    Ok(())\n}",
          "tip": "dyn_into returns Result, dyn_ref returns Option. Use dyn_ref when a null is a normal outcome and dyn_into when the wrong type is a bug."
        },
        {
          "h": "Reads, writes and forced reflow",
          "p": [
            "Every getter and setter is a JavaScript call, and some of them are worse than others. Reading offset_width or getBoundingClientRect forces the browser to flush pending style and layout. A loop that reads, writes, then reads again can force dozens of reflows and turn a 200-element list into a 100 ms frame. The cost is not the call itself but the flush it triggers, which can revalidate style for the whole document.",
            "The fix is mechanical: collect every read first, then perform every write, ideally inside a single animation frame. The DOM stays the same; the number of layout flushes drops from N to one. That structural change is usually worth more than any micro-optimization inside the loop itself."
          ],
          "code": "use wasm_bindgen::prelude::*;\nuse wasm_bindgen::JsCast;\n\npub fn widen_all(selector: &str) -> Result<(), JsValue> {\n    let document = web_sys::window().unwrap().document().unwrap();\n    let nodes = document.query_selector_all(selector)?;\n\n    // Pass 1: read everything (one layout flush).\n    let mut widths = Vec::with_capacity(nodes.length() as usize);\n    for i in 0..nodes.length() {\n        let el = nodes\n            .item(i)\n            .and_then(|n| n.dyn_into::<web_sys::HtmlElement>().ok());\n        if let Some(el) = el {\n            widths.push(el.offset_width());\n        }\n    }\n\n    // Pass 2: write once, on the next frame.\n    let window = web_sys::window().unwrap();\n    let closure = Closure::once(move || {\n        for (i, w) in widths.into_iter().enumerate() {\n            let el = nodes\n                .item(i as u32)\n                .and_then(|n| n.dyn_into::<web_sys::HtmlElement>().ok());\n            if let Some(el) = el {\n                let _ = el.style().set_property(\"width\", &format!(\"{}px\", w + 8));\n            }\n        }\n    });\n    window.request_animation_frame(closure.into_js_value().unchecked_ref())?;\n    Ok(())\n}",
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
        "starter": "use wasm_bindgen::prelude::*;\nuse wasm_bindgen::JsCast;\n\npub fn wire_echo() -> Result<(), JsValue> {\n    // 1. query #echo-input as HtmlInputElement\n    // 2. query #echo-output as HtmlElement\n    // 3. on click: read value, write text, toggle class\n    todo!()\n}",
        "hint": "Store the closure in a struct or leak it deliberately with into_js_value; the input's value() returns String, and class_list().toggle_with_force(\"empty\", bool) sets the class deterministically.",
        "solution": "use wasm_bindgen::prelude::*;\nuse wasm_bindgen::JsCast;\nuse web_sys::{HtmlElement, HtmlInputElement};\n\npub fn wire_echo() -> Result<(), JsValue> {\n    let document = web_sys::window().unwrap().document().unwrap();\n\n    let input = document\n        .get_element_by_id(\"echo-input\")\n        .ok_or(\"missing #echo-input\")?\n        .dyn_into::<HtmlInputElement>()?;\n\n    let output = document\n        .get_element_by_id(\"echo-output\")\n        .ok_or(\"missing #echo-output\")?\n        .dyn_into::<HtmlElement>()?;\n\n    let button = document\n        .get_element_by_id(\"echo-run\")\n        .ok_or(\"missing #echo-run\")?\n        .dyn_into::<HtmlElement>()?;\n\n    let onclick = {\n        let input = input.clone();\n        let output = output.clone();\n        Closure::<dyn FnMut()>::new(move || {\n            let value = input.value();\n            output.set_text_content(Some(&value));\n            let empty = value.trim().is_empty();\n            let _ = output.class_list().toggle_with_force(\"empty\", empty);\n            let _ = output.set_attribute(\"aria-invalid\", if empty { \"true\" } else { \"false\" });\n        })\n    };\n\n    button.add_event_listener_with_callback(\"click\", onclick.as_ref().unchecked_ref())?;\n    onclick.forget(); // page-lifetime listener: intentionally leaked\n\n    Ok(())\n}"
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
        {
          "name": "wasm-bindgen/wasm-bindgen — web-sys lives in crates/web-sys",
          "url": "https://github.com/wasm-bindgen/wasm-bindgen"
        },
        {
          "name": "rustwasm/gloo — higher-level wrappers over web-sys",
          "url": "https://github.com/ranile/gloo"
        }
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
          "code": "// app/src/lib.rs\nuse leptos::prelude::*;\nuse leptos_meta::{provide_meta_context, MetaTags, Stylesheet, Title};\n\npub fn shell(options: LeptosOptions) -> impl IntoView {\n    view! {\n        <!DOCTYPE html>\n        <html lang=\"en\">\n            <head>\n                <meta charset=\"utf-8\"/>\n                <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"/>\n                <HydrationScripts options/>\n                <MetaTags/>\n            </head>\n            <body>\n                <App/>\n            </body>\n        </html>\n    }\n}\n\n#[component]\npub fn App() -> impl IntoView {\n    provide_meta_context();\n\n    view! {\n        <Title text=\"Ops dashboard\"/>\n        <Stylesheet id=\"leptos\" href=\"/pkg/dashboard.css\"/>\n        <main>\n            <h1>\"Fleet overview\"</h1>\n            <MetricsTable/>\n        </main>\n    }\n}",
          "tip": "HydrationScripts must be inside <head>: it emits the script that loads the wasm and the serialized resource data the client will reuse."
        },
        {
          "h": "Wiring axum to the renderer",
          "p": [
            "generate_route_list walks the router in your app and produces the routes axum must serve, so the server never duplicates a route table by hand. leptos_routes then owns rendering for those paths, and file_and_error_handler serves the hashed JS and wasm assets plus a 404 fallback.",
            "Server functions are the other half. A #[server] function runs in-process during SSR and becomes an HTTP endpoint for the client, so the resource that renders on the server does not refetch during hydration — the serialized value is already in the HTML."
          ],
          "code": "use axum::Router;\nuse leptos::config::get_configuration;\nuse leptos_axum::{generate_route_list, LeptosRoutes};\n\n#[tokio::main]\nasync fn main() {\n    let conf = get_configuration(Some(\"Cargo.toml\")).unwrap();\n    let leptos_options = conf.leptos_options;\n    let addr = leptos_options.site_addr;\n    let routes = generate_route_list(App);\n\n    let app = Router::new()\n        .leptos_routes(&leptos_options, routes, {\n            let options = leptos_options.clone();\n            move || shell(options.clone())\n        })\n        .fallback(leptos_axum::file_and_error_handler(shell))\n        .with_state(leptos_options);\n\n    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();\n    println!(\"listening on {addr}\");\n    axum::serve(listener, app.into_make_service()).await.unwrap();\n}",
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
          "code": "// app/src/main.rs — the client entry point\n#[cfg(feature = \"hydrate\")]\n#[wasm_bindgen::prelude::wasm_bindgen]\npub fn hydrate() {\n    console_error_panic_hook::set_once();\n    leptos::mount::hydrate_body(App);\n}\n\n#[cfg(not(feature = \"hydrate\"))]\nfn main() {\n    // The server binary uses the axum entry point instead.\n}\n\n// Deterministic render: no clock, no randomness, no storage reads.\n#[component]\npub fn Uptime(seconds: u64) -> impl IntoView {\n    view! { <span class=\"uptime\">{format_duration(seconds)}</span> }\n}",
          "tip": "If hydration panics, diff the first bytes of the served HTML against view-source of the client render: the first divergence is the component that read the environment."
        }
      ],
      "exercise": {
        "prompt": "Add a server function that returns metric rows and a component that renders them inside Suspense. The HTML must already contain the rows, and the client must not refetch them during hydration.",
        "starter": "use leptos::prelude::*;\n\n#[server]\npub async fn metrics() -> Result<Vec<Metric>, ServerFnError> {\n    todo!()\n}\n\n#[component]\npub fn MetricsTable() -> impl IntoView {\n    // 1. Resource::new keyed on ()\n    // 2. Suspense with an aria-busy fallback\n    // 3. render each row\n    todo!()\n}",
        "hint": "Resource::new(|| (), |_| async move { metrics().await }) is enough; Suspense renders the fallback on the server only until the resource resolves, then the data is serialized into the HTML.",
        "solution": "use leptos::prelude::*;\nuse serde::{Deserialize, Serialize};\n\n#[derive(Clone, Debug, Serialize, Deserialize)]\npub struct Metric {\n    pub name: String,\n    pub p95_ms: f64,\n}\n\n#[server]\npub async fn metrics() -> Result<Vec<Metric>, ServerFnError> {\n    // Server-only: replace with your store or database call.\n    Ok(vec![\n        Metric { name: \"checkout\".into(), p95_ms: 182.0 },\n        Metric { name: \"search\".into(), p95_ms: 74.5 },\n    ])\n}\n\n#[component]\npub fn MetricsTable() -> impl IntoView {\n    let rows = Resource::new(|| (), |_| async move { metrics().await });\n\n    view! {\n        <Suspense fallback=|| view! { <p aria-busy=\"true\">\"Loading metrics…\"</p> }>\n            {move || rows.get().map(|result| match result {\n                Ok(list) => view! {\n                    <table>\n                        <thead><tr><th>\"Route\"</th><th>\"p95\"</th></tr></thead>\n                        <tbody>\n                            {list.into_iter().map(|m| view! {\n                                <tr>\n                                    <td>{m.name}</td>\n                                    <td>{format!(\"{:.1} ms\", m.p95_ms)}</td>\n                                </tr>\n                            }).collect_view()}\n                        </tbody>\n                    </table>\n                }.into_any(),\n                Err(e) => view! { <p class=\"error\">{e.to_string()}</p> }.into_any(),\n            })}\n        </Suspense>\n    }\n}"
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
        {
          "name": "leptos-rs/leptos — SSR and hydration examples",
          "url": "https://github.com/leptos-rs/leptos"
        },
        {
          "name": "tokio-rs/axum",
          "url": "https://github.com/tokio-rs/axum"
        }
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
          "code": "use leptos::prelude::*;\n\n#[derive(Clone, Copy, PartialEq, Default)]\npub enum Theme {\n    #[default]\n    Dark,\n    Light,\n}\n\n#[derive(Clone, Copy)]\npub struct Session {\n    pub user: RwSignal<Option<String>>,\n    pub theme: RwSignal<Theme>,\n}\n\n#[component]\npub fn Root() -> impl IntoView {\n    let session = Session {\n        user: RwSignal::new(None),\n        theme: RwSignal::new(Theme::default()),\n    };\n    provide_context(session);\n    view! { <Shell/> }\n}\n\n#[component]\npub fn Shell() -> impl IntoView {\n    let session = use_context::<Session>().expect(\"Root provides Session\");\n    let is_dark = move || session.theme.get() == Theme::Dark;\n\n    view! {\n        <main class:dark=is_dark>\n            <button on:click=move |_| {\n                session.theme.update(|t| {\n                    *t = if *t == Theme::Dark { Theme::Light } else { Theme::Dark }\n                });\n            }>\"Toggle theme\"</button>\n        </main>\n    }\n}",
          "tip": "If a child renders once and never again, you provided a value; if it re-renders too often, you provided one signal where several would do."
        },
        {
          "h": "Server state has its own rules",
          "p": [
            "A Resource is keyed: the source closure decides when to refetch, and the fetcher is async. Read it with get(), which returns Option<Result<T, E>>, so loading, error and ready are explicit states rather than a boolean you have to keep in sync. Mutations go through an Action or a server function, and freshness comes from refetching, not from writing into the cache.",
            "Do not copy a resource value into a signal to make it easier to use. You then own invalidation by hand and lose the SSR serialization that makes hydration free. If a row needs optimistic updates, keep a separate overlay signal and merge it at render time, so the server remains the source of truth."
          ],
          "code": "use leptos::prelude::*;\n\n#[component]\npub fn Incidents() -> impl IntoView {\n    let page = RwSignal::new(1u32);\n    let rows = Resource::new(move || page.get(), |p| async move { fetch_page(p).await });\n\n    view! {\n        <button on:click=move |_| page.update(|p| *p += 1)>\"Next page\"</button>\n        {move || match rows.get() {\n            None => view! { <p aria-busy=\"true\">\"Loading…\"</p> }.into_any(),\n            Some(Err(e)) => view! { <p class=\"error\">{e.to_string()}</p> }.into_any(),\n            Some(Ok(list)) => view! {\n                <ul>{list.into_iter().map(|r| view! { <li>{r.name}</li> }).collect_view()}</ul>\n            }.into_any(),\n        }}\n    }\n}",
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
        "starter": "use leptos::prelude::*;\n\n#[derive(Clone, Copy)]\npub struct Session {\n    pub user: RwSignal<Option<String>>,\n    pub theme: RwSignal<bool>, // true = dark\n}\n\n#[component]\npub fn Header() -> impl IntoView {\n    // read only session.user\n    todo!()\n}",
        "hint": "Read session.user inside its own closure so the header's effect depends on user alone. A closure that reads both signals subscribes to both, and the theme toggle will re-run it.",
        "solution": "use leptos::prelude::*;\n\n#[derive(Clone, Copy)]\npub struct Session {\n    pub user: RwSignal<Option<String>>,\n    pub theme: RwSignal<bool>,\n}\n\n#[component]\npub fn Root() -> impl IntoView {\n    provide_context(Session {\n        user: RwSignal::new(Some(\"ada\".to_string())),\n        theme: RwSignal::new(true),\n    });\n    view! { <Header/> <ThemeToggle/> }\n}\n\n#[component]\npub fn Header() -> impl IntoView {\n    let session = use_context::<Session>().expect(\"Root provides Session\");\n\n    // Only reads user: the theme toggle cannot invalidate this closure.\n    let greeting = move || match session.user.get() {\n        Some(name) => format!(\"Signed in as {name}\"),\n        None => \"Signed out\".to_string(),\n    };\n\n    view! { <header>{greeting}</header> }\n}\n\n#[component]\npub fn ThemeToggle() -> impl IntoView {\n    let session = use_context::<Session>().expect(\"Root provides Session\");\n    view! {\n        <button on:click=move |_| session.theme.update(|t| *t = !*t)>\n            \"Toggle theme\"\n        </button>\n    }\n}"
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
        {
          "name": "leptos-rs/leptos — reactive graph and context",
          "url": "https://github.com/leptos-rs/leptos"
        },
        {
          "name": "DioxusLabs/dioxus — signals and stores implementation",
          "url": "https://github.com/DioxusLabs/dioxus"
        }
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
          "code": "use wasm_bindgen::prelude::*;\n\nfn perf() -> web_sys::Performance {\n    web_sys::window().unwrap().performance().unwrap()\n}\n\npub fn measure<T>(label: &str, f: impl FnOnce() -> T) -> T {\n    let p = perf();\n    let _ = p.mark(label);\n    let out = f();\n    let end = format!(\"{label}-end\");\n    let _ = p.mark(&end);\n    let _ = p.measure_with_start_and_end(label, label, &end);\n    out\n}\n\n// One copy of N values instead of N boundary crossings.\npub fn p95_from(buf: &js_sys::Float64Array) -> f64 {\n    let mut values = buf.to_vec();\n    if values.is_empty() {\n        return 0.0;\n    }\n    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));\n    let idx = ((values.len() - 1) as f64 * 0.95).round() as usize;\n    values[idx]\n}",
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
          "code": "[profile.release]\nopt-level = \"z\"      # size first; use 3 if a hot loop is arithmetic\nlto = \"fat\"\ncodegen-units = 1\npanic = \"abort\"\nstrip = true\n\n# Smaller than any flag: remove unused web-sys features.\n# Then measure the result, compressed:\n#   wasm-opt -Oz -o out.wasm in.wasm\n#   twiggy top -n 20 out.wasm\n#   brotli -q 11 -c out.wasm | wc -c",
          "tip": "panic = \"abort\" removes unwinding machinery, but every panic becomes an unrecoverable instance abort — keep the panic hook installed so you still get a message."
        }
      ],
      "exercise": {
        "prompt": "A chart pulls 10,000 samples with a getter per element. Replace it with a single typed-array transfer, then measure both versions with performance.measure and report the difference.",
        "starter": "use wasm_bindgen::prelude::*;\n\n// Slow: one boundary crossing per element.\npub fn sum_slow(get: &js_sys::Function, len: u32) -> f64 {\n    todo!()\n}\n\n// Fast: one copy, then pure Rust.\npub fn sum_fast(buf: &js_sys::Float64Array) -> f64 {\n    todo!()\n}",
        "hint": "For the slow path, call js_sys::Reflect::get with an index and as_f64(). For the fast path, buf.to_vec() copies once; sum in Rust and return a single f64.",
        "solution": "use wasm_bindgen::prelude::*;\n\npub fn sum_slow(get: &js_sys::Function, len: u32) -> f64 {\n    let this = JsValue::NULL;\n    let mut total = 0.0;\n    for i in 0..len {\n        let idx = JsValue::from_f64(i as f64);\n        if let Ok(v) = get.call1(&this, &idx) {\n            total += v.as_f64().unwrap_or(0.0);\n        }\n    }\n    total\n}\n\npub fn sum_fast(buf: &js_sys::Float64Array) -> f64 {\n    // One copy out of the JS heap, then pure Rust arithmetic.\n    buf.to_vec().iter().sum()\n}\n\npub fn run_benchmark(samples: &js_sys::Float64Array) {\n    let p = web_sys::window().unwrap().performance().unwrap();\n    let _ = p.mark(\"sum-start\");\n    let total = sum_fast(samples); // swap in sum_slow to reproduce the slow path\n    let _ = p.mark(\"sum-end\");\n    let _ = p.measure_with_start_and_end(\"sum\", \"sum-start\", \"sum-end\");\n    web_sys::console::log_1(&JsValue::from_f64(total));\n}"
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
        {
          "name": "rustwasm/twiggy — code size profiler for wasm",
          "url": "https://github.com/AlexEne/twiggy"
        },
        {
          "name": "WebAssembly/binaryen — the wasm-opt optimizer",
          "url": "https://github.com/WebAssembly/binaryen"
        }
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
          "code": "use wasm_bindgen::JsCast;\nuse wasm_bindgen_test::*;\n\nwasm_bindgen_test_configure!(run_in_browser);\n\nfn mount(html: &str) -> web_sys::Element {\n    let document = web_sys::window().unwrap().document().unwrap();\n    let host = document.create_element(\"div\").unwrap();\n    host.set_inner_html(html);\n    document.body().unwrap().append_child(&host).unwrap();\n    host\n}\n\n#[wasm_bindgen_test]\nfn input_value_is_readable() {\n    let host = mount(r#\"<input id=\"q\" value=\"kafka\"><p id=\"status\"></p>\"#);\n    let input = host\n        .query_selector(\"#q\").unwrap().unwrap()\n        .dyn_into::<web_sys::HtmlInputElement>().unwrap();\n    let status = host.query_selector(\"#status\").unwrap().unwrap();\n\n    assert_eq!(input.value(), \"kafka\");\n    status.set_text_content(Some(\"1 match\"));\n    assert_eq!(status.text_content().unwrap(), \"1 match\");\n\n    host.remove();\n}\n\n#[wasm_bindgen_test]\nasync fn awaits_a_promise() {\n    let promise = js_sys::Promise::resolve(&JsValue::from(42));\n    let value = wasm_bindgen_futures::JsFuture::from(promise).await.unwrap();\n    assert_eq!(value.as_f64(), Some(42.0));\n}",
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
        "starter": "use wasm_bindgen_test::*;\nuse wasm_bindgen::JsCast;\n\nwasm_bindgen_test_configure!(run_in_browser);\n\n#[wasm_bindgen_test]\nfn typing_updates_status() {\n    // 1. mount <input id=\"q\"> and <p id=\"status\">\n    // 2. set the value and dispatch an \"input\" event\n    // 3. assert the status text\n}",
        "hint": "Create the event with web_sys::Event::new(\"input\"), then input.dispatch_event(&event). Handle the event synchronously in the test so no await is needed.",
        "solution": "use wasm_bindgen::prelude::*;\nuse wasm_bindgen::JsCast;\nuse wasm_bindgen_test::*;\n\nwasm_bindgen_test_configure!(run_in_browser);\n\n#[wasm_bindgen_test]\nfn typing_updates_status() {\n    let document = web_sys::window().unwrap().document().unwrap();\n    let host = document.create_element(\"div\").unwrap();\n    host.set_inner_html(r#\"<input id=\"q\" value=\"\"><p id=\"status\">3 matches</p>\"#);\n    document.body().unwrap().append_child(&host).unwrap();\n\n    let input = host\n        .query_selector(\"#q\").unwrap().unwrap()\n        .dyn_into::<web_sys::HtmlInputElement>().unwrap();\n    let status = host.query_selector(\"#status\").unwrap().unwrap();\n\n    let handler = {\n        let status = status.clone();\n        Closure::<dyn FnMut(web_sys::Event)>::new(move |_ev| {\n            status.set_text_content(Some(\"1 match\"));\n        })\n    };\n    input\n        .add_event_listener_with_callback(\"input\", handler.as_ref().unchecked_ref())\n        .unwrap();\n\n    input.set_value(\"kafka\");\n    let event = web_sys::Event::new(\"input\").unwrap();\n    input.dispatch_event(&event).unwrap();\n\n    assert_eq!(status.text_content().unwrap(), \"1 match\");\n    drop(handler);\n    host.remove();\n}"
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
        {
          "name": "wasm-bindgen/wasm-bindgen — wasm-bindgen-test lives in crates/test",
          "url": "https://github.com/wasm-bindgen/wasm-bindgen"
        },
        {
          "name": "dequelabs/axe-core — accessibility assertions for the e2e layer",
          "url": "https://github.com/dequelabs/axe-core"
        }
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
          "code": "<!-- index.html -->\n<!DOCTYPE html>\n<html lang=\"en\">\n  <head>\n    <meta charset=\"utf-8\"/>\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"/>\n    <title>Ops dashboard</title>\n    <link data-trunk rel=\"css\" href=\"styles/app.css\"/>\n    <link data-trunk rel=\"rust\" data-wasm-opt=\"z\"/>\n  </head>\n  <body></body>\n</html>\n\n# Trunk.toml\n[build]\ntarget = \"index.html\"\ndist = \"dist\"\nrelease = true\n\n[serve]\naddresses = [\"127.0.0.1\"]\nport = 8080",
          "tip": "data-wasm-opt=\"z\" asks Trunk to run wasm-opt at size priority; drop the attribute while debugging, because optimized output is much harder to read in a profiler."
        },
        {
          "h": "A budget is a test",
          "p": [
            "A size budget is only real if it fails a build. Build in release, compress with brotli, compare against a committed number, and exit non-zero above it. Without that, sizes creep by tens of kilobytes per feature and nobody notices until mobile users on a slow connection do.",
            "Track the wasm and the JS separately. A growing glue file usually means duplicated bindings or two wasm-bindgen versions in the dependency graph; cargo tree -i wasm-bindgen finds the second copy, and two copies both ship and both register types. Size regressions are rarely one big dependency; they are five small ones plus a duplicated binding crate, which is why the number must be tracked rather than eyeballed."
          ],
          "code": "# .github/workflows/ci.yml (excerpt)\n- name: build\n  run: trunk build --release\n\n- name: size budget\n  run: |\n    set -euo pipefail\n    WASM=$(ls dist/*.wasm | head -1)\n    JS=$(ls dist/*.js | head -1)\n    W=$(brotli -q 11 -c \"$WASM\" | wc -c | tr -d ' ')\n    J=$(brotli -q 11 -c \"$JS\" | wc -c | tr -d ' ')\n    echo \"wasm $W bytes (budget 180000), js $J bytes (budget 60000)\"\n    test \"$W\" -le 180000\n    test \"$J\" -le 60000",
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
        "starter": "# 1. build\n# 2. find the wasm\n# 3. compress and count bytes\n# 4. compare against a budget",
        "hint": "brotli -q 11 -c file | wc -c gives the compressed size; set -euo pipefail makes any failing command abort the step. For the jump, check cargo tree -i wasm-bindgen and the diff in web-sys features.",
        "solution": "#!/usr/bin/env bash\nset -euo pipefail\n\nBUDGET=${BUDGET:-180000}\n\ntrunk build --release\n\nWASM=$(find dist -maxdepth 1 -name '*.wasm' | head -1)\nif [ -z \"$WASM\" ]; then\n  echo \"no wasm produced\" >&2\n  exit 1\nfi\n\nBYTES=$(brotli -q 11 -c \"$WASM\" | wc -c | tr -d ' ')\necho \"compressed wasm: $BYTES bytes (budget $BUDGET)\"\n\nif [ \"$BYTES\" -gt \"$BUDGET\" ]; then\n  echo \"size budget exceeded by $((BYTES - BUDGET)) bytes\" >&2\n  # First checks: duplicate wasm-bindgen versions, new web-sys features,\n  # a dependency that pulled in std formatting or regex.\n  cargo tree -i wasm-bindgen || true\n  exit 1\nfi"
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
        {
          "name": "trunk-rs/trunk",
          "url": "https://github.com/trunk-rs/trunk"
        },
        {
          "name": "WebAssembly/binaryen",
          "url": "https://github.com/WebAssembly/binaryen"
        }
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
          "url": "https://developer.mozilla.org/en-US/docs/WebAssembly/Guides/Concepts",
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
          "code": "# Produce a browser package with an async init().\nwasm-pack build --release --target web --out-dir pkg --out-name dashboard\n\n# What you actually ship:\nls pkg\n# dashboard.js       ESM glue with init()\n# dashboard_bg.wasm  the module itself\n# dashboard.d.ts     generated TypeScript types\n# package.json       module/types/files entries\n\n# Run the browser test suite headless.\nwasm-pack test --headless --chrome\n\n# Cargo.toml metadata wasm-pack uses\n# [package]\n# description = \"Ops dashboard rendered in Rust\"\n# license = \"MIT OR Apache-2.0\"\n# repository = \"https://github.com/acme/dashboard\"\n#\n# [lib]\n# crate-type = [\"cdylib\", \"rlib\"]",
          "tip": "Keep rlib in crate-type: it lets cargo test run your pure logic natively while cdylib produces the wasm artifact."
        },
        {
          "h": "Consuming the package",
          "p": [
            "init() resolves once the wasm is instantiated, so every exported symbol must be used after that await. With --target web, init optionally takes a URL or Request, which is how you point at a CDN, a hashed filename, or a copy served from a different path.",
            "The generated .d.ts is part of the contract. Review it in the same diff as the Rust change: a Struct field that becomes Option<T> changes the TypeScript type, and a consumer's build should fail rather than silently pass undefined. Treat that file as generated API: diff it, review it, never hand-edit it."
          ],
          "code": "import init, { Dashboard } from \"./pkg/dashboard.js\";\n\n// 1. Instantiate before touching any export.\nawait init();\n\nconst dashboard = new Dashboard();\ndashboard.push(12.5);\ndashboard.push(31.0);\nconsole.log(dashboard.snapshot()); // { samples: 2, p95_ms: 31 }\n\n// JS has no destructor for the Rust value.\ndashboard.free();",
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
        "starter": "# 1. build for the web target with an out-dir and out-name\n# 2. write the JS that awaits init()\n\nimport init, { Counter } from \"./pkg/counter.js\";",
        "hint": "The generated default export is the init function; named exports are your #[wasm_bindgen] items. Nothing works before await init() resolves.",
        "solution": "# Build\nwasm-pack build --release --target web --out-dir pkg --out-name counter\n\n// main.js\nimport init, { Counter } from \"./pkg/counter.js\";\n\nawait init(); // fetches and instantiates counter_bg.wasm\n\nconst counter = new Counter();\ncounter.increment();\ncounter.increment();\n\nconsole.log(counter.value); // 2\ncounter.free();\n\n// Rust side that this consumes:\n//\n// #[wasm_bindgen]\n// pub struct Counter { value: u32 }\n//\n// #[wasm_bindgen]\n// impl Counter {\n//     #[wasm_bindgen(constructor)]\n//     pub fn new() -> Counter { Counter { value: 0 } }\n//\n//     pub fn increment(&mut self) { self.value += 1; }\n//\n//     #[wasm_bindgen(getter)]\n//     pub fn value(&self) -> u32 { self.value }\n// }"
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
        {
          "name": "wasm-bindgen/wasm-pack",
          "url": "https://github.com/wasm-bindgen/wasm-pack"
        },
        {
          "name": "wasm-bindgen/wasm-bindgen",
          "url": "https://github.com/wasm-bindgen/wasm-bindgen"
        }
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
          "code": "use wasm_bindgen::prelude::*;\nuse wasm_bindgen::JsCast;\nuse web_sys::{Worker, WorkerOptions, WorkerType};\n\npub struct Aggregator {\n    worker: Worker,\n    on_message: Closure<dyn FnMut(web_sys::MessageEvent)>,\n}\n\nimpl Aggregator {\n    pub fn spawn(script: &str) -> Result<Self, JsValue> {\n        let options = WorkerOptions::new();\n        options.set_type(WorkerType::Module);\n        let worker = Worker::new_with_options(script, &options)?;\n\n        let on_message = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(\n            move |event: web_sys::MessageEvent| {\n                if let Some(text) = event.data().as_string() {\n                    leptos::logging::log!(\"worker: {text}\");\n                }\n            },\n        );\n        worker.set_onmessage(Some(on_message.as_ref().unchecked_ref()));\n\n        Ok(Self { worker, on_message })\n    }\n\n    pub fn send(&self, text: &str) -> Result<(), JsValue> {\n        self.worker.post_message(&JsValue::from_str(text))\n    }\n\n    pub fn terminate(self) {\n        self.worker.terminate();\n    }\n}",
          "tip": "Call terminate() instead of dropping the Worker: a dropped handle does not stop the thread, and the worker keeps receiving messages nobody handles."
        },
        {
          "h": "Shared memory is a different tier",
          "p": [
            "The threads proposal adds SharedArrayBuffer and atomics, and browsers only expose them on cross-origin-isolated pages. That means Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp on every response, plus a build with the atomics target features. No headers, no SharedArrayBuffer, regardless of what the Rust code does.",
            "wasm-bindgen-rayon builds a Rayon thread pool on top of that, so par_iter can run across workers inside one wasm module. It is genuinely useful for CPU-bound work and it is a commitment: every page that loads the module must be isolated from cross-origin resources, and every dependency must be built for the atomics target."
          ],
          "code": "# 1. Build for atomics (build-std requires a nightly toolchain).\nRUSTFLAGS='-C target-feature=+atomics,+bulk-memory,+mutable-globals' \\\n  cargo build --target wasm32-unknown-unknown --release \\\n  -Z build-std=std,panic_abort\n\n# 2. The server must send both headers on every response,\n#    including the worker script and the wasm binary:\n#    Cross-Origin-Opener-Policy: same-origin\n#    Cross-Origin-Embedder-Policy: require-corp\n\n# 3. Verify before shipping: in the console,\n#    typeof SharedArrayBuffer === \"object\"  // false means no isolation",
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
        "starter": "use wasm_bindgen::prelude::*;\nuse web_sys::Worker;\n\npub struct Client {\n    // worker + closure\n}\n\nimpl Client {\n    pub fn spawn(url: &str) -> Result<Self, JsValue> {\n        // WorkerOptions with WorkerType::Module\n        todo!()\n    }\n\n    pub fn send(&self, msg: &str) -> Result<(), JsValue> {\n        todo!()\n    }\n}",
        "hint": "set_onmessage takes Option<&Function>, and the closure must live in the struct or it is dropped as soon as spawn returns.",
        "solution": "use wasm_bindgen::prelude::*;\nuse wasm_bindgen::JsCast;\nuse web_sys::{Worker, WorkerOptions, WorkerType};\n\npub struct Client {\n    worker: Worker,\n    on_message: Closure<dyn FnMut(web_sys::MessageEvent)>,\n}\n\nimpl Client {\n    pub fn spawn(url: &str) -> Result<Self, JsValue> {\n        let options = WorkerOptions::new();\n        options.set_type(WorkerType::Module);\n        let worker = Worker::new_with_options(url, &options)?;\n\n        let on_message = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(\n            move |event: web_sys::MessageEvent| {\n                let data = event.data();\n                if let Some(text) = data.as_string() {\n                    web_sys::console::log_1(&JsValue::from_str(&format!(\"reply: {text}\")));\n                }\n            },\n        );\n        worker.set_onmessage(Some(on_message.as_ref().unchecked_ref()));\n\n        Ok(Self { worker, on_message })\n    }\n\n    pub fn send(&self, msg: &str) -> Result<(), JsValue> {\n        self.worker.post_message(&JsValue::from_str(msg))\n    }\n\n    pub fn shutdown(self) {\n        self.worker.terminate();\n    }\n}\n\n// worker.js\n// self.onmessage = async (ev) => {\n//   const { default: init, aggregate } = await import(\"./pkg/app.js\");\n//   await init();\n//   self.postMessage(JSON.stringify(aggregate(ev.data)));\n// };"
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
        {
          "name": "GoogleChromeLabs/wasm-bindgen-rayon",
          "url": "https://github.com/GoogleChromeLabs/wasm-bindgen-rayon"
        },
        {
          "name": "wasm-bindgen/wasm-bindgen — Worker bindings live in web-sys",
          "url": "https://github.com/wasm-bindgen/wasm-bindgen"
        }
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
          "code": "use wasm_bindgen::prelude::*;\nuse wasm_bindgen::JsCast;\nuse web_sys::{CanvasRenderingContext2d, HtmlCanvasElement};\n\npub fn draw_sparkline(canvas: &HtmlCanvasElement, values: &[f64]) -> Result<(), JsValue> {\n    let dpr = web_sys::window().unwrap().device_pixel_ratio();\n    let css_w = canvas.client_width() as f64;\n    let css_h = canvas.client_height() as f64;\n\n    canvas.set_width((css_w * dpr) as u32);\n    canvas.set_height((css_h * dpr) as u32);\n\n    let ctx = canvas\n        .get_context(\"2d\")?\n        .ok_or(\"no 2d context\")?\n        .dyn_into::<CanvasRenderingContext2d>()?;\n\n    ctx.scale(dpr, dpr)?;\n    ctx.clear_rect(0.0, 0.0, css_w, css_h);\n\n    let max = values.iter().copied().fold(f64::MIN, f64::max).max(1.0);\n    let span = (values.len().max(2) - 1) as f64;\n\n    ctx.set_stroke_style_str(\"#4ade80\");\n    ctx.set_line_width(2.0);\n    ctx.begin_path();\n    for (i, v) in values.iter().enumerate() {\n        let x = (i as f64 / span) * css_w;\n        let y = css_h - (v / max) * css_h;\n        if i == 0 {\n            ctx.move_to(x, y);\n        } else {\n            ctx.line_to(x, y);\n        }\n    }\n    ctx.stroke();\n    Ok(())\n}",
          "tip": "Re-setting canvas.width clears the bitmap and resets the transform; do it on resize only, not on every frame."
        },
        {
          "h": "WebGL is a state machine with silent failures",
          "p": [
            "WebGL means compiling shaders, linking a program, uploading buffers, setting uniforms and drawing. web-sys exposes WebGlRenderingContext and WebGl2RenderingContext, but the code is verbose and failures are quiet: a shader that fails to compile returns null, and the reason is only in get_shader_info_log. That silence defines the API: nothing throws, and a black canvas is the only symptom.",
            "Write a small helper that compiles, checks, and returns Result with the log attached. That single function saves hours, because the alternative is a black canvas and no message. It pays for itself the first time a shader fails at 2 a.m., when the only other signal is a black rectangle. Write it before any drawing code."
          ],
          "code": "pub fn compile_shader(\n    gl: &web_sys::WebGl2RenderingContext,\n    kind: u32,\n    source: &str,\n) -> Result<web_sys::WebGlShader, String> {\n    let shader = gl.create_shader(kind).ok_or(\"create_shader failed\")?;\n    gl.shader_source(&shader, source);\n    gl.compile_shader(&shader);\n\n    if gl\n        .get_shader_parameter(&shader, web_sys::WebGl2RenderingContext::COMPILE_STATUS)\n        .as_bool()\n        .unwrap_or(false)\n    {\n        Ok(shader)\n    } else {\n        Err(gl\n            .get_shader_info_log(&shader)\n            .unwrap_or_else(|| \"unknown shader error\".to_string()))\n    }\n}\n\npub fn link_program(\n    gl: &web_sys::WebGl2RenderingContext,\n    vs: &web_sys::WebGlShader,\n    fs: &web_sys::WebGlShader,\n) -> Result<web_sys::WebGlProgram, String> {\n    let program = gl.create_program().ok_or(\"create_program failed\")?;\n    gl.attach_shader(&program, vs);\n    gl.attach_shader(&program, fs);\n    gl.link_program(&program);\n    if gl\n        .get_program_parameter(&program, web_sys::WebGl2RenderingContext::LINK_STATUS)\n        .as_bool()\n        .unwrap_or(false)\n    {\n        Ok(program)\n    } else {\n        Err(gl.get_program_info_log(&program).unwrap_or_default())\n    }\n}",
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
        "starter": "use wasm_bindgen::prelude::*;\nuse web_sys::HtmlCanvasElement;\n\npub fn draw_bars(canvas: &HtmlCanvasElement, values: &[f64]) -> Result<(), JsValue> {\n    // 1. size for devicePixelRatio\n    // 2. get the 2d context and scale\n    // 3. draw one filled rect per value\n    todo!()\n}",
        "hint": "set_fill_style_str picks the colour; fill_rect(x, y, w, h) draws in CSS units once the context is scaled by dpr. For accessibility, a <table> with the same numbers plus an aria-label or a visually-hidden summary is enough.",
        "solution": "use wasm_bindgen::prelude::*;\nuse wasm_bindgen::JsCast;\nuse web_sys::{CanvasRenderingContext2d, HtmlCanvasElement};\n\npub fn draw_bars(canvas: &HtmlCanvasElement, values: &[f64]) -> Result<(), JsValue> {\n    let dpr = web_sys::window().unwrap().device_pixel_ratio();\n    let css_w = canvas.client_width() as f64;\n    let css_h = canvas.client_height() as f64;\n    canvas.set_width((css_w * dpr) as u32);\n    canvas.set_height((css_h * dpr) as u32);\n\n    let ctx = canvas\n        .get_context(\"2d\")?\n        .ok_or(\"no 2d context\")?\n        .dyn_into::<CanvasRenderingContext2d>()?;\n    ctx.scale(dpr, dpr)?;\n    ctx.clear_rect(0.0, 0.0, css_w, css_h);\n\n    if values.is_empty() {\n        return Ok(());\n    }\n\n    let max = values.iter().copied().fold(f64::MIN, f64::max).max(1.0);\n    let slot = css_w / values.len() as f64;\n    let gap = (slot * 0.2).min(6.0);\n\n    ctx.set_fill_style_str(\"#60a5fa\");\n    for (i, v) in values.iter().enumerate() {\n        let h = (v / max) * (css_h - 4.0);\n        let x = i as f64 * slot + gap / 2.0;\n        ctx.fill_rect(x, css_h - h, slot - gap, h);\n    }\n\n    // Accessibility mirror (in the DOM, not on the canvas):\n    // <figure aria-labelledby=\"chart-caption\">\n    //   <figcaption id=\"chart-caption\">Requests per minute, last 24 hours</figcaption>\n    //   <table class=\"visually-hidden\"> ... one row per bar ... </table>\n    // </figure>\n    Ok(())\n}"
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
        {
          "name": "gfx-rs/wgpu",
          "url": "https://github.com/gfx-rs/wgpu"
        },
        {
          "name": "wasm-bindgen/wasm-bindgen — canvas bindings in web-sys",
          "url": "https://github.com/wasm-bindgen/wasm-bindgen"
        }
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
          "code": "use leptos::prelude::*;\n\n#[component]\npub fn RouteShell(#[prop(into)] title: String, children: Children) -> impl IntoView {\n    // Effects run on the client, after the DOM is updated.\n    Effect::new(move |_| {\n        let Some(document) = web_sys::window().and_then(|w| w.document()) else {\n            return;\n        };\n        if let Some(heading) = document.get_element_by_id(\"route-heading\") {\n            let _ = heading.set_attribute(\"tabindex\", \"-1\");\n            if let Some(el) = heading.dyn_ref::<web_sys::HtmlElement>() {\n                let _ = el.focus();\n            }\n        }\n    });\n\n    view! {\n        <main>\n            <h1 id=\"route-heading\" tabindex=\"-1\">{title}</h1>\n            {children()}\n        </main>\n    }\n}",
          "tip": "tabindex=\"-1\" makes an element programmatically focusable without adding it to the tab order — exactly what a heading needs after navigation."
        },
        {
          "h": "Announce changes without flooding",
          "p": [
            "A live region announces content that changes after the initial render. aria-live=\"polite\" waits for a pause; assertive interrupts. For a streaming dashboard this is a hazard: putting aria-live on a table that updates every second makes a screen reader unusable, because every update queues an announcement.",
            "Announce a summary instead, and throttle it. Expose state as well: aria-busy while loading, aria-invalid plus aria-describedby for a failing field, aria-pressed for a toggle, aria-expanded for a disclosure. Those attributes are the difference between a component that looks right and one that is usable."
          ],
          "code": "view! {\n    <section aria-labelledby=\"metrics-heading\">\n        <h2 id=\"metrics-heading\">\"Live metrics\"</h2>\n\n        // One summary line, updated at most once every few seconds.\n        <p role=\"status\" aria-live=\"polite\" aria-atomic=\"true\">\n            {move || format!(\n                \"{} req/s, p95 {} ms\",\n                throttled_rps.get(),\n                throttled_p95.get()\n            )}\n        </p>\n\n        // The table itself is not a live region: it would flood the queue.\n        <table aria-busy=move || loading.get().to_string()>\n            <caption>\"Per-route latency, last 5 minutes\"</caption>\n            <thead><tr><th scope=\"col\">\"Route\"</th><th scope=\"col\">\"p95\"</th></tr></thead>\n            <tbody>{/* rows */}</tbody>\n        </table>\n    </section>\n}",
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
        "starter": "view! {\n    <div class=\"search\">\n        // 1. a <label> bound to the input\n        // 2. an <input> with aria-invalid and aria-describedby\n        // 3. a status line announcing the count\n    </div>\n}",
        "hint": "for=id on the label, id on the input, aria-describedby pointing at the error paragraph, and role=status for the count. Only set aria-invalid when the value is actually invalid.",
        "solution": "use leptos::prelude::*;\n\n#[component]\npub fn SearchField() -> impl IntoView {\n    let (query, set_query) = signal(String::new());\n    let results = Memo::new(move |_| {\n        let q = query.get();\n        if q.is_empty() { 0 } else { 4 } // placeholder count\n    });\n    let invalid = move || query.get().len() == 1;\n\n    view! {\n        <form class=\"search\" role=\"search\" on:submit=|ev| ev.prevent_default()>\n            <label for=\"incident-search\">\"Search incidents\"</label>\n\n            <input\n                id=\"incident-search\"\n                type=\"search\"\n                autocomplete=\"off\"\n                prop:value=move || query.get()\n                aria-invalid=move || invalid().to_string()\n                aria-describedby=\"search-error\"\n                on:input=move |ev| set_query.set(event_target_value(&ev))\n            />\n\n            <p id=\"search-error\" class=\"error\" role=\"alert\" hidden=move || !invalid()>\n                \"Enter at least two characters.\"\n            </p>\n\n            <p role=\"status\" aria-live=\"polite\" aria-atomic=\"true\">\n                {move || format!(\"{} incidents match\", results.get())}\n            </p>\n\n            <button type=\"submit\">\"Search\"</button>\n        </form>\n    }\n}"
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
        {
          "name": "dequelabs/axe-core",
          "url": "https://github.com/dequelabs/axe-core"
        },
        {
          "name": "leptos-rs/leptos — aria attributes in view!",
          "url": "https://github.com/leptos-rs/leptos"
        }
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
          "code": "{\n  \"name\": \"Ops dashboard\",\n  \"short_name\": \"Ops\",\n  \"start_url\": \"/\",\n  \"scope\": \"/\",\n  \"display\": \"standalone\",\n  \"background_color\": \"#0b1220\",\n  \"theme_color\": \"#0b1220\",\n  \"icons\": [\n    { \"src\": \"/icons/icon-192.png\", \"sizes\": \"192x192\", \"type\": \"image/png\" },\n    { \"src\": \"/icons/icon-512.png\", \"sizes\": \"512x512\", \"type\": \"image/png\", \"purpose\": \"any maskable\" }\n  ]\n}\n\n<!-- index.html head -->\n<link rel=\"manifest\" href=\"/manifest.webmanifest\"/>\n<meta name=\"theme-color\" content=\"#0b1220\"/>",
          "tip": "purpose \"any maskable\" needs safe padding: maskable icons are cropped to the platform's shape, so keep the logo inside the middle 80%."
        },
        {
          "h": "Register from Rust, update deliberately",
          "p": [
            "Registration is one call into navigator.serviceWorker. The interesting part is the update flow: a new worker installs in the background and waits while the page keeps running the old one. Calling skipWaiting immediately lets the new worker take over mid-session, where it can serve a wasm binary that does not match the JS already loaded.",
            "The safe pattern is to detect the waiting worker, show a prompt, and reload only when the user accepts. That preserves the HTML/JS/wasm triple, which is exactly the invariant a wasm app needs and exactly what a naive cache-first worker breaks. Reloading without asking is tempting and costs whatever the user was typing; asking keeps the versions consistent for free."
          ],
          "code": "use wasm_bindgen::prelude::*;\nuse wasm_bindgen::JsCast;\nuse wasm_bindgen_futures::JsFuture;\nuse web_sys::ServiceWorkerRegistration;\n\npub async fn register(path: &str) -> Result<ServiceWorkerRegistration, JsValue> {\n    let container = web_sys::window()\n        .ok_or(\"no window\")?\n        .navigator()\n        .service_worker();\n\n    let registration = JsFuture::from(container.register(path)).await?;\n    Ok(registration.unchecked_into())\n}\n\n/// Call after every registration: a waiting worker means a new deploy.\npub fn prompt_if_waiting(registration: &ServiceWorkerRegistration) -> bool {\n    match registration.waiting() {\n        Some(worker) => {\n            // Show a banner; on accept, tell the worker to take over and reload.\n            let _ = worker.post_message(&JsValue::from_str(\"SKIP_WAITING\"));\n            true\n        }\n        None => false,\n    }\n}",
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
          "code": "const VERSION = \"app-2026-11-04\";\nconst SHELL = [\"/\", \"/pkg/app.js\", \"/pkg/app_bg.wasm\", \"/styles/app.css\"];\n\nself.addEventListener(\"install\", (event) => {\n  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)));\n});\n\nself.addEventListener(\"activate\", (event) => {\n  event.waitUntil(\n    caches.keys().then((keys) =>\n      Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))),\n    ),\n  );\n});\n\nself.addEventListener(\"fetch\", (event) => {\n  const url = new URL(event.request.url);\n  const isHashed = url.pathname.startsWith(\"/pkg/\");\n\n  if (isHashed) {\n    // Immutable assets: cache first, network as a fallback.\n    event.respondWith(\n      caches.match(event.request).then((hit) => hit || fetch(event.request)),\n    );\n  }\n  // HTML and API requests fall through to the network.\n});",
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
        "starter": "const VERSION = \"app-v1\";\nconst SHELL = [];\n\nself.addEventListener(\"install\", (event) => {\n  // precache\n});\n\nself.addEventListener(\"activate\", (event) => {\n  // delete stale caches\n});",
        "hint": "cache.addAll rejects the whole install if any URL 404s, which is why the shell list must be exact. Deleting caches other than VERSION on activate is what prevents stale wasm.",
        "solution": "const VERSION = \"app-v1\";\nconst SHELL = [\"/\", \"/pkg/app.js\", \"/pkg/app_bg.wasm\", \"/styles/app.css\"];\n\nself.addEventListener(\"install\", (event) => {\n  event.waitUntil(\n    caches.open(VERSION).then((cache) => cache.addAll(SHELL)),\n  );\n});\n\nself.addEventListener(\"activate\", (event) => {\n  event.waitUntil(\n    caches.keys().then((keys) =>\n      Promise.all(\n        keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)),\n      ),\n    ),\n  );\n});\n\nself.addEventListener(\"fetch\", (event) => {\n  const url = new URL(event.request.url);\n  if (!url.pathname.startsWith(\"/pkg/\")) return; // HTML stays network-first\n\n  event.respondWith(\n    caches.match(event.request).then(async (hit) => {\n      if (hit) return hit;\n      const response = await fetch(event.request);\n      if (response.ok) {\n        const cache = await caches.open(VERSION);\n        cache.put(event.request, response.clone());\n      }\n      return response;\n    }),\n  );\n});\n\n// The breaking change: serving app.js from a cache that still holds the\n// previous app_bg.wasm. The glue calls a symbol the old binary does not\n// export, and only users who visited before the deploy see the failure."
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
        {
          "name": "GoogleChrome/workbox",
          "url": "https://github.com/GoogleChrome/workbox"
        },
        {
          "name": "wasm-bindgen/wasm-bindgen — service worker bindings in web-sys",
          "url": "https://github.com/wasm-bindgen/wasm-bindgen"
        }
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
          "code": "use worker::*;\n\n#[event(fetch)]\npub async fn main(req: Request, env: Env, _ctx: worker::Context) -> Result<Response> {\n    let router = Router::new();\n\n    router\n        .get_async(\"/health\", |_req, _ctx| async move { Response::ok(\"ok\") })\n        .get_async(\"/metrics/:route\", |_req, ctx| async move {\n            let route = ctx.param(\"route\").cloned().unwrap_or_default();\n            let kv = ctx.kv(\"METRICS\")?;\n\n            match kv.get(&route).text().await? {\n                Some(body) => Response::ok(body),\n                None => Response::error(\"not found\", 404),\n            }\n        })\n        .run(req, env)\n        .await\n}",
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
        "starter": "use worker::*;\n\n#[event(fetch)]\npub async fn main(req: Request, env: Env, _ctx: worker::Context) -> Result<Response> {\n    // 1. Router::new()\n    // 2. /health -> \"ok\"\n    // 3. /summary/:key -> KV read, JSON response\n    todo!()\n}",
        "hint": "ctx.kv(\"METRICS\") gives a KvStore; .get(key).text().await? returns Option<String>. Response::from_json takes a serializable value.",
        "solution": "use serde::Serialize;\nuse worker::*;\n\n#[derive(Serialize)]\nstruct Summary {\n    key: String,\n    rows: usize,\n}\n\n#[event(fetch)]\npub async fn main(req: Request, env: Env, _ctx: worker::Context) -> Result<Response> {\n    let router = Router::new();\n\n    router\n        .get_async(\"/health\", |_req, _ctx| async move { Response::ok(\"ok\") })\n        .get_async(\"/summary/:key\", |_req, ctx| async move {\n            let key = ctx.param(\"key\").cloned().unwrap_or_default();\n            let kv = ctx.kv(\"METRICS\")?;\n\n            let Some(raw) = kv.get(&key).text().await? else {\n                return Response::error(\"not found\", 404);\n            };\n\n            let rows = raw.lines().count();\n            Response::from_json(&Summary { key, rows })\n        })\n        .run(req, env)\n        .await\n}\n\n// If the aggregate grew to megabytes, it would move out of the worker:\n// a scheduled job writes a precomputed summary to KV or R2, and the edge\n// handler only reads that object. Edge CPU is for per-request work, not\n// for scanning large datasets on every request."
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
        {
          "name": "cloudflare/workers-rs",
          "url": "https://github.com/cloudflare/workers-rs"
        },
        {
          "name": "bytecodealliance/wasmtime — the engine behind several edge runtimes",
          "url": "https://github.com/bytecodealliance/wasmtime"
        }
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
          "code": "use wasmtime::{Engine, Linker, Module, Store};\n\npub struct Plugin {\n    engine: Engine,\n    module: Module,\n}\n\nimpl Plugin {\n    pub fn compile(wasm: &[u8]) -> anyhow::Result<Self> {\n        let engine = Engine::default();\n        let module = Module::new(&engine, wasm)?;\n        Ok(Self { engine, module })\n    }\n\n    pub fn call(&self, input: i32) -> anyhow::Result<i32> {\n        // No imports linked: this guest can only compute.\n        let linker: Linker<()> = Linker::new(&self.engine);\n        let mut store = Store::new(&self.engine, ());\n        let instance = linker.instantiate(&mut store, &self.module)?;\n        let process = instance.get_typed_func::<i32, i32>(&mut store, \"process\")?;\n        process.call(&mut store, input)\n    }\n}",
          "tip": "Instantiate per call, compile once. Module is Send + Sync and safe to share; Store owns mutable state and is meant to be short-lived."
        },
        {
          "h": "Fuel, epochs and memory ceilings",
          "p": [
            "An untrusted module containing loop {} will consume a core until something stops it. Wasmtime offers two mechanisms: fuel, a deterministic instruction budget metered by the engine, and epoch interruption, a cheap counter checked at loop backedges so a watchdog thread can preempt execution.",
            "Fuel is deterministic and therefore testable — the same input consumes the same budget. Epochs are cheaper and wall-clock based. Either way, the limit is not a default you can skip: without one, a hostile or simply buggy guest runs until the request times out, if it ever does."
          ],
          "code": "use std::sync::Arc;\nuse std::time::Duration;\nuse wasmtime::{Config, Engine, Linker, Module, Store, StoreLimits, StoreLimitsBuilder};\n\npub fn hardened_engine() -> anyhow::Result<Engine> {\n    let mut config = Config::new();\n    config.consume_fuel(true);          // deterministic instruction budget\n    config.epoch_interruption(true);    // wall-clock preemption\n    Engine::new(&config).map_err(Into::into)\n}\n\nstruct HostState {\n    limits: StoreLimits,\n}\n\npub fn run(engine: &Engine, module: &Module, fuel: u64) -> anyhow::Result<i32> {\n    let limits = StoreLimitsBuilder::new()\n        .memory_size(64 << 20)          // 64 MiB of linear memory\n        .instances(1)\n        .build();\n\n    let mut store = Store::new(engine, HostState { limits });\n    store.set_fuel(fuel)?;\n    store.epoch_deadline_trap();\n    // The limits must live in the store's data; a temporary would not outlive this call.\n    store.limiter(|state| &mut state.limits);\n\n    let linker: Linker<HostState> = Linker::new(engine);\n    let instance = linker.instantiate(&mut store, module)?;\n    let f = instance.get_typed_func::<i32, i32>(&mut store, \"process\")?;\n    f.call(&mut store, 42)\n}\n\npub fn watchdog(engine: Arc<Engine>) {\n    // Bump the epoch periodically; guests with a deadline trap when it passes.\n    std::thread::spawn(move || loop {\n        std::thread::sleep(Duration::from_millis(50));\n        engine.increment_epoch();\n    });\n}",
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
          "code": "# AOT compile at build time, ship the .cwasm artifact.\nwasmtime compile guest.wasm -o guest.cwasm\n\n# Cross-compile for the architecture your fleet actually runs.\nwasmtime compile --target aarch64-unknown-linux-gnu guest.wasm -o guest-arm64.cwasm\n\n# Inspect what the module imports before you link anything.\nwasmtime inspect guest.wasm\n\n# Run with a WASI context (preview 2) instead of an empty linker.\nwasmtime run --dir ./data guest.wasm\n\n# The engine refuses an artifact built by a different wasmtime version;\n# rebuild it in the same pipeline that builds the runtime image.",
          "tip": "wasmtime inspect lists imports before execution; an unexpected wasi:sockets import is a finding, not a detail."
        }
      ],
      "exercise": {
        "prompt": "Write a runner that enforces a fuel budget and refuses to link any import. Then explain how you would add a single host function that appends a line to a log, without opening any other capability.",
        "starter": "use wasmtime::{Engine, Linker, Module, Store};\n\npub fn run(engine: &Engine, module: &Module, fuel: u64) -> anyhow::Result<i32> {\n    // 1. store with fuel\n    // 2. empty linker\n    // 3. typed call to \"process\"\n    todo!()\n}",
        "hint": "store.set_fuel(fuel)? before instantiation; Linker::new(&engine) with no additions links nothing, so any import in the module fails instantiation with an unknown-import error.",
        "solution": "use wasmtime::{Caller, Engine, Linker, Module, Store};\n\npub struct LogOnly;\n\npub fn run(engine: &Engine, module: &Module, fuel: u64) -> anyhow::Result<i32> {\n    let mut store: Store<()> = Store::new(engine, ());\n    store.set_fuel(fuel)?;\n\n    let mut linker: Linker<()> = Linker::new(engine);\n\n    // Exactly one capability: append a line to stdout.\n    linker.func_wrap(\"host\", \"log\", |_caller: Caller<'_, ()>, ptr: i32, len: i32| {\n        println!(\"guest log: ptr={ptr} len={len}\");\n    })?;\n\n    let instance = linker.instantiate(&mut store, module)?;\n    let process = instance.get_typed_func::<i32, i32>(&mut store, \"process\")?;\n    process.call(&mut store, 42)\n}\n\n// Anything the module imports that is not \"host\".\"log\" now fails at\n// instantiation with an unknown-import error, which is the intended\n// failure mode: deny by default, allow explicitly."
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
        {
          "name": "bytecodealliance/wasmtime",
          "url": "https://github.com/bytecodealliance/wasmtime"
        },
        {
          "name": "bytecodealliance/wasm-tools",
          "url": "https://github.com/bytecodealliance/wasm-tools"
        }
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
          "code": "// wit/dashboard.wit\npackage acme:dashboard@0.1.0;\n\ninterface metrics {\n  record sample {\n    name: string,\n    p95-ms: f64,\n    healthy: bool,\n  }\n\n  enum error {\n    not-found,\n    unavailable,\n  }\n\n  get-samples: func(limit: u32) -> list<sample>;\n  record: func(name: string, latency-ms: f64) -> result<_, error>;\n}\n\nworld dashboard {\n  import log: func(message: string);\n  export metrics;\n}",
          "tip": "WIT uses kebab-case names; bindings map them to snake_case in Rust and camelCase in JavaScript, so the wire format stays language-neutral."
        },
        {
          "h": "Building a component",
          "p": [
            "cargo component wraps the usual build and emits a component rather than a core module. For a core module produced by plain rustc, wasm-tools component new wraps it with an adapter that maps preview1 imports onto the component model, which is how existing crates keep working.",
            "Inspect before you integrate. wasm-tools component wit prints the world a component declares, and that output is the fastest way to catch a dependency that quietly widened your interface. Imports you did not plan for mean the contract grew without a review."
          ],
          "code": "# Build a component directly from a Rust crate that has a wit/ folder.\ncargo component build --release\n# -> target/wasm32-wasip1/release/dashboard.wasm\n\n# Or adapt a core module built by rustc.\nwasm-tools component new core.wasm \\\n  --adapt wasi_snapshot_preview1=adapter/wasi_snapshot_preview1.wasm \\\n  -o dashboard.wasm\n\n# Verify the world the component actually implements.\nwasm-tools component wit dashboard.wasm\n\n# Run it on wasmtime; the component-model feature is on by default.\nwasmtime run dashboard.wasm",
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
          "code": "use wasmtime::component::{Component, Linker};\nuse wasmtime::{Engine, Store};\n\nwasmtime::component::bindgen!({\n    world: \"dashboard\",\n    path: \"wit\",\n    include_component_type: true,\n});\n\nfn main() -> anyhow::Result<()> {\n    let engine = Engine::default();\n    let component = Component::from_file(&engine, \"dashboard.wasm\")?;\n\n    let mut linker: Linker<()> = Linker::new(&engine);\n    linker.root().func_wrap(\"log\", |_store, (msg,): (String,)| {\n        println!(\"guest: {msg}\");\n    })?;\n\n    let mut store = Store::new(&engine, ());\n    let instance = linker.instantiate(&mut store, &component)?;\n\n    // Typed calls are generated from the world; no pointer arithmetic.\n    let _ = &instance;\n    Ok(())\n}",
          "tip": "If bindgen! reports a missing world, pass path explicitly — the macro looks for wi/ adjacent to Cargo.toml and requires exactly one world unless you name it."
        }
      ],
      "exercise": {
        "prompt": "Write a WIT world for a plugin that imports a logger and exports a transform function over a list of records. Then show the commands that build it and inspect the resulting world.",
        "starter": "// wit/plugin.wit\npackage acme:plugin@0.1.0;\n\ninterface transform {\n  // record input { ... }\n  // run: func(rows: list<input>) -> list<input>;\n}\n\nworld plugin {\n  // import log\n  // export transform\n}",
        "hint": "Records need named fields with WIT types; the world block lists `import log: func(message: string);` and `export transform;`. Build with cargo component, inspect with wasm-tools component wit.",
        "solution": "// wit/plugin.wit\npackage acme:plugin@0.1.0;\n\ninterface transform {\n  record input {\n    key: string,\n    value: f64,\n  }\n\n  run: func(rows: list<input>) -> list<input>;\n}\n\nworld plugin {\n  import log: func(message: string);\n  export transform;\n}\n\n# Build and inspect\ncargo component build --release\nwasm-tools component wit target/wasm32-wasip1/release/plugin.wasm\n\n# Expected output: the same package, world plugin, with one import\n# (log) and one export (transform). Any extra import is a contract\n# change you did not intend."
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
        {
          "name": "WebAssembly/component-model",
          "url": "https://github.com/WebAssembly/component-model"
        },
        {
          "name": "bytecodealliance/cargo-component",
          "url": "https://github.com/bytecodealliance/cargo-component"
        }
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
