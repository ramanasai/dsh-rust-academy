/**
 * Process handling & workers track.
 *
 * Authored for the Rust Academy plugin. Every lesson is plain JSON-compatible
 * data consumed by src/app.js through build.mjs.
 */
export default {
  "key": "processes",
  "title": "Process handling & workers",
  "blurb": "Run long-lived workers and child processes in production: bounded concurrency, supervision, ordered shutdown, schedulers, IPC, and resource isolation.",
  "level": "industry",
  "project": {
    "title": "Capstone: the always-on job runner",
    "brief": "Build a single service that owns a bounded worker pool, supervises its tasks, executes external commands with timeouts and resource caps, exposes readiness, runs a leader-safe scheduler, and speaks a framed protocol over a Unix socket. Everything must survive a rolling deploy without dropping work.",
    "deliverables": [
      "A worker pool with a bounded queue, drain deadline, and pool/queue metrics",
      "Supervision with restart limits, panic isolation, and cooperative cancellation",
      "A scheduler that is correct with two replicas and records missed runs",
      "Child processes with timeouts, process-group kills, and rlimit caps",
      "A length-delimited Unix-socket endpoint with backpressure and half-close"
    ],
    "stack": [
      "tokio",
      "tokio-util",
      "apalis",
      "tokio-cron-scheduler",
      "sqlx",
      "nix",
      "rlimit",
      "bytes",
      "futures",
      "tracing",
      "anyhow",
      "serde"
    ]
  },
  "lessons": [
    {
      "id": "p01",
      "title": "Worker pools & bounded concurrency",
      "minutes": 60,
      "level": "core",
      "goal": "Bound concurrent work and queue depth, propagate backpressure to producers, and drain in-flight jobs under a deadline.",
      "sections": [
        {
          "h": "Concurrency is a permit, not a thread",
          "p": [
            "An unbounded tokio::spawn loop is not a worker pool. Every accepted job becomes a task immediately, so memory grows with arrival rate and the runtime's queues grow without limit. A pool fixes two numbers up front: how many jobs may run at once, and how many may wait.",
            "Semaphore::acquire_owned hands you a permit that can cross a task boundary, because you moved an Arc<Semaphore> clone instead of borrowing it. The permit returns to the semaphore when it drops, including when the task panics or is aborted, so a failed job cannot leak capacity."
          ],
          "code": "use std::sync::Arc;\nuse tokio::sync::Semaphore;\nuse tokio::task::JoinSet;\n\n// Every snippet in this lesson works with this job type.\ntype Job = u64;\nasync fn run_job(_job: Job) {}\n\npub struct Pool {\n    permits: Arc<Semaphore>,\n    jobs: JoinSet<()>,\n}\n\nimpl Pool {\n    pub fn new(max_concurrent: usize) -> Self {\n        Self {\n            permits: Arc::new(Semaphore::new(max_concurrent)),\n            jobs: JoinSet::new(),\n        }\n    }\n\n    pub async fn spawn<F>(&mut self, job: F) -> Result<(), tokio::sync::AcquireError>\n    where\n        F: std::future::Future<Output = ()> + Send + 'static,\n    {\n        // Wait for capacity *before* accepting more work: this is backpressure.\n        let permit = self.permits.clone().acquire_owned().await?;\n        self.jobs.spawn(async move {\n            let _permit = permit; // released when the task ends, panic included\n            job.await;\n        });\n        Ok(())\n    }\n}",
          "tip": "Keep the JoinSet inside the pool. Dropping a JoinSet aborts every task in it, so an accidental early drop is a mass cancellation, not a tidy cleanup."
        },
        {
          "h": "A bounded queue is the backpressure",
          "p": [
            "Permits limit running work; a bounded mpsc channel limits queued work. Sender::send awaits when the channel is full, which pushes the slowdown back to the producer instead of buffering it inside the runtime. If the producer reads from a socket, awaiting send stops reading and TCP flow control does the rest.",
            "Size the queue from a latency budget, not from available memory: queue depth divided by throughput is the worst-case wait before a job even starts. Export both depth and wait time, because a full queue is the first symptom of a slow dependency."
          ],
          "code": "use tokio::sync::mpsc;\n\nlet mut pool = Pool::new(4);           // at most 4 jobs run at once\nlet (tx, mut rx) = mpsc::channel::<Job>(64); // at most 64 queued jobs\n\n// Producer: parks here once 64 jobs are queued.\ntx.send(7).await.expect(\"receiver alive\");\n\n// Consumer: one admission loop feeds the pool.\nwhile let Some(job) = rx.recv().await {\n    pool.spawn(run_job(job)).await.expect(\"pool alive\");\n}",
          "list": [
            "send().await waits for capacity, which is the behaviour you want for durable work",
            "try_send() returns TrySendError::Full so a caller can shed load and answer 503",
            "rx.close() stops new sends but lets the receiver drain what is already buffered"
          ],
          "tip": "rx.recv() returning None means every sender was dropped. Treat it as the normal end-of-input path, not as an error to log at warn level."
        },
        {
          "h": "spawn_blocking has its own queue",
          "p": [
            "A semaphore caps how many jobs you admit, but tokio's blocking pool is a separate executor with its own thread count. Each running spawn_blocking call holds a thread; the pool grows on demand up to max_blocking_threads and then queues. Without a gate, CPU-heavy jobs turn into an invisible backlog and a shutdown that never finishes, because a blocking task cannot be aborted once it starts."
          ],
          "code": "use tokio::sync::Semaphore;\n\n// Static works because const_new is a const fn. 2x cores is a common start.\nstatic BLOCKING: Semaphore = Semaphore::const_new(8);\n\nasync fn file_size(path: std::path::PathBuf) -> std::io::Result<u64> {\n    let _permit = BLOCKING.acquire().await.expect(\"semaphore never closed\");\n    tokio::task::spawn_blocking(move || -> std::io::Result<u64> {\n        let bytes = std::fs::read(&path)?;\n        Ok(bytes.len() as u64)\n    })\n    .await\n    .expect(\"blocking task panicked\")\n}",
          "tip": "Blocking tasks cannot be cancelled once started, so runtime shutdown waits for them. Keep them short and bounded; use a dedicated std thread for work that runs forever."
        },
        {
          "h": "Draining is ordered, not hopeful",
          "p": [
            "A graceful drain has a fixed order: stop admitting (close the queue), finish queued work, wait for running jobs, and only then drop shared resources such as the database pool. Drop the pool first and in-flight jobs fail while shutting down, which turns a clean deploy into a partial write.",
            "A deadline is mandatory. Some job is always stuck; without a timeout the process never exits and the orchestrator sends SIGKILL, which is exactly the failure the drain was meant to prevent."
          ],
          "code": "use tokio::time::{timeout, Duration};\n\npub async fn drain(\n    mut pool: Pool,\n    mut rx: mpsc::Receiver<Job>,\n    budget: Duration,\n) -> Result<usize, &'static str> {\n    rx.close();                              // 1. refuse new work\n    while let Some(job) = rx.recv().await {  // 2. run what is already queued\n        pool.spawn(run_job(job)).await.map_err(|_| \"pool closed\")?;\n    }\n    let mut completed = 0usize;\n    let wait_all = async {\n        while pool.jobs.join_next().await.is_some() {\n            completed += 1;\n        }\n        completed\n    };\n    // 3. give running jobs a bounded amount of time\n    timeout(budget, wait_all).await.map_err(|_| \"drain deadline exceeded\")\n}",
          "list": [
            "Admission closes first; otherwise new work keeps arriving during the drain",
            "The deadline is shorter than the platform grace period, with slack for the final flush",
            "Resources are released after the join, never before it"
          ],
          "tip": "Log the number of jobs still running when the deadline fires. That count is the difference between a clean stop and a silent work loss."
        }
      ],
      "exercise": {
        "prompt": "Implement submit, which must never block and must distinguish a full queue from a closed one, and drain, which closes the receiver, runs every queued job, and joins running jobs under a deadline.",
        "starter": "use tokio::sync::mpsc;\nuse tokio::task::JoinSet;\nuse tokio::time::{timeout, Duration};\n\npub enum SubmitError {\n    Full(u64),\n    Closed(u64),\n}\n\n// TODO 1: never await here; map TrySendError into SubmitError.\npub fn submit(tx: &mpsc::Sender<u64>, job: u64) -> Result<(), SubmitError> {\n    tx.try_send(job).map_err(|_| SubmitError::Closed(job))\n}\n\n// TODO 2: close rx, run each queued job through the set, then join the set\n// under the budget. Return the number of jobs handled.\npub async fn drain(\n    mut rx: mpsc::Receiver<u64>,\n    set: &mut JoinSet<()>,\n    budget: Duration,\n) -> Result<u64, &'static str> {\n    let _ = timeout(budget, async {}).await;\n    Err(\"not implemented\")\n}\n\nasync fn process(job: u64) {\n    tokio::time::sleep(Duration::from_millis(5)).await;\n    let _ = job;\n}",
        "hint": "mpsc::error::TrySendError has Full(value) and Closed(value) variants. In drain, rx.close() first, then recv until None, then join_next until None, all inside one async block passed to timeout.",
        "solution": "use tokio::sync::mpsc;\nuse tokio::task::JoinSet;\nuse tokio::time::{timeout, Duration};\n\npub enum SubmitError {\n    Full(u64),\n    Closed(u64),\n}\n\npub fn submit(tx: &mpsc::Sender<u64>, job: u64) -> Result<(), SubmitError> {\n    tx.try_send(job).map_err(|err| match err {\n        mpsc::error::TrySendError::Full(job) => SubmitError::Full(job),\n        mpsc::error::TrySendError::Closed(job) => SubmitError::Closed(job),\n    })\n}\n\npub async fn drain(\n    mut rx: mpsc::Receiver<u64>,\n    set: &mut JoinSet<()>,\n    budget: Duration,\n) -> Result<u64, &'static str> {\n    rx.close(); // no new sends; already-buffered messages are still readable\n    let work = async {\n        let mut done = 0u64;\n        while let Some(job) = rx.recv().await {\n            set.spawn(async move { process(job).await });\n            done += 1;\n        }\n        while set.join_next().await.is_some() {\n            done += 1;\n        }\n        done\n    };\n    timeout(budget, work)\n        .await\n        .map_err(|_| \"drain deadline exceeded\")\n}\n\nasync fn process(job: u64) {\n    tokio::time::sleep(Duration::from_millis(5)).await;\n    let _ = job;\n}"
      },
      "production": [
        "Pool size and queue capacity are configuration, logged at startup and exported as gauges.",
        "Every admission path has a deadline; a full queue returns a typed error instead of hanging.",
        "spawn_blocking calls are gated by their own semaphore and fit inside the drain budget.",
        "Shutdown closes admission, joins with a timeout, then closes pools and flushes telemetry.",
        "A load test at twice the pool size proves queue depth stays bounded and latency degrades linearly."
      ],
      "crates": [
        "tokio",
        "tokio-util",
        "tracing"
      ],
      "pitfall": "An unbounded queue with one tokio::spawn per job looks fine in staging, then OOMs in production when the downstream slows: every queued job keeps its input alive while the producer keeps accepting.",
      "questions": [
        {
          "q": "A pool holds 4 permits and a bounded queue of 64 jobs. The producer has already queued 64 jobs and sends the 65th with send().await. What happens?",
          "options": [
            "The job is dropped and an error is returned to the producer",
            "send() parks the producer until a queued job is admitted and a slot frees",
            "Tokio spawns an extra blocking thread so the job runs immediately"
          ],
          "answer": 1,
          "explain": "Sender::send awaits capacity, which is how backpressure reaches the producer. try_send is the non-blocking variant that returns TrySendError::Full so the caller can shed load."
        },
        {
          "q": "Why bound the queue between producers and workers?",
          "options": [
            "It makes the queue faster by using less memory",
            "An unbounded queue turns overload into unbounded memory growth and latency",
            "Bounded queues remove the need for backpressure",
            "It guarantees jobs run exactly once"
          ],
          "answer": 1,
          "explain": "Unbounded queues hide overload until memory or latency collapses. A bounded queue makes producers wait or shed load, which is explicit backpressure."
        }
      ],
      "resources": [
        {
          "title": "tokio::sync::Semaphore API and examples",
          "url": "https://docs.rs/tokio/latest/tokio/sync/struct.Semaphore.html",
          "kind": "docs"
        },
        {
          "title": "tokio::task::spawn_blocking semantics and limits",
          "url": "https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html",
          "kind": "docs"
        },
        {
          "title": "Bridging async code and blocking code",
          "url": "https://tokio.rs/tokio/topics/bridging",
          "kind": "docs"
        }
      ],
      "quickbytes": [
        "Size the pool to the downstream concurrency limit, not just CPU cores.",
        "Use tokio::sync::Semaphore or a bounded channel to apply backpressure."
      ],
      "github": [
        {
          "name": "tokio-rs/tokio",
          "url": "https://github.com/tokio-rs/tokio"
        },
        {
          "name": "tokio-rs/tokio-util",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ]
    },
    {
      "id": "p02",
      "title": "Task supervision & cancellation",
      "minutes": 65,
      "level": "advanced",
      "goal": "Own every spawned task: observe panics through JoinSet, cancel cooperatively with tokens, and restart with limits instead of in a loop.",
      "sections": [
        {
          "h": "JoinSet is the owner",
          "p": [
            "JoinSet both spawns tasks and reports their completion with the panic payload intact. Spawn into it, await join_next to learn which task finished, and treat the JoinError as data: is_panic() tells you it panicked, is_cancelled() that it was aborted, and into_panic() hands you the payload for logging.",
            "The set does not own the runtime; it owns membership. Dropping a JoinSet aborts every member immediately, which is a mass kill with no chance to flush. join_next is cancel safe, so it can sit in a select! next to a cancellation token, and one set per subsystem keeps the blast radius small."
          ],
          "code": "use tokio::task::JoinSet;\n\nlet mut set: JoinSet<&'static str> = JoinSet::new();\nset.spawn(async { \"worker-a\" });\nset.spawn(async { \"worker-b\" });\n\nwhile let Some(result) = set.join_next().await {\n    match result {\n        Ok(name) => tracing::info!(task = name, \"exited cleanly\"),\n        Err(err) if err.is_panic() => {\n            let payload = err.into_panic();\n            tracing::error!(?payload, \"task panicked\");\n        }\n        Err(err) => tracing::warn!(?err, \"task aborted\"),\n    }\n}",
          "tip": "A panicking task does not poison the runtime; it returns JoinError. Catch it, classify it, and decide consciously whether the task should be restarted."
        },
        {
          "h": "Cancellation is cooperative",
          "p": [
            "A CancellationToken is a broadcast flag, not a kill. Tasks must poll it, so every long loop needs a cancellation point: select! on token.cancelled() at the top of each iteration, and around any await that can take a while. Dropping a future is the only forceful option, and it is unsafe halfway through a write, because the write may be half-applied.",
            "child_token() creates a subtree whose cancellation follows the parent but cannot cancel its siblings. cancel() wakes all waiters, is_cancelled() is a cheap check for cleanup paths, and drop_guard() cancels on scope exit, which is how a forgotten error path still shuts down."
          ],
          "code": "use std::time::Duration;\nuse tokio_util::sync::CancellationToken;\n\nlet root = CancellationToken::new();\nlet worker = root.child_token();\n\nlet handle = tokio::spawn(async move {\n    loop {\n        tokio::select! {\n            _ = worker.cancelled() => break,\n            _ = tokio::time::sleep(Duration::from_secs(1)) => {\n                // one unit of work\n            }\n        }\n    }\n    // cleanup runs before exit: flush, ack, release the lease.\n});\n\nroot.cancel();\nhandle.await.expect(\"worker task\");",
          "tip": "Cancellation is not a failure. If a task reports cancellation and your supervisor restarts it, shutdown turns into a restart storm."
        },
        {
          "h": "Panic isolation and restart policy",
          "p": [
            "A supervisor restarts on failure, but a restart loop without limits is a fork bomb with better manners. Bound it: max attempts per window, exponential backoff with jitter, and a terminal state that surfaces as an alert. Distinguish permanent failures (bad configuration) from transient ones (a timeout on a peer).",
            "Hold cancellation authority outside the supervised task. If the task owns the token that stops it, a panic drops the token and nothing can stop the replacement cleanly."
          ],
          "code": "use std::time::Duration;\nuse tokio_util::sync::CancellationToken;\n\npub async fn supervise<F, Fut>(mut make_task: F, token: CancellationToken)\nwhere\n    F: FnMut() -> Fut,\n    Fut: std::future::Future<Output = Result<(), String>> + Send + 'static,\n{\n    let mut attempt = 0u32;\n    loop {\n        let mut handle = tokio::spawn(make_task());\n        tokio::select! {\n            _ = token.cancelled() => {\n                handle.abort();\n                return;\n            }\n            result = &mut handle => match result {\n                Ok(Ok(())) => return,\n                Ok(Err(err)) => tracing::warn!(%err, \"task failed\"),\n                Err(join_err) => tracing::warn!(?join_err, \"task died\"),\n            },\n        }\n        attempt += 1;\n        if attempt >= 5 {\n            tracing::error!(attempt, \"supervisor giving up\");\n            return;\n        }\n        let backoff = Duration::from_millis(100u64 << attempt); // add jitter in production\n        tokio::time::sleep(backoff).await;\n    }\n}",
          "tip": "Classify cancellation before failure. If the token is already cancelled, return instead of counting an attempt and sleeping through the shutdown budget."
        },
        {
          "h": "Who owns the task?",
          "p": [
            "Every spawned task needs an owner that outlives it and a policy for its result. Fire-and-forget tokio::spawn with a discarded JoinHandle is a leak with extra steps: nothing observes failure, nothing awaits exit, and shutdown has no way to know the task is still running.",
            "The rule that keeps this tractable: the component that creates a task owns its JoinSet and its token subtree; the task owns only its inputs. Abort handles supervise tasks; a Drop impl that aborts is the last line of defence, not the design."
          ],
          "list": [
            "Store JoinHandles or a JoinSet in the owner, never in the task's own state",
            "Log every exit path with a task name and elapsed time",
            "On abort, allow one yield point for cleanup, or document what state is dropped",
            "Never hold a std Mutex guard across an await inside a supervised task"
          ],
          "tip": "If a task must outlive the request that spawned it, it needs a name, a token, and a place in the owner's set. Otherwise it will be found later as an orphan in a profile."
        }
      ],
      "exercise": {
        "prompt": "Implement supervise_once: spawn a fallible job, race it against a cancellation token, and classify the outcome. A completed job is Done, a panicking job is Panic, and a cancelled wait is Cancelled, after aborting and reaping the task.",
        "starter": "use tokio_util::sync::CancellationToken;\n\n#[derive(Debug, PartialEq)]\npub enum Outcome {\n    Done,\n    Panic,\n    Cancelled,\n}\n\n// TODO: spawn the job, select on token.cancelled() vs the join handle,\n// abort and await on cancellation, classify JoinError::is_panic().\npub async fn supervise_once<F>(job: F, token: CancellationToken) -> Outcome\nwhere\n    F: std::future::Future<Output = ()> + Send + 'static,\n{\n    let _ = token;\n    todo!()\n}",
        "hint": "Use `let mut handle = tokio::spawn(job);` then select! on `token.cancelled()` and `&mut handle`. After an abort, await the handle once so the task is reaped, and return Cancelled.",
        "solution": "use tokio_util::sync::CancellationToken;\n\n#[derive(Debug, PartialEq)]\npub enum Outcome {\n    Done,\n    Panic,\n    Cancelled,\n}\n\npub async fn supervise_once<F>(job: F, token: CancellationToken) -> Outcome\nwhere\n    F: std::future::Future<Output = ()> + Send + 'static,\n{\n    let mut handle = tokio::spawn(job);\n    tokio::select! {\n        _ = token.cancelled() => {\n            handle.abort();\n            let _ = handle.await; // reap: nothing is left running\n            Outcome::Cancelled\n        }\n        result = &mut handle => match result {\n            Ok(()) => Outcome::Done,\n            Err(err) if err.is_panic() => Outcome::Panic,\n            Err(_aborted) => Outcome::Cancelled,\n        },\n    }\n}"
      },
      "production": [
        "Each subsystem has one owner struct holding its JoinSet and its child token.",
        "JoinError is logged with is_panic and the payload, never silently ignored.",
        "Restart policy has an attempt cap, backoff with an upper bound, and a terminal alert.",
        "Cancellation is checked before restart, so shutdown cannot start a new task."
      ],
      "crates": [
        "tokio",
        "tokio-util",
        "tracing"
      ],
      "pitfall": "Restarting on any JoinError makes shutdown a restart loop: an aborted task returns a JoinError with is_cancelled() true, the supervisor respawns it, and the drain never reaches zero tasks.",
      "questions": [
        {
          "q": "A supervised task aborts during shutdown and join_next yields a JoinError. What should the supervisor do before restarting it?",
          "options": [
            "Restart, because every JoinError is a transient failure",
            "Check the cancellation token and treat is_cancelled() as a stop signal, not a failure",
            "Ignore JoinError values and only restart on Ok(Err(_))"
          ],
          "answer": 1,
          "explain": "Cancellation must win over failure classification. Restarting an aborted task turns shutdown into a restart storm and the drain never reaches zero tasks."
        },
        {
          "q": "What does a CancellationToken guarantee for child tasks?",
          "options": [
            "It aborts them immediately, even mid-syscall",
            "It signals cancellation; tasks must poll it or be dropped at an await point",
            "It restarts tasks after cancellation",
            "It only works with spawn_blocking"
          ],
          "answer": 1,
          "explain": "Cancellation is cooperative: tasks observe the token or get cancelled when their future is dropped at an await point. Blocking code must be interrupted explicitly."
        }
      ],
      "resources": [
        {
          "title": "tokio::task::JoinSet API",
          "url": "https://docs.rs/tokio/latest/tokio/task/struct.JoinSet.html",
          "kind": "docs"
        },
        {
          "title": "tokio_util::sync::CancellationToken",
          "url": "https://docs.rs/tokio-util/latest/tokio_util/sync/struct.CancellationToken.html",
          "kind": "docs"
        },
        {
          "title": "Tokio: graceful shutdown patterns",
          "url": "https://tokio.rs/tokio/topics/shutdown",
          "kind": "docs"
        }
      ],
      "quickbytes": [
        "JoinSet aborts dropped tasks; keep the handle alive until you intend cancellation.",
        "Use TaskTracker to wait for all children during shutdown."
      ],
      "github": [
        {
          "name": "tokio-rs/tokio",
          "url": "https://github.com/tokio-rs/tokio"
        },
        {
          "name": "tokio-rs/tokio-util",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ]
    },
    {
      "id": "p03",
      "title": "Subprocess handling",
      "minutes": 75,
      "level": "advanced",
      "goal": "Spawn external commands safely: stream both pipes, enforce timeouts, kill the whole process group, and always reap the child.",
      "sections": [
        {
          "h": "Command is async; the OS is not",
          "p": [
            "tokio::process::Command mirrors std::process::Command but returns futures for spawn, status, and output. spawn() still forks synchronously; wait() polls a signal-driven reaper. The default is inherited stdio, which surprises people: run a child from a service and its output goes wherever the service's file descriptors point, not into your logs.",
            "Set Stdio::piped() when you want to observe output, and set kill_on_drop(true) as a safety net for the path where your code panics. The runtime reaps such children on a best-effort basis only, so a supervised service should still await wait() itself."
          ],
          "code": "use std::process::Stdio;\nuse tokio::process::Command;\n\nlet mut cmd = Command::new(\"ffmpeg\");\ncmd.arg(\"-i\")\n    .arg(\"input.mp4\")\n    .arg(\"-f\")\n    .arg(\"null\")\n    .arg(\"-\")\n    .stdout(Stdio::piped())\n    .stderr(Stdio::piped())\n    .kill_on_drop(true); // last resort; still await wait() yourself\n\nlet child = cmd.spawn().expect(\"spawn failed: missing binary or EPERM\");",
          "tip": "Never build a command by interpolating user input into sh -c. Pass argv directly; if you truly need a shell, quote and validate every argument first."
        },
        {
          "h": "Stream without deadlocking",
          "p": [
            "Two pipes and one reader is a deadlock: the child fills stderr while you read stdout, it blocks on write, you block on read, and the job hangs until the timeout fires. Read both piped streams concurrently, or use wait_with_output(), which drains both but buffers everything in memory.",
            "For long-running children, stream line by line into a bounded channel so the processor applies backpressure. Cap line length while you do it: BufReader::lines has no bound, so a child that never emits a newline grows the parent's heap."
          ],
          "code": "use tokio::io::{AsyncBufReadExt, BufReader};\nuse tokio::process::Command;\n\nlet mut child = Command::new(\"cargo\")\n    .arg(\"test\")\n    .stdout(std::process::Stdio::piped())\n    .stderr(std::process::Stdio::piped())\n    .spawn()\n    .expect(\"cargo available\");\n\nlet stdout = child.stdout.take().expect(\"stdout piped\");\nlet stderr = child.stderr.take().expect(\"stderr piped\");\n\nlet out_task = tokio::spawn(async move {\n    let mut lines = BufReader::new(stdout).lines();\n    while let Ok(Some(line)) = lines.next_line().await {\n        tracing::info!(stream = \"stdout\", %line);\n    }\n});\nlet err_task = tokio::spawn(async move {\n    let mut lines = BufReader::new(stderr).lines();\n    while let Ok(Some(line)) = lines.next_line().await {\n        tracing::warn!(stream = \"stderr\", %line);\n    }\n});\n\nlet status = child.wait().await.expect(\"child wait\");\nlet _ = tokio::join!(out_task, err_task);\ntracing::info!(?status);",
          "tip": "If you only read stdout, redirect stderr to null or merge it explicitly. A blocked pipe on the unread stream stalls the child, and the timeout blames the wrong component."
        },
        {
          "h": "Timeouts and process groups",
          "p": [
            "A timeout that drops wait() leaves the child running with your pipes open. Kill it and then wait to reap it. child.kill() signals only the direct child, so a wrapper script, a shell command, or a build tool that spawns linkers leaves grandchildren behind.",
            "Spawn the child into its own process group with process_group(0), so the child's pid is also its pgid, then signal the group with killpg. Capture id() before awaiting wait(), because after reaping it returns None."
          ],
          "code": "// inside: async fn run(cmd: &mut Command) -> std::io::Result<bool>\nuse std::time::Duration;\nuse tokio::time::timeout;\n\n#[cfg(unix)]\ncmd.process_group(0); // child becomes its own group leader: pgid == pid\n\nlet mut child = cmd.spawn()?;\nmatch timeout(Duration::from_secs(30), child.wait()).await {\n    Ok(status) => Ok(status?.success()),\n    Err(_elapsed) => {\n        #[cfg(unix)]\n        {\n            use nix::sys::signal::{killpg, Signal};\n            use nix::unistd::Pid;\n            if let Some(pid) = child.id() {\n                // ESRCH means it died between the timeout and the kill; ignore it.\n                let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGKILL);\n            }\n        }\n        #[cfg(not(unix))]\n        child.kill().await?;\n\n        let _status = child.wait().await?; // reap: never leave a zombie\n        Ok(false)\n    }\n}",
          "tip": "SIGKILL to a process group is not graceful. Send SIGTERM to the group first when the child can flush, then SIGKILL after a short grace window."
        },
        {
          "h": "Zombies and kill_on_drop",
          "p": [
            "On Unix an exited child that has not been waited for is a zombie: it holds a pid and a process-table slot, and enough of them make fork fail. The tokio runtime reaps its own children on a best-effort basis, so the only guarantee you fully control is awaiting wait() exactly once per child.",
            "try_wait() is the non-blocking probe for supervisor loops. SignalKind::child() exists if you insist on SIGCHLD-driven reaping, but in a service every spawn site should have exactly one waiter, which makes the signal unnecessary."
          ],
          "list": [
            "Exactly one task awaits each Child; a second wait returns an error or None",
            "Use try_wait() in a select! loop when you need periodic liveness checks",
            "kill_on_drop cannot await the reap, so it is a safety net and not a cleanup strategy",
            "After a timeout: kill the group, await wait(), then log the exit status and duration"
          ],
          "tip": "Capture child.id() before awaiting wait() if the pid is part of your logs or metrics. It is None once the child has been reaped."
        }
      ],
      "exercise": {
        "prompt": "Implement run_bounded(cmd, limit): spawn the command in its own process group, drain stdout and stderr concurrently, and kill the whole group if it exceeds the limit. Return a timed-out outcome only after the child has been reaped.",
        "starter": "use std::process::Stdio;\nuse std::time::Duration;\nuse tokio::process::Command;\n\npub enum Outcome {\n    Exited(i32),\n    TimedOut,\n    Signalled,\n}\n\n// TODO: set piped stdio and kill_on_drop, call process_group(0) on unix,\n// drain both pipes in a spawned task, timeout child.wait(), then killpg\n// and await wait() on the timeout path.\npub async fn run_bounded(_cmd: Command, _limit: Duration) -> Outcome {\n    todo!()\n}",
        "hint": "Take stdout and stderr out of the child, move them into a spawned task using AsyncReadExt::read_to_end for both, and start that task before awaiting wait(). On timeout, killpg(Pid::from_raw(pid as i32), Signal::SIGKILL), then await child.wait() so the pid is released.",
        "solution": "use std::process::Stdio;\nuse std::time::Duration;\nuse tokio::io::AsyncReadExt;\nuse tokio::process::Command;\nuse tokio::time::timeout;\n\npub enum Outcome {\n    Exited(i32),\n    TimedOut,\n    Signalled,\n}\n\npub async fn run_bounded(mut cmd: Command, limit: Duration) -> Outcome {\n    cmd.stdout(Stdio::piped())\n        .stderr(Stdio::piped())\n        .kill_on_drop(true);\n    #[cfg(unix)]\n    cmd.process_group(0);\n\n    let mut child = match cmd.spawn() {\n        Ok(child) => child,\n        Err(_) => return Outcome::Exited(-1),\n    };\n\n    let mut stdout = child.stdout.take().expect(\"stdout piped\");\n    let mut stderr = child.stderr.take().expect(\"stderr piped\");\n    // Start draining immediately: a full pipe would block the child.\n    let drain = tokio::spawn(async move {\n        let mut out = Vec::new();\n        let mut err = Vec::new();\n        let _ = tokio::join!(\n            stdout.read_to_end(&mut out),\n            stderr.read_to_end(&mut err),\n        );\n        (out, err)\n    });\n\n    match timeout(limit, child.wait()).await {\n        Ok(status) => {\n            let _ = drain.await;\n            let code = status.ok().and_then(|s| s.code()).unwrap_or(-1);\n            Outcome::Exited(code)\n        }\n        Err(_elapsed) => {\n            #[cfg(unix)]\n            {\n                use nix::sys::signal::{killpg, Signal};\n                use nix::unistd::Pid;\n                if let Some(pid) = child.id() {\n                    let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGKILL);\n                }\n            }\n            #[cfg(not(unix))]\n            {\n                let _ = child.kill().await;\n            }\n            let _ = child.wait().await; // reap the killed child\n            let _ = drain.await;\n            Outcome::TimedOut\n        }\n    }\n}"
      },
      "production": [
        "Every spawn site sets stdio explicitly; inherited output hides failures inside a service.",
        "Timeouts are mandatory and always followed by a group kill plus wait().",
        "The child's argv, pid, exit code, and duration are logged on every path.",
        "Integration tests cover a sleeping child, one ignoring SIGTERM, and one flooding stderr.",
        "No shell interpolation: argv is passed directly, and sh -c requires a documented reason."
      ],
      "crates": [
        "tokio",
        "nix",
        "tracing"
      ],
      "pitfall": "Dropping the wait() future on timeout does not stop the child, and dropping Child without kill_on_drop leaves it running with your pipes; the next deploy finds an orphan holding the port.",
      "questions": [
        {
          "q": "You set stdout and stderr to Stdio::piped() and then await child.wait() without reading either pipe. What is the risk?",
          "options": [
            "Nothing, the runtime drains pipes automatically",
            "The child can block on a full pipe while the parent waits for exit, deadlocking the job",
            "wait() returns an error when a pipe is unread"
          ],
          "answer": 1,
          "explain": "Pipe buffers are finite. Read both streams concurrently or use wait_with_output(), which drains both but buffers everything in memory."
        },
        {
          "q": "Why kill the whole process group instead of just the child?",
          "options": [
            "It is faster than killing one process",
            "Grandchildren forked by the child survive a single kill and become orphans",
            "Killing one process leaves its stdout pipe open",
            "Rust cannot kill a single process"
          ],
          "answer": 1,
          "explain": "The child may have spawned its own children. Killing only the direct child leaves them running as orphans; use process groups (killpg) and expect to reap them."
        }
      ],
      "resources": [
        {
          "title": "tokio::process module documentation",
          "url": "https://docs.rs/tokio/latest/tokio/process/index.html",
          "kind": "docs"
        },
        {
          "title": "tokio::process::Command API",
          "url": "https://docs.rs/tokio/latest/tokio/process/struct.Command.html",
          "kind": "docs"
        },
        {
          "title": "tokio::process::Child API",
          "url": "https://docs.rs/tokio/latest/tokio/process/struct.Child.html",
          "kind": "docs"
        },
        {
          "title": "nix::sys::signal::killpg",
          "url": "https://docs.rs/nix/latest/nix/sys/signal/fn.killpg.html",
          "kind": "docs"
        }
      ],
      "quickbytes": [
        "Wrap child.wait() in tokio::time::timeout so a hung child cannot block shutdown.",
        "Stream stdout and stderr concurrently; draining one pipe sequentially can deadlock."
      ],
      "github": [
        {
          "name": "tokio-rs/tokio",
          "url": "https://github.com/tokio-rs/tokio"
        },
        {
          "name": "nix-rust/nix",
          "url": "https://github.com/nix-rust/nix"
        }
      ]
    },
    {
      "id": "p04",
      "title": "Signals & graceful shutdown",
      "minutes": 70,
      "level": "industry",
      "goal": "Turn SIGTERM and SIGINT into an ordered shutdown: fail readiness, stop admission, cancel, drain under a deadline, flush, then exit.",
      "sections": [
        {
          "h": "Two signals, two meanings",
          "p": [
            "SIGTERM asks a process to stop. SIGKILL cannot be caught and is what the kernel, the kubelet, or systemd sends when the grace period expires. SIGINT is the interactive ctrl-c. Handle both, and treat a second signal as an instruction to stop waiting, because an operator pressing ctrl-c twice expects the process to die now.",
            "tokio::signal::unix::signal(SignalKind::terminate()) yields a stream of that signal; signal::ctrl_c() is the cross-platform SIGINT convenience. Install the listener once, at startup, before the first worker. A handler installed after boot means a signal that arrives during startup terminates the process with no cleanup at all."
          ],
          "code": "use tokio::signal::unix::{signal, SignalKind};\n\npub async fn shutdown_signal() {\n    let mut term = signal(SignalKind::terminate()).expect(\"install SIGTERM handler\");\n    let mut int = signal(SignalKind::interrupt()).expect(\"install SIGINT handler\");\n    tokio::select! {\n        _ = term.recv() => tracing::info!(\"received SIGTERM\"),\n        _ = int.recv() => tracing::info!(\"received SIGINT\"),\n    }\n}",
          "tip": "Signal handlers are process-global. Install them once in main and pass a CancellationToken to subsystems; do not let each module install its own SIGTERM listener."
        },
        {
          "h": "Ordered shutdown, not a race",
          "p": [
            "First flip readiness to false, so the load balancer stops sending new requests while existing connections continue to be served. Then close the listener or admission queue so no new work is accepted. Then cancel the token so workers stop at their next checkpoint. Then wait for the tracker under a deadline. Finally flush telemetry, close pools, and return from main.",
            "Every step before the drain must be cheap and non-blocking. A shutdown path that awaits a remote call before cancelling workers gets killed by the orchestrator while jobs are still running. Telemetry flushes last, because every step before it wants to log."
          ],
          "code": "use std::sync::atomic::{AtomicBool, Ordering};\nuse std::sync::Arc;\nuse tokio::time::{timeout, Duration};\nuse tokio_util::sync::CancellationToken;\nuse tokio_util::task::TaskTracker;\n\npub async fn run() -> anyhow::Result<()> {\n    let listener = tokio::net::TcpListener::bind(\"0.0.0.0:8080\").await?;\n    let ready = Arc::new(AtomicBool::new(true)); // wired to the /readyz handler\n    let token = CancellationToken::new();\n    let tracker = TaskTracker::new();\n\n    // Spawn the accept loop and workers: each gets token.child_token()\n    // and registers itself with tracker.spawn(...).\n\n    shutdown_signal().await;\n    ready.store(false, Ordering::SeqCst); // 1. fail readiness\n    drop(listener);                       // 2. stop accepting\n    token.cancel();                       // 3. ask workers to stop\n    tracker.close();                      // 4. no new tasks are tracked\n    match timeout(Duration::from_secs(20), tracker.wait()).await {\n        Ok(()) => tracing::info!(\"all workers drained\"),\n        Err(_) => tracing::warn!(left = tracker.len(), \"drain deadline hit\"),\n    }\n    // 5. flush telemetry, close the pool, remove the socket or pid file.\n    Ok(())\n}",
          "list": [
            "Readiness flips before cancellation, never after it",
            "The listener is dropped before the drain so new connections are refused fast",
            "The tracker is closed so wait() can return when it empties",
            "Telemetry and pool shutdown happen only after the join completes"
          ],
          "tip": "TaskTracker::wait only returns when the tracker is both empty and closed. Forget close() and shutdown hangs with zero running tasks, which looks exactly like a deadlock."
        },
        {
          "h": "Readiness versus liveness",
          "p": [
            "Readiness answers whether this instance may receive traffic now, and it must flip false the moment shutdown starts, even while jobs drain. Liveness answers whether the process is wedged, and it should stay true during a normal drain; otherwise the orchestrator restarts you in the middle of it.",
            "Kubernetes makes the contract explicit: a preStop hook runs before termination, and terminationGracePeriodSeconds bounds the wait before SIGKILL, defaulting to 30 seconds. Make the drain deadline strictly smaller than the grace period, measured from SIGTERM, and leave headroom for the final flush."
          ],
          "list": [
            "Grace period 30s: drain deadline 20s, flush budget 5s, 5s of slack",
            "Liveness probes the process and its event loop, not downstream dependencies",
            "Readiness probes admission plus queue health, not just whether the port accepts",
            "Log the signal, the deadline, and the number of jobs still running at exit"
          ],
          "tip": "If the drain deadline equals the grace period, you have chosen to be SIGKILLed while flushing. Pick numbers that leave room for the flush you wrote."
        },
        {
          "h": "Deadlines and exit codes",
          "p": [
            "A drain without a deadline can hang forever on one stuck job. Wrap the wait in a timeout; on expiry, log the remaining count, abort the supervised set, and return an error so main can exit nonzero. Exit codes are part of the interface: 0 for a requested clean stop, nonzero for a drain that timed out.",
            "Do not call std::process::exit from a worker. Returning from main runs destructors and tracing guards, which is what actually flushes the last lines of the incident you are about to debug."
          ],
          "code": "// inside the top-level shutdown function, after tracker.close()\nuse tokio::time::{timeout, Duration};\n\nif timeout(budget, tracker.wait()).await.is_err() {\n    tracing::error!(remaining = tracker.len(), \"drain deadline exceeded\");\n    supervised.abort_all(); // only tasks owned by this set\n    anyhow::bail!(\"shutdown drain timed out\");\n}\ntracing::info!(\"shutdown complete\");\nOk(())",
          "tip": "A second SIGTERM should take a fast path: abort, log one line, exit nonzero. Waiting out the full drain after an explicit second signal is how deploys become five-minute timeouts."
        }
      ],
      "exercise": {
        "prompt": "Implement shutdown: flip readiness, cancel the token, close the tracker, and wait for it under a budget. Return a Drain reporting whether it finished cleanly and how many tasks were still running when the deadline expired.",
        "starter": "use std::sync::atomic::{AtomicBool, Ordering};\nuse std::sync::Arc;\nuse tokio::time::{timeout, Duration};\nuse tokio_util::sync::CancellationToken;\nuse tokio_util::task::TaskTracker;\n\n#[derive(Debug, PartialEq)]\npub struct Drain {\n    pub clean: bool,\n    pub abandoned: usize,\n}\n\n// TODO: readiness first, then cancel, then close, then bounded wait.\npub async fn shutdown(\n    ready: Arc<AtomicBool>,\n    token: CancellationToken,\n    tracker: TaskTracker,\n    budget: Duration,\n) -> Drain {\n    let _ = (ready, token, tracker, budget);\n    Drain { clean: false, abandoned: 0 }\n}",
        "hint": "Order matters: ready.store(false, Ordering::SeqCst), token.cancel(), tracker.close(), then timeout(budget, tracker.wait()). On Err, read tracker.len() for the abandoned count.",
        "solution": "use std::sync::atomic::{AtomicBool, Ordering};\nuse std::sync::Arc;\nuse tokio::time::{timeout, Duration};\nuse tokio_util::sync::CancellationToken;\nuse tokio_util::task::TaskTracker;\n\n#[derive(Debug, PartialEq)]\npub struct Drain {\n    pub clean: bool,\n    pub abandoned: usize,\n}\n\npub async fn shutdown(\n    ready: Arc<AtomicBool>,\n    token: CancellationToken,\n    tracker: TaskTracker,\n    budget: Duration,\n) -> Drain {\n    ready.store(false, Ordering::SeqCst); // 1. no new traffic\n    token.cancel();                       // 2. workers stop at checkpoints\n    tracker.close();                      // 3. wait() may now return when empty\n\n    match timeout(budget, tracker.wait()).await {\n        Ok(()) => Drain { clean: true, abandoned: 0 },\n        Err(_) => Drain { clean: false, abandoned: tracker.len() },\n    }\n}"
      },
      "production": [
        "A test races SIGTERM against a readiness probe and asserts the order of transitions.",
        "Drain deadline is at most two thirds of the platform grace period, read from config.",
        "A second signal aborts the drain, logs one line, and exits nonzero.",
        "Exit codes distinguish requested success (0) from drain timeout (1).",
        "Shutdown is idempotent: a signal during startup still runs the cleanup path."
      ],
      "crates": [
        "tokio",
        "tokio-util",
        "tracing",
        "anyhow"
      ],
      "pitfall": "Calling std::process::exit at the first SIGTERM skips destructors, so buffered logs and in-flight transactions disappear; the deploy looks clean while the evidence is lost.",
      "questions": [
        {
          "q": "A container has terminationGracePeriodSeconds: 30 and a 20-second drain budget. When should readiness flip to false?",
          "options": [
            "After all workers have finished draining",
            "At the start of shutdown, before cancelling workers or closing the listener",
            "Only after telemetry has been flushed"
          ],
          "answer": 1,
          "explain": "Readiness must fail first so the load balancer stops routing new requests while in-flight work drains. Liveness stays true during the drain so the orchestrator does not restart mid-drain."
        },
        {
          "q": "Why should readiness become false before termination begins?",
          "options": [
            "It is required by Rust",
            "Load balancers stop routing new requests while in-flight work drains",
            "It closes the listening socket immediately",
            "It forces the process to exit faster"
          ],
          "answer": 1,
          "explain": "Marking not-ready first removes the instance from rotation; then drain in-flight requests, then exit. Otherwise clients hit a closed socket during rollout."
        }
      ],
      "resources": [
        {
          "title": "tokio::signal module",
          "url": "https://docs.rs/tokio/latest/tokio/signal/index.html",
          "kind": "docs"
        },
        {
          "title": "tokio::signal::unix::SignalKind",
          "url": "https://docs.rs/tokio/latest/tokio/signal/unix/struct.SignalKind.html",
          "kind": "docs"
        },
        {
          "title": "Kubernetes pod lifecycle and termination",
          "url": "https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/",
          "kind": "docs"
        },
        {
          "title": "signal(7): Linux signal semantics",
          "url": "https://man7.org/linux/man-pages/man7/signal.7.html",
          "kind": "docs"
        }
      ],
      "quickbytes": [
        "Install handlers for SIGTERM and SIGINT; exit non-zero only on the second signal.",
        "Give shutdown a deadline with a timeout and abort remaining work after it."
      ],
      "github": [
        {
          "name": "tokio-rs/tokio",
          "url": "https://github.com/tokio-rs/tokio"
        },
        {
          "name": "tokio-rs/tokio-util",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ]
    },
    {
      "id": "p05",
      "title": "Schedulers & cron",
      "minutes": 65,
      "level": "advanced",
      "goal": "Schedule recurring work that is safe with several replicas, survives restarts, and states honestly whether it runs at most or at least once.",
      "sections": [
        {
          "h": "In-process cron is a timer, not a scheduler",
          "p": [
            "tokio-cron-scheduler runs jobs inside your process: JobScheduler::start() spawns a ticker, Job::new_async attaches an async handler, and shutdown() stops the ticker. That is exactly right for a cache warmer on a single replica, and wrong for anything that must run once across a fleet or survive a restart: there is no durable queue, no retry policy, and no record of the last successful run.",
            "Mind the schedule format. tokio-cron-scheduler takes a six-field expression with seconds first, so \"0 */5 * * * *\" is every five minutes at second zero. A five-field Unix cron string is a parse error here rather than a silently wrong schedule, so assert every expression at boot and let the deploy fail."
          ],
          "code": "use tokio_cron_scheduler::{Job, JobScheduler};\nuse tokio_util::sync::CancellationToken;\n\npub async fn run_cron(token: CancellationToken) -> anyhow::Result<()> {\n    let mut sched = JobScheduler::new().await?;\n    sched\n        .add(Job::new_async(\"0 */5 * * * *\", |_id, _sched| {\n            Box::pin(async move {\n                // A panic here kills this run silently: no Done notification fires.\n                if let Err(err) = tokio::task::spawn(housekeeping()).await {\n                    tracing::error!(?err, \"housekeeping task failed\");\n                }\n            })\n        })?)\n        .await?;\n    sched.start().await?; // spawns the tick loop\n    token.cancelled().await;\n    sched.shutdown().await?; // stops the ticker before the process exits\n    Ok(())\n}\n\nasync fn housekeeping() {\n    // real work goes here\n}",
          "tip": "Catch panics around each tick. The async job runs in its own spawned task, so a panic ends that run silently: no Done notification, no retry, no metric."
        },
        {
          "h": "Leader election with a lease",
          "p": [
            "Two replicas plus one cron tick equals two runs. Either make the work idempotent, which is preferred, or elect one leader. A Postgres session advisory lock is the cheapest lease: hold a dedicated connection, try pg_try_advisory_lock(key), and treat the connection's death as lost leadership, because the lock is session-scoped and disappears with it.",
            "Keep the lock on a connection you control, not on whatever the pool hands out. Returning a PoolConnection to the pool keeps its session alive, so the advisory lock stays held on a connection another task can now check out. Hold that connection for the process lifetime, or open a dedicated one outside the pool."
          ],
          "code": "use sqlx::pool::PoolConnection;\nuse sqlx::{PgPool, Postgres};\n\npub async fn try_lead(\n    pool: &PgPool,\n    key: i64,\n) -> sqlx::Result<Option<PoolConnection<Postgres>>> {\n    let mut conn = pool.acquire().await?;\n    let acquired: bool = sqlx::query_scalar(\"SELECT pg_try_advisory_lock($1)\")\n        .bind(key)\n        .fetch_one(&mut *conn)\n        .await?;\n    // The caller must keep this connection alive: dropping it returns the\n    // session to the pool while the advisory lock is still held.\n    Ok(if acquired { Some(conn) } else { None })\n}",
          "tip": "A leader that cannot renew must stop ticking immediately. Check the lock connection in the same loop that ticks, and prefer skipping a run to running it twice."
        },
        {
          "h": "Missed runs and your guarantee",
          "p": [
            "A cron expression says when a run is due, not what should happen after downtime. Decide explicitly: skip, which is at most once and allows gaps, or backfill every slot since last_success, which is at least once and allows duplicates. Backfill must be capped, because a week offline with a five-minute period is 2016 runs, which is an outage rather than a catch-up.",
            "Make the slot part of the data model: a run key of (job, slot_start) inserted with ON CONFLICT DO NOTHING. Enqueue only when the insert won. That single statement turns an unbounded duplicate problem into a bounded one and makes retries safe."
          ],
          "code": "pub fn slot_for(now_secs: i64, period_secs: i64) -> i64 {\n    assert!(period_secs > 0, \"period must be positive\");\n    now_secs - now_secs.rem_euclid(period_secs)\n}\n\npub async fn claim_slot(pool: &sqlx::PgPool, job: &str, slot: i64) -> sqlx::Result<bool> {\n    let inserted = sqlx::query(\n        \"INSERT INTO scheduled_runs (job, slot) VALUES ($1, $2) ON CONFLICT DO NOTHING\",\n    )\n    .bind(job)\n    .bind(slot)\n    .execute(pool)\n    .await?\n    .rows_affected();\n    if inserted == 1 {\n        sqlx::query(\"INSERT INTO jobs (kind, slot) VALUES ($1, $2)\")\n            .bind(job)\n            .bind(slot)\n            .execute(pool)\n            .await?;\n    }\n    Ok(inserted == 1)\n}",
          "tip": "The unique row is the idempotency token. Enqueue and claim in one transaction, or you can claim a slot and crash before the job is queued, which is a silent miss."
        },
        {
          "h": "Durable execution with apalis",
          "p": [
            "When work must not be lost, put a queue between the tick and the handler. apalis models workers over backends (in-memory, Postgres, Redis): a WorkerBuilder names the worker, attaches the backend and middleware such as concurrency and retries, and builds a task handler. The worker polls, claims, and acknowledges; retries, timeouts, and rate limits are layers rather than a hand-rolled loop.",
            "run_until(signal) turns shutdown into a graceful drain: the worker stops polling, finishes the in-flight task, and returns. The concurrency setting is the same permit budget from lesson 1, applied to a durable queue instead of an in-memory one."
          ],
          "code": "use apalis::prelude::*;\n\n// storage: MemoryStorage, apalis-redis, or apalis-postgres.\nlet worker = WorkerBuilder::new(\"email-worker\")\n    .backend(storage)\n    .concurrency(4)   // four tasks in flight, like four semaphore permits\n    .build(handle_email);\n\n// Stop polling on ctrl-c, finish the in-flight task, then return.\nworker\n    .run_until(async {\n        tokio::signal::ctrl_c().await.expect(\"signal handler\");\n        Ok::<(), WorkerError>(())\n    })\n    .await?;",
          "tip": "At-least-once delivery means handlers must be idempotent: the same task can be claimed twice after a crash between execution and acknowledgement."
        }
      ],
      "exercise": {
        "prompt": "Implement slot_for, which floors a timestamp to a fixed period, and claim_slot, which inserts an idempotency row with ON CONFLICT DO NOTHING and reports whether this replica owns the slot. Add a unit test for the flooring.",
        "starter": "pub fn slot_for(now_secs: i64, period_secs: i64) -> i64 {\n    // TODO: floor to the start of the current period\n    now_secs\n}\n\npub async fn claim_slot(\n    pool: &sqlx::PgPool,\n    job: &str,\n    slot: i64,\n) -> sqlx::Result<bool> {\n    // TODO: INSERT ... ON CONFLICT DO NOTHING, true only when this call inserted\n    let _ = (pool, job, slot);\n    Ok(false)\n}",
        "hint": "now_secs - now_secs.rem_euclid(period_secs) floors correctly even for timestamps before the epoch. In claim_slot, rows_affected() is 1 only for the winning insert.",
        "solution": "pub fn slot_for(now_secs: i64, period_secs: i64) -> i64 {\n    assert!(period_secs > 0, \"period must be positive\");\n    now_secs - now_secs.rem_euclid(period_secs)\n}\n\npub async fn claim_slot(\n    pool: &sqlx::PgPool,\n    job: &str,\n    slot: i64,\n) -> sqlx::Result<bool> {\n    let inserted = sqlx::query(\n        \"INSERT INTO scheduled_runs (job, slot) VALUES ($1, $2) ON CONFLICT DO NOTHING\",\n    )\n    .bind(job)\n    .bind(slot)\n    .execute(pool)\n    .await?\n    .rows_affected();\n    Ok(inserted == 1)\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn floors_to_period_boundary() {\n        assert_eq!(slot_for(1_000, 300), 900);\n        assert_eq!(slot_for(1_200, 300), 1_200);\n    }\n}"
      },
      "production": [
        "Every scheduled job has an idempotency key persisted in the database, not in memory.",
        "Backfill windows are capped and truncated backfills are logged with a count.",
        "Each cron expression is parsed and asserted at boot, so a typo fails the deploy.",
        "Leader locks live on a dedicated connection and losing the lock stops ticks.",
        "Missed-run and duplicate-run counts are exported as separate metrics."
      ],
      "crates": [
        "tokio",
        "tokio-cron-scheduler",
        "apalis",
        "sqlx",
        "tracing"
      ],
      "pitfall": "Waiting for a real tick to test a cron job is slow and flaky; test slot_for and the handler directly, then run one end-to-end case with a one-second schedule.",
      "questions": [
        {
          "q": "Two replicas both run the same in-process five-minute cron job. What makes the work run once per slot?",
          "options": [
            "tokio-cron-scheduler deduplicates ticks across processes",
            "A leader lock or a unique (job, slot) row claimed with ON CONFLICT DO NOTHING",
            "Nothing needs to be done: each replica owns its own schedule"
          ],
          "answer": 1,
          "explain": "An in-process scheduler knows nothing about its peers. Either elect one leader or make the slot an idempotency key in the database and enqueue only when the insert wins."
        },
        {
          "q": "Why must scheduled jobs be idempotent?",
          "options": [
            "Cron expressions are advisory",
            "At-least-once schedulers can run a job twice after a crash or lease loss",
            "Because Rust makes jobs run twice by default",
            "So the job can be cancelled"
          ],
          "answer": 1,
          "explain": "Crashes, retries and leader changes can redeliver a run. Dedupe by run id or make the effect conditional (upsert, idempotency key) so a repeat is harmless."
        }
      ],
      "resources": [
        {
          "title": "tokio-cron-scheduler JobScheduler API",
          "url": "https://docs.rs/tokio-cron-scheduler/latest/tokio_cron_scheduler/struct.JobScheduler.html",
          "kind": "docs"
        },
        {
          "title": "apalis: background job processing",
          "url": "https://docs.rs/apalis/latest/apalis/",
          "kind": "docs"
        },
        {
          "title": "apalis-cron scheduler backend",
          "url": "https://docs.rs/apalis-cron/latest/apalis_cron/",
          "kind": "docs"
        },
        {
          "title": "Kubernetes Lease objects and leader election",
          "url": "https://kubernetes.io/docs/concepts/architecture/leases/",
          "kind": "docs"
        }
      ],
      "quickbytes": [
        "Persist last-run state in the database, not in process memory.",
        "Use a leader lease so only one replica schedules each job."
      ],
      "github": [
        {
          "name": "tokio-rs/tokio",
          "url": "https://github.com/tokio-rs/tokio"
        },
        {
          "name": "apalis-dev/apalis",
          "url": "https://github.com/apalis-dev/apalis"
        }
      ]
    },
    {
      "id": "p06",
      "title": "IPC & streaming",
      "minutes": 80,
      "level": "industry",
      "goal": "Move framed messages over Unix sockets with an explicit wire format, bounded frames, real backpressure, and correct half-close semantics.",
      "sections": [
        {
          "h": "A byte stream is not a message stream",
          "p": [
            "A UnixStream is a byte stream: write() boundaries mean nothing to the reader, so a 100 KB message can arrive as a 64 KB read plus a 36 KB read, or glued to the next message. Every protocol needs framing, meaning a length prefix, a delimiter, or a fixed-size header, and the reader must be able to say not enough bytes yet without discarding what it already has.",
            "A length prefix is the simplest robust choice: a big-endian u32 length followed by the payload. Delimiters break when the payload can contain the delimiter and need escaping; fixed headers work only for fixed-size messages."
          ],
          "code": "// Wire format: 4-byte big-endian length, then exactly that many payload bytes.\nfn encode(payload: &[u8]) -> Vec<u8> {\n    let mut buf = Vec::with_capacity(4 + payload.len());\n    buf.extend_from_slice(&(payload.len() as u32).to_be_bytes());\n    buf.extend_from_slice(payload);\n    buf\n}\n\nfn length_of(header: &[u8]) -> Option<usize> {\n    let bytes: [u8; 4] = header.get(..4)?.try_into().ok()?;\n    Some(u32::from_be_bytes(bytes) as usize)\n}",
          "tip": "Document the frame layout once and generate both encoder and decoder from that note. Two hand-written parsers drift, and the drift shows up as a misrouted message."
        },
        {
          "h": "LengthDelimitedCodec does the bookkeeping",
          "p": [
            "tokio-util's Framed turns an AsyncRead + AsyncWrite into a Stream + Sink of frames, and LengthDelimitedCodec supplies the framing. It defaults to a 4-byte big-endian u32 prefix; set max_frame_length explicitly, because a peer that announces a 4 GiB frame makes the decoder reserve that much before the first payload byte arrives.",
            "Framed::new(stream, codec) then next().await yields BytesMut frames and send(bytes).await writes one. Partial frames sit in the codec's read buffer, so incompleteness costs memory rather than correctness, and a max_frame_length converts a hostile length into a decode error instead of an allocation."
          ],
          "code": "use bytes::Bytes;\nuse futures::{SinkExt, StreamExt};\nuse tokio::net::{UnixListener, UnixStream};\nuse tokio_util::codec::{Framed, LengthDelimitedCodec};\n\npub fn codec() -> LengthDelimitedCodec {\n    LengthDelimitedCodec::builder()\n        .length_field_type::<u32>()\n        .max_frame_length(8 * 1024 * 1024) // reject oversized frames before allocating\n        .new_codec()\n}\n\npub async fn serve(path: &str) -> std::io::Result<()> {\n    let listener = UnixListener::bind(path)?;\n    loop {\n        let (stream, _addr) = listener.accept().await?;\n        tokio::spawn(async move {\n            if let Err(err) = handle(stream).await {\n                tracing::warn!(?err, \"connection closed with error\");\n            }\n        });\n    }\n}\n\nasync fn handle(stream: UnixStream) -> std::io::Result<()> {\n    let mut framed = Framed::new(stream, codec());\n    while let Some(frame) = framed.next().await {\n        let request = frame?; // bad length or oversized frame ends the connection\n        let response = echo(&request).await;\n        framed.send(Bytes::from(response)).await?;\n    }\n    Ok(())\n}\n\nasync fn echo(request: &[u8]) -> Vec<u8> {\n    request.to_vec()\n}",
          "tip": "Put the socket in a dedicated runtime directory with mode 0o600, and unlink a stale socket path at startup. Binding over an existing path fails instead of replacing it."
        },
        {
          "h": "Backpressure across a socket",
          "p": [
            "SinkExt::send waits for the sink to be ready, so a slow peer throttles the writer: the kernel socket buffer fills, poll_write returns Pending, and send().await parks while the reader on the other end catches up. That is backpressure working.",
            "What breaks it is spawning a task per response over an unbounded channel: the queue absorbs the pressure and memory grows until the process dies. Choose a policy per link, block the reader or drop the oldest message, and bound whatever channel sits in between."
          ],
          "code": "use bytes::Bytes;\nuse tokio::sync::mpsc;\n\n// Bounded: at most 32 responses in flight between reader and writer.\nlet (tx, mut rx) = mpsc::channel::<Bytes>(32);\n\n// Reader side: parks once the writer is 32 frames behind.\nif tx.send(frame.freeze()).await.is_err() {\n    return Ok(()); // writer task is gone\n}\n\n// Writer task owns the sink half.\ntokio::spawn(async move {\n    let mut sink = Framed::new(stream, codec());\n    while let Some(msg) = rx.recv().await {\n        if let Err(err) = sink.send(msg).await {\n            tracing::warn!(?err, \"peer disconnected\");\n            break;\n        }\n    }\n});",
          "tip": "A full bounded channel is a signal to measure, not to widen. Raise capacity only after you know the consumer's throughput and the acceptable latency."
        },
        {
          "h": "Half-close and EOF",
          "p": [
            "shutdown() on the write half sends EOF to the peer while the read half stays open: that is how a client says it has finished sending and still expects an answer. On the server, the framed stream then ends with None, which is a normal end of input and not a connection failure.",
            "Watch the decoding edge: a peer that half-closes in the middle of a frame leaves an incomplete length prefix, and Framed reports that as an error on the final read. That is the correct outcome, because truncation must not look like a valid empty message."
          ],
          "code": "use bytes::Bytes;\nuse futures::{SinkExt, StreamExt};\nuse tokio::io::AsyncWriteExt;\nuse tokio_util::codec::Framed;\n\nlet mut framed = Framed::new(stream, codec());\nframed.send(Bytes::from_static(b\"hello\")).await?; // send() writes and flushes\nframed.get_mut().shutdown().await?; // half-close: peer sees EOF, we can still read\n\n// Server side: None means the client finished sending, not that it crashed.\nwhile let Some(frame) = framed.next().await {\n    let frame = frame?;\n    tracing::debug!(len = frame.len(), \"request\");\n}",
          "tip": "send() flushes, so the half-close above is safe. If you batch with feed() instead, flush before shutdown(): buffered frames are lost when the FIN goes out."
        }
      ],
      "exercise": {
        "prompt": "Using UnixStream::pair() and a Framed LengthDelimitedCodec, echo two frames in a spawned task, half-close the client's write side, read both replies, and assert the stream then ends. Use a bounded max_frame_length.",
        "starter": "use bytes::Bytes;\nuse futures::{SinkExt, StreamExt};\nuse tokio::io::AsyncWriteExt;\nuse tokio::net::UnixStream;\nuse tokio_util::codec::{Framed, LengthDelimitedCodec};\n\nfn codec() -> LengthDelimitedCodec {\n    LengthDelimitedCodec::builder()\n        .max_frame_length(1024 * 1024)\n        .new_codec()\n}\n\n#[tokio::main]\nasync fn main() -> std::io::Result<()> {\n    let (client, server) = UnixStream::pair()?;\n    // TODO: echo server task, two frames, half-close,\n    // two replies, assert the next frame is None.\n    let _ = (client, server);\n    Ok(())\n}",
        "hint": "Use a plain loop: let next = framed.next().await; then let Some(next) = next else { break }; so EOF ends the loop. Reply with framed.send(frame.freeze()), then framed.get_mut().shutdown() to half-close; send() already flushes.",
        "solution": "use bytes::Bytes;\nuse futures::{SinkExt, StreamExt};\nuse tokio::io::AsyncWriteExt;\nuse tokio::net::UnixStream;\nuse tokio_util::codec::{Framed, LengthDelimitedCodec};\n\nfn codec() -> LengthDelimitedCodec {\n    LengthDelimitedCodec::builder()\n        .length_field_type::<u32>()\n        .max_frame_length(1024 * 1024)\n        .new_codec()\n}\n\n#[tokio::main]\nasync fn main() -> std::io::Result<()> {\n    let (client, server) = UnixStream::pair()?;\n\n    let echo = tokio::spawn(async move {\n        let mut framed = Framed::new(server, codec());\n        loop {\n            let next = framed.next().await; // statement: borrow ends here\n            let Some(next) = next else { break };\n            let frame = next.expect(\"valid frame\");\n            framed.send(frame.freeze()).await.expect(\"echo send\");\n        }\n    });\n\n    let mut framed = Framed::new(client, codec());\n    framed.send(Bytes::from_static(b\"one\")).await.unwrap();\n    framed.send(Bytes::from_static(b\"two\")).await.unwrap();\n    framed.get_mut().shutdown().await.unwrap(); // half-close, keep reading\n\n    let first = framed.next().await.expect(\"reply one\").expect(\"valid\");\n    let second = framed.next().await.expect(\"reply two\").expect(\"valid\");\n    assert_eq!(&first[..], b\"one\");\n    assert_eq!(&second[..], b\"two\");\n    assert!(framed.next().await.is_none(), \"server closed after EOF\");\n\n    echo.await.unwrap();\n    Ok(())\n}"
      },
      "production": [
        "Every message type has a documented wire format and an explicit maximum frame size.",
        "Decode errors close the connection with a logged reason; a frame is never skipped silently.",
        "The socket file is mode 0o600 in a private directory, unlinked on startup and shutdown.",
        "A slow-reader test proves memory stays bounded and exactly one writer task parks.",
        "Half-close is covered: two frames, shutdown, two replies, then EOF."
      ],
      "crates": [
        "tokio",
        "tokio-util",
        "bytes",
        "futures",
        "tracing"
      ],
      "pitfall": "Treating each read() as one message works in tests and breaks under load: stream coalescing merges a small write with the next one, so the parser sees two messages as one and misroutes them.",
      "questions": [
        {
          "q": "A client sends two framed requests, then half-closes its write side. After the replies, what does the server framed stream yield?",
          "options": [
            "An error, because the connection was closed",
            "None once the two complete frames are consumed and the read buffer is empty",
            "A zero-length frame that must be skipped"
          ],
          "answer": 1,
          "explain": "EOF with an empty decode buffer ends the stream normally. A truncated frame would instead produce an io error: bytes remaining on stream."
        },
        {
          "q": "What does length-delimited framing solve?",
          "options": [
            "It compresses messages",
            "It tells the reader where one message ends without guessing from read boundaries",
            "It encrypts each frame",
            "It removes the need for backpressure"
          ],
          "answer": 1,
          "explain": "Streams deliver arbitrary byte chunks. A length prefix lets the decoder split frames deterministically instead of assuming one read equals one message."
        }
      ],
      "resources": [
        {
          "title": "tokio::net::UnixListener",
          "url": "https://docs.rs/tokio/latest/tokio/net/struct.UnixListener.html",
          "kind": "docs"
        },
        {
          "title": "tokio_util::codec framing module",
          "url": "https://docs.rs/tokio-util/latest/tokio_util/codec/index.html",
          "kind": "docs"
        },
        {
          "title": "LengthDelimitedCodec",
          "url": "https://docs.rs/tokio-util/latest/tokio_util/codec/length_delimited/struct.LengthDelimitedCodec.html",
          "kind": "docs"
        },
        {
          "title": "Tokio tutorial: framing a stream",
          "url": "https://tokio.rs/tokio/tutorial/framing",
          "kind": "docs"
        }
      ],
      "quickbytes": [
        "Framed codecs handle partial reads; never assume one read equals one message.",
        "Bound the maximum frame size to reject malicious payloads early."
      ],
      "github": [
        {
          "name": "tokio-rs/tokio-util",
          "url": "https://github.com/tokio-rs/tokio"
        },
        {
          "name": "tokio-rs/tokio",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ]
    },
    {
      "id": "p07",
      "title": "Resource limits & isolation",
      "minutes": 85,
      "level": "industry",
      "goal": "Bound a child's CPU, memory, file size, and process count with rlimits and cgroups, then understand which isolation they do not provide.",
      "sections": [
        {
          "h": "rlimits are inherited, cheap, and per-process",
          "p": [
            "A resource limit is a soft/hard pair inherited across fork and exec. Set it before exec and every process the child spawns inherits it. Soft limits can be raised by the process up to the hard limit, so the hard limit is the enforcement boundary; drop privileges after setting limits so the child cannot raise them back.",
            "Which limits matter for a job runner: CPU (seconds of CPU, then SIGXCPU and finally SIGKILL), AS (address space, so an allocation-heavy job fails instead of pushing the host into swap), FSIZE (largest file a job may write), NPROC (fork bombs), and NOFILE (descriptor exhaustion)."
          ],
          "code": "use rlimit::{getrlimit, setrlimit, Resource};\n\n#[derive(Debug, Clone, Copy)]\npub struct Limits {\n    pub cpu_secs: u64,\n    pub mem_bytes: u64,\n    pub fsize_bytes: u64,\n}\n\npub fn apply(limits: Limits) -> std::io::Result<()> {\n    // The hard limit is the ceiling the child cannot exceed.\n    setrlimit(Resource::CPU, limits.cpu_secs, limits.cpu_secs + 5)?;\n    setrlimit(Resource::AS, limits.mem_bytes, limits.mem_bytes)?;\n    setrlimit(Resource::FSIZE, limits.fsize_bytes, limits.fsize_bytes)?;\n    setrlimit(Resource::NPROC, 64, 64)?;\n    let (soft, hard) = getrlimit(Resource::NOFILE)?;\n    tracing::debug!(soft, hard, \"inherited NOFILE limit\");\n    Ok(())\n}",
          "tip": "Enforce in the child, not in the caller. A limit applied in the parent applies to the parent; only inheritance or an explicit prlimit call affects the child."
        },
        {
          "h": "Apply limits in the child, not around it",
          "p": [
            "From the parent, prlimit(2) can change another process's limits, but there is a race: the child may allocate before you call it. The correct place is pre_exec, which runs after fork and before exec, where Rust code is restricted to async-signal-safe operations: no allocation, no locks, no logging.",
            "tokio::process::Command exposes pre_exec with exactly that contract, and an error returned from the closure is reported by spawn(). Keep prlimit for supervising an existing child, raising NOFILE during a hot phase, or reading limits back for verification."
          ],
          "code": "use rlimit::{Resource, setrlimit};\nuse tokio::process::Command;\n\n#[cfg(unix)]\npub fn limited(cmd: &mut Command, limits: Limits) {\n    // SAFETY: the closure only issues setrlimit syscalls. No allocation,\n    // no locks, no logging: this runs between fork and exec.\n    unsafe {\n        cmd.pre_exec(move || {\n            setrlimit(Resource::CPU, limits.cpu_secs, limits.cpu_secs + 5)?;\n            setrlimit(Resource::AS, limits.mem_bytes, limits.mem_bytes)?;\n            setrlimit(Resource::FSIZE, limits.fsize_bytes, limits.fsize_bytes)?;\n            setrlimit(Resource::NPROC, 64, 64)?;\n            Ok(())\n        });\n    }\n}",
          "tip": "A failure inside pre_exec aborts the spawn with an error, which is what you want: running the job without its limits is worse than not running it."
        },
        {
          "h": "cgroup v2 enforces groups",
          "p": [
            "rlimits bind a process; cgroups bind a tree. In cgroup v2 you create a directory under a delegated subtree of /sys/fs/cgroup, write the controller files, then write the child's pid into cgroup.procs. Every descendant is accounted into that group, including grandchildren you never spawned directly.",
            "The files that map to job control: memory.max is the hard memory limit and the cgroup OOM killer kills a task inside the group when reclaim cannot get under it; cpu.max takes a quota and a period in microseconds, so 50000 100000 means half a CPU; pids.max caps forked processes and makes fork return EAGAIN; cgroup.kill takes a 1 and SIGKILLs the whole subtree, including concurrent forks."
          ],
          "code": "use std::fs;\nuse std::path::{Path, PathBuf};\n\npub fn isolate(name: &str, mem_bytes: u64, cpu_quota: u64) -> std::io::Result<PathBuf> {\n    let dir = Path::new(\"/sys/fs/cgroup\").join(name);\n    fs::create_dir_all(&dir)?;\n    fs::write(dir.join(\"memory.max\"), mem_bytes.to_string())?;\n    // cpu.max is \"<quota> <period>\" in microseconds: half a core here.\n    fs::write(dir.join(\"cpu.max\"), format!(\"{cpu_quota} 100000\"))?;\n    fs::write(dir.join(\"pids.max\"), \"128\")?;\n    Ok(dir)\n}\n\npub fn attach(dir: &Path, pid: u32) -> std::io::Result<()> {\n    fs::write(dir.join(\"cgroup.procs\"), pid.to_string())\n}\n\npub fn kill_tree(dir: &Path) -> std::io::Result<()> {\n    fs::write(dir.join(\"cgroup.kill\"), \"1\") // SIGKILL the subtree, fork-safe\n}",
          "tip": "Inside a container /sys/fs/cgroup is often read-only or delegated to a subpath. Surface EROFS or EPERM as a job failure instead of silently running without limits."
        },
        {
          "h": "What rlimits and cgroups do not stop",
          "p": [
            "Neither mechanism stops a job from reading /etc/shadow, calling the cloud metadata endpoint, or writing outside its directory. Limiting what a process can see needs namespaces (mount, pid, network, user) and a syscall filter (seccomp); Landlock is the unprivileged filesystem-scope option.",
            "The pragmatic stack for a job runner: a dedicated uid per class, rlimits for cheap per-process bounds, a cgroup for group accounting and atomic kill, a private mount namespace with a read-only root where possible, and seccomp-bpf for the syscall surface. Each layer is independently useful; none replaces another."
          ],
          "list": [
            "Drop to a dedicated uid and gid before exec; never run untrusted jobs as root",
            "Mount the work directory nosuid, nodev, and noexec, and give the job only that path",
            "Deny outbound network unless the job contract requires it",
            "Log the applied limits and the child pid, so a policy rejection is explainable later"
          ],
          "tip": "RLIMIT_AS counts virtual address space, so a job that mmaps a large file can hit it without high resident memory; cgroup memory.max counts charged memory. Choose by what you are protecting against."
        }
      ],
      "exercise": {
        "prompt": "Implement spawn_limited(argv, limits): spawn argv with AS, CPU, and FSIZE limits installed in pre_exec, then read the child's AS limit back with prlimit and return it with the child. Return an error if the kernel reports a different value.",
        "starter": "use rlimit::Resource;\nuse std::process::Stdio;\nuse tokio::process::{Child, Command};\n\n#[derive(Debug, Clone, Copy)]\npub struct Limits {\n    pub cpu_secs: u64,\n    pub mem_bytes: u64,\n    pub fsize_bytes: u64,\n}\n\n// TODO: build the Command from argv, install limits in pre_exec,\n// spawn, read AS back with prlimit, compare, and clean up on mismatch.\n#[cfg(target_os = \"linux\")]\npub async fn spawn_limited(\n    _argv: &[&str],\n    _limits: Limits,\n) -> std::io::Result<(Child, u64)> {\n    todo!()\n}",
        "hint": "prlimit(pid, Resource::AS, None, Some((&mut soft, &mut hard))) returns Result<()> and writes the current values. Compare soft with limits.mem_bytes, and on mismatch kill plus wait before returning the error.",
        "solution": "use rlimit::{prlimit, Resource};\nuse std::process::Stdio;\nuse tokio::process::{Child, Command};\n\n#[derive(Debug, Clone, Copy)]\npub struct Limits {\n    pub cpu_secs: u64,\n    pub mem_bytes: u64,\n    pub fsize_bytes: u64,\n}\n\n#[cfg(target_os = \"linux\")]\npub async fn spawn_limited(\n    argv: &[&str],\n    limits: Limits,\n) -> std::io::Result<(Child, u64)> {\n    let (program, args) = argv.split_first().expect(\"argv is not empty\");\n    let mut cmd = Command::new(program);\n    cmd.args(args)\n        .stdout(Stdio::piped())\n        .stderr(Stdio::piped())\n        .kill_on_drop(true);\n    cmd.process_group(0); // a timeout can kill grandchildren too\n\n    // SAFETY: only setrlimit syscalls run between fork and exec here.\n    unsafe {\n        cmd.pre_exec(move || {\n            rlimit::setrlimit(Resource::CPU, limits.cpu_secs, limits.cpu_secs + 5)?;\n            rlimit::setrlimit(Resource::AS, limits.mem_bytes, limits.mem_bytes)?;\n            rlimit::setrlimit(Resource::FSIZE, limits.fsize_bytes, limits.fsize_bytes)?;\n            Ok(())\n        });\n    }\n\n    let mut child = cmd.spawn()?;\n    let pid = child.id().expect(\"child has not been reaped yet\");\n    let (mut soft, mut hard) = (0u64, 0u64);\n    prlimit(pid as i32, Resource::AS, None, Some((&mut soft, &mut hard)))?;\n\n    if soft != limits.mem_bytes {\n        let _ = child.kill().await;\n        let _ = child.wait().await; // reap before returning\n        return Err(std::io::Error::new(\n            std::io::ErrorKind::InvalidData,\n            format!(\"AS limit mismatch: expected {}, got {soft}\", limits.mem_bytes),\n        ));\n    }\n    Ok((child, soft))\n}"
      },
      "production": [
        "Every job class has explicit CPU seconds, memory bytes, file-size, and process-count limits in config.",
        "Limits are installed in pre_exec and verified once at startup by reading them back with prlimit.",
        "cgroup paths live under a delegated subtree; creation failures fail the job instead of degrading silently.",
        "A job that hits memory.max is retried at most once, then quarantined rather than looping on OOM.",
        "A job uid cannot read another job's work directory; a mount namespace enforces that, not file permissions alone."
      ],
      "crates": [
        "tokio",
        "rlimit",
        "nix",
        "libc",
        "tracing"
      ],
      "pitfall": "RLIMIT_AS exhaustion surfaces as an allocation abort inside the child, not a clean error; if you only inspect the exit status, a policy rejection looks like a random crash. Log the applied limits with the pid.",
      "questions": [
        {
          "q": "Which mechanism SIGKILLs every process in a cgroup tree, including processes forked while the kill is in progress?",
          "options": [
            "killpg on the direct child process group",
            "RLIMIT_NPROC set to the current process count",
            "Writing 1 to the cgroup.kill file"
          ],
          "answer": 2,
          "explain": "cgroup.kill kills the whole subtree and handles concurrent forks. killpg reaches one process group, and RLIMIT_NPROC only blocks new forks."
        },
        {
          "q": "Why set RLIMIT_NOFILE explicitly for services?",
          "options": [
            "Rust needs exactly 1024 descriptors",
            "Containers often inherit low defaults and exhaust descriptors under load",
            "It caps memory usage of the process",
            "It is required for async code"
          ],
          "answer": 1,
          "explain": "The default descriptor limit is often low relative to connection-heavy services. Raising it deliberately (and monitoring usage) avoids accept failures under load."
        }
      ],
      "resources": [
        {
          "title": "rlimit crate: resource limits for Rust",
          "url": "https://docs.rs/rlimit/latest/rlimit/",
          "kind": "docs"
        },
        {
          "title": "rlimit::Resource constants",
          "url": "https://docs.rs/rlimit/latest/rlimit/struct.Resource.html",
          "kind": "docs"
        },
        {
          "title": "rlimit::prlimit for an arbitrary process",
          "url": "https://docs.rs/rlimit/latest/rlimit/fn.prlimit.html",
          "kind": "docs"
        },
        {
          "title": "cgroups(7): Linux control groups",
          "url": "https://man7.org/linux/man-pages/man7/cgroups.7.html",
          "kind": "docs"
        }
      ],
      "quickbytes": [
        "Set cgroup v2 memory.max, cpu.max and pids.max for child workloads.",
        "Drop privileges (uid/gid, no_new_privs) after setup, not before."
      ],
      "github": [
        {
          "name": "nix-rust/nix",
          "url": "https://github.com/nix-rust/nix"
        },
        {
          "name": "rust-osdev/linked-list-allocator",
          "url": "https://github.com/rust-osdev/linked-list-allocator"
        }
      ]
    },
    {
      "id": "p08",
      "title": "Container entrypoints and PID 1",
      "minutes": 55,
      "level": "core",
      "goal": "Pick an exec-form entrypoint, explain why PID 1 discards an unhandled SIGTERM, and return an exit status the runtime can classify.",
      "sections": [
        {
          "h": "Exec form, shell form, and who gets the signal",
          "p": [
            "Dockerfile ENTRYPOINT and CMD have two forms. The exec form is a JSON array and runs the binary directly, so that binary becomes PID 1 in the container's PID namespace. The shell form is a plain string and runs /bin/sh -c with your command as an argument, so the shell is PID 1 and your process is its child.",
            "Whether that matters depends on one detail: does the shell exec the command or fork it? A single simple command is often exec'd as an optimisation, so signals still arrive. Add &&, a pipe, a redirection, or a variable assignment and the shell keeps running, waits for the child, and does not forward SIGTERM. The container then takes the full grace period and is SIGKILLed."
          ],
          "code": "# Shell form: /bin/sh -c \"./migrate && ./server\" becomes PID 1.\n# The shell stays alive because of &&, so SIGTERM never reaches the server.\nFROM debian:bookworm-slim\nCMD ./migrate && ./server\n\n# Exec form: the binary itself is PID 1 and receives SIGTERM directly.\nFROM debian:bookworm-slim\nENTRYPOINT [\"/usr/local/bin/server\"]\n\n# If you genuinely need a shell, exec the final command explicitly.\n# ENTRYPOINT [\"/bin/sh\", \"-c\", \"exec /usr/local/bin/server\"]",
          "tip": "Check the running container with `docker exec <id> ps -o pid,ppid,comm`. If PID 1 is sh, you have a signal-forwarding problem regardless of what the Dockerfile looks like."
        },
        {
          "h": "PID 1 is not a normal process",
          "p": [
            "Inside a PID namespace the first process is the namespace init, and the kernel treats signals to it differently. A signal sent by another process in the namespace is delivered only if init has installed a handler for it. SIGKILL and SIGSTOP from an ancestor namespace are the exceptions and are always delivered.",
            "The practical consequence: a Rust binary with no signal handler dies from SIGTERM on your laptop and ignores it as PID 1 in a container. This is not Docker being broken; it is the kernel protecting the namespace init. Install the handler at the top of main, before any worker or listener exists, so a stop signal during boot still runs cleanup."
          ],
          "code": "use std::process::ExitCode;\nuse std::time::Duration;\nuse tokio::signal::unix::{signal, SignalKind};\n\n#[tokio::main]\nasync fn main() -> ExitCode {\n    // Install before spawning anything: an unhandled SIGTERM is discarded\n    // for the init process of a PID namespace, so the container would wait\n    // out the full grace period and then be SIGKILLed.\n    let mut term = signal(SignalKind::terminate()).expect(\"SIGTERM handler\");\n    let mut int = signal(SignalKind::interrupt()).expect(\"SIGINT handler\");\n\n    tokio::select! {\n        _ = term.recv() => tracing::info!(\"received SIGTERM\"),\n        _ = int.recv() => tracing::info!(\"received SIGINT\"),\n    }\n\n    let drained = tokio::time::timeout(Duration::from_secs(20), drain())\n        .await\n        .is_ok();\n\n    if drained {\n        ExitCode::SUCCESS\n    } else {\n        ExitCode::from(1)\n    }\n}\n\nasync fn drain() {\n    // stop admission, cancel workers, join them, flush telemetry\n}",
          "tip": "If you cannot add signal handling, run a real init as PID 1: tini or dumb-init forwards signals and reaps orphans for you."
        },
        {
          "h": "Exit codes are part of the contract",
          "p": [
            "Orchestrators and CI read the exit status, so make it mean something. Zero is a requested, clean stop. One is your own failure. 143 is 128 plus SIGTERM, meaning the process was terminated by the signal rather than exiting; 137 is 128 plus SIGKILL, which is what a grace-period expiry or a cgroup OOM kill produces.",
            "A process that catches SIGTERM and returns zero has told the runtime the stop was clean, and the runtime will record it as completed rather than failed. That is honest only if the drain actually finished. If the deadline expired with jobs still running, exit nonzero and log the count; a deploy that silently drops work is worse than a noisy one."
          ],
          "list": [
            "0: requested stop, all admitted work finished",
            "1: drain deadline exceeded, or an unrecoverable startup error",
            "143: the process never handled SIGTERM and was terminated by it",
            "137: SIGKILL, typically grace-period expiry or the cgroup OOM killer"
          ],
          "tip": "docker stop sends SIGTERM and then SIGKILL after 10 seconds by default. Set STOPSIGNAL or the stop timeout if your drain needs longer, and keep the drain budget below it."
        }
      ],
      "exercise": {
        "prompt": "Implement stop_reason, which waits for SIGTERM or SIGINT and reports which arrived, and exit_code, which maps the signal plus whether the drain finished to 0, 130, or 143. A timed-out drain must not be reported as a clean stop.",
        "starter": "use std::process::ExitCode;\nuse tokio::signal::unix::{signal, SignalKind};\n\n#[derive(Debug, PartialEq)]\npub enum Stop {\n    Term,\n    Int,\n}\n\n// TODO: race the two signal streams; return the one that fired first.\npub async fn stop_reason() -> Stop {\n    let _ = signal(SignalKind::terminate());\n    Stop::Term\n}\n\n// TODO: a finished drain is 0; otherwise 128 + the signal number.\npub fn exit_code(stop: &Stop, drained: bool) -> ExitCode {\n    let _ = (stop, drained);\n    ExitCode::SUCCESS\n}",
        "hint": "Create both streams with signal(SignalKind::terminate()) and signal(SignalKind::interrupt()), then tokio::select! on term.recv() and int.recv(). Signal numbers are 15 and 2, so the fallback codes are 143 and 130.",
        "solution": "use std::process::ExitCode;\nuse tokio::signal::unix::{signal, SignalKind};\n\n#[derive(Debug, PartialEq)]\npub enum Stop {\n    Term,\n    Int,\n}\n\npub async fn stop_reason() -> Stop {\n    let mut term = signal(SignalKind::terminate()).expect(\"SIGTERM handler\");\n    let mut int = signal(SignalKind::interrupt()).expect(\"SIGINT handler\");\n\n    tokio::select! {\n        _ = term.recv() => Stop::Term,\n        _ = int.recv() => Stop::Int,\n    }\n}\n\npub fn exit_code(stop: &Stop, drained: bool) -> ExitCode {\n    match (stop, drained) {\n        (_, true) => ExitCode::SUCCESS,\n        (Stop::Term, false) => ExitCode::from(143),\n        (Stop::Int, false) => ExitCode::from(130),\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn a_forced_stop_is_not_success() {\n        assert_eq!(exit_code(&Stop::Term, true), ExitCode::SUCCESS);\n        assert_eq!(exit_code(&Stop::Term, false), ExitCode::from(143));\n        assert_eq!(exit_code(&Stop::Int, false), ExitCode::from(130));\n    }\n}"
      },
      "production": [
        "The container runs one process as PID 1, in exec form, with no shell in between.",
        "The signal handler is installed before migrations, listeners, or worker pools start.",
        "The drain budget is shorter than the platform stop timeout, and the gap is logged at boot.",
        "A test asserts that SIGTERM during boot still exits through the cleanup path.",
        "Exit codes distinguish a clean stop from a timed-out drain in dashboards and CI."
      ],
      "crates": [
        "tokio",
        "tracing",
        "anyhow"
      ],
      "github": [
        {
          "name": "krallin/tini - a tiny init for containers",
          "url": "https://github.com/krallin/tini"
        },
        {
          "name": "Yelp/dumb-init - minimal init system for Linux containers",
          "url": "https://github.com/Yelp/dumb-init"
        }
      ],
      "pitfall": "Using the shell form with `&&` to run a migration before the server: the shell stays PID 1, never forwards SIGTERM, and every deploy waits out the grace period before SIGKILL.",
      "questions": [
        {
          "q": "A container uses ENTRYPOINT [\"sh\", \"-c\", \"migrate && ./server\"]. The runtime sends SIGTERM to PID 1. What does the server see?",
          "options": [
            "SIGTERM, because the shell forwards it to its child by default",
            "Nothing, because the shell is PID 1, stays alive for &&, and does not forward the signal",
            "SIGKILL, because the shell converts SIGTERM for its children",
            "SIGTERM, but only after the shell finishes waiting for the child"
          ],
          "answer": 1,
          "explain": "A shell that forks a child and waits does not forward SIGTERM. The shell dies at the grace-period SIGKILL and the server is killed with it, so in-flight work is dropped."
        },
        {
          "q": "A Rust service ignores SIGTERM as container PID 1 but exits correctly when run directly on a VM. Why?",
          "options": [
            "Docker masks SIGTERM for containers by design",
            "The kernel only delivers namespace-init signals that init has a handler for, apart from SIGKILL and SIGSTOP",
            "Tokio installs a SIGTERM handler on a VM and removes it in containers",
            "The process is not in the same cgroup as the signal sender"
          ],
          "answer": 1,
          "explain": "pid_namespaces(7): signals from inside the namespace are delivered to the init process only if it installed a handler. Unhandled SIGTERM is discarded, so the runtime waits out the grace period."
        },
        {
          "q": "A worker exits with code 137 after a deploy. What is the most likely cause?",
          "options": [
            "The application returned 137 from main",
            "The process was SIGKILLed, for example by a grace-period expiry or the cgroup OOM killer",
            "The drain deadline was reached and the process exited cleanly",
            "The runtime could not find the binary"
          ],
          "answer": 1,
          "explain": "137 is 128 + 9, the shell convention for death by SIGKILL. A cgroup OOM kill and a grace-period expiry both look like this, which is why the cgroup memory.events counter matters."
        }
      ],
      "quickbytes": [
        "Use the exec form, or `exec` the final command inside any shell wrapper.",
        "Install the signal handler first, before migrations and listeners.",
        "143 means the process never handled SIGTERM; treat it as a bug, not a clean stop."
      ],
      "resources": [
        {
          "title": "Dockerfile reference: ENTRYPOINT, CMD, and STOPSIGNAL",
          "url": "https://docs.docker.com/reference/dockerfile/",
          "kind": "docs"
        },
        {
          "title": "pid_namespaces(7): init, signals, and orphan reparenting",
          "url": "https://man7.org/linux/man-pages/man7/pid_namespaces.7.html",
          "kind": "docs"
        },
        {
          "title": "tini: signal forwarding and zombie reaping for containers",
          "url": "https://github.com/krallin/tini",
          "kind": "repo"
        },
        {
          "title": "CNCF channel: container runtime and Kubernetes internals talks",
          "url": "https://www.youtube.com/@CNCF",
          "kind": "video"
        }
      ]
    },
    {
      "id": "p09",
      "title": "Reaping orphans and subreapers",
      "minutes": 60,
      "level": "advanced",
      "goal": "Keep a container's process table clean: reap reparented descendants with waitpid, and become a subreaper when your process is not PID 1.",
      "sections": [
        {
          "h": "Orphans land on PID 1",
          "p": [
            "A child that exits stays a zombie until its parent waits for it, holding a pid and a process-table slot. When the parent dies first, the kernel reparents the surviving child to the init process of the PID namespace, which in a container is whatever runs as PID 1.",
            "If that process never calls waitpid, every orphan accumulates. With pids.max set, fork eventually fails with EAGAIN and the symptom is bizarre: threads that spawn helper processes stop working, but the process itself looks healthy. Counting zombies is part of monitoring a container, not an afterthought."
          ],
          "code": "# Count zombies inside the container's PID namespace.\nps -eo stat,pid,ppid,comm | awk '$1 ~ /^Z/ { print }'\n\n# The process-tree view that makes reparenting visible.\nps -eo pid,ppid,stat,comm --forest | head -40\n\n# The limit they will eventually hit.\ncat /sys/fs/cgroup/pids.max\ncat /sys/fs/cgroup/pids.current\n\n# Seccomp and signal masks are per-process facts worth having on hand.\ngrep -E 'Seccomp|SigCgt' /proc/1/status",
          "tip": "A single zombie is normal between exit and wait. A growing count is a missing waitpid, and a count at pids.current near pids.max is an outage waiting for the next fork."
        },
        {
          "h": "waitpid(-1) is the reaper loop",
          "p": [
            "waitpid with a None pid asks the kernel for any child that changed state, and WNOHANG makes it non-blocking. Loop until it returns StillAlive, which means children exist but none has exited, or ECHILD, which means you have no children at all and reparenting is now somebody else's problem.",
            "The hard part is ownership. If your app spawns through tokio::process and also runs a manual waitpid(-1), the manual reaper can consume a child tokio is waiting for, and Child::wait then returns an error. Pick one reaper per process: either tokio owns every child, or a dedicated init shim owns every child and your app does not exist in that namespace."
          ],
          "code": "use nix::errno::Errno;\nuse nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};\nuse std::time::Duration;\n\n/// Reap every child that has already exited, without blocking.\npub fn reap_ready() -> usize {\n    let mut reaped = 0;\n    loop {\n        match waitpid(None, Some(WaitPidFlag::WNOHANG)) {\n            Ok(WaitStatus::StillAlive) => break, // children exist, none exited\n            Ok(status) => {\n                tracing::info!(?status, \"reaped a descendant\");\n                reaped += 1;\n            }\n            Err(Errno::ECHILD) => break, // nothing to wait for; stop polling\n            Err(err) => {\n                tracing::warn!(%err, \"waitpid failed\");\n                break;\n            }\n        }\n    }\n    reaped\n}\n\npub async fn reaper_loop() {\n    loop {\n        reap_ready();\n        tokio::time::sleep(Duration::from_millis(100)).await;\n    }\n}",
          "tip": "A 100 ms poll is a deliberate simplification. A SIGCHLD handler with a self-pipe wakes you exactly once per exit; polling costs an idle wakeup per tick per container."
        },
        {
          "h": "Become a subreaper when you are not PID 1",
          "p": [
            "PR_SET_CHILD_SUBREAPER marks the calling process as the reaper for orphaned descendants, even if it is not the namespace init. A job runner that double-forks helpers, or a build agent whose compilers spawn linkers, uses it so orphans stop at the runner instead of disappearing up to the host init.",
            "The attribute is per-process: set it once at startup, before spawning anything, and be aware that children do not inherit it. It is Linux-only, so gate it with cfg(target_os = \"linux\") and let other platforms fall back to normal init behaviour."
          ],
          "code": "#[cfg(target_os = \"linux\")]\npub fn become_subreaper() -> nix::Result<()> {\n    use nix::sys::prctl::set_child_subreaper;\n    // Orphans of our descendants are reparented to us, not to host init.\n    set_child_subreaper(true)\n}\n\n#[cfg(not(target_os = \"linux\"))]\npub fn become_subreaper() -> nix::Result<()> {\n    Ok(()) // init already reaps on macOS and BSD\n}",
          "tip": "A subreaper that does not reap is worse than no subreaper: it collects every orphan and turns them into zombies it never collects."
        },
        {
          "h": "Prove it with a forking child",
          "p": [
            "The bug is invisible in code review and obvious in a test. Spawn a shell that backgrounds a sleep and exits immediately: the sleep is reparented to your process, and after it finishes a zombie should appear unless the reaper runs.",
            "Assert on /proc/<pid>/status or on a zombie count from ps, then call the reaper and assert the count drops to zero. Set PR_SET_CHILD_SUBREAPER in the test, or run it in a PID namespace: otherwise the orphan is adopted by the host init and your reaper never sees it, so the test passes without testing anything."
          ],
          "list": [
            "Test the reaper with a child that forks and exits before its grandchild",
            "Assert no zombie remains after one reaper tick, not after an arbitrary sleep",
            "Run the test in a container so reparenting targets your PID 1",
            "Export a zombie-count gauge and alert when it is above zero for a minute"
          ],
          "tip": "A test that passes on a laptop and fails in CI is usually adoption: on the host, init reaps the orphan before your code sees it."
        }
      ],
      "exercise": {
        "prompt": "Implement reap_ready, which drains every already-exited child with waitpid(WNOHANG) and returns the count, stopping on StillAlive or ECHILD. Add a test using a shell that backgrounds a sleep and exits.",
        "starter": "use nix::errno::Errno;\nuse nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};\n\n// TODO: loop on waitpid(None, Some(WNOHANG)); count Ok(non-StillAlive),\n// break on StillAlive and on ECHILD.\npub fn reap_ready() -> usize {\n    0\n}\n\nfn main() {\n    let _ = (Errno::ECHILD, WaitStatus::StillAlive, WaitPidFlag::WNOHANG);\n    println!(\"reaped {}\", reap_ready());\n}",
        "hint": "Match Ok(WaitStatus::StillAlive) and Err(Errno::ECHILD) to break, Ok(other) to count, and any other Err to log and break. The loop must terminate when no exited child remains.",
        "solution": "use nix::errno::Errno;\nuse nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};\n\npub fn reap_ready() -> usize {\n    let mut reaped = 0usize;\n    loop {\n        match waitpid(None, Some(WaitPidFlag::WNOHANG)) {\n            Ok(WaitStatus::StillAlive) => break,\n            Ok(status) => {\n                eprintln!(\"reaped: {status:?}\");\n                reaped += 1;\n            }\n            Err(Errno::ECHILD) => break,\n            Err(err) => {\n                eprintln!(\"waitpid: {err}\");\n                break;\n            }\n        }\n    }\n    reaped\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    #[cfg(target_os = \"linux\")]\n    fn reaps_a_reparented_grandchild() {\n        // Without this the orphan is adopted by host init, not by us.\n        nix::sys::prctl::set_child_subreaper(true).expect(\"subreaper\");\n\n        // The shell exits immediately; sleep is reparented to this process.\n        let mut child = std::process::Command::new(\"sh\")\n            .arg(\"-c\")\n            .arg(\"sleep 0.05 & exit 0\")\n            .spawn()\n            .expect(\"spawn sh\");\n        child.wait().expect(\"wait for sh\");\n        std::thread::sleep(std::time::Duration::from_millis(200));\n        assert!(reap_ready() >= 1, \"expected to reap the reparented sleep\");\n    }\n}"
      },
      "production": [
        "Exactly one component in the process tree is allowed to call waitpid; it is named in the architecture doc.",
        "A zombie-count gauge is exported and alerts when it stays above zero.",
        "pids.max is set for every workload, so a fork leak fails fast instead of exhausting the host.",
        "Subreaper mode is set once at startup on Linux and covered by a forking test.",
        "The init shim, if used, does nothing but forward signals and reap; no business logic lives there."
      ],
      "crates": [
        "nix",
        "tokio",
        "tracing"
      ],
      "github": [
        {
          "name": "containers/conmon - OCI container runtime monitor",
          "url": "https://github.com/containers/conmon"
        },
        {
          "name": "krallin/tini - a tiny init for containers",
          "url": "https://github.com/krallin/tini"
        }
      ],
      "pitfall": "Calling waitpid(-1) in a process that also uses tokio::process::Child::wait: the manual reaper steals the child, and tokio's wait returns ECHILD, which surfaces as a random spawn failure.",
      "questions": [
        {
          "q": "waitpid(None, WNOHANG) returns Ok(WaitStatus::StillAlive). What does that mean?",
          "options": [
            "There are no children left to wait for",
            "Children exist but none has changed state since the last check",
            "The call was interrupted and should be retried immediately",
            "The child was stopped and will be resumed"
          ],
          "answer": 1,
          "explain": "StillAlive means waitable children exist but none has exited. ECHILD is the no-children case, and that distinction is what makes the non-blocking drain loop terminate correctly."
        },
        {
          "q": "What happens to a container's process table when the PID 1 process exits?",
          "options": [
            "The remaining processes are reparented to the host init and keep running",
            "The kernel SIGKILLs every remaining process in the namespace",
            "The namespace stays alive until the last process exits",
            "The processes are frozen until a new PID 1 attaches"
          ],
          "answer": 1,
          "explain": "pid_namespaces(7): terminating the namespace init terminates all processes in the namespace with SIGKILL, and later forks into it fail with ENOMEM."
        },
        {
          "q": "You set PR_SET_CHILD_SUBREAPER on your job runner. Which statement is true?",
          "options": [
            "Every child of the runner is automatically a subreaper too",
            "Orphaned descendants are reparented to the runner, which must then reap them",
            "It prevents the kernel from creating zombies at all",
            "It only works when the runner is PID 1 in its namespace"
          ],
          "answer": 1,
          "explain": "Subreaper changes where orphans are reparented, not whether they become zombies. The runner inherits the responsibility to waitpid them, which is why the reaper loop is mandatory."
        }
      ],
      "quickbytes": [
        "One waiter per process tree: either tokio::process owns every child or a dedicated init shim does.",
        "ECHILD means stop polling; StillAlive means keep polling later.",
        "Set PR_SET_CHILD_SUBREAPER before the first spawn, and reap in the same binary."
      ],
      "resources": [
        {
          "title": "pid_namespaces(7): init, orphan adoption, and subreapers",
          "url": "https://man7.org/linux/man-pages/man7/pid_namespaces.7.html",
          "kind": "docs"
        },
        {
          "title": "nix::sys::wait::waitpid",
          "url": "https://docs.rs/nix/latest/nix/sys/wait/fn.waitpid.html",
          "kind": "docs"
        },
        {
          "title": "nix::sys::prctl::set_child_subreaper",
          "url": "https://docs.rs/nix/latest/nix/sys/prctl/fn.set_child_subreaper.html",
          "kind": "docs"
        },
        {
          "title": "Yelp/dumb-init - signal forwarding plus reaping, in one small binary",
          "url": "https://github.com/Yelp/dumb-init",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "p10",
      "title": "Process supervisors and restart policy",
      "minutes": 70,
      "level": "advanced",
      "goal": "Restart a crashed child without turning one bad config into a restart storm: classify the exit, back off, cap attempts, and stop the whole tree.",
      "sections": [
        {
          "h": "Read the exit status before restarting",
          "p": [
            "A supervisor needs three facts from wait: did it exit, with what code, or was it signalled. Exit code zero from a one-shot job means done, not crash. A signal means somebody killed it, which during shutdown is expected and must not count as a failure. Code 127 means the binary was not found, and no amount of restarting will fix that.",
            "The policy follows from those cases. Restart only failures, treat a clean exit as terminal for one-shot work, and treat a signal received during our own shutdown as termination rather than a crash. This is the same mistake lesson p02 warned about for tasks, one layer down at the operating system."
          ],
          "code": "use std::process::ExitStatus;\n\n#[derive(Debug, PartialEq)]\npub enum Action {\n    Done,\n    Restart,\n    GiveUp,\n    Stop,\n}\n\npub fn decide(status: ExitStatus, failures: u32, max_failures: u32) -> Action {\n    if status.success() {\n        return Action::Done; // one-shot work finished; nothing to restart\n    }\n    if failures >= max_failures {\n        return Action::GiveUp; // bad config, missing binary, port taken\n    }\n    // code() is None when the child died from a signal; a signal during our\n    // own shutdown is a stop, not a crash to restart.\n    match status.code() {\n        Some(127) | Some(126) => Action::GiveUp,\n        _ => Action::Restart,\n    }\n}",
          "tip": "Log the raw status as well as your classification. A crash loop that is really exit 127 looks identical to a panic until you print the code."
        },
        {
          "h": "Backoff, jitter, and a window",
          "p": [
            "Immediate restarts are how a dependency outage becomes a self-inflicted DDoS: every replica retries at once, the recovering service falls over, and the loop continues. Exponential backoff with a cap and jitter spreads retries, and a stability window resets the attempt counter only after the child has run long enough to be considered healthy. Docker doubles its restart delay on each attempt; Kubernetes computes CrashLoopBackOff; systemd counts starts against a time window.",
            "Every supervisor has a budget, whether it admits it or not. systemd's StartLimitBurst and StartLimitIntervalSec express it, Docker's restart policy has no backoff beyond a doubling delay, and Kubernetes computes CrashLoopBackOff. Your own supervisor should expose the same three numbers: max failures, the window they count in, and the longest delay."
          ],
          "code": "use std::time::{Duration, Instant};\n\npub struct Policy {\n    pub max_failures: u32,\n    pub window: Duration,\n    pub base: Duration,\n    pub cap: Duration,\n    pub stable_after: Duration,\n}\n\npub fn backoff(policy: &Policy, failures: u32) -> Duration {\n    let exp = policy.base.saturating_mul(1u32 << failures.min(10));\n    let capped = exp.min(policy.cap);\n    // Deterministic jitter for the example; use rand in production.\n    let jitter = capped / 10 * (failures % 3);\n    (capped + jitter).min(policy.cap)\n}\n\nimpl Policy {\n    /// Reset the failure counter only after a run proves itself stable.\n    pub fn record_run(&self, started: Instant, failures: &mut u32) {\n        if started.elapsed() >= self.stable_after {\n            *failures = 0;\n        }\n    }\n}",
          "tip": "Reset on stable uptime, not on successful spawn. A process that starts and dies in 50 ms would otherwise reset its own counter on every attempt."
        },
        {
          "h": "Stop the tree, then restart",
          "p": [
            "Killing only the direct child leaves its grandchildren alive. A wrapper script, a compiler, or a server that re-execs itself will keep the listening port, and the restart fails with EADDRINUSE while the orphan keeps serving stale code. That is why every child of a supervisor gets its own process group, and why the restart path kills the group and waits.",
            "Order matters on the way back up too: kill the group, wait for the direct child (so the pid is released), apply the backoff, then spawn. And on shutdown, stop the supervisor first, so it cannot spawn one more child while you are draining."
          ],
          "code": "use std::process::Stdio;\nuse std::time::Duration;\nuse tokio::process::Command;\nuse tokio_util::sync::CancellationToken;\n\npub async fn supervise(mut argv: Vec<String>, token: CancellationToken) -> std::io::Result<()> {\n    loop {\n        let mut cmd = Command::new(&argv[0]);\n        cmd.args(&argv[1..])\n            .stdout(Stdio::inherit())\n            .stderr(Stdio::inherit())\n            .kill_on_drop(true);\n        #[cfg(unix)]\n        cmd.process_group(0); // the child leads its own group\n\n        let mut child = cmd.spawn()?;\n        tokio::select! {\n            _ = token.cancelled() => {\n                // Signal the whole group, then reap before returning.\n                #[cfg(unix)]\n                if let Some(pid) = child.id() {\n                    let _ = nix::sys::signal::killpg(\n                        nix::unistd::Pid::from_raw(pid as i32),\n                        nix::sys::signal::Signal::SIGTERM,\n                    );\n                }\n                let _ = child.wait().await;\n                return Ok(());\n            }\n            status = child.wait() => {\n                tracing::warn!(?status, \"supervised child exited\");\n                tokio::time::sleep(Duration::from_secs(1)).await;\n            }\n        }\n    }\n}",
          "tip": "If a restart fails with EADDRINUSE, you did not kill the tree. Check for a surviving grandchild before adding a retry loop around bind."
        },
        {
          "h": "Who supervises the supervisor?",
          "p": [
            "Two supervisors on the same child is worse than none: one restarts while the other is draining, and the child gets two SIGTERMs with different expectations. Decide the layer once. Under systemd or Kubernetes, the platform owns restarts and your binary should only supervise children it spawned itself, such as sidecars or job workers.",
            "A supervisor should also be observable: restart count, last exit code, time since last successful start, and whether it is currently in backoff. Without those, the only signal is a container that keeps appearing in the restart list, and an operator has to guess which child is at fault."
          ],
          "list": [
            "One restart owner per process; the platform or your loop, never both",
            "Restart counter and last exit status exported as metrics, not just logs",
            "Backoff state visible in the health endpoint so a crash loop is not reported healthy",
            "Give-up is terminal and alertable; it must not silently leave a half-serving process"
          ],
          "tip": "When the platform restarts the container anyway, a give-up supervisor still loses. Give up loudly: exit nonzero with one clear log line and let the platform's backoff take over."
        }
      ],
      "exercise": {
        "prompt": "Implement decide(status, failures, max) returning Done for a clean exit, GiveUp at the failure cap or for 126/127, and Restart otherwise; and backoff(failures) with exponential growth capped at 30 seconds. Add tests for both.",
        "starter": "use std::process::ExitStatus;\nuse std::time::Duration;\n\n#[derive(Debug, PartialEq)]\npub enum Action {\n    Done,\n    Restart,\n    GiveUp,\n}\n\npub fn decide(_status: ExitStatus, _failures: u32, _max: u32) -> Action {\n    Action::Restart\n}\n\npub fn backoff(_failures: u32) -> Duration {\n    Duration::ZERO\n}\n\nfn main() {\n    let status = std::process::Command::new(\"true\").status().unwrap();\n    println!(\"{:?} {:?}\", decide(status, 0, 5), backoff(3));\n}",
        "hint": "status.success() is the clean-exit case; status.code() is None for a signalled child. For backoff use 100ms << failures with a cap, and saturate the shift so a large counter cannot panic.",
        "solution": "use std::process::ExitStatus;\nuse std::time::Duration;\n\n#[derive(Debug, PartialEq)]\npub enum Action {\n    Done,\n    Restart,\n    GiveUp,\n}\n\npub fn decide(status: ExitStatus, failures: u32, max: u32) -> Action {\n    if status.success() {\n        return Action::Done;\n    }\n    if failures >= max {\n        return Action::GiveUp;\n    }\n    match status.code() {\n        Some(127) | Some(126) => Action::GiveUp,\n        _ => Action::Restart,\n    }\n}\n\npub fn backoff(failures: u32) -> Duration {\n    let step = Duration::from_millis(100) << failures.min(9);\n    step.min(Duration::from_secs(30))\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    fn status(code: i32) -> ExitStatus {\n        std::process::Command::new(\"sh\")\n            .arg(\"-c\")\n            .arg(format!(\"exit {code}\"))\n            .status()\n            .expect(\"run sh\")\n    }\n\n    #[test]\n    fn classifies_exit_codes() {\n        assert_eq!(decide(status(0), 0, 5), Action::Done);\n        assert_eq!(decide(status(127), 0, 5), Action::GiveUp);\n        assert_eq!(decide(status(1), 0, 5), Action::Restart);\n        assert_eq!(decide(status(1), 5, 5), Action::GiveUp);\n    }\n\n    #[test]\n    fn backoff_is_capped_and_monotonic() {\n        assert_eq!(backoff(0), Duration::from_millis(100));\n        assert!(backoff(3) > backoff(2));\n        assert_eq!(backoff(30), Duration::from_secs(30));\n    }\n}"
      },
      "production": [
        "Restart policy is named per workload: on-failure, always, or never, with the exit codes it treats as failure.",
        "Backoff has a cap, jitter, and a stability window that resets the failure counter.",
        "Every supervised child runs in its own process group and is killed as a group before restart.",
        "Restart count, last exit code, and time in backoff are exported metrics.",
        "Only one layer supervises a given process; the platform or the application, never both."
      ],
      "crates": [
        "tokio",
        "tokio-util",
        "nix",
        "tracing"
      ],
      "github": [
        {
          "name": "containers/conmon - the monitor behind podman and CRI-O",
          "url": "https://github.com/containers/conmon"
        },
        {
          "name": "krallin/tini - init and signal forwarding for containers",
          "url": "https://github.com/krallin/tini"
        }
      ],
      "pitfall": "Restarting a child that spawns grandchildren without killing the process group: the grandchild keeps the port and the replacement exits with EADDRINUSE, which looks like a binary bug, not an orphan.",
      "questions": [
        {
          "q": "A supervised batch job exits 0. The policy is restart-on-failure. What should happen?",
          "options": [
            "Restart it, because the supervisor restarts every exit",
            "Treat it as done and stop supervising",
            "Treat exit 0 as a failure because batch jobs must return 1",
            "Restart it once and then stop"
          ],
          "answer": 1,
          "explain": "For one-shot work, exit 0 is completion. A supervisor that restarts clean exits turns a finished migration into an infinite loop."
        },
        {
          "q": "Why reset the failure counter only after a stability window rather than after every successful spawn?",
          "options": [
            "Because spawn can never fail",
            "Because a process that starts and dies immediately would reset its own counter and loop forever",
            "Because systemd requires it",
            "Because the counter is stored in the child"
          ],
          "answer": 1,
          "explain": "Resetting on spawn lets a fast crash loop keep its delay at the base value. Uptime is the only evidence that the restart actually worked."
        },
        {
          "q": "A restart repeatedly fails with EADDRINUSE. What is the first thing to check?",
          "options": [
            "The backoff cap is too low",
            "A grandchild from the previous run still holds the port, because only the direct child was killed",
            "The supervisor has too many failures recorded",
            "The child needs a larger RLIMIT_NOFILE"
          ],
          "answer": 1,
          "explain": "A direct kill leaves wrapper scripts and re-exec'd servers alive. Spawn each child in its own process group and kill the group before respawning."
        }
      ],
      "quickbytes": [
        "127 is not a crash: it is a missing binary, and restarting cannot fix it.",
        "Backoff needs a cap, jitter, and a stability window; two out of three still storms.",
        "killpg the child's group before every restart, or the orphan keeps the port."
      ],
      "resources": [
        {
          "title": "wait(2): exit status, signals, and WNOHANG",
          "url": "https://man7.org/linux/man-pages/man2/wait.2.html",
          "kind": "docs"
        },
        {
          "title": "tokio::process::Command: groups and kill_on_drop",
          "url": "https://docs.rs/tokio/latest/tokio/process/struct.Command.html",
          "kind": "docs"
        },
        {
          "title": "conmon: how a container runtime monitors its processes",
          "url": "https://github.com/containers/conmon",
          "kind": "repo"
        },
        {
          "title": "InfoQ: operating long-running services and failure handling",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        }
      ]
    },
    {
      "id": "p11",
      "title": "systemd units and socket activation",
      "minutes": 75,
      "level": "industry",
      "goal": "Run a Rust service under systemd with the right unit type, notify readiness, inherit a listening socket, and keep restarts bounded.",
      "sections": [
        {
          "h": "The unit fields that decide behaviour",
          "p": [
            "A service unit is small, but four fields explain most production incidents. Type decides when systemd considers the service started: simple means immediately after fork, notify means when the process sends READY=1. Restart plus RestartSec decide the crash policy, and TimeoutStopSec decides how long SIGTERM is allowed to work before SIGKILL.",
            "KillMode=mixed is the right default for a supervised service: SIGTERM to the main process only, then SIGKILL to the whole cgroup after the timeout, so a cooperative parent can stop its children in order. StartLimitIntervalSec and StartLimitBurst live in the [Unit] section and bound the restart loop; without them a bad config restarts forever."
          ],
          "code": "[Unit]\nDescription=Rust job runner\nAfter=network-online.target postgresql.service\nWants=network-online.target\n# At most 5 starts in 60s, then systemd gives up and enters failed state.\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]\nType=notify\nExecStart=/usr/local/bin/job-runner --config /etc/job-runner.toml\nRestart=on-failure\nRestartSec=2s\nTimeoutStopSec=30\nKillMode=mixed\nWatchdogSec=20\nNotifyAccess=main\nUser=jobrunner\nGroup=jobrunner\nEnvironment=RUST_LOG=info\n\n[Install]\nWantedBy=multi-user.target",
          "tip": "After editing a unit run `systemctl daemon-reload`; after editing the binary run `systemctl restart`. Forgetting the first makes every later diagnosis wrong."
        },
        {
          "h": "Type=notify is a readiness contract",
          "p": [
            "With Type=notify, systemd holds the service in the activating state until the process writes READY=1 to the notification socket. That is the correct type for a service that runs migrations or loads a cache at boot: simple would report success before the first query works, and dependents would start against a process that is not ready.",
            "sd-notify 0.5 exposes this as notify(&[NotifyState::Ready]); the older two-argument form is gone. Send MAINPID when you fork a worker, STOPPING=1 when the drain starts, and WATCHDOG=1 on an interval shorter than WatchdogSec. If no notification arrives, systemd kills and restarts the service, which is exactly the behaviour you want for a wedged event loop."
          ],
          "code": "use sd_notify::{notify, NotifyState};\nuse std::time::Duration;\n\npub async fn boot(pool: &sqlx::PgPool) -> anyhow::Result<()> {\n    sqlx::migrate!(\"./migrations\").run(pool).await?;\n\n    // The service is only \"started\" once it can actually serve.\n    notify(&[\n        NotifyState::Ready,\n        NotifyState::Status(\"migrations applied, accepting work\"),\n    ])?;\n    Ok(())\n}\n\n/// Call every WatchdogSec / 3 while the runtime is making progress.\npub async fn watchdog(token: tokio_util::sync::CancellationToken) {\n    let mut tick = tokio::time::interval(Duration::from_secs(7));\n    loop {\n        tokio::select! {\n            _ = token.cancelled() => break,\n            _ = tick.tick() => {\n                let _ = notify(&[NotifyState::Watchdog]);\n            }\n        }\n    }\n}",
          "tip": "A watchdog that is sent by a timer task proves only that the timer works. Send it from the loop that does the work, or it will happily report a deadlocked worker as healthy."
        },
        {
          "h": "Socket activation: let systemd hold the socket",
          "p": [
            "With a .socket unit, systemd creates the listening socket and passes it to the service as file descriptor 3, described by LISTEN_FDS and LISTEN_PID. The service never binds, so the socket survives restarts: connections queue in the kernel backlog while the old process exits and the new one starts, and a restart stops being a connection reset.",
            "Accept=no passes one listening socket, which is what most services want. Accept=yes passes one connected socket per connection and expects the service to handle exactly one; that model is for inetd-style tools and breaks pooling. Read the descriptors with sd_notify::listen_fds(), which validates LISTEN_PID and sets O_CLOEXEC before handing them over."
          ],
          "code": "# job-runner.socket: systemd owns /run/job-runner.sock\n[Unit]\nDescription=Job runner socket\n\n[Socket]\nListenStream=/run/job-runner.sock\nSocketMode=0660\nRemoveOnStop=true\n\n[Install]\nWantedBy=sockets.target\n\n# job-runner.service gains: Requires=job-runner.socket",
          "tip": "Do not bind the same path in code as a fallback when the socket unit is active: two listeners on one path produce EADDRINUSE at the worst possible moment."
        },
        {
          "h": "Consume the inherited descriptor",
          "p": [
            "The descriptor arrives as a plain integer, so taking ownership requires an unsafe FromRawFd conversion. Do it exactly once: double ownership means a double close, and the second close can hit a descriptor the runtime has since reused. Set non-blocking before wrapping it in tokio, or every accept blocks a runtime thread.",
            "Keep a development fallback that binds a path when LISTEN_FDS is absent, so cargo run still works. Gate it on the environment variable rather than on a build feature, and log which path was taken, because the difference between inherited and self-bound sockets explains many permission failures on /run."
          ],
          "code": "use std::os::fd::FromRawFd;\nuse tokio::net::UnixListener;\n\npub fn inherited_socket() -> std::io::Result<UnixListener> {\n    // LISTEN_FDS counts descriptors; they start at fd 3.\n    let mut fds = sd_notify::listen_fds()?;\n    let fd = fds.next().ok_or_else(|| {\n        std::io::Error::other(\"no socket passed: is job-runner.socket active?\")\n    })?;\n\n    // SAFETY: systemd passed ownership of this descriptor to this process\n    // exactly once, and nothing else in the program closes it.\n    let listener = unsafe { std::os::unix::net::UnixListener::from_raw_fd(fd) };\n    listener.set_nonblocking(true)?;\n    UnixListener::from_std(listener)\n}",
          "tip": "`systemd-analyze verify job-runner.service` catches unknown directives and bad paths before you deploy; run it in CI on every unit file."
        }
      ],
      "exercise": {
        "prompt": "Implement inherited_socket: read the descriptors systemd passed, reject the case where none arrived, set the listener non-blocking, and convert fd 3 into a tokio UnixListener. Also implement bind_fallback for local development.",
        "starter": "use std::os::fd::FromRawFd;\nuse tokio::net::UnixListener;\n\n// TODO: sd_notify::listen_fds(), take the first fd, from_raw_fd, set\n// non-blocking, UnixListener::from_std.\npub fn inherited_socket() -> std::io::Result<UnixListener> {\n    todo!()\n}\n\npub fn bind_fallback(path: &str) -> std::io::Result<UnixListener> {\n    let _ = path;\n    todo!()\n}",
        "hint": "listen_fds returns an ExactSizeIterator<Item = RawFd>. Wrap std::os::unix::net::UnixListener::from_raw_fd(fd) in unsafe, call set_nonblocking(true), then UnixListener::from_std. Remove a stale socket path before binding in the fallback.",
        "solution": "use std::os::fd::FromRawFd;\nuse tokio::net::UnixListener;\n\npub fn inherited_socket() -> std::io::Result<UnixListener> {\n    let mut fds = sd_notify::listen_fds()?;\n    let fd = fds.next().ok_or_else(|| {\n        std::io::Error::other(\"no socket passed: is job-runner.socket active?\")\n    })?;\n\n    // SAFETY: systemd passed this descriptor to us exactly once.\n    let listener = unsafe { std::os::unix::net::UnixListener::from_raw_fd(fd) };\n    listener.set_nonblocking(true)?;\n    UnixListener::from_std(listener)\n}\n\npub fn bind_fallback(path: &str) -> std::io::Result<UnixListener> {\n    // Binding over an existing path fails; remove the stale socket first.\n    match std::fs::remove_file(path) {\n        Ok(()) => tracing::warn!(path, \"removed stale socket\"),\n        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}\n        Err(err) => return Err(err),\n    }\n    UnixListener::bind(path)\n}"
      },
      "production": [
        "Every long-running unit uses Type=notify or Type=exec, never Type=simple with a slow boot.",
        "StartLimitBurst is set, so a bad config ends in failed state instead of an endless restart loop.",
        "TimeoutStopSec exceeds the drain budget, and KillMode=mixed lets the parent stop its children.",
        "The socket path is owned by the service user, and the service works with or without socket activation.",
        "systemd-analyze verify runs in CI on every unit and socket file."
      ],
      "crates": [
        "sd-notify",
        "tokio",
        "sqlx",
        "tracing"
      ],
      "github": [
        {
          "name": "systemd/systemd - units, sd_notify, and socket activation",
          "url": "https://github.com/systemd/systemd"
        },
        {
          "name": "mitsuhiko/listenfd - inherited listeners for development",
          "url": "https://github.com/mitsuhiko/listenfd"
        }
      ],
      "pitfall": "Using Type=simple for a service that runs migrations: systemd reports it started, dependents connect, and the first requests fail against unapplied schema while the unit looks healthy.",
      "questions": [
        {
          "q": "A service uses Type=notify but never sends READY=1. What does systemd do?",
          "options": [
            "Treats the unit as started as soon as the process is forked",
            "Keeps the unit in the activating state until the start timeout, then fails and applies the restart policy",
            "Sends SIGTERM immediately after ExecStart returns",
            "Disables the watchdog for that unit"
          ],
          "answer": 1,
          "explain": "Type=notify is a contract: the service is not started until READY=1. Without it the start job times out, systemd marks the unit failed, and Restart= takes over."
        },
        {
          "q": "With Accept=no on a .socket unit, what does the service receive?",
          "options": [
            "One connected socket per accepted connection",
            "A single listening socket on fd 3, described by LISTEN_FDS",
            "A pipe that carries connection metadata",
            "Nothing until the first connection, then one connected socket"
          ],
          "answer": 1,
          "explain": "Accept=no passes the listening socket itself, so the service accepts in its own loop. Accept=yes launches one service instance per connection, which is the inetd model."
        },
        {
          "q": "Why does socket activation make restarts lossless for connections?",
          "options": [
            "systemd buffers application payloads in memory",
            "systemd keeps the listening socket open, so the kernel backlog holds connection attempts across the restart",
            "The kernel retries the TCP handshake at the client",
            "Connections are held by the old process until the new one is ready"
          ],
          "answer": 1,
          "explain": "The listening socket outlives the process. Clients that connect during a restart complete the handshake into the backlog and are accepted by the new process."
        }
      ],
      "quickbytes": [
        "Type=notify plus READY=1 after migrations is the honest startup contract.",
        "Bound restart loops with StartLimitBurst in [Unit], not with hope.",
        "Read the inherited socket exactly once and set it non-blocking before tokio sees it."
      ],
      "resources": [
        {
          "title": "systemd source: sd_listen_fds(3) semantics",
          "url": "https://github.com/systemd/systemd/blob/main/man/sd_listen_fds.xml",
          "kind": "docs"
        },
        {
          "title": "sd-notify crate: notify, listen_fds, watchdog",
          "url": "https://docs.rs/sd-notify/latest/sd_notify/",
          "kind": "docs"
        },
        {
          "title": "listenfd: inherited descriptors and local development",
          "url": "https://docs.rs/listenfd/latest/listenfd/",
          "kind": "docs"
        },
        {
          "title": "systemd repository: unit grammar and behaviour",
          "url": "https://github.com/systemd/systemd",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "p12",
      "title": "Daemonising and journald logging",
      "minutes": 65,
      "level": "industry",
      "goal": "Decide whether to daemonise at all, do it in the correct order when you must, and ship structured logs to journald instead of a file nobody rotates.",
      "sections": [
        {
          "h": "Under a supervisor, do not daemonise",
          "p": [
            "systemd, Docker, and Kubernetes all want a foreground process: they own the lifetime, capture stdout, and deliver signals to the main process. A double fork breaks all three. The parent exits, the supervisor thinks the service stopped, the grandchild is reparented, and its logs go to a file you will never rotate.",
            "Type=forking and a pidfile exist for legacy software that cannot run in the foreground. New code should not join them. If you must daemonise, for a SysV host or an SSH session, do it before any thread or tokio runtime exists, because after fork only async-signal-safe calls are allowed in the child."
          ],
          "code": "use std::os::fd::AsRawFd;\n\n/// Must run before any thread or tokio runtime exists.\npub fn daemonise() -> nix::Result<()> {\n    // SAFETY: single-threaded here, so no lock or allocator state is copied.\n    match unsafe { nix::unistd::fork() }? {\n        nix::unistd::ForkResult::Parent { .. } => std::process::exit(0),\n        nix::unistd::ForkResult::Child => {}\n    }\n    nix::unistd::setsid()?; // new session: no controlling terminal\n\n    // Second fork: the grandchild can never reacquire a terminal.\n    match unsafe { nix::unistd::fork() }? {\n        nix::unistd::ForkResult::Parent { .. } => std::process::exit(0),\n        nix::unistd::ForkResult::Child => {}\n    }\n\n    std::env::set_current_dir(\"/\")?;\n    let devnull = std::fs::OpenOptions::new()\n        .read(true)\n        .write(true)\n        .open(\"/dev/null\")?;\n    // SAFETY: dup2 onto the standard descriptors; the file stays open.\n    unsafe {\n        libc::dup2(devnull.as_raw_fd(), libc::STDIN_FILENO);\n        libc::dup2(devnull.as_raw_fd(), libc::STDOUT_FILENO);\n        libc::dup2(devnull.as_raw_fd(), libc::STDERR_FILENO);\n    }\n    Ok(())\n}",
          "tip": "A pidfile is not a lock. Write it after the final fork, with O_EXCL, and keep a flock on it; otherwise two starts race and the second overwrites the first's pid."
        },
        {
          "h": "journald is the sink, not a file",
          "p": [
            "When stdout is connected to journald, every line is tagged with the unit, the syslog identifier, the pid, and the boot id. journalctl can then filter by unit or field, and the journal handles rotation and rate limiting. Writing your own log file reimplements all of that badly and usually without a size cap.",
            "tracing-journald sends each event as a native journal entry, so span fields become journal fields you can query with `journalctl -u job-runner JOB_ID=abc`. That is the difference between grepping text and filtering records, and it is worth the extra dependency on Linux."
          ],
          "code": "use tracing_subscriber::layer::SubscriberExt;\nuse tracing_subscriber::util::SubscriberInitExt;\nuse tracing_subscriber::EnvFilter;\n\npub fn init(filter: &str) -> anyhow::Result<()> {\n    let registry = tracing_subscriber::registry().with(EnvFilter::try_new(filter)?);\n\n    match tracing_journald::layer() {\n        Ok(journald) => registry.with(journald).try_init()?,\n        Err(err) => {\n            // No journal socket: running outside a unit, so fall back.\n            eprintln!(\"journald unavailable ({err}), logging to stderr\");\n            registry.with(tracing_subscriber::fmt::layer()).try_init()?;\n        }\n    }\n    Ok(())\n}",
          "tip": "Set RateLimitBurst and RateLimitIntervalSec deliberately. The default drops messages under a log storm, and a missing message during an incident looks exactly like a code path that never ran."
        },
        {
          "h": "Logs that survive aggregation",
          "p": [
            "One event per line, stable field names, and an error chain rendered explicitly. tracing's %err is Display and ?err is Debug; pick one per field and keep it stable, because a dashboard that parses your message text breaks the moment somebody edits a sentence.",
            "High-cardinality values belong in fields, not in metric labels or log-derived index keys. A job id in every line is fine for journalctl; the same id as a Prometheus label blows up the time series count. And never log the payload of a job: logs are the least protected copy of your data."
          ],
          "list": [
            "Fields: service, job_id, queue, attempt, outcome, duration_ms",
            "Errors: log the source chain once, at the boundary, not at every layer",
            "Never log secrets, tokens, or full job payloads; log sizes and hashes instead",
            "Keep the message short and the fields rich; messages are for humans, fields are for queries"
          ],
          "tip": "Check what journald actually received with `journalctl -u job-runner -o json | jq '.JOB_ID'` before trusting any dashboard built on those fields."
        }
      ],
      "exercise": {
        "prompt": "Implement init(filter): build an EnvFilter, install a tracing-journald layer when the journal socket exists, and fall back to a stderr fmt layer when it does not. Return an error only if filter parsing fails.",
        "starter": "use tracing_subscriber::layer::SubscriberExt;\nuse tracing_subscriber::util::SubscriberInitExt;\nuse tracing_subscriber::EnvFilter;\n\n// TODO: registry().with(EnvFilter), then match tracing_journald::layer().\npub fn init(filter: &str) -> anyhow::Result<()> {\n    let _ = (filter, tracing_journald::layer());\n    Ok(())\n}",
        "hint": "tracing_journald::layer() returns Result<Layer, io::Error>. Build the registry first, then in each match arm call registry.with(...).try_init(). try_init fails if a global subscriber is already set.",
        "solution": "use tracing_subscriber::layer::SubscriberExt;\nuse tracing_subscriber::util::SubscriberInitExt;\nuse tracing_subscriber::EnvFilter;\n\npub fn init(filter: &str) -> anyhow::Result<()> {\n    let registry = tracing_subscriber::registry().with(EnvFilter::try_new(filter)?);\n\n    match tracing_journald::layer() {\n        Ok(journald) => registry.with(journald).try_init()?,\n        Err(err) => {\n            eprintln!(\"journald unavailable ({err}), logging to stderr\");\n            registry.with(tracing_subscriber::fmt::layer()).try_init()?;\n        }\n    }\n    Ok(())\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn rejects_an_invalid_filter() {\n        assert!(init(\"this is not a filter\").is_err());\n    }\n}"
      },
      "production": [
        "The service runs in the foreground under its supervisor; daemonising exists only for legacy hosts.",
        "If a pidfile exists, it is written after the final fork, created with O_EXCL, and protected by flock.",
        "Logs go to journald or stdout, never to an application-managed file without rotation.",
        "Structured fields are documented and queried by name; no dashboard parses message text.",
        "RateLimitBurst is tuned and a dropped-message counter is reviewed after incidents."
      ],
      "crates": [
        "tracing",
        "tracing-subscriber",
        "tracing-journald",
        "nix"
      ],
      "github": [
        {
          "name": "tokio-rs/tracing - structured logging and the journald layer",
          "url": "https://github.com/tokio-rs/tracing"
        },
        {
          "name": "systemd/systemd - journald and unit documentation",
          "url": "https://github.com/systemd/systemd"
        }
      ],
      "pitfall": "Forking after the tokio runtime has started worker threads: the child inherits locks held by threads that no longer exist, and the process deadlocks in the allocator or the logger on its first allocation.",
      "questions": [
        {
          "q": "Why must daemonise() run before the tokio runtime is created?",
          "options": [
            "Because tokio refuses to start in a session leader",
            "Because after fork in a multithreaded process only the calling thread survives, including any locks it did not hold",
            "Because setsid resets the runtime's timer wheel",
            "Because the runtime registers a SIGCHLD handler that fork removes"
          ],
          "answer": 1,
          "explain": "The child of a multithreaded fork has one thread and the memory of many, including mutexes held by threads that do not exist in the child. Only async-signal-safe calls are legal until exec."
        },
        {
          "q": "journald drops some of your log lines during a burst. Where do you look first?",
          "options": [
            "The tracing subscriber filter",
            "RateLimitIntervalSec and RateLimitBurst in journald.conf",
            "The filesystem permissions on /var/log",
            "The kernel's dmesg buffer"
          ],
          "answer": 1,
          "explain": "journald rate-limits per unit by default. Raise the burst or reduce log volume at the source, and check the suppression notice in the journal."
        },
        {
          "q": "Which log field is safe to use as a Prometheus label?",
          "options": [
            "job_id",
            "request_id",
            "queue name",
            "user email"
          ],
          "answer": 2,
          "explain": "Queue names are a small, bounded set. Job, request, and user identifiers are unbounded and would create one time series per value, which is how metrics backends fall over."
        }
      ],
      "quickbytes": [
        "Foreground plus journald beats a double fork on every axis a supervisor cares about.",
        "Write the pidfile after the last fork, with O_EXCL and a flock; a pidfile alone is not a lock.",
        "Put identifiers in journal fields, never in metric labels."
      ],
      "resources": [
        {
          "title": "daemon(7): the double-fork recipe and its caveats",
          "url": "https://man7.org/linux/man-pages/man7/daemon.7.html",
          "kind": "docs"
        },
        {
          "title": "fork(2): what is safe between fork and exec",
          "url": "https://man7.org/linux/man-pages/man2/fork.2.html",
          "kind": "docs"
        },
        {
          "title": "tracing-journald: structured events to the journal",
          "url": "https://docs.rs/tracing-journald/latest/tracing_journald/",
          "kind": "docs"
        },
        {
          "title": "systemd repository: journald configuration and fields",
          "url": "https://github.com/systemd/systemd",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "p13",
      "title": "Autoscaling workers by queue depth",
      "minutes": 70,
      "level": "industry",
      "goal": "Turn queue depth and job age into a replica count with a control loop that has a step limit, a cooldown, and a floor, instead of scaling on CPU.",
      "sections": [
        {
          "h": "Depth is lagging; age is what users feel",
          "p": [
            "CPU is a poor scaling signal for a worker that waits on a database or an HTTP API: it idles at 15 percent while the queue grows. Queue depth is better, but depth alone cannot tell a burst from a stall: a consumer that has died also produces a growing depth, and so does a sudden surge of new work.",
            "Oldest-job age separates the two. Little's law says the number in the system equals arrival rate times time in system, so if age is rising while depth is flat, throughput has fallen and the answer is a fix, not more replicas. Size from arrival rate and service time, and use age as the alarm."
          ],
          "code": "use std::time::Duration;\n\npub fn required_workers(arrivals_per_sec: f64, p95_secs: f64, target_util: f64) -> u32 {\n    assert!(target_util > 0.0 && target_util < 1.0, \"util must be in (0, 1)\");\n    // Little's law: L = lambda * W, then divide by headroom.\n    let in_flight = arrivals_per_sec * p95_secs;\n    (in_flight / target_util).ceil().max(1.0) as u32\n}\n\n#[derive(Debug)]\npub struct AgeAlert {\n    pub threshold: Duration,\n}\n\nimpl AgeAlert {\n    /// Age, not depth, is the user-visible symptom.\n    pub fn is_slow(&self, oldest_secs: u64) -> bool {\n        Duration::from_secs(oldest_secs) > self.threshold\n    }\n}",
          "tip": "Compute target_util from your SLO, not from a feeling. A queue at 90 percent utilisation has a latency blow-up long before it saturates."
        },
        {
          "h": "A control loop, not a reaction",
          "p": [
            "One depth sample is noise. Feed the controller a smoothed value, clamp the result to a floor and ceiling, and limit how far one decision may move the fleet. Scaling from 2 to 40 in one step is how a cold dependency receives a thundering herd of new workers that all connect at once.",
            "Scale up fast and scale down slowly. Up is cheap in latency and expensive in capacity; down is the reverse, and a premature scale-down that immediately scales back up is a flap that costs more than the capacity it saved. A scale-down cooldown longer than the job p99 is the simplest defence."
          ],
          "code": "pub struct ScalePolicy {\n    pub min: u32,\n    pub max: u32,\n    pub jobs_per_worker: u32,\n    pub step: u32,\n}\n\npub fn desired(policy: &ScalePolicy, depth: u64, current: u32) -> u32 {\n    let needed = (depth as f64 / policy.jobs_per_worker as f64).ceil() as u32;\n    let target = needed.clamp(policy.min, policy.max);\n\n    if target > current {\n        // Scale up quickly, but never jump the whole gap at once.\n        (current + policy.step).min(target)\n    } else if target < current {\n        // Scale down one worker at a time, never below the floor.\n        let down = current.saturating_sub(1);\n        down.max(policy.min).max(target)\n    } else {\n        current\n    }\n}",
          "tip": "Keep the controller a pure function and test it with a table of (depth, current) cases. Autoscalers fail on the edge cases, not on the happy path."
        },
        {
          "h": "When the broker buffers, depth lies",
          "p": [
            "If the broker pushes batches to consumers, the queue looks empty while every worker is saturated: the backlog exists in prefetched messages and in-flight requests. Use broker-side lag or in-flight count, not the application's own counter, or you will scale to one replica during the exact incident that needed forty.",
            "Kubernetes exposes this through an External metric, and the HPA still applies its own behaviour rules on top of your value. Set scaleUp and scaleDown policies explicitly; the default scale-down stabilization window is five minutes, which silently overrides a controller you thought was in charge."
          ],
          "code": "apiVersion: autoscaling/v2\nkind: HorizontalPodAutoscaler\nmetadata:\n  name: job-runner\nspec:\n  scaleTargetRef:\n    apiVersion: apps/v1\n    kind: Deployment\n    name: job-runner\n  minReplicas: 2\n  maxReplicas: 40\n  behavior:\n    scaleUp:\n      stabilizationWindowSeconds: 0\n      policies:\n        - type: Percent\n          value: 100\n          periodSeconds: 30\n    scaleDown:\n      stabilizationWindowSeconds: 300\n      policies:\n        - type: Pods\n          value: 2\n          periodSeconds: 60\n  metrics:\n    - type: External\n      external:\n        metric:\n          name: job_queue_depth\n          selector:\n            matchLabels:\n              queue: default\n        target:\n          type: AverageValue\n          averageValue: \"20\"",
          "tip": "Every replica opens its own database pool. max_connections divided by pool size is a hard ceiling on replicas; scaling past it converts a queue problem into a connection-refused problem."
        },
        {
          "h": "Floor, ceiling, and scale to zero",
          "p": [
            "The floor is not one. Keep at least two replicas so a node drain does not take the whole worker fleet, and keep enough capacity to absorb a cold start: the queue grows while a new pod pulls an image and replays a cache. The ceiling is a contract with the downstream, not with the cloud budget.",
            "Scale to zero only when the trigger is a cheap poll and the cold start is inside the latency budget. A worker that takes 90 seconds to become ready should never scale to zero behind a queue with a 30-second SLO, because the first job after idle always misses."
          ],
          "list": [
            "Floor of two for availability, plus a burst buffer for cold starts",
            "Ceiling derived from the downstream connection budget, written down",
            "Cooldown longer than the p99 job duration to avoid flapping",
            "Scale-to-zero only with a cheap activation path and a generous timeout"
          ],
          "tip": "Record every scaling decision with the inputs that produced it. Reconstructing why the fleet went to forty replicas is impossible from a graph alone."
        }
      ],
      "exercise": {
        "prompt": "Implement desired(policy, depth, current): compute the needed workers from depth and jobs_per_worker, clamp to min and max, move up by at most step per decision, and scale down by one. Add table tests for the floor, the ceiling, and no-op cases.",
        "starter": "pub struct ScalePolicy {\n    pub min: u32,\n    pub max: u32,\n    pub jobs_per_worker: u32,\n    pub step: u32,\n}\n\n// TODO: ceil(depth / jobs_per_worker), clamp, apply the asymmetric step.\npub fn desired(_policy: &ScalePolicy, _depth: u64, _current: u32) -> u32 {\n    1\n}\n\nfn main() {\n    let policy = ScalePolicy { min: 2, max: 40, jobs_per_worker: 20, step: 4 };\n    println!(\"{}\", desired(&policy, 1000, 2));\n}",
        "hint": "Use f64 division with ceil, then clamp. On scale-up return (current + step).min(target); on scale-down return current.saturating_sub(1).max(min).max(target).",
        "solution": "pub struct ScalePolicy {\n    pub min: u32,\n    pub max: u32,\n    pub jobs_per_worker: u32,\n    pub step: u32,\n}\n\npub fn desired(policy: &ScalePolicy, depth: u64, current: u32) -> u32 {\n    let needed = (depth as f64 / policy.jobs_per_worker as f64).ceil() as u32;\n    let target = needed.clamp(policy.min, policy.max);\n\n    if target > current {\n        (current + policy.step).min(target)\n    } else if target < current {\n        current.saturating_sub(1).max(policy.min).max(target)\n    } else {\n        current\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    fn policy() -> ScalePolicy {\n        ScalePolicy { min: 2, max: 40, jobs_per_worker: 20, step: 4 }\n    }\n\n    #[test]\n    fn scales_up_by_at_most_step() {\n        assert_eq!(desired(&policy(), 1_000, 2), 6);\n    }\n\n    #[test]\n    fn never_below_the_floor() {\n        assert_eq!(desired(&policy(), 0, 3), 2);\n        assert_eq!(desired(&policy(), 0, 2), 2);\n    }\n\n    #[test]\n    fn never_above_the_ceiling() {\n        assert_eq!(desired(&policy(), 1_000_000, 39), 40);\n    }\n\n    #[test]\n    fn scales_down_one_at_a_time() {\n        assert_eq!(desired(&policy(), 20, 10), 9);\n    }\n}"
      },
      "production": [
        "Workers scale on queue depth or broker lag, never on CPU alone, and the chosen metric is documented.",
        "Oldest-job age is alerted on separately, because it distinguishes a stall from a burst.",
        "Scale-up is step-limited and scale-down has a cooldown longer than the p99 job duration.",
        "The replica ceiling is derived from the downstream connection budget, not from the budget.",
        "Every scaling decision is logged with its inputs so a fleet size can be explained afterwards."
      ],
      "crates": [
        "tokio",
        "metrics",
        "tracing"
      ],
      "github": [
        {
          "name": "kubernetes/kubernetes - HPA controller and external metrics",
          "url": "https://github.com/kubernetes/kubernetes"
        }
      ],
      "pitfall": "Scaling on an application-side queue counter while the broker prefetches batches: depth reads zero at full saturation, so the controller scales down exactly when the backlog is largest.",
      "questions": [
        {
          "q": "A worker pool is IO-bound: 15 percent CPU and a growing queue. Which scaling signal is appropriate?",
          "options": [
            "CPU utilisation, because 15 percent means there is headroom",
            "Queue depth or oldest-job age, because CPU does not reflect waiting on IO",
            "Memory usage, because waiting tasks buffer in memory",
            "Replica count itself, scaled linearly with time"
          ],
          "answer": 1,
          "explain": "IO-bound workers idle while work waits. Depth and age measure the backlog the user experiences; CPU stays low until the dependency recovers."
        },
        {
          "q": "Why is a scale-down cooldown longer than the p99 job duration?",
          "options": [
            "Because Kubernetes requires it",
            "Because a job removed mid-flight is lost, and the p99 bounds how long workers must be given",
            "Because metrics are scraped every 60 seconds",
            "Because scale-down costs more than scale-up"
          ],
          "answer": 1,
          "explain": "Scaling down kills the pod, and its in-flight jobs must be finished or requeued. A cooldown below the job duration guarantees work is interrupted on every scale event."
        },
        {
          "q": "With 40 replicas, a pool of 10 connections per replica, and a Postgres max_connections of 200, what happens?",
          "options": [
            "Connections are multiplexed transparently by the pooler",
            "200 of the 400 desired connections fail, so scale-up stops helping and errors look like database failures",
            "Postgres queues the extra connections until a slot is free",
            "The HPA detects the limit and caps itself at 20 replicas"
          ],
          "answer": 1,
          "explain": "Each replica opens its own pool, so the fleet needs replicas x pool_size connections. Exceeding max_connections fails at connect time and masks the real capacity limit."
        }
      ],
      "quickbytes": [
        "Scale on depth or lag; alert on age. They answer different questions.",
        "Cap the step: a jump from 2 to 40 is a self-inflicted thundering herd.",
        "max_connections / pool_size is your real maximum replica count."
      ],
      "resources": [
        {
          "title": "Kubernetes Horizontal Pod Autoscaling: behaviour and policies",
          "url": "https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/",
          "kind": "docs"
        },
        {
          "title": "metrics crate: counters, gauges, and histograms",
          "url": "https://docs.rs/metrics/latest/metrics/",
          "kind": "docs"
        },
        {
          "title": "Kubernetes repository: HPA controller implementation",
          "url": "https://github.com/kubernetes/kubernetes",
          "kind": "repo"
        },
        {
          "title": "CNCF: autoscaling and workload talks",
          "url": "https://www.youtube.com/@CNCF",
          "kind": "video"
        }
      ]
    },
    {
      "id": "p14",
      "title": "At-least-once execution and dedupe",
      "minutes": 75,
      "level": "industry",
      "goal": "Make a job safe to run twice: claim it with a lease, commit the effect and the dedupe record together, and size the dedupe window from the retry horizon.",
      "sections": [
        {
          "h": "Delivery is at-least-once; effects must be idempotent",
          "p": [
            "A worker acknowledges a job after doing the work. If it crashes in between, the broker redelivers, because the alternative is losing the job. That gap is not a bug in the broker; it is the price of not having a distributed transaction between the queue and your database.",
            "So the guarantee you build is at-least-once delivery plus idempotent effects, which is effectively-once for the observable state. The idempotency key is the whole design: the same key must produce the same effect no matter how many times the handler runs, including concurrently, which means a uniqueness constraint rather than a read-then-write check."
          ],
          "code": "-- One statement claims a job and extends its lease.\nWITH claimed AS (\n    SELECT id FROM jobs\n    WHERE (status = 'queued' AND run_at <= now())\n       OR (status = 'running' AND lease_until < now())\n    ORDER BY priority DESC, run_at\n    FOR UPDATE SKIP LOCKED\n    LIMIT 1\n)\nUPDATE jobs\n   SET status = 'running',\n       attempts = attempts + 1,\n       lease_until = now() + interval '5 minutes',\n       worker_id = $1\n  FROM claimed\n WHERE jobs.id = claimed.id\nRETURNING jobs.id, jobs.payload, jobs.attempts;",
          "tip": "SKIP LOCKED is what makes N workers scale. Without it, every worker queues behind the same row and throughput is one."
        },
        {
          "h": "A lease, not a lock",
          "p": [
            "A lock held by a crashed worker is held forever; a lease expires. The worker renews the lease while it works, and a sweeper requeues anything whose lease expired. That converts a crash into a bounded delay instead of a stuck queue.",
            "The cost is that two workers can run the same job at once: one paused past its lease, the other after requeue. This is normal, not exceptional, so the handler must tolerate concurrent execution. If it cannot, add fencing: the effect checks the attempt number or a monotonic epoch and rejects writes from a stale attempt."
          ],
          "code": "-- Renew the lease while the job is still running.\n-- Zero rows affected means the lease was lost: stop and do not commit.\nUPDATE jobs\n   SET lease_until = now() + interval '5 minutes'\n WHERE id = $1\n   AND worker_id = $2\n   AND status = 'running'\nRETURNING id;\n\n-- Fencing: a stale worker's write is rejected because the attempt\n-- moved on, so the late write cannot land after a newer one.\nUPDATE jobs\n   SET lease_until = now() + interval '5 minutes'\n WHERE id = $1 AND attempts = $3\nRETURNING id;",
          "tip": "Never make the lease longer than the job's p99 and call it safety. A long lease delays recovery; a short lease requires renewal and fencing. Pick one deliberately."
        },
        {
          "h": "Dedupe at the effect boundary",
          "p": [
            "The dedupe row and the business write must commit in the same transaction. Insert the key with ON CONFLICT DO NOTHING, check rows_affected, and only then apply the effect; if the insert won, the effect is committed in the same transaction, so there is no window where one exists without the other.",
            "A read-then-write check has a race between the SELECT and the INSERT, and two workers both pass it. A unique index does not. This is also why the dedupe table is not a cache: it is part of the correctness proof, and deleting a row early re-opens the exact hole it was meant to close."
          ],
          "code": "use sqlx::PgPool;\n\n#[derive(Debug, PartialEq)]\npub enum Outcome {\n    Executed,\n    Duplicate,\n}\n\npub async fn credit_once(\n    pool: &PgPool,\n    job_key: &str,\n    account: i64,\n    amount: i64,\n) -> sqlx::Result<Outcome> {\n    let mut tx = pool.begin().await?;\n\n    let inserted = sqlx::query(\n        \"INSERT INTO processed_jobs (job_key) VALUES ($1) ON CONFLICT DO NOTHING\",\n    )\n    .bind(job_key)\n    .execute(&mut *tx)\n    .await?\n    .rows_affected();\n\n    if inserted == 0 {\n        tx.rollback().await?; // already applied by an earlier attempt\n        return Ok(Outcome::Duplicate);\n    }\n\n    sqlx::query(\"UPDATE accounts SET balance = balance + $1 WHERE id = $2\")\n        .bind(amount)\n        .bind(account)\n        .execute(&mut *tx)\n        .await?;\n\n    tx.commit().await?;\n    Ok(Outcome::Executed)\n}",
          "tip": "Index the dedupe key and add a created_at column in the same migration. You will need to prune it, and pruning without a timestamp is a full scan."
        },
        {
          "h": "How long does a dedupe row live?",
          "p": [
            "Forever is the safe answer and eventually an operational problem. The defensible minimum is longer than the maximum time a job can be redelivered: max attempts times the retry backoff plus the lease, with margin. If a job can be replayed by an operator next month, the row has to survive that too.",
            "Two designs are common. Keep a bounded window and accept that very old replays may double-apply, or keep the key forever and partition the table by month so pruning is a partition drop. Choose based on whether the effect is money or a notification, and write the choice down where the next on-call engineer will find it."
          ],
          "list": [
            "Retention must exceed max attempts x backoff plus lease duration",
            "Partition by created_at so dropping old keys is O(1), not a delete storm",
            "A manual replay tool must respect the same dedupe table, or it defeats the design",
            "Dedupe on a stable key: client-supplied, or a hash of the immutable payload, never a timestamp"
          ],
          "tip": "Server-computed keys from the payload dedupe identical legitimate repeats too. If a user may send the same request twice on purpose, the client must supply the key."
        }
      ],
      "exercise": {
        "prompt": "Implement claim, which takes one job with SKIP LOCKED and returns its id and attempts, and credit_once, which applies an effect exactly once by committing a dedupe insert and an update in one transaction.",
        "starter": "use sqlx::PgPool;\n\npub struct Claimed {\n    pub id: i64,\n    pub attempts: i32,\n}\n\n// TODO: CTE with FOR UPDATE SKIP LOCKED, then UPDATE ... RETURNING.\npub async fn claim(_pool: &PgPool, _worker: &str) -> sqlx::Result<Option<Claimed>> {\n    Ok(None)\n}\n\n// TODO: insert the dedupe key with ON CONFLICT DO NOTHING; only apply the\n// effect when rows_affected() == 1, and commit both together.\npub async fn credit_once(\n    _pool: &PgPool,\n    _job_key: &str,\n    _account: i64,\n    _amount: i64,\n) -> sqlx::Result<bool> {\n    Ok(false)\n}",
        "hint": "Use query_as with a struct that derives sqlx::FromRow, or query_scalar for the id. In credit_once, begin a transaction, check rows_affected on the insert, and return early without the update when it is zero.",
        "solution": "use sqlx::PgPool;\n\n#[derive(Debug, sqlx::FromRow)]\npub struct Claimed {\n    pub id: i64,\n    pub attempts: i32,\n}\n\npub async fn claim(pool: &PgPool, worker: &str) -> sqlx::Result<Option<Claimed>> {\n    sqlx::query_as::<_, Claimed>(\n        r#\"\n        WITH claimed AS (\n            SELECT id FROM jobs\n            WHERE (status = 'queued' AND run_at <= now())\n               OR (status = 'running' AND lease_until < now())\n            ORDER BY priority DESC, run_at\n            FOR UPDATE SKIP LOCKED\n            LIMIT 1\n        )\n        UPDATE jobs\n           SET status = 'running',\n               attempts = attempts + 1,\n               lease_until = now() + interval '5 minutes',\n               worker_id = $1\n          FROM claimed\n         WHERE jobs.id = claimed.id\n        RETURNING jobs.id, jobs.attempts\n        \"#,\n    )\n    .bind(worker)\n    .fetch_optional(pool)\n    .await\n}\n\npub async fn credit_once(\n    pool: &PgPool,\n    job_key: &str,\n    account: i64,\n    amount: i64,\n) -> sqlx::Result<bool> {\n    let mut tx = pool.begin().await?;\n\n    let inserted = sqlx::query(\n        \"INSERT INTO processed_jobs (job_key) VALUES ($1) ON CONFLICT DO NOTHING\",\n    )\n    .bind(job_key)\n    .execute(&mut *tx)\n    .await?\n    .rows_affected();\n\n    if inserted == 0 {\n        tx.rollback().await?;\n        return Ok(false);\n    }\n\n    sqlx::query(\"UPDATE accounts SET balance = balance + $1 WHERE id = $2\")\n        .bind(amount)\n        .bind(account)\n        .execute(&mut *tx)\n        .await?;\n    tx.commit().await?;\n    Ok(true)\n}"
      },
      "production": [
        "Every handler has an idempotency key with a unique constraint, and the effect commits in the same transaction.",
        "Job claims use a lease with renewal, and a sweeper requeues expired leases.",
        "Dedupe retention is documented and exceeds the maximum redelivery horizon.",
        "Handlers tolerate concurrent execution of the same key, or use fencing to reject stale attempts.",
        "Attempts are capped and exhausted jobs move to a dead-letter state with the last error attached."
      ],
      "crates": [
        "sqlx",
        "tokio",
        "tracing",
        "uuid"
      ],
      "github": [
        {
          "name": "launchbadge/sqlx - async SQL, transactions, and pools",
          "url": "https://github.com/transact-rs/sqlx"
        }
      ],
      "pitfall": "Checking for a duplicate with SELECT before INSERT: two workers both see nothing, both insert and both apply the effect. Only a unique index plus ON CONFLICT closes that race.",
      "questions": [
        {
          "q": "A worker commits its effect, then crashes before acknowledging the job. What happens, and is it safe?",
          "options": [
            "The job is lost, because the ack never arrived",
            "The job is redelivered; the handler sees the dedupe row and skips the effect",
            "The broker marks the job complete from the commit log",
            "The effect is rolled back by the broker"
          ],
          "answer": 1,
          "explain": "At-least-once means a missing ack causes redelivery. The dedupe row committed with the effect makes the second run a no-op, which is what effectively-once means."
        },
        {
          "q": "Two workers run the same job because one paused past its lease. What is the correct response?",
          "options": [
            "Prevent it by making leases infinite",
            "Accept it: the handler must be idempotent, or reject stale attempts with a fencing check",
            "Disable SKIP LOCKED so only one worker can claim",
            "Delete the job from the queue on the first execution"
          ],
          "answer": 1,
          "explain": "Leases expire by design, so concurrent execution is always possible. Either the effect is idempotent, or the write checks the attempt epoch and refuses stale workers."
        },
        {
          "q": "The dedupe table keeps keys for one hour, but retries can happen for six hours. What is the failure?",
          "options": [
            "A key collision between different jobs",
            "A late retry finds no key and applies the effect a second time",
            "The unique index stops enforcing uniqueness",
            "The handler blocks on the missing key"
          ],
          "answer": 1,
          "explain": "Retention is part of the guarantee. If a redelivery can arrive after the key is pruned, the duplicate check passes and the effect runs twice."
        }
      ],
      "quickbytes": [
        "Insert the dedupe key with ON CONFLICT DO NOTHING and commit it with the effect.",
        "Leases expire; locks do not. Expiry means duplicates, so handlers must be idempotent.",
        "Dedupe retention must outlive the longest possible redelivery, including manual replays."
      ],
      "resources": [
        {
          "title": "sqlx: transactions and query execution",
          "url": "https://docs.rs/sqlx/latest/sqlx/",
          "kind": "docs"
        },
        {
          "title": "PostgreSQL INSERT: ON CONFLICT and RETURNING",
          "url": "https://www.postgresql.org/docs/current/sql-insert.html",
          "kind": "docs"
        },
        {
          "title": "sqlx repository: pool and transaction internals",
          "url": "https://github.com/transact-rs/sqlx",
          "kind": "repo"
        },
        {
          "title": "InfoQ: idempotency, retries, and exactly-once claims",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        }
      ]
    },
    {
      "id": "p15",
      "title": "Job prioritisation and fairness",
      "minutes": 65,
      "level": "advanced",
      "goal": "Serve urgent work first without starving bulk work: choose a queue discipline, enforce weighted fairness per tenant, and avoid head-of-line blocking.",
      "sections": [
        {
          "h": "Strict priority starves the tail",
          "p": [
            "A single priority queue is seductive: pop the highest priority job, done. Under sustained load, low-priority work never runs, and the queue for it grows without bound. Worse, priority inheritance problems appear: a high-priority job that needs a low-priority job's output waits forever, and nothing in the scheduler knows that.",
            "Aging, incrementing priority with wait time, bounds starvation but destroys the meaning of priority, because eventually everything is urgent. The cleaner answer is reserved capacity: a fixed share of workers always serves the bulk class, and the remainder is divided by weight. Bulk work gets slower under load, never starved."
          ],
          "code": "pub struct Reservation {\n    /// Workers always available to the bulk class, regardless of load.\n    pub bulk_floor: usize,\n    pub total: usize,\n}\n\nimpl Reservation {\n    pub fn workers_for(&self, class: Class) -> usize {\n        match class {\n            Class::Bulk => self.bulk_floor,\n            Class::Interactive => self.total - self.bulk_floor,\n        }\n    }\n}\n\n#[derive(Clone, Copy, Debug, PartialEq)]\npub enum Class {\n    Bulk,\n    Interactive,\n}",
          "tip": "Priorities are a product decision with a support cost. Cap the number of classes at three, and document the SLA each one actually gets."
        },
        {
          "h": "Weighted fair queueing in one struct",
          "p": [
            "Weighted fair queueing picks the class with the smallest served-to-weight ratio, so over time each class gets its share and no class is starved. When a class is empty, its share goes to whoever has work, which keeps the pool work-conserving instead of idling reserved capacity.",
            "Fixed-point arithmetic avoids float drift and makes the tests deterministic. Compare served times one thousand divided by weight, and the ordering stays stable after millions of picks, where an f64 starts tying on values that differ by less than its precision. The tie-break matters more than it looks: always prefer the lower index, or the ordering depends on hash iteration and the test flakes once a year."
          ],
          "code": "pub struct FairPicker {\n    weights: Vec<u32>,\n    served: Vec<u64>,\n}\n\nimpl FairPicker {\n    pub fn new(weights: &[u32]) -> Self {\n        assert!(!weights.is_empty(), \"at least one class\");\n        assert!(weights.iter().all(|w| *w > 0), \"weights must be positive\");\n        Self { weights: weights.to_vec(), served: vec![0; weights.len()] }\n    }\n\n    /// Smallest served/weight ratio among classes that have work.\n    pub fn next_class(&mut self, depth: &[usize]) -> Option<usize> {\n        assert_eq!(depth.len(), self.weights.len());\n        let mut best: Option<(usize, u64)> = None;\n\n        for (class, weight) in self.weights.iter().enumerate() {\n            if depth[class] == 0 {\n                continue; // work-conserving: skip empty classes\n            }\n            let cost = self.served[class] * 1_000 / u64::from(*weight);\n            match best {\n                Some((_, best_cost)) if cost >= best_cost => {} // keep first on ties\n                _ => best = Some((class, cost)),\n            }\n        }\n\n        let (class, _) = best?;\n        self.served[class] += 1;\n        Some(class)\n    }\n}",
          "tip": "Do not reset the served counters on a timer. Reset them by subtracting the minimum when every class has been served, or the ratios drift apart under long-running load."
        },
        {
          "h": "Head-of-line blocking is a scheduling bug",
          "p": [
            "One FIFO queue with a ten-minute report ahead of five hundred 20 ms notifications delays every notification by ten minutes. No priority scheme fixes that if the long job has already been admitted to the only lane; the fix is either a separate lane for short work or a scheduler that admits by class.",
            "Separate lanes have a cost: each needs its own concurrency budget, and a saturated short lane still needs a share of workers. The trade-off is explicit, which is the point. Shortest-job-first minimises mean latency but starves long jobs, so in practice it means reserving a lane rather than sorting by duration."
          ],
          "list": [
            "Long jobs get their own lane so they cannot block short ones",
            "Short lanes must still be bounded, or they consume the whole pool",
            "Preemption requires checkpointing; most job runners should not attempt it",
            "Admission control beats reordering: reject or defer work you cannot serve"
          ],
          "tip": "Measure queue time per class, not just overall throughput. A p99 wait of ten minutes in the interactive class is invisible in an aggregate throughput graph."
        },
        {
          "h": "The heap does not preserve FIFO",
          "p": [
            "Rust's BinaryHeap is a max-heap and makes no promise about elements that compare equal, so two jobs with the same priority can come out in any order. That is usually fine, and occasionally it is a fairness bug: a stream of equal-priority jobs can be reordered for reasons nobody can reproduce.",
            "Add a monotonically increasing sequence number and compare it in reverse so lower sequence wins. Deriving Ord on a tuple works, but `Reverse` makes the intent legible and prevents the classic mistake of ordering by sequence in the wrong direction."
          ],
          "code": "use std::cmp::{Ordering, Reverse};\nuse std::collections::BinaryHeap;\n\n#[derive(Eq, PartialEq, Debug)]\npub struct Queued {\n    pub priority: u8,\n    pub seq: u64,\n}\n\nimpl Ord for Queued {\n    fn cmp(&self, other: &Self) -> Ordering {\n        // Higher priority first; within a priority, lower seq first.\n        (self.priority, Reverse(self.seq)).cmp(&(other.priority, Reverse(other.seq)))\n    }\n}\n\nimpl PartialOrd for Queued {\n    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {\n        Some(self.cmp(other))\n    }\n}\n\n#[test]\nfn equal_priority_pops_in_submission_order() {\n    let mut heap = BinaryHeap::new();\n    heap.push(Queued { priority: 1, seq: 2 });\n    heap.push(Queued { priority: 1, seq: 1 });\n    assert_eq!(heap.pop().unwrap().seq, 1);\n}",
          "tip": "A sequence number needs to survive restarts. Use the database sequence that assigned the job, not an in-memory counter, or ordering resets on every deploy."
        }
      ],
      "exercise": {
        "prompt": "Implement FairPicker: given per-class weights and current depths, return the class with the smallest served-to-weight ratio that has work, and increment its served count. Ties go to the lower class index. Add a test showing a 3:1 weight split.",
        "starter": "pub struct FairPicker {\n    weights: Vec<u32>,\n    served: Vec<u64>,\n}\n\nimpl FairPicker {\n    pub fn new(weights: &[u32]) -> Self {\n        Self { weights: weights.to_vec(), served: vec![0; weights.len()] }\n    }\n\n    // TODO: skip empty classes, compare served * 1000 / weight, tie-break\n    // on the lower index, then increment the winner.\n    pub fn next_class(&mut self, _depth: &[usize]) -> Option<usize> {\n        None\n    }\n}",
        "hint": "Track the best (class, cost) pair. On ties keep the earlier class. Multiply before dividing to keep integer precision, and skip a class when its depth is zero so empty shares flow to busy classes.",
        "solution": "pub struct FairPicker {\n    weights: Vec<u32>,\n    served: Vec<u64>,\n}\n\nimpl FairPicker {\n    pub fn new(weights: &[u32]) -> Self {\n        assert!(!weights.is_empty());\n        assert!(weights.iter().all(|w| *w > 0));\n        Self { weights: weights.to_vec(), served: vec![0; weights.len()] }\n    }\n\n    pub fn next_class(&mut self, depth: &[usize]) -> Option<usize> {\n        assert_eq!(depth.len(), self.weights.len());\n        let mut best: Option<(usize, u64)> = None;\n\n        for (class, weight) in self.weights.iter().enumerate() {\n            if depth[class] == 0 {\n                continue;\n            }\n            let cost = self.served[class] * 1_000 / u64::from(*weight);\n            match best {\n                Some((_, best_cost)) if cost >= best_cost => {}\n                _ => best = Some((class, cost)),\n            }\n        }\n\n        let (class, _) = best?;\n        self.served[class] += 1;\n        Some(class)\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn splits_three_to_one_over_eight_picks() {\n        let mut picker = FairPicker::new(&[3, 1]);\n        let depth = [10, 10];\n        let mut counts = [0usize; 2];\n        for _ in 0..8 {\n            let class = picker.next_class(&depth).unwrap();\n            counts[class] += 1;\n        }\n        assert_eq!(counts, [6, 2]);\n    }\n\n    #[test]\n    fn empty_classes_lend_their_share() {\n        let mut picker = FairPicker::new(&[3, 1]);\n        assert_eq!(picker.next_class(&[0, 5]), Some(1));\n        assert_eq!(picker.next_class(&[0, 0]), None);\n    }\n}"
      },
      "production": [
        "At most three priority classes exist, each with a written latency SLA and a named owner.",
        "Bulk work has reserved capacity, so it degrades under load instead of starving.",
        "Queue wait time is measured per class, not just in aggregate.",
        "Long-running work has its own lane or its own worker pool, so it cannot block short jobs.",
        "Priority ordering is stable within a class, backed by a durable sequence, not an in-memory counter."
      ],
      "crates": [
        "tokio",
        "tokio-util",
        "tracing"
      ],
      "github": [
        {
          "name": "tokio-rs/tokio - queues, semaphores, and task scheduling",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "pitfall": "Deriving Ord on a priority-only struct and pushing it into BinaryHeap: equal priorities come out in an arbitrary order, which surfaces later as an unreproducible reordering bug in a fairness-sensitive pipeline.",
      "questions": [
        {
          "q": "Under constant high-priority load, what happens to a single strict-priority queue?",
          "options": [
            "Low-priority jobs are served at a slower but steady rate",
            "Low-priority jobs never run, and their queue grows without bound",
            "The scheduler promotes low-priority jobs automatically",
            "High-priority jobs start failing once the queue is large"
          ],
          "answer": 1,
          "explain": "Strict priority has no fairness term. Without aging or reserved capacity, the low class only runs when the high class is empty, which under sustained load never happens."
        },
        {
          "q": "Which change removes head-of-line blocking for 20 ms notifications stuck behind a ten-minute report?",
          "options": [
            "Increasing worker count for the same FIFO queue",
            "Giving short jobs a separate lane with its own concurrency budget",
            "Raising the report's priority so it finishes sooner",
            "Lowering the notification timeout"
          ],
          "answer": 1,
          "explain": "The blocked job is already admitted ahead of the notifications in the same FIFO. Adding workers helps only if the long job does not occupy them all; a separate lane bounds the delay structurally."
        },
        {
          "q": "A FairPicker shows weight 3 for interactive and 1 for bulk, but bulk gets nothing for an hour. What is the likely bug?",
          "options": [
            "The weights are inverted",
            "The served counters are being reset every tick, so the ratio never accumulates",
            "The picker is not work-conserving",
            "BinaryHeap ordering is unstable"
          ],
          "answer": 1,
          "explain": "WFQ needs accumulated service to compute the ratio. Resetting counters makes the class with the lowest index win every tick, which starves the other classes regardless of weight."
        }
      ],
      "quickbytes": [
        "Reserve capacity for bulk work instead of relying on priority to be fair.",
        "Keep queue time per class; aggregate throughput hides starvation.",
        "Give equal-priority jobs a durable sequence number, or their order is undefined."
      ],
      "resources": [
        {
          "title": "sched(7): Linux scheduling policies and starvation",
          "url": "https://man7.org/linux/man-pages/man7/sched.7.html",
          "kind": "docs"
        },
        {
          "title": "tokio::sync: semaphores and bounded channels for lanes",
          "url": "https://docs.rs/tokio/latest/tokio/sync/index.html",
          "kind": "docs"
        },
        {
          "title": "tokio repository: runtime scheduling internals",
          "url": "https://github.com/tokio-rs/tokio",
          "kind": "repo"
        },
        {
          "title": "InfoQ: queueing theory and fair scheduling in production",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        }
      ]
    },
    {
      "id": "p16",
      "title": "Crash-only design and idempotent restarts",
      "minutes": 60,
      "level": "industry",
      "goal": "Delete the special shutdown path: make every stop look like a crash, every start a recovery, and prove recovery is bounded and repeatable.",
      "sections": [
        {
          "h": "Two stop paths means one is untested",
          "p": [
            "Most services have a graceful path that runs on SIGTERM and a crash path that runs when the process dies. The graceful path is exercised on deploys; the crash path is exercised constantly and never deliberately. Any correctness logic that lives only in the graceful path is logic you cannot trust.",
            "Crash-only design collapses them: there is one way to stop, which is to die, and one way to start, which is to recover. Candea and Fox argued in 2003 that this produces simpler code, because recovery is exercised on every boot rather than on the rare clean shutdown."
          ],
          "code": "// The same entry point for a deploy, an OOM kill, and kill -9.\n#[tokio::main]\nasync fn main() -> anyhow::Result<()> {\n    let pool = db::connect().await?;\n\n    // Recovery runs before readiness, on every boot, with no fast path.\n    let recovered = recover(&pool).await?;\n    tracing::info!(recovered, \"startup reconciliation complete\");\n\n    ready.set(true);\n    serve(pool).await\n}",
          "tip": "If your shutdown handler does something the crash path does not, you have found either a correctness bug or a latency optimisation. Decide which, and label it."
        },
        {
          "h": "Startup must reconcile, not assume",
          "p": [
            "On boot the process knows nothing about what the previous instance left behind: leases held by dead workers, half-written temp files, rows marked running with no owner. Recovery has to reconcile that state before accepting work, and recovery has to be idempotent, because a boot loop will run it repeatedly.",
            "Keep recovery bounded. A million stale rows must not turn a 200 ms boot into a ten-minute one; cap the batch and continue in the background, but do not report ready until the state that affects correctness is consistent. Then make the whole thing repeatable: running it twice must produce the same state."
          ],
          "code": "use sqlx::PgPool;\n\npub async fn recover(pool: &PgPool) -> sqlx::Result<u64> {\n    // Expired leases belong to dead workers; put the work back.\n    let requeued = sqlx::query(\n        \"UPDATE jobs\n            SET status = 'queued', lease_until = NULL, worker_id = NULL\n          WHERE status = 'running'\n            AND lease_until < now()\n            AND attempts < max_attempts\",\n    )\n    .execute(pool)\n    .await?\n    .rows_affected();\n\n    // Exhausted jobs fail deterministically instead of retrying forever.\n    sqlx::query(\n        \"UPDATE jobs SET status = 'dead'\n          WHERE status = 'running' AND lease_until < now() AND attempts >= max_attempts\",\n    )\n    .execute(pool)\n    .await?;\n\n    Ok(requeued) // a second call returns 0: recovery is idempotent\n}",
          "tip": "Run recovery in a test against a database that already contains the state it produces. The second run returning zero is the assertion that proves idempotency."
        },
        {
          "h": "Prove it with kill -9",
          "p": [
            "A crash-only service is only as good as the crashes you have tested. Send SIGKILL at random points during a job, restart, and assert the invariants: no acknowledged job lost, no effect applied twice, recovery under a fixed deadline. Without that test, crash-only is a philosophy rather than a property.",
            "Instrument recovery itself. Duration, rows reconciled, and failures are metrics, because a recovery that silently takes four minutes is a restart loop that never becomes ready while the orchestrator keeps killing it. Treat a slow recovery as an incident of its own: it burns the platform's restart budget and converts one crash into a permanent crash loop."
          ],
          "list": [
            "Chaos test kills the process mid-job and asserts the job is re-executed or completed, never lost",
            "Duplicate effects are asserted with a dedupe key, not assumed",
            "Recovery duration has an SLO and an alert, because it gates readiness",
            "Boot loops are capped by the platform's backoff, and recovery handles being run twice"
          ],
          "tip": "kill -9 in staging is cheap. Discovering the missing recovery branch during a production OOM is not."
        },
        {
          "h": "What crash-only does not excuse",
          "p": [
            "Crash-only is about correctness, not about abandoning latency work. Flushing a batch on a normal stop is still worth doing, because it saves work; it just must not be the only place the data becomes durable. If a clean stop can lose data that a crash would not, the design is inverted.",
            "You also still need ordering: write the file and fsync before you mark the job done, and commit the dedupe row with the effect. Crash-only changes where recovery lives, not what durability requires. The test is simple: pull the power at the worst moment and ask what the next boot can prove."
          ],
          "tip": "Crash-only plus an un-fsynced write is just data loss with a design essay attached. Durability is a separate property; keep them separate in reviews."
        }
      ],
      "exercise": {
        "prompt": "Implement recover(pool): requeue jobs whose lease expired and whose attempts remain, mark exhausted ones dead, and return the number requeued. A second call on the same state must return zero.",
        "starter": "use sqlx::PgPool;\n\n// TODO: one UPDATE for expired leases under max_attempts, one for the\n// exhausted rows, return rows_affected from the first.\npub async fn recover(_pool: &PgPool) -> sqlx::Result<u64> {\n    Ok(0)\n}",
        "hint": "Both statements filter on status = 'running' AND lease_until < now(). The first also requires attempts < max_attempts; the second is its complement. Return rows_affected() from the first UPDATE.",
        "solution": "use sqlx::PgPool;\n\npub async fn recover(pool: &PgPool) -> sqlx::Result<u64> {\n    let requeued = sqlx::query(\n        \"UPDATE jobs\n            SET status = 'queued', lease_until = NULL, worker_id = NULL\n          WHERE status = 'running'\n            AND lease_until < now()\n            AND attempts < max_attempts\",\n    )\n    .execute(pool)\n    .await?\n    .rows_affected();\n\n    sqlx::query(\n        \"UPDATE jobs SET status = 'dead'\n          WHERE status = 'running' AND lease_until < now() AND attempts >= max_attempts\",\n    )\n    .execute(pool)\n    .await?;\n\n    Ok(requeued)\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[tokio::test]\n    #[ignore = \"requires DATABASE_URL and a migrated schema\"]\n    async fn recovery_is_idempotent() {\n        let pool = PgPool::connect(&std::env::var(\"DATABASE_URL\").unwrap())\n            .await\n            .unwrap();\n        let first = recover(&pool).await.unwrap();\n        let second = recover(&pool).await.unwrap();\n        assert_eq!(second, 0, \"second recovery must find nothing to do\");\n        let _ = first;\n    }\n}"
      },
      "production": [
        "Every boot runs the same reconciliation path; there is no clean-shutdown-only correctness logic.",
        "Recovery is idempotent and covered by a test that runs it twice.",
        "Recovery duration and reconciled row counts are metrics, and readiness waits for them.",
        "A kill -9 chaos test asserts no lost acknowledged work and no duplicated effect.",
        "Durability order (write, fsync, mark done) is reviewed separately from crash-only claims."
      ],
      "crates": [
        "sqlx",
        "tokio",
        "tracing"
      ],
      "github": [
        {
          "name": "launchbadge/sqlx - transactions used by recovery paths",
          "url": "https://github.com/transact-rs/sqlx"
        }
      ],
      "pitfall": "Putting the requeue of stale leases in the SIGTERM handler: an OOM kill or a node failure skips it entirely, and those are the failures that actually happen.",
      "questions": [
        {
          "q": "Why does crash-only design make recovery more reliable rather than less?",
          "options": [
            "It removes the need for transactions",
            "Recovery runs on every boot, so it is exercised constantly instead of only after clean shutdowns",
            "It makes crashes impossible by preventing restarts",
            "It moves state into memory so there is nothing to reconcile"
          ],
          "answer": 1,
          "explain": "A path exercised on every start is tested by every deploy, crash, and OOM kill. A graceful-shutdown-only path is exercised rarely and degrades silently."
        },
        {
          "q": "Recovery returns 0 on its second run. What does that demonstrate?",
          "options": [
            "The database is empty",
            "Recovery is idempotent: the first run left no state that the second run acts on",
            "The pool has no connections",
            "The first run failed silently"
          ],
          "answer": 1,
          "explain": "Idempotency means applying the operation twice has the same effect as once. The second run finding nothing is the observable proof."
        },
        {
          "q": "Which requirement does crash-only design NOT remove?",
          "options": [
            "Ordering writes and fsync before marking a job done",
            "The need for a readiness endpoint",
            "The need for bounded recovery",
            "The need for restart backoff"
          ],
          "answer": 0,
          "explain": "Crash-only changes where recovery lives, not what durability requires. An un-fsynced write is lost regardless of how principled the restart path is."
        }
      ],
      "quickbytes": [
        "If only the SIGTERM path does it, an OOM kill will skip it. Move it to recovery.",
        "Recovery must be idempotent; run it twice in a test and assert the second call is a no-op.",
        "Cap recovery work so a large backlog cannot turn a fast boot into a restart loop."
      ],
      "resources": [
        {
          "title": "Crash-Only Software (Candea and Fox, HotOS 2003)",
          "url": "https://www.usenix.org/conference/hotos-ix/crash-only-software",
          "kind": "paper"
        },
        {
          "title": "sqlx: transactions and query execution",
          "url": "https://docs.rs/sqlx/latest/sqlx/",
          "kind": "docs"
        },
        {
          "title": "Kubernetes pod lifecycle: restarts, backoff, and termination",
          "url": "https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/",
          "kind": "docs"
        },
        {
          "title": "InfoQ: designing for failure and recovery",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        },
        {
          "title": "apalis: durable job queues with retries and recovery",
          "url": "https://github.com/apalis-dev/apalis",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "p17",
      "title": "Per-worker resource accounting",
      "minutes": 70,
      "level": "industry",
      "goal": "Attribute CPU, memory, and process counts to each job from cgroup v2 counters and rusage, and turn those numbers into per-class cost metrics.",
      "sections": [
        {
          "h": "Read the counters the kernel already keeps",
          "p": [
            "You rarely need to sample /proc yourself. A cgroup per job exposes cpu.stat with usage_usec, memory.current, memory.peak, pids.current, and memory.events with an oom_kill count. Reading them is four small file reads, and the kernel maintains them whether or not you look.",
            "The important property is that they are charged to the group, not the process: a job that forks four compilers is accounted as one workload, and its children cannot escape the accounting. That is exactly what per-job cost needs, and it is why lesson p07 used the same files for limits."
          ],
          "code": "use std::io;\nuse std::path::Path;\n\n#[derive(Debug, Default, Clone, Copy)]\npub struct Usage {\n    pub cpu_usec: u64,\n    pub memory_peak_bytes: u64,\n    pub pids: u64,\n    pub oom_kills: u64,\n}\n\nfn read_u64(path: &Path) -> io::Result<u64> {\n    Ok(std::fs::read_to_string(path)?.trim().parse()?)\n}\n\nfn read_key(path: &Path, key: &str) -> io::Result<u64> {\n    let text = std::fs::read_to_string(path)?;\n    for line in text.lines() {\n        if let Some((name, value)) = line.split_once(' ') {\n            if name == key {\n                return value.trim().parse().map_err(|err| {\n                    io::Error::new(io::ErrorKind::InvalidData, err)\n                });\n            }\n        }\n    }\n    Err(io::Error::other(format!(\"missing key {key}\")))\n}\n\npub fn read_usage(cgroup: &Path) -> io::Result<Usage> {\n    Ok(Usage {\n        cpu_usec: read_key(&cgroup.join(\"cpu.stat\"), \"usage_usec\")?,\n        memory_peak_bytes: read_u64(&cgroup.join(\"memory.peak\"))?,\n        pids: read_u64(&cgroup.join(\"pids.current\"))?,\n        oom_kills: read_key(&cgroup.join(\"memory.events\"), \"oom_kill\")?,\n    })\n}",
          "tip": "memory.peak exists since Linux 5.19. On older kernels fall back to sampling memory.current, and say so in the cost model, because a sampled peak under-reports short spikes."
        },
        {
          "h": "Counters need deltas and a lifetime",
          "p": [
            "usage_usec is monotonic for the life of the cgroup, so a job's cost is the value at exit, not the value at any sample. If you reuse a cgroup across jobs, subtract the previous reading; if you create one cgroup per job, read it once before deleting it.",
            "Sampling has a resolution problem: a job that runs for 40 ms will be sampled zero or one times. Read the counters at exit instead of polling, and keep polling only for long-running jobs where you want a live gauge. Delete the cgroup only after the read, or the numbers disappear with it."
          ],
          "code": "impl Usage {\n    /// Usage between two readings of the same cgroup.\n    pub fn delta(self, later: Usage) -> Usage {\n        Usage {\n            cpu_usec: later.cpu_usec.saturating_sub(self.cpu_usec),\n            // Peak is a high-water mark, so the later value is the answer.\n            memory_peak_bytes: later.memory_peak_bytes.max(self.memory_peak_bytes),\n            pids: later.pids,\n            oom_kills: later.oom_kills.saturating_sub(self.oom_kills),\n        }\n    }\n}",
          "tip": "Cost per job is CPU-seconds times rate plus GB-seconds times rate. Those two units survive instance changes; a raw percentage does not."
        },
        {
          "h": "getrusage is a trap for per-job numbers",
          "p": [
            "getrusage(RUSAGE_CHILDREN) looks like a per-child API and is not one: it sums CPU and takes the maximum RSS across every child you have ever reaped. Reading it before and after a job gives you the whole process's history, not that job's cost.",
            "wait4 returns rusage for the specific child, which is the right primitive if you need per-job numbers without cgroups. It also gives you the exact CPU time even for a 5 ms child. Use it when a cgroup per job is too heavy; use cgroups when a job spawns a tree."
          ],
          "list": [
            "RUSAGE_CHILDREN: aggregate of all reaped children, never per job",
            "wait4: rusage for one child, including grandchildren only if they were reaped by that child",
            "cgroup: whole subtree, so it captures escaped and double-forked descendants",
            "cpu.stat nr_throttled counts quota throttling, which is a latency signal, not usage"
          ],
          "tip": "If your CPU numbers look impossible, check units first: rusage reports microseconds as timeval, cgroup reports microseconds as integers, and quotas are in microseconds per period."
        },
        {
          "h": "From bytes to a budget",
          "p": [
            "Billing or quota needs a small number of normalised units, not raw counters. CPU-seconds, GB-seconds of peak memory, and process-count peaks cover most abuse. Aggregate into histograms per job class and per tenant; a single average across all jobs tells you nothing actionable.",
            "Beware page cache. memory.current includes file-backed pages the kernel can reclaim, so a job that reads a 2 GB file appears to use 2 GB when its anonymous memory is 30 MB. Read memory.stat and bill anon plus shmem, and treat file pages as cache pressure rather than usage."
          ],
          "tip": "Publish the cost model in the job class definition. A quota that cannot be explained from published numbers gets escalated, and the escalation is always correct."
        }
      ],
      "exercise": {
        "prompt": "Implement read_usage, which parses cpu.stat usage_usec, memory.peak, pids.current, and memory.events oom_kill from a cgroup directory, plus delta, which returns the change between two readings of the same cgroup.",
        "starter": "use std::io;\nuse std::path::Path;\n\n#[derive(Debug, Default, Clone, Copy)]\npub struct Usage {\n    pub cpu_usec: u64,\n    pub memory_peak_bytes: u64,\n    pub pids: u64,\n    pub oom_kills: u64,\n}\n\npub fn read_usage(_cgroup: &Path) -> io::Result<Usage> {\n    Ok(Usage::default())\n}\n\nimpl Usage {\n    pub fn delta(self, _later: Usage) -> Usage {\n        self\n    }\n}",
        "hint": "Split each key-value file on a single space. cpu.stat and memory.events are multi-key, memory.peak and pids.current are single values. In delta use saturating_sub for counters and max for the peak.",
        "solution": "use std::io;\nuse std::path::Path;\n\n#[derive(Debug, Default, Clone, Copy, PartialEq)]\npub struct Usage {\n    pub cpu_usec: u64,\n    pub memory_peak_bytes: u64,\n    pub pids: u64,\n    pub oom_kills: u64,\n}\n\nfn read_u64(path: &Path) -> io::Result<u64> {\n    Ok(std::fs::read_to_string(path)?.trim().parse()?)\n}\n\nfn read_key(path: &Path, key: &str) -> io::Result<u64> {\n    let text = std::fs::read_to_string(path)?;\n    for line in text.lines() {\n        if let Some((name, value)) = line.split_once(' ') {\n            if name == key {\n                return value\n                    .trim()\n                    .parse()\n                    .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err));\n            }\n        }\n    }\n    Err(io::Error::other(format!(\"missing key {key}\")))\n}\n\npub fn read_usage(cgroup: &Path) -> io::Result<Usage> {\n    Ok(Usage {\n        cpu_usec: read_key(&cgroup.join(\"cpu.stat\"), \"usage_usec\")?,\n        memory_peak_bytes: read_u64(&cgroup.join(\"memory.peak\"))?,\n        pids: read_u64(&cgroup.join(\"pids.current\"))?,\n        oom_kills: read_key(&cgroup.join(\"memory.events\"), \"oom_kill\")?,\n    })\n}\n\nimpl Usage {\n    pub fn delta(self, later: Usage) -> Usage {\n        Usage {\n            cpu_usec: later.cpu_usec.saturating_sub(self.cpu_usec),\n            memory_peak_bytes: later.memory_peak_bytes.max(self.memory_peak_bytes),\n            pids: later.pids,\n            oom_kills: later.oom_kills.saturating_sub(self.oom_kills),\n        }\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn delta_is_counter_aware() {\n        let before = Usage { cpu_usec: 100, memory_peak_bytes: 50, pids: 2, oom_kills: 0 };\n        let after = Usage { cpu_usec: 350, memory_peak_bytes: 40, pids: 3, oom_kills: 1 };\n        let d = before.delta(after);\n        assert_eq!(d.cpu_usec, 250);\n        assert_eq!(d.memory_peak_bytes, 50); // peak never decreases\n        assert_eq!(d.oom_kills, 1);\n    }\n}"
      },
      "production": [
        "Each job class has a cost unit (CPU-seconds and GB-seconds) published with its quota.",
        "Accounting reads cgroup counters at exit, before the cgroup directory is removed.",
        "memory.stat anon and shmem drive the memory number; page cache is reported separately.",
        "A job that exceeds its p99 cost triggers a review, not an automatic kill.",
        "Per-class histograms exist; a single fleet-wide average is not treated as a cost signal."
      ],
      "crates": [
        "tokio",
        "metrics",
        "tracing",
        "libc"
      ],
      "github": [
        {
          "name": "torvalds/linux - cgroup v2 implementation and documentation",
          "url": "https://github.com/torvalds/linux"
        }
      ],
      "pitfall": "Reading memory.current at process exit to bill a job: the sample is taken after the work is done and misses the peak, so a memory abuser is billed as a well-behaved job.",
      "questions": [
        {
          "q": "Why is getrusage(RUSAGE_CHILDREN) unsuitable for per-job CPU accounting?",
          "options": [
            "It only reports the current process, not children",
            "It aggregates every child ever reaped, including those from earlier jobs",
            "It resets after each call",
            "It is not available on Linux"
          ],
          "answer": 1,
          "explain": "RUSAGE_CHILDREN is cumulative for all waited children. Use wait4 for one child's rusage, or a cgroup per job for a whole subtree."
        },
        {
          "q": "A job reads a 2 GB file and shows 2 GB in memory.current while its heap is 30 MB. What is happening?",
          "options": [
            "The kernel charges page cache to the cgroup; memory.stat file accounts for it",
            "The job leaked 2 GB of anonymous memory",
            "memory.current is in kilobytes, so it is really 2 MB",
            "The cgroup controller is double-counting shared libraries"
          ],
          "answer": 0,
          "explain": "File-backed pages are charged to the cgroup and are reclaimable. Billing should use anon plus shmem and treat file pages as cache pressure."
        },
        {
          "q": "cpu.stat shows usage_usec flat but nr_throttled climbing. What does that mean?",
          "options": [
            "The job is idle and should be stopped",
            "The job is hitting its cpu.max quota and being throttled, so it is slower than its CPU usage suggests",
            "The CPU is offline",
            "The cgroup controller is not enabled"
          ],
          "answer": 1,
          "explain": "Throttling means the quota, not the workload, is limiting progress. Latency investigations should check nr_throttled before blaming the application."
        }
      ],
      "quickbytes": [
        "Read cgroup counters at exit, before deleting the cgroup directory.",
        "Bill anon plus shmem; page cache is reclaimable and inflates memory.current.",
        "nr_throttled is a latency signal; usage_usec is a cost signal. Do not conflate them."
      ],
      "resources": [
        {
          "title": "Control Group v2: cpu.stat, memory.current, memory.peak",
          "url": "https://docs.kernel.org/admin-guide/cgroup-v2.html",
          "kind": "docs"
        },
        {
          "title": "getrusage(2): RUSAGE_SELF and RUSAGE_CHILDREN semantics",
          "url": "https://man7.org/linux/man-pages/man2/getrusage.2.html",
          "kind": "docs"
        },
        {
          "title": "tokio::task::spawn_blocking for reading counters off the reactor",
          "url": "https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html",
          "kind": "docs"
        },
        {
          "title": "CNCF: resource management and cost attribution talks",
          "url": "https://www.youtube.com/@CNCF",
          "kind": "video"
        },
        {
          "title": "metrics-rs/metrics: emitting the cost gauges you collect",
          "url": "https://github.com/metrics-rs/metrics",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "p18",
      "title": "Sandboxing child processes with seccomp",
      "minutes": 85,
      "level": "industry",
      "goal": "Install a seccomp-bpf allowlist in the child before exec, deny unlisted syscalls with a deliberate errno, and know what seccomp cannot contain.",
      "sections": [
        {
          "h": "An allowlist, checked against the architecture",
          "p": [
            "A seccomp filter is a BPF program over the syscall number and arguments. The kernel documentation is blunt: prefer an allowlist, because a denylist has to be updated every time a dangerous syscall is added, and any value that can be re-expressed slips past it.",
            "Always check the architecture field first. On x86-64 the same processor can issue the x32 ABI, where syscall numbers carry a high bit; a filter that only compares numbers can be bypassed by switching ABI. seccompiler generates the arch check for you, which is a good reason to use it rather than hand-written BPF."
          ],
          "code": "use seccompiler::{SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompRule};\nuse std::collections::BTreeMap;\n\n/// Allowlist: an empty rule vector matches the syscall whatever its args.\npub fn allowlist(allowed: &[i64]) -> BTreeMap<i64, Vec<SeccompRule>> {\n    allowed.iter().map(|nr| (*nr, Vec::new())).collect()\n}\n\n/// fcntl is allowed only for F_GETFD. Conditions inside one rule are ANDed;\n/// rules for the same syscall are ORed.\npub fn guarded() -> BTreeMap<i64, Vec<SeccompRule>> {\n    let getfd = SeccompCondition::new(\n        1, // argument index: fcntl(fd, cmd, ...)\n        SeccompCmpArgLen::Dword,\n        SeccompCmpOp::Eq,\n        libc::F_GETFD as u64,\n    )\n    .expect(\"valid condition\");\n\n    let mut rules = BTreeMap::new();\n    rules.insert(libc::SYS_fcntl, vec![SeccompRule::new(vec![getfd]).expect(\"valid rule\")]);\n    rules\n}",
          "tip": "Build the policy from strace, not imagination: `strace -f -c ./job` lists what actually gets called, and the allowlist is that list minus anything you can remove."
        },
        {
          "h": "Install before exec, with no new privileges",
          "p": [
            "Filters are inherited across fork and preserved across execve, so the practical pattern is a small launcher that installs the filter and then execs the untrusted binary. Installing in the child after exec is too late, and installing in the parent constrains the supervisor instead.",
            "The kernel requires either CAP_SYS_ADMIN or no_new_privs before an unprivileged filter is accepted. Set PR_SET_NO_NEW_PRIVS first; it also prevents setuid binaries from gaining privilege later, which is the point. Then apply the filter with TSYNC so existing threads cannot escape it."
          ],
          "code": "use seccompiler::{apply_filter_all_threads, SeccompAction, SeccompFilter, SeccompRule};\nuse std::collections::BTreeMap;\n\n/// Linux only. Allow exactly these syscall numbers; deny the rest.\npub fn install(allowed: &[i64]) -> Result<(), Box<dyn std::error::Error>> {\n    let rules: BTreeMap<i64, Vec<SeccompRule>> =\n        allowed.iter().map(|nr| (*nr, Vec::new())).collect();\n\n    // mismatch: not in the list -> EPERM. match: in the list -> allow.\n    let filter: seccompiler::BpfProgram = SeccompFilter::new(\n        rules,\n        SeccompAction::Errno(libc::EPERM as u32),\n        SeccompAction::Allow,\n        std::env::consts::ARCH.try_into()?,\n    )?\n    .try_into()?;\n\n    // Required before installing a filter without CAP_SYS_ADMIN.\n    let rc = unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };\n    if rc != 0 {\n        return Err(std::io::Error::last_os_error().into());\n    }\n\n    // TSYNC applies the filter to every thread, not just this one.\n    apply_filter_all_threads(&filter)?;\n    Ok(())\n}",
          "tip": "seccompiler supports x86_64, aarch64, and riscv64, little-endian only. On other architectures the crate does not build, so gate the dependency by target in Cargo.toml."
        },
        {
          "h": "EPERM beats SIGSYS for policy violations",
          "p": [
            "The default action for an unlisted syscall is your choice. Killing the process makes a policy gap look like a crash: the exit status is SIGSYS, the log has no reason, and the on-call engineer debugs the application instead of the sandbox. Returning EPERM lets the child report a normal error that names the operation.",
            "Use SECCOMP_RET_LOG during rollout to record instead of block, and KILL_PROCESS for a small set of syscalls that must never run. Layered filters take the highest-precedence action across all of them, so a permissive filter cannot widen a stricter one."
          ],
          "code": "use seccompiler::{SeccompAction, SeccompFilter};\nuse std::collections::BTreeMap;\n\n/// Rollout mode: log what would be denied and let it through, then read the\n/// audit trail before switching the mismatch action to Errno.\npub fn probe(\n    rules: BTreeMap<i64, Vec<seccompiler::SeccompRule>>,\n) -> Result<seccompiler::BpfProgram, Box<dyn std::error::Error>> {\n    let filter = SeccompFilter::new(\n        rules,\n        SeccompAction::Log,   // not listed: log, then allow\n        SeccompAction::Allow, // listed: allow\n        std::env::consts::ARCH.try_into()?,\n    )?;\n    Ok(filter.try_into()?)\n}\n\n// Only actions named in this sysctl are actually logged.\npub fn logged_actions() -> std::io::Result<String> {\n    std::fs::read_to_string(\"/proc/sys/kernel/seccomp/actions_logged\")\n}",
          "tip": "A SIGSYS with no core dump and no panic message is a seccomp kill, not a Rust bug. Check `Seccomp:` in /proc/<pid>/status before reading the application logs."
        },
        {
          "h": "Seccomp is not a sandbox",
          "p": [
            "The kernel's own documentation says syscall filtering is not a sandbox. The filter cannot dereference pointers, so it cannot see file paths, hostnames, or which file a write targets. Blocking open does not stop openat, and blocking connect does not stop a different socket family.",
            "Layer it. A dedicated uid bounds what the filesystem permissions allow, mount namespaces bound what is visible, Landlock bounds path access for unprivileged processes, and cgroups bound resources. seccomp removes kernel attack surface that nothing else can. Each layer answers a different question, and the job runner needs all of them."
          ],
          "list": [
            "seccomp: which syscalls, with what scalar arguments",
            "Landlock: which paths, for unprivileged processes",
            "namespaces: what is visible at all",
            "uid and capabilities: what permission checks allow",
            "cgroups: how much CPU, memory, and how many processes"
          ],
          "tip": "Test the policy with the real workload, not with a hello-world: dynamically linked binaries and DNS resolution use far more syscalls than a static Rust binary."
        }
      ],
      "exercise": {
        "prompt": "Implement install(allowed): build an allowlist filter that returns EPERM for unlisted syscalls, set PR_SET_NO_NEW_PRIVS, and apply it to all threads. Gate the module on Linux and mark the test ignored, since it must run in a disposable process.",
        "starter": "// Linux-only module.\npub fn install(_allowed: &[i64]) -> Result<(), Box<dyn std::error::Error>> {\n    Ok(())\n}\n\nfn main() {\n    // install(&[libc::SYS_read, libc::SYS_write, libc::SYS_exit_group]).unwrap();\n}",
        "hint": "SeccompFilter::new takes (rules: BTreeMap<i64, Vec<SeccompRule>>, mismatch_action, match_action, arch). Use SeccompAction::Errno(libc::EPERM as u32) and SeccompAction::Allow, then apply_filter_all_threads(&filter).",
        "solution": "use seccompiler::{apply_filter_all_threads, SeccompAction, SeccompFilter, SeccompRule};\nuse std::collections::BTreeMap;\n\npub fn install(allowed: &[i64]) -> Result<(), Box<dyn std::error::Error>> {\n    let rules: BTreeMap<i64, Vec<SeccompRule>> =\n        allowed.iter().map(|nr| (*nr, Vec::new())).collect();\n\n    let filter: seccompiler::BpfProgram = SeccompFilter::new(\n        rules,\n        SeccompAction::Errno(libc::EPERM as u32),\n        SeccompAction::Allow,\n        std::env::consts::ARCH.try_into()?,\n    )?\n    .try_into()?;\n\n    let rc = unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };\n    if rc != 0 {\n        return Err(std::io::Error::last_os_error().into());\n    }\n\n    apply_filter_all_threads(&filter)?;\n    Ok(())\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    #[ignore = \"installs a process-wide filter; run in a disposable process\"]\n    fn denies_unlisted_syscalls() {\n        install(&[libc::SYS_read, libc::SYS_write, libc::SYS_exit_group])\n            .expect(\"filter installs\");\n        // A subsequent unlisted syscall returns EPERM (or kills if policy says so);\n        // assert in a child process, never in the test harness itself.\n    }\n}"
      },
      "production": [
        "Every untrusted job runs under an allowlist filter installed by a launcher before exec.",
        "PR_SET_NO_NEW_PRIVS is set before the filter, and the job runs as a dedicated non-root uid.",
        "Policy violations return EPERM and are counted, rather than appearing as SIGSYS crashes.",
        "The policy is generated from observed strace output and regenerated when the runtime changes.",
        "seccomp is combined with namespaces, Landlock, and cgroups; no single layer is described as a sandbox."
      ],
      "crates": [
        "seccompiler",
        "libc",
        "nix",
        "tracing"
      ],
      "github": [
        {
          "name": "rust-vmm/seccompiler - seccomp-bpf filters in Rust",
          "url": "https://github.com/rust-vmm/seccompiler"
        },
        {
          "name": "firecracker-microvm/firecracker - per-thread seccomp in production",
          "url": "https://github.com/firecracker-microvm/firecracker"
        }
      ],
      "pitfall": "Blocking open because strace showed open, while the binary actually calls openat: the filter allows the real syscall, and the policy looks enforced without being enforced.",
      "questions": [
        {
          "q": "Why must a seccomp filter check the architecture field before the syscall number?",
          "options": [
            "Because syscall numbers are the same on every ABI of one architecture",
            "Because one architecture can use several ABIs, and the same number means different calls in each",
            "Because the architecture field carries the process id",
            "Because BPF cannot compare integers without it"
          ],
          "answer": 1,
          "explain": "On x86-64, x32 syscalls carry a high bit in the number. A number-only filter can be bypassed by issuing the other ABI's call, so the arch check is mandatory."
        },
        {
          "q": "What is the advantage of SECCOMP_RET_ERRNO over killing the process?",
          "options": [
            "It is faster at runtime",
            "The child gets a normal error it can report, instead of a SIGSYS crash that looks like an application bug",
            "It automatically logs to journald",
            "It disables the filter for that syscall"
          ],
          "answer": 1,
          "explain": "Errno keeps the failure attributable: the job logs a denied operation, and the policy gap is visible. A kill produces SIGSYS with no context."
        },
        {
          "q": "A filter allows open and denies execve. Which attack remains possible?",
          "options": [
            "Nothing: denying execve prevents all code execution",
            "Opening files by path, because seccomp cannot inspect pointer arguments or stop openat",
            "Forking new processes, because fork also needs execve",
            "Reading memory outside the process"
          ],
          "answer": 1,
          "explain": "Seccomp sees scalar arguments, not pointed-to strings, and openat is a different syscall. Filesystem scope needs Landlock or mount namespaces."
        }
      ],
      "quickbytes": [
        "Allowlist plus arch check, or you have a denylist with a known bypass.",
        "Set PR_SET_NO_NEW_PRIVS before installing an unprivileged filter.",
        "Deny with EPERM during rollout; kill only for syscalls that must never run."
      ],
      "resources": [
        {
          "title": "Seccomp BPF: design, return values, and pitfalls",
          "url": "https://docs.kernel.org/userspace-api/seccomp_filter.html",
          "kind": "docs"
        },
        {
          "title": "seccomp(2): actions, flags, and TSYNC",
          "url": "https://man7.org/linux/man-pages/man2/seccomp.2.html",
          "kind": "docs"
        },
        {
          "title": "seccompiler: filters, BpfProgram, apply_filter_all_threads",
          "url": "https://docs.rs/seccompiler/latest/seccompiler/",
          "kind": "docs"
        },
        {
          "title": "Firecracker: seccomp policy per thread in a production VMM",
          "url": "https://github.com/firecracker-microvm/firecracker",
          "kind": "repo"
        },
        {
          "title": "Sandboxing: Foolproof Boundaries vs Unbounded Foolishness",
          "url": "https://dl.acm.org/doi/pdf/10.1145/3733699",
          "kind": "paper"
        }
      ]
    },
    {
      "id": "p19",
      "title": "Process metrics and health endpoints",
      "minutes": 60,
      "level": "advanced",
      "goal": "Expose liveness, readiness, and worker metrics that answer whether this instance can work right now, without turning a slow dependency into a restart loop.",
      "sections": [
        {
          "h": "Three probes, three different questions",
          "p": [
            "Liveness asks whether the process is wedged and should be restarted. Readiness asks whether it can accept work right now. Startup asks whether a slow boot has finished. Answering the wrong question with the wrong probe is how a database blip restarts an entire fleet.",
            "A liveness probe that queries the database will fail during a dependency outage, the orchestrator will kill every replica, and the outage becomes total. Liveness should check the event loop and the supervisor. Readiness should check admission state, migrations, and queue health, because taking an instance out of rotation is reversible and cheap."
          ],
          "code": "use std::sync::atomic::{AtomicU8, Ordering};\n\n#[derive(Clone, Copy, Debug, PartialEq)]\n#[repr(u8)]\npub enum Phase {\n    Starting = 0,\n    Ready = 1,\n    Draining = 2,\n    Stopped = 3,\n}\n\npub struct Health {\n    phase: AtomicU8,\n}\n\nimpl Health {\n    pub fn new() -> Self {\n        Self { phase: AtomicU8::new(Phase::Starting as u8) }\n    }\n\n    pub fn set(&self, phase: Phase) {\n        self.phase.store(phase as u8, Ordering::SeqCst);\n    }\n\n    pub fn get(&self) -> Phase {\n        match self.phase.load(Ordering::SeqCst) {\n            1 => Phase::Ready,\n            2 => Phase::Draining,\n            3 => Phase::Stopped,\n            _ => Phase::Starting,\n        }\n    }\n}",
          "tip": "Set the startup probe's failureThreshold from your slowest migration, not from a guess. It exists so liveness does not kill a process that is still booting."
        },
        {
          "h": "Readiness is a state, not a query",
          "p": [
            "The readiness handler should read a value, not perform IO. A handler that pings Postgres on every probe turns a probe into load and makes the probe fail for reasons the process cannot fix. Drive the state from the components that actually know: migrations finished, pool connected, listener bound, supervisor healthy.",
            "During shutdown, readiness flips to false before the listener closes, so the load balancer stops sending traffic while in-flight work drains. Liveness stays true through the drain; a liveness failure during a normal shutdown causes a restart in the middle of it."
          ],
          "list": [
            "starting: process alive, migrations running, not ready",
            "ready: listener bound, pool warm, supervisor running",
            "draining: readiness false, liveness true, work finishing",
            "stopped: process exiting; liveness false only here"
          ],
          "tip": "Return 503 from readiness with a short body naming the reason. `kubectl describe pod` shows the message, and it saves a log hunt."
        },
        {
          "h": "Metrics that catch a silent stall",
          "p": [
            "Four metric families cover most worker incidents: queue depth as a gauge, jobs started and finished by outcome as counters, job duration as a histogram, and time since the last successful job as a gauge. That last one catches the failure nothing else does: a process that is alive, connected, and doing nothing.",
            "Cardinality is the constraint. Queue name and job class are bounded; job id and tenant id are not, and a label with a million values will take down the metrics backend before it tells you anything. Put unbounded identifiers in logs and traces, not in metric labels."
          ],
          "code": "use axum::extract::State;\nuse axum::http::StatusCode;\nuse axum::routing::get;\nuse axum::Router;\nuse metrics_exporter_prometheus::PrometheusHandle;\nuse std::sync::Arc;\n\npub fn router(health: Arc<Health>, prom: PrometheusHandle) -> Router {\n    Router::new()\n        // Liveness: no IO, no dependency checks.\n        .route(\"/healthz\", get(|| async { StatusCode::OK }))\n        .route(\n            \"/readyz\",\n            get({\n                let health = health.clone();\n                move || async move {\n                    match health.get() {\n                        Phase::Ready => (StatusCode::OK, \"ready\"),\n                        Phase::Draining => (StatusCode::SERVICE_UNAVAILABLE, \"draining\"),\n                        _ => (StatusCode::SERVICE_UNAVAILABLE, \"starting\"),\n                    }\n                }\n            }),\n        )\n        .route(\n            \"/metrics\",\n            get(move || {\n                let body = prom.render();\n                async move { body }\n            }),\n        )\n}",
          "tip": "A histogram of job duration answers questions a gauge cannot: p99, and how much of the tail is one pathological class of work."
        },
        {
          "h": "Alert on symptoms, not on every counter",
          "p": [
            "Alerts should correspond to user-visible pain: oldest job age above the SLO, restart rate above baseline, readiness flapping, or no successful job in the last ten minutes. Alerting on a single counter increment produces noise, and noise teaches people to ignore the pager.",
            "Keep the healthy path quiet. A worker that logs every job at info level and exports forty metrics is expensive to run and hard to read during an incident. Log state transitions and failures, count everything else, and keep one dashboard that answers: is work flowing, and if not, where is it stuck."
          ],
          "tip": "For every alert, write the first diagnostic command in the runbook. If you cannot, the alert is not actionable yet."
        }
      ],
      "exercise": {
        "prompt": "Implement Health and probe: an atomic phase that starts in Starting, a setter, and a probe returning (StatusCode, reason) where only Ready is 200 and Draining reports its own reason.",
        "starter": "use axum::http::StatusCode;\nuse std::sync::atomic::AtomicU8;\n\n#[derive(Clone, Copy, Debug, PartialEq)]\n#[repr(u8)]\npub enum Phase {\n    Starting = 0,\n    Ready = 1,\n    Draining = 2,\n}\n\npub struct Health {\n    phase: AtomicU8,\n}\n\nimpl Health {\n    pub fn new() -> Self {\n        unimplemented!()\n    }\n    pub fn set(&self, _phase: Phase) {\n        unimplemented!()\n    }\n    pub fn get(&self) -> Phase {\n        unimplemented!()\n    }\n}\n\npub fn probe(_phase: Phase) -> (StatusCode, &'static str) {\n    (StatusCode::OK, \"ready\")\n}",
        "hint": "Mirror the repr(u8) discriminants in get(): match on the loaded u8 and map anything unknown to Starting. In probe, match Ready to 200 and everything else to 503 with a distinct reason.",
        "solution": "use axum::http::StatusCode;\nuse std::sync::atomic::{AtomicU8, Ordering};\n\n#[derive(Clone, Copy, Debug, PartialEq)]\n#[repr(u8)]\npub enum Phase {\n    Starting = 0,\n    Ready = 1,\n    Draining = 2,\n}\n\npub struct Health {\n    phase: AtomicU8,\n}\n\nimpl Health {\n    pub fn new() -> Self {\n        Self { phase: AtomicU8::new(Phase::Starting as u8) }\n    }\n\n    pub fn set(&self, phase: Phase) {\n        self.phase.store(phase as u8, Ordering::SeqCst);\n    }\n\n    pub fn get(&self) -> Phase {\n        match self.phase.load(Ordering::SeqCst) {\n            1 => Phase::Ready,\n            2 => Phase::Draining,\n            _ => Phase::Starting,\n        }\n    }\n}\n\npub fn probe(phase: Phase) -> (StatusCode, &'static str) {\n    match phase {\n        Phase::Ready => (StatusCode::OK, \"ready\"),\n        Phase::Draining => (StatusCode::SERVICE_UNAVAILABLE, \"draining\"),\n        Phase::Starting => (StatusCode::SERVICE_UNAVAILABLE, \"starting\"),\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn only_ready_is_a_200() {\n        assert_eq!(probe(Phase::Ready).0, StatusCode::OK);\n        assert_eq!(probe(Phase::Draining).0, StatusCode::SERVICE_UNAVAILABLE);\n        let health = Health::new();\n        assert_eq!(health.get(), Phase::Starting);\n        health.set(Phase::Ready);\n        assert_eq!(health.get(), Phase::Ready);\n    }\n}"
      },
      "production": [
        "Liveness checks only the event loop and supervisor; no downstream dependency is in the path.",
        "Readiness is driven by a state machine, flips false before the listener closes, and stays false while draining.",
        "Queue depth, job outcomes, duration, and last-success age are exported with bounded labels.",
        "Startup probe thresholds are derived from the slowest migration, not from a default.",
        "Every alert has a runbook line naming the first diagnostic command."
      ],
      "crates": [
        "axum",
        "metrics",
        "metrics-exporter-prometheus",
        "tokio"
      ],
      "github": [
        {
          "name": "metrics-rs/metrics - metrics facade and Prometheus exporter",
          "url": "https://github.com/metrics-rs/metrics"
        }
      ],
      "pitfall": "A liveness probe whose handler queries the database: when the database slows, every replica fails liveness at once and the orchestrator restarts the whole fleet, turning a read slowdown into a total outage.",
      "questions": [
        {
          "q": "Which check belongs in a liveness probe?",
          "options": [
            "A query against the primary database",
            "Whether the runtime's event loop and supervisor are making progress",
            "Whether the queue depth is below the target",
            "Whether the last job succeeded within the SLO"
          ],
          "answer": 1,
          "explain": "Liveness restarts the process. It must not depend on something a restart cannot fix, or a dependency outage becomes a fleet-wide restart loop."
        },
        {
          "q": "When should readiness return 503 during a deploy?",
          "options": [
            "Only after the process exits",
            "As soon as shutdown starts, before the listener closes, so traffic drains",
            "After telemetry has been flushed",
            "Never; readiness should stay 200 until the process is gone"
          ],
          "answer": 1,
          "explain": "The load balancer needs a head start to stop routing before the listener closes. Readiness false plus liveness true is the drain state."
        },
        {
          "q": "Which value is safe as a Prometheus label?",
          "options": [
            "job_id",
            "tenant_id",
            "queue",
            "attempt_uuid"
          ],
          "answer": 2,
          "explain": "Queue names are a small bounded set. Per-job and per-tenant identifiers create a time series per value and will overload the metrics backend."
        }
      ],
      "quickbytes": [
        "Readiness reads a state; it never performs IO on the probe path.",
        "Track time since last successful job: it catches the stall that CPU and memory miss.",
        "Only bounded values become metric labels; identifiers stay in logs and traces."
      ],
      "resources": [
        {
          "title": "Kubernetes: liveness, readiness, and startup probes",
          "url": "https://kubernetes.io/docs/concepts/workloads/pods/probes/",
          "kind": "docs"
        },
        {
          "title": "metrics-exporter-prometheus: scrape endpoint and render()",
          "url": "https://docs.rs/metrics-exporter-prometheus/latest/metrics_exporter_prometheus/",
          "kind": "docs"
        },
        {
          "title": "metrics crate: counters, gauges, histograms",
          "url": "https://docs.rs/metrics/latest/metrics/",
          "kind": "docs"
        },
        {
          "title": "CNCF: observability and SLO talks",
          "url": "https://www.youtube.com/@CNCF",
          "kind": "video"
        }
      ]
    },
    {
      "id": "p20",
      "title": "Cross-platform process handling",
      "minutes": 70,
      "level": "advanced",
      "goal": "Abstract over Unix process groups and Windows job objects with one supervision API, and know which guarantees you lose on Windows.",
      "sections": [
        {
          "h": "The portable surface is smaller than it looks",
          "p": [
            "std::process::Command, Child::kill, wait, and ExitStatus are portable. Process groups, signals, and the fork/exec split are not. On Unix, kill sends a signal the child can handle; on Windows, Child::kill calls TerminateProcess, which is SIGKILL with no chance to clean up.",
            "Windows has no SIGTERM. Console applications receive CTRL_C_EVENT or CTRL_BREAK_EVENT, and GenerateConsoleCtrlEvent can only target a process group that shares a console. A service started by the Service Control Manager has no console at all, so graceful stop has to arrive over a channel you control."
          ],
          "code": "use std::process::ExitStatus;\n\n#[derive(Debug, PartialEq)]\npub enum Ending {\n    Code(i32),\n    Signalled(i32),\n    Unknown,\n}\n\npub fn classify(status: ExitStatus) -> Ending {\n    if let Some(code) = status.code() {\n        return Ending::Code(code);\n    }\n    #[cfg(unix)]\n    {\n        use std::os::unix::process::ExitStatusExt;\n        if let Some(sig) = status.signal() {\n            return Ending::Signalled(sig);\n        }\n    }\n    Ending::Unknown\n}",
          "tip": "On Windows a terminated process still reports an exit code, so a TerminateProcess kill looks like a normal nonzero exit. Log the code and the wall time, or you will misclassify every forced stop."
        },
        {
          "h": "One API: spawn a group, signal it, wait for it",
          "p": [
            "The command-group crate wraps both models: on Unix it calls setpgid before exec, on Windows it creates a job object and assigns the child. group_spawn returns an AsyncGroupChild whose kill terminates the whole tree, which is the behaviour you actually want for a job runner.",
            "Reach for it instead of hand-rolling cfg blocks at every spawn site. If you only need Unix, process_group(0) and killpg are fewer dependencies; the moment Windows is in scope, the job-object plumbing is not something to reimplement. The crate is two traits and one wrapper type, and the alternative is unsafe FFI plus a cfg block on every single spawn call in your codebase."
          ],
          "code": "use command_group::AsyncCommandGroup;\nuse std::process::Stdio;\nuse tokio::process::Command;\n\npub async fn spawn_grouped(\n    program: &str,\n    args: &[&str],\n) -> std::io::Result<command_group::AsyncGroupChild> {\n    let mut cmd = Command::new(program);\n    cmd.args(args)\n        .stdout(Stdio::inherit())\n        .stderr(Stdio::inherit())\n        .kill_on_drop(true);\n\n    // Unix: new process group. Windows: a job object for the tree.\n    cmd.group_spawn()\n}\n\npub async fn stop(mut child: command_group::AsyncGroupChild) -> std::io::Result<()> {\n    // Kills the group on Unix and the job on Windows, then reaps.\n    child.kill().await?;\n    let _status = child.wait().await?;\n    Ok(())\n}",
          "tip": "Closing a job handle with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is the Windows equivalent of a process-group kill on parent death. Without it, a crashed supervisor leaves its grandchildren running."
        },
        {
          "h": "Graceful stop without signals",
          "p": [
            "If the platform cannot deliver SIGTERM, do not fake it. Give the child a stop channel: a named pipe, a small local HTTP endpoint, a control socket, or a file it watches. The supervisor writes a stop request with a deadline, waits for the child to exit, and only then terminates the tree.",
            "tokio::signal::ctrl_c works on both platforms for interactive use, which is enough for development. Production Windows services need the Service Control Manager, which delivers its own stop event through the service API rather than a POSIX signal, and that requires a service wrapper crate rather than hand-written FFI."
          ],
          "list": [
            "Unix: SIGTERM, wait, then killpg with SIGKILL after a grace window",
            "Windows console: CTRL_BREAK_EVENT to the child's process group",
            "Windows service: SCM stop event, delivered through a service wrapper",
            "Any platform: a control socket plus a deadline, when signals are unreliable"
          ],
          "tip": "A control socket is also the most testable shutdown path: an integration test connects, sends stop, and asserts the deadline behaviour without sending signals to the test harness."
        },
        {
          "h": "CI has to run both",
          "p": [
            "Cross-platform code that is never compiled on Windows rots quietly. Gate platform modules with cfg and run the test suite on both targets; at minimum, compile-check the Windows path with cargo check --target x86_64-pc-windows-msvc so cfg-gated code cannot drift. The check costs one CI job and catches the entire class of bugs where a cfg branch has not compiled since it was written.",
            "Small differences cause real bugs: .exe suffixes, backslash paths, CRLF in captured output, and shell built-ins that do not exist in cmd.exe. None of them is hard to handle, and all of them are invisible until the first Windows run. Pass argv directly instead of going through a shell, normalise line endings before parsing child output, and resolve the program name with its extension before spawning."
          ],
          "tip": "Never build a command with cmd /C and an interpolated argument. Windows quoting rules differ from POSIX, and the resulting command injection is just as real."
        }
      ],
      "exercise": {
        "prompt": "Implement classify, which maps an ExitStatus to Code, Signalled, or Unknown across platforms, and stop, which kills a grouped child and reaps it. Add a test that classifies a normal exit and, on Unix, a SIGKILLed child.",
        "starter": "use std::process::ExitStatus;\n\n#[derive(Debug, PartialEq)]\npub enum Ending {\n    Code(i32),\n    Signalled(i32),\n    Unknown,\n}\n\npub fn classify(_status: ExitStatus) -> Ending {\n    Ending::Unknown\n}",
        "hint": "status.code() returns Some on normal exits and None when the child died from a signal. Use std::os::unix::process::ExitStatusExt::signal behind cfg(unix). For the test, spawn sh -c 'kill -9 $$'.",
        "solution": "use std::process::ExitStatus;\n\n#[derive(Debug, PartialEq)]\npub enum Ending {\n    Code(i32),\n    Signalled(i32),\n    Unknown,\n}\n\npub fn classify(status: ExitStatus) -> Ending {\n    if let Some(code) = status.code() {\n        return Ending::Code(code);\n    }\n    #[cfg(unix)]\n    {\n        use std::os::unix::process::ExitStatusExt;\n        if let Some(sig) = status.signal() {\n            return Ending::Signalled(sig);\n        }\n    }\n    Ending::Unknown\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    fn run(script: &str) -> ExitStatus {\n        std::process::Command::new(\"sh\")\n            .arg(\"-c\")\n            .arg(script)\n            .status()\n            .expect(\"spawn sh\")\n    }\n\n    #[test]\n    fn classifies_a_normal_exit() {\n        assert_eq!(classify(run(\"exit 3\")), Ending::Code(3));\n    }\n\n    #[cfg(unix)]\n    #[test]\n    fn classifies_a_signalled_child() {\n        assert_eq!(classify(run(\"kill -9 $$\")), Ending::Signalled(9));\n    }\n}"
      },
      "production": [
        "Every child is spawned into a group or job object, so kill reaches the whole tree on both platforms.",
        "Shutdown has a platform-appropriate path: SIGTERM on Unix, a control event or socket on Windows.",
        "A Windows job object uses KILL_ON_JOB_CLOSE, so a supervisor crash cannot orphan grandchildren.",
        "CI compiles and tests both targets, with cfg-gated tests for the platform-specific paths.",
        "No child command is built by interpolating arguments into a shell on either platform."
      ],
      "crates": [
        "command-group",
        "tokio",
        "win32job",
        "nix"
      ],
      "github": [
        {
          "name": "watchexec/command-group - process groups and job objects",
          "url": "https://github.com/watchexec/command-group"
        },
        {
          "name": "ohadravid/win32job-rs - safe Windows job objects",
          "url": "https://github.com/ohadravid/win32job-rs"
        }
      ],
      "pitfall": "Treating Child::kill as a graceful stop on Windows: TerminateProcess gives the child no chance to flush, so every deploy loses buffered work, and the exit code makes it look like a normal failure.",
      "questions": [
        {
          "q": "What does tokio::process::Child::kill do on Windows?",
          "options": [
            "Sends SIGTERM, which the child can handle",
            "Calls TerminateProcess, which the child cannot intercept or clean up after",
            "Sends CTRL_C_EVENT to the child's console group",
            "Closes the job object handle"
          ],
          "answer": 1,
          "explain": "There is no SIGTERM on Windows. kill is immediate termination, so graceful shutdown needs a control channel or a console control event."
        },
        {
          "q": "Why spawn a child into its own process group on Unix?",
          "options": [
            "To give it a higher scheduling priority",
            "So a kill can reach grandchildren that the direct child spawned",
            "To isolate its environment variables",
            "Because tokio requires it for async wait"
          ],
          "answer": 1,
          "explain": "Signals go to one process unless you signal a group. Wrapper scripts and build tools spawn grandchildren, which survive a direct kill and keep ports and files locked."
        },
        {
          "q": "A supervisor crashes on Windows but its children keep running. What was missing?",
          "options": [
            "A SIGTERM handler",
            "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE on the job object",
            "A higher process priority",
            "The CREATE_NEW_CONSOLE flag"
          ],
          "answer": 1,
          "explain": "The job object owns the tree only while its handle is open. With the kill-on-close limit, closing the last handle on supervisor death terminates the whole job."
        }
      ],
      "quickbytes": [
        "Use a group or job object per child; a bare kill only reaches the direct process.",
        "On Windows, plan shutdown as a message, not as a signal.",
        "Compile-check the cfg(windows) path in CI, or it will not build when you need it."
      ],
      "resources": [
        {
          "title": "command-group: process groups on Unix, job objects on Windows",
          "url": "https://docs.rs/command-group/latest/command_group/",
          "kind": "docs"
        },
        {
          "title": "win32job: job object limits, including kill-on-close",
          "url": "https://docs.rs/win32job/latest/win32job/",
          "kind": "docs"
        },
        {
          "title": "signal(7): Unix signal semantics and defaults",
          "url": "https://man7.org/linux/man-pages/man7/signal.7.html",
          "kind": "docs"
        },
        {
          "title": "command-group repository: cross-platform implementation",
          "url": "https://github.com/watchexec/command-group",
          "kind": "repo"
        }
      ]
    }
  ]
};
