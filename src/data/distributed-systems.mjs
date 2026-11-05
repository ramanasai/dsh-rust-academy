/**
 * Distributed systems track.
 *
 * Crate versions checked against crates.io while writing (Nov 2026):
 * openraft 0.9.25, raft (raft-rs) 0.7.0, turmoil 0.7.2, madsim 0.2.34,
 * proptest 1.12.0, crdts 7.3.2, tokio 1.54.1, tracing 0.1.44, serde 1.0.229.
 *
 * Data is JSON-compatible and consumed by the plugin build.
 */
export default {
  key: 'distributed-systems',
  prefix: 'e',
  title: 'Distributed systems',
  blurb: 'Consensus, replication, consistency models and the failure modes that decide whether a distributed system survives production.',
  level: 'industry',
  project: {
    title: 'Capstone: a replicated key-value store',
    brief: 'Implement a Raft-replicated KV store from the paper rather than from a library: leader election with pre-vote, log replication with the consistency check, snapshotting that truncates the log, and single-node membership changes. Then break it on purpose under turmoil and prove the surviving client history is linearizable.',
    deliverables: [
      'Leader election and log replication: randomized timeouts, prevote, AppendEntries conflict repair, and a commit rule that never commits a previous-term entry by counting replicas alone.',
      'Snapshotting and membership changes: a snapshot at a log index, log truncation, InstallSnapshot for lagging followers, and one-server-at-a-time reconfiguration.',
      'Fault-injection tests: turmoil scenarios for partition, crash, pause, and latency that assert safety (one leader per term, no committed entry lost) and liveness (a leader within N ticks).',
      'Linearizability checks: a bounded Wing-Gong search over recorded client histories, run under proptest with shrinking so a failure yields a minimal interleaving.',
      'An operations surface: per-node tracing spans carrying term and commit index, a metrics endpoint for election count and log lag, and a README with the failure modes you accepted.',
    ],
    stack: ['tokio', 'serde', 'tracing', 'turmoil', 'proptest'],
  },
  lessons: [
    {
      id: 'e01',
      title: 'CAP and PACELC: the trade-off is per operation',
      minutes: 60,
      level: 'core',
      goal: 'Read CAP as a partition-time choice between linearizability and availability, add PACELC for the normal case, and place the decision at the call site instead of in a database slogan.',
      sections: [
        {
          h: 'What CAP actually claims',
          p: [
            "Brewer's 2000 conjecture, formalized by Gilbert and Lynch in 2002, is narrower than the slogan. Consistency means linearizability: every operation appears to take effect atomically at a single point between its invocation and its response. Availability means every request to a non-failing node eventually returns a non-error response - with no latency bound. Partition tolerance means the network may drop arbitrary messages between nodes.",
            "Since partitions are a property of networks and not a design option, the theorem only bites while a partition is in progress: at that moment you either wait (and risk not answering) or answer from a partial view (and risk being wrong). A single-node database is not 'CA'; it simply has no partition to tolerate, and the moment your app talks to it over a network, the choice is back.",
          ],
          list: [
            'C = linearizability, not "the replicas agree" and not "no torn writes"',
            'A = a non-error response, so a 30-second timeout followed by an error is not availability',
            'P = arbitrary message loss, which includes the asymmetric partition you did not test',
            'Most applications need a weaker property than linearizability; naming it precisely is the design work',
          ],
          tip: 'If a vendor says CA, ask what happens when the health check passes but one switch drops packets between two racks.',
        },
        {
          h: 'PACELC adds the case you run in every day',
          p: [
            "Abadi's PACELC extends the question: if there is a Partition, choose Availability or Consistency; Else, choose Latency or Consistency. The else branch is where most traffic lives. A quorum read that waits for two replicas in three regions has not partitioned anything - it simply costs a cross-region round trip to be sure the answer is current.",
            "That makes the normal-case trade-off a dial rather than a switch. Spanner picks consistency and pays commit-wait plus TrueTime hardware; Dynamo picks availability and latency and pushes reconciliation to the application. Both are defensible because someone measured the cost of the other side. The failure mode is picking a side by accident, then discovering it during an incident.",
          ],
          code: `use std::time::Duration;

/// Where the CAP/PACELC decision actually lives: at the call site, per
/// operation, not in one global database setting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Quorum read. Correct while partitioned, fails when a quorum is
    /// unreachable, and pays a round trip on every call.
    Linearizable,
    /// Any reachable replica, bounded by how old the answer may be.
    BoundedStale(Duration),
}

#[derive(Debug, PartialEq, Eq)]
pub enum ReadError {
    Unavailable,
    TooStale(Duration),
    Missing,
}

pub trait Replicas {
    fn reachable(&self) -> usize;
    fn quorum(&self) -> usize;
    fn read_quorum(&self, key: &str) -> Option<(u64, Duration)>;
    fn read_any(&self, key: &str) -> Option<(u64, Duration)>;
}

pub fn read(store: &dyn Replicas, key: &str, mode: Mode) -> Result<u64, ReadError> {
    match mode {
        Mode::Linearizable => {
            if store.reachable() < store.quorum() {
                return Err(ReadError::Unavailable);
            }
            store.read_quorum(key).map(|(v, _)| v).ok_or(ReadError::Missing)
        }
        Mode::BoundedStale(max_age) => {
            let (value, age) = store.read_any(key).ok_or(ReadError::Missing)?;
            if age > max_age {
                return Err(ReadError::TooStale(age));
            }
            Ok(value)
        }
    }
}`,
          tip: 'The stale branch is a fallback, so it must not call the quorum path internally. A fallback that depends on the thing that is down is not a fallback.',
        },
        {
          h: 'Write the choice down, then test it',
          p: [
            "A consistency decision that is not in code is a rumour. Put the mode in the request type or the handler signature so a reviewer can see which endpoints are linearizable, and make the fallback observable: a request served stale should increment a different counter than a request that failed, because they are different user experiences.",
            "The test that matters is not 'does it work when healthy' but 'when I cut the link between the two replicas that hold the hot key, what does each endpoint return within its deadline'. If the answer is a 500 after the load balancer's 30-second timeout, you chose CP by accident and shipped the worst version of it.",
          ],
          production: [
            'Every read and write path names its consistency mode in the handler signature or request type.',
            'Stale-served requests and failed requests are separate metrics, with separate alerts.',
            'The degraded path is load-tested at production QPS; it must not depend on the healthy path.',
            'Each choice is recorded in an ADR with the measured latency cost of the consistent branch.',
            'Client deadlines are shorter than server-side quorum waits, so the caller gets a decision instead of a hang.',
          ],
          tip: 'Measure the consistent path before you promise it. "Linearizable reads add 40 ms p99" is a decision; "we are strongly consistent" is a hope.',
        },
      ],
      exercise: {
        prompt: 'Given a quorum configuration (n, r, w) and the number of currently reachable replicas, return the strongest read mode the caller can still satisfy, or None when neither branch is legal. Treat a write quorum as satisfied only when reachable >= w.',
        starter: `#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode { Linearizable, BoundedStale }

#[derive(Clone, Copy, Debug)]
pub struct Quorum { pub n: usize, pub r: usize, pub w: usize }

/// Return the strongest mode that can still be served, or None.
pub fn serve_mode(q: Quorum, reachable: usize) -> Option<Mode> {
    // 1. linearizable requires reachable >= r
    // 2. bounded-stale requires at least one reachable replica
    todo!()
}`,
        hint: 'Linearizable needs reachable >= q.r. Bounded stale needs reachable >= 1. Also reject configurations where r + w <= n, because the quorums would not intersect.',
        solution: `#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode { Linearizable, BoundedStale }

#[derive(Clone, Copy, Debug)]
pub struct Quorum { pub n: usize, pub r: usize, pub w: usize }

#[derive(Debug, PartialEq, Eq)]
pub enum ConfigError { Empty, QuorumsDoNotIntersect }

impl Quorum {
    pub fn validate(self) -> Result<Self, ConfigError> {
        if self.n == 0 || self.r == 0 || self.w == 0 {
            return Err(ConfigError::Empty);
        }
        if self.r + self.w <= self.n {
            return Err(ConfigError::QuorumsDoNotIntersect);
        }
        if self.r > self.n || self.w > self.n {
            return Err(ConfigError::Empty);
        }
        Ok(self)
    }
}

pub fn serve_mode(q: Quorum, reachable: usize) -> Option<Mode> {
    let q = q.validate().ok()?;
    if reachable >= q.r {
        Some(Mode::Linearizable)
    } else if reachable >= 1 {
        Some(Mode::BoundedStale)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn degrades_when_quorum_is_lost() {
        let q = Quorum { n: 3, r: 2, w: 2 }.validate().unwrap();
        assert_eq!(serve_mode(q, 3), Some(Mode::Linearizable));
        assert_eq!(serve_mode(q, 2), Some(Mode::Linearizable));
        assert_eq!(serve_mode(q, 1), Some(Mode::BoundedStale));
        assert_eq!(serve_mode(q, 0), None);
    }
}`,
      },
      questions: [
        {
          q: 'Which definition of availability does the CAP theorem use?',
          options: [
            'Every request to a non-failing node returns a non-error response, with no latency bound',
            'Every request completes within a fixed p99 latency target',
            'Every node can accept writes at all times',
            'Every replica eventually converges to the same value',
          ],
          answer: 0,
          explain: 'Gilbert and Lynch define availability as a response from every non-failing node, with no timing requirement. That is why a slow quorum read is still available in the CAP sense, while a request that errors after a timeout is not.',
        },
        {
          q: 'During a partition, a store keeps answering reads from whichever replica is reachable and reconciles later. Which CAP classification fits?',
          options: [
            'AP: available, but not linearizable while partitioned',
            'CP: consistent, so availability is not affected',
            'CA: no partition exists from the client point of view',
            'Neither, because CAP only applies to single-key operations',
          ],
          answer: 0,
          explain: 'Answering from a partial view is exactly the availability side of the trade-off: the system stays available and gives up linearizability for the duration of the partition. Reconcile-later is the eventual consistency half of that choice.',
        },
        {
          q: 'What does the "else" branch of PACELC constrain?',
          options: [
            'Latency versus consistency when the network is healthy',
            'Availability versus durability when a disk fails',
            'Read versus write quorum sizes in a leaderless store',
            'The number of replicas needed to survive a rack failure',
          ],
          answer: 0,
          explain: 'PACELC says: on Partition choose A or C, Else choose Latency or Consistency. The normal case is a latency bill - cross-region quorum waits, commit-wait, read-your-writes tokens - not a binary switch.',
        },
      ],
      quickbytes: [
        'CAP is per operation: one endpoint can be CP and another AP inside the same service.',
        'A timeout looks identical to a partition from inside the process; handle both with the same fallback path.',
        'If you cannot state the stale-read tolerance in milliseconds, you have not chosen a consistency model.',
        'Count "served stale" separately from "failed" - they are different incidents with different pages.',
      ],
      production: [
        'Every read and write path declares its consistency mode where a reviewer can see it.',
        'Degraded-mode traffic is exercised by a chaos test, not only by a manual runbook step.',
        'The consistent branch has a measured p99 latency number attached to its ADR.',
        'Server quorum waits are shorter than client deadlines, so callers receive an answer rather than a socket close.',
        'Dashboards separate stale answers, hard failures, and slow answers.',
      ],
      crates: ['tokio', 'serde', 'tracing', 'thiserror'],
      github: [
        { name: 'tokio-rs/tokio', url: 'https://github.com/tokio-rs/tokio' },
        { name: 'serde-rs/serde', url: 'https://github.com/serde-rs/serde' },
      ],
      pitfall: 'Calling a single-region Postgres "CA" and never implementing a fallback. The first real partition between the app tier and the database produces 30-second hangs, which is neither consistent nor available, and nobody owns the degraded behaviour.',
      resources: [
        { title: "Brewer's conjecture and the feasibility of consistent, available, partition-tolerant web services", url: 'https://dl.acm.org/doi/10.1145/564585.564601', kind: 'paper' },
        { title: 'Spanner: Google globally-distributed database (OSDI 2012)', url: 'https://www.usenix.org/conference/osdi12/technical-sessions/presentation/corbett', kind: 'paper' },
        { title: 'Dynamo: Amazon highly available key-value store (SOSP 2007)', url: 'https://dl.acm.org/doi/10.1145/1294261.1294281', kind: 'paper' },
        { title: 'openraft: Raft building blocks with pluggable storage and network', url: 'https://docs.rs/openraft/latest/openraft/', kind: 'docs' },
        { title: 'RaftScope: interactive Raft visualisation', url: 'https://raft.github.io/raftscope/index.html', kind: 'docs' },
      ],
    },
    {
      id: 'e02',
      title: 'Consistency models you can test',
      minutes: 75,
      level: 'core',
      goal: 'Separate linearizable, sequential, causal and eventual behaviour by the histories each permits, and implement the session guarantees applications actually depend on.',
      sections: [
        {
          h: 'The hierarchy is about real-time order',
          p: [
            "All of these models agree that every client sees its own operations in program order. They differ on how other clients' operations may be ordered. Sequential consistency allows any single total order that respects each client's order; linearizability adds the real-time constraint, so an operation that finished before another started must appear before it. Causal consistency only orders operations related by happens-before, which leaves concurrent writes visible in different orders at different replicas.",
            "The practical consequence: sequential and causal histories can be produced by a system with no wall-clock coordination, while linearizability needs a round of communication (a quorum read, a leader lease, or a timestamp oracle). Eventual consistency is not a fourth rung on the same ladder - it says nothing about ordering and only promises convergence once writes stop, which is why it is compatible with almost any anomaly you can imagine.",
          ],
          list: [
            'Linearizable: one total order plus real-time order',
            'Sequential: one total order, no real-time constraint',
            'Causal: order only around happens-before; concurrent writes may be seen in either order',
            'Eventual: convergence after quiescence, no per-read guarantee',
          ],
          tip: 'Never write "strongly consistent" in a design doc. Write the model name, then a test that fails if the model is violated.',
        },
        {
          h: 'A register checker you can run in CI',
          p: [
            "A history is a list of completed operations with invocation and response times. Checking linearizability means asking whether some sequential order exists that respects real-time precedence and where every read returns the value written by the immediately preceding write. The search is exponential in the worst case, which is fine for regression-sized histories of a few dozen operations.",
            "This is the algorithm behind the tools that find real bugs: record what clients observed, then try to explain it sequentially. If no explanation exists, either the implementation or your assumption about the model is wrong - and both are worth knowing before a customer does.",
          ],
          code: `/// One completed operation on a single register.
#[derive(Clone, Debug)]
pub struct Op {
    pub start: u64,
    pub end: u64,
    pub write: Option<u64>, // Some(v) for a write
    pub read: Option<u64>,  // Some(v) for what the read returned
}

/// Bounded Wing-Gong search for one register.
pub fn linearizable(history: &[Op]) -> bool {
    let mut pending = history.to_vec();
    search(&mut pending, 0)
}

fn search(pending: &mut Vec<Op>, state: u64) -> bool {
    if pending.is_empty() {
        return true;
    }
    // Only operations that started before the earliest pending response can
    // be linearized next; anything later would violate real-time order.
    let horizon = pending.iter().map(|op| op.end).min().unwrap();

    for i in 0..pending.len() {
        if pending[i].start > horizon {
            continue;
        }
        let op = pending[i].clone();
        let next_state = match (op.write, op.read) {
            (Some(v), _) => v,
            (None, Some(v)) if v == state => state,
            _ => continue,
        };
        pending.remove(i);
        if search(pending, next_state) {
            return true;
        }
        pending.insert(i, op);
    }
    false
}`,
          tip: 'Search order matters for speed, not correctness: try the operation with the earliest end first and the checker usually finds a witness in one pass.',
        },
        {
          h: 'Session guarantees are the ones users notice',
          p: [
            "Most products cannot afford linearizable reads everywhere, but they must avoid the anomalies users describe: reading your own profile edit and seeing the old name, or refreshing twice and watching the timestamp go backwards. Those are session guarantees, and they are cheaper because they only constrain one client's view.",
            "The mechanism is a version token. The write returns a version, the client carries it on subsequent reads, and a replica that has not applied that version either waits, forwards, or refuses. Monotonic reads use the same token to prevent a refresh from hitting a lagging replica. The cost is one header and a per-replica applied-version check, not a quorum.",
          ],
          code: `use std::time::Duration;

/// What a client must remember between requests.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SessionToken {
    pub last_write_version: u64,
    pub last_read_version: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ReadError {
    /// The replica is behind the client's own writes; wait or forward.
    Behind { applied: u64, required: u64 },
    /// Nothing wrong, just not caught up within the budget.
    Timeout,
}

pub trait Replica {
    fn applied_version(&self) -> u64;
    fn read(&self, key: &str) -> Option<u64>;
}

/// Read-your-writes plus monotonic reads, enforced client-side.
pub async fn read_sticky(
    replica: &dyn Replica,
    key: &str,
    token: &mut SessionToken,
) -> Result<u64, ReadError> {
    let required = token.last_write_version.max(token.last_read_version);
    let applied = replica.applied_version();
    if applied < required {
        return Err(ReadError::Behind { applied, required });
    }
    let value = replica.read(key).ok_or(ReadError::Timeout)?;
    token.last_read_version = applied;
    Ok(value)
}`,
          tip: 'Return the applied version with every response. Without it the client cannot tell a slow replica from a stale one, and retry logic becomes guesswork.',
        },
      ],
      exercise: {
        prompt: 'Implement a session gateway that satisfies read-your-writes and monotonic reads across a replica set: pick the first replica whose applied version meets the token, wait up to a budget for that version, and update the token. Return the value and the replica you used.',
        starter: `use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, Default)]
pub struct SessionToken {
    pub last_write_version: u64,
    pub last_read_version: u64,
}

pub struct Replica {
    pub name: &'static str,
    pub applied_version: u64,
    pub value: Option<u64>,
}

/// Try each replica until one satisfies the token; total wait <= budget.
pub fn read(
    replicas: &[Replica],
    token: &mut SessionToken,
    _budget: Duration,
) -> Option<(String, u64)> {
    // 1. required = max(last_write, last_read)
    // 2. first replica with applied >= required answers
    // 3. update last_read_version to what the replica had applied
    todo!()
}`,
        hint: 'Sort candidates by applied version descending so the freshest eligible replica wins. If none qualifies, return None and let the caller retry after the replication lag budget - do not silently serve stale data after a write.',
        solution: `use std::time::Duration;

#[derive(Clone, Copy, Debug, Default)]
pub struct SessionToken {
    pub last_write_version: u64,
    pub last_read_version: u64,
}

pub struct Replica {
    pub name: &'static str,
    pub applied_version: u64,
    pub value: Option<u64>,
}

pub fn read(
    replicas: &[Replica],
    token: &mut SessionToken,
    _budget: Duration,
) -> Option<(String, u64)> {
    let required = token.last_write_version.max(token.last_read_version);
    let mut best: Option<&Replica> = None;

    for r in replicas {
        if r.applied_version < required {
            continue;
        }
        if best.map_or(true, |b| r.applied_version > b.applied_version) {
            best = Some(r);
        }
    }

    let chosen = best?;
    let value = chosen.value?;
    token.last_read_version = chosen.applied_version;
    Some((chosen.name.to_string(), value))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn replica(name: &'static str, applied: u64, value: u64) -> Replica {
        Replica { name, applied_version: applied, value: Some(value) }
    }

    #[test]
    fn never_serves_behind_own_write() {
        let r = [replica("fast", 9, 42), replica("slow", 3, 41)];
        let mut token = SessionToken { last_write_version: 5, last_read_version: 5 };
        let (name, value) = read(&r, &mut token, Duration::from_millis(50)).unwrap();
        assert_eq!((name.as_str(), value), ("fast", 42));
        assert_eq!(token.last_read_version, 9);
    }

    #[test]
    fn refuses_when_nothing_is_fresh_enough() {
        let r = [replica("slow", 3, 41)];
        let mut token = SessionToken { last_write_version: 5, last_read_version: 0 };
        assert!(read(&r, &mut token, Duration::from_millis(10)).is_none());
        assert_eq!(token.last_read_version, 0);
    }
}`,
      },
      questions: [
        {
          q: 'Which behaviour is allowed by sequential consistency but forbidden by linearizability?',
          options: [
            'Two clients see different orders for concurrent writes',
            'A read that started after another client write completed returns the old value',
            'A client sees its own writes out of order',
            'A read returns a value that was never written',
          ],
          answer: 1,
          explain: 'Sequential consistency only fixes one total order consistent with program order; it does not require that order to respect real time. Linearizability adds the real-time constraint, so a later read must observe an earlier completed write.',
        },
        {
          q: 'What does a read-your-writes token actually require from a replica?',
          options: [
            'That it has applied at least the version the client last observed',
            'That it is the leader for the partition',
            'That it participated in the write quorum',
            'That its wall clock is within one second of the writer',
          ],
          answer: 0,
          explain: 'The guarantee is about applied state, not role or clock. Any replica that has replayed up to the client version can answer; a leader that has not applied it cannot.',
        },
        {
          q: 'Why is eventual consistency compatible with almost every anomaly?',
          options: [
            'It constrains only what happens after writes stop, so per-read ordering is unconstrained',
            'It requires a quorum for every read, which hides anomalies',
            'It forbids concurrent writes by construction',
            'It uses wall-clock timestamps to order all operations',
          ],
          answer: 0,
          explain: 'Eventual consistency promises convergence once writes quiesce. It says nothing about what a read may observe while writes continue, so stale, reordered, and non-monotonic reads are all permitted.',
        },
      ],
      quickbytes: [
        'Write the model name in the code comment; "strongly consistent" is untestable.',
        'A version token is cheaper than a sticky session: any caught-up replica can answer.',
        'Linearizable reads require linearizable writes; mixing the two creates read-modify-write races.',
        'Keep a record of real client histories: they are the only evidence that your model holds.',
      ],
      production: [
        'Each public endpoint documents its model and has a test that fails when the model is broken.',
        'Clients carry an applied-version token on reads that follow their own writes.',
        'Chaos tests include a lagging replica, not only a failed one.',
        'Session guarantees are tested with two clients, because a single client hides the anomaly.',
        'The linearizability checker runs on captured production histories in CI, with a step budget.',
      ],
      crates: ['proptest', 'serde', 'tokio', 'tracing'],
      github: [
        { name: 'proptest-rs/proptest', url: 'https://github.com/proptest-rs/proptest' },
        { name: 'tokio-rs/tokio', url: 'https://github.com/tokio-rs/tokio' },
      ],
      pitfall: 'Enforcing read-your-writes with a sticky session instead of a version: the cookie expires, the load balancer rehashes, and the next read lands on a replica that has not applied the write the user just made.',
      resources: [
        { title: 'Linearizability: a correctness condition for concurrent objects', url: 'https://dl.acm.org/doi/10.1145/78969.78972', kind: 'paper' },
        { title: 'Highly available transactions: virtues and limitations', url: 'https://dl.acm.org/doi/10.14778/2732232.2732237', kind: 'paper' },
        { title: 'proptest: property-based testing for Rust', url: 'https://docs.rs/proptest/latest/proptest/', kind: 'docs' },
        { title: 'Raft paper: safety, log matching, and committed entries', url: 'https://raft.github.io/raft.pdf', kind: 'paper' },
      ],
    },
    {
      id: 'e03',
      title: 'Replication strategies and quorum arithmetic',
      minutes: 70,
      level: 'core',
      goal: 'Compare single-leader, multi-leader and leaderless replication, prove the R + W > N overlap you rely on, and implement a write path that waits for a quorum with a deadline.',
      sections: [
        {
          h: 'Three shapes, three failure modes',
          p: [
            "Single-leader replication gives one order for writes and an obvious conflict story: none. Its cost is failover, and the window where the old leader still believes it leads. Multi-leader removes the write bottleneck across regions and buys conflict resolution - last-write-wins, per-field merge, or CRDTs - plus the certainty that some conflicts will be resolved wrongly. Leaderless replication writes to W replicas and reads from R, trading coordination for version reconciliation at read time.",
            "Chain replication, from the OSDI 2004 paper, is the useful fourth option: writes enter at the head and flow down the chain, reads are served at the tail. It gets strong consistency with high throughput because only the tail answers reads, at the cost of a longer write path and a more delicate failure recovery than quorum replication.",
          ],
          list: [
            'Single leader: one write order, failover is the risk surface',
            'Multi leader: local writes, conflicts are the risk surface',
            'Leaderless quorums: no failover, read repair and version reconciliation are the risk surface',
            'Chain replication: tail reads, head writes, strong consistency with a serial pipeline',
          ],
          tip: 'Choose by the failure you would rather debug at 3 a.m.: failover, conflict resolution, or read repair.',
        },
        {
          h: 'Quorum arithmetic has an assumption',
          p: [
            "R + W > N means every read set intersects every write set, so a read necessarily touches at least one replica that saw the latest acknowledged write. It does not mean the read returns that value: if the replicas disagree, the read path must compare versions and repair, otherwise it can return the copy from the replica that missed the write.",
            "The second assumption is that the replica set is fixed. During a rebalance or a node replacement, the set that acknowledged a write is not the set that serves the next read, so quorum overlap holds only within a configuration. This is why leaderless stores attach the configuration to each write and why changing membership without care silently weakens the guarantee.",
          ],
          code: `use std::time::Duration;
use futures::stream::{FuturesUnordered, StreamExt};
use tokio::time::timeout;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Quorum {
    pub n: usize,
    pub r: usize,
    pub w: usize,
}

impl Quorum {
    pub fn validate(self) -> Result<Self, &'static str> {
        if self.n == 0 || self.r == 0 || self.w == 0 || self.r > self.n || self.w > self.n {
            return Err("invalid quorum size");
        }
        if self.r + self.w <= self.n {
            return Err("read and write quorums do not intersect");
        }
        Ok(self)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum WriteError {
    QuorumLost { needed: usize },
    BadConfig(&'static str),
}

/// Fan out to all N replicas, count the first W acks, ignore stragglers.
pub async fn write_with_quorum<F, Fut>(
    q: Quorum,
    deadline: Duration,
    mut send: F,
) -> Result<u64, WriteError>
where
    F: FnMut(usize) -> Fut,
    Fut: std::future::Future<Output = Result<u64, ()>>,
{
    let q = q.validate().map_err(WriteError::BadConfig)?;
    let mut calls: FuturesUnordered<_> = (0..q.n).map(&mut send).collect();
    let outcome = timeout(deadline, async move {
        let (mut acks, mut version) = (0usize, 0u64);
        while let Some(result) = calls.next().await {
            if let Ok(v) = result {
                acks += 1;
                version = version.max(v);
                if acks == q.w {
                    return Some(version);
                }
            }
        }
        None
    })
    .await;
    match outcome {
        Ok(Some(version)) => Ok(version),
        _ => Err(WriteError::QuorumLost { needed: q.w }),
    }
}`,
          tip: 'Count acknowledgements for the specific write, not for the connection: a replica that reconnects and acks an older write can push the count over W while the new write is still missing.',
        },
        {
          h: 'Replication lag is a number you must publish',
          p: [
            "Every asynchronous replica strategy creates a gap between the acknowledged write and the replica that can serve it. That gap is the product decision: if the read replica lags 400 ms, a user who saves and immediately reloads may see the old value even though the write returned 200 OK. Either the client carries a token, the read is routed to the leader for a short window, or the UI pretends nothing happened.",
            "Publish lag per replica and per partition, and alert on the shape, not just the level. A lag that grows linearly with write throughput is a capacity problem; a lag that spikes and recovers on every compaction is a tuning problem; a lag that is flat at 30 seconds on exactly one replica is usually a stuck apply loop.",
          ],
          list: [
            'Synchronous quorum: ack means durable on W replicas, latency follows the slowest of W',
            'Asynchronous: ack means local durability, read replicas can lag arbitrarily',
            'Semi-synchronous: ack after one remote replica, a middle ground with a different failure mode',
            'Lag must be measured per replica and per shard, not as a cluster average',
          ],
          tip: 'Alert on replication lag as a fraction of the read-your-writes window, not as a raw number of seconds that nobody can interpret.',
        },
      ],
      exercise: {
        prompt: 'Implement a read path for a leaderless store: read from R replicas in parallel, pick the value with the highest version, and repair any replica whose version is lower. Return an error when fewer than R replicas answer within the deadline.',
        starter: `use std::time::Duration;

pub struct ReplicaValue {
    pub replica: usize,
    pub version: u64,
    pub value: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ReadError {
    QuorumLost { got: usize, needed: usize },
    Empty,
}

/// Read from R replicas, resolve by version, and record repairs.
pub async fn read_with_repair<F, Fut>(
    n: usize,
    r: usize,
    deadline: Duration,
    send: F,
) -> Result<(String, Vec<usize>), ReadError>
where
    F: FnMut(usize) -> Fut,
    Fut: std::future::Future<Output = Option<ReplicaValue>>,
{
    todo!()
}`,
        hint: 'Collect answers until R arrive, keep the max version, then repair every responder whose version is below it. If fewer than R answer, fail the read - do not return a stale value as if it were a quorum read.',
        solution: `use std::time::Duration;
use tokio::time::timeout;

pub struct ReplicaValue {
    pub replica: usize,
    pub version: u64,
    pub value: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ReadError {
    QuorumLost { got: usize, needed: usize },
    Empty,
}

pub async fn read_with_repair<F, Fut>(
    n: usize,
    r: usize,
    deadline: Duration,
    mut send: F,
) -> Result<(String, Vec<usize>), ReadError>
where
    F: FnMut(usize) -> Fut,
    Fut: std::future::Future<Output = Option<ReplicaValue>>,
{
    let r = r.min(n);
    let calls: Vec<_> = (0..n).map(&mut send).collect();

    let answers = timeout(deadline, async {
        use futures::stream::{FuturesUnordered, StreamExt};
        let mut set: FuturesUnordered<_> = calls.into_iter().collect();
        let mut got: Vec<ReplicaValue> = Vec::with_capacity(r);
        while let Some(item) = set.next().await {
            if let Some(v) = item {
                got.push(v);
                if got.len() == r {
                    break;
                }
            }
        }
        got
    })
    .await
    .unwrap_or_default();

    if answers.len() < r {
        return Err(ReadError::QuorumLost { got: answers.len(), needed: r });
    }

    let best = answers
        .iter()
        .max_by_key(|v| v.version)
        .ok_or(ReadError::Empty)?;

    let stale: Vec<usize> = answers
        .iter()
        .filter(|v| v.version < best.version)
        .map(|v| v.replica)
        .collect();

    Ok((best.value.clone(), stale))
}`,
      },
      questions: [
        {
          q: 'N = 5, W = 2, R = 2. What does the configuration actually guarantee?',
          options: [
            'Nothing about overlap: 2 + 2 is not greater than 5',
            'That reads always return the latest value',
            'That writes survive two node failures',
            'That reads and writes never conflict because N is odd',
          ],
          answer: 0,
          explain: 'R + W = 4 <= 5, so a read quorum and a write quorum can be disjoint. The store may still converge eventually, but a read is not guaranteed to intersect the last acknowledged write.',
        },
        {
          q: 'Why can quorum overlap break during a membership change?',
          options: [
            'The set that acked the write may not be the set serving the next read',
            'The version numbers are reused after a rebalance',
            'Reads use a different hash function than writes',
            'Quorum overlap only applies to multi-leader replication',
          ],
          answer: 0,
          explain: 'Overlap is a property of one configuration. When the membership moves, replicas outside the new set hold the acknowledged write while the new read quorum may not include them, so the guarantee has to be re-established by handoff or configuration-aware reads.',
        },
        {
          q: 'In chain replication, where do reads and writes enter?',
          options: [
            'Writes at the head, reads at the tail',
            'Writes at the tail, reads at the head',
            'Both at any replica, resolved by version',
            'Both at a quorum of the chain, chosen by the client',
          ],
          answer: 0,
          explain: 'The head orders writes and pushes them down the chain; the tail answers reads once it has applied them. That is what gives strong consistency with a simple read path and a longer write path.',
        },
      ],
      quickbytes: [
        'R + W > N gives overlap, not freshness; the read path still has to resolve versions.',
        'Count acks per write id, never per open connection.',
        'Replication lag is a product metric: tie its alert threshold to the read-your-writes window.',
        'During a rebalance, reads must know which configuration a value belongs to.',
      ],
      production: [
        'Quorum configuration is validated at startup and refuses to boot with R + W <= N.',
        'Write acks are counted against a write id with a deadline, not against sockets.',
        'Replication lag is exported per replica and per shard with a read-your-writes-based alert.',
        'Reconfiguration runs through the same log as data, one server at a time.',
        'Write and read paths both have a metric for "answered without full quorum" if such a mode exists.',
      ],
      crates: ['tokio', 'futures', 'serde', 'tracing'],
      github: [
        { name: 'tokio-rs/tokio', url: 'https://github.com/tokio-rs/tokio' },
        { name: 'serde-rs/serde', url: 'https://github.com/serde-rs/serde' },
      ],
      pitfall: 'Raising W to 3 "for safety" on a five-node cluster while leaving R at 2 during a rolling restart: one node replacement makes both quorums land in the same three-node subset, and the read path starts returning pre-restart values.',
      resources: [
        { title: 'Chain replication for supporting high throughput and availability (OSDI 2004)', url: 'https://www.usenix.org/legacy/events/osdi04/tech/full_papers/renesse/renesse.pdf', kind: 'paper' },
        { title: 'Dynamo: Amazon highly available key-value store (SOSP 2007)', url: 'https://dl.acm.org/doi/10.1145/1294261.1294281', kind: 'paper' },
        { title: 'Tokio mpsc: bounded channels and backpressure', url: 'https://docs.rs/tokio/latest/tokio/sync/mpsc/index.html', kind: 'docs' },
        { title: 'tokio-rs/tokio', url: 'https://github.com/tokio-rs/tokio', kind: 'repo' },
      ],
    },
    {
      id: 'e04',
      title: 'Partitioning, consistent hashing and rebalancing',
      minutes: 70,
      level: 'core',
      goal: 'Place keys across nodes with a deterministic, stable mapping, add virtual nodes for balance, and move ownership during a rebalance without dropping the guarantee you promised readers.',
      sections: [
        {
          h: 'A partitioner makes four promises',
          p: [
            "Deterministic: the same key maps to the same node on every client, in every process, forever. Stable: adding or removing one node moves roughly its share of keys and nothing else. Balanced: no node owns a wildly disproportionate share of the load. Visible: the client can compute the mapping without asking a coordinator, or can cache a versioned map that is invalidated on change.",
            "Range partitioning keeps ordered scans cheap and makes splits a metadata operation, at the cost of hot ranges when the key is a timestamp or a monotonic id. Hash partitioning spreads writes evenly and destroys locality, so range scans become fan-out queries. Most systems end up with a composite key: hash of the tenant for placement, ordered fields inside the partition for scanning.",
          ],
          list: [
            'Hash the key, not the row: a mutable field in the key silently moves the row',
            'Virtual nodes (100-256 per machine) even out the variance of a small ring',
            'Range partitions need split and merge, not just rebalance',
            'A hot key is a data-model problem; rebalancing makes it worse by moving it',
          ],
          tip: 'If the partitioner changes, every cached mapping must be invalidated in the same deploy. Pin a mapping version and reject reads against an unknown version.',
        },
        {
          h: 'A ring you can reason about',
          p: [
            "Consistent hashing places both nodes and keys on a circle and assigns each key to the first node clockwise. With one point per node the distribution has high variance; with a few hundred virtual points per node, the load concentrates within a few percent, and adding a node steals a slice from every existing node rather than reshuffling everything.",
            "The hash function must be stable across builds. Rust's DefaultHasher is explicitly allowed to change between releases, so a ring built with it can move keys after a toolchain upgrade - a silent, cluster-wide data movement during a routine build.",
          ],
          code: `/// FNV-1a: deterministic across runs, platforms and compiler versions.
/// DefaultHasher is not: its algorithm may change between Rust releases.
fn hash64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        h ^= u64::from(*byte);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

pub struct Ring {
    /// (position on the ring, node id), sorted by position.
    vnodes: Vec<(u64, u32)>,
    replicas: usize,
}

impl Ring {
    pub fn new(nodes: &[u32], vnodes_per_node: usize, replicas: usize) -> Self {
        let mut vnodes = Vec::with_capacity(nodes.len() * vnodes_per_node);
        for &node in nodes {
            for v in 0..vnodes_per_node {
                let point = format!("{node}#{v}");
                vnodes.push((hash64(point.as_bytes()), node));
            }
        }
        vnodes.sort_unstable();
        Self { vnodes, replicas: replicas.max(1) }
    }

    /// Distinct nodes walking clockwise from the key position.
    pub fn owners(&self, key: &str) -> Vec<u32> {
        let h = hash64(key.as_bytes());
        let start = self.vnodes.partition_point(|(pos, _)| *pos < h);
        let mut out = Vec::with_capacity(self.replicas);
        for step in 0..self.vnodes.len() {
            let node = self.vnodes[(start + step) % self.vnodes.len()].1;
            if !out.contains(&node) {
                out.push(node);
                if out.len() == self.replicas {
                    break;
                }
            }
        }
        out
    }
}`,
          tip: 'Add a unit test that builds a ring of five nodes, records 10k key owners, then rebuilds with a sixth node and asserts that only about one sixth of the keys moved. Regressions in the hash show up immediately.',
        },
        {
          h: 'Rebalancing is a data migration with a deadline',
          p: [
            "When ownership moves, the new owner has no data. If it starts serving reads immediately, it answers missing or empty, which is worse than stale. The safe sequence is: transfer a snapshot, replay the tail from a log, fence the old owner, then flip the mapping. During the transfer, reads either go to the old owner or are served by the new one only after it reports a caught-up version.",
            "Bound the migration. A rebalance that saturates the network also slows the writes whose log it is trying to replay, and the completion time grows without limit. Move one shard at a time, cap bytes per second, and make the operation resumable; a rebalance that restarts from zero after a coordinator crash never finishes on a large cluster.",
          ],
          list: [
            'Transfer snapshot, replay log tail, fence, then flip routing',
            'Serve no reads from a new owner until its version is caught up',
            'One shard at a time, rate-limited, resumable, with a progress metric',
            'Abort if the source falls behind or the target stops making progress',
          ],
          tip: 'Test rebalancing under continuous writes. A rebalance that only passes on a quiesced cluster will corrupt or lose the writes that arrive during the move.',
        },
      ],
      exercise: {
        prompt: 'Implement rendezvous (highest-random-weight) hashing as an alternative to the ring: owner(key) is the node maximizing hash(key, node). Test that removing a node moves only the keys that node owned.',
        starter: `fn hash64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        h ^= u64::from(*byte);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Rendezvous hashing: no ring structure, O(nodes) per lookup.
pub fn owner(key: &str, nodes: &[u32]) -> Option<u32> {
    todo!()
}`,
        hint: 'Score each node with hash64 over the concatenation of key and node id, then take the maximum. Removing a node only changes keys whose winner was that node, which is the property to assert in the test.',
        solution: `fn hash64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        h ^= u64::from(*byte);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

pub fn owner(key: &str, nodes: &[u32]) -> Option<u32> {
    nodes
        .iter()
        .map(|node| {
            let score = hash64(format!("{key}\u{0}{node}").as_bytes());
            (score, *node)
        })
        .max()
        .map(|(_, node)| node)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removing_a_node_only_moves_its_own_keys() {
        let all = [1u32, 2, 3, 4, 5];
        let fewer = [1u32, 2, 3, 5];
        let mut moved = 0;
        for i in 0..5_000u32 {
            let key = format!("user:{i}");
            let before = owner(&key, &all).unwrap();
            let after = owner(&key, &fewer).unwrap();
            if before != after {
                moved += 1;
                assert_eq!(before, 4, "only keys owned by the removed node may move");
            }
        }
        assert!(moved > 300 && moved < 1_700, "expected roughly 1/5 of keys, moved {moved}");
    }
}`,
      },
      questions: [
        {
          q: 'Why is Rust DefaultHasher unsafe for a persistent consistent-hash ring?',
          options: [
            'Its algorithm is not guaranteed stable across Rust releases, so keys can move after an upgrade',
            'It is too slow for large keys',
            'It returns a different value on each call within one process',
            'It is not thread-safe',
          ],
          answer: 0,
          explain: 'DefaultHasher is documented as unspecified and may change between releases. A cluster built on it can silently re-shuffle ownership after a toolchain upgrade, which looks like a data loss incident.',
        },
        {
          q: 'What do virtual nodes fix?',
          options: [
            'The variance in load when few nodes share a ring',
            'The need to replicate each key',
            'The cost of range scans over hash-partitioned data',
            'The consistency of reads during a rebalance',
          ],
          answer: 0,
          explain: 'With one point per node, the arcs are uneven and some nodes own far more keys. Many virtual points per node average out the variance so each machine gets a similar share, and a joining node takes a slice from every existing node.',
        },
        {
          q: 'When may a new owner start serving reads for a shard it just received?',
          options: [
            'After it has caught up to a version at least as new as the last acknowledged write for that shard',
            'As soon as the snapshot copy starts',
            'Immediately, because the routing table now points at it',
            'Only after every other shard has also finished moving',
          ],
          answer: 0,
          explain: 'Ownership is not data. Serving before catch-up turns a rebalance into stale or missing reads; the safe point is when the new owner can prove it has replayed through the last acknowledged write.',
        },
      ],
      quickbytes: [
        'Hash the key, never a mutable field: changing the field moves the row.',
        'Use a hash with a documented, frozen algorithm for anything persisted.',
        'Rate-limit rebalances; an unbounded move starves the writes it is replaying.',
        'A hot key stays hot after it moves - fix the model, not the ring.',
      ],
      production: [
        'The partitioner and its hash function are versioned and recorded with the data.',
        'Rebalance moves one shard at a time with a byte-rate cap and resumable progress.',
        'Clients fail closed on an unknown mapping version instead of guessing.',
        'A test asserts that a single node change moves only that node share of keys.',
        'Ownership changes are fenced so a paused old owner cannot serve after the flip.',
      ],
      crates: ['serde', 'tokio', 'tracing'],
      github: [
        { name: 'serde-rs/serde', url: 'https://github.com/serde-rs/serde' },
        { name: 'tokio-rs/tokio', url: 'https://github.com/tokio-rs/tokio' },
      ],
      pitfall: 'Using a HashMap iteration order or DefaultHasher to build the ring, then upgrading the toolchain: ownership shifts for a subset of keys, the old and new owners both believe they are authoritative during the deploy, and reads split between two divergent copies.',
      resources: [
        { title: 'Consistent hashing and random trees (STOC 1997)', url: 'https://dl.acm.org/doi/10.1145/258533.258660', kind: 'paper' },
        { title: 'Dynamo: partitioning and hinted handoff (SOSP 2007)', url: 'https://dl.acm.org/doi/10.1145/1294261.1294281', kind: 'paper' },
        { title: 'serde: serialising the routing table and versioned keys', url: 'https://docs.rs/serde/latest/serde/', kind: 'docs' },
        { title: 'tokio: spawning the transfer tasks', url: 'https://docs.rs/tokio/latest/tokio/', kind: 'docs' },
      ],
    },
    {
      id: 'e05',
      title: 'Raft: elections, log matching and commit rules',
      minutes: 110,
      level: 'advanced',
      goal: 'Implement the three rules that make Raft safe - the election restriction, the AppendEntries consistency check, and the current-term commit rule - and know which one breaks when a bug report says "we lost a committed write".',
      sections: [
        {
          h: 'Terms are the clock, and the election restriction is the gate',
          p: [
            "Raft divides time into terms, each starting with an election. A node votes at most once per term and only for a candidate whose log is at least as up to date: higher last term wins, and on a tie the longer log wins. That single rule is what prevents a node missing a committed entry from becoming leader and overwriting it.",
            "Election timeouts are randomized per node, typically 150-300 ms, because identical timeouts produce split votes forever. The pre-vote extension, described in the Raft dissertation, has a candidate ask whether it could win before incrementing its term; without it, a node returning from a long pause disrupts a healthy leader and forces an unnecessary election.",
          ],
          code: `pub type Term = u64;
pub type Index = u64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub term: Term,
    pub index: Index,
    pub data: Vec<u8>,
}

/// entries[i] holds index i + 1. Index 0 is the virtual sentinel.
#[derive(Default)]
pub struct Log {
    pub entries: Vec<Entry>,
}

impl Log {
    pub fn term_at(&self, index: Index) -> Option<Term> {
        if index == 0 {
            return Some(0);
        }
        self.entries.get((index - 1) as usize).map(|e| e.term)
    }

    pub fn last(&self) -> (Index, Term) {
        self.entries.last().map_or((0, 0), |e| (e.index, e.term))
    }
}

/// The election restriction: compare (last index, last term).
pub fn candidate_up_to_date(candidate: (Index, Term), voter: (Index, Term)) -> bool {
    candidate.1 > voter.1 || (candidate.1 == voter.1 && candidate.0 >= voter.0)
}`,
          tip: 'Compare the term first and the index only on a tie. Comparing total log length across terms is the classic bug that lets a stale candidate win.',
        },
        {
          h: 'AppendEntries: the consistency check and the repair',
          p: [
            "Every AppendEntries carries the index and term of the entry immediately before the new ones. A follower accepts only if it has that entry with that term; otherwise it rejects, and the leader decrements nextIndex until the logs match. This is the log matching property in action: if two logs contain an entry with the same index and term, all preceding entries are identical.",
            "Retries one index at a time are correct but slow when a follower is far behind. The optimization is to return a conflict hint - the first index of the conflicting term - so the leader can back up by a whole term in one round trip. It changes performance, not safety.",
          ],
          code: `#[derive(Debug, PartialEq, Eq)]
pub enum AppendResult {
    Ok { match_index: Index },
    /// Ask the leader to retry at first_index of the conflicting term.
    Conflict { term: Term, first_index: Index },
}

pub fn append_entries(
    log: &mut Log,
    prev: (Index, Term),
    entries: &[Entry],
) -> AppendResult {
    match log.term_at(prev.0) {
        Some(term) if term == prev.1 => {}
        Some(_) => {
            let conflict_term = log.term_at(prev.0).unwrap();
            let mut first = prev.0;
            while first > 1 && log.term_at(first - 1) == Some(conflict_term) {
                first -= 1;
            }
            return AppendResult::Conflict { term: conflict_term, first_index: first };
        }
        None => {
            return AppendResult::Conflict { term: 0, first_index: log.last().0 + 1 };
        }
    }

    for entry in entries {
        match log.term_at(entry.index) {
            Some(term) if term == entry.term => continue, // idempotent retry
            Some(_) => {
                // First conflict: truncate this and everything after it.
                log.entries.truncate((entry.index - 1) as usize);
            }
            None => {}
        }
        log.entries.push(entry.clone());
    }

    AppendResult::Ok { match_index: prev.0 + entries.len() as Index }
}`,
          tip: 'Never truncate on a matching prefix. Duplicate AppendEntries after a lost response must be a no-op, or a delayed retry erases entries the follower already committed.',
        },
        {
          h: 'Commit only counts replicas for the current term',
          p: [
            "A leader may advance commitIndex to N when a majority stores index N and entry N was created in the leader's current term. The current-term clause is not optional: an older entry replicated to a majority might still be overwritten by a future leader that lacks it, because the majority that holds it may not be the majority that elects. Figure 8 in the Raft paper is exactly this scenario.",
            "In practice the rule is easy to encode: after each successful AppendEntries response, compute the highest index replicated on a majority, then take the minimum of that and the highest index of the current term. If you find yourself committing by counting replicas alone, the symptom is a committed write that disappears after a leadership change under partition - rare in tests, reproducible under turmoil in minutes.",
          ],
          list: [
            'Advance commitIndex only for entries whose term equals the leader current term',
            'Earlier entries commit implicitly when a current-term entry commits',
            'Persist currentTerm and votedFor before responding to a vote or appending',
            'A leader never commits an entry from a previous term by counting replicas',
          ],
          tip: 'Write the Figure 8 timeline as a unit test with a fake transport: it is the cheapest way to prove your commit rule is the Raft one.',
        },
      ],
      exercise: {
        prompt: 'Implement the follower-side AppendEntries handler including fast backup: reject when prev_log_index/prev_log_term do not match, and return the first index of the conflicting term so the leader can skip a whole term. Truncate only at a genuine conflict.',
        starter: `pub type Term = u64;
pub type Index = u64;

pub struct Entry { pub term: Term, pub index: Index, pub data: Vec<u8> }

pub struct Log { pub entries: Vec<Entry> }

#[derive(Debug, PartialEq, Eq)]
pub enum AppendResult {
    Ok { match_index: Index },
    Conflict { term: Term, first_index: Index },
}

pub fn append_entries(
    log: &mut Log,
    prev: (Index, Term),
    entries: &[Entry],
) -> AppendResult {
    // 1. term_at(prev.0) must equal prev.1
    // 2. skip entries that already match
    // 3. truncate at the first mismatch, then append
    todo!()
}`,
        hint: 'Check the previous entry first. For the conflict hint, walk back while the term at first_index - 1 equals the conflicting term. Then append from the first mismatching entry onward.',
        solution: `pub type Term = u64;
pub type Index = u64;

#[derive(Clone)]
pub struct Entry { pub term: Term, pub index: Index, pub data: Vec<u8> }

#[derive(Default)]
pub struct Log { pub entries: Vec<Entry> }

impl Log {
    pub fn term_at(&self, index: Index) -> Option<Term> {
        if index == 0 { return Some(0); }
        self.entries.get((index - 1) as usize).map(|e| e.term)
    }
    pub fn last_index(&self) -> Index {
        self.entries.last().map_or(0, |e| e.index)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum AppendResult {
    Ok { match_index: Index },
    Conflict { term: Term, first_index: Index },
}

pub fn append_entries(
    log: &mut Log,
    prev: (Index, Term),
    entries: &[Entry],
) -> AppendResult {
    match log.term_at(prev.0) {
        Some(term) if term == prev.1 => {}
        Some(_) => {
            let conflict_term = log.term_at(prev.0).unwrap();
            let mut first = prev.0;
            while first > 1 && log.term_at(first - 1) == Some(conflict_term) {
                first -= 1;
            }
            return AppendResult::Conflict { term: conflict_term, first_index: first };
        }
        None => {
            return AppendResult::Conflict { term: 0, first_index: log.last_index() + 1 };
        }
    }

    for entry in entries {
        let existing = log.term_at(entry.index);
        match existing {
            Some(term) if term == entry.term => continue,
            Some(_) => log.entries.truncate((entry.index - 1) as usize),
            None => {}
        }
        log.entries.push(entry.clone());
    }

    AppendResult::Ok { match_index: prev.0 + entries.len() as Index }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(term: Term, index: Index) -> Entry { Entry { term, index, data: vec![] } }

    #[test]
    fn conflicts_truncate_and_report_the_first_index_of_the_term() {
        let mut log = Log { entries: vec![e(1, 1), e(1, 2), e(2, 3)] };
        let result = append_entries(&mut log, (1, 1), &[e(3, 2), e(3, 3)]);
        assert_eq!(result, AppendResult::Conflict { term: 2, first_index: 3 });
    }

    #[test]
    fn duplicate_append_is_a_no_op() {
        let mut log = Log { entries: vec![e(1, 1), e(1, 2)] };
        let result = append_entries(&mut log, (0, 0), &[e(1, 1), e(1, 2)]);
        assert_eq!(result, AppendResult::Ok { match_index: 2 });
        assert_eq!(log.entries.len(), 2);
    }
}`,
      },
      questions: [
        {
          q: 'Why may a leader not commit an entry from a previous term by counting replicas?',
          options: [
            'A majority holding that entry may not be the majority that elects the next leader',
            'Followers refuse to store entries from previous terms',
            'The entry may have a duplicate index',
            'Commit indexes are per term, not per log',
          ],
          answer: 0,
          explain: 'This is the Figure 8 problem. Only when an entry from the current term is stored on a majority can the leader infer that any future leader must contain it, because a future leader needs a majority and the election restriction applies.',
        },
        {
          q: 'A candidate has a shorter log but a higher last term than the voter. What does the voter do?',
          options: [
            'Grants the vote, because the last term is compared first',
            'Rejects the vote, because the log is shorter',
            'Grants the vote only if the candidate has the same commit index',
            'Asks the leader before responding',
          ],
          answer: 0,
          explain: 'The up-to-date rule compares the term of the last entry first and only uses length to break a tie. A shorter log ending in a newer term is necessarily more up to date, which is what makes the restriction safe.',
        },
        {
          q: 'What is the purpose of pre-vote?',
          options: [
            'Stop a partitioned or paused node from incrementing terms and disrupting a healthy leader',
            'Speed up log replication for new followers',
            'Allow a follower to commit without the leader',
            'Replace the election restriction for single-node clusters',
          ],
          answer: 0,
          explain: 'Pre-vote asks peers whether the candidate could win before it changes its term. Without it, a node returning from a pause starts an election, raises the cluster term, and forces the real leader to step down for no reason.',
        },
      ],
      quickbytes: [
        'Persist term and votedFor before you answer: a vote that survives a crash is the whole point.',
        'Randomize election timeouts per node, or watch split votes live forever.',
        'Return a conflict hint, not just false: one round trip instead of one per entry.',
        'Figure 8 is a unit test, not a thought experiment.',
      ],
      production: [
        'currentTerm and votedFor are fsynced before responding to RequestVote.',
        'Election timeouts are randomized and exceed the measured p99 disk fsync by a wide margin.',
        'Snapshots are taken at a log size threshold, and InstallSnapshot is exercised by a slow-follower test.',
        'A metric records elections per hour per node; a rising rate is a symptom, not noise.',
        'Log matching is asserted in debug builds: same index and term implies same prefix.',
      ],
      crates: ['tokio', 'serde', 'tracing', 'thiserror'],
      github: [
        { name: 'tikv/raft-rs', url: 'https://github.com/tikv/raft-rs' },
        { name: 'databendlabs/openraft', url: 'https://github.com/databendlabs/openraft' },
      ],
      pitfall: 'Truncating the follower log on every AppendEntries where the leader resends an older batch. A delayed duplicate then deletes committed entries, and the node that later wins an election is missing writes the client was told were durable.',
      resources: [
        { title: 'In search of an understandable consensus algorithm (Raft paper)', url: 'https://raft.github.io/raft.pdf', kind: 'paper' },
        { title: 'The Raft site: visualisation, talks and the dissertation', url: 'https://raft.github.io/', kind: 'docs' },
        { title: 'openraft: production Raft in Rust with pluggable storage', url: 'https://docs.rs/openraft/latest/openraft/', kind: 'docs' },
        { title: 'raft-rs: TiKV Raft implementation', url: 'https://docs.rs/raft/latest/raft/', kind: 'docs' },
      ],
    },
    {
      id: 'e06',
      title: 'Paxos and its variants: what the acceptor promises',
      minutes: 100,
      level: 'advanced',
      goal: 'Implement the two Paxos phases and explain the quorum intersection argument, then name the practical problems Multi-Paxos adds and why Raft is easier to operate.',
      sections: [
        {
          h: 'Two phases, one invariant',
          p: [
            "An acceptor promises never to accept a proposal numbered lower than the highest it has seen (phase 1), and accepts a value with a proposal number at least that high (phase 2). A proposer succeeds when a majority promises, then proposes the highest-numbered value among the promises - or its own value if none was accepted.",
            "The safety argument is quorum intersection: any two majorities share at least one acceptor, and that acceptor's promise prevents a lower-numbered proposal from being accepted after a higher one. Correctness does not need synchronized clocks, a leader, or a fixed membership - only that majorities intersect. That is why Paxos is the reference point even when nobody deploys plain Paxos.",
          ],
          code: `#[derive(Clone, Debug, Default)]
pub struct Acceptor {
    pub promised: Option<u64>,
    pub accepted: Option<(u64, String)>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Reject {
    Stale(u64),
}

impl Acceptor {
    /// Phase 1b: promise not to accept anything below n.
    /// Returns the value already accepted, if any, so the proposer can
    /// adopt the highest-numbered one.
    pub fn prepare(&mut self, n: u64) -> Result<Option<(u64, String)>, Reject> {
        if let Some(promised) = self.promised {
            if n <= promised {
                return Err(Reject::Stale(promised));
            }
        }
        self.promised = Some(n);
        Ok(self.accepted.clone())
    }

    /// Phase 2b: accept only if no higher promise has been made.
    pub fn accept(&mut self, n: u64, value: &str) -> Result<(), Reject> {
        if let Some(promised) = self.promised {
            if n < promised {
                return Err(Reject::Stale(promised));
            }
        }
        self.promised = Some(n);
        self.accepted = Some((n, value.to_string()));
        Ok(())
    }
}`,
          tip: 'Persist both fields before replying. An acceptor that forgets a promise after a restart can accept two different values for the same proposal number.',
        },
        {
          h: 'Multi-Paxos: the leader you did not want to write',
          p: [
            "Running phase 1 for every value is expensive, so Multi-Paxos elects a distinguished proposer that runs phase 1 once for a range of proposal numbers and then streams phase 2. That optimization is where the practical complexity appears: a leader must be stable (or clients fight), a new leader must fill holes left by its predecessor, and every replica must eventually learn which values were chosen.",
            "This is the gap between the protocol and the system. The Part-Time Parliament describes the protocol; Paxos Made Live, from the Chubby team, describes the years of work needed for snapshots, membership, disk failures, and leader leases. Raft's contribution is mostly this operational shape - a strong leader, a log without holes, and a membership change rule - expressed so that a team can implement it correctly.",
          ],
          list: [
            'Phase 1 is per-range, not per-value, once a leader is stable',
            'A new leader must recover any chosen-but-unknown values before serving',
            'Holes in the log require no-op entries or a recovery protocol',
            'Membership changes need their own agreement, or you get two quorums with different voters',
          ],
          tip: 'If you are choosing an implementation this quarter, choose Raft or an existing Paxos library. Writing Multi-Paxos from scratch is a multi-engineer-year project with a reputation for subtle bugs.',
        },
        {
          h: 'Where Paxos still wins',
          p: [
            "Paxos shines when the unit of agreement is small and independent: per-key or per-range consensus inside a larger system, where each replica group can run its own log. Google's spanner-style systems run many Paxos groups rather than one giant log, because a single log serializes unrelated writes and turns one slow disk into a global stall.",
            "It also fits systems where the leader changes rarely and the write path is mostly one-way: phase 2 with no return traffic is a single message delay. If your workload is one log with frequent leadership changes and heavy catch-up, Raft's explicit term and log-matching rules are easier to debug in an incident.",
          ],
          list: [
            'Use many small Paxos groups if keys are independent',
            'Use one Raft log if you need a single total order over a small state machine',
            'Either way, the snapshot is the hard part: size, transfer, and how to install it',
          ],
          tip: 'The interesting question is not Paxos versus Raft; it is how many independent logs you need, because that decides your failure blast radius.',
        },
      ],
      exercise: {
        prompt: 'Implement the proposer side of one Paxos round over a set of acceptors: run phase 1, adopt the highest-numbered accepted value if any promise carries one, then run phase 2 and report whether a majority accepted.',
        starter: `use crate::acceptor::{Acceptor, Reject};

pub struct Promise {
    pub accepted: Option<(u64, String)>,
}

/// Run one round with proposal number n. Return the chosen value, if any.
pub fn run_round(
    acceptors: &mut [Acceptor],
    n: u64,
    proposed: &str,
) -> Result<Option<String>, String> {
    todo!()
}`,
        hint: 'Collect promises from a majority in phase 1; if any promise carries an accepted value, propose the one with the highest proposal number instead of your own. Then require a majority of accepts in phase 2.',
        solution: `use crate::acceptor::{Acceptor, Reject};

pub struct Promise {
    pub accepted: Option<(u64, String)>,
}

pub fn run_round(
    acceptors: &mut [Acceptor],
    n: u64,
    proposed: &str,
) -> Result<Option<String>, String> {
    let majority = acceptors.len() / 2 + 1;
    let mut promises: Vec<Promise> = Vec::with_capacity(majority);
    let mut highest: Option<(u64, String)> = None;

    for acceptor in acceptors.iter_mut() {
        match acceptor.prepare(n) {
            Ok(accepted) => {
                if let Some((num, value)) = accepted.clone() {
                    if highest.as_ref().map_or(true, |(best, _)| num > *best) {
                        highest = Some((num, value));
                    }
                }
                promises.push(Promise { accepted });
                if promises.len() == majority {
                    break;
                }
            }
            Err(Reject::Stale(_)) => continue,
        }
    }

    if promises.len() < majority {
        return Err(format!("phase 1 failed: {} of {} promises", promises.len(), majority));
    }

    let value = highest.map(|(_, v)| v).unwrap_or_else(|| proposed.to_string());
    let mut accepts = 0usize;
    for acceptor in acceptors.iter_mut() {
        if acceptor.accept(n, &value).is_ok() {
            accepts += 1;
        }
    }

    if accepts >= majority {
        Ok(Some(value))
    } else {
        Err(format!("phase 2 failed: {accepts} accepts, needed {majority}"))
    }
}`,
      },
      questions: [
        {
          q: 'Why can two Paxos majorities never choose different values for the same instance?',
          options: [
            'They must share an acceptor, whose promise blocks a lower-numbered accept',
            'Because the leader is unique and elected by the largest quorum',
            'Because proposal numbers are timestamps that always increase globally',
            'Because acceptors read the value back from a shared log',
          ],
          answer: 0,
          explain: 'Safety comes from quorum intersection plus the acceptor promise. Any majority overlaps any other, and the shared acceptor can only accept a proposal at least as high as the promise it already made.',
        },
        {
          q: 'What does Multi-Paxos add to the basic protocol?',
          options: [
            'A stable distinguished proposer that runs phase 1 once for many values',
            'A second phase that removes the need for acceptors',
            'Clock synchronization for proposal ordering',
            'A membership protocol',
          ],
          answer: 0,
          explain: 'Multi-Paxos amortizes phase 1 across values by keeping one leader. The cost is leader recovery: the new leader must recover chosen values and fill holes before it can serve.',
        },
        {
          q: 'Why do large systems run many Paxos groups instead of one?',
          options: [
            'One log serializes unrelated writes, so one slow disk stalls everything',
            'Paxos only supports single-key values',
            'Multiple groups remove the need for quorums',
            'A single group cannot survive a node restart',
          ],
          answer: 0,
          explain: 'Per-key or per-range groups isolate failures and let independent writes proceed in parallel. A single log makes every write wait behind the slowest participant, which turns a local disk problem into a global outage.',
        },
      ],
      quickbytes: [
        'Persist promises and accepted values before replying; the protocol assumes crash recovery.',
        'Adopt the highest-numbered accepted value, never the most common one.',
        'A stable leader is what turns Paxos from 2 RTT per value into 1.',
        'Membership changes need consensus too, or two quorums can disagree about who votes.',
      ],
      production: [
        'Acceptor state (promise and accepted value) is fsynced with the response.',
        'Leader recovery runs before serving reads, and it is tested by killing a leader mid-write.',
        'Log holes are impossible by construction or repaired by no-ops with a test.',
        'Snapshot transfer has its own rate limit and does not block phase 2 traffic.',
        'Membership is changed through the log, never by editing a config file on live nodes.',
      ],
      crates: ['tokio', 'serde', 'tracing'],
      github: [
        { name: 'tikv/raft-rs', url: 'https://github.com/tikv/raft-rs' },
        { name: 'etcd-io/etcd', url: 'https://github.com/etcd-io/etcd' },
      ],
      pitfall: 'Reusing proposal numbers after a leader restart because the number was kept in memory only. Two proposers can then run phase 2 with the same number and different values, and acceptors will accept both, breaking the single-value invariant without any crash visible in the logs.',
      resources: [
        { title: 'The part-time parliament (Paxos, TOCS 1998)', url: 'https://dl.acm.org/doi/10.1145/279227.279229', kind: 'paper' },
        { title: 'Spanner: Paxos groups in production (OSDI 2012)', url: 'https://www.usenix.org/conference/osdi12/technical-sessions/presentation/corbett', kind: 'paper' },
        { title: 'Raft paper: the operational alternative to Multi-Paxos', url: 'https://raft.github.io/raft.pdf', kind: 'paper' },
        { title: 'openraft storage traits: log storage and state machine', url: 'https://docs.rs/openraft/latest/openraft/storage/index.html', kind: 'docs' },
      ],
    },
    {
      id: 'e07',
      title: 'Vector clocks: detecting concurrency, not ordering it',
      minutes: 80,
      level: 'advanced',
      goal: 'Encode happens-before with one counter per writer, merge clocks pointwise, distinguish concurrent from ordered versions, and recognise the metadata cost before it becomes an incident.',
      sections: [
        {
          h: 'Happens-before without a clock',
          p: [
            "Lamport's happened-before relation orders events by causality: events in one process are ordered, a send precedes its receive, and transitivity extends the order. Wall clocks cannot represent this because they disagree; counters can, because they only encode what a process has actually observed.",
            "A vector clock is one counter per writer. Local events increment the local entry; receiving a message merges the sender's vector with your own by taking the maximum per entry. With that structure, A happens-before B exactly when every entry of A is less than or equal to B's and at least one is strictly smaller. Neither smaller nor larger in every entry means concurrent, which is a fact, not a failure.",
          ],
          code: `use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct VClock(BTreeMap<String, u64>);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Order {
    Before,
    After,
    Equal,
    Concurrent,
}

impl VClock {
    pub fn incr(&mut self, node: &str) -> u64 {
        let counter = self.0.entry(node.to_string()).or_insert(0);
        *counter += 1;
        *counter
    }

    /// Pointwise maximum: everything this replica has observed.
    pub fn merge(&mut self, other: &VClock) {
        for (node, &count) in &other.0 {
            let entry = self.0.entry(node.clone()).or_insert(0);
            *entry = (*entry).max(count);
        }
    }

    pub fn relation(&self, other: &VClock) -> Order {
        let mut self_le = true;
        let mut other_le = true;
        let mut nodes: Vec<&String> = self.0.keys().chain(other.0.keys()).collect();
        nodes.sort();
        nodes.dedup();

        for node in nodes {
            let a = self.0.get(node).copied().unwrap_or(0);
            let b = other.0.get(node).copied().unwrap_or(0);
            if a > b {
                other_le = false;
            }
            if b > a {
                self_le = false;
            }
        }

        match (self_le, other_le) {
            (true, true) => Order::Equal,
            (true, false) => Order::Before,
            (false, true) => Order::After,
            (false, false) => Order::Concurrent,
        }
    }
}`,
          tip: 'Merge on read, not only on write: a replica that answered a read from a peer must carry that knowledge into its next write, or it will report a concurrent version as newer.',
        },
        {
          h: 'What concurrency detection buys you',
          p: [
            "With a vector clock you can implement a register that never silently loses a write: if a write arrives with a clock equal to or after the stored one, replace; if it is before, discard; if it is concurrent, keep both and let policy decide - last-writer-wins by a tie-breaker, sibling merge for a list, or an application-level conflict surfaced to the user.",
            "That last case is the honest part. Vector clocks do not resolve conflicts; they prove one exists. Systems that resolve by timestamp are choosing a total order that can erase a causally later write made on a clock that ran behind, which is why a clock comparison is only safe when the timestamps are bounded, as in TrueTime or HLC.",
          ],
          list: [
            'Equal or after: the incoming write supersedes',
            'Before: the incoming write is stale, drop it and count the drop',
            'Concurrent: keep siblings, apply policy, and record that a conflict happened',
            'Never compare wall-clock timestamps of writes from different nodes without a bound',
          ],
          tip: 'A conflict rate metric is the signal that your partition key is wrong: the same logical record is being written concurrently from two paths that should not both own it.',
        },
        {
          h: 'The metadata bill',
          p: [
            "A vector clock has one entry per writer that has ever touched the value. With one writer per user that is fine; with one writer per request id, a hot record accumulates thousands of entries and every read pays to deserialize and merge them. Compaction - dropping entries older than a threshold - is only safe if your conflict policy can tolerate losing the ability to detect those conflicts.",
            "Dotted version vectors, used by Riak for sibling tracking, separate the causal context from the specific write, which keeps the clock small while still detecting concurrency correctly. Hybrid logical clocks take the other route: a physical component plus a logical counter, giving timestamps that are close to wall time and monotonic within a bounded skew, at the cost of requiring a maximum-skew assumption.",
          ],
          list: [
            'Bound writers per key by design: one clock entry per actor, not per request',
            'Compact with a documented policy, and log what compaction can no longer detect',
            'Dotted version vectors when sibling precision matters and clocks must stay small',
            'HLC when you need sortable timestamps and can bound clock skew',
          ],
          tip: 'Measure clock size per record in production. If p99 is above a few dozen entries, your merge cost is growing without bound.',
        },
      ],
      exercise: {
        prompt: 'Build a last-writer-wins-with-siblings register: apply a write carrying (value, clock) against stored siblings, return the new sibling set, and count conflicts. A write that is concurrent with any sibling is kept alongside it.',
        starter: `use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct VClock(pub BTreeMap<String, u64>);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Order { Before, After, Equal, Concurrent }

impl VClock {
    pub fn relation(&self, _other: &VClock) -> Order { todo!() }
}

#[derive(Clone, Debug)]
pub struct Versioned { pub value: String, pub clock: VClock }

/// Apply a write and return the surviving siblings plus a conflict flag.
pub fn apply(siblings: &mut Vec<Versioned>, incoming: Versioned) -> bool {
    todo!()
}`,
        hint: 'Compare the incoming clock with each sibling. Drop siblings the incoming write supersedes, drop the incoming write if a sibling supersedes it, and keep both when concurrent. Return true when the result has more than one sibling.',
        solution: `use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct VClock(pub BTreeMap<String, u64>);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Order { Before, After, Equal, Concurrent }

impl VClock {
    pub fn relation(&self, other: &VClock) -> Order {
        let mut self_le = true;
        let mut other_le = true;
        let mut nodes: Vec<&String> = self.0.keys().chain(other.0.keys()).collect();
        nodes.sort();
        nodes.dedup();
        for node in nodes {
            let a = self.0.get(node).copied().unwrap_or(0);
            let b = other.0.get(node).copied().unwrap_or(0);
            if a > b { other_le = false; }
            if b > a { self_le = false; }
        }
        match (self_le, other_le) {
            (true, true) => Order::Equal,
            (true, false) => Order::Before,
            (false, true) => Order::After,
            (false, false) => Order::Concurrent,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Versioned { pub value: String, pub clock: VClock }

pub fn apply(siblings: &mut Vec<Versioned>, incoming: Versioned) -> bool {
    let mut kept: Vec<Versioned> = Vec::with_capacity(siblings.len() + 1);
    let mut incoming_dropped = false;

    for existing in siblings.drain(..) {
        match incoming.clock.relation(&existing.clock) {
            Order::After | Order::Equal => {}
            Order::Before => {
                incoming_dropped = true;
                kept.push(existing);
            }
            Order::Concurrent => kept.push(existing),
        }
    }

    if !incoming_dropped {
        kept.push(incoming);
    }
    *siblings = kept;
    siblings.len() > 1
}`,
      },
      questions: [
        {
          q: 'Two versions have clocks {A:2, B:1} and {A:1, B:3}. What is their relation?',
          options: [
            'Concurrent: each is ahead of the other on a different writer',
            'The first happened before the second',
            'The second happened before the first',
            'Equal, because the totals are the same',
          ],
          answer: 0,
          explain: 'The first is greater on A and smaller on B, so neither dominates. That is concurrency, and a correct register must keep both siblings rather than pick one silently.',
        },
        {
          q: 'What does a vector clock fail to provide?',
          options: [
            'A total order you can use for a single authoritative timestamp',
            'Detection of causally ordered writes',
            'Detection of concurrent writes',
            'A way to merge knowledge after a message',
          ],
          answer: 0,
          explain: 'Vector clocks encode partial order. Turning them into a total order requires a tie-break or a bounded physical clock, and that extra rule is where writes can be lost.',
        },
        {
          q: 'Why does a clock entry per request id become a production problem?',
          options: [
            'Every read must deserialize and merge an unbounded growing map',
            'Vector clocks cannot represent more than 64 writers',
            'Request ids are not unique enough for causality',
            'Merging requires a global lock',
          ],
          answer: 0,
          explain: 'The clock is per value and grows with the number of distinct writers. With high-cardinality writers, the metadata dominates storage and merge cost, so the design should bound writers per key.',
        },
      ],
      quickbytes: [
        'Merge on read as well as on write, or a read replica will misclassify its next write.',
        'Concurrent is a real state, not an error: keep siblings and let policy decide.',
        'Compact clocks with a documented policy and a metric for what compaction loses.',
        'Never order writes by wall clock unless the skew is bounded and stated.',
      ],
      production: [
        'Conflict rate is exported per key family, with an alert when it exceeds the design assumption.',
        'Clock size per record is measured; p99 above the design bound fails a test.',
        'Every stored version carries its clock through snapshots and restores.',
        'Conflict policy is documented per data type, not applied globally.',
        'Compaction has an owner and a rollback, because it removes information permanently.',
      ],
      crates: ['serde', 'uuid', 'tokio', 'thiserror'],
      github: [
        { name: 'serde-rs/serde', url: 'https://github.com/serde-rs/serde' },
        { name: 'uuid-rs/uuid', url: 'https://github.com/uuid-rs/uuid' },
      ],
      pitfall: 'Resolving concurrent siblings by "the one with the later wall-clock timestamp". A node whose clock ran two seconds ahead wins every future conflict until it restarts, and writes made after the losing one disappear with no error.',
      resources: [
        { title: 'Time, clocks, and the ordering of events in a distributed system', url: 'https://dl.acm.org/doi/10.1145/359545.359563', kind: 'paper' },
        { title: 'Dynamo: versioned values and sibling reconciliation (SOSP 2007)', url: 'https://dl.acm.org/doi/10.1145/1294261.1294281', kind: 'paper' },
        { title: 'vclock crate: vector clocks with merge and comparison', url: 'https://docs.rs/vclock/latest/vclock/', kind: 'docs' },
        { title: 'serde: versioned records and clock serialisation', url: 'https://docs.rs/serde/latest/serde/', kind: 'docs' },
      ],
    },
    {
      id: 'e08',
      title: 'CRDTs: convergence by construction',
      minutes: 90,
      level: 'advanced',
      goal: 'Build state that merges without coordination, prove the merge laws on a counter, and know which invariants a CRDT cannot protect so you do not put a bank transfer in one.',
      sections: [
        {
          h: 'Three laws, no coordinator',
          p: [
            "A state-based CRDT is a value plus a merge function that is commutative, associative and idempotent. Commutative means order does not matter, associative means grouping does not matter, idempotent means duplicates are harmless - together they mean replicas that have seen the same set of updates hold the same value regardless of delivery order or repeats.",
            "Those laws describe a join semilattice, and they are what removes the coordination round trip: a replica accepts an update locally and reconciles later. The price is that the state must be able to represent every update that could still matter, which is why grow-only counters keep a per-writer maximum and sets keep tombstones.",
          ],
          list: [
            'Merge must never lose an update that a peer has already acknowledged',
            'Merge must be safe to retry: anti-entropy sends the same state repeatedly',
            'The payload carries metadata proportional to the number of writers or removals',
            'Op-based CRDTs need causal, exactly-once delivery, which is a transport problem',
          ],
          tip: 'Write the three law tests before the data structure: merge in both orders, merge twice, merge three ways in two groupings. They catch most broken designs immediately.',
        },
        {
          h: 'A counter you can merge in any order',
          p: [
            "A GCounter stores one count per writer and merge takes the pointwise maximum. It never decreases, which is exactly right for counting requests, views, or retries. A PNCounter is two GCounter values - increments and decrements - subtracted at read time; it can go negative and still converges.",
            "The crdts crate gives you the state-based versions with the trait already implemented. The important part is what the numbers mean: a counter that only grows cannot express a rate limit that must reset, and a subtract-only counter cannot enforce a non-negative balance across replicas without a coordination point.",
          ],
          code: `use crdts::{CvRDT, GCounter};

fn main() {
    // Two replicas, each counting locally while partitioned.
    let mut eu: GCounter<String> = GCounter::new();
    eu.inc("eu-west-1".to_string());
    eu.inc_many("eu-west-1".to_string(), 4);

    let mut us: GCounter<String> = GCounter::new();
    us.inc("us-east-1".to_string());

    // Merge is commutative and idempotent: applying it twice changes nothing.
    eu.merge(us.clone());
    let after_first = eu.read();
    eu.merge(us);
    assert_eq!(eu.read(), after_first, "merge must be idempotent");

    // 5 from eu-west-1 plus 1 from us-east-1, in any order.
    assert_eq!(after_first, 6);
}`,
          tip: 'Use a GCounter where the value only rises (total requests, bytes sent) and a PNCounter only where negative values are meaningful. A counter that must stay non-negative is an invariant, not a counter.',
        },
        {
          h: 'Where CRDTs stop earning their keep',
          p: [
            "CRDTs converge on a per-object value. They do not protect invariants that span objects. Stock cannot be reserved by two orders if the reservation is two independent counters, and an account cannot stay non-negative if debits are G-Counters. Those need a serialization point - a consensus log, a database transaction, or a single owner per key.",
            "The practical split is: CRDTs for presence, counters, sets, collaborative text, and anything where the merged answer is still meaningful. Consensus for money, inventory, uniqueness, and any rule that says the sum must not cross a line. A system that mixes the two needs the boundary documented, because the failure of the mixed design is silent: each replica looks correct in isolation.",
          ],
          list: [
            'Sets: OR-Set with unique add tags, or ORSWOT to keep tombstones bounded by version vectors',
            'Text: RGA or Yjs-style structures, not a sequence of characters with LWW',
            'Registers: LWW needs a total order; multi-value registers keep siblings',
            'Counters: GCounter when monotonic, PNCounter when both directions are legal',
          ],
          tip: 'If the merged state can violate a business rule, you needed a coordination point. Write that rule down and put it in the design review.',
        },
      ],
      exercise: {
        prompt: 'Implement a PNCounter from scratch: per-actor positive and negative counts, a merge that takes the pointwise maximum of both maps, and a value() that subtracts. Add a test proving merge order does not change the result.',
        starter: `use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PnCounter {
    pub pos: BTreeMap<String, u64>,
    pub neg: BTreeMap<String, u64>,
}

impl PnCounter {
    pub fn add(&mut self, actor: &str, by: u64) { todo!() }
    pub fn sub(&mut self, actor: &str, by: u64) { todo!() }
    pub fn value(&self) -> i64 { todo!() }
    pub fn merge(&mut self, other: &PnCounter) { todo!() }
}`,
        hint: 'Bump the actor entry in the right map, merge pointwise with max (never sum, or duplicates double-count), and compute value as total positive minus total negative with i64 arithmetic.',
        solution: `use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PnCounter {
    pub pos: BTreeMap<String, u64>,
    pub neg: BTreeMap<String, u64>,
}

impl PnCounter {
    pub fn add(&mut self, actor: &str, by: u64) {
        *self.pos.entry(actor.to_string()).or_insert(0) += by;
    }

    pub fn sub(&mut self, actor: &str, by: u64) {
        *self.neg.entry(actor.to_string()).or_insert(0) += by;
    }

    pub fn value(&self) -> i64 {
        let pos: i64 = self.pos.values().map(|v| *v as i64).sum();
        let neg: i64 = self.neg.values().map(|v| *v as i64).sum();
        pos - neg
    }

    pub fn merge(&mut self, other: &PnCounter) {
        for (actor, count) in &other.pos {
            let entry = self.pos.entry(actor.clone()).or_insert(0);
            *entry = (*entry).max(*count);
        }
        for (actor, count) in &other.neg {
            let entry = self.neg.entry(actor.clone()).or_insert(0);
            *entry = (*entry).max(*count);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn replica(actor: &str, adds: u64, subs: u64) -> PnCounter {
        let mut c = PnCounter::default();
        c.add(actor, adds);
        c.sub(actor, subs);
        c
    }

    #[test]
    fn merge_is_order_independent() {
        let a = replica("a", 10, 1);
        let b = replica("b", 4, 6);
        let c = replica("c", 7, 0);

        let mut ab = a.clone();
        ab.merge(&b);
        ab.merge(&c);

        let mut ba = b.clone();
        ba.merge(&a);
        ba.merge(&c);

        assert_eq!(ab, ba);
        assert_eq!(ab.value(), 14);
    }

    #[test]
    fn duplicate_merge_does_not_double_count() {
        let mut a = replica("a", 10, 1);
        let b = replica("b", 4, 6);
        a.merge(&b);
        a.merge(&b);
        assert_eq!(a.value(), 7);
    }
}`,
      },
      questions: [
        {
          q: 'Which property is required for state-based CRDT merge?',
          options: [
            'Idempotence, so replaying the same state cannot change the result',
            'Deterministic wall-clock ordering of updates',
            'A leader that serializes merges',
            'Exactly-once delivery of merge messages',
          ],
          answer: 0,
          explain: 'Anti-entropy resends state arbitrarily often, so merge must be idempotent along with commutative and associative. Without idempotence, every retransmission would inflate counters or duplicate elements.',
        },
        {
          q: 'Why is an OR-Set commonly used instead of a remove-wins set?',
          options: [
            'It allows concurrent add and remove to resolve to add, which matches most user intent',
            'It needs no tombstones at all',
            'It converges faster than a G-Set',
            'It works without unique tags',
          ],
          answer: 0,
          explain: 'An observed-remove set removes only the add tags it has seen, so a concurrent add survives. That is usually the intended semantic for presence and collections, at the cost of storing tags and tombstones.',
        },
        {
          q: 'When must you not model a business rule as a CRDT?',
          options: [
            'When the rule is an invariant across keys, such as a non-negative balance',
            'When the data is written by more than one node',
            'When the value is a counter',
            'When the network can partition',
          ],
          answer: 0,
          explain: 'CRDTs guarantee convergence, not invariant preservation. Multi-key invariants need serialization: a transaction, a consensus log, or single ownership per invariant.',
        },
      ],
      quickbytes: [
        'Test merge both orders, twice, and three ways - three law tests catch most designs.',
        'Merge is pointwise max, never sum, or retransmits double-count.',
        'Tombstones are the bill: bound them with a version vector or a compaction policy.',
        'A CRDT that can violate a business rule is the wrong tool; use a log.',
      ],
      production: [
        'Every CRDT type has property tests for commutativity, associativity and idempotence.',
        'Metadata size per key is measured and capped; tombstone growth has an alert.',
        'The transport delivers updates at least once, and the merge is tested under duplication.',
        'Multi-key invariants are listed explicitly as requiring consensus, not CRDTs.',
        'Snapshots serialise CRDT state including metadata, and restore merges rather than overwrites.',
      ],
      crates: ['crdts', 'serde', 'tokio', 'proptest'],
      github: [
        { name: 'rust-crdt/rust-crdt', url: 'https://github.com/rust-crdt/rust-crdt' },
        { name: 'automerge/automerge', url: 'https://github.com/automerge/automerge' },
      ],
      pitfall: 'Storing a GCounter per SKU and treating two concurrent reservations as a sum: inventory appears available on every replica while the warehouse has one unit, and the oversell is discovered only at fulfilment.',
      resources: [
        { title: 'CRDTs: consistency without concurrency control', url: 'https://arxiv.org/abs/0907.0929', kind: 'paper' },
        { title: 'crdts crate documentation', url: 'https://docs.rs/crdts/latest/crdts/', kind: 'docs' },
        { title: 'rust-crdt: implementations and merge semantics', url: 'https://github.com/rust-crdt/rust-crdt', kind: 'repo' },
        { title: 'Automerge: CRDTs for JSON-like documents', url: 'https://docs.rs/automerge/latest/automerge/', kind: 'docs' },
      ],
    },
    {
      id: 'e09',
      title: 'Leases, quorum grants and fencing tokens',
      minutes: 85,
      level: 'advanced',
      goal: 'Grant time-bounded leadership, state the clock and drift assumptions that make it safe, and derive a monotonic fence from the replicated log so a paused leader cannot corrupt state.',
      sections: [
        {
          h: 'A lease is a promise with a deadline',
          p: [
            "A lease is a time-bounded grant: the granter promises not to grant the same right to anyone else until the lease expires. Gray and Cheriton introduced them for cache consistency in 1989, and the same structure now backs leader leases and read-only fast paths. The point is to avoid a round trip per read, so the holder acts on a local timer until renewal.",
            "The safety of the whole thing rests on two clocks, not one. The holder must stop before the granter could possibly have granted the lease elsewhere, which means the holder's clock can run fast by at most the drift the protocol assumes. A virtual machine that pauses for two seconds in a live migration, or a clock stepped by NTP, breaks that assumption without any message being lost.",
          ],
          list: [
            'Granter: never re-grant before the recorded expiry',
            'Holder: stop before expiry minus maximum drift, and stop immediately if renewal fails',
            'Renew at roughly one third of the duration, so two failures still leave time to stop',
            'Never extend a lease because work is almost finished',
          ],
          tip: 'A lease that is renewed by a background task while the work continues on another task is not a lease. The work must check validity at every mutation.',
        },
        {
          h: 'The fence comes from the log, not from the lock',
          p: [
            "Fencing makes a stale leader harmless. Every grant carries a monotonically increasing token; every write to protected state includes the token; the state stores the highest token it has accepted and rejects anything lower. A leader that wakes up after its lease expired is rejected by the storage layer, not by its own clock, so correctness no longer depends on timing.",
            "Derive the token from the replicated log: the term and the index of the entry that granted leadership. Both are monotonic under Raft's rules, survive restarts because they are persisted, and are the same number every replica can verify. A counter in the lease service's memory is not a fence - it resets on restart and it never reaches the resource that needs to enforce it.",
          ],
          code: `use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug)]
pub struct Lease {
    pub term: u64,
    pub granted_at: Instant,
    pub duration: Duration,
    pub max_drift: Duration,
}

impl Lease {
    /// The holder may serve only while its elapsed time plus the assumed
    /// drift is still inside the grant.
    pub fn may_serve(&self, now: Instant) -> bool {
        now.duration_since(self.granted_at) + self.max_drift < self.duration
    }

    /// Renew well before expiry so two lost renewals still leave room to stop.
    pub fn renew_at(&self) -> Instant {
        self.granted_at + self.duration / 3
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Fence {
    pub term: u64,
    pub log_index: u64,
}

/// Enforced by the resource, not by the lease holder. Any write with a
/// token that is not strictly newer is rejected.
pub fn accept_write(last: &mut Fence, incoming: Fence) -> bool {
    if incoming > *last {
        *last = incoming;
        true
    } else {
        false
    }
}`,
          tip: 'The resource must persist the fence in the same transaction as the write. Check the fence, then write, in two statements, and a pause between them reintroduces the race.',
        },
        {
          h: 'Reads are the hard part',
          p: [
            "Write fencing is straightforward because every write reaches the resource. Reads do not: a leader serving reads from its own state machine never touches the fenced resource, so a stale leader can answer with a value that is no longer current. Leader leases are the usual fix - the leader may serve reads only while its lease holds - which reintroduces the clock assumption you were trying to remove from writes.",
            "The alternative is ReadIndex: confirm leadership with a quorum round (or a heartbeat exchange), wait until the state machine has applied through the commit index you saw, then answer locally. It costs one round trip and no clock assumption. Most systems offer both and default to ReadIndex for reads that must be linearizable, keeping the lease as an optimization for the hot path with a documented tolerance.",
          ],
          list: [
            'Lease read: zero extra round trips, needs bounded drift and a stop rule',
            'ReadIndex: one quorum round, no clock assumption, still linearizable',
            'Follower read: stale by design, must carry a version the client can check',
            'Never serve a lease read after a failed renewal, even if the lease has not visibly expired',
          ],
          tip: 'If the design review cannot state the maximum clock drift of your fleet, the lease read is not safe. Measure it or use ReadIndex.',
        },
      ],
      exercise: {
        prompt: 'Given an election timeout, an assumed maximum clock drift, and a replication delay budget, compute the longest leader lease that is still safe, and reject configurations where no positive lease fits.',
        starter: `use std::time::Duration;

#[derive(Debug, PartialEq, Eq)]
pub enum LeaseConfig {
    Safe(Duration),
    Unsafe { reason: &'static str },
}

/// A new leader can be elected after election_timeout, but the old
/// leader must stop before that. Keep a margin for the grant message.
pub fn max_safe_lease(
    election_timeout: Duration,
    max_drift: Duration,
    replication_delay: Duration,
) -> LeaseConfig {
    todo!()
}`,
        hint: 'The old leader may hold the lease for at most election_timeout minus drift minus the time the grant message can take. If that subtraction goes negative, no lease is safe and the answer is an error, not zero.',
        solution: `use std::time::Duration;

#[derive(Debug, PartialEq, Eq)]
pub enum LeaseConfig {
    Safe(Duration),
    Unsafe { reason: &'static str },
}

pub fn max_safe_lease(
    election_timeout: Duration,
    max_drift: Duration,
    replication_delay: Duration,
) -> LeaseConfig {
    let budget = match election_timeout
        .checked_sub(max_drift)
        .and_then(|d| d.checked_sub(replication_delay))
    {
        Some(d) => d,
        None => {
            return LeaseConfig::Unsafe {
                reason: "drift plus replication delay exceeds the election timeout",
            }
        }
    };

    // Keep a third of the budget for the renewal attempt itself.
    let lease = budget / 3;
    if lease.is_zero() {
        return LeaseConfig::Unsafe { reason: "computed lease is zero" };
    }
    LeaseConfig::Safe(lease)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_drift_larger_than_the_election_timeout() {
        let result = max_safe_lease(
            Duration::from_millis(300),
            Duration::from_millis(400),
            Duration::from_millis(10),
        );
        assert!(matches!(result, LeaseConfig::Unsafe { .. }));
    }

    #[test]
    fn leaves_room_for_renewal() {
        let LeaseConfig::Safe(lease) = max_safe_lease(
            Duration::from_millis(900),
            Duration::from_millis(100),
            Duration::from_millis(50),
        ) else {
            panic!("expected a safe lease");
        };
        assert_eq!(lease, Duration::from_millis(250));
    }
}`,
      },
      questions: [
        {
          q: 'What makes a lease-based leader safe against a paused holder?',
          options: [
            'The holder stops before expiry minus drift, and the resource rejects writes with an old fence',
            'The granter sends a revocation message that the holder always receives',
            'The holder restarts automatically after a pause',
            'The lease duration is shorter than the network round trip',
          ],
          answer: 0,
          explain: 'Revocation messages can be delayed by the same pause. Safety comes from the holder stopping on its own timer with a drift margin, and from the resource rejecting any token older than the highest it has accepted.',
        },
        {
          q: 'Why is a term and log index a better fence than a counter in the lock service?',
          options: [
            'It is monotonic under the consensus rules, persisted, and verifiable by every replica',
            'It is shorter to encode',
            'It does not require the resource to store anything',
            'It avoids the need for a quorum',
          ],
          answer: 0,
          explain: 'A memory counter resets on restart and never reaches the resource. A term and index pair is persisted in the log, comparable everywhere, and increases with every leadership change.',
        },
        {
          q: 'What does a ReadIndex read require?',
          options: [
            'A quorum confirmation of leadership and waiting for the state machine to apply the observed commit index',
            'A lease that has not expired',
            'A read from at least R replicas with version comparison',
            'Nothing beyond local state, which is why it is the fastest option',
          ],
          answer: 0,
          explain: 'ReadIndex avoids clock assumptions by confirming leadership with a round of communication, then waiting until the local state machine has applied everything committed at that point.',
        },
      ],
      quickbytes: [
        'Renew at one third of the lease; stop immediately when renewal fails.',
        'The resource enforces the fence, in the same transaction as the write.',
        'A lease read is a performance choice; ReadIndex is the correctness one.',
        'Measure clock drift across the fleet before trusting a lease in production.',
      ],
      production: [
        'Lease durations are derived from measured election timeouts and drift, not chosen for round numbers.',
        'Every fenced write validates the token in the same statement that mutates state.',
        'A failed renewal stops work immediately and pages, since it is a leadership change.',
        'Reads document whether they are lease reads, ReadIndex reads, or follower reads.',
        'The maximum clock drift of the fleet is measured and reviewed quarterly.',
      ],
      crates: ['tokio', 'tracing', 'serde', 'thiserror'],
      github: [
        { name: 'tokio-rs/tracing', url: 'https://github.com/tokio-rs/tracing' },
        { name: 'tokio-rs/tokio', url: 'https://github.com/tokio-rs/tokio' },
      ],
      pitfall: 'Starting the lease timer before sending the renewal request. The grant arrives late, the holder treats the old timestamp as still valid, and a second holder is already writing with a newer fence.',
      resources: [
        { title: 'Leases: an efficient fault-tolerant mechanism for distributed file cache consistency', url: 'https://dl.acm.org/doi/10.1145/74850.74870', kind: 'paper' },
        { title: 'Raft paper: leader leases and ReadIndex in practice', url: 'https://raft.github.io/raft.pdf', kind: 'paper' },
        { title: 'openraft: leader and quorum APIs', url: 'https://docs.rs/openraft/latest/openraft/', kind: 'docs' },
        { title: 'Redis distributed locks: the Redlock pattern and its limits', url: 'https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/', kind: 'docs' },
      ],
    },
    {
      id: 'e10',
      title: 'Failure detection: timeouts, phi accrual and suspicion',
      minutes: 75,
      level: 'advanced',
      goal: 'Turn a missing heartbeat into a probability instead of a verdict, tune false positives against detection time, and keep detection from becoming a data-loss trigger.',
      sections: [
        {
          h: 'A timeout is a guess with a bias',
          p: [
            "Every failure detector built on heartbeats makes the same trade: a short timeout detects real failures quickly and mistakes garbage collection pauses for death; a long timeout is accurate and slow. In a consensus cluster a false positive is expensive - a new election, a term bump, in-flight requests failed - while in a load balancer it is cheap: one healthy node briefly removed.",
            "The detector also only sees its own vantage point. A node that cannot reach a peer has no way to distinguish a crashed peer, a partitioned link, a saturated NIC, and a peer whose runtime is stuck behind a stop-the-world pause. Treating that observation as a fact about the peer is the mistake that turns a network problem into a membership change.",
          ],
          list: [
            'A false positive in consensus costs an election and failed writes',
            'A false positive in a load balancer costs one rerouted request',
            'Detection is asymmetric: A may not hear B while B hears A',
            'Never delete data or shrink a replica set on a single detector opinion',
          ],
          tip: 'Log the observed inter-arrival distribution, not just the timeout. The p99 heartbeat gap tells you how close your timeout is to the pause tail.',
        },
        {
          h: 'Phi accrual: a probability, not a boolean',
          p: [
            "The phi accrual detector samples inter-arrival times, estimates their mean and standard deviation, and reports phi = -log10 of the probability that a heartbeat would be this late if the peer were alive. Phi 1 means roughly a 10 percent chance, phi 8 a one-in-a-hundred-million chance. The threshold becomes a product decision rather than a magic number.",
            "The estimator adapts: a process that pauses for 200 ms every minute widens the distribution, so a 300 ms gap no longer looks like death. That is the property a fixed timeout lacks, and it is why systems with variable pause behaviour - JVM, GC-heavy services, hosts with noisy neighbours - use it.",
          ],
          code: `use std::collections::VecDeque;
use std::time::Duration;

/// Sliding-window phi accrual detector (normal approximation).
pub struct Phi {
    window: VecDeque<f64>,
    capacity: usize,
}

impl Phi {
    pub fn new(capacity: usize) -> Self {
        Self { window: VecDeque::with_capacity(capacity), capacity }
    }

    pub fn observe(&mut self, interval: Duration) {
        if self.window.len() == self.capacity {
            self.window.pop_front();
        }
        self.window.push_back(interval.as_secs_f64());
    }

    /// phi = -log10(P(a heartbeat would be at least this late)).
    pub fn phi(&self, elapsed: Duration) -> f64 {
        if self.window.len() < 2 {
            return 0.0;
        }
        let n = self.window.len() as f64;
        let mean = self.window.iter().sum::<f64>() / n;
        let variance = self.window.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (n - 1.0);
        let std = variance.sqrt().max(1e-9);
        let z = (elapsed.as_secs_f64() - mean) / std;
        let p_late = 1.0 - normal_cdf(z);
        -p_late.max(1e-12).log10()
    }
}

fn normal_cdf(z: f64) -> f64 {
    0.5 * (1.0 + erf(z / std::f64::consts::SQRT_2))
}

/// Abramowitz and Stegun 7.1.26, accurate to about 1.5e-7.
fn erf(x: f64) -> f64 {
    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    let x = x.abs();
    let t = 1.0 / (1.0 + 0.327_591_1 * x);
    let y = 1.0
        - (((((1.061_405_429 * t - 1.453_152_027) * t) + 1.421_413_741) * t - 0.284_496_736)
            * t
            + 0.254_829_592)
            * t
            * (-x * x).exp();
    sign * y
}`,
          tip: 'Start with a threshold around 8 for suspect and 12 for dead, then calibrate against your own pause tail. The number is a policy, not a constant from a paper.',
        },
        {
          h: 'Suspicion beats conviction',
          p: [
            "SWIM improves on pure heartbeats with two mechanisms. First, indirect probing: if a direct ping times out, ask k random peers to ping the suspect, which distinguishes a dead node from a congested link between two specific nodes. Second, suspicion: instead of declaring death immediately, disseminate a suspicion with a timeout that grows with cluster size, and let any refutation cancel it.",
            "This is what memberlist implements, and it is why a busy cluster does not churn membership every time one link saturates. The operational rule that follows: detection should trigger a probe or an election, never a destructive action. Rebalancing away from a node that was merely slow is how a small latency spike becomes a data movement storm.",
          ],
          list: [
            'Direct ping, then k indirect probes before suspecting',
            'Suspicion timeout scaled by log(cluster size) to absorb gossip delay',
            'Any refutation cancels suspicion, including a probe from a third party',
            'Destructive actions wait for a second, independent signal (disk, process, operator)',
          ],
          tip: 'Alert on the rate of suspicion, not on individual suspicions. A steady trickle is normal; a step change is the incident.',
        },
      ],
      exercise: {
        prompt: 'Implement a heartbeat monitor that keeps the last N inter-arrival samples and reports a state: Healthy below 4, Suspect between 4 and 8, Dead at or above 8. Include a test showing that a peer with a wide pause distribution is not declared dead at the same gap as a steady peer.',
        starter: `use std::collections::VecDeque;
use std::time::Duration;

#[derive(Debug, PartialEq, Eq)]
pub enum State { Healthy, Suspect, Dead }

pub struct Monitor {
    pub window: VecDeque<Duration>,
    pub capacity: usize,
}

impl Monitor {
    pub fn observe(&mut self, interval: Duration) { todo!() }
    pub fn state(&self, elapsed: Duration) -> State { todo!() }
}`,
        hint: 'Compute mean and standard deviation over the window, convert the elapsed gap to a z-score, approximate the normal CDF, then map phi to the three bands. Keep at least two samples before answering anything but Healthy.',
        solution: `use std::collections::VecDeque;
use std::time::Duration;

#[derive(Debug, PartialEq, Eq)]
pub enum State { Healthy, Suspect, Dead }

pub struct Monitor {
    pub window: VecDeque<Duration>,
    pub capacity: usize,
}

impl Monitor {
    pub fn new(capacity: usize) -> Self {
        Self { window: VecDeque::new(), capacity }
    }

    pub fn observe(&mut self, interval: Duration) {
        if self.window.len() == self.capacity {
            self.window.pop_front();
        }
        self.window.push_back(interval);
    }

    pub fn state(&self, elapsed: Duration) -> State {
        if self.window.len() < 2 {
            return State::Healthy;
        }
        let n = self.window.len() as f64;
        let mean = self.window.iter().map(|d| d.as_secs_f64()).sum::<f64>() / n;
        let variance = self
            .window
            .iter()
            .map(|d| (d.as_secs_f64() - mean).powi(2))
            .sum::<f64>()
            / (n - 1.0);
        let std = variance.sqrt().max(1e-9);
        let z = (elapsed.as_secs_f64() - mean) / std;

        // Normal tail probability, floored so phi stays finite.
        let p_late = (1.0 - normal_cdf(z)).max(1e-12);
        let phi = -p_late.log10();

        if phi >= 8.0 {
            State::Dead
        } else if phi >= 4.0 {
            State::Suspect
        } else {
            State::Healthy
        }
    }
}

fn normal_cdf(z: f64) -> f64 {
    0.5 * (1.0 + erf(z / std::f64::consts::SQRT_2))
}

fn erf(x: f64) -> f64 {
    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    let x = x.abs();
    let t = 1.0 / (1.0 + 0.327_591_1 * x);
    let y = 1.0
        - (((((1.061_405_429 * t - 1.453_152_027) * t) + 1.421_413_741) * t - 0.284_496_736)
            * t
            + 0.254_829_592)
            * t
            * (-x * x).exp();
    sign * y
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adaptive_to_pause_distribution() {
        let mut steady = Monitor::new(64);
        for _ in 0..32 {
            steady.observe(Duration::from_millis(100));
        }
        assert_eq!(steady.state(Duration::from_millis(400)), State::Dead);

        let mut jittery = Monitor::new(64);
        for i in 0..32 {
            let gap = if i % 4 == 0 { 400 } else { 100 };
            jittery.observe(Duration::from_millis(gap));
        }
        assert_ne!(jittery.state(Duration::from_millis(400)), State::Dead);
    }
}`,
      },
      questions: [
        {
          q: 'Why does a consensus cluster care more about a false positive than a load balancer does?',
          options: [
            'A false positive costs an election, a term bump and failed in-flight writes',
            'Consensus nodes cannot be restarted',
            'Load balancers do not use heartbeats',
            'Consensus requires every node to be healthy at all times',
          ],
          answer: 0,
          explain: 'Detection feeds leader election in consensus, so a wrong verdict changes who writes. A load balancer just sends traffic elsewhere, and the next health check can undo it.',
        },
        {
          q: 'What does phi represent?',
          options: [
            'The negative log10 probability that a heartbeat would be this late if the peer were alive',
            'The number of missed heartbeats since the last success',
            'The round-trip time in milliseconds',
            'The fraction of probes that failed',
          ],
          answer: 0,
          explain: 'Phi converts a latency observation into evidence against liveness: phi 8 corresponds to roughly a one-in-a-hundred-million chance of that gap under the observed distribution.',
        },
        {
          q: 'What is the purpose of indirect probing in SWIM?',
          options: [
            'Distinguish a dead node from a congested link between two specific nodes',
            'Reduce the number of gossip messages',
            'Replace the need for suspicion timeouts',
            'Guarantee that a failure is detected in one round',
          ],
          answer: 0,
          explain: 'If a direct ping fails, asking other members to probe the suspect tests whether the path is the problem. A suspect that answers an indirect probe is alive, and the suspicion is refuted.',
        },
      ],
      quickbytes: [
        'Log the heartbeat gap distribution; the timeout should sit outside the pause tail.',
        'Detection triggers probes and elections, never deletes.',
        'Suspicion timeouts must scale with cluster size or gossip delay wins.',
        'A single detector opinion is not evidence of death.',
      ],
      production: [
        'Election timeouts exceed the measured p99 fsync and pause tail by a documented margin.',
        'Membership changes require two independent signals, never one missed heartbeat.',
        'Suspicion rate is a first-class metric with a step-change alert.',
        'Indirect probing is enabled for clusters larger than a handful of nodes.',
        'Detection thresholds are reviewed whenever the deployment shape changes.',
      ],
      crates: ['tokio', 'tracing', 'serde'],
      github: [
        { name: 'hashicorp/memberlist', url: 'https://github.com/hashicorp/memberlist' },
        { name: 'tokio-rs/tokio', url: 'https://github.com/tokio-rs/tokio' },
      ],
      pitfall: 'Setting the election timeout to 150 ms on hosts whose fsync p99 is 400 ms. Every snapshot or log flush looks like a dead leader, the cluster elects a new leader every few seconds, and throughput collapses while all nodes report healthy.',
      resources: [
        { title: 'hashicorp/memberlist: SWIM with suspicion and indirect probes', url: 'https://github.com/hashicorp/memberlist', kind: 'repo' },
        { title: 'Raft paper: heartbeats, election timeouts and disruption', url: 'https://raft.github.io/raft.pdf', kind: 'paper' },
        { title: 'Tokio time: timers, intervals and monotonic instants', url: 'https://docs.rs/tokio/latest/tokio/time/index.html', kind: 'docs' },
        { title: 'chitchat: cluster membership and gossip in Rust', url: 'https://github.com/quickwit-oss/chitchat', kind: 'repo' },
      ],
    },
    {
      id: 'e11',
      title: 'Gossip: spreading state in O(log n) rounds',
      minutes: 75,
      level: 'advanced',
      goal: 'Disseminate membership and small state with push-pull gossip, bound convergence and bandwidth, and use digests so the protocol moves deltas instead of snapshots.',
      sections: [
        {
          h: 'Epidemic dissemination, with numbers',
          p: [
            "In each round a node contacts f peers and exchanges state. With fanout f, the number of nodes holding a new item multiplies by roughly f per round, so complete coverage takes about log_f(N) rounds. A 1000-node cluster with fanout 3 converges in about seven rounds; at one round per second that is seven seconds, which is fine for membership and useless for a counter you must read immediately.",
            "Push-only wastes messages late in the epidemic because most contacts are with nodes that already know. Pull-only is slow at the start. Push-pull, where both sides exchange digests and each sends what the other lacks, is the usual compromise: it converges fastest per byte and it is what most production gossip implementations do.",
          ],
          list: [
            'Fanout controls bandwidth; rounds control latency. Both are tunable',
            'Push-pull converges faster than push-only for the same bytes',
            'Gossip is eventually consistent: never read a value that must be current from it',
            'Message size limits matter more than round count at scale',
          ],
          tip: 'Do the arithmetic before choosing a fanout: rounds x interval is your convergence time, and fanout x message size x N is your bandwidth.',
        },
        {
          h: 'Digests, not snapshots',
          p: [
            "Sending full state every round does not scale. The standard fix is a versioned digest: each node keeps (key, version, writer) and exchanges a compact summary; the receiver requests only the entries where its version is lower. Anti-entropy over Merkle trees does the same at range granularity, comparing subtree hashes so a mismatch costs O(log n) work instead of a full scan.",
            "Merge must be a total, deterministic order or two nodes will keep flipping values forever. Version plus writer id is the usual tie-break: the higher version wins, and equal versions are broken by the writer id so every node picks the same winner without a clock.",
          ],
          code: `use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Versioned {
    pub version: u64,
    pub writer: u32,
    pub value: String,
}

#[derive(Clone, Debug, Default)]
pub struct State {
    pub entries: BTreeMap<String, Versioned>,
}

impl State {
    /// Deterministic last-writer-wins with a writer tie-break.
    pub fn merge(&mut self, remote: State) -> usize {
        let mut changed = 0;
        for (key, incoming) in remote.entries {
            match self.entries.get(&key) {
                Some(current) if current >= &incoming => {}
                _ => {
                    self.entries.insert(key, incoming);
                    changed += 1;
                }
            }
        }
        changed
    }

    /// Compact digest: only what the peer needs to compare.
    pub fn digest(&self) -> BTreeMap<String, (u64, u32)> {
        self.entries
            .iter()
            .map(|(k, v)| (k.clone(), (v.version, v.writer)))
            .collect()
    }

    /// Keys where the peer is behind, capped so one round cannot flood.
    pub fn delta_for(&self, peer: &BTreeMap<String, (u64, u32)>, limit: usize) -> Vec<String> {
        let mut out = Vec::with_capacity(limit);
        for (key, value) in &self.entries {
            if out.len() == limit {
                break;
            }
            match peer.get(key) {
                Some(seen) if seen >= &(value.version, value.writer) => {}
                _ => out.push(key.clone()),
            }
        }
        out
    }
}`,
          tip: 'Cap the delta per round. An uncapped catch-up after a partition turns one recovering node into a bandwidth incident for the whole cluster.',
        },
        {
          h: 'Membership is the payload that matters most',
          p: [
            "The state most systems gossip is membership: who is alive, what address they are on, what metadata they carry. SWIM layers failure detection on top of gossip, and the suspicion mechanism from the failure detection lesson travels through the same messages, which is why membership converges in seconds and why a false suspicion can spread quickly if refutations are not equally fast.",
            "Gossip is also a security surface. Most implementations authenticate messages but not membership claims, so a node with a valid key can introduce arbitrary peers. If the cluster address space is reachable from untrusted networks, treat the gossip protocol as an internal API: mutual TLS, a shared secret, and an allow-list of joining identities.",
          ],
          list: [
            'Gossip membership, digests of larger state, and suspicion - not bulk data',
            'Authenticate and authorise joins; a valid signature is not a valid member',
            'Bound message size and rate per peer, with a drop counter',
            'Test convergence under packet loss, not only under clean conditions',
          ],
          tip: 'A gossip cluster that has been partitioned for an hour should converge in seconds after healing. If it takes minutes, the delta cap or the digest size is the bottleneck.',
        },
      ],
      exercise: {
        prompt: 'Implement anti-entropy for two replicas: given their versioned digests, return the keys the local node must send, the keys it must request, and the entries that agree. Keep the output sorted so tests are deterministic.',
        starter: `use std::collections::BTreeMap;

pub type Digest = BTreeMap<String, (u64, u32)>;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Diff {
    pub send: Vec<String>,
    pub request: Vec<String>,
    pub agree: Vec<String>,
}

pub fn diff(local: &Digest, remote: &Digest) -> Diff {
    todo!()
}`,
        hint: 'Walk the union of keys in sorted order. Compare the (version, writer) tuples: local newer means send, remote newer means request, equal means agree. A key present on only one side goes in the corresponding list.',
        solution: `use std::collections::BTreeMap;

pub type Digest = BTreeMap<String, (u64, u32)>;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Diff {
    pub send: Vec<String>,
    pub request: Vec<String>,
    pub agree: Vec<String>,
}

pub fn diff(local: &Digest, remote: &Digest) -> Diff {
    let mut out = Diff::default();
    let mut keys: Vec<&String> = local.keys().chain(remote.keys()).collect();
    keys.sort();
    keys.dedup();

    for key in keys {
        match (local.get(key), remote.get(key)) {
            (Some(l), Some(r)) if l == r => out.agree.push(key.clone()),
            (Some(l), Some(r)) if l > r => out.send.push(key.clone()),
            (Some(_), Some(_)) => out.request.push(key.clone()),
            (Some(_), None) => out.send.push(key.clone()),
            (None, Some(_)) => out.request.push(key.clone()),
            (None, None) => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_keys_deterministically() {
        let mut local = Digest::new();
        local.insert("a".into(), (3, 1));
        local.insert("b".into(), (1, 1));
        local.insert("c".into(), (2, 2));

        let mut remote = Digest::new();
        remote.insert("a".into(), (3, 1));
        remote.insert("b".into(), (2, 1));
        remote.insert("d".into(), (1, 9));

        let d = diff(&local, &remote);
        assert_eq!(d.agree, vec!["a".to_string()]);
        assert_eq!(d.request, vec!["b".to_string(), "d".to_string()]);
        assert_eq!(d.send, vec!["c".to_string()]);
    }
}`,
      },
      questions: [
        {
          q: 'With fanout 4, roughly how many rounds does a 4096-node cluster need for full dissemination?',
          options: [
            'About 6, because coverage grows as 4^rounds',
            'About 64, because one node is contacted per round',
            'About 1024, because each round doubles coverage',
            'One, because gossip broadcasts in a single round',
          ],
          answer: 0,
          explain: 'Coverage multiplies by the fanout each round, so rounds are log base fanout of N. 4^6 is 4096, so six rounds suffice in expectation, with a tail for stragglers.',
        },
        {
          q: 'Why exchange digests instead of full state?',
          options: [
            'The receiver requests only the entries where it is behind, bounding bytes per round',
            'Digests are cryptographically signed',
            'Full state cannot be merged deterministically',
            'Digests remove the need for a version',
          ],
          answer: 0,
          explain: 'A digest is a compact summary that lets each side compute what the other lacks. Sending full state every round costs bandwidth proportional to total data rather than to divergence.',
        },
        {
          q: 'What can a validly authenticated gossip message still do?',
          options: [
            'Claim membership for peers that were never authorised to join',
            'Bypass the merge function',
            'Change the version ordering without a write',
            'Prevent convergence after a partition',
          ],
          answer: 0,
          explain: 'Authentication proves who sent the message, not that the membership claim inside it is authorised. Joins need their own authorisation rule in addition to transport security.',
        },
      ],
      quickbytes: [
        'Convergence time is rounds times interval; do the arithmetic before choosing a fanout.',
        'Push-pull beats push-only for the same bandwidth.',
        'Cap deltas per round so one recovering node cannot flood the cluster.',
        'Never read a strongly consistent value from gossip state.',
      ],
      production: [
        'Fanout, round interval and max message size are configuration with documented convergence targets.',
        'Digest exchanges are capped and the dropped-delta counter is alerted.',
        'Gossip ports are reachable only from the cluster network and require mutual authentication.',
        'Joins are authorised against an allow-list, not just a shared secret.',
        'Convergence after a long partition is measured, not assumed.',
      ],
      crates: ['tokio', 'serde', 'tracing'],
      github: [
        { name: 'hashicorp/memberlist', url: 'https://github.com/hashicorp/memberlist' },
        { name: 'quickwit-oss/chitchat', url: 'https://github.com/quickwit-oss/chitchat' },
      ],
      pitfall: 'Gossiping the full membership table every second on a 500-node cluster. Each node sends O(N) entries per round, the network cost grows quadratically, and membership gossip starts delaying the application traffic it shares a NIC with.',
      resources: [
        { title: 'Epidemic algorithms for replicated database maintenance', url: 'https://dl.acm.org/doi/10.1145/41840.41841', kind: 'paper' },
        { title: 'hashicorp/memberlist: SWIM membership and gossip', url: 'https://github.com/hashicorp/memberlist', kind: 'repo' },
        { title: 'chitchat: gossip-based cluster state for Rust services', url: 'https://github.com/quickwit-oss/chitchat', kind: 'repo' },
        { title: 'CNCF talks on cluster membership and service discovery', url: 'https://www.youtube.com/@cncf', kind: 'video' },
      ],
    },
    {
      id: 'e12',
      title: 'Exactly-once semantics: dedup plus a transaction',
      minutes: 90,
      level: 'advanced',
      goal: 'Decompose exactly-once into at-least-once delivery plus deduplication or a transaction, implement Kafka-style sequence fencing, and say honestly where the guarantee stops.',
      sections: [
        {
          h: 'There is no exactly-once delivery',
          p: [
            "A message either arrives and is processed, or it does not; over an unreliable network the sender cannot distinguish a lost message from a lost acknowledgement, so it must retry. Retrying means duplicates. Every system that claims exactly-once is really providing at-least-once delivery plus a mechanism that makes the duplicate invisible: a dedup table, an idempotent write, or a transaction that covers both the effect and the offset.",
            "Kafka's idempotent producer does this with a producer id, an epoch, and a per-partition sequence number. The broker remembers the last sequence it accepted for each producer-partition pair and rejects or acknowledges a repeat without writing it twice. The epoch changes when a new producer instance takes over the same transactional id, which fences the old instance even if it is still running.",
          ],
          list: [
            'At-most-once: send and forget; loss is acceptable, duplicates are not',
            'At-least-once: retry until acked; duplicates are guaranteed eventually',
            'Effectively-once: at-least-once plus dedup or a transactional write',
            'Exactly-once in a marketing deck usually means the third row',
          ],
          tip: 'Ask where the dedup state lives and how long it is kept. If the answer is "in memory" or "forever", the guarantee has a hole you can name.',
        },
        {
          h: 'Fencing a producer by epoch',
          p: [
            "Sequence numbers alone are not enough. A producer that was paused by a long GC can wake up and send batch 42 after a replacement producer has already sent 43. The broker must reject the old instance entirely, which is what the epoch does: any request from an older epoch is fenced, and the producer must rejoin with a new producer id.",
            "The same structure applies outside Kafka. Keep a producer generation on every write path, compare it against the highest generation the store has accepted, and reject anything from a previous generation. That single rule turns an unbounded duplicate problem into a bounded one, and it is cheaper than storing every message id forever.",
          ],
          code: `/// Broker-side view of one producer-partition pair.
#[derive(Clone, Debug, Default)]
pub struct ProducerState {
    pub epoch: u16,
    pub last_seq: i64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Accept {
    /// New record, persist it and advance last_seq.
    Fresh,
    /// Already handled: acknowledge again without writing.
    Duplicate,
    /// A gap means the producer lost a batch; it must resend from last_seq + 1.
    OutOfOrder { expected: i64 },
    /// An older producer instance tried to write.
    Fenced { current_epoch: u16 },
}

pub fn accept(state: &mut ProducerState, epoch: u16, seq: i64) -> Accept {
    if epoch < state.epoch {
        return Accept::Fenced { current_epoch: state.epoch };
    }
    if epoch > state.epoch {
        // New instance: it owns the partition from sequence 0 onward.
        state.epoch = epoch;
        state.last_seq = -1;
    }

    if seq == state.last_seq + 1 {
        state.last_seq = seq;
        Accept::Fresh
    } else if seq <= state.last_seq {
        Accept::Duplicate
    } else {
        Accept::OutOfOrder { expected: state.last_seq + 1 }
    }
}`,
          tip: 'Store the last sequence and epoch durably with the record. A broker that loses them on restart accepts duplicates for the rest of the retention window.',
        },
        {
          h: 'Transactions move the boundary, they do not remove it',
          p: [
            "Kafka transactions cover the output records and the consumer offsets in one atomic unit: a read-process-write pipeline commits its produced records and its input offset together, so a crash replays from a consistent point. Consumers using read_committed only see records below the last stable offset, which excludes records from open or aborted transactions.",
            "The guarantee ends at the sink you write to. If the transaction writes to an external database, that database must participate - a two-phase commit, or an idempotent upsert keyed by the record identity. Otherwise the gap between committing to Kafka and writing to the database is exactly the window where a duplicate or a loss appears, and no amount of producer configuration closes it.",
          ],
          list: [
            'Offsets commit inside the transaction, never before it',
            'Sinks are idempotent by key, or participate in a transaction',
            'Aborted records are skipped by read_committed consumers, which also delays visibility to the last stable offset',
            'A rebalance mid-transaction aborts the transaction and replays the batch',
            'With rdkafka that is enable.idempotence=true, a transactional.id, and read_committed consumers',
          ],
          tip: 'Draw the boundary on a whiteboard: everything inside the transaction is once; everything after it needs a key. The drawing usually reveals the bug.',
        },
      ],
      exercise: {
        prompt: 'Implement an effectively-once consumer step: given a message id, apply the effect only if the id has not been seen, persist the id together with the output, and only then commit the offset. Return whether the message was applied.',
        starter: `use std::collections::HashSet;

pub struct Consumer {
    pub applied: HashSet<String>,
    pub committed_offset: i64,
}

impl Consumer {
    /// Apply the effect exactly once, then advance the offset.
    pub fn handle(&mut self, msg_id: &str, offset: i64) -> Result<bool, &'static str> {
        todo!()
    }
}`,
        hint: 'Check the applied set first and return false on a duplicate without moving the offset backwards. On a fresh id, insert the id and the output in the same durable step, then commit the offset greater than the current one.',
        solution: `use std::collections::HashSet;

pub struct Consumer {
    pub applied: HashSet<String>,
    pub committed_offset: i64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    Applied,
    Duplicate,
    OutOfOrder,
}

impl Consumer {
    pub fn handle(&mut self, msg_id: &str, offset: i64) -> Result<Step, &'static str> {
        if offset <= self.committed_offset && !self.applied.contains(msg_id) {
            return Err("offset behind the committed position with an unknown id");
        }

        if self.applied.contains(msg_id) {
            return Ok(Step::Duplicate);
        }

        // In a real sink this insert and the output write are one transaction.
        self.applied.insert(msg_id.to_string());
        if offset > self.committed_offset {
            self.committed_offset = offset;
        }
        Ok(Step::Applied)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redelivery_is_a_no_op() {
        let mut c = Consumer { applied: HashSet::new(), committed_offset: -1 };
        assert_eq!(c.handle("m-1", 0).unwrap(), Step::Applied);
        assert_eq!(c.committed_offset, 0);

        // Broker redelivers after a lost ack.
        assert_eq!(c.handle("m-1", 0).unwrap(), Step::Duplicate);
        assert_eq!(c.committed_offset, 0);
        assert_eq!(c.applied.len(), 1);
    }

    #[test]
    fn offsets_never_move_backwards() {
        let mut c = Consumer { applied: HashSet::new(), committed_offset: 10 };
        c.handle("m-11", 11).unwrap();
        assert_eq!(c.committed_offset, 11);
    }
}`,
      },
      questions: [
        {
          q: 'What does the Kafka broker use to reject a paused producer instance that wakes up late?',
          options: [
            'The producer epoch, which advances when a new instance takes over the transactional id',
            'The record timestamp, compared against the broker clock',
            'The partition leader lease',
            'A checksum over the record batch',
          ],
          answer: 0,
          explain: 'Sequence numbers detect duplicates within one producer session; the epoch fences an entire older session. A request from an older epoch is rejected even if its sequence number looks plausible.',
        },
        {
          q: 'A pipeline uses Kafka transactions but writes to an external database outside the transaction. What is the guarantee?',
          options: [
            'At-least-once across the sink, unless the sink write is idempotent or transactional',
            'Exactly-once end to end, because Kafka transactions are atomic',
            'At-most-once, because aborted records are skipped',
            'Exactly-once if the consumer uses read_committed',
          ],
          answer: 0,
          explain: 'The transaction covers Kafka records and offsets. The external write happens after the commit point, so a crash between them duplicates it; the sink must be idempotent by key or join the transaction.',
        },
        {
          q: 'Why do read_committed consumers see data later than read_uncommitted ones?',
          options: [
            'They can only read up to the last stable offset, which excludes open transactions',
            'They fetch from a different replica',
            'They wait for a rebalance to finish',
            'They re-validate every checksum before delivery',
          ],
          answer: 0,
          explain: 'Visibility is bounded by the last stable offset so that aborted records are never exposed. An open transaction holds back the offset until it commits or aborts.',
        },
      ],
      quickbytes: [
        'Exactly-once is at-least-once plus dedup; find the dedup state before believing the claim.',
        'Fence with an epoch, not just a sequence: a paused producer can outlive its session.',
        'Commit offsets after the sink write, never before it.',
        'Draw the transaction boundary; everything outside it needs a key.',
      ],
      production: [
        'Producer ids, epochs and sequence state are durable across broker restarts.',
        'Consumer offsets commit atomically with the produced output.',
        'External sinks are keyed and idempotent, with the key derived from the record identity.',
        'Aborted transaction rate and last-stable-offset lag are dashboards, not mysteries.',
        'Rebalance handling aborts in-flight transactions and replays from the last committed offset.',
      ],
      crates: ['rdkafka', 'serde', 'tokio', 'tracing'],
      github: [
        { name: 'fede1024/rust-rdkafka', url: 'https://github.com/fede1024/rust-rdkafka' },
        { name: 'tokio-rs/tokio', url: 'https://github.com/tokio-rs/tokio' },
      ],
      pitfall: 'Committing the offset before the database write. A crash in between replays nothing, the write is lost, and the pipeline reports success - the opposite failure from the duplicate everyone plans for.',
      resources: [
        { title: 'Apache Kafka documentation: delivery semantics and transactions', url: 'https://kafka.apache.org/documentation/', kind: 'docs' },
        { title: 'rdkafka: transactional producer and consumer configuration', url: 'https://docs.rs/rdkafka/latest/rdkafka/', kind: 'docs' },
        { title: 'Kafka protocol guide: record batches, producer ids and transaction markers', url: 'https://kafka.apache.org/protocol.html', kind: 'docs' },
        { title: 'fede1024/rust-rdkafka', url: 'https://github.com/fede1024/rust-rdkafka', kind: 'repo' },
      ],
    },
    {
      id: 'e13',
      title: 'Idempotency keys at the API boundary',
      minutes: 80,
      level: 'advanced',
      goal: 'Make a retried write safe with a client-supplied key, a payload fingerprint and a persisted response, and handle the concurrent duplicate that arrives while the first attempt is still running.',
      sections: [
        {
          h: 'An idempotency key is a promise about a payload',
          p: [
            "A key alone is not enough. If a client reuses the same key with a different amount, replaying the stored response silently returns the wrong answer for the new request. Bind the key to a fingerprint of the canonical request body and the authenticated identity, and reject a mismatch with a 422 instead of guessing.",
            "Scope and lifetime matter too. Keys are scoped per customer, never global, or one tenant can probe another's responses. The retention window must exceed the client's retry horizon including its backoff tail: a key that expires after one hour while a mobile client retries for two produces a duplicate charge, which is exactly the failure the key was meant to prevent.",
          ],
          list: [
            'Client generates the key, server treats it as opaque',
            'Fingerprint covers method, path, body and caller identity',
            'Unique constraint on (tenant, key) does the arbitration - not a read-then-write check',
            'Retention exceeds the maximum retry window, and the record is immutable once completed',
          ],
          tip: 'Hash the canonical JSON, not the raw bytes. Key ordering and whitespace differences turn a legitimate retry into a spurious 422.',
        },
        {
          h: 'The concurrent duplicate is the interesting case',
          p: [
            "Two identical requests arrive within milliseconds. Both find no record, both start work, both charge the card. The fix is to insert the key before doing the work, under a unique constraint, and treat the losing insert as a signal: the winner is in progress, and the loser returns 409 or waits briefly rather than starting a second charge.",
            "The state machine is small: in_progress, completed, failed. A completed row stores the status code and the response body, so a retry can replay it byte for byte. A failed row can be retried or deleted depending on whether the failure is known-safe; an in_progress row that is older than a timeout means the worker died, and the row must be taken over carefully - usually by re-running against an idempotent downstream, not by assuming it never happened.",
          ],
          code: `use sqlx::{PgPool, Row};

#[derive(Debug)]
pub struct Stored {
    pub status: u16,
    pub body: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Claim {
    Execute,
    Replay(Stored),
    /// Same key, different payload: a client bug, not a retry.
    Mismatch,
    /// Another request holds the key and has not finished.
    InProgress,
}

pub async fn claim(
    pool: &PgPool,
    tenant: &str,
    key: &str,
    fingerprint: &str,
) -> Result<Claim, sqlx::Error> {
    let inserted = sqlx::query(
        "INSERT INTO idempotency (tenant, key, fingerprint, state)
         VALUES ($1, $2, $3, 'in_progress')
         ON CONFLICT (tenant, key) DO NOTHING",
    )
    .bind(tenant)
    .bind(key)
    .bind(fingerprint)
    .execute(pool)
    .await?
    .rows_affected();
    if inserted == 1 {
        return Ok(Claim::Execute);
    }
    let row = sqlx::query(
        "SELECT fingerprint, state, status, body
           FROM idempotency WHERE tenant = $1 AND key = $2",
    )
    .bind(tenant)
    .bind(key)
    .fetch_one(pool)
    .await?;
    if row.try_get::<String, _>("fingerprint")? != fingerprint {
        return Ok(Claim::Mismatch);
    }
    if row.try_get::<String, _>("state")? != "completed" {
        return Ok(Claim::InProgress);
    }
    Ok(Claim::Replay(Stored {
        status: row.try_get::<i16, _>("status")? as u16,
        body: row.try_get("body")?,
    }))
}`,
          tip: 'Never store the response before the side effect. The order is: claim the key, run the effect idempotently, write the completion. A crash in the middle leaves in_progress, which is recoverable; a stored success with no effect is not.',
        },
        {
          h: 'Idempotency by construction is cheaper',
          p: [
            "Not every write needs a key. PUT with a client-chosen identifier, DELETE, and conditional updates with an entity tag are naturally idempotent: replaying them produces the same state. Insert with a natural key plus ON CONFLICT DO NOTHING is idempotent without any extra table. Use keys for the operations that create something with a server-generated id and an external side effect - payments being the canonical example.",
            "State machines are the other lever. A write that says set status to shipped is idempotent when the transition is validated against the current state; a write that says increment shipped_count is not. Choosing the former at the API boundary removes an entire class of duplicate bugs, and it is a design decision you make once rather than a table you maintain forever.",
          ],
          list: [
            'PUT by client id, DELETE, and compare-and-set are naturally idempotent',
            'Use a key for create-with-server-id plus external side effects',
            'Prefer absolute state transitions over relative increments',
            'Record idempotency outcomes, not just hits: a rising mismatch rate is a client bug',
          ],
          tip: 'Retrofitting keys onto an existing API is a migration: old clients do not send them, so the endpoint must accept both modes and the unsafe mode needs a different rate limit.',
        },
      ],
      exercise: {
        prompt: 'Implement an in-memory idempotency registry with states: the first claim executes, a concurrent claim returns InProgress, a completed claim replays the stored response, and a mismatched fingerprint is rejected. Include a TTL sweep for stale in-progress records.',
        starter: `use std::collections::HashMap;

pub struct Entry {
    pub fingerprint: String,
    pub state: State,
    pub response: Option<(u16, String)>,
}

pub enum State { InProgress, Completed }

pub struct Registry {
    pub entries: HashMap<String, Entry>,
}

impl Registry {
    pub fn claim(&mut self, key: &str, fingerprint: &str) -> Result<Claim, &'static str> {
        todo!()
    }
    pub fn complete(&mut self, key: &str, status: u16, body: &str) { todo!() }
}`,
        hint: 'Insert on miss and return Execute; on hit compare fingerprints first, then state. Only completed rows replay. complete() must not overwrite a row that another caller owns with a different fingerprint.',
        solution: `use std::collections::HashMap;

#[derive(Debug, PartialEq, Eq)]
pub enum State { InProgress, Completed }

pub struct Entry {
    pub fingerprint: String,
    pub state: State,
    pub response: Option<(u16, String)>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Claim {
    Execute,
    Replay(u16, String),
    Mismatch,
    InProgress,
}

pub struct Registry {
    pub entries: HashMap<String, Entry>,
}

impl Registry {
    pub fn new() -> Self {
        Self { entries: HashMap::new() }
    }

    pub fn claim(&mut self, key: &str, fingerprint: &str) -> Result<Claim, &'static str> {
        if let Some(entry) = self.entries.get(key) {
            if entry.fingerprint != fingerprint {
                return Ok(Claim::Mismatch);
            }
            return Ok(match &entry.state {
                State::Completed => {
                    let (status, body) = entry.response.clone().ok_or("completed without response")?;
                    Claim::Replay(status, body)
                }
                State::InProgress => Claim::InProgress,
            });
        }

        self.entries.insert(
            key.to_string(),
            Entry {
                fingerprint: fingerprint.to_string(),
                state: State::InProgress,
                response: None,
            },
        );
        Ok(Claim::Execute)
    }

    pub fn complete(&mut self, key: &str, status: u16, body: &str) {
        if let Some(entry) = self.entries.get_mut(key) {
            entry.state = State::Completed;
            entry.response = Some((status, body.to_string()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_duplicate_does_not_start_twice() {
        let mut r = Registry::new();
        assert_eq!(r.claim("k1", "fp-1").unwrap(), Claim::Execute);
        assert_eq!(r.claim("k1", "fp-1").unwrap(), Claim::InProgress);

        r.complete("k1", 201, "{\\"id\\":7}");
        assert_eq!(r.claim("k1", "fp-1").unwrap(), Claim::Replay(201, "{\\"id\\":7}".to_string()));
        assert_eq!(r.claim("k1", "fp-2").unwrap(), Claim::Mismatch);
    }
}`,
      },
      questions: [
        {
          q: 'Why must the idempotency key be bound to a request fingerprint?',
          options: [
            'A reused key with a different payload would otherwise replay the wrong response',
            'The fingerprint is used as the primary key',
            'It makes the key shorter',
            'It removes the need for a unique constraint',
          ],
          answer: 0,
          explain: 'Clients reuse keys by accident and attackers reuse them deliberately. Binding the key to a hash of the canonical request lets the server detect a different request and reject it instead of replaying a stale result.',
        },
        {
          q: 'Two identical requests arrive at the same instant. What prevents two effects?',
          options: [
            'Inserting the key first under a unique constraint, so the loser observes an existing row',
            'A read-then-write check inside a transaction',
            'A per-client rate limit',
            'Storing the response before the effect',
          ],
          answer: 0,
          explain: 'A read followed by a write has a race window between them. The unique constraint is the arbitration point: exactly one insert succeeds, and the other caller learns that work is already in progress.',
        },
        {
          q: 'Which operation is naturally idempotent without a key?',
          options: [
            'PUT with a client-chosen id',
            'POST creating a server-generated id',
            'An increment of a counter',
            'Appending an event to a log',
          ],
          answer: 0,
          explain: 'Client-chosen ids make the second PUT overwrite the same resource with the same value. POST and increments create new effects each time, and appends create new events.',
        },
      ],
      quickbytes: [
        'Insert the key first; the unique constraint is the arbitrator.',
        'Fingerprint the canonical payload, not the raw bytes.',
        'Keep the record longer than the client retry horizon, including backoff.',
        'Prefer absolute state transitions over increments at the API boundary.',
      ],
      production: [
        'The idempotency table has a unique constraint on (tenant, key) and a TTL index.',
        'Stored responses are immutable and replayed byte for byte, including status codes.',
        'A sweeper detects in-progress rows older than the worker timeout and resolves them explicitly.',
        'Mismatch and replay rates are metricised per endpoint.',
        'Key retention is documented against the slowest client retry policy.',
      ],
      crates: ['sqlx', 'serde', 'tokio', 'uuid'],
      github: [
        { name: 'launchbadge/sqlx', url: 'https://github.com/launchbadge/sqlx' },
        { name: 'uuid-rs/uuid', url: 'https://github.com/uuid-rs/uuid' },
      ],
      pitfall: 'Checking for an existing key with SELECT and then inserting. Two concurrent requests both see nothing, both insert, both charge the card, and the unique constraint is missing or added later as a "cleanup".',
      resources: [
        { title: 'PostgreSQL: INSERT ... ON CONFLICT and unique constraints', url: 'https://www.postgresql.org/docs/current/sql-insert.html', kind: 'docs' },
        { title: 'PostgreSQL: transaction isolation and concurrent inserts', url: 'https://www.postgresql.org/docs/current/transaction-iso.html', kind: 'docs' },
        { title: 'sqlx: async Postgres from Rust', url: 'https://docs.rs/sqlx/latest/sqlx/', kind: 'docs' },
        { title: 'launchbadge/sqlx', url: 'https://github.com/launchbadge/sqlx', kind: 'repo' },
      ],
    },
    {
      id: 'e14',
      title: 'Two-phase commit and the in-doubt window',
      minutes: 90,
      level: 'advanced',
      goal: 'Run a two-phase commit with a durable decision record, explain why a coordinator crash blocks participants, and choose between 2PC, a saga and a single-database transaction for a given boundary.',
      sections: [
        {
          h: 'Prepare, then decide, then finish',
          p: [
            "Two-phase commit gives atomicity across participants: the coordinator asks everyone to prepare (vote yes means the participant has durably staged the change and can commit later), then sends commit or abort once it has all votes. If any vote is no, everyone aborts. The protocol is correct, and it is blocking: a participant that voted yes must wait for the decision, and a coordinator that dies after collecting votes leaves everyone holding locks with no way to decide.",
            "The fix is durability, not cleverness. The coordinator writes its decision to a replicated log before sending it, and participants can then ask any surviving coordinator instance what the outcome was. If the decision record is lost, the only safe outcome is to block, because guessing abort can break atomicity when another participant already committed.",
          ],
          code: `#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Vote {
    Yes,
    No,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Commit,
    Abort,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TxRecord {
    pub id: u64,
    pub participants: Vec<String>,
    pub votes: Vec<(String, Vote)>,
    pub decision: Option<Decision>,
}

impl TxRecord {
    /// The decision function is pure and idempotent: the same votes always
    /// produce the same outcome. It is written to the log before any
    /// participant is told anything.
    pub fn decide(&mut self, votes: Vec<(String, Vote)>) -> Decision {
        if let Some(decision) = self.decision {
            return decision; // recovery path: never re-decide
        }
        self.votes = votes;
        let decision = if self.votes.iter().all(|(_, v)| *v == Vote::Yes) {
            Decision::Commit
        } else {
            Decision::Abort
        };
        self.decision = Some(decision);
        decision
    }

    /// A record with votes but no decision is in doubt: the coordinator
    /// must recover the decision, not invent one.
    pub fn is_in_doubt(&self) -> bool {
        self.decision.is_none() && !self.votes.is_empty()
    }
}`,
          tip: 'Write the decision record to a replicated store, not to the coordinator local disk. A coordinator that cannot survive its own host failure cannot be the source of truth for anyone else.',
        },
        {
          h: 'The blocking window is a product decision',
          p: [
            "An in-doubt transaction holds row locks, connections, and sometimes a business-level reservation. If the coordinator is down for twenty minutes, those locks live for twenty minutes and every dependent request queues behind them. That is why the coordinator is usually a replicated service with a fast failover, and why the transaction should be short: the shorter the window between the last prepare and the decision, the smaller the blast radius.",
            "Presumed abort helps on the participant side: if a participant has prepared but hears nothing, it may abort after the transaction times out only if it is certain the coordinator never committed. It is not certain, which is why the timeout only applies to transactions the coordinator has abandoned, and why the coordinator must record abandonment before the participant is allowed to act on it.",
          ],
          list: [
            'Keep the prepare-to-decide window as short as the work allows',
            'The coordinator is replicated; its decision log is the source of truth',
            'Participants never guess: they resolve through the log',
            'Monitor in-doubt count with an alert, because it predicts lock pileups',
          ],
          tip: 'Instrument the age of the oldest in-doubt transaction. A count tells you something is stuck; an age tells you how much of the system is stuck behind it.',
        },
        {
          h: 'When not to use 2PC',
          p: [
            "If both writes hit the same database, you already have a transaction; 2PC across two services on that database is pure overhead. If one write is a database row and the other is a message, the transactional outbox gives you atomicity with one local transaction and a relay, no coordinator required. If the boundary spans long-running business steps with external systems, a saga with compensations fits the failure model better than holding locks for minutes.",
            "2PC earns its keep when the participants are few, the operation is short, and the participants are databases that already implement prepared transactions. Spanner and Percolator both run 2PC, but over consensus-replicated partitions with timestamps, so the coordinator failure is absorbed by the consensus layer rather than by a human with a runbook.",
          ],
          list: [
            'Same database: use the database transaction',
            'Database plus message: outbox, not 2PC',
            'Long business process: saga with compensations',
            'Few short-lived participants with prepared-transaction support: 2PC',
          ],
          tip: 'Count the round trips: 2PC costs at least two network round trips plus two fsyncs. If the operation is on a user-facing path, that latency is part of the design, not an implementation detail.',
        },
      ],
      exercise: {
        prompt: 'Implement coordinator recovery: given a durable log entry with votes and an optional decision, return the actions to take on startup - resolve the decision if missing, then send commit or abort to participants who have not acknowledged. Never invent a decision.',
        starter: `#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Vote { Yes, No }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision { Commit, Abort }

pub struct Record {
    pub id: u64,
    pub votes: Vec<(String, Vote)>,
    pub decision: Option<Decision>,
    pub acked: Vec<String>,
}

pub enum Action {
    Persist(Decision),
    Send { participant: String, decision: Decision },
}

pub fn recover(record: &mut Record) -> Vec<Action> {
    todo!()
}`,
        hint: 'If a decision exists, do not compute a new one. If votes are complete but the decision is missing, compute it from the votes and persist before sending. Then send only to participants missing from acked.',
        solution: `#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Vote { Yes, No }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision { Commit, Abort }

pub struct Record {
    pub id: u64,
    pub votes: Vec<(String, Vote)>,
    pub decision: Option<Decision>,
    pub acked: Vec<String>,
}

pub enum Action {
    Persist(Decision),
    Send { participant: String, decision: Decision },
}

pub fn recover(record: &mut Record) -> Vec<Action> {
    let mut actions = Vec::new();

    let decision = match record.decision {
        Some(d) => d,
        None => {
            if record.votes.is_empty() {
                // Nothing was prepared: abort is safe and needs no record.
                return actions;
            }
            let d = if record.votes.iter().all(|(_, v)| *v == Vote::Yes) {
                Decision::Commit
            } else {
                Decision::Abort
            };
            record.decision = Some(d);
            actions.push(Action::Persist(d));
            d
        }
    };

    for (participant, _) in &record.votes {
        if !record.acked.contains(participant) {
            actions.push(Action::Send {
                participant: participant.clone(),
                decision,
            });
        }
    }

    actions
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_redecides_a_committed_transaction() {
        let mut record = Record {
            id: 1,
            votes: vec![("a".into(), Vote::Yes)],
            decision: Some(Decision::Commit),
            acked: vec!["a".into()],
        };
        assert!(recover(&mut record).is_empty());
        assert_eq!(record.decision, Some(Decision::Commit));
    }

    #[test]
    fn a_no_vote_means_abort_even_without_a_decision() {
        let mut record = Record {
            id: 2,
            votes: vec![("a".into(), Vote::Yes), ("b".into(), Vote::No)],
            decision: None,
            acked: vec![],
        };
        let actions = recover(&mut record);
        assert!(matches!(actions.first(), Some(Action::Persist(Decision::Abort))));
        assert_eq!(record.decision, Some(Decision::Abort));
    }
}`,
      },
      questions: [
        {
          q: 'Why does a coordinator crash after all prepares block the participants?',
          options: [
            'They must wait for a decision they cannot derive safely on their own',
            'They have already committed and cannot roll back',
            'They lost their locks when the coordinator died',
            'They must re-prepare with a new coordinator before aborting',
          ],
          answer: 0,
          explain: 'A prepared participant has staged the change and may have to commit if any other participant committed. Without the durable decision, aborting risks breaking atomicity, so it blocks.',
        },
        {
          q: 'When is the transactional outbox a better choice than 2PC?',
          options: [
            'When one write is a row and the other is a message that must be published',
            'When both writes are in different databases that support prepare',
            'When the operation must hold locks for several minutes',
            'When the coordinator is a single non-replicated process',
          ],
          answer: 0,
          explain: 'The outbox makes the row and the message atomic in one local transaction, and a relay publishes later. No distributed coordinator is needed, at the cost of a delivery delay and at-least-once publishing.',
        },
        {
          q: 'What does presumed abort allow a participant to do?',
          options: [
            'Abort an abandoned transaction after a timeout, once abandonment is recorded',
            'Commit without a decision if it is the last participant',
            'Forget a prepared transaction immediately on restart',
            'Recover the decision from a peer participant',
          ],
          answer: 0,
          explain: 'Presumed abort is safe only when the coordinator has durably recorded that it will not commit. Otherwise aborting a prepared participant can contradict another participant that already committed.',
        },
      ],
      quickbytes: [
        'Write the decision to a replicated log before telling anyone.',
        'A participant never guesses: it resolves through the decision record.',
        'Alert on the age of the oldest in-doubt transaction, not just the count.',
        'Database plus message means outbox; long business process means saga.',
      ],
      production: [
        'The coordinator decision log is replicated and survives coordinator host loss.',
        'Prepared transactions have a timeout only after abandonment is durably recorded.',
        'In-doubt age is alerted with a page, because locks pile up behind it.',
        'Transaction scope is measured; a prepare-to-decide window above the target fails review.',
        'Participants expose a recovery endpoint so an operator can resolve without guessing.',
      ],
      crates: ['sqlx', 'tokio', 'serde', 'uuid'],
      github: [
        { name: 'launchbadge/sqlx', url: 'https://github.com/launchbadge/sqlx' },
        { name: 'launchbadge/sqlx', url: 'https://github.com/launchbadge/sqlx' },
      ],
      pitfall: 'Storing the coordinator decision in local memory and returning it to participants on a retry. After a restart the coordinator has no record, aborts a transaction that another participant already committed, and the two databases disagree permanently.',
      resources: [
        { title: 'Spanner: two-phase commit over Paxos groups (OSDI 2012)', url: 'https://www.usenix.org/conference/osdi12/technical-sessions/presentation/corbett', kind: 'paper' },
        { title: 'PostgreSQL: PREPARE TRANSACTION and prepared transaction limits', url: 'https://www.postgresql.org/docs/current/sql-prepare-transaction.html', kind: 'docs' },
        { title: 'PostgreSQL: transaction isolation levels', url: 'https://www.postgresql.org/docs/current/transaction-iso.html', kind: 'docs' },
        { title: 'etcd: the replicated log behind coordinator failover', url: 'https://github.com/etcd-io/etcd', kind: 'repo' },
      ],
    },
    {
      id: 'e15',
      title: 'Sagas: compensation, isolation and the pivot step',
      minutes: 85,
      level: 'advanced',
      goal: 'Model a long-running business transaction as local steps with compensations, fix the isolation anomalies that compensation cannot undo, and persist the saga state so a restart resumes rather than restarts.',
      sections: [
        {
          h: 'A saga is a sequence with an undo, not a rollback',
          p: [
            "Garcia-Molina and Salem described sagas in 1987 as a sequence of local transactions, each paired with a compensating transaction that semantically undoes it if a later step fails. There is no global lock and no atomic visibility: intermediate states are visible to everyone, which is the point (it keeps locks short) and the problem (other transactions can read them).",
            "The difference between undo and compensation is not cosmetic. A card authorization is voided, a charge is refunded, a shipment is recalled, an email cannot be unsent. Compensations are new business actions with their own failure modes, they may not be commutative with later steps, and they may fail permanently - which means the saga needs a human escalation path, not just a retry loop.",
          ],
          list: [
            'Each step is a local transaction with a durable effect',
            'Each step has a compensation that is itself idempotent',
            'Compensations run in reverse order, and only for steps that completed',
            'Some compensations are impossible (email sent); design those steps last',
          ],
          tip: 'Order steps so the irreversible ones come after the risky ones. The cheapest compensation is the one you never have to run.',
        },
        {
          h: 'Isolation is what you give up',
          p: [
            "Because intermediate states are visible, a saga can suffer dirty reads (another transaction sees a reservation that is later cancelled), lost updates (two sagas read the same balance and both act), and fuzzy reads (a value changes between two reads inside one saga). A database transaction prevents these with locks; a saga prevents them with design.",
            "The two standard remedies are a semantic lock - a flag that marks the record as pending and causes other transactions to wait or fail - and a pivot transaction, the point after which the saga can no longer be aborted and everything must run forward. Steps before the pivot are retryable and compensable; steps after it are retryable only. Naming the pivot explicitly is the difference between a saga you can operate and one that deadlocks itself during an incident.",
          ],
          code: `#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    ReserveStock { sku: String, qty: u32 },
    ChargeCard { amount_minor: u64 },
    CreateShipment { address_id: u64 },
    SendConfirmation { email: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Compensation {
    ReleaseStock { sku: String, qty: u32 },
    Refund { amount_minor: u64 },
    CancelShipment { address_id: u64 },
    /// Irreversible: the only action is to record that it happened.
    RecordOnly { note: String },
}

impl Step {
    pub fn compensation(&self) -> Compensation {
        match self {
            Step::ReserveStock { sku, qty } => {
                Compensation::ReleaseStock { sku: sku.clone(), qty: *qty }
            }
            Step::ChargeCard { amount_minor } => Compensation::Refund { amount_minor: *amount_minor },
            Step::CreateShipment { address_id } => {
                Compensation::CancelShipment { address_id: *address_id }
            }
            Step::SendConfirmation { email } => Compensation::RecordOnly {
                note: format!("confirmation already sent to {email}"),
            },
        }
    }

    /// Steps after the pivot can be retried but never undone normally.
    pub fn is_pivot(&self) -> bool {
        matches!(self, Step::ChargeCard { .. })
    }
}

/// Reverse order, only for steps that actually completed.
pub fn compensation_plan(completed: &[Step]) -> Vec<Compensation> {
    completed.iter().rev().map(Step::compensation).collect()
}`,
          tip: 'Persist the completed step list before running the next step. If the process dies after charging the card but before recording it, the compensation will never run.',
        },
        {
          h: 'Orchestration, state and the operator',
          p: [
            "A choreographed saga - each service listening for events and emitting the next - spreads the workflow across services with no single owner, which is elegant until you need to answer what state is this order in. An orchestrated saga keeps the sequence in one service with a persisted state machine, so the answer is a row, and a stuck saga is a query.",
            "Persist the saga id, the completed steps, the current step, retry counts and the escalation deadline. Every step and compensation takes the saga id as its idempotency key, so a retried call after a timeout is a no-op. A sweeper finds sagas past their deadline and either retries or escalates to a human queue; a saga that silently stops is worse than one that fails loudly.",
          ],
          list: [
            'One state machine per saga instance, persisted, with an explicit current step',
            'Step idempotency key = saga id plus step name',
            'A sweeper with an escalation queue, not an infinite retry',
            'Every transition emits a span and a metric tagged with the saga type',
          ],
          tip: 'Test the restart path by killing the orchestrator between every pair of steps. The failures you find are the ones that only appear in production at 3 a.m.',
        },
      ],
      exercise: {
        prompt: 'Implement the saga runner: execute steps in order, record each completed step durably, and on failure run compensations in reverse for completed steps only. Make each step and compensation idempotent by key and stop at a permanent failure with an escalation.',
        starter: `#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Saga {
    pub id: String,
    pub completed: Vec<&'static str>,
    pub escalated: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum StepResult { Done, Retryable, Permanent }

/// Run steps until one fails, then compensate the completed prefix.
pub async fn run(
    saga: &mut Saga,
    steps: &[&'static str],
    mut exec: impl FnMut(&str, &str) -> StepResult,
    mut compensate: impl FnMut(&str, &str) -> StepResult,
) -> Result<(), String> {
    todo!()
}`,
        hint: 'Push the step onto completed only after it returns Done. On Retryable, stop and return an error so a sweeper resumes; on Permanent, compensate in reverse and mark escalated if a compensation also fails permanently.',
        solution: `#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Saga {
    pub id: String,
    pub completed: Vec<&'static str>,
    pub escalated: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum StepResult { Done, Retryable, Permanent }

pub async fn run(
    saga: &mut Saga,
    steps: &[&'static str],
    mut exec: impl FnMut(&str, &str) -> StepResult,
    mut compensate: impl FnMut(&str, &str) -> StepResult,
) -> Result<(), String> {
    for step in steps {
        if saga.completed.contains(step) {
            continue; // resume after a restart
        }
        match exec(&saga.id, step) {
            StepResult::Done => saga.completed.push(step),
            StepResult::Retryable => {
                return Err(format!("saga {} paused at step {}", saga.id, step));
            }
            StepResult::Permanent => {
                for done in saga.completed.clone().into_iter().rev() {
                    if compensate(&saga.id, done) == StepResult::Permanent {
                        saga.escalated = true;
                    }
                }
                return Err(format!("saga {} failed at step {} and was compensated", saga.id, step));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compensates_only_completed_steps_in_reverse() {
        let mut saga = Saga { id: "s-1".into(), completed: vec![], escalated: false };
        let mut order = Vec::new();

        let result = futures::executor::block_on(run(
            &mut saga,
            &["reserve", "charge", "ship"],
            |_, step| if step == "ship" { StepResult::Permanent } else { StepResult::Done },
            |_, step| {
                order.push(step.to_string());
                StepResult::Done
            },
        ));

        assert!(result.is_err());
        assert_eq!(order, vec!["charge".to_string(), "reserve".to_string()]);
        assert!(!saga.escalated);
    }
}`,
      },
      questions: [
        {
          q: 'What does a saga give up compared with a distributed transaction?',
          options: [
            'Isolation: intermediate states are visible to other transactions',
            'Atomicity of each individual step',
            'Durability of each step',
            'The ability to define a failure path',
          ],
          answer: 0,
          explain: 'Each step is a durable local transaction, so atomicity and durability hold locally. What is missing is isolation across steps, which is why dirty reads and lost updates appear and need semantic locks or pivot design.',
        },
        {
          q: 'What is the pivot transaction in a saga?',
          options: [
            'The step after which the saga can no longer be aborted and must run forward',
            'The first step, which reserves all resources',
            'The step that has no compensation',
            'The step that is retried the most',
          ],
          answer: 0,
          explain: 'Before the pivot, a failure triggers compensations. At and after the pivot, the business decision is committed, so the only path is forward with retries and escalation.',
        },
        {
          q: 'Why must compensation and step calls use a key derived from the saga id?',
          options: [
            'A retry after a timeout must be a no-op, not a second refund',
            'The key is used to route the request to the right shard',
            'It allows compensations to run in parallel',
            'It replaces the need to persist saga state',
          ],
          answer: 0,
          explain: 'Timeouts are ambiguous: the call may have succeeded. A deterministic key per saga step and per compensation makes the retry safe, which is necessary because the orchestrator cannot distinguish the two cases.',
        },
      ],
      quickbytes: [
        'Order irreversible steps last; the cheapest compensation is the one you never run.',
        'Persist the completed step before starting the next one.',
        'Name the pivot; ambiguity there is where incidents become outages.',
        'Every compensation is idempotent because every compensation will be retried.',
      ],
      production: [
        'Saga state is persisted per instance with current step, retries and deadline.',
        'Step and compensation keys are deterministic and enforced by the callee.',
        'A sweeper escalates sagas past their deadline to a human queue.',
        'Restart-between-steps is part of the test suite, not a manual drill.',
        'Saga progress and stuck counts are metrics per saga type.',
      ],
      crates: ['tokio', 'futures', 'serde', 'tracing'],
      github: [
        { name: 'tokio-rs/tokio', url: 'https://github.com/tokio-rs/tokio' },
        { name: 'tokio-rs/tracing', url: 'https://github.com/tokio-rs/tracing' },
      ],
      pitfall: 'Recording a step as completed before its effect is durable. The orchestrator dies, resumes after the last recorded step, and the customer is charged twice while the saga log shows a clean run.',
      resources: [
        { title: 'Sagas (SIGMOD 1987)', url: 'https://dl.acm.org/doi/10.1145/38713.38742', kind: 'paper' },
        { title: 'PostgreSQL: transaction isolation and the anomalies sagas expose', url: 'https://www.postgresql.org/docs/current/transaction-iso.html', kind: 'docs' },
        { title: 'Highly available transactions: what isolation costs', url: 'https://dl.acm.org/doi/10.14778/2732232.2732237', kind: 'paper' },
        { title: 'CNCF talks on workflow orchestration and long-running transactions', url: 'https://www.youtube.com/@cncf', kind: 'video' },
      ],
    },
    {
      id: 'e16',
      title: 'Consensus in practice: sizing, fsync and read paths',
      minutes: 100,
      level: 'industry',
      goal: 'Size a Raft cluster from its failure budget, wire openraft correctly, and operate the things that actually break: fsync latency, snapshot transfer, membership changes and read consistency.',
      sections: [
        {
          h: 'Size by failure budget, not by superstition',
          p: [
            "A cluster of 2f+1 nodes tolerates f failures, so three tolerates one and five tolerates two. Even sizes are strictly worse than the odd number below them: four nodes still need three for a majority and tolerate one failure, exactly like three, with more hardware and more places to fail. That arithmetic is the only part of sizing that is settled.",
            "The unsettled part is latency. A quorum write completes when the slowest of the majority acknowledges, so what matters is the p99 of the slowest replica, not the average across the cluster. A five-node cluster spread over three regions writes at the speed of the second-slowest region. If that number is unacceptable, the fix is fewer regions per group or more independence per region - not a bigger cluster.",
          ],
          list: [
            '3 nodes: one failure, lowest coordination cost',
            '5 nodes: two failures, or survival of a whole region with a 3+2 layout',
            '7 nodes: diminishing returns; quorum latency grows with the slowest majority',
            'Learners catch up without voting, which is how you add a node without risking quorum',
          ],
          tip: 'Write the failure budget down: "we survive one region loss" is a design statement that determines the size and placement, not a post-hoc justification.',
        },
        {
          h: 'Durability is fsync, and fsync is the latency floor',
          p: [
            "A Raft node must persist its term, vote and log entries before acknowledging. In practice that means one fsync per batch on the log file, and the throughput of the group is bounded by the number of fsyncs the slowest disk can complete per second, divided by the batch size. A cluster with a 2 ms fsync and single-entry batches tops out around 500 writes per second per group, no matter how many cores you add.",
            "This is why production implementations batch aggressively, keep the log on a dedicated device, and treat disk latency as a first-class metric. It is also why election timeouts must sit far above the fsync p99: when a snapshot write blocks the log for 400 ms, a 150 ms timeout elects a new leader and the term churn makes the disk problem worse.",
          ],
          code: `use std::collections::BTreeMap;
use std::io::Cursor;
use std::sync::Arc;

use openraft::{BasicNode, Config, Raft};

openraft::declare_raft_types!(
    pub TypeConfig:
        D = KvRequest,
        R = KvResponse,
        NodeId = u64,
        Node = BasicNode,
        Entry = openraft::Entry<TypeConfig>,
        SnapshotData = Cursor<Vec<u8>>,
        AsyncRuntime = openraft::TokioRuntime,
);

/// Build the node. Storage and network are your implementations of
/// RaftLogStorage, RaftStateMachine and RaftNetworkFactory.
pub async fn start(
    id: u64,
    network: KvNetwork,
    log_store: KvLogStore,
    state_machine: KvStateMachine,
) -> Result<Raft<TypeConfig>, Box<dyn std::error::Error>> {
    let config = Arc::new(Config::default().validate()?);
    let raft = Raft::new(id, config, network, log_store, state_machine).await?;
    Ok(raft)
}

/// Bootstrap exactly once, from one node, with the full initial membership.
pub async fn bootstrap(raft: &Raft<TypeConfig>) -> Result<(), Box<dyn std::error::Error>> {
    let members = BTreeMap::from([
        (1, BasicNode::default()),
        (2, BasicNode::default()),
        (3, BasicNode::default()),
    ]);
    raft.initialize(members).await?;
    Ok(())
}

pub async fn put(
    raft: &Raft<TypeConfig>,
    key: String,
    value: String,
) -> Result<u64, Box<dyn std::error::Error>> {
    let response = raft.client_write(KvRequest::Set { key, value }).await?;
    Ok(response.log_id.index)
}`,
          tip: 'Bootstrap from one node only. Two nodes that both initialize a cluster create two single-node groups that later refuse to merge, and the mistake looks like a network problem.',
        },
        {
          h: 'Reads, snapshots and membership are the operational surface',
          p: [
            "Writes go through the log, so they are linearizable by construction. Reads do not: a leader that has been partitioned may still answer locally with stale data. Use ReadIndex or a leader lease for reads that must be linearizable, and make the choice explicit in the API rather than defaulting to whatever is fastest.",
            "Snapshots keep the log bounded, but they are also the most disruptive thing the system does: writing one competes with log appends for disk, and installing one on a lagging follower can saturate its network for minutes. Cap snapshot size, transfer rate and concurrency, and alert when a follower has been behind for longer than the snapshot interval. Membership changes are the other sharp edge: change one voter at a time, add new nodes as learners first, and never run two changes concurrently.",
          ],
          list: [
            'ReadIndex for linearizable reads without a clock assumption',
            'Snapshot threshold on log entries or bytes, not on wall-clock time alone',
            'One membership change at a time, learners before voters',
            'Alert on leader changes per hour, apply lag, and snapshot bytes per second',
          ],
          tip: 'Drill the snapshot path in staging with a follower that is deliberately 100k entries behind. It is the slowest recovery path and the one least exercised by normal traffic.',
        },
      ],
      exercise: {
        prompt: 'Given a desired failure tolerance and the regions a cluster may span, compute the smallest odd cluster size and the per-region placement that survives the loss of one region, rejecting layouts where the remaining regions cannot form a majority.',
        starter: `#[derive(Debug, PartialEq, Eq)]
pub struct Layout {
    pub nodes_per_region: Vec<usize>,
    pub quorum: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SizingError {
    NoMajorityAfterRegionLoss,
    TooManyRegions,
}

pub fn plan(regions: &[&str], failures_to_tolerate: usize) -> Result<Layout, SizingError> {
    todo!()
}`,
        hint: 'Size is 2f+1, distributed as evenly as possible across regions, with any extra node in the first region. A region loss is survivable when the remaining nodes still reach a majority of the original size.',
        solution: `#[derive(Debug, PartialEq, Eq)]
pub struct Layout {
    pub nodes_per_region: Vec<usize>,
    pub quorum: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SizingError {
    NoMajorityAfterRegionLoss,
    TooManyRegions,
}

pub fn plan(regions: &[&str], failures_to_tolerate: usize) -> Result<Layout, SizingError> {
    if regions.is_empty() || regions.len() > 5 {
        return Err(SizingError::TooManyRegions);
    }
    let size = 2 * failures_to_tolerate + 1;
    let quorum = size / 2 + 1;

    let base = size / regions.len();
    let mut nodes_per_region = vec![base; regions.len()];
    for i in 0..(size % regions.len()) {
        nodes_per_region[i] += 1;
    }

    // Losing the largest region must still leave a majority.
    let largest = *nodes_per_region.iter().max().unwrap();
    if size - largest < quorum {
        return Err(SizingError::NoMajorityAfterRegionLoss);
    }

    Ok(Layout { nodes_per_region, quorum })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_regions_two_failures() {
        let layout = plan(&["eu", "us", "ap"], 2).unwrap();
        assert_eq!(layout.nodes_per_region, vec![2, 2, 1]);
        assert_eq!(layout.quorum, 3);
        assert_eq!(layout.nodes_per_region.iter().sum::<usize>(), 5);
    }

    #[test]
    fn rejects_layout_that_loses_majority_with_one_region() {
        assert_eq!(plan(&["eu", "us"], 2), Err(SizingError::NoMajorityAfterRegionLoss));
    }
}`,
      },
      questions: [
        {
          q: 'A four-node Raft cluster loses one node. What remains?',
          options: [
            'A working cluster with a quorum of 3, exactly like three nodes but with more hardware',
            'No quorum, because 4 is even',
            'A cluster that tolerates two failures',
            'A read-only cluster until the node returns',
          ],
          answer: 0,
          explain: 'The quorum is floor(4/2)+1 = 3, so three surviving nodes can commit. An even cluster buys no extra tolerance over the odd size below it while adding cost and failure surface.',
        },
        {
          q: 'What bounds write throughput on a single Raft group?',
          options: [
            'The fsync rate of the slowest disk in the majority, divided by the batch size',
            'The number of CPU cores on the leader',
            'The number of followers, regardless of quorum',
            'The size of the client connection pool',
          ],
          answer: 0,
          explain: 'Every acknowledged write requires persistence on a majority before the response. With one fsync per batch, throughput is fsync rate times batch size, and the slowest disk in the majority sets the floor.',
        },
        {
          q: 'Why add a new node as a learner first?',
          options: [
            'It can catch up without voting, so adding it cannot break quorum',
            'Learners commit entries faster than voters',
            'Learners do not need snapshots',
            'It avoids the need for a membership change',
          ],
          answer: 0,
          explain: 'A learner receives the log but does not count toward quorum, so a slow catch-up cannot stall commits. Once it is close, one membership change promotes it to a voter.',
        },
      ],
      quickbytes: [
        'Quorum latency is the slowest of the majority, not the cluster average.',
        'Election timeouts must clear the fsync p99 by a wide margin.',
        'Bootstrap once, from one node, with the full membership.',
        'One membership change at a time; learners before voters.',
      ],
      production: [
        'Leader changes per hour, apply lag and snapshot transfer rate are alerted metrics.',
        'The log lives on storage where fsync p99 is measured and published.',
        'Read paths document ReadIndex versus lease reads and their consistency.',
        'Membership changes are tooled, serialized and audited, never hand-edited config.',
        'A slow follower drill proves snapshot install works under load.',
      ],
      crates: ['openraft', 'tokio', 'serde', 'tracing'],
      github: [
        { name: 'databendlabs/openraft', url: 'https://github.com/databendlabs/openraft' },
        { name: 'etcd-io/etcd', url: 'https://github.com/etcd-io/etcd' },
      ],
      pitfall: 'Running a five-node cluster with a 150 ms election timeout on cloud disks whose fsync p99 is 300 ms. Every snapshot write causes an election, the cluster churns leaders, and the only visible symptom is mysterious latency spikes correlated with nothing in the application.',
      resources: [
        { title: 'openraft: RaftTypeConfig, Config and Raft API', url: 'https://docs.rs/openraft/latest/openraft/', kind: 'docs' },
        { title: 'openraft storage traits: RaftLogStorage and RaftStateMachine', url: 'https://docs.rs/openraft/latest/openraft/storage/index.html', kind: 'docs' },
        { title: 'The Raft paper: cluster membership and snapshots', url: 'https://raft.github.io/raft.pdf', kind: 'paper' },
        { title: 'RaftScope: watching elections and log repair', url: 'https://raft.github.io/raftscope/index.html', kind: 'docs' },
      ],
    },
    {
      id: 'e17',
      title: 'Clock skew: monotonic time, TrueTime and leases',
      minutes: 80,
      level: 'industry',
      goal: 'Separate wall clocks from monotonic clocks, bound the damage a clock step can do to timeouts and timestamps, and know when only an uncertainty interval can make an ordering claim.',
      sections: [
        {
          h: 'Two clocks, two jobs',
          p: [
            "SystemTime is wall-clock time: it can jump backwards when NTP corrects a drifting machine, and it can jump forwards when a VM is resumed after a pause. Instant is monotonic within a process: it never goes backwards, but it has no meaning across machines and its epoch is arbitrary. Timeouts, leases and rate limiters belong on Instant; only human-readable timestamps belong on SystemTime.",
            "The subtle failure is a clock step during a timeout. A 30-second timeout computed against SystemTime that jumps forward by an hour fires immediately, and one that jumps backward can hang for the length of the step. Tokio's sleep and timeout use the monotonic clock, but code that builds its own deadline from SystemTime reintroduces the bug in one line.",
          ],
          code: `use std::time::{Duration, Instant, SystemTime};

/// A deadline lives on the monotonic clock. It cannot be affected by NTP.
#[derive(Clone, Copy, Debug)]
pub struct Deadline {
    at: Instant,
}

impl Deadline {
    pub fn after(budget: Duration) -> Self {
        Self { at: Instant::now() + budget }
    }

    pub fn remaining(&self) -> Duration {
        self.at.saturating_duration_since(Instant::now())
    }

    pub fn expired(&self) -> bool {
        Instant::now() >= self.at
    }
}

/// A TrueTime-style uncertainty interval: the true time is somewhere in
/// [earliest, latest]. Ordering is only claimable when intervals do not
/// overlap; otherwise the caller must wait out the uncertainty.
#[derive(Clone, Copy, Debug)]
pub struct Timestamp {
    pub earliest: u64,
    pub latest: u64,
}

impl Timestamp {
    pub fn is_definitely_before(&self, other: &Timestamp) -> bool {
        self.latest < other.earliest
    }

    /// The wait needed before this timestamp is guaranteed to be in the past.
    pub fn commit_wait(&self) -> Duration {
        Duration::from_nanos(self.latest - self.earliest)
    }
}

/// Compare the wall delta with the monotonic delta to detect a step.
pub fn wall_step(
    wall_before: SystemTime,
    wall_after: SystemTime,
    mono_before: Instant,
    mono_after: Instant,
) -> Option<Duration> {
    let wall = wall_after.duration_since(wall_before).ok()?;
    let mono = mono_after.duration_since(mono_before);
    let skew = wall.abs_diff(mono);
    (skew > Duration::from_millis(50)).then_some(skew)
}`,
          tip: 'Log both clocks on every request: wall time for humans, monotonic elapsed for duration. When the two disagree, the difference is your skew signal.',
        },
        {
          h: 'Spanner buys ordering with uncertainty',
          p: [
            "Spanner's TrueTime exposes an interval that is guaranteed to contain the true time, implemented with GPS and atomic clocks in the datacentres. A transaction waits out the uncertainty of its commit timestamp before releasing locks, an approach called commit-wait, so a later transaction is guaranteed to see a larger timestamp. That is what converts timestamp order into a real-time order.",
            "Without clocks you get ordering from consensus instead: a log assigns positions, and every replica agrees on them. The trade is a round trip per operation. The engineering question is which cost you pay - commit-wait's few milliseconds with special hardware, or a consensus round trip with commodity clocks - and whether your ordering claim actually needs to be real-time.",
          ],
          list: [
            'Timestamp order is only real-time order when the uncertainty is bounded',
            'HLC gives bounded skew with logical counters, not a true-time guarantee',
            'Consensus order is real-time order without any clock assumption',
            'NTP drift on commodity hardware is milliseconds, not microseconds',
          ],
          tip: 'If a design says last-write-wins by timestamp, ask what bounds the skew. If the answer is NTP, the policy is incorrect for any conflict that matters.',
        },
        {
          h: 'Operational hygiene for clocks',
          p: [
            "Run a time daemon everywhere, alert when the offset exceeds a threshold well below any protocol assumption, and never allow a manual clock change on a live node. Containers share the host clock, so a host with a broken daemon silently breaks every container on it, including the ones that think they are unaffected.",
            "Measure skew continuously rather than trusting the daemon: exchange timestamps with a peer and compute the round-trip-corrected offset. A fleet-wide dashboard of offset by node catches the one host that is drifting before a lease or an idempotency window fails. In tests, inject steps and pauses deliberately - a deterministic simulator can advance time, and a chaos run can pause a process long enough to expire a lease.",
          ],
          list: [
            'Alert on absolute offset per node, not on daemon liveness',
            'Never order writes across nodes by wall clock unless the skew is bounded',
            'Use monotonic time for every timeout, lease and rate limiter',
            'Test with a paused process and a stepped clock, not only with slow responses',
          ],
          tip: 'A process paused for longer than its lease is indistinguishable from a crashed one to everyone else. That is why fencing tokens, not clocks, are the guarantee.',
        },
      ],
      exercise: {
        prompt: 'Implement a skew-bounded comparator: given two timestamps with uncertainty intervals and a maximum tolerated skew, decide whether one definitely precedes the other, whether they are concurrent, or whether the skew bound has been exceeded and the comparison must fail.',
        starter: `#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Interval {
    pub earliest: u64,
    pub latest: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Before,
    After,
    Concurrent,
    SkewTooLarge,
}

pub fn compare(a: Interval, b: Interval, max_skew: u64) -> Verdict {
    todo!()
}`,
        hint: 'The width of an interval is its uncertainty. If either width exceeds the tolerated skew, refuse to compare. Otherwise overlap means concurrent, and disjoint intervals give a definite order.',
        solution: `#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Interval {
    pub earliest: u64,
    pub latest: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Before,
    After,
    Concurrent,
    SkewTooLarge,
}

pub fn compare(a: Interval, b: Interval, max_skew: u64) -> Verdict {
    let width = |i: Interval| i.latest.saturating_sub(i.earliest);
    if width(a) > max_skew || width(b) > max_skew {
        return Verdict::SkewTooLarge;
    }
    if a.latest < b.earliest {
        Verdict::Before
    } else if b.latest < a.earliest {
        Verdict::After
    } else {
        Verdict::Concurrent
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlapping_intervals_are_concurrent() {
        let a = Interval { earliest: 100, latest: 120 };
        let b = Interval { earliest: 110, latest: 130 };
        assert_eq!(compare(a, b, 50), Verdict::Concurrent);
    }

    #[test]
    fn wide_uncertainty_refuses_to_order() {
        let a = Interval { earliest: 100, latest: 400 };
        let b = Interval { earliest: 500, latest: 600 };
        assert_eq!(compare(a, b, 50), Verdict::SkewTooLarge);
    }

    #[test]
    fn disjoint_narrow_intervals_order_cleanly() {
        let a = Interval { earliest: 100, latest: 110 };
        let b = Interval { earliest: 120, latest: 130 };
        assert_eq!(compare(a, b, 50), Verdict::Before);
    }
}`,
      },
      questions: [
        {
          q: 'Why must timeouts use a monotonic clock?',
          options: [
            'Wall-clock steps can make a timeout fire immediately or hang far too long',
            'Monotonic time is synchronized across machines',
            'Wall clocks have lower resolution',
            'Monotonic clocks survive process restarts',
          ],
          answer: 0,
          explain: 'Instant never moves backwards and is unaffected by NTP corrections. A deadline built on SystemTime can be jumped over by a clock step, changing the timeout arbitrarily.',
        },
        {
          q: 'What makes Spanner timestamp order equal real-time order?',
          options: [
            'TrueTime uncertainty intervals plus commit-wait, so timestamps never appear out of order',
            'GPS receivers in every client',
            'The Paxos leader assigns timestamps after a quorum read',
            'NTP with a very short polling interval',
          ],
          answer: 0,
          explain: 'A transaction waits out the uncertainty of its commit timestamp before releasing locks. That guarantees a later real-time transaction receives a larger timestamp, which is the property plain wall clocks lack.',
        },
        {
          q: 'A lease holder is paused for longer than its lease. What makes the system safe?',
          options: [
            'The resource rejects writes carrying a fence older than the newest it has accepted',
            'The lease granter sends a revocation that is always delivered',
            'The paused process detects the pause on resume and exits',
            'The monotonic clock does not advance while paused',
          ],
          answer: 0,
          explain: 'The holder cannot be trusted to know it was paused, and messages may be delayed to it. Fencing moves the decision to the resource, which rejects any token that is not strictly newer.',
        },
      ],
      quickbytes: [
        'Instant for timeouts and leases; SystemTime only for display.',
        'Alert on measured offset per node, not on daemon uptime.',
        'Timestamp ordering without a bounded uncertainty is a guess.',
        'Test with a paused process, since a pause is indistinguishable from a crash.',
      ],
      production: [
        'Every timeout, lease and rate limiter is built on the monotonic clock.',
        'Clock offset is measured per node and alerted below the smallest protocol assumption.',
        'No cross-node ordering relies on wall-clock timestamps without a stated skew bound.',
        'Requests log both wall time and monotonic duration.',
        'A paused-process test expires a lease and asserts that fencing rejects the old holder.',
      ],
      crates: ['tokio', 'tracing', 'serde'],
      github: [
        { name: 'tokio-rs/tokio', url: 'https://github.com/tokio-rs/tokio' },
        { name: 'madsim-rs/madsim', url: 'https://github.com/madsim-rs/madsim' },
      ],
      pitfall: 'Measuring a lease deadline with SystemTime and losing to an NTP correction. The lease appears to expire early, work stops mid-batch, and a retry performs the same operation while the previous holder never actually stopped.',
      resources: [
        { title: 'Time, clocks, and the ordering of events in a distributed system', url: 'https://dl.acm.org/doi/10.1145/359545.359563', kind: 'paper' },
        { title: 'Spanner: TrueTime and commit-wait (OSDI 2012)', url: 'https://www.usenix.org/conference/osdi12/technical-sessions/presentation/corbett', kind: 'paper' },
        { title: 'Tokio time: Instant, sleep and timeouts on a monotonic clock', url: 'https://docs.rs/tokio/latest/tokio/time/index.html', kind: 'docs' },
        { title: 'AWS time synchronization guidance for distributed workloads', url: 'https://docs.aws.amazon.com/whitepapers/latest/availability-and-beyond-improving-resilience/time-synchronization.html', kind: 'docs' },
      ],
    },
    {
      id: 'e18',
      title: 'Backpressure: queues are not capacity',
      minutes: 75,
      level: 'industry',
      goal: 'Bound every queue, shed load before latency collapses, and instrument queue age so overload shows up as a metric instead of an outage.',
      sections: [
        {
          h: 'A queue converts overload into latency',
          p: [
            "Little's law says the average number in a system equals arrival rate times time in system. When arrivals exceed service capacity, the number in the queue grows without bound and so does the time each item spends waiting. The queue does not create capacity; it hides the moment when demand exceeded supply, and then delivers the bill as a latency cliff.",
            "Unbounded channels are therefore a memory leak with a schedule. The correct shapes are: bound the queue and block the producer (which propagates backpressure), bound it and shed the excess (which protects latency at the cost of some requests), or coalesce updates so the queue holds state rather than events. Which one is right depends on whether the caller can usefully wait.",
          ],
          list: [
            'Bound every channel, including internal fan-out and retry buffers',
            'Shedding beats queueing when the caller has a deadline',
            'Coalescing suits state updates: the latest value is the only one that matters',
            'Depth alone hides the problem; age is the metric that predicts the cliff',
          ],
          tip: 'Alert on queue age (how long the oldest item has waited), not on depth. Depth 1000 is fine at high throughput and catastrophic at low throughput.',
        },
        {
          h: 'Shedding with send_timeout and try_send',
          p: [
            "Tokio gives you the primitives directly. channel(capacity) bounds the queue; send awaits when full, try_send returns Full immediately, and send_timeout waits up to a budget before giving up. The budget should come from the request deadline, not from a constant: a request with 40 ms left should not wait 500 ms for a queue slot it will never use.",
            "When the queue is full, return a fast, honest error: 503 with Retry-After, or a domain-specific overload response. The worst outcome is accepting work, queueing it past its deadline, doing it anyway, and returning a timeout - the caller retries, the work is duplicated, and the queue grows faster.",
          ],
          code: `use std::time::{Duration, Instant};
use tokio::sync::mpsc;

#[derive(Debug, PartialEq, Eq)]
pub enum Shed {
    /// Queue is full; the caller should retry later with backoff.
    QueueFull { waited: Duration },
    /// Consumer is gone; this is a deployment or crash, not load.
    Closed,
}

pub async fn submit(
    tx: &mpsc::Sender<Job>,
    job: Job,
    deadline: Instant,
) -> Result<(), Shed> {
    let budget = deadline.saturating_duration_since(Instant::now());
    let started = Instant::now();

    match tx.send_timeout(job, budget).await {
        Ok(()) => Ok(()),
        Err(mpsc::error::SendTimeoutError::Timeout(_)) => {
            Err(Shed::QueueFull { waited: started.elapsed() })
        }
        Err(mpsc::error::SendTimeoutError::Closed(_)) => Err(Shed::Closed),
    }
}

/// Non-blocking variant for request paths that must never wait.
pub fn try_submit(tx: &mpsc::Sender<Job>, job: Job) -> Result<(), Shed> {
    match tx.try_send(job) {
        Ok(()) => Ok(()),
        Err(mpsc::error::TrySendError::Full(_)) => {
            Err(Shed::QueueFull { waited: Duration::ZERO })
        }
        Err(mpsc::error::TrySendError::Closed(_)) => Err(Shed::Closed),
    }
}`,
          tip: 'Return Retry-After proportional to current queue age, not a fixed one second. A fixed value turns a short spike into synchronized retries that make the spike worse.',
        },
        {
          h: 'Retries are load, and load multiplies',
          p: [
            "Three retries with no budget triples the request rate exactly when the system is least able to serve it. That is retry amplification, and it is why retry budgets - a cap on retries as a fraction of successful requests, enforced per client and per endpoint - matter more than backoff jitter. Jitter spreads retries; a budget bounds them.",
            "Backpressure also has to cross process boundaries. gRPC and HTTP/2 have flow control, but it operates per stream and only applies while a single connection is saturated. At the service level, the instruments are admission control at the edge, concurrency limits per dependency, and deadlines that propagate rather than reset at every hop. A downstream call with a fresh 5-second timeout inside a request that has 200 ms left is not backpressure; it is a latency amplifier.",
          ],
          list: [
            'Retry budget as a fraction of successes, enforced client-side',
            'Full jitter on delays, and honour Retry-After from the server',
            'Per-dependency concurrency limits, not one global pool',
            'Deadlines shrink at each hop; they never reset',
          ],
          tip: 'Cap in-flight requests per dependency. A limit slightly above the dependency capacity keeps latency bounded and makes overload visible immediately.',
        },
      ],
      exercise: {
        prompt: 'Implement an admission-controlled worker: a bounded channel, N workers, and a submit function that sheds with a deadline-derived budget. Track accepted, shed and peak queue depth, and test that a full queue sheds instead of blocking past the deadline.',
        starter: `use std::time::{Duration, Instant};
use tokio::sync::mpsc;

pub struct Stats {
    pub accepted: u64,
    pub shed: u64,
    pub peak_depth: usize,
}

pub async fn submit(
    tx: &mpsc::Sender<u64>,
    item: u64,
    deadline: Instant,
    stats: &mut Stats,
) -> Result<(), &'static str> {
    todo!()
}`,
        hint: 'Compute the budget from the deadline, use send_timeout, and count both outcomes. Peak depth comes from the channel capacity minus remaining capacity, sampled after a successful send.',
        solution: `use std::time::{Duration, Instant};
use tokio::sync::mpsc;

pub struct Stats {
    pub accepted: u64,
    pub shed: u64,
    pub peak_depth: usize,
}

pub async fn submit(
    tx: &mpsc::Sender<u64>,
    item: u64,
    deadline: Instant,
    stats: &mut Stats,
) -> Result<(), &'static str> {
    let budget = deadline.saturating_duration_since(Instant::now());
    if budget.is_zero() {
        stats.shed += 1;
        return Err("deadline already expired");
    }

    match tx.send_timeout(item, budget).await {
        Ok(()) => {
            stats.accepted += 1;
            let depth = tx.max_capacity() - tx.capacity();
            stats.peak_depth = stats.peak_depth.max(depth);
            Ok(())
        }
        Err(_) => {
            stats.shed += 1;
            Err("queue full within deadline")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::timeout;

    #[tokio::test]
    async fn sheds_instead_of_blocking_past_the_deadline() {
        let (tx, _rx) = mpsc::channel::<u64>(1);
        let mut stats = Stats { accepted: 0, shed: 0, peak_depth: 0 };

        submit(&tx, 1, Instant::now() + Duration::from_millis(50), &mut stats)
            .await
            .unwrap();

        let result = timeout(
            Duration::from_millis(500),
            submit(&tx, 2, Instant::now() + Duration::from_millis(10), &mut stats),
        )
        .await
        .expect("submit must return, not hang");

        assert!(result.is_err());
        assert_eq!(stats.shed, 1);
        assert_eq!(stats.accepted, 1);
        assert_eq!(stats.peak_depth, 1);
    }
}`,
      },
      questions: [
        {
          q: 'What does an unbounded queue do under sustained overload?',
          options: [
            'It grows until memory is exhausted while every item ages past its usefulness',
            'It increases throughput by absorbing bursts',
            'It applies backpressure to the producer',
            'It drops the oldest items automatically',
          ],
          answer: 0,
          explain: 'Without a bound there is nothing to push back against the producer. The queue absorbs memory, latency grows without limit, and the work that eventually runs is usually already too late to matter.',
        },
        {
          q: 'Which signal best predicts an imminent latency collapse?',
          options: [
            'Queue age: how long the oldest waiting item has been there',
            'Queue depth in items',
            'The number of workers configured',
            'CPU utilisation of the producer',
          ],
          answer: 0,
          explain: 'Depth depends on throughput and item size. Age maps directly to the latency a caller experiences and crosses the deadline threshold at a predictable point.',
        },
        {
          q: 'Why are retries without a budget dangerous?',
          options: [
            'They multiply load exactly when the system is already failing',
            'They always create duplicate writes',
            'They bypass idempotency keys',
            'They increase the queue capacity',
          ],
          answer: 0,
          explain: 'Each retry is another request. During an incident, unrestricted retries add load faster than the system can recover, and synchronized retry storms turn a blip into a sustained outage.',
        },
      ],
      quickbytes: [
        'Bound every channel; unbounded is a memory leak with a schedule.',
        'Alert on queue age, not depth.',
        'Derive the wait budget from the request deadline, not a constant.',
        'Retry budget beats retry count; jitter beats fixed backoff.',
      ],
      production: [
        'Every channel and buffer has a documented capacity and a full-queue behaviour.',
        'Shedding returns 429 or 503 with Retry-After derived from queue age.',
        'Queue age, shed rate and in-flight count are alerted per dependency.',
        'Retry budgets are enforced per client and endpoint.',
        'Deadlines propagate and shrink; no hop resets the budget.',
      ],
      crates: ['tokio', 'tracing', 'thiserror'],
      github: [
        { name: 'tokio-rs/tokio', url: 'https://github.com/tokio-rs/tokio' },
        { name: 'tokio-rs/tracing', url: 'https://github.com/tokio-rs/tracing' },
      ],
      pitfall: 'Wrapping a bounded channel in an unbounded one because try_send returning Full was inconvenient. The retry buffer then grows without limit during an incident and the process is killed by the OOM killer while the dashboard still shows a healthy queue.',
      resources: [
        { title: 'Tokio mpsc: bounded channels, try_send and send_timeout', url: 'https://docs.rs/tokio/latest/tokio/sync/mpsc/index.html', kind: 'docs' },
        { title: 'Tokio select: racing a send against a deadline', url: 'https://tokio.rs/tokio/tutorial/select', kind: 'docs' },
        { title: 'Jon Gjengset: long-form Rust systems streams', url: 'https://www.youtube.com/@jonhoo', kind: 'video' },
        { title: 'tokio-rs/tokio', url: 'https://github.com/tokio-rs/tokio', kind: 'repo' },
      ],
    },
    {
      id: 'e19',
      title: 'Observability: traces that survive a partition',
      minutes: 80,
      level: 'industry',
      goal: 'Propagate trace context across RPC hops, attach the node and consensus state that explains a failure, and keep metric cardinality from turning your monitoring into the outage.',
      sections: [
        {
          h: 'Instrument the questions you will ask at 3 a.m.',
          p: [
            "In a distributed system the first question is always which node, and the second is what it believed. A trace that records only service names cannot answer either. Attach the node id, the Raft term, the commit index, the replica set and the routing decision to the span, and the trace becomes a record of each participant's view rather than a list of timings.",
            "Metrics answer a different question: is this systemic? Rate, errors and duration per endpoint, plus saturation per resource, tell you whether one node is unwell or the whole tier is. Logs answer the third: what exactly happened in that one request. The three are useful together only if they share an identifier, which is what trace context gives you.",
          ],
          list: [
            'Every span carries service, node id, and the consensus or version state it acted on',
            'Metrics: rate, errors, duration per endpoint; saturation per dependency',
            'Logs include the trace id, never the full context as free text',
            'Sampling keeps all errors and all slow traces; sampling them out is how outages become invisible',
          ],
          tip: 'Put the term and commit index in the span, not the log line. When a write is lost, the trace shows which leader answered and how stale it was.',
        },
        {
          h: 'traceparent is a small, strict format',
          p: [
            "W3C trace context is a header of the form version-trace_id-parent_id-flags, all lowercase hex. Version 00 fixes trace id at 16 bytes and parent id at 8 bytes, and the sampled flag is the low bit of the flags byte. A service must forward the header, replacing only the parent id with its own span id, and generate a new trace id when none is present.",
            "Two failure modes are common. The first is regenerating the trace id at every hop, which silently splits one request into N traces and makes the waterfall useless. The second is parsing the header with a permissive split and accepting malformed input, which lets a client inject arbitrary values into your trace store. Validate length and hex, and treat invalid headers as absent.",
          ],
          code: `#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TraceCtx {
    pub trace_id: [u8; 16],
    pub span_id: [u8; 8],
    pub sampled: bool,
}

impl TraceCtx {
    /// Strict parser for W3C traceparent version 00.
    pub fn parse(header: &str) -> Option<Self> {
        let mut parts = header.split('-');
        if parts.next()? != "00" {
            return None;
        }
        let trace_id = hex_array::<16>(parts.next()?)?;
        let span_id = hex_array::<8>(parts.next()?)?;
        let flags = u8::from_str_radix(parts.next()?, 16).ok()?;
        if parts.next().is_some() {
            return None;
        }
        Some(Self { trace_id, span_id, sampled: flags & 0x01 == 0x01 })
    }

    /// A child span keeps the trace id and swaps in a new parent id.
    pub fn child(&self, span_id: [u8; 8]) -> Self {
        Self { trace_id: self.trace_id, span_id, sampled: self.sampled }
    }

    pub fn to_header(&self) -> String {
        let flags = if self.sampled { "01" } else { "00" };
        format!("00-{}-{}-{}", hex(&self.trace_id), hex(&self.span_id), flags)
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn hex_array<const N: usize>(input: &str) -> Option<[u8; N]> {
    if input.len() != N * 2 || !input.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; N];
    for (i, chunk) in input.as_bytes().chunks(2).enumerate() {
        let text = std::str::from_utf8(chunk).ok()?;
        out[i] = u8::from_str_radix(text, 16).ok()?;
    }
    Some(out)
}`,
          tip: 'Never let the sampled flag be the only sampling decision. Tail sampling at the collector keeps every error and every trace above the latency threshold, which is what you actually need during an incident.',
        },
        {
          h: 'Cardinality, clocks and the tracing tax',
          p: [
            "A metric label with a user id, a request id or a raw URL is a cardinality bomb: each distinct value creates a time series, and the monitoring system falls over before the service does. Keep labels to bounded sets - endpoint template, status class, node, region - and push high-cardinality detail into spans and logs, where it is queried rather than indexed.",
            "Trace timestamps come from each node's clock, so cross-node start times can be skewed by milliseconds and produce waterfalls that appear to show causality backwards. Trust span durations and parent-child relationships, not absolute timestamps across hosts. And keep instrumentation cheap: a span per query row or a log line per loop iteration turns observability into the bottleneck, which is its own incident.",
          ],
          list: [
            'Bounded label sets only; no ids, no raw paths, no error strings as labels',
            'Use span duration, not cross-node timestamps, to explain latency',
            'Instrument boundaries: inbound requests, outbound calls, queue handoffs, consensus steps',
            'Sample decisions are recorded, so a missing trace is explainable',
          ],
          tip: 'Audit metric label cardinality monthly. The cheapest time to notice a 200k-series metric is before the bill and the scrape timeout.',
        },
      ],
      exercise: {
        prompt: 'Implement trace context propagation for one hop: parse an inbound traceparent, derive a child context for the outbound call, and format the header. Reject malformed headers, and keep the trace id unchanged across the hop.',
        starter: `#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TraceCtx {
    pub trace_id: [u8; 16],
    pub span_id: [u8; 8],
    pub sampled: bool,
}

impl TraceCtx {
    pub fn parse(header: &str) -> Option<Self> { todo!() }
    pub fn child(&self, span_id: [u8; 8]) -> Self { todo!() }
    pub fn to_header(&self) -> String { todo!() }
}`,
        hint: 'Split on hyphens and expect exactly four fields: version, 32 hex chars, 16 hex chars, 2 hex chars. Parse into fixed-size arrays, keep only the low bit of the flags, and format everything back as lowercase hex.',
        solution: `#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TraceCtx {
    pub trace_id: [u8; 16],
    pub span_id: [u8; 8],
    pub sampled: bool,
}

impl TraceCtx {
    pub fn parse(header: &str) -> Option<Self> {
        let mut parts = header.split('-');
        if parts.next()? != "00" {
            return None;
        }
        let trace_id = hex_array::<16>(parts.next()?)?;
        let span_id = hex_array::<8>(parts.next()?)?;
        let flags = u8::from_str_radix(parts.next()?, 16).ok()?;
        if parts.next().is_some() {
            return None;
        }
        Some(Self { trace_id, span_id, sampled: flags & 0x01 == 0x01 })
    }

    pub fn child(&self, span_id: [u8; 8]) -> Self {
        Self { trace_id: self.trace_id, span_id, sampled: self.sampled }
    }

    pub fn to_header(&self) -> String {
        let flags = if self.sampled { "01" } else { "00" };
        format!("00-{}-{}-{}", hex(&self.trace_id), hex(&self.span_id), flags)
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_array<const N: usize>(input: &str) -> Option<[u8; N]> {
    if input.len() != N * 2 || !input.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; N];
    for (i, chunk) in input.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(chunk).ok()?, 16).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_keeps_the_trace_id_and_changes_the_span() {
        let parent = TraceCtx::parse(
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        )
        .unwrap();
        let child = parent.child([0xAB; 8]);
        assert_eq!(child.trace_id, parent.trace_id);
        assert!(child.sampled);
        assert_eq!(
            child.to_header(),
            "00-4bf92f3577b34da6a3ce929d0e0e4736-abababababababab-01"
        );
    }

    #[test]
    fn rejects_malformed_headers() {
        assert!(TraceCtx::parse("00-xyz-00f067aa0ba902b7-01").is_none());
        assert!(TraceCtx::parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7").is_none());
    }
}`,
      },
      questions: [
        {
          q: 'What must a service do with an inbound traceparent header?',
          options: [
            'Keep the trace id, replace the parent id with its own span id and forward it',
            'Generate a new trace id for each hop',
            'Drop it and start a fresh trace',
            'Copy it unchanged into every outbound call',
          ],
          answer: 0,
          explain: 'The trace id identifies the whole request; the parent id identifies the current span. Replacing only the parent id links the hop into the same trace, which is what makes the waterfall connected.',
        },
        {
          q: 'Why are user ids and raw URLs bad metric labels?',
          options: [
            'Each distinct value creates a time series, exploding cardinality',
            'They are not valid UTF-8',
            'They change too slowly to be useful',
            'They cannot be aggregated by the collector',
          ],
          answer: 0,
          explain: 'Metric backends index every label combination. High-cardinality values multiply series until scrapes and storage fail; span attributes and logs are the right home for that detail.',
        },
        {
          q: 'Which trace data is reliable across machines?',
          options: [
            'Span durations and parent-child relationships',
            'Absolute span start timestamps',
            'The difference between two nodes start times',
            'The clock skew encoded in the trace',
          ],
          answer: 0,
          explain: 'Each node stamps spans with its own clock, so absolute times can disagree. Durations are measured locally and parent-child links are explicit, so they survive skew.',
        },
      ],
      quickbytes: [
        'Put node id, term and commit index in spans - not in free-text logs.',
        'Validate traceparent strictly; malformed headers are untrusted input.',
        'Keep metric labels bounded; put the rest in spans.',
        'Tail-sample to keep every error and every slow trace.',
      ],
      production: [
        'Trace context propagates through every RPC, queue and consensus handoff.',
        'Spans carry node identity and the version or term the node acted on.',
        'Metric label cardinality is budgeted and reviewed, with a per-metric limit.',
        'Sampling policy keeps errors and slow traces, and is documented.',
        'A single request can be reconstructed from trace id across logs, metrics and spans.',
      ],
      crates: ['tracing', 'opentelemetry', 'tokio', 'serde'],
      github: [
        { name: 'tokio-rs/tracing', url: 'https://github.com/tokio-rs/tracing' },
        { name: 'open-telemetry/opentelemetry-rust', url: 'https://github.com/open-telemetry/opentelemetry-rust' },
      ],
      pitfall: 'Regenerating the trace id in an async worker that picks a message off a queue. The producer and consumer traces never join, so every investigation of a delayed message starts by grepping timestamps across two systems.',
      resources: [
        { title: 'OpenTelemetry: Rust instrumentation', url: 'https://opentelemetry.io/docs/languages/rust/', kind: 'docs' },
        { title: 'tracing: spans, fields and subscribers', url: 'https://docs.rs/tracing/latest/tracing/', kind: 'docs' },
        { title: 'opentelemetry-rust: exporters and context propagation', url: 'https://github.com/open-telemetry/opentelemetry-rust', kind: 'repo' },
        { title: 'CNCF talks on distributed tracing and observability', url: 'https://www.youtube.com/@cncf', kind: 'video' },
      ],
    },
    {
      id: 'e20',
      title: 'Chaos engineering: hypotheses, seeds and linearizability',
      minutes: 100,
      level: 'industry',
      goal: 'Run fault experiments that are reproducible and cheap, assert safety invariants rather than vibes, and shrink a failing schedule to the smallest one that still breaks the system.',
      sections: [
        {
          h: 'An experiment has a hypothesis and an abort',
          p: [
            "A chaos experiment is not random killing. It starts with a steady-state hypothesis - a measurable statement about normal behaviour, such as a write succeeds within 200 ms at p99 and no acknowledged write is ever lost - and a fault that should not violate it. If the hypothesis fails, the experiment found something; if the system never noticed, the fault was too weak to be informative.",
            "Two guardrails make this survivable. Blast radius: start with one instance, one shard, or one simulated cluster, and only widen after the experiment passes repeatedly. Abort condition: a defined threshold - error rate, replication lag, queue age - that ends the experiment automatically. Without an abort, chaos engineering is an outage with a project name.",
          ],
          list: [
            'State the steady-state metric before injecting anything',
            'Inject one fault class at a time, with a known recovery path',
            'Bound the blast radius by instance, shard, region or simulation',
            'Define the abort threshold and who owns the rollback before starting',
          ],
          tip: 'If the experiment cannot fail, it is a demo. Write down what observation would falsify the hypothesis before you run it.',
        },
        {
          h: 'Deterministic simulation is the cheap version',
          p: [
            "turmoil simulates a network of hosts inside one process: you control latency, message ordering, partitions, crashes and restarts, and you get a seed that reproduces the exact run. Tests are fast, deterministic, and can run in CI on every commit. madsim takes the same idea further by swapping the runtime so tokio APIs, time and randomness are all under simulation control.",
            "The limitation is fidelity: simulated networks do not reproduce a real kernel's TCP behaviour, disk firmware stalls, or a hypervisor pause. That is why simulation covers the logic - election safety, commit rules, retry storms - while staging and production experiments cover the environment. Use both, and do not pretend one substitutes for the other.",
          ],
          code: `use std::time::Duration;
use turmoil::Builder;

/// run_node is the node entry point: it returns turmoil::Result, so a panic
/// or an error fails the test with the seed attached.
#[test]
fn survives_losing_the_leader() {
    let mut sim = Builder::new()
        .rng_seed(0xC0FFEE)
        .min_message_latency(Duration::from_millis(1))
        .max_message_latency(Duration::from_millis(15))
        .build();

    sim.host("n1", || async { run_node(1).await });
    sim.host("n2", || async { run_node(2).await });
    sim.host("n3", || async { run_node(3).await });

    sim.client("probe", async {
        // Steady state: a write is acknowledged and readable.
        put("k", "v1").await?;
        assert_eq!(get("k").await?, Some("v1".to_string()));
        Ok(())
    });

    // Let the cluster elect and replicate.
    for _ in 0..50 {
        sim.step().unwrap();
    }

    // Isolate the current leader from both followers.
    sim.partition("n1", "n2");
    sim.partition("n1", "n3");

    // The majority must elect a new leader and keep serving.
    sim.run().unwrap();
}`,
          tip: 'Commit the seed in the test source. A failing scenario that cannot be replayed is an anecdote, not a test.',
        },
        {
          h: 'Check the history, not the log lines',
          p: [
            "Safety bugs hide in interleavings that no assertion inside the node can see. Record the client-visible history - operation, arguments, result, invocation and response time - and check it offline for linearizability. A bounded search is enough for regression-sized histories, and it catches the class of bug where every node logs success and the client still observed a value that was never written.",
            "When a check fails, shrink. proptest can minimise a failing schedule by removing faults, shortening delays or reducing the operation list while the failure persists. The result is a minimal interleaving you can read, turn into a deterministic test, and fix - which is the difference between a flaky CI failure and a repaired protocol.",
          ],
          list: [
            'Record client operations with timestamps, not just server logs',
            'Assert safety invariants: one leader per term, no committed entry lost, no phantom read',
            'Assert liveness with a bound: a leader within N ticks, a write within M seconds',
            'Shrink failing schedules and pin the minimal case as a regression test',
          ],
          tip: 'A test that only asserts "the cluster recovered" passes for a system that lost every write. Assert what must never happen, too.',
        },
      ],
      exercise: {
        prompt: 'Implement a deterministic fault schedule from a seed: given the number of steps, produce a reproducible list of faults (partition, crash, pause, heal) with no fault before a warm-up period. The same seed must always produce the same schedule.',
        starter: `#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    Partition { a: u8, b: u8 },
    Crash { node: u8 },
    Pause { node: u8, steps: u8 },
    Heal,
}

/// Deterministic schedule; identical seeds must produce identical output.
pub fn schedule(seed: u64, steps: u32, nodes: u8) -> Vec<(u32, Fault)> {
    todo!()
}`,
        hint: 'Use a small linear congruential generator seeded from the input, skip the warm-up steps, and derive the node ids and fault kind from successive draws. Keep the generator local so results do not depend on std hashing.',
        solution: `#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    Partition { a: u8, b: u8 },
    Crash { node: u8 },
    Pause { node: u8, steps: u8 },
    Heal,
}

struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
}

pub fn schedule(seed: u64, steps: u32, nodes: u8) -> Vec<(u32, Fault)> {
    let warmup = (steps / 4).max(1);
    let mut rng = Lcg(seed ^ 0x9E37_79B9_7F4A_7C15);
    let mut out = Vec::new();
    let mut step = warmup;

    while step < steps {
        let a = (rng.next() % nodes as u64) as u8;
        let mut b = (rng.next() % nodes as u64) as u8;
        if b == a {
            b = (b + 1) % nodes;
        }
        let fault = match rng.next() % 4 {
            0 => Fault::Partition { a, b },
            1 => Fault::Crash { node: a },
            2 => Fault::Pause { node: a, steps: 5 },
            _ => Fault::Heal,
        };
        out.push((step, fault));
        step += 10;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_same_schedule() {
        assert_eq!(schedule(42, 400, 3), schedule(42, 400, 3));
    }

    #[test]
    fn no_faults_during_warmup() {
        let warmup = (400 / 4) as u32;
        assert!(schedule(7, 400, 3).iter().all(|(step, _)| *step >= warmup));
    }
}`,
      },
      questions: [
        {
          q: 'What makes a chaos experiment meaningful?',
          options: [
            'A falsifiable steady-state hypothesis and a defined abort condition',
            'Injecting as many faults as possible at once',
            'Running only in production to get real traffic',
            'Randomly killing instances on a schedule',
          ],
          answer: 0,
          explain: 'Without a hypothesis you cannot tell a finding from noise, and without an abort you cannot bound the damage. The experiment exists to falsify a claim about steady state.',
        },
        {
          q: 'What is the main limitation of deterministic simulation like turmoil?',
          options: [
            'It models logic, not real kernel, disk or hypervisor behaviour',
            'It cannot reproduce failures from a seed',
            'It only works for single-node systems',
            'It requires a production cluster',
          ],
          answer: 0,
          explain: 'Simulation is excellent for protocol logic and terrible at reproducing a firmware stall or a TCP stack quirk. Environment-level faults still need staging or production experiments.',
        },
        {
          q: 'Why check client histories for linearizability instead of node logs?',
          options: [
            'Some safety bugs are invisible to every node but visible in the client-visible order',
            'Logs are not durable in simulations',
            'Linearizability checks are faster than assertions',
            'Node logs cannot record commit indexes',
          ],
          answer: 0,
          explain: 'Each node can behave as its own code intends and the global order can still be wrong. The history is the only place where that discrepancy is observable.',
        },
      ],
      quickbytes: [
        'Write the hypothesis and the abort threshold before injecting anything.',
        'Commit the seed so a failure is replayable in CI.',
        'Simulation for logic, staging and production for environment.',
        'Assert what must never happen, not only that recovery occurred.',
      ],
      production: [
        'Fault-injection tests run on every commit with fixed seeds and a time budget.',
        'Staging experiments have an abort switch owned by the on-call engineer.',
        'Safety invariants are asserted in code, not reviewed by eye.',
        'Failing schedules are shrunk and pinned as regression tests.',
        'Production experiments start at one instance and widen only after repeated passes.',
      ],
      crates: ['turmoil', 'proptest', 'tokio', 'tracing'],
      github: [
        { name: 'tokio-rs/turmoil', url: 'https://github.com/tokio-rs/turmoil' },
        { name: 'madsim-rs/madsim', url: 'https://github.com/madsim-rs/madsim' },
      ],
      pitfall: 'Injecting random faults without a hypothesis or an abort condition. The cluster discovers a real bug during a customer incident, the experiment is declared a success, and nobody can reproduce the failure because the seed was never recorded.',
      resources: [
        { title: 'turmoil: deterministic network simulation for async Rust', url: 'https://docs.rs/turmoil/latest/turmoil/', kind: 'docs' },
        { title: 'turmoil Sim: partition, crash, hold and release', url: 'https://docs.rs/turmoil/latest/turmoil/struct.Sim.html', kind: 'docs' },
        { title: 'tokio-rs/turmoil', url: 'https://github.com/tokio-rs/turmoil', kind: 'repo' },
        { title: 'madsim: deterministic simulation testing of distributed systems', url: 'https://github.com/madsim-rs/madsim', kind: 'repo' },
        { title: 'proptest: shrinking failing cases to a minimal input', url: 'https://docs.rs/proptest/latest/proptest/', kind: 'docs' },
      ],
    },
  ],
};
