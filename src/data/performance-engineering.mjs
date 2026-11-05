/**
 * Performance engineering track.
 *
 * Versions checked against docs.rs and crates.io while authoring:
 * criterion 0.8.x (Rust 1.86+), pprof 0.15.x, iai-callgrind 0.16.x,
 * hdrhistogram 7.6.x (Rust 1.88+), tokio 1.54.x.
 *
 * Data is JSON-compatible and consumed by the plugin build.
 */
export default {
  key: "performance-engineering",
  prefix: "pf",
  title: "Performance engineering",
  blurb: "Measure before optimising: profiling, allocation, cache behaviour, latency budgets, tail latency, load testing and regression gates.",
  level: "industry",
  project: {
    title: "Capstone: make a slow service fast, with receipts",
    brief: "Take a deliberately slow Rust service - one that clones on every request, holds a global mutex, allocates per row, and answers from a table with no index - and make it fast without guessing. Profile it, fix the bottlenecks the profile actually names, and prove each change with a benchmark, a load test, and a number a reviewer can reproduce. Finish with a latency budget, an SLO report, and a CI gate that fails the next regression before a customer finds it.",
    deliverables: [
      "A committed baseline: criterion suite, flamegraph, allocation profile, and the machine/commit/rustc record they were produced on.",
      "Optimised hot paths, each with a before/after criterion comparison and one paragraph explaining why the change works.",
      "A per-hop latency budget with an SLO report built from coordinated-omission-corrected load tests (p50, p99, p999, error rate).",
      "A CI regression gate: instruction-count benchmarks for determinism plus a p99/throughput threshold with a documented noise floor.",
      "A cost-per-million-requests calculation before and after, including the instance shape that makes the workload cheapest."
    ],
    stack: [
      "criterion",
      "pprof",
      "iai-callgrind",
      "hdrhistogram",
      "oha",
      "tokio",
      "sqlx"
    ]
  },
  lessons: [
    {
      id: "pf01",
      n: 1,
      title: "Measure first: what a performance claim needs",
      minutes: 60,
      level: "core",
      goal: "Turn a vague complaint about slowness into a falsifiable claim: a named metric, a fixed workload, a controlled environment, and a committed baseline anyone can reproduce.",
      sections: [
        {
          h: "A performance claim is a measurement contract",
          p: [
            "Before a line of code changes, write down four things: the metric, the workload, the environment, and the comparison point. The metric is the one number the product is judged on, such as p99 latency at 200 requests per second. The workload fixes input size, concurrency, and cache state. The environment names the CPU, core count, kernel, rustc version, and build profile. The comparison names the commit you are beating. Miss any one of them and 'faster' becomes an opinion nobody can review.",
            "The metric also decides what you will accidentally sacrifice. Optimising throughput usually raises per-request latency; optimising the median usually worsens the tail; optimising CPU often increases memory. Name the guardrails up front - the numbers that must not regress - and treat them as part of done. A change that doubles throughput and triples p99 is not an optimisation, it is a trade you forgot to document."
          ],
          list: [
            "Latency: p50, p99, p999 and max, read from a histogram rather than a mean",
            "Throughput: requests per second at a fixed concurrency and error rate",
            "Efficiency: CPU-seconds, bytes allocated, or bytes moved per request",
            "Cost: currency per million requests at a stated utilisation"
          ],
          tip: "If two engineers can run your benchmark and land within your noise floor, the contract is good enough to act on."
        },
        {
          h: "Control the variables or measure noise",
          p: [
            "A benchmark is an experiment. Pin the build profile: benchmarks run in release mode with debug symbols, never in dev. Pin the machine: a shared CI runner with a noisy neighbour produces a different number every run, and a laptop on battery throttles mid-suite. Record the CPU model, core count, kernel, and rustc version in the result file, so a comparison across machines is visibly invalid instead of quietly wrong.",
            "Then measure the noise floor before measuring the change. Run the unmodified binary ten times and look at the spread of the metric you care about. If run-to-run p99 moves by 15%, a 5% improvement is not detectable, and any gate built on it will either fail constantly or never fail at all. The noise floor is the resolution of your experiment; every claim smaller than it is a coin flip."
          ],
          tip: "Benchmark the same binary twice before benchmarking a change. The difference between those two runs is your resolution."
        },
        {
          h: "Amdahl decides whether the work is worth doing",
          p: [
            "Optimisation has a ceiling. If a function accounts for 40% of wall time, making it infinitely fast improves the total by at most 1/(1-0.4) = 1.67x. That ceiling, not the function's own speedup, is what a plan should promise. Compute it before starting. If the ceiling sits below the target, the profile is telling you the bottleneck is elsewhere, and the most valuable next step is a better profile rather than a faster function.",
            "The corollary is that the largest wins usually move work off the critical path instead of making it faster: cache the result, batch the calls, do it asynchronously, or delete it. Those change the fraction itself, which is the only lever without a ceiling."
          ],
          code: `/// Upper bound on total speedup when a fraction \`p\` of the work
/// becomes infinitely fast. p is in [0, 1].
pub fn amdahl_ceiling(p: f64) -> f64 {
    assert!((0.0..=1.0).contains(&p), "fraction must be in [0, 1]");
    1.0 / (1.0 - p)
}

/// Speedup after improving that same fraction by \`speedup\` (4.0 means 4x).
pub fn amdahl_speedup(p: f64, speedup: f64) -> f64 {
    assert!(speedup >= 1.0, "a speedup below 1 is a regression");
    1.0 / ((1.0 - p) + p / speedup)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ceiling_matches_the_arithmetic() {
        assert!((amdahl_ceiling(0.40) - 1.6667).abs() < 1e-3);
        assert_eq!(amdahl_ceiling(0.0), 1.0);
    }

    #[test]
    fn a_four_x_fix_on_40_percent_is_not_4x() {
        // 1 / (0.6 + 0.1) = 1.428x end to end, not 4x
        assert!((amdahl_speedup(0.40, 4.0) - 1.4286).abs() < 1e-3);
    }
}`,
          tip: "Quote the ceiling, not the local speedup. A 10x faster function that is 5% of the request is a 5% faster service."
        },
        {
          h: "Write the baseline into the repository",
          p: [
            "A baseline that lives in a chat thread is gone next week. Commit it next to the benchmarks: the command, the commit hash, the machine, and the numbers, in a small file a reviewer can open. When someone claims a regression six months later, that file answers whether the machine changed or the code did.",
            "Keep the raw histogram or criterion output as an artifact, not just a summary. A mean cannot be re-derived into a p999, and the shape of the distribution is usually the interesting part: a bimodal latency histogram means two code paths, not one slow one."
          ],
          code: `# benches/BASELINE.toml - committed, updated deliberately
[run]
commit = "9f3c2ab"
date = "2026-03-14"
command = "cargo bench --bench parse -- --save-baseline main"
rustc = "rustc 1.86.0 (05f9846f8 2025-03-31)"
profile = "bench (release, debug = 1, lto = thin)"
cpu = "AMD EPYC 7B13, 8 vCPU, 3.5 GHz"
kernel = "6.8.0-45-generic"
governor = "performance"

[results.parse_csv_10k]
unit = "MiB/s"
median = 412.0
samples = 100

[results.get_order]
p50_ms = 1.8
p99_ms = 11.4
p999_ms = 38.0
load_test = "oha -z 60s -c 64 -q 800 --latency-correction"`,
          tip: "Commit the command, not only the number. A number without its invocation is a rumour."
        }
      ],
      exercise: {
        prompt: "A profile of one endpoint shows JSON decoding at 35% of request time, database work at 45%, and logging at 20%. Product asks for 2x throughput this quarter. Compute the ceiling for each single fix and for the best pair, then state in code which combination reaches 2x.",
        starter: `fn amdahl_speedup(fraction: f64, speedup: f64) -> f64 {
    // 1 / ((1 - fraction) + fraction / speedup)
    todo!()
}

fn main() {
    // decode: fraction 0.35, 3x faster
    // database: fraction 0.45, 2x faster
    // logging: fraction 0.20, 10x faster
    // print each end-to-end speedup, then the best pair, then all three
}`,
        hint: "Single fixes: decode 1/(0.65 + 0.35/3) = 1.30x, database 1/(0.55 + 0.225) = 1.29x, logging 1/(0.8 + 0.02) = 1.22x. Decode plus database is 1/(0.20 + 0.117 + 0.225) = 1.85x. Only all three together clear 2x.",
        solution: `fn amdahl_speedup(fraction: f64, speedup: f64) -> f64 {
    assert!((0.0..=1.0).contains(&fraction));
    assert!(speedup >= 1.0);
    1.0 / ((1.0 - fraction) + fraction / speedup)
}

fn main() {
    let decode = amdahl_speedup(0.35, 3.0);
    let database = amdahl_speedup(0.45, 2.0);
    let logging = amdahl_speedup(0.20, 10.0);

    println!("decode only:   {decode:.2}x");
    println!("database only: {database:.2}x");
    println!("logging only:  {logging:.2}x");

    // Combined fractions add; the remaining work is what is left.
    let pair = 1.0 / (0.20 + 0.35 / 3.0 + 0.45 / 2.0);
    println!("decode + db:   {pair:.2}x");

    let all = 1.0 / (0.35 / 3.0 + 0.45 / 2.0 + 0.20 / 10.0);
    println!("all three:     {all:.2}x");

    assert!(pair < 2.0, "no pair of fixes reaches the target");
    assert!(all > 2.0, "all three fixes do");

    // The honest plan: the pair gets 1.85x, so either add logging or
    // remove work entirely (cache decoded payloads) to change the fractions.
}`
      },
      production: [
        "Every performance PR links a committed baseline file naming commit, machine, profile, and command.",
        "Benchmarks run in the bench profile with debug symbols; timings from dev builds are never quoted.",
        "Guardrail metrics such as p99, memory, and error rate are listed beside the target metric in the PR.",
        "Baseline artifacts include raw histograms, not only means, so percentiles can be re-derived later.",
        "Claims smaller than the measured noise floor are reported as no measurable change."
      ],
      crates: ["criterion", "pprof", "hdrhistogram"],
      pitfall: "Profiling a dev build: the sampler spends its samples in allocator and formatting code, so the flamegraph points at the standard library and the optimisation you ship fixes nothing.",
      questions: [
        {
          q: "A change makes a function 4x faster, but that function is 25% of request time. What is the end-to-end speedup?",
          options: [
            "About 4x, because the change is a 4x improvement",
            "About 2.5x, the average of the improved and unimproved parts",
            "About 1.23x, from 1 / (0.75 + 0.25/4)",
            "Zero, because Amdahl's law only applies to parallel code"
          ],
          answer: 2,
          explain: "The untouched 75% dominates: 1 / (0.75 + 0.0625) = 1.23x. Local speedup is not service speedup."
        },
        {
          q: "Which baseline is usable as the reference for a regression gate?",
          options: [
            "The p99 from a single run on a shared CI runner",
            "The mean of ten runs on a developer laptop",
            "p99 from ten runs on a pinned machine, with commit, rustc version, and command recorded",
            "The fastest single request ever observed in production"
          ],
          answer: 2,
          explain: "A gate needs a reproducible environment, a distribution rather than one sample, and provenance so a later comparison knows what changed."
        },
        {
          q: "Why is mean latency a poor target for optimisation?",
          options: [
            "Means are always larger than medians",
            "The mean hides the tail users and SLOs are judged on, and a few slow requests barely move it",
            "Means cannot be computed from histograms",
            "Means require a normal distribution to be meaningful"
          ],
          answer: 1,
          explain: "A long tail is exactly what an average erases. One 4-second request among a thousand 20 ms requests moves the mean by 4 ms and the p99 by seconds."
        }
      ],
      quickbytes: [
        "Name the metric, workload, machine, and baseline commit before profiling; a claim missing one of the four cannot be reviewed.",
        "Run the unchanged binary ten times first; that spread is the smallest change you can honestly detect.",
        "Compute the Amdahl ceiling for the hottest function before promising a speedup; it caps the whole project.",
        "Commit the baseline file with the command that produced it, not just the number."
      ],
      github: [
        { name: "criterion.rs - statistical benchmarking for Rust", url: "https://github.com/criterion-rs/criterion.rs" },
        { name: "pprof-rs - CPU profiler with flamegraph output", url: "https://github.com/tikv/pprof-rs" }
      ],
      resources: [
        {
          title: "criterion crate documentation",
          url: "https://docs.rs/criterion/latest/criterion/",
          kind: "docs"
        },
        {
          title: "perf-record(1): sampling profiles with call graphs",
          url: "https://man7.org/linux/man-pages/man1/perf-record.1.html",
          kind: "docs"
        },
        {
          title: "The Tail at Scale (Dean & Barroso): why averages hide the problem",
          url: "https://research.google/pubs/the-tail-at-scale/",
          kind: "paper"
        },
        {
          title: "pprof-rs repository and usage notes",
          url: "https://github.com/tikv/pprof-rs",
          kind: "repo"
        }
      ]
    },
    {
      id: "pf02",
      n: 2,
      title: "Benchmarking with criterion: honest micro-benchmarks",
      minutes: 90,
      level: "core",
      goal: "Build micro-benchmarks that survive review: warm-up, black_box, batched setup, throughput per input size, and a statistical comparison instead of one stopwatch reading.",
      sections: [
        {
          h: "Why a stopwatch loop lies",
          p: [
            "A hand-rolled loop around Instant::now has four defects. The optimiser may delete the work because the result is never used. There is no warm-up, so the first iterations pay page faults and CPU frequency ramp. Setup such as cloning the input is timed along with the operation. And a single run has no error bar, so the difference between two implementations is indistinguishable from the difference between two afternoons.",
            "None of these are exotic; they are the default outcome of writing a loop and pressing run. Criterion exists to make each one an explicit choice: a warm-up phase that lets the CPU settle, a sample of many iterations, statistical analysis that reports an interval rather than a point, and a comparison against the previous run with a stated confidence level."
          ],
          list: [
            "Unused result: the compiler removes the loop entirely",
            "Setup inside the timed closure: you measure clone, not the algorithm",
            "No warm-up: early samples include page faults and frequency scaling",
            "One run: no confidence interval, so noise reads as a result"
          ]
        },
        {
          h: "Groups, inputs, and throughput",
          p: [
            "Criterion's defaults are a 3 s warm-up, a 5 s measurement, 100 samples, a 1% noise threshold, and 95% confidence. Those defaults are reasonable; change them deliberately when a benchmark is slow or noisy. Use benchmark_group when comparing variants, BenchmarkId to name each input, and Throughput to turn time into a rate so results read as MiB/s instead of nanoseconds per call."
          ],
          code: `use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use std::hint::black_box;

fn count_fields(input: &str) -> usize {
    input.split(',').filter(|field| !field.is_empty()).count()
}

fn bench_parse(c: &mut Criterion) {
    let mut group = c.benchmark_group("parse_csv");
    group.measurement_time(std::time::Duration::from_secs(10));
    group.sample_size(50);

    for rows in [1_000usize, 10_000, 100_000] {
        let payload = "alpha,beta,gamma\\n".repeat(rows);
        group.throughput(Throughput::Bytes(payload.len() as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(rows),
            &payload,
            |b, payload| b.iter(|| count_fields(black_box(payload))),
        );
    }
    group.finish();
}

criterion_group!(benches, bench_parse);
criterion_main!(benches);`,
          tip: "Throughput::Bytes turns a benchmark into a bandwidth measurement, which is the number that matters once data stops fitting in cache."
        },
        {
          h: "Keep setup out of the measurement",
          p: [
            "b.iter times the whole closure, which is correct only when the operation includes its own setup. For anything that consumes or mutates an input, use iter_batched: the first closure builds the input, the second runs the measured code, and criterion times only the second. BatchSize tells criterion whether that setup is cheap or expensive, which controls how many inputs it prepares per batch.",
            "The classic bug is benchmarking sort by cloning the vector inside iter. The clone is O(n) memory traffic, often comparable to the sort itself, and it hides the improvement you are trying to measure. If the clone dominates, a 20% faster sort looks like a 3% faster benchmark, and the change gets rejected for the wrong reason."
          ],
          code: `use criterion::{criterion_group, criterion_main, BatchSize, Criterion};
use std::hint::black_box;

fn bench_sort(c: &mut Criterion) {
    let input: Vec<u64> = (0..10_000).rev().collect();

    c.bench_function("sort_10k_clone_inside", |b| {
        // WRONG: the clone and its allocation are part of the measurement
        b.iter(|| {
            let mut v = black_box(&input).to_vec();
            v.sort_unstable();
            black_box(v)
        })
    });

    c.bench_function("sort_10k_setup_outside", |b| {
        b.iter_batched(
            || input.clone(), // setup: prepared, not timed
            |mut v| {
                v.sort_unstable();
                black_box(v)
            },
            BatchSize::SmallInput,
        )
    });
}

criterion_group!(benches, bench_sort);
criterion_main!(benches);`,
          tip: "If the benchmark's result is a new allocation, black_box it. Returning a value the harness ignores is the fastest way to benchmark an empty function."
        },
        {
          h: "Comparing runs without fooling yourself",
          p: [
            "Criterion compares each run with the previous one and prints a change estimate with a confidence interval. If the interval straddles zero, or the change is under the 1% noise threshold, the honest conclusion is 'no measurable difference', not 'slightly faster'. Use save_baseline to pin a named baseline on main and retain_baseline to compare feature branches against it, and critcmp to diff several saved baselines at once.",
            "Two habits keep the numbers trustworthy. Compare like with like: same machine, same profile, same input, same session. And treat a surprising result as a bug in the benchmark first - check that the optimised version was not simply optimised away, and that the new code path is actually executed rather than skipped by a branch the input never takes."
          ],
          tip: "A benchmark that gets suspiciously fast after a refactor is usually a benchmark that no longer measures anything."
        }
      ],
      exercise: {
        prompt: "Benchmark two ways to join 10,000 integers into a comma-separated string: repeated push_str with format!, and a preallocated String written through fmt::Write. Report throughput in elements per second and compare both against a saved baseline.",
        starter: `use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use std::hint::black_box;

fn join_with_format(values: &[u32]) -> String {
    // one format! per element, no capacity hint
    todo!()
}

fn join_preallocated(values: &[u32]) -> String {
    // with_capacity + write!
    todo!()
}

fn bench_join(c: &mut Criterion) {
    let values: Vec<u32> = (0..10_000).collect();
    let mut group = c.benchmark_group("join");
    // 1. set throughput in elements
    // 2. benchmark both functions on the same input
    group.finish();
}

criterion_group!(benches, bench_join);
criterion_main!(benches);`,
        hint: "group.throughput(Throughput::Elements(values.len() as u64)), then group.bench_with_input(BenchmarkId::new(name, values.len()), &values, |b, v| b.iter(|| f(black_box(v)))). Keep the same input slice for both so only the implementation changes.",
        solution: `use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use std::fmt::Write as _;
use std::hint::black_box;

fn join_with_format(values: &[u32]) -> String {
    let mut out = String::new();
    for v in values {
        out.push_str(&format!("{v},"));
    }
    out
}

fn join_preallocated(values: &[u32]) -> String {
    let mut out = String::with_capacity(values.len() * 6);
    for v in values {
        let _ = write!(out, "{v},");
    }
    out
}

fn bench_join(c: &mut Criterion) {
    let values: Vec<u32> = (0..10_000).collect();
    let mut group = c.benchmark_group("join");
    group.throughput(Throughput::Elements(values.len() as u64));

    for (name, f) in [
        ("format", join_with_format as fn(&[u32]) -> String),
        ("preallocated", join_preallocated as fn(&[u32]) -> String),
    ] {
        group.bench_with_input(BenchmarkId::new(name, values.len()), &values, |b, v| {
            b.iter(|| f(black_box(v)))
        });
    }

    group.finish();
}

criterion_group!(benches, bench_join);
criterion_main!(benches);

// Run with: cargo bench --bench join -- --save-baseline main
// The preallocated version usually wins by removing reallocation and the
// per-element format! machinery; check the change interval, not the point
// estimate.`
      },
      production: [
        "Every benchmark states its input sizes and whether setup sits inside or outside the timed region.",
        "Benchmark groups use BenchmarkId and Throughput so results stay comparable across sizes.",
        "Baselines are saved by name on main and compared with retain_baseline on feature branches.",
        "Slow or noisy benchmarks set sample_size and measurement_time explicitly instead of relying on defaults.",
        "A benchmark whose result is unused is treated as a bug: black_box the inputs and outputs."
      ],
      crates: ["criterion", "iai-callgrind"],
      pitfall: "Cloning the input inside b.iter: allocation and memcpy are timed as part of the operation, and the improvement you are testing disappears into the setup cost.",
      questions: [
        {
          q: "What does std::hint::black_box do in a benchmark?",
          options: [
            "It prevents the optimiser from removing or hoisting the computation by treating the value as opaque",
            "It flushes the CPU cache between iterations",
            "It forces the closure to run on a separate thread",
            "It counts the instructions the closure executes"
          ],
          answer: 0,
          explain: "black_box is an optimisation barrier, not a measurement tool. Without it the compiler may delete work whose result is never observed."
        },
        {
          q: "A run reports +3.0% with a 95% confidence interval of [-1.8%, +7.9%]. What is the correct conclusion?",
          options: [
            "It is a 3% regression and should be reverted",
            "It is a 3% improvement and should be merged",
            "The difference is not distinguishable from noise; gather more samples or report no measurable change",
            "Rerun until the interval excludes zero"
          ],
          answer: 2,
          explain: "An interval spanning zero cannot support a direction. Rerunning until it does is p-hacking, not measurement."
        },
        {
          q: "Why use iter_batched instead of iter when the benchmark sorts a Vec<u64>?",
          options: [
            "iter cannot measure operations that allocate",
            "iter_batched excludes input construction from the measured time",
            "iter_batched runs every iteration on a new thread",
            "iter_batched disables the warm-up phase"
          ],
          answer: 1,
          explain: "iter times everything in the closure, including the clone. iter_batched moves construction into an untimed setup phase so only the sort is measured."
        }
      ],
      quickbytes: [
        "Wrap inputs and outputs in black_box; an unread result invites the optimiser to delete the work.",
        "Use Throughput::Elements or ::Bytes so results read as rates and stay comparable across input sizes.",
        "Treat a change inside the 1% noise threshold, or an interval straddling zero, as no measurable difference.",
        "Save a named baseline on main and compare branches with retain_baseline plus critcmp."
      ],
      github: [
        { name: "criterion.rs - benchmarking harness and baseline comparison", url: "https://github.com/criterion-rs/criterion.rs" },
        { name: "iai-callgrind - instruction-count benchmarks for CI", url: "https://github.com/gungraun/gungraun" }
      ],
      resources: [
        {
          title: "criterion::Criterion: warm-up, measurement, baselines, noise threshold",
          url: "https://docs.rs/criterion/latest/criterion/struct.Criterion.html",
          kind: "docs"
        },
        {
          title: "criterion.rs repository and book",
          url: "https://github.com/criterion-rs/criterion.rs",
          kind: "repo"
        },
        {
          title: "iai-callgrind: deterministic instruction-count benchmarks",
          url: "https://docs.rs/iai-callgrind/latest/iai_callgrind/",
          kind: "docs"
        },
        {
          title: "InfoQ: engineering talks on benchmarking and performance practice",
          url: "https://www.youtube.com/@InfoQ",
          kind: "video"
        }
      ]
    },
    {
      id: "pf03",
      n: 3,
      title: "Profilers and flamegraphs: where the time actually goes",
      minutes: 105,
      level: "core",
      goal: "Sample a running Rust program with perf or pprof, read a flamegraph correctly, and turn the widest self-time frame into a concrete, testable hypothesis.",
      sections: [
        {
          h: "Sampling finds the cost you did not predict",
          p: [
            "A sampling profiler interrupts the program at a fixed frequency and records the stack. Ten thousand samples describe where time is spent without instrumenting a single function. Overhead is low enough to run against production-like load, which matters because microbenchmarks systematically miss costs that only appear under concurrency: allocator contention, lock queues, page faults, and syscalls.",
            "On Linux, perf record -F 999 -g --call-graph dwarf -p <pid> captures user and kernel stacks, and perf report opens them. Frame pointers are cheaper to unwind but are omitted by default in optimised builds, so dwarf is the reliable choice for a Rust binary built with debug = 1."
          ],
          list: [
            "Sample at a prime frequency such as 997 Hz to avoid lock-step with timers",
            "Build with debug = 1 in bench and release profiles so symbols resolve",
            "Profile the real workload when the question is about a service, not a synthetic loop",
            "Blocked time needs off-CPU profiling (perf record --off-cpu), not an on-CPU sampler"
          ]
        },
        {
          h: "In-process profiling with pprof",
          p: [
            "When you cannot run perf, or want a profile inside CI, pprof samples within the process. The guard starts collection, report().build() resolves samples to symbols, and the flamegraph feature writes an SVG. Keep the blocklist: skipping libc, libgcc, pthread and vdso avoids unwinder deadlocks and the bogus vdso frames some distributions ship."
          ],
          code: `// Cargo.toml: pprof = { version = "0.15", features = ["flamegraph"] }
use std::fs::File;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let guard = pprof::ProfilerGuardBuilder::default()
        .frequency(997) // prime: avoids resonating with timer ticks
        .blocklist(&["libc", "libgcc", "pthread", "vdso"])
        .build()?;

    // The workload under investigation.
    let mut acc = 0u64;
    for i in 0..50_000_000u64 {
        acc = acc.wrapping_add(i.rotate_left(7));
    }
    std::hint::black_box(acc);

    let report = guard.report().build()?;
    let file = File::create("flamegraph.svg")?;
    report.flamegraph(file)?;
    Ok(())
}`,
          tip: "Report is only valid while the guard lives. Build the report, write the file, then drop the guard."
        },
        {
          h: "Reading a flamegraph without being fooled",
          p: [
            "Width is the number of samples in which a frame appeared anywhere on the stack, not the time spent in that function. A wide frame low in the graph is a function that is on the stack a lot; the frames above it explain why. Look for plateaus: a wide frame with wide children and no dominant child means the cost is spread across that subsystem rather than concentrated in one call.",
            "Two distortions matter. Inlining merges small functions into their caller, so a hot helper can be invisible. And sampling attributes time to the instruction pointer, so a thread blocked in a syscall shows up in kernel frames, not in your Rust function. A differential flamegraph, comparing two profiles, is usually more informative than either one alone."
          ]
        },
        {
          h: "Profile the build and the workload you ship",
          p: [
            "A profile of a debug build is a profile of the standard library: bounds checks, unoptimised formatting, and allocation dominate. Use the same profile as production, with symbols. If the question is why an endpoint is slow, drive it with the load test rather than a microbenchmark, and sample long enough that the slow path appears a few hundred times - otherwise the tail you are chasing is statistical noise in the profile itself."
          ],
          tip: "If a frame has no symbol, you are looking at a stripped binary, not at an absence of cost."
        }
      ],
      exercise: {
        prompt: "Wrap a CPU-bound sum in a pprof guard, write flamegraph.svg, then run it twice: once over Vec<u64> and once over Vec<Box<u64>>. Explain which frame widens and why.",
        starter: `// Cargo.toml: pprof = { version = "0.15", features = ["flamegraph"] }
use std::fs::File;

fn sum_flat(values: &[u64]) -> u64 {
    values.iter().sum()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1. start a ProfilerGuardBuilder around 1000 Hz with a blocklist
    // 2. run the workload over 5 million values
    // 3. write flamegraph.svg
    todo!()
}`,
        hint: "Create the guard before the loop, build the report after it, and write with report.flamegraph(File::create(\"flamegraph.svg\")?). The boxed version adds one pointer chase per element, so cache-miss frames widen while sum_flat itself narrows.",
        solution: `use std::fs::File;

fn sum_flat(values: &[u64]) -> u64 {
    values.iter().sum()
}

fn sum_boxed(values: &[Box<u64>]) -> u64 {
    values.iter().map(|v| **v).sum()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let flat: Vec<u64> = (0..5_000_000).collect();
    let boxed: Vec<Box<u64>> = (0..5_000_000).map(Box::new).collect();

    let guard = pprof::ProfilerGuardBuilder::default()
        .frequency(997)
        .blocklist(&["libc", "libgcc", "pthread", "vdso"])
        .build()?;

    let a = sum_flat(&flat);
    let b = sum_boxed(&boxed);
    std::hint::black_box((a, b));

    let report = guard.report().build()?;
    report.flamegraph(File::create("flamegraph.svg")?)?;

    println!("flat={a} boxed={b}");
    Ok(())
}

// Expected reading: sum_flat is a tight loop with few samples in the allocator.
// sum_boxed shows wide frames under the deref path - each Box is a separate
// allocation, so the traversal is a pointer chase with a cache miss per element.
// The fix is not a faster sum; it is Vec<u64> instead of Vec<Box<u64>> (pf05).`
      },
      production: [
        "Production-like profiles are captured with symbols and the same optimisation profile that ships.",
        "Sampling frequency is prime and stated in the profiling notes so runs are comparable.",
        "Flamegraphs are stored as artifacts next to the load-test report they explain.",
        "Any optimisation claim from a profile names the frame and the mechanism, not just the percentage.",
        "Off-CPU time is measured separately when latency, not throughput, is the complaint."
      ],
      crates: ["pprof", "flamegraph", "criterion"],
      pitfall: "Optimising the widest frame in a debug-build profile, which turns out to be core::fmt: release builds inline the formatting away and the cost you measured never existed.",
      questions: [
        {
          q: "In a flamegraph, what does the width of a frame represent?",
          options: [
            "The wall-clock time spent executing that function's own instructions",
            "The share of samples in which that frame appeared anywhere on the stack",
            "The number of times the function was called",
            "The function's memory allocation total"
          ],
          answer: 1,
          explain: "Width is sample share, inclusive of callees. A wide frame may spend almost none of that time in its own instructions."
        },
        {
          q: "Why does a profile of a debug build mislead?",
          options: [
            "Debug builds cannot be sampled by perf",
            "Symbols are missing, so every frame is Unknown",
            "Optimisations are off, so bounds checks, formatting, and allocation dominate the samples",
            "Debug builds run on a different CPU architecture"
          ],
          answer: 2,
          explain: "The profile describes unoptimised code. The hot frame in dev is often not hot at all in release."
        },
        {
          q: "A function holds 60% of samples but its largest child holds 55%. Where is the cost?",
          options: [
            "In the parent function's own instructions",
            "In the child; the parent is wide because it is on the stack, not because it computes",
            "Split evenly between parent and child",
            "It cannot be determined without instrumentation"
          ],
          answer: 1,
          explain: "Inclusive width propagates upward. Self time is the difference between a frame and its children, which here is about 5%."
        }
      ],
      quickbytes: [
        "Sample at a prime frequency such as 997 Hz and build with debug = 1; symbols are the difference between a profile and a picture.",
        "Read flamegraphs by self time: subtract children from the parent before optimising anything.",
        "Blocked threads do not appear in on-CPU samples; use off-CPU profiling for latency work.",
        "Keep the flamegraph artifact next to the benchmark that produced it."
      ],
      github: [
        { name: "pprof-rs - in-process sampling profiler", url: "https://github.com/tikv/pprof-rs" },
        { name: "flamegraph - cargo flamegraph wrapper", url: "https://github.com/flamegraph-rs/flamegraph" }
      ],
      resources: [
        {
          title: "pprof crate documentation and flamegraph feature",
          url: "https://docs.rs/pprof/0.14.1/pprof/",
          kind: "docs"
        },
        {
          title: "perf-record(1): call graphs, off-CPU profiling, sample frequency",
          url: "https://man7.org/linux/man-pages/man1/perf-record.1.html",
          kind: "docs"
        },
        {
          title: "Brendan Gregg's FlameGraph tooling",
          url: "https://github.com/brendangregg/FlameGraph",
          kind: "repo"
        },
        {
          title: "USENIX Association: systems performance talks",
          url: "https://www.youtube.com/@USENIX",
          kind: "video"
        }
      ]
    },
    {
      id: "pf04",
      n: 4,
      title: "Allocation analysis: count, size, and lifetime",
      minutes: 90,
      level: "advanced",
      goal: "Measure allocator traffic instead of guessing: count allocations with a global allocator, attribute them to call sites with DHAT, and remove the ones that matter.",
      sections: [
        {
          h: "What an allocation actually costs",
          p: [
            "An allocation is not one instruction. It is a call into the allocator, a size-class lookup, often an atomic or a lock, a cold cache line, and eventually a free that returns the block to a size class. Uncontended that is tens of nanoseconds; under contention it is microseconds, and every new page the allocator touches costs a page fault. At 50,000 requests per second, one avoidable allocation per request is 50,000 allocator round trips per second.",
            "The second cost is layout. Allocations scatter logically adjacent data across the heap, so traversal becomes pointer chasing. That is why removing allocations often improves more than the allocator time alone: it restores locality, which is the subject of the next lesson."
          ],
          list: [
            "Per-request allocations multiply by QPS; count them, do not estimate",
            "Bytes matter for cache footprint, blocks matter for allocator overhead",
            "A clone is an allocation plus a memcpy, and both appear in the profile",
            "jemalloc or mimalloc changes the constant, not the asymptotic cost"
          ]
        },
        {
          h: "Count allocations with a global allocator",
          p: [
            "A counting GlobalAlloc wrapper is twenty lines and answers the first question in any investigation: does this path allocate at all? Use relaxed atomics - the counters are diagnostics, not synchronisation - and take snapshots around the region of interest. Keep it behind a feature flag so the counters do not tax production builds, and remember that realloc counts as an allocation because it usually copies."
          ],
          code: `use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU64, Ordering};

static ALLOCS: AtomicU64 = AtomicU64::new(0);
static BYTES: AtomicU64 = AtomicU64::new(0);

struct Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
        BYTES.fetch_add(layout.size() as u64, Ordering::Relaxed);
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
        BYTES.fetch_add(new_size as u64, Ordering::Relaxed);
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

pub fn snapshot() -> (u64, u64) {
    (ALLOCS.load(Ordering::Relaxed), BYTES.load(Ordering::Relaxed))
}`,
          tip: "Counting allocations inside a test turns 'this path should not allocate' into an assertion instead of a hope."
        },
        {
          h: "Attribute allocations with DHAT",
          p: [
            "Counting tells you how many; DHAT tells you where. The dhat crate installs a profiling allocator, records every block with its backtrace, and writes dhat-heap.json when the profiler drops; the viewer then shows total blocks, total bytes, and the hottest allocation site. The distinction matters: ten thousand tiny blocks is an allocator-overhead problem, while one 200 MiB block is a memory-footprint problem, and they have different fixes."
          ],
          code: `// Cargo.toml: dhat = "0.3"
fn main() {
    let _profiler = dhat::Profiler::new_heap();

    let mut rows = Vec::new();
    for i in 0..10_000 {
        // One String allocation per row: 10k blocks, visible in DHAT.
        rows.push(format!("row-{i}"));
    }

    let stats = dhat::HeapStats::get();
    println!(
        "blocks={} bytes={} max_bytes={}",
        stats.total_blocks, stats.total_bytes, stats.max_bytes
    );

    // dhat-heap.json is written when _profiler drops.
    // Open it with the dh_view.html shipped by the crate.
}`,
          tip: "Compare total_blocks between two runs, not only total_bytes: the allocator cares about the number of calls."
        },
        {
          h: "Fixes that remove allocations",
          p: [
            "The reliable fixes are boring: reserve capacity with Vec::with_capacity, reuse a buffer across requests instead of allocating per request, write into a String with write! instead of format! plus push_str, return Cow<str> when the borrowed case dominates, use SmallVec or ArrayVec when the collection is usually tiny, and share immutable bytes with Bytes instead of copying.",
            "Each has a trade. SmallVec puts the inline capacity inside every value, so a collection that is usually large pays a memcpy on every move. Reused buffers need a pool and a clear-on-return discipline, or they leak data between requests. Bytes makes ownership shared, which is excellent for zero-copy and hostile to code that assumed mutation was free."
          ],
          tip: "Optimise block count when the allocator is hot; optimise bytes when RSS or cache footprint is the problem. They are different bugs with different fixes."
        }
      ],
      exercise: {
        prompt: "Add a counting global allocator to a binary, then format 1,000 rows into one reusable String. Assert that after a warm-up iteration the loop performs zero allocations.",
        starter: `use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU64, Ordering};

static ALLOCS: AtomicU64 = AtomicU64::new(0);
static BYTES: AtomicU64 = AtomicU64::new(0);

struct Counting;
unsafe impl GlobalAlloc for Counting { /* alloc, dealloc, realloc */ }

#[global_allocator]
static GLOBAL: Counting = Counting;

fn main() {
    // 1. snapshot before
    // 2. format 1000 rows into a String that is cleared, not reallocated
    // 3. assert the delta is zero
}`,
        hint: "Allocate the String once with with_capacity, call out.clear() at the top of each iteration, and append with write!(out, ...). Take the snapshot after the first iteration, because the first pass may grow the buffer.",
        solution: `use std::alloc::{GlobalAlloc, Layout, System};
use std::fmt::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};

static ALLOCS: AtomicU64 = AtomicU64::new(0);

struct Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

fn format_rows(out: &mut String, rows: usize) {
    out.clear();
    for i in 0..rows {
        let _ = writeln!(out, "row-{i}");
    }
}

fn main() {
    let mut buffer = String::with_capacity(64 * 1024);
    format_rows(&mut buffer, 1_000); // warm-up: buffer may grow here

    let before = ALLOCS.load(Ordering::Relaxed);
    for _ in 0..100 {
        format_rows(&mut buffer, 1_000);
    }
    let after = ALLOCS.load(Ordering::Relaxed);

    println!("allocations in 100 iterations: {}", after - before);
    assert_eq!(after, before, "the hot loop must not allocate");
    assert!(buffer.len() > 0);
}`
      },
      production: [
        "Request handlers are tested for zero allocations on the steady-state path where latency matters.",
        "Allocation counters run behind a feature flag and are never compiled into the release artefact.",
        "Buffers are pooled and cleared on return, with a documented maximum size.",
        "DHAT profiles are captured for any endpoint whose p99 is dominated by allocator time.",
        "Every with_capacity is justified by a measured bound, not a guess."
      ],
      crates: ["dhat", "smallvec", "bumpalo", "mimalloc"],
      pitfall: "Chasing allocation count while bytes and cache misses dominate: a handler can allocate once per request into a 2 MiB buffer and still be slow, because the problem is footprint, not call count.",
      questions: [
        {
          q: "Which pattern most directly increases allocator contention under high concurrency?",
          options: [
            "Many small short-lived allocations on every request",
            "One large buffer allocated per connection at startup",
            "Fixed-size arrays held on the stack",
            "Static string literals returned from handlers"
          ],
          answer: 0,
          explain: "Each small allocation and free is an allocator round trip that can hit a shared lock or atomic. At high QPS the queue forms at the allocator, not at your code."
        },
        {
          q: "DHAT reports 10,000 blocks totalling only 640 KiB for a single request. What is the likely fix?",
          options: [
            "Reduce the size of each block with a smaller struct",
            "Remove the per-item allocations by pooling, batching, or SmallVec",
            "Switch to a different allocator and keep the code",
            "Increase the thread stack size"
          ],
          answer: 1,
          explain: "Ten thousand blocks is allocator overhead and pointer chasing, not footprint. Block count is the signal; the fix is to allocate once."
        },
        {
          q: "Why can SmallVec be slower than Vec for a collection that is usually large?",
          options: [
            "SmallVec cannot hold more than its inline capacity",
            "Every value carries the inline array, so moving or growing it copies that array",
            "SmallVec disables the optimiser",
            "SmallVec allocates on the stack and Rust forbids that"
          ],
          answer: 1,
          explain: "SmallVec spills to the heap when large, but the inline buffer is still part of every value and is copied on moves. Choose it for usually-small collections."
        }
      ],
      quickbytes: [
        "Snapshot allocation counters around the steady-state path, not around startup.",
        "Use DHAT when you know it allocates but not where; use the counter when you need an assertion.",
        "Replace format! plus push_str with write! into a reused String; it removes a temporary per call.",
        "Bytes and Cow remove copies; they do not remove allocations unless the borrowed path dominates."
      ],
      github: [
        { name: "dhat-rs - heap profiling with call sites", url: "https://github.com/nnethercote/dhat-rs" },
        { name: "mimalloc - allocator used as a drop-in replacement", url: "https://github.com/microsoft/mimalloc" }
      ],
      resources: [
        {
          title: "std::alloc::GlobalAlloc: implementing a counting allocator",
          url: "https://doc.rust-lang.org/std/alloc/trait.GlobalAlloc.html",
          kind: "docs"
        },
        {
          title: "dhat-rs repository and viewer",
          url: "https://github.com/nnethercote/dhat-rs",
          kind: "repo"
        },
        {
          title: "iai-callgrind: running DHAT inside benchmarks",
          url: "https://docs.rs/iai-callgrind/latest/iai_callgrind/",
          kind: "docs"
        },
        {
          title: "InfoQ: allocator and memory-layout engineering talks",
          url: "https://www.youtube.com/@InfoQ",
          kind: "video"
        }
      ]
    },
    {
      id: "pf05",
      n: 5,
      title: "Cache-friendly data layout",
      minutes: 105,
      level: "advanced",
      goal: "Reason about cache lines and memory hierarchy, then restructure data from array-of-structs to struct-of-arrays and eliminate false sharing where it matters.",
      sections: [
        {
          h: "The hierarchy in numbers",
          p: [
            "A modern core can retire several instructions per cycle; an L1 hit costs about 4 cycles, L2 around 14, L3 in the tens, and DRAM 200 to 350. At 3 GHz, one DRAM miss is roughly the time to execute a thousand instructions. That is the whole justification for caring about layout: the CPU is rarely slow, it is waiting.",
            "Data moves in 64-byte cache lines, so touching one byte pulls in the whole line. A loop that uses 4 of those 64 bytes wastes most of the bandwidth it paid for. Hardware prefetchers hide sequential streams well and struggle with pointer chasing, which is why a flat vector beats a linked structure even when the linked structure has better complexity on paper."
          ],
          list: [
            "L1 about 4 cycles, L2 about 14, L3 about 40, DRAM 200-350: the ratios matter more than the exact numbers",
            "Lines are 64 bytes; use every byte of the line you fault in",
            "Sequential access is prefetched, pointer chasing is not",
            "A Vec<Box<T>> traverses like a linked list with extra steps"
          ]
        },
        {
          h: "Array-of-structs versus struct-of-arrays",
          p: [
            "Array-of-structs is the natural way to model a particle or an order, and it is the wrong layout when a hot loop reads one field across many elements. SoA stores each field in its own vector, so a pass over x streams 4 bytes per element instead of 16, and the prefetcher sees a pure sequential stream. The cost is that code touching every field now reads several streams - usually acceptable, because sequential streams still prefetch."
          ],
          code: `#[derive(Clone, Copy)]
struct Particle {
    x: f32,
    y: f32,
    z: f32,
    mass: f32,
} // 16 bytes: four particles per 64-byte line

struct AoS {
    items: Vec<Particle>,
}

struct SoA {
    x: Vec<f32>,
    y: Vec<f32>,
    z: Vec<f32>,
    mass: Vec<f32>,
}

fn sum_x_aos(p: &AoS) -> f32 {
    // Reads 16 bytes per element to use 4.
    p.items.iter().map(|p| p.x).sum()
}

fn sum_x_soa(p: &SoA) -> f32 {
    // Reads 4 bytes per element, sequentially.
    p.x.iter().sum()
}

#[test]
fn layout_is_what_we_think() {
    assert_eq!(std::mem::size_of::<Particle>(), 16);
}`,
          tip: "Convert only the arrays a hot loop touches. Converting everything doubles the code and helps nothing if the loop still reads all fields."
        },
        {
          h: "Padding, alignment, and false sharing",
          p: [
            "Rust's default layout may reorder fields, which is fine until you rely on offsets. repr(C) fixes declaration order for FFI and for on-disk formats; repr(align(N)) raises alignment. Padding is not waste when it separates two atomics written by different cores: false sharing makes each write invalidate the other core's line, turning two independent counters into a ping-pong match that scales negatively with threads."
          ],
          code: `use std::mem::{align_of, size_of};
use std::sync::atomic::AtomicU64;

#[repr(C)]
struct Flags {
    a: bool,
    b: bool,
}

#[repr(C, align(64))]
struct PaddedCounter {
    value: AtomicU64,
}

#[test]
fn layout_is_explicit() {
    assert_eq!(size_of::<Flags>(), 2);           // packed together
    assert_eq!(size_of::<PaddedCounter>(), 64);  // one counter per line
    assert_eq!(align_of::<PaddedCounter>(), 64);
}

// Portable alternative: crossbeam_utils::CachePadded<T>
// static COUNTER: CachePadded<AtomicU64> = CachePadded::new(AtomicU64::new(0));`,
          tip: "Suspect false sharing when throughput falls as you add threads and the profile shows time in atomic operations rather than in your logic."
        },
        {
          h: "Indices instead of pointers",
          p: [
            "When a structure needs cross-references, store u32 indices into a Vec instead of Box pointers. The graph becomes contiguous, traversal becomes prefetchable, and the whole arena can be cloned or serialised with one memcpy. The trade is that indices need validation, deletion needs a free list or tombstones, and a stale index is a logic bug rather than something the borrow checker would have caught."
          ]
        }
      ],
      exercise: {
        prompt: "A hot loop sums total_cents over a Vec<Order> of one million rows, where Order is 48 bytes. Convert the field to struct-of-arrays, benchmark both with criterion, and state how many bytes each version streams.",
        starter: `#[derive(Clone)]
struct Order {
    id: u64,
    customer_id: u64,
    total_cents: u64,
    created_at: i64,
    status: u8,
    _pad: [u8; 7],
}

fn sum_aos(orders: &[Order]) -> u64 {
    orders.iter().map(|o| o.total_cents).sum()
}

fn main() {
    // 1. build 1_000_000 orders
    // 2. add an SoA version holding only total_cents
    // 3. benchmark both and compute bytes streamed
}`,
        hint: "AoS streams size_of::<Order>() = 48 bytes per row (48 MB); SoA streams 8 bytes per row (8 MB). Keep identical values in both so only the layout changes.",
        solution: `use criterion::{criterion_group, criterion_main, Criterion};
use std::hint::black_box;

#[derive(Clone)]
struct Order {
    id: u64,
    customer_id: u64,
    total_cents: u64,
    created_at: i64,
    status: u8,
    _pad: [u8; 7],
}

fn sum_aos(orders: &[Order]) -> u64 {
    orders.iter().map(|o| o.total_cents).sum()
}

fn sum_soa(totals: &[u64]) -> u64 {
    totals.iter().sum()
}

fn bench_layout(c: &mut Criterion) {
    let orders: Vec<Order> = (0..1_000_000)
        .map(|i| Order {
            id: i,
            customer_id: i % 50_000,
            total_cents: i % 9_999,
            created_at: i as i64,
            status: 1,
            _pad: [0; 7],
        })
        .collect();
    let totals: Vec<u64> = orders.iter().map(|o| o.total_cents).collect();

    let mut group = c.benchmark_group("sum_total_cents");
    group.bench_function("aos_48b_per_row", |b| {
        b.iter(|| sum_aos(black_box(&orders)))
    });
    group.bench_function("soa_8b_per_row", |b| {
        b.iter(|| sum_soa(black_box(&totals)))
    });
    group.finish();

    // AoS: 1e6 * 48 B = 48 MB streamed per pass.
    // SoA: 1e6 *  8 B =  8 MB streamed per pass.
    // At a few GB/s of effective bandwidth, the SoA pass should be
    // several times faster even though both do the same additions.
}

criterion_group!(benches, bench_layout);
criterion_main!(benches);`
      },
      production: [
        "Hot loops are reviewed for the bytes they stream per element, not only for their operation count.",
        "repr(C) or repr(align) appears only where layout is a contract, with a comment naming the contract.",
        "Counters written by different threads are padded or sharded to separate cache lines.",
        "Large collections are Vec<T> or arena-plus-index; Vec<Box<T>> is justified explicitly when used.",
        "A layout change ships with a benchmark showing bytes moved or time per element."
      ],
      crates: ["crossbeam-utils", "criterion", "smallvec"],
      pitfall: "Measuring a layout change on a working set that fits in L2: both versions hit cache, the benchmark shows no difference, and you conclude layout does not matter.",
      questions: [
        {
          q: "Why is summing Vec<Box<u64>> much slower than summing Vec<u64>?",
          options: [
            "Box adds a bounds check on every access",
            "Each element is a separate allocation, so the loop performs a dependent load per item",
            "Box<u64> stores the value on the stack",
            "Vec<Box<u64>> cannot use SIMD because u64 is not a SIMD type"
          ],
          answer: 1,
          explain: "The pointer chase defeats the prefetcher and adds a cache miss per element. The arithmetic is identical; the memory access pattern is not."
        },
        {
          q: "Two threads increment two separate AtomicU64 counters that sit next to each other in memory. What happens?",
          options: [
            "Nothing; separate variables never interact",
            "False sharing: each write invalidates the other core's cache line, so throughput drops",
            "The compiler merges the counters",
            "The counters become eventually consistent"
          ],
          answer: 1,
          explain: "Coherence works on cache lines, not variables. Padding each counter to its own line removes the ping-pong."
        },
        {
          q: "What does repr(C) guarantee for a struct?",
          options: [
            "Fields are laid out in declaration order with C-compatible padding and alignment",
            "The struct is allocated on the stack",
            "The struct is cache-line aligned",
            "Fields are reordered for minimal size"
          ],
          answer: 0,
          explain: "repr(C) fixes the layout contract. The default Rust layout is free to reorder fields, which is usually better for size and worse for anything that depends on offsets."
        }
      ],
      quickbytes: [
        "Count bytes streamed per element before optimising instructions; most hot loops are waiting on memory.",
        "Convert only the arrays a hot loop reads to SoA; leave the rest alone.",
        "Pad or shard counters that different threads write, and suspect false sharing when more threads means less throughput.",
        "Prefer Vec<T> plus u32 indices over Vec<Box<T>> for graph-shaped data."
      ],
      github: [
        { name: "crossbeam - CachePadded and lock-free utilities", url: "https://github.com/crossbeam-rs/crossbeam" },
        { name: "criterion.rs - benchmarking the layout change", url: "https://github.com/criterion-rs/criterion.rs" }
      ],
      resources: [
        {
          title: "The Rust Reference: type layout, repr(C), repr(align)",
          url: "https://doc.rust-lang.org/reference/type-layout.html",
          kind: "docs"
        },
        {
          title: "crossbeam-utils CachePadded documentation",
          url: "https://docs.rs/crossbeam-utils/latest/crossbeam_utils/struct.CachePadded.html",
          kind: "docs"
        },
        {
          title: "STREAM benchmark: measuring sustainable memory bandwidth",
          url: "https://github.com/jeffhammond/STREAM",
          kind: "repo"
        },
        {
          title: "InfoQ: data-oriented design and cache behaviour talks",
          url: "https://www.youtube.com/@InfoQ",
          kind: "video"
        }
      ]
    },
    {
      id: "pf06",
      n: 6,
      title: "SIMD and autovectorisation",
      minutes: 105,
      level: "advanced",
      goal: "Know when LLVM will vectorise a loop, write a stable std::arch path behind runtime feature detection, and measure the bandwidth ceiling before claiming a SIMD win.",
      sections: [
        {
          h: "What the compiler will and will not vectorise",
          p: [
            "LLVM vectorises a loop when it can prove the trip count is known, the accesses are contiguous, and the pointers do not alias. Rust's slice iterators usually satisfy this, which is why a simple for x in &data reduction compiles to vector instructions. An early return, an index-based gather, or a branch inside the loop often stops it.",
            "The default target is baseline x86-64, meaning SSE2 and no AVX2. Building with -C target-cpu=native lets LLVM use wider registers, but the binary then requires those features at runtime and can crash on an older machine. For distributed binaries the portable route is runtime detection with is_x86_feature_detected! plus #[target_feature] functions."
          ],
          list: [
            "Contiguous slices, no aliasing, simple reduction: usually vectorised",
            "Data-dependent branches or gathers: usually not",
            "Check the assembly with cargo asm or godbolt instead of assuming",
            "target-cpu=native is a deployment decision, not just a build flag"
          ]
        },
        {
          h: "Stable SIMD with std::arch",
          p: [
            "std::arch exposes intrinsics per architecture. The function must be unsafe and marked #[target_feature(enable = \"avx2\")], and it may only be called after is_x86_feature_detected!(\"avx2\") returns true. Inside, load unaligned chunks, compare or add, and reduce with a movemask or a horizontal sum. Handle the remainder scalar-wise: the tail is where the correctness bugs live."
          ],
          code: `use std::arch::x86_64::*;

/// Requires AVX2. The caller must have checked the feature bit.
#[target_feature(enable = "avx2")]
unsafe fn count_avx2(haystack: &[u8], needle: u8) -> usize {
    let needle = _mm256_set1_epi8(needle as i8);
    let mut hits = 0usize;

    let mut chunks = haystack.chunks_exact(32);
    for chunk in &mut chunks {
        let v = unsafe { _mm256_loadu_si256(chunk.as_ptr() as *const __m256i) };
        let eq = _mm256_cmpeq_epi8(v, needle);
        hits += _mm256_movemask_epi8(eq).count_ones() as usize;
    }

    hits + chunks.remainder().iter().filter(|&&b| b == needle).count()
}

pub fn count(haystack: &[u8], needle: u8) -> usize {
    if is_x86_feature_detected!("avx2") {
        unsafe { count_avx2(haystack, needle) }
    } else {
        haystack.iter().filter(|&&b| b == needle).count()
    }
}`,
          tip: "The safe wrapper is the API; the target_feature function is private. Never let a caller reach the unsafe path without the runtime check."
        },
        {
          h: "The ceiling is bandwidth, not vector width",
          p: [
            "Vector width is not speedup. A 32-byte load that misses to DRAM is limited by memory bandwidth, so an 8-wide loop over a 1 GiB array may be barely faster than scalar - both wait on the same bus. Speedup appears when data fits in L1 or L2, or when the operation is genuinely compute-bound. Measure bytes per second and compare with the machine's STREAM number before believing a SIMD win.",
            "The other ceiling is the tail. A 32-byte chunk loop leaves up to 31 scalar elements: negligible across a megabyte, dominant across a hundred bytes. For short inputs, scalar often beats dispatch plus setup, and a hand-written SIMD path that is slower below 64 bytes is a regression for every small message on the hot path."
          ]
        },
        {
          h: "When not to write SIMD",
          p: [
            "Hand-written intrinsics are a maintenance liability: unsafe, architecture-specific, and easy to get subtly wrong at the tail. Reach for them only after a profile shows a compute-bound hot loop over contiguous data, after confirming autovectorisation failed, and after measuring that the gain survives in the real workload. Often the better fix is the layout change from the previous lesson, which lets the compiler vectorise code you never had to write."
          ],
          tip: "Portable crates such as wide give you SIMD-shaped types without intrinsics; try them before committing to std::arch."
        }
      ],
      exercise: {
        prompt: "Implement dot product for &[f32] with an AVX2 path behind runtime detection and a scalar fallback, then assert both paths agree within 1e-4 on random data.",
        starter: `use std::arch::x86_64::*;

#[target_feature(enable = "avx2")]
unsafe fn dot_avx2(a: &[f32], b: &[f32]) -> f32 {
    // 1. accumulate _mm256_mul_ps into a vector accumulator
    // 2. horizontal sum the 8 lanes
    // 3. add the scalar tail
    todo!()
}

pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    // runtime detection + scalar fallback
    todo!()
}`,
        hint: "Multiply with _mm256_mul_ps, accumulate with _mm256_add_ps, then _mm256_storeu_ps into a [f32; 8] and sum it. Compare against the scalar path with a tolerance, never with ==.",
        solution: `use std::arch::x86_64::*;

#[target_feature(enable = "avx2")]
unsafe fn dot_avx2(a: &[f32], b: &[f32]) -> f32 {
    let mut acc = _mm256_setzero_ps();
    let mut i = 0usize;

    while i + 8 <= a.len() {
        let va = unsafe { _mm256_loadu_ps(a.as_ptr().add(i)) };
        let vb = unsafe { _mm256_loadu_ps(b.as_ptr().add(i)) };
        acc = _mm256_add_ps(acc, _mm256_mul_ps(va, vb));
        i += 8;
    }

    let mut lanes = [0f32; 8];
    unsafe { _mm256_storeu_ps(lanes.as_mut_ptr(), acc) };
    let mut total: f32 = lanes.iter().sum();

    while i < a.len() {
        total += a[i] * b[i];
        i += 1;
    }
    total
}

fn dot_scalar(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len());
    if a.len() >= 8 && is_x86_feature_detected!("avx2") {
        unsafe { dot_avx2(a, b) }
    } else {
        dot_scalar(a, b)
    }
}

fn main() {
    let a: Vec<f32> = (0..10_003).map(|i| (i % 17) as f32).collect();
    let b: Vec<f32> = (0..10_003).map(|i| (i % 13) as f32).collect();

    let fast = dot(&a, &b);
    let slow = dot_scalar(&a, &b);
    assert!((fast - slow).abs() < 1e-4, "{fast} vs {slow}");
    println!("dot = {fast}");
}`
      },
      production: [
        "Every std::arch path has a runtime feature check and a scalar fallback that is tested in CI.",
        "SIMD changes are benchmarked on both cache-resident and memory-sized inputs.",
        "target-cpu=native is never used for binaries shipped to heterogeneous fleets.",
        "Intrinsic functions are private and unsafe; only the checked wrapper is public.",
        "A SIMD optimisation is reverted if it does not beat the compiler's autovectorised version."
      ],
      crates: ["wide", "criterion", "iai-callgrind"],
      pitfall: "Calling a #[target_feature(enable = \"avx2\")] function without checking the CPU feature: it runs fine on the developer's machine and dies with SIGILL on an older production host.",
      questions: [
        {
          q: "Which loop is most likely to be autovectorised by LLVM?",
          options: [
            "A loop with an early return on a data-dependent condition",
            "A contiguous slice reduction with no aliasing and no branches",
            "A loop that gathers elements through a Vec of indices",
            "A loop calling a virtual method per element"
          ],
          answer: 1,
          explain: "Vectorisation needs provable trip counts, contiguous access, and no side effects that could alias. Branches and gathers usually break it."
        },
        {
          q: "An AVX2 loop is only 1.2x faster than scalar on a 1 GiB array. Why?",
          options: [
            "AVX2 does not support f32",
            "The loop is limited by DRAM bandwidth, not by compute width",
            "Rust cannot vectorise arrays larger than L2",
            "The scalar version was already auto-vectorised into AVX-512"
          ],
          answer: 1,
          explain: "Once data streams from DRAM, both versions wait on the same bus. SIMD wins when the working set is cache-resident or the operation is compute-bound."
        },
        {
          q: "What happens if a target_feature function runs on a CPU without that feature?",
          options: [
            "The compiler inserts a fallback automatically",
            "The process executes an illegal instruction and is killed",
            "The function returns an error",
            "The runtime downgrades to the scalar path"
          ],
          answer: 1,
          explain: "target_feature tells the compiler it may emit those instructions unconditionally. Only is_x86_feature_detected! makes it safe."
        }
      ],
      quickbytes: [
        "Check the assembly before hand-writing intrinsics; LLVM already vectorises most simple reductions.",
        "Gate every std::arch path with is_x86_feature_detected! and test the scalar fallback.",
        "Benchmark SIMD on memory-sized inputs as well as cache-resident ones; bandwidth caps the win.",
        "Handle the remainder scalar-wise and test lengths that are not multiples of the vector width."
      ],
      github: [
        { name: "wide - portable SIMD types without intrinsics", url: "https://github.com/Lokathor/wide" },
        { name: "criterion.rs - measuring the vectorised version", url: "https://github.com/criterion-rs/criterion.rs" }
      ],
      resources: [
        {
          title: "core::arch::x86_64 intrinsics and target_feature",
          url: "https://doc.rust-lang.org/core/arch/x86_64/index.html",
          kind: "docs"
        },
        {
          title: "portable-simd repository and design notes",
          url: "https://github.com/rust-lang/portable-simd",
          kind: "repo"
        },
        {
          title: "criterion: measuring the vectorised version honestly",
          url: "https://docs.rs/criterion/latest/criterion/",
          kind: "docs"
        },
        {
          title: "InfoQ: SIMD and low-level optimisation talks",
          url: "https://www.youtube.com/@InfoQ",
          kind: "video"
        }
      ]
    },
    {
      id: "pf07",
      n: 7,
      title: "Async performance pitfalls",
      minutes: 105,
      level: "industry",
      goal: "Find the four ways async Rust quietly serialises itself - blocking the worker, holding a lock across await, unbounded task spawning, and per-field syscalls - and fix each without moving the queue.",
      sections: [
        {
          h: "Blocking the executor is the most expensive bug in async Rust",
          p: [
            "Tokio runs many futures on a small number of worker threads. Any code that blocks - std::fs, a synchronous database driver, a CPU-heavy parse, std::thread::sleep - stops that worker from polling every other task assigned to it. One 50 ms blocking call on a four-worker runtime can add tens of milliseconds to unrelated requests, and the flamegraph will blame whatever function happened to be running.",
            "The fix is not to spawn everything. CPU work goes to spawn_blocking or a dedicated compute pool; long-lived loops go to std::thread, because spawn_blocking occupies a blocking-pool thread for the duration; synchronous I/O gets an async client or a bounded bridge. Bound the concurrency of whatever you move, because the blocking pool is large by default and an unbounded fan-out simply relocates the queue."
          ],
          list: [
            "std::fs, std::net, std::thread::sleep, and sync database drivers all block a worker",
            "spawn_blocking is for bounded blocking work, not permanent loops",
            "Blocking tasks cannot be aborted once they start running",
            "A semaphore around spawn_blocking stops the blocking pool becoming the new bottleneck"
          ]
        },
        {
          h: "Locks held across await points",
          p: [
            "std::sync::Mutex is not async-aware. Holding its guard across an await means the future can be suspended while owning the lock. In most code this fails to compile as a Send violation, which is a gift; on a current-thread runtime it compiles and a second task locking the same mutex deadlocks the only worker. Tokio's Mutex is async-aware but slower on the uncontended path, so the better answer is usually to finish the critical section before awaiting."
          ],
          code: `use std::collections::HashMap;
use std::sync::Mutex;

struct State {
    cache: Mutex<HashMap<String, String>>,
}

// BAD: the std guard is alive across the await. Usually rejected by
// tokio::spawn as !Send; on a current-thread runtime it can deadlock.
async fn bad(state: &State, key: &str) -> Option<String> {
    let mut cache = state.cache.lock().unwrap();
    if let Some(v) = cache.get(key) {
        return Some(v.clone());
    }
    let value = load(key).await; // guard still held here
    if let Some(v) = &value {
        cache.insert(key.to_string(), v.clone());
    }
    value
}

// GOOD: copy out, drop the guard, then await.
async fn good(state: &State, key: &str) -> Option<String> {
    if let Some(v) = state.cache.lock().unwrap().get(key).cloned() {
        return Some(v);
    }
    let value = load(key).await;
    if let Some(v) = &value {
        state.cache.lock().unwrap().insert(key.to_string(), v.clone());
    }
    value
}

async fn load(_key: &str) -> Option<String> {
    Some("value".to_string())
}`,
          tip: "If a critical section needs an await inside it, you need a different data structure, not a different mutex."
        },
        {
          h: "Task granularity and cancellation",
          p: [
            "A tokio task costs an allocation and a scheduler enqueue: hundreds of nanoseconds, not free. Spawning one task per item in a hot loop can cost more than the work itself, while one giant task per connection serialises everything that connection does. The usual shape is one task per connection, plus one per request only when requests genuinely proceed independently.",
            "Cancellation is the other hidden cost. Dropping a future stops it at an await point, but work it already started - a spawned task, a socket write, a spawn_blocking job - continues. select! is where this bites: the losing branch is dropped mid-flight, so any partial state must be safe to abandon."
          ]
        },
        {
          h: "Buffering, syscalls, and timers",
          p: [
            "Each write syscall costs roughly a microsecond plus a copy. A handler that writes headers and body separately pays twice; a log line per field pays per field. Wrap writers in BufWriter or build the response in one buffer and flush once. Timers deserve the same suspicion: a 1 ms interval across 10,000 tasks is ten million wakeups per second, a denial-of-service you wrote yourself."
          ],
          code: `use std::sync::Arc;
use tokio::sync::Semaphore;

fn slow_hash(input: &str) -> u64 {
    // Stand-in for argon2/bcrypt: deliberately expensive CPU work.
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for b in input.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

pub async fn hash_bounded(
    permits: Arc<Semaphore>,
    password: String,
) -> Result<u64, tokio::task::JoinError> {
    // Bounded fan-out: at most N hashes occupy blocking threads at once.
    let _permit = permits.acquire().await.expect("semaphore is never closed");
    tokio::task::spawn_blocking(move || slow_hash(&password)).await
}

// Runtime side: one shared limiter sized to the core count.
// let permits = Arc::new(Semaphore::new(num_cpus::get()));`,
          tip: "Size the semaphore to physical cores, not to requests. Blocking work does not become parallel by queueing more of it."
        }
      ],
      exercise: {
        prompt: "This handler locks a shared map with std::sync::Mutex, awaits a database call while holding the guard, then runs a 20 ms password hash on the worker. Fix both problems without changing the response type.",
        starter: `use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::Semaphore;

pub async fn login(
    state: Arc<State>,
    permits: Arc<Semaphore>,
    user: String,
    password: String,
) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let mut sessions = state.sessions.lock().unwrap();
    let token = fetch_token(&user, &password).await?; // guard held across await
    let hash = slow_hash(&password); // 20 ms on the worker
    sessions.insert(token.clone(), hash);
    Ok(Some(token))
}

pub struct State {
    pub sessions: Mutex<HashMap<String, u64>>,
}

async fn fetch_token(_u: &str, _p: &str) -> Result<String, Box<dyn std::error::Error>> {
    Ok("token".into())
}

fn slow_hash(_p: &str) -> u64 { 0 }`,
        hint: "Copy whatever you need out of the map, drop the guard, then await. Move slow_hash into spawn_blocking, and acquire a permit from the shared semaphore first so the blocking pool cannot be flooded.",
        solution: `use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::Semaphore;

pub struct State {
    pub sessions: Mutex<HashMap<String, u64>>,
}

pub async fn login(
    state: Arc<State>,
    permits: Arc<Semaphore>,
    user: String,
    password: String,
) -> Result<Option<String>, Box<dyn std::error::Error>> {
    // Critical section ends before the await.
    let cached = state.sessions.lock().unwrap().get(&user).copied();
    if cached.is_some() {
        return Ok(Some(user));
    }

    let token = fetch_token(&user, &password).await?;

    // Expensive CPU work off the async worker, bounded by a permit.
    let _permit = permits.acquire().await.expect("semaphore is never closed");
    let hash = tokio::task::spawn_blocking(move || slow_hash(&password)).await?;

    state.sessions.lock().unwrap().insert(token.clone(), hash);
    Ok(Some(token))
}

async fn fetch_token(_u: &str, _p: &str) -> Result<String, Box<dyn std::error::Error>> {
    Ok("token".into())
}

fn slow_hash(password: &str) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for b in password.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}`
      },
      production: [
        "Clippy's await_holding_lock lint is denied in CI, and std Mutex guards never cross an await.",
        "CPU-heavy handlers call spawn_blocking behind a semaphore sized to physical cores.",
        "Long-lived background work uses dedicated threads, not the blocking pool.",
        "Response bodies are built in one buffer and written once; per-field writes are treated as a bug.",
        "Timer intervals are justified against the number of tasks that will wake."
      ],
      crates: ["tokio", "tokio-util", "tokio-console"],
      pitfall: "Using spawn_blocking for a permanent worker loop: each call pins a blocking-pool thread forever, the pool saturates, and every other blocking operation queues behind a loop that never ends.",
      questions: [
        {
          q: "Why is holding a std::sync::MutexGuard across an await dangerous?",
          options: [
            "The guard is silently dropped at the await, releasing the lock early",
            "The future stops being Send so tokio::spawn rejects it, and on a current-thread runtime a second locker can deadlock the worker",
            "std::sync::Mutex cannot be used inside async functions at all",
            "It makes the mutex poison itself"
          ],
          answer: 1,
          explain: "The guard is not Send, which usually turns into a compile error. Where it does compile, the worker can block on a lock held by a future it is supposed to poll."
        },
        {
          q: "Which statement about tokio::task::spawn_blocking is true?",
          options: [
            "It runs the closure on the async worker but with a larger stack",
            "Once started, the closure cannot be aborted, and runtime shutdown waits for it",
            "It is intended for long-lived background loops",
            "It limits concurrency to the number of cores automatically"
          ],
          answer: 1,
          explain: "Blocking closures are not futures, so abort has no effect once they run. Long-lived loops belong on dedicated threads, and concurrency needs an explicit semaphore."
        },
        {
          q: "Why is spawning one task per item usually a pessimisation in a hot loop?",
          options: [
            "Tokio tasks cannot run concurrently",
            "Each spawn allocates and enqueues, and that overhead can exceed the item's work",
            "Tasks are limited to 1,000 per process",
            "The runtime runs spawned tasks sequentially"
          ],
          answer: 1,
          explain: "Task creation is cheap but not free. At high item rates the scheduler becomes the hot path; batch items or process them inline."
        }
      ],
      quickbytes: [
        "Never call blocking APIs from an async worker; move them to spawn_blocking with a permit.",
        "Drop std Mutex guards before awaiting, or the future becomes !Send and may deadlock a worker.",
        "Size spawn_blocking concurrency to cores, not to request count.",
        "Build responses in one buffer and flush once; syscalls are per call, not per byte."
      ],
      github: [
        { name: "tokio - async runtime and blocking pool", url: "https://github.com/tokio-rs/tokio" },
        { name: "tokio-console - task and resource inspector", url: "https://github.com/tokio-rs/console" }
      ],
      resources: [
        {
          title: "tokio::task::spawn_blocking: pool limits and cancellation",
          url: "https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html",
          kind: "docs"
        },
        {
          title: "tokio repository and runtime internals",
          url: "https://github.com/tokio-rs/tokio",
          kind: "repo"
        },
        {
          title: "tokio-console: finding tasks stuck on a worker",
          url: "https://github.com/tokio-rs/console",
          kind: "repo"
        },
        {
          title: "InfoQ: async runtime performance talks",
          url: "https://www.youtube.com/@InfoQ",
          kind: "video"
        }
      ]
    },
    {
      id: "pf08",
      n: 8,
      title: "Lock contention: measure, shard, or remove",
      minutes: 105,
      level: "advanced",
      goal: "Recognise contention as a queueing problem, prove it with off-CPU or futex evidence, and choose between removing shared state, sharding it, or changing the primitive.",
      sections: [
        {
          h: "A lock is a queue with a serialisation point",
          p: [
            "A mutex does not make code slow by itself; contention does. The cost is roughly critical-section length times arrival rate. At a 1 microsecond critical section and 500,000 lock acquisitions per second, the lock is saturated and waiters queue. Little's law applies to locks as much as to servers: the number waiting equals arrival rate times wait time.",
            "Amdahl returns here too. If 20% of request time sits inside one global lock, no amount of parallelism removes that serialisation, and the ceiling is 5x - in practice much less, because the lock's cache line bounces between cores and every transfer costs coherence traffic."
          ]
        },
        {
          h: "Diagnose before sharding",
          p: [
            "Look for the signature first: throughput rises with threads, plateaus, then falls while CPU stays busy. That is coherence traffic, not useful work. On Linux, perf lock and off-CPU samples show time in futex; tokio-console shows tasks waiting on async primitives; a quick experiment that removes the lock entirely tells you whether it was the bottleneck at all.",
            "Confirm the critical section is actually long. A lock held for 50 ns cannot saturate at any realistic request rate, and 'add more shards' will just add code and cache misses. Contention is a property of the workload, not of the primitive's implementation, so the measurement has to be of your workload at your concurrency."
          ],
          list: [
            "Throughput curve peaks then declines as threads increase: suspect contention",
            "Time in futex or in the lock's own code in an off-CPU profile",
            "Try a no-lock variant to establish the ceiling before redesigning",
            "Measure the critical section length; nanoseconds cannot saturate a lock"
          ]
        },
        {
          h: "Remove, shard, or change the primitive",
          p: [
            "Three fixes, in order of preference. Remove the shared state: give each task its own data and merge at the end, which is the only fix that scales linearly. Shard: N mutexes keyed by a hash, so unrelated keys never meet; DashMap does this internally. Change the primitive: atomics for counters, RwLock for genuinely read-mostly data, channels when ownership can move instead of being shared."
          ],
          code: `use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::Mutex;

pub struct ShardedCounter<K> {
    shards: Vec<Mutex<HashMap<K, u64>>>,
}

impl<K: Eq + Hash + Clone> ShardedCounter<K> {
    pub fn new(shards: usize) -> Self {
        Self {
            shards: (0..shards).map(|_| Mutex::new(HashMap::new())).collect(),
        }
    }

    fn shard(&self, key: &K) -> usize {
        let mut h = DefaultHasher::new();
        key.hash(&mut h);
        (h.finish() as usize) % self.shards.len()
    }

    pub fn incr(&self, key: K) {
        let idx = self.shard(&key);
        *self.shards[idx].lock().unwrap().entry(key).or_insert(0) += 1;
    }

    pub fn total(&self) -> u64 {
        self.shards
            .iter()
            .map(|s| s.lock().unwrap().values().sum::<u64>())
            .sum()
    }
}`,
          tip: "Shard by the key you already have, not by thread id: thread sharding still needs a merge and can unbalance when one thread owns a hot key."
        },
        {
          h: "Primitive trade-offs",
          p: [
            "parking_lot::Mutex is faster than std in the uncontended case and smaller in memory, but it does not create parallelism: if the critical section is long, the queue is just as long. RwLock helps when reads vastly outnumber writes and sections are non-trivial; with very short sections the atomic bookkeeping can make it slower than a plain mutex. Atomics are fastest for a single word, but every write still bounces the cache line, so sharded atomics beat one hot atomic.",
            "The primitive you pick changes constants; the structure you pick - shared versus partitioned versus owned - changes the scaling curve. Fix the structure first, then tune the primitive. Swapping a mutex for a faster mutex is a constant-factor change that leaves the queue exactly where it was, which is why it so often measures as noise."
          ],
          tip: "If a counter only needs to be read occasionally, accumulate per thread and merge on read; that removes the shared write entirely."
        }
      ],
      exercise: {
        prompt: "Implement a hit counter twice - once behind a single Mutex, once sharded 16 ways - and measure 10 million increments with 1, 2, 4, and 8 threads. Report the scaling curve and explain where each version stops scaling.",
        starter: `use std::sync::Mutex;
use std::thread;
use std::time::Instant;

struct Single {
    count: Mutex<u64>,
}

fn main() {
    // For threads in [1, 2, 4, 8]:
    //   split 10_000_000 increments across threads
    //   time the join
    //   print increments per second
    // Then repeat with a sharded counter.
}`,
        hint: "Use std::thread::scope so the threads can borrow the counter. Give each thread its own range of increments; the total work must be identical across thread counts for the curve to mean anything.",
        solution: `use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Instant;

const TOTAL: u64 = 10_000_000;
const SHARDS: usize = 16;

struct Single(Mutex<u64>);
struct Sharded(Vec<AtomicU64>);

impl Single {
    fn incr(&self) {
        *self.0.lock().unwrap() += 1;
    }
}

impl Sharded {
    fn incr(&self, i: u64) {
        // Spread writes across cache lines; no lock at all.
        self.0[(i as usize) % SHARDS].fetch_add(1, Ordering::Relaxed);
    }
    fn total(&self) -> u64 {
        self.0.iter().map(|c| c.load(Ordering::Relaxed)).sum()
    }
}

fn run<F: Fn(u64) + Sync>(threads: usize, f: F) -> f64 {
    let per_thread = TOTAL / threads as u64;
    let start = Instant::now();
    thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| {
                for i in 0..per_thread {
                    f(i);
                }
            });
        }
    });
    TOTAL as f64 / start.elapsed().as_secs_f64()
}

fn main() {
    for threads in [1usize, 2, 4, 8] {
        let single = Single(Mutex::new(0));
        let sharded = Sharded((0..SHARDS).map(|_| AtomicU64::new(0)).collect());

        let mutex_rate = run(threads, |_| single.incr());
        let sharded_rate = run(threads, |i| sharded.incr(i));

        let expected = TOTAL / threads as u64 * threads as u64;
        assert_eq!(*single.0.lock().unwrap(), expected);
        assert_eq!(sharded.total(), expected);
        println!("{threads} threads: mutex {mutex_rate:.0}/s, sharded {sharded_rate:.0}/s");
    }
}

// The mutex version peaks after a few threads and then declines: the cache
// line holding the count bounces between cores. The sharded version keeps
// scaling until memory bandwidth or core count binds.`
      },
      production: [
        "Every mutex guarding a hot path has a measured critical-section length recorded in review.",
        "Counters are per-thread and merged on read, or sharded, rather than one global atomic.",
        "Lock-free alternatives are adopted only with a benchmark showing they win under real contention.",
        "Throughput is measured at 1, 2, 4, and 8 threads, not at one concurrency level.",
        "A no-lock variant is benchmarked first to establish the ceiling."
      ],
      crates: ["parking_lot", "dashmap", "crossbeam-utils"],
      pitfall: "Replacing std::sync::Mutex with parking_lot and calling it an optimisation: the uncontended path got faster while the contended path - the actual problem - still queues.",
      questions: [
        {
          q: "Throughput rises from 1 to 4 threads and then falls at 8, while CPU stays saturated. What is the most likely cause?",
          options: [
            "The machine has fewer than 8 physical cores",
            "Contention on a shared cache line or lock, so coherence traffic replaces useful work",
            "The allocator is running out of memory",
            "The compiler failed to inline the hot loop"
          ],
          answer: 1,
          explain: "A peak-then-decline curve with busy CPUs is the signature of serialisation. Check off-CPU/futex time and the critical-section length."
        },
        {
          q: "Why does an RwLock sometimes lose to a Mutex for read-mostly data?",
          options: [
            "RwLock blocks all readers while a writer waits",
            "The atomic bookkeeping for reader counts costs more than a short critical section saves",
            "RwLock cannot be used across threads",
            "RwLock allocates on every read"
          ],
          answer: 1,
          explain: "RwLock pays extra atomics on every acquisition. If the protected work is nanoseconds, that overhead dominates."
        },
        {
          q: "Two adjacent AtomicU64 counters are incremented by different threads. Why is the pair slower than one counter?",
          options: [
            "Atomics on adjacent addresses are not allowed",
            "Both counters share a cache line, so each write invalidates the other core's copy",
            "The compiler serialises all atomic operations",
            "Atomic operations are always slower than mutexes"
          ],
          answer: 1,
          explain: "False sharing. Padding each counter to its own cache line (CachePadded) restores independent scaling."
        }
      ],
      quickbytes: [
        "Measure the critical section length before redesigning; nanoseconds cannot saturate a lock.",
        "Prefer removing shared state over sharding it, and sharding over changing the primitive.",
        "Shard by key, not by thread, so hot keys still spread across shards.",
        "Pad or separate counters that different threads write; adjacent atomics share a cache line."
      ],
      github: [
        { name: "parking_lot - faster mutexes and RwLocks", url: "https://github.com/Amanieu/parking_lot" },
        { name: "dashmap - sharded concurrent hash map", url: "https://github.com/xacrimon/dashmap" }
      ],
      resources: [
        {
          title: "parking_lot documentation and trade-offs",
          url: "https://docs.rs/parking_lot/latest/parking_lot/",
          kind: "docs"
        },
        {
          title: "dashmap documentation: sharding behaviour",
          url: "https://docs.rs/dashmap/latest/dashmap/",
          kind: "docs"
        },
        {
          title: "crossbeam: lock-free data structures and CachePadded",
          url: "https://github.com/crossbeam-rs/crossbeam",
          kind: "repo"
        },
        {
          title: "USENIX: scalability and contention studies",
          url: "https://www.youtube.com/@USENIX",
          kind: "video"
        }
      ]
    },
    {
      id: "pf09",
      n: 9,
      title: "Memory bandwidth: when the algorithm stops mattering",
      minutes: 90,
      level: "advanced",
      goal: "Decide whether a kernel is compute- or bandwidth-bound using arithmetic intensity, measure achieved GB/s against STREAM, and reduce bytes moved when bandwidth is the ceiling.",
      sections: [
        {
          h: "Arithmetic intensity and the roofline",
          p: [
            "Every kernel has an arithmetic intensity: operations performed per byte moved. Compare it with the machine's ratio of peak FLOPs to peak bandwidth and you get a ceiling - the roofline. A copy or a sum has intensity near zero, so it is bandwidth-bound no matter how it is written. A matrix multiply blocked to fit in cache has high intensity and can approach compute peak.",
            "Server DRAM delivers tens of gigabytes per second per socket, and that budget is shared by every core on the socket. Adding threads to a bandwidth-bound kernel does not add bandwidth; it adds contention, and total throughput can fall as cores fight over the same memory controllers and prefetchers."
          ]
        },
        {
          h: "Streaming, prefetching, and NUMA",
          p: [
            "Sequential streams are prefetched and reach near-peak bandwidth. Random access across a large region does not: each miss is a full line fetch and the prefetcher cannot help. Huge pages reduce TLB misses for large working sets, and NUMA placement decides whether a core reads local or remote memory - usually determined by first touch, which means the thread that allocated the page decides the latency for every other thread."
          ]
        },
        {
          h: "Measure GB/s, not seconds",
          p: [
            "A triad kernel (a[i] = b[i] + scalar * c[i]) moves three arrays per element, so bytes = 3 x 8 x n for f64. Time it, divide, and compare with STREAM on the same machine. If a simple kernel achieves 60% of STREAM, you are near the practical limit and further micro-optimisation is wasted effort; if it achieves 15%, the access pattern or the thread count is wrong."
          ],
          code: `use std::time::Instant;

fn triad(a: &mut [f64], b: &[f64], c: &[f64], scalar: f64) {
    for i in 0..a.len() {
        a[i] = b[i] + scalar * c[i];
    }
}

fn main() {
    let n = 32 * 1024 * 1024; // 256 MiB per array: far beyond any LLC
    let b = vec![1.0f64; n];
    let c = vec![2.0f64; n];
    let mut a = vec![0.0f64; n];

    let start = Instant::now();
    triad(&mut a, &b, &c, 1.5);
    let elapsed = start.elapsed().as_secs_f64();

    let bytes = 3.0 * 8.0 * n as f64; // two reads + one write per element
    let gbs = bytes / elapsed / 1e9;
    println!("{:.1} GB/s over {:.2} s", gbs, elapsed);
    std::hint::black_box(&a);
}`,
          tip: "Warm the allocation before timing: the first touch of a fresh Vec faults pages, and that cost belongs to the allocator, not the kernel."
        },
        {
          h: "When bandwidth is the bottleneck, move fewer bytes",
          p: [
            "If a kernel is bandwidth-bound, the only wins left are fewer bytes: narrower types where the range allows (u16 instead of u64, f32 instead of f64), compression for network and disk, fusing passes so data is read once, or blocking so the working set fits in cache. A faster algorithm that touches more memory can lose to a slower one that streams once.",
            "This is also why 'optimise the loop' plateaus. Once the loop is a sequential stream at 60% of STREAM, the remaining 40% is hardware, not code. At that point the only lever left is the data: fewer bytes, a smaller type, a fused pass, or a layout that keeps the working set in cache."
          ]
        }
      ],
      exercise: {
        prompt: "Measure achieved GB/s for a copy of 256 MiB, then fuse a two-pass computation (sum, then scale) into a single pass and compare both against the copy's bandwidth.",
        starter: `use std::time::Instant;

fn copy(a: &mut [f64], b: &[f64]) {
    a.copy_from_slice(b);
}

fn two_pass(data: &mut [f64]) -> f64 {
    let sum: f64 = data.iter().sum();
    for v in data.iter_mut() {
        *v *= 2.0;
    }
    sum
}

fn fused(data: &mut [f64]) -> f64 {
    // one pass: accumulate and scale together
    todo!()
}

fn main() {
    // 32M f64 values, time each function, print GB/s
}`,
        hint: "Copy moves 16 bytes per element (read + write). Two-pass moves 24 (read, read, write); fused moves 16. Divide bytes by seconds and compare the three numbers.",
        solution: `use std::time::Instant;

const N: usize = 32 * 1024 * 1024; // 256 MiB of f64

fn copy(dst: &mut [f64], src: &[f64]) {
    dst.copy_from_slice(src);
}

fn two_pass(data: &mut [f64]) -> f64 {
    let sum: f64 = data.iter().sum();
    for v in data.iter_mut() {
        *v *= 2.0;
    }
    sum
}

fn fused(data: &mut [f64]) -> f64 {
    let mut sum = 0.0;
    for v in data.iter_mut() {
        sum += *v;
        *v *= 2.0;
    }
    sum
}

fn gbs(bytes: f64, secs: f64) -> f64 {
    bytes / secs / 1e9
}

fn main() {
    let src = vec![1.5f64; N];
    let mut dst = vec![0.0f64; N];

    let start = Instant::now();
    copy(&mut dst, &src);
    let copy_gbs = gbs(2.0 * 8.0 * N as f64, start.elapsed().as_secs_f64());

    let mut a = src.clone();
    let start = Instant::now();
    let s1 = two_pass(&mut a);
    let two_pass_gbs = gbs(3.0 * 8.0 * N as f64, start.elapsed().as_secs_f64());

    let mut b = src.clone();
    let start = Instant::now();
    let s2 = fused(&mut b);
    let fused_gbs = gbs(2.0 * 8.0 * N as f64, start.elapsed().as_secs_f64());

    assert!((s1 - s2).abs() < 1e-6);
    println!("copy:     {copy_gbs:.1} GB/s");
    println!("two-pass: {two_pass_gbs:.1} GB/s (24 bytes/element)");
    println!("fused:    {fused_gbs:.1} GB/s (16 bytes/element)");

    // Fused does the same work with one fewer stream, so it finishes in
    // roughly two thirds of the time even though its GB/s looks similar.
}`
      },
      production: [
        "Bandwidth-bound kernels are identified before tuning, so effort goes to bytes moved rather than instruction count.",
        "STREAM is run on the deployment machine and its result is recorded with the benchmark baseline.",
        "Large working sets are checked for NUMA placement and transparent huge pages.",
        "Thread counts are chosen by measurement, not by 'one per core' by default.",
        "Data-width reductions (f64 to f32, u64 to u32) are reviewed for range and precision."
      ],
      crates: ["criterion", "rayon", "perf-event"],
      pitfall: "Adding threads to a bandwidth-bound kernel and reporting a slowdown as a code regression: the kernel is already at the memory ceiling, and more cores only add contention.",
      questions: [
        {
          q: "A kernel copies 1 GiB and takes 0.4 s. What is the achieved bandwidth?",
          options: [
            "About 2.5 GB/s, counting 1 GiB moved",
            "About 5.4 GB/s, counting read plus write",
            "About 10 GB/s, counting read, write, and cache fills",
            "Cannot be computed without knowing the CPU frequency"
          ],
          answer: 1,
          explain: "A copy reads and writes: 2 x 1.074 GB / 0.4 s = 5.4 GB/s. Counting only one direction halves the number and makes comparisons meaningless."
        },
        {
          q: "Why does a cache-blocked matrix multiply beat a naive one by a large factor on identical hardware?",
          options: [
            "It performs fewer floating-point operations",
            "Blocking raises arithmetic intensity, so fewer bytes come from DRAM per FLOP",
            "It uses AVX-512, which the naive version cannot",
            "It avoids bounds checks in Rust"
          ],
          answer: 1,
          explain: "The FLOP count is the same. Blocking keeps reused tiles in cache, moving the kernel from the bandwidth roof toward the compute roof."
        },
        {
          q: "A simple sum over a 1 GiB array does not get faster when threads are doubled. Why?",
          options: [
            "Sums cannot be parallelised",
            "The kernel is bandwidth-bound and the memory controllers are already saturated",
            "Rust's iterators are single-threaded",
            "The array does not fit in L1"
          ],
          answer: 1,
          explain: "With near-zero arithmetic intensity, every core waits on the same DRAM. Parallelism helps only when the bottleneck is compute."
        }
      ],
      quickbytes: [
        "Compute arithmetic intensity before tuning; it tells you which roof you are under.",
        "Measure GB/s and compare with STREAM on the same machine, not with a vendor peak number.",
        "To go faster at the bandwidth limit, move fewer bytes: narrower types, fused passes, blocking.",
        "Warm the allocation before timing so page faults are not attributed to the kernel."
      ],
      github: [
        { name: "rayon - data-parallel iteration", url: "https://github.com/rayon-rs/rayon" },
        { name: "criterion.rs - benchmarking bandwidth-bound kernels", url: "https://github.com/criterion-rs/criterion.rs" }
      ],
      resources: [
        {
          title: "STREAM benchmark repository",
          url: "https://github.com/jeffhammond/STREAM",
          kind: "repo"
        },
        {
          title: "perf-record(1): cache and memory sampling",
          url: "https://man7.org/linux/man-pages/man1/perf-record.1.html",
          kind: "docs"
        },
        {
          title: "criterion: benchmarking memory-bound kernels",
          url: "https://docs.rs/criterion/latest/criterion/",
          kind: "docs"
        },
        {
          title: "USENIX: memory system and NUMA performance talks",
          url: "https://www.youtube.com/@USENIX",
          kind: "video"
        }
      ]
    },
    {
      id: "pf10",
      n: 10,
      title: "Latency budgets: allocate milliseconds like money",
      minutes: 90,
      level: "industry",
      goal: "Decompose an SLO into a per-hop budget, propagate remaining time as a deadline, and instrument budget burn instead of raw latency.",
      sections: [
        {
          h: "An end-to-end budget is a decomposition, not an average",
          p: [
            "A request that must answer in 300 ms at p99 has to spend those 300 ms across every hop: TLS and network, load balancer, queue wait, service CPU, database, serialisation, and the client's own work. Write the budget as a table with a number per hop and a reserve. Without it, every team optimises its own mean and the sum still violates the SLO.",
            "Percentiles do not add. The p99 of the total is not the sum of per-hop p99s: hops are correlated, and a request only lands in the tail when several hops are slow at once. Summing p99s gives an upper bound that is usually far too pessimistic; summing means gives a number that is always too optimistic. Budget with medians plus per-hop tail allowances, then validate end to end with a load test."
          ],
          list: [
            "One line per hop: network, load balancer, queue, service, datastore, serialisation",
            "Reserve 20-30% of the SLO for variance and retries",
            "A hop with no instrumented histogram cannot be budgeted",
            "Budgets are per endpoint class, not per service"
          ]
        },
        {
          h: "Derive the budget from the promise, not from today",
          p: [
            "Start from the promise: 300 ms p99 for search, 800 ms p99 for checkout. Subtract what you do not control - client RTT, TLS handshake amortised by keep-alive - and divide the rest across hops according to their share of current p99, then tighten the hops you can actually change. The budget is a target, not a description; if today's numbers do not fit, that mismatch is the finding.",
            "Give every hop a hard deadline shorter than its budget, and propagate the remaining time downstream. A service that receives 200 ms of remaining budget must not start a query with a 5 s timeout; it should fail fast, degrade, or return partial results."
          ]
        },
        {
          h: "Enforce with deadlines and child budgets",
          p: [
            "The clean way to propagate is a Budget value carried through the request, not a set of constants per service. It stores an absolute deadline, hands each downstream call a share of what remains minus a reserve for serialising the response, and returns None when there is not enough left to bother. Every RPC and query takes its timeout from it, so a slow hop cannot consume the whole request."
          ],
          code: `use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy)]
pub struct Budget {
    deadline: Instant,
}

impl Budget {
    pub fn new(total: Duration) -> Self {
        Self { deadline: Instant::now() + total }
    }

    pub fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }

    /// Hand a downstream call at most \`share\` of what is left, keeping
    /// a reserve so the response can still be serialised and written.
    pub fn child(&self, share: f64, reserve: Duration) -> Option<Duration> {
        let left = self.remaining().checked_sub(reserve)?;
        let slice = left.mul_f64(share.clamp(0.0, 1.0));
        (slice > Duration::ZERO).then_some(slice)
    }
}

#[test]
fn a_child_never_exceeds_the_parent() {
    let budget = Budget::new(Duration::from_millis(300));
    let child = budget.child(0.5, Duration::from_millis(20)).unwrap();
    assert!(child <= Duration::from_millis(140));
    assert!(budget.remaining() > Duration::ZERO);
}`,
          tip: "Never pass an absolute timestamp to another process; clocks disagree. Pass the remaining duration."
        },
        {
          h: "Instrument the budget, alert on burn",
          p: [
            "A budget that is not measured is a wish. Emit a histogram per hop with the hop name as a label, and compute the fraction of requests that exceeded their allocation. Alert on budget burn rate rather than raw latency: a hop at 40% of its budget is fine even when the number looks large, and a hop at 150% is a problem even when the number looks small."
          ],
          tip: "Put the budget in the trace as attributes: total, remaining at each hop, and whether the request degraded. That turns a latency investigation into a query."
        }
      ],
      exercise: {
        prompt: "Implement remaining_budget for a 250 ms request, split it across three hops (auth 10%, query 60%, render 30%), and reject the request when fewer than 30 ms remain before the query starts.",
        starter: `use std::time::{Duration, Instant};

struct Budget {
    deadline: Instant,
}

impl Budget {
    fn remaining(&self) -> Duration { todo!() }
    fn allocate(&self, share: f64) -> Option<Duration> { todo!() }
}

fn main() {
    // 1. 250 ms total
    // 2. simulate 180 ms spent in auth + queue
    // 3. allocate 60% for the query and print accept or reject
}`,
        hint: "remaining() is saturating_duration_since(now). allocate multiplies what is left by the share and returns None below a 30 ms floor, which is the signal to shed load rather than start a doomed query.",
        solution: `use std::time::{Duration, Instant};

struct Budget {
    deadline: Instant,
    floor: Duration,
}

impl Budget {
    fn new(total: Duration, floor: Duration) -> Self {
        Self { deadline: Instant::now() + total, floor }
    }

    fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }

    fn allocate(&self, share: f64) -> Option<Duration> {
        let slice = self.remaining().mul_f64(share.clamp(0.0, 1.0));
        (slice >= self.floor).then_some(slice)
    }
}

fn main() {
    let budget = Budget::new(Duration::from_millis(250), Duration::from_millis(30));

    // Auth and queue consumed 180 ms of the 250 ms promise.
    std::thread::sleep(Duration::from_millis(180));

    match budget.allocate(0.60) {
        Some(slice) => println!("query gets {slice:?}"),
        None => println!("shed load: not enough budget left to query"),
    }

    // With 70 ms left, 60% is 42 ms: above the 30 ms floor, so it proceeds.
    // Spend 50 ms more and the same call returns None, which is the signal
    // to return a degraded response instead of starting a doomed query.
}`
      },
      production: [
        "Every endpoint has a written budget table with per-hop allocations and a reserve.",
        "Outbound calls derive their timeout from the remaining budget, never from a fixed constant.",
        "Requests below the minimum viable budget are shed or degraded, not started.",
        "Hop histograms are emitted with budget-exceeded counts, and alerts fire on burn rate.",
        "Budgets are validated end to end with a load test, not inferred from per-hop numbers."
      ],
      crates: ["hdrhistogram", "tracing", "tonic"],
      pitfall: "Giving every downstream call the same fixed 2 s timeout: one slow dependency consumes the entire request budget while every hop believes it is within its own limit.",
      questions: [
        {
          q: "Why is the p99 of an end-to-end request not the sum of the per-hop p99s?",
          options: [
            "Because percentiles are not additive; hops correlate and the total tail is a different distribution",
            "Because p99 is always larger than the sum of means",
            "Because network latency is excluded from per-hop numbers",
            "Because histograms cannot be merged across hops"
          ],
          answer: 0,
          explain: "The sum of p99s assumes every hop is at its worst simultaneously. Correlated hops make it pessimistic; independence makes it optimistic. Measure the total."
        },
        {
          q: "A request has 120 ms of budget left and needs to serialise a 2 MB response, which takes about 25 ms. What should the next hop get?",
          options: [
            "The full 120 ms, because that is what remains",
            "About 95 ms, reserving time to serialise and write the response",
            "A fixed 2 s timeout, so the hop is never the cause of failure",
            "Nothing; the request should already have been rejected"
          ],
          answer: 1,
          explain: "Reserve for work you still must do. Handing the full remainder downstream guarantees the response misses its deadline."
        },
        {
          q: "What does alerting on budget burn add over alerting on raw p99 latency?",
          options: [
            "It removes the need for histograms",
            "It ties the signal to the promise, so a fast endpoint with a tight budget and a slow one with a loose budget are judged fairly",
            "It measures CPU instead of time",
            "It only works for batch workloads"
          ],
          answer: 1,
          explain: "Burn rate normalises by the allocation, which is what the SLO actually promises. Raw latency without the budget cannot say whether a number is a problem."
        }
      ],
      quickbytes: [
        "Write the budget as a table with a reserve; a hop without a histogram cannot be budgeted.",
        "Propagate remaining time, never an absolute deadline across processes.",
        "Reserve time for serialisation and writes before handing budget downstream.",
        "Alert on budget burn, not on raw latency that has no target attached."
      ],
      github: [
        { name: "hdrhistogram - latency histograms with corrected recording", url: "https://github.com/HdrHistogram/HdrHistogram_rust" },
        { name: "tonic - deadlines and timeout propagation", url: "https://github.com/grpc/grpc-rust" }
      ],
      resources: [
        {
          title: "hdrhistogram: value_at_quantile and record_correct",
          url: "https://docs.rs/hdrhistogram/latest/hdrhistogram/",
          kind: "docs"
        },
        {
          title: "gRPC deadlines guide: propagating remaining time",
          url: "https://grpc.io/docs/guides/deadlines/",
          kind: "docs"
        },
        {
          title: "The Tail at Scale: why budgets must cover the fan-out",
          url: "https://research.google/pubs/the-tail-at-scale/",
          kind: "paper"
        },
        {
          title: "InfoQ: SLO and latency-budget engineering talks",
          url: "https://www.youtube.com/@InfoQ",
          kind: "video"
        }
      ]
    },
    {
      id: "pf11",
      n: 11,
      title: "Tail latency: why p99 is a product, not a sum",
      minutes: 105,
      level: "industry",
      goal: "Explain tail amplification across fan-out, identify the real causes of slow requests, and apply hedging, partitioning, and load shedding without making the tail worse.",
      sections: [
        {
          h: "The tail is a product",
          p: [
            "If a request fans out to 100 services and each has a 1% chance of being slow, the chance that at least one is slow is 1 - 0.99^100 = 63%. The user waits for the slowest dependency, so the tail of the request is the maximum over its dependencies, and that maximum grows with fan-out. A service with an excellent p99 can still produce a poor user experience.",
            "The same arithmetic applies to retries. Retrying a slow request three times triples the load on the component that is already struggling, which is how a small hiccup becomes an outage. Retries must be budgeted, jittered, and capped, and they must never be the response to a timeout you caused yourself."
          ],
          list: [
            "Fan-out multiplies tail probability: 100 dependencies at 1% slow means 63% of requests touch one",
            "The request's latency is the max over its dependencies, not the mean",
            "Retries amplify load on the slowest component",
            "Hedging trades extra load for a shorter tail, and must be capped"
          ]
        },
        {
          h: "Where tails actually come from",
          p: [
            "Queueing dominates: as utilisation approaches one, wait time explodes before throughput does (the next lesson derives this). Beyond queueing: head-of-line blocking on a shared connection or a single-threaded stage, stop-the-world pauses from page reclaim or transparent huge-page compaction, CPU frequency and noisy neighbours, background jobs competing for the same disk, and key distributions where a few keys are far hotter than the rest.",
            "The order matters. Most teams reach for hedging first, when the honest fix is reducing utilisation, removing a shared bottleneck, or making the slow path not exist at all. Hedge after you have removed the queue, because hedging into a saturated backend doubles the load on the component that is already the reason for the tail."
          ]
        },
        {
          h: "Mitigations that work",
          p: [
            "Hedged requests: send the request to a second replica after a delay near the p95, take the first answer, and cancel the other. Tied requests: send to two replicas that coordinate so only one executes. Micro-partitioning: split a hot key across N sub-partitions so one slow shard cannot dominate. Load shedding: reject early when the queue exceeds a threshold, because a fast rejection beats a slow timeout. Deadlines everywhere, so no dependency can hold a connection until the client gives up."
          ],
          code: `use std::time::Duration;
use tokio::time::sleep;

type Error = Box<dyn std::error::Error + Send + Sync>;

async fn replica_a(_id: u64) -> Result<String, Error> {
    Ok("a".to_string())
}

async fn replica_b(_id: u64) -> Result<String, Error> {
    Ok("b".to_string())
}

/// Send to A; if it has not answered after \`hedge_after\`, race a second
/// replica. The loser is dropped, which cancels its in-flight future.
pub async fn hedged(id: u64, hedge_after: Duration) -> Result<String, Error> {
    let primary = replica_a(id);
    tokio::pin!(primary);

    tokio::select! {
        result = &mut primary => result,
        _ = sleep(hedge_after) => {
            tokio::select! {
                result = &mut primary => result,
                result = replica_b(id) => result,
            }
        }
    }
}`,
          tip: "Cap hedges: a hedge rate above roughly 5% of requests turns a latency fix into a capacity problem."
        },
        {
          h: "Measure the tail you actually serve",
          p: [
            "Measure at the client, not only inside the service: the network, the load balancer queue, and retries are part of the user's latency. Use a histogram with enough resolution to see p999 and max, keep the raw distribution, and merge histograms across instances rather than averaging percentiles. Percentiles from one-minute averages are fiction; a merged histogram is the only honest fleet number.",
            "Report max as well. A p999 that looks fine next to a max of eleven seconds is telling you about a rare mechanism - a reconnect storm, a lock convoy, a cold cache, or a stop-the-world pause - that no percentile will explain, and that a percentile-based alert will never page anyone for."
          ]
        }
      ],
      exercise: {
        prompt: "Implement hedged_request: send to replica A, and if it has not answered after 20 ms, race the same request against replica B. Return the first success and let the loser be cancelled.",
        starter: `use std::time::Duration;
use tokio::time::sleep;

type Error = Box<dyn std::error::Error + Send + Sync>;

async fn replica_a(id: u64) -> Result<String, Error> { todo!() }
async fn replica_b(id: u64) -> Result<String, Error> { todo!() }

pub async fn hedged_request(id: u64) -> Result<String, Error> {
    // 1. start A
    // 2. select over A and a 20 ms sleep
    // 3. on timeout, select over A and B
    todo!()
}`,
        hint: "Pin the primary future with tokio::pin!, then select over &mut primary and sleep. In the timeout branch, select again over &mut primary and replica_b. Dropping the pinned future at return cancels it.",
        solution: `use std::time::Duration;
use tokio::time::sleep;

type Error = Box<dyn std::error::Error + Send + Sync>;

async fn replica_a(id: u64) -> Result<String, Error> {
    sleep(Duration::from_millis(60)).await;
    Ok(format!("a-{id}"))
}

async fn replica_b(id: u64) -> Result<String, Error> {
    sleep(Duration::from_millis(25)).await;
    Ok(format!("b-{id}"))
}

pub async fn hedged_request(id: u64) -> Result<String, Error> {
    let primary = replica_a(id);
    tokio::pin!(primary);

    tokio::select! {
        result = &mut primary => result,
        _ = sleep(Duration::from_millis(20)) => {
            tokio::select! {
                result = &mut primary => result,
                result = replica_b(id) => result,
            }
        }
    }
}

#[tokio::main]
async fn main() {
    // A takes 60 ms, so the hedge fires at 20 ms and B wins at 45 ms.
    let answer = hedged_request(7).await.unwrap();
    assert_eq!(answer, "b-7");
    println!("{answer}");
}

// Cancellation safety matters: dropping the losing future must not leave
// a half-written record. Keep request handlers idempotent for this reason.`
      },
      production: [
        "Fan-out endpoints have a documented tail budget and a cap on concurrent dependencies.",
        "Retries are limited, jittered, and charged against the remaining request budget.",
        "Hedges are capped as a fraction of traffic and disabled when the backend is unhealthy.",
        "Latency histograms are merged across instances; averaged percentiles are not used.",
        "Max latency is reported alongside p999, with a named mechanism for each outlier class."
      ],
      crates: ["tokio", "hdrhistogram", "tower"],
      pitfall: "Hedging every request to fix a tail caused by queueing: the duplicate load pushes utilisation higher, the queue gets longer, and the tail gets worse.",
      questions: [
        {
          q: "A request fans out to 50 services, each with a 1% chance of being slow. Roughly what fraction of requests hits at least one slow service?",
          options: [
            "About 1%",
            "About 10%",
            "About 39%",
            "About 99%"
          ],
          answer: 2,
          explain: "1 - 0.99^50 is about 0.395. Tail probability compounds with fan-out, which is why the max over dependencies dominates."
        },
        {
          q: "Why do aggressive retries make tail latency worse?",
          options: [
            "Retries bypass the load balancer",
            "Retried requests add load to the component that is already slow, increasing its queue",
            "Retries use a different code path with more allocations",
            "Retries disable keep-alive"
          ],
          answer: 1,
          explain: "A timeout usually means the server is saturated. Retrying multiplies work exactly when capacity is scarce, turning a slowdown into an outage."
        },
        {
          q: "Which measurement is trustworthy for a fleet-wide p99?",
          options: [
            "The average of each instance's p99",
            "The p99 of one-minute average latencies",
            "A histogram merged across instances, then queried at the 0.99 quantile",
            "The maximum latency divided by the request count"
          ],
          answer: 2,
          explain: "Averages of percentiles and percentiles of averages both lose the distribution. Merge histograms first, then take the quantile."
        }
      ],
      quickbytes: [
        "Fan-out multiplies tail risk: 1 - (1 - p)^n, so cap dependency count as well as latency.",
        "Remove queueing before adding hedges; hedging into a saturated backend makes the tail worse.",
        "Cap hedge rate near 5% of traffic and disable it when error rates rise.",
        "Merge histograms across instances, and always report max next to p999."
      ],
      github: [
        { name: "hdrhistogram - recording and merging latency distributions", url: "https://github.com/HdrHistogram/HdrHistogram_rust" },
        { name: "tower - timeouts, load shedding, and retry layers", url: "https://github.com/tower-rs/tower" }
      ],
      resources: [
        {
          title: "The Tail at Scale (Dean & Barroso)",
          url: "https://research.google/pubs/the-tail-at-scale/",
          kind: "paper"
        },
        {
          title: "hdrhistogram: histograms built for latency tails",
          url: "https://docs.rs/hdrhistogram/latest/hdrhistogram/",
          kind: "docs"
        },
        {
          title: "oha: latency correction and tail reporting",
          url: "https://github.com/hatoo/oha",
          kind: "repo"
        },
        {
          title: "USENIX: tail-latency and datacenter measurement talks",
          url: "https://www.youtube.com/@USENIX",
          kind: "video"
        }
      ]
    },
    {
      id: "pf12",
      n: 12,
      title: "Queueing theory for engineers",
      minutes: 90,
      level: "advanced",
      goal: "Use utilisation, Little's law, and variability to predict latency and size pools before a load test surprises you, and understand why coordinated omission flatters every result.",
      sections: [
        {
          h: "Utilisation is the whole story",
          p: [
            "For a single server with Poisson arrivals and exponential service, response time is R = S/(1-U), where S is service time and U = lambda x S is utilisation. At 50% utilisation a 10 ms service takes 20 ms; at 90% it takes 100 ms; at 99% it takes one second. The curve is not linear and it is not gentle: most latency incidents are utilisation incidents wearing a costume.",
            "Real systems are not M/M/1, but the shape holds well enough to plan with. The practical rule: keep steady-state utilisation under 60-70% for latency-sensitive services, and treat 80% as an incident waiting for a traffic spike, a rolling deploy, or one slow query to tip it over."
          ],
          list: [
            "R = S/(1-U): latency doubles at 50% and grows tenfold at 90%",
            "Plan capacity for peak, not for the daily average",
            "Utilisation above 70% leaves no room for failover or deploys",
            "Queue wait is where the tail lives; service time is usually stable"
          ]
        },
        {
          h: "Little's law sizes everything",
          p: [
            "L = lambda x W: the average number of items in a system equals arrival rate times average time in the system. It applies to connection pools, thread pools, queues, and in-flight requests, and it needs no distributional assumptions. A pool of 20 connections serving 2,000 requests per second at 5 ms each needs L = 2000 x 0.005 = 10 connections; a pool of 20 has headroom, a pool of 8 is already saturated and queueing.",
            "The same equation sizes worker threads, database connections, and concurrency limits. The mistake is to size for the mean and then wonder why the p99 queues: at the p99 service time the required concurrency is five times larger, and the pool that was adequate at the median is saturated exactly when requests are slowest."
          ]
        },
        {
          h: "Variability is the missing term",
          p: [
            "Kingman's approximation adds what M/M/1 hides: wait time grows with the sum of the squared coefficients of variation of arrivals and service times. Two systems with identical average load can have wildly different tails if one has bursty arrivals or variable service times. That is why smoothing batch jobs, avoiding retry storms, and making service times uniform - cache hits, fixed-size work, precomputed answers - reduces latency without adding capacity."
          ],
          code: `fn response_time(service_ms: f64, utilisation: f64) -> f64 {
    assert!((0.0..1.0).contains(&utilisation), "U must be in [0, 1)");
    service_ms / (1.0 - utilisation)
}

/// Little's law: concurrency = arrival rate x time in system.
fn pool_size(arrival_per_sec: f64, latency_secs: f64) -> f64 {
    arrival_per_sec * latency_secs
}

fn main() {
    let service_ms = 10.0;
    for u in [0.3, 0.5, 0.7, 0.9, 0.95, 0.99] {
        println!("U={u:.2} -> R={:.1} ms", response_time(service_ms, u));
    }

    // 2,000 rps, 5 ms per request at the median.
    println!("pool for p50: {:.0}", pool_size(2_000.0, 0.005));
    // Same traffic, 25 ms at the p99.
    println!("pool for p99: {:.0}", pool_size(2_000.0, 0.025));
}`,
          tip: "A pool sized for the median is a queue sized for the tail. Add a timeout so waiting requests fail instead of accumulating."
        },
        {
          h: "Coordinated omission flatters every result",
          p: [
            "If a load generator waits for a response before sending the next request, it stops sending while the server is slow. The slow period is under-sampled, so the reported p99 is far better than what a real client sending at a fixed rate would see. This is coordinated omission, and it is the most common reason a load test passes while production burns.",
            "The fix is to generate at a fixed rate and measure each request from its scheduled send time, including the time it spent waiting for a worker or a connection. oha's --latency-correction does exactly this for HTTP load tests, and hdrhistogram's record_correct does the same for measurements taken inside the process."
          ]
        }
      ],
      exercise: {
        prompt: "A service handles 3,000 requests per second and each request makes one query taking 4 ms at p50 and 25 ms at p99. Size the connection pool for both percentiles, then decide what to ship and why.",
        starter: `fn pool_size(arrival_per_sec: f64, latency_secs: f64) -> f64 {
    arrival_per_sec * latency_secs
}

fn main() {
    // p50: 3000 rps x 0.004 s
    // p99: 3000 rps x 0.025 s
    // print both, then reason about which to ship
}`,
        hint: "Little's law gives 12 connections at p50 and 75 at p99. Shipping 75 idle connections wastes database memory; shipping 12 queues at the tail. The usual answer is a pool near the p99 need with a short acquisition timeout and a shed path.",
        solution: `fn pool_size(arrival_per_sec: f64, latency_secs: f64) -> f64 {
    arrival_per_sec * latency_secs
}

fn main() {
    let p50 = pool_size(3_000.0, 0.004);
    let p99 = pool_size(3_000.0, 0.025);

    println!("p50 needs {p50:.0} connections");
    println!("p99 needs {p99:.0} connections");

    // Shipping 12 keeps the database small but queues as soon as service
    // time drifts. Shipping 75 covers the tail but leaves most connections
    // idle at normal load, and the database pays for each one.
    //
    // A defensible middle: size near 48 (roughly p95 need), set a 50 ms
    // acquisition timeout, and shed load when the pool is exhausted. The
    // timeout converts an unbounded queue into a bounded, observable one.
    let shipped = 48.0;
    assert!(shipped > p50 && shipped < p99);
    println!("ship {shipped:.0} with a 50 ms acquire timeout");
}`
      },
      production: [
        "Steady-state utilisation targets are documented per service, with headroom for failover and deploys.",
        "Pools and concurrency limits are derived from Little's law and recorded with the assumed latency.",
        "Pool acquisition has a timeout; waiting is measured and alerted, not invisible.",
        "Load tests generate at a fixed rate with latency correction enabled.",
        "Bursty batch jobs are scheduled away from latency-sensitive peaks or smoothed."
      ],
      crates: ["hdrhistogram", "tokio", "sqlx"],
      pitfall: "Sizing a connection pool from the median service time: the pool is adequate on average and permanently saturated whenever the tail arrives, which is exactly when requests are slow.",
      questions: [
        {
          q: "A service has 10 ms of service time and runs at 90% utilisation. What is the approximate response time under M/M/1?",
          options: [
            "About 11 ms",
            "About 50 ms",
            "About 100 ms",
            "It is unbounded"
          ],
          answer: 2,
          explain: "R = S/(1-U) = 10/0.1 = 100 ms. The tenfold amplification at 90% is why headroom is a latency decision, not a cost decision."
        },
        {
          q: "Which statement about Little's law is correct?",
          options: [
            "It requires Poisson arrivals and exponential service",
            "It holds for any stable system: concurrency equals arrival rate times time in system",
            "It only applies to network queues",
            "It predicts the p99, not the mean"
          ],
          answer: 1,
          explain: "L = lambda x W needs only stability and consistent units. That is why it is the most reusable formula in capacity planning."
        },
        {
          q: "Why does splitting one queue into several independent servers reduce tail latency at the same total capacity?",
          options: [
            "Each server becomes faster",
            "The probability that a request waits behind a long job on the same queue falls",
            "Total utilisation drops",
            "Queueing theory does not apply to multiple servers"
          ],
          answer: 1,
          explain: "Fewer requests share each queue, so the chance of landing behind a slow one drops. It is why sharding and micro-partitioning help the tail."
        }
      ],
      quickbytes: [
        "Keep latency-sensitive services under 70% utilisation; latency doubles at 50% and grows tenfold at 90%.",
        "Size pools with L = lambda x W at a high percentile, then bound the wait with a timeout.",
        "Reduce variability before adding capacity: bursty arrivals hurt as much as heavy load.",
        "Generate load at a fixed rate with latency correction, or your p99 is a fiction."
      ],
      github: [
        { name: "hdrhistogram - record_correct for coordinated omission", url: "https://github.com/HdrHistogram/HdrHistogram_rust" },
        { name: "oha - fixed-rate load generation", url: "https://github.com/hatoo/oha" }
      ],
      resources: [
        {
          title: "hdrhistogram: record_correct and coordinated omission",
          url: "https://docs.rs/hdrhistogram/latest/hdrhistogram/",
          kind: "docs"
        },
        {
          title: "oha: --latency-correction and open-loop generation",
          url: "https://github.com/hatoo/oha",
          kind: "repo"
        },
        {
          title: "The Tail at Scale: queueing and fan-out effects",
          url: "https://research.google/pubs/the-tail-at-scale/",
          kind: "paper"
        },
        {
          title: "USENIX: queueing and datacenter performance talks",
          url: "https://www.youtube.com/@USENIX",
          kind: "video"
        }
      ]
    },
    {
      id: "pf13",
      n: 13,
      title: "Load testing: open versus closed models",
      minutes: 105,
      level: "industry",
      goal: "Run a load test that tells the truth: fixed arrival rate, latency measured from the scheduled send time, staged ramps, and saturation signals recorded alongside percentiles.",
      sections: [
        {
          h: "Closed loops hide the latency you are trying to measure",
          p: [
            "A closed-loop load test has N workers, each sending a request and waiting for the response. When the server slows down, workers slow down too, so the test stops offering load exactly during the slow period. The reported p99 describes a system that was never pushed. This is coordinated omission in load-generator form, and it is why a test passes at 1,000 requests per second while production dies at 600.",
            "An open-loop test sends at a fixed rate regardless of responses. If the server cannot keep up, the queue grows and latency rises, which is what a real client population does. The generator must then measure each request from its scheduled send time, including the time it spent waiting for a connection."
          ]
        },
        {
          h: "Drive it with oha",
          p: [
            "oha is a Rust HTTP load generator with an open-loop mode: -q sets a fixed queries-per-second rate across all connections, -z sets the duration, -c sets connections, and --latency-correction measures from the scheduled send time instead of the actual one. --disable-keepalive models clients that do not reuse connections, and --output-format json turns each run into a file you can diff and gate on."
          ],
          code: `#!/usr/bin/env bash
set -euo pipefail

TARGET="http://127.0.0.1:8080/orders"
OUT="perf/load"
mkdir -p "$OUT"

# Warm the service, the pool, and the page cache before measuring.
oha -z 20s -q 200 -c 32 --latency-correction --disable-keepalive --output-format json -o "$OUT/warmup.json" "$TARGET"

# Staged open-loop run: fixed arrival rate, latency measured from schedule.
for qps in 400 800 1200 1600; do
  oha -z 60s -q "$qps" -c 64 --latency-correction --output-format json -o "$OUT/qps-$qps.json" "$TARGET"
done

# Closed-loop comparison: workers wait for responses, so it flatters the tail.
oha -z 60s -c 64 --output-format json -o "$OUT/closed-loop.json" "$TARGET"

# Compare the two p99 values. A large gap is coordinated omission,
# not a difference in the service.`,
          tip: "Run the generator on a different machine. Sharing a host with the service means you are measuring your own CPU contention."
        },
        {
          h: "Record saturation, not just latency",
          p: [
            "Record achieved throughput (not requested), p50/p99/p999/max, error rate and error classes, and the saturation signals on the server: CPU, run-queue length, pool wait, queue depth, allocator activity. A run with 0.4% errors is a different system from one with none; report errors separately instead of hiding them inside a latency average.",
            "Ignore the first seconds: connection setup, cold caches, pool growth, and autoscaling all distort the start. Warm up, then measure. And keep every run's JSON artifact next to the commit, because the interesting comparison is between two runs of the same test, not against a number someone typed into a slide last quarter."
          ]
        },
        {
          h: "Ramp, saturate, and find the knee",
          p: [
            "A single-rate test tells you whether the system survives that rate. A ramp tells you where it stops: increase the rate in stages until p99 or the error rate crosses a threshold, and record the rate at that knee. That knee, minus a safety margin, is the capacity number for the planning document - not the highest rate that happened not to error in one run."
          ],
          tip: "Stop the ramp at the first stage that breaches the SLO. Continuing past it only produces numbers nobody can act on."
        }
      ],
      exercise: {
        prompt: "Write a Rust load generator that sends 500 requests per second for 10 seconds, measures each request from its scheduled send time, and prints p50/p99/p999 from an HdrHistogram.",
        starter: `use hdrhistogram::Histogram;
use std::time::{Duration, Instant};
use tokio::time::{interval, MissedTickBehavior};

async fn call() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // stand-in for an HTTP call
    tokio::time::sleep(Duration::from_millis(2)).await;
    Ok(())
}

#[tokio::main]
async fn main() {
    // 1. interval at 2 ms (500 rps), MissedTickBehavior::Delay
    // 2. record latency from the scheduled tick, not from send time
    // 3. print p50/p99/p999
}`,
        hint: "Call tick() first, take Instant::now() as the scheduled time, then await the call and record now - scheduled with hist.record_correct(elapsed_ms, 2). record_correct attributes the wait to the sample, which is the in-process version of latency correction.",
        solution: `use hdrhistogram::Histogram;
use std::time::{Duration, Instant};
use tokio::time::{interval, MissedTickBehavior};

async fn call() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tokio::time::sleep(Duration::from_millis(2)).await;
    Ok(())
}

#[tokio::main]
async fn main() {
    let rate_hz = 500u64;
    let period = Duration::from_micros(1_000_000 / rate_hz);
    let mut hist = Histogram::<u64>::new_with_bounds(1, 60_000, 3).unwrap();

    let mut ticker = interval(period);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let mut errors = 0u64;
    for _ in 0..(rate_hz * 10) {
        ticker.tick().await;
        let scheduled = Instant::now(); // the time this request was due

        if call().await.is_err() {
            errors += 1;
        }

        let elapsed_ms = scheduled.elapsed().as_micros().max(1) as u64 / 1000;
        // record_correct also accounts for the interval, so a request that
        // waited for a connection is not under-reported.
        hist.record_correct(elapsed_ms.max(1), period.as_millis() as u64)
            .unwrap();
    }

    println!(
        "p50={} ms p99={} ms p999={} ms max={} ms errors={}",
        hist.value_at_quantile(0.50),
        hist.value_at_quantile(0.99),
        hist.value_at_quantile(0.999),
        hist.max(),
        errors
    );
}`
      },
      production: [
        "Load tests are open-loop with latency correction; closed-loop runs are labelled as such and never quoted as SLO evidence.",
        "Every run records achieved throughput, error classes, and server saturation signals alongside percentiles.",
        "The generator runs on separate hardware from the service under test.",
        "Ramps stop at the first SLO breach, and the knee rate is recorded as capacity.",
        "Run artefacts (JSON output plus server metrics) are archived with the commit under test."
      ],
      crates: ["oha", "hdrhistogram", "tokio"],
      pitfall: "Running a closed-loop test with 50 workers and reporting its p99: the generator stops sending during the slow period, so the number describes a system that was never under the load the report claims.",
      questions: [
        {
          q: "What is coordinated omission in a load test?",
          options: [
            "The generator skips requests that would fail",
            "The generator waits for responses, so it under-samples the slow period and reports a better tail",
            "The server drops requests during the test",
            "Multiple generators share the same clock"
          ],
          answer: 1,
          explain: "A closed-loop generator reduces offered load exactly when latency rises. Fixed-rate generation with scheduled-time measurement is the fix."
        },
        {
          q: "What does oha's --latency-correction do?",
          options: [
            "It subtracts network latency from every sample",
            "It measures latency from the scheduled send time, including time spent waiting for a connection",
            "It retries failed requests",
            "It disables keep-alive automatically"
          ],
          answer: 1,
          explain: "It only has an effect with -q or --burst-delay, and it converts the closed-loop measurement into an open-loop one."
        },
        {
          q: "Why should the load generator run on a separate host?",
          options: [
            "oha refuses to run on the same host as the target",
            "Generator CPU and network contend with the service, so the measurement includes your own load",
            "The service would reject loopback traffic",
            "Latency correction does not work over loopback"
          ],
          answer: 1,
          explain: "The generator is a real workload. Sharing a host means the service competes with the thing measuring it."
        }
      ],
      quickbytes: [
        "Generate at a fixed rate and measure from the scheduled send time; everything else under-reports the tail.",
        "Warm up for at least 20 seconds, then discard the warm-up from the report.",
        "Ramp in stages and stop at the first SLO breach; that rate is the capacity number.",
        "Keep the JSON output per run so two runs can be compared later."
      ],
      github: [
        { name: "oha - HTTP load generator with latency correction", url: "https://github.com/hatoo/oha" },
        { name: "hdrhistogram - recording corrected latency samples", url: "https://github.com/HdrHistogram/HdrHistogram_rust" }
      ],
      resources: [
        {
          title: "oha: usage, --latency-correction, and coordinated omission",
          url: "https://github.com/hatoo/oha",
          kind: "repo"
        },
        {
          title: "hdrhistogram: record_correct and quantile queries",
          url: "https://docs.rs/hdrhistogram/latest/hdrhistogram/",
          kind: "docs"
        },
        {
          title: "The Tail at Scale: what load tests miss about fan-out",
          url: "https://research.google/pubs/the-tail-at-scale/",
          kind: "paper"
        },
        {
          title: "USENIX: load testing and benchmark methodology talks",
          url: "https://www.youtube.com/@USENIX",
          kind: "video"
        }
      ]
    },
    {
      id: "pf14",
      n: 14,
      title: "Capacity planning: headroom, not averages",
      minutes: 90,
      level: "industry",
      goal: "Convert load-test results into a fleet size with explicit headroom, identify the binding constraint, and account for the lag between a spike and the capacity that answers it.",
      sections: [
        {
          h: "From load test to fleet size",
          p: [
            "The arithmetic is simple once the inputs are right: instances = ceil(peak_qps x cpu_seconds_per_request / (cores x target_utilisation)), then add failover headroom and deploy headroom. If a request needs 8 ms of CPU and you serve 3,000 requests per second on 4-core machines at 60%, you need 3000 x 0.008 / (4 x 0.6) = 10 instances, plus one for failover.",
            "The inputs are the hard part. Peak QPS is not the daily average; it is the busiest minute at a high percentile, multiplied by a growth factor. CPU seconds per request must come from a profile, and it must include work done on the request's behalf by other services - otherwise the fleet is sized for the easy half of the path."
          ],
          list: [
            "Peak QPS: busiest minute at p999, times a growth allowance",
            "CPU seconds per request: measured, including downstream fan-out",
            "Target utilisation: 60% for latency-sensitive, higher only with evidence",
            "Headroom: N+1 for failover, one instance for rolling deploys"
          ]
        },
        {
          h: "Find the binding constraint",
          p: [
            "CPU is rarely the only limit. Memory bandwidth, connection counts, file descriptors, database pool size, upstream rate limits, TLS handshakes per second, and network egress each cap throughput independently. The binding constraint is the first one you hit as load rises; adding capacity to anything else is money spent on a resource that was not the problem.",
            "Load tests find it if you watch the right signals: a service at 40% CPU with p99 climbing is bound by a lock, a pool, or a dependency, not by compute. The capacity plan must name the constraint and the number at which it binds."
          ],
          code: `#[derive(Debug, Clone, Copy)]
struct Resource {
    name: &'static str,
    per_instance: f64, // capacity of one instance
    per_request: f64,  // consumption of one request
}

/// Requests per second at which this resource saturates the fleet.
fn saturation_rps(resource: Resource, instances: f64) -> f64 {
    instances * resource.per_instance / resource.per_request
}

fn main() {
    let fleet = 12.0;
    let limits = [
        Resource { name: "cpu", per_instance: 4.0, per_request: 0.008 },
        Resource { name: "memory", per_instance: 8.0e9, per_request: 3.0e6 },
        Resource { name: "db_pool", per_instance: 20.0, per_request: 0.004 },
    ];

    for resource in limits {
        println!(
            "{:>8} saturates at {:.0} rps",
            resource.name,
            saturation_rps(resource, fleet)
        );
    }

    // cpu 6,000 rps, memory 32,000, db_pool 60,000: CPU binds first.
    // Adding memory to this fleet buys nothing until CPU moves.
}`
        },
        {
          h: "Autoscaling lags, so plan for the spike",
          p: [
            "Autoscalers react to metrics that are already late: a 60-second average, a scrape interval, an instance boot, and a warm-up. For a traffic spike lasting two minutes, the fleet arrives after the spike. Pre-scale for known events - launches, marketing, month-end - keep a warm buffer for the unknown, and make scale-in slow so a brief dip does not remove capacity you need thirty seconds later."
          ],
          tip: "Measure the time from 'metric crosses threshold' to 'new instance serving traffic'. That number, not the average QPS, sets your minimum buffer."
        },
        {
          h: "Headroom is a product decision",
          p: [
            "Every percentage point of target utilisation buys cost and spends latency. At 60% you have room for one instance to fail and for a rolling deploy; at 85% you have neither, and a single slow query cascades. Write the headroom policy down - N+1 for failover, one instance for deploys, 30% for diurnal peaks - and make the cost of each explicit in the plan."
          ]
        }
      ],
      exercise: {
        prompt: "Compute the fleet for 3,000 requests per second, 8 ms of CPU per request, 4-core instances, and a 60% target utilisation, plus N+1 and one instance for deploys. Then recompute at 80% and state the trade.",
        starter: `fn fleet(peak_qps: f64, cpu_secs_per_req: f64, cores: f64, target_util: f64) -> f64 {
    // ceil(qps * cpu / (cores * util))
    todo!()
}

fn main() {
    // 1. compute at 0.60 and add N+1 plus one deploy instance
    // 2. compute at 0.80
    // 3. print both and the percentage saved
}`,
        hint: "At 60%: 3000 x 0.008 / (4 x 0.6) = 10.0, so 10 base + 1 failover + 1 deploy = 12. At 80%: 7.5, so 8 + 2 = 10. The two instances saved are the headroom you gave up.",
        solution: `fn fleet(peak_qps: f64, cpu_secs_per_req: f64, cores: f64, target_util: f64) -> u32 {
    assert!(target_util > 0.0 && target_util < 1.0);
    let base = (peak_qps * cpu_secs_per_req / (cores * target_util)).ceil();
    base as u32
}

fn main() {
    let qps = 3_000.0;
    let cpu = 0.008; // 8 ms of CPU per request, from a profile
    let cores = 4.0;

    let at_60 = fleet(qps, cpu, cores, 0.60) + 1 /* N+1 */ + 1 /* deploy */;
    let at_80 = fleet(qps, cpu, cores, 0.80) + 1 + 1;

    println!("60% target: {at_60} instances");
    println!("80% target: {at_80} instances");

    // 60%: 10 base + 2 = 12. 80%: 8 base + 2 = 10.
    // The two saved instances are base capacity, not headroom: headroom is
    // still there, but at 80% losing one instance leaves the rest near 89%,
    // where queueing theory says latency roughly doubles.
    assert_eq!(at_60, 12);
    assert_eq!(at_80, 10);
    assert!(at_60 > at_80);

    // At 80%, one instance lost to a bad deploy leaves the rest at ~89%,
    // where queueing theory says latency roughly doubles.
}`
      },
      production: [
        "Fleet sizing is derived from a measured CPU-seconds-per-request figure that includes downstream work.",
        "The binding constraint is named in the capacity document with the load at which it binds.",
        "Headroom policy is explicit: N+1 failover, one instance for deploys, and a stated peak allowance.",
        "Scale-up latency is measured, and known events are pre-scaled rather than left to autoscaling.",
        "Capacity is re-derived after every significant performance change, not carried forward."
      ],
      crates: ["tokio", "criterion", "sqlx", "oha"],
      pitfall: "Planning capacity from the daily average QPS: the average is served comfortably while the daily peak, which is two to five times higher, queues and times out.",
      questions: [
        {
          q: "Why is 100% target utilisation a bad capacity plan?",
          options: [
            "Cloud providers bill a penalty above 90%",
            "Queueing latency grows without bound as utilisation approaches one, and there is no room for failover or deploys",
            "CPUs throttle above 90% by design",
            "Autoscalers cannot scale past 90%"
          ],
          answer: 1,
          explain: "R = S/(1-U) diverges at U=1. Headroom is what keeps the p99 finite when an instance disappears."
        },
        {
          q: "A service runs at 35% CPU while p99 climbs with load. What is the likely binding constraint?",
          options: [
            "CPU frequency scaling",
            "A non-CPU resource: a lock, a connection pool, a dependency, or network",
            "The compiler's optimisation level",
            "Insufficient memory allocation"
          ],
          answer: 1,
          explain: "Low CPU with rising latency means requests are waiting, not computing. Find the queue: pool, lock, connection, or downstream."
        },
        {
          q: "What does N+1 headroom mean in a capacity plan?",
          options: [
            "One extra instance per availability zone",
            "Capacity sufficient to lose one instance and still meet the SLO",
            "One instance reserved for deploys only",
            "One more core than the benchmark used"
          ],
          answer: 1,
          explain: "N+1 covers a single failure. Deploy headroom is a separate allowance, because a rolling deploy takes an instance out on purpose."
        }
      ],
      quickbytes: [
        "Size from peak QPS and measured CPU seconds per request, then add failover and deploy headroom.",
        "Name the binding constraint; adding capacity to a non-binding resource buys nothing.",
        "Measure scale-up latency and pre-scale known events instead of trusting autoscaling.",
        "Re-derive capacity after every big performance change."
      ],
      github: [
        { name: "tokio - measuring per-request CPU cost", url: "https://github.com/tokio-rs/tokio" },
        { name: "oha - finding the capacity knee", url: "https://github.com/hatoo/oha" }
      ],
      resources: [
        {
          title: "AWS Well-Architected: cost optimization pillar",
          url: "https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html",
          kind: "docs"
        },
        {
          title: "Kubernetes horizontal pod autoscaling",
          url: "https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/",
          kind: "docs"
        },
        {
          title: "The Tail at Scale: why headroom protects the tail",
          url: "https://research.google/pubs/the-tail-at-scale/",
          kind: "paper"
        },
        {
          title: "InfoQ: capacity planning and scaling talks",
          url: "https://www.youtube.com/@InfoQ",
          kind: "video"
        }
      ]
    },
    {
      id: "pf15",
      n: 15,
      title: "Database performance: the query is the bottleneck",
      minutes: 105,
      level: "industry",
      goal: "Read EXPLAIN (ANALYZE, BUFFERS) for evidence rather than intuition, eliminate N+1 round trips, and design indexes that pay for their write cost.",
      sections: [
        {
          h: "Measure the plan, not the stopwatch",
          p: [
            "In most request paths the database is the slowest hop, and the usual culprits are a missing index, a query returning more rows than needed, or an N+1 pattern that turns one request into fifty round trips. pg_stat_statements gives the aggregate view; EXPLAIN (ANALYZE, BUFFERS) explains one statement with actual time, rows, loops, and shared hits versus reads.",
            "The most common surprise is a row estimate that is off by orders of magnitude, which makes the planner choose a nested loop for what is really a large scan. Run ANALYZE, check the statistics target, and compare the planned rows column with the actual rows column before changing anything."
          ],
          list: [
            "Actual time per loop, not total time, is what a single request pays",
            "Buffers: hit means cache, read means disk; a read-heavy hot query needs memory or a better index",
            "Rows Removed by Filter high means the index is not selective enough",
            "Estimated versus actual rows far apart means stale statistics"
          ]
        },
        {
          h: "N+1 and round trips",
          p: [
            "Each round trip costs a network RTT plus parse and planning. Fifty of them at 0.5 ms is 25 ms before any real work. Batch with = ANY($1) or a join, use prepared statements so planning is cached, and pipeline independent queries when the driver supports it. The goal is one round trip per request, or as close as the consistency model allows.",
            "The fix belongs in the query layer, not in a cache in front of it. A cache hides the N+1 until the cache misses, and then the tail returns with interest: one request pays fifty round trips while the rest were paying one, which is exactly the bimodal latency histogram nobody can explain."
          ]
        },
        {
          h: "Indexes: read speed paid for on writes",
          p: [
            "An index turns a scan into a lookup at the cost of write amplification and storage. Choose indexes for the predicates and orderings you actually use, prefer covering indexes for hot read paths, and remember that a low-selectivity index on a boolean column is usually ignored by the planner. Composite index column order matters: equality predicates first, then range, then sort."
          ],
          code: `-- Before: one query per order (N+1), 50 round trips per request.
SELECT id, total_cents FROM order_items WHERE order_id = $1;

-- After: one query for all 50 orders.
SELECT order_id, id, total_cents
FROM order_items
WHERE order_id = ANY($1)
ORDER BY order_id, id;

-- Read the plan, not only the time:
EXPLAIN (ANALYZE, BUFFERS)
SELECT order_id, id, total_cents
FROM order_items
WHERE order_id = ANY($1);

-- Buffers: hit=... read=...   -> reads mean the working set missed cache.
-- Rows Removed by Filter: ... -> the index is not selective enough.
-- actual rows vs planned rows -> stale statistics; run ANALYZE.`,
          tip: "A covering index can answer a hot query without touching the table, but every covered column is copied into the index on write."
        },
        {
          h: "Measure at production scale",
          p: [
            "A query that is fast on 100 rows can be catastrophic on 10 million: the plan changes, the cache hit rate changes, and the index that helped becomes a liability. Load test against a production-sized dataset with production statistics, and watch buffer cache hit ratio and disk reads per query. If the test dataset fits in RAM, you are benchmarking the page cache."
          ]
        }
      ],
      exercise: {
        prompt: "Rewrite an N+1 loop that fetches items for 50 orders into a single query using = ANY($1), then explain which EXPLAIN line would prove the improvement.",
        starter: `use sqlx::PgPool;
use uuid::Uuid;

pub async fn items_n_plus_one(
    pool: &PgPool,
    order_ids: &[Uuid],
) -> Result<Vec<(Uuid, i64)>, sqlx::Error> {
    let mut out = Vec::new();
    for id in order_ids {
        // one round trip per order
        let rows = sqlx::query_as::<_, (Uuid, i64)>(
            "SELECT order_id, total_cents FROM order_items WHERE order_id = $1",
        )
        .bind(id)
        .fetch_all(pool)
        .await?;
        out.extend(rows);
    }
    Ok(out)
}`,
        hint: "Bind the whole slice once with .bind(order_ids) and use WHERE order_id = ANY($1). In EXPLAIN, the proof is one scan with loops=1 instead of 50 loops, and a much lower total actual time.",
        solution: `use sqlx::PgPool;
use uuid::Uuid;

pub async fn items_batched(
    pool: &PgPool,
    order_ids: &[Uuid],
) -> Result<Vec<(Uuid, i64)>, sqlx::Error> {
    // One round trip, one plan, one scan for all orders.
    sqlx::query_as::<_, (Uuid, i64)>(
        r#"
        SELECT order_id, total_cents
        FROM order_items
        WHERE order_id = ANY($1)
        ORDER BY order_id, id
        "#,
    )
    .bind(order_ids)
    .fetch_all(pool)
    .await
}

// Proof in the plan:
//   N+1: 50 separate statements, each with loops=1, total time ~25 ms
//   Batched: one Index Scan, loops=1, actual time ~0.6 ms
// Check "Buffers: shared hit=" for the batched query; if "read=" dominates,
// the index is not covering and the table pages are coming from disk.`
      },
      production: [
        "Every endpoint has a query budget in round trips, and N+1 is caught by a test or a query counter.",
        "Slow-query review reads EXPLAIN (ANALYZE, BUFFERS), not just execution time.",
        "Indexes are added with a named query they serve and are removed when that query disappears.",
        "Load tests run against a production-sized dataset with production statistics.",
        "Prepared statements are used for repeated queries so planning is cached."
      ],
      crates: ["sqlx", "tokio", "deadpool-postgres", "postgres"],
      pitfall: "Testing queries against a 100-row table that fits in the page cache: the plan, the cache hit ratio, and the index choice all differ from production at 10 million rows.",
      questions: [
        {
          q: "EXPLAIN (ANALYZE, BUFFERS) shows high shared read and low shared hit for a hot query. What does that indicate?",
          options: [
            "The query is returning too many columns",
            "The working set is not in cache, so pages are being read from disk",
            "The planner chose a sequential scan",
            "The statistics are stale"
          ],
          answer: 1,
          explain: "Buffers separate cache hits from disk reads. Reads on a hot path mean the working set exceeds memory or the access pattern defeats the cache."
        },
        {
          q: "Why does OFFSET-based pagination get slower on later pages?",
          options: [
            "Later pages contain larger rows",
            "The database must generate and discard all preceding rows before returning the page",
            "OFFSET disables indexes",
            "Later pages require more network round trips"
          ],
          answer: 1,
          explain: "OFFSET 100000 scans and throws away 100,000 rows. Keyset pagination (WHERE id > last_id) seeks instead."
        },
        {
          q: "What is the cost of adding an index to a write-heavy table?",
          options: [
            "No cost; indexes only affect reads",
            "Every insert, update, and delete must maintain the index, adding write amplification and storage",
            "It doubles the number of connections needed",
            "It forces the planner to use nested loops"
          ],
          answer: 1,
          explain: "Indexes trade write throughput and storage for read speed. An unused index is pure cost."
        }
      ],
      quickbytes: [
        "Read EXPLAIN (ANALYZE, BUFFERS) for actual rows, loops, and cache hits before changing a query.",
        "Replace N+1 loops with one = ANY($1) query; the round trips are usually the dominant cost.",
        "Prefer keyset pagination over large OFFSET; the database discards everything before the page.",
        "Load test against production-sized data or you are benchmarking the page cache."
      ],
      github: [
        { name: "sqlx - async SQL with prepared statements", url: "https://github.com/transact-rs/sqlx" },
        { name: "PostgreSQL - the database under test", url: "https://github.com/postgres/postgres" }
      ],
      resources: [
        {
          title: "PostgreSQL: using EXPLAIN",
          url: "https://www.postgresql.org/docs/current/using-explain.html",
          kind: "docs"
        },
        {
          title: "PostgreSQL: indexes and index-only scans",
          url: "https://www.postgresql.org/docs/current/indexes.html",
          kind: "docs"
        },
        {
          title: "sqlx crate documentation",
          url: "https://docs.rs/sqlx/latest/sqlx/",
          kind: "docs"
        },
        {
          title: "sqlx repository: prepared statements and batching",
          url: "https://github.com/transact-rs/sqlx",
          kind: "repo"
        },
        {
          title: "USENIX: database performance and query optimization talks",
          url: "https://www.youtube.com/@USENIX",
          kind: "video"
        }
      ]
    },
    {
      id: "pf16",
      n: 16,
      title: "Network performance: RTT, syscalls, and TLS",
      minutes: 90,
      level: "industry",
      goal: "Account for round trips, handshakes, and syscalls in request latency, coalesce writes, and stop benchmarking the loopback interface as if it were a network.",
      sections: [
        {
          h: "The cost stack per request",
          p: [
            "A loopback request costs a few microseconds; a real one costs a round trip plus TLS plus queueing. The TCP handshake is one RTT, TLS 1.3 adds one, TLS 1.2 adds two; keep-alive amortises all of it across requests. On a 40 ms RTT link a new connection costs 80-120 ms before the first byte of response, which is why connection reuse is usually the largest single network optimisation available.",
            "Inside the process, every write is a syscall: roughly a microsecond plus a copy. A response written header by header pays per field. Nagle's algorithm and delayed ACK can interact to add up to 40 ms on small writes, so latency-sensitive request/response traffic usually sets TCP_NODELAY."
          ],
          list: [
            "Count round trips per request; each one costs at least an RTT",
            "Reuse connections: handshakes dominate short-lived traffic",
            "One write per response beats one write per field",
            "TCP_NODELAY for request/response; leave Nagle on for bulk streaming"
          ]
        },
        {
          h: "Frame messages and flush once",
          p: [
            "Coalesce writes: build the response in one buffer, or wrap a writer in BufWriter and flush once. For protocols you control, frame messages with a length prefix and read with read_exact into a reusable buffer instead of allocating per message. write_vectored lets the kernel gather several buffers in one syscall when the response is naturally segmented."
          ],
          code: `use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub struct Conn {
    stream: TcpStream,
    buf: Vec<u8>,
}

impl Conn {
    pub async fn connect(addr: &str) -> std::io::Result<Self> {
        let stream = TcpStream::connect(addr).await?;
        // Latency over throughput for request/response traffic.
        stream.set_nodelay(true)?;
        Ok(Self {
            stream,
            buf: Vec::with_capacity(8 * 1024),
        })
    }

    /// Length-prefixed frame: 4-byte big-endian length, then payload.
    pub async fn send(&mut self, payload: &[u8]) -> std::io::Result<()> {
        self.buf.clear();
        self.buf.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        self.buf.extend_from_slice(payload);
        // One syscall for header and body.
        self.stream.write_all(&self.buf).await
    }

    pub async fn recv(&mut self) -> std::io::Result<Vec<u8>> {
        let len = self.stream.read_u32().await? as usize;
        let mut out = vec![0u8; len];
        self.stream.read_exact(&mut out).await?;
        Ok(out)
    }
}`,
          tip: "Keep the frame buffer on the connection, not in the handler: it is the same allocation reused for every message."
        },
        {
          h: "Measure the network, not the loopback",
          p: [
            "Loopback has no RTT, no loss, and effectively unlimited bandwidth, so a benchmark over 127.0.0.1 tells you about your code and nothing about the network. Inject delay with tc netem, test across availability zones, and record RTT and retransmits (ss -ti) alongside throughput. A service that is fast on loopback and slow in production is usually paying for round trips it did not know it made."
          ]
        },
        {
          h: "Pools and head-of-line blocking",
          p: [
            "A connection pool has a size and a wait queue, and both are part of latency. HTTP/2 multiplexes streams over one connection, removing handshake cost but introducing TCP-level head-of-line blocking when a packet is lost; HTTP/3 moves that to QUIC streams. For internal gRPC, one connection per peer with many streams is usually right. For HTTP/1.1, size the pool with Little's law and measure the wait."
          ]
        }
      ],
      exercise: {
        prompt: "Take a client that writes a 4-byte header and a 200-byte body with two separate writes, and change it to one write with TCP_NODELAY enabled. Then batch 100 messages into a single write and explain when batching hurts latency.",
        starter: `use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

pub async fn send_one(stream: &mut TcpStream, body: &[u8]) -> std::io::Result<()> {
    stream.write_all(&(body.len() as u32).to_be_bytes()).await?;
    stream.write_all(body).await
}

pub async fn send_batch(stream: &mut TcpStream, bodies: &[&[u8]]) -> std::io::Result<()> {
    // one buffer, one write
    todo!()
}`,
        hint: "Build a Vec<u8> with capacity for all frames, extend it with each length and body, then a single write_all. Batching helps throughput and hurts latency: the first message waits for the batch to fill.",
        solution: `use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

pub async fn send_one(stream: &mut TcpStream, body: &[u8]) -> std::io::Result<()> {
    // Still two syscalls, but the connection has TCP_NODELAY set.
    stream.write_all(&(body.len() as u32).to_be_bytes()).await?;
    stream.write_all(body).await
}

pub async fn send_batch(stream: &mut TcpStream, bodies: &[&[u8]]) -> std::io::Result<()> {
    let total: usize = bodies.iter().map(|b| 4 + b.len()).sum();
    let mut buf = Vec::with_capacity(total);

    for body in bodies {
        buf.extend_from_slice(&(body.len() as u32).to_be_bytes());
        buf.extend_from_slice(body);
    }

    // One syscall for the whole batch.
    stream.write_all(&buf).await
}

// When batching hurts: a request/response protocol where the client waits
// for message one before producing message two. Batching then adds the
// wait for the batch to fill to every message's latency. Batch only when
// the messages are independent and throughput matters more than p50.
//
// Also set nodelay at connect time:
//   stream.set_nodelay(true)?;`
      },
      production: [
        "Every request path has a documented round-trip count, and new hops justify themselves.",
        "Connections are pooled or multiplexed; per-request connects are treated as a defect.",
        "Responses are written once; per-field writes are caught in review.",
        "TCP_NODELAY is set explicitly for request/response protocols.",
        "Latency tests run across a real network with injected delay, not over loopback."
      ],
      crates: ["tokio", "hyper", "bytes"],
      pitfall: "Benchmarking over 127.0.0.1 and concluding the network costs nothing: loopback has no RTT, no loss, and no handshake, so every round trip you removed looks free in the test and expensive in production.",
      questions: [
        {
          q: "What does TCP_NODELAY do?",
          options: [
            "It disables the TCP handshake",
            "It disables Nagle's algorithm, sending small writes immediately instead of coalescing them",
            "It increases the socket buffer size",
            "It enables TLS session resumption"
          ],
          answer: 1,
          explain: "Nagle reduces packet count by delaying small writes; for request/response traffic that delay is latency you did not ask for."
        },
        {
          q: "Why is connection reuse usually the biggest network win for a service?",
          options: [
            "It compresses payloads",
            "It amortises the TCP and TLS handshakes across many requests",
            "It avoids DNS entirely",
            "It removes the need for timeouts"
          ],
          answer: 1,
          explain: "A new connection costs one to three RTTs plus crypto. Reusing one makes that cost disappear from every request but the first."
        },
        {
          q: "A benchmark over loopback shows 40 microseconds per request, but production shows 8 ms. What is the most likely missing cost?",
          options: [
            "Rust's runtime is slower in production",
            "Real network round trips, TLS, and any queueing at the load balancer",
            "The production CPU is slower",
            "The loopback test used release mode"
          ],
          answer: 1,
          explain: "Loopback has no RTT and no handshake. The gap is the network path and the infrastructure in front of the service."
        }
      ],
      quickbytes: [
        "Count round trips per request; each one is at least an RTT you cannot optimise away in code.",
        "Build the response once and write it once; a syscall per field is a self-inflicted cost.",
        "Set TCP_NODELAY for request/response, and leave Nagle alone for bulk transfers.",
        "Test with netem delay or across zones; loopback benchmarks measure your code, not the network."
      ],
      github: [
        { name: "hyper - HTTP client and server", url: "https://github.com/hyperium/hyper" },
        { name: "tokio - async TCP and buffering", url: "https://github.com/tokio-rs/tokio" }
      ],
      resources: [
        {
          title: "tcp(7): Nagle, delayed ACK, and socket options",
          url: "https://man7.org/linux/man-pages/man7/tcp.7.html",
          kind: "docs"
        },
        {
          title: "tokio::net::TcpStream: set_nodelay and async I/O",
          url: "https://docs.rs/tokio/latest/tokio/net/struct.TcpStream.html",
          kind: "docs"
        },
        {
          title: "hyper repository: connection pooling and HTTP/2",
          url: "https://github.com/hyperium/hyper",
          kind: "repo"
        },
        {
          title: "InfoQ: networking and protocol performance talks",
          url: "https://www.youtube.com/@InfoQ",
          kind: "video"
        }
      ]
    },
    {
      id: "pf17",
      n: 17,
      title: "GC-less memory design: arenas, pools, and ownership",
      minutes: 105,
      level: "advanced",
      goal: "Design memory by lifetime instead of by type: per-request arenas, bounded pools, shared Bytes, and RSS-based monitoring that catches fragmentation before the weekly restart.",
      sections: [
        {
          h: "No collector, but plenty of memory work",
          p: [
            "Rust has no tracing collector, so there are no GC pauses - but there is allocator traffic, drop glue, and fragmentation. A long-running service that allocates per request slowly fragments the heap and grows RSS even when live memory is flat. The symptom is a service that needs a restart every week; the cause is usually a mix of size classes plus a few long-lived allocations pinning pages.",
            "The design question is lifetime, not language. Data that lives for one request belongs in a per-request arena; data that lives for the process belongs in a preallocated structure; data shared across tasks belongs behind Bytes or Arc, with the cost of the atomic refcount understood rather than assumed."
          ],
          list: [
            "Per-request data: arena, reset after the response is written",
            "Per-process data: preallocate at startup, never grow on the hot path",
            "Shared data: Bytes for zero-copy slices, Arc only when ownership is genuinely shared",
            "Every queue and cache needs a maximum and an overflow policy"
          ]
        },
        {
          h: "Arenas: allocate a lot, free once",
          p: [
            "bumpalo allocates by moving a pointer and frees everything when the arena is reset. For a request that builds a tree of strings, that turns N allocations and N frees into one bump and one reset. The trade is that individual values cannot be freed, so an arena must never hold anything that outlives the request - returning an arena-allocated reference to a caller is the classic bug."
          ],
          code: `use bumpalo::Bump;

pub struct Parsed<'a> {
    pub fields: Vec<&'a str>,
}

/// Parse one request into a per-request arena. The arena must outlive
/// the parsed value and must not be reset while it is borrowed.
pub fn parse_request<'a>(arena: &'a Bump, body: &'a str) -> Parsed<'a> {
    let mut fields = Vec::new();
    for line in body.lines() {
        // One bump allocation per field; no per-field malloc.
        fields.push(arena.alloc_str(line.trim()));
    }
    Parsed { fields }
}

fn main() {
    let arena = Bump::with_capacity(64 * 1024);
    let parsed = parse_request(&arena, "a=1\\nb=2\\nc=3");
    assert_eq!(parsed.fields, ["a=1", "b=2", "c=3"]);

    // Dropping the borrow, then resetting, frees every field at once.
    drop(parsed);
    arena.reset();
}`,
          tip: "An arena that is never reset is a memory leak with a nicer API. Reset it in the same scope that created it."
        },
        {
          h: "Pools and shared bytes",
          p: [
            "Pools trade memory for allocation latency: keep N buffers of the maximum size, hand them out, take them back cleared. Bound the pool, or a burst turns it into a memory leak with extra steps. Bytes gives cheap shared slices over one allocation, so a response can be split into header and body without copying, and cloning a Bytes is a refcount increment rather than a memcpy."
          ]
        },
        {
          h: "Bounded memory is a design property",
          p: [
            "Unbounded queues are memory leaks with good intentions. Every channel, cache, and pool needs a maximum and a policy for what happens at the maximum: block, shed, or drop oldest. Measure RSS, not only heap allocations, and alert on growth rate rather than absolute size. A service that grows 1% per day is an incident with a long fuse."
          ],
          tip: "Track allocated-bytes and RSS on the same dashboard; the gap between them is fragmentation and allocator retention."
        }
      ],
      exercise: {
        prompt: "A handler builds 200 short Strings per request with format!. Convert it to a per-request bumpalo arena, keep the response type borrowed from the arena, and reset the arena after the response is serialised.",
        starter: `use bumpalo::Bump;

pub struct Row<'a> {
    pub label: &'a str,
    pub value: &'a str,
}

pub fn build_rows<'a>(arena: &'a Bump, items: &[(u32, u32)]) -> Vec<Row<'a>> {
    // one String per label and value today; replace with arena allocations
    todo!()
}

fn main() {
    let arena = Bump::new();
    let rows = build_rows(&arena, &[(1, 10), (2, 20)]);
    // serialise rows, then reset the arena
}`,
        hint: "Use arena.alloc_str(&format!(...)) for each field; the temporary String is dropped immediately and only the arena copy survives. Serialise before resetting, because reset invalidates every borrow.",
        solution: `use bumpalo::Bump;

pub struct Row<'a> {
    pub label: &'a str,
    pub value: &'a str,
}

pub fn build_rows<'a>(arena: &'a Bump, items: &[(u32, u32)]) -> Vec<Row<'a>> {
    let mut rows = Vec::with_capacity(items.len());
    for (id, cents) in items {
        rows.push(Row {
            label: arena.alloc_str(&format!("item-{id}")),
            value: arena.alloc_str(&format!("{:.2}", *cents as f64 / 100.0)),
        });
    }
    rows
}

fn main() {
    let arena = Bump::with_capacity(16 * 1024);
    let rows = build_rows(&arena, &[(1, 1050), (2, 2099)]);

    // Serialise while the arena is still alive.
    let mut out = String::new();
    for row in &rows {
        out.push_str(row.label);
        out.push('=');
        out.push_str(row.value);
        out.push('\\n');
    }
    println!("{out}");

    // Every field is freed in one step once nothing borrows the arena.
    drop(rows);
    arena.reset();
}`
      },
      production: [
        "Per-request arenas are created and reset in the same scope, and never stored in a long-lived struct.",
        "Every channel, cache, and pool has a documented maximum and an overflow policy.",
        "RSS and allocated bytes are charted together, with an alert on growth rate.",
        "Shared payloads use Bytes instead of cloning Vec<u8>, with the refcount cost understood.",
        "Long-running services have a soak test that runs for hours and watches RSS."
      ],
      crates: ["bumpalo", "bytes", "mimalloc"],
      pitfall: "Storing a per-request arena in a struct that outlives the request: the arena is never reset, every request adds to it, and the process grows until it is killed.",
      questions: [
        {
          q: "Why is a bump arena faster than individual allocations?",
          options: [
            "It uses a faster memory type",
            "Allocation is a pointer bump and freeing is a single reset, with no per-object bookkeeping",
            "It bypasses the operating system entirely",
            "It compresses allocations in memory"
          ],
          answer: 1,
          explain: "The win is the absence of per-object allocator work, not the memory itself. The constraint is that nothing may outlive the reset."
        },
        {
          q: "What is the advantage of Bytes over cloning a Vec<u8>?",
          options: [
            "Bytes is always faster to mutate",
            "A Bytes clone is a refcount increment over shared memory, not a copy",
            "Bytes stores data on the stack",
            "Bytes avoids reference counting"
          ],
          answer: 1,
          explain: "Zero-copy sharing. The trade is that Bytes is immutable; mutation requires BytesMut or a copy."
        },
        {
          q: "A service's heap allocations are flat but RSS grows 2% per day. What is the likely explanation?",
          options: [
            "The allocator is leaking every allocation",
            "Fragmentation or retention: freed memory is not returned to the OS, often from mixed size classes",
            "RSS always grows and can be ignored",
            "The kernel is swapping"
          ],
          answer: 1,
          explain: "Live bytes and resident bytes diverge under fragmentation. Size classes, arenas never reset, and pools are the usual suspects."
        }
      ],
      quickbytes: [
        "Design by lifetime: arena for the request, preallocation for the process, Bytes for shared payloads.",
        "Reset arenas in the same scope that created them; a never-reset arena is a leak.",
        "Bound every pool and queue, and define what happens at the bound.",
        "Chart RSS against allocated bytes; the gap is fragmentation, not live data."
      ],
      github: [
        { name: "bumpalo - bump allocation arena", url: "https://github.com/fitzgen/bumpalo" },
        { name: "bytes - zero-copy byte buffers", url: "https://github.com/tokio-rs/bytes" }
      ],
      resources: [
        {
          title: "bumpalo documentation: arenas and reset",
          url: "https://docs.rs/bumpalo/latest/bumpalo/",
          kind: "docs"
        },
        {
          title: "bytes documentation: Bytes, BytesMut, and zero-copy",
          url: "https://docs.rs/bytes/latest/bytes/",
          kind: "docs"
        },
        {
          title: "mimalloc repository",
          url: "https://github.com/microsoft/mimalloc",
          kind: "repo"
        },
        {
          title: "InfoQ: memory management and allocator talks",
          url: "https://www.youtube.com/@InfoQ",
          kind: "video"
        }
      ]
    },
    {
      id: "pf18",
      n: 18,
      title: "The optimisation workflow: one change, one measurement",
      minutes: 75,
      level: "industry",
      goal: "Run optimisation as a disciplined loop - hypothesis, smallest change, measurement, keep or revert - and know when the remaining gain is not worth the complexity.",
      sections: [
        {
          h: "One change, one measurement",
          p: [
            "The loop is: define the metric, profile, state a hypothesis, make the smallest change that tests it, measure, keep or revert, commit with the numbers. The discipline is one variable at a time. Two changes in one commit cannot be attributed, and when one of them is a regression you keep both because the net looked positive.",
            "Write the hypothesis before the change: removing the per-request clone in parse should cut allocations by three per request and p99 by about a millisecond. A hypothesis that cannot be wrong is not a hypothesis, it is a wish, and it will be confirmed by a benchmark that measures nothing."
          ],
          list: [
            "State the metric and the expected direction before editing",
            "Change one thing; commit it separately with the before/after numbers",
            "If the result is neutral, revert it - dead complexity is a cost",
            "Re-profile after every accepted change; the bottleneck moves"
          ]
        },
        {
          h: "Correctness first, then speed",
          p: [
            "Run the test suite before and after, including property or fuzz tests around the hot path. An optimisation that changes behaviour on an edge case is a bug with a benchmark attached. Keep the benchmark in the same commit as the change so a later bisect can find the regression, and prefer changes that are obviously correct over changes that are clever."
          ]
        },
        {
          h: "Know when to stop",
          p: [
            "Every optimisation adds complexity that someone maintains. Stop when the remaining cost is below the noise floor, when the next change needs unsafe code for a few percent, or when the complexity would make the next bug harder to find. Write down what you did not do and why; that note is what stops the next engineer repeating the investigation."
          ],
          tip: "The best optimisation is often deletion: a feature nobody uses, a cache that never hits, a serialisation round trip that exists for historical reasons."
        },
        {
          h: "Make the workflow reproducible",
          p: [
            "Automate the comparison: check out the base commit, run the benchmark, check out the change, run it again, print the delta. critcmp compares saved criterion baselines and prints a side-by-side table; -t 5 hides differences of five percent or less, so the remaining rows are worth a human look. critcmp does not fail a build, so the pass/fail decision belongs in your own script, reading a small budget file your harness writes."
          ],
          code: `#!/usr/bin/env bash
set -euo pipefail

BASE="\${1:-main}"
BRANCH="\${2:-HEAD}"
OUT="target/bench-diff"
mkdir -p "$OUT"

git checkout "$BASE"
cargo bench --bench hot_path -- --save-baseline base | tee "$OUT/base.txt"

git checkout "$BRANCH"
cargo bench --bench hot_path -- --save-baseline branch | tee "$OUT/branch.txt"

# Side-by-side comparison; -t 5 hides differences of 5% or less.
critcmp base branch -t 5 | tee "$OUT/compare.txt"

# critcmp is a report, not a gate. The gate reads the numbers your harness
# records, so the metric and the threshold are explicit.
python3 - "$OUT/budget.json" <<'PY'
import json, sys

data = json.load(open(sys.argv[1]))
limit = data["max_regression_pct"]
failed = False

for metric, before in data["base"].items():
    after = data["branch"][metric]
    change = (after - before) / before * 100.0
    if change > limit:
        failed = True
    print(f"{metric}: {before:.3f} -> {after:.3f} ({change:+.1f}%)")

sys.exit(1 if failed else 0)
PY`,
          tip: "Run the script on the same machine in the same session; a laptop that moved between runs is a different experiment."
        }
      ],
      exercise: {
        prompt: "Write the workflow as a five-step checklist and a script that benchmarks a base commit and a branch, prints the comparison, and exits non-zero on a regression above 5%.",
        starter: `#!/usr/bin/env bash
set -euo pipefail

# 1. checkout base, run bench, save baseline "base"
# 2. checkout branch, run bench, save baseline "branch"
# 3. compare with critcmp
# 4. fail if a benchmark regressed more than 5%
# 5. print where the artefacts are`,
        hint: "cargo bench --bench <name> -- --save-baseline <name> on each side, then critcmp base branch -t 5 to see the meaningful rows. critcmp only reports, so write the pass/fail yourself over a budget.json built from the results.",
        solution: `#!/usr/bin/env bash
set -euo pipefail

BENCH="hot_path"
BASE="\${1:-main}"
BRANCH="\${2:-HEAD}"
OUT="target/bench-diff"
mkdir -p "$OUT"

echo "1. benchmarking base: $BASE"
git checkout "$BASE"
cargo bench --bench "$BENCH" -- --save-baseline base | tee "$OUT/base.txt"

echo "2. benchmarking branch: $BRANCH"
git checkout "$BRANCH"
cargo bench --bench "$BENCH" -- --save-baseline branch | tee "$OUT/branch.txt"

echo "3. comparing (only differences above 5%)"
critcmp base branch -t 5 | tee "$OUT/compare.txt"

echo "4. checking the regression threshold"
python3 - "$OUT/budget.json" <<'PY'
import json, sys

data = json.load(open(sys.argv[1]))
limit = data["max_regression_pct"]
failed = False

for metric, before in data["base"].items():
    after = data["branch"][metric]
    change = (after - before) / before * 100.0
    if change > limit:
        failed = True
    print(f"{metric}: {before:.3f} -> {after:.3f} ({change:+.1f}%)")

sys.exit(1 if failed else 0)
PY

echo "5. artefacts in $OUT"
echo "OK: no regression above threshold"

# budget.json is written by the harness after each run, for example:
#   {"max_regression_pct": 5.0,
#    "base":   {"p99_ms": 11.4, "rps": 810.0},
#    "branch": {"p99_ms": 10.1, "rps": 905.0}}
#
# Checklist before running this:
#   [ ] metric and hypothesis written in the PR
#   [ ] tests and fuzz targets pass on both commits
#   [ ] one change in the diff, not three
#   [ ] benchmark and change committed together
#   [ ] artefacts attached to the PR`
      },
      production: [
        "Each optimisation PR contains one change, a stated hypothesis, and before/after numbers.",
        "Benchmarks live in the same commit as the change they measure so bisect can find regressions.",
        "A neutral result is reverted rather than kept as harmless complexity.",
        "The comparison script runs on the same machine and session as both measurements.",
        "The PR records what was deliberately not optimised and why."
      ],
      crates: ["criterion", "critcmp", "iai-callgrind"],
      pitfall: "Bundling three optimisations into one commit: the net number looks good, one of the three is a regression, and nobody can tell which without redoing the work.",
      questions: [
        {
          q: "Why change one thing at a time?",
          options: [
            "Cargo recompiles faster that way",
            "Attribution: with several changes, a regression cannot be assigned to a cause",
            "Benchmarks refuse to run with multiple changes",
            "It reduces the number of tests needed"
          ],
          answer: 1,
          explain: "Measurement only answers questions about what changed. Several changes produce one number and no explanation."
        },
        {
          q: "A change measures neutral, within the noise floor, but the code is arguably cleaner. What should you do?",
          options: [
            "Keep it and claim a small win",
            "Revert it: unproven complexity is a cost, not a benefit",
            "Keep it and stop benchmarking",
            "Merge it and measure again next quarter"
          ],
          answer: 1,
          explain: "If it is not measurably faster, it must justify itself on clarity alone. Performance claims need evidence."
        },
        {
          q: "When is it reasonable to stop optimising?",
          options: [
            "When the profile has no frames left",
            "When the remaining cost is below the noise floor or the complexity outweighs the gain",
            "When the code is fully unsafe",
            "After three iterations, regardless of results"
          ],
          answer: 1,
          explain: "There is always a next frame. Stopping is a judgement about measurable gain versus maintenance cost."
        }
      ],
      quickbytes: [
        "Write the hypothesis and expected direction before editing; a claim you cannot falsify is a wish.",
        "Commit one change with its benchmark so a later bisect can attribute the regression.",
        "Revert neutral changes; complexity without a measured win is pure cost.",
        "Re-profile after each accepted change, because the bottleneck moves."
      ],
      github: [
        { name: "critcmp - compare criterion baselines", url: "https://github.com/BurntSushi/critcmp" },
        { name: "criterion.rs - saved baselines", url: "https://github.com/criterion-rs/criterion.rs" }
      ],
      resources: [
        {
          title: "criterion: save_baseline and retain_baseline",
          url: "https://docs.rs/criterion/latest/criterion/struct.Criterion.html",
          kind: "docs"
        },
        {
          title: "critcmp repository",
          url: "https://github.com/BurntSushi/critcmp",
          kind: "repo"
        },
        {
          title: "iai-callgrind: deterministic comparisons in CI",
          url: "https://docs.rs/iai-callgrind/latest/iai_callgrind/",
          kind: "docs"
        },
        {
          title: "InfoQ: performance engineering practice talks",
          url: "https://www.youtube.com/@InfoQ",
          kind: "video"
        }
      ]
    },
    {
      id: "pf19",
      n: 19,
      title: "Performance regression detection in CI",
      minutes: 105,
      level: "industry",
      goal: "Build a gate that catches real regressions without crying wolf: deterministic instruction counts, a documented noise floor, thresholds per metric, and a fast local path.",
      sections: [
        {
          h: "Wall-clock CI benchmarks are noisy by construction",
          p: [
            "A shared CI runner has variable CPU frequency, noisy neighbours, and often a different microarchitecture from production. Wall-clock benchmarks there produce numbers with 10-30% variance, so a gate either fires on noise or is set so loose it misses real regressions. The fix is to measure something deterministic, or to run on a dedicated pinned machine and accept a wider threshold.",
            "Instruction counts are deterministic in the sense that matters: the same binary on the same input executes the same instructions, regardless of turbo or neighbours. Valgrind's callgrind counts them, and iai-callgrind wraps callgrind in a Rust harness, so a hot function can be gated on a noisy runner."
          ]
        },
        {
          h: "A gate needs a metric, a threshold, and a noise floor",
          p: [
            "Decide what the gate protects: p99 from a load test, throughput from a ramp, instruction count for a hot function, or binary size. Then set the threshold above the measured noise floor - 5% is common for wall clock, 1-2% for instruction counts - and record the floor next to the threshold. A gate without a documented noise floor will be disabled by the third person who hits a false positive.",
            "Gates also need a scope. A deterministic micro-benchmark can block a merge; a full load test cannot run on every PR, so it belongs in a nightly job that alerts and opens an issue. Mixing the two produces a pipeline everyone learns to ignore."
          ],
          list: [
            "Blocking gate: deterministic, fast, on every PR",
            "Alerting gate: wall-clock or load test, nightly, on a pinned machine",
            "Threshold above the noise floor, with the floor written down",
            "Every failure links the benchmark name and the commit that caused it"
          ]
        },
        {
          h: "Deterministic micro-benchmarks with iai-callgrind",
          p: [
            "iai-callgrind runs the benchmark once under callgrind and reports instruction counts, cache behaviour, and estimated cycles. Because it counts instead of timing, it is stable across machines and load. The trade is speed: callgrind emulates the CPU, so a benchmark that takes milliseconds natively can take seconds, and it only means something for code whose cost is dominated by instructions rather than I/O."
          ],
          code: `# Cargo.toml
[dev-dependencies]
iai-callgrind = "0.16"

[[bench]]
name = "parse"
harness = false

# benches/parse.rs
use iai_callgrind::{library_benchmark, library_benchmark_group, main};
use std::hint::black_box;

fn parse(input: &str) -> usize {
    input.split(',').filter(|field| !field.is_empty()).count()
}

#[library_benchmark]
#[bench::small("a,b,c,d,e,f,g,h")]
fn bench_parse(input: &str) -> usize {
    black_box(parse(black_box(input)))
}

library_benchmark_group!(
    name = parse_group;
    benchmarks = bench_parse
);

main!(library_benchmark_groups = parse_group);`,
          tip: "iai-callgrind needs valgrind installed on the runner; check for it in the job and skip with a clear message rather than failing mysteriously."
        },
        {
          h: "Designing the gate so it survives",
          p: [
            "Run deterministic benchmarks on every PR, and wall-clock or load tests nightly against a stored baseline. Fail on deterministic regressions, alert on the noisy ones. Quarantine a flaky benchmark instead of deleting it, and never gate on a metric nobody can explain. Keep the gate fast enough to run locally - a gate that takes forty minutes will be bypassed by the people it is meant to protect."
          ]
        }
      ],
      exercise: {
        prompt: "Write a gate binary that reads two JSON files of instruction counts per benchmark, fails when any count grows by more than 2%, and prints a table with the deltas.",
        starter: `use serde_json::Value;
use std::collections::BTreeMap;
use std::process::ExitCode;

fn load(path: &str) -> BTreeMap<String, f64> {
    // read the file, parse an object of name -> count
    todo!()
}

fn main() -> ExitCode {
    // args: baseline.json candidate.json [limit_pct]
    // print each benchmark's delta, exit FAILURE if any exceeds the limit
    todo!()
}`,
        hint: "Parse with serde_json::Value, take as_object(), map each value with as_f64(). Compare (after - before) / before * 100 against the limit, and return ExitCode::FAILURE if anything exceeded it.",
        solution: `use serde_json::Value;
use std::collections::BTreeMap;
use std::process::ExitCode;

fn load(path: &str) -> BTreeMap<String, f64> {
    let text = std::fs::read_to_string(path).expect("read measurements");
    let json: Value = serde_json::from_str(&text).expect("valid json");
    json.as_object()
        .expect("object of benchmark -> count")
        .iter()
        .map(|(name, value)| {
            (name.clone(), value.as_f64().expect("numeric count"))
        })
        .collect()
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let base_path = args.next().expect("baseline.json");
    let candidate_path = args.next().expect("candidate.json");
    let limit = args
        .next()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(2.0);

    let base = load(&base_path);
    let candidate = load(&candidate_path);
    let mut failed = false;

    for (name, before) in &base {
        let Some(after) = candidate.get(name) else {
            println!("{name:40} missing from candidate");
            failed = true;
            continue;
        };
        let change = (after - before) / before * 100.0;
        if change > limit {
            failed = true;
        }
        println!("{name:40} {before:>14.0} -> {after:>14.0} ({change:+.2}%)");
    }

    if failed {
        eprintln!("regression above {limit:.1}%");
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}`
      },
      production: [
        "A deterministic benchmark blocks merges; wall-clock and load tests alert nightly.",
        "Each gate records its metric, threshold, and measured noise floor in the repository.",
        "CI checks for valgrind before running iai-callgrind and skips with a clear message.",
        "Flaky benchmarks are quarantined with an owner and a date, not silently deleted.",
        "Every gate failure names the benchmark, the delta, and the commit under test."
      ],
      crates: ["iai-callgrind", "criterion", "serde_json"],
      pitfall: "Gating on a single wall-clock run from a shared CI runner: the benchmark has 20% run-to-run variance, so the gate blocks unrelated PRs and gets disabled within a month.",
      questions: [
        {
          q: "Why are instruction counts more stable than wall-clock time on a shared CI runner?",
          options: [
            "Instructions execute faster than time passes",
            "They count work performed by the binary, which does not change with CPU frequency or neighbours",
            "Valgrind pins the process to a dedicated core",
            "Instruction counts are averaged over many runs"
          ],
          answer: 1,
          explain: "The same binary on the same input executes the same instructions. Time varies with frequency, contention, and thermal state."
        },
        {
          q: "A wall-clock benchmark regresses 2% while its noise floor is 15%. What is the correct action?",
          options: [
            "Block the merge and bisect",
            "Treat it as noise and do not block; a deterministic benchmark or a longer run is needed to resolve it",
            "Delete the benchmark",
            "Raise the threshold to 20% and forget it"
          ],
          answer: 1,
          explain: "A 2% signal inside a 15% noise band is unmeasurable. Either measure deterministically or accept that this gate cannot see it."
        },
        {
          q: "Why should a full load test not block every pull request?",
          options: [
            "Load tests are not reproducible",
            "They are too slow and too resource-hungry to run per PR, so they belong in a nightly job that alerts",
            "Load tests cannot detect regressions",
            "They require production credentials"
          ],
          answer: 1,
          explain: "Gate design is about feedback latency. Blocking gates must be fast; slower checks alert and open issues."
        }
      ],
      quickbytes: [
        "Gate merges on deterministic instruction counts; alert nightly on wall-clock and load-test numbers.",
        "Write the noise floor next to the threshold, or the gate will be disabled by false positives.",
        "Check for valgrind in CI and skip iai-callgrind explicitly when it is missing.",
        "Quarantine flaky benchmarks with an owner and a date instead of deleting them."
      ],
      github: [
        { name: "iai-callgrind (now Gungraun) - deterministic instruction-count benchmarks", url: "https://github.com/gungraun/gungraun" },
        { name: "criterion.rs - saved baselines for comparison", url: "https://github.com/criterion-rs/criterion.rs" }
      ],
      resources: [
        {
          title: "iai-callgrind: instruction counts and CI usage",
          url: "https://docs.rs/iai-callgrind/latest/iai_callgrind/",
          kind: "docs"
        },
        {
          title: "criterion: significance, noise threshold, and baselines",
          url: "https://docs.rs/criterion/latest/criterion/struct.Criterion.html",
          kind: "docs"
        },
        {
          title: "critcmp repository: comparing saved baselines",
          url: "https://github.com/BurntSushi/critcmp",
          kind: "repo"
        },
        {
          title: "InfoQ: CI performance gates and benchmarking practice",
          url: "https://www.youtube.com/@InfoQ",
          kind: "video"
        }
      ]
    },
    {
      id: "pf20",
      n: 20,
      title: "Cost-aware performance: performance per dollar",
      minutes: 90,
      level: "industry",
      goal: "Convert latency and throughput work into unit economics: cost per million requests, the utilisation multiplier, the big levers in order, and what happens to the capacity you save.",
      sections: [
        {
          h: "Performance is a price, not a score",
          p: [
            "The number that reaches a finance review is cost per request, not requests per second. Compute it as instance cost per hour divided by requests served per hour at the target utilisation, and include memory, storage, and egress. A 30% faster service on a 40% more expensive instance is a regression in unit economics even though the latency chart looks better.",
            "Utilisation is the multiplier. At 25% utilisation you pay four times the compute you use; at 60% you pay about 1.7 times. That is why right-sizing and consolidation often beat micro-optimisation on cost, and why an optimisation that lets you remove instances is worth more than one that merely lowers CPU by a few percent."
          ],
          list: [
            "Cost per million requests, at a stated utilisation",
            "Cost per active user, for consumer products",
            "Cost per GB processed or stored, for data workloads",
            "Egress and storage are often the surprise line items"
          ]
        },
        {
          h: "Levers, in order of size",
          p: [
            "Right-size first: match the instance shape to the binding resource, and prefer fewer larger instances when per-request overhead is high. Then price: committed use or savings plans for steady load, spot for batch, ARM instances where the workload allows. Then architecture: caching, compression, batching, and moving work off the request path. Then code: the micro-optimisations from earlier lessons, which matter most when they remove a whole instance class."
          ],
          tip: "An optimisation that removes 10% of CPU is worth 10% of the bill; one that lets you drop from 12 instances to 10 is worth two instances plus the headroom they carried."
        },
        {
          h: "Measure unit cost, not the bill",
          p: [
            "The bill moves with traffic, so it cannot tell you whether the service got more efficient. Track cost per 1,000 requests and cost per active user, computed from the same load test that produced the latency numbers: run the test, measure the resources consumed, divide. Include the cost of running the load test itself; a test that saturates the fleet for an hour is a line item."
          ],
          code: `#[derive(Debug, Clone, Copy)]
struct Instance {
    usd_per_hour: f64,
    vcpu: f64,
}

/// Cost in USD for one million requests at a given fleet size and rate.
fn cost_per_million(instance: Instance, instances: f64, rps: f64) -> f64 {
    let requests_per_hour = rps * 3600.0;
    (instance.usd_per_hour * instances) / requests_per_hour * 1_000_000.0
}

fn main() {
    let small = Instance { usd_per_hour: 0.085, vcpu: 2.0 };
    let big = Instance { usd_per_hour: 0.340, vcpu: 8.0 };

    // Same 24 vCPU in both fleets, same 3,000 requests per second.
    let small_cost = cost_per_million(small, 12.0, 3_000.0);
    let big_cost = cost_per_million(big, 4.0, 3_000.0);

    println!("12 x small: \${small_cost:.3}/M requests");
    println!(" 4 x big:   \${big_cost:.3}/M requests");
    println!(
        "per vCPU-hour: \${:.4} vs \${:.4}",
        small.usd_per_hour / small.vcpu,
        big.usd_per_hour / big.vcpu
    );

    // The big fleet costs more per vCPU here, so it only wins if it needs
    // fewer vCPU for the same work: less per-instance overhead and fewer
    // cross-instance calls. That is a measurement, not an assumption.
    assert!(big_cost > small_cost);
}`,
          tip: "Put cost per million on the same dashboard as p99. A latency win that raises unit cost should be a visible decision, not a side effect."
        },
        {
          h: "The Jevons trap",
          p: [
            "Faster code tends to be rewarded with more work, not a smaller bill: teams add features, raise limits, or keep the same fleet because there is headroom now. Cost-aware performance means deciding in advance what happens to the saved capacity - remove instances, raise the SLO, or absorb growth - and measuring the outcome. Otherwise the optimisation shows up as a better latency chart and an unchanged invoice."
          ]
        }
      ],
      exercise: {
        prompt: "A service uses 12 instances at 0.085 USD/hour serving 3,000 requests per second. A change cuts CPU per request by 30%, letting you drop to 9 instances. Compute cost per million before and after, and state the monthly saving.",
        starter: `fn cost_per_million(usd_per_hour: f64, instances: f64, rps: f64) -> f64 {
    // (usd_per_hour * instances) / (rps * 3600) * 1_000_000
    todo!()
}

fn main() {
    // before: 12 instances
    // after: 9 instances
    // print both and the monthly saving at sustained load
}`,
        hint: "Before: 0.085 x 12 = 1.02 USD/hour over 10.8M requests/hour, about 0.094 per million. After: 0.765 USD/hour, about 0.071 per million. The monthly saving is the hourly difference times 730 hours.",
        solution: `fn cost_per_million(usd_per_hour: f64, instances: f64, rps: f64) -> f64 {
    let requests_per_hour = rps * 3600.0;
    (usd_per_hour * instances) / requests_per_hour * 1_000_000.0
}

fn main() {
    let usd_per_hour = 0.085;
    let rps = 3_000.0;

    let before = cost_per_million(usd_per_hour, 12.0, rps);
    let after = cost_per_million(usd_per_hour, 9.0, rps);

    let hourly_before = usd_per_hour * 12.0;
    let hourly_after = usd_per_hour * 9.0;
    let monthly_saving = (hourly_before - hourly_after) * 730.0;

    println!("before: \${before:.3}/M");
    println!("after:  \${after:.3}/M");
    println!("saving: \${monthly_saving:.0}/month at sustained load");

    // A 25% fleet reduction is a 25% cost reduction, but the 30% CPU
    // improvement only translated into 25% fewer instances because of
    // headroom and rounding. Report the fleet change, not just the CPU win.
    assert!((before - 0.0944).abs() < 0.001);
    assert!((after - 0.0708).abs() < 0.001);
    assert!((monthly_saving - 186.15).abs() < 0.01);
}`
      },
      production: [
        "Cost per million requests is tracked next to p99 and reviewed with the same regularity.",
        "Instance shapes are chosen from a measured binding resource, not from habit.",
        "Committed-use and spot coverage are explicit, with the risk of interruption documented.",
        "Every performance change states what happens to the saved capacity.",
        "Egress, storage, and load-test costs are included in unit economics."
      ],
      crates: ["tokio", "metrics", "governor"],
      pitfall: "Optimising CPU while egress dominates the bill: the service gets faster, the invoice does not move, and the real cost driver was never on the performance dashboard.",
      questions: [
        {
          q: "A service runs at 25% average CPU utilisation. What does that imply about cost?",
          options: [
            "The service is efficient because CPU is idle",
            "You are paying for roughly four times the compute you actually use",
            "Idle CPU is free in the cloud",
            "Utilisation has no effect on cost per request"
          ],
          answer: 1,
          explain: "Cost per request scales with the inverse of utilisation. Consolidating or right-sizing is usually the largest single cost lever."
        },
        {
          q: "Why can a cheaper per-hour instance increase cost per request?",
          options: [
            "Cheaper instances cannot run Rust",
            "If it is slower per core, you need more instances or more time to serve the same work",
            "Pricing is per request, not per hour",
            "It cannot; the hourly price is the only variable"
          ],
          answer: 1,
          explain: "Unit economics divides by work done. A slower instance can cost more per request even at a lower hourly rate."
        },
        {
          q: "What is the Jevons trap in performance work?",
          options: [
            "Optimising code makes it harder to read",
            "Efficiency gains are absorbed by more work, so the bill does not fall",
            "Faster services attract more traffic than they can handle",
            "Costs rise linearly with request count"
          ],
          answer: 1,
          explain: "Saved capacity gets spent on new features or higher limits unless someone decides otherwise. Decide in advance and measure."
        }
      ],
      quickbytes: [
        "Report cost per million requests, not just CPU percentage; utilisation is the multiplier.",
        "Right-size and consolidate before micro-optimising; the levers are ordered by size.",
        "An optimisation that removes instances is worth more than one that lowers CPU by a few percent.",
        "Decide what happens to saved capacity before shipping the optimisation."
      ],
      github: [
        { name: "tokio - measuring per-request cost", url: "https://github.com/tokio-rs/tokio" },
        { name: "metrics - counters and histograms for unit economics", url: "https://github.com/metrics-rs/metrics" }
      ],
      resources: [
        {
          title: "AWS Well-Architected: cost optimization pillar",
          url: "https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html",
          kind: "docs"
        },
        {
          title: "Amazon EC2 instance types: sizing and families",
          url: "https://docs.aws.amazon.com/ec2/latest/instancetypes/instance-types.html",
          kind: "docs"
        },
        {
          title: "Kubernetes horizontal pod autoscaling",
          url: "https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/",
          kind: "docs"
        },
        {
          title: "metrics - counters and histograms for unit-cost dashboards",
          url: "https://github.com/metrics-rs/metrics",
          kind: "repo"
        },
        {
          title: "InfoQ: cloud cost and performance engineering talks",
          url: "https://www.youtube.com/@InfoQ",
          kind: "video"
        }
      ]
    }
  ]
};
