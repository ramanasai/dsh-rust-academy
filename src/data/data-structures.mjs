/**
 * Data structures in Rust track.
 *
 * Authored for the Rust Academy plugin. Every lesson is plain JSON-compatible
 * data consumed by src/app.js through build.mjs.
 */
export default {
  "key": "data-structures",
  "prefix": "b",
  "title": "Data structures in Rust",
  "blurb": "How the containers actually work, when the standard library is wrong for the job, and how to build safe ones.",
  "level": "industry",
  "project": {
    "title": "Capstone: a production cache library",
    "brief": "Build the cache crate you would actually ship: LRU and LFU eviction behind one policy trait, per-entry TTL with lazy and active expiry, single-flight loading so a miss stampede collapses into one upstream call, and metrics that expose hit ratio, evictions, and load latency. It has to be correct under concurrency, proven with loom, and fast enough to justify itself with criterion numbers.",
    "deliverables": [
      "Eviction policies (LRU and LFU) behind one trait, with deterministic tests for eviction order and a hard capacity bound.",
      "Per-entry TTL with lazy expiry on read plus a bounded active-expiry sweep, tested against a controllable clock.",
      "Single-flight loading that collapses concurrent misses for one key into a single upstream call, with cancellation safety.",
      "A concurrent implementation with sharded state and loom models covering the single-flight and eviction paths.",
      "Criterion benchmarks reporting hit ratio, p50/p99 get latency, and load amplification against a naive RwLock<HashMap> baseline."
    ],
    "stack": [
      "hashbrown",
      "parking_lot",
      "loom",
      "moka",
      "criterion"
    ]
  },
  "lessons": [
    {
      "id": "b01",
      "n": 1,
      "title": "Vec internals: capacity, growth, invalidation",
      "minutes": 60,
      "level": "core",
      "goal": "Explain what Vec's three words mean, when it reallocates, why every reallocation invalidates outstanding pointers, and how to keep spare capacity from leaking into your memory profile.",
      "sections": [
        {
          "h": "Three words, one allocation",
          "p": [
            "Vec<T> is a pointer, a capacity, and a length: 24 bytes on a 64-bit target regardless of how large T is. The allocation holds capacity slots; only the first length of them are initialised. Everything else follows from that split. len() and capacity() are field reads, and push only touches the allocator when len == capacity.",
            "Growth is amortised. When the buffer is full, RawVec asks for max(2 * capacity, required) and copies the live elements into the new block. Doubling makes n pushes cost O(n) in total, but any individual push may memcpy the entire buffer, which is a latency spike that shows up in p99 even when the average looks flat."
          ],
          "list": [
            "Vec::with_capacity(n) removes every reallocation for a known lower bound of n pushes",
            "len() <= capacity() always; the spare slots are uninitialised memory, not zeroed memory",
            "Zero-sized types get capacity usize::MAX and never allocate at all",
            "shrink_to_fit is a request to the allocator, not a guarantee that capacity will drop"
          ],
          "tip": "Size hot vectors with with_capacity before the first push, not after the tenth reallocation.",
          "code": "use std::mem::size_of;\n\nfn main() {\n    // The Vec struct is three machine words, whatever T is.\n    assert_eq!(size_of::<Vec<u8>>(), 3 * size_of::<usize>());\n    assert_eq!(size_of::<Vec<[u8; 1024]>>(), 3 * size_of::<usize>());\n\n    // Watch the growth curve: 4, 8, 16, ... for small elements.\n    let mut v: Vec<u32> = Vec::new();\n    let mut growth = Vec::new();\n    for i in 0..1_000u32 {\n        if v.len() == v.capacity() {\n            growth.push((i, v.capacity()));\n        }\n        v.push(i);\n    }\n    assert!(growth.len() <= 10, \"doubling should need ~9 reallocations\");\n    println!(\"reallocations: {growth:?}\");\n\n    // Pre-sizing takes the allocator out of the loop entirely.\n    let mut exact = Vec::with_capacity(1_000);\n    for i in 0..1_000u32 {\n        exact.push(i);\n    }\n    assert_eq!(exact.len(), exact.capacity());\n}"
        },
        {
          "h": "Reallocation invalidates every pointer",
          "p": [
            "A reallocation moves the buffer, so every &T, &mut T, and raw pointer into it dangles. The borrow checker prevents the safe version: pushing while a reference into the vector is alive is a compile error, which is why the classic C++ vector-invalidation bug is rare in ordinary Rust.",
            "Unsafe code does not get that protection. If you stash Vec::as_ptr(v) in a struct and later push, the allocation can move or be freed while the pointer survives. The rule is blunt: re-derive any raw pointer into a Vec after any operation that may grow it, or freeze the allocation into a Box<[T]> before handing pointers out."
          ],
          "code": "fn main() {\n    // O(1) removal when order does not matter: the last element fills the hole.\n    let mut v = vec![10, 20, 30, 40];\n    assert_eq!(v.swap_remove(1), 20);\n    assert_eq!(v, [10, 40, 30]);\n\n    // O(n) removal that preserves order: everything after the hole shifts left.\n    let mut v = vec![10, 20, 30, 40];\n    assert_eq!(v.remove(1), 20);\n    assert_eq!(v, [10, 30, 40]);\n\n    // drain() empties the vector without releasing the allocation.\n    let mut buf: Vec<u8> = Vec::with_capacity(1024);\n    buf.extend_from_slice(b\"hello\");\n    let drained: Vec<u8> = buf.drain(..).collect();\n    assert_eq!(&drained[..], &b\"hello\"[..]);\n    assert_eq!(buf.len(), 0);\n    assert_eq!(buf.capacity(), 1024);\n}"
        },
        {
          "h": "Capacity you never meant to keep",
          "p": [
            "Vectors grow geometrically and never shrink on their own. A request buffer that peaked at 4 MiB keeps 4 MiB for as long as it lives, so a scratch Vec stored in a long-lived struct becomes a slow leak. Use shrink_to_fit when the peak is genuinely behind you, or keep one reusable buffer and call clear(), which deliberately retains capacity.",
            "The opposite mistake is cloning a slice into a fresh Vec when a Box<[T]> or Arc<[T]> would do. into_boxed_slice trims spare capacity and drops a word of indirection; Arc<[T]> additionally makes clones O(1) and the contents immutable, which is usually what a config or lookup table wants."
          ],
          "tip": "clear() keeps capacity, shrink_to_fit() may reallocate, into_boxed_slice() always trims."
        }
      ],
      "exercise": {
        "prompt": "Write a function that builds a Vec<u32> of the first n squares without a single reallocation after the initial one, asserts the buffer is exactly full, and returns a Box<[u32]> with no spare capacity.",
        "starter": "fn squares(n: usize) -> Box<[u32]> {\n    // 1. allocate once, with the exact final size\n    // 2. fill without triggering growth\n    // 3. trim to a boxed slice\n    unimplemented!()\n}\n\nfn main() {\n    let s = squares(1_000);\n    println!(\"{} values, first = {}\", s.len(), s[0]);\n}",
        "hint": "Vec::with_capacity(n) then push in a loop; assert len == capacity before into_boxed_slice, which consumes the Vec and drops any spare capacity.",
        "solution": "fn squares(n: usize) -> Box<[u32]> {\n    let mut v = Vec::with_capacity(n);\n    for i in 0..n {\n        let i = i as u32;\n        v.push(i * i);\n    }\n    // No reallocation happened because capacity was exact from the start.\n    assert_eq!(v.len(), v.capacity());\n    v.into_boxed_slice()\n}\n\nfn main() {\n    let s = squares(1_000);\n    assert_eq!(s.len(), 1_000);\n    assert_eq!(s[31], 961);\n    assert_eq!(s[999], 999 * 999);\n\n    // A boxed slice has nowhere to hide spare capacity.\n    let empty_extra = squares(0);\n    assert!(empty_extra.is_empty());\n}"
      },
      "questions": [
        {
          "q": "A Vec<u8> has len 10 and capacity 16. How many bytes does the Vec value itself occupy on a 64-bit target?",
          "options": [
            "24 bytes: pointer, capacity, length",
            "16 bytes: pointer and length",
            "10 bytes, one per initialised element",
            "26 bytes: the allocation plus its header"
          ],
          "answer": 0,
          "explain": "Vec is a RawVec (pointer + capacity) plus a usize length. The elements live in a separate heap allocation, so the struct size does not depend on T."
        },
        {
          "q": "Which operation can leave a raw pointer previously obtained from Vec::as_ptr dangling?",
          "options": [
            "push when len == capacity",
            "get(0)",
            "len()",
            "iter().count()"
          ],
          "answer": 0,
          "explain": "Growing may reallocate and move the buffer, freeing the old block. Everything else only reads the header or existing elements and cannot invalidate pointers."
        },
        {
          "q": "You call clear() on a 1 MiB Vec<u8> that is reused per request. What happens to the 1 MiB allocation?",
          "options": [
            "It is retained; clear only sets len to 0",
            "It is freed immediately",
            "It is zeroed and kept",
            "It is halved on every clear"
          ],
          "answer": 0,
          "explain": "clear() drops the elements and sets the length to zero, but keeps capacity so the next request does not allocate. shrink_to_fit or dropping the Vec releases it."
        }
      ],
      "quickbytes": [
        "clear() keeps the allocation; shrink_to_fit() may return it; into_boxed_slice() always trims.",
        "Prefer swap_remove for order-insensitive deletes: O(1) instead of an O(n) memmove.",
        "A push can memcpy the whole buffer, so keep growth out of latency-critical paths with with_capacity."
      ],
      "production": [
        "Never hold a raw pointer into a Vec across a call that can push; re-derive it or store an index.",
        "Cap request-scoped buffers at a measured size, shrink after a documented peak, and check both with dhat allocation counts and a criterion benchmark.",
        "Count allocations per request in CI (dhat or a counting allocator); a missing with_capacity is invisible in wall-clock tests.",
        "Return Box<[T]> or Arc<[T]> for immutable data that outlives the function that built it."
      ],
      "crates": [
        "dhat",
        "criterion"
      ],
      "github": [
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        }
      ],
      "pitfall": "A long-lived scratch buffer keeps the peak capacity of the largest request it ever saw, so one 4 MiB upload pins 4 MiB per worker for the process lifetime.",
      "resources": [
        {
          "title": "std::vec::Vec API reference",
          "url": "https://doc.rust-lang.org/std/vec/struct.Vec.html",
          "kind": "docs"
        },
        {
          "title": "rust-lang/rust: the standard library source",
          "url": "https://github.com/rust-lang/rust",
          "kind": "repo"
        },
        {
          "title": "fasterthanlime: Rust systems programming videos",
          "url": "https://www.youtube.com/@fasterthanlime",
          "kind": "video"
        }
      ]
    },
    {
      "id": "b02",
      "n": 2,
      "title": "HashMap: SwissTable groups and hasher choice",
      "minutes": 75,
      "level": "core",
      "goal": "Read hashbrown's probe sequence, size a table from its 7/8 load factor, and pick a hasher that is either DoS-resistant or fast, never accidentally both.",
      "sections": [
        {
          "h": "Open addressing, sixteen slots at a time",
          "p": [
            "std::collections::HashMap is hashbrown: open addressing with linear probing over groups of 16 slots. Each slot carries a control byte holding a 7-bit tag or one of EMPTY and DELETED. A lookup hashes once, uses the top bits to pick a group, and compares sixteen tags with SIMD before it ever touches a key.",
            "The table grows at 7/8 load, so capacity() is already padded: a map with capacity n holds roughly 0.875n entries before it doubles and rehashes everything. with_capacity(entries) picks the smallest bucket count that keeps the requested entries under that threshold, which is almost always what you want instead of with_capacity(bytes)."
          ],
          "list": [
            "One hash per operation; 7-bit tags reject most candidates before any key comparison",
            "Deletion writes a DELETED tombstone, so heavy insert/remove churn lengthens probe runs until the next resize",
            "Iteration order is arbitrary and changes on resize, so never persist it or depend on it in tests",
            "Budget roughly key + value + one control byte per entry, times 8/7, before you size a shard"
          ],
          "tip": "Size from entries, not bytes: capacity() is already inflated for the 7/8 load factor."
        },
        {
          "h": "The hasher is a security decision",
          "p": [
            "std's RandomState is SipHash-1-3 with per-process random keys. It is deliberately not the fastest option because it must resist hash flooding: an attacker who chooses keys should not be able to force collisions and turn O(1) lookups into O(n) scans. That property is why the default is slow on short string keys.",
            "hashbrown 0.17 defaults to foldhash instead, which is much faster and not collision-resistant. That is the right default for internal keys such as u64 ids and enum discriminants, and the wrong one for anything a client controls. Pick the hasher per map and write down why: the choice is a trust boundary, not a micro-optimisation."
          ],
          "code": "use std::collections::HashMap;\n\nfn main() {\n    // Entries, not bytes: with_capacity(1_000) never rehashes for 1_000 inserts.\n    let mut counts: HashMap<String, u64> = HashMap::with_capacity(1_000);\n    assert!(counts.capacity() >= 1_000);\n\n    for word in [\"red\", \"blue\", \"red\", \"green\", \"red\"] {\n        *counts.entry(word.to_string()).or_insert(0) += 1;\n    }\n    assert_eq!(counts[\"red\"], 3);\n\n    // entry() hashes once and hands back a handle to the slot.\n    counts\n        .entry(\"red\".to_string())\n        .and_modify(|c| *c += 100)\n        .or_insert(1);\n    assert_eq!(counts[\"red\"], 103);\n\n    // or_insert_with_key builds the value from the key without cloning first.\n    let mut label: HashMap<u32, String> = HashMap::new();\n    label.entry(7).or_insert_with_key(|k| format!(\"id-{k}\"));\n    assert_eq!(label[&7], \"id-7\");\n\n    println!(\"{} entries in {} buckets\", counts.len(), counts.capacity());\n}"
        },
        {
          "h": "Entry API: one probe instead of two",
          "p": [
            "get followed by insert hashes twice and probes twice. entry() hashes once and returns a handle to the occupied or vacant slot, so or_insert, and_modify, and or_insert_with_key all run on a single probe. For per-event counters at millions of events per second that halves the map cost.",
            "The subtle part is that and_modify never inserts and or_insert never overwrites, so chaining them is a hit/miss branch without a second lookup. The occupied and vacant entry types also expose the slot directly, which is how you update in place without moving a large value out and back in."
          ],
          "tip": "If you write get() and then insert(), you are paying for two probes and one race."
        }
      ],
      "exercise": {
        "prompt": "Build a top-k word counter over a fixed slice of words: pre-size the map, count with exactly one entry() lookup per word, then return the k most frequent words sorted by count descending and word ascending.",
        "starter": "use std::collections::HashMap;\n\nfn top_k(words: &[&str], k: usize) -> Vec<(String, u64)> {\n    // 1. pre-size the map from words.len()\n    // 2. exactly one entry() lookup per word\n    // 3. sort by count desc, then word asc; truncate to k\n    unimplemented!()\n}\n\nfn main() {\n    let words = [\"b\", \"a\", \"b\", \"c\", \"a\", \"b\"];\n    assert_eq!(top_k(&words, 2), vec![(\"b\".to_string(), 3), (\"a\".to_string(), 2)]);\n}",
        "hint": "HashMap::with_capacity(words.len()); *counts.entry(w.to_string()).or_insert(0) += 1; then collect and sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0))).",
        "solution": "use std::collections::HashMap;\n\nfn top_k(words: &[&str], k: usize) -> Vec<(String, u64)> {\n    let mut counts: HashMap<String, u64> = HashMap::with_capacity(words.len());\n    for w in words {\n        *counts.entry((*w).to_string()).or_insert(0) += 1;\n    }\n\n    let mut ranked: Vec<(String, u64)> = counts.into_iter().collect();\n    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));\n    ranked.truncate(k);\n    ranked\n}\n\nfn main() {\n    let words = [\"b\", \"a\", \"b\", \"c\", \"a\", \"b\"];\n    assert_eq!(\n        top_k(&words, 2),\n        vec![(\"b\".to_string(), 3), (\"a\".to_string(), 2)]\n    );\n    assert_eq!(top_k(&words, 0).len(), 0);\n}"
      },
      "questions": [
        {
          "q": "A HashMap reports capacity() == 112. Roughly how many entries can it hold before the next resize?",
          "options": [
            "About 98, because the table grows at 7/8 load",
            "Exactly 112",
            "About 56, because of the 0.5 load factor",
            "Unlimited until the allocator fails"
          ],
          "answer": 0,
          "explain": "hashbrown resizes at a 7/8 load factor, so 112 buckets hold about 98 entries. capacity() already reflects that headroom."
        },
        {
          "q": "Why is std's default RandomState considered a security feature rather than a performance choice?",
          "options": [
            "It uses random keys so an attacker cannot precompute colliding keys and degrade lookups to O(n)",
            "It is the fastest hasher available for strings",
            "It encrypts the stored keys",
            "It guarantees iteration order across runs"
          ],
          "answer": 0,
          "explain": "SipHash with per-process random keys makes hash flooding impractical. A fast non-random hasher lets an attacker force collisions and turn lookups into linear scans."
        },
        {
          "q": "What does entry(key).or_insert(v) save compared with get(key) followed by insert(key, v)?",
          "options": [
            "One hash and one probe, because the slot is resolved once",
            "A heap allocation per call",
            "A clone of the key",
            "Nothing; they compile to the same code"
          ],
          "answer": 0,
          "explain": "entry() hashes once and returns a handle to the resolved slot. The get-then-insert pattern hashes and probes twice, and can race between the two calls."
        }
      ],
      "quickbytes": [
        "with_capacity(n) takes an entry count, not a byte count; multiply by 8/7 mentally when sizing shards.",
        "use foldhash/ahash only for keys you control; attacker-controlled keys need SipHash or better.",
        "Chaining and_modify(...).or_insert(...) is a single-probe hit/miss branch."
      ],
      "production": [
        "Pick the hasher at the type level and document the trust boundary for each map in the codebase.",
        "Pre-size maps that are filled from a known batch; rehash storms are a common tail-latency source.",
        "Do not iterate a HashMap when output order matters; collect and sort, or use BTreeMap.",
        "Watch for tombstone accumulation in maps with sustained insert/remove churn and rebuild them periodically if probe lengths grow."
      ],
      "crates": [
        "hashbrown",
        "foldhash"
      ],
      "github": [
        {
          "name": "rust-lang/hashbrown",
          "url": "https://github.com/rust-lang/hashbrown"
        }
      ],
      "pitfall": "Swapping in a fast non-random hasher for a map keyed by client-supplied strings reopens the hash-flooding DoS that RandomState exists to prevent.",
      "resources": [
        {
          "title": "std::collections::HashMap API reference",
          "url": "https://doc.rust-lang.org/std/collections/struct.HashMap.html",
          "kind": "docs"
        },
        {
          "title": "hashbrown: SwissTable for Rust",
          "url": "https://docs.rs/hashbrown/latest/hashbrown/",
          "kind": "docs"
        },
        {
          "title": "rust-lang/hashbrown repository",
          "url": "https://github.com/rust-lang/hashbrown",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "b03",
      "n": 3,
      "title": "BTreeMap: ordered iteration and range scans",
      "minutes": 70,
      "level": "core",
      "goal": "Use the B-tree's sorted order for prefix and range queries, know when a sorted Vec beats it, and avoid byte-order surprises in string keys.",
      "sections": [
        {
          "h": "Contiguous nodes, not pointer chasing",
          "p": [
            "std's BTreeMap is a B-tree with a branching factor of 6 and up to 11 keys per node. That is an implementation detail, not a guarantee, but it explains the performance: nodes are contiguous arrays, so a lookup touches a handful of cache lines instead of following a pointer per level the way a red-black tree does.",
            "The price is paid on mutation. Every insert may split a node and memmove up to 11 keys, and every remove may merge one. That is still O(log n), with a larger constant than a hash probe. Use a B-tree when order is part of the query, not as a slower HashMap."
          ],
          "list": [
            "Keys must be Ord; the map stores them sorted at all times",
            "Height grows slowly because each node holds many keys",
            "first_key_value and last_key_value are O(log n), not O(1)",
            "Values are stable in place across inserts, unlike Vec elements across pushes"
          ],
          "tip": "If you never call range, first_key_value, or iterate in order, you probably wanted a HashMap."
        },
        {
          "h": "Ranges are the reason to be here",
          "p": [
            "range accepts any RangeBounds over the key type, including half-open and unbounded forms. Because iteration is in key order, a prefix scan is range(prefix..) plus take_while on the prefix: it stops at the first key that leaves the prefix instead of scanning the entire map. That is the primitive behind multi-tenant key spaces.",
            "String keys sort by bytes, not by human expectation, so user:10 sorts before user:9. Zero-pad numeric segments or use a fixed-width encoding if you rely on order. split_off is the other production primitive: it moves everything at or above a key into a new map without touching entries one by one."
          ],
          "code": "use std::collections::BTreeMap;\n\nfn main() {\n    let mut sessions: BTreeMap<String, u32> = BTreeMap::new();\n    for (k, v) in [\n        (\"user:0009\", 9u32),\n        (\"user:0010\", 10),\n        (\"user:0011\", 11),\n        (\"admin:1\", 1),\n    ] {\n        sessions.insert(k.to_string(), v);\n    }\n\n    // Prefix scan: start at the prefix, stop when keys leave it.\n    let prefix = \"user:\";\n    let hits: Vec<(String, u32)> = sessions\n        .range(prefix.to_string()..)\n        .take_while(|(k, _)| k.starts_with(prefix))\n        .map(|(k, v)| (k.clone(), *v))\n        .collect();\n    assert_eq!(hits.len(), 3);\n\n    // Split off everything at or above a key: no per-entry loop.\n    let tail = sessions.split_off(\"user:0010\");\n    assert_eq!(sessions.len(), 2); // admin:1 and user:0009\n    assert_eq!(tail.len(), 2);\n    assert_eq!(tail.first_key_value().map(|(_, v)| *v), Some(10));\n}"
        },
        {
          "h": "When a sorted Vec wins",
          "p": [
            "If the data is built once and read many times, a sorted Vec<(K, V)> plus binary_search_by is hard to beat: one allocation, no node headers, and a branch-predictable search over contiguous memory. It loses as soon as you insert in the middle, because that is an O(n) memmove, or when you need values to stay put.",
            "A common production shape is to build the Vec in a background task, sort it by key, and publish it behind Arc<[(K, V)]>. Readers get binary search and slice-based ranges with no per-entry allocation, and writers never touch the published copy. That is faster than a BTreeMap for static dictionaries and simpler to reason about."
          ],
          "tip": "Sort once, search many: binary search on a sorted Vec beats any node-based map when inserts are rare."
        }
      ],
      "exercise": {
        "prompt": "Given a BTreeMap<u64, String> keyed by unix timestamp, drop every entry older than cutoff with a single O(log n) structural operation rather than a per-entry loop, and report how many were removed.",
        "starter": "use std::collections::BTreeMap;\n\nfn expire_before(map: BTreeMap<u64, String>, cutoff: u64) -> (BTreeMap<u64, String>, usize) {\n    // hint: split_off keeps everything >= the key; keep that half\n    unimplemented!()\n}\n\nfn main() {\n    let mut m = BTreeMap::new();\n    for t in [10u64, 20, 30, 40] {\n        m.insert(t, format!(\"session-{t}\"));\n    }\n    let (kept, removed) = expire_before(m, 30);\n    assert_eq!(removed, 2);\n    assert_eq!(kept.len(), 2);\n}",
        "hint": "let keep = map.split_off(&cutoff); computes the removed count as the old length minus the new one, then returns keep and that count.",
        "solution": "use std::collections::BTreeMap;\n\nfn expire_before(map: BTreeMap<u64, String>, cutoff: u64) -> (BTreeMap<u64, String>, usize) {\n    let mut old = map;\n    let removed = old.len();\n    let keep = old.split_off(&cutoff); // everything >= cutoff\n    let removed = removed - keep.len();\n    (keep, removed)\n}\n\nfn main() {\n    let mut m = BTreeMap::new();\n    for t in [10u64, 20, 30, 40] {\n        m.insert(t, format!(\"session-{t}\"));\n    }\n\n    let (kept, removed) = expire_before(m, 30);\n    assert_eq!(removed, 2);\n    assert_eq!(kept.len(), 2);\n    assert_eq!(kept.first_key_value().map(|(k, _)| *k), Some(30));\n\n    // A cutoff above every key removes everything in one call.\n    let (empty, all) = expire_before(kept, u64::MAX);\n    assert_eq!(all, 2);\n    assert!(empty.is_empty());\n}"
      },
      "questions": [
        {
          "q": "Why does a prefix scan written as range(prefix..) plus take_while stop early?",
          "options": [
            "Iteration is in key order, so the first key without the prefix ends the range",
            "BTreeMap stores a prefix index",
            "range is implemented with a hash lookup",
            "take_while hashes each key and compares it to the prefix"
          ],
          "answer": 0,
          "explain": "BTreeMap iterates in sorted key order. Once a key no longer starts with the prefix, no later key can, so take_while terminates the scan."
        },
        {
          "q": "Which workload makes a sorted Vec<(K, V)> plus binary search a better choice than a BTreeMap?",
          "options": [
            "Build once from a batch, then serve many reads with no inserts",
            "Continuous insert and delete of random keys",
            "Frequent range queries over changing data",
            "Keys that are expensive to compare"
          ],
          "answer": 0,
          "explain": "A sorted Vec packs entries into one allocation and searches with binary search. Middle inserts are O(n) memmoves, so write-heavy or churn-heavy workloads still want a B-tree."
        },
        {
          "q": "You store keys \"user:9\", \"user:10\", \"user:11\" and iterate the map. What order do you get?",
          "options": [
            "user:10, user:11, user:9, because strings compare byte by byte",
            "user:9, user:10, user:11, because numbers sort numerically",
            "Insertion order",
            "Undefined, because BTreeMap does not preserve order"
          ],
          "answer": 0,
          "explain": "String ordering is lexicographic over bytes, and \"1\" < \"9\", so zero-pad numeric segments when order matters."
        }
      ],
      "quickbytes": [
        "Zero-pad numeric key segments; \"10\" sorts before \"9\" in byte order.",
        "split_off is O(log n) plus moved nodes, and is the right tool for retention windows.",
        "BTreeSet is the same structure with unit values; use it when you only need ordered membership.",
        "Need insertion order rather than sorted order? That is IndexMap, and it is a different guarantee."
      ],
      "production": [
        "Size range scans with a bound: an unbounded range over a tenant prefix can return the whole map.",
        "Encode sortable keys deliberately (zero padding, fixed width, or a sortable timestamp format).",
        "Prefer a published Arc<[(K, V)]> for static lookup tables instead of rebuilding a BTreeMap per request.",
        "Do not hold a BTreeMap behind one RwLock and expect write scalability; consider crossbeam-skiplist or sharding."
      ],
      "crates": [
        "crossbeam-skiplist",
        "indexmap"
      ],
      "github": [
        {
          "name": "rust-lang/rust",
          "url": "https://github.com/rust-lang/rust"
        }
      ],
      "pitfall": "A prefix scan written as range(prefix..prefix_end) without take_while returns every key above the prefix, so a tenant with a high prefix can read another tenant's data.",
      "resources": [
        {
          "title": "std::collections::BTreeMap API reference",
          "url": "https://doc.rust-lang.org/std/collections/struct.BTreeMap.html",
          "kind": "docs"
        },
        {
          "title": "std::collections::BTreeSet API reference",
          "url": "https://doc.rust-lang.org/std/collections/struct.BTreeSet.html",
          "kind": "docs"
        },
        {
          "title": "rust-lang/rust: the standard library source",
          "url": "https://github.com/rust-lang/rust",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "b04",
      "n": 4,
      "title": "LRU caches: O(1) recency and why get takes &mut",
      "minutes": 85,
      "level": "advanced",
      "goal": "Implement LRU as a hash map plus a recency list, explain why a cache hit mutates the cache, and choose between LRU, LFU, and SIEVE for a real workload.",
      "sections": [
        {
          "h": "Two structures, one invariant",
          "p": [
            "An LRU needs O(1) lookup and O(1) reordering. A hash map provides the lookup; a doubly linked list provides the reordering. The map stores a handle to the list node, so a hit can unlink that node and push it to the front without scanning anything. lru 0.19 keeps the nodes in a Vec with a free list, trading one indirection for zero per-entry allocations.",
            "The invariant is that the list is ordered by last use, most recent at the front. A hit moves a node to the front, an insert adds at the front, and eviction pops the back. get, put, and peek exist to maintain that order or to deliberately avoid disturbing it."
          ],
          "list": [
            "One map entry and one list node per cached value; both are updated together",
            "peek reads without promoting, which is what metrics and background scans want",
            "Capacity is a hard bound: eviction happens before the insert completes",
            "Sharding multiplies both structures and divides contention"
          ],
          "tip": "Draw the map-to-node edge before writing code; every LRU bug is a stale edge between the two structures.",
          "code": "use lru::LruCache;\nuse std::num::NonZeroUsize;\n\nfn main() {\n    let mut cache = LruCache::new(NonZeroUsize::new(3).unwrap());\n    cache.put(\"a\", 1);\n    cache.put(\"b\", 2);\n    cache.put(\"c\", 3);\n\n    // A hit promotes \"a\" to most-recently-used: this is why get needs &mut self.\n    assert_eq!(cache.get(&\"a\"), Some(&1));\n\n    // \"b\" is now the least recently used, so inserting \"d\" evicts it.\n    cache.put(\"d\", 4);\n    assert!(cache.peek(&\"b\").is_none());\n    assert_eq!(cache.len(), 3);\n\n    // peek reads without promoting, for metrics and background scans.\n    assert_eq!(cache.peek(&\"a\"), Some(&1));\n    assert_eq!(cache.peek(&\"c\"), Some(&3));\n}"
        },
        {
          "h": "Why &mut on a read is a design constraint",
          "p": [
            "get(&mut self) is honest: a hit changes the cache. The cost is that you cannot call it through a shared reference, so a sharded cache needs each shard behind its own lock - a parking_lot::RwLock per shard, typically - and every read takes the write lock on that shard. Under one hot key all readers serialise on exactly the traffic the cache was meant to absorb.",
            "Three escapes. peek for read-only callers, accepting that recency stops updating. Shard by key so contention is per shard rather than global. Or use a policy whose hits do not write at all, which is the point of SIEVE: the NSDI 2024 paper reports hits requiring no locking and twice the throughput of an optimised 16-thread LRU on web traces."
          ]
        },
        {
          "h": "LRU is a policy, not a law",
          "p": [
            "LRU is near-optimal for recency-skewed traffic and pathological for scans: one full-table pass evicts everything, because every scanned key is the most recent key. LFU protects genuinely hot entries but freezes on stale popularity unless frequencies decay. W-TinyLFU, as implemented by moka, combines a small LRU window with a frequency-based admission filter, which is why it wins on CDN-style traces.",
            "Measure the metric that matters at the size you will actually run. A policy with a 3% better hit ratio that needs an exclusive lock on every hit can still lose on throughput, and a policy that wins at 10 GiB can lose at 100 MiB because the admission window dominates."
          ],
          "tip": "If every hit takes an exclusive lock, benchmark under contention before trusting the hit-ratio chart."
        }
      ],
      "exercise": {
        "prompt": "Wrap lru::LruCache in a Cache type that tracks hits, misses, and evictions, exposes get (promoting) and peek (non-promoting), and reports the hit ratio. Evictions must be counted exactly, including on overwrite.",
        "starter": "use lru::LruCache;\nuse std::num::NonZeroUsize;\n\npub struct Cache {\n    inner: LruCache<u64, Vec<u8>>,\n    hits: u64,\n    misses: u64,\n    evictions: u64,\n}\n\nimpl Cache {\n    pub fn new(cap: usize) -> Self {\n        unimplemented!()\n    }\n\n    pub fn get(&mut self, key: u64) -> Option<&Vec<u8>> {\n        unimplemented!()\n    }\n\n    pub fn hit_ratio(&self) -> f64 {\n        unimplemented!()\n    }\n}",
        "hint": "Track len() before and after put to detect an eviction, and return Option<&Vec<u8>> from get by mapping the hit. Hit ratio is hits / (hits + misses), with a zero guard.",
        "solution": "use lru::LruCache;\nuse std::num::NonZeroUsize;\n\npub struct Cache {\n    inner: LruCache<u64, Vec<u8>>,\n    hits: u64,\n    misses: u64,\n    evictions: u64,\n}\n\nimpl Cache {\n    pub fn new(cap: usize) -> Self {\n        let cap = NonZeroUsize::new(cap).expect(\"capacity must be non-zero\");\n        Self { inner: LruCache::new(cap), hits: 0, misses: 0, evictions: 0 }\n    }\n\n    pub fn get(&mut self, key: u64) -> Option<&Vec<u8>> {\n        let before = self.inner.len();\n        let hit = self.inner.get(&key).is_some();\n        if hit {\n            self.hits += 1;\n        } else {\n            self.misses += 1;\n        }\n        debug_assert_eq!(before, self.inner.len());\n        self.inner.get(&key)\n    }\n\n    pub fn insert(&mut self, key: u64, value: Vec<u8>) {\n        let before = self.inner.len();\n        let replaced = self.inner.put(key, value).is_some();\n        if !replaced && self.inner.len() == before {\n            self.evictions += 1;\n        }\n    }\n\n    pub fn hit_ratio(&self) -> f64 {\n        let total = self.hits + self.misses;\n        if total == 0 { 0.0 } else { self.hits as f64 / total as f64 }\n    }\n}\n\nfn main() {\n    let mut c = Cache::new(2);\n    c.insert(1, vec![1]);\n    c.insert(2, vec![2]);\n    assert!(c.get(1).is_some());\n    c.insert(3, vec![3]); // evicts key 2, the least recently used\n    assert!(c.get(2).is_none());\n    assert_eq!(c.evictions, 1);\n    assert!((c.hit_ratio() - 0.5).abs() < f64::EPSILON);\n}"
      },
      "questions": [
        {
          "q": "Why does LruCache::get take &mut self instead of &self?",
          "options": [
            "A hit reorders the recency list, so the cache genuinely changes",
            "It returns a mutable reference to the value",
            "It may grow the internal hash map",
            "It is an API accident kept for backward compatibility"
          ],
          "answer": 0,
          "explain": "get promotes the entry to most-recently-used, which mutates the linked list. peek is the shared-reference variant that does not promote."
        },
        {
          "q": "A workload scans a large table once per minute through an LRU cache. What happens to the hit ratio?",
          "options": [
            "It collapses, because the scan marks every key as recently used and evicts the real working set",
            "It improves, because the scan warms the cache",
            "It is unchanged, because scans bypass the map",
            "It improves only if the scan is parallel"
          ],
          "answer": 0,
          "explain": "This is LRU's classic scan resistance failure: a sequential pass touches every key once, promoting each and flushing the entries that were actually hot."
        },
        {
          "q": "What is the main advantage of SIEVE over a lock-per-shard LRU on a read-heavy cache?",
          "options": [
            "A hit does not write, so hits need no lock",
            "It stores fewer entries",
            "It guarantees a higher hit ratio on every trace",
            "It removes the need for a hash map"
          ],
          "answer": 0,
          "explain": "SIEVE defers reordering to eviction time, keeping hits read-only. The NSDI 2024 evaluation reports higher throughput and competitive miss ratios on web traces."
        }
      ],
      "quickbytes": [
        "Use peek for metrics and peek_mut only when you intend to change the value without promoting.",
        "Capacity is a bound on entries, not bytes; a 10k-entry cache of 64 KiB values is 640 MiB.",
        "If a cache is sharded, shard the capacity too, or one shard evicts while another is half empty."
      ],
      "production": [
        "Expose hits, misses, evictions, and load latency as metrics; a cache without a hit ratio is a guess.",
        "Set capacity from a memory budget divided by the measured mean value size, then verify with the allocator.",
        "Benchmark under concurrent access to the same hot key, not only with uniform random keys.",
        "Document the eviction policy and its known failure mode (scan resistance, frequency staleness) next to the capacity constant."
      ],
      "crates": [
        "lru",
        "moka",
        "parking_lot"
      ],
      "github": [
        {
          "name": "jeromefroe/lru-rs",
          "url": "https://github.com/jeromefroe/lru-rs"
        }
      ],
      "pitfall": "Sharding an LRU without sharding its capacity gives each shard the full bound, so the process holds N times the memory you budgeted for.",
      "resources": [
        {
          "title": "lru 0.19: LruCache API",
          "url": "https://docs.rs/lru/latest/lru/",
          "kind": "docs"
        },
        {
          "title": "jeromefroe/lru-rs repository",
          "url": "https://github.com/jeromefroe/lru-rs",
          "kind": "repo"
        },
        {
          "title": "SIEVE is Simpler than LRU (NSDI 2024)",
          "url": "https://www.usenix.org/conference/nsdi24/presentation/zhang-yazhuo",
          "kind": "paper"
        }
      ]
    },
    {
      "id": "b05",
      "n": 5,
      "title": "Ring buffers: fixed-capacity FIFO without reallocation",
      "minutes": 60,
      "level": "core",
      "goal": "Keep the last N items with O(1) push and no allocation, understand VecDeque's two-slice layout, and choose overwrite-oldest versus reject-when-full deliberately.",
      "sections": [
        {
          "h": "Head, tail, and a mask",
          "p": [
            "A ring buffer stores elements in a fixed array with a head index for the next read and a tail index for the next write. Both advance modulo capacity, so writing past the end wraps to slot zero and overwrites the oldest element without moving any memory. With a power-of-two capacity the modulo becomes a bitwise AND, which is the version found in audio, telemetry, and network stacks.",
            "The cost is that the logical sequence is not always physically contiguous. The oldest element can sit near the end of the array while the newest sits at the start, so a consumer that wants one slice must handle two segments or copy. That discontinuity is the whole trade: no allocation and no memmove, at the price of a split view."
          ],
          "list": [
            "Track length explicitly, or sacrifice one slot, so full and empty are distinguishable",
            "Overwrite-oldest keeps the newest N and suits logs, metrics, and sampling",
            "Reject-when-full preserves every item and suits command and work queues",
            "A power-of-two capacity turns the wrap into a mask, not a division"
          ],
          "tip": "Decide the full policy before choosing the type; it is the behaviour that shows up in incidents."
        },
        {
          "h": "VecDeque is the growable ring",
          "p": [
            "std's VecDeque is a ring buffer that reallocates when full. as_slices() returns the two live segments without copying, make_contiguous() rotates the buffer into one slice in O(n), and push_back with pop_front is O(1) amortised. It gives you the layout, but not the bound: you enforce capacity by popping the front when len reaches the limit.",
            "The two-slice view matters when you hand data to an API that wants &[T]. If you call make_contiguous() on every write, you paid for a rotation you could have avoided by sizing the buffer once and letting it wrap forever."
          ],
          "code": "use std::collections::VecDeque;\n\n/// Keeps the newest N samples; pushing past capacity drops the oldest.\nstruct Ring {\n    buf: VecDeque<f64>,\n    cap: usize,\n}\n\nimpl Ring {\n    fn with_capacity(cap: usize) -> Self {\n        Self { buf: VecDeque::with_capacity(cap), cap }\n    }\n\n    fn push(&mut self, sample: f64) {\n        if self.buf.len() == self.cap {\n            self.buf.pop_front();\n        }\n        self.buf.push_back(sample);\n    }\n\n    fn len(&self) -> usize {\n        self.buf.len()\n    }\n\n    /// The live region may be two segments; no copy happens here.\n    fn segments(&self) -> (&[f64], &[f64]) {\n        self.buf.as_slices()\n    }\n}\n\nfn main() {\n    let mut ring = Ring::with_capacity(3);\n    for x in [1.0, 2.0, 3.0, 4.0] {\n        ring.push(x);\n    }\n    assert_eq!(ring.len(), 3);\n    let (a, b) = ring.segments();\n    let all: Vec<f64> = a.iter().chain(b).copied().collect();\n    assert_eq!(all, [2.0, 3.0, 4.0]);\n    assert!(ring.buf.capacity() >= 3);\n}"
        },
        {
          "h": "Backpressure is a product decision",
          "p": [
            "Every bounded buffer must answer one question at capacity: drop oldest, drop newest, block the producer, or fail the write. Dropping oldest keeps freshness and loses history. Dropping newest keeps history and loses the present. Blocking propagates pressure backwards, which is usually correct for a job queue and fatal inside an async runtime task.",
            "Encoding the policy in the type stops it from drifting. arraydeque 0.5 exposes ArrayDeque<[T; N], Wrapping> and the Saturating behaviour, so the bound lives in the type and the full-case behaviour is visible at the call site; heapless::Deque is the no_std equivalent."
          ],
          "tip": "An unbounded queue is not a queue with no policy; it is a queue whose policy is to grow until the OOM killer runs."
        }
      ],
      "exercise": {
        "prompt": "Implement a ring that keeps the newest N bytes of a stream and can produce a contiguous copy on demand, plus a count of how many bytes were dropped. Do not grow the allocation after construction.",
        "starter": "use std::collections::VecDeque;\n\npub struct Tail {\n    buf: VecDeque<u8>,\n    cap: usize,\n    dropped: u64,\n}\n\nimpl Tail {\n    pub fn new(cap: usize) -> Self {\n        unimplemented!()\n    }\n\n    pub fn write(&mut self, bytes: &[u8]) {\n        // keep only the newest cap bytes; count the rest as dropped\n        unimplemented!()\n    }\n\n    pub fn snapshot(&self) -> Vec<u8> {\n        unimplemented!()\n    }\n}",
        "hint": "Push byte by byte; when len == cap, pop_front and increment dropped. snapshot chains the two slices into a Vec.",
        "solution": "use std::collections::VecDeque;\n\npub struct Tail {\n    buf: VecDeque<u8>,\n    cap: usize,\n    dropped: u64,\n}\n\nimpl Tail {\n    pub fn new(cap: usize) -> Self {\n        assert!(cap > 0, \"capacity must be positive\");\n        Self { buf: VecDeque::with_capacity(cap), cap, dropped: 0 }\n    }\n\n    pub fn write(&mut self, bytes: &[u8]) {\n        for &b in bytes {\n            if self.buf.len() == self.cap {\n                self.buf.pop_front();\n                self.dropped += 1;\n            }\n            self.buf.push_back(b);\n        }\n    }\n\n    pub fn snapshot(&self) -> Vec<u8> {\n        let (a, b) = self.buf.as_slices();\n        a.iter().chain(b).copied().collect()\n    }\n\n    pub fn dropped(&self) -> u64 {\n        self.dropped\n    }\n}\n\nfn main() {\n    let mut t = Tail::new(4);\n    t.write(b\"abcdef\");\n    assert_eq!(&t.snapshot()[..], &b\"cdef\"[..]);\n    assert_eq!(t.dropped(), 2);\n    // The allocation never grew past the configured capacity.\n    assert!(t.buf.capacity() >= 4);\n}"
      },
      "questions": [
        {
          "q": "Why do ring buffers often require a power-of-two capacity?",
          "options": [
            "The wrap becomes a bitwise AND instead of a division or modulo",
            "It guarantees the buffer never fills",
            "It allows the elements to be non-Copy",
            "It removes the need for a head index"
          ],
          "answer": 0,
          "explain": "index & (cap - 1) equals index % cap when cap is a power of two, and the mask is a single instruction rather than a division."
        },
        {
          "q": "What does VecDeque::as_slices() return, and why does it matter?",
          "options": [
            "The two live segments, so you can read without copying or rotating",
            "A sorted view of the deque",
            "Two independent copies of the data",
            "The spare capacity as a mutable slice"
          ],
          "answer": 0,
          "explain": "A wrapped ring is not contiguous. as_slices exposes the two segments, and make_contiguous rotates them into one slice when an API demands a single &[T]."
        },
        {
          "q": "A metrics pipeline keeps the last 1,000 samples and never blocks. Which full policy matches?",
          "options": [
            "Overwrite the oldest sample",
            "Reject the newest sample",
            "Block the producer",
            "Grow the buffer"
          ],
          "answer": 0,
          "explain": "Freshness matters and losing old samples is acceptable, so overwrite-oldest is correct. Blocking a metrics hot path or growing without bound are both worse failure modes."
        }
      ],
      "quickbytes": [
        "VecDeque::make_contiguous is O(n); call it once, not on every push.",
        "A ring that keeps capacity in the hundreds is often faster than a Vec plus drain.",
        "Log the dropped count next to the buffer metric; silent drops look like healthy throughput."
      ],
      "production": [
        "Name the full policy in the type or constructor and test the boundary at exactly capacity + 1.",
        "Size rings from the retention window and the sample rate, not from a round number.",
        "Expose a dropped or overwritten counter; unbounded silent loss is the classic ring buffer incident.",
        "Avoid make_contiguous in a hot loop; batch consumers should accept two segments."
      ],
      "crates": [
        "arraydeque",
        "heapless"
      ],
      "github": [
        {
          "name": "andylokandy/arraydeque",
          "url": "https://github.com/andylokandy/arraydeque"
        }
      ],
      "pitfall": "A ring that distinguishes full from empty by leaving one slot unused silently holds capacity - 1 items, so a 1,024-slot buffer keeps 1,023 samples and the off-by-one survives every test that only checks the steady state.",
      "resources": [
        {
          "title": "std::collections::VecDeque API reference",
          "url": "https://doc.rust-lang.org/std/collections/struct.VecDeque.html",
          "kind": "docs"
        },
        {
          "title": "arraydeque 0.5: fixed-capacity ring buffer",
          "url": "https://docs.rs/arraydeque/latest/arraydeque/",
          "kind": "docs"
        },
        {
          "title": "andylokandy/arraydeque repository",
          "url": "https://github.com/andylokandy/arraydeque",
          "kind": "repo"
        },
        {
          "title": "fasterthanlime: Rust systems programming videos",
          "url": "https://www.youtube.com/@fasterthanlime",
          "kind": "video"
        }
      ]
    },
    {
      "id": "b06",
      "n": 6,
      "title": "Arenas and slabs: generational keys, not references",
      "minutes": 80,
      "level": "advanced",
      "goal": "Allocate many small objects cheaply with an arena, reclaim individual slots with a slab, and use versioned keys so a stale handle fails instead of touching reused memory.",
      "sections": [
        {
          "h": "Bump allocation and mass free",
          "p": [
            "A bump arena hands out memory by incrementing a pointer. Allocation is a pointer add and a bounds check, which is why arena-heavy parsers and compilers are fast: no free-list search, no per-object header, near-perfect locality. The price is that nothing is freed individually; you reset the whole arena at once, usually at the end of a request or a compile phase.",
            "bumpalo 3.20 makes the lifetime explicit: values allocated in a Bump borrow it, so the compiler refuses to let a reference outlive the arena. Reset runs no destructors, so if the allocated values own resources, use bumpalo::boxed::Box, which runs Drop when the box is dropped, or keep the arena scoped to values that need no cleanup."
          ],
          "list": [
            "One allocation per chunk instead of one per object",
            "Reset is O(1) and drops nothing, so leaks inside a request become frees at the boundary",
            "The arena must outlive every reference into it, which the lifetime encodes",
            "Do not grow a single arena across requests unless the working set truly is the request"
          ],
          "tip": "An arena turns per-object frees into one bulk free; count that as a latency win only if the objects share a lifetime."
        },
        {
          "h": "Slabs, free lists, and ABA",
          "p": [
            "A slab preallocates slots and keeps a free list: insert takes a free slot, remove returns it. That gives stable indices instead of pointers. But a bare index is unsafe the moment the slot is reused, because an old index now resolves to a different object. In a single thread that is the ABA problem without any atoms involved.",
            "The fix is a generation counter per slot. A key is (index, generation); remove bumps the generation, so a stale key compares unequal and lookup returns None. slotmap 1.1 packages exactly that, with O(1) insert, get, and remove, secondary maps for per-entity data, and optional serde support."
          ],
          "code": "use slotmap::{DefaultKey, SlotMap};\n\n#[derive(Debug)]\nstruct Node {\n    name: String,\n    parent: Option<DefaultKey>,\n    children: Vec<DefaultKey>,\n}\n\nfn main() {\n    let mut arena: SlotMap<DefaultKey, Node> = SlotMap::new();\n\n    let root = arena.insert(Node { name: \"root\".into(), parent: None, children: vec![] });\n    let child = arena.insert(Node {\n        name: \"child\".into(),\n        parent: Some(root),\n        children: vec![],\n    });\n    arena.get_mut(root).unwrap().children.push(child);\n\n    assert_eq!(arena[child].parent, Some(root));\n    assert_eq!(arena.iter().count(), 2);\n\n    let removed = arena.remove(child).unwrap();\n    assert_eq!(removed.name, \"child\");\n\n    // The key carries a generation, so it never resolves to a reused slot.\n    assert!(arena.get(child).is_none());\n    assert_eq!(arena.len(), 1);\n    assert_eq!(arena[root].children.len(), 1); // the edge is now stale\n}"
        },
        {
          "h": "Model graphs with keys",
          "p": [
            "Rust makes a graph of mutually referencing nodes awkward with references: you cannot hand out two mutable borrows into the same structure, and self-referential structs fight the borrow checker. Generational keys remove the problem by making every edge an integer pair and every traversal a lookup, the same model used by ECS engines and game worlds.",
            "The cost is one indirection and one generation check per access, plus the need for a separate collection pass for unreachable nodes. In exchange the structure is trivially serialisable, cheap to clone, and safe to mutate while iterating - collect the keys first, then mutate through them."
          ],
          "tip": "When two nodes must point at each other, store keys and a slot map, not references and RefCell."
        }
      ],
      "exercise": {
        "prompt": "Build a tree arena with slotmap where removing a node also detaches it from its parent and orphans its children. Prove that the removed key stays dead even after the slot is reused by a later insert.",
        "starter": "use slotmap::{DefaultKey, SlotMap};\n\npub struct Tree {\n    arena: SlotMap<DefaultKey, Node>,\n    root: Option<DefaultKey>,\n}\n\npub struct Node {\n    pub parent: Option<DefaultKey>,\n    pub children: Vec<DefaultKey>,\n    pub label: String,\n}\n\nimpl Tree {\n    pub fn new() -> Self { unimplemented!() }\n    pub fn add_child(&mut self, parent: DefaultKey, label: &str) -> DefaultKey { unimplemented!() }\n    pub fn remove(&mut self, key: DefaultKey) -> bool { unimplemented!() }\n}",
        "hint": "On remove: read the parent and children, detach the key from the parent's child list, clear the children's parent fields, then arena.remove(key). A later insert reuses the slot but with a new generation.",
        "solution": "use slotmap::{DefaultKey, SlotMap};\n\npub struct Node {\n    pub parent: Option<DefaultKey>,\n    pub children: Vec<DefaultKey>,\n    pub label: String,\n}\n\npub struct Tree {\n    arena: SlotMap<DefaultKey, Node>,\n    root: Option<DefaultKey>,\n}\n\nimpl Tree {\n    pub fn new() -> Self {\n        Self { arena: SlotMap::new(), root: None }\n    }\n\n    pub fn add_root(&mut self, label: &str) -> DefaultKey {\n        let key = self.arena.insert(Node {\n            parent: None,\n            children: vec![],\n            label: label.to_string(),\n        });\n        self.root = Some(key);\n        key\n    }\n\n    pub fn add_child(&mut self, parent: DefaultKey, label: &str) -> DefaultKey {\n        let key = self.arena.insert(Node {\n            parent: Some(parent),\n            children: vec![],\n            label: label.to_string(),\n        });\n        if let Some(p) = self.arena.get_mut(parent) {\n            p.children.push(key);\n        }\n        key\n    }\n\n    pub fn remove(&mut self, key: DefaultKey) -> bool {\n        let Some(node) = self.arena.remove(key) else {\n            return false; // stale or already removed\n        };\n        if let Some(parent) = node.parent {\n            if let Some(p) = self.arena.get_mut(parent) {\n                p.children.retain(|k| *k != key);\n            }\n        }\n        for child in node.children {\n            if let Some(c) = self.arena.get_mut(child) {\n                c.parent = None;\n            }\n        }\n        true\n    }\n}\n\nfn main() {\n    let mut t = Tree::new();\n    let root = t.add_root(\"root\");\n    let a = t.add_child(root, \"a\");\n    let b = t.add_child(a, \"b\");\n\n    assert!(t.remove(a));\n    assert!(!t.remove(a)); // already gone\n    assert_eq!(t.arena[b].parent, None); // orphaned, not dangling\n\n    // The slot may be reused, but the old key stays invalid.\n    let c = t.add_child(root, \"c\");\n    assert!(t.arena.get(a).is_none());\n    assert!(t.arena.get(c).is_some());\n}"
      },
      "questions": [
        {
          "q": "What does a slab slot generation counter protect against?",
          "options": [
            "A stale key resolving to a different object after the slot is reused",
            "Two threads inserting at the same time",
            "Memory exhaustion in the arena",
            "Keys being guessed by an attacker"
          ],
          "answer": 0,
          "explain": "Removal bumps the generation, so a key holding the old generation fails the equality check even when its index is reassigned. That closes the single-threaded ABA hole."
        },
        {
          "q": "What happens to values in a bumpalo::Bump when the arena is reset?",
          "options": [
            "Their destructors do not run; the memory is reclaimed in bulk",
            "Each value is dropped in reverse allocation order",
            "The arena keeps them alive until the process exits",
            "They are moved to the global allocator"
          ],
          "answer": 0,
          "explain": "Reset rewinds the bump pointer. Drop is not invoked; use bumpalo::boxed::Box when values own resources that need cleanup."
        },
        {
          "q": "Why is a graph of slot-map keys easier in Rust than a graph of references?",
          "options": [
            "Edges are values, so there is no aliasing borrow to satisfy and the graph serialises cleanly",
            "Keys are faster than pointers in every case",
            "It removes the need for a generation check",
            "It makes the graph acyclic"
          ],
          "answer": 0,
          "explain": "Keys break the borrow relationship between nodes. The trade is an indirection plus a validity check per access, and you must handle stale edges yourself."
        }
      ],
      "quickbytes": [
        "Prefer SlotMap when iteration speed matters less than insert/remove speed; DenseSlotMap iterates like a Vec.",
        "A removed key returning None is a feature: assert on it in tests instead of unwrapping blindly.",
        "Keep arenas request-scoped; a global arena is a leak with extra steps."
      ],
      "production": [
        "Never store raw indices into a slab; use the crate's key type so generations are checked.",
        "Bound arena growth per request and alert when the high-water mark keeps rising.",
        "Detach edges explicitly on removal, or a later traversal walks into keys that no longer resolve.",
        "Measure allocation count before adopting an arena; the win is in allocator traffic, not in CPU alone."
      ],
      "crates": [
        "slotmap",
        "bumpalo"
      ],
      "github": [
        {
          "name": "orlp/slotmap",
          "url": "https://github.com/orlp/slotmap"
        },
        {
          "name": "fitzgen/bumpalo",
          "url": "https://github.com/fitzgen/bumpalo"
        }
      ],
      "pitfall": "Reusing a slab index without checking the generation turns a removed node into a silent alias for a live one, so a stale edge mutates an unrelated object.",
      "resources": [
        {
          "title": "slotmap 1.1: generational slot maps",
          "url": "https://docs.rs/slotmap/latest/slotmap/",
          "kind": "docs"
        },
        {
          "title": "bumpalo 3.20: bump allocation arena",
          "url": "https://docs.rs/bumpalo/latest/bumpalo/",
          "kind": "docs"
        },
        {
          "title": "orlp/slotmap repository",
          "url": "https://github.com/orlp/slotmap",
          "kind": "repo"
        },
        {
          "title": "fitzgen/bumpalo repository",
          "url": "https://github.com/fitzgen/bumpalo",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "b07",
      "n": 7,
      "title": "Intrusive lists: links stored inside the value",
      "minutes": 80,
      "level": "advanced",
      "goal": "Eliminate per-node allocation by embedding links in your objects, and understand the ownership rules that keep intrusive containers sound.",
      "sections": [
        {
          "h": "The link lives in the object",
          "p": [
            "A normal linked list allocates a node per element and stores your value inside it. An intrusive list does the opposite: the link fields live inside your struct, and the list stores pointers to whole objects. Insert is two pointer writes, removal is an unlink, and the allocator is never called. That is why kernels, allocators, and runtimes use them.",
            "The consequence is that an object knows it is linked, and one object can sit in several lists at once if it carries several links: a run-queue link, a timer link, a wait-list link. That multi-membership is why the pattern survives in schedulers, where one task is queued to run and waiting on a timeout simultaneously."
          ],
          "list": [
            "Zero allocation per insertion; the container itself allocates nothing",
            "The object must outlive its membership, and moving it invalidates every link",
            "One object can belong to many lists, one link field per list",
            "Removal needs a cursor or a back-pointer to the embedded link"
          ],
          "tip": "Draw the ownership arrow first: a list of Box<T> owns, a list of &T only borrows, and the two have different Drop behaviour."
        },
        {
          "h": "Ownership: Box, arena, or borrow",
          "p": [
            "intrusive-collections 0.10 uses an adapter to declare the pointer type and the field holding the link. With Box<T> the list owns the objects: push_front takes the Box, iteration borrows, and dropping the list drops whatever is still linked. With a borrowed adapter the list only borrows, so the borrow checker proves the values outlive it.",
            "Moving a linked object is the failure mode. If a T lives by value and moves, every link still points at the old address. The crate rules this out by owning through Box, whose heap address is stable, or by borrowing an arena allocation that cannot move. Pin is the general statement of the same requirement for async state."
          ],
          "code": "use intrusive_collections::intrusive_adapter;\nuse intrusive_collections::{LinkedList, LinkedListLink};\n\nstruct Job {\n    link: LinkedListLink,\n    id: u32,\n    priority: u8,\n}\n\nintrusive_adapter!(JobAdapter = Box<Job>: Job { link => LinkedListLink });\n\nfn main() {\n    let mut ready = LinkedList::new(JobAdapter::new());\n    for (id, priority) in [(1u32, 3u8), (2, 9), (3, 5)] {\n        ready.push_back(Box::new(Job {\n            link: LinkedListLink::new(),\n            id,\n            priority,\n        }));\n    }\n    assert_eq!(ready.iter().map(|j| j.id).collect::<Vec<_>>(), [1, 2, 3]);\n\n    // Remove in place while walking: no allocation, no search structure.\n    let mut cursor = ready.front_mut();\n    while let Some(job) = cursor.get() {\n        let stale = job.priority < 5;\n        if stale {\n            cursor.remove();\n        } else {\n            cursor.move_next();\n        }\n    }\n    assert_eq!(ready.iter().map(|j| j.id).collect::<Vec<_>>(), [2, 3]);\n}"
        },
        {
          "h": "Where intrusive lists still win",
          "p": [
            "In a runtime, a task may sit in a run queue, a timer wheel, and a wait list at once. Copying it into three containers is impossible, and wrapping it in three Arcs adds three allocations and three atomic increments per state change. An intrusive node gives O(1) insert and remove from any of those structures with no allocation, because ownership already lives with the task.",
            "The cost is unsafe code inside the container and a rule the compiler cannot fully enforce: unlink before dropping, and never move a linked value. Libraries encode this with adapters, borrowed pointer types, and careful Drop implementations. Hand-rolled intrusive lists are where dangling-link bugs live."
          ],
          "tip": "If you only append and iterate, a Vec is faster; intrusive lists pay off when middle removal happens constantly."
        }
      ],
      "exercise": {
        "prompt": "Model a timer wheel slot: an intrusive list of Box<Timer> ordered by deadline, where firing removes the expired entries by cursor and returns how many fired. Do not allocate during the sweep.",
        "starter": "use intrusive_collections::intrusive_adapter;\nuse intrusive_collections::{LinkedList, LinkedListLink};\n\npub struct Timer {\n    pub link: LinkedListLink,\n    pub deadline_ms: u64,\n    pub fired: bool,\n}\n\nintrusive_adapter!(TimerAdapter = Box<Timer>: Timer { link => LinkedListLink });\n\npub fn sweep(list: &mut LinkedList<TimerAdapter>, now_ms: u64) -> usize {\n    // walk with a cursor; remove entries whose deadline has passed\n    unimplemented!()\n}",
        "hint": "Copy the predicate into a local bool before calling cursor.remove(), otherwise the borrow from cursor.get() is still live. remove() advances the cursor for you.",
        "solution": "use intrusive_collections::intrusive_adapter;\nuse intrusive_collections::{LinkedList, LinkedListLink};\n\npub struct Timer {\n    pub link: LinkedListLink,\n    pub deadline_ms: u64,\n    pub fired: bool,\n}\n\nintrusive_adapter!(TimerAdapter = Box<Timer>: Timer { link => LinkedListLink });\n\npub fn sweep(list: &mut LinkedList<TimerAdapter>, now_ms: u64) -> usize {\n    let mut fired = 0;\n    let mut cursor = list.front_mut();\n    while let Some(timer) = cursor.get() {\n        if timer.deadline_ms <= now_ms {\n            let mut removed = cursor.remove().expect(\"cursor points at a timer\");\n            removed.fired = true;\n            fired += 1;\n        } else {\n            cursor.move_next();\n        }\n    }\n    fired\n}\n\nfn main() {\n    let mut wheel = LinkedList::new(TimerAdapter::new());\n    for deadline_ms in [100u64, 250, 900] {\n        wheel.push_back(Box::new(Timer {\n            link: LinkedListLink::new(),\n            deadline_ms,\n            fired: false,\n        }));\n    }\n\n    let fired = sweep(&mut wheel, 300);\n    assert_eq!(fired, 2);\n    assert_eq!(wheel.iter().map(|t| t.deadline_ms).collect::<Vec<_>>(), [900]);\n}"
      },
      "questions": [
        {
          "q": "Why can one object be inserted into several intrusive collections at once?",
          "options": [
            "Each collection uses its own link field embedded in the object",
            "The object is cloned into each collection",
            "Intrusive collections share a global node pool",
            "The adapter stores a pointer to the previous collection"
          ],
          "answer": 0,
          "explain": "Links are per-collection fields inside the value. A task can carry a run-queue link and a timer link, and each list uses only its own."
        },
        {
          "q": "What breaks if a linked object is moved in memory?",
          "options": [
            "Every link pointing at the old address dangles",
            "The object is silently unlinked",
            "The list reallocates its nodes",
            "Nothing breaks; the adapter re-registers it"
          ],
          "answer": 0,
          "explain": "Intrusive links are addresses. Moving the value changes its address, so neighbours still point at the old one. Box or arena allocation keeps the address stable."
        },
        {
          "q": "What does an intrusive list save compared with Vec<T> for the same elements?",
          "options": [
            "O(1) insertion and removal at any position without moving other elements or allocating",
            "Memory per element",
            "The need for a Drop implementation",
            "Iteration speed"
          ],
          "answer": 0,
          "explain": "The win is pointer surgery instead of a memmove plus an allocation. Iteration over an intrusive list is pointer chasing and is usually slower than a Vec scan."
        }
      ],
      "quickbytes": [
        "Copy the predicate into a bool before cursor.remove(); holding the borrow from get() blocks the mutable call.",
        "Use a bumpalo arena plus a borrowed adapter when the values are already owned elsewhere.",
        "Dropping a Box<T> that is still linked is the bug the adapter type system exists to prevent."
      ],
      "production": [
        "Never move a value that is linked; allocate it in a Box or an arena whose address is stable.",
        "Keep one link field per collection the object can join, and document which lists own it.",
        "Prefer the crate adapters over hand-written unsafe link manipulation; the invariants are subtle.",
        "Add a debug assertion that the link is unlinked before drop, so double-membership fails loudly in tests."
      ],
      "crates": [
        "intrusive-collections",
        "bumpalo"
      ],
      "github": [
        {
          "name": "Amanieu/intrusive-rs",
          "url": "https://github.com/Amanieu/intrusive-rs"
        },
        {
          "name": "fitzgen/bumpalo",
          "url": "https://github.com/fitzgen/bumpalo"
        }
      ],
      "pitfall": "A list of Box<T> dropped while another structure still holds a borrowed link leaves that structure pointing into freed memory, which is why scoped collections tie lifetimes together.",
      "resources": [
        {
          "title": "intrusive-collections 0.10 guide",
          "url": "https://docs.rs/intrusive-collections/latest/intrusive_collections/",
          "kind": "docs"
        },
        {
          "title": "Amanieu/intrusive-rs repository",
          "url": "https://github.com/Amanieu/intrusive-rs",
          "kind": "repo"
        },
        {
          "title": "Jon Gjengset: Rust internals and performance streams",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ]
    },
    {
      "id": "b08",
      "n": 8,
      "title": "Skip lists: ordered maps under concurrent writes",
      "minutes": 75,
      "level": "advanced",
      "goal": "Understand the probabilistic level structure, read crossbeam-skiplist's lock-free API, and decide when a skip list beats an RwLock<BTreeMap>.",
      "sections": [
        {
          "h": "Levels instead of rotations",
          "p": [
            "A skip list is a linked list with express lanes. Every element is at level 0; each element is promoted to level 1 with probability p, to level 2 with p squared, and so on. A search starts at the top-left, moves right while the next key is smaller, and drops a level otherwise, giving expected O(log n) with no rebalancing.",
            "With p = 1/2 the average node has two pointers, the same order as a balanced tree's child pointers but without rotations. With p = 1/4 you spend about 1.33 pointers per node for shorter lanes and fewer comparisons. The constants are a tuning knob; the structure is identical whether the levels were chosen randomly or deliberately."
          ],
          "list": [
            "Expected O(log n) search, insert, and delete with high probability",
            "No rotations and no rebalancing, so writers only touch forward pointers",
            "Memory is one allocation per node plus its level array",
            "Deterministic worst case is O(n), which is why the level source must be a decent RNG"
          ],
          "tip": "The level source is part of the data structure: a biased RNG silently turns O(log n) into O(n)."
        },
        {
          "h": "Lock-free insertion",
          "p": [
            "Insertion only writes forward pointers, bottom-up, with one CAS per level. A reader that follows a stale pointer still lands on a valid node, so lookups need no lock at all. That is why skip lists show up in concurrent ordered maps where a B-tree would need a lock on every node it touches.",
            "Crossbeam's SkipMap takes &self for insert and remove and hands back an Entry that borrows the map. Removed entries stay alive under epoch-based reclamation until the last reader drops its Entry, so holding Entries across a long computation keeps memory alive even after the keys are gone."
          ],
          "code": "use crossbeam_skiplist::SkipMap;\n\nfn main() {\n    let index = SkipMap::new();\n\n    // &self, not &mut self: no lock and no exclusive borrow at the call site.\n    index.insert(30u64, \"thirty\");\n    index.insert(10u64, \"ten\");\n    index.insert(20u64, \"twenty\");\n\n    // Ordered iteration over a lock-free structure.\n    let keys: Vec<u64> = index.iter().map(|e| *e.key()).collect();\n    assert_eq!(keys, [10, 20, 30]);\n\n    // Range scan for a window of timestamps.\n    let window: Vec<u64> = index.range(15..=30).map(|e| *e.key()).collect();\n    assert_eq!(window, [20, 30]);\n\n    let entry = index.get(&20).unwrap();\n    assert_eq!(*entry.value(), \"twenty\");\n    drop(entry); // release the epoch guard so reclamation can proceed\n}"
        },
        {
          "h": "Skip list or RwLock<BTreeMap>",
          "p": [
            "The crossbeam documentation is unusually honest: skip lists are a reasonable choice when you need concurrent writes to an ordered collection, but they can be substantially slower than B-trees, and with infrequent writes a shared BTreeMap may be faster. The win is that writers never block readers and never block each other.",
            "Adopt one when the access pattern is genuinely mixed and ordered, such as a time-series index taking writes while queries scan ranges, or when a single writer lock is a measured bottleneck. Do not make it the default ordered map: it pays pointer chasing per level and one allocation per entry."
          ],
          "tip": "A skip list is a lock-free BTreeMap with worse constants; adopt it for concurrency, not for speed."
        }
      ],
      "exercise": {
        "prompt": "Build a concurrent event index keyed by timestamp using crossbeam-skiplist: insert from several threads, then query a closed range and return the payloads in order. Every entry must be fully formed when observed.",
        "starter": "use crossbeam_skiplist::SkipMap;\nuse std::sync::Arc;\n\npub fn ingest(events: &[(u64, String)]) -> Arc<SkipMap<u64, String>> {\n    // 1. share the map across scoped threads\n    // 2. insert from each thread\n    // 3. return the map\n    unimplemented!()\n}",
        "hint": "Wrap SkipMap in Arc, use std::thread::scope so borrows can be shared, and insert with &self. A range query then iterates in key order without locking.",
        "solution": "use crossbeam_skiplist::SkipMap;\nuse std::sync::Arc;\nuse std::thread;\n\npub fn ingest(events: &[(u64, String)]) -> Arc<SkipMap<u64, String>> {\n    let index = Arc::new(SkipMap::new());\n    let chunk = events.len().div_ceil(4).max(1);\n\n    thread::scope(|s| {\n        for part in events.chunks(chunk) {\n            let index = Arc::clone(&index);\n            s.spawn(move || {\n                for (ts, payload) in part {\n                    index.insert(*ts, payload.clone());\n                }\n            });\n        }\n    });\n\n    index\n}\n\nfn main() {\n    let events: Vec<(u64, String)> = (0..100u64)\n        .map(|i| (i * 10, format!(\"event-{i}\")))\n        .collect();\n\n    let index = ingest(&events);\n    assert_eq!(index.len(), 100);\n\n    let window: Vec<String> = index\n        .range(100..=300)\n        .map(|e| e.value().clone())\n        .collect();\n    assert_eq!(window.len(), 21);\n    assert_eq!(window.first().map(String::as_str), Some(\"event-10\"));\n\n    // Every entry is fully formed: no torn inserts are observable.\n    for entry in index.iter() {\n        assert!(entry.value().starts_with(\"event-\"));\n    }\n}"
      },
      "questions": [
        {
          "q": "What does the promotion probability p control in a skip list?",
          "options": [
            "The expected number of levels per node, trading memory against search comparisons",
            "The maximum number of keys",
            "The hash function used for keys",
            "Whether insertion is lock-free"
          ],
          "answer": 0,
          "explain": "A node is promoted with probability p per level, so the mean height is 1/(1-p). Smaller p means fewer pointers but longer lanes and more comparisons."
        },
        {
          "q": "Why can a reader follow a stale forward pointer in a lock-free skip list without a lock?",
          "options": [
            "Insertion publishes fully initialised nodes, and reclamation defers freeing until readers are done",
            "The map copies every entry it returns",
            "Readers retry until the pointer matches",
            "All writes take a global mutex internally"
          ],
          "answer": 0,
          "explain": "Nodes are initialised before being linked in, and epoch-based reclamation keeps removed nodes alive while any reader can still reach them."
        },
        {
          "q": "When is an RwLock<BTreeMap> likely to beat a SkipMap?",
          "options": [
            "When writes are rare and reads dominate, so the lock is rarely contended",
            "When writes are continuous from many threads",
            "When keys are strings and values are large",
            "Never; a skip list is always faster"
          ],
          "answer": 0,
          "explain": "With little write contention, the B-tree's better cache behaviour wins. The skip list advantage appears when writers must not block readers."
        }
      ],
      "quickbytes": [
        "Drop Entry handles promptly; holding them pins removed nodes via epoch reclamation.",
        "SkipMap::insert replaces an existing value and returns the old one; use entry-style APIs when the replacement must be conditional.",
        "Benchmark against RwLock<BTreeMap> before adopting: the skip list is not a drop-in speedup."
      ],
      "production": [
        "Measure with your real read/write ratio; skip lists lose to a B-tree when writes are rare.",
        "Bound the lifetime of Entry guards and never hold one across an await point.",
        "Watch memory under sustained insert/remove: reclamation lags behind deletion while readers are active.",
        "Document that ordering is by key only; equal keys collapse, which matters for low-resolution timestamps."
      ],
      "crates": [
        "crossbeam-skiplist",
        "crossbeam-epoch"
      ],
      "github": [
        {
          "name": "crossbeam-rs/crossbeam",
          "url": "https://github.com/crossbeam-rs/crossbeam"
        }
      ],
      "pitfall": "A skip list keeps every removed node alive while any reader holds an Entry, so a service that stores guards in a long-lived struct grows without bound instead of shrinking after deletes.",
      "resources": [
        {
          "title": "crossbeam-skiplist 0.1 API and guarantees",
          "url": "https://docs.rs/crossbeam-skiplist/latest/crossbeam_skiplist/",
          "kind": "docs"
        },
        {
          "title": "crossbeam-rs/crossbeam repository",
          "url": "https://github.com/crossbeam-rs/crossbeam",
          "kind": "repo"
        },
        {
          "title": "std::collections::BTreeMap for comparison",
          "url": "https://doc.rust-lang.org/std/collections/struct.BTreeMap.html",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "b09",
      "n": 9,
      "title": "Tries and FSTs: prefix search over keys",
      "minutes": 75,
      "level": "advanced",
      "goal": "Walk a path-compressed trie, build an immutable FST over sorted byte keys, and pick the right structure for autocomplete versus exact lookup.",
      "sections": [
        {
          "h": "Paths share prefixes",
          "p": [
            "A trie has one node per character, so keys that share a prefix share a path, and lookup costs O(key length) regardless of how many keys are stored. The naive version wastes memory: one node per byte, most with a single child. A radix trie compresses unary paths into an edge labelled with a substring, and an adaptive radix tree switches node layout as fan-out changes.",
            "The property that matters is that a prefix query is a walk, not a scan. Descend to the prefix node, then enumerate the subtree. No unrelated key is ever compared, so autocomplete over ten million keys costs the same as over ten thousand, modulo the size of the result set."
          ],
          "list": [
            "Lookup cost depends on key length, not on the number of keys",
            "Path compression removes chains of single-child nodes",
            "Enumeration order is lexicographic by construction",
            "Mutation and prefix enumeration are the operations that justify a trie"
          ],
          "tip": "If you only ever ask whether an exact key is present, a trie is a slower hash map with more allocations."
        },
        {
          "h": "FSTs: an immutable trie with shared suffixes",
          "p": [
            "fst 0.4 builds a finite state transducer: a trie where identical suffixes are merged into shared states. The result is a compact byte automaton that can be memory-mapped and searched without decompression. Keys must be byte strings, map values must be u64, and construction requires keys in lexicographic order.",
            "Queries are automata, not string comparisons. A Str automaton with starts_with gives prefix search, Levenshtein gives fuzzy search, and OpBuilder unions or intersects streams from several FSTs using memory proportional to the number of streams. The API is a Streamer rather than an Iterator because each key is built in a shared buffer and lent out."
          ],
          "code": "use fst::automaton::Str;\nuse fst::{IntoStreamer, Set, Streamer};\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    // Construction requires sorted, unique keys.\n    let mut words = vec![\"apple\", \"application\", \"apply\", \"banana\", \"band\"];\n    words.sort_unstable();\n\n    let set = Set::from_iter(words)?;\n\n    // Prefix search is an automaton over the transducer, not a scan.\n    let matcher = Str::new(\"app\").starts_with();\n    let mut stream = set.search(matcher).into_stream();\n    let mut hits = Vec::new();\n    while let Some(key) = stream.next() {\n        hits.push(String::from_utf8(key.to_vec())?);\n    }\n    assert_eq!(hits, [\"apple\", \"application\", \"apply\"]);\n\n    // Exact membership costs O(len(key)) and never allocates.\n    assert!(set.contains(\"banana\"));\n    assert!(!set.contains(\"appl\"));\n    Ok(())\n}"
        },
        {
          "h": "Choosing between them",
          "p": [
            "Use a mutable radix trie when the key set changes and you need prefix queries: HTTP routes, IP-prefix ACLs, symbol tables in a language server. Use an FST when the key set is built once, is large, and must be shared or memory-mapped: a dictionary, a static routing table, a search term index.",
            "Both beat a BTreeMap prefix scan when the prefix is selective, because the scan must still seek and walk. Neither beats a hash map for exact-key lookup: a trie pays per byte, a hash pays once. If every query is exact, stop here and use a HashMap."
          ],
          "tip": "Build the FST offline in sorted order and mmap it; rebuilding it per process throws away the only thing it is good at."
        }
      ],
      "exercise": {
        "prompt": "Build an FST map from sorted (word, id) pairs and implement a prefix lookup that returns ids for every key starting with a prefix, in lexicographic order. Report an error if the input is not sorted.",
        "starter": "use fst::automaton::Str;\nuse fst::{IntoStreamer, Map, MapBuilder, Streamer};\n\npub fn build(pairs: &[(&str, u64)]) -> Result<Map<Vec<u8>>, fst::Error> {\n    // MapBuilder, one insert per pair, finish into a Vec<u8>\n    unimplemented!()\n}\n\npub fn with_prefix(map: &Map<Vec<u8>>, prefix: &str) -> Vec<(String, u64)> {\n    unimplemented!()\n}",
        "hint": "MapBuilder::memory(), insert each pair in order, into_inner() returns the bytes; Map::new(bytes) reconstructs. Prefix search uses Str::new(prefix).starts_with() and into_stream().",
        "solution": "use fst::automaton::Str;\nuse fst::{IntoStreamer, Map, MapBuilder, Streamer};\n\npub fn build(pairs: &[(&str, u64)]) -> Result<Map<Vec<u8>>, fst::Error> {\n    let mut builder = MapBuilder::memory();\n    for (word, id) in pairs {\n        builder.insert(word, *id)?; // must be sorted; out-of-order is an error\n    }\n    let bytes = builder.into_inner()?;\n    Map::new(bytes)\n}\n\npub fn with_prefix(map: &Map<Vec<u8>>, prefix: &str) -> Vec<(String, u64)> {\n    let matcher = Str::new(prefix).starts_with();\n    let mut stream = map.search(matcher).into_stream();\n    let mut out = Vec::new();\n    while let Some((key, id)) = stream.next() {\n        out.push((String::from_utf8_lossy(key).into_owned(), id));\n    }\n    out\n}\n\nfn main() {\n    let map = build(&[(\"app\", 1), (\"apple\", 2), (\"apply\", 3), (\"banana\", 4)]).unwrap();\n    assert_eq!(\n        with_prefix(&map, \"app\"),\n        vec![\n            (\"app\".to_string(), 1),\n            (\"apple\".to_string(), 2),\n            (\"apply\".to_string(), 3),\n        ]\n    );\n    assert!(with_prefix(&map, \"zzz\").is_empty());\n\n    // Out-of-order keys are rejected by the builder.\n    assert!(build(&[(\"b\", 1), (\"a\", 2)]).is_err());\n}"
      },
      "questions": [
        {
          "q": "Why is prefix search on a trie faster than a prefix scan on a BTreeMap?",
          "options": [
            "It descends directly to the prefix node and enumerates only that subtree",
            "It hashes the prefix first",
            "It stores a second inverted index",
            "BTreeMap cannot store strings with a common prefix"
          ],
          "answer": 0,
          "explain": "A trie walk costs O(prefix length) to reach the subtree. A B-tree range scan must seek and then compare keys in the range, including keys that share only part of the prefix."
        },
        {
          "q": "What restriction does fst::MapBuilder impose on input?",
          "options": [
            "Keys must be inserted in lexicographic byte order, and values must be u64",
            "Keys must be unique 64-bit integers",
            "Values must be UTF-8 strings",
            "The map must fit in memory as a HashMap first"
          ],
          "answer": 0,
          "explain": "An FST is built by merging a sorted stream of byte keys into shared states. Out-of-order input is an error, and values are limited to u64."
        },
        {
          "q": "Why does fst use a Streamer trait instead of Iterator?",
          "options": [
            "Keys are built in a shared buffer and lent out, which Iterator cannot express safely",
            "Iterators cannot return errors",
            "It is faster to implement",
            "Iterators require the keys to be Copy"
          ],
          "answer": 0,
          "explain": "Iterator yields items that cannot borrow from the iterator itself. The Streamer pattern lends a key buffer per step and avoids one allocation per result."
        }
      ],
      "quickbytes": [
        "Sort and deduplicate keys before building an FST; the builder rejects out-of-order input.",
        "Memory-map a large FST instead of reading it into a Vec; the OS pages in only what the query touches.",
        "radix_trie for mutable prefix sets, fst for immutable ones you can share."
      ],
      "production": [
        "Choose the key encoding before building: FST ordering is byte order, so zero-pad numeric segments.",
        "Serve large dictionaries from an mmap rather than a per-process heap copy.",
        "Cap prefix results; a one-character prefix over a big dictionary returns nearly everything.",
        "Rebuild FSTs offline and swap them atomically; incremental mutation is not what they are for."
      ],
      "crates": [
        "fst",
        "radix_trie"
      ],
      "github": [
        {
          "name": "BurntSushi/fst",
          "url": "https://github.com/BurntSushi/fst"
        }
      ],
      "pitfall": "Building an FST from an unsorted iterator fails at build time, and a nightly job that only fails on the twenty-thousandth key is a common way to discover it in production.",
      "resources": [
        {
          "title": "fst 0.4: finite state transducers",
          "url": "https://docs.rs/fst/latest/fst/",
          "kind": "docs"
        },
        {
          "title": "BurntSushi/fst repository",
          "url": "https://github.com/BurntSushi/fst",
          "kind": "repo"
        },
        {
          "title": "Jon Gjengset: Rust internals and performance streams",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ]
    },
    {
      "id": "b10",
      "n": 10,
      "title": "Bloom filters: bits per item, false positives, no deletes",
      "minutes": 70,
      "level": "advanced",
      "goal": "Size a Bloom filter from a target false-positive rate, explain why deletion is impossible, and use one as a pre-filter that cannot change correctness.",
      "sections": [
        {
          "h": "k hashes, m bits",
          "p": [
            "A Bloom filter is m bits and k hash functions. Insert sets k bits, and a query checks the same k bits. If any is zero the key is definitely absent; if all are one it is probably present. There are no false negatives as long as bits are only ever set, which is exactly why there is no delete: clearing one key's bits would clear bits shared with other keys.",
            "For n items in m bits the false-positive rate is roughly (1 - e^(-kn/m))^k, minimised at k = (m/n) ln 2. That is about 9.6 bits per item for 1% and 14.4 bits per item for 0.1%. The rate degrades as the filter fills, so size for the final n, not for today's n."
          ],
          "list": [
            "No false negatives; a false positive is the only error mode",
            "No deletion, because bits are shared between keys",
            "No enumeration: the filter answers membership and nothing else",
            "Size for peak cardinality, since growing means rebuilding and reinserting"
          ],
          "tip": "Two decimal places of false-positive rate is a marketing number; know the bits per item you actually bought."
        },
        {
          "h": "Use it as a pre-filter",
          "p": [
            "The productive pattern is a filter in front of something expensive: an SST block read, a network round trip, a database index probe. A negative answer skips the work entirely, and a positive answer falls through to the authoritative lookup. Because a false positive only costs work you would have done anyway, the filter can never make the result incorrect - only slower when it is badly sized.",
            "fastbloom 0.17 builds from a target false-positive rate and derives all k indices from one 64-bit hash by composing its halves, which is much cheaper than hashing k times. Its AtomicBloomFilter takes &self for insert and contains, so concurrent writers do not need a lock around the whole filter."
          ],
          "code": "use fastbloom::BloomFilter;\n\nfn main() {\n    let n = 100_000u64;\n\n    // 1% target: the builder picks m and k for the expected item count.\n    // fastbloom hashes with foldhash by default; swap in .hasher(..) if you need a seeded one.\n    let mut filter = BloomFilter::with_false_pos(0.01).expected_items(n as usize);\n    for i in 0..n {\n        filter.insert(&i);\n    }\n\n    // No false negatives: every inserted key is reported present.\n    assert!((0..n).all(|i| filter.contains(&i)));\n\n    // False positives exist; measure the rate on keys never inserted.\n    let hits = (n..2 * n).filter(|i| filter.contains(i)).count();\n    let rate = hits as f64 / n as f64;\n    println!(\"measured false-positive rate: {rate:.4}\");\n    assert!(rate < 0.02, \"sizing should land near the 1% target\");\n}"
        },
        {
          "h": "Sizing is the whole job",
          "p": [
            "A filter sized for 100k items does not gracefully hold a million. The rate depends on n/m and the k chosen for the original ratio, so as bits saturate the false-positive rate climbs towards certainty and every check falls through to the expensive path. The only fix is a rebuild: allocate the larger filter, stream the keys again, swap atomically.",
            "When the key set is unbounded, either rebuild on a schedule from the upstream source of truth, or use a structure that ages: a rotating pair of filters, a cuckoo filter with deletion, or a counting Bloom filter with small counters. Each buys deletion at a cost in space or CPU, and each needs a policy for what happens when it fills."
          ],
          "tip": "A Bloom filter is a cache of negative answers; it never replaces the authoritative store."
        }
      ],
      "exercise": {
        "prompt": "Add a Bloom pre-filter to a lookup that counts disk reads: insert every key on load, then serve queries with a fast negative path. Report how many expensive lookups the filter avoided and assert that no inserted key took the negative path.",
        "starter": "use fastbloom::BloomFilter;\nuse std::collections::HashSet;\n\npub struct Filtered {\n    truth: HashSet<u64>,\n    bloom: BloomFilter,\n    pub disk_reads: u64,\n    pub avoided: u64,\n}\n\nimpl Filtered {\n    pub fn new(keys: &[u64]) -> Self {\n        unimplemented!()\n    }\n\n    pub fn get(&mut self, key: u64) -> bool {\n        unimplemented!()\n    }\n}",
        "hint": "Insert every key into the filter at construction. On get, if the filter says absent, increment avoided and return false without touching truth; otherwise count a disk read and consult the set.",
        "solution": "use fastbloom::BloomFilter;\nuse std::collections::HashSet;\n\npub struct Filtered {\n    truth: HashSet<u64>,\n    bloom: BloomFilter,\n    pub disk_reads: u64,\n    pub avoided: u64,\n}\n\nimpl Filtered {\n    pub fn new(keys: &[u64]) -> Self {\n        let mut bloom = BloomFilter::with_false_pos(0.01).expected_items(keys.len());\n        for k in keys {\n            bloom.insert(k);\n        }\n        Self {\n            truth: keys.iter().copied().collect(),\n            bloom,\n            disk_reads: 0,\n            avoided: 0,\n        }\n    }\n\n    pub fn get(&mut self, key: u64) -> bool {\n        if !self.bloom.contains(&key) {\n            self.avoided += 1;\n            return false; // definitely absent: no disk read at all\n        }\n        self.disk_reads += 1;\n        self.truth.contains(&key) // false positives fall through here\n    }\n}\n\nfn main() {\n    let keys: Vec<u64> = (0..10_000).collect();\n    let mut f = Filtered::new(&keys);\n\n    assert!(f.get(123));\n\n    // Absent keys are always reported absent, even when the filter says maybe.\n    let before = f.disk_reads;\n    for k in 0..100_000u64 {\n        assert!(!f.get(1_000_000 + k));\n    }\n\n    // Almost every absent key skipped the disk; a few false positives fell through.\n    assert!(f.avoided > 90_000);\n    assert!(f.disk_reads - before < 10_000);\n}"
      },
      "questions": [
        {
          "q": "How many bits per item does a Bloom filter need for a 1% false-positive rate?",
          "options": [
            "About 9.6",
            "About 1",
            "About 64",
            "About 4.8"
          ],
          "answer": 0,
          "explain": "The optimum is -log2(eps)/ln 2 bits per item, about 9.6 at 1% and 14.4 at 0.1%. That is the whole attraction of the structure."
        },
        {
          "q": "Why can a standard Bloom filter not support deletion?",
          "options": [
            "Bits are shared between keys, so clearing one key's bits can clear another key's evidence",
            "The hash functions are not invertible",
            "The filter stores no keys, only counts",
            "Deletion would require a second pass over the input"
          ],
          "answer": 0,
          "explain": "Each key sets k shared bits. Clearing them for one key creates false negatives for every other key that set the same bits."
        },
        {
          "q": "A Bloom pre-filter returns a false positive. What is the consequence?",
          "options": [
            "One unnecessary lookup against the authoritative store; the answer stays correct",
            "The returned value is wrong",
            "The filter must be rebuilt",
            "A false negative follows on the next query"
          ],
          "answer": 0,
          "explain": "A positive is only a hint. The authoritative lookup still runs and decides, so a false positive costs latency, never correctness."
        }
      ],
      "quickbytes": [
        "Rebuild when n reaches the size you provisioned; a saturated filter is worse than none.",
        "Do not put a Bloom filter in front of a cheap lookup; the probe costs more than the check.",
        "AtomicBloomFilter inserts through &self, which is what concurrent loaders actually need."
      ],
      "production": [
        "Record the designed n and false-positive rate next to the filter, and alert when n approaches the design point.",
        "Rebuild from the source of truth rather than trying to grow in place; there is no in-place growth.",
        "Never treat a positive as proof; the authoritative path must still run.",
        "Version the serialized filter, since fastbloom 0.17 is not compatible with earlier encodings."
      ],
      "crates": [
        "fastbloom",
        "foldhash"
      ],
      "github": [
        {
          "name": "tomtomwombat/fastbloom",
          "url": "https://github.com/tomtomwombat/fastbloom"
        }
      ],
      "pitfall": "A filter provisioned for 100k keys that receives a million inserts approaches a 100% positive rate, so every query pays the expensive path and the filter adds pure overhead.",
      "resources": [
        {
          "title": "fastbloom 0.17: Bloom filters and AtomicBloomFilter",
          "url": "https://docs.rs/fastbloom/latest/fastbloom/",
          "kind": "docs"
        },
        {
          "title": "tomtomwombat/fastbloom repository",
          "url": "https://github.com/tomtomwombat/fastbloom",
          "kind": "repo"
        },
        {
          "title": "Jon Gjengset: Rust internals and performance streams",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ]
    },
    {
      "id": "b11",
      "n": 11,
      "title": "HyperLogLog: cardinality in a few kilobytes",
      "minutes": 70,
      "level": "advanced",
      "goal": "Estimate distinct counts with bounded memory, read the register and harmonic-mean construction, and merge per-shard sketches without double counting.",
      "sections": [
        {
          "h": "Registers and ranks",
          "p": [
            "HyperLogLog hashes each element to 64 bits, uses the first p bits to choose one of m = 2^p registers, and stores in that register the position of the leftmost 1 in the remaining bits, keeping the maximum. The estimate is a harmonic mean of 2^rank across registers, scaled by a constant: one large rank is evidence of many distinct values, and the harmonic mean stops a single register from dominating.",
            "Two corrections matter in practice. Small cardinalities are dominated by empty registers, so linear counting takes over below roughly 2.5m. Large ones approach the hash space, so HLL++ applies empirical bias correction. The standard error is about 1.04/sqrt(m): p = 12 gives roughly 1.6%, and p = 16 roughly 0.4%."
          ],
          "list": [
            "Memory is fixed at 2^p registers, independent of how many items you feed it",
            "Relative error falls as 1/sqrt(m), so each extra bit of precision costs double the memory",
            "The hash must be well distributed; a weak hash produces a biased estimate",
            "The sketch is mergeable, which is the property that makes it useful in a fleet"
          ],
          "tip": "Pick precision from the error you can tolerate, not from the memory you have left over."
        },
        {
          "h": "Merging is register-wise max",
          "p": [
            "Because each register holds a maximum, merging two sketches is a max per register. That is what makes HLL usable in a sharded service: each shard keeps its own sketch, and the aggregator merges them without unioning key sets and without double counting. Merge requires identical precision and the same hash function.",
            "The same property is the limitation. A sketch cannot answer membership, cannot enumerate, and cannot subtract. Questions like how many users hit A but not B are set operations, not cardinality questions, and HLL has nothing to say about them."
          ],
          "code": "use hyperloglogplus::{HyperLogLog, HyperLogLogPlus};\nuse std::collections::hash_map::RandomState;\n\nfn main() {\n    // p = 14: 16,384 registers, about 1% standard error.\n    let mut shard_a: HyperLogLogPlus<u64, _> =\n        HyperLogLogPlus::new(14, RandomState::new()).unwrap();\n    let mut shard_b: HyperLogLogPlus<u64, _> =\n        HyperLogLogPlus::new(14, RandomState::new()).unwrap();\n\n    for user in 0..50_000u64 {\n        shard_a.insert(&user);\n    }\n    for user in 25_000..75_000u64 {\n        shard_b.insert(&user);\n    }\n\n    // Merge is a register-wise max, so the overlap is not double counted.\n    shard_a.merge(&shard_b).unwrap();\n    let estimate = shard_a.count(); // takes &mut self\n\n    let truth = 75_000.0;\n    let error = (estimate - truth).abs() / truth;\n    println!(\"estimate {estimate:.0}, relative error {error:.3}\");\n    assert!(error < 0.05);\n}"
        },
        {
          "h": "Where it pays",
          "p": [
            "Use HLL when the exact answer is expensive and a percent of error is acceptable: unique visitors per day, distinct query terms, distinct source IPs per minute. A HashSet<u64> holding 100 million users is at least 800 MB before hashing overhead; a p = 14 sketch is a few kilobytes and merges in microseconds.",
            "Store sketches, not counts, when you need arbitrary time windows: one sketch per hour lets you merge any window later, while storing only a daily number forces a full recompute for a different range. Serialise the sketch and keep the precision in the payload. Note that the Deserialize impl also requires the hasher to be Deserialize, so a sketch built on RandomState is write-only: pick a serialisable hasher before an aggregator depends on it."
          ],
          "tip": "Name the precision in the config or the type; merging mismatched precisions fails at runtime, not at compile time."
        }
      ],
      "exercise": {
        "prompt": "Estimate unique users per hour from three shard sketches of differing load, merge them, and report the relative error against the true union. Then prove that merging a sketch with a different precision fails instead of silently producing a wrong number.",
        "starter": "use hyperloglogplus::{HyperLogLog, HyperLogLogPlus};\nuse std::collections::hash_map::RandomState;\n\npub fn estimate(events: &[u64], precision: u8) -> f64 {\n    // insert every event, then count\n    unimplemented!()\n}\n\nfn main() {\n    let events: Vec<u64> = (0..10_000).collect();\n    let est = estimate(&events, 12);\n    println!(\"{est}\");\n}",
        "hint": "Build HyperLogLogPlus::new(precision, RandomState::new()).unwrap(), call insert for each event, then count() which takes &mut self. Merging needs both sides at the same precision.",
        "solution": "use hyperloglogplus::{HyperLogLog, HyperLogLogPlus};\nuse std::collections::hash_map::RandomState;\n\npub fn sketch(events: &[u64], precision: u8) -> HyperLogLogPlus<u64, RandomState> {\n    let mut hll = HyperLogLogPlus::new(precision, RandomState::new()).unwrap();\n    for e in events {\n        hll.insert(e);\n    }\n    hll\n}\n\nfn main() {\n    let a: Vec<u64> = (0..6_000).collect();\n    let b: Vec<u64> = (4_000..10_000).collect();\n\n    let mut left = sketch(&a, 12);\n    let right = sketch(&b, 12);\n\n    left.merge(&right).unwrap();\n    let estimate = left.count();\n    let truth = 10_000.0;\n    let error = (estimate - truth).abs() / truth;\n\n    println!(\"estimate {estimate:.0}, error {error:.3}\");\n    assert!(error < 0.08, \"p=12 should land within a few percent\");\n\n    // Same precision is required for a merge; a mismatch is an error.\n    let other = sketch(&a, 14);\n    assert!(left.merge(&other).is_err());\n}"
      },
      "questions": [
        {
          "q": "With precision p = 12, what relative error should you expect?",
          "options": [
            "Around 1.6%, because the standard error is 1.04/sqrt(4096)",
            "Around 12%",
            "Around 0.01%",
            "Zero error above 10,000 items"
          ],
          "answer": 0,
          "explain": "m = 2^12 = 4096 registers, so 1.04/sqrt(4096) = 0.01625, about 1.6% relative standard error."
        },
        {
          "q": "How are two HyperLogLog sketches merged?",
          "options": [
            "Register-wise maximum, which is why overlap is not double counted",
            "By summing the estimates",
            "By summing every register",
            "By reinserting the original keys"
          ],
          "answer": 0,
          "explain": "Each register stores a maximum rank, so the union sketch keeps the larger value per register. Summing would inflate the estimate."
        },
        {
          "q": "Which question can a HyperLogLog sketch not answer?",
          "options": [
            "Whether a specific user id was seen",
            "The approximate number of distinct ids in a window",
            "The union cardinality of two shards",
            "The cardinality after merging hourly sketches"
          ],
          "answer": 0,
          "explain": "HLL stores only register maxima, not keys. Membership, enumeration, and subtraction are outside what the structure can represent."
        }
      ],
      "quickbytes": [
        "p = 12 is a good default: 4,096 registers and about 1.6% error.",
        "Always merge at the same precision; store the precision with the serialized sketch.",
        "Keep one sketch per time bucket so you can merge arbitrary windows later."
      ],
      "production": [
        "Record the precision in the serialized payload and reject merges with a different value.",
        "Size sketches per shard and per time bucket, then check the aggregate memory before rollout.",
        "Do not derive alerts from a single sketch; error compounds when you compare two estimates.",
        "Prefer sketches over exact sets only when you have measured the cost of the exact path."
      ],
      "crates": [
        "hyperloglogplus",
        "serde"
      ],
      "github": [
        {
          "name": "tabac/hyperloglog.rs",
          "url": "https://github.com/tabac/hyperloglog.rs"
        }
      ],
      "pitfall": "Comparing two sketches to compute overlap is arithmetically meaningless: HLL cannot subtract, so the difference of two estimates can be negative or wildly wrong.",
      "resources": [
        {
          "title": "hyperloglogplus 0.4: HLL and HLL++",
          "url": "https://docs.rs/hyperloglogplus/latest/hyperloglogplus/",
          "kind": "docs"
        },
        {
          "title": "HyperLogLog in Practice (Google Research)",
          "url": "https://research.google/pubs/hyperloglog-in-practice-algorithmic-engineering-of-a-state-of-the-art-cardinality-estimation-algorithm/",
          "kind": "paper"
        },
        {
          "title": "tabac/hyperloglog.rs repository",
          "url": "https://github.com/tabac/hyperloglog.rs",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "b12",
      "n": 12,
      "title": "Cuckoo filters: deletion, fingerprints, and load",
      "minutes": 65,
      "level": "advanced",
      "goal": "Insert with cuckoo kicks, delete safely from a probabilistic structure, and recognise insertion failure as a load-factor problem rather than a bug.",
      "sections": [
        {
          "h": "Two buckets, one fingerprint",
          "p": [
            "A cuckoo filter stores a short fingerprint of 8 to 12 bits in one of two candidate buckets. The first bucket is the hash modulo the bucket count; the second is derived by XOR-ing the first with a hash of the fingerprint, which makes the pair symmetric: from either bucket you can compute the other. A lookup checks at most two buckets, usually one cache line each.",
            "Insertion is cuckoo hashing. If both buckets are full, evict a random fingerprint from one, move it to its alternate bucket, and repeat. This terminates only because the alternate is computable from the fingerprint alone. A kick chain longer than the maximum displacement means the table is too full, not that the key is invalid."
          ],
          "list": [
            "Deletion is supported, unlike a Bloom filter, because fingerprints are stored",
            "Load factor reaches about 95% with four slots per bucket, then failures rise sharply",
            "False positives come from fingerprint collisions, roughly 2b / 2^f",
            "Deleting a key that was never inserted can remove another key's fingerprint"
          ],
          "tip": "Locality is the real advantage: two buckets beat k random bit probes once the filter stops fitting in cache."
        },
        {
          "h": "Failure is a design case",
          "p": [
            "cuckoofilter 0.5 returns a Result from add, and can return NotEnoughSpace. The documentation is candid about the semantics: on that error the element was still added and some other random element was evicted. A rejected insert is therefore not a no-op, and code that retries in a loop silently corrupts the filter.",
            "Treat insertion failure as a capacity signal. Size from expected items divided by the target load factor, keep headroom, and on failure rebuild into a larger filter from the source of truth. If a rebuild is impossible, keep a small stash of overflow fingerprints and check it after the two buckets."
          ],
          "code": "use cuckoofilter::CuckooFilter;\nuse std::collections::hash_map::DefaultHasher;\n\nfn main() {\n    // with_capacity sizes the bucket array; keep headroom below the load limit.\n    let mut filter: CuckooFilter<DefaultHasher> = CuckooFilter::with_capacity(1_000);\n\n    for user in 0..800u64 {\n        filter.add(&user).expect(\"capacity was sized with headroom\");\n    }\n    assert_eq!(filter.len(), 800);\n    assert!(filter.contains(&42));\n\n    // Deletion is real: the fingerprint is stored, so it can be removed.\n    assert!(filter.delete(&42));\n    assert!(!filter.contains(&42));\n    assert_eq!(filter.len(), 799);\n\n    // Re-inserting needs the bucket layout to still have room.\n    filter.add(&42).unwrap();\n    assert!(filter.contains(&42));\n}"
        },
        {
          "h": "Bloom or cuckoo",
          "p": [
            "Choose Bloom when the set is append-only, memory is the tightest constraint, and a 1% false-positive rate is acceptable at about 9.6 bits per item. Choose cuckoo when you must delete, when you want one or two cache-line lookups instead of k random probes, or when the filter is large enough that locality dominates.",
            "The original Cuckoo Filter paper reports better space efficiency than Bloom for target false-positive rates below about 3%, where Bloom already needs roughly 1.44 log2(1/eps) bits per item. At looser targets Bloom is usually smaller. Benchmark against your query distribution: the crossover depends on fingerprint width and bucket size."
          ],
          "tip": "Deleting a key you never inserted is a silent false negative; gate delete on a confirmed hit from the source of truth."
        }
      ],
      "exercise": {
        "prompt": "Add a rebuild-on-pressure wrapper around cuckoofilter: insert must never lose a previously inserted key silently. On NotEnoughSpace, rebuild into a filter with twice the capacity from a retained key set, and assert the new filter holds every key.",
        "starter": "use cuckoofilter::CuckooFilter;\nuse std::collections::hash_map::DefaultHasher;\n\npub struct SafeFilter {\n    inner: CuckooFilter<DefaultHasher>,\n    keys: Vec<u64>,\n    rebuilds: usize,\n}\n\nimpl SafeFilter {\n    pub fn new(cap: usize) -> Self { unimplemented!() }\n    pub fn insert(&mut self, key: u64) { unimplemented!() }\n    pub fn contains(&self, key: u64) -> bool { unimplemented!() }\n}",
        "hint": "Keep the inserted keys in a Vec so you can rebuild. On add() returning Err, double the capacity, add every retained key again, retry the new key once, and count the rebuild.",
        "solution": "use cuckoofilter::CuckooFilter;\nuse std::collections::hash_map::DefaultHasher;\n\npub struct SafeFilter {\n    inner: CuckooFilter<DefaultHasher>,\n    keys: Vec<u64>,\n    rebuilds: usize,\n}\n\nimpl SafeFilter {\n    pub fn new(cap: usize) -> Self {\n        Self {\n            inner: CuckooFilter::with_capacity(cap),\n            keys: Vec::new(),\n            rebuilds: 0,\n        }\n    }\n\n    fn rebuild(&mut self) {\n        let cap = (self.keys.len().max(64)) * 4;\n        let mut bigger = CuckooFilter::with_capacity(cap);\n        for k in &self.keys {\n            bigger.add(k).expect(\"fresh filter has headroom\");\n        }\n        self.inner = bigger;\n        self.rebuilds += 1;\n    }\n\n    pub fn insert(&mut self, key: u64) {\n        if self.inner.add(&key).is_ok() {\n            self.keys.push(key);\n            return;\n        }\n        // The failed add already evicted another element: rebuild from truth.\n        self.rebuild();\n        self.inner.add(&key).expect(\"rebuilt filter has room\");\n        self.keys.push(key);\n    }\n\n    pub fn contains(&self, key: u64) -> bool {\n        self.inner.contains(&key)\n    }\n}\n\nfn main() {\n    let mut f = SafeFilter::new(16);\n    for i in 0..5_000u64 {\n        f.insert(i);\n    }\n    assert!(f.rebuilds > 0, \"a tiny filter must have rebuilt\");\n    for i in 0..5_000u64 {\n        assert!(f.contains(i), \"key {i} was lost across rebuild\");\n    }\n}"
      },
      "questions": [
        {
          "q": "Why can a cuckoo filter support deletion when a Bloom filter cannot?",
          "options": [
            "It stores a fingerprint per item, so removing one does not clear bits shared with other items",
            "It keeps a full copy of every key",
            "It uses fewer hash functions",
            "Deletion is emulated by rebuilding"
          ],
          "answer": 0,
          "explain": "Each item owns fingerprint slots rather than setting shared bits. Deleting removes one fingerprint, so other items are unaffected - as long as the fingerprint was actually present."
        },
        {
          "q": "What does cuckoofilter 0.5 guarantee when add returns NotEnoughSpace?",
          "options": [
            "The element was added and some other random element was evicted",
            "The filter is unchanged",
            "The filter is now empty",
            "The element was rejected and nothing else changed"
          ],
          "answer": 0,
          "explain": "The crate documents this explicitly. Because a failed add is not a no-op, callers must rebuild from the source of truth rather than retrying blindly."
        },
        {
          "q": "Why does a cuckoo filter need a second bucket derived by XOR with the fingerprint hash?",
          "options": [
            "So the alternate bucket can be recomputed from the fingerprint alone during a kick",
            "To reduce the number of hash functions to zero",
            "To make the filter ordered",
            "To allow more than one fingerprint per slot"
          ],
          "answer": 0,
          "explain": "Cuckoo kicks move a fingerprint without its original key. The XOR construction makes the alternate bucket computable from the stored fingerprint, keeping the moves symmetric."
        }
      ],
      "quickbytes": [
        "Size buckets from expected items / 0.9; the 95% ceiling is not a comfortable operating point.",
        "Never delete a key unless the authoritative store confirmed it was present.",
        "Two cache-line probes beat k scattered bit probes once the filter exceeds L2."
      ],
      "production": [
        "Handle NotEnoughSpace by rebuilding from the source of truth, never by retrying the same insert.",
        "Track load factor and insertion failures as metrics; a filter above 90% is one burst from silent eviction.",
        "Do not delete on a negative authoritative lookup; fingerprints can collide with unrelated keys.",
        "Pin the fingerprint width and bucket size, since serialized layouts are not portable across configurations."
      ],
      "crates": [
        "cuckoofilter",
        "fastbloom"
      ],
      "github": [
        {
          "name": "axiomhq/rust-cuckoofilter",
          "url": "https://github.com/axiomhq/rust-cuckoofilter"
        }
      ],
      "pitfall": "A retry loop around add after NotEnoughSpace keeps evicting fingerprints, so the filter slowly forgets keys that were inserted long ago and starts producing false negatives.",
      "resources": [
        {
          "title": "cuckoofilter 0.5 API reference",
          "url": "https://docs.rs/cuckoofilter/latest/cuckoofilter/",
          "kind": "docs"
        },
        {
          "title": "axiomhq/rust-cuckoofilter repository",
          "url": "https://github.com/axiomhq/rust-cuckoofilter",
          "kind": "repo"
        },
        {
          "title": "fastbloom: the Bloom alternative",
          "url": "https://docs.rs/fastbloom/latest/fastbloom/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "b13",
      "n": 13,
      "title": "Concurrent maps: sharded guards and deadlock",
      "minutes": 90,
      "level": "industry",
      "goal": "Use DashMap's shard model safely, keep guards short, and recognise the guard-held-across-lock deadlock that sharded maps invite.",
      "sections": [
        {
          "h": "Sharding is the whole design",
          "p": [
            "DashMap is an array of RwLock<HashMap> shards, with the key's hash selecting a shard. A get takes a read guard on one shard; an insert takes a write guard on one shard. Threads on different shards never contend, and the default shard count scales with available parallelism, so throughput improves with cores until a single hot key pins one shard.",
            "The cost is that there is no longer one coherent view. len() sums shards, iteration locks shards one at a time and can observe a state that never existed atomically, and there is no multi-key transaction. Anything that needs a consistent snapshot needs a different structure or an external lock."
          ],
          "list": [
            "Per-shard locks: contention lives inside a shard, not across the map",
            "get returns a Ref guard that holds the shard read lock until dropped",
            "Iteration is weakly consistent and can miss or repeat entries that move during the walk",
            "One hot key serialises on one shard no matter how many shards exist"
          ],
          "tip": "Count shards from the number of keys you expect to be hot, not from the number of cores."
        },
        {
          "h": "Guards are locks with good manners",
          "p": [
            "Ref and RefMut deref to the value, which makes them feel like references, but each holds a lock for its whole lifetime. Hold one across an await point and the shard stays locked while the task is suspended; another task on the same shard then blocks a runtime worker, and the pool silently loses a thread.",
            "The deadlock is easy to write: take a read guard on one key, then request a write guard on another key that hashes to the same shard. Neither std's RwLock nor parking_lot's is reentrant, so the second acquisition waits on the first forever. Copy the value out, drop the guard, then take the next lock."
          ],
          "code": "use dashmap::DashMap;\nuse std::sync::Arc;\n\nfn main() {\n    let sessions: Arc<DashMap<u64, u32>> = Arc::new(DashMap::new());\n\n    // entry() takes one shard lock and returns a guard.\n    sessions.entry(7).or_insert(1);\n    *sessions.entry(7).or_insert(0) += 1;\n    assert_eq!(*sessions.get(&7).unwrap(), 2);\n\n    // Copy the value out so the guard is released at the end of the statement.\n    let snapshot = *sessions.get(&7).unwrap();\n    assert_eq!(snapshot, 2);\n\n    // Read-modify-write on one key is atomic within the shard lock.\n    if let Some(mut v) = sessions.get_mut(&7) {\n        *v += 10;\n    }\n    assert_eq!(*sessions.get(&7).unwrap(), 12);\n\n    // len() sums the shards; it is a snapshot, not a transaction.\n    assert_eq!(sessions.len(), 1);\n\n    // This would deadlock if both keys landed in one shard:\n    // let a = sessions.get(&7);          // read guard, shard held\n    // let b = sessions.get_mut(&8);      // write guard on the same shard: no\n    // Use try_get_mut when you cannot prove the keys differ.\n    assert!(sessions.try_get_mut(&99).is_none());\n}"
        },
        {
          "h": "When a concurrent map is the wrong tool",
          "p": [
            "DashMap is excellent for a large key space with mostly independent keys: connection registries, per-tenant configuration, deduplication windows. It is a poor fit for counters over a small hot set, where every update fights over one shard, and for anything needing multi-key invariants such as moving a balance between two accounts.",
            "Alternatives worth knowing: papaya for lock-free reads with a similar API, scc for higher write concurrency, flurry for a Java-style ConcurrentHashMap, and a plain RwLock<HashMap> when reads dominate and you want one coherent structure. The right answer is measured against your key distribution, not assumed from a benchmark table."
          ],
          "tip": "If you hold two guards at once, you have written a lock-ordering problem with extra steps."
        }
      ],
      "exercise": {
        "prompt": "Implement a per-key rate limiter on DashMap where each key holds a token bucket. Updates must be atomic per key, must not hold a guard across the sleep, and must cap the map size by evicting idle buckets.",
        "starter": "use dashmap::DashMap;\nuse std::time::{Duration, Instant};\n\npub struct Bucket {\n    tokens: f64,\n    last: Instant,\n}\n\npub struct Limiter {\n    buckets: DashMap<String, Bucket>,\n    rate_per_sec: f64,\n    burst: f64,\n}\n\nimpl Limiter {\n    pub fn allow(&self, key: &str) -> bool {\n        unimplemented!()\n    }\n}",
        "hint": "Use entry(key.to_string()) once, compute the refill from elapsed time inside the guard, and return the decision. Do not sleep while holding the guard; the caller decides how to wait.",
        "solution": "use dashmap::DashMap;\nuse std::time::{Duration, Instant};\n\npub struct Bucket {\n    tokens: f64,\n    last: Instant,\n}\n\npub struct Limiter {\n    buckets: DashMap<String, Bucket>,\n    rate_per_sec: f64,\n    burst: f64,\n}\n\nimpl Limiter {\n    pub fn new(rate_per_sec: f64, burst: f64) -> Self {\n        Self { buckets: DashMap::new(), rate_per_sec, burst }\n    }\n\n    pub fn allow(&self, key: &str) -> bool {\n        let now = Instant::now();\n        let mut entry = self.buckets.entry(key.to_string()).or_insert(Bucket {\n            tokens: self.burst,\n            last: now,\n        });\n\n        let elapsed = now.duration_since(entry.last).as_secs_f64();\n        entry.tokens = (entry.tokens + elapsed * self.rate_per_sec).min(self.burst);\n        entry.last = now;\n\n        if entry.tokens >= 1.0 {\n            entry.tokens -= 1.0;\n            true\n        } else {\n            false\n        }\n    }\n\n    /// Call from a maintenance task; never from the request path.\n    pub fn evict_idle(&self, idle: Duration) {\n        let now = Instant::now();\n        self.buckets.retain(|_, b| now.duration_since(b.last) < idle);\n    }\n}\n\nfn main() {\n    let limiter = Limiter::new(10.0, 3.0);\n    assert!(limiter.allow(\"tenant-a\"));\n    assert!(limiter.allow(\"tenant-a\"));\n    assert!(limiter.allow(\"tenant-a\"));\n    assert!(!limiter.allow(\"tenant-a\")); // burst exhausted\n    assert!(limiter.allow(\"tenant-b\"));  // independent bucket\n    assert_eq!(limiter.buckets.len(), 2);\n\n    limiter.evict_idle(Duration::from_secs(0));\n    assert_eq!(limiter.buckets.len(), 0);\n}"
      },
      "questions": [
        {
          "q": "Why can DashMap::len() be misleading under concurrent writes?",
          "options": [
            "It sums per-shard lengths, so it is a snapshot rather than an atomic count",
            "It caches a stale value forever",
            "It only counts one shard",
            "It requires an exclusive lock and panics"
          ],
          "answer": 0,
          "explain": "Each shard is locked separately, so the total is assembled from shard states observed at different times. Inserts during the walk can make it off by any amount."
        },
        {
          "q": "What is the deadlock risk with DashMap guards?",
          "options": [
            "Holding a read guard on one key and then taking a write guard on a key in the same shard",
            "Calling get twice on the same key",
            "Dropping a guard before using the value",
            "Using more shards than cores"
          ],
          "answer": 0,
          "explain": "Guards are shard locks and locks are not reentrant. Two keys that hash to the same shard turn a second acquisition into a self-deadlock."
        },
        {
          "q": "Which workload is a poor fit for a sharded concurrent map?",
          "options": [
            "A small hot set of counters updated by every thread",
            "A large registry of connections keyed by id",
            "Per-tenant configuration read by request handlers",
            "A deduplication window with many distinct keys"
          ],
          "answer": 0,
          "explain": "Hot counters collide on one shard, so the map serialises exactly the operations you wanted to parallelise. Per-thread counters merged periodically scale better."
        }
      ],
      "quickbytes": [
        "Copy values out of guards before awaiting, calling out, or taking another lock.",
        "try_get_mut turns a potential deadlock into an observable None.",
        "Set the shard count explicitly in performance-sensitive services so a core-count change is not a silent regression."
      ],
      "production": [
        "Never hold a DashMap guard across an await point; restructure to copy, drop, then act.",
        "Add a metrics gauge for map len and shard balance; one hot shard looks like uniform contention in CPU profiles.",
        "Prefer per-key entry() updates over get-then-insert, which is not atomic across the two calls.",
        "Evict idle keys on a schedule; an unbounded map is a memory leak with a hash function."
      ],
      "crates": [
        "dashmap",
        "parking_lot"
      ],
      "github": [
        {
          "name": "xacrimon/dashmap",
          "url": "https://github.com/xacrimon/dashmap"
        }
      ],
      "pitfall": "A read guard held while acquiring a write guard for a second key in the same shard deadlocks the thread against itself, and the stack trace points at the map rather than at the ordering mistake.",
      "resources": [
        {
          "title": "dashmap 6.2: concurrent HashMap",
          "url": "https://docs.rs/dashmap/latest/dashmap/",
          "kind": "docs"
        },
        {
          "title": "xacrimon/dashmap repository",
          "url": "https://github.com/xacrimon/dashmap",
          "kind": "repo"
        },
        {
          "title": "Jon Gjengset: Rust internals and performance streams",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ]
    },
    {
      "id": "b14",
      "n": 14,
      "title": "Lock-free queues: bounded MPMC and memory ordering",
      "minutes": 95,
      "level": "industry",
      "goal": "Read the sequence-number protocol behind a bounded MPMC ring, use crossbeam-queue correctly, and test the result with loom instead of hope.",
      "sections": [
        {
          "h": "Sequence numbers instead of a lock",
          "p": [
            "A bounded MPMC queue cannot be built from one atomic index per slot. A producer must claim a vacant slot, and a consumer must know the slot is published. Vyukov's design pairs each slot with a sequence number: enqueue CAS-increments the tail, then waits until the slot's sequence equals its ticket; dequeue does the mirror on the head. The sequence encodes position and generation at once.",
            "The wrap is the subtle part: comparison is against the ticket, not against zero, so a slot reused after 2^32 operations still reports vacant or full correctly. That is also why capacity must be a power of two and why the queue is bounded: the algorithm has no allocation path to fall back on when it is full."
          ],
          "list": [
            "One CAS per operation; losers retry against the new index",
            "Capacity must be a power of two so the index wraps with a mask",
            "push returns the item back on failure, which is the backpressure signal",
            "False sharing is real: head, tail, and slots must not share cache lines"
          ],
          "tip": "A bounded queue is a backpressure mechanism; an unbounded one moves the failure to the allocator."
        },
        {
          "h": "crossbeam-queue gives you the two useful shapes",
          "p": [
            "ArrayQueue is the bounded MPMC ring: push and pop return Result, both take &self, and any number of threads can share it behind an Arc. SegQueue is unbounded and allocates segments on demand: simpler at the call site, but it grows until the allocator or the OOM killer intervenes, which is rarely what a producer-consumer boundary wants.",
            "Both are lock-free, not wait-free: a thread can be delayed by another thread's progress. That distinction matters for tail latency. A bounded queue also gives an immediate, observable full signal to the producer instead of unbounded memory growth with a latency cliff at the end."
          ],
          "code": "use crossbeam_queue::ArrayQueue;\nuse std::sync::Arc;\nuse std::thread;\n\nfn main() {\n    let q: Arc<ArrayQueue<u64>> = Arc::new(ArrayQueue::new(1024));\n    let mut producers = Vec::new();\n\n    for w in 0..4u64 {\n        let q = Arc::clone(&q);\n        producers.push(thread::spawn(move || {\n            for i in 0..10_000u64 {\n                let item = w * 100_000 + i;\n                while q.push(item).is_err() {\n                    // Full: apply backpressure instead of allocating.\n                    std::hint::spin_loop();\n                }\n            }\n        }));\n    }\n\n    let mut seen = 0u64;\n    while seen < 40_000 {\n        if q.pop().is_some() {\n            seen += 1;\n        } else {\n            std::hint::spin_loop();\n        }\n    }\n\n    for p in producers {\n        p.join().unwrap();\n    }\n    assert!(q.is_empty());\n}"
        },
        {
          "h": "Loom, not luck",
          "p": [
            "Concurrency bugs are rare by construction: they need one specific interleaving. Running a stress test a million times is not evidence. Loom explores the interleavings allowed by the C11 memory model using replacement atomics selected by a cfg flag, which is how the queue crates themselves are tested.",
            "Loom requires your code to use loom's types when the cfg is on, so the usual pattern is a small sync module that re-exports std normally and loom under cfg(loom). Run with RUSTFLAGS=\"--cfg loom\" and --release; when the model explodes, LOOM_MAX_PREEMPTIONS=2 or 3 catches most bugs at a fraction of the states."
          ],
          "code": "use std::sync::Arc;\n\n#[cfg(loom)]\nuse loom::sync::atomic::{AtomicUsize, Ordering};\n#[cfg(not(loom))]\nuse std::sync::atomic::{AtomicUsize, Ordering};\n\nstruct Slot {\n    seq: AtomicUsize,\n    value: AtomicUsize,\n}\n\n#[test]\nfn published_value_is_visible_after_release() {\n    #[cfg(loom)]\n    loom::model(|| {\n        let slot = Arc::new(Slot {\n            seq: AtomicUsize::new(1),\n            value: AtomicUsize::new(0),\n        });\n        let writer = Arc::clone(&slot);\n        let t = loom::thread::spawn(move || {\n            writer.value.store(42, Ordering::Relaxed);\n            writer.seq.store(2, Ordering::Release);\n        });\n        while slot.seq.load(Ordering::Acquire) != 2 {\n            loom::thread::yield_now();\n        }\n        assert_eq!(slot.value.load(Ordering::Relaxed), 42);\n        t.join().unwrap();\n    });\n\n    #[cfg(not(loom))]\n    {\n        let slot = Slot { seq: AtomicUsize::new(2), value: AtomicUsize::new(42) };\n        assert_eq!(slot.seq.load(Ordering::Acquire), 2);\n        assert_eq!(slot.value.load(Ordering::Relaxed), 42);\n    }\n}\n\n// RUSTFLAGS=\"--cfg loom\" cargo test --release --test loom_queue\n// LOOM_MAX_PREEMPTIONS=3 RUSTFLAGS=\"--cfg loom\" cargo test --release"
        }
      ],
      "exercise": {
        "prompt": "Wrap crossbeam_queue::ArrayQueue in a bounded work queue that returns a typed Full error instead of spinning, and add a shutdown flag so workers exit cleanly when producers stop. Prove no item is lost or duplicated.",
        "starter": "use crossbeam_queue::ArrayQueue;\nuse std::sync::atomic::{AtomicBool, Ordering};\nuse std::sync::Arc;\n\npub enum PushError<T> { Full(T), Closed(T) }\n\npub struct WorkQueue<T> {\n    inner: Arc<ArrayQueue<T>>,\n    closed: AtomicBool,\n}\n\nimpl<T> WorkQueue<T> {\n    pub fn new(cap: usize) -> Self { unimplemented!() }\n    pub fn push(&self, item: T) -> Result<(), PushError<T>> { unimplemented!() }\n    pub fn pop(&self) -> Option<T> { unimplemented!() }\n    pub fn close(&self) { unimplemented!() }\n}",
        "hint": "Check closed before and after the push; on Err(item) from the queue, return Full(item). pop should drain remaining items after close, so workers finish work already accepted.",
        "solution": "use crossbeam_queue::ArrayQueue;\nuse std::sync::atomic::{AtomicBool, Ordering};\nuse std::sync::Arc;\n\n#[derive(Debug, PartialEq)]\npub enum PushError<T> {\n    Full(T),\n    Closed(T),\n}\n\npub struct WorkQueue<T> {\n    inner: Arc<ArrayQueue<T>>,\n    closed: AtomicBool,\n}\n\nimpl<T> WorkQueue<T> {\n    pub fn new(cap: usize) -> Self {\n        Self { inner: Arc::new(ArrayQueue::new(cap)), closed: AtomicBool::new(false) }\n    }\n\n    pub fn push(&self, item: T) -> Result<(), PushError<T>> {\n        if self.closed.load(Ordering::Acquire) {\n            return Err(PushError::Closed(item));\n        }\n        match self.inner.push(item) {\n            Ok(()) => Ok(()),\n            Err(item) if self.closed.load(Ordering::Acquire) => Err(PushError::Closed(item)),\n            Err(item) => Err(PushError::Full(item)),\n        }\n    }\n\n    pub fn pop(&self) -> Option<T> {\n        self.inner.pop()\n    }\n\n    /// Stop accepting work; already-queued items remain drainable.\n    pub fn close(&self) {\n        self.closed.store(true, Ordering::Release);\n    }\n\n    pub fn len(&self) -> usize {\n        self.inner.len()\n    }\n}\n\nfn main() {\n    let q = WorkQueue::new(2);\n    assert!(q.push(1).is_ok());\n    assert!(q.push(2).is_ok());\n    assert_eq!(q.push(3), Err(PushError::Full(3)));\n    assert_eq!(q.pop(), Some(1));\n\n    q.close();\n    assert_eq!(q.push(4), Err(PushError::Closed(4)));\n    assert_eq!(q.pop(), Some(2)); // accepted work is still drainable\n    assert_eq!(q.pop(), None);\n    assert_eq!(q.len(), 0);\n}"
      },
      "questions": [
        {
          "q": "Why must a bounded MPMC ring have a power-of-two capacity?",
          "options": [
            "So the position wraps with a bitmask and the sequence comparison stays cheap and correct",
            "So the allocator can align the buffer",
            "Because atomics require power-of-two sizes",
            "To guarantee wait-free progress"
          ],
          "answer": 0,
          "explain": "Index wrapping is masked, and the slot sequence is derived from the position. Non-power-of-two capacities break the cheap mask and complicate the protocol."
        },
        {
          "q": "What does ArrayQueue::push return when the queue is full?",
          "options": [
            "Err with the item handed back, so the caller can retry or shed load",
            "A panic",
            "It blocks until space is available",
            "It silently drops the item"
          ],
          "answer": 0,
          "explain": "Returning the item makes backpressure explicit and allocation-free. Spinning, blocking, or dropping are policies the caller chooses."
        },
        {
          "q": "What is loom actually doing in a concurrency test?",
          "options": [
            "Exhaustively exploring allowed interleavings with instrumented atomics under the C11 memory model",
            "Running the test many times on many threads and hoping to hit the race",
            "Adding artificial sleeps to widen race windows",
            "Checking memory leaks"
          ],
          "answer": 0,
          "explain": "Loom replaces atomics and thread scheduling so each valid permutation can be replayed deterministically. Repetition-based stress testing is not a proof."
        }
      ],
      "quickbytes": [
        "Return the item on a failed push; dropping it silently is the classic bounded-queue data loss bug.",
        "Keep head and tail on separate cache lines, or producers and consumers fight over one line.",
        "Run loom in CI under --release with a preemption bound; it is not a debug-build tool."
      ],
      "production": [
        "Choose the bound from measured service time and arrival rate, and export a full-queue counter.",
        "Never spin without a yield or a park in a hot path; a full queue under a slow consumer becomes a CPU fire.",
        "Cover the queue with a loom model and keep a stress test for throughput regressions.",
        "Document the shutdown semantics: whether queued work drains or is dropped on close."
      ],
      "crates": [
        "crossbeam-queue",
        "loom"
      ],
      "github": [
        {
          "name": "crossbeam-rs/crossbeam",
          "url": "https://github.com/crossbeam-rs/crossbeam"
        },
        {
          "name": "tokio-rs/loom",
          "url": "https://github.com/tokio-rs/loom"
        }
      ],
      "pitfall": "A producer that ignores the Err from push and drops the item loses work under exactly the load spike the queue was meant to absorb, with no error path to observe it.",
      "resources": [
        {
          "title": "crossbeam-queue 0.3: ArrayQueue and SegQueue",
          "url": "https://docs.rs/crossbeam-queue/latest/crossbeam_queue/",
          "kind": "docs"
        },
        {
          "title": "loom 0.7: permutation testing for concurrent code",
          "url": "https://docs.rs/loom/latest/loom/",
          "kind": "docs"
        },
        {
          "title": "tokio-rs/loom repository",
          "url": "https://github.com/tokio-rs/loom",
          "kind": "repo"
        },
        {
          "title": "crossbeam-rs/crossbeam repository",
          "url": "https://github.com/crossbeam-rs/crossbeam",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "b15",
      "n": 15,
      "title": "SmallVec: inline storage and its hidden costs",
      "minutes": 65,
      "level": "core",
      "goal": "Choose an inline capacity from measured item counts, understand the spill copy, and avoid the stack bloat that comes with a large inline array.",
      "sections": [
        {
          "h": "One type, two layouts",
          "p": [
            "SmallVec<[T; N]> stores up to N elements inside the value itself and spills to the heap at element N+1. The inline array is part of the struct, so size_of::<SmallVec<[u8; 16]>>() is at least 16 bytes plus a length and a layout tag - larger than a Vec's 24 bytes, but with no allocation for short vectors.",
            "The spill is a one-way copy of all N elements into a fresh heap allocation. That is fine when short is the common case and long is rare. It is pathological when sizes straddle N, because instances alternate between inline and heap and pay the copy on the way out every time."
          ],
          "list": [
            "No allocation while len <= N; one allocation plus a memcpy at N+1",
            "The inline array makes the value big, and moving the value copies the inline contents",
            "Large N in a hot struct is a stack and memcpy problem, not a speed optimisation",
            "Deref to [T] means most read-only code does not care which layout is active"
          ],
          "tip": "SmallVec saves allocator traffic, not bandwidth; if the values are large, the memcpy eats the win."
        },
        {
          "h": "Pick N from data, not from aesthetics",
          "p": [
            "SmallVec pays off when the distribution is strongly bimodal: nearly all instances hold zero to four items, and the rare large one can afford a heap allocation. AST child lists, HTTP header sets, and error chains have that shape. A vector that is usually twelve items with an inline capacity of four just spills on every instance.",
            "The other cost is per-value size. A SmallVec<[u8; 256]> inside an enum makes every variant at least 256 bytes, and every move copies it. If the struct is passed by value through several layers, the memcpy shows up in profiles as an unexplained constant cost."
          ],
          "code": "use smallvec::{smallvec, SmallVec};\nuse std::mem::size_of;\n\nfn main() {\n    // Inline: no allocation, data lives in the value.\n    let inline: SmallVec<[u8; 4]> = smallvec![1, 2, 3];\n    assert_eq!(inline.len(), 3);\n    assert!(size_of::<SmallVec<[u8; 4]>>() >= size_of::<Vec<u8>>());\n\n    // Spill: the fifth element allocates and copies the first four.\n    let mut spilled: SmallVec<[u8; 4]> = smallvec![1, 2, 3, 4];\n    spilled.push(5);\n    assert_eq!(&spilled[..], &[1, 2, 3, 4, 5]);\n\n    // into_vec hands over the heap buffer without a second copy once spilled.\n    let v: Vec<u8> = spilled.into_vec();\n    assert_eq!(v, vec![1, 2, 3, 4, 5]);\n\n    // from_vec adopts an existing allocation instead of copying into inline space.\n    let adopted: SmallVec<[u8; 4]> = SmallVec::from_vec(vec![9; 5]);\n    assert_eq!(adopted.len(), 5);\n\n    println!(\"inline size: {} bytes\", size_of::<SmallVec<[u8; 4]>>());\n}"
        },
        {
          "h": "Alternatives and the union feature",
          "p": [
            "ArrayVec is the no-spill sibling: fixed capacity, and pushing past it returns the element or panics depending on the API. Use it when overflow is a bug, and SmallVec when overflow is expected but rare. tinyvec targets Copy element types with a smaller API surface and no unsafe in user code.",
            "The smallvec union feature removes the layout tag and saves one word, so a small inline capacity costs 24 rather than 32 bytes. That matters in arrays of millions and nowhere else. Treat it as a size optimisation: measure struct size before and after, and do not expect throughput to move."
          ],
          "tip": "If more than a few percent of instances spill, the inline buffer costs you a copy and saves nothing."
        }
      ],
      "exercise": {
        "prompt": "Model a parser node with 0..=6 children where over 95% of nodes have at most three. Pick an inline capacity from that distribution, keep the type finitely sized, and prove which child counts spill.",
        "starter": "use smallvec::SmallVec;\n\npub struct Node {\n    pub name: String,\n    // A direct SmallVec<[Node; N]> would be infinitely sized; box the children.\n    pub children: SmallVec<[Box<Node>; 0]>,\n}\n\nfn main() {\n    // print size_of::<Node>() for a few capacities in a scratch copy\n}",
        "hint": "Box each child so the type stays finitely sized, then N = 3 keeps almost every node inline. A direct SmallVec<[Node; 3]> field makes the struct recursive with infinite size and does not compile.",
        "solution": "use smallvec::SmallVec;\nuse std::mem::size_of;\n\npub struct Node {\n    pub name: String,\n    // Boxed children keep the type finitely sized; 3 pointers stay inline.\n    pub children: SmallVec<[Box<Node>; 3]>,\n}\n\nimpl Node {\n    pub fn leaf(name: &str) -> Self {\n        Self { name: name.to_string(), children: SmallVec::new() }\n    }\n\n    pub fn with_children(name: &str, kids: impl IntoIterator<Item = Node>) -> Self {\n        Self {\n            name: name.to_string(),\n            children: kids.into_iter().map(Box::new).collect(),\n        }\n    }\n\n    /// True when the inline buffer spilled to the heap.\n    pub fn spilled(&self) -> bool {\n        self.children.spilled()\n    }\n}\n\nfn main() {\n    let leaf = Node::leaf(\"x\");\n    println!(\"node size: {} bytes\", size_of::<Node>());\n    assert!(!leaf.spilled());\n\n    let three = Node::with_children(\n        \"a\",\n        [Node::leaf(\"b\"), Node::leaf(\"c\"), Node::leaf(\"d\")],\n    );\n    assert!(!three.spilled());\n\n    let four = Node::with_children(\n        \"root\",\n        [Node::leaf(\"b\"), Node::leaf(\"c\"), Node::leaf(\"d\"), Node::leaf(\"e\")],\n    );\n    assert!(four.spilled());\n\n    // Four children means one heap allocation for the child list itself.\n    assert_eq!(four.children.len(), 4);\n    assert_eq!(four.name, \"root\");\n}"
      },
      "questions": [
        {
          "q": "What happens when a SmallVec with inline capacity 4 receives its fifth element?",
          "options": [
            "It allocates on the heap and copies the four inline elements into the new buffer",
            "It returns an error",
            "It overwrites the first element",
            "It doubles its inline capacity at runtime"
          ],
          "answer": 0,
          "explain": "The spill is a single allocation plus a memcpy of the existing elements. Growth from there behaves like Vec. ArrayVec is the version that refuses instead."
        },
        {
          "q": "Which distribution makes SmallVec a poor choice?",
          "options": [
            "Sizes cluster around the inline capacity, so instances frequently spill and pop back",
            "Almost all instances hold zero or one item",
            "A rare large instance grows to thousands of items",
            "Most instances are built once and never moved"
          ],
          "answer": 0,
          "explain": "Straddling N means paying the spill copy often while the inline buffer still inflates every value. Either raise N to cover the common case or use Vec."
        },
        {
          "q": "Why can a large inline capacity be slower than a Vec in a hot path?",
          "options": [
            "Moves copy the whole inline array, and the larger value stresses the stack and cache",
            "The heap allocator is faster than the stack",
            "SmallVec cannot be iterated with Deref",
            "It disables the optimiser"
          ],
          "answer": 0,
          "explain": "Every move or return by value copies the inline storage. At 256 bytes per value, that memcpy dominates the allocations you were trying to avoid."
        }
      ],
      "quickbytes": [
        "Measure the size distribution first; the right N is a fact about your data, not a default.",
        "smallvec::SmallVec::spilled() is the cheapest way to validate the capacity in tests.",
        "Prefer Vec for values larger than a few cache lines; the copy costs more than the allocation."
      ],
      "production": [
        "Pick the inline capacity from a histogram of real item counts, and revisit it when the data changes.",
        "Keep inline capacities small (about 4 to 8) in structs that are moved often.",
        "Assert on spill rate in a benchmark or a sampled test; a silent spill on every instance is invisible in latency averages.",
        "Use ArrayVec where overflow is a bug and SmallVec where it is an expected rare case."
      ],
      "crates": [
        "smallvec",
        "arrayvec"
      ],
      "github": [
        {
          "name": "servo/rust-smallvec",
          "url": "https://github.com/servo/rust-smallvec"
        }
      ],
      "pitfall": "An inline capacity chosen to fit the maximum ever seen makes every value that wide, so a SmallVec<[T; 256]> in a recursive AST node multiplies stack usage by 256 bytes per level.",
      "resources": [
        {
          "title": "smallvec 1.16: inline-storage vectors",
          "url": "https://docs.rs/smallvec/latest/smallvec/",
          "kind": "docs"
        },
        {
          "title": "servo/rust-smallvec repository",
          "url": "https://github.com/servo/rust-smallvec",
          "kind": "repo"
        },
        {
          "title": "fasterthanlime: Rust systems programming videos",
          "url": "https://www.youtube.com/@fasterthanlime",
          "kind": "video"
        }
      ]
    },
    {
      "id": "b16",
      "n": 16,
      "title": "Bytes and BytesMut: refcounted slices, no copies",
      "minutes": 80,
      "level": "advanced",
      "goal": "Build frames in BytesMut, freeze them into cheaply cloneable Bytes, and avoid pinning a large allocation by holding a small slice.",
      "sections": [
        {
          "h": "One allocation, many owners",
          "p": [
            "Bytes is a reference-counted view over a byte buffer: cloning is an atomic increment, slicing is an offset plus a length, and the allocation is freed when the last handle drops. That is what lets a proxy fan one network frame out to several consumers without copying it once per consumer.",
            "BytesMut is the unique-owner counterpart: a growable buffer with a write cursor, used to assemble a message. split() or split_to() separates the written prefix into its own handle, and freeze() converts it into an immutable Bytes without copying. The two types are two states of one buffer, not two implementations."
          ],
          "list": [
            "clone is O(1): the buffer is shared, not duplicated",
            "slice and split_to adjust offsets, so no bytes move",
            "freeze is the zero-copy transition from building to sharing",
            "advance moves the read cursor without a memmove"
          ],
          "tip": "Bytes is for sharing what you already built; BytesMut is for building what you will share.",
          "code": "use bytes::{BufMut, Bytes, BytesMut};\n\nfn main() {\n    let mut buf = BytesMut::with_capacity(1024);\n    buf.put_slice(b\"hello \");\n\n    // Split the written prefix off; the remaining buffer stays writable.\n    let head: Bytes = buf.split().freeze();\n    buf.put_slice(b\"world\");\n    let tail: Bytes = buf.freeze();\n\n    assert_eq!(&head[..], &b\"hello \"[..]);\n    assert_eq!(&tail[..], &b\"world\"[..]);\n\n    // Clone is a refcount bump: both handles point at the same memory.\n    let shared = head.clone();\n    assert_eq!(shared.as_ptr(), head.as_ptr());\n\n    // Slicing is an offset, not a copy.\n    let word = shared.slice(0..5);\n    assert_eq!(&word[..], &b\"hello\"[..]);\n\n    // Copying a small piece out lets the large allocation go away.\n    let owned = Bytes::copy_from_slice(&word[..4]);\n    drop(shared);\n    drop(word);\n    assert_eq!(&owned[..], &b\"hell\"[..]);\n}"
        },
        {
          "h": "The retained-allocation trap",
          "p": [
            "A small Bytes slice keeps the whole underlying allocation alive. Parse a 4-byte length prefix out of a 1 MiB frame, store that Bytes in a connection table, and the table pins 1 MiB per entry. The buffer is freed only when the last view drops, and the allocator accounts for its full size, not the slice length.",
            "The fix is to copy deliberately at the boundary where the lifetime should end: Bytes::copy_from_slice for the small extract, or Bytes::from(Vec) when the data is already materialised. Copying 4 bytes is cheaper than retaining a megabyte for the lifetime of the process."
          ],
          "tip": "Audit every long-lived map keyed or valued by Bytes; ask what allocation each handle keeps alive."
        },
        {
          "h": "Framing with Buf and BufMut",
          "p": [
            "tokio-util codecs use these types directly: LengthDelimitedCodec reads a length prefix from a BytesMut, splits off exactly that many bytes, and hands the frame out as Bytes. The decode path is offset arithmetic plus one refcount, which is why a proxy can parse millions of frames per second per core.",
            "In your own codec, keep the pattern: accumulate into BytesMut, check the length before calling split_to, and return Bytes rather than Vec<u8> so downstream stages share the buffer. Reserve from the length prefix once it is known and let the buffer amortise across frames."
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a length-prefixed frame codec over BytesMut: append_frame encodes a big-endian u32 length followed by the payload, and next_frame returns a Bytes frame only when the full frame has arrived, leaving partial data buffered.",
        "starter": "use bytes::{Buf, BufMut, Bytes, BytesMut};\n\npub struct Codec {\n    buf: BytesMut,\n}\n\nimpl Codec {\n    pub fn new() -> Self { unimplemented!() }\n    pub fn append(&mut self, payload: &[u8]) { unimplemented!() }\n    pub fn next_frame(&mut self) -> Option<Bytes> { unimplemented!() }\n}",
        "hint": "Write the 4-byte length before the payload. In next_frame, peek the header with get_u32 only when at least 4 bytes are buffered, check the total length, then split_to(4 + len) and advance past the header.",
        "solution": "use bytes::{Buf, BufMut, Bytes, BytesMut};\n\npub struct Codec {\n    buf: BytesMut,\n}\n\nimpl Codec {\n    pub fn new() -> Self {\n        Self { buf: BytesMut::with_capacity(8 * 1024) }\n    }\n\n    pub fn append(&mut self, payload: &[u8]) {\n        self.buf.put_u32(payload.len() as u32);\n        self.buf.put_slice(payload);\n    }\n\n    pub fn next_frame(&mut self) -> Option<Bytes> {\n        if self.buf.len() < 4 {\n            return None; // header not complete yet\n        }\n        let len = u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;\n        if self.buf.len() < 4 + len {\n            return None; // body not complete yet\n        }\n        let mut frame = self.buf.split_to(4 + len);\n        frame.advance(4); // drop the length header\n        Some(frame.freeze())\n    }\n}\n\nfn main() {\n    let mut codec = Codec::new();\n    codec.append(b\"first\");\n    codec.append(b\"second\");\n\n    let a = codec.next_frame().unwrap();\n    assert_eq!(&a[..], &b\"first\"[..]);\n    let b = codec.next_frame().unwrap();\n    assert_eq!(&b[..], &b\"second\"[..]);\n    assert!(codec.next_frame().is_none());\n\n    // A partial frame stays buffered until the rest arrives.\n    let mut partial = Codec::new();\n    partial.buf.put_u32(10);\n    partial.buf.put_slice(b\"abc\");\n    assert!(partial.next_frame().is_none());\n}"
      },
      "questions": [
        {
          "q": "Why is cloning a Bytes O(1)?",
          "options": [
            "It increments a reference count and copies an offset and length",
            "It copies the buffer into a new allocation lazily",
            "Bytes stores data in a linked list of chunks",
            "It uses copy-on-write pages provided by the OS"
          ],
          "answer": 0,
          "explain": "Bytes is a shared handle over one allocation. Clone bumps the refcount; the bytes themselves are never copied until you explicitly copy them."
        },
        {
          "q": "You keep a 4-byte Bytes slice taken from a 1 MiB frame in a long-lived map. What is the memory cost?",
          "options": [
            "The full 1 MiB stays alive as long as that slice exists",
            "Only 4 bytes plus the handle",
            "The buffer is copied so only 4 bytes remain",
            "The allocator shrinks the block automatically"
          ],
          "answer": 0,
          "explain": "Slices share the allocation and keep it alive. One small retained view pins the entire buffer until it is dropped."
        },
        {
          "q": "What does BytesMut::freeze() do?",
          "options": [
            "Converts the unique buffer into an immutable shared Bytes without copying",
            "Writes the buffer to disk",
            "Copies the buffer into a new allocation",
            "Prevents further reads"
          ],
          "answer": 0,
          "explain": "Freeze transfers ownership of the existing allocation into the immutable handle, so the bytes never move. It is the handoff point between building and sharing."
        }
      ],
      "quickbytes": [
        "Return Bytes from parsers, not Vec<u8>, so downstream stages can share the buffer.",
        "copy_from_slice at the boundary where the big buffer should stop being retained.",
        "Check the length prefix before split_to; an unchecked split can panic on a truncated frame."
      ],
      "production": [
        "Cap the BytesMut reserve size per connection, or one slow peer can grow it without bound.",
        "Never store a Bytes slice of a large buffer in a long-lived structure without copying it out.",
        "Return Bytes from frame decoders so fan-out is a refcount rather than a memcpy.",
        "Test the codec with a frame delivered one byte at a time; partial frames are the normal case on a socket."
      ],
      "crates": [
        "bytes",
        "tokio-util"
      ],
      "github": [
        {
          "name": "tokio-rs/bytes",
          "url": "https://github.com/tokio-rs/bytes"
        }
      ],
      "pitfall": "A parser that returns Bytes slices of its input buffer keeps every input buffer alive for as long as any parsed field survives, turning a streaming parser into a memory amplifier.",
      "resources": [
        {
          "title": "bytes 1.12: Bytes, BytesMut, Buf, BufMut",
          "url": "https://docs.rs/bytes/latest/bytes/",
          "kind": "docs"
        },
        {
          "title": "tokio-rs/bytes repository",
          "url": "https://github.com/tokio-rs/bytes",
          "kind": "repo"
        },
        {
          "title": "Jon Gjengset: Rust internals and performance streams",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ]
    },
    {
      "id": "b17",
      "n": 17,
      "title": "Roaring bitmaps: compressed sets of integers",
      "minutes": 70,
      "level": "advanced",
      "goal": "Understand the three container types behind Roaring, run set algebra on integer sets, and know when it beats HashSet<u32> and a raw bitset.",
      "sections": [
        {
          "h": "Chunked containers",
          "p": [
            "Roaring partitions the 32-bit space into chunks of 65,536 values. Each chunk is stored in the cheapest of three containers: a sorted array of u16 for sparse chunks up to 4,096 values, an 8 KiB bitmap for dense chunks, and a run-length container for long consecutive runs. Operations dispatch per container, so intersecting two sparse chunks merges sorted arrays instead of scanning 8 KiB of zeroes.",
            "That hybrid is why Roaring beats both extremes. A HashSet<u32> costs a hash-table entry per value, and a raw bitset costs 512 MiB for the full 32-bit range. Roaring costs bytes proportional to the structure of the data, and its serialized form is portable across implementations."
          ],
          "list": [
            "Sorted arrays for sparse chunks, bitmaps for dense, runs for long intervals",
            "Set algebra is per container, so AND and OR skip unused ranges",
            "The serialized format is interoperable and often smaller than a HashSet dump",
            "Iteration is in ascending order, which a HashSet cannot offer"
          ],
          "tip": "Roaring is a set of integers, not a set of keys: if your ids are hashes, sort the domain first."
        },
        {
          "h": "Set algebra on ids",
          "p": [
            "Roaring is the right structure whenever the domain is dense integers and the query is a set operation: inverted indexes, permission sets, cohort analysis, feature-flag targeting. Intersecting a user's group ids with a document's allowed groups is a handful of word operations rather than a nested loop over two hash sets.",
            "roaring 0.12 implements the standard operators: & intersects, | unions, - differences, ^ symmetric difference. rank answers how many values are at most x, and select returns the nth set bit, which makes pagination over a bitmap cheap and stable."
          ],
          "code": "use roaring::RoaringBitmap;\n\nfn main() {\n    let mut allowed = RoaringBitmap::new();\n    for id in [1u32, 2, 3, 1_000, 70_000] {\n        allowed.insert(id);\n    }\n\n    let mut requested = RoaringBitmap::new();\n    for id in [2u32, 3, 4, 70_000, 200_000] {\n        requested.insert(id);\n    }\n\n    let granted = &allowed & &requested;\n    assert_eq!(granted.len(), 3);\n    assert!(granted.contains(70_000));\n    assert!(!granted.contains(4));\n\n    let missing = &requested - &allowed;\n    assert_eq!(missing.len(), 2);\n\n    // Sorted iteration and rank-based queries come for free.\n    let ordered: Vec<u32> = granted.iter().collect();\n    assert_eq!(ordered, [2, 3, 70_000]);\n    assert_eq!(granted.rank(3), 2); // two values <= 3\n\n    // The serialized form is compact and portable across implementations.\n    let mut bytes = Vec::new();\n    granted.serialize_into(&mut bytes).unwrap();\n    let restored = RoaringBitmap::deserialize_from(&bytes[..]).unwrap();\n    assert_eq!(restored, granted);\n    println!(\"{} values in {} bytes\", granted.len(), bytes.len());\n}"
        },
        {
          "h": "When not to use it",
          "p": [
            "Roaring is not a replacement for a hash set of arbitrary keys, and it is not automatically smaller than a bitset for a small dense domain: a 1,000-bit bitset is 125 bytes, while Roaring carries container headers. Below a few hundred values a sorted Vec<u32> is smaller and faster to build and iterate.",
            "It also fits poorly when the domain is huge, sparse, and uniformly random, where a hash set or a Bloom filter wins. Roaring shines when values cluster: database ids, days since epoch, user cohorts - not uniformly distributed 32-bit hashes."
          ],
          "tip": "Benchmark against a sorted Vec<u32> below a thousand elements; Roaring headers are not free at small sizes."
        }
      ],
      "exercise": {
        "prompt": "Model document permissions as Roaring bitmaps: build an index of group id to document bitmap, then answer \"which documents can groups 3, 9, and 12 together read?\" by unioning their bitmaps and returning sorted document ids.",
        "starter": "use roaring::RoaringBitmap;\nuse std::collections::HashMap;\n\npub fn visible(index: &HashMap<u32, RoaringBitmap>, groups: &[u32]) -> Vec<u32> {\n    unimplemented!()\n}",
        "hint": "Start from an empty RoaringBitmap and OR each group's bitmap into it; iter() already yields ascending ids.",
        "solution": "use roaring::RoaringBitmap;\nuse std::collections::HashMap;\n\npub fn visible(index: &HashMap<u32, RoaringBitmap>, groups: &[u32]) -> Vec<u32> {\n    let mut acc = RoaringBitmap::new();\n    for g in groups {\n        if let Some(docs) = index.get(g) {\n            acc |= docs;\n        }\n    }\n    acc.iter().collect()\n}\n\nfn main() {\n    let mut index: HashMap<u32, RoaringBitmap> = HashMap::new();\n    index.insert(3, RoaringBitmap::from_iter([10u32, 11, 40]));\n    index.insert(9, RoaringBitmap::from_iter([11u32, 12]));\n    index.insert(12, RoaringBitmap::from_iter([40u32, 41]));\n\n    assert_eq!(visible(&index, &[3, 9, 12]), vec![10, 11, 12, 40, 41]);\n    assert_eq!(visible(&index, &[9]), vec![11, 12]);\n    assert!(visible(&index, &[99]).is_empty());\n\n    // Intersection answers the other direction: documents visible to both.\n    let both = &index[&3] & &index[&9];\n    assert_eq!(both.iter().collect::<Vec<_>>(), vec![11]);\n}"
      },
      "questions": [
        {
          "q": "Why does Roaring store each chunk in one of three container types?",
          "options": [
            "Sparse, dense, and run-length data compress best with different representations",
            "To support both 32-bit and 64-bit values",
            "Because hash collisions require a fallback",
            "To make serialization endian-independent"
          ],
          "answer": 0,
          "explain": "A sorted array is compact for a few values, a bitmap is compact when most bits are set, and runs win for long intervals. Per-container dispatch keeps every shape small."
        },
        {
          "q": "What does RoaringBitmap::rank(x) return?",
          "options": [
            "The number of values less than or equal to x",
            "The value at position x",
            "The number of containers",
            "Whether x is present"
          ],
          "answer": 0,
          "explain": "rank is a prefix count, so rank(x) - rank(y) counts values in (y, x]. That makes pagination and percentile queries cheap."
        },
        {
          "q": "Which workload is a poor fit for a Roaring bitmap?",
          "options": [
            "A sparse, uniformly random 32-bit identifier domain",
            "A permission set of small integer group ids",
            "Days since epoch with long consecutive runs",
            "Document ids in a dense range"
          ],
          "answer": 0,
          "explain": "With no locality, every value lands in a different chunk and each chunk pays container overhead. A hash set or Bloom filter is better there."
        }
      ],
      "quickbytes": [
        "Use rank and select for pagination instead of collecting and sorting ids.",
        "Serialized Roaring is interoperable with the Java and Go implementations.",
        "Prefer a sorted Vec<u32> or a plain bitvec bitset below a few hundred values."
      ],
      "production": [
        "Store bitmaps in a portable serialized form and version them if you change the container encoding.",
        "Measure compressed size on real id distributions; uniform random ids defeat the compression.",
        "Cap the number of containers per bitmap when ids come from an untrusted range.",
        "Use rank-based pagination so results stay stable while the set changes."
      ],
      "crates": [
        "roaring",
        "bitvec"
      ],
      "github": [
        {
          "name": "RoaringBitmap/roaring-rs",
          "url": "https://github.com/RoaringBitmap/roaring-rs"
        }
      ],
      "pitfall": "Unioning bitmaps from untrusted id ranges allocates a container per 65,536-value chunk, so a malicious client submitting scattered ids can inflate a permission set far beyond its cardinality.",
      "resources": [
        {
          "title": "roaring 0.12: compressed bitmaps",
          "url": "https://docs.rs/roaring/latest/roaring/",
          "kind": "docs"
        },
        {
          "title": "Better bitmap performance with Roaring bitmaps",
          "url": "https://arxiv.org/abs/1402.6407",
          "kind": "paper"
        },
        {
          "title": "RoaringBitmap/roaring-rs repository",
          "url": "https://github.com/RoaringBitmap/roaring-rs",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "b18",
      "n": 18,
      "title": "Heapless containers for no_std and bounded memory",
      "minutes": 70,
      "level": "advanced",
      "goal": "Replace heap containers with fixed-capacity types, handle capacity errors as normal control flow, and keep stack usage predictable on an embedded target.",
      "sections": [
        {
          "h": "Capacity in the type",
          "p": [
            "heapless 0.9 provides Vec<T, N>, String<N>, Deque, and lock-free queues whose storage is inline and whose capacity is a const parameter. No global allocator is involved, so there is no OOM path, no fragmentation, and no allocator lock - the three properties that make heap use unacceptable in a hard real-time loop.",
            "The price is that capacity is part of the type. A Vec<u8, 64> cannot grow into a 128-byte buffer, and the error is a Result the caller must handle. Pushing past capacity returns an error rather than panicking, so the failure is a branch you can log, count, or shed load on."
          ],
          "list": [
            "Fixed capacity, inline storage, no allocator and no fragmentation",
            "Every growable operation returns Result; capacity errors are control flow",
            "The buffer lives wherever the value lives: stack, static, or inside a struct",
            "Changing capacity changes the type, so it is a compile-time decision"
          ],
          "tip": "A capacity error that reaches production is a sizing bug; make it a metric, not a panic."
        },
        {
          "h": "Queues between interrupt and task",
          "p": [
            "heapless::spsc::Queue is a lock-free single-producer single-consumer ring with a const capacity, designed for the interrupt-to-task handoff. split() gives a Producer and a Consumer; enqueue returns the item back when full, and dequeue returns None when empty. No critical section, no allocator, no priority inversion.",
            "The constraint is real: exactly one producer and one consumer. If an interrupt and a task both produce, you need the MPMC queue or an external lock. Getting this wrong is a data race that compiles cleanly, which is why the type split is worth the ceremony."
          ],
          "code": "use heapless::{String, Vec};\n\nfn main() {\n    let mut v: Vec<u8, 4> = Vec::new();\n    assert!(v.push(1).is_ok());\n    assert!(v.push(2).is_ok());\n    assert!(v.push(3).is_ok());\n    assert!(v.push(4).is_ok());\n    assert!(v.push(5).is_err()); // capacity error, not a panic\n\n    let mut s: String<16> = String::new();\n    s.push_str(\"temp=\").unwrap();\n    s.push_str(\"21.5\").unwrap();\n    assert_eq!(s.as_str(), \"temp=21.5\");\n    assert!(s.push_str(\" and a very long suffix\").is_err());\n\n    // The value owns its storage: no allocator is involved anywhere above.\n    println!(\"inline vec is {} bytes\", core::mem::size_of::<Vec<u8, 4>>());\n}"
        },
        {
          "h": "What you give up",
          "p": [
            "No dynamic growth means you must bound every input. A JSON parser with a 4 KiB buffer rejects larger payloads; a log formatter with a 128-byte String truncates. That is a feature in firmware and a liability in a service, so heapless belongs in no_std code, not in a general-purpose backend.",
            "Stack pressure is the other hazard. A heapless Vec inside a recursive function multiplies its inline array by the stack depth, and embedded linkers give you a small stack without a guard page. Put large buffers in statics or in one task-owned struct, and keep only small capacities in locals."
          ],
          "tip": "Size capacities from the protocol maximum, not from the largest sample you happened to see in testing."
        }
      ],
      "exercise": {
        "prompt": "Implement a no_std sensor frame parser with a heapless buffer: append bytes from an interrupt-safe path, parse \"T=21.5;H=40\" into a heapless String, and return a typed error when the buffer or the value would overflow.",
        "starter": "use heapless::String;\n\npub enum ParseError { TooLong, Malformed }\n\npub struct Frame {\n    pub temperature: String<8>,\n    pub humidity: String<8>,\n}\n\npub fn parse(input: &str) -> Result<Frame, ParseError> {\n    unimplemented!()\n}",
        "hint": "Split on ; and then on =, and push_str into heapless Strings with ? mapped to TooLong. Reject unexpected keys or extra separators as Malformed.",
        "solution": "use heapless::String;\n\n#[derive(Debug, PartialEq)]\npub enum ParseError {\n    TooLong,\n    Malformed,\n}\n\npub struct Frame {\n    pub temperature: String<8>,\n    pub humidity: String<8>,\n}\n\npub fn parse(input: &str) -> Result<Frame, ParseError> {\n    let mut frame = Frame {\n        temperature: String::new(),\n        humidity: String::new(),\n    };\n\n    for field in input.split(';') {\n        let (key, value) = field.split_once('=').ok_or(ParseError::Malformed)?;\n        match key {\n            \"T\" => frame.temperature.push_str(value).map_err(|_| ParseError::TooLong)?,\n            \"H\" => frame.humidity.push_str(value).map_err(|_| ParseError::TooLong)?,\n            _ => return Err(ParseError::Malformed),\n        }\n    }\n\n    if frame.temperature.is_empty() || frame.humidity.is_empty() {\n        return Err(ParseError::Malformed);\n    }\n    Ok(frame)\n}\n\nfn main() {\n    let f = parse(\"T=21.5;H=40\").unwrap();\n    assert_eq!(f.temperature.as_str(), \"21.5\");\n    assert_eq!(f.humidity.as_str(), \"40\");\n\n    assert_eq!(parse(\"T=21.5\").unwrap_err(), ParseError::Malformed);\n    assert_eq!(parse(\"T=123456789;H=40\").unwrap_err(), ParseError::TooLong);\n\n    // No allocation happened: every string lives inline in the Frame.\n    assert!(core::mem::size_of::<Frame>() <= 48);\n}"
      },
      "questions": [
        {
          "q": "What does heapless::Vec::push return when the buffer is full?",
          "options": [
            "An error carrying the rejected value, so capacity handling is explicit",
            "It panics",
            "It silently drops the oldest element",
            "It allocates a larger buffer"
          ],
          "answer": 0,
          "explain": "There is no allocator to fall back on, so the API makes the failure part of the type. Ignoring the Result is a deliberate choice, not an accident."
        },
        {
          "q": "Why does heapless::spsc::Queue split into a Producer and a Consumer?",
          "options": [
            "To enforce the single-producer single-consumer guarantee at compile time",
            "To double the buffer capacity",
            "To allow multiple threads to enqueue",
            "Because the queue cannot be shared by reference"
          ],
          "answer": 0,
          "explain": "The lock-free protocol is only correct with one writer and one reader. The split makes that a type-level invariant instead of a comment."
        },
        {
          "q": "Where is a heapless container a poor fit?",
          "options": [
            "A server handling payloads whose size is chosen by clients",
            "An interrupt handler enqueuing a sensor sample",
            "A fixed-size telemetry frame in firmware",
            "A bootloader parsing a known header layout"
          ],
          "answer": 0,
          "explain": "Client-controlled sizes need either a hard protocol limit or dynamic allocation. Fixed-capacity storage turns an unexpected payload into a rejection."
        }
      ],
      "quickbytes": [
        "Put large heapless buffers in statics or task-owned structs, never on a deep stack.",
        "spsc::Queue::enqueue returns the item on failure, so backpressure is allocation-free.",
        "Tune capacities from the protocol maximum and assert on the resulting struct size."
      ],
      "production": [
        "Convert every capacity error into a counter or a defmt log line; silent truncation is the embedded equivalent of data loss.",
        "Place large buffers in statics and keep locals small to fit a linker-script stack.",
        "Document the maximum frame size the device accepts, and enforce it at the transport boundary.",
        "Use the MPMC queue only when you actually have multiple producers; the SPSC split is a correctness guard."
      ],
      "crates": [
        "heapless",
        "defmt"
      ],
      "github": [
        {
          "name": "rust-embedded/heapless",
          "url": "https://github.com/rust-embedded/heapless"
        }
      ],
      "pitfall": "A heapless Vec declared inside a recursive walker multiplies its inline capacity by the stack depth, and the resulting overflow corrupts memory without a guard page to catch it.",
      "resources": [
        {
          "title": "heapless 0.9: static-friendly containers",
          "url": "https://docs.rs/heapless/latest/heapless/",
          "kind": "docs"
        },
        {
          "title": "rust-embedded/heapless repository",
          "url": "https://github.com/rust-embedded/heapless",
          "kind": "repo"
        },
        {
          "title": "Jon Gjengset: Rust internals and performance streams",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ]
    },
    {
      "id": "b19",
      "n": 19,
      "title": "Persistent structures: cheap snapshots by sharing",
      "minutes": 80,
      "level": "advanced",
      "goal": "Clone a map in O(1) with structural sharing, understand path copying, and know the access-cost trade-off before replacing a BTreeMap.",
      "sections": [
        {
          "h": "Clone is a refcount bump",
          "p": [
            "A persistent data structure is immutable, and its clone shares almost everything with the original. im 15.1's HashMap is a hash-array-mapped trie: a 64-way tree indexed by 6-bit chunks of a 64-bit hash, so a lookup is at most 11 levels and clone is one reference-count increment. An update copies only the nodes on the path to the changed leaf.",
            "That gives O(1) clone and O(log64 n) update, which is the wrong trade for a single-threaded hot loop and exactly right when you must keep old versions. The costs are one allocation per copied node, one indirection per level, and a Clone bound on the values."
          ],
          "list": [
            "Clone is O(1); update copies a path, not the structure",
            "Old versions stay valid forever, so readers never block writers",
            "Values must be Clone, so large payloads belong behind Arc",
            "Each level allocates, which is why point access loses to a flat map"
          ],
          "tip": "Clone the structure, not the values: a persistent map of Arc<T> is the pattern; a persistent map of large T is a memcpy machine."
        },
        {
          "h": "Where snapshots pay",
          "p": [
            "Config versioning, undo stacks, MVCC-style reads, and incremental pipelines all want the same thing: a stable view that neither blocks writers nor costs a full copy. A persistent map gives a reader a handle it can hold forever while the writer creates a new version and publishes it - no lock and no copy.",
            "Because the old version is still a valid value, time travel for debugging is nearly free: keep the last N roots and diff them. The memory cost is proportional to what changed between versions, not to the size of the map."
          ],
          "code": "use im::HashMap;\n\nfn main() {\n    let v1: HashMap<u32, String> = HashMap::new();\n    let mut v2 = v1.clone(); // O(1): shares the whole tree\n    v2.insert(1, \"one\".into());\n    v2.insert(2, \"two\".into());\n\n    let mut v3 = v2.clone();\n    v3.insert(2, \"TWO\".into());\n    v3.remove(&1);\n\n    // The old versions are unchanged and still cheap to read.\n    assert_eq!(v1.len(), 0);\n    assert_eq!(v2.get(&2).map(String::as_str), Some(\"two\"));\n    assert_eq!(v3.get(&2).map(String::as_str), Some(\"TWO\"));\n    assert!(v3.get(&1).is_none());\n\n    // Hand a reader a stable snapshot while writers move on to v3.\n    let snapshot = v2.clone();\n    drop(v2);\n    assert_eq!(snapshot.len(), 2);\n\n    // Diffing two versions only touches the changed path.\n    for key in v3.keys() {\n        if snapshot.get(key) != v3.get(key) {\n            println!(\"changed: {key}\");\n        }\n    }\n}"
        },
        {
          "h": "The price list",
          "p": [
            "Point access is slower than std. Each level is a pointer chase and each node is a separate allocation; the crate itself documents OrdMap as roughly two to three times slower than BTreeMap on basic operations, with HashMap closer to std on lookups and clearly ahead on clone. Persistent structures also retain old nodes until every version referencing them is dropped.",
            "Values must be Clone, so store large payloads as Arc<T>. The usual production shape is a persistent index of Arc<Document>: cloning the index is cheap, and cloning a document never happens. If you do not need old versions, do not pay for them."
          ],
          "tip": "If a reader only needs the current value, an ArcSwap beats a persistent map; persistence pays when history is part of the contract."
        }
      ],
      "exercise": {
        "prompt": "Build a config store that keeps the last three versions and lets a request pin the version it started with. Writes publish a new version; a pinned read must never observe a later write.",
        "starter": "use im::HashMap;\n\npub struct ConfigStore {\n    current: HashMap<String, String>,\n    history: Vec<HashMap<String, String>>,\n}\n\nimpl ConfigStore {\n    pub fn new() -> Self { unimplemented!() }\n    pub fn set(&mut self, key: &str, value: &str) { unimplemented!() }\n    pub fn pinned(&self, version: usize) -> Option<HashMap<String, String>> { unimplemented!() }\n}",
        "hint": "Push a clone of the current map onto history after each write, keep at most three, and return a clone for a pinned read. Cloning an im::HashMap is O(1), so the history costs only the changed nodes.",
        "solution": "use im::HashMap;\n\npub struct ConfigStore {\n    current: HashMap<String, String>,\n    history: Vec<HashMap<String, String>>,\n}\n\nimpl ConfigStore {\n    pub fn new() -> Self {\n        let current = HashMap::new();\n        Self { history: vec![current.clone()], current }\n    }\n\n    pub fn set(&mut self, key: &str, value: &str) {\n        self.current.insert(key.to_string(), value.to_string());\n        self.history.push(self.current.clone());\n        if self.history.len() > 3 {\n            self.history.remove(0);\n        }\n    }\n\n    pub fn pinned(&self, version: usize) -> Option<HashMap<String, String>> {\n        self.history.get(version).cloned()\n    }\n}\n\nfn main() {\n    let mut store = ConfigStore::new();\n    store.set(\"mode\", \"fast\");\n    let pinned = store.pinned(1).unwrap();\n\n    store.set(\"mode\", \"safe\");\n    store.set(\"timeout\", \"5s\");\n\n    // The pinned snapshot is immune to later writes.\n    assert_eq!(pinned.get(\"mode\").map(String::as_str), Some(\"fast\"));\n    assert_eq!(pinned.get(\"timeout\"), None);\n\n    // The newest retained version is at index 2 and sees the timeout write.\n    assert_eq!(\n        store.pinned(2).unwrap().get(\"timeout\").map(String::as_str),\n        Some(\"5s\")\n    );\n\n    // Only the last three versions are retained: index 3 is already gone.\n    assert!(store.pinned(3).is_none());\n}"
      },
      "questions": [
        {
          "q": "Why is cloning an im::HashMap O(1)?",
          "options": [
            "It increments a reference count on the shared root and shares all unchanged nodes",
            "It uses a memcpy of the hash table",
            "It stores values in a Vec and clones lazily",
            "It keeps a global registry of maps"
          ],
          "answer": 0,
          "explain": "The trie is immutable and reference counted. Clone shares the root; only later updates copy the path they touch."
        },
        {
          "q": "What does an update to a persistent HAMT copy?",
          "options": [
            "The nodes on the path from the root to the changed entry",
            "The entire trie",
            "Only the leaf value",
            "Nothing; it mutates in place"
          ],
          "answer": 0,
          "explain": "Path copying is the core trick: nodes outside the path are shared with every older version, so cost scales with depth, not size."
        },
        {
          "q": "When is a persistent map the wrong choice?",
          "options": [
            "A single-threaded loop that only ever reads the current value",
            "Serving old config versions to in-flight requests",
            "Undo history in an editor",
            "Diffing two versions of a large index"
          ],
          "answer": 0,
          "explain": "Without history or concurrent readers, you pay the allocation and indirection overhead for a sharing benefit nobody uses."
        }
      ],
      "quickbytes": [
        "Store Arc<T> in persistent maps; a Clone bound on a large payload turns every update into a copy.",
        "Keep a bounded ring of root versions instead of unbounded history, or memory grows with write rate.",
        "im::Vector is an RRB tree: O(log n) push, pop, split, and concat with O(1) clone."
      ],
      "production": [
        "Bound version retention explicitly; persistent structures keep every reachable version alive.",
        "Measure point-lookup cost against the std type you are replacing, at production sizes.",
        "Publish new versions atomically (ArcSwap or a lock) so readers never see a half-built map.",
        "Wrap large values in Arc before they enter the structure."
      ],
      "crates": [
        "im",
        "arc-swap"
      ],
      "github": [
        {
          "name": "bodil/im-rs",
          "url": "https://github.com/bodil/im-rs"
        }
      ],
      "pitfall": "Keeping every published version forever to support time travel pins every changed node, so memory grows with write rate rather than with the size of the current state.",
      "resources": [
        {
          "title": "im 15.1: immutable collections",
          "url": "https://docs.rs/im/latest/im/",
          "kind": "docs"
        },
        {
          "title": "bodil/im-rs repository",
          "url": "https://github.com/bodil/im-rs",
          "kind": "repo"
        },
        {
          "title": "fasterthanlime: Rust systems programming videos",
          "url": "https://www.youtube.com/@fasterthanlime",
          "kind": "video"
        }
      ]
    },
    {
      "id": "b20",
      "n": 20,
      "title": "Benchmarking containers without lying to yourself",
      "minutes": 90,
      "level": "industry",
      "goal": "Measure the operation you care about at a realistic size and distribution, and know which tool answers which performance question.",
      "sections": [
        {
          "h": "Measure the right operation",
          "p": [
            "A container benchmark fails in four predictable ways: it measures a structure so small that the optimiser folds the answer away, it uses uniform keys when production is Zipfian, it includes construction in the timed section, and it reports the mean when the decision depends on p99. Any one of these can invert the conclusion.",
            "criterion 0.8 gives groups, throughput, and statistical comparison against a saved baseline. Use iter_batched to separate setup from the timed loop, std::hint::black_box (criterion::black_box is deprecated) to stop the optimiser deleting the work, and Throughput::Elements so the report is nanoseconds per element rather than per iteration."
          ],
          "list": [
            "Benchmark at production sizes: 100, 10k, 1M, 10M - the crossover is the interesting part",
            "Model the key distribution, not just the key count",
            "Exclude setup with iter_batched, and never benchmark an empty container",
            "Save a baseline before the change and compare against it, not against memory"
          ],
          "tip": "A benchmark that does not name its distribution and size is an anecdote with error bars.",
          "code": "use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};\nuse std::collections::HashMap;\nuse std::hint::black_box;\n\nfn bench_lookup(c: &mut Criterion) {\n    let mut group = c.benchmark_group(\"hashmap_get\");\n\n    for n in [1_000usize, 100_000, 1_000_000] {\n        let map: HashMap<u64, u64> = (0..n as u64).map(|i| (i, i * 2)).collect();\n        let keys: Vec<u64> = (0..n as u64).collect();\n\n        group.throughput(Throughput::Elements(keys.len() as u64));\n        group.bench_with_input(BenchmarkId::from_parameter(n), &n, |b, _| {\n            b.iter(|| {\n                let mut sum = 0u64;\n                for k in &keys {\n                    sum += *map.get(black_box(k)).unwrap();\n                }\n                black_box(sum)\n            });\n        });\n    }\n    group.finish();\n}\n\ncriterion_group!(benches, bench_lookup);\ncriterion_main!(benches);"
        },
        {
          "h": "Distributions and sizes",
          "p": [
            "Run the same benchmark across sizes. Hash maps and B-trees cross over as the working set leaves L2 and then L3, and a result at 1k says nothing about 1M. For caches, model the request distribution - uniform, Zipf with the exponent you actually observe, or a replay of production traces - because hit ratio depends on skew as much as on size.",
            "Separate cold from warm. A cold lookup includes page faults and cache misses; a warm lookup may hit a structure that fits in L1. Production is usually neither, so publish both numbers and say which one the SLO refers to."
          ]
        },
        {
          "h": "Beyond wall-clock",
          "p": [
            "Wall-clock benchmarks are noisy on shared CI runners. Two complements: instruction counts from cachegrind, which are nearly deterministic and catch codegen regressions, and allocation counts from a counting global allocator or dhat, which catch the hidden clone. A change that keeps time flat but doubles allocations is a regression waiting for a busier machine.",
            "For cache behaviour the decisive number is often the miss rate rather than the time. perf stat -e cache-misses,cache-references tells you whether the structure is spilling out of L2, and that number is far more stable across machines than nanoseconds."
          ],
          "code": "# Cargo.toml\n[dev-dependencies]\ncriterion = { version = \"0.8\", features = [\"html_reports\"] }\niai-callgrind = \"0.14\"   # pin to the current release\n\n[[bench]]\nname = \"containers\"\nharness = false\n\n[[bench]]\nname = \"instructions\"\nharness = false\n\n# Save a baseline, change the code, compare against it.\ncargo bench --bench containers -- --save-baseline before\ncargo bench --bench containers -- --baseline before\n\n# Deterministic instruction counts: good on noisy CI runners.\ncargo bench --bench instructions\n\n# Where the time actually goes: misses, not just nanoseconds.\nperf stat -e cache-misses,cache-references,instructions \\\n    target/release/deps/containers-*"
        }
      ],
      "exercise": {
        "prompt": "Benchmark a hit-heavy lookup path against a miss-heavy one for the same map, at three sizes, and report ns/element for each. Use a deterministic pseudo-random key source so the run is reproducible, and black_box the result.",
        "starter": "use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};\nuse std::collections::HashMap;\nuse std::hint::black_box;\n\nfn bench(c: &mut Criterion) {\n    // 3 sizes x {hit, miss}, throughput in elements\n}\n\ncriterion_group!(benches, bench);\ncriterion_main!(benches);",
        "hint": "Build the map once per size outside the timed closure. Use a small linear congruential generator for keys, and choose hit keys as existing keys and miss keys as values above the map size.",
        "solution": "use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};\nuse std::collections::HashMap;\nuse std::hint::black_box;\n\nfn lcg(state: &mut u64) -> u64 {\n    *state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);\n    *state\n}\n\nfn bench(c: &mut Criterion) {\n    let mut group = c.benchmark_group(\"lookup_hit_vs_miss\");\n\n    for n in [1_000u64, 100_000, 1_000_000] {\n        let map: HashMap<u64, u64> = (0..n).map(|i| (i, i * 2)).collect();\n        let mut state = 42u64;\n        let hits: Vec<u64> = (0..1_024).map(|_| lcg(&mut state) % n).collect();\n        let misses: Vec<u64> = (0..1_024).map(|_| n + lcg(&mut state) % n).collect();\n\n        group.throughput(Throughput::Elements(hits.len() as u64));\n        for (label, keys) in [(\"hit\", &hits), (\"miss\", &misses)] {\n            group.bench_with_input(BenchmarkId::new(label, n), keys, |b, keys| {\n                b.iter(|| {\n                    let mut found = 0u64;\n                    for k in keys {\n                        found += u64::from(map.get(black_box(k)).is_some());\n                    }\n                    black_box(found)\n                });\n            });\n        }\n    }\n    group.finish();\n}\n\ncriterion_group!(benches, bench);\ncriterion_main!(benches);"
      },
      "questions": [
        {
          "q": "Why does a benchmark need std::hint::black_box around the result?",
          "options": [
            "Without it the optimiser can prove the work is unused and delete the whole loop",
            "It pins the thread to one core",
            "It disables the branch predictor",
            "It forces a heap allocation"
          ],
          "answer": 0,
          "explain": "black_box is an opaque use of the value, so the compiler must materialise it. Without it, dead-code elimination can reduce the benchmark to an empty loop."
        },
        {
          "q": "What does criterion's iter_batched separate?",
          "options": [
            "Per-iteration setup from the timed routine, so construction is not measured",
            "Reads from writes",
            "Threads from async tasks",
            "Compilation from execution"
          ],
          "answer": 0,
          "explain": "iter_batched runs setup outside the measured region and passes the prepared input into the timed closure, removing setup cost from the sample."
        },
        {
          "q": "Which measurement is most useful on a noisy shared CI runner?",
          "options": [
            "Instruction counts from cachegrind, which barely vary between runs",
            "Mean wall-clock time",
            "Peak RSS",
            "Compile time"
          ],
          "answer": 0,
          "explain": "Instruction counts are deterministic for the same binary and catch codegen changes that wall-clock noise hides. Use them as a gate, and wall-clock for capacity planning."
        }
      ],
      "quickbytes": [
        "cargo bench -- --save-baseline before, then --baseline before after the change.",
        "Report ns/element with Throughput::Elements so different sizes are comparable.",
        "Profile allocations separately; time and allocation count often move in opposite directions."
      ],
      "production": [
        "Gate merges on a benchmark at production size with a stated key distribution, not a microbenchmark at 100 elements.",
        "Keep a saved baseline in CI and fail on a regression beyond a stated threshold.",
        "Pair wall-clock numbers with instruction counts so noise does not mask a codegen change.",
        "Re-benchmark when the allocator, Rust version, or CPU generation changes; those move container results more than most code changes."
      ],
      "crates": [
        "criterion",
        "dhat"
      ],
      "github": [
        {
          "name": "criterion-rs/criterion.rs",
          "url": "https://github.com/criterion-rs/criterion.rs"
        }
      ],
      "pitfall": "Benchmarking with a uniform random key distribution on a 1,000-entry map and extrapolating to a million entries inverts the HashMap-versus-BTreeMap conclusion, because the crossover is a cache effect, not an algorithmic one.",
      "resources": [
        {
          "title": "criterion 0.8: statistics-driven benchmarks",
          "url": "https://docs.rs/criterion/latest/criterion/",
          "kind": "docs"
        },
        {
          "title": "criterion-rs/criterion.rs repository",
          "url": "https://github.com/criterion-rs/criterion.rs",
          "kind": "repo"
        },
        {
          "title": "std::hint::black_box",
          "url": "https://doc.rust-lang.org/std/hint/fn.black_box.html",
          "kind": "docs"
        },
        {
          "title": "SIEVE is Simpler than LRU: evaluation methodology in practice",
          "url": "https://www.usenix.org/conference/nsdi24/presentation/zhang-yazhuo",
          "kind": "paper"
        }
      ]
    }
  ]
};
