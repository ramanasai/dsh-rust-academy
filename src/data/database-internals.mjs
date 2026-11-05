/**
 * Database internals track.
 *
 * Versions checked against docs.rs while writing (Nov 2026):
 *   redb 4.4.0, crc32fast 1.5.4, bytes 1.12.1, tempfile 3.27.0,
 *   criterion 0.8.2, sqlx 0.9.0, rusqlite 0.41.1, parking_lot 0.13.0,
 *   openraft 0.9.25, refinery 0.10.0.
 * Server behaviour is quoted from the PostgreSQL 18 manual.
 *
 * Data is plain JSON-compatible values consumed by build.mjs.
 */
export default {
  key: 'database-internals',
  prefix: 'c',
  title: 'Database internals',
  blurb: 'What happens inside a database: pages, indexes, WAL, MVCC, query planning, replication and sharding.',
  level: 'industry',
  project: {
    title: 'Capstone: a miniature storage engine',
    brief:
      'Build a durable key-value engine from the disk up: 8 KiB slotted pages with checksums, a write-ahead log with group commit, an index that supports ordered range scans, and recovery that replays the log after a kill -9. Then benchmark it against SQLite on the same workload and explain every number you report.',
    deliverables: [
      'Page-oriented storage with a slotted layout, per-page CRC32 checksums, and a free-space map.',
      'A write-ahead log with framed records, group commit, and a checkpoint that bounds recovery time.',
      'Crash-recovery tests that kill the process mid-write and assert every acknowledged commit survives.',
      'A B+tree or LSM index supporting point lookups and ordered range scans, with measured amplification.',
      'A criterion benchmark comparing the engine to SQLite through rusqlite on identical workloads.',
    ],
    stack: ['crc32fast', 'bytes', 'tempfile', 'criterion'],
  },
  lessons: [
    {
      id: 'c01',
      n: 1,
      title: 'Storage engines: what an engine owes you',
      minutes: 60,
      level: 'core',
      goal: 'Separate the storage engine from the database above it, state the three-part contract it must keep, and choose between heap, B+tree and LSM shapes using amplification numbers.',
      sections: [
        {
          h: 'An engine is not a database',
          p: [
            'A storage engine owns bytes on disk and answers four operations: point lookup, insert-or-update, delete, and ordered range scan. It does not parse SQL, choose indexes, or decide which row versions a transaction may see. Everything above that line - parser, planner, executor, MVCC - is the database, and every one of those layers assumes the engine contract holds.',
            'The contract has three parts, and all three are easy to get subtly wrong. Durability: after commit returns, the data survives a power cut. Atomicity: a batch lands entirely or not at all. Ordering: a range scan returns keys in byte order, which is what makes secondary indexes possible at all. Write those down before coding, because every later design argument is about their price.',
          ],
          code: `use bytes::Bytes;

/// The whole contract an engine owes the layer above it.
pub trait StorageEngine {
    type Error: std::error::Error + Send + Sync + 'static;

    fn get(&self, key: &[u8]) -> Result<Option<Bytes>, Self::Error>;

    /// Inserts or overwrites. Invisible to \`get\` until commit.
    fn put(&mut self, key: &[u8], value: &[u8]) -> Result<(), Self::Error>;

    fn delete(&mut self, key: &[u8]) -> Result<(), Self::Error>;

    /// Half-open range, ascending byte order.
    fn range(&self, start: &[u8], end: &[u8]) -> Result<Vec<(Bytes, Bytes)>, Self::Error>;

    /// Returns only after the batch is durable (fsync or equivalent).
    fn commit(&mut self) -> Result<(), Self::Error>;
}`,
          tip: 'If a method can return before the bytes are on stable storage, its name must not be commit. Naming is the cheapest correctness documentation you have.',
        },
        {
          h: 'Heap, B+tree, log-structured: pick a shape',
          p: [
            'Three families dominate. A heap file appends records and keeps separate index structures pointing at them, which is what PostgreSQL does. An index-organized store keeps rows inside a B+tree keyed by primary key, which is what InnoDB and redb do. A log-structured merge tree buffers writes in memory and flushes immutable sorted files, which is what RocksDB and LevelDB do.',
            'The shape fixes your amplification profile. An in-place B+tree pays one page write per update plus the log, and roughly one page read per lookup. An LSM tree turns random writes into sequential ones, but a point lookup may touch a memtable plus several levels, and compaction rewrites the same bytes repeatedly. Neither is better; they are different budgets, and the budget you can afford depends on the workload.',
          ],
          list: [
            'Write amplification: bytes written to the device per byte of logical write. LSM compaction makes this the dominant cost.',
            'Read amplification: pages touched per logical read. A deep B+tree costs a descent; an LSM costs one probe per candidate run.',
            'Space amplification: on-disk bytes divided by live bytes. Deleted-but-not-compacted data and page fragmentation both show up here.',
          ],
        },
        {
          h: 'Choosing with numbers, not vibes',
          p: [
            'A three-level leveled LSM with a size ratio of 10 rewrites each byte about 30 times before it reaches the bottom level; an in-place B+tree update is close to one page write. If the workload is 95 percent point reads with a tight p99, the B+tree is usually the better default. If it is append-heavy telemetry where reads are scans, the LSM wins because its writes are sequential.',
            'The way to settle it is to measure amplification on your own trace rather than trust a benchmark post. Replay a day of production operations against both engines, record device bytes written and pages read, and compare those two numbers with the SLO you actually promised.',
          ],
          code: `# Cargo.toml
[dependencies]
redb = "4.4"
bytes = "1.12"
tempfile = "3.27"

# src/main.rs
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};

const KV: TableDefinition<&str, &str> = TableDefinition::new("kv");

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let file = tempfile::NamedTempFile::new()?;
    let db = Database::create(file.path())?;

    let write = db.begin_write()?;
    {
        let mut table = write.open_table(KV)?;
        table.insert("user:1", "ada")?;
        table.insert("user:2", "grace")?;
    }
    write.commit()?; // both rows, or neither

    let read = db.begin_read()?;
    let table = read.open_table(KV)?;
    for entry in table.range("user:1".."user:3")? {
        let (key, value) = entry?;
        println!("{} = {}", key.value(), value.value());
    }
    Ok(())
}`,
          tip: 'redb is copy-on-write: a read transaction never blocks a writer and never sees a torn page. You pay in write amplification and in space that is only reclaimed by later commits.',
        },
      ],
      exercise: {
        prompt:
          'Implement the StorageEngine trait over a BTreeMap with commit as a no-op, then write down exactly which clause of the contract you just broke and what a crash at the wrong moment would lose.',
        starter: `use bytes::Bytes;
use std::collections::BTreeMap;

pub struct MemoryEngine {
    data: BTreeMap<Vec<u8>, Bytes>,
    pending: Vec<(Vec<u8>, Option<Bytes>)>,
}

impl MemoryEngine {
    pub fn new() -> Self {
        Self { data: BTreeMap::new(), pending: Vec::new() }
    }
}

// TODO: implement get/put/delete/range/commit.
// put() must not be visible to get() before commit().`,
        hint: 'Buffer mutations in pending and apply them in commit. Then answer honestly: a process crash loses everything, so only the atomicity clause holds, not durability.',
        solution: `use bytes::Bytes;
use std::collections::BTreeMap;
use std::ops::Bound;

pub struct MemoryEngine {
    data: BTreeMap<Vec<u8>, Bytes>,
    pending: Vec<(Vec<u8>, Option<Bytes>)>,
}

impl MemoryEngine {
    pub fn new() -> Self {
        Self { data: BTreeMap::new(), pending: Vec::new() }
    }

    pub fn get(&self, key: &[u8]) -> Option<Bytes> {
        // Uncommitted writes stay invisible: read the committed map only.
        self.data.get(key).cloned()
    }

    pub fn put(&mut self, key: &[u8], value: &[u8]) {
        self.pending.push((key.to_vec(), Some(Bytes::copy_from_slice(value))));
    }

    pub fn delete(&mut self, key: &[u8]) {
        self.pending.push((key.to_vec(), None));
    }

    pub fn range(&self, start: &[u8], end: &[u8]) -> Vec<(Bytes, Bytes)> {
        self.data
            .range::<[u8], _>((Bound::Included(start), Bound::Excluded(end)))
            .map(|(k, v)| (Bytes::copy_from_slice(k), v.clone()))
            .collect()
    }

    /// Atomic in memory, not durable: the process exiting loses everything.
    pub fn commit(&mut self) {
        for (key, value) in self.pending.drain(..) {
            match value {
                Some(bytes) => { self.data.insert(key, bytes); }
                None => { self.data.remove(&key); }
            }
        }
    }
}`,
      },
      questions: [
        {
          q: 'Which guarantee does an embedded key-value engine typically NOT give you out of the box?',
          options: [
            'Crash-consistent writes after commit returns',
            'Ordered range scans over keys',
            'SQL planning and automatic secondary-index maintenance',
            'Point lookups by key',
          ],
          answer: 2,
          explain:
            'An engine gives you durability, atomicity and key order. Parsing SQL, picking indexes and keeping secondary indexes in sync is the database layer built on top of it.',
        },
        {
          q: 'A workload is 99 percent point reads over a working set that fits in RAM, with rare bulk loads. Which shape is the better default?',
          options: [
            'LSM tree, because it turns writes into sequential I/O',
            'B+tree, because a lookup is one descent and there is no compaction rewriting',
            'Heap file with no index at all',
            'Whichever binary is smaller',
          ],
          answer: 1,
          explain:
            'When reads dominate and writes are rare, compaction buys nothing and its write amplification and background I/O hurt tail latency. One B+tree descent per lookup is the cheaper path.',
        },
        {
          q: 'What does write amplification measure?',
          options: [
            'Bytes written to storage per byte of logical write',
            'The ratio of cache misses to cache hits',
            'The number of indexes on a table',
            'The time spent in fsync',
          ],
          answer: 0,
          explain:
            'Write amplification is a byte ratio, not a latency. A value of 30 means the device writes thirty bytes for every byte your application committed, which caps device lifetime and steals I/O bandwidth.',
        },
      ],
      quickbytes: [
        'State durability, atomicity and ordering in the README before the first commit; every later design argument is about their cost.',
        'If a method can return before the bytes are durable, it is not a commit. Rename it.',
        'Replay a production trace and compare device bytes written against logical bytes before picking an engine.',
      ],
      production: [
        'Every service records which storage engine it uses and why, so operators are not surprised by compaction storms.',
        'Alert on device write amplification, not just on query latency; compaction and checkpointing show up there first.',
        'Test recovery, not only steady state: kill -9 during a write burst and assert the last acknowledged commit survived.',
        'Keep the engine behind a trait so a later swap does not leak engine-specific types into business logic.',
      ],
      crates: ['redb', 'bytes', 'tempfile'],
      github: [{ name: 'cberner/redb', url: 'https://github.com/cberner/redb' }],
      pitfall:
        'Treating an embedded key-value store as a database: you get durability and ordered scans, but no SQL, no secondary indexes and no cross-table constraints. Every one of those becomes application code you now own.',
      resources: [
        { title: 'redb crate documentation', url: 'https://docs.rs/redb/latest/redb/', kind: 'docs' },
        { title: 'cberner/redb source and design notes', url: 'https://github.com/cberner/redb', kind: 'repo' },
        { title: 'bytes: zero-copy buffers for page and record data', url: 'https://docs.rs/bytes/latest/bytes/', kind: 'docs' },
      ],
    },
    {
      id: 'c02',
      n: 2,
      title: 'Page layout: slotted pages and checksums',
      minutes: 75,
      level: 'core',
      goal: 'Lay out a fixed-size page with a header, slot array and record area, verify it with a CRC32 on read, and compact it when fragmentation eats the free space.',
      sections: [
        {
          h: 'The page is the unit of I/O',
          p: [
            'Databases do not read records, they read pages: usually 4 to 16 KiB, because that is what the storage stack moves efficiently and what fsync and checksums can protect as a unit. A 60-byte row still costs a page read. That one fact explains buffer pools, fill factors, and why a wide table with one hot column is slow.',
            'A slotted page packs variable-length records into a fixed-size block. The header at offset zero holds the page id, the log sequence number of the last change, the slot count and two free-space offsets. Slot entries grow forward from the header, record bytes grow backward from the end, and the gap in the middle is the free space.',
          ],
          code: `pub const PAGE_SIZE: usize = 8192;
const CHECKSUM_LEN: usize = 4;
const SLOT_LEN: usize = 4;

#[repr(C)]
pub struct PageHeader {
    pub page_id: u32,
    pub lsn: u64,        // WAL position of the last change to this page
    pub slot_count: u16,
    pub free_start: u16, // first byte after the slot array
    pub free_end: u16,   // first byte of the record area
    pub flags: u16,      // 0b01 dirty, 0b10 has_overflow
}

impl PageHeader {
    pub fn encode(&self, page: &mut [u8]) {
        page[0..4].copy_from_slice(&self.page_id.to_le_bytes());
        page[4..12].copy_from_slice(&self.lsn.to_le_bytes());
        page[12..14].copy_from_slice(&self.slot_count.to_le_bytes());
        page[14..16].copy_from_slice(&self.free_start.to_le_bytes());
        page[16..18].copy_from_slice(&self.free_end.to_le_bytes());
        page[18..20].copy_from_slice(&self.flags.to_le_bytes());
    }

    pub fn decode(page: &[u8]) -> Self {
        Self {
            page_id: u32::from_le_bytes(page[0..4].try_into().unwrap()),
            lsn: u64::from_le_bytes(page[4..12].try_into().unwrap()),
            slot_count: u16::from_le_bytes(page[12..14].try_into().unwrap()),
            free_start: u16::from_le_bytes(page[14..16].try_into().unwrap()),
            free_end: u16::from_le_bytes(page[16..18].try_into().unwrap()),
            flags: u16::from_le_bytes(page[18..20].try_into().unwrap()),
        }
    }
}`,
          tip: 'Store offsets, never pointers. A page that is mmapped at a different address after restart must decode to the same values.',
        },
        {
          h: 'A checksum that catches torn writes',
          p: [
            'A crash during a page write can leave the first half new and the second half old. A CRC32 over the page body detects that on the next read, turning silent corruption into a clean error. Compute it last, after the header is final, and cover the header too; a checksum that skips the header cannot catch a torn header write.',
            'CRC32 is not cryptographic and does not need to be. It is there to detect accidental corruption and torn writes, at a couple of gigabytes per second on modern hardware. crc32fast picks an SSE or aarch64 implementation at runtime through Hasher::new, so the cost stays in the noise next to the I/O.',
          ],
          code: `use crc32fast::Hasher;

#[derive(Debug)]
pub enum PageError {
    Checksum { stored: u32, actual: u32 },
    Corrupt(&'static str),
}

/// Call after every mutation, once the header is final.
pub fn seal(page: &mut [u8]) {
    let n = page.len();
    let crc = crc32fast::hash(&page[..n - CHECKSUM_LEN]);
    page[n - CHECKSUM_LEN..].copy_from_slice(&crc.to_le_bytes());
}

pub fn verify(page: &[u8]) -> Result<(), PageError> {
    let n = page.len();
    let stored = u32::from_le_bytes(page[n - CHECKSUM_LEN..].try_into().unwrap());
    let actual = crc32fast::hash(&page[..n - CHECKSUM_LEN]);
    if stored == actual {
        Ok(())
    } else {
        Err(PageError::Checksum { stored, actual })
    }
}

/// Streaming variant: hash the header and records in separate chunks so the
/// buffer pool does not have to copy the page into one contiguous slice.
pub fn seal_chunked(header: &[u8], records: &[u8]) -> u32 {
    let mut hasher = Hasher::new();
    hasher.update(header);
    hasher.update(records);
    hasher.finalize()
}`,
          tip: 'Verify before you parse. A corrupt free_end offset read into a slice index panics or, worse, reads attacker-controlled memory.',
        },
        {
          h: 'Compaction and the fragmentation tax',
          p: [
            'Deleting a record leaves a hole, and a smaller replacement may not fit into it. Track the largest contiguous free run rather than total free bytes: a page with 3 KiB free in forty fragments cannot accept a 1 KiB record. When the largest run is too small, compaction rewrites live records toward the end of the page and rebuilds the slot array.',
            'Compaction is linear in page size but must run under an exclusive latch, so a page that compacts on every insert becomes a contention point. In practice you compact lazily, when a record does not fit but total free space would allow it, and you record the new offsets in the slot array in the same critical section.',
          ],
          code: `pub const TOMBSTONE: u16 = u16::MAX;

/// Move live records toward the end of the page and rewrite slot offsets.
/// Returns the new contiguous free space in bytes.
pub fn compact(page: &mut [u8], slot_offset: impl Fn(usize) -> usize) -> usize {
    let mut header = PageHeader::decode(page);
    let slots: Vec<u16> = (0..header.slot_count as usize)
        .map(|i| u16::from_le_bytes(page[slot_offset(i)..slot_offset(i) + 2].try_into().unwrap()))
        .collect();

    let mut write = PAGE_SIZE - CHECKSUM_LEN;
    let mut moved = Vec::with_capacity(slots.len());

    for slot in slots {
        if slot == TOMBSTONE {
            moved.push(TOMBSTONE);
            continue;
        }
        let start = slot as usize;
        let len = u16::from_le_bytes(page[start..start + 2].try_into().unwrap()) as usize;
        write -= len;
        page.copy_within(start..start + len, write); // memmove: overlap is fine
        moved.push(write as u16);
    }

    for (i, slot) in moved.iter().enumerate() {
        page[slot_offset(i)..slot_offset(i) + 2].copy_from_slice(&slot.to_le_bytes());
    }
    header.free_end = write as u16;
    header.encode(page);
    (header.free_end - header.free_start) as usize
}`,
          tip: 'Record the page LSN in the header on every mutation. Recovery uses it to decide whether a redo record still needs to be applied.',
        },
      ],
      exercise: {
        prompt:
          'Write insert_record so it first tries the contiguous gap, then compacts once and retries, and finally reports NoSpace. Add a debug assertion that the page checksum verifies after every successful insert.',
        starter: `pub fn insert_record(page: &mut [u8], record: &[u8]) -> Result<u16, PageError> {
    let header = PageHeader::decode(page);
    let need = record.len() + 2 + SLOT_LEN;
    // TODO: 1) try the gap between free_start and free_end
    //       2) on failure, compact() once and retry
    //       3) otherwise return PageError::Corrupt("no space")
    let _ = (header, need);
    todo!()
}`,
        hint: 'Compaction moves records but not the slot array, so free_start is unchanged; only free_end changes. Check the checksum with verify() in a debug_assert! after seal().',
        solution: `pub fn insert_record(page: &mut [u8], record: &[u8]) -> Result<u16, PageError> {
    let need = record.len() + 2 + SLOT_LEN;
    let mut header = PageHeader::decode(page);

    let mut gap = (header.free_end - header.free_start) as usize;
    if gap < need {
        gap = compact(page, |i| 32 + i * SLOT_LEN);
        header = PageHeader::decode(page);
        if gap < need {
            return Err(PageError::Corrupt("no space"));
        }
    }

    // Record grows downward, slot grows upward.
    let rec_start = header.free_end as usize - record.len();
    page[rec_start..rec_start + 2].copy_from_slice(&(record.len() as u16).to_le_bytes());
    page[rec_start + 2..rec_start + 2 + record.len()].copy_from_slice(record);

    let slot = 32 + header.slot_count as usize * SLOT_LEN;
    page[slot..slot + 2].copy_from_slice(&(rec_start as u16).to_le_bytes());

    header.slot_count += 1;
    header.free_start += SLOT_LEN as u16;
    header.free_end = rec_start as u16;
    header.encode(page);
    seal(page);
    debug_assert!(verify(page).is_ok());
    Ok((header.slot_count - 1) as u16)
}`,
      },
      questions: [
        {
          q: 'Why do slotted pages store slot offsets instead of pointers to records?',
          options: [
            'Offsets are smaller and survive the page being moved in memory or remapped after restart',
            'Pointers are faster but the compiler forbids them',
            'Offsets let the database skip checksums',
            'Pointers would make range scans impossible',
          ],
          answer: 0,
          explain:
            'A page can be read into a different address on every access and after every restart. Offsets relative to the page header stay valid; absolute pointers do not.',
        },
        {
          q: 'When must the page checksum be computed?',
          options: [
            'Before writing the header, so the header can be verified separately',
            'After the header and records are final, covering the whole page except the checksum field',
            'Only for pages that contain indexes',
            'At checkpoint time, once per database',
          ],
          answer: 1,
          explain:
            'The checksum must cover every byte that a torn write could corrupt, including the header, and it must be written last so it describes the final content.',
        },
        {
          q: 'A page reports 3 KiB of free space but a 1 KiB insert fails with NoSpace. What is the likely cause?',
          options: [
            'The checksum is wrong',
            'Free space is fragmented, so no single contiguous run fits the record',
            'The page is not dirty',
            'The slot array is full at 32 entries',
          ],
          answer: 1,
          explain:
            'Free bytes are not free space. You need one contiguous run of record length plus its two-byte length prefix; otherwise compaction has to run first.',
        },
      ],
      quickbytes: [
        'Verify the checksum before decoding any offset; a corrupt free_end turns into a panic or an out-of-bounds read.',
        'Track the largest contiguous free run, not total free bytes, or inserts fail while the page looks half empty.',
        'Seal the page after every mutation and store the page LSN in the header for redo decisions.',
        'Keep the checksum in the last four bytes so a page image is one contiguous slice for fsync and for the buffer pool.',
      ],
      production: [
        'Run a background scrubber that reads every page and verifies its checksum; silent corruption is found by reading, not by waiting.',
        'Alert on pages that compact more than N times per minute; that is a fill-factor or record-size problem, not a random event.',
        'Keep the page size fixed per database and record it in the header of page zero so a format change cannot be silently misread.',
        'Log the first checksum failure with page id and LSN; that pair tells you whether the log or the page write is at fault.',
      ],
      crates: ['crc32fast', 'bytes'],
      github: [{ name: 'srijs/rust-crc32fast', url: 'https://github.com/srijs/rust-crc32fast' }],
      pitfall:
        'Storing absolute offsets into the record area inside records themselves. After one compaction every such offset points at a different record, and the corruption appears only under delete-then-insert workloads.',
      resources: [
        { title: 'crc32fast: Hasher and one-shot hashing', url: 'https://docs.rs/crc32fast/latest/crc32fast/', kind: 'docs' },
        { title: 'srijs/rust-crc32fast repository', url: 'https://github.com/srijs/rust-crc32fast', kind: 'repo' },
        { title: 'bytes: BytesMut and BufMut for page buffers', url: 'https://docs.rs/bytes/latest/bytes/', kind: 'docs' },
      ],
    },
    {
      id: 'c03',
      n: 3,
      title: 'B+ trees: fanout, splits, and the root',
      minutes: 90,
      level: 'core',
      goal: 'Compute the height of a B+tree from fanout, implement a leaf split with parent propagation, and explain why copy-on-write trees let readers run without latches.',
      sections: [
        {
          h: 'Fanout is the whole point',
          p: [
            'A B+tree stores all values in leaves and only keys plus child pointers in internal nodes. With 8 KiB pages, 16-byte keys and 8-byte child pointers, an internal node holds about 340 entries. At 70 percent fill that is roughly 238 children per level, so three levels address about 13 million leaf entries and four levels about 3 billion.',
            'That is why a B+tree lookup is three or four page reads and why the top levels are always cached. The tree is shallow by construction, not by luck: fanout is page size divided by entry size, and every design choice that shrinks the key (prefix compression, 8-byte surrogate keys) buys a whole level of height for free.',
          ],
          list: [
            'Height grows only when the root splits, so a tree of height 3 stays height 3 until the root overflows.',
            'Leaves are linked left to right, which is what makes a range scan a sequential walk instead of a re-descent.',
            'Fill factor trades space for split frequency: 70 percent fill means fewer splits per insert but more pages on disk.',
          ],
        },
        {
          h: 'Split, propagate, and grow a level',
          p: [
            'Insert descends to the correct leaf, inserts in sorted order, and if the leaf is full, splits it into two and pushes the separator key up. The parent may then overflow and split in turn, recursively. A root split is the only operation that increases height, which is why height changes are rare and measurable.',
            'Deletion is the mirror image, but most engines do not merge aggressively. Merging costs a page rewrite and risks thrashing under alternating insert and delete, so many implementations only merge when a node drops below a low-water mark or leave the underfull node in place and let later inserts fill it.',
          ],
          code: `/// Split a full leaf in half. The allocator supplies the new page id so the
/// leaf links stay valid; the caller inserts the separator into the parent.
pub fn split_leaf(leaf: &mut LeafNode, new_page_id: u32) -> (Vec<u8>, LeafNode) {
    let mid = leaf.entries.len() / 2;
    let right_entries = leaf.entries.split_off(mid);
    let right = LeafNode {
        page_id: new_page_id,
        entries: right_entries,
        next: leaf.next,
        prev: leaf.page_id,
    };
    leaf.next = new_page_id;

    // The separator is a copy of the first key on the right, not a move:
    // every value still lives in a leaf, which is what makes it a B+tree.
    let separator = right.entries[0].key.clone();
    (separator, right)
}

/// Propagate a separator into a parent; split the parent if it is full.
pub fn insert_into_parent(
    parent: &mut InternalNode,
    separator: Vec<u8>,
    right_child: u32,
    alloc: &mut PageAllocator,
) -> Option<(Vec<u8>, u32)> {
    let pos = parent.keys.partition_point(|k| *k < separator);
    parent.keys.insert(pos, separator);
    parent.children.insert(pos + 1, right_child);

    if parent.keys.len() <= MAX_KEYS {
        return None; // parent had room, recursion stops here
    }
    let mid = parent.keys.len() / 2;
    let up = parent.keys.remove(mid);
    let right_keys = parent.keys.split_off(mid);
    let right_children = parent.children.split_off(mid + 1);
    let right = alloc.alloc_internal(right_keys, right_children);
    Some((up, right))
}`,
          tip: 'Copy the separator up; never move the value. A B-tree moves values between internal nodes, a B+tree does not, and mixing the two breaks range scans.',
        },
        {
          h: 'Copy-on-write trees: readers never wait',
          p: [
            'An in-place B+tree needs latches on every page it touches, because a concurrent reader could see a half-applied split. A copy-on-write tree writes modified pages to fresh locations and publishes a new root atomically, so readers holding an old root see a consistent old snapshot. LMDB and redb work this way.',
            'The cost is write amplification: a one-byte update rewrites the leaf and every ancestor up to the root, typically three or four pages instead of one, plus space that is only reclaimed when no reader still references the old pages. The benefit is that read transactions are lock-free and snapshot isolation falls out of the design almost for free.',
          ],
          code: `use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};

const TABLE: TableDefinition<u64, &str> = TableDefinition::new("users");

/// One writer at a time; readers run concurrently on the published snapshot.
pub fn upsert(db: &Database, id: u64, name: &str) -> Result<(), redb::Error> {
    let write = db.begin_write()?; // blocks only against other writers
    {
        let mut table = write.open_table(TABLE)?;
        table.insert(id, name)?;
    }
    write.commit()?; // atomic root swap + fsync of the new pages
    Ok(())
}

pub fn scan(db: &Database, from: u64, to: u64) -> Result<Vec<(u64, String)>, redb::Error> {
    let read = db.begin_read()?; // no latch, stable view
    let table = read.open_table(TABLE)?;
    let mut out = Vec::new();
    for entry in table.range(from..to)? {
        let (k, v) = entry?;
        out.push((k.value(), v.value().to_string()));
    }
    Ok(out)
}`,
          tip: 'Because readers pin old roots, a long-lived read transaction blocks page reuse. Cap read transaction lifetime the same way you cap a SQL transaction.',
        },
      ],
      exercise: {
        prompt:
          'Implement search and insert for an in-memory B+tree of order 4 (at most 3 keys per node). Insert 1..=20 in ascending order and assert the height is 3 and that a range scan returns all keys in order.',
        starter: `enum Node {
    Leaf { keys: Vec<i32>, values: Vec<i32> },
    Internal { keys: Vec<i32>, children: Vec<Box<Node>> },
}

pub struct BTree { root: Node }

impl BTree {
    pub fn new() -> Self { Self { root: Node::Leaf { keys: vec![], values: vec![] } } }
    pub fn search(&self, key: i32) -> Option<i32> { todo!() }
    pub fn insert(&mut self, key: i32, value: i32) { todo!() }
    pub fn height(&self) -> usize { todo!() }
}`,
        hint: 'Split before descending when a node is full (proactive split) or after inserting on the way back up. Ascending inserts are the worst case: every split happens on the rightmost path.',
        solution: `enum Node {
    Leaf { keys: Vec<i32>, values: Vec<i32> },
    Internal { keys: Vec<i32>, children: Vec<Box<Node>> },
}

const ORDER: usize = 4;

pub struct BTree { root: Node }

impl BTree {
    pub fn new() -> Self {
        Self { root: Node::Leaf { keys: vec![], values: vec![] } }
    }

    pub fn search(&self, key: i32) -> Option<i32> {
        let mut node = &self.root;
        loop {
            match node {
                Node::Leaf { keys, values } => {
                    return keys.binary_search(&key).ok().map(|i| values[i]);
                }
                Node::Internal { keys, children } => {
                    let i = keys.partition_point(|k| *k <= key);
                    node = &children[i];
                }
            }
        }
    }

    pub fn insert(&mut self, key: i32, value: i32) {
        if let Some((sep, right)) = Self::insert_into(&mut self.root, key, value) {
            let old = std::mem::replace(
                &mut self.root,
                Node::Internal { keys: vec![], children: vec![] },
            );
            self.root = Node::Internal { keys: vec![sep], children: vec![Box::new(old), Box::new(right)] };
        }
    }

    fn insert_into(node: &mut Node, key: i32, value: i32) -> Option<(i32, Node)> {
        match node {
            Node::Leaf { keys, values } => {
                let i = keys.partition_point(|k| *k < key);
                if keys.get(i) == Some(&key) {
                    values[i] = value;
                    return None;
                }
                keys.insert(i, key);
                values.insert(i, value);
                if keys.len() < ORDER {
                    return None;
                }
                let mid = keys.len() / 2;
                let right_keys = keys.split_off(mid);
                let right_values = values.split_off(mid);
                let sep = right_keys[0];
                Some((sep, Node::Leaf { keys: right_keys, values: right_values }))
            }
            Node::Internal { keys, children } => {
                let i = keys.partition_point(|k| *k <= key);
                let split = Self::insert_into(&mut children[i], key, value);
                let (sep, right) = split?;
                keys.insert(i, sep);
                children.insert(i + 1, Box::new(right));
                if keys.len() < ORDER {
                    return None;
                }
                let mid = keys.len() / 2;
                let up = keys.remove(mid);
                let right_keys = keys.split_off(mid);
                let right_children = children.split_off(mid + 1);
                Some((up, Node::Internal { keys: right_keys, children: right_children }))
            }
        }
    }

    pub fn height(&self) -> usize {
        let mut h = 1;
        let mut node = &self.root;
        while let Node::Internal { children, .. } = node {
            h += 1;
            node = &children[0];
        }
        h
    }
}`,
      },
      questions: [
        {
          q: 'What operation is the only one that increases the height of a B+tree?',
          options: [
            'A leaf split',
            'A split of the root node',
            'A merge of two leaves',
            'A range scan that crosses a page boundary',
          ],
          answer: 1,
          explain:
            'Leaf and internal splits redistribute within an existing level. Only when the root itself splits do you create a new root above it, increasing height by one.',
        },
        {
          q: 'Why does a B+tree keep values only in leaves?',
          options: [
            'To make internal nodes hold more keys, raising fanout and lowering height, and to make range scans a leaf walk',
            'Because leaves are always cached',
            'To avoid checksums on internal pages',
            'Because internal nodes cannot store variable-length data',
          ],
          answer: 0,
          explain:
            'Separating keys from values maximizes entries per internal page, which minimizes height, and lets leaves be linked so a range scan reads sequentially.',
        },
        {
          q: 'A copy-on-write B+tree gives readers a stable snapshot without latches. What does it cost?',
          options: [
            'Readers must take a shared latch on the root',
            'Every update rewrites the path to the root and old pages are reclaimed only when no reader references them',
            'Range scans become impossible',
            'Writes must be serialized through a single global lock forever',
          ],
          answer: 1,
          explain:
            'Path copying is write amplification, and snapshot lifetime pins old pages, so space is reclaimed lazily once readers advance past them.',
        },
      ],
      quickbytes: [
        'Height 3 at 8 KiB pages and 238-way fanout addresses roughly 13 million leaf entries; compute your own fanout before guessing.',
        'Copy the separator key up on a split; moving it breaks the invariant that all values live in leaves.',
        'Cap read-transaction lifetime in a copy-on-write tree or old pages can never be reused.',
      ],
      production: [
        'Monitor index height and average fill factor; a tree at 50 percent fill doubles the pages read per scan.',
        'Prefer narrow keys: an 8-byte surrogate key instead of a 36-byte UUID often removes an entire level of height.',
        'Alert when a single index grows faster than its table; that usually means an accidental random key.',
        'Benchmark delete-then-insert cycles, not just inserts, to see whether underfull pages accumulate.',
      ],
      crates: ['redb', 'bytes', 'tempfile'],
      github: [{ name: 'cberner/redb', url: 'https://github.com/cberner/redb' }],
      pitfall:
        'Inserting monotonically increasing keys into a B+tree is fine, but inserting random UUIDv4 keys is not: every insert touches a different leaf, the working set becomes the whole leaf level, and the buffer pool hit rate collapses.',
      resources: [
        { title: 'redb crate documentation (copy-on-write B+trees)', url: 'https://docs.rs/redb/latest/redb/', kind: 'docs' },
        { title: 'cberner/redb repository and design document', url: 'https://github.com/cberner/redb', kind: 'repo' },
        { title: 'Jon Gjengset: long-form Rust systems programming streams', url: 'https://www.youtube.com/@jonhoo', kind: 'video' },
      ],
    },
    {
      id: 'c04',
      n: 4,
      title: 'LSM trees: memtables, runs, and compaction',
      minutes: 90,
      level: 'advanced',
      goal: 'Trace a write from memtable to L0 to a compacted level, compute leveled-compaction write amplification, and explain why tombstones cannot be dropped early.',
      sections: [
        {
          h: 'Writes land in memory first',
          p: [
            'An LSM tree never overwrites a page in place. A write appends to a write-ahead log for durability and inserts into an in-memory sorted structure, usually a skiplist, called the memtable. When the memtable reaches a size threshold it becomes immutable, a background thread flushes it to an immutable sorted file, and a new memtable takes over.',
            'Reads check the memtable, then each immutable memtable, then level zero newest file first, then deeper levels. A key may exist in several runs, so the newest version wins. That is the entire trick: writes are sequential appends, and the cost moves to reads and to background rewriting.',
          ],
          code: `pub struct Memtable {
    /// Sorted map; a skiplist in production so writers never block readers.
    entries: std::collections::BTreeMap<Vec<u8>, Entry>,
    bytes: usize,
    capacity: usize,
}

pub enum Entry {
    Value(Vec<u8>),
    Tombstone,
}

impl Memtable {
    pub fn put(&mut self, key: &[u8], value: &[u8]) {
        self.bytes += key.len() + value.len();
        self.entries.insert(key.to_vec(), Entry::Value(value.to_vec()));
    }

    pub fn delete(&mut self, key: &[u8]) {
        // A delete is a value: a tombstone that hides older versions.
        self.entries.insert(key.to_vec(), Entry::Tombstone);
    }

    pub fn should_flush(&self) -> bool {
        self.bytes >= self.capacity
    }

    /// Frozen memtables are flushed in order, so L0 files overlap in key range.
    pub fn freeze(&mut self) -> Vec<(Vec<u8>, Entry)> {
        let drained: Vec<_> = self.entries.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        self.entries.clear();
        self.bytes = 0;
        drained
    }
}`,
          tip: 'A tombstone is a write, not an absence. If deletes were implemented by removing the key, an older run would resurrect the value on the next read.',
        },
        {
          h: 'Compaction is the tax you pay later',
          p: [
            'Leveled compaction keeps level L sorted and non-overlapping, with each level ten times larger than the one above. When a level fills, one file is merged with the overlapping files in the next level and the output is written as new files. Because a byte can be rewritten at every level, write amplification is roughly the number of levels times the size ratio.',
            'Tiered compaction merges groups of runs and tolerates overlap, which lowers write amplification but raises read and space amplification. RocksDB lets you mix the two per level, and that knob is the single most consequential tuning decision in an LSM deployment.',
          ],
          code: `pub struct Level {
    pub files: Vec<FileMeta>, // sorted by smallest key, non-overlapping
    pub target_bytes: u64,
}

pub struct FileMeta {
    pub smallest: Vec<u8>,
    pub largest: Vec<u8>,
    pub bytes: u64,
    pub level: u8,
}

/// Pick the input files for one leveled compaction: the oldest file in the
/// level that exceeds its size budget, plus every file it overlaps below.
pub fn pick_compaction(levels: &[Level]) -> Option<(Vec<usize>, Vec<usize>)> {
    let (src, level) = levels
        .iter()
        .enumerate()
        .find(|(_, l)| l.files.iter().map(|f| f.bytes).sum::<u64>() > l.target_bytes)?;

    let victim = level.files.first()?;
    let below = levels.get(src + 1)?;
    let overlapping: Vec<usize> = below
        .files
        .iter()
        .enumerate()
        .filter(|(_, f)| f.smallest <= victim.largest && victim.smallest <= f.largest)
        .map(|(i, _)| i)
        .collect();

    Some((vec![0], overlapping))
}

/// Write amplification for a leveled tree with ratio R and L levels.
pub fn write_amp(levels: u32, ratio: u64) -> u64 {
    levels as u64 * ratio
}`,
          tip: 'Tombstones may only be dropped when compaction reaches the bottom level. Dropping one earlier lets a value in a deeper, older run reappear as if the delete never happened.',
        },
        {
          h: 'Bloom filters and block indexes',
          p: [
            'Without help, a missing-key lookup probes every run and pays the worst case. A Bloom filter per file answers probably-not-present in a few nanoseconds; at ten bits per key the false-positive rate is about one percent, and the filter is small enough to keep in memory. That single structure is why LSM point reads are viable at all.',
            'Inside a file, keys are prefix-compressed into blocks with restart points, and a block index maps the first key of each block to its offset. A lookup does a binary search in the index, one block read, then a short linear scan from the nearest restart point. Values larger than a block are usually stored in a separate value log, which is the WiscKey idea.',
          ],
          code: `/// Bloom filter sizing: m bits for n keys at false-positive rate p.
/// m = -n * ln(p) / ln(2)^2, k = m/n * ln(2) hash functions.
pub fn bloom_bits(keys: u64, fp_rate: f64) -> (u64, u32) {
    let ln2 = std::f64::consts::LN_2;
    let m = (-(keys as f64) * fp_rate.ln() / (ln2 * ln2)).ceil() as u64;
    let k = ((m as f64 / keys as f64) * ln2).round() as u32;
    (m.max(64), k.max(1))
}

/// Ten bits per key, two hashes: ~1 percent false positives, ~1.25 bytes/key.
pub fn default_filter(keys: u64) -> (u64, u32) {
    bloom_bits(keys, 0.01)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ten_bits_per_key_at_one_percent() {
        let (bits, hashes) = default_filter(1_000_000);
        assert!((9..=12).contains(&(bits / 1_000_000)));
        assert!((6..=8).contains(&hashes));
    }
}`,
          tip: 'A Bloom filter has no false negatives only if it is built over every key in the file. Rebuilding a file without updating its filter is a silent correctness bug.',
        },
      ],
      exercise: {
        prompt:
          'Given a leveled LSM with three levels, a 10x size ratio, and 1 GiB of live data, compute write amplification and the total bytes written to ingest that data. Then implement should_compact so a level compacts at 1.1x its target size, and explain what happens if the threshold is 1.0x.',
        starter: `pub fn total_bytes_written(live_bytes: u64, levels: u32, ratio: u64) -> u64 {
    // TODO: each level rewrites the data once per pass through it.
    todo!()
}

pub fn should_compact(level_bytes: u64, target_bytes: u64) -> bool {
    // TODO: compact slightly above target to avoid a compaction per flush.
    todo!()
}`,
        hint: 'With three levels and ratio 10, each byte is written about 30 times: roughly 30 GiB for 1 GiB of data. A 1.0x threshold compacts after every flush, so compaction runs continuously and never catches up.',
        solution: `/// Every byte is rewritten once per level it passes through.
pub fn total_bytes_written(live_bytes: u64, levels: u32, ratio: u64) -> u64 {
    live_bytes * levels as u64 * ratio
}

/// Compact at 110 percent of target: amortizes compaction over several
/// flushes and keeps a small cushion for bursty ingest.
pub fn should_compact(level_bytes: u64, target_bytes: u64) -> bool {
    level_bytes * 10 > target_bytes * 11
}

fn main() {
    let live = 1024 * 1024 * 1024; // 1 GiB
    let written = total_bytes_written(live, 3, 10);
    println!("write amplification = {}", written / live); // 30
    println!("device bytes = {:.1} GiB", written as f64 / (1u64 << 30) as f64);

    // A 1.0x threshold compacts after every flush: compaction never idles,
    // and read latency spikes because the background threads never drain.
    assert!(should_compact(1_100_000_000, 1_000_000_000));
    assert!(!should_compact(1_000_000_000, 1_000_000_000));
}`,
      },
      questions: [
        {
          q: 'Why is a delete stored as a tombstone instead of removing the key?',
          options: [
            'To keep the memtable sorted',
            'Because an older run may still hold the value, and only a newer marker can hide it',
            'To make Bloom filters work',
            'Because tombstones compress better than values',
          ],
          answer: 1,
          explain:
            'Runs are immutable and searched newest-first. Removing the key from the newest run would let an older run answer the read, resurrecting deleted data.',
        },
        {
          q: 'What does leveled compaction primarily trade away to keep read amplification low?',
          options: [
            'Write amplification: bytes are rewritten at every level',
            'Durability of the write-ahead log',
            'The ability to do range scans',
            'Crash recovery',
          ],
          answer: 0,
          explain:
            'Non-overlapping levels mean a lookup probes one file per level, but each byte is rewritten once per level, so device writes multiply.',
        },
        {
          q: 'A Bloom filter is built with ten bits per key. What does that buy?',
          options: [
            'Zero false positives',
            'About a one percent false-positive rate, so most missing-key lookups skip the file',
            'Guaranteed in-memory residency',
            'Faster compaction',
          ],
          answer: 1,
          explain:
            'Roughly ten bits per key gives about one percent false positives at seven hash functions; the filter can say definitely-absent, never definitely-present.',
        },
      ],
      quickbytes: [
        'Size Bloom filters at ten bits per key for about one percent false positives; below that, missing-key reads start probing files.',
        'Never drop a tombstone above the bottom level; that is how deleted rows come back.',
        'A 10x size ratio with three levels means roughly 30x write amplification; check the device endurance math before choosing levels.',
        'Measure read amplification as files probed per lookup, not as bytes read; the file count is what the Bloom filters control.',
      ],
      production: [
        'Alert on compaction backlog (pending bytes) rather than on CPU; backlog is the leading indicator of read latency spikes.',
        'Cap the number of L0 files; too many overlapping runs turns every point read into a merge.',
        'Track tombstone counts per level and watch for a delete-heavy workload that never reaches the bottom level.',
        'Benchmark with a dataset larger than RAM, or you are measuring the page cache rather than the tree.',
      ],
      crates: ['bytes', 'crc32fast', 'criterion'],
      github: [
        { name: 'tokio-rs/bytes', url: 'https://github.com/tokio-rs/bytes' },
        { name: 'srijs/rust-crc32fast', url: 'https://github.com/srijs/rust-crc32fast' },
      ],
      pitfall:
        'Tuning compaction for write throughput alone. Fewer, larger compactions reduce device writes but let L0 file counts and space amplification grow until reads probe dozens of runs and p99 collapses.',
      resources: [
        {
          title: 'WiscKey: Separating Keys from Values in SSD-conscious Storage (FAST 16)',
          url: 'https://www.usenix.org/conference/fast16/technical-sessions/presentation/lu',
          kind: 'paper',
        },
        { title: 'bytes: Bytes and BytesMut for run files', url: 'https://docs.rs/bytes/latest/bytes/', kind: 'docs' },
        { title: 'crc32fast for per-block checksums in SSTables', url: 'https://docs.rs/crc32fast/latest/crc32fast/', kind: 'docs' },
      ],
    },
    {
      id: 'c05',
      n: 5,
      title: 'Write-ahead logging: the commit rule',
      minutes: 75,
      level: 'core',
      goal: 'Frame WAL records with a checksum, enforce the rule that log bytes reach disk before the pages they describe, and bound recovery time with checkpoints.',
      sections: [
        {
          h: 'Log first, page later',
          p: [
            'The write-ahead rule is one sentence: a page may not be written to disk until the log records describing its changes are durable. That single ordering turns random page writes into a recoverable stream. If the process dies after the log write and before the page write, recovery replays the record; if it dies before the log write, nothing was acknowledged.',
            'The commit rule is the second half: a transaction is acknowledged only after its commit record is on stable storage. Everything else in the engine can be reordered, buffered or lost, because the log plus the checkpoint is sufficient to reconstruct the state. This is why a database can acknowledge a write in one fsync and flush dirty pages minutes later.',
          ],
          list: [
            'Redo: reapply a change that is in the log but not yet in the page. Needed after any crash.',
            'Undo: revert an uncommitted change that reached a page. Needed when pages are flushed before commit.',
            'LSN: the log position of a record, stored in each page header so recovery knows where to resume.',
          ],
        },
        {
          h: 'Framing records so a torn tail is detectable',
          p: [
            'A log is an append-only byte stream, and a crash can leave a partially written record at the end. Each record therefore carries a length, a type, a transaction id and a CRC32 over its payload. Recovery reads forward, verifies the checksum, and stops at the first record that fails: everything after it was never acknowledged.',
            'The record must be self-describing, because recovery runs without the buffer pool and without the catalog. A redo record names a page id and carries the after-image; an undo record carries the before-image. Storing both images makes undo possible without reading the page, at the cost of doubling log volume for large updates.',
          ],
          code: `use crc32fast::Hasher;
use std::io::{self, Write};

pub const RECORD_MAGIC: u32 = 0x5741_4C31; // "WAL1"

pub struct LogRecord {
    pub lsn: u64,
    pub txid: u64,
    pub page_id: u32,
    pub kind: RecordKind,
    pub before: Vec<u8>,
    pub after: Vec<u8>,
}

pub enum RecordKind {
    Update,
    Commit,
    Abort,
    Checkpoint,
}

impl LogRecord {
    pub fn encode(&self) -> Vec<u8> {
        let mut body = Vec::with_capacity(64);
        body.extend_from_slice(&self.lsn.to_le_bytes());
        body.extend_from_slice(&self.txid.to_le_bytes());
        body.extend_from_slice(&self.page_id.to_le_bytes());
        body.push(self.kind as u8);
        body.extend_from_slice(&(self.before.len() as u32).to_le_bytes());
        body.extend_from_slice(&(self.after.len() as u32).to_le_bytes());
        body.extend_from_slice(&self.before);
        body.extend_from_slice(&self.after);

        let mut hasher = Hasher::new();
        hasher.update(&body);
        let crc = hasher.finalize();

        let mut out = Vec::with_capacity(body.len() + 12);
        out.extend_from_slice(&RECORD_MAGIC.to_le_bytes());
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&body);
        out
    }
}

/// Append and fsync. Group commit batches this across transactions.
pub fn append(wal: &mut std::fs::File, record: &LogRecord) -> io::Result<u64> {
    let bytes = record.encode();
    wal.write_all(&bytes)?;
    wal.sync_data()?; // fdatasync: data is durable, metadata may lag
    Ok(record.lsn + bytes.len() as u64)
}`,
          tip: 'fdatasync is enough for an append to an existing file: the size change is data, not metadata, on every filesystem you are likely to run.',
        },
        {
          h: 'Checkpoints bound recovery time',
          p: [
            'If the log is never truncated, recovery replays a year of history. A checkpoint flushes all dirty pages whose LSN is at or below a chosen point, then writes a checkpoint record naming that LSN and the active transaction table. Recovery starts at the last checkpoint instead of at the beginning of the log.',
            'A fuzzy checkpoint does not stop the world: it records the point, lets writes continue, and tracks pages that are dirtied after it. The checkpoint is complete when all pages dirty at the recorded LSN have reached disk. That is how a busy system takes a checkpoint without a latency cliff.',
          ],
          code: `pub struct Checkpoint {
    pub redo_lsn: u64,          // replay starts here
    pub active_txns: Vec<u64>,  // in flight when the checkpoint began
    pub dirty_page_count: u32,
}

pub fn take_checkpoint(
    wal: &mut std::fs::File,
    buffer_pool: &mut crate::buffer::BufferPool,
    active_txns: Vec<u64>,
) -> std::io::Result<Checkpoint> {
    let redo_lsn = buffer_pool.flushed_lsn();

    // Flush every page whose changes are already covered by the log.
    let dirty = buffer_pool.dirty_page_ids();
    for page_id in &dirty {
        buffer_pool.flush_page(*page_id)?; // WAL rule enforced inside
    }

    let cp = Checkpoint {
        redo_lsn,
        active_txns,
        dirty_page_count: dirty.len() as u32,
    };
    append(wal, &LogRecord {
        lsn: buffer_pool.next_lsn(),
        txid: 0,
        page_id: 0,
        kind: RecordKind::Checkpoint,
        before: Vec::new(),
        after: cp.redo_lsn.to_le_bytes().to_vec(),
    })?;
    Ok(cp)
}`,
          tip: 'A checkpoint that flushes pages without first flushing the log violates the WAL rule. Flush order is log, then data, always.',
        },
      ],
      exercise: {
        prompt:
          'Implement a WAL reader that scans forward, verifies each record CRC, and stops cleanly at a torn tail. Return the records it could parse plus the byte offset of the first bad record, and test it by truncating a valid log at every offset.',
        starter: `pub struct ScanResult {
    pub records: Vec<LogRecord>,
    pub good_bytes: u64,
    pub torn_at: Option<u64>,
}

pub fn scan(log: &[u8]) -> ScanResult {
    // TODO: read magic, length, crc, body; stop at the first mismatch.
    todo!()
}`,
        hint: 'Treat every short read, bad magic, bad length and bad CRC as end-of-log, not as an error. A crash during append produces exactly those shapes.',
        solution: `pub struct ScanResult {
    pub records: Vec<LogRecord>,
    pub good_bytes: u64,
    pub torn_at: Option<u64>,
}

pub fn scan(log: &[u8]) -> ScanResult {
    let mut records = Vec::new();
    let mut pos = 0usize;

    while pos + 12 <= log.len() {
        let magic = u32::from_le_bytes(log[pos..pos + 4].try_into().unwrap());
        if magic != RECORD_MAGIC {
            return ScanResult { records, good_bytes: pos as u64, torn_at: Some(pos as u64) };
        }
        let len = u32::from_le_bytes(log[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let crc = u32::from_le_bytes(log[pos + 8..pos + 12].try_into().unwrap());

        let body_start = pos + 12;
        let body_end = body_start + len;
        if body_end > log.len() {
            return ScanResult { records, good_bytes: pos as u64, torn_at: Some(pos as u64) };
        }
        let body = &log[body_start..body_end];
        if crc32fast::hash(body) != crc {
            return ScanResult { records, good_bytes: pos as u64, torn_at: Some(pos as u64) };
        }

        records.push(LogRecord {
            lsn: u64::from_le_bytes(body[0..8].try_into().unwrap()),
            txid: u64::from_le_bytes(body[8..16].try_into().unwrap()),
            page_id: u32::from_le_bytes(body[16..20].try_into().unwrap()),
            kind: match body[20] {
                0 => RecordKind::Update,
                1 => RecordKind::Commit,
                2 => RecordKind::Abort,
                _ => RecordKind::Checkpoint,
            },
            before: Vec::new(),
            after: Vec::new(),
        });
        pos = body_end;
    }

    ScanResult { records, good_bytes: pos as u64, torn_at: None }
}`,
      },
      questions: [
        {
          q: 'What exactly does the write-ahead rule require?',
          options: [
            'Every transaction is written to the log before it is executed',
            'Log records describing a page change reach stable storage before that page does',
            'The log is flushed only at checkpoint time',
            'Pages are written before the log so recovery can compare them',
          ],
          answer: 1,
          explain:
            'The ordering is log-then-page per change. Writing pages first makes an uncommitted change durable with no record to undo it.',
        },
        {
          q: 'Why does each log record carry a CRC32 and a length?',
          options: [
            'To compress the log',
            'So recovery can detect a torn tail and stop at the last complete, acknowledged record',
            'To encrypt the payload',
            'To sort records by page id',
          ],
          answer: 1,
          explain:
            'A crash can leave a partial record at the end. Length plus checksum lets recovery distinguish a complete record from a torn one without guessing.',
        },
        {
          q: 'What does a checkpoint actually bound?',
          options: [
            'The number of concurrent transactions',
            'How far back recovery must replay, and therefore recovery time',
            'The size of each page',
            'The number of indexes per table',
          ],
          answer: 1,
          explain:
            'A checkpoint records a redo LSN after flushing pages up to it, so recovery starts there rather than at the beginning of the log.',
        },
      ],
      quickbytes: [
        'Flush the log, then the page. Reversing that order silently makes uncommitted changes durable.',
        'Batch fsyncs across transactions; per-transaction fsync caps throughput at the device sync rate.',
        'Recovery must treat a short read, a bad magic and a bad CRC identically: end of log, not a fatal error.',
        'Take checkpoints on a time or log-size budget, not on a timer that ignores write volume.',
      ],
      production: [
        'Alert on checkpoint duration and on log size between checkpoints; both predict recovery time after a crash.',
        'Test recovery with a fault injector that truncates the log at random offsets, not just with a clean restart.',
        'Keep the log on a separate device or at least a separate filesystem from data files when fsync latency matters.',
        'Record the redo LSN in the checkpoint record and verify on startup that replay actually starts there.',
      ],
      crates: ['crc32fast', 'bytes', 'tempfile'],
      github: [{ name: 'srijs/rust-crc32fast', url: 'https://github.com/srijs/rust-crc32fast' }],
      pitfall:
        'Acknowledging a commit after write() but before fsync(). The bytes sit in the page cache, the client is told the write succeeded, and a power cut loses it while the client believes otherwise.',
      resources: [
        {
          title: 'ARIES: a transaction recovery method using write-ahead logging (ACM TODS, 1992)',
          url: 'https://dl.acm.org/doi/10.1145/128765.128770',
          kind: 'paper',
        },
        { title: 'fsync(2) manual page', url: 'https://man7.org/linux/man-pages/man2/fsync.2.html', kind: 'docs' },
        { title: 'crc32fast for record framing checksums', url: 'https://docs.rs/crc32fast/latest/crc32fast/', kind: 'docs' },
      ],
    },
    {
      id: 'c06',
      n: 6,
      title: 'Buffer pools: pins, dirty pages, and clock sweep',
      minutes: 75,
      level: 'advanced',
      goal: 'Map pages into frames with pin counts, evict with a clock sweep that resists scan pollution, and refuse to evict a dirty page whose log records are not yet durable.',
      sections: [
        {
          h: 'Frames, pins, and a page table',
          p: [
            'The buffer pool is a fixed array of frames plus a hash table from page id to frame index. A thread that wants a page pins its frame, which increments a counter and guarantees the page will not be evicted while the pointer is held. Unpinning decrements it. A frame with a nonzero pin count is untouchable, no matter how cold it looks.',
            'Two latches are involved and they are not the same. The page table has its own short-lived latch, held only long enough to look up or insert a mapping. Each frame has a latch that protects the page bytes. Holding the table latch while doing I/O serializes the whole pool, which is why real implementations release it before reading from disk.',
          ],
          code: `use bytes::Bytes;
use parking_lot::Mutex;
use std::collections::HashMap;

pub type PageId = u64;

pub struct Frame {
    pub page: Option<Bytes>,
    pub pin_count: u32,
    pub dirty: bool,
    pub usage: u8, // clock-sweep counter, 0..=5
}

struct PoolState {
    table: HashMap<PageId, usize>,
    hand: usize,
    ticks: u64,
}

pub struct BufferPool {
    frames: Vec<Mutex<Frame>>,
    state: Mutex<PoolState>,
    capacity: usize,
}

impl BufferPool {
    /// Returns a pinned frame index. The caller must call unpin when done.
    /// Lock order is always state, then frame: never the reverse.
    pub fn pin(&self, page_id: PageId) -> Option<usize> {
        let mut state = self.state.lock();
        if let Some(&idx) = state.table.get(&page_id) {
            let mut frame = self.frames[idx].lock();
            frame.pin_count += 1;
            frame.usage = frame.usage.saturating_add(1).min(5);
            return Some(idx);
        }

        let idx = self.evict_one(&mut state)?;
        let mut frame = self.frames[idx].lock();
        frame.page = Some(Bytes::from(vec![0u8; 8192])); // read_page(page_id)?
        frame.pin_count = 1;
        frame.usage = 1;
        frame.dirty = false;
        state.table.insert(page_id, idx);
        Some(idx)
    }

    pub fn unpin(&self, idx: usize, dirty: bool) {
        let mut frame = self.frames[idx].lock();
        frame.pin_count = frame.pin_count.saturating_sub(1);
        frame.dirty |= dirty;
    }
}`,
          tip: 'Pin before you release the table latch. Between lookup and pin, another thread can evict the frame and hand it to a different page.',
        },
        {
          h: 'Clock sweep beats plain LRU under scans',
          p: [
            'A sequential scan touches every page once and would evict the entire hot set under strict LRU. The clock sweep approximates LRU-K cheaply: each frame carries a usage counter, and the eviction hand decrements counters as it passes, taking the first frame whose counter is zero. Pages touched repeatedly survive; pages touched once are reclaimed on the next pass.',
            'PostgreSQL uses exactly this scheme, with a usage count capped at five. A single scan bumps each page to one, so the hand clears them on its next revolution instead of letting them displace genuinely hot pages. The cap matters: without it, one scan could promote pages above long-lived hot data.',
          ],
          code: `impl BufferPool {
    /// Advance the clock hand until an unpinned frame with usage 0 is found.
    /// Returns None only if every frame is pinned (the pool is exhausted).
    fn evict_one(&self, state: &mut PoolState) -> Option<usize> {
        for _ in 0..self.capacity * 6 {
            let idx = state.hand;
            state.hand = (state.hand + 1) % self.capacity;

            let mut frame = self.frames[idx].lock();
            if frame.page.is_none() {
                return Some(idx);
            }
            if frame.pin_count > 0 {
                continue;
            }
            if frame.usage > 0 {
                frame.usage -= 1; // second chance: keep it for one more pass
                continue;
            }
            if frame.dirty {
                // WAL rule: the page's log must be durable before the page is.
                drop(frame);
                if self.flush_frame(idx).is_err() {
                    continue;
                }
                frame = self.frames[idx].lock();
            }
            if let Some(old) = state.table.iter().find(|(_, v)| **v == idx).map(|(k, _)| *k) {
                state.table.remove(&old);
            }
            return Some(idx);
        }
        None // everything pinned: caller must wait or fail with a timeout
    }
}`,
          tip: 'Cap the usage counter at five. Without a cap, a single full-table scan promotes every page above your hot set and the next lookup misses.',
        },
        {
          h: 'Dirty pages, checkpoints, and the WAL rule again',
          p: [
            'A frame can only be written back if the log records describing its changes are already durable. The pool therefore tracks the log flushed position and refuses to write a page whose LSN is greater than that. This is the write-ahead rule enforced at the eviction boundary, and forgetting it is how engines produce a database that cannot be recovered.',
            'Writeback also interacts with checkpoints. A checkpoint wants every page dirty at a given LSN on disk, which means it must first flush the log up to that LSN. If the log flush is slow, the checkpoint stalls, which is why checkpoint duration tracks fsync latency rather than the amount of dirty data.',
          ],
          code: `impl BufferPool {
    /// Called on eviction and on checkpoint. Enforces the WAL rule.
    fn flush_frame(&self, idx: usize) -> std::io::Result<()> {
        let frame = self.frames[idx].lock();
        let page = match &frame.page {
            Some(p) => p.clone(),
            None => return Ok(()),
        };
        let page_lsn = crate::page::PageHeader::decode(&page).lsn;
        drop(frame);

        // Cannot write the page until the log covering it is durable.
        crate::wal::wait_until_flushed(page_lsn)?;

        crate::io::write_page(idx as u64, &page)?;
        let mut frame = self.frames[idx].lock();
        frame.dirty = false;
        Ok(())
    }

    /// Eviction with a deadline: never block a query forever on a full pool.
    pub fn pin_with_timeout(&self, page_id: PageId, budget: std::time::Duration) -> Option<usize> {
        let deadline = std::time::Instant::now() + budget;
        loop {
            if let Some(idx) = self.pin(page_id) {
                return Some(idx);
            }
            if std::time::Instant::now() >= deadline {
                return None; // surface as a retryable error, not a hang
            }
            std::thread::yield_now();
        }
    }
}`,
          tip: 'A buffer pool that can block forever on a full pool turns one slow query into a global outage. Always give pinning a deadline.',
        },
      ],
      exercise: {
        prompt:
          'Add a sequential-scan-resistant eviction policy to the pool: a scan hint that sets usage to zero on first touch, and a metric that counts frames reclaimed per eviction pass. Show, with a test, that a hot page survives a full scan of 10,000 cold pages.',
        starter: `impl BufferPool {
    /// Mark a page as touched by a scan: it must not displace hot pages.
    pub fn pin_scan(&self, page_id: PageId) -> Option<usize> { todo!() }

    /// Evictions in the last pass, for the "is the pool thrashing" alert.
    pub fn reclaims(&self) -> u64 { todo!() }
}`,
        hint: 'Set usage to 0 for scan pages and let the clock hand reclaim them on the same pass. The hot page keeps a usage above zero only if something pins it between passes, so touch it in the test loop.',
        solution: `impl BufferPool {
    /// A scan does not get to promote pages: set usage to 0 after pinning.
    pub fn pin_scan(&self, page_id: PageId) -> Option<usize> {
        let idx = self.pin(page_id)?;
        let mut frame = self.frames[idx].lock();
        frame.usage = 0;
        Some(idx)
    }

    pub fn reclaims(&self) -> u64 {
        self.state.lock().ticks
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hot_page_survives_a_full_scan() {
        let pool = BufferPool::new(64);

        // Hot page, pinned and unpinned repeatedly.
        for _ in 0..3 {
            let idx = pool.pin(7).unwrap();
            pool.unpin(idx, false);
        }

        // Full scan of cold pages, each touched once with the scan hint.
        for page in 1000..11_000 {
            let idx = pool.pin_scan(page).unwrap();
            pool.unpin(idx, false);
        }

        // The hot page must still be resident: a miss here means the scan won.
        assert_eq!(pool.pin(7), Some(0), "hot page was evicted by the scan");
    }
}`,
      },
      questions: [
        {
          q: 'What does a nonzero pin count guarantee?',
          options: [
            'The page is clean and can be written back at any time',
            'The frame will not be chosen for eviction while the count stays above zero',
            'The page is the most recently used in the pool',
            'The page is durable on disk',
          ],
          answer: 1,
          explain:
            'A pin is a lease on a frame. Eviction skips pinned frames, which is what makes it safe to hold a reference to page bytes across an I/O or a computation.',
        },
        {
          q: 'Why does a plain LRU policy perform badly under a large sequential scan?',
          options: [
            'LRU cannot handle more than 100 pages',
            'The scan touches every page once, so it evicts the hot set even though those pages will never be reused',
            'Sequential scans bypass the buffer pool entirely',
            'LRU requires a lock per page read',
          ],
          answer: 1,
          explain:
            'LRU assumes recency predicts reuse. A scan has no reuse, so it floods the cache; clock sweep with a usage counter gives those pages a second chance to be reclaimed immediately.',
        },
        {
          q: 'What must happen before a dirty page is written back?',
          options: [
            'A checkpoint must be taken',
            'The log records describing its changes must already be durable',
            'The page must be unpinned twice',
            'Its checksum must be recomputed by the checkpoint thread',
          ],
          answer: 1,
          explain:
            'That is the write-ahead rule at the eviction boundary. Writing the page first would make changes durable that the log cannot explain after a crash.',
        },
      ],
      quickbytes: [
        'Never hold the page-table latch across a disk read; release it, do the I/O, then re-check that nobody else filled the frame.',
        'Cap the clock-sweep usage counter at five, or one scan promotes every page above your hot set.',
        'Give pinning a deadline: a pool that can block forever converts one slow query into an outage.',
        'Count frames reclaimed per pass; a rising reclaim rate is the earliest signal of a working set that no longer fits.',
      ],
      production: [
        'Size the pool from the working set, not from total RAM; a pool larger than the hot set buys nothing and hurts checkpoints.',
        'Alert on pin wait time and on evictions per second, not only on query latency.',
        'Flush the log before dirty pages at every boundary: eviction, checkpoint, and shutdown.',
        'Track the dirty-page ratio; a pool that is always 90 percent dirty makes every checkpoint a latency spike.',
      ],
      crates: ['parking_lot', 'bytes'],
      github: [{ name: 'Amanieu/parking_lot', url: 'https://github.com/Amanieu/parking_lot' }],
      pitfall:
        'Locking the page-table mutex for the whole duration of a page read. Every other thread queues behind one disk read, and the pool serializes to a single page per I/O latency.',
      resources: [
        { title: 'parking_lot: Mutex and RwLock primitives', url: 'https://docs.rs/parking_lot/latest/parking_lot/', kind: 'docs' },
        { title: 'Amanieu/parking_lot repository', url: 'https://github.com/Amanieu/parking_lot', kind: 'repo' },
        { title: 'bytes: cheaply cloneable page buffers', url: 'https://docs.rs/bytes/latest/bytes/', kind: 'docs' },
      ],
    },
    {
      id: 'c07',
      n: 7,
      title: 'MVCC: version chains and snapshot visibility',
      minutes: 90,
      level: 'advanced',
      goal: 'Implement the visibility test that decides which row version a transaction sees, and explain how version chains turn updates into append-only writes that vacuum must later clean up.',
      sections: [
        {
          h: 'Two ways to keep old versions',
          p: [
            'An update under MVCC does not overwrite a row; it creates a new version and marks the old one as superseded. PostgreSQL stores every version inline in the heap and records the creating transaction in xmin and the deleting transaction in xmax. Readers pick the version their snapshot is allowed to see, and no read ever blocks a write.',
            'InnoDB takes the other route: the current row lives in the page and older versions are reconstructed from undo records in rollback segments, chained backwards from the row. Append-only versions make reads cheap and writes bulky; undo records make the heap compact and reads more expensive, because an old snapshot may have to follow a chain.',
          ],
          list: [
            'PostgreSQL: version stored in the heap, xmin/xmax in the tuple header, dead versions reclaimed by VACUUM.',
            'InnoDB: current version in the page, older versions rebuilt from undo logs, purge thread reclaims.',
            'Both: a snapshot is a set of transaction ids, not a timestamp, and visibility is decided per version.',
          ],
        },
        {
          h: 'The visibility test',
          p: [
            'A version is visible to a transaction when its creator committed before the snapshot and its deleter either does not exist or had not committed at snapshot time. Your own uncommitted writes are always visible to you and never visible to anyone else. That is the whole rule, and every MVCC engine implements some spelling of it.',
            'The subtle part is the snapshot representation. Storing xmin, xmax and the list of transactions active when the snapshot was taken is enough to answer committed-before for any id, without consulting a global commit log. A transaction id below xmin is committed; one at or above xmax is in the future; anything in between is committed only if it is not in the active list.',
          ],
          code: `pub type TxId = u64;

#[derive(Clone)]
pub struct Version {
    pub xmin: TxId,          // created by
    pub xmax: Option<TxId>,  // deleted or superseded by
    pub value: Vec<u8>,
}

pub struct Snapshot {
    pub xmin: TxId,          // oldest still-active transaction
    pub xmax: TxId,          // first not-yet-assigned id
    pub active: Vec<TxId>,   // in flight when the snapshot was taken
}

impl Snapshot {
    fn committed_before(&self, tx: TxId) -> bool {
        if tx >= self.xmax {
            return false; // not even started when we took the snapshot
        }
        if tx < self.xmin {
            return true; // finished before the oldest active transaction
        }
        !self.active.contains(&tx)
    }
}

/// The rule every MVCC engine implements, in one function.
pub fn visible(v: &Version, snap: &Snapshot, me: TxId) -> bool {
    if v.xmin != me && !snap.committed_before(v.xmin) {
        return false; // created by someone we cannot see yet
    }
    match v.xmax {
        None => true,
        Some(xmax) if xmax == me => false,       // we deleted it ourselves
        Some(xmax) => !snap.committed_before(xmax), // deleter not visible: still live
    }
}`,
          tip: 'Snapshot ids must never be reused. Wraparound is why PostgreSQL has to freeze old tuples and why a 32-bit transaction id is a maintenance obligation, not an implementation detail.',
        },
        {
          h: 'The bill comes due: bloat and vacuum',
          p: [
            'Every update leaves a dead version behind. Space is reclaimed only when no snapshot can still see it, which means the oldest active snapshot sets a floor: the xmin horizon. A single long-running transaction, an idle-in-transaction session, or a forgotten replication slot pins that horizon and prevents cleanup of everything newer.',
            'This is the operational face of MVCC. A reporting query that runs for an hour on a write-heavy table does not just consume CPU; it makes the table grow for an hour. PostgreSQL exposes the horizon as the backend_xmin of sessions and the xmin of replication slots, and bloat monitoring is really horizon monitoring.',
          ],
          code: `-- Who is holding the xmin horizon back?
SELECT pid, state, xact_start, backend_xmin,
       now() - xact_start AS txn_age
FROM pg_stat_activity
WHERE backend_xmin IS NOT NULL
ORDER BY age(backend_xmin) DESC
LIMIT 10;

-- Replication slots that pin old rows even when no client is connected.
SELECT slot_name, active, xmin, catalog_xmin,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
FROM pg_replication_slots
WHERE xmin IS NOT NULL OR catalog_xmin IS NOT NULL;

-- Dead tuples per table: the input to any bloat estimate.
SELECT relname, n_live_tup, n_dead_tup,
       round(100.0 * n_dead_tup / greatest(n_live_tup + n_dead_tup, 1), 1) AS dead_pct,
       last_autovacuum
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 10;`,
          tip: 'A replication slot whose consumer is gone keeps every row it has not confirmed as visible. It is the most common cause of a table that grows without bound.',
        },
      ],
      exercise: {
        prompt:
          'Extend visible() with the write path: apply an update as a new version plus an xmax on the old one, then prove with a test that a snapshot taken before the update sees the old value and a snapshot taken after sees the new one.',
        starter: `pub struct Chain {
    pub versions: Vec<Version>, // newest last
}

impl Chain {
    pub fn read(&self, snap: &Snapshot, me: TxId) -> Option<&Version> { todo!() }
    pub fn update(&mut self, me: TxId, value: Vec<u8>) { todo!() }
}`,
        hint: 'Scan from newest to oldest and return the first visible version. On update, set xmax = Some(me) on the current version and push a new one with xmin = me.',
        solution: `pub type TxId = u64;

#[derive(Clone)]
pub struct Version {
    pub xmin: TxId,
    pub xmax: Option<TxId>,
    pub value: Vec<u8>,
}

pub struct Snapshot {
    pub xmin: TxId,
    pub xmax: TxId,
    pub active: Vec<TxId>,
}

impl Snapshot {
    fn committed_before(&self, tx: TxId) -> bool {
        if tx >= self.xmax { return false; }
        if tx < self.xmin { return true; }
        !self.active.contains(&tx)
    }
}

pub fn visible(v: &Version, snap: &Snapshot, me: TxId) -> bool {
    if v.xmin != me && !snap.committed_before(v.xmin) { return false; }
    match v.xmax {
        None => true,
        Some(xmax) if xmax == me => false,
        Some(xmax) => !snap.committed_before(xmax),
    }
}

pub struct Chain {
    pub versions: Vec<Version>,
}

impl Chain {
    pub fn read(&self, snap: &Snapshot, me: TxId) -> Option<&Version> {
        self.versions.iter().rev().find(|v| visible(v, snap, me))
    }

    pub fn update(&mut self, me: TxId, value: Vec<u8>) {
        if let Some(last) = self.versions.last_mut() {
            last.xmax = Some(me);
        }
        self.versions.push(Version { xmin: me, xmax: None, value });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_before_update_sees_old_value() {
        let mut chain = Chain { versions: vec![Version { xmin: 1, xmax: None, value: b"old".to_vec() }] };

        // Snapshot taken while tx 5 is the only one in flight.
        let before = Snapshot { xmin: 5, xmax: 6, active: vec![5] };

        chain.update(5, b"new".to_vec());

        let seen = chain.read(&before, 6).unwrap();
        assert_eq!(seen.value, b"old");

        let after = Snapshot { xmin: 6, xmax: 7, active: vec![] };
        assert_eq!(chain.read(&after, 6).unwrap().value, b"new");
    }
}`,
      },
      questions: [
        {
          q: 'Under MVCC, what does an UPDATE do to the existing row version?',
          options: [
            'Overwrites its bytes in place',
            'Marks it as superseded and creates a new version, so readers on older snapshots still see the old one',
            'Deletes it and relies on the index to find the new one',
            'Moves it to a temporary table',
          ],
          answer: 1,
          explain:
            'Versions are immutable once committed. The update sets an xmax on the old version and inserts a new version with a new xmin, which is why space must later be reclaimed.',
        },
        {
          q: 'Which condition makes a version visible to a snapshot?',
          options: [
            'Its creator committed before the snapshot, and its deleter either does not exist or had not committed by then',
            'Its creator is the oldest transaction in the system',
            'Its xmin is greater than the snapshot xmax',
            'Its deleter is still active',
          ],
          answer: 0,
          explain:
            'Creator must be visible and deleter must not be. Your own uncommitted writes are a special case that is always visible to you.',
        },
        {
          q: 'Why does a single long-running transaction cause table bloat?',
          options: [
            'It holds a lock on every row it read',
            'It pins the xmin horizon, so no version newer than its snapshot can be reclaimed',
            'It prevents checkpoints',
            'It disables the WAL',
          ],
          answer: 1,
          explain:
            'Vacuum can only remove versions that no live snapshot could still see. A long snapshot makes every version created after it potentially visible, so cleanup stalls.',
        },
      ],
      quickbytes: [
        'A snapshot is a set of transaction ids, not a wall-clock time; never compare MVCC visibility with timestamps.',
        'Monitor the xmin horizon, not just dead-tuple counts; the horizon explains why the count is rising.',
        'Cap idle-in-transaction sessions with idle_in_transaction_session_timeout before they pin the horizon for hours.',
        'Drop unused replication slots; an inactive slot keeps every unconfirmed row visible forever.',
      ],
      production: [
        'Alert when the oldest backend_xmin is more than a few minutes old on a write-heavy database.',
        'Set statement_timeout and idle_in_transaction_session_timeout; both bound the horizon without human intervention.',
        'Track dead tuples per table and compare with the autovacuum threshold, not with a fixed number.',
        'Test long-running analytics against a replica, where a held snapshot does not block cleanup on the primary.',
      ],
      crates: ['parking_lot', 'bytes'],
      github: [{ name: 'Amanieu/parking_lot', url: 'https://github.com/Amanieu/parking_lot' }],
      pitfall:
        'Assuming a snapshot taken at the start of a transaction is used by every statement. In PostgreSQL Read Committed, each statement takes a fresh snapshot, so two identical SELECTs in one transaction can return different rows.',
      resources: [
        {
          title: 'PostgreSQL: Introduction to MVCC (chapter 13.1)',
          url: 'https://www.postgresql.org/docs/current/mvcc-intro.html',
          kind: 'docs',
        },
        {
          title: 'PostgreSQL: Transaction Isolation (chapter 13.2)',
          url: 'https://www.postgresql.org/docs/current/transaction-iso.html',
          kind: 'docs',
        },
        { title: 'parking_lot for per-version chain latches', url: 'https://docs.rs/parking_lot/latest/parking_lot/', kind: 'docs' },
      ],
    },
    {
      id: 'c08',
      n: 8,
      title: 'Isolation levels: what each one actually prevents',
      minutes: 75,
      level: 'advanced',
      goal: 'Map the four SQL phenomena to the isolation levels that forbid them, demonstrate write skew under snapshot isolation, and write a retry loop for serialization failures.',
      sections: [
        {
          h: 'Four phenomena, four levels',
          p: [
            'The SQL standard defines isolation by the anomalies it forbids: dirty read, nonrepeatable read, phantom read and serialization anomaly. PostgreSQL implements only three distinct levels, because Read Uncommitted would behave exactly like Read Committed under MVCC, and its Repeatable Read also prevents phantoms, which the standard permits as a stronger guarantee.',
            'The practical consequence is that Repeatable Read is snapshot isolation. Every statement in the transaction sees the same snapshot, writers do not block readers, and two transactions can each read a set, decide independently, and write disjoint rows with no conflict detected. That last case is write skew, and it is not prevented by snapshot isolation.',
          ],
          list: [
            'Read Committed: a new snapshot per statement; a row updated concurrently is re-read and the WHERE clause re-evaluated.',
            'Repeatable Read: one snapshot for the transaction; a concurrent update to a row you then modify aborts with SQLSTATE 40001.',
            'Serializable: Repeatable Read plus SSI, which tracks read/write dependencies and aborts cycles.',
          ],
        },
        {
          h: 'Write skew, the anomaly that survives snapshots',
          p: [
            'Two doctors are on call. Each transaction counts the on-call doctors, sees two, and sets its own row to off-call because the count is above one. Both commit under snapshot isolation, and the invariant that at least one doctor is on call is now false. No row was updated twice, so no write-write conflict exists to detect.',
            'Serializable Snapshot Isolation fixes this by tracking rw-antidependencies between transactions and aborting one when a dangerous structure forms. PostgreSQL reports it as could not serialize access due to read/write dependencies among transactions, also SQLSTATE 40001, and the application must retry.',
          ],
          code: `-- Two sessions, both at REPEATABLE READ (snapshot isolation).
-- Setup: two doctors, both on_call = true.

-- Session A                                  -- Session B
BEGIN ISOLATION LEVEL REPEATABLE READ;         BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT count(*) FROM doctors WHERE on_call;    SELECT count(*) FROM doctors WHERE on_call;
-- both see 2, so both conclude "I can go off call"
UPDATE doctors SET on_call = false
  WHERE name = 'alice';
                                               UPDATE doctors SET on_call = false
                                                 WHERE name = 'bob';
COMMIT;                                        COMMIT;
-- Invariant violated: zero doctors on call.
-- At SERIALIZABLE, one of the two commits fails with SQLSTATE 40001.`,
          tip: 'Snapshot isolation is not serializable. If an invariant spans rows that different transactions write, you need Serializable or an explicit lock.',
        },
        {
          h: 'Retries are part of the contract',
          p: [
            'Serializable and Repeatable Read both abort transactions with 40001, and the only correct response is to retry the whole transaction from the beginning. That means the transaction body must be a function you can call again, with no side effects outside the database and no state captured from the aborted attempt.',
            'Retry immediately and you build a thundering herd: every aborted transaction retries in lockstep and the conflict repeats. Use exponential backoff with jitter, cap the attempts, and distinguish 40001 from 23505 (unique violation), which will fail identically on every retry and must not be retried at all.',
          ],
          code: `use sqlx::{PgPool, Postgres, Transaction};
use std::time::Duration;

pub async fn transfer(pool: &PgPool, from: i64, to: i64, cents: i64) -> Result<(), sqlx::Error> {
    const MAX_ATTEMPTS: u32 = 5;

    for attempt in 0..MAX_ATTEMPTS {
        let mut tx = pool.begin().await?;
        // Must be the first statement in the transaction.
        sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
            .execute(&mut *tx)
            .await?;

        let result = async {
            sqlx::query("UPDATE accounts SET balance = balance - $1 WHERE id = $2")
                .bind(cents).bind(from).execute(&mut *tx).await?;
            sqlx::query("UPDATE accounts SET balance = balance + $1 WHERE id = $2")
                .bind(cents).bind(to).execute(&mut *tx).await?;
            tx.commit().await
        }
        .await;

        match result {
            Ok(()) => return Ok(()),
            Err(sqlx::Error::Database(db)) if db.code().as_deref() == Some("40001") => {
                let backoff = Duration::from_millis(5 * 2u64.pow(attempt));
                tokio::time::sleep(backoff).await;
            }
            Err(other) => return Err(other), // 23505 and friends: never retry
        }
    }
    Err(sqlx::Error::Protocol("serialization retries exhausted".into()))
}`,
          tip: 'Retry only 40001 and deadlock_detected (40P01). Retrying a unique violation just burns CPU and delays the real error.',
        },
      ],
      exercise: {
        prompt:
          'Reproduce write skew in two psql sessions at REPEATABLE READ, then rerun the same sequence at SERIALIZABLE and capture the error code. Explain why the row-level lock in SELECT FOR UPDATE would also have prevented it.',
        starter: `-- Session A
BEGIN ISOLATION LEVEL REPEATABLE READ;
-- TODO: read the count, decide, write
COMMIT;

-- Session B
BEGIN ISOLATION LEVEL REPEATABLE READ;
-- TODO: same read, same decision, different row
COMMIT;`,
        hint: 'Both sessions must read before either writes, otherwise the second UPDATE simply blocks. Then check that SERIALIZABLE aborts one with 40001.',
        solution: `-- Setup
CREATE TABLE doctors (name text PRIMARY KEY, on_call boolean NOT NULL);
INSERT INTO doctors VALUES ('alice', true), ('bob', true);

-- Session A
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT count(*) FROM doctors WHERE on_call;   -- 2, so "I can leave"
UPDATE doctors SET on_call = false WHERE name = 'alice';

-- Session B (concurrently)
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT count(*) FROM doctors WHERE on_call;   -- also 2
UPDATE doctors SET on_call = false WHERE name = 'bob';

-- A commits first, then B:
COMMIT;  -- B: ERROR: could not serialize access due to read/write dependencies
         -- SQLSTATE 40001. Retry B; it now sees 1 and declines to leave.

-- Alternative without SERIALIZABLE: take a lock that conflicts.
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT count(*) FROM doctors WHERE on_call FOR UPDATE;
-- The second session blocks here until the first commits, then re-reads 1.`,
      },
      questions: [
        {
          q: 'Which anomaly is possible under PostgreSQL Repeatable Read?',
          options: [
            'Dirty read',
            'Nonrepeatable read',
            'Serialization anomaly such as write skew',
            'Phantom read',
          ],
          answer: 2,
          explain:
            'PostgreSQL Repeatable Read is snapshot isolation: it prevents dirty, nonrepeatable and phantom reads but allows write skew, because no write-write conflict occurs.',
        },
        {
          q: 'A query fails with SQLSTATE 40001. What is the correct application response?',
          options: [
            'Return 500 to the client; the data is corrupt',
            'Retry the entire transaction from the beginning, with backoff and jitter',
            'Retry only the failing statement',
            'Switch the session to Read Committed and continue',
          ],
          answer: 1,
          explain:
            'The transaction was aborted by the server to preserve serializability. Its reads are stale, so the whole body must rerun against a fresh snapshot.',
        },
        {
          q: 'Why must SET TRANSACTION ISOLATION LEVEL be the first statement in the transaction?',
          options: [
            'It is a performance hint',
            'The isolation level applies to the snapshot the transaction has already taken; after a query runs, changing it would be ambiguous',
            'It is only allowed in autocommit mode',
            'It locks the table',
          ],
          answer: 1,
          explain:
            'The snapshot is established by the first statement. PostgreSQL rejects changing the level afterwards rather than silently applying it to part of the transaction.',
        },
      ],
      quickbytes: [
        'Repeatable Read in PostgreSQL is snapshot isolation and does not prevent write skew.',
        'Retry 40001 and 40P01 with jitter; never retry 23505.',
        'Set the isolation level as the first statement of the transaction, before any read.',
        'Read-only transactions can be declared READ ONLY, which lets PostgreSQL skip predicate locks in many plans.',
      ],
      production: [
        'Every Serializable transaction path has a bounded retry loop with jitter and a metric for exhausted retries.',
        'Integration tests force a serialization failure, not just a clean commit path.',
        'Avoid long transactions at Serializable; SSI tracks predicate locks and memory grows with transaction size.',
        'Log the SQLSTATE of every aborted transaction so a retry storm is visible before it becomes an outage.',
      ],
      crates: ['sqlx', 'tokio'],
      github: [{ name: 'launchbadge/sqlx', url: 'https://github.com/launchbadge/sqlx' }],
      pitfall:
        'Catching every database error in the retry wrapper. A unique-constraint violation retried five times with backoff turns a 1 ms failure into a 200 ms one and still fails.',
      resources: [
        {
          title: 'PostgreSQL: Transaction Isolation (chapter 13.2)',
          url: 'https://www.postgresql.org/docs/current/transaction-iso.html',
          kind: 'docs',
        },
        { title: 'sqlx: pools, transactions and query macros', url: 'https://docs.rs/sqlx/latest/sqlx/', kind: 'docs' },
        { title: 'launchbadge/sqlx repository', url: 'https://github.com/launchbadge/sqlx', kind: 'repo' },
      ],
    },
    {
      id: 'c09',
      n: 9,
      title: 'Latching and locking: memory versus data',
      minutes: 75,
      level: 'advanced',
      goal: 'Separate short-lived latches from transaction-scoped locks, implement a lock manager with a wait-for graph, and order latches so no detector is needed.',
      sections: [
        {
          h: 'Two mechanisms, two failure modes',
          p: [
            'A latch protects bytes in memory for microseconds: a page, a hash bucket, a slot array. It is held across a memcpy, never across a disk read, and it has no deadlock detector because it is never held long enough for a cycle to matter - in theory. A lock protects logical data for the life of a transaction and must be visible to a deadlock detector.',
            'Confusing the two produces both bugs at once. A latch held across I/O turns a microsecond critical section into a millisecond one, and throughput collapses under contention. A lock released at the end of a function instead of at commit lets another transaction see uncommitted state, which is exactly the isolation the database promised to prevent.',
          ],
          list: [
            'Latch: physical, short, no deadlock detection, held across memory operations only.',
            'Lock: logical, transaction-scoped, tracked in a lock table, participates in deadlock detection.',
            'Rule of thumb: if the critical section can await or block on I/O, it is not a latch section.',
          ],
        },
        {
          h: 'Modes, intentions, and two-phase locking',
          p: [
            'Locks come in modes with a compatibility matrix: shared conflicts with exclusive, and intention modes let a table-level request coexist with row-level requests. A transaction that wants to write one row takes an intention-exclusive lock on the table and an exclusive lock on the row, so a table-level exclusive request only has to check the table.',
            'Two-phase locking is the correctness rule: a transaction acquires all its locks before releasing any. That is what makes a schedule conflict-serializable. Most engines relax it for reads through MVCC, which is why the lock table in a modern database is much smaller than the set of rows read.',
          ],
          code: `#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LockMode {
    Shared,
    Exclusive,
}

impl LockMode {
    fn conflicts(self, other: LockMode) -> bool {
        self == LockMode::Exclusive || other == LockMode::Exclusive
    }
}

pub struct LockTable {
    /// resource -> (holder, mode)
    holders: std::collections::HashMap<u64, Vec<(u64, LockMode)>>,
    /// txid -> the txid it is waiting for
    waits: std::collections::HashMap<u64, u64>,
}

impl LockTable {
    pub fn acquire(&mut self, tx: u64, resource: u64, mode: LockMode) -> Result<(), u64> {
        let holders = self.holders.entry(resource).or_default();
        if holders.iter().all(|(_, m)| !m.conflicts(mode)) {
            holders.push((tx, mode));
            return Ok(());
        }
        // Report the blocker so the caller can wait and record the edge.
        let blocker = holders[0].0;
        self.waits.insert(tx, blocker);
        Err(blocker)
    }

    pub fn release_all(&mut self, tx: u64) {
        for holders in self.holders.values_mut() {
            holders.retain(|(t, _)| *t != tx);
        }
        self.waits.remove(&tx);
        self.waits.retain(|_, waiting_for| *waiting_for != tx);
    }
}`,
          tip: 'Release all locks at commit or abort, never in the middle. Partial release is how a transaction becomes non-serializable without anyone noticing.',
        },
        {
          h: 'Deadlocks: detect the cycle or prevent it',
          p: [
            'A deadlock is a cycle in the wait-for graph. Detection is cheap if the graph is small: walk from the waiting transaction and see whether you return to it. The victim is chosen by cost, usually the transaction with the least work done, and aborted with a serialization-style error the application retries.',
            'Prevention is better where you control the code: acquire locks in a fixed global order, use lock timeouts as a backstop, and keep transactions short. Latch deadlocks are a code bug rather than a workload property, so the fix is always a documented ordering, for example always parent page before child page.',
          ],
          code: `use std::collections::HashMap;

/// Returns the cycle if adding tx -> blocker closes one.
pub fn find_cycle(waits: &HashMap<u64, u64>, start: u64) -> Option<Vec<u64>> {
    let mut path = vec![start];
    let mut current = start;

    while let Some(&next) = waits.get(&current) {
        if let Some(pos) = path.iter().position(|t| *t == next) {
            return Some(path[pos..].to_vec()); // the cycle itself
        }
        path.push(next);
        current = next;
        if path.len() > 10_000 {
            return None; // defensive: a corrupt graph must not spin forever
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_two_transaction_cycle() {
        let mut waits = HashMap::new();
        waits.insert(1, 2);
        waits.insert(2, 1);
        assert_eq!(find_cycle(&waits, 1), Some(vec![1, 2]));
    }

    #[test]
    fn no_cycle_when_chain_ends() {
        let mut waits = HashMap::new();
        waits.insert(1, 2);
        assert_eq!(find_cycle(&waits, 1), None);
    }
}`,
          tip: 'Cap the walk at a few thousand nodes. A corrupt or adversarial wait-for graph must not turn the deadlock detector into the outage.',
        },
      ],
      exercise: {
        prompt:
          'Add wait-die prevention to the lock table: an older transaction waits, a younger one aborts immediately. Then simulate three transactions acquiring resources in opposite orders and show that wait-die breaks the cycle without a detector.',
        starter: `impl LockTable {
    /// Wait-die: if tx is older than the holder it waits, else it aborts.
    pub fn acquire_wait_die(&mut self, tx: u64, resource: u64, mode: LockMode) -> Result<(), u64> {
        // TODO: compare tx ids (smaller = older), then either wait or abort.
        todo!()
    }
}`,
        hint: 'Transaction ids are assigned monotonically, so a smaller id is older. Older waits, younger aborts and retries with its original id, which keeps it young and therefore abortable.',
        solution: `impl LockTable {
    /// Wait-die: older transactions wait, younger ones abort.
    /// No wait-for cycle can form, because edges always point from
    /// younger to older and ids are fixed for the life of a transaction.
    pub fn acquire_wait_die(&mut self, tx: u64, resource: u64, mode: LockMode) -> Result<(), u64> {
        let holders = self.holders.entry(resource).or_default();
        if holders.iter().all(|(_, m)| !m.conflicts(mode)) {
            holders.push((tx, mode));
            return Ok(());
        }

        let oldest_blocker = holders.iter().map(|(t, _)| *t).min().unwrap();
        if tx < oldest_blocker {
            // We are older: wait for the younger holder to finish.
            self.waits.insert(tx, oldest_blocker);
            Err(oldest_blocker)
        } else {
            // We are younger: die now and retry rather than wait.
            Err(tx)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn younger_aborts_instead_of_forming_a_cycle() {
        let mut table = LockTable { holders: Default::default(), waits: Default::default() };
        assert!(table.acquire_wait_die(1, 10, LockMode::Exclusive).is_ok());
        // tx 2 is younger than holder 1, so it dies rather than waits.
        assert_eq!(table.acquire_wait_die(2, 10, LockMode::Exclusive), Err(2));
        // tx 0 is older, so it waits.
        assert_eq!(table.acquire_wait_die(0, 10, LockMode::Exclusive), Err(1));
    }
}`,
      },
      questions: [
        {
          q: 'What distinguishes a latch from a lock?',
          options: [
            'Latches are stored on disk, locks in memory',
            'A latch protects in-memory structures briefly and has no deadlock detector; a lock protects logical data for a transaction and is tracked for deadlocks',
            'Locks are only used by indexes',
            'Latches are always exclusive',
          ],
          answer: 1,
          explain:
            'The distinction is scope and lifetime: physical and microseconds versus logical and transaction-scoped. Mixing them up produces both contention and isolation bugs.',
        },
        {
          q: 'Why does two-phase locking guarantee conflict serializability?',
          options: [
            'Because it uses shared locks',
            'Because no transaction releases a lock before it has acquired all the locks it will need, so conflicting operations cannot interleave',
            'Because it prevents deadlocks',
            'Because it is enforced by the storage engine',
          ],
          answer: 1,
          explain:
            'Growing and shrinking phases with no release in between force conflicting accesses into a serial order. Deadlocks are a separate problem that 2PL can still cause.',
        },
        {
          q: 'What does wait-die do when a younger transaction requests a lock held by an older one?',
          options: [
            'It waits until the older transaction commits',
            'It aborts immediately, because a younger transaction can never be allowed to wait on an older one',
            'It upgrades its lock',
            'It ignores the conflict',
          ],
          answer: 1,
          explain:
            'Edges always point from younger to older, so cycles cannot form. The younger transaction restarts and retries rather than risking a deadlock.',
        },
      ],
      quickbytes: [
        'If a critical section can block on I/O, it is not a latch section; holding a latch across a disk read serializes the page.',
        'Document latch order once, for example parent before child, and enforce it in review; latch deadlocks are code bugs.',
        'Release all locks at commit or abort, never mid-transaction.',
        'Keep transactions short: lock hold time is the single largest multiplier on contention.',
      ],
      production: [
        'Alert on lock wait time and deadlock rate per query fingerprint, not as one global number.',
        'Set lock_timeout on migrations and batch jobs so they cannot block traffic indefinitely.',
        'Review any transaction that takes more than a handful of locks; it is a latency and deadlock risk.',
        'Log the deadlock victim and the cycle; the cycle shape tells you which code path has the wrong order.',
      ],
      crates: ['parking_lot', 'tokio'],
      github: [{ name: 'Amanieu/parking_lot', url: 'https://github.com/Amanieu/parking_lot' }],
      pitfall:
        'Taking latches in a different order on two code paths, for example leaf-then-parent on insert and parent-then-leaf on split. No deadlock detector watches latches, so the process simply hangs.',
      resources: [
        {
          title: 'PostgreSQL: Explicit Locking (chapter 13.3)',
          url: 'https://www.postgresql.org/docs/current/explicit-locking.html',
          kind: 'docs',
        },
        { title: 'parking_lot: fast Mutex and RwLock', url: 'https://docs.rs/parking_lot/latest/parking_lot/', kind: 'docs' },
        { title: 'Amanieu/parking_lot repository', url: 'https://github.com/Amanieu/parking_lot', kind: 'repo' },
      ],
    },
    {
      id: 'c10',
      n: 10,
      title: 'Query planning: cost models and join order',
      minutes: 90,
      level: 'advanced',
      goal: 'Read a plan as a tree of iterators, compute scan and join costs with the same constants PostgreSQL uses, and diagnose a misestimate from EXPLAIN ANALYZE output.',
      sections: [
        {
          h: 'A plan is a tree of iterators',
          p: [
            'A planner turns a parsed, rewritten query into a tree of physical operators: sequential scan, index scan, bitmap heap scan, nested loop, hash join, merge join, sort, aggregate. Execution pulls rows from the root, and each node pulls from its children, which is the volcano model. Vectorized engines batch rows between nodes instead of pulling one at a time.',
            'Costing is arithmetic over statistics. PostgreSQL charges 1.0 per sequential page read, 4.0 per random page read, and 0.01 per row processed. A 345-page table with 10,000 rows costs 345 * 1.0 + 10,000 * 0.01 = 445 for a full scan, which is exactly the number EXPLAIN prints.',
          ],
          code: `pub struct Stats {
    pub pages: f64,
    pub rows: f64,
}

pub struct Cost {
    pub startup: f64,
    pub total: f64,
    pub rows: f64,
}

// PostgreSQL defaults, in arbitrary units where one sequential page read = 1.
const SEQ_PAGE_COST: f64 = 1.0;
const RANDOM_PAGE_COST: f64 = 4.0;
const CPU_TUPLE_COST: f64 = 0.01;
const CPU_INDEX_TUPLE_COST: f64 = 0.005;

pub fn seq_scan(s: &Stats) -> Cost {
    Cost {
        startup: 0.0,
        total: s.pages * SEQ_PAGE_COST + s.rows * CPU_TUPLE_COST,
        rows: s.rows,
    }
}

/// Index scan: one descent, then a random heap fetch per matching row.
/// Scattered rows touch pages faster than proportionally, so model the
/// number of distinct heap pages as pages * (1 - exp(-matched / pages)).
pub fn index_scan(s: &Stats, selectivity: f64) -> Cost {
    let matched = s.rows * selectivity;
    let heap_pages = s.pages * (1.0 - (-matched / s.pages).exp());
    Cost {
        startup: RANDOM_PAGE_COST, // the index root and a leaf
        total: RANDOM_PAGE_COST
            + matched * CPU_INDEX_TUPLE_COST
            + heap_pages * RANDOM_PAGE_COST
            + matched * CPU_TUPLE_COST,
        rows: matched,
    }
}

/// Crossover: the selectivity below which the index is cheaper than a scan.
pub fn index_crossover(s: &Stats) -> f64 {
    let scan = seq_scan(s).total;
    let mut lo = 0.0;
    let mut hi = 1.0;
    for _ in 0..40 {
        let mid = (lo + hi) / 2.0;
        if index_scan(s, mid).total < scan { lo = mid } else { hi = mid }
    }
    lo
}`,
          tip: 'These constants are per-cluster settings (seq_page_cost, random_page_cost, cpu_tuple_cost). On NVMe, lowering random_page_cost to 1.1 changes plans more than any query rewrite.',
        },
        {
          h: 'Join order is the expensive decision',
          p: [
            'A nested loop costs the outer input once plus the inner input once per outer row, so it wins only when the outer side is tiny or the inner side has an index on the join key. A hash join builds a table from one side and probes it with the other: linear in both inputs, but memory-bound by the build side. A merge join needs both inputs sorted, which is free if an index provides the order and expensive otherwise.',
            'Join order multiplies: with ten tables there are 3.6 million left-deep orders. Planners prune with dynamic programming below a threshold (PostgreSQL switches to a genetic algorithm above geqo_threshold, default 12 tables) and rely on selectivity estimates to compare survivors. Bad statistics therefore produce bad order, and bad order produces the slow query.',
          ],
          code: `/// Pick the cheapest join strategy for two inputs.
pub fn choose_join(outer: &Cost, inner: &Cost, inner_has_index: bool) -> (&'static str, Cost) {
    // Nested loop: outer once, inner re-executed per outer row.
    let nl = Cost {
        startup: outer.startup + inner.startup,
        total: outer.total + outer.rows * inner.total,
        rows: outer.rows * inner.rows,
    };

    // Hash join: build the inner side, probe with the outer side.
    let hash = Cost {
        startup: inner.total,
        total: inner.total + outer.total + (outer.rows + inner.rows) * CPU_TUPLE_COST,
        rows: outer.rows * inner.rows,
    };

    // Merge join: both inputs must already be sorted; sorting is the caller's cost.
    let merge = Cost {
        startup: outer.startup + inner.startup,
        total: outer.total + inner.total,
        rows: outer.rows * inner.rows,
    };

    if inner_has_index && nl.total < hash.total {
        ("nested loop", nl)
    } else if merge.total < hash.total {
        ("merge join", merge)
    } else {
        ("hash join", hash)
    }
}`,
          tip: 'A nested loop over 10,000 outer rows and an index scan costing 8 units each is 80,000 units. A hash join over the same inputs is a few thousand. The row estimate is what decides.',
        },
        {
          h: 'Reading EXPLAIN ANALYZE without fooling yourself',
          p: [
            'The first thing to compare is estimated rows against actual rows, node by node. A factor-of-ten misestimate at a scan propagates upward and changes every decision above it. The second is loops: in a nested loop the inner node reports per-execution averages, so multiply by loops to get total time. The third is buffers, where hit and read tell you whether the plan is I/O bound or CPU bound.',
            'The classic failure is a nested loop chosen on an estimate of one row that actually returns a hundred thousand. It shows up as an inner node with loops=100000 and a total time two orders of magnitude above the estimate. The fix is usually statistics: ANALYZE the table, raise the statistics target on the filtered column, or add an extended statistics object for correlated columns.',
          ],
          code: `-- Capture the plan as JSON so a program can diff estimates against actuals.
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT o.id, o.total
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE c.region = 'eu' AND o.created_at > now() - interval '1 day';

-- Find the worst misestimate per node.
WITH plan AS (
  SELECT $1::jsonb AS doc
)
SELECT node->>'Node Type'                AS node_type,
       (node->>'Plan Rows')::float       AS est_rows,
       (node->>'Actual Rows')::float     AS act_rows,
       round(((node->>'Actual Rows')::numeric + 1) /
             ((node->>'Plan Rows')::numeric + 1), 2) AS ratio,
       (node->>'Actual Loops')::int      AS loops
FROM plan,
     jsonb_path_query(doc, '$.** ? (@."Node Type" != null)') AS node
ORDER BY ratio DESC
LIMIT 5;`,
          tip: 'loops matters: an inner node showing 0.003 ms and loops=100000 is 300 ms of the query. Read per-loop numbers as averages, never as totals.',
        },
      ],
      exercise: {
        prompt:
          'Given a 1,000,000-row table across 20,000 pages, compute the selectivity at which an index scan stops beating a sequential scan using PostgreSQL default constants. Then verify your answer against EXPLAIN on a real table.',
        starter: `pub fn index_crossover(pages: f64, rows: f64) -> f64 {
    // TODO: scan cost = pages * 1.0 + rows * 0.01
    //       index cost = 4.0 + matched * 0.005
    //                    + pages * (1 - exp(-matched / pages)) * 4.0
    //                    + matched * 0.01
    //       bisect on selectivity s, with matched = rows * s.
    todo!()
}`,
        hint: 'The heap-page term saturates, so there is no clean closed form. Bisect between 0 and 1 for forty iterations; expect a crossover near one percent, not fifty.',
        solution: `pub const SEQ_PAGE_COST: f64 = 1.0;
pub const RANDOM_PAGE_COST: f64 = 4.0;
pub const CPU_TUPLE_COST: f64 = 0.01;
pub const CPU_INDEX_TUPLE_COST: f64 = 0.005;

pub fn scan_cost(pages: f64, rows: f64) -> f64 {
    pages * SEQ_PAGE_COST + rows * CPU_TUPLE_COST
}

pub fn index_cost(pages: f64, rows: f64, s: f64) -> f64 {
    let matched = rows * s;
    let heap_pages = pages * (1.0 - (-matched / pages).exp());
    RANDOM_PAGE_COST
        + matched * CPU_INDEX_TUPLE_COST
        + heap_pages * RANDOM_PAGE_COST
        + matched * CPU_TUPLE_COST
}

pub fn index_crossover(pages: f64, rows: f64) -> f64 {
    let scan = scan_cost(pages, rows);
    let (mut lo, mut hi) = (0.0, 1.0);
    for _ in 0..40 {
        let mid = (lo + hi) / 2.0;
        if index_cost(pages, rows, mid) < scan { lo = mid } else { hi = mid }
    }
    lo
}

fn main() {
    let s = index_crossover(20_000.0, 1_000_000.0);
    println!("index wins below {:.2}% selectivity", s * 100.0);

    // scan cost          = 20000 + 10000 = 30000
    // index at 1%        = 4 + 50 + 20000*(1 - e^-0.5)*4 + 100 = 31,630 (loses)
    // index at 0.9%      = 4 + 45 + 20000*(1 - e^-0.45)*4 + 90 = 29,129 (wins)
    assert!((0.008..0.010).contains(&s));
    assert!(index_cost(20_000.0, 1_000_000.0, 0.01) > scan_cost(20_000.0, 1_000_000.0));
}`,
      },
      questions: [
        {
          q: 'A nested loop node shows an inner child with actual time 0.002 ms and loops = 50000. How much time did that child consume in total?',
          options: [
            '0.002 ms',
            'About 100 ms, because the reported time is a per-loop average',
            '50000 ms',
            'It cannot be determined from EXPLAIN',
          ],
          answer: 1,
          explain:
            'Actual time in a repeatedly executed node is per execution. Multiply by loops: 0.002 ms * 50,000 = 100 ms, which is often the bulk of the query.',
        },
        {
          q: 'When is a hash join preferred over a nested loop?',
          options: [
            'When the outer input is very small and the inner has an index',
            'When both inputs are large and the join is an equi-join, so one pass over each input beats re-scanning the inner side',
            'When the inputs are already sorted on the join key',
            'When the query has no WHERE clause',
          ],
          answer: 1,
          explain:
            'A hash join is linear in both inputs but needs memory for the build side. Nested loops win when the outer side is tiny; merge joins win when both sides arrive sorted.',
        },
        {
          q: 'A plan estimates 1 row and returns 100,000 from a nested loop inner side. What is the most likely root cause?',
          options: [
            'The buffer pool is too small',
            'Stale or insufficient statistics on the filtered column, so the planner underestimated selectivity',
            'The index is corrupt',
            'The query uses too many joins',
          ],
          answer: 1,
          explain:
            'The planner chose a nested loop because it believed the outer side produced one row. ANALYZE, a higher statistics target, or extended statistics for correlated columns is the usual fix.',
        },
      ],
      quickbytes: [
        'Compare Plan Rows with Actual Rows node by node; the first large ratio is the root cause, everything above it is a symptom.',
        'Multiply actual time by loops in repeatedly executed nodes, or you will under-report the expensive part of the plan.',
        'Lower random_page_cost on NVMe (1.1 is common); the default of 4.0 still assumes spinning disks.',
        'EXPLAIN (ANALYZE, BUFFERS) is the only version that tells you whether the plan is I/O bound.',
      ],
      production: [
        'Log plans for queries above a latency threshold, with the JSON format so estimates can be compared programmatically.',
        'Alert on estimate-to-actual ratios above 10x; that predicts a plan flip after the next data growth spurt.',
        'Run ANALYZE after bulk loads, and raise the statistics target on columns used in selective filters.',
        'Pin critical query plans only as a last resort; a pinned plan that outlives its data distribution is worse than a bad estimate.',
      ],
      crates: ['sqlx', 'serde_json', 'tokio'],
      github: [{ name: 'launchbadge/sqlx', url: 'https://github.com/launchbadge/sqlx' }],
      pitfall:
        'Tuning a query by adding indexes while the real problem is a stale estimate. The planner is not choosing badly; it is reasoning from statistics that no longer describe the table.',
      resources: [
        {
          title: 'PostgreSQL: Using EXPLAIN (chapter 14.1)',
          url: 'https://www.postgresql.org/docs/current/using-explain.html',
          kind: 'docs',
        },
        {
          title: 'PostgreSQL: Planner Cost Constants (chapter 19.7.2)',
          url: 'https://www.postgresql.org/docs/current/runtime-config-query.html',
          kind: 'docs',
        },
        {
          title: 'CMU Database Group: 15-445 and 15-721 lecture recordings',
          url: 'https://www.youtube.com/@CMUDatabaseGroup',
          kind: 'video',
        },
      ],
    },
    {
      id: 'c11',
      n: 11,
      title: 'Index selection: when a scan beats an index',
      minutes: 75,
      level: 'advanced',
      goal: 'Estimate the selectivity at which an index scan loses to a sequential scan, use composite indexes under the left-prefix rule, and account for the write cost every index adds.',
      sections: [
        {
          h: 'The heap fetch is the expensive half',
          p: [
            'An index scan is two operations: descend the B+tree to find matching keys, then fetch each matching row from the heap by physical address. The descent is a few page reads and is usually cached. The heap fetches are random I/O, and they dominate once more than a small fraction of the table matches.',
            'A bitmap index scan changes the shape of the problem. It collects all matching tuple ids from the index, sorts them by page, then reads the heap in physical order. That converts thousands of random reads into a sequential sweep with one recheck per row, which is why it appears for medium-selectivity predicates where a plain index scan would thrash.',
          ],
          code: `-- 1. Low selectivity: one row, plain index scan is right.
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders WHERE id = 42;
-- Index Scan using orders_pkey  (cost=0.43..8.45 rows=1)

-- 2. Medium selectivity: bitmap scan sorts tuple ids, then reads the heap.
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders WHERE created_at > now() - interval '3 days';
-- Bitmap Heap Scan on orders  (cost=5.06..224.98 rows=100)
--   Recheck Cond: (created_at > ...)
--   ->  Bitmap Index Scan on orders_created_at_idx

-- 3. High selectivity: the heap fetch is the whole table, so scan it once.
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders WHERE status <> 'cancelled';
-- Seq Scan on orders  (cost=0.00..445.00 rows=9000)`,
          tip: 'BUFFERS separates the two costs: shared hit in the index node means the tree is cached, while read in the heap node means the random I/O is the problem.',
        },
        {
          h: 'Composite indexes and the left-prefix rule',
          p: [
            'An index on (a, b, c) is sorted by a, then b, then c. It can serve predicates on a, on (a, b), or on (a, b, c), and it can serve ORDER BY a, b. It cannot efficiently serve a predicate on b alone, because matching b values are scattered across every a. That is the left-prefix rule, and it is the most common source of an index that exists but is never used.',
            'Two refinements matter in practice. A skip scan lets the planner use a low-cardinality leading column by jumping between distinct values, which PostgreSQL 18 exposes as multiple index searches in EXPLAIN. An INCLUDE clause adds payload columns to the leaf pages only, so an index-only scan can answer the query without touching the heap at all.',
          ],
          code: `-- Covers WHERE tenant_id = ? AND created_at > ? ORDER BY created_at.
CREATE INDEX orders_tenant_created_idx
    ON orders (tenant_id, created_at DESC);

-- Covering: payload in the leaf, key order unchanged.
CREATE INDEX orders_tenant_created_covering_idx
    ON orders (tenant_id, created_at DESC)
    INCLUDE (total_cents, status);

-- Index-only scan: heap fetches drop to zero while the visibility map is set.
EXPLAIN (ANALYZE, BUFFERS)
SELECT created_at, total_cents
FROM orders
WHERE tenant_id = 7 AND created_at > now() - interval '1 day';
-- Index Only Scan using orders_tenant_created_covering_idx
--   Heap Fetches: 0

-- Not served by the same index: no leading tenant_id.
EXPLAIN SELECT * FROM orders WHERE created_at > now() - interval '1 day';
-- Seq Scan on orders  (cost=0.00..445.00 rows=9000)`,
          tip: 'Write the WHERE and ORDER BY clauses first, then design one index that serves both. An index that matches the filter but not the sort still leaves a Sort node in the plan.',
        },
        {
          h: 'Every index is a write tax',
          p: [
            'An insert updates every index on the table, each with its own page splits, WAL records and cache pressure. Five indexes turn one row insert into six page modifications. On a write-heavy table, unused indexes are not neutral: they consume buffer pool, generate WAL, and slow every write while returning nothing.',
            'The fix is measurement, not intuition. PostgreSQL records index usage in pg_stat_user_indexes.idx_scan, and a unique index that only enforces a constraint will show zero scans forever. Drop it and keep the constraint as a unique constraint, which is implemented with an index you actually need.',
          ],
          code: `-- Indexes that have never been used since the last statistics reset.
SELECT relname AS table, indexrelname AS index,
       idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE idx_scan = 0
  AND indexrelid NOT IN (SELECT conindid FROM pg_constraint)
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT 20;

-- Reset counters, wait a full business cycle, then look again.
SELECT pg_stat_reset();

-- Duplicate indexes: same leading columns, one is redundant.
SELECT indrelid::regclass AS table,
       array_agg(indexrelid::regclass) AS indexes,
       indkey
FROM pg_index
GROUP BY indrelid, indkey
HAVING count(*) > 1;`,
          tip: 'Reset statistics, wait a full weekly cycle including month-end jobs, and only then drop. A monthly report query will look unused for 29 days.',
        },
      ],
      exercise: {
        prompt:
          'A table has 2 million rows, 50,000 pages, and three queries: lookup by email, list by tenant ordered by created_at, and count by status. Choose indexes, justify each with a cost estimate, and name the one query you would deliberately leave unindexed.',
        starter: `-- 1. SELECT id FROM users WHERE email = $1;
-- 2. SELECT id, created_at FROM events WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50;
-- 3. SELECT count(*) FROM events WHERE status = 'failed';

-- TODO: write the CREATE INDEX statements and explain each choice.`,
        hint: 'Email is unique and highly selective: a unique index. Tenant plus created_at needs a composite in that order to avoid a sort. Status is low cardinality, so an index on it rarely beats a scan unless it is partial.',
        solution: `-- 1. Point lookup, unique, highly selective.
CREATE UNIQUE INDEX users_email_key ON users (email);

-- 2. Filter and sort served by one composite index, in that order.
--    Without tenant_id first, the sort would need a separate Sort node.
CREATE INDEX events_tenant_created_idx
    ON events (tenant_id, created_at DESC);

-- 3. Low cardinality: index only the rare value, and only if failures are rare.
--    A partial index stays small and is only usable for this predicate.
CREATE INDEX events_failed_idx
    ON events (created_at)
    WHERE status = 'failed';

-- Deliberately not indexed: SELECT count(*) FROM events;
-- A full count must read every row (or every index entry). An index on
-- status would not help a global count and would tax every insert.

-- Verify each choice instead of trusting the reasoning:
EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM users WHERE email = 'a@b.c';
EXPLAIN (ANALYZE, BUFFERS)
  SELECT id, created_at FROM events
  WHERE tenant_id = 7 ORDER BY created_at DESC LIMIT 50;`,
      },
      questions: [
        {
          q: 'Why can an index on (a, b, c) not efficiently serve a query filtered only on b?',
          options: [
            'Because b is not a key column',
            'Because entries are sorted by a first, so equal b values are scattered across the whole index',
            'Because composite indexes are always larger than the table',
            'Because PostgreSQL forbids it',
          ],
          answer: 1,
          explain:
            'The index is ordered by the leading column. Without a predicate on a, matching b values are spread over every a value, so the scan degenerates to a full index scan.',
        },
        {
          q: 'What does a bitmap index scan change compared with a plain index scan?',
          options: [
            'It avoids reading the index',
            'It collects tuple ids, sorts them by page, and reads the heap in physical order, turning random I/O into a mostly sequential sweep',
            'It only works on primary keys',
            'It caches the whole table in memory',
          ],
          answer: 1,
          explain:
            'The bitmap converts random heap fetches into page-ordered access, at the cost of a recheck because the bitmap is lossy for some predicates.',
        },
        {
          q: 'What is the real cost of an unused index on a write-heavy table?',
          options: [
            'None, if it is never read',
            'Every insert and update maintains it: extra page writes, WAL volume and buffer pool pressure for no read benefit',
            'It only costs disk space',
            'It slows down only DELETEs',
          ],
          answer: 1,
          explain:
            'Index maintenance happens on the write path regardless of reads. Unused indexes are pure write amplification, which is why pg_stat_user_indexes exists.',
        },
      ],
      quickbytes: [
        'Index the filter and the sort with one composite index, in that order, or you keep the Sort node.',
        'A partial index on the rare value is usually better than an index on a low-cardinality column.',
        'Check idx_scan after a full business cycle before dropping an index; monthly queries look unused for weeks.',
        'INCLUDE puts payload in the leaf only, enabling index-only scans without changing the key order.',
      ],
      production: [
        'Review pg_stat_user_indexes monthly and drop indexes with zero scans that are not backing a constraint.',
        'Create indexes CONCURRENTLY in production; a plain CREATE INDEX blocks writes for the duration.',
        'Alert when an index grows faster than its table; that signals a random key or a duplicated index.',
        'Track index-only scan ratio per table; a falling ratio means the visibility map is stale and vacuum is behind.',
      ],
      crates: ['sqlx', 'tokio'],
      github: [{ name: 'launchbadge/sqlx', url: 'https://github.com/launchbadge/sqlx' }],
      pitfall:
        'Indexing a column and then filtering on an expression, as in WHERE lower(email) = $1. The plain index is unusable; you need an expression index on lower(email) or a normalized column.',
      resources: [
        {
          title: 'PostgreSQL: Index-Only Scans and Covering Indexes',
          url: 'https://www.postgresql.org/docs/current/indexes-index-only-scans.html',
          kind: 'docs',
        },
        {
          title: 'The Case for Learned Index Structures (arXiv:1712.01208)',
          url: 'https://arxiv.org/abs/1712.01208',
          kind: 'paper',
        },
        {
          title: 'PostgreSQL: Using EXPLAIN (chapter 14.1)',
          url: 'https://www.postgresql.org/docs/current/using-explain.html',
          kind: 'docs',
        },
      ],
    },
    {
      id: 'c12',
      n: 12,
      title: 'Joins and aggregation under memory pressure',
      minutes: 90,
      level: 'advanced',
      goal: 'Choose between nested loop, hash and merge join from input sizes, recognise a hash join that spills to disk, and implement a two-phase aggregate that bounds memory.',
      sections: [
        {
          h: 'Three join algorithms, three cost shapes',
          p: [
            'A nested loop is the only join that can use an index on the inner side, and it is the only one that streams results without materializing. Its cost is outer rows times inner cost per row, so it wins when the outer side is small and the inner side is indexed. It loses catastrophically when a bad estimate makes the outer side large.',
            'A hash join reads the build side into a hash table, then probes it with the other side: linear in both inputs, but memory-bound by the build side. A merge join requires both inputs sorted on the join key and then walks them in lockstep; it is the best choice when an index already provides the order, and the worst when it forces two sorts.',
          ],
          list: [
            'Nested loop: O(outer * inner_lookup), streams, needs an inner index, best for small outer inputs.',
            'Hash join: O(outer + inner), needs work_mem for the build side, spills to batches when it does not fit.',
            'Merge join: O(sort + outer + inner), no memory spike, best when inputs arrive sorted.',
          ],
        },
        {
          h: 'When the hash table does not fit',
          p: [
            'PostgreSQL gives each hash join node work_mem, multiplied by hash_mem_multiplier (2.0 by default) for hash-based operations. If the build side still exceeds that, the join switches to batched mode: both inputs are partitioned into files, and each batch is joined separately. EXPLAIN shows this as Batches greater than 1, and the cost is an extra write and read of both inputs.',
            'The fix is not always more memory. A join that builds on a filtered 100-row side instead of an unfiltered 10-million-row side needs no extra memory at all, so check which side the planner chose to hash. Pushing a predicate below the join, or adding the right index, frequently removes the spill without touching work_mem.',
          ],
          code: `-- Batches > 1 means the hash join spilled to disk.
EXPLAIN (ANALYZE, BUFFERS)
SELECT c.id, count(*)
FROM customers c
JOIN orders o ON o.customer_id = c.id
WHERE o.created_at > now() - interval '7 days'
GROUP BY c.id;

-- Hash Join  (cost=... rows=...)
--   Hash Cond: (o.customer_id = c.id)
--   ->  Seq Scan on customers c
--   ->  Hash  (cost=... rows=...)
--         Buckets: 262144  Batches: 8  Memory Usage: 4097kB
--         ->  Bitmap Heap Scan on orders o

-- Reduce the build side instead of raising work_mem globally.
SET work_mem = '64MB';            -- per node, per connection: risky at scale
SET enable_hashjoin = off;        -- diagnostic only, never in production
ANALYZE orders;                   -- refresh the estimate first`,
          tip: 'work_mem is per sort or hash node per connection. Setting it to 256 MB with 200 connections allows 50 GB of allocations, and the OOM killer does not read your config.',
        },
        {
          h: 'Aggregation: hash, sort, or two-phase',
          p: [
            'Hash aggregation keeps one entry per group in memory and updates it as rows arrive; it needs memory proportional to the number of distinct groups, not the number of rows. Sort-based aggregation sorts by group key and folds adjacent rows, which is linear in memory but pays for the sort - unless an index already provides the order.',
            'Distributed and parallel plans add a second decision: aggregate before or after the shuffle. Partial aggregation computes per-worker groups first, then a final node merges them, which shrinks the data crossing the network from rows to groups. Doing the same thing locally - aggregate per chunk, then merge - is how you keep memory bounded when the group count is unknown.',
          ],
          code: `use std::collections::HashMap;

/// Two-phase aggregation: bound memory by spilling partial groups to a sink
/// instead of holding every group for the whole input.
pub struct PartialAgg {
    counts: HashMap<u64, u64>,
    capacity: usize,
    spilled: Vec<HashMap<u64, u64>>,
}

impl PartialAgg {
    pub fn new(capacity: usize) -> Self {
        Self { counts: HashMap::new(), capacity, spilled: Vec::new() }
    }

    pub fn push(&mut self, key: u64) {
        *self.counts.entry(key).or_insert(0) += 1;
        if self.counts.len() >= self.capacity {
            // Spill this chunk; a later pass merges the partial maps.
            self.spilled.push(std::mem::take(&mut self.counts));
        }
    }

    pub fn finish(mut self) -> HashMap<u64, u64> {
        for chunk in self.spilled.drain(..) {
            for (key, count) in chunk {
                *self.counts.entry(key).or_insert(0) += count;
            }
        }
        self.counts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spills_and_merges_to_the_same_result() {
        let mut agg = PartialAgg::new(2);
        for key in [1, 1, 2, 3, 3, 3, 1] {
            agg.push(key);
        }
        let result = agg.finish();
        assert_eq!(result.get(&1), Some(&3));
        assert_eq!(result.get(&2), Some(&1));
        assert_eq!(result.get(&3), Some(&3));
    }
}`,
          tip: 'If the group count is bounded and small, hash aggregation is strictly better. If it can be millions of distinct keys, sort-based aggregation or spilling is the only safe option.',
        },
      ],
      exercise: {
        prompt:
          'Given a 10-million-row orders table and a 100,000-row customers table, estimate the cost of a nested loop with an index on orders.customer_id versus a hash join. Then explain which side should be hashed and why.',
        starter: `// outer = customers (100_000 rows, 2_000 pages)
// inner = orders indexed on customer_id, ~100 orders per customer
// TODO: compute both totals in the units used by EXPLAIN,
//       then decide which side to build the hash table from.`,
        hint: 'Nested loop: 100,000 outer rows times the cost of one index lookup (roughly 4 + 100 heap pages). Hash join: scan both tables once plus CPU per row. The hash build side should be the smaller relation.',
        solution: `const SEQ_PAGE_COST: f64 = 1.0;
const RANDOM_PAGE_COST: f64 = 4.0;
const CPU_TUPLE_COST: f64 = 0.01;

pub struct Rel {
    pub rows: f64,
    pub pages: f64,
}

pub fn seq_scan(r: &Rel) -> f64 {
    r.pages * SEQ_PAGE_COST + r.rows * CPU_TUPLE_COST
}

/// Nested loop: one indexed lookup per outer row.
/// Each lookup is one index descent plus ~orders_per_customer heap pages.
pub fn nested_loop(outer: &Rel, orders_per_customer: f64) -> f64 {
    let per_lookup = RANDOM_PAGE_COST
        + orders_per_customer * RANDOM_PAGE_COST
        + orders_per_customer * CPU_TUPLE_COST;
    outer.rows * per_lookup
}

/// Hash join: scan both sides once, then hash and probe every row.
pub fn hash_join(build: &Rel, probe: &Rel) -> f64 {
    seq_scan(build) + seq_scan(probe) + (build.rows + probe.rows) * CPU_TUPLE_COST
}

fn main() {
    let customers = Rel { rows: 100_000.0, pages: 2_000.0 };
    let orders = Rel { rows: 10_000_000.0, pages: 200_000.0 };

    let nl = nested_loop(&customers, 100.0);
    let hj = hash_join(&customers, &orders); // build on customers: 100k rows fits

    println!("nested loop: {nl:.0} units");
    println!("hash join:   {hj:.0} units");
    println!("speedup:     {:.0}x", nl / hj);

    // 100_000 * (4 + 400 + 1) = 40.5M units for the nested loop.
    assert!((nl - 40_500_000.0).abs() < 1.0);
    // 3_000 + 300_000 + 101_000 = ~404k units for the hash join.
    assert!((hj - 404_000.0).abs() < 2_000.0);
    assert!(nl / hj > 50.0);

    // Build the hash table from customers, the smaller side: 100k rows of
    // key plus payload fits in a few MB, so Batches stays at 1. Building on
    // orders would need ~10M entries and would spill to disk immediately.
}`,
      },
      questions: [
        {
          q: 'What does Batches: 8 in a hash join node tell you?',
          options: [
            'The join ran with 8 parallel workers',
            'The hash table did not fit in work_mem, so both inputs were partitioned into 8 on-disk batches',
            'The join produced 8 output rows',
            'The table has 8 partitions',
          ],
          answer: 1,
          explain:
            'Batched mode means the build side exceeded work_mem and the join spilled. That adds a write and a read of both inputs, usually an order of magnitude slower.',
        },
        {
          q: 'Which join algorithm streams results without materializing either input?',
          options: ['Hash join', 'Merge join', 'Nested loop', 'None of them'],
          answer: 2,
          explain:
            'A nested loop can emit a row as soon as it finds a match, which matters for LIMIT queries and for the first-row latency of an API.',
        },
        {
          q: 'Why does partial aggregation reduce network traffic in a distributed plan?',
          options: [
            'It compresses each row',
            'It sends one row per group instead of one row per input row, and the final node merges the partial results',
            'It skips the shuffle entirely',
            'It uses a smaller hash function',
          ],
          answer: 1,
          explain:
            'Partial aggregation collapses rows into per-group counters before the exchange, so the shuffle carries group count rather than row count.',
        },
      ],
      quickbytes: [
        'Check which side the planner builds the hash from; hashing the filtered small side removes most spills.',
        'work_mem is per node per connection; multiply by max_connections before raising it.',
        'A merge join is free when an index provides the order and expensive when it forces two sorts.',
        'Partial aggregation is the local equivalent of a distributed shuffle reduction: aggregate per chunk, then merge.',
      ],
      production: [
        'Alert on Batches greater than 1 in logged plans; disk-spilling joins are the most common cause of a sudden latency cliff.',
        'Keep the build side small by pushing filters below the join rather than by raising work_mem globally.',
        'Track temp file usage per database; it is the direct signal of sorts and hashes spilling.',
        'Test with production-sized data; a plan that fits in work_mem at 1 percent of the rows may spill at full size.',
      ],
      crates: ['sqlx', 'tokio'],
      github: [{ name: 'launchbadge/sqlx', url: 'https://github.com/launchbadge/sqlx' }],
      pitfall:
        'Raising work_mem to fix one slow query. The setting applies per operation per connection, so a busy pool can allocate many gigabytes and the OOM killer takes down the database instead of the query.',
      resources: [
        {
          title: 'PostgreSQL: Using EXPLAIN (chapter 14.1)',
          url: 'https://www.postgresql.org/docs/current/using-explain.html',
          kind: 'docs',
        },
        {
          title: 'PostgreSQL: Statistics Used by the Planner (chapter 14.2)',
          url: 'https://www.postgresql.org/docs/current/planner-stats.html',
          kind: 'docs',
        },
        {
          title: 'PostgreSQL: Resource Consumption, work_mem and hash_mem_multiplier (19.4.1)',
          url: 'https://www.postgresql.org/docs/current/runtime-config-resource.html',
          kind: 'docs',
        },
      ],
    },
    {
      id: 'c13',
      n: 13,
      title: 'Replication: logs, quorum, and failover',
      minutes: 90,
      level: 'industry',
      goal: 'Distinguish physical from logical replication, apply the Raft commit rule to a replicated log, and quantify the data loss window of an asynchronous replica.',
      sections: [
        {
          h: 'Physical versus logical replication',
          p: [
            'Physical replication ships the write-ahead log byte for byte, so the standby is a block-level copy of the primary: same page layout, same indexes, same everything. It is cheap and exact, and it cannot replicate between versions or between a subset of tables. Streaming replication is physical replication over a socket instead of a shared archive.',
            'Logical replication decodes the log into row-level changes and applies them through the normal write path. It can cross major versions, replicate selected tables, and feed a different schema, at the cost of more CPU on the publisher and a different failure surface, including conflicts when the subscriber is written to independently.',
          ],
          list: [
            'Synchronous commit: the primary waits for the standby to acknowledge before reporting commit, so RPO is zero at the cost of latency.',
            'Asynchronous: the primary commits locally and streams afterwards, so a failover loses everything not yet replayed.',
            'Quorum commit: the primary waits for any k of n standbys, which survives one slow replica without stalling.',
          ],
        },
        {
          h: 'Raft: commit is a majority decision',
          p: [
            'Raft makes the log the source of truth. A leader appends an entry, replicates it, and marks it committed once a majority of servers have it in their log; only then does it apply the entry to the state machine and answer the client. Entries carry a term and an index, and a follower rejects an append whose previous entry does not match, which forces the leader to repair history.',
            'Two safety rules do the heavy lifting. A leader never overwrites or deletes entries in its own log, and a candidate can only win with a log at least as up-to-date as a majority. Together they guarantee that a committed entry appears in the log of every future leader, which is what makes the majority commit rule safe rather than merely plausible.',
          ],
          code: `pub struct Entry {
    pub term: u64,
    pub index: u64,
    pub command: Vec<u8>,
}

/// The commit rule: an entry is committed once it is stored on a majority.
/// match_index[i] is the highest index known replicated on server i.
pub fn advance_commit(leader_term: u64, log: &[Entry], match_index: &[u64]) -> u64 {
    let mut sorted = match_index.to_vec();
    sorted.sort_unstable_by(|a, b| b.cmp(a)); // descending

    let majority = sorted.len() / 2; // index of the median for odd n
    let candidate = sorted[majority];

    match log.iter().find(|e| e.index == candidate) {
        // Raft's Figure 8 caveat: only commit entries from the current term
        // directly; earlier entries commit indirectly when a current-term
        // entry above them commits.
        Some(entry) if entry.term == leader_term => candidate,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn majority_of_five_is_three() {
        let log: Vec<Entry> = (1..=10)
            .map(|i| Entry { term: 2, index: i, command: vec![] })
            .collect();
        // Three servers at index 10, two lagging at index 4.
        assert_eq!(advance_commit(2, &log, &[10, 10, 10, 4, 4]), 10);
        // Only two at 10: the median is 4, so nothing new commits.
        assert_eq!(advance_commit(2, &log, &[10, 10, 4, 4, 4]), 4);
    }
}`,
          tip: 'Never commit an entry from a previous term just because it is on a majority; that is the Figure 8 bug. Commit it indirectly via a current-term entry above it.',
        },
        {
          h: 'Failover: measure the window, then fence',
          p: [
            'With asynchronous replication the loss window is the replay lag measured in bytes of WAL, converted to time by the write rate. A standby 40 MB behind at 10 MB/s of WAL generation is four seconds from losing four seconds of committed transactions. The application was told those commits succeeded, so this is silent data loss, not a clean failure.',
            'Promotion also needs fencing. An old primary that still believes it is primary will accept writes that the new primary never sees, and the two histories diverge. Fencing is a mechanism that makes the old primary unable to write: revoke its credentials, stop its instance through the orchestrator, or rely on a lease that expires. Never promote without it.',
          ],
          code: `-- On the primary: who is connected, and how far behind are they?
SELECT client_addr, state,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) AS replay_lag_bytes,
       replay_lag
FROM pg_stat_replication;

-- On the standby: how stale is the data I would serve?
SELECT now() - pg_last_xact_replay_timestamp() AS replay_delay,
       pg_is_in_recovery() AS is_standby;

-- Zero-RPO option: wait for one standby to flush, not to apply.
ALTER SYSTEM SET synchronous_commit = 'remote_write';
ALTER SYSTEM SET synchronous_standby_names = 'ANY 1 (replica_a, replica_b)';
SELECT pg_reload_conf();`,
          tip: 'remote_write waits for the standby OS to receive the WAL, not for it to be applied. It survives a primary crash but not a standby crash before fsync.',
        },
      ],
      exercise: {
        prompt:
          'A primary generates 12 MB/s of WAL and the standby is 60 MB behind. Compute the data-loss window in seconds, then state the synchronous_commit setting that closes it and the latency cost you accept.',
        starter: `// lag_bytes = 60 MB, wal_rate = 12 MB/s
// TODO: compute the window, then pick a synchronous_commit mode
//       and name what it protects against and what it does not.`,
        hint: '60 / 12 = 5 seconds of committed transactions at risk. remote_write closes the window against primary crash; remote_apply additionally guarantees the standby has applied them, which readers can observe.',
        solution: `// 60 MB of WAL behind at 12 MB/s is a 5 second window: every transaction
// committed in the last 5 seconds is on the primary and nowhere else.
//
// Options, from weakest to strongest:
//
//   synchronous_commit = off
//     Local commit returns before the local WAL is flushed. Fast, but a
//     primary crash can lose recent commits even with no replica involved.
//
//   synchronous_commit = on
//     Local flush, then acknowledge. Zero loss on primary crash, full 5 s
//     window on failover to an async standby.
//
//   synchronous_commit = remote_write
//     Wait until a quorum of standbys has received and written the WAL.
//     Survives primary crash with zero loss; a standby crash before its own
//     fsync can still lose the tail.
//
//   synchronous_commit = remote_apply
//     Wait until the standby has applied the change, so a read on the standby
//     sees it. Strongest, and the slowest: commit latency now includes
//     replay, not just network and write.
//
//   synchronous_standby_names = 'ANY 1 (a, b)'
//     Quorum rather than a named primary standby, so one slow replica does
//     not stall every commit.

fn loss_window_secs(lag_bytes: f64, wal_bytes_per_sec: f64) -> f64 {
    lag_bytes / wal_bytes_per_sec
}

fn main() {
    let window = loss_window_secs(60.0 * 1024.0 * 1024.0, 12.0 * 1024.0 * 1024.0);
    assert!((window - 5.0).abs() < 0.001);
    println!("RPO with async replication: {window} s");
}`,
      },
      questions: [
        {
          q: 'What is the fundamental difference between physical and logical replication?',
          options: [
            'Physical ships WAL blocks; logical decodes row changes and applies them through the write path',
            'Physical is always synchronous; logical is always asynchronous',
            'Logical replicates indexes; physical replicates tables',
            'They are the same mechanism with different names',
          ],
          answer: 0,
          explain:
            'Physical replication is a block-level copy and cannot cross major versions or select tables. Logical replication decodes changes, which is more flexible and more expensive.',
        },
        {
          q: 'In Raft, when is a log entry considered committed?',
          options: [
            'When the leader writes it to its own disk',
            'When a majority of servers have stored it, and it is from the leader current term',
            'When every follower acknowledges it',
            'When the client receives the response',
          ],
          answer: 1,
          explain:
            'Majority storage is the safety condition; the current-term restriction avoids committing an entry that a later leader could still overwrite.',
        },
        {
          q: 'Why is promoting an asynchronous standby dangerous without fencing the old primary?',
          options: [
            'The standby will refuse writes',
            'The old primary can keep accepting writes that the new primary never sees, producing two diverging histories',
            'Replication slots will be dropped',
            'The WAL will be corrupted',
          ],
          answer: 1,
          explain:
            'Split brain. Fencing makes the old primary unable to write before promotion, usually by revoking credentials or stopping the instance through the orchestrator.',
        },
      ],
      quickbytes: [
        'Convert replay lag in bytes to seconds using the WAL generation rate; that number is your RPO.',
        'Use synchronous_standby_names with ANY k (…) so one slow replica does not stall every commit.',
        'Never promote without fencing the old primary; credentials, lease, or orchestrator stop.',
        'Test failover on a schedule and measure the actual loss window; a runbook that has never run is a guess.',
      ],
      production: [
        'Alert on replay lag in seconds, not bytes; bytes mean nothing without the write rate.',
        'Record the configured RPO and the measured RPO separately, and review them after every failover drill.',
        'Run standbys with enough IOPS to keep up with peak WAL generation, or the lag grows during exactly the incident you care about.',
        'Automate fencing before promotion in the failover path; a manual step under pressure gets skipped.',
      ],
      crates: ['openraft', 'tokio', 'sqlx'],
      github: [{ name: 'datafuselabs/openraft', url: 'https://github.com/datafuselabs/openraft' }],
      pitfall:
        'Treating a replica as a backup. A replica faithfully applies a DROP TABLE in milliseconds; point-in-time recovery needs an archive of WAL plus base backups, not a second copy of the current state.',
      resources: [
        {
          title: 'In Search of an Understandable Consensus Algorithm (Raft paper)',
          url: 'https://raft.github.io/raft.pdf',
          kind: 'paper',
        },
        { title: 'The Raft consensus site: visualisation and talks', url: 'https://raft.github.io/', kind: 'docs' },
        { title: 'openraft: a Rust Raft implementation', url: 'https://docs.rs/openraft/latest/openraft/', kind: 'docs' },
        { title: 'datafuselabs/openraft repository', url: 'https://github.com/datafuselabs/openraft', kind: 'repo' },
      ],
    },
    {
      id: 'c14',
      n: 14,
      title: 'Sharding: keys, routing, and resharding',
      minutes: 90,
      level: 'industry',
      goal: 'Choose a shard key from access patterns rather than cardinality alone, implement a vnode hash ring, and move a shard without downtime using dual writes and a read cutover.',
      sections: [
        {
          h: 'The shard key is an API decision',
          p: [
            'A shard key decides which node owns a row, and that decision is effectively permanent because changing it requires moving data. Choose it from the queries that must be single-shard: if the product always reads a tenant together, tenant_id is the key, even if user_id has higher cardinality. Cardinality matters for balance; access pattern matters for correctness and latency.',
            'Every cross-shard operation becomes application work. A join between shards is two queries and a merge; a transaction spanning shards needs two-phase commit or a saga; a unique constraint across shards needs a global index or a coordination service. Count those operations before committing to a key, and prefer the key that makes the hot path single-shard.',
          ],
          list: [
            'High cardinality avoids hot shards but does not guarantee even load: one tenant can still dominate.',
            'Low-cardinality keys such as country or plan tier concentrate writes on a few shards.',
            'Monotonic keys such as timestamps or auto-increment ids send all new writes to the last shard.',
          ],
        },
        {
          h: 'Hash, range, or directory routing',
          p: [
            'Range sharding keeps ordered data together, so range scans stay single-shard, but it creates hotspots when writes are append-only. Hash sharding spreads writes evenly and destroys locality, so every range query fans out. Directory routing keeps an explicit mapping from key to shard, which is the most flexible and adds a lookup and a single point of change.',
            'Consistent hashing with virtual nodes is the usual compromise. Each physical shard owns many positions on a hash ring, so adding a shard moves roughly 1/n of the keys instead of reshuffling everything. Virtual nodes also fix the balance problem: with 100 to 200 vnodes per shard, distribution is close to uniform even for a few shards.',
          ],
          code: `use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};

pub struct Ring {
    /// hash position -> shard id, sorted so we can find the next owner.
    vnodes: BTreeMap<u64, usize>,
    replicas: usize,
}

impl Ring {
    pub fn new(shards: &[usize], replicas: usize) -> Self {
        let mut vnodes = BTreeMap::new();
        for &shard in shards {
            for i in 0..replicas {
                vnodes.insert(Self::hash(&(shard, i)), shard);
            }
        }
        Self { vnodes, replicas }
    }

    fn hash<T: Hash>(value: &T) -> u64 {
        // A stable hash is mandatory: std DefaultHasher is not guaranteed
        // stable across releases, so use a fixed one (xxh3, fnv) in production.
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        value.hash(&mut hasher);
        hasher.finish()
    }

    pub fn shard_for(&self, key: &[u8]) -> Option<usize> {
        let h = Self::hash(&key);
        // First vnode clockwise from the key; wrap around at the end.
        self.vnodes.range(h..).next().or_else(|| self.vnodes.iter().next()).map(|(_, s)| *s)
    }

    /// How many keys move if one shard joins or leaves: about 1/n.
    pub fn moved_fraction(&self, shards: usize) -> f64 {
        1.0 / shards as f64
    }
}`,
          tip: 'Use a hash with a documented, stable output. A hash that changes between releases silently remaps every key, which is indistinguishable from data loss.',
        },
        {
          h: 'Resharding without a maintenance window',
          p: [
            'Moving a shard is a four-step protocol. First, dual-write: the application writes to both the old and the new location and reads from the old. Second, backfill: copy existing rows while dual writes keep both copies current. Third, verify: compare checksums or row counts per key range and fix discrepancies. Fourth, cut over reads, then stop dual writes.',
            'Slot-based assignment makes this operationally simpler. Redis Cluster hashes keys into 16384 slots and moves slots between nodes; the mapping is small enough to gossip and to change atomically. The general lesson: decouple the number of logical partitions from the number of physical nodes, so growth is a reassignment rather than a rehash.',
          ],
          code: `-- Dual write inside one transaction is only possible if both shards are
-- on the same server. Across servers, write an outbox row and relay it.
BEGIN;
INSERT INTO orders_2025 (id, tenant_id, total_cents)
VALUES ($1, $2, $3)
ON CONFLICT (id) DO UPDATE SET total_cents = EXCLUDED.total_cents;
INSERT INTO outbox (id, shard, payload)
VALUES (gen_random_uuid(), 'orders_2025', $4);
COMMIT;

-- Backfill in key-range batches so each transaction stays short.
DO $$
DECLARE last_id bigint := 0;
BEGIN
  LOOP
    WITH batch AS (
      SELECT id FROM orders_2025 WHERE id > last_id ORDER BY id LIMIT 1000
    )
    INSERT INTO orders_2025_new (id, tenant_id, total_cents)
    SELECT o.id, o.tenant_id, o.total_cents
    FROM orders_2025 o JOIN batch b ON b.id = o.id
    ON CONFLICT (id) DO NOTHING;

    SELECT coalesce(max(id), last_id) INTO last_id FROM (
      SELECT id FROM orders_2025 WHERE id > last_id ORDER BY id LIMIT 1000
    ) t;
    EXIT WHEN last_id IS NULL;
    COMMIT; -- keep each batch its own transaction
  END LOOP;
END $$;`,
          tip: 'Backfill in bounded key ranges with a commit per batch. One giant INSERT ... SELECT holds locks, bloats the WAL, and cannot be paused when it saturates the primary.',
        },
      ],
      exercise: {
        prompt:
          'Implement a ring with 4 shards and 100 vnodes each, then measure the distribution of 100,000 keys drawn from a Zipf-like distribution. Explain why vnodes reduce variance and what still causes a hot shard.',
        starter: `pub fn distribution(ring: &Ring, keys: impl Iterator<Item = Vec<u8>>) -> Vec<usize> {
    // TODO: count keys per shard id.
    todo!()
}`,
        hint: 'With few vnodes, the arc lengths between positions vary wildly and one shard can own twice its share. Vnodes average that out. A hot shard can still happen when one key is requested far more than the others.',
        solution: `impl Ring {
    pub fn distribution(&self, keys: impl Iterator<Item = Vec<u8>>) -> Vec<usize> {
        let mut counts = vec![0usize; self.vnodes.values().max().map(|m| m + 1).unwrap_or(0)];
        for key in keys {
            if let Some(shard) = self.shard_for(&key) {
                counts[shard] += 1;
            }
        }
        counts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vnodes_even_out_a_small_cluster() {
        let ring = Ring::new(&[0, 1, 2, 3], 100);
        let keys = (0..100_000u64).map(|i| i.to_le_bytes().to_vec());
        let counts = ring.distribution(keys);

        let total: usize = counts.iter().sum();
        assert_eq!(total, 100_000);
        for count in &counts {
            let share = *count as f64 / total as f64;
            // Within +/-20 percent of the ideal 25 percent share.
            assert!((0.20..0.30).contains(&share), "shard share {share}");
        }
    }
}

// Why variance shrinks: each shard owns ~100 arcs whose lengths are drawn from
// the same distribution, so the sum concentrates around 1/n of the ring.
// A hot shard still happens when a single key is requested far more than the
// rest: hashing balances keys, not traffic.`,
      },
      questions: [
        {
          q: 'Why is a monotonically increasing shard key such as a timestamp a poor choice?',
          options: [
            'It has too few distinct values',
            'All new writes land on the shard that owns the newest range, so one node takes the entire write load',
            'It cannot be hashed',
            'It makes range queries impossible',
          ],
          answer: 1,
          explain:
            'Monotonic keys defeat distribution: the write frontier is a single shard. Timestamp sharding only works if you also shard by another dimension or accept the hotspot.',
        },
        {
          q: 'What do virtual nodes fix in consistent hashing?',
          options: [
            'They encrypt the ring',
            'They give each shard many positions, so removing or adding a shard moves about 1/n of the keys and the load is more evenly spread',
            'They remove the need for a hash function',
            'They make range scans single-shard',
          ],
          answer: 1,
          explain:
            'Without vnodes, arc lengths are uneven and one shard can own a disproportionate share. Many small arcs per shard average out the imbalance.',
        },
        {
          q: 'In a zero-downtime reshard, when is it safe to stop dual writes?',
          options: [
            'As soon as the backfill query finishes',
            'After reads have been cut over to the new location and verification shows both copies agree',
            'Immediately after starting the backfill',
            'Only during a maintenance window',
          ],
          answer: 1,
          explain:
            'Dual writes are the safety net for rows that change during the copy. Removing them before the cutover and verification leaves a window where updates land in only one place.',
        },
      ],
      quickbytes: [
        'Pick the shard key from the queries that must stay single-shard, not from cardinality alone.',
        'Use a stable hash; DefaultHasher output is not guaranteed across Rust releases.',
        '100 to 200 vnodes per shard is enough to keep a small cluster balanced.',
        'Reshard in four steps: dual write, backfill, verify, cut over reads, then stop dual writes.',
      ],
      production: [
        'Record the shard key in the schema and in the API contract; changing it later is a data migration, not a config change.',
        'Alert on per-shard request and storage skew; a 2x skew is the early warning of a hot tenant.',
        'Keep logical partitions (slots) independent of physical nodes so growth is a reassignment.',
        'Rehearse a shard move on a copy of production data before the first real one.',
      ],
      crates: ['sqlx', 'tokio'],
      github: [{ name: 'launchbadge/sqlx', url: 'https://github.com/launchbadge/sqlx' }],
      pitfall:
        'Hashing on a low-cardinality column such as country or plan tier. Every key lands on a handful of shards, the rest sit idle, and adding shards does not move any load.',
      resources: [
        { title: 'sqlx: pools and transactions for per-shard clients', url: 'https://docs.rs/sqlx/latest/sqlx/', kind: 'docs' },
        { title: 'launchbadge/sqlx repository', url: 'https://github.com/launchbadge/sqlx', kind: 'repo' },
        { title: 'tokio: runtime primitives for concurrent shard fan-out', url: 'https://docs.rs/tokio/latest/tokio/', kind: 'docs' },
      ],
    },
    {
      id: 'c15',
      n: 15,
      title: 'Connection pooling: sizing, queues, and timeouts',
      minutes: 60,
      level: 'industry',
      goal: 'Size a pool from concurrency rather than request rate, configure acquire and lifetime timeouts, and recognise the session state that transaction-mode pooling breaks.',
      sections: [
        {
          h: 'A connection is a backend process',
          p: [
            'In PostgreSQL, every connection is a server process with its own memory, catalog caches and prepared statements. Opening one costs a TCP handshake, a TLS handshake, authentication and a fork; on a busy service that is milliseconds of latency and real memory per connection. A pool amortizes that cost by keeping connections open and lending them out.',
            'The pool is a queue with a timeout, and that framing matters. When all connections are busy, an acquire call waits; if the wait is unbounded, request latency grows without limit and the service appears hung rather than overloaded. Every pool needs an acquire timeout shorter than the caller deadline, so overload surfaces as a fast, retryable error.',
          ],
          code: `use sqlx::postgres::PgPoolOptions;
use std::time::Duration;

pub async fn connect(url: &str) -> Result<sqlx::PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(20)                                  // hard ceiling
        .min_connections(5)                                   // warm floor
        .acquire_timeout(Duration::from_millis(500))           // fail fast
        .idle_timeout(Duration::from_secs(600))                // shrink when quiet
        .max_lifetime(Duration::from_secs(1800))               // recycle for DNS/failover
        .test_before_acquire(true)                             // drop dead connections
        .connect(url)
        .await
}

pub async fn with_conn<T, F, Fut>(pool: &sqlx::PgPool, f: F) -> Result<T, sqlx::Error>
where
    F: FnOnce(&mut sqlx::PgConnection) -> Fut,
    Fut: std::future::Future<Output = Result<T, sqlx::Error>>,
{
    // The acquire timeout is the pool's job; this is the query budget.
    let mut conn = pool.acquire().await?;
    tokio::time::timeout(Duration::from_secs(2), f(&mut conn))
        .await
        .map_err(|_| sqlx::Error::Protocol("query budget exceeded".into()))?
}`,
          tip: 'Set max_lifetime below your load balancer DNS TTL and below any failover promotion window, or the pool keeps handing out connections to a dead primary.',
        },
        {
          h: 'Size by concurrency, not by request rate',
          p: [
            'Little law gives the number you actually need: concurrent database work equals arrival rate times time in the database. At 2,000 requests per second with 5 ms of database time per request, 10 connections can in principle keep up. A pool of 100 does not make the database faster; it makes 100 requests contend for the same cores and locks at once.',
            'The common heuristic from HikariCP is connections = (cores * 2) + effective_spindle_count, which for a 16-core database with SSD storage suggests a pool in the thirties. Treat it as a starting point for a benchmark, not a law. What is a law: total connections across all application instances must stay well below the database max_connections, with headroom for admin and replication.',
          ],
          code: `// Little law, made explicit so it can be reviewed and tested.
pub struct PoolSizing {
    pub target_rps: f64,
    pub db_time_ms: f64,
    pub instances: u32,
}

impl PoolSizing {
    /// Connections needed per instance, rounded up, with a safety factor.
    pub fn per_instance(&self, safety: f64) -> u32 {
        let concurrent = self.target_rps * (self.db_time_ms / 1000.0);
        let per_instance = concurrent / self.instances as f64;
        (per_instance * safety).ceil().max(2.0) as u32
    }

    /// Check against the server limit, keeping room for admin and replication.
    pub fn fits(&self, pool_per_instance: u32, server_max: u32) -> bool {
        let total = pool_per_instance * self.instances;
        total + 10 <= server_max // 10 reserved for operators and replication
    }
}

fn main() {
    let s = PoolSizing { target_rps: 2000.0, db_time_ms: 5.0, instances: 8 };
    assert_eq!(s.per_instance(1.5), 2); // 10 concurrent / 8 instances * 1.5
    assert!(s.fits(2, 100));
    assert!(!s.fits(20, 100)); // 160 + 10 > 100: the classic over-provisioning bug
}`,
          tip: 'Multiply your pool size by the number of autoscaled replicas. A pool that is safe at 8 instances becomes a database outage at 80.',
        },
        {
          h: 'Pooling in front of the database breaks session state',
          p: [
            'PgBouncer in transaction mode hands a server connection to a client only for the duration of a transaction. That multiplies the number of clients a database can serve, and it breaks everything that assumes session affinity: prepared statements created with a name, SET parameters, advisory locks, LISTEN/NOTIFY, and temporary tables.',
            'The prepared-statement failure is the one that bites Rust services, because drivers cache prepared statements by name. With transaction pooling, a statement prepared on one server connection may be missing on the next, producing errors like prepared statement already exists or does not exist. The fixes are protocol-level prepared statements disabled, or a pool mode that keeps session affinity.',
          ],
          list: [
            'Session mode: full affinity, least multiplexing, safe for everything.',
            'Transaction mode: best multiplexing, breaks session state; disable named prepared statements.',
            'Statement mode: highest multiplexing, breaks multi-statement transactions entirely.',
          ],
        },
      ],
      exercise: {
        prompt:
          'A service runs 12 instances behind an autoscaler, each with a 30-connection pool, against a database with max_connections = 200. Compute the headroom, then resize the pools for 3,000 RPS at 8 ms of database time and show that the new total fits.',
        starter: `// current: 12 * 30 = 360 connections against max_connections = 200
// target:  3000 rps, 8 ms db time, 12 instances
// TODO: compute concurrent work, per-instance pool, and total.`,
        hint: 'Concurrent work = 3000 * 0.008 = 24. Per instance that is 2, and with a 1.5 safety factor it is 3. Total 36, leaving 164 connections of headroom.',
        solution: `pub struct Sizing {
    pub rps: f64,
    pub db_ms: f64,
    pub instances: u32,
    pub server_max: u32,
}

impl Sizing {
    pub fn concurrent(&self) -> f64 {
        self.rps * self.db_ms / 1000.0
    }

    pub fn pool_per_instance(&self, safety: f64) -> u32 {
        (self.concurrent() / self.instances as f64 * safety).ceil().max(2.0) as u32
    }

    pub fn total(&self, pool: u32) -> u32 {
        pool * self.instances
    }

    pub fn headroom(&self, pool: u32) -> i64 {
        self.server_max as i64 - self.total(pool) as i64
    }
}

fn main() {
    // Today: 12 * 30 = 360 against 200. The database is already the bottleneck,
    // and every new autoscaled instance makes it worse.
    assert_eq!(12 * 30, 360);

    let s = Sizing { rps: 3000.0, db_ms: 8.0, instances: 12, server_max: 200 };
    assert!((s.concurrent() - 24.0).abs() < f64::EPSILON);
    assert_eq!(s.pool_per_instance(1.5), 3); // 24 / 12 = 2, * 1.5 = 3
    assert_eq!(s.total(3), 36);
    assert!(s.headroom(3) >= 100);

    // With the new sizing, adding instances stays safe until ~63 replicas.
    assert_eq!(s.server_max / 3, 66);
}`,
      },
      questions: [
        {
          q: 'What does Little law say about pool sizing?',
          options: [
            'Pool size should equal request rate',
            'Concurrent database work equals arrival rate times time spent in the database',
            'Pool size should be twice the CPU count',
            'Pool size should equal the number of tables',
          ],
          answer: 1,
          explain:
            'Concurrency, not throughput, is what a pool must cover. Rate times latency gives the number of simultaneous users of a connection.',
        },
        {
          q: 'Why does transaction-mode PgBouncer break named prepared statements?',
          options: [
            'It encrypts statements',
            'A server connection is only attached for one transaction, so a statement prepared earlier may not exist on the next connection',
            'It disallows parameter binding',
            'It rewrites SQL',
          ],
          answer: 1,
          explain:
            'Prepared statements live on a specific server connection. Transaction pooling does not preserve that affinity, so drivers that cache statements by name hit missing-statement errors.',
        },
        {
          q: 'Why is an unbounded acquire wait worse than a fast failure?',
          options: [
            'It uses more CPU',
            'Requests queue until client deadlines expire, so the service looks hung and every caller times out instead of shedding load',
            'It corrupts connections',
            'It prevents the pool from closing',
          ],
          answer: 1,
          explain:
            'A queue with no timeout converts overload into latency and then into cascading timeouts. A short acquire timeout turns it into a retryable error the caller can handle.',
        },
      ],
      quickbytes: [
        'Set acquire_timeout below the caller deadline so overload fails fast instead of hanging.',
        'Multiply pool size by autoscaled replicas before comparing with max_connections.',
        'Set max_lifetime below the failover window so the pool does not hold connections to a demoted primary.',
        'In transaction-mode pooling, disable named prepared statements or use session mode.',
      ],
      production: [
        'Alert on pool acquisition wait time and on acquire timeouts; both precede user-visible errors.',
        'Keep total connections under 80 percent of max_connections, with explicit headroom for operators and replication.',
        'Recycle connections with max_lifetime so DNS changes and failovers are picked up without a restart.',
        'Load-test at the autoscaler maximum, not at the current replica count.',
      ],
      crates: ['sqlx', 'tokio'],
      github: [{ name: 'launchbadge/sqlx', url: 'https://github.com/launchbadge/sqlx' }],
      pitfall:
        'Sizing the pool per instance and forgetting the autoscaler. A 30-connection pool is fine on 4 replicas and takes the database down at 40, which is exactly when traffic is highest.',
      resources: [
        { title: 'sqlx: Pool and PgPoolOptions', url: 'https://docs.rs/sqlx/latest/sqlx/', kind: 'docs' },
        { title: 'launchbadge/sqlx repository', url: 'https://github.com/launchbadge/sqlx', kind: 'repo' },
        { title: 'tokio: timeouts and async runtime', url: 'https://docs.rs/tokio/latest/tokio/', kind: 'docs' },
      ],
    },
    {
      id: 'c16',
      n: 16,
      title: 'Schema migrations that do not lock the table',
      minutes: 75,
      level: 'industry',
      goal: 'Run schema changes while old and new application versions are both live, using expand-contract, NOT VALID constraints and CREATE INDEX CONCURRENTLY.',
      sections: [
        {
          h: 'Every migration runs during a rolling deploy',
          p: [
            'A migration is not applied to a stopped system. During a rolling deploy, version N and version N+1 of the application run at the same time, and both must work against the schema at every intermediate step. That constraint, not the SQL dialect, is what makes production migrations hard.',
            'Expand-contract is the discipline that satisfies it. First expand: add the new column, table or index without removing anything, and deploy code that writes both shapes. Then migrate data in the background. Then switch reads. Only after the old shape is provably unused do you contract, dropping it in a later deploy. Each step is independently reversible.',
          ],
          list: [
            'Expand: additive DDL only, safe for both versions of the code.',
            'Migrate: backfill in bounded batches, with the dual-write path keeping new rows correct.',
            'Contract: drop the old column or table in a separate deploy, after confirming no reader uses it.',
          ],
        },
        {
          h: 'The lock each ALTER TABLE actually takes',
          p: [
            'Adding a column with a constant default is metadata-only since PostgreSQL 11; before that it rewrote the table. Adding a column with a volatile default still rewrites. Changing a column type rewrites unless the conversion is binary-coercible, such as varchar to text. Setting NOT NULL scans the table unless a validated CHECK constraint proves it.',
            'The dangerous operations are the ones that take ACCESS EXCLUSIVE and then wait: an ALTER TABLE that queues behind a long query blocks every subsequent query on that table, including the SELECTs that would have finished. Set lock_timeout before DDL so a migration fails fast instead of building a queue.',
          ],
          code: `-- Safe: metadata-only, no rewrite, brief ACCESS EXCLUSIVE.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD';

-- Safe: enforce the constraint without a long exclusive scan.
ALTER TABLE orders
    ADD CONSTRAINT orders_total_positive CHECK (total_cents > 0) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_total_positive; -- SHARE UPDATE EXCLUSIVE

-- Safe: build the index without blocking writes. Cannot run inside a
-- transaction block, so the migration tool must support non-transactional steps.
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_customer_created_idx
    ON orders (customer_id, created_at DESC);

-- Never do this on a large table in a rolling deploy:
ALTER TABLE orders ALTER COLUMN status TYPE varchar(32); -- rewrites the table
ALTER TABLE orders ALTER COLUMN total_cents SET NOT NULL; -- full scan, EXCLUSIVE

-- Always bound the wait before DDL:
SET lock_timeout = '3s';
SET statement_timeout = '30s';`,
          tip: 'A CREATE INDEX CONCURRENTLY that fails leaves an invalid index behind. Check pg_index.indisvalid and drop it before retrying, or the next attempt fails too.',
        },
        {
          h: 'Tooling: embedded, versioned, checksummed',
          p: [
            'A migration tool has three jobs: order the files deterministically, record which ones ran, and detect that an already-applied file changed. sqlx embeds the directory at compile time with the migrate! macro and verifies checksums against the _sqlx_migrations table; refinery does the same for V1__name.sql files and works with rusqlite, postgres and mysql.',
            'Whichever you use, keep migrations in the repository next to the code, run them as a separate step from application startup in production, and make the runner take an advisory lock so two instances cannot migrate concurrently. Startup migrations are convenient in development and a race in production.',
          ],
          code: `use sqlx::migrate::Migrator;
use std::time::Duration;

/// Embedded at compile time; checksums are verified against the database.
static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

pub async fn migrate(pool: &sqlx::PgPool) -> Result<(), Box<dyn std::error::Error>> {
    // One migrator at a time, even if every replica starts together.
    let mut lock = pool.acquire().await?;
    sqlx::query("SELECT pg_advisory_lock(727_001)")
        .execute(&mut *lock)
        .await?;

    let result = MIGRATOR.run(pool).await;

    let _ = sqlx::query("SELECT pg_advisory_unlock(727_001)")
        .execute(&mut *lock)
        .await;
    result?;
    Ok(())
}

// refinery, for a rusqlite or non-sqlx stack:
//   mod embedded {
//       use refinery::embed_migrations;
//       embed_migrations!("./migrations");
//   }
//   let mut conn = rusqlite::Connection::open("app.db")?;
//   embedded::migrations::runner().run(&mut conn)?;
pub const MIGRATION_TIMEOUT: Duration = Duration::from_secs(30);`,
          tip: 'Run migrations as a Kubernetes Job or a deploy step, not in main(). Ten replicas starting at once is a race the advisory lock only partly fixes.',
        },
      ],
      exercise: {
        prompt:
          'Rename users.name to users.full_name on a table with 50 million rows and continuous traffic, in four deploys, with no statement taking ACCESS EXCLUSIVE for longer than a few milliseconds.',
        starter: `-- Deploy 1: expand
-- Deploy 2: backfill
-- Deploy 3: switch reads
-- Deploy 4: contract
-- TODO: write the DDL and the application changes for each step.`,
        hint: 'Never rename. Add full_name, dual-write, backfill in batches, switch reads, then drop name in a later deploy. The old column must stay until no running code reads it.',
        solution: `-- Deploy 1 (expand): additive only, old code unaffected.
ALTER TABLE users ADD COLUMN full_name text;
CREATE INDEX CONCURRENTLY users_full_name_idx ON users (full_name);

-- Application: write both columns; read name.

-- Deploy 2 (backfill): bounded batches, no long transaction.
DO $$
DECLARE last_id bigint := 0;
BEGIN
  LOOP
    UPDATE users
       SET full_name = name
     WHERE id IN (SELECT id FROM users WHERE id > last_id
                  ORDER BY id LIMIT 5000)
       AND full_name IS NULL;
    SELECT max(id) INTO last_id FROM (
      SELECT id FROM users WHERE id > last_id ORDER BY id LIMIT 5000
    ) t;
    EXIT WHEN last_id IS NULL;
    COMMIT;
  END LOOP;
END $$;

-- Deploy 3 (switch reads): application reads full_name, still writes both.
-- Verify: SELECT count(*) FROM users WHERE full_name IS DISTINCT FROM name;

-- Deploy 4 (contract): only after the previous version is fully drained.
ALTER TABLE users ALTER COLUMN full_name SET NOT NULL; -- fast: validated below
ALTER TABLE users DROP COLUMN name;

-- Note on the NOT NULL: if the table is large, add a NOT VALID CHECK first,
-- validate it, then SET NOT NULL, which can use the validated constraint
-- instead of scanning under ACCESS EXCLUSIVE.`,
      },
      questions: [
        {
          q: 'Why must a migration be compatible with both the old and the new application version?',
          options: [
            'Because migrations run twice',
            'Because during a rolling deploy both versions serve traffic against the same schema',
            'Because the database caches old queries',
            'Because rollbacks are forbidden',
          ],
          answer: 1,
          explain:
            'There is no instant where only one version runs. Every intermediate schema must satisfy both, which is exactly what expand-contract buys.',
        },
        {
          q: 'What does CREATE INDEX CONCURRENTLY require that a normal CREATE INDEX does not?',
          options: [
            'A superuser role',
            'It cannot run inside a transaction block, so the migration runner needs non-transactional steps',
            'The table must be empty',
            'It requires a lock on every row',
          ],
          answer: 1,
          explain:
            'Concurrent builds take multiple short locks and need to wait between phases; a surrounding transaction would hold locks for the whole build.',
        },
        {
          q: 'Why is a plain ALTER TABLE ... ADD COLUMN ... DEFAULT dangerous on PostgreSQL 10 and earlier?',
          options: [
            'It was not allowed',
            'It rewrote every row, holding ACCESS EXCLUSIVE for the duration of a full table rewrite',
            'It dropped indexes',
            'It required a restart',
          ],
          answer: 1,
          explain:
            'Before PostgreSQL 11, a non-null default forced a rewrite. Since 11 the default is stored in the catalog and the rewrite is skipped.',
        },
      ],
      quickbytes: [
        'Set lock_timeout before any DDL; a queued ACCESS EXCLUSIVE blocks every query behind it.',
        'Add constraints as NOT VALID, then VALIDATE; the validation takes a much weaker lock.',
        'Never rename a column in place; add, dual-write, backfill, switch, then drop in a later deploy.',
        'Take a pg_advisory_lock in the migration runner so concurrent replicas cannot race.',
      ],
      production: [
        'Migrations run as a separate deploy step with a lock timeout, never from application startup.',
        'Every migration has a tested rollback or a documented forward-fix, and destructive steps are split into their own deploy.',
        'CI runs migrations against a production-sized schema copy and fails on any statement expected to rewrite a large table.',
        'Alert on long-running transactions before a migration window; they are what turns a metadata change into an outage.',
      ],
      crates: ['sqlx', 'refinery', 'rusqlite'],
      github: [
        { name: 'rust-db/refinery', url: 'https://github.com/rust-db/refinery' },
        { name: 'launchbadge/sqlx', url: 'https://github.com/launchbadge/sqlx' },
      ],
      pitfall:
        'Running migrations from main() on every replica start. Ten instances race on the same migration table, and the loser either crashes or applies a partially visible schema change.',
      resources: [
        { title: 'refinery: SQL migration toolkit for Rust', url: 'https://docs.rs/refinery/latest/refinery/', kind: 'docs' },
        { title: 'rust-db/refinery repository', url: 'https://github.com/rust-db/refinery', kind: 'repo' },
        { title: 'sqlx: migrate! macro and Migrator', url: 'https://docs.rs/sqlx/latest/sqlx/', kind: 'docs' },
      ],
    },
    {
      id: 'c17',
      n: 17,
      title: 'Transactions at scale: idempotency and retries',
      minutes: 90,
      level: 'industry',
      goal: 'Keep transactions short enough to survive contention, make writes idempotent with a unique key, and retry safely across failovers without duplicating effects.',
      sections: [
        {
          h: 'Short transactions are a capacity decision',
          p: [
            'A transaction holds locks, pins the xmin horizon and occupies a connection for its whole duration. A 200 ms transaction at 500 requests per second needs 100 concurrent connections just to keep up; a 5 ms transaction needs 3. Latency inside a transaction multiplies into connection count, lock contention and vacuum pressure.',
            'So the rule is not stylistic. Never wait for a user, a network call or a queue inside a transaction. Do the read, decide in application code, then write in a short transaction that re-checks the invariant it depends on. Batch jobs should commit every few thousand rows rather than wrapping the whole job in one transaction.',
          ],
          code: `-- Bad: one transaction for a million rows. Locks, WAL and bloat all at once.
BEGIN;
DELETE FROM events WHERE created_at < now() - interval '90 days';
COMMIT;

-- Better: bounded batches, each its own transaction, pausable.
DO $$
DECLARE deleted int;
BEGIN
  LOOP
    DELETE FROM events
    WHERE ctid IN (
      SELECT ctid FROM events
      WHERE created_at < now() - interval '90 days'
      LIMIT 5000
    );
    GET DIAGNOSTICS deleted = ROW_COUNT;
    EXIT WHEN deleted = 0;
    COMMIT;
    PERFORM pg_sleep(0.05); -- let autovacuum and replicas keep up
  END LOOP;
END $$;`,
          tip: 'Deleting a large fraction of a table leaves dead tuples that vacuum must clean. TRUNCATE or partition dropping is cheaper when the whole partition is obsolete.',
        },
        {
          h: 'Idempotency keys make retries safe',
          p: [
            'Every retry mechanism - client retry, load balancer retry, failover - can deliver the same request twice. The only durable fix is to make the write itself idempotent: store a client-supplied key with a unique constraint, and let the second attempt collide instead of duplicating the effect.',
            'The insert must also tell you which case happened. INSERT ... ON CONFLICT DO NOTHING RETURNING returns zero rows on a replay, which lets the handler return the original result instead of pretending to do the work again. If the original response must be returned byte for byte, store it next to the key.',
          ],
          code: `use sqlx::PgPool;
use uuid::Uuid;

pub struct Payment {
    pub idempotency_key: Uuid,
    pub account_id: i64,
    pub amount_cents: i64,
}

pub enum Outcome {
    Created(i64),
    Replayed(i64),
}

pub async fn charge(pool: &PgPool, p: &Payment) -> Result<Outcome, sqlx::Error> {
    let mut tx = pool.begin().await?;

    // The unique index on idempotency_key is the whole mechanism.
    let inserted: Option<(i64,)> = sqlx::query_as(
        "INSERT INTO payments (idempotency_key, account_id, amount_cents)
         VALUES ($1, $2, $3)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id",
    )
    .bind(p.idempotency_key)
    .bind(p.account_id)
    .bind(p.amount_cents)
    .fetch_optional(&mut *tx)
    .await?;

    let outcome = match inserted {
        Some((id,)) => Outcome::Created(id),
        None => {
            // Replay: return the original row, do not charge again.
            let (id,): (i64,) = sqlx::query_as(
                "SELECT id FROM payments WHERE idempotency_key = $1",
            )
            .bind(p.idempotency_key)
            .fetch_one(&mut *tx)
            .await?;
            Outcome::Replayed(id)
        }
    };

    tx.commit().await?;
    Ok(outcome)
}`,
          tip: 'Generate the idempotency key on the client, not in the service. A key generated after the retry is a new key, and the duplicate goes through.',
        },
        {
          h: 'When one transaction cannot cover it',
          p: [
            'A transaction cannot span two services or two shards without two-phase commit, which couples their availability. The alternative is a saga: a sequence of local transactions, each with a compensating action, plus a durable record of where the saga is. The outbox pattern is the usual foundation, because it writes the state change and the event in one local transaction.',
            'Sagas give at-least-once delivery, so every step and every consumer must be idempotent. That is not a detail to add later; it is the property that makes the whole design correct under retries. A compensation that runs twice must be as harmless as a charge that runs twice.',
          ],
          code: `-- State change and event in one local transaction: no dual-write problem.
BEGIN;
UPDATE orders SET status = 'reserved' WHERE id = $1 AND status = 'pending';
INSERT INTO outbox (id, aggregate_id, event_type, payload)
VALUES (gen_random_uuid(), $1, 'order.reserved', $2);
COMMIT;

-- A relay publishes outbox rows and marks them sent. It may publish twice;
-- consumers dedupe on (consumer, event_id) with a unique constraint.
UPDATE outbox
SET published_at = now()
WHERE id = ANY($1)
  AND published_at IS NULL;`,
          tip: 'The relay must mark rows published only after the broker acknowledges. Marking first and publishing later turns a crash into a lost event.',
        },
      ],
      exercise: {
        prompt:
          'Write an idempotent endpoint that creates an order and returns the same response body on replay. Include the table, the unique constraint, the insert with ON CONFLICT, and the retry policy for a failover.',
        starter: `-- TODO: schema with a client-supplied idempotency key
-- TODO: INSERT ... ON CONFLICT ... RETURNING
-- TODO: decide what to return on replay`,
        hint: 'Store the serialized response next to the key so a replay returns exactly the original body. Retry on 40001 and connection errors with jitter; never on a unique violation.',
        solution: `CREATE TABLE orders (
    id              bigserial PRIMARY KEY,
    idempotency_key uuid NOT NULL UNIQUE,
    account_id      bigint NOT NULL,
    total_cents     bigint NOT NULL CHECK (total_cents > 0),
    response_body   jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- First attempt inserts and returns the stored body.
-- A replay conflicts, returns zero rows, and we read the stored body.
WITH ins AS (
    INSERT INTO orders (idempotency_key, account_id, total_cents, response_body)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id, response_body
)
SELECT id, response_body, false AS replayed FROM ins
UNION ALL
SELECT id, response_body, true
FROM orders
WHERE idempotency_key = $1
  AND NOT EXISTS (SELECT 1 FROM ins);

-- Retry policy: the insert is safe to repeat, so retry on transient errors.
--   40001 serialization failure  -> retry with jitter
--   40P01 deadlock detected      -> retry with jitter
--   connection reset / failover  -> retry with jitter
--   23505 unique_violation       -> do NOT retry; it is the replay path
-- Cap attempts and surface the last error with the key for correlation.`,
      },
      questions: [
        {
          q: 'Why does a longer transaction reduce capacity even when it does no extra work?',
          options: [
            'It uses more CPU per row',
            'It holds a connection and locks for its whole duration, so concurrency equals arrival rate times duration',
            'It disables the query cache',
            'It forces a checkpoint',
          ],
          answer: 1,
          explain:
            'Concurrency is rate times latency. A transaction that lasts 200 ms instead of 5 ms needs 40 times as many concurrent connections and lock holders.',
        },
        {
          q: 'What makes ON CONFLICT DO NOTHING RETURNING useful for idempotency?',
          options: [
            'It returns the conflicting row automatically',
            'It returns zero rows on a replay, so the handler can distinguish a new write from a duplicate',
            'It retries the insert',
            'It locks the row for the transaction',
          ],
          answer: 1,
          explain:
            'Zero rows returned means the unique key already existed. You then read the original row and return it instead of applying the effect twice.',
        },
        {
          q: 'In the outbox pattern, when should a relay mark a row as published?',
          options: [
            'Before publishing, to avoid duplicates',
            'After the broker acknowledges, accepting that a crash may publish twice',
            'At the end of the day in a batch',
            'Never; consumers poll the outbox directly',
          ],
          answer: 1,
          explain:
            'Marking first loses events on a crash between mark and publish. Marking after gives at-least-once, which is why consumers must be idempotent.',
        },
      ],
      quickbytes: [
        'Never hold a transaction open across a network call or user think time.',
        'Generate idempotency keys on the client; a key created after a retry is a new request.',
        'Retry 40001, 40P01 and connection errors with jitter; never retry 23505.',
        'Batch large deletes and commits every few thousand rows so vacuum and replicas keep up.',
      ],
      production: [
        'Every write endpoint that can be retried has an idempotency key with a unique constraint.',
        'Alert on transactions open longer than a few seconds; they are the leading indicator of lock and vacuum problems.',
        'Cap retry attempts and record the attempt count in logs so a retry storm is visible.',
        'Make compensations idempotent before shipping the saga, not after the first double refund.',
      ],
      crates: ['sqlx', 'tokio', 'uuid'],
      github: [{ name: 'launchbadge/sqlx', url: 'https://github.com/launchbadge/sqlx' }],
      pitfall:
        'Retrying a write after a timeout without an idempotency key. The first attempt may have committed; the retry then charges the customer twice and no layer above can tell.',
      resources: [
        {
          title: 'PostgreSQL: Explicit Locking (chapter 13.3)',
          url: 'https://www.postgresql.org/docs/current/explicit-locking.html',
          kind: 'docs',
        },
        {
          title: 'PostgreSQL: INSERT and the ON CONFLICT clause',
          url: 'https://www.postgresql.org/docs/current/sql-insert.html',
          kind: 'docs',
        },
        { title: 'launchbadge/sqlx repository', url: 'https://github.com/launchbadge/sqlx', kind: 'repo' },
      ],
    },
    {
      id: 'c18',
      n: 18,
      title: 'Vacuum, bloat, and the wraparound countdown',
      minutes: 75,
      level: 'industry',
      goal: 'Read the autovacuum threshold formula, find what is holding the xmin horizon back, and keep transaction id age far away from the wraparound shutdown.',
      sections: [
        {
          h: 'Dead tuples and who is allowed to remove them',
          p: [
            'An UPDATE writes a new row version and marks the old one dead; a DELETE marks a version dead without removing its bytes. Neither can be reclaimed while any live snapshot might still see it. VACUUM removes versions below the xmin horizon, which is the oldest transaction id still visible to someone.',
            'That horizon is set by the oldest thing that might still need the data: an open transaction, an idle-in-transaction session, a prepared transaction, or a replication slot. This is why bloat is almost always an operational question rather than a tuning one, and why the first diagnostic is not VACUUM but who is holding the horizon.',
          ],
          code: `-- The horizon holders, in priority order.
SELECT pid, state, xact_start, backend_xmin,
       now() - xact_start AS open_for
FROM pg_stat_activity
WHERE backend_xmin IS NOT NULL
ORDER BY age(backend_xmin) DESC;

-- Prepared transactions left behind by a crashed coordinator.
SELECT gid, prepared, age(transaction) FROM pg_prepared_xacts;

-- Replication slots pinning old rows even with no consumer attached.
SELECT slot_name, active, age(xmin) AS xmin_age,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
FROM pg_replication_slots
WHERE xmin IS NOT NULL;

-- Table-level view: dead tuples and when autovacuum last ran.
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 10;`,
          tip: 'A replication slot with active = false and an old xmin will hold back cleanup forever. It is the most common cause of a table that grows without bound.',
        },
        {
          h: 'The autovacuum threshold, in the manual formula',
          p: [
            'Autovacuum does not vacuum on a timer. It compares the number of obsolete tuples with a threshold computed as the base threshold plus a scale factor times reltuples, capped by a maximum. With the defaults of 50 tuples and 0.2, a 10-million-row table needs about 2,000,050 dead tuples before autovacuum reacts, which on a fast-updating table can be hours of bloat.',
            'The fix is per-table storage parameters, not a global change. A hot, small table wants a much lower scale factor and a shorter naptime; a huge append-only table wants the opposite so autovacuum does not scan it constantly. Setting autovacuum_vacuum_scale_factor per table is a supported, targeted knob.',
          ],
          code: `-- See the effective thresholds for a table.
SELECT relname, reltuples::bigint,
       current_setting('autovacuum_vacuum_threshold')::int
         + current_setting('autovacuum_vacuum_scale_factor')::float * reltuples
         AS vacuum_threshold
FROM pg_class
WHERE relname = 'orders';

-- Tune the hot table only: react after 1 percent dead, not 20 percent.
ALTER TABLE orders SET (
    autovacuum_vacuum_scale_factor = 0.01,
    autovacuum_vacuum_threshold = 1000,
    autovacuum_analyze_scale_factor = 0.02
);

-- Expensive but sometimes necessary after a massive delete:
VACUUM (VERBOSE, ANALYZE) orders;
-- VACUUM FULL rewrites the table under ACCESS EXCLUSIVE: last resort, needs
-- free disk equal to the table size, and blocks all reads and writes.`,
          tip: 'VACUUM FULL is not "better vacuum". It rewrites the table and takes an ACCESS EXCLUSIVE lock; on a large table in production it is an outage you scheduled.',
        },
        {
          h: 'Wraparound is a countdown, not a warning',
          p: [
            'Transaction ids are 32 bits and compared modulo 2^31. A row version more than two billion transactions old appears to be in the future and becomes invisible. PostgreSQL prevents this by freezing old rows, and it refuses to assign new ids when fewer than about three million remain, which turns the database read-only.',
            'The age columns make this measurable long before it is urgent. Warnings start at forty million transactions from the limit, and the age of relfrozenxid tells you how far the oldest unfrozen row is. A database that has not been vacuumed in a long time shows up here first, and the fix is a database-wide VACUUM run by a superuser.',
          ],
          code: `-- How close is each table to the wraparound limit?
SELECT c.oid::regclass AS table_name,
       age(c.relfrozenxid) AS xid_age,
       2_000_000_000 - age(c.relfrozenxid) AS xids_remaining
FROM pg_class c
WHERE c.relkind IN ('r', 'm')
ORDER BY age(c.relfrozenxid) DESC
LIMIT 10;

-- Per database, the floor across all tables.
SELECT datname, age(datfrozenxid) AS db_age FROM pg_database ORDER BY 2 DESC;

-- Autovacuum forced for wraparound shows up with this query name.
SELECT pid, query, now() - xact_start AS running_for
FROM pg_stat_activity
WHERE query LIKE '%to prevent wraparound%';`,
          tip: 'The wraparound autovacuum cannot be interrupted by conflicting locks. If one is running for hours, it is doing a full scan because freezing was deferred too long.',
        },
      ],
      exercise: {
        prompt:
          'Write a monitoring query that returns one row per table with dead-tuple percentage, xid age, and the number of days since the last autovacuum, then define the three alert thresholds you would page on.',
        starter: `SELECT relname,
       -- TODO: dead tuple percentage
       -- TODO: xid age
       -- TODO: days since last autovacuum
FROM pg_stat_user_tables
JOIN pg_class ON pg_class.relname = pg_stat_user_tables.relname;`,
        hint: 'Dead percentage needs greatest(n_live_tup + n_dead_tup, 1) to avoid division by zero on an empty table. Xid age comes from age(relfrozenxid); the interval from last_autovacuum.',
        solution: `SELECT s.relname,
       s.n_live_tup,
       s.n_dead_tup,
       round(100.0 * s.n_dead_tup
             / greatest(s.n_live_tup + s.n_dead_tup, 1), 1) AS dead_pct,
       age(c.relfrozenxid) AS xid_age,
       extract(day FROM now() - s.last_autovacuum)::int AS days_since_autovacuum
FROM pg_stat_user_tables s
JOIN pg_class c ON c.oid = s.relid
ORDER BY s.n_dead_tup DESC;

-- Page on:
--   1. dead_pct > 30 on a table with more than 100k rows, for over an hour.
--      Bloat is already costing scans and index lookups.
--   2. xid_age > 1_500_000_000 (75 percent of the 2 billion limit).
--      Wraparound is a read-only database, not a slow query.
--   3. days_since_autovacuum is null and the table has churn, or greater
--      than 7 with dead tuples rising. Autovacuum is being blocked, not idle.

-- Follow-up when an alert fires: find the horizon holder before tuning.
SELECT pid, state, now() - xact_start AS open_for, backend_xmin
FROM pg_stat_activity
WHERE backend_xmin IS NOT NULL
ORDER BY age(backend_xmin) DESC
LIMIT 5;`,
      },
      questions: [
        {
          q: 'What sets the xmin horizon that VACUUM cannot cross?',
          options: [
            'The table size',
            'The oldest transaction id that any live snapshot, prepared transaction or replication slot might still need',
            'The number of indexes on the table',
            'The autovacuum naptime',
          ],
          answer: 1,
          explain:
            'Cleanup cannot remove a version that some live snapshot could still see. Long transactions, idle-in-transaction sessions and stale slots all hold that horizon back.',
        },
        {
          q: 'With defaults of 50 and 0.2, roughly how many dead tuples does a 10-million-row table need before autovacuum reacts?',
          options: ['50', '20,000', 'about 2 million', '10 million'],
          answer: 2,
          explain:
            'The threshold is 50 + 0.2 * 10,000,000 = 2,000,050. On a fast-updating table that is a lot of bloat before autovacuum starts, which is why hot tables get a lower scale factor.',
        },
        {
          q: 'What happens when transaction id age approaches the wraparound limit?',
          options: [
            'Queries get slower but keep working',
            'PostgreSQL refuses to assign new transaction ids, so the database becomes read-only until a VACUUM fixes it',
            'The database restarts automatically',
            'Old rows are deleted automatically',
          ],
          answer: 1,
          explain:
            'At about three million remaining ids, PostgreSQL stops assigning new ones to avoid data loss. Only read-only transactions can start until the vacuum completes.',
        },
      ],
      quickbytes: [
        'Diagnose bloat by finding the xmin holder first; tuning autovacuum will not help while a slot pins the horizon.',
        'Set autovacuum_vacuum_scale_factor per hot table instead of changing the global default.',
        'VACUUM FULL takes ACCESS EXCLUSIVE and needs free space equal to the table; schedule it, never run it casually.',
        'Track age(relfrozenxid), not just dead tuples; the wraparound limit is what turns a warning into an outage.',
      ],
      production: [
        'Page on xid age above 75 percent of the limit; it is a read-only database if it is ever reached.',
        'Alert on inactive replication slots and on prepared transactions older than an hour.',
        'Set idle_in_transaction_session_timeout so a forgotten session cannot pin the horizon indefinitely.',
        'Review autovacuum settings for the ten busiest tables quarterly; the default scale factor is wrong for hot tables.',
      ],
      crates: ['sqlx', 'tokio'],
      github: [{ name: 'launchbadge/sqlx', url: 'https://github.com/launchbadge/sqlx' }],
      pitfall:
        'Disabling autovacuum on a busy table to avoid its I/O. Dead tuples accumulate, the visibility map goes stale, index-only scans degrade to heap fetches, and the eventual wraparound vacuum is far more disruptive than the one you turned off.',
      resources: [
        {
          title: 'PostgreSQL: Routine Vacuuming (chapter 24.1)',
          url: 'https://www.postgresql.org/docs/current/routine-vacuuming.html',
          kind: 'docs',
        },
        {
          title: 'PostgreSQL: Visibility Map (chapter 66.4)',
          url: 'https://www.postgresql.org/docs/current/storage-vm.html',
          kind: 'docs',
        },
        {
          title: 'PostgreSQL: Monitoring Database Activity (chapter 27)',
          url: 'https://www.postgresql.org/docs/current/monitoring-stats.html',
          kind: 'docs',
        },
      ],
    },
    {
      id: 'c19',
      n: 19,
      title: 'Durability: fsync, group commit, and lying disks',
      minutes: 75,
      level: 'industry',
      goal: 'State exactly what fsync and fdatasync guarantee, implement group commit so one fsync serves many transactions, and choose a synchronous_commit mode with a known failure model.',
      sections: [
        {
          h: 'What fsync actually promises',
          p: [
            'fsync flushes a file data and the metadata needed to retrieve it, and does not return until the device reports the data is on stable storage. fdatasync skips metadata that is not required for retrieval, which for an append to an existing file means it is usually enough and measurably cheaper. Neither one makes a newly created file durable: for that you must also fsync the parent directory, because the name itself lives in a directory entry.',
            'The page cache is the reason this matters. write() copies bytes into kernel memory and returns; the data is visible to every process and survives a process crash, but not a power loss. A database that acknowledges after write() has a durability bug that only appears on the failure it was supposed to survive.',
          ],
          code: `use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::io::AsRawFd;

/// Create a file and make both its contents and its name durable.
pub fn create_durably(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = OpenOptions::new().create_new(true).write(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?; // contents + inode metadata

    // The directory entry is metadata of the parent, not of the file.
    let dir = File::open(path.parent().unwrap())?;
    dir.sync_all()?;
    Ok(())
}

/// Append to an existing file: fdatasync is enough, and cheaper.
pub fn append_durably(file: &mut File, bytes: &[u8]) -> std::io::Result<()> {
    file.write_all(bytes)?;
    file.sync_data()?; // fdatasync
    Ok(())
}

/// O_DIRECT bypasses the page cache entirely; alignment requirements apply.
pub fn open_direct(path: &std::path::Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_DIRECT)
        .open(path)
}

// Raw fd available if you need sync_file_range or posix_fadvise:
pub fn raw(file: &File) -> i32 {
    file.as_raw_fd()
}`,
          tip: 'On Linux, a failed fsync may have already discarded the dirty pages. Retrying is not guaranteed to help, which is why PostgreSQL escalates repeated fsync failures to a panic rather than looping.',
        },
        {
          h: 'Group commit is the only real lever',
          p: [
            'An fsync costs between 0.1 ms on a good NVMe device and several milliseconds on a network volume. Doing one per transaction caps throughput at the reciprocal of that latency, no matter how many cores you have. Group commit batches several transactions into one write and one fsync, then acknowledges all of them: the cost per transaction drops by the batch size.',
            'The implementation is a queue plus a dedicated writer. Transactions enqueue their bytes with a channel to receive the result; the writer drains everything available, writes it as one buffer, fsyncs once, and then completes every waiter. The latency of a transaction in a batch is the fsync time, not the fsync time times the batch size, which is why batching helps throughput without hurting tail latency much.',
          ],
          code: `use std::io::Write;
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};

pub struct WalHandle {
    tx: SyncSender<Request>,
}

struct Request {
    bytes: Vec<u8>,
    ack: Sender<std::io::Result<()>>,
}

impl WalHandle {
    /// One OS thread owns the file; fsync is blocking, so never run it on an
    /// async executor thread. Callers may block on the ack from spawn_blocking.
    pub fn spawn(mut file: std::fs::File) -> Self {
        let (tx, rx) = mpsc::sync_channel::<Request>(1024);
        std::thread::spawn(move || Self::writer_loop(&mut file, rx));
        Self { tx }
    }

    fn writer_loop(file: &mut std::fs::File, rx: Receiver<Request>) {
        while let Ok(first) = rx.recv() {
            let mut batch = vec![first];
            // Drain whatever else is already queued: one fsync for all of it.
            while let Ok(next) = rx.try_recv() {
                batch.push(next);
                if batch.len() >= 512 {
                    break;
                }
            }

            let mut buf = Vec::with_capacity(batch.iter().map(|r| r.bytes.len()).sum());
            for req in &batch {
                buf.extend_from_slice(&req.bytes);
            }

            let result = file.write_all(&buf).and_then(|_| file.sync_data());
            // Acknowledge after the fsync, never before.
            for req in batch {
                let _ = req.ack.send(match &result {
                    Ok(()) => Ok(()),
                    Err(e) => Err(std::io::Error::new(e.kind(), e.to_string())),
                });
            }
        }
    }

    pub fn commit(&self, bytes: Vec<u8>) -> std::io::Result<()> {
        let (ack_tx, ack_rx) = mpsc::channel();
        self.tx
            .send(Request { bytes, ack: ack_tx })
            .map_err(|_| std::io::Error::other("wal writer stopped"))?;
        ack_rx.recv().map_err(|_| std::io::Error::other("wal writer dropped ack"))?
    }
}`,
          tip: 'Acknowledge only after the batch fsync returns. Acknowledging at enqueue time turns group commit into an unlogged write with extra steps.',
        },
        {
          h: 'Choosing what to lose',
          p: [
            'synchronous_commit has levels, and each one names a different failure it survives. on waits for the local WAL flush. remote_write waits until a standby has written the WAL to its own OS. remote_apply waits until a standby has applied it, so a read there sees the change. off returns before the local flush and can lose recent commits even with no replica involved.',
            'fsync = off is a different category of risk. It does not merely lose recent transactions; it can leave the data files inconsistent with the log, because the kernel may reorder writes it was told to make durable. Use it for a disposable test cluster and nowhere else, and be explicit about that in the config comment.',
          ],
          code: `-- Per-transaction override for a bulk load, then back to the default.
BEGIN;
SET LOCAL synchronous_commit = off;
COPY events FROM '/tmp/events.csv' WITH (FORMAT csv);
COMMIT;

-- Cluster default: zero loss on primary crash, no replication guarantee.
ALTER SYSTEM SET synchronous_commit = 'on';

-- Quorum: survive the loss of any one standby without stalling on a slow one.
ALTER SYSTEM SET synchronous_standby_names = 'ANY 1 (replica_a, replica_b)';
SELECT pg_reload_conf();

-- Inspect what is actually in effect.
SHOW synchronous_commit;
SHOW synchronous_standby_names;
SHOW fsync;`,
          tip: 'SET LOCAL inside a transaction reverts at commit, so a bulk-load override cannot leak into the next request on a pooled connection.',
        },
      ],
      exercise: {
        prompt:
          'Measure the cost of fsync on your machine: write 4 KiB, fsync, repeat 1,000 times, and compare with the same loop doing one fsync per 32 writes. Report transactions per second for both and explain the ratio.',
        starter: `use std::fs::OpenOptions;
use std::io::Write;

fn main() -> std::io::Result<()> {
    // TODO: loop 1000 times, fsync each write, measure elapsed
    // TODO: loop 1000 times in batches of 32, fsync once per batch
    // TODO: print ops/sec for both
    Ok(())
}`,
        hint: 'Expect a ratio close to the batch size if fsync dominates. Use std::time::Instant and a file on the real filesystem, not tmpfs, which makes fsync a no-op.',
        solution: `use std::fs::OpenOptions;
use std::io::Write;
use std::time::Instant;

const WRITES: usize = 1_000;
const BATCH: usize = 32;

fn per_write(path: &str) -> std::io::Result<f64> {
    let mut file = OpenOptions::new().create(true).write(true).truncate(true).open(path)?;
    let start = Instant::now();
    for _ in 0..WRITES {
        file.write_all(&[0u8; 4096])?;
        file.sync_data()?; // one fsync per transaction
    }
    Ok(WRITES as f64 / start.elapsed().as_secs_f64())
}

fn batched(path: &str) -> std::io::Result<f64> {
    let mut file = OpenOptions::new().create(true).write(true).truncate(true).open(path)?;
    let start = Instant::now();
    for i in 0..WRITES {
        file.write_all(&[0u8; 4096])?;
        if (i + 1) % BATCH == 0 {
            file.sync_data()?; // one fsync per batch of 32
        }
    }
    file.sync_data()?;
    Ok(WRITES as f64 / start.elapsed().as_secs_f64())
}

fn main() -> std::io::Result<()> {
    let per_write = per_write("/tmp/durability-single.dat")?;
    let batched = batched("/tmp/durability-batched.dat")?;
    println!("one fsync per write: {per_write:.0} ops/s");
    println!("batch of {BATCH}:      {batched:.0} ops/s");
    println!("ratio: {:.1}x", batched / per_write);
    // On a device with 0.5 ms fsync, the first loop tops out near 2000 ops/s
    // and the second near 64000. The ratio tracks the batch size until the
    // write path or the CPU becomes the limit.
    Ok(())
}`,
      },
      questions: [
        {
          q: 'You create a new file, write to it, and fsync the file. What is still missing for the name to be durable?',
          options: [
            'Nothing, fsync covers the directory entry',
            'An fsync of the parent directory, because the name lives in the directory entry',
            'A second fsync of the file',
            'A call to syncfs on a different mount',
          ],
          answer: 1,
          explain:
            'The file fsync makes the contents and inode durable. The directory entry that maps the name to the inode is metadata of the parent directory and needs its own fsync.',
        },
        {
          q: 'Why does group commit raise throughput without multiplying latency by the batch size?',
          options: [
            'Because fsync becomes asynchronous',
            'Because all transactions in the batch share one fsync, so each waits roughly one fsync rather than one per transaction',
            'Because writes are buffered in the page cache',
            'Because the batch is written to memory first',
          ],
          answer: 1,
          explain:
            'The batch pays a single device sync. Throughput scales with batch size while per-transaction latency stays near one fsync plus queueing.',
        },
        {
          q: 'What risk does fsync = off introduce beyond losing recent transactions?',
          options: [
            'None, it is equivalent to synchronous_commit = off',
            'The kernel may reorder writes, leaving data files inconsistent with the log, so recovery can produce a corrupt database',
            'It disables the WAL',
            'It forces a checkpoint on every commit',
          ],
          answer: 1,
          explain:
            'Losing a tail of transactions is recoverable. Reordering writes that were assumed durable can make the page and log disagree in ways recovery cannot repair.',
        },
      ],
      quickbytes: [
        'fsync the parent directory after creating a file, or the name can vanish on power loss.',
        'fdatasync is enough for appends to an existing file and is cheaper than fsync.',
        'Never run a blocking fsync on an async executor thread; use a dedicated thread or spawn_blocking.',
        'Use SET LOCAL synchronous_commit = off for bulk loads so the override cannot leak to the next request.',
      ],
      production: [
        'Know your device fsync latency; it sets the ceiling on single-row commit throughput more than any code change.',
        'Never run fsync = off outside a disposable environment; document it in the config if you do.',
        'Alert on WAL write and sync time percentiles, not just on query latency.',
        'Test with a real power cut or a forced instance stop, not only with a clean shutdown.',
      ],
      crates: ['tempfile', 'tokio', 'libc'],
      github: [{ name: 'Stebalien/tempfile', url: 'https://github.com/Stebalien/tempfile' }],
      pitfall:
        'Using tmpfs or an in-memory overlay for the data directory in staging. fsync becomes a no-op, the benchmark looks wonderful, and every durability assumption you validated there is untested.',
      resources: [
        { title: 'fsync(2) manual page', url: 'https://man7.org/linux/man-pages/man2/fsync.2.html', kind: 'docs' },
        { title: 'tempfile: durable temp files for crash tests', url: 'https://docs.rs/tempfile/latest/tempfile/', kind: 'docs' },
        { title: 'Stebalien/tempfile repository', url: 'https://github.com/Stebalien/tempfile', kind: 'repo' },
      ],
    },
    {
      id: 'c20',
      n: 20,
      title: 'Benchmarking databases honestly',
      minutes: 90,
      level: 'industry',
      goal: 'Measure latency distributions rather than averages, use criterion for engine-level benchmarks, and compare against SQLite or PostgreSQL with identical durability settings.',
      sections: [
        {
          h: 'Averages hide the failure you care about',
          p: [
            'A database benchmark that reports a mean latency tells you almost nothing about user experience. Tail latency is where SLOs live: p99 and p999 capture queueing, fsync stalls, compaction and checkpoint spikes. A mean of 2 ms with a p999 of 900 ms is a service that times out regularly while looking healthy on a dashboard.',
            'Coordinated omission makes this worse. A closed-loop benchmark that sends the next request only after the previous response finishes never records the latency of requests that would have been sent during a stall. Use a fixed request rate and measure from the intended send time, or report the latency distribution from an open-loop generator.',
          ],
          list: [
            'Report p50, p95, p99 and p999, plus the max, and the number of samples behind each.',
            'State whether the generator is open-loop (fixed rate) or closed-loop (fixed concurrency).',
            'Warm up before measuring: caches, JIT-less as Rust is, and connection pools all need it.',
          ],
        },
        {
          h: 'Criterion for engine-level measurements',
          p: [
            'Criterion runs each benchmark for a minimum time, takes many samples, and reports a confidence interval around the change between runs, which is exactly what you need to tell a real regression from noise. Set throughput so it reports elements per second, and keep the dataset larger than RAM if you are claiming anything about storage.',
            'One trap is state accumulating across iterations: an insert benchmark that keeps inserting into the same database measures a growing dataset, not a fixed one. Recreate the database per sample, or benchmark a fixed-size batch and subtract the setup cost explicitly.',
          ],
          code: `use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};
use std::hint::black_box;

const KV: TableDefinition<u64, &str> = TableDefinition::new("kv");
const BATCH: u64 = 10_000;

fn bench_insert(c: &mut Criterion) {
    let mut group = c.benchmark_group("kv_insert");
    group.throughput(Throughput::Elements(BATCH));
    group.sample_size(20); // each sample is expensive: fewer, longer samples
    let dir = tempfile::tempdir().unwrap();

    // redb: one write transaction per batch, default durability (fsync).
    let redb_path = dir.path().join("bench.redb");
    group.bench_function(BenchmarkId::new("redb", BATCH), |b| {
        b.iter_batched(
            || Database::create(&redb_path).unwrap(), // fresh db per sample
            |db| {
                let write = db.begin_write().unwrap();
                {
                    let mut table = write.open_table(KV).unwrap();
                    for i in 0..BATCH {
                        table.insert(black_box(i), "value").unwrap();
                    }
                }
                write.commit().unwrap();
                black_box(db);
            },
            criterion::BatchSize::PerIteration,
        )
    });

    // SQLite: WAL mode, synchronous=NORMAL, one transaction per batch.
    let sqlite_path = dir.path().join("bench.sqlite");
    group.bench_function(BenchmarkId::new("sqlite", BATCH), |b| {
        b.iter_batched(
            || {
                let conn = rusqlite::Connection::open(&sqlite_path).unwrap();
                conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE kv (k INTEGER PRIMARY KEY, v TEXT);").unwrap();
                conn
            },
            |conn| {
                let tx = conn.unchecked_transaction().unwrap();
                let mut stmt = tx.prepare("INSERT OR REPLACE INTO kv VALUES (?1, ?2)").unwrap();
                for i in 0..BATCH {
                    // rusqlite has no ToSql for u64: cast, do not wrap.
                    stmt.execute((black_box(i as i64), "value")).unwrap();
                }
                drop(stmt);
                tx.commit().unwrap();
            },
            criterion::BatchSize::PerIteration,
        )
    });
    group.finish();
}

criterion_group!(benches, bench_insert);
criterion_main!(benches);`,
          tip: 'criterion::black_box is deprecated in criterion 0.8; use std::hint::black_box. Both stop the optimizer from deleting the work, but only one is maintained.',
        },
        {
          h: 'Compare against a real database, with the settings printed',
          p: [
            'A comparison is only meaningful if both systems are configured for the same durability. SQLite with synchronous=OFF and a Rust engine calling fsync on every commit is not a comparison of engines; it is a comparison of two different promises. Record the PRAGMAs, the PostgreSQL settings, the filesystem, the device and the dataset size next to the numbers.',
            'Run the same workload shape on both: same key distribution, same read/write ratio, same value sizes. YCSB popularised this discipline with named workloads (A is 50/50 read/update, B is 95/5, C is read-only, D is read-latest, E is scan-heavy, F is read-modify-write). If you invent your own mix, publish the mix.',
          ],
          code: `# Reproducible comparison: pin the environment in the same file as the numbers.
uname -a
df -T /var/lib/postgresql
mount | grep -E ' / | /var '

psql -c "SHOW fsync; SHOW synchronous_commit; SHOW shared_buffers; SHOW work_mem;"
sqlite3 bench.db "PRAGMA journal_mode; PRAGMA synchronous; PRAGMA cache_size;"

# Dataset must exceed RAM for any claim about storage behaviour.
free -h
du -sh bench.db

# Same workload shape on both systems: 70/30 read/write, Zipfian keys.
# Run each three times and report the spread, not a single number.`,
          tip: 'If the dataset fits in the page cache, you are benchmarking memcpy. Say so explicitly, or the number will be quoted as a disk result.',
        },
      ],
      exercise: {
        prompt:
          'Write a benchmark that compares three key-value engines on a 70/30 read/write mix with Zipfian key distribution, reports p50/p99/p999, and asserts that all three used the same durability setting.',
        starter: `// TODO: generate a Zipfian key sequence
// TODO: run a fixed-rate load for N seconds against each engine
// TODO: record per-request latency and print percentiles
// TODO: assert durability settings match before reporting`,
        hint: 'Collect latencies in a Vec, sort, and index at 0.5, 0.99, 0.999. Use a fixed inter-arrival time to avoid coordinated omission; sleeping after the request would hide stalls.',
        solution: `use std::time::{Duration, Instant};

/// Zipf-ish distribution: a few hot keys take most of the traffic.
/// Real YCSB uses a proper Zipfian generator; this is the shape, not the law.
pub fn zipf_key(i: u64, n: u64, exponent: f64) -> u64 {
    let u = (i as f64 + 0.5) / n as f64;
    (u.powf(exponent) * n as f64) as u64 % n.max(1)
}

pub fn percentiles(mut samples: Vec<Duration>) -> (Duration, Duration, Duration, Duration) {
    samples.sort_unstable();
    let at = |q: f64| samples[((samples.len() as f64 * q) as usize).min(samples.len() - 1)];
    (at(0.50), at(0.99), at(0.999), *samples.last().unwrap())
}

pub struct Durability {
    pub fsync_on_commit: bool,
    pub sync_mode: &'static str,
}

/// Refuse to compare numbers collected under different promises.
pub fn assert_comparable(a: &Durability, b: &Durability) {
    assert_eq!(
        a.fsync_on_commit, b.fsync_on_commit,
        "one engine fsyncs per commit and the other does not: not a comparison"
    );
    assert_eq!(a.sync_mode, b.sync_mode, "different synchronous modes");
}

fn main() {
    // Fixed-rate driver: sleep until the next intended send time, not after
    // the response, so a stall shows up as latency instead of vanishing.
    let rate = Duration::from_micros(500); // 2000 ops/s
    let mut samples = Vec::new();
    let mut next = Instant::now();

    for i in 0..20_000u64 {
        next += rate;
        let key = zipf_key(i, 1_000_000, 1.2);
        let start = Instant::now();
        // engine.get_or_put(key) goes here
        std::hint::black_box(key);
        samples.push(start.elapsed());

        let now = Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        }
    }

    let (p50, p99, p999, max) = percentiles(samples);
    println!("p50={p50:?} p99={p99:?} p999={p999:?} max={max:?}");

    let redb = Durability { fsync_on_commit: true, sync_mode: "on" };
    let sqlite = Durability { fsync_on_commit: true, sync_mode: "FULL" };
    assert_comparable(&redb, &sqlite);
}`,
      },
      questions: [
        {
          q: 'What is coordinated omission in a benchmark?',
          options: [
            'Skipping the warmup phase',
            'A closed-loop generator never records the latency of requests that would have been sent during a stall, so tails look far better than reality',
            'Using too few keys',
            'Measuring only the median',
          ],
          answer: 1,
          explain:
            'If you wait for a response before sending the next request, a 900 ms stall hides the requests that would have queued behind it. Fixed-rate generation exposes them.',
        },
        {
          q: 'Why is comparing your engine to SQLite with synchronous=OFF unfair?',
          options: [
            'SQLite is always faster',
            'You are comparing different durability promises: one fsyncs per commit and the other does not',
            'SQLite uses a different file format',
            'OFF disables the WAL permanently',
          ],
          answer: 1,
          explain:
            'Throughput numbers only mean something relative to a guarantee. Publish the PRAGMAs and settings next to the result, or the comparison is marketing.',
        },
        {
          q: 'What does criterion throughput report, and why set it?',
          options: [
            'The number of CPU cycles per iteration',
            'Elements per second, so results are comparable across batch sizes rather than only across time per iteration',
            'The memory used by the benchmark',
            'The number of samples taken',
          ],
          answer: 1,
          explain:
            'Time per iteration changes meaning when you change the batch size. Throughput normalizes it, which matters when comparing a 1k batch to a 10k batch.',
        },
      ],
      quickbytes: [
        'Report p50, p99 and p999; a mean hides the stalls that break SLOs.',
        'Use a fixed-rate generator so stalls show up as latency instead of disappearing.',
        'Recreate the database per sample, or you are benchmarking a dataset that grows every iteration.',
        'Print fsync settings, PRAGMAs and dataset size next to the numbers; an unqualified benchmark is not evidence.',
      ],
      production: [
        'Benchmark on hardware and storage that match production; a laptop NVMe says nothing about network-attached storage.',
        'Keep a checked-in benchmark script so results are reproducible by the next engineer.',
        'Track p999 in production as well as in benchmarks; the benchmark is a hypothesis, the SLO is the test.',
        'Report the spread across at least three runs, not a single best-case number.',
      ],
      crates: ['criterion', 'redb', 'rusqlite', 'tempfile'],
      github: [
        { name: 'criterion-rs/criterion.rs', url: 'https://github.com/criterion-rs/criterion.rs' },
        { name: 'rusqlite/rusqlite', url: 'https://github.com/rusqlite/rusqlite' },
      ],
      pitfall:
        'Benchmarking a dataset that fits in the page cache and reporting it as storage performance. The numbers are real, but they measure memory bandwidth, and they will not survive the first production-sized table.',
      resources: [
        { title: 'criterion: statistics-driven benchmarking', url: 'https://docs.rs/criterion/latest/criterion/', kind: 'docs' },
        { title: 'criterion-rs/criterion.rs repository', url: 'https://github.com/criterion-rs/criterion.rs', kind: 'repo' },
        { title: 'rusqlite: SQLite bindings for the comparison baseline', url: 'https://docs.rs/rusqlite/latest/rusqlite/', kind: 'docs' },
      ],
    },
  ],
};
