/**
 * Operating systems track.
 *
 * Authored for the Rust Academy plugin. Every lesson is plain JSON-compatible
 * data consumed by src/app.js through build.mjs.
 */
export default {
  "key": "operating-systems",
  "prefix": "os",
  "title": "Operating systems",
  "blurb": "How the OS actually works: processes and scheduling, virtual memory, syscalls, filesystems, IO, namespaces and the kernel interfaces Rust talks to.",
  "level": "industry",
  "project": {
    "title": "Capstone: a userspace container runtime",
    "brief": "Build a minimal container runner in Rust that creates PID, mount, UTS, IPC and network namespaces, pivots into a prepared rootfs, applies cgroup v2 limits, drops capabilities, and propagates signals and exit codes to the caller. Then measure what the isolation does and does not give you: what is shared, what leaks through /proc, and where the limits fail open.",
    "deliverables": [
      "Namespace isolation with integration tests: new PID, mount, UTS, IPC and network namespaces, verified from inside and outside the container",
      "cgroup v2 resource limits for memory.max, pids.max and cpu.max, with a test that provokes the limit and asserts the failure mode",
      "Signal and exit-code propagation: SIGTERM forwarding, orphan reaping, and exact 128+signal exit status on the host",
      "An isolation and limit benchmark report: syscall overhead, memory ceiling behaviour, fork-bomb containment, and the known escape surfaces"
    ],
    "stack": [
      "nix",
      "libc",
      "caps",
      "tokio"
    ]
  },
  "lessons": [
    {
      "id": "os01",
      "n": 1,
      "title": "Processes, threads, and what the kernel actually shares",
      "minutes": 70,
      "level": "core",
      "goal": "Read task_struct through its user-visible effects: which resources clone(2) shares or copies per flag, and what that means for fork cost, memory and file offsets.",
      "sections": [
        {
          "h": "A process is a thread group with its own address space",
          "p": [
            "The kernel does not schedule processes; it schedules tasks. Each task is a task_struct with its own registers, kernel stack, scheduling entity and credentials. A process is a thread group: the first task's pid becomes the group's tgid, and every thread created with CLONE_THREAD shares that tgid. /proc/PID is the group view, /proc/PID/task lists the members, and /proc/self/task is how a process sees its own threads.",
            "This is why several classic statements are wrong on Linux. A thread is not a lighter process with a hidden scheduler; it is a task that shares resources by flag. Conversely, a process is not defined by having its own memory but by not passing CLONE_VM. Everything else - file table, signal handlers, namespaces - is opt-in sharing you can inspect in /proc/PID/status and /proc/PID/ns."
          ],
          "list": [
            "Same tgid, different pid: threads in one process",
            "Different tgid, shared page tables: possible only with CLONE_VM without CLONE_THREAD, and it is a bug factory",
            "A forked child inherits namespace membership and signal dispositions but gets a copied address space"
          ]
        },
        {
          "h": "clone(2) is the only primitive; everything else is a wrapper",
          "p": [
            "fork, vfork, pthread_create and posix_spawn are all library wrappers over clone or clone3. The flags decide the sharing, and there is no magic beyond them. CLONE_VM shares the address space, CLONE_FILES shares the file descriptor table, CLONE_FS shares the root and working directory, CLONE_SIGHAND shares handlers, CLONE_THREAD places the task in the caller's thread group, and the CLONE_NEW* flags create the namespaces covered later in this track.",
            "Because the flags are independent, the combinations are the interesting part. A thread without CLONE_FILES would have a separate descriptor table pointing at the same open file descriptions, which is why CLONE_FILES and CLONE_VM are almost always used together. When you audit a runtime that claims to isolate a workload, the clone flags are the first thing to read."
          ],
          "code": "// The kernel's view of one task, reduced to the fields that explain behaviour.\nstruct task_struct {\n    pid_t pid;            // this task\n    pid_t tgid;           // thread group leader: what userspace calls \"the process\"\n    struct mm_struct *mm; // shared only when CLONE_VM was passed\n    struct files_struct *files; // shared when CLONE_FILES\n    struct signal_struct *signal;\n    struct nsproxy *nsproxy;    // the CLONE_NEW* bundle\n    struct sched_entity se;     // vruntime lives here (EEVDF/CFS)\n};"
        },
        {
          "h": "Copy-on-write makes fork cheap, not free",
          "p": [
            "fork copies the page tables and marks every writable private page read-only in both processes. Nothing is copied until one side writes, at which point the fault handler allocates a page, copies the contents and re-enables write access. That is why a 1 GiB process can fork in microseconds and why the first write in the child costs a minor fault per page, not one big copy.",
            "The cost lands later and unevenly: page-table pages must be duplicated up front, RSS is shared but the first writes split it, and transparent huge pages turn a 4 KiB fault into a 2 MiB copy. In a threaded program, fork is worse than expensive - the child has one thread and cloned locks, so only async-signal-safe calls are legal before exec. That is the real reason posix_spawn exists."
          ],
          "tip": "If a service forks to run a child, do it before spawning threads, or use posix_spawn/Command so the gap between fork and exec stays inside libc."
        },
        {
          "h": "Measure the sharing instead of assuming it",
          "p": [
            "The file offset is the cleanest probe of what fork shares, because it lives in the open file description, not in the descriptor table. Open a file, fork, read four bytes in the child, then read in the parent: the parent continues at byte four. The address space, by contrast, diverges on first write. Two probes, two different answers, both explained by the same flag table.",
            "In production the same distinction shows up as bugs: a log file opened before fork has one shared offset, so parent and child interleave writes at the kernel level but not atomically; a buffer allocated before fork is shared until either side writes it. Counting threads through /proc/self/task is also the cheapest way to catch a runtime spawning more than you think."
          ],
          "code": "use std::fs;\nuse std::thread;\n\nfn threads_now() -> usize {\n    fs::read_dir(\"/proc/self/task\").unwrap().count()\n}\n\nfn main() {\n    println!(\"tasks at start: {}\", threads_now());\n    let handles: Vec<_> = (0..3)\n        .map(|_| thread::spawn(|| std::thread::sleep(std::time::Duration::from_millis(50))))\n        .collect();\n    println!(\"tasks while running: {}\", threads_now());\n    for h in handles { h.join().unwrap(); }\n    println!(\"tasks after join: {}\", threads_now());\n}"
        }
      ],
      "exercise": {
        "prompt": "Prove which resource fork shares and which it copies. Open a file, fork, read four bytes in the child, wait for the child, then read four bytes in the parent. Print both reads and explain the offset you observe.",
        "starter": "use std::fs::File;\nuse std::io::Read;\nuse std::os::fd::AsRawFd;\n\nfn main() -> std::io::Result<()> {\n    let mut f = File::open(\"/etc/hostname\")?;\n    // 1. fork with libc::fork\n    // 2. in the child: read 4 bytes through the raw fd, print, _exit(0)\n    // 3. in the parent: waitpid, then read 4 bytes and print\n    Ok(())\n}",
        "hint": "The offset lives in the open file description, which fork shares. Read through the raw fd in the child so the stdio buffer does not absorb the bytes; use libc::_exit in the child, never a normal return.",
        "solution": "use std::fs::File;\nuse std::io::{Read, Seek, SeekFrom};\nuse std::os::fd::AsRawFd;\n\nfn main() -> std::io::Result<()> {\n    let mut f = File::open(\"/etc/hostname\")?;\n    f.seek(SeekFrom::Start(0))?;\n\n    unsafe {\n        let pid = libc::fork();\n        assert!(pid >= 0, \"fork failed\");\n        if pid == 0 {\n            let mut buf = [0u8; 4];\n            let n = libc::read(f.as_raw_fd(), buf.as_mut_ptr().cast(), 4);\n            println!(\"child read {n}: {:?}\", String::from_utf8_lossy(&buf));\n            libc::_exit(0); // not return: the child must not run the parent's code\n        }\n        let mut status = 0;\n        libc::waitpid(pid, &mut status, 0);\n    }\n\n    let mut buf = [0u8; 4];\n    let n = f.read(&mut buf)?;\n    println!(\"parent next read {n}: {:?}\", String::from_utf8_lossy(&buf));\n    Ok(())\n}"
      },
      "production": [
        "Fork before starting threads, or use Command/posix_spawn so no user locks exist between fork and exec.",
        "Never rely on a shared log file offset for ordering; each process opens its own description and uses O_APPEND.",
        "Watch /proc/PID/status Threads and /proc/PID/task in tests to catch runtime thread leaks.",
        "For memory ceilings, measure RSS after the first write, not VmSize at fork: COW defers the charge."
      ],
      "crates": [
        "nix",
        "libc",
        "rustix"
      ],
      "pitfall": "Forking a multithreaded process and calling malloc in the child: another thread may have held the allocator lock at fork time, so the child deadlocks before it can exec.",
      "questions": [
        {
          "q": "A single-threaded process calls fork(). Which resource does the child get a private copy of?",
          "options": [
            "The open file description, so reads continue independently",
            "The page tables, with writable private pages marked copy-on-write",
            "The signal handlers, which are reset to SIG_DFL in the child",
            "The current working directory, which the child may change alone"
          ],
          "answer": 1,
          "explain": "fork copies the address space as copy-on-write. The open file description is shared, signal dispositions are inherited, and the cwd is shared through fs_struct unless CLONE_FS was passed."
        },
        {
          "q": "What does CLONE_VM without CLONE_THREAD produce?",
          "options": [
            "An ordinary thread that shares the thread group",
            "Two tasks with one address space but separate PIDs and signal queues",
            "A child that shares file descriptors but not memory",
            "A process that cannot be scheduled on another CPU"
          ],
          "answer": 1,
          "explain": "CLONE_VM shares mm_struct; without CLONE_THREAD the task is not in the caller's thread group, so it has its own pid and signal state. It is legal and almost always a mistake."
        },
        {
          "q": "Why can the first write after fork be slower than the write before it?",
          "options": [
            "The kernel must copy the entire heap before the write returns",
            "The write triggers a write-protect fault and one page copy, and may split a huge page",
            "The child is running at a lower scheduling priority until exec",
            "The write must be flushed to disk because the page is now shared"
          ],
          "answer": 1,
          "explain": "COW faults per page: the fault handler allocates a page, copies it, and fixes the PTE. The copy is page-sized, not heap-sized, and a THP fault can copy 2 MiB."
        }
      ],
      "quickbytes": [
        "Read /proc/PID/status for Tgid, Threads and VmRSS; read /proc/PID/task to count tasks.",
        "clone flags are the sharing contract: VM, FILES, FS, SIGHAND, THREAD, NEW*.",
        "Between fork and exec only async-signal-safe calls are legal; malloc is not one.",
        "The file offset is shared after fork; the address space is not."
      ],
      "github": [
        {
          "name": "nix - fork, clone and waitpid bindings",
          "url": "https://github.com/nix-rust/nix"
        },
        {
          "name": "tokio - userspace task scheduling on top of threads",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "resources": [
        {
          "title": "clone(2): the flag table that defines sharing",
          "url": "https://man7.org/linux/man-pages/man2/clone.2.html",
          "kind": "docs"
        },
        {
          "title": "proc(5): /proc/PID/status, task and ns",
          "url": "https://man7.org/linux/man-pages/man5/proc.5.html",
          "kind": "docs"
        },
        {
          "title": "nix::sched and nix::unistd API",
          "url": "https://docs.rs/nix/latest/nix/sched/",
          "kind": "docs"
        },
        {
          "title": "Linux kernel source: kernel/fork.c",
          "url": "https://github.com/torvalds/linux",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "os02",
      "n": 2,
      "title": "CPU scheduling: vruntime, nice, and affinity",
      "minutes": 80,
      "level": "core",
      "goal": "Understand how the fair scheduler turns nice values and cgroup weights into CPU time, when affinity helps, and how to measure scheduling behaviour instead of guessing.",
      "sections": [
        {
          "h": "Fair scheduling is accounting, not timeslices",
          "p": [
            "The fair scheduler gives each runnable task a weight derived from its nice value - each nice step is roughly a 1.25x change in weight - and tracks how much virtual time it has consumed. The task with the least virtual runtime runs next; when it runs, its vruntime advances in proportion to real time divided by its weight, so a task with double the weight accumulates vruntime half as fast.",
            "CFS implemented this with a red-black tree keyed by vruntime and a monotonic min_vruntime. Since 6.6 the fair class is EEVDF, which keeps the weight model but replaces the tree's implicit timeslicing with explicit lag and slice: a task's lag is how far its virtual time is behind the weighted average, and eligible tasks with positive lag get scheduled in deadline order. The practical consequence is the same: no fixed quantum, no priority numbers, just relative weight and latency targets."
          ],
          "list": [
            "nice is per-thread on Linux, not per-process, whatever POSIX says",
            "Each nice step changes weight by about 1.25x, so -20 versus 19 is a huge ratio",
            "SCHED_BATCH assumes CPU-bound work and avoids wakeup preemption",
            "SCHED_IDLE runs only when nothing else wants the CPU"
          ]
        },
        {
          "h": "Nice is local; cgroup weight is global",
          "p": [
            "The classic trap: with autogrouping enabled, nice only orders tasks inside the same session. Two terminals running CPU hogs will each get half the machine regardless of nice. For real capacity control you need the cgroup v2 cpu controller: cpu.weight (1..10000, default 100) divides time between sibling groups, and cpu.max ('quota period' or 'max') imposes a hard bandwidth ceiling that throttles rather than slows.",
            "These are different instruments. cpu.weight is proportional and work-conserving - an idle group donates its share. cpu.max is absolute and unpaid: a group that exhausts its quota is throttled until the next period, which shows up as latency spikes, not as slower progress. Choose weight for sharing a busy host and max for protecting a host from one tenant, and never set both to solve the same problem."
          ],
          "code": "# cgroup v2 CPU controls are two different mechanisms.\n# Proportional share between siblings: 3:1 in favour of api over batch.\necho 300 > /sys/fs/cgroup/api.slice/cpu.weight\necho 100 > /sys/fs/cgroup/batch.slice/cpu.weight\n\n# Hard ceiling: 200ms of CPU per 100ms period = 2 full CPUs, then throttled.\necho \"200000 100000\" > /sys/fs/cgroup/api.slice/cpu.max\n\n# Watch throttling (nr_throttled) and runtime consumed.\ncat /sys/fs/cgroup/api.slice/cpu.stat\n# usage_usec 18273645\n# nr_periods 9182\n# nr_throttled 731\n# throttled_usec 41200431",
          "tip": "A rising nr_throttled with a flat usage_usec means the ceiling is binding; a rising nr_throttled with rising usage means the workload is bursty, not over limit."
        },
        {
          "h": "Affinity pins a thread, and topology decides the price",
          "p": [
            "sched_setaffinity takes a CPU mask per thread. Pinning removes the load balancer's ability to move work, which helps only when you know the topology: pin a latency-sensitive thread away from its SMT sibling, or keep a polling thread and its interrupt on the same NUMA node. Pinning everything to CPU 0 is the most common self-inflicted outage in this area.",
            "The kernel exposes the facts you need: /sys/devices/system/cpu/cpuN/topology/thread_siblings_list for SMT pairs, nodeN for NUMA, and /proc/schedstat for per-CPU run time. Read them at startup instead of hard-coding masks, because the same container image runs on laptops and 128-core servers. A mask that assumes eight CPUs either fails outright or silently leaves most of a large machine idle, and both outcomes are hard to notice because the service keeps answering requests."
          ],
          "code": "use std::mem::MaybeUninit;\n\nfn main() {\n    unsafe {\n        let mut set: libc::cpu_set_t = MaybeUninit::zeroed().assume_init();\n        libc::CPU_ZERO(&mut set);\n        libc::CPU_SET(0, &mut set);\n\n        let rc = libc::sched_setaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &set);\n        if rc != 0 {\n            eprintln!(\"sched_setaffinity: {}\", std::io::Error::last_os_error());\n            return;\n        }\n\n        let mut got: libc::cpu_set_t = MaybeUninit::zeroed().assume_init();\n        libc::sched_getaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &mut got);\n        println!(\"cpu0={} cpu1={} running on {}\",\n            libc::CPU_ISSET(0, &got), libc::CPU_ISSET(1, &got), libc::sched_getcpu());\n    }\n}"
        },
        {
          "h": "Measure context switches, not intuition",
          "p": [
            "/proc/self/sched reports nr_switches, nr_voluntary_switches, nr_involuntary_switches and se.sum_exec_runtime. Voluntary switches mean the thread blocked - a lock, a read, a futex. Involuntary switches mean the scheduler preempted it while runnable, which is what CPU oversubscription looks like from inside the process. A thread that never yields voluntarily but shows thousands of involuntary switches is competing for its CPU, not waiting on anything.",
            "For capacity questions, measure utilization and run-queue delay rather than elapsed time. A 10 ms request that spends 9 ms waiting to be scheduled is not a slow algorithm. perf sched and /proc/PID/schedstat separate run time from wait time; pressure stall information (PSI) aggregates it per cgroup and is the number to alert on."
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a probe that runs a fixed busy loop and reports the thread's context switches, runtime from /proc/self/sched, and which CPU it finished on. Then run it pinned to one CPU and explain the difference.",
        "starter": "use std::time::Instant;\n\nfn main() {\n    // 1. read /proc/self/sched before the loop\n    // 2. run a fixed amount of work (e.g. 200M wrapping multiply)\n    // 3. read the file again and print nr_switches and se.sum_exec_runtime\n    // 4. print sched_getcpu() and the elapsed wall time\n}",
        "hint": "Parse lines by their leading key: se.sum_exec_runtime and nr_switches. Use std::hint::black_box so the loop is not optimized away, and compare runtime to wall time to see how much of the wall time was not CPU time.",
        "solution": "use std::time::Instant;\n\nfn read_sched() -> (u64, u64) {\n    let text = std::fs::read_to_string(\"/proc/self/sched\").unwrap();\n    let mut switches = 0;\n    let mut runtime = 0;\n    for line in text.lines() {\n        let line = line.trim();\n        if let Some(v) = line.strip_prefix(\"nr_switches\") {\n            switches = v.trim_start_matches(':').trim().parse().unwrap();\n        }\n        if let Some(v) = line.strip_prefix(\"se.sum_exec_runtime\") {\n            let secs: f64 = v.trim_start_matches(':').trim().parse().unwrap();\n            runtime = (secs * 1e9) as u64;\n        }\n    }\n    (switches, runtime)\n}\n\nfn main() {\n    let (before_sw, before_rt) = read_sched();\n    let t0 = Instant::now();\n    let mut x: u64 = 1;\n    for i in 1..200_000_000u64 {\n        x = std::hint::black_box(x.wrapping_mul(i) ^ i);\n    }\n    let wall = t0.elapsed();\n    let (after_sw, after_rt) = read_sched();\n\n    unsafe {\n        println!(\"finished on cpu {}\", libc::sched_getcpu());\n    }\n    println!(\"switches: {} ({} new)\", after_sw, after_sw - before_sw);\n    println!(\"cpu time {:.3}s of {:.3}s wall\", (after_rt - before_rt) as f64 / 1e9, wall.as_secs_f64());\n    println!(\"black box: {x}\");\n}"
      },
      "production": [
        "Set CPU limits with cpu.max for hard ceilings and cpu.weight for proportional sharing; record which one a limit change touched.",
        "Alert on cgroup cpu.stat nr_throttled and on PSI cpu some avg10, not only on request latency.",
        "Derive affinity masks from topology files instead of hard-coding CPU numbers.",
        "Treat involuntary context switches as evidence of oversubscription, not of application slowness."
      ],
      "crates": [
        "libc",
        "nix",
        "tokio"
      ],
      "pitfall": "Using nice to prioritize a service inside a cgroup: nice orders threads within a scheduling group, while the group's cpu.weight decides how much CPU the whole service gets.",
      "questions": [
        {
          "q": "Two CPU-bound tasks in different login sessions run with nice -10 and nice 10. With autogrouping on, what happens?",
          "options": [
            "The nicer task gets roughly 25 times more CPU",
            "Both sessions get about half the CPU, then nice orders tasks inside each session",
            "The nicer task runs first on every CPU and the other is throttled to zero",
            "nice has no effect at all on SCHED_OTHER tasks"
          ],
          "answer": 1,
          "explain": "Autogrouping puts each session in its own task group; the fair scheduler divides between groups first. With one task per group the groups split the CPU evenly, so the cross-session nice difference buys nothing."
        },
        {
          "q": "cpu.max is set to '100000 100000'. What does the workload observe?",
          "options": [
            "Its threads run at half speed continuously",
            "It gets one CPU-second per second, then all its threads are throttled until the next period",
            "It is limited to 100 threads that each get one full CPU",
            "It is moved to SCHED_IDLE for the rest of the period"
          ],
          "answer": 1,
          "explain": "cpu.max is a quota: runtime per period. Exhausting it throttles the whole group until the period rolls over, so the symptom is latency spikes at period boundaries, not a uniform slowdown."
        },
        {
          "q": "Which file tells you the thread was preempted while it still wanted to run?",
          "options": [
            "/proc/self/status VmRSS",
            "/proc/self/sched nr_involuntary_switches",
            "/proc/self/statm resident pages",
            "/proc/self/limits Max cpu time"
          ],
          "answer": 1,
          "explain": "Involuntary switches count preemptions of a runnable task, the signature of CPU oversubscription. Voluntary switches mean the task blocked on its own."
        }
      ],
      "quickbytes": [
        "Read /proc/self/sched for se.sum_exec_runtime and nr_involuntary_switches.",
        "cpu.weight shares, cpu.max caps; mixing them up produces the wrong failure mode.",
        "Check cpu.stat nr_throttled before blaming the application for latency.",
        "Build affinity masks from /sys/devices/system/cpu/*/topology, not from constants."
      ],
      "github": [
        {
          "name": "Linux kernel scheduler sources",
          "url": "https://github.com/torvalds/linux"
        },
        {
          "name": "tokio - cooperative scheduling and runtime worker control",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "resources": [
        {
          "title": "CFS scheduler design (kernel documentation)",
          "url": "https://docs.kernel.org/scheduler/sched-design-CFS.html",
          "kind": "docs"
        },
        {
          "title": "EEVDF scheduler (kernel documentation)",
          "url": "https://docs.kernel.org/scheduler/sched-eevdf.html",
          "kind": "docs"
        },
        {
          "title": "sched(7): policies, nice, RT limits, autogroup",
          "url": "https://man7.org/linux/man-pages/man7/sched.7.html",
          "kind": "docs"
        },
        {
          "title": "Control Group v2: cpu controller and cpu.max",
          "url": "https://docs.kernel.org/admin-guide/cgroup-v2.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "os03",
      "n": 3,
      "title": "Virtual memory: page tables, PTEs and demand paging",
      "minutes": 85,
      "level": "core",
      "goal": "Trace a virtual address through a four-level page table, then explain why mmap is nearly free, why touching pages is not, and what RSS actually measures.",
      "sections": [
        {
          "h": "Translation is a tree walk, cached by the TLB",
          "p": [
            "On x86-64 with four-level paging, a 48-bit virtual address splits into four 9-bit indices and a 12-bit offset. The page-table base register (CR3) points at the top level, each entry points at the next table, and the final entry holds the physical frame plus permission bits. Five memory reads per translation is unacceptable, so the TLB caches recent translations and the walk itself caches intermediate levels.",
            "The PTE bits are the policy: present, writable, user-accessible, no-execute, accessed, dirty, and copy-on-write encoded as writable-clear on a shared frame. Every protection change is a page-table edit followed by a TLB invalidation, which is why mprotect on a large range costs more than the syscall suggests, and why a remote core must be interrupted for the invalidation."
          ],
          "list": [
            "PTE: present, rw, user, nx, accessed, dirty, global",
            "A COW page is a private mapping whose PTE is writable-clear in both processes",
            "Huge pages collapse a level: one 2 MiB PTE instead of 512 4 KiB PTEs",
            "/proc/PID/pagemap exposes PFNs only with CAP_SYS_ADMIN; treat it as privileged"
          ]
        },
        {
          "h": "mmap reserves address space; the fault does the work",
          "p": [
            "Anonymous mmap returns a range in the process's address space and nothing else: no physical pages, no page-table pages for the untouched range, no charge to the memory cgroup. The first read or write causes a page fault; for anonymous memory the handler installs a shared zero page read-only, and the first write allocates a real frame and charges it. This is demand-zero paging, and it is why VmSize is meaningless as a memory metric.",
            "File-backed mappings behave differently. The page cache is the file's in-memory representation, and the fault maps the cached folio directly into the process. Read-only file pages are shared by every process mapping that file; a write to a MAP_SHARED page dirties the page cache and eventually writes back. A minor fault is resolved from memory, a major fault needs storage, and the ratio between them is one of the most useful IO diagnostics you have."
          ],
          "code": "use std::time::Instant;\n\nfn main() {\n    let len = 256 * 1024 * 1024usize;\n    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };\n    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) };\n    let before = ru.ru_minflt;\n\n    let t0 = Instant::now();\n    let p = unsafe {\n        libc::mmap(std::ptr::null_mut(), len,\n            libc::PROT_READ | libc::PROT_WRITE,\n            libc::MAP_PRIVATE | libc::MAP_ANONYMOUS, -1, 0)\n    };\n    assert_ne!(p, libc::MAP_FAILED, \"mmap failed\");\n    println!(\"mmap of 256 MiB returned in {:?}\", t0.elapsed());\n\n    let t1 = Instant::now();\n    unsafe { std::ptr::write_volatile(p as *mut u8, 1) }; // one page fault\n    println!(\"first touch took {:?}\", t1.elapsed());\n\n    unsafe {\n        libc::getrusage(libc::RUSAGE_SELF, &mut ru);\n        libc::munmap(p, len);\n    }\n    println!(\"minor faults since before mmap: {}\", ru.ru_minflt - before);\n}",
          "tip": "Run the same probe with MAP_POPULATE and compare: you pay the faults up front instead of at first touch, which is a latency trade, not a saving."
        },
        {
          "h": "What the kernel charges, and where it lies",
          "p": [
            "RSS counts resident pages, including shared file pages, so summing RSS across processes double-counts. PSS apportions shared pages, and USS counts only private ones; /proc/PID/smaps_rollup gives all three. The memory cgroup charges a page to the group that faulted it in, and it stays charged there until reclaimed or freed, even if the process migrates - which is why moving a busy process between cgroups does not move its memory.",
            "Overcommit is the other lie. Linux grants address space optimistically; the OOM killer resolves the debt when there is no page to reclaim. A process can therefore mmap 100 GiB successfully and die later on a fault. If you need a guarantee, set vm.overcommit_memory=2 with a swap-aware ratio, or rely on a memory.max cgroup limit where the failure is a scoped OOM kill rather than a machine-wide one."
          ]
        },
        {
          "h": "Where the time actually goes",
          "p": [
            "Page faults dominate startup for large binaries and JIT heaps. They also serialize: the fault path takes mmap_lock for read in most cases, but a fault that needs to grow a mapping or fault in a THP takes it for write, briefly blocking other faults in the same process. That is why a program with hundreds of threads can show mysterious latency at first touch.",
            "The mitigations are all about batching: MAP_POPULATE or madvise(MADV_WILLNEED) for predictable reads, huge pages to cut fault count by 512x, and pre-touching a buffer pool at startup so the fault cost is not paid on the request path. Each trades memory or startup time for steady-state latency, and each should be justified by a measurement of the fault counters."
          ]
        }
      ],
      "exercise": {
        "prompt": "Map 64 MiB PROT_NONE, then mprotect it 4 KiB at a time and write one byte per page. Count minor faults and show that untouched pages were never charged. Explain the fault count you get.",
        "starter": "fn main() {\n    let len = 64 * 1024 * 1024usize;\n    // 1. mmap PROT_NONE | MAP_PRIVATE | MAP_ANONYMOUS\n    // 2. loop over pages: mprotect each page RW, then write one byte\n    // 3. read getrusage before and after and print ru_minflt\n    // 4. munmap\n}",
        "hint": "mprotect itself does not fault a page in; the first write after it does. Expect roughly one minor fault per page you touch, and zero for the pages you skip. Read the counters before mmap so the arithmetic is honest.",
        "solution": "fn main() {\n    let len = 64 * 1024 * 1024usize;\n    let page = 4096usize;\n\n    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };\n    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) };\n    let before = ru.ru_minflt;\n\n    let base = unsafe {\n        libc::mmap(std::ptr::null_mut(), len, libc::PROT_NONE,\n            libc::MAP_PRIVATE | libc::MAP_ANONYMOUS, -1, 0)\n    };\n    assert_ne!(base, libc::MAP_FAILED);\n\n    // Touch only every other page: the skipped half must stay uncharged.\n    let touched = (0..len).step_by(page * 2).count();\n    for off in (0..len).step_by(page * 2) {\n        let addr = unsafe { (base as *mut u8).add(off) };\n        let rc = unsafe { libc::mprotect(addr.cast(), page, libc::PROT_READ | libc::PROT_WRITE) };\n        assert_eq!(rc, 0, \"mprotect: {}\", std::io::Error::last_os_error());\n        unsafe { std::ptr::write_volatile(addr, 1) };\n    }\n\n    unsafe {\n        libc::getrusage(libc::RUSAGE_SELF, &mut ru);\n        libc::munmap(base, len);\n    }\n    println!(\"pages touched: {touched}\");\n    println!(\"minor faults: {}\", ru.ru_minflt - before);\n    println!(\"resident after touch is about {} KiB\", touched * 4);\n}"
      },
      "production": [
        "Report PSS or USS from smaps_rollup for capacity; never sum RSS across processes.",
        "Alert on major faults per request when serving from a file-backed cache; they indicate a cold or evicted working set.",
        "Pre-touch latency-critical buffers at startup, and document the memory cost of doing so.",
        "Set memory.max per workload so overcommit failures are scoped to a cgroup instead of the host OOM killer."
      ],
      "crates": [
        "libc",
        "rustix",
        "nix"
      ],
      "pitfall": "Treating VmSize as memory usage: an mmap of 100 GiB is address space, not pages, and a service can pass every size check while its RSS is a rounding error - until the first touch of each page.",
      "questions": [
        {
          "q": "An anonymous page is mapped, read, and never written. What backs it?",
          "options": [
            "A freshly zeroed physical page charged to the process",
            "The shared zero page, mapped read-only, with no per-process charge",
            "A swap slot allocated eagerly at mmap time",
            "Nothing: reads of untouched anonymous memory return EFAULT"
          ],
          "answer": 1,
          "explain": "Demand-zero paging maps the kernel's shared zero page read-only. Only the first write allocates and charges a private frame, which is why read-only touched memory can stay free."
        },
        {
          "q": "Why does mprotect over a large range cost more than the syscall entry suggests?",
          "options": [
            "It copies the protected pages to swap",
            "It edits PTEs and must invalidate stale TLB entries, interrupting other cores that ran the process",
            "It upgrades the mapping to a huge page, which requires compaction",
            "It walks the page tables twice because of the VMA lock"
          ],
          "answer": 1,
          "explain": "The PTE edits are cheap; the TLB shootdown IPIs are not. The kernel batches them, but the cost still scales with cores that have the range cached."
        },
        {
          "q": "A process is moved to a different memory cgroup while holding 2 GiB of anonymous memory. What happens to the charge?",
          "options": [
            "It moves with the process immediately",
            "It stays with the old cgroup until the pages are reclaimed or freed",
            "The move fails with EBUSY while memory is charged",
            "The pages are reclaimed first, then the process is moved"
          ],
          "answer": 1,
          "explain": "Memory is charged at fault time and stays with the cgroup that faulted it. Migration does not re-parent existing charges, so a moved process can keep pressuring its old group."
        }
      ],
      "quickbytes": [
        "VmSize is address space; RSS is resident; PSS apportions shared pages; only PSS adds up.",
        "Demand-zero means read-only anonymous pages cost nothing until written.",
        "Compare ru_minflt and ru_majflt before and after any mmap experiment.",
        "MAP_POPULATE moves fault cost to mmap time; it does not remove it."
      ],
      "github": [
        {
          "name": "Linux kernel memory management sources",
          "url": "https://github.com/torvalds/linux"
        },
        {
          "name": "rustix - mm module with safe mmap/mprotect wrappers",
          "url": "https://github.com/bytecodealliance/rustix"
        }
      ],
      "resources": [
        {
          "title": "Page tables (kernel documentation)",
          "url": "https://docs.kernel.org/mm/page_tables.html",
          "kind": "docs"
        },
        {
          "title": "mmap(2): mapping flags and fault semantics",
          "url": "https://man7.org/linux/man-pages/man2/mmap.2.html",
          "kind": "docs"
        },
        {
          "title": "rustix::mm API reference",
          "url": "https://docs.rs/rustix/latest/rustix/mm/",
          "kind": "docs"
        },
        {
          "title": "Linux kernel source: mm/memory.c fault path",
          "url": "https://github.com/torvalds/linux",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "os04",
      "n": 4,
      "title": "The system call boundary: registers, vDSO and errno",
      "minutes": 70,
      "level": "core",
      "goal": "Read a syscall from both sides: the exact register contract on x86-64, what the mode switch costs, and why some libc calls never enter the kernel at all.",
      "sections": [
        {
          "h": "One instruction, one ABI",
          "p": [
            "On x86-64 Linux a syscall is a single syscall instruction. The number goes in rax, arguments in rdi, rsi, rdx, r10, r8 and r9 (note r10 instead of rcx), and the result comes back in rax. The instruction saves the return address in rcx and flags in r11, which is why those registers are clobbered and why a wrapper must declare them. The kernel switches to its own stack and returns with sysret.",
            "Negative returns are errors: values in -4095..-1 are -errno and the libc wrapper turns them into a -1 return plus errno. That convention is the entire error model of the boundary. Rust's io::Error::last_os_error() reads the thread-local errno that the wrapper set; calling it after a successful call returns a stale value from an earlier failure, which is a classic source of nonsense diagnostics."
          ],
          "code": "use std::arch::asm;\n\n// x86-64 only: syscall clobbers rcx (return address) and r11 (flags).\n#[inline]\nunsafe fn raw_syscall(nr: u64, a1: u64, a2: u64, a3: u64) -> i64 {\n    let ret: i64;\n    asm!(\n        \"syscall\",\n        inlateout(\"rax\") nr as i64 => ret,\n        in(\"rdi\") a1,\n        in(\"rsi\") a2,\n        in(\"rdx\") a3,\n        lateout(\"rcx\") _,\n        lateout(\"r11\") _,\n        options(nostack)\n    );\n    ret\n}\n\nfn main() {\n    // SYS_getpid = 39, SYS_gettid = 186 on x86-64\n    let pid = unsafe { raw_syscall(39, 0, 0, 0) };\n    let tid = unsafe { raw_syscall(186, 0, 0, 0) };\n    println!(\"getpid={pid} gettid={tid}\");\n\n    let bad = unsafe { raw_syscall(39, 0, 0, 0) };\n    assert!(bad > 0, \"kernel returns -errno, libc converts it\");\n}"
        },
        {
          "h": "What the switch costs",
          "p": [
            "A syscall does not pay for a full context switch, but it is not free either: privilege transition, stack switch, entry trampoline, KPTI page-table swap on older mitigations, argument validation and the return path. On current server hardware a trivial syscall is a few hundred nanoseconds when mitigations are active; a getpid loop can exceed a million calls per second only by pinning a core and doing nothing else.",
            "The cost matters at scale, not in isolation. A service doing four syscalls per request at 100k requests per second is doing 400k crossings per second, which is real CPU. The fixes are batching (readv, sendmmsg, epoll_wait returning many events), avoiding the crossing entirely (vDSO, mmap), or moving the queue into shared memory (io_uring, covered later)."
          ],
          "list": [
            "Batch where the API allows it: readv/writev, sendmmsg/recvmmsg, epoll_wait",
            "Use vDSO for clocks and getcpu: no privilege transition",
            "Prefer mmap over read for large, repeatedly accessed files",
            "Count syscalls per request with strace -c before optimizing anything"
          ]
        },
        {
          "h": "The vDSO: kernel code mapped into userspace",
          "p": [
            "clock_gettime, gettimeofday, time, getcpu and rseq are served by the vDSO, a small ELF shared object the kernel maps into every process. The call runs in userspace, reads a timekeeping structure the kernel updates, and never executes syscall. That is why a clock read costs about 20 ns while a getpid costs hundreds: one is a function call, the other a privilege transition.",
            "The vDSO is also a compatibility surface. If the kernel's data structure changes, the vDSO changes with it, which is why statically linked binaries still get correct time. Rust's std::time::Instant goes through clock_gettime(CLOCK_MONOTONIC), so it is already on the fast path; wrapping it in a syscall of your own would be strictly worse."
          ],
          "code": "use std::time::Instant;\n\nfn main() {\n    // Clock reads go through the vDSO: no syscall instruction, no errno.\n    let t0 = Instant::now();\n    let mut acc = 0u64;\n    for _ in 0..1_000_000 {\n        acc = acc.wrapping_add(Instant::now().elapsed().as_nanos() as u64 & 1);\n    }\n    println!(\"1M clock reads + elapsed: {:?} (acc {acc})\", t0.elapsed());\n\n    // A raw getpid loop pays the transition every iteration.\n    let t1 = Instant::now();\n    for _ in 0..1_000_000 {\n        std::hint::black_box(unsafe { libc::syscall(libc::SYS_getpid) });\n    }\n    println!(\"1M getpid syscalls: {:?}\", t1.elapsed());\n}",
          "tip": "If a benchmark claims a syscall is 50 ns, check for vDSO substitution and for a kernel built without Spectre mitigations; both change the answer by an order of magnitude."
        },
        {
          "h": "Reading the boundary from outside",
          "p": [
            "strace -c -f aggregates syscall counts and time per syscall across threads; it is the first tool for a process that is busy but does not look busy. perf trace gives the same view with less overhead and can sample stacks. /proc/PID/syscall shows the syscall a blocked thread is currently in, which distinguishes a futex wait from a read on a socket.",
            "Interpretation matters more than collection. EAGAIN is not an error - it means try again later, and a non-blocking loop that treats it as fatal is broken. EINTR means a signal arrived before the call did any work and the call should be retried unless the API is documented otherwise. ENOENT from openat on a path that exists usually means a missing directory component or a race, not a permissions problem."
          ]
        }
      ],
      "exercise": {
        "prompt": "Build a tiny syscall benchmark: time 1,000,000 raw getpid calls with inline asm, then time 1,000,000 clock_gettime(CLOCK_MONOTONIC) calls, then report the per-call cost of each and explain the ratio.",
        "starter": "use std::arch::asm;\nuse std::time::Instant;\n\nunsafe fn raw_getpid() -> i64 {\n    let ret: i64;\n    // fill in the asm block: syscall with rax=39\n    ret\n}\n\nfn main() {\n    // 1. time 1M raw_getpid\n    // 2. time 1M libc::clock_gettime(CLOCK_MONOTONIC, &mut ts)\n    // 3. print ns per call for both\n}",
        "hint": "Use black_box on results so the loop is not removed. clock_gettime goes through the vDSO, so expect tens of nanoseconds; getpid pays the full transition, hundreds of nanoseconds. Report both ratios rather than absolute numbers.",
        "solution": "use std::arch::asm;\nuse std::time::Instant;\n\n#[inline]\nunsafe fn raw_getpid() -> i64 {\n    let ret: i64;\n    asm!(\n        \"syscall\",\n        inlateout(\"rax\") 39i64 => ret,\n        lateout(\"rcx\") _,\n        lateout(\"r11\") _,\n        options(nostack)\n    );\n    ret\n}\n\nfn main() {\n    const N: u32 = 1_000_000;\n\n    let t0 = Instant::now();\n    for _ in 0..N {\n        std::hint::black_box(unsafe { raw_getpid() });\n    }\n    let syscall_ns = t0.elapsed().as_nanos() as f64 / N as f64;\n\n    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };\n    let t1 = Instant::now();\n    for _ in 0..N {\n        let rc = unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };\n        std::hint::black_box((rc, ts.tv_nsec));\n    }\n    let vdso_ns = t1.elapsed().as_nanos() as f64 / N as f64;\n\n    println!(\"getpid:     {syscall_ns:.1} ns/call\");\n    println!(\"clock_gettime: {vdso_ns:.1} ns/call\");\n    println!(\"ratio: {:.1}x\", syscall_ns / vdso_ns);\n}"
      },
      "production": [
        "Measure syscalls per request with strace -c or perf trace before choosing an optimization.",
        "Retry on EINTR and treat EAGAIN as backpressure, never as a fatal error.",
        "Never call last_os_error() after a successful operation; capture errno at the failure site.",
        "Prefer vDSO-served clocks in hot paths and avoid re-reading /proc for time or CPU identity."
      ],
      "crates": [
        "libc",
        "rustix",
        "nix"
      ],
      "pitfall": "Checking errno instead of the return value: a successful syscall may leave errno untouched from a previous failure, so the check reports an error that never happened.",
      "questions": [
        {
          "q": "Which register holds the fourth syscall argument on x86-64 Linux?",
          "options": [
            "rcx",
            "r10",
            "r8",
            "r9"
          ],
          "answer": 1,
          "explain": "The order is rdi, rsi, rdx, r10, r8, r9. rcx is clobbered because the syscall instruction stores the return address there."
        },
        {
          "q": "A syscall returns -13 in rax to the libc wrapper. What does the wrapper do?",
          "options": [
            "Returns -13 and sets errno to 0",
            "Returns -1, sets errno to EACCES, and the caller must check errno",
            "Panics with a permission error",
            "Retries the call once before failing"
          ],
          "answer": 1,
          "explain": "The kernel uses -4095..-1 as -errno. libc converts that into a -1 return plus errno, which is why portable code checks the return value first and errno second."
        },
        {
          "q": "Why is clock_gettime much cheaper than getpid?",
          "options": [
            "getpid takes a global kernel lock that clock_gettime avoids",
            "clock_gettime is served by the vDSO in userspace and never executes syscall",
            "clock_gettime is cached in the process's TLS by libc",
            "getpid must switch page tables twice while clock_gettime does not"
          ],
          "answer": 1,
          "explain": "The vDSO maps timekeeping code and data into the process. Clock reads are ordinary function calls; getpid needs a privilege transition and the entry/exit path."
        }
      ],
      "quickbytes": [
        "x86-64: rax number, rdi rsi rdx r10 r8 r9 args, rax result, rcx and r11 clobbered.",
        "strace -c -f is the fastest way to find syscall-dominated CPU.",
        "EINTR means retry; EAGAIN means wait for readiness; both are control flow, not failure.",
        "std::time::Instant is already on the vDSO path; do not wrap it in a syscall."
      ],
      "github": [
        {
          "name": "libc - raw syscall constants and bindings",
          "url": "https://github.com/rust-lang/libc"
        },
        {
          "name": "rustix - memory-safe syscall wrappers",
          "url": "https://github.com/bytecodealliance/rustix"
        }
      ],
      "resources": [
        {
          "title": "syscall(2): the raw calling convention",
          "url": "https://man7.org/linux/man-pages/man2/syscall.2.html",
          "kind": "docs"
        },
        {
          "title": "vdso(7): kernel-provided userspace routines",
          "url": "https://man7.org/linux/man-pages/man7/vdso.7.html",
          "kind": "docs"
        },
        {
          "title": "Adding a new system call (kernel documentation)",
          "url": "https://docs.kernel.org/process/adding-syscalls.html",
          "kind": "docs"
        },
        {
          "title": "rustix - safe POSIX and Linux syscall wrappers",
          "url": "https://github.com/bytecodealliance/rustix",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "os05",
      "n": 5,
      "title": "Interrupts, exceptions, and what reaches userspace",
      "minutes": 80,
      "level": "advanced",
      "goal": "Separate asynchronous interrupts from synchronous exceptions, follow a page fault from the CPU through the kernel, and recognise when the result of that path is a signal.",
      "sections": [
        {
          "h": "Two different entry paths wear the same name",
          "p": [
            "An interrupt arrives from outside the instruction stream: a device raises a line, the local APIC delivers a vector, and the CPU jumps to the handler with interrupts disabled. An exception is caused by the instruction itself - a page fault, a divide by zero, an invalid opcode - and the CPU pushes an error code for some vectors before entering the handler. Both land in the IDT, but only one is reproducible by rerunning the same instruction.",
            "The distinction predicts everything that follows. Interrupt handlers must be short and must not sleep, because they run on whatever task was interrupted and with interrupts off. Exceptions can sleep in some cases (a page fault may wait for IO), which is why the page fault path is allowed to allocate and to block on a filesystem read."
          ],
          "list": [
            "Top half: minimal, no sleeping, acknowledges the device and queues work",
            "Softirq: deferred, can run on return from interrupt or in ksoftirqd",
            "Workqueue: process context, may sleep, may take mutexes",
            "Threaded IRQ: the handler is a kernel thread, so it can sleep"
          ]
        },
        {
          "h": "The page fault is an exception with policy inside it",
          "p": [
            "When a load or store misses, the CPU pushes the faulting address into CR2 and an error code describing the access, then jumps to the fault handler. The handler walks the VMA, decides between anonymous allocation, page-cache fill, COW copy, stack growth, and a genuine fault. Only the last case ends in a signal.",
            "That policy is visible in siginfo. si_code is SEGV_MAPERR when no mapping covers the address and SEGV_ACCERR when a mapping exists but the permission is wrong. A wild pointer usually produces MAPERR; a write through a read-only mapping produces ACCERR; a stack overflow produces MAPERR on the guard page just below the stack. Reading si_addr in a handler is the difference between a useful crash report and a stack trace that points at the faulting instruction with no address."
          ],
          "code": "use std::mem::MaybeUninit;\n\nextern \"C\" fn on_segv(sig: libc::c_int, info: *mut libc::siginfo_t, _ctx: *mut libc::c_void) {\n    unsafe {\n        let addr = (*info).si_addr() as usize;\n        let code = (*info).si_code;\n        let kind = if code == libc::SEGV_MAPERR { \"MAPERR\" } else if code == libc::SEGV_ACCERR { \"ACCERR\" } else { \"other\" };\n        let msg = format!(\"SIGSEGV({sig}) {kind} at {addr:#018x}\\n\");\n        libc::write(2, msg.as_ptr().cast(), msg.len());\n        libc::_exit(128 + sig); // never return into the faulting instruction\n    }\n}\n\nfn main() {\n    unsafe {\n        let mut sa: libc::sigaction = MaybeUninit::zeroed().assume_init();\n        sa.sa_sigaction = on_segv as usize;\n        sa.sa_flags = libc::SA_SIGINFO | libc::SA_RESETHAND;\n        libc::sigemptyset(&mut sa.sa_mask);\n        assert_eq!(libc::sigaction(libc::SIGSEGV, &sa, std::ptr::null_mut()), 0);\n\n        let unmapped = 0x10 as *mut u8; // outside the NULL page: SEGV_MAPERR\n        std::ptr::write_volatile(unmapped, 1);\n    }\n}",
          "tip": "A stack overflow faults on the guard page while the handler's own stack is exhausted; install a sigaltstack with SA_ONSTACK or the handler never runs."
        },
        {
          "h": "Bottom halves exist because handlers cannot do the work",
          "p": [
            "A network interrupt must copy the packet out of the ring and acknowledge the device quickly; protocol processing, socket wakeups and TCP retransmit timers happen later. That split is what softirqs and NAPI do. When load is high, ksoftirqd becomes visible in top as a kernel thread burning CPU, which is the signature of deferred work being starved by the interrupt rate.",
            "For driver authors the rule is blunt: if it can sleep, it cannot be in the top half. Allocating with GFP_KERNEL, taking a mutex, or copying to userspace all sleep. Threaded IRQs were added so drivers could keep their handler in one function and still have it run in process context; the interrupt still arrives in hard IRQ context, but the handler body runs as a schedulable thread."
          ]
        },
        {
          "h": "Signals are the userspace projection of kernel events",
          "p": [
            "SIGSEGV, SIGBUS, SIGFPE and SIGILL are synchronous: they are generated by the thread that executed the instruction and are delivered before the instruction can be retried. SIGCHLD, SIGTERM and SIGIO are asynchronous and may be delivered to any thread that does not block them. The same signal number can arrive for different reasons, so a handler that only prints the number throws away the useful part.",
            "Async-signal safety restricts what a handler can call: no malloc, no stdio, no Rust code that allocates or panics. The safe pattern is to write into a preallocated buffer or an eventfd/pipe and let the main loop do the work. Rust handlers are extern C functions; a panic unwinding through them is undefined behaviour, so the handler should only touch atomics, raw fds and libc calls."
          ]
        }
      ],
      "exercise": {
        "prompt": "Extend the SIGSEGV handler to distinguish SEGV_MAPERR from SEGV_ACCERR. Trigger both: one write to an unmapped address, and one write to a page that is mapped but mprotected PROT_READ. Print si_addr and si_code for each and confirm the kernel reports different codes.",
        "starter": "use std::mem::MaybeUninit;\n\nextern \"C\" fn on_segv(sig: libc::c_int, info: *mut libc::siginfo_t, _ctx: *mut libc::c_void) {\n    // print si_addr and si_code, then _exit(128 + sig)\n}\n\nfn main() {\n    // install with SA_SIGINFO\n    // case 1: write to 0x10\n    // case 2 (separate run): mmap RW, mprotect PROT_READ, write\n}",
        "hint": "You cannot recover from the fault and continue in the same process; run each case in its own invocation and pass the case as argv[1]. Both end in _exit, so a shell loop can compare the two outputs.",
        "solution": "use std::mem::MaybeUninit;\n\nextern \"C\" fn on_segv(sig: libc::c_int, info: *mut libc::siginfo_t, _ctx: *mut libc::c_void) {\n    unsafe {\n        let addr = (*info).si_addr() as usize;\n        let code = (*info).si_code;\n        let msg = format!(\"SIGSEGV code={code} addr={addr:#x}\\n\");\n        libc::write(2, msg.as_ptr().cast(), msg.len());\n        libc::_exit(128 + sig);\n    }\n}\n\nfn install() {\n    unsafe {\n        let mut sa: libc::sigaction = MaybeUninit::zeroed().assume_init();\n        sa.sa_sigaction = on_segv as usize;\n        sa.sa_flags = libc::SA_SIGINFO | libc::SA_RESETHAND;\n        libc::sigemptyset(&mut sa.sa_mask);\n        libc::sigaction(libc::SIGSEGV, &sa, std::ptr::null_mut());\n    }\n}\n\nfn main() {\n    let which = std::env::args().nth(1).unwrap_or_default();\n    install();\n    if which == \"acc\" {\n        let p = unsafe {\n            libc::mmap(std::ptr::null_mut(), 4096, libc::PROT_READ,\n                libc::MAP_PRIVATE | libc::MAP_ANONYMOUS, -1, 0)\n        };\n        assert_ne!(p, libc::MAP_FAILED);\n        println!(\"expect ACCERR at {p:p}\");\n        unsafe { std::ptr::write_volatile(p as *mut u8, 7) };\n    } else {\n        println!(\"expect MAPERR at 0x10\");\n        unsafe { std::ptr::write_volatile(0x10 as *mut u8, 7) };\n    }\n}"
      },
      "production": [
        "Log si_addr, si_code and the faulting thread id from crash handlers; SIGSEGV alone is not a diagnosis.",
        "Install a sigaltstack with SA_ONSTACK for stack-overflow detection.",
        "Keep signal handlers to atomics, raw fd writes and _exit; never allocate or unwind.",
        "Watch ksoftirqd and per-vector /proc/interrupts deltas when throughput collapses under load."
      ],
      "crates": [
        "libc",
        "nix",
        "signal-hook"
      ],
      "pitfall": "A SIGSEGV handler installed without SA_ONSTACK on the overflowing stack: the kernel tries to deliver the signal, cannot push a frame, and the process dies with no handler output at all.",
      "questions": [
        {
          "q": "A store faults because the page is mapped read-only. Which si_code do you expect?",
          "options": [
            "SEGV_MAPERR",
            "SEGV_ACCERR",
            "BUS_ADRERR",
            "SI_KERNEL"
          ],
          "answer": 1,
          "explain": "ACCERR means a mapping covers the address but the access violates its permissions. MAPERR means nothing is mapped there at all."
        },
        {
          "q": "Why must a hard IRQ handler avoid GFP_KERNEL allocations?",
          "options": [
            "GFP_KERNEL memory is not DMA-able from interrupt context",
            "GFP_KERNEL may sleep, and sleeping in interrupt context is illegal",
            "GFP_KERNEL disables interrupts for too long",
            "GFP_KERNEL is only available to workqueues at boot"
          ],
          "answer": 1,
          "explain": "The allocator may reclaim and block, which requires a schedulable context. Interrupt context has no task to sleep and cannot be rescheduled."
        },
        {
          "q": "Which of these is legal inside a signal handler?",
          "options": [
            "format! and println! to describe the signal",
            "Mutex::lock on a global logger",
            "write(2) to a pre-opened file descriptor, then _exit",
            "Dropping a Box to free the buffer the handler used"
          ],
          "answer": 2,
          "explain": "write and _exit are async-signal-safe. Allocation, stdio, mutexes and most Rust runtime facilities are not: they can deadlock if the signal interrupted the same lock."
        }
      ],
      "quickbytes": [
        "Interrupts are asynchronous; exceptions are caused by the instruction and are reproducible.",
        "CR2 holds the faulting address; siginfo holds si_addr and si_code.",
        "If a handler can sleep, it belongs in a workqueue or a threaded IRQ.",
        "SIGSEGV from a stack overflow needs sigaltstack to be observable at all."
      ],
      "github": [
        {
          "name": "Linux kernel interrupt and entry code",
          "url": "https://github.com/torvalds/linux"
        },
        {
          "name": "signal-hook - safe signal handling for Rust",
          "url": "https://github.com/vorner/signal-hook"
        }
      ],
      "resources": [
        {
          "title": "RedLeaf: isolation and communication in a safe OS (OSDI 2020)",
          "url": "https://www.usenix.org/conference/osdi20/presentation/narayanan-vikram",
          "kind": "paper"
        },
        {
          "title": "USENIX Association talks (OSDI/ATC recordings)",
          "url": "https://www.youtube.com/user/USENIXAssociation",
          "kind": "video"
        },
        {
          "title": "signal(7): dispositions, synchronous vs asynchronous",
          "url": "https://man7.org/linux/man-pages/man7/signal.7.html",
          "kind": "docs"
        },
        {
          "title": "Generic IRQ handling (kernel documentation)",
          "url": "https://docs.kernel.org/core-api/genericirq.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "os06",
      "n": 6,
      "title": "Filesystems and VFS: inodes, dentries and mounts",
      "minutes": 80,
      "level": "core",
      "goal": "Walk a path the way the kernel does, distinguish names from objects, and know which filesystem operations are atomic, durable, or neither.",
      "sections": [
        {
          "h": "Four objects and one namespace",
          "p": [
            "The VFS models every filesystem with four structures. A superblock represents one mounted filesystem instance; an inode represents one object (file, directory, device, socket) with its metadata and operations; a dentry represents one name in one directory, cached in RAM and never written to disk; a file represents one open file description, holding the offset and flags. open(2) resolves a path to a dentry, creates a file object, and installs it in the descriptor table.",
            "Path resolution starts at the root or the cwd, walks one component at a time through the dentry cache, and calls the filesystem's lookup method only on a miss. Symlinks are followed with a depth limit of 40, mount points are crossed transparently, and .. is resolved relative to the current dentry - which is exactly why a process can escape a chroot by holding a descriptor to a directory outside it."
          ],
          "list": [
            "dentry: name to inode, cached, reclaimable, never on disk",
            "inode: the object and its metadata, one per hard link target",
            "file: the open description, shared by dup and fork",
            "superblock: one mounted filesystem, shared by all its mounts"
          ]
        },
        {
          "h": "Names are links; inodes are the objects",
          "p": [
            "A directory entry maps a name to an inode number. Creating a hard link adds another name for the same inode and increments nlink; deleting a name decrements it, and the inode is freed only when nlink reaches zero and no process holds it open. That is why a deleted-but-open file still consumes space and appears in lsof with the text (deleted). A symlink is a different inode whose content is a path, resolved at use time.",
            "Two consequences matter in production. rename(2) within one filesystem is atomic: the target either has the old contents or the new, never a mixture - which is why write-temp-then-rename is the only safe way to update a config file. Across filesystems, rename fails with EXDEV and must be emulated with copy and unlink, which is not atomic at all."
          ],
          "code": "use std::fs;\nuse std::os::unix::fs::MetadataExt;\n\nfn main() -> std::io::Result<()> {\n    let dir = std::env::temp_dir().join(\"vfs-demo\");\n    let _ = fs::remove_dir_all(&dir);\n    fs::create_dir_all(&dir)?;\n\n    let a = dir.join(\"a.txt\");\n    fs::write(&a, b\"hello\")?;\n    let b = dir.join(\"b.txt\");\n    fs::hard_link(&a, &b)?;      // second name, same inode\n    let c = dir.join(\"c.txt\");\n    fs::copy(&a, &c)?;           // new inode, new data\n\n    let (ma, mb, mc) = (fs::metadata(&a)?, fs::metadata(&b)?, fs::metadata(&c)?);\n    println!(\"a ino={} nlink={}\", ma.ino(), ma.nlink());\n    println!(\"b ino={} nlink={}\", mb.ino(), mb.nlink());\n    println!(\"c ino={} nlink={}\", mc.ino(), mc.nlink());\n    println!(\"a and b are one object: {}\", ma.ino() == mb.ino() && ma.dev() == mb.dev());\n    Ok(())\n}"
        },
        {
          "h": "Mounts form a tree of filesystem instances",
          "p": [
            "Each mount attaches a superblock at a dentry, and the mount namespace decides which tree a process sees. The same superblock can be mounted many times (bind mounts, overlayfs lower layers), and unmounting one mount does not free the superblock until the last reference goes. /proc/self/mountinfo is the authoritative list: mount id, parent id, major:minor, root, mount point and options.",
            "overlayfs is the composition primitive containers rely on. It stacks read-only lower layers and one writable upper layer, with a work directory for atomic copy-up. Reading a file present only in a lower layer serves it from the lower filesystem; writing it first copies the whole file up. That is why a container writing one byte to a 2 GiB base-image file pays for 2 GiB of copy-up and why the upper layer is usually a writable volume, not the image."
          ],
          "tip": "Mount with MS_NOSUID, MS_NODEV and MS_NOEXEC for container root filesystems; a writable layer that honours setuid is a privilege escalation waiting for a bug."
        },
        {
          "h": "Durability is a separate operation from writing",
          "p": [
            "write(2) returns when the data is in the page cache, not on media. fsync flushes the file's data and metadata, fdatasync skips metadata that is not needed to read the data back, and syncfs flushes the whole filesystem. Creating a file requires a second durability step: fsync the parent directory, or a crash can leave the entry invisible even though the file's contents were written.",
            "Filesystems also reorder. ext4 in its default data=ordered mode does not guarantee that a newly created file's data is on disk before its directory entry, unless you fsync in the right order. The portable recipe for atomic replace is: write to a temporary file in the same directory, fsync it, rename over the target, then fsync the directory. Anything less is a crash-consistency bug that will be discovered by the one power failure you did not plan for."
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a probe that creates a file, a hard link to it, and a copy, then prints inode number, device and link count for all three. Use the output to prove which pairs share an inode and what happens to nlink when one name is removed.",
        "starter": "use std::fs;\nuse std::os::unix::fs::MetadataExt;\n\nfn main() -> std::io::Result<()> {\n    let dir = std::env::temp_dir().join(\"vfs-ex\");\n    // 1. create dir and a.txt\n    // 2. hard_link to b.txt, fs::copy to c.txt\n    // 3. print ino, dev, nlink for each\n    // 4. remove a.txt and print nlink of b.txt\n    Ok(())\n}",
        "hint": "fs::copy creates a new inode; fs::hard_link shares the existing one. After removing one of two names, nlink drops to 1 and the inode survives because a name still refers to it.",
        "solution": "use std::fs;\nuse std::os::unix::fs::MetadataExt;\n\nfn main() -> std::io::Result<()> {\n    let dir = std::env::temp_dir().join(\"vfs-ex\");\n    let _ = fs::remove_dir_all(&dir);\n    fs::create_dir_all(&dir)?;\n\n    let a = dir.join(\"a.txt\");\n    let b = dir.join(\"b.txt\");\n    let c = dir.join(\"c.txt\");\n    fs::write(&a, b\"hello\")?;\n    fs::hard_link(&a, &b)?;\n    fs::copy(&a, &c)?;\n\n    for p in [&a, &b, &c] {\n        let m = fs::metadata(p)?;\n        println!(\"{:?}: dev={} ino={} nlink={}\", p.file_name().unwrap(), m.dev(), m.ino(), m.nlink());\n    }\n\n    fs::remove_file(&a)?;\n    let mb = fs::metadata(&b)?;\n    println!(\"after removing a: b ino={} nlink={}\", mb.ino(), mb.nlink());\n    assert_eq!(mb.nlink(), 1);\n    assert!(c.exists() && b.exists());\n    Ok(())\n}"
      },
      "production": [
        "Replace config and data files with write-temp, fsync, rename, fsync-directory; never truncate in place.",
        "Alert on inodes used and on deleted-but-open files (lsof +L1) before the disk fills invisibly.",
        "Mount container root filesystems with nosuid, nodev and noexec, and keep the writable layer off the image.",
        "Pin the expected filesystem type and mount options in deployment checks; overlayfs and network filesystems change the durability rules."
      ],
      "crates": [
        "rustix",
        "nix",
        "libc"
      ],
      "pitfall": "fsync on the file but not its directory: after a crash the data may be durable while the name is missing, producing an empty directory that looks like an application bug.",
      "questions": [
        {
          "q": "What is stored on disk: dentry, inode, or both?",
          "options": [
            "Both: the dentry cache is a disk-backed index",
            "The inode and directory entries; dentries are an in-memory cache only",
            "Only dentries; inodes are reconstructed at mount time",
            "Neither: the VFS rebuilds both from the journal on every open"
          ],
          "answer": 1,
          "explain": "Directory entries are stored by the filesystem as name-to-inode mappings, but the dentry object itself is an in-memory cache that is reclaimed under memory pressure."
        },
        {
          "q": "Why does rename(2) fail with EXDEV across two mount points?",
          "options": [
            "The kernel refuses to overwrite an existing target on another filesystem",
            "Atomic rename is implemented inside one filesystem's namespace, so the VFS cannot do it across superblocks",
            "The destination filesystem may be read-only",
            "The source file is open in another process"
          ],
          "answer": 1,
          "explain": "Each filesystem implements rename over its own directory entries. Crossing superblocks would require copy and unlink, which is not atomic, so the kernel returns EXDEV."
        },
        {
          "q": "A file is unlinked while a process still has it open. What happens to the space?",
          "options": [
            "It is freed immediately because the name is gone",
            "It stays allocated until the last open file description is closed",
            "It is moved to lost+found",
            "It is freed at the next fsync"
          ],
          "answer": 1,
          "explain": "The inode is freed when nlink hits zero and the last reference drops. That is why restarting a process that holds a deleted log file suddenly frees gigabytes."
        }
      ],
      "quickbytes": [
        "Compare dev and ino together; inode numbers repeat across filesystems.",
        "rename within one filesystem is the only atomic replace primitive you get.",
        "fsync the file, rename, then fsync the directory to make the name durable.",
        "overlayfs copy-up copies the whole file on first write, not the changed block."
      ],
      "github": [
        {
          "name": "Linux kernel VFS sources",
          "url": "https://github.com/torvalds/linux"
        },
        {
          "name": "rustix - filesystem syscall wrappers",
          "url": "https://github.com/bytecodealliance/rustix"
        }
      ],
      "resources": [
        {
          "title": "Overview of the Linux virtual file system",
          "url": "https://docs.kernel.org/filesystems/vfs.html",
          "kind": "docs"
        },
        {
          "title": "path_resolution(7): how a pathname becomes an inode",
          "url": "https://man7.org/linux/man-pages/man7/path_resolution.7.html",
          "kind": "docs"
        },
        {
          "title": "Overlayfs (kernel documentation)",
          "url": "https://docs.kernel.org/filesystems/overlayfs.html",
          "kind": "docs"
        },
        {
          "title": "Linux kernel source: fs/namei.c",
          "url": "https://github.com/torvalds/linux",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "os07",
      "n": 7,
      "title": "Block devices and IO scheduling: from bio to blk-mq",
      "minutes": 80,
      "level": "advanced",
      "goal": "Follow a write from the page cache to a request on a hardware queue, choose a scheduler that matches the device, and read the counters that actually predict latency.",
      "sections": [
        {
          "h": "The path a write takes",
          "p": [
            "A buffered write dirties a page in the page cache and returns. Writeback later builds a bio - a description of one or more contiguous page ranges - and submits it to the block layer. The block layer merges adjacent bios into a request, the IO scheduler may reorder or delay it, and blk-mq places it on a software queue that maps to a hardware submission queue. The device consumes it and completes with an interrupt, which is where the latency is finally known.",
            "blk-mq exists because NVMe exposes thousands of queues and millions of outstanding commands. Each CPU has software queues that feed shared hardware queues, which removes the single-queue lock that older drivers needed. The scheduler's job changes with that: on a device with deep parallelism, reordering requests buys little and costs CPU, which is why none is often correct on NVMe while mq-deadline still helps on a single-queue SATA disk."
          ],
          "list": [
            "none: no reordering, lowest CPU cost, right for NVMe and virtio with deep queues",
            "mq-deadline: read priority with a write expiry, good for SATA and mixed workloads",
            "kyber: two latency targets, simple and predictable",
            "bfq: per-process fairness and low latency on slow or shared devices, highest CPU cost"
          ]
        },
        {
          "h": "Scheduler choice is a device property",
          "p": [
            "Read /sys/block/<dev>/queue/scheduler: square brackets mark the active one and the list shows what the driver registered. Writing a name switches it. Also read rotational, nr_requests and max_sectors_kb; a queue that is too shallow throttles concurrency, and a scheduler that serialises on a device that wants depth wastes the hardware.",
            "The classic mistake is tuning for the benchmark instead of the device. A container image on NVMe with the default mq-deadline can lose 20-30 percent throughput to lock contention at high queue depth; the same setting is essential on a SATA disk where seeking dominates. If the storage is network-backed, the scheduler is often irrelevant compared to the queue depth and the filesystem's writeback behaviour."
          ],
          "code": "use std::fs;\nuse std::path::Path;\n\nfn main() -> std::io::Result<()> {\n    for entry in fs::read_dir(\"/sys/block\")? {\n        let entry = entry?;\n        let q = entry.path().join(\"queue\");\n        let read = |name: &str| {\n            fs::read_to_string(q.join(name)).map(|s| s.trim().to_string()).unwrap_or_default()\n        };\n        println!(\n            \"{:8} rotational={} nr_requests={} scheduler={}\",\n            entry.file_name().to_string_lossy(),\n            read(\"rotational\"), read(\"nr_requests\"), read(\"scheduler\")\n        );\n    }\n\n    // Per-device counters: reads, writes, sectors, ms spent, weighted ms.\n    if let Ok(stat) = fs::read_to_string(\"/sys/block/nvme0n1/stat\") {\n        println!(\"nvme0n1 stat: {}\", stat.trim());\n    }\n    Ok(()\n}",
          "tip": "Write through sysfs is per device and does not survive reboot; set it in udev rules or the initramfs, or you will tune a machine that forgets."
        },
        {
          "h": "Priorities, throttling and fairness",
          "p": [
            "ioprio_set assigns a class (realtime, best-effort, idle) and a level (0-7) to a thread or process. The block layer honours it for the device it reaches, and the cgroup io controller can enforce absolute bandwidth and IOPS ceilings with io.max. These are separate levers: ioprio orders requests within a device, io.max caps a group's aggregate traffic and throttles it when exceeded.",
            "Writeback is a third, hidden scheduler. Dirty pages accumulate until the dirty ratio is crossed, then flusher threads submit them; a burst of buffered writes can therefore produce a stall minutes later, far from the code that caused it. /proc/meminfo Dirty and Writeback, plus cgroup memory.stat's file_dirty and file_writeback, tell you whether the stall is yours or the flusher's."
          ]
        },
        {
          "h": "Read the counters correctly",
          "p": [
            "/sys/block/<dev>/stat has eleven fields; the ones that matter are read/write IOPS, sectors, and the four time fields in milliseconds. Field 9 is time spent doing IO, field 10 is the weighted time that accounts for queue depth, and field 11 is the number of in-flight requests. A high field 9 with low field 10 means a deep queue hiding latency; low field 9 with high latency means the queue is not being used at all.",
            "iostat -x derives await and util from the same counters. util near 100 percent on NVMe does not mean saturated - the device can service many requests in parallel, and util measures busy time, not capacity. The honest capacity signal is a latency percentile at a known queue depth, measured from the application, because that is the number the client experiences."
          ]
        }
      ],
      "exercise": {
        "prompt": "Enumerate block devices, print each queue's scheduler and rotational flag, then attempt to switch the first non-rotational device to none. Handle EACCES without panicking and print the active scheduler afterwards to prove the change.",
        "starter": "use std::fs;\n\nfn main() -> std::io::Result<()> {\n    // iterate /sys/block/*/queue/{scheduler,rotational}\n    // find a device with rotational=0\n    // write \"none\" to its scheduler file, tolerate permission errors\n    // re-read and print the active scheduler\n    Ok(())\n}",
        "hint": "The scheduler file lists candidates in brackets, e.g. [none] mq-deadline kyber bfq. Writing requires root; on a container you will get EACCES or EROFS. Print the error and continue rather than unwrapping.",
        "solution": "use std::fs;\nuse std::io::Write;\n\nfn read_trim(path: &std::path::Path) -> String {\n    fs::read_to_string(path).map(|s| s.trim().to_string()).unwrap_or_default()\n}\n\nfn main() -> std::io::Result<()> {\n    let mut target = None;\n    for entry in fs::read_dir(\"/sys/block\")? {\n        let entry = entry?;\n        let q = entry.path().join(\"queue\");\n        let rotational = read_trim(&q.join(\"rotational\"));\n        let scheduler = read_trim(&q.join(\"scheduler\"));\n        println!(\"{:8} rotational={rotational} scheduler={scheduler}\", entry.file_name().to_string_lossy());\n        if rotational == \"0\" && target.is_none() {\n            target = Some(entry.path());\n        }\n    }\n\n    let Some(dev) = target else { println!(\"no non-rotational device\"); return Ok(()); };\n    let sched = dev.join(\"queue/scheduler\");\n    match fs::OpenOptions::new().write(true).open(&sched) {\n        Ok(mut f) => {\n            f.write_all(b\"none\")?;\n            println!(\"switched {:?} to: {}\", dev.file_name().unwrap(), read_trim(&sched));\n        }\n        Err(e) => println!(\"cannot switch scheduler ({e}); active is {}\", read_trim(&sched)),\n    }\n    Ok(())\n}"
      },
      "production": [
        "Record the active scheduler and queue depth per device in the host baseline; compare after kernel or driver upgrades.",
        "Use io.max for tenant bandwidth ceilings and ioprio for relative priority; do not confuse the two.",
        "Alert on rising writeback and Dirty bytes, not only on device latency, to catch flusher-induced stalls.",
        "Never size storage performance from %util on NVMe; benchmark at the queue depth the application actually uses."
      ],
      "crates": [
        "libc",
        "rustix",
        "nix"
      ],
      "pitfall": "Setting the IO scheduler by echoing to sysfs on a running host: the change applies to that device only, is lost on reboot, and silently differs across nodes unless it is pinned in udev or the boot image.",
      "questions": [
        {
          "q": "Why is the none scheduler usually right for NVMe?",
          "options": [
            "NVMe devices cannot reorder commands",
            "The device has deep parallel queues, so kernel reordering adds CPU cost without reducing seek time",
            "none disables the page cache and removes writeback stalls",
            "NVMe firmware implements mq-deadline internally"
          ],
          "answer": 1,
          "explain": "Reordering helps when there is one queue and a seek penalty. NVMe has many queues and no seeks, so the scheduler mostly adds overhead."
        },
        {
          "q": "A buffered write returns immediately. Where is the data?",
          "options": [
            "On stable storage, because writeback is synchronous",
            "In the page cache, dirty, waiting for writeback",
            "In the block layer request queue, already scheduled",
            "In the device's write cache, acknowledged via DMA"
          ],
          "answer": 1,
          "explain": "write(2) on a buffered file copies into the page cache and marks the page dirty. Nothing reaches the block layer until writeback or fsync."
        },
        {
          "q": "Which pair correctly separates ordering from capping?",
          "options": [
            "io.max orders requests, ioprio caps bandwidth",
            "ioprio orders requests within a device, io.max caps a group's aggregate traffic",
            "Both are enforced by the IO scheduler and are equivalent",
            "ioprio is per-cgroup, io.max is per-thread"
          ],
          "answer": 1,
          "explain": "ioprio is a per-thread hint consumed by the scheduler or device. io.max is a cgroup v2 controller limit enforced with throttling."
        }
      ],
      "quickbytes": [
        "Buffered write means page cache; fsync is what forces the block layer to act.",
        "Check /sys/block/*/queue/scheduler and rotational before tuning anything.",
        "Field 10 of /sys/block/*/stat is queue-depth-weighted time; field 9 is not.",
        "Dirty pages stall later: watch /proc/meminfo Dirty and Writeback."
      ],
      "github": [
        {
          "name": "Linux kernel block layer sources",
          "url": "https://github.com/torvalds/linux"
        },
        {
          "name": "fio - flexible IO tester used to benchmark block devices",
          "url": "https://github.com/axboe/fio"
        }
      ],
      "resources": [
        {
          "title": "Block layer documentation index",
          "url": "https://docs.kernel.org/block/index.html",
          "kind": "docs"
        },
        {
          "title": "Multi-queue block IO queueing mechanism (blk-mq)",
          "url": "https://docs.kernel.org/block/blk-mq.html",
          "kind": "docs"
        },
        {
          "title": "Block IO priorities (ioprio)",
          "url": "https://docs.kernel.org/block/ioprio.html",
          "kind": "docs"
        },
        {
          "title": "Linux kernel source: block/ and drivers/nvme",
          "url": "https://github.com/torvalds/linux",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "os08",
      "n": 8,
      "title": "Memory mapping and the page cache contract",
      "minutes": 75,
      "level": "advanced",
      "goal": "Use mmap correctly for file IO: understand what MAP_SHARED changes, when msync is required, and which failures arrive as SIGBUS instead of errno.",
      "sections": [
        {
          "h": "The page cache is the file, in memory",
          "p": [
            "Every buffered read and write goes through the page cache, an address_space of folios indexed by file offset. A read copies from the cached folio to your buffer; a write copies into it and marks it dirty. mmap skips the copy: the fault handler installs the cached folio's page directly into your page tables, so a load from the mapping reads the same physical memory the page cache holds.",
            "That identity is the point and the hazard. MAP_SHARED means stores change the page cache and are visible to every process mapping the file, and are eventually written back. MAP_PRIVATE means the first store triggers a COW copy, so your change is invisible to everyone else and is lost unless you write it somewhere. There is no third mode where writes are shared but not persisted; that is what fsync is for."
          ],
          "list": [
            "MAP_SHARED: shared with the page cache, persisted on writeback",
            "MAP_PRIVATE: COW, never persisted, invisible to other mappers",
            "MAP_POPULATE: prefault the range at mmap time, trading startup latency for fewer later faults",
            "MAP_LOCKED / mlock: pin pages so they cannot be reclaimed or swapped"
          ]
        },
        {
          "h": "msync, fsync and what a crash can lose",
          "p": [
            "msync(MS_SYNC) flushes dirty pages in the mapping and waits; msync(MS_ASYNC) schedules writeback and returns. Neither guarantees the file's metadata or a durable directory entry. fsync on a file descriptor covering the same file is equivalent for data but also flushes metadata. If you need the mapping's data on stable storage, msync then fsync, and fsync the directory if the file was created.",
            "The failure mode people miss: mmap writes are visible to other processes immediately, before any durability. A second process can read data that will vanish on power loss, so a consumer cannot infer durability from visibility. Systems that require a crash-consistent handoff between processes need an explicit fsync before publishing the offset or the name."
          ],
          "code": "use std::fs::OpenOptions;\nuse std::os::fd::AsRawFd;\nuse std::os::unix::fs::OpenOptionsExt;\n\nfn main() -> std::io::Result<()> {\n    let path = std::env::temp_dir().join(\"pagecache-demo.bin\");\n    let f = OpenOptions::new().read(true).write(true).create(true).truncate(true)\n        .mode(0o644).open(&path)?;\n    f.set_len(4096)?;\n\n    let p = unsafe {\n        libc::mmap(std::ptr::null_mut(), 4096,\n            libc::PROT_READ | libc::PROT_WRITE, libc::MAP_SHARED, f.as_raw_fd(), 0)\n    };\n    assert_ne!(p, libc::MAP_FAILED, \"mmap: {}\", std::io::Error::last_os_error());\n\n    let msg = b\"written through the page cache\";\n    unsafe {\n        std::ptr::copy_nonoverlapping(msg.as_ptr(), p as *mut u8, msg.len());\n        let rc = libc::msync(p, 4096, libc::MS_SYNC);\n        assert_eq!(rc, 0, \"msync: {}\", std::io::Error::last_os_error());\n        libc::munmap(p, 4096);\n    }\n    f.sync_all()?;\n\n    let bytes = std::fs::read(&path)?;\n    println!(\"first {} bytes: {:?}\", msg.len(), String::from_utf8_lossy(&bytes[..msg.len()]));\n    Ok(())\n}"
        },
        {
          "h": "SIGBUS is the price of mapping a mutable file",
          "p": [
            "A mapping is a promise about a file's size and blocks. If another process truncates the file, or the filesystem cannot allocate a block where one was promised, the fault handler cannot return an error to your load instruction - there is no errno channel for a memory access. The kernel delivers SIGBUS instead, with si_code BUS_ADRERR, and the process dies unless it handles it.",
            "This is why databases with their own buffer pools often avoid mmap for the data file and use pread/pwrite: an IO error becomes an errno they can retry, log, or fail over, instead of a signal. mmap remains excellent for read-only index files and immutable artifacts, where the file cannot change underneath the mapping and the fault path is the fastest way to touch bytes."
          ],
          "tip": "If you mmap a file that can be truncated, keep the file descriptor open and take a shared lock or a lease; a mapping does not pin the file's size."
        },
        {
          "h": "When mmap loses to read(2)",
          "p": [
            "mmap wins for large, page-aligned, repeatedly accessed ranges: it removes a copy and lets the kernel share one cached copy across processes. It loses for small random reads (a fault costs more than a 200-byte pread), for files on network filesystems with weak mmap coherence, and for write paths that need error reporting per operation.",
            "It also loses when the access pattern defeats readahead. The kernel's readahead window is built from sequential fault patterns; a random mmap walk gets one fault per page and no prefetch, while an explicit madvise(MADV_RANDOM) tells the kernel to stop trying. Measure with minor and major fault counters before choosing; a mmap rewrite that trades a copy for twice the faults is a regression with extra complexity."
          ]
        }
      ],
      "exercise": {
        "prompt": "Map a 4 KiB file MAP_SHARED, write a known string through the mapping, msync it, unmap, and verify the bytes with an independent read. Then repeat with MAP_PRIVATE and prove that the file is unchanged.",
        "starter": "use std::fs::OpenOptions;\nuse std::os::fd::AsRawFd;\n\nfn main() -> std::io::Result<()> {\n    // 1. create and size a temp file to 4096 bytes\n    // 2. mmap it MAP_SHARED, write a string, msync(MS_SYNC), munmap\n    // 3. read the file back and assert the string is there\n    // 4. repeat with MAP_PRIVATE and assert the file did NOT change\n    Ok(())\n}",
        "hint": "For MAP_PRIVATE you do not need msync: the stores never reach the page cache. Assert on the file contents, not on the mapping, because the mapping always shows your private copy.",
        "solution": "use std::fs::{self, OpenOptions};\nuse std::os::fd::AsRawFd;\n\nfn write_map(path: &std::path::Path, flags: libc::c_int) -> std::io::Result<()> {\n    let f = OpenOptions::new().read(true).write(true).open(path)?;\n    f.set_len(4096)?;\n    let p = unsafe {\n        libc::mmap(std::ptr::null_mut(), 4096,\n            libc::PROT_READ | libc::PROT_WRITE, flags, f.as_raw_fd(), 0)\n    };\n    assert_ne!(p, libc::MAP_FAILED, \"mmap: {}\", std::io::Error::last_os_error());\n    unsafe {\n        std::ptr::copy_nonoverlapping(b\"shared-visible\".as_ptr(), p as *mut u8, 14);\n        if flags == libc::MAP_SHARED {\n            assert_eq!(libc::msync(p, 4096, libc::MS_SYNC), 0);\n        }\n        libc::munmap(p, 4096);\n    }\n    Ok(())\n}\n\nfn main() -> std::io::Result<()> {\n    let path = std::env::temp_dir().join(\"mmap-ex.bin\");\n    fs::write(&path, vec![0u8; 4096])?;\n\n    write_map(&path, libc::MAP_SHARED)?;\n    let shared = fs::read(&path)?;\n    assert_eq!(&shared[..14], b\"shared-visible\");\n    println!(\"MAP_SHARED persisted: {:?}\", String::from_utf8_lossy(&shared[..14]));\n\n    write_map(&path, libc::MAP_PRIVATE)?;\n    let private = fs::read(&path)?;\n    assert_eq!(&private[..14], b\"shared-visible\", \"private writes must not reach the file\");\n    println!(\"MAP_PRIVATE left the file unchanged\");\n    Ok(())\n}"
      },
      "production": [
        "Decide MAP_SHARED vs MAP_PRIVATE explicitly; the default in a code review should never be accidental.",
        "fsync before announcing an offset or a file name to another process; visibility is not durability.",
        "Do not mmap files that may be truncated unless SIGBUS is handled and the handler can fail the work.",
        "Check minor/major fault counts when replacing read(2) with mmap; a copy saved is not automatically a win."
      ],
      "crates": [
        "libc",
        "memmap2",
        "rustix"
      ],
      "pitfall": "Truncating a file while another process has it mapped: the next access past the new end of file raises SIGBUS, and there is no errno to retry, so the process dies at a load instruction.",
      "questions": [
        {
          "q": "A process writes through a MAP_PRIVATE mapping. When do other processes see the change?",
          "options": [
            "Immediately, because the page cache is shared",
            "After msync(MS_SYNC)",
            "Never: the store triggers a COW copy private to the process",
            "After the mapping is unmapped and the file is reopened"
          ],
          "answer": 2,
          "explain": "MAP_PRIVATE makes the first write fault into a private copy. The page cache is untouched, so no other process and no future reader can see it."
        },
        {
          "q": "What does msync(MS_SYNC) guarantee?",
          "options": [
            "The file's directory entry is durable",
            "Dirty pages in the given range are written back and the call waits",
            "The mapping is locked into RAM until munmap",
            "Subsequent reads bypass the page cache"
          ],
          "answer": 1,
          "explain": "msync flushes and waits for the range. Directory entry durability needs fsync on the parent directory, and mlock is what pins pages."
        },
        {
          "q": "Why can a truncated file turn an mmap read into SIGBUS but not a pread failure?",
          "options": [
            "mmap mappings are read-only after truncation",
            "A load instruction has no errno channel, so the fault handler must signal the process",
            "Truncation invalidates the page tables and the CPU raises an alignment fault",
            "The page cache refuses to serve pages past EOF and returns EIO to the load"
          ],
          "answer": 1,
          "explain": "Memory accesses report faults, not error codes. Beyond the new EOF there is no valid backing block, so the kernel delivers SIGBUS with BUS_ADRERR."
        }
      ],
      "quickbytes": [
        "MAP_SHARED writes the page cache; MAP_PRIVATE copies on first write.",
        "msync flushes bytes; fsync also flushes metadata; the directory needs its own fsync.",
        "Visible to another process does not mean durable.",
        "SIGBUS with BUS_ADRERR on a mapping usually means the file shrank underneath you."
      ],
      "github": [
        {
          "name": "memmap2 - safe mmap wrappers for Rust",
          "url": "https://github.com/RazrFalcon/memmap2-rs"
        },
        {
          "name": "Linux kernel page cache and writeback",
          "url": "https://github.com/torvalds/linux"
        }
      ],
      "resources": [
        {
          "title": "mmap(2): flags, MAP_SHARED and MAP_PRIVATE semantics",
          "url": "https://man7.org/linux/man-pages/man2/mmap.2.html",
          "kind": "docs"
        },
        {
          "title": "msync(2): flushing a mapping",
          "url": "https://man7.org/linux/man-pages/man2/msync.2.html",
          "kind": "docs"
        },
        {
          "title": "VFS address_space and page cache (kernel documentation)",
          "url": "https://docs.kernel.org/filesystems/vfs.html",
          "kind": "docs"
        },
        {
          "title": "Linux kernel source: mm/filemap.c",
          "url": "https://github.com/torvalds/linux",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "os09",
      "n": 9,
      "title": "Kernel synchronisation: spinlocks, RCU and futexes",
      "minutes": 90,
      "level": "advanced",
      "goal": "Pick the right primitive for the context you are in, and understand the futex protocol well enough to reason about every userspace lock you use.",
      "sections": [
        {
          "h": "The first question is always: can this context sleep?",
          "p": [
            "A spinlock disables preemption on the local CPU and spins until the owner releases. It is correct only when the critical section cannot sleep and is shorter than two context switches; holding one across a page fault or an allocation with GFP_KERNEL is a bug that shows up as a soft lockup. A mutex may sleep, so it can protect work that allocates, copies to userspace or waits for IO, and it cannot be used from interrupt context at all.",
            "Between them sit rwsem (many readers, one writer, sleeping), seqlock (readers retry, writers never block) and RCU (readers never block or lock, writers wait for a grace period). RCU is the reason the kernel can walk a list of network routes on every packet without touching a shared counter: readers use rcu_read_lock, which on a non-preemptible kernel compiles to nothing."
          ],
          "list": [
            "spinlock: short, non-sleeping, interrupt-safe variants disable local IRQs",
            "mutex: sleeping, owner-tracked, may be priority-inheriting",
            "rwsem: reader-writer with sleeping waiters",
            "seqlock: optimistic readers, retry on a version change",
            "RCU: lock-free readers, deferred reclamation after a grace period"
          ]
        },
        {
          "h": "Priority inversion is a scheduling bug, not a lock bug",
          "p": [
            "A low-priority task holds a mutex; a high-priority task blocks on it; a medium-priority task preempts the holder. The high-priority task now waits for the medium one, which is unbounded inversion. Priority inheritance fixes it by temporarily raising the holder to the waiter's priority, and Linux implements it for rt-mutexes and, in userspace, for PI futexes.",
            "Inheritance is not a cure-all. It only works for locks that opted in, chains of waiters propagate only a few levels, and it does nothing for a holder that is spinning or blocked on IO. The real-time lesson is to keep critical sections tiny, avoid allocating under a lock, and never take a blocking lock from a thread that has a deadline."
          ]
        },
        {
          "h": "Futex: one syscall underneath every userspace lock",
          "p": [
            "A futex is a 32-bit word in your address space that the kernel only examines when you ask it to. The fast path is a compare-and-swap in userspace; only contention calls futex(FUTEX_WAIT), which sleeps if and only if the word still holds the expected value. That conditional is the whole trick: the kernel checks the value while holding the bucket lock, so a wakeup racing with the wait cannot be lost.",
            "The classic three-state mutex uses 0 (unlocked), 1 (locked, no waiters) and 2 (locked, waiters). Unlock only calls FUTEX_WAKE when the previous state was 2, so an uncontended lock costs one atomic swap and zero syscalls. Every pthread mutex, Rust's std::sync::Mutex on Linux and every async runtime's parking lot is a variation on this protocol."
          ],
          "code": "use std::sync::atomic::{AtomicU32, Ordering};\n\nstruct FutexMutex { state: AtomicU32 }\n\nimpl FutexMutex {\n    const fn new() -> Self { Self { state: AtomicU32::new(0) } }\n\n    fn lock(&self) {\n        if self.state.compare_exchange(0, 1, Ordering::Acquire, Ordering::Relaxed).is_ok() {\n            return; // fast path: no syscall\n        }\n        while self.state.swap(2, Ordering::Acquire) != 0 {\n            // Sleep only while the word still reads 2; a racing unlock cannot be lost.\n            unsafe {\n                libc::syscall(\n                    libc::SYS_futex,\n                    &self.state as *const AtomicU32 as *const u32,\n                    libc::FUTEX_WAIT,\n                    2u32,\n                    std::ptr::null::<libc::timespec>(),\n                );\n            }\n        }\n    }\n\n    fn unlock(&self) {\n        if self.state.swap(0, Ordering::Release) == 2 {\n            unsafe {\n                libc::syscall(\n                    libc::SYS_futex,\n                    &self.state as *const AtomicU32 as *const u32,\n                    libc::FUTEX_WAKE,\n                    1u32,\n                );\n            }\n        }\n    }\n}\n\nstatic M: FutexMutex = FutexMutex::new();\nstatic TOTAL: AtomicU32 = AtomicU32::new(0);\n\nfn main() {\n    std::thread::scope(|s| {\n        for _ in 0..4 {\n            s.spawn(|| {\n                for _ in 0..100_000 {\n                    M.lock();\n                    TOTAL.fetch_add(1, Ordering::Relaxed);\n                    M.unlock();\n                }\n            });\n        }\n    });\n    println!(\"total = {} (expected 400000)\", TOTAL.load(Ordering::Relaxed));\n}",
          "tip": "Measure the uncontended path with perf stat: a correct futex mutex shows zero futex syscalls until the first real contention, which is the property to preserve in a rewrite."
        },
        {
          "h": "Diagnosing a hang in this layer",
          "p": [
            "When a process is stuck, the question is which primitive and which owner. /proc/PID/stack shows the kernel stack of a task blocked in a syscall; /proc/PID/wchan names the wait channel; perf lock and lockdep-style tracing show contention but require kernel support. For userspace locks, /proc/PID/task/*/stat's state (D for uninterruptible IO, S for sleep) plus a stack sample usually identifies whether the blocker is a mutex, a futex or a disk.",
            "The most common real bug is not a deadlock but lock ordering: two code paths take locks A then B and B then A under rare interleaving. Lockdep finds these at boot in the kernel; in userspace you get it from a documented lock hierarchy, or from a tool like parking_lot's deadlock detection in tests, which is worth the cost in CI and not in production."
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement the three-state futex mutex (0 free, 1 locked, 2 locked-with-waiters), run four threads incrementing a shared counter 100,000 times each, and assert the total. Then count futex syscalls with strace to confirm the uncontended path avoids them.",
        "starter": "use std::sync::atomic::{AtomicU32, Ordering};\n\nstruct FutexMutex { state: AtomicU32 }\n\nimpl FutexMutex {\n    const fn new() -> Self { Self { state: AtomicU32::new(0) } }\n    fn lock(&self) { todo!() }\n    fn unlock(&self) { todo!() }\n}\n\nfn main() {\n    // 4 threads x 100_000 increments under the mutex\n}",
        "hint": "Unlock must swap to 0 and wake only if the old value was 2. In lock, the slow path swaps in 2 and waits only while the word reads 2; that is what prevents a lost wakeup between the CAS and the futex call.",
        "solution": "use std::sync::atomic::{AtomicU32, Ordering};\n\nstruct FutexMutex { state: AtomicU32 }\n\nimpl FutexMutex {\n    const fn new() -> Self { Self { state: AtomicU32::new(0) } }\n\n    fn lock(&self) {\n        if self.state.compare_exchange(0, 1, Ordering::Acquire, Ordering::Relaxed).is_ok() {\n            return;\n        }\n        while self.state.swap(2, Ordering::Acquire) != 0 {\n            unsafe {\n                libc::syscall(\n                    libc::SYS_futex,\n                    &self.state as *const AtomicU32 as *const u32,\n                    libc::FUTEX_WAIT,\n                    2u32,\n                    std::ptr::null::<libc::timespec>(),\n                );\n            }\n        }\n    }\n\n    fn unlock(&self) {\n        if self.state.swap(0, Ordering::Release) == 2 {\n            unsafe {\n                libc::syscall(\n                    libc::SYS_futex,\n                    &self.state as *const AtomicU32 as *const u32,\n                    libc::FUTEX_WAKE,\n                    1u32,\n                );\n            }\n        }\n    }\n}\n\nstatic M: FutexMutex = FutexMutex::new();\nstatic TOTAL: AtomicU32 = AtomicU32::new(0);\n\nfn main() {\n    std::thread::scope(|s| {\n        for _ in 0..4 {\n            s.spawn(|| {\n                for _ in 0..100_000 {\n                    M.lock();\n                    TOTAL.fetch_add(1, Ordering::Relaxed);\n                    M.unlock();\n                }\n            });\n        }\n    });\n    let total = TOTAL.load(Ordering::Relaxed);\n    println!(\"total = {total}\");\n    assert_eq!(total, 400_000);\n}"
      },
      "production": [
        "Document a lock hierarchy for every shared structure and enforce it in review; deadlocks are ordering bugs.",
        "Never allocate, copy to userspace, or wait on IO while holding a spinlock.",
        "Use PI mutexes only where an unbounded inversion is worse than the extra bookkeeping, and keep the critical section short anyway.",
        "Check futex syscall counts before and after lock changes to prove the fast path survived."
      ],
      "crates": [
        "libc",
        "parking_lot",
        "crossbeam"
      ],
      "pitfall": "A spinlock held across a page fault: the fault handler may need the same lock or sleep, the CPU spins with preemption disabled, and the machine reports a soft lockup instead of a clean deadlock.",
      "questions": [
        {
          "q": "Which primitive is legal in hard IRQ context?",
          "options": [
            "A mutex, because it tracks its owner",
            "A spinlock with the IRQ-disabling variant",
            "An rwsem taken for read",
            "A futex wait on a userspace word"
          ],
          "answer": 1,
          "explain": "Only non-sleeping primitives are allowed in interrupt context. spin_lock_irqsave also prevents the local interrupt handler from deadlocking on the same lock."
        },
        {
          "q": "What makes the futex wait/wake protocol immune to lost wakeups?",
          "options": [
            "The kernel takes a global futex lock around every userspace lock operation",
            "FUTEX_WAIT sleeps only if the word still has the expected value, checked under the kernel's bucket lock",
            "The waiter re-checks the word after every scheduler tick",
            "FUTEX_WAKE always wakes all waiters, so none can be missed"
          ],
          "answer": 1,
          "explain": "The value check and the enqueue happen atomically with respect to the waker's swap and FUTEX_WAKE, so either the waiter sees the new value or it is queued before the wake."
        },
        {
          "q": "Why does an uncontended three-state futex mutex make no syscalls?",
          "options": [
            "The kernel maps the futex word into a shared page",
            "Lock is a compare-and-swap and unlock sees the old value 1, so no wake is needed",
            "The libc wrapper batches futex calls per thread",
            "The scheduler polls the futex word during context switches"
          ],
          "answer": 1,
          "explain": "The fast path is entirely userspace atomics. Only a waiter (state 2) causes FUTEX_WAIT, and only a release with waiters causes FUTEX_WAKE."
        }
      ],
      "quickbytes": [
        "Ask can-it-sleep first; the primitive choice follows.",
        "spin_lock_irqsave is about the local CPU, not about other CPUs.",
        "Unlock wakes only when the old state was contended, or every uncontended unlock becomes a syscall.",
        "Priority inheritance raises the holder; it does not shorten the critical section."
      ],
      "github": [
        {
          "name": "parking_lot - futex-based userspace synchronisation",
          "url": "https://github.com/Amanieu/parking_lot"
        },
        {
          "name": "crossbeam - lock-free structures and channel primitives",
          "url": "https://github.com/crossbeam-rs/crossbeam"
        }
      ],
      "resources": [
        {
          "title": "futex(2): the wait/wake protocol",
          "url": "https://man7.org/linux/man-pages/man2/futex.2.html",
          "kind": "docs"
        },
        {
          "title": "Kernel locking documentation index",
          "url": "https://docs.kernel.org/locking/index.html",
          "kind": "docs"
        },
        {
          "title": "parking_lot API reference",
          "url": "https://docs.rs/parking_lot/latest/parking_lot/",
          "kind": "docs"
        },
        {
          "title": "parking_lot source: futex-based parking",
          "url": "https://github.com/Amanieu/parking_lot",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "os10",
      "n": 10,
      "title": "Namespaces and cgroups: the isolation substrate",
      "minutes": 90,
      "level": "advanced",
      "goal": "Know exactly what each namespace virtualises, how cgroup v2 delegation works, and which limits throttle versus kill.",
      "sections": [
        {
          "h": "Eight namespaces, eight different lies",
          "p": [
            "A namespace wraps one global resource so that members see a private instance. PID isolates the process ID space and the process tree; mount isolates the mount table; network isolates interfaces, routes, ports and iptables; IPC isolates System V objects and POSIX queues; UTS isolates hostname and domain; user isolates UID/GID mappings and capabilities; cgroup isolates the visible cgroup root; time isolates CLOCK_MONOTONIC and CLOCK_BOOTTIME offsets.",
            "The user namespace is the key that unlocks the rest: since Linux 3.8 an unprivileged process can create one, and inside it it holds a full capability set over resources it owns. That is how rootless containers work, and also why user namespaces are a security-sensitive surface - the kernel must make sure capabilities in a child user namespace cannot affect the parent."
          ],
          "list": [
            "CLONE_NEWPID: the first child becomes PID 1 in the new namespace; the caller is not moved",
            "CLONE_NEWNS: mount namespace; also required before pivot_root",
            "CLONE_NEWNET: a new stack with only loopback down until you configure it",
            "CLONE_NEWUSER: maps a range of host UIDs to namespace UIDs via uid_map/gid_map"
          ]
        },
        {
          "h": "cgroup v2 is one tree, delegated by file permissions",
          "p": [
            "There is a single cgroup2 hierarchy. Controllers are enabled per-subtree by writing '+cpu +memory' to cgroup.subtree_control, and only then do the controller files appear in the children. The no-internal-process constraint says a non-root cgroup can distribute a domain resource only if it has no processes of its own, so the pattern is always: create children, move processes down, then enable controllers.",
            "Delegation is deliberately boring: give a user write access to a directory plus cgroup.procs, cgroup.threads and cgroup.subtree_control, and they can build a subtree underneath without escaping the parent's limits. With the nsdelegate mount option, a cgroup namespace becomes the delegation boundary, and writes to files at the namespace root are rejected except for the small set listed in /sys/kernel/cgroup/delegate."
          ],
          "code": "use std::fs;\nuse std::io::Write;\n\nfn write(path: &str, value: &str) -> std::io::Result<()> {\n    fs::OpenOptions::new().write(true).open(path)?.write_all(value.as_bytes())\n}\n\nfn main() -> std::io::Result<()> {\n    let base = \"/sys/fs/cgroup/academy\";\n    fs::create_dir_all(base)?;\n\n    // Controllers must be enabled in the parent before child files exist.\n    write(\"/sys/fs/cgroup/cgroup.subtree_control\", \"+memory +pids +cpu\")?;\n    write(&format!(\"{base}/memory.max\"), \"268435456\")?; // 256 MiB\n    write(&format!(\"{base}/pids.max\"), \"64\")?;\n    write(&format!(\"{base}/cpu.max\"), \"50000 100000\")?; // half a CPU\n\n    // Move this process into the group, then read back the accounting.\n    let pid = std::process::id().to_string();\n    write(&format!(\"{base}/cgroup.procs\"), &pid)?;\n\n    for f in [\"memory.current\", \"memory.events\", \"pids.current\", \"cpu.stat\"] {\n        if let Ok(v) = fs::read_to_string(format!(\"{base}/{f}\")) {\n            println!(\"--- {f}\\n{}\", v.trim());\n        }\n    }\n    Ok(())\n}",
          "tip": "Enabling a controller in the parent while it still has processes fails with EBUSY; create the child and move every task down first, which is exactly what systemd does with slices."
        },
        {
          "h": "Limits fail in three different ways",
          "p": [
            "memory.max is a hard wall: exceeding it triggers reclaim, then the cgroup OOM killer. memory.high is a throttle: allocations slow down and the group is pushed to reclaim without being killed, which is the right setting for a latency-sensitive tenant you would rather slow than lose. pids.max makes fork fail with EAGAIN, which an application often misreads as a transient error. cpu.max throttles until the next period, producing latency spikes rather than errors.",
            "Pick the failure mode deliberately, then test it. A limit that has never been provoked in a test is a hypothesis, not a control. The assertions to write are: memory.max produces an OOM kill inside the group and nothing outside it; pids.max produces EAGAIN and not a crash; cpu.max produces throttling visible in cpu.stat and no data loss."
          ]
        },
        {
          "h": "The isolation is not a security boundary by itself",
          "p": [
            "Namespaces partition visibility; they do not enforce least privilege. A process with CAP_SYS_ADMIN in the initial user namespace can setns into almost anything. A container that mounts the host's /proc, shares the host PID namespace, or runs with CAP_SYS_PTRACE can inspect and often control neighbours. The security boundary is the combination of namespaces, dropped capabilities, seccomp, and read-only mounts - each doing a different job.",
            "Two concrete leaks to check in any runtime: /proc/sys and /proc/sysrq-trigger are writable if mounted without care and can change host-wide settings; and a mount namespace that still has the host root reachable through an open descriptor defeats the isolation entirely. The test is not 'does it look isolated' but 'from inside, can I name or affect a process outside'."
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a privileged probe that creates a cgroup, enables the pids controller, sets pids.max to 16, moves itself in, and forks until fork fails. Print the final child count and the error, then confirm pids.events shows the hit.",
        "starter": "use std::fs;\n\nfn main() -> std::io::Result<()> {\n    // 1. mkdir /sys/fs/cgroup/pids-ex\n    // 2. enable +pids in the parent subtree_control\n    // 3. echo 16 > pids.max and move self into cgroup.procs\n    // 4. fork children until libc::fork() returns -1, print errno and count\n    // 5. print pids.events and pids.current\n    Ok(())\n}",
        "hint": "Run as root on a cgroup v2 host. The failure is EAGAIN, not ENOMEM. Children must _exit immediately so they do not consume the parent's remaining time; read pids.events after the failures.",
        "solution": "use std::fs;\nuse std::io::Write;\nuse std::time::Duration;\n\nfn write(path: &str, v: &str) -> std::io::Result<()> {\n    fs::OpenOptions::new().write(true).open(path)?.write_all(v.as_bytes())\n}\n\nfn main() -> std::io::Result<()> {\n    let base = \"/sys/fs/cgroup/pids-ex\";\n    fs::create_dir_all(base)?;\n    write(\"/sys/fs/cgroup/cgroup.subtree_control\", \"+pids\")?;\n    write(&format!(\"{base}/pids.max\"), \"16\")?;\n    write(&format!(\"{base}/cgroup.procs\"), &std::process::id().to_string())?;\n    // Leave headroom for this process and its threads.\n    std::thread::sleep(Duration::from_millis(20));\n\n    let mut made = 0;\n    loop {\n        let pid = unsafe { libc::fork() };\n        if pid == 0 {\n            std::thread::sleep(Duration::from_millis(500));\n            unsafe { libc::_exit(0) };\n        }\n        if pid < 0 {\n            let e = std::io::Error::last_os_error();\n            println!(\"fork failed after {made} children: {e} (errno {:?})\", e.raw_os_error());\n            break;\n        }\n        made += 1;\n        if made > 200 { break; }\n    }\n\n    println!(\"pids.current = {}\", fs::read_to_string(format!(\"{base}/pids.current\"))?.trim());\n    println!(\"pids.events:\\n{}\", fs::read_to_string(format!(\"{base}/pids.events\"))?.trim());\n    Ok(())\n}"
      },
      "production": [
        "Test every limit by provoking it; record the observed failure (OOM kill, EAGAIN, throttle) next to the configuration.",
        "Use memory.high for throttling and memory.max for a hard wall; do not set only one and hope.",
        "Never share the host PID namespace or mount host /proc into an untrusted workload.",
        "Drop capabilities and apply seccomp in addition to namespaces; isolation without least privilege is cosmetic."
      ],
      "crates": [
        "nix",
        "libc",
        "caps"
      ],
      "pitfall": "Enabling a domain controller in a cgroup that still has processes: the write fails with EBUSY, the setup script ignores the error, and the limits silently never apply.",
      "questions": [
        {
          "q": "After unshare(CLONE_NEWPID), which process is PID 1 in the new namespace?",
          "options": [
            "The calling process",
            "The first child created after the unshare",
            "The kernel's kthreadd",
            "The process that wrote to /proc/sys/kernel/ns_last_pid"
          ],
          "answer": 1,
          "explain": "unshare(CLONE_NEWPID) changes the namespace for children only. The caller stays in the old PID namespace; its first child becomes PID 1 and inherits the reaping duties."
        },
        {
          "q": "Why does writing +memory to a populated non-root cgroup.subtree_control fail?",
          "options": [
            "The memory controller cannot be delegated",
            "The no-internal-process constraint forbids distributing a domain resource while the cgroup has processes",
            "memory.max must be set before the controller is enabled",
            "The file only accepts one controller at a time"
          ],
          "answer": 1,
          "explain": "Domain controllers must only see processes at the leaves. Create children, move the tasks down, then enable the controller in the parent."
        },
        {
          "q": "Which cgroup limit throttles instead of killing when exceeded?",
          "options": [
            "memory.max",
            "memory.high",
            "pids.max",
            "memory.oom.group"
          ],
          "answer": 1,
          "explain": "memory.high applies reclaim pressure and slows allocations. memory.max is a hard wall that ends in the cgroup OOM killer."
        }
      ],
      "quickbytes": [
        "unshare changes namespaces for children; setns joins an existing one by fd.",
        "cgroup v2: create child, move tasks, then enable controllers in the parent.",
        "memory.high throttles, memory.max kills, pids.max returns EAGAIN, cpu.max throttles.",
        "Namespaces hide; capabilities and seccomp restrict. You need all three."
      ],
      "github": [
        {
          "name": "runc - reference OCI runtime built on namespaces and cgroups",
          "url": "https://github.com/opencontainers/runc"
        },
        {
          "name": "podman - rootless container engine",
          "url": "https://github.com/podman-container-tools/podman"
        }
      ],
      "resources": [
        {
          "title": "namespaces(7): all eight types and the API",
          "url": "https://man7.org/linux/man-pages/man7/namespaces.7.html",
          "kind": "docs"
        },
        {
          "title": "Control Group v2: controllers, delegation, no-internal-process",
          "url": "https://docs.kernel.org/admin-guide/cgroup-v2.html",
          "kind": "docs"
        },
        {
          "title": "user_namespaces(7): uid_map, capabilities and restrictions",
          "url": "https://man7.org/linux/man-pages/man7/user_namespaces.7.html",
          "kind": "docs"
        },
        {
          "title": "runc source: how a real runtime sequences namespaces",
          "url": "https://github.com/opencontainers/runc",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "os11",
      "n": 11,
      "title": "Containers from first principles: pivot_root and exec",
      "minutes": 100,
      "level": "advanced",
      "goal": "Assemble a container by hand in the right order - namespaces, private mounts, pivot_root, proc, privilege drop, exec - and know which step each isolation property comes from.",
      "sections": [
        {
          "h": "There is no container object in the kernel",
          "p": [
            "A container is a process whose clone flags, mount table, cgroup membership, capabilities and seccomp filter happen to produce a useful illusion. Nothing in the kernel is named container; runc, crun and containerd are userspace programs that perform the same sequence of syscalls you can write yourself. That is why container escapes are almost always configuration bugs - a shared namespace, a mounted host path, a retained capability - rather than kernel magic.",
            "Order matters. Namespaces must exist before you mount, mounts must be private before you pivot, /proc must be mounted after the PID namespace exists, and privileges must be dropped after the mounts but before exec. Getting the order wrong produces failures that look unrelated: mounting proc too early shows the host's processes, dropping capabilities too early makes mount fail with EPERM."
          ],
          "list": [
            "unshare(CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWUTS | CLONE_NEWIPC)",
            "mount --make-rprivate / so nothing propagates back to the host",
            "bind the prepared rootfs onto itself so it is a mount point",
            "pivot_root(new_root, new_root/.oldroot) and detach the old root",
            "mount a fresh /proc, set hostname, drop capabilities, exec"
          ]
        },
        {
          "h": "pivot_root, not chroot",
          "p": [
            "chroot changes the root directory of the calling process only. The working directory can remain outside, open descriptors still reference the old tree, and a process with CAP_SYS_CHROOT can escape trivially. The kernel's own documentation calls chroot a security measure only in the weakest sense: it is a filesystem namespace convenience, not an isolation boundary.",
            "pivot_root moves the mount namespace's root. It requires that the new root is a mount point, that it is not the current root, and that the old root is moved to a directory underneath the new one, from which you then detach it with umount2(MNT_DETACH). After that the old tree is unreachable by path in this namespace, even for a process that keeps a descriptor - though that descriptor still works, which is why you should also close inherited descriptors."
          ],
          "code": "use std::ffi::CString;\nuse std::os::unix::process::CommandExt;\nuse std::process::Command;\n\nfn c(s: &str) -> CString { CString::new(s).unwrap() }\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    let root = c(\"/srv/rootfs\");\n\n    unsafe {\n        // 1. Requires CAP_SYS_ADMIN in the current user namespace.\n        let flags = libc::CLONE_NEWNS | libc::CLONE_NEWPID | libc::CLONE_NEWUTS | libc::CLONE_NEWIPC;\n        if libc::unshare(flags) != 0 {\n            return Err(std::io::Error::last_os_error().into());\n        }\n\n        // 2. Stop mount propagation before touching anything.\n        libc::mount(std::ptr::null(), c(\"/\").as_ptr(), std::ptr::null(),\n            libc::MS_REC | libc::MS_PRIVATE, std::ptr::null());\n\n        // 3. new_root must itself be a mount point for pivot_root.\n        libc::mount(root.as_ptr(), root.as_ptr(), std::ptr::null(),\n            libc::MS_BIND | libc::MS_REC, std::ptr::null());\n\n        // 4. Put the old root under the new one, then pivot.\n        let put_old = c(\"/srv/rootfs/.oldroot\");\n        libc::mkdir(put_old.as_ptr(), 0o755);\n        if libc::syscall(libc::SYS_pivot_root, root.as_ptr(), put_old.as_ptr()) != 0 {\n            return Err(std::io::Error::last_os_error().into());\n        }\n        libc::chdir(c(\"/\").as_ptr());\n\n        // 5. Detach the old root and mount a fresh proc for the new PID ns.\n        let old = c(\"/.oldroot\");\n        libc::umount2(old.as_ptr(), libc::MNT_DETACH);\n        libc::rmdir(old.as_ptr());\n        libc::mount(c(\"proc\").as_ptr(), c(\"/proc\").as_ptr(), c(\"proc\").as_ptr(), 0, std::ptr::null());\n\n        libc::sethostname(c(\"academy\").as_ptr(), 7);\n        libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);\n    }\n\n    // 6. exec in the same process: the new program becomes the container's init.\n    let err = Command::new(\"/bin/sh\").arg(\"-c\").arg(\"id; hostname; ps -ef\").exec();\n    Err(err.into())\n}",
          "tip": "The rootfs must be owned and mounted by the runtime, not the workload: a writable rootfs mounted without nosuid,nodev,noexec turns a container compromise into a host compromise."
        },
        {
          "h": "Build the root filesystem before you enter it",
          "p": [
            "A usable rootfs needs more than a copy of /bin. Mount proc for the new PID namespace, a minimal /dev (devtmpfs or a few bind-mounted nodes), /sys read-only, a tmpfs /tmp, and /etc/resolv.conf copied rather than bind-mounted from the host so the workload cannot rewrite host DNS configuration. Every bind mount from the host is a hole; count them and justify each one.",
            "Ownership matters because of user namespaces. If you map container root to an unprivileged host UID, files owned by that host UID inside the rootfs appear as root inside. Files owned by real host root appear as nobody, which breaks setuid binaries and is a useful audit signal: if a file shows nobody, the mapping and the on-disk ownership disagree."
          ]
        },
        {
          "h": "Drop privilege in the right order and prove it",
          "p": [
            "PR_SET_NO_NEW_PRIVS prevents execve from gaining privileges through setuid or file capabilities; set it before exec and it cannot be undone. Then clear the capability bounding set, drop ambient capabilities, and set the uid/gid mapping so that the workload runs as the intended user inside the namespace. A seccomp filter belongs last, immediately before exec, because every syscall you need for setup must exist in the filter.",
            "Then verify rather than assume. From inside, check /proc/self/status for CapEff, NoNewPrivs and Seccomp; check /proc/self/uid_map; list /proc/1/ns and compare inode numbers with the host. From outside, check that the process cannot see host PIDs, that its cgroup is the one you created, and that a write to a read-only mount fails with EROFS. Each assertion maps to one step in the sequence."
          ]
        }
      ],
      "exercise": {
        "prompt": "Write the container setup sequence for a prepared rootfs at /srv/rootfs: private mounts, bind, pivot_root, detach old root, mount proc, no_new_privs, then exec /bin/sh. Make every failure return an error with the failing syscall name.",
        "starter": "use std::ffi::CString;\n\nfn c(s: &str) -> CString { CString::new(s).unwrap() }\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    // unshare NEWNS|NEWPID|NEWUTS|NEWIPC\n    // make / rprivate, bind /srv/rootfs onto itself\n    // pivot_root to /srv/rootfs with .oldroot, detach it\n    // mount proc, set no_new_privs, exec\n    Ok(())\n}",
        "hint": "Bind-mount new_root onto itself before pivot_root or you get EINVAL. Detach the old root with MNT_DETACH, otherwise busy mounts keep it alive. Run as root in a disposable VM or user namespace.",
        "solution": "use std::ffi::CString;\nuse std::os::unix::process::CommandExt;\nuse std::process::Command;\n\nfn c(s: &str) -> CString { CString::new(s).unwrap() }\n\nfn check(rc: libc::c_int, what: &str) -> Result<(), Box<dyn std::error::Error>> {\n    if rc == 0 { Ok(()) } else { Err(format!(\"{what}: {}\", std::io::Error::last_os_error()).into()) }\n}\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    let root = c(\"/srv/rootfs\");\n    let put_old = c(\"/srv/rootfs/.oldroot\");\n    unsafe {\n        check(libc::unshare(libc::CLONE_NEWNS | libc::CLONE_NEWPID | libc::CLONE_NEWUTS | libc::CLONE_NEWIPC), \"unshare\")?;\n        check(libc::mount(std::ptr::null(), c(\"/\").as_ptr(), std::ptr::null(),\n            libc::MS_REC | libc::MS_PRIVATE, std::ptr::null()), \"make-rprivate\")?;\n        check(libc::mount(root.as_ptr(), root.as_ptr(), std::ptr::null(),\n            libc::MS_BIND | libc::MS_REC, std::ptr::null()), \"bind rootfs\")?;\n        libc::mkdir(put_old.as_ptr(), 0o755);\n        check(libc::syscall(libc::SYS_pivot_root, root.as_ptr(), put_old.as_ptr()) as i32, \"pivot_root\")?;\n        check(libc::chdir(c(\"/\").as_ptr()), \"chdir /\")?;\n        check(libc::umount2(c(\"/.oldroot\").as_ptr(), libc::MNT_DETACH), \"detach old root\")?;\n        check(libc::mount(c(\"proc\").as_ptr(), c(\"/proc\").as_ptr(), c(\"proc\").as_ptr(), 0, std::ptr::null()), \"mount proc\")?;\n        check(libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), \"no_new_privs\")?;\n    }\n    Err(Command::new(\"/bin/sh\").exec().into())\n}"
      },
      "production": [
        "Make the mount tree private before any bind mount, and count host bind mounts as part of the threat model.",
        "Mount container rootfs with nosuid,nodev,noexec where the workload does not need them.",
        "Set no_new_privs and a seccomp filter before exec; verify NoNewPrivs and Seccomp in /proc/self/status.",
        "Close inherited file descriptors across the runtime boundary; a descriptor to the host root defeats pivot_root."
      ],
      "crates": [
        "nix",
        "libc",
        "caps"
      ],
      "pitfall": "Skipping mount --make-rprivate: a mount performed inside the container propagates back to the host mount namespace and every other container that shares it.",
      "questions": [
        {
          "q": "Why does chroot not isolate a container?",
          "options": [
            "It is not implemented on modern kernels",
            "It only changes the calling process's root directory, and open descriptors or CAP_SYS_CHROOT allow escape",
            "It requires the same filesystem for all mounts",
            "It cannot be combined with a mount namespace"
          ],
          "answer": 1,
          "explain": "chroot is a path-resolution change, not a mount-namespace operation. A retained fd to a directory outside, or the capability to call chroot again, breaks it."
        },
        {
          "q": "Which condition makes pivot_root return EINVAL?",
          "options": [
            "The new root is on a different filesystem from the old root",
            "The new root is not a mount point, or is the current root",
            "The old root is still mounted read-only",
            "The calling process has not mounted proc yet"
          ],
          "answer": 1,
          "explain": "pivot_root needs new_root to be a mount point and distinct from the current root. Bind-mounting it onto itself first is the standard fix."
        },
        {
          "q": "What does PR_SET_NO_NEW_PRIVS actually prevent?",
          "options": [
            "All setuid binaries from executing at all",
            "execve from gaining new privileges via setuid or file capabilities",
            "The process from creating new namespaces",
            "Writes to the root filesystem"
          ],
          "answer": 1,
          "explain": "It is a one-way flag: execve may proceed but cannot confer privilege. It does not stop namespaces, and it does not make mounts read-only."
        }
      ],
      "quickbytes": [
        "unshare -> rprivate -> bind -> pivot_root -> detach -> mount proc -> no_new_privs -> exec.",
        "pivot_root requires new_root to be a mount point and not the current root.",
        "Bind-mounting /etc/resolv.conf from the host gives the workload write access to host DNS config.",
        "Verify CapEff, NoNewPrivs and Seccomp from inside; do not trust the config file."
      ],
      "github": [
        {
          "name": "bubblewrap - unprivileged sandboxing used by Flatpak",
          "url": "https://github.com/containers/bubblewrap"
        },
        {
          "name": "runc - OCI runtime reference implementation",
          "url": "https://github.com/opencontainers/runc"
        }
      ],
      "resources": [
        {
          "title": "pivot_root(2): requirements and error cases",
          "url": "https://man7.org/linux/man-pages/man2/pivot_root.2.html",
          "kind": "docs"
        },
        {
          "title": "mount_namespaces(7): propagation and locking",
          "url": "https://man7.org/linux/man-pages/man7/mount_namespaces.7.html",
          "kind": "docs"
        },
        {
          "title": "bubblewrap source: a minimal, auditable container builder",
          "url": "https://github.com/containers/bubblewrap",
          "kind": "repo"
        },
        {
          "title": "runc: the syscall sequence behind docker run",
          "url": "https://github.com/opencontainers/runc",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "os12",
      "n": 12,
      "title": "Boot, initramfs, and PID 1 duties",
      "minutes": 85,
      "level": "advanced",
      "goal": "Follow the handoff from firmware to kernel to initramfs to root filesystem, then implement the reaping and signal duties that make a process a valid PID 1.",
      "sections": [
        {
          "h": "Firmware, bootloader, kernel, initramfs",
          "p": [
            "UEFI firmware initialises enough hardware to read a boot entry and loads an EFI application - usually the kernel's own EFI stub. The kernel decompresses itself, sets up paging and traps, and mounts an initial rootfs: a tmpfs populated from the initramfs archive the bootloader loaded alongside it. That archive is a CPIO file, not a filesystem image, and it is what makes early boot possible before any disk driver is available.",
            "The kernel then executes /init from that tmpfs. In an initramfs, /init is responsible for finding and mounting the real root, which may require loading storage or network modules, assembling RAID or unlocking LUKS. When the real root is ready, it either execs the real init after chroot (switch_root) or pivots into it and execs PID 1. systemd can run inside the initramfs and uses the same unit model, with initrd.target as its goal."
          ],
          "list": [
            "initramfs: CPIO archive unpacked into tmpfs, freed after switch_root",
            "switch_root: move mounts, chroot, exec the new init, delete the old root",
            "root= and rd.* kernel parameters select and debug the root device",
            "init=/bin/sh and rd.break are the two escape hatches worth memorising"
          ]
        },
        {
          "h": "PID 1 is a job, not a privilege",
          "p": [
            "The kernel gives PID 1 three special properties: signals with default dispositions are ignored rather than fatal, orphaned processes in the namespace are re-parented to it, and its death panics the kernel. Everything else must be implemented. A minimal init must mount /proc and /dev, reap every orphan by calling waitpid(-1), and translate SIGTERM into an orderly shutdown or reboot.",
            "The reaping duty is the one that breaks naive containers. A PID 1 that never calls waitpid accumulates zombies until the pid namespace is exhausted; a PID 1 that exits or returns from main triggers a kernel panic. That is why container images with a shell as entrypoint, or an application that does not reap, need a tiny init like tini or dumb-init in front of them."
          ],
          "code": "use std::ffi::CString;\n\nfn c(s: &str) -> CString { CString::new(s).unwrap() }\n\nextern \"C\" fn on_term(_: libc::c_int) {\n    unsafe { libc::reboot(libc::RB_POWER_OFF) }; // or RB_AUTOBOOT, after unmounting\n}\n\nfn main() {\n    unsafe {\n        libc::mkdir(c(\"/proc\").as_ptr(), 0o755);\n        libc::mount(c(\"proc\").as_ptr(), c(\"/proc\").as_ptr(), c(\"proc\").as_ptr(), 0, std::ptr::null());\n        libc::mkdir(c(\"/dev\").as_ptr(), 0o755);\n        libc::mount(c(\"devtmpfs\").as_ptr(), c(\"/dev\").as_ptr(), c(\"devtmpfs\").as_ptr(), 0, std::ptr::null());\n\n        libc::signal(libc::SIGTERM, on_term as usize);\n        libc::signal(libc::SIGINT, on_term as usize);\n    }\n\n    loop {\n        let mut status = 0;\n        let pid = unsafe { libc::waitpid(-1, &mut status, 0) };\n        if pid < 0 {\n            let e = std::io::Error::last_os_error();\n            if e.raw_os_error() == Some(libc::EINTR) { continue; }\n            panic!(\"waitpid: {e}\");\n        }\n        if libc::WIFEXITED(status) {\n            println!(\"pid {pid} exited with {}\", libc::WEXITSTATUS(status));\n        } else if libc::WIFSIGNALED(status) {\n            println!(\"pid {pid} killed by signal {}\", libc::WTERMSIG(status));\n        }\n    }\n}",
          "tip": "Never return from main in PID 1: the kernel panics with 'Attempted to kill init'. Exit through reboot(2), or call _exit only if you intend to halt the machine."
        },
        {
          "h": "systemd starts a graph, not a list",
          "p": [
            "systemd models boot as a dependency graph of units - services, sockets, mounts, timers, targets. Ordering is expressed with Before/After, requirements with Requires/Wants, and targets are named checkpoints such as sysinit.target, basic.target and multi-user.target. Sockets are bound early and handed to services on demand, which is why a service can be 'started' while its binary is still loading.",
            "That parallelism is why 'the boot hangs' is rarely one slow service. Use systemd-analyze blame for the total time per unit, systemd-analyze critical-chain for the path that actually gates the target, and journalctl -b -u <unit> for the failure. Reaching emergency.target is a diagnostic state, not a fix: it usually means a required mount or local-fs unit failed."
          ]
        },
        {
          "h": "Debugging boot when there is no shell",
          "p": [
            "The kernel's console output is the only reliable channel. Add console=ttyS0,115200 earlycon to the kernel command line, and set loglevel=8 while debugging. If the initramfs is the problem, rd.debug and rd.shell give you a shell inside it; if the root filesystem is the problem, init=/bin/sh bypasses systemd entirely and shows whether the kernel can mount the root at all.",
            "Persistent journals make the difference after a failed boot: journalctl -b -1 reads the previous boot if /var/log/journal is on persistent storage. For panics, pstore or kdump capture the tail that never made it to disk. The general rule is to instrument earlier: by the time systemd logs something, several hundred kernel messages and driver probes have already happened."
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement a minimal PID 1: mount proc and devtmpfs, install a SIGTERM handler that reboots, then loop on waitpid(-1) printing exit codes and signals. Test it inside a PID namespace, where it can be PID 1 without being the host's init.",
        "starter": "use std::ffi::CString;\n\nfn main() {\n    // 1. mount /proc and /dev\n    // 2. handle SIGTERM and SIGINT -> reboot(RB_POWER_OFF)\n    // 3. loop: waitpid(-1), decode WIFEXITED/WIFSIGNALED, never return\n}",
        "hint": "Test with unshare --pid --mount --fork ./minit, then run a child that exits 3 and another that kills itself. The waitpid loop must survive EINTR and must never fall out of the loop.",
        "solution": "use std::ffi::CString;\n\nfn c(s: &str) -> CString { CString::new(s).unwrap() }\n\nextern \"C\" fn on_term(_: libc::c_int) {\n    unsafe { libc::reboot(libc::RB_POWER_OFF) };\n}\n\nfn main() {\n    unsafe {\n        libc::mkdir(c(\"/proc\").as_ptr(), 0o755);\n        libc::mount(c(\"proc\").as_ptr(), c(\"/proc\").as_ptr(), c(\"proc\").as_ptr(), 0, std::ptr::null());\n        libc::mkdir(c(\"/dev\").as_ptr(), 0o755);\n        libc::mount(c(\"devtmpfs\").as_ptr(), c(\"/dev\").as_ptr(), c(\"devtmpfs\").as_ptr(), 0, std::ptr::null());\n        libc::signal(libc::SIGTERM, on_term as usize);\n        libc::signal(libc::SIGINT, on_term as usize);\n    }\n\n    loop {\n        let mut status = 0;\n        let pid = unsafe { libc::waitpid(-1, &mut status, 0) };\n        if pid < 0 {\n            if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {\n                continue;\n            }\n            std::thread::sleep(std::time::Duration::from_millis(10));\n            continue;\n        }\n        if libc::WIFEXITED(status) {\n            println!(\"reaped {pid}: exit {}\", libc::WEXITSTATUS(status));\n        } else if libc::WIFSIGNALED(status) {\n            println!(\"reaped {pid}: signal {}\", libc::WTERMSIG(status));\n        } else {\n            println!(\"reaped {pid}: status {status}\");\n        }\n    }\n}"
      },
      "production": [
        "Give every container an init that reaps, or set the image entrypoint to a real init; never leave reaping to the application.",
        "Add console=ttyS0 with earlycon to the kernel command line for every server image, and keep a serial console reachable.",
        "Use systemd-analyze critical-chain, not blame, to find what gates the boot target.",
        "Persist the journal across reboots so the previous boot's failure is still readable."
      ],
      "crates": [
        "libc",
        "nix",
        "rustix"
      ],
      "pitfall": "A container entrypoint that starts the app directly with no init: the app becomes PID 1, ignores SIGTERM by default, and never reaps, so shutdowns time out and zombies accumulate.",
      "questions": [
        {
          "q": "What is an initramfs, mechanically?",
          "options": [
            "A disk image containing a minimal root filesystem",
            "A CPIO archive the kernel unpacks into a tmpfs",
            "A compressed ext4 partition mounted read-only by the bootloader",
            "A kernel module that mounts the root filesystem"
          ],
          "answer": 1,
          "explain": "It is a CPIO archive, not a filesystem image, unpacked into rootfs (tmpfs). That is why it needs no block driver and is freed after switch_root."
        },
        {
          "q": "Which signal behaviour is special for PID 1?",
          "options": [
            "It receives every signal twice",
            "Signals with default dispositions are ignored instead of fatal",
            "It cannot receive SIGKILL",
            "Signal handlers run on a separate stack automatically"
          ],
          "answer": 1,
          "explain": "The kernel protects init from accidental death by default actions, which is also why a naive init appears not to respond to SIGTERM until it installs a handler."
        },
        {
          "q": "What happens when PID 1 exits?",
          "options": [
            "The kernel re-parents its children and continues",
            "The kernel panics, because init cannot be killed",
            "Runlevel 1 is entered",
            "systemd restarts it automatically"
          ],
          "answer": 1,
          "explain": "There is nothing above init to reap or continue. The kernel panics, which is why init must exit only through reboot(2)."
        }
      ],
      "quickbytes": [
        "initramfs is a CPIO archive in tmpfs; initrd is the legacy block-device form.",
        "switch_root chroots and execs; it also deletes the initramfs to free memory.",
        "PID 1 must reap with waitpid(-1); orphan re-parenting is automatic, reaping is not.",
        "systemd-analyze critical-chain answers what gates boot; blame answers what is slow."
      ],
      "github": [
        {
          "name": "systemd - init, units, and boot targets",
          "url": "https://github.com/systemd/systemd"
        },
        {
          "name": "Linux kernel init and initramfs code",
          "url": "https://github.com/torvalds/linux"
        }
      ],
      "resources": [
        {
          "title": "bootup(7): firmware, initramfs, targets, shutdown",
          "url": "https://man7.org/linux/man-pages/man7/bootup.7.html",
          "kind": "docs"
        },
        {
          "title": "Kernel command-line parameters (root=, rd.*, console=)",
          "url": "https://docs.kernel.org/admin-guide/kernel-parameters.html",
          "kind": "docs"
        },
        {
          "title": "systemd source: unit ordering and transaction logic",
          "url": "https://github.com/systemd/systemd",
          "kind": "repo"
        },
        {
          "title": "Linux kernel source: init/ and initramfs unpacking",
          "url": "https://github.com/torvalds/linux",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "os13",
      "n": 13,
      "title": "Device drivers and the Linux device model",
      "minutes": 85,
      "level": "advanced",
      "goal": "Read the bus/device/driver model from sysfs, understand what a char device's file_operations expose, and know where a driver's failure modes surface.",
      "sections": [
        {
          "h": "Bus, device, driver: the model behind sysfs",
          "p": [
            "The device model is a set of kernel objects connected by buses. A bus type can match a device with a driver, usually through an ID table (PCI vendor/device, USB VID/PID, platform compatible string, or ACPI HID). When a match occurs, the driver's probe function runs; remove runs on unbind or hot-unplug. Every object appears in sysfs: /sys/bus/pci/devices, /sys/bus/pci/drivers, and the symlinks between them are the model, not a report about it.",
            "Enumeration comes from firmware. On x86 it is ACPI plus PCI configuration space; on ARM it is the device tree passed at boot. A driver that hard-codes register addresses instead of taking them from the device's resources will work on exactly one board. The kernel's rule is that resources - MMIO ranges, IRQ numbers, GPIOs, clocks, regulators - are described by firmware and claimed by the driver."
          ],
          "list": [
            "kobject: the sysfs directory and reference count",
            "device: a physical or virtual device, with resources and a parent",
            "driver: code plus an ID table, bound by the bus",
            "uevent: the notification udev turns into /dev nodes and systemd units"
          ]
        },
        {
          "h": "Char devices are a file_operations table",
          "p": [
            "A char device registers a major number and a file_operations struct: open, release, read, write, ioctl, mmap, poll. The kernel does not interpret your protocol; it dispatches from the VFS to those function pointers. That is why ioctl is where most device-specific control lives - it is the only general-purpose escape hatch in the interface.",
            "ioctl arguments are untyped integers from the kernel's perspective, which is why each driver defines request codes with _IO/_IOR/_IOW/_IOWR macros encoding direction and size. Getting the direction wrong is a classic bug: the kernel writes into a userspace pointer the caller marked as input, and nothing checks it. Modern drivers prefer a typed ioctl number with an explicit struct, and use copy_from_user/copy_to_user rather than dereferencing user pointers."
          ],
          "code": "use std::fs;\nuse std::mem::MaybeUninit;\n\nfn main() -> std::io::Result<()> {\n    // Identity, driver binding and modalias are all sysfs attributes.\n    println!(\"{}\", fs::read_to_string(\"/sys/class/net/lo/uevent\")?.trim());\n    for entry in fs::read_dir(\"/sys/bus/pci/drivers\")?.take(5) {\n        let e = entry?;\n        println!(\"pci driver: {}\", e.file_name().to_string_lossy());\n    }\n\n    // A char device's private operations are reached through ioctl.\n    let mut ws: libc::winsize = unsafe { MaybeUninit::zeroed().assume_init() };\n    let rc = unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut ws) };\n    if rc == 0 {\n        println!(\"terminal is {}x{}\", ws.ws_col, ws.ws_row);\n    } else {\n        println!(\"stdout is not a tty: {}\", std::io::Error::last_os_error());\n    }\n    Ok(())\n}",
          "tip": "Read /sys/class/<subsys>/<dev>/uevent before writing udev rules: it shows the exact MODALIAS, DEVNAME and DEVUID the kernel will send, so the rule matches reality."
        },
        {
          "h": "The probe path and its traps",
          "p": [
            "probe runs in process context and may sleep, so it can allocate, request IRQs and read firmware. It must not assume the hardware is ready: regulators and clocks may need enabling, and a device may need a reset delay. devm_* managed allocations tie cleanup to the device's lifetime, which removes most error-path leaks but makes ordering matter - managed resources are released in reverse order.",
            "Concurrency is where drivers break. Interrupt handlers run concurrently with the process reading the device; buffers shared with the device need DMA-safe allocation and correct barriers; and a driver that sleeps in an atomic context triggers a scheduling-while-atomic warning immediately. Locking a driver's state with a mutex is fine in read/write, but not in the hard IRQ handler - that is where spinlocks and threaded IRQs come in."
          ]
        },
        {
          "h": "Where to look when a device misbehaves",
          "p": [
            "Start with dmesg: probe failures, firmware load errors and AER reports all land there with the device's BDF. lspci -k shows which driver claimed a device and which modules are in use; lsusb -t shows the topology and negotiated speed. If a device has no driver, the modalias in sysfs tells you exactly what ID the bus offered.",
            "For a driver you are writing, dynamic debug (dyndbg) lets you enable pr_debug at runtime per file or per call site without rebuilding. ftrace's function_graph follows probe and interrupt paths, and perf can attribute time to kernel symbols. The one thing to avoid is printk in a hot interrupt path: it serialises on the console and turns a latency problem into a much bigger one."
          ]
        }
      ],
      "exercise": {
        "prompt": "Enumerate PCI drivers and devices from sysfs, print the driver bound to the first network-class device, and use an ioctl to query the terminal size. Handle a non-tty stdout without failing.",
        "starter": "use std::fs;\n\nfn main() -> std::io::Result<()> {\n    // 1. list /sys/bus/pci/drivers (first 10)\n    // 2. read /sys/class/net/*/device/uevent if present\n    // 3. ioctl TIOCGWINSZ on stdout and print width/height\n    Ok(())\n}",
        "hint": "A virtual interface such as lo has no PCI device, so the uevent read must be optional. TIOCGWINSZ needs a real terminal; redirecting output to a file makes it fail with ENOTTY, which is the case to handle.",
        "solution": "use std::fs;\nuse std::mem::MaybeUninit;\nuse std::path::Path;\n\nfn main() -> std::io::Result<()> {\n    for entry in fs::read_dir(\"/sys/bus/pci/drivers\")?.take(10) {\n        println!(\"driver: {}\", entry?.file_name().to_string_lossy());\n    }\n\n    for entry in fs::read_dir(\"/sys/class/net\")? {\n        let iface = entry?.path();\n        let uevent = iface.join(\"device/uevent\");\n        if Path::new(&uevent).exists() {\n            println!(\"interface {} bound to:\\n{}\", iface.file_name().unwrap().to_string_lossy(), fs::read_to_string(uevent)?.trim());\n            break;\n        }\n    }\n\n    let mut ws: libc::winsize = unsafe { MaybeUninit::zeroed().assume_init() };\n    let rc = unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut ws) };\n    if rc == 0 && ws.ws_col > 0 {\n        println!(\"terminal: {} cols x {} rows\", ws.ws_col, ws.ws_row);\n    } else {\n        println!(\"stdout is not a tty (ioctl errno {:?})\", std::io::Error::last_os_error().raw_os_error());\n    }\n    Ok(())\n}"
      },
      "production": [
        "Bind drivers by ID tables and firmware-described resources; never hard-code addresses or IRQs.",
        "Use devm_* allocations in probe and keep the remove path symmetric and testable.",
        "Enable dyndbg per file instead of adding printk to hot paths; console writes serialise.",
        "Check lspci -k or lsusb -t before debugging a protocol; an unbound device explains most 'hardware broken' reports."
      ],
      "crates": [
        "nix",
        "libc",
        "rustix"
      ],
      "pitfall": "Sleeping in an atomic context: calling a function that takes a mutex or allocates with GFP_KERNEL from a hard IRQ handler produces a scheduling-while-atomic warning and can deadlock the CPU.",
      "questions": [
        {
          "q": "What decides which driver binds to a PCI device?",
          "options": [
            "The order modules were loaded",
            "The bus matches the device ID against each driver's ID table and calls probe on a match",
            "udev assigns the driver from its rules",
            "The device tree node's status property"
          ],
          "answer": 1,
          "explain": "Matching is a bus operation over ID tables; module load order only affects which drivers are available. udev reacts to the resulting uevent."
        },
        {
          "q": "Why is ioctl a common source of driver bugs?",
          "options": [
            "It cannot be called from a multithreaded process",
            "The request encoding and the pointer types are unchecked, so direction and structure size must be right by construction",
            "It always copies data twice",
            "It bypasses the VFS permission checks"
          ],
          "answer": 1,
          "explain": "The kernel sees an unsigned long request and a void pointer. _IOR/_IOW encode direction; a mismatch silently corrupts data or reads uninitialised memory."
        },
        {
          "q": "Which context may sleep?",
          "options": [
            "Hard IRQ handler",
            "Softirq",
            "Driver probe",
            "Atomic section under spin_lock"
          ],
          "answer": 2,
          "explain": "probe runs in process context, so it may allocate, wait for firmware, and take mutexes. IRQ and softirq contexts may not sleep."
        }
      ],
      "quickbytes": [
        "sysfs is the device model; /sys/bus/*/drivers and devices are views of the same graph.",
        "uevent is what udev consumes; read it before writing rules.",
        "ioctl request codes encode direction and size - get them from the same header on both sides.",
        "dmesg, lspci -k, lsusb -t, then dyndbg; in that order."
      ],
      "github": [
        {
          "name": "Linux kernel driver core and driver API",
          "url": "https://github.com/torvalds/linux"
        },
        {
          "name": "systemd - udev, the userspace half of the device model",
          "url": "https://github.com/systemd/systemd"
        }
      ],
      "resources": [
        {
          "title": "Driver model overview (kernel documentation)",
          "url": "https://docs.kernel.org/driver-api/driver-model/overview.html",
          "kind": "docs"
        },
        {
          "title": "ioctl(2): request encoding and permission rules",
          "url": "https://man7.org/linux/man-pages/man2/ioctl.2.html",
          "kind": "docs"
        },
        {
          "title": "Driver API documentation index",
          "url": "https://docs.kernel.org/driver-api/index.html",
          "kind": "docs"
        },
        {
          "title": "Linux kernel source: drivers/ and include/linux/device.h",
          "url": "https://github.com/torvalds/linux",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "os14",
      "n": 14,
      "title": "eBPF and tracing: the verifier is the contract",
      "minutes": 95,
      "level": "industry",
      "goal": "Write and load a real eBPF program, understand what the verifier will and will not accept, and choose an attach point that measures the question you are asking.",
      "sections": [
        {
          "h": "What eBPF actually is",
          "p": [
            "eBPF is a bytecode with a fixed register set and a bounded instruction budget that the kernel loads into a sandboxed virtual machine, or JIT-compiles to native code. The verifier is the security boundary: it explores every path, proves that memory accesses are within objects it can identify, rejects unbounded loops, and tracks pointer types through helper calls. A program that passes is guaranteed not to crash the kernel, which is what makes attaching it to arbitrary probes safe.",
            "Programs can only reach the outside world through maps and helpers. A map is a kernel data structure keyed from the program; helpers are the fixed API for reading time, probing memory, updating maps, or sending events. BTF (BPF Type Format) describes kernel types, which is what enables CO-RE: compile once against a type description, then relocate field offsets at load time on a different kernel."
          ],
          "list": [
            "Tracepoint: stable ABI in the kernel, ideal for production",
            "kprobe/kretprobe: any symbol, unstable signature, use for debugging",
            "fentry/fexit: BTF-based function tracing, faster and safer than kprobes",
            "XDP/tc: packet paths, where eBPF is a data plane rather than a tracer"
          ]
        },
        {
          "h": "Maps are the only interface",
          "p": [
            "A BPF_MAP_TYPE_HASH maps fixed-size keys to fixed-size values; an ARRAY is preallocated and index-addressed; a RINGBUF is the modern way to stream variable-length events to userspace with a single shared mapping. Map lookups happen per event, so putting a map lookup in the hottest path has a real cost, and the value size should be exactly what you need rather than a padded struct.",
            "Concurrency is explicit. Multiple CPUs can run the same program simultaneously, so read-modify-write on a map value needs a per-CPU map or a bpf_spin_lock inside the value. The verifier will not stop you from losing updates; it only stops you from corrupting memory. This is the most common logic bug in tracing code: a global counter in a hash map that loses increments under load."
          ]
        },
        {
          "h": "aya: eBPF without libbpf or a C toolchain",
          "p": [
            "Rust eBPF work splits into two crates and two targets. aya-ebpf provides the #![no_std] program side, compiled for bpfel-unknown-none with the eBPF target; aya provides the userspace loader, which parses the object, applies BTF relocations, loads programs, and attaches them. aya does not depend on libbpf or bcc, so a release build needs no C toolchain or kernel headers.",
            "The loader is ordinary Rust and belongs in the same process as your metrics or control plane. The program side must stay small: no allocation, a 512-byte stack, bounded loops, and only helper calls the verifier knows. That is why the idiomatic split is a thin eBPF program that copies a few fields into a ring buffer, and all the interpretation in userspace."
          ],
          "code": "// Userspace loader (aya 0.16). The object is built from a aya-ebpf crate\n// for the bpfel-unknown-none target and embedded at compile time.\nuse aya::programs::TracePoint;\nuse aya::Ebpf;\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    let mut ebpf = Ebpf::load(aya::include_bytes_aligned!(\"../../target/bpfel-unknown-none/release/execs\"))?;\n\n    let program: &mut TracePoint = ebpf\n        .program_mut(\"trace_exec\")\n        .ok_or(\"trace_exec not found in object\")?\n        .try_into()?;\n    program.load()?;                                  // verifier runs here\n    program.attach(\"sched\", \"sched_process_exec\")?;  // stable tracepoint ABI\n\n    println!(\"attached; Ctrl-C to stop\");\n    loop { std::thread::sleep(std::time::Duration::from_secs(1)); }\n}",
          "tip": "Attach to a tracepoint before reaching for a kprobe: it is a documented ABI with stable field offsets, while a kprobe's function signature can change in any kernel release."
        },
        {
          "h": "Overhead, safety, and when not to use eBPF",
          "p": [
            "Tracing costs what it observes. A tracepoint program that reads five fields and writes to a ring buffer is cheap; a kprobe on a hot function that calls bpf_probe_read_str can multiply the cost of that function. Always measure with the program detached versus attached, and add a filter in the program so the expensive path runs only for the process or cgroup you care about.",
            "Permissions are real: loading programs needs CAP_BPF (or CAP_SYS_ADMIN on older kernels), and unprivileged BPF is disabled by default on most distributions for good reason. Some container runtimes block bpf(2) with seccomp, and kernel lockdown disables it entirely. The operational rule: ship the loader with the exact capabilities it needs, keep the program pinned in /sys/fs/bpf so it survives a loader restart, and have a documented detach path."
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a userspace loader that loads an eBPF object, attaches trace_exec to sched/sched_process_exec, keeps the link alive, and detaches cleanly on Ctrl-C. Print the verifier's error verbatim if loading fails.",
        "starter": "use aya::programs::TracePoint;\nuse aya::Ebpf;\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    // 1. load the object embedded with include_bytes_aligned!\n    // 2. program_mut(\"trace_exec\") -> TracePoint\n    // 3. load() and attach(\"sched\", \"sched_process_exec\")\n    // 4. sleep until Ctrl-C, report errors with context\n    Ok(())\n}",
        "hint": "program.load() is where verifier errors appear; do not swallow them. Keep the TracePoint link variable alive for the lifetime of the loop, and run as root or with CAP_BPF. Point include_bytes_aligned! at the object path you actually build.",
        "solution": "use aya::programs::TracePoint;\nuse aya::Ebpf;\nuse std::time::Duration;\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    // include_bytes_aligned! expands to include_bytes!, so the path must be a literal.\n    let mut ebpf = Ebpf::load(aya::include_bytes_aligned!(\n        \"../../target/bpfel-unknown-none/release/execs\"\n    ))\n    .map_err(|e| format!(\"load object: {e}\"))?;\n\n    let program: &mut TracePoint = ebpf\n        .program_mut(\"trace_exec\")\n        .ok_or(\"program trace_exec missing from object\")?\n        .try_into()\n        .map_err(|e| format!(\"wrong program type: {e}\"))?;\n\n    program.load().map_err(|e| format!(\"verifier rejected the program: {e}\"))?;\n    let link = program\n        .attach(\"sched\", \"sched_process_exec\")\n        .map_err(|e| format!(\"attach sched/sched_process_exec: {e}\"))?;\n\n    println!(\"attached; pid {} sleeping\", std::process::id());\n    std::thread::sleep(Duration::from_secs(30));\n\n    drop(link); // detach explicitly before the maps are dropped\n    println!(\"detached\");\n    Ok(())\n}"
      },
      "production": [
        "Prefer tracepoints and fentry over kprobes for anything that must survive kernel upgrades.",
        "Use per-CPU maps or bpf_spin_lock for counters; plain hash-map increments lose updates.",
        "Measure the cost of the program attached versus detached on the same workload.",
        "Pin programs and maps in /sys/fs/bpf and document detach; an orphaned probe is an invisible tax."
      ],
      "crates": [
        "aya",
        "aya-ebpf",
        "aya-log"
      ],
      "pitfall": "A kprobe on a hot function that calls bpf_probe_read on every invocation: the verifier accepts it, the benchmark shows a 30 percent regression, and the probe is invisible in the application's own metrics.",
      "questions": [
        {
          "q": "What does the eBPF verifier guarantee?",
          "options": [
            "The program terminates within a fixed wall-clock time",
            "Every reachable path only accesses memory the verifier can bound and type-check",
            "The program cannot call kernel helpers",
            "The program runs at a higher priority than normal tasks"
          ],
          "answer": 1,
          "explain": "The verifier is a static safety proof over pointers, bounds and loops. It does not bound wall-clock time or guarantee progress under contention."
        },
        {
          "q": "Why can a hash-map counter lose increments under load?",
          "options": [
            "BPF maps are eventually consistent",
            "Multiple CPUs can run the program concurrently, so lookup-modify-update races",
            "The verifier removes increments it cannot prove are needed",
            "Hash maps are read-only from BPF programs"
          ],
          "answer": 1,
          "explain": "There is no implicit atomicity across a lookup and an update. Use a per-CPU map and sum in userspace, or a bpf_spin_lock inside the value."
        },
        {
          "q": "What does CO-RE (compile once, run everywhere) rely on?",
          "options": [
            "A stable kernel ABI for struct layouts across versions",
            "BTF type information plus load-time relocation of field offsets",
            "Compiling the program on the target host at load time",
            "Running the program in userspace against kernel memory"
          ],
          "answer": 1,
          "explain": "Struct layouts change between kernels. CO-RE records field access symbolically, and the loader relocates offsets using the target kernel's BTF."
        }
      ],
      "quickbytes": [
        "Verifier errors are the design feedback loop; read them literally.",
        "Tracepoints are ABI; kprobes are addresses. Prefer the former in production.",
        "Per-CPU maps for counters, ringbuf for events, arrays for preallocated config.",
        "Loading needs CAP_BPF; lockdown and seccomp can make it impossible by design."
      ],
      "github": [
        {
          "name": "aya - eBPF library written in Rust",
          "url": "https://github.com/aya-rs/aya"
        },
        {
          "name": "bcc - tracing toolkit and reference probes",
          "url": "https://github.com/iovisor/bcc"
        }
      ],
      "resources": [
        {
          "title": "BPF documentation index (kernel)",
          "url": "https://docs.kernel.org/bpf/index.html",
          "kind": "docs"
        },
        {
          "title": "bpf(2): map types, program types and syscall",
          "url": "https://man7.org/linux/man-pages/man2/bpf.2.html",
          "kind": "docs"
        },
        {
          "title": "aya API reference",
          "url": "https://docs.rs/aya/latest/aya/",
          "kind": "docs"
        },
        {
          "title": "aya source and examples",
          "url": "https://github.com/aya-rs/aya",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "os15",
      "n": 15,
      "title": "io_uring: shared rings and real async IO",
      "minutes": 95,
      "level": "industry",
      "goal": "Submit and complete IO through the shared rings, use the features that actually remove syscalls, and know the operational reasons io_uring is sometimes disabled.",
      "sections": [
        {
          "h": "Two rings in shared memory",
          "p": [
            "io_uring_setup creates a ring pair and returns a file descriptor. mmap maps the submission queue, the completion queue, the SQE array and (optionally) the CQEs into the process. Submitting work means writing an SQE into the array and advancing the tail; the kernel consumes from the head. Completion is the mirror image: the kernel advances the CQ tail, userspace reads entries and advances the head.",
            "Because the queues are shared memory, the normal case costs one io_uring_enter per batch instead of one syscall per operation. SQE and CQE are fixed-layout structs; user_data is the only field that survives unchanged from submission to completion, so it is your correlation id. A CQE's res is the equivalent syscall return, including negative errno - there is no errno for an async operation."
          ],
          "list": [
            "IOSQE_IO_LINK: the next SQE runs only if this one succeeds",
            "IORING_SETUP_SQPOLL: a kernel thread polls the SQ, removing io_uring_enter from the hot path",
            "Registered files and buffers: skip the per-request fd and buffer lookups",
            "Provided buffers and multishot recv: one submission, many completions"
          ]
        },
        {
          "h": "Registration is what makes it fast",
          "p": [
            "By default every SQE carries an fd and a userspace pointer, which the kernel must translate and pin per request. Registering files (IORING_REGISTER_FILES) and buffers (IORING_REGISTER_BUFFERS) does that work once; requests then reference indices. Provided buffer rings go further: userspace posts a pool of buffers, and a multishot receive consumes them as data arrives, posting a completion per buffer without a new submission.",
            "That is also where the correctness burden moves. A registered buffer must outlive its use, a fixed file index must be updated when descriptors are recycled, and a multishot request continues until it is cancelled or fails. The API is explicitly low-level: the io-uring crate exposes SQE construction, not a future. Safe wrappers exist, but they cannot make buffer lifetime automatic."
          ],
          "code": "use io_uring::{opcode, types, IoUring};\nuse std::os::fd::AsRawFd;\n\nfn main() -> std::io::Result<()> {\n    let mut ring = IoUring::new(8)?;\n    let file = std::fs::File::open(\"Cargo.toml\")?;\n    let mut buf = vec![0u8; 4096];\n\n    let read = opcode::Read::new(\n        types::Fd(file.as_raw_fd()),\n        buf.as_mut_ptr(),\n        buf.len() as u32,\n    )\n    .offset(0)\n    .build()\n    .user_data(0x42);\n\n    unsafe { ring.submission().push(&read).expect(\"SQ full\") };\n    let submitted = ring.submit_and_wait(1)?;\n    assert_eq!(submitted, 1);\n\n    let mut cq = ring.completion();\n    let cqe = cq.next().expect(\"one completion\");\n    let res = cqe.result();\n    assert_eq!(cqe.user_data(), 0x42);\n    if res < 0 {\n        return Err(std::io::Error::from_raw_os_error(-res));\n    }\n    println!(\"read {} bytes: {:?}\", res, String::from_utf8_lossy(&buf[..res as usize]));\n    Ok(())\n}",
          "tip": "Always handle a CQE result below zero by converting -res to an OS error; io_uring never sets errno, so a naive `if res < 0` that ignores the value loses the cause."
        },
        {
          "h": "What it costs, and where it does not fit",
          "p": [
            "The ring setup costs a few pages and one fd; per-operation overhead beats epoll plus read for high-IOPS workloads, especially with SQPOLL. But for a handful of operations per second the difference is noise, and the complexity is not: you now own buffer lifetimes, cancellation, and a completion loop that must not block indefinitely without a timeout.",
            "Kernel support matters. Multishot accept and provided buffers arrived later than the base API, so a library must probe features (IORING_REGISTER_PROBE) rather than assume. Some container runtimes block io_uring_setup with seccomp, and several distributions disabled unprivileged io_uring after a run of kernel vulnerabilities; a design that requires it must detect ENOSYS or EPERM and fall back to epoll or blocking IO.",
            "The io-wq worker pool is the other operational surprise: operations that cannot complete inline are handed to kernel worker threads. They are accounted to the submitting task's cgroup, but they are not the same tasks - scheduling attributes and CPU affinity can differ, and a per-task rlimit is not what the worker runs under. A workload under a cgroup CPU limit can therefore see its async work executed with different scheduling characteristics than its synchronous work."
          ]
        },
        {
          "h": "Testing an async IO path",
          "p": [
            "Test the completion path, not just the submission. Submit more operations than the ring holds and verify that EAGAIN or a full SQ is handled; cancel an in-flight request and verify exactly one CQE with -ECANCELED; close the ring fd while requests are outstanding and verify the kernel drains or cancels them as documented. These are the cases where naive wrappers leak memory or hang.",
            "For performance, measure with the same queue depth the application uses. A benchmark at depth 1 measures syscall overhead; at depth 128 it measures the device. Count io_uring_enter calls per operation to prove batching is happening, and check that registered buffers are actually used - a fallback to unregistered requests can silently erase the gain you designed for."
          ]
        }
      ],
      "exercise": {
        "prompt": "Submit two reads of the same file at different offsets in one batch, then match each completion to its request by user_data and print offset 0 and offset 1024 contents. Assert that the number of submitted entries equals the number completed.",
        "starter": "use io_uring::{opcode, types, IoUring};\nuse std::os::fd::AsRawFd;\n\nfn main() -> std::io::Result<()> {\n    // 1. open a file with at least 2 KiB\n    // 2. build two Read SQEs, user_data 0 and 1, offsets 0 and 1024\n    // 3. push both, submit_and_wait(2)\n    // 4. drain completions and match user_data\n    Ok(())\n}",
        "hint": "Each buffer must stay alive until its completion arrives. Use two separate Vec<u8> buffers, and read both CQEs before inspecting the data. submit_and_wait(2) returns the number submitted, not completed.",
        "solution": "use io_uring::{opcode, types, IoUring};\nuse std::os::fd::AsRawFd;\n\nfn main() -> std::io::Result<()> {\n    let path = std::env::temp_dir().join(\"uring-ex.bin\");\n    let data: Vec<u8> = (0..4096u32).map(|i| (i % 251) as u8).collect();\n    std::fs::write(&path, &data)?;\n\n    let file = std::fs::File::open(&path)?;\n    let mut ring = IoUring::new(8)?;\n    let mut a = vec![0u8; 512];\n    let mut b = vec![0u8; 512];\n\n    let sqe_a = opcode::Read::new(types::Fd(file.as_raw_fd()), a.as_mut_ptr(), 512)\n        .offset(0).build().user_data(0);\n    let sqe_b = opcode::Read::new(types::Fd(file.as_raw_fd()), b.as_mut_ptr(), 512)\n        .offset(1024).build().user_data(1);\n\n    {\n        let mut sq = ring.submission();\n        unsafe {\n            sq.push(&sqe_a).expect(\"SQ full\");\n            sq.push(&sqe_b).expect(\"SQ full\");\n        }\n    }\n\n    let submitted = ring.submit_and_wait(2)?;\n    println!(\"submitted {submitted}\");\n\n    let mut done = 0;\n    let mut cq = ring.completion();\n    while done < 2 {\n        if let Some(cqe) = cq.next() {\n            let res = cqe.result();\n            let id = cqe.user_data();\n            if res < 0 {\n                return Err(std::io::Error::from_raw_os_error(-res));\n            }\n            let bytes = if id == 0 { &a } else { &b };\n            println!(\"user_data={id} res={res} first={:?}\", bytes[0]);\n            done += 1;\n        }\n    }\n\n    assert_eq!(a[0], data[0]);\n    assert_eq!(b[0], data[1024]);\n    println!(\"both buffers match the file\");\n    Ok(())\n}"
      },
      "production": [
        "Probe io_uring features at startup instead of assuming; fall back to epoll on ENOSYS or EPERM.",
        "Keep registered buffers and fixed file tables in sync with your fd lifecycle.",
        "Handle -ECANCELED and partial completions explicitly; they are normal, not exceptional.",
        "Measure io_uring_enter calls per operation and confirm registered buffers are in use before claiming a win."
      ],
      "crates": [
        "io-uring",
        "tokio",
        "libc"
      ],
      "pitfall": "Submitting a request that points at a stack buffer or a Vec that is reallocated before completion: the kernel writes into freed memory, producing silent corruption rather than an error.",
      "questions": [
        {
          "q": "What carries a request's identity from submission to completion?",
          "options": [
            "The SQE index, which the kernel preserves",
            "user_data, copied unchanged from SQE to CQE",
            "The file descriptor in the SQE",
            "The CQE flags field"
          ],
          "answer": 1,
          "explain": "Completions can arrive out of order, so the index is not stable. user_data is the only opaque field the kernel echoes back."
        },
        {
          "q": "Why register buffers and files?",
          "options": [
            "To make the ring safe to share between processes",
            "To pay fd lookup and page pinning once instead of per request",
            "To encrypt buffers while they are in the kernel",
            "To enable SQPOLL, which requires registration"
          ],
          "answer": 1,
          "explain": "Registration pins memory and maps descriptors up front. Requests then reference indices, removing per-operation translation and refcount work."
        },
        {
          "q": "What does an io_uring completion with res = -13 mean?",
          "options": [
            "13 bytes were transferred",
            "The request failed with EACCES; errno is also set",
            "The request failed with EACCES; errno is not set",
            "The request is still pending and must be resubmitted"
          ],
          "answer": 2,
          "explain": "res holds the equivalent syscall return, so negative values are -errno. There is no errno for async completions; the value is the only error channel."
        }
      ],
      "quickbytes": [
        "res < 0 means -errno; convert with io::Error::from_raw_os_error(-res).",
        "user_data is the correlation id; completions are unordered.",
        "SQPOLL removes io_uring_enter, not the need to check completions.",
        "Some runtimes seccomp-block io_uring_setup; always ship a fallback path."
      ],
      "github": [
        {
          "name": "io-uring - Rust bindings maintained under tokio-rs",
          "url": "https://github.com/tokio-rs/io-uring"
        },
        {
          "name": "liburing - reference C library and test suite",
          "url": "https://github.com/axboe/liburing"
        }
      ],
      "resources": [
        {
          "title": "io_uring(7): rings, SQEs, CQEs and ordering",
          "url": "https://man7.org/linux/man-pages/man7/io_uring.7.html",
          "kind": "docs"
        },
        {
          "title": "io_uring_setup(2): parameters and ring layout",
          "url": "https://man7.org/linux/man-pages/man2/io_uring_setup.2.html",
          "kind": "docs"
        },
        {
          "title": "io-uring crate API reference",
          "url": "https://docs.rs/io-uring/latest/io_uring/",
          "kind": "docs"
        },
        {
          "title": "liburing source: feature probing and examples",
          "url": "https://github.com/axboe/liburing",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "os16",
      "n": 16,
      "title": "Real-time scheduling: determinism, not speed",
      "minutes": 90,
      "level": "industry",
      "goal": "Configure a real-time thread correctly, remove the unbounded operations around it, and measure wakeup jitter instead of average latency.",
      "sections": [
        {
          "h": "The requirement is a bound, not a mean",
          "p": [
            "A real-time system is one where a late result is a wrong result. That makes the average irrelevant: a thread that wakes in 80 microseconds on average and 40 milliseconds once an hour fails a 1-millisecond deadline. The metric is the maximum lateness over a long run, and the engineering is about removing every operation with an unbounded worst case from the path.",
            "Linux offers three RT policies. SCHED_FIFO runs until it blocks or a higher-priority RT thread becomes runnable; SCHED_RR adds a timeslice among equal priorities; SCHED_DEADLINE admits a sporadic task with runtime, deadline and period and rejects the admission if the total utilisation is infeasible. Priorities are 1-99 and always outrank SCHED_OTHER, which is why an RT thread that spins without blocking can lock a core forever."
          ],
          "list": [
            "SCHED_FIFO: no timeslice, priority 1-99, must block voluntarily",
            "SCHED_RR: round-robin among equal RT priorities",
            "SCHED_DEADLINE: runtime <= deadline <= period, admission-controlled",
            "sched_rt_runtime_us defaults to 950000 of 1000000, reserving 5 percent for non-RT work"
          ]
        },
        {
          "h": "Page faults and allocations are the enemies",
          "p": [
            "A minor fault takes microseconds and can take much longer under memory pressure; a major fault takes milliseconds. Either one inside a 500-microsecond control loop is a missed deadline. mlockall(MCL_CURRENT | MCL_FUTURE) pins the address space, but the stack and the heap must be touched before the loop starts: mlock prevents eviction, it does not prefault pages you have never written.",
            "Allocation is the other unbounded operation. malloc may take a lock, may call mmap, may trigger reclaim; even a free can return memory to the kernel and cause a future fault. Real-time code preallocates every buffer, uses fixed-size pools, and avoids formatting, logging and dynamic dispatch on the hot path. If a library allocates internally, treat it as unsuitable for the loop rather than hoping."
          ],
          "code": "fn main() {\n    unsafe {\n        let max = libc::sched_get_priority_max(libc::SCHED_FIFO);\n        let param = libc::sched_param { sched_priority: max.min(50) };\n\n        if libc::sched_setscheduler(0, libc::SCHED_FIFO, &param) != 0 {\n            eprintln!(\"need CAP_SYS_NICE or RLIMIT_RTPRIO > 0: {}\", std::io::Error::last_os_error());\n            return;\n        }\n\n        // Pin code, stack and heap; then touch what the loop will use.\n        libc::mlockall(libc::MCL_CURRENT | libc::MCL_FUTURE);\n\n        let runtime = std::fs::read_to_string(\"/proc/sys/kernel/sched_rt_runtime_us\").unwrap_or_default();\n        println!(\"SCHED_FIFO prio {} (max {}), rt_runtime_us={}\", param.sched_priority, max, runtime.trim());\n    }\n}",
          "tip": "An RT thread that only sleeps is harmless; one that busy-waits at priority 99 starves the RCU and watchdog threads. Always give it a blocking wait or a bounded loop with sched_yield."
        },
        {
          "h": "Priority inversion needs inheritance, not hope",
          "p": [
            "The canonical failure: a high-priority RT thread waits on a mutex held by a low-priority thread, which is preempted by a medium-priority thread that is not involved at all. The RT thread now waits for the medium one. A priority-inheriting mutex (PTHREAD_PRIO_INHERIT, or an rt-mutex in the kernel) raises the holder to the waiter's priority for the duration of the critical section.",
            "Inheritance is a mitigation, not a design. It does not help if the holder blocks on IO, allocates, or faults while holding the lock. The robust design keeps the lock scope to a few instructions, moves copies outside it, and prefers lock-free single-producer/single-consumer rings between the RT thread and everything else. Where you must share, use a PI mutex deliberately, not as a default."
          ]
        },
        {
          "h": "Measure the tail with cyclictest or your own harness",
          "p": [
            "The standard tool is cyclictest: it arms an absolute timer, sleeps, and records the difference between the intended and actual wakeup. Report the maximum over minutes, not the average over seconds, and run it under the same load and power state as production. A laptop idle at 2 GHz and a server under memory pressure give answers that differ by two orders of magnitude.",
            "Two kernel settings change the result more than any application change. CONFIG_PREEMPT_RT (mainline since 6.12) turns most spinlocks into sleeping locks and threaded interrupts, collapsing long non-preemptible sections; CPU isolation (isolcpus, nohz_full, rcu_nocbs) removes the scheduler tick and RCU callbacks from the cores you reserved. Both are deployment decisions, not code changes, so they belong in the runbook next to the latency budget."
          ]
        }
      ],
      "exercise": {
        "prompt": "Set SCHED_FIFO priority 10, lock memory, then measure wakeup lateness over 1,000 one-millisecond absolute sleeps. Report the worst case in microseconds and the number of overruns above 200 microseconds.",
        "starter": "fn main() {\n    // 1. sched_setscheduler(SCHED_FIFO, prio 10), ignore failure with a message\n    // 2. mlockall(MCL_CURRENT | MCL_FUTURE)\n    // 3. loop 1000x: advance an absolute timespec by 1ms, clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME)\n    // 4. read CLOCK_MONOTONIC after each wake, track max lateness and overruns\n}",
        "hint": "clock_nanosleep returns the error number directly, not -1 with errno. Keep tv_nsec in range by normalizing, and compare against the intended time, not against the time before sleeping.",
        "solution": "fn main() {\n    unsafe {\n        let param = libc::sched_param { sched_priority: 10 };\n        if libc::sched_setscheduler(0, libc::SCHED_FIFO, &param) != 0 {\n            eprintln!(\"not real-time: {}\", std::io::Error::last_os_error());\n        }\n        libc::mlockall(libc::MCL_CURRENT | libc::MCL_FUTURE);\n    }\n\n    let period_ns: i64 = 1_000_000;\n    let mut next = libc::timespec { tv_sec: 0, tv_nsec: 0 };\n    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut next) };\n\n    let mut worst: i64 = 0;\n    let mut overruns = 0;\n    for _ in 0..1000 {\n        next.tv_nsec += period_ns;\n        while next.tv_nsec >= 1_000_000_000 {\n            next.tv_nsec -= 1_000_000_000;\n            next.tv_sec += 1;\n        }\n        let rc = unsafe {\n            libc::clock_nanosleep(libc::CLOCK_MONOTONIC, libc::TIMER_ABSTIME, &next, std::ptr::null_mut())\n        };\n        if rc != 0 {\n            eprintln!(\"clock_nanosleep error {rc}\");\n            break;\n        }\n\n        let mut now = libc::timespec { tv_sec: 0, tv_nsec: 0 };\n        unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut now) };\n        let late = (now.tv_sec - next.tv_sec) * 1_000_000_000 + (now.tv_nsec - next.tv_nsec);\n        worst = worst.max(late);\n        if late > 200_000 { overruns += 1; }\n    }\n\n    println!(\"worst lateness: {} us, overruns >200us: {}\", worst / 1000, overruns);\n}"
      },
      "production": [
        "Publish a latency budget with a maximum, not an average, and measure it under production load and power state.",
        "Prefault and mlock the RT thread's stack, heap and code before the loop; verify with /proc/PID/status VmLck.",
        "Record sched_rt_runtime_us and the preemption model in the host baseline; they change the achievable bound.",
        "Keep RT threads off shared cores and out of the memory-reclaim path; isolation is a deployment property."
      ],
      "crates": [
        "libc",
        "nix",
        "crossbeam"
      ],
      "pitfall": "Holding a PI mutex across a page fault or a blocking read: inheritance raises the holder's priority but cannot shorten an unbounded wait, so the deadline is still missed.",
      "questions": [
        {
          "q": "What does sched_rt_runtime_us = 950000 with period 1000000 enforce?",
          "options": [
            "Each RT thread may run 950ms per second",
            "All RT tasks together may consume 95 percent of each CPU second, leaving 5 percent for non-RT work",
            "RT threads are throttled to 95 percent of their measured average",
            "The scheduler runs RT tasks only 950 times per second"
          ],
          "answer": 1,
          "explain": "It is a global bandwidth cap per period across all RT and deadline tasks on a CPU, the safety valve that keeps a runaway RT thread from locking the machine."
        },
        {
          "q": "Why is mlockall not enough to make a loop deterministic?",
          "options": [
            "It only locks the first page of each mapping",
            "It prevents eviction but does not prefault untouched pages, which still fault on first access",
            "It requires CAP_SYS_ADMIN and silently fails otherwise",
            "It disables transparent huge pages, causing more faults"
          ],
          "answer": 1,
          "explain": "mlock pins what is mapped. Pages you have never touched are still demand-zero, so the first write in the loop takes a fault. Touch every buffer first."
        },
        {
          "q": "A high-priority RT thread blocks on a mutex held by a low-priority thread, which is then preempted by an unrelated medium thread. What fixes this?",
          "options": [
            "Raising the RT thread's priority above 99",
            "A priority-inheriting mutex that raises the holder while it is waited on",
            "Disabling the scheduler tick on that CPU",
            "Making the RT thread busy-wait instead of blocking"
          ],
          "answer": 1,
          "explain": "Inheritance propagates the waiter's priority to the holder so the medium thread cannot preempt it. Busy-waiting would burn the CPU and still not release the lock."
        }
      ],
      "quickbytes": [
        "Measure maximum lateness over minutes, never average latency over seconds.",
        "mlockall pins pages; prefaulting makes them resident. Do both, before the loop.",
        "SCHED_DEADLINE rejects admission when total utilisation is infeasible - EBUSY is a real answer.",
        "check /proc/sys/kernel/sched_rt_runtime_us before blaming the application for jitter."
      ],
      "github": [
        {
          "name": "Linux kernel scheduler and PREEMPT_RT sources",
          "url": "https://github.com/torvalds/linux"
        },
        {
          "name": "nix - sched module for policy and affinity",
          "url": "https://github.com/nix-rust/nix"
        }
      ],
      "resources": [
        {
          "title": "sched(7): RT policies, RLIMIT_RTPRIO, RT throttling",
          "url": "https://man7.org/linux/man-pages/man7/sched.7.html",
          "kind": "docs"
        },
        {
          "title": "SCHED_DEADLINE documentation (kernel)",
          "url": "https://docs.kernel.org/scheduler/sched-deadline.html",
          "kind": "docs"
        },
        {
          "title": "getrlimit(2): RLIMIT_RTPRIO and RLIMIT_RTTIME",
          "url": "https://man7.org/linux/man-pages/man2/getrlimit.2.html",
          "kind": "docs"
        },
        {
          "title": "Linux kernel source: kernel/sched/rt.c and deadline.c",
          "url": "https://github.com/torvalds/linux",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "os17",
      "n": 17,
      "title": "Signals and process control: exit codes and orphans",
      "minutes": 85,
      "level": "advanced",
      "goal": "Turn signals into a file descriptor instead of a handler, reap children correctly, and propagate termination and exit status without inventing conventions.",
      "sections": [
        {
          "h": "Signals are per-thread masks plus per-process dispositions",
          "p": [
            "A signal has a disposition (default, ignore, handler) shared by the process, a mask that is per-thread, and a pending set split between the thread and the process. A process-directed signal is delivered to any thread that does not block it; a thread-directed signal - SIGSEGV, SIGFPE, or one sent with tgkill - goes to that thread. That asymmetry explains why blocking SIGTERM in every thread leaves it pending forever.",
            "Delivery builds a signal frame on the user stack and returns through a trampoline that calls rt_sigreturn. SA_RESTART asks the kernel to restart interruptible syscalls automatically, which hides EINTR for read, write, wait and nanosleep - but not for poll, select, epoll_wait or semop, which always return EINTR. A handler that assumes restart semantics everywhere will eventually see a spurious failure."
          ],
          "list": [
            "SIGKILL and SIGSTOP cannot be caught, blocked or ignored",
            "SIGCHLD is not queued: coalesced notifications can hide child exits",
            "SA_SIGINFO gives si_code and si_addr; SA_RESTART changes syscall behaviour",
            "The default action for SIGTERM is terminate; for SIGCHLD it is ignore"
          ]
        },
        {
          "h": "Wait status is a packed word, not an integer",
          "p": [
            "waitpid returns a status that encodes normal exit, signal death, stop and continue. WIFEXITED plus WEXITSTATUS, WIFSIGNALED plus WTERMSIG, WIFSTOPPED plus WSTOPSIG. The shell's 128+signal convention is a shell convention: the kernel reports the signal number, and a program that returns 143 to indicate SIGTERM is mimicking what a shell would compute, not what waitpid gives you.",
            "Orphans are re-parented to PID 1 of their PID namespace, or to the nearest subreaper marked with PR_SET_CHILD_SUBREAPER. That is the mechanism container runtimes use so that a shim can reap grandchildren whose parent already exited. Without a reaper, zombies persist until the namespace dies, and because each one holds a PID, a long-lived container can exhaust its PID cgroup limit."
          ]
        },
        {
          "h": "signalfd replaces handlers with readiness",
          "p": [
            "signalfd turns a blocked signal set into a readable file descriptor, so signals join the same event loop as sockets and timers. The pattern is: block the signals in every thread, create the fd, then read signalfd_siginfo records. No async-signal-safety rules apply because no handler runs at an arbitrary instruction; the loop handles signals at a safe point.",
            "Block before creating threads, or a signal can be delivered to a thread that has not blocked it yet. Combine signalfd with pidfd or waitpid in the same loop for full process supervision: SIGCHLD tells you something exited, and waitpid(-1, WNOHANG) tells you which. Always loop waitpid until it returns 0 or -1, because SIGCHLD is coalesced and one notification can cover several exits."
          ],
          "code": "use std::mem::MaybeUninit;\n\nfn main() -> std::io::Result<()> {\n    unsafe {\n        let mut mask: libc::sigset_t = std::mem::zeroed();\n        libc::sigemptyset(&mut mask);\n        libc::sigaddset(&mut mask, libc::SIGCHLD);\n        libc::sigaddset(&mut mask, libc::SIGTERM);\n        libc::sigprocmask(libc::SIG_BLOCK, &mask, std::ptr::null_mut());\n\n        let fd = libc::signalfd(-1, &mask, libc::SFD_CLOEXEC);\n        assert!(fd >= 0, \"signalfd: {}\", std::io::Error::last_os_error());\n\n        let mut info: libc::signalfd_siginfo = MaybeUninit::zeroed().assume_init();\n        loop {\n            let n = libc::read(fd, (&mut info as *mut libc::signalfd_siginfo).cast(),\n                std::mem::size_of::<libc::signalfd_siginfo>());\n            if n < 0 {\n                let e = std::io::Error::last_os_error();\n                if e.raw_os_error() == Some(libc::EINTR) { continue; }\n                return Err(e);\n            }\n\n            match info.ssi_signo as i32 {\n                libc::SIGCHLD => {\n                    let mut status = 0;\n                    while libc::waitpid(-1, &mut status, libc::WNOHANG) > 0 {\n                        if libc::WIFEXITED(status) {\n                            println!(\"child exited {}\", libc::WEXITSTATUS(status));\n                        } else if libc::WIFSIGNALED(status) {\n                            println!(\"child killed by {}\", libc::WTERMSIG(status));\n                        }\n                    }\n                }\n                libc::SIGTERM => { println!(\"shutting down\"); break; }\n                _ => {}\n            }\n        }\n        libc::close(fd);\n    }\n    Ok(())\n}",
          "tip": "Block signals before spawning threads. A mask applied after the pool exists leaves unblocked threads that can steal the signal and run a handler you thought was gone."
        },
        {
          "h": "Forwarding termination without losing the reason",
          "p": [
            "A supervisor must distinguish three outcomes: the child exited with a code, the child died from a signal, or the supervisor itself was asked to stop. On SIGTERM, forward the signal to the child's process group, wait for a grace period, then SIGKILL and reap. Report the child's status faithfully; do not convert a signal death into exit code 1, because the caller cannot then tell a crash from a clean failure.",
            "PR_SET_PDEATHSIG is the kernel-side backstop: set it in the child before exec, and the child receives the chosen signal when its parent dies. It is not a substitute for supervision, because it fires on the parent thread's death, not on a graceful shutdown request, and it is cleared by exec of a setuid binary. Use it to prevent orphans, not to implement shutdown."
          ]
        }
      ],
      "exercise": {
        "prompt": "Spawn /bin/sh -c 'kill -TERM $$', reap it, and print the exact exit status the shell would report (128 plus the signal). Then add a signalfd that forwards SIGTERM to a long-running child and exits only after reaping it.",
        "starter": "use std::process::Command;\n\nfn main() -> std::io::Result<()> {\n    // 1. spawn a child that kills itself with SIGTERM\n    // 2. decode the status with WIFEXITED/WIFSIGNALED\n    // 3. print 128 + signal\n    // 4. (second half) signalfd SIGTERM, forward to child, reap, exit\n    Ok(())\n}",
        "hint": "std::process::ExitStatus exposes signal() on Unix; use std::os::unix::process::ExitStatusExt. A child killed by SIGTERM has code() == None and signal() == Some(15), so 128+15 is 143.",
        "solution": "use std::os::unix::process::ExitStatusExt;\nuse std::process::Command;\n\nfn main() -> std::io::Result<()> {\n    let mut child = Command::new(\"/bin/sh\")\n        .arg(\"-c\")\n        .arg(\"kill -TERM $$\")\n        .spawn()?;\n    let status = child.wait()?;\n\n    let reported = match (status.code(), status.signal()) {\n        (Some(code), _) => code,\n        (None, Some(sig)) => 128 + sig,\n        _ => 1,\n    };\n    println!(\"raw status: {status:?}\");\n    println!(\"shell-style: {reported}\");\n    assert_eq!(status.signal(), Some(libc::SIGTERM));\n    assert_eq!(reported, 143);\n\n    // Forwarding: start a child that ignores nothing, then signal it.\n    let mut long = Command::new(\"/bin/sleep\").arg(\"30\").spawn()?;\n    unsafe { libc::kill(long.id() as i32, libc::SIGTERM) };\n    let forwarded = long.wait()?;\n    println!(\"forwarded child: {:?} -> {}\", forwarded.signal(), 128 + forwarded.signal().unwrap_or(0));\n    Ok(())\n}"
      },
      "production": [
        "Report signal deaths as 128+signal so callers can distinguish a crash from a handled failure.",
        "Loop waitpid until it returns 0 or -1; SIGCHLD is coalesced and one signal can cover several exits.",
        "Block signals before creating threads, then serve them from signalfd or a self-pipe.",
        "Set PR_SET_PDEATHSIG in children and mark a subreaper in supervisors so grandchildren are reaped."
      ],
      "crates": [
        "libc",
        "nix",
        "signal-hook"
      ],
      "pitfall": "Calling waitpid once per SIGCHLD: when two children exit between signals, the second zombie is never reaped and the container slowly exhausts its PID limit.",
      "questions": [
        {
          "q": "What does a shell's 143 mean?",
          "options": [
            "The process exited normally with code 143",
            "The process was killed by signal 15 (SIGTERM), computed as 128+15",
            "The process was killed by signal 143",
            "waitpid reported an unknown status"
          ],
          "answer": 1,
          "explain": "The kernel reports the signal number 15. Shells add 128 so signal deaths do not collide with exit codes, and 143 is that convention, not a kernel value."
        },
        {
          "q": "Which call is never restarted by SA_RESTART?",
          "options": [
            "read on a pipe",
            "waitpid",
            "nanosleep",
            "epoll_wait"
          ],
          "answer": 3,
          "explain": "epoll_wait, poll and select always return EINTR when a signal arrives. read, write, wait and sleep are restarted when SA_RESTART is set."
        },
        {
          "q": "Why is SIGCHLD unsuitable as an exact child-exit counter?",
          "options": [
            "It is delivered only to the thread that forked the child",
            "Standard signals are not queued, so multiple exits can coalesce into one notification",
            "It is blocked by default in containers",
            "It carries no information about which child exited"
          ],
          "answer": 1,
          "explain": "Multiple SIGCHLDs collapse into one pending signal. The authoritative record is waitpid, which is why the handler must drain it in a loop."
        }
      ],
      "quickbytes": [
        "Block signals before spawning threads; masks are per-thread, dispositions per-process.",
        "WIFSIGNALED + WTERMSIG is the kernel truth; 128+signal is the shell convention built on it.",
        "signalfd moves signal handling into the event loop and out of async-signal context.",
        "PR_SET_PDEATHSIG prevents orphans; it does not implement graceful shutdown."
      ],
      "github": [
        {
          "name": "nix - signal and wait bindings",
          "url": "https://github.com/nix-rust/nix"
        },
        {
          "name": "signal-hook - iterator-based signal handling",
          "url": "https://github.com/vorner/signal-hook"
        }
      ],
      "resources": [
        {
          "title": "signal(7): semantics, dispositions and delivery",
          "url": "https://man7.org/linux/man-pages/man7/signal.7.html",
          "kind": "docs"
        },
        {
          "title": "signalfd(2): signals as a file descriptor",
          "url": "https://man7.org/linux/man-pages/man2/signalfd.2.html",
          "kind": "docs"
        },
        {
          "title": "wait(2): status encoding and orphan reaping",
          "url": "https://man7.org/linux/man-pages/man2/wait.2.html",
          "kind": "docs"
        },
        {
          "title": "nix source: signal and process modules",
          "url": "https://github.com/nix-rust/nix",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "os18",
      "n": 18,
      "title": "Resource limits and accounting: rlimits to cgroups",
      "minutes": 80,
      "level": "advanced",
      "goal": "Apply the right ceiling at the right layer, predict the errno or signal each ceiling produces, and read the accounting that proves which limit was hit.",
      "sections": [
        {
          "h": "rlimits are per-process ceilings inherited by children",
          "p": [
            "setrlimit sets a soft limit (the value enforced) and a hard limit (the ceiling a process may raise the soft limit to). An unprivileged process may lower the hard limit but never raise it, and the change is permanent for that process. Limits are inherited across fork and preserved across exec, so a supervisor can set them once for everything it starts.",
            "Each limit fails differently. RLIMIT_NOFILE makes open return EMFILE once the descriptor table is full; RLIMIT_NPROC makes fork or clone return EAGAIN, and it counts processes per real UID across the whole system, not per process tree - which is why a service can hit it because an unrelated process of the same user is busy forking. RLIMIT_AS bounds address space, so mmap fails with ENOMEM; RLIMIT_CPU sends SIGXCPU at the soft limit and SIGKILL at the hard one; RLIMIT_CORE sizes the core dump."
          ],
          "list": [
            "RLIMIT_NOFILE: EMFILE; also raises the cost of every select/poll set",
            "RLIMIT_NPROC: EAGAIN at fork, counted per real UID system-wide",
            "RLIMIT_AS: ENOMEM from mmap, often far above actual RSS",
            "RLIMIT_CPU: SIGXCPU then SIGKILL; RLIMIT_RTTIME: SIGXCPU for RT overruns"
          ]
        },
        {
          "h": "cgroups measure and enforce, per group",
          "p": [
            "rlimits are blunt and per-process; cgroup v2 controls are hierarchical and per-workload. memory.current is the charge, memory.max is the wall, memory.high is the throttle, memory.events counts max, high and oom occurrences, and memory.stat breaks the charge into anon, file, kernel and pagetables. pids.current and pids.events do the same for task counts, and cpu.stat reports usage_usec, nr_throttled and throttled_usec.",
            "The accounting is hierarchical: memory.events at a parent includes descendants, while memory.events.local excludes them. That distinction matters for alerting, because a parent's max counter can be triggered by any child and tells you nothing about which one. Alert on the leaf group that owns the workload, and use the parent only for aggregate headroom."
          ],
          "code": "use std::fs;\n\nfn main() -> std::io::Result<()> {\n    unsafe {\n        let lim = libc::rlimit { rlim_cur: 256, rlim_max: 256 };\n        assert_eq!(libc::setrlimit(libc::RLIMIT_NOFILE, &lim), 0,\n            \"setrlimit: {}\", std::io::Error::last_os_error());\n    }\n\n    for line in fs::read_to_string(\"/proc/self/limits\")?.lines() {\n        if line.starts_with(\"Max open files\") || line.starts_with(\"Max processes\") {\n            println!(\"{line}\");\n        }\n    }\n\n    let cgroup = fs::read_to_string(\"/proc/self/cgroup\")?;\n    println!(\"cgroup: {}\", cgroup.trim());\n    if let Some(path) = cgroup.trim().strip_prefix(\"0::\") {\n        let base = format!(\"/sys/fs/cgroup{path}\");\n        for f in [\"memory.current\", \"memory.max\", \"memory.events\", \"pids.current\", \"cpu.stat\"] {\n            if let Ok(v) = fs::read_to_string(format!(\"{base}/{f}\")) {\n                println!(\"--- {f}\\n{}\", v.trim());\n            }\n        }\n    }\n    Ok(())\n}",
          "tip": "Read limits from the process itself, not from /etc/security/limits.conf: systemd units, containers and shells each apply their own, and the file only describes one path to the value."
        },
        {
          "h": "Who gets killed when the wall is hit",
          "p": [
            "The cgroup OOM killer selects a victim inside the cgroup that hit memory.max, scored by oom_score plus oom_score_adj, and kills it. memory.oom.group makes the whole cgroup die together, which is what a runtime wants: a half-dead JVM with a surviving sidecar is worse than a clean restart. Kernel OOM, by contrast, scans the whole machine and can pick any process - the failure mode you avoid by giving every workload a cgroup limit.",
            "Accounting is not instantaneous. A page is charged when it is faulted in, can be reclaimed lazily, and the kernel may overshoot memory.max briefly. memory.peak records the high-water mark, which is the number to size requests from. A workload whose memory.current sits at 95 percent of max with rising workingset_refault is thrashing inside its limit, not merely close to it."
          ]
        },
        {
          "h": "Limits interact, so test the combination",
          "p": [
            "A JVM sized from the host's total memory, a cgroup memory.max smaller than the heap, and a container with 200 pids is three limits that each look sane and together guarantee an OOM kill. Read the limit from inside the process - /sys/fs/cgroup/memory.max and cpu.max - and configure heaps, thread pools and connection pools from that, not from sysconf.",
            "The test that proves the configuration is the one that provokes each ceiling: open until EMFILE, fork until EAGAIN, allocate until memory.events shows oom, burn CPU until nr_throttled rises. Record the observed errno or signal next to the limit in the runbook. A limit that has never been reached in a test is an assumption, and the first time it is reached will be under production load."
          ]
        }
      ],
      "exercise": {
        "prompt": "Lower RLIMIT_NOFILE to 64, open files until the call fails, print the errno and the number opened, then restore nothing and explain why the change cannot be undone. Verify the new limit from /proc/self/limits.",
        "starter": "use std::fs::File;\n\nfn main() -> std::io::Result<()> {\n    // 1. setrlimit RLIMIT_NOFILE soft=hard=64\n    // 2. open /dev/null in a loop, keeping the handles alive in a Vec\n    // 3. on error print errno and count\n    // 4. print the Max open files line from /proc/self/limits\n    Ok(())\n}",
        "hint": "Opening /dev/null costs a descriptor per iteration; keep them in a Vec so they are not dropped. The failure is EMFILE (per-process), not ENFILE (system-wide). Setting hard to 64 makes the change irreversible for this process.",
        "solution": "use std::fs::{self, File};\n\nfn main() -> std::io::Result<()> {\n    let lim = libc::rlimit { rlim_cur: 64, rlim_max: 64 };\n    assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &lim) }, 0);\n\n    let mut held = Vec::new();\n    loop {\n        match File::open(\"/dev/null\") {\n            Ok(f) => held.push(f),\n            Err(e) => {\n                println!(\"failed after {} descriptors: {e} (errno {:?})\", held.len(), e.raw_os_error());\n                assert_eq!(e.raw_os_error(), Some(libc::EMFILE));\n                break;\n            }\n        }\n    }\n\n    for line in fs::read_to_string(\"/proc/self/limits\")?.lines() {\n        if line.starts_with(\"Max open files\") {\n            println!(\"{line}\");\n        }\n    }\n    println!(\"held {} descriptors; hard limit 64 cannot be raised again\", held.len());\n    drop(held);\n    Ok(())\n}"
      },
      "production": [
        "Set RLIMIT_NOFILE and the cgroup pids.max from measured concurrency, and test the failure path for each.",
        "Size heaps and thread pools from the cgroup limits read at runtime, not from host memory.",
        "Enable memory.oom.group for workload cgroups so a partial kill cannot leave a half-dead service.",
        "Alert on the leaf group's memory.events and cpu.stat nr_throttled; parent counters hide which child is responsible."
      ],
      "crates": [
        "libc",
        "nix",
        "rustix"
      ],
      "pitfall": "Setting RLIMIT_NPROC to bound one service: the limit is counted per real UID across the whole host, so an unrelated process of the same user can exhaust it and make your service's fork fail with EAGAIN.",
      "questions": [
        {
          "q": "Which errno does a full descriptor table produce on open?",
          "options": [
            "ENFILE",
            "EMFILE",
            "EAGAIN",
            "ENOMEM"
          ],
          "answer": 1,
          "explain": "EMFILE is the per-process limit from RLIMIT_NOFILE. ENFILE is the system-wide file table limit, a different failure."
        },
        {
          "q": "What distinguishes memory.high from memory.max?",
          "options": [
            "high is per-container, max is per-process",
            "high throttles and applies reclaim pressure; max is a hard wall ending in the cgroup OOM killer",
            "high is advisory only and never enforced",
            "max applies only to page cache, high only to anonymous memory"
          ],
          "answer": 1,
          "explain": "high is a soft ceiling used to slow a workload and force reclaim. max is enforcement: allocations fail or the OOM killer runs inside the cgroup."
        },
        {
          "q": "A process lowers its RLIMIT_NOFILE hard limit to 64. What can it do later?",
          "options": [
            "Raise it back with setrlimit because it is the same process",
            "Nothing: an unprivileged process cannot raise a hard limit it lowered",
            "Raise it only after exec",
            "Raise it if it has CAP_SYS_RESOURCE in any namespace"
          ],
          "answer": 1,
          "explain": "Lowering a hard limit is one-way for an unprivileged process. CAP_SYS_RESOURCE can raise it, which is exactly why capabilities are part of the threat model."
        }
      ],
      "quickbytes": [
        "Soft limit enforced, hard limit is the ceiling; unprivileged processes can only lower hard.",
        "RLIMIT_NPROC is per real UID across the host, not per service.",
        "memory.events is hierarchical; memory.events.local is the leaf view.",
        "Read /sys/fs/cgroup inside the process before sizing any pool or heap."
      ],
      "github": [
        {
          "name": "runc - applies cgroup v2 limits per container",
          "url": "https://github.com/opencontainers/runc"
        },
        {
          "name": "systemd - resource control unit settings",
          "url": "https://github.com/systemd/systemd"
        }
      ],
      "resources": [
        {
          "title": "getrlimit(2): every limit and its failure mode",
          "url": "https://man7.org/linux/man-pages/man2/getrlimit.2.html",
          "kind": "docs"
        },
        {
          "title": "Control Group v2: memory, pids, cpu controllers",
          "url": "https://docs.kernel.org/admin-guide/cgroup-v2.html",
          "kind": "docs"
        },
        {
          "title": "Pressure stall information (PSI)",
          "url": "https://docs.kernel.org/accounting/psi.html",
          "kind": "docs"
        },
        {
          "title": "Linux kernel source: kernel/cgroup/",
          "url": "https://github.com/torvalds/linux",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "os19",
      "n": 19,
      "title": "OS security boundaries: capabilities, seccomp, Landlock",
      "minutes": 95,
      "level": "industry",
      "goal": "Replace root with explicit capabilities, confine syscalls with a real seccomp filter, and know which kernel boundary stops which class of attack.",
      "sections": [
        {
          "h": "Root is a bag of capabilities, and most of them are too much",
          "p": [
            "Linux splits the old root privilege into capabilities: CAP_NET_BIND_SERVICE to bind low ports, CAP_SYS_ADMIN for mounts and namespaces, CAP_SYS_PTRACE to inspect other processes, CAP_DAC_OVERRIDE to bypass file permissions. A process has permitted, effective, inheritable, bounding and ambient sets; what it can actually exercise is the effective set, and the bounding set limits what exec can ever grant.",
            "CAP_SYS_ADMIN is the notorious one: it covers mounting, namespace creation, some ioctls and a long tail of operations, so a process with it is root in all but name. The useful discipline is to start from zero and add only what a test proves is needed. File capabilities let a binary acquire a single capability on exec, but they interact with no_new_privs and user namespaces in ways that are easy to get wrong."
          ],
          "list": [
            "Effective: what the kernel checks right now",
            "Permitted: the ceiling the process may raise into",
            "Inheritable: preserved across exec only with matching file caps",
            "Bounding: what exec may ever grant; dropping is one-way",
            "Ambient: preserved for unprivileged exec without file caps"
          ]
        },
        {
          "h": "seccomp-bpf filters syscalls, not arguments in memory",
          "p": [
            "A seccomp filter is a BPF program over the syscall number, architecture, instruction pointer and the raw register arguments. It can return ALLOW, ERRNO(value), TRACE, LOG, KILL_THREAD or KILL_PROCESS. It cannot dereference a pointer argument, so you cannot filter on a pathname or a socket address - only on scalar values and flags. The filter is inherited across fork and exec and cannot be removed, which is what makes it a durable boundary.",
            "Always check the architecture first. On x86-64, the x32 ABI uses syscall numbers with bit 30 set; a filter that compares only against the 64-bit numbers can be bypassed by invoking the same call through the x32 ABI. The filter must also be installed with PR_SET_NO_NEW_PRIVS, or a setuid binary could exec with a different privilege state than the filter was written for."
          ],
          "code": "fn main() {\n    const AUDIT_ARCH_X86_64: u32 = 0xc000_003e;\n    const LD_W_ABS: u16 = 0x20;\n    const JEQ_K: u16 = 0x15;\n    const RET_K: u16 = 0x06;\n    const RET_KILL_PROCESS: u32 = 0x8000_0000;\n    const RET_ERRNO: u32 = 0x0005_0000;\n    const RET_ALLOW: u32 = 0x7fff_0000;\n\n    let filter = [\n        libc::sock_filter { code: LD_W_ABS, jt: 0, jf: 0, k: 4 },              // arch\n        libc::sock_filter { code: JEQ_K, jt: 1, jf: 0, k: AUDIT_ARCH_X86_64 },\n        libc::sock_filter { code: RET_K, jt: 0, jf: 0, k: RET_KILL_PROCESS },  // wrong ABI\n        libc::sock_filter { code: LD_W_ABS, jt: 0, jf: 0, k: 0 },              // syscall nr\n        libc::sock_filter { code: JEQ_K, jt: 0, jf: 1, k: libc::SYS_execve as u32 },\n        libc::sock_filter { code: RET_K, jt: 0, jf: 0, k: RET_ERRNO | libc::EPERM as u32 },\n        libc::sock_filter { code: RET_K, jt: 0, jf: 0, k: RET_ALLOW },\n    ];\n    let prog = libc::sock_fprog {\n        len: filter.len() as u16,\n        filter: filter.as_ptr() as *mut libc::sock_filter,\n    };\n\n    unsafe {\n        assert_eq!(libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), 0);\n        let rc = libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &prog);\n        assert_eq!(rc, 0, \"seccomp: {}\", std::io::Error::last_os_error());\n    }\n\n    let err = std::process::Command::new(\"/bin/true\").status().unwrap_err();\n    println!(\"execve blocked: {err}\");\n}",
          "tip": "Use SECCOMP_RET_ERRNO during rollout and SECCOMP_RET_KILL_PROCESS once the allowlist is proven; an errno filter can be retried in a loop, a kill cannot."
        },
        {
          "h": "Landlock and LSM: paths, not just syscalls",
          "p": [
            "seccomp cannot look at a pathname, so it cannot express 'this process may only read /data'. Landlock can: an unprivileged process builds a ruleset of filesystem access rights, adds path-beneath rules for directories it already has access to, and restricts itself. The restriction is inherited by children and cannot be lifted, which makes it the right tool for a plugin or a build step that should only touch one directory.",
            "Other LSMs cover different questions. Yama's ptrace_scope restricts which processes may trace which, which is why debugging a sibling process sometimes needs a privileged parent. SELinux and AppArmor add labels or path profiles enforced at the same hook points. None of these replace capabilities and seccomp: they answer different questions, and a workload should get a path policy, a syscall policy and a minimal capability set together."
          ]
        },
        {
          "h": "Boundaries are compositional, and each one leaks",
          "p": [
            "A user namespace lets an unprivileged user become root inside it, so the kernel must prevent that root from affecting the parent; the history of container escapes is largely the history of bugs in that guarantee. A mount namespace hides paths, but an inherited file descriptor still works. A seccomp filter blocks syscalls, but a permitted syscall with an unchecked argument may be enough. A capability set is only as strong as the bounding set that survives exec.",
            "The practical method is to enumerate what the workload must do and then remove everything else: no CAP_SYS_ADMIN, no host PID namespace, no writable host mounts, no device nodes beyond /dev/null and /dev/zero, a seccomp allowlist generated from a real trace, and a Landlock policy for its data directory. Then attack your own configuration from inside, with the same syscalls an exploit would use, before someone else does."
          ]
        }
      ],
      "exercise": {
        "prompt": "Install a seccomp filter that kills the process on a non-x86-64 ABI and returns EPERM for execve, then prove that Command::new fails and that /proc/self/status reports Seccomp: 2. Do not filter anything your process needs first.",
        "starter": "fn main() {\n    // 1. build the sock_filter array: arch check, nr load, execve check, allow\n    // 2. PR_SET_NO_NEW_PRIVS, then PR_SET_SECCOMP with the program\n    // 3. try Command::new(\"/bin/true\") and print the error\n    // 4. print the Seccomp line from /proc/self/status\n}",
        "hint": "Jump offsets are relative to the next instruction: jt=1 skips one instruction. Install the filter late in main, because it also applies to any thread you spawn afterwards. Seccomp: 2 means filter mode.",
        "solution": "fn main() {\n    const AUDIT_ARCH_X86_64: u32 = 0xc000_003e;\n    const RET_KILL_PROCESS: u32 = 0x8000_0000;\n    const RET_ERRNO: u32 = 0x0005_0000;\n    const RET_ALLOW: u32 = 0x7fff_0000;\n\n    let filter = [\n        libc::sock_filter { code: 0x20, jt: 0, jf: 0, k: 4 },\n        libc::sock_filter { code: 0x15, jt: 1, jf: 0, k: AUDIT_ARCH_X86_64 },\n        libc::sock_filter { code: 0x06, jt: 0, jf: 0, k: RET_KILL_PROCESS },\n        libc::sock_filter { code: 0x20, jt: 0, jf: 0, k: 0 },\n        libc::sock_filter { code: 0x15, jt: 0, jf: 1, k: libc::SYS_execve as u32 },\n        libc::sock_filter { code: 0x06, jt: 0, jf: 0, k: RET_ERRNO | libc::EPERM as u32 },\n        libc::sock_filter { code: 0x06, jt: 0, jf: 0, k: RET_ALLOW },\n    ];\n    let prog = libc::sock_fprog { len: filter.len() as u16, filter: filter.as_ptr() as *mut libc::sock_filter };\n\n    unsafe {\n        assert_eq!(libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), 0);\n        let rc = libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &prog);\n        assert_eq!(rc, 0, \"seccomp install: {}\", std::io::Error::last_os_error());\n    }\n\n    match std::process::Command::new(\"/bin/true\").status() {\n        Ok(s) => println!(\"unexpectedly ran: {s}\"),\n        Err(e) => println!(\"execve denied: {e} (errno {:?})\", e.raw_os_error()),\n    }\n\n    let status = std::fs::read_to_string(\"/proc/self/status\").unwrap();\n    for line in status.lines().filter(|l| l.starts_with(\"Seccomp\") || l.starts_with(\"NoNewPrivs\")) {\n        println!(\"{line}\");\n    }\n}"
      },
      "production": [
        "Start every workload with zero capabilities and add only what a test proves is required.",
        "Generate the seccomp allowlist from a real trace, include the arch check, and ship a kill mode once proven.",
        "Apply Landlock for filesystem confinement where seccomp cannot express a path rule.",
        "Re-run the escape checklist from inside the sandbox after every runtime or kernel upgrade."
      ],
      "crates": [
        "caps",
        "libc",
        "seccompiler"
      ],
      "pitfall": "A seccomp filter that checks syscall numbers without checking the architecture: on x86-64 an x32 syscall number with bit 30 set reaches the same code path and slips past the filter.",
      "questions": [
        {
          "q": "Which capability is effectively unrestricted root for container purposes?",
          "options": [
            "CAP_NET_BIND_SERVICE",
            "CAP_SYS_ADMIN",
            "CAP_CHOWN",
            "CAP_SETUID"
          ],
          "answer": 1,
          "explain": "CAP_SYS_ADMIN covers mount, namespace creation, and a long tail of privileged operations. A workload holding it can build its own less-restricted environment."
        },
        {
          "q": "What can a seccomp filter inspect?",
          "options": [
            "Pointers to userspace strings and structures",
            "Syscall number, architecture, instruction pointer and scalar register arguments",
            "The contents of the process's open files",
            "The kernel stack of the calling thread"
          ],
          "answer": 1,
          "explain": "seccomp has no safe way to dereference user pointers, so it filters on numbers. Path-based policy needs Landlock or an LSM."
        },
        {
          "q": "What does Landlock add over seccomp?",
          "options": [
            "It blocks syscalls by number",
            "It restricts filesystem access by path hierarchy for the process and its children",
            "It drops capabilities from the bounding set",
            "It prevents ptrace of sibling processes"
          ],
          "answer": 1,
          "explain": "Landlock rulesets apply to path-beneath hierarchies, are inherited and cannot be lifted. seccomp cannot see a pathname at all."
        }
      ],
      "quickbytes": [
        "CAP_SYS_ADMIN is root with a different name; never hand it to a workload.",
        "Check the seccomp architecture first, or the x32 ABI bypasses the filter.",
        "PR_SET_NO_NEW_PRIVS is required before installing a filter; it is one-way.",
        "Landlock for paths, seccomp for syscalls, capabilities for privilege: three different questions."
      ],
      "github": [
        {
          "name": "libseccomp - filter construction and reference BPF",
          "url": "https://github.com/seccomp/libseccomp"
        },
        {
          "name": "caps-rs - read and drop Linux capabilities",
          "url": "https://github.com/lucab/caps-rs"
        }
      ],
      "resources": [
        {
          "title": "capabilities(7): the five sets and file capabilities",
          "url": "https://man7.org/linux/man-pages/man7/capabilities.7.html",
          "kind": "docs"
        },
        {
          "title": "seccomp(2): filter semantics and return actions",
          "url": "https://man7.org/linux/man-pages/man2/seccomp.2.html",
          "kind": "docs"
        },
        {
          "title": "Landlock: unprivileged filesystem access control",
          "url": "https://man7.org/linux/man-pages/man7/landlock.7.html",
          "kind": "docs"
        },
        {
          "title": "caps-rs source: capability set manipulation",
          "url": "https://github.com/lucab/caps-rs",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "os20",
      "n": 20,
      "title": "Debugging the kernel interface without guessing",
      "minutes": 85,
      "level": "industry",
      "goal": "Diagnose a failing syscall from the errno outward: separate ABI mistakes from policy denials and scheduling delays, and build a harness that proves which one it is.",
      "sections": [
        {
          "h": "The errno taxonomy is the first branch",
          "p": [
            "Every kernel-interface bug starts with a return value and an errno, and the errno encodes who refused. EPERM means policy denied the operation - a missing capability, a seccomp filter, a read-only filesystem restriction. EACCES means permission bits or an LSM label. EINVAL means the ABI is wrong: a bad size, an unsupported flag, a structure the kernel does not recognise. ENOSYS means the kernel or configuration does not implement the call at all.",
            "The costly mistakes are treating these as one class. Retrying EPERM forever hides a capability that will never appear; padding a struct to silence EINVAL hides a version mismatch. EAGAIN is not an error at all, it is flow control. EINTR is a signal, not a failure. Deciding which of these you are looking at is the whole diagnosis, and it takes one read of the man page section on errors."
          ],
          "list": [
            "EPERM: policy or capability, never going to succeed by retrying",
            "EACCES: permission bits, ownership, or an LSM denial",
            "EINVAL: wrong size, flag, or structure layout at the ABI",
            "ENOSYS: not implemented, or blocked by a seccomp filter returning ENOSYS",
            "EBUSY: resource is in use or the operation is illegal in this state"
          ]
        },
        {
          "h": "Reproduce outside the application",
          "p": [
            "The fastest path is a ten-line program that calls the same syscall with the same flags. If it fails identically, the problem is in the environment, not the code. If it succeeds, the application differs in a way you can bisect: privileges, namespaces, cgroup, seccomp, open file descriptors, or a flag it sets earlier. Compare /proc/self/status (CapEff, Seccomp, NoNewPrivs) between the two.",
            "strace is the ground truth for what was actually requested: -f follows threads, -e trace=openat,mount narrows the noise, and -y resolves file descriptor arguments to paths. perf trace does the same with lower overhead and stack samples. /proc/PID/syscall names the syscall a blocked thread is in, and /proc/PID/wchan names the kernel wait channel - together they distinguish a futex wait from a read on a socket from a disk wait."
          ],
          "code": "use std::time::Duration;\n\nextern \"C\" fn on_alarm(_: libc::c_int) {}\n\nfn main() {\n    // 1. A signal without SA_RESTART makes an interruptible sleep fail with EINTR.\n    unsafe {\n        let mut sa: libc::sigaction = std::mem::zeroed();\n        sa.sa_sigaction = on_alarm as usize;\n        sa.sa_flags = 0; // deliberately no SA_RESTART\n        libc::sigemptyset(&mut sa.sa_mask);\n        libc::sigaction(libc::SIGALRM, &sa, std::ptr::null_mut());\n        libc::ualarm(20_000, 0);\n\n        let req = libc::timespec { tv_sec: 1, tv_nsec: 0 };\n        let rc = libc::nanosleep(&req, std::ptr::null_mut());\n        let err = std::io::Error::last_os_error();\n        println!(\"nanosleep rc={rc} errno={:?} ({err})\", err.raw_os_error());\n        assert_eq!(err.raw_os_error(), Some(libc::EINTR));\n    }\n\n    // 2. When a thread is blocked, this file names the syscall it is in.\n    let current = std::fs::read_to_string(\"/proc/self/syscall\").unwrap_or_default();\n    println!(\"current syscall: {}\", current.trim());\n\n    // 3. Policy state explains EPERM without any application code.\n    let status = std::fs::read_to_string(\"/proc/self/status\").unwrap_or_default();\n    for line in status.lines().filter(|l| l.starts_with(\"CapEff\") || l.starts_with(\"Seccomp\") || l.starts_with(\"NoNewPrivs\")) {\n        println!(\"{line}\");\n    }\n    std::thread::sleep(Duration::from_millis(1));\n}",
          "tip": "When a syscall fails only in a container, run the same binary on the host with strace and diff the syscall sequence; the first divergence is almost always namespaces, seccomp or a missing capability."
        },
        {
          "h": "Separate blocked from runnable",
          "p": [
            "A slow request is either waiting to run or waiting on something. /proc/PID/sched's nr_involuntary_switches and PSI's cpu some pressure answer the first; wchan, /proc/PID/stack, and off-CPU profiling answer the second. perf sched record/report gives per-task run and wait time, and perf trace -s summarises syscall latency without the full strace overhead.",
            "The classic misdiagnosis is adding CPU to a workload that is blocked on a lock or a disk. The counters are unambiguous once you know which to read: rising involuntary switches mean the scheduler is holding you back, rising major faults or IO wait means memory or storage, and a stable run queue with high latency means the wait is inside the kernel or on a lock."
          ]
        },
        {
          "h": "Build a harness you can keep",
          "p": [
            "The final debugging skill is turning the investigation into a test. A program that asserts the exact errno for a denied syscall, checks CapEff and Seccomp, prints the mount table, and reports the kernel version is both a diagnosis and a regression test. Run it inside the container image and on the host; the diff is your environment contract.",
            "Keep the harness small enough to copy into a scratch container and independent of the application's dependencies. It should be statically linked or use only libc, so it runs in the minimal image where the bug reproduces. That is the artifact to attach to an incident, because it answers the first three questions - what is the kernel, what can this process do, and what did the syscall actually return - before anyone starts reading application code."
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a diagnostic binary that reports uname, the effective capability mask, Seccomp mode, the cgroup path, and the errno of a deliberately interrupted nanosleep. It must compile without the application's dependencies and run in a minimal container.",
        "starter": "fn main() {\n    // 1. uname via libc::uname, print release and machine\n    // 2. Seccomp, NoNewPrivs and CapEff from /proc/self/status\n    // 3. cgroup path from /proc/self/cgroup\n    // 4. install SIGALRM without SA_RESTART, ualarm, nanosleep, print errno\n}",
        "hint": "Only libc is needed. ualarm takes microseconds; 20ms is enough to arrive during a one-second sleep. If you set SA_RESTART, nanosleep returns 0 remaining and you learn nothing about EINTR.",
        "solution": "use std::ffi::CStr;\n\nextern \"C\" fn on_alarm(_: libc::c_int) {}\n\nfn main() {\n    unsafe {\n        let mut uts: libc::utsname = std::mem::zeroed();\n        if libc::uname(&mut uts) == 0 {\n            let release = CStr::from_ptr(uts.release.as_ptr()).to_string_lossy();\n            let machine = CStr::from_ptr(uts.machine.as_ptr()).to_string_lossy();\n            println!(\"kernel: {release} ({machine})\");\n        }\n    }\n\n    if let Ok(status) = std::fs::read_to_string(\"/proc/self/status\") {\n        for line in status.lines() {\n            if line.starts_with(\"CapEff\") || line.starts_with(\"Seccomp\") || line.starts_with(\"NoNewPrivs\") {\n                println!(\"{line}\");\n            }\n        }\n    }\n\n    if let Ok(cg) = std::fs::read_to_string(\"/proc/self/cgroup\") {\n        println!(\"cgroup: {}\", cg.trim());\n    }\n\n    unsafe {\n        let mut sa: libc::sigaction = std::mem::zeroed();\n        sa.sa_sigaction = on_alarm as usize;\n        sa.sa_flags = 0; // no SA_RESTART: we want to observe EINTR\n        libc::sigemptyset(&mut sa.sa_mask);\n        libc::sigaction(libc::SIGALRM, &sa, std::ptr::null_mut());\n        libc::ualarm(20_000, 0);\n\n        let req = libc::timespec { tv_sec: 1, tv_nsec: 0 };\n        let rc = libc::nanosleep(&req, std::ptr::null_mut());\n        let err = std::io::Error::last_os_error();\n        println!(\"nanosleep rc={rc} errno={:?}\", err.raw_os_error());\n        assert_eq!(err.raw_os_error(), Some(libc::EINTR));\n    }\n}"
      },
      "production": [
        "Attach a libc-only diagnostic binary to every incident: kernel, CapEff, Seccomp, cgroup, mount table.",
        "Classify the errno before adding a retry; EPERM and EINVAL do not become success with backoff.",
        "Use strace -f -y to see the actual syscall sequence, and perf trace when overhead matters.",
        "Turn every environment-specific bug into an assertion in the image's smoke test."
      ],
      "crates": [
        "libc",
        "nix",
        "rustix"
      ],
      "pitfall": "Wrapping a failing syscall in an infinite retry loop: EPERM, EACCES and EINVAL are deterministic, so the retry converts a clear error into a hang with no error message.",
      "questions": [
        {
          "q": "A mount call fails with EPERM inside a container but works on the host. What is the first thing to check?",
          "options": [
            "Whether the filesystem supports the mount flags",
            "The effective capability set and the user namespace the process is in",
            "The size of the mount options string",
            "Whether the kernel has the filesystem compiled as a module"
          ],
          "answer": 1,
          "explain": "EPERM is a policy denial. CAP_SYS_ADMIN in the relevant user namespace is the usual missing piece; a missing module would give ENODEV or ENOSYS."
        },
        {
          "q": "Which file names the syscall a blocked thread is currently executing?",
          "options": [
            "/proc/PID/status",
            "/proc/PID/syscall",
            "/proc/PID/limits",
            "/proc/PID/mountinfo"
          ],
          "answer": 1,
          "explain": "/proc/PID/syscall shows the syscall number, arguments and stack pointer, or 'running' when the task is on-CPU. wchan complements it with the wait channel."
        },
        {
          "q": "When is EAGAIN not an error?",
          "options": [
            "When the file descriptor is non-blocking and the operation would block",
            "When the process lacks a capability",
            "When the syscall number is unknown to the kernel",
            "When the buffer is misaligned"
          ],
          "answer": 0,
          "explain": "EAGAIN means try again when ready; it is the contract of non-blocking IO and is also how RLIMIT_NPROC surfaces at fork. It is flow control, not failure."
        }
      ],
      "quickbytes": [
        "EPERM is policy, EACCES is permissions, EINVAL is ABI, ENOSYS is unsupported: branch before retrying.",
        "strace -f -y is ground truth; perf trace is the low-overhead version.",
        "Separate runnable from blocked with nr_involuntary_switches and wchan before adding CPU.",
        "Keep a libc-only diagnostic binary in the image; it is the incident attachment."
      ],
      "github": [
        {
          "name": "strace - syscall tracer used in every diagnosis",
          "url": "https://github.com/strace/strace"
        },
        {
          "name": "Linux kernel source: the syscall error paths",
          "url": "https://github.com/torvalds/linux"
        }
      ],
      "resources": [
        {
          "title": "strace(1): tracing options and overhead",
          "url": "https://man7.org/linux/man-pages/man1/strace.1.html",
          "kind": "docs"
        },
        {
          "title": "perf_event_open(2): the interface under perf",
          "url": "https://man7.org/linux/man-pages/man2/perf_event_open.2.html",
          "kind": "docs"
        },
        {
          "title": "ptrace(2): process inspection and its restrictions",
          "url": "https://man7.org/linux/man-pages/man2/ptrace.2.html",
          "kind": "docs"
        },
        {
          "title": "Linux kernel source: the syscall table and error returns",
          "url": "https://github.com/torvalds/linux",
          "kind": "repo"
        }
      ]
    }
  ]
};
