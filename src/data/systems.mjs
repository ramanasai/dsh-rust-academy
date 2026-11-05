/**
 * Systems programming track.
 *
 * Authored for the Rust Academy plugin. Every lesson is plain JSON-compatible
 * data consumed by src/app.js through build.mjs.
 */
export default {
  "key": "systems",
  "prefix": "n",
  "title": "Systems programming",
  "blurb": "Syscalls, memory and allocators, io_uring, eBPF, containers internals, WASM and no_std systems.",
  "level": "industry",
  "project": {
    "title": "Capstone: a sandboxed task runner",
    "brief": "Build a runner that accepts a command, starts it in fresh namespaces under a cgroup v2 leaf, installs a seccomp filter and a capability bounding set, then supervises it to completion and reports peak memory, CPU time and exit status. It must survive a crash of the runner itself without orphaning the workload, and it must never leave a cgroup or mount behind.",
    "deliverables": [
      "Namespace isolation: user, mount, PID, UTS, IPC and network namespaces created in the right order, with uid_map/gid_map written and pivot_root performed after MS_REC|MS_PRIVATE on /.",
      "Cgroup v2 placement: a dedicated leaf under the delegated subtree, memory.max and pids.max set before exec, and the leaf removed on every exit path including panics.",
      "Seccomp filter compiled with seccompiler from an allowlist of syscalls, installed with no_new_privs set, and verified by a test that a forbidden syscall returns EPERM or SIGSYS.",
      "Resource accounting: CPU time from wait4 rusage, peak memory from memory.peak before the cgroup is removed, and OOM detection from memory.events.",
      "Crash-safe supervision: the child is reaped by a subreaper or a supervisor that survives runner death, with a pidfd so no signal is sent to a recycled PID."
    ],
    "stack": [
      "nix",
      "libc",
      "tokio",
      "caps",
      "seccompiler",
      "thiserror"
    ]
  },
  "lessons": [
    {
      "id": "n01",
      "title": "System calls: the ABI boundary between Rust and the kernel",
      "minutes": 75,
      "level": "core",
      "goal": "Follow one File::open from Rust down to openat(2), decode the negative-errno return convention, and choose correctly between std, nix, rustix and raw libc.",
      "sections": [
        {
          "h": "One instruction, six registers, one return value",
          "p": [
            "A system call is the only door from your process into the kernel. On x86-64 the syscall instruction takes the call number in rax and up to six arguments in rdi, rsi, rdx, r10, r8 and r9, then returns a single value in rax. The kernel never touches errno: on failure rax holds a small negative number such as -2, and the libc wrapper is what turns that into a return of -1 plus errno = 2.",
            "That division of labour explains most of the confusion around system calls. A raw call reports failure by returning a value in the range -4095 to -1, while the C wrapper reports failure as -1 and stores the reason in a thread-local variable. Rust std sits on top of the wrapper, so std::io::Error carries the errno value but not the syscall that produced it.",
            "The call is also not free. A syscall traps into the kernel, switches stacks, and on modern CPUs pays for Spectre mitigations; expect tens to a few hundred nanoseconds plus whatever the kernel copies across the boundary. Anything the kernel can answer without trapping, such as clock_gettime, is served from the vDSO instead."
          ],
          "code": "use std::io;\n\nfn raw_getpid() -> io::Result<libc::pid_t> {\n    // libc::syscall is the variadic C wrapper: it sets errno on failure.\n    let rc = unsafe { libc::syscall(libc::SYS_getpid) };\n    if rc < 0 {\n        Err(io::Error::last_os_error())\n    } else {\n        Ok(rc as libc::pid_t)\n    }\n}\n\nfn main() -> io::Result<()> {\n    println!(\"raw syscall = {}\", raw_getpid()?);\n    println!(\"nix         = {}\", nix::unistd::getpid());\n    println!(\"std         = {}\", std::process::id());\n    Ok(())\n}",
          "tip": "Read errno immediately after the failing call. Any intervening libc call, including the one inside println!, may overwrite it."
        },
        {
          "h": "errno is thread-local state you borrow, not own",
          "p": [
            "Because errno is a per-thread variable, the value is only valid until the next call that might set it. Rust encodes this by making io::Error::last_os_error() read the current value at construction. If you save the return code, log something, and only then build the error, you are reporting whatever the logging code did to errno.",
            "The wrapper crates differ in how much they hide. nix returns Result<T, Errno> and converts immediately, so the error cannot go stale. rustix returns io::Result and passes file descriptors as OwnedFd or BorrowedFd, which makes descriptor leaks a compile-time concern rather than a review comment. std is the highest level and the least specific: it retries EINTR for you, sets O_CLOEXEC, and collapses distinct kernel failures into a few ErrorKind variants."
          ],
          "list": [
            "std first: it is portable, keeps descriptors owned, and handles EINTR",
            "nix or rustix when std exposes no wrapper for the call you need",
            "raw libc only for ioctls, flags and structs that no wrapper has bound yet",
            "never reimplement a wrapper that already exists: the edge cases are the value"
          ],
          "tip": "EINTR means no data moved, not that the operation failed. Retry the exact same call; std already does this inside read and write."
        },
        {
          "h": "The syscalls your abstractions already make",
          "p": [
            "File::open is openat(2) with O_CLOEXEC. Spawning a thread is clone(2) with CLONE_VM and CLONE_THREAD. println! takes a lock and calls write(2) on file descriptor 1. None of this is hidden from strace, and reading a trace of your own binary is the cheapest way to learn what a library actually costs.",
            "The practical payoff is batching. One read of 64 KiB costs roughly the same as one read of 64 bytes, so a loop that issues a syscall per byte can be two orders of magnitude slower than the same loop with a buffer. writev and sendmmsg exist for the same reason: move more per trap."
          ],
          "code": "# trace only path-resolution and I/O syscalls, follow threads, show durations\nstrace -f -T -e trace=%file,%desc ./target/release/taskrunner 2>&1 | head -20\n\n# count syscalls per request instead of reading the list\nstrace -c -f ./target/release/taskrunner 2>&1 | head -15\n\n# typical first lines of a Rust binary starting up\n# openat(AT_FDCWD, \"/etc/ld.so.cache\", O_RDONLY|O_CLOEXEC) = 3 <0.000021>\n# openat(AT_FDCWD, \"/lib/x86_64-linux-gnu/libgcc_s.so.1\", O_RDONLY|O_CLOEXEC) = 3\n# read(3, \"\\177ELF\\002\\001\\001\\003\\000\\000\\000\\000\\000\\000\\000\\000\\000\", 832) = 832\n# write(1, \"ready\\n\", 6) = 6 <0.000007>",
          "tip": "Count syscalls per request, not per second. A service doing 40 syscalls to answer one HTTP request has a batching problem, not a kernel problem."
        }
      ],
      "exercise": {
        "prompt": "Write getuid_two_ways: one version calling SYS_getuid through libc::syscall, one through nix::unistd::getuid. Then trigger a real failure with an openat of a missing path in both styles and prove the errno values match.",
        "starter": "use std::io;\n\nfn raw_getuid() -> io::Result<libc::uid_t> {\n    // TODO: call libc::syscall(libc::SYS_getuid), check the negative range,\n    // and convert errno into io::Error.\n    todo!()\n}\n\nfn main() {\n    // TODO: print both values, then compare the errors from\n    // std::fs::File::open(\"/definitely/missing\") and\n    // nix::fcntl::open(...) on the same path.\n}",
        "hint": "libc::syscall returns c_long; success is any non-negative value. For the failure comparison, print errno().raw_os_error() from nix and raw_os_error() from std::io::Error - both should be ENOENT (2).",
        "solution": "use std::io;\n\nfn raw_getuid() -> io::Result<libc::uid_t> {\n    let rc = unsafe { libc::syscall(libc::SYS_getuid) };\n    if rc < 0 {\n        Err(io::Error::last_os_error())\n    } else {\n        Ok(rc as libc::uid_t)\n    }\n}\n\nfn main() {\n    println!(\"raw = {}\", raw_getuid().unwrap());\n    println!(\"nix = {}\", nix::unistd::getuid());\n\n    let std_err = std::fs::File::open(\"/definitely/missing\").unwrap_err();\n    let nix_err = nix::fcntl::open(\n        \"/definitely/missing\",\n        nix::fcntl::OFlag::O_RDONLY,\n        nix::sys::stat::Mode::empty(),\n    )\n    .unwrap_err();\n\n    println!(\"std raw_os_error = {:?}\", std_err.raw_os_error());\n    println!(\"nix errno         = {:?}\", nix_err as i32);\n    assert_eq!(std_err.raw_os_error(), Some(libc::ENOENT));\n}"
      },
      "questions": [
        {
          "q": "A libc wrapper returns -1. Where is the actual reason stored, and what would a raw syscall have returned instead?",
          "options": [
            "The reason is in rax as a positive error number; the raw call returns 0",
            "The reason is in the thread-local errno; the raw call returns -errno in rax",
            "The reason is in the carry flag; the raw call returns errno in rdx",
            "The reason is in a kernel log ring; the raw call returns EAGAIN"
          ],
          "answer": 1,
          "explain": "The kernel returns a small negative value in rax. glibc converts that into -1 plus errno, which is why reading errno after other calls can report the wrong failure."
        },
        {
          "q": "write(2) returns 12 when you asked it to write 4096 bytes to a socket. What happened?",
          "options": [
            "The write failed and errno is set to EMSGSIZE",
            "The kernel buffered 12 bytes and silently dropped the rest",
            "A partial write occurred; you must advance the buffer and write again",
            "The file descriptor is non-blocking and the call must be retried with the same buffer"
          ],
          "answer": 2,
          "explain": "A short write is a normal success. Only a return of -1 is a failure, and the remaining bytes must be written from the new offset, ideally with a loop or writev."
        },
        {
          "q": "Which of these normally completes without entering the kernel at all?",
          "options": [
            "clock_gettime(CLOCK_MONOTONIC, ...)",
            "openat(AT_FDCWD, path, O_RDONLY)",
            "futex(FUTEX_WAIT, ...)",
            "getpid()"
          ],
          "answer": 0,
          "explain": "The kernel maps a vDSO page into every process, so clock_gettime and gettimeofday read the time in userspace. getpid still traps on modern kernels because of PID caching removal."
        }
      ],
      "quickbytes": [
        "Check the return value before touching errno; on success errno is undefined, not zero.",
        "Run strace -c on your binary before optimising anything: the syscall histogram usually names the real cost.",
        "Prefer nix or rustix over raw libc so descriptors are owned and errors cannot go stale."
      ],
      "production": [
        "Error paths log the syscall name and the raw errno, not just a Display string that hides ENOENT behind \"not found\".",
        "Hot loops read into buffers of at least 8 KiB and handle short reads and EINTR explicitly.",
        "Every spawned child sets CLOEXEC on inherited descriptors; a leaked fd survives exec and pins files open.",
        "CI runs one smoke test under strace -f -e trace=%file to catch accidental per-request opens."
      ],
      "crates": [
        "nix",
        "rustix",
        "libc"
      ],
      "github": [
        {
          "name": "nix - Rust friendly bindings to *nix APIs",
          "url": "https://github.com/nix-rust/nix"
        },
        {
          "name": "libc - raw FFI bindings to platform libraries",
          "url": "https://github.com/rust-lang/libc"
        }
      ],
      "pitfall": "Calling io::Error::last_os_error() after another libc call, or after a println!, returns a stale or overwritten errno, so the log names the wrong syscall and sends the investigation in the wrong direction.",
      "resources": [
        {
          "title": "syscalls(2) - the Linux system call table and ABI notes",
          "url": "https://man7.org/linux/man-pages/man2/syscalls.2.html",
          "kind": "docs"
        },
        {
          "title": "nix crate documentation",
          "url": "https://docs.rs/nix/latest/nix/",
          "kind": "docs"
        },
        {
          "title": "std::io::Error and raw_os_error",
          "url": "https://doc.rust-lang.org/std/io/struct.Error.html",
          "kind": "docs"
        },
        {
          "title": "nix source repository",
          "url": "https://github.com/nix-rust/nix",
          "kind": "repo"
        },
        {
          "title": "Jon Gjengset - long-form Rust systems streams",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ]
    },
    {
      "id": "n02",
      "title": "Virtual memory: pages, VMAs, and the fault path",
      "minutes": 80,
      "level": "core",
      "goal": "Explain what it costs to materialise a virtual address, distinguish minor from major faults, and read RSS, PSS and VSZ without fooling yourself.",
      "sections": [
        {
          "h": "An address space is a promise, not memory",
          "p": [
            "Every mapping is a range in a tree of VMAs, each tagged with permissions and a backing object: a file, an anonymous region, or a shared memory object. mmap of a gigabyte creates one VMA and returns immediately; not a single page frame has been allocated. The kernel only builds page-table entries when a fault proves the program actually wants the memory.",
            "That laziness is why the numbers in ps are so easy to misread. VSZ counts the whole promised range, including reservations a custom allocator makes for a multi-gigabyte arena. RSS counts resident pages, including pages shared with other processes and page-cache pages mapped from files. Neither number is the memory your program would free if it exited."
          ],
          "code": "use std::fs;\n\nfn statm() -> (u64, u64) {\n    // size, resident: both in pages, and both coarse by construction.\n    let s = fs::read_to_string(\"/proc/self/statm\").unwrap();\n    let mut it = s.split_whitespace().map(|f| f.parse::<u64>().unwrap());\n    (it.next().unwrap(), it.next().unwrap())\n}\n\nfn main() {\n    let page = 4096u64;\n    let (vsz, rss) = statm();\n    println!(\"before: vsz={} MiB rss={} MiB\", vsz * page / 1048576, rss * page / 1048576);\n\n    // Reserve 64 MiB: address space only, no resident frames yet.\n    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024 * 1024);\n    let (vsz2, rss2) = statm();\n    println!(\"after reserve: vsz={} MiB rss={} MiB\", vsz2 * page / 1048576, rss2 * page / 1048576);\n\n    // Push a full page at a time: each push writes 4096 bytes, so every page\n    // is faulted in and becomes resident.\n    for _ in 0..buf.capacity() / 4096 {\n        buf.extend_from_slice(&[0u8; 4096]);\n    }\n    let (_, rss3) = statm();\n    println!(\"after touch: rss={} MiB (len={})\", rss3 * page / 1048576, buf.len());\n}",
          "tip": "A Vec::with_capacity does not allocate physical memory; it reserves address space. Only the pages you write become resident."
        },
        {
          "h": "The fault path, and why first touch is expensive",
          "p": [
            "A minor fault resolves against something already in memory: a page-cache page, the shared zero page, or a copy-on-write page. A major fault has to reach a block device or the swap file and costs orders of magnitude more. Anonymous memory that has never been written maps to a single global zero page, which is why reading fresh memory is cheap and writing it is not.",
            "Copy-on-write is the same mechanism wearing a different hat. fork duplicates page tables but not frames, marking every writable page read-only in both processes. The first store in either process faults, the kernel copies the frame, and RSS grows by exactly one page. A child that only calls exec never pays for the copy at all."
          ],
          "list": [
            "Minor fault: map an existing frame into the page table",
            "Major fault: read from disk or swap before mapping",
            "COW fault: copy the frame, then remap both sides writable",
            "Huge fault: allocate a 2 MiB transparent huge page instead of 512 small ones"
          ],
          "tip": "perf stat -e page-faults,minor-faults,major-faults gives per-run counts; a rising major-fault rate usually means you are re-reading a file you could have cached."
        },
        {
          "h": "Numbers that survive scrutiny",
          "p": [
            "Use RSS for a rough per-process total, PSS when processes share pages and you are adding numbers together, and cgroup memory.current when you need what the kernel will actually reclaim or OOM-kill. smaps_rollup gives PSS in one read without walking every mapping. When RSS refuses to fall after a free, the pages are usually in a per-thread cache or still mapped by a file, not leaked.",
            "MADV_DONTNEED on anonymous memory drops the page-table entries and makes the next read return zeros, which is a real cost if the data was live. MADV_FREE is cheaper but keeps the contents until pressure arrives. On file-backed mappings, dropping the PTE does not lose data because the page cache still holds it."
          ],
          "code": "# per-mapping detail, sorted by resident size\nawk '/^[0-9a-f]/ {name=$6} /^Rss:/ {print $2, name}' /proc/self/smaps | sort -rn | head\n\n# one-line PSS/RSS totals without walking every VMA\ngrep -E '^(Rss|Pss|Private_Dirty):' /proc/self/smaps_rollup\n\n# faults for a single run\nperf stat -e page-faults,minor-faults,major-faults ./target/release/app\n\n# resident versus shared, in one line\ngrep -E '^(Rss|Pss|Shared_Clean):' /proc/self/smaps_rollup",
          "tip": "Sum PSS, never RSS, when you add up containers: shared libraries and page-cache pages are counted once per process in RSS."
        }
      ],
      "exercise": {
        "prompt": "Write a program that reserves 128 MiB with mmap(MAP_ANONYMOUS|MAP_PRIVATE), prints RSS, touches every 4 KiB page, prints RSS again, then calls madvise(MADV_DONTNEED) and prints RSS a third time. Explain each delta.",
        "starter": "use nix::sys::mman::{mmap, madvise, MunmapFlags, MmapAdvise};\nuse nix::sys::mman::{MapFlags, ProtFlags};\nuse std::num::NonZeroUsize;\n\nfn rss_kib() -> u64 {\n    // TODO: parse VmRSS from /proc/self/status\n    0\n}\n\nfn main() {\n    let len = NonZeroUsize::new(128 * 1024 * 1024).unwrap();\n    // TODO: map, touch one byte per page, advise DONTNEED, print RSS each time.\n}",
        "hint": "Read VmRSS from /proc/self/status (kB). Touch with ptr::write_volatile at offsets i * 4096 so the optimiser cannot elide the stores. MADV_DONTNEED on anonymous memory zeroes the next read.",
        "solution": "use nix::sys::mman::{madvise, mmap, MapFlags, MmapAdvise, ProtFlags};\nuse std::num::NonZeroUsize;\n\nfn rss_kib() -> u64 {\n    let status = std::fs::read_to_string(\"/proc/self/status\").unwrap();\n    status\n        .lines()\n        .find(|l| l.starts_with(\"VmRSS:\"))\n        .and_then(|l| l.split_whitespace().nth(1))\n        .and_then(|v| v.parse().ok())\n        .unwrap_or(0)\n}\n\nfn main() {\n    let len = 128 * 1024 * 1024;\n    let ptr = unsafe {\n        mmap(\n            None,\n            NonZeroUsize::new(len).unwrap(),\n            ProtFlags::PROT_READ | ProtFlags::PROT_WRITE,\n            MapFlags::MAP_ANONYMOUS | MapFlags::MAP_PRIVATE,\n            -1,\n            0,\n        )\n        .unwrap()\n    };\n    println!(\"reserved: {} KiB\", rss_kib());\n\n    for off in (0..len).step_by(4096) {\n        unsafe { std::ptr::write_volatile((ptr as *mut u8).add(off), 1) };\n    }\n    println!(\"touched:  {} KiB\", rss_kib());\n\n    unsafe { madvise(ptr, len, MmapAdvise::MADV_DONTNEED).unwrap() };\n    println!(\"advised:  {} KiB\", rss_kib());\n\n    unsafe { nix::sys::mman::munmap(ptr, len).unwrap() };\n}"
      },
      "questions": [
        {
          "q": "A freshly mmapped anonymous page is read before it is ever written. Which fault, if any, occurs?",
          "options": [
            "A major fault, because the page must come from swap",
            "A minor fault mapping the shared zero page, or no fault if it was already mapped",
            "No fault is possible; anonymous memory is allocated eagerly",
            "A SIGSEGV, because the page has no backing object"
          ],
          "answer": 1,
          "explain": "Read-only access to untouched anonymous memory maps the kernel-wide zero page. The expensive case is the first write, which allocates a real frame."
        },
        {
          "q": "After fork, the child writes one byte into a 10 MiB heap. What does the kernel do?",
          "options": [
            "Copies the entire heap during fork regardless of writes",
            "Copies one page on the write fault; the other pages stay shared read-only",
            "Shares the page writable, so the parent sees the byte",
            "Sends SIGSEGV because the page is read-only after fork"
          ],
          "answer": 1,
          "explain": "fork marks pages copy-on-write. The store faults, the kernel copies that single page for the writer, and both processes keep sharing everything untouched."
        },
        {
          "q": "Which metric should you sum across containers to estimate real memory pressure?",
          "options": [
            "VSZ",
            "RSS",
            "PSS",
            "VmPeak"
          ],
          "answer": 2,
          "explain": "PSS divides each shared page among its users. Summing RSS double-counts shared libraries and page-cache pages, and VSZ counts reservations that were never touched."
        }
      ],
      "quickbytes": [
        "Never size a container limit from VSZ; a 2 GiB VSZ process can hold 30 MiB resident.",
        "madvise(MADV_DONTNEED) on anonymous memory discards contents; on file-backed mappings it just drops the PTE.",
        "Watch major-faults, not total faults, when diagnosing a slow first request."
      ],
      "production": [
        "Memory alerts use cgroup memory.current and memory.events:max, not host-level free memory.",
        "Services that fork set MADV_DONTFORK on mappings the child must not inherit, such as device buffers.",
        "Startup warms hot pages deliberately (MAP_POPULATE or a touch loop) when the first request cannot afford major faults.",
        "Capacity reviews look at PSS from smaps_rollup so shared libraries are not charged once per worker."
      ],
      "crates": [
        "nix",
        "memmap2",
        "libc"
      ],
      "github": [
        {
          "name": "nix - mmap, madvise and munmap wrappers",
          "url": "https://github.com/nix-rust/nix"
        },
        {
          "name": "memmap2 - cross-platform memory mapping",
          "url": "https://github.com/RazrFalcon/memmap2-rs"
        }
      ],
      "pitfall": "Treating VSZ as memory usage: a Rust binary with a custom allocator that reserves a large arena shows tens of gigabytes of VSZ while using a few hundred megabytes of RSS, and an alarm built on that number pages the wrong team.",
      "resources": [
        {
          "title": "memmap2 crate documentation",
          "url": "https://docs.rs/memmap2/latest/memmap2/",
          "kind": "docs"
        },
        {
          "title": "nix crate documentation (mman module)",
          "url": "https://docs.rs/nix/latest/nix/",
          "kind": "docs"
        },
        {
          "title": "proc(5) - /proc/pid/statm, status and smaps",
          "url": "https://man7.org/linux/man-pages/man5/proc.5.html",
          "kind": "docs"
        },
        {
          "title": "nix source repository",
          "url": "https://github.com/nix-rust/nix",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "n03",
      "title": "The system allocator: tcache, arenas, and why RSS does not fall",
      "minutes": 100,
      "level": "advanced",
      "goal": "Explain how glibc malloc serves an allocation, why freed memory stays resident, and how to measure and tune it before reaching for jemalloc or mimalloc.",
      "sections": [
        {
          "h": "One malloc, three strategies",
          "p": [
            "glibc malloc is not one algorithm. A freed chunk goes first to a per-thread cache that holds a few chunks per size class with no locking at all; when that cache is full it lands in fastbins, smallbins or largebins, and contention there takes an arena lock. Small requests are carved from the heap with brk, while requests at or above mmap_threshold, 128 KiB by default, get their own anonymous mapping. The threshold is adaptive: it rises when freed mmapped blocks are reused, up to a 32 MiB cap.",
            "The consequence is that the size of an allocation decides whether memory can ever go back to the operating system. A freed mmapped block is unmapped immediately. A freed chunk below the threshold stays in the arena, reusable by the process but invisible to the kernel, which is why RSS after a burst looks like a leak when it is really a cache."
          ],
          "code": "use std::fs;\n\nfn rss_kib() -> u64 {\n    let status = fs::read_to_string(\"/proc/self/status\").unwrap();\n    status\n        .lines()\n        .find(|l| l.starts_with(\"VmRSS:\"))\n        .and_then(|l| l.split_whitespace().nth(1))\n        .and_then(|v| v.parse().ok())\n        .unwrap_or(0)\n}\n\nfn main() {\n    let before = rss_kib();\n    {\n        // 64 KiB each: below the 128 KiB mmap threshold, so these live in arenas.\n        let mut blocks: Vec<Vec<u8>> = Vec::with_capacity(2000);\n        for _ in 0..2000 {\n            let mut b = vec![0u8; 64 * 1024];\n            // Write one byte per page so the pages are actually faulted in.\n            for i in (0..b.len()).step_by(4096) {\n                b[i] = 1;\n            }\n            blocks.push(b);\n        }\n        println!(\"live:       +{} KiB\", rss_kib() - before);\n    }\n    println!(\"after free: +{} KiB\", rss_kib() - before);\n    // glibc only: musl has no malloc_trim, so this line needs a cfg or a shim there.\n    unsafe { libc::malloc_trim(0) };\n    println!(\"after trim: +{} KiB\", rss_kib() - before);\n}",
          "tip": "A plateau in RSS after a burst is a cache, not a leak. Compare it with live bytes from a heap profiler before filing the bug."
        },
        {
          "h": "Threads multiply arenas",
          "p": [
            "To avoid one global lock, glibc creates up to 8 arenas per core, and a thread is assigned to one on its first allocation. Each arena reserves a 64 MiB region on x86-64 and grows into it. A service that spawns 200 short-lived threads can therefore end up with dozens of arenas, each holding free chunks no other thread can use, and RSS that stays high long after the traffic spike.",
            "MALLOC_ARENA_MAX caps that growth at the cost of more contention, and malloc_trim returns free heap pages to the kernel. Both are blunt instruments: cap arenas too low and a many-threaded service serialises inside malloc; call trim in a hot path and the next allocation pays page faults to get the memory back. Measure, then choose the smallest change that moves the number you actually care about."
          ],
          "list": [
            "tcache: per-thread, lock-free, small, the first stop for every free",
            "arena: per-thread-group heap with its own lock and a 64 MiB reservation",
            "mmap threshold: 128 KiB by default and adaptive, the cutoff for returning memory",
            "malloc_trim: explicit return of free heap pages, never automatic"
          ],
          "tip": "Each arena shows up as a large anonymous mapping in smaps. Counting those mappings is the fastest way to confirm an arena problem."
        },
        {
          "h": "When to replace it, and how to prove it",
          "p": [
            "jemalloc and mimalloc add size classes, per-thread caches and better fragmentation behaviour, at the cost of a larger resident footprint and another dependency in the binary. For a single-threaded CLI the system allocator usually wins on both size and speed. For a service with many threads and variable-size allocations the win can be real, but it has to be measured on production-like traffic rather than on a microbenchmark that allocates in one size.",
            "The tools matter more than the choice. heaptrack and DHAT report allocation counts, sizes and lifetimes; smaps_rollup gives PSS without walking every mapping; MALLOC_PERTURB_ fills freed memory with a pattern so a use-after-free reads obviously wrong data. Swapping the allocator to fix a fragmentation problem you never measured is how a service acquires a second problem while keeping the first."
          ],
          "code": "# each arena reserves a 64 MiB region on x86-64; count them\npmap -x $PID | awk '$2 >= 65000 && $2 <= 65536' | wc -l\n\n# cap arenas and replay the same load\nMALLOC_ARENA_MAX=2 ./target/release/app\n\n# poison freed memory so a use-after-free reads garbage instead of stale data\nMALLOC_PERTURB_=165 ./target/release/app\n\n# resident, proportional and dirty totals without walking every VMA\ngrep -E '^(Rss|Pss|Private_Dirty):' /proc/self/smaps_rollup",
          "tip": "MALLOC_PERTURB_ costs speed and is for CI and canaries, not for steady-state production."
        }
      ],
      "exercise": {
        "prompt": "Measure retention by allocation size: allocate and free 2000 blocks of 64 KiB, then 200 blocks of 2 MiB, printing RSS before, after the free, and after malloc_trim. Explain which size returned memory to the kernel and why.",
        "starter": "use std::fs;\n\nfn rss_kib() -> u64 {\n    // TODO: parse VmRSS from /proc/self/status\n    0\n}\n\nfn trial(size: usize, count: usize) -> u64 {\n    // TODO: record RSS, allocate count blocks, drop them, record RSS again\n    0\n}\n\nfn main() {\n    println!(\"64 KiB x 2000 retains {} KiB\", trial(64 * 1024, 2000));\n    println!(\"2 MiB  x 200  retains {} KiB\", trial(2 * 1024 * 1024, 200));\n}",
        "hint": "Write one byte into each block so the pages are faulted in, otherwise RSS never grows and the experiment proves nothing. Call libc::malloc_trim(0) after dropping the blocks and print the RSS again.",
        "solution": "use std::fs;\n\nfn rss_kib() -> u64 {\n    let status = fs::read_to_string(\"/proc/self/status\").unwrap();\n    status\n        .lines()\n        .find(|l| l.starts_with(\"VmRSS:\"))\n        .and_then(|l| l.split_whitespace().nth(1))\n        .and_then(|v| v.parse().ok())\n        .unwrap_or(0)\n}\n\nfn trial(size: usize, count: usize) -> (u64, u64) {\n    let before = rss_kib();\n    {\n        let mut blocks: Vec<Vec<u8>> = Vec::with_capacity(count);\n        for _ in 0..count {\n            let mut b = vec![0u8; size];\n            for i in (0..size).step_by(4096) {\n                b[i] = 1;\n            }\n            blocks.push(b);\n        }\n        println!(\"  live: +{} KiB\", rss_kib() - before);\n    }\n    let after_free = rss_kib() - before;\n    // glibc only; musl targets need a cfg gate here.\n    unsafe { libc::malloc_trim(0) };\n    (after_free, rss_kib() - before)\n}\n\nfn main() {\n    let (a, a_trim) = trial(64 * 1024, 2000);\n    println!(\"64 KiB x 2000: {a} KiB retained, {a_trim} after trim\");\n    let (b, b_trim) = trial(2 * 1024 * 1024, 200);\n    println!(\"2 MiB x 200:   {b} KiB retained, {b_trim} after trim\");\n}"
      },
      "questions": [
        {
          "q": "Why does a freed 2 MiB allocation return memory to the kernel while a freed 64 KiB one usually does not?",
          "options": [
            "The kernel only tracks mappings larger than 1 MiB",
            "Allocations at or above mmap_threshold get their own mapping, which is unmapped on free",
            "glibc compacts small allocations only during malloc_trim",
            "Small allocations are always leaked by design"
          ],
          "answer": 1,
          "explain": "The threshold, 128 KiB by default, decides the strategy. Above it each request is an anonymous mapping that goes away on free; below it the chunk returns to an arena and stays resident."
        },
        {
          "q": "A service peaks at 4 GiB and settles at 1.2 GiB RSS after traffic drops, with no growth afterwards. What is the most likely explanation?",
          "options": [
            "A use-after-free is corrupting the heap",
            "Per-thread arenas are holding free chunks that the kernel cannot reclaim",
            "The page cache is charging the process for file pages",
            "jemalloc was linked in by accident"
          ],
          "answer": 1,
          "explain": "A stable plateau is a cache, not a leak. Freed chunks below the mmap threshold stay in arenas until malloc_trim or reuse; a leak would keep growing."
        },
        {
          "q": "What should you do before switching a service to jemalloc?",
          "options": [
            "Set MALLOC_ARENA_MAX=1 to establish a baseline",
            "Measure allocation sizes, lifetimes and RSS with a heap profiler on production-like traffic",
            "Disable tcache with GLIBC_TUNABLES",
            "Rebuild with LTO so allocation sites inline"
          ],
          "answer": 1,
          "explain": "Without a profile you cannot tell fragmentation from retention from a real leak, and you cannot prove the new allocator helped. Measurement first, dependency second."
        }
      ],
      "quickbytes": [
        "Freeing a chunk below mmap_threshold returns it to the arena, not to the kernel.",
        "Cap arenas with MALLOC_ARENA_MAX only after measuring contention; too low serialises malloc.",
        "malloc_trim(0) returns free heap pages, but the next allocation pays the page faults."
      ],
      "production": [
        "RSS alerts are paired with a heap profile so a retained cache is not paged as a leak.",
        "Services with many threads set MALLOC_ARENA_MAX explicitly and record it in the deployment config.",
        "MALLOC_PERTURB_ is enabled in canary and sanitizer runs to catch use-after-free reads.",
        "Allocator changes ship with before/after RSS and p99 latency measured on production-like traffic."
      ],
      "crates": [
        "libc",
        "nix",
        "mimalloc"
      ],
      "github": [
        {
          "name": "mimalloc - compact general purpose allocator",
          "url": "https://github.com/microsoft/mimalloc"
        },
        {
          "name": "jemalloc - general purpose allocator",
          "url": "https://github.com/jemalloc/jemalloc"
        }
      ],
      "pitfall": "Reading RSS as memory in use and concluding there is a leak: glibc keeps freed chunks in per-thread arenas, so RSS plateaus instead of falling, and a real leak stays invisible until you compare RSS with live bytes from a profiler.",
      "resources": [
        {
          "title": "malloc(3) - allocation, free and trimming behaviour",
          "url": "https://man7.org/linux/man-pages/man3/malloc.3.html",
          "kind": "docs"
        },
        {
          "title": "mallopt(3) - arena limits and mmap threshold knobs",
          "url": "https://man7.org/linux/man-pages/man3/mallopt.3.html",
          "kind": "docs"
        },
        {
          "title": "libc crate documentation",
          "url": "https://docs.rs/libc/latest/libc/",
          "kind": "docs"
        },
        {
          "title": "jemalloc source repository",
          "url": "https://github.com/jemalloc/jemalloc",
          "kind": "repo"
        },
        {
          "title": "Jon Gjengset - long-form Rust systems streams",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ]
    },
    {
      "id": "n04",
      "title": "mmap: shared, private, and the page cache in the middle",
      "minutes": 90,
      "level": "advanced",
      "goal": "Map files and anonymous memory with the right flags, know exactly what msync guarantees, and avoid the SIGBUS that comes with mapping a file you do not control.",
      "sections": [
        {
          "h": "Two flags decide everything",
          "p": [
            "MAP_SHARED makes writes visible to every other mapping of the same file and eventually to the file itself. MAP_PRIVATE gives you copy-on-write pages: your writes are invisible to everyone else and are lost on unmap. The flags are not a performance hint, they are the memory model, and mixing them up produces data loss that no test catches until production.",
            "The mapping is also lazy in a second sense: mmap records the VMA, and pages arrive on fault from the page cache. If another process already read the file, you map its cached pages and pay no I/O at all. That is why the first read of a large file is slow and every later read in the same boot is fast, even from a different process."
          ],
          "code": "use memmap2::MmapOptions;\nuse std::fs::OpenOptions;\n\nfn main() -> std::io::Result<()> {\n    let path = \"/tmp/ra-mmap-demo.bin\";\n    let file = OpenOptions::new()\n        .read(true)\n        .write(true)\n        .create(true)\n        .truncate(true)\n        .open(path)?;\n\n    // A mapping cannot extend a file: set the length first.\n    file.set_len(4096)?;\n\n    let mut mmap = unsafe { MmapOptions::new().len(4096).map_mut(&file)? };\n    mmap[0..5].copy_from_slice(b\"hello\");\n    mmap.flush()?; // msync(MS_SYNC): dirty pages reach the file\n\n    drop(mmap);\n    let bytes = std::fs::read(path)?;\n    println!(\"{} bytes, starts with {:?}\", bytes.len(), &bytes[0..5]);\n    Ok(())\n}",
          "tip": "mmap never grows a file. Truncate to the size you need first, or the pages past EOF will fault with SIGBUS."
        },
        {
          "h": "What msync actually guarantees",
          "p": [
            "Writing through a shared mapping dirties page-cache pages. Those pages are visible to every reader immediately, because reads also come from the cache; nothing has necessarily reached the disk. msync with MS_SYNC waits for writeback of the range, which is the mmap equivalent of fsync for data, but it does not flush the file metadata or the directory entry.",
            "Unmapping does not flush. Neither does dropping the last reference. The kernel writes dirty pages back on its own schedule, which is fine for caches and fatal for anything that must survive a power cut. If durability matters, the same rules as write(2) apply: fsync the file, then fsync the directory if you created or renamed an entry."
          ],
          "list": [
            "MAP_SHARED + msync: other processes see writes immediately, disk catches up later",
            "MAP_PRIVATE: writes are COW, invisible outside, discarded on unmap",
            "MAP_POPULATE: pre-fault the range, turning faults into mmap latency",
            "O_DIRECT on the fd bypasses the page cache but demands alignment"
          ],
          "tip": "msync(MS_ASYNC) only schedules writeback. If you need the data on stable storage before returning, MS_SYNC plus fsync is the combination."
        },
        {
          "h": "The failure modes are signals, not errors",
          "p": [
            "A mapping can outlive the file it maps. Truncate the file below the mapped range and the next access to a vanished page raises SIGBUS, which in Rust looks like an immediate abort with no unwind and no error value. Code that maps files it does not exclusively own needs a signal handler, a copy into anonymous memory, or a lock that prevents truncation.",
            "The second trap is permissions. Mapping a file opened O_RDONLY with PROT_WRITE and MAP_SHARED fails with EACCES at mmap time, which is the good outcome. Mapping it MAP_PRIVATE succeeds, because COW only needs a readable backing object, and the writes are silently private. Both behaviours are correct and both surprise people."
          ],
          "code": "# watch the mapping appear, grow on fault, and survive truncation\nstrace -e trace=mmap,msync,munmap ./target/release/app\ncat /proc/self/maps | grep -i mmap-demo\n\n# force writeback of one file's dirty pages\nsync /tmp/ra-mmap-demo.bin\n\n# see whether the pages are in cache after the process exits\nvmtouch -v /tmp/ra-mmap-demo.bin\n\n# did the dirty pages actually reach disk?\ngrep -E '^(Dirty|Writeback):' /proc/meminfo",
          "tip": "SIGBUS on a mapping is almost always a truncated file or a full filesystem on a shared mapping. Check the file size before blaming your pointer arithmetic."
        }
      ],
      "exercise": {
        "prompt": "Build a tiny append-only log: a file pre-sized to 1 MiB, mapped MAP_SHARED, where each record is a u32 length followed by bytes. Append ten records, flush, then read the file back with std::fs and verify the bytes are there before the process exits.",
        "starter": "use memmap2::MmapMut;\nuse std::fs::OpenOptions;\n\nstruct Log { map: MmapMut, used: usize }\n\nimpl Log {\n    fn open(path: &str, capacity: usize) -> std::io::Result<Self> {\n        // TODO: create/truncate to capacity, map_mut, start used at 0.\n        todo!()\n    }\n    fn append(&mut self, payload: &[u8]) -> std::io::Result<()> {\n        // TODO: write u32 length, then payload, advance used, bounds-check.\n        todo!()\n    }\n}",
        "hint": "Write the length with to_le_bytes and copy the payload after it. Bounds-check before writing so a full log returns an error instead of corrupting the next record. Call flush() before reading the file with std::fs.",
        "solution": "use memmap2::MmapMut;\nuse std::fs::OpenOptions;\nuse std::io;\n\nstruct Log {\n    map: MmapMut,\n    used: usize,\n}\n\nimpl Log {\n    fn open(path: &str, capacity: usize) -> io::Result<Self> {\n        let file = OpenOptions::new()\n            .read(true)\n            .write(true)\n            .create(true)\n            .truncate(true)\n            .open(path)?;\n        file.set_len(capacity as u64)?;\n        let map = unsafe { memmap2::MmapOptions::new().len(capacity).map_mut(&file)? };\n        Ok(Self { map, used: 0 })\n    }\n\n    fn append(&mut self, payload: &[u8]) -> io::Result<()> {\n        let need = 4 + payload.len();\n        if self.used + need > self.map.len() {\n            return Err(io::Error::new(io::ErrorKind::WriteZero, \"log full\"));\n        }\n        let start = self.used;\n        self.map[start..start + 4].copy_from_slice(&(payload.len() as u32).to_le_bytes());\n        self.map[start + 4..start + need].copy_from_slice(payload);\n        self.used += need;\n        Ok(())\n    }\n}\n\nfn main() -> io::Result<()> {\n    let path = \"/tmp/ra-log.bin\";\n    let mut log = Log::open(path, 1024 * 1024)?;\n    for i in 0..10u32 {\n        log.append(format!(\"record-{i}\").as_bytes())?;\n    }\n    log.map.flush()?;\n\n    let bytes = std::fs::read(path)?;\n    assert_eq!(&bytes[4..12], b\"record-0\");\n    println!(\"first record present, log used {} bytes\", log.used);\n    Ok(())\n}"
      },
      "questions": [
        {
          "q": "Process A maps a file MAP_PRIVATE and writes to it. What does process B, mapping the same file MAP_SHARED, observe?",
          "options": [
            "The write, because both mappings share the page cache",
            "Nothing: the write is copy-on-write in A private pages",
            "A SIGBUS, because the file is mapped twice with different flags",
            "The write only after A calls msync"
          ],
          "answer": 1,
          "explain": "MAP_PRIVATE takes a COW copy on write. The file and every shared mapping keep the original bytes, and A loses its edits when the mapping is dropped."
        },
        {
          "q": "A file mapped MAP_SHARED is truncated by another process. What happens on the next access to a page past the new end?",
          "options": [
            "read returns EIO and write returns ENOSPC",
            "The mapping is silently remapped to the shorter file",
            "The process receives SIGBUS, which usually aborts it",
            "The kernel extends the file back to the mapped length"
          ],
          "answer": 2,
          "explain": "The page table entry points at a page that no longer has a backing block. There is no error return path for a load, so the kernel raises SIGBUS."
        },
        {
          "q": "Which call makes previously written mmap data durable across a power loss?",
          "options": [
            "munmap, which writes dirty pages before returning",
            "msync with MS_ASYNC, which blocks until writeback completes",
            "msync with MS_SYNC, followed by fsync for metadata if needed",
            "Closing the file descriptor flushes all dirty pages"
          ],
          "answer": 2,
          "explain": "Only MS_SYNC waits for writeback. Unmap, close and MS_ASYNC schedule work but do not guarantee it has reached stable storage."
        }
      ],
      "quickbytes": [
        "set_len before map_mut; a mapping never extends the file and touching past EOF is SIGBUS.",
        "mmap + sequential scan is faster than read() for large files only when you avoid faulting pages you never use.",
        "Use MAP_POPULATE for latency-sensitive startup reads, and measure the added mmap time honestly."
      ],
      "production": [
        "Files that are mapped are never truncated while mapped; rotation writes a new file and renames instead.",
        "Shared mappings are flushed with MS_SYNC before the process acknowledges a write to a client.",
        "Large mappings are checked against RLIMIT_AS and the 32-bit address space when the binary may run on 32-bit targets.",
        "SIGBUS handlers are installed where mappings are unavoidable, and they log the mapping range before aborting."
      ],
      "crates": [
        "memmap2",
        "nix",
        "libc"
      ],
      "github": [
        {
          "name": "memmap2 - cross-platform memory mapped buffers",
          "url": "https://github.com/RazrFalcon/memmap2-rs"
        },
        {
          "name": "nix - mman wrappers",
          "url": "https://github.com/nix-rust/nix"
        }
      ],
      "pitfall": "Assuming a shared mapping is durable because another process can see the write: both processes read the same page cache, and a power loss before writeback loses the data even though every reader agreed it was there.",
      "resources": [
        {
          "title": "mmap(2) - mapping files and anonymous memory",
          "url": "https://man7.org/linux/man-pages/man2/mmap.2.html",
          "kind": "docs"
        },
        {
          "title": "msync(2) - synchronise a file with a mapping",
          "url": "https://man7.org/linux/man-pages/man2/msync.2.html",
          "kind": "docs"
        },
        {
          "title": "memmap2 crate documentation",
          "url": "https://docs.rs/memmap2/latest/memmap2/",
          "kind": "docs"
        },
        {
          "title": "memmap2 source repository",
          "url": "https://github.com/RazrFalcon/memmap2-rs",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "n05",
      "title": "io_uring: shared rings and completion-based I/O",
      "minutes": 120,
      "level": "industry",
      "goal": "Submit reads through the io-uring crate, explain the SQ/CQ ring protocol and its memory ordering, and judge when io_uring beats epoll and when it quietly loses.",
      "sections": [
        {
          "h": "Two rings, mapped into your address space",
          "p": [
            "io_uring_setup(entries, params) returns a file descriptor and fills in offsets. You then mmap three regions from that descriptor: the submission ring, the completion ring, and the array of 64-byte submission queue entries. With IORING_FEAT_SINGLE_MMAP the two rings share one mapping, but the SQE array is always separate. From then on, submission is a store to the SQ tail and a call to io_uring_enter.",
            "The protocol is single-producer, single-consumer per ring with explicit acquire and release ordering. The application writes an SQE, fills the index into the SQ array, then publishes by advancing the tail with release semantics. The kernel consumes up to the tail and advances the head. Completions go the other way: the kernel writes a 16-byte CQE containing your user_data, a result that is a byte count or a negative errno, and flags.",
            "Because the kernel can complete a request after your function has returned, the buffer and the file descriptor must outlive the request, not the call. The Rust crate cannot check this for you: pushing an entry is unsafe precisely because the compiler has no way to tie the lifetime of a raw pointer to the completion."
          ],
          "code": "use io_uring::{opcode, types, IoUring};\nuse std::fs::File;\nuse std::os::fd::AsRawFd;\n\nfn main() -> std::io::Result<()> {\n    let file = File::open(\"Cargo.toml\")?;\n    let mut ring = IoUring::new(8)?;\n    let mut buf = vec![0u8; 4096];\n\n    let read = opcode::Read::new(\n        types::Fd(file.as_raw_fd()),\n        buf.as_mut_ptr(),\n        buf.len() as u32,\n    )\n    .offset(0)\n    .build()\n    .user_data(0x42);\n\n    // Safety: buf and file outlive every submission until the CQE is reaped.\n    unsafe {\n        ring.submission().push(&read).expect(\"queue full\");\n    }\n    ring.submit()?;\n\n    let cqe = ring.completion().next().expect(\"no completion\");\n    assert_eq!(cqe.user_data(), 0x42);\n    let res = cqe.result();\n    if res < 0 {\n        return Err(std::io::Error::from_raw_os_error(-res));\n    }\n    println!(\"read {} bytes: {:?}\", res, &buf[..res as usize]);\n    Ok(())\n}",
          "tip": "A ring entry is a promise about memory. If the Vec is dropped before the CQE arrives, the kernel writes into freed memory and you get corruption, not an error."
        },
        {
          "h": "user_data is your only correlation handle",
          "p": [
            "Completions can arrive out of order, and with IOSQE_IO_LINK or multishot operations they may not correspond one-to-one with submissions. The 64-bit user_data field is how you find your state again: an index into a slab, a pointer to a request struct, or a packed opcode plus slot. Applications that assume completion order is submission order work until the first operation fails and the rest of a linked chain is cancelled.",
            "Two features change the cost model. Registered files replace the per-request descriptor lookup with an index, and registered buffers pin memory so the kernel skips the get_user_pages walk on every I/O. Both require the buffer or descriptor to be stable for the ring lifetime, which is why production users allocate them once at startup and reuse them."
          ],
          "list": [
            "IOSQE_IO_LINK: cancel the rest of the chain if one request fails",
            "IORING_SETUP_SQPOLL: a kernel thread polls the SQ, so submission needs no syscall",
            "IORING_SETUP_IOPOLL: busy-wait for NVMe completions, lower latency, burns a core",
            "IORING_REGISTER_BUFFERS: pin once, submit many times"
          ],
          "tip": "Use a slab keyed by user_data, not a pointer to a stack local. A CQE that outlives its stack frame is the most common io_uring bug in Rust."
        },
        {
          "h": "Where it wins, and where it does not",
          "p": [
            "epoll reports readiness, and regular files are always ready, so epoll-based runtimes push file I/O onto a thread pool. io_uring reports completion, so a single thread can keep hundreds of reads in flight without a thread per request. That is the structural win: fewer threads, less stack memory, and no wakeup per operation.",
            "The costs are real. Every submission has overhead, so tiny operations are slower than a plain read; a syscall per operation remains the baseline unless SQPOLL is enabled. io_uring_setup is also a privileged, security-sensitive interface: many container seccomp profiles block it, /proc/sys/kernel/io_uring_disabled can turn it off system-wide, and older kernels lack the opcodes you want. Detect support with io_uring_probe rather than assuming it."
          ],
          "code": "# is io_uring available to this process at all?\ncat /proc/sys/kernel/io_uring_disabled   # 0 = enabled, 1 = CAP_SYS_ADMIN, 2 = off\nuname -r                                  # 5.6 is the practical floor, 6.x for the good opcodes\n\n# count io_uring syscalls and see which opcodes a binary actually uses\nstrace -f -e trace=io_uring_setup,io_uring_enter,io_uring_register ./target/release/app 2>&1 | head\n\n# check that the ring was created with the features you expect\ngrep -i io_uring /proc/self/status\n\n# the sysctl that decides whether unprivileged rings are allowed\nsysctl kernel.io_uring_disabled",
          "tip": "Measure the crossover on your hardware. For small reads on a warm page cache, a plain pread often beats a ring submission by a wide margin."
        }
      ],
      "exercise": {
        "prompt": "Extend the single-read example to submit four reads of the same file at offsets 0, 4096, 8192 and 12288 in one submit call, then reap all four completions and verify that the bytes read match a plain pread of each range.",
        "starter": "use io_uring::{opcode, types, IoUring};\nuse std::fs::File;\nuse std::os::fd::AsRawFd;\n\nfn main() -> std::io::Result<()> {\n    let file = File::open(\"Cargo.toml\")?;\n    let mut ring = IoUring::new(8)?;\n    let mut bufs = vec![vec![0u8; 4096]; 4];\n\n    // TODO: push four opcode::Read entries, each with its own buffer and\n    // user_data equal to its index, then submit once and reap four CQEs.\n    Ok(())\n}",
        "hint": "Keep bufs alive until every CQE is reaped, and store the completion count outside the loop. user_data tells you which buffer to inspect; a negative result means that request failed and the others may still have completed.",
        "solution": "use io_uring::{opcode, types, IoUring};\nuse std::fs::File;\nuse std::os::fd::AsRawFd;\n\nfn main() -> std::io::Result<()> {\n    let file = File::open(\"Cargo.toml\")?;\n    let mut ring = IoUring::new(8)?;\n    let mut bufs = vec![vec![0u8; 4096]; 4];\n    let fd = types::Fd(file.as_raw_fd());\n\n    for (i, buf) in bufs.iter_mut().enumerate() {\n        let read = opcode::Read::new(fd, buf.as_mut_ptr(), buf.len() as u32)\n            .offset((i * 4096) as u64)\n            .build()\n            .user_data(i as u64);\n        unsafe { ring.submission().push(&read).expect(\"queue full\") };\n    }\n    ring.submit()?;\n\n    let mut done = 0;\n    while done < 4 {\n        let cqe = ring.completion().next().expect(\"missing completion\");\n        let idx = cqe.user_data() as usize;\n        let res = cqe.result();\n        if res < 0 {\n            eprintln!(\"request {idx} failed: {:?}\", std::io::Error::from_raw_os_error(-res));\n        } else {\n            println!(\"request {idx}: {res} bytes\");\n        }\n        done += 1;\n    }\n    Ok(())\n}"
      },
      "questions": [
        {
          "q": "Why does an epoll-based runtime need a thread pool for regular file reads?",
          "options": [
            "Files are always reported ready, so epoll cannot tell you when a read would not block",
            "epoll cannot watch file descriptors opened on regular files at all",
            "The kernel refuses to attach file descriptors above 1024 to an epoll set",
            "File reads require a completion queue, which epoll does not provide"
          ],
          "answer": 0,
          "explain": "Readiness for a regular file is almost always true because the page cache answers immediately, so a non-blocking read still blocks on I/O. Threads are the workaround; io_uring replaces it with completions."
        },
        {
          "q": "What does the user_data field of an SQE do?",
          "options": [
            "It stores the errno the kernel should return on failure",
            "It is copied into the CQE so you can correlate a completion with your request state",
            "It selects the io_uring opcode for the submission",
            "It sets the priority of the request in the block layer"
          ],
          "answer": 1,
          "explain": "Completions can arrive out of order and linked chains can be cancelled, so user_data is the only reliable way back to the request you submitted."
        },
        {
          "q": "A submission returns -EOPNOTSUPP from io_uring_enter. What is the most likely cause?",
          "options": [
            "The buffer was not page-aligned",
            "The kernel is older than the opcode, or the opcode was rejected by the ring restrictions",
            "The ring has more entries than the process file descriptor limit",
            "The file descriptor was opened with O_CLOEXEC"
          ],
          "answer": 1,
          "explain": "Opcode availability is kernel-version and feature dependent. Probe with io_uring_probe and fall back to pread rather than assuming every 5.x kernel supports every op."
        }
      ],
      "quickbytes": [
        "Reap every CQE before dropping the buffers; the kernel does not know when your Vec goes away.",
        "Check /proc/sys/kernel/io_uring_disabled and your seccomp profile before designing around io_uring.",
        "Registered buffers pay off only when the same memory is reused for many operations."
      ],
      "production": [
        "The ring size is sized from measured queue depth, and a full SQ is handled by submitting and retrying rather than panicking.",
        "Every completion path converts a negative result into an error and accounts for cancelled linked requests.",
        "The service falls back to pread or spawn_blocking when io_uring_setup fails, and logs which path it took.",
        "Kernel version and seccomp profile are part of the deployment contract, not an afterthought in the README."
      ],
      "crates": [
        "io-uring",
        "tokio-uring",
        "libc"
      ],
      "github": [
        {
          "name": "io-uring - the low-level Rust interface",
          "url": "https://github.com/tokio-rs/io-uring"
        },
        {
          "name": "liburing - reference implementation and man pages",
          "url": "https://github.com/axboe/liburing"
        }
      ],
      "pitfall": "Dropping or reallocating a buffer before its completion arrives: the kernel writes into freed memory, so the failure surfaces as heap corruption in an unrelated allocation rather than as an I/O error.",
      "resources": [
        {
          "title": "io_uring_setup(2) - ring layout, flags and features",
          "url": "https://man7.org/linux/man-pages/man2/io_uring_setup.2.html",
          "kind": "docs"
        },
        {
          "title": "io-uring crate documentation",
          "url": "https://docs.rs/io-uring/latest/io_uring/",
          "kind": "docs"
        },
        {
          "title": "io-uring source repository",
          "url": "https://github.com/tokio-rs/io-uring",
          "kind": "repo"
        },
        {
          "title": "liburing - reference implementation and tests",
          "url": "https://github.com/axboe/liburing",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "n06",
      "title": "epoll and event loops: readiness, edges, and EAGAIN",
      "minutes": 95,
      "level": "advanced",
      "goal": "Drive epoll correctly in level and edge mode, explain what tokio reactor actually does per wakeup, and diagnose the stalls caused by not draining a socket.",
      "sections": [
        {
          "h": "An interest list and a ready list",
          "p": [
            "An epoll instance holds two things: the set of file descriptors you registered, and the subset that currently has events. epoll_ctl adds, modifies or removes interest; epoll_wait copies ready entries into your buffer. The kernel maintains the ready list incrementally, so the cost of a wait is proportional to the number of ready descriptors, not to the size of the interest list.",
            "The key is the pair of file descriptor number and open file description, not the number alone. That is why closing a descriptor does not necessarily remove it from the interest list if another descriptor still refers to the same open file description, and why EPOLL_CTL_DEL before close is the habit that avoids stale events. An epoll descriptor is itself pollable, which is how event loops nest."
          ],
          "code": "use mio::net::TcpListener;\nuse mio::{Events, Interest, Poll, Token};\nuse std::io::{ErrorKind, Read, Write};\n\nconst SERVER: Token = Token(0);\n\nfn main() -> std::io::Result<()> {\n    let mut poll = Poll::new()?;\n    let mut events = Events::with_capacity(128);\n    let mut server = TcpListener::bind(\"127.0.0.1:7878\".parse().unwrap())?;\n    poll.registry().register(&mut server, SERVER, Interest::READABLE)?;\n\n    loop {\n        poll.poll(&mut events, None)?;\n        for event in events.iter() {\n            if event.token() != SERVER {\n                continue;\n            }\n            // Edge semantics: accept until EAGAIN, not once per event.\n            loop {\n                match server.accept() {\n                    Ok((mut stream, _addr)) => {\n                        let mut buf = [0u8; 512];\n                        match stream.read(&mut buf) {\n                            Ok(0) => break,\n                            Ok(n) => {\n                                let _ = stream.write_all(&buf[..n]);\n                            }\n                            Err(e) if e.kind() == ErrorKind::WouldBlock => break,\n                            Err(e) => return Err(e),\n                        }\n                    }\n                    Err(e) if e.kind() == ErrorKind::WouldBlock => break,\n                    Err(e) => return Err(e),\n                }\n            }\n        }\n    }\n}",
          "tip": "mio sockets are non-blocking already. If you hand a blocking descriptor to an event loop, one slow peer freezes every other connection."
        },
        {
          "h": "Edge triggering is a contract, not a flag",
          "p": [
            "In level mode, epoll_wait keeps reporting a descriptor while data remains, so a forgotten byte is retried on the next iteration. In edge mode you are told only that the state changed. If you read 1 KiB out of a 2 KiB buffer and return to epoll_wait, nothing will wake you again and the connection hangs with data sitting in the kernel.",
            "The contract has three parts: descriptors are non-blocking, you read or write until EAGAIN, and you keep per-connection state so a partial write can resume. EPOLLONESHOT disables the descriptor after one event, which forces a single-threaded owner to rearm with EPOLL_CTL_MOD; it is the usual fix for two workers processing the same socket. EPOLLEXCLUSIVE reduces the thundering herd when many processes share a listening socket."
          ],
          "list": [
            "Read until EAGAIN, then return to the loop",
            "On write, queue the remainder and wait for writability",
            "Rearm with MOD after EPOLLONESHOT",
            "Use EPOLLEXCLUSIVE on shared listeners, not on every socket"
          ],
          "tip": "A hang with data in the socket buffer and no CPU use is the signature of edge-triggered without draining. strace shows one epoll_wait and then silence."
        },
        {
          "h": "What tokio actually does with epoll",
          "p": [
            "tokio does not have a thread per connection. Its reactor owns one epoll instance per runtime worker, registered through mio, and each readiness event wakes the task whose waker was stored for that descriptor. A task that gets WouldBlock registers interest, yields, and is woken when epoll reports the descriptor again. That is why an async read is cheap when idle and why blocking inside a task stalls an entire worker thread.",
            "Files break the model because they are always ready, so tokio::fs and tokio::net are not the same shape: file operations are dispatched to spawn_blocking. Understanding this explains a common production surprise, where an async service with heavy file I/O needs a much larger blocking pool than its socket concurrency suggests."
          ],
          "code": "# per-process epoll wait counts and wakeups\nperf stat -e syscalls:sys_enter_epoll_wait,syscalls:sys_enter_epoll_ctl -p $PID sleep 5\n\n# which descriptors are registered on the process epoll instance\nls -l /proc/$PID/fd | wc -l\ncat /proc/$PID/fdinfo/$(ls -l /proc/$PID/fd | awk '/eventpoll/ {print $9}' | head -1)\n\n# blocked-in-epoll threads during a stall\ncat /proc/$PID/task/*/wchan | sort | uniq -c\n\n# listen-queue overflow shows up as drops, not as an epoll error\nnstat -az TcpExtListenDrops TcpExtListenOverflows",
          "tip": "When a tokio service stops responding, check wchan: threads parked in ep_poll are idle, threads in futex_wait are contending on a lock you took inside async code."
        }
      ],
      "exercise": {
        "prompt": "Write a level-triggered epoll loop with nix that accepts connections and echoes one read per event, then convert it to edge-triggered with a drain loop. Explain why the first version survives a partial read and the second one hangs without the loop.",
        "starter": "use nix::sys::epoll::{Epoll, EpollCreateFlags, EpollEvent, EpollFlags, EpollTimeout};\n\nfn main() -> nix::Result<()> {\n    let epoll = Epoll::new(EpollCreateFlags::EPOLL_CLOEXEC)?;\n    // TODO: bind a TcpListener, register it EPOLLIN, then loop on epoll.wait.\n    // Level version: one accept and one read per event.\n    // Edge version: add EPOLLET and loop until WouldBlock.\n    Ok(())\n}",
        "hint": "nix::sys::epoll::Epoll::wait takes a timeout and returns events with data() carrying the token you stored. Set the listener non-blocking with fcntl O_NONBLOCK, otherwise accept blocks after the first connection and the loop never returns.",
        "solution": "use nix::fcntl::{fcntl, FcntlArg, OFlag};\nuse nix::sys::epoll::{Epoll, EpollCreateFlags, EpollEvent, EpollFlags, EpollTimeout};\nuse std::io::Read;\nuse std::os::fd::AsFd;\n\nfn main() -> nix::Result<()> {\n    let listener = std::net::TcpListener::bind(\"127.0.0.1:7879\").unwrap();\n    let raw = listener.as_fd();\n    fcntl(raw, FcntlArg::F_SETFL(OFlag::O_NONBLOCK))?;\n\n    let epoll = Epoll::new(EpollCreateFlags::EPOLL_CLOEXEC)?;\n    // EPOLLET is the only difference between the two versions.\n    let mut ev = EpollEvent::new(EpollFlags::EPOLLIN | EpollFlags::EPOLLET, 1);\n    epoll.add(raw, ev)?;\n\n    let mut events = [EpollEvent::new(EpollFlags::empty(), 0); 8];\n    loop {\n        let n = epoll.wait(&mut events, EpollTimeout::NONE)?;\n        for e in &events[..n] {\n            if e.data() != 1 {\n                continue;\n            }\n            loop {\n                match listener.accept() {\n                    Ok((mut stream, _)) => {\n                        stream.set_nonblocking(true).unwrap();\n                        let mut buf = [0u8; 1024];\n                        loop {\n                            match stream.read(&mut buf) {\n                                Ok(0) => break,\n                                Ok(n) => {\n                                    use std::io::Write;\n                                    let _ = stream.write_all(&buf[..n]);\n                                }\n                                Err(ref err) if err.kind() == std::io::ErrorKind::WouldBlock => break,\n                                Err(_) => break,\n                            }\n                        }\n                    }\n                    Err(ref err) if err.kind() == std::io::ErrorKind::WouldBlock => break,\n                    Err(_) => break,\n                }\n            }\n            ev.set_flags(EpollFlags::EPOLLIN | EpollFlags::EPOLLET);\n        }\n    }\n}"
      },
      "questions": [
        {
          "q": "An edge-triggered connection reads 100 bytes of a 500-byte payload and returns to epoll_wait. What happens next?",
          "options": [
            "epoll_wait reports the descriptor again because 400 bytes remain",
            "epoll_wait blocks; the remaining bytes sit in the socket buffer until more arrive",
            "The kernel sends SIGIO to the process",
            "The socket is closed by the kernel after the partial read"
          ],
          "answer": 1,
          "explain": "Edge mode reports transitions. The transition already happened, so nothing wakes the loop until new data arrives or the peer closes. Draining to EAGAIN is mandatory."
        },
        {
          "q": "Why must a descriptor registered with EPOLLET be non-blocking?",
          "options": [
            "epoll_ctl rejects blocking descriptors with EINVAL",
            "A blocking read after the last byte would suspend the whole event loop thread",
            "Non-blocking mode is required for EPOLLONESHOT to work",
            "The kernel only queues edge events for non-blocking sockets"
          ],
          "answer": 1,
          "explain": "Draining to EAGAIN means the last read has no data left. On a blocking descriptor that read never returns, so the thread that serves every other connection stops."
        },
        {
          "q": "Two worker processes accept from the same listening socket and every connection wakes both. Which flag addresses this?",
          "options": [
            "EPOLLET",
            "EPOLLONESHOT",
            "EPOLLEXCLUSIVE",
            "EPOLLWAKEUP"
          ],
          "answer": 2,
          "explain": "EPOLLEXCLUSIVE wakes one waiter per event instead of all of them. EPOLLONESHOT is about disarming a single registration, not about sharing a listener."
        }
      ],
      "quickbytes": [
        "Always read until EAGAIN in edge mode; one read per event is a latent hang.",
        "EPOLL_CTL_DEL before close prevents events for a descriptor number that got reused.",
        "A task blocked on a mutex inside async code stalls a whole tokio worker, not just itself."
      ],
      "production": [
        "Every socket in the loop is explicitly non-blocking, asserted in a test rather than assumed from the library.",
        "Per-connection write buffers are bounded, and a slow reader is disconnected instead of growing memory without limit.",
        "The accept path has a cap per wakeup so one flood cannot starve other descriptors.",
        "Metrics count epoll wakeups per second and the number of registered descriptors, so a leak shows up before the fd limit."
      ],
      "crates": [
        "mio",
        "nix",
        "tokio"
      ],
      "github": [
        {
          "name": "mio - low-level readiness-based I/O",
          "url": "https://github.com/tokio-rs/mio"
        },
        {
          "name": "nix - epoll wrappers",
          "url": "https://github.com/nix-rust/nix"
        }
      ],
      "pitfall": "Level-triggered code that accidentally registers EPOLLET during a refactor: the loop still works under load and hangs only when a read returns short, which is exactly the case tests rarely generate.",
      "resources": [
        {
          "title": "epoll(7) - level and edge triggering in detail",
          "url": "https://man7.org/linux/man-pages/man7/epoll.7.html",
          "kind": "docs"
        },
        {
          "title": "mio crate documentation",
          "url": "https://docs.rs/mio/latest/mio/",
          "kind": "docs"
        },
        {
          "title": "mio source repository",
          "url": "https://github.com/tokio-rs/mio",
          "kind": "repo"
        },
        {
          "title": "Tokio tutorial - the runtime and reactors",
          "url": "https://tokio.rs/tokio/tutorial",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "n07",
      "title": "eBPF: verifier-bounded programs inside the kernel",
      "minutes": 120,
      "level": "industry",
      "goal": "Load a kprobe with aya, share counters through a map, and predict what the verifier will reject before you ever run the loader.",
      "sections": [
        {
          "h": "A virtual machine with a bouncer",
          "p": [
            "eBPF is a register machine with eleven registers, a 512-byte stack and no ability to call arbitrary kernel functions. Programs are attached to hooks: kprobes and tracepoints for tracing, XDP and tc for packets, cgroup hooks for policy. They are loaded with the bpf(2) syscall, and the kernel copies the bytecode, runs the verifier, and only then JITs it.",
            "The verifier is the whole product. It explores every reachable path, proves that no read touches uninitialised stack, that every map lookup result is null-checked before dereference, that pointer arithmetic stays inside a known object, and that the program terminates. Bounded loops have been allowed since 5.3; before that every loop had to be fully unrolled. A rejected program returns EACCES with a log that names the instruction and the reason, and reading that log is a skill of its own."
          ],
          "list": [
            "No unbounded loops; the verifier must prove an upper bound",
            "Stack reads must be initialised on every path",
            "Map lookups return a nullable pointer and must be checked",
            "Program size is capped (1M instructions since 5.2), and complexity is capped separately"
          ],
          "tip": "Set the verifier log level to 1 or 2 while developing. The default gives you EACCES and nothing else; the log gives you the instruction index and the state that failed."
        },
        {
          "h": "BTF, CO-RE, and the portability problem",
          "p": [
            "A kprobe reads kernel structs whose layout changes between versions and build configurations. Hard-coding offsets produces a program that works on the machine you built it on and corrupts data everywhere else. BTF is the kernel type information that describes those layouts, and CO-RE is the relocation mechanism that rewrites field accesses at load time against the running kernel BTF.",
            "The practical consequence is that an eBPF object should be compiled once, with BTF, and relocated at load. aya does this from Rust: a separate crate built for the bpfel target produces the object, aya-build embeds it, and the userspace loader performs the relocations. Without BTF on the target kernel, CO-RE cannot work and the loader fails with a clear but easily misread error."
          ],
          "code": "use aya::maps::HashMap;\nuse aya::programs::KProbe;\nuse aya::Ebpf;\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    // Built by a separate aya-ebpf crate for the bpfel target.\n    let mut ebpf = Ebpf::load(aya::include_bytes_aligned!(concat!(\n        env!(\"OUT_DIR\"),\n        \"/execve\"\n    )))?;\n\n    let program: &mut KProbe = ebpf\n        .program_mut(\"count_execve\")\n        .ok_or(\"program missing\")?\n        .try_into()?;\n    program.load()?;\n    program.attach(\"do_execveat_common\", 0)?;\n\n    let mut counts: HashMap<_, u32, u64> =\n        HashMap::try_from(ebpf.map_mut(\"COUNTS\").ok_or(\"map missing\")?)?;\n\n    for _ in 0..3 {\n        std::thread::sleep(std::time::Duration::from_secs(1));\n        let n = counts.get(&0, 0)?;\n        println!(\"execve calls: {n}\");\n    }\n    Ok(())\n}",
          "tip": "CAP_BPF and CAP_PERFMON split the old CAP_SYS_ADMIN requirement since 5.8, but container runtimes usually still need an explicit allowance for bpf(2)."
        },
        {
          "h": "Tracing versus data path",
          "p": [
            "For diagnosis, the cost model is simple: a kprobe on a hot function is expensive because it traps, while a tracepoint is cheaper and stable across versions. For one-off questions, bpftrace gets you an answer in one line. For a product, aya gives you a self-contained binary with no libbpf, no clang at runtime, and no BCC Python stack.",
            "For the data path, XDP runs before the socket layer and can drop or redirect a packet without allocating an skb, which is why DDoS scrubbing and load balancers use it. The trade-off is that XDP programs must be small, must not sleep, and are tied to driver support; anything complex belongs in tc or userspace."
          ],
          "code": "# one-line tracing: who is calling openat, and with what path\nbpftrace -e 'tracepoint:syscalls:sys_enter_openat { printf(\"%s %s\\n\", comm, str(args->filename)); }'\n\n# count execve per process for 10 seconds\nbpftrace -e 'tracepoint:syscalls:sys_enter_execve { @[comm] = count(); }' -d 10\n\n# see whether a program is loaded and what it is attached to\nbpftool prog list\nbpftool map dump name COUNTS\n\n# CO-RE needs BTF on the target kernel\nls -l /sys/kernel/btf/vmlinux",
          "tip": "Prefer tracepoints over kprobes for anything long-lived: tracepoint arguments are part of the kernel ABI, while kprobe function names and signatures change between releases."
        }
      ],
      "exercise": {
        "prompt": "Write the userspace half of a syscall counter: load an eBPF program that increments a per-CPU array keyed by syscall number on every openat, attach it to a tracepoint, and print the top three syscalls after five seconds.",
        "starter": "use aya::maps::PerCpuArray;\nuse aya::programs::TracePoint;\nuse aya::Ebpf;\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    let mut ebpf = Ebpf::load(aya::include_bytes_aligned!(concat!(\n        env!(\"OUT_DIR\"),\n        \"/syscalls\"\n    )))?;\n    // TODO: attach the TracePoint program to \"syscalls\" / \"sys_enter_openat\",\n    // then read the PerCpuArray and sum the per-CPU values.\n    Ok(())\n}",
        "hint": "TracePoint::attach takes category and name: attach(\"syscalls\", \"sys_enter_openat\"). PerCpuArray::get returns one value per possible CPU, so sum across CPUs before comparing.",
        "solution": "use aya::maps::PerCpuArray;\nuse aya::programs::TracePoint;\nuse aya::Ebpf;\nuse std::time::Duration;\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    let mut ebpf = Ebpf::load(aya::include_bytes_aligned!(concat!(\n        env!(\"OUT_DIR\"),\n        \"/syscalls\"\n    )))?;\n\n    let program: &mut TracePoint = ebpf\n        .program_mut(\"count_openat\")\n        .ok_or(\"program missing\")?\n        .try_into()?;\n    program.load()?;\n    program.attach(\"syscalls\", \"sys_enter_openat\")?;\n\n    std::thread::sleep(Duration::from_secs(5));\n\n    let counts: PerCpuArray<_, u64> =\n        PerCpuArray::try_from(ebpf.map(\"COUNTS\").ok_or(\"map missing\")?)?;\n    let per_cpu = counts.get(&0, 0)?;\n    let total: u64 = per_cpu.iter().sum();\n    println!(\"openat calls across {} CPUs: {total}\", per_cpu.len());\n    Ok(())\n}"
      },
      "questions": [
        {
          "q": "What are the two properties the verifier must establish before a program is allowed to run?",
          "options": [
            "That the program is signed and that it uses less than 4 KiB of stack",
            "That it terminates and that every memory access is safe",
            "That it only calls exported kernel symbols and never loops",
            "That it compiles with the same clang version as the kernel"
          ],
          "answer": 1,
          "explain": "Termination (bounded loops) and memory safety (initialised stack, checked pointers, bounded arithmetic) are the invariants. Everything else is a consequence."
        },
        {
          "q": "Why does a hard-coded struct offset in a kprobe program break on another machine?",
          "options": [
            "eBPF offsets are relative to the stack, not to kernel memory",
            "Struct layouts differ by kernel version and build configuration, so the offset points at the wrong field",
            "The verifier randomises offsets at load time for security",
            "BTF rewrites all offsets to zero when it is available"
          ],
          "answer": 1,
          "explain": "That is exactly what CO-RE solves: field accesses are relocations resolved against the target kernel BTF at load time instead of baked into the object."
        },
        {
          "q": "When is a kprobe the wrong tool?",
          "options": [
            "When you need to inspect function arguments on a kernel you built yourself",
            "When the hook is on a very hot path and you need low, predictable overhead",
            "When you want to count calls per process for an hour",
            "When the function is not exported to modules"
          ],
          "answer": 1,
          "explain": "kprobes trap and are version-fragile. Tracepoints, or fentry with BTF, are cheaper and more stable for hot, long-lived instrumentation."
        }
      ],
      "quickbytes": [
        "Read the verifier log with log_level set; EACCES alone tells you nothing actionable.",
        "Null-check every map lookup result before dereferencing it, or the verifier rejects the program.",
        "Use bpftrace for one-off questions and aya when the probe ships as a product."
      ],
      "production": [
        "Programs are attached by name from a manifest, and a failed attach is fatal at startup rather than silently skipped.",
        "Ring buffer consumers handle dropped events explicitly and export a drop counter.",
        "Kernel version and BTF availability are checked before load, with a documented fallback when unavailable.",
        "eBPF agents run with CAP_BPF and CAP_PERFMON only, never full CAP_SYS_ADMIN."
      ],
      "crates": [
        "aya",
        "libc",
        "tokio"
      ],
      "github": [
        {
          "name": "aya - eBPF library written in Rust",
          "url": "https://github.com/aya-rs/aya"
        },
        {
          "name": "libbpf - reference C loader and CO-RE implementation",
          "url": "https://github.com/libbpf/libbpf"
        }
      ],
      "pitfall": "Testing an eBPF loader on your development kernel and shipping it to a fleet with older kernels: the object loads locally, then every production host fails at attach with a relocation or opcode error the log reports only as EACCES.",
      "resources": [
        {
          "title": "aya crate documentation",
          "url": "https://docs.rs/aya/latest/aya/",
          "kind": "docs"
        },
        {
          "title": "bpf(2) - the bpf syscall and program loading",
          "url": "https://man7.org/linux/man-pages/man2/bpf.2.html",
          "kind": "docs"
        },
        {
          "title": "aya source repository",
          "url": "https://github.com/aya-rs/aya",
          "kind": "repo"
        },
        {
          "title": "Linux kernel BPF documentation",
          "url": "https://docs.kernel.org/bpf/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "n08",
      "title": "Filesystems: VFS, page cache, fsync, and atomic replace",
      "minutes": 100,
      "level": "advanced",
      "goal": "Trace a write through the VFS and page cache, implement an atomic file replacement that survives a crash, and know when O_DIRECT or overlayfs changes the rules.",
      "sections": [
        {
          "h": "Four objects and one path walk",
          "p": [
            "The VFS models every filesystem with four objects: a superblock for the mounted filesystem, an inode for a file, a dentry for a name in a directory, and a file for an open description. A path is resolved one component at a time, with the dentry cache short-circuiting repeats. That walk is why opening the same file in a loop is cheap and why a missing intermediate directory costs a syscall per component.",
            "Hard links make the distinction concrete: two names can point at one inode, so unlink removes a name, not a file, and the inode disappears when the last link and the last open descriptor are gone. rename is atomic within one filesystem because it swaps directory entries; across filesystems it degrades into copy plus unlink and is not atomic at all."
          ],
          "list": [
            "superblock: one mounted filesystem",
            "inode: metadata and block map, independent of any name",
            "dentry: a name-to-inode binding, cached",
            "file: an open description with an offset and flags"
          ],
          "tip": "rename is atomic only within one filesystem. A temp file in /tmp and a destination in /var is a copy, not a rename."
        },
        {
          "h": "Writeback, fsync, and what a crash can lose",
          "p": [
            "write(2) copies into page-cache pages and marks them dirty. The kernel flushes them later, either on a timer, under memory pressure, or when you call fsync. fsync waits for the file data and the inode metadata; fdatasync skips metadata that is not needed to read the data back, which is usually faster and sufficient for an append-only log.",
            "The subtle part is that the directory entry is separate. Creating a file and fsyncing the file does not guarantee that after a power loss the name exists. The durable pattern is: write the data, fsync the file, rename the temp over the target, then fsync the containing directory. Skipping the last step is the classic source of zero-length files after a crash on ext4."
          ],
          "code": "use std::fs::{self, File};\nuse std::io::Write;\nuse std::path::Path;\n\nfn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {\n    let dir = path.parent().unwrap_or_else(|| Path::new(\".\"));\n    let name = path.file_name().unwrap().to_string_lossy();\n    let tmp = dir.join(format!(\".{name}.tmp\"));\n\n    {\n        let mut f = File::create(&tmp)?;\n        f.write_all(data)?;\n        f.sync_all()?; // data and inode before the rename\n    }\n\n    fs::rename(&tmp, path)?; // atomic within one filesystem\n    File::open(dir)?.sync_all()?; // make the rename durable too\n    Ok(())\n}\n\nfn main() -> std::io::Result<()> {\n    write_atomic(Path::new(\"/tmp/ra-atomic.json\"), b\"{\\\"ok\\\":true}\")?;\n    println!(\"{:?}\", fs::read(\"/tmp/ra-atomic.json\")?);\n    Ok(())\n}",
          "tip": "File::sync_all is fsync; sync_data is fdatasync. The directory needs its own fsync after a create or rename."
        },
        {
          "h": "Layers that change the semantics",
          "p": [
            "overlayfs gives containers a writable layer over a read-only image. The first write to a file triggers copy-up of the entire file, which means a one-byte edit of a 2 GiB image file costs 2 GiB of I/O and breaks shared mappings of the lower layer. Deleting a file in the lower layer creates a whiteout rather than freeing space.",
            "Other layers rewrite the rules too. tmpfs keeps everything in memory and swap, so fsync is nearly free and durability is a fiction. NFS has close-to-open consistency, so a write is not guaranteed visible to another client until close. O_DIRECT bypasses the page cache but requires buffer alignment to the logical block size and still needs fsync for metadata. Know which layer you are on before reasoning about durability."
          ],
          "code": "# which filesystem is this path actually on?\nfindmnt -T /var/lib/taskrunner\nstat -f -c '%T' /var/lib/taskrunner\n\n# is the file copied up in an overlay?\nls -l /proc/self/mountinfo | grep overlay\n\n# direct I/O alignment: this fails with EINVAL on a misaligned buffer\ndd if=/dev/zero of=/tmp/direct.bin bs=4096 count=1 oflag=direct\n\n# inode exhaustion looks like ENOSPC with free space\ndf -i /var/lib/taskrunner",
          "tip": "In containers, measure write amplification: copying up a large file can turn a millisecond write into seconds of I/O."
        }
      ],
      "exercise": {
        "prompt": "Write a durable counter that survives kill -9 and power loss: read a u64 from a file, increment, write atomically with the temp-file pattern, fsync the file and the directory, and verify by killing the process mid-loop.",
        "starter": "use std::fs::{self, File};\nuse std::io::{Read, Write};\nuse std::path::Path;\n\nfn load(path: &Path) -> std::io::Result<u64> {\n    // TODO: missing file means 0; otherwise parse 8 little-endian bytes.\n    todo!()\n}\n\nfn store(path: &Path, value: u64) -> std::io::Result<()> {\n    // TODO: temp file in the same directory, write, fsync, rename, fsync dir.\n    todo!()\n}",
        "hint": "Write the u64 with to_le_bytes into a temp file named after the target, sync_all the file, rename, then open the parent directory read-only and sync_all it. Loop incrementing until killed, then check the file parses.",
        "solution": "use std::fs::{self, File};\nuse std::io::{Read, Write};\nuse std::path::Path;\n\nfn load(path: &Path) -> std::io::Result<u64> {\n    let mut buf = [0u8; 8];\n    match File::open(path) {\n        Ok(mut f) => {\n            f.read_exact(&mut buf)?;\n            Ok(u64::from_le_bytes(buf))\n        }\n        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),\n        Err(e) => Err(e),\n    }\n}\n\nfn store(path: &Path, value: u64) -> std::io::Result<()> {\n    let dir = path.parent().unwrap_or_else(|| Path::new(\".\"));\n    let tmp = dir.join(\".counter.tmp\");\n    {\n        let mut f = File::create(&tmp)?;\n        f.write_all(&value.to_le_bytes())?;\n        f.sync_all()?;\n    }\n    fs::rename(&tmp, path)?;\n    File::open(dir)?.sync_all()?;\n    Ok(())\n}\n\nfn main() -> std::io::Result<()> {\n    let path = Path::new(\"/tmp/ra-counter.bin\");\n    loop {\n        let next = load(path)? + 1;\n        store(path, next)?;\n        if next % 1000 == 0 {\n            println!(\"{next}\");\n        }\n    }\n}"
      },
      "questions": [
        {
          "q": "You write a new file, fsync it, and the machine loses power. The file is gone after reboot. Why?",
          "options": [
            "fsync does not flush file data, only metadata",
            "The directory entry was never made durable, so the name did not survive",
            "ext4 discards files smaller than one block on crash",
            "The inode was not allocated until the next mount"
          ],
          "answer": 1,
          "explain": "fsync makes the file contents and inode durable, but the name lives in a directory that also has to be synced. This is why the durable pattern ends with an fsync on the parent directory."
        },
        {
          "q": "When is fdatasync preferable to fsync?",
          "options": [
            "When you need the file size change to be durable as well as the data",
            "When the file is on NFS and you want close-to-open consistency",
            "When you overwrite existing bytes and do not need unrelated metadata durable",
            "When the file is memory-mapped with MAP_SHARED"
          ],
          "answer": 2,
          "explain": "fdatasync skips metadata that is not required to retrieve the data, such as mtime. If the write changes the file size, that size is metadata you do need, and fsync is the safe choice."
        },
        {
          "q": "A container writes one byte to a 2 GiB file in its image layer and the operation takes seconds. What is happening?",
          "options": [
            "The page cache is disabled inside containers",
            "overlayfs copies the entire file up into the writable layer on first write",
            "The write is being replicated to every node of the cluster",
            "The file is memory-mapped and the whole mapping is being flushed"
          ],
          "answer": 1,
          "explain": "Copy-up is whole-file. That is why container images are built in layers with large immutable files at the bottom and small mutable files on top."
        }
      ],
      "quickbytes": [
        "Atomic replace is temp file, fsync file, rename, fsync directory, in that order.",
        "df -i catches inode exhaustion; ENOSPC with free blocks is usually that.",
        "O_DIRECT needs block-aligned buffers and offsets, and still needs fsync for metadata."
      ],
      "production": [
        "Every file that is replaced at runtime is written through the temp-and-rename helper, never truncated in place.",
        "Writers of durable state call sync_all and sync the parent directory before acknowledging success.",
        "Disk-space alerts cover inode usage as well as bytes, and log retention is capped by count.",
        "Container images keep mutable state on a volume, never in the overlay upper layer."
      ],
      "crates": [
        "nix",
        "libc",
        "rustix"
      ],
      "github": [
        {
          "name": "nix - filesystem and mount wrappers",
          "url": "https://github.com/nix-rust/nix"
        },
        {
          "name": "rustix - I/O-safe POSIX bindings",
          "url": "https://github.com/bytecodealliance/rustix"
        }
      ],
      "pitfall": "Renaming a temp file into place without fsyncing the parent directory: after a power loss the rename may not have reached disk, leaving the old file, a missing file, or a zero-length one depending on the filesystem.",
      "resources": [
        {
          "title": "fsync(2) - what is guaranteed and what is not",
          "url": "https://man7.org/linux/man-pages/man2/fsync.2.html",
          "kind": "docs"
        },
        {
          "title": "open(2) - O_DIRECT, O_SYNC and flag semantics",
          "url": "https://man7.org/linux/man-pages/man2/open.2.html",
          "kind": "docs"
        },
        {
          "title": "rustix crate documentation (fs module)",
          "url": "https://docs.rs/rustix/latest/rustix/",
          "kind": "docs"
        },
        {
          "title": "rustix source repository",
          "url": "https://github.com/bytecodealliance/rustix",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "n09",
      "title": "Processes: fork, exec, wait, and the zombie you forgot",
      "minutes": 90,
      "level": "core",
      "goal": "Explain what fork copies and shares, why exec is a separate call, and reap children without leaving zombies or signalling a recycled PID.",
      "sections": [
        {
          "h": "fork copies a process, not a program",
          "p": [
            "fork duplicates the calling process: a new task_struct, a copied file descriptor table pointing at the same open file descriptions, a copied address space with every writable page marked copy-on-write, and a new PID. Signal handlers are inherited but pending signals are not, and timers are cleared. The child returns from fork with 0, the parent returns with the child PID, and everything else is identical.",
            "Threads do not come along. The child has exactly one thread, the one that called fork, so any mutex held by another thread at that moment stays locked forever in the child. That is the real reason the async-signal-safe rule exists: between fork and exec the child may only call functions that do not allocate, lock, or touch shared state. clone is the general form of the same syscall and is what threads use with CLONE_VM and CLONE_THREAD."
          ],
          "code": "use nix::sys::wait::{waitpid, WaitStatus};\nuse nix::unistd::{execvp, fork, ForkResult};\nuse std::ffi::CString;\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    let prog = CString::new(\"/bin/echo\")?;\n    let arg = CString::new(\"hello from exec\")?;\n\n    match unsafe { fork() }? {\n        ForkResult::Child => {\n            // Between fork and exec: no allocation, no locks, no println.\n            if execvp(&prog, &[prog.as_c_str(), arg.as_c_str()]).is_err() {\n                let _ = nix::unistd::write(std::io::stderr(), b\"exec failed\");\n            }\n            unsafe { libc::_exit(127) };\n        }\n        ForkResult::Parent { child } => match waitpid(child, None)? {\n            WaitStatus::Exited(_, code) => println!(\"exited with {code}\"),\n            WaitStatus::Signaled(_, sig, _) => println!(\"killed by {sig}\"),\n            other => println!(\"unexpected {other:?}\"),\n        },\n    }\n    Ok(())\n}",
          "tip": "In a multithreaded program, prefer posix_spawn or std::process::Command over hand-written fork plus exec; they avoid running arbitrary Rust in the child."
        },
        {
          "h": "exec replaces the image, not the process",
          "p": [
            "execve loads a new program into the existing address space and keeps the PID, the process group, the session and any descriptor not marked close-on-exec. Everything else is replaced: memory, signal handlers (those set to a handler become default), and the thread that called exec. atexit handlers do not run, buffers are not flushed, and Rust destructors never execute, which is why a File that was not flushed before exec may lose data.",
            "std::process::Command on Unix is exactly this sequence with careful plumbing: pipes for stdio, close-on-exec on everything else, and an error pipe so the parent learns about a failed exec. The classic bug it prevents is a child that reports success because fork succeeded even though the binary does not exist."
          ],
          "list": [
            "Descriptor leaks survive exec unless O_CLOEXEC is set; Rust sets it for files it opens",
            "The environment is inherited and can be replaced with execvpe",
            "argv[0] is convention, not truth: a process can lie about its name",
            "A failed exec must exit non-zero, or the parent sees a successful empty child"
          ],
          "tip": "If a spawned process exits 0 without doing anything, check for a failed exec that was never reported to the parent."
        },
        {
          "h": "Waiting, zombies, and PID reuse",
          "p": [
            "A child that exits becomes a zombie until someone reaps it. The kernel keeps the exit status and the PID so the parent can collect it with waitpid; until then the entry cannot be freed. A long-running supervisor that never waits accumulates zombies until it hits the PID limit, and then it cannot fork at all.",
            "The other half is signalling. A PID is recycled, so kill(pid) after the child has exited can hit an unrelated process. pidfd_open plus pidfd_send_signal ties the signal to the process identity rather than the number, which is the only safe way to signal a process you do not directly own. For daemons, a double fork or PR_SET_CHILD_SUBREAPER makes the reaping responsibility explicit instead of accidental."
          ],
          "code": "# who is a zombie, and who is their parent?\nps -eo pid,ppid,stat,comm | awk '$3 ~ /Z/'\n\n# reap without blocking: waitpid with WNOHANG in a loop\nstrace -f -e trace=wait4,clone,fork,vfork ./target/release/supervisor 2>&1 | tail -20\n\n# is this PID still the process you think it is?\nls -l /proc/$PID/ns/pid   # inode changes when the PID is recycled\n\n# what did the child actually exec?\ncat /proc/$PID/cmdline | tr '\\0' ' '",
          "tip": "Use a pidfd for every long-lived child. Comparing /proc/PID/starttime before signalling is a workaround; a pidfd is the actual fix."
        }
      ],
      "exercise": {
        "prompt": "Write a supervisor that spawns three children with Command, waits for them with waitpid in a loop using WNOHANG, and reports each exit status exactly once. Then deliberately skip waiting for one child and show it as a zombie in ps.",
        "starter": "use std::process::Command;\n\nfn main() -> std::io::Result<()> {\n    let mut pids = Vec::new();\n    for i in 0..3 {\n        let child = Command::new(\"sh\").arg(\"-c\").arg(format!(\"sleep 0.{}; exit {i}\", i + 1)).spawn()?;\n        pids.push(child.id());\n    }\n    // TODO: poll waitpid(pid, WNOHANG) for each pid until all are reaped,\n    // then print each status once.\n    Ok(())\n}",
        "hint": "Use nix::sys::wait::waitpid(Pid::from_raw(pid), Some(WaitPidFlag::WNOHANG)) and treat WaitStatus::StillAlive as \"not yet\". Sleep briefly between rounds; do not spin.",
        "solution": "use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};\nuse nix::unistd::Pid;\nuse std::process::Command;\nuse std::time::Duration;\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    let mut pids = Vec::new();\n    for i in 0..3 {\n        let child = Command::new(\"sh\")\n            .arg(\"-c\")\n            .arg(format!(\"sleep 0.{}; exit {i}\", i + 1))\n            .spawn()?;\n        pids.push(child.id());\n    }\n\n    let mut remaining = pids.clone();\n    while !remaining.is_empty() {\n        remaining.retain(|raw| {\n            match waitpid(Pid::from_raw(*raw as i32), Some(WaitPidFlag::WNOHANG)) {\n                Ok(WaitStatus::StillAlive) => true,\n                Ok(WaitStatus::Exited(_, code)) => {\n                    println!(\"pid {raw} exited {code}\");\n                    false\n                }\n                Ok(other) => {\n                    println!(\"pid {raw}: {other:?}\");\n                    false\n                }\n                Err(e) => {\n                    println!(\"pid {raw}: wait failed {e}\");\n                    false\n                }\n            }\n        });\n        std::thread::sleep(Duration::from_millis(20));\n    }\n    Ok(())\n}"
      },
      "questions": [
        {
          "q": "A multithreaded process forks. What does the child contain?",
          "options": [
            "A copy of every thread, all parked until exec",
            "Only the calling thread, with all other threads gone",
            "No threads at all until exec creates one",
            "Every thread, but with signals blocked in all of them"
          ],
          "answer": 1,
          "explain": "fork duplicates only the calling thread. Locks held by other threads at fork time stay held in the child, which is why only async-signal-safe calls are legal before exec."
        },
        {
          "q": "Which descriptor does NOT survive execve?",
          "options": [
            "stdin, because exec reopens it",
            "One opened with O_CLOEXEC",
            "One inherited from the parent without any flags",
            "One that is a pipe"
          ],
          "answer": 1,
          "explain": "O_CLOEXEC closes the descriptor during a successful exec. Rust sets it on files it opens, which is why leaked descriptors usually come from FFI or from C libraries."
        },
        {
          "q": "waitpid returns WaitStatus::StillAlive. What does that mean?",
          "options": [
            "The child is stopped by SIGSTOP",
            "The child has not changed state yet, and WNOHANG was set",
            "The child was reaped but the status is unavailable",
            "The PID belongs to another process"
          ],
          "answer": 1,
          "explain": "With WNOHANG the call does not block; StillAlive means nothing to report yet. Without WNOHANG the call would have blocked until the child changed state."
        }
      ],
      "quickbytes": [
        "Never call malloc, println! or any lock between fork and exec; only async-signal-safe calls are legal.",
        "A supervisor must wait on every child or it will run out of PIDs, not memory.",
        "Use pidfd for long-lived children so a recycled PID cannot receive your signal."
      ],
      "production": [
        "Every spawned child is registered in a table keyed by pidfd, and the table is drained on SIGCHLD.",
        "Child stdout and stderr are always consumed or redirected, never inherited into a pipe nobody reads.",
        "Exec failures are reported through an error pipe or a non-zero exit, never silently.",
        "Process groups are created per workload so a cleanup can signal the whole tree, not just the leader."
      ],
      "crates": [
        "nix",
        "libc",
        "tokio"
      ],
      "github": [
        {
          "name": "nix - fork, exec and wait wrappers",
          "url": "https://github.com/nix-rust/nix"
        },
        {
          "name": "tokio - process supervision primitives",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "pitfall": "Forking from a multithreaded process and calling Rust code in the child before exec: if another thread held the allocator lock at fork time, the child deadlocks inside malloc and never reaches exec.",
      "resources": [
        {
          "title": "fork(2) - what is copied, what is shared",
          "url": "https://man7.org/linux/man-pages/man2/fork.2.html",
          "kind": "docs"
        },
        {
          "title": "execve(2) - image replacement and close-on-exec",
          "url": "https://man7.org/linux/man-pages/man2/execve.2.html",
          "kind": "docs"
        },
        {
          "title": "wait(2) - zombies, WNOHANG and status encoding",
          "url": "https://man7.org/linux/man-pages/man2/wait.2.html",
          "kind": "docs"
        },
        {
          "title": "nix crate documentation",
          "url": "https://docs.rs/nix/latest/nix/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "n10",
      "title": "Signals: handlers, masks, and the self-pipe trick",
      "minutes": 90,
      "level": "advanced",
      "goal": "Install a handler that only touches async-signal-safe state, move delivery into an event loop with signalfd or tokio, and explain why Rust ignores SIGPIPE.",
      "sections": [
        {
          "h": "A signal is an interrupt with almost no stack",
          "p": [
            "A signal is delivered to some thread that does not block it, and the handler runs on that thread stack, interrupting whatever it was doing. The disposition is per process: default, ignore, or a handler installed with sigaction. Handlers are inherited across fork and reset to default across exec, and the mask is per thread, which is why blocking signals before creating threads is the only way to control which thread receives them.",
            "SA_RESTART makes many interrupted syscalls resume automatically, but not all of them: poll, epoll_wait and nanosleep return EINTR regardless. That asymmetry is why every blocking loop needs an EINTR branch, and why code that ignores EINTR works until the first SIGCHLD arrives during a wait."
          ],
          "list": [
            "Default dispositions: terminate, ignore, stop, continue, or core dump",
            "SIGKILL and SIGSTOP cannot be caught, blocked or ignored",
            "The mask is inherited across fork and across exec",
            "SA_SIGINFO gives you siginfo_t with the sender and fault address"
          ],
          "tip": "Block signals in the main thread before spawning workers, then unblock only in the thread that owns the signalfd."
        },
        {
          "h": "Async-signal-safety is a hard rule",
          "p": [
            "A handler can interrupt malloc in the middle of updating its free lists, or a mutex in the middle of a lock. Calling either from the handler deadlocks or corrupts the heap. The set of safe functions is small and documented: read, write, open, close, _exit, sigaction and a few dozen others. Everything in std that allocates is unsafe in a handler, which includes println!, format!, Vec::push and any lock.",
            "The self-pipe trick turns the problem into ordinary I/O: the handler writes one byte to a pipe and returns, and the main loop reads the pipe and does the real work. signalfd goes further and makes the signal queue itself a file descriptor you can poll, provided the signal is blocked first. Both approaches move all the interesting code out of the handler."
          ],
          "code": "use tokio::signal::unix::{signal, SignalKind};\n\n#[tokio::main]\nasync fn main() -> std::io::Result<()> {\n    // tokio installs a handler that writes to an internal pipe and wakes the reactor.\n    let mut term = signal(SignalKind::terminate())?;\n    let mut int = signal(SignalKind::interrupt())?;\n\n    tokio::select! {\n        _ = term.recv() => eprintln!(\"SIGTERM: draining\"),\n        _ = int.recv() => eprintln!(\"SIGINT: draining\"),\n    }\n\n    // Real work happens here, outside the handler: stop accepting,\n    // then wait for in-flight requests with a deadline.\n    tokio::time::sleep(std::time::Duration::from_millis(50)).await;\n    Ok(())\n}",
          "tip": "A handler that logs with println! can deadlock if the signal arrives while the same thread holds the stdout lock."
        },
        {
          "h": "The signals Rust already changed",
          "p": [
            "The Rust runtime sets SIGPIPE to SIG_IGN before main runs. A write to a closed pipe therefore returns EPIPE instead of killing the process, which is what you want in a library and occasionally not what you want in a CLI that should die when piped into head. Restore the default with a sigaction call if you need the old behaviour, and handle BrokenPipe explicitly if you do not.",
            "SIGSEGV, SIGBUS and SIGFPE are synchronous faults, not notifications: they are delivered to the thread that caused them, and returning from the handler retries the faulting instruction. That is why a SIGSEGV handler is only useful for reporting and for jumping out with siglongjmp, and why Rust turns stack overflow into a SIGSEGV with an alternate signal stack rather than a catchable error."
          ],
          "code": "# which signals does this process have blocked, and what is pending?\ngrep -E 'SigBlk|SigIgn|SigCgt' /proc/$PID/status\n\n# follow signal delivery in order\nstrace -f -e trace=rt_sigaction,rt_sigprocmask,rt_sigreturn ./target/release/app\n\n# send SIGTERM and watch the drain\nkill -TERM $PID && sleep 1 && ps -o pid,stat,comm -p $PID\n\n# decode a signal number from a core file or a log line\nkill -l 11",
          "tip": "A process in state D cannot be killed, even with SIGKILL. That is an uninterruptible kernel wait, usually I/O, not a signal problem."
        }
      ],
      "exercise": {
        "prompt": "Implement the self-pipe trick with nix: install a SIGTERM handler that writes one byte to a pipe and does nothing else, block SIGTERM before spawning a worker thread, and have the main loop read the pipe and shut down cleanly.",
        "starter": "use nix::sys::signal::{self, SigHandler, Signal};\nuse std::os::fd::RawFd;\n\nstatic mut PIPE_WRITE: RawFd = -1;\n\nextern \"C\" fn on_term(_: i32) {\n    // TODO: write exactly one byte to PIPE_WRITE with libc::write and return.\n}\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    // TODO: create a pipe, store the write end, install the handler with\n    // SA_RESTART, block SIGTERM, spawn a worker, then read the pipe.\n    Ok(())\n}",
        "hint": "libc::write is async-signal-safe; println! is not. Block SIGTERM with pthread_sigmask before spawning, or the worker may receive it instead of the loop. Use signal::sigaction with SigHandler::Handler.",
        "solution": "use nix::sys::signal::{self, SigHandler, Signal};\nuse std::io::Read;\nuse std::os::fd::FromRawFd;\n\nstatic mut PIPE_WRITE: i32 = -1;\n\nextern \"C\" fn on_term(_: i32) {\n    let byte = 1u8;\n    // write(2) is async-signal-safe; nothing else here is.\n    unsafe {\n        libc::write(PIPE_WRITE, &byte as *const u8 as *const libc::c_void, 1);\n    }\n}\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    let mut fds = [0i32; 2];\n    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);\n\n    let action = SigHandler::Handler(on_term);\n    unsafe {\n        PIPE_WRITE = fds[1];\n        signal::sigaction(Signal::SIGTERM, &signal::SigAction::new(\n            action,\n            signal::SaFlags::SA_RESTART,\n            signal::SigSet::empty(),\n        ))?;\n    }\n\n    // Block SIGTERM so only the thread that reads the pipe is a candidate.\n    let mut set = signal::SigSet::empty();\n    set.add(Signal::SIGTERM);\n    signal::pthread_sigmask(signal::SigmaskHow::SIG_BLOCK, Some(&set), None)?;\n\n    let mut reader = unsafe { std::fs::File::from_raw_fd(fds[0]) };\n    let mut byte = [0u8; 1];\n    reader.read_exact(&mut byte)?;\n    println!(\"SIGTERM received, shutting down\");\n    Ok(())\n}"
      },
      "questions": [
        {
          "q": "Which function may a signal handler call safely?",
          "options": [
            "println!",
            "Vec::push",
            "write(2)",
            "Mutex::lock"
          ],
          "answer": 2,
          "explain": "write is on the async-signal-safe list. The others allocate or lock, and the handler may have interrupted exactly the code that holds those locks."
        },
        {
          "q": "Why does a Rust program get EPIPE instead of dying when it writes to a closed pipe?",
          "options": [
            "Rust catches SIGPIPE and converts it into an error at the write site",
            "The runtime sets SIGPIPE to SIG_IGN at startup, so the write returns an error",
            "Pipes never deliver SIGPIPE to processes started by cargo",
            "The kernel only sends SIGPIPE for sockets, not pipes"
          ],
          "answer": 1,
          "explain": "SIGPIPE is ignored before main. That keeps libraries safe, and a CLI that must die on a broken pipe has to restore the default handler or exit on BrokenPipe."
        },
        {
          "q": "What does SA_RESTART do?",
          "options": [
            "Restarts the process automatically after it is killed",
            "Resumes certain interrupted syscalls instead of returning EINTR",
            "Delivers the signal to a dedicated handler thread",
            "Blocks the signal until the handler returns"
          ],
          "answer": 1,
          "explain": "It restarts some syscalls transparently, but poll, epoll_wait and nanosleep still return EINTR. Do not rely on it to make blocking loops simple."
        }
      ],
      "quickbytes": [
        "Handlers do one thing: write a byte or set an atomic flag. Everything else runs in the loop.",
        "Block signals before spawning threads, then unblock only where you handle them.",
        "SIGKILL cannot be caught, blocked or ignored; a stuck process in state D will not die either."
      ],
      "production": [
        "SIGTERM triggers a drain with a deadline, and SIGKILL is the documented escalation after it.",
        "Signal masks are set before the first worker thread starts, never after.",
        "SIGSEGV and SIGBUS handlers log a backtrace and abort; they never try to recover and continue.",
        "The service restores or explicitly handles SIGPIPE if it is a CLI whose output is piped."
      ],
      "crates": [
        "nix",
        "libc",
        "tokio"
      ],
      "github": [
        {
          "name": "nix - signal and sigaction wrappers",
          "url": "https://github.com/nix-rust/nix"
        },
        {
          "name": "tokio - signal handling for async runtimes",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "pitfall": "Doing real work inside the handler: a println! or a Mutex::lock there can deadlock, because the handler may have interrupted the thread that already holds that lock.",
      "resources": [
        {
          "title": "signal(7) - signal dispositions, delivery and EINTR",
          "url": "https://man7.org/linux/man-pages/man7/signal.7.html",
          "kind": "docs"
        },
        {
          "title": "signal-safety(7) - the list of async-signal-safe functions",
          "url": "https://man7.org/linux/man-pages/man7/signal-safety.7.html",
          "kind": "docs"
        },
        {
          "title": "signalfd(2) - signals as a pollable file descriptor",
          "url": "https://man7.org/linux/man-pages/man2/signalfd.2.html",
          "kind": "docs"
        },
        {
          "title": "tokio signal module documentation",
          "url": "https://docs.rs/tokio/latest/tokio/signal/index.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "n11",
      "title": "Namespaces and cgroups: isolation versus accounting",
      "minutes": 115,
      "level": "industry",
      "goal": "Create each namespace type in the order that works, write uid_map and gid_map for rootless operation, and place a process in a cgroup v2 leaf with memory and PID limits.",
      "sections": [
        {
          "h": "Eight namespaces, eight different resources",
          "p": [
            "A namespace makes a global resource look private. UTS isolates hostname and domain name, mount isolates the mount table, PID isolates the process ID space, network isolates interfaces and ports, IPC isolates SysV objects and POSIX queues, user isolates UID and GID mappings, cgroup isolates the visible cgroup root, and time offsets the boot and monotonic clocks. There is no single container namespace; a container is a combination.",
            "The APIs are unshare for the calling process, clone for a new child, and setns to join an existing namespace through a /proc/pid/ns file descriptor. User namespaces are the exception to the CAP_SYS_ADMIN requirement: since 3.8 an unprivileged process can create one, which is what makes rootless containers possible. Everything else usually follows from that first step."
          ],
          "code": "use nix::sched::{unshare, CloneFlags};\nuse nix::sys::wait::waitpid;\nuse nix::unistd::{fork, sethostname, ForkResult};\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    // Rootless: the user namespace has to be created on its own first.\n    // Combining CLONE_NEWUSER with the other flags in one call fails with EPERM\n    // for an unprivileged process, because the capability check happens first.\n    unshare(CloneFlags::CLONE_NEWUSER)?;\n    // The process now holds full capabilities inside the new user namespace.\n    unshare(CloneFlags::CLONE_NEWUTS | CloneFlags::CLONE_NEWPID)?;\n    sethostname(\"sandbox\")?;\n\n    // CLONE_NEWPID only affects children: this process keeps its old PID.\n    match unsafe { fork() }? {\n        ForkResult::Child => {\n            println!(\"child sees pid {} inside the namespace\", std::process::id());\n            unsafe { libc::_exit(0) };\n        }\n        ForkResult::Parent { child } => {\n            waitpid(child, None)?;\n        }\n    }\n    Ok(())\n}",
          "tip": "unshare(CLONE_NEWPID) changes the PID namespace of your children, not yours. Without the fork, getpid still returns the old PID."
        },
        {
          "h": "cgroup v2 is one hierarchy with strict rules",
          "p": [
            "cgroup v2 has a single tree. Controllers are enabled per cgroup by writing to cgroup.subtree_control, and a controller only appears in a child once the parent has enabled it. The no-internal-process constraint says a cgroup with domain controllers enabled cannot have its own processes: put processes in leaves, and enable controllers on the parents that distribute resources.",
            "The interface files are the API. memory.max is a hard limit that triggers reclaim and then the OOM killer; memory.high throttles instead of killing; pids.max caps the process count and is the defence against fork bombs; cpu.max sets a quota and period. memory.peak and memory.events give you the accounting a task runner needs, and they disappear when the cgroup directory is removed, so read them before cleanup."
          ],
          "code": "use std::fs;\nuse std::io::Write;\n\nfn place(base: &str, pid: u32, bytes: u64) -> std::io::Result<()> {\n    // The leaf must exist and its parent must have enabled memory and pids.\n    fs::write(format!(\"{base}/memory.max\"), bytes.to_string())?;\n    fs::write(format!(\"{base}/pids.max\"), \"64\")?;\n\n    let mut procs = fs::OpenOptions::new()\n        .write(true)\n        .open(format!(\"{base}/cgroup.procs\"))?;\n    writeln!(procs, \"{pid}\")?;\n    Ok(())\n}\n\nfn main() -> std::io::Result<()> {\n    let base = \"/sys/fs/cgroup/taskrunner/job-42\";\n    place(base, std::process::id(), 256 * 1024 * 1024)?;\n    println!(\"peak: {}\", fs::read_to_string(format!(\"{base}/memory.peak\"))?);\n    println!(\"events: {}\", fs::read_to_string(format!(\"{base}/memory.events\"))?);\n    Ok(())\n}",
          "tip": "If memory.max is missing with ENOENT, the parent cgroup has not enabled the memory controller in subtree_control. Fix the parent, not the leaf."
        },
        {
          "h": "Ordering, delegation and the failures you will hit",
          "p": [
            "Rootless setup has an order: unshare the user namespace, write uid_map and gid_map from the parent, then create the remaining namespaces. Writing the maps from inside the new namespace only works for the single mapping you already own. Denying setgroups is required before gid_map can be written when the process is not privileged, which is why every runtime writes \"deny\" to setgroups first.",
            "On a systemd host, the cgroup tree is managed by systemd, so writing to /sys/fs/cgroup directly fails with EROFS or EACCES. Delegation is the supported path: systemd gives a service a subtree and the service creates leaves under it. The failure modes are consistent: EPERM means a capability or mapping is missing, ENOENT usually means a controller was not enabled in the parent, and EBUSY means processes still live in the cgroup you are trying to remove."
          ],
          "list": [
            "unshare user, write uid_map/gid_map and setgroups=deny, then unshare the rest",
            "Enable controllers top-down in subtree_control before writing leaf limits",
            "Read memory.peak and memory.events before removing the cgroup",
            "rmdir fails with EBUSY until the last process has left or been killed"
          ],
          "tip": "Compare /proc/PID/ns/pid inodes to prove isolation: two processes in the same namespace share the inode, different namespaces do not."
        }
      ],
      "exercise": {
        "prompt": "Write a launcher that creates a user and PID namespace, writes the uid_map so the child appears as uid 0, forks, and prints the child PID as seen inside and outside the namespace. Then add a cgroup leaf with pids.max=8 and prove a fork bomb is stopped.",
        "starter": "use nix::sched::{unshare, CloneFlags};\nuse nix::sys::wait::waitpid;\nuse nix::unistd::{fork, ForkResult};\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    unshare(CloneFlags::CLONE_NEWUSER | CloneFlags::CLONE_NEWPID)?;\n    // TODO: write \"deny\" to /proc/self/setgroups, then uid_map and gid_map,\n    // fork, and print the inner and outer PID of the same child.\n    Ok(())\n}",
        "hint": "Write uid_map as \"0 <your-uid> 1\". The child PID inside the new namespace is 1; the parent sees the real PID returned by fork. Check /proc/PID/status NSpid to see both values at once.",
        "solution": "use nix::sched::{unshare, CloneFlags};\nuse nix::sys::wait::waitpid;\nuse nix::unistd::{fork, ForkResult};\nuse std::fs;\nuse std::io::Write;\n\nfn write(path: &str, value: &str) -> std::io::Result<()> {\n    let mut f = fs::OpenOptions::new().write(true).open(path)?;\n    f.write_all(value.as_bytes())\n}\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    let uid = unsafe { libc::getuid() };\n    let gid = unsafe { libc::getgid() };\n\n    // Step 1: user namespace alone, then the id maps.\n    unshare(CloneFlags::CLONE_NEWUSER)?;\n    write(\"/proc/self/setgroups\", \"deny\")?;\n    write(\"/proc/self/uid_map\", &format!(\"0 {uid} 1\"))?;\n    write(\"/proc/self/gid_map\", &format!(\"0 {gid} 1\"))?;\n\n    // Step 2: now that we hold capabilities in the new user namespace.\n    unshare(CloneFlags::CLONE_NEWPID)?;\n\n    match unsafe { fork() }? {\n        ForkResult::Child => {\n            let status = fs::read_to_string(\"/proc/self/status\")?;\n            let nspid = status\n                .lines()\n                .find(|l| l.starts_with(\"NSpid:\"))\n                .unwrap_or(\"NSpid: ?\");\n            println!(\"inside: uid={} {nspid}\", unsafe { libc::getuid() });\n            unsafe { libc::_exit(0) };\n        }\n        ForkResult::Parent { child } => {\n            println!(\"outside: child pid = {child}\");\n            waitpid(child, None)?;\n        }\n    }\n    Ok(())\n}"
      },
      "questions": [
        {
          "q": "Which namespace must you create first to run the rest unprivileged?",
          "options": [
            "PID",
            "mount",
            "user",
            "network"
          ],
          "answer": 2,
          "explain": "A user namespace grants capabilities inside it, so creating one first makes the subsequent namespace creation permitted for an unprivileged process."
        },
        {
          "q": "After unshare(CLONE_NEWPID), getpid() still returns the old PID. Why?",
          "options": [
            "The namespace is only applied at exec time",
            "The calling process stays in its original PID namespace; only new children enter the new one",
            "getpid is cached by the vDSO and never traps",
            "CLONE_NEWPID requires a mount namespace to take effect"
          ],
          "answer": 1,
          "explain": "PID namespaces apply to processes created after the unshare. You need a fork, and the child becomes PID 1 of the new namespace."
        },
        {
          "q": "Writing a PID to cgroup.procs fails with ENOENT even though the cgroup directory exists. What is the likely cause?",
          "options": [
            "The PID does not exist",
            "The controller was not enabled in the parent subtree_control, so the file is absent",
            "The process is already in another cgroup",
            "cgroup v2 requires a reboot after creating a leaf"
          ],
          "answer": 1,
          "explain": "Controllers are enabled top-down. Until the parent writes +memory to subtree_control, the memory.* files do not exist in the child, and the path you are writing resolves to nothing."
        }
      ],
      "quickbytes": [
        "Write deny to setgroups before gid_map, or the write fails with EPERM.",
        "A cgroup with controllers enabled cannot host processes; put them in leaves.",
        "Read memory.peak and memory.events before rmdir; the accounting vanishes with the directory."
      ],
      "production": [
        "Cgroup leaves are named per job and removed on every exit path, with a startup sweep for orphans.",
        "pids.max is set on every leaf so a fork bomb kills one job, not the host.",
        "Namespace creation is attempted in a fixed order with a clear error for each missing capability.",
        "The launcher verifies isolation by comparing /proc/self/ns inodes, not by trusting that unshare succeeded."
      ],
      "crates": [
        "nix",
        "libc",
        "caps"
      ],
      "github": [
        {
          "name": "nix - unshare, mount and sethostname",
          "url": "https://github.com/nix-rust/nix"
        },
        {
          "name": "runc - reference OCI runtime implementation",
          "url": "https://github.com/opencontainers/runc"
        }
      ],
      "pitfall": "Calling unshare(CLONE_NEWPID) and expecting the current process to change PID: isolation silently applies only to children, so a test that checks getpid passes on the host and proves nothing.",
      "resources": [
        {
          "title": "namespaces(7) - every namespace type and its API",
          "url": "https://man7.org/linux/man-pages/man7/namespaces.7.html",
          "kind": "docs"
        },
        {
          "title": "Control Group v2 - the authoritative cgroup v2 reference",
          "url": "https://docs.kernel.org/admin-guide/cgroup-v2.html",
          "kind": "docs"
        },
        {
          "title": "user_namespaces(7) - uid_map, gid_map and setgroups",
          "url": "https://man7.org/linux/man-pages/man7/user_namespaces.7.html",
          "kind": "docs"
        },
        {
          "title": "nix crate documentation (sched module)",
          "url": "https://docs.rs/nix/latest/nix/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "n12",
      "title": "Container internals: pivot_root, capabilities, seccomp",
      "minutes": 120,
      "level": "industry",
      "goal": "Assemble what a container runtime actually does - private mounts, pivot_root, a capability bounding set, no_new_privs and a syscall filter - in the order that makes each one stick.",
      "sections": [
        {
          "h": "There is no container object in the kernel",
          "p": [
            "A container is a process whose view of the system has been narrowed by namespaces, whose resources are metered by a cgroup, whose filesystem root has been replaced, and whose privileges have been reduced. The OCI runtime specification describes the bundle: a root filesystem, a config.json with mounts, capabilities, seccomp and rlimits, and the process to exec. runc is one implementation of that spec.",
            "The runtime sequence is create, start, delete. create performs all the setup and blocks before exec; start lets the init process run. That two-phase split exists so a supervisor can configure the container before the payload executes, which is exactly the hook a task runner needs."
          ],
          "list": [
            "Namespaces: what the process can see",
            "Cgroups: how much it can use",
            "Root filesystem: what it can open",
            "Capabilities and seccomp: what it can ask the kernel to do"
          ],
          "tip": "Reproduce a container by hand once with unshare, mount and pivot_root. Debugging runc is much easier when you know which syscall failed."
        },
        {
          "h": "pivot_root, not chroot",
          "p": [
            "chroot changes the root directory but leaves the old root reachable through an open descriptor, and a process with CAP_SYS_CHROOT can escape with fchdir and chroot(\"..\"). pivot_root moves the current root under a new directory and makes the new root the real root, so there is no path back. It requires the new root to be a mount point, and it requires the old root to be detachable.",
            "Before any of that, mount propagation has to be stopped. By default a mount namespace inherits shared propagation from the host, so a mount you create inside the container can appear outside it. MS_REC|MS_PRIVATE on / cuts that link. Then bind-mount the rootfs onto itself so it is a mount point, create the put_old directory, pivot, chdir to /, and detach the old root with MNT_DETACH."
          ],
          "code": "use nix::mount::{mount, umount2, MntFlags, MsFlags};\nuse nix::unistd::pivot_root;\nuse std::path::Path;\n\nfn enter_rootfs(root: &Path) -> nix::Result<()> {\n    // 1. Stop mount events crossing the namespace boundary in either direction.\n    mount(\n        None::<&str>,\n        \"/\",\n        None::<&str>,\n        MsFlags::MS_REC | MsFlags::MS_PRIVATE,\n        None::<&str>,\n    )?;\n\n    // 2. The new root must itself be a mount point.\n    mount(\n        Some(root),\n        root,\n        None::<&str>,\n        MsFlags::MS_BIND | MsFlags::MS_REC,\n        None::<&str>,\n    )?;\n\n    let put_old = root.join(\".oldroot\");\n    std::fs::create_dir_all(&put_old)?;\n\n    // 3. Swap roots, then release the old one.\n    pivot_root(root, put_old.as_path())?;\n    std::env::set_current_dir(\"/\")?;\n    umount2(\"/.oldroot\", MntFlags::MNT_DETACH)?;\n    std::fs::remove_dir(\"/.oldroot\").ok();\n    Ok(())\n}",
          "tip": "After pivot_root, mount /proc fresh inside the new root. The inherited /proc still shows the host PIDs and defeats the PID namespace."
        },
        {
          "h": "Dropping privilege in an order that cannot be undone",
          "p": [
            "Capabilities come in sets: permitted, effective, inheritable, bounding and ambient. Dropping the bounding set matters most, because it caps what a process can ever regain through exec of a setuid binary. no_new_privs goes further and tells the kernel that exec may never grant privileges, which is also a prerequisite for an unprivileged process to install a seccomp filter.",
            "Seccomp goes last, because a filter cannot be removed and every setup syscall you still need must be allowed. seccompiler compiles a rule map into a BPF program and installs it with apply_filter. Use an allowlist with EPERM or ENOSYS for everything else, and test it: a workload that needs a syscall you forgot fails at the worst possible moment, usually in production under a different glibc."
          ],
          "code": "use seccompiler::{apply_filter, SeccompAction, SeccompFilter};\nuse std::collections::BTreeMap;\nuse std::convert::TryInto;\n\nfn install_allowlist() -> Result<(), Box<dyn std::error::Error>> {\n    let mut rules: BTreeMap<i64, Vec<seccompiler::SeccompRule>> = BTreeMap::new();\n    for nr in [\n        libc::SYS_read,\n        libc::SYS_write,\n        libc::SYS_exit,\n        libc::SYS_exit_group,\n        libc::SYS_futex,\n    ] {\n        rules.insert(nr as i64, vec![]);\n    }\n\n    let filter: seccompiler::BpfProgram = SeccompFilter::new(\n        rules,\n        SeccompAction::Errno(libc::EPERM as u32), // unmatched syscalls\n        SeccompAction::Allow,                     // matched syscalls\n        std::env::consts::ARCH.try_into()?,\n    )?\n    .try_into()?;\n\n    // Required before an unprivileged seccomp install, and a good idea anyway.\n    nix::sys::prctl::set_no_new_privs()?;\n    apply_filter(&filter)?;\n    Ok(())\n}",
          "tip": "Order matters: setgroups, uid_map, gid_map, drop capabilities, no_new_privs, seccomp, then exec. Reversing any two usually produces EPERM."
        }
      ],
      "exercise": {
        "prompt": "Write the privilege-drop sequence for a sandbox: clear every capability from the bounding, effective and permitted sets except the ones you need, set no_new_privs, install an allowlist seccomp filter, then exec /bin/true. Verify with /proc/self/status that CapBnd is zero and Seccomp is 2.",
        "starter": "use caps::{CapSet, Capability};\nuse seccompiler::{apply_filter, SeccompAction, SeccompFilter};\n\nfn drop_caps() -> Result<(), Box<dyn std::error::Error>> {\n    // TODO: clear effective, permitted, inheritable, ambient and bounding.\n    Ok(())\n}\n\nfn install_filter() -> Result<(), Box<dyn std::error::Error>> {\n    // TODO: allow read, write, exit, exit_group, execve; deny the rest with EPERM.\n    Ok(())\n}",
        "hint": "caps::clear(None, CapSet::Bounding) drops every capability from the bounding set. Set no_new_privs before apply_filter. Seccomp mode 2 in /proc/self/status means filter mode, not enforce mode with a log.",
        "solution": "use caps::{CapSet, Capability};\nuse seccompiler::{apply_filter, SeccompAction, SeccompFilter};\nuse std::collections::BTreeMap;\nuse std::convert::TryInto;\n\nfn drop_caps() -> Result<(), Box<dyn std::error::Error>> {\n    for set in [CapSet::Ambient, CapSet::Inheritable, CapSet::Effective, CapSet::Permitted] {\n        caps::clear(None, set)?;\n    }\n    caps::clear(None, CapSet::Bounding)?;\n    assert!(!caps::has_cap(None, CapSet::Effective, Capability::CAP_SYS_ADMIN)?);\n    Ok(())\n}\n\nfn install_filter() -> Result<(), Box<dyn std::error::Error>> {\n    let mut rules: BTreeMap<i64, Vec<seccompiler::SeccompRule>> = BTreeMap::new();\n    for nr in [\n        libc::SYS_read,\n        libc::SYS_write,\n        libc::SYS_exit,\n        libc::SYS_exit_group,\n        libc::SYS_execve,\n    ] {\n        rules.insert(nr as i64, vec![]);\n    }\n    let filter: seccompiler::BpfProgram = SeccompFilter::new(\n        rules,\n        SeccompAction::Errno(libc::EPERM as u32),\n        SeccompAction::Allow,\n        std::env::consts::ARCH.try_into()?,\n    )?\n    .try_into()?;\n    nix::sys::prctl::set_no_new_privs()?;\n    apply_filter(&filter)?;\n    Ok(())\n}\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    drop_caps()?;\n    install_filter()?;\n    let status = std::fs::read_to_string(\"/proc/self/status\")?;\n    for line in status.lines().filter(|l| l.starts_with(\"CapBnd\") || l.starts_with(\"Seccomp:\")) {\n        println!(\"{line}\");\n    }\n    Ok(())\n}"
      },
      "questions": [
        {
          "q": "Why is pivot_root preferred over chroot for a container root?",
          "options": [
            "pivot_root is faster because it does not touch the dentry cache",
            "pivot_root removes the old root from the namespace, so an open descriptor cannot climb back",
            "chroot cannot be used with mount namespaces",
            "pivot_root automatically mounts /proc inside the new root"
          ],
          "answer": 1,
          "explain": "chroot only changes the resolution root; a process with a descriptor on the old root can fchdir and chroot(\"..\") out. pivot_root swaps the actual root and leaves nothing to climb back to."
        },
        {
          "q": "What does no_new_privs prevent?",
          "options": [
            "Any exec of a binary not owned by root",
            "exec from gaining privileges through setuid or file capabilities",
            "The process from creating new user namespaces",
            "The process from installing a seccomp filter"
          ],
          "answer": 1,
          "explain": "It makes exec unable to elevate privilege, which closes the setuid escape. It is also required before an unprivileged process may install a seccomp filter."
        },
        {
          "q": "Why must the seccomp filter be installed after namespace setup and capability dropping?",
          "options": [
            "Filters only apply to the thread that installs them",
            "A filter cannot be removed, so it would block the setup syscalls you still need",
            "Installing it earlier would also filter the kernel threads",
            "seccomp requires all capabilities to be present"
          ],
          "answer": 1,
          "explain": "Seccomp is irreversible for the process. Every mount, unshare and write to cgroup.procs has to happen before the allowlist takes effect."
        }
      ],
      "quickbytes": [
        "MS_REC|MS_PRIVATE on / before pivot_root, or mounts leak between host and container.",
        "Mount a fresh /proc after pivot_root; the inherited one still shows host PIDs.",
        "Drop the bounding set, not just effective: bounding caps what exec could ever regain."
      ],
      "production": [
        "The runtime applies the same privilege-drop sequence on every code path, including error paths that exec a shell.",
        "Seccomp allowlists are derived from an actual trace of the workload, not from a blog post, and are re-derived when the base image changes.",
        "Any container with CAP_SYS_ADMIN is treated as a host-root equivalent in reviews and alerts.",
        "A smoke test asserts that a forbidden syscall fails with EPERM and that CapBnd is empty inside the sandbox."
      ],
      "crates": [
        "caps",
        "seccompiler",
        "nix"
      ],
      "github": [
        {
          "name": "caps - Linux capability manipulation",
          "url": "https://github.com/lucab/caps-rs"
        },
        {
          "name": "seccompiler - seccomp-bpf filters from Rust",
          "url": "https://github.com/rust-vmm/seccompiler"
        }
      ],
      "pitfall": "Forgetting MS_REC|MS_PRIVATE before pivot_root: the new mount namespace still shares propagation with the host, so a mount made inside the container appears on the host and the isolation you tested disappears.",
      "resources": [
        {
          "title": "capabilities(7) - the five capability sets",
          "url": "https://man7.org/linux/man-pages/man7/capabilities.7.html",
          "kind": "docs"
        },
        {
          "title": "pivot_root(2) - requirements and failure modes",
          "url": "https://man7.org/linux/man-pages/man2/pivot_root.2.html",
          "kind": "docs"
        },
        {
          "title": "seccompiler crate documentation",
          "url": "https://docs.rs/seccompiler/latest/seccompiler/",
          "kind": "docs"
        },
        {
          "title": "seccompiler source repository",
          "url": "https://github.com/rust-vmm/seccompiler",
          "kind": "repo"
        },
        {
          "title": "seccomp(2) - filter modes, flags and TSYNC",
          "url": "https://man7.org/linux/man-pages/man2/seccomp.2.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "n13",
      "title": "WebAssembly: linear memory and a capability-free sandbox",
      "minutes": 110,
      "level": "advanced",
      "goal": "Compile Rust to wasm32, host it in wasmtime under fuel and memory limits, and explain why a guest cannot open a file without an import you provided.",
      "sections": [
        {
          "h": "The sandbox is the type system, not a policy",
          "p": [
            "A WebAssembly module has no syscalls, no ambient authority and no pointers into the host. It can only call functions it imported, and those imports are whatever the embedder chose to link. Memory is a single linear byte array the guest indexes with 32-bit offsets; every access is bounds-checked by the engine, so a wild offset traps instead of corrupting the host.",
            "Validation happens before a single instruction runs. The engine checks that the operand stack types line up on every path, that branches target valid labels, and that function signatures match. That is why wasm needs no MMU, no address-space isolation and no separate process: the worst a module can do is consume CPU and memory until you stop it."
          ],
          "list": [
            "Imports are the entire attack surface; link fewer of them",
            "Linear memory is separate from the host heap; copying in and out is explicit",
            "Traps (out of bounds, divide by zero, unreachable) unwind to the embedder as errors",
            "A module cannot observe wall-clock time or randomness unless you import them"
          ],
          "tip": "A guest that hangs is not a security failure, it is a resource failure. Bound CPU with fuel or epochs and memory with a limiter, or the sandbox is only logical."
        },
        {
          "h": "WASI is a syscall ABI designed for capability security",
          "p": [
            "WASI preview 1 exposes file and network operations as imports over a table of file descriptors, and a guest can only see directories the embedder preopened. There is no open(\"/etc/passwd\") that works by accident, because the path is resolved relative to a descriptor the host handed over. Preview 2 moves to the component model: typed interfaces, resource handles, and async built into the ABI.",
            "WASI is not POSIX. It has no fork, no signals, no users, and its socket API changed shape between previews. Rust targets it with wasm32-wasip1 for preview 1 and wasm32-wasip2 for components, and a crate that depends on libc-heavy functionality will not build for either. Check the target triple before designing around a library."
          ],
          "code": "# build a guest for preview 1 (needs the target installed)\nrustup target add wasm32-wasip1\ncargo build --target wasm32-wasip1 --release\n\n# run it with a single preopened directory and nothing else\nwasmtime run --dir /srv/data target/wasm32-wasip1/release/guest.wasm\n\n# inspect imports: everything the guest can reach is listed here\nwasm-tools print target/wasm32-wasip1/release/guest.wasm | grep '(import'\n\n# and the exports the host is allowed to call\nwasm-tools print target/wasm32-wasip1/release/guest.wasm | grep '(export'",
          "tip": "Audit the import list before shipping a plugin: an unexpected wasi:sockets import is a capability you did not intend to grant."
        },
        {
          "h": "Embedding with wasmtime",
          "p": [
            "wasmtime separates compilation from execution. Engine holds configuration and compiled code, Module is a compiled artifact that can be serialised ahead of time, Store holds per-instance state, and Linker resolves imports. Compile once at startup and clone the Module for each request; compiling per request is the most common performance mistake in wasm services.",
            "Resource limits are configured in two places. Fuel is a deterministic instruction budget that makes a run reproducible, while epochs are a wall-clock interrupt driven by another thread; use fuel for tests and epochs for untrusted production code. Memory limits come from a ResourceLimiter on the store, which also caps table growth and instance count."
          ],
          "code": "use wasmtime::{\n    Caller, Config, Engine, Linker, Module, ResourceLimiter, Store, StoreLimits,\n    StoreLimitsBuilder,\n};\n\nstruct Host {\n    limits: StoreLimits,\n}\n\nfn main() -> wasmtime::Result<()> {\n    let mut config = Config::new();\n    config.consume_fuel(true);\n\n    let engine = Engine::new(&config)?;\n    let module = Module::from_file(&engine, \"guest.wasm\")?;\n\n    let mut store = Store::new(\n        &engine,\n        Host { limits: StoreLimitsBuilder::new().memory_size(16 << 20).build() },\n    );\n    store.limiter(|h| &mut h.limits as &mut dyn ResourceLimiter);\n    store.set_fuel(10_000)?;\n\n    let mut linker = Linker::new(&engine);\n    linker.func_wrap(\"host\", \"log\", |mut caller: Caller<'_, Host>, ptr: i32, len: i32| {\n        let mem = caller\n            .get_export(\"memory\")\n            .and_then(|e| e.into_memory())\n            .ok_or_else(|| wasmtime::Error::msg(\"guest has no memory\"))?;\n        let mut buf = vec![0u8; len as usize];\n        mem.read(&caller, ptr as usize, &mut buf)?;\n        println!(\"guest: {}\", String::from_utf8_lossy(&buf));\n        Ok(())\n    })?;\n\n    let instance = linker.instantiate(&mut store, &module)?;\n    let run = instance.get_typed_func::<(), ()>(&mut store, \"run\")?;\n    run.call(&mut store, ())?;\n    println!(\"fuel left: {}\", store.get_fuel()?);\n    Ok(())\n}",
          "tip": "Fuel is consumed by guest instructions, not by host calls. A guest that calls an expensive imported function can exhaust your patience without exhausting its budget."
        }
      ],
      "exercise": {
        "prompt": "Take a Rust function that sums a slice and compile it to wasm32-unknown-unknown with no_std-style exports. Host it in wasmtime, write the input bytes into the guest memory, call the function, and read the result back, with a fuel limit that makes an infinite loop fail instead of hang.",
        "starter": "use wasmtime::{Config, Engine, Linker, Module, Store};\n\nfn main() -> wasmtime::Result<()> {\n    let mut config = Config::new();\n    config.consume_fuel(true);\n    let engine = Engine::new(&config)?;\n    let module = Module::from_file(&engine, \"sum.wasm\")?;\n    let mut store = Store::new(&engine, ());\n    store.set_fuel(100_000)?;\n\n    let mut linker = Linker::new(&engine);\n    let instance = linker.instantiate(&mut store, &module)?;\n    // TODO: get memory and the exported sum function, write 4 u32 values\n    // at offset 0, call sum(ptr, len), read the i64 result.\n    Ok(())\n}",
        "hint": "Memory::write(&mut store, offset, &bytes) and Memory::read(&store, offset, &mut out) do the copies. TypedFunc<i32, i64>::call takes the store and the argument. Use a fuel value just above what a correct run needs.",
        "solution": "use wasmtime::{Config, Engine, Linker, Module, Store};\n\nfn main() -> wasmtime::Result<()> {\n    let mut config = Config::new();\n    config.consume_fuel(true);\n    let engine = Engine::new(&config)?;\n    let module = Module::from_file(&engine, \"sum.wasm\")?;\n\n    let mut store = Store::new(&engine, ());\n    store.set_fuel(100_000)?;\n\n    let mut linker = Linker::new(&engine);\n    let instance = linker.instantiate(&mut store, &module)?;\n\n    let memory = instance.get_memory(&mut store, \"memory\").expect(\"no memory export\");\n    let sum = instance.get_typed_func::<(i32, i32), i64>(&mut store, \"sum\")?;\n\n    let values: [u32; 4] = [10, 20, 30, 40];\n    let mut bytes = Vec::with_capacity(16);\n    for v in values {\n        bytes.extend_from_slice(&v.to_le_bytes());\n    }\n    memory.write(&mut store, 0, &bytes)?;\n\n    let total = sum.call(&mut store, (0, values.len() as i32))?;\n    println!(\"guest sum = {total}, fuel left = {}\", store.get_fuel()?);\n    assert_eq!(total, 100);\n    Ok(())\n}"
      },
      "questions": [
        {
          "q": "Why can a WebAssembly module not read a file unless the host allows it?",
          "options": [
            "The engine blocks the open syscall by seccomp",
            "The module has no syscalls and can only call functions it imported",
            "Linear memory is encrypted until the host decrypts it",
            "WASI requires a signed capability token per file"
          ],
          "answer": 1,
          "explain": "There is no ambient syscall interface at all. File access exists only if the embedder linked WASI and preopened a descriptor, which is the whole point of capability-based sandboxing."
        },
        {
          "q": "What does fuel measure in wasmtime?",
          "options": [
            "Wall-clock time spent inside the guest",
            "Bytes of linear memory allocated",
            "A deterministic budget consumed per guest instruction",
            "The number of host function calls"
          ],
          "answer": 2,
          "explain": "Fuel is instruction-count based, so it is reproducible across machines. Wall-clock interruption is what epochs are for, and host calls are not metered by fuel."
        },
        {
          "q": "A guest service compiles its Module on every request and latency is poor. What is the fix?",
          "options": [
            "Enable the pooling allocator only",
            "Compile once at startup and reuse the Module, serialising it ahead of time if needed",
            "Switch the guest from WASI preview 1 to preview 2",
            "Disable fuel, which forces recompilation"
          ],
          "answer": 1,
          "explain": "Compilation is the expensive part. A Module is immutable and shareable, so compile at startup or ahead-of-time and instantiate per request."
        }
      ],
      "quickbytes": [
        "Compile once, instantiate per request; Module is shareable and cheap to clone.",
        "Set both fuel (deterministic) and a memory limiter; one without the other is not a sandbox.",
        "Read the import list of any third-party wasm before granting it a preopened directory."
      ],
      "production": [
        "Guest modules are compiled at startup or deserialised from an AOT artifact, never compiled per request.",
        "Every guest runs with a fuel or epoch deadline, a memory limiter, and a documented trap-to-error mapping.",
        "Preopened directories are the minimum set, mounted read-only unless the guest provably needs writes.",
        "The host logs traps with the guest module hash so a bad plugin version is identifiable."
      ],
      "crates": [
        "wasmtime",
        "wasmtime-wasi",
        "anyhow"
      ],
      "github": [
        {
          "name": "wasmtime - Bytecode Alliance WebAssembly runtime",
          "url": "https://github.com/bytecodealliance/wasmtime"
        },
        {
          "name": "WASI - the WebAssembly system interface",
          "url": "https://github.com/WebAssembly/WASI"
        }
      ],
      "pitfall": "Treating fuel as a timeout: a guest that blocks in an imported host function consumes no fuel, so the request hangs while the budget looks untouched. Pair fuel with an epoch deadline or a host-side timeout.",
      "resources": [
        {
          "title": "wasmtime crate documentation",
          "url": "https://docs.rs/wasmtime/latest/wasmtime/",
          "kind": "docs"
        },
        {
          "title": "WebAssembly core specification and concepts",
          "url": "https://webassembly.org/",
          "kind": "docs"
        },
        {
          "title": "MDN: WebAssembly concepts and linear memory",
          "url": "https://developer.mozilla.org/en-US/docs/WebAssembly",
          "kind": "docs"
        },
        {
          "title": "wasmtime source repository",
          "url": "https://github.com/bytecodealliance/wasmtime",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "n14",
      "title": "Freestanding Rust: _start, inline asm, and no libc",
      "minutes": 100,
      "level": "advanced",
      "goal": "Link a binary with no runtime at all: your own _start, syscalls through inline asm with correct clobbers, and a panic handler that never unwinds.",
      "sections": [
        {
          "h": "What the C runtime was doing for you",
          "p": [
            "A normal Linux binary does not start at main. The linker points the entry at _start in crt1.o, which reads argc and argv off the stack, aligns the stack pointer, initialises libc, runs constructors, calls main, and finally flushes and exits. Everything you assume about process startup lives in that object file, and a freestanding target does not link it.",
            "Removing it means you own the entry point. The kernel enters _start with the stack holding argc, then argv pointers, then a null, then envp, and nothing has decoded any of it. There is no libc, no atexit, no thread-local storage setup and no stack protector. The binary must also avoid requesting a dynamic interpreter, which is what -nostartfiles and a static link give you."
          ],
          "list": [
            "crt1.o provides _start, argv decoding, libc init and exit",
            "-nostartfiles keeps the linker from pulling crt1.o in",
            "A dynamic interpreter shows up as an INTERP program header",
            "core and alloc still work; only the platform layer disappears"
          ],
          "tip": "If the kernel answers \"Exec format error\", check the INTERP header and the entry point before suspecting the toolchain."
        },
        {
          "h": "A binary that is only _start",
          "p": [
            "On a freestanding x86-64 target there is no crt0 to set up argc, argv or the environment, and no libc to call. The kernel enters your ELF at _start with the stack pointer set, and everything after that is your responsibility. A syscall is three lines of inline assembly: put the number in rax, the arguments in the ABI registers, and execute syscall.",
            "The assembly block has to tell the compiler the truth. syscall clobbers rcx and r11, so they must be declared as outputs or the optimiser may keep a value in them across the call. options(nostack) says the block does not touch the stack, which lets the compiler avoid setting up a frame; it is a promise, and getting it wrong produces bugs that only appear at opt-level 3."
          ],
          "code": "#![no_std]\n#![no_main]\n\nuse core::arch::asm;\n\nfn write(fd: usize, buf: &[u8]) -> isize {\n    let ret: isize;\n    unsafe {\n        asm!(\n            \"syscall\",\n            inlateout(\"rax\") 1isize => ret, // SYS_write\n            in(\"rdi\") fd,\n            in(\"rsi\") buf.as_ptr(),\n            in(\"rdx\") buf.len(),\n            lateout(\"rcx\") _,\n            lateout(\"r11\") _,\n            options(nostack)\n        );\n    }\n    ret\n}\n\n#[panic_handler]\nfn panic(_info: &core::panic::PanicInfo) -> ! {\n    write(2, b\"panic\\n\");\n    unsafe { asm!(\"syscall\", in(\"rax\") 60isize, in(\"rdi\") 1isize, options(noreturn)) }\n}\n\n#[unsafe(no_mangle)]\npub extern \"C\" fn _start() -> ! {\n    write(1, b\"hello from no_std\\n\");\n    unsafe { asm!(\"syscall\", in(\"rax\") 60isize, in(\"rdi\") 0isize, options(noreturn)) }\n}",
          "tip": "Build with cargo build --target x86_64-unknown-none and check with file and readelf that the entry point is _start and no interpreter is requested."
        },
        {
          "h": "Allocation, tests and the things that quietly pull in std",
          "p": [
            "Vec and String need a global allocator even in no_std. On embedded that is usually a fixed-size arena or linked_list_allocator over a static array; on a freestanding Linux binary you can implement a bump allocator on top of brk or mmap. The allocator must be correct for concurrent access if you have interrupts or threads, which is why embedded projects often avoid the heap entirely.",
            "The build failures are usually link errors with a clear cause once you know where to look. A dependency with default features enabled can pull std in transitively; a #[panic_handler] defined twice means two crates both claim the runtime; missing eh_personality appears when unwinding is still enabled. cargo tree -e features finds the first, the profile finds the second, and panic = abort finds the third."
          ],
          "code": "# .cargo/config.toml for a freestanding x86-64 binary\n[build]\ntarget = \"x86_64-unknown-none\"\n\n[target.x86_64-unknown-none]\nrustflags = [\"-C\", \"link-arg=-nostartfiles\"]\n\n# Cargo.toml\n[profile.release]\npanic = \"abort\"\nlto = true\nstrip = true\n\n# prove there is no dynamic loader and no libc dependency\nreadelf -l target/x86_64-unknown-none/release/app | grep INTERP\nnm -u target/x86_64-unknown-none/release/app | head",
          "tip": "If a no_std build suddenly needs std, run cargo tree -e features and look for a dependency whose default feature enables it."
        }
      ],
      "exercise": {
        "prompt": "Extend the freestanding binary with a bump allocator over a static 64 KiB array, register it as the global allocator, and use a Vec to build a greeting before writing it to stdout. Keep the binary free of libc.",
        "starter": "#![no_std]\n#![no_main]\n\nextern crate alloc;\nuse alloc::vec::Vec;\nuse core::alloc::{GlobalAlloc, Layout};\n\nstruct Bump;\n\nunsafe impl GlobalAlloc for Bump {\n    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {\n        // TODO: bump a static array with alignment handling\n        core::ptr::null_mut()\n    }\n    unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}\n}\n\n#[global_allocator]\nstatic ALLOC: Bump = Bump;",
        "hint": "Use a static mut array plus an AtomicUsize offset, or a UnsafeCell in a critical section. Round the address up to layout.align(), check the end against the array length, and return null on exhaustion so Rust can call handle_alloc_error.",
        "solution": "#![no_std]\n#![no_main]\n\nextern crate alloc;\n\nuse alloc::vec::Vec;\nuse core::alloc::{GlobalAlloc, Layout};\nuse core::arch::asm;\nuse core::sync::atomic::{AtomicUsize, Ordering};\n\nconst HEAP: usize = 64 * 1024;\nstatic mut ARENA: [u8; HEAP] = [0; HEAP];\nstatic OFFSET: AtomicUsize = AtomicUsize::new(0);\n\nstruct Bump;\n\nunsafe impl GlobalAlloc for Bump {\n    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {\n        let base = &raw mut ARENA as *mut u8 as usize;\n        let mut cur = OFFSET.load(Ordering::Relaxed);\n        loop {\n            let aligned = (base + cur + layout.align() - 1) & !(layout.align() - 1);\n            let next = aligned - base + layout.size();\n            if next > HEAP {\n                return core::ptr::null_mut();\n            }\n            match OFFSET.compare_exchange_weak(cur, next, Ordering::SeqCst, Ordering::Relaxed) {\n                Ok(_) => return aligned as *mut u8,\n                Err(actual) => cur = actual,\n            }\n        }\n    }\n    unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}\n}\n\n#[global_allocator]\nstatic ALLOC: Bump = Bump;\n\nfn write(fd: usize, buf: &[u8]) {\n    unsafe {\n        asm!(\"syscall\", in(\"rax\") 1isize, in(\"rdi\") fd, in(\"rsi\") buf.as_ptr(),\n             in(\"rdx\") buf.len(), lateout(\"rcx\") _, lateout(\"r11\") _, options(nostack));\n    }\n}\n\n#[panic_handler]\nfn panic(_: &core::panic::PanicInfo) -> ! {\n    unsafe { asm!(\"syscall\", in(\"rax\") 60isize, in(\"rdi\") 1isize, options(noreturn)) }\n}\n\n#[unsafe(no_mangle)]\npub extern \"C\" fn _start() -> ! {\n    let mut v: Vec<u8> = Vec::new();\n    v.extend_from_slice(b\"hello from a bump arena\\n\");\n    write(1, &v);\n    unsafe { asm!(\"syscall\", in(\"rax\") 60isize, in(\"rdi\") 0isize, options(noreturn)) }\n}"
      },
      "questions": [
        {
          "q": "Which crate do you need for Vec in a no_std binary?",
          "options": [
            "std, with the alloc feature",
            "core alone, because Vec is in core",
            "alloc, plus a #[global_allocator]",
            "libc, for malloc"
          ],
          "answer": 2,
          "explain": "Vec lives in alloc, which is a separate crate from core. It compiles without an OS but needs a global allocator at link time."
        },
        {
          "q": "Why does a no_std binary need panic = abort?",
          "options": [
            "Panics are not allowed in no_std code",
            "Unwinding needs a runtime with personality and landing pads that freestanding targets do not have",
            "abort produces smaller panic messages",
            "The panic handler cannot be called from unwinding code"
          ],
          "answer": 1,
          "explain": "Unwinding requires eh_personality and unwinder support. Without std or a custom unwinder, the only viable strategy is to abort."
        },
        {
          "q": "What is the x86-64 syscall instruction guaranteed to clobber besides rax?",
          "options": [
            "rbx and rbp",
            "rcx and r11",
            "rsi and rdi",
            "Nothing else"
          ],
          "answer": 1,
          "explain": "syscall saves the return address in rcx and the flags in r11. Inline asm must declare both, or the optimiser may keep live values in them across the call."
        }
      ],
      "quickbytes": [
        "core has no heap; add extern crate alloc and a global allocator for Vec and String.",
        "Declare rcx and r11 as clobbered in every syscall asm block, including read-only ones.",
        "panic = abort in every no_std profile; unwinding without a runtime is a link error at best."
      ],
      "production": [
        "no_std crates gate std-only functionality behind a feature and CI builds both configurations.",
        "Every unsafe asm block documents which registers it clobbers and why options(nostack) is sound.",
        "Freestanding binaries are checked with readelf for a missing INTERP and nm for undefined libc symbols.",
        "Allocator failure is tested by exhausting the arena, not discovered in the field."
      ],
      "crates": [
        "linked_list_allocator",
        "cortex-m"
      ],
      "github": [
        {
          "name": "linked_list_allocator - a simple no_std heap",
          "url": "https://github.com/rust-osdev/linked-list-allocator"
        },
        {
          "name": "rust-embedded/cortex-m - low-level Cortex-M support",
          "url": "https://github.com/rust-embedded/cortex-m"
        }
      ],
      "pitfall": "A dependency with default features enabled pulls std in transitively, and the failure appears as a link error about a missing std or a duplicate panic_impl far away from the crate that caused it.",
      "resources": [
        {
          "title": "The Rust Reference: no_std and the core crate",
          "url": "https://doc.rust-lang.org/reference/names/preludes.html",
          "kind": "docs"
        },
        {
          "title": "embedded-hal crate documentation",
          "url": "https://docs.rs/embedded-hal/latest/embedded_hal/",
          "kind": "docs"
        },
        {
          "title": "cortex-m crate documentation",
          "url": "https://docs.rs/cortex-m/latest/cortex_m/",
          "kind": "docs"
        },
        {
          "title": "rust-embedded/cortex-m source repository",
          "url": "https://github.com/rust-embedded/cortex-m",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "n15",
      "title": "Embedded Rust: memory-mapped registers and async executors",
      "minutes": 110,
      "level": "advanced",
      "goal": "Blink an LED by writing a register directly, then replace the busy loop with an embassy task and explain what the executor does when every task is idle.",
      "sections": [
        {
          "h": "A microcontroller is a memory map",
          "p": [
            "There is no kernel and no driver layer between your code and the hardware: peripherals are registers at fixed addresses. Writing a 1 to the right bit in RCC_AHB1ENR enables the clock for GPIOB, and only then do writes to the GPIO registers have any effect. Forgetting the clock enable is the embedded equivalent of forgetting to open the file, and the symptom is silence.",
            "Registers must be accessed with volatile semantics, because the compiler is entitled to cache or eliminate a normal load or store that appears redundant. In Rust, core::ptr::read_volatile and write_volatile express that. Peripheral access crates (PACs) generate typed wrappers over these addresses, and HAL crates build pin and bus abstractions on top; hand-written register code is the right tool for understanding, not for shipping."
          ],
          "code": "#![no_std]\n#![no_main]\n\nuse cortex_m_rt::entry;\nuse core::ptr::{read_volatile, write_volatile};\n\nconst RCC_BASE: usize = 0x4002_3800;\nconst GPIOB_BASE: usize = 0x4002_0400;\n\n#[inline(always)]\nunsafe fn reg(base: usize, offset: usize) -> *mut u32 {\n    (base + offset) as *mut u32\n}\n\n#[entry]\nfn main() -> ! {\n    unsafe {\n        // 1. Clock the GPIOB peripheral, or every write below is ignored.\n        let ahb1enr = reg(RCC_BASE, 0x30);\n        write_volatile(ahb1enr, read_volatile(ahb1enr) | (1 << 1));\n\n        // 2. PB0 as a push-pull output.\n        let moder = reg(GPIOB_BASE, 0x00);\n        write_volatile(moder, (read_volatile(moder) & !0b11) | 0b01);\n\n        let bsrr = reg(GPIOB_BASE, 0x18);\n        loop {\n            write_volatile(bsrr, 1); // set\n            for _ in 0..500_000 {\n                core::hint::spin_loop();\n            }\n            write_volatile(bsrr, 1 << 16); // reset\n            for _ in 0..500_000 {\n                core::hint::spin_loop();\n            }\n        }\n    }\n}",
          "tip": "STM32F4 GPIOB lives at 0x4002_0400 and RCC at 0x4002_3800; BSRR at offset 0x18 sets bits 0-15 and clears with bits 16-31."
        },
        {
          "h": "Interrupts, WFI, and where async fits",
          "p": [
            "A busy-wait loop keeps the core awake at full power. The alternative is to sleep with WFI and let an interrupt wake you. embassy turns that into the same async model you use on the host: tasks are futures, the executor polls them, and when every task is waiting the executor executes WFI until a waker is called from an interrupt handler.",
            "Two properties make this practical on a microcontroller. Tasks are statically allocated, so the linker proves at build time that the program fits in RAM; there is no heap and no runtime allocation failure. And the timer queue is integrated, so Timer::after returns a future that the executor re-polls at the right tick instead of spinning."
          ],
          "list": [
            "No allocator: task storage is a static per task, sized at compile time",
            "No idle polling: the core sleeps in WFI between wakeups",
            "Interrupt priority still matters; a waker from a high-priority ISR can preempt a task",
            "A blocking call inside a task blocks every task at that priority"
          ],
          "tip": "If the LED blinks at the wrong rate, check the clock tree before the timer: a 16 MHz default HSI instead of a 100 MHz PLL changes every delay proportionally."
        },
        {
          "h": "Toolchain, flashing, and seeing what happened",
          "p": [
            "Cross-compilation targets a bare-metal triple such as thumbv7em-none-eabihf. cargo build produces an ELF, probe-rs or openocd flashes it, and defmt sends log strings over the debug probe with the format strings stored in the ELF rather than in the binary. That is why defmt output is cheap: the device sends an index and a few arguments, and the host reconstructs the text.",
            "Panics need somewhere to go. panic-probe prints the panic location over defmt and halts, which turns a silent hang into a line of output. Size matters too: a debug build of a blink can be ten times the size of a release build, and on a 128 KiB part that difference decides whether it links at all."
          ],
          "code": "# .cargo/config.toml\n[build]\ntarget = \"thumbv7em-none-eabihf\"\n\n[target.thumbv7em-none-eabihf]\nrunner = \"probe-rs run --chip STM32F411CEUx\"\n\n# flash and watch defmt output in one command\ncargo run --release\n\n# size breakdown, sorted, when the binary does not fit\ncargo size --release -- -A\nnm --size-sort -S target/thumbv7em-none-eabihf/release/app | tail",
          "tip": "Run cargo size before adding a dependency: a single formatting crate can add tens of kilobytes to a part with 128 KiB of flash."
        }
      ],
      "exercise": {
        "prompt": "Replace the busy-wait blink with an embassy task that toggles the LED every 250 ms, and add a second task that prints a counter every second with defmt. Explain why the CPU is asleep between wakeups.",
        "starter": "#![no_std]\n#![no_main]\n\nuse embassy_executor::Spawner;\nuse embassy_time::{Duration, Timer};\n\n#[embassy_executor::task]\nasync fn blink() {\n    // TODO: toggle an output pin every 250 ms using Timer::after(...).await\n}\n\n#[embassy_executor::main]\nasync fn main(spawner: Spawner) {\n    // TODO: initialise the HAL, spawn both tasks, then return.\n}",
        "hint": "Timer::after(Duration::from_millis(250)).await yields to the executor, which sleeps in WFI until the timer interrupt fires. spawner.spawn returns a Result in embassy-executor 0.10, so handle or unwrap it.",
        "solution": "#![no_std]\n#![no_main]\n\nuse embassy_executor::Spawner;\nuse embassy_time::{Duration, Timer};\nuse embedded_hal::digital::OutputPin;\n\n#[embassy_executor::task]\nasync fn blink(mut led: embassy_stm32::gpio::Output<'static>) {\n    loop {\n        let _ = led.set_high();\n        Timer::after(Duration::from_millis(250)).await;\n        let _ = led.set_low();\n        Timer::after(Duration::from_millis(250)).await;\n    }\n}\n\n#[embassy_executor::task]\nasync fn heartbeat() {\n    let mut n = 0u32;\n    loop {\n        defmt::info!(\"tick {=u32}\", n);\n        n += 1;\n        Timer::after(Duration::from_secs(1)).await;\n    }\n}\n\n#[embassy_executor::main]\nasync fn main(spawner: Spawner) {\n    // HAL init differs between embassy-stm32 releases; the task model does not.\n    let p = embassy_stm32::init(Default::default());\n    spawner.spawn(blink(p.PB0.into())).unwrap();\n    spawner.spawn(heartbeat()).unwrap();\n}"
      },
      "questions": [
        {
          "q": "Why must a GPIO register write be volatile?",
          "options": [
            "Because the register is read-only and volatile is required for reads",
            "Because the compiler could otherwise cache or remove a store that has a hardware side effect",
            "Because volatile makes the access atomic across cores",
            "Because the register is memory-mapped above 4 GiB"
          ],
          "answer": 1,
          "explain": "Volatile tells the compiler the access is observable and must happen exactly once, in order. It says nothing about atomicity or ordering across cores."
        },
        {
          "q": "What does the embassy executor do when every task is waiting?",
          "options": [
            "Polls all tasks in a tight loop to reduce latency",
            "Calls WFI so the core sleeps until an interrupt wakes it",
            "Spins up a background thread to handle timers",
            "Returns from main and halts the MCU"
          ],
          "answer": 1,
          "explain": "The executor polls only woken tasks and sleeps with WFI otherwise. That is why an idle embassy firmware draws close to the MCU sleep current."
        },
        {
          "q": "Why does defmt keep format strings in the ELF rather than in the firmware?",
          "options": [
            "To make the binary smaller and logging cheaper: the device sends an index plus arguments",
            "Because the MCU cannot execute string formatting code",
            "To encrypt the log messages in transit",
            "Because defmt is a host-only crate"
          ],
          "answer": 0,
          "explain": "The device transmits a compact index and the raw argument values; the host tooling looks up the format string in the ELF. Flash and bandwidth both shrink."
        }
      ],
      "quickbytes": [
        "Enable the peripheral clock before touching its registers; otherwise the writes are silently dropped.",
        "Use Timer::after, never a spin loop, unless you are deliberately measuring cycles.",
        "Check cargo size --release -A before blaming the linker for a full flash."
      ],
      "production": [
        "Firmware uses a HAL and PAC rather than raw addresses, with raw-register code confined to bring-up examples.",
        "Every task has a documented worst-case execution time and a priority, and blocking calls are forbidden inside tasks.",
        "panic-probe plus defmt is wired up from day one so field resets leave a trace.",
        "Flash and RAM headroom are tracked per release, with a hard budget enforced in CI."
      ],
      "crates": [
        "embassy-executor",
        "cortex-m",
        "defmt",
        "embedded-hal"
      ],
      "github": [
        {
          "name": "embassy - async framework for embedded",
          "url": "https://github.com/embassy-rs/embassy"
        },
        {
          "name": "defmt - efficient deferred formatting for embedded",
          "url": "https://github.com/knurling-rs/defmt"
        }
      ],
      "pitfall": "Writing to a GPIO register before enabling its peripheral clock: the writes complete without error and have no effect, so the bug looks like a dead pin or a bad solder joint rather than a missing register write.",
      "resources": [
        {
          "title": "embassy-executor crate documentation",
          "url": "https://docs.rs/embassy-executor/latest/embassy_executor/",
          "kind": "docs"
        },
        {
          "title": "embassy documentation hub",
          "url": "https://docs.embassy.dev/",
          "kind": "docs"
        },
        {
          "title": "embassy source repository",
          "url": "https://github.com/embassy-rs/embassy",
          "kind": "repo"
        },
        {
          "title": "embedded-hal trait documentation",
          "url": "https://docs.rs/embedded-hal/latest/embedded_hal/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "n16",
      "title": "Writing drivers: a kernel char device and an embedded-hal client",
      "minutes": 115,
      "level": "industry",
      "goal": "Write a minimal Linux char device that copies data to userspace, drive it from Rust with an ioctl, and structure a portable device driver around embedded-hal traits.",
      "sections": [
        {
          "h": "Kernel space has different rules",
          "p": [
            "Kernel code has no std, no floating point by default, a small stack, and no protection from itself. It cannot touch userspace pointers directly: copy_to_user and copy_from_user exist because the pointer may be invalid, and because the access must be checked and may sleep. The return value of copy_to_user is the number of bytes NOT copied, which is the single most common bug in first kernel modules.",
            "Context determines what you may call. Process context can sleep, so it can allocate with GFP_KERNEL and take mutexes. Atomic context, which includes interrupt handlers and any code holding a spinlock, cannot sleep at all. Rust-for-Linux exists upstream and provides a kernel crate with safe abstractions, but it is in-tree only, its API is unstable, and out-of-tree modules still cannot use it; most production drivers are still C."
          ],
          "list": [
            "Never dereference a __user pointer; always copy",
            "Check copy_to_user and return -EFAULT on a short copy",
            "Sleep only in process context, never under a spinlock",
            "Use devm_ allocations so probe failure unwinds automatically"
          ],
          "tip": "Rust-for-Linux is real but constrained: in-tree, nightly-ish, and not usable for an out-of-tree module. Do not promise it to a team that ships DKMS modules."
        },
        {
          "h": "A misc device in about forty lines",
          "p": [
            "The misc subsystem gives you a dynamic minor number and a /dev node without managing majors. You fill a file_operations struct, register with misc_register, and implement read, write and unlocked_ioctl. copy_to_user moves the reply out, copy_from_user moves a command in, and returning a negative errno is how you report failure.",
            "The ioctl numbers matter: they encode direction, size and a magic letter, and _IOR and _IOW generate them so userspace and kernel agree. Returning -ENOTTY for an unknown command is what makes a wrong ioctl number look like a wrong device instead of a silent no-op."
          ],
          "code": "#include <linux/fs.h>\n#include <linux/miscdevice.h>\n#include <linux/module.h>\n#include <linux/uaccess.h>\n\n#define COUNTER_MAGIC 'c'\n#define COUNTER_GET   _IOR(COUNTER_MAGIC, 1, u32)\n#define COUNTER_RESET _IO(COUNTER_MAGIC, 2)\nstatic u32 counter;\n\nstatic ssize_t counter_read(struct file *f, char __user *buf,\n                            size_t len, loff_t *off)\n{\n    char tmp[32];\n    int n = scnprintf(tmp, sizeof(tmp), \"%u\\n\", counter);\n\n    if (*off >= n)\n        return 0;\n    if (len > (size_t)(n - *off))\n        len = n - *off;\n    if (copy_to_user(buf, tmp + *off, len))\n        return -EFAULT;\n    *off += len;\n    return len;\n}\n\nstatic long counter_ioctl(struct file *f, unsigned int cmd, unsigned long arg)\n{\n    u32 value;\n    switch (cmd) {\n    case COUNTER_GET:\n        value = counter;\n        if (copy_to_user((u32 __user *)arg, &value, sizeof(value)))\n            return -EFAULT;\n        return 0;\n    case COUNTER_RESET:\n        counter = 0;\n        return 0;\n    default:\n        return -ENOTTY;\n    }\n}\nstatic const struct file_operations counter_fops = {\n    .owner = THIS_MODULE,\n    .read = counter_read,\n    .unlocked_ioctl = counter_ioctl,\n};\nstatic struct miscdevice counter_dev = {\n    .minor = MISC_DYNAMIC_MINOR,\n    .name = \"ra_counter\",\n    .fops = &counter_fops,\n};\n\nstatic int __init counter_init(void) { return misc_register(&counter_dev); }\nstatic void __exit counter_exit(void) { misc_deregister(&counter_dev); }\n\nmodule_init(counter_init);\nmodule_exit(counter_exit);\nMODULE_LICENSE(\"GPL\");",
          "tip": "unlocked_ioctl means the caller does not hold the BKL, so any shared state needs your own lock. The old ioctl field is gone."
        },
        {
          "h": "The userspace half: ioctl from Rust, drivers over traits",
          "p": [
            "nix generates the ioctl wrapper from the same encoding the kernel used, so a mismatch is a compile-time constant rather than a runtime surprise. The call is unsafe because the kernel writes through your pointer; the type you pass must match the size encoded in the request, or the kernel writes past the end of your variable.",
            "For hardware attached over I2C or SPI, the portable pattern is a driver struct generic over an embedded-hal trait. The driver owns the register map and the logic, the trait provides read and write, and the same code runs on a microcontroller and on a Linux host through i2c-dev. That is the difference between a driver you can test and one that only runs on the board on your desk."
          ],
          "code": "use embedded_hal::i2c::I2c;\nuse nix::ioctl_read;\nuse std::fs::File;\nuse std::os::fd::AsRawFd;\n\n// _IOR('c', 1, u32) - must match the kernel header exactly.\nioctl_read!(counter_get, b'c', 1, u32);\n\nconst BME280_ADDR: u8 = 0x76;\nconst REG_CHIP_ID: u8 = 0xD0;\n\npub struct Bme280<I2C> {\n    i2c: I2C,\n}\n\nimpl<I2C: I2c> Bme280<I2C> {\n    pub fn new(i2c: I2C) -> Self {\n        Self { i2c }\n    }\n\n    /// Returns 0x60 for a BME280; 0x58 means BMP280 and different compensation.\n    pub fn chip_id(&mut self) -> Result<u8, I2C::Error> {\n        let mut id = [0u8; 1];\n        self.i2c.write_read(BME280_ADDR, &[REG_CHIP_ID], &mut id)?;\n        Ok(id[0])\n    }\n}\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    let dev = File::open(\"/dev/ra_counter\")?;\n    let mut value: u32 = 0;\n    unsafe { counter_get(dev.as_raw_fd(), &mut value)? };\n    println!(\"counter = {value}\");\n    Ok(())\n}",
          "tip": "The ioctl number encodes the argument size. Passing a u64 to an _IOR(..., u32) request gives the kernel a four-byte write into an eight-byte variable, which usually goes unnoticed."
        }
      ],
      "exercise": {
        "prompt": "Add a write handler to the counter module that accepts a decimal number and sets the counter, then write a Rust test binary that opens /dev/ra_counter, sets it to 41, increments nothing, and reads 41 back through both read and the ioctl.",
        "starter": "static ssize_t counter_write(struct file *f, const char __user *buf,\n                             size_t len, loff_t *off)\n{\n    char tmp[32];\n    unsigned long value;\n    // TODO: bound len, copy_from_user into tmp, kstrtoul, store, return len.\n}",
        "hint": "Reject len >= sizeof(tmp) before copying. kstrtoul returns 0 on success and the parsed value; return -EINVAL on a parse failure and -EFAULT on a failed copy_from_user. Update *off so a second write does not loop.",
        "solution": "static ssize_t counter_write(struct file *f, const char __user *buf,\n                             size_t len, loff_t *off)\n{\n    char tmp[32];\n    unsigned long value;\n    int ret;\n\n    if (len >= sizeof(tmp))\n        return -EINVAL;\n    if (copy_from_user(tmp, buf, len))\n        return -EFAULT;\n    tmp[len] = '\\0';\n\n    ret = kstrtoul(tmp, 10, &value);\n    if (ret)\n        return ret;\n\n    counter = (u32)value;\n    *off += len;\n    return len;\n}\n\n// in counter_fops:\n//   .write = counter_write,\n//\n// userspace check with nix:\n//   std::fs::write(\"/dev/ra_counter\", b\"41\")?;\n//   let mut v = 0u32;\n//   unsafe { counter_get(dev.as_raw_fd(), &mut v)? };\n//   assert_eq!(v, 41);"
      },
      "questions": [
        {
          "q": "Why can a kernel driver not simply memcpy from a __user pointer?",
          "options": [
            "The pointer may be invalid, and the access must be checked and may need to sleep",
            "Userspace memory is encrypted until copy_from_user decrypts it",
            "memcpy is not available in the kernel",
            "The pointer is only valid on the same CPU"
          ],
          "answer": 0,
          "explain": "copy_from_user validates the range and handles faults and page faults. A raw dereference of a bad user pointer oopses the kernel instead of returning EFAULT."
        },
        {
          "q": "What does copy_to_user return?",
          "options": [
            "0 on success, -EFAULT on failure",
            "The number of bytes successfully copied",
            "The number of bytes NOT copied, which is 0 on success",
            "The errno value to return to userspace"
          ],
          "answer": 2,
          "explain": "It returns the uncopied byte count. Code that treats any non-zero return as success silently truncates data; code that returns it as an errno reports nonsense."
        },
        {
          "q": "What is the main constraint on using Rust for a Linux driver today?",
          "options": [
            "Rust cannot express volatile memory access",
            "The kernel Rust abstractions are in-tree only and their API is unstable",
            "The kernel cannot load modules written in Rust at all",
            "Rust drivers cannot use interrupts"
          ],
          "answer": 1,
          "explain": "Rust-for-Linux is upstream, but the abstractions are unstable and only usable for in-tree code. Out-of-tree modules, including most vendor drivers, are still C."
        }
      ],
      "quickbytes": [
        "Check the copy_to_user return: it is the uncopied count, not an errno.",
        "Return -ENOTTY for unknown ioctls so a wrong number fails loudly.",
        "Write hardware drivers generic over embedded-hal traits so they can be tested on a host."
      ],
      "production": [
        "Every __user access goes through copy_from_user or copy_to_user with the return value checked.",
        "ioctl numbers use _IO/_IOR/_IOW macros shared through a header, never hand-written constants.",
        "probe() returns a negative errno on every failure path and uses devm_ allocation so cleanup is automatic.",
        "Kernel modules are tested against the oldest supported kernel in CI, not only the developer kernel."
      ],
      "crates": [
        "nix",
        "libc",
        "embedded-hal"
      ],
      "github": [
        {
          "name": "Rust-for-Linux - in-tree Rust abstractions",
          "url": "https://github.com/Rust-for-Linux/linux"
        },
        {
          "name": "embedded-hal - portable hardware traits",
          "url": "https://github.com/rust-embedded/embedded-hal"
        }
      ],
      "pitfall": "Ignoring the copy_to_user return value: it reports the number of bytes NOT copied, so a partial copy is treated as success and userspace receives a truncated or uninitialised buffer.",
      "resources": [
        {
          "title": "ioctl(2) - request encoding and the _IO macros",
          "url": "https://man7.org/linux/man-pages/man2/ioctl.2.html",
          "kind": "docs"
        },
        {
          "title": "Linux kernel driver API documentation",
          "url": "https://docs.kernel.org/driver-api/",
          "kind": "docs"
        },
        {
          "title": "nix ioctl macros documentation",
          "url": "https://docs.rs/nix/latest/nix/",
          "kind": "docs"
        },
        {
          "title": "embedded-hal trait documentation",
          "url": "https://docs.rs/embedded-hal/latest/embedded_hal/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "n17",
      "title": "Performance counters: cycles, cache misses, and multiplexing",
      "minutes": 100,
      "level": "advanced",
      "goal": "Read hardware counters through perf_event_open, interpret IPC and miss rates instead of raw totals, and recognise when a count was scaled because the PMU ran out of counters.",
      "sections": [
        {
          "h": "The PMU counts events, not time",
          "p": [
            "A modern core has a handful of general-purpose counters and a few fixed ones, and each can be programmed to count one event: instructions retired, core cycles, cache misses at a given level, branch mispredictions. The mapping from event name to encoding is model-specific, which is why perf carries a table per microarchitecture and why an event that works on one CPU returns EINVAL on another.",
            "Counters can be opened per thread, per process, or per CPU. Per-process counting follows the process across migrations but loses events from other threads unless inheritance is enabled; per-CPU counting sees everything on that CPU and needs to be aggregated. Both are subject to the same paranoid level, which is the kernel knob that decides whether unprivileged users may count at all."
          ],
          "list": [
            "perf_event_paranoid 2: per-process counting allowed, no kernel or raw tracepoints",
            "perf_event_paranoid 3: no counting at all for unprivileged users",
            "inherit=1: follow children and threads, at the cost of overhead",
            "exclude_kernel=1: count only userspace, useful in shared environments"
          ],
          "tip": "Check /proc/sys/kernel/perf_event_paranoid before blaming your code: a counter that reads 0 in a container is usually a permissions problem, not a hardware problem."
        },
        {
          "h": "Opening a counter from Rust",
          "p": [
            "The perf-event crate wraps perf_event_open with a builder, then enable, disable and read. The default event is retired instructions, which is a useful first measurement because it is stable across frequency changes; cycles are not, because the CPU frequency and the number of concurrent threads both change what a cycle means.",
            "Groups matter when you compare events. If you read instructions and cycles in two separate opens, they may cover different time windows, so their ratio is meaningless. A group makes the kernel schedule the events together, and the read returns a consistent snapshot; if the PMU cannot fit them all, the kernel multiplexes and scales."
          ],
          "code": "use perf_event::Builder;\n\nfn main() -> std::io::Result<()> {\n    let mut counter = Builder::new().build()?; // PERF_COUNT_HW_INSTRUCTIONS\n    let mut total = 0u64;\n\n    counter.enable()?;\n    for i in 0..2_000_000u64 {\n        total = total.wrapping_add(i);\n    }\n    counter.disable()?;\n\n    println!(\"{total} summed, {} instructions retired\", counter.read()?);\n    Ok(())\n}",
          "tip": "Wrap enable and disable as tightly as possible around the code you care about; a counter left running through startup measures the loader as much as your loop."
        },
        {
          "h": "Numbers that survive a second look",
          "p": [
            "Instructions per cycle is the first derived metric worth computing. Well under 1.0 means the pipeline is stalling, so the next question is why: cache misses, branch mispredictions, or a dependency chain. Cache misses per thousand instructions is more comparable across workloads than a raw miss count, because it normalises by work done.",
            "Multiplexing is the trap. When more events are requested than there are counters, the kernel rotates them and reports time_enabled and time_running; the final count is scaled by their ratio. The number is then an estimate, and two runs can disagree by several percent. If the ratio is close to 1.0 the count is real; if it is 0.3, treat the result as directional.",
            "rdtsc is the other trap. It is not a serialising instruction, so the CPU can reorder it around your code, it counts at a constant rate that may not equal the core clock, and it is per-core. Use it only with lfence or rdtscp, only for short intervals, and never as a substitute for a PMU cycle count."
          ],
          "code": "# a comparable summary, including IPC and per-instruction miss rates\nperf stat -e cycles,instructions,cache-misses,branch-misses -d ./target/release/app\n\n# sample stacks for a profile, then fold into a flamegraph\nperf record -F 999 -g --call-graph dwarf ./target/release/app\nperf script | inferno-collapse-perf | inferno-flamegraph > flame.svg\n\n# confirm the counter is not multiplexed: look for \"<not counted>\" or scaled values\nperf stat -e cycles,instructions,cache-misses,L1-dcache-load-misses sleep 1\n\n# which raw events this microarchitecture actually exposes\nperf list hw cache",
          "tip": "A 10 percent difference in cycles between two runs on the same machine is usually frequency or neighbours, not your optimisation. Compare instructions first."
        }
      ],
      "exercise": {
        "prompt": "Measure instructions retired for two versions of the same function: one that sums a Vec<u64> and one that sums a slice with the same loop. Explain any difference, then compute a miss rate per thousand instructions.",
        "starter": "use perf_event::Builder;\n\nfn sum_vec(v: &Vec<u64>) -> u64 {\n    v.iter().copied().fold(0u64, u64::wrapping_add)\n}\n\nfn sum_slice(v: &[u64]) -> u64 {\n    v.iter().copied().fold(0u64, u64::wrapping_add)\n}\n\nfn main() -> std::io::Result<()> {\n    // TODO: count instructions around each call and print the two totals.\n    Ok(())\n}",
        "hint": "Build the counter, enable it immediately before the call, disable immediately after, then read. Run each version several times: the first call includes page faults from allocating the vector.",
        "solution": "use perf_event::Builder;\n\nfn sum_vec(v: &Vec<u64>) -> u64 {\n    v.iter().copied().fold(0u64, u64::wrapping_add)\n}\n\nfn sum_slice(v: &[u64]) -> u64 {\n    v.iter().copied().fold(0u64, u64::wrapping_add)\n}\n\nfn count<F: FnOnce() -> u64>(f: F) -> std::io::Result<(u64, u64)> {\n    let mut counter = Builder::new().build()?;\n    counter.enable()?;\n    let result = f();\n    counter.disable()?;\n    Ok((result, counter.read()?))\n}\n\nfn main() -> std::io::Result<()> {\n    let data: Vec<u64> = (0..100_000).collect();\n    let (a, ins_a) = count(|| sum_vec(&data))?;\n    let (b, ins_b) = count(|| sum_slice(&data))?;\n\n    println!(\"vec:   {a} in {ins_a} instructions\");\n    println!(\"slice: {b} in {ins_b} instructions\");\n    assert_eq!(a, b);\n    println!(\"per-element: {:.2} vs {:.2}\", ins_a as f64 / 100_000.0, ins_b as f64 / 100_000.0);\n    Ok(())\n}"
      },
      "questions": [
        {
          "q": "A workload reports 0.35 instructions per cycle. What does that suggest?",
          "options": [
            "The CPU is running above its base frequency",
            "The pipeline is stalling, so look at cache misses, branch misses or dependency chains",
            "The counter is multiplexed and the value is meaningless",
            "The program is memory-bound and therefore optimal"
          ],
          "answer": 1,
          "explain": "IPC well below 1 means the core is waiting rather than executing. Which wait dominates is the next measurement, not an assumption."
        },
        {
          "q": "perf reports time_enabled much larger than time_running for a counter. What follows?",
          "options": [
            "The count is exact but covers a longer window",
            "The events were multiplexed and the reported count is scaled, so it is an estimate",
            "The process was descheduled and the count is invalid",
            "The PMU is not available on this CPU"
          ],
          "answer": 1,
          "explain": "The kernel rotated the events because there were not enough counters. Scaling by the ratio gives an estimate whose error grows as the ratio falls."
        },
        {
          "q": "Why is rdtsc a poor choice for measuring a long interval?",
          "options": [
            "It returns nanoseconds, not cycles",
            "It is not serialising and counts at a constant rate that may differ from the core clock",
            "It is only available in kernel mode",
            "It stops counting when the CPU enters C-states"
          ],
          "answer": 1,
          "explain": "Without lfence or rdtscp the measurement can be reordered, and the invariant TSC rate is a fixed reference, not the core frequency. For long intervals use a monotonic clock."
        }
      ],
      "quickbytes": [
        "Compare instructions before cycles; frequency scaling and neighbours make cycles noisy.",
        "Check time_enabled vs time_running before trusting a scaled count.",
        "Normalise misses per thousand instructions so numbers stay comparable across workloads."
      ],
      "production": [
        "Benchmarks pin frequency and report instructions, cycles and IPC together, not a single wall-clock number.",
        "CI either grants perf_event access deliberately or skips hardware counters; a silently zero counter is treated as a failure.",
        "Profiles are captured from release builds with debug symbols, using frame pointers or DWARF call graphs.",
        "Any performance claim in a design review cites a before/after measurement with the command used."
      ],
      "crates": [
        "perf-event",
        "libc",
        "nix"
      ],
      "github": [
        {
          "name": "perf-event - Rust interface to perf_event_open",
          "url": "https://github.com/jimblandy/perf-event"
        },
        {
          "name": "not-perf - a Rust rewrite of perf",
          "url": "https://github.com/koute/not-perf"
        }
      ],
      "pitfall": "Comparing cycle counts across runs or machines without pinning frequency and CPU: the numbers move by tens of percent for reasons unrelated to the code, and an optimisation that did nothing looks like a win.",
      "resources": [
        {
          "title": "perf_event_open(2) - the counter interface in full",
          "url": "https://man7.org/linux/man-pages/man2/perf_event_open.2.html",
          "kind": "docs"
        },
        {
          "title": "perf-event crate documentation",
          "url": "https://docs.rs/perf-event/latest/perf_event/",
          "kind": "docs"
        },
        {
          "title": "perf-event source repository",
          "url": "https://github.com/jimblandy/perf-event",
          "kind": "repo"
        },
        {
          "title": "perf(1) - stat, record and report",
          "url": "https://man7.org/linux/man-pages/man1/perf.1.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "n18",
      "title": "Time and clocks: monotonic, realtime, and the vDSO",
      "minutes": 85,
      "level": "advanced",
      "goal": "Pick the right clock for measuring latency versus timestamping events, and explain why a system clock step must never be able to move a duration.",
      "sections": [
        {
          "h": "Five clocks with five meanings",
          "p": [
            "CLOCK_REALTIME is wall-clock time: settable, subject to NTP steps and manual changes, and the only clock you should put in a log line. CLOCK_MONOTONIC never goes backwards and is adjusted gradually by NTP, so it is right for measuring elapsed time but stops during suspend. CLOCK_BOOTTIME is the same but includes suspend, which is what a timeout across a laptop sleep should use.",
            "CLOCK_MONOTONIC_RAW is the hardware counter with no NTP adjustment at all, useful when you are comparing clocks rather than scheduling work. CLOCK_TAI is international atomic time without leap seconds, which matters for systems that must not repeat a second. Choosing wrong is not a rounding error: it is a negative duration, a timeout that never fires, or a log with two events in the wrong order."
          ],
          "list": [
            "REALTIME: timestamps for humans, never for elapsed time",
            "MONOTONIC: durations and timeouts that must not jump",
            "BOOTTIME: timeouts that must survive suspend",
            "MONOTONIC_RAW: hardware comparison without NTP slew",
            "TAI: leap-second-free ordering"
          ],
          "tip": "Rust Instant is monotonic and opaque; SystemTime is realtime. If you subtract two SystemTimes to get a duration, you have a bug waiting for an NTP step."
        },
        {
          "h": "Reading a clock is nearly free",
          "p": [
            "clock_gettime does not normally enter the kernel. The kernel maps a vDSO page into every process, and the call reads the timebase and the offset directly in userspace, which costs tens of nanoseconds instead of a syscall. That is why timestamping every request is affordable, and why gettimeofday survived as a faster, coarser variant.",
            "Precision and accuracy are different. The clock may have nanosecond resolution and still be milliseconds away from true time, because the oscillator drifts and NTP corrects it gradually. For latency measurement the resolution is what matters; for ordering events across machines, accuracy and a bounded error matter more than resolution."
          ],
          "code": "use nix::time::{clock_gettime, ClockId};\nuse std::time::{Duration, Instant};\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    let start = Instant::now();\n    let t0 = clock_gettime(ClockId::CLOCK_MONOTONIC)?;\n\n    std::thread::sleep(Duration::from_millis(10));\n\n    let t1 = clock_gettime(ClockId::CLOCK_MONOTONIC)?;\n    let elapsed_ns = (t1.tv_sec() - t0.tv_sec()) as i128 * 1_000_000_000\n        + (t1.tv_nsec() - t0.tv_nsec()) as i128;\n\n    println!(\"clock_gettime: {elapsed_ns} ns\");\n    println!(\"Instant:       {:?}\", start.elapsed());\n    println!(\"realtime now:  {}\", clock_gettime(ClockId::CLOCK_REALTIME)?.tv_sec());\n    Ok(())\n}",
          "tip": "tv_nsec is a long, not a u32; subtracting two TimeSpecs field by field without i128 arithmetic produces a negative Duration and a panic."
        },
        {
          "h": "Sleeping, deadlines, and slack",
          "p": [
            "Relative sleeps drift: each sleep starts when the thread is scheduled, so a loop that sleeps 10 ms a hundred times overshoots by the accumulated scheduling delay. An absolute deadline loop computes the next wakeup from a fixed origin and passes TIMER_ABSTIME, so the error does not accumulate. Timer wheels in tokio and timerfd in the kernel are built on the same idea.",
            "The kernel also coalesces timers to save power. timer slack defaults to 50 microseconds and can be raised per thread, which means a 1 ms sleep may return noticeably later. For latency-sensitive work, set the slack explicitly; for background work, a larger slack is a feature because it lets the CPU stay idle longer."
          ],
          "code": "# which clock a process is using, and how often it traps\nstrace -c -e trace=clock_gettime,clock_nanosleep,nanosleep ./target/release/app\n\n# per-thread timer slack (default 50 us)\ncat /proc/self/timerslack_ns\n\n# NTP discipline and estimated error, in seconds\ntimedatectl timesync-status 2>/dev/null || chronyc tracking\n\n# kernel tick rate, the floor for sleep granularity without hrtimers\ngetconf CLK_TCK",
          "tip": "A sleep that overshoots by exactly the timer tick is slack, not a scheduling bug. Measure with Instant around the sleep to see the distribution."
        }
      ],
      "exercise": {
        "prompt": "Write a loop that runs 20 iterations with a 50 ms period, first with sleep(50ms) each time and then with an absolute deadline computed from the start. Report total drift and the max lateness for each, measured with Instant.",
        "starter": "use std::time::{Duration, Instant};\n\nfn relative(period: Duration, n: u32) -> Duration {\n    // TODO: sleep(period) each iteration, return total elapsed\n    Duration::ZERO\n}\n\nfn absolute(period: Duration, n: u32) -> Duration {\n    // TODO: compute deadline = start + i * period, sleep_until, return elapsed\n    Duration::ZERO\n}",
        "hint": "std::thread::sleep takes a Duration, and Duration::saturating_sub clamps at zero. For the absolute version, compute the deadline from the fixed start each iteration so late wakeups do not shift the schedule.",
        "solution": "use std::time::{Duration, Instant};\n\nfn relative(period: Duration, n: u32) -> Duration {\n    let start = Instant::now();\n    for _ in 0..n {\n        std::thread::sleep(period);\n    }\n    start.elapsed()\n}\n\nfn absolute(period: Duration, n: u32) -> Duration {\n    let start = Instant::now();\n    for i in 1..=n {\n        let deadline = start + period * i;\n        let now = Instant::now();\n        if deadline > now {\n            std::thread::sleep(deadline - now);\n        }\n    }\n    start.elapsed()\n}\n\nfn main() {\n    let period = Duration::from_millis(50);\n    let n = 20;\n    let r = relative(period, n);\n    let a = absolute(period, n);\n    println!(\"relative: {:?} (ideal {:?})\", r, period * n);\n    println!(\"absolute: {:?} (ideal {:?})\", a, period * n);\n}"
      },
      "questions": [
        {
          "q": "Which clock should a 30-second request timeout use if the machine may suspend?",
          "options": [
            "CLOCK_REALTIME",
            "CLOCK_MONOTONIC",
            "CLOCK_BOOTTIME",
            "CLOCK_MONOTONIC_RAW"
          ],
          "answer": 2,
          "explain": "BOOTTIME keeps counting through suspend. MONOTONIC would freeze, so a timeout could outlive its wall-clock deadline across a sleep."
        },
        {
          "q": "Why must elapsed time never be computed from CLOCK_REALTIME?",
          "options": [
            "It has only microsecond resolution",
            "It can be stepped by NTP or by an operator, so differences can be negative",
            "It is not available in containers",
            "It stops counting when the process is descheduled"
          ],
          "answer": 1,
          "explain": "REALTIME is settable. A step backwards produces a negative duration and a timeout that never fires; monotonic clocks exist precisely to avoid this."
        },
        {
          "q": "Why is clock_gettime cheaper than a typical syscall?",
          "options": [
            "The kernel caches the result per process",
            "It is served from the vDSO, a kernel-provided page mapped into userspace",
            "It is implemented entirely in libc with no kernel involvement at all",
            "It uses a shared memory ring buffer"
          ],
          "answer": 1,
          "explain": "The vDSO contains a small routine that reads the timebase and applies the current offset. No trap is needed, which is why timestamping is affordable."
        }
      ],
      "quickbytes": [
        "Instant for durations, SystemTime for timestamps, BOOTTIME for timeouts across suspend.",
        "Use absolute deadlines in periodic loops; relative sleeps accumulate scheduling error.",
        "A 50 microsecond timer slack is normal, so sub-millisecond sleeps are best-effort."
      ],
      "production": [
        "Durations are always computed with a monotonic clock, and a lint or review rule enforces it.",
        "Periodic work uses absolute deadlines, and drift is monitored rather than assumed away.",
        "Services that must survive suspend use BOOTTIME or a wall-clock deadline checked against realtime.",
        "Log timestamps include the clock source and are compared across machines only with a known NTP error bound."
      ],
      "crates": [
        "nix",
        "libc",
        "tokio"
      ],
      "github": [
        {
          "name": "nix - clock_gettime and timer wrappers",
          "url": "https://github.com/nix-rust/nix"
        },
        {
          "name": "tokio - async timers and timeouts",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "pitfall": "Computing an elapsed duration from SystemTime: an NTP step backwards makes the duration negative, and a step forwards makes a timeout fire early or a metric record a latency that never happened.",
      "resources": [
        {
          "title": "clock_gettime(2) - the clock IDs and their semantics",
          "url": "https://man7.org/linux/man-pages/man2/clock_gettime.2.html",
          "kind": "docs"
        },
        {
          "title": "time(7) - clocks, timers and timer slack",
          "url": "https://man7.org/linux/man-pages/man7/time.7.html",
          "kind": "docs"
        },
        {
          "title": "std::time::Instant documentation",
          "url": "https://doc.rust-lang.org/std/time/struct.Instant.html",
          "kind": "docs"
        },
        {
          "title": "nix crate documentation (time module)",
          "url": "https://docs.rs/nix/latest/nix/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "n19",
      "title": "IPC: pipes, unix sockets, and passing file descriptors",
      "minutes": 100,
      "level": "advanced",
      "goal": "Choose between pipes, unix sockets, shared memory and eventfd, and hand a file descriptor to another process with SCM_RIGHTS without leaking it.",
      "sections": [
        {
          "h": "Pipes are a byte stream with a small buffer",
          "p": [
            "An anonymous pipe holds a bounded buffer, 64 KiB by default, and gives you two descriptors: one read end, one write end. A reader sees EOF only when every write end is closed, which is why a forgotten copy of the write end turns a clean shutdown into a hang. Writes larger than the buffer block until the reader drains, and a write of up to PIPE_BUF bytes, 4096 on Linux, is atomic.",
            "socketpair gives you two connected descriptors with socket semantics. With SOCK_SEQPACKET, message boundaries survive, so a reader gets exactly what a writer sent instead of a merged stream. That property alone is worth the extra setup for protocols where framing matters, and unix sockets also carry credentials and file descriptors."
          ],
          "list": [
            "pipe: one direction, byte stream, cheapest",
            "socketpair(AF_UNIX, SOCK_STREAM): bidirectional byte stream",
            "socketpair(AF_UNIX, SOCK_SEQPACKET): message boundaries preserved",
            "eventfd: an 8-byte counter for wakeups, not for data"
          ],
          "tip": "Close every unused end of a pipe immediately after fork or spawn. The reader cannot see EOF while a write end is still open anywhere, including in the parent."
        },
        {
          "h": "SCM_RIGHTS transfers a reference, not a copy",
          "p": [
            "A file descriptor is a process-local index into a table of open file descriptions. Sending one over a unix socket asks the kernel to install that open file description into the receiver table, which is why the two processes share the file offset and the status flags. It is the mechanism behind systemd socket activation, container runtime handoff and privilege separation.",
            "The control message carries the descriptors as ancillary data next to a normal payload. The receiver must allocate enough control buffer space, parse the messages, and close the descriptors it does not want. A receiver that ignores the ancillary data leaks descriptors, and a sender that forgets to close its copy keeps the object alive after the receiver exits."
          ],
          "code": "use nix::sys::socket::{\n    recvmsg, sendmsg, socketpair, AddressFamily, ControlMessage, MsgFlags, SockFlag, SockType,\n};\nuse std::io::IoSliceMut;\nuse std::os::fd::{AsRawFd, OwnedFd, RawFd};\n\nfn send_fd(sock: &OwnedFd, fd: RawFd) -> nix::Result<()> {\n    let iov = [std::io::IoSlice::new(&[0u8])];\n    let fds = [fd];\n    let cmsg = [ControlMessage::ScmRights(&fds)];\n    sendmsg(sock, &iov, &cmsg, MsgFlags::empty(), None)?;\n    Ok(())\n}\n\nfn recv_fd(sock: &OwnedFd) -> nix::Result<OwnedFd> {\n    let mut buf = [0u8; 1];\n    let mut iov = [IoSliceMut::new(&mut buf)];\n    let mut space = nix::cmsg_space!([RawFd; 1]);\n    let msg = recvmsg::<()>(sock, &mut iov, Some(&mut space), MsgFlags::empty())?;\n    for cmsg in msg.cmsgs()? {\n        if let ControlMessage::ScmRights(fds) = cmsg {\n            if let Some(&fd) = fds.first() {\n                return Ok(unsafe { OwnedFd::from_raw_fd(fd) });\n            }\n        }\n    }\n    Err(nix::errno::Errno::EINVAL)\n}\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    use std::os::fd::FromRawFd;\n    let (a, b) = socketpair(AddressFamily::Unix, SockType::Stream, None, SockFlag::empty())?;\n    let file = std::fs::File::open(\"/etc/hostname\")?;\n    send_fd(&a, file.as_raw_fd())?;\n    let received = recv_fd(&b)?;\n    let meta = std::fs::metadata(format!(\"/proc/self/fd/{}\", received.as_raw_fd()))?;\n    println!(\"received fd refers to {} bytes\", meta.len());\n    Ok(())\n}",
          "tip": "The receiver gets a new descriptor number pointing at the same open file description, so the file offset is shared. That is a feature for handoff and a bug for independent readers."
        },
        {
          "h": "Shared memory and eventfd",
          "p": [
            "For bulk data, copying through a socket is the wrong shape. memfd_create gives you an anonymous file with no path, which you can seal against writes or growth, map MAP_SHARED, and pass to another process as a descriptor. Nothing appears in the filesystem, so a sandboxed process cannot open it by name; it must be given the descriptor.",
            "eventfd is a counter, not a queue: a write adds, a read returns the total and resets it, and it is pollable. It is the right primitive for waking an event loop from a signal handler or another thread, and the wrong primitive for transferring messages. For ordering shared-memory updates, a futex or an atomic sequence number is still required; shared memory gives you visibility, not synchronisation."
          ],
          "code": "# inspect the descriptors a process holds and what they point at\nls -l /proc/$PID/fd\n\n# see socket peer credentials and the inode behind a unix socket\nss -x -p | grep $PID\n\n# count descriptors by type to spot an SCM_RIGHTS leak\nls -l /proc/$PID/fd | awk '{print $NF}' | sed 's/:.*//' | sort | uniq -c\n\n# queued bytes and backlog on unix sockets\nss -x -m | head -20",
          "tip": "Passing descriptors is the safe alternative to passing paths: the receiver gets exactly the object you meant, with no time-of-check/time-of-use window."
        }
      ],
      "exercise": {
        "prompt": "Build a tiny worker protocol over socketpair(SOCK_SEQPACKET): the parent sends a request with one descriptor attached, the child reads the message and the descriptor, and replies with the byte count read from that file. Close both copies correctly and verify no descriptor leak with /proc/self/fd.",
        "starter": "use nix::sys::socket::{recvmsg, sendmsg, socketpair, ControlMessage, MsgFlags, SockFlag, SockType, AddressFamily};\nuse std::os::fd::OwnedFd;\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    let (parent, child) = socketpair(\n        AddressFamily::Unix,\n        SockType::SeqPacket,\n        None,\n        SockFlag::empty(),\n    )?;\n    // TODO: fork, send a File plus a one-byte tag from parent,\n    // receive both in child, reply with the size, then exit.\n    Ok(())\n}",
        "hint": "SOCK_SEQPACKET preserves the message, so one sendmsg is one recvmsg. In the child, wrap the received RawFd in OwnedFd so it closes on drop. Reply with a plain write on the same socket; no ancillary data is needed for the reply.",
        "solution": "use nix::sys::socket::{\n    recvmsg, sendmsg, socketpair, AddressFamily, ControlMessage, MsgFlags, SockFlag, SockType,\n};\nuse nix::sys::wait::waitpid;\nuse nix::unistd::{fork, ForkResult};\nuse std::io::{IoSlice, IoSliceMut};\nuse std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    let (parent, child) = socketpair(\n        AddressFamily::Unix,\n        SockType::SeqPacket,\n        None,\n        SockFlag::empty(),\n    )?;\n\n    match unsafe { fork() }? {\n        ForkResult::Child => {\n            drop(parent);\n            let mut buf = [0u8; 1];\n            let mut iov = [IoSliceMut::new(&mut buf)];\n            let mut space = nix::cmsg_space!([RawFd; 1]);\n            let msg = recvmsg::<()>(&child, &mut iov, Some(&mut space), MsgFlags::empty())?;\n\n            let mut received: Option<OwnedFd> = None;\n            for cmsg in msg.cmsgs()? {\n                if let ControlMessage::ScmRights(fds) = cmsg {\n                    if let Some(&fd) = fds.first() {\n                        received = Some(unsafe { OwnedFd::from_raw_fd(fd) });\n                    }\n                }\n            }\n            let fd = received.expect(\"no descriptor\");\n            let len = std::fs::metadata(format!(\"/proc/self/fd/{}\", fd.as_raw_fd()))?.len();\n            let reply = len.to_le_bytes();\n            sendmsg(&child, &[IoSlice::new(&reply)], &[], MsgFlags::empty(), None)?;\n            unsafe { libc::_exit(0) };\n        }\n        ForkResult::Parent { child: pid } => {\n            drop(child);\n            let file = std::fs::File::open(\"/etc/hostname\")?;\n            let fds = [file.as_raw_fd()];\n            let tag = [1u8];\n            sendmsg(\n                &parent,\n                &[IoSlice::new(&tag)],\n                &[ControlMessage::ScmRights(&fds)],\n                MsgFlags::empty(),\n                None,\n            )?;\n\n            let mut reply = [0u8; 8];\n            let mut iov = [IoSliceMut::new(&mut reply)];\n            recvmsg::<()>(&parent, &mut iov, None, MsgFlags::empty())?;\n            println!(\"child read {} bytes\", u64::from_le_bytes(reply));\n            waitpid(pid, None)?;\n        }\n    }\n    Ok(())\n}"
      },
      "questions": [
        {
          "q": "Two processes write 4000-byte messages to the same pipe concurrently. What is guaranteed?",
          "options": [
            "The messages are interleaved arbitrarily",
            "Each write of up to PIPE_BUF bytes is atomic, so the two messages do not interleave",
            "Writes larger than the pipe buffer are rejected with EINVAL",
            "The kernel serialises writers with a per-pipe lock for any size"
          ],
          "answer": 1,
          "explain": "Atomicity is only guaranteed up to PIPE_BUF, 4096 bytes on Linux. Larger writes can be split and interleaved with another writer."
        },
        {
          "q": "What does SCM_RIGHTS actually transfer?",
          "options": [
            "A copy of the file contents",
            "A new descriptor in the receiver referring to the same open file description",
            "A path that the receiver reopens",
            "A capability token that must be redeemed"
          ],
          "answer": 1,
          "explain": "The kernel installs the same open file description into the receiver table. That is why the file offset and status flags are shared between both processes."
        },
        {
          "q": "Why is memfd_create preferable to shm_open for a sandboxed handoff?",
          "options": [
            "It is faster because it avoids the page cache",
            "It has no filesystem name, so the object can only be reached through the descriptor you pass",
            "It supports larger sizes than POSIX shared memory",
            "It automatically encrypts the contents"
          ],
          "answer": 1,
          "explain": "A named shm object can be opened by anything that can reach the name. An memfd has no name, which fits capability-based passing and seccomp-filtered sandboxes."
        }
      ],
      "quickbytes": [
        "Close the unused end of every pipe immediately, or the reader will never see EOF.",
        "A write is atomic only up to PIPE_BUF, 4096 bytes; larger writes can interleave.",
        "Wrap a received descriptor in OwnedFd the moment you get it, so error paths cannot leak it."
      ],
      "production": [
        "Every received SCM_RIGHTS descriptor is wrapped in OwnedFd immediately, and the count of open descriptors is exported as a metric.",
        "Protocols over SOCK_STREAM have an explicit length prefix; only SOCK_SEQPACKET may rely on boundaries.",
        "Descriptor passing is preferred over path passing for anything security-sensitive, and SO_PEERCRED is checked on the socket.",
        "Pipes and sockets have timeouts, so a peer that stops reading cannot block a worker forever."
      ],
      "crates": [
        "nix",
        "libc",
        "rustix"
      ],
      "github": [
        {
          "name": "nix - socket, sendmsg and cmsg helpers",
          "url": "https://github.com/nix-rust/nix"
        },
        {
          "name": "rustix - I/O-safe descriptor passing",
          "url": "https://github.com/bytecodealliance/rustix"
        }
      ],
      "pitfall": "Leaving a duplicate of the write end open in the parent: the reader never receives EOF, so a worker waits forever for input that will never come, and the hang appears only in production shutdown.",
      "resources": [
        {
          "title": "pipe(7) - buffering, atomicity and EOF semantics",
          "url": "https://man7.org/linux/man-pages/man7/pipe.7.html",
          "kind": "docs"
        },
        {
          "title": "unix(7) - SCM_RIGHTS and credentials over unix sockets",
          "url": "https://man7.org/linux/man-pages/man7/unix.7.html",
          "kind": "docs"
        },
        {
          "title": "memfd_create(2) - anonymous sealed memory files",
          "url": "https://man7.org/linux/man-pages/man2/memfd_create.2.html",
          "kind": "docs"
        },
        {
          "title": "nix crate documentation (socket module)",
          "url": "https://docs.rs/nix/latest/nix/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "n20",
      "title": "Systems debugging: strace, perf, and the state a process is in",
      "minutes": 110,
      "level": "industry",
      "goal": "Diagnose a hung or slow process from the outside using /proc state, syscall traces, stack samples and core dumps, without restarting it and losing the evidence.",
      "sections": [
        {
          "h": "Start with state, not speculation",
          "p": [
            "The first question is what the process is doing, and /proc answers it without instrumentation. The state letter in ps tells you whether it is running, sleeping, a zombie, or in uninterruptible sleep. wchan names the kernel function it is parked in, and /proc/PID/stack shows the kernel stack if you have permission. A process in D state is waiting on I/O and cannot be killed, not even with SIGKILL.",
            "Then look at what it holds: the number of descriptors, the socket list, memory from smaps_rollup, and the signal masks in status. A service that stops accepting connections while every thread is parked in futex_wait is not out of file descriptors; it is deadlocked on a lock. The distinction changes the entire investigation."
          ],
          "list": [
            "ps -o stat,wchan:32 -p PID: what state and where",
            "ls /proc/PID/fd | wc -l: descriptor growth",
            "grep -E \"SigBlk|Threads|VmRSS\" /proc/PID/status",
            "cat /proc/PID/task/*/wchan | sort | uniq -c: where threads wait"
          ],
          "tip": "D state means uninterruptible kernel wait, usually block I/O or a hung NFS mount. SIGKILL does not help; fix the I/O or reboot."
        },
        {
          "h": "strace answers \"what\", perf answers \"where\"",
          "p": [
            "strace shows syscalls with arguments, return values, errno and optionally durations. It is unbeatable for a startup failure, a permission problem or a protocol mismatch, and it is a trap for performance work: every syscall now costs a context switch to the tracer, which can slow a program by an order of magnitude and hide the race you are chasing. Use it to understand behaviour, not to measure it.",
            "perf samples stacks at a fixed frequency and tells you where time goes without modifying the binary. User-space stacks need frame pointers or DWARF unwind information, and Rust release builds default to neither, which is why a profile with no symbols is a build configuration problem rather than a perf problem. For async code, a task-level view from tokio-console is often faster than a CPU profile, because the time is spent waiting rather than running."
          ],
          "code": "# what syscall is it blocked in right now?\nstrace -p $PID -f -T -e trace=%desc,%file\n\n# where is CPU time going, with call graphs\nperf record -F 999 -g --call-graph dwarf -p $PID -- sleep 10\nperf report --stdio | head -40\n\n# flamegraph from the same data\nperf script | inferno-collapse-perf | inferno-flamegraph > out.svg\n\n# count a syscall and its latency distribution without a tracer\nbpftrace -e 'tracepoint:syscalls:sys_enter_read { @start[tid] = nsecs; }\n             tracepoint:syscalls:sys_exit_read /@start[tid]/ {\n                 @us = hist((nsecs - @start[tid]) / 1000); delete(@start[tid]); }'",
          "tip": "Profile a release build with debug = true in the profile, or the symbols you need will not exist when the profile is finally interesting."
        },
        {
          "h": "Cores, panics, and what to capture before restarting",
          "p": [
            "A core dump is the only artifact that lets you inspect a process after it died. core_pattern decides where the kernel writes it, ulimit -c decides whether it writes one at all, and systemd-coredump stores it for coredumpctl. With a core and the matching binary, gdb or rust-gdb can show every thread stack, the panic message, and the arguments that caused it.",
            "For async services, a core is less useful than a task dump, because the interesting state is in future state machines rather than thread stacks. tokio-console shows tasks, their poll counts and their wait times, which is exactly the information a thread dump lacks. Either way, capture the evidence before restarting: the restart is what destroys the only copy of the bug."
          ],
          "code": "# enable cores for this shell, then run the failing case\nulimit -c unlimited\ncat /proc/sys/kernel/core_pattern\n\n# inspect a core with Rust pretty-printers loaded\nrust-gdb --batch -ex \"thread apply all bt\" ./target/release/app core.1234\n\n# systemd hosts: list and inspect without hunting for files\ncoredumpctl list\ncoredumpctl gdb $(coredumpctl list --no-legend | tail -1 | awk '{print $5}')\n\n# did the OOM killer take it?\ndmesg -T | grep -i -E 'oom|killed process'",
          "tip": "Set core_pattern and ulimit -c in the service unit, not in your shell profile. A crash at 3am will not have your shell environment."
        }
      ],
      "exercise": {
        "prompt": "Write a deliberately hanging program that takes a mutex in one thread and then blocks on a read from a pipe nobody writes to, and produce a diagnosis using only ps state, wchan and strace. Record which evidence identified each of the two problems.",
        "starter": "use std::io::Read;\nuse std::sync::Mutex;\n\nfn main() {\n    let lock = Mutex::new(0u32);\n    let guard = lock.lock().unwrap();\n    // TODO: spawn a thread that tries to lock the same mutex,\n    // then block the main thread on a pipe read and observe both.\n    let _ = guard;\n    let mut buf = [0u8; 1];\n    std::io::stdin().read_exact(&mut buf).unwrap();\n}",
        "hint": "The blocked thread shows futex_wait in wchan; the main thread shows pipe_read or wait_woken. strace -f shows one thread parked in futex and the other in read with no return value.",
        "solution": "use std::io::Read;\nuse std::sync::{Arc, Mutex};\n\nfn main() {\n    let lock = Arc::new(Mutex::new(0u32));\n\n    let handle = {\n        let lock = Arc::clone(&lock);\n        std::thread::spawn(move || {\n            // Blocks forever: the main thread holds the guard.\n            let _guard = lock.lock().unwrap();\n        })\n    };\n\n    let guard = lock.lock().unwrap();\n\n    // Block on a pipe that nobody writes to.\n    let mut buf = [0u8; 1];\n    let _ = std::io::stdin().read_exact(&mut buf);\n\n    drop(guard);\n    let _ = handle.join();\n}\n\n// Diagnosis:\n//   ps -o stat,wchan:32 -p PID  -> main thread in pipe_read, worker in futex_wait\n//   cat /proc/PID/task/*/wchan   -> futex_wait and pipe_read, one per thread\n//   strace -f -p PID             -> read(0, ... <unfinished ...> and futex(... <unfinished ...>\n// The mutex is held across a blocking read: a lock-ordering bug, not a pipe bug."
      },
      "questions": [
        {
          "q": "A process is in state D and does not respond to SIGKILL. What does that mean?",
          "options": [
            "It is a zombie waiting to be reaped",
            "It is in an uninterruptible kernel wait, usually I/O, and will die only when the wait ends",
            "It is stopped by a debugger",
            "Its signal mask blocks SIGKILL"
          ],
          "answer": 1,
          "explain": "D state is uninterruptible sleep in the kernel. Signals, including SIGKILL, are only delivered when the process returns to a state where delivery is possible."
        },
        {
          "q": "Why can strace make a race condition disappear?",
          "options": [
            "It serialises all threads onto one CPU",
            "It adds a context switch and latency to every syscall, changing the timing that produced the race",
            "It blocks signals while attached",
            "It disables the page cache for the traced process"
          ],
          "answer": 1,
          "explain": "Tracing changes timing by orders of magnitude, which hides timing-dependent bugs. Use it to understand behaviour, and use sampling or logging for races."
        },
        {
          "q": "A perf profile of a Rust release binary shows only addresses, no function names. What is the cause?",
          "options": [
            "perf does not support Rust symbol mangling",
            "The build has no frame pointers or DWARF info, so stacks cannot be unwound",
            "The kernel needs CONFIG_KALLSYMS for userspace symbols",
            "The binary was stripped of its dynamic symbol table only"
          ],
          "answer": 1,
          "explain": "User-space unwinding needs frame pointers or DWARF. Enable debug symbols and either force frame pointers or use --call-graph dwarf with the matching build."
        }
      ],
      "quickbytes": [
        "Read wchan before attaching a tracer; it often answers the question in one line.",
        "Capture the core or task dump before restarting, or the bug is gone.",
        "Profile release builds with debug symbols; a stripped binary gives you addresses, not answers."
      ],
      "production": [
        "Services ship with debug symbols or a symbol server, and the exact binary is retained per release for core analysis.",
        "Core dumps are enabled in the unit file with a bounded retention policy, and coredumpctl is part of the runbook.",
        "Every incident review records the /proc evidence collected before the restart.",
        "perf and bpftrace access is granted deliberately to on-call, with the paranoid level documented."
      ],
      "crates": [
        "nix",
        "libc",
        "tokio"
      ],
      "github": [
        {
          "name": "tokio-console - async task introspection",
          "url": "https://github.com/tokio-rs/console"
        },
        {
          "name": "nix - process and ptrace wrappers",
          "url": "https://github.com/nix-rust/nix"
        }
      ],
      "pitfall": "Attaching strace to a latency-sensitive service in production: the tracer serialises syscalls and slows the process enough to turn a mild slowdown into a timeout storm, while hiding the original race.",
      "resources": [
        {
          "title": "proc(5) - status, wchan, stack and smaps",
          "url": "https://man7.org/linux/man-pages/man5/proc.5.html",
          "kind": "docs"
        },
        {
          "title": "strace(1) - tracing syscalls and signals",
          "url": "https://man7.org/linux/man-pages/man1/strace.1.html",
          "kind": "docs"
        },
        {
          "title": "perf(1) - record, report and call graphs",
          "url": "https://man7.org/linux/man-pages/man1/perf.1.html",
          "kind": "docs"
        },
        {
          "title": "tokio-console source repository",
          "url": "https://github.com/tokio-rs/console",
          "kind": "repo"
        },
        {
          "title": "InfoQ - production systems and debugging talks",
          "url": "https://www.youtube.com/@InfoQ",
          "kind": "video"
        }
      ]
    }
  ]
};
