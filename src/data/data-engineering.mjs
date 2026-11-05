/**
 * Data engineering track.
 *
 * API versions verified against docs.rs and crates.io on 2026-11-04:
 * arrow 60.1.0, parquet 60.1.0, polars 0.55.2, rdkafka 0.39.0,
 * object_store 0.14.2, async-nats 0.51.0, apache-avro 0.22.0,
 * iceberg 0.11.0, opentelemetry 0.33.1, cron 0.17.0, tokio 1.54.x.
 *
 * Plain JSON-compatible data consumed by build.mjs.
 */
export default {
  key: "data-engineering",
  prefix: "m",
  title: "Data engineering",
  blurb: "Batch and streaming pipelines, Arrow/Parquet, dataframes, CDC, orchestration and data quality.",
  level: "industry",
  project: {
    title: "Capstone: an incremental data pipeline",
    brief: "Build a CDC-driven pipeline that lands Parquet in a lake, transforms with Polars and publishes quality metrics.",
    deliverables: [
      "CDC ingestion with idempotent writes: a Debezium-style envelope applied to a keyed store, deduplicated on log position",
      "Parquet partitioning and compaction: date-partitioned writes, a manifest commit, and a bin-packing compaction job",
      "Polars transforms with tests: bronze to silver to gold as lazy plans, with predicate-pushdown assertions",
      "Quality checks and lineage: freshness, uniqueness and volume checks per run, plus OpenLineage start/complete/fail events",
      "A cost and observability report: bytes scanned, files per partition and per-run freshness exported as metrics"
    ],
    stack: ["arrow", "parquet", "polars", "rdkafka", "object_store", "tokio", "serde", "chrono"]
  },
  lessons: [
    {
      id: "m01",
      title: "Batch versus streaming: bounded and unbounded work",
      minutes: 60,
      level: "core",
      goal: "Choose batch or streaming per stage from the completion signal, then build a micro-batcher that bounds latency and memory together.",
      sections: [
        {
          h: "The difference is whether the input ends",
          p: [
            "A batch job knows when it is done: the input is a bounded set, so it may sort the whole thing, join against every row, and redo the run from scratch after a failure. A streaming job never sees the end. It can only reason about windows it believes are closed, which is why every streaming system needs a watermark plus an explicit policy for records that arrive after the watermark passed.",
            "This is not a product boundary. The same Rust process can read a bounded Parquet listing on Monday and an unbounded NATS subject on Tuesday. What changes is what the code may assume: batch may recompute, streaming must hold state and decide when a result is final. Choose per stage. A pipeline that needs a per-event fraud decision streams that rule and batches the reporting table behind it."
          ],
          list: [
            "Bounded input: the run has a start and an end, so a retry can rewrite the same output",
            "Unbounded input: no completion signal, so correctness depends on watermarks and late-data policy",
            "Micro-batching is the middle: bounded work over an unbounded source",
            "The freshness SLO decides the model, not the tooling - a 15-minute SLO rarely needs per-record streaming"
          ],
          tip: "If a stage tolerates ten minutes of delay, micro-batch it: far less state to operate than a streaming job with exactly-once semantics."
        },
        {
          h: "Micro-batches need two bounds, not one",
          p: [
            "Flushing every N rows alone means a quiet source holds rows in memory indefinitely. Flushing every T seconds alone means a burst can allocate without limit between ticks. Production batchers trip on whichever bound comes first, and they record why the flush happened so that a latency problem is distinguishable from a memory problem in the metrics.",
            "The real constraint is bounded memory, not the flush interval. Cap the channel, cap the batch, and let the flush do its durable work before the loop accepts more input. A slow sink plus an uncapped queue does not fail with a clean error; it grows until the OOM killer ends the process, losing whatever was buffered and leaving the offset commit nowhere near the data."
          ],
          code: `use std::time::Duration;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlushReason { Size, Time, Shutdown }

pub struct Batcher { pub max_rows: usize, pub max_wait: Duration }

impl Batcher {
    /// Flush on whichever bound trips first. The timer restarts after each
    /// flush, so max_wait measures time since the last write, not wall clock.
    pub async fn drain<F>(&self, rx: &mut mpsc::Receiver<Vec<u8>>, mut flush: F) -> Result<(), Box<dyn std::error::Error>>
    where F: FnMut(Vec<Vec<u8>>, FlushReason) -> Result<(), Box<dyn std::error::Error>> {
        let mut batch = Vec::with_capacity(self.max_rows);
        loop {
            let sleep = tokio::time::sleep(self.max_wait);
            tokio::pin!(sleep);
            let reason = loop {
                tokio::select! {
                    maybe = rx.recv() => match maybe {
                        Some(record) => {
                            batch.push(record);
                            if batch.len() >= self.max_rows { break FlushReason::Size; }
                        }
                        None => break FlushReason::Shutdown,
                    },
                    _ = &mut sleep => break FlushReason::Time,
                }
            };
            if !batch.is_empty() {
                flush(std::mem::take(&mut batch), reason)?;
            }
            if reason == FlushReason::Shutdown { return Ok(()); }
        }
    }
}`,
          tip: "Log a counter per flush reason. If size flushes dominate, the interval is too long for the arrival rate; if time flushes dominate, batches are tiny and per-batch overhead is your cost."
        },
        {
          h: "What streaming buys, and what it charges",
          p: [
            "Streaming shortens the delay between an event and its effect, and it can act per record: revoke a session, invalidate a cache entry, page someone. It charges state, watermarks, replay tooling and a harder test story, because most defects only appear when records arrive out of order, twice, or three hours late.",
            "Batch charges latency and full recomputation, but every run is reproducible: same input, same code, same output. When a number is disputed in a meeting, reproducibility is worth more than freshness. The durable pattern keeps raw events in a log, streams the low-latency path, and recomputes the authoritative table in batch from that same log."
          ],
          tip: "Build the recompute path first. If the streaming output cannot be rebuilt from stored input, a logic bug becomes an unfixable data incident."
        }
      ],
      exercise: {
        prompt: "Implement Batcher::drain so it flushes on max_rows, on max_wait since the last flush, or on channel close - and reports which bound fired so the caller can emit a metric.",
        starter: `use std::time::Duration;
use tokio::sync::mpsc;

pub enum FlushReason { Size, Time, Shutdown }

pub struct Batcher { pub max_rows: usize, pub max_wait: Duration }

impl Batcher {
    pub async fn drain<F>(&self, rx: &mut mpsc::Receiver<Vec<u8>>, mut flush: F)
        -> Result<(), Box<dyn std::error::Error>>
    where F: FnMut(Vec<Vec<u8>>, FlushReason) -> Result<(), Box<dyn std::error::Error>> {
        let mut batch = Vec::new();
        // 1. select over rx.recv() and a pinned sleep
        // 2. break with the reason that fired
        // 3. flush, restart the timer, stop on Shutdown
        todo!()
    }
}`,
        hint: "tokio::select! over rx.recv() and a pinned sleep. Create the sleep inside the outer loop so it measures time since the last flush. recv() is cancel-safe, so re-creating it each iteration loses nothing.",
        solution: `use std::time::Duration;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlushReason { Size, Time, Shutdown }

pub struct Batcher { pub max_rows: usize, pub max_wait: Duration }

impl Batcher {
    pub async fn drain<F>(&self, rx: &mut mpsc::Receiver<Vec<u8>>, mut flush: F)
        -> Result<(), Box<dyn std::error::Error>>
    where F: FnMut(Vec<Vec<u8>>, FlushReason) -> Result<(), Box<dyn std::error::Error>> {
        let mut batch: Vec<Vec<u8>> = Vec::with_capacity(self.max_rows);
        loop {
            let sleep = tokio::time::sleep(self.max_wait);
            tokio::pin!(sleep);
            let reason = loop {
                tokio::select! {
                    maybe = rx.recv() => match maybe {
                        Some(record) => {
                            batch.push(record);
                            if batch.len() >= self.max_rows { break FlushReason::Size; }
                        }
                        None => break FlushReason::Shutdown,
                    },
                    _ = &mut sleep => break FlushReason::Time,
                }
            };
            if !batch.is_empty() {
                flush(std::mem::take(&mut batch), reason)?;
            }
            if reason == FlushReason::Shutdown { return Ok(()); }
        }
    }
}`
      },
      questions: [
        {
          q: "What does a batch job have that a streaming job must reconstruct from the data itself?",
          options: [
            "A completion signal for the input",
            "A schema",
            "A partition key",
            "A checkpoint directory"
          ],
          answer: 0,
          explain: "Batch input is bounded, so the end of input is the completion signal. Streaming input never ends, so the job must infer closure with watermarks and decide explicitly what to do with records that arrive after the watermark."
        },
        {
          q: "A micro-batcher flushes only when 10,000 rows accumulate. What happens on a source that produces 50 rows a minute?",
          options: [
            "Rows are flushed every second regardless",
            "Rows sit in memory and downstream freshness stalls indefinitely",
            "The channel applies backpressure and the producer slows to 10,000 per minute",
            "Tokio closes the channel after a timeout"
          ],
          answer: 1,
          explain: "With only a size bound there is no timer to force a flush, so a low-volume source leaves data buffered and the sink sees nothing. That is why production batchers trip on size or elapsed time, whichever comes first."
        },
        {
          q: "Why should the flush complete before the loop accepts more input?",
          options: [
            "Because tokio::select! cannot run two futures concurrently",
            "Because the channel would reorder records",
            "Because an accepted record that cannot be flushed is unbounded growth that ends in an OOM kill",
            "Because Rust forbids holding a Vec across an await"
          ],
          answer: 2,
          explain: "Backpressure is the only thing bounding memory. If a slow sink keeps accepting work, the buffer grows until the process dies, losing buffered records and leaving committed offsets ahead of the data actually written."
        }
      ],
      quickbytes: [
        "Batch = bounded input, so retries may rewrite the whole output; streaming = unbounded input, so closure must be inferred.",
        "Flush on size or elapsed time, whichever fires first; a single bound always has a failure mode.",
        "Emit the flush reason as a metric: it separates a slow sink from a too-long interval.",
        "Cargo: tokio = { version = \"1\", features = [\"macros\", \"rt-multi-thread\", \"sync\", \"time\"] }"
      ],
      production: [
        "The channel is bounded (mpsc::channel(capacity)), and full means backpressure, not an unbounded Vec.",
        "Every flush is idempotent: a crash after the write and before the offset commit replays the batch.",
        "Flush reason, batch rows and flush duration are exported as counters and a histogram.",
        "Shutdown path drains the final batch before exiting, so a deploy does not drop the last partial window."
      ],
      crates: ["tokio", "futures-util", "tracing"],
      github: [
        { name: "tokio-rs/tokio", url: "https://github.com/tokio-rs/tokio" }
      ],
      pitfall: "A batcher with a time bound but no size bound: one burst allocates until the process is killed, and the crash gets blamed on the sink that was merely slow.",
      resources: [
        { title: "tokio::select! macro: biased selection and cancel safety", url: "https://docs.rs/tokio/latest/tokio/macro.select.html", kind: "docs" },
        { title: "tokio::sync::mpsc: bounded channels and backpressure", url: "https://docs.rs/tokio/latest/tokio/sync/mpsc/index.html", kind: "docs" },
        { title: "The Dataflow Model: balancing correctness, latency and cost", url: "https://research.google/pubs/pub43864/", kind: "paper" },
        { title: "tokio-rs/tokio: the async runtime used in this lesson", url: "https://github.com/tokio-rs/tokio", kind: "repo" }
      ]
    },
    {
      id: "m02",
      title: "Kafka as a log: retention, compaction and lag",
      minutes: 90,
      level: "core",
      goal: "Treat a topic as a re-readable log, choose delete or compact retention deliberately, and compute per-partition lag from watermarks and positions.",
      sections: [
        {
          h: "A consumer position, not a mailbox",
          p: [
            "Kafka does not delete a record when a consumer reads it. Each consumer group stores an offset per partition, and retention runs on a separate clock measured in time or bytes: log.retention.ms and retention.bytes delete whole segments regardless of who has read them. A consumer that falls behind the retention window does not slow down, it gets a gap, and auto.offset.reset decides whether it resumes at the earliest surviving record or at the end.",
            "That makes replay an ordinary operation: stop the consumer, reset offsets, run the same code again. It also makes the topic the system of record for anything not persisted elsewhere, so retention must exceed the slowest recovery path - a rebuild of last month's table cannot read a topic kept for seven days."
          ],
          list: [
            "Delete retention removes whole segments by age or size, never by consumption",
            "Compact retention keeps the last value per key and drops superseded ones",
            "A null payload on a compacted topic is a tombstone; delete.retention.ms decides how long it survives",
            "auto.offset.reset=earliest replays everything when the group has no committed offset"
          ],
          tip: "Set retention from worst-case rebuild time. Seven days of retention cannot rebuild a table you recompute monthly."
        },
        {
          h: "Lag is the backlog, measured per partition",
          p: [
            "Lag is the log-end offset minus the group's committed position, summed over partitions. It is the only metric that answers whether the pipeline is behind, because broker CPU and produce rate can look healthy while one partition falls hours behind. Track the maximum per-partition lag, not the mean: a single hot key with a stuck handler disappears in an average.",
            "Two cheap metadata calls give you the number: fetch_watermarks returns the low and high offsets, position returns the group's current position. Do not infer lag from consumed counts, because rebalances and manual commits make counters drift, and a consumer that stops polling looks exactly like one that is merely slow."
          ],
          code: `use rdkafka::consumer::{Consumer, StreamConsumer};
use rdkafka::util::Timeout;
use rdkafka::Offset;
use std::time::Duration;

/// Per-partition lag: high watermark minus committed (or current) position.
pub fn report_lag(
    consumer: &StreamConsumer,
    topic: &str,
    partitions: i32,
) -> rdkafka::error::KafkaResult<()> {
    let timeout = Timeout::After(Duration::from_secs(2));
    let positions = consumer.position()?;

    for partition in 0..partitions {
        let (low, high) = consumer.fetch_watermarks(topic, partition, timeout)?;
        let committed = positions
            .elements_for_topic(topic)
            .into_iter()
            .find(|element| element.partition() == partition)
            .and_then(|element| match element.offset() {
                Offset::Offset(offset) => Some(offset),
                _ => None,
            })
            .unwrap_or(low);

        tracing::info!(
            topic,
            partition,
            lag = high.saturating_sub(committed),
            high,
            committed,
            "consumer lag"
        );
    }
    Ok(())
}`,
          tip: "A negative lag means offsets beyond the log end, usually after a topic recreation. Clamp with saturating_sub and alert on the reset, not on the number."
        },
        {
          h: "Partition count is a capacity decision",
          p: [
            "Ordering is per partition, so the record key chooses the partition and the partition count caps consumer parallelism: two consumers on a one-partition topic means one idle consumer no matter how much CPU it has. Adding partitions later changes the key-to-partition mapping, so per-key ordering can break across the resize for the keys that move.",
            "Size partitions for peak parallelism with headroom, then stop. Every partition carries broker metadata, replication traffic and consumer bookkeeping, so an oversized count multiplies operational work with no read benefit. If you must grow, do it at a recorded timestamp and treat it as a data event downstream, because jobs that assumed one partition per key now see two."
          ],
          tip: "Key by aggregate id. Keying by a random UUID spreads load evenly and orders nothing, so two events for the same order can be processed in either order."
        }
      ],
      exercise: {
        prompt: "Write a ticker that computes per-partition lag every 15 seconds and marks a partition stale when lag exceeds 50,000 records for two consecutive ticks.",
        starter: `use rdkafka::consumer::{Consumer, StreamConsumer};
use rdkafka::util::Timeout;
use std::time::Duration;

pub async fn watch(consumer: StreamConsumer, topic: &str, partitions: i32) -> ! {
    let mut stale = vec![0u8; partitions as usize];
    loop {
        // 1. fetch watermarks and positions per partition
        // 2. compute lag, increment or reset the per-partition counter
        // 3. log a warning when the counter reaches 2
        tokio::time::sleep(Duration::from_secs(15)).await;
    }
}`,
        hint: "Keep a Vec<u8> of consecutive-stale counts indexed by partition. Reset a counter to zero whenever lag drops below the threshold, otherwise a single busy morning pages all day.",
        solution: `use rdkafka::consumer::{Consumer, StreamConsumer};
use rdkafka::util::Timeout;
use rdkafka::Offset;
use std::time::Duration;

pub async fn watch(consumer: StreamConsumer, topic: &str, partitions: i32) -> ! {
    const THRESHOLD: i64 = 50_000;
    let mut stale = vec![0u8; partitions as usize];
    loop {
        let timeout = Timeout::After(Duration::from_secs(2));
        let positions = consumer.position().ok();
        for partition in 0..partitions {
            let Ok((_, high)) = consumer.fetch_watermarks(topic, partition, timeout) else { continue };
            let committed = positions
                .as_ref()
                .and_then(|list| {
                    list.elements_for_topic(topic)
                        .into_iter()
                        .find(|element| element.partition() == partition)
                        .and_then(|element| match element.offset() {
                            Offset::Offset(offset) => Some(offset),
                            _ => None,
                        })
                })
                .unwrap_or(high);
            let lag = high.saturating_sub(committed);
            let counter = &mut stale[partition as usize];
            if lag > THRESHOLD {
                *counter = counter.saturating_add(1);
                if *counter >= 2 {
                    tracing::warn!(topic, partition, lag, "partition stale for two ticks");
                }
            } else {
                *counter = 0;
            }
        }
        tokio::time::sleep(Duration::from_secs(15)).await;
    }
}`
      },
      questions: [
        {
          q: "A consumer group was paused for 10 days on a topic with log.retention.ms = 604800000. What does it see on restart?",
          options: [
            "Every record since its last commit, because offsets are permanent",
            "A gap: segments older than the retention window are gone, so it resumes where the log now begins",
            "The broker refuses the fetch until the group catches up",
            "Records are recompacted so nothing is lost"
          ],
          answer: 1,
          explain: "Retention deletes segments by age or size independent of consumption. Offsets remain, but the data they point at may be gone, so the consumer resumes at the log start offset - a gap that must be repaired by a backfill from another source."
        },
        {
          q: "Which pair of calls gives you per-partition lag without consuming records?",
          options: [
            "metadata() and list_offsets()",
            "fetch_watermarks() and position()",
            "committed() and subscribe()",
            "assignment() and store_offset()"
          ],
          answer: 1,
          explain: "fetch_watermarks returns the low and high offsets for a partition; position() returns the group's current position. Both are metadata calls, so a lag monitor does not need to consume or commit anything."
        },
        {
          q: "A topic with 6 partitions is consumed by a group with 4 consumers. What is the consequence?",
          options: [
            "Two consumers are idle and partitions hold extra assignment",
            "The group rebalances on every poll",
            "Messages are duplicated across consumers",
            "Kafka rejects the subscription"
          ],
          answer: 0,
          explain: "Each partition is assigned to exactly one consumer in a group, so with 4 consumers and 6 partitions two consumers get a second partition each. Parallelism is capped by partitions, which is why partition count is a capacity decision."
        }
      ],
      quickbytes: [
        "Kafka deletes by retention policy, never because a consumer read a record.",
        "Lag = high watermark - committed offset, computed per partition and alerted on the maximum.",
        "Compacted topics keep the last value per key; a null payload is a tombstone, not a delete message.",
        "Partition count caps consumer parallelism; growing it later remaps keys and can break per-key order."
      ],
      production: [
        "Retention is longer than the worst-case time to rebuild downstream tables from the topic.",
        "Lag is exported per partition with an alert on max lag sustained over two scrapes, not on the mean.",
        "auto.offset.reset is set explicitly and documented; earliest on a new group replays the whole topic.",
        "Partition count changes are recorded with a timestamp so downstream jobs can reason about key remapping."
      ],
      crates: ["rdkafka", "tokio", "tracing", "serde"],
      github: [
        { name: "fede1024/rust-rdkafka", url: "https://github.com/fede1024/rust-rdkafka" }
      ],
      pitfall: "Monitoring broker health and produce rate while ignoring per-partition lag: one partition with a hot key stalls for hours and the pipeline is silently hours behind.",
      resources: [
        { title: "rdkafka: consumer trait, watermarks and positions", url: "https://docs.rs/rdkafka/latest/rdkafka/consumer/trait.Consumer.html", kind: "docs" },
        { title: "Apache Kafka design: log, retention and compaction", url: "https://kafka.apache.org/documentation/#design", kind: "docs" },
        { title: "rust-rdkafka: the Rust client used here", url: "https://github.com/fede1024/rust-rdkafka", kind: "repo" },
        { title: "How Kafka stores a trillion messages: segments, indexes, compaction", url: "https://www.youtube.com/watch?v=hDi2VPiAmt0", kind: "video" }
      ]
    },
    {
      id: "m03",
      title: "JetStream: streams, durable consumers and acks",
      minutes: 85,
      level: "core",
      goal: "Model a durable pipeline on JetStream with a subject-scoped stream, a pull consumer using explicit acks, and a dedupe window keyed by message id.",
      sections: [
        {
          h: "Streams persist; consumers track position",
          p: [
            "Core NATS is fire and forget: publish to a subject, and whoever is subscribed at that instant receives it. JetStream adds a stream, a replicated disk-backed log selected by subject, with limits on age, bytes and message count plus a discard policy that decides whether new messages are refused or old ones evicted. Several consumers can read one stream independently, each with its own position, so a slow consumer cannot hold back a fast one.",
            "Storage type and replicas are the durability decision. File storage with three replicas survives losing a node; memory storage does not. For a pipeline that lands Parquet in an object store, the stream is a buffer sized for the outage you can tolerate, not an archive: max_age should exceed the time it takes to notice and repair a broken sink."
          ],
          list: [
            "One stream per subject namespace, for example events.orders.v1.>",
            "duplicate_window makes a repeated Nats-Msg-Id a no-op inside the window",
            "max_age bounds replay; a stream kept for seven days cannot rebuild a monthly table",
            "Replicas of three on file storage is the minimum that survives a node loss"
          ],
          tip: "A stream with a broad wildcard silently absorbs subjects nobody planned for. Scope the subject filter to a versioned namespace."
        },
        {
          h: "Acks decide what a redelivery means",
          p: [
            "A pull consumer with explicit acks redelivers anything unacknowledged after ack_wait. max_deliver caps the attempts, after which the message stays in the stream and stops being delivered to that consumer. A nak with a delay is a retry, term ends delivery for a poison message, and ack acknowledges. The ack is not a transaction with your write: it happens afterwards, so a crash in between causes redelivery, and the sink has to tolerate it.",
            "max_ack_pending is the flow-control knob. Too high and a slow sink accumulates a large unacknowledged set that all comes back after a restart; too low and throughput collapses under per-message latency. Set it from the sink's batch size rather than leaving the server default in place and hoping."
          ],
          code: `use async_nats::jetstream::{
    self,
    consumer::{pull, AckPolicy},
    stream, AckKind,
};
use futures_util::StreamExt;
use std::time::Duration;

#[derive(Debug)]
pub enum SinkError { Retryable(String), Poison(String) }

pub async fn run(url: &str) -> Result<(), Box<dyn std::error::Error>> {
    let client = async_nats::connect(url).await?;
    let js = jetstream::new(client);

    let stream = js
        .get_or_create_stream(stream::Config {
            name: "ORDERS".to_string(),
            subjects: vec!["events.orders.v1.>".to_string()],
            max_age: Duration::from_secs(7 * 24 * 3600),
            duplicate_window: Duration::from_secs(120),
            ..Default::default()
        })
        .await?;

    let consumer = stream
        .get_or_create_consumer(
            "orders-lake",
            pull::Config {
                durable_name: Some("orders-lake".to_string()),
                ack_policy: AckPolicy::Explicit,
                ack_wait: Duration::from_secs(30),
                max_deliver: 5,
                max_ack_pending: 256,
                ..Default::default()
            },
        )
        .await?;

    let mut messages = consumer.messages().await?;
    while let Some(next) = messages.next().await {
        let message = next?;
        match handle(&message.payload).await {
            Ok(()) => message.ack().await?,
            Err(SinkError::Retryable(reason)) => {
                tracing::warn!(%reason, "retryable sink error, naking");
                message.ack_with(AckKind::Nak(Some(Duration::from_secs(5)))).await?;
            }
            Err(SinkError::Poison(reason)) => {
                tracing::error!(%reason, "poison message, terminating delivery");
                message.ack_with(AckKind::Term).await?;
            }
        }
    }
    Ok(())
}

async fn handle(_payload: &[u8]) -> Result<(), SinkError> { Ok(()) }`,
          tip: "Use Nak(Some(delay)) for retryable failures. An immediate nak spins a hot loop against a dependency that is still down."
        },
        {
          h: "Dedupe at publish, idempotence at consume",
          p: [
            "The duplicate window is a producer-side convenience: publish the same Nats-Msg-Id twice inside the window and the server stores one copy. It does not survive a restart outside the window, and it does not deduplicate two different message ids carrying the same business event. Treat it as protection against retries in flight, not as exactly-once delivery.",
            "The consumer still needs an idempotent write. Land the record under a deterministic key - partition path plus event id - and a redelivery overwrites the same object instead of appending a second one. Where the sink cannot be made idempotent, keep a durable dedupe table keyed by message id and check it inside the same transaction as the write."
          ],
          tip: "Set duplicate_window to at least the publisher's retry horizon. A 30-second window with a five-minute retry policy deduplicates nothing."
        }
      ],
      exercise: {
        prompt: "Add deduplication and retry classification to a JetStream consumer: ack on success, nak with a 5 second delay on a retryable sink error, term after three poison deliveries, and skip a message whose id was already landed.",
        starter: `use async_nats::jetstream::message::Message;

pub struct Sink { pub landed: std::collections::HashSet<String> }

pub async fn process(sink: &mut Sink, message: &Message) -> Result<(), String> {
    // 1. read the Nats-Msg-Id header (or the message subject + sequence)
    // 2. return Ok(()) if it is already in sink.landed so the caller acks
    // 3. otherwise write, insert the id, and let the caller ack
    todo!()
}`,
        hint: "The header is message.headers.as_ref().and_then(|h| h.get(\"Nats-Msg-Id\")). Fall back to the stream sequence, which is unique per stream even when the producer omits the header.",
        solution: `use async_nats::jetstream::message::Message;

pub struct Sink { pub landed: std::collections::HashSet<String> }

pub async fn process(sink: &mut Sink, message: &Message) -> Result<(), String> {
    let id = message
        .headers
        .as_ref()
        .and_then(|headers| headers.get("Nats-Msg-Id"))
        .map(|value| value.to_string())
        .unwrap_or_else(|| format!("{}-{}", message.subject, message.info().unwrap().stream_sequence));

    if sink.landed.contains(&id) {
        tracing::info!(%id, "duplicate delivery, acking without a write");
        return Ok(());
    }

    // Durable, idempotent write keyed by id goes here: same key, same object.
    sink.landed.insert(id);
    Ok(())
}`
      },
      questions: [
        {
          q: "What does the duplicate_window setting actually guarantee?",
          options: [
            "Exactly-once delivery to every consumer",
            "That a republished message with the same Nats-Msg-Id inside the window is stored once",
            "That acknowledgements survive a server restart",
            "That consumers never see the same message twice"
          ],
          answer: 1,
          explain: "It is a producer-side dedupe inside a time window, keyed by Nats-Msg-Id. Redelivery to consumers is a separate mechanism, and a retry outside the window stores a second copy, so the sink still has to be idempotent."
        },
        {
          q: "A handler consistently takes longer than ack_wait. What do you observe?",
          options: [
            "The server extends ack_wait automatically",
            "Messages are redelivered while the first attempt is still running, so work is duplicated",
            "The consumer is deleted",
            "The stream refuses new messages"
          ],
          answer: 1,
          explain: "ack_wait is a server-side timer, not knowledge of your progress. If the handler exceeds it, the message becomes eligible for redelivery to another consumer while the first attempt continues - concurrent duplicates, unless max_ack_pending and timeouts are sized to the handler."
        },
        {
          q: "Why is max_ack_pending a flow-control setting rather than a performance tweak?",
          options: [
            "It caps how many unacknowledged messages a consumer may hold, bounding replay after a crash",
            "It sets the number of replicas",
            "It limits the size of each message",
            "It controls how long messages stay in the stream"
          ],
          answer: 0,
          explain: "Unacknowledged messages are still owed work. A high limit lets a slow sink accumulate a large in-flight set that is all redelivered after a restart; a low limit keeps memory and replay bounded at the cost of throughput."
        }
      ],
      quickbytes: [
        "Ack after the durable write, never before; a crash in between is a redelivery, not data loss.",
        "AckKind::Nak(Some(delay)) for retryable errors, AckKind::Term for poison messages.",
        "duplicate_window deduplicates republished Nats-Msg-Id values; it is not exactly-once delivery.",
        "Size max_ack_pending from the sink batch size and ack_wait from the p99 handler duration."
      ],
      production: [
        "Streams use file storage with num_replicas >= 3 and max_age longer than the sink repair window.",
        "ack_wait exceeds the p99 handler duration, measured, not guessed.",
        "Poison messages are terminated and routed to a dead-letter subject with the failure reason attached.",
        "Every sink write is keyed deterministically so a redelivery overwrites rather than duplicates."
      ],
      crates: ["async-nats", "tokio", "futures-util", "serde_json"],
      github: [
        { name: "nats-io/nats.rs", url: "https://github.com/nats-io/nats.rs" }
      ],
      pitfall: "Leaving max_ack_pending at the default with a sink that takes seconds per batch: after a restart the whole in-flight window is redelivered at once and the sink is hit by a thundering herd of duplicates.",
      resources: [
        { title: "async-nats JetStream module: streams, consumers, acks", url: "https://docs.rs/async-nats/latest/async_nats/jetstream/", kind: "docs" },
        { title: "NATS docs: JetStream concepts and persistence", url: "https://docs.nats.io/nats-concepts/jetstream", kind: "docs" },
        { title: "nats-io/nats.rs: the official Rust client", url: "https://github.com/nats-io/nats.rs", kind: "repo" },
        { title: "State of NATS: core, persistence and materialized views (Tomasz Pietrek, CNCF)", url: "https://www.youtube.com/watch?v=MPda_7EPrNU", kind: "video" }
      ]
    },
    {
      id: "m04",
      title: "Stream processing: keyed state, event time and watermarks",
      minutes: 100,
      level: "advanced",
      goal: "Aggregate an unbounded stream with keyed state, decide when a window is closed using watermarks, and handle late records with an explicit policy.",
      sections: [
        {
          h: "Aggregation is state, and state is the cost",
          p: [
            "Map and filter are stateless: one record in, at most one out. Every aggregation is different, because a sum over a customer needs the running total for that customer, and a count needs a counter per key. The state is the expensive part of a streaming job: it must be bounded, checkpointed, and migrated when the key space or the query changes.",
            "Bound it on purpose. A keyed window holds state only until the window closes, so its size is keys times open windows - predictable. An unbounded per-key state, such as every session since launch, grows forever and eventually fails on a checkpoint timeout rather than on a clean error. If a query needs history, project it into a table and join against that instead of holding it in memory."
          ],
          list: [
            "Stateless operators scale by adding workers; keyed state scales only by rebalancing keys",
            "Window state is bounded by open windows; session state is bounded by traffic and time",
            "Every stateful operator needs a TTL or an explicit close condition",
            "Checkpoint size, not throughput, is usually the first operational limit you hit"
          ],
          tip: "Log the live key count and the checkpoint duration. A key count that trends up with traffic means the key is too granular."
        },
        {
          h: "Event time is not arrival time",
          p: [
            "Records arrive in whatever order the network and the partitions allow. A payment made at 10:00 can land after one made at 10:05 because it came from a different partition, a retried producer, or a mobile client that buffered for a minute. Aggregating by arrival time makes the result depend on transport, so the same data produces different numbers on a replay.",
            "Event time fixes that by windowing on the timestamp inside the record. The price is that the job cannot know when a window is complete, so it maintains a watermark: a claim that no record older than W is expected. Watermarks come from the source's own guarantees - Kafka partition offsets and timestamps, or an explicit idle-partition policy - and every streaming engine exposes a knob for how aggressive that claim is."
          ],
          code: `use std::collections::HashMap;

/// Tumbling windows over event time, with a bounded lateness allowance.
pub struct WindowAgg {
    pub window_ms: i64,
    pub allowed_lateness_ms: i64,
    watermark: i64,
    state: HashMap<(String, i64), i64>,
    pub late_dropped: u64,
}

impl WindowAgg {
    pub fn new(window_ms: i64, allowed_lateness_ms: i64) -> Self {
        Self { window_ms, allowed_lateness_ms, watermark: i64::MIN, state: HashMap::new(), late_dropped: 0 }
    }

    /// Returns windows that closed as a result of this record's timestamp.
    pub fn push(&mut self, key: &str, event_ts: i64, amount: i64) -> Vec<(String, i64, i64)> {
        let window_start = event_ts.div_euclid(self.window_ms) * self.window_ms;
        let window_end = window_start + self.window_ms;
        if window_end + self.allowed_lateness_ms <= self.watermark {
            self.late_dropped += 1;
            return Vec::new();
        }
        *self.state.entry((key.to_string(), window_start)).or_insert(0) += amount;
        self.advance(event_ts)
    }

    /// The watermark trails the max event time by the lateness allowance.
    pub fn advance(&mut self, event_ts: i64) -> Vec<(String, i64, i64)> {
        self.watermark = self.watermark.max(event_ts - self.allowed_lateness_ms);
        let watermark = self.watermark;
        let window_ms = self.window_ms;
        let allowed = self.allowed_lateness_ms;
        let closed: Vec<_> = self
            .state
            .keys()
            .filter(|(_, start)| start + window_ms + allowed <= watermark)
            .cloned()
            .collect();
        closed
            .into_iter()
            .filter_map(|k| self.state.remove(&k).map(|sum| (k.0, k.1, sum)))
            .collect()
    }
}`,
          tip: "Emit window_end as the timestamp of the aggregate, not the arrival time. Downstream joins and dedupe then behave the same on live and replayed data."
        },
        {
          h: "Late data needs a written policy",
          p: [
            "Some records will always miss their window. The policy has to be explicit because each choice has a different downstream meaning: drop and count, route to a side output for a later reconciliation, or retract and re-emit the corrected window. Dropping silently is the worst option, since the number is now wrong with no record of why.",
            "Allowed lateness is the budget you set for that policy. It should come from observed transport delay - the p99 difference between event time and arrival time - not from a round number. A budget of five minutes with a p99 delay of forty seconds is generous; a budget of five seconds with the same delay drops one percent of the data every hour."
          ],
          tip: "Alert when late_dropped grows faster than ingestion. That ratio is the honest measure of whether the watermark policy matches reality."
        }
      ],
      exercise: {
        prompt: "Extend WindowAgg with a retract path: when a late record falls inside an already-emitted window within the lateness budget, emit both the correction delta and the key so the sink can upsert.",
        starter: `use std::collections::HashMap;

pub struct WindowAgg {
    pub window_ms: i64,
    pub allowed_lateness_ms: i64,
    watermark: i64,
    state: HashMap<(String, i64), i64>,
    pub emitted: HashMap<(String, i64), i64>,
    pub late_dropped: u64,
}

impl WindowAgg {
    pub fn push(&mut self, key: &str, event_ts: i64, amount: i64)
        -> Vec<(String, i64, i64)> {
        // 1. window_start from event_ts
        // 2. if the window already closed, decide: drop or emit a delta
        // 3. otherwise accumulate and advance the watermark
        todo!()
    }
}`,
        hint: "Keep the last emitted value per window in `emitted`. A late record inside the budget produces a delta (new total minus emitted total), which an upserting sink applies correctly. Outside the budget, increment late_dropped.",
        solution: `use std::collections::HashMap;

pub struct WindowAgg {
    pub window_ms: i64,
    pub allowed_lateness_ms: i64,
    watermark: i64,
    state: HashMap<(String, i64), i64>,
    pub emitted: HashMap<(String, i64), i64>,
    pub late_dropped: u64,
}

impl WindowAgg {
    pub fn push(&mut self, key: &str, event_ts: i64, amount: i64) -> Vec<(String, i64, i64)> {
        let window_start = event_ts.div_euclid(self.window_ms) * self.window_ms;
        let window_end = window_start + self.window_ms;
        let closed_at = window_end + self.allowed_lateness_ms;

        if closed_at <= self.watermark {
            let id = (key.to_string(), window_start);
            match self.emitted.get_mut(&id) {
                Some(last) => {
                    let delta = amount;
                    *last += delta;
                    // Upsert sink: the new total replaces the old one.
                    vec![(id.0, id.1, *last)]
                }
                None => {
                    self.late_dropped += 1;
                    Vec::new()
                }
            }
        } else {
            *self.state.entry((key.to_string(), window_start)).or_insert(0) += amount;
            let watermark = self.watermark.max(event_ts - self.allowed_lateness_ms);
            self.watermark = watermark;
            let closed: Vec<_> = self
                .state
                .keys()
                .filter(|(_, start)| start + self.window_ms + self.allowed_lateness_ms <= watermark)
                .cloned()
                .collect();
            closed
                .into_iter()
                .filter_map(|id| {
                    let total = self.state.remove(&id)?;
                    self.emitted.insert(id.clone(), total);
                    Some((id.0, id.1, total))
                })
                .collect()
        }
    }
}`
      },
      questions: [
        {
          q: "Why does windowing by arrival time produce different results on replay than on the live run?",
          options: [
            "Because arrival time is assigned by the consumer, so a slower consumer shifts records between windows",
            "Because the broker rewrites timestamps on replay",
            "Because watermarks are disabled on replay",
            "Because windowing requires a sorted input"
          ],
          answer: 0,
          explain: "Arrival time is a property of the transport and the consumer's pace, not of the event. Replaying the same records at a different speed moves them across window boundaries, which is exactly what event time avoids."
        },
        {
          q: "What does a watermark of W assert?",
          options: [
            "That all records up to W have been processed",
            "That no record with event time older than W is expected, so windows ending before W may be closed",
            "That the source is idle",
            "That state older than W has been deleted"
          ],
          answer: 1,
          explain: "A watermark is a heuristic completeness claim, not a fact. It licenses closing windows, and the allowed-lateness budget exists because the claim is sometimes wrong."
        },
        {
          q: "A job holds per-key session state with no TTL. What is the predictable failure?",
          options: [
            "Throughput drops because of lock contention",
            "Checkpoint size and restore time grow without bound until a checkpoint times out",
            "The watermark advances too fast",
            "Records are dropped as late"
          ],
          answer: 1,
          explain: "Unbounded keyed state grows with history, so snapshots take longer and restores take longer, until the checkpoint interval can no longer complete. The failure surfaces as a checkpoint timeout, not as an out-of-memory panic."
        }
      ],
      quickbytes: [
        "Window on the event timestamp inside the record; arrival time makes results depend on transport.",
        "Watermark = completeness claim; allowed lateness = the budget for that claim being wrong.",
        "Bound keyed state with windows or TTLs; unbounded state fails as a checkpoint timeout, not an OOM.",
        "Track late_dropped divided by ingested records; that ratio tells you if the watermark is honest."
      ],
      production: [
        "Every stateful operator has a documented bound: window size, TTL, or an explicit close condition.",
        "The lateness budget is derived from the measured p99 difference between event time and arrival time.",
        "Late records are counted and, where they matter, routed to a reconciliation path instead of dropped.",
        "Aggregates are emitted with the window end as their event time so live and replayed results match."
      ],
      crates: ["tokio", "futures-util", "serde", "tracing"],
      github: [
        { name: "apache/flink", url: "https://github.com/apache/flink" }
      ],
      pitfall: "Emitting a window on a timer instead of on the watermark: replay produces different totals than the live run, and nobody can reconcile the two.",
      resources: [
        { title: "The Dataflow Model: event time, watermarks, triggers", url: "https://research.google/pubs/pub43864/", kind: "paper" },
        { title: "Event time and watermarks - Apache Flink 101 (Confluent)", url: "https://www.youtube.com/watch?v=sdhwpUAjqaI", kind: "video" },
        { title: "tokio::time: intervals, sleeps and timeouts", url: "https://docs.rs/tokio/latest/tokio/time/index.html", kind: "docs" },
        { title: "apache/flink: reference implementation of watermarks and keyed state", url: "https://github.com/apache/flink", kind: "repo" }
      ]
    },
    {
      id: "m05",
      title: "Apache Arrow: columnar memory, nulls and zero-copy",
      minutes: 95,
      level: "advanced",
      goal: "Read an Arrow array's layout, build a RecordBatch by hand, and use filter and cast kernels without copying data you do not need.",
      sections: [
        {
          h: "One buffer per column, plus a validity bitmap",
          p: [
            "Arrow stores a column as a contiguous typed buffer: 10,000 int64 values occupy 80,000 bytes with no per-row header, no pointer indirection and no object allocation. Variable-length types add an offsets buffer and a data buffer, so a string column is two integer arrays plus bytes. Nulls are tracked in a separate bitmap with one bit per value, which means a dense column with no nulls pays nothing for the capability.",
            "The payoff is locality and simplicity: a scan over one column reads only that column's bytes instead of pulling every field through cache. The layout is also specified across languages, so a Rust service, a Python notebook and a Java query engine can share one buffer with no serialization step, which is the entire reason Arrow exists as a format rather than a library API."
          ],
          list: [
            "Fixed-width values: one data buffer, typed and contiguous",
            "Variable-width values: an offsets buffer plus a data buffer",
            "Nulls: a validity bitmap, one bit per slot, absent when nothing is null",
            "Slicing is O(1): an array carries an offset and a length into shared buffers"
          ],
          tip: "A slice does not copy. Holding a 10-row slice of a million-row batch keeps the whole buffer alive, so be explicit about lifetimes when you buffer slices."
        },
        {
          h: "RecordBatch is the unit of work",
          p: [
            "A RecordBatch pairs one schema with one array per field, and its constructor enforces that every column has the same length and matches the declared type. That validation is the boundary between untyped bytes and typed data: Parquet, Kafka and CSV decoders all end by producing a batch, and every operator downstream can assume lengths agree.",
            "Cloning a batch is cheap because columns are reference-counted, so passing a batch to a filter creates new arrays only for the values that survive. This is why the idiomatic Rust data path is batch-oriented: amortize validation and allocation over thousands of rows, then let kernels do branch-free loops over the buffers."
          ],
          code: `use std::sync::Arc;
use arrow::array::{Array, BooleanArray, Int64Array, StringArray};
use arrow::compute::kernels::filter::filter_record_batch;
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;

pub fn build() -> Result<RecordBatch, arrow::error::ArrowError> {
    let schema = Arc::new(Schema::new(vec![
        Field::new("order_id", DataType::Utf8, false),
        Field::new("amount_minor", DataType::Int64, false),
        Field::new("refunded_minor", DataType::Int64, true),
    ]));

    let order_id = StringArray::from(vec!["o-1", "o-2", "o-3"]);
    let amount = Int64Array::from(vec![1_200, 900, 4_500]);
    let refunded = Int64Array::from(vec![Some(0), None, Some(500)]);

    let batch = RecordBatch::try_new(schema, vec![
        Arc::new(order_id),
        Arc::new(amount),
        Arc::new(refunded),
    ])?;

    // Nulls are a bitmap, not a sentinel value.
    assert_eq!(batch.column(2).null_count(), 1);

    // Filtering is a kernel over a boolean array, not a per-row loop.
    let predicate = BooleanArray::from(vec![true, false, true]);
    filter_record_batch(&batch, &predicate)
}`,
          tip: "RecordBatch::try_new validates length and type only. It does not validate business rules, and it will happily accept a schema that disagrees with the data's meaning."
        },
        {
          h: "Kernels beat hand-written loops",
          p: [
            "A kernel is a vectorized implementation of one operation - filter, take, cast, sum - that the compiler can auto-vectorize because it loops over a slice with no branches per element. Writing the same logic as an iterator over rows reintroduces bounds checks and per-value match arms, and typically runs several times slower on numeric data.",
            "The trade-off is that kernels want simple types. A cast that changes a column's type produces a new array and a copy, so a pipeline that casts repeatedly is really a pipeline that copies repeatedly. Decide the physical types at ingestion - int64 for money in minor units, UTF-8 for ids - and keep casts at the edges where the data enters your system."
          ],
          tip: "Use arrow::compute::kernels::cast::cast(&array, &DataType::Int64) rather than parsing strings per row; it handles nulls and errors uniformly."
        }
      ],
      exercise: {
        prompt: "Build a three-column RecordBatch of orders, count nulls per column, and return only the rows with a non-null amount above 1,000 using the filter kernel.",
        starter: `use std::sync::Arc;
use arrow::array::{Array, BooleanArray, Int64Array, StringArray};
use arrow::compute::kernels::filter::filter_record_batch;
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;

pub fn paid_orders() -> Result<RecordBatch, arrow::error::ArrowError> {
    // 1. define a schema: order_id (Utf8), amount_minor (Int64), note (Utf8, nullable)
    // 2. build the arrays
    // 3. build the predicate from the amount column, downcast first
    // 4. return filter_record_batch(&batch, &predicate)
    todo!()
}`,
        hint: "Downcast with batch.column(1).as_any().downcast_ref::<Int64Array>().expect(\"amount is Int64\"). Then map over iter() to build the boolean predicate.",
        solution: `use std::sync::Arc;
use arrow::array::{Array, BooleanArray, Int64Array, StringArray};
use arrow::compute::filter_record_batch;
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;

pub fn paid_orders() -> Result<RecordBatch, arrow::error::ArrowError> {
    let schema = Arc::new(Schema::new(vec![
        Field::new("order_id", DataType::Utf8, false),
        Field::new("amount_minor", DataType::Int64, false),
        Field::new("note", DataType::Utf8, true),
    ]));

    let ids = StringArray::from(vec!["o-1", "o-2", "o-3"]);
    let amounts = Int64Array::from(vec![1_200, 400, 4_500]);
    let notes = StringArray::from(vec![None, Some("manual review"), None]);

    let batch = RecordBatch::try_new(schema, vec![
        Arc::new(ids),
        Arc::new(amounts),
        Arc::new(notes),
    ])?;

    for (index, column) in batch.columns().iter().enumerate() {
        tracing::debug!(column = index, nulls = column.null_count(), "column nulls");
    }

    let amounts = batch
        .column(1)
        .as_any()
        .downcast_ref::<Int64Array>()
        .expect("amount_minor is Int64");
    let predicate = BooleanArray::from(
        amounts.iter().map(|value| value.map(|v| v > 1_000)).collect::<Vec<_>>(),
    );

    filter_record_batch(&batch, &predicate)
}`
      },
      questions: [
        {
          q: "Where does an Arrow array store which slots are null?",
          options: [
            "In a sentinel value such as i64::MIN",
            "In a separate validity bitmap, one bit per slot",
            "In a per-row enum tag",
            "In the schema metadata"
          ],
          answer: 1,
          explain: "Nulls live in a validity bitmap alongside the value buffer, so a column without nulls carries no bitmap at all. Sentinel values are exactly what Arrow avoids, because they collide with real data."
        },
        {
          q: "You take batch.slice(0, 10) from a batch of one million rows. What happens to memory?",
          options: [
            "Ten rows are copied and the rest is freed",
            "The slice references the same buffers, so the million-row buffers stay alive",
            "The slice is invalid until the parent is dropped",
            "Arrow compacts the buffers in the background"
          ],
          answer: 1,
          explain: "Arrow slices are an offset and a length into shared buffers, which is O(1) and allocation-free - and means a small slice can pin a large allocation. Copy explicitly when you need to retain a small piece."
        },
        {
          q: "Why is filter_record_batch preferred over mapping rows into a new Vec?",
          options: [
            "It preserves the schema automatically while a Vec does not",
            "The kernel loops over buffers with no per-row branching, so it vectorizes and rarely allocates per value",
            "It avoids allocating a boolean array",
            "It works only on Int64 columns"
          ],
          answer: 1,
          explain: "Kernels are written as tight loops over typed slices, which the compiler can vectorize; row-wise iteration adds bounds checks and per-value control flow. The boolean array is still allocated, so that option is wrong."
        }
      ],
      quickbytes: [
        "Arrow is columnar with a validity bitmap; nulls cost one bit, not one branch per value.",
        "RecordBatch::try_new checks column count, length and type - it is the trust boundary after decoding.",
        "Slices are O(1) views into shared buffers; keep them small or copy before retaining.",
        "Pin physical types at ingestion (int64 minor units, UTF-8 ids) and cast only at the edges."
      ],
      production: [
        "Batch size is explicit (for example 8,192 rows) and tuned, never whatever the decoder produced.",
        "Numeric money is int64 minor units end to end, so no float rounding enters the pipeline.",
        "Decoders validate schema and nullability once at ingestion, not per operator.",
        "Long-lived slices are avoided or copied, so a small downstream buffer cannot pin a large one."
      ],
      crates: ["arrow", "parquet", "tracing"],
      github: [
        { name: "apache/arrow-rs", url: "https://github.com/apache/arrow-rs" }
      ],
      pitfall: "Retaining a 10-row slice of a million-row batch in a cache: the whole underlying buffer stays resident, and the memory profile looks like a leak.",
      resources: [
        { title: "arrow crate: arrays, record batches and kernels", url: "https://docs.rs/arrow/latest/arrow/", kind: "docs" },
        { title: "arrow::array: buffer layout per array type", url: "https://docs.rs/arrow/latest/arrow/array/index.html", kind: "docs" },
        { title: "Apache Arrow: a cross-language in-memory format (Wes McKinney, SciPy 2018)", url: "https://www.youtube.com/watch?v=y7zGnKzaKIw", kind: "video" },
        { title: "apache/arrow-rs: the Rust implementation", url: "https://github.com/apache/arrow-rs", kind: "repo" }
      ]
    },
    {
      id: "m06",
      title: "Parquet: row groups, dictionary encoding and statistics",
      minutes: 100,
      level: "advanced",
      goal: "Configure a Parquet writer whose statistics actually enable skipping, and read only the row groups, columns and pages a query needs.",
      sections: [
        {
          h: "Row groups are the skip unit",
          p: [
            "A Parquet file is a sequence of row groups, and each row group stores a column chunk per column. A column chunk is a series of pages, each page holding values and - optionally - statistics. This nesting is the whole design: a reader can skip a row group without decompressing it, skip a column chunk because the projection does not need it, and skip a page inside a chunk when the predicate excludes its range.",
            "Row group size therefore trades three things. Larger groups compress better and reduce per-group metadata, but read more bytes per skip decision and need more memory to decode at once. A few hundred thousand rows, or roughly 100-250 MB uncompressed, is the usual compromise; a row group smaller than a page is pure overhead, because the footer and chunk metadata dominate."
          ],
          list: [
            "File footer holds the schema and per-row-group, per-column statistics",
            "Projection pushdown skips whole column chunks, including their I/O",
            "Predicate pushdown uses min/max and null counts to skip pages and groups",
            "Dictionary encoding helps low-cardinality columns and hurts wide unique ids"
          ],
          tip: "Statistics only help if the column is sorted or clustered. Randomly distributed values make every min/max range overlap, so nothing is ever skipped."
        },
        {
          h: "Writer settings that decide read cost",
          p: [
            "The default writer is not a bad writer, but it is a general one. Setting compression to ZSTD, keeping dictionary encoding on for low-cardinality columns, and enabling chunk-level statistics costs a little write CPU and buys faster reads for every consumer of the file. Bloom filters add a per-column structure that makes point lookups on high-cardinality columns - an order id - skip row groups that min/max cannot exclude.",
            "Measure the result instead of trusting the settings: after closing the writer, read the file metadata and compare total uncompressed size with compressed size, and check that the column you filter on actually has statistics. A file whose filter column has no statistics is a file that will be fully scanned by every predicate, which is the most common silent performance bug in a lake."
          ],
          code: `use std::fs::File;
use std::sync::Arc;

use arrow::array::{Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use parquet::arrow::ArrowWriter;
use parquet::basic::{Compression, ZstdLevel};
use parquet::file::properties::{EnabledStatistics, WriterProperties};
use parquet::schema::types::ColumnPath;

pub fn write(batch: &RecordBatch, path: &str) -> Result<(), Box<dyn std::error::Error>> {
    let props = WriterProperties::builder()
        .set_compression(Compression::ZSTD(ZstdLevel::try_new(3)?))
        .set_max_row_group_size(256 * 1024)
        .set_dictionary_enabled(true)
        .set_statistics_enabled(EnabledStatistics::Chunk)
        .set_column_bloom_filter_enabled(ColumnPath::from("order_id"), true)
        .build();

    let file = File::create(path)?;
    let mut writer = ArrowWriter::try_new(file, batch.schema(), Some(props))?;
    writer.write(batch)?;
    let metadata = writer.close()?;

    let row_groups = metadata.row_groups();
    let compressed: i64 = row_groups.iter().map(|rg| rg.compressed_size()).sum();
    let uncompressed: i64 = row_groups.iter().map(|rg| rg.total_byte_size()).sum();
    tracing::info!(
        rows = metadata.file_metadata().num_rows(),
        groups = row_groups.len(),
        ratio = uncompressed as f64 / compressed.max(1) as f64,
        "parquet written"
    );
    Ok(())
}`,
          tip: "ZstdLevel::try_new(3) is a balanced default. Level 19 compresses marginally better and makes the write path several times slower."
        },
        {
          h: "Predicate and projection pushdown in Rust",
          p: [
            "The reader builder exposes the two pushdowns directly. ProjectionMask::roots selects root columns by index, so unselected column chunks are never read from storage. RowFilter takes predicates built with ArrowPredicateFn, each declaring which columns it needs; the reader evaluates them on partially decoded batches and skips the remaining rows before they reach you.",
            "Where you put a predicate matters. A filter on the sorted event-date column can eliminate entire row groups before any page is decompressed; a filter on a random UUID cannot, and evaluating it as a row filter only saves downstream work. Order predicates cheapest and most selective first, and keep the predicate columns in the projection so the filter can be evaluated at all."
          ],
          code: `use std::fs::File;
use std::sync::Arc;

use arrow::array::BooleanArray;
use arrow::compute::kernels::cmp::gt_eq;
use arrow::datatypes::DataType;
use parquet::arrow::arrow_reader::{ArrowPredicateFn, ParquetRecordBatchReaderBuilder, RowFilter};
use parquet::arrow::ProjectionMask;

pub fn scan(path: &str, min_amount: i64) -> Result<usize, Box<dyn std::error::Error>> {
    let builder = ParquetRecordBatchReaderBuilder::try_new(File::open(path)?)?;

    // Only order_id (0) and amount_minor (1) are decoded.
    let projection = ProjectionMask::roots(builder.parquet_schema(), [0, 1]);
    let filter = RowFilter::new(vec![Box::new(ArrowPredicateFn::new(
        ProjectionMask::roots(builder.parquet_schema(), [1]),
        move |batch| {
            let amount = batch
                .column(0)
                .as_any()
                .downcast_ref::<arrow::array::Int64Array>()
                .expect("amount_minor is Int64");
            let threshold = arrow::array::Int64Array::new_scalar(min_amount);
            gt_eq(amount, &threshold)
        },
    ))]);

    let reader = builder
        .with_projection(projection)
        .with_row_filter(filter)
        .with_batch_size(8_192)
        .build()?;

    let mut rows = 0;
    for batch in reader {
        rows += batch?.num_rows();
    }
    Ok(rows)
}`,
          tip: "Keep predicate columns inside the projection. A row filter whose column was projected away fails at build time, not silently."
        }
      ],
      exercise: {
        prompt: "Write a function that reports, for a Parquet file, the number of row groups, the total compressed and uncompressed bytes, and whether the column you filter on has min/max statistics.",
        starter: `use std::fs::File;

pub fn audit(path: &str, column: &str) -> Result<(), Box<dyn std::error::Error>> {
    // 1. open the file with ParquetRecordBatchReaderBuilder::try_new
    // 2. read builder.metadata().file_metadata() and .row_groups()
    // 3. for each row group, find the column chunk and its statistics
    todo!()
}`,
        hint: "Use builder.metadata() before build(). For each row group, column(i).statistics() returns Option<&Statistics>; a file written without statistics returns None for every chunk.",
        solution: `use std::fs::File;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

pub fn audit(path: &str, column: &str) -> Result<(), Box<dyn std::error::Error>> {
    let builder = ParquetRecordBatchReaderBuilder::try_new(File::open(path)?)?;
    let metadata = builder.metadata();
    let file_meta = metadata.file_metadata();

    let schema = file_meta.schema_descr();
    let index = (0..schema.num_columns())
        .find(|i| schema.column(*i).name() == column)
        .ok_or("column not found")?;

    let mut compressed = 0i64;
    let mut uncompressed = 0i64;
    let mut with_stats = 0usize;

    for group in metadata.row_groups() {
        compressed += group.compressed_size();
        uncompressed += group.total_byte_size();
        if group.column(index).statistics().is_some() {
            with_stats += 1;
        }
    }

    tracing::info!(
        rows = file_meta.num_rows(),
        groups = metadata.num_row_groups(),
        compressed,
        uncompressed,
        ratio = uncompressed as f64 / compressed.max(1) as f64,
        stats_groups = with_stats,
        "parquet audit"
    );
    Ok(())
}`
      },
      questions: [
        {
          q: "What makes predicate pushdown effective on a Parquet file?",
          options: [
            "Compression enabled on every column",
            "Row group and page statistics whose min/max ranges do not overlap the predicate",
            "A bloom filter on every column",
            "Sorting the file's rows by insertion order"
          ],
          answer: 1,
          explain: "Skipping requires a range that excludes the predicate. Data clustered by the filter column produces narrow, non-overlapping ranges; randomly ordered data produces overlapping ranges and nothing is skipped, no matter which options are enabled."
        },
        {
          q: "A file has 50,000 row groups of 100 rows each. What is the most likely consequence?",
          options: [
            "Better compression from smaller units",
            "Metadata and per-group overhead dominate, and planning slows down",
            "Predicate pushdown stops working",
            "Dictionary encoding is disabled automatically"
          ],
          answer: 1,
          explain: "Each row group carries metadata, a footer entry and page headers. Groups smaller than a page cost more to describe than to read, so tiny groups inflate the footer and every reader pays for it."
        },
        {
          q: "Why does dictionary encoding usually hurt a column of unique random UUIDs?",
          options: [
            "The dictionary grows to one entry per value and adds indirection without deduplication",
            "The column exceeds the 32-bit page limit",
            "Statistics cannot be written for encoded columns",
            "ZSTD refuses to compress dictionary pages"
          ],
          answer: 0,
          explain: "Dictionary encoding pays only when values repeat. For near-unique values the dictionary is as large as the data plus an index buffer, so the file grows and decode does more work."
        }
      ],
      quickbytes: [
        "Row group size trades compression and skip granularity: aim for 100-250 MB uncompressed.",
        "Statistics only skip pages when the filter column is clustered, not random.",
        "ProjectionMask cuts decoded columns; RowFilter cuts rows before they reach you.",
        "Verify with metadata after writing: a filter column with no statistics means full scans forever."
      ],
      production: [
        "Files are written with ZSTD compression, chunk-level statistics, and a documented row-group size.",
        "The primary filter column is clustered or sorted, and a test asserts that statistics exist for it.",
        "Readers set a projection mask and batch size instead of decoding whole files.",
        "A metadata audit runs in CI over sample files, so a writer configuration change cannot silently drop statistics."
      ],
      crates: ["parquet", "arrow", "tracing"],
      github: [
        { name: "apache/arrow-rs", url: "https://github.com/apache/arrow-rs" },
        { name: "apache/parquet-format", url: "https://github.com/apache/parquet-format" }
      ],
      pitfall: "Writing Parquet with the default writer and a random sort order, then wondering why a date-filtered query scans the whole lake: no clustering means every row group overlaps every predicate.",
      resources: [
        { title: "parquet crate: writer, reader and properties", url: "https://docs.rs/parquet/latest/parquet/", kind: "docs" },
        { title: "WriterProperties: compression, statistics, bloom filters", url: "https://docs.rs/parquet/latest/parquet/file/properties/struct.WriterProperties.html", kind: "docs" },
        { title: "Dremel: record shredding and assembly for nested columns", url: "https://research.google/pubs/pub36632/", kind: "paper" },
        { title: "The Parquet format and performance optimization opportunities (Databricks)", url: "https://www.youtube.com/watch?v=1j8SdS7s_NY", kind: "video" },
        { title: "apache/parquet-format: the specification behind these settings", url: "https://github.com/apache/parquet-format", kind: "repo" }
      ]
    },
    {
      id: "m07",
      title: "Polars: lazy plans, pushdown and streaming scans",
      minutes: 95,
      level: "advanced",
      goal: "Build a lazy Polars plan over partitioned Parquet, read the optimized plan to confirm pushdown, and write results back without materializing everything.",
      sections: [
        {
          h: "Lazy builds a plan; collect executes it",
          p: [
            "An eager dataframe runs each operation immediately, which means every filter allocates a new frame. A lazy frame records expressions into a plan and executes them together, so the optimizer can push a filter below a join, drop columns no one selected, and evaluate one scan instead of three. For a lake query the column pruning is the largest win, because unselected columns are never decompressed.",
            "Explain the plan before trusting it. Polars renders both the logical and the optimized plan, and the difference tells you whether a predicate actually reached the scan. If a filter appears above a scan with a projection of every column, either the predicate depends on a computed expression the optimizer cannot push, or the file layout does not allow pruning."
          ],
          code: `use polars::prelude::*;

pub fn daily_revenue(path: &str) -> PolarsResult<DataFrame> {
    let plan = LazyFrame::scan_parquet(path.into(), ScanArgsParquet::default())?
        .filter(col("status").eq(lit("paid")))
        // dt is the hive-style partition column, stored as UTF-8: a string
        // comparison still prunes the scan when the values are ISO dates.
        .filter(col("dt").gt_eq(lit("2026-01-01")))
        .select([col("dt"), col("customer_id"), col("amount_minor")])
        .group_by([col("dt")])
        .agg([
            col("amount_minor").sum().alias("revenue_minor"),
            len().alias("orders"),
        ])
        .sort_by_exprs(
            [col("dt")],
            SortMultipleOptions::default().with_order_descending(false),
        );

    // The optimized plan should show the projection and predicate at the scan.
    println!("{}", plan.explain(true)?);
    plan.collect()
}`,
          tip: "explain(true) returns the optimized plan; explain(false) shows what you wrote. Diff them - that diff is the optimizer's entire contribution."
        },
        {
          h: "Expressions are columnar, and that changes how you write code",
          p: [
            "Polars expressions describe an operation over entire columns, so col(\"amount\").sum() is one vectorized pass, not a closure invoked per row. The habit that transfers best from Rust iterators - map, filter, collect - is the wrong shape here: a per-row closure is opaque to the optimizer and forces it to materialize an intermediate frame.",
            "Grouping, joining and window functions compose from the same primitives, and the engine parallelizes across groups and columns. What it cannot fix is a bad physical plan: a join key with mismatched types, a group by on a high-cardinality string column, or a filter applied after an expensive aggregation. Those are decisions you make, and the plan view is where you check them."
          ],
          list: [
            "Filter and select early; the optimizer pushes both toward the scan",
            "Prefer built-in aggregations over map-style closures, which block pushdown",
            "Cast join keys to the same type once, before the join, not inside it",
            "Sort only when a downstream consumer needs order; it costs a full pass"
          ],
          tip: "A join on Utf8 keys hashes strings. If both sides have an integer id available, joining on that is usually several times faster."
        },
        {
          h: "Writing results without materializing the lake",
          p: [
            "collect() materializes the final frame in memory, which is fine for an aggregate and wrong for a reshaped copy of the input. Polars can sink a lazy plan directly to Parquet, and for a smaller result you can write the collected frame with ParquetWriter, choosing compression and row-group size explicitly rather than accepting defaults.",
            "The decision is the same one as in the Parquet lesson: an aggregate that fits in memory is a small frame, and a rewrite of a billion rows is not. Size the output rows first from a count, then choose between collect-then-write and a streaming sink. Both produce the same bytes; only the peak memory differs."
          ],
          code: `use std::fs::File;

use polars::prelude::*;

pub fn write_daily(path: &str, out: &str) -> PolarsResult<()> {
    let mut df = LazyFrame::scan_parquet(path.into(), ScanArgsParquet::default())?
        .filter(col("status").eq(lit("paid")))
        .group_by([col("dt")])
        .agg([col("amount_minor").sum().alias("revenue_minor")])
        .collect()?;

    let file = File::create(out)?;
    let written = ParquetWriter::new(file)
        .with_compression(ParquetCompression::Zstd(None))
        .with_row_group_size(Some(256 * 1024))
        .finish(&mut df)?;

    tracing::info!(rows = df.height(), bytes = written, "aggregate written");
    Ok(())
}`,
          tip: "ParquetWriter defaults to Zstd, unlike parquet-rs which defaults to uncompressed. Do not assume the same defaults across crates."
        }
      ],
      exercise: {
        prompt: "Write a lazy pipeline that scans a Parquet directory, keeps only rows with a non-null customer_id and a positive amount, groups by customer_id, and returns the top ten by total amount - then assert the plan contains a projection at the scan.",
        starter: `use polars::prelude::*;

pub fn top_customers(path: &str) -> PolarsResult<DataFrame> {
    let plan = LazyFrame::scan_parquet(path.into(), ScanArgsParquet::default())?
        // 1. filter null customer_id and non-positive amounts
        // 2. select only the two columns you need
        // 3. group by customer_id, sum amount, sort descending, limit 10
        ;
    let explained = plan.explain(true)?;
    assert!(explained.contains("Parquet"));
    plan.collect()
}`,
        hint: "col(\"customer_id\").is_not_null() and col(\"amount_minor\").gt(lit(0)). Sort with sort_by_exprs and SortMultipleOptions::default().with_order_descending(true), then .limit(10).",
        solution: `use polars::prelude::*;

pub fn top_customers(path: &str) -> PolarsResult<DataFrame> {
    let plan = LazyFrame::scan_parquet(path.into(), ScanArgsParquet::default())?
        .filter(col("customer_id").is_not_null())
        .filter(col("amount_minor").gt(lit(0)))
        .select([col("customer_id"), col("amount_minor")])
        .group_by([col("customer_id")])
        .agg([col("amount_minor").sum().alias("total_minor")])
        .sort_by_exprs(
            [col("total_minor")],
            SortMultipleOptions::default().with_order_descending(true),
        )
        .limit(10);

    let explained = plan.explain(true)?;
    // A projection and a predicate at the scan mean pushdown happened.
    assert!(explained.contains("Parquet"));
    plan.collect()
}`
      },
      questions: [
        {
          q: "What does a lazy frame give you that an eager frame does not?",
          options: [
            "Automatic parallelism per row",
            "A single optimized plan, so filters and projections are pushed into the scan",
            "Stronger type checking at compile time",
            "Zero-copy conversion to Arrow"
          ],
          answer: 1,
          explain: "Laziness exists to let the optimizer see the whole query. Column pruning and predicate pushdown are only possible when the engine knows every operation before executing any of them."
        },
        {
          q: "A filter does not appear at the scan in explain(true). Which cause is most likely?",
          options: [
            "The Parquet file is corrupted",
            "The predicate depends on an expression the optimizer cannot push down, such as a per-row closure",
            "The file has too many row groups",
            "Polars disabled pushdown for UTF-8 columns"
          ],
          answer: 1,
          explain: "Polars pushes simple column predicates. An opaque map or a computed expression leaves the filter above the scan, where it still works but reads and decodes columns it will discard."
        },
        {
          q: "Why does collect() before writing Parquet risk failure on a large rewrite?",
          options: [
            "ParquetWriter cannot write frames larger than 2 GB",
            "The whole result is held in memory, so peak usage is proportional to output size",
            "collect() disables compression",
            "The writer requires an eager frame that is already sorted"
          ],
          answer: 1,
          explain: "collect materializes the frame. For an aggregate that is small, but for a row-preserving rewrite the output size equals the input and the process may not have that much memory."
        }
      ],
      quickbytes: [
        "explain(true) shows the optimized plan; diff it against explain(false) to confirm pushdown.",
        "Select only the columns you need - Parquet decompresses per column, so pruning is real I/O saved.",
        "Prefer built-in aggregations over per-row closures; closures block pushdown and vectorization.",
        "Polars ParquetWriter defaults to Zstd; parquet-rs defaults to uncompressed."
      ],
      production: [
        "Every lake query starts from scan_parquet against a lazy frame, never a full read into a DataFrame.",
        "The optimized plan is printed in debug mode or asserted in a test for critical pipelines.",
        "Join keys are cast to matching types before the join, and string-key joins are treated as a performance smell.",
        "Output row-group size and compression are set explicitly when writing curated tables."
      ],
      crates: ["polars", "parquet", "tracing"],
      github: [
        { name: "pola-rs/polars", url: "https://github.com/pola-rs/polars" }
      ],
      pitfall: "Wrapping the pipeline in a per-row closure to reuse iterator habits: the optimizer can no longer push the predicate into the scan, and the job reads every column of every file.",
      resources: [
        { title: "polars crate: lazy frames, expressions and IO", url: "https://docs.rs/polars/latest/polars/", kind: "docs" },
        { title: "ParquetWriter: compression, statistics and row-group size", url: "https://docs.rs/polars/latest/polars/prelude/struct.ParquetWriter.html", kind: "docs" },
        { title: "Polars, the fastest dataframe library you never heard of (Ritchie Vink, PyData)", url: "https://www.youtube.com/watch?v=iwGIuGk5nCE", kind: "video" },
        { title: "pola-rs/polars: query engine and dataframe library", url: "https://github.com/pola-rs/polars", kind: "repo" }
      ]
    },
    {
      id: "m08",
      title: "Lakehouse: table commits over object storage",
      minutes: 105,
      level: "advanced",
      goal: "Explain why a lake needs a table protocol, then implement a snapshot commit with conditional writes that readers can never catch half-applied.",
      sections: [
        {
          h: "Object stores are not filesystems",
          p: [
            "An object store offers PUT, GET, LIST and DELETE on immutable objects. There is no rename, no directory, and no atomic multi-object operation: writing a hundred files makes a hundred independent commits. S3 has been strongly consistent for reads after writes since 2020, but consistency is not atomicity - a reader listing the prefix can still observe thirty of the hundred new files.",
            "A data lake therefore needs a protocol layered on top. The table format writes data files first, then commits a single metadata object that lists them. Readers resolve the current metadata object and see either the previous snapshot or the new one, never a mixture. This is what turns a pile of Parquet into a table with atomic append, schema and time travel."
          ],
          list: [
            "Data files are immutable; a change is a new file, never an edit in place",
            "A commit is one new metadata object plus a pointer that readers resolve first",
            "Listing a prefix is not a snapshot: it includes half-written and orphaned files",
            "Garbage collection must run after commit, with a retention margin"
          ],
          tip: "Never let a reader reconstruct a table by listing. Listing is for maintenance jobs that already know which snapshot they are repairing."
        },
        {
          h: "A snapshot is a manifest, and time travel is reading an old one",
          p: [
            "In both Delta Lake and Apache Iceberg the committed metadata contains the snapshot's file list, its schema and its partitioning, plus delete files or tombstones where rows were removed. Iceberg keeps a snapshot log and manifest lists; Delta keeps a transaction log of JSON commits with checkpoints. Either way, a query resolves one snapshot id and reads exactly the files that snapshot names.",
            "That indirection buys the properties people actually want: a failed job leaves orphan files instead of corrupt data, two writers conflict at the commit instead of interleaving, and an audit can ask what the table looked like at a timestamp. The cost is a metadata read on every query and a maintenance obligation - expired snapshots, orphan files and small files all need jobs."
          ],
          code: `use object_store::path::Path;
use object_store::{ObjectStore, PutMode, PutOptions, PutPayload, UpdateVersion};
use std::sync::Arc;

#[derive(serde::Serialize)]
pub struct Commit {
    pub snapshot: u64,
    pub files: Vec<String>,
    pub parent: Option<u64>,
}

/// Two-step commit: write an immutable snapshot, then swap CURRENT with a
/// compare-and-swap so exactly one writer wins. Losers retry against CAS.
pub async fn commit(
    store: Arc<dyn ObjectStore>,
    snapshot: Commit,
) -> Result<u64, Box<dyn std::error::Error>> {
    let body = serde_json::to_vec(&snapshot)?;
    let manifest = Path::from(format!("table/_snapshots/{:020}.json", snapshot.snapshot));

    // Step 1: the manifest must be new. A retry that already wrote it is a conflict.
    match store
        .put_opts(&manifest, PutPayload::from(body), PutOptions { mode: PutMode::Create, ..Default::default() })
        .await
    {
        Ok(_) => {}
        Err(object_store::Error::AlreadyExists { .. }) => {}
        Err(e) => return Err(e.into()),
    }

    // Step 2: swap the pointer only if it still holds the version we read.
    let current = Path::from("table/CURRENT");
    let pointer = match store.get(&current).await {
        Ok(existing) => PutOptions {
            mode: PutMode::Update(UpdateVersion {
                e_tag: existing.meta.e_tag.clone(),
                version: existing.meta.version.clone(),
            }),
            ..Default::default()
        },
        // First commit: the pointer does not exist yet.
        Err(object_store::Error::NotFound { .. }) => {
            PutOptions { mode: PutMode::Create, ..Default::default() }
        }
        Err(e) => return Err(e.into()),
    };
    store
        .put_opts(&current, PutPayload::from(snapshot.snapshot.to_string()), pointer)
        .await?;
    Ok(snapshot.snapshot)
}`,
          tip: "Map a failed conditional put to a retry with re-read metadata, not to a fatal error. Two concurrent commits are normal in a lake; losing data is not."
        },
        {
          h: "Do not build a table format by accident",
          p: [
            "The commit above is the shape of the protocol, not a substitute for one. Real formats add conflict detection per partition, schema and partition-spec evolution, delete files, statistics in manifests, snapshot retention and cross-language readers. Writing those yourself is a multi-quarter project, and the failure modes are the ones that lose data quietly.",
            "The practical rule: use Delta or Iceberg through an existing crate, and reserve hand-rolled manifests for internal caches and derived artifacts where a lost snapshot costs a rebuild rather than an audit finding. If you hand-roll, at least keep the two invariants - immutable data files and a single compare-and-swap pointer - because they are what make recovery possible."
          ],
          tip: "Test the commit under contention with two writers and a forced failure between the manifest write and the pointer swap; the table must still read correctly afterwards."
        }
      ],
      exercise: {
        prompt: "Implement load_snapshot so it reads CURRENT, then the referenced manifest, and returns the file list - treating a missing pointer as an empty table rather than an error.",
        starter: `use std::sync::Arc;
use object_store::{ObjectStore, path::Path};

pub struct Snapshot { pub snapshot: u64, pub files: Vec<String> }

pub async fn load_snapshot(store: Arc<dyn ObjectStore>) -> Result<Snapshot, Box<dyn std::error::Error>> {
    // 1. get table/CURRENT; NotFound means empty table (snapshot 0)
    // 2. parse the snapshot number
    // 3. get table/_snapshots/{number:020}.json and deserialize
    todo!()
}`,
        hint: "Match on object_store::Error::NotFound to return an empty snapshot. Read bytes with store.get(&path).await?.bytes().await? and parse with serde_json.",
        solution: `use std::sync::Arc;
use object_store::{ObjectStore, path::Path};

pub struct Snapshot { pub snapshot: u64, pub files: Vec<String> }

pub async fn load_snapshot(store: Arc<dyn ObjectStore>) -> Result<Snapshot, Box<dyn std::error::Error>> {
    let current = Path::from("table/CURRENT");
    let number = match store.get(&current).await {
        Ok(result) => String::from_utf8(result.bytes().await?.to_vec())?.trim().parse::<u64>()?,
        Err(object_store::Error::NotFound { .. }) => {
            return Ok(Snapshot { snapshot: 0, files: Vec::new() });
        }
        Err(e) => return Err(e.into()),
    };

    let manifest = Path::from(format!("table/_snapshots/{number:020}.json"));
    let bytes = store.get(&manifest).await?.bytes().await?;
    let snapshot: Snapshot = serde_json::from_slice(&bytes)?;
    Ok(snapshot)
}`
      },
      questions: [
        {
          q: "Why can a reader not rebuild a table snapshot by listing the data prefix?",
          options: [
            "LIST is eventually consistent on every object store",
            "The listing includes files from failed or in-flight commits, because there is no atomic multi-object write",
            "Listing returns objects in random order",
            "Object keys are hashed and cannot be ordered"
          ],
          answer: 1,
          explain: "A listing reflects objects that exist, not a committed set. Half-written files from a failed job, and files from a concurrent commit, appear in the prefix; only the committed manifest defines the snapshot."
        },
        {
          q: "What does the compare-and-swap on the pointer protect against?",
          options: [
            "Two writers silently replacing each other's snapshots",
            "Readers seeing a partially written data file",
            "Compression failures",
            "Orphan files accumulating"
          ],
          answer: 0,
          explain: "Without the conditional update, two commits that both read snapshot N produce two snapshot N+1s, and the later write wins - dropping the other writer's files. The CAS forces one to retry against fresh metadata."
        },
        {
          q: "A job fails after writing 40 data files and before the pointer swap. What is the state of the table?",
          options: [
            "Corrupt, because the files are unreferenced",
            "Unchanged, with 40 orphan files that garbage collection will remove",
            "Partially updated with 40 rows",
            "Locked until a manual repair"
          ],
          answer: 1,
          explain: "Data files carry no authority until a manifest names them. The table still resolves to the previous snapshot; the orphans are a storage cost, cleaned up by a retention job."
        }
      ],
      quickbytes: [
        "Write data files first, commit one manifest, then swap a pointer with compare-and-swap.",
        "Listing a prefix is not a snapshot; it includes orphans and in-flight files.",
        "Use Delta or Iceberg via their crates for real tables; hand-roll only for derived caches.",
        "Every snapshot protocol needs orphan cleanup and snapshot expiry, or storage grows forever."
      ],
      production: [
        "Readers resolve a snapshot id and never enumerate the data prefix directly.",
        "Commit conflicts are retried with fresh metadata, bounded by an attempt limit and counted in metrics.",
        "Orphan and expired-snapshot collection runs on a schedule with a retention margin longer than the longest job.",
        "A contention test with two concurrent writers runs in CI against an in-memory object store."
      ],
      crates: ["object_store", "tokio", "serde_json", "uuid"],
      github: [
        { name: "delta-io/delta-rs", url: "https://github.com/delta-io/delta-rs" },
        { name: "apache/iceberg-rust", url: "https://github.com/apache/iceberg-rust" }
      ],
      pitfall: "Making the pointer write unconditional: two jobs that both read snapshot 41 both publish snapshot 42, and one job's files vanish from the table with no error anywhere.",
      resources: [
        { title: "object_store: conditional puts, PutMode and update versions", url: "https://docs.rs/object_store/latest/object_store/", kind: "docs" },
        { title: "The Data Lakehouse: data warehousing and more (arXiv)", url: "https://arxiv.org/abs/2310.08697", kind: "paper" },
        { title: "delta-io/delta-rs: Delta Lake transactions in Rust", url: "https://github.com/delta-io/delta-rs", kind: "repo" },
        { title: "Data lakehouses explained: architecture and trade-offs (IBM Technology)", url: "https://www.youtube.com/watch?v=Enu-EH7RHHM", kind: "video" }
      ]
    },
    {
      id: "m09",
      title: "Change data capture: reading the write-ahead log",
      minutes: 100,
      level: "advanced",
      goal: "Parse a Debezium-style CDC envelope, apply changes in log order, and make the apply step idempotent against redelivery and snapshots.",
      sections: [
        {
          h: "Snapshot, then tail the log",
          p: [
            "Log-based CDC reads the database's own replication stream rather than polling tables. Postgres logical decoding streams committed changes with a log sequence number; MySQL and MongoDB offer equivalents. The pipeline first takes a consistent snapshot of the table at a known position, then tails changes after that position, so the snapshot and the stream join without a gap.",
            "The hard part is not the wire format, it is the cutover. A plain snapshot takes minutes, and rows change while it runs, so the stream position must be captured before or during the snapshot and every change replayed after it. Netflix's DBLog describes the alternative used when a global lock is unacceptable: a low watermark plus per-table progress, so the snapshot proceeds in chunks while log events buffer.",
            "The consumer of this data does not see a database; it sees an ordered sequence of row images with log positions attached. Reconstructing state means applying those images in position order, ignoring an image older than what was already applied, and emitting a tombstone for a row that no longer exists. Every CDC consumer is a fold over that sequence, and the log position is its index."
          ],
          list: [
            "The snapshot defines a starting position; the log defines everything after it",
            "Never take the snapshot without recording the corresponding log position",
            "A long transaction appears as one event at commit time, not when it started",
            "Schema changes arrive as events too, and must not silently desynchronize the parser"
          ],
          tip: "Store the source log position with every landed batch. Without it, a replay cannot prove where it restarted and a gap looks like a quiet period."
        },
        {
          h: "The envelope is the contract",
          p: [
            "Debezium wraps each change in a JSON envelope with before and after images, an op code, a source block carrying the log position, and a timestamp. The op codes are c for create, u for update, d for delete, and r for a snapshot read. Updates carry both images, which is what lets a consumer derive a diff without re-reading the row; deletes carry only before, and a delete with a null value is a tombstone for compacted topics.",
            "Treat this envelope as an external contract. It is generated by a connector you do not control, it changes between connector versions, and it is the one place where an upstream database's types become bytes. Parse into a typed struct with explicit optional fields rather than indexing into serde_json::Value, so a new field is ignored and a missing one fails loudly at the boundary."
          ],
          code: `use serde::Deserialize;
use std::collections::HashMap;

#[derive(Debug, Deserialize)]
pub struct Envelope { pub op: String, pub before: Option<Row>, pub after: Option<Row>, pub source: Source }

#[derive(Debug, Deserialize)]
pub struct Row { pub id: i64, pub status: String, pub amount_minor: i64 }

#[derive(Debug, Deserialize)]
pub struct Source { pub lsn: Option<u64>, pub pos: Option<u64>, pub table: String }

#[derive(Debug, Clone, PartialEq)]
pub struct Applied { pub id: i64, pub status: String, pub amount_minor: i64, pub position: u64 }

/// Apply in log order. The stored position makes a redelivery a no-op even
/// when the event is the same one the previous attempt already applied.
pub fn apply(
    state: &mut HashMap<i64, Applied>,
    envelope: &Envelope,
) -> Result<Option<Applied>, String> {
    let position = envelope.source.lsn.or(envelope.source.pos).ok_or("missing log position")?;

    // Either image may carry the key; a delete has only a before image.
    let id = envelope
        .after
        .as_ref()
        .or(envelope.before.as_ref())
        .map(|row| row.id)
        .ok_or("envelope has neither before nor after")?;

    if state.get(&id).map(|current| current.position >= position).unwrap_or(false) {
        return Ok(None);
    }

    match envelope.op.as_str() {
        "d" => {
            state.remove(&id);
            Ok(None)
        }
        "c" | "u" | "r" => {
            let row = envelope.after.as_ref().ok_or("op without an after image")?;
            let applied = Applied {
                id,
                status: row.status.clone(),
                amount_minor: row.amount_minor,
                position,
            };
            state.insert(id, applied.clone());
            Ok(Some(applied))
        }
        other => Err(format!("unknown op {other}")),
    }
}`,
          tip: "The op code is not a type: r (snapshot read) still carries an after image and must be applied exactly like c, or the initial load is silently skipped."
        },
        {
          h: "Deletes, tombstones and out-of-order applies",
          p: [
            "Kafka guarantees order within a partition, so keying CDC events by primary key keeps every change for one row in order. Across partitions there is no order, which breaks any transformation that needs two rows together - a foreign key change and the row that references it will race. Fact tables that must be joined are better assembled downstream by a batch job than by a streaming join across keys.",
            "Deletes need a decision the source never makes for you: hard delete, soft delete with a deleted_at, or a tombstone that removes the row from the current view while the history table keeps it. Whichever you choose, the tombstone must be produced exactly once per key, because a compacted topic keeps only the last one and a re-sent tombstone can remove a row that was later recreated.",
            "Idempotency comes from the position, not from the payload. Comparing the stored log position before an apply makes a redelivered event a no-op, and it also protects the snapshot path when a connector restarts from an earlier position. Two rows with identical contents at different positions are different facts, so payload equality is not a substitute for position comparison."
          ],
          tip: "Test with the same event applied twice, and with an older event applied after a newer one. Those two cases are the entire failure surface of a CDC consumer."
        }
      ],
      exercise: {
        prompt: "Add deduplication to the apply function so that replaying the same envelope twice leaves state unchanged, and an out-of-order older update is dropped and counted.",
        starter: `use std::collections::HashMap;

pub struct Applied { pub id: i64, pub amount_minor: i64, pub position: u64 }

pub struct Store {
    pub rows: HashMap<i64, Applied>,
    pub stale_dropped: u64,
}

impl Store {
    pub fn apply(&mut self, id: i64, amount_minor: i64, position: u64) -> bool {
        // 1. return false when the stored position is >= position
        // 2. count the drop in stale_dropped
        // 3. otherwise insert and return true
        todo!()
    }
}`,
        hint: "Compare positions before writing: if self.rows.get(&id) has a position greater than or equal to the incoming one, the event is a duplicate or an old replay. Increment stale_dropped and return false.",
        solution: `use std::collections::HashMap;

pub struct Applied { pub id: i64, pub amount_minor: i64, pub position: u64 }

pub struct Store {
    pub rows: HashMap<i64, Applied>,
    pub stale_dropped: u64,
}

impl Store {
    pub fn apply(&mut self, id: i64, amount_minor: i64, position: u64) -> bool {
        if let Some(current) = self.rows.get(&id) {
            if current.position >= position {
                self.stale_dropped += 1;
                return false;
            }
        }
        self.rows.insert(id, Applied { id, amount_minor, position });
        true
    }
}`
      },
      questions: [
        {
          q: "Why must the snapshot record a log position?",
          options: [
            "To detect schema changes during the snapshot",
            "So changes after that position can be replayed without duplicating or skipping rows",
            "Because Kafka requires an offset to publish",
            "To compress the snapshot output"
          ],
          answer: 1,
          explain: "The snapshot and the log are two sources. The position is the seam: everything at or before it is in the snapshot, everything after it is streamed. Without it the seam is a guess, and gaps appear as missing rows."
        },
        {
          q: "What does op = r mean in a Debezium envelope?",
          options: [
            "The row was removed",
            "The event is a snapshot read and must be applied like an insert",
            "The event is a retry and should be skipped",
            "The row was renamed"
          ],
          answer: 1,
          explain: "Snapshot reads carry a full after image with the source position at which the snapshot was taken. Treating r as unknown drops the entire initial load, which surfaces much later as a table that is missing older rows."
        },
        {
          q: "CDC events are keyed by primary key and spread over 12 partitions. Which operation is unsafe as a streaming join?",
          options: [
            "Deduplicating a single row by position",
            "Joining an order change with its line-item changes, which are keyed by different ids",
            "Filtering delete events",
            "Counting events per key"
          ],
          answer: 1,
          explain: "Ordering is guaranteed only within a partition, and different keys land in different partitions. Joining two keys in the stream races, which is why cross-entity assembly is usually batched downstream."
        }
      ],
      quickbytes: [
        "Snapshot plus log position is the only seam that neither duplicates nor skips.",
        "Treat op = r as an insert: it is the initial load, not a retry.",
        "Dedupe on the source log position, not on payload equality.",
        "Key by primary key so every change to one row stays ordered in one partition."
      ],
      production: [
        "Every landed batch stores the source log position it covers, and a gap check alerts when positions jump.",
        "Connector schema changes are monitored, and the parser fails closed on an unknown op code.",
        "Delete semantics are documented per table: hard delete, soft delete, or tombstone plus history.",
        "A replay test applies an event twice and an older event after a newer one, asserting state is unchanged."
      ],
      crates: ["serde", "serde_json", "tokio"],
      github: [
        { name: "debezium/debezium", url: "https://github.com/debezium/debezium" }
      ],
      pitfall: "Parsing the envelope by indexing into serde_json::Value: a connector upgrade renames a field, the index returns null, and the pipeline writes empty rows for a week without an error.",
      resources: [
        { title: "DBLog: a watermark based change-data-capture framework (arXiv)", url: "https://arxiv.org/abs/2010.12597", kind: "paper" },
        { title: "PostgreSQL logical decoding: how the replication stream is produced", url: "https://www.postgresql.org/docs/current/logicaldecoding-explanation.html", kind: "docs" },
        { title: "debezium/debezium: the connector that produces these envelopes", url: "https://github.com/debezium/debezium", kind: "repo" },
        { title: "Change data capture explained: Debezium, MySQL, Kafka", url: "https://www.youtube.com/watch?v=dN_11nBcv_A", kind: "video" }
      ]
    },
    {
      id: "m10",
      title: "Orchestration: DAGs, leases and idempotent tasks",
      minutes: 95,
      level: "advanced",
      goal: "Run a dependency graph where every task is safe under at-least-once scheduling, and only one instance owns a task at a time.",
      sections: [
        {
          h: "A scheduler is a control plane",
          p: [
            "An orchestrator decides what should run, when, and with which inputs. It should not move data through itself: if a task's payload passes through the scheduler's database, the scheduler becomes the bottleneck and the failure domain for everything. Airflow, Dagster and a cron-driven Rust binary all follow the same model - they trigger work, record outcomes, and retry.",
            "The graph matters more than the tool. A DAG encodes which tasks may run in parallel and which must wait, and a task should declare its inputs (a partition, a snapshot id) rather than read whatever is newest. Declared inputs make a run reproducible: the same logical date produces the same output, whether it runs at 02:00 today or during a backfill next month."
          ],
          list: [
            "Tasks declare inputs and outputs; the scheduler never infers them from wall-clock time",
            "A retry re-runs the same logical partition, not the next one",
            "Scheduling metadata lives in a durable store, not in process memory",
            "Alerting belongs to the scheduler; data correctness belongs to the task"
          ],
          tip: "Give every task an idempotency key: pipeline, partition and code version. A retry with the same key is safe by construction."
        },
        {
          h: "At-least-once scheduling is the default",
          p: [
            "Schedulers fail in the middle of a run and retry, so every task must assume it may execute twice, possibly concurrently. In-process locking does not help across replicas: two scheduler instances both believe they own the 02:00 run. A lease in the shared store does, provided the lease has an expiry and the work checks it still owns the lease before committing.",
            "A fencing token closes the remaining hole. The lease holder increments a counter; the sink rejects writes carrying a token older than the last one it accepted. Without fencing, a paused process that resumes after its lease expired can still write, and the new owner's work is silently overwritten.",
            "The cheap version is to make every write idempotent and to skip leases entirely for work that is inexpensive to redo. Reserve leases and fencing tokens for tasks whose duplication causes visible damage: a payment run, an overwrite of a curated partition, a notification batch. That keeps the coordination surface small and the common path simple."
          ],
          code: `use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Debug, PartialEq, Eq)]
pub enum Claim { Acquired { token: u64 }, Busy, Expired }

pub struct Lease { owner: String, token: u64, expires_at: Instant }

/// A single-writer lease with a monotonically increasing fencing token.
pub struct LeaseTable {
    entries: HashMap<String, Lease>,
    next_token: u64,
}

impl LeaseTable {
    pub fn acquire(&mut self, task: &str, owner: &str, ttl: Duration) -> Claim {
        let now = Instant::now();
        let held = matches!(
            self.entries.get(task),
            Some(lease) if lease.expires_at > now && lease.owner != owner
        );
        if held {
            return Claim::Busy;
        }

        self.next_token += 1;
        self.entries.insert(
            task.to_string(),
            Lease { owner: owner.to_string(), token: self.next_token, expires_at: now + ttl },
        );
        Claim::Acquired { token: self.next_token }
    }

    /// The sink rejects any token older than the newest one it has seen.
    pub fn check(&self, task: &str, token: u64) -> Claim {
        match self.entries.get(task) {
            Some(lease) if lease.token == token && lease.expires_at > Instant::now() => {
                Claim::Acquired { token }
            }
            Some(_) => Claim::Expired,
            None => Claim::Expired,
        }
    }
}`,
          tip: "Lease TTL must exceed the p99 task duration, or a healthy task loses its lease while still working and two workers overlap."
        },
        {
          h: "Cron is a syntax, not a schedule",
          p: [
            "Cron expressions describe local wall-clock times, which means daylight saving creates two failures a year: a skipped run at the spring-forward hour and a duplicated run at the fall-back hour. A pipeline that must run exactly hourly should be scheduled from a monotonic cadence and labelled with the UTC hour it covers, not from a five-field expression evaluated in local time.",
            "Catchup is the other trap. When a scheduler starts after downtime, it can either run every missed interval or skip to the latest. Running all of them is correct for a pipeline with a backfill-safe task and disastrous for one that sends a daily email to every customer. Make catchup an explicit per-pipeline setting, and cap the number of intervals a single restart may trigger."
          ],
          list: [
            "Schedule in UTC, label partitions in UTC, display in local time only in the UI",
            "Catchup policy is per pipeline: all missed intervals, latest only, or none",
            "A missed run must be detectable from data freshness, not from a scheduler log",
            "DST transitions need a test, not a comment"
          ],
          tip: "The cron crate takes six or seven fields - seconds first. A five-field expression copied from crontab silently fails to parse."
        }
      ],
      exercise: {
        prompt: "Write a topological runner: given tasks with dependencies, run every task exactly once after its dependencies succeed, retry a failed task twice, and refuse to start when the graph has a cycle.",
        starter: `use std::collections::{HashMap, HashSet};

pub struct Task { pub name: String, pub deps: Vec<String> }

pub fn order(tasks: &[Task]) -> Result<Vec<String>, String> {
    // 1. build indegree and an adjacency map
    // 2. repeatedly take nodes with indegree zero
    // 3. if fewer nodes are emitted than exist, report a cycle
    todo!()
}`,
        hint: "Kahn's algorithm: count incoming edges, queue the zero-indegree nodes, and decrement neighbours as you emit. The emitted count equals the task count only when the graph is acyclic.",
        solution: `use std::collections::{BTreeMap, HashMap, VecDeque};

pub struct Task { pub name: String, pub deps: Vec<String> }

pub fn order(tasks: &[Task]) -> Result<Vec<String>, String> {
    let mut indegree: HashMap<&str, usize> = HashMap::new();
    let mut dependents: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    let mut by_name: HashMap<&str, &Task> = HashMap::new();

    for task in tasks {
        by_name.insert(task.name.as_str(), task);
        indegree.entry(task.name.as_str()).or_insert(0);
    }

    for task in tasks {
        for dep in &task.deps {
            if !by_name.contains_key(dep.as_str()) {
                return Err(format!("{} depends on unknown {}", task.name, dep));
            }
            *indegree.get_mut(task.name.as_str()).unwrap() += 1;
            dependents.entry(dep.as_str()).or_default().push(task.name.as_str());
        }
    }

    let mut ready: VecDeque<&str> = indegree
        .iter()
        .filter(|(_, degree)| **degree == 0)
        .map(|(name, _)| *name)
        .collect();

    let mut order = Vec::with_capacity(tasks.len());
    while let Some(name) = ready.pop_front() {
        order.push(name.to_string());
        for dependent in dependents.get(name).cloned().unwrap_or_default() {
            let degree = indegree.get_mut(dependent).unwrap();
            *degree -= 1;
            if *degree == 0 {
                ready.push_back(dependent);
            }
        }
    }

    if order.len() != tasks.len() {
        return Err("dependency cycle detected".to_string());
    }
    Ok(order)
}`
      },
      questions: [
        {
          q: "Why is an in-process mutex insufficient to prevent two scheduler replicas running the same task?",
          options: [
            "Mutexes are not Send across await points",
            "The replicas are separate processes, so each mutex only excludes its own threads",
            "The scheduler holds the mutex only while parsing the DAG",
            "Tokio does not support mutexes with timeouts"
          ],
          answer: 1,
          explain: "Mutual exclusion has to live where both replicas can see it - the shared metadata store - with an expiry so a crashed owner does not block the task forever."
        },
        {
          q: "What does a fencing token add beyond a lease?",
          options: [
            "It shortens the lease TTL",
            "It lets the sink reject writes from a worker whose lease already expired",
            "It makes the lease renewable indefinitely",
            "It orders tasks in the DAG"
          ],
          answer: 1,
          explain: "A lease expires by time, but the old owner may still be running. A monotonically increasing token carried into the write lets the sink discard stale owners, closing the overlap window."
        },
        {
          q: "A daily pipeline is scheduled at 02:30 local time. What happens on the spring-forward day in a DST zone?",
          options: [
            "It runs twice",
            "That local time does not exist, so the run is skipped unless the scheduler handles it",
            "It runs at 01:30",
            "Nothing differs; cron is always UTC"
          ],
          answer: 1,
          explain: "Cron evaluates wall-clock time, and 02:30 can be skipped entirely. Scheduling in UTC and labelling partitions in UTC removes the class of bug; local time belongs in the display layer only."
        }
      ],
      quickbytes: [
        "The scheduler triggers work; it must never carry the data path.",
        "Every task must be safe to run twice: idempotency key = pipeline + partition + code version.",
        "Leases need a TTL above p99 duration; fencing tokens close the overlap window.",
        "Schedule in UTC, and make catchup an explicit per-pipeline policy."
      ],
      production: [
        "Scheduling state lives in a durable store with a lease expiry, not in memory, so a replica restart does not double-run.",
        "Every task declares its input partitions explicitly and tolerates being retried.",
        "Catchup behaviour is configured per pipeline and capped in the number of intervals per restart.",
        "A cycle check runs when the DAG is loaded, and a malformed graph fails before any task starts."
      ],
      crates: ["tokio", "cron", "chrono", "tracing"],
      github: [
        { name: "apache/airflow", url: "https://github.com/apache/airflow" }
      ],
      pitfall: "Relying on a scheduler's retry as the error handler: a task that appends on each attempt doubles the day's revenue, and the retry that caused it is reported as a success.",
      resources: [
        { title: "Kubernetes CronJob: schedules, missed runs and concurrency policy", url: "https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/", kind: "docs" },
        { title: "cron crate: six-field expressions with seconds", url: "https://docs.rs/cron/latest/cron/", kind: "docs" },
        { title: "In search of an understandable consensus algorithm (Raft)", url: "https://raft.github.io/raft.pdf", kind: "paper" },
        { title: "apache/airflow: DAG scheduling semantics to learn from", url: "https://github.com/apache/airflow", kind: "repo" }
      ]
    },
    {
      id: "m11",
      title: "Data quality checks that fail loudly",
      minutes: 90,
      level: "industry",
      goal: "Write schema, null, uniqueness, freshness and volume checks with severities, then decide per check whether to quarantine rows or fail the run.",
      sections: [
        {
          h: "Four check families cover most incidents",
          p: [
            "Schema checks confirm the columns and types you expect, including nullability. Null and domain checks confirm that a required field is present and that a status is one of the known values. Uniqueness checks confirm the grain: one row per order, not one per order-line silently fanning out a join. Freshness and volume checks confirm the table is moving at all, and they catch the outage class that the first three miss entirely.",
            "Each check needs a severity, because not every anomaly should stop a pipeline. A blocking check is a contract violation - a missing primary key column, a null in a not-null field - and the run must fail before publishing. A warning check is a distribution shift that should page a human but not stall the downstream table, since a stalled table is usually worse than a slightly odd one."
          ],
          list: [
            "Blocking: schema drift, null in a required column, duplicate primary keys",
            "Warning: volume below the trailing median, unexpected category values, skew",
            "Report-only: new-but-allowed enum value, a column whose null rate doubled",
            "A check that cannot fail is documentation, not a check - assert on a failing fixture"
          ],
          tip: "Write every check against a deliberately broken fixture first. If the check passes on the broken fixture, it will pass in production when everything is broken."
        },
        {
          h: "Freshness and volume catch the silent failures",
          p: [
            "A job that runs successfully and writes zero rows is the most common serious incident in a data platform: every task is green, the dashboard is flat, and the cause is an upstream filter that started returning nothing. Row-count checks against a trailing baseline catch it, and a freshness check on the maximum event timestamp catches the variant where rows arrive but stop advancing.",
            "Compare with a robust baseline, not a mean. A seven-day median with a tolerance band handles weekends and holidays better than a fixed threshold, and a day-of-week comparison handles them better still. When volume drops, the run should record the count, the baseline and the ratio, so the incident review starts with numbers instead of a screenshot."
          ],
          code: `use arrow::array::{Array, Int64Array, StringArray};
use arrow::record_batch::RecordBatch;
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity { Blocking, Warning }

#[derive(Debug)]
pub struct Finding {
    pub check: &'static str,
    pub severity: Severity,
    pub detail: String,
}

/// Uniqueness on the table grain: duplicates mean a join fanned out.
pub fn check_unique(batch: &RecordBatch, column: usize) -> Option<Finding> {
    let ids = batch.column(column).as_any().downcast_ref::<StringArray>()?;
    let mut seen = HashSet::with_capacity(batch.num_rows());
    let mut duplicates = 0usize;
    for value in ids.iter().flatten() {
        if !seen.insert(value) {
            duplicates += 1;
        }
    }
    (duplicates > 0).then(|| Finding {
        check: "order_id_unique",
        severity: Severity::Blocking,
        detail: format!("{duplicates} duplicate order_id values in {} rows", batch.num_rows()),
    })
}

/// Null rate on a column that must always be present.
pub fn check_no_nulls(batch: &RecordBatch, column: usize, name: &'static str) -> Option<Finding> {
    let nulls = batch.column(column).null_count();
    (nulls > 0).then(|| Finding {
        check: name,
        severity: Severity::Blocking,
        detail: format!("{nulls} nulls in {} rows", batch.num_rows()),
    })
}

/// Freshness: the newest event must be within the allowed lag.
pub fn check_freshness(batch: &RecordBatch, column: usize, now_ms: i64, max_lag_ms: i64) -> Option<Finding> {
    let ts = batch.column(column).as_any().downcast_ref::<Int64Array>()?;
    let newest = ts.iter().flatten().max()?;
    let lag = now_ms - newest;
    (lag > max_lag_ms).then(|| Finding {
        check: "event_freshness",
        severity: Severity::Warning,
        detail: format!("newest event is {lag} ms old, budget {max_lag_ms} ms"),
    })
}`,
          tip: "Return findings instead of panicking inside checks. The run decides what to do with them, and the same check can be a warning in staging and blocking in production."
        },
        {
          h: "Quarantine beats dropping",
          p: [
            "Rows that fail a non-blocking check have two possible destinations: the run fails, or the rows are written to a quarantine table with the reason attached. Quarantine keeps the good rows moving and preserves the bad ones for repair, which is usually what a business wants at 09:00 on a Monday. Dropping them silently is the one option with no recovery path.",
            "Gate the publish on blocking checks only, and publish the quarantine count as a metric with the failing check name. A quarantine table that grows every day is a contract problem to fix at the source, and it is invisible unless someone charts it. The check framework's job is to make the number impossible to ignore."
          ],
          tip: "Store the check name, run id and source position with each quarantined row. Without the position, repairing means replaying everything to find it again."
        }
      ],
      exercise: {
        prompt: "Implement a check registry that runs all checks over a batch, returns the findings, and decides publish eligibility: no blocking findings, plus a quarantine rate under one percent.",
        starter: `use arrow::record_batch::RecordBatch;

pub struct Finding { pub check: String, pub blocking: bool, pub detail: String }

pub struct Verdict { pub publish: bool, pub findings: Vec<Finding>, pub quarantine_rate: f64 }

pub fn evaluate(
    batch: &RecordBatch,
    findings: Vec<Finding>,
    quarantined_rows: usize,
) -> Verdict {
    // 1. publish only when no finding is blocking
    // 2. and the quarantine rate is under 1 percent
    todo!()
}`,
        hint: "quarantine_rate = quarantined_rows as f64 / batch.num_rows().max(1) as f64. Publish = !findings.iter().any(|f| f.blocking) && quarantine_rate < 0.01.",
        solution: `use arrow::record_batch::RecordBatch;

pub struct Finding { pub check: String, pub blocking: bool, pub detail: String }

pub struct Verdict { pub publish: bool, pub findings: Vec<Finding>, pub quarantine_rate: f64 }

pub fn evaluate(
    batch: &RecordBatch,
    findings: Vec<Finding>,
    quarantined_rows: usize,
) -> Verdict {
    let quarantine_rate = quarantined_rows as f64 / batch.num_rows().max(1) as f64;
    let blocking = findings.iter().any(|finding| finding.blocking);
    let publish = !blocking && quarantine_rate < 0.01;

    for finding in &findings {
        if finding.blocking {
            tracing::error!(check = %finding.check, detail = %finding.detail, "blocking check failed");
        } else {
            tracing::warn!(check = %finding.check, detail = %finding.detail, "check failed");
        }
    }

    Verdict { publish, findings, quarantine_rate }
}`
      },
      questions: [
        {
          q: "Which check most reliably catches a pipeline that runs green but writes no data?",
          options: [
            "Schema compatibility",
            "Row-count volume against a trailing baseline",
            "Uniqueness on the primary key",
            "A domain check on a status column"
          ],
          answer: 1,
          explain: "Zero rows satisfy uniqueness and domain checks vacuously, and a schema can be perfectly stable. Only a volume or freshness expectation notices that nothing arrived."
        },
        {
          q: "Why compare volume with a seven-day median rather than yesterday's count?",
          options: [
            "Medians are cheaper to compute",
            "Weekends and holidays create regular dips that a single previous day treats as an anomaly",
            "A median is immune to duplicates",
            "Yesterday's count is not available in the same batch"
          ],
          answer: 1,
          explain: "A robust baseline absorbs weekly seasonality. Comparing to the previous day generates a false page every Monday and trains the team to ignore the alert."
        },
        {
          q: "What is wrong with dropping rows that fail a warning-level check?",
          options: [
            "Nothing; dropping is the standard handling",
            "The rows are gone with no record, so the loss cannot be quantified or repaired",
            "It makes the batch smaller than the schema allows",
            "Arrow arrays require a fixed row count"
          ],
          answer: 1,
          explain: "Dropping converts a data quality problem into an unobservable data loss. Quarantine with the reason and source position keeps the option to repair."
        }
      ],
      quickbytes: [
        "Schema, null/domain, uniqueness, freshness/volume - four families, different failure modes.",
        "Only blocking checks should stop the publish; warnings page a human without stalling the table.",
        "Write the failing fixture first, or the check will pass on broken data.",
        "Quarantine with the reason and source position; never drop silently."
      ],
      production: [
        "Every check has a severity and a named owner, and blocking checks are covered by a deliberately failing fixture.",
        "Freshness is measured from the maximum event timestamp, not from the job's completion time.",
        "Volume is compared against a robust trailing baseline with a documented tolerance band.",
        "Quarantine rate and the failing check name are exported as metrics with an alert threshold."
      ],
      crates: ["arrow", "serde", "thiserror", "tracing"],
      github: [
        { name: "great-expectations/great_expectations", url: "https://github.com/great-expectations/great_expectations" },
        { name: "awslabs/deequ", url: "https://github.com/awslabs/deequ" }
      ],
      pitfall: "Checks written against healthy data only: the uniqueness check passes, the join is in fact fanning out, and nobody notices until the revenue number is twice the bank statement.",
      resources: [
        { title: "arrow crate: the arrays the checks read", url: "https://docs.rs/arrow/latest/arrow/", kind: "docs" },
        { title: "great-expectations: check semantics worth copying", url: "https://github.com/great-expectations/great_expectations", kind: "repo" },
        { title: "Testing data pipelines with Great Expectations", url: "https://www.youtube.com/watch?v=7UQ91Ib7PtU", kind: "video" },
        { title: "awslabs/deequ: data quality constraints at scale", url: "https://github.com/awslabs/deequ", kind: "repo" }
      ]
    },
    {
      id: "m12",
      title: "Data lineage: emitting OpenLineage events",
      minutes: 85,
      level: "industry",
      goal: "Emit OpenLineage run events for every job, join them by run id, and derive column-level lineage from the plan rather than from guesswork.",
      sections: [
        {
          h: "Lineage is an event stream, not a diagram",
          p: [
            "A lineage diagram drawn by hand is out of date the day it is committed. OpenLineage models lineage as events: a job starts, finishes or fails a run, and each event names the datasets it read and wrote. A collector stores the events, and the graph is a query over them. The graph is then always as current as the last run, because the runs produce it.",
            "The identity triple is job namespace, job name and run id. Runs are the unit of correlation: the same run id appears in the start event, the complete event, the metrics and any quality findings. Without it, a failed job's partial output cannot be tied to the process that produced it, and the graph shows a dataset that appeared from nowhere."
          ],
          list: [
            "eventType is START, COMPLETE, FAIL, ABORT or RUNNING - exactly one per state change",
            "job.namespace separates teams and environments; job.name is stable across deploys",
            "inputs and outputs carry namespace plus name, and optional facets",
            "run.runId must be a UUID generated per execution, not per schedule slot"
          ],
          tip: "Emit START before reading input and COMPLETE after the commit. A dataset that appears without a COMPLETE is a lineage signal that a run died mid-flight."
        },
        {
          h: "Emit at the edges, join on the run id",
          p: [
            "The producer of an event is the job itself, not a crawler that infers lineage afterwards. Emitting from inside the job means the event carries facts no crawler can know: row counts, the partition range actually processed, the query plan, byte sizes. It also means the event is emitted on the failure path, which is the path crawlers never see and operators care about most.",
            "Wrap emission so it can never fail the pipeline. Lineage is observability, and an observability backend outage must not stop a data job. Queue events in memory with a bounded buffer, drop with a counter when the buffer is full, and send them from a background task; the alternative is a pipeline that halts because a collector returned 503."
          ],
          code: `use chrono::Utc;
use serde::Serialize;
use uuid::Uuid;

#[derive(Serialize)]
pub struct Dataset { pub namespace: String, pub name: String }

#[derive(Serialize)]
pub struct Job { pub namespace: String, pub name: String }

#[derive(Serialize)]
pub struct RunRef { #[serde(rename = "runId")] pub run_id: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    pub event_type: &'static str,
    pub event_time: String,
    pub run: RunRef,
    pub job: Job,
    pub inputs: Vec<Dataset>,
    pub outputs: Vec<Dataset>,
}

pub fn start(job_namespace: &str, job_name: &str, run_id: Uuid, input: Dataset) -> RunEvent {
    RunEvent {
        event_type: "START",
        event_time: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        run: RunRef { run_id: run_id.to_string() },
        job: Job { namespace: job_namespace.to_string(), name: job_name.to_string() },
        inputs: vec![input],
        outputs: Vec::new(),
    }
}

pub fn complete(mut event: RunEvent, output: Dataset) -> RunEvent {
    event.event_type = "COMPLETE";
    event.event_time = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    event.outputs = vec![output];
    event
}`,
          tip: "Same run id in START and COMPLETE. A fresh UUID on the second event turns one run into two half-runs that never join."
        },
        {
          h: "Column-level lineage comes from the plan",
          p: [
            "Table-level lineage answers which job produced which table. Column-level lineage answers which source column produced the target column, and it can only be derived from a parsed query or a plan - not from naming conventions. Parse the SQL or read the Polars plan, map output expressions to input columns, and accept that a user-defined function is a black box you report as unresolved rather than invent.",
            "The payoff is impact analysis: before changing a column, ask which downstream datasets reference it. The cost is maintenance, because a parser that lags the SQL dialect reports false orphans. Treat column lineage as best-effort with an explicit unknown marker, and never let an incomplete mapping be presented as complete."
          ],
          tip: "Lineage is a join key across tools: the same namespace and dataset name must appear in your quality metrics and your cost attribution, or the three views disagree."
        }
      ],
      exercise: {
        prompt: "Add a fail path: build a FAIL event that reuses the run id from the START event, records the error message in a run facet, and never panics if serialization fails.",
        starter: `use chrono::Utc;
use uuid::Uuid;

pub struct Started { pub run_id: Uuid, pub job: String, pub inputs: Vec<String> }

pub struct Event { pub event_type: String, pub run_id: Uuid, pub job: String, pub error: Option<String> }

pub fn fail(started: &Started, error: &str) -> Option<String> {
    // 1. build the event with the same run id
    // 2. set the error facet
    // 3. serialize to JSON, returning None instead of panicking
    todo!()
}`,
        hint: "serde_json::to_string returns Result; map the error to None with .ok(). Reusing started.run_id is what makes the pair a single run.",
        solution: `use chrono::Utc;
use serde::Serialize;
use uuid::Uuid;

pub struct Started { pub run_id: Uuid, pub job: String, pub inputs: Vec<String> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorFacet { message: String, #[serde(rename = "_producer")] producer: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    event_type: &'static str,
    event_time: String,
    run_id: Uuid,
    job: String,
    inputs: Vec<String>,
    error: ErrorFacet,
}

pub fn fail(started: &Started, error: &str) -> Option<String> {
    let event = Event {
        event_type: "FAIL",
        event_time: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        run_id: started.run_id,
        job: started.job.clone(),
        inputs: started.inputs.clone(),
        error: ErrorFacet { message: error.to_string(), producer: "orders-silver".to_string() },
    };
    serde_json::to_string(&event).ok()
}`
      },
      questions: [
        {
          q: "What ties a START event to its COMPLETE event?",
          options: [
            "The job name only",
            "The run id generated for that execution",
            "The event timestamp",
            "The output dataset name"
          ],
          answer: 1,
          explain: "A job name repeats on every run, and timestamps are approximate. The run id is generated once per execution and appears in start, complete, fail and metrics events, which is what makes them one run."
        },
        {
          q: "Why is a crawler that infers lineage from completed tables insufficient?",
          options: [
            "It cannot see the schema",
            "It misses failed runs and the run-level facts, such as row counts and partitions actually processed",
            "It duplicates the collector",
            "It requires SQL parsing"
          ],
          answer: 1,
          explain: "Crawlers observe successful output only. Failed and half-written runs, plus run-scoped facts, are invisible to them, and those are exactly the runs a human needs to reconstruct."
        },
        {
          q: "The lineage collector is returning 503. What should the pipeline do?",
          options: [
            "Fail the run so lineage stays consistent",
            "Buffer a bounded number of events, drop with a counter, and continue the data work",
            "Retry in a blocking loop until the collector recovers",
            "Write events to the same table as the data"
          ],
          answer: 1,
          explain: "Lineage is observability: it must degrade, not halt. A bounded buffer with a drop counter keeps memory bounded and makes the gap measurable."
        }
      ],
      quickbytes: [
        "Lineage is events, not diagrams: START, COMPLETE, FAIL per run, keyed by run id.",
        "Emit from the job, on both success and failure paths; crawlers cannot see failures.",
        "Column-level lineage needs a parsed plan; report unresolved expressions explicitly.",
        "Never let lineage emission fail a data job - buffer, drop with a counter, and continue."
      ],
      production: [
        "Every job emits START and exactly one terminal event, with the same run id, including on error paths.",
        "Emission runs on a bounded queue in a background task, so a collector outage cannot stall the pipeline.",
        "Job names are stable across deploys and namespaces separate environment and team.",
        "Dataset names in lineage match the names used in quality metrics and cost attribution."
      ],
      crates: ["serde", "serde_json", "uuid", "chrono"],
      github: [
        { name: "OpenLineage/OpenLineage", url: "https://github.com/OpenLineage/OpenLineage" },
        { name: "MarquezProject/marquez", url: "https://github.com/MarquezProject/marquez" }
      ],
      pitfall: "Generating a new UUID when the run completes: the graph shows two half-runs, the output has no producer, and impact analysis reports no downstream consumers for the column you are about to rename.",
      resources: [
        { title: "OpenLineage specification: run, job and dataset events", url: "https://github.com/OpenLineage/OpenLineage/blob/main/spec/OpenLineage.md", kind: "docs" },
        { title: "OpenLineage/OpenLineage: spec and integrations", url: "https://github.com/OpenLineage/OpenLineage", kind: "repo" },
        { title: "Data lineage with OpenLineage and Airflow (Astronomer)", url: "https://www.youtube.com/watch?v=2s013GQy1Sw", kind: "video" },
        { title: "MarquezProject/marquez: metadata service for lineage", url: "https://github.com/MarquezProject/marquez", kind: "repo" }
      ]
    },
    {
      id: "m13",
      title: "Schema evolution: compatibility directions and field ids",
      minutes: 95,
      level: "industry",
      goal: "Classify a schema change as backward, forward or full compatible, and choose a format whose resolution rules make renames and additions safe.",
      sections: [
        {
          h: "Compatibility is a direction, not a badge",
          p: [
            "A schema change is backward compatible when a new reader can read old data, and forward compatible when an old reader can read new data. Adding an optional field with a default is both, because the new reader fills the default for old records and the old reader ignores a field it does not know. Removing a field that has a default is also both, for the same reason read in reverse.",
            "Breaking changes are the ones that change meaning without a default: adding a required field, removing one without a default, renaming without an alias, and narrowing a type. Widening int to long is usually safe because every int is a long; the reverse truncates. Registries encode these rules as a per-subject mode - BACKWARD, FORWARD, FULL or NONE - and reject a publish that violates the mode at write time rather than at 3 a.m. in a consumer."
          ],
          list: [
            "Add optional field with default: backward and forward compatible",
            "Remove field with default: compatible in both directions",
            "Rename: breaking unless the format supports aliases or field ids",
            "Narrow a type, or add a required field: breaking, always"
          ],
          tip: "Set the registry mode to FULL for topics with independent consumers, so no producer can publish a change only its own consumer tolerates."
        },
        {
          h: "Names break, ids do not",
          p: [
            "Avro resolves fields by name, so a rename looks like a removal plus an addition unless an alias is declared. Parquet and Iceberg store a numeric field id per column, so a rename is metadata: the id still points at the same column and readers keep resolving correctly. JSON has no schema at all, which means nothing is checked and every consumer discovers breakage at runtime.",
            "That difference decides where evolution is cheap. If downstream tables are Parquet managed by Iceberg or Delta, renames are a metadata update and old files stay valid. If the wire format is Avro without aliases, a rename is a coordinated deploy across every consumer. Pick the storage format for the evolution you expect, not only for the query performance you want today."
          ],
          code: `use apache_avro::{Reader, Schema, Writer};
use apache_avro::types::Value;

const V1: &str = r#"{
  "type": "record", "name": "Order", "namespace": "acme.orders",
  "fields": [
    {"name": "id", "type": "string"},
    {"name": "amount_minor", "type": "long"}
  ]
}"#;

const V2: &str = r#"{
  "type": "record", "name": "Order", "namespace": "acme.orders",
  "fields": [
    {"name": "id", "type": "string"},
    {"name": "amount_minor", "type": "long"},
    {"name": "currency", "type": "string", "default": "INR"}
  ]
}"#;

pub fn write_v2(rows: &[(String, i64)]) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let schema = Schema::parse_str(V2)?;
    let mut writer = Writer::new(&schema, Vec::new());
    for (id, amount) in rows {
        writer.append_value(Value::Record(vec![
            ("id".to_string(), Value::String(id.clone())),
            ("amount_minor".to_string(), Value::Long(*amount)),
            ("currency".to_string(), Value::String("INR".to_string())),
        ]))?;
    }
    Ok(writer.into_inner()?)
}

/// Read V2 data with the V1 reader schema: the default fills currency, so an
/// old consumer keeps working. Resolve to Value, not into_deser_iter.
pub fn read_as_v1(bytes: &[u8]) -> Result<usize, Box<dyn std::error::Error>> {
    let reader_schema = Schema::parse_str(V1)?;
    let reader = Reader::builder(bytes)
        .reader_schema(&reader_schema)
        .build()?;
    let mut count = 0;
    for value in reader {
        value?;
        count += 1;
    }
    Ok(count)
}`,
          tip: "apache-avro 0.22 documents reader_schema as incompatible with ReaderDeser: into_deser_iter panics when writer and reader schemas differ. Iterate Value when schemas differ."
        },
        {
          h: "Enforce at the boundary, test with real payloads",
          p: [
            "A compatibility mode is only as good as the payloads you test it with. A registry validates structural compatibility, but it cannot know that currency moved from minor units to major, or that a status enum gained a value your consumer's match statement treats as unreachable. Encode those expectations as tests that run against recorded production messages, including a message written by the previous schema version.",
            "Version the schema id into the message - Confluent's wire format prefixes a schema id - so a consumer can fetch the writer schema and resolve rather than guess. The alternative, storing a schema version only in the topic name, makes a mixed-version topic unreadable and forces a new topic for every change."
          ],
          list: [
            "Keep a fixture corpus of messages per schema version and run compatibility tests in CI",
            "Prefix the schema id in the payload; never infer it from the topic name",
            "Treat enum additions as breaking for exhaustive matches in Rust",
            "Record the writer schema id with each landed batch for future repair"
          ],
          tip: "A Rust enum built from a schema with four values will fail to deserialize a fifth, so an additive enum change is a deploy-ordering problem, not a free change."
        }
      ],
      exercise: {
        prompt: "Decide which of three changes to an Avro order schema are full-compatible, and prove one with a round trip: (a) add optional currency with default, (b) rename amount_minor to amount, (c) change amount from long to string.",
        starter: `// a) add {"name":"currency","type":"string","default":"INR"}
// b) rename amount_minor -> amount
// c) change amount_minor from "long" to "string"

pub fn classify(change: char) -> &'static str {
    match change {
        // 'a' => "full", 'b' => ..., 'c' => ...
        _ => todo!(),
    }
}

pub fn round_trip() -> Result<(), Box<dyn std::error::Error>> {
    // write with the new schema, read with the old one
    todo!()
}`,
        hint: "Only the added field with a default is full-compatible. A rename needs an alias to resolve by name; changing long to string is a type promotion Avro does not allow and every reader breaks.",
        solution: `use apache_avro::{Reader, Schema, Writer};
use apache_avro::types::Value;

const V1: &str = r#"{"type":"record","name":"Order","fields":[
  {"name":"id","type":"string"},{"name":"amount_minor","type":"long"}]}"#;

const V2: &str = r#"{"type":"record","name":"Order","fields":[
  {"name":"id","type":"string"},{"name":"amount_minor","type":"long"},
  {"name":"currency","type":"string","default":"INR"}]}"#;

pub fn classify(change: char) -> &'static str {
    match change {
        'a' => "full: new readers fill the default, old readers ignore the field",
        'b' => "breaking: names are the identity in Avro, add an alias to fix it",
        'c' => "breaking: long to string is not a permitted promotion",
        _ => "unknown",
    }
}

pub fn round_trip() -> Result<(), Box<dyn std::error::Error>> {
    let writer_schema = Schema::parse_str(V2)?;
    let mut writer = Writer::new(&writer_schema, Vec::new());
    writer.append_value(Value::Record(vec![
        ("id".to_string(), Value::String("o-1".to_string())),
        ("amount_minor".to_string(), Value::Long(1_200)),
        ("currency".to_string(), Value::String("INR".to_string())),
    ]))?;
    let bytes = writer.into_inner()?;

    let reader_schema = Schema::parse_str(V1)?;
    let reader = Reader::builder(bytes.as_slice()).reader_schema(&reader_schema).build()?;
    let values: Vec<Value> = reader.collect::<Result<_, _>>()?;
    assert_eq!(values.len(), 1);
    Ok(())
}`
      },
      questions: [
        {
          q: "A producer adds a required field with no default. Which compatibility claim is true?",
          options: [
            "Backward compatible, because old data is unchanged",
            "Breaking in both directions: old data lacks the field and new readers have nothing to fill",
            "Forward compatible only",
            "Compatible if the field is a string"
          ],
          answer: 1,
          explain: "Without a default there is no value to supply for existing records, so a new reader cannot resolve old data. The registry rejects this under BACKWARD, FORWARD and FULL modes."
        },
        {
          q: "Why is renaming a column safe in Iceberg but breaking in Avro?",
          options: [
            "Iceberg stores data in Parquet, which has no names",
            "Iceberg identifies columns by field id, while Avro identifies them by name unless an alias is declared",
            "Avro disallows renames in the specification",
            "Iceberg rewrites all data files on rename"
          ],
          answer: 1,
          explain: "Field ids are stable across renames, so old files still resolve to the same column and the rename is a metadata change. Avro resolves by name, so the reader sees a removed field and an added one."
        },
        {
          q: "Why is an added enum value dangerous for a Rust consumer?",
          options: [
            "Rust cannot deserialize enums from Avro",
            "An exhaustive match fails or the deserializer errors on a variant it does not know",
            "Enums cannot have defaults",
            "Avro sorts enum symbols alphabetically"
          ],
          answer: 1,
          explain: "Adding a symbol is structurally compatible but not semantically compatible: an exhaustive match has no arm for the new value, so the failure appears at runtime in the consumer, not at publish time."
        }
      ],
      quickbytes: [
        "Backward = new reader reads old data; forward = old reader reads new data; FULL requires both.",
        "Add optional fields with defaults; never add a required field to an existing schema.",
        "Field ids (Parquet/Iceberg) survive renames; Avro names need aliases.",
        "Test compatibility with recorded messages from the previous schema version, not with synthetic rows."
      ],
      production: [
        "A schema registry mode is set per subject, and CI publishes a compatibility check before deploy.",
        "The schema id is embedded in every payload, so consumers resolve with the writer schema.",
        "A fixture corpus keeps one message per schema version and is replayed in tests.",
        "Enum additions are treated as breaking for exhaustive Rust matches and deployed consumer-first."
      ],
      crates: ["apache-avro", "serde", "serde_json"],
      github: [
        { name: "apache/avro", url: "https://github.com/apache/avro" }
      ],
      pitfall: "Relying on a schema registry to catch a units change: currency moving from minor to major units is structurally identical and passes every compatibility check, while every downstream sum is off by a hundred.",
      resources: [
        { title: "apache-avro: Schema, Reader, Writer and resolution", url: "https://docs.rs/apache-avro/latest/apache_avro/", kind: "docs" },
        { title: "apache/avro: specification and schema resolution rules", url: "https://github.com/apache/avro", kind: "repo" },
        { title: "Schema compatibility: backward, forward and full (Confluent)", url: "https://www.youtube.com/watch?v=vQ4mPepAM7Q", kind: "video" },
        { title: "Avro schema evolution: writer and reader schemas explained", url: "https://www.youtube.com/watch?v=wNXgAqoQ034", kind: "video" }
      ]
    },
    {
      id: "m14",
      title: "Partitioning strategies and pruning that works",
      minutes: 100,
      level: "industry",
      goal: "Choose partition keys from real query predicates, use transforms instead of raw high-cardinality columns, and compute the file count before writing.",
      sections: [
        {
          h: "Partitioning is a pruning contract",
          p: [
            "A partition is useful only if queries filter on it. Writing by customer_id looks tidy and prunes nothing when every query filters by date, so the reader opens every partition to find the day it wanted. Start from the WHERE clauses your dashboards actually issue, and partition on the leading column of the most selective predicate that appears in almost every query.",
            "The contract has two sides. Writers must produce a layout that matches those predicates, and readers must pass the predicate down so the file list is filtered before any object is opened. A partition column that is never used in a predicate is pure cost: extra directory levels, more files, more metadata, and a listing that takes longer than the query."
          ],
          list: [
            "Partition on the column that appears in the WHERE clause of most queries",
            "Order matters for readability, not pruning: readers filter on all partition keys",
            "Two levels at most for most tables; a third usually means a different transform",
            "Never partition on a column with millions of distinct values"
          ],
          tip: "Before adding a partition column, count the distinct values per day. If it is above a few thousand, use a bucket transform instead of identity partitioning."
        },
        {
          h: "Transforms are the escape hatch from cardinality",
          p: [
            "Identity partitioning on a timestamp gives one directory per distinct value, which at millisecond resolution is unbounded. A day or hour transform collapses it to a bounded number of partitions and still prunes range predicates. Iceberg calls these hidden partitions: the table stores the transform in its spec, so a query written against the raw column still prunes without the user naming dt=2026-01-01.",
            "Bucket and truncate transforms handle the other shape of skew. Bucketing hashes a high-cardinality key into N files, which spreads write load evenly at the cost of never pruning by that key's value. Truncate keeps a prefix - useful for ids or postcodes - and prunes range and prefix predicates while keeping cardinality bounded by design."
          ],
          code: `use chrono::{DateTime, Utc};

/// Identity by day plus a bounded bucket for a high-cardinality key.
pub fn partition_path(event_ts_ms: i64, customer_id: u64, buckets: u32) -> String {
    let ts = DateTime::<Utc>::from_timestamp_millis(event_ts_ms).unwrap_or_default();
    let bucket = (stable_bucket_hash(customer_id) % buckets as u64) as u32;
    format!("dt={}/bucket={:03}", ts.format("%Y-%m-%d"), bucket)
}

/// Toy hash, shown for shape: it must be stable across processes and runs.
/// A hash that changes between runs reshuffles every file into a different
/// bucket on the next write. Use a vetted stable hasher in production.
fn stable_bucket_hash(value: u64) -> u64 {
    const K: u64 = 0x517c_c1b7_2722_0a95;
    value.wrapping_mul(K) ^ (value >> 32)
}

/// File count is a design input: partitions times files per partition.
pub fn planned_files(partitions_per_day: u64, files_per_partition: u64, days: u64) -> u64 {
    partitions_per_day * files_per_partition * days
}

pub fn before_writing(days: u64) -> u64 {
    // 24 hourly partitions * 2 files * 90 days = 4,320 files. Fine.
    planned_files(24, 2, days)
}

pub fn too_fine(days: u64) -> u64 {
    // customer identity partitioning: 20,000 customers * 1 file * 90 days =
    // 1.8M files. Listing alone becomes the bottleneck.
    planned_files(20_000, 1, days)
}`,
          tip: "Use a stable hash for bucketing. std::collections::hash_map::DefaultHasher is randomly seeded per process, so two writers place the same key in different buckets."
        },
        {
          h: "Target file size, not target partition size",
          p: [
            "The unit a query pays for is the file: one open, one footer read, one set of row groups. A partition of 10 GB in 500 files costs far more per query than the same 10 GB in 20 files, because planning and request latency scale with file count while the bytes scanned are identical. Aim for 128-512 MB per file and treat anything under 32 MB as a compaction candidate.",
            "Compute the number before the job runs, not after the bill. Rows per file divided into rows per day gives files per partition; multiply by partitions and retention days. If that number exceeds a few hundred thousand for the whole table, the layout is too fine, and the fix is a coarser transform or fewer partition columns - not a bigger cluster."
          ],
          tip: "Keep partition columns out of the file name and inside the path, so a rewrite of a partition never changes the schema of the table."
        }
      ],
      exercise: {
        prompt: "Given a table of 50 million events per day and queries that filter by date and country, propose a partition layout, compute files for 90 days at a 256 MB target, and write the path function.",
        starter: `pub fn path(event_ts_ms: i64, country: &str) -> String {
    // 1. dt=YYYY-MM-DD from the timestamp
    // 2. country=XX
    todo!()
}

pub fn files_for_90_days(events_per_day: u64, rows_per_file: u64, countries: u64) -> u64 {
    todo!()
}`,
        hint: "Partition by day and country only - both appear in the predicate. files = ceil(events_per_day / rows_per_file) * countries * 90. At 50M events and 1M rows per file that is 50 * 200 * 90.",
        solution: `use chrono::{DateTime, Utc};

pub fn path(event_ts_ms: i64, country: &str) -> String {
    let ts = DateTime::<Utc>::from_timestamp_millis(event_ts_ms).unwrap_or_default();
    format!("dt={}/country={}", ts.format("%Y-%m-%d"), country)
}

pub fn files_for_90_days(events_per_day: u64, rows_per_file: u64, countries: u64) -> u64 {
    let per_partition = events_per_day.div_ceil(rows_per_file.max(1));
    per_partition * countries * 90
}

pub fn report(events_per_day: u64, rows_per_file: u64, countries: u64) {
    let files = files_for_90_days(events_per_day, rows_per_file, countries);
    tracing::info!(
        files,
        per_file_mb = 256,
        "planned layout: day x country, 90 days; compact above 200k files"
    );
    assert!(files < 200_000, "layout too fine: {files} files");
}`
      },
      questions: [
        {
          q: "Which column should lead the partition layout?",
          options: [
            "The primary key, for uniqueness",
            "The column that appears in the WHERE clause of most queries",
            "The column with the highest cardinality, for even distribution",
            "The column written last, to reduce rewrites"
          ],
          answer: 1,
          explain: "Partitions exist to prune. A key that queries do not filter on produces directories nothing skips, at the cost of more files and more metadata."
        },
        {
          q: "Why does identity partitioning on a millisecond timestamp fail?",
          options: [
            "Timestamps cannot be partition values",
            "It produces one partition per distinct value, so cardinality is unbounded",
            "It breaks predicate pushdown",
            "Parquet cannot store timestamps"
          ],
          answer: 1,
          explain: "One directory per millisecond is effectively one row per partition. A day or hour transform bounds the partition count while still pruning range predicates."
        },
        {
          q: "Two writers bucket the same customer id into different partitions. What is the likely cause?",
          options: [
            "Different Parquet row group sizes",
            "A randomly seeded hasher such as DefaultHasher, which differs per process",
            "Different compression codecs",
            "The bucket count changed between writes"
          ],
          answer: 1,
          explain: "Bucket assignment must be a pure function of the key. A random SipHash seed per process puts the same value in a different bucket on every restart, scattering one customer's rows across the table."
        }
      ],
      quickbytes: [
        "Partition on the predicates your queries actually use; unused partition keys are pure cost.",
        "Bound cardinality with day/hour, bucket or truncate transforms instead of identity on raw keys.",
        "Use a stable hash for buckets - DefaultHasher is randomly seeded per process.",
        "Plan files before writing: partitions x files per partition x retention days."
      ],
      production: [
        "The partition spec is reviewed against the top ten production queries, not against the data model.",
        "Bucket counts and hash functions are documented and stable across releases.",
        "A pre-write estimate of file count fails the job when the layout exceeds a threshold.",
        "Readers pass partition predicates explicitly, and tests assert that the file list shrinks."
      ],
      crates: ["iceberg", "chrono", "arrow", "object_store"],
      github: [
        { name: "apache/iceberg-rust", url: "https://github.com/apache/iceberg-rust" }
      ],
      pitfall: "Partitioning by customer id because it is the obvious entity: 20,000 directories per day, no query prunes on it, and listing the table takes longer than scanning the data.",
      resources: [
        { title: "Iceberg spec: partition specs and transforms", url: "https://docs.rs/iceberg/latest/iceberg/spec/index.html", kind: "docs" },
        { title: "Apache Kafka design: partitioning as the unit of parallelism", url: "https://kafka.apache.org/documentation/#design", kind: "docs" },
        { title: "apache/iceberg-rust: PartitionSpec and transform implementation", url: "https://github.com/apache/iceberg-rust", kind: "repo" },
        { title: "The Parquet format and performance optimization (Databricks)", url: "https://www.youtube.com/watch?v=1j8SdS7s_NY", kind: "video" }
      ]
    },
    {
      id: "m15",
      title: "Compaction: fixing the small-file problem",
      minutes: 95,
      level: "industry",
      goal: "Plan a bin-packed compaction over a partition, rewrite files without changing data, and commit atomically so readers never see a gap.",
      sections: [
        {
          h: "Small files cost requests, not bytes",
          p: [
            "A thousand 1 MB files and one 1 GB file hold the same data, and the thousand files cost a thousand opens, a thousand footer reads and a thousand listing entries. On object storage each of those is a request with latency and a price, and query planning must materialise the whole file list before the first byte is read. The scan can be dominated by metadata while the actual data transfer is trivial.",
            "Small files appear for structural reasons, not by accident: a streaming sink flushes every minute, a partition key has too many distinct values, a backfill writes one file per input split, or a job crashed and left partial output. Compaction is the maintenance job that merges them, and it is not optional - every lake that ingests continuously needs it scheduled from day one."
          ],
          list: [
            "Symptom: p99 query latency grows while bytes scanned stays flat",
            "Symptom: listing a partition returns thousands of objects under 32 MB",
            "Cause: per-minute flushes, over-partitioning, or one file per backfill split",
            "Fix: bin-pack to a target size, then delete superseded files after a retention margin"
          ],
          tip: "Track files per partition as a first-class metric. It predicts the cost increase weeks before anyone complains about dashboards."
        },
        {
          h: "Compaction is a rewrite plus a commit",
          p: [
            "A compaction job reads a set of small files, writes fewer larger files with the same rows, and commits a new snapshot that references the new files and drops the old ones. Readers resolve the snapshot, so during the rewrite they see the old files; after the commit they see the new ones. Nothing is edited in place, which is what makes the operation safe to run against a live table.",
            "The rewrite must preserve row content and order-independent properties: same schema, same values, same partition assignment. It may improve compression and statistics, and it will change file names, so anything that cached a file path - an audit, a manifest of a previous snapshot - must resolve through the table rather than pin paths."
          ],
          code: `/// Bin-pack files into groups close to target_bytes, skipping groups of one.
/// Sorting by size first keeps big files from being rewritten repeatedly.
pub fn plan(files: Vec<(String, u64)>, target_bytes: u64) -> Vec<Vec<String>> {
    let mut sorted = files;
    sorted.sort_by_key(|(_, size)| *size);

    let mut groups: Vec<Vec<String>> = Vec::new();
    let mut current: Vec<String> = Vec::new();
    let mut current_bytes = 0u64;

    for (path, size) in sorted {
        if !current.is_empty() && current_bytes + size > target_bytes {
            groups.push(std::mem::take(&mut current));
            current_bytes = 0;
        }
        current.push(path);
        current_bytes += size;
    }
    if !current.is_empty() {
        groups.push(current);
    }

    // A group of one is already at target size: rewriting it is pure write
    // amplification with no reduction in file count.
    groups.retain(|group| group.len() > 1);
    groups
}

#[cfg(test)]
mod tests {
    use super::plan;

    #[test]
    fn single_file_groups_are_not_rewritten() {
        let files = vec![("a".into(), 900), ("b".into(), 50), ("c".into(), 50)];
        let groups = plan(files, 1000);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].len(), 2);
    }
}`,
          tip: "Skip groups of one. Rewriting a file that is already large adds write cost and produces no reduction in file count."
        },
        {
          h: "Cadence, concurrency and the delete margin",
          p: [
            "Run compaction on a schedule proportional to ingestion: hourly for a stream that flushes every minute, daily for a batch table. Bound the concurrency so compaction does not starve the writers, and compact only partitions older than the newest ingestion window, so a partition is not rewritten while it is being appended to.",
            "Deleting the old files is the dangerous step. Keep a retention margin longer than the longest-running query and the longest-running snapshot reader - a reader that resolved the previous snapshot still needs its files. Expire snapshots first, then run orphan cleanup, and alert if orphan bytes grow, because that means a commit path is failing after writing data."
          ],
          list: [
            "Compact partitions closed for writes, never the active one",
            "Retain old files for at least the longest query plus a safety margin",
            "Expire snapshots before deleting orphans, in that order",
            "Measure write amplification: bytes rewritten per byte ingested"
          ],
          tip: "Compaction that rewrites the same large file every night is a sign of missing skip logic - check that groups of one are excluded."
        }
      ],
      exercise: {
        prompt: "Implement the delete step: given the list of files referenced by the new snapshot and the previous snapshot's files, return the files safe to delete, excluding any touched within the retention window.",
        starter: `use std::collections::HashSet;

pub struct FileRef { pub path: String, pub modified_ms: i64 }

pub fn deletable(
    previous: Vec<FileRef>,
    current_paths: &HashSet<String>,
    now_ms: i64,
    retain_ms: i64,
) -> Vec<String> {
    // 1. keep files still referenced by the current snapshot
    // 2. keep files modified inside the retention window
    // 3. return the rest
    todo!()
}`,
        hint: "Filter previous by !current_paths.contains(&file.path) && now_ms - file.modified_ms > retain_ms. Never delete a file the new snapshot references, no matter how old it is.",
        solution: `use std::collections::HashSet;

pub struct FileRef { pub path: String, pub modified_ms: i64 }

pub fn deletable(
    previous: Vec<FileRef>,
    current_paths: &HashSet<String>,
    now_ms: i64,
    retain_ms: i64,
) -> Vec<String> {
    previous
        .into_iter()
        .filter(|file| !current_paths.contains(&file.path))
        .filter(|file| now_ms.saturating_sub(file.modified_ms) > retain_ms)
        .map(|file| file.path)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn referenced_files_are_never_deleted() {
        let previous = vec![FileRef { path: "a.parquet".into(), modified_ms: 0 }];
        let current: HashSet<String> = ["a.parquet".to_string()].into_iter().collect();
        assert!(deletable(previous, &current, 10_000, 0).is_empty());
    }
}`
      },
      questions: [
        {
          q: "Why do a thousand small files cost more than one large file with the same bytes?",
          options: [
            "Compression is worse per file",
            "Each file is an open, a footer read and a listing entry, so request count and planning dominate",
            "Parquet files cannot share a schema",
            "Object stores charge per byte read only"
          ],
          answer: 1,
          explain: "The bytes are equal; the per-object overhead is not. Every file costs metadata, a request and planning time, and on object storage those requests are billed."
        },
        {
          q: "When is compaction of a group safe with respect to readers?",
          options: [
            "Always, because Parquet files are immutable",
            "When the commit is atomic and old files are retained past the longest reader",
            "Only when the table is offline",
            "Only if the group is a single file"
          ],
          answer: 1,
          explain: "Immutability makes the rewrite safe, but a reader that resolved the previous snapshot still needs the old files. Retention past the longest reader plus an atomic commit is what prevents a missing-file error."
        },
        {
          q: "Compaction rewrites the same large file every night. What is the most likely bug?",
          options: [
            "The target size is too small",
            "Groups of one are not filtered out before rewriting",
            "The retention margin is too long",
            "Parquet statistics are enabled"
          ],
          answer: 1,
          explain: "A group containing one file that is already at target size has nothing to merge. Rewriting it adds write amplification without reducing file count, which is the definition of a broken compaction policy."
        }
      ],
      quickbytes: [
        "Small files cost requests and planning time, not bytes - watch files per partition.",
        "Bin-pack sorted sizes to a 128-512 MB target; never rewrite groups of one.",
        "Compact closed partitions only, and keep old files past the longest reader.",
        "Expire snapshots first, then delete orphans; alert when orphan bytes grow."
      ],
      production: [
        "Compaction is scheduled from the first day of streaming ingestion, sized to the flush interval.",
        "Files per partition and orphan bytes are exported as metrics with alerts.",
        "The rewrite skips single-file groups and reports write amplification per run.",
        "Old files are retained for longer than the longest query and snapshot retention."
      ],
      crates: ["parquet", "arrow", "object_store", "tokio"],
      github: [
        { name: "delta-io/delta-rs", url: "https://github.com/delta-io/delta-rs" },
        { name: "apache/iceberg-rust", url: "https://github.com/apache/iceberg-rust" }
      ],
      pitfall: "Deleting the old files immediately after the commit: a dashboard that resolved the previous snapshot minutes earlier fails with a file-not-found, and the table looks corrupt to the user.",
      resources: [
        { title: "parquet crate: reading and rewriting files", url: "https://docs.rs/parquet/latest/parquet/", kind: "docs" },
        { title: "Iceberg spec: snapshots and file lifecycles", url: "https://docs.rs/iceberg/latest/iceberg/spec/index.html", kind: "docs" },
        { title: "Small file problem in the lakehouse: Apache Iceberg compaction (Cloudera)", url: "https://www.youtube.com/watch?v=Xl92re55rYE", kind: "video" },
        { title: "apache/iceberg-rust: rewrite and maintenance actions", url: "https://github.com/apache/iceberg-rust", kind: "repo" }
      ]
    },
    {
      id: "m16",
      title: "Exactly-once: transactions and idempotent sinks",
      minutes: 110,
      level: "industry",
      goal: "Separate delivery from effect: use Kafka transactions to commit output and offsets together, or a deterministic sink key to make replays harmless.",
      sections: [
        {
          h: "Delivery cannot be exactly once; the effect can",
          p: [
            "A producer cannot know whether a message was stored if the acknowledgement is lost, so it must choose between retrying, which may duplicate, and not retrying, which may lose. That is the two-generals problem, and no configuration removes it. What can be made exactly once is the visible effect: the database row, the output record, the file committed to a table.",
            "There are two ways to get there. Make the write atomic with the position: a transaction that publishes output and advances the input offset in one commit. Or make the write idempotent: derive the output identity from the input position so a replay overwrites the same record rather than adding another. Most real pipelines use the second, because it also survives the failures a transaction cannot cover, such as a crash after the commit but before the acknowledgement."
          ],
          list: [
            "At-most-once: commit before processing, so a crash loses work",
            "At-least-once: process then commit, so a crash duplicates work",
            "Effectively-once: at-least-once delivery plus idempotent or transactional writes",
            "Exactly-once delivery: not achievable across a network with retries"
          ],
          tip: "Write the dedupe key down before choosing a mechanism. If you cannot name the key that makes a replay a no-op, a transaction will not save the pipeline."
        },
        {
          h: "Kafka transactions: output and offsets in one commit",
          p: [
            "A transactional producer writes records and consumer offsets into the same transaction. Consumers with isolation.level=read_committed see only committed records, and the offsets become visible at the same instant as the output. If the job dies before commit, the transaction aborts and the offsets do not advance, so the input is reprocessed and the partial output is invisible.",
            "The transaction coordinator handles the hard part, but the configuration matters: a stable transactional.id fences a zombie producer from a previous incarnation, enable.idempotence is required, and the send_offsets_to_transaction call needs the consumer's group metadata - not a group id string - so the coordinator knows which offsets to commit atomically."
          ],
          code: `use rdkafka::consumer::{Consumer, StreamConsumer};
use rdkafka::producer::{FutureProducer, FutureRecord, Producer};
use rdkafka::util::Timeout;
use std::time::Duration;

pub async fn transactional_hop(
    producer: &FutureProducer,
    consumer: &StreamConsumer,
    input: &str,
    output: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let timeout = Timeout::After(Duration::from_secs(10));
    producer.init_transactions(timeout)?;
    producer.begin_transaction()?;

    // Output and offsets become visible together, at commit.
    producer
        .send(FutureRecord::to(output).payload("{}"), timeout)
        .await
        .map_err(|(e, _)| e)?;

    let mut offsets = rdkafka::TopicPartitionList::new();
    offsets.add_partition_offset(input, 0, rdkafka::Offset::Offset(42))?;

    let group = consumer.group_metadata().ok_or("consumer has no group.id")?;
    producer.send_offsets_to_transaction(&offsets, &group, timeout)?;
    producer.commit_transaction(timeout)?;
    Ok(())
}`,
          tip: "group_metadata() returns Option, not a Result. A consumer without group.id yields None, and passing a group id string instead is a type error rather than a subtle runtime bug."
        },
        {
          h: "The idempotent sink is usually enough",
          p: [
            "When the sink is object storage or a table, the deterministic-key approach is simpler and more robust than a distributed transaction. Key the written object by the input position - topic, partition and offset, or a CDC log position - and use a create-only conditional put. A replay finds the object already exists and treats it as success; nothing downstream ever sees two copies.",
            "This moves the burden to naming. The key must be a pure function of the input range, so a retry with the same range produces the same name, and a different range never collides. Where rows from many inputs merge into one table, the key becomes the row's natural identity plus a monotonically increasing version, and the sink keeps the highest version per key. That is an upsert with a version guard, which is exactly the same idea as the fencing token in the orchestration lesson."
          ],
          tip: "A deterministic object name plus PutMode::Create is an idempotent writer in five lines; verify the AlreadyExists error is treated as success."
        }
      ],
      exercise: {
        prompt: "Make the object-store sink idempotent: derive the object key from the input range, create-only put, and treat AlreadyExists as success. Then explain in a comment where a duplicate can still reach the table.",
        starter: `use std::sync::Arc;
use object_store::{path::Path, ObjectStore, PutMode, PutOptions, PutPayload};

pub async fn land(
    store: Arc<dyn ObjectStore>,
    topic: &str,
    partition: i32,
    offset_from: i64,
    offset_to: i64,
    bytes: Vec<u8>,
) -> Result<(), Box<dyn std::error::Error>> {
    // 1. build a deterministic key: bronze/{topic}/p={partition}/{from}-{to}.parquet
    // 2. put with PutMode::Create
    // 3. map AlreadyExists to Ok(())
    todo!()
}`,
        hint: "Path::from(format!(...)) then store.put_opts(&path, PutPayload::from(bytes), PutOptions { mode: PutMode::Create, ..Default::default() }). Match object_store::Error::AlreadyExists and return Ok.",
        solution: `use std::sync::Arc;
use object_store::{path::Path, ObjectStore, PutMode, PutOptions, PutPayload};

pub async fn land(
    store: Arc<dyn ObjectStore>,
    topic: &str,
    partition: i32,
    offset_from: i64,
    offset_to: i64,
    bytes: Vec<u8>,
) -> Result<(), Box<dyn std::error::Error>> {
    let path = Path::from(format!(
        "bronze/{topic}/p={partition}/{offset_from:012}-{offset_to:012}.parquet"
    ));
    let options = PutOptions { mode: PutMode::Create, ..Default::default() };

    match store.put_opts(&path, PutPayload::from(bytes), options).await {
        Ok(_) => Ok(()),
        // A retry of the same input range writes the same name: the object is
        // already correct, so the conflict is success.
        Err(object_store::Error::AlreadyExists { .. }) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

// A duplicate can still reach the table if a *different* input range produces
// the same rows - for example after a source re-sends an event with a new
// offset. That must be handled by dedupe on business identity, not by naming.`
      },
      questions: [
        {
          q: "Why is exactly-once delivery over a network unachievable?",
          options: [
            "Brokers do not support it",
            "A lost acknowledgement forces a choice between retrying, which may duplicate, and not retrying, which may lose",
            "Consumers cannot store offsets twice",
            "Clocks are not synchronized"
          ],
          answer: 1,
          explain: "The sender cannot distinguish a lost message from a lost acknowledgement. Exactly-once is therefore a property of the observable effect, achieved with atomic commits or idempotent writes."
        },
        {
          q: "What does isolation.level=read_committed change for a consumer?",
          options: [
            "It halves the fetch size",
            "It hides records from aborted transactions and uncommitted offset advances",
            "It enables compression",
            "It makes the consumer transactional"
          ],
          answer: 1,
          explain: "Transactional records are only visible once committed. read_committed is what prevents a consumer from reading output that the producer later aborted."
        },
        {
          q: "When is a deterministic object key not enough to prevent duplicates?",
          options: [
            "When the object store lacks compare-and-swap",
            "When two different input ranges produce the same business rows, for example a re-sent event with a new offset",
            "When ZSTD is used",
            "When the sink is Parquet instead of JSON"
          ],
          answer: 1,
          explain: "Keying by input position deduplicates replays of the same range. A source that re-emits an event under a new offset defeats that scheme, so the sink also needs dedupe on business identity."
        }
      ],
      quickbytes: [
        "Exactly-once is an effect property: atomic commit with the offset, or an idempotent write.",
        "Transactional producers need enable.idempotence, a stable transactional.id, and read_committed consumers.",
        "send_offsets_to_transaction takes ConsumerGroupMetadata, not a group id string.",
        "PutMode::Create plus a deterministic key: turn AlreadyExists into success."
      ],
      production: [
        "Every sink has a documented idempotency key, and the key is derived from input position or business identity.",
        "Transactional producers use a stable transactional.id so a restarted instance fences the previous one.",
        "Consumers of transactional topics set isolation.level=read_committed explicitly.",
        "An idempotency test runs the same batch twice and asserts row counts are unchanged."
      ],
      crates: ["rdkafka", "object_store", "tokio", "serde_json"],
      github: [
        { name: "fede1024/rust-rdkafka", url: "https://github.com/fede1024/rust-rdkafka" }
      ],
      pitfall: "A transactional producer with a random transactional.id per process: the old instance keeps writing because nothing fences it, and two producers commit interleaved output for the same partition.",
      resources: [
        { title: "MillWheel: fault-tolerant stream processing with exactly-once effects", url: "https://research.google/pubs/pub41378/", kind: "paper" },
        { title: "rdkafka producer: transactions and offsets", url: "https://docs.rs/rdkafka/latest/rdkafka/producer/index.html", kind: "docs" },
        { title: "Apache Kafka transactions and exactly-once semantics (Confluent)", url: "https://www.youtube.com/watch?v=Ki2D2o9aVl8", kind: "video" },
        { title: "object_store: conditional puts for idempotent sinks", url: "https://docs.rs/object_store/latest/object_store/", kind: "docs" },
        { title: "fede1024/rust-rdkafka: transactional producer support", url: "https://github.com/fede1024/rust-rdkafka", kind: "repo" }
      ]
    },
    {
      id: "m17",
      title: "Backfills: replay without breaking production",
      minutes: 90,
      level: "industry",
      goal: "Plan a bounded, resumable backfill that shares code with the live pipeline and cannot damage the current partition.",
      sections: [
        {
          h: "A backfill is a controlled replay",
          p: [
            "A backfill re-processes a range of history, usually because a transform was wrong, a source arrived late, or a new column needs populating. It must run the same code as the live pipeline against a different range, or the backfilled data and the live data will disagree in ways nobody can reason about. The only intended difference is the input range and the destination.",
            "The safest destination is the partition itself, rewritten atomically. If the job writes partition dt=2026-03-04 as a new object and commits it, a failure leaves the old partition intact, and the switch is one operation. Appending during a backfill is what creates duplicates that outlive the incident, because the live job has already written rows for some of the same days."
          ],
          list: [
            "Same binary, same transform, different input range",
            "Write whole partitions and swap them; never append into a backfilled range",
            "Take the source position from the data, not from the current clock",
            "A backfill that needs a code change is a new version of the pipeline, not a flag"
          ],
          tip: "Make the partition the unit of work. It gives you resumability, bounded memory and an atomic commit in one decision."
        },
        {
          h: "Isolate the replay from the live path",
          p: [
            "A backfill that reads the production database at full speed competes with the live traffic that pays the bills. Use a separate consumer group or a read replica, cap concurrency, and rate-limit the source rather than the sink. On the write side, target a shadow prefix or a shadow table first, compare row counts and checksums against the live partition, then swap.",
            "The swap is also where compaction and retention interact. Running compaction on the same partitions during a backfill rewrites files that are about to be replaced, which wastes IO and can resurrect a superseded file if the ordering is unlucky. Pause compaction for the affected partitions, or exclude them by the commit timestamp."
          ],
          code: `use chrono::{Duration, NaiveDate};
use futures_util::stream::{self, StreamExt};
use std::collections::HashSet;

pub fn partitions(from: NaiveDate, days: i64) -> Vec<String> {
    (0..days)
        .map(|offset| (from + Duration::days(offset)).format("%Y-%m-%d").to_string())
        .collect()
}

/// Bounded, resumable replay: skip partitions already committed, run at most
/// concurrency at a time, and stop on the first hard failure.
pub async fn backfill<F, Fut>(
    from: NaiveDate,
    days: i64,
    concurrency: usize,
    committed: &HashSet<String>,
    run: F,
) -> Result<usize, String>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let pending: Vec<String> = partitions(from, days)
        .into_iter()
        .filter(|partition| !committed.contains(partition))
        .collect();

    tracing::info!(total = pending.len(), concurrency, "backfill starting");

    let mut done = 0usize;
    let mut results = stream::iter(pending)
        .map(|partition| run(partition))
        .buffer_unordered(concurrency);

    while let Some(result) = results.next().await {
        result?;
        done += 1;
        if done % 25 == 0 {
            tracing::info!(done, "backfill progress");
        }
    }
    Ok(done)
}`,
          tip: "buffer_unordered takes a concurrency limit and keeps results as they finish. Without a limit, a thousand partitions open a thousand filesystems at once."
        },
        {
          h: "Bookkeeping that survives a restart",
          p: [
            "The list of completed partitions must live outside the process, keyed by pipeline version and partition. A table of (pipeline, version, partition, committed_at, row_count, checksum) gives you resume, audit and the ability to answer which code version produced a row. Without the version, a backfill after a second bug fix silently keeps the output of the first fix.",
            "Progress must also be observable while it runs: partitions done, rows written, current rate and an ETA computed from recent throughput rather than from the average since start. The ETA is what tells an operator whether to wait or to abort, and a backfill with no ETA gets killed at the wrong moment by someone who assumes it is stuck."
          ],
          tip: "Commit the bookkeeping row in the same transaction or the same atomic put as the partition. Two separate writes guarantee a mismatch after a crash."
        }
      ],
      exercise: {
        prompt: "Make the backfill resumable and safe: skip committed partitions, bound concurrency to 4, record each success in the completed set, and abort remaining work after 3 failures.",
        starter: `use std::collections::HashSet;

pub struct Progress { pub completed: HashSet<String>, pub failures: usize }

pub async fn run<F, Fut>(pending: Vec<String>, progress: &mut Progress, run: F) -> Result<(), String>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    // 1. skip anything already in progress.completed
    // 2. call run() and insert into completed on success
    // 3. count failures and return Err after the third
    todo!()
}`,
        hint: "Iterate sequentially or with buffer_unordered; the important part is inserting into completed immediately after each success so a later restart skips it. Track failures in the struct, not a local.",
        solution: `use std::collections::HashSet;

pub struct Progress { pub completed: HashSet<String>, pub failures: usize }

pub async fn run<F, Fut>(pending: Vec<String>, progress: &mut Progress, run: F) -> Result<(), String>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    for partition in pending {
        if progress.completed.contains(&partition) {
            continue;
        }
        match run(partition.clone()).await {
            Ok(()) => {
                progress.completed.insert(partition);
            }
            Err(error) => {
                progress.failures += 1;
                tracing::error!(%partition, %error, failures = progress.failures, "partition failed");
                if progress.failures >= 3 {
                    return Err(format!("aborting after {} failures", progress.failures));
                }
            }
        }
    }
    Ok(())
}`
      },
      questions: [
        {
          q: "Why should a backfill not append into the range the live job is writing?",
          options: [
            "Kafka rejects duplicate keys",
            "The live job may already have written some of the same days, producing duplicates that persist after the incident",
            "Appends are slower than overwrites",
            "Parquet cannot be appended"
          ],
          answer: 1,
          explain: "Live and backfill ranges overlap during an incident, and an append has no way to replace what is already there. Overwriting whole partitions keeps exactly one authoritative copy per day."
        },
        {
          q: "What makes a backfill resumable after a crash?",
          options: [
            "Writing progress to memory",
            "Persisting completed partitions keyed by pipeline version outside the process",
            "Recomputing from the beginning each time",
            "Using a single concurrency slot"
          ],
          answer: 1,
          explain: "Resume requires durable per-partition bookkeeping. Keying by pipeline version prevents a restart from treating output produced by an older, buggy version as complete."
        },
        {
          q: "Why is a shadow prefix or table useful before swapping a backfill?",
          options: [
            "It compresses better",
            "It lets you compare counts and checksums against the live partition before replacing it",
            "It avoids the object store's request charges",
            "It makes the job idempotent automatically"
          ],
          answer: 1,
          explain: "A backfill is a rewrite of production data. Validating the output in a separate location before the atomic swap turns a possible data loss into a comparison you can reject."
        }
      ],
      quickbytes: [
        "Same code, different range: a backfill is a replay, not a fork of the pipeline.",
        "Rewrite whole partitions and swap atomically; never append into a backfilled range.",
        "Separate consumer group or replica, and cap concurrency to protect the source.",
        "Persist (pipeline, version, partition, checksum) so a restart resumes and an audit can attribute."
      ],
      production: [
        "Backfills run the released binary with an explicit range, and the code version is recorded per partition.",
        "Concurrency and source rate limits are configured per backfill, not inherited from the live job.",
        "Compaction is paused or excluded for partitions being rewritten.",
        "Progress, rows written and a short-window ETA are exported while the job runs."
      ],
      crates: ["tokio", "futures-util", "object_store", "chrono"],
      github: [
        { name: "apache/airflow", url: "https://github.com/apache/airflow" },
        { name: "delta-io/delta-rs", url: "https://github.com/delta-io/delta-rs" }
      ],
      pitfall: "A backfill that writes with the current timestamp instead of the ingested data's timestamp: the rewritten partition sorts to today, and the next incremental run skips the history it was meant to repair.",
      resources: [
        { title: "Kafka consumer position and offset reset semantics", url: "https://kafka.apache.org/documentation/", kind: "docs" },
        { title: "object_store: atomic partition replacement with conditional puts", url: "https://docs.rs/object_store/latest/object_store/", kind: "docs" },
        { title: "Airflow DAG scheduling and catchup semantics", url: "https://github.com/apache/airflow", kind: "repo" },
        { title: "tokio: bounded concurrency with buffer_unordered", url: "https://docs.rs/tokio/latest/tokio/", kind: "docs" }
      ]
    },
    {
      id: "m18",
      title: "Medallion layers: bronze, silver and gold",
      minutes: 85,
      level: "advanced",
      goal: "Assign each layer one job - raw fidelity, deduplicated truth, or consumption-ready aggregates - and make every layer rebuildable from the one before.",
      sections: [
        {
          h: "Each layer removes one kind of mess",
          p: [
            "Bronze is the raw landing zone: records as received, append-only, with source metadata attached. It tolerates schema drift because its job is fidelity - if a field was wrong at the source, bronze still has what actually arrived. Nothing in bronze is deduplicated, typed for analysis, or joined, and that is deliberate: every transformation you apply here is a decision you cannot undo later.",
            "Silver is the conformed layer: typed, deduplicated, validated and joined to the grain the business uses. One row per order, with the customer key resolved and the status normalized. Gold is the consumption layer: aggregates and wide tables shaped for specific questions, with a contract and an owner. Each layer exists so that a change in one does not force a change in all."
          ],
          list: [
            "Bronze: append-only, source-shaped, no dedupe, long retention",
            "Silver: deduplicated at the declared grain, typed, conformed, validated",
            "Gold: aggregated, denormalized, contract-bound, cheap to query",
            "Never let gold become another team's source of record"
          ],
          tip: "If a gold table is being used as an input to another pipeline, the pipeline is reading the wrong layer; point it at silver."
        },
        {
          h: "Reprocessability is the point",
          p: [
            "The value of layering is not tidiness, it is rebuild cost. A bug in the silver dedupe means rebuilding silver from bronze, which is cheap because bronze is unchanged. A bug in gold means rebuilding from silver. If bronze were cleaned in place, there would be nothing to rebuild from and the answer to a bad transform would be a data loss incident.",
            "That property requires determinism: silver must be a pure function of a bronze range, with no reliance on wall-clock time, random ordering, or the current contents of a mutable table. Version the transform and record it on the output so a rebuild can be compared against what it replaces, and so an audit can tell which logic produced a given row."
          ],
          code: `use std::collections::HashMap;

use arrow::array::{Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use std::sync::Arc;

#[derive(Clone)]
pub struct BronzeRow {
    pub order_id: String,
    pub status: String,
    pub amount_minor: i64,
    pub position: u64,
}

/// Bronze to silver: keep the highest log position per order, then emit a
/// typed batch. Deterministic: the same bronze range always yields this.
pub fn to_silver(rows: &[BronzeRow]) -> Result<RecordBatch, arrow::error::ArrowError> {
    let mut latest: HashMap<&str, &BronzeRow> = HashMap::new();
    for row in rows {
        latest
            .entry(row.order_id.as_str())
            .and_modify(|current| {
                if row.position > current.position {
                    *current = row;
                }
            })
            .or_insert(row);
    }

    let mut ordered: Vec<&BronzeRow> = latest.into_values().collect();
    ordered.sort_by(|a, b| a.order_id.cmp(&b.order_id));

    let ids = StringArray::from(ordered.iter().map(|r| r.order_id.as_str()).collect::<Vec<_>>());
    let statuses = StringArray::from(ordered.iter().map(|r| r.status.as_str()).collect::<Vec<_>>());
    let amounts = Int64Array::from(ordered.iter().map(|r| r.amount_minor).collect::<Vec<_>>());

    let schema = Arc::new(Schema::new(vec![
        Field::new("order_id", DataType::Utf8, false),
        Field::new("status", DataType::Utf8, false),
        Field::new("amount_minor", DataType::Int64, false),
    ]));

    RecordBatch::try_new(schema, vec![Arc::new(ids), Arc::new(statuses), Arc::new(amounts)])
}`,
          tip: "Sorting before writing makes the output byte-stable for a given input, which turns a rebuild comparison into an equality check instead of a diff hunt."
        },
        {
          h: "The failure modes the layers prevent",
          p: [
            "Without bronze, a bad transform cannot be corrected - the evidence is gone. Without silver, every consumer re-implements dedupe and each gets it slightly differently, so two dashboards disagree on revenue. Without gold, every dashboard joins five tables itself and one of them uses the wrong status filter.",
            "The layers also fail in specific ways. Bronze that is transformed on write is not bronze. Silver that reads the current state of a mutable dimension is not deterministic. Gold that other pipelines consume becomes a de facto silver with a contract nobody wrote. Each of those is visible in review if you ask one question: can this layer be rebuilt from the layer below, deterministically?"
          ],
          tip: "Check the rebuild path quarterly: rebuild one silver partition from bronze and compare row counts and checksums against production."
        }
      ],
      exercise: {
        prompt: "Implement the gold aggregate deterministically: from silver rows, compute per-day revenue and order count for paid orders only, sorted by date, and assert the result is identical when the input order is shuffled.",
        starter: `pub struct SilverRow { pub order_id: String, pub event_date: String, pub status: String, pub amount_minor: i64 }

pub struct GoldRow { pub event_date: String, pub revenue_minor: i64, pub orders: u64 }

pub fn to_gold(rows: &[SilverRow]) -> Vec<GoldRow> {
    // 1. filter paid orders
    // 2. aggregate by event_date
    // 3. sort by date so the output is stable
    todo!()
}`,
        hint: "Use a BTreeMap keyed by date so iteration order is already sorted; a HashMap requires an explicit sort, and forgetting it makes byte-level comparisons fail for identical data.",
        solution: `use std::collections::BTreeMap;

pub struct SilverRow { pub order_id: String, pub event_date: String, pub status: String, pub amount_minor: i64 }

pub struct GoldRow { pub event_date: String, pub revenue_minor: i64, pub orders: u64 }

pub fn to_gold(rows: &[SilverRow]) -> Vec<GoldRow> {
    let mut by_date: BTreeMap<&str, GoldRow> = BTreeMap::new();
    for row in rows.iter().filter(|row| row.status == "paid") {
        let entry = by_date.entry(row.event_date.as_str()).or_insert(GoldRow {
            event_date: row.event_date.clone(),
            revenue_minor: 0,
            orders: 0,
        });
        entry.revenue_minor += row.amount_minor;
        entry.orders += 1;
    }
    by_date.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_is_order_independent() {
        let a = SilverRow { order_id: "1".into(), event_date: "2026-01-01".into(), status: "paid".into(), amount_minor: 100 };
        let b = SilverRow { order_id: "2".into(), event_date: "2026-01-01".into(), status: "paid".into(), amount_minor: 50 };
        let forward = to_gold(&[a.clone(), b.clone()]);
        let backward = to_gold(&[b, a]);
        assert_eq!(forward.len(), 1);
        assert_eq!(forward[0].revenue_minor, backward[0].revenue_minor);
    }
}`
      },
      questions: [
        {
          q: "What belongs in the bronze layer?",
          options: [
            "Deduplicated rows with typed columns",
            "Records as received, append-only, with source metadata",
            "Aggregated metrics for dashboards",
            "Only rows that passed validation"
          ],
          answer: 1,
          explain: "Bronze is the evidence layer. Deduplication and typing are decisions that belong in silver, where they can be changed and re-applied without losing the original data."
        },
        {
          q: "A silver transform reads the current customer dimension table to resolve a segment. Why is that a problem?",
          options: [
            "It makes silver non-deterministic: a rebuild months later produces different rows",
            "It is slower than a join",
            "Dimension tables are not Parquet",
            "It breaks the bronze schema"
          ],
          answer: 0,
          explain: "Rebuildability requires silver to be a pure function of bronze. Reading mutable state means a rebuild produces different output, so a comparison cannot tell a fix from a drift."
        },
        {
          q: "Another team's pipeline reads your gold table as its source. What is the architectural correction?",
          options: [
            "Give them read access to bronze instead",
            "Point them at silver, which holds the conformed grain, and keep gold for consumption",
            "Copy gold into a second gold table",
            "Nothing; gold is a valid source"
          ],
          answer: 1,
          explain: "Gold is shaped for a question, not for reuse. Consuming it makes every gold change a breaking change for another team; silver is the shared, conformed layer."
        }
      ],
      quickbytes: [
        "Bronze preserves fidelity, silver establishes truth, gold serves a question.",
        "Every layer must be a deterministic function of the layer below, or it cannot be rebuilt.",
        "If another pipeline reads gold, it is really consuming silver with an unwritten contract.",
        "Rebuild one partition per quarter and compare checksums; that is the only real test of the layering."
      ],
      production: [
        "Bronze is append-only with source metadata and retention longer than any expected rebuild.",
        "Silver dedupe is keyed by declared grain plus log position, and its transform version is recorded.",
        "Gold tables have a named owner and a documented contract with the consumers.",
        "A scheduled rebuild-and-compare test runs on a sample partition to prove determinism."
      ],
      crates: ["arrow", "parquet", "polars", "object_store"],
      github: [
        { name: "delta-io/delta-rs", url: "https://github.com/delta-io/delta-rs" }
      ],
      pitfall: "Cleaning data on the way into bronze: a transform bug six months later cannot be corrected because the original values were never stored, and the rebuild produces the same wrong answer.",
      resources: [
        { title: "The Medallion data architecture: pros and cons (Kahan Data Solutions)", url: "https://www.youtube.com/watch?v=8p77fOWp5F4", kind: "video" },
        { title: "The Data Lakehouse: data warehousing and more (arXiv)", url: "https://arxiv.org/abs/2310.08697", kind: "paper" },
        { title: "delta-io/delta-rs: layered tables with transactional writes", url: "https://github.com/delta-io/delta-rs", kind: "repo" },
        { title: "parquet crate: writing the typed silver output", url: "https://docs.rs/parquet/latest/parquet/", kind: "docs" }
      ]
    },
    {
      id: "m19",
      title: "Pipeline observability: SLIs, run records and traces",
      minutes: 95,
      level: "industry",
      goal: "Define the four SLIs that describe a pipeline, emit them per stage, and alert on data lateness rather than on process health.",
      sections: [
        {
          h: "Four SLIs describe a pipeline",
          p: [
            "Freshness is how old the newest data is, measured from the maximum event timestamp to now. Lag is how much input is unprocessed. Throughput is rows or bytes per unit time. Error rate is failed records over total, with quarantine counted separately from hard failures. Every pipeline incident is one of these four degrading, and a dashboard that shows CPU instead answers a question nobody asked.",
            "Measure them per stage, not per pipeline. A pipeline that is fresh at the source and stale at the sink has a specific failing stage, and an aggregate freshness number hides it. Stage-level SLIs also make the SLO meaningful: the target belongs to the table a consumer reads, and the per-stage numbers explain which hop is eating the budget."
          ],
          list: [
            "Freshness: now minus max(event_timestamp), in seconds, per output table",
            "Lag: input position minus processed position, in records",
            "Throughput: rows and bytes per minute, per stage",
            "Error rate: failed and quarantined records over ingested records"
          ],
          tip: "Compute freshness from the data, not from the job's finish time. A job that succeeds in 40 seconds while reading a stalled source is fresh by the clock and stale by the data."
        },
        {
          h: "Run records and traces answer different questions",
          p: [
            "A metric tells you that freshness is degrading. A run record tells you which execution did it: run id, start, end, input position range, rows in, rows out, bytes written, files written, checksum, code version, and the commit id it produced. When a number is wrong, the run record is the join key between the dashboard, the lineage graph and the actual files.",
            "A trace connects the stages inside one run. One span per stage, with attributes for rows, bytes, partition and retries, shows where the time went without correlating timestamps by hand. Emit the run id as a span attribute so a trace can be found from a run record and vice versa; without that link, two good observability systems remain two disconnected tools."
          ],
          code: `use opentelemetry::metrics::{Counter, Histogram, Meter};
use opentelemetry::{global, KeyValue};

pub struct PipelineMetrics {
    pub rows: Counter<u64>,
    pub files: Counter<u64>,
    pub flush_ms: Histogram<f64>,
    pub freshness_s: Histogram<f64>,
}

impl PipelineMetrics {
    pub fn new(meter: &Meter) -> Self {
        Self {
            rows: meter
                .u64_counter("pipeline.rows.written")
                .with_unit("1")
                .with_description("Rows written to the sink")
                .build(),
            files: meter.u64_counter("pipeline.files.written").with_unit("1").build(),
            flush_ms: meter
                .f64_histogram("pipeline.flush.duration")
                .with_unit("ms")
                .with_boundaries(vec![1.0, 5.0, 20.0, 100.0, 500.0, 2_000.0])
                .build(),
            freshness_s: meter
                .f64_histogram("pipeline.freshness")
                .with_unit("s")
                .with_boundaries(vec![60.0, 300.0, 900.0, 3_600.0, 21_600.0])
                .build(),
        }
    }

    pub fn record_flush(&self, stage: &str, rows: u64, files: u64, elapsed_ms: f64, freshness_s: f64) {
        let attrs = [KeyValue::new("stage", stage.to_string())];
        self.rows.add(rows, &attrs);
        self.files.add(files, &attrs);
        self.flush_ms.record(elapsed_ms, &attrs);
        self.freshness_s.record(freshness_s, &attrs);
    }
}

pub fn init() -> PipelineMetrics {
    // A meter provider must be installed for the global meter to emit.
    PipelineMetrics::new(&global::meter("orders-pipeline"))
}

pub fn run_span(run_id: &str, stage: &str) -> tracing::Span {
    tracing::info_span!("pipeline_stage", run_id = %run_id, stage = %stage)
}`,
          tip: "One span per stage with the run id as an attribute, not one span per record. Per-record spans cost more than the transform and make every trace unreadable."
        },
        {
          h: "Alert on the symptom, diagnose with the cause",
          p: [
            "The page should fire when data is late for a consumer, not when CPU is high. A pipeline can run at 90 percent CPU and be perfectly on time, and it can run idle while a source is dead. Define the SLO on freshness at the consumption table, alert on the burn rate, and keep the diagnostic signals - lag, error rate, queue depth - on a dashboard for the person who is already awake.",
            "Use multi-window burn rates rather than static thresholds. A freshness SLO of 15 minutes with one percent error budget is breached slowly by a gradual slowdown and instantly by an outage, and a two-window rule catches both without paging on a single slow minute. Static thresholds either page constantly during normal variance or miss the slow burn entirely."
          ],
          tip: "Every alert needs a link to the run record query for the affected table. An alert without a next step trains the team to acknowledge and ignore it."
        }
      ],
      exercise: {
        prompt: "Add a freshness SLI: given the newest event timestamp per table and the SLO in seconds, compute the burn rate, classify it as healthy, slow burn or fast burn, and choose whether to page.",
        starter: `pub enum Burn { Healthy, Slow, Fast }

pub struct Verdict { pub burn: Burn, pub page: bool, pub ratio: f64 }

pub fn evaluate(newest_event_ms: i64, now_ms: i64, slo_seconds: f64) -> Verdict {
    // burn ratio = (now - newest) / slo
    // fast: ratio > 4, slow: ratio > 1, else healthy
    todo!()
}`,
        hint: "Page only on fast burn. A single scrape above 1.0 is normal jitter; four times the SLO sustained is an incident worth waking someone for.",
        solution: `pub enum Burn { Healthy, Slow, Fast }

pub struct Verdict { pub burn: Burn, pub page: bool, pub ratio: f64 }

pub fn evaluate(newest_event_ms: i64, now_ms: i64, slo_seconds: f64) -> Verdict {
    let age_seconds = (now_ms - newest_event_ms) as f64 / 1_000.0;
    let ratio = age_seconds / slo_seconds.max(1.0);

    let burn = if ratio > 4.0 {
        Burn::Fast
    } else if ratio > 1.0 {
        Burn::Slow
    } else {
        Burn::Healthy
    };

    let page = matches!(burn, Burn::Fast);
    tracing::info!(age_seconds, ratio, page, "freshness evaluated");
    Verdict { burn, page, ratio }
}`
      },
      questions: [
        {
          q: "Why is per-stage freshness more useful than pipeline-level freshness?",
          options: [
            "It is cheaper to compute",
            "It identifies which hop consumes the latency budget instead of averaging it away",
            "It removes the need for lag metrics",
            "It only works with streaming jobs"
          ],
          answer: 1,
          explain: "A pipeline is a chain, and the aggregate hides the slow link. Stage-level SLIs show whether the source, the transform or the sink is responsible."
        },
        {
          q: "A job finishes in 40 seconds but the source has been stalled for an hour. What does freshness computed from finish time report?",
          options: [
            "Stale, because the source is stalled",
            "Fresh, which is wrong - freshness must be computed from the newest event timestamp",
            "It cannot be computed",
            "It reports lag instead"
          ],
          answer: 1,
          explain: "Job duration measures the job, not the data. Freshness is now minus the newest event timestamp; a fast job over old data is stale data delivered quickly."
        },
        {
          q: "Why alert on a multi-window burn rate instead of a static freshness threshold?",
          options: [
            "It removes the need for an SLO",
            "It catches both gradual degradation and sudden outages without paging on normal jitter",
            "It is the only way to compute lag",
            "It avoids emitting metrics"
          ],
          answer: 1,
          explain: "A static threshold either fires during ordinary variance or misses a slow burn. Two windows at different speeds distinguish jitter from a real budget burn."
        }
      ],
      quickbytes: [
        "SLIs: freshness, lag, throughput, error rate - per stage, exported as metrics.",
        "Freshness = now minus max(event_timestamp); never derive it from job finish time.",
        "Emit a run record per execution: run id, range, rows, bytes, files, code version.",
        "Page on fast burn of the freshness SLO; keep lag and error rate for diagnosis."
      ],
      production: [
        "Each output table has a freshness SLO with an error budget and a burn-rate alert.",
        "A persisted run record exists per execution and links to the trace and the lineage run id.",
        "Metrics carry pipeline, stage and table attributes emitted through one metrics facade.",
        "Every alert links to the run-record query for the affected table."
      ],
      crates: ["opentelemetry", "tracing", "tokio"],
      github: [
        { name: "open-telemetry/opentelemetry-rust", url: "https://github.com/open-telemetry/opentelemetry-rust" }
      ],
      pitfall: "Alerting on consumer lag alone: lag can be zero while the sink is silently dropping failed records, so the pipeline looks healthy and the table is wrong.",
      resources: [
        { title: "OpenTelemetry metrics specification: instruments and aggregation", url: "https://opentelemetry.io/docs/specs/otel/metrics/", kind: "docs" },
        { title: "opentelemetry crate: meters, counters and histograms", url: "https://docs.rs/opentelemetry/latest/opentelemetry/metrics/", kind: "docs" },
        { title: "open-telemetry/opentelemetry-rust: SDK and exporters", url: "https://github.com/open-telemetry/opentelemetry-rust", kind: "repo" },
        { title: "opentelemetry::global: installing a meter provider", url: "https://docs.rs/opentelemetry/latest/opentelemetry/global/index.html", kind: "docs" }
      ]
    },
    {
      id: "m20",
      title: "Data platform cost: bytes, requests and small files",
      minutes: 90,
      level: "industry",
      goal: "Model what a lake actually charges for - stored bytes, per-request operations and repeated scans - and attribute it per pipeline before optimizing.",
      sections: [
        {
          h: "You pay for three different things",
          p: [
            "Object storage bills stored bytes per month, every PUT and GET request, and egress. Compute is separate: a warehouse or query engine bills the bytes it scans, so the same table costs more every time somebody selects from it carelessly. A pipeline that writes 1 TB and is scanned 200 times a day is paying mostly for reads, and compacting it changes the bill more than compressing it does.",
            "Small files make both sides worse. A thousand 1 MB files and one 1 GB file store the same bytes, but the small ones cost a thousand PUTs to write, a thousand GETs per full scan, and more planning time per query. That is the mechanism behind the common observation that a lake gets slower and more expensive at the same time: ingestion wrote files at the wrong granularity."
          ],
          list: [
            "Storage: bytes per month, tiered by access pattern and retrieval cost",
            "Requests: PUT/GET/LIST per operation, which is why file count matters",
            "Compute: bytes scanned per query, driven by projection and partitioning",
            "Egress: bytes leaving the region or the cloud, avoidable by co-locating compute"
          ],
          tip: "Before optimizing storage, count requests. A table of tiny files can cost more in GETs than in stored bytes."
        },
        {
          h: "The three levers that actually move the number",
          p: [
            "First, scan less: partition and cluster so a typical query touches a fraction of the table, and never select columns the query does not need. Second, store fewer, larger objects: compaction cuts request count and planning time, and compression cuts bytes - but compression only helps if the bytes are read in the first place. Third, age data out: move cold partitions to a cheaper class, expire snapshots and orphans, and delete what no one has queried in a year.",
            "Order matters. Compaction and partition pruning change the request and scan model; compression changes the storage line item, which is often the smallest of the three. Teams regularly spend a quarter on a better codec and get a few percent, then find that one dashboard was scanning the entire history every fifteen minutes."
          ],
          code: `/// Illustrative us-east-1 list prices in USD. Verify against the current
/// published price list before using these numbers for a budget.
const USD_PER_GB_MONTH: f64 = 0.023;
const USD_PER_1K_PUT: f64 = 0.005;
const USD_PER_1K_GET: f64 = 0.0004;

pub struct Layout {
    pub total_bytes: u64,
    pub files: u64,
    pub queries_per_day: u64,
    pub files_per_query: u64,
}

pub fn monthly_cost(layout: &Layout) -> f64 {
    let storage = (layout.total_bytes as f64 / 1e9) * USD_PER_GB_MONTH;
    let gets = (layout.files_per_query as f64 * layout.queries_per_day as f64 * 30.0 / 1_000.0) * USD_PER_1K_GET;
    let puts = (layout.files as f64 / 1_000.0) * USD_PER_1K_PUT;
    storage + gets + puts
}

/// Fragmentation cost: the same bytes spread over factor more files.
pub fn fragmentation_delta(layout: &Layout, factor: u64) -> f64 {
    let small = Layout {
        total_bytes: layout.total_bytes,
        files: layout.files * factor,
        queries_per_day: layout.queries_per_day,
        files_per_query: layout.files_per_query * factor,
    };
    monthly_cost(&small) - monthly_cost(layout)
}

pub fn report(layout: &Layout) {
    let base = monthly_cost(layout);
    let ten_x = fragmentation_delta(layout, 10);
    tracing::info!(usd_month = base, usd_if_ten_x_files = base + ten_x, files = layout.files, "cost model");
}`,
          tip: "Model cost from files per query, not from table size. Request and planning costs scale with file count, which is independent of how many bytes the table holds."
        },
        {
          h: "Attribute before you optimize",
          p: [
            "A platform bill is an aggregate that no single team owns. Attribution starts with naming: one prefix or table per pipeline and per environment, so storage and requests can be broken down without guesswork. On the compute side, tag queries by pipeline and user, then report cost per run alongside rows produced - a pipeline that costs more per row than the value it produces is the conversation worth having.",
            "Attribution also changes behaviour. When a team sees the cost of its own dashboard refreshing every fifteen minutes, the refresh interval changes the same week. Without it, the only lever anyone has is a central mandate to use a different storage class, which is both unpopular and usually the wrong lever."
          ],
          list: [
            "One prefix per pipeline and environment, so storage splits without tagging",
            "Record bytes written and files written per run, and multiply by the price list",
            "Report cost per table and per run on the same dashboard as freshness",
            "Review the top ten tables by scan volume quarterly"
          ],
          tip: "Cost per row produced is the metric that survives reorganizations; a raw monthly total does not."
        }
      ],
      exercise: {
        prompt: "Compute and compare the monthly cost of one layout against the same bytes split into ten times as many files, then report how much of the difference is requests rather than storage.",
        starter: `pub struct Layout { pub total_bytes: u64, pub files: u64, pub queries_per_day: u64, pub files_per_query: u64 }

pub fn monthly_cost(layout: &Layout) -> f64 { todo!() }

pub fn request_share(layout: &Layout) -> f64 {
    // returns the fraction of monthly cost that is GET + PUT
    todo!()
}`,
        hint: "Storage = bytes / 1e9 * 0.023. GETs = files_per_query * queries_per_day * 30 / 1000 * 0.0004. PUTs = files / 1000 * 0.005. The request share is the last two over the total.",
        solution: `const USD_PER_GB_MONTH: f64 = 0.023;
const USD_PER_1K_PUT: f64 = 0.005;
const USD_PER_1K_GET: f64 = 0.0004;

pub struct Layout { pub total_bytes: u64, pub files: u64, pub queries_per_day: u64, pub files_per_query: u64 }

pub fn monthly_cost(layout: &Layout) -> f64 {
    let storage = (layout.total_bytes as f64 / 1e9) * USD_PER_GB_MONTH;
    let gets = (layout.files_per_query as f64 * layout.queries_per_day as f64 * 30.0 / 1_000.0) * USD_PER_1K_GET;
    let puts = (layout.files as f64 / 1_000.0) * USD_PER_1K_PUT;
    storage + gets + puts
}

pub fn request_share(layout: &Layout) -> f64 {
    let gets = (layout.files_per_query as f64 * layout.queries_per_day as f64 * 30.0 / 1_000.0) * USD_PER_1K_GET;
    let puts = (layout.files as f64 / 1_000.0) * USD_PER_1K_PUT;
    let total = monthly_cost(layout);
    if total <= 0.0 { 0.0 } else { (gets + puts) / total }
}

pub fn compare(layout: &Layout) {
    let fragmented = Layout {
        total_bytes: layout.total_bytes,
        files: layout.files * 10,
        queries_per_day: layout.queries_per_day,
        files_per_query: layout.files_per_query * 10,
    };
    tracing::info!(
        base = monthly_cost(layout),
        fragmented = monthly_cost(&fragmented),
        request_share = request_share(layout),
        "layout cost comparison"
    );
}`
      },
      questions: [
        {
          q: "Two layouts hold identical bytes. Which one costs more per full scan?",
          options: [
            "The one with fewer, larger files",
            "The one with more, smaller files, because every file is a request and a planning entry",
            "They cost the same, since bytes are equal",
            "It depends only on the compression codec"
          ],
          answer: 1,
          explain: "Object requests and planning scale with file count, not bytes. A thousand small files cost a thousand GETs for the same data a single large file would return in one."
        },
        {
          q: "A team spends a quarter improving compression and sees a small saving. What lever did they miss?",
          options: [
            "Changing the region",
            "Scans that read far more data than the query needs, because of missing partitions or column pruning",
            "Using Parquet instead of CSV",
            "Compacting small files"
          ],
          answer: 1,
          explain: "Compression reduces stored bytes, usually the smallest line item. Scan volume dominates when queries read the whole table for a single day's answer, and that is fixed by layout, not codecs."
        },
        {
          q: "Why does per-pipeline attribution matter more than a platform-wide mandate?",
          options: [
            "It reduces the storage price",
            "Teams change the behaviour they can see the cost of, such as refresh intervals and file counts",
            "It removes the need for compaction",
            "It lowers egress"
          ],
          answer: 1,
          explain: "A central mandate changes one setting. Attribution shows a team that its own dashboard costs more than the data it produces, which is what actually changes refresh intervals and write patterns."
        }
      ],
      quickbytes: [
        "Storage, requests and scanned bytes are three separate bills; file count drives the middle one.",
        "Compaction and pruning change cost more than compression, which only touches the smallest line item.",
        "Price constants are illustrative - read the current price list, and keep them in one place.",
        "One prefix per pipeline makes attribution possible without a tagging project."
      ],
      production: [
        "Each pipeline writes under its own prefix, and bytes plus files written are recorded per run.",
        "Monthly cost per table and cost per row produced appear next to freshness on the same dashboard.",
        "The top ten tables by scanned bytes are reviewed quarterly for layout changes.",
        "Retention and snapshot expiry are configured for every table, not left at the default forever."
      ],
      crates: ["object_store", "parquet", "tracing"],
      github: [
        { name: "apache/arrow-rs", url: "https://github.com/apache/arrow-rs" }
      ],
      pitfall: "Optimizing the storage line item while the request line grows: compression shaves a few percent off bytes while a chatty dashboard triples the GET count every quarter.",
      resources: [
        { title: "Amazon S3 storage classes: cost and retrieval trade-offs", url: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/selecting-content-storage-class.html", kind: "docs" },
        { title: "Amazon S3 request rate and performance considerations", url: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/request-rate-perf-considerations.html", kind: "docs" },
        { title: "S3 storage classes explained with real cost math", url: "https://www.youtube.com/watch?v=hYb4q2-Rphw", kind: "video" },
        { title: "object_store: the abstraction your lake writes through", url: "https://docs.rs/object_store/latest/object_store/", kind: "repo" }
      ]
    }
  ]
};
