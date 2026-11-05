/**
 * Algorithms & problem solving track.
 *
 * API versions used across the lessons: petgraph 0.8.x, priority-queue 2.7.x,
 * criterion 0.8.x, proptest 1.12.x, indexmap 2.14.x, hashbrown 0.17.x,
 * bitvec 1.1.x, num-integer 0.1.x, rayon 1.12.x, rand 0.10.x.
 *
 * Data is JSON-compatible and consumed by the plugin build.
 */
export default {
  "key": "algorithms",
  "prefix": "a",
  "title": "Algorithms & problem solving",
  "blurb": "Complexity, core data-structure algorithms, graphs, DP, strings and the patterns that show up in real systems and interviews.",
  "level": "industry",
  "project": {
    "title": "Capstone: a pathfinding and scheduling engine",
    "brief": "Build a library that answers two questions over the same graph model: what is the cheapest route from A to B, and in what order should a set of dependent jobs run to meet their deadlines? Load a real road or build graph, answer routes with BFS, Dijkstra and A*, schedule jobs with a DP or a proven greedy, and defend every complexity claim with benchmarks against a naive baseline and property tests for the invariants.",
    "deliverables": [
      "A graph abstraction with build-time validation, CSR storage, and BFS, DFS, Dijkstra and A* over the same trait.",
      "A scheduling solver (weighted interval DP or earliest-deadline greedy) with a written exchange-argument proof of its bound.",
      "Criterion benchmarks against naive baselines, reporting throughput and p50/p99 per query size.",
      "Proptest suites covering path optimality, triangle-inequality heuristics, and schedule feasibility.",
      "A README stating the complexity budget per operation and where the implementation exceeds it."
    ],
    "stack": [
      "petgraph",
      "priority-queue",
      "criterion",
      "proptest",
      "rayon",
      "indexmap"
    ]
  },
  "lessons": [
    {
      "id": "a01",
      "title": "Complexity analysis: counting the operation that dominates",
      "minutes": 75,
      "level": "core",
      "goal": "Predict a function's growth rate from its loops, separate amortised from worst-case cost, and measure real code instead of trusting Big-O alone.",
      "sections": [
        {
          "h": "Growth rates, not stopwatch readings",
          "p": [
            "Big-O describes how work grows with input size, not how long a call takes. A linked-list traversal and a contiguous slice scan are both O(n), yet the scan can be five to ten times faster because one cache line feeds sixteen integers while a pointer chase touches a new line per node. Two algorithms with the same bound differ by constants decided by memory layout, branch prediction, and allocation, so the bound is a starting point rather than a verdict.",
            "To analyse a new function, count the operation that dominates: comparisons for sorting, edge relaxations for a shortest path, hash probes for a map. Express that count as a function of n, then watch the ratio when n doubles. Linear work doubles, quadratic work quadruples, O(n log n) grows slightly faster than double. That ratio is the fastest sanity check available on real code and needs no profiler."
          ],
          "tip": "Print the ratio between consecutive sizes, not just the elapsed time: ratios are stable across machines, absolute nanoseconds are not."
        },
        {
          "h": "Amortised cost: Vec::push and the doubling trick",
          "p": [
            "Vec::push is O(1) most of the time and O(n) when the buffer is full and must grow. Growth doubles capacity, so n pushes copy at most 1 + 2 + 4 + ... + n/2 < n elements in total, which keeps the average cost per push constant. That is amortised O(1): a bound over a sequence of operations, not over any single call. The worst case for one call never improves.",
            "The distinction matters at latency boundaries. A push that reallocates can stall for milliseconds while it copies a large buffer, which shows up in a p99 graph even when the average looks healthy. When a spike is unacceptable, reserve capacity up front with Vec::with_capacity or reserve_exact, or use a chunked structure that never copies old data. Amortised cost predicts throughput; worst case predicts tail latency."
          ]
        },
        {
          "h": "Measuring without lying to yourself",
          "p": [
            "Benchmarks mislead in three predictable ways: debug builds, dead-code elimination, and unrealistic inputs. Measure with --release, consume results through std::hint::black_box, and generate the distribution you actually see: nearly sorted keys, long duplicate runs, strings sharing a prefix. A benchmark over random u64 values tells you nothing about a map keyed by short strings that all begin with the same eight bytes.",
            "Criterion warms up, collects enough samples to report a confidence interval, and can compare against a saved baseline, which is how you separate a real regression from noise. Report throughput as well as time per iteration, and keep input generation outside the measured closure so you time the algorithm rather than the allocator. Change one variable per run and record the commit you measured."
          ],
          "code": `// benches/dedupe.rs — run with: cargo bench --bench dedupe
use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use std::hint::black_box;

fn count_equal_pairs(xs: &[u64]) -> usize {
    let mut pairs = 0usize;
    for (i, &a) in xs.iter().enumerate() {
        for &b in &xs[..i] {
            if a == b {
                pairs += 1;
            }
        }
    }
    pairs
}

fn bench(c: &mut Criterion) {
    let mut group = c.benchmark_group("equal_pairs");
    for n in [500usize, 1_000, 2_000] {
        let xs: Vec<u64> = (0..n as u64).map(|i| i.wrapping_mul(2_654_435_761) % 7919).collect();
        group.throughput(Throughput::Elements(n as u64));
        group.bench_with_input(BenchmarkId::from_parameter(n), &xs, |b, input| {
            b.iter(|| count_equal_pairs(black_box(input)))
        });
    }
    group.finish();
}

criterion_group!(benches, bench);
criterion_main!(benches);`,
          "tip": "Divide the reported time by n and watch the per-element number: a flat curve is linear, a rising curve is super-linear."
        },
        {
          "h": "When the constant outranks the exponent",
          "p": [
            "For small n, an O(n^2) loop over a Vec routinely beats an O(n) hash map because hashing costs tens of cycles and a linear scan of sixteen integers fits in one cache line. Every real library contains a threshold like this: Rust's own slice sort switches to insertion sort for short runs. The asymptotically worse choice wins until the input is big enough for the better growth rate to pay back its setup cost.",
            "So state the crossover, not just the bound. A scheduler that sorts ten thousand jobs once can afford O(n log n); a hot path called a million times per second with n = 8 should stay linear and allocation-free. Complexity budgets in the capstone are written this way: a bound, the input range where it applies, and the constant you measured at that range."
          ],
          "list": [
            "n below roughly 32: prefer linear scans, sorted small arrays, and stack buffers",
            "n in the thousands to millions: growth rate dominates, constants become noise",
            "Latency-sensitive paths care about the worst case, throughput paths about the amortised one"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a deterministic doubling experiment: count the comparisons performed by a quadratic duplicate check on all-distinct input at n = 500, 1000, 2000 and 4000, print the ratio between consecutive sizes, and confirm it converges on 4. Then print the comparison count for a sort-and-scan version to show the difference in growth.",
        "starter": "fn count_quadratic(xs: &[u64]) -> usize {\n    // count every element-to-element comparison, including the ones that break early\n    todo!()\n}\n\nfn count_sort_scan(xs: &[u64]) -> (usize, usize) {\n    // returns (distinct, scan comparisons); sort comparisons are internal to std\n    todo!()\n}\n\nfn main() {\n    let mut previous: Option<usize> = None;\n    for n in [500usize, 1_000, 2_000, 4_000] {\n        // build 0..n, measure, print n, steps and ratio\n    }\n}",
        "hint": "Keep a previous step count outside the loop. The ratio is steps(n) / steps(n/2); for a loop over all earlier elements it approaches 4, while the scan after sorting is linear.",
        "solution": `fn count_quadratic(xs: &[u64]) -> usize {
    let mut steps = 0usize;
    for (i, &a) in xs.iter().enumerate() {
        for &b in &xs[..i] {
            steps += 1;
            if a == b {
                break;
            }
        }
    }
    steps
}

fn count_sort_scan(xs: &[u64]) -> (usize, usize) {
    let mut sorted = xs.to_vec();
    sorted.sort_unstable();
    let mut distinct = 1usize;
    let mut steps = 0usize;
    for pair in sorted.windows(2) {
        steps += 1;
        if pair[0] != pair[1] {
            distinct += 1;
        }
    }
    (distinct, steps)
}

fn main() {
    let mut previous: Option<usize> = None;
    for n in [500usize, 1_000, 2_000, 4_000] {
        let xs: Vec<u64> = (0..n as u64).collect();
        let steps = count_quadratic(&xs);
        let ratio = previous.map(|p| steps as f64 / p as f64);
        println!("n={n:>5} quadratic_steps={steps:>9} ratio={ratio:?}");
        previous = Some(steps);
    }

    let xs: Vec<u64> = (0..4_000u64).collect();
    let (distinct, scan_steps) = count_sort_scan(&xs);
    println!("sort+scan: distinct={distinct} scan_steps={scan_steps} (linear after an O(n log n) sort)");
}`
      },
      "questions": [
        {
          "q": "A Vec grows by doubling. What is the amortised cost of a single push over n pushes?",
          "options": [
            "O(1) amortised, with O(n) worst case on the call that reallocates",
            "O(log n), because capacity doubles logarithmically many times",
            "O(n) amortised, because every push may copy the buffer",
            "O(1) worst case, because Rust reserves spare capacity"
          ],
          "answer": 0,
          "explain": "Each doubling copies the whole buffer, but the total copied across n pushes is under n, so the average per push is constant. Any individual call can still cost O(n)."
        },
        {
          "q": "Two functions are both O(n). Which statement is defensible without measuring?",
          "options": [
            "They will take the same time for large n",
            "Their growth rate matches, but constants may differ by an order of magnitude",
            "The one with fewer lines of code is faster",
            "The one using a Vec is always faster than the one using a HashMap"
          ],
          "answer": 1,
          "explain": "Big-O ignores constant factors and lower-order terms. Memory layout, allocation, and branch behaviour routinely produce 5-10x differences between algorithms with the same bound."
        },
        {
          "q": "Your benchmark shows a 30 percent speedup in a debug build. What should you do first?",
          "options": [
            "Ship it: the measurement is direct evidence",
            "Rerun in release mode with black_box and realistic inputs before believing it",
            "Add more debug assertions to confirm the result",
            "Convert the benchmark to a unit test"
          ],
          "answer": 1,
          "explain": "Debug builds disable optimisations, so they emphasise different costs than production. Release mode plus black_box plus representative data is the minimum credible measurement."
        }
      ],
      "quickbytes": [
        "cargo bench --bench <name> builds in release with debug assertions off; a cargo run measurement does not.",
        "Wrap inputs and outputs in std::hint::black_box so LLVM cannot delete the work you are timing.",
        "If doubling n multiplies time by about 4, suspect a nested loop over the same input.",
        "Report ns per element, not total time: it makes different input sizes comparable."
      ],
      "production": [
        "Every hot path has a written complexity budget and the input range where it holds.",
        "Benchmarks run in release mode with black_box and a data distribution copied from production.",
        "Latency-sensitive code is reviewed for worst-case reallocation, not just amortised cost.",
        "Criterion baselines are stored in CI, and regressions above an agreed threshold fail the build."
      ],
      "crates": [
        "criterion",
        "std"
      ],
      "github": [
        {
          "name": "bheisler/criterion.rs",
          "url": "https://github.com/bheisler/criterion.rs"
        },
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        }
      ],
      "pitfall": "Benchmarking a function whose result is never used: LLVM deletes the whole computation, and the benchmark reports a few nanoseconds for work that never ran. black_box on the result prevents it.",
      "resources": [
        {
          "title": "criterion: statistics-driven benchmarking for Rust",
          "url": "https://docs.rs/criterion/latest/criterion/",
          "kind": "docs"
        },
        {
          "title": "criterion.rs repository",
          "url": "https://github.com/bheisler/criterion.rs",
          "kind": "repo"
        },
        {
          "title": "std::hint::black_box",
          "url": "https://doc.rust-lang.org/std/hint/fn.black_box.html",
          "kind": "docs"
        },
        {
          "title": "MIT OpenCourseWare: Introduction to Algorithms (6.006) lectures",
          "url": "https://www.youtube.com/@mitocw",
          "kind": "video"
        }
      ]
    },
    {
      "id": "a02",
      "title": "Arrays and two pointers: the write-index invariant",
      "minutes": 85,
      "level": "core",
      "goal": "Compact and partition slices in place with read and write indices, and explain why contiguous storage beats pointer structures at the same complexity.",
      "sections": [
        {
          "h": "A slice is a pointer and a length",
          "p": [
            "A &[T] is a fat pointer: an address and a length. Indexing is a bounds check plus address arithmetic, iteration is a linear walk, and split_at_mut hands out two disjoint mutable halves that the borrow checker proves cannot overlap. That proof is why safe Rust can express in-place algorithms without the aliasing bugs that plague C versions of the same loops.",
            "Prefer slices in signatures and Vec only at ownership boundaries. Functions that take &[T] or &mut [T] accept arrays, Vec, Box<[T]>, and subslices without conversion, and they cannot grow the collection behind your back. When an algorithm genuinely needs to append, take &mut Vec<T> and document that it may reallocate, invalidating any outstanding references."
          ],
          "list": [
            "windows(2) for adjacent pairs, chunks(n) for fixed blocks, split_at_mut for two writers",
            "copy_within is memmove semantics: correct even when source and destination overlap",
            "Indexing panics on out-of-range; get() returns Option and is the right call on untrusted input"
          ]
        },
        {
          "h": "Two pointers: compact in place, keep the invariant",
          "p": [
            "Removing duplicates or a value from a sorted array does not need a second allocation. Keep a read index that scans every element and a write index that marks the end of the answer. The invariant is that xs[..write] is always the compacted prefix; when xs[read] belongs in the answer, copy it to xs[write] and advance both. Reads always run ahead of writes, so no data is overwritten before it is examined.",
            "The loop is O(n) time and O(1) extra space, and it works on &mut [T] with no allocation at all. The same shape solves move-zeroes, remove-element, and the merge step of merge sort when you write from the back. The invariant is the part worth memorising: once you can state what the prefix contains, the index updates follow, and off-by-one bugs stop being guesswork."
          ],
          "code": `/// Remove duplicates from a sorted slice in place; returns the new logical length.
pub fn dedup_sorted(xs: &mut [i64]) -> usize {
    if xs.is_empty() {
        return 0;
    }
    let mut write = 1;
    for read in 1..xs.len() {
        if xs[read] != xs[write - 1] {
            xs[write] = xs[read];
            write += 1;
        }
    }
    write
}

/// Move every zero to the end while preserving the order of non-zero values.
pub fn move_zeroes(xs: &mut [i64]) {
    let mut write = 0;
    for read in 0..xs.len() {
        if xs[read] != 0 {
            xs[write] = xs[read];
            write += 1;
        }
    }
    for slot in &mut xs[write..] {
        *slot = 0;
    }
}`,
          "tip": "Write the invariant as a comment before the loop. If you cannot state it in one sentence, the indices are doing too much."
        },
        {
          "h": "Three-way partition in a single pass",
          "p": [
            "When the input has many equal keys, two-way partitioning degrades badly: quicksort on an array of identical values becomes quadratic. Dijkstra's Dutch national flag partitions into less-than, equal, and greater in one pass with three indices, which is why production quicksorts switch to three-way partitioning on duplicate-heavy data. Rust's sort handles this internally, but you meet the same shape in bucket problems and in streaming classification.",
            "The loop maintains [0, lt) < pivot, [lt, i) == pivot, and (gt, len) > pivot. Elements equal to the pivot are simply skipped, which is what keeps them out of later recursive calls. The cost is one comparison per element and at most one swap, so O(n) time and O(1) space. Watch the greater-than branch: you swap an unexamined element into position i and must not advance i."
          ],
          "code": `use std::cmp::Ordering;

/// Dutch national flag: [0, lt) < pivot, [lt, i) == pivot, (gt, len) > pivot.
pub fn three_way_partition(xs: &mut [i64], pivot: i64) {
    let mut lt = 0usize;
    let mut i = 0usize;
    let mut gt = xs.len();

    while i < gt {
        match xs[i].cmp(&pivot) {
            Ordering::Less => {
                xs.swap(lt, i);
                lt += 1;
                i += 1;
            }
            Ordering::Equal => i += 1,
            Ordering::Greater => {
                gt -= 1;
                xs.swap(i, gt); // the swapped-in element is unexamined: do not advance i
            }
        }
    }
}`,
          "tip": "After the loop, lt is the count of elements below the pivot and gt is the start of the greater region; both are bounds you can assert in tests."
        },
        {
          "h": "Layout beats asymptotics",
          "p": [
            "A Vec<Vec<u32>> adjacency list is O(1) per neighbour in theory, but every inner Vec is a separate allocation reached through a pointer, so iterating one node's edges may miss cache on every hop. A flat CSR layout - one offsets array plus one targets array - turns the same traversal into sequential reads and often halves the runtime at identical complexity.",
            "The rule generalises: keep the hot data contiguous, keep the per-element size small, and avoid indirection in the inner loop. Struct-of-arrays beats array-of-structs when the loop touches two fields out of twelve, because the cache line no longer carries ten unused fields. None of this changes Big-O; all of it changes whether the algorithm is fast enough to ship."
          ],
          "list": [
            "Flat CSR: offsets[i]..offsets[i+1] slices targets for node i, one allocation total",
            "Keep hot loops over &[u32] or &[f64]; convert to structs only at the boundary",
            "Measure with the real graph: a road network and a social graph have very different degree distributions"
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement `compress(xs: &mut [i32], keep: impl Fn(i32) -> bool) -> usize`: keep the elements that satisfy the predicate, preserve their order, write them into the front of the slice, and return the new length. Then merge two sorted slices into one buffer by writing from the back so nothing is overwritten.",
        "starter": "pub fn compress(xs: &mut [i32], keep: impl Fn(i32) -> bool) -> usize {\n    // read scans all elements, write marks the end of the kept prefix\n    todo!()\n}\n\npub fn merge_from_back(a: &[i32], b: &[i32], out: &mut [i32]) {\n    // out.len() == a.len() + b.len(); fill from the last index backwards\n    todo!()\n}",
        "hint": "In compress, increment write only when keep(xs[read]) is true. In merge_from_back, compare a[i] and b[j], place the larger at out[k], and decrement the corresponding index; copy the remainder when one side runs out.",
        "solution": `pub fn compress(xs: &mut [i32], keep: impl Fn(i32) -> bool) -> usize {
    let mut write = 0usize;
    for read in 0..xs.len() {
        if keep(xs[read]) {
            xs[write] = xs[read];
            write += 1;
        }
    }
    write
}

pub fn merge_from_back(a: &[i32], b: &[i32], out: &mut [i32]) {
    assert_eq!(out.len(), a.len() + b.len());
    let (mut i, mut j, mut k) = (a.len(), b.len(), out.len());
    while i > 0 && j > 0 {
        k -= 1;
        if a[i - 1] > b[j - 1] {
            out[k] = a[i - 1];
            i -= 1;
        } else {
            out[k] = b[j - 1];
            j -= 1;
        }
    }
    while i > 0 {
        k -= 1;
        out[k] = a[i - 1];
        i -= 1;
    }
    while j > 0 {
        k -= 1;
        out[k] = b[j - 1];
        j -= 1;
    }
}

fn main() {
    let mut xs = [0, 1, 0, 2, 3, 0, 4];
    let n = compress(&mut xs, |x| x != 0);
    assert_eq!(&xs[..n], &[1, 2, 3, 4]);

    let a = [1, 4, 9];
    let b = [2, 3, 10, 11];
    let mut out = [0; 7];
    merge_from_back(&a, &b, &mut out);
    assert_eq!(out, [1, 2, 3, 4, 9, 10, 11]);
    println!("ok");
}`
      },
      "questions": [
        {
          "q": "In the two-pointer dedupe loop, why is it safe that read and write touch the same buffer?",
          "options": [
            "Because Rust checks bounds at runtime before each write",
            "Because write never passes read, so every element is read before it is overwritten",
            "Because the slice is sorted, so duplicates are adjacent",
            "Because swap is atomic for integers"
          ],
          "answer": 1,
          "explain": "The write index trails the read index, so the element at read has already been examined before anything overwrites it. Sorting makes duplicates adjacent, but the safety comes from the index ordering."
        },
        {
          "q": "Why does three-way partitioning help on inputs with many equal keys?",
          "options": [
            "It sorts the equal region, which speeds up later comparisons",
            "It removes equal elements from further recursive work instead of leaving them for the next pass",
            "It halves the number of comparisons per element",
            "It avoids the need for a pivot"
          ],
          "answer": 1,
          "explain": "Two-way partitioning puts all equals on one side and recurses into them again, which is quadratic for identical input. Three-way puts equals in a middle region that is never revisited."
        },
        {
          "q": "A CSR graph stores offsets and targets. What does offsets[i+1] - offsets[i] give you?",
          "options": [
            "The weight of edge i",
            "The number of outgoing edges from node i",
            "The index of node i's parent",
            "The total number of edges in the graph"
          ],
          "answer": 1,
          "explain": "offsets[i] is the start of node i's neighbours in targets and offsets[i+1] is the end, so the difference is the out-degree."
        }
      ],
      "quickbytes": [
        "Take &[T] in signatures and return Vec<T> at ownership boundaries; callers keep their options.",
        "xs.split_at_mut(k) is the safe way to give two loops disjoint mutable halves.",
        "xs.copy_within(src, dst) has memmove semantics, so overlapping ranges are fine.",
        "Vec::dedup only removes consecutive duplicates: sort first, or it silently leaves the rest."
      ],
      "production": [
        "In-place helpers document their invariant and assert it in debug builds.",
        "Hot loops iterate slices, not Vec<Vec<_>>, and the graph layer uses CSR.",
        "Predicate removals use retain or a write-index loop instead of repeated remove(i).",
        "Any function that may reallocate takes &mut Vec and says so in its doc comment."
      ],
      "crates": [
        "std",
        "smallvec",
        "criterion"
      ],
      "github": [
        {
          "name": "servo/rust-smallvec",
          "url": "https://github.com/servo/rust-smallvec"
        },
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        }
      ],
      "pitfall": "Removing elements with Vec::remove(i) inside a forward loop: every removal shifts the tail, the loop index skips the next element, and the whole operation is O(n^2) on a hot path that retain solves in one pass.",
      "resources": [
        {
          "title": "std::slice — windows, chunks, split_at_mut, copy_within",
          "url": "https://doc.rust-lang.org/std/primitive.slice.html",
          "kind": "docs"
        },
        {
          "title": "smallvec: store small vectors inline on the stack",
          "url": "https://docs.rs/smallvec/latest/smallvec/",
          "kind": "docs"
        },
        {
          "title": "servo/rust-smallvec repository",
          "url": "https://github.com/servo/rust-smallvec",
          "kind": "repo"
        },
        {
          "title": "criterion: benchmarking in-place versus allocating variants",
          "url": "https://docs.rs/criterion/latest/criterion/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "a03",
      "title": "Hashing strategies: entry API, load factor, and hash DoS",
      "minutes": 80,
      "level": "advanced",
      "goal": "Choose a hasher and a map for the workload, use the entry API to avoid double lookups, and explain what makes a hash table fast and what makes it exploitable.",
      "sections": [
        {
          "h": "One lookup, one decision: the entry API",
          "p": [
            "The pattern if map.contains_key(k) { map.get_mut(k) } else { map.insert(k, v) } hashes the key twice and probes twice. HashMap::entry hashes once and hands back an Entry that is either occupied or vacant, so the insert-or-update decision happens after a single probe. It reads better and it is measurably faster on string keys, where each hash walks the bytes.",
            "Entry also encodes the two common shapes: or_insert for a default value, or_insert_with when the default is expensive to build, and and_modify before or_insert to update in place. For counters, *map.entry(key).or_insert(0) += 1 is the canonical form. The one thing entry cannot do is return a reference to a different map while the entry borrow is alive, which is why grouped aggregation often needs a two-phase pass."
          ],
          "code": `use std::collections::HashMap;

/// Two-sum in one pass. Returns indices (i, j) with xs[i] + xs[j] == target.
pub fn two_sum(xs: &[i64], target: i64) -> Option<(usize, usize)> {
    let mut seen: HashMap<i64, usize> = HashMap::with_capacity(xs.len());
    for (j, &x) in xs.iter().enumerate() {
        if let Some(&i) = seen.get(&(target - x)) {
            return Some((i, j));
        }
        seen.insert(x, j);
    }
    None
}

/// Word frequency without a second probe per word.
pub fn frequencies<'a>(words: &[&'a str]) -> HashMap<&'a str, u32> {
    let mut counts: HashMap<&str, u32> = HashMap::with_capacity(words.len());
    for &word in words {
        *counts.entry(word).or_insert(0) += 1;
    }
    counts
}

/// Group by the first byte, appending indices, in a single pass.
pub fn bucket_by_first_byte(words: &[&str]) -> HashMap<u8, Vec<usize>> {
    let mut buckets: HashMap<u8, Vec<usize>> = HashMap::new();
    for (i, word) in words.iter().enumerate() {
        let key = word.as_bytes().first().copied().unwrap_or(b'\\0');
        buckets.entry(key).or_default().push(i);
    }
    buckets
}`,
          "tip": "with_capacity(n) avoids several rehashes when n is known. It is the cheapest optimisation in most map-heavy code."
        },
        {
          "h": "What the hasher actually costs",
          "p": [
            "std::collections::HashMap uses SipHash-1-3 with a per-process random key. It is not the fastest hasher available, and that is deliberate: an attacker who can choose keys cannot predict the seed, so they cannot build a colliding set that turns every lookup into a linear scan. For maps fed by untrusted input - query parameters, headers, JSON field names - that property is worth more than the cycles.",
            "For integer keys or trusted internal data, a non-cryptographic hasher is often two to three times faster per lookup. rustc_hash::FxHashMap is the usual choice for integer and pointer-like keys. hashbrown, the table implementation std is built on, defaults to foldhash, which its own documentation describes as fast, non-cryptographic and only minimally DoS-resistant: fine for an internal index, wrong for a public endpoint."
          ],
          "list": [
            "Untrusted keys: keep SipHash (std default) or another keyed hasher",
            "Trusted integer keys: FxHashMap or another multiply-xor hasher",
            "Short string keys: hashing dominates; consider interning to u32 ids first",
            "Never implement Hash by hand without also checking Eq consistency"
          ]
        },
        {
          "h": "Load factor, probing, and deletion",
          "p": [
            "Open-addressed tables keep all entries in one array and resolve collisions by probing adjacent slots. SwissTable-style designs probe groups of sixteen slots with one SIMD comparison, which is why a lookup is a handful of instructions when the table is not full. The price is that performance falls off a cliff as the table fills: at a load factor near 7/8 the probe sequences lengthen and the table must grow and rehash everything.",
            "Deletion in open addressing leaves tombstones or requires backward-shift cleanup, which is why repeated insert/remove cycles can degrade a table that never grows. Rust's HashMap handles this internally, but the practical consequences remain: iteration order is unspecified and changes on rehash, so never depend on it; and a map that had a million entries and now holds ten still occupies the peak capacity until you call shrink_to_fit."
          ],
          "code": `use std::collections::HashMap;

/// Counting with a pre-sized table and no per-iteration allocation.
pub fn histogram(values: &[u32]) -> HashMap<u32, u64> {
    let mut counts = HashMap::with_capacity(values.len());
    for &v in values {
        *counts.entry(v).or_insert(0) += 1;
    }
    if counts.capacity() > counts.len() * 4 {
        counts.shrink_to_fit(); // return memory after a burst
    }
    counts
}

/// Ordered results: sort the keys once instead of trusting map iteration order.
pub fn top_k(counts: &HashMap<u32, u64>, k: usize) -> Vec<(u32, u64)> {
    let mut pairs: Vec<(u32, u64)> = counts.iter().map(|(&k, &v)| (k, v)).collect();
    pairs.sort_unstable_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    pairs.truncate(k);
    pairs
}`,
          "tip": "Iteration order is a hash detail, not an API guarantee. Sort explicitly whenever output order is observable."
        },
        {
          "h": "When a map is the wrong structure",
          "p": [
            "A BTreeMap costs O(log n) per operation instead of O(1) expected, but it keeps keys ordered, supports range queries, and has deterministic iteration. If you need the smallest deadline, all jobs between two timestamps, or stable output for a snapshot test, the tree is the better tool and the constant difference rarely matters below a few hundred thousand entries.",
            "IndexMap preserves insertion order with O(1) lookup, which is what you want for configuration and for de-duplicating while keeping first-seen order. A sorted Vec is unbeatable below a few dozen elements and for read-mostly data built once. Choosing between these is a data-shape question, and the answer should be visible in the type rather than buried in a comment."
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement `first_unique(words: &[&str]) -> Option<usize>` returning the index of the first word that occurs exactly once. Do it in two passes over a single map, then again in one pass using an insertion-ordered structure, and explain the trade-off.",
        "starter": "use std::collections::HashMap;\n\npub fn first_unique(words: &[&str]) -> Option<usize> {\n    // pass 1: count; pass 2: find the first word whose count is 1\n    todo!()\n}\n\npub fn first_unique_ordered(words: &[&str]) -> Option<usize> {\n    // one pass, preserving first-seen order\n    todo!()\n}",
        "hint": "The two-pass version needs counts: HashMap<&str, u32>, then a scan. The ordered version needs the index of the first occurrence plus a count; indexmap::IndexMap<&str, (usize, u32)> keeps both and iterates in insertion order.",
        "solution": `use std::collections::HashMap;

pub fn first_unique(words: &[&str]) -> Option<usize> {
    let mut counts: HashMap<&str, u32> = HashMap::with_capacity(words.len());
    for &word in words {
        *counts.entry(word).or_insert(0) += 1;
    }
    words.iter().position(|word| counts[word] == 1)
}

/// Same answer, one pass plus one ordered walk; useful when the input is a stream.
pub fn first_unique_ordered(words: &[&str]) -> Option<usize> {
    let mut seen: HashMap<&str, (usize, u32)> = HashMap::with_capacity(words.len());
    for (i, &word) in words.iter().enumerate() {
        seen.entry(word)
            .and_modify(|(_, count)| *count += 1)
            .or_insert((i, 1));
    }
    seen.values()
        .filter(|(_, count)| *count == 1)
        .map(|(i, _)| *i)
        .min()
}

fn main() {
    let words = ["rust", "go", "rust", "zig", "go"];
    assert_eq!(first_unique(&words), Some(3));
    assert_eq!(first_unique_ordered(&words), Some(3));
    println!("ok");
}`
      },
      "questions": [
        {
          "q": "Why is contains_key followed by get_mut slower than a single entry call?",
          "options": [
            "contains_key takes a lock on the map",
            "The key is hashed and the table probed twice instead of once",
            "get_mut clones the value before returning a reference",
            "contains_key scans every bucket linearly"
          ],
          "answer": 1,
          "explain": "Both calls hash the key and run the probe sequence. entry performs that work once and returns a handle to the slot, occupied or vacant."
        },
        {
          "q": "What does std's default SipHash-1-3 hasher buy you over FxHash?",
          "options": [
            "Lower latency for integer keys",
            "Resistance to collision attacks because the seed is unpredictable",
            "Deterministic iteration order across runs",
            "Smaller memory per entry"
          ],
          "answer": 1,
          "explain": "A keyed cryptographic hash prevents an attacker from constructing colliding keys offline. FxHash is faster but predictable, so it is unsafe for attacker-controlled keys."
        },
        {
          "q": "A service holds a HashMap that shrank from 2 million to 200 entries after a burst. What should you check?",
          "options": [
            "Whether capacity is still sized for the peak and should be shrunk",
            "Whether the hasher is SipHash",
            "Whether iteration order changed",
            "Whether the map should be a Vec"
          ],
          "answer": 0,
          "explain": "HashMap does not shrink on its own. The table keeps peak capacity, and its memory footprint stays at burst level until shrink_to_fit or a new map is built."
        }
      ],
      "quickbytes": [
        "Use map.entry(k).or_insert_with(|| expensive()) so the default is built only when needed.",
        "*map.entry(k).or_default() += 1 is the counter idiom; or_default needs a Default value type.",
        "Keep SipHash for anything a user can influence; switch to FxHash for internal integer ids.",
        "Reserve with HashMap::with_capacity when the item count is known, then shrink_to_fit after a burst."
      ],
      "production": [
        "Public-facing maps use a keyed, collision-resistant hasher; performance profiles justify any swap.",
        "Capacity is reserved from a known bound, and shrink_to_fit runs after bursty workloads.",
        "No code depends on HashMap iteration order; ordered output is sorted or uses a BTreeMap.",
        "Key types derive Hash and Eq together, and custom Hash implementations are property-tested."
      ],
      "crates": [
        "hashbrown",
        "rustc-hash",
        "std"
      ],
      "github": [
        {
          "name": "rust-lang/hashbrown",
          "url": "https://github.com/rust-lang/hashbrown"
        },
        {
          "name": "rust-lang/rustc-hash",
          "url": "https://github.com/rust-lang/rustc-hash"
        }
      ],
      "pitfall": "Feeding request parameters into a map with a predictable hasher: an attacker submits thousands of keys that collide, every lookup degrades to a linear scan, and one endpoint takes the whole service down.",
      "resources": [
        {
          "title": "hashbrown: SwissTable-style hash map and set",
          "url": "https://docs.rs/hashbrown/latest/hashbrown/",
          "kind": "docs"
        },
        {
          "title": "rust-lang/hashbrown repository",
          "url": "https://github.com/rust-lang/hashbrown",
          "kind": "repo"
        },
        {
          "title": "std::collections::HashMap",
          "url": "https://doc.rust-lang.org/std/collections/struct.HashMap.html",
          "kind": "docs"
        },
        {
          "title": "On the Insertion Time of Cuckoo Hashing",
          "url": "https://arxiv.org/abs/1006.1231",
          "kind": "paper"
        }
      ]
    },
    {
      "id": "a04",
      "title": "Sorting: stability, key cost, and adversarial input",
      "minutes": 90,
      "level": "advanced",
      "goal": "Pick between stable and unstable sorts with a reason, avoid recomputing expensive keys, and recognise when a linear-time distribution sort beats comparison sorting.",
      "sections": [
        {
          "h": "sort versus sort_unstable is a semantics choice",
          "p": [
            "sort is stable: elements that compare equal keep their original relative order. sort_unstable gives that up and, in exchange, avoids the auxiliary allocation and is usually faster. The current std implementations are driftsort for the stable path - a quicksort/mergesort hybrid with run detection - and ipnsort for the unstable path, both documented as achieving linear time on fully sorted and reversed inputs.",
            "Stability is only worth paying for when order carries meaning. Sorting log lines by level while keeping timestamp order within a level is a stability problem; sorting a set of points by x is not. If you are unsure, ask whether two equal keys are distinguishable to the user - if they are, stability is part of correctness, not an optimisation."
          ],
          "list": [
            "sort_unstable for primitive keys and records with a unique tiebreaker",
            "sort when the input order is meaningful within equal keys",
            "sort_by_key with a closure returning a Copy key, or sort_unstable_by_key when stability is irrelevant",
            "NaN and floats: use total_cmp, never partial_cmp().unwrap() on untrusted data"
          ]
        },
        {
          "h": "The key function is usually the cost",
          "p": [
            "sort_by_key computes the key on every comparison, which is fine when the key is a field read and disastrous when it parses a string or allocates. sort_by_cached_key computes each key once into a temporary array, sorts by those keys, and moves the originals; it allocates O(n) memory but turns an O(n log n) key computations problem into O(n).",
            "The same idea applies to comparisons. Building a sort key as a tuple (priority, deadline, id) moves the tie-breaking into the comparison itself and makes the ordering total, which removes the need for a stable sort in most scheduling code. A total order also makes the result deterministic, so tests stop flaking when the input order changes."
          ],
          "code": `use std::cmp::Reverse;

#[derive(Debug, Clone)]
pub struct Job {
    pub id: u32,
    pub priority: u8,
    pub deadline: u64,
    pub name: String,
}

/// Highest priority first, then earliest deadline, then id: a total order.
pub fn schedule_order(jobs: &mut [Job]) {
    jobs.sort_unstable_by_key(|job| (Reverse(job.priority), job.deadline, job.id));
}

/// Expensive key computed once instead of on every comparison.
pub fn by_normalised_name(jobs: &mut [Job]) {
    jobs.sort_by_cached_key(|job| job.name.to_lowercase());
}`,
          "tip": "Sorting by a tuple gives you a total order and deterministic output; add the unique id as the last element."
        },
        {
          "h": "Linear-time sorts when the key domain is small",
          "p": [
            "Comparison sorting cannot beat O(n log n) in the general case, but many real keys are small integers: ages, ports, bytes, bucket indices, days since epoch. Counting sort runs in O(n + k) for keys in 0..k, and radix sort applies it digit by digit for wider keys. Both are stable when the scatter pass processes input in order, which makes them usable as the inner loop of a stable multi-key sort.",
            "The trade-off is memory and key range. A counting array of 65,536 u32 counters is 256 KB, which is larger than L2 on some machines and will lose to comparison sort on a thousand elements. Radix sort with 8-bit digits uses four passes for u32 and is cache-friendly; it wins on millions of integers and loses on a few thousand records with expensive-to-extract keys."
          ],
          "code": `/// Stable counting sort for u16 values. O(n + 65536) time, O(n + 65536) space.
pub fn counting_sort(xs: &[u16]) -> Vec<u16> {
    let mut next_slot = vec![0u32; u16::MAX as usize + 1];
    for &x in xs {
        next_slot[x as usize] += 1;
    }

    let mut start = 0u32;
    for slot in next_slot.iter_mut() {
        let count = *slot;
        *slot = start;
        start += count;
    }

    let mut out = vec![0u16; xs.len()];
    for &x in xs {
        let slot = &mut next_slot[x as usize];
        out[*slot as usize] = x;
        *slot += 1;
    }
    out
}`,
          "tip": "Count the distinct keys before reaching for a counting sort: if k is much larger than n, the O(k) initialisation dominates."
        },
        {
          "h": "Parallel sorting and worst-case inputs",
          "p": [
            "rayon's par_sort_unstable splits the slice, sorts chunks in parallel, and merges them, giving close to linear speedup on large inputs on a multi-core machine. It needs T: Send and a rayon thread pool; below roughly a hundred thousand elements the split and merge overhead usually exceeds the gain, so keep a size threshold rather than parallelising every call site.",
            "Adversarial inputs are a real category, not a theoretical one. TimSort's worst case was shown to be worse than the claimed O(n log n) on crafted patterns, which is exactly the kind of bug that shows up as a slow request from one tenant. Rust's sort documents linear behaviour on sorted and reversed input, but you should still benchmark your data - shuffled, sorted, reversed, many duplicates - rather than a single random sample."
          ],
          "code": `use rayon::prelude::*;

/// Parallel sort with a cutoff: sequential below the threshold, parallel above it.
pub fn sort_records(records: &mut [u64]) {
    const PARALLEL_THRESHOLD: usize = 100_000;
    if records.len() >= PARALLEL_THRESHOLD {
        records.par_sort_unstable();
    } else {
        records.sort_unstable();
    }
}

/// Four distributions every sort benchmark should include.
pub fn distributions(n: usize) -> Vec<(&'static str, Vec<u64>)> {
    let ascending: Vec<u64> = (0..n as u64).collect();
    let mut descending = ascending.clone();
    descending.reverse();
    let shuffled: Vec<u64> = (0..n as u64).map(|i| i.wrapping_mul(6_364_136_223_846_793_005) >> 33).collect();
    let duplicates: Vec<u64> = (0..n as u64).map(|i| i % 8).collect();
    vec![
        ("ascending", ascending),
        ("descending", descending),
        ("shuffled", shuffled),
        ("duplicates", duplicates),
    ]
}`,
          "tip": "Benchmark the sorted and reversed cases too: production data is often more ordered than the random generator you tested with."
        }
      ],
      "exercise": {
        "prompt": "Sort a slice of `Job` by (priority descending, deadline ascending, id ascending) without a stable sort, then rewrite the expensive-key version so the lowercased name is computed once. Add a test that proves the ordering is total by sorting the same set from two different initial permutations and comparing the results.",
        "starter": "use std::cmp::Reverse;\n\n#[derive(Debug, Clone, PartialEq, Eq)]\npub struct Job {\n    pub id: u32,\n    pub priority: u8,\n    pub deadline: u64,\n    pub name: String,\n}\n\npub fn schedule_order(jobs: &mut [Job]) {\n    // highest priority first, then earliest deadline, then smallest id\n    todo!()\n}\n\npub fn by_normalised_name(jobs: &mut [Job]) {\n    // compute each key once\n    todo!()\n}",
        "hint": "A tuple key of (Reverse(priority), deadline, id) is totally ordered, so sort_unstable_by_key is safe. For names use sort_by_cached_key and compare the lowercased form; it guarantees one allocation per element.",
        "solution": `use std::cmp::Reverse;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    pub id: u32,
    pub priority: u8,
    pub deadline: u64,
    pub name: String,
}

pub fn schedule_order(jobs: &mut [Job]) {
    jobs.sort_unstable_by_key(|job| (Reverse(job.priority), job.deadline, job.id));
}

pub fn by_normalised_name(jobs: &mut [Job]) {
    jobs.sort_by_cached_key(|job| job.name.to_lowercase());
}

fn main() {
    let make = |ids: [u32; 4]| -> Vec<Job> {
        ids.iter()
            .map(|&id| Job {
                id,
                priority: (id % 2) as u8,
                deadline: 10 + u64::from(id % 3),
                name: format!("Job-{id}"),
            })
            .collect()
    };

    let mut a = make([3, 1, 4, 2]);
    let mut b = make([2, 4, 1, 3]);
    schedule_order(&mut a);
    schedule_order(&mut b);
    let a_ids: Vec<u32> = a.iter().map(|j| j.id).collect();
    let b_ids: Vec<u32> = b.iter().map(|j| j.id).collect();
    assert_eq!(a_ids, b_ids, "a total order is independent of input permutation");

    by_normalised_name(&mut a);
    println!("{:?}", a.iter().map(|j| &j.name).collect::<Vec<_>>());
}`
      },
      "questions": [
        {
          "q": "When is sort_unstable not a safe replacement for sort?",
          "options": [
            "When the slice contains floats",
            "When equal elements must keep their original relative order",
            "When the slice is larger than 100,000 elements",
            "When the element type implements Copy"
          ],
          "answer": 1,
          "explain": "Unstable sort may reorder equal elements. If that order is observable - for example, records already sorted by timestamp then re-sorted by level - stability is required."
        },
        {
          "q": "Why can sort_by_key be much slower than sort_by_cached_key?",
          "options": [
            "sort_by_key allocates a Vec for every comparison",
            "The key closure runs O(n log n) times instead of O(n)",
            "sort_by_key is not inlined by LLVM",
            "cached_key uses a faster comparison algorithm"
          ],
          "answer": 1,
          "explain": "A comparison sort performs O(n log n) comparisons, and sort_by_key recomputes the key for each one. Caching computes each key once, at the cost of O(n) extra memory."
        },
        {
          "q": "For n = 2,000 u32 values with a key range of 0..=1,000,000, which sort is likely best?",
          "options": [
            "Counting sort with a million counters",
            "sort_unstable, because k is large relative to n",
            "Radix sort with 8-bit digits",
            "A stable merge sort"
          ],
          "answer": 1,
          "explain": "Counting sort allocates and initialises k counters, so a key range of a million for 2,000 elements is dominated by setup. Comparison sort wins at that ratio."
        }
      ],
      "quickbytes": [
        "sort_unstable is usually faster and always allocation-free; use it unless stability is part of correctness.",
        "Use total_cmp for f32/f64 keys; partial_cmp().unwrap() panics on NaN.",
        "sort_by_cached_key trades O(n) memory for one key computation per element.",
        "Below roughly 100k elements, rayon's parallel sort overhead usually outweighs the speedup."
      ],
      "production": [
        "Sort choice is justified by stability requirements, not by habit.",
        "Expensive key extraction uses cached keys and is benchmarked with realistic strings.",
        "Benchmarks cover sorted, reversed, duplicate-heavy, and shuffled distributions.",
        "Float comparisons use total_cmp and the resulting order is documented."
      ],
      "crates": [
        "std",
        "rayon",
        "criterion"
      ],
      "github": [
        {
          "name": "rayon-rs/rayon",
          "url": "https://github.com/rayon-rs/rayon"
        }
      ],
      "pitfall": "Sorting by a float key with partial_cmp().unwrap(): one NaN in production input panics the sort, and a comparator that is not a total order can make the sort produce a wrong permutation instead of an error.",
      "resources": [
        {
          "title": "slice::sort_unstable — implementation notes and guarantees",
          "url": "https://doc.rust-lang.org/std/primitive.slice.html",
          "kind": "docs"
        },
        {
          "title": "rayon: data-parallel sorting",
          "url": "https://docs.rs/rayon/latest/rayon/",
          "kind": "docs"
        },
        {
          "title": "rayon-rs/rayon repository",
          "url": "https://github.com/rayon-rs/rayon",
          "kind": "repo"
        },
        {
          "title": "On the Worst-Case Complexity of TimSort",
          "url": "https://arxiv.org/abs/1805.08612",
          "kind": "paper"
        },
        {
          "title": "15 Sorting Algorithms in 6 Minutes (visualisation)",
          "url": "https://www.youtube.com/watch?v=kPRA0W1kECg",
          "kind": "video"
        }
      ]
    },
    {
      "id": "a05",
      "title": "Binary search: bounds, predicates, and off-by-one",
      "minutes": 75,
      "level": "advanced",
      "goal": "Derive lower and upper bounds from a single predicate loop, avoid overflow and termination bugs, and apply binary search to answer spaces rather than arrays.",
      "sections": [
        {
          "h": "binary_search answers membership, not bounds",
          "p": [
            "slice::binary_search returns Result<usize, usize>: the index of some matching element, or the insertion point if there is none. With duplicates, which matching element you get is unspecified, so using it to find the first occurrence is a bug that passes tests on unique data and fails in production. It is a membership test with an index attached.",
            "partition_point is the primitive you actually want. It takes a predicate that is false for a prefix and true for the rest, and returns the length of the false prefix - the first index where the predicate holds. Lower bound is partition_point(|x| *x < target) and upper bound is partition_point(|x| *x <= target). The difference between them is the duplicate count, and both are O(log n) with no allocation."
          ],
          "code": `/// First index whose value is >= target.
pub fn lower_bound(xs: &[i64], target: i64) -> usize {
    xs.partition_point(|&x| x < target)
}

/// First index whose value is > target.
pub fn upper_bound(xs: &[i64], target: i64) -> usize {
    xs.partition_point(|&x| x <= target)
}

/// Number of occurrences of target in a sorted slice.
pub fn count_occurrences(xs: &[i64], target: i64) -> usize {
    let lo = lower_bound(xs, target);
    let hi = upper_bound(xs, target);
    if lo < hi { hi - lo } else { 0 }
}`,
          "tip": "Predicate form removes the duplicated search: any monotone condition can be expressed as a closure, and partition_point handles the loop."
        },
        {
          "h": "One loop, three invariants",
          "p": [
            "Writing the loop by hand is still worth learning because the answer-space variant has no slice to call partition_point on. Use a half-open interval [lo, hi) with the invariants: everything before lo is false, everything from hi onwards is true, and the answer is lo when the loop ends. The loop condition is lo < hi, and the update is always hi = mid or lo = mid + 1, so the interval strictly shrinks.",
            "Compute mid as lo + (hi - lo) / 2, not (lo + hi) / 2. For usize indices near the top of the address space the sum overflows, and in release mode that wraps into a wrong index rather than panicking. The subtraction form cannot overflow because hi >= lo. This is the same fix that took years to land in the Java standard library, and it costs nothing."
          ],
          "code": `/// Generic lower bound: first index in 0..=len where pred is true.
/// pred must be monotone: false...false true...true.
pub fn first_true(mut lo: usize, mut hi: usize, pred: impl Fn(usize) -> bool) -> usize {
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if pred(mid) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    lo
}

fn main() {
    let xs = [1, 3, 3, 3, 7, 9];
    let lo = first_true(0, xs.len(), |i| xs[i] >= 3);
    let hi = first_true(0, xs.len(), |i| xs[i] > 3);
    assert_eq!((lo, hi), (1, 4));
    assert_eq!(hi - lo, 3);
    println!("3 occurs {hi_minus_lo} times", hi_minus_lo = hi - lo);
}`
        },
        {
          "h": "Binary search on the answer",
          "p": [
            "Many problems ask for the smallest capacity, speed, or timeout that makes something feasible. If feasibility is monotone - once a capacity works, every larger one also works - you can binary search the answer space directly. The predicate is a full simulation that runs in O(n), so the total is O(n log range), which is far better than enumerating candidates.",
            "The two failure modes are a predicate that is not actually monotone (often because of an off-by-one in the simulation) and a search range that excludes the answer. Set lo to a value known infeasible and hi to a value known feasible, then prove both by running the predicate once on each. If hi is infeasible, the loop returns a wrong answer rather than an error, so assert the boundary before searching."
          ],
          "code": `/// Minimum ship capacity to move all weights within the given number of days.
/// Feasibility is monotone in capacity, so binary search the capacity space.
pub fn ship_within_days(weights: &[u32], days: u32) -> u32 {
    let feasible = |capacity: u32| -> bool {
        let mut used_days = 1u32;
        let mut load = 0u32;
        for &w in weights {
            if load + w > capacity {
                used_days += 1;
                load = w;
            } else {
                load += w;
            }
        }
        used_days <= days
    };

    let mut lo = *weights.iter().max().expect("non-empty input"); // single heaviest item
    let mut hi: u32 = weights.iter().sum(); // one day, everything at once
    assert!(feasible(hi), "hi must be feasible or the search is unbounded");

    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if feasible(mid) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    lo
}`,
          "tip": "Assert that hi is feasible before the loop. An infeasible upper bound silently returns hi, which looks like a plausible capacity."
        },
        {
          "h": "Memory layout: when binary search is not the bottleneck",
          "p": [
            "Binary search on a sorted array is O(log n) comparisons but each comparison is a potential cache miss, and for large arrays the misses dominate. The Eytzinger layout stores the tree breadth-first so the first comparisons land in the same cache lines, and branch-free variants convert unpredictable branches into conditional moves. Measurements in the literature show a two to three times improvement on multi-million-element arrays for the same O(log n).",
            "For small arrays the picture reverses: a linear scan over 32 elements is a handful of vectorised loads and beats the branchy search loop. The practical rule is to measure at your real size, and to remember that a sorted Vec plus binary search is often faster than a BTreeMap for read-mostly data because it has no pointer chasing and one allocation."
          ],
          "list": [
            "n <= 32: linear scan, possibly with SIMD-friendly chunks",
            "n up to a few million: sorted Vec plus partition_point",
            "Very large or mutating: BTreeMap, or an Eytzinger layout rebuilt in batches"
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement `min_capacity(weights: &[u32], days: u32) -> u32` for the ship-within-days problem, then add `first_at_least(xs: &[i64], target: i64) -> Option<usize>` that returns None when every element is smaller. Prove the predicate boundaries with assertions.",
        "starter": "pub fn min_capacity(weights: &[u32], days: u32) -> u32 {\n    // binary search the capacity; feasibility is monotone\n    todo!()\n}\n\npub fn first_at_least(xs: &[i64], target: i64) -> Option<usize> {\n    // partition_point plus a bounds check\n    todo!()\n}",
        "hint": "lo starts at the heaviest single item (infeasible below it) and hi at the total weight (always feasible). For first_at_least, compute idx = xs.partition_point(|&x| x < target) and return None when idx == xs.len().",
        "solution": `pub fn min_capacity(weights: &[u32], days: u32) -> u32 {
    let feasible = |capacity: u32| -> bool {
        let mut used_days = 1u32;
        let mut load = 0u32;
        for &w in weights {
            if load + w > capacity {
                used_days += 1;
                load = w;
            } else {
                load += w;
            }
        }
        used_days <= days
    };

    let mut lo = *weights.iter().max().expect("non-empty input");
    let mut hi = weights.iter().sum::<u32>();
    assert!(feasible(hi));

    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if feasible(mid) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    lo
}

pub fn first_at_least(xs: &[i64], target: i64) -> Option<usize> {
    let idx = xs.partition_point(|&x| x < target);
    (idx < xs.len()).then_some(idx)
}

fn main() {
    let weights = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert_eq!(min_capacity(&weights, 5), 15);
    assert_eq!(min_capacity(&weights, 1), 55);

    let xs = [2, 4, 4, 4, 9];
    assert_eq!(first_at_least(&xs, 4), Some(1));
    assert_eq!(first_at_least(&xs, 10), None);
    println!("ok");
}`
      },
      "questions": [
        {
          "q": "Why is mid = lo + (hi - lo) / 2 preferred over (lo + hi) / 2?",
          "options": [
            "It produces a different midpoint that converges faster",
            "It avoids integer overflow when lo and hi are both large",
            "It keeps the interval half-open",
            "It removes the need for a loop invariant"
          ],
          "answer": 1,
          "explain": "lo + hi can overflow usize for large values. The subtraction form cannot, because hi >= lo means the difference is representable."
        },
        {
          "q": "xs.partition_point(|&x| x < 5) on a sorted slice returns what?",
          "options": [
            "The index of any element equal to 5",
            "The number of elements strictly less than 5",
            "The number of elements less than or equal to 5",
            "A bool indicating whether 5 is present"
          ],
          "answer": 1,
          "explain": "partition_point returns the length of the prefix where the predicate holds. With the predicate x < 5, that prefix is exactly the elements below 5, so the return value is also their count."
        },
        {
          "q": "When does binary search on the answer produce a wrong result instead of an error?",
          "options": [
            "When the array is not sorted",
            "When the upper bound of the search range is infeasible",
            "When the predicate allocates",
            "When the answer is zero"
          ],
          "answer": 1,
          "explain": "The loop assumes the answer lies in [lo, hi] and that hi is feasible. If nothing in the range is feasible, it converges to hi and returns a value that looks valid."
        }
      ],
      "quickbytes": [
        "Lower bound: partition_point(|x| *x < target). Upper bound: partition_point(|x| *x <= target).",
        "binary_search is a membership test; never rely on which duplicate index it returns.",
        "Assert that the high end of an answer-space search is feasible before looping.",
        "Prefer a sorted Vec over a BTreeMap for read-mostly lookup below a few million entries."
      ],
      "production": [
        "Bound searches use partition_point or a documented predicate, never a hand-rolled duplicate.",
        "Answer-space searches assert feasibility at both ends and log the range on failure.",
        "Midpoint arithmetic uses the subtraction form everywhere, including usize indices.",
        "Binary search over untrusted or mutated data re-validates the sorted invariant first."
      ],
      "crates": [
        "std",
        "criterion"
      ],
      "github": [
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        }
      ],
      "pitfall": "Using binary_search to find the first occurrence of a duplicated key: it may return any matching index, so pagination and range scans silently start in the middle of a run of equal records.",
      "resources": [
        {
          "title": "slice::partition_point and binary_search",
          "url": "https://doc.rust-lang.org/std/primitive.slice.html",
          "kind": "docs"
        },
        {
          "title": "Array Layouts for Comparison-Based Searching",
          "url": "https://arxiv.org/abs/1509.05053",
          "kind": "paper"
        },
        {
          "title": "criterion: benchmarking search variants at real sizes",
          "url": "https://docs.rs/criterion/latest/criterion/",
          "kind": "docs"
        },
        {
          "title": "rust-lang/rust repository",
          "url": "https://github.com/rust-lang/rust",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "a06",
      "title": "Stacks, queues, and the monotonic stack",
      "minutes": 70,
      "level": "core",
      "goal": "Use Vec and VecDeque for their real cost model, and turn an O(n^2) next-greater scan into a single-pass monotonic stack.",
      "sections": [
        {
          "h": "Vec is the stack; VecDeque is the ring",
          "p": [
            "Vec is the stack: push and pop work at the end, both amortised O(1), and the data stays contiguous. VecDeque is a growable ring buffer with O(1) push and pop at both ends; it stores a head index and wraps, so the contents are logically contiguous but physically in up to two slices. Indexing is still O(1), iteration handles the wrap, and make_contiguous rotates the buffer when you need one slice.",
            "std::LinkedList is a doubly linked list with a cursor API, and it is almost never what you want. Every push allocates, traversal chases pointers, and there is no O(1) indexing, so a Vec beats it for stacks and a VecDeque beats it for queues at every size where the difference can be measured. Reach for LinkedList only when you need stable node references plus splicing, and even then an arena usually wins."
          ],
          "list": [
            "Stack: Vec, push/pop at the end",
            "Queue and deque: VecDeque, push_back with pop_front",
            "Bounded work queue: VecDeque plus an explicit capacity check, or a channel with backpressure",
            "Avoid Vec::remove(0): it shifts every element and turns a queue into O(n) per pop"
          ]
        },
        {
          "h": "The monotonic stack",
          "p": [
            "The next-greater-element problem asks, for every position, where the next larger value sits. The naive scan is O(n^2). The monotonic stack keeps indices whose values are still waiting for a greater element, in decreasing order, and pops each one when a larger value arrives. Every index is pushed once and popped at most once, so the whole pass is O(n) with O(n) worst-case space.",
            "The stack is not storing a subsequence for its own sake; it encodes a promise: everything on the stack is unresolved, and the values decrease from bottom to top. That invariant is what makes the pop loop correct. The same shape solves daily temperatures, stock span, and the largest rectangle in a histogram, where the stack holds bars in increasing height and a shorter bar closes them."
          ],
          "code": `/// For each index, the index of the next strictly greater value.
pub fn next_greater(xs: &[i64]) -> Vec<Option<usize>> {
    let mut out = vec![None; xs.len()];
    let mut stack: Vec<usize> = Vec::with_capacity(xs.len());

    for i in 0..xs.len() {
        while let Some(&top) = stack.last() {
            if xs[top] < xs[i] {
                out[top] = Some(i);
                stack.pop();
            } else {
                break;
            }
        }
        stack.push(i);
    }
    out
}

/// Days until a warmer temperature, the same algorithm with a different output.
pub fn daily_temperatures(temps: &[i32]) -> Vec<i32> {
    let mut wait = vec![0i32; temps.len()];
    let mut stack: Vec<usize> = Vec::new();
    for i in 0..temps.len() {
        while let Some(&top) = stack.last() {
            if temps[top] < temps[i] {
                wait[top] = (i - top) as i32;
                stack.pop();
            } else {
                break;
            }
        }
        stack.push(i);
    }
    wait
}`,
          "tip": "If the inner while loop can pop each element only once, the total work is linear no matter how the loop looks."
        },
        {
          "h": "The deque as a sliding window",
          "p": [
            "A monotonic deque keeps candidate maxima for a sliding window in decreasing order, dropping from the back anything the new element dominates and from the front anything that has left the window. Each index enters and leaves once, so the window maximum over n elements costs O(n) instead of O(nk). This is the standard fix for rate limiting, rolling statistics, and streaming aggregates.",
            "VecDeque is also the right container for 0-1 BFS, where edges cost zero or one: push a zero-cost neighbour to the front and a one-cost neighbour to the back, and the deque stays sorted by distance without a heap. Both uses rely on the same discipline as the monotonic stack - state an invariant about the container's contents, then make every operation preserve it."
          ],
          "code": `use std::collections::VecDeque;

/// Maximum of every window of size k. O(n) time, O(k) space.
pub fn max_sliding_window(xs: &[i32], k: usize) -> Vec<i32> {
    assert!(k > 0 && k <= xs.len());
    let mut deque: VecDeque<usize> = VecDeque::with_capacity(k);
    let mut out = Vec::with_capacity(xs.len() - k + 1);

    for i in 0..xs.len() {
        while deque.back().is_some_and(|&j| xs[j] <= xs[i]) {
            deque.pop_back();
        }
        deque.push_back(i);

        if let Some(&front) = deque.front() {
            if front + k == i + 1 {
                deque.pop_front();
            }
        }
        if i + 1 >= k {
            out.push(xs[*deque.front().expect("window is non-empty")]);
        }
    }
    out
}`,
          "tip": "Drop expired indices before pushing the output, not after, or the first window can report a value that already left it."
        }
      ],
      "exercise": {
        "prompt": "Implement `next_greater` returning, for each index, the index of the next strictly greater element or None. Then implement `span(prices: &[u64]) -> Vec<usize>` where span[i] is how many consecutive days ending at i had a price less than or equal to prices[i].",
        "starter": "pub fn next_greater(xs: &[i64]) -> Vec<Option<usize>> {\n    // stack of unresolved indices, values decreasing from bottom to top\n    todo!()\n}\n\npub fn span(prices: &[u64]) -> Vec<usize> {\n    // pop while the stacked price is <= today's price, then span = i - previous index\n    todo!()\n}",
        "hint": "For next_greater, store indices on the stack and pop while xs[top] < xs[i]. For span, store indices of unresolved days and pop while prices[top] <= prices[i]; when the stack empties, the span reaches back to day zero.",
        "solution": `pub fn next_greater(xs: &[i64]) -> Vec<Option<usize>> {
    let mut out = vec![None; xs.len()];
    let mut stack: Vec<usize> = Vec::with_capacity(xs.len());
    for i in 0..xs.len() {
        while let Some(&top) = stack.last() {
            if xs[top] < xs[i] {
                out[top] = Some(i);
                stack.pop();
            } else {
                break;
            }
        }
        stack.push(i);
    }
    out
}

pub fn span(prices: &[u64]) -> Vec<usize> {
    let mut spans = vec![0usize; prices.len()];
    let mut stack: Vec<usize> = Vec::with_capacity(prices.len());
    for i in 0..prices.len() {
        while let Some(&top) = stack.last() {
            if prices[top] <= prices[i] {
                stack.pop();
            } else {
                break;
            }
        }
        spans[i] = match stack.last() {
            Some(&top) => i - top,
            None => i + 1,
        };
        stack.push(i);
    }
    spans
}

fn main() {
    assert_eq!(next_greater(&[2, 1, 3]), vec![Some(2), Some(2), None]);
    assert_eq!(span(&[100, 80, 60, 70, 60, 75, 85]), vec![1, 1, 1, 2, 1, 4, 6]);
    println!("ok");
}`
      },
      "questions": [
        {
          "q": "Why does the monotonic stack make next-greater linear rather than quadratic?",
          "options": [
            "Because the stack is sorted, so lookup is binary search",
            "Because each index is pushed once and popped at most once across the whole pass",
            "Because it skips elements that are smaller than their predecessor",
            "Because it uses recursion instead of a nested loop"
          ],
          "answer": 1,
          "explain": "The inner while loop looks quadratic but each element leaves the stack at most once, so the total number of pops is bounded by n."
        },
        {
          "q": "Which collections does std provide with amortised O(1) push and pop at both ends?",
          "options": [
            "Vec and LinkedList",
            "VecDeque",
            "BinaryHeap",
            "BTreeMap"
          ],
          "answer": 1,
          "explain": "VecDeque is a growable ring buffer and supports constant-time operations at both ends. Vec only at the back; LinkedList allocates per node and is slower in practice."
        },
        {
          "q": "In the sliding-window maximum, why is xs[j] <= xs[i] the pop condition rather than <?",
          "options": [
            "Equal values must be kept to preserve window size",
            "An equal value that is newer dominates the older one, which would expire sooner",
            "Using < would overflow the deque",
            "It makes the deque stable"
          ],
          "answer": 1,
          "explain": "If a newer element is equal, the older one can never be the unique maximum before the newer one expires, so dropping it keeps the deque minimal and correct."
        }
      ],
      "quickbytes": [
        "Vec is the fastest stack; VecDeque is the fastest queue; LinkedList is almost never either.",
        "Vec::remove(0) is O(n): use VecDeque::pop_front for FIFO work.",
        "In a monotonic stack, count the pops: total pops <= n proves linear time.",
        "VecDeque::make_contiguous returns &mut [T] and may rotate the buffer, costing O(n) once."
      ],
      "production": [
        "Queues use VecDeque or a bounded channel with explicit backpressure, never Vec::remove(0).",
        "Streaming windows keep a monotonic deque so cost stays O(n) as the window grows.",
        "Bounded queues define what happens when full: block, drop oldest, or reject with an error.",
        "Stack-based parsers cap depth or use an explicit heap stack to avoid overflow on hostile input."
      ],
      "crates": [
        "std",
        "smallvec"
      ],
      "github": [
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        }
      ],
      "pitfall": "Using Vec::remove(0) as a queue pop: every call shifts the remaining elements, so a loop that processes a million items does a trillion moves and the service appears to hang.",
      "resources": [
        {
          "title": "std::collections::VecDeque — growable ring buffer",
          "url": "https://doc.rust-lang.org/std/collections/struct.VecDeque.html",
          "kind": "docs"
        },
        {
          "title": "std::collections — choosing between Vec, VecDeque, and LinkedList",
          "url": "https://doc.rust-lang.org/std/collections/index.html",
          "kind": "docs"
        },
        {
          "title": "rust-lang/rust: standard library sources",
          "url": "https://github.com/rust-lang/rust",
          "kind": "repo"
        },
        {
          "title": "smallvec: inline storage for short stacks",
          "url": "https://docs.rs/smallvec/latest/smallvec/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "a07",
      "title": "Linked lists: boxes, arenas, and a recursive Drop",
      "minutes": 85,
      "level": "advanced",
      "goal": "Build a singly linked list that compiles, reverse it without unsafe, and explain why a deep list can overflow the stack when it is dropped.",
      "sections": [
        {
          "h": "Why the default answer is not a linked list",
          "p": [
            "A linked list gives O(1) insertion given a node reference, but every traversal is a pointer chase with a cache miss per node, and there is no O(1) indexing. On modern hardware a Vec scan is often ten times faster per element, which is why std::LinkedList is a niche tool for splicing large lists, not a general-purpose sequence. Rust's version is doubly linked with a cursor API, and it still allocates once per element.",
            "The structure is worth learning anyway because it is the cleanest exercise in ownership. Insertion at the head moves a Box, reversal rewires next pointers that the borrow checker will not let you alias, and deletion has to prove that the removed node is dropped exactly once. Graph and tree code uses the same ideas at a larger scale."
          ],
          "list": [
            "Vec for sequences, stacks, and almost every queue",
            "VecDeque for FIFO with cheap ends",
            "Arena (Vec of nodes plus indices) for graphs, trees, and intrusive structures",
            "std::LinkedList only when you need stable nodes and splice"
          ]
        },
        {
          "h": "Ownership: take, rewire, put back",
          "p": [
            "A node owns its successor: struct Node { value: i32, next: Option<Box<Node>> }. To move the head out you cannot copy it, so you take() it, leaving None behind. Reversal then walks the list with three variables - previous, current, next - and each step detaches the successor before reassigning, because holding two mutable paths into the same node is exactly what the borrow checker forbids.",
            "The take-and-replace pattern is the general answer to moving out of a place you only have &mut access to. It costs nothing at runtime: Option<Box<T>> is pointer-sized thanks to the null-pointer optimisation, and take is a mem::replace with None. Writing the loop by hand once is the fastest way to stop fighting the compiler on tree and list code."
          ],
          "code": `#[derive(Debug)]
struct Node {
    value: i32,
    next: Option<Box<Node>>,
}

#[derive(Debug, Default)]
pub struct List {
    head: Option<Box<Node>>,
    len: usize,
}

impl List {
    pub fn push_front(&mut self, value: i32) {
        let next = self.head.take();
        self.head = Some(Box::new(Node { value, next }));
        self.len += 1;
    }

    pub fn pop_front(&mut self) -> Option<i32> {
        let mut node = self.head.take()?;
        self.head = node.next.take();
        self.len -= 1;
        Some(node.value)
    }

    /// Reverse in place, O(n) time and O(1) extra space.
    pub fn reverse(&mut self) {
        let mut previous: Option<Box<Node>> = None;
        let mut current = self.head.take();
        while let Some(mut node) = current {
            current = node.next.take();
            node.next = previous;
            previous = Some(node);
        }
        self.head = previous;
    }

    pub fn len(&self) -> usize {
        self.len
    }
}`,
          "tip": "Option<Box<T>> is one pointer wide: None is the null pointer. Boxing a node does not cost an extra tag."
        },
        {
          "h": "Drop is recursive, and that is a real bug",
          "p": [
            "The derived drop glue for Option<Box<Node>> drops the head, which drops its next, which drops its next: one stack frame per node. A list of a hundred thousand nodes needs a hundred thousand frames, and the default 8 MB thread stack overflows inside drop, where the panic cannot even be caught reliably. The program aborts during cleanup, which looks like a random crash at shutdown.",
            "The fix is an explicit Drop that unlinks iteratively before the nodes go out of scope. Take the head, then repeatedly take the successor and let the current node drop with next already None. Every serious intrusive list in Rust does this, and so does the standard library for some recursive types. Any time you write a recursive data structure with an owning pointer, ask what its drop does."
          ],
          "code": `impl Drop for List {
    fn drop(&mut self) {
        // Unlink iteratively: dropping the chain recursively would use one
        // stack frame per node and abort on long lists.
        let mut current = self.head.take();
        while let Some(mut node) = current {
            current = node.next.take();
        }
    }
}

fn main() {
    let mut list = List::default();
    for i in 0..1_000_000 {
        list.push_front(i);
    }
    list.reverse();
    assert_eq!(list.len(), 1_000_000);
    assert_eq!(list.pop_front(), Some(0));
    // Dropping one million nodes here is iterative, so it does not overflow.
}`,
          "tip": "Write a test that builds a list of 1e6 nodes and drops it. If it aborts, you have the recursive-drop bug."
        },
        {
          "h": "Arenas: indices instead of pointers",
          "p": [
            "An arena stores nodes in a Vec and refers to them by index: struct Arena { nodes: Vec<NodeSlot> } with left: Option<u32> and right: Option<u32>. There is no Rc, no RefCell, no unsafe, and no recursive drop, because the Vec owns every node flatly. Indices are Copy, so algorithms can hold several at once without borrow conflicts, which is exactly where a pointer-based tree becomes painful.",
            "The costs are real: a stale index is a logic error rather than a compile error, removal needs free-list management, and a u32 index caps you at four billion nodes. Generational indices - index plus a generation counter - turn stale references into detectable errors. For parsers, dependency graphs, and the capstone's routing graph, an arena with u32 ids is the layout that keeps traversal fast and the code boring."
          ],
          "list": [
            "Index 0 as a sentinel or reserve Option<u32> for absence; document which",
            "Deletion: swap_remove is O(1) but invalidates the moved index",
            "Generational ids catch use-after-free that indices otherwise hide",
            "Keep hot fields first in the slot struct so a cache line holds what traversal needs"
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement a singly linked list with push_front, pop_front, and an in-place reverse, then add an iterative Drop so that dropping a list of one million nodes does not overflow the stack. Prove the reverse with a test that compares against the original Vec order.",
        "starter": "#[derive(Debug)]\nstruct Node {\n    value: i32,\n    next: Option<Box<Node>>,\n}\n\npub struct List {\n    head: Option<Box<Node>>,\n}\n\nimpl List {\n    pub fn push_front(&mut self, value: i32) { todo!() }\n    pub fn pop_front(&mut self) -> Option<i32> { todo!() }\n    pub fn reverse(&mut self) { todo!() }\n}\n\nimpl Drop for List {\n    fn drop(&mut self) { todo!() }\n}",
        "hint": "push_front takes self.head and rebuilds it with a new node. reverse walks with previous/current and uses node.next.take() before reassigning. Drop loops taking successors so each node is freed with next already None.",
        "solution": `#[derive(Debug)]
struct Node {
    value: i32,
    next: Option<Box<Node>>,
}

pub struct List {
    head: Option<Box<Node>>,
}

impl List {
    pub fn new() -> Self {
        Self { head: None }
    }

    pub fn push_front(&mut self, value: i32) {
        let next = self.head.take();
        self.head = Some(Box::new(Node { value, next }));
    }

    pub fn pop_front(&mut self) -> Option<i32> {
        let mut node = self.head.take()?;
        self.head = node.next.take();
        Some(node.value)
    }

    pub fn reverse(&mut self) {
        let mut previous: Option<Box<Node>> = None;
        let mut current = self.head.take();
        while let Some(mut node) = current {
            current = node.next.take();
            node.next = previous;
            previous = Some(node);
        }
        self.head = previous;
    }

    pub fn to_vec(&self) -> Vec<i32> {
        let mut out = Vec::new();
        let mut cursor = self.head.as_deref();
        while let Some(node) = cursor {
            out.push(node.value);
            cursor = node.next.as_deref();
        }
        out
    }
}

impl Drop for List {
    fn drop(&mut self) {
        let mut current = self.head.take();
        while let Some(mut node) = current {
            current = node.next.take();
        }
    }
}

fn main() {
    let mut list = List::new();
    for value in [3, 2, 1] {
        list.push_front(value);
    }
    assert_eq!(list.to_vec(), vec![1, 2, 3]);
    list.reverse();
    assert_eq!(list.to_vec(), vec![3, 2, 1]);
    assert_eq!(list.pop_front(), Some(3));

    let mut big = List::new();
    for i in 0..1_000_000 {
        big.push_front(i);
    }
    drop(big); // iterative Drop: no stack overflow
    println!("ok");
}`
      },
      "questions": [
        {
          "q": "Why is reversing a Box-based list written with take() rather than assigning through references?",
          "options": [
            "take() is faster at runtime because it avoids a branch",
            "Moving out through &mut requires leaving a valid value behind, and two mutable paths to a node would alias",
            "Box cannot be dereferenced without take",
            "The borrow checker allows the reference version but LLVM miscompiles it"
          ],
          "answer": 1,
          "explain": "You cannot move a Box out of a borrowed node; take swaps in None. And two live mutable references to the same node would violate the aliasing rules the checker enforces."
        },
        {
          "q": "What actually fails when dropping a long Box-linked list without a custom Drop?",
          "options": [
            "The allocator deadlocks",
            "Drop recursion consumes one stack frame per node until the thread stack overflows",
            "The list is leaked silently",
            "Every node is dropped twice"
          ],
          "answer": 1,
          "explain": "Drop glue is recursive through next. A hundred thousand nodes need a hundred thousand frames, which overflows the stack during cleanup and aborts the process."
        },
        {
          "q": "What does an arena buy over Rc<RefCell<T>> for tree nodes?",
          "options": [
            "It allows cycles to be collected automatically",
            "It removes reference counting, runtime borrow checks, and recursive drops at the cost of manual index validity",
            "It makes deletion O(1) with stable indices",
            "It compiles to the same code but reads better"
          ],
          "answer": 1,
          "explain": "Arena nodes live in one Vec, addressed by Copy indices. There is no refcount traffic or RefCell check, but you must manage stale indices and deletion yourself."
        }
      ],
      "quickbytes": [
        "Option<Box<T>> is a single pointer: None is the null pointer, no tag byte.",
        "Give any owning recursive structure an explicit iterative Drop and test it with a million nodes.",
        "take() leaves None behind, which is how you move a value out of a place you only borrow.",
        "Prefer arena indices over Rc<RefCell<_>> for trees and graphs with sharing and cycles."
      ],
      "production": [
        "Recursive owning structures either cap depth or implement iterative Drop.",
        "Linked structures are justified in writing; sequences and queues default to Vec and VecDeque.",
        "Arena indices are typed newtypes and validated at every public boundary.",
        "Long-list behaviour is covered by a test with at least 100k nodes."
      ],
      "crates": [
        "std",
        "smallvec"
      ],
      "github": [
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        }
      ],
      "pitfall": "A derived Drop on a million-node linked list overflows the stack inside drop, so the process aborts during cleanup and the backtrace points at the allocator instead of the list.",
      "resources": [
        {
          "title": "std::collections::LinkedList",
          "url": "https://doc.rust-lang.org/std/collections/struct.LinkedList.html",
          "kind": "docs"
        },
        {
          "title": "std::collections — data structure trade-offs",
          "url": "https://doc.rust-lang.org/std/collections/index.html",
          "kind": "docs"
        },
        {
          "title": "rust-lang/rust: Box and linked-list internals",
          "url": "https://github.com/rust-lang/rust",
          "kind": "repo"
        },
        {
          "title": "smallvec: avoid per-node allocation for short lists",
          "url": "https://docs.rs/smallvec/latest/smallvec/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "a08",
      "title": "Trees and traversals: depth, order, and arena layout",
      "minutes": 90,
      "level": "advanced",
      "goal": "Keep a search tree balanced enough to matter, traverse it without recursion limits, and store nodes in an arena so traversals stay cache-friendly.",
      "sections": [
        {
          "h": "The invariant is the tree",
          "p": [
            "A binary search tree promises that everything in the left subtree is smaller and everything in the right subtree is larger, which makes search O(height). Insert 1..n in order and the tree becomes a linked list of height n, so search degrades to O(n) with pointer chasing on top. The invariant still holds; the shape is just useless, which is why self-balancing trees exist.",
            "Production code rarely hand-rolls a balanced BST. BTreeMap gives ordered iteration, ranges, and O(log n) operations with a high branching factor that suits cache lines. Red-black and AVL trees are worth understanding for the rotation logic and for reading library code, but reaching for one when BTreeMap exists is usually a mistake. A search tree you wrote yourself is justified by the algorithm on top of it, not by the container."
          ],
          "list": [
            "BTreeMap/BTreeSet for ordered maps, ranges, and floor/ceil queries",
            "BinaryHeap for priority, not for ordered traversal",
            "Hand-written trees when the tree is the algorithm (tries, segment trees, interval trees)"
          ]
        },
        {
          "h": "Iterative inorder, explicit stack",
          "p": [
            "Recursive inorder is four lines and three of them are correct, but it consumes one stack frame per level. A degenerate tree is a million levels deep, and the traversal overflows the stack before it finishes. An explicit Vec-based stack uses heap memory and has a hard, inspectable bound, which is the right trade for parsing untrusted input.",
            "The iterative version walks left as far as possible, pushing each node, then pops one, visits it, and descends into its right child. The invariant is that the stack holds exactly the ancestors whose left subtree is being consumed. That yields sorted output from a BST and a natural way to implement an iterator with a resume point, which is what a database cursor does over an index."
          ],
          "code": `pub struct Node {
    pub key: i64,
    pub left: Option<u32>,
    pub right: Option<u32>,
}

pub struct ArenaTree {
    pub nodes: Vec<Node>,
    pub root: Option<u32>,
}

impl ArenaTree {
    pub fn new() -> Self {
        Self { nodes: Vec::new(), root: None }
    }

    pub fn insert(&mut self, key: i64) {
        let new_id = self.nodes.len() as u32;
        self.nodes.push(Node { key, left: None, right: None });

        let Some(mut current) = self.root else {
            self.root = Some(new_id);
            return;
        };

        loop {
            let slot = &mut self.nodes[current as usize];
            let branch = if key < slot.key { &mut slot.left } else { &mut slot.right };
            match *branch {
                Some(next) => current = next,
                None => {
                    *branch = Some(new_id);
                    return;
                }
            }
        }
    }

    /// Inorder keys without recursion: left spine, pop, then right subtree.
    pub fn inorder(&self) -> Vec<i64> {
        let mut out = Vec::with_capacity(self.nodes.len());
        let mut stack: Vec<u32> = Vec::new();
        let mut current = self.root;

        while current.is_some() || !stack.is_empty() {
            while let Some(id) = current {
                stack.push(id);
                current = self.nodes[id as usize].left;
            }
            let id = stack.pop().expect("loop condition guarantees a node");
            let node = &self.nodes[id as usize];
            out.push(node.key);
            current = node.right;
        }
        out
    }
}`,
          "tip": "The traversal needs only the left spine on the stack, never the whole tree: peak memory is O(height)."
        },
        {
          "h": "Arena layout and the borrow checker",
          "p": [
            "Storing nodes in a Vec<u32 indices> removes per-node allocation and makes traversal sequential, but it also creates a borrow problem: you cannot hold &mut to two nodes at once. The insert loop above solves it by re-borrowing the slot on each iteration and only keeping the index, which is the arena idiom. Splitting the borrow with split_at_mut works for arrays but not for a tree.",
            "The pattern generalises to graphs: any structure with cross-links becomes easy once node identity is an integer. The cost is that the compiler no longer proves indices are valid, so the arena's public API should be the only place that dereferences them. A private fn node(&self, id: u32) with a debug assertion, plus newtypes for ids, keeps the invariant reviewable."
          ]
        },
        {
          "h": "Traversals answer different questions",
          "p": [
            "Preorder visits parents before children and is how you copy or serialise a tree. Postorder visits children first and is how you free, evaluate, or compute sizes bottom-up. Inorder gives sorted order for a BST. Level order is BFS and gives shortest hop counts in an unweighted tree. Choosing the wrong one is not a performance bug; it is a wrong answer that still compiles and runs.",
            "Depth-first search on a general graph needs a visited marker because graphs have cycles; a tree does not, but the same code often serves both. petgraph draws the line explicitly: Dfs and Bfs iterators handle visitation, while toposort works on directed acyclic graphs and returns Err(Cycle) when the input has a cycle. Reusing those instead of rewriting traversal logic is usually the right call in production."
          ],
          "code": `use petgraph::algo::toposort;
use petgraph::graph::DiGraph;
use std::collections::VecDeque;

/// Topological order of a dependency graph, or the cycle that prevents it.
pub fn build_order(deps: &DiGraph<&'static str, ()>) -> Result<Vec<&'static str>, String> {
    toposort(deps, None)
        .map(|order| order.into_iter().map(|id| deps[id]).collect())
        .map_err(|cycle| format!("dependency cycle at {:?}", deps[cycle.node_id()]))
}

/// BFS levels from a start node: the tree equivalent of level order.
pub fn levels(graph: &DiGraph<&'static str, ()>, start: petgraph::graph::NodeIndex) -> Vec<Vec<&'static str>> {
    let mut queue: VecDeque<(petgraph::graph::NodeIndex, usize)> = VecDeque::new();
    let mut seen = vec![false; graph.node_count()];
    let mut out: Vec<Vec<&'static str>> = Vec::new();

    seen[start.index()] = true;
    queue.push_back((start, 0));
    while let Some((node, depth)) = queue.pop_front() {
        if out.len() == depth {
            out.push(Vec::new());
        }
        out[depth].push(graph[node]);
        for next in graph.neighbors(node) {
            if !seen[next.index()] {
                seen[next.index()] = true;
                queue.push_back((next, depth + 1));
            }
        }
    }
    out
}`,
          "tip": "For a dependency graph, toposort is the answer to what order, and DFS postorder is the answer to why that order."
        }
      ],
      "exercise": {
        "prompt": "Implement an arena-backed BST with iterative insert and an iterative inorder traversal that returns keys in sorted order. Then add `height()` computed with an explicit stack, and show that inserting a sorted sequence produces a tree of height n.",
        "starter": "pub struct Node {\n    pub key: i64,\n    pub left: Option<u32>,\n    pub right: Option<u32>,\n}\n\npub struct ArenaTree {\n    pub nodes: Vec<Node>,\n    pub root: Option<u32>,\n}\n\nimpl ArenaTree {\n    pub fn insert(&mut self, key: i64) { todo!() }\n    pub fn inorder(&self) -> Vec<i64> { todo!() }\n    pub fn height(&self) -> usize { todo!() }\n}",
        "hint": "Insert: push the node first, then walk from the root re-borrowing each slot until you find a None child. Inorder: descend the left spine pushing ids, pop one, emit, move right. Height: stack of (id, depth), track the maximum.",
        "solution": `pub struct Node {
    pub key: i64,
    pub left: Option<u32>,
    pub right: Option<u32>,
}

pub struct ArenaTree {
    pub nodes: Vec<Node>,
    pub root: Option<u32>,
}

impl ArenaTree {
    pub fn new() -> Self {
        Self { nodes: Vec::new(), root: None }
    }

    pub fn insert(&mut self, key: i64) {
        let new_id = self.nodes.len() as u32;
        self.nodes.push(Node { key, left: None, right: None });

        let Some(mut current) = self.root else {
            self.root = Some(new_id);
            return;
        };

        loop {
            let slot = &mut self.nodes[current as usize];
            let branch = if key < slot.key { &mut slot.left } else { &mut slot.right };
            match *branch {
                Some(next) => current = next,
                None => {
                    *branch = Some(new_id);
                    return;
                }
            }
        }
    }

    pub fn inorder(&self) -> Vec<i64> {
        let mut out = Vec::with_capacity(self.nodes.len());
        let mut stack: Vec<u32> = Vec::new();
        let mut current = self.root;
        while current.is_some() || !stack.is_empty() {
            while let Some(id) = current {
                stack.push(id);
                current = self.nodes[id as usize].left;
            }
            let id = stack.pop().expect("non-empty");
            let node = &self.nodes[id as usize];
            out.push(node.key);
            current = node.right;
        }
        out
    }

    pub fn height(&self) -> usize {
        let Some(root) = self.root else { return 0 };
        let mut best = 0usize;
        let mut stack = vec![(root, 1usize)];
        while let Some((id, depth)) = stack.pop() {
            best = best.max(depth);
            let node = &self.nodes[id as usize];
            if let Some(left) = node.left {
                stack.push((left, depth + 1));
            }
            if let Some(right) = node.right {
                stack.push((right, depth + 1));
            }
        }
        best
    }
}

fn main() {
    let mut balanced = ArenaTree::new();
    for key in [50, 25, 75, 10, 30, 60, 90] {
        balanced.insert(key);
    }
    assert_eq!(balanced.inorder(), vec![10, 25, 30, 50, 60, 75, 90]);
    assert_eq!(balanced.height(), 3);

    let mut degenerate = ArenaTree::new();
    for key in 0..1_000 {
        degenerate.insert(key);
    }
    assert_eq!(degenerate.height(), 1_000); // sorted input, no balancing
    println!("balanced height 3, sorted-insert height 1000");
}`
      },
      "questions": [
        {
          "q": "Inserting 1..n into an unbalanced BST produces what shape and search cost?",
          "options": [
            "A balanced tree with O(log n) search",
            "A right-leaning chain with O(n) search",
            "A heap with O(1) minimum",
            "A tree of height log n but O(n) search"
          ],
          "answer": 1,
          "explain": "Each key is larger than the last, so every node becomes the right child of the previous one. Height and search cost both degrade to n."
        },
        {
          "q": "What is the peak stack memory of the iterative inorder traversal?",
          "options": [
            "O(1) because there is no recursion",
            "O(height), because only the current left spine is stacked",
            "O(n), because every node is pushed",
            "O(log n) only for complete trees"
          ],
          "answer": 1,
          "explain": "At most one node per level sits on the stack at any moment, so peak memory is the tree height. The stack lives on the heap, so it is not bounded by the thread stack."
        },
        {
          "q": "Which traversal computes subtree sizes bottom-up?",
          "options": [
            "Preorder",
            "Inorder",
            "Postorder",
            "Level order"
          ],
          "answer": 2,
          "explain": "Postorder visits children before their parent, so a node sees its children's results already computed. That is why it also works for freeing and expression evaluation."
        }
      ],
      "quickbytes": [
        "BTreeMap already gives ordered iteration and ranges; hand-write a BST only when the algorithm needs it.",
        "Replace recursive traversal with an explicit Vec stack whenever input depth is untrusted.",
        "Arena nodes keyed by u32 remove per-node allocation and recursive drops.",
        "petgraph toposort returns Err(Cycle) instead of silently producing a wrong order."
      ],
      "production": [
        "Trees built from untrusted input have iterative traversal or an explicit depth cap.",
        "Ordered maps use BTreeMap rather than a hand-rolled BST unless the tree is the algorithm.",
        "Arena ids are newtypes validated behind a single accessor.",
        "Dependency ordering uses toposort and reports the cycle node, not a generic error."
      ],
      "crates": [
        "std",
        "petgraph",
        "indexmap"
      ],
      "github": [
        {
          "name": "petgraph/petgraph",
          "url": "https://github.com/petgraph/petgraph"
        },
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        }
      ],
      "pitfall": "Recursive traversal of a tree built from user input: a crafted deeply nested document produces one stack frame per level, and the worker segfaults outside any catchable panic.",
      "resources": [
        {
          "title": "std::collections::BTreeMap",
          "url": "https://doc.rust-lang.org/std/collections/struct.BTreeMap.html",
          "kind": "docs"
        },
        {
          "title": "petgraph: graph and tree traversals",
          "url": "https://docs.rs/petgraph/latest/petgraph/",
          "kind": "docs"
        },
        {
          "title": "petgraph/petgraph repository",
          "url": "https://github.com/petgraph/petgraph",
          "kind": "repo"
        },
        {
          "title": "petgraph::visit — Dfs, Bfs and visitor traits",
          "url": "https://docs.rs/petgraph/latest/petgraph/visit/index.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "a09",
      "title": "Heaps and priority queues: lazy deletion and indexed updates",
      "minutes": 90,
      "level": "industry",
      "goal": "Use BinaryHeap without a decrease-key, decide when lazy deletion is cheaper than an indexed heap, and recognise when a bucket queue beats both.",
      "sections": [
        {
          "h": "BinaryHeap is a max-heap with no update",
          "p": [
            "std::BinaryHeap is a max-heap over T: Ord with O(log n) push and pop and O(1) peek. For a min-heap you wrap the priority in std::cmp::Reverse. It lacks decrease-key, and that absence is deliberate: tracking an item's position requires a handle, an index map, and bookkeeping on every sift, which most users do not want to pay for.",
            "The backing array is the complete binary tree in level order, so children of i are 2i+1 and 2i+2. push appends and sifts up; pop swaps the last element to the root, shrinks, and sifts down. peek_mut is the escape hatch that exposes the top element for mutation, but modifying it in a way that changes ordering is a logic error, not something the type can prevent."
          ]
        },
        {
          "h": "Lazy deletion: how Dijkstra copes",
          "p": [
            "Without decrease-key, the standard trick is to push a new (distance, node) entry every time a shorter distance is found and never remove the old one. When an entry is popped, check it against the current best distance; if it is stale, skip it. The heap can hold up to O(E) entries, but each push is O(log E) and the total stays O(E log E), which is the same asymptotic cost as the indexed version.",
            "The constant matters: duplicate entries cost memory and extra sift work. In practice lazy Dijkstra is often faster than an indexed heap on sparse graphs because pushes and pops are simple and the stale check is a single array load. Reach for an indexed heap when the graph is dense, when memory is tight, or when the same node's priority changes many times."
          ],
          "code": `use std::cmp::Reverse;
use std::collections::BinaryHeap;

/// Dijkstra with lazy deletion. edges[u] = [(v, weight), ...], weights are non-negative.
pub fn dijkstra(edges: &[Vec<(usize, u64)>], start: usize) -> Vec<Option<u64>> {
    let mut dist: Vec<Option<u64>> = vec![None; edges.len()];
    let mut heap: BinaryHeap<Reverse<(u64, usize)>> = BinaryHeap::new();

    dist[start] = Some(0);
    heap.push(Reverse((0, start)));

    while let Some(Reverse((d, u))) = heap.pop() {
        if dist[u].is_some_and(|best| d > best) {
            continue; // stale entry left behind by an earlier relaxation
        }
        for &(v, w) in &edges[u] {
            let candidate = d + w;
            if dist[v].is_none_or(|best| candidate < best) {
                dist[v] = Some(candidate);
                heap.push(Reverse((candidate, v)));
            }
        }
    }
    dist
}`,
          "tip": "The stale check must compare the popped distance to the stored one. Comparing node ids only skips duplicates from the same relaxation, not older ones."
        },
        {
          "h": "Indexed heaps when priorities change in place",
          "p": [
            "priority-queue's PriorityQueue<I, P> keys entries by item identity plus priority, so pushing an existing item updates it and returns the old priority, and change_priority returns the previous value. Internally it keeps a map from item to heap position, which is the decrease-key that std omits. The item type must be Hash + Eq, so use u32 node ids rather than structs.",
            "An indexed heap is the right structure for schedulers where a job's deadline changes, for event simulation with rescheduling, and for algorithms that relax the same node repeatedly. It is the wrong structure when items are inserted once and popped once, because you pay hashing and bookkeeping for an update path you never use."
          ],
          "code": `use priority_queue::PriorityQueue;
use std::cmp::Reverse;

/// Reschedule a job's deadline and prove the old one is returned.
pub fn reschedule(queue: &mut PriorityQueue<String, Reverse<u64>>, job: &str, deadline: u64) {
    let previous = queue.push(job.to_string(), Reverse(deadline));
    match previous {
        Some(Reverse(old)) => println!("{job}: deadline moved from {old} to {deadline}"),
        None => println!("{job}: inserted with deadline {deadline}"),
    }
}

pub fn run() {
    let mut queue: PriorityQueue<String, Reverse<u64>> = PriorityQueue::new();
    reschedule(&mut queue, "nightly-report", 500);
    reschedule(&mut queue, "backup", 200);
    reschedule(&mut queue, "nightly-report", 100); // earlier deadline, priority increased

    assert_eq!(queue.peek(), Some((&"nightly-report".to_string(), &Reverse(100))));
    while let Some((job, Reverse(deadline))) = queue.pop() {
        println!("{job} at {deadline}");
    }
}`,
          "tip": "Reverse<u64> makes the smallest deadline the greatest priority, which is what a scheduler wants."
        },
        {
          "h": "Beyond the binary heap",
          "p": [
            "A d-ary heap with four children per node does more comparisons per sift but has a shallower tree and better cache behaviour, which is why some graph libraries offer 4-ary heaps. A bucket queue (Dial's algorithm) exploits small integer weights: keep one bucket per distance and walk them in order, which turns Dijkstra on unit or tiny weights into O(V + E + C) where C is the largest distance.",
            "Leftist and skew heaps support O(log n) meld, which matters when you merge priority queues rather than push into one. Pairing heaps are simpler and faster in practice despite a worse proven bound. None of these are in std, and each is worth reaching for only when a profile says the heap is the bottleneck rather than the graph traversal around it."
          ],
          "list": [
            "Binary heap: default, best cache behaviour per comparison",
            "d-ary heap: fewer levels, more comparisons per level; good for large queues",
            "Bucket queue: small integer weights, linear time, needs memory proportional to max distance",
            "Meldable heap: merging queues, as in some MST and scheduling variants"
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement Dijkstra with a BinaryHeap and lazy deletion over an adjacency list, then add a `pop_valid` helper that discards stale entries. Prove with a test that a graph with a shorter path discovered later still returns the correct distances.",
        "starter": "use std::cmp::Reverse;\nuse std::collections::BinaryHeap;\n\npub fn dijkstra(edges: &[Vec<(usize, u64)>], start: usize) -> Vec<Option<u64>> {\n    // dist: Vec<Option<u64>>, heap of Reverse((distance, node))\n    todo!()\n}",
        "hint": "Initialise dist[start] = Some(0) and push (0, start). On pop, skip if the popped distance is greater than the stored one; otherwise relax every edge and push improved distances.",
        "solution": `use std::cmp::Reverse;
use std::collections::BinaryHeap;

pub fn dijkstra(edges: &[Vec<(usize, u64)>], start: usize) -> Vec<Option<u64>> {
    let mut dist: Vec<Option<u64>> = vec![None; edges.len()];
    let mut heap: BinaryHeap<Reverse<(u64, usize)>> = BinaryHeap::new();

    dist[start] = Some(0);
    heap.push(Reverse((0, start)));

    while let Some(Reverse((d, u))) = heap.pop() {
        if dist[u].is_some_and(|best| d > best) {
            continue;
        }
        for &(v, w) in &edges[u] {
            let candidate = d + w;
            if dist[v].is_none_or(|best| candidate < best) {
                dist[v] = Some(candidate);
                heap.push(Reverse((candidate, v)));
            }
        }
    }
    dist
}

fn main() {
    // 0 -> 1 costs 10, 0 -> 2 costs 1, 2 -> 1 costs 1: the short path is found after the long one.
    let edges = vec![
        vec![(1, 10), (2, 1)],
        vec![],
        vec![(1, 1)],
    ];
    assert_eq!(dijkstra(&edges, 0), vec![Some(0), Some(2), Some(1)]);
    println!("ok");
}`
      },
      "questions": [
        {
          "q": "Why does Dijkstra push a node more than once with a BinaryHeap?",
          "options": [
            "Because BinaryHeap does not support decrease-key, so an improved distance is a new entry",
            "Because each edge must appear in the heap exactly once",
            "Because the heap is a max-heap and needs both directions",
            "Because stale entries are required for path reconstruction"
          ],
          "answer": 0,
          "explain": "std's heap has no handle to an existing element. Pushing a new (smaller distance, node) pair and skipping stale pops at the top is the standard workaround."
        },
        {
          "q": "What does priority-queue's change_priority require of the item type?",
          "options": [
            "Ord only",
            "Hash + Eq, so the queue can find the item's position",
            "Copy + Default",
            "Send + Sync"
          ],
          "answer": 1,
          "explain": "The indexed heap keeps a map from item to position. Identity hashing is what makes change_priority O(1) to locate plus O(log n) to sift."
        },
        {
          "q": "When does a bucket queue beat a binary heap for shortest paths?",
          "options": [
            "When weights are arbitrary u64 values",
            "When weights are small non-negative integers and the maximum distance is bounded",
            "When the graph is dense and weights are floats",
            "When negative edges are present"
          ],
          "answer": 1,
          "explain": "Dial's algorithm keeps one bucket per distance, so its cost is linear in vertices, edges, and the maximum distance. Large or unbounded weights make the bucket array impractical."
        }
      ],
      "quickbytes": [
        "BinaryHeap is a max-heap: wrap priorities in Reverse for earliest-deadline-first.",
        "Lazy Dijkstra: push duplicates, skip pops where d > dist[u].",
        "priority-queue's push on an existing item updates its priority and returns the old one.",
        "peek_mut exists, but mutating the top into a different ordering is a logic error."
      ],
      "production": [
        "Heap entries carry enough data to detect staleness, and stale entries are skipped before expansion.",
        "Priority updates either use an indexed heap or are proven cheap enough to duplicate.",
        "Scheduler ordering is total, so equal priorities cannot produce nondeterministic order.",
        "Heap size under load is monitored: duplicate entries can multiply memory by the edge count."
      ],
      "crates": [
        "priority-queue",
        "std",
        "criterion"
      ],
      "github": [
        {
          "name": "garro95/priority-queue",
          "url": "https://github.com/garro95/priority-queue"
        },
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        }
      ],
      "pitfall": "Popping a stale heap entry and expanding it anyway: a node's old, larger distance is processed after its better distance was found, and the algorithm reports a longer path than the one that exists.",
      "resources": [
        {
          "title": "std::collections::BinaryHeap",
          "url": "https://doc.rust-lang.org/std/collections/struct.BinaryHeap.html",
          "kind": "docs"
        },
        {
          "title": "priority-queue: indexed priority queue with change_priority",
          "url": "https://docs.rs/priority-queue/latest/priority_queue/",
          "kind": "docs"
        },
        {
          "title": "garro95/priority-queue repository",
          "url": "https://github.com/garro95/priority-queue",
          "kind": "repo"
        },
        {
          "title": "Amortized Analysis of Leftist Heaps",
          "url": "https://arxiv.org/abs/2411.11051",
          "kind": "paper"
        }
      ]
    },
    {
      "id": "a10",
      "title": "Graph BFS and DFS: representation, visitation, cycles",
      "minutes": 90,
      "level": "advanced",
      "goal": "Pick an adjacency representation, traverse without recursion limits, and use colours to detect cycles and produce topological order.",
      "sections": [
        {
          "h": "Representation decides the cost",
          "p": [
            "Vec<Vec<u32>> is the readable adjacency list: one allocation per node, O(1) neighbour iteration, but pointer chasing and per-node allocator overhead. CSR flattens it into offsets plus targets, which is what you want for million-node graphs: two allocations, sequential scans, and no per-node indirection. Building CSR needs the degrees first, so it is a two-pass construction over an edge list.",
            "Directed and undirected differ by one line - insert both directions - and that line is a common source of double-counted components and wrong in-degrees. Node identity should be a dense u32 assigned at load time; keep a HashMap<String, u32> only at the boundary where external ids are parsed. Validating that every edge endpoint is in range is cheaper than debugging a panic three layers into a traversal."
          ],
          "code": `/// Compressed sparse row adjacency: one allocation for offsets, one for targets.
pub struct Csr {
    pub offsets: Vec<u32>,
    pub targets: Vec<u32>,
}

impl Csr {
    /// edges must contain node ids in 0..n.
    pub fn from_edges(n: usize, edges: &[(u32, u32)], directed: bool) -> Self {
        let mut counts = vec![0u32; n + 1];
        for &(u, v) in edges {
            assert!((u as usize) < n && (v as usize) < n, "endpoint out of range");
            counts[u as usize + 1] += 1;
            if !directed {
                counts[v as usize + 1] += 1;
            }
        }
        for i in 0..n {
            counts[i + 1] += counts[i];
        }

        let mut offsets = counts.clone();
        let mut targets = vec![0u32; offsets[n] as usize];
        for &(u, v) in edges {
            let slot = &mut offsets[u as usize];
            targets[*slot as usize] = v;
            *slot += 1;
            if !directed {
                let slot = &mut offsets[v as usize];
                targets[*slot as usize] = u;
                *slot += 1;
            }
        }
        // Restore offsets: the scatter above advanced them.
        let mut start = 0u32;
        let mut rebuilt = vec![0u32; n + 1];
        for i in 0..n {
            rebuilt[i] = start;
            start += counts[i + 1] - counts[i];
        }
        rebuilt[n] = start;
        Self { offsets: rebuilt, targets }
    }

    pub fn neighbors(&self, u: u32) -> &[u32] {
        &self.targets[self.offsets[u as usize] as usize..self.offsets[u as usize + 1] as usize]
    }
}`,
          "tip": "Build CSR from a degree count in one pass, then scatter. If offsets and targets disagree, neighbours() silently returns the wrong slice."
        },
        {
          "h": "BFS: shortest paths in unweighted graphs",
          "p": [
            "BFS explores in order of hop count, so the first time it reaches a node it has found a shortest path in edges. A VecDeque is the queue, a dist array of Option<u32> or u32::MAX is the visited marker, and a parent array reconstructs the path. Mark nodes when they are enqueued, not when they are dequeued, or the queue can hold the same node many times.",
            "The cost is O(V + E) time and O(V) space, which is optimal for the problem. Multi-source BFS seeds the queue with several starts and answers nearest-facility questions in one pass. On a grid, BFS is the algorithm behind flood fill, maze solving, and the rotting-oranges style simulation; on a graph it is the answer to minimum hops, not minimum cost."
          ],
          "code": `use std::collections::VecDeque;

/// BFS distances and parents from one source. Returns None for unreachable nodes.
pub fn bfs(csr: &Csr, start: u32) -> (Vec<Option<u32>>, Vec<Option<u32>>) {
    let n = csr.offsets.len() - 1;
    let mut dist: Vec<Option<u32>> = vec![None; n];
    let mut parent: Vec<Option<u32>> = vec![None; n];
    let mut queue: VecDeque<u32> = VecDeque::with_capacity(n);

    dist[start as usize] = Some(0);
    queue.push_back(start);

    while let Some(u) = queue.pop_front() {
        let next_dist = dist[u as usize].expect("queued nodes have a distance") + 1;
        for &v in csr.neighbors(u) {
            if dist[v as usize].is_none() {
                dist[v as usize] = Some(next_dist);
                parent[v as usize] = Some(u);
                queue.push_back(v);
            }
        }
    }
    (dist, parent)
}

/// Path from start to goal by walking parents backwards, or None if unreachable.
pub fn path_to(parent: &[Option<u32>], start: u32, goal: u32) -> Option<Vec<u32>> {
    let mut path = Vec::new();
    let mut current = goal;
    while current != start {
        path.push(current);
        current = parent[current as usize]?;
    }
    path.push(start);
    path.reverse();
    Some(path)
}`,
          "tip": "Set the visited marker at enqueue time. Marking on dequeue lets the same node enter the queue once per incoming edge."
        },
        {
          "h": "DFS with colours, cycles, and topological order",
          "p": [
            "Recursive DFS is the natural expression and the wrong one for untrusted depth. The iterative version needs an explicit stack of (node, next-child-index) to reproduce postorder, or two stacks if you only need finishing order. White/gray/black colours are the standard cycle detector: reaching a gray node means a back edge, which is a cycle in a directed graph.",
            "Topological order is the reverse of DFS finishing order on a DAG, and petgraph's toposort computes it directly, returning Err(Cycle) when no order exists. A cycle in a dependency graph is a configuration error, not an internal invariant violation, so it belongs in the error type and should name the nodes involved. That is the difference between an operator fixing a manifest and an engineer reading a panic."
          ],
          "code": `#[derive(Clone, Copy, PartialEq)]
enum Color {
    White,
    Gray,
    Black,
}

/// Returns the node that closes a directed cycle, if one exists.
pub fn find_cycle(csr: &Csr) -> Option<u32> {
    let n = csr.offsets.len() - 1;
    let mut color = vec![Color::White; n];

    for start in 0..n {
        if color[start] != Color::White {
            continue;
        }
        let mut stack: Vec<(u32, usize)> = vec![(start as u32, 0)];
        color[start] = Color::Gray;

        while let Some(&mut (u, ref mut next_child)) = stack.last_mut() {
            let neighbors = csr.neighbors(u);
            if *next_child < neighbors.len() {
                let v = neighbors[*next_child];
                *next_child += 1;
                match color[v as usize] {
                    Color::Gray => return Some(v),
                    Color::White => {
                        color[v as usize] = Color::Gray;
                        stack.push((v, 0));
                    }
                    Color::Black => {}
                }
            } else {
                color[u as usize] = Color::Black;
                stack.pop();
            }
        }
    }
    None
}`,
          "tip": "Gray means on the current stack. A white node seen twice is a cross edge, which is fine; a gray node means you have walked a loop."
        },
        {
          "h": "Use the library when the algorithm is not the point",
          "p": [
            "petgraph::visit::Bfs and Dfs are iterators that carry their own visited maps; you construct them with the graph and a start node and call next until None. They handle the visitation bookkeeping, and they compose with the same graph types as the algorithm module. For an application that needs traversal as plumbing, that is less code and fewer bugs than a hand-rolled loop.",
            "Hand-roll when you need something the iterator does not expose: distances, parents, early termination with a custom predicate, or a stack you can inspect. The capstone's router needs parents and distances, so it owns its BFS; the dependency sorter just needs an order, so it calls toposort. Deciding which side of that line you are on is most of the design work."
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement BFS over an adjacency list that returns distances and parents, plus `path_to` that reconstructs the route from start to goal. Then implement directed cycle detection with white/gray/black colours and return a node that closes the cycle.",
        "starter": "use std::collections::VecDeque;\n\npub fn bfs(adj: &[Vec<u32>], start: u32) -> (Vec<Option<u32>>, Vec<Option<u32>>) {\n    // mark visited when enqueuing\n    todo!()\n}\n\npub fn find_cycle(adj: &[Vec<u32>]) -> Option<u32> {\n    // explicit stack of (node, next child index), colours white/gray/black\n    todo!()\n}",
        "hint": "In BFS, set dist[v] and parent[v] before push_back. In find_cycle, keep (node, child_index) frames; a gray neighbour is a back edge, and a finished node becomes black.",
        "solution": `use std::collections::VecDeque;

pub fn bfs(adj: &[Vec<u32>], start: u32) -> (Vec<Option<u32>>, Vec<Option<u32>>) {
    let mut dist: Vec<Option<u32>> = vec![None; adj.len()];
    let mut parent: Vec<Option<u32>> = vec![None; adj.len()];
    let mut queue = VecDeque::new();

    dist[start as usize] = Some(0);
    queue.push_back(start);

    while let Some(u) = queue.pop_front() {
        let d = dist[u as usize].unwrap() + 1;
        for &v in &adj[u as usize] {
            if dist[v as usize].is_none() {
                dist[v as usize] = Some(d);
                parent[v as usize] = Some(u);
                queue.push_back(v);
            }
        }
    }
    (dist, parent)
}

pub fn path_to(parent: &[Option<u32>], start: u32, goal: u32) -> Option<Vec<u32>> {
    let mut path = Vec::new();
    let mut current = goal;
    while current != start {
        path.push(current);
        current = parent[current as usize]?;
    }
    path.push(start);
    path.reverse();
    Some(path)
}

#[derive(Clone, Copy, PartialEq)]
enum Color {
    White,
    Gray,
    Black,
}

pub fn find_cycle(adj: &[Vec<u32>]) -> Option<u32> {
    let mut color = vec![Color::White; adj.len()];
    for start in 0..adj.len() {
        if color[start] != Color::White {
            continue;
        }
        let mut stack: Vec<(u32, usize)> = vec![(start as u32, 0)];
        color[start] = Color::Gray;

        while let Some(&mut (u, ref mut next_child)) = stack.last_mut() {
            let neighbors = &adj[u as usize];
            if *next_child < neighbors.len() {
                let v = neighbors[*next_child];
                *next_child += 1;
                match color[v as usize] {
                    Color::Gray => return Some(v),
                    Color::White => {
                        color[v as usize] = Color::Gray;
                        stack.push((v, 0));
                    }
                    Color::Black => {}
                }
            } else {
                color[u as usize] = Color::Black;
                stack.pop();
            }
        }
    }
    None
}

fn main() {
    let adj = vec![vec![1, 2], vec![3], vec![3], vec![]];
    let (dist, parent) = bfs(&adj, 0);
    assert_eq!(dist, vec![Some(0), Some(1), Some(1), Some(2)]);
    assert_eq!(path_to(&parent, 0, 3), Some(vec![0, 1, 3]));
    assert_eq!(find_cycle(&adj), None);

    let cyclic = vec![vec![1], vec![2], vec![0]];
    assert_eq!(find_cycle(&cyclic), Some(0));
    println!("ok");
}`
      },
      "questions": [
        {
          "q": "Why must BFS mark a node as visited when it is enqueued?",
          "options": [
            "Because dequeue order is otherwise nondeterministic",
            "Because the same node can be enqueued once per incoming edge, growing the queue and duplicating work",
            "Because VecDeque requires unique elements",
            "Because distances would be negative otherwise"
          ],
          "answer": 1,
          "explain": "With marking on dequeue, several neighbours can each enqueue the same node before any of them processes it. Marking at enqueue keeps the queue and the distance array consistent."
        },
        {
          "q": "In directed cycle detection, which colour on a neighbour proves a cycle?",
          "options": [
            "White",
            "Gray",
            "Black",
            "Any non-white colour"
          ],
          "answer": 1,
          "explain": "Gray means the node is on the current DFS stack, so an edge back to it closes a loop. Black nodes are finished and white ones are untouched."
        },
        {
          "q": "What does toposort return for a graph with a cycle?",
          "options": [
            "An arbitrary order and a warning",
            "Err(Cycle) carrying the nodes involved",
            "An empty vector",
            "Panics"
          ],
          "answer": 1,
          "explain": "petgraph's toposort returns Result<Vec<NodeId>, Cycle>. Treating the cycle as an error value lets callers report which dependency loop exists."
        }
      ],
      "quickbytes": [
        "Mark visited at enqueue time in BFS; marking at dequeue duplicates work.",
        "CSR is two allocations: build degree counts, prefix-sum them, then scatter edges.",
        "Gray means on the current DFS stack; that is the only colour that proves a cycle.",
        "petgraph's Bfs/Dfs iterators own the visited map when you do not need distances."
      ],
      "production": [
        "Edge endpoints are validated against the node range at load time, with the offending id in the error.",
        "Traversals over untrusted graphs use an explicit stack and a documented memory bound.",
        "Cycle detection is an error path that reports the involved nodes, not a panic.",
        "Undirected edges are inserted in both directions exactly once, verified by a degree assertion."
      ],
      "crates": [
        "std",
        "petgraph"
      ],
      "github": [
        {
          "name": "petgraph/petgraph",
          "url": "https://github.com/petgraph/petgraph"
        }
      ],
      "pitfall": "Building an undirected graph by inserting each edge once: half the edges are missing, and BFS reports disconnected components that are actually reachable.",
      "resources": [
        {
          "title": "petgraph::visit — Bfs, Dfs, and visitor traits",
          "url": "https://docs.rs/petgraph/latest/petgraph/visit/index.html",
          "kind": "docs"
        },
        {
          "title": "petgraph algorithm module index",
          "url": "https://docs.rs/petgraph/latest/petgraph/algo/index.html",
          "kind": "docs"
        },
        {
          "title": "petgraph/petgraph repository",
          "url": "https://github.com/petgraph/petgraph",
          "kind": "repo"
        },
        {
          "title": "Graph Theory Tutorial: BFS, DFS and shortest paths",
          "url": "https://www.youtube.com/watch?v=09_LlHjoEiY",
          "kind": "video"
        }
      ]
    },
    {
      "id": "a11",
      "title": "Shortest paths: Dijkstra, Bellman-Ford, and A*",
      "minutes": 100,
      "level": "industry",
      "goal": "Implement Dijkstra with a binary heap, know exactly when it fails, and use A* with a heuristic you can prove admissible.",
      "sections": [
        {
          "h": "Dijkstra and the settled-set invariant",
          "p": [
            "Dijkstra maintains a set of settled nodes whose shortest distance is final, and repeatedly settles the unsettled node with the smallest tentative distance. That step is only valid when edge weights are non-negative: adding a negative edge could make a path to an already-settled node shorter, which breaks the invariant. With a binary heap the cost is O((V + E) log V), and with a Fibonacci heap it is O(E + V log V), which is why the paper benchmark exists.",
            "Stop when the goal is popped, not when it is pushed: the first pop of a node is the moment its distance is final. Reconstruct the path with a parent array updated on every successful relaxation. The heap holds at most one live entry per node but may hold stale duplicates, so the settle check compares the popped distance with the stored one before expanding."
          ],
          "code": `use petgraph::algo::dijkstra;
use petgraph::graph::{DiGraph, NodeIndex};
use std::collections::HashMap;

/// All distances from a source with petgraph; non-negative weights required.
/// petgraph returns a hashbrown map, so collect into std's HashMap here.
pub fn distances(g: &DiGraph<&'static str, u32>, start: NodeIndex) -> HashMap<NodeIndex, u32> {
    dijkstra(g, start, None, |edge| *edge.weight())
        .into_iter()
        .collect()
}

/// Early exit: once the goal is settled, do not explore the rest of the graph.
pub fn distance_to(
    g: &DiGraph<&'static str, u32>,
    start: NodeIndex,
    goal: NodeIndex,
) -> Option<u32> {
    dijkstra(g, start, Some(goal), |edge| *edge.weight()).get(&goal).copied()
}

fn main() {
    let mut g: DiGraph<&str, u32> = DiGraph::new();
    let a = g.add_node("a");
    let b = g.add_node("b");
    let c = g.add_node("c");
    g.add_edge(a, b, 10);
    g.add_edge(a, c, 1);
    g.add_edge(c, b, 1);
    assert_eq!(distance_to(&g, a, b), Some(2));
}`,
          "tip": "The goal-bound variant returns a map that may not contain the goal when it is unreachable; check the lookup rather than unwrapping it."
        },
        {
          "h": "Negative weights and Bellman-Ford",
          "p": [
            "Bellman-Ford relaxes every edge V-1 times, which is O(VE) but tolerates negative weights and detects negative cycles on the V-th pass. A negative cycle makes the shortest path undefined: you can go around it and decrease the cost forever, so the correct answer is an error, not a very small number. Any protocol that reports costs from untrusted peers needs this check.",
            "SPFA is a queue-based optimisation of Bellman-Ford that is fast on typical graphs and worst-case O(VE); it is popular in competitive programming and risky in production because crafted input reproduces the worst case. petgraph provides bellman_ford and find_negative_cycle, so use those rather than hand-rolling unless you need a specific relaxation order."
          ],
          "list": [
            "Negative edge, no negative cycle: Bellman-Ford is correct, Dijkstra is not",
            "Negative cycle: report an error and name one node on the cycle",
            "All weights equal: BFS is O(V + E) and beats every priority-queue variant",
            "Weights in a tiny integer range: consider a bucket queue"
          ]
        },
        {
          "h": "A*: a heuristic that must not overestimate",
          "p": [
            "A* orders the frontier by f(n) = g(n) + h(n), where g is the cost so far and h estimates the remaining cost. If h never overestimates the true remaining distance - it is admissible - A* is guaranteed to return an optimal path. If h is also consistent, meaning h(u) <= cost(u,v) + h(v), then no node is expanded twice and the search is efficient as well as correct.",
            "On a grid, Manhattan distance is admissible when movement is four-directional and each step costs at least one; octile distance applies to eight-directional movement; Euclidean distance works for continuous space. Scaling h by a factor above one gives weighted A*, which is faster and returns paths within that factor of optimal - useful for games, wrong for a routing engine that promises the shortest route."
          ],
          "code": `use petgraph::algo::astar;
use petgraph::graph::{DiGraph, NodeIndex};

/// A* over a unit-cost grid graph. Manhattan distance is admissible for 4-way moves.
pub fn astar_grid(
    g: &DiGraph<(u32, u32), u32>,
    start: NodeIndex,
    goal: NodeIndex,
) -> Option<(u32, Vec<NodeIndex>)> {
    let (gx, gy) = g[goal];
    let heuristic = |n: NodeIndex| {
        let (x, y) = g[n];
        x.abs_diff(gx) + y.abs_diff(gy)
    };

    astar(g, start, |n| n == goal, |edge| *edge.weight(), heuristic)
}

fn main() {
    let mut g: DiGraph<(u32, u32), u32> = DiGraph::new();
    let a = g.add_node((0, 0));
    let b = g.add_node((1, 0));
    let c = g.add_node((1, 1));
    g.add_edge(a, b, 1);
    g.add_edge(b, c, 1);
    g.add_edge(a, c, 5);

    let (cost, path) = astar_grid(&g, a, c).expect("connected");
    assert_eq!(cost, 2);
    assert_eq!(path, vec![a, b, c]);
}`,
          "tip": "If the heuristic can overestimate by one, the returned path can be one unit worse and no test with a single example will catch it. Property-test the triangle inequality instead."
        },
        {
          "h": "What production routing adds",
          "p": [
            "A continent-sized road network has tens of millions of nodes, and plain Dijkstra answers a query in seconds. Contraction hierarchies preprocess the graph by contracting nodes in order of importance, producing shortcuts that let a bidirectional query skip most of the network; query times drop by orders of magnitude at the cost of preprocessing and extra storage. Customizable contraction hierarchies separate the slow metric-dependent customisation from the fast query.",
            "The engineering lesson is that the algorithm is one component of a system: preprocessing, memory layout, and query batching matter as much as the asymptotic bound. Before reaching for a research-grade index, measure plain Dijkstra on your real graph - if the graph is small or the query rate is low, the simplest correct implementation is also the cheapest to operate."
          ],
          "list": [
            "Bidirectional Dijkstra explores roughly half the search space on symmetric graphs",
            "A* with a landmark-based heuristic (ALT) is a strong general-purpose upgrade",
            "Contraction hierarchies win on static road networks, not on dynamic graphs",
            "Preprocessing time and memory are part of the complexity budget"
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement Dijkstra from scratch over an adjacency list and return distances plus parents. Then add an A* variant that takes a heuristic closure, and test that A* returns the same cost as Dijkstra on a small grid with unit weights.",
        "starter": "use std::cmp::Reverse;\nuse std::collections::BinaryHeap;\n\npub fn dijkstra(adj: &[Vec<(usize, u64)>], start: usize) -> (Vec<Option<u64>>, Vec<Option<usize>>) {\n    todo!()\n}\n\npub fn astar(\n    adj: &[Vec<(usize, u64)>],\n    start: usize,\n    goal: usize,\n    heuristic: impl Fn(usize) -> u64,\n) -> Option<(u64, Vec<usize>)> {\n    todo!()\n}",
        "hint": "A* is Dijkstra with the heap key changed to g + h; keep g in a separate array, skip stale pops by comparing g, and stop when the goal is popped. With h = 0 it must produce identical costs.",
        "solution": `use std::cmp::Reverse;
use std::collections::BinaryHeap;

pub fn dijkstra(
    adj: &[Vec<(usize, u64)>],
    start: usize,
) -> (Vec<Option<u64>>, Vec<Option<usize>>) {
    let mut dist: Vec<Option<u64>> = vec![None; adj.len()];
    let mut parent: Vec<Option<usize>> = vec![None; adj.len()];
    let mut heap: BinaryHeap<Reverse<(u64, usize)>> = BinaryHeap::new();

    dist[start] = Some(0);
    heap.push(Reverse((0, start)));

    while let Some(Reverse((d, u))) = heap.pop() {
        if dist[u].is_some_and(|best| d > best) {
            continue;
        }
        for &(v, w) in &adj[u] {
            let candidate = d + w;
            if dist[v].is_none_or(|best| candidate < best) {
                dist[v] = Some(candidate);
                parent[v] = Some(u);
                heap.push(Reverse((candidate, v)));
            }
        }
    }
    (dist, parent)
}

pub fn astar(
    adj: &[Vec<(usize, u64)>],
    start: usize,
    goal: usize,
    heuristic: impl Fn(usize) -> u64,
) -> Option<(u64, Vec<usize>)> {
    let mut best: Vec<Option<u64>> = vec![None; adj.len()];
    let mut parent: Vec<Option<usize>> = vec![None; adj.len()];
    let mut heap: BinaryHeap<Reverse<(u64, u64, usize)>> = BinaryHeap::new(); // (f, g, node)

    best[start] = Some(0);
    heap.push(Reverse((heuristic(start), 0, start)));

    while let Some(Reverse((_, g, u))) = heap.pop() {
        if u == goal {
            let mut path = vec![goal];
            let mut current = goal;
            while current != start {
                current = parent[current]?;
                path.push(current);
            }
            path.reverse();
            return Some((g, path));
        }
        if best[u].is_some_and(|known| g > known) {
            continue;
        }
        for &(v, w) in &adj[u] {
            let candidate = g + w;
            if best[v].is_none_or(|known| candidate < known) {
                best[v] = Some(candidate);
                parent[v] = Some(u);
                heap.push(Reverse((candidate + heuristic(v), candidate, v)));
            }
        }
    }
    None
}

fn main() {
    let adj = vec![
        vec![(1, 1), (2, 5)],
        vec![(2, 1)],
        vec![],
    ];
    let (dist, _) = dijkstra(&adj, 0);
    assert_eq!(dist[2], Some(2));

    let zero = |_: usize| 0u64;
    let (cost, path) = astar(&adj, 0, 2, zero).unwrap();
    assert_eq!(cost, 2);
    assert_eq!(path, vec![0, 1, 2]);

    let perfect = |n: usize| if n == 2 { 0 } else { 1 };
    assert_eq!(astar(&adj, 0, 2, perfect).unwrap().0, 2);
    println!("ok");
}`
      },
      "questions": [
        {
          "q": "Why does Dijkstra require non-negative edge weights?",
          "options": [
            "Because the heap cannot order negative numbers",
            "Because settling a node is only valid if no later path through an unsettled node can be cheaper",
            "Because parent pointers would form a cycle",
            "Because distances would not fit in u64"
          ],
          "answer": 1,
          "explain": "The settled set assumes distances only increase as the search expands. A negative edge can make an already-settled node cheaper, invalidating the result."
        },
        {
          "q": "What does an admissible A* heuristic guarantee?",
          "options": [
            "It expands the fewest possible nodes",
            "It never overestimates the true remaining cost, so the returned path is optimal",
            "It runs in O(V + E) time",
            "It works with negative weights"
          ],
          "answer": 1,
          "explain": "Admissibility (h <= true cost) preserves optimality. Consistency, a stronger condition, additionally guarantees no node is expanded twice."
        },
        {
          "q": "A negative cycle exists in the graph. What is the correct result for a shortest path query?",
          "options": [
            "The path with the most negative total",
            "An error, because the shortest path is undefined",
            "The path with the fewest edges",
            "Zero"
          ],
          "answer": 1,
          "explain": "Circling the negative cycle decreases cost without bound, so no finite shortest path exists. Bellman-Ford detects this on the V-th relaxation pass."
        }
      ],
      "quickbytes": [
        "Settle a node when it is popped, not when it is pushed.",
        "Stop Dijkstra at the goal pop; the first pop is the final distance.",
        "A* with h = 0 is Dijkstra, which is the cheapest correctness test for your A*.",
        "Property-test heuristic consistency: h(u) <= w(u, v) + h(v) for every edge."
      ],
      "production": [
        "Weight types reject or explicitly handle negatives before running Dijkstra.",
        "Heuristics are admissible by construction and property-tested against edge costs.",
        "Query time and preprocessing time are both measured and reported for routing indexes.",
        "Unreachable goals return a typed error, not a sentinel distance."
      ],
      "crates": [
        "petgraph",
        "priority-queue",
        "std"
      ],
      "github": [
        {
          "name": "petgraph/petgraph",
          "url": "https://github.com/petgraph/petgraph"
        },
        {
          "name": "garro95/priority-queue",
          "url": "https://github.com/garro95/priority-queue"
        }
      ],
      "pitfall": "Passing a heuristic that overestimates by a small amount: A* still returns a path, it is just not the shortest one, and no assertion fires because the path is valid-looking.",
      "resources": [
        {
          "title": "petgraph::algo::astar — signature and complexity notes",
          "url": "https://docs.rs/petgraph/latest/petgraph/algo/astar/fn.astar.html",
          "kind": "docs"
        },
        {
          "title": "petgraph algorithm module index",
          "url": "https://docs.rs/petgraph/latest/petgraph/algo/index.html",
          "kind": "docs"
        },
        {
          "title": "petgraph/petgraph repository",
          "url": "https://github.com/petgraph/petgraph",
          "kind": "repo"
        },
        {
          "title": "Customizable Contraction Hierarchies",
          "url": "https://arxiv.org/abs/1402.0402",
          "kind": "paper"
        },
        {
          "title": "Dijkstra's Algorithm — Computerphile",
          "url": "https://www.youtube.com/watch?v=GazC3A4OQTE",
          "kind": "video"
        }
      ]
    },
    {
      "id": "a12",
      "title": "Union-find: path compression and union by size",
      "minutes": 80,
      "level": "advanced",
      "goal": "Implement disjoint sets in two arrays, explain why the amortised cost is effectively constant, and use them for Kruskal and dynamic connectivity.",
      "sections": [
        {
          "h": "Two arrays, two rules",
          "p": [
            "A disjoint-set forest stores a parent index per element. find walks to the root; union links one root under another. Two rules make it fast: union by size always attaches the smaller tree under the larger, which keeps depth logarithmic, and path compression points every node on the find path directly at the root, which flattens the tree for later calls. Together they give an amortised cost of O(alpha(n)), the inverse Ackermann function.",
            "alpha(n) is at most 4 for any n that fits in the physical universe, so the practical answer is constant time per operation. The proof is subtle - it took years to simplify, which is why the recent analyses are worth reading - but the implementation is twenty lines. The important part is that neither rule alone is enough: union by size without compression gives O(log n), compression without union by size gives O(log n) amortised."
          ],
          "code": `pub struct DisjointSet {
    parent: Vec<u32>,
    size: Vec<u32>,
    components: usize,
}

impl DisjointSet {
    pub fn new(n: usize) -> Self {
        Self {
            parent: (0..n as u32).collect(),
            size: vec![1; n],
            components: n,
        }
    }

    /// Iterative find with full path compression: no recursion, no stack risk.
    pub fn find(&mut self, mut x: u32) -> u32 {
        let mut root = x;
        while self.parent[root as usize] != root {
            root = self.parent[root as usize];
        }
        while self.parent[x as usize] != root {
            let next = self.parent[x as usize];
            self.parent[x as usize] = root;
            x = next;
        }
        root
    }

    /// Returns false when the two elements were already connected.
    pub fn union(&mut self, a: u32, b: u32) -> bool {
        let (mut ra, mut rb) = (self.find(a), self.find(b));
        if ra == rb {
            return false;
        }
        if self.size[ra as usize] < self.size[rb as usize] {
            std::mem::swap(&mut ra, &mut rb);
        }
        self.parent[rb as usize] = ra;
        self.size[ra as usize] += self.size[rb as usize];
        self.components -= 1;
        true
    }

    pub fn connected(&mut self, a: u32, b: u32) -> bool {
        self.find(a) == self.find(b)
    }

    pub fn components(&self) -> usize {
        self.components
    }
}`,
          "tip": "Both loops in find are necessary: the first finds the root, the second flattens the path. Fusing them is where subtle bugs live."
        },
        {
          "h": "Kruskal: sorting edges and rejecting cycles",
          "p": [
            "Kruskal's minimum spanning tree sorts edges by weight and adds each one whose endpoints are in different components. Union-find answers that question in amortised constant time, so the whole algorithm is dominated by the sort: O(E log E). The rejected edges are exactly the ones that would close a cycle, which is why the algorithm never needs an explicit cycle check.",
            "The same machinery answers dynamic connectivity questions: as edges arrive, are two nodes connected yet? Adding edges only merges components, which union-find handles; deletions do not work, because splitting a component needs a different data structure. That asymmetry is worth remembering before designing a feature around it."
          ],
          "code": `/// Kruskal MST. edges are (u, v, weight); returns total weight and chosen edges.
pub fn kruskal(n: usize, mut edges: Vec<(u32, u32, u64)>) -> (u64, Vec<(u32, u32, u64)>) {
    edges.sort_unstable_by_key(|&(_, _, w)| w);
    let mut dsu = DisjointSet::new(n);
    let mut total = 0u64;
    let mut chosen = Vec::new();

    for edge @ (u, v, w) in edges {
        if dsu.union(u, v) {
            total += w;
            chosen.push(edge);
            if chosen.len() + 1 == n {
                break; // spanning tree complete
            }
        }
    }

    assert_eq!(chosen.len() + 1, n, "graph is disconnected");
    (total, chosen)
}`,
          "tip": "Store the edge tuple before destructuring if you need it afterwards; the loop pattern above rebinds it with @ so the weight is not lost."
        },
        {
          "h": "The failure modes: recursion and stale roots",
          "p": [
            "A recursive find is elegant and dangerous. Before compression runs, a union-by-size forest has depth O(log n), which is safe; but if someone writes union without the size rule, the tree becomes a chain and find recurses once per element, overflowing the stack at a few hundred thousand nodes. The iterative version costs two extra lines and removes the failure mode entirely.",
            "The second trap is caching a root across unions. A root id returned by find is valid only until the next union touches that component; after that it may be a child. Code that stores roots in a HashMap and compares them later is comparing history, not connectivity. Call find again at the point of use, or store the element and resolve it then."
          ],
          "list": [
            "Use u32 for ids below four billion to halve the memory of both arrays",
            "Assert that ids are in range at the public boundary, not inside find",
            "Path compression mutates on read, so find takes &mut self",
            "Union returning bool doubles as the cycle check in Kruskal"
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement DisjointSet with iterative find, path compression, and union by size. Then implement `count_provinces(adj: &[Vec<u32>]) -> usize`, returning the number of connected components of an undirected graph, and verify it on a graph with two separate clusters.",
        "starter": "pub struct DisjointSet {\n    parent: Vec<u32>,\n    size: Vec<u32>,\n}\n\nimpl DisjointSet {\n    pub fn new(n: usize) -> Self { todo!() }\n    pub fn find(&mut self, x: u32) -> u32 { todo!() }\n    pub fn union(&mut self, a: u32, b: u32) -> bool { todo!() }\n}\n\npub fn count_provinces(adj: &[Vec<u32>]) -> usize {\n    todo!()\n}",
        "hint": "Start with components = n and decrement on every successful union. For count_provinces, union each undirected edge once (i < j) and return dsu.components().",
        "solution": `pub struct DisjointSet {
    parent: Vec<u32>,
    size: Vec<u32>,
    components: usize,
}

impl DisjointSet {
    pub fn new(n: usize) -> Self {
        Self {
            parent: (0..n as u32).collect(),
            size: vec![1; n],
            components: n,
        }
    }

    pub fn find(&mut self, mut x: u32) -> u32 {
        let mut root = x;
        while self.parent[root as usize] != root {
            root = self.parent[root as usize];
        }
        while self.parent[x as usize] != root {
            let next = self.parent[x as usize];
            self.parent[x as usize] = root;
            x = next;
        }
        root
    }

    pub fn union(&mut self, a: u32, b: u32) -> bool {
        let (mut ra, mut rb) = (self.find(a), self.find(b));
        if ra == rb {
            return false;
        }
        if self.size[ra as usize] < self.size[rb as usize] {
            std::mem::swap(&mut ra, &mut rb);
        }
        self.parent[rb as usize] = ra;
        self.size[ra as usize] += self.size[rb as usize];
        self.components -= 1;
        true
    }

    pub fn components(&self) -> usize {
        self.components
    }
}

pub fn count_provinces(adj: &[Vec<u32>]) -> usize {
    let mut dsu = DisjointSet::new(adj.len());
    for (u, neighbors) in adj.iter().enumerate() {
        for &v in neighbors {
            if (u as u32) < v {
                dsu.union(u as u32, v);
            }
        }
    }
    dsu.components()
}

fn main() {
    // 0-1-2 form one cluster, 3-4 another, 5 is isolated.
    let adj = vec![
        vec![1],
        vec![0, 2],
        vec![1],
        vec![4],
        vec![3],
        vec![],
    ];
    assert_eq!(count_provinces(&adj), 3);

    let mut dsu = DisjointSet::new(5);
    assert!(dsu.union(0, 1));
    assert!(dsu.union(1, 2));
    assert!(!dsu.union(0, 2), "already connected");
    assert_eq!(dsu.components(), 3);
    println!("ok");
}`
      },
      "questions": [
        {
          "q": "What does union by size alone (without path compression) guarantee about tree height?",
          "options": [
            "Constant height",
            "O(log n), because each element's depth increases only when its tree at least doubles",
            "O(n) in the worst case",
            "O(alpha(n))"
          ],
          "answer": 1,
          "explain": "Attaching the smaller tree under the larger means an element's depth rises only when its component doubles in size, which can happen at most log n times."
        },
        {
          "q": "In Kruskal's algorithm, what does a failed union tell you?",
          "options": [
            "The edge is the heaviest in the graph",
            "The edge's endpoints are already connected, so adding it would create a cycle",
            "The graph is disconnected",
            "The edge must be added twice for undirected graphs"
          ],
          "answer": 1,
          "explain": "union returns false exactly when both endpoints share a root. That is the cycle test, which is why Kruskal never needs a separate DFS."
        },
        {
          "q": "Why is a cached root id unsafe to store across later unions?",
          "options": [
            "Roots are recycled by the allocator",
            "A later union can attach that root under another, so it is no longer the representative",
            "Root ids are random per run",
            "The parent array is reallocated on every union"
          ],
          "answer": 1,
          "explain": "Union may make the cached node a child of a new root. Connectivity must be resolved with a fresh find at the time of the query."
        }
      ],
      "quickbytes": [
        "Union by size plus path compression gives amortised O(alpha(n)), effectively constant.",
        "Write find iteratively: a degenerate chain plus recursion is a stack overflow.",
        "find mutates the parent array, so it takes &mut self even though it only reads connectivity.",
        "Union-find supports merges, not splits; deletions need a different structure."
      ],
      "production": [
        "Union-find is used for connectivity and MST, with union by size always enabled.",
        "find is iterative and covered by a test that builds a 1e6-element chain.",
        "Ids are validated at the API boundary, and out-of-range input returns an error, not a panic.",
        "Algorithms that need deletions use a different structure; the limitation is documented."
      ],
      "crates": [
        "petgraph",
        "std"
      ],
      "github": [
        {
          "name": "petgraph/petgraph",
          "url": "https://github.com/petgraph/petgraph"
        }
      ],
      "pitfall": "Recursive find without union by size: after a few hundred thousand adversarial unions the parent chain is linear, and the first find overflows the stack in a service that was fine in tests.",
      "resources": [
        {
          "title": "petgraph::unionfind — UnionFind with rank and path compression",
          "url": "https://docs.rs/petgraph/latest/petgraph/unionfind/index.html",
          "kind": "docs"
        },
        {
          "title": "petgraph/petgraph repository",
          "url": "https://github.com/petgraph/petgraph",
          "kind": "repo"
        },
        {
          "title": "Simpler Analyses of Union-Find",
          "url": "https://arxiv.org/abs/2308.09021",
          "kind": "paper"
        },
        {
          "title": "petgraph algorithm module index",
          "url": "https://docs.rs/petgraph/latest/petgraph/algo/index.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "a13",
      "title": "Dynamic programming: state, order, and rolling arrays",
      "minutes": 110,
      "level": "industry",
      "goal": "Turn a recurrence into a correct table, choose the iteration order that makes it valid, and cut memory without changing the answer.",
      "sections": [
        {
          "h": "Define the state before writing any loop",
          "p": [
            "A DP solution is a state definition plus a recurrence plus an order. The state must capture everything the future needs and nothing more: for weighted interval scheduling, the state is the best weight achievable using the first j jobs in finish-time order. If a proposed state needs to know which jobs were chosen, it is not a state, it is the whole search tree, and the table will not close.",
            "Optimal substructure means an optimal solution contains optimal solutions to subproblems; overlapping subproblems means the same state recurs. Both must hold for DP to beat plain recursion. When only the first holds, you have a greedy or divide-and-conquer problem; when only the second holds, memoisation still helps but the state may be exponential, which is when you need a different formulation."
          ]
        },
        {
          "h": "Weighted interval scheduling",
          "p": [
            "Jobs have a start, a finish, and a weight; chosen jobs must not overlap, and the goal is maximum total weight. Sort by finish time, then define dp[j] as the best weight using the first j jobs. Either job j is excluded, giving dp[j-1], or it is included, giving weight[j] plus the best solution among jobs that finish before job j starts - a prefix that binary search finds in O(log n).",
            "The recurrence is dp[j] = max(dp[j-1], w[j] + dp[p(j)]), computed bottom-up in one pass. The binary search inside the loop makes it O(n log n); precomputing p(j) with a merge-style sweep makes it O(n) after the sort. This is the exact shape the capstone's scheduler needs, and the same recurrence underlies job sequencing with deadlines and RNA secondary structure."
          ],
          "code": `pub struct Job {
    pub start: u64,
    pub finish: u64,
    pub weight: u64,
}

/// Maximum total weight of non-overlapping jobs. O(n log n) after sorting.
pub fn max_weight(mut jobs: Vec<Job>) -> u64 {
    jobs.sort_unstable_by_key(|job| job.finish);

    // finishes[i] is the finish time of job i; prefix lookups become binary searches.
    let finishes: Vec<u64> = jobs.iter().map(|job| job.finish).collect();
    let mut dp = vec![0u64; jobs.len() + 1];

    for (i, job) in jobs.iter().enumerate() {
        // Number of jobs that finish at or before this job starts.
        let compatible = finishes.partition_point(|&finish| finish <= job.start);
        let take = job.weight + dp[compatible];
        dp[i + 1] = dp[i].max(take);
    }
    dp[jobs.len()]
}

fn main() {
    let jobs = vec![
        Job { start: 0, finish: 3, weight: 3 },
        Job { start: 1, finish: 4, weight: 5 },
        Job { start: 3, finish: 5, weight: 2 },
        Job { start: 5, finish: 7, weight: 4 },
    ];
    assert_eq!(max_weight(jobs), 9); // jobs 2 and 4, or 1 and 4
}`,
          "tip": "Sort by finish, not by start: the recurrence needs the prefix of jobs that are already finished, and that prefix only exists in finish order."
        },
        {
          "h": "Order is the correctness proof",
          "p": [
            "A bottom-up table is correct only if every dependency is computed before it is read. Iterating j from 1 to n reads dp[j-1] and dp[p(j)], both smaller indices, so the order works. In 0/1 knapsack, iterating capacity from high to low is what prevents an item from being used twice; the same loop written low to high computes the unbounded version, which is a different problem with a different answer.",
            "When the order is wrong the code still compiles and still returns a number, which is the dangerous part. The defence is to derive the dependency graph of the state and check the loop order against it, then test against a brute-force solution for small inputs. Property tests with random small instances catch order bugs far more reliably than hand-written examples."
          ],
          "code": `/// 0/1 knapsack: capacity loop runs downwards so each item is used at most once.
pub fn knapsack(weights: &[u32], values: &[u32], capacity: usize) -> u32 {
    let mut best = vec![0u32; capacity + 1];
    for (&w, &v) in weights.iter().zip(values) {
        let w = w as usize;
        for c in (w..=capacity).rev() {
            best[c] = best[c].max(best[c - w] + v);
        }
    }
    best[capacity]
}

/// Edit distance with two rows: O(n*m) time, O(m) memory.
pub fn edit_distance(a: &[u8], b: &[u8]) -> usize {
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    let mut current = vec![0usize; b.len() + 1];

    for (i, &ca) in a.iter().enumerate() {
        current[0] = i + 1;
        for (j, &cb) in b.iter().enumerate() {
            let substitute = previous[j] + usize::from(ca != cb);
            let delete = previous[j + 1] + 1;
            let insert = current[j] + 1;
            current[j + 1] = substitute.min(delete).min(insert);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[b.len()]
}`,
          "tip": "Draw the table dependency before optimising memory. Rolling rows are safe only when the recurrence reads the previous row and the current row's earlier cells."
        },
        {
          "h": "Rust mechanics for memoisation",
          "p": [
            "Top-down memoisation in Rust wants a struct that owns the table and a method that takes &mut self, because the recursive calls must mutate the cache. That is fine, but it makes the function non-reentrant and awkward to call from parallel code. A plain Vec<Option<T>> is the cache; use Option rather than a sentinel value so that a legitimate zero is not mistaken for uncomputed.",
            "Recursion depth is the hidden cost: a DP over a 100,000-element sequence in top-down form needs 100,000 stack frames unless the recurrence is shallow. Bottom-up tables avoid the stack entirely but force every state to be computed, including unreachable ones. The usual production choice is bottom-up with a flat Vec and index arithmetic, because it is allocatable once, cache-friendly, and testable without recursion limits."
          ],
          "list": [
            "Flat Vec<u64> with idx = i * width + j beats Vec<Vec<u64>> on allocation and locality",
            "Use Option<T> for not-yet-computed states; 0 and u64::MAX are both real answers sometimes",
            "u32 saturating arithmetic can silently cap the answer; size the type to the bound",
            "Keep a brute-force implementation behind a cfg(test) flag as the oracle"
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement `max_weight(jobs)` for weighted interval scheduling with the binary-search recurrence, then implement `edit_distance(a, b)` with two rows. Add a brute-force subset solver in the test module and compare it with the DP on random small inputs.",
        "starter": "pub struct Job {\n    pub start: u64,\n    pub finish: u64,\n    pub weight: u64,\n}\n\npub fn max_weight(jobs: Vec<Job>) -> u64 {\n    // sort by finish, dp[j] = max(dp[j-1], weight + dp[p(j)])\n    todo!()\n}\n\npub fn edit_distance(a: &[u8], b: &[u8]) -> usize {\n    // two rows, swap after each row\n    todo!()\n}",
        "hint": "p(j) is the count of jobs whose finish is <= job j's start, found with partition_point. For edit distance, current[0] = i + 1 each row, then min(substitute, delete, insert).",
        "solution": `#[derive(Clone)]
pub struct Job {
    pub start: u64,
    pub finish: u64,
    pub weight: u64,
}

pub fn max_weight(mut jobs: Vec<Job>) -> u64 {
    jobs.sort_unstable_by_key(|job| job.finish);
    let finishes: Vec<u64> = jobs.iter().map(|job| job.finish).collect();
    let mut dp = vec![0u64; jobs.len() + 1];

    for (i, job) in jobs.iter().enumerate() {
        let compatible = finishes.partition_point(|&finish| finish <= job.start);
        dp[i + 1] = dp[i].max(job.weight + dp[compatible]);
    }
    dp[jobs.len()]
}

pub fn edit_distance(a: &[u8], b: &[u8]) -> usize {
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    let mut current = vec![0usize; b.len() + 1];

    for (i, &ca) in a.iter().enumerate() {
        current[0] = i + 1;
        for (j, &cb) in b.iter().enumerate() {
            let substitute = previous[j] + usize::from(ca != cb);
            let delete = previous[j + 1] + 1;
            let insert = current[j] + 1;
            current[j + 1] = substitute.min(delete).min(insert);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[b.len()]
}

fn brute_force(jobs: &[Job]) -> u64 {
    let n = jobs.len();
    let mut best = 0u64;
    for mask in 0u32..(1u32 << n) {
        let mut chosen: Vec<&Job> = (0..n).filter(|i| mask & (1 << i) != 0).map(|i| &jobs[i]).collect();
        chosen.sort_unstable_by_key(|job| job.start);
        let overlaps = chosen.windows(2).any(|pair| pair[0].finish > pair[1].start);
        if !overlaps {
            best = best.max(chosen.iter().map(|job| job.weight).sum());
        }
    }
    best
}

fn main() {
    let jobs = vec![
        Job { start: 0, finish: 3, weight: 3 },
        Job { start: 1, finish: 4, weight: 5 },
        Job { start: 3, finish: 5, weight: 2 },
        Job { start: 5, finish: 7, weight: 4 },
    ];
    assert_eq!(max_weight(jobs.clone()), brute_force(&jobs));
    assert_eq!(max_weight(jobs), 9);

    assert_eq!(edit_distance(b"kitten", b"sitting"), 3);
    assert_eq!(edit_distance(b"", b"abc"), 3);
    println!("ok");
}`
      },
      "questions": [
        {
          "q": "In 0/1 knapsack, why does the capacity loop run from high to low?",
          "options": [
            "So the array stays sorted",
            "Because best[c - w] must still be from the previous item, not the current one",
            "Because usize subtraction would underflow otherwise",
            "Because it halves the number of iterations"
          ],
          "answer": 1,
          "explain": "Descending order means best[c - w] has not been updated for the current item yet, so each item is used at most once. Ascending order computes the unbounded variant."
        },
        {
          "q": "What does p(j) represent in weighted interval scheduling?",
          "options": [
            "The profit of job j",
            "The number of jobs that finish no later than job j starts",
            "The job that starts immediately after j",
            "The position of job j in the original input"
          ],
          "answer": 1,
          "explain": "p(j) is the largest index of a job compatible with j in finish-time order. Sorting by finish makes that set exactly a prefix, so it is one binary search."
        },
        {
          "q": "When is top-down memoisation a poor fit in Rust?",
          "options": [
            "When the state space is small",
            "When the recurrence is deep enough that recursion depth becomes a stack risk, or the function must be reentrant",
            "When the answer fits in u64",
            "When the table is a flat Vec"
          ],
          "answer": 1,
          "explain": "Top-down needs &mut self and one stack frame per state depth. Long sequences or parallel callers push you toward bottom-up with an owned table."
        }
      ],
      "quickbytes": [
        "Write the state definition and recurrence before writing a single loop.",
        "Sort by finish time for interval DP; p(j) is then a prefix length.",
        "0/1 knapsack iterates capacity downwards; upwards gives the unbounded problem.",
        "Keep a brute-force oracle and compare on small random inputs."
      ],
      "production": [
        "Every DP has a brute-force oracle tested on small random inputs.",
        "State types are sized to the proven bound, with overflow impossible or checked.",
        "Memory is O(state) after rolling-row optimisation, and the peak is documented.",
        "Recurrences over untrusted-length input are bottom-up, never deep recursion."
      ],
      "crates": [
        "std",
        "criterion"
      ],
      "github": [
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        }
      ],
      "pitfall": "Writing the knapsack capacity loop in ascending order: each item is reused unlimited times, the answer is too high, and on small tests it can still match by coincidence.",
      "resources": [
        {
          "title": "Dynamic Programming I: Fibonacci, Shortest Paths — MIT 6.006",
          "url": "https://www.youtube.com/watch?v=OQ5jsbhAv_M",
          "kind": "video"
        },
        {
          "title": "criterion: benchmarking table sizes and allocation strategies",
          "url": "https://docs.rs/criterion/latest/criterion/",
          "kind": "docs"
        },
        {
          "title": "rust-lang/rust repository",
          "url": "https://github.com/rust-lang/rust",
          "kind": "repo"
        },
        {
          "title": "proptest: random small-input oracles for DP tables",
          "url": "https://docs.rs/proptest/latest/proptest/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "a14",
      "title": "Greedy algorithms: exchange arguments and honest limits",
      "minutes": 85,
      "level": "advanced",
      "goal": "Prove a greedy choice with an exchange argument, implement Huffman coding, and name the cases where greedy is simply wrong.",
      "sections": [
        {
          "h": "A greedy algorithm is a theorem",
          "p": [
            "Greedy means committing to a locally best choice and never reconsidering. It is correct only when an exchange argument shows that any optimal solution can be transformed to include that choice without getting worse. For interval scheduling - maximise the number of non-overlapping jobs - the choice is the job that finishes earliest, because replacing the first job of any optimal schedule with it leaves at least as much room for the rest.",
            "The proof has two steps: the greedy choice is safe (there exists an optimal solution containing it), and the remaining problem is a smaller instance of the same problem. Without both, a greedy heuristic can be arbitrarily bad. The failure is silent: the code returns a schedule, it is just not optimal, and no test with a friendly example notices."
          ],
          "list": [
            "Interval scheduling: earliest finish time, O(n log n) after sorting",
            "Fractional knapsack: highest value density first",
            "Minimum lateness: earliest deadline first",
            "0/1 knapsack, set cover, travelling salesman: greedy has no constant-factor guarantee in general"
          ]
        },
        {
          "h": "Huffman: greedy that provably compresses",
          "p": [
            "Huffman coding builds a prefix-free code by repeatedly merging the two least frequent symbols. The exchange argument: in an optimal tree, the two least frequent symbols can always be placed as siblings at maximum depth, so merging them first loses nothing. A BinaryHeap of Reverse counts implements the merge loop in O(n log n) and computes the total encoded length as the sum of every merge.",
            "Prefix-free matters because decoding is a walk down the tree with no delimiters. The code length for a symbol is its depth, so minimising the weighted path length is exactly minimising the encoded size. Real compressors do more - context modelling, arithmetic coding, block structure - but the entropy-coded back end of many formats still descends from this 1952 algorithm."
          ],
          "code": `use std::cmp::Reverse;
use std::collections::BinaryHeap;

/// Total encoded bit length for the given symbol frequencies.
pub fn huffman_bits(frequencies: &[u64]) -> u64 {
    let mut heap: BinaryHeap<Reverse<u64>> = frequencies
        .iter()
        .copied()
        .filter(|&f| f > 0)
        .map(Reverse)
        .collect();

    let mut total = 0u64;
    while heap.len() > 1 {
        let Reverse(a) = heap.pop().expect("len > 1");
        let Reverse(b) = heap.pop().expect("len > 1");
        total += a + b; // every merge adds one bit to each symbol below it
        heap.push(Reverse(a + b));
    }
    total
}

fn main() {
    // Frequencies 5, 2, 1, 1: merge 1+1=2, then 2+2=4, then 4+5=9 -> 2+4+9 = 15 bits.
    assert_eq!(huffman_bits(&[5, 2, 1, 1]), 15);
    // Four equal weights: every symbol ends at depth 2, so 4 * 2 = 8 bits.
    assert_eq!(huffman_bits(&[1, 1, 1, 1]), 8);
    println!("{}", huffman_bits(&[9, 4, 2, 2, 1, 1]));
}`,
          "tip": "The total is the sum of merge costs, which equals the weighted external path length: no tree construction needed to check the bound."
        },
        {
          "h": "Where greedy breaks, and how to notice",
          "p": [
            "The classic counterexample is 0/1 knapsack: capacity 10, item A weight 6 value 6, item B weight 5 value 5, item C weight 5 value 5. Density-greedy takes A and stops with value 6, while B and C give 10. The same instance solves optimally in the fractional version, which is why the distinction between divisible and indivisible resources appears in every scheduling and packing problem.",
            "A useful test before trusting a greedy: construct two or three adversarial instances by hand and check the greedy answer against brute force. If it survives, look for a matroid structure or an exchange argument; if it does not, you need DP, an approximation guarantee, or an ILP solver. Shipping a greedy with a proven 2-approximation is a legitimate engineering decision, but only if the bound is written down."
          ],
          "code": `/// Earliest-finish-time interval scheduling: the provably optimal greedy.
pub fn max_non_overlapping(mut intervals: Vec<(u64, u64)>) -> Vec<(u64, u64)> {
    intervals.sort_unstable_by_key(|&(_, finish)| finish);
    let mut chosen: Vec<(u64, u64)> = Vec::new();
    let mut last_finish = 0u64;
    for (start, finish) in intervals {
        if start >= last_finish {
            chosen.push((start, finish));
            last_finish = finish;
        }
    }
    chosen
}

/// Greedy by value density, for the fractional relaxation only.
pub fn fractional_knapsack(mut items: Vec<(u64, u64)>, capacity: u64) -> f64 {
    assert!(items.iter().all(|&(weight, _)| weight > 0), "zero weight has infinite density");
    items.sort_unstable_by(|a, b| (b.1 as f64 / b.0 as f64).total_cmp(&(a.1 as f64 / a.0 as f64)));
    let mut value = 0.0;
    let mut remaining = capacity;
    for (weight, worth) in items {
        if weight <= remaining {
            value += worth as f64;
            remaining -= weight;
        } else {
            value += worth as f64 * (remaining as f64 / weight as f64);
            break;
        }
    }
    value
}`,
          "tip": "Sort with total_cmp on floats, and keep the density comparison as a ratio rather than a precomputed float field."
        },
        {
          "h": "Approximation bounds are the honest fallback",
          "p": [
            "When exact optimisation is NP-hard, a greedy with a proven ratio is often the right production answer. List scheduling - assign each job to the machine that becomes free first - is within 2 - 1/m of optimal, and the bound is tight. Greedy set cover is within ln n + 1 of optimal, and no polynomial algorithm does asymptotically better unless P = NP.",
            "State the bound next to the algorithm and test it: generate instances, compare against a brute-force optimum for small n, and assert that the ratio never exceeds the proven value. That test is what separates an engineering decision from a hopeful heuristic, and it is the same discipline the capstone requires for its scheduling deliverable."
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement earliest-finish interval scheduling returning the chosen intervals, then add a brute-force optimum for up to 12 intervals and assert the greedy result is never smaller. Then compute Huffman encoded length for a frequency table and verify it against a hand-computed small example.",
        "starter": "pub fn max_non_overlapping(intervals: Vec<(u64, u64)>) -> Vec<(u64, u64)> {\n    // sort by finish, take what fits\n    todo!()\n}\n\npub fn huffman_bits(frequencies: &[u64]) -> u64 {\n    // min-heap of Reverse counts; total += a + b on every merge\n    todo!()\n}",
        "hint": "Track the finish of the last chosen interval and accept a job when its start is >= that value. For Huffman, pop two, add their sum to the total, push the sum back; the total is the encoded bit length.",
        "solution": `use std::cmp::Reverse;
use std::collections::BinaryHeap;

pub fn max_non_overlapping(mut intervals: Vec<(u64, u64)>) -> Vec<(u64, u64)> {
    intervals.sort_unstable_by_key(|&(_, finish)| finish);
    let mut chosen = Vec::new();
    let mut last_finish = 0u64;
    for (start, finish) in intervals {
        if start >= last_finish {
            chosen.push((start, finish));
            last_finish = finish;
        }
    }
    chosen
}

pub fn huffman_bits(frequencies: &[u64]) -> u64 {
    let mut heap: BinaryHeap<Reverse<u64>> =
        frequencies.iter().copied().filter(|&f| f > 0).map(Reverse).collect();
    let mut total = 0u64;
    while heap.len() > 1 {
        let Reverse(a) = heap.pop().unwrap();
        let Reverse(b) = heap.pop().unwrap();
        total += a + b;
        heap.push(Reverse(a + b));
    }
    total
}

fn brute_force(intervals: &[(u64, u64)]) -> usize {
    let n = intervals.len();
    let mut best = 0usize;
    for mask in 0u32..(1u32 << n) {
        let mut chosen: Vec<(u64, u64)> =
            (0..n).filter(|i| mask & (1 << i) != 0).map(|i| intervals[i]).collect();
        chosen.sort_unstable_by_key(|&(_, finish)| finish);
        if chosen.windows(2).all(|pair| pair[0].1 <= pair[1].0) {
            best = best.max(chosen.len());
        }
    }
    best
}

fn main() {
    let intervals = vec![(1, 4), (3, 5), (0, 6), (5, 7), (3, 9), (5, 9), (6, 10), (8, 11)];
    let greedy = max_non_overlapping(intervals.clone());
    assert_eq!(greedy.len(), brute_force(&intervals));
    assert_eq!(greedy, vec![(1, 4), (5, 7), (8, 11)]);

    // Frequencies 5, 2, 1, 1: merge 1+1=2, then 2+2=4, then 4+5=9 -> 2+4+9 = 15 bits.
    assert_eq!(huffman_bits(&[5, 2, 1, 1]), 15);
    println!("ok");
}`
      },
      "questions": [
        {
          "q": "Why is earliest-finish-time optimal for maximising the number of non-overlapping intervals?",
          "options": [
            "Because it processes the shortest intervals first",
            "Because the earliest-finishing interval leaves the most room, and an exchange argument shows it can replace the first interval of any optimum",
            "Because sorting by finish makes the input a matroid",
            "Because it is the same as sorting by start time"
          ],
          "answer": 1,
          "explain": "The exchange step replaces the first chosen interval with the earliest-finishing compatible one, which never reduces the remaining room. That makes the greedy choice safe."
        },
        {
          "q": "Which problem defeats value-density greedy?",
          "options": [
            "Fractional knapsack",
            "0/1 knapsack, where items are indivisible",
            "Huffman coding",
            "Interval scheduling"
          ],
          "answer": 1,
          "explain": "A density-first pick can fill capacity with one dense item and block a combination of lighter items with greater total value. Divisibility is what makes the fractional version greedy-solvable."
        },
        {
          "q": "Greedy list scheduling on m machines has what guarantee?",
          "options": [
            "Exactly optimal",
            "Within 2 - 1/m of the optimal makespan",
            "Within ln n of optimal",
            "No guarantee"
          ],
          "answer": 1,
          "explain": "The classic bound is 2 - 1/m, and it is tight. Set cover's ln n + 1 bound belongs to a different problem."
        }
      ],
      "quickbytes": [
        "No exchange argument, no greedy: write the proof or write a test against brute force.",
        "Sort by finish for interval scheduling, by deadline for minimum lateness.",
        "Huffman bit length equals the sum of all merge costs, no tree walk required.",
        "State an approximation ratio next to any heuristic that ships."
      ],
      "production": [
        "Every greedy path is justified by a proof or a measured approximation bound.",
        "Adversarial instances from the literature are part of the test suite.",
        "Heuristics log their objective so regressions in solution quality are visible.",
        "Float comparisons in ordering use total_cmp, never partial_cmp().unwrap()."
      ],
      "crates": [
        "std",
        "priority-queue"
      ],
      "github": [
        {
          "name": "garro95/priority-queue",
          "url": "https://github.com/garro95/priority-queue"
        }
      ],
      "pitfall": "Shipping a density-greedy packer because it looked right on three examples: on indivisible items it can return half the optimal value, and nothing in the code signals that the answer is a heuristic.",
      "resources": [
        {
          "title": "BinaryHeap: the min-heap behind Huffman merging",
          "url": "https://doc.rust-lang.org/std/collections/struct.BinaryHeap.html",
          "kind": "docs"
        },
        {
          "title": "priority-queue: indexed priority queue for scheduling",
          "url": "https://docs.rs/priority-queue/latest/priority_queue/",
          "kind": "docs"
        },
        {
          "title": "garro95/priority-queue repository",
          "url": "https://github.com/garro95/priority-queue",
          "kind": "repo"
        },
        {
          "title": "MIT OpenCourseWare: algorithms lectures on greedy methods",
          "url": "https://www.youtube.com/@mitocw",
          "kind": "video"
        }
      ]
    },
    {
      "id": "a15",
      "title": "Backtracking: pruning, bitmasks, and exact cover",
      "minutes": 95,
      "level": "advanced",
      "goal": "Structure a search as choose-explore-unchoose, prune with bitmasks, and know when a backtracking search needs a smarter formulation instead of more speed.",
      "sections": [
        {
          "h": "The recursion tree is the algorithm",
          "p": [
            "Backtracking enumerates candidates while maintaining a partial solution. At each level you choose, recurse, then undo the choice, which is why the pattern is choose-explore-unchoose. Permutations swap an element into position, combinations advance a start index, and N-queens places one queen per row. The complexity is the size of the tree, so every improvement comes from making the tree smaller, not from making the loop faster.",
            "Undo must be exact. A Vec push paired with pop is safe; a bitmask OR paired with a mask argument passed by value is safe; mutating shared state and forgetting to restore it produces answers that depend on traversal order, which is the classic backtracking bug. Passing the partial state by value where it is cheap - a u32 of used columns - removes the whole class of mistakes."
          ],
          "code": `/// All permutations, generated by swapping into position and swapping back.
pub fn permutations(xs: &mut [u32]) -> Vec<Vec<u32>> {
    fn walk(xs: &mut [u32], k: usize, out: &mut Vec<Vec<u32>>) {
        if k == xs.len() {
            out.push(xs.to_vec());
            return;
        }
        for i in k..xs.len() {
            xs.swap(k, i);
            walk(xs, k + 1, out);
            xs.swap(k, i); // undo: without this, later branches see a corrupted array
        }
    }

    let mut out = Vec::new();
    walk(xs, 0, &mut out);
    out
}`,
          "tip": "Undo operations must mirror the choice exactly. Every swap gets a swap back; every push gets a pop."
        },
        {
          "h": "Bitmask pruning: N-queens",
          "p": [
            "N-queens places one queen per row with no two sharing a column or diagonal. A naive search tries all n columns per row and checks conflicts, which is O(n!) with a large constant. Representing occupied columns, down-diagonals, and up-diagonals as three u32 bitmasks turns conflict checking into three ORs and a NOT, and the free positions into a single AND against the row mask.",
            "The diagonal masks shift by one each row: a down-diagonal keeps its column index, so shifting left moves the attack pattern to the next row. Each set bit is one candidate; clearing the lowest set bit with x & x.wrapping_neg() enumerates them without a loop over columns. Counting all solutions for n = 8 becomes microseconds, and n = 12 is still interactive."
          ],
          "code": `/// Count N-queens solutions with column and diagonal bitmasks.
pub fn count_n_queens(n: u32) -> u64 {
    fn place(n: u32, cols: u32, down: u32, up: u32, count: &mut u64) {
        let full = (1u32 << n) - 1;
        let mut free = !(cols | down | up) & full;
        if free == 0 {
            return;
        }
        while free != 0 {
            let bit = free & free.wrapping_neg(); // lowest set bit
            free ^= bit;
            let next_cols = cols | bit;
            let next_down = (down | bit) << 1;
            let next_up = (up | bit) >> 1;
            if next_cols == full {
                *count += 1;
            } else {
                place(n, next_cols, next_down, next_up, count);
            }
        }
    }

    let mut count = 0u64;
    place(n, 0, 0, 0, &mut count);
    count
}

fn main() {
    assert_eq!(count_n_queens(8), 92);
    assert_eq!(count_n_queens(4), 2);
    println!("{}", count_n_queens(12));
}`,
          "tip": "free & free.wrapping_neg() isolates the lowest set bit; free &= free - 1 is the same trick without the negation."
        },
        {
          "h": "Order the branches before you prune them",
          "p": [
            "Pruning is only half of it; branch order decides how much of the tree you never visit. Choosing the most constrained variable first, and trying the most promising value first, can turn an intractable instance into a fast one without changing the worst-case bound. This is the MRV heuristic in constraint solvers, and it is why a Sudoku solver written with MRV feels instant while the naive one does not.",
            "Symmetry breaking is the other lever. If the problem has interchangeable pieces, fix one of them in a canonical position before searching. N-queens has eightfold symmetry, and a solver that does not exploit it does eight times the work. Both techniques are cheap to add and easy to get wrong, so they belong behind a flag with tests that compare against the unpruned solver on small inputs."
          ],
          "list": [
            "Most-constrained variable first: fail fast on the tightest domain",
            "Value ordering: try the value that leaves the most options for the rest",
            "Symmetry breaking: fix one representative of each equivalent class",
            "Memoise failed states only if the state fully captures the remaining problem"
          ]
        },
        {
          "h": "Exact cover and Dancing Links",
          "p": [
            "Some problems are set systems rather than sequences: choose a set of rows that covers every column exactly once. Sudoku, pentomino tiling, and N-queens all reduce to exact cover. Knuth's Algorithm X expresses the search as repeatedly choosing the column with the fewest ones and covering it; Dancing Links implements the cover and uncover operations as pointer surgery on circular doubly linked lists, so undo is O(1) and the matrix can be huge and sparse.",
            "That paper is worth reading for the technique, not just the algorithm: representing a sparse matrix as linked nodes and making backtracking cheap is the same idea as an arena with free lists. In Rust, an implementation is a Vec of nodes with four index links rather than raw pointers, which keeps it safe and still cache-hostile enough to be interesting to benchmark."
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement `count_n_queens(n: u32) -> u64` with three bitmasks and no board allocation, then generalise it to `first_solution(n: u32) -> Option<Vec<u32>>` returning the column of the queen in each row.",
        "starter": "pub fn count_n_queens(n: u32) -> u64 {\n    // cols, down, up masks; lowest-set-bit enumeration\n    todo!()\n}\n\npub fn first_solution(n: u32) -> Option<Vec<u32>> {\n    // same search, but records the chosen column per row and returns on success\n    todo!()",
        "hint": "Track placed = cols | down | up. A column is free when the corresponding bit is 0 in all three; shift down left and up right on the way down. For first_solution, push the bit index into a path Vec and pop on backtrack.",
        "solution": `pub fn count_n_queens(n: u32) -> u64 {
    fn place(n: u32, full: u32, cols: u32, down: u32, up: u32, count: &mut u64) {
        let mut free = !(cols | down | up) & full;
        while free != 0 {
            let bit = free & free.wrapping_neg();
            free ^= bit;
            let next_cols = cols | bit;
            if next_cols == full {
                *count += 1;
            } else {
                place(n, full, next_cols, (down | bit) << 1, (up | bit) >> 1, count);
            }
        }
    }

    let mut count = 0u64;
    let full = (1u32 << n) - 1;
    place(n, full, 0, 0, 0, &mut count);
    count
}

pub fn first_solution(n: u32) -> Option<Vec<u32>> {
    fn place(
        n: u32,
        full: u32,
        cols: u32,
        down: u32,
        up: u32,
        path: &mut Vec<u32>,
    ) -> Option<Vec<u32>> {
        let mut free = !(cols | down | up) & full;
        while free != 0 {
            let bit = free & free.wrapping_neg();
            free ^= bit;
            let column = bit.trailing_zeros();
            let next_cols = cols | bit;
            path.push(column);
            if next_cols == full {
                return Some(path.clone());
            }
            if let Some(solution) = place(n, full, next_cols, (down | bit) << 1, (up | bit) >> 1, path) {
                return Some(solution);
            }
            path.pop();
        }
        None
    }

    let mut path = Vec::new();
    place(n, (1u32 << n) - 1, 0, 0, 0, &mut path)
}

fn main() {
    assert_eq!(count_n_queens(8), 92);
    assert_eq!(count_n_queens(6), 4);
    assert_eq!(first_solution(4), Some(vec![1, 3, 0, 2]));
    assert_eq!(count_n_queens(0), 0);
    println!("ok");
}`
      },
      "questions": [
        {
          "q": "What does the undo step in choose-explore-unchoose protect against?",
          "options": [
            "Memory leaks in the recursion",
            "State left over from one branch leaking into sibling branches, producing order-dependent answers",
            "Stack overflow",
            "Duplicate solutions"
          ],
          "answer": 1,
          "explain": "The search must restore the exact state on return. A missing undo makes later branches see mutations from earlier ones, so results depend on traversal order."
        },
        {
          "q": "Why are three bitmasks faster than checking a board for conflicts?",
          "options": [
            "They use less memory than a Vec",
            "Conflict checks collapse to OR, NOT and AND, and free columns are enumerated with lowest-set-bit arithmetic",
            "They avoid recursion entirely",
            "They let the compiler vectorise the loop"
          ],
          "answer": 1,
          "explain": "One word holds the whole conflict state, so a candidate test is a few register operations instead of a loop over queens."
        },
        {
          "q": "Dancing Links makes backtracking in exact cover fast mainly because of what?",
          "options": [
            "It sorts the matrix rows",
            "Cover and uncover are O(1) pointer operations on circular linked lists, so undo is cheap",
            "It compresses the matrix with bitmaps",
            "It uses SIMD to test columns"
          ],
          "answer": 1,
          "explain": "Knuth's trick is that removing and restoring a column and its rows is constant-time pointer surgery, so the search spends its time branching rather than copying state."
        }
      ],
      "quickbytes": [
        "Choose, explore, unchoose: undo exactly what you did, in reverse order.",
        "Pass immutable state by value (a u32 mask) to eliminate the undo bug entirely.",
        "Enumerate free positions with free & free.wrapping_neg(), then free ^= bit.",
        "Try the most constrained variable first; pruning order matters as much as pruning."
      ],
      "production": [
        "Backtracking searches carry an explicit node budget or deadline and return a partial result when exceeded.",
        "Undo is tested by comparing against a fresh-state implementation on small inputs.",
        "Search state is small and Copy where possible, so backtracking cannot corrupt siblings.",
        "Symmetry breaking and heuristics are behind flags with correctness tests against the naive solver."
      ],
      "crates": [
        "std",
        "smallvec"
      ],
      "github": [
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        }
      ],
      "pitfall": "Forgetting one undo after a successful branch: the search still returns a solution, so tests pass, but later instances produce wrong counts that depend on input order.",
      "resources": [
        {
          "title": "Dancing links (Knuth): exact cover with O(1) cover and uncover",
          "url": "https://arxiv.org/abs/cs/0011047",
          "kind": "paper"
        },
        {
          "title": "std::collections::VecDeque — iterative deepening queues",
          "url": "https://doc.rust-lang.org/std/collections/struct.VecDeque.html",
          "kind": "docs"
        },
        {
          "title": "rust-lang/rust repository",
          "url": "https://github.com/rust-lang/rust",
          "kind": "repo"
        },
        {
          "title": "smallvec: small candidate buffers without allocation",
          "url": "https://docs.rs/smallvec/latest/smallvec/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "a16",
      "title": "String algorithms: UTF-8 boundaries, KMP, and multi-pattern search",
      "minutes": 95,
      "level": "industry",
      "goal": "Index strings without panicking on UTF-8, implement linear-time substring search, and choose the right tool for matching many patterns at once.",
      "sections": [
        {
          "h": "str is UTF-8; indices are bytes",
          "p": [
            "A Rust String is a Vec<u8> that is guaranteed to be valid UTF-8, and &str indexing is by byte offset. len() returns bytes, not characters; chars().count() is O(n); and slicing at a non-boundary panics. That panic is a real production failure: truncating a user's name to 32 bytes with &name[..32] crashes whenever byte 32 lands inside a multi-byte code point.",
            "The safe primitives are is_char_boundary, char_indices, and floor_char_boundary-style loops that walk back to a boundary. If you need a display width, use a crate that understands grapheme clusters, because even char count is wrong for emoji with modifiers. Treat byte offsets as the only cheap index, and convert to character positions only when the output actually needs them."
          ],
          "code": `/// Truncate to at most max_bytes without splitting a UTF-8 code point.
pub fn truncate_on_boundary(s: &str, max_bytes: usize) -> &str {
    if max_bytes >= s.len() {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn main() {
    let s = "héllo wörld";
    assert_eq!(s.len(), 13); // two 2-byte characters
    assert_eq!(s.chars().count(), 11);

    for cut in 0..=s.len() {
        let t = truncate_on_boundary(s, cut);
        assert!(s.starts_with(t), "truncation must not split a code point");
    }
    println!("{}", truncate_on_boundary(s, 2)); // "h"
}`,
          "tip": "Never index a &str with a length from a byte counter. Use is_char_boundary, or the str::floor_char_boundary method where available."
        },
        {
          "h": "find is a byte search, and memchr is faster",
          "p": [
            "str::find returns a byte offset, and for a multi-byte pattern it uses a substring searcher that is already quite good. For single-byte searches - delimiters, quotes, newlines - memchr is much faster because it compares 32 bytes per instruction with SIMD. Parsers that scan for one character at a time should use memchr::memchr or memchr_iter, not chars().position().",
            "Case-insensitive matching is where naive code goes wrong. to_lowercase allocates and can change length; Unicode case folding has rules that ASCII lowercasing ignores. For protocol tokens and ASCII identifiers, eq_ignore_ascii_case is correct and allocation-free. For human text, use a Unicode-aware crate and decide explicitly whether you need case folding or case conversion, because they answer different questions."
          ],
          "code": `/// Split on a byte delimiter without allocating per field.
pub fn split_lines(payload: &[u8]) -> Vec<&[u8]> {
    let mut fields = Vec::new();
    let mut start = 0usize;
    while let Some(offset) = memchr::memchr(b'\\n', &payload[start..]) {
        let end = start + offset;
        fields.push(&payload[start..end]);
        start = end + 1;
    }
    fields.push(&payload[start..]);
    fields
}

/// ASCII case-insensitive comparison, no allocation.
pub fn is_http_method(token: &str) -> bool {
    ["GET", "POST", "PUT", "DELETE", "HEAD"]
        .iter()
        .any(|known| token.eq_ignore_ascii_case(known))
}`,
          "tip": "memchr returns an offset relative to the slice you passed, so add the slice start before advancing."
        },
        {
          "h": "KMP: linear time on repetitive text",
          "p": [
            "The naive substring search restarts from scratch after each mismatch, which is O(nm) on inputs like aaaaaaaab with pattern aaaab. KMP precomputes a prefix function - the length of the longest proper prefix that is also a suffix for every pattern prefix - and uses it to fall back without re-reading the text. The result is O(n + m) with O(m) extra memory, and the fallback logic is the same idea behind Aho-Corasick's failure links.",
            "In practice, std's find and memchr's substring search use SIMD-accelerated algorithms that beat KMP on typical inputs. KMP's value is the guarantee and the technique: when you need streaming search where the text cannot be rewound, or when you are building failure links for a multi-pattern automaton, the prefix function is the tool. Implement it once to understand it, then use the library in production unless you need the streaming property."
          ],
          "code": `/// Prefix function: pi[i] = length of the longest proper prefix of pattern[..=i]
/// that is also a suffix of pattern[..=i].
pub fn prefix_function(pattern: &[u8]) -> Vec<usize> {
    let mut pi = vec![0usize; pattern.len()];
    let mut k = 0usize;
    for i in 1..pattern.len() {
        while k > 0 && pattern[i] != pattern[k] {
            k = pi[k - 1];
        }
        if pattern[i] == pattern[k] {
            k += 1;
        }
        pi[i] = k;
    }
    pi
}

/// All start offsets of needle in haystack, in O(n + m).
pub fn find_all(haystack: &[u8], needle: &[u8]) -> Vec<usize> {
    if needle.is_empty() {
        return (0..=haystack.len()).collect();
    }
    let pi = prefix_function(needle);
    let mut hits = Vec::new();
    let mut k = 0usize;
    for (i, &byte) in haystack.iter().enumerate() {
        while k > 0 && byte != needle[k] {
            k = pi[k - 1];
        }
        if byte == needle[k] {
            k += 1;
        }
        if k == needle.len() {
            hits.push(i + 1 - k);
            k = pi[k - 1]; // allow overlapping matches
        }
    }
    hits
}`,
          "tip": "After a match, fall back to pi[k-1] rather than resetting to zero, or overlapping occurrences are missed."
        },
        {
          "h": "Many patterns: Aho-Corasick",
          "p": [
            "Matching thousands of keywords with one pass over the text needs an automaton, not repeated finds. Aho-Corasick builds a trie of the patterns and adds failure links so a mismatch falls back to the longest suffix that is still a prefix of some pattern. The scan is O(n + matches) regardless of pattern count, which is why it powers intrusion detection rulesets and the literal optimisations inside the regex crate.",
            "The regex crate documents that it extracts required literals from a pattern and searches for them with an Aho-Corasick automaton before running the slower engine. Double-array trie layouts make the automaton compact and cache-friendly, which is the subject of current engineering papers. If you are matching a fixed dictionary against a stream, use aho-corasick rather than writing the automaton yourself."
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement `truncate_on_boundary` and `find_all` (KMP). Then verify with a test that a haystack of repeated characters returns every overlapping match, and that truncation at every byte offset never panics on multibyte text.",
        "starter": "pub fn truncate_on_boundary(s: &str, max_bytes: usize) -> &str {\n    todo!()\n}\n\npub fn prefix_function(pattern: &[u8]) -> Vec<usize> {\n    todo!()\n}\n\npub fn find_all(haystack: &[u8], needle: &[u8]) -> Vec<usize> {\n    todo!()\n}",
        "hint": "For truncation, walk end backwards while !s.is_char_boundary(end). For KMP, build pi first, then scan the haystack maintaining k; on a full match push i+1-k and set k = pi[k-1].",
        "solution": `pub fn truncate_on_boundary(s: &str, max_bytes: usize) -> &str {
    if max_bytes >= s.len() {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

pub fn prefix_function(pattern: &[u8]) -> Vec<usize> {
    let mut pi = vec![0usize; pattern.len()];
    let mut k = 0usize;
    for i in 1..pattern.len() {
        while k > 0 && pattern[i] != pattern[k] {
            k = pi[k - 1];
        }
        if pattern[i] == pattern[k] {
            k += 1;
        }
        pi[i] = k;
    }
    pi
}

pub fn find_all(haystack: &[u8], needle: &[u8]) -> Vec<usize> {
    if needle.is_empty() {
        return (0..=haystack.len()).collect();
    }
    let pi = prefix_function(needle);
    let mut hits = Vec::new();
    let mut k = 0usize;
    for (i, &byte) in haystack.iter().enumerate() {
        while k > 0 && byte != needle[k] {
            k = pi[k - 1];
        }
        if byte == needle[k] {
            k += 1;
        }
        if k == needle.len() {
            hits.push(i + 1 - k);
            k = pi[k - 1];
        }
    }
    hits
}

fn main() {
    assert_eq!(find_all(b"aaaaa", b"aa"), vec![0, 1, 2, 3]);
    assert_eq!(find_all(b"abababa", b"aba"), vec![0, 2, 4]);
    assert_eq!(find_all(b"abc", b"d"), Vec::<usize>::new());

    let text = "héllo wörld";
    for cut in 0..=text.len() {
        let truncated = truncate_on_boundary(text, cut);
        assert!(text.starts_with(truncated));
    }
    println!("ok");
}`
      },
      "questions": [
        {
          "q": "s.len() on the string héllo returns 6 for 5 characters. Why?",
          "options": [
            "len counts bytes and é is two bytes in UTF-8",
            "len counts grapheme clusters and é has two",
            "len includes a null terminator",
            "len rounds up to an alignment boundary"
          ],
          "answer": 0,
          "explain": "str::len is the byte length of the UTF-8 buffer. chars().count() gives the number of code points, which is also not the same as grapheme count."
        },
        {
          "q": "What is the worst-case complexity of naive substring search, and what does KMP guarantee?",
          "options": [
            "O(n + m) naive, O(nm) KMP",
            "O(nm) naive, O(n + m) KMP",
            "O(n log m) both",
            "O(n) naive, O(n + m) KMP"
          ],
          "answer": 1,
          "explain": "Naive search re-scans text after a mismatch, giving O(nm) on repetitive input. KMP's prefix function avoids re-reading, giving O(n + m)."
        },
        {
          "q": "When is memchr preferable to str::find?",
          "options": [
            "When searching for a single byte such as a delimiter",
            "When the pattern contains Unicode",
            "When the haystack is shorter than the pattern",
            "When the match must be case-insensitive"
          ],
          "answer": 0,
          "explain": "memchr compares wide blocks per instruction for one byte, which is much faster than a general substring search for delimiters and line breaks."
        }
      ],
      "quickbytes": [
        "str::len is bytes; chars().count() is O(n); slicing mid-code-point panics.",
        "Use is_char_boundary before any slicing with a byte offset from outside Rust.",
        "memchr for one byte, str::find for one pattern, aho-corasick for a dictionary.",
        "After a KMP match, fall back with k = pi[k-1] to keep overlapping matches."
      ],
      "production": [
        "No string is sliced with a byte count that did not come from a boundary-aware API.",
        "User-visible truncation is grapheme-aware and tested with multibyte and emoji input.",
        "Dictionary matching over streams uses an automaton, not a loop of finds.",
        "Case handling distinguishes ASCII tokens from Unicode text, and each path is tested."
      ],
      "crates": [
        "memchr",
        "regex",
        "std"
      ],
      "github": [
        {
          "name": "BurntSushi/memchr",
          "url": "https://github.com/BurntSushi/memchr"
        },
        {
          "name": "rust-lang/regex",
          "url": "https://github.com/rust-lang/regex"
        }
      ],
      "pitfall": "Slicing a user-supplied string with &s[..max_bytes]: the first request containing a multi-byte character that straddles the limit panics the handler, and ASCII-only tests never see it.",
      "resources": [
        {
          "title": "str — UTF-8 boundary methods and find",
          "url": "https://doc.rust-lang.org/std/primitive.str.html",
          "kind": "docs"
        },
        {
          "title": "memchr: SIMD byte and substring search",
          "url": "https://docs.rs/memchr/latest/memchr/",
          "kind": "docs"
        },
        {
          "title": "BurntSushi/memchr repository",
          "url": "https://github.com/BurntSushi/memchr",
          "kind": "repo"
        },
        {
          "title": "Engineering faster double-array Aho-Corasick automata",
          "url": "https://arxiv.org/abs/2207.13870",
          "kind": "paper"
        }
      ]
    },
    {
      "id": "a17",
      "title": "Bit manipulation: masks, popcount, and subset DP",
      "minutes": 80,
      "level": "advanced",
      "goal": "Read and write bit tricks safely, enumerate subsets of a mask, and recognise the 2^n problems where bitmask DP is the intended solution.",
      "sections": [
        {
          "h": "Operators, shifts, and the overflow rules",
          "p": [
            "Rust has the usual bitwise operators on unsigned integers, plus inherent methods that express intent: count_ones is popcount, leading_zeros and trailing_zeros locate the highest and lowest set bit, reverse_bits mirrors the word, and rotate_left rotates. These compile to single instructions on x86_64 and aarch64, so they are always preferable to hand-written loops that the optimiser may or may not recognise.",
            "Shifts are the sharp edge. In debug builds, shifting by a value greater than or equal to the bit width panics; in release the shift amount is masked, so a 64-bit shift by 64 becomes a shift by 0 and returns the original value. Use checked_shl and checked_shr when the amount is data-dependent, or assert it once at the boundary. Masking with (1u32 << n) - 1 also breaks when n == 32; use u64 or the full-mask special case."
          ],
          "code": `/// Bit helpers that behave the same in debug and release builds.
pub fn low_bit(x: u64) -> u64 {
    x & x.wrapping_neg()
}

pub fn clear_lowest(x: u64) -> u64 {
    x & (x - 1)
}

pub fn is_power_of_two(x: u64) -> bool {
    x != 0 && x & (x - 1) == 0
}

pub fn mask_of(n: u32) -> u64 {
    if n >= 64 { u64::MAX } else { (1u64 << n) - 1 }
}

fn main() {
    assert_eq!(low_bit(0b1011_0000), 0b0001_0000);
    assert_eq!(clear_lowest(0b1011_0000), 0b1010_0000);
    assert!(is_power_of_two(1 << 20));
    assert!(!is_power_of_two(0));
    assert_eq!(mask_of(64), u64::MAX);

    // A data-dependent shift must be checked, not assumed.
    assert_eq!(1u64.checked_shl(64), None);
    println!("ok");
}`,
          "tip": "x & x.wrapping_neg() isolates the lowest set bit; x & (x - 1) clears it. Both are one instruction and both appear everywhere in bitmask code."
        },
        {
          "h": "Enumerating subsets without an n-bit loop",
          "p": [
            "For a mask m, the submasks are all s with s & m == s. Instead of iterating 0..2^n and filtering, the trick s = (s - 1) & m walks every submask in decreasing order and terminates after zero. The total work over all masks is 3^n, which sounds large until you compare it with 4^n for the filter-everything version; for n = 20 the difference is minutes versus hours.",
            "The same structure appears in SOS (sum over subsets) DP, where you push information from a submask to its supersets, and in the inclusion-exclusion computations behind counting problems. Whenever an algorithm says sum over all subsets, this enumeration is how it is implemented without allocating."
          ],
          "code": `/// weights[i] is the value of element i. Sums every submask of every mask: O(3^n).
pub fn submask_sums(n: usize, weights: &[u64]) -> Vec<u64> {
    assert!(n < 24, "3^n enumeration needs a small n");
    assert_eq!(weights.len(), n);

    // bit_value[mask] = sum of weights of the bits set in mask.
    let size = 1usize << n;
    let mut bit_value = vec![0u64; size];
    for mask in 1..size {
        let low = mask & mask.wrapping_neg();
        let bit = low.trailing_zeros() as usize;
        bit_value[mask] = bit_value[mask ^ low] + weights[bit];
    }

    let mut sums = vec![0u64; size];
    for mask in 0..size {
        let mut total = 0u64;
        let mut sub = mask;
        loop {
            total += bit_value[sub];
            if sub == 0 {
                break;
            }
            sub = (sub - 1) & mask;
        }
        sums[mask] = total;
    }
    sums
}

fn main() {
    let sums = submask_sums(4, &[1, 10, 100, 1000]);
    // Submasks of {0,1,2} sum to 0+1+10+100+11+101+110+111 = 444.
    assert_eq!(sums[0b0111], 444);
    // Each weight appears in exactly half of the 16 subsets.
    assert_eq!(sums[0b1111], 8 * (1 + 10 + 100 + 1000));
    println!("{}", sums[0b1111]);
}`,
          "tip": "The loop body must run for sub == 0 as well, so break after processing zero rather than using a while condition."
        },
        {
          "h": "Bitmask DP: the travelling salesman",
          "p": [
            "Held-Karp solves TSP in O(2^n * n^2) by defining dp[mask][last] as the cheapest path that visits exactly the cities in mask and ends at last. The transition appends an unvisited city, and the answer closes the tour back to the start. For n = 20 that is about a million masks times 20 endpoints, which fits in memory and runs in seconds; for n = 25 it is already impractical, and that boundary is the whole lesson.",
            "Before writing it, check that n is small and that the state needs the whole set. Many problems that look like TSP are actually assignment problems solvable in O(n^3) by the Hungarian algorithm, or shortest paths solvable in O(n^3) by Floyd-Warshall. Bitmask DP is the right tool when visitation history genuinely matters, not as a default for anything with a set in the statement."
          ],
          "code": `/// Held-Karp TSP: cost[i][j] is the direct cost from i to j, diagonal zero.
/// Returns None when n is too large or there is no tour.
pub fn tsp(cost: &[Vec<u64>]) -> Option<u64> {
    let n = cost.len();
    if n == 0 {
        return None;
    }
    if n > 22 {
        return None; // 2^22 * 22 states is the practical ceiling
    }

    let states = 1usize << n;
    let mut dp = vec![vec![u64::MAX; n]; states];
    dp[1][0] = 0; // start at city 0, only city 0 visited

    for mask in 1..states {
        for last in 0..n {
            if dp[mask][last] == u64::MAX || mask & (1 << last) == 0 {
                continue;
            }
            for next in 0..n {
                if mask & (1 << next) != 0 {
                    continue;
                }
                let next_mask = mask | (1 << next);
                let candidate = dp[mask][last] + cost[last][next];
                if candidate < dp[next_mask][next] {
                    dp[next_mask][next] = candidate;
                }
            }
        }
    }

    let all = states - 1;
    let mut best = u64::MAX;
    for last in 1..n {
        if dp[all][last] != u64::MAX {
            best = best.min(dp[all][last] + cost[last][0]);
        }
    }
    (best != u64::MAX).then_some(best)
}`,
          "tip": "n > 22 should be an explicit typed error, not a silent None: the caller needs to know the instance is out of scope rather than infeasible."
        },
        {
          "h": "Bitsets when the mask does not fit a word",
          "p": [
            "Above 64 elements, a mask becomes an array of words. fixedbitset gives a compact fixed-size bit set with union, intersection, and iteration over set bits, and it is what petgraph uses internally. bitvec gives slices and views with explicit bit order (Msb0 or Lsb0), which matters the moment you serialise a bitset to a wire format and read it back on a different machine.",
            "Word-level parallelism is the payoff: a 10,000-element set intersection is 157 u64 ANDs, and popcount over the result is 157 instructions, not 10,000 branches. Bitset-based graph algorithms (reachability, transitive closure, set cover) exploit this directly. Roaring bitmaps go further with adaptive containers for sparse and dense regions, which is why search engines use them for document id sets."
          ],
          "code": `use bitvec::prelude::*;

/// Set algebra over dynamic bitsets: union, intersection, and cardinality.
pub fn bitset_ops(a: &[u64], b: &[u64]) -> (usize, usize) {
    let a = a.view_bits::<Lsb0>();
    let b = b.view_bits::<Lsb0>();
    let n = a.len().min(b.len());

    let mut union = bitvec![0; n];
    let mut intersection = bitvec![0; n];
    for i in 0..n {
        union.set(i, a[i] | b[i]);
        intersection.set(i, a[i] & b[i]);
    }
    (union.count_ones(), intersection.count_ones())
}

/// Reachability by bitset: row u gains row v in one word-wise OR per edge.
pub fn transitive_closure(adj: &[Vec<usize>], n: usize) -> Vec<Vec<u64>> {
    let words = n.div_ceil(64);
    let mut reach = vec![vec![0u64; words]; n];
    for (u, neighbors) in adj.iter().enumerate() {
        reach[u][u / 64] |= 1 << (u % 64);
        for &v in neighbors {
            reach[u][v / 64] |= 1 << (v % 64);
        }
    }
    for k in 0..n {
        for u in 0..n {
            if reach[u][k / 64] & (1 << (k % 64)) != 0 {
                for w in 0..words {
                    let add = reach[k][w];
                    reach[u][w] |= add;
                }
            }
        }
    }
    reach
}`,
          "tip": "Pick Msb0 or Lsb0 once, write it in the type alias, and never mix: the same bytes decode to different sets under different bit orders."
        }
      ],
      "exercise": {
        "prompt": "Implement `low_bit`, `clear_lowest`, and a safe `mask_of(n)` that does not overflow at n = 64. Then implement `submask_sums(n, weights)` and verify one entry by hand. Finally, explain why (1u32 << n) - 1 is a bug for n = 32.",
        "starter": "pub fn low_bit(x: u64) -> u64 { todo!() }\npub fn clear_lowest(x: u64) -> u64 { todo!() }\npub fn mask_of(n: u32) -> u64 { todo!() }\n\npub fn submask_sums(n: usize, weights: &[u64]) -> Vec<u64> {\n    todo!()\n}",
        "hint": "low_bit uses wrapping_neg; clear_lowest uses x - 1; mask_of must special-case n >= 64. For submasks, precompute the value of each mask from its lowest bit, then iterate sub = (sub - 1) & mask and break after processing zero.",
        "solution": `pub fn low_bit(x: u64) -> u64 {
    x & x.wrapping_neg()
}

pub fn clear_lowest(x: u64) -> u64 {
    x & (x - 1)
}

pub fn mask_of(n: u32) -> u64 {
    if n >= 64 {
        u64::MAX
    } else {
        (1u64 << n) - 1
    }
}

pub fn submask_sums(n: usize, weights: &[u64]) -> Vec<u64> {
    assert!(n < 24);
    assert_eq!(weights.len(), n);
    let size = 1usize << n;

    let mut bit_value = vec![0u64; size];
    for mask in 1..size {
        let low = mask & mask.wrapping_neg();
        let bit = low.trailing_zeros() as usize;
        bit_value[mask] = bit_value[mask ^ low] + weights[bit];
    }

    let mut sums = vec![0u64; size];
    for mask in 0..size {
        let mut total = 0u64;
        let mut sub = mask;
        loop {
            total += bit_value[sub];
            if sub == 0 {
                break;
            }
            sub = (sub - 1) & mask;
        }
        sums[mask] = total;
    }
    sums
}

fn main() {
    assert_eq!(low_bit(40), 8);
    assert_eq!(clear_lowest(40), 32);
    assert_eq!(mask_of(32), 0xFFFF_FFFF);
    assert_eq!(mask_of(64), u64::MAX);

    let sums = submask_sums(4, &[1, 10, 100, 1000]);
    assert_eq!(sums[0b0011], 0 + 1 + 10 + 11);
    assert_eq!(sums[0b0111], 444);
    assert_eq!(sums[0b1111], 8 * 1111);
    println!("ok");
}`
      },
      "questions": [
        {
          "q": "What does x & x.wrapping_neg() compute?",
          "options": [
            "The lowest set bit of x as a value",
            "The highest set bit of x",
            "The number of set bits",
            "x with its lowest bit cleared"
          ],
          "answer": 0,
          "explain": "Negating in two's complement flips the bits above the lowest set bit, so the AND isolates exactly that bit. x & (x - 1) does the opposite: clears it."
        },
        {
          "q": "Why is (1u32 << n) - 1 wrong for a full 32-bit mask?",
          "options": [
            "It produces a mask of 31 bits",
            "Shifting a u32 by 32 panics in debug and is masked in release",
            "It overflows the subtraction",
            "It only works for signed integers"
          ],
          "answer": 1,
          "explain": "The shift amount equals the bit width. Debug builds panic; release masks the amount to zero, giving 1 - 1 = 0 instead of 0xFFFF_FFFF."
        },
        {
          "q": "What is the time complexity of Held-Karp TSP for n cities?",
          "options": [
            "O(n^2)",
            "O(2^n * n^2)",
            "O(n!)",
            "O(3^n)"
          ],
          "answer": 1,
          "explain": "There are 2^n subsets and n possible endpoints, and each state tries n next cities. That is 2^n * n^2 transitions, which is why n beyond about 22 is impractical."
        }
      ],
      "quickbytes": [
        "x & x.wrapping_neg() isolates the lowest set bit; x & (x - 1) clears it.",
        "Use checked_shl for data-dependent shift amounts; debug and release behave differently otherwise.",
        "Enumerate submasks with s = (s - 1) & mask, and handle s == 0 before breaking.",
        "fixedbitset or bitvec once the mask exceeds 64 bits; word-parallel ops are the point."
      ],
      "production": [
        "Shift amounts that depend on input are validated or use checked_shl.",
        "Mask helpers are unit-tested at the width boundary (n = 0, 63, 64).",
        "Bitmask DP refuses instances above a documented n instead of exhausting memory.",
        "Bit order is fixed in a type alias and tested across serialisation boundaries."
      ],
      "crates": [
        "bitvec",
        "fixedbitset",
        "std"
      ],
      "github": [
        {
          "name": "bitvecto-rs/bitvec",
          "url": "https://github.com/bitvecto-rs/bitvec"
        },
        {
          "name": "petgraph/fixedbitset",
          "url": "https://github.com/petgraph/fixedbitset"
        }
      ],
      "pitfall": "Computing a full-width mask with (1u32 << n) - 1: at n = 32 the debug build panics and the release build silently returns zero, so every element is filtered out in production only.",
      "resources": [
        {
          "title": "bitvec: bit-level slices and views with explicit ordering",
          "url": "https://docs.rs/bitvec/latest/bitvec/",
          "kind": "docs"
        },
        {
          "title": "bitvecto-rs/bitvec repository",
          "url": "https://github.com/bitvecto-rs/bitvec",
          "kind": "repo"
        },
        {
          "title": "fixedbitset: compact fixed-size bitsets used by petgraph",
          "url": "https://docs.rs/fixedbitset/latest/fixedbitset/",
          "kind": "docs"
        },
        {
          "title": "std::collections: BinaryHeap and other container foundations",
          "url": "https://doc.rust-lang.org/std/collections/index.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "a18",
      "title": "Math and number theory: gcd, modular arithmetic, primality",
      "minutes": 85,
      "level": "advanced",
      "goal": "Compute gcd and modular inverses without overflow, exponentiate in log time, and run a Miller-Rabin test that is deterministic for every u64.",
      "sections": [
        {
          "h": "Euclid, extended, and the inverse",
          "p": [
            "Euclid's algorithm is subtraction replaced by remainder: gcd(a, b) = gcd(b, a mod b), which terminates in O(log min(a, b)) steps. The extended version also returns x and y with ax + by = g, and when gcd(a, m) = 1 that x is the modular inverse of a modulo m. num-integer provides gcd, lcm, and extended_gcd on its Integer trait, so production code rarely needs to write them.",
            "The trap is overflow in lcm and in the multiplication inside extended gcd. lcm(a, b) = a / gcd(a, b) * b is safe in that order because the division is exact; writing a * b / gcd overflows for values that fit comfortably in the type. If the result cannot fit, the correct answer is an error or a wider type, not a wrapped value that looks plausible."
          ],
          "code": `use num_integer::Integer;

/// Modular inverse via the extended Euclidean algorithm.
/// ExtendedGcd is a struct with gcd, x and y fields; ax + my = gcd.
pub fn inverse_mod(a: i64, m: i64) -> Option<i64> {
    let eg = a.extended_gcd(&m);
    if eg.gcd != 1 {
        return None; // no inverse when gcd(a, m) != 1
    }
    Some(eg.x.rem_euclid(m))
}

fn main() {
    assert_eq!(12i64.gcd(&18), 6);
    assert_eq!(12i64.lcm(&18), 36);
    // 3 * 4 = 12 = 1 mod 11
    assert_eq!(inverse_mod(3, 11), Some(4));
    assert_eq!(inverse_mod(6, 9), None);
}`,
          "tip": "rem_euclid is the correct normalisation for a possibly negative x; % keeps the sign of the dividend and produces negative inverses."
        },
        {
          "h": "Modular exponentiation without overflow",
          "p": [
            "Computing a^e mod m by repeated multiplication overflows almost immediately, even for small inputs: two 32-bit numbers multiply to 64 bits, and in u64 arithmetic the intermediate wraps. Binary exponentiation reduces the exponent by half each step in O(log e) multiplications, but each multiplication still needs a wider intermediate or a mulmod routine.",
            "In Rust the simplest correct approach is to widen: cast to u128, multiply, reduce, cast back. That covers every u64 modulus without a custom mulmod. For larger moduli, or for constant-time code where branch behaviour matters, use a big-integer crate and a documented reduction strategy. Never rely on wrapping arithmetic for a modular result: it is silent and wrong."
          ],
          "code": `/// (base ^ exp) mod modulus, using u128 for the intermediate product.
pub fn mod_pow(mut base: u64, mut exp: u64, modulus: u64) -> u64 {
    if modulus == 1 {
        return 0;
    }
    let mut result = 1u64;
    base %= modulus;
    while exp > 0 {
        if exp & 1 == 1 {
            result = (result as u128 * base as u128 % modulus as u128) as u64;
        }
        base = (base as u128 * base as u128 % modulus as u128) as u64;
        exp >>= 1;
    }
    result
}

fn main() {
    assert_eq!(mod_pow(2, 10, 1_000), 24);
    assert_eq!(mod_pow(3, 0, 7), 1);
    assert_eq!(mod_pow(2, 63, u64::MAX), 0); // exact multiple
    println!("{}", mod_pow(7, 1_000_000_007, 1_000_000_009));
}`,
          "tip": "modulus == 1 must return 0 explicitly, otherwise the initial result of 1 is already outside the ring."
        },
        {
          "h": "Miller-Rabin: deterministic for u64",
          "p": [
            "Trial division is O(sqrt n) and hopeless beyond a few trillion. Miller-Rabin tests a candidate against bases a: write n - 1 as d * 2^s, compute a^d mod n, and square up to s times looking for n - 1. A composite that passes a base is a pseudoprime to that base, and the chance of passing many random bases is bounded by 1/4 per base.",
            "For 64-bit inputs randomness is unnecessary: testing the first twelve primes - 2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37 - is deterministic for every n below roughly 3.18 * 10^23, which comfortably covers u64. That is the version to ship for hash table sizing and competitive primality checks; use a cryptographic library when you need provable primes or adversarial resistance."
          ],
          "code": `pub fn is_prime(n: u64) -> bool {
    if n < 2 {
        return false;
    }
    for p in [2u64, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37] {
        if n % p == 0 {
            return n == p;
        }
    }

    // n - 1 = d * 2^s with d odd.
    let mut d = n - 1;
    let mut s = 0u32;
    while d % 2 == 0 {
        d /= 2;
        s += 1;
    }

    'witness: for a in [2u64, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37] {
        let mut x = mod_pow(a, d, n);
        if x == 1 || x == n - 1 {
            continue;
        }
        for _ in 0..s - 1 {
            x = mod_pow(x, 2, n);
            if x == n - 1 {
                continue 'witness;
            }
        }
        return false;
    }
    true
}

fn main() {
    assert!(is_prime(2));
    assert!(!is_prime(1));
    assert!(is_prime(1_000_000_007));
    // 2^61 - 1 is a Mersenne prime.
    assert!(is_prime((1u64 << 61) - 1));
    // A strong pseudoprime to base 2, caught by the full witness set.
    assert!(!is_prime(321_503_175_391));
    println!("ok");
}`,
          "tip": "The witness loop needs a labelled continue to skip to the next base once x reaches n - 1; a plain break leaves the inner loop and reports composite."
        },
        {
          "h": "Sieves, integer roots, and float traps",
          "p": [
            "The sieve of Eratosthenes finds every prime below n in O(n log log n); with a bitset it holds n bits rather than n bytes, and a segmented sieve extends it beyond memory by processing blocks. Use it when you need many primes, and Miller-Rabin when you need a few large ones. Trial division is fine only for numbers under a few million.",
            "isqrt is exact integer square root and is the right tool for loop bounds in trial division and for perfect-square checks. Converting to f64 and back loses precision above 2^53, and the rounding can land one below or above the true root, producing an off-by-one that only appears on large inputs. Rust's u64::isqrt is exact; use it, and if you must use floats, verify the result by squaring."
          ],
          "list": [
            "isqrt for bounds and perfect squares, never (n as f64).sqrt() as u64",
            "Sieve with a bitset for dense small ranges; segmented sieve for huge ranges",
            "Miller-Rabin first, then a Lucas test if you need Baillie-PSW confidence",
            "u128 intermediates for any modular multiplication of u64 values"
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement `mod_pow` with a u128 intermediate, `inverse_mod` via extended gcd, and `is_prime` with the twelve-witness Miller-Rabin. Verify that the inverse round-trips (a * inverse) % m == 1, and that composites with small factors are rejected quickly.",
        "starter": "pub fn mod_pow(base: u64, exp: u64, modulus: u64) -> u64 { todo!() }\n\npub fn inverse_mod(a: i64, m: i64) -> Option<i64> {\n    // extended gcd, then rem_euclid\n    todo!()\n}\n\npub fn is_prime(n: u64) -> bool { todo!() }",
        "hint": "Binary exponentiation squares the base each step and multiplies into the result when the low bit of the exponent is set. For the inverse, bail when gcd != 1 and normalise with rem_euclid.",
        "solution": `pub fn mod_pow(mut base: u64, mut exp: u64, modulus: u64) -> u64 {
    if modulus == 1 {
        return 0;
    }
    let mut result = 1u64;
    base %= modulus;
    while exp > 0 {
        if exp & 1 == 1 {
            result = (result as u128 * base as u128 % modulus as u128) as u64;
        }
        base = (base as u128 * base as u128 % modulus as u128) as u64;
        exp >>= 1;
    }
    result
}

pub fn inverse_mod(a: i64, m: i64) -> Option<i64> {
    fn egcd(a: i64, b: i64) -> (i64, i64, i64) {
        if b == 0 {
            (a, 1, 0)
        } else {
            let (g, x, y) = egcd(b, a % b);
            (g, y, x - (a / b) * y)
        }
    }
    let (g, x, _) = egcd(a.rem_euclid(m), m);
    if g != 1 {
        None
    } else {
        Some(x.rem_euclid(m))
    }
}

pub fn is_prime(n: u64) -> bool {
    if n < 2 {
        return false;
    }
    for p in [2u64, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37] {
        if n % p == 0 {
            return n == p;
        }
    }

    let mut d = n - 1;
    let mut s = 0u32;
    while d % 2 == 0 {
        d /= 2;
        s += 1;
    }

    'witness: for a in [2u64, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37] {
        let mut x = mod_pow(a, d, n);
        if x == 1 || x == n - 1 {
            continue;
        }
        for _ in 0..s - 1 {
            x = mod_pow(x, 2, n);
            if x == n - 1 {
                continue 'witness;
            }
        }
        return false;
    }
    true
}

fn main() {
    assert_eq!(mod_pow(2, 10, 1_000), 24);
    assert_eq!(inverse_mod(3, 11), Some(4));
    assert_eq!(inverse_mod(6, 9), None);
    for (a, m) in [(3i64, 11i64), (17, 3120), (7, 1_000_000_007)] {
        let inv = inverse_mod(a, m).unwrap();
        assert_eq!((a.rem_euclid(m) * inv) % m, 1);
    }

    assert!(is_prime(2));
    assert!(!is_prime(1));
    assert!(is_prime(1_000_000_007));
    assert!(!is_prime(321_503_175_391));
    println!("ok");
}`
      },
      "questions": [
        {
          "q": "Why is lcm computed as a / gcd(a, b) * b rather than a * b / gcd(a, b)?",
          "options": [
            "The division-first form is exact and avoids overflowing the intermediate product",
            "The second form is not mathematically equivalent",
            "Division is faster than multiplication",
            "gcd returns a float"
          ],
          "answer": 0,
          "explain": "gcd divides a exactly, so the order a / g * b never exceeds the true lcm. Multiplying first can overflow even when the lcm itself fits."
        },
        {
          "q": "What makes Miller-Rabin deterministic for u64 with the first twelve primes?",
          "options": [
            "The primes are large enough to divide every composite",
            "No composite below roughly 3.18e23 passes all twelve as witnesses",
            "The test falls back to trial division",
            "Twelve rounds make the error probability exactly zero for any size"
          ],
          "answer": 1,
          "explain": "The witness set has been proven sufficient below that bound, which exceeds u64::MAX. Above it, you need more bases or a different test."
        },
        {
          "q": "Why is (n as f64).sqrt() as u64 unsafe as an integer square root?",
          "options": [
            "f64 cannot represent integers above 2^53 exactly, so rounding can be off by one",
            "sqrt panics for large inputs",
            "The cast rounds toward negative infinity",
            "f64 has no square root for odd numbers"
          ],
          "answer": 0,
          "explain": "Above 2^53 the conversion loses integer precision, so the result can be one below or above the true root. u64::isqrt is exact."
        }
      ],
      "quickbytes": [
        "Use u128 intermediates for modular multiplication of u64 values.",
        "rem_euclid normalises negative results; % keeps the dividend's sign.",
        "Twelve Miller-Rabin witnesses are deterministic for all u64.",
        "u64::isqrt is exact; float sqrt then cast is an off-by-one waiting for large inputs."
      ],
      "production": [
        "Modular arithmetic widens intermediates and is property-tested against a reference for small moduli.",
        "Primality tests document their determinism bound and never claim more than it proves.",
        "Integer roots use isqrt, and float square roots are verified by squaring.",
        "Hash table sizing that depends on primes uses a verified prime table, not a heuristic."
      ],
      "crates": [
        "num-integer",
        "std"
      ],
      "github": [
        {
          "name": "rust-num/num-integer",
          "url": "https://github.com/rust-num/num-integer"
        },
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        }
      ],
      "pitfall": "Computing a modular inverse with Fermat's little theorem for a modulus that is not prime: the result satisfies nothing, and the failure appears later as a corrupt hash or a broken signature.",
      "resources": [
        {
          "title": "num-integer: Integer trait with gcd, lcm and extended_gcd",
          "url": "https://docs.rs/num-integer/latest/num_integer/",
          "kind": "docs"
        },
        {
          "title": "rust-num/num-integer repository",
          "url": "https://github.com/rust-num/num-integer",
          "kind": "repo"
        },
        {
          "title": "On the Distribution of Witnesses in the Miller-Rabin Test",
          "url": "https://arxiv.org/abs/1608.07317",
          "kind": "paper"
        },
        {
          "title": "std::cmp::Ord — ordering requirements for key types",
          "url": "https://doc.rust-lang.org/std/cmp/trait.Ord.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "a19",
      "title": "Randomised algorithms: sampling, shuffle, and selection",
      "minutes": 80,
      "level": "advanced",
      "goal": "Use rand without breaking reproducibility, sample from a stream in one pass, and get an expected-linear selection without sorting.",
      "sections": [
        {
          "h": "Randomness you can reproduce",
          "p": [
            "rand 0.10 exposes rand::rng() for a thread-local generator and rand::random_range(a..b) for a value in a range. The range and sampling methods live on RngExt, which is blanket-implemented for every Rng and must be imported. Thread-local generators are convenient and not reproducible across runs; when you need reproducibility - tests, simulations, benchmarks, replays - construct StdRng::seed_from_u64 and pass it explicitly.",
            "Randomness for security is a different problem. A seeded PRNG is predictable by design, so tokens, salts, and session ids must come from the operating system's CSPRNG, not from StdRng. rand exposes that distinction through its rngs module; using the wrong one is a vulnerability, not a style issue."
          ],
          "code": `use rand::rngs::StdRng;
use rand::{RngExt, SeedableRng};

/// Deterministic shuffle for tests and replays: same seed, same permutation.
pub fn shuffle_with_seed<T>(items: &mut [T], seed: u64) -> StdRng {
    let mut rng = StdRng::seed_from_u64(seed);
    for i in (1..items.len()).rev() {
        let j = rng.random_range(0..=i);
        items.swap(i, j);
    }
    rng
}

fn main() {
    let mut a = vec![1, 2, 3, 4, 5];
    let mut b = vec![1, 2, 3, 4, 5];
    shuffle_with_seed(&mut a, 42);
    shuffle_with_seed(&mut b, 42);
    assert_eq!(a, b);
    println!("{a:?}");
}`,
          "tip": "Iterate the Fisher-Yates loop downwards. Doing it upwards with j in 0..=i produces a biased shuffle that looks random in small tests."
        },
        {
          "h": "Reservoir sampling: one pass, uniform sample",
          "p": [
            "When the input does not fit in memory, or you do not know its length, reservoir sampling keeps a uniform sample of k items in O(n) time and O(k) space. Keep the first k items, then for item i choose j uniformly in 0..=i and replace reservoir[j] when j < k. Every item ends up in the sample with probability k/n, which is exactly uniform.",
            "The algorithm generalises to weighted sampling, where items have different inclusion probabilities, and to distributed streams, where each shard samples and the coordinator merges with adjusted weights. The weighted case is not a small change - naive weighting biases the sample - so use a published algorithm and test the distribution rather than trusting intuition."
          ],
          "code": `use rand::{Rng, RngExt};

/// Uniform sample of k items from a stream of unknown length, in one pass.
pub fn reservoir_sample<T: Clone>(stream: &[T], k: usize, rng: &mut impl Rng) -> Vec<T> {
    if k == 0 {
        return Vec::new();
    }
    let mut reservoir: Vec<T> = Vec::with_capacity(k);
    for (i, item) in stream.iter().enumerate() {
        if i < k {
            reservoir.push(item.clone());
        } else {
            let j = rng.random_range(0..=i);
            if j < k {
                reservoir[j] = item.clone();
            }
        }
    }
    reservoir
}

fn main() {
    let mut rng = rand::rng();
    let data: Vec<u32> = (0..1_000).collect();
    let sample = reservoir_sample(&data, 10, &mut rng);
    assert_eq!(sample.len(), 10);
    assert_eq!(reservoir_sample(&data, 0, &mut rng).len(), 0);
    println!("{sample:?}");
}`,
          "tip": "Draw j from 0..=i inclusive. Using 0..i biases the sample toward early items because the last position can never be chosen for i."
        },
        {
          "h": "Selection without sorting",
          "p": [
            "Finding the k-th smallest element does not require a sort. Quickselect partitions around a pivot and recurses into one side, which is O(n) expected and O(n^2) worst case on adversarial pivots. Rust exposes this as select_nth_unstable, which reorders the slice so that the element at k is in its sorted position, everything before is smaller, and everything after is larger - all in expected linear time.",
            "For a guaranteed linear bound, median-of-medians chooses a pivot that is provably good, at the cost of a large constant and extra allocation; it is a theory result you should know and rarely ship. In practice, random pivots plus a fallback to sorting small partitions is what libraries do. Use select_nth_unstable for top-k, percentiles, and any place where a full sort is wasted work."
          ],
          "code": `/// The k smallest values, unordered, in expected O(n) time.
pub fn k_smallest(values: &mut [u64], k: usize) -> &[u64] {
    if k == 0 {
        return &[];
    }
    if k >= values.len() {
        values.sort_unstable();
        return values;
    }
    values.select_nth_unstable(k - 1);
    &values[..k]
}

fn main() {
    let mut values = vec![9, 1, 8, 2, 7, 3, 6, 4, 5];
    let mut smallest = k_smallest(&mut values, 3).to_vec();
    smallest.sort_unstable();
    assert_eq!(smallest, vec![1, 2, 3]);
    println!("{smallest:?}");
}`,
          "tip": "select_nth_unstable returns the three partitions; discarding the tuple is fine, but the borrow ends with the statement, so bind the slice afterwards."
        },
        {
          "h": "Las Vegas, Monte Carlo, and skip lists",
          "p": [
            "A Las Vegas algorithm is always correct and sometimes slow: randomised quicksort, skip-list search. A Monte Carlo algorithm always finishes in bounded time and is sometimes wrong: Miller-Rabin with random bases, probabilistic counting. Naming which one you built matters, because the mitigations differ - a Las Vegas algorithm needs a timeout, a Monte Carlo one needs an error bound.",
            "Skip lists are the cleanest example of randomness buying simplicity: each node gets a random level, searches descend levels and move right, and the expected search cost is O(log n) with a small constant and no rotations. Concurrent skip lists are much easier to make lock-free than balanced trees, which is why databases and in-memory indexes use them. The randomness is in the structure, not the query, so a bad seed affects every operation - seed it once and keep it."
          ],
          "list": [
            "Deterministic seed in tests, entropy in production, CSPRNG for secrets",
            "Test distributions, not single draws: chi-square or bucket counts over many runs",
            "Bound retries in Las Vegas loops and return an error rather than spinning",
            "Document the failure probability of every Monte Carlo decision"
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement `reservoir_sample(stream, k, rng)` and `k_smallest(values, k)` using select_nth_unstable. Then write a test that samples 10,000 times from 100 items with k = 10 and asserts every item appears within a plausible frequency band.",
        "starter": "use rand::{Rng, RngExt};\n\npub fn reservoir_sample<T: Clone>(stream: &[T], k: usize, rng: &mut impl Rng) -> Vec<T> {\n    todo!()\n}\n\npub fn k_smallest(values: &mut [u64], k: usize) -> &[u64] {\n    todo!()\n}",
        "hint": "For the reservoir, keep the first k and replace at index j when random_range(0..=i) < k. For selection, call select_nth_unstable(k - 1) and slice the front; guard k == 0 and k >= len.",
        "solution": `use rand::rngs::StdRng;
use rand::{Rng, RngExt, SeedableRng};

pub fn reservoir_sample<T: Clone>(stream: &[T], k: usize, rng: &mut impl Rng) -> Vec<T> {
    if k == 0 {
        return Vec::new();
    }
    let mut reservoir = Vec::with_capacity(k);
    for (i, item) in stream.iter().enumerate() {
        if i < k {
            reservoir.push(item.clone());
        } else {
            let j = rng.random_range(0..=i);
            if j < k {
                reservoir[j] = item.clone();
            }
        }
    }
    reservoir
}

pub fn k_smallest(values: &mut [u64], k: usize) -> &[u64] {
    if k == 0 {
        return &[];
    }
    if k >= values.len() {
        values.sort_unstable();
        return values;
    }
    values.select_nth_unstable(k - 1);
    &values[..k]
}

fn main() {
    let mut rng = StdRng::seed_from_u64(7);
    let data: Vec<u32> = (0..100).collect();
    let mut counts = vec![0u32; 100];
    for _ in 0..10_000 {
        for item in reservoir_sample(&data, 10, &mut rng) {
            counts[item as usize] += 1;
        }
    }
    // Each item should appear about 1000 times; allow a wide band.
    assert!(counts.iter().all(|&c| (800..1200).contains(&c)), "{counts:?}");

    let mut values = vec![9, 1, 8, 2, 7, 3, 6, 4, 5];
    let mut smallest = k_smallest(&mut values, 3).to_vec();
    smallest.sort_unstable();
    assert_eq!(smallest, vec![1, 2, 3]);
    println!("ok");
}`
      },
      "questions": [
        {
          "q": "Why must Fisher-Yates iterate downwards with j chosen in 0..=i?",
          "options": [
            "It is faster due to cache locality",
            "Choosing j from 0..i excludes the last position and biases the permutation",
            "Upward iteration cannot express the swap",
            "rand requires descending indices"
          ],
          "answer": 1,
          "explain": "The correctness argument needs every position to be equally likely at each step. Excluding i makes the last element never chosen for its own slot, producing a measurable bias."
        },
        {
          "q": "What is the space complexity of reservoir sampling with sample size k?",
          "options": [
            "O(n)",
            "O(k)",
            "O(log n)",
            "O(1)"
          ],
          "answer": 1,
          "explain": "Only the reservoir of k items is retained, regardless of stream length. That is what makes it usable on streams that do not fit in memory."
        },
        {
          "q": "Which statement separates a Las Vegas from a Monte Carlo algorithm?",
          "options": [
            "Las Vegas uses more memory",
            "Las Vegas is always correct but may run longer; Monte Carlo always finishes but may be wrong",
            "Monte Carlo cannot use randomness",
            "Las Vegas requires a CSPRNG"
          ],
          "answer": 1,
          "explain": "The trade is between certainty and time. Randomised quicksort is Las Vegas; Miller-Rabin with random bases is Monte Carlo."
        }
      ],
      "quickbytes": [
        "StdRng::seed_from_u64 for reproducibility; rand::rng() for production entropy.",
        "Never use a seeded PRNG for tokens or salts: use the OS CSPRNG.",
        "Reservoir sampling: replace reservoir[j] when random_range(0..=i) < k.",
        "select_nth_unstable gives top-k or percentiles in expected O(n) with no full sort."
      ],
      "production": [
        "Randomised tests and simulations take an explicit seed that is logged on failure.",
        "Security-sensitive randomness comes from a CSPRNG, never from StdRng.",
        "Sampling and shuffle routines are distribution-tested over many runs.",
        "Las Vegas loops have a retry or time bound and return a typed error on exhaustion."
      ],
      "crates": [
        "rand",
        "std"
      ],
      "github": [
        {
          "name": "rust-random/rand",
          "url": "https://github.com/rust-random/rand"
        }
      ],
      "pitfall": "Shuffling with j drawn from 0..i instead of 0..=i: the permutation looks random and passes a single manual check, but statistical tests show a clear bias toward the original order.",
      "resources": [
        {
          "title": "rand 0.10: Rng, random_range, and seeding",
          "url": "https://docs.rs/rand/latest/rand/",
          "kind": "docs"
        },
        {
          "title": "StdRng: a reproducible, seedable generator",
          "url": "https://docs.rs/rand/latest/rand/rngs/struct.StdRng.html",
          "kind": "docs"
        },
        {
          "title": "rust-random/rand repository",
          "url": "https://github.com/rust-random/rand",
          "kind": "repo"
        },
        {
          "title": "Weighted Reservoir Sampling from Distributed Streams",
          "url": "https://arxiv.org/abs/1904.04126",
          "kind": "paper"
        }
      ]
    },
    {
      "id": "a20",
      "title": "Problem-solving patterns: constraints, prefixes, and windows",
      "minutes": 100,
      "level": "industry",
      "goal": "Read constraints to choose a complexity class, then apply prefix sums, difference arrays, and sliding windows as reusable transformations.",
      "sections": [
        {
          "h": "The constraints tell you the algorithm",
          "p": [
            "Before designing anything, read n and the time limit. n up to 20 suggests exponential with pruning or bitmask DP; n up to 5,000 suggests O(n^2); n up to 2 * 10^5 suggests O(n log n); n up to 10^7 suggests O(n) with a small constant. These are not interview tricks - they are the same arithmetic you do when deciding whether a per-request sort fits a latency budget.",
            "Write the budget down before coding: input size, target latency, and the resulting operations per second. A service handling 10,000 requests per second with a 50 ms budget has 500,000 operation-slots per request if each operation is a nanosecond, which rules out anything quadratic on a 1,000-element input. The constraint table turns a vague requirement into a decision you can defend in review."
          ],
          "list": [
            "n <= 20: 2^n subsets, bitmask DP, backtracking with pruning",
            "n <= 5,000: O(n^2) is fine; 25 million operations is milliseconds",
            "n <= 200,000: O(n log n) only; sorting, heaps, binary search per element",
            "n <= 10,000,000: single-pass O(n), streaming, no per-element allocation"
          ]
        },
        {
          "h": "Prefix sums and difference arrays",
          "p": [
            "A prefix sum array answers range-sum queries in O(1) after O(n) preprocessing: sum(l..r) = prefix[r] - prefix[l]. The same construction answers range XOR, range product with modular arithmetic, and counting queries over a static array. It costs one extra array and one subtraction per query, which is hard to beat with any data structure.",
            "The difference array is the dual: to add a value to a range, record +delta at l and -delta at r+1, then take a prefix sum to materialise the array. Applying m range updates to n elements drops from O(nm) to O(n + m), which is the difference between a batch job that finishes and one that times out. A 2D difference array does the same for submatrix updates, using four corner marks and a double prefix sum."
          ],
          "code": `/// Materialise m range additions on n slots in O(n + m).
pub fn range_additions(n: usize, updates: &[(usize, usize, i64)]) -> Vec<i64> {
    let mut diff = vec![0i64; n + 1];
    for &(l, r, delta) in updates {
        assert!(l <= r && r < n, "range out of bounds");
        diff[l] += delta;
        diff[r + 1] -= delta;
    }

    let mut values = vec![0i64; n];
    let mut running = 0i64;
    for i in 0..n {
        running += diff[i];
        values[i] = running;
    }
    values
}

/// Prefix sums: O(1) range queries after O(n) preprocessing.
pub struct PrefixSum {
    prefix: Vec<i64>,
}

impl PrefixSum {
    pub fn new(values: &[i64]) -> Self {
        let mut prefix = Vec::with_capacity(values.len() + 1);
        prefix.push(0);
        for &v in values {
            prefix.push(prefix.last().copied().unwrap() + v);
        }
        Self { prefix }
    }

    /// Sum of values[l..r].
    pub fn range(&self, l: usize, r: usize) -> i64 {
        self.prefix[r] - self.prefix[l]
    }
}`,
          "tip": "Size the difference array n + 1 so the r + 1 mark at the last index is still in bounds; the extra cell is never read."
        },
        {
          "h": "Sliding window: a two-pointer invariant",
          "p": [
            "A sliding window maintains a contiguous range [left, right) plus enough aggregate state to answer the question - a sum, a frequency map, a count of distinct values. Expand right, and shrink left while the window violates the constraint. Each index enters and leaves once, so the whole scan is O(n) even though the nested while loop looks quadratic.",
            "The pattern applies when the predicate is monotone in the window size: if [l, r) is valid then every sub-window is valid. Longest substring without repeats, minimum window containing a set, and at-most-k-distinct all fit. When the predicate is not monotone - sums with negative numbers, for instance - the window is invalid and you need prefix sums plus a map instead. Recognising that difference is the skill."
          ],
          "code": `/// Longest window with at most k distinct values. O(n) with a frequency map.
pub fn longest_at_most_k_distinct(xs: &[u32], k: usize) -> usize {
    use std::collections::HashMap;

    let mut counts: HashMap<u32, usize> = HashMap::new();
    let mut best = 0usize;
    let mut left = 0usize;

    for right in 0..xs.len() {
        *counts.entry(xs[right]).or_insert(0) += 1;

        while counts.len() > k {
            let value = xs[left];
            let entry = counts.get_mut(&value).expect("present while in window");
            *entry -= 1;
            if *entry == 0 {
                counts.remove(&value);
            }
            left += 1;
        }
        best = best.max(right - left + 1);
    }
    best
}

fn main() {
    assert_eq!(longest_at_most_k_distinct(&[1, 2, 1, 2, 3], 2), 4);
    assert_eq!(longest_at_most_k_distinct(&[1, 2, 3, 4], 1), 1);
    println!("ok");
}`,
          "tip": "Remove keys when their count reaches zero, otherwise the map size, and the while condition, stop reflecting the window."
        },
        {
          "h": "Model the problem as a graph, then reuse the toolkit",
          "p": [
            "Many problems that do not mention graphs become BFS once you name the states. Word-ladder puzzles: nodes are words, edges are one-letter changes. Minimum operations to transform a number: nodes are values, edges are allowed operations. Course prerequisites: a DAG with topological order. The modelling step is choosing the node set and the edge relation so that the answer is a traversal result, not a bespoke algorithm.",
            "The same reuse applies to the other patterns. A dependency problem is a topological sort; a matching problem is bipartite matching; a scheduling problem is often weighted interval scheduling or a greedy with a proof. Working with a small library of patterns - prefix sums, windows, binary search on answer, heap top-k, graph traversal, DP on intervals - covers most problems you will meet, and the remaining ones are usually a combination of two of them."
          ],
          "list": [
            "Write the state graph explicitly before coding BFS over it",
            "Check whether the answer is monotone: if so, binary search it",
            "Check whether the input is static: prefix sums beat segment trees",
            "Check whether the problem is a known reduction before inventing an algorithm"
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement `range_additions(n, updates)` with a difference array and `PrefixSum` with O(1) range queries. Then implement `longest_at_most_k_distinct` and verify all three on small hand-checked inputs.",
        "starter": "pub fn range_additions(n: usize, updates: &[(usize, usize, i64)]) -> Vec<i64> {\n    todo!()\n}\n\npub struct PrefixSum {\n    prefix: Vec<i64>,\n}\n\nimpl PrefixSum {\n    pub fn new(values: &[i64]) -> Self { todo!() }\n    pub fn range(&self, l: usize, r: usize) -> i64 { todo!() }\n}",
        "hint": "The difference array marks +delta at l and -delta at r+1, then a running sum materialises values. PrefixSum stores n+1 entries with prefix[0] = 0 so range(l, r) is prefix[r] - prefix[l].",
        "solution": `pub fn range_additions(n: usize, updates: &[(usize, usize, i64)]) -> Vec<i64> {
    let mut diff = vec![0i64; n + 1];
    for &(l, r, delta) in updates {
        assert!(l <= r && r < n);
        diff[l] += delta;
        diff[r + 1] -= delta;
    }
    let mut values = vec![0i64; n];
    let mut running = 0i64;
    for i in 0..n {
        running += diff[i];
        values[i] = running;
    }
    values
}

pub struct PrefixSum {
    prefix: Vec<i64>,
}

impl PrefixSum {
    pub fn new(values: &[i64]) -> Self {
        let mut prefix = Vec::with_capacity(values.len() + 1);
        prefix.push(0);
        for &v in values {
            let last = *prefix.last().unwrap();
            prefix.push(last + v);
        }
        Self { prefix }
    }

    pub fn range(&self, l: usize, r: usize) -> i64 {
        self.prefix[r] - self.prefix[l]
    }
}

pub fn longest_at_most_k_distinct(xs: &[u32], k: usize) -> usize {
    use std::collections::HashMap;

    if k == 0 {
        return 0;
    }
    let mut counts: HashMap<u32, usize> = HashMap::new();
    let mut best = 0usize;
    let mut left = 0usize;

    for right in 0..xs.len() {
        *counts.entry(xs[right]).or_insert(0) += 1;
        while counts.len() > k {
            let value = xs[left];
            let entry = counts.get_mut(&value).unwrap();
            *entry -= 1;
            if *entry == 0 {
                counts.remove(&value);
            }
            left += 1;
        }
        best = best.max(right - left + 1);
    }
    best
}

fn main() {
    let updates = [(0, 2, 5), (1, 3, -2), (4, 4, 7)];
    assert_eq!(range_additions(6, &updates), vec![5, 3, 3, -2, 7, 0]);

    let prefix = PrefixSum::new(&[3, 1, 4, 1, 5, 9]);
    assert_eq!(prefix.range(0, 6), 23);
    assert_eq!(prefix.range(2, 4), 5);

    assert_eq!(longest_at_most_k_distinct(&[1, 2, 1, 2, 3], 2), 4);
    assert_eq!(longest_at_most_k_distinct(&[1, 2, 3], 0), 0);
    println!("ok");
}`
      },
      "questions": [
        {
          "q": "A problem states n <= 200,000 and a one-second limit. Which complexity class is the target?",
          "options": [
            "O(n^2)",
            "O(n log n)",
            "O(n^3)",
            "O(2^n)"
          ],
          "answer": 1,
          "explain": "Roughly 10^8 simple operations fit in a second. n^2 at 200,000 is 4 * 10^10, far too slow; n log n is about 3.6 * 10^6, comfortable."
        },
        {
          "q": "Why does a difference array make m range updates cost O(n + m) instead of O(nm)?",
          "options": [
            "It stores the array in a compressed format",
            "Each update writes two boundary marks, and one prefix pass applies all of them",
            "It uses a balanced tree internally",
            "It batches updates into a queue"
          ],
          "answer": 1,
          "explain": "The marks at l and r+1 cancel outside the range when summed. A single prefix pass over the marks materialises every update at once."
        },
        {
          "q": "When does a sliding window stop being valid?",
          "options": [
            "When the array is not sorted",
            "When the window predicate is not monotone in window size, for example sums with negative values",
            "When k is larger than the array",
            "When the answer requires a map"
          ],
          "answer": 1,
          "explain": "The two-pointer shrink argument assumes that removing elements can only help. With mixed signs, a larger window can become valid again, so the invariant fails."
        }
      ],
      "quickbytes": [
        "Read n first: 20 means exponential, 5,000 means quadratic, 200,000 means n log n.",
        "Prefix sums trade O(n) memory for O(1) range queries on static data.",
        "Difference arrays turn m range updates into O(n + m) with two marks per update.",
        "A sliding window needs a monotone predicate; negative values usually break it."
      ],
      "production": [
        "Each hot path states its operation budget and the input size it is sized for.",
        "Prefix structures are built once per batch, not per query.",
        "Range updates validate l <= r < n at the boundary, not in the inner loop.",
        "Window algorithms document their monotonicity assumption and test a breaking input."
      ],
      "crates": [
        "std",
        "indexmap",
        "smallvec"
      ],
      "github": [
        {
          "name": "indexmap-rs/indexmap",
          "url": "https://github.com/indexmap-rs/indexmap"
        },
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        }
      ],
      "pitfall": "Using a sliding window on an array with negative values because the positive-only version passed: the shrink condition no longer implies the window is optimal, and the answer is wrong on a quarter of real inputs.",
      "resources": [
        {
          "title": "indexmap: insertion-ordered map for window frequency state",
          "url": "https://docs.rs/indexmap/latest/indexmap/",
          "kind": "docs"
        },
        {
          "title": "indexmap-rs/indexmap repository",
          "url": "https://github.com/indexmap-rs/indexmap",
          "kind": "repo"
        },
        {
          "title": "std::collections — maps, sets, and their iteration order",
          "url": "https://doc.rust-lang.org/std/collections/index.html",
          "kind": "docs"
        },
        {
          "title": "Algorithms Course: graph theory and problem patterns",
          "url": "https://www.youtube.com/watch?v=09_LlHjoEiY",
          "kind": "video"
        }
      ]
    }
  ]
};
