/**
 * Concurrency patterns track.
 *
 * Authored for the Rust Academy plugin. Every lesson is plain JSON-compatible
 * data consumed by src/app.js through build.mjs.
 */
export default {
  "key": "concurrency-patterns",
  "prefix": "cp",
  "title": "Concurrency patterns",
  "blurb": "Actors, CSP, structured concurrency, atomics, lock-free structures, and how to test concurrent Rust without flaky failures.",
  "level": "industry",
  "project": {
    "title": "Capstone: a concurrent job pipeline",
    "brief": "Build a bounded, cancellable job pipeline that ingests work from many producers, fans it out across a fixed worker pool, and shuts down without losing or duplicating a job. Prove the properties instead of hoping for them: model-check the shared state with loom, test cancellation and drain semantics deterministically, and publish throughput plus tail latency under saturation.",
    "deliverables": [
      "A bounded ingress queue with an explicit load-shedding policy and a counter for every dropped job.",
      "Workers that own their state, with a mailbox capacity chosen from a measured queue-depth budget.",
      "A cancellation path: one token, hierarchical children, and a drain window that finishes in-flight jobs before exit.",
      "Deterministic tests for shutdown, cancellation, and conservation of jobs (nothing lost, nothing duplicated).",
      "A loom suite covering the shared completion counter and the bounded queue's head/tail protocol.",
      "A criterion benchmark harness reporting throughput at fixed concurrency and p50/p99 latency at 70% and 100% saturation."
    ],
    "stack": [
      "tokio",
      "tokio-util",
      "crossbeam",
      "crossbeam-utils",
      "rayon",
      "loom",
      "parking_lot",
      "criterion"
    ]
  },
  "lessons": [
    {
      "id": "cp01",
      "n": 1,
      "title": "Concurrency is not parallelism",
      "minutes": 50,
      "level": "core",
      "goal": "Separate the two ideas so you choose threads, async tasks, or data parallelism for the right reason instead of adding concurrency to a latency problem.",
      "sections": [
        {
          "h": "Two different words for two different problems",
          "p": [
            "Concurrency is a structure: several activities are in flight and the program must stay correct when their execution interleaves. Parallelism is an execution property: two instructions retire on two cores in the same cycle. A single-core machine runs concurrent code perfectly well, and a parallel program still needs concurrency reasoning because the OS scheduler can pause either thread at any instruction boundary.",
            "The distinction decides the design. If the program is waiting - on sockets, disks, locks, timers - you need concurrency, and you pay per in-flight activity in memory and scheduling. If the program is computing, you need parallelism, and the payoff is bounded by Amdahl's law: a 5% serial section caps speedup at 20x no matter how many cores are installed."
          ],
          "tip": "Ask which resource is idle. Cores idle with high latency is a waiting problem; latency flat but CPU pinned is a parallelism problem."
        },
        {
          "h": "One core, ten thousand tasks",
          "p": [
            "On one thread, async concurrency is a state machine per task plus an executor that polls them. Ten thousand sockets cost ten thousand small state machines, not ten thousand 2 MB stacks. That is the entire win over thread-per-connection: a thread costs a kernel object, a stack reservation, and a context switch, which is why 10k threads is a struggle and 10k tasks is unremarkable.",
            "So you can have concurrency without parallelism, and that is often the correct answer. A service that is 95% waiting does not need 64 cores to hold 64 in-flight requests; it needs one core and a scheduler. Adding workers only helps once a measurable fraction of wall time is CPU-bound, and then you scale the runtime's worker count rather than the request count."
          ]
        },
        {
          "h": "Settle it with a stopwatch",
          "p": [
            "Two experiments end most arguments. Spawn eight threads that each sleep two seconds: wall clock stays near two seconds, because sleeping is concurrent, not parallel. Spawn eight threads that each burn CPU for two seconds: wall clock is near two seconds only if eight cores are actually available, which you should query instead of assume.",
            "Run the CPU version on a two-core CI runner and the number doubles. That is the honest measurement of parallelism, and it is why a benchmark without a machine description is not a benchmark. Concurrency shows up as latency under load; parallelism shows up as throughput scaling with cores, and only until the serial fraction takes over."
          ],
          "code": "use std::thread;\nuse std::time::{Duration, Instant};\n\nfn main() {\n    let cores = thread::available_parallelism().map(|n| n.get()).unwrap_or(1);\n    println!(\"available_parallelism = {cores}\");\n\n    // Concurrency: eight sleeps overlap even on a single core.\n    let t = Instant::now();\n    thread::scope(|s| {\n        for _ in 0..8 {\n            s.spawn(|| thread::sleep(Duration::from_secs(2)));\n        }\n    });\n    println!(\"8 x sleep(2s) -> {:?}\", t.elapsed());\n\n    // Parallelism: wall clock only shrinks while cores are free.\n    let t = Instant::now();\n    thread::scope(|s| {\n        for _ in 0..8 {\n            s.spawn(|| {\n                let end = Instant::now() + Duration::from_secs(2);\n                while Instant::now() < end {\n                    std::hint::black_box(0u64.wrapping_mul(3));\n                }\n            });\n        }\n    });\n    println!(\"8 x burn(2s)  -> {:?}\", t.elapsed());\n}"
        }
      ],
      "exercise": {
        "prompt": "A batch job takes 100 s on one core, 34 s on four cores, and 29 s on twelve. Compute the serial fraction, then write a scoped-thread harness that measures the same scaling for your own closure and prints efficiency per core count.",
        "starter": "use std::thread;\nuse std::time::Instant;\n\nfn run(cores: usize) -> std::time::Duration {\n    // 1. split the work into one chunk per core\n    // 2. run them with thread::scope so no Arc/Mutex is needed\n    // 3. return wall clock\n    todo!()\n}\n\nfn main() {\n    for cores in [1, 2, 4, 8, 12] {\n        let d = run(cores);\n        println!(\"{cores} cores -> {d:?}\");\n    }\n}",
        "hint": "With s = 0.04, Amdahl gives 1/(0.04 + 0.96/12) = 8.8x, close to the measured 100/29. Use thread::scope and chunks so the chunks borrow the input instead of cloning it.",
        "solution": "use std::hint::black_box;\nuse std::thread;\nuse std::time::{Duration, Instant};\n\n/// Total work is fixed: the cost is proportional to the chunk length.\nfn work(chunk: &[u64]) -> u64 {\n    let mut acc = 0u64;\n    for v in chunk {\n        for _ in 0..200 {\n            acc = acc.wrapping_add(black_box(*v));\n        }\n    }\n    acc\n}\n\n/// A deliberate ~4% serial section, executed once per run.\nfn serial_tail(data: &[u64]) -> u64 {\n    data.iter().step_by(25).map(|v| v.wrapping_mul(2)).sum()\n}\n\nfn run(cores: usize, data: &[u64]) -> Duration {\n    let chunk = data.len().div_ceil(cores).max(1);\n    let start = Instant::now();\n    let tail = serial_tail(data);\n    let parallel: u64 = thread::scope(|s| {\n        let handles: Vec<_> = data\n            .chunks(chunk)\n            .map(|part| s.spawn(move || work(part)))\n            .collect();\n        handles.into_iter().map(|h| h.join().expect(\"worker panicked\")).sum()\n    });\n    black_box(tail + parallel);\n    start.elapsed()\n}\n\nfn main() {\n    let data = vec![1u64; 1_000_000];\n    let one = run(1, &data);\n    for cores in [1, 2, 4, 8, 12] {\n        let d = run(cores, &data);\n        let speedup = one.as_secs_f64() / d.as_secs_f64();\n        println!(\n            \"{cores:2} cores -> {d:?}  speedup {speedup:.2}x  efficiency {:.0}%\",\n            speedup / cores as f64 * 100.0\n        );\n    }\n}"
      },
      "questions": [
        {
          "q": "A job takes 100 s serially, 34 s on 4 cores, and 29 s on 12 cores. What does the 12-core number tell you that Amdahl's law did not predict?",
          "options": [
            "Nothing - 29 s is within noise of the 4-core run",
            "Speedup stalled near 3.4x, so something beyond a fixed serial fraction - shared bandwidth or contention - is now the limit",
            "The serial fraction is exactly 12%, which is what Amdahl predicts",
            "The job became I/O bound, which Amdahl's law cannot model"
          ],
          "answer": 1,
          "explain": "From the 4-core point, Amdahl implies s = 0.04 and predicts about 8.8x at 12 cores, i.e. roughly 11 s. Measured 29 s means the serial fraction grows with core count: memory bandwidth, allocator contention, or cache-line sharing the model treats as zero."
        },
        {
          "q": "Which workload actually benefits from raising tokio's worker thread count?",
          "options": [
            "A gateway holding 50k idle websockets that mostly wait on the network",
            "A handler that spends 200 ms per request in a CPU-bound JSON transform",
            "A service parked on a rate limiter for most of each call",
            "A proxy that awaits two upstream calls per request"
          ],
          "answer": 1,
          "explain": "Worker threads buy parallel CPU. Waiting workloads are already concurrent on one worker, and adding threads only adds contention on the queues and allocator. The JSON transform is the only case where time is spent executing instructions rather than parked."
        }
      ],
      "quickbytes": [
        "Concurrency is about structure under interleaving; parallelism is about simultaneous execution. Name which one the bug or the budget is about.",
        "Measure available_parallelism() instead of assuming cores; CI runners routinely have two.",
        "A sleep-heavy benchmark proves concurrency, never parallelism - use CPU burn to test scaling."
      ],
      "production": [
        "Every performance claim in a design doc names the machine: core count, CPU model, and whether SMT was on.",
        "Worker-pool sizing comes from measured CPU fraction, not from a constant copied between services.",
        "Latency SLOs are stated at a concurrency level, because concurrency without a load level is meaningless.",
        "A serial section found by profiling is either removed or documented with its Amdahl ceiling."
      ],
      "crates": [
        "tokio",
        "rayon",
        "crossbeam-utils"
      ],
      "github": [
        {
          "name": "tokio - async runtime, task scheduler, sync primitives",
          "url": "https://github.com/tokio-rs/tokio"
        },
        {
          "name": "rayon - data parallelism on a work-stealing pool",
          "url": "https://github.com/rayon-rs/rayon"
        }
      ],
      "pitfall": "Adding threads to a latency problem: a request handler that awaits one database call gains nothing from four workers, and now four requests can be in flight against a pool sized for one, converting a slow service into a saturated one.",
      "resources": [
        {
          "title": "The Rust Book, chapter 16: fearless concurrency",
          "url": "https://doc.rust-lang.org/book/ch16-00-concurrency.html",
          "kind": "docs"
        },
        {
          "title": "The Tokio tutorial: tasks, spawning, and shared state",
          "url": "https://tokio.rs/tokio/tutorial",
          "kind": "docs"
        },
        {
          "title": "std::thread::available_parallelism",
          "url": "https://doc.rust-lang.org/std/thread/fn.available_parallelism.html",
          "kind": "docs"
        },
        {
          "title": "InfoQ: concurrency and runtime architecture talks",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        },
        {
          "title": "rayon: data-parallel iterators and work stealing",
          "url": "https://github.com/rayon-rs/rayon",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "cp02",
      "n": 2,
      "title": "Threads, stacks, and scoped threads",
      "minutes": 60,
      "level": "core",
      "goal": "Spawn threads that borrow stack data safely with thread::scope, size stacks and names deliberately, and handle a worker panic instead of losing it.",
      "sections": [
        {
          "h": "What thread::spawn costs you",
          "p": [
            "thread::spawn requires 'static, which is the compiler telling you the thread may outlive the caller. That single bound is why thread-per-request code ends up wrapping everything in Arc: the closure cannot borrow a local buffer, so it clones the world. Each thread also reserves a 2 MiB stack by default and gets a kernel scheduling entity.",
            "A thread also has no owner once spawned. Its JoinHandle can be dropped, the thread keeps running, and a panic inside it is captured in the handle and then discarded if nobody joins. Processes that shut down while a detached thread writes to a file or a socket are the usual symptom: truncated output with no error anywhere."
          ],
          "tip": "Name threads with Builder::new().name(\"ingest-3\"). The name appears in panic messages, thread dumps, and perf output - three places you will look at 3 a.m."
        },
        {
          "h": "Scoped threads make borrowing legal",
          "p": [
            "thread::scope, stable since Rust 1.63, creates a region in which spawned threads may borrow non-'static data, because the scope joins every thread before it returns. The lifetime argument is the guarantee: 'scope ends only after all threads are joined, so any borrow that outlives 'scope is safe by construction.",
            "The practical effect is that data parallelism stops needing Arc and Mutex. Split a &mut [T] with chunks_mut, hand each disjoint chunk to one thread, and the borrow checker accepts it because the slices do not alias. No lock, no refcount traffic, no poisoned mutex to unwrap."
          ],
          "code": "use std::thread;\n\nfn sum_parallel(xs: &[u64], threads: usize) -> u64 {\n    let chunk = xs.len().div_ceil(threads).max(1);\n    thread::scope(|s| {\n        let handles: Vec<_> = xs\n            .chunks(chunk)\n            .map(|part| s.spawn(move || part.iter().sum::<u64>()))\n            .collect();\n        handles\n            .into_iter()\n            .map(|h| h.join().expect(\"worker panicked\"))\n            .sum()\n    })\n}\n\nfn main() {\n    let data: Vec<u64> = (1..=1_000_000).collect();\n    assert_eq!(sum_parallel(&data, 8), data.iter().sum());\n    println!(\"ok\");\n}"
        },
        {
          "h": "Panics, joins, and what the scope does for you",
          "p": [
            "ScopedJoinHandle::join returns thread::Result<T>, an Err carrying the panic payload. If you do not join a scoped thread yourself, the scope joins it at the end and resumes the panic, so a failing worker takes down the whole scope. That is the safe default: silence is worse than a crash, and it is why the auto-join behaviour differs from detached threads.",
            "Handle it when a partial result is meaningful. Join explicitly, convert Err into a domain error, and keep the successful chunks. Note the interaction with panic = \"abort\" in the release profile: with abort there is no unwinding, join never returns Err, and the process is simply gone, so a catch-and-continue design needs panic = \"unwind\"."
          ],
          "list": [
            "Join in the same order you spawned only if you need deterministic output ordering",
            "Move a copy of the chunk index into each closure to label errors",
            "Use Builder::stack_size for recursive parsers; the default 2 MiB is not always enough",
            "Prefer scope over Arc<Mutex<..>> whenever the split is disjoint"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a parallel map over &[String] that returns Vec<usize> of lengths using scoped threads and no shared mutable state, then make one chunk fail and confirm the remaining results are still usable.",
        "starter": "use std::thread;\n\nfn lengths(xs: &[String], threads: usize) -> Vec<usize> {\n    // hint: chunks, one spawn per chunk, join into ordered results\n    todo!()\n}\n\nfn main() {\n    let xs: Vec<String> = (0..1000).map(|i| \"x\".repeat(i % 17)).collect();\n    assert_eq!(lengths(&xs, 4), xs.iter().map(|s| s.len()).collect::<Vec<_>>());\n    println!(\"ok\");\n}",
        "hint": "Each closure returns Vec<usize> for its chunk; join in chunk order and flatten. For the failure case, join each handle and push a 0 for the failed chunk while recording the panic.",
        "solution": "use std::thread;\n\nfn lengths(xs: &[String], threads: usize) -> Vec<usize> {\n    let chunk = xs.len().div_ceil(threads).max(1);\n    thread::scope(|s| {\n        let handles: Vec<_> = xs\n            .chunks(chunk)\n            .map(|part| s.spawn(move || part.iter().map(|s| s.len()).collect::<Vec<_>>()))\n            .collect();\n        handles\n            .into_iter()\n            .flat_map(|h| h.join().expect(\"worker panicked\"))\n            .collect()\n    })\n}\n\nfn lengths_tolerant(xs: &[String], threads: usize) -> (Vec<usize>, usize) {\n    let chunk = xs.len().div_ceil(threads).max(1);\n    let mut out = Vec::with_capacity(xs.len());\n    let mut failed = 0;\n    thread::scope(|s| {\n        let handles: Vec<_> = xs\n            .chunks(chunk)\n            .enumerate()\n            .map(|(i, part)| {\n                s.spawn(move || {\n                    if i == 2 {\n                        panic!(\"simulated poison chunk {i}\");\n                    }\n                    part.iter().map(|s| s.len()).collect::<Vec<_>>()\n                })\n            })\n            .collect();\n        for (i, h) in handles.into_iter().enumerate() {\n            match h.join() {\n                Ok(v) => out.extend(v),\n                Err(_) => {\n                    failed += 1;\n                    out.extend(std::iter::repeat(0).take(xs.chunks(chunk).nth(i).unwrap().len()));\n                }\n            }\n        }\n    });\n    (out, failed)\n}\n\nfn main() {\n    let xs: Vec<String> = (0..1000).map(|i| \"x\".repeat(i % 17)).collect();\n    assert_eq!(lengths(&xs, 4), xs.iter().map(|s| s.len()).collect::<Vec<_>>());\n    let (got, failed) = lengths_tolerant(&xs, 4);\n    assert_eq!(got.len(), xs.len());\n    assert_eq!(failed, 1);\n    println!(\"ok, {failed} chunk failed but {} lengths kept\", got.len());\n}"
      },
      "questions": [
        {
          "q": "Why can a closure passed to Scope::spawn borrow a local Vec while thread::spawn refuses it?",
          "options": [
            "The scope joins every spawned thread before returning, so the borrow cannot outlive the data",
            "The scope copies the borrowed data into each thread's stack",
            "Scoped threads run on a runtime that tracks lifetimes at run time",
            "The scope leaks the Vec so its lifetime becomes 'static"
          ],
          "answer": 0,
          "explain": "It is purely a lifetime argument: 'scope ends after the joins, so the borrow is provably valid. Nothing is copied, and no runtime tracking happens - the guarantee is erased at compile time."
        },
        {
          "q": "A scoped worker panics and you never call join on its handle. What happens when the scope ends?",
          "options": [
            "The panic is logged and the scope returns normally",
            "The scope resumes the panic on the calling thread",
            "The scope hangs waiting for a worker that will never finish",
            "The process aborts with SIGABRT before unwinding"
          ],
          "answer": 1,
          "explain": "Auto-joined threads propagate their panic, so an unhandled worker failure surfaces as a panic in the parent. Join explicitly if you want to convert it into a domain error instead."
        },
        {
          "q": "Which workload is a bad fit for one-thread-per-item?",
          "options": [
            "A dozen CPU-heavy image transcodes on a build server",
            "40k concurrent idle TCP connections on an 8-core host",
            "Four parallel file copies on a workstation",
            "Six rayon-style chunk jobs over a large array"
          ],
          "answer": 1,
          "explain": "40k threads means 40k stacks (about 80 GiB of reservations at the 2 MiB default) plus kernel scheduling overhead for work that is mostly parked. That is the case async tasks exist for."
        }
      ],
      "quickbytes": [
        "Use thread::scope whenever the data is already in memory; Arc<Mutex<_>> is usually a symptom of fighting 'static.",
        "chunks_mut over a &mut [T] gives you disjoint mutable slices the borrow checker will accept in each thread.",
        "Always join, or accept that a worker panic becomes an invisible failure in production."
      ],
      "production": [
        "Long-lived services name every thread so panics and thread dumps are attributable.",
        "Thread counts are bounded by a pool or a semaphore, never by the size of an incoming batch.",
        "Worker panics are either propagated deliberately or converted to errors with the chunk index attached.",
        "Stack size is raised only where recursion depth demands it, and the reason is in a comment."
      ],
      "crates": [
        "crossbeam-utils",
        "rayon",
        "tokio"
      ],
      "github": [
        {
          "name": "Rust standard library - thread::scope implementation",
          "url": "https://github.com/rust-lang/rust"
        },
        {
          "name": "rayon - scoped fork-join as a higher-level alternative",
          "url": "https://github.com/rayon-rs/rayon"
        }
      ],
      "pitfall": "Dropping JoinHandles to \"fire and forget\": the thread keeps running against data that is being torn down, and the panic that explains the corruption is stored in a handle nobody holds.",
      "resources": [
        {
          "title": "std::thread::scope reference and lifetime notes",
          "url": "https://doc.rust-lang.org/std/thread/fn.scope.html",
          "kind": "docs"
        },
        {
          "title": "The Rust Book, chapter 16.1: threads and move closures",
          "url": "https://doc.rust-lang.org/book/ch16-00-concurrency.html",
          "kind": "docs"
        },
        {
          "title": "crossbeam-utils: scope, CachePadded, Backoff",
          "url": "https://github.com/crossbeam-rs/crossbeam",
          "kind": "repo"
        },
        {
          "title": "rayon: scoped fork-join without hand-written joins",
          "url": "https://docs.rs/rayon/latest/rayon/fn.scope.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "cp03",
      "n": 3,
      "title": "Channels and CSP: moving ownership instead of sharing",
      "minutes": 70,
      "level": "core",
      "goal": "Design a pipeline around owned messages and bounded channels, and explain exactly what happens on a full queue, a closed receiver, and a dropped sender.",
      "sections": [
        {
          "h": "The message is the synchronization",
          "p": [
            "Communicating sequential processes replaces shared mutable state with owned messages. Sending a Vec<u8> moves it; the receiver now owns it exclusively, so no lock, no Arc, and no aliasing exist between the two stages. The compiler enforces the handoff, which is why race conditions in a channel-based pipeline are rare and logic errors are common.",
            "The cost moves elsewhere: every message is a copy or a move plus a queue operation, and the queue is where backpressure and ordering live. A channel is not a magic thread boundary - it is a bounded buffer with a wakeup protocol, and its capacity is a design decision with an operational consequence."
          ],
          "tip": "Write the capacity next to the channel and justify it. channel(1024) with no comment is a guess that becomes an incident."
        },
        {
          "h": "std, crossbeam, or tokio",
          "p": [
            "std::sync::mpsc is one-consumer: channel() is unbounded and sync_channel(n) is bounded, and Sender is Clone while Receiver is not. crossbeam-channel adds multi-producer multi-consumer, select!, recv_timeout, and a bounded queue that performs well under contention. tokio::sync::mpsc is the async counterpart whose send().await is the backpressure point.",
            "Pick by topology and by who blocks. Threads with a fixed fan-out: std is enough. Threads that need to wait on several channels at once: crossbeam's select!. Async tasks: tokio, because a blocking recv would park a worker thread and stall every other task on it. Mixing an async task with std::sync::mpsc::recv is the single most common way to freeze a runtime."
          ],
          "code": "use std::thread;\nuse std::time::Duration;\nuse crossbeam_channel::{bounded, select, unbounded, Receiver, Sender};\n\nfn stage(name: &'static str, rx: Receiver<u64>, tx: Sender<u64>) {\n    thread::spawn(move || {\n        for msg in rx {\n            // A slow stage eventually fills the bounded queue behind it.\n            thread::sleep(Duration::from_micros(50));\n            if tx.send(msg * 2).is_err() {\n                eprintln!(\"{name}: downstream closed\");\n                return;\n            }\n        }\n    });\n}\n\nfn main() {\n    let (tx0, rx0) = bounded::<u64>(8);\n    let (tx1, rx1) = bounded(8);\n    // The terminal collector must not block the sink, or the pipeline stalls\n    // while main is still feeding it; unbounded is safe here because it is drained.\n    let (done_tx, done_rx) = unbounded();\n    stage(\"double\", rx0, tx1);\n    stage(\"sink\", rx1, done_tx);\n\n    for i in 0..1_000 {\n        if tx0.send(i).is_err() { break; }\n    }\n    drop(tx0); // closing the input ends the for-loop over rx\n\n    let mut sum = 0u64;\n    loop {\n        // Arms return Option so control flow stays outside the macro.\n        let next = select! {\n            recv(done_rx) -> v => v.ok(),\n            default(Duration::from_millis(100)) => None,\n        };\n        match next {\n            Some(v) => sum += v,\n            None => break,\n        }\n    }\n    println!(\"sum = {sum}\");\n}"
        },
        {
          "h": "Failure modes hide at the edges",
          "p": [
            "Three edges need explicit policy. A full queue decides whether the producer waits, drops, or sheds. A closed receiver turns send into Err, and ignoring that Err silently discards work. A dropped sender ends the receiver's iteration, which is the normal shutdown signal - but only if every clone of the sender is dropped, which a stray clone in a struct field will prevent.",
            "Unbounded channels remove the first edge and replace it with memory growth: a producer that outruns its consumer will fill RAM until the OOM killer decides the argument. Bounded plus await, or bounded plus a drop counter, are the only two options that keep the failure visible."
          ],
          "list": [
            "Treat send() Err as a shutdown signal and log it once, not per message",
            "Drop every Sender clone to end a for msg in rx loop; a leaked clone hangs shutdown",
            "Use try_send + a dropped counter when overload should shed rather than block",
            "Never call a blocking recv from an async task"
          ]
        }
      ],
      "exercise": {
        "prompt": "Build a three-stage pipeline (parse, transform, write) over crossbeam bounded channels where every stage reports how many messages it processed, and shutdown is driven purely by dropping senders. Then add a fault: the middle stage panics, and the upstream producer must notice instead of blocking forever.",
        "starter": "use crossbeam_channel::{bounded, Receiver, Sender};\n\nfn spawn_stage<F>(name: &'static str, rx: Receiver<u64>, tx: Sender<u64>, f: F)\nwhere F: Fn(u64) -> u64 + Send + 'static {\n    // 1. loop over rx\n    // 2. apply f\n    // 3. forward, and return early if the send fails\n    todo!()\n}",
        "hint": "Dropping the downstream sender on error makes the next send fail with Err, which the producer sees and stops. Count with a local usize and return it through the JoinHandle.",
        "solution": "use crossbeam_channel::{bounded, Receiver, Sender};\nuse std::thread;\n\nfn spawn_stage<F>(name: &'static str, rx: Receiver<u64>, tx: Sender<u64>, f: F) -> thread::JoinHandle<usize>\nwhere\n    F: Fn(u64) -> u64 + Send + 'static,\n{\n    thread::spawn(move || {\n        let mut n = 0usize;\n        for msg in rx {\n            n += 1;\n            if tx.send(f(msg)).is_err() {\n                eprintln!(\"{name}: downstream gone after {n} messages\");\n                return n;\n            }\n        }\n        eprintln!(\"{name}: input closed after {n} messages\");\n        n\n    })\n}\n\nfn main() {\n    let (tx0, rx0) = bounded::<u64>(16);\n    let (tx1, rx1) = bounded(16);\n    let (tx2, rx2) = bounded(16);\n\n    let a = spawn_stage(\"parse\", rx0, tx1, |v| v);\n    let b = spawn_stage(\"transform\", rx1, tx2, |v| v * 3);\n    // A sink consumes without forwarding, so nothing can block on a full tail queue.\n    let c = thread::spawn(move || {\n        let mut n = 0usize;\n        for _ in rx2 {\n            n += 1;\n        }\n        n\n    });\n\n    for i in 0..10_000 {\n        // The bounded queue is the backpressure: this blocks when full.\n        if tx0.send(i).is_err() { break; }\n    }\n    drop(tx0);\n\n    println!(\"parse={} transform={} write={}\",\n             a.join().unwrap(), b.join().unwrap(), c.join().unwrap());\n}"
      },
      "questions": [
        {
          "q": "A pipeline's producers block forever after the consumer task exits. What is the most likely cause?",
          "options": [
            "The consumer's Receiver was moved into a struct that is still alive elsewhere",
            "A Sender clone survives inside another struct, so the channel never closes",
            "The bounded queue is too small, so sends never complete",
            "crossbeam channels require an explicit close() call from the consumer"
          ],
          "answer": 1,
          "explain": "A channel closes when all senders are dropped. One leaked clone in a config struct, a supervisor, or a spawned closure keeps the channel open, so receivers never see the end-of-stream signal and upstream waits forever."
        },
        {
          "q": "Why is std::sync::mpsc::recv() inside a tokio task a production bug?",
          "options": [
            "It is slower than tokio's receiver but otherwise correct",
            "It blocks the worker thread, so every other task scheduled on that thread stalls",
            "It panics when the runtime has more than one worker",
            "It works on current_thread but deadlocks on multi_thread"
          ],
          "answer": 1,
          "explain": "The runtime multiplexes many tasks onto each worker thread. A blocking recv parks the thread inside a task poll, so the other tasks on that thread - including timers and I/O for other connections - stop making progress until the message arrives."
        },
        {
          "q": "You replace an unbounded channel with channel(1_000) and the producer now awaits. What did you actually change?",
          "options": [
            "Nothing measurable; the buffer size does not affect behaviour",
            "Backpressure now propagates to the producer instead of accumulating in RAM",
            "Messages may now be reordered or lost when the buffer is full",
            "The consumer became multi-threaded"
          ],
          "answer": 1,
          "explain": "A bounded queue converts an unbounded memory risk into latency or a blocked producer. Nothing is silently dropped with await-based send, and ordering is preserved; the trade is that slow consumers now slow their producers."
        }
      ],
      "quickbytes": [
        "Choose the channel by topology and blocking model, not by habit: crossbeam for threads, tokio for tasks.",
        "Dropping all senders is the shutdown signal; audit for clones held in long-lived structs.",
        "Every send that can fail needs a policy: propagate, retry, or count the drop."
      ],
      "production": [
        "Every channel in the codebase is bounded, and the capacity is justified in a comment or an ADR.",
        "A dropped message is counted and exported as a metric, never swallowed by `let _ =`.",
        "Shutdown is tested: close the input, drop the senders, and assert that every stage returns.",
        "No blocking channel receive is reachable from an async task; a lint or review rule enforces it."
      ],
      "crates": [
        "crossbeam",
        "crossbeam-channel",
        "tokio",
        "flume"
      ],
      "github": [
        {
          "name": "crossbeam - MPMC channels, deques, and epoch reclamation",
          "url": "https://github.com/crossbeam-rs/crossbeam"
        },
        {
          "name": "tokio - async mpsc, oneshot, and broadcast",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "pitfall": "An unbounded channel in front of a slow consumer: memory climbs linearly with the backlog until the allocator or the OOM killer ends the process, and the queue depth metric you never exported would have shown it hours earlier.",
      "resources": [
        {
          "title": "crossbeam-channel: bounded, select, and timeouts",
          "url": "https://docs.rs/crossbeam/latest/crossbeam/channel/index.html",
          "kind": "docs"
        },
        {
          "title": "tokio::sync::mpsc::channel and its backpressure semantics",
          "url": "https://docs.rs/tokio/latest/tokio/sync/mpsc/fn.channel.html",
          "kind": "docs"
        },
        {
          "title": "std::sync::mpsc: channel and sync_channel",
          "url": "https://doc.rust-lang.org/std/sync/mpsc/fn.channel.html",
          "kind": "docs"
        },
        {
          "title": "Strange Loop: concurrency, queues, and message passing talks",
          "url": "https://www.youtube.com/@StrangeLoopConf",
          "kind": "video"
        }
      ]
    },
    {
      "id": "cp04",
      "n": 4,
      "title": "The actor model without a framework",
      "minutes": 75,
      "level": "advanced",
      "goal": "Build an actor from a mailbox and a loop, make request/response explicit with oneshot reply channels, and avoid the synchronous call cycle that deadlocks actor systems.",
      "sections": [
        {
          "h": "An actor is a task that owns something",
          "p": [
            "Strip the terminology and an actor is: a task with a mailbox, private state, and a message handler that runs one message at a time. Because only the task touches the state, there are no locks and no data races; because messages queue, the actor serializes its own mutations and you get a natural place to put invariants.",
            "You do not need a framework to get this. tokio::sync::mpsc gives the mailbox, oneshot gives the reply, and a match arm gives the handler. What a framework adds is supervision trees, remote addressing, and persistence - real value, but not needed to decide whether the pattern fits your problem."
          ],
          "tip": "Name the actor's invariant in one sentence before writing the loop. If you cannot, the state belongs in a plain function instead."
        },
        {
          "h": "Request/response without a lock",
          "p": [
            "A command that needs an answer carries a oneshot::Sender in the message. The caller creates (tx, rx), sends the message, and awaits rx. If the actor panics or its mailbox closes, the reply sender is dropped and the caller gets RecvError - which is an error, not a hang, and that difference is the point.",
            "Bounded mailboxes are the backpressure. send().await blocks the caller when the actor is behind, propagating slowness instead of buffering it. try_send gives you the shedding option, but then the caller must handle TrySendError::Full explicitly, or messages vanish under exactly the load you care about."
          ],
          "code": "use tokio::sync::{mpsc, oneshot};\n\nenum Msg {\n    Inc(u64),\n    Get(oneshot::Sender<u64>),\n}\n\nstruct Counter {\n    value: u64,\n    rx: mpsc::Receiver<Msg>,\n}\n\nimpl Counter {\n    async fn run(mut self) {\n        while let Some(msg) = self.rx.recv().await {\n            match msg {\n                Msg::Inc(n) => self.value = self.value.saturating_add(n),\n                Msg::Get(reply) => {\n                    // The caller may have timed out and dropped rx; ignore that.\n                    let _ = reply.send(self.value);\n                }\n            }\n        }\n        // Mailbox closed: all senders dropped. Flush here if you must.\n    }\n}\n\n#[tokio::main]\nasync fn main() {\n    let (tx, rx) = mpsc::channel(64);\n    tokio::spawn(Counter { value: 0, rx }.run());\n\n    for _ in 0..1000 {\n        tx.send(Msg::Inc(1)).await.unwrap();\n    }\n    let (rtx, rrx) = oneshot::channel();\n    tx.send(Msg::Get(rtx)).await.unwrap();\n    assert_eq!(rrx.await.unwrap(), 1000);\n    println!(\"value = 1000\");\n}"
        },
        {
          "h": "The call cycle that hangs",
          "p": [
            "Actors deadlock on synchronous cycles. If actor A handles a message by sending to B and awaiting the reply, and B is currently handling a message that sends to A and awaits, both mailboxes are full of handlers that will never run: A is blocked on B's reply and B on A's. One request per actor in flight is enough to do it.",
            "The fixes are structural: send-and-forget with a later callback message, a bounded timeout on every reply, or a supervisor that owns the cycle. Timeouts turn a permanent hang into a recurring error you can alert on, which is why every request/reply actor call should carry one."
          ],
          "list": [
            "Every request/response carries a timeout at the call site",
            "Never await an actor reply while holding a lock the other actor needs",
            "Log the actor name and message kind on a reply timeout",
            "Shard hot actors by key instead of scaling the mailbox depth"
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement a key-value actor that owns a HashMap and handles Get, Set, and Delete with reply channels and a bounded mailbox. Add a timeout helper so a caller can never wait forever, and a snapshot command that returns a clone for a debug endpoint.",
        "starter": "use std::collections::HashMap;\nuse tokio::sync::{mpsc, oneshot};\n\nenum Msg {\n    // Get { key, reply }\n    // Set { key, value, reply }\n    // Delete { key, reply }\n    // Snapshot { reply }\n}\n\nstruct Store { map: HashMap<String, String>, rx: mpsc::Receiver<Msg> }\n\nasync fn call(tx: &mpsc::Sender<Msg>, msg: Msg) -> Result<(), String> {\n    // send + await with a 250 ms budget\n    todo!()\n}",
        "hint": "oneshot::Sender<String> for Get, oneshot::Sender<()> for Set/Delete, and oneshot::Sender<Vec<(String, String)>> for Snapshot. Wrap the reply await in tokio::time::timeout and map Elapsed to a String error.",
        "solution": "use std::collections::HashMap;\nuse std::time::Duration;\nuse tokio::sync::{mpsc, oneshot};\nuse tokio::time::timeout;\n\nenum Msg {\n    Get { key: String, reply: oneshot::Sender<Option<String>> },\n    Set { key: String, value: String, reply: oneshot::Sender<()> },\n    Delete { key: String, reply: oneshot::Sender<bool> },\n    Snapshot { reply: oneshot::Sender<Vec<(String, String)>> },\n}\n\nstruct Store { map: HashMap<String, String>, rx: mpsc::Receiver<Msg> }\n\nimpl Store {\n    async fn run(mut self) {\n        while let Some(msg) = self.rx.recv().await {\n            match msg {\n                Msg::Get { key, reply } => { let _ = reply.send(self.map.get(&key).cloned()); }\n                Msg::Set { key, value, reply } => {\n                    self.map.insert(key, value);\n                    let _ = reply.send(());\n                }\n                Msg::Delete { key, reply } => { let _ = reply.send(self.map.remove(&key).is_some()); }\n                Msg::Snapshot { reply } => {\n                    let _ = reply.send(self.map.iter().map(|(k, v)| (k.clone(), v.clone())).collect());\n                }\n            }\n        }\n    }\n}\n\n/// Every call is bounded: a wedged actor becomes an error, not a hang.\nasync fn call<T>(\n    tx: &mpsc::Sender<Msg>,\n    msg: Msg,\n    rx: oneshot::Receiver<T>,\n) -> Result<T, String> {\n    tx.send(msg).await.map_err(|_| \"actor gone\".to_string())?;\n    timeout(Duration::from_millis(250), rx)\n        .await\n        .map_err(|_| \"actor reply timed out\".to_string())?\n        .map_err(|_| \"actor dropped reply\".to_string())\n}\n\n#[tokio::main]\nasync fn main() {\n    let (tx, rx) = mpsc::channel(64);\n    tokio::spawn(Store { map: HashMap::new(), rx }.run());\n\n    let (rtx, rrx) = oneshot::channel();\n    call(&tx, Msg::Set { key: \"a\".into(), value: \"1\".into(), reply: rtx }, rrx).await.unwrap();\n\n    let (rtx, rrx) = oneshot::channel();\n    let got = call(&tx, Msg::Get { key: \"a\".into(), reply: rtx }, rrx).await.unwrap();\n    assert_eq!(got.as_deref(), Some(\"1\"));\n    println!(\"ok\");\n}"
      },
      "questions": [
        {
          "q": "Actor A handles a command by sending to B and awaiting the reply; B does the same toward A. Both mailboxes have depth 1. What happens?",
          "options": [
            "Both messages are processed because mailboxes are FIFO",
            "The two handlers block on each other's replies and both actors wedge",
            "The runtime detects the cycle and returns a JoinError",
            "Only the lower-priority actor stalls; the other completes"
          ],
          "answer": 1,
          "explain": "Each actor is inside a handler that cannot return until the other replies, but the other cannot run the handler while it is itself blocked. Nothing detects it - the tasks are simply awaiting oneshots that will never fire."
        },
        {
          "q": "What does a dropped oneshot::Sender on the actor side do to the caller?",
          "options": [
            "Blocks the caller until the mailbox closes",
            "Makes the caller's await return RecvError immediately",
            "Panics the caller's task",
            "Resends the message automatically"
          ],
          "answer": 1,
          "explain": "The reply channel closes with the sender, so the caller observes an error. That is the desired property: an actor crash surfaces as a typed failure instead of an infinite await - provided the caller maps it instead of unwrapping."
        },
        {
          "q": "Which change most directly bounds actor memory during a traffic spike?",
          "options": [
            "Increasing the mailbox capacity so senders rarely wait",
            "Using a bounded mailbox and awaiting send, so producers slow down",
            "Switching from mpsc to broadcast",
            "Spawning one actor per message"
          ],
          "answer": 1,
          "explain": "A bounded mailbox with awaited send applies backpressure at the producer. Raising capacity just moves the cliff, broadcast multiplies work, and per-message actors move the queue into the task scheduler where it is harder to observe."
        }
      ],
      "quickbytes": [
        "Actor = task + mailbox + private state. Reach for a framework only when you need supervision or remote addressing.",
        "Every request/reply needs a timeout; without one, a wedged actor is indistinguishable from a slow one.",
        "Bounded mailbox plus awaited send is backpressure; unbounded is a memory leak with extra steps."
      ],
      "production": [
        "Each actor has a bounded mailbox and a documented overload policy.",
        "Reply timeouts are set below the caller's deadline and produce a metric tagged with the actor name.",
        "Actor shutdown is deterministic: close the mailbox, drain, then drop state in an explicit flush step.",
        "Synchronous actor call cycles are forbidden by review; cycles use callbacks or a supervisor."
      ],
      "crates": [
        "tokio",
        "tokio-util",
        "async-trait",
        "tracing"
      ],
      "github": [
        {
          "name": "actix - actor framework for Rust",
          "url": "https://github.com/actix/actix"
        },
        {
          "name": "tokio - mpsc and oneshot primitives used by hand-rolled actors",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "pitfall": "Unwrapping the reply in a request handler: when the actor panics, the caller's task panics too, and a single bad message cascades into a wave of 500s instead of one failed request with a clear error.",
      "resources": [
        {
          "title": "tokio::sync::oneshot: reply channels and error semantics",
          "url": "https://docs.rs/tokio/latest/tokio/sync/oneshot/index.html",
          "kind": "docs"
        },
        {
          "title": "actix: actor model, supervision, and mailbox types",
          "url": "https://github.com/actix/actix",
          "kind": "repo"
        },
        {
          "title": "Tokio tutorial: shared state and message passing",
          "url": "https://tokio.rs/tokio/tutorial",
          "kind": "docs"
        },
        {
          "title": "InfoQ: actor systems and message-driven architecture talks",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        }
      ]
    },
    {
      "id": "cp05",
      "n": 5,
      "title": "Shared state: choosing the right lock",
      "minutes": 75,
      "level": "advanced",
      "goal": "Pick between ownership, atomics, sharding, and the four lock flavours using access pattern and critical-section length, rather than defaulting to Arc<Mutex<T>>.",
      "sections": [
        {
          "h": "The lock is the last resort, not the first",
          "p": [
            "Before choosing a lock, ask whether the data needs to be shared at all. A single writer becomes an owner plus a channel. Read-mostly data becomes an immutable Arc rebuilt on change, so readers take no lock. Independent counters become atomics. Only when several writers must mutate a compound invariant do you need mutual exclusion - and then the question becomes which one.",
            "The strongest signal is the critical section's shape. A few instructions touching one field: atomic. A map lookup: a lock, but a short one. A network call or an await: not a lock problem at all, it is a state-machine problem, and holding any lock across it is how throughput dies."
          ],
          "tip": "If the answer to \"what does this lock protect?\" takes more than one sentence, split the state until each lock has a one-sentence answer."
        },
        {
          "h": "Four locks, four trade-offs",
          "p": [
            "std::sync::Mutex is the reference implementation: a futex on Linux, poisoning on panic, and an unspecified handoff policy. parking_lot::Mutex is one word, has no poisoning, spins adaptively before parking, and is measurably faster uncontended; it also ships FairMutex and a deadlock detector behind a feature. Both are synchronous: their guards must not cross an await.",
            "tokio::sync::Mutex is the async-aware one. Its guard is Send, it queues waiters in FIFO order, and it costs noticeably more than the std lock in an uncontended path. It exists for exactly one case: you must hold the lock across an await point. If you can restructure so you do not, do that instead - a tokio Mutex serializes every waiter behind a slow await, which is a latency amplifier."
          ],
          "list": [
            "Short, synchronous critical section: std or parking_lot Mutex",
            "Read-heavy with rare writes: RwLock, or an immutable snapshot behind Arc",
            "Must hold across .await: tokio::sync::Mutex, and only then",
            "One word of state with no invariant: AtomicUsize/AtomicU64"
          ]
        },
        {
          "h": "The guard that outlives its scope",
          "p": [
            "clippy::await_holding_lock exists because the bug compiles. With a std guard, tokio::spawn usually rejects the future since the guard is not Send, but a current_thread runtime accepts it and then blocks the only worker. With a tokio guard, the code compiles everywhere and simply serializes all waiters behind whatever the holder is awaiting.",
            "The reliable discipline is to keep lock scope inside a synchronous helper. The helper takes &self, locks, mutates, and returns a plain value; the async function calls it, gets an owned result, and only then awaits. The guard never exists in the async state machine, so the question cannot arise."
          ],
          "code": "use std::collections::HashMap;\nuse std::sync::{Arc, Mutex};\n\n#[derive(Clone, Default)]\nstruct Registry(Arc<Mutex<HashMap<String, u32>>>);\n\nimpl Registry {\n    /// Synchronous on purpose: the guard cannot escape this body.\n    fn record(&self, key: &str) -> u32 {\n        let mut map = self.0.lock().expect(\"registry poisoned\");\n        let entry = map.entry(key.to_owned()).or_insert(0);\n        *entry += 1;\n        *entry\n    }\n}\n\nasync fn handle(reg: Registry, key: String) -> u32 {\n    let hits = reg.record(&key); // guard acquired and released here\n    let encoded = encode(&key).await; // no lock is alive across this await\n    hits + encoded\n}\n\nasync fn encode(_key: &str) -> u32 {\n    tokio::time::sleep(std::time::Duration::from_millis(1)).await;\n    1\n}"
        }
      ],
      "exercise": {
        "prompt": "A handler locks a HashMap, then awaits a 20 ms database call while still holding the guard. Restructure it so no guard crosses an await, and state the throughput consequence of the alternative.",
        "starter": "use std::collections::HashMap;\nuse std::sync::{Arc, Mutex};\n\nasync fn get_or_load(\n    cache: Arc<Mutex<HashMap<String, String>>>,\n    key: String,\n) -> String {\n    let mut map = cache.lock().unwrap();\n    if let Some(v) = map.get(&key) {\n        return v.clone();\n    }\n    // BUG: the guard is alive across this await.\n    let loaded = load_from_db(&key).await;\n    map.insert(key, loaded.clone());\n    loaded\n}\n\nasync fn load_from_db(_key: &str) -> String { \"value\".to_string() }",
        "hint": "Lock, check, drop the guard, then await outside. Re-check under a second short lock before inserting so two callers do not both write, and note that a tokio::sync::Mutex would let you hold across the await at the cost of serializing all readers.",
        "solution": "use std::collections::HashMap;\nuse std::sync::{Arc, Mutex};\n\nasync fn get_or_load(\n    cache: Arc<Mutex<HashMap<String, String>>>,\n    key: String,\n) -> String {\n    // 1. Short critical section: look up, then release.\n    {\n        let map = cache.lock().expect(\"cache poisoned\");\n        if let Some(v) = map.get(&key) {\n            return v.clone();\n        }\n    } // guard dropped here, before any await\n\n    // 2. Slow work with no lock held.\n    let loaded = load_from_db(&key).await;\n\n    // 3. Short critical section again: last writer is fine, both wrote the same value.\n    let mut map = cache.lock().expect(\"cache poisoned\");\n    map.entry(key).or_insert(loaded).clone()\n}\n\nasync fn load_from_db(_key: &str) -> String {\n    tokio::time::sleep(std::time::Duration::from_millis(20)).await;\n    \"value\".to_string()\n}\n\n#[tokio::main]\nasync fn main() {\n    let cache = Arc::new(Mutex::new(HashMap::new()));\n    let a = get_or_load(cache.clone(), \"k\".into()).await;\n    let b = get_or_load(cache.clone(), \"k\".into()).await;\n    assert_eq!(a, b);\n    println!(\"ok\");\n}"
      },
      "questions": [
        {
          "q": "When is tokio::sync::Mutex the correct choice over std::sync::Mutex?",
          "options": [
            "Whenever the lock is inside an async function",
            "Only when the guard must be held across an .await point",
            "Whenever more than four tasks contend for the lock",
            "On current_thread runtimes, where std locks do not work"
          ],
          "answer": 1,
          "explain": "Both work in async code as long as the guard's scope contains no await. The async mutex exists to make holding a guard across await possible and safe; using it otherwise adds a slower, fairer queue for no benefit."
        },
        {
          "q": "Why does a std::sync::Mutex guard held across an await usually fail to compile in tokio::spawn?",
          "options": [
            "The guard is not Send, so the spawned future is not Send",
            "std mutexes cannot be used in async functions at all",
            "tokio::spawn requires all locals to be 'static",
            "Clippy rejects it before rustc sees it"
          ],
          "answer": 0,
          "explain": "MutexGuard is !Send, and a future that holds one across an await is therefore !Send, so spawn's Send bound rejects it. Inside a current_thread runtime or block_on the same code compiles and can stall the worker instead."
        },
        {
          "q": "You replace Arc<Mutex<HashMap<..>>> with one mutex per 16 shards keyed by hash. What did you buy?",
          "options": [
            "Lower per-operation latency on a single key",
            "Less contention across keys, at the cost of occasional cross-shard reads",
            "Stronger consistency for multi-key invariants",
            "Nothing: sharding only helps with atomics"
          ],
          "answer": 1,
          "explain": "Contention drops when threads touch different keys, and throughput rises with core count. Operations that need several keys at once must now take several locks in a fixed order, which is why sharding trades simplicity for concurrency."
        }
      ],
      "quickbytes": [
        "Try ownership and a channel first; a lock is a shared-memory design decision with an ongoing cost.",
        "Keep lock scope inside sync helpers so a guard can never be captured into an async state machine.",
        "parking_lot for throughput with no poisoning; tokio::sync for guards that must survive an await."
      ],
      "production": [
        "Every lock has a comment naming the invariant it protects and the ordering rule it obeys.",
        "clippy::await_holding_lock is denied in the workspace lint table, not left to review discipline.",
        "Contended locks are visible in profiling; a hot mutex is treated as a design bug, not tuned.",
        "Poisoning policy is explicit: recover, fail the request, or abort, chosen per lock."
      ],
      "crates": [
        "parking_lot",
        "tokio",
        "arc-swap",
        "crossbeam-utils"
      ],
      "github": [
        {
          "name": "parking_lot - compact mutexes, FairMutex, deadlock detection",
          "url": "https://github.com/Amanieu/parking_lot"
        },
        {
          "name": "arc-swap - lock-free reads of a rarely replaced Arc",
          "url": "https://github.com/vorner/arc-swap"
        }
      ],
      "pitfall": "Holding a lock across an await and calling it \"fine because it compiles\": every other task waiting on that lock is now serialized behind the slowest network call in the system, and the queue depth grows without any lock contention showing up in profiles.",
      "resources": [
        {
          "title": "parking_lot: Mutex, RwLock, FairMutex and feature flags",
          "url": "https://docs.rs/parking_lot/latest/parking_lot/",
          "kind": "docs"
        },
        {
          "title": "std::sync::Mutex: poisoning and guard semantics",
          "url": "https://doc.rust-lang.org/std/sync/struct.Mutex.html",
          "kind": "docs"
        },
        {
          "title": "tokio::sync::Mutex: async-aware, fair, guard is Send",
          "url": "https://docs.rs/tokio/latest/tokio/sync/struct.Mutex.html",
          "kind": "docs"
        },
        {
          "title": "Rust Clippy: await_holding_lock lint",
          "url": "https://clippy.rust-lang.org/master/index.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "cp06",
      "n": 6,
      "title": "Atomics and memory ordering",
      "minutes": 90,
      "level": "advanced",
      "goal": "Choose an ordering from the synchronization it must establish, publish data with a Release/Acquire pair, and recognise why a Relaxed bug survives on x86 and dies on ARM.",
      "sections": [
        {
          "h": "What atomic actually buys",
          "p": [
            "An atomic gives two things: the operation is indivisible (no torn reads or writes) and every location has a single modification order that all threads can agree on. It does not give you ordering of surrounding memory operations - that is what the Ordering argument does, and it is the part almost every bug gets wrong.",
            "A data race is two threads accessing the same location concurrently, at least one writing, with no happens-before edge between them. In Rust that is undefined behaviour regardless of what the hardware appears to do, which is why a program that \"works on x86\" is not evidence of correctness: x86 is strongly ordered and will hide a missing Acquire for years."
          ],
          "tip": "Write the synchronization you need as a sentence first: \"the reader must see the buffer writes before it sees the flag\". That sentence maps to Release then Acquire."
        },
        {
          "h": "Four orderings, one job each",
          "p": [
            "Relaxed preserves atomicity and nothing else: no other access may be assumed ordered around it. Acquire on a load means later operations cannot move before it; Release on a store means earlier operations cannot move after it. AcqRel is the pair for read-modify-write operations like compare_exchange, which both read and write.",
            "SeqCst adds a single total order over all SeqCst operations, at the cost of fences even on x86. The honest default is SeqCst until you can state the exact pair you are replacing - then Relaxed for a standalone counter, Acquire/Release for a handoff, and AcqRel for a CAS that publishes."
          ],
          "code": "use std::cell::UnsafeCell;\nuse std::sync::atomic::{AtomicBool, Ordering};\n\n/// A single-slot handoff. Sketch only: one sender, one receiver.\nstruct Slot<T> {\n    value: UnsafeCell<Option<T>>,\n    ready: AtomicBool,\n}\n\nunsafe impl<T: Send> Sync for Slot<T> {}\n\nimpl<T> Slot<T> {\n    fn new() -> Self {\n        Self { value: UnsafeCell::new(None), ready: AtomicBool::new(false) }\n    }\n\n    fn send(&self, v: T) {\n        unsafe { *self.value.get() = Some(v) };\n        // Release: the slot write above cannot be reordered after this store.\n        self.ready.store(true, Ordering::Release);\n    }\n\n    fn try_recv(&self) -> Option<T> {\n        // Acquire: the slot read below cannot be reordered before this load.\n        if self.ready.load(Ordering::Acquire) {\n            unsafe { (*self.value.get()).take() }\n        } else {\n            None\n        }\n    }\n}"
        },
        {
          "h": "Why the wrong ordering compiles and passes CI",
          "p": [
            "Change both orderings to Relaxed in the example above and nothing observable changes on an x86 laptop: the store buffer still drains in program order for these accesses. On ARM64, where writes may become visible out of order, the reader can observe ready == true and a None slot. Your CI on x86 will never produce the failure.",
            "This is the case for loom (lesson 16) and for running tests on both architectures. It is also the case for keeping the atomic surface tiny: every additional atomic is another ordering argument someone has to re-derive during review. Prefer a mutex over an incorrectly ordered atomic - correctness first, then measure."
          ],
          "list": [
            "Relaxed: metrics counters, sequence numbers with no data attached",
            "Acquire load / Release store: publish a structure, then a flag",
            "AcqRel: compare_exchange that both claims and publishes",
            "SeqCst: anything you cannot yet prove weaker, and stop there"
          ]
        }
      ],
      "exercise": {
        "prompt": "A worker builds a Config, stores it in a Box, publishes the pointer through an AtomicPtr with Relaxed, and the reader loads with Relaxed before dereferencing. Explain the bug, fix the orderings, and say which tool would have caught it on x86.",
        "starter": "use std::ptr;\nuse std::sync::atomic::{AtomicPtr, Ordering};\n\nstruct Config { workers: usize }\n\nstatic CONFIG: AtomicPtr<Config> = AtomicPtr::new(ptr::null_mut());\n\nfn publish(cfg: Box<Config>) {\n    let raw = Box::into_raw(cfg);\n    // 1. is Relaxed enough here?\n    CONFIG.store(raw, Ordering::Relaxed);\n}\n\nfn read_workers() -> Option<usize> {\n    let p = CONFIG.load(Ordering::Relaxed);\n    if p.is_null() { return None; }\n    // 2. what guarantee is missing?\n    Some(unsafe { (*p).workers })\n}",
        "hint": "The reader may see the pointer before the Config bytes are visible, so it dereferences uninitialized memory. Store with Release and load with Acquire; on x86 the bug is invisible, so loom with cfg(loom) types is the tool that exposes it.",
        "solution": "use std::ptr;\nuse std::sync::atomic::{AtomicPtr, Ordering};\n\nstruct Config { workers: usize }\n\nstatic CONFIG: AtomicPtr<Config> = AtomicPtr::new(ptr::null_mut());\n\nfn publish(cfg: Box<Config>) {\n    let raw = Box::into_raw(cfg);\n    // Release: every write that built the Config happens-before this store.\n    CONFIG.store(raw, Ordering::Release);\n}\n\nfn read_workers() -> Option<usize> {\n    // Acquire: the reads of *p below cannot move before this load, so they\n    // observe the initialized Config, not a torn or default one.\n    let p = CONFIG.load(Ordering::Acquire);\n    if p.is_null() {\n        return None;\n    }\n    Some(unsafe { (*p).workers })\n}\n\nfn main() {\n    publish(Box::new(Config { workers: 8 }));\n    assert_eq!(read_workers(), Some(8));\n    println!(\"ok\");\n}\n\n// Leak note: a real implementation reclaims the old Box with crossbeam-epoch.\n// A Relaxed/Relaxed version of this code passes on x86 and fails under\n// RUSTFLAGS=\"--cfg loom\" cargo test --release, because loom enumerates the\n// interleaving where the pointer lands first."
      },
      "questions": [
        {
          "q": "Writer does `data = 42; flag.store(true, Release)`. Reader does `if flag.load(Acquire) { read(data) }`. What is guaranteed?",
          "options": [
            "The reader necessarily runs after the writer and sees 42",
            "If the reader sees true, it also sees the write to data",
            "The reader sees 42 only if it also loads with SeqCst",
            "Nothing, because data is not atomic"
          ],
          "answer": 1,
          "explain": "Release/Acquire on the same location creates a happens-before edge, so the data write is visible whenever the flag is. It does not force the reader to run later - it only constrains what it can observe if it does see the flag."
        },
        {
          "q": "A request counter is incremented by every worker purely for a metrics endpoint. Which ordering is defensible?",
          "options": [
            "SeqCst, because counters must never lose increments",
            "Relaxed, because the counter synchronizes no other memory",
            "AcqRel, because fetch_add both reads and writes",
            "Release, because the value is published to a metrics thread"
          ],
          "answer": 1,
          "explain": "fetch_add is already atomic under any ordering, so increments are never lost. Relaxed only gives up ordering of surrounding accesses, which a standalone counter does not need and does not provide to anything else."
        },
        {
          "q": "What does compare_exchange return when it fails?",
          "options": [
            "Err with the value that was actually in the atomic",
            "Ok with the value it wrote anyway",
            "A bool, with no information about the current value",
            "It panics unless you pass compare_exchange_weak"
          ],
          "answer": 0,
          "explain": "On failure it returns Err(actual), which is why the standard CAS loop assigns cur = actual and retries. compare_exchange_weak may fail spuriously, so it is the right choice inside a loop that reloads anyway."
        }
      ],
      "quickbytes": [
        "Ordering is about visibility of other memory, not about the atomic operation itself.",
        "Release store plus Acquire load on the same location is the publish primitive; memorise that pair first.",
        "If you cannot name the ordering argument in one sentence, use SeqCst and leave a comment saying why."
      ],
      "production": [
        "Every non-SeqCst atomic has a comment stating the happens-before edge it participates in.",
        "Unsafe atomic handoffs are covered by a loom test in CI, not only by review.",
        "At least one CI leg runs on a weakly ordered target (ARM64) for crates with manual atomics.",
        "Atomic types are chosen with an eye on target support; AtomicU64 is not universal on 32-bit targets."
      ],
      "crates": [
        "crossbeam-utils",
        "loom",
        "parking_lot",
        "crossbeam-epoch"
      ],
      "github": [
        {
          "name": "Rust standard library: atomic types and Ordering",
          "url": "https://github.com/rust-lang/rust"
        },
        {
          "name": "loom - model checker for C11 memory orderings",
          "url": "https://github.com/tokio-rs/loom"
        }
      ],
      "pitfall": "Using Relaxed for a publish flag because the test passed: x86 hides the missing Acquire, so the bug ships and appears only on ARM servers or under a model checker, usually as a nil dereference in a code path nobody can reproduce.",
      "resources": [
        {
          "title": "std::sync::atomic::Ordering reference",
          "url": "https://doc.rust-lang.org/std/sync/atomic/enum.Ordering.html",
          "kind": "docs"
        },
        {
          "title": "The Rustonomicon: atomics and the C++ memory model",
          "url": "https://doc.rust-lang.org/nomicon/atomics.html",
          "kind": "docs"
        },
        {
          "title": "loom: permutation testing of memory orderings",
          "url": "https://docs.rs/loom/latest/loom/",
          "kind": "docs"
        },
        {
          "title": "Strange Loop: memory models and lock-free data structure talks",
          "url": "https://www.youtube.com/@StrangeLoopConf",
          "kind": "video"
        }
      ]
    },
    {
      "id": "cp07",
      "n": 7,
      "title": "Lock-free basics: CAS loops and ABA",
      "minutes": 85,
      "level": "advanced",
      "goal": "Read and write a compare-exchange loop correctly, state the progress guarantee it provides, and recognise ABA as a reclamation problem rather than a comparison problem.",
      "sections": [
        {
          "h": "A CAS loop is a retry protocol",
          "p": [
            "Lock-free updates follow one shape: load the current value, compute the next state, then compare_exchange to install it only if nothing changed. On failure you receive the actual value and retry with it. compare_exchange_weak may fail spuriously on LL/SC architectures even when the value matched, which is fine inside a loop and is why the weak form is the idiomatic one there.",
            "The loop's cost is contention: every loser re-reads and re-computes. Under heavy contention the retries can dominate, so a real implementation adds backoff, batches updates per thread, or admits that a mutex with a longer critical section is faster. Lock-free is a latency and progress property, not an automatic throughput win."
          ],
          "tip": "Prefer fetch_update over a hand-written retry loop; it exists precisely so the reload-retry logic is not re-derived per call site."
        },
        {
          "h": "Progress guarantees, stated honestly",
          "p": [
            "Wait-free means every thread finishes in a bounded number of its own steps. Lock-free means at least one thread makes progress system-wide, so a stalled thread cannot block everyone. Obstruction-free means progress only if a thread runs in isolation. Most production \"lock-free\" queues are lock-free but not wait-free, and a naive CAS loop with no backoff is technically lock-free while behaving badly under contention.",
            "These guarantees matter when a thread can be descheduled mid-operation - a preempted lock holder blocks everyone, which is why a mutex is unsafe inside a signal handler or a real-time loop. For an ordinary web service, a short mutex is usually the faster and clearer choice."
          ],
          "code": "use std::sync::atomic::{AtomicU64, Ordering};\n\n/// Lock-free max, written as the canonical CAS loop.\n/// std already provides fetch_max since 1.45; this is the shape, not a replacement.\npub fn raise_to(v: &AtomicU64, candidate: u64) -> u64 {\n    let mut cur = v.load(Ordering::Relaxed);\n    loop {\n        if candidate <= cur {\n            return cur;\n        }\n        match v.compare_exchange_weak(cur, candidate, Ordering::AcqRel, Ordering::Relaxed) {\n            Ok(_) => return cur,\n            Err(actual) => cur = actual, // lost the race; retry from reality\n        }\n    }\n}\n\nfn main() {\n    let v = AtomicU64::new(7);\n    assert_eq!(raise_to(&v, 3), 7);\n    assert_eq!(raise_to(&v, 9), 7);\n    assert_eq!(v.load(Ordering::Relaxed), 9);\n    println!(\"ok\");\n}"
        },
        {
          "h": "ABA is memory reclamation in disguise",
          "p": [
            "A Treiber stack pop reads the head pointer, reads head.next, then CASes head from A to next. If another thread pops A, pushes A back, and the allocator reuses the same address, the CAS succeeds against a stack that has changed underneath, and next may point to freed memory. The comparison is correct; the assumption that equal pointer means same object is not.",
            "Fixes are memory-management schemes rather than cleverer comparisons: tagged pointers with a version counter, hazard pointers, or epoch-based reclamation as implemented by crossbeam-epoch. This is the point where hand-rolling stops being reasonable: use crossbeam's deque or queue, and keep your unsafe to the boundary you can loom-test."
          ],
          "list": [
            "Never free a node another thread might still be reading",
            "Version-tag the pointer so ABA becomes a detectable mismatch",
            "Prefer crossbeam's battle-tested structures over a bespoke stack",
            "Write the loom test before the third retry arm"
          ]
        }
      ],
      "exercise": {
        "prompt": "Build a spin lock from an AtomicBool with a CAS acquire and a Release unlock, add exponential backoff so it does not hammer the cache line, and write a test where four threads increment a shared counter 100k times each.",
        "starter": "use std::sync::atomic::{AtomicBool, Ordering};\n\npub struct SpinLock {\n    locked: AtomicBool,\n}\n\nimpl SpinLock {\n    pub const fn new() -> Self { Self { locked: AtomicBool::new(false) } }\n    pub fn lock(&self) { /* CAS loop + backoff */ }\n    pub fn unlock(&self) { /* Release store */ }\n}\n\nimpl Drop for SpinLock {\n    fn drop(&mut self) { /* nothing to do, but document it */ }\n}",
        "hint": "Acquire on success, Relaxed on the failed probe, and Release to unlock. Use crossbeam_utils::Backoff and call snooze() while spinning; std::hint::spin_loop() is the raw fallback.",
        "solution": "use std::cell::UnsafeCell;\nuse std::ops::{Deref, DerefMut};\nuse std::sync::atomic::{AtomicBool, Ordering};\nuse std::thread;\nuse crossbeam_utils::Backoff;\n\npub struct SpinLock<T> {\n    locked: AtomicBool,\n    data: UnsafeCell<T>,\n}\n\nunsafe impl<T: Send> Sync for SpinLock<T> {}\nunsafe impl<T: Send> Send for SpinLock<T> {}\n\npub struct Guard<'a, T> {\n    lock: &'a SpinLock<T>,\n}\n\nimpl<T> SpinLock<T> {\n    pub const fn new(value: T) -> Self {\n        Self { locked: AtomicBool::new(false), data: UnsafeCell::new(value) }\n    }\n\n    pub fn lock(&self) -> Guard<'_, T> {\n        let backoff = Backoff::new();\n        loop {\n            if self\n                .locked\n                .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)\n                .is_ok()\n            {\n                return Guard { lock: self };\n            }\n            while self.locked.load(Ordering::Relaxed) {\n                backoff.snooze();\n            }\n            backoff.spin();\n        }\n    }\n}\n\nimpl<T> Deref for Guard<'_, T> {\n    type Target = T;\n    fn deref(&self) -> &T { unsafe { &*self.lock.data.get() } }\n}\n\nimpl<T> DerefMut for Guard<'_, T> {\n    fn deref_mut(&mut self) -> &mut T { unsafe { &mut *self.lock.data.get() } }\n}\n\nimpl<T> Drop for Guard<'_, T> {\n    fn drop(&mut self) {\n        // Release: every write inside the critical section is visible to the\n        // next thread that acquires this lock.\n        self.lock.locked.store(false, Ordering::Release);\n    }\n}\n\nfn main() {\n    let lock = SpinLock::new(0u64);\n    thread::scope(|s| {\n        for _ in 0..4 {\n            s.spawn(|| {\n                for _ in 0..100_000 {\n                    *lock.lock() += 1;\n                }\n            });\n        }\n    });\n    assert_eq!(*lock.lock(), 400_000);\n    println!(\"ok\");\n}"
      },
      "questions": [
        {
          "q": "Why is compare_exchange_weak preferred inside a retry loop on LL/SC architectures?",
          "options": [
            "It is always faster because it skips the atomic read",
            "It may fail spuriously, and the loop already reloads and retries",
            "It guarantees a total order that the strong form does not",
            "It cannot fail when the value matches, unlike the strong form"
          ],
          "answer": 1,
          "explain": "On LL/SC, a spurious failure can occur without interference, and a loop that reloads handles it for free. The strong form is for single-shot attempts where a spurious failure would be a real error."
        },
        {
          "q": "What makes a Treiber stack pop vulnerable to ABA?",
          "options": [
            "Two threads pop the same element and double free it",
            "The address can be freed and reused, so an equal pointer no longer means an equal node",
            "The CAS compares the value of the element rather than the pointer",
            "The stack is unbounded, so the head can wrap around"
          ],
          "answer": 1,
          "explain": "ABA is an identity problem: pointer equality is used as object identity, but after a free and reallocation the address can hold something else. That is why the fix is reclamation - epochs, hazard pointers, tags - not a different comparison."
        },
        {
          "q": "A CAS loop under 64-way contention is slower than a mutex, yet it is lock-free. How?",
          "options": [
            "Lock-free guarantees system-wide progress, not throughput or fairness",
            "The benchmark must have been measuring incorrectly",
            "Lock-free structures are only faster on ARM",
            "CAS loops are actually wait-free and should win"
          ],
          "answer": 0,
          "explain": "Progress and speed are separate claims. Lock-free means some thread always advances; it says nothing about cache-line traffic from 64 losers retrying, which a mutex avoids by parking them."
        }
      ],
      "quickbytes": [
        "Every CAS loop needs a backoff or a batching strategy; contention turns retries into a cache-line fight.",
        "Check whether std already has the operation (fetch_max, fetch_min, fetch_update) before writing the loop.",
        "ABA is fixed by reclamation schemes, not by comparing harder."
      ],
      "production": [
        "Hand-rolled lock-free code is isolated behind a small unsafe module with a loom suite and a safety comment.",
        "Retry loops are bounded or backed off, and the bound is chosen from a measurement.",
        "Data structures that need reclamation use crossbeam-epoch rather than ad-hoc retirement lists.",
        "Any unsafe impl Sync documents why the type is safe to share, field by field."
      ],
      "crates": [
        "crossbeam",
        "crossbeam-epoch",
        "crossbeam-utils",
        "loom"
      ],
      "github": [
        {
          "name": "crossbeam - lock-free queues, deques, epoch reclamation",
          "url": "https://github.com/crossbeam-rs/crossbeam"
        },
        {
          "name": "loom - exhaustive interleaving checks for your CAS loops",
          "url": "https://github.com/tokio-rs/loom"
        }
      ],
      "pitfall": "Writing a Treiber stack without reclamation: it passes every test, then crashes in production when the allocator hands a freed node's address to a new push and a stale CAS succeeds against the wrong object.",
      "resources": [
        {
          "title": "crossbeam-epoch: epoch-based reclamation",
          "url": "https://docs.rs/crossbeam/latest/crossbeam/epoch/index.html",
          "kind": "docs"
        },
        {
          "title": "std::sync::atomic::AtomicU64 and compare_exchange",
          "url": "https://doc.rust-lang.org/std/sync/atomic/type.AtomicU64.html",
          "kind": "docs"
        },
        {
          "title": "loom: bounded exhaustive exploration for unsafe code",
          "url": "https://docs.rs/loom/latest/loom/",
          "kind": "docs"
        },
        {
          "title": "Strange Loop: lock-free data structures in practice",
          "url": "https://www.youtube.com/@StrangeLoopConf",
          "kind": "video"
        },
        {
          "title": "crossbeam-utils::Backoff for contention-friendly spin loops",
          "url": "https://docs.rs/crossbeam-utils/latest/crossbeam_utils/struct.Backoff.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "cp08",
      "n": 8,
      "title": "False sharing and cache-line layout",
      "minutes": 60,
      "level": "advanced",
      "goal": "Diagnose a parallel counter that scales negatively, explain coherence traffic in cache-line terms, and fix it with padding without padding everything.",
      "sections": [
        {
          "h": "Coherence works on lines, not variables",
          "p": [
            "Caches transfer 64-byte lines (128 on some recent Apple and ARM cores). When two cores write to different variables that happen to live in the same line, the hardware treats it as one contended object: each write invalidates the other core's copy, and the line ping-pongs through the coherence protocol. No lock is involved, and none of your code is wrong.",
            "The symptom is distinctive: throughput that falls as you add threads, while CPU utilisation rises and the profiler shows no lock. Four threads each incrementing a private counter in a Vec<AtomicU64> can be an order of magnitude slower than one thread doing all four counters' work."
          ],
          "tip": "If adding a thread makes a parallel loop slower, suspect sharing of a cache line before suspecting the scheduler."
        },
        {
          "h": "Fixing it with layout",
          "p": [
            "The fix is to separate the writes: #[repr(align(64))] on a wrapper struct, or crossbeam_utils::CachePadded, which does the same thing portably. Padding costs memory - 64 bytes per counter - so apply it to hot, per-thread state, not to every struct in the crate.",
            "Layout also matters inside a single struct. An Arc<Stats> with three AtomicU64 fields touched by three different threads is one line of contention; splitting it into padded sections, or giving each thread its own Stats and merging at the end, removes the contention entirely. Merging is usually the better design because it also removes the atomic."
          ],
          "code": "use crossbeam_utils::CachePadded;\nuse std::sync::atomic::{AtomicU64, Ordering};\nuse std::thread;\nuse std::time::Instant;\n\nconst THREADS: usize = 4;\nconst ITERS: u64 = 4_000_000;\n\nfn main() {\n    // Packed: all four counters share one or two cache lines.\n    let packed: Vec<AtomicU64> = (0..THREADS).map(|_| AtomicU64::new(0)).collect();\n    let t = Instant::now();\n    thread::scope(|s| {\n        for c in &packed {\n            s.spawn(move || {\n                for _ in 0..ITERS {\n                    c.fetch_add(1, Ordering::Relaxed);\n                }\n            });\n        }\n    });\n    let packed_time = t.elapsed();\n\n    // Padded: one cache line per counter, no coherence ping-pong.\n    let padded: Vec<CachePadded<AtomicU64>> =\n        (0..THREADS).map(|_| CachePadded::new(AtomicU64::new(0))).collect();\n    let t = Instant::now();\n    thread::scope(|s| {\n        for c in &padded {\n            s.spawn(move || {\n                for _ in 0..ITERS {\n                    c.fetch_add(1, Ordering::Relaxed);\n                }\n            });\n        }\n    });\n    let padded_time = t.elapsed();\n\n    println!(\"packed {:?} vs padded {:?}\", packed_time, padded_time);\n    println!(\"ratio {:.1}x\", packed_time.as_secs_f64() / padded_time.as_secs_f64());\n}"
        },
        {
          "h": "Where it hides in real code",
          "p": [
            "The classics: per-thread statistics kept in one struct, head and tail indices of a ring buffer sharing a line, a rayon reduce writing into one accumulator, and a Vec<AtomicBool> of per-shard flags. Each looks clean, each serialises on coherence without a lock, and each is fixed by layout or by per-thread accumulation.",
            "The over-correction is padding everything, which inflates memory and hurts the cache hit rate for data that is read together. Pad the write-heavy, per-thread fields; keep read-only and co-accessed fields adjacent, because locality is the other half of the same trade-off."
          ],
          "list": [
            "Pad per-thread counters and per-worker stats structs",
            "Keep queue head and tail apart when they are written by different threads",
            "Accumulate locally and merge once, instead of one shared atomic",
            "Measure before padding: the ratio tells you whether you found the real problem"
          ]
        }
      ],
      "exercise": {
        "prompt": "A worker pool reports per-worker request counts in a shared struct with four AtomicU64 fields. Four threads each bump only their own field and throughput collapses. Rewrite it two ways - padded shared fields and per-worker local counts merged at the end - and measure both against the original.",
        "starter": "use std::sync::atomic::{AtomicU64, Ordering};\n\npub struct Stats {\n    pub a: AtomicU64,\n    pub b: AtomicU64,\n    pub c: AtomicU64,\n    pub d: AtomicU64,\n}\n\nimpl Stats {\n    pub fn new() -> Self {\n        Self { a: AtomicU64::new(0), b: AtomicU64::new(0),\n               c: AtomicU64::new(0), d: AtomicU64::new(0) }\n    }\n    pub fn bump(&self, worker: usize) {\n        // 1. map worker -> field\n        // 2. fix the layout so the four fields are not in one line\n        todo!()\n    }\n}",
        "hint": "Wrap each field in crossbeam_utils::CachePadded, or collect into a Vec<u64> indexed by worker and sum at the end. Measure with std::time::Instant and enough iterations for a stable ratio.",
        "solution": "use crossbeam_utils::CachePadded;\nuse std::sync::atomic::{AtomicU64, Ordering};\nuse std::thread;\nuse std::time::Instant;\n\nconst ITERS: u64 = 2_000_000;\n\npub struct Packed {\n    pub a: AtomicU64,\n    pub b: AtomicU64,\n    pub c: AtomicU64,\n    pub d: AtomicU64,\n}\n\nimpl Packed {\n    fn bump(&self, worker: usize) {\n        let field = match worker {\n            0 => &self.a,\n            1 => &self.b,\n            2 => &self.c,\n            _ => &self.d,\n        };\n        field.fetch_add(1, Ordering::Relaxed);\n    }\n}\n\npub struct Padded {\n    pub a: CachePadded<AtomicU64>,\n    pub b: CachePadded<AtomicU64>,\n    pub c: CachePadded<AtomicU64>,\n    pub d: CachePadded<AtomicU64>,\n}\n\nimpl Padded {\n    fn bump(&self, worker: usize) {\n        let field = match worker {\n            0 => &self.a,\n            1 => &self.b,\n            2 => &self.c,\n            _ => &self.d,\n        };\n        field.fetch_add(1, Ordering::Relaxed);\n    }\n}\n\nfn main() {\n    let packed = Packed {\n        a: AtomicU64::new(0), b: AtomicU64::new(0),\n        c: AtomicU64::new(0), d: AtomicU64::new(0),\n    };\n    let t = Instant::now();\n    thread::scope(|s| {\n        for w in 0..4 {\n            let stats = &packed; // &Packed is Copy, so the closure can take it\n            s.spawn(move || for _ in 0..ITERS { stats.bump(w) });\n        }\n    });\n    let packed = t.elapsed();\n\n    let padded = Padded {\n        a: CachePadded::new(AtomicU64::new(0)), b: CachePadded::new(AtomicU64::new(0)),\n        c: CachePadded::new(AtomicU64::new(0)), d: CachePadded::new(AtomicU64::new(0)),\n    };\n    let t = Instant::now();\n    thread::scope(|s| {\n        for w in 0..4 {\n            let stats = &padded;\n            s.spawn(move || for _ in 0..ITERS { stats.bump(w) });\n        }\n    });\n    let padded_time = t.elapsed();\n\n    // Third option: no sharing at all.\n    let t = Instant::now();\n    let totals: Vec<u64> = thread::scope(|s| {\n        let handles: Vec<_> = (0..4)\n            .map(|_| s.spawn(|| { let mut n = 0u64; for _ in 0..ITERS { n += 1; } n }))\n            .collect();\n        handles.into_iter().map(|h| h.join().unwrap()).collect()\n    });\n    let local = t.elapsed();\n\n    println!(\"packed  {packed:?}\");\n    println!(\"padded  {padded_time:?}  ({:.1}x faster)\", packed.as_secs_f64() / padded_time.as_secs_f64());\n    println!(\"local   {local:?}  (sum {})\", totals.iter().sum::<u64>());\n}"
      },
      "questions": [
        {
          "q": "Four threads write four different AtomicU64 values stored adjacently in one struct. Why is this slow?",
          "options": [
            "The atomics contend on one lock inside the CPU",
            "The values share a cache line, so each write invalidates the line in other cores",
            "Atomic writes to distinct addresses are always serialized by the memory controller",
            "The struct cannot be Sync, so the compiler inserts fences"
          ],
          "answer": 1,
          "explain": "Coherence is line-granular. Distinct variables in one line produce the same invalidation traffic as one variable, which is exactly what padding avoids - with no lock and no correctness bug involved."
        },
        {
          "q": "When is padding the wrong fix?",
          "options": [
            "When the fields are written by different threads in a hot loop",
            "When the fields are read-only or always accessed together, so extra padding wastes cache",
            "When the struct is behind an Arc",
            "When the counters are u32 instead of u64"
          ],
          "answer": 1,
          "explain": "Padding trades memory density for independence. Read-only or co-accessed fields benefit from sharing a line; padding them inflates the working set and can make the cache miss rate worse."
        }
      ],
      "quickbytes": [
        "Unexplained negative scaling across threads is a cache-line problem until proven otherwise.",
        "CachePadded is one line per value: 64 bytes of cost, so use it on per-thread hot state only.",
        "Prefer per-thread accumulation and a final merge over a shared atomic that everyone touches."
      ],
      "production": [
        "Per-worker statistics are either padded or merged from thread-local values, never packed into one line.",
        "Queue head and tail are separated when producers and consumers write them from different cores.",
        "A scaling benchmark exists per worker pool and fails CI when throughput regresses beyond a threshold.",
        "Padding decisions carry a comment with the measured ratio that justified them."
      ],
      "crates": [
        "crossbeam-utils",
        "rayon",
        "tokio-metrics"
      ],
      "github": [
        {
          "name": "crossbeam - CachePadded and the deque that uses it",
          "url": "https://github.com/crossbeam-rs/crossbeam"
        },
        {
          "name": "rayon - per-thread work queues laid out to avoid sharing",
          "url": "https://github.com/rayon-rs/rayon"
        }
      ],
      "pitfall": "Adding a per-worker field to an existing stats struct and watching a 4-core service lose 40% throughput: the new AtomicU64 landed next to the others, so every worker now invalidates the same line on every request.",
      "resources": [
        {
          "title": "crossbeam_utils::CachePadded",
          "url": "https://docs.rs/crossbeam-utils/latest/crossbeam_utils/struct.CachePadded.html",
          "kind": "docs"
        },
        {
          "title": "crossbeam: data structures and cache-line-aware utilities",
          "url": "https://docs.rs/crossbeam/latest/crossbeam/",
          "kind": "docs"
        },
        {
          "title": "rayon: work-stealing deques and per-thread queues",
          "url": "https://github.com/rayon-rs/rayon",
          "kind": "repo"
        },
        {
          "title": "InfoQ: mechanical sympathy and cache-coherence talks",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        }
      ]
    },
    {
      "id": "cp09",
      "n": 9,
      "title": "Work stealing and data parallelism with rayon",
      "minutes": 75,
      "level": "advanced",
      "goal": "Use a work-stealing deque's locality correctly, parallelise CPU-bound data with rayon, and avoid the two ways teams break it: blocking workers and drowning them in tiny tasks.",
      "sections": [
        {
          "h": "The deque is why stealing works",
          "p": [
            "A work-stealing scheduler gives every worker its own deque. The owner pushes and pops at one end (LIFO, so the hottest data stays in cache), and idle workers steal from the other end (FIFO, so they take the oldest and usually largest chunk). Most operations touch only the owner's end and need no synchronization at all; only a steal contends.",
            "That asymmetry is the whole performance story: under load, workers barely communicate, and when load is uneven, steals move work instead of leaving cores idle. Tokio uses the same family of queue for tasks, rayon for parallel iterators, and both assume tasks are short and self-contained."
          ],
          "tip": "Stealing gets expensive when tasks are tiny: the steal itself costs more than the work. Batch small items into chunks of hundreds before parallelising."
        },
        {
          "h": "rayon in practice",
          "p": [
            "rayon turns an iterator into a parallel one with par_iter and requires the element type to be Sync because chunks are shared by reference. join runs two closures potentially in parallel, and nesting is safe: the runtime steals the other branch rather than deadlocking, which is what makes recursive divide-and-conquer trivial to express.",
            "Use ThreadPoolBuilder to size a pool and install to run a closure inside it. A separate pool is the right isolation boundary when rayon work must not compete with request handling, and it is also how you keep a test deterministic by pinning num_threads(1)."
          ],
          "code": "use rayon::prelude::*;\nuse rayon::ThreadPoolBuilder;\n\nfn main() {\n    let data: Vec<u64> = (1..=2_000_000).collect();\n\n    // A dedicated pool: rayon work cannot starve the rest of the process.\n    let pool = ThreadPoolBuilder::new().num_threads(4).build().unwrap();\n    let doubled: u64 = pool.install(|| data.par_iter().map(|x| x * 2).sum());\n\n    assert_eq!(doubled, data.iter().map(|x| x * 2).sum::<u64>());\n\n    // join is the fork-join primitive; the runtime steals one branch.\n    let (lo, hi) = rayon::join(|| (1..1_000u64).sum::<u64>(), || (1_000..2_000u64).sum());\n    println!(\"sum={doubled} split={}\", lo + hi);\n}"
        },
        {
          "h": "The two ways rayon goes wrong",
          "p": [
            "First, blocking inside a rayon task. The pool has num_threads workers, not thousands; a worker parked on a socket read removes 1/N of the pool, and enough of them deadlock the pool entirely because there are no spare threads for the tasks that would unblock them. rayon is for CPU-bound work, and every blocking call belongs on a different executor.",
            "Second, unbatched parallelism. Calling par_iter over a million elements each costing 20 ns spends more time on splitting and stealing than on work. Chunk the input, or use with_min_len, and measure the crossover: for most machines the useful granularity is tens of microseconds per task, not tens of nanoseconds."
          ],
          "list": [
            "CPU-bound only: no file I/O, no HTTP, no tokio blocking calls inside rayon",
            "Use par_chunks or with_min_len for fine-grained data",
            "Prefer a dedicated pool over the global one in services",
            "Measure parallel speedup against machines with fewer cores, not against a hunch"
          ]
        }
      ],
      "exercise": {
        "prompt": "Parallelise a CPU-heavy image blur over a &mut [u8] using rayon's par_chunks_mut, then show the same work running in a 2-thread pool and explain what the speedup tells you about your task granularity.",
        "starter": "use rayon::prelude::*;\n\nfn blur(src: &[u8], radius: usize) -> Vec<u8> {\n    // 1. process independent chunks of rows in parallel\n    // 2. each chunk writes only its own output rows\n    todo!()\n}\n\nfn main() {\n    let src = vec![7u8; 1920 * 1080 * 3];\n    let out = blur(&src, 2);\n    assert_eq!(out.len(), src.len());\n    println!(\"done\");\n}",
        "hint": "Collect into a Vec<Vec<u8>> per chunk and concatenate, or use par_chunks_mut on the output buffer and read the corresponding input rows. Compare against a sequential run and compute efficiency per thread.",
        "solution": "use rayon::prelude::*;\nuse rayon::ThreadPoolBuilder;\nuse std::time::Instant;\n\nconst W: usize = 1920;\nconst H: usize = 1080;\n\nfn box_blur_row(row: &[u8], radius: usize) -> Vec<u8> {\n    let n = row.len();\n    let mut out = vec![0u8; n];\n    for i in 0..n {\n        let lo = i.saturating_sub(radius);\n        let hi = (i + radius).min(n - 1);\n        let sum: u32 = row[lo..=hi].iter().map(|&v| v as u32).sum();\n        out[i] = (sum / (hi - lo + 1) as u32) as u8;\n    }\n    out\n}\n\nfn blur_parallel(src: &[u8]) -> Vec<u8> {\n    let rows: Vec<&[u8]> = src.chunks(W).take(H).collect();\n    let processed: Vec<Vec<u8>> = rows.par_iter().map(|row| box_blur_row(row, 2)).collect();\n    processed.into_iter().flatten().collect()\n}\n\nfn blur_sequential(src: &[u8]) -> Vec<u8> {\n    src.chunks(W).take(H).flat_map(|row| box_blur_row(row, 2)).collect()\n}\n\nfn main() {\n    let src = vec![7u8; W * H * 3];\n\n    let t = Instant::now();\n    let seq = blur_sequential(&src);\n    let seq_time = t.elapsed();\n\n    let pool = ThreadPoolBuilder::new().num_threads(2).build().unwrap();\n    let t = Instant::now();\n    let par = pool.install(|| blur_parallel(&src));\n    let par_time = t.elapsed();\n\n    assert_eq!(seq, par);\n    println!(\"sequential {seq_time:?}\");\n    println!(\"2 threads  {par_time:?}  speedup {:.2}x\",\n             seq_time.as_secs_f64() / par_time.as_secs_f64());\n}"
      },
      "questions": [
        {
          "q": "Why does the owning worker pop from the opposite end of the deque from the one thieves steal from?",
          "options": [
            "To keep the owner on hot, recently pushed data while thieves take older, larger chunks",
            "Because atomics only work in one direction on the deque",
            "To guarantee FIFO ordering across the whole pool",
            "To prevent the deque from growing beyond its capacity"
          ],
          "answer": 0,
          "explain": "LIFO for the owner maximises cache locality, and FIFO for thieves tends to hand out the oldest subtree, which is usually the biggest remaining unit. Both reduce the number of steals."
        },
        {
          "q": "A rayon pool of 8 threads stalls completely when each task calls reqwest::blocking::get(). Why?",
          "options": [
            "rayon detects blocking calls and panics",
            "All 8 workers park on I/O, so no thread is left to run newly split tasks",
            "The HTTP client opens more sockets than the pool allows",
            "rayon requires tasks to be Send but blocking clients are not"
          ],
          "answer": 1,
          "explain": "The pool has a fixed number of workers. Blocking removes them from the scheduler, so pending tasks - including the ones that would complete the work - have nobody to run on. rayon is a CPU pool; blocking I/O belongs elsewhere."
        },
        {
          "q": "When does parallelising an iterator make a loop slower?",
          "options": [
            "When the collection is smaller than 1000 elements, always",
            "When per-element work is so small that splitting and stealing costs more than the work",
            "When the element type is not Copy",
            "When the closure allocates nothing"
          ],
          "answer": 1,
          "explain": "Parallelism has a fixed per-task overhead - splitting, queueing, joining. Below a few microseconds of work per task, that overhead dominates. Chunking or with_min_len fixes it; the element type is irrelevant."
        }
      ],
      "quickbytes": [
        "rayon is for CPU-bound work on slices and trees; every blocking call belongs on another pool.",
        "Batch small units with par_chunks or with_min_len before reaching for more threads.",
        "Use ThreadPoolBuilder::install for isolation and num_threads(1) for reproducible tests."
      ],
      "production": [
        "Services use dedicated rayon pools with explicit thread counts instead of the global pool.",
        "No blocking I/O is reachable from a rayon task; the boundary is enforced by module structure.",
        "Task granularity is benchmarked, and the crossover point is recorded next to the parallel code.",
        "Rayon pool size never exceeds the CPU quota of the container, or throttling shows up as latency."
      ],
      "crates": [
        "rayon",
        "rayon-core",
        "crossbeam-deque",
        "criterion"
      ],
      "github": [
        {
          "name": "rayon - work-stealing data parallelism",
          "url": "https://github.com/rayon-rs/rayon"
        },
        {
          "name": "crossbeam-deque - the Chase-Lev deque used by schedulers",
          "url": "https://github.com/crossbeam-rs/crossbeam"
        }
      ],
      "pitfall": "Calling par_iter inside a tokio handler that also blocks: the rayon workers finish fast but the async workers are parked, so the process reports low CPU and high latency at the same time.",
      "resources": [
        {
          "title": "rayon: parallel iterators, join, and pool configuration",
          "url": "https://docs.rs/rayon/latest/rayon/",
          "kind": "docs"
        },
        {
          "title": "crossbeam-deque: work-stealing deque API",
          "url": "https://docs.rs/crossbeam/latest/crossbeam/deque/index.html",
          "kind": "docs"
        },
        {
          "title": "Formal verification of the Chase-Lev deque in separation logic",
          "url": "https://arxiv.org/abs/2309.03642",
          "kind": "paper"
        },
        {
          "title": "rayon ThreadPoolBuilder reference",
          "url": "https://docs.rs/rayon/latest/rayon/struct.ThreadPoolBuilder.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "cp10",
      "n": 10,
      "title": "Structured concurrency with JoinSet",
      "minutes": 65,
      "level": "advanced",
      "goal": "Make every spawned task owned by a scope that cannot return before its children, and choose an explicit policy for the first failure instead of leaking tasks.",
      "sections": [
        {
          "h": "Detached tasks are leaks with a scheduler",
          "p": [
            "tokio::spawn returns a JoinHandle. Drop the handle and the task keeps running; the runtime does not know you stopped caring. If the request that started it has already returned a 500, the task is now writing to a database on behalf of a client that is gone, and no shutdown path waits for it.",
            "Structured concurrency is the rule that a concurrent region cannot outlive its parent. The parent waits for all children, observes their errors, and cancels them if it fails first. In Rust that is JoinSet: dropping the set aborts every task in it, and join_next lets the parent drain results as they arrive."
          ],
          "tip": "If a spawn has no await on its handle anywhere in the file, it is not concurrency, it is a background job with no owner - and it needs a different design."
        },
        {
          "h": "Draining, failing fast, and shutting down",
          "p": [
            "JoinSet::join_next returns Option<Result<T, JoinError>>; None means the set is empty. JoinError tells you whether a task panicked or was aborted, which is worth distinguishing in logs - a panic is a bug, an abort is usually your own cancellation. join_all is convenient but panics if any task fails, so handle failures explicitly in services.",
            "Fail-fast is three lines: on the first error, stop calling join_next, then call set.shutdown().await, which aborts the remaining tasks and waits for them to finish shutting down. Without that wait you can return from the handler while aborted tasks are still mid-cleanup, which makes shutdown tests flaky."
          ],
          "code": "use std::time::Duration;\nuse tokio::task::JoinSet;\n\nasync fn fetch(id: u32) -> Result<u32, String> {\n    tokio::time::sleep(Duration::from_millis(10)).await;\n    if id == 7 {\n        return Err(format!(\"upstream rejected id {id}\"));\n    }\n    Ok(id * 2)\n}\n\n#[tokio::main]\nasync fn main() {\n    let mut set = JoinSet::new();\n    for id in 0..16 {\n        set.spawn(fetch(id));\n    }\n\n    let mut ok = Vec::new();\n    let mut failure = None;\n    while let Some(joined) = set.join_next().await {\n        match joined {\n            Ok(Ok(v)) => ok.push(v),\n            Ok(Err(e)) => {\n                failure = Some(e);\n                break; // stop consuming; cancel the rest below\n            }\n            Err(join_err) => {\n                failure = Some(if join_err.is_panic() {\n                    \"worker panicked\".to_string()\n                } else {\n                    \"worker aborted\".to_string()\n                });\n                break;\n            }\n        }\n    }\n\n    if failure.is_some() {\n        // Abort every remaining task and wait for them to actually stop.\n        set.shutdown().await;\n    }\n\n    println!(\"{ok:?} failure={failure:?} in_flight={}\", set.len());\n}"
        },
        {
          "h": "Bounding the fan-out",
          "p": [
            "A JoinSet does not limit concurrency. Spawning one task per row of a million-row export will queue a million futures and their captured state, which is exactly the memory blow-up channels were supposed to prevent. Pair the set with a semaphore, or keep a window of at most N live tasks and join before spawning more.",
            "The windowed pattern is the one that scales: while set.len() >= limit, join_next one result; then spawn the next item. That gives you bounded memory, bounded downstream load, and a natural place to apply per-item timeouts without accumulating a backlog you cannot see."
          ],
          "list": [
            "JoinSet + Semaphore when items are independent and you want a fixed parallelism",
            "Window of join_next when the source itself is a stream",
            "Always shutdown() before returning on the error path",
            "Distinguish panic from abort in the JoinError you log"
          ]
        }
      ],
      "exercise": {
        "prompt": "Fetch 10_000 keys with at most 32 in flight, abort everything on the first error, and return both the successes and the count of keys never attempted. Write it with a JoinSet and no external crate beyond tokio.",
        "starter": "use tokio::task::JoinSet;\n\nasync fn fetch(key: u32) -> Result<String, String> {\n    Ok(format!(\"v{key}\"))\n}\n\npub struct Outcome {\n    pub values: Vec<String>,\n    pub skipped: usize,\n}\n\npub async fn fetch_all(keys: Vec<u32>, limit: usize) -> Outcome {\n    // 1. keep <= limit tasks live\n    // 2. on the first Err, shutdown() and count what was never spawned\n    todo!()\n}",
        "hint": "Iterate the keys with an index. Before each spawn, while set.len() >= limit, join_next to free a slot. On error, shutdown().await and compute skipped = keys.len() - attempted.",
        "solution": "use tokio::task::JoinSet;\n\nasync fn fetch(key: u32) -> Result<String, String> {\n    tokio::time::sleep(std::time::Duration::from_micros(50)).await;\n    if key == 4_242 {\n        return Err(format!(\"poison key {key}\"));\n    }\n    Ok(format!(\"v{key}\"))\n}\n\npub struct Outcome {\n    pub values: Vec<String>,\n    pub skipped: usize,\n}\n\npub async fn fetch_all(keys: Vec<u32>, limit: usize) -> Outcome {\n    let total = keys.len();\n    let mut set: JoinSet<Result<String, String>> = JoinSet::new();\n    let mut values = Vec::with_capacity(total);\n    let mut attempted = 0usize;\n    let mut failure: Option<String> = None;\n\n    for key in keys {\n        if failure.is_some() {\n            break;\n        }\n        // Keep the number of live tasks at or below the limit.\n        while set.len() >= limit {\n            if let Some(joined) = set.join_next().await {\n                match joined {\n                    Ok(Ok(v)) => values.push(v),\n                    Ok(Err(e)) => { failure = Some(e); break; }\n                    Err(e) => { failure = Some(e.to_string()); break; }\n                }\n            } else {\n                break;\n            }\n        }\n        if failure.is_some() {\n            break;\n        }\n        set.spawn(fetch(key));\n        attempted += 1;\n    }\n\n    // Collect until the set drains or something fails.\n    while failure.is_none() {\n        match set.join_next().await {\n            Some(Ok(Ok(v))) => values.push(v),\n            Some(Ok(Err(e))) => failure = Some(e),\n            Some(Err(e)) => failure = Some(e.to_string()),\n            None => break,\n        }\n    }\n\n    if failure.is_some() {\n        // Fail fast: abort every task still in flight and wait for it to stop.\n        set.shutdown().await;\n    }\n\n    Outcome { values, skipped: total - attempted }\n}\n\n#[tokio::main]\nasync fn main() {\n    let keys: Vec<u32> = (0..10_000).collect();\n    let out = fetch_all(keys, 32).await;\n    assert!(out.skipped > 0, \"the poison key must abort the run\");\n    println!(\"ok={} skipped={}\", out.values.len(), out.skipped);\n}"
      },
      "questions": [
        {
          "q": "You drop a JoinSet without calling shutdown(). What happens to its tasks?",
          "options": [
            "They are aborted immediately by the Drop implementation",
            "They continue running until the runtime shuts down",
            "They are converted into detached tasks with no handle",
            "They panic, because joining is mandatory"
          ],
          "answer": 0,
          "explain": "JoinSet's Drop aborts every tracked task, which is the safety net. It does not wait for them, though - that is what shutdown().await adds, and why graceful paths call it explicitly."
        },
        {
          "q": "set.len() is 32 and you spawn a 33rd task. What went wrong?",
          "options": [
            "The set reallocates and the extra task is queued",
            "JoinSet has no limit; 33 tasks are now live and memory grows with each spawn",
            "The spawn panics once the set is full",
            "The oldest task is evicted to make room"
          ],
          "answer": 1,
          "explain": "JoinSet is a collection, not a bounded pool. Bounding is your job: join_next first, or gate with a Semaphore. Otherwise the fan-out is limited only by how fast you can allocate."
        }
      ],
      "quickbytes": [
        "Every spawn needs an owner that awaits it or a set that aborts it; otherwise you have a leak.",
        "Call set.shutdown().await on the error path so aborted tasks finish cleaning up before you return.",
        "Window your fan-out with join_next or a Semaphore; a JoinSet alone is unbounded."
      ],
      "production": [
        "No bare tokio::spawn in request paths; background work goes through a supervised set or a worker queue.",
        "The first-failure policy is documented per fan-out: fail fast, collect errors, or best effort.",
        "Shutdown paths call shutdown() or join all tasks and assert the set is empty.",
        "Task panics are distinguished from aborts in logs and alerts."
      ],
      "crates": [
        "tokio",
        "tokio-util",
        "futures",
        "tracing"
      ],
      "github": [
        {
          "name": "tokio - JoinSet, JoinHandle, and task abort semantics",
          "url": "https://github.com/tokio-rs/tokio"
        },
        {
          "name": "futures - join_all and structured combinators",
          "url": "https://github.com/rust-lang/futures-rs"
        }
      ],
      "pitfall": "Using join_all on a set that can fail: one panic propagates out of the combinator and the remaining tasks are cancelled at an arbitrary point, so partial writes land in your database with no record of which ones.",
      "resources": [
        {
          "title": "tokio::task::JoinSet API reference",
          "url": "https://docs.rs/tokio/latest/tokio/task/struct.JoinSet.html",
          "kind": "docs"
        },
        {
          "title": "Tokio tutorial: spawning and shared state",
          "url": "https://tokio.rs/tokio/tutorial",
          "kind": "docs"
        },
        {
          "title": "Asynchronous Programming in Rust (async book)",
          "url": "https://rust-lang.github.io/async-book/",
          "kind": "docs"
        },
        {
          "title": "InfoQ: structured concurrency and task supervision talks",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        }
      ]
    },
    {
      "id": "cp11",
      "n": 11,
      "title": "Cancellation and timeouts that actually stop work",
      "minutes": 80,
      "level": "industry",
      "goal": "Treat cancellation as a drop at an await point, propagate one token through a task tree, and keep every wait bounded by a deadline that shrinks as it travels.",
      "sections": [
        {
          "h": "Cancellation is a dropped future",
          "p": [
            "Rust has no thread interruption: a future is cancelled when it is dropped, and dropping happens at an await point. Any work between two awaits runs to completion; a long synchronous loop inside an async fn is uncancellable by construction. That single fact explains most \"shutdown hangs\" reports.",
            "Cancellation safety is the per-operation question: if this future is dropped mid-await, is the state consistent? tokio::sync::mpsc::recv is cancel safe - no message is lost. Read operations that consume bytes into a caller buffer are not, which is why select! around read_exact can silently drop a partial frame."
          ],
          "tip": "Audit every await inside a select! arm for cancel safety. The arm that loses the race is dropped, not suspended."
        },
        {
          "h": "One token, a tree of tasks",
          "p": [
            "tokio_util::sync::CancellationToken gives a cloneable handle where cancel() wakes every waiter. child_token() builds a hierarchy: cancelling the parent cancels the children, cancelling a child leaves the parent running. That is the shape of a request scope with its own sub-tasks - cancel the request, keep the process.",
            "drop_guard() converts scope into cleanup: the returned guard cancels the token when dropped, so an early return or a panic still triggers shutdown. Pair cancellation with a deadline: a token says \"stop asking for more\", a timeout says \"stop waiting\", and a drain window says \"finish what you started\"."
          ],
          "code": "use std::time::Duration;\nuse tokio::select;\nuse tokio::time::{sleep, timeout};\nuse tokio_util::sync::CancellationToken;\n\nasync fn worker(id: usize, token: CancellationToken) {\n    loop {\n        select! {\n            // cancelled() is cancel safe and fires even if already cancelled.\n            _ = token.cancelled() => {\n                println!(\"worker {id}: stop requested\");\n                return;\n            }\n            _ = sleep(Duration::from_millis(20)) => {\n                // one unit of work; nothing here is uncancellable\n            }\n        }\n    }\n}\n\n#[tokio::main]\nasync fn main() {\n    let root = CancellationToken::new();\n    let mut handles = Vec::new();\n    for id in 0..4 {\n        handles.push(tokio::spawn(worker(id, root.child_token())));\n    }\n\n    sleep(Duration::from_millis(75)).await;\n    root.cancel();\n\n    // Bound the drain: never wait forever for a worker to notice.\n    for h in handles {\n        let _ = timeout(Duration::from_secs(1), h).await;\n    }\n    println!(\"all workers stopped\");\n}"
        },
        {
          "h": "Deadlines must shrink, not reset",
          "p": [
            "Every hop should receive the remaining budget, not a fresh one. If the gateway has 800 ms and spent 120 ms, the next call gets 680 ms. Resetting the deadline at each layer multiplies the worst case by the number of hops and makes tail latency unbounded in practice.",
            "Also separate \"timed out\" from \"cancelled\" in your error type. A timeout is a downstream failure worth retrying with a smaller budget; a cancellation is a caller decision that must not be retried, or you will resurrect work the user asked you to stop."
          ],
          "list": [
            "Carry remaining budget as a Duration, never as an absolute timestamp",
            "Wrap each downstream await in timeout(remaining)",
            "Map Elapsed to a distinct error variant from Cancelled",
            "Give shutdown a fixed drain window, then abort"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a batch job that processes items in parallel with a shared CancellationToken, stops pulling new items when a SIGINT-equivalent fires, drains in-flight work for at most 2 seconds, and reports how many items were completed versus abandoned.",
        "starter": "use std::time::Duration;\nuse tokio_util::sync::CancellationToken;\n\npub struct Report { pub done: usize, pub abandoned: usize }\n\npub async fn run(items: Vec<u32>, token: CancellationToken) -> Report {\n    // 1. stop taking new items once token is cancelled\n    // 2. wait at most 2s for in-flight work\n    // 3. count what never completed\n    todo!()\n}",
        "hint": "Keep a JoinSet of in-flight items. In the loop, select! on token.cancelled() and join_next. On cancel, break out, then wrap the remaining joins in tokio::time::timeout(2s) and abort whatever is left.",
        "solution": "use std::time::Duration;\nuse tokio::task::JoinSet;\nuse tokio::time::timeout;\nuse tokio_util::sync::CancellationToken;\n\npub struct Report {\n    pub done: usize,\n    pub abandoned: usize,\n}\n\nasync fn process(item: u32) -> u32 {\n    tokio::time::sleep(Duration::from_millis(30)).await;\n    item * 2\n}\n\npub async fn run(items: Vec<u32>, token: CancellationToken) -> Report {\n    let total = items.len();\n    let mut set: JoinSet<u32> = JoinSet::new();\n    let mut iter = items.into_iter();\n    let mut done = 0usize;\n    let mut cancelled = false;\n\n    loop {\n        // Keep at most 8 in flight, and stop pulling as soon as cancellation fires.\n        while !cancelled && set.len() < 8 {\n            match iter.next() {\n                Some(item) => {\n                    set.spawn(process(item));\n                }\n                None => break,\n            }\n        }\n\n        if set.is_empty() {\n            break;\n        }\n\n        tokio::select! {\n            _ = token.cancelled(), if !cancelled => {\n                cancelled = true; // no new work from here on\n            }\n            joined = set.join_next() => {\n                match joined {\n                    Some(Ok(_)) => done += 1,\n                    Some(Err(e)) if e.is_cancelled() => {}\n                    Some(Err(e)) => {\n                        eprintln!(\"worker failed: {e}\");\n                        cancelled = true;\n                        break;\n                    }\n                    None => break,\n                }\n            }\n        }\n    }\n\n    // Drain window: give in-flight work 2 seconds, then abort the rest.\n    if cancelled {\n        let _ = timeout(Duration::from_secs(2), async {\n            while let Some(joined) = set.join_next().await {\n                if joined.is_ok() {\n                    done += 1;\n                }\n            }\n        })\n        .await;\n        set.shutdown().await;\n    }\n\n    Report { done, abandoned: total - done }\n}\n\n#[tokio::main]\nasync fn main() {\n    let token = CancellationToken::new();\n    let t = token.clone();\n    tokio::spawn(async move {\n        tokio::time::sleep(Duration::from_millis(45)).await;\n        t.cancel();\n    });\n    let report = run((0..100).collect(), token).await;\n    println!(\"done={} abandoned={}\", report.done, report.abandoned);\n    assert!(report.abandoned > 0);\n}"
      },
      "questions": [
        {
          "q": "An async task runs a 30-second CPU loop with no awaits. You cancel its token. What happens?",
          "options": [
            "The loop stops at the next statement boundary",
            "Nothing, because the future is only dropped at an await point",
            "The runtime aborts the worker thread",
            "The token cancels the task but the task keeps the core busy anyway"
          ],
          "answer": 1,
          "explain": "Cancellation is a drop, and drops happen when the task yields. With no await inside the loop there is no cancellation point, so the work runs to completion - use spawn_blocking plus cooperative checks for that kind of work."
        },
        {
          "q": "Why does using child_token() beat cloning the root token for per-request sub-tasks?",
          "options": [
            "Children can be cancelled without cancelling the parent, while a parent cancel still propagates down",
            "Clones are not Send, so they cannot cross task boundaries",
            "Child tokens avoid the atomic cost of cloning",
            "Cloning the root token leaks memory until the process exits"
          ],
          "answer": 0,
          "explain": "A clone is a peer: cancelling one cancels all. A child inherits cancellation from the parent but can be cancelled alone, which is exactly the request-scoped subtree you want."
        },
        {
          "q": "A request has 800 ms total budget and 120 ms is spent before the downstream call. What timeout should that call get?",
          "options": [
            "800 ms, so the downstream has a fair chance",
            "680 ms, the remaining budget",
            "120 ms, matching what was already spent",
            "No timeout; the outer deadline will handle it"
          ],
          "answer": 1,
          "explain": "Deadlines must shrink. Granting a fresh 800 ms makes the worst case grow with every hop, so a single slow dependency can blow the caller's SLO even though every individual timeout looked reasonable."
        }
      ],
      "quickbytes": [
        "Only await points are cancellation points; put one inside any long-running async loop.",
        "Cancel safe operations are safe inside select!; for others use a dedicated task and a channel.",
        "Propagate remaining budget as a Duration and map timeout separately from cancellation."
      ],
      "production": [
        "One cancellation token per request scope, children for sub-tasks, and a drop guard where early return is possible.",
        "Shutdown has a bounded drain window and a metric for work abandoned at the deadline.",
        "Timeout errors are distinguishable from cancellation errors in the API and in retry policy.",
        "Long synchronous sections inside async functions are found by review and moved to spawn_blocking."
      ],
      "crates": [
        "tokio-util",
        "tokio",
        "tracing",
        "thiserror"
      ],
      "github": [
        {
          "name": "tokio - cancellation, select!, and drop semantics",
          "url": "https://github.com/tokio-rs/tokio"
        },
        {
          "name": "tokio-util - CancellationToken implementation",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "pitfall": "Cancelling a task that was mid-write: the future is dropped between two awaits, the file handle closes at an arbitrary byte offset, and the next run reads a truncated record with no error flagged anywhere.",
      "resources": [
        {
          "title": "tokio_util::sync::CancellationToken reference",
          "url": "https://docs.rs/tokio-util/latest/tokio_util/sync/struct.CancellationToken.html",
          "kind": "docs"
        },
        {
          "title": "tokio::time::timeout and Elapsed",
          "url": "https://docs.rs/tokio/latest/tokio/time/fn.timeout.html",
          "kind": "docs"
        },
        {
          "title": "Asynchronous Programming in Rust: select and cancellation",
          "url": "https://rust-lang.github.io/async-book/",
          "kind": "docs"
        },
        {
          "title": "Strange Loop: shutdown, cancellation, and graceful drain talks",
          "url": "https://www.youtube.com/@StrangeLoopConf",
          "kind": "video"
        }
      ]
    },
    {
      "id": "cp12",
      "n": 12,
      "title": "Backpressure and bounded queues",
      "minutes": 75,
      "level": "industry",
      "goal": "Size a bounded queue from Little's law, decide where to apply backpressure in the pipeline, and make load shedding an explicit, measured policy rather than an accident.",
      "sections": [
        {
          "h": "A queue is a latency buffer you pay for twice",
          "p": [
            "Every queue between a producer and a consumer is a buffer that absorbs bursts and converts them into latency. Little's law ties the three numbers together: items in the system equals arrival rate times time in the system. At 200 requests per second and 500 ms each, 100 requests are in flight; a queue of 100 in front of a consumer that handles 150/s means the tail waits seconds.",
            "An unbounded queue hides the imbalance by borrowing memory. It works until the producer's rate is sustained, at which point the backlog grows without bound, latency approaches infinity, and the process dies of allocation rather than of load. Bounded is not a performance tweak; it is the only mechanism that makes saturation visible."
          ],
          "tip": "Set the bound from a latency budget, not from a round number: capacity ≈ (allowed wait) × (drain rate). Write the arithmetic in the comment."
        },
        {
          "h": "Three ways to apply it",
          "p": [
            "Block the producer: send().await on a full tokio channel, or a blocking send on a sync channel. The producer's own throughput drops to the consumer's, and the pressure propagates back to whatever is upstream - ideally to the client via a slower response, which is honest.",
            "Shed the load: try_send, and on TrySendError::Full either reject with 429/503 or drop the oldest item. Shedding keeps latency flat at the cost of completing less work, and it must be counted - an uncounted drop is indistinguishable from a bug. Limit concurrency with a Semaphore when the resource is downstream connections rather than a queue."
          ],
          "list": [
            "Ingress: bound the accept queue and reject early, before allocating per-request state",
            "Internal stages: bounded channels sized to the slowest stage's drain rate",
            "Downstream calls: a Semaphore sized to the connection pool, not to the request rate",
            "Every shed increments a counter tagged with the reason"
          ]
        },
        {
          "h": "Backpressure across a timeout",
          "p": [
            "Backpressure and timeouts interact badly if you are careless. A producer blocked on a full queue with a 5-second deadline will time out while still queued, then retry, adding load to a system that was already saturated. The fix is to check the deadline before enqueueing and to expire queued items rather than executing them after their deadline has passed.",
            "The second interaction is retries: at saturation, retries are a load amplifier. Budget them per caller, use jitter, and never retry a request that was rejected for backpressure - that rejection is the system telling you to slow down, and retrying it is arguing with a queue that is already full."
          ],
          "code": "use std::time::Duration;\nuse tokio::sync::mpsc;\nuse tokio::time::timeout;\n\n#[derive(Debug)]\npub enum Rejected {\n    QueueFull,\n    Closed,\n    TimedOut,\n}\n\npub struct Pipeline {\n    tx: mpsc::Sender<u32>,\n}\n\nimpl Pipeline {\n    pub fn new(capacity: usize) -> (Self, mpsc::Receiver<u32>) {\n        let (tx, rx) = mpsc::channel(capacity);\n        (Self { tx }, rx)\n    }\n\n    /// Non-blocking submission: shed immediately instead of growing a backlog.\n    pub fn submit(&self, job: u32) -> Result<(), Rejected> {\n        self.tx.try_send(job).map_err(|e| match e {\n            mpsc::error::TrySendError::Full(_) => Rejected::QueueFull,\n            mpsc::error::TrySendError::Closed(_) => Rejected::Closed,\n        })\n    }\n\n    /// Blocking submission with a deadline: wait for capacity, but not forever.\n    pub async fn submit_wait(&self, job: u32, budget: Duration) -> Result<(), Rejected> {\n        timeout(budget, self.tx.send(job))\n            .await\n            .map_err(|_| Rejected::TimedOut)?\n            .map_err(|_| Rejected::Closed)\n    }\n}"
        }
      ],
      "exercise": {
        "prompt": "A log shipper reads 50k events/s at peak but the disk writer sustains 20k/s. Add a bounded queue of 10k, a shedding policy with a metric, and a slow-path test proving the producer slows down instead of the process growing.",
        "starter": "use tokio::sync::mpsc;\n\npub struct Shipper {\n    tx: mpsc::Sender<Vec<u8>>,\n    shed: std::sync::atomic::AtomicU64,\n}\n\nimpl Shipper {\n    pub fn new(capacity: usize) -> (Self, mpsc::Receiver<Vec<u8>>) {\n        // 1. bounded channel\n        // 2. try_send with a policy\n        todo!()\n    }\n\n    pub fn offer(&self, event: Vec<u8>) -> bool {\n        // true = accepted, false = shed\n        todo!()\n    }\n}",
        "hint": "try_send returns TrySendError::Full; increment a relaxed counter and return false. For a lossless mode, use send().await instead and compare, but note that blocking the producer is only acceptable if it can absorb the delay.",
        "solution": "use std::sync::atomic::{AtomicU64, Ordering};\nuse tokio::sync::mpsc;\n\npub struct Shipper {\n    tx: mpsc::Sender<Vec<u8>>,\n    shed: AtomicU64,\n}\n\nimpl Shipper {\n    pub fn new(capacity: usize) -> (Self, mpsc::Receiver<Vec<u8>>) {\n        let (tx, rx) = mpsc::channel(capacity);\n        (Self { tx, shed: AtomicU64::new(0) }, rx)\n    }\n\n    /// Bounded, non-blocking offer. Returns false when the event was shed.\n    pub fn offer(&self, event: Vec<u8>) -> bool {\n        match self.tx.try_send(event) {\n            Ok(()) => true,\n            Err(mpsc::error::TrySendError::Full(_)) => {\n                // The counter is the alerting signal: a silent drop is a bug.\n                self.shed.fetch_add(1, Ordering::Relaxed);\n                false\n            }\n            Err(mpsc::error::TrySendError::Closed(_)) => {\n                self.shed.fetch_add(1, Ordering::Relaxed);\n                false\n            }\n        }\n    }\n\n    pub fn shed_total(&self) -> u64 {\n        self.shed.load(Ordering::Relaxed)\n    }\n}\n\n#[tokio::main]\nasync fn main() {\n    let (shipper, mut rx) = Shipper::new(16);\n\n    // Slow consumer: 1ms per event, so the queue fills quickly.\n    let consumer = tokio::spawn(async move {\n        let mut n = 0usize;\n        while rx.recv().await.is_some() {\n            tokio::time::sleep(std::time::Duration::from_millis(1)).await;\n            n += 1;\n        }\n        n\n    });\n\n    let mut accepted = 0usize;\n    for i in 0..1_000u32 {\n        if shipper.offer(vec![i as u8; 64]) {\n            accepted += 1;\n        }\n    }\n\n    println!(\"accepted={accepted} shed={}\", shipper.shed_total());\n    assert!(shipper.shed_total() > 0, \"a slow consumer must cause shedding\");\n    drop(shipper);\n    let consumed = consumer.await.unwrap();\n    assert_eq!(consumed, accepted);\n}"
      },
      "questions": [
        {
          "q": "A service holds 200 rps with 400 ms average latency. How many requests are typically in flight?",
          "options": [
            "80, from Little's law (200 x 0.4)",
            "20, from 200 / 10",
            "500, from the 500 ms timeout budget",
            "It cannot be computed without the queue depth"
          ],
          "answer": 0,
          "explain": "L = λW: 200 requests per second times 0.4 seconds in the system is 80 concurrent requests. That number sizes connection pools and worker counts far more reliably than a guess."
        },
        {
          "q": "Which reaction to TrySendError::Full is correct when the queue exists to protect a database?",
          "options": [
            "Retry the send in a tight loop until it succeeds",
            "Reject or shed now, increment a counter, and let the client see a fast failure",
            "Increase the queue capacity so the error stops happening",
            "Block the async worker with a synchronous sleep and retry"
          ],
          "answer": 1,
          "explain": "The full queue is the database saying it is saturated. Shedding with a counted, observable rejection keeps latency bounded; retrying or growing the queue moves the failure into memory and p99 latency instead."
        },
        {
          "q": "Why is retrying a request that was rejected for backpressure usually wrong?",
          "options": [
            "The request was mutated and cannot be replayed",
            "It adds load to an already saturated system and multiplies with other clients' retries",
            "Backpressure rejections are always permanent errors",
            "Retries are fine as long as they use exponential backoff"
          ],
          "answer": 1,
          "explain": "A backpressure rejection is a signal to slow down. Retrying it at the client multiplies offered load exactly when capacity is the constraint, which turns a smooth degradation into a collapse."
        }
      ],
      "quickbytes": [
        "Size queue capacity from a latency budget and drain rate; write the arithmetic down.",
        "Count every shed with a reason tag; an uncounted drop is a silent data-loss bug.",
        "Never retry a backpressure rejection - that is the system asking for less load."
      ],
      "production": [
        "All queues are bounded, with the bound derived from a measured drain rate.",
        "Queue depth and shed count are exported as metrics and alerted on before they saturate.",
        "Ingress sheds before allocating per-request state, not after.",
        "Concurrency limits are sized to the downstream pool, and retries carry jitter and a budget."
      ],
      "crates": [
        "tokio",
        "crossbeam",
        "tower",
        "metrics"
      ],
      "github": [
        {
          "name": "tokio - bounded mpsc, Semaphore, and try_send",
          "url": "https://github.com/tokio-rs/tokio"
        },
        {
          "name": "tower - load shedding and concurrency limiting middleware",
          "url": "https://github.com/tower-rs/tower"
        }
      ],
      "pitfall": "Putting an unbounded channel between ingest and a database writer: latency looks fine until the writer falls behind, then memory grows at exactly the arrival rate while p99 climbs to minutes - and the queue depth you did not export is the only metric that would have predicted it.",
      "resources": [
        {
          "title": "tokio::sync::mpsc: bounded channel and try_send semantics",
          "url": "https://docs.rs/tokio/latest/tokio/sync/mpsc/fn.channel.html",
          "kind": "docs"
        },
        {
          "title": "tokio::sync::Semaphore: limiting concurrency",
          "url": "https://docs.rs/tokio/latest/tokio/sync/struct.Semaphore.html",
          "kind": "docs"
        },
        {
          "title": "crossbeam bounded MPMC channels for thread pipelines",
          "url": "https://docs.rs/crossbeam/latest/crossbeam/channel/index.html",
          "kind": "docs"
        },
        {
          "title": "InfoQ: capacity planning and load shedding in production",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        }
      ]
    },
    {
      "id": "cp13",
      "n": 13,
      "title": "Deadlock and livelock",
      "minutes": 65,
      "level": "industry",
      "goal": "Break one of the four Coffman conditions by design, detect the deadlocks you failed to prevent, and tell a livelock apart from a hang.",
      "sections": [
        {
          "h": "Four conditions, one of which you must break",
          "p": [
            "Deadlock needs mutual exclusion, hold-and-wait, no preemption, and a circular wait - all four at once. Rust gives you the first two by default whenever you take two locks, and RAII gives you release-on-drop but not preemption. That leaves circular wait as the condition you can remove cheaply: define a total order over locks and always acquire in that order.",
            "The second lever is hold-and-wait: never acquire a second lock while holding the first. Either take one lock that covers the whole invariant, or take and release them independently. try_lock is the third: it converts a potential deadlock into a retry or an error, at the cost of handling backoff correctly."
          ],
          "tip": "Number your locks. A comment like \"acquires sessions before billing\" is documentation; an id ordering checked in debug builds is enforcement."
        },
        {
          "h": "Detection when prevention fails",
          "p": [
            "parking_lot's deadlock_detection feature runs a cycle check over its parking queues. check_deadlock returns the threads that are in a cycle, with thread ids and backtraces. Two caveats matter operationally: waits with a deadline are not reported because they can time out, and reporting is destructive - detected threads are removed from their queues and stay blocked forever, so this is a diagnostic tool, not a recovery mechanism.",
            "For async code the usual detector does not apply, because tasks waiting on a future are not parked in a lock queue. The practical instrument there is a per-task span with a start timestamp plus a watchdog on tasks that exceed their deadline - which catches mutual oneshot waits, a wedged actor, and a starved runtime alike."
          ],
          "code": "// Cargo.toml: parking_lot = { version = \"0.13\", features = [\"deadlock_detection\"] }\nuse parking_lot::{deadlock, Mutex};\nuse std::sync::Arc;\nuse std::thread;\nuse std::time::Duration;\n\nfn main() {\n    let a = Arc::new(Mutex::new(0u8));\n    let b = Arc::new(Mutex::new(0u8));\n\n    // Deliberate inversion: one thread takes a then b, the other b then a.\n    let (a1, b1) = (a.clone(), b.clone());\n    thread::spawn(move || {\n        let _ga = a1.lock();\n        thread::sleep(Duration::from_millis(50));\n        let _gb = b1.lock();\n    });\n    let (a2, b2) = (a.clone(), b.clone());\n    thread::spawn(move || {\n        let _gb = b2.lock();\n        thread::sleep(Duration::from_millis(50));\n        let _ga = a2.lock();\n    });\n\n    thread::sleep(Duration::from_millis(200));\n\n    let cycles = deadlock::check_deadlock();\n    if cycles.is_empty() {\n        println!(\"no cycle detected\");\n        return;\n    }\n    for (i, threads) in cycles.iter().enumerate() {\n        eprintln!(\"cycle {i}\");\n        for t in threads {\n            // Detection is destructive: these threads stay blocked after this.\n            eprintln!(\"  thread {:?}\\n{:#?}\", t.thread_id(), t.backtrace());\n        }\n    }\n    std::process::exit(1);\n}"
        },
        {
          "h": "Livelock looks busy",
          "p": [
            "Livelock is work without progress: two threads detect a conflict, back off identically, and collide again forever. CPU is pegged, no thread is blocked, and throughput is zero. Identical retry timings are the usual cause, which is why jitter is not decoration - it is the mechanism that desynchronises retries.",
            "In async code the same shape appears as a retry storm: a downstream returns a retryable error, every caller retries immediately, the downstream stays saturated, and the errors never clear. Exponential backoff with full jitter, a per-caller retry budget, and a circuit breaker are the standard trio because each addresses a different part of the loop."
          ],
          "list": [
            "Backoff: exponential, with a cap",
            "Jitter: full jitter, not a fixed random offset",
            "Budget: cap retries per request and per client",
            "Breaker: stop sending when the error rate crosses a threshold"
          ]
        }
      ],
      "exercise": {
        "prompt": "A transfer function locks two account records to move money between them, and two concurrent transfers in opposite directions deadlock under load. Fix it with a lock ordering derived from the account id, and prove with a stress test that 10k concurrent transfers complete.",
        "starter": "use std::sync::{Arc, Mutex};\n\npub struct Account { pub id: u64, pub balance: i64 }\npub type Ledger = Arc<Vec<Mutex<Account>>>;\n\npub fn transfer(ledger: &Ledger, from: u64, to: u64, amount: i64) -> Result<(), String> {\n    // 1. always lock the lower id first\n    // 2. re-check balances after acquiring both\n    todo!()\n}",
        "hint": "Compute (lo, hi) from the ids, lock in that order regardless of direction, then apply the debit and credit. Both guards are needed at once only for the two balances, so keep the critical section to a few instructions.",
        "solution": "use std::sync::{Arc, Mutex};\nuse std::thread;\n\npub struct Account { pub id: u64, pub balance: i64 }\npub type Ledger = Arc<Vec<Mutex<Account>>>;\n\npub fn ledger(n: usize, balance: i64) -> Ledger {\n    Arc::new((0..n).map(|i| Mutex::new(Account { id: i as u64, balance })).collect())\n}\n\npub fn transfer(ledger: &Ledger, from: u64, to: u64, amount: i64) -> Result<(), String> {\n    if from == to {\n        return Ok(());\n    }\n    let (lo, hi) = if from < to { (from, to) } else { (to, from) };\n\n    // Total order on account id == no circular wait, regardless of direction.\n    let mut first = ledger[lo as usize].lock().map_err(|e| e.to_string())?;\n    let mut second = ledger[hi as usize].lock().map_err(|e| e.to_string())?;\n\n    let (src, dst) = if from == lo {\n        (&mut *first, &mut *second)\n    } else {\n        (&mut *second, &mut *first)\n    };\n\n    if src.balance < amount {\n        return Err(format!(\"insufficient funds in {}\", src.id));\n    }\n    src.balance -= amount;\n    dst.balance += amount;\n    Ok(())\n}\n\nfn main() {\n    let n = 64usize;\n    let book = ledger(n, 1_000);\n\n    thread::scope(|s| {\n        for t in 0..8u64 {\n            let book = Arc::clone(&book);\n            s.spawn(move || {\n                for i in 0..1_250u64 {\n                    let from = (t * 7 + i) % n as u64;\n                    let to = (from + 1 + i % 5) % n as u64;\n                    let _ = transfer(&book, from, to, 1);\n                }\n            });\n        }\n    });\n\n    let total: i64 = book.iter().map(|m| m.lock().unwrap().balance).sum();\n    assert_eq!(total, 1_000 * n as i64, \"money must be conserved\");\n    println!(\"ok, total {total}\");\n}"
      },
      "questions": [
        {
          "q": "Which Coffman condition does assigning every lock a numeric id and acquiring in ascending order remove?",
          "options": [
            "Mutual exclusion, because ids make locks shareable",
            "Circular wait, because a cycle cannot form in a total order",
            "No preemption, because ids allow stealing",
            "Hold-and-wait, because the second lock is never held"
          ],
          "answer": 1,
          "explain": "A total order makes a cycle impossible: some thread in the cycle would have to acquire a lower id after a higher one. The other three conditions are untouched, which is why the rule works."
        },
        {
          "q": "What is the operational catch of parking_lot's deadlock detector?",
          "options": [
            "It only works in release builds",
            "Reported threads are removed from their queues and remain blocked permanently",
            "It panics the process as soon as a cycle is found",
            "It detects cycles but cannot report thread ids"
          ],
          "answer": 1,
          "explain": "Detection is destructive by design: the detector pulls threads out of parking queues to capture backtraces, so those threads never resume. It is a post-mortem diagnostic, not a recovery path."
        },
        {
          "q": "Two workers retry a failed RPC in lockstep and the service stays saturated with zero throughput. What is missing?",
          "options": [
            "A larger thread pool",
            "Jittered backoff that desynchronises the retries",
            "A shorter timeout on the RPC",
            "More retries per request to get past the bad window"
          ],
          "answer": 1,
          "explain": "Identical retry schedules re-collide forever. Randomised backoff breaks the symmetry so some callers succeed and the load drops; more retries or threads make the livelock worse."
        }
      ],
      "quickbytes": [
        "Order your locks and assert the order in debug builds; comments do not fail CI.",
        "try_lock turns a deadlock into a retry loop - only use it if the retry has backoff and a bound.",
        "Livelock pegs the CPU with no progress; jitter is the fix, not more threads."
      ],
      "production": [
        "Locks are numbered and the ordering rule is written where the locks are defined.",
        "Deadlock detection is available behind a feature flag and documented as destructive.",
        "Async tasks that wait on each other carry a watchdog and a deadline, not just a log line.",
        "Retry policy includes jitter, a budget, and a breaker, and the three are configured together."
      ],
      "crates": [
        "parking_lot",
        "tokio",
        "backoff",
        "tracing"
      ],
      "github": [
        {
          "name": "parking_lot - deadlock detection behind a feature flag",
          "url": "https://github.com/Amanieu/parking_lot"
        },
        {
          "name": "tokio - timeouts and task supervision for async deadlock watchdogs",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "pitfall": "Taking two locks in an order that depends on request parameters: it works for months because most traffic hits one direction, then a bulk import reverses the order and the whole worker pool stops in a cycle.",
      "resources": [
        {
          "title": "parking_lot::deadlock - detection semantics and caveats",
          "url": "https://docs.rs/parking_lot/latest/parking_lot/deadlock/index.html",
          "kind": "docs"
        },
        {
          "title": "parking_lot Mutex and RwLock reference",
          "url": "https://docs.rs/parking_lot/latest/parking_lot/",
          "kind": "docs"
        },
        {
          "title": "std::sync::Mutex poisoning and drop semantics",
          "url": "https://doc.rust-lang.org/std/sync/struct.Mutex.html",
          "kind": "docs"
        },
        {
          "title": "InfoQ: production incident analyses of deadlocks and retry storms",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        }
      ]
    },
    {
      "id": "cp14",
      "n": 14,
      "title": "Starvation and fairness",
      "minutes": 60,
      "level": "industry",
      "goal": "Recognise when unfair is the right default, choose fair primitives for latency-sensitive paths, and separate lock fairness from scheduler fairness.",
      "sections": [
        {
          "h": "Fairness is a handoff policy",
          "p": [
            "An unfair mutex lets an arriving thread barge ahead of parked waiters, which maximises throughput because it avoids a context switch, but a waiter can be skipped indefinitely under sustained contention. A fair mutex hands the lock to the next waiter in FIFO order, which bounds waiting time and costs throughput on every handoff.",
            "std::sync::Mutex does not specify a policy, so behaviour varies by platform and version. parking_lot::Mutex is unfair by default and ships FairMutex when you need FIFO. tokio::sync::Mutex queues waiters in arrival order, so it is fair - one more reason it is slower per operation than a std lock."
          ],
          "tip": "Pick fair when a request's tail latency matters and the critical section is short. Pick unfair when the critical section is microseconds and throughput is the metric."
        },
        {
          "h": "Readers, writers, and the starvation nobody notices",
          "p": [
            "A read-preferring RwLock lets a continuous stream of readers keep a writer waiting forever. Write-preferring and task-fair policies fix the writer but let a single long reader block everyone. There is no free policy; the choice depends on whether you care more about read throughput or write latency.",
            "The practical symptom is a writer that is \"slow\" only under load, while CPU is high on the read path. If writers matter, measure the write lock's wait time as its own metric - an average across the lock hides the starved tail completely."
          ],
          "code": "use std::sync::atomic::{AtomicUsize, Ordering};\n\n/// FIFO ticket lock: every waiter is served in arrival order.\n/// Fair by construction, at the cost of a handoff store per acquisition.\npub struct TicketLock {\n    next: AtomicUsize,\n    serving: AtomicUsize,\n}\n\nimpl TicketLock {\n    pub const fn new() -> Self {\n        Self { next: AtomicUsize::new(0), serving: AtomicUsize::new(0) }\n    }\n\n    pub fn lock(&self) -> Ticket<'_> {\n        // Fetch the ticket first: arrival order is fixed here, not in the spin.\n        let ticket = self.next.fetch_add(1, Ordering::Relaxed);\n        while self.serving.load(Ordering::Acquire) != ticket {\n            std::hint::spin_loop();\n        }\n        Ticket { lock: self }\n    }\n}\n\npub struct Ticket<'a> { lock: &'a TicketLock }\n\nimpl Drop for Ticket<'_> {\n    fn drop(&mut self) {\n        // Release publishes the critical section to the next ticket holder.\n        self.lock.serving.fetch_add(1, Ordering::Release);\n    }\n}"
        },
        {
          "h": "Scheduler fairness is a different question",
          "p": [
            "tokio's scheduler is work-conserving, not fair per task. A task that never yields runs until it blocks, and the cooperative budget only forces a yield after a fixed number of I/O operations in one poll - pure CPU work inside an async task is not budgeted. One hot loop can therefore starve every other task on that worker.",
            "The remedy is not a fairer scheduler but a shorter task: chunk CPU work, await between chunks, or move it to spawn_blocking or rayon. tokio::task::yield_now exists for the case where you must remain on the runtime; use it between units of work, not inside one."
          ],
          "list": [
            "Bound work per task iteration, then yield",
            "Never put unbounded CPU loops in an async fn",
            "Measure per-task poll time, not only request latency",
            "Prefer fair locks only where the tail matters"
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement the ticket lock, run four threads that each increment a counter 200k times, and compare its wall time with std::sync::Mutex. Then explain which one you would ship for a 2-microsecond critical section and why.",
        "starter": "use std::sync::atomic::{AtomicUsize, Ordering};\n\npub struct TicketLock { next: AtomicUsize, serving: AtomicUsize }\n\nimpl TicketLock {\n    pub const fn new() -> Self { /* ... */ }\n    pub fn lock(&self) { /* ticket + spin */ }\n    pub fn unlock(&self) { /* advance serving */ }\n}",
        "hint": "fetch_add returns the previous value - that is your ticket. Compare serving with Acquire, advance with Release. Expect the ticket lock to lose on throughput to std's futex-based mutex when the critical section is tiny, but to bound waiting time.",
        "solution": "use std::sync::atomic::{AtomicUsize, Ordering};\nuse std::sync::Mutex;\nuse std::thread;\nuse std::time::Instant;\n\npub struct TicketLock {\n    next: AtomicUsize,\n    serving: AtomicUsize,\n}\n\nimpl TicketLock {\n    pub const fn new() -> Self {\n        Self { next: AtomicUsize::new(0), serving: AtomicUsize::new(0) }\n    }\n\n    pub fn lock(&self) -> Ticket<'_> {\n        let ticket = self.next.fetch_add(1, Ordering::Relaxed);\n        while self.serving.load(Ordering::Acquire) != ticket {\n            std::hint::spin_loop();\n        }\n        Ticket { lock: self }\n    }\n}\n\npub struct Ticket<'a> { lock: &'a TicketLock }\n\nimpl Drop for Ticket<'_> {\n    fn drop(&mut self) {\n        self.lock.serving.fetch_add(1, Ordering::Release);\n    }\n}\n\nconst THREADS: usize = 4;\nconst ITERS: usize = 200_000;\n\nfn main() {\n    let ticket = TicketLock::new();\n    let t = Instant::now();\n    thread::scope(|s| {\n        for _ in 0..THREADS {\n            s.spawn(|| {\n                for _ in 0..ITERS {\n                    let _g = ticket.lock();\n                }\n            });\n        }\n    });\n    let fair = t.elapsed();\n\n    let std_mutex = Mutex::new(());\n    let t = Instant::now();\n    thread::scope(|s| {\n        for _ in 0..THREADS {\n            s.spawn(|| {\n                for _ in 0..ITERS {\n                    let _g = std_mutex.lock().unwrap();\n                }\n            });\n        }\n    });\n    let unfair = t.elapsed();\n\n    println!(\"ticket (fair) {fair:?}\");\n    println!(\"std mutex     {unfair:?}\");\n    println!(\"ratio {:.2}x\", fair.as_secs_f64() / unfair.as_secs_f64());\n}"
      },
      "questions": [
        {
          "q": "Why is a fair mutex usually slower than an unfair one in a short critical section?",
          "options": [
            "Fairness requires an extra atomic RMW inside the critical section",
            "It must hand the lock to a specific waiter, forcing a wake-up and context switch instead of letting a running thread barge in",
            "Fair mutexes disable CPU caches",
            "It checks the waiter queue on every instruction in the critical section"
          ],
          "answer": 1,
          "explain": "Barging keeps the lock on a thread that is already running; fair handoff wakes a parked thread and pays a scheduling round trip. That is a throughput cost paid to bound waiting time."
        },
        {
          "q": "A read-heavy service shows a writer that is fast in tests and slow under production load. What is the likely mechanism?",
          "options": [
            "The writer is starved by a continuous stream of readers on a read-preferring RwLock",
            "Writers always run on fewer cores",
            "The writer's mutex poison flag is set",
            "Read locks are upgraded to write locks automatically"
          ],
          "answer": 0,
          "explain": "If readers can always acquire a shared lock, a writer waits for a gap that never comes. The fix is a write-preferring or task-fair policy, plus a metric on write-lock wait time to make the starvation visible."
        },
        {
          "q": "One async task runs a 500 ms CPU loop without awaiting. What happens to other tasks on that worker?",
          "options": [
            "They are migrated to another worker automatically",
            "They wait, because the runtime cannot preempt a running poll",
            "They run with reduced priority",
            "The cooperative budget aborts the loop"
          ],
          "answer": 1,
          "explain": "The cooperative budget applies to I/O operations within a poll, not to arbitrary CPU work. Until the task returns from poll, the worker cannot run anything else, so the loop must be chunked or moved off the runtime."
        }
      ],
      "quickbytes": [
        "Fair means FIFO handoff: bounded waiting, lower throughput. Choose per critical section, not per codebase.",
        "Watch write-lock wait time separately; average lock latency hides writer starvation.",
        "tokio does not preempt a busy task; chunk CPU work and yield, or move it to a blocking pool."
      ],
      "production": [
        "Latency-sensitive paths use fair primitives where a starved waiter would break an SLO.",
        "RwLock wait times are instrumented per role (reader versus writer).",
        "No unbounded CPU loop runs inside an async task; per-iteration work is bounded and yields.",
        "Lock policy choices are documented with the throughput/latency trade-off that motivated them."
      ],
      "crates": [
        "parking_lot",
        "tokio",
        "crossbeam-utils",
        "hdrhistogram"
      ],
      "github": [
        {
          "name": "parking_lot - FairMutex and fair RwLock variants",
          "url": "https://github.com/Amanieu/parking_lot"
        },
        {
          "name": "tokio - cooperative scheduling and task budgets",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "pitfall": "Instrumenting only average lock wait: a writer starved for 30 seconds in every 60-second window barely moves the mean, so dashboards stay green while a batch job makes no progress.",
      "resources": [
        {
          "title": "parking_lot: Mutex, FairMutex, and RwLock variants",
          "url": "https://docs.rs/parking_lot/latest/parking_lot/",
          "kind": "docs"
        },
        {
          "title": "tokio::sync::Mutex fairness documentation",
          "url": "https://docs.rs/tokio/latest/tokio/sync/struct.Mutex.html",
          "kind": "docs"
        },
        {
          "title": "std::sync::RwLock platform-dependent policy",
          "url": "https://doc.rust-lang.org/std/sync/struct.RwLock.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "cp15",
      "n": 15,
      "title": "Testing concurrent code without flaky failures",
      "minutes": 80,
      "level": "industry",
      "goal": "Replace sleep-and-hope with forced interleavings and virtual time, assert invariants rather than schedules, and keep a suite that fails for real reasons.",
      "sections": [
        {
          "h": "Sleep is not synchronization",
          "p": [
            "A test that spawns a task, sleeps 50 ms, and asserts on the result is measuring the machine, not the code. On a loaded CI runner the sleep is too short and the test fails; on a fast laptop it passes and hides the race. Every sleep in a concurrency test is an admission that you do not know what you are waiting for.",
            "Replace time with signals. A channel message tells you the task reached a point. A tokio::sync::Barrier forces N tasks to the same line before any proceeds. A oneshot tells you a specific step completed. Each of those is deterministic, and each fails with a message that names the step that never happened."
          ],
          "tip": "If a test needs a timeout to pass, it needs a signal instead. Keep the timeout only as a failure bound, set generously, and never assert on elapsed wall time."
        },
        {
          "h": "Virtual time turns 30 seconds into a millisecond",
          "p": [
            "tokio::time::pause freezes the clock and auto-advances it when the runtime is idle, so a 30-second timeout completes instantly and deterministically. It requires the test-util feature and a current_thread runtime, which is exactly what #[tokio::test] provides; #[tokio::test(start_paused = true)] sets it up before the first poll.",
            "This is how you test deadline logic without slowing the suite: assert that a request with a 250 ms budget gives up at 250 ms of virtual time, that a retry backoff schedules at 1s, 2s, 4s, and that a drain window expires exactly when configured. Real sleeping tests for these paths take minutes and still flake."
          ],
          "code": "use std::time::Duration;\nuse tokio::sync::Barrier;\nuse tokio::time::{timeout, Instant};\n\n#[tokio::test(start_paused = true)]\nasync fn deadline_is_exact() {\n    let start = Instant::now();\n    let res = timeout(Duration::from_millis(250), std::future::pending::<()>()).await;\n    assert!(res.is_err(), \"a pending future must hit the deadline\");\n    // Virtual time: this assertion is exact, not approximate.\n    assert_eq!(start.elapsed(), Duration::from_millis(250));\n}\n\n#[tokio::test(start_paused = true)]\nasync fn retries_back_off() {\n    let mut attempt = 0u32;\n    let start = Instant::now();\n    loop {\n        attempt += 1;\n        if attempt == 4 {\n            break;\n        }\n        let delay = Duration::from_millis(100 * 2u64.pow(attempt - 1));\n        tokio::time::sleep(delay).await;\n    }\n    // 100 + 200 + 400 ms of virtual time, no real waiting.\n    assert_eq!(start.elapsed(), Duration::from_millis(700));\n}\n\n#[tokio::test(flavor = \"multi_thread\", worker_threads = 4)]\nasync fn barrier_forces_an_interleaving() {\n    let barrier = std::sync::Arc::new(Barrier::new(4));\n    let mut set = tokio::task::JoinSet::new();\n    for id in 0..4u32 {\n        let b = barrier.clone();\n        set.spawn(async move {\n            b.wait().await; // all four reach here before any proceeds\n            id\n        });\n    }\n    let mut seen = Vec::new();\n    while let Some(r) = set.join_next().await {\n        seen.push(r.unwrap());\n    }\n    seen.sort_unstable();\n    assert_eq!(seen, vec![0, 1, 2, 3]);\n}"
        },
        {
          "h": "Assert properties, not schedules",
          "p": [
            "You cannot enumerate every interleaving in a normal test, so assert on invariants that must hold for all of them: every submitted job is either completed or counted as dropped; the sum of balances is constant; a counter equals the number of messages consumed. Those invariants are checkable after any schedule and catch real bugs that a sleep-based test misses.",
            "Then layer the specialised tools: loom for small unsafe state machines, shuttle for randomised exploration of larger ones, and proptest for sequences of operations against a model. Each has a place, and none replaces a fast deterministic test suite that runs on every commit."
          ],
          "list": [
            "Conservation: nothing created or destroyed unexpectedly",
            "Accounting: accepted + rejected == attempted",
            "Idempotency: replaying a message does not double-apply",
            "Liveness bound: shutdown completes within a stated budget"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write tests for a bounded worker pool: one proving shutdown drains in-flight work, one proving no job is both executed and reported as dropped, and one proving the deadline fires at exactly the configured virtual time. No test may sleep on the real clock.",
        "starter": "use std::time::Duration;\nuse tokio::sync::mpsc;\n\npub struct Pool { tx: mpsc::Sender<u64> }\n\n#[tokio::test(start_paused = true)]\nasync fn shutdown_drains_in_flight() {\n    // 1. enqueue N jobs, drop the sender\n    // 2. await the worker\n    // 3. assert all N completed\n    todo!()\n}",
        "hint": "Drop the sender to close the mailbox, then await the JoinHandle. For the accounting test, count submissions and compare with completed plus rejected. For the deadline, use start_paused and assert on Instant::elapsed.",
        "solution": "use std::sync::atomic::{AtomicU64, Ordering};\nuse std::sync::Arc;\nuse std::time::Duration;\nuse tokio::sync::mpsc;\nuse tokio::task::JoinHandle;\nuse tokio::time::{timeout, Instant};\n\nstruct Pool {\n    tx: mpsc::Sender<u64>,\n    done: Arc<AtomicU64>,\n    handle: JoinHandle<()>,\n}\n\nasync fn pool(capacity: usize, job_ms: u64) -> Pool {\n    let (tx, mut rx) = mpsc::channel(capacity);\n    let done = Arc::new(AtomicU64::new(0));\n    let d = done.clone();\n    let handle = tokio::spawn(async move {\n        while let Some(_job) = rx.recv().await {\n            tokio::time::sleep(Duration::from_millis(job_ms)).await;\n            d.fetch_add(1, Ordering::Relaxed);\n        }\n    });\n    Pool { tx, done, handle }\n}\n\n#[tokio::test(start_paused = true)]\nasync fn shutdown_drains_in_flight() {\n    let p = pool(16, 10).await;\n    for i in 0..10 {\n        p.tx.send(i).await.unwrap();\n    }\n    drop(p.tx); // closing the mailbox is the shutdown signal\n    p.handle.await.unwrap();\n    assert_eq!(p.done.load(Ordering::Relaxed), 10);\n}\n\n#[tokio::test(start_paused = true)]\nasync fn every_job_is_accounted_for() {\n    let p = pool(2, 5).await;\n    let mut accepted = 0u64;\n    let mut rejected = 0u64;\n    for i in 0..100u64 {\n        match p.tx.try_send(i) {\n            Ok(()) => accepted += 1,\n            Err(mpsc::error::TrySendError::Full(_)) => rejected += 1,\n            Err(mpsc::error::TrySendError::Closed(_)) => break,\n        }\n    }\n    assert_eq!(accepted + rejected, 100);\n    drop(p.tx);\n    p.handle.await.unwrap();\n    assert_eq!(p.done.load(Ordering::Relaxed), accepted);\n}\n\n#[tokio::test(start_paused = true)]\nasync fn give_up_is_exact() {\n    let start = Instant::now();\n    let res = timeout(Duration::from_secs(30), std::future::pending::<()>()).await;\n    assert!(res.is_err());\n    assert_eq!(start.elapsed(), Duration::from_secs(30));\n}\n\n#[tokio::main]\nasync fn main() {\n    // Tests live in the harness; this binary just keeps the types honest.\n    let p = pool(4, 1).await;\n    drop(p.tx);\n    p.handle.await.unwrap();\n}"
      },
      "questions": [
        {
          "q": "Which change makes a flaky concurrency test deterministic?",
          "options": [
            "Increasing the sleep before the assertion",
            "Replacing the sleep with a channel signal from the task at the point you care about",
            "Running the test with --test-threads=1",
            "Retrying the test up to three times in CI"
          ],
          "answer": 1,
          "explain": "A signal states the condition you are waiting for, so the test either proceeds immediately or fails with a precise reason. Longer sleeps and retries only widen the window; single-threaded test execution does not order your tasks."
        },
        {
          "q": "What is required for #[tokio::test(start_paused = true)] to work?",
          "options": [
            "A multi_thread runtime with at least two workers",
            "The test-util feature and a current_thread runtime",
            "The time feature alone, on any runtime flavour",
            "A nightly compiler"
          ],
          "answer": 1,
          "explain": "Virtual time needs test-util and the current_thread runtime, which is the default flavour for #[tokio::test]. On a multi_thread runtime time cannot be paused deterministically across workers."
        },
        {
          "q": "A test asserts that 100 submitted jobs end as either completed or rejected. Which property is this?",
          "options": [
            "Linearizability",
            "Conservation of work across any schedule",
            "Lock freedom",
            "Fairness of the queue"
          ],
          "answer": 1,
          "explain": "It asserts that the arithmetic of accepted, rejected, and completed always closes - a schedule-independent invariant. That is testable without controlling the interleaving, which is exactly why it is valuable."
        }
      ],
      "quickbytes": [
        "Replace sleeps with channels, barriers, or oneshot signals; keep timeouts only as failure bounds.",
        "start_paused turns deadline tests into exact, instant assertions.",
        "Assert invariants that must hold after any interleaving, not one expected order of events."
      ],
      "production": [
        "No test sleeps to wait for a concurrent effect; signals and barriers are used instead.",
        "Deadline and retry logic is tested with virtual time, so the suite stays fast.",
        "Every concurrency test asserts an invariant (conservation, accounting, idempotency), not a schedule.",
        "Flaky tests are quarantined and fixed within a sprint; a retry wrapper is treated as a bug report."
      ],
      "crates": [
        "tokio",
        "proptest",
        "shuttle",
        "loom"
      ],
      "github": [
        {
          "name": "shuttle - randomised concurrency testing from AWS Labs",
          "url": "https://github.com/awslabs/shuttle"
        },
        {
          "name": "proptest - property-based testing for operation sequences",
          "url": "https://github.com/proptest-rs/proptest"
        }
      ],
      "pitfall": "Using tokio::time::sleep in a test that also pauses time: the sleep auto-advances the clock, your timeout fires earlier than the test expects, and the failure looks like a production race when it is a test-fixture bug.",
      "resources": [
        {
          "title": "tokio::time::pause and virtual time rules",
          "url": "https://docs.rs/tokio/latest/tokio/time/fn.pause.html",
          "kind": "docs"
        },
        {
          "title": "tokio::sync::Barrier for forced interleavings",
          "url": "https://docs.rs/tokio/latest/tokio/sync/struct.Barrier.html",
          "kind": "docs"
        },
        {
          "title": "proptest: property-based testing",
          "url": "https://github.com/proptest-rs/proptest",
          "kind": "repo"
        },
        {
          "title": "shuttle: randomised testing for concurrent Rust",
          "url": "https://github.com/awslabs/shuttle",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "cp16",
      "n": 16,
      "title": "Loom: model checking the shared state",
      "minutes": 90,
      "level": "industry",
      "goal": "Write a loom test that explores every interleaving of a two-thread handoff, keep the model small enough to finish, and wire it into CI as a separate job.",
      "sections": [
        {
          "h": "What loom actually does",
          "p": [
            "loom replaces the scheduler and the memory model. Inside loom::model, it runs your closure repeatedly, each time choosing a different thread schedule and a different permitted outcome for every atomic access. It prunes equivalent executions, so it is exhaustive rather than random - for the threads and operations it can see.",
            "The consequence is that loom only observes what uses loom's own types. If one Arc is std's and the rest are loom's, the interaction is invisible and the model is unsound. That is why the standard pattern is a cfg(loom) module that re-exports loom types under one name and std types otherwise."
          ],
          "tip": "Keep loom models to two or three threads and a handful of atomics. Every extra thread multiplies the state space; three threads is where most subtle bugs live anyway."
        },
        {
          "h": "A test that fails for a real reason",
          "p": [
            "The canonical bug is a publish without a Release. Writer stores data with Relaxed, then sets a ready flag with Relaxed; reader sees the flag and reads stale data. On x86 this passes for years; loom enumerates the interleaving where it does not, and the test fails on the first run.",
            "Once the pair is Release/Acquire, the same test passes, and that passing is meaningful: it holds for every schedule loom can produce, which is a far stronger claim than a loop of a million iterations on one machine. A stress loop samples schedules and depends on the host; loom enumerates them inside the bounds you set, so a green model is evidence about all modelled executions rather than evidence of an hour of luck."
          ],
          "code": "// tests/loom_publish.rs\n#![cfg(loom)]\n\nuse loom::sync::atomic::{AtomicBool, AtomicUsize, Ordering};\nuse loom::sync::Arc;\nuse loom::thread;\n\n#[test]\nfn release_acquire_publishes_the_value() {\n    loom::model(|| {\n        let data = Arc::new(AtomicUsize::new(0));\n        let ready = Arc::new(AtomicBool::new(false));\n\n        let (d, r) = (data.clone(), ready.clone());\n        let writer = thread::spawn(move || {\n            d.store(42, Ordering::Relaxed);\n            r.store(true, Ordering::Release); // swap to Relaxed to see it fail\n        });\n\n        // The initial value is 0; once ready is observed, 42 must be visible.\n        if ready.load(Ordering::Acquire) {\n            assert_eq!(data.load(Ordering::Relaxed), 42);\n        }\n\n        writer.join().unwrap();\n    });\n}"
        },
        {
          "h": "Running it without wrecking CI",
          "p": [
            "Loom tests run with a cfg flag, not by default: RUSTFLAGS=\"--cfg loom\" cargo test --test loom_publish --release. Release matters because the model executes thousands of permutations and debug builds multiply that by a large constant. Keep loom in target.'cfg(loom)'.dependencies so normal builds never compile it.",
            "Bound the search before it bounds you. loom::model::Builder exposes max_threads and preemption_bound as fields and a check method that runs the model: max_threads = 3 with preemption_bound = Some(2) explores every execution with at most two preemptions, which is where most bugs hide, and finishes in seconds. LOOM_MAX_PREEMPTIONS does the same from the environment for a one-off deep run."
          ],
          "list": [
            "One test file per data structure, each under a second",
            "max_threads = 2..3 and a preemption bound of 2..3",
            "A dedicated CI job, not the default test run",
            "Swap the ordering to the buggy one and confirm the test fails"
          ]
        }
      ],
      "exercise": {
        "prompt": "Model a two-thread SPSC ring buffer with loom: one producer writing a slot then advancing a Release head, one consumer loading head with Acquire then reading the slot. Prove no execution lets the consumer read an unwritten slot, then break the ordering and watch loom catch it.",
        "starter": "#![cfg(loom)]\nuse loom::sync::atomic::{AtomicUsize, Ordering};\nuse loom::sync::Arc;\n\nstruct Ring {\n    slot: loom::cell::UnsafeCell<u32>,\n    head: AtomicUsize,\n}\n\n#[test]\nfn consumer_never_sees_stale_slot() {\n    loom::model(|| {\n        // 1. producer: slot.store(v); head.store(1, Release)\n        // 2. consumer: if head.load(Acquire) == 1 { read slot }\n        todo!()\n    });\n}",
        "hint": "Use loom::cell::UnsafeCell with .with_mut and .with for the slot, and assert inside the consumer only after an Acquire load observes 1. Then change Release to Relaxed and run with LOOM_MAX_PREEMPTIONS=3.",
        "solution": "#![cfg(loom)]\nuse loom::cell::UnsafeCell;\nuse loom::sync::atomic::{AtomicUsize, Ordering};\nuse loom::sync::Arc;\nuse loom::thread;\n\nstruct Ring {\n    slot: UnsafeCell<u32>,\n    head: AtomicUsize,\n}\n\n#[test]\nfn consumer_never_sees_stale_slot() {\n    loom::model(|| {\n        let ring = Arc::new(Ring { slot: UnsafeCell::new(0), head: AtomicUsize::new(0) });\n\n        let producer = {\n            let ring = ring.clone();\n            thread::spawn(move || {\n                // Publish the payload, then the index that guards it.\n                ring.slot.with_mut(|p| unsafe { *p = 7 });\n                ring.head.store(1, Ordering::Release);\n            })\n        };\n\n        let consumer = {\n            let ring = ring.clone();\n            thread::spawn(move || {\n                // Acquire pairs with the producer's Release. Relaxed here would\n                // let the slot read happen before the payload is visible.\n                if ring.head.load(Ordering::Acquire) == 1 {\n                    let seen = ring.slot.with(|p| unsafe { *p });\n                    assert_eq!(seen, 7, \"consumer observed an unpublished slot\");\n                }\n            })\n        };\n\n        producer.join().unwrap();\n        consumer.join().unwrap();\n    });\n}\n\n// Run: RUSTFLAGS=\"--cfg loom\" cargo test --test loom_ring --release\n// Deep run: LOOM_MAX_PREEMPTIONS=3 RUSTFLAGS=\"--cfg loom\" cargo test --release\n// Negative control: change Release to Relaxed and the test fails."
      },
      "questions": [
        {
          "q": "Your loom test uses std::sync::Arc but loom atomics. What is wrong?",
          "options": [
            "Nothing, Arc has no synchronization",
            "Loom cannot observe the Arc's interactions, so schedules it explores are not the real ones",
            "It fails to compile because loom requires loom::sync::Arc",
            "It is fine as long as the Arc is cloned before the model starts"
          ],
          "answer": 1,
          "explain": "Loom only controls operations it implements - thread spawn, atomics, locks, and its Arc's refcount. A std Arc's reference counting is invisible to the model, so the explored executions do not cover the real program."
        },
        {
          "q": "Why does a loom test with six threads rarely finish?",
          "options": [
            "Loom refuses more than four threads by default and panics",
            "Interleavings grow combinatorially; state reduction prunes some but not enough",
            "Each thread needs its own compiler thread",
            "Six threads exceed MAX_THREADS and compile fails"
          ],
          "answer": 1,
          "explain": "The number of distinct executions grows explosively with thread count. Loom prunes equivalents but the remainder still explodes, which is why models are kept small and preemption bounds are set."
        },
        {
          "q": "What does a passing loom test prove that a 1,000,000-iteration stress loop does not?",
          "options": [
            "That the code is faster",
            "That no execution within the model's scope violates the assertion, not merely that none did on one machine",
            "That the code is free of all bugs, including logic errors",
            "That the compiler will not reorder the atomics"
          ],
          "answer": 1,
          "explain": "Stress testing samples schedules and depends on the host; loom enumerates them within its bounds. It proves a property for the modelled threads and operations, which is strong - but it says nothing about logic errors outside the model."
        }
      ],
      "quickbytes": [
        "Loom sees only loom types: route every Arc, atomic, Mutex, and spawn through a cfg(loom) module.",
        "Run loom in release with a separate CI job and a preemption bound; keep each model under a second.",
        "Always verify the test can fail: flip Release to Relaxed and watch it break."
      ],
      "production": [
        "Every unsafe concurrent structure has a loom model covering its publish and reclamation paths.",
        "Loom runs as its own CI job with a bounded preemption setting and a wall-clock timeout.",
        "The loom dependency is under target.'cfg(loom)'.dependencies and absent from release builds.",
        "Each loom test has a documented negative control that was observed to fail."
      ],
      "crates": [
        "loom",
        "shuttle",
        "crossbeam-epoch",
        "tokio"
      ],
      "github": [
        {
          "name": "loom - permutation testing for concurrent code",
          "url": "https://github.com/tokio-rs/loom"
        },
        {
          "name": "shuttle - randomised exploration for larger models",
          "url": "https://github.com/awslabs/shuttle"
        }
      ],
      "pitfall": "Writing a loom test that can never fail because the assertion sits outside the model or the types are std: the test is green, the team believes the unsafe code is verified, and the actual race is exactly the one the model could not see.",
      "resources": [
        {
          "title": "loom crate documentation: model, Builder, limitations",
          "url": "https://docs.rs/loom/latest/loom/",
          "kind": "docs"
        },
        {
          "title": "Making the Tokio scheduler 10x faster (loom case study)",
          "url": "https://tokio.rs/blog/2019-10-scheduler",
          "kind": "article"
        },
        {
          "title": "loom source and examples",
          "url": "https://github.com/tokio-rs/loom",
          "kind": "repo"
        },
        {
          "title": "Formal verification of the Chase-Lev deque (why these proofs matter)",
          "url": "https://arxiv.org/abs/2309.03642",
          "kind": "paper"
        }
      ]
    },
    {
      "id": "cp17",
      "n": 17,
      "title": "Async runtime internals you can reason about",
      "minutes": 75,
      "level": "industry",
      "goal": "Trace what a worker thread does between two polls, and use that model to explain stalls, timer drift, and why a task that never registers a waker never wakes.",
      "sections": [
        {
          "h": "A task is a state machine plus a waker",
          "p": [
            "The runtime owns tasks, not threads. A task is a future plus a waker; polling runs the future until it returns Pending, and the waker is how a resource (a socket, a timer, a channel) schedules that task again. If a future returns Pending without arranging for its waker to be called, it is simply never polled again - a hang with no error and no thread blocked.",
            "That is the single most useful debugging fact about async Rust: a stuck request is usually a missing wakeup, not a slow operation. Instrument poll counts and waker calls and the difference between \"never scheduled\" and \"scheduled but slow\" becomes obvious."
          ],
          "tip": "When a task hangs, ask which resource it is waiting on and whether that resource has the waker. The scheduler is almost never the culprit."
        },
        {
          "h": "Workers, local queues, and stealing",
          "p": [
            "A multi-thread runtime starts one worker thread per core by default. Each worker owns a local run queue and drains it, spilling overflow and externally submitted tasks into a global queue that every worker can consume. An idle worker steals from siblings rather than sleeping immediately, and parks only when there is genuinely nothing to do.",
            "Two details explain most observed behaviour. Newly woken tasks go into a special slot checked before the queue, which is why message-passing chains stay cache-hot. And a task that is scheduled while all workers are busy waits for a worker to finish its current poll - there is no preemption, so a long poll delays everything behind it."
          ],
          "code": "use std::time::Duration;\nuse tokio::runtime::Builder;\n\nfn main() -> std::io::Result<()> {\n    let rt = Builder::new_multi_thread()\n        .worker_threads(4)          // async tasks: keep this at the CPU quota\n        .max_blocking_threads(64)   // spawn_blocking: file I/O, compression, FFI\n        .thread_name(\"api-worker\")\n        .thread_keep_alive(Duration::from_secs(30))\n        .enable_all()               // I/O driver + timer wheel\n        .build()?;\n\n    rt.block_on(async {\n        let out = tokio::spawn(async {\n            tokio::time::sleep(Duration::from_millis(10)).await;\n            7u32\n        })\n        .await\n        .unwrap();\n        assert_eq!(out, 7);\n    });\n\n    // Dropping a runtime waits for blocking tasks to finish, so shut down with\n    // a deadline when a blocking task may be long-lived.\n    rt.shutdown_timeout(Duration::from_secs(5));\n    println!(\"shut down cleanly\");\n    Ok(())\n}"
        },
        {
          "h": "Cooperation, timers, and shutdown",
          "p": [
            "A task that loops over ready sockets could monopolise a worker forever, so tokio applies a cooperative budget: after a bounded number of I/O operations in one poll, resources return Pending and reschedule the task, giving siblings a turn. Pure CPU work is outside that budget, which is why a compute loop still starves its worker.",
            "Timers live in a hashed hierarchical wheel, so a 30-second sleep costs a slot, not a thread. The runtime advances the wheel when it parks, which means timer accuracy is bounded by how long the runtime stays busy - a worker stuck in a long poll delays every timer on that runtime. shutdown_timeout exists because dropping a runtime waits for blocking tasks, and a wedged blocking task would otherwise hang shutdown."
          ],
          "list": [
            "worker_threads ≈ CPU quota; more workers do not fix blocking",
            "max_blocking_threads bounds the blocking pool, not the async work",
            "One long poll delays timers and every task behind it",
            "Always shut a runtime down with a timeout in tests and binaries"
          ]
        }
      ],
      "exercise": {
        "prompt": "Build a runtime with 2 workers and a 16-thread blocking pool, run 8 tasks that each sleep 50 ms and 4 blocking jobs that each sleep 200 ms, and report total wall time. Then explain why raising workers to 8 does not change the blocking jobs' completion time.",
        "starter": "use std::time::{Duration, Instant};\nuse tokio::runtime::Builder;\n\nfn main() -> std::io::Result<()> {\n    let rt = Builder::new_multi_thread()\n        .worker_threads(2)\n        .max_blocking_threads(16)\n        .enable_all()\n        .build()?;\n    // 1. spawn 8 async sleeps\n    // 2. spawn 4 spawn_blocking jobs\n    // 3. measure wall clock and join everything\n    todo!()\n}",
        "hint": "Blocking jobs run on a separate pool, so they overlap with each other and with async tasks; the slowest one sets the floor at about 200 ms regardless of worker count. Workers only change how quickly async tasks are polled.",
        "solution": "use std::time::{Duration, Instant};\nuse tokio::runtime::Builder;\n\nfn build(workers: usize) -> std::io::Result<tokio::runtime::Runtime> {\n    Builder::new_multi_thread()\n        .worker_threads(workers)\n        .max_blocking_threads(16)\n        .enable_all()\n        .build()\n}\n\nfn run(workers: usize) -> std::io::Result<Duration> {\n    let rt = build(workers)?;\n    let start = Instant::now();\n    rt.block_on(async {\n        let mut set = tokio::task::JoinSet::new();\n        for _ in 0..8 {\n            set.spawn(async {\n                tokio::time::sleep(Duration::from_millis(50)).await;\n            });\n        }\n        for _ in 0..4 {\n            set.spawn_blocking(|| std::thread::sleep(Duration::from_millis(200)));\n        }\n        while set.join_next().await.is_some() {}\n    });\n    Ok(start.elapsed())\n}\n\nfn main() -> std::io::Result<()> {\n    for workers in [1, 2, 8] {\n        println!(\"{workers} workers -> {:?}\", run(workers)?);\n    }\n    Ok(())\n}"
      },
      "questions": [
        {
          "q": "A future returns Poll::Pending without registering its waker. What happens?",
          "options": [
            "The runtime repolls it on the next tick",
            "The task is never polled again unless something else wakes it",
            "The runtime panics with a lost-waker error",
            "The task is moved to the blocking pool"
          ],
          "answer": 1,
          "explain": "Pending is a promise that a wakeup will arrive. Without a registered waker there is no wakeup, so the task sleeps forever while its thread is free - the classic silent hang."
        },
        {
          "q": "Why does one long CPU poll inside an async task hurt unrelated requests?",
          "options": [
            "It consumes the cooperative budget permanently",
            "The worker cannot run other tasks until the poll returns, and timers on that runtime are delayed too",
            "It forces the runtime to spawn extra workers",
            "It holds the global queue lock"
          ],
          "answer": 1,
          "explain": "There is no preemption between polls. The worker is inside your code until it returns, so siblings wait and the timer wheel cannot advance on that thread."
        },
        {
          "q": "What does max_blocking_threads actually bound?",
          "options": [
            "The number of async tasks the runtime will accept",
            "The size of the pool used by spawn_blocking and blocking file I/O",
            "The number of worker threads reading from epoll",
            "The depth of each worker's local run queue"
          ],
          "answer": 1,
          "explain": "It caps the blocking pool. Async tasks share the worker threads and are unbounded in number; blocking work is what can exhaust threads, and exceeding the cap queues blocking jobs instead of growing the process."
        }
      ],
      "quickbytes": [
        "A hang is usually a missing wakeup; a stall is usually a long poll. They look identical from outside - instrument poll counts.",
        "Worker count tracks CPU quota; blocking work needs its own pool and its own bound.",
        "One long poll delays every timer on that runtime; keep polls short."
      ],
      "production": [
        "Runtime configuration (workers, blocking cap, keep-alive) is explicit and reviewed, not left to defaults.",
        "Runtime metrics such as busy duration and park counts are exported and alerted on.",
        "Binaries and tests call shutdown_timeout instead of dropping a runtime silently.",
        "Poll-time instrumentation identifies tasks that exceed a stated budget."
      ],
      "crates": [
        "tokio",
        "tokio-metrics",
        "console-subscriber",
        "tracing"
      ],
      "github": [
        {
          "name": "tokio - the work-stealing scheduler and runtime",
          "url": "https://github.com/tokio-rs/tokio"
        },
        {
          "name": "tokio-metrics - runtime and task instrumentation",
          "url": "https://github.com/tokio-rs/tokio-metrics"
        }
      ],
      "pitfall": "Assuming more worker threads fix a slow service: if the time is spent in spawn_blocking or in one long poll, extra workers add context switches and memory while the bottleneck stays exactly where it was.",
      "resources": [
        {
          "title": "Making the Tokio scheduler 10x faster (design walkthrough)",
          "url": "https://tokio.rs/blog/2019-10-scheduler",
          "kind": "article"
        },
        {
          "title": "tokio::runtime::Builder reference",
          "url": "https://docs.rs/tokio/latest/tokio/runtime/struct.Builder.html",
          "kind": "docs"
        },
        {
          "title": "tokio-metrics: worker and task metrics",
          "url": "https://docs.rs/tokio-metrics/latest/tokio_metrics/",
          "kind": "docs"
        },
        {
          "title": "Asynchronous Programming in Rust: executors and wakers",
          "url": "https://rust-lang.github.io/async-book/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "cp18",
      "n": 18,
      "title": "Blocking inside async: the tax and the escape hatch",
      "minutes": 60,
      "level": "industry",
      "goal": "Find every blocking call reachable from an async task, move it to the blocking pool with a bound, and know when block_in_place is legitimate.",
      "sections": [
        {
          "h": "What blocking actually costs",
          "p": [
            "An async task runs on a worker thread shared by hundreds of other tasks. A blocking call parks that thread inside the kernel, so every task scheduled on it stops: timers do not fire, sockets are not polled, and requests queue behind a call that has nothing to do with them. One thread::sleep in a handler can take out 25% of a four-worker runtime.",
            "The threshold is lower than people expect. Anything that may take more than tens of microseconds - file I/O, DNS resolution, compression, a synchronous database driver, FFI into a C library - belongs on the blocking pool. tokio::fs is implemented with spawn_blocking for exactly this reason."
          ],
          "tip": "Grep for std::fs, std::net, std::thread::sleep, and blocking database clients inside async modules. A deny-list of imports is cheaper than a postmortem."
        },
        {
          "h": "spawn_blocking, block_in_place, and the difference",
          "p": [
            "spawn_blocking moves one closure onto a dedicated pool whose size is capped by max_blocking_threads (512 by default). It returns a JoinHandle you must await; dropping the handle does not cancel the work, because a running blocking task cannot be interrupted. Bound the pool with a Semaphore when the work is expensive, or a burst will queue behind the cap.",
            "block_in_place is different: it tells the runtime that the current worker is about to block, so the executor hands its queued tasks to another worker first. It panics on a current_thread runtime, any other code running concurrently in the same task is suspended for the duration (a join! sibling, for example), and it exists mainly to adapt a synchronous call that must run inline while you hold a borrow."
          ],
          "code": "use std::time::Duration;\nuse tokio::sync::Semaphore;\nuse tokio::time::timeout;\n\npub struct Blocker {\n    permits: std::sync::Arc<Semaphore>,\n}\n\nimpl Blocker {\n    pub fn new(max_concurrent: usize) -> Self {\n        Self { permits: std::sync::Arc::new(Semaphore::new(max_concurrent)) }\n    }\n\n    /// CPU- or IO-heavy synchronous work, bounded and cancellable from the caller.\n    pub async fn run<T, F>(&self, budget: Duration, f: F) -> Result<T, String>\n    where\n        T: Send + 'static,\n        F: FnOnce() -> T + Send + 'static,\n    {\n        let permit = self\n            .permits\n            .clone()\n            .acquire_owned()\n            .await\n            .map_err(|_| \"blocker closed\".to_string())?;\n\n        // The permit is released when the blocking job actually finishes,\n        // not when the timeout fires - the thread keeps running either way.\n        let handle = tokio::task::spawn_blocking(move || {\n            let out = f();\n            drop(permit);\n            out\n        });\n\n        timeout(budget, handle)\n            .await\n            .map_err(|_| \"blocking job exceeded its budget\".to_string())?\n            .map_err(|e| e.to_string())\n    }\n}\n\n#[tokio::main]\nasync fn main() {\n    let blocker = Blocker::new(2);\n    let out = blocker\n        .run(Duration::from_secs(2), || {\n            // Pretend this is zstd, argon2, or a C library call.\n            std::thread::sleep(Duration::from_millis(50));\n            41 + 1\n        })\n        .await\n        .unwrap();\n    assert_eq!(out, 42);\n    println!(\"ok\");\n}"
        },
        {
          "h": "The two panic traps",
          "p": [
            "Calling Handle::block_on from inside a runtime panics: you cannot block a thread that is already driving other tasks. Calling block_in_place on a current_thread runtime panics too, because there is no other worker to hand the queue to. Both are compile-successfully, panic-at-runtime mistakes that show up first in a test using the wrong flavour.",
            "The subtler trap is blocking-pool exhaustion. Every spawn_blocking job that stalls holds a pool thread; once 512 are held, further blocking jobs queue behind them and the async side looks fine while work piles up invisibly. Cap the pool or cap your own concurrency, and export the queue depth."
          ],
          "list": [
            "spawn_blocking for anything that may take >10-100 microseconds",
            "A Semaphore in front of spawn_blocking when the work is bursty",
            "Never call block_on inside async; use .await",
            "block_in_place only on multi_thread, and only to adapt a sync API"
          ]
        }
      ],
      "exercise": {
        "prompt": "A handler computes a SHA-256 over a 50 MB upload using a synchronous hasher on the async worker. Move the hashing to the blocking pool, bound the number of concurrent hashes to 4, add a 2-second budget, and prove with a paused-clock test that the deadline path returns an error.",
        "starter": "use std::time::Duration;\n\npub async fn hash_upload(bytes: Vec<u8>) -> Result<[u8; 32], String> {\n    // 1. do not hash on the async worker\n    // 2. bound concurrency\n    // 3. enforce a budget\n    todo!()\n}",
        "hint": "Wrap the hashing closure in tokio::task::spawn_blocking behind an Arc<Semaphore>, then tokio::time::timeout the JoinHandle. Remember the permit must be dropped inside the closure, after the work, not after the timeout.",
        "solution": "use std::sync::Arc;\nuse std::time::Duration;\nuse tokio::sync::Semaphore;\nuse tokio::time::timeout;\n\npub struct Hasher {\n    permits: Arc<Semaphore>,\n}\n\nimpl Hasher {\n    pub fn new(max_concurrent: usize) -> Self {\n        Self { permits: Arc::new(Semaphore::new(max_concurrent)) }\n    }\n\n    pub async fn hash_upload(&self, bytes: Vec<u8>, budget: Duration) -> Result<u64, String> {\n        let permit = self\n            .permits\n            .clone()\n            .acquire_owned()\n            .await\n            .map_err(|_| \"hasher closed\".to_string())?;\n\n        let handle = tokio::task::spawn_blocking(move || {\n            // Stand-in for a real synchronous hasher over 50 MB.\n            let mut acc = 0u64;\n            for chunk in bytes.chunks(1024) {\n                for &b in chunk {\n                    acc = acc.wrapping_mul(31).wrapping_add(b as u64);\n                }\n            }\n            drop(permit); // released when the work is truly done\n            acc\n        });\n\n        timeout(budget, handle)\n            .await\n            .map_err(|_| \"hash exceeded budget\".to_string())?\n            .map_err(|e| e.to_string())\n    }\n}\n\n#[tokio::main]\nasync fn main() {\n    let hasher = Hasher::new(4);\n    let data = vec![7u8; 1024 * 1024];\n    let out = hasher.hash_upload(data, Duration::from_secs(2)).await.unwrap();\n    println!(\"hash = {out}\");\n}"
      },
      "questions": [
        {
          "q": "Why does tokio::fs use spawn_blocking internally?",
          "options": [
            "To make file reads parallel across cores",
            "Because most platforms' file APIs are blocking syscalls that would park a worker thread",
            "Because async file I/O is unsafe in Rust",
            "To bypass the page cache"
          ],
          "answer": 1,
          "explain": "There is no portable async file API on all targets, so the blocking syscall is moved to a pool where parking a thread is acceptable. The async signature stays, the blocking moves off the worker."
        },
        {
          "q": "A spawn_blocking job times out at the caller. What is true?",
          "options": [
            "The blocking thread is interrupted and stops",
            "The job keeps running; only the await was abandoned",
            "The pool replaces the thread and the job restarts",
            "The permit is released immediately, freeing capacity"
          ],
          "answer": 1,
          "explain": "Blocking work cannot be cancelled, so the thread runs to completion. That is exactly why a permit must be held inside the closure: releasing it at timeout would over-admit work that is still consuming a thread."
        },
        {
          "q": "Where is block_in_place acceptable?",
          "options": [
            "On a current_thread runtime, to avoid an extra thread",
            "On a multi_thread runtime, to adapt a synchronous API that must run inline",
            "Anywhere, as long as the call is short",
            "Inside spawn_blocking, to avoid a second hop"
          ],
          "answer": 1,
          "explain": "It hands the worker's queue to a sibling and converts the worker into a blocking thread - only possible with a multi-thread runtime. On current_thread it panics, and it is never a substitute for spawn_blocking."
        }
      ],
      "quickbytes": [
        "One thread::sleep in a handler removes a worker from the runtime for its whole duration.",
        "Hold the blocking permit inside the closure, so timeouts do not over-admit work.",
        "Handle::block_on inside async and block_in_place on current_thread both panic at runtime, not compile time."
      ],
      "production": [
        "Blocking calls in async paths are found by an import deny-list and by review, not by profiling luck.",
        "The blocking pool has a concurrency cap and an exported queue-depth metric.",
        "Every spawn_blocking call has a stated budget and a policy for the timeout path.",
        "Tests cover both runtime flavours where block_in_place or paused time is used."
      ],
      "crates": [
        "tokio",
        "tokio-util",
        "rayon",
        "tokio-metrics"
      ],
      "github": [
        {
          "name": "tokio - spawn_blocking and the blocking pool",
          "url": "https://github.com/tokio-rs/tokio"
        },
        {
          "name": "tokio-metrics - detect workers stalled by blocking work",
          "url": "https://github.com/tokio-rs/tokio-metrics"
        }
      ],
      "pitfall": "Using a synchronous database driver inside async handlers: the pool of workers is fine at low load, then every worker parks on a socket read and the whole service stops responding while CPU sits near zero.",
      "resources": [
        {
          "title": "tokio::task::spawn_blocking reference",
          "url": "https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html",
          "kind": "docs"
        },
        {
          "title": "tokio::task::block_in_place and runtime flavour rules",
          "url": "https://docs.rs/tokio/latest/tokio/task/fn.block_in_place.html",
          "kind": "docs"
        },
        {
          "title": "tokio::runtime::Builder: worker and blocking pool sizing",
          "url": "https://docs.rs/tokio/latest/tokio/runtime/struct.Builder.html",
          "kind": "docs"
        },
        {
          "title": "Asynchronous Programming in Rust: what makes a future blocking",
          "url": "https://rust-lang.github.io/async-book/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "cp19",
      "n": 19,
      "title": "Measuring concurrency performance honestly",
      "minutes": 80,
      "level": "industry",
      "goal": "Produce throughput, tail latency, and scaling numbers that survive review, and recognise the benchmark shapes that flatter a concurrent design.",
      "sections": [
        {
          "h": "Throughput without latency is half a measurement",
          "p": [
            "A concurrent system has a curve, not a number. At low load, latency is flat and throughput rises linearly; at saturation, throughput plateaus and latency climbs without bound. A benchmark that reports only requests per second at saturation describes a system nobody wants to operate, because the last 10% of throughput costs seconds of tail latency.",
            "Report at least two operating points: the throughput at a fixed latency budget (say p99 under 50 ms), and the maximum throughput with the corresponding p50/p99. Those two numbers, plus the concurrency level and the machine, are what another engineer needs to reproduce your claim."
          ],
          "tip": "State the concurrency level next to every latency number. p99 without a load level is a number without a subject."
        },
        {
          "h": "Coordinated omission ruins closed-loop benchmarks",
          "p": [
            "Most load generators are closed loop: a fixed number of clients each send a request, wait for the response, then send again. When the server stalls, the generator stalls too, so the slow requests are never issued and never measured - the tail you report is the tail of the requests that were lucky enough to be sent.",
            "Open-loop generators send at a fixed rate regardless of responses; that is how you see the real queueing delay. If your tool only does closed loop, measure the achieved rate and the queue depth, and treat the p99 as a lower bound. Criterion solves the microbenchmark version of this by sampling with a known iteration count and reporting a distribution."
          ],
          "code": "use criterion::{criterion_group, criterion_main, BatchSize, Criterion, Throughput};\nuse std::hint::black_box;\n\nfn work(n: u64) -> u64 {\n    (0..n).fold(0u64, |acc, i| acc.wrapping_add(black_box(i) * 3))\n}\n\nfn bench(c: &mut Criterion) {\n    let mut group = c.benchmark_group(\"pipeline\");\n    group.throughput(Throughput::Elements(1_000));\n\n    // Steady-state cost per batch.\n    group.bench_function(\"sequential\", |b| b.iter(|| work(black_box(1_000))));\n\n    // Setup cost excluded: this is the shape to use for queue-based work.\n    group.bench_function(\"batched\", |b| {\n        b.iter_batched(\n            || (0u64..1_000).collect::<Vec<_>>(),\n            |items| items.iter().map(|i| black_box(*i) * 3).sum::<u64>(),\n            BatchSize::SmallInput,\n        )\n    });\n\n    group.finish();\n}\n\ncriterion_group!(benches, bench);\ncriterion_main!(benches);"
        },
        {
          "h": "Scaling curves and the counters that explain them",
          "p": [
            "Plot speedup against thread count and compare it with the linear line. A curve that flattens early is either a serial section, a shared cache line, or a pool that is not the bottleneck you think. Run the same binary with 1, 2, 4, 8 workers and keep every other variable fixed - same machine, same build profile, same input.",
            "Then explain the shape with counters: context switches per request, LLC misses, queue depth, and worker busy time. A benchmark without a mechanism is a rumour; the counter that changes with the regression is what lets you fix it. And never compare a debug build against a release build, or two runs on a shared CI runner with different neighbours."
          ],
          "list": [
            "Release profile, fixed input, pinned CPU where possible",
            "Report p50/p99, not the mean",
            "Report the concurrency level and the machine",
            "Keep the counter that explains the curve next to the chart"
          ]
        }
      ],
      "exercise": {
        "prompt": "Benchmark a bounded channel pipeline at 1, 2, 4, and 8 workers with criterion, reporting throughput and per-item time. Then explain which point on the curve you would ship, given that p99 latency doubles between the last two points.",
        "starter": "use criterion::{criterion_group, criterion_main, Criterion, Throughput};\n\nfn pipeline(workers: usize, items: usize) -> u64 {\n    // bounded channel + worker threads + sum\n    todo!()\n}\n\nfn bench(c: &mut Criterion) {\n    let mut g = c.benchmark_group(\"pipeline\");\n    // 1. one benchmark per worker count\n    // 2. set Throughput::Elements\n    todo!()\n}\n\ncriterion_group!(benches, bench);\ncriterion_main!(benches);",
        "hint": "Throughput::Elements(items as u64) makes criterion print items per second. Build the threads inside the routine or use iter_batched with setup, so thread spawn cost does not dominate a small item count.",
        "solution": "use criterion::{criterion_group, criterion_main, BatchSize, Criterion, Throughput};\nuse crossbeam_channel::bounded;\nuse std::hint::black_box;\nuse std::thread;\n\nfn pipeline(workers: usize, items: usize) -> u64 {\n    let (tx, rx) = bounded::<u64>(64);\n    let mut total = 0u64;\n\n    thread::scope(|s| {\n        let handles: Vec<_> = (0..workers)\n            .map(|_| {\n                let rx = rx.clone();\n                s.spawn(move || {\n                    let mut local = 0u64;\n                    for v in rx {\n                        local = local.wrapping_add(v * 3);\n                    }\n                    local\n                })\n            })\n            .collect();\n        drop(rx); // only the workers hold receivers now\n\n        for i in 0..items as u64 {\n            if tx.send(i).is_err() {\n                break;\n            }\n        }\n        drop(tx); // closing the input lets the workers finish\n\n        for h in handles {\n            total = total.wrapping_add(h.join().unwrap());\n        }\n    });\n\n    black_box(total)\n}\n\nfn bench(c: &mut Criterion) {\n    let mut group = c.benchmark_group(\"pipeline\");\n    group.throughput(Throughput::Elements(10_000));\n    group.sample_size(30);\n\n    for workers in [1usize, 2, 4, 8] {\n        group.bench_with_input(\n            format!(\"workers_{workers}\"),\n            &workers,\n            |b, &workers| {\n                b.iter_batched(\n                    || (),\n                    |()| pipeline(workers, 10_000),\n                    BatchSize::SmallInput,\n                )\n            },\n        );\n    }\n    group.finish();\n}\n\ncriterion_group!(benches, bench);\ncriterion_main!(benches);"
      },
      "questions": [
        {
          "q": "Why is a closed-loop load generator's p99 optimistic?",
          "options": [
            "It measures server time instead of client time",
            "It stops issuing requests while waiting, so the requests that would have been slowest are never sent",
            "It averages over too few samples",
            "It ignores TLS handshakes"
          ],
          "answer": 1,
          "explain": "Closed loop couples request rate to response time, so a stalled server suppresses its own load. The long queueing delays that an open-loop generator would have produced never appear in the sample."
        },
        {
          "q": "A scaling curve flattens at four threads on an eight-core machine. Which explanation is testable first?",
          "options": [
            "The OS limits the process to four threads",
            "A shared cache line or a single lock is serialising the hot path",
            "Criterion cannot measure more than four threads",
            "The workload is memory-bound and cannot scale"
          ],
          "answer": 1,
          "explain": "Contention is the most common cause and the cheapest to test: remove the sharing (per-thread state, padding) and see whether the curve straightens. The other explanations are possible but each needs its own evidence."
        },
        {
          "q": "What does criterion's iter_batched give you that iter does not?",
          "options": [
            "It runs the benchmark in parallel",
            "It separates untimed setup from the timed routine",
            "It removes the need for black_box",
            "It measures CPU time instead of wall time"
          ],
          "answer": 1,
          "explain": "Setup such as building a Vec or a queue should not be inside the measurement. iter_batched lets the harness time only the routine while still creating fresh input per iteration."
        }
      ],
      "quickbytes": [
        "Report throughput at a latency budget plus the saturation point; one number hides the trade-off.",
        "State the concurrency level and machine next to every latency figure.",
        "Closed-loop load generation suppresses the tail; prefer open-loop or report queue depth."
      ],
      "production": [
        "Benchmarks run in release mode on a labelled machine, and results are stored with the commit.",
        "Every performance claim in a design review includes p50/p99 at a stated concurrency.",
        "A scaling benchmark exists for each pool and fails CI on a regression beyond a threshold.",
        "The counter that explains a regression is captured in the same run as the timing."
      ],
      "crates": [
        "criterion",
        "divan",
        "hdrhistogram",
        "tokio-metrics"
      ],
      "github": [
        {
          "name": "criterion.rs - statistical benchmarking",
          "url": "https://github.com/criterion-rs/criterion.rs"
        },
        {
          "name": "hdrhistogram - recording latency distributions without averaging",
          "url": "https://github.com/HdrHistogram/HdrHistogram_rust"
        }
      ],
      "pitfall": "Benchmarking with the default debug profile: the numbers are five to fifty times slower, the optimizer removes nothing because nothing is optimized, and the conclusion you draw about lock contention is about a program nobody ships.",
      "resources": [
        {
          "title": "criterion: statistical benchmarking and throughput reporting",
          "url": "https://docs.rs/criterion/latest/criterion/",
          "kind": "docs"
        },
        {
          "title": "hdrhistogram: latency distributions for tail analysis",
          "url": "https://github.com/HdrHistogram/HdrHistogram_rust",
          "kind": "repo"
        },
        {
          "title": "tokio-metrics: worker busy duration and task polls",
          "url": "https://docs.rs/tokio-metrics/latest/tokio_metrics/",
          "kind": "docs"
        },
        {
          "title": "InfoQ: performance engineering and tail latency talks",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        }
      ]
    },
    {
      "id": "cp20",
      "n": 20,
      "title": "A concurrency design review you can run",
      "minutes": 90,
      "level": "industry",
      "goal": "Review concurrent code against a fixed checklist covering ownership, bounds, cancellation, blocking, ordering, verification, and observability, and reject designs that only work when nothing goes wrong.",
      "sections": [
        {
          "h": "Start with ownership, not with primitives",
          "p": [
            "The first question is who owns what and who waits for whom. Every spawned task needs an owner that awaits it or a scope that aborts it; every queue needs a producer that can be slowed; every lock needs a named invariant. If a reviewer cannot answer \"what happens to in-flight work when this returns an error\", the design is not finished.",
            "The second question is the shutdown path. Draw it: signal, stop accepting, drain with a deadline, abort the rest, flush, exit. Designs that skip this produce the two classic incidents - work lost on deploy and a process that will not exit because a detached task holds a socket."
          ],
          "tip": "Review the error path first. It is where concurrency bugs live and where the design is usually thinnest."
        },
        {
          "h": "The checklist",
          "p": [
            "These are the items that catch the expensive mistakes. Each is answerable from the diff, and each has a failure mode you have seen in this track: unbounded queues, guards across awaits, missed wakeups, blocking on workers, unordered locks, unverified unsafe, and no metrics for depth or wait time.",
            "Treat a missing answer as a finding, not a preference. \"We will add metrics later\" on a queue is how an OOM ships, and \"it is probably fine\" on an atomic ordering is how an ARM-only crash reaches production. The checklist is deliberately short: eight questions a reviewer can answer from the diff, each tied to a failure mode this track has already shown you."
          ],
          "list": [
            "Every task has an owner; shutdown drains with a deadline and reports what was abandoned",
            "Every queue is bounded and every rejection is counted with a reason",
            "No lock guard crosses an await; clippy::await_holding_lock is denied",
            "Locks are numbered and acquired in order; the rule lives next to the definitions",
            "Blocking work is on spawn_blocking or rayon with a concurrency cap",
            "Atomics beyond SeqCst carry a written ordering argument and a loom test",
            "Metrics: queue depth, in-flight count, lock wait, task poll time, shed count",
            "Backpressure reaches ingress, so overload becomes a fast rejection, not a growing backlog"
          ]
        },
        {
          "h": "Make the rules mechanical",
          "p": [
            "A review checklist that depends on memory decays. Encode what can be encoded: deny the clippy lints that catch guards across awaits, forbid blocking imports in async modules with a lint or a grep in CI, run loom separately, and fail the build on a benchmark regression. What remains is judgement, and judgement is better spent on design than on remembering rules.",
            "The decision table for primitives is short enough to memorise. Independent work with a slow consumer: bounded channel. Shared invariant with short critical section: mutex. Per-key state: sharding or an actor. CPU-bound bulk data: rayon. Coordination across services: not concurrency, use a distributed system design instead."
          ],
          "code": "# Cargo.toml - rules that fail the build instead of a review\n\n[lints.rust]\nunsafe_op_in_unsafe_fn = \"deny\"\n\n[lints.clippy]\nawait_holding_lock = \"deny\"\nawait_holding_refcell_ref = \"deny\"\nlet_underscore_future = \"deny\"   # dropping a JoinHandle silently\n\n# CI (separate jobs, not the default test run):\n#   cargo clippy --all-targets -- -D warnings\n#   RUSTFLAGS=\"--cfg loom\" cargo test --release --test loom_shared\n#   cargo bench --bench pipeline -- --save-baseline main\n\n# Review artefacts that must exist for any new concurrent subsystem:\n#   docs/concurrency/<subsystem>.md  - ownership, bounds, shutdown, metrics\n#   tests/loom_<subsystem>.rs        - models for unsafe shared state\n#   benches/<subsystem>.rs           - throughput at 70% and 100% saturation"
        }
      ],
      "exercise": {
        "prompt": "Review this design and list every finding with its failure mode: an HTTP handler spawns a detached task per request, sends jobs into an unbounded channel, a single worker writes to the database with a std Mutex held across an await, and shutdown relies on process exit.",
        "starter": "// Design under review (do not fix the code, enumerate the findings)\nasync fn handler(req: Request) -> Response {\n    tokio::spawn(async move { process(req).await });   // A\n    Response::ok()\n}\n\nfn pipeline() -> (Sender<Job>, JoinHandle<()>) {\n    let (tx, mut rx) = unbounded();                    // B\n    let handle = tokio::spawn(async move {\n        while let Some(job) = rx.recv().await {\n            let guard = STATE.lock().unwrap();         // C\n            db.write(&job).await;                      // D\n            drop(guard);\n        }\n    });\n    (tx, handle)\n}",
        "hint": "Four findings minimum: no owner for the detached task, no bound so memory grows, no cancellation or drain, a guard held across an await. Add the missing metrics and the missing backpressure to ingress, and note the response is returned before any work is durable.",
        "solution": "Findings, each with the failure mode it causes:\n\nA. tokio::spawn with the JoinHandle discarded\n   - No owner: the task outlives the request and the response.\n   - The client gets 200 before the work is durable; a crash loses it silently.\n   - A panic is stored in a handle nobody reads, so failures are invisible.\n   Fix: submit into a bounded queue owned by a supervisor, or await a JoinSet.\n\nB. Unbounded channel\n   - Memory grows at the arrival rate whenever the writer is slower.\n   - No signal that the writer is saturated; latency climbs to minutes.\n   Fix: bounded(cap) with an explicit policy (await send or try_send + counter)\n   and export depth.\n\nC. std::sync::Mutex held across .await\n   - The guard is !Send, so the future is !Send; on a multi-thread runtime this\n     either fails to compile in spawn or serializes every waiter behind the DB call.\n   Fix: lock, copy what you need, drop the guard, then await; or a tokio Mutex if\n   the invariant truly requires it, accepting the serialization.\n\nD. No cancellation and no drain\n   - Deploy = work lost mid-write; the process may not exit while the task lives.\n   Fix: one CancellationToken, stop accepting, drain with a deadline, then abort.\n\nE. No observability or limits\n   - No queue depth, in-flight count, shed count, or per-item latency.\n   - No bound on concurrent database writes, so the pool is the real limit and\n     it is discovered in an incident.\n   Fix: export depth and shed counts, cap concurrency with a Semaphore sized to\n   the pool, and alert on depth before it saturates.\n\nOrder of work: A and B first (data loss and memory), then C (throughput and\ncorrectness under load), then D (operator safety), then E (so the next\nregression is visible)."
      },
      "questions": [
        {
          "q": "A review finds a detached tokio::spawn whose handle is dropped, returning 200 immediately. What is the most serious consequence?",
          "options": [
            "The task uses more memory than necessary",
            "Work can be lost silently, and failures never reach the caller or the logs",
            "The runtime refuses to shut down",
            "The task runs on the wrong worker thread"
          ],
          "answer": 1,
          "explain": "The response claims success before durability, and the panic or error ends up in a handle nobody reads. Data loss plus invisible failure is worse than a slow request."
        },
        {
          "q": "Which item belongs in a concurrency review but cannot be enforced by clippy?",
          "options": [
            "No guard held across an await",
            "Every queue has a bound derived from a measured drain rate",
            "No unused future dropped",
            "No unsafe block without a safety comment"
          ],
          "answer": 1,
          "explain": "Lints catch guards across awaits, dropped futures, and missing safety comments. Queue sizing depends on measured load and a latency budget, so it stays a judgement call recorded in the design note."
        },
        {
          "q": "Which primitive fits \"independent CPU-bound chunks of one large array\"?",
          "options": [
            "A bounded channel to a single worker",
            "rayon's parallel iterators over the array",
            "An actor with a mailbox",
            "A tokio Mutex around the array"
          ],
          "answer": 1,
          "explain": "The work is data-parallel, has no shared state to protect, and is CPU-bound - exactly rayon's model. Channels, actors, and locks all add coordination the problem does not need."
        }
      ],
      "quickbytes": [
        "Review the failure path first: ownership of in-flight work and the drain sequence expose the design.",
        "Encode what lints can catch, and reserve review attention for bounds, ordering arguments, and shutdown.",
        "A queue without a depth metric is an outage waiting for a slow consumer."
      ],
      "production": [
        "Every concurrent subsystem has a one-page note: ownership, bounds, shutdown, metrics, and failure policy.",
        "CI denies await_holding_lock, drops a failed loom job, and fails on benchmark regressions.",
        "An on-call runbook exists for queue saturation: what to shed, what to scale, what to drain.",
        "Design reviews reject unbounded queues, detached tasks, and unordered multi-lock acquisition."
      ],
      "crates": [
        "tokio",
        "tokio-util",
        "crossbeam",
        "rayon"
      ],
      "github": [
        {
          "name": "tokio - runtime, sync primitives, and task ownership",
          "url": "https://github.com/tokio-rs/tokio"
        },
        {
          "name": "crossbeam - bounded channels and lock-free queues for review criteria",
          "url": "https://github.com/crossbeam-rs/crossbeam"
        }
      ],
      "pitfall": "Approving a design because the happy path is correct: the review asks how many requests per second it handles, not what happens when the consumer dies, and the first slow consumer takes the process down with an allocation failure.",
      "resources": [
        {
          "title": "Rust Clippy lint index (await_holding_lock and friends)",
          "url": "https://clippy.rust-lang.org/master/index.html",
          "kind": "docs"
        },
        {
          "title": "The Rust Book: shared-state concurrency and Send/Sync",
          "url": "https://doc.rust-lang.org/book/ch16-00-concurrency.html",
          "kind": "docs"
        },
        {
          "title": "tokio::task::JoinSet: ownership and shutdown semantics",
          "url": "https://docs.rs/tokio/latest/tokio/task/struct.JoinSet.html",
          "kind": "docs"
        },
        {
          "title": "Strange Loop: architecture and production readiness talks",
          "url": "https://www.youtube.com/@StrangeLoopConf",
          "kind": "video"
        }
      ]
    }
  ]
};
