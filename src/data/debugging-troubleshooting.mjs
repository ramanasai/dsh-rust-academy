/**
 * Debugging & troubleshooting track.
 *
 * Tool versions used across the lessons: tracing 0.1.x (attributes feature),
 * tracing-subscriber 0.3.x (env-filter, reload), console-subscriber 0.5.x
 * (tokio-console), tokio 1.x (tracing feature + tokio_unstable cfg),
 * loom 0.7.x, criterion 0.5.x, pprof 0.14.x. Sanitizer flags and gdb/core(5)
 * behaviour verified against the Rust Unstable Book and man-pages 6.19.
 *
 * Data is JSON-compatible and consumed by the plugin build.
 */
export default {
  "key": "debugging-troubleshooting",
  "prefix": "dg",
  "title": "Debugging & troubleshooting",
  "blurb": "A repeatable method for hard bugs: reproduce, bisect, observe, isolate, fix and prevent regressions.",
  "level": "industry",
  "project": {
    "title": "Capstone: diagnose a production incident",
    "brief": "An injected failure is running against a checkout service: intermittent 5xx under load, only on one canary, with no obvious log line. Work it end to end as an incident: stabilise, reproduce it outside production, bisect to the introducing change, prove the mechanism, fix it, add a guard that fails on the old code, then write the postmortem and the runbook delta a colleague could act on at 3am.",
    "deliverables": [
      "A reproducer under tests/repro/ that fails on demand with a pinned clock, seed, config hash and flag snapshot, plus a ddmin log showing the shrunk input.",
      "A git bisect transcript with endpoints, skipped commits and the parent/culprit confirmation runs.",
      "A root cause analysis naming trigger, latent conditions and detection gap, with the mechanism encoded as a failing assertion.",
      "A fix with a regression test proven to fail on the parent commit, plus a class-level guard (property test, fuzz target or chart assertion).",
      "A postmortem with a timestamped timeline and dated action items, and a runbook change reviewed by the on-call who was paged."
    ],
    "stack": [
      "tracing",
      "tracing-subscriber",
      "console-subscriber",
      "tokio",
      "criterion",
      "pprof",
      "loom",
      "proptest"
    ]
  },
  "lessons": [
    {
      "id": "dg01",
      "n": 1,
      "title": "The debugging method: one falsifiable hypothesis at a time",
      "minutes": 60,
      "level": "core",
      "goal": "Run debugging as a loop of observation, falsifiable hypothesis and cheapest discriminating experiment, and keep a written record that makes the next experiment obvious.",
      "sections": [
        {
          "h": "A hypothesis predicts something you have not observed yet",
          "p": [
            "Debugging stalls when the work becomes guessing rather than searching. A useful hypothesis is a sentence that predicts an observation you do not have: if the retry path re-applies the discount, then replaying the same idempotency key must produce a total that is exactly one discount lower than the first response. If nothing you could observe would prove the sentence wrong, it is a belief, and no amount of reading code will settle it.",
            "The experiment should be the cheapest one that discriminates between hypotheses, not the one that confirms your favourite. Reading code is cheap but weak evidence: you are reading the code you wrote, not the code that ran. Changing one log line to WARN and replaying the failing request is still cheap and much stronger. Save the debugger, the sanitizer and the record-replay session for hypotheses that survived the cheap rounds."
          ]
        },
        {
          "h": "Write four artifacts before touching code",
          "p": [
            "Every bug needs a repro command, the observed versus expected behaviour, an environment fingerprint, and a timeline. The fingerprint is the part teams skip: commit hash, binary build id, feature-flag snapshot, config checksum, runtime version, host class, and whether the process was a canary. Without it, a bug that only appears on one of twelve pods turns into a debate about whose terminal is haunted.",
            "The timeline is what turns correlation into evidence. Record first seen, last known good, the deploy that sits between them, and the traffic shape at the time. Two timestamps and one deploy marker eliminate more search space than an hour of code reading, because they tell you which axis - version, config, traffic - can even be responsible."
          ],
          "list": [
            "Repro: one command, no manual steps, finishes in under two minutes",
            "Expected versus actual: exact strings, status codes or numbers, never the word broken",
            "Fingerprint: commit, build id, flag snapshot, config hash, host class",
            "Timeline: first seen, last known good, and every change in between"
          ],
          "tip": "If you cannot paste the repro into a terminal on another machine and watch it fail, you do not have one yet."
        },
        {
          "h": "Bisect the search space, not the source file",
          "p": [
            "A bug hides in one of four spaces: input, version, configuration, or time. Rank candidate experiments by information gained per minute, not by how clever they feel. Halving the configuration space usually costs a restart and rules out entire classes of cause; reading a 900-line module costs an hour and rules out nothing until you finish it.",
            "A factorial sweep over the knobs that differ between a working and a broken environment is the fastest way to shrink a config-space bug. Four booleans is sixteen runs. If one knob flips the outcome alone you are done; if only a pair flips it, you have found an interaction that no single-variable test would have shown, which is itself the diagnosis."
          ],
          "code": `// src/bin/knobs.rs - which environment knob flips the failure?
use std::process::Command;

const KNOBS: [(&str, &str, &str); 4] = [
    ("CACHE_TTL", "0", "300"),
    ("BATCH_SIZE", "1", "64"),
    ("PARALLELISM", "1", "8"),
    ("PRICER_V2", "0", "1"),
];

fn fails_with(overrides: &[(&str, &str)]) -> bool {
    let mut cmd = Command::new("./target/release/checkout");
    for (name, default, _) in KNOBS {
        cmd.env(name, default);
    }
    for (name, value) in overrides {
        cmd.env(name, value);
    }
    !cmd.status().expect("spawn checkout").success()
}

fn main() {
    let mut minimal: Option<Vec<(&str, &str)>> = None;
    for mask in 1u32..(1 << KNOBS.len()) {
        let overrides: Vec<(&str, &str)> = KNOBS
            .iter()
            .enumerate()
            .filter(|(i, _)| mask & (1 << i) != 0)
            .map(|(_, (name, _, other))| (*name, *other))
            .collect();
        if fails_with(&overrides) {
            println!("flips with {overrides:?}");
            if minimal.as_ref().is_none_or(|m| overrides.len() < m.len()) {
                minimal = Some(overrides);
            }
        }
    }
    println!("minimal flipping set: {minimal:?}");
}`,
          "tip": "Sixteen runs of a two-minute repro beats one hour of reading; the sweep also produces the log you attach to the ticket."
        }
      ],
      "exercise": {
        "prompt": "A checkout endpoint returns 500 only on the eu-west canary, only above 200 rps, and only since Tuesday's deploy. Write the order you will run experiments in and encode a config-space sweep over the three knobs you can toggle at runtime without a deploy.",
        "starter": `// src/bin/knobs.rs
// 1. Order the axes by cost: replay one request, then version, then config, then rate.
// 2. Sweep only the knobs that differ between canary and stable.
const KNOBS: [(&str, &str, &str); 3] = [
    ("CACHE_TTL", "0", "300"),
    ("BATCH_SIZE", "1", "64"),
    ("PRICER_V2", "0", "1"),
];

fn fails_with(overrides: &[(&str, &str)]) -> bool {
    todo!("spawn the binary with defaults, then apply overrides")
}

fn main() {
    todo!("enumerate the 7 non-empty subsets and print the minimal flipping set")
}`,
        "hint": "Cut time first: replay a recorded request and see whether it fails at all. Then version: does the stable fleet fail with the canary config? Config sweep before rate, because a load generator costs far more per run than a restart.",
        "solution": `// src/bin/knobs.rs - cheapest-first experiment order, then a factorial sweep.
use std::process::Command;

// Axis order, cheapest first:
// 1. time    - replay one recorded request; does it fail outside production?
// 2. version - run the stable image with the canary's config map.
// 3. config  - the sweep below; a restart per run, seconds each.
// 4. rate    - only if 1-3 are clean; needs a load generator and is slow.
const KNOBS: [(&str, &str, &str); 3] = [
    ("CACHE_TTL", "0", "300"),
    ("BATCH_SIZE", "1", "64"),
    ("PRICER_V2", "0", "1"),
];

fn fails_with(overrides: &[(&str, &str)]) -> bool {
    let mut cmd = Command::new("./target/release/checkout");
    for (name, default, _) in KNOBS {
        cmd.env(name, default);
    }
    for (name, value) in overrides {
        cmd.env(name, value);
    }
    !cmd.status().expect("spawn checkout").success()
}

fn main() {
    let mut minimal: Option<Vec<(&str, &str)>> = None;
    for mask in 1u32..(1 << KNOBS.len()) {
        let overrides: Vec<(&str, &str)> = KNOBS
            .iter()
            .enumerate()
            .filter(|(i, _)| mask & (1 << i) != 0)
            .map(|(_, (name, _, other))| (*name, *other))
            .collect();
        let failed = fails_with(&overrides);
        println!("{overrides:?} -> failed={failed}");
        if failed && minimal.as_ref().is_none_or(|m| overrides.len() < m.len()) {
            minimal = Some(overrides);
        }
    }
    match minimal {
        Some(set) => println!("minimal flipping set: {set:?}"),
        None => println!("no config combination flips it: look at version or rate"),
    }
}`
      },
      "production": [
        "Every incident channel gets a pinned card with repro, expected/actual, fingerprint and timeline.",
        "Reproducers live in scripts/repro/ and tests/repro/, versioned with the code, never in a chat message.",
        "On-call runs one injected-bug game day per quarter and must produce a written repro before touching the code.",
        "Every alert links to the runbook section that lists the first three hypotheses for that symptom."
      ],
      "crates": [
        "tracing",
        "anyhow",
        "clap"
      ],
      "pitfall": "Starting with a theory and reading code until it fits. The theory feels productive because it is familiar, but it produces no observation, so two engineers can hold opposite theories for an hour without either being refuted.",
      "questions": [
        {
          "q": "Which sentence is a falsifiable debugging hypothesis rather than a belief?",
          "options": [
            "If the retry reuses the idempotency key, replaying one request must double the discount",
            "The cache is probably stale somewhere in the checkout path",
            "This code looks wrong and probably causes the timeouts",
            "It is most likely a race condition under load"
          ],
          "answer": 0,
          "explain": "Only the idempotency claim names an observation that could come out otherwise. The others predict nothing specific, so no experiment can refute them and the discussion has no exit."
        },
        {
          "q": "You have two candidate experiments: one takes two minutes and halves the configuration space, the other takes ninety minutes and would confirm your leading theory. Which first?",
          "options": [
            "Neither; read the suspect module until the cause is obvious",
            "The two-minute one, because it halves the space regardless of which theory is right",
            "Both in parallel, so the slower one finishes sooner",
            "The confirming one, so you do not waste time on the wrong area"
          ],
          "answer": 1,
          "explain": "Halving the space is useful under every hypothesis; confirming one theory is only useful if it happens to be correct, and running it first anchors everyone on it."
        },
        {
          "q": "Why does the environment fingerprint matter more than the stack trace for an intermittent bug?",
          "options": [
            "It lets you skip the reproducer entirely",
            "Stack traces are always incomplete in release builds",
            "It separates pods, builds and flag states, so a one-of-twelve difference becomes visible instead of anecdotal",
            "It is required by the incident process"
          ],
          "answer": 2,
          "explain": "The fingerprint is what makes works-on-my-machine falsifiable. A trace from a healthy pod proves nothing; a fingerprint diff between healthy and unhealthy pods names the axis to bisect."
        }
      ],
      "quickbytes": [
        "Write the hypothesis as a prediction, then design the cheapest experiment that could prove it wrong.",
        "Cut the config space before the source file: a sixteen-run sweep is cheaper than an hour of reading.",
        "Record the fingerprint and the timeline in the ticket before you open the editor."
      ],
      "github": [
        {
          "name": "git/git - the bisect and pickaxe implementations used by every version search",
          "url": "https://github.com/git/git"
        },
        {
          "name": "sharkdp/hyperfine - timing experiments with warmup and outlier detection",
          "url": "https://github.com/sharkdp/hyperfine"
        }
      ],
      "resources": [
        {
          "title": "The Cargo Book: profiles, debug info and reproducible builds",
          "url": "https://doc.rust-lang.org/cargo/reference/profiles.html",
          "kind": "docs"
        },
        {
          "title": "git/git - bisect documentation in the source tree",
          "url": "https://github.com/git/git",
          "kind": "repo"
        },
        {
          "title": "sharkdp/hyperfine - command-line benchmarking tool",
          "url": "https://github.com/sharkdp/hyperfine",
          "kind": "repo"
        },
        {
          "title": "fasterthanlime: long-form Rust debugging and internals videos",
          "url": "https://www.youtube.com/@fasterthanlime",
          "kind": "video"
        }
      ]
    },
    {
      "id": "dg02",
      "n": 2,
      "title": "Building a reproducer that fails on demand",
      "minutes": 75,
      "level": "core",
      "goal": "Turn a bug report into a single command that fails every time, then shrink its input mechanically so the remaining state is small enough to reason about.",
      "sections": [
        {
          "h": "Faithful first, minimal second",
          "p": [
            "A bug report describes a symptom in a running system; a reproducer is a program that exhibits the same failure with no human in the loop. The first cut does not need to be small, only faithful: replay the recorded request, pin the reported commit, and confirm the failure appears without the customer present. Minimality comes later, because a reduced case that no longer fails costs more than it saves.",
            "Prefer a test over a script. A #[test] runs under the same harness as the regression guard you will eventually ship, supports --nocapture for output, and can be selected by name in CI. When the failure needs a process boundary - signals, working directory, environment - use an integration test that spawns the binary instead of calling the function directly."
          ],
          "list": [
            "One command, no manual steps, non-zero exit on the failure",
            "Deterministic: run it ten times, get ten failures",
            "Self-contained: no shared staging database, no wall-clock dependency",
            "Named after the bug so the eventual fix can cite it"
          ],
          "tip": "If the reproducer needs a database, make the test create and drop its own schema; a shared fixture will be the next flake."
        },
        {
          "h": "Delta debugging: let the machine shrink the input",
          "p": [
            "Hand-shrinking is biased: you delete what looks irrelevant, which is exactly the part you do not yet understand. Delta debugging replaces judgement with an oracle. You hand it a list of input elements and a function that says whether the current subset still fails, and it splits and removes chunks, converging in a logarithmic number of runs on a 1-minimal input where deleting any single element stops the failure.",
            "The oracle is the hard part. It must be cheap, deterministic, and must not confuse did not fail with did not run: a build error or a timeout is neither. Return a three-state answer and treat unknown as a skip, or the minimizer will happily delete the line that makes the crash reachable and hand you a case that no longer reproduces."
          ],
          "code": `// Minimal ddmin. \`oracle\` returns Some(true) when the subset still reproduces,
// Some(false) when it does not, and None when the answer is unknown (skip).
pub fn ddmin<T: Clone>(input: &[T], oracle: &mut dyn FnMut(&[T]) -> Option<bool>) -> Vec<T> {
    let mut current = input.to_vec();
    let mut granularity = 2usize;
    while current.len() >= 2 {
        let chunk = current.len().div_ceil(granularity);
        let mut reduced = false;
        for start in (0..current.len()).step_by(chunk) {
            let end = (start + chunk).min(current.len());
            let mut candidate = Vec::with_capacity(current.len() - (end - start));
            candidate.extend_from_slice(&current[..start]);
            candidate.extend_from_slice(&current[end..]);
            if oracle(&candidate) == Some(true) {
                current = candidate;
                granularity = granularity.saturating_sub(1).max(2);
                reduced = true;
                break;
            }
        }
        if !reduced {
            if granularity >= current.len() {
                break;
            }
            granularity = (granularity * 2).min(current.len());
        }
    }
    current
}`,
          "tip": "Count oracle calls in the log. If the shrink takes more calls than there are elements, the oracle is probably answering unknown too often."
        },
        {
          "h": "Freeze everything the failure depends on",
          "p": [
            "A reproducer is only a reproducer if the environment is part of it. Pin the RNG seed, the timezone and locale, the wall clock if the code reads it, the worker-thread count, the feature-flag snapshot and the config hash. Anything you cannot pin, inject: a Clock trait with a fixed implementation beats a comment that says run this at 3am.",
            "Then make the failure loud. Assert on the exact value that is wrong, not on a log line that happens to contain it; a test that greps stdout passes when the format changes and fails when logging is disabled. The assertion message should contain the input, so a red CI run explains itself without anyone opening the code."
          ],
          "code": `// tests/repro_4412.rs - fails 10/10 on the reported commit.
use std::time::{Duration, UNIX_EPOCH};

#[test]
fn repro_4412_discount_applied_twice_on_retry() {
    // Pinned: fixed clock, no RNG, one thread, config hash in the fixture.
    let cfg = Config::from_toml(include_str!("fixtures/cfg-4412.toml")).unwrap();
    let clock = Clock::fixed(UNIX_EPOCH + Duration::from_secs(1_700_000_000));
    let mut svc = Checkout::new(cfg, clock);

    let key = IdempotencyKey::from("retry-4412");
    let first = svc.place(order(1, 10_000), &key);
    let second = svc.place(order(1, 10_000), &key);

    assert_eq!(first, second, "replay of {key:?} changed the response");
    assert_eq!(second.total_minor, 9_000, "10% discount must apply exactly once");
}`,
          "tip": "A test that only passes with RUST_LOG set is not a reproducer; it is a script with a superstition."
        }
      ],
      "exercise": {
        "prompt": "A failing request carries 300 log lines and the parser only errors when two specific lines are both present. Implement ddmin over a Vec of lines with a three-state oracle, and report how many oracle calls the shrink took compared with testing each line by hand.",
        "starter": `// src/bin/shrink.rs
fn reproduces(lines: &[&str]) -> Option<bool> {
    // Some(true)  -> still fails
    // Some(false) -> does not fail
    // None        -> could not decide (empty input, harness error)
    todo!()
}

fn ddmin(lines: &[&str]) -> Vec<&str> {
    todo!("copy the ddmin loop and call reproduces")
}

fn main() {
    let lines: Vec<&str> = include_str!("../fixtures/4412.log").lines().collect();
    let minimal = ddmin(&lines);
    println!("{} lines -> {} lines: {minimal:?}", lines.len(), minimal.len());
}`,
        "hint": "The oracle returns None for an empty slice, Some(false) when the parser succeeds, and Some(true) only when it returns the specific UnexpectedEof error. A different error is also None, not false.",
        "solution": `// src/bin/shrink.rs - shrink a 300-line failing log to the two lines that matter.
fn reproduces(lines: &[&str]) -> Option<bool> {
    if lines.is_empty() {
        return None; // nothing to run: unknown, never "does not fail"
    }
    match parse_config(lines) {
        Ok(_) => Some(false),
        Err(ParseError::UnexpectedEof) => Some(true),
        Err(_other) => None, // a different failure is not evidence either way
    }
}

fn ddmin(lines: &[&str]) -> (Vec<&str>, usize) {
    let mut calls = 0usize;
    let mut oracle = |candidate: &[&str]| {
        calls += 1;
        reproduces(candidate)
    };
    let mut current: Vec<&str> = lines.to_vec();
    let mut granularity = 2usize;
    while current.len() >= 2 {
        let chunk = current.len().div_ceil(granularity);
        let mut reduced = false;
        for start in (0..current.len()).step_by(chunk) {
            let end = (start + chunk).min(current.len());
            let mut candidate = Vec::with_capacity(current.len() - (end - start));
            candidate.extend_from_slice(&current[..start]);
            candidate.extend_from_slice(&current[end..]);
            if oracle(&candidate) == Some(true) {
                current = candidate;
                granularity = granularity.saturating_sub(1).max(2);
                reduced = true;
                break;
            }
        }
        if !reduced {
            if granularity >= current.len() {
                break;
            }
            granularity = (granularity * 2).min(current.len());
        }
    }
    (current, calls)
}

fn main() {
    let lines: Vec<&str> = include_str!("../fixtures/4412.log").lines().collect();
    let (minimal, calls) = ddmin(&lines);
    println!("{} lines -> {} lines in {calls} oracle calls", lines.len(), minimal.len());
    for line in &minimal {
        println!("  {line}");
    }
}`
      },
      "production": [
        "Reproducers live in tests/repro/ and merge before the fix; a P1 without one is not allowed to close.",
        "Every reproducer pins clock, seed, thread count and config hash in code, not in a README.",
        "A nightly job re-runs open P1 reproducers so a fix cannot silently stop reproducing.",
        "Input shrinking uses a three-state oracle; a build failure or timeout is a skip, never a negative."
      ],
      "crates": [
        "proptest",
        "arbitrary",
        "tempfile"
      ],
      "pitfall": "Shrinking by hand until the case stops failing, then declaring the bug unreproducible. The deleted element was the trigger, and the team loses a day rediscovering it.",
      "questions": [
        {
          "q": "What does a 1-minimal input from ddmin actually guarantee?",
          "options": [
            "It is the smallest possible failing input",
            "It compiles faster than the original input",
            "It is the shortest input that still parses",
            "Removing any single remaining element stops the failure"
          ],
          "answer": 3,
          "explain": "1-minimality is local: no single deletion preserves the failure. Smaller multi-element subsets may still exist, which is why a second pass with a different chunking sometimes finds more."
        },
        {
          "q": "Your oracle returns Some(false) when the project fails to build. What goes wrong?",
          "options": [
            "It deletes elements whose removal only broke the build, and converges on a case that no longer reproduces",
            "It reports the build error as the root cause",
            "Nothing; a build failure means the input is irrelevant",
            "The minimizer runs forever because false is absorbing"
          ],
          "answer": 0,
          "explain": "A build failure is not evidence about the bug. Treating it as does not fail teaches the minimizer to prefer broken inputs, and the final case is a compile error rather than the original failure."
        },
        {
          "q": "Why is a #[test] usually a better reproducer than a shell script that curls a service?",
          "options": [
            "Tests always reproduce concurrency bugs",
            "It runs in the same harness as the regression guard, is selectable by name, and cannot drift from the code",
            "Tests are faster to write than shell scripts",
            "Shell scripts cannot set environment variables"
          ],
          "answer": 1,
          "explain": "The reproducer and the eventual guard should be the same artifact. A curl script lives outside the build, drifts from the code, and has to be rewritten as a test later."
        }
      ],
      "quickbytes": [
        "Faithful then minimal: a big reproducer that fails beats a small one that does not.",
        "Three-state oracle (fails, passes, unknown) or the minimizer will eat your trigger.",
        "Pin clock, seed, threads, flags and config hash inside the reproducer, not beside it."
      ],
      "github": [
        {
          "name": "proptest-rs/proptest - shrinking failure cases automatically",
          "url": "https://github.com/proptest-rs/proptest"
        },
        {
          "name": "nextest-rs/nextest - per-test process isolation and filtering",
          "url": "https://github.com/nextest-rs/nextest"
        }
      ],
      "resources": [
        {
          "title": "WDD: Weighted Delta Debugging (ICSE 2025)",
          "url": "https://arxiv.org/abs/2411.19410",
          "kind": "paper"
        },
        {
          "title": "proptest-rs/proptest - property testing with automatic shrinking",
          "url": "https://github.com/proptest-rs/proptest",
          "kind": "repo"
        },
        {
          "title": "nextest-rs/nextest - a next-generation test runner for Rust",
          "url": "https://github.com/nextest-rs/nextest",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "dg03",
      "n": 3,
      "title": "git bisect: turning a commit range into one culprit",
      "minutes": 70,
      "level": "core",
      "goal": "Automate a binary search over history with a trustworthy predicate, handle commits that cannot be tested, and confirm the named commit before believing it.",
      "sections": [
        {
          "h": "Bisect needs an oracle, not an opinion",
          "p": [
            "git bisect is a binary search over commits and it is exactly as good as the predicate you feed it. The predicate must exit 0 for good, 1 for bad, and 125 for cannot decide. That last code matters: a commit that fails to compile is not evidence of the bug, and marking it bad poisons the search by pushing the reported culprit toward the build break.",
            "Automate the loop with git bisect run. It removes the two failure modes that ruin manual bisects: bias about which commit looks guilty, and transcription errors when a human types good and bad forty times. Write the two endpoints as full hashes into the log before you start, so the transcript is self-contained when you attach it to the ticket."
          ],
          "code": `#!/usr/bin/env bash
# scripts/repro.sh - exit 0 good, 1 bad, 125 skip (cannot decide)
set -uo pipefail

if ! cargo build --quiet --bin checkout 2>/dev/null; then
  exit 125                       # broken build is not evidence
fi

cargo test --quiet --test repro_4412 -- --exact repro_4412_discount >/dev/null 2>&1
status=$?
case $status in
  0)   exit 0 ;;                 # bug absent at this commit
  101) exit 1 ;;                 # bug present: the test failed
  *)   exit 125 ;;               # harness error, timeout, missing fixture
esac`,
          "tip": "cargo test exits 101 on failure, not 1. Mapping it explicitly is what keeps the 125 path for real ambiguity."
        },
        {
          "h": "Skip, good, bad and the four states",
          "p": [
            "Real histories are not clean. Merge commits, dependency bumps that break the build, and commits that need a service you do not have all produce cannot decide. Bisect handles that: exit 125 skips the commit and continues, and at the end it reports the adjacent commits it could not test. If every remaining candidate was skipped, the answer is a range, which is still a useful answer.",
            "After bisect names a commit, confirm it. Check out the parent and the culprit and run the reproducer on both; a bisect that skipped twenty commits can land one commit off. Then read the diff with the reproducer state in mind, because the goal is a mechanism you can explain, not a hash you can blame."
          ],
          "list": [
            "Record both endpoints as full hashes before the first step",
            "Exit 125 for broken builds, missing fixtures and timeouts",
            "Bisect a tag range, not a branch that other people are pushing to",
            "Re-run the reproducer on the parent and the named commit before believing it"
          ]
        },
        {
          "h": "Bisecting axes other than commits",
          "p": [
            "The same search works on anything ordered: which of forty feature flags, which of twelve config keys, which release image. The trick is to turn the axis into an ordered list and the predicate into a script. git bisect start -- <path> restricts the search to commits touching a directory, a cheap prior when the suspect subsystem is already known.",
            "Performance regressions are the exception that needs care: the predicate is statistical, not binary, so a plain bisect chases noise and names an innocent commit. Either make the measurement deterministic with a fixed input and a pinned CPU, or run three times and compare the median against a threshold, and accept that the output is a range rather than a single commit."
          ],
          "code": `# A reproducible session, recorded as evidence.
git bisect start
git bisect bad  v1.9.0
git bisect good v1.8.0
git bisect run ./scripts/repro.sh 2>&1 | tee bisect-4412.log

# Restrict the search to the subsystem you already suspect.
git bisect start -- crates/checkout

# For a performance bisect, rename the terms so the log reads correctly.
git bisect start --term-old=fast --term-new=slow
git bisect slow  v1.9.0
git bisect fast  v1.8.0
git bisect run ./scripts/bench_gate.sh --threshold 0.10`,
          "tip": "git bisect log prints the replayable script of the session; paste it into the ticket instead of a screenshot of the terminal."
        }
      ],
      "exercise": {
        "prompt": "The bug only reproduces when a fixture database exists, and half the range fails to compile on the current toolchain. Write scripts/repro.sh so a missing database or a broken build is a skip and only a genuine test failure is a bad verdict.",
        "starter": `#!/usr/bin/env bash
# scripts/repro.sh
set -uo pipefail

# 1. bail out to 125 when the fixture database is missing
# 2. bail out to 125 when the build fails
# 3. run the reproducer and map 0 -> good, 101 -> bad, everything else -> skip`,
        "hint": "Check the fixture before building, so a missing database does not cost a full compile. Use `pg_isready -q` or a plain connection attempt, and return 125 rather than 1 on failure.",
        "solution": `#!/usr/bin/env bash
# scripts/repro.sh - exit 0 good, 1 bad, 125 skip.
set -uo pipefail

DB_URL=\${REPRO_DB_URL:-postgres://localhost/repro_4412}

# A missing fixture is ambiguity, not a verdict.
if ! psql "$DB_URL" -c "select 1" >/dev/null 2>&1; then
  echo "skip: fixture database unavailable at $DB_URL" >&2
  exit 125
fi

if ! cargo build --quiet --bin checkout 2>/dev/null; then
  echo "skip: build failed at $(git rev-parse --short HEAD)" >&2
  exit 125
fi

# Timeouts are ambiguity too: a hung run says nothing about this commit.
timeout 120 cargo test --quiet --test repro_4412 -- --exact repro_4412_discount >/dev/null 2>&1
status=$?
case $status in
  0)   exit 0 ;;
  101) exit 1 ;;
  124) echo "skip: reproducer timed out" >&2; exit 125 ;;
  *)   echo "skip: harness error $status" >&2; exit 125 ;;
esac`
      },
      "production": [
        "Every P1 ships a scripts/repro.sh that exits 0/1/125 and is used verbatim by git bisect run.",
        "Bisect transcripts (endpoints, skips, named commit, confirmation runs) are attached to the ticket.",
        "CI keeps a rolling job that builds the last fifty commits so a bisect is never blocked by an unbuildable commit.",
        "Performance bisects use a median of three runs and a threshold; single-run gates are rejected in review."
      ],
      "crates": [
        "criterion",
        "cargo-nextest",
        "anyhow"
      ],
      "pitfall": "Marking a commit that fails to compile as bad. The search narrows toward the build break, the named commit is innocent, and the real change sits outside the range you then stop investigating.",
      "questions": [
        {
          "q": "git bisect run exits 125. What does bisect do with that commit?",
          "options": [
            "Marks it bad and continues on the older half",
            "Aborts the session and prints the current commit",
            "Skips it, tests adjacent commits, and reports the range it could not resolve",
            "Marks it good to keep the search balanced"
          ],
          "answer": 2,
          "explain": "125 is the skip signal. Bisect tries the neighbours and, if every remaining candidate is untestable, reports a range instead of a single commit."
        },
        {
          "q": "You marked a non-compiling commit as bad. What is the practical result?",
          "options": [
            "Nothing, because a bad commit is still a bad commit",
            "Bisect reports two culprits, one for each failure",
            "Bisect detects the build failure and corrects itself",
            "The reported culprit is likely the build break, and the real change may be excluded"
          ],
          "answer": 3,
          "explain": "Bisect has no way to distinguish your bug from a compile error. Every commit after the build break looks bad, so the search converges on the break, not the regression."
        },
        {
          "q": "Why must the two endpoints be recorded as full hashes rather than tag names?",
          "options": [
            "Tags can be moved or re-pointed, so the transcript stops reproducing what you actually tested",
            "Bisect requires at least one hash endpoint",
            "Tags are not supported by git bisect",
            "Full hashes make the search faster"
          ],
          "answer": 0,
          "explain": "A moved tag silently changes the range. Recording hashes means the transcript can be replayed months later and produces the same commits."
        }
      ],
      "quickbytes": [
        "git bisect run ./scripts/repro.sh, never forty manual good/bad verdicts.",
        "Exit 125 for broken builds, missing fixtures and timeouts; only a real test failure is 1.",
        "Confirm the named commit against its parent before writing the RCA."
      ],
      "github": [
        {
          "name": "git/git - bisect and pickaxe implementation",
          "url": "https://github.com/git/git"
        },
        {
          "name": "nextest-rs/nextest - deterministic test selection for bisect predicates",
          "url": "https://github.com/nextest-rs/nextest"
        }
      ],
      "resources": [
        {
          "title": "git/git - bisect documentation lives in Documentation/git-bisect.adoc",
          "url": "https://github.com/git/git",
          "kind": "repo"
        },
        {
          "title": "nextest-rs/nextest - per-test filtering and retries",
          "url": "https://github.com/nextest-rs/nextest",
          "kind": "repo"
        },
        {
          "title": "Weighted Delta Debugging: systematic input and history reduction (ICSE 2025)",
          "url": "https://arxiv.org/abs/2411.19410",
          "kind": "paper"
        }
      ]
    },
    {
      "id": "dg04",
      "n": 4,
      "title": "Reading panics, backtraces and panic hooks",
      "minutes": 65,
      "level": "core",
      "goal": "Decode what a panic actually contains, keep usable backtraces in release builds, and install a hook that reports one structured event with context instead of two half-messages.",
      "sections": [
        {
          "h": "What a panic actually contains",
          "p": [
            "A panic carries a payload (usually a &str or String), a location captured at the panic site, and an unwinding decision. The location is only useful when the panic came from your code: Option::unwrap reports the caller's line thanks to #[track_caller], which is why the message points at your .unwrap() and not at core::option. That is also why expect with a message carrying the data beats unwrap in anything you will debug later.",
            "Unwinding is a policy, not a detail. With panic = abort in the release profile a panic kills the process with no chance to run a hook that flushes logs; with unwind, a panic inside a spawned task is caught by the runtime and only surfaces if you join the handle. Neither choice is wrong, but it decides whether production gives you a backtrace at all."
          ],
          "code": `# Cargo.toml - keep the information that makes a panic diagnosable.
[profile.release]
debug = "line-tables-only"   # file and line in backtraces, small size cost
strip = "none"               # strip later, in the image layer, if at all
panic = "unwind"             # abort loses the chance to flush and report

# src/main.rs
// Prefer expect() with the data that makes the failure explainable.
let total = line_items
    .iter()
    .try_fold(0i64, |acc, item| acc.checked_add(item.total_minor))
    .expect("order total overflowed i64: too many line items");

// #[track_caller] makes your own helper report the caller's line.
#[track_caller]
pub fn parse_qty(raw: &str) -> u32 {
    raw.parse().expect("quantity must be an unsigned integer")
}`,
          "tip": "A panic message without the offending value is a puzzle; expect(&format!(...)) is fine when the branch is already broken."
        },
        {
          "h": "Backtraces that survive release",
          "p": [
            "RUST_BACKTRACE=1 prints a backtrace for the panicking thread and full adds the frames between the hook and your code. Symbols come from the binary, so a stripped image gives addresses and offsets - still enough to symbolize offline with the build id, if you kept the unstripped binary. Keep one of the two: ship symbols as a sidecar keyed by build id, or build with debug = line-tables-only.",
            "Backtrace::force_capture() gives you a backtrace as data rather than as stderr text, which is what you want in a structured error report. Capture it at the boundary where request context still exists, not deep inside a library, and put it in the error payload the caller logs. A backtrace captured after the stack unwound is worth nothing."
          ]
        },
        {
          "h": "A panic hook that adds context and stops double printing",
          "p": [
            "std::panic::set_hook replaces the default printer. In a service the default writes to stderr with no trace id, no span fields and no routing, so a panic is the one log line you cannot search. A hook can read the current tracing span, emit one structured error with the location and payload, and capture a backtrace while the stack still exists.",
            "Two traps. The hook runs while panicking, so it must not panic: avoid unwrap, avoid taking a lock a panicking thread might hold, and keep formatting small. And if you install it alongside a subscriber, decide who prints - keep the previous hook and you get every panic twice, which makes log-based alerting count double."
          ],
          "code": `use std::backtrace::Backtrace;
use std::panic::PanicHookInfo;

pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info: &PanicHookInfo<'_>| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown".to_string());
        let payload = info.payload_as_str().unwrap_or("<non-string payload>");

        tracing::error!(
            panic.location = %location,
            panic.payload = %payload,
            panic.thread = ?std::thread::current().id(),
            span.id = tracing::Span::current().id().map(|id| id.into_u64()).unwrap_or_default(),
            backtrace = %Backtrace::force_capture(),
            "panic"
        );

        // Opt-in only: printing twice breaks log-based alerting counts.
        if std::env::var_os("RUST_PANIC_PRINT").is_some() {
            previous(info);
        }
    }));
}`,
          "tip": "Log the panic at ERROR with a stable event name so an alert can match on it; a free-text message is not alertable."
        }
      ],
      "exercise": {
        "prompt": "Install a panic hook that emits one structured event with the panic location, payload, thread id and span id, suppresses the default printer, and captures a backtrace only when RUST_BACKTRACE is set.",
        "starter": `use std::panic::PanicHookInfo;

pub fn install() {
    // 1. take the previous hook so you can opt back into it
    // 2. read info.location() and info.payload_as_str()
    // 3. capture a backtrace conditionally
    todo!()
}`,
        "hint": "Backtrace::force_capture() is cheap enough to always take when the environment asks for it, and expensive enough that you should not take it unconditionally in a hot service.",
        "solution": `use std::backtrace::Backtrace;
use std::panic::PanicHookInfo;

pub fn install() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info: &PanicHookInfo<'_>| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown".to_string());
        let payload = info.payload_as_str().unwrap_or("<non-string payload>");
        let want_backtrace = std::env::var_os("RUST_BACKTRACE").is_some();

        let backtrace = want_backtrace.then(|| Backtrace::force_capture().to_string());

        tracing::error!(
            panic.location = %location,
            panic.payload = %payload,
            panic.thread = ?std::thread::current().id(),
            span.id = tracing::Span::current().id().map(|id| id.into_u64()).unwrap_or_default(),
            backtrace = backtrace.as_deref().unwrap_or("<disabled: set RUST_BACKTRACE=1>"),
            "panic"
        );

        if std::env::var_os("RUST_PANIC_PRINT").is_some() {
            previous(info);
        }
    }));
}`
      },
      "production": [
        "Release builds keep line tables or a sidecar symbol file keyed by build id; nothing ships fully stripped without one.",
        "Services install a hook that logs exactly one structured panic event with location, payload, thread id and span id.",
        "panic = abort is only used where a supervisor restarts the process and no in-process flush is needed.",
        "Library crates return Result; panics are reserved for invariants the caller cannot reasonably handle."
      ],
      "crates": [
        "eyre",
        "color-eyre",
        "tracing"
      ],
      "pitfall": "Shipping strip = symbols with no sidecar, then reading a production panic that contains only addresses and module offsets - a backtrace that costs an afternoon to symbolize and may not match the binary at all.",
      "questions": [
        {
          "q": "Why does Option::unwrap report a line in your own code rather than inside core?",
          "options": [
            "Because unwrap is generic and gets inlined",
            "Because unwrap is marked #[track_caller], so the panic location is the caller's call site",
            "Because debug builds keep the full core source",
            "Because the panic hook rewrites the location"
          ],
          "answer": 1,
          "explain": "#[track_caller] threads the caller location through, which is why the reported file and line point at your .unwrap() and why your own helpers should use it too."
        },
        {
          "q": "What does debug = line-tables-only give you that strip = symbols removes?",
          "options": [
            "Faster runtime performance",
            "The ability to attach a debugger at all",
            "File and line information for symbolized backtraces",
            "Variable values for every frame"
          ],
          "answer": 2,
          "explain": "Line tables map addresses to file and line without variable or type detail. Stripping symbols discards the names, leaving offsets that need an external symbol file."
        },
        {
          "q": "A panic hook calls a function that panics. What happens?",
          "options": [
            "The panic payload is replaced by the hook's panic",
            "The second panic is logged and the process continues",
            "The hook is uninstalled and the default printer takes over",
            "The runtime aborts the process immediately (panic while panicking)"
          ],
          "answer": 3,
          "explain": "A panic during unwinding or inside the panic hook is a double panic and aborts. Keep the hook allocation-light and lock-free for exactly this reason."
        }
      ],
      "quickbytes": [
        "expect() with the offending value beats unwrap() with no message, every time.",
        "RUST_BACKTRACE=full plus line tables turns a production panic into a file and line.",
        "One panic event, one logger: keep the default hook only behind an env var or your counts double."
      ],
      "github": [
        {
          "name": "eyre-rs/eyre - error reports with context and backtraces",
          "url": "https://github.com/eyre-rs/eyre"
        },
        {
          "name": "tokio-rs/tracing - events, spans and the subscriber pipeline",
          "url": "https://github.com/tokio-rs/tracing"
        }
      ],
      "resources": [
        {
          "title": "The Cargo Book: the debug setting and what each level keeps",
          "url": "https://doc.rust-lang.org/cargo/reference/profiles.html",
          "kind": "docs"
        },
        {
          "title": "eyre-rs/eyre - context-rich error reports",
          "url": "https://github.com/eyre-rs/eyre",
          "kind": "repo"
        },
        {
          "title": "tokio-rs/tracing - tracing documentation and guides",
          "url": "https://github.com/tokio-rs/tracing",
          "kind": "repo"
        },
        {
          "title": "gdb(1) - examining a program that stopped, including at a core file",
          "url": "https://man7.org/linux/man-pages/man1/gdb.1.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "dg05",
      "n": 5,
      "title": "Logging versus tracing: choosing the instrument",
      "minutes": 60,
      "level": "core",
      "goal": "Pick events or spans based on the question being asked, design fields that are queryable, and change verbosity at runtime without a redeploy.",
      "sections": [
        {
          "h": "Events and spans answer different questions",
          "p": [
            "A log line answers what happened at this instant. A span answers which unit of work this was and how long it took. tracing gives you both from one macro family: info! emits an event, #[instrument] opens a span around a function and records its arguments as fields. The span is what makes a line attributable when forty requests are in flight on the same worker thread.",
            "Choose by question, not by habit. Why did this request fail is a span question with an event attached; how many retries happened last hour is a metric question; which code path ran is a span-structure question. A printed line per step gives a transcript with no boundaries, which is exactly why println! debugging collapses as soon as concurrency enters the picture."
          ],
          "code": `use tracing::{info, instrument, warn};

#[instrument(skip_all, fields(order.id = %order.id, order.total = order.total_minor))]
pub async fn charge(order: &Order, client: &Payments) -> Result<Receipt, ChargeError> {
    info!(attempt = 1, "charging");
    match client.authorize(order).await {
        Ok(receipt) => {
            info!(auth = %receipt.auth_id, "authorized");
            Ok(receipt)
        }
        Err(err) if err.is_retryable() => {
            warn!(error = %err, "authorization retryable, backing off");
            Err(ChargeError::Retryable(err))
        }
        Err(err) => {
            warn!(error = %err, "authorization rejected");
            Err(ChargeError::Permanent(err))
        }
    }
}`,
          "tip": "One span per unit of work, one event per state transition. If a function logs three events but opens no span, the events have no parent."
        },
        {
          "h": "Field design decides whether you can search",
          "p": [
            "A message string is for humans; fields are for queries. Record the identifiers you will filter by - order id, tenant, route, status code, attempt - and keep the prose short. Never put a secret or a raw payload in a field: logs are the most copied artifact in an incident, and the copy usually lands somewhere with weaker access control.",
            "skip_all followed by explicit fields is the safe default for functions with large arguments. The default #[instrument] records every argument with Debug, so a handler that takes a request body writes the whole body into every span it creates - a megabyte per call at INFO, plus a formatting cost that shows up in the profile. Skipping is also the only way to instrument an argument that does not implement Debug."
          ]
        },
        {
          "h": "Turning verbosity up without a redeploy",
          "p": [
            "EnvFilter parses RUST_LOG-style directives: warn,checkout=debug,tower=off. Combined with tracing_subscriber::reload, the filter handle can be swapped at runtime, which is how you get debug output for one subsystem during an incident without restarting the process or drowning in output from everything else.",
            "Directive syntax goes further than per-crate levels: checkout[charge{order.id=4412}]=trace enables TRACE only inside a span named charge whose field matches. That is the cheapest targeted debugging instrument in Rust, and it costs nothing until a directive matches. Guard the reload path like any other admin action: it is a remote verbosity control on a production process."
          ],
          "code": `use tracing_subscriber::{fmt, prelude::*, reload, EnvFilter};

type Handle = reload::Handle<EnvFilter, tracing_subscriber::Registry>;

pub fn init() -> Handle {
    let (filter, handle) = reload::Layer::new(
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
    );
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(true))
        .init();
    handle
}

/// Swap the live filter, e.g. "checkout[charge{order.id=4412}]=trace".
pub fn set_verbosity(handle: &Handle, directive: &str) -> Result<(), Box<dyn std::error::Error>> {
    handle.modify(|filter| {
        *filter = EnvFilter::new(directive);
    })?;
    Ok(())
}`,
          "tip": "Keep the previous filter string so a reload can be reverted in one call; an operator who cannot undo a verbosity change will leave it on."
        }
      ],
      "exercise": {
        "prompt": "Add a reloadable filter to a service and expose set_verbosity so an operator can enable TRACE for one order id without a restart, then revert to the previous directive in one call.",
        "starter": `use tracing_subscriber::{reload, EnvFilter};

pub fn init() -> reload::Handle<EnvFilter, tracing_subscriber::Registry> {
    todo!("build a reload::Layer, install the subscriber, return the handle")
}

pub fn set_verbosity(
    handle: &reload::Handle<EnvFilter, tracing_subscriber::Registry>,
    directive: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    todo!()
}`,
        "hint": "reload::Layer::new returns a tuple of (layer, handle). Store the last directive in a Mutex<String> next to the handle so revert does not need the caller to remember it.",
        "solution": `use std::sync::Mutex;
use tracing_subscriber::{fmt, prelude::*, reload, EnvFilter};

pub struct Verbosity {
    handle: reload::Handle<EnvFilter, tracing_subscriber::Registry>,
    previous: Mutex<String>,
}

pub fn init() -> Verbosity {
    let initial = std::env::var("RUST_LOG").unwrap_or_else(|_| "info".to_string());
    let (filter, handle) = reload::Layer::new(EnvFilter::new(&initial));
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(true))
        .init();
    Verbosity {
        handle,
        previous: Mutex::new(initial),
    }
}

impl Verbosity {
    /// e.g. "checkout[charge{order.id=4412}]=trace"
    pub fn set(&self, directive: &str) -> Result<(), Box<dyn std::error::Error>> {
        let mut previous = self.previous.lock().expect("verbosity mutex poisoned");
        self.handle.modify(|filter| {
            *filter = EnvFilter::new(directive);
        })?;
        *previous = directive.to_string();
        Ok(())
    }

    pub fn revert(&self) -> Result<(), Box<dyn std::error::Error>> {
        let previous = self.previous.lock().expect("verbosity mutex poisoned").clone();
        self.handle.modify(|filter| {
            *filter = EnvFilter::new(&previous);
        })?;
        Ok(())
    }
}`
      },
      "production": [
        "One structured event per state transition, with identifiers in span fields and no payloads in messages.",
        "The log filter is reloadable at runtime and the reload path is authenticated and audited.",
        "INFO is a budget: a request path emitting more than five INFO events is a review finding.",
        "No println! in library crates; CI greps for it and fails the build."
      ],
      "crates": [
        "tracing",
        "tracing-subscriber",
        "tracing-appender"
      ],
      "pitfall": "Using #[instrument] without skip_all on a handler that takes a large request body: every span now carries a serialized payload, log volume explodes, and the formatting cost lands on the request path.",
      "questions": [
        {
          "q": "Which instrument answers how long the payment call took inside one specific request?",
          "options": [
            "A span around the call, whose recorded duration is attached to that request's trace",
            "An info! event emitted before and after the call",
            "A counter metric incremented per call",
            "A debug! line containing the elapsed milliseconds"
          ],
          "answer": 0,
          "explain": "A span carries duration and parentage, so the time is attributable to that request. An event with elapsed time in the message is a string that no query can aggregate."
        },
        {
          "q": "What does #[instrument(skip_all, fields(order.id = %id))] record?",
          "options": [
            "Nothing, because skip_all disables the span",
            "Only order.id, with all other arguments skipped",
            "The order id as a Debug string only",
            "Every argument, plus the order id"
          ],
          "answer": 1,
          "explain": "skip_all drops every argument and the explicit fields list adds back just the values you want. The % sigil records the value through Display rather than Debug."
        },
        {
          "q": "Why is println! debugging misleading in an async service?",
          "options": [
            "It cannot print values that implement Debug",
            "It is slower than tracing in every case",
            "Output from concurrent tasks interleaves with no span context, and blocking stdout distorts the timing you are trying to observe",
            "It does not compile inside async functions"
          ],
          "answer": 2,
          "explain": "You get a transcript with no boundaries, and the act of writing to a blocking stdout handle can change the scheduling you are investigating."
        }
      ],
      "quickbytes": [
        "Spans for where the time went, events for what happened, metrics for how often.",
        "skip_all then explicit fields; the default records every argument with Debug.",
        "checkout[charge{order.id=4412}]=trace is the cheapest targeted debug switch in Rust."
      ],
      "github": [
        {
          "name": "tokio-rs/tracing - the tracing ecosystem",
          "url": "https://github.com/tokio-rs/tracing"
        },
        {
          "name": "tokio-rs/tokio - runtime that emits the spans the console consumes",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "resources": [
        {
          "title": "tracing crate documentation",
          "url": "https://docs.rs/tracing/latest/tracing/",
          "kind": "docs"
        },
        {
          "title": "tracing-subscriber EnvFilter directive syntax",
          "url": "https://docs.rs/tracing-subscriber/latest/tracing_subscriber/filter/struct.EnvFilter.html",
          "kind": "docs"
        },
        {
          "title": "tracing::instrument - fields, skip, ret and err",
          "url": "https://docs.rs/tracing/latest/tracing/attr.instrument.html",
          "kind": "docs"
        },
        {
          "title": "tokio-rs/tracing repository",
          "url": "https://github.com/tokio-rs/tracing",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "dg06",
      "n": 6,
      "title": "Debuggers: breakpoints that answer a question",
      "minutes": 85,
      "level": "advanced",
      "goal": "Build a binary you can actually step through, use conditional breakpoints and command scripts to sample state, and attach to a live process without stopping it longer than necessary.",
      "sections": [
        {
          "h": "Debug info is the product; the debugger is just the reader",
          "p": [
            "A debugger shows you what the compiler decided to keep. With debug = 0 you get function names and little else; with line tables you get file and line; with full debug info you get variables, types and inlining records. Optimized builds also reorder and merge code, so a breakpoint on a line may fire three times or never, and a variable may read as optimized out.",
            "Practical recipe: keep a dev or custom debug profile for stepping, and a release build with line tables for the bugs that only appear optimized. rust-gdb and rust-lldb wrap the system debugger with pretty-printers for Vec, HashMap, String and enums, which turns p *ptr from an unreadable struct dump into something you can reason about in seconds."
          ],
          "code": `# A profile you can step through: optimized enough to keep timing honest,
# unoptimized enough that variables survive.
[profile.debug-rel]
inherits = "release"
debug = 2
lto = false

# Build and attach with the pretty-printers loaded:
#   cargo build --profile debug-rel
#   rust-gdb --args ./target/debug-rel/checkout --order 4412
#   (rust-lldb is the same wrapper for LLDB)`,
          "tip": "If a variable reads optimized out, rebuild at opt-level 1 rather than 0: most of the speed stays and the variable usually comes back."
        },
        {
          "h": "Conditional breakpoints and command scripts",
          "p": [
            "A breakpoint that fires ten thousand times is useless. break checkout.rs:88 if order_id == 4412 fires once. Better, attach a command list: silent to suppress the stop banner, printf to print two fields, bt for a short stack, continue to keep running. That turns the debugger into a programmable sampler and keeps you in the terminal instead of adding log lines and rebuilding.",
            "Watchpoints are the other half: watch -l order.total_minor stops when that memory changes, which is how you find the writer when six functions could be responsible. They are slow, because hardware watchpoints cover a handful of addresses, so use them on one suspect field rather than on a whole struct."
          ],
          "code": `# gdb.cmds - run with: gdb -x gdb.cmds --args ./target/debug-rel/checkout
set pagination off
set print pretty on
set print elements 32

break checkout.rs:88 if order_id == 4412
commands
  silent
  printf "hit order=%llu attempt=%d", order_id, attempt
  bt 6
  continue
end

# Stop when the suspect field is written, and show who wrote it.
watch -l order.total_minor
commands
  silent
  bt 8
  continue
end

run`,
          "tip": "Put the script in scripts/gdb/ and commit it. A hang diagnosed from a remembered incantation is diagnosed differently by the next person."
        },
        {
          "h": "Post-mortem: attaching to a live process",
          "p": [
            "gdb -p <pid> stops the process, which is why it is a production hazard: every thread freezes while you look. Use -batch with an -ex list so the stop lasts milliseconds, and prefer the two commands that answer most hang questions: thread apply all bt for what every thread is doing, and info threads for who is running versus waiting.",
            "Attaching needs ptrace permission: same uid, or CAP_SYS_PTRACE, and in Kubernetes a container with SYS_PTRACE and a shared PID namespace. If you cannot attach, the fallbacks are a core dump via gcore, a stack dump you built into the binary behind a signal, or perf and eBPF sampling that never stops the world."
          ],
          "code": `# Snapshot every thread's stack in one short, non-interactive stop.
PID=$(pgrep -f 'checkout --profile debug-rel' | head -1)
gdb -p "$PID" -batch \
  -ex "set pagination off" \
  -ex "set print thread-events off" \
  -ex "info threads" \
  -ex "thread apply all bt 12" \
  -ex "detach" 2>&1 | tee "stacks-$PID.txt"

# Same idea, but stop at the faulting frame and read state.
gdb -p "$PID" -batch \
  -ex "set pagination off" \
  -ex "thread apply all bt 4" \
  -ex "thread 1" \
  -ex "frame 2" \
  -ex "info locals" \
  -ex "info registers rip rsp" \
  -ex "detach"

# For a hang you can reproduce locally, record and replay instead:
#   rr record ./target/debug-rel/checkout --order 4412
#   rr replay   # deterministic, backwards-capable gdb session`,
          "tip": "Always detach before quitting: a killed gdb can leave the inferior stopped, and a frozen pod fails its liveness probe."
        }
      ],
      "exercise": {
        "prompt": "A request hangs only for order 4412 and only on the second attempt. Write a gdb command file that stops only on that order and attempt, prints the retry counter and a short backtrace, and continues automatically.",
        "starter": `# gdb.cmds
set pagination off

# 1. break on the retry loop with a compound condition
# 2. add a commands block that prints attempt and a short backtrace
# 3. continue so the run finishes and you collect every hit
run`,
        "hint": "Conditions can combine: if order_id == 4412 && attempt == 2. If attempt is optimized away, break on the retry function instead and read the argument.",
        "solution": `# gdb.cmds - only the second attempt for one order.
set pagination off
set print pretty on

break checkout.rs:88 if order_id == 4412 && attempt == 2
commands
  silent
  printf "order=%llu attempt=%d", order_id, attempt
  printf " key=%s", idempotency_key
  bt 8
  continue
end

run

# If the condition never fires in an optimized build, fall back to the
# function entry, where the arguments are still in registers:
#   break checkout::retry::attempt
#   commands
#     silent
#     info args
#     bt 4
#     continue
#   end`
      },
      "production": [
        "One build per release keeps line tables or a sidecar symbol file, and the debug profile is reproducible from the tag.",
        "gdb command files live in scripts/gdb/ so a hang is diagnosed the same way by everyone.",
        "Attaching to production needs the same approval as a deploy, a named pod, a batch command and a time box.",
        "A debug image variant is pre-built with gdb, perf and matching symbols so nothing is installed during an incident."
      ],
      "crates": [
        "gimli",
        "addr2line",
        "backtrace"
      ],
      "pitfall": "Setting a breakpoint on a line in an optimized build and concluding the code never runs because the breakpoint never fires: inlining moved the code and the line has no distinct address.",
      "questions": [
        {
          "q": "A breakpoint on a source line never fires in a release build, though the code clearly runs. What is the most likely explanation?",
          "options": [
            "The debugger cannot debug Rust binaries",
            "The binary was compiled with panic = abort",
            "Symbols were stripped, so no breakpoint can ever fire",
            "Inlining and reordering gave that line no distinct address, so the breakpoint landed elsewhere or nowhere"
          ],
          "answer": 3,
          "explain": "Optimized builds merge and move code. Break on the function instead, use rbreak, or rebuild at a lower opt-level where the line keeps its own address."
        },
        {
          "q": "What does thread apply all bt answer that a plain bt does not?",
          "options": [
            "It shows what every thread is doing, which is what a hang or deadlock question actually asks",
            "It prints the heap layout",
            "It lists loaded shared libraries",
            "It shows local variables for every frame"
          ],
          "answer": 0,
          "explain": "A single bt shows one thread, usually the one that stopped. For a hang you need all of them at the same instant to see the wait cycle."
        },
        {
          "q": "Why is gdb -p on a production pod riskier than reading its traces?",
          "options": [
            "It disables the tracing subscriber",
            "It freezes every thread for the duration, which can blow latency budgets and trip liveness probes",
            "It requires a rebuild of the binary",
            "It corrupts the process memory"
          ],
          "answer": 1,
          "explain": "ptrace stops the whole process. A batch snapshot of a few milliseconds is usually survivable; an interactive session on live traffic is not."
        }
      ],
      "quickbytes": [
        "break file:line if cond plus a commands block turns gdb into a sampler.",
        "watch -l field finds the writer; use it on one field, not a struct.",
        "gdb -p PID -batch -ex 'thread apply all bt' -ex detach is the safe production snapshot."
      ],
      "github": [
        {
          "name": "rust-lang/rust - ships the rust-gdb and rust-lldb pretty-printer wrappers",
          "url": "https://github.com/rust-lang/rust"
        },
        {
          "name": "llvm/llvm-project - LLDB and llvm-symbolizer",
          "url": "https://github.com/llvm/llvm-project"
        }
      ],
      "resources": [
        {
          "title": "gdb(1) - the GNU debugger manual page",
          "url": "https://man7.org/linux/man-pages/man1/gdb.1.html",
          "kind": "docs"
        },
        {
          "title": "The Cargo Book: debug info levels and split-debuginfo",
          "url": "https://doc.rust-lang.org/cargo/reference/profiles.html",
          "kind": "docs"
        },
        {
          "title": "llvm/llvm-project - LLDB source and symbolizer",
          "url": "https://github.com/llvm/llvm-project",
          "kind": "repo"
        },
        {
          "title": "rust-lang/rust - rust-gdb, rust-lldb and std pretty-printers",
          "url": "https://github.com/rust-lang/rust",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "dg07",
      "n": 7,
      "title": "Core dumps and minidumps: debugging a corpse",
      "minutes": 80,
      "level": "advanced",
      "goal": "Make a crashed process leave a usable dump, open it with the matching binary, and know when a compact minidump is enough and when you need the full core.",
      "sections": [
        {
          "h": "Why the core you expected is not there",
          "p": [
            "A core dump is a file the kernel writes on a fatal signal, and there are a dozen reasons it is not written: RLIMIT_CORE is zero, the working directory is not writable, the process is setuid, the filesystem is full, or core_pattern pipes dumps to a handler you did not know about. Containers make every one of those worse, because the limit is inherited from the runtime and the dump lands in the container's ephemeral filesystem.",
            "Check the knobs before the crash, not after: ulimit -c unlimited in the entrypoint, cat /proc/sys/kernel/core_pattern, and coredumpctl list on a systemd host. In Kubernetes a dump written inside the pod disappears with the pod, so pipe it to a host path or a collector, and make sure the node has room for a file the size of your RSS."
          ],
          "code": `# Entrypoint: allow a dump and put it somewhere durable.
ulimit -c unlimited
cat /proc/sys/kernel/core_pattern        # what the host does with cores

# Traditional pattern (needs privileges to change):
#   echo "/var/crash/core.%e.%p.%t" > /proc/sys/kernel/core_pattern

# systemd hosts collect dumps themselves:
coredumpctl list | tail -3
coredumpctl dump 2955 -o /tmp/core

# Open it with the exact binary that produced it.
gdb ./target/release/checkout /tmp/core \
  -batch -ex "info threads" -ex "thread apply all bt 20"`,
          "tip": "core_pattern with a leading pipe sends the dump to a program, and RLIMIT_CORE is then ignored - which is why raising ulimit changes nothing on those hosts."
        },
        {
          "h": "A core is only as good as the binary",
          "p": [
            "The dump contains memory and register state, not symbols. You must open it with the exact binary that produced it, and gdb warns when the build id does not match. Ship one of: the unstripped binary, a .debug sidecar, or a debuginfod server keyed by build id. Without one of those you have addresses and a linker map, which is a slow afternoon.",
            "Reading a core follows a fixed order: info threads, thread apply all bt, pick the faulting thread, then frame N and info locals. For a deadlock the interesting frames are the ones blocked in futex or pthread_cond_wait; for a memory bug they are wherever the corrupted pointer was read, which is often not where it was corrupted."
          ]
        },
        {
          "h": "Minidumps: crash reporting for a fleet",
          "p": [
            "A minidump is a compact crash file: thread stacks, register sets, the module list with build ids, and a stream of annotations, without the heap. That makes it small enough to upload from a user machine and complete enough to symbolize later. The minidump crate parses the format, and rust-minidump ships a processor that turns one into a symbolized stack trace.",
            "The trade-off is explicit: you get stacks and module versions, not variable state. For the bugs where the stack is the answer - null dereference, abort, stack overflow - that is a good deal. For a corrupted invariant you still need a core or a targeted log. Either way, archive the symbol files for every shipped build keyed by build id, or the dumps you collect are unreadable."
          ],
          "code": `# A crash reporter that only keeps what it needs: stacks + modules, no heap.
# The minidump crate parses the file; minidump-processor symbolizes it
# against the symbol files archived at build time.
#
# CI, per release:
#   cargo build --profile release-with-debug
#   objcopy --only-keep-debug checkout checkout.debug
#   aws s3 cp checkout.debug s3://symbols/checkout/$BUILD_ID.debug
#
# On the crash path: write the minidump, upload, drop the file.
# On the analysis side:
#   minidump-stackwalk crash.dmp --symbols-url s3://symbols/ --human`,
          "tip": "A minidump without a symbol server is a hex dump with a version string; the symbol archive is the actual crash-reporting system."
        }
      ],
      "exercise": {
        "prompt": "A canary panics twice a week and the pod is replaced within seconds. Write the entrypoint lines that make a core land outside the container, and the batch gdb invocation that extracts the panicking thread's stack from it.",
        "starter": `#!/usr/bin/env bash
# entrypoint.sh
set -euo pipefail

# 1. raise the core limit
# 2. point core_pattern at a host-mounted path
# 3. start the binary with exec so signals reach it`,
        "hint": "core_pattern is a host setting; set it in the node bootstrap or a privileged init container, not in the app container. Mount /var/crash from the host so the file survives the pod.",
        "solution": `#!/usr/bin/env bash
# entrypoint.sh - the pod writes cores to a hostPath mount.
set -euo pipefail

ulimit -c unlimited
mkdir -p /var/crash

# Host-side bootstrap (DaemonSet or node init), not this container:
#   echo "/var/crash/core.%e.%p.%t" > /proc/sys/kernel/core_pattern
# Kubernetes: mount hostPath /var/crash into this pod at /var/crash.

echo "core limit: $(ulimit -c) pattern: $(cat /proc/sys/kernel/core_pattern)"
exec ./checkout --config /etc/checkout/config.toml

# After the crash, on the node:
#   gdb ./checkout /var/crash/core.checkout.4412.1770000000 \\
#     -batch -ex "set pagination off" \\
#            -ex "info threads" \\
#            -ex "thread apply all bt 20"
#
# Then confirm the binary matches the dump:
#   gdb -batch -ex "info proc" -ex "core-file /var/crash/core.checkout.4412.1770000000"
#   readelf -n ./checkout | grep 'Build ID'`
      },
      "production": [
        "Every container sets an explicit core limit and a core_pattern that writes outside the container filesystem.",
        "Symbols for every release are archived and keyed by build id, with retention matching crash retention.",
        "Crash dumps are treated as sensitive: they can contain tokens and customer data, so access is audited and retention is bounded.",
        "A weekly job symbolizes and groups the week's dumps so the top crash is visible without a human reading files."
      ],
      "crates": [
        "minidump",
        "minidump-processor",
        "backtrace"
      ],
      "pitfall": "Raising ulimit -c and stopping there on a systemd host whose core_pattern pipes to systemd-coredump: the dumps exist, but in /var/lib/systemd/coredump as compressed files nobody looks for.",
      "questions": [
        {
          "q": "A process dies with SIGSEGV and leaves no core. Which cause is least likely?",
          "options": [
            "RLIMIT_CORE is zero for the process",
            "core_pattern pipes dumps to a handler that failed",
            "The binary was built with debug = 0",
            "The pod was deleted before the dump finished writing"
          ],
          "answer": 2,
          "explain": "The debug setting affects symbols, not whether a dump is written. A stripped binary still produces a core; you just cannot read it well."
        },
        {
          "q": "What does a minidump deliberately omit compared with a full core?",
          "options": [
            "The module list and build ids",
            "The thread stacks",
            "The register state",
            "The heap and most of the address space"
          ],
          "answer": 3,
          "explain": "A minidump keeps stacks, registers and the module list so it can be uploaded from a user machine. Without the heap you lose variable state, which is the trade it makes."
        },
        {
          "q": "Why must the binary match the core by build id?",
          "options": [
            "Addresses and symbols come from the binary, so a mismatch produces confidently wrong frames",
            "The kernel rejects a core from a different binary",
            "gdb refuses to start otherwise",
            "The core file is encrypted with the build id"
          ],
          "answer": 0,
          "explain": "The dump stores addresses. Symbols are resolved against a binary, so a different build silently maps them to the wrong functions."
        }
      ],
      "quickbytes": [
        "Check ulimit -c, core_pattern and coredumpctl before the crash, not after.",
        "A core is only readable with the matching binary or a debuginfod server keyed by build id.",
        "Minidumps give stacks and module versions; they never give you variable state."
      ],
      "github": [
        {
          "name": "rust-minidump/rust-minidump - minidump parsing and symbolization",
          "url": "https://github.com/rust-minidump/rust-minidump"
        },
        {
          "name": "rust-lang/rust - the std backtrace and panic machinery behind crash reports",
          "url": "https://github.com/rust-lang/rust"
        }
      ],
      "resources": [
        {
          "title": "core(5) - how core dumps are produced, named and suppressed",
          "url": "https://man7.org/linux/man-pages/man5/core.5.html",
          "kind": "docs"
        },
        {
          "title": "rust-minidump/rust-minidump - minidump crate and processor",
          "url": "https://github.com/rust-minidump/rust-minidump",
          "kind": "repo"
        },
        {
          "title": "gdb(1) - opening a core file and inspecting threads",
          "url": "https://man7.org/linux/man-pages/man1/gdb.1.html",
          "kind": "docs"
        },
        {
          "title": "llvm/llvm-project - llvm-symbolizer for offline symbolization",
          "url": "https://github.com/llvm/llvm-project",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "dg08",
      "n": 8,
      "title": "Memory bugs: Miri, sanitizers and the aliasing rules",
      "minutes": 90,
      "level": "advanced",
      "goal": "Choose between Miri and the LLVM sanitizers for a given unsafe bug, run each correctly, and read the first report instead of the fallout.",
      "sections": [
        {
          "h": "Undefined behaviour is a contract violation, not a crash",
          "p": [
            "Safe Rust prevents the classic memory bugs, but unsafe blocks, FFI and MaybeUninit reintroduce them, and the failure is not required to be visible. A use-after-free may read stale-but-valid memory for months; an aliasing violation may only miscompile under one optimization level. The point of an interpreter or a sanitizer is to make the violation fail loudly at the moment it happens, instead of as a wrong number in a report.",
            "Rank the tools by what they can see. Miri interprets your MIR and checks aliasing, initialization and out-of-bounds precisely, but it cannot run FFI or real I/O. AddressSanitizer runs real code at roughly double cost and catches heap and stack overflows plus use-after-free. ThreadSanitizer catches data races but needs all synchronization visible and does not model atomic fences."
          ],
          "list": [
            "Miri for unsafe code that does not call into C",
            "ASan for FFI, allocator misuse, and anything Miri cannot execute",
            "TSan for lock-free code and racy statics, on x86_64 Linux",
            "LSan for leaks at exit, cheap enough for every CI job"
          ]
        },
        {
          "h": "Running Miri on the part of the crate that can run under it",
          "p": [
            "cargo +nightly miri test needs the Miri component and a nightly toolchain, and it only runs tests that do not touch the outside world. That constraint is the feature: tests that do real I/O are excluded, so the suite that runs under Miri is exactly the pure core where unsafe lives. Keep that subset small and fast, and gate tests that need a stub behind cfg(miri).",
            "Miri reports the violation with a backtrace through the interpreter and a message naming the rule: out-of-bounds pointer arithmetic, use of uninitialized memory, or an aliasing violation. Treat every report as a real bug even when the test passes on hardware, because the interpreter is showing you an execution the optimizer is allowed to produce."
          ],
          "code": `// Miri rejects this: the shared reference is invalidated by the write.
#[test]
fn aliasing_is_caught() {
    let mut data = vec![1u8, 2, 3];
    let first = &mut data[0] as *mut u8;
    let second = &data[0] as *const u8;
    unsafe {
        *first = 9;                     // invalidates the shared borrow
        assert_eq!(*second, 9);         // read through an invalidated pointer
    }
}

// CI:
//   rustup component add miri --toolchain nightly
//   cargo +nightly miri test --lib`,
          "tip": "Miri is slow, so scope it: --lib on the crate that owns the unsafe, not the whole workspace."
        },
        {
          "h": "Sanitizers in CI without lying to yourself",
          "p": [
            "Sanitizers need -Zbuild-std, because an uninstrumented standard library produces false positives and missed bugs. That means nightly and a full rebuild, so run them in a separate nightly job rather than on every push. The --target flag is mandatory: without it RUSTFLAGS also applies to build scripts and proc macros, which then either fail or slow the build to a crawl.",
            "Read the first report only. ASan aborts on the first error and everything after it is fallout, so fix, re-run, repeat. Keep the symbolized stack too: reports are only readable when llvm-symbolizer is on PATH, otherwise you get module plus offset and will spend the afternoon in addr2line."
          ],
          "code": `# AddressSanitizer: real execution, instrumented std, explicit target.
export RUSTFLAGS="-Zsanitizer=address"
export RUSTDOCFLAGS="-Zsanitizer=address"
cargo +nightly test -Zbuild-std --target x86_64-unknown-linux-gnu

# ThreadSanitizer for the lock-free path.
RUSTFLAGS="-Zsanitizer=thread" \\
  cargo +nightly test -Zbuild-std --target x86_64-unknown-linux-gnu

# LeakSanitizer runs at exit on Linux; make leaks fatal in CI.
ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 \\
  cargo +nightly test -Zbuild-std --target x86_64-unknown-linux-gnu`,
          "tip": "Put llvm-symbolizer on PATH in the CI image before you need it; unsymbolized ASan output is the most common reason a report gets ignored."
        }
      ],
      "exercise": {
        "prompt": "Add a Miri job and an ASan job to CI. Miri runs only the library tests; ASan builds for an explicit target with an instrumented std and fails on the first report.",
        "starter": `# .github/workflows/sanitizers.yml
name: sanitizers
on: [push, pull_request]

jobs:
  miri:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # 1. install nightly + miri
      # 2. run cargo +nightly miri test --lib
  asan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # 3. install nightly, llvm-symbolizer
      # 4. run with -Zsanitizer=address -Zbuild-std --target`,
        "hint": "rustup component add miri --toolchain nightly, then MIRIFLAGS=-Zmiri-disable-isolation only if a test genuinely needs the clock. For ASan, add the target with rustup target add.",
        "solution": `# .github/workflows/sanitizers.yml
name: sanitizers
on: [push, pull_request]

jobs:
  miri:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: rustup toolchain install nightly --component miri
      - run: cargo +nightly miri setup
      - name: Run Miri on the unsafe core
        run: cargo +nightly miri test --lib
        env:
          MIRIFLAGS: -Zmiri-strict-provenance

  asan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: rustup toolchain install nightly
      - run: rustup target add x86_64-unknown-linux-gnu
      - run: sudo apt-get update && sudo apt-get install -y llvm
      - name: AddressSanitizer with an instrumented std
        run: cargo +nightly test -Zbuild-std --target x86_64-unknown-linux-gnu
        env:
          RUSTFLAGS: -Zsanitizer=address
          RUSTDOCFLAGS: -Zsanitizer=address
          ASAN_OPTIONS: detect_leaks=1:halt_on_error=1`
      },
      "production": [
        "Miri runs on the pure-core test subset for every pull request that touches an unsafe block.",
        "A nightly ASan plus LSan job builds with -Zbuild-std for an explicit target and fails on the first report.",
        "Every unsafe block carries a // SAFETY: comment naming the invariant and the test that covers it.",
        "Sanitizer reports are triaged as bugs, never retried; a flaky sanitizer usually means a real race."
      ],
      "crates": [
        "libc",
        "bytemuck",
        "zerocopy"
      ],
      "pitfall": "Running ASan without -Zbuild-std: the standard library is uninstrumented, so out-of-bounds writes inside std allocations are missed and the report you do get may be a false positive.",
      "questions": [
        {
          "q": "Why does AddressSanitizer need -Zbuild-std to be trustworthy?",
          "options": [
            "It makes the build faster",
            "The standard library must be instrumented too, or accesses inside its allocations are missed and reports can be false",
            "It enables the leak detector",
            "It is only needed on macOS"
          ],
          "answer": 1,
          "explain": "Sanitizers work by instrumenting memory accesses. Code in an uninstrumented std is invisible, so a violation that happens there is not reported."
        },
        {
          "q": "A test opens a TCP socket, so Miri cannot run it. What is the right response?",
          "options": [
            "Add -Zmiri-disable-isolation and keep the socket call",
            "Replace Miri with ASan and drop the test",
            "Split the pure logic out and test that under Miri, keeping the I/O test out of the Miri subset",
            "Disable Miri for the crate"
          ],
          "answer": 2,
          "explain": "Miri's value is on the code that can run under it. Extracting the unsafe core is both the fix for the test and a better structure for review."
        },
        {
          "q": "ThreadSanitizer reports a race between a plain write in thread A and a read in thread B with no synchronization. Is it a false positive?",
          "options": [
            "Only if the threads are on different cores",
            "Yes, TSan reports many false positives on Rust",
            "Only if the value is a u8",
            "No: it is a real data race, which is undefined behaviour regardless of whether the value looks correct"
          ],
          "answer": 3,
          "explain": "TSan is conservative about fences and inline assembly, but an unsynchronized plain write/read pair is a genuine race. The fact that it has never misbehaved is luck, not safety."
        }
      ],
      "quickbytes": [
        "Miri for aliasing and initialization in pure code; ASan for FFI and real allocations.",
        "Always pass --target with -Zbuild-std so build scripts and proc macros stay uninstrumented.",
        "Fix the first ASan report and re-run; everything after the abort is fallout."
      ],
      "github": [
        {
          "name": "rust-lang/miri - the MIR interpreter that checks undefined behaviour",
          "url": "https://github.com/rust-lang/miri"
        },
        {
          "name": "rust-lang/rust - sanitizer support lives in the compiler and std",
          "url": "https://github.com/rust-lang/rust"
        }
      ],
      "resources": [
        {
          "title": "The Rust Unstable Book: sanitizer support and -Zbuild-std",
          "url": "https://doc.rust-lang.org/beta/unstable-book/compiler-flags/sanitizer.html",
          "kind": "docs"
        },
        {
          "title": "rust-lang/miri - undefined behaviour detection for unsafe Rust",
          "url": "https://github.com/rust-lang/miri",
          "kind": "repo"
        },
        {
          "title": "The Cargo Book: profiles used to build instrumented binaries",
          "url": "https://doc.rust-lang.org/cargo/reference/profiles.html",
          "kind": "docs"
        },
        {
          "title": "rust-lang/rust - tracking issues for the sanitizers",
          "url": "https://github.com/rust-lang/rust",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "dg09",
      "n": 9,
      "title": "Deadlocks and hangs: finding the cycle",
      "minutes": 85,
      "level": "advanced",
      "goal": "Tell the four shapes of a hang apart from evidence, impose a lock order that prevents cycles, and read a blocked process well enough to name the two lines involved.",
      "sections": [
        {
          "h": "Hangs have four shapes",
          "p": [
            "A hang is a process that stops making progress, and the cause is one of four things: a deadlock, which is a cycle of waits; a livelock, which is work without progress; starvation, where one waiter never wins; or a wait on something that will never arrive, such as a reply from a peer that is gone, a task nobody spawned, or a channel whose sender was dropped. Only the first is a lock bug, and the four need different evidence.",
            "The first diagnostic question is whether the process is using CPU. A spinning process is livelock or a busy retry loop; a process at zero with open connections is waiting. top -H and /proc/<pid>/status answer that in seconds, before any debugger, and they tell you which of the four shapes to go looking for."
          ]
        },
        {
          "h": "Lock ordering, and how cycles form",
          "p": [
            "Two mutexes taken in opposite orders by two threads is the canonical deadlock, and it is invisible in review because each function looks locally correct. The fix is a global order: every path takes accounts before ledger, enforced by a comment, by a helper that acquires both, or by a debug-only assertion that records the acquisition order and panics on an inversion. try_lock with a timeout converts a hang into a loggable error carrying both stacks.",
            "std::sync::Mutex poisons on panic, so a panicking holder turns every later lock into an Err, which looks like corruption from a distance. parking_lot::Mutex does not poison and is faster, but a panic mid-update then leaves the data inconsistent with no signal at all. Both choices are defensible; the indefensible one is not knowing which you picked."
          ],
          "code": `use std::sync::{Arc, Mutex};
use std::thread;

struct Books {
    accounts: Mutex<u32>,
    ledger: Mutex<u32>,
}

fn accounts_then_ledger(b: &Books) {
    let mut accounts = b.accounts.lock().unwrap();
    let mut ledger = b.ledger.lock().unwrap();
    *accounts -= 1;
    *ledger += 1;
}

fn ledger_then_accounts(b: &Books) {
    // Opposite order: this is the cycle.
    let mut ledger = b.ledger.lock().unwrap();
    let mut accounts = b.accounts.lock().unwrap();
    *accounts += 1;
    *ledger -= 1;
}

fn main() {
    let books = Arc::new(Books {
        accounts: Mutex::new(0),
        ledger: Mutex::new(0),
    });
    let a = books.clone();
    let b = books.clone();
    let t1 = thread::spawn(move || accounts_then_ledger(&a));
    let t2 = thread::spawn(move || ledger_then_accounts(&b));
    t1.join().unwrap();
    t2.join().unwrap();
}`,
          "tip": "Make the order impossible to get wrong: one function that returns both guards in a fixed order beats a comment that asks people to remember."
        },
        {
          "h": "Reading a hung process",
          "p": [
            "With the process still alive, capture all stacks: gdb -p <pid> -batch -ex 'thread apply all bt'. In a deadlock you will see two threads each blocked in a futex wait inside Mutex::lock, with the frames above naming the two functions. That is the cycle, and those two source lines are the fix. parking_lot has a deadlock_detection feature that performs the same analysis in-process and returns the cycle as data.",
            "Async hangs look different and waste the most time. The thread is parked in the runtime's idle loop because no task is runnable, so thread stacks show nothing useful; tokio-console is the instrument that shows which task waits on which resource. Reaching for gdb on an async hang is the single most common wasted hour in this area."
          ],
          "code": `# Capture every thread at one instant, then release the process.
PID=$(pgrep -f 'checkout$' | head -1)
gdb -p "$PID" -batch \
  -ex "set pagination off" \
  -ex "thread apply all bt 15" \
  -ex "detach" 2>&1 | tee hang-stacks.txt

# What a two-lock deadlock looks like in that output:
#   Thread 3 (LWP 4412):
#   #0  futex_wait
#   #1  std::sync::mutex::Mutex<T>::lock
#   #2  checkout::ledger_then_accounts
#   Thread 4 (LWP 4413):
#   #0  futex_wait
#   #1  std::sync::mutex::Mutex<T>::lock
#   #2  checkout::accounts_then_ledger`,
          "tip": "Grab two snapshots thirty seconds apart. Identical stacks across both is a hang; different stacks mean slow progress, which is a different investigation."
        }
      ],
      "exercise": {
        "prompt": "Reproduce a two-lock deadlock, capture both stacks with a batch gdb invocation, and fix it by imposing a lock order. Show the two frames that prove the cycle.",
        "starter": `use std::sync::{Arc, Mutex};
use std::thread;

struct Books { accounts: Mutex<u32>, ledger: Mutex<u32> }

fn transfer_out(b: &Books) {
    // TODO: take accounts then ledger
}

fn transfer_in(b: &Books) {
    // TODO: deliberately take ledger then accounts
}

fn main() {
    // TODO: spawn both and join
}`,
        "hint": "Make the deadlock reliable by holding the first guard for a moment before taking the second, for example with a short sleep between the two locks in one of the functions.",
        "solution": `use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

struct Books { accounts: Mutex<u32>, ledger: Mutex<u32> }

fn transfer_out(b: &Books) {
    let mut accounts = b.accounts.lock().unwrap();
    thread::sleep(Duration::from_millis(50)); // widen the window
    let mut ledger = b.ledger.lock().unwrap();
    *accounts -= 1;
    *ledger += 1;
}

fn transfer_in(b: &Books) {
    let mut ledger = b.ledger.lock().unwrap(); // opposite order -> cycle
    thread::sleep(Duration::from_millis(50));
    let mut accounts = b.accounts.lock().unwrap();
    *accounts += 1;
    *ledger -= 1;
}

fn main() {
    let books = Arc::new(Books { accounts: Mutex::new(0), ledger: Mutex::new(0) });
    let a = books.clone();
    let b = books.clone();
    let t1 = thread::spawn(move || transfer_out(&a));
    let t2 = thread::spawn(move || transfer_in(&b));

    // Run: gdb -p $(pgrep -f books) -batch -ex "thread apply all bt 15" -ex detach
    // You will see both threads in futex_wait under Mutex::lock, one in
    // transfer_out and one in transfer_in. That pair of frames is the cycle.
    t1.join().unwrap();
    t2.join().unwrap();
}

// Fix: one acquisition order everywhere.
fn transfer_in_fixed(b: &Books) {
    let mut accounts = b.accounts.lock().unwrap();
    let mut ledger = b.ledger.lock().unwrap();
    *accounts += 1;
    *ledger -= 1;
}`
      },
      "production": [
        "Every pair of locks has a documented acquisition order, and a debug-build assertion fails on an inversion.",
        "No lock guard is held across an await point; the type system does not stop you, so review and clippy configuration do.",
        "Every cross-service wait has a timeout, so a vanished peer becomes an error instead of a hang.",
        "Hang alerts fire on absence of progress (queue depth, task age), because hangs are invisible to CPU alerts."
      ],
      "crates": [
        "parking_lot",
        "tokio",
        "loom"
      ],
      "pitfall": "Holding a std::sync::Mutex guard across an .await inside an async fn: the task may be suspended while holding the lock, and every other task that needs it blocks a worker thread behind it.",
      "questions": [
        {
          "q": "A process sits at 0% CPU with all threads parked and connections open. Which shape of hang is most likely?",
          "options": [
            "A deadlock or a wait on something that will never arrive",
            "Livelock",
            "An infinite loop with no allocation",
            "A stack overflow"
          ],
          "answer": 0,
          "explain": "Zero CPU with parked threads means nobody is spinning. Either the waits form a cycle, or a single wait will never be satisfied - both need stack or task evidence to distinguish."
        },
        {
          "q": "Why does thread apply all bt explain nothing about an async hang?",
          "options": [
            "tokio hides its threads from ptrace",
            "The waiting is represented in the task graph, not the thread stack; executor threads are simply idle",
            "gdb cannot read Rust symbols",
            "Async tasks do not have stacks"
          ],
          "answer": 1,
          "explain": "A task that returns Pending releases its thread. The thread stack shows the idle loop, so you need a task-level view such as tokio-console."
        },
        {
          "q": "What does try_lock with a timeout buy you in production?",
          "options": [
            "It removes the need for a lock order",
            "It prevents the deadlock from happening",
            "It turns a hang into a loggable error with a stack, and gives you a chance to shed load",
            "It makes the mutex lock-free"
          ],
          "answer": 2,
          "explain": "The cycle still exists; you have converted an invisible stall into an observable error. Preventing the cycle still requires a consistent order."
        }
      ],
      "quickbytes": [
        "CPU at zero plus parked threads means waiting; CPU pegged means spinning. Check that before attaching anything.",
        "One global lock order, enforced by a helper or a debug assertion, not by memory.",
        "Two stack snapshots thirty seconds apart separate a hang from slow progress."
      ],
      "github": [
        {
          "name": "tokio-rs/loom - permutation testing for concurrent code",
          "url": "https://github.com/tokio-rs/loom"
        },
        {
          "name": "tokio-rs/tokio - the async runtime whose Mutex and task model matter here",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "resources": [
        {
          "title": "loom crate documentation: modelling, preemption bounds, checkpoints",
          "url": "https://docs.rs/loom/latest/loom/",
          "kind": "docs"
        },
        {
          "title": "tokio-rs/loom - concurrency permutation testing tool",
          "url": "https://github.com/tokio-rs/loom",
          "kind": "repo"
        },
        {
          "title": "gdb(1) - attaching to a running process and dumping all threads",
          "url": "https://man7.org/linux/man-pages/man1/gdb.1.html",
          "kind": "docs"
        },
        {
          "title": "tokio-rs/tokio - runtime internals and sync primitives",
          "url": "https://github.com/tokio-rs/tokio",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "dg10",
      "n": 10,
      "title": "Async task debugging: tasks that never wake",
      "minutes": 95,
      "level": "advanced",
      "goal": "Diagnose a stalled async task that no thread stack can show, use tokio-console to see task state and waker counts, and bound every wait with a timeout.",
      "sections": [
        {
          "h": "A stalled task is not a blocked thread",
          "p": [
            "In an async runtime a task that cannot make progress returns Pending and its thread goes back to the scheduler. Nothing is blocked, so no thread stack shows the problem. The bug lives in a future waiting for a waker that never fires: a mutex guard held across an await, a channel whose sender was dropped, a oneshot whose receiver was dropped, or a timer registered on a runtime that is shutting down.",
            "The other half is accidental blocking. std::thread::sleep, a synchronous database driver, or block_on inside an async context occupies a worker thread. On a four-worker runtime, four such calls stop every task, and the symptom looks like a deadlock with healthy CPU. block_in_place or spawn_blocking moves the work to a thread that is allowed to block."
          ]
        },
        {
          "h": "tokio-console: the task view stacks cannot give you",
          "p": [
            "tokio-console attaches to a running process and shows tasks, their state, poll counts, busy time and waker counts. It needs the tokio_unstable cfg, the tracing feature on tokio, and console_subscriber installed as a layer; in exchange you see exactly which task is idle, how long it has been idle, and what it last awaited.",
            "The waker count is the detail that finds leaked tasks. A task whose waker count keeps growing is being cloned into more places than it is woken, and a task that has been idle for an hour with no waker is never coming back. Name your tasks with task::Builder::new().name(...) or #[instrument(name = ...)], or the console shows you forty identical entries."
          ],
          "code": `use tokio::task::JoinSet;
use tracing::Instrument;

pub fn init_debugging() {
    // Requires tokio features = ["tracing"] and RUSTFLAGS="--cfg tokio_unstable".
    console_subscriber::init();
}

pub async fn fan_out(orders: Vec<Order>) -> Vec<Result<Receipt, ChargeError>> {
    let mut set = JoinSet::new();
    for order in orders {
        let span = tracing::info_span!("charge", order.id = %order.id);
        set.spawn(async move { charge(order).await }.instrument(span));
    }

    let mut out = Vec::new();
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(result) => out.push(result),
            Err(err) if err.is_panic() => tracing::error!(?err, "task panicked"),
            Err(err) => tracing::warn!(?err, "task cancelled"),
        }
    }
    out
}`,
          "tip": "A task with no name and no span is a black box in an incident; one #[instrument] on the spawned future fixes both the console and the logs."
        },
        {
          "h": "Timeouts, cancellation and leaked tasks",
          "p": [
            "Every await on something external needs a bound: tokio::time::timeout, or a select! with a sleep. A dropped JoinHandle detaches the task rather than cancelling it, so a spawn whose handle you ignore is a task that runs forever on error paths. The leak is invisible until the console shows a thousand idle tasks, at which point you are debugging memory rather than the original bug.",
            "Instrument before you need it. A task with no span name, no attributes and no timeout is unfalsifiable at 3am; one #[instrument] on the spawned future costs a span creation and answers which order, which attempt and how long, from the console and from the logs at once. Prefer JoinSet over loose spawns so shutdown is structured: abort_all, then await until the set drains or a deadline passes."
          ]
        }
      ],
      "exercise": {
        "prompt": "A worker stops consuming from a channel after a deploy. Instrument the consumer task, wrap the receive in a timeout that logs on expiry, and name the task so the console identifies it.",
        "starter": `use tokio::sync::mpsc;
use tracing::Instrument;

pub async fn consume(mut rx: mpsc::Receiver<Job>) {
    loop {
        // 1. receive with a timeout
        // 2. log the timeout with the task name
        // 3. stop cleanly when the channel closes
        todo!()
    }
}`,
        "hint": "tokio::time::timeout(duration, rx.recv()).await returns Result<Option<Job>, Elapsed>. The None case is a closed channel, which is a normal shutdown and not a timeout.",
        "solution": `use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{info, instrument, warn, Instrument};

#[instrument(name = "job_consumer", skip(rx))]
pub async fn consume(mut rx: mpsc::Receiver<Job>) {
    loop {
        match tokio::time::timeout(Duration::from_secs(30), rx.recv()).await {
            Ok(Some(job)) => {
                info!(job.id = %job.id, "received");
                if let Err(err) = handle(job).await {
                    warn!(error = %err, "job failed");
                }
            }
            Ok(None) => {
                info!("channel closed, consumer exiting");
                break;
            }
            Err(_elapsed) => {
                // A silent idle consumer and a wedged one look identical in logs;
                // this line is what makes the difference visible.
                warn!("no job received in 30s; still waiting on the channel");
            }
        }
    }
}

pub fn spawn_consumer(rx: mpsc::Receiver<Job>) -> tokio::task::JoinHandle<()> {
    let span = tracing::info_span!("job_consumer");
    tokio::spawn(consume(rx).instrument(span))
}

async fn handle(_job: Job) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}`
      },
      "production": [
        "Every spawned task has a name and a span; an unnamed spawn is a review finding.",
        "Every await on a network or channel resource is wrapped in a timeout with a metric on expiry.",
        "Shutdown is structured: JoinSet aborted and awaited with a drain deadline, never fire-and-forget.",
        "Blocking calls are isolated in spawn_blocking, and CI lints for std::thread::sleep inside async functions."
      ],
      "crates": [
        "tokio",
        "console-subscriber",
        "futures-util",
        "tracing"
      ],
      "pitfall": "Dropping a JoinHandle to silence an unused-variable warning: the task keeps running detached, so error paths leak tasks until the runtime is out of memory or the console shows thousands of idle entries.",
      "questions": [
        {
          "q": "Why does thread apply all bt fail to explain an async hang?",
          "options": [
            "Async tasks run on separate processes",
            "Rust async frames cannot be symbolized",
            "tokio masks its threads from ptrace",
            "A waiting task returns Pending and frees its thread, so the stack shows the idle loop rather than the wait"
          ],
          "answer": 3,
          "explain": "The waiting state lives in the future, not the stack. That is why task-level tooling such as tokio-console exists."
        },
        {
          "q": "You drop a JoinHandle without aborting it. What happens to the task?",
          "options": [
            "It keeps running, detached, with no handle to join or abort",
            "It panics with a cancelled error",
            "The runtime refuses to drop the handle",
            "It is cancelled at the next await point"
          ],
          "answer": 0,
          "explain": "Dropping the handle detaches. The task continues until it finishes or the runtime shuts down, which is why error paths leak tasks silently."
        },
        {
          "q": "What does a steadily growing waker count on one task suggest?",
          "options": [
            "The task holds a mutex guard across an await",
            "Its waker is being cloned into places that never wake it, a common leak pattern",
            "The task is about to be scheduled",
            "The runtime is starved of worker threads"
          ],
          "answer": 1,
          "explain": "Each clone is a promise to wake later. Counts that only grow mean registrations that are never fulfilled, so the task waits forever while the bookkeeping grows."
        }
      ],
      "quickbytes": [
        "A stalled async task looks idle, not blocked; task-level tooling is the only view that shows it.",
        "console_subscriber::init() needs tokio_unstable and the tokio tracing feature, or it silently shows nothing.",
        "Dropping a JoinHandle detaches; abort it or keep it in a JoinSet."
      ],
      "github": [
        {
          "name": "tokio-rs/console - tokio-console, a debugger for async Rust",
          "url": "https://github.com/tokio-rs/console"
        },
        {
          "name": "tokio-rs/tokio - task instrumentation consumed by the console",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "resources": [
        {
          "title": "console-subscriber: setup, tokio_unstable and the builder API",
          "url": "https://docs.rs/console-subscriber/latest/console_subscriber/",
          "kind": "docs"
        },
        {
          "title": "tokio-rs/console - the tokio-console debugger",
          "url": "https://github.com/tokio-rs/console",
          "kind": "repo"
        },
        {
          "title": "tokio-rs/tokio - runtime and task instrumentation",
          "url": "https://github.com/tokio-rs/tokio",
          "kind": "repo"
        },
        {
          "title": "Jon Gjengset: long-form async Rust and runtime internals",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ]
    },
    {
      "id": "dg11",
      "n": 11,
      "title": "Distributed tracing for bugs: follow one request",
      "minutes": 90,
      "level": "industry",
      "goal": "Use a trace id as the join key for an incident, record the attributes that explain a slow hop, and keep the failing traces instead of sampling them away.",
      "sections": [
        {
          "h": "The trace is the reproducer you did not have to build",
          "p": [
            "In a distributed system the failing request cannot be replayed, but it can be recorded. A trace is the ordered set of spans for one request across services, keyed by a trace id propagated in headers. During an incident the trace id is the join key: it turns checkout is slow into this request spent 780ms in inventory and 40ms everywhere else.",
            "Traces also fail in a specific way: they are sampled. If you sample one percent at the edge, the failing request is almost certainly not recorded, and you are left with dashboards describing healthy traffic. The fix is not sample more but tail sampling: keep every trace that contains an error or exceeds a latency budget, and sample the boring ones."
          ],
          "list": [
            "trace_id in every log line and every error payload, not only in spans",
            "Tail sampling keeps error and slow traces; head sampling keeps nothing useful",
            "Span links, not parent-child, for retries and fan-in joins",
            "One span per outbound call, with the peer service name as an attribute"
          ]
        },
        {
          "h": "Attributes that answer which hop",
          "p": [
            "A span with a name and a duration tells you where the time went but not why. Record the deciding inputs at each hop: the shard or partition, the retry attempt, the resolved flag value, the row count, the cache hit or miss. Three or four attributes per span is usually enough to explain an outlier; thirty is a bill and a cardinality problem.",
            "Record the negative facts too. cache.hit=false, retry.attempt=3 and pool.wait_ms=412 are the attributes that explain a latency outlier, and they are the ones people forget because they are uninteresting on a healthy request. If you only record success paths, every trace looks the same and none of them is diagnostic."
          ],
          "code": `use std::time::Instant;
use tracing::instrument;

#[instrument(
    skip_all,
    fields(
        peer.service = "inventory",
        attempt = ctx.attempt,
        cache.hit = ctx.cache_hit,
        pool.wait_ms,
    )
)]
pub async fn reserve(
    ctx: &TraceCtx,
    sku: Sku,
    qty: u32,
) -> Result<Reservation, ReserveError> {
    let wait_start = Instant::now();
    let conn = ctx.pool.get().await?;
    let waited = wait_start.elapsed().as_millis() as u64;
    tracing::Span::current().record("pool.wait_ms", waited);

    let result = ctx.inventory.reserve(&conn, sku, qty).await;
    if let Err(err) = &result {
        tracing::error!(error = %err, retryable = err.is_retryable(), "reserve failed");
    }
    result
}`,
          "tip": "Declare the field empty in fields(...) and record it later when the value exists; that is how pool.wait_ms avoids a second span."
        },
        {
          "h": "Sampling and propagation during an incident",
          "p": [
            "Propagation is a contract: the context travels in a header such as W3C traceparent, every client injects it, every server extracts it. A single hop that drops the header breaks the trace in half, and you will not notice until the incident where the second half is the interesting one. Assert propagation in a test: send a request with a known trace id and check that a downstream span shares it.",
            "During an incident, force sampling for the affected tenant rather than globally: a header or flag that makes the sampler keep everything matching a predicate. Cost stays bounded and you get complete traces for exactly the failing traffic. Turn it off when the incident closes, or the sampling budget becomes the next incident."
          ]
        }
      ],
      "exercise": {
        "prompt": "Checkout p99 rose from 300ms to 900ms. Write the span attributes you need to localize the hop, and a query that separates time waiting for a pooled connection from time spent in the downstream call.",
        "starter": `#[instrument(skip_all, fields(peer.service = "inventory"))]
pub async fn reserve(ctx: &TraceCtx, sku: Sku, qty: u32) -> Result<Reservation, ReserveError> {
    // 1. time the pool acquisition separately from the RPC
    // 2. record both as span fields
    // 3. record the retry attempt and cache result
    todo!()
}`,
        "hint": "Two Instant::now() calls around the two awaits give you pool.wait_ms and rpc.ms. Group by both fields in the trace backend; a p99 driven by pool.wait_ms points at the pool, not at inventory.",
        "solution": `use std::time::Instant;
use tracing::instrument;

#[instrument(
    skip_all,
    fields(
        peer.service = "inventory",
        attempt = ctx.attempt,
        cache.hit = ctx.cache_hit,
        pool.wait_ms,
        rpc.ms,
        outcome,
    )
)]
pub async fn reserve(
    ctx: &TraceCtx,
    sku: Sku,
    qty: u32,
) -> Result<Reservation, ReserveError> {
    let span = tracing::Span::current();

    let wait_start = Instant::now();
    let conn = ctx.pool.get().await?;
    span.record("pool.wait_ms", wait_start.elapsed().as_millis() as u64);

    let rpc_start = Instant::now();
    let result = ctx.inventory.reserve(&conn, sku, qty).await;
    span.record("rpc.ms", rpc_start.elapsed().as_millis() as u64);

    match &result {
        Ok(_) => span.record("outcome", "ok"),
        Err(err) => {
            span.record("outcome", if err.is_retryable() { "retryable" } else { "permanent" });
            tracing::error!(error = %err, "reserve failed");
        }
    }
    result
}

// Query: group by span name, then compare p99 of pool.wait_ms with p99 of rpc.ms.
// A regression that moves pool.wait_ms is a capacity bug; one that moves rpc.ms
// is the peer's problem. Neither is visible from the parent span's duration alone.`
      },
      "production": [
        "Every service injects and extracts W3C traceparent, and a synthetic test asserts the trace spans three services.",
        "Tail sampling keeps 100% of error and over-budget traces; head sampling is only for volume control.",
        "Span attributes are budgeted: at most eight per span, reviewed like a schema change.",
        "Logs carry trace_id and span_id so a log search and a trace search return the same request."
      ],
      "crates": [
        "opentelemetry",
        "opentelemetry-otlp",
        "tracing-opentelemetry",
        "tracing"
      ],
      "pitfall": "Adopting tracing with head sampling at 1% and no tail sampler: every incident review then argues from dashboards of healthy requests, because the failing traces were discarded at the edge.",
      "questions": [
        {
          "q": "You sample 1% at the edge during an incident. What do you lose?",
          "options": [
            "Nothing, because 1% of a large number is still large",
            "Only the metrics, not the traces",
            "The failing requests, unless a tail sampler keeps error and over-budget traces",
            "The span attributes, but not the durations"
          ],
          "answer": 2,
          "explain": "Head sampling decides before the outcome is known, so it discards failures at the same rate as successes. Tail sampling decides after the trace completes."
        },
        {
          "q": "What is the right way to represent a retry in a trace?",
          "options": [
            "A log event only, outside the trace",
            "Reuse the parent span and overwrite its duration",
            "A child span nested under the first attempt",
            "A new span with the same operation and an attempt attribute, linked to the first"
          ],
          "answer": 3,
          "explain": "A child span implies the retry happened inside the first attempt. A sibling with an attempt attribute and a link preserves both the ordering and the causality."
        },
        {
          "q": "A downstream service shows no spans for a request you can see upstream. What is the most likely cause?",
          "options": [
            "The trace context header was not injected or not extracted on that hop",
            "Span attributes exceeded the cardinality limit",
            "The downstream service is not instrumented at all",
            "The sampler dropped only that service"
          ],
          "answer": 0,
          "explain": "A broken propagation hop splits the trace. Instrumentation that never injects the header is the usual cause, and it is invisible until you look for a gap."
        }
      ],
      "quickbytes": [
        "The trace id is the join key: put it in logs, errors and the incident timeline.",
        "Tail-sample errors and over-budget traces; head sampling throws away exactly the ones you need.",
        "Record pool wait, retry attempt and cache result, or every trace will look the same."
      ],
      "github": [
        {
          "name": "tokio-rs/tracing - spans, context and subscriber layers",
          "url": "https://github.com/tokio-rs/tracing"
        },
        {
          "name": "tokio-rs/tokio - runtime instrumentation that emits spans",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "resources": [
        {
          "title": "tracing crate documentation: spans, fields and context",
          "url": "https://docs.rs/tracing/latest/tracing/",
          "kind": "docs"
        },
        {
          "title": "Scalable Statistical Root Cause Analysis on App Telemetry (Facebook Minesweeper)",
          "url": "https://arxiv.org/abs/2010.09974",
          "kind": "paper"
        },
        {
          "title": "tokio-rs/tracing repository",
          "url": "https://github.com/tokio-rs/tracing",
          "kind": "repo"
        },
        {
          "title": "Jon Gjengset: distributed systems and Rust internals lectures",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ]
    },
    {
      "id": "dg12",
      "n": 12,
      "title": "Flaky tests: measure the rate before you fix it",
      "minutes": 80,
      "level": "advanced",
      "goal": "Turn an intermittent failure into a measured failure rate, remove the nondeterminism at its source, and reproduce a schedule rather than rerunning and hoping.",
      "sections": [
        {
          "h": "A flake is a distribution, not a bug report",
          "p": [
            "A test that fails one run in fifty is not probably fine; it is a system producing a failure at a rate nobody has measured. Before fixing, measure: run the case two hundred times, record the rate, and write it in the ticket. A rate turns it passed for me into a number, and it is also the only way to show a fix worked, because taking two percent to zero needs the same two hundred runs to demonstrate.",
            "The measurement costs more than people expect. A study of Python projects found that establishing 95% confidence that a passing test is not flaky takes on average 170 reruns; anything less is a coin flip dressed as evidence. Run the loop with the thread count fixed, or the measurement itself becomes another source of nondeterminism."
          ],
          "code": `// tests/flake_probe.rs - measure first, then fix.
#[test]
fn flake_probe_checkout_totals() {
    let runs = 200u32;
    let mut failures = 0u32;

    for seed in 0..runs {
        // A fresh fixture and runtime per iteration, as a fresh process would get.
        let outcome = std::panic::catch_unwind(|| run_case(seed as u64));
        if outcome.is_err() {
            failures += 1;
        }
    }

    let rate = 100.0 * failures as f64 / runs as f64;
    assert_eq!(failures, 0, "{failures}/{runs} runs failed ({rate:.2}%)");
}`,
          "tip": "Print the seed of every failing iteration. A flake you can re-run by seed is already half fixed."
        },
        {
          "h": "The usual causes in Rust",
          "p": [
            "Most Rust flakes come from four places: shared mutable state such as a static, a lazily initialised global or a pool sized one; the environment, meaning ports, temp paths, locale, timezone and Instant::now; scheduling, because cargo test runs tests in parallel threads inside one process; and randomness without a seeded source. Test ordering matters for the same reason: any global is shared across the whole binary.",
            "Fix the cause, not the symptom. --test-threads=1 hides the bug in CI and doubles the runtime; a retry hides it in the report and leaves it in production. The durable fixes are injection (a clock, an RNG, a port allocator), isolation (a temp dir, a unique schema per test), and explicit synchronisation instead of sleep."
          ],
          "list": [
            "Bind to port 0 and read back the assigned port; never hard-code one",
            "Inject a clock and a seeded RNG; never assert against SystemTime::now",
            "One temp dir per test, removed by a guard; no fixed /tmp paths",
            "Use nextest's process-per-test model when a test must own global state"
          ]
        },
        {
          "h": "Reproduce the schedule, not just the input",
          "p": [
            "For concurrency bugs, rerunning is a lottery; loom replaces the lottery with an exhaustive search over interleavings. Model the primitive with loom types under cfg(loom), run loom::model, and the failure becomes deterministic. Once it fails, LOOM_CHECKPOINT_FILE plus LOOM_LOG gives you the exact schedule that produced it, which is a reproducer in the sense dg02 demands.",
            "When the bug needs the real binary, rr record captures an execution and replays it deterministically under gdb, including thread interleaving. It is Linux-only and slows execution, which is exactly the trade you want for a bug that appears once a week on one machine. Record on the failing host, replay anywhere."
          ],
          "code": `# loom explores schedules instead of hoping for them.
[target.'cfg(loom)'.dependencies]
loom = "0.7"

# Run it in its own job, in release mode: it executes the model many times.
RUSTFLAGS="--cfg loom" cargo test --release --test loom_queue

# Once it fails, pin the schedule and turn on the log:
LOOM_CHECKPOINT_FILE=queue.json LOOM_CHECKPOINT_INTERVAL=1 \\
LOOM_LOG=trace LOOM_LOCATION=1 \\
RUSTFLAGS="--cfg loom" cargo test --release --test loom_queue`,
          "tip": "LOOM_MAX_PREEMPTIONS=3 finds most bugs in a fraction of the time; run the unbounded search nightly."
        }
      ],
      "exercise": {
        "prompt": "A test fails 3 times in 200 in CI and never locally. Write the probe that measures the rate, list the three environment differences to check first, and convert the test to inject a clock and an allocated port.",
        "starter": `#[test]
fn checkout_is_deterministic() {
    // 1. loop enough iterations to measure a rate
    // 2. replace SystemTime::now with an injected clock
    // 3. bind a listener to port 0 instead of 8080
    todo!()
}`,
        "hint": "Start with the three cheapest hypotheses: parallel test threads sharing a global, a fixed port already in use, and a clock or timezone read directly. Each is verifiable by changing one thing and re-running the probe.",
        "solution": `use std::net::TcpListener;
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

#[derive(Clone)]
struct FixedClock(UNIX_EPOCH);

impl FixedClock {
    fn now(&self) -> std::time::SystemTime {
        self.0 + Duration::from_secs(1_700_000_000)
    }
}

fn free_port() -> u16 {
    // Bind to 0, read the assigned port, drop the listener. Racy in principle,
    // fine in practice; a port allocator that holds the socket is stricter.
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    listener.local_addr().expect("local addr").port()
}

#[test]
fn checkout_is_deterministic() {
    let runs = 200u32;
    let mut failures = 0u32;

    for seed in 0..runs {
        let clock = FixedClock(UNIX_EPOCH);
        let port = free_port();
        let svc = Arc::new(Service::new(clock, port, seed as u64));

        let outcome = std::panic::catch_unwind({
            let svc = Arc::clone(&svc);
            move || svc.checkout(fixture_order())
        });
        if outcome.is_err() {
            failures += 1;
            eprintln!("failed at seed {seed}, port {port}");
        }
    }

    assert_eq!(failures, 0, "{failures}/{runs} runs failed");
}`
      },
      "production": [
        "Every flaky test has a ticket with a measured rate and a deadline; retries are quarantine, not a fix.",
        "A nightly sweep reports per-test flake rates instead of hiding them behind rerun-failed.",
        "Tests bind to port 0, use per-test temp dirs, and never read the wall clock directly.",
        "Concurrency primitives have a loom model under cfg(loom) that runs in a separate CI job."
      ],
      "crates": [
        "loom",
        "proptest",
        "tempfile",
        "rand"
      ],
      "pitfall": "Adding a retry to the CI step so the pipeline goes green: the failure rate is unchanged, the report is now a lie, and the same nondeterminism reaches production where nobody retries a customer request.",
      "questions": [
        {
          "q": "Why is twenty reruns a weak basis for calling a flake fixed?",
          "options": [
            "Twenty runs is too slow to be practical",
            "The confidence interval is far too wide; published work needed around 170 reruns for 95% confidence",
            "Reruns do not exercise the same code path",
            "Reruns always pass because of caching"
          ],
          "answer": 1,
          "explain": "A 2% failure rate has a substantial chance of producing zero failures in twenty runs. The absence of a failure is not evidence of a fix at that sample size."
        },
        {
          "q": "--test-threads=1 makes the failure disappear. What have you learned?",
          "options": [
            "The test is now correct and can be committed",
            "The failure was a timing artifact with no cause",
            "The bug depends on parallel execution, so it is shared state or a scheduling assumption, and the fix is isolation",
            "The test runner is buggy"
          ],
          "answer": 2,
          "explain": "Serialising removes concurrency, which is the condition the bug needs. It hides the defect and doubles the suite runtime; the fix is per-test isolation."
        },
        {
          "q": "What does loom give you that ten thousand reruns do not?",
          "options": [
            "Automatic fixes for data races",
            "Faster execution of the same test",
            "Coverage measurements for concurrent code",
            "A deterministic search over interleavings plus a reproducible failing schedule"
          ],
          "answer": 3,
          "explain": "Reruns sample schedules blindly. Loom explores them systematically and can dump the exact one that failed, which is what makes the bug debuggable."
        }
      ],
      "quickbytes": [
        "Measure the rate over 200 runs before changing anything; 20 runs proves nothing.",
        "Parallel test threads share globals: port 0, per-test temp dirs, injected clock and seed.",
        "loom for schedules, rr for real binaries, retries for neither."
      ],
      "github": [
        {
          "name": "tokio-rs/loom - deterministic exploration of thread interleavings",
          "url": "https://github.com/tokio-rs/loom"
        },
        {
          "name": "nextest-rs/nextest - process-per-test isolation and flake reporting",
          "url": "https://github.com/nextest-rs/nextest"
        }
      ],
      "resources": [
        {
          "title": "Understanding Flaky Tests: The Developer's Perspective (FSE 2019)",
          "url": "https://arxiv.org/abs/1907.01466",
          "kind": "paper"
        },
        {
          "title": "An Empirical Study of Flaky Tests in Python (ICST 2021) - the 170-rerun result",
          "url": "https://arxiv.org/abs/2101.09077",
          "kind": "paper"
        },
        {
          "title": "loom documentation: checkpoints, LOOM_LOG and preemption bounds",
          "url": "https://docs.rs/loom/latest/loom/",
          "kind": "docs"
        },
        {
          "title": "rr-debugger/rr - record and replay executions deterministically",
          "url": "https://github.com/rr-debugger/rr",
          "kind": "repo"
        },
        {
          "title": "nextest-rs/nextest - test isolation and rerun reporting",
          "url": "https://github.com/nextest-rs/nextest",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "dg13",
      "n": 13,
      "title": "Performance regressions: prove it, localize it, gate it",
      "minutes": 90,
      "level": "industry",
      "goal": "Establish a baseline before explaining a slowdown, localize it with a profile rather than intuition, and bisect it with a statistical gate that tolerates noise.",
      "sections": [
        {
          "h": "Prove the regression before you explain it",
          "p": [
            "A performance complaint is a number without a baseline. Before profiling, establish four things: which operation, on which input, measured how, and what the number was last week. criterion gives a statistical comparison against a saved baseline, and hyperfine gives wall-clock timings for a CLI with warmup and outlier detection. Both will tell you the difference is not significant when it is not, which is the part hand-timed runs get wrong.",
            "Noise sources to control: CPU frequency scaling, a shared CI runner, another build running, debug assertions left on, and allocator state. Pin the core if you can, run before and after on the same machine, and compare medians of at least three runs. A three percent difference measured once is not a regression; a thirty percent difference measured three times is."
          ],
          "code": `// benches/checkout.rs
use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};

fn bench_checkout(c: &mut Criterion) {
    let mut group = c.benchmark_group("checkout");
    group.sample_size(50);

    for lines in [1usize, 10, 100] {
        let order = fixture_order(lines);
        group.bench_with_input(BenchmarkId::new("lines", lines), &order, |b, order| {
            b.iter(|| black_box(checkout_total(black_box(order))));
        });
    }
    group.finish();
}

criterion_group!(benches, bench_checkout);
criterion_main!(benches);

// Baseline, then compare:
//   cargo bench --bench checkout -- --save-baseline before
//   cargo bench --bench checkout -- --baseline before`,
          "tip": "Save the baseline on the same machine and toolchain as the comparison; criterion's change estimates assume that."
        },
        {
          "h": "Localize with a profile, not with intuition",
          "p": [
            "A flamegraph shows where samples landed: width is time, depth is the call stack. perf record -F 997 -g -- ./target/release/checkout followed by perf script | inferno-flamegraph > out.svg gives you one, and cargo flamegraph wraps both commands. Read the widest frame you own; the frames below it are usually allocator, memcpy or the kernel, and those are consequences rather than causes.",
            "Sampling frequency is a trade: 99Hz is cheap and enough for a hot loop, while 997Hz resolves short requests at a higher overhead. For off-CPU time - waiting on a lock, a socket, a disk - a CPU flamegraph shows nothing at all, and you need off-CPU sampling or a span that measures the wait directly. A latency regression is frequently an off-CPU story."
          ],
          "code": `# CPU profile of a release binary, symbolized, then rendered.
perf record -F 997 -g -- ./target/release/checkout --replay load.json
perf script | inferno-flamegraph > checkout-cpu.svg

# Or let cargo-flamegraph drive perf:
cargo flamegraph --bin checkout -- --replay load.json -o checkout.svg

# Off-CPU: where the time goes when the thread is not running.
perf record -e offcpu-time -g -- ./target/release/checkout --replay load.json
perf script | inferno-flamegraph --color=io > checkout-offcpu.svg`,
          "tip": "Diff two flamegraphs rather than reading one: inferno can collapse and diff stacks, which shows the frames that grew, not the frames that are big."
        },
        {
          "h": "Bisect the regression with a statistical gate",
          "p": [
            "Once you can measure, git bisect run finds the commit, but the predicate must tolerate noise: run the benchmark three times, take the median, and fail only above a threshold. A gate that fires on a two percent wobble names a random commit and wastes an afternoon; a gate at ten percent with three runs is slower per step and much more likely to be right.",
            "Keep the gate afterwards. A bench job that runs on every merge and comments the delta turns it got slower last month into PR 4412 made checkout twelve percent slower, which is a conversation you can have while the author still remembers the change. Benchmarks that only run on demand are documentation, not a gate."
          ]
        }
      ],
      "exercise": {
        "prompt": "Write scripts/bench_gate.sh that runs the checkout benchmark three times, compares the median against a stored baseline, and exits 1 only above a 10% regression, 125 if the baseline is missing.",
        "starter": `#!/usr/bin/env bash
# scripts/bench_gate.sh - exit 0 no regression, 1 regression, 125 cannot decide
set -uo pipefail

# 1. fail closed to 125 when the baseline file is absent
# 2. run the bench three times and take the median
# 3. compare against the baseline with a 10% threshold`,
        "hint": "Have criterion write machine-readable output (--message-format json) or parse the saved estimates file; parsing the human table is brittle. Median of three is enough here because the threshold is wide.",
        "solution": `#!/usr/bin/env bash
# scripts/bench_gate.sh - exit 0 ok, 1 regression, 125 cannot decide.
set -uo pipefail

BASE=target/criterion/checkout/lines/100/before/estimates.json
CURR=target/criterion/checkout/lines/100/new/estimates.json
THRESHOLD=0.10

if [[ ! -f "$BASE" ]]; then
  echo "skip: no baseline at $BASE (run with --save-baseline before)" >&2
  exit 125
fi

point_estimate() {
  python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['mean']['point_estimate'])" "$1"
}

baseline=$(point_estimate "$BASE") || exit 125

medians=()
for run in 1 2 3; do
  if ! cargo bench --quiet --bench checkout -- --baseline before >/dev/null 2>&1; then
    echo "skip: bench run $run failed" >&2
    exit 125
  fi
  medians+=("$(point_estimate "$CURR")")
done

median=$(printf '%s\\n' "\${medians[@]}" | sort -n | sed -n '2p')
delta=$(python3 -c "import sys;b=float(sys.argv[1]);m=float(sys.argv[2]);print(f'{(m-b)/b:.2%}')" "$baseline" "$median")
over=$(python3 -c "import sys;b=float(sys.argv[1]);m=float(sys.argv[2]);print(int((m-b)/b > float(sys.argv[3])))" "$baseline" "$median" "$THRESHOLD")

echo "baseline=$baseline median=$median delta=$delta"

if [[ "$over" == "1" ]]; then
  echo "regression: $delta exceeds the \${THRESHOLD} threshold" >&2
  exit 1
fi
exit 0
`
      },
      "production": [
        "Every service benchmarks three or four hot paths against saved baselines on a dedicated runner.",
        "Release and benchmark builds use the same profile; comparing a debug build to a release build is rejected in review.",
        "A bench gate comments the delta on each PR and blocks merges above the agreed threshold.",
        "Latency regressions are bisected with a median-of-three gate and logged like any other bisect."
      ],
      "crates": [
        "criterion",
        "pprof",
        "inferno"
      ],
      "pitfall": "Benchmarking on a shared CI runner and trusting a single run: the delta is dominated by a noisy neighbour, the gate fires on the wrong PR, and the team disables the gate within a month.",
      "questions": [
        {
          "q": "A single benchmark run shows a 6% slowdown. What is the correct conclusion?",
          "options": [
            "Nothing yet: repeat under controlled conditions and use a statistical comparison",
            "It is a regression and should block the merge",
            "The change is fine because 6% is small",
            "The benchmark itself must be broken"
          ],
          "answer": 0,
          "explain": "One measurement cannot separate the change from run-to-run noise. criterion's comparison or a median of several runs is what turns a delta into evidence."
        },
        {
          "q": "A flamegraph is dominated by memcpy. What does that tell you?",
          "options": [
            "The profiler is misconfigured",
            "Time is going into copying; look at the callers for buffer growth, serialization or needless clones",
            "The allocator should be replaced",
            "memcpy is the bug and should be optimized"
          ],
          "answer": 1,
          "explain": "memcpy is a consequence. Its callers are the actionable frames, and the usual causes are repeated Vec growth, serialization into intermediate buffers, or clones that could borrow."
        },
        {
          "q": "Why does an off-CPU profile matter for a latency regression?",
          "options": [
            "It captures allocations",
            "It measures cache misses more accurately",
            "CPU profiles miss time spent waiting, and latency regressions are often lock, socket or disk waits",
            "It runs faster than a CPU profile"
          ],
          "answer": 2,
          "explain": "A thread blocked on a lock or a socket is not on the CPU, so it never appears in a CPU sample. Off-CPU sampling or spans that measure the wait are the only views of that time."
        }
      ],
      "quickbytes": [
        "Baseline first: which operation, which input, measured how, and the number last week.",
        "Read the widest frame you own; allocator and memcpy frames are consequences.",
        "A perf bisect needs a median of three and a threshold, or it names innocent commits."
      ],
      "github": [
        {
          "name": "bheisler/criterion.rs - statistics-driven benchmarking",
          "url": "https://github.com/bheisler/criterion.rs"
        },
        {
          "name": "flamegraph-rs/flamegraph - cargo flamegraph",
          "url": "https://github.com/flamegraph-rs/flamegraph"
        }
      ],
      "resources": [
        {
          "title": "perf-record(1) - sampling frequency, call graphs and off-CPU recording",
          "url": "https://man7.org/linux/man-pages/man1/perf-record.1.html",
          "kind": "docs"
        },
        {
          "title": "flamegraph-rs/flamegraph - easy flamegraphs for Rust projects",
          "url": "https://github.com/flamegraph-rs/flamegraph",
          "kind": "repo"
        },
        {
          "title": "bheisler/criterion.rs - statistical benchmarking for Rust",
          "url": "https://github.com/bheisler/criterion.rs",
          "kind": "repo"
        },
        {
          "title": "jonhoo/inferno - Rust port of FlameGraph, with diff support",
          "url": "https://github.com/jonhoo/inferno",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "dg14",
      "n": 14,
      "title": "Production debugging without making it worse",
      "minutes": 85,
      "level": "industry",
      "goal": "Work up the instrumentation ladder from least to most invasive, bound the blast radius of every action, and ship debug endpoints that are safe enough to leave in the build.",
      "sections": [
        {
          "h": "The ladder: cheapest and least invasive first",
          "p": [
            "Debugging production is an exercise in not making it worse. Work up a ladder: metrics, then traces, then targeted logs, then a snapshot (profile, heap, task dump), then attaching a debugger, then restarting with more instrumentation. Each rung costs more and disturbs more, so stop at the first rung that answers the question. Most incidents are resolved on the first two.",
            "Attaching gdb stops every thread in the process, which can trip a liveness probe, blow a latency SLO, and cause the orchestrator to kill the very pod you were investigating. That is not a reason never to do it; it is a reason to do it on one canary, for seconds, with -batch, after telling the incident channel what you are about to do."
          ]
        },
        {
          "h": "Blast radius controls",
          "p": [
            "Every production action needs a scope and an undo. Scope: one pod, one tenant, one percent of traffic. Undo: the flag goes back, the level returns to INFO, the debug container exits with the pod. Time box it too, because debug endpoint enabled for fifteen minutes beats debug endpoint enabled while we look, and the second one is still enabled next quarter.",
            "Prefer instruments that are already deployed and gated over instruments you install during an incident. A pprof endpoint behind an admin token, a heap snapshot on a signal, a console listener bound to localhost only: these turn a forty-minute build-and-deploy into a forty-second action, and they can be tested in staging before you need them."
          ],
          "code": `use std::time::Duration;
use subtle::ConstantTimeEq;

pub struct DebugGate {
    token: String,
    enabled: bool,
}

impl DebugGate {
    pub fn authorize(&self, presented: &str) -> bool {
        self.enabled && presented.as_bytes().ct_eq(self.token.as_bytes()).into()
    }
}

/// Sample for at most 30s, then render a flamegraph. Guarded and time-boxed so
/// it cannot be left sampling by accident. Needs the flamegraph feature enabled.
pub async fn capture_flamegraph(
    gate: &DebugGate,
    token: &str,
    secs: u64,
) -> Result<Vec<u8>, String> {
    if !gate.authorize(token) {
        return Err("debug endpoint disabled or token rejected".into());
    }
    let guard = pprof::ProfilerGuardBuilder::default()
        .frequency(99)
        .blocklist(&["libc", "libgcc", "pthread", "vdso"])
        .build()
        .map_err(|e| e.to_string())?;

    tokio::time::sleep(Duration::from_secs(secs.min(30))).await;

    let report = guard.report().build().map_err(|e| e.to_string())?;
    let mut svg = Vec::new();
    report.flamegraph(&mut svg).map_err(|e| e.to_string())?;
    Ok(svg)
}`,
          "tip": "Gate on a token AND a feature flag: the flag is the kill switch when the endpoint itself misbehaves."
        },
        {
          "h": "Evidence you can keep",
          "p": [
            "A production investigation produces artifacts that outlive the incident: trace ids, the exact queries, the profile, the timeline. Capture them in the incident doc as you go, because the pod is deleted and log retention is fourteen days. The postmortem in dg17 is far cheaper to write from notes taken during the incident than from memory two days later.",
            "Sanitize as you copy. A profile can contain symbol names with tenant identifiers, a heap snapshot can contain tokens, and a log excerpt can contain customer data. Paste ids and aggregates into the incident doc, keep the raw artifacts in the restricted bucket, and set an expiry on both."
          ]
        }
      ],
      "exercise": {
        "prompt": "Design the debug surface for a Rust service: which instruments are always on, which are gated, and what each requires. Then implement the gate that decides whether a profile request is allowed.",
        "starter": `pub struct DebugGate {
    token: String,
    enabled: bool,
}

impl DebugGate {
    pub fn authorize(&self, presented: &str) -> bool {
        // 1. disabled means deny, regardless of token
        // 2. compare in constant time
        todo!()
    }
}`,
        "hint": "A plain == on a secret leaks timing information. subtle::ConstantTimeEq is the small dependency that removes the question, and a feature flag plus a token means one control can fail without opening the endpoint.",
        "solution": `use subtle::ConstantTimeEq;

pub struct DebugGate {
    token: String,
    enabled: bool,
}

impl DebugGate {
    pub fn from_env() -> Self {
        Self {
            token: std::env::var("DEBUG_TOKEN").unwrap_or_default(),
            enabled: std::env::var("DEBUG_ENDPOINTS").as_deref() == Ok("1"),
        }
    }

    pub fn authorize(&self, presented: &str) -> bool {
        if !self.enabled || self.token.is_empty() {
            return false;
        }
        presented.as_bytes().ct_eq(self.token.as_bytes()).into()
    }
}

// Always on:   metrics, traces at the configured sample rate, INFO events.
// Gated:       DEBUG/TRACE filters (scoped + TTL), pprof flamegraph (30s max),
//              tokio-console listener (localhost only, never on the LB).
// Never:       interactive gdb on a pod serving traffic; batch snapshots only.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_gate_denies_even_with_the_right_token() {
        let gate = DebugGate { token: "s3cret".into(), enabled: false };
        assert!(!gate.authorize("s3cret"));
    }

    #[test]
    fn enabled_gate_accepts_only_the_exact_token() {
        let gate = DebugGate { token: "s3cret".into(), enabled: true };
        assert!(gate.authorize("s3cret"));
        assert!(!gate.authorize("s3cre"));
    }
}`
      },
      "production": [
        "Debug endpoints compile behind a feature flag, default off, require a token, and are time-boxed.",
        "Attaching to production needs approval, a named pod and a batch command; interactive sessions on live traffic are banned.",
        "Log level changes are scoped to a tenant or route and revert automatically after a TTL.",
        "Every investigation leaves trace ids, queries and artifacts in the incident doc before the pod is replaced."
      ],
      "crates": [
        "pprof",
        "tokio",
        "subtle"
      ],
      "pitfall": "Running an interactive gdb session on a pod that is serving traffic: every thread stops, the liveness probe times out, the orchestrator restarts the pod, and the evidence you were collecting is destroyed by your own investigation.",
      "questions": [
        {
          "q": "Why is attaching a debugger to a production pod riskier than reading its traces?",
          "options": [
            "It requires a rebuild of the binary",
            "It disables tracing for the whole process",
            "It corrupts the process memory",
            "It freezes every thread for the duration, which can blow latency budgets and trip liveness probes"
          ],
          "answer": 3,
          "explain": "ptrace stops the process. A milliseconds-long batch snapshot is usually survivable; an interactive session on live traffic risks the pod being restarted mid-investigation."
        },
        {
          "q": "Which control most limits the blast radius of turning on DEBUG logs?",
          "options": [
            "Scoping the directive to a tenant or route, adding a TTL, and sampling",
            "Increasing log retention first",
            "Asking the on-call to review the volume afterwards",
            "Turning it on for the whole fleet but watching the dashboard"
          ],
          "answer": 0,
          "explain": "Scope, time box and sampling bound both the volume and the number of affected requests. Watching a dashboard is not a control; it is a hope."
        },
        {
          "q": "What makes a gated debug endpoint safe enough to leave compiled into a release?",
          "options": [
            "It is only reachable from the cluster network",
            "Feature flag default off, token auth with constant-time comparison, and a hard time box",
            "It is only documented in the runbook",
            "It listens on a non-standard port"
          ],
          "answer": 1,
          "explain": "Two independent controls plus a bounded run time mean a single mistake does not expose the endpoint. Network position alone is not a control once anything else in the cluster is compromised."
        }
      ],
      "quickbytes": [
        "Ladder: metrics, traces, logs, snapshot, debugger. Stop at the first rung that answers the question.",
        "Every production action gets a scope, an undo and a time box before you start.",
        "Gate debug endpoints on a flag and a token; make the flag the kill switch."
      ],
      "github": [
        {
          "name": "flamegraph-rs/flamegraph - profiling that can run behind a guarded endpoint",
          "url": "https://github.com/flamegraph-rs/flamegraph"
        },
        {
          "name": "tokio-rs/tokio - runtime whose task dump is the async equivalent of a thread dump",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "resources": [
        {
          "title": "perf-record(1) - what an on-demand profile costs and requires",
          "url": "https://man7.org/linux/man-pages/man1/perf-record.1.html",
          "kind": "docs"
        },
        {
          "title": "flamegraph-rs/flamegraph - cargo flamegraph",
          "url": "https://github.com/flamegraph-rs/flamegraph",
          "kind": "repo"
        },
        {
          "title": "tokio-rs/tokio - runtime and task instrumentation",
          "url": "https://github.com/tokio-rs/tokio",
          "kind": "repo"
        },
        {
          "title": "tracing crate documentation - scoped filters for temporary verbosity",
          "url": "https://docs.rs/tracing/latest/tracing/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "dg15",
      "n": 15,
      "title": "Feature flags and kill switches as debugging instruments",
      "minutes": 70,
      "level": "industry",
      "goal": "Use a flag flip as a reversible runtime bisect, design a kill switch that still works when the failing dependency is the flag service, and retire flags before they become debt.",
      "sections": [
        {
          "h": "A flag is a runtime bisect",
          "p": [
            "Commit bisect finds the change; flag bisect finds the configuration. When a failure correlates with a cohort - one region, one plan tier, one app version - the flag snapshot is the fastest axis to search, and flipping one flag on one canary is reversible in seconds where a revert is a deploy. That reversibility is the whole point: a kill switch is a debugging instrument that also happens to be an operational control.",
            "Distinguish three things that all look like flags. A release flag hides unfinished work and should die in weeks. An experiment flag splits traffic and needs a statistical design. A kill switch disables a dependency or code path under stress and must be boring, tested and rarely used. Mixing them in one system is how a kill switch ends up depending on the service it is meant to disable."
          ]
        },
        {
          "h": "Designing a kill switch that works when everything is on fire",
          "p": [
            "Requirements that matter: default-off semantics, so the absence of configuration means the safe path; evaluation that cannot block, because a cached local value cannot fail; independence from the failing dependency, because the flag service must not be the thing you are disabling; and propagation measured in seconds with a known staleness bound. If flipping the switch needs a deploy, it is not a kill switch.",
            "Then test it. A switch that has never been flipped is a guess. Run a game day where you disable the payment adapter on one canary and confirm the fallback works, the alert fires correctly, and the flag shows up in the trace. The failure mode you are protecting against is discovering that the fallback has been broken for a year."
          ],
          "list": [
            "Default off: missing or malformed config never enables the risky path",
            "Evaluation is a local read with a documented staleness bound",
            "The control plane is independent of the path being disabled",
            "The switch is exercised in a game day at least twice a year"
          ]
        },
        {
          "h": "Flags in the trace, and flag debt",
          "p": [
            "Record the flag values that affected a request in the span or the log line. Without it, two requests with identical inputs produce different outcomes and the trace cannot explain why; with it, this only happens when inventory.reserve_v2=true becomes a query rather than a hypothesis. It also makes the flag's blast radius measurable before you remove it.",
            "Every flag is a branch pair that must be tested, so debt compounds quietly. Give each flag an owner and an expiry, alert when a flag passes expiry, and delete the losing branch the week the rollout finishes. A codebase with forty live flags has 2^40 configurations, of which you test two."
          ],
          "code": `#[derive(Clone, Copy, Debug)]
pub struct Flags {
    pub inventory_reserve_v2: bool,
    pub payments_adapter_down: bool,
}

impl Flags {
    /// Absence of configuration means the safe path: a flag is only on when
    /// explicitly set to a true value, and a malformed value never enables it.
    pub fn from_env() -> Self {
        Self {
            inventory_reserve_v2: env_flag("INVENTORY_RESERVE_V2"),
            payments_adapter_down: env_flag("PAYMENTS_ADAPTER_DOWN"),
        }
    }
}

fn env_flag(name: &str) -> bool {
    matches!(std::env::var(name).as_deref(), Ok("1") | Ok("true"))
}

#[tracing::instrument(
    skip_all,
    fields(
        flag.inventory_reserve_v2 = flags.inventory_reserve_v2,
        flag.payments_adapter_down = flags.payments_adapter_down,
    )
)]
pub async fn checkout(flags: Flags, cart: Cart) -> Result<Receipt, CheckoutError> {
    if flags.payments_adapter_down {
        return fallback_authorize(cart).await;
    }
    authorize(cart).await
}`,
          "tip": "Log the flag snapshot on every error report, not just in spans; the support ticket rarely has the trace id."
        }
      ],
      "exercise": {
        "prompt": "Add a kill switch that bypasses a slow recommendation service with a cached fallback: default off, recorded in the span, and covered by a test that asserts the fallback path is taken when the switch is on.",
        "starter": `#[derive(Clone, Copy, Debug)]
pub struct Flags {
    pub recommendations_bypassed: bool,
}

pub async fn recommendations(flags: Flags, user: User) -> Result<Vec<Item>, RecError> {
    // 1. when the switch is on, serve the cached fallback
    // 2. record the flag value in the span
    todo!()
}`,
        "hint": "The fallback must not call the slow service at all, and it must not be able to fail in a new way: a cached list plus a static default is enough. Test both branches explicitly.",
        "solution": `#[derive(Clone, Copy, Debug)]
pub struct Flags {
    pub recommendations_bypassed: bool,
}

#[tracing::instrument(
    skip_all,
    fields(flag.recommendations_bypassed = flags.recommendations_bypassed, user.id = %user.id)
)]
pub async fn recommendations(flags: Flags, user: User) -> Result<Vec<Item>, RecError> {
    if flags.recommendations_bypassed {
        // Cached, bounded, and independent of the service being disabled.
        return Ok(user.cached_recommendations.take(20));
    }
    client::fetch_recommendations(&user).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bypass_serves_cache_without_calling_the_service() {
        let user = User::fixture_with_cache(vec![Item::fixture("sku-1")]);
        let flags = Flags { recommendations_bypassed: true };

        let items = recommendations(flags, user).await.unwrap();

        assert_eq!(items.len(), 1, "cache should be served as-is");
        // The client is not running in this test: a call would error or hang.
    }

    #[tokio::test]
    async fn switch_off_uses_the_service() {
        let user = User::fixture_with_cache(vec![Item::fixture("sku-1")]);
        let flags = Flags { recommendations_bypassed: false };

        let result = recommendations(flags, user).await;
        assert!(result.is_err(), "no service is running, so this must fail");
    }
}`
      },
      "production": [
        "Every flag has an owner, an expiry date, and an alert when it passes expiry.",
        "Kill switches are exercised in a game day at least twice a year, including the fallback path.",
        "Flag evaluation is a local cached read with a documented staleness bound; no network call on the request path.",
        "The flag snapshot is attached to every error report and to the incident timeline."
      ],
      "crates": [
        "tracing",
        "arc-swap",
        "serde"
      ],
      "pitfall": "A kill switch whose flag lookup calls the same control-plane service that is failing: the switch cannot be evaluated during the incident it was built for, and everyone discovers it at the worst moment.",
      "questions": [
        {
          "q": "What separates a kill switch from a release flag?",
          "options": [
            "Kill switches are stored in code, release flags in a database",
            "Kill switches are per-user, release flags are global",
            "A kill switch must be safe under stress, independent of the failing path, and long-lived; a release flag is short-lived",
            "There is no difference; the terms are interchangeable"
          ],
          "answer": 2,
          "explain": "The lifetime and the failure semantics differ. A kill switch is evaluated when everything else is broken, so its own dependencies and default behaviour are the design constraints."
        },
        {
          "q": "Why must flag evaluation never block on a network call?",
          "options": [
            "Network calls are slower than disk reads",
            "It breaks the tracing context",
            "It makes the code harder to read",
            "The control plane can be the failing dependency, so a blocking read turns a flag outage into a request outage"
          ],
          "answer": 3,
          "explain": "A cached local value cannot fail. A synchronous remote read puts the flag service on the critical path of every request, which is precisely the dependency a kill switch must not have."
        },
        {
          "q": "Why record flag values in spans?",
          "options": [
            "Identical inputs can diverge because of configuration, and without the value the trace cannot explain the outcome",
            "They are required by the tracing specification",
            "They are needed for billing",
            "It reduces log volume"
          ],
          "answer": 0,
          "explain": "Two requests with the same input and different results are unexplainable without the configuration that differed. The flag value is the cheapest way to make that difference queryable."
        }
      ],
      "quickbytes": [
        "A flag flip is a reversible bisect over configuration; use it before a revert.",
        "Default off, local evaluation, independent control plane, tested fallback.",
        "Every flag gets an owner and an expiry, or it becomes a permanent branch pair."
      ],
      "github": [
        {
          "name": "tokio-rs/tracing - recording flag values as span fields",
          "url": "https://github.com/tokio-rs/tracing"
        },
        {
          "name": "tokio-rs/tokio - async service shape the switch lives in",
          "url": "https://github.com/tokio-rs/tokio"
        }
      ],
      "resources": [
        {
          "title": "tracing crate documentation: fields and instrument",
          "url": "https://docs.rs/tracing/latest/tracing/",
          "kind": "docs"
        },
        {
          "title": "tracing::instrument - recording configuration as span fields",
          "url": "https://docs.rs/tracing/latest/tracing/attr.instrument.html",
          "kind": "docs"
        },
        {
          "title": "tokio-rs/tracing repository",
          "url": "https://github.com/tokio-rs/tracing",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "dg16",
      "n": 16,
      "title": "Root cause analysis: from symptom to mechanism",
      "minutes": 80,
      "level": "industry",
      "goal": "Separate symptom, fault and mechanism, test the cause with a counterfactual, and stop the why-chain at something you can change and verify.",
      "sections": [
        {
          "h": "Symptom, fault and mechanism are three different things",
          "p": [
            "A symptom is what users saw: twelve percent of checkouts timed out. A fault is the defect: a connection pool sized for one replica's concurrency. A mechanism is the chain that connects them: a deploy doubled the replica count, each replica opened its own pool of twenty, the database limit of one hundred connections was reached, new connections waited thirty seconds, and the request deadline expired. An analysis that stops at the pool was too small has not explained why it worked for six months.",
            "The mechanism is the only part a test can falsify. Pool size twenty per replica with eight replicas exceeds max_connections one hundred is a statement you can encode as an assertion. We had a capacity issue is not, which is why it produces action items like add monitoring that do not prevent the next incident."
          ]
        },
        {
          "h": "The counterfactual is the test of the cause",
          "p": [
            "Ask: if I change only this, does the symptom disappear? Revert the suspect line, or set the suspect config back, and re-run the reproducer. If the symptom persists, the cause is elsewhere and the confident explanation was a story. This is the same move as a controlled experiment, and it is skipped precisely when everyone is most certain.",
            "Counterfactuals also bound the cause. If reverting the pool size fixes it but the deploy also added a retry, you have two candidate mechanisms and one experiment that does not separate them. Change one variable at a time even during an incident, or you will write a postmortem about the wrong thing."
          ],
          "list": [
            "State the mechanism as a chain of falsifiable claims, each with evidence attached",
            "Change one variable and re-run the reproducer",
            "Separate the trigger (the deploy) from the latent defect (the pool sizing)",
            "Name the detection gap separately from the cause"
          ]
        },
        {
          "h": "Five whys is a chain, not a quiz",
          "p": [
            "The technique works when each why is answered with evidence and lands on a mechanism. It fails when it becomes a ritual that ends at human error. Stop when you reach something you can change and test: a default, a limit, a check, an alert threshold. Going further usually produces philosophy; stopping earlier usually produces a patch that does not hold.",
            "Distributed incidents rarely have one root cause. They have a trigger, one or more latent conditions, and a detection gap. Write all three. An analysis that names a single cause will produce a single action item, and the latent condition that made the trigger dangerous will still be there next quarter."
          ],
          "code": `// tests/rca_pool_exhaustion.rs
// Mechanism, as falsifiable claims:
//   1. replicas * per_replica_pool <= database.max_connections
//   2. a wait for a connection must fit inside the request deadline
// The incident violated both after the replica count doubled.
use std::time::Duration;

#[test]
fn pool_math_exceeds_database_limit() {
    let replicas = 8u32;
    let per_replica_pool = 20u32;
    let max_connections = 100u32;
    let connect_timeout = Duration::from_secs(30);
    let request_deadline = Duration::from_secs(5);

    assert!(
        replicas * per_replica_pool <= max_connections,
        "{replicas} replicas x {per_replica_pool} = {} connections exceeds max_connections {max_connections}",
        replicas * per_replica_pool
    );
    assert!(
        connect_timeout < request_deadline,
        "waiting {connect_timeout:?} for a connection cannot fit in a {request_deadline:?} deadline"
    );
}`,
          "tip": "If the mechanism cannot be written as arithmetic or an assertion, it is probably still a symptom in disguise."
        }
      ],
      "exercise": {
        "prompt": "Latency doubled after enabling a flag. Write the mechanism as a chain of falsifiable claims, then encode the part that is arithmetic as a test that fails on the pre-fix configuration.",
        "starter": `// tests/rca_flag_latency.rs
// 1. list the claims in order, each with the evidence that supports it
// 2. encode the arithmetic claims as assertions
#[test]
fn flag_doubles_work_per_request() {
    todo!()
}`,
        "hint": "The chain usually looks like: flag on -> second call added -> calls per request doubles -> pool wait doubles -> p99 exceeds deadline. Only the middle steps are arithmetic; the first needs a trace, the last needs a latency measurement.",
        "solution": `// tests/rca_flag_latency.rs
// Claims, each with the evidence that supports it:
//   1. flag.enrich_v2 adds a second pricing call per request      (trace: 2 child spans)
//   2. the extra call shares the same bounded pool                (config: pool=20)
//   3. pool wait therefore doubles at constant throughput         (arithmetic, below)
//   4. doubled wait exceeds the 250ms budget at p99                (latency measurement)
use std::time::Duration;

const POOL_SIZE: u32 = 20;
const BASE_RPS: u32 = 400;
const BASE_CALLS_PER_REQUEST: u32 = 1;
const BASE_CALL_LATENCY: Duration = Duration::from_millis(20);
const P99_BUDGET: Duration = Duration::from_millis(250);

fn pool_wait(calls_per_request: u32) -> Duration {
    let demand = BASE_RPS * calls_per_request;
    let service_capacity = POOL_SIZE * (1000 / BASE_CALL_LATENCY.as_millis() as u32);
    let queue = demand.saturating_sub(service_capacity);
    BASE_CALL_LATENCY * (queue / POOL_SIZE.max(1))
}

#[test]
fn enabling_the_flag_pushes_pool_wait_over_budget() {
    let before = pool_wait(BASE_CALLS_PER_REQUEST);
    let after = pool_wait(BASE_CALLS_PER_REQUEST + 1);

    assert!(before < P99_BUDGET, "baseline wait {before:?} should fit the budget");
    assert!(
        after > P99_BUDGET,
        "with the flag on, wait {after:?} must exceed the {P99_BUDGET:?} budget; \
         this is the mechanism, not the symptom"
    );
}`
      },
      "production": [
        "Every P1 analysis names trigger, latent conditions and detection gap as separate sections.",
        "The mechanism is encoded as a test or assertion wherever the arithmetic allows.",
        "Counterfactual evidence (revert, replay, re-measure) is quoted in the analysis, not summarized.",
        "Analyses are reviewed by someone who was not on call for the incident."
      ],
      "crates": [
        "tracing",
        "serde",
        "serde_json"
      ],
      "pitfall": "Stopping the why-chain at human error: it names nothing you can test, so the action item becomes be more careful and the system that made the mistake consequential is left untouched.",
      "questions": [
        {
          "q": "Which statement is a mechanism rather than a symptom?",
          "options": [
            "Checkout latency increased by 300%",
            "Eight replicas at pool 20 exceed the database limit of 100 connections, so connects queue past the deadline",
            "The database was under pressure",
            "Users reported slow checkouts"
          ],
          "answer": 1,
          "explain": "Only the replica, pool and connection claim is a causal chain with quantities you can assert on. The others describe the observation or restate it with different words."
        },
        {
          "q": "Reverting the suspect change does not make the symptom disappear. What follows?",
          "options": [
            "The symptom must be unrelated to the change",
            "The measurement is wrong",
            "The stated cause is wrong or incomplete; the trigger and the latent condition are probably different things",
            "The revert was applied incorrectly, so try again"
          ],
          "answer": 2,
          "explain": "A counterfactual that fails is information. It says the mechanism you wrote does not account for the failure, which is exactly what you need to know before writing action items."
        },
        {
          "q": "Why is human error a poor place to stop a why-chain?",
          "options": [
            "It is too specific to be actionable",
            "It is unfair to the individual",
            "It is always inaccurate",
            "It is not a mechanism you can test or change, and it ignores why the system made the error consequential"
          ],
          "answer": 3,
          "explain": "The useful question is what allowed a single mistake to cause this impact: a missing default, a limit, a review gate. Those are testable and changeable."
        }
      ],
      "quickbytes": [
        "Symptom, fault, mechanism: only the mechanism can be falsified by a test.",
        "Revert one variable and re-run; a counterfactual that fails is a result.",
        "Stop the why-chain at something you can change and verify."
      ],
      "github": [
        {
          "name": "danluu/post-mortems - a large collection of real incident write-ups",
          "url": "https://github.com/danluu/post-mortems"
        },
        {
          "name": "tokio-rs/tracing - the evidence source for most mechanisms",
          "url": "https://github.com/tokio-rs/tracing"
        }
      ],
      "resources": [
        {
          "title": "Scalable Statistical Root Cause Analysis on App Telemetry (Minesweeper)",
          "url": "https://arxiv.org/abs/2010.09974",
          "kind": "paper"
        },
        {
          "title": "Graph-Free Root Cause Analysis (PRISM) - why the biggest anomaly is not the cause",
          "url": "https://arxiv.org/abs/2601.21359",
          "kind": "paper"
        },
        {
          "title": "danluu/post-mortems - real postmortems to calibrate your mechanism against",
          "url": "https://github.com/danluu/post-mortems",
          "kind": "repo"
        },
        {
          "title": "tracing crate documentation - the evidence you need to state a mechanism",
          "url": "https://docs.rs/tracing/latest/tracing/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "dg17",
      "n": 17,
      "title": "Writing the postmortem and updating the runbook",
      "minutes": 70,
      "level": "industry",
      "goal": "Build a timeline from recorded timestamps, write action items that can be closed and verified, and leave a runbook delta the next responder can actually use.",
      "sections": [
        {
          "h": "The timeline is the evidence",
          "p": [
            "Build the timeline from timestamps that exist - deploy events, alert firings, trace start times, log lines - not from memory. Mark three moments: when the failure started, when a human noticed, and when it stopped affecting users. The gaps between them are three different problems (detection, response, mitigation), and each deserves its own action item rather than one shared we will do better.",
            "Record what you believed at the time, including the wrong turns. A postmortem that presents a straight line from alert to fix teaches nothing and hides the diagnostic that actually worked. The next responder will have the same first two hypotheses, and knowing why they were wrong is worth more than knowing the answer."
          ]
        },
        {
          "h": "Action items that can be closed",
          "p": [
            "An action item is a change to a system with an owner, a date, and a way to verify it landed: add a regression test for the pool arithmetic, alert when connections used exceeds eighty percent of max for five minutes, cap the per-replica pool in the chart template. Be more careful and improve monitoring are not action items; they are moods with a Jira ticket attached.",
            "Rank items by whether they would have prevented, detected, or shortened the incident, and prefer prevention over detection over response. Then schedule them. Unassigned postmortem actions are the most reliable predictor of a repeat incident, so reviewers should treat a postmortem with no dated items as incomplete rather than as a draft."
          ],
          "code": `# alert-rules/checkout.yaml - the alert that would have fired six minutes earlier.
groups:
  - name: checkout
    rules:
      - alert: CheckoutLatencyBudgetBurn
        expr: |
          sum(rate(checkout_request_duration_seconds_bucket{le="1.0"}[5m]))
            / sum(rate(checkout_request_duration_seconds_count[5m])) < 0.95
        for: 5m
        labels:
          severity: page
        annotations:
          summary: "More than 5% of checkouts exceed 1s"
          runbook: "https://runbooks.internal/checkout#latency"

      - alert: DbConnectionsNearLimit
        expr: pg_stat_activity_count / pg_settings_max_connections > 0.8
        for: 5m
        labels:
          severity: ticket
        annotations:
          summary: "Database connections above 80% of max_connections"`,
          "tip": "Write the alert expression into the postmortem and link the rule file. An alert proposed in prose never gets created."
        },
        {
          "h": "Update the runbook, not just the document",
          "p": [
            "The postmortem is for the organization; the runbook is for the person at 3am. Every incident should change a runbook step: a new first check, a corrected command, a removed step that wasted ten minutes. If the runbook was followed and failed, that is a finding. If it was not followed, ask why before writing follow the runbook more closely.",
            "Keep the runbook short and imperative. Check DbConnectionsNearLimit; if firing, lower the per-replica pool in the chart and roll one replica at a time beats three paragraphs of architecture. Link out for the explanation, because the on-call reader has four minutes, one hand, and a phone that is still ringing."
          ]
        }
      ],
      "exercise": {
        "prompt": "Turn an incident summary into a postmortem skeleton: a timestamped timeline with detection and mitigation marked, three action items with owners and verification, and one runbook delta.",
        "starter": `# INC-2026-0314 - checkout latency (draft)

## Impact
## Timeline
## What we believed at the time
## Action items
## Runbook delta`,
        "hint": "Every timeline entry needs a source: a deploy id, an alert timestamp, a trace start. Entries with no source are the ones that turn out to be wrong when someone else reads them.",
        "solution": `# INC-2026-0314 - checkout latency, 29 minutes, 12% of EU checkouts

## Impact
12% of EU checkouts exceeded the 5s deadline from 09:12 to 09:41 UTC.
No data loss; 1,904 requests failed with DEADLINE_EXCEEDED.

## Timeline (all times UTC, sources in parentheses)
- 09:04  deploy 4412 scales checkout 4 -> 8 replicas (deploy log)
- 09:12  p99 crosses 1s; first deadline exceeded (trace 4bf92f35...)
- 09:19  CheckoutLatencyBudgetBurn pages on-call (alertmanager)
- 09:23  first hypothesis: payments provider slow; ruled out, p99 flat at 240ms
- 09:31  DbConnectionsNearLimit observed at 97% (postgres exporter)
- 09:37  pool lowered to 12 on canary; p99 returns to 310ms (canary metrics)
- 09:41  rollout of pool=12 completes; incident mitigated

## What we believed at the time
The payments provider was the first suspect because its latency dashboard
looked spiky at 09:14. It was ruled out by its own p99 series, which never
moved. The next responder should check the connection series first.

## Action items
1. Cap per-replica pool at max_connections/replicas in the chart template.
   Owner: platform. Due: 2026-03-21. Verify: template unit test fails on 8x20.
2. Add DbConnectionsNearLimit alert at 80% for 5m.
   Owner: observability. Due: 2026-03-19. Verify: rule present and firing in staging.
3. Regression test asserting replicas * pool <= max_connections.
   Owner: checkout. Due: 2026-03-18. Verify: test fails on the pre-fix chart.

## Runbook delta
Before: "check payments latency, then database CPU".
After: "check DbConnectionsNearLimit first; if above 80%, lower the per-replica
pool in the chart and roll one replica at a time. Payments p99 is a red herring
for this symptom."`
      },
      "production": [
        "Postmortems are written within five business days and reviewed in a blameless forum.",
        "Every action item has an owner, a date and a verification; undated items are rejected.",
        "Each incident produces at least one runbook change, reviewed by the on-call who was paged.",
        "Postmortems and runbooks live in the repository next to the service, not in a wiki nobody opens."
      ],
      "crates": [
        "tracing",
        "tracing-subscriber",
        "serde_json"
      ],
      "pitfall": "Writing a timeline from memory two days later: the deploy marker moves, the detection gap disappears, and the action items target the response phase instead of the detection phase that actually cost the twenty minutes.",
      "questions": [
        {
          "q": "Which postmortem item is actionable?",
          "options": [
            "Add a chart-template assertion that replicas * pool <= max_connections, owner platform, due 2026-03-21",
            "Improve capacity planning for database connections",
            "Be more careful when scaling services",
            "Increase monitoring coverage across the platform"
          ],
          "answer": 0,
          "explain": "Only the chart-assertion item names a change, an owner, a date and a way to verify. The others cannot be closed or shown to have landed."
        },
        {
          "q": "What does the gap between failure start and human notice measure?",
          "options": [
            "The total incident duration",
            "The detection gap, which needs its own action item separate from response and mitigation",
            "The quality of the postmortem",
            "The response time of the on-call engineer"
          ],
          "answer": 1,
          "explain": "Detection, response and mitigation are three different failures with three different fixes. Collapsing them into one number produces action items aimed at the wrong phase."
        },
        {
          "q": "Why include wrong hypotheses in the timeline?",
          "options": [
            "Because incident policy requires it",
            "To document who was responsible",
            "The next responder will form the same hypotheses, and knowing why they failed shortens the next diagnosis",
            "To show the investigation was thorough"
          ],
          "answer": 2,
          "explain": "A postmortem is a debugging guide for the next person. The dead ends are the most reusable part, because they are the ones that cost time."
        }
      ],
      "quickbytes": [
        "Every timeline entry needs a source; memory is not a source.",
        "Action item = change + owner + date + verification, or it is a mood.",
        "Every incident changes a runbook step, reviewed by the person who was paged."
      ],
      "github": [
        {
          "name": "danluu/post-mortems - a curated collection of real postmortems",
          "url": "https://github.com/danluu/post-mortems"
        },
        {
          "name": "tokio-rs/tracing - the timestamps the timeline is built from",
          "url": "https://github.com/tokio-rs/tracing"
        }
      ],
      "resources": [
        {
          "title": "danluu/post-mortems - calibrate your write-up against real ones",
          "url": "https://github.com/danluu/post-mortems",
          "kind": "repo"
        },
        {
          "title": "Scalable Statistical Root Cause Analysis on App Telemetry (Minesweeper)",
          "url": "https://arxiv.org/abs/2010.09974",
          "kind": "paper"
        },
        {
          "title": "tracing crate documentation - structured events for the timeline",
          "url": "https://docs.rs/tracing/latest/tracing/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "dg18",
      "n": 18,
      "title": "Preventing regressions: guards that actually fail",
      "minutes": 75,
      "level": "industry",
      "goal": "Prove a regression test is real by running it against the old code, pick the guard that matches the failure class, and make the failure message name the bug.",
      "sections": [
        {
          "h": "A regression test that passes on the old code is decoration",
          "p": [
            "The only proof that a guard works is that it fails before the fix and passes after. Check it mechanically: stash the fix, run the new test, watch it fail with the message you expect. Teams routinely add a test that passes both ways because it asserts on the new API's shape rather than on the invariant that broke, and nobody notices until the bug returns.",
            "Mutation testing is the systematic version. cargo-mutants rewrites operators and return values in your code and reports which mutants survive the suite. A surviving mutant is a line your tests do not constrain. It is slow and noisy on legacy code, so run it on the modules that handle money, auth and state transitions rather than everywhere."
          ]
        },
        {
          "h": "Guards beyond unit tests",
          "p": [
            "Match the guard to the failure class. Logic errors get a unit test on the invariant. Parsers get a fuzz target, because the input space is the enemy and cargo-fuzz explores it far better than examples. Concurrency gets a loom model, which explores schedules rather than inputs. Performance gets a bench gate with a threshold. Operations gets an alert on the user-visible symptom.",
            "Bugs that escaped once will escape again in a different form, so guard the class and not just the instance. If the pool arithmetic was wrong, the guard is an assertion in the chart template that applies to every service, not a test for one service's constant. Class-level guards are the difference between fixing a bug and removing a category."
          ],
          "code": `// 1. The instance guard: must fail on the parent commit.
#[test]
fn regression_4412_discount_applied_once() {
    let mut svc = checkout_with(fixture("4412"));
    let key = IdempotencyKey::from("retry-4412");

    let first = svc.place(&key).unwrap();
    let second = svc.place(&key).unwrap();

    assert_eq!(first.total_minor, second.total_minor, "replay changed the total");
    assert_eq!(second.total_minor, 9_000, "10% discount must apply once");
}

// 2. The class guard: an invariant over generated inputs, not one fixture.
proptest! {
    #[test]
    fn total_is_monotonic_in_quantity(qty in 1u32..100, unit in 1i64..10_000) {
        let total = line_total(qty, unit);
        prop_assert!(total >= 0, "negative total for qty={} unit={}", qty, unit);
        prop_assert!(
            total >= (qty as i64 - 1) * unit,
            "total {} below the lower bound for qty={} unit={}", total, qty, unit
        );
    }
}`,
          "tip": "Commit the failing run in the PR description. A reviewer who sees the red output stops asking whether the test is real."
        },
        {
          "h": "Make the failure loud and local",
          "p": [
            "A guard is only useful if the failure message names the problem. assert!(ok) sends the next engineer to a debugger; assert_eq!(second.total_minor, 9_000, replay of {key:?} applied the discount twice) sends them to the bug. Spend the extra line on the message, especially for invariants that only fail in production.",
            "Put cheap assertions on the hot path in debug builds with debug_assert!, and keep the expensive invariant checks in tests. Then make CI run the exact reproducer rather than an approximation: if the bug needed three retries and a specific flag, the test must set that flag, or it will pass forever while the bug ships again."
          ]
        }
      ],
      "exercise": {
        "prompt": "Take the pool-arithmetic bug from dg16 and write two guards: a regression test that fails on the pre-fix configuration, and a class-level guard that catches the same mistake in any service.",
        "starter": `// 1. instance guard: the specific chart values that broke
#[test]
fn chart_pool_exceeds_database_limit() {
    todo!()
}

// 2. class guard: the invariant that applies to every service chart
#[test]
fn every_chart_respects_max_connections() {
    todo!()
}`,
        "hint": "The class guard should read the chart files from the repo and assert the invariant for each one, so adding a new service with a bad pool fails without anyone writing a test.",
        "solution": `use std::fs;
use std::path::Path;

// 1. Instance guard: fails on the chart as it was before the fix.
#[test]
fn chart_pool_exceeds_database_limit() {
    let replicas = 8u32;
    let per_replica_pool = 20u32;
    let max_connections = 100u32;

    assert!(
        replicas * per_replica_pool <= max_connections,
        "{replicas} x {per_replica_pool} = {} exceeds max_connections {max_connections}",
        replicas * per_replica_pool
    );
}

// 2. Class guard: every chart in the repo must satisfy the invariant.
#[test]
fn every_chart_respects_max_connections() {
    let dir = Path::new("deploy/charts");
    let mut checked = 0usize;

    for entry in fs::read_dir(dir).expect("charts directory") {
        let path = entry.expect("dir entry").path().join("values.yaml");
        if !path.exists() {
            continue;
        }
        let text = fs::read_to_string(&path).expect("read values.yaml");
        let replicas: u32 = parse_value(&text, "replicaCount");
        let pool: u32 = parse_value(&text, "db.poolSize");
        let max_connections: u32 = parse_value(&text, "db.maxConnections");

        assert!(
            replicas * pool <= max_connections,
            "{}: {replicas} replicas x {pool} pool = {} exceeds max_connections {max_connections}",
            path.display(),
            replicas * pool
        );
        checked += 1;
    }

    assert!(checked > 0, "no charts were checked; the guard is not wired up");
}

fn parse_value(text: &str, key: &str) -> u32 {
    text.lines()
        .find_map(|line| line.trim().strip_prefix(key)?.trim_start().strip_prefix(':')?.trim().parse().ok())
        .unwrap_or_else(|| panic!("missing key {key}"))
}`
      },
      "production": [
        "Every bug-fix PR includes a test that fails on the parent commit, and reviewers ask for the red run.",
        "cargo-mutants runs nightly on money, auth and state-machine modules with a minimum kill rate.",
        "Parsers carry a cargo-fuzz target seeded with the corpus of past failures.",
        "Chart and config templates assert the invariants behind past incidents, not just the service that broke."
      ],
      "crates": [
        "proptest",
        "cargo-fuzz",
        "cargo-mutants",
        "loom"
      ],
      "pitfall": "A regression test that asserts the fix's implementation detail rather than the broken invariant: it passes on the old code, and it breaks on the next refactor while the original bug returns unnoticed.",
      "questions": [
        {
          "q": "How do you verify that a regression test is real?",
          "options": [
            "Run it twice and check it passes both times",
            "Check that it has an assertion",
            "Confirm it is covered by the coverage report",
            "Run it against the pre-fix code and confirm it fails with the expected message"
          ],
          "answer": 3,
          "explain": "The defining property is failing before the fix. Without that run, a passing test proves only that the current code does something the test accepts."
        },
        {
          "q": "What does a surviving mutant tell you?",
          "options": [
            "The suite does not constrain that line, so a behaviour change there would go unnoticed",
            "The compiler optimized the code away",
            "The test suite is too slow",
            "The mutant is equivalent and can be ignored"
          ],
          "answer": 0,
          "explain": "Some survivors are genuinely equivalent mutants, but the default assumption is a gap. Review each one and either add an assertion or document why the mutation is unobservable."
        },
        {
          "q": "Which guard fits a hand-written parser?",
          "options": [
            "A loom model of the parser's threads",
            "A fuzz target, because the input space cannot be covered by examples",
            "A unit test with three example inputs",
            "A benchmark with a threshold"
          ],
          "answer": 1,
          "explain": "Parsers fail on inputs nobody thought of. cargo-fuzz explores that space and keeps a corpus, which is exactly the class-level guard for this failure mode."
        }
      ],
      "quickbytes": [
        "Stash the fix, run the new test, watch it fail; otherwise it is decoration.",
        "Match the guard to the class: property, fuzz, loom, bench gate, or alert.",
        "Guard the category with a repo-wide assertion, not just the one service that broke."
      ],
      "github": [
        {
          "name": "proptest-rs/proptest - property tests with shrinking",
          "url": "https://github.com/proptest-rs/proptest"
        },
        {
          "name": "rust-fuzz/cargo-fuzz - coverage-guided fuzzing for Rust",
          "url": "https://github.com/rust-fuzz/cargo-fuzz"
        }
      ],
      "resources": [
        {
          "title": "proptest-rs/proptest - property-based testing for Rust",
          "url": "https://github.com/proptest-rs/proptest",
          "kind": "repo"
        },
        {
          "title": "rust-fuzz/cargo-fuzz - command-line helpers for fuzzing",
          "url": "https://github.com/rust-fuzz/cargo-fuzz",
          "kind": "repo"
        },
        {
          "title": "loom documentation - modelling concurrent invariants",
          "url": "https://docs.rs/loom/latest/loom/",
          "kind": "docs"
        },
        {
          "title": "tokio-rs/loom - concurrency permutation testing",
          "url": "https://github.com/tokio-rs/loom",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "dg19",
      "n": 19,
      "title": "The debugging toolbox: what to reach for and when",
      "minutes": 65,
      "level": "core",
      "goal": "Know one command per question, understand what each tool costs and requires, and check what a container image can actually do before an incident forces the question.",
      "sections": [
        {
          "h": "The ladder, restated as a cost table",
          "p": [
            "Every tool trades time-to-answer against setup cost and disturbance. println! is instant and useless under concurrency; a debugger costs minutes of setup and stops the process; a record-replay session costs a slow run and answers questions you did not know to ask; a sanitizer costs a rebuild and finds bugs that never reproduce on demand. Pick by the shape of the unknown, not by familiarity.",
            "Three tools are worth learning cold because they answer questions nothing else does: a debugger for state, perf for where time goes, and strace for what the process asked the kernel for. The rest (cargo expand, cargo tree -d, cargo bloat, Miri, loom, rr) are specialists you reach for when the general tools say not here."
          ],
          "list": [
            "gdb or lldb: break, run, bt, frame, p, watch, info threads, thread apply all bt",
            "perf: record, report, stat, script; render with inferno or cargo-flamegraph",
            "strace -f -e trace=network,file: what the process asked the kernel for",
            "cargo tree -d: duplicate crate versions, the classic two types with one name"
          ]
        },
        {
          "h": "Container and remote constraints",
          "p": [
            "Distroless images have no shell, no ps and no gdb. You cannot install anything into a running pod, and rebuilding the image destroys the failing process. Plan for it: a debug variant of the image with the tools, an ephemeral container sharing the PID namespace, or a host-level tool reading /proc/<pid> through the shared namespace.",
            "Privileges are the other wall. perf needs perf_event_paranoid low enough or CAP_PERFMON; ptrace needs CAP_SYS_PTRACE and a shared PID namespace; eBPF needs CAP_BPF and a modern kernel. Knowing which capability each tool needs saves an hour of operation not permitted in the middle of an incident, when nobody wants to change a security context."
          ],
          "code": `#!/usr/bin/env bash
# scripts/toolbox.sh - what can this host actually do?
set -u

for tool in gdb lldb perf strace rr cargo-flamegraph inferno-flamegraph tokio-console; do
  if path=$(command -v "$tool" 2>/dev/null); then
    echo "$tool -> $path"
  else
    echo "$tool -> MISSING"
  fi
done

echo "--- capabilities ---"
grep -E 'CapEff|NoNewPrivs' /proc/self/status 2>/dev/null || echo "unavailable"

echo "--- perf_event_paranoid (2 = no kernel profiling) ---"
cat /proc/sys/kernel/perf_event_paranoid 2>/dev/null || echo "unavailable"

echo "--- yama ptrace_scope (1 = descendants only) ---"
cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo "unavailable"`,
          "tip": "Run this in CI against the shipped image, not on your laptop; the difference between the two is the incident."
        },
        {
          "h": "Tools that answer what is this code, really",
          "p": [
            "cargo expand shows the macro output, which is the only way to debug a derive that produced the wrong Debug or an #[instrument] that captured the wrong fields. cargo tree -d finds two versions of one crate in the graph, which produces the classic expected foo::Error, found foo::Error with identical-looking paths. cargo bloat and cargo llvm-lines answer why the binary or the compile time grew.",
            "None of these are debugging tools in the narrow sense, and all of them shorten a specific class of investigation from hours to minutes. The pattern is to know one command per question: what did the macro write, what is in my dependency graph, what is in my binary, what did the kernel see, where did the time go."
          ]
        }
      ],
      "exercise": {
        "prompt": "Write scripts/toolbox.sh for your team's image, run it inside the container, and list which tools are missing and which capability blocks each one.",
        "starter": `#!/usr/bin/env bash
# scripts/toolbox.sh
set -u

# 1. check for gdb, perf, strace, rr, cargo-flamegraph
# 2. print the capability and sysctl values that gate them
# 3. exit non-zero if a required tool is missing`,
        "hint": "Make the script fail CI when a tool the runbook depends on is missing. A toolbox check that always exits 0 is documentation, not a gate.",
        "solution": `#!/usr/bin/env bash
# scripts/toolbox.sh - fail CI when an incident tool is missing from the image.
set -u

required=(gdb perf strace)
optional=(lldb rr cargo-flamegraph inferno-flamegraph tokio-console)
missing=0

for tool in "\${required[@]}"; do
  if path=$(command -v "$tool" 2>/dev/null); then
    echo "ok      $tool -> $path"
  else
    echo "MISSING $tool (required)"
    missing=1
  fi
done

for tool in "\${optional[@]}"; do
  if path=$(command -v "$tool" 2>/dev/null); then
    echo "ok      $tool -> $path"
  else
    echo "absent  $tool (optional)"
  fi
done

echo "--- capability and sysctl gates ---"
grep -E 'CapEff|NoNewPrivs' /proc/self/status 2>/dev/null || echo "CapEff unavailable"
echo "perf_event_paranoid: $(cat /proc/sys/kernel/perf_event_paranoid 2>/dev/null || echo unavailable)"
echo "ptrace_scope: $(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo unavailable)"

exit "$missing"`
      },
      "production": [
        "A debug image variant exists for every service, built in CI with gdb, perf, strace and matching symbols.",
        "The toolbox script runs in CI so a missing tool is discovered before an incident, not during one.",
        "Capability requirements (ptrace, perf_event, BPF) are documented per environment.",
        "On-call has a one-page map from symptom class to first tool."
      ],
      "crates": [
        "inferno",
        "addr2line",
        "object"
      ],
      "pitfall": "Discovering in the middle of an incident that the production image is distroless, has no shell, and cannot run any of the tools the runbook references.",
      "questions": [
        {
          "q": "Which tool answers what syscalls this process is making?",
          "options": [
            "perf record",
            "cargo tree -d",
            "strace -f",
            "gdb thread apply all bt"
          ],
          "answer": 2,
          "explain": "strace traces system calls and signals. perf samples where CPU time goes, which is a different question with a different answer."
        },
        {
          "q": "perf record fails with permission denied on a hardened host. What is the likely cause?",
          "options": [
            "The kernel is too old for perf",
            "perf requires a nightly toolchain",
            "The binary lacks debug symbols",
            "perf_event_paranoid is set restrictively, or the container lacks CAP_PERFMON"
          ],
          "answer": 3,
          "explain": "perf needs permission to open performance counters. Either the sysctl blocks unprivileged use or the container's capability set omits what is needed."
        },
        {
          "q": "You see expected foo::Error, found foo::Error with identical paths. What do you run?",
          "options": [
            "cargo tree -d to find two versions of the same crate in the graph",
            "cargo bloat to inspect the binary",
            "cargo clean and rebuild",
            "cargo expand to see the macro output"
          ],
          "answer": 0,
          "explain": "Two semver-incompatible versions of one crate produce two distinct types with the same path. cargo tree -d lists the duplicates and who pulls them in."
        }
      ],
      "quickbytes": [
        "One command per question: state, time, syscalls, dependency graph, macro output.",
        "Check capabilities before the incident: ptrace, perf_event, BPF each need their own grant.",
        "Run the toolbox script in CI against the shipped image, not on your laptop."
      ],
      "github": [
        {
          "name": "flamegraph-rs/flamegraph - cargo flamegraph",
          "url": "https://github.com/flamegraph-rs/flamegraph"
        },
        {
          "name": "rr-debugger/rr - record and replay debugging",
          "url": "https://github.com/rr-debugger/rr"
        }
      ],
      "resources": [
        {
          "title": "perf-record(1) - the sampling entry point for CPU and off-CPU profiles",
          "url": "https://man7.org/linux/man-pages/man1/perf-record.1.html",
          "kind": "docs"
        },
        {
          "title": "gdb(1) - the commands worth knowing cold",
          "url": "https://man7.org/linux/man-pages/man1/gdb.1.html",
          "kind": "docs"
        },
        {
          "title": "jonhoo/inferno - FlameGraph port used by perf script pipelines",
          "url": "https://github.com/jonhoo/inferno",
          "kind": "repo"
        },
        {
          "title": "flamegraph-rs/flamegraph - one-command flamegraphs",
          "url": "https://github.com/flamegraph-rs/flamegraph",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "dg20",
      "n": 20,
      "title": "The debugging checklist: a runbook for hard bugs",
      "minutes": 60,
      "level": "industry",
      "goal": "Run the first fifteen minutes in a fixed order, work a twelve-item checklist with exit criteria, and hand off with a written state that lets someone else continue without the backlog.",
      "sections": [
        {
          "h": "The first fifteen minutes",
          "p": [
            "Before hypotheses, stabilise and capture. Stop the bleeding if users are affected - flag off, roll back, shed load - then capture what is about to disappear: the failing trace ids, the current process state, the exact deploy and flag snapshot, and when the symptom started. Investigating a system that is still degrading produces evidence you will have to throw away.",
            "Then scope it with four questions: who is affected, all or one tenant or one region; what changed, deploy or config or traffic or dependency; when did it start relative to that change; and where in the request path does it stop being healthy. Those four answers usually eliminate most of the search space before anyone reads code."
          ]
        },
        {
          "h": "The checklist",
          "p": [
            "A checklist is not a substitute for thought; it is a way to stop skipping the step you always skip under pressure. Twelve items, each with an exit condition, in an order that keeps you honest: reproduce, scope, correlate with change, read one trace, filter logs, check the failing hop's metrics, diff the config, check dependency health, bisect, state the mechanism, fix, guard.",
            "Each item is answered by a lesson in this track, which is the point: the checklist is an index into technique, not a replacement for it. When an item cannot be completed, that is the finding - a missing reproducer, an untraced hop, or a config you cannot diff is itself an action item for the next incident."
          ],
          "list": [
            "Reproducer exists and fails on demand (dg02)",
            "Scope: who, where, since when (dg01)",
            "What changed: deploy, flag, config, traffic, dependency (dg03, dg15)",
            "One failing trace, end to end (dg11)",
            "Logs filtered by trace id, not by time window (dg05)",
            "Metrics for the failing hop: rate, errors, duration, saturation (dg13)",
            "Config and flag diff between a healthy and an unhealthy instance (dg15)",
            "Dependency health for every downstream (dg11)",
            "Bisect the version, config or input space (dg03)",
            "State the mechanism as falsifiable claims (dg16)",
            "Fix with a test that fails before the fix (dg18)",
            "Postmortem, runbook delta and dated action items (dg17)"
          ]
        },
        {
          "h": "Handoff at 3am",
          "p": [
            "A handoff is a structured message, not a conversation: current hypothesis, evidence for and against, what is ruled out, the next experiment and how long it takes, and where the artifacts live. The person taking over should be able to start the next experiment without reading the channel backlog, and the person handing off should be able to sleep without holding the context in their head.",
            "Write it in the incident doc as you go, not at the end. The act of writing what I believe and why surfaces the hypothesis you have been assuming without testing, which is the single most common reason a long incident stays long. If you cannot write the next experiment, that is the finding."
          ],
          "code": `# incidents/2026-03-14-checkout-latency.md (front matter)
id: INC-2026-0314
severity: sev2
started_at: 2026-03-14T09:12:00Z
detected_at: 2026-03-14T09:19:00Z
mitigated_at: 2026-03-14T09:41:00Z
commander: oncall-checkout
impact: "12% of EU checkouts exceeded the 5s deadline for 29 minutes"

suspects_ruled_out:
  - "payments provider latency (p99 flat at 240ms throughout)"
  - "database CPU (below 40% for the whole window)"

hypothesis: "per-replica pool x 8 replicas exceeds max_connections after scale-up"
next_experiment: "set pool=12 on one canary, replay 500 requests, compare p99"
eta_minutes: 15

artifacts:
  - "trace: 4bf92f3577b34da6a3ce929d0e0e4736"
  - "stacks: s3://incident-artifacts/INC-2026-0314/stacks.txt"
  - "flamegraph: s3://incident-artifacts/INC-2026-0314/cpu.svg"`,
          "tip": "If the handoff message cannot name a next experiment with a time estimate, the incident is stuck on a missing observation, not on a missing engineer."
        }
      ],
      "exercise": {
        "prompt": "Fill an incident card for a scenario where checkout 5xx spikes after a flag rollout: include two ruled-out suspects with the evidence that ruled them out, one hypothesis, and a next experiment with a time estimate.",
        "starter": `# incidents/YYYY-MM-DD-summary.md
id:
severity:
started_at:
detected_at:
impact:

suspects_ruled_out:
  - 
  - 

hypothesis:
next_experiment:
eta_minutes:
artifacts:`,
        "hint": "Ruled-out suspects need evidence, not opinions: a metric series that stayed flat, a trace that shows the hop was fast. Without evidence the next person will re-investigate the same two suspects.",
        "solution": `# incidents/2026-04-02-checkout-5xx.md
id: INC-2026-0402
severity: sev1
started_at: 2026-04-02T14:02:00Z
detected_at: 2026-04-02T14:05:00Z
mitigated_at: 2026-04-02T14:22:00Z
commander: oncall-checkout
impact: "38% of checkout requests returned 500 for 20 minutes after flag rollout"

suspects_ruled_out:
  - "inventory service errors (its 5xx rate was 0.00% for the whole window)"
  - "database saturation (connections at 41%, p99 query 12ms, unchanged)"

hypothesis: "flag inventory.reserve_v2=true returns 500 when the reservation is
  already held; the new path maps Conflict to Internal instead of 409"
next_experiment: "flip the flag off on one canary and replay the recorded 5xx
  request from trace 8a1f...; expect 409 instead of 500"
eta_minutes: 10

artifacts:
  - "trace: 8a1f3c9d2b7e4051a6c4f0e2d9b81357"
  - "log query: service=checkout trace_id=8a1f3c9d2b7e4051a6c4f0e2d9b81357"
  - "flag snapshot: inventory.reserve_v2=true (canary only)"

next_after_that: "if confirmed, map Conflict -> 409 and add a regression test
  for the double-reserve case before re-enabling the flag"`
      },
      "production": [
        "Every incident has a card from minute one, filled in during the incident rather than reconstructed after.",
        "The checklist is reviewed after each P1: which items helped, which were skipped and why.",
        "Handoffs are written, timestamped and link artifacts; verbal-only handoffs are not accepted.",
        "The checklist fits on one screen; a longer one will not be used at 3am."
      ],
      "crates": [
        "tracing",
        "serde",
        "serde_json"
      ],
      "pitfall": "Investigating before stabilising: the pod is replaced mid-investigation, the trace retention window closes, and the evidence that would have answered the question no longer exists.",
      "questions": [
        {
          "q": "What should you capture first when a production incident starts?",
          "options": [
            "The full source of the suspect module",
            "The evidence that disappears: trace ids, process state, deploy and flag snapshot, symptom start time",
            "A list of everyone who touched the service this week",
            "The current on-call schedule"
          ],
          "answer": 1,
          "explain": "Pods get replaced, traces age out and logs roll. Capturing the ephemeral evidence first is what makes the later investigation possible at all."
        },
        {
          "q": "Why is a checklist useful to an experienced engineer?",
          "options": [
            "It makes incidents shorter by definition",
            "It documents who is responsible",
            "It prevents skipping the step that is habitually skipped under pressure",
            "It replaces the need for judgement"
          ],
          "answer": 2,
          "explain": "Experts skip steps they consider obvious, and under pressure the skipped step is usually the one that would have resolved the incident fastest."
        },
        {
          "q": "What belongs in a handoff message?",
          "options": [
            "Only the current error message",
            "The full chat transcript",
            "A summary of who worked on what",
            "Hypothesis, evidence for and against, what is ruled out, the next experiment, and artifact locations"
          ],
          "answer": 3,
          "explain": "The next person needs the state of the search, not the history of the conversation. Ruled-out suspects and the next experiment are the two parts that save the most time."
        }
      ],
      "quickbytes": [
        "Stabilise, then capture the ephemeral evidence, then form hypotheses.",
        "Four scoping questions: who, what changed, when, where it stops being healthy.",
        "A handoff without a next experiment and a time estimate means the incident is stuck on a missing observation."
      ],
      "github": [
        {
          "name": "danluu/post-mortems - real incident write-ups to calibrate the card",
          "url": "https://github.com/danluu/post-mortems"
        },
        {
          "name": "tokio-rs/tracing - the trace ids the checklist depends on",
          "url": "https://github.com/tokio-rs/tracing"
        }
      ],
      "resources": [
        {
          "title": "danluu/post-mortems - a collection of real postmortems",
          "url": "https://github.com/danluu/post-mortems",
          "kind": "repo"
        },
        {
          "title": "Scalable Statistical Root Cause Analysis on App Telemetry (Minesweeper)",
          "url": "https://arxiv.org/abs/2010.09974",
          "kind": "paper"
        },
        {
          "title": "tracing crate documentation - the evidence source for every checklist item",
          "url": "https://docs.rs/tracing/latest/tracing/",
          "kind": "docs"
        },
        {
          "title": "fasterthanlime: long-form Rust debugging walkthroughs",
          "url": "https://www.youtube.com/@fasterthanlime",
          "kind": "video"
        }
      ]
    }
  ]
};
