/**
 * Rust Academy: process handling & workers track.
 *
 * Operational Rust: bounded worker pools, supervision and cancellation,
 * subprocess handling, signal-driven shutdown, schedulers, IPC, and
 * resource isolation. Assumes the async basics from foundations.mjs.
 */
export default {
  key: "processes",
  title: "Process handling & workers",
  blurb:
    "Run long-lived workers and child processes in production: bounded concurrency, supervision, ordered shutdown, schedulers, IPC, and resource isolation.",
  level: "industry",
  project: {
    title: "Capstone: the always-on job runner",
    brief:
      "Build a single service that owns a bounded worker pool, supervises its tasks, executes external commands with timeouts and resource caps, exposes readiness, runs a leader-safe scheduler, and speaks a framed protocol over a Unix socket. Everything must survive a rolling deploy without dropping work.",
    deliverables: [
      "A worker pool with a bounded queue, drain deadline, and pool/queue metrics",
      "Supervision with restart limits, panic isolation, and cooperative cancellation",
      "A scheduler that is correct with two replicas and records missed runs",
      "Child processes with timeouts, process-group kills, and rlimit caps",
      "A length-delimited Unix-socket endpoint with backpressure and half-close",
    ],
    stack: [
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
      "serde",
    ],
  },
  lessons: [
    {
      id: "p01",
      title: "Worker pools & bounded concurrency",
      minutes: 60,
      level: "core",
      goal: "Bound concurrent work and queue depth, propagate backpressure to producers, and drain in-flight jobs under a deadline.",
      sections: [
        {
          h: "Concurrency is a permit, not a thread",
          p: [
            "An unbounded tokio::spawn loop is not a worker pool. Every accepted job becomes a task immediately, so memory grows with arrival rate and the runtime's queues grow without limit. A pool fixes two numbers up front: how many jobs may run at once, and how many may wait.",
            "Semaphore::acquire_owned hands you a permit that can cross a task boundary, because you moved an Arc<Semaphore> clone instead of borrowing it. The permit returns to the semaphore when it drops, including when the task panics or is aborted, so a failed job cannot leak capacity.",
          ],
          code: `use std::sync::Arc;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

// Every snippet in this lesson works with this job type.
type Job = u64;
async fn run_job(_job: Job) {}

pub struct Pool {
    permits: Arc<Semaphore>,
    jobs: JoinSet<()>,
}

impl Pool {
    pub fn new(max_concurrent: usize) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(max_concurrent)),
            jobs: JoinSet::new(),
        }
    }

    pub async fn spawn<F>(&mut self, job: F) -> Result<(), tokio::sync::AcquireError>
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        // Wait for capacity *before* accepting more work: this is backpressure.
        let permit = self.permits.clone().acquire_owned().await?;
        self.jobs.spawn(async move {
            let _permit = permit; // released when the task ends, panic included
            job.await;
        });
        Ok(())
    }
}`,
          tip: "Keep the JoinSet inside the pool. Dropping a JoinSet aborts every task in it, so an accidental early drop is a mass cancellation, not a tidy cleanup.",
        },
        {
          h: "A bounded queue is the backpressure",
          p: [
            "Permits limit running work; a bounded mpsc channel limits queued work. Sender::send awaits when the channel is full, which pushes the slowdown back to the producer instead of buffering it inside the runtime. If the producer reads from a socket, awaiting send stops reading and TCP flow control does the rest.",
            "Size the queue from a latency budget, not from available memory: queue depth divided by throughput is the worst-case wait before a job even starts. Export both depth and wait time, because a full queue is the first symptom of a slow dependency.",
          ],
          code: `use tokio::sync::mpsc;

let mut pool = Pool::new(4);           // at most 4 jobs run at once
let (tx, mut rx) = mpsc::channel::<Job>(64); // at most 64 queued jobs

// Producer: parks here once 64 jobs are queued.
tx.send(7).await.expect("receiver alive");

// Consumer: one admission loop feeds the pool.
while let Some(job) = rx.recv().await {
    pool.spawn(run_job(job)).await.expect("pool alive");
}`,
          list: [
            "send().await waits for capacity, which is the behaviour you want for durable work",
            "try_send() returns TrySendError::Full so a caller can shed load and answer 503",
            "rx.close() stops new sends but lets the receiver drain what is already buffered",
          ],
          tip: "rx.recv() returning None means every sender was dropped. Treat it as the normal end-of-input path, not as an error to log at warn level.",
        },
        {
          h: "spawn_blocking has its own queue",
          p: [
            "A semaphore caps how many jobs you admit, but tokio's blocking pool is a separate executor with its own thread count. Each running spawn_blocking call holds a thread; the pool grows on demand up to max_blocking_threads and then queues. Without a gate, CPU-heavy jobs turn into an invisible backlog and a shutdown that never finishes, because a blocking task cannot be aborted once it starts.",
          ],
          code: `use tokio::sync::Semaphore;

// Static works because const_new is a const fn. 2x cores is a common start.
static BLOCKING: Semaphore = Semaphore::const_new(8);

async fn file_size(path: std::path::PathBuf) -> std::io::Result<u64> {
    let _permit = BLOCKING.acquire().await.expect("semaphore never closed");
    tokio::task::spawn_blocking(move || -> std::io::Result<u64> {
        let bytes = std::fs::read(&path)?;
        Ok(bytes.len() as u64)
    })
    .await
    .expect("blocking task panicked")
}`,
          tip: "Blocking tasks cannot be cancelled once started, so runtime shutdown waits for them. Keep them short and bounded; use a dedicated std thread for work that runs forever.",
        },
        {
          h: "Draining is ordered, not hopeful",
          p: [
            "A graceful drain has a fixed order: stop admitting (close the queue), finish queued work, wait for running jobs, and only then drop shared resources such as the database pool. Drop the pool first and in-flight jobs fail while shutting down, which turns a clean deploy into a partial write.",
            "A deadline is mandatory. Some job is always stuck; without a timeout the process never exits and the orchestrator sends SIGKILL, which is exactly the failure the drain was meant to prevent.",
          ],
          code: `use tokio::time::{timeout, Duration};

pub async fn drain(
    mut pool: Pool,
    mut rx: mpsc::Receiver<Job>,
    budget: Duration,
) -> Result<usize, &'static str> {
    rx.close();                              // 1. refuse new work
    while let Some(job) = rx.recv().await {  // 2. run what is already queued
        pool.spawn(run_job(job)).await.map_err(|_| "pool closed")?;
    }
    let mut completed = 0usize;
    let wait_all = async {
        while pool.jobs.join_next().await.is_some() {
            completed += 1;
        }
        completed
    };
    // 3. give running jobs a bounded amount of time
    timeout(budget, wait_all).await.map_err(|_| "drain deadline exceeded")
}`,
          list: [
            "Admission closes first; otherwise new work keeps arriving during the drain",
            "The deadline is shorter than the platform grace period, with slack for the final flush",
            "Resources are released after the join, never before it",
          ],
          tip: "Log the number of jobs still running when the deadline fires. That count is the difference between a clean stop and a silent work loss.",
        },
      ],
      exercise: {
        prompt:
          "Implement submit, which must never block and must distinguish a full queue from a closed one, and drain, which closes the receiver, runs every queued job, and joins running jobs under a deadline.",
        starter: `use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio::time::{timeout, Duration};

pub enum SubmitError {
    Full(u64),
    Closed(u64),
}

// TODO 1: never await here; map TrySendError into SubmitError.
pub fn submit(tx: &mpsc::Sender<u64>, job: u64) -> Result<(), SubmitError> {
    tx.try_send(job).map_err(|_| SubmitError::Closed(job))
}

// TODO 2: close rx, run each queued job through the set, then join the set
// under the budget. Return the number of jobs handled.
pub async fn drain(
    mut rx: mpsc::Receiver<u64>,
    set: &mut JoinSet<()>,
    budget: Duration,
) -> Result<u64, &'static str> {
    let _ = timeout(budget, async {}).await;
    Err("not implemented")
}

async fn process(job: u64) {
    tokio::time::sleep(Duration::from_millis(5)).await;
    let _ = job;
}`,
        hint: "mpsc::error::TrySendError has Full(value) and Closed(value) variants. In drain, rx.close() first, then recv until None, then join_next until None, all inside one async block passed to timeout.",
        solution: `use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio::time::{timeout, Duration};

pub enum SubmitError {
    Full(u64),
    Closed(u64),
}

pub fn submit(tx: &mpsc::Sender<u64>, job: u64) -> Result<(), SubmitError> {
    tx.try_send(job).map_err(|err| match err {
        mpsc::error::TrySendError::Full(job) => SubmitError::Full(job),
        mpsc::error::TrySendError::Closed(job) => SubmitError::Closed(job),
    })
}

pub async fn drain(
    mut rx: mpsc::Receiver<u64>,
    set: &mut JoinSet<()>,
    budget: Duration,
) -> Result<u64, &'static str> {
    rx.close(); // no new sends; already-buffered messages are still readable
    let work = async {
        let mut done = 0u64;
        while let Some(job) = rx.recv().await {
            set.spawn(async move { process(job).await });
            done += 1;
        }
        while set.join_next().await.is_some() {
            done += 1;
        }
        done
    };
    timeout(budget, work)
        .await
        .map_err(|_| "drain deadline exceeded")
}

async fn process(job: u64) {
    tokio::time::sleep(Duration::from_millis(5)).await;
    let _ = job;
}`,
      },
      production: [
        "Pool size and queue capacity are configuration, logged at startup and exported as gauges.",
        "Every admission path has a deadline; a full queue returns a typed error instead of hanging.",
        "spawn_blocking calls are gated by their own semaphore and fit inside the drain budget.",
        "Shutdown closes admission, joins with a timeout, then closes pools and flushes telemetry.",
        "A load test at twice the pool size proves queue depth stays bounded and latency degrades linearly.",
      ],
      crates: ["tokio", "tokio-util", "tracing"],
      pitfall:
        "An unbounded queue with one tokio::spawn per job looks fine in staging, then OOMs in production when the downstream slows: every queued job keeps its input alive while the producer keeps accepting.",
      questions: [
        {
          q: "A pool holds 4 permits and a bounded queue of 64 jobs. The producer has already queued 64 jobs and sends the 65th with send().await. What happens?",
          options: ["The job is dropped and an error is returned to the producer", "send() parks the producer until a queued job is admitted and a slot frees", "Tokio spawns an extra blocking thread so the job runs immediately"],
          answer: 1,
          explain: "Sender::send awaits capacity, which is how backpressure reaches the producer. try_send is the non-blocking variant that returns TrySendError::Full so the caller can shed load.",
        },
      ],
      resources: [
        {
          title: "tokio::sync::Semaphore API and examples",
          url: "https://docs.rs/tokio/latest/tokio/sync/struct.Semaphore.html",
          kind: "docs",
        },
        {
          title: "tokio::task::spawn_blocking semantics and limits",
          url: "https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html",
          kind: "docs",
        },
        {
          title: "Bridging async code and blocking code",
          url: "https://tokio.rs/tokio/topics/bridging",
          kind: "docs",
        },
      ],
    },
    {
      id: "p02",
      title: "Task supervision & cancellation",
      minutes: 65,
      level: "advanced",
      goal: "Own every spawned task: observe panics through JoinSet, cancel cooperatively with tokens, and restart with limits instead of in a loop.",
      sections: [
        {
          h: "JoinSet is the owner",
          p: [
            "JoinSet both spawns tasks and reports their completion with the panic payload intact. Spawn into it, await join_next to learn which task finished, and treat the JoinError as data: is_panic() tells you it panicked, is_cancelled() that it was aborted, and into_panic() hands you the payload for logging.",
            "The set does not own the runtime; it owns membership. Dropping a JoinSet aborts every member immediately, which is a mass kill with no chance to flush. join_next is cancel safe, so it can sit in a select! next to a cancellation token, and one set per subsystem keeps the blast radius small.",
          ],
          code: `use tokio::task::JoinSet;

let mut set: JoinSet<&'static str> = JoinSet::new();
set.spawn(async { "worker-a" });
set.spawn(async { "worker-b" });

while let Some(result) = set.join_next().await {
    match result {
        Ok(name) => tracing::info!(task = name, "exited cleanly"),
        Err(err) if err.is_panic() => {
            let payload = err.into_panic();
            tracing::error!(?payload, "task panicked");
        }
        Err(err) => tracing::warn!(?err, "task aborted"),
    }
}`,
          tip: "A panicking task does not poison the runtime; it returns JoinError. Catch it, classify it, and decide consciously whether the task should be restarted.",
        },
        {
          h: "Cancellation is cooperative",
          p: [
            "A CancellationToken is a broadcast flag, not a kill. Tasks must poll it, so every long loop needs a cancellation point: select! on token.cancelled() at the top of each iteration, and around any await that can take a while. Dropping a future is the only forceful option, and it is unsafe halfway through a write, because the write may be half-applied.",
            "child_token() creates a subtree whose cancellation follows the parent but cannot cancel its siblings. cancel() wakes all waiters, is_cancelled() is a cheap check for cleanup paths, and drop_guard() cancels on scope exit, which is how a forgotten error path still shuts down.",
          ],
          code: `use std::time::Duration;
use tokio_util::sync::CancellationToken;

let root = CancellationToken::new();
let worker = root.child_token();

let handle = tokio::spawn(async move {
    loop {
        tokio::select! {
            _ = worker.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_secs(1)) => {
                // one unit of work
            }
        }
    }
    // cleanup runs before exit: flush, ack, release the lease.
});

root.cancel();
handle.await.expect("worker task");`,
          tip: "Cancellation is not a failure. If a task reports cancellation and your supervisor restarts it, shutdown turns into a restart storm.",
        },
        {
          h: "Panic isolation and restart policy",
          p: [
            "A supervisor restarts on failure, but a restart loop without limits is a fork bomb with better manners. Bound it: max attempts per window, exponential backoff with jitter, and a terminal state that surfaces as an alert. Distinguish permanent failures (bad configuration) from transient ones (a timeout on a peer).",
            "Hold cancellation authority outside the supervised task. If the task owns the token that stops it, a panic drops the token and nothing can stop the replacement cleanly.",
          ],
          code: `use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub async fn supervise<F, Fut>(mut make_task: F, token: CancellationToken)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<(), String>> + Send + 'static,
{
    let mut attempt = 0u32;
    loop {
        let mut handle = tokio::spawn(make_task());
        tokio::select! {
            _ = token.cancelled() => {
                handle.abort();
                return;
            }
            result = &mut handle => match result {
                Ok(Ok(())) => return,
                Ok(Err(err)) => tracing::warn!(%err, "task failed"),
                Err(join_err) => tracing::warn!(?join_err, "task died"),
            },
        }
        attempt += 1;
        if attempt >= 5 {
            tracing::error!(attempt, "supervisor giving up");
            return;
        }
        let backoff = Duration::from_millis(100u64 << attempt); // add jitter in production
        tokio::time::sleep(backoff).await;
    }
}`,
          tip: "Classify cancellation before failure. If the token is already cancelled, return instead of counting an attempt and sleeping through the shutdown budget.",
        },
        {
          h: "Who owns the task?",
          p: [
            "Every spawned task needs an owner that outlives it and a policy for its result. Fire-and-forget tokio::spawn with a discarded JoinHandle is a leak with extra steps: nothing observes failure, nothing awaits exit, and shutdown has no way to know the task is still running.",
            "The rule that keeps this tractable: the component that creates a task owns its JoinSet and its token subtree; the task owns only its inputs. Abort handles supervise tasks; a Drop impl that aborts is the last line of defence, not the design.",
          ],
          list: [
            "Store JoinHandles or a JoinSet in the owner, never in the task's own state",
            "Log every exit path with a task name and elapsed time",
            "On abort, allow one yield point for cleanup, or document what state is dropped",
            "Never hold a std Mutex guard across an await inside a supervised task",
          ],
          tip: "If a task must outlive the request that spawned it, it needs a name, a token, and a place in the owner's set. Otherwise it will be found later as an orphan in a profile.",
        },
      ],
      exercise: {
        prompt:
          "Implement supervise_once: spawn a fallible job, race it against a cancellation token, and classify the outcome. A completed job is Done, a panicking job is Panic, and a cancelled wait is Cancelled, after aborting and reaping the task.",
        starter: `use tokio_util::sync::CancellationToken;

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Done,
    Panic,
    Cancelled,
}

// TODO: spawn the job, select on token.cancelled() vs the join handle,
// abort and await on cancellation, classify JoinError::is_panic().
pub async fn supervise_once<F>(job: F, token: CancellationToken) -> Outcome
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let _ = token;
    todo!()
}`,
        hint: "Use `let mut handle = tokio::spawn(job);` then select! on `token.cancelled()` and `&mut handle`. After an abort, await the handle once so the task is reaped, and return Cancelled.",
        solution: `use tokio_util::sync::CancellationToken;

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Done,
    Panic,
    Cancelled,
}

pub async fn supervise_once<F>(job: F, token: CancellationToken) -> Outcome
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let mut handle = tokio::spawn(job);
    tokio::select! {
        _ = token.cancelled() => {
            handle.abort();
            let _ = handle.await; // reap: nothing is left running
            Outcome::Cancelled
        }
        result = &mut handle => match result {
            Ok(()) => Outcome::Done,
            Err(err) if err.is_panic() => Outcome::Panic,
            Err(_aborted) => Outcome::Cancelled,
        },
    }
}`,
      },
      production: [
        "Each subsystem has one owner struct holding its JoinSet and its child token.",
        "JoinError is logged with is_panic and the payload, never silently ignored.",
        "Restart policy has an attempt cap, backoff with an upper bound, and a terminal alert.",
        "Cancellation is checked before restart, so shutdown cannot start a new task.",
      ],
      crates: ["tokio", "tokio-util", "tracing"],
      pitfall:
        "Restarting on any JoinError makes shutdown a restart loop: an aborted task returns a JoinError with is_cancelled() true, the supervisor respawns it, and the drain never reaches zero tasks.",
      questions: [
        {
          q: "A supervised task aborts during shutdown and join_next yields a JoinError. What should the supervisor do before restarting it?",
          options: ["Restart, because every JoinError is a transient failure", "Check the cancellation token and treat is_cancelled() as a stop signal, not a failure", "Ignore JoinError values and only restart on Ok(Err(_))"],
          answer: 1,
          explain: "Cancellation must win over failure classification. Restarting an aborted task turns shutdown into a restart storm and the drain never reaches zero tasks.",
        },
      ],
      resources: [
        {
          title: "tokio::task::JoinSet API",
          url: "https://docs.rs/tokio/latest/tokio/task/struct.JoinSet.html",
          kind: "docs",
        },
        {
          title: "tokio_util::sync::CancellationToken",
          url: "https://docs.rs/tokio-util/latest/tokio_util/sync/struct.CancellationToken.html",
          kind: "docs",
        },
        {
          title: "Tokio: graceful shutdown patterns",
          url: "https://tokio.rs/tokio/topics/shutdown",
          kind: "docs",
        },
      ],
    },
    {
      id: "p03",
      title: "Subprocess handling",
      minutes: 75,
      level: "advanced",
      goal: "Spawn external commands safely: stream both pipes, enforce timeouts, kill the whole process group, and always reap the child.",
      sections: [
        {
          h: "Command is async; the OS is not",
          p: [
            "tokio::process::Command mirrors std::process::Command but returns futures for spawn, status, and output. spawn() still forks synchronously; wait() polls a signal-driven reaper. The default is inherited stdio, which surprises people: run a child from a service and its output goes wherever the service's file descriptors point, not into your logs.",
            "Set Stdio::piped() when you want to observe output, and set kill_on_drop(true) as a safety net for the path where your code panics. The runtime reaps such children on a best-effort basis only, so a supervised service should still await wait() itself.",
          ],
          code: `use std::process::Stdio;
use tokio::process::Command;

let mut cmd = Command::new("ffmpeg");
cmd.arg("-i")
    .arg("input.mp4")
    .arg("-f")
    .arg("null")
    .arg("-")
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true); // last resort; still await wait() yourself

let child = cmd.spawn().expect("spawn failed: missing binary or EPERM");`,
          tip: "Never build a command by interpolating user input into sh -c. Pass argv directly; if you truly need a shell, quote and validate every argument first.",
        },
        {
          h: "Stream without deadlocking",
          p: [
            "Two pipes and one reader is a deadlock: the child fills stderr while you read stdout, it blocks on write, you block on read, and the job hangs until the timeout fires. Read both piped streams concurrently, or use wait_with_output(), which drains both but buffers everything in memory.",
            "For long-running children, stream line by line into a bounded channel so the processor applies backpressure. Cap line length while you do it: BufReader::lines has no bound, so a child that never emits a newline grows the parent's heap.",
          ],
          code: `use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

let mut child = Command::new("cargo")
    .arg("test")
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped())
    .spawn()
    .expect("cargo available");

let stdout = child.stdout.take().expect("stdout piped");
let stderr = child.stderr.take().expect("stderr piped");

let out_task = tokio::spawn(async move {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        tracing::info!(stream = "stdout", %line);
    }
});
let err_task = tokio::spawn(async move {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        tracing::warn!(stream = "stderr", %line);
    }
});

let status = child.wait().await.expect("child wait");
let _ = tokio::join!(out_task, err_task);
tracing::info!(?status);`,
          tip: "If you only read stdout, redirect stderr to null or merge it explicitly. A blocked pipe on the unread stream stalls the child, and the timeout blames the wrong component.",
        },
        {
          h: "Timeouts and process groups",
          p: [
            "A timeout that drops wait() leaves the child running with your pipes open. Kill it and then wait to reap it. child.kill() signals only the direct child, so a wrapper script, a shell command, or a build tool that spawns linkers leaves grandchildren behind.",
            "Spawn the child into its own process group with process_group(0), so the child's pid is also its pgid, then signal the group with killpg. Capture id() before awaiting wait(), because after reaping it returns None.",
          ],
          code: `// inside: async fn run(cmd: &mut Command) -> std::io::Result<bool>
use std::time::Duration;
use tokio::time::timeout;

#[cfg(unix)]
cmd.process_group(0); // child becomes its own group leader: pgid == pid

let mut child = cmd.spawn()?;
match timeout(Duration::from_secs(30), child.wait()).await {
    Ok(status) => Ok(status?.success()),
    Err(_elapsed) => {
        #[cfg(unix)]
        {
            use nix::sys::signal::{killpg, Signal};
            use nix::unistd::Pid;
            if let Some(pid) = child.id() {
                // ESRCH means it died between the timeout and the kill; ignore it.
                let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGKILL);
            }
        }
        #[cfg(not(unix))]
        child.kill().await?;

        let _status = child.wait().await?; // reap: never leave a zombie
        Ok(false)
    }
}`,
          tip: "SIGKILL to a process group is not graceful. Send SIGTERM to the group first when the child can flush, then SIGKILL after a short grace window.",
        },
        {
          h: "Zombies and kill_on_drop",
          p: [
            "On Unix an exited child that has not been waited for is a zombie: it holds a pid and a process-table slot, and enough of them make fork fail. The tokio runtime reaps its own children on a best-effort basis, so the only guarantee you fully control is awaiting wait() exactly once per child.",
            "try_wait() is the non-blocking probe for supervisor loops. SignalKind::child() exists if you insist on SIGCHLD-driven reaping, but in a service every spawn site should have exactly one waiter, which makes the signal unnecessary.",
          ],
          list: [
            "Exactly one task awaits each Child; a second wait returns an error or None",
            "Use try_wait() in a select! loop when you need periodic liveness checks",
            "kill_on_drop cannot await the reap, so it is a safety net and not a cleanup strategy",
            "After a timeout: kill the group, await wait(), then log the exit status and duration",
          ],
          tip: "Capture child.id() before awaiting wait() if the pid is part of your logs or metrics. It is None once the child has been reaped.",
        },
      ],
      exercise: {
        prompt:
          "Implement run_bounded(cmd, limit): spawn the command in its own process group, drain stdout and stderr concurrently, and kill the whole group if it exceeds the limit. Return a timed-out outcome only after the child has been reaped.",
        starter: `use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

pub enum Outcome {
    Exited(i32),
    TimedOut,
    Signalled,
}

// TODO: set piped stdio and kill_on_drop, call process_group(0) on unix,
// drain both pipes in a spawned task, timeout child.wait(), then killpg
// and await wait() on the timeout path.
pub async fn run_bounded(_cmd: Command, _limit: Duration) -> Outcome {
    todo!()
}`,
        hint: "Take stdout and stderr out of the child, move them into a spawned task using AsyncReadExt::read_to_end for both, and start that task before awaiting wait(). On timeout, killpg(Pid::from_raw(pid as i32), Signal::SIGKILL), then await child.wait() so the pid is released.",
        solution: `use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;

pub enum Outcome {
    Exited(i32),
    TimedOut,
    Signalled,
}

pub async fn run_bounded(mut cmd: Command, limit: Duration) -> Outcome {
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(_) => return Outcome::Exited(-1),
    };

    let mut stdout = child.stdout.take().expect("stdout piped");
    let mut stderr = child.stderr.take().expect("stderr piped");
    // Start draining immediately: a full pipe would block the child.
    let drain = tokio::spawn(async move {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let _ = tokio::join!(
            stdout.read_to_end(&mut out),
            stderr.read_to_end(&mut err),
        );
        (out, err)
    });

    match timeout(limit, child.wait()).await {
        Ok(status) => {
            let _ = drain.await;
            let code = status.ok().and_then(|s| s.code()).unwrap_or(-1);
            Outcome::Exited(code)
        }
        Err(_elapsed) => {
            #[cfg(unix)]
            {
                use nix::sys::signal::{killpg, Signal};
                use nix::unistd::Pid;
                if let Some(pid) = child.id() {
                    let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGKILL);
                }
            }
            #[cfg(not(unix))]
            {
                let _ = child.kill().await;
            }
            let _ = child.wait().await; // reap the killed child
            let _ = drain.await;
            Outcome::TimedOut
        }
    }
}`,
      },
      production: [
        "Every spawn site sets stdio explicitly; inherited output hides failures inside a service.",
        "Timeouts are mandatory and always followed by a group kill plus wait().",
        "The child's argv, pid, exit code, and duration are logged on every path.",
        "Integration tests cover a sleeping child, one ignoring SIGTERM, and one flooding stderr.",
        "No shell interpolation: argv is passed directly, and sh -c requires a documented reason.",
      ],
      crates: ["tokio", "nix", "tracing"],
      pitfall:
        "Dropping the wait() future on timeout does not stop the child, and dropping Child without kill_on_drop leaves it running with your pipes; the next deploy finds an orphan holding the port.",
      questions: [
        {
          q: "You set stdout and stderr to Stdio::piped() and then await child.wait() without reading either pipe. What is the risk?",
          options: ["Nothing, the runtime drains pipes automatically", "The child can block on a full pipe while the parent waits for exit, deadlocking the job", "wait() returns an error when a pipe is unread"],
          answer: 1,
          explain: "Pipe buffers are finite. Read both streams concurrently or use wait_with_output(), which drains both but buffers everything in memory.",
        },
      ],
      resources: [
        {
          title: "tokio::process module documentation",
          url: "https://docs.rs/tokio/latest/tokio/process/index.html",
          kind: "docs",
        },
        {
          title: "tokio::process::Command API",
          url: "https://docs.rs/tokio/latest/tokio/process/struct.Command.html",
          kind: "docs",
        },
        {
          title: "tokio::process::Child API",
          url: "https://docs.rs/tokio/latest/tokio/process/struct.Child.html",
          kind: "docs",
        },
        {
          title: "nix::sys::signal::killpg",
          url: "https://docs.rs/nix/latest/nix/sys/signal/fn.killpg.html",
          kind: "docs",
        },
      ],
    },
    {
      id: "p04",
      title: "Signals & graceful shutdown",
      minutes: 70,
      level: "industry",
      goal: "Turn SIGTERM and SIGINT into an ordered shutdown: fail readiness, stop admission, cancel, drain under a deadline, flush, then exit.",
      sections: [
        {
          h: "Two signals, two meanings",
          p: [
            "SIGTERM asks a process to stop. SIGKILL cannot be caught and is what the kernel, the kubelet, or systemd sends when the grace period expires. SIGINT is the interactive ctrl-c. Handle both, and treat a second signal as an instruction to stop waiting, because an operator pressing ctrl-c twice expects the process to die now.",
            "tokio::signal::unix::signal(SignalKind::terminate()) yields a stream of that signal; signal::ctrl_c() is the cross-platform SIGINT convenience. Install the listener once, at startup, before the first worker. A handler installed after boot means a signal that arrives during startup terminates the process with no cleanup at all.",
          ],
          code: `use tokio::signal::unix::{signal, SignalKind};

pub async fn shutdown_signal() {
    let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
    let mut int = signal(SignalKind::interrupt()).expect("install SIGINT handler");
    tokio::select! {
        _ = term.recv() => tracing::info!("received SIGTERM"),
        _ = int.recv() => tracing::info!("received SIGINT"),
    }
}`,
          tip: "Signal handlers are process-global. Install them once in main and pass a CancellationToken to subsystems; do not let each module install its own SIGTERM listener.",
        },
        {
          h: "Ordered shutdown, not a race",
          p: [
            "First flip readiness to false, so the load balancer stops sending new requests while existing connections continue to be served. Then close the listener or admission queue so no new work is accepted. Then cancel the token so workers stop at their next checkpoint. Then wait for the tracker under a deadline. Finally flush telemetry, close pools, and return from main.",
            "Every step before the drain must be cheap and non-blocking. A shutdown path that awaits a remote call before cancelling workers gets killed by the orchestrator while jobs are still running. Telemetry flushes last, because every step before it wants to log.",
          ],
          code: `use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::time::{timeout, Duration};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

pub async fn run() -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await?;
    let ready = Arc::new(AtomicBool::new(true)); // wired to the /readyz handler
    let token = CancellationToken::new();
    let tracker = TaskTracker::new();

    // Spawn the accept loop and workers: each gets token.child_token()
    // and registers itself with tracker.spawn(...).

    shutdown_signal().await;
    ready.store(false, Ordering::SeqCst); // 1. fail readiness
    drop(listener);                       // 2. stop accepting
    token.cancel();                       // 3. ask workers to stop
    tracker.close();                      // 4. no new tasks are tracked
    match timeout(Duration::from_secs(20), tracker.wait()).await {
        Ok(()) => tracing::info!("all workers drained"),
        Err(_) => tracing::warn!(left = tracker.len(), "drain deadline hit"),
    }
    // 5. flush telemetry, close the pool, remove the socket or pid file.
    Ok(())
}`,
          list: [
            "Readiness flips before cancellation, never after it",
            "The listener is dropped before the drain so new connections are refused fast",
            "The tracker is closed so wait() can return when it empties",
            "Telemetry and pool shutdown happen only after the join completes",
          ],
          tip: "TaskTracker::wait only returns when the tracker is both empty and closed. Forget close() and shutdown hangs with zero running tasks, which looks exactly like a deadlock.",
        },
        {
          h: "Readiness versus liveness",
          p: [
            "Readiness answers whether this instance may receive traffic now, and it must flip false the moment shutdown starts, even while jobs drain. Liveness answers whether the process is wedged, and it should stay true during a normal drain; otherwise the orchestrator restarts you in the middle of it.",
            "Kubernetes makes the contract explicit: a preStop hook runs before termination, and terminationGracePeriodSeconds bounds the wait before SIGKILL, defaulting to 30 seconds. Make the drain deadline strictly smaller than the grace period, measured from SIGTERM, and leave headroom for the final flush.",
          ],
          list: [
            "Grace period 30s: drain deadline 20s, flush budget 5s, 5s of slack",
            "Liveness probes the process and its event loop, not downstream dependencies",
            "Readiness probes admission plus queue health, not just whether the port accepts",
            "Log the signal, the deadline, and the number of jobs still running at exit",
          ],
          tip: "If the drain deadline equals the grace period, you have chosen to be SIGKILLed while flushing. Pick numbers that leave room for the flush you wrote.",
        },
        {
          h: "Deadlines and exit codes",
          p: [
            "A drain without a deadline can hang forever on one stuck job. Wrap the wait in a timeout; on expiry, log the remaining count, abort the supervised set, and return an error so main can exit nonzero. Exit codes are part of the interface: 0 for a requested clean stop, nonzero for a drain that timed out.",
            "Do not call std::process::exit from a worker. Returning from main runs destructors and tracing guards, which is what actually flushes the last lines of the incident you are about to debug.",
          ],
          code: `// inside the top-level shutdown function, after tracker.close()
use tokio::time::{timeout, Duration};

if timeout(budget, tracker.wait()).await.is_err() {
    tracing::error!(remaining = tracker.len(), "drain deadline exceeded");
    supervised.abort_all(); // only tasks owned by this set
    anyhow::bail!("shutdown drain timed out");
}
tracing::info!("shutdown complete");
Ok(())`,
          tip: "A second SIGTERM should take a fast path: abort, log one line, exit nonzero. Waiting out the full drain after an explicit second signal is how deploys become five-minute timeouts.",
        },
      ],
      exercise: {
        prompt:
          "Implement shutdown: flip readiness, cancel the token, close the tracker, and wait for it under a budget. Return a Drain reporting whether it finished cleanly and how many tasks were still running when the deadline expired.",
        starter: `use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::time::{timeout, Duration};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

#[derive(Debug, PartialEq)]
pub struct Drain {
    pub clean: bool,
    pub abandoned: usize,
}

// TODO: readiness first, then cancel, then close, then bounded wait.
pub async fn shutdown(
    ready: Arc<AtomicBool>,
    token: CancellationToken,
    tracker: TaskTracker,
    budget: Duration,
) -> Drain {
    let _ = (ready, token, tracker, budget);
    Drain { clean: false, abandoned: 0 }
}`,
        hint: "Order matters: ready.store(false, Ordering::SeqCst), token.cancel(), tracker.close(), then timeout(budget, tracker.wait()). On Err, read tracker.len() for the abandoned count.",
        solution: `use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::time::{timeout, Duration};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

#[derive(Debug, PartialEq)]
pub struct Drain {
    pub clean: bool,
    pub abandoned: usize,
}

pub async fn shutdown(
    ready: Arc<AtomicBool>,
    token: CancellationToken,
    tracker: TaskTracker,
    budget: Duration,
) -> Drain {
    ready.store(false, Ordering::SeqCst); // 1. no new traffic
    token.cancel();                       // 2. workers stop at checkpoints
    tracker.close();                      // 3. wait() may now return when empty

    match timeout(budget, tracker.wait()).await {
        Ok(()) => Drain { clean: true, abandoned: 0 },
        Err(_) => Drain { clean: false, abandoned: tracker.len() },
    }
}`,
      },
      production: [
        "A test races SIGTERM against a readiness probe and asserts the order of transitions.",
        "Drain deadline is at most two thirds of the platform grace period, read from config.",
        "A second signal aborts the drain, logs one line, and exits nonzero.",
        "Exit codes distinguish requested success (0) from drain timeout (1).",
        "Shutdown is idempotent: a signal during startup still runs the cleanup path.",
      ],
      crates: ["tokio", "tokio-util", "tracing", "anyhow"],
      pitfall:
        "Calling std::process::exit at the first SIGTERM skips destructors, so buffered logs and in-flight transactions disappear; the deploy looks clean while the evidence is lost.",
      questions: [
        {
          q: "A container has terminationGracePeriodSeconds: 30 and a 20-second drain budget. When should readiness flip to false?",
          options: ["After all workers have finished draining", "At the start of shutdown, before cancelling workers or closing the listener", "Only after telemetry has been flushed"],
          answer: 1,
          explain: "Readiness must fail first so the load balancer stops routing new requests while in-flight work drains. Liveness stays true during the drain so the orchestrator does not restart mid-drain.",
        },
      ],
      resources: [
        {
          title: "tokio::signal module",
          url: "https://docs.rs/tokio/latest/tokio/signal/index.html",
          kind: "docs",
        },
        {
          title: "tokio::signal::unix::SignalKind",
          url: "https://docs.rs/tokio/latest/tokio/signal/unix/struct.SignalKind.html",
          kind: "docs",
        },
        {
          title: "Kubernetes pod lifecycle and termination",
          url: "https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/",
          kind: "docs",
        },
        {
          title: "signal(7): Linux signal semantics",
          url: "https://man7.org/linux/man-pages/man7/signal.7.html",
          kind: "docs",
        },
      ],
    },
    {
      id: "p05",
      title: "Schedulers & cron",
      minutes: 65,
      level: "advanced",
      goal: "Schedule recurring work that is safe with several replicas, survives restarts, and states honestly whether it runs at most or at least once.",
      sections: [
        {
          h: "In-process cron is a timer, not a scheduler",
          p: [
            "tokio-cron-scheduler runs jobs inside your process: JobScheduler::start() spawns a ticker, Job::new_async attaches an async handler, and shutdown() stops the ticker. That is exactly right for a cache warmer on a single replica, and wrong for anything that must run once across a fleet or survive a restart: there is no durable queue, no retry policy, and no record of the last successful run.",
            "Mind the schedule format. tokio-cron-scheduler takes a six-field expression with seconds first, so \"0 */5 * * * *\" is every five minutes at second zero. A five-field Unix cron string is a parse error here rather than a silently wrong schedule, so assert every expression at boot and let the deploy fail.",
          ],
          code: `use tokio_cron_scheduler::{Job, JobScheduler};
use tokio_util::sync::CancellationToken;

pub async fn run_cron(token: CancellationToken) -> anyhow::Result<()> {
    let mut sched = JobScheduler::new().await?;
    sched
        .add(Job::new_async("0 */5 * * * *", |_id, _sched| {
            Box::pin(async move {
                // A panic here kills this run silently: no Done notification fires.
                if let Err(err) = tokio::task::spawn(housekeeping()).await {
                    tracing::error!(?err, "housekeeping task failed");
                }
            })
        })?)
        .await?;
    sched.start().await?; // spawns the tick loop
    token.cancelled().await;
    sched.shutdown().await?; // stops the ticker before the process exits
    Ok(())
}

async fn housekeeping() {
    // real work goes here
}`,
          tip: "Catch panics around each tick. The async job runs in its own spawned task, so a panic ends that run silently: no Done notification, no retry, no metric.",
        },
        {
          h: "Leader election with a lease",
          p: [
            "Two replicas plus one cron tick equals two runs. Either make the work idempotent, which is preferred, or elect one leader. A Postgres session advisory lock is the cheapest lease: hold a dedicated connection, try pg_try_advisory_lock(key), and treat the connection's death as lost leadership, because the lock is session-scoped and disappears with it.",
            "Keep the lock on a connection you control, not on whatever the pool hands out. Returning a PoolConnection to the pool keeps its session alive, so the advisory lock stays held on a connection another task can now check out. Hold that connection for the process lifetime, or open a dedicated one outside the pool.",
          ],
          code: `use sqlx::pool::PoolConnection;
use sqlx::{PgPool, Postgres};

pub async fn try_lead(
    pool: &PgPool,
    key: i64,
) -> sqlx::Result<Option<PoolConnection<Postgres>>> {
    let mut conn = pool.acquire().await?;
    let acquired: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock($1)")
        .bind(key)
        .fetch_one(&mut *conn)
        .await?;
    // The caller must keep this connection alive: dropping it returns the
    // session to the pool while the advisory lock is still held.
    Ok(if acquired { Some(conn) } else { None })
}`,
          tip: "A leader that cannot renew must stop ticking immediately. Check the lock connection in the same loop that ticks, and prefer skipping a run to running it twice.",
        },
        {
          h: "Missed runs and your guarantee",
          p: [
            "A cron expression says when a run is due, not what should happen after downtime. Decide explicitly: skip, which is at most once and allows gaps, or backfill every slot since last_success, which is at least once and allows duplicates. Backfill must be capped, because a week offline with a five-minute period is 2016 runs, which is an outage rather than a catch-up.",
            "Make the slot part of the data model: a run key of (job, slot_start) inserted with ON CONFLICT DO NOTHING. Enqueue only when the insert won. That single statement turns an unbounded duplicate problem into a bounded one and makes retries safe.",
          ],
          code: `pub fn slot_for(now_secs: i64, period_secs: i64) -> i64 {
    assert!(period_secs > 0, "period must be positive");
    now_secs - now_secs.rem_euclid(period_secs)
}

pub async fn claim_slot(pool: &sqlx::PgPool, job: &str, slot: i64) -> sqlx::Result<bool> {
    let inserted = sqlx::query(
        "INSERT INTO scheduled_runs (job, slot) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(job)
    .bind(slot)
    .execute(pool)
    .await?
    .rows_affected();
    if inserted == 1 {
        sqlx::query("INSERT INTO jobs (kind, slot) VALUES ($1, $2)")
            .bind(job)
            .bind(slot)
            .execute(pool)
            .await?;
    }
    Ok(inserted == 1)
}`,
          tip: "The unique row is the idempotency token. Enqueue and claim in one transaction, or you can claim a slot and crash before the job is queued, which is a silent miss.",
        },
        {
          h: "Durable execution with apalis",
          p: [
            "When work must not be lost, put a queue between the tick and the handler. apalis models workers over backends (in-memory, Postgres, Redis): a WorkerBuilder names the worker, attaches the backend and middleware such as concurrency and retries, and builds a task handler. The worker polls, claims, and acknowledges; retries, timeouts, and rate limits are layers rather than a hand-rolled loop.",
            "run_until(signal) turns shutdown into a graceful drain: the worker stops polling, finishes the in-flight task, and returns. The concurrency setting is the same permit budget from lesson 1, applied to a durable queue instead of an in-memory one.",
          ],
          code: `use apalis::prelude::*;

// storage: MemoryStorage, apalis-redis, or apalis-postgres.
let worker = WorkerBuilder::new("email-worker")
    .backend(storage)
    .concurrency(4)   // four tasks in flight, like four semaphore permits
    .build(handle_email);

// Stop polling on ctrl-c, finish the in-flight task, then return.
worker
    .run_until(async {
        tokio::signal::ctrl_c().await.expect("signal handler");
        Ok::<(), WorkerError>(())
    })
    .await?;`,
          tip: "At-least-once delivery means handlers must be idempotent: the same task can be claimed twice after a crash between execution and acknowledgement.",
        },
      ],
      exercise: {
        prompt:
          "Implement slot_for, which floors a timestamp to a fixed period, and claim_slot, which inserts an idempotency row with ON CONFLICT DO NOTHING and reports whether this replica owns the slot. Add a unit test for the flooring.",
        starter: `pub fn slot_for(now_secs: i64, period_secs: i64) -> i64 {
    // TODO: floor to the start of the current period
    now_secs
}

pub async fn claim_slot(
    pool: &sqlx::PgPool,
    job: &str,
    slot: i64,
) -> sqlx::Result<bool> {
    // TODO: INSERT ... ON CONFLICT DO NOTHING, true only when this call inserted
    let _ = (pool, job, slot);
    Ok(false)
}`,
        hint: "now_secs - now_secs.rem_euclid(period_secs) floors correctly even for timestamps before the epoch. In claim_slot, rows_affected() is 1 only for the winning insert.",
        solution: `pub fn slot_for(now_secs: i64, period_secs: i64) -> i64 {
    assert!(period_secs > 0, "period must be positive");
    now_secs - now_secs.rem_euclid(period_secs)
}

pub async fn claim_slot(
    pool: &sqlx::PgPool,
    job: &str,
    slot: i64,
) -> sqlx::Result<bool> {
    let inserted = sqlx::query(
        "INSERT INTO scheduled_runs (job, slot) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(job)
    .bind(slot)
    .execute(pool)
    .await?
    .rows_affected();
    Ok(inserted == 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floors_to_period_boundary() {
        assert_eq!(slot_for(1_000, 300), 900);
        assert_eq!(slot_for(1_200, 300), 1_200);
    }
}`,
      },
      production: [
        "Every scheduled job has an idempotency key persisted in the database, not in memory.",
        "Backfill windows are capped and truncated backfills are logged with a count.",
        "Each cron expression is parsed and asserted at boot, so a typo fails the deploy.",
        "Leader locks live on a dedicated connection and losing the lock stops ticks.",
        "Missed-run and duplicate-run counts are exported as separate metrics.",
      ],
      crates: ["tokio", "tokio-cron-scheduler", "apalis", "sqlx", "tracing"],
      pitfall:
        "Waiting for a real tick to test a cron job is slow and flaky; test slot_for and the handler directly, then run one end-to-end case with a one-second schedule.",
      questions: [
        {
          q: "Two replicas both run the same in-process five-minute cron job. What makes the work run once per slot?",
          options: ["tokio-cron-scheduler deduplicates ticks across processes", "A leader lock or a unique (job, slot) row claimed with ON CONFLICT DO NOTHING", "Nothing needs to be done: each replica owns its own schedule"],
          answer: 1,
          explain: "An in-process scheduler knows nothing about its peers. Either elect one leader or make the slot an idempotency key in the database and enqueue only when the insert wins.",
        },
      ],
      resources: [
        {
          title: "tokio-cron-scheduler JobScheduler API",
          url: "https://docs.rs/tokio-cron-scheduler/latest/tokio_cron_scheduler/struct.JobScheduler.html",
          kind: "docs",
        },
        {
          title: "apalis: background job processing",
          url: "https://docs.rs/apalis/latest/apalis/",
          kind: "docs",
        },
        {
          title: "apalis-cron scheduler backend",
          url: "https://docs.rs/apalis-cron/latest/apalis_cron/",
          kind: "docs",
        },
        {
          title: "Kubernetes Lease objects and leader election",
          url: "https://kubernetes.io/docs/concepts/architecture/leases/",
          kind: "docs",
        },
      ],
    },
    {
      id: "p06",
      title: "IPC & streaming",
      minutes: 80,
      level: "industry",
      goal: "Move framed messages over Unix sockets with an explicit wire format, bounded frames, real backpressure, and correct half-close semantics.",
      sections: [
        {
          h: "A byte stream is not a message stream",
          p: [
            "A UnixStream is a byte stream: write() boundaries mean nothing to the reader, so a 100 KB message can arrive as a 64 KB read plus a 36 KB read, or glued to the next message. Every protocol needs framing, meaning a length prefix, a delimiter, or a fixed-size header, and the reader must be able to say not enough bytes yet without discarding what it already has.",
            "A length prefix is the simplest robust choice: a big-endian u32 length followed by the payload. Delimiters break when the payload can contain the delimiter and need escaping; fixed headers work only for fixed-size messages.",
          ],
          code: `// Wire format: 4-byte big-endian length, then exactly that many payload bytes.
fn encode(payload: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(4 + payload.len());
    buf.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    buf.extend_from_slice(payload);
    buf
}

fn length_of(header: &[u8]) -> Option<usize> {
    let bytes: [u8; 4] = header.get(..4)?.try_into().ok()?;
    Some(u32::from_be_bytes(bytes) as usize)
}`,
          tip: "Document the frame layout once and generate both encoder and decoder from that note. Two hand-written parsers drift, and the drift shows up as a misrouted message.",
        },
        {
          h: "LengthDelimitedCodec does the bookkeeping",
          p: [
            "tokio-util's Framed turns an AsyncRead + AsyncWrite into a Stream + Sink of frames, and LengthDelimitedCodec supplies the framing. It defaults to a 4-byte big-endian u32 prefix; set max_frame_length explicitly, because a peer that announces a 4 GiB frame makes the decoder reserve that much before the first payload byte arrives.",
            "Framed::new(stream, codec) then next().await yields BytesMut frames and send(bytes).await writes one. Partial frames sit in the codec's read buffer, so incompleteness costs memory rather than correctness, and a max_frame_length converts a hostile length into a decode error instead of an allocation.",
          ],
          code: `use bytes::Bytes;
use futures::{SinkExt, StreamExt};
use tokio::net::{UnixListener, UnixStream};
use tokio_util::codec::{Framed, LengthDelimitedCodec};

pub fn codec() -> LengthDelimitedCodec {
    LengthDelimitedCodec::builder()
        .length_field_type::<u32>()
        .max_frame_length(8 * 1024 * 1024) // reject oversized frames before allocating
        .new_codec()
}

pub async fn serve(path: &str) -> std::io::Result<()> {
    let listener = UnixListener::bind(path)?;
    loop {
        let (stream, _addr) = listener.accept().await?;
        tokio::spawn(async move {
            if let Err(err) = handle(stream).await {
                tracing::warn!(?err, "connection closed with error");
            }
        });
    }
}

async fn handle(stream: UnixStream) -> std::io::Result<()> {
    let mut framed = Framed::new(stream, codec());
    while let Some(frame) = framed.next().await {
        let request = frame?; // bad length or oversized frame ends the connection
        let response = echo(&request).await;
        framed.send(Bytes::from(response)).await?;
    }
    Ok(())
}

async fn echo(request: &[u8]) -> Vec<u8> {
    request.to_vec()
}`,
          tip: "Put the socket in a dedicated runtime directory with mode 0o600, and unlink a stale socket path at startup. Binding over an existing path fails instead of replacing it.",
        },
        {
          h: "Backpressure across a socket",
          p: [
            "SinkExt::send waits for the sink to be ready, so a slow peer throttles the writer: the kernel socket buffer fills, poll_write returns Pending, and send().await parks while the reader on the other end catches up. That is backpressure working.",
            "What breaks it is spawning a task per response over an unbounded channel: the queue absorbs the pressure and memory grows until the process dies. Choose a policy per link, block the reader or drop the oldest message, and bound whatever channel sits in between.",
          ],
          code: `use bytes::Bytes;
use tokio::sync::mpsc;

// Bounded: at most 32 responses in flight between reader and writer.
let (tx, mut rx) = mpsc::channel::<Bytes>(32);

// Reader side: parks once the writer is 32 frames behind.
if tx.send(frame.freeze()).await.is_err() {
    return Ok(()); // writer task is gone
}

// Writer task owns the sink half.
tokio::spawn(async move {
    let mut sink = Framed::new(stream, codec());
    while let Some(msg) = rx.recv().await {
        if let Err(err) = sink.send(msg).await {
            tracing::warn!(?err, "peer disconnected");
            break;
        }
    }
});`,
          tip: "A full bounded channel is a signal to measure, not to widen. Raise capacity only after you know the consumer's throughput and the acceptable latency.",
        },
        {
          h: "Half-close and EOF",
          p: [
            "shutdown() on the write half sends EOF to the peer while the read half stays open: that is how a client says it has finished sending and still expects an answer. On the server, the framed stream then ends with None, which is a normal end of input and not a connection failure.",
            "Watch the decoding edge: a peer that half-closes in the middle of a frame leaves an incomplete length prefix, and Framed reports that as an error on the final read. That is the correct outcome, because truncation must not look like a valid empty message.",
          ],
          code: `use bytes::Bytes;
use futures::{SinkExt, StreamExt};
use tokio::io::AsyncWriteExt;
use tokio_util::codec::Framed;

let mut framed = Framed::new(stream, codec());
framed.send(Bytes::from_static(b"hello")).await?; // send() writes and flushes
framed.get_mut().shutdown().await?; // half-close: peer sees EOF, we can still read

// Server side: None means the client finished sending, not that it crashed.
while let Some(frame) = framed.next().await {
    let frame = frame?;
    tracing::debug!(len = frame.len(), "request");
}`,
          tip: "send() flushes, so the half-close above is safe. If you batch with feed() instead, flush before shutdown(): buffered frames are lost when the FIN goes out.",
        },
      ],
      exercise: {
        prompt:
          "Using UnixStream::pair() and a Framed LengthDelimitedCodec, echo two frames in a spawned task, half-close the client's write side, read both replies, and assert the stream then ends. Use a bounded max_frame_length.",
        starter: `use bytes::Bytes;
use futures::{SinkExt, StreamExt};
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tokio_util::codec::{Framed, LengthDelimitedCodec};

fn codec() -> LengthDelimitedCodec {
    LengthDelimitedCodec::builder()
        .max_frame_length(1024 * 1024)
        .new_codec()
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let (client, server) = UnixStream::pair()?;
    // TODO: echo server task, two frames, half-close,
    // two replies, assert the next frame is None.
    let _ = (client, server);
    Ok(())
}`,
        hint: "Use a plain loop: let next = framed.next().await; then let Some(next) = next else { break }; so EOF ends the loop. Reply with framed.send(frame.freeze()), then framed.get_mut().shutdown() to half-close; send() already flushes.",
        solution: `use bytes::Bytes;
use futures::{SinkExt, StreamExt};
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tokio_util::codec::{Framed, LengthDelimitedCodec};

fn codec() -> LengthDelimitedCodec {
    LengthDelimitedCodec::builder()
        .length_field_type::<u32>()
        .max_frame_length(1024 * 1024)
        .new_codec()
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let (client, server) = UnixStream::pair()?;

    let echo = tokio::spawn(async move {
        let mut framed = Framed::new(server, codec());
        loop {
            let next = framed.next().await; // statement: borrow ends here
            let Some(next) = next else { break };
            let frame = next.expect("valid frame");
            framed.send(frame.freeze()).await.expect("echo send");
        }
    });

    let mut framed = Framed::new(client, codec());
    framed.send(Bytes::from_static(b"one")).await.unwrap();
    framed.send(Bytes::from_static(b"two")).await.unwrap();
    framed.get_mut().shutdown().await.unwrap(); // half-close, keep reading

    let first = framed.next().await.expect("reply one").expect("valid");
    let second = framed.next().await.expect("reply two").expect("valid");
    assert_eq!(&first[..], b"one");
    assert_eq!(&second[..], b"two");
    assert!(framed.next().await.is_none(), "server closed after EOF");

    echo.await.unwrap();
    Ok(())
}`,
      },
      production: [
        "Every message type has a documented wire format and an explicit maximum frame size.",
        "Decode errors close the connection with a logged reason; a frame is never skipped silently.",
        "The socket file is mode 0o600 in a private directory, unlinked on startup and shutdown.",
        "A slow-reader test proves memory stays bounded and exactly one writer task parks.",
        "Half-close is covered: two frames, shutdown, two replies, then EOF.",
      ],
      crates: ["tokio", "tokio-util", "bytes", "futures", "tracing"],
      pitfall:
        "Treating each read() as one message works in tests and breaks under load: stream coalescing merges a small write with the next one, so the parser sees two messages as one and misroutes them.",
      questions: [
        {
          q: "A client sends two framed requests, then half-closes its write side. After the replies, what does the server framed stream yield?",
          options: ["An error, because the connection was closed", "None once the two complete frames are consumed and the read buffer is empty", "A zero-length frame that must be skipped"],
          answer: 1,
          explain: "EOF with an empty decode buffer ends the stream normally. A truncated frame would instead produce an io error: bytes remaining on stream.",
        },
      ],
      resources: [
        {
          title: "tokio::net::UnixListener",
          url: "https://docs.rs/tokio/latest/tokio/net/struct.UnixListener.html",
          kind: "docs",
        },
        {
          title: "tokio_util::codec framing module",
          url: "https://docs.rs/tokio-util/latest/tokio_util/codec/index.html",
          kind: "docs",
        },
        {
          title: "LengthDelimitedCodec",
          url: "https://docs.rs/tokio-util/latest/tokio_util/codec/length_delimited/struct.LengthDelimitedCodec.html",
          kind: "docs",
        },
        {
          title: "Tokio tutorial: framing a stream",
          url: "https://tokio.rs/tokio/tutorial/framing",
          kind: "docs",
        },
      ],
    },
    {
      id: "p07",
      title: "Resource limits & isolation",
      minutes: 85,
      level: "industry",
      goal: "Bound a child's CPU, memory, file size, and process count with rlimits and cgroups, then understand which isolation they do not provide.",
      sections: [
        {
          h: "rlimits are inherited, cheap, and per-process",
          p: [
            "A resource limit is a soft/hard pair inherited across fork and exec. Set it before exec and every process the child spawns inherits it. Soft limits can be raised by the process up to the hard limit, so the hard limit is the enforcement boundary; drop privileges after setting limits so the child cannot raise them back.",
            "Which limits matter for a job runner: CPU (seconds of CPU, then SIGXCPU and finally SIGKILL), AS (address space, so an allocation-heavy job fails instead of pushing the host into swap), FSIZE (largest file a job may write), NPROC (fork bombs), and NOFILE (descriptor exhaustion).",
          ],
          code: `use rlimit::{getrlimit, setrlimit, Resource};

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub cpu_secs: u64,
    pub mem_bytes: u64,
    pub fsize_bytes: u64,
}

pub fn apply(limits: Limits) -> std::io::Result<()> {
    // The hard limit is the ceiling the child cannot exceed.
    setrlimit(Resource::CPU, limits.cpu_secs, limits.cpu_secs + 5)?;
    setrlimit(Resource::AS, limits.mem_bytes, limits.mem_bytes)?;
    setrlimit(Resource::FSIZE, limits.fsize_bytes, limits.fsize_bytes)?;
    setrlimit(Resource::NPROC, 64, 64)?;
    let (soft, hard) = getrlimit(Resource::NOFILE)?;
    tracing::debug!(soft, hard, "inherited NOFILE limit");
    Ok(())
}`,
          tip: "Enforce in the child, not in the caller. A limit applied in the parent applies to the parent; only inheritance or an explicit prlimit call affects the child.",
        },
        {
          h: "Apply limits in the child, not around it",
          p: [
            "From the parent, prlimit(2) can change another process's limits, but there is a race: the child may allocate before you call it. The correct place is pre_exec, which runs after fork and before exec, where Rust code is restricted to async-signal-safe operations: no allocation, no locks, no logging.",
            "tokio::process::Command exposes pre_exec with exactly that contract, and an error returned from the closure is reported by spawn(). Keep prlimit for supervising an existing child, raising NOFILE during a hot phase, or reading limits back for verification.",
          ],
          code: `use rlimit::{Resource, setrlimit};
use tokio::process::Command;

#[cfg(unix)]
pub fn limited(cmd: &mut Command, limits: Limits) {
    // SAFETY: the closure only issues setrlimit syscalls. No allocation,
    // no locks, no logging: this runs between fork and exec.
    unsafe {
        cmd.pre_exec(move || {
            setrlimit(Resource::CPU, limits.cpu_secs, limits.cpu_secs + 5)?;
            setrlimit(Resource::AS, limits.mem_bytes, limits.mem_bytes)?;
            setrlimit(Resource::FSIZE, limits.fsize_bytes, limits.fsize_bytes)?;
            setrlimit(Resource::NPROC, 64, 64)?;
            Ok(())
        });
    }
}`,
          tip: "A failure inside pre_exec aborts the spawn with an error, which is what you want: running the job without its limits is worse than not running it.",
        },
        {
          h: "cgroup v2 enforces groups",
          p: [
            "rlimits bind a process; cgroups bind a tree. In cgroup v2 you create a directory under a delegated subtree of /sys/fs/cgroup, write the controller files, then write the child's pid into cgroup.procs. Every descendant is accounted into that group, including grandchildren you never spawned directly.",
            "The files that map to job control: memory.max is the hard memory limit and the cgroup OOM killer kills a task inside the group when reclaim cannot get under it; cpu.max takes a quota and a period in microseconds, so 50000 100000 means half a CPU; pids.max caps forked processes and makes fork return EAGAIN; cgroup.kill takes a 1 and SIGKILLs the whole subtree, including concurrent forks.",
          ],
          code: `use std::fs;
use std::path::{Path, PathBuf};

pub fn isolate(name: &str, mem_bytes: u64, cpu_quota: u64) -> std::io::Result<PathBuf> {
    let dir = Path::new("/sys/fs/cgroup").join(name);
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("memory.max"), mem_bytes.to_string())?;
    // cpu.max is "<quota> <period>" in microseconds: half a core here.
    fs::write(dir.join("cpu.max"), format!("{cpu_quota} 100000"))?;
    fs::write(dir.join("pids.max"), "128")?;
    Ok(dir)
}

pub fn attach(dir: &Path, pid: u32) -> std::io::Result<()> {
    fs::write(dir.join("cgroup.procs"), pid.to_string())
}

pub fn kill_tree(dir: &Path) -> std::io::Result<()> {
    fs::write(dir.join("cgroup.kill"), "1") // SIGKILL the subtree, fork-safe
}`,
          tip: "Inside a container /sys/fs/cgroup is often read-only or delegated to a subpath. Surface EROFS or EPERM as a job failure instead of silently running without limits.",
        },
        {
          h: "What rlimits and cgroups do not stop",
          p: [
            "Neither mechanism stops a job from reading /etc/shadow, calling the cloud metadata endpoint, or writing outside its directory. Limiting what a process can see needs namespaces (mount, pid, network, user) and a syscall filter (seccomp); Landlock is the unprivileged filesystem-scope option.",
            "The pragmatic stack for a job runner: a dedicated uid per class, rlimits for cheap per-process bounds, a cgroup for group accounting and atomic kill, a private mount namespace with a read-only root where possible, and seccomp-bpf for the syscall surface. Each layer is independently useful; none replaces another.",
          ],
          list: [
            "Drop to a dedicated uid and gid before exec; never run untrusted jobs as root",
            "Mount the work directory nosuid, nodev, and noexec, and give the job only that path",
            "Deny outbound network unless the job contract requires it",
            "Log the applied limits and the child pid, so a policy rejection is explainable later",
          ],
          tip: "RLIMIT_AS counts virtual address space, so a job that mmaps a large file can hit it without high resident memory; cgroup memory.max counts charged memory. Choose by what you are protecting against.",
        },
      ],
      exercise: {
        prompt:
          "Implement spawn_limited(argv, limits): spawn argv with AS, CPU, and FSIZE limits installed in pre_exec, then read the child's AS limit back with prlimit and return it with the child. Return an error if the kernel reports a different value.",
        starter: `use rlimit::Resource;
use std::process::Stdio;
use tokio::process::{Child, Command};

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub cpu_secs: u64,
    pub mem_bytes: u64,
    pub fsize_bytes: u64,
}

// TODO: build the Command from argv, install limits in pre_exec,
// spawn, read AS back with prlimit, compare, and clean up on mismatch.
#[cfg(target_os = "linux")]
pub async fn spawn_limited(
    _argv: &[&str],
    _limits: Limits,
) -> std::io::Result<(Child, u64)> {
    todo!()
}`,
        hint: "prlimit(pid, Resource::AS, None, Some((&mut soft, &mut hard))) returns Result<()> and writes the current values. Compare soft with limits.mem_bytes, and on mismatch kill plus wait before returning the error.",
        solution: `use rlimit::{prlimit, Resource};
use std::process::Stdio;
use tokio::process::{Child, Command};

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub cpu_secs: u64,
    pub mem_bytes: u64,
    pub fsize_bytes: u64,
}

#[cfg(target_os = "linux")]
pub async fn spawn_limited(
    argv: &[&str],
    limits: Limits,
) -> std::io::Result<(Child, u64)> {
    let (program, args) = argv.split_first().expect("argv is not empty");
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cmd.process_group(0); // a timeout can kill grandchildren too

    // SAFETY: only setrlimit syscalls run between fork and exec here.
    unsafe {
        cmd.pre_exec(move || {
            rlimit::setrlimit(Resource::CPU, limits.cpu_secs, limits.cpu_secs + 5)?;
            rlimit::setrlimit(Resource::AS, limits.mem_bytes, limits.mem_bytes)?;
            rlimit::setrlimit(Resource::FSIZE, limits.fsize_bytes, limits.fsize_bytes)?;
            Ok(())
        });
    }

    let mut child = cmd.spawn()?;
    let pid = child.id().expect("child has not been reaped yet");
    let (mut soft, mut hard) = (0u64, 0u64);
    prlimit(pid as i32, Resource::AS, None, Some((&mut soft, &mut hard)))?;

    if soft != limits.mem_bytes {
        let _ = child.kill().await;
        let _ = child.wait().await; // reap before returning
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("AS limit mismatch: expected {}, got {soft}", limits.mem_bytes),
        ));
    }
    Ok((child, soft))
}`,
      },
      production: [
        "Every job class has explicit CPU seconds, memory bytes, file-size, and process-count limits in config.",
        "Limits are installed in pre_exec and verified once at startup by reading them back with prlimit.",
        "cgroup paths live under a delegated subtree; creation failures fail the job instead of degrading silently.",
        "A job that hits memory.max is retried at most once, then quarantined rather than looping on OOM.",
        "A job uid cannot read another job's work directory; a mount namespace enforces that, not file permissions alone.",
      ],
      crates: ["tokio", "rlimit", "nix", "libc", "tracing"],
      pitfall:
        "RLIMIT_AS exhaustion surfaces as an allocation abort inside the child, not a clean error; if you only inspect the exit status, a policy rejection looks like a random crash. Log the applied limits with the pid.",
      questions: [
        {
          q: "Which mechanism SIGKILLs every process in a cgroup tree, including processes forked while the kill is in progress?",
          options: ["killpg on the direct child process group", "RLIMIT_NPROC set to the current process count", "Writing 1 to the cgroup.kill file"],
          answer: 2,
          explain: "cgroup.kill kills the whole subtree and handles concurrent forks. killpg reaches one process group, and RLIMIT_NPROC only blocks new forks.",
        },
      ],
      resources: [
        {
          title: "rlimit crate: resource limits for Rust",
          url: "https://docs.rs/rlimit/latest/rlimit/",
          kind: "docs",
        },
        {
          title: "rlimit::Resource constants",
          url: "https://docs.rs/rlimit/latest/rlimit/struct.Resource.html",
          kind: "docs",
        },
        {
          title: "rlimit::prlimit for an arbitrary process",
          url: "https://docs.rs/rlimit/latest/rlimit/fn.prlimit.html",
          kind: "docs",
        },
        {
          title: "cgroups(7): Linux control groups",
          url: "https://man7.org/linux/man-pages/man7/cgroups.7.html",
          kind: "docs",
        },
      ],
    },
  ],
};
