/**
 * Networking & protocols track.
 *
 * API versions used across the lessons: hyper 1.12.x with hyper-util 0.1.21
 * (TokioIo, TokioExecutor, legacy client), http-body-util 0.1.x, h2 0.4.x,
 * rustls 0.23.x with tokio-rustls 0.26.x, quinn 0.11.x, hickory-resolver 0.26.x,
 * tokio-tungstenite 0.30.x with tungstenite 0.30.x, tower 0.5.x, tokio-util 0.7.x,
 * metrics 0.24.x, socket2 0.6.x.
 *
 * Data is JSON-compatible and consumed by the plugin build.
 */
export default {
  "key": "networking",
  "prefix": "f",
  "title": "Networking & protocols",
  "blurb": "From sockets and TCP to HTTP/2, QUIC, TLS and load balancing, with the operational details that break at scale.",
  "level": "industry",
  "project": {
    "title": "Capstone: a protocol proxy",
    "brief": "Build an HTTP proxy that terminates TLS, routes by path prefix to upstream pools, and wraps every upstream call in a deadline, a bounded retry, and a circuit breaker. It must report per-route latency and error metrics, and it must survive an upstream that hangs: no request outlives its budget, no retry outlives the caller, and no idle tunnel outlives its client.",
    "deliverables": [
      "TLS termination with rustls: SNI certificate selection, ALPN negotiation, and a handshake that fails loudly for unknown hosts",
      "Routing and upstream pools: path-prefix rules, bounded per-upstream pools, and a checkout that cannot outlive the request",
      "Timeout, retry and circuit breaking: deadline propagation, idempotency-aware retries with jitter, and an open circuit that fails fast instead of queueing",
      "Latency metrics per route: duration histograms, upstream connect time, and error counts labelled by route and status class",
      "A shutdown path that stops accepting, drains in-flight requests and CONNECT tunnels inside the grace period, then closes the pools"
    ],
    "stack": [
      "hyper",
      "hyper-util",
      "http-body-util",
      "tokio",
      "tokio-rustls",
      "rustls",
      "tower",
      "metrics"
    ]
  },
  "lessons": [
    {
      "id": "f01",
      "n": 1,
      "title": "Layers on paper, packets on the wire",
      "minutes": 55,
      "level": "core",
      "goal": "Trace one response from handler to wire, compute the per-packet header budget, and use the layer model to pick the right diagnostic tool instead of guessing.",
      "sections": [
        {
          "h": "What actually leaves the process",
          "p": [
            "Your handler writes 1,200 bytes; the kernel sends packets. Each one gains a TCP header of 20 bytes, an IPv4 header of 20, and 14 bytes of Ethernet framing before it reaches the wire, and the peer strips them in reverse. Nothing on that path consults a seven-layer diagram. The model is a vocabulary for arguing about where a fault lives, and for deciding whether `curl`, `ss`, `tcpdump`, or `openssl` is the tool that can see it.",
            "The vocabulary pays off at boundaries. A DNS failure is not an HTTP failure, even when the browser shows a single error page. A TCP reset is not a TLS alert. A 502 is not a timeout, and a timeout is not a refused connection. Naming the layer narrows the search before you open a dashboard, and it stops you from rewriting a retry policy when the real problem is a certificate that expired last night."
          ],
          "list": [
            "Application: HTTP, gRPC, DNS messages; the only layer your code writes",
            "Transport: TCP or UDP ports, sequence numbers, retransmission, flow control",
            "Internet: IP addresses, routing, fragmentation, path MTU",
            "Link: Ethernet, ARP, VLAN tags, and whatever encapsulation the cloud added"
          ],
          "tip": "When an error message names a library rather than a protocol, you are still inside the application layer; walk outward until the symptom fits."
        },
        {
          "h": "MTU, MSS, and the 1,500-byte budget",
          "p": [
            "Ethernet carries 1,500 bytes by default. Subtract 20 bytes of IP and 20 of TCP and the peer advertises an MSS of 1,460: the largest payload one segment can hold. TLS 1.3 adds a 5-byte record header and a 16-byte AEAD tag, so a full segment carries about 1,439 bytes of application data. Every byte beyond that is another packet, another set of headers, and another chance to be dropped somewhere you cannot see.",
            "Path MTU discovery depends on ICMP fragmentation-needed messages coming back. A firewall that drops all ICMP turns the path into a black hole: a 2 KB GET succeeds, a 200 KB POST hangs after the handshake, and nothing in the application logs. Jumbo frames make it worse, because a 9,000-byte MTU on one link and 1,500 everywhere else only fails through the hop that disagrees."
          ],
          "list": [
            "Interface MTU: `ip link show`; jumbo is 9,000 and requires every hop to agree",
            "Path test: `ping -M do -s 1472 host` (1,472 + 28 = 1,500) succeeds only if the path carries full segments",
            "Tunnels and VPNs: clamp MSS at the edge with `iptables -t mangle --clamp-mss-to-pmtu`",
            "Never block ICMP type 3 code 4; you disable path MTU discovery with it"
          ],
          "tip": "If small responses succeed and large ones stall at exactly the same elapsed time, test the MTU before you read the application code."
        },
        {
          "h": "Where TLS and QUIC break the cake",
          "p": [
            "Textbooks put TLS between transport and application. In Rust it is a library inside your process: `rustls` runs in user space and the kernel only sees TCP. QUIC goes further and implements reliability, congestion control, and encryption over UDP, so an on-path device sees UDP/443 and an encrypted payload. Header protection hides even packet numbers, which is why middleboxes cannot help and load balancers must route on connection IDs.",
            "That is a trade, not an accident: encrypted transport removes ossification and removes your ability to inspect. Operationally a QUIC balancer hashes a connection ID rather than a five-tuple, a packet capture shows nothing without keys, and per-flow fairness is enforced by the endpoint rather than the network. Ask which layer owns the failure, then use a tool that can see that layer."
          ],
          "code": [
            "# 1. What the interface can carry",
            "ip link show dev eth0 | head -2",
            "",
            "# 2. Does the path carry full-size segments? (1,472 + 8 ICMP + 20 IP = 1,500)",
            "ping -M do -s 1472 -c 2 api.example.com",
            "ping -M do -s 1200 -c 2 api.example.com     # control: same path, smaller payload",
            "",
            "# 3. What the kernel actually negotiated",
            "ss -tin dst 10.0.0.5 | grep -E 'mss|rtt|cwnd'",
            "",
            "# 4. See the headers, and the retransmissions that follow a black hole",
            "tcpdump -ni eth0 -c 20 -vv 'host 10.0.0.5 and tcp port 443'",
            "",
            "# 5. A request large enough to cross the MTU boundary",
            "curl -sS -o /dev/null -w 'size=%{size_download} time=%{time_total}\\n' --data-binary @2mb.bin https://api.example.com/upload"
          ].join("\n"),
          "tip": "A capture that shows the same 1,460-byte segment leaving repeatedly with no ACK is an MTU black hole, not a slow server."
        }
      ],
      "exercise": {
        "prompt": "One VPC subnet gets 200 for 2 KB responses and a hang for 200 KB responses; another subnet is fine. Write the command sequence that proves or disproves an MTU black hole, and say what each command's output looks like in each case.",
        "starter": "#!/usr/bin/env bash\nset -euo pipefail\n\nHOST=\"$1\"\n\n# 1. find the interface MTU\n# 2. probe the path with DF set at 1,472 and at 1,200\n# 3. capture retransmissions of one full-size segment\n# 4. compare a small request with a large one\n",
        "hint": "Black hole: the 1,472-byte probe fails, the 1,200-byte probe succeeds, and tcpdump shows one 1,460-byte segment retransmitted with no ACK. A healthy path passes both probes and the large upload completes.",
        "solution": "#!/usr/bin/env bash\nset -euo pipefail\n\nHOST=\"$1\"\nif [ -z \"$HOST\" ]; then\n  echo \"usage: diagnose.sh host\" >&2\n  exit 2\nfi\n\nip link show dev eth0 | head -2                     # 1,500 or 9,000?\nping -M do -s 1472 -c 2 \"$HOST\" || echo 'full-size probe failed'\nping -M do -s 1200 -c 2 \"$HOST\"                     # control probe\n\nsudo tcpdump -ni any -c 40 -vv \"host $HOST and tcp port 443\" &\nsleep 1\n\ncurl -sS -o /dev/null -w 'small: %{http_code} %{time_total}s\\n' \"https://$HOST/health\"\ncurl -sS -o /dev/null -w 'large: %{http_code} %{time_total}s\\n' --data-binary @2mb.bin \"https://$HOST/upload\"\nwait\n\n# Black hole: 1,472 fails, 1,200 passes, and the capture repeats the\n# full-size segment while the large upload hangs until the client gives up.\n# Healthy: both probes pass and the upload completes in one or two RTTs."
      },
      "questions": [
        {
          "q": "On a 1,500-byte Ethernet MTU carrying IPv4 and TCP with no options, what MSS does the receiver advertise?",
          "options": ["1460 bytes", "1500 bytes", "1440 bytes", "1480 bytes"],
          "answer": 0,
          "explain": "1,500 minus 20 bytes of IPv4 header and 20 of TCP header. TLS overhead lives inside that 1,460-byte payload, so it does not change the MSS."
        },
        {
          "q": "A 2 KB response works but a 200 KB upload hangs after the TLS handshake in one subnet. What is the most likely cause?",
          "options": [
            "An MTU black hole where ICMP fragmentation-needed is filtered",
            "An expired TLS certificate",
            "A DNS TTL that is too short",
            "HTTP/1.1 pipelining enabled by a proxy"
          ],
          "answer": 0,
          "explain": "The handshake proves TCP and TLS work. A failure that depends on message size points at the path MTU: full-size segments are dropped and the ICMP that would fix it never arrives."
        },
        {
          "q": "Which statement about QUIC is correct?",
          "options": [
            "It runs over UDP with encryption and congestion control in user space",
            "It requires kernel changes before it can be deployed",
            "It uses TCP port 443 as its transport",
            "It removes the need for congestion control"
          ],
          "answer": 0,
          "explain": "QUIC is a user-space protocol over UDP; rustls and quinn implement TLS 1.3 and congestion control inside the process, which is why middleboxes see only encrypted UDP."
        }
      ],
      "quickbytes": [
        "MSS = MTU - 40 for IPv4 plus TCP options; 1,460 on standard Ethernet",
        "A TLS 1.3 record costs 5 bytes of header and a 16-byte AEAD tag inside that MSS",
        "`ss -tin` prints the negotiated MSS, cwnd and RTT for a live connection",
        "Filtering ICMP type 3 code 4 is an MTU black hole, not a security win"
      ],
      "production": [
        "Record the real path MTU for every network you deploy into, including VPN and overlay links, and clamp MSS at tunnel edges.",
        "Allow ICMP fragmentation-needed through every security group and audit the rule quarterly.",
        "Alert on retransmission rate and on failures that correlate with response size.",
        "Plot bytes per request alongside request count so size-dependent regressions are visible."
      ],
      "crates": ["socket2", "tokio", "tracing"],
      "github": [
        { "name": "tokio", "url": "https://github.com/tokio-rs/tokio" },
        { "name": "socket2", "url": "https://github.com/rust-lang/socket2" }
      ],
      "pitfall": "Jumbo frames enabled on one link: everything works inside the rack and fails through the load balancer, because one hop still fragments at 1,500 and the ICMP that would tell you is filtered.",
      "resources": [
        { "title": "tokio::net: TCP and UDP primitives", "url": "https://docs.rs/tokio/latest/tokio/net/", "kind": "docs" },
        { "title": "socket2: socket options, keepalive and buffer sizes", "url": "https://docs.rs/socket2/latest/socket2/", "kind": "docs" },
        { "title": "A performance perspective on TCP+TLS+HTTP/2 vs QUIC", "url": "https://arxiv.org/abs/1906.07415", "kind": "paper" },
        { "title": "tokio repository", "url": "https://github.com/tokio-rs/tokio", "kind": "repo" }
      ]
    },
    {
      "id": "f02",
      "n": 2,
      "title": "TCP: handshakes, windows, and the 40 ms stall",
      "minutes": 75,
      "level": "core",
      "goal": "Explain what a connection costs before the first byte, how flow and congestion control differ, and why Nagle plus delayed ACK adds 40 ms to small writes.",
      "sections": [
        {
          "h": "One round trip before any data",
          "p": [
            "A TCP connection starts with SYN, SYN-ACK, ACK: one full round trip before your request bytes can move, so on a 40 ms path that is 40 ms of pure latency. The client's initial congestion window is about ten segments, so a fresh connection cannot have more than roughly 14 KB in flight. A warm pooled connection has already paid both the handshake and the first slow-start ramp.",
            "TLS adds another round trip for a full handshake; TLS 1.3 resumption can take it to zero, and QUIC folds transport and crypto into one exchange. That is why connection reuse is the highest-leverage latency optimisation in most services, and why opening a new connection per request is expensive even when the server is idle and the network is clean."
          ],
          "tip": "Measure connect time separately from request time. A p50 that hides a 3 ms handshake still pays it on every request you do not reuse."
        },
        {
          "h": "Flow control is not congestion control",
          "p": [
            "The receive window is the receiver saying how much buffer it has; it protects the receiver and is advertised in every ACK. The congestion window is the sender's estimate of what the network can absorb; it protects the network and doubles during slow start until loss or a model says stop. Linux defaults to CUBIC, which treats loss as congestion; BBR models bandwidth and round-trip time instead and is far less loss-sensitive.",
            "Both windows bound in-flight bytes, and the effective limit is the smaller one. A receiver with a tiny socket buffer throttles a fast path; a sender with a collapsed window after loss underuses it. When throughput sits far below link speed, `ss -ti` says which limit you are hitting, `rwnd_limited` or `cwnd_limited`, plus the retransmit counters that explain the rest."
          ],
          "list": [
            "Flow control: receiver buffer, per connection, updated by every ACK",
            "Congestion control: sender estimate, per path, halved on loss under CUBIC",
            "Slow start: cwnd doubles per RTT until the first loss or the ssthresh estimate",
            "Bufferbloat: a deep queue inflates RTT without improving throughput"
          ]
        },
        {
          "h": "Nagle, delayed ACK, and the 40 ms trap",
          "p": [
            "Nagle's algorithm holds a small segment while earlier data is unacknowledged, waiting to coalesce. Delayed ACK waits up to about 40 ms before acknowledging, hoping to piggyback on a response. Put them together with a handler that writes headers and body in two calls and you get a stall: the second write waits for an ACK, and the ACK waits for traffic the write is holding back.",
            "The fix is both halves at once: disable Nagle on request/response sockets with TCP_NODELAY, and write the response in a single buffer so there is nothing to coalesce. `write_vectored` helps when the pieces are already separate, but not every TLS backend implements it efficiently. Setting TCP_NODELAY and still doing two small writes moves the problem into the kernel instead of solving it."
          ],
          "code": [
            "use socket2::{SockRef, TcpKeepalive};",
            "use std::time::Duration;",
            "use tokio::net::TcpStream;",
            "",
            "pub async fn connect(addr: std::net::SocketAddr) -> std::io::Result<TcpStream> {",
            "    // A SYN that never answers must not pin the task for the kernel default.",
            "    let stream = tokio::time::timeout(Duration::from_millis(800), TcpStream::connect(addr))",
            "        .await",
            "        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, \"connect timed out\"))??;",
            "",
            "    stream.set_nodelay(true)?; // request/response traffic: coalescing only hurts",
            "",
            "    let sock = SockRef::from(&stream);",
            "    sock.set_tcp_keepalive(",
            "        &TcpKeepalive::new()",
            "            .with_time(Duration::from_secs(60))",
            "            .with_interval(Duration::from_secs(15)),",
            "    )?;",
            "",
            "    Ok(stream)",
            "}"
          ].join("\n"),
          "tip": "Linux keeps TCP keepalive idle at 7,200 s by default, so a dead peer behind a NAT can look healthy for two hours unless you set it yourself."
        },
        {
          "h": "TIME_WAIT and ephemeral ports",
          "p": [
            "The side that closes first enters TIME_WAIT for two maximum segment lifetimes, 60 seconds on Linux, so a duplicate segment from a lost connection cannot be mistaken for a new one. That is correct behaviour and it costs a port. A service that opens thousands of short-lived outbound connections burns the ephemeral range, about 28,000 ports by default, and starts failing with EADDRNOTAVAIL.",
            "Reuse is the answer, not tuning. Keep connections alive in a pool, cap concurrency, and treat connection creation as the expensive path it is. `SO_REUSEADDR` only lets you bind while old sockets sit in TIME_WAIT; it does not create ports. `net.ipv4.tcp_tw_reuse` helps client-side reuse in some cases, and `ss -s` tells you whether you have a port problem at all."
          ],
          "tip": "`ss -s` prints sockets in TIME_WAIT; if that number tracks your request rate, every request is paying for a connection it did not need."
        }
      ],
      "exercise": {
        "prompt": "A service makes one outbound HTTPS call per request. p99 latency is 40 ms worse than p50 on a 1 ms network, and `ss -s` shows 25,000 sockets in TIME_WAIT. Name the two costs being paid and change the connection code so it pays neither.",
        "starter": "use tokio::net::TcpStream;\n\npub async fn call(addr: std::net::SocketAddr) -> std::io::Result<()> {\n    // one fresh connection per request\n    let stream = TcpStream::connect(addr).await?;\n    stream.set_nodelay(true)?;\n    // ... write request, read response\n    Ok(())\n}",
        "hint": "Costs: a handshake plus a slow-start ramp on every request, and an ephemeral port held in TIME_WAIT afterwards. Fix: a bounded pool of long-lived connections, TCP_NODELAY, and a connect timeout so a black-holed peer cannot pin the task.",
        "solution": "use socket2::{SockRef, TcpKeepalive};\nuse std::time::Duration;\nuse tokio::net::TcpStream;\n\npub async fn call(addr: std::net::SocketAddr) -> std::io::Result<()> {\n    let stream = tokio::time::timeout(Duration::from_millis(800), TcpStream::connect(addr))\n        .await\n        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, \"connect timed out\"))??;\n    stream.set_nodelay(true)?;\n\n    let sock = SockRef::from(&stream);\n    sock.set_tcp_keepalive(&TcpKeepalive::new().with_time(Duration::from_secs(60)))?;\n\n    // ... write the request, read the response ...\n    Ok(())\n}\n\n// The real fix sits upstream of this function: a bounded per-host pool of\n// these streams, checked out per request, with a maximum connection age below\n// the DNS TTL. Ports stay in ESTABLISHED instead of cycling through TIME_WAIT,\n// and the handshake plus the slow-start ramp is amortised across requests."
      },
      "questions": [
        {
          "q": "How many round trips does a TCP handshake add before the first application byte can be sent?",
          "options": ["One", "Zero", "Two", "Three"],
          "answer": 0,
          "explain": "SYN, SYN-ACK, ACK is one full round trip. The client may send data with the final ACK, but it still waited one RTT."
        },
        {
          "q": "Which pair of settings most often produces a 40 ms stall on a small request/response exchange?",
          "options": [
            "Nagle enabled on the sender and delayed ACK on the peer",
            "TCP_NODELAY plus a single write",
            "A large receive window plus CUBIC",
            "SO_REUSEADDR plus an idle pool"
          ],
          "answer": 0,
          "explain": "Nagle holds a small second write until the first is acknowledged, and delayed ACK waits up to about 40 ms before acknowledging. Each waits for the other."
        },
        {
          "q": "A service opens 30,000 short-lived outbound connections per minute. What fails first?",
          "options": [
            "Ephemeral ports are exhausted and connect fails with EADDRNOTAVAIL",
            "The TLS root store is invalidated",
            "DNS negative caching expires",
            "The congestion window grows without bound"
          ],
          "answer": 0,
          "explain": "Each closed connection holds a port in TIME_WAIT for 60 s, so the ~28,000-port ephemeral range runs out long before CPU or bandwidth do."
        }
      ],
      "quickbytes": [
        "`ss -ti` prints cwnd, rtt, retransmits, and whether you are rwnd- or cwnd-limited",
        "Connection setup costs one RTT plus a slow-start ramp; reuse beats tuning",
        "Set TCP_NODELAY on request/response sockets and send the response in one write",
        "TIME_WAIT lasts 2*MSL, 60 s on Linux, and holds a port for the side that closed first"
      ],
      "production": [
        "Every outbound client has a connect timeout, a read timeout, and a total deadline.",
        "Connection pools are bounded per host, and pool size is a capacity decision with a metric attached.",
        "TCP keepalive is configured explicitly; the Linux default idle of 7,200 s hides dead peers for two hours.",
        "Alert on sockets in TIME_WAIT and on retransmit rate per host, not just on error rate."
      ],
      "crates": ["tokio", "socket2", "tracing"],
      "github": [
        { "name": "tokio", "url": "https://github.com/tokio-rs/tokio" },
        { "name": "socket2", "url": "https://github.com/rust-lang/socket2" }
      ],
      "pitfall": "Setting a generous connect timeout but no read timeout: a peer that completes the handshake and then stops sending holds the task, the pool slot, and the caller's budget until something else times out.",
      "resources": [
        { "title": "tokio TcpStream: connect, nodelay, keepalive", "url": "https://docs.rs/tokio/latest/tokio/net/struct.TcpStream.html", "kind": "docs" },
        { "title": "Linux IP sysctl reference (keepalive, tcp_tw_reuse)", "url": "https://docs.kernel.org/networking/ip-sysctl.html", "kind": "docs" },
        { "title": "socket2 repository", "url": "https://github.com/rust-lang/socket2", "kind": "repo" },
        { "title": "Jon Gjengset: Rust systems streams on protocols and async internals", "url": "https://www.youtube.com/@jonhoo", "kind": "video" }
      ]
    },
    {
      "id": "f03",
      "n": 3,
      "title": "UDP: datagrams you must frame yourself",
      "minutes": 60,
      "level": "core",
      "goal": "Use UDP correctly: connect the socket, size the receive buffer, respect the MTU, and know which guarantees you now have to rebuild in user space.",
      "sections": [
        {
          "h": "A datagram is a boundary, not a stream",
          "p": [
            "A UDP send is one datagram: it either arrives whole or not at all, and it can arrive twice, out of order, or after the application has moved on. `recv_from` returns the length of exactly one datagram; if your buffer is smaller, the remainder is discarded on Linux with no error unless you ask for `MSG_TRUNC`. Size the buffer for the largest datagram you accept and treat a full buffer as a truncation signal.",
            "Calling `connect` on a UDP socket does not create a connection. It pins the peer so `send` and `recv` work, makes the kernel drop datagrams from other sources, and surfaces ICMP port-unreachable as a real error on the next call. Without it, an unreachable peer looks identical to silence, and you find out through a timeout instead of an error."
          ],
          "tip": "A UDP socket that never calls connect() silently accepts traffic from any source, including the scanner that found your port."
        },
        {
          "h": "MTU, fragmentation, and the 1,200-byte habit",
          "p": [
            "IPv4 routers may fragment a large datagram; IPv6 routers do not, and the sender must respect the path MTU. Fragmentation is bad for loss, because one lost fragment discards the whole datagram, and middleboxes routinely drop fragments. QUIC therefore caps its initial datagrams at 1,200 bytes and discovers the path MTU upward from there, so it never depends on IP fragmentation.",
            "For your own protocol, pick a payload budget, document it, and reject larger messages in the encoder rather than letting the kernel fragment. If you must send more than one datagram's worth, define sequence numbers and reassembly yourself, including what happens when the middle piece never arrives. That is precisely the work TCP already did for you, and it is harder than it looks."
          ]
        },
        {
          "h": "What you give up, and what you rebuild",
          "p": [
            "UDP gives you no retransmission, no ordering, no congestion control, and no flow control. That is not a bug; it is the point. A game sends the newest position and drops stale ones, a resolver retries a different server, and a metrics agent accepts loss. The moment your protocol needs every byte, you are reimplementing TCP badly unless you put QUIC underneath it.",
            "Unpaced UDP is also dangerous: the kernel will happily send at line rate, and a lossy path turns that into a retransmission-free flood that starves every TCP flow sharing the bottleneck. If you write your own protocol, add pacing and a congestion signal from the first commit, or hand the transport to QUIC and stop maintaining one."
          ],
          "list": [
            "Retransmission and duplicate suppression: at-least-once delivery means the receiver dedupes",
            "Ordering: add a sequence number and a reassembly window, or design for unordered delivery",
            "Congestion control: an unpaced sender at line rate is a denial-of-service on its own network",
            "Flow control: a slow receiver needs a credit scheme, or the socket buffer drops silently",
            "Path MTU discovery and ECN: both must be implemented, not inherited from the kernel"
          ],
          "code": [
            "use std::net::SocketAddr;",
            "use tokio::net::UdpSocket;",
            "",
            "const MAX_DATAGRAM: usize = 1_200; // stays under the IPv6 minimum MTU",
            "",
            "pub async fn run(bind: SocketAddr, peer: SocketAddr) -> std::io::Result<()> {",
            "    let socket = UdpSocket::bind(bind).await?;",
            "    // connect() filters other peers and turns ICMP port-unreachable into an error.",
            "    socket.connect(peer).await?;",
            "",
            "    let mut buf = vec![0u8; MAX_DATAGRAM + 1]; // one spare byte detects truncation",
            "    loop {",
            "        let n = socket.recv(&mut buf).await?;",
            "        if n > MAX_DATAGRAM {",
            "            tracing::warn!(%peer, len = n, \"oversized datagram dropped\");",
            "            continue;",
            "        }",
            "        if let Err(err) = handle(&buf[..n]).await {",
            "            tracing::warn!(%err, \"datagram rejected\");",
            "        }",
            "    }",
            "}",
            "",
            "async fn handle(_payload: &[u8]) -> Result<(), std::io::Error> {",
            "    Ok(())",
            "}"
          ].join("\n"),
          "tip": "A recv that returns exactly buffer.len() is not a success; on Linux it is how truncation looks."
        }
      ],
      "exercise": {
        "prompt": "Write a UDP receiver that accepts datagrams up to 1,200 bytes, logs and drops anything larger, and reports the peer it came from. Then explain what connect() changes about error reporting.",
        "starter": "use tokio::net::UdpSocket;\n\npub async fn run(bind: std::net::SocketAddr) -> std::io::Result<()> {\n    let socket = UdpSocket::bind(bind).await?;\n    let mut buf = [0u8; 2048];\n    loop {\n        // recv_from, size check, log the peer\n    }\n}",
        "hint": "Use recv_from and compare n with the limit. After connect(peer), the kernel filters other sources and returns the pending ECONNREFUSED on the next send or recv, so an unreachable peer fails loudly instead of looking like silence.",
        "solution": "use std::net::SocketAddr;\nuse tokio::net::UdpSocket;\n\nconst MAX: usize = 1_200;\n\npub async fn run(bind: SocketAddr) -> std::io::Result<()> {\n    let socket = UdpSocket::bind(bind).await?;\n    let mut buf = vec![0u8; MAX + 1];\n\n    loop {\n        let (n, peer) = socket.recv_from(&mut buf).await?;\n        if n > MAX {\n            // n == buf.len() means the datagram did not fit; the rest is gone.\n            tracing::warn!(%peer, len = n, \"oversized datagram dropped\");\n            continue;\n        }\n        tracing::debug!(%peer, len = n, \"datagram\");\n        handle(peer, &buf[..n]).await;\n    }\n}\n\nasync fn handle(_peer: SocketAddr, _payload: &[u8]) {}\n\n// recv_from reports the sender but cannot surface ICMP errors. After connect(peer)\n// the kernel filters other sources and the next send/recv returns the pending\n// ECONNREFUSED from an ICMP port-unreachable, so an unreachable peer fails loudly\n// instead of looking like silence."
      },
      "questions": [
        {
          "q": "On Linux, what happens when a datagram is larger than the buffer passed to recv?",
          "options": [
            "The remainder is discarded and recv returns the buffer length",
            "The datagram is queued until the next recv",
            "recv returns EMSGSIZE",
            "The kernel fragments the datagram into the buffer"
          ],
          "answer": 0,
          "explain": "UDP preserves the boundary, not the loss. Extra bytes are dropped silently unless you pass MSG_TRUNC to learn the real size."
        },
        {
          "q": "What does connect() actually do on a UDP socket?",
          "options": [
            "Pins the peer, filters other senders, and surfaces ICMP errors",
            "Performs a three-way handshake",
            "Guarantees ordering and retransmission",
            "Reserves a congestion window for the flow"
          ],
          "answer": 0,
          "explain": "There is no handshake. connect only stores the peer address, which filters incoming datagrams and makes ICMP port-unreachable visible on the next call."
        },
        {
          "q": "Why does QUIC cap its initial datagrams at 1,200 bytes?",
          "options": [
            "To stay below the IPv6 minimum MTU and avoid IP fragmentation",
            "Because a UDP header is 1,200 bytes",
            "To match the classic TCP MSS",
            "Because TLS records cannot exceed 1,200 bytes"
          ],
          "answer": 0,
          "explain": "1,280 is the IPv6 minimum MTU; minus 40 bytes of IPv6 and UDP headers and some room to grow, 1,200 is the safe size that no path should fragment."
        }
      ],
      "quickbytes": [
        "A UDP recv returns exactly one datagram: the boundary is preserved, the delivery is not",
        "Size the receive buffer for the largest datagram you accept and treat a full buffer as truncation",
        "QUIC's 1,200-byte initial limit avoids IP fragmentation on the IPv6 minimum MTU",
        "Unpaced UDP at line rate starves every TCP flow sharing the bottleneck"
      ],
      "production": [
        "Document the maximum datagram size your protocol accepts and reject larger messages in the encoder.",
        "Set the socket receive buffer deliberately and monitor drops; the kernel never tells the sender.",
        "Call connect() on client sockets so ICMP errors surface as errors instead of timeouts.",
        "If you need reliability over UDP, use QUIC instead of rebuilding a transport from scratch."
      ],
      "crates": ["tokio", "quinn", "tracing"],
      "github": [
        { "name": "tokio", "url": "https://github.com/tokio-rs/tokio" },
        { "name": "quinn", "url": "https://github.com/quinn-rs/quinn" }
      ],
      "pitfall": "A generous receive buffer and a sender at line rate: the kernel drops datagrams when the socket buffer fills, the sender never learns, and the application sees unexplained message loss that looks like a network fault.",
      "resources": [
        { "title": "tokio UdpSocket: recv_from, send_to, connect", "url": "https://docs.rs/tokio/latest/tokio/net/struct.UdpSocket.html", "kind": "docs" },
        { "title": "quinn: QUIC transport built on UDP datagrams", "url": "https://docs.rs/quinn/latest/quinn/", "kind": "docs" },
        { "title": "QUIC Steps: evaluating pacing strategies in QUIC implementations", "url": "https://arxiv.org/abs/2505.09222", "kind": "paper" },
        { "title": "tokio repository", "url": "https://github.com/tokio-rs/tokio", "kind": "repo" }
      ]
    },
    {
      "id": "f04",
      "n": 4,
      "title": "Accept loops that survive bad days",
      "minutes": 70,
      "level": "core",
      "goal": "Write a listener that bounds concurrency, handles accept errors without exiting, tracks connection tasks, and drains them on shutdown.",
      "sections": [
        {
          "h": "The loop is not the hard part",
          "p": [
            "An accept loop is five lines; the operational version is fifty. `accept` can fail with EMFILE when the process hits its descriptor limit, with ECONNABORTED when a client vanishes mid-handshake, and with EINTR. A loop that propagates every error exits on the first hiccup; a loop that ignores every error spins at full CPU. Distinguish transient from fatal, log with the peer address, and keep going.",
            "Bound the work before you accept it. Acquiring a semaphore permit before `accept` means the kernel backlog absorbs bursts instead of your heap, and it caps memory per connection at a number you chose. Accepting everything and hoping the runtime schedules fairly is how a process with plenty of RAM dies at thirty thousand idle connections."
          ],
          "tip": "If EMFILE appears under load, find the descriptor leak before you raise the limit; raising it moves the cliff, it does not remove it."
        },
        {
          "h": "Spawn, track, and drain",
          "p": [
            "Every accepted socket becomes a task. A `JoinSet` gives you a handle per task, surfaces panics instead of swallowing them, and lets you await the whole set during shutdown. Call `try_join_next` inside the loop so finished tasks are reaped, stop accepting when the shutdown token fires, then wait for in-flight requests to finish inside the grace period.",
            "Graceful shutdown has an order. Stop accepting, cancel idle work, let active requests finish, then close. Dropping the listener closes the socket, but connections already accepted keep running; that is why the drain must be explicit. Sending `Connection: close` or an HTTP/2 GOAWAY before the drain lets clients move on instead of retrying into a dying process."
          ]
        },
        {
          "h": "Socket options that matter at listen time",
          "p": [
            "`SO_REUSEPORT` lets several processes bind the same port and spreads incoming connections across them, which is how you use every core without a shared accept lock. It also means a restart can briefly double-accept, and a crashing worker loses its share of established connections, so pair it with a load balancer that retries and with a drain that is long enough to matter.",
            "The backlog is the kernel's queue of completed handshakes waiting for `accept`. If it is too small, the kernel drops SYNs and clients see retries and seconds of delay with no server-side error at all. Set it explicitly through socket2, watch `ss -lnt` for the `Send-Q` column, and never block the accept loop on anything slow."
          ],
          "list": [
            "SO_REUSEPORT per worker so N processes share one port and the kernel hashes flows",
            "Backlog of 1024 through socket2; the common default of 128 drops SYNs under a burst",
            "TCP_NODELAY on every accepted socket, or small responses pay Nagle",
            "SO_KEEPALIVE with 60 s idle and 15 s interval, so half-open peers are reaped"
          ],
          "code": [
            "use std::sync::Arc;",
            "use tokio::net::TcpListener;",
            "use tokio::sync::Semaphore;",
            "use tokio::task::JoinSet;",
            "",
            "pub async fn serve(listener: TcpListener, max_conns: usize) -> std::io::Result<()> {",
            "    let permits = Arc::new(Semaphore::new(max_conns));",
            "    let mut tasks = JoinSet::new();",
            "",
            "    loop {",
            "        // Acquire before accept: the backlog absorbs the burst, the heap does not.",
            "        let permit = permits.clone().acquire_owned().await.expect(\"semaphore stays open\");",
            "",
            "        let (stream, peer) = match listener.accept().await {",
            "            Ok(pair) => pair,",
            "            Err(err) if is_fatal(&err) => return Err(err),",
            "            Err(err) => {",
            "                // EMFILE and friends: log, back off a little, keep serving.",
            "                tracing::warn!(%err, \"accept failed\");",
            "                tokio::time::sleep(std::time::Duration::from_millis(20)).await;",
            "                continue;",
            "            }",
            "        };",
            "",
            "        tasks.spawn(async move {",
            "            let _permit = permit; // released when the connection task ends",
            "            if let Err(err) = handle(stream).await {",
            "                tracing::warn!(%peer, %err, \"connection ended\");",
            "            }",
            "        });",
            "",
            "        while tasks.try_join_next().is_some() {}",
            "    }",
            "}",
            "",
            "fn is_fatal(err: &std::io::Error) -> bool {",
            "    !matches!(",
            "        err.kind(),",
            "        std::io::ErrorKind::ConnectionAborted | std::io::ErrorKind::Interrupted",
            "    )",
            "}",
            "",
            "async fn handle(_stream: tokio::net::TcpStream) -> std::io::Result<()> {",
            "    Ok(())",
            "}"
          ].join("\n"),
          "tip": "Print the listen backlog with `ss -lnt` and compare Send-Q with your configured value; the kernel silently caps it at somaxconn."
        }
      ],
      "exercise": {
        "prompt": "Harden the loop: cap concurrency at 512, survive EMFILE without spinning, reap finished tasks, and stop accepting on SIGTERM while draining in-flight connections for up to 10 seconds.",
        "starter": "use std::sync::Arc;\nuse tokio::net::TcpListener;\nuse tokio::sync::Semaphore;\nuse tokio::task::JoinSet;\n\npub async fn serve(listener: TcpListener, max_conns: usize) -> std::io::Result<()> {\n    // 1. cap concurrency\n    // 2. classify accept errors\n    // 3. reap finished tasks\n    // 4. stop on shutdown and drain\n    Ok(())\n}",
        "hint": "Select between shutdown.cancelled() and a semaphore permit before accept. Break out of the loop on shutdown, drop the listener, then wrap the JoinSet drain in tokio::time::timeout.",
        "solution": "use std::sync::Arc;\nuse std::time::Duration;\nuse tokio::net::TcpListener;\nuse tokio::sync::Semaphore;\nuse tokio::task::JoinSet;\nuse tokio_util::sync::CancellationToken;\n\npub async fn serve(\n    listener: TcpListener,\n    shutdown: CancellationToken,\n    max_conns: usize,\n) -> std::io::Result<()> {\n    let permits = Arc::new(Semaphore::new(max_conns));\n    let mut tasks = JoinSet::new();\n\n    loop {\n        let permit = tokio::select! {\n            _ = shutdown.cancelled() => break,\n            permit = permits.clone().acquire_owned() => permit.expect(\"semaphore stays open\"),\n        };\n\n        let (stream, peer) = match listener.accept().await {\n            Ok(pair) => pair,\n            Err(err) if err.kind() == std::io::ErrorKind::ConnectionAborted => continue,\n            Err(err) => {\n                tracing::warn!(%err, \"accept failed\");\n                tokio::time::sleep(Duration::from_millis(20)).await;\n                continue;\n            }\n        };\n\n        tasks.spawn(async move {\n            let _permit = permit;\n            if let Err(err) = handle(stream).await {\n                tracing::warn!(%peer, %err, \"connection ended\");\n            }\n        });\n\n        while tasks.try_join_next().is_some() {}\n    }\n\n    drop(listener); // no new connections; accepted ones keep running\n    let drained = tokio::time::timeout(Duration::from_secs(10), async {\n        while tasks.join_next().await.is_some() {}\n    })\n    .await;\n\n    if drained.is_err() {\n        tasks.abort_all(); // the grace period expired; let the supervisor kill us\n    }\n    Ok(())\n}\n\nasync fn handle(_stream: tokio::net::TcpStream) -> std::io::Result<()> {\n    Ok(())\n}"
      },
      "questions": [
        {
          "q": "Why acquire the semaphore permit before accept() rather than after?",
          "options": [
            "The kernel backlog absorbs bursts instead of the process heap",
            "It makes accept() non-blocking",
            "It raises the listen backlog automatically",
            "It pins the connection to one worker thread"
          ],
          "answer": 0,
          "explain": "Permit-first applies backpressure at the cheapest queue you have, the kernel's accept queue, and keeps memory per connection bounded by a number you chose."
        },
        {
          "q": "accept() returns EMFILE. What should the loop do?",
          "options": [
            "Log it, pause briefly, and continue without spawning",
            "Exit so the supervisor restarts the process",
            "Retry immediately in a tight loop",
            "Panic to force a core dump"
          ],
          "answer": 0,
          "explain": "EMFILE means descriptors are exhausted, which is usually a leak or a missing cap. Exiting restarts into the same condition; a tight loop burns CPU while the leak persists."
        },
        {
          "q": "After dropping the TcpListener during shutdown, what happens to already-accepted connections?",
          "options": [
            "They keep running until their tasks finish or the drain deadline hits",
            "They are closed immediately",
            "The kernel resets them",
            "They are requeued in the backlog"
          ],
          "answer": 0,
          "explain": "Dropping the listener only closes the listening socket. Established connections are owned by their tasks, which is exactly why the drain has to be explicit."
        }
      ],
      "quickbytes": [
        "Acquire a permit before accept so the kernel backlog is the shock absorber",
        "EMFILE is about descriptors, not memory: find the leak before raising the limit",
        "Keep the owned permit inside the connection task; it releases on drop",
        "Drop the listener first, then drain tasks inside terminationGracePeriodSeconds"
      ],
      "production": [
        "The accept loop distinguishes transient from fatal errors and never exits on one client failure.",
        "Concurrent connections are capped by a semaphore set below the descriptor limit.",
        "Every connection task is tracked, so panics are visible and shutdown can wait for them.",
        "Raising ulimit is paired with a descriptor-leak check on idle connections."
      ],
      "crates": ["tokio", "tokio-util", "socket2"],
      "github": [
        { "name": "tokio", "url": "https://github.com/tokio-rs/tokio" },
        { "name": "socket2", "url": "https://github.com/rust-lang/socket2" }
      ],
      "pitfall": "Accepting without a concurrency bound: a slowloris client or a SYN burst grows tasks until descriptors run out, and the first symptom is EMFILE when an unrelated file is opened.",
      "resources": [
        { "title": "tokio TcpListener", "url": "https://docs.rs/tokio/latest/tokio/net/struct.TcpListener.html", "kind": "docs" },
        { "title": "tokio_util CancellationToken", "url": "https://docs.rs/tokio-util/latest/tokio_util/sync/struct.CancellationToken.html", "kind": "docs" },
        { "title": "Tokio guide: graceful shutdown", "url": "https://tokio.rs/tokio/topics/shutdown", "kind": "docs" },
        { "title": "tokio repository", "url": "https://github.com/tokio-rs/tokio", "kind": "repo" }
      ]
    },
    {
      "id": "f05",
      "n": 5,
      "title": "HTTP/1.1: framing, semantics, and smuggling",
      "minutes": 65,
      "level": "core",
      "goal": "Read HTTP/1.1 as a text protocol with two framing rules, apply method semantics to retry decisions, and spot the header combination that enables request smuggling.",
      "sections": [
        {
          "h": "One request at a time, per connection",
          "p": [
            "HTTP/1.1 is a text protocol whose messages are separated by CRLF and whose body length comes from either `Content-Length` or `Transfer-Encoding: chunked`. A connection carries one request at a time: pipelining exists in the specification but is effectively dead, because responses must return in order and a slow first response blocks everything behind it. That head-of-line limit is the problem HTTP/2 was built to remove.",
            "`Host` is mandatory in 1.1 and is what makes virtual hosting possible. A forward proxy receives the absolute form, `GET https://host/path HTTP/1.1`, while a reverse proxy receives origin-form and routes on `Host`. Getting that distinction wrong produces the classic bug where a proxy forwards the absolute URI upstream and the origin 404s on a path that begins with `https://`."
          ],
          "code": [
            "POST /v1/orders HTTP/1.1",
            "Host: api.example.com",
            "Content-Type: application/json",
            "Transfer-Encoding: chunked",
            "",
            "20",
            "{\"id\":\"7f3c\",\"total_cents\":1999}",
            "0",
            "",
            "HTTP/1.1 201 Created",
            "Location: /v1/orders/7f3c",
            "Content-Length: 0",
            "Connection: keep-alive"
          ].join("\n"),
          "tip": "The hex before each chunk is a byte count, not a length in characters; UTF-8 payloads make that difference visible."
        },
        {
          "h": "Semantics decide what is safe to retry",
          "p": [
            "Methods carry meaning, not just verbs. GET, HEAD, PUT, DELETE, and OPTIONS are idempotent: repeating them leaves the same state, so a retry after a timeout is defensible. POST is not idempotent unless you add an idempotency key, and retrying a POST that already committed is how customers get charged twice. Status codes matter too: 429 and 503 are retryable; 400 and 409 are not.",
            "Two responses never have a body, no matter what the headers claim: 204 and 304. HEAD returns the headers of the GET it mirrors and no body, which is why a proxy must not measure a HEAD by reading bytes that will never arrive. And keep-alive is the default in 1.1; the `Connection` header appears to say `close` or to list hop-by-hop tokens that must be stripped before forwarding."
          ],
          "code": [
            "use bytes::Bytes;",
            "use http_body_util::Full;",
            "use hyper::body::Incoming;",
            "use hyper::{Method, Request, Response, StatusCode};",
            "use std::convert::Infallible;",
            "",
            "async fn handle(req: Request<Incoming>) -> Result<Response<Full<Bytes>>, Infallible> {",
            "    let method = req.method();",
            "    let is_head = method == Method::HEAD;",
            "    let allowed = method == Method::GET || is_head || method == Method::PUT;",
            "",
            "    if !allowed {",
            "        return Ok(Response::builder()",
            "            .status(StatusCode::METHOD_NOT_ALLOWED)",
            "            .header(\"allow\", \"GET, HEAD, PUT\")",
            "            .body(Full::new(Bytes::new()))",
            "            .expect(\"static response builds\"));",
            "    }",
            "",
            "    // HEAD must send the headers a GET would send, and no body.",
            "    let body = if is_head { Bytes::new() } else { Bytes::from_static(b\"{\\\"ok\\\":true}\") };",
            "    let mut response = Response::new(Full::new(body));",
            "    response.headers_mut().insert(\"content-type\", \"application/json\".parse().unwrap());",
            "    Ok(response)",
            "}"
          ].join("\n"),
          "tip": "A handler that returns a body for HEAD desynchronises HTTP/1.1 clients: they read the body as the next response's status line."
        },
        {
          "h": "Request smuggling is a framing disagreement",
          "p": [
            "If a request carries both `Content-Length` and `Transfer-Encoding: chunked`, servers disagree about where it ends. One reads the length, the other reads chunks, and the leftover bytes become the start of the next request on the same connection. Front-end and back-end differ, a smuggled request slips past the first hop's access control, and the connection is now desynchronised for whoever reuses it next.",
            "The defences are boring and effective: reject ambiguous framing with 400, normalise header values, never forward a `Transfer-Encoding` you did not generate, and keep front-end and back-end on the same parser rules. Connection reuse makes the failure worse, because the poison survives on a pooled connection that the next client inherits."
          ],
          "list": [
            "Reject any message with both Content-Length and Transfer-Encoding",
            "Reject duplicate Content-Length values that disagree, and any non-numeric value",
            "Strip Transfer-Encoding and Connection tokens before forwarding",
            "Keep every hop on the same parser family and normalisation rules"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write the framing validation a proxy runs before routing: reject messages with both Content-Length and Transfer-Encoding, reject a non-numeric or conflicting Content-Length, and let chunked messages through to the parser.",
        "starter": "use hyper::header::{CONTENT_LENGTH, TRANSFER_ENCODING};\nuse hyper::HeaderMap;\n\n#[derive(Debug, PartialEq)]\npub enum FramingError {\n    BothFramingHeaders,\n    InvalidContentLength,\n    ConflictingContentLength,\n}\n\npub fn validate_framing(headers: &HeaderMap) -> Result<(), FramingError> {\n    todo!()\n}",
        "hint": "Check contains_key for both headers first. Then iterate get_all(CONTENT_LENGTH), parse each value as u64, and compare against the previous one. Return Ok for chunked-only messages.",
        "solution": "use hyper::header::{CONTENT_LENGTH, TRANSFER_ENCODING};\nuse hyper::HeaderMap;\n\n#[derive(Debug, PartialEq)]\npub enum FramingError {\n    BothFramingHeaders,\n    InvalidContentLength,\n    ConflictingContentLength,\n}\n\npub fn validate_framing(headers: &HeaderMap) -> Result<(), FramingError> {\n    let has_te = headers.contains_key(TRANSFER_ENCODING);\n    let has_cl = headers.contains_key(CONTENT_LENGTH);\n\n    if has_te && has_cl {\n        return Err(FramingError::BothFramingHeaders); // the smuggling shape\n    }\n    if has_te {\n        return Ok(()); // chunked: the chunk parser owns the end of the message\n    }\n\n    let mut expected: Option<u64> = None;\n    for value in headers.get_all(CONTENT_LENGTH) {\n        let text = value\n            .to_str()\n            .map_err(|_| FramingError::InvalidContentLength)?;\n        let len: u64 = text\n            .parse()\n            .map_err(|_| FramingError::InvalidContentLength)?;\n\n        if expected.is_some_and(|prev| prev != len) {\n            return Err(FramingError::ConflictingContentLength);\n        }\n        expected = Some(len);\n    }\n\n    Ok(())\n}"
      },
      "questions": [
        {
          "q": "Which response can never carry a body?",
          "options": ["304 Not Modified", "200 OK", "400 Bad Request", "500 Internal Server Error"],
          "answer": 0,
          "explain": "304 and 204 are defined with no body. A 304 tells the client to reuse its cached representation; there is nothing to send."
        },
        {
          "q": "A request carries both Content-Length: 6 and Transfer-Encoding: chunked. What should a proxy do?",
          "options": [
            "Reject it with 400 rather than guess",
            "Prefer Content-Length and ignore chunked",
            "Prefer chunked and ignore Content-Length",
            "Forward both headers unchanged"
          ],
          "answer": 0,
          "explain": "The two hops may pick different framings, which is request smuggling. Rejecting the ambiguous message is the only behaviour that cannot desynchronise a connection."
        },
        {
          "q": "Which method is not safe to retry after a timeout unless the request carries an idempotency key?",
          "options": ["POST", "GET", "PUT", "DELETE"],
          "answer": 0,
          "explain": "GET, PUT and DELETE are idempotent by definition. A POST may already have created a resource, so a blind retry duplicates the effect."
        }
      ],
      "quickbytes": [
        "Reject any message with both Content-Length and Transfer-Encoding: 400, not a guess",
        "HEAD returns a GET's headers with no body; 204 and 304 never have one",
        "Idempotent: GET, HEAD, PUT, DELETE. POST needs an idempotency key to be retryable",
        "A byte count in a chunk header is hex and counts bytes, not characters"
      ],
      "production": [
        "The edge rejects ambiguous framing before routing and logs the peer when it does.",
        "Retries are limited to idempotent methods or requests carrying an idempotency key.",
        "Header count and size limits are enforced at parse time, not after routing.",
        "Front-end and back-end use the same parser family, so one smuggling shape cannot be valid at one hop and invalid at the next."
      ],
      "crates": ["hyper", "http-body-util", "bytes"],
      "github": [
        { "name": "hyper", "url": "https://github.com/hyperium/hyper" }
      ],
      "pitfall": "A proxy that forwards both Content-Length and Transfer-Encoding: the next hop chooses a different framing than you did, the leftover bytes become a request the client never sent, and the connection is reused by the next victim.",
      "resources": [
        { "title": "MDN: HTTP messages, request targets and framing", "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Messages", "kind": "docs" },
        { "title": "hyper HTTP/1 server connections", "url": "https://docs.rs/hyper/latest/hyper/server/conn/http1/", "kind": "docs" },
        { "title": "MDN: CONNECT method and tunnelling", "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Methods/CONNECT", "kind": "docs" },
        { "title": "hyper repository", "url": "https://github.com/hyperium/hyper", "kind": "repo" }
      ]
    },
    {
      "id": "f06",
      "n": 6,
      "title": "HTTP/2: multiplexing, HPACK, and stalled windows",
      "minutes": 80,
      "level": "advanced",
      "goal": "Explain how one TCP connection carries many streams, why a 65,535-byte window stalls a large response, and what GOAWAY does during a deploy.",
      "sections": [
        {
          "h": "Frames, streams, and one connection",
          "p": [
            "HTTP/2 keeps the semantics of HTTP/1.1 and replaces text framing with binary frames. Each frame has a 9-byte header carrying length, type, flags, and a 31-bit stream identifier. A request/response pair is a stream; many streams share one connection, so a slow response no longer blocks a fast one at the HTTP layer. HPACK compresses headers with a dynamic table that both ends update as the connection progresses.",
            "Multiplexing removes HTTP head-of-line blocking, not TCP head-of-line blocking. Lose one TCP segment and every stream stalls until it is retransmitted, because the kernel delivers bytes in order. On a lossy link that is why several HTTP/2 connections can beat one: the measured effect of domain sharding on cellular networks is exactly this trade between connection count and blocked streams."
          ],
          "tip": "If an HTTP/2 migration made things slower on a lossy mobile network, suspect TCP head-of-line blocking before you blame the server."
        },
        {
          "h": "Flow control is per stream and per connection",
          "p": [
            "Every stream and the connection itself have a receive window. The default initial window is 65,535 bytes, so a sender that respects it stops after 64 KB until the receiver advertises more. A client that reads a large response slowly, or a server that never grows the window, turns a fast link into a 64 KB-at-a-time transfer. That is why clients raise the connection window and enable adaptive windows.",
            "The other settings matter operationally. `SETTINGS_MAX_CONCURRENT_STREAMS` bounds in-flight requests per connection, so a client that queues a thousand streams waits for the server's limit rather than for the network. `SETTINGS_MAX_HEADER_LIST_SIZE` bounds the HPACK decode, and a server that never sets it is one crafted header block away from a memory spike."
          ],
          "code": [
            "use bytes::Bytes;",
            "use h2::server;",
            "use tokio::net::TcpStream;",
            "",
            "pub async fn serve(stream: TcpStream) -> Result<(), Box<dyn std::error::Error>> {",
            "    // Raise the windows; the 65,535-byte default caps every large response.",
            "    let mut conn = server::Builder::new()",
            "        .initial_window_size(1024 * 1024)",
            "        .initial_connection_window_size(4 * 1024 * 1024)",
            "        .max_concurrent_streams(256)",
            "        .handshake(stream)",
            "        .await?;",
            "",
            "    while let Some(accepted) = conn.accept().await {",
            "        let (request, mut respond) = accepted?;",
            "        let path = request.uri().path().to_owned();",
            "",
            "        tokio::spawn(async move {",
            "            let response = http::Response::builder()",
            "                .status(200)",
            "                .header(\"content-type\", \"text/plain\")",
            "                .body(())",
            "                .expect(\"static response builds\");",
            "",
            "            let mut body = respond.send_response(response, false)?;",
            "            body.send_data(Bytes::from(path), false)?;",
            "            body.send_data(Bytes::new(), true)?; // END_STREAM",
            "            Ok::<(), h2::Error>(())",
            "        });",
            "    }",
            "",
            "    Ok(())",
            "}"
          ].join("\n"),
          "tip": "Raising the window raises memory per connection; 4 MiB across 20,000 connections is 80 GB of worst-case buffering, so size it against your concurrency."
        },
        {
          "h": "GOAWAY is a drain, not a disconnect",
          "p": [
            "A server that is shutting down sends GOAWAY with the last stream id it will process. Streams at or below that id finish; the client must not start new ones on that connection and should move to another. Because GOAWAY and a request race, a client can still lose a request, which is why the pattern is: send GOAWAY, wait, close, and let the client retry idempotent requests elsewhere.",
            "Hyper exposes this through connection configuration: keep-alive pings detect a dead peer, and `max_concurrent_streams` bounds the work one connection can queue. On the client side, a pool that holds an HTTP/2 connection forever without pings eventually discovers a half-open socket by timing out a real request rather than by a ping that would have been free."
          ]
        }
      ],
      "exercise": {
        "prompt": "Configure an h2 server that allows 256 concurrent streams, raises the connection window to 4 MiB, and handles each stream in its own task. Then explain what a client observes for a 10 MiB response if it never sends WINDOW_UPDATE.",
        "starter": "use bytes::Bytes;\nuse h2::server;\nuse tokio::net::TcpStream;\n\npub async fn serve(stream: TcpStream) -> Result<(), Box<dyn std::error::Error>> {\n    // build the connection with windows and stream limits\n    // accept streams and respond on each\n    Ok(())\n}",
        "hint": "Use server::Builder::new().initial_window_size(..).initial_connection_window_size(..).max_concurrent_streams(..).handshake(stream). Without WINDOW_UPDATE the peer sends at most 65,535 bytes and then stops, and the body never ends.",
        "solution": "use bytes::Bytes;\nuse h2::server;\nuse tokio::net::TcpStream;\n\npub async fn serve(stream: TcpStream) -> Result<(), Box<dyn std::error::Error>> {\n    let mut conn = server::Builder::new()\n        .initial_window_size(1024 * 1024)\n        .initial_connection_window_size(4 * 1024 * 1024)\n        .max_concurrent_streams(256)\n        .handshake(stream)\n        .await?;\n\n    while let Some(accepted) = conn.accept().await {\n        let (request, mut respond) = accepted?;\n        let path = request.uri().path().to_owned();\n\n        tokio::spawn(async move {\n            let response = http::Response::builder()\n                .status(200)\n                .header(\"content-type\", \"text/plain\")\n                .body(())\n                .expect(\"static response builds\");\n\n            let mut body = respond.send_response(response, false)?;\n            body.send_data(Bytes::from(path), false)?;\n            body.send_data(Bytes::new(), true)?;\n            Ok::<(), h2::Error>(())\n        });\n    }\n\n    Ok(())\n}\n\n// A client that never sends WINDOW_UPDATE reads 65,535 bytes, then the stream\n// stalls: the sender is blocked by flow control, not by the network. It is\n// indistinguishable from a hung handler unless you export the stream window."
      },
      "questions": [
        {
          "q": "What does HTTP/2 multiplexing actually remove?",
          "options": [
            "HTTP-level head-of-line blocking between requests",
            "TCP-level head-of-line blocking after a lost segment",
            "The need for flow control",
            "The need for TLS"
          ],
          "answer": 0,
          "explain": "Streams are independent at the HTTP layer, but they share one TCP byte stream, so one lost segment still stalls every stream until it is retransmitted."
        },
        {
          "q": "A 10 MB response over HTTP/2 stops after 64 KB. What is the most likely cause?",
          "options": [
            "The client is not sending WINDOW_UPDATE, so flow control blocks the sender",
            "HPACK decompression failed",
            "The server sent GOAWAY",
            "The connection window was set to 4 GiB"
          ],
          "answer": 0,
          "explain": "65,535 bytes is the default initial window. Once it is consumed the sender must wait for WINDOW_UPDATE frames that a stalled or broken client never sends."
        },
        {
          "q": "What is GOAWAY used for during a deploy?",
          "options": [
            "Telling the peer no new streams will start, while streams at or below the last id finish",
            "Closing the connection immediately and resetting every stream",
            "Negotiating the TLS version",
            "Compressing headers for the next connection"
          ],
          "answer": 0,
          "explain": "GOAWAY carries the last stream id the server will process, so in-flight streams complete and the client moves new requests to another connection."
        }
      ],
      "quickbytes": [
        "A frame header is 9 bytes: length, type, flags, and a 31-bit stream id",
        "Default flow-control windows are 65,535 bytes per stream and per connection",
        "GOAWAY names the last stream id; drain, then close",
        "One TCP loss stalls every stream on the connection, which is QUIC's opening argument"
      ],
      "production": [
        "Server and client windows are configured explicitly and load-tested with multi-megabyte responses.",
        "MAX_CONCURRENT_STREAMS is set below the concurrency the handler can actually serve.",
        "MAX_HEADER_LIST_SIZE is bounded so a crafted header block cannot exhaust memory.",
        "Shutdown sends GOAWAY, drains, then closes; clients retry idempotent requests elsewhere."
      ],
      "crates": ["h2", "hyper", "http", "bytes"],
      "github": [
        { "name": "hyper", "url": "https://github.com/hyperium/hyper" },
        { "name": "hyper-util", "url": "https://github.com/hyperium/hyper-util" }
      ],
      "pitfall": "Leaving the default 65,535-byte connection window: a 10 MB response runs at 64 KB per round trip, CPU looks idle, and throughput sits at a fraction of the link while everything appears healthy.",
      "resources": [
        { "title": "h2 crate documentation", "url": "https://docs.rs/h2/latest/h2/", "kind": "docs" },
        { "title": "h2 server builder: windows and stream limits", "url": "https://docs.rs/h2/latest/h2/server/struct.Builder.html", "kind": "docs" },
        { "title": "Domain sharding for faster HTTP/2 in lossy cellular networks", "url": "https://arxiv.org/abs/1707.05836", "kind": "paper" },
        { "title": "hyper repository", "url": "https://github.com/hyperium/hyper", "kind": "repo" }
      ]
    },
    {
      "id": "f07",
      "n": 7,
      "title": "QUIC and HTTP/3: streams over UDP",
      "minutes": 85,
      "level": "advanced",
      "goal": "Explain what QUIC moves into user space, why 0-RTT resumption can replay a request, and how to stand up a quinn endpoint with transport limits you chose.",
      "sections": [
        {
          "h": "One handshake, many streams",
          "p": [
            "QUIC runs over UDP and folds the transport handshake and the TLS 1.3 handshake into one exchange, so a new connection is ready after one round trip and a resumed one can send data in the first flight. Streams are a transport concept: each has its own flow control and its own loss recovery, so a lost packet on one stream does not stall the others. That is the head-of-line problem TCP cannot solve.",
            "Header protection encrypts most of the packet, including the packet number, so on-path devices cannot see retransmissions or reorder them. That is why QUIC middleboxes do not exist in the way TCP middleboxes do, and why a QUIC load balancer hashes a connection ID instead of a five-tuple. It also means debugging starts at the endpoint, not at the tap."
          ],
          "tip": "A packet capture of QUIC shows almost nothing without the connection keys; plan for endpoint-side metrics instead of tap-side inspection."
        },
        {
          "h": "0-RTT is fast and replayable",
          "p": [
            "0-RTT lets a client that holds a session ticket send application data before the handshake completes, saving a round trip on reconnect. An attacker who captures that flight can replay it, so the server may process the same request twice. Only idempotent, replay-safe requests belong in 0-RTT: a GET for a cacheable resource, never a POST that moves money.",
            "Replay protection is partial. The server can remember recently seen tickets for a window and reject duplicates, but that is bounded state, not a guarantee. Most stacks default 0-RTT off for exactly this reason, and the ones that enable it restrict it to a route allowlist. Measure the round trip you save against the duplicate you may have to handle."
          ]
        },
        {
          "h": "Sizing a quinn endpoint",
          "p": [
            "An endpoint is a UDP socket plus per-connection state. `TransportConfig` carries the limits that decide memory: concurrent streams, receive windows, idle timeout, and keep-alive interval. The defaults are sized for a browser, not for a proxy holding ten thousand connections, so set them explicitly, write down the resulting worst-case memory, and load-test the number you wrote down.",
            "UDP throughput is a kernel problem too. A single socket is processed on one core unless you enable segmentation offload or run several sockets with `SO_REUSEPORT`; quinn uses GSO on Linux and falls back to one datagram per syscall when the platform cannot. Measure packets per second as well as bytes before you blame the protocol for a throughput ceiling."
          ],
          "list": [
            "Idle timeout 30 s plus keep-alive 10 s: idle timeout alone is not enough behind a NAT",
            "Max concurrent bidirectional streams, because each stream is buffered memory",
            "Stream and connection receive windows, so one slow reader cannot buffer a whole file",
            "ALPN h3 required, or the handshake is refused before HTTP exists"
          ],
          "code": [
            "use std::sync::Arc;",
            "use std::time::Duration;",
            "use quinn::crypto::rustls::QuicServerConfig;",
            "use quinn::{Endpoint, IdleTimeout, ServerConfig, VarInt};",
            "",
            "pub fn endpoint(",
            "    addr: std::net::SocketAddr,",
            "    certs: Vec<rustls::pki_types::CertificateDer<'static>>,",
            "    key: rustls::pki_types::PrivateKeyDer<'static>,",
            ") -> Result<Endpoint, Box<dyn std::error::Error>> {",
            "    let mut tls = rustls::ServerConfig::builder()",
            "        .with_no_client_auth()",
            "        .with_single_cert(certs, key)?;",
            "    tls.alpn_protocols = vec![b\"h3\".to_vec()]; // no ALPN, no HTTP/3",
            "",
            "    let mut config = ServerConfig::with_crypto(Arc::new(QuicServerConfig::try_from(tls)?));",
            "    let transport = Arc::get_mut(&mut config.transport).expect(\"freshly built config\");",
            "    transport.max_idle_timeout(Some(IdleTimeout::try_from(Duration::from_secs(30))?));",
            "    transport.keep_alive_interval(Some(Duration::from_secs(10)));",
            "    transport.max_concurrent_bidi_streams(VarInt::from_u32(256));",
            "",
            "    Ok(Endpoint::server(config, addr)?)",
            "}",
            "",
            "pub async fn accept_loop(endpoint: Endpoint) -> Result<(), Box<dyn std::error::Error>> {",
            "    while let Some(incoming) = endpoint.accept().await {",
            "        let conn = incoming.await?;",
            "        tokio::spawn(async move {",
            "            while let Ok((mut send, mut recv)) = conn.accept_bi().await {",
            "                tokio::spawn(async move {",
            "                    let body = recv.read_to_end(64 * 1024).await.unwrap_or_default();",
            "                    let _ = send.write_all(&body).await;",
            "                    let _ = send.finish();",
            "                });",
            "            }",
            "        });",
            "    }",
            "    Ok(())",
            "}"
          ].join("\n"),
          "tip": "The default stream limit is a small number chosen for browsers; a proxy that copies a 4 MiB body per stream needs its own budget."
        }
      ],
      "exercise": {
        "prompt": "Stand up a quinn server with ALPN h3, a 30-second idle timeout, a 10-second keep-alive, and a 256-stream limit. Then explain what a client sees when it opens stream 257.",
        "starter": "use std::sync::Arc;\nuse std::time::Duration;\nuse quinn::{Endpoint, ServerConfig};\n\npub fn build(addr: std::net::SocketAddr) -> Result<Endpoint, Box<dyn std::error::Error>> {\n    // 1. build the rustls config and set ALPN\n    // 2. wrap it with QuicServerConfig\n    // 3. set transport limits\n    Ok(Endpoint::server(ServerConfig::with_single_cert(vec![], todo!())?, addr)?)\n}",
        "hint": "Build rustls::ServerConfig::builder().with_no_client_auth().with_single_cert(...), set alpn_protocols to h3, then ServerConfig::with_crypto(Arc::new(QuicServerConfig::try_from(tls)?)) and mutate config.transport through Arc::get_mut.",
        "solution": "use std::sync::Arc;\nuse std::time::Duration;\nuse quinn::crypto::rustls::QuicServerConfig;\nuse quinn::{Endpoint, IdleTimeout, ServerConfig, VarInt};\n\npub fn build(\n    addr: std::net::SocketAddr,\n    certs: Vec<rustls::pki_types::CertificateDer<'static>>,\n    key: rustls::pki_types::PrivateKeyDer<'static>,\n) -> Result<Endpoint, Box<dyn std::error::Error>> {\n    let mut tls = rustls::ServerConfig::builder()\n        .with_no_client_auth()\n        .with_single_cert(certs, key)?;\n    tls.alpn_protocols = vec![b\"h3\".to_vec()];\n\n    let mut config = ServerConfig::with_crypto(Arc::new(QuicServerConfig::try_from(tls)?));\n    let transport = Arc::get_mut(&mut config.transport).expect(\"freshly built config\");\n    transport.max_idle_timeout(Some(IdleTimeout::try_from(Duration::from_secs(30))?));\n    transport.keep_alive_interval(Some(Duration::from_secs(10)));\n    transport.max_concurrent_bidi_streams(VarInt::from_u32(256));\n\n    Ok(Endpoint::server(config, addr)?)\n}\n\n// Stream 257 is not refused: open_bi() waits until a stream slot is free.\n// If every stream is long-lived, the client blocks forever and sees no error,\n// which is why a proxy needs a stream-concurrency metric and a per-stream\n// deadline rather than assuming the transport will complain."
      },
      "questions": [
        {
          "q": "What does 0-RTT resumption cost in exchange for one fewer round trip?",
          "options": [
            "Replayable early data that the server may process twice",
            "A second TLS handshake later in the session",
            "Loss of forward secrecy for the whole session",
            "An extra TCP connection alongside the QUIC one"
          ],
          "answer": 0,
          "explain": "Early data can be captured and replayed, so only idempotent requests belong in 0-RTT. The rest of the session still has forward secrecy from the handshake that follows."
        },
        {
          "q": "Why can an on-path middlebox not rewrite QUIC packet numbers?",
          "options": [
            "Most of the packet, including the packet number, is encrypted",
            "QUIC packets are signed by the router",
            "Packet numbers do not exist in QUIC",
            "They are protected only by the UDP checksum"
          ],
          "answer": 0,
          "explain": "QUIC applies header protection so the packet number is not visible on the wire. That is what removes the middlebox's ability to reorder, drop, or inspect per-packet state."
        },
        {
          "q": "A QUIC load balancer must route on what instead of a five-tuple?",
          "options": [
            "The connection ID",
            "The TLS session ticket",
            "The HTTP path",
            "The UDP checksum"
          ],
          "answer": 0,
          "explain": "Client addresses change on migration, so a five-tuple hash breaks the connection. The connection ID is designed to be the stable routing key."
        }
      ],
      "quickbytes": [
        "QUIC does TLS 1.3 and the transport handshake in one round trip; resumption can reach zero",
        "Header protection hides packet numbers, so tap-based debugging needs the keys",
        "ALPN h3 is mandatory; without it the connection dies before HTTP exists",
        "0-RTT early data is replayable: restrict it to idempotent routes or leave it off"
      ],
      "production": [
        "ALPN, idle timeout, keep-alive and stream limits are set explicitly and reviewed as capacity numbers.",
        "Per-stream deadlines exist, because a blocked open_bi() never returns an error.",
        "0-RTT is disabled or allowlisted to idempotent routes, with server-side replay defence.",
        "Packets per second, not just bytes, are measured on the UDP receive path."
      ],
      "crates": ["quinn", "rustls", "tokio"],
      "github": [
        { "name": "quinn", "url": "https://github.com/quinn-rs/quinn" },
        { "name": "rustls", "url": "https://github.com/rustls/rustls" }
      ],
      "pitfall": "Default transport limits on a proxy: the concurrent-stream cap is sized for a browser, so a few hundred long-lived streams make new requests wait inside open_bi() with no error and no timeout.",
      "resources": [
        { "title": "quinn Endpoint: accept, connect, migration", "url": "https://docs.rs/quinn/latest/quinn/struct.Endpoint.html", "kind": "docs" },
        { "title": "quinn TransportConfig: streams, windows, idle timeout", "url": "https://docs.rs/quinn/latest/quinn/struct.TransportConfig.html", "kind": "docs" },
        { "title": "Passive measurement of QUIC deployments and load balancer behaviour", "url": "https://arxiv.org/abs/2209.00965", "kind": "paper" },
        { "title": "quinn repository", "url": "https://github.com/quinn-rs/quinn", "kind": "repo" }
      ]
    },
    {
      "id": "f08",
      "n": 8,
      "title": "TLS termination with rustls",
      "minutes": 90,
      "level": "advanced",
      "goal": "Terminate TLS in-process with rustls: pick a crypto provider, resolve certificates by SNI, negotiate ALPN correctly, and reason about session resumption.",
      "sections": [
        {
          "h": "What terminates where",
          "p": [
            "TLS termination means the proxy owns the private key and the client's encrypted channel ends there; everything behind it is plaintext unless you re-encrypt. rustls makes this a library call rather than a linked C library: no OpenSSL, no system dependency, memory safety in the parser. The cost is that you wire the pieces explicitly: provider, certificates, ALPN, and session storage.",
            "The crypto provider is chosen by feature at build time and by `install_default` at run time. With both `aws-lc-rs` and `ring` enabled, the process must pick one before building any config, or construction fails with no process-level provider available. Pinning one provider in Cargo features is the least surprising option for a service that builds in CI and runs in a container."
          ],
          "tip": "Construct your TLS config once at startup and share it in an Arc; rebuilding it per connection re-parses certificates and destroys the resumption cache."
        },
        {
          "h": "SNI, ALPN, and the handshake contract",
          "p": [
            "TLS carries the requested hostname in the ClientHello, before any certificate is sent, so one listener can serve many domains. Implement `ResolvesServerCert` and return the certified key for that name; return `None` and the handshake fails with an unrecognised-name alert. Never fall back to a default certificate silently, because that hands a customer another tenant's name and a certificate they did not ask for.",
            "ALPN is how the client and server agree on HTTP/2 versus HTTP/1.1 before the first request. A server that advertises only `http/1.1` will silently serve every browser at 1.1 speeds, with no error anywhere. Advertise `h2` then `http/1.1` in that preference order, read the negotiated value after the handshake, and route the connection to the matching parser."
          ],
          "code": [
            "use std::sync::Arc;",
            "use rustls::pki_types::{CertificateDer, PrivateKeyDer};",
            "use rustls::server::{ClientHello, ResolvesServerCert};",
            "use rustls::sign::CertifiedKey;",
            "",
            "struct SniCerts {",
            "    entries: Vec<(String, Arc<CertifiedKey>)>,",
            "}",
            "",
            "impl ResolvesServerCert for SniCerts {",
            "    fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {",
            "        let name = hello.server_name()?;",
            "        self.entries",
            "            .iter()",
            "            .find(|(host, _)| host == name)",
            "            .map(|(_, key)| Arc::clone(key))",
            "    }",
            "}",
            "",
            "pub fn server_config(",
            "    entries: Vec<(String, Vec<CertificateDer<'static>>, PrivateKeyDer<'static>)>,",
            ") -> Result<Arc<rustls::ServerConfig>, Box<dyn std::error::Error>> {",
            "    let mut certs = Vec::with_capacity(entries.len());",
            "    for (host, chain, key) in entries {",
            "        let signing = rustls::crypto::aws_lc_rs::sign::any_supported_type(&key)?;",
            "        certs.push((host, Arc::new(CertifiedKey::new(chain, signing))));",
            "    }",
            "",
            "    let mut config = rustls::ServerConfig::builder()",
            "        .with_no_client_auth()",
            "        .with_cert_resolver(Arc::new(SniCerts { entries: certs }));",
            "    config.alpn_protocols = vec![b\"h2\".to_vec(), b\"http/1.1\".to_vec()];",
            "    Ok(Arc::new(config))",
            "}"
          ].join("\n"),
          "tip": "Check the negotiated ALPN after the handshake; a client that offered nothing gets an empty value, and the safe default is HTTP/1.1."
        },
        {
          "h": "Resumption, tickets, and 0-RTT",
          "p": [
            "Session tickets let a returning client skip a full handshake. rustls stores server-side ticket state in a `ProducesTickets` implementation; the default in-memory store is per-process, so two replicas behind a load balancer do not share it and resumption only succeeds when the client lands on the same instance. Either accept that hit rate or back the store with shared state.",
            "0-RTT is the resumption path that sends data with the first flight, and it inherits QUIC's replay problem. rustls exposes it through early-data APIs; enable it only for routes where a duplicate request is harmless, and make the application idempotent anyway. Early data also skips some checks by design, so it weakens the guarantee you are selling to a customer."
          ],
          "list": [
            "Tickets are opaque: rotating the key invalidates every outstanding ticket at once",
            "A shared ticket store trades a network hop on resume for a better hit rate",
            "Certificate expiry is an outage with a date; monitor it like an SLO, not a calendar reminder",
            "Handshake errors are not retryable: an unknown name or bad chain fails the same way twice"
          ]
        }
      ],
      "exercise": {
        "prompt": "Serve two hostnames from one listener, negotiate h2 for clients that offer it, and fail the handshake for any other hostname. Then explain why a silent default certificate is worse than a failed handshake.",
        "starter": "use std::sync::Arc;\nuse rustls::server::{ClientHello, ResolvesServerCert};\nuse rustls::sign::CertifiedKey;\n\nstruct Resolver {\n    entries: Vec<(String, Arc<CertifiedKey>)>,\n}\n\nimpl ResolvesServerCert for Resolver {\n    fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {\n        todo!()\n    }\n}",
        "hint": "Return None when server_name() is absent or not in the list: rustls then sends an unrecognised_name alert. Set alpn_protocols to [h2, http/1.1] so h2 is preferred when offered.",
        "solution": "use std::sync::Arc;\nuse rustls::server::{ClientHello, ResolvesServerCert};\nuse rustls::sign::CertifiedKey;\n\nstruct Resolver {\n    entries: Vec<(String, Arc<CertifiedKey>)>,\n}\n\nimpl ResolvesServerCert for Resolver {\n    fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {\n        let name = hello.server_name()?;\n        self.entries\n            .iter()\n            .find(|(host, _)| host == name)\n            .map(|(_, key)| Arc::clone(key))\n    }\n}\n\npub fn build(entries: Vec<(String, Arc<CertifiedKey>)>) -> Arc<rustls::ServerConfig> {\n    let mut config = rustls::ServerConfig::builder()\n        .with_no_client_auth()\n        .with_cert_resolver(Arc::new(Resolver { entries }));\n    config.alpn_protocols = vec![b\"h2\".to_vec(), b\"http/1.1\".to_vec()];\n    Arc::new(config)\n}\n\n// A default certificate means a client asking for unknown.example gets a valid\n// certificate for someone else's name: the connection succeeds, the client\n// sends a request for a host you do not serve, and the failure surfaces later\n// as a confusing 404 or, worse, as data belonging to another tenant."
      },
      "questions": [
        {
          "q": "What does the ClientHello carry before any certificate is sent?",
          "options": [
            "The requested server name (SNI)",
            "The client certificate",
            "The HTTP request line",
            "The session key"
          ],
          "answer": 0,
          "explain": "SNI arrives in the ClientHello so the server can choose a certificate. That is why one listener can serve many names, and why the server learns the hostname before authentication."
        },
        {
          "q": "A server advertises only http/1.1 in ALPN. What happens to an HTTP/2-capable client?",
          "options": [
            "It is served over HTTP/1.1 with no error",
            "The handshake is refused",
            "It upgrades to HTTP/2 after the first request",
            "It falls back to HTTP/3"
          ],
          "answer": 0,
          "explain": "ALPN simply picks from the intersection. Nothing fails, which is why a missing h2 entry is a silent performance regression rather than a visible bug."
        },
        {
          "q": "Why does in-memory ticket storage hurt resumption behind a load balancer?",
          "options": [
            "A ticket is only valid on the instance that issued it",
            "Tickets expire after one second",
            "TLS 1.3 forbids resumption",
            "The store is shared but slow"
          ],
          "answer": 0,
          "explain": "Tickets are encrypted with per-process state, so a client that lands on another replica cannot resume and pays a full handshake."
        }
      ],
      "quickbytes": [
        "Set alpn_protocols to [h2, http/1.1]; an empty list means 1.1 with no error",
        "Return None from the resolver for unknown names instead of serving a default certificate",
        "Build the ServerConfig once at startup and share it with Arc",
        "Monitor certificate expiry as an SLO; expiry is a scheduled outage"
      ],
      "production": [
        "Exactly one crypto provider is enabled, or install_default runs before any config is built.",
        "The SNI resolver fails closed for unknown hostnames, and the alert is logged with the requested name.",
        "ALPN is configured and asserted in an integration test that speaks h2.",
        "Session ticket keys rotate on a schedule, and the resumption hit rate is a metric."
      ],
      "crates": ["rustls", "tokio-rustls", "tokio"],
      "github": [
        { "name": "rustls", "url": "https://github.com/rustls/rustls" },
        { "name": "tokio", "url": "https://github.com/tokio-rs/tokio" }
      ],
      "pitfall": "Forgetting ALPN entirely: browsers and gRPC clients quietly negotiate HTTP/1.1, HTTP/2 multiplexing never happens, and every latency regression is blamed on the application.",
      "resources": [
        { "title": "rustls server certificate resolution (ResolvesServerCert)", "url": "https://docs.rs/rustls/latest/rustls/server/trait.ResolvesServerCert.html", "kind": "docs" },
        { "title": "tokio-rustls: async TLS acceptor and connector", "url": "https://docs.rs/tokio-rustls/latest/tokio_rustls/", "kind": "docs" },
        { "title": "MDN: transport layer security", "url": "https://developer.mozilla.org/en-US/docs/Web/Security/Transport_Layer_Security", "kind": "docs" },
        { "title": "rustls repository", "url": "https://github.com/rustls/rustls", "kind": "repo" }
      ]
    },
    {
      "id": "f09",
      "n": 9,
      "title": "DNS: the cache you do not control",
      "minutes": 70,
      "level": "advanced",
      "goal": "Trace a lookup through resolver caches, TTLs and CNAME chains, then use hickory-resolver with explicit timeouts and explain why pooled connections ignore DNS changes.",
      "sections": [
        {
          "h": "Resolution is a chain of caches",
          "p": [
            "A lookup starts in the stub resolver, which checks its own cache, then the configured nameservers, which recurse from the root through the TLD to the authoritative server for the zone. Every answer carries a TTL, and every hop may cache it. You control the TTL in your zone and nothing else; a resolver that ignores your 30-second TTL because its operator set an hour-long minimum is not violating a contract you can enforce.",
            "CNAMEs add hops. A name that points at a CDN's name has its own TTL, and the resolver must resolve the target too, so the effective lifetime is the minimum along the chain. Negative answers are cached as well, using the SOA minimum, which is why a typo keeps failing for minutes after you fix it. `dig +trace` shows the chain; `dig +noall +answer` shows what your resolver actually returned."
          ],
          "tip": "When a failover takes longer than your TTL, the extra time is in a cache you do not own; measure resolution from the client's resolver, not from the authoritative server."
        },
        {
          "h": "Happy Eyeballs and truncated responses",
          "p": [
            "A name can return both A and AAAA records. Connecting to the first address and waiting for it to fail wastes a full TCP timeout when the other family works. Happy Eyeballs starts the second family's connection shortly after the first, typically 250 ms, and uses whichever completes. Hyper's connector implements this, but only if the resolver returned both families and you did not filter one out for tidiness.",
            "UDP answers are limited to 512 bytes without EDNS0, so a large answer sets the truncated bit and the resolver retries over TCP. A firewall that allows UDP/53 and blocks TCP/53 produces lookups that work for small zones and fail for large ones, often only under load. If you run DNS through a firewall, allow both transports and test with a large TXT record."
          ]
        },
        {
          "h": "Long-lived connections ignore DNS",
          "p": [
            "A connection pool holds sockets open for minutes or hours. If the record changes, the pool keeps using the address it connected to, and a failover that flips the record appears to do nothing until the pool drains. That is not a DNS bug; it is the pool doing its job. Either keep the maximum connection age below the TTL, or make the pool aware that resolution changed.",
            "In-process caching is a second layer. hickory-resolver caches per resolver instance and exposes TTL bounds for positive and negative answers, so a resolver created per request caches nothing while one shared for a week serves answers inside the TTL contract. Share one resolver, size its cache, and record lookup latency as a metric on the request path, because DNS is a dependency like any other."
          ],
          "code": [
            "use std::time::Duration;",
            "use hickory_resolver::Resolver;",
            "",
            "pub async fn resolve(host: &str) -> Result<Vec<std::net::IpAddr>, Box<dyn std::error::Error>> {",
            "    // One shared resolver per process: a resolver per request caches nothing.",
            "    let resolver = Resolver::builder_tokio()?.build()?;",
            "",
            "    // Bound the lookup: a black-holed nameserver must not eat the request budget.",
            "    let lookup = tokio::time::timeout(",
            "        Duration::from_millis(800),",
            "        resolver.lookup_ip(host),",
            "    )",
            "    .await??;",
            "",
            "    let addrs: Vec<std::net::IpAddr> = lookup.iter().map(|ip| ip.to_owned()).collect();",
            "    if addrs.is_empty() {",
            "        return Err(format!(\"no addresses for {host}\").into());",
            "    }",
            "    Ok(addrs)",
            "}"
          ].join("\n"),
          "tip": "Try both families from one lookup and start the second connection after ~250 ms; sequential fallback turns a broken IPv6 route into a full-timeout stall."
        }
      ],
      "exercise": {
        "prompt": "Write a resolver wrapper that shares one resolver per process, fails within 800 ms, returns both address families, and reports how long resolution took. Then explain why a per-request resolver is worse than no cache at all.",
        "starter": "use std::time::Duration;\nuse hickory_resolver::Resolver;\n\npub struct Dns {\n    // one resolver, shared\n}\n\nimpl Dns {\n    pub async fn lookup(&self, host: &str) -> Result<Vec<std::net::IpAddr>, String> {\n        todo!()\n    }\n}",
        "hint": "Store the resolver built once from Resolver::builder_tokio(), wrap lookup_ip in tokio::time::timeout, and collect every address rather than the first. A per-request resolver allocates and re-reads system config while caching nothing.",
        "solution": "use std::time::{Duration, Instant};\nuse hickory_resolver::Resolver;\n\npub struct Dns {\n    resolver: Resolver,\n}\n\nimpl Dns {\n    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {\n        Ok(Self {\n            resolver: Resolver::builder_tokio()?.build()?,\n        })\n    }\n\n    pub async fn lookup(&self, host: &str) -> Result<Vec<std::net::IpAddr>, String> {\n        let started = Instant::now();\n        let lookup = tokio::time::timeout(Duration::from_millis(800), self.resolver.lookup_ip(host))\n            .await\n            .map_err(|_| format!(\"dns timeout for {host}\"))?\n            .map_err(|err| format!(\"dns error for {host}: {err}\"))?;\n\n        let addrs: Vec<std::net::IpAddr> = lookup.iter().map(|ip| ip.to_owned()).collect();\n        tracing::debug!(host, ms = started.elapsed().as_millis(), count = addrs.len(), \"resolved\");\n\n        if addrs.is_empty() {\n            return Err(format!(\"no addresses for {host}\"));\n        }\n        Ok(addrs)\n    }\n}\n\n// A per-request resolver pays construction, re-reads resolv.conf, and caches\n// nothing, so every lookup becomes an authoritative round trip. Sharing one\n// resolver is what turns the TTL into an actual cache instead of a promise."
      },
      "questions": [
        {
          "q": "Which TTL governs how long a resolver may cache a CNAME chain?",
          "options": [
            "The minimum TTL along the chain",
            "The TTL of the last record only",
            "The SOA minimum in every case",
            "The client's local cache setting"
          ],
          "answer": 0,
          "explain": "Each record in the chain has its own TTL, and the cached answer cannot outlive the shortest of them without serving an expired link."
        },
        {
          "q": "Large TXT answers fail while small lookups work. What is likely blocked?",
          "options": [
            "TCP port 53, needed after a truncated UDP response",
            "UDP port 53",
            "DNSSEC validation",
            "The resolver's negative cache"
          ],
          "answer": 0,
          "explain": "A UDP answer over 512 bytes without EDNS0 is truncated, and the resolver retries over TCP. Blocking TCP/53 breaks exactly the large answers."
        },
        {
          "q": "Why does a DNS failover appear to do nothing for existing traffic?",
          "options": [
            "Connection pools keep using the address they already connected to",
            "Resolvers ignore TTLs",
            "The record is cached forever",
            "TLS pins the IP address in the certificate"
          ],
          "answer": 0,
          "explain": "An established connection never re-resolves. Until the pool evicts it or the maximum connection age expires, that socket keeps talking to the old address."
        }
      ],
      "quickbytes": [
        "Share one resolver per process; a resolver per request is a cache that never hits",
        "Bound lookups with a timeout; DNS is on the request path and can hang like any dependency",
        "Return both A and AAAA and let Happy Eyeballs pick the winner after ~250 ms",
        "Negative answers are cached too, so a bad deploy can outlive its fix by the SOA minimum"
      ],
      "production": [
        "Lookup latency and failure rate are metrics, not just log lines.",
        "Pool maximum connection age is lower than the DNS TTL of the upstream.",
        "Both UDP/53 and TCP/53 are allowed through every firewall on the resolution path.",
        "Search domains and ndots are reviewed, because they silently multiply the queries per request."
      ],
      "crates": ["hickory-resolver", "tokio", "tracing"],
      "github": [
        { "name": "hickory-dns", "url": "https://github.com/hickory-dns/hickory-dns" }
      ],
      "pitfall": "A resolver constructed inside the request handler: every lookup bypasses the cache, adds a full recursive resolution, and multiplies DNS traffic by your request rate during exactly the incident when DNS is already struggling.",
      "resources": [
        { "title": "hickory-resolver: caching resolver, TTL bounds, DoT and DoH", "url": "https://docs.rs/hickory-resolver/latest/hickory_resolver/", "kind": "docs" },
        { "title": "tokio::time::timeout for bounding lookups", "url": "https://docs.rs/tokio/latest/tokio/time/fn.timeout.html", "kind": "docs" },
        { "title": "MDN: DNS concepts and record types", "url": "https://developer.mozilla.org/en-US/docs/Glossary/DNS", "kind": "docs" },
        { "title": "hickory-dns repository", "url": "https://github.com/hickory-dns/hickory-dns", "kind": "repo" }
      ]
    },
    {
      "id": "f10",
      "n": 10,
      "title": "Proxies: forward, reverse, and CONNECT",
      "minutes": 90,
      "level": "advanced",
      "goal": "Distinguish forward from reverse proxying, strip hop-by-hop headers correctly, and implement CONNECT tunnelling with hyper's upgrade path.",
      "sections": [
        {
          "h": "Two products with one name",
          "p": [
            "A forward proxy receives requests on behalf of a client, usually in absolute form, and may be asked to tunnel with CONNECT. A reverse proxy receives requests on behalf of a server, in origin form, and routes by Host or path. The parsing differs, the trust model differs, and the headers you must rewrite differ; a single implementation that assumes one shape breaks on the other in ways that look like application bugs.",
            "The forward case is an access-control boundary: the client chooses the destination, so you validate the target, refuse internal ranges, and log the authority. The reverse case is a routing boundary: the client chose your name, so you validate the Host against configured routes and never let a header choose which upstream gets the request unless that upstream is on an allowlist."
          ],
          "tip": "A forward proxy that accepts origin-form requests, or a reverse proxy that accepts absolute-form, is one SSRF report away from being someone's internal port scanner."
        },
        {
          "h": "Hop-by-hop headers are per connection",
          "p": [
            "Some headers describe the connection rather than the message: Connection, Keep-Alive, Proxy-Authenticate, Proxy-Authorization, TE, Trailer, Transfer-Encoding, and Upgrade. They must not be forwarded, because the next hop has its own connection semantics. Worse, `Connection` can name additional headers that are hop-by-hop for that message, so a correct proxy removes the tokens listed in `Connection` as well as the standard set.",
            "Then add forwarding metadata deliberately. `Via` records that a proxy handled the message. X-Forwarded-For appends the client address, and Forwarded is the standardised equivalent. Both are trivially spoofable by clients, so the application must only trust them from a known proxy hop, take the last value your edge appended, and never use them for authentication or authorisation decisions."
          ],
          "list": [
            "Strip the eight standard hop-by-hop headers on every hop",
            "Strip every header named in the Connection header's token list",
            "Append to X-Forwarded-For or Forwarded; never replace the client's value silently",
            "Trust forwarding headers only when the peer address is a known proxy"
          ],
          "code": [
            "use bytes::Bytes;",
            "use http_body_util::{combinators::BoxBody, BodyExt};",
            "use hyper::body::Incoming;",
            "use hyper::header::{HeaderValue, CONNECTION};",
            "use hyper::{Request, Response};",
            "use hyper_util::client::legacy::connect::HttpConnector;",
            "use hyper_util::client::legacy::Client;",
            "",
            "pub type ProxyBody = BoxBody<Bytes, hyper::Error>;",
            "",
            "const HOP_BY_HOP: [&str; 8] = [",
            "    \"connection\", \"keep-alive\", \"proxy-authenticate\", \"proxy-authorization\",",
            "    \"te\", \"trailer\", \"transfer-encoding\", \"upgrade\",",
            "];",
            "",
            "pub async fn forward(",
            "    client: &Client<HttpConnector, Incoming>,",
            "    mut req: Request<Incoming>,",
            ") -> Result<Response<ProxyBody>, Box<dyn std::error::Error>> {",
            "    // A forward proxy is addressed in absolute form; anything else is not for us.",
            "    if req.uri().authority().is_none() {",
            "        return Err(\"origin-form request on a forward proxy\".into());",
            "    }",
            "",
            "    // Headers named by Connection are hop-by-hop for this message too.",
            "    let named: Vec<String> = req",
            "        .headers()",
            "        .get_all(CONNECTION)",
            "        .iter()",
            "        .filter_map(|value| value.to_str().ok())",
            "        .flat_map(|value| value.split(',').map(|token| token.trim().to_ascii_lowercase()))",
            "        .collect();",
            "",
            "    for name in HOP_BY_HOP {",
            "        req.headers_mut().remove(name);",
            "    }",
            "    for name in named {",
            "        req.headers_mut().remove(name.as_str());",
            "    }",
            "",
            "    req.headers_mut()",
            "        .insert(\"via\", HeaderValue::from_static(\"1.1 rust-academy-proxy\"));",
            "",
            "    let response = client.request(req).await?;",
            "    Ok(response.map(|body| body.boxed()))",
            "}"
          ].join("\n"),
          "tip": "The legacy hyper client keeps the absolute URI for routing and writes origin-form upstream, so stripping headers is the only rewrite a forward proxy needs."
        },
        {
          "h": "CONNECT is a byte pipe",
          "p": [
            "CONNECT asks the proxy to open a TCP connection to an authority and then stop parsing HTTP. The proxy replies 200 and the connection becomes opaque bytes, which is how HTTPS works through a forward proxy. In hyper the upgrade arrives through `hyper::upgrade::on`, and you then copy bytes in both directions with `tokio::io::copy_bidirectional`.",
            "The operational details are policy: restrict CONNECT to 443, cap concurrent tunnels, set an idle timeout, and remember that you can no longer see or filter the traffic inside. A tunnel that is never closed is a file descriptor and a pair of buffers that outlive the request that created it, so tie its lifetime to the client connection and to the token that authorised it."
          ]
        }
      ],
      "exercise": {
        "prompt": "Write the header sanitisation a reverse proxy runs before forwarding: remove hop-by-hop headers including the ones named in Connection, add Via, and reject a request whose Host is not in the route table.",
        "starter": "use hyper::header::HeaderMap;\n\npub fn sanitize(headers: &mut HeaderMap) {\n    todo!()\n}\n\npub fn check_host(headers: &HeaderMap, allowed: &[&str]) -> Result<(), &'static str> {\n    todo!()\n}",
        "hint": "Collect the tokens from every Connection header first, then remove the standard eight and the collected tokens. Compare Host's hostname (before the colon) case-insensitively against the allowlist.",
        "solution": "use hyper::header::{HeaderMap, HeaderValue, CONNECTION, HOST};\n\nconst HOP_BY_HOP: [&str; 8] = [\n    \"connection\", \"keep-alive\", \"proxy-authenticate\", \"proxy-authorization\",\n    \"te\", \"trailer\", \"transfer-encoding\", \"upgrade\",\n];\n\npub fn sanitize(headers: &mut HeaderMap) {\n    let named: Vec<String> = headers\n        .get_all(CONNECTION)\n        .iter()\n        .filter_map(|value| value.to_str().ok())\n        .flat_map(|value| value.split(',').map(|token| token.trim().to_ascii_lowercase()))\n        .collect();\n\n    for name in HOP_BY_HOP {\n        headers.remove(name);\n    }\n    for name in named {\n        headers.remove(name.as_str());\n    }\n\n    headers.insert(\"via\", HeaderValue::from_static(\"1.1 edge\"));\n}\n\npub fn check_host(headers: &HeaderMap, allowed: &[&str]) -> Result<(), &'static str> {\n    let host = headers\n        .get(HOST)\n        .and_then(|value| value.to_str().ok())\n        .ok_or(\"missing Host\")?;\n\n    let hostname = host.split(':').next().unwrap_or(host);\n    if allowed.iter().any(|name| name.eq_ignore_ascii_case(hostname)) {\n        Ok(())\n    } else {\n        Err(\"unknown Host\")\n    }\n}"
      },
      "questions": [
        {
          "q": "Which header must a proxy strip because it describes the connection rather than the message?",
          "options": ["Connection", "Content-Type", "Accept-Encoding", "User-Agent"],
          "answer": 0,
          "explain": "Connection, Keep-Alive, TE, Trailer, Transfer-Encoding, Upgrade and the proxy authentication headers are hop-by-hop: they describe the connection that ends at the proxy."
        },
        {
          "q": "What does a forward proxy receive in the request line that a reverse proxy does not?",
          "options": [
            "An absolute-form target such as https://host/path",
            "A CONNECT method in every request",
            "An HTTP/2 pseudo-header",
            "A chunked body"
          ],
          "answer": 0,
          "explain": "The client names the destination, so the target is absolute. A reverse proxy receives origin-form and finds the upstream from Host or the route table."
        },
        {
          "q": "Why can X-Forwarded-For never be trusted on its own?",
          "options": [
            "Clients can send it, and proxies append rather than replace",
            "It is encrypted by TLS",
            "HTTP/2 strips it",
            "Browsers never set it"
          ],
          "answer": 0,
          "explain": "An attacker can send any value. Only the entry appended by your own trusted edge is meaningful, so read from the right and verify the peer address."
        }
      ],
      "quickbytes": [
        "Forward proxy: absolute-form targets and CONNECT. Reverse proxy: origin-form and Host routing",
        "Eight hop-by-hop headers, plus every token listed in Connection",
        "Via records the hop; Forwarded and X-Forwarded-For need a trust boundary",
        "CONNECT turns the connection opaque: cap it, time it out, and log the authority"
      ],
      "production": [
        "Forward and reverse modes are separate code paths with separate validation rules.",
        "CONNECT is restricted to 443, capped in count, and given an idle timeout.",
        "Forwarded headers are honoured only from known proxy addresses.",
        "Every tunnel is tied to the client connection and closed when the client goes away."
      ],
      "crates": ["hyper", "hyper-util", "http-body-util", "bytes"],
      "github": [
        { "name": "hyper", "url": "https://github.com/hyperium/hyper" },
        { "name": "hyper-util", "url": "https://github.com/hyperium/hyper-util" }
      ],
      "pitfall": "Forwarding the Connection header and everything it names: the upstream inherits hop-by-hop semantics meant for your connection, and a keep-alive token can make it reuse a socket the next hop considers closed.",
      "resources": [
        { "title": "hyper upgrades and CONNECT tunnelling", "url": "https://docs.rs/hyper/latest/hyper/upgrade/", "kind": "docs" },
        { "title": "hyper-util legacy client: pooling and connectors", "url": "https://docs.rs/hyper-util/latest/hyper_util/", "kind": "docs" },
        { "title": "HTTP/3 vs HTTP/2 with proxy integration", "url": "https://arxiv.org/abs/2409.16267", "kind": "paper" },
        { "title": "hyper repository", "url": "https://github.com/hyperium/hyper", "kind": "repo" }
      ]
    },
    {
      "id": "f11",
      "n": 11,
      "title": "Load balancing: round robin, P2C, and the tail",
      "minutes": 75,
      "level": "advanced",
      "goal": "Choose an algorithm by what it optimises, implement power-of-two-choices correctly, and explain why health checks and ejection decide more outcomes than the algorithm does.",
      "sections": [
        {
          "h": "Algorithms and the cost they ignore",
          "p": [
            "Round robin is fair in requests and blind to cost: one endpoint with a slow dependency gets the same share as a healthy one. Least-connections fixes that but needs shared, accurate in-flight counts, which is why it is easier inside a mesh than across independent balancers. Weighted variants only help when you know the capacity ratio and keep it current; a stale weight is worse than none.",
            "Latency-aware balancing (EWMA of observed latency) tracks the outcome you care about, at the price of reacting slowly to a sudden change and being noisy when samples are few. Consistent hashing, and Maglev-style hashing, trade perfect balance for stability: the same key lands on the same backend when the set changes, which is what cache affinity needs and what a hot key punishes."
          ],
          "list": [
            "Round robin: even request counts, no notion of endpoint cost",
            "Least connections: needs live in-flight state per endpoint",
            "Power of two choices: near-least-loaded with only local information",
            "Consistent or Maglev hashing: stable key placement for caching, vulnerable to hot keys"
          ],
          "tip": "If one endpoint is chronically slower, no algorithm saves you; outlier ejection removes it from the pool, and the algorithm only has to be good enough."
        },
        {
          "h": "Power of two choices, implemented",
          "p": [
            "P2C picks two endpoints at random and sends the request to whichever reports less load. With random choices the maximum load is bounded far more tightly than pure random, and it needs only each endpoint's own counter, so there is no global lock and no cross-node gossip. That is why it is the default in several production proxies and in tower's balance module.",
            "The counter matters. In-flight requests, a peak-EWMA of latency, and queue depth all give different behaviour; in-flight is cheap and works well for uniform work, while an EWMA is better when request cost varies by orders of magnitude. Whichever you choose, the estimator must decay or reset, or a single long request pins an endpoint out of rotation for minutes."
          ],
          "code": [
            "use std::sync::atomic::{AtomicU64, Ordering};",
            "use std::sync::Arc;",
            "",
            "pub struct Endpoint {",
            "    pub addr: String,",
            "    pub inflight: AtomicU64,",
            "}",
            "",
            "impl Endpoint {",
            "    fn load(&self) -> u64 {",
            "        self.inflight.load(Ordering::Relaxed)",
            "    }",
            "}",
            "",
            "pub struct P2c {",
            "    endpoints: Vec<Arc<Endpoint>>,",
            "    seed: AtomicU64,",
            "}",
            "",
            "impl P2c {",
            "    /// Two random candidates, least loaded wins. O(1), no shared lock.",
            "    pub fn pick(&self) -> Option<Arc<Endpoint>> {",
            "        let n = self.endpoints.len();",
            "        if n == 0 {",
            "            return None;",
            "        }",
            "",
            "        let mut x = self.seed.fetch_add(0x9E37_79B9_7F4A_7C15, Ordering::Relaxed);",
            "        x ^= x >> 12;",
            "        x ^= x << 25;",
            "        x ^= x >> 27;",
            "",
            "        let a = &self.endpoints[(x as usize) % n];",
            "        let b = &self.endpoints[((x >> 32) as usize) % n];",
            "        let winner = if a.load() <= b.load() { a } else { b };",
            "",
            "        winner.inflight.fetch_add(1, Ordering::Relaxed);",
            "        Some(Arc::clone(winner))",
            "    }",
            "}"
          ].join("\n"),
          "tip": "tower ships this already: `tower::balance::p2c::Balance` over a `Discover`, with `PendingRequests` or `PeakEwma` as the load estimator."
        },
        {
          "h": "Health and ejection decide the outcome",
          "p": [
            "An active health check tests an endpoint on a schedule and is the only thing that can remove it before a user request fails. A passive check watches real traffic and ejects on consecutive failures or on latency far above the endpoint's own baseline; that catches the slow-and-wrong endpoint an active check thinks is fine because it answers 200 quickly on /healthz.",
            "Both need a slow start. An endpoint that has just passed a check has an empty connection pool and a cold cache, so sending it a full share immediately makes it fail the next check. Ramp traffic over ten or thirty seconds, and give an ejected endpoint a probe path back in rather than waiting for a human to restart it."
          ],
          "list": [
            "Active checks: fast failure detection, but only prove the health endpoint works",
            "Passive ejection: real signal, but you must bound how much traffic a probe costs",
            "Slow start after admission, or the recovered endpoint fails again immediately",
            "Zone-aware routing, but never so strictly that one zone's failure cannot be absorbed"
          ]
        }
      ],
      "exercise": {
        "prompt": "Finish the P2C picker: return the less loaded of two random endpoints, increment its in-flight counter, and explain how you would use PeakEwma instead when request cost varies by two orders of magnitude.",
        "starter": "use std::sync::atomic::{AtomicU64, Ordering};\nuse std::sync::Arc;\n\npub struct Endpoint {\n    pub inflight: AtomicU64,\n}\n\npub fn pick(endpoints: &[Arc<Endpoint>], seed: u64) -> Option<Arc<Endpoint>> {\n    todo!()\n}",
        "hint": "Derive two indices from the seed with a cheap mix (xorshift or multiply-shift), compare inflight loads, and fetch_add(1) on the winner. With variable request cost, compare an EWMA of latency instead of counts.",
        "solution": "use std::sync::atomic::{AtomicU64, Ordering};\nuse std::sync::Arc;\n\npub struct Endpoint {\n    pub inflight: AtomicU64,\n}\n\npub fn pick(endpoints: &[Arc<Endpoint>], seed: u64) -> Option<Arc<Endpoint>> {\n    let n = endpoints.len();\n    if n == 0 {\n        return None;\n    }\n\n    let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15);\n    x ^= x >> 12;\n    x ^= x << 25;\n    x ^= x >> 27;\n\n    let a = &endpoints[(x as usize) % n];\n    let b = &endpoints[((x >> 32) as usize) % n];\n\n    let winner = if a.inflight.load(Ordering::Relaxed) <= b.inflight.load(Ordering::Relaxed) {\n        a\n    } else {\n        b\n    };\n\n    winner.inflight.fetch_add(1, Ordering::Relaxed);\n    Some(Arc::clone(winner))\n}\n\n// With request costs that vary by 100x, a request count is the wrong signal: one\n// expensive call looks the same as one cheap one. Swap inflight for a decaying\n// EWMA of observed latency and compare that, or let tower's PeakEwma do it."
      },
      "questions": [
        {
          "q": "Why does least-connections need shared state while P2C does not?",
          "options": [
            "P2C compares only two endpoints using each one's own load estimate",
            "P2C ignores load completely",
            "Least-connections only works over UDP",
            "P2C requires a service mesh to function"
          ],
          "answer": 0,
          "explain": "P2C samples two candidates and compares local estimates, so it needs no global view. Least-connections needs an accurate count across every balancer that can reach the endpoint."
        },
        {
          "q": "What does passive outlier ejection use as its signal?",
          "options": [
            "Observed failures and latency on real requests",
            "The DNS TTL of the endpoint",
            "The TCP congestion window",
            "A consistent hash ring"
          ],
          "answer": 0,
          "explain": "Passive ejection watches live traffic: consecutive errors or latency far above the endpoint's baseline take it out of rotation without waiting for an active probe."
        },
        {
          "q": "A balancer hashes the request path to choose a backend. What is the characteristic failure?",
          "options": [
            "A single hot object concentrates load regardless of endpoint capacity",
            "Connections can no longer be pooled",
            "TLS termination stops working",
            "HTTP/2 multiplexing stops working"
          ],
          "answer": 0,
          "explain": "Hashing gives stability, not balance. One popular key sends its whole load to one endpoint while the rest idle, which is why caches need request coalescing and hot-key handling."
        }
      ],
      "quickbytes": [
        "P2C: two random candidates, least loaded wins, no shared state",
        "In-flight counts suit uniform work; EWMA latency suits variable request cost",
        "Eject on passive signals and re-admit with a slow start, or the recovered endpoint fails again",
        "Health checks prove /healthz works, not that the endpoint can serve real traffic"
      ],
      "production": [
        "The load estimator decays, so one long request cannot pin an endpoint out of rotation.",
        "Ejection has a bounded probe budget and an automatic path back into the pool.",
        "Recovered endpoints ramp traffic over 10-30 seconds instead of taking a full share.",
        "Zone-aware routing degrades to cross-zone rather than failing when a zone is lost."
      ],
      "crates": ["tower", "tokio", "tracing"],
      "github": [
        { "name": "tower", "url": "https://github.com/tower-rs/tower" }
      ],
      "pitfall": "Strict zone affinity with no fallback: one zone's balancer failure sends zero traffic to healthy endpoints in the other zone, turning a partial outage into a full one.",
      "resources": [
        { "title": "tower::balance::p2c::Balance", "url": "https://docs.rs/tower/latest/tower/balance/p2c/struct.Balance.html", "kind": "docs" },
        { "title": "tower::load: PendingRequests and PeakEwma estimators", "url": "https://docs.rs/tower/latest/tower/load/index.html", "kind": "docs" },
        { "title": "RepNet: cutting tail latency with flow replication", "url": "https://arxiv.org/abs/1407.1239", "kind": "paper" },
        { "title": "tower repository", "url": "https://github.com/tower-rs/tower", "kind": "repo" }
      ]
    },
    {
      "id": "f12",
      "n": 12,
      "title": "Timeouts and retries that do not cascade",
      "minutes": 80,
      "level": "advanced",
      "goal": "Replace per-call timeouts with a propagating deadline, retry only what is safe, and add jitter and a budget so retries cannot turn an incident into an outage.",
      "sections": [
        {
          "h": "A deadline, not a timeout",
          "p": [
            "A timeout bounds one attempt; a deadline bounds the whole operation, including retries, queueing, and the time spent parsing. If a gateway has 800 ms and has already spent 100 ms, the upstream call gets at most 700 ms, not another 800. gRPC carries this in the grpc-timeout header. HTTP has no standard deadline header, so anything you invent must be documented as yours.",
            "Propagate the remaining budget, never an absolute timestamp: two hosts disagree about the clock, and a deadline computed from a skewed clock is worse than none. On the server side, wrap downstream work in `tokio::time::timeout` with the remaining budget, so a slow dependency cannot silently consume the caller's entire allowance while the handler waits politely."
          ],
          "tip": "Log the budget at entry and the remaining budget at exit; a handler that routinely returns with 5% left is one dependency away from timing out."
        },
        {
          "h": "Retry only what is safe",
          "p": [
            "Retry idempotent methods, connection failures that failed before the request was written, and explicit transient statuses such as 429 and 503. Never retry a POST without an idempotency key, a 400, a 409, or a TLS handshake failure. A timeout is ambiguous: the request may have committed, so retrying it is safe only if the operation is idempotent by construction.",
            "Backoff must be exponential and jittered. Without jitter, every client that failed at the same instant retries at the same instant, and the load arrives in synchronised waves. Full jitter, sleeping a uniform random amount in `[0, base]`, spreads the arrival; decorrelated jitter converges a little better when failures persist. Either is better than a fixed retry interval, which is a self-inflicted thundering herd."
          ],
          "list": [
            "Retry: connect errors before write, 429, 503, and idempotent 5xx",
            "Do not retry: 400, 401, 403, 404, 409, 422, and any TLS or DNS-name failure",
            "Cap attempts and cap total elapsed time; the deadline wins over the attempt count",
            "Jitter every retry, including the first"
          ]
        },
        {
          "h": "Budgets, breakers, and amplification",
          "p": [
            "A retry budget caps retries as a fraction of successful traffic, for example 10%. When the error rate climbs, the budget runs out and retries stop exactly when they would do the most damage. Combined with a circuit breaker that fails fast while the upstream is down, this is the difference between a degraded dependency and a total outage caused by your own clients.",
            "Do the arithmetic before you enable retries. Three attempts means up to three times the load on a service that is already failing, and the extra work is spent on requests that have a high chance of failing again. Hedged requests, sending a second copy after p95 latency, improve the tail but amplify load even more; use them only for idempotent reads with a strict budget."
          ],
          "code": [
            "use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};",
            "use tokio::time::sleep;",
            "",
            "#[derive(Debug)]",
            "pub enum AttemptError {",
            "    Transient,",
            "    Permanent(String),",
            "}",
            "",
            "pub async fn with_retry<F, Fut, T>(budget: Duration, mut call: F) -> Result<T, AttemptError>",
            "where",
            "    F: FnMut() -> Fut,",
            "    Fut: std::future::Future<Output = Result<T, AttemptError>>,",
            "{",
            "    let deadline = Instant::now() + budget;",
            "    let mut attempt: u32 = 0;",
            "",
            "    loop {",
            "        attempt += 1;",
            "        match call().await {",
            "            Ok(value) => return Ok(value),",
            "            Err(AttemptError::Permanent(reason)) => return Err(AttemptError::Permanent(reason)),",
            "            Err(AttemptError::Transient) => {",
            "                // Exponential base, capped, then full jitter: sleep in [0, base].",
            "                let base_ms = 50u64.saturating_mul(1u64 << attempt.min(5));",
            "                let wait = Duration::from_millis(jitter_ms(attempt, base_ms));",
            "",
            "                // Never sleep past the caller's deadline; fail while we still can.",
            "                if Instant::now() + wait >= deadline {",
            "                    return Err(AttemptError::Transient);",
            "                }",
            "                tracing::warn!(attempt, wait_ms = wait.as_millis(), \"retrying\");",
            "                sleep(wait).await;",
            "            }",
            "        }",
            "    }",
            "}",
            "",
            "fn jitter_ms(attempt: u32, base_ms: u64) -> u64 {",
            "    let nanos = SystemTime::now()",
            "        .duration_since(UNIX_EPOCH)",
            "        .map(|d| d.subsec_nanos() as u64)",
            "        .unwrap_or(0);",
            "    // Hash the clock with the attempt: cheap jitter, no RNG dependency.",
            "    let mixed = nanos ^ (attempt as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);",
            "    mixed % (base_ms + 1)",
            "}"
          ].join("\n"),
          "tip": "For a real deployment prefer `rand`'s uniform range over a clock hash; the point here is that jitter must exist and must not be correlated across clients."
        }
      ],
      "exercise": {
        "prompt": "A dependency returns 503 for 30% of requests and the caller has 800 ms. Implement retries that never exceed the budget, cap attempts at three, and explain why removing the cap makes the incident worse.",
        "starter": "use std::time::{Duration, Instant};\n\npub async fn call_with_retries() -> Result<(), String> {\n    let deadline = Instant::now() + Duration::from_millis(800);\n    // 1. loop with an attempt cap\n    // 2. jittered exponential backoff\n    // 3. stop when the remaining budget is too small\n    todo!()\n}",
        "hint": "Check both the attempt count and the remaining budget before sleeping. Every retry multiplies load on a failing dependency, and the extra requests are more likely to fail than the original.",
        "solution": "use std::time::{Duration, Instant};\n\n#[derive(Debug)]\npub enum CallError {\n    Transient,\n    Fatal(String),\n}\n\npub async fn call_with_retries<F, Fut>(budget: Duration, mut call: F) -> Result<(), CallError>\nwhere\n    F: FnMut() -> Fut,\n    Fut: std::future::Future<Output = Result<(), CallError>>,\n{\n    let deadline = Instant::now() + budget;\n    const MAX_ATTEMPTS: u32 = 3;\n\n    for attempt in 1..=MAX_ATTEMPTS {\n        match call().await {\n            Ok(()) => return Ok(()),\n            Err(CallError::Fatal(reason)) => return Err(CallError::Fatal(reason)),\n            Err(CallError::Transient) => {\n                let base = 40u64 << (attempt - 1); // 40, 80, 160 ms\n                let jitter = std::time::SystemTime::now()\n                    .duration_since(std::time::UNIX_EPOCH)\n                    .map(|d| (d.subsec_nanos() as u64) % (base + 1))\n                    .unwrap_or(0);\n                let wait = Duration::from_millis(base + jitter);\n\n                let remaining = deadline.saturating_duration_since(Instant::now());\n                if attempt == MAX_ATTEMPTS || remaining <= wait {\n                    return Err(CallError::Transient);\n                }\n                tokio::time::sleep(wait).await;\n            }\n        }\n    }\n\n    Err(CallError::Transient)\n}\n\n// Removing the cap means a failing dependency receives attempt_count x load for\n// as long as the caller waits, from every client at once. Retries do not create\n// capacity; they spend the capacity that is already exhausted."
      },
      "questions": [
        {
          "q": "Why propagate the remaining time rather than an absolute deadline timestamp?",
          "options": [
            "Clocks on different hosts disagree, so a timestamp can grant too much or too little time",
            "Timestamps are larger on the wire",
            "Absolute deadlines break HTTP/2",
            "Remaining time is easier to log"
          ],
          "answer": 0,
          "explain": "A budget relative to now is immune to skew between hosts; an absolute expiry computed from a skewed clock is wrong by exactly the skew."
        },
        {
          "q": "Which case is unsafe to retry without an idempotency key?",
          "options": [
            "A POST that timed out after the request was written",
            "A connection refused before any byte was sent",
            "A 503 response with Retry-After",
            "A GET that failed with a reset"
          ],
          "answer": 0,
          "explain": "The POST may have committed on the server. A timeout is not proof of failure, so only an idempotent operation or an idempotency key makes the retry safe."
        },
        {
          "q": "What does a retry budget of 10% actually protect?",
          "options": [
            "It caps retry traffic at a fraction of successful traffic so retries cannot dominate during an outage",
            "It limits each request to 10% of its deadline",
            "It reserves 10% of connections for retries",
            "It reduces the timeout to 10% of its configured value"
          ],
          "answer": 0,
          "explain": "When errors rise, successful traffic falls and the budget shrinks with it, so retries stop adding load exactly when the dependency is least able to take it."
        }
      ],
      "quickbytes": [
        "One deadline per request; every hop gets the remaining budget, not a fresh one",
        "Retry idempotent methods and 429/503; never retry 4xx or TLS failures",
        "Full jitter: sleep a uniform random amount in [0, exponential base]",
        "A retry budget of ~10% stops retries from becoming the outage"
      ],
      "production": [
        "Every request carries a deadline that shrinks at each hop and is logged at entry and exit.",
        "Retries are limited to idempotent operations or requests carrying an idempotency key.",
        "A retry budget and a circuit breaker exist, and both are visible on a dashboard.",
        "Attempt counts and time spent retrying are metrics, not just log lines."
      ],
      "crates": ["tower", "tokio", "tracing"],
      "github": [
        { "name": "tower", "url": "https://github.com/tower-rs/tower" }
      ],
      "pitfall": "Three retries on every 5xx with no budget: at a 30% error rate the retry traffic adds up to 90% more requests to a service that is already failing, and the storm keeps it down after the original trigger is gone.",
      "resources": [
        { "title": "tower retry Policy trait", "url": "https://docs.rs/tower/latest/tower/retry/trait.Policy.html", "kind": "docs" },
        { "title": "tower TimeoutLayer", "url": "https://docs.rs/tower/latest/tower/timeout/struct.TimeoutLayer.html", "kind": "docs" },
        { "title": "tower repository", "url": "https://github.com/tower-rs/tower", "kind": "repo" },
        { "title": "RepNet: tail latency under replication", "url": "https://arxiv.org/abs/1407.1239", "kind": "paper" }
      ]
    },
    {
      "id": "f13",
      "n": 13,
      "title": "Keep-alive: the idle-timeout race",
      "minutes": 70,
      "level": "advanced",
      "goal": "Align client pool, server, and load balancer idle timeouts so connection reuse stops producing spurious resets, and handle GOAWAY without losing requests.",
      "sections": [
        {
          "h": "Two keepalives at two layers",
          "p": [
            "TCP keepalive sends probes on an idle connection to detect a dead peer; it is a link-level liveness check with a default idle of 7,200 seconds on Linux. HTTP keep-alive is an application agreement that a connection may carry another request. They solve different problems, and a service can have a healthy TCP connection that no HTTP request should use, which is exactly what the idle-timeout race produces.",
            "HTTP/1.1 keep-alive is the default; the connection closes when either side says `Connection: close` or when an idle timer fires. HTTP/2 has no such header and relies on GOAWAY plus PING for liveness. In both cases the client pool is the component that decides whether a socket is reused, and the server is the component that decides when it is about to disappear."
          ],
          "tip": "A keepalive is not a health check: it proves the peer's kernel is alive, not that its handler can still serve requests."
        },
        {
          "h": "The race, and how to order the timers",
          "p": [
            "Every hop has an idle timeout, and the smallest one wins silently. A classic production setup: the load balancer closes idle connections at 60 seconds, the server at 75, and the client pool keeps sockets for 90. After a quiet minute the client checks out a socket that the balancer has already sent a FIN for, writes a request into it, and gets a reset. The user sees a sporadic 502.",
            "Order the timers so the client gives up first: pool idle below the balancer's idle, which is below the server's idle. Then a reused socket is still open at every hop. If you cannot control all three, add HTTP/2 PINGs or a periodic warm-up request so no connection is ever idle long enough to be reaped, and keep `retry_canceled_requests` enabled for the race you cannot remove."
          ],
          "list": [
            "Client pool idle timeout: the smallest number in the chain",
            "Load balancer idle timeout: larger than the client's, smaller than the server's",
            "Server keep-alive timeout: the largest of the three",
            "HTTP/2: PING while idle plus GOAWAY-aware retry of cancelled requests"
          ],
          "code": [
            "use std::time::Duration;",
            "use hyper_util::client::legacy::connect::HttpConnector;",
            "use hyper_util::client::legacy::Client;",
            "use hyper_util::rt::{TokioExecutor, TokioTimer};",
            "",
            "pub fn client() -> Client<HttpConnector, hyper::body::Incoming> {",
            "    let mut connector = HttpConnector::new();",
            "    connector.set_nodelay(true);",
            "    connector.set_connect_timeout(Some(Duration::from_millis(500)));",
            "",
            "    let mut builder = Client::builder(TokioExecutor::new());",
            "    builder",
            "        // Below the balancer's 60 s idle timeout: the client gives up first.",
            "        .pool_idle_timeout(Duration::from_secs(30))",
            "        .pool_max_idle_per_host(32)",
            "        .pool_timer(TokioTimer::new())",
            "        // Detect a dead peer before a user request does.",
            "        .http2_keep_alive_interval(Some(Duration::from_secs(20)))",
            "        .http2_keep_alive_timeout(Duration::from_secs(5))",
            "        .http2_keep_alive_while_idle(true)",
            "        .timer(TokioTimer::new());",
            "",
            "    builder.build(connector)",
            "}"
          ].join("\n"),
          "tip": "`pool_idle_timeout` does nothing without a timer; hyper's pool needs `pool_timer`, and forgetting it is a silent no-op."
        },
        {
          "h": "GOAWAY, resets, and retrying the race",
          "p": [
            "When a server drains, it sends GOAWAY with the last stream id it will serve. A request sent just before that frame arrives can land above the id and be refused; the client sees a connection error, not a response. That is a safe retry for idempotent requests, and hyper's legacy client replays a request that was never written to the wire when `retry_canceled_requests` is on, which is the default.",
            "The residual failure is a request that was written and processed but whose response was lost when the connection closed. No client can classify that safely, which is why idempotency keys exist. Track connection errors separately from HTTP status codes: a spike in resets during a deploy is a drain problem, while the same spike at steady state is usually the idle-timeout race."
          ]
        }
      ],
      "exercise": {
        "prompt": "A client pools connections for 90 seconds, the load balancer closes idle ones at 60, and p99 shows 0.5% spurious 502s. Choose timeouts that remove the race, configure them on hyper's client, and say what you would do if the balancer's timeout were not configurable.",
        "starter": "use std::time::Duration;\nuse hyper_util::client::legacy::Client;\nuse hyper_util::rt::TokioExecutor;\n\npub fn client() -> Client<hyper_util::client::legacy::connect::HttpConnector, hyper::body::Incoming> {\n    let builder = Client::builder(TokioExecutor::new());\n    // set pool idle timeout, pool timer, and HTTP/2 keep-alive\n    todo!()\n}",
        "hint": "Pool idle 30 s, balancer 60 s, server 75 s. Without control of the balancer, send an HTTP/2 PING every 20 s while idle, or a warm-up request, so connections are never idle at the moment the balancer reaps them.",
        "solution": "use std::time::Duration;\nuse hyper_util::client::legacy::connect::HttpConnector;\nuse hyper_util::client::legacy::Client;\nuse hyper_util::rt::{TokioExecutor, TokioTimer};\n\npub fn client() -> Client<HttpConnector, hyper::body::Incoming> {\n    let mut connector = HttpConnector::new();\n    connector.set_nodelay(true);\n\n    let mut builder = Client::builder(TokioExecutor::new());\n    builder\n        .pool_idle_timeout(Duration::from_secs(30))  // < balancer 60 s < server 75 s\n        .pool_max_idle_per_host(32)\n        .pool_timer(TokioTimer::new())\n        .http2_keep_alive_interval(Some(Duration::from_secs(20)))\n        .http2_keep_alive_timeout(Duration::from_secs(5))\n        .http2_keep_alive_while_idle(true)\n        .timer(TokioTimer::new());\n\n    builder.build(connector)\n}\n\n// If the balancer's idle timeout is fixed, keep connections busy: an HTTP/2 PING\n// every 20 s prevents the idle state entirely. For HTTP/1.1, a lightweight\n// warm-up request on the same interval achieves the same thing at a small cost.\n// Either way, keep retrying cancelled requests and make writes idempotent."
      },
      "questions": [
        {
          "q": "Which ordering of idle timeouts removes the reuse race?",
          "options": [
            "Client pool < load balancer < server",
            "Server < load balancer < client pool",
            "All three equal",
            "Client pool > server > load balancer"
          ],
          "answer": 0,
          "explain": "The client must stop reusing a socket before any hop behind it closes it. If the client's idle timeout is the smallest, a reused socket is still open everywhere."
        },
        {
          "q": "What does hyper's pool_idle_timeout require to take effect?",
          "options": [
            "A timer, supplied with pool_timer",
            "HTTP/2 enabled",
            "A non-zero pool_max_idle_per_host",
            "TLS session resumption"
          ],
          "answer": 0,
          "explain": "The pool needs a timer to expire idle sockets; without `pool_timer` the timeout is silently ignored."
        },
        {
          "q": "A server sends GOAWAY while requests are in flight. What should the client do?",
          "options": [
            "Finish streams at or below the announced id and move new requests to another connection",
            "Retry every stream on the same connection",
            "Send the connection preface again",
            "Ignore it until the socket closes"
          ],
          "answer": 0,
          "explain": "GOAWAY names the last stream the server will process. Streams above that id were not processed and are safe to retry elsewhere if idempotent."
        }
      ],
      "quickbytes": [
        "Client pool idle < balancer idle < server idle, or reuse races forever",
        "TCP keepalive and HTTP keep-alive are unrelated mechanisms",
        "hyper's pool needs pool_timer and an HTTP/2 keep-alive interval to notice dead peers",
        "A connection reset during a deploy is a drain problem, not a client bug"
      ],
      "production": [
        "Idle timeouts are documented per hop and asserted in an integration test that idles a connection.",
        "HTTP/2 connections send PINGs while idle, with a timeout that closes a dead peer.",
        "Connection errors are charted separately from HTTP status codes.",
        "Deploys drain with GOAWAY and a grace period longer than the longest request."
      ],
      "crates": ["hyper-util", "hyper", "tokio"],
      "github": [
        { "name": "hyper-util", "url": "https://github.com/hyperium/hyper-util" },
        { "name": "hyper", "url": "https://github.com/hyperium/hyper" }
      ],
      "pitfall": "Client pool idle of 90 s against a balancer that closes at 60 s: every reuse after a quiet minute writes a request into a socket that received a FIN, and the caller sees a sporadic 502 that no handler code can explain.",
      "resources": [
        { "title": "hyper-util legacy client builder: pool and keep-alive options", "url": "https://docs.rs/hyper-util/latest/hyper_util/client/legacy/struct.Builder.html", "kind": "docs" },
        { "title": "hyper HTTP/2 server connections", "url": "https://docs.rs/hyper/latest/hyper/server/conn/http2/struct.Builder.html", "kind": "docs" },
        { "title": "Sharding and HTTP/2 connection reuse revisited", "url": "https://arxiv.org/abs/2110.14239", "kind": "paper" },
        { "title": "hyper repository", "url": "https://github.com/hyperium/hyper", "kind": "repo" }
      ]
    },
    {
      "id": "f14",
      "n": 14,
      "title": "WebSockets: upgrade, frames, and slow clients",
      "minutes": 85,
      "level": "advanced",
      "goal": "Implement the WebSocket handshake and frame protocol correctly, bound per-connection buffering, and keep long-lived sockets alive through proxies that idle them out.",
      "sections": [
        {
          "h": "The upgrade is an HTTP request",
          "p": [
            "A WebSocket starts as an HTTP/1.1 request with `Upgrade: websocket`, `Connection: Upgrade`, a base64 `Sec-WebSocket-Key`, and a version. The server answers 101 with `Sec-WebSocket-Accept`, the SHA-1 of the key concatenated with a fixed GUID, and from then on the connection is frames. Any proxy in the path must forward Upgrade and must not buffer the 101 response.",
            "Two details break implementations. The handshake requires HTTP/1.1, so an HTTP/2-only proxy cannot pass it through without the extended CONNECT mechanism, which many intermediaries still lack. And the `Sec-WebSocket-Protocol` header negotiates a subprotocol; a server that answers with a protocol the client did not offer must fail the handshake rather than pick one anyway."
          ],
          "tip": "A 200 response to an upgrade request usually means a proxy consumed the Upgrade header; check the hop, not the client library."
        },
        {
          "h": "Frames, masking, and control frames",
          "p": [
            "Every frame has a 2-byte header: FIN and opcode, a mask bit and a 7-bit length that extends to 16 or 64 bits. The opcode says text, binary, continuation, close, ping, or pong. Client-to-server frames must be masked with a per-frame key, and a server that accepts unmasked client frames is violating the specification in a way scanners notice.",
            "Control frames are limited to 125 bytes and cannot be fragmented. A ping must be answered with a pong carrying the same payload, and a close frame carries a status code: 1000 normal, 1001 going away, 1002 protocol error, 1009 message too big, 1011 internal error. After sending a close, the peer must not send more data frames, and the connection closes on the TCP level."
          ],
          "list": [
            "Text frames must be valid UTF-8; invalid UTF-8 is a 1007 close, not a lenient decode",
            "Fragmentation is legal: a message is a sequence starting with text or binary and ending at FIN",
            "permessage-deflate is negotiated per connection and costs CPU per message; measure before enabling",
            "A close handshake is two frames: you send Close, the peer echoes it, then the socket closes"
          ]
        },
        {
          "h": "Slow clients and dead peers",
          "p": [
            "A WebSocket has no request/response boundary, so nothing provides backpressure for you. If the application writes into an unbounded queue, a slow client turns into unbounded memory and eventually takes the process down. Bound the outbound queue per connection, and when it fills, decide explicitly: drop the connection, drop the message, or coalesce to the latest state.",
            "Proxies and load balancers idle out silent connections, often at 60 seconds, which is shorter than the gap between events in many applications. Send a ping every 20 or 30 seconds and treat a missing pong, or a failed write, as a dead peer. On shutdown, send a close frame with 1001 and give the client a moment to reconnect elsewhere instead of disappearing."
          ],
          "code": [
            "use futures_util::{SinkExt, StreamExt};",
            "use tokio::net::TcpStream;",
            "use tokio_tungstenite::tungstenite::protocol::{Message, WebSocketConfig};",
            "",
            "pub async fn serve(stream: TcpStream) -> Result<(), Box<dyn std::error::Error>> {",
            "    let config = WebSocketConfig::default()",
            "        .max_message_size(Some(1 << 20)) // 1 MiB per message, not 64 MiB",
            "        .max_frame_size(Some(256 * 1024));",
            "",
            "    let ws = tokio_tungstenite::accept_async_with_config(stream, Some(config)).await?;",
            "    let (mut sink, mut source) = ws.split();",
            "",
            "    let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(20));",
            "    loop {",
            "        tokio::select! {",
            "            _ = heartbeat.tick() => {",
            "                // Keeps proxies from idling the connection out.",
            "                sink.send(Message::Ping(Default::default())).await?;",
            "            }",
            "            incoming = source.next() => match incoming {",
            "                Some(Ok(Message::Text(text))) => sink.send(Message::Text(text)).await?,",
            "                Some(Ok(Message::Close(_))) | None => break,",
            "                Some(Ok(_)) => {} // pong, binary, or a ping the codec already answered",
            "                Some(Err(err)) => return Err(err.into()),",
            "            },",
            "        }",
            "    }",
            "",
            "    Ok(())",
            "}"
          ].join("\n"),
          "tip": "The default tungstenite message limit is 64 MiB; lower it per endpoint, because a message limit is the only thing standing between a client and your allocator."
        }
      ],
      "exercise": {
        "prompt": "Write an echo server that caps messages at 1 MiB, sends a ping every 20 seconds, closes cleanly on a client close frame, and explains where backpressure has to come from.",
        "starter": "use futures_util::{SinkExt, StreamExt};\nuse tokio::net::TcpStream;\nuse tokio_tungstenite::tungstenite::protocol::{Message, WebSocketConfig};\n\npub async fn serve(stream: TcpStream) -> Result<(), Box<dyn std::error::Error>> {\n    // accept with a config, split, select on heartbeat and incoming frames\n    todo!()\n}",
        "hint": "Use accept_async_with_config, split the stream, and select between an interval tick and source.next(). There is no built-in backpressure: bound your own outbound queue or the socket buffer becomes your memory limit.",
        "solution": "use futures_util::{SinkExt, StreamExt};\nuse tokio::net::TcpStream;\nuse tokio_tungstenite::tungstenite::protocol::{Message, WebSocketConfig};\n\npub async fn serve(stream: TcpStream) -> Result<(), Box<dyn std::error::Error>> {\n    let config = WebSocketConfig::default()\n        .max_message_size(Some(1 << 20))\n        .max_frame_size(Some(256 * 1024));\n\n    let ws = tokio_tungstenite::accept_async_with_config(stream, Some(config)).await?;\n    let (mut sink, mut source) = ws.split();\n\n    let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(20));\n    loop {\n        tokio::select! {\n            _ = heartbeat.tick() => {\n                sink.send(Message::Ping(Default::default())).await?;\n            }\n            incoming = source.next() => match incoming {\n                Some(Ok(Message::Text(text))) => sink.send(Message::Text(text)).await?,\n                Some(Ok(Message::Close(_))) | None => break,\n                Some(Ok(_)) => {}\n                Some(Err(err)) => return Err(err.into()),\n            },\n        }\n    }\n\n    Ok(())\n}\n\n// Backpressure: `sink.send()` awaits when the socket is full, so a slow client\n// slows this task rather than growing memory. If a producer task feeds this\n// connection, give it a bounded mpsc and drop or coalesce when it is full."
      },
      "questions": [
        {
          "q": "What does the server prove by returning Sec-WebSocket-Accept?",
          "options": [
            "That it read the client's Sec-WebSocket-Key, by hashing it with a fixed GUID",
            "That it shares the client's TLS session",
            "That the client is authenticated",
            "That the connection is encrypted"
          ],
          "answer": 0,
          "explain": "The accept value is SHA-1 of the client key plus the RFC 6455 GUID, base64 encoded. It proves the server understood the upgrade, not that the client is trusted."
        },
        {
          "q": "Which frame is illegal from a client to a server?",
          "options": [
            "An unmasked data frame",
            "A fragmented text message",
            "A ping with a 16-byte payload",
            "A close frame with code 1001"
          ],
          "answer": 0,
          "explain": "Client frames must be masked with a per-frame key. Accepting unmasked frames violates RFC 6455 and is a common scanner finding."
        },
        {
          "q": "A WebSocket connection dies silently after about a minute of inactivity behind a load balancer. What is the fix?",
          "options": [
            "Send periodic ping frames so the connection is never idle",
            "Increase the TLS session timeout",
            "Disable Nagle on the client",
            "Use HTTP/1.1 pipelining"
          ],
          "answer": 0,
          "explain": "Intermediaries close idle connections on their own timers. Pings every 20-30 seconds keep traffic flowing and also detect a peer that has gone away."
        }
      ],
      "quickbytes": [
        "The handshake is HTTP/1.1 Upgrade; a 200 means a proxy ate the header",
        "Client frames must be masked; control frames are capped at 125 bytes",
        "Close codes: 1000 normal, 1001 going away, 1009 too big, 1011 internal error",
        "Ping every 20 s or the load balancer will idle you out"
      ],
      "production": [
        "max_message_size and max_frame_size are set explicitly per endpoint.",
        "Each connection has a bounded outbound queue with a documented overflow policy.",
        "Pings run on a timer and a missed pong terminates the connection.",
        "Shutdown sends close 1001 so clients reconnect instead of retrying blindly."
      ],
      "crates": ["tokio-tungstenite", "tungstenite", "tokio", "futures-util"],
      "github": [
        { "name": "tokio-tungstenite", "url": "https://github.com/snapview/tokio-tungstenite" }
      ],
      "pitfall": "Unbounded per-connection send queues: one client on a bad mobile link stops reading, the queue grows until the process is killed, and the same heap pressure degrades every other connection first.",
      "resources": [
        { "title": "tokio-tungstenite: async handshake and streams", "url": "https://docs.rs/tokio-tungstenite/latest/tokio_tungstenite/", "kind": "docs" },
        { "title": "MDN: the WebSockets API", "url": "https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API", "kind": "docs" },
        { "title": "tungstenite WebSocketConfig limits", "url": "https://docs.rs/tungstenite/latest/tungstenite/protocol/struct.WebSocketConfig.html", "kind": "docs" },
        { "title": "tokio-tungstenite repository", "url": "https://github.com/snapview/tokio-tungstenite", "kind": "repo" }
      ]
    },
    {
      "id": "f15",
      "n": 15,
      "title": "gRPC internals: five bytes and a trailer",
      "minutes": 90,
      "level": "industry",
      "goal": "Read a gRPC call at the HTTP/2 level: the length-prefixed message format, trailers that carry status, deadline encoding, and why half the proxies in your path break it.",
      "sections": [
        {
          "h": "gRPC is HTTP/2 with conventions",
          "p": [
            "A gRPC call is an HTTP/2 request with `content-type: application/grpc`, a `TE: trailers` header, and a body made of length-prefixed messages. Each message is one byte of compression flag followed by a 4-byte big-endian length and the protobuf payload. Streaming is just several of those frames on one stream, in order, with no envelope in between and no `Content-Length` on the request.",
            "The status does not live in the HTTP status line. gRPC returns HTTP 200 for a call that failed and puts `grpc-status` and `grpc-message` in the trailers after the last message, because HTTP/2 trailers can change a status after the server has already started streaming. A proxy that drops trailers turns every application error into a successful empty response, which is the single most common way to break gRPC in transit."
          ],
          "tip": "If a gRPC call succeeds but returns nothing, check for trailers first: the error is usually in grpc-status, which the caller never saw."
        },
        {
          "h": "Framing, encoding, and deadlines",
          "p": [
            "The compression flag is 0 for an uncompressed message and 1 when the message is compressed with the algorithm named in `grpc-encoding`. A receiver that sees 1 without having negotiated that encoding must fail the call rather than guess. The length is the compressed length, so decompressing before checking the size limit is how a small frame becomes a large allocation.",
            "Deadlines travel in `grpc-timeout`, a value like `100m` or `2S`: digits followed by H, M, S, m, u, or n. The server converts it to a local deadline and returns status 4 (DEADLINE_EXCEEDED) when it expires, which is not the same as a client-side cancellation (status 1). Metadata is HTTP/2 headers with lower-case names; keys ending in `-bin` carry base64-encoded binary values."
          ],
          "list": [
            "0 OK, 1 CANCELLED, 3 INVALID_ARGUMENT, 4 DEADLINE_EXCEEDED, 5 NOT_FOUND, 8 RESOURCE_EXHAUSTED, 14 UNAVAILABLE",
            "Retry 14 and 4 only when the call is idempotent and budget remains",
            "Never retry 3, 5, 6, 7, or 9: they are deterministic answers",
            "Trailers arrive after the last DATA frame; a client that stops reading loses the status"
          ],
          "code": [
            "/// gRPC message framing: 1 byte compressed flag + 4 byte big-endian length.",
            "pub fn encode(payload: &[u8]) -> Vec<u8> {",
            "    let mut out = Vec::with_capacity(5 + payload.len());",
            "    out.push(0); // 0 = not compressed",
            "    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());",
            "    out.extend_from_slice(payload);",
            "    out",
            "}",
            "",
            "#[derive(Debug, PartialEq)]",
            "pub enum FrameError {",
            "    UnsupportedCompression(u8),",
            "    TooLarge(usize),",
            "}",
            "",
            "/// Returns the message plus the number of bytes consumed, or None if incomplete.",
            "pub fn decode(buf: &[u8]) -> Result<Option<(&[u8], usize)>, FrameError> {",
            "    if buf.len() < 5 {",
            "        return Ok(None);",
            "    }",
            "    let flag = buf[0];",
            "    if flag != 0 {",
            "        return Err(FrameError::UnsupportedCompression(flag));",
            "    }",
            "    let len = u32::from_be_bytes([buf[1], buf[2], buf[3], buf[4]]) as usize;",
            "    if len > 4 * 1024 * 1024 {",
            "        return Err(FrameError::TooLarge(len)); // check before allocating",
            "    }",
            "    if buf.len() < 5 + len {",
            "        return Ok(None);",
            "    }",
            "    Ok(Some((&buf[5..5 + len], 5 + len)))",
            "}",
            "",
            "#[cfg(test)]",
            "mod tests {",
            "    use super::*;",
            "",
            "    #[test]",
            "    fn round_trips_one_message() {",
            "        let framed = encode(b\"hello\");",
            "        assert_eq!(framed[..5], [0, 0, 0, 0, 5]);",
            "        assert_eq!(decode(&framed).unwrap(), Some((&b\"hello\"[..], 10)));",
            "    }",
            "}"
          ].join("\n"),
          "tip": "A length prefix is not a size limit: validate the announced length against a maximum before you reserve a buffer for it."
        },
        {
          "h": "Why proxies break gRPC",
          "p": [
            "An HTTP/1.1 hop cannot carry gRPC: there are no trailers in the general case, and a proxy that converts HTTP/2 to HTTP/1.1 has nowhere to put grpc-status. End-to-end HTTP/2 is a requirement, not a performance preference. A proxy that buffers the whole response to compute a length also destroys streaming, because the client waits for a message that the server is holding.",
            "Timeouts need care at the proxy too. If the proxy applies its own 30-second deadline while the client sent `grpc-timeout: 5S`, the client sees UNAVAILABLE from a cancellation rather than the DEADLINE_EXCEEDED it asked for. Forward the header, subtract the time spent queueing, and let the server own the deadline it was given."
          ]
        }
      ],
      "exercise": {
        "prompt": "Implement gRPC message framing with a maximum size check, and write a test that decodes two messages back to back from one buffer. Then explain what a proxy must preserve for the call to succeed.",
        "starter": "pub fn encode(payload: &[u8]) -> Vec<u8> {\n    todo!()\n}\n\npub fn decode(buf: &[u8]) -> Result<Option<(&[u8], usize)>, FrameError> {\n    todo!()\n}",
        "hint": "Five header bytes, big-endian length, then the payload. Return the consumed length so the caller can loop. Check the length against a maximum before slicing or reserving.",
        "solution": "pub fn encode(payload: &[u8]) -> Vec<u8> {\n    let mut out = Vec::with_capacity(5 + payload.len());\n    out.push(0);\n    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());\n    out.extend_from_slice(payload);\n    out\n}\n\n#[derive(Debug, PartialEq)]\npub enum FrameError {\n    UnsupportedCompression(u8),\n    TooLarge(usize),\n}\n\npub fn decode(buf: &[u8]) -> Result<Option<(&[u8], usize)>, FrameError> {\n    if buf.len() < 5 {\n        return Ok(None);\n    }\n    let flag = buf[0];\n    if flag != 0 {\n        return Err(FrameError::UnsupportedCompression(flag));\n    }\n    let len = u32::from_be_bytes([buf[1], buf[2], buf[3], buf[4]]) as usize;\n    if len > 4 * 1024 * 1024 {\n        return Err(FrameError::TooLarge(len));\n    }\n    if buf.len() < 5 + len {\n        return Ok(None);\n    }\n    Ok(Some((&buf[5..5 + len], 5 + len)))\n}\n\nfn decode_all(mut buf: &[u8]) -> Result<Vec<&[u8]>, FrameError> {\n    let mut out = Vec::new();\n    while let Some((message, consumed)) = decode(buf)? {\n        out.push(message);\n        buf = &buf[consumed..];\n    }\n    Ok(out)\n}\n\n// A proxy must keep HTTP/2 end to end, forward trailers, avoid buffering the\n// response, and pass grpc-timeout through with the remaining budget. Losing any\n// one of those turns a working call into an empty success or a wrong status."
      },
      "questions": [
        {
          "q": "Where does gRPC put the status of a call?",
          "options": [
            "In the HTTP/2 trailers as grpc-status and grpc-message",
            "In the HTTP status line",
            "In a Content-Length header",
            "In the first message of the stream"
          ],
          "answer": 0,
          "explain": "The HTTP status is 200 even for a failed call. The real outcome arrives in trailers, which is why a proxy that drops them is so destructive."
        },
        {
          "q": "What are the five bytes before every gRPC message?",
          "options": [
            "A compression flag and a 4-byte big-endian length",
            "A 4-byte magic number and a version",
            "A checksum and a message type",
            "A stream identifier and flags"
          ],
          "answer": 0,
          "explain": "Bit 0 is the compressed flag, the next four bytes are the big-endian length of the (possibly compressed) payload."
        },
        {
          "q": "Why does an HTTP/1.1 proxy break gRPC?",
          "options": [
            "HTTP/1.1 has no general trailer mechanism, so grpc-status has nowhere to go",
            "HTTP/1.1 cannot carry binary bodies",
            "HTTP/1.1 forbids the POST method",
            "HTTP/1.1 has no headers"
          ],
          "answer": 0,
          "explain": "Trailers after a streamed body are the only place gRPC can report status. Converting to HTTP/1.1 either buffers and loses them or drops them."
        }
      ],
      "quickbytes": [
        "gRPC message = 1 byte flag + 4 byte big-endian length + payload",
        "HTTP status is 200 even when the call fails; grpc-status lives in trailers",
        "grpc-timeout is digits plus a unit: 100m, 2S, 500u",
        "End-to-end HTTP/2 is required; a 1.1 hop cannot carry trailers"
      ],
      "production": [
        "The maximum decoded message size is set explicitly on client and server.",
        "Proxies are verified to forward trailers, with an integration test that triggers a non-OK status.",
        "Deadlines are forwarded as remaining budget, and the proxy does not impose a shorter one.",
        "Compression is negotiated and never assumed from the flag alone."
      ],
      "crates": ["h2", "tonic", "prost", "bytes"],
      "github": [
        { "name": "h2", "url": "https://github.com/hyperium/h2" }
      ],
      "pitfall": "A proxy that terminates HTTP/2 and re-encodes as HTTP/1.1: every gRPC error becomes a 200 with an empty body, so clients retry successful calls and never see the real status.",
      "resources": [
        { "title": "gRPC core concepts: streams, metadata, status codes", "url": "https://grpc.io/docs/what-is-grpc/core-concepts/", "kind": "docs" },
        { "title": "h2: the HTTP/2 implementation underneath tonic", "url": "https://docs.rs/h2/latest/h2/", "kind": "docs" },
        { "title": "hyper repository", "url": "https://github.com/hyperium/hyper", "kind": "repo" }
      ]
    },
    {
      "id": "f16",
      "n": 16,
      "title": "Backpressure: the queue is the outage",
      "minutes": 75,
      "level": "industry",
      "goal": "Bound concurrency and queue depth with numbers, shed load explicitly when the bound is hit, and propagate backpressure to the client instead of buffering.",
      "sections": [
        {
          "h": "Queues convert overload into latency",
          "p": [
            "Little's law says the average number in the system equals arrival rate times time in system: 2,000 requests per second at 50 ms each is 100 concurrent requests. That number is your concurrency budget, not a guess. Queueing delay then grows non-linearly as utilisation approaches one, so a service at 90% utilisation waits roughly ten times longer than an idle one for the same work.",
            "An unbounded queue does not absorb load; it stores it until something runs out. Requests sit in the queue past their deadline, get retried by clients that have given up, and add more arrivals to a queue that is already too long. The operator sees high latency and low CPU, which looks like a code problem and is actually a capacity decision made by omission."
          ],
          "tip": "A queue depth metric that only grows during an incident is not a queue, it is a memory leak with a schedule."
        },
        {
          "h": "Three knobs: concurrency, depth, shedding",
          "p": [
            "Concurrency is the number of tasks allowed to work at once; queue depth is how many may wait; shedding is what happens to the rest. Pick all three deliberately. A semaphore with `try_acquire` gives you the shedding decision for free, and returning 503 with `Retry-After` tells the client to come back rather than to hammer you immediately.",
            "Shedding is a feature, not a failure. A service that rejects 5% of requests in 2 ms keeps its p99 at 50 ms and stays up; a service that accepts everything has a p99 that grows until clients time out and retry, which doubles the arrival rate at the worst possible moment. Rate limiting and load shedding are the same mechanism applied at different scopes."
          ],
          "list": [
            "Concurrency limit: semaphore sized from Little's law, not from a round number",
            "Queue depth: bounded, and shorter than the request deadline",
            "Shed: 503 with Retry-After, logged and counted as a metric",
            "Per-tenant limits: one noisy customer must not consume the shared budget"
          ],
          "code": [
            "use std::sync::Arc;",
            "use hyper::{Response, StatusCode};",
            "use tokio::sync::Semaphore;",
            "",
            "pub struct Limiter {",
            "    permits: Arc<Semaphore>,",
            "}",
            "",
            "impl Limiter {",
            "    pub fn new(max_concurrent: usize) -> Self {",
            "        Self { permits: Arc::new(Semaphore::new(max_concurrent)) }",
            "    }",
            "",
            "    pub async fn run<F, T>(&self, work: F) -> Result<T, Response<&'static str>>",
            "    where",
            "        F: std::future::Future<Output = T>,",
            "    {",
            "        // try_acquire, not acquire: waiting is what turns overload into latency.",
            "        let permit = match self.permits.clone().try_acquire_owned() {",
            "            Ok(permit) => permit,",
            "            Err(_) => {",
            "                return Err(Response::builder()",
            "                    .status(StatusCode::SERVICE_UNAVAILABLE)",
            "                    .header(\"retry-after\", \"1\")",
            "                    .body(\"overloaded\")",
            "                    .expect(\"static response builds\"));",
            "            }",
            "        };",
            "",
            "        let result = work.await;",
            "        drop(permit);",
            "        Ok(result)",
            "    }",
            "}",
            "",
            "// If a short wait is acceptable, acquire with a timeout shorter than the",
            "// request deadline: tokio::time::timeout(Duration::from_millis(20), sem.acquire())"
          ].join("\n"),
          "tip": "Make the queue shorter than the deadline. A request that waits 900 ms in a queue for an 800 ms budget has already failed; rejecting it in 2 ms frees the slot."
        },
        {
          "h": "Backpressure has to reach the reader",
          "p": [
            "Concurrency limits only help if the work stops reading more input when it cannot process it. A handler that reads a whole request body into memory before checking limits has already lost. Stream the body, and let `poll_ready` or an awaited send be the signal that the downstream is full, instead of spawning a task per chunk into an unbounded channel.",
            "HTTP/2 flow control gives you a protocol-level version of the same idea: a server that never sends WINDOW_UPDATE stops the client from sending, which is correct backpressure as long as your application also stops reading. A proxy that reads eagerly and buffers is a proxy that converts a slow upstream into its own memory problem."
          ]
        }
      ],
      "exercise": {
        "prompt": "Add admission control to a handler: at most 64 concurrent requests, a 20 ms wait for a slot, and a 503 with Retry-After when the slot does not arrive. Explain why try_acquire is preferable to acquire for a request path.",
        "starter": "use std::sync::Arc;\nuse tokio::sync::Semaphore;\n\npub struct Limiter {\n    permits: Arc<Semaphore>,\n}\n\nimpl Limiter {\n    pub async fn run<T>(&self, work: impl std::future::Future<Output = T>) -> Result<T, ()> {\n        todo!()\n    }\n}",
        "hint": "Wrap acquire in tokio::time::timeout with 20 ms; map both the timeout and a closed semaphore to an overload response. Waiting longer than the deadline only converts a fast failure into a slow one.",
        "solution": "use std::sync::Arc;\nuse std::time::Duration;\nuse tokio::sync::Semaphore;\n\npub struct Limiter {\n    permits: Arc<Semaphore>,\n}\n\nimpl Limiter {\n    pub fn new(max: usize) -> Self {\n        Self { permits: Arc::new(Semaphore::new(max)) }\n    }\n\n    pub async fn run<F, T>(&self, work: F) -> Result<T, &'static str>\n    where\n        F: std::future::Future<Output = T>,\n    {\n        let permit = tokio::time::timeout(\n            Duration::from_millis(20),\n            self.permits.clone().acquire_owned(),\n        )\n        .await\n        .map_err(|_| \"overloaded\")? // waited too long: shed now\n        .map_err(|_| \"closed\")?;\n\n        let result = work.await;\n        drop(permit);\n        Ok(result)\n    }\n}\n\n// try_acquire never queues at all, which is right when the queue is already the\n// problem. A 20 ms timeout is the compromise: it absorbs a momentary burst but\n// cannot turn into a second, slower queue behind the semaphore."
      },
      "questions": [
        {
          "q": "A service handles 2,000 requests per second at 50 ms each. What concurrency does Little's law predict?",
          "options": ["100", "40", "1,000", "2,000"],
          "answer": 0,
          "explain": "L = arrival rate x time in system = 2,000 x 0.05 s = 100 concurrent requests. That is the concurrency budget to size limits against."
        },
        {
          "q": "Why is an unbounded request queue harmful?",
          "options": [
            "Requests wait past their deadlines while memory grows, and clients retry into the same queue",
            "It uses more CPU than a bounded queue",
            "It prevents the runtime from scheduling tasks",
            "It disables HTTP/2 flow control"
          ],
          "answer": 0,
          "explain": "The queue stores work that can no longer succeed. Latency rises, deadlines expire, and retries add arrivals, which is the classic metastable failure."
        },
        {
          "q": "What does returning 503 with Retry-After accomplish?",
          "options": [
            "It fails fast and tells the client when to come back, instead of holding a doomed request",
            "It silently drops the request",
            "It upgrades the client to HTTP/2",
            "It retries the request internally"
          ],
          "answer": 0,
          "explain": "Fast rejection frees the slot for work that can finish, and Retry-After prevents every client from retrying immediately in lockstep."
        }
      ],
      "quickbytes": [
        "L = lambda x W: 2,000 rps at 50 ms means 100 in flight",
        "Keep queue depth below the request deadline, or the queue is just a slow failure",
        "try_acquire sheds immediately; a 20 ms timeout absorbs bursts without becoming a queue",
        "A queue that only grows during an incident is a memory leak with a schedule"
      ],
      "production": [
        "Concurrency limits are derived from measured arrival rate and latency, then load-tested.",
        "Overload responses are 503 with Retry-After and are counted as a metric.",
        "Per-tenant limits prevent one customer from consuming the shared budget.",
        "Request bodies are streamed, so a handler never buffers more than it can process."
      ],
      "crates": ["tower", "tokio", "metrics"],
      "github": [
        { "name": "tower", "url": "https://github.com/tower-rs/tower" }
      ],
      "pitfall": "A request queue with no deadline: during an incident every request waits for a slot it will never get, memory climbs with the queue, and the process dies while CPU sits at 10%.",
      "resources": [
        { "title": "tower::limit: concurrency and rate limiting layers", "url": "https://docs.rs/tower/latest/tower/limit/", "kind": "docs" },
        { "title": "tower::load_shed: fail fast when the service is not ready", "url": "https://docs.rs/tower/latest/tower/load_shed/struct.LoadShedLayer.html", "kind": "docs" },
        { "title": "MDN: 503 Service Unavailable and Retry-After", "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/503", "kind": "docs" },
        { "title": "tower repository", "url": "https://github.com/tower-rs/tower", "kind": "repo" }
      ]
    },
    {
      "id": "f17",
      "n": 17,
      "title": "Framing: turning bytes into messages",
      "minutes": 80,
      "level": "industry",
      "goal": "Choose a framing scheme, decode it without trusting the length field, and use tokio-util codecs to keep the buffer management in one place.",
      "sections": [
        {
          "h": "A byte stream has no messages",
          "p": [
            "TCP delivers bytes, not writes: one `write` can arrive as three reads, and three writes can arrive as one. A protocol has to define where messages end. Length-prefixed framing puts a fixed-width length before each message; delimiter framing scans for a byte or sequence; fixed-size framing works for telemetry records. HTTP/1.1 chunked encoding is a length prefix in hex with CRLF delimiters, and QUIC uses a variable-length integer for the same job.",
            "Length-prefixed is the easiest to decode and the easiest to attack, because the decoder reads a number the peer chose. Delimiter framing needs an escaping rule or it breaks on payloads that contain the delimiter, and scanning for a delimiter across a buffer is where quadratic behaviour hides. Fixed-size is trivial until the record needs a variable field."
          ],
          "list": [
            "Length prefix: O(1) decode, must cap the announced length before allocating",
            "Delimiter: needs escaping, and scanning must be bounded per buffer",
            "Fixed size: simplest, but one schema change rewrites the protocol",
            "Version the framing scheme in the first bytes, or you cannot migrate it later"
          ],
          "tip": "If your decoder allocates `Vec::with_capacity(len)` from a length the peer sent, you have written a remote memory-exhaustion bug."
        },
        {
          "h": "Decode incrementally",
          "p": [
            "A decoder is a state machine over a growing buffer: if there are not enough bytes for a header, return `Ok(None)` and ask for more; once the length is known, check it against a maximum, then wait for the whole message. Returning `None` is not an error, and a decoder that treats a partial read as a failure will drop valid traffic under load when reads split differently.",
            "Copy as little as possible. `BytesMut::split_to` hands you an owned slice of the existing buffer without copying the payload, and the remaining buffer keeps its capacity for the next frame. Reserving capacity for the exact frame you are waiting for avoids repeated reallocation, but only after you have validated the length."
          ]
        },
        {
          "h": "Codecs keep the state in one place",
          "p": [
            "tokio-util's `Decoder` and `Encoder` traits separate framing from I/O, and `Framed` combines them so the read loop is a stream of messages. That matters for testability: you can unit-test a decoder against byte slices with no socket, including the nasty cases where a frame header is split across two reads.",
            "The built-in `LengthDelimitedCodec` already implements the common case, including `max_frame_length`, so use it unless the wire format is genuinely not a u32-prefixed frame. When you do write your own, keep the `max_frame_length` equivalent as a constant with a comment explaining the largest legitimate message, because the next person will need to change it."
          ],
          "code": [
            "use bytes::{Buf, BytesMut};",
            "use tokio_util::codec::Decoder;",
            "",
            "const MAX_FRAME: usize = 1 << 20; // 1 MiB: largest legitimate message",
            "",
            "pub struct LengthPrefixed;",
            "",
            "impl Decoder for LengthPrefixed {",
            "    type Item = BytesMut;",
            "    type Error = std::io::Error;",
            "",
            "    fn decode(&mut self, src: &mut BytesMut) -> Result<Option<Self::Item>, Self::Error> {",
            "        if src.len() < 4 {",
            "            src.reserve(4 - src.len());",
            "            return Ok(None); // need more bytes, not an error",
            "        }",
            "",
            "        let len = u32::from_be_bytes([src[0], src[1], src[2], src[3]]) as usize;",
            "        if len > MAX_FRAME {",
            "            return Err(std::io::Error::new(",
            "                std::io::ErrorKind::InvalidData,",
            "                format!(\"frame of {len} bytes exceeds {MAX_FRAME}\"),",
            "            ));",
            "        }",
            "",
            "        if src.len() < 4 + len {",
            "            src.reserve(4 + len - src.len()); // validated, so safe to reserve",
            "            return Ok(None);",
            "        }",
            "",
            "        src.advance(4);",
            "        Ok(Some(src.split_to(len)))",
            "    }",
            "}"
          ].join("\n"),
          "tip": "Test the decoder with a frame header split across two reads; that case is where most hand-written decoders fail."
        }
      ],
      "exercise": {
        "prompt": "Write a Decoder for a 4-byte big-endian length prefix that rejects frames over 1 MiB, waits for complete data, and yields the payload without copying it. Then describe what happens when the header itself is split across two reads.",
        "starter": "use bytes::BytesMut;\nuse tokio_util::codec::Decoder;\n\npub struct LengthPrefixed;\n\nimpl Decoder for LengthPrefixed {\n    type Item = BytesMut;\n    type Error = std::io::Error;\n\n    fn decode(&mut self, src: &mut BytesMut) -> Result<Option<Self::Item>, Self::Error> {\n        todo!()\n    }\n}",
        "hint": "Return Ok(None) when fewer than 4 bytes are buffered. After reading the length, compare with the cap, then return Ok(None) until 4 + len bytes are present. Advance past the prefix and split_to(len).",
        "solution": "use bytes::{Buf, BytesMut};\nuse tokio_util::codec::Decoder;\n\nconst MAX_FRAME: usize = 1 << 20;\n\npub struct LengthPrefixed;\n\nimpl Decoder for LengthPrefixed {\n    type Item = BytesMut;\n    type Error = std::io::Error;\n\n    fn decode(&mut self, src: &mut BytesMut) -> Result<Option<Self::Item>, Self::Error> {\n        if src.len() < 4 {\n            src.reserve(4 - src.len());\n            return Ok(None);\n        }\n\n        let len = u32::from_be_bytes([src[0], src[1], src[2], src[3]]) as usize;\n        if len > MAX_FRAME {\n            return Err(std::io::Error::new(\n                std::io::ErrorKind::InvalidData,\n                format!(\"frame of {len} bytes exceeds {MAX_FRAME}\"),\n            ));\n        }\n\n        if src.len() < 4 + len {\n            src.reserve(4 + len - src.len());\n            return Ok(None);\n        }\n\n        src.advance(4);\n        Ok(Some(src.split_to(len)))\n    }\n}\n\n// A split header is the normal case, not the edge: the first read may deliver one\n// or two bytes. The decoder returns Ok(None), Framed reads again, and decode is\n// called with a longer buffer. Returning an error on a partial read is the bug."
      },
      "questions": [
        {
          "q": "What must a length-prefixed decoder check before reserving a buffer for the payload?",
          "options": [
            "That the announced length is within a configured maximum",
            "That the payload is valid UTF-8",
            "That the peer negotiated compression",
            "That the frame count is below 65,535"
          ],
          "answer": 0,
          "explain": "The length comes from the peer. Checking it against a maximum before allocating is the difference between a decoder and a remote memory-exhaustion primitive."
        },
        {
          "q": "What should a Decoder return when the buffer holds only half a frame?",
          "options": [
            "Ok(None), so the caller reads more bytes",
            "An InvalidData error",
            "The partial frame as an item",
            "Ok(Some(empty))"
          ],
          "answer": 0,
          "explain": "Partial data is the normal state of a stream decoder. Ok(None) tells Framed to read again; an error would drop a valid connection."
        },
        {
          "q": "Why is delimiter framing riskier than a length prefix?",
          "options": [
            "It needs escaping and can hide unbounded scanning if the delimiter never appears",
            "It cannot carry binary data at all",
            "It requires HTTP/2",
            "It always copies the payload twice"
          ],
          "answer": 0,
          "explain": "A payload containing the delimiter needs an escape rule, and a missing delimiter forces the decoder to scan an ever-growing buffer unless the size is bounded."
        }
      ],
      "quickbytes": [
        "TCP is a byte stream: message boundaries are your protocol's job",
        "Validate a peer-supplied length before reserving or slicing",
        "Ok(None) means need-more-data, not an error",
        "`Framed` + `Decoder` lets you unit-test framing without a socket"
      ],
      "production": [
        "Every framed protocol has a maximum message size enforced in the decoder.",
        "Framing is versioned in the first bytes so it can be migrated.",
        "Decoder tests cover split headers, coalesced frames, and oversized lengths.",
        "Buffer reuse is measured; per-message allocation shows up as CPU in profiles."
      ],
      "crates": ["tokio-util", "bytes", "tokio"],
      "github": [
        { "name": "tokio", "url": "https://github.com/tokio-rs/tokio" },
        { "name": "bytes", "url": "https://github.com/tokio-rs/bytes" }
      ],
      "pitfall": "Trusting the length field: a client sends 0xFFFFFFFF, the decoder calls with_capacity for 4 GiB, and the process is killed by the OOM reaper before the frame ever arrives.",
      "resources": [
        { "title": "tokio_util::codec: Decoder, Encoder, Framed", "url": "https://docs.rs/tokio-util/latest/tokio_util/codec/", "kind": "docs" },
        { "title": "bytes::BytesMut: split_to and zero-copy slices", "url": "https://docs.rs/bytes/latest/bytes/", "kind": "docs" },
        { "title": "tokio repository (tokio-util lives here)", "url": "https://github.com/tokio-rs/tokio", "kind": "repo" }
      ]
    },
    {
      "id": "f18",
      "n": 18,
      "title": "Connection pooling: sizing and staleness",
      "minutes": 85,
      "level": "industry",
      "goal": "Size a pool from measured concurrency, bound checkout wait below the request deadline, and handle the stale connection that every pool eventually hands out.",
      "sections": [
        {
          "h": "A pool is a cache with a lifecycle",
          "p": [
            "Creating a connection costs a TCP handshake, a TLS handshake, and a protocol negotiation: two or three round trips before the first byte of work. A pool amortises that by keeping connections open and lending them out. The lifecycle is the hard part: creation, checkout, health, return, idle expiry, maximum age, and eviction when the peer goes away without telling you.",
            "The maximum age matters as much as the idle timeout. A connection that has lived for an hour may be pinned to an address that DNS no longer returns, or to a backend that a deploy replaced. Setting a maximum lifetime, typically minutes rather than hours, bounds how long a stale route can survive, and it spreads reconnection cost instead of paying it all at once."
          ],
          "tip": "A pool without a checkout timeout is a queue: under saturation, callers wait for a connection until their own deadline expires, and every one of them fails slowly."
        },
        {
          "h": "Sizing with arithmetic",
          "p": [
            "Pool size follows from concurrency, not from a feeling. If a route needs 100 concurrent upstream calls, the pool needs at least 100 connections, or the 101st request waits. But per-host pools multiply: twenty upstream hosts at 100 each is 2,000 connections, which is a file-descriptor and memory decision as much as a latency one.",
            "HTTP/2 changes the arithmetic. One connection can carry many concurrent streams, so a pool of one or two connections per host is often enough, and it is far more efficient on handshakes. The cost is that all streams share one congestion window and one TCP loss event, so a lossy path or a single very large response can starve the rest of the traffic on that connection."
          ],
          "list": [
            "Concurrency per route from Little's law, not from a round number",
            "Checkout timeout strictly below the request deadline",
            "HTTP/1.1: pool size approximates concurrency; HTTP/2: 1-2 connections per host plus stream limits",
            "Maximum connection age in minutes, so DNS and deploys cannot pin a route forever"
          ],
          "code": [
            "use std::sync::Arc;",
            "use std::time::{Duration, Instant};",
            "use tokio::sync::{mpsc, Mutex, Semaphore};",
            "",
            "pub struct Idle<C> { conn: C, since: Instant }",
            "pub struct Pool<C> {",
            "    idle_tx: mpsc::UnboundedSender<Idle<C>>,",
            "    idle_rx: Mutex<mpsc::UnboundedReceiver<Idle<C>>>,",
            "    permits: Arc<Semaphore>,",
            "    idle_timeout: Duration,",
            "}",
            "",
            "impl<C: Send + 'static> Pool<C> {",
            "    pub fn new(max: usize, idle_timeout: Duration) -> Arc<Self> {",
            "        let (idle_tx, idle_rx) = mpsc::unbounded_channel();",
            "        Arc::new(Self {",
            "            idle_tx,",
            "            idle_rx: Mutex::new(idle_rx),",
            "            permits: Arc::new(Semaphore::new(max)),",
            "            idle_timeout,",
            "        })",
            "    }",
            "",
            "    pub async fn checkout<F, Fut>(self: &Arc<Self>, connect: F) -> Result<Guard<C>, PoolError>",
            "    where F: FnOnce() -> Fut, Fut: std::future::Future<Output = std::io::Result<C>>",
            "    {",
            "        // Bounded checkout: waiting for a slot must not outlive the request.",
            "        let permit = tokio::time::timeout(",
            "            Duration::from_millis(250),",
            "            self.permits.clone().acquire_owned(),",
            "        )",
            "        .await",
            "        .map_err(|_| PoolError::Exhausted)?",
            "        .map_err(|_| PoolError::Closed)?;",
            "        let mut idle = self.idle_rx.lock().await;",
            "        while let Some(entry) = idle.try_recv().ok() {",
            "            if entry.since.elapsed() < self.idle_timeout {",
            "                drop(idle);",
            "                return Ok(Guard { pool: Arc::clone(self), conn: Some(entry.conn), _permit: permit });",
            "            }",
            "        }",
            "        drop(idle);",
            "",
            "        let conn = connect().await.map_err(PoolError::Connect)?;",
            "        Ok(Guard { pool: Arc::clone(self), conn: Some(conn), _permit: permit })",
            "    }",
            "}",
            "",
            "pub struct Guard<C> { pool: Arc<Pool<C>>, conn: Option<C>, _permit: tokio::sync::OwnedSemaphorePermit }",
            "",
            "impl<C> Drop for Guard<C> {",
            "    fn drop(&mut self) {",
            "        // Drop cannot await; hand the connection back through a channel.",
            "        if let Some(conn) = self.conn.take() {",
            "            let _ = self.pool.idle_tx.send(Idle { conn, since: Instant::now() });",
            "        }",
            "    }",
            "}",
            "",
            "#[derive(Debug)] pub enum PoolError { Exhausted, Closed, Connect(std::io::Error) }"
          ].join("\n"),
          "tip": "Track checkout wait time as a metric. A rising p99 wait with stable latency means the pool is too small; a wait of exactly the timeout means it is winning."
        },
        {
          "h": "Stale sockets and the retry you need",
          "p": [
            "Every pool eventually hands out a socket the peer has already closed: the server idle-timed it out, a load balancer reaped it, or the host restarted. The client finds out when the write succeeds and the read returns zero bytes. For an idempotent request that is a safe retry; for anything else it is a correctness problem you have to design around.",
            "Reduce the window rather than relying on luck: keep the client's idle timeout below the server's, validate a checked-out connection cheaply where the protocol allows, and retry only requests that were never written. Track these errors separately from application 5xx, because a spike right after a deploy is a drain bug, not a capacity problem."
          ]
        }
      ],
      "exercise": {
        "prompt": "A route handles 1,500 requests per second with a 40 ms upstream call and an HTTP/1.1 client. Size the pool, set the checkout timeout, and explain what changes if the client speaks HTTP/2 with a 100-stream limit.",
        "starter": "// concurrency = 1500 * 0.040 = ?\n// checkout timeout < request deadline\n// HTTP/2: streams per connection instead of connections\n",
        "hint": "1,500 x 0.04 = 60 concurrent, so a pool of 60-80 with a checkout timeout around 100-200 ms. With HTTP/2 and 100 streams per connection, one or two connections cover it, at the cost of sharing one congestion window.",
        "solution": "// HTTP/1.1\n//   concurrency: 1,500 rps x 0.040 s = 60 in flight\n//   pool_max_idle_per_host: ~80 (headroom for burst and reconnect)\n//   checkout timeout: 150 ms, well below the 800 ms request deadline\n//\n// HTTP/2\n//   one connection carries up to 100 concurrent streams, so 1-2 connections\n//   per host cover 60 in flight and avoid 60 handshakes.\n//   Set max_concurrent_streams deliberately and watch stream wait time:\n//   all streams share one congestion window, so a 10 MB response and a\n//   2 KB health check on the same connection interact.\n//\n// Either way:\n//   - idle timeout below the server's, maximum age of a few minutes\n//   - checkout wait time and pool saturation are metrics\n//   - retry only requests that were never written to a stale socket"
      },
      "questions": [
        {
          "q": "A route does 1,500 rps with a 40 ms upstream call. What is the concurrency, and roughly the HTTP/1.1 pool size?",
          "options": ["60 concurrent, pool around 60-80", "37 concurrent, pool of 40", "1,500 concurrent, pool of 1,500", "4 concurrent, pool of 4"],
          "answer": 0,
          "explain": "Little's law: 1,500 x 0.040 = 60 concurrent requests. The pool must cover that concurrency plus a little headroom for reconnects."
        },
        {
          "q": "Why does HTTP/2 change pool sizing?",
          "options": [
            "One connection can multiplex many streams, so a few connections per host suffice",
            "HTTP/2 connections cannot be pooled",
            "HTTP/2 removes the need for TLS",
            "HTTP/2 pools are shared across hosts"
          ],
          "answer": 0,
          "explain": "Stream multiplexing replaces connection concurrency, at the cost of sharing one congestion window and one loss event across all streams."
        },
        {
          "q": "A pool hands out a connection the server has already closed. What is the safe response?",
          "options": [
            "Retry only if the request was never written, and keep the client idle timeout below the server's",
            "Retry every request, including POSTs",
            "Disable pooling",
            "Increase the pool size"
          ],
          "answer": 0,
          "explain": "A request that reached the server may have committed. Retry the ones that provably never left, and remove the race by ordering idle timeouts."
        }
      ],
      "quickbytes": [
        "Pool size comes from Little's law, not from a round number",
        "Checkout timeout must be shorter than the request deadline",
        "HTTP/2 turns connection count into stream count, and shares one congestion window",
        "Maximum connection age bounds how long a stale DNS answer or drained backend survives"
      ],
      "production": [
        "Pool size, checkout wait, and saturation are metrics with alerts.",
        "Maximum connection age is set in minutes, so DNS changes and deploys take effect.",
        "Stale-connection retries are limited to requests that were never written.",
        "Per-host pools are bounded so a many-host fan-out cannot exhaust descriptors."
      ],
      "crates": ["tokio", "hyper-util", "metrics"],
      "github": [
        { "name": "hyper-util", "url": "https://github.com/hyperium/hyper-util" },
        { "name": "tokio", "url": "https://github.com/tokio-rs/tokio" }
      ],
      "pitfall": "A pool with no checkout timeout and no maximum age: under saturation callers wait for a connection they cannot get, and connections created an hour ago keep pointing at backends that no longer exist.",
      "resources": [
        { "title": "hyper-util client pooling options", "url": "https://docs.rs/hyper-util/latest/hyper_util/client/legacy/struct.Builder.html", "kind": "docs" },
        { "title": "tokio::sync::Semaphore for bounded checkout", "url": "https://docs.rs/tokio/latest/tokio/sync/struct.Semaphore.html", "kind": "docs" },
        { "title": "Sharding and HTTP/2 connection reuse revisited", "url": "https://arxiv.org/abs/2110.14239", "kind": "paper" },
        { "title": "hyper-util repository", "url": "https://github.com/hyperium/hyper-util", "kind": "repo" }
      ]
    },
    {
      "id": "f19",
      "n": 19,
      "title": "CDN and caching: keys, freshness, purge",
      "minutes": 80,
      "level": "industry",
      "goal": "Design a cache key and a freshness policy that survive shared caches, use conditional requests instead of re-downloading, and know what a purge can and cannot fix.",
      "sections": [
        {
          "h": "The cache key decides correctness",
          "p": [
            "A shared cache stores a response under a key built from the method, the host, the path, and the values of any headers named in `Vary`. Everything else is invisible to it. If your API returns different JSON for `Accept-Language` and you never send `Vary`, one user's language is served to everyone. If you put a session identifier in the path, you have a cache that never hits and a hit ratio that looks like a bug.",
            "Cookies and `Authorization` change behaviour by cache, not by specification alone: most CDNs will not cache a response to a request with `Authorization` unless told to. That default is a safety net, not a design. Decide explicitly which responses are public, mark them `public` with an `s-maxage`, and mark everything personalised `private` or `no-store` so a misconfiguration cannot leak it."
          ],
          "list": [
            "Key: method + host + normalised path + query order + Vary headers",
            "Normalise query parameters and percent-encoding before hashing the key",
            "`private` for user-specific responses, `no-store` for tokens and secrets",
            "`Vary: Accept-Encoding` when the representation is compressed"
          ],
          "tip": "A cache hit ratio that is far below expectation is usually a key problem, not a TTL problem: check for a per-request query parameter or a cookie in the key."
        },
        {
          "h": "Freshness, revalidation, and 304",
          "p": [
            "`max-age` is freshness for any cache; `s-maxage` overrides it for shared caches; `stale-while-revalidate` lets a cache serve a stale copy while it refreshes in the background; `stale-if-error` lets it serve stale when the origin is failing. Those two directives are how a CDN keeps serving during an origin incident, and they are the difference between a blip and an outage.",
            "Revalidation is cheap when you support it. Send a strong `ETag` with the response and handle `If-None-Match` by returning 304 with no body; the client keeps its copy and you save an entire payload. `Last-Modified` with `If-Modified-Since` is the weaker fallback with one-second resolution. A 304 still counts as a request, so it saves bandwidth far more than it saves origin CPU."
          ],
          "code": [
            "use bytes::Bytes;",
            "use http_body_util::Full;",
            "use hyper::body::Incoming;",
            "use hyper::header::{HeaderValue, CACHE_CONTROL, ETAG, IF_NONE_MATCH};",
            "use hyper::{Request, Response, StatusCode};",
            "",
            "const BODY: &[u8] = br#\"{\"plan\":\"pro\"}\"#;",
            "const VERSION: &str = \"v42\";",
            "",
            "pub fn render(req: &Request<Incoming>) -> Response<Full<Bytes>> {",
            "    let etag = format!(\"\\\"{VERSION}\\\"\");",
            "    let fresh = req",
            "        .headers()",
            "        .get(IF_NONE_MATCH)",
            "        .and_then(|value| value.to_str().ok())",
            "        .is_some_and(|value| value.split(',').any(|tag| tag.trim() == etag));",
            "",
            "    let mut response = if fresh {",
            "        Response::new(Full::new(Bytes::new()))",
            "    } else {",
            "        Response::new(Full::new(Bytes::from_static(BODY)))",
            "    };",
            "",
            "    *response.status_mut() = if fresh { StatusCode::NOT_MODIFIED } else { StatusCode::OK };",
            "    response.headers_mut().insert(ETAG, etag.parse().expect(\"valid etag\"));",
            "    response.headers_mut().insert(",
            "        CACHE_CONTROL,",
            "        HeaderValue::from_static(",
            "            \"public, max-age=0, s-maxage=60, stale-while-revalidate=300, stale-if-error=600\",",
            "        ),",
            "    );",
            "    response",
            "}"
          ].join("\n"),
          "tip": "`max-age=0, s-maxage=60` is a deliberate pattern: browsers revalidate every time, the CDN serves for a minute."
        },
        {
          "h": "What the edge changes",
          "p": [
            "A CDN terminates TLS at a point of presence, so the client's handshake is short even when the origin is far away, and it needs a certificate for every hostname you serve. It shields the origin with a mid-tier cache, so a cache miss in one region does not become a direct request to your database. And it collapses concurrent misses for the same key into one origin request, which is the only thing standing between a viral URL and a thundering herd.",
            "Purge is a blunt instrument. A purge by URL takes effect at one POP at a time and can take seconds to propagate, so an emergency purge is not a correctness mechanism. Versioned asset names and cache keys that include a build id let you deploy without purging at all. For data that must be fresh, keep it out of the shared cache rather than purging it constantly."
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a handler that serves a JSON document with a strong ETag, answers If-None-Match with 304, and lets a shared cache serve it for 60 seconds while allowing stale content during an origin failure. Then say when you would use a purge instead.",
        "starter": "use bytes::Bytes;\nuse http_body_util::Full;\nuse hyper::{Request, Response};\nuse hyper::body::Incoming;\n\npub fn render(req: &Request<Incoming>) -> Response<Full<Bytes>> {\n    todo!()\n}",
        "hint": "Compare the If-None-Match value against the quoted ETag, return 304 with an empty body on a match, and set Cache-Control: public, max-age=0, s-maxage=60, stale-while-revalidate=300, stale-if-error=600.",
        "solution": "use bytes::Bytes;\nuse http_body_util::Full;\nuse hyper::body::Incoming;\nuse hyper::header::{HeaderValue, CACHE_CONTROL, ETAG, IF_NONE_MATCH};\nuse hyper::{Request, Response, StatusCode};\n\nconst BODY: &[u8] = br#\"{\"plan\":\"pro\"}\"#;\nconst VERSION: &str = \"v42\";\n\npub fn render(req: &Request<Incoming>) -> Response<Full<Bytes>> {\n    let etag = format!(\"\\\"{VERSION}\\\"\");\n    let fresh = req\n        .headers()\n        .get(IF_NONE_MATCH)\n        .and_then(|value| value.to_str().ok())\n        .is_some_and(|value| value.split(',').any(|tag| tag.trim() == etag));\n\n    let mut response = if fresh {\n        Response::new(Full::new(Bytes::new()))\n    } else {\n        Response::new(Full::new(Bytes::from_static(BODY)))\n    };\n\n    *response.status_mut() = if fresh { StatusCode::NOT_MODIFIED } else { StatusCode::OK };\n    response.headers_mut().insert(ETAG, etag.parse().expect(\"valid etag\"));\n    response.headers_mut().insert(\n        CACHE_CONTROL,\n        HeaderValue::from_static(\n            \"public, max-age=0, s-maxage=60, stale-while-revalidate=300, stale-if-error=600\",\n        ),\n    );\n    response\n}\n\n// Purge is for mistakes, not for freshness: it is per-POP, asynchronous, and\n// rate limited. For routine updates, version the asset or the cache key so the\n// new representation is a different key; the old one expires on its own.\n// Keep anything that must be immediately consistent out of the shared cache."
      },
      "questions": [
        {
          "q": "A shared cache serves the wrong language to users. What is missing?",
          "options": [
            "A Vary header naming the request header that selects the representation",
            "A longer max-age",
            "An ETag",
            "A Cache-Control: private directive"
          ],
          "answer": 0,
          "explain": "The cache key includes the values of headers named in Vary. Without `Vary: Accept-Language` every language shares one entry, and the first response wins."
        },
        {
          "q": "What does s-maxage control that max-age does not?",
          "options": [
            "Freshness for shared caches such as CDNs",
            "Freshness in the browser cache",
            "The maximum response size",
            "The number of revalidations"
          ],
          "answer": 0,
          "explain": "s-maxage applies to shared caches and overrides max-age for them, which is how you say 'browsers revalidate, the CDN can serve this for a minute'."
        },
        {
          "q": "What is the main cost of a 304 Not Modified response?",
          "options": [
            "A full round trip to the origin, even though the body is not sent",
            "Re-sending the whole body",
            "Re-encrypting the connection",
            "Invalidating the cache entry"
          ],
          "answer": 0,
          "explain": "A 304 saves bandwidth but still costs a request. `stale-while-revalidate` is how you avoid making users wait for that round trip."
        }
      ],
      "quickbytes": [
        "Cache key = method + host + path + query + Vary values; everything else is invisible",
        "s-maxage overrides max-age for shared caches; use both deliberately",
        "stale-while-revalidate and stale-if-error keep serving during an origin incident",
        "Purge is per-POP and asynchronous; versioned keys are the reliable deploy path"
      ],
      "production": [
        "Every response that varies by a header declares it in Vary.",
        "Personalised responses are private or no-store, never public with a short TTL.",
        "ETag and If-None-Match are implemented for cacheable JSON and static assets.",
        "Hit ratio, origin offload, and stale-serve counts are charted per route."
      ],
      "crates": ["hyper", "http-body-util", "bytes"],
      "github": [
        { "name": "hyper", "url": "https://github.com/hyperium/hyper" }
      ],
      "pitfall": "Caching a response that depends on a header you did not put in Vary: one user's locale, currency, or feature flag is served to everyone else until the entry expires, and purge is too slow to help.",
      "resources": [
        { "title": "MDN: HTTP caching, freshness and revalidation", "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching", "kind": "docs" },
        { "title": "MDN: Cache-Control directives", "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control", "kind": "docs" },
        { "title": "MDN: conditional requests and 304", "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Conditional_requests", "kind": "docs" },
        { "title": "Multi-tier caching analysis in CDN-based video systems", "url": "https://arxiv.org/abs/1902.04067", "kind": "paper" }
      ]
    },
    {
      "id": "f20",
      "n": 20,
      "title": "Debugging a network path without guesswork",
      "minutes": 95,
      "level": "industry",
      "goal": "Walk the tool ladder from DNS to bytes, read a request timing breakdown, and instrument the server so the next incident answers the question the tools cannot.",
      "sections": [
        {
          "h": "The tool ladder",
          "p": [
            "Start with `ss`: `ss -s` summarises sockets, `ss -tan state time-wait` counts ports you are holding, and `ss -tin` shows MSS, cwnd, RTT, and retransmits for a connection. Then `dig +trace` for resolution and `curl -w` for the timing breakdown of one request. Only then reach for `tcpdump`, because a capture answers framing questions and is expensive in time and attention.",
            "For TLS, `openssl s_client -connect host:443 -servername host -alpn h2` prints the chain, the negotiated protocol, and the cipher, which distinguishes a certificate problem from an ALPN problem from a firewall that accepts TCP and drops the handshake. `mtr --report` shows per-hop loss, remembering that routers deprioritise ICMP and a mid-path hop showing loss is often innocent."
          ],
          "list": [
            "`ss -s` and `ss -tin` for sockets, windows, retransmits",
            "`curl -w` for dns, connect, tls, ttfb and total in one line",
            "`openssl s_client` for chain, ALPN, and TLS version",
            "`tcpdump -ni any -vv 'tcp port 443'` when you need the bytes",
            "`strace -f -e trace=network` when the process, not the network, is lying"
          ],
          "tip": "Check the client and the server clocks before you compare timings; a 3-second skew makes every latency investigation nonsense."
        },
        {
          "h": "Read the timing breakdown",
          "p": [
            "`time_namelookup` is DNS. `time_connect - time_namelookup` is the TCP handshake. `time_appconnect - time_connect` is TLS. `time_starttransfer - time_appconnect` is the server's think time plus one round trip, and `time_total - time_starttransfer` is the body transfer. If DNS dominates, the resolver is slow or the name has too many CNAME hops; if connect dominates, suspect the path or SYN retransmits.",
            "A large ttfb gap with fast DNS and connect points at the application or a queue in front of it. A large transfer gap with a small body points at a shrinking congestion window or a proxy buffering. Comparing the same request from inside the cluster and from outside separates a network problem from a service problem in one measurement, and it costs one command."
          ],
          "code": [
            "HOST=api.example.com",
            "",
            "# One request, broken down by phase. Compare from inside and outside the cluster.",
            "curl -sS -o /dev/null -w 'dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total} http=%{http_version} ip=%{remote_ip}\\n' \\",
            "  \"https://$HOST/health\"",
            "",
            "# Is the TLS layer or ALPN the problem?",
            "openssl s_client -connect \"$HOST:443\" -servername \"$HOST\" -alpn h2 < /dev/null 2>/dev/null | head -20",
            "",
            "# Sockets: who is holding ports, who is retransmitting?",
            "ss -s",
            "ss -tin dst \"$HOST\" | grep -E 'cwnd|retrans|rtt'",
            "",
            "# Per-hop loss, with the caveat that routers deprioritise ICMP.",
            "mtr --report --report-cycles 20 \"$HOST\""
          ].join("\n"),
          "tip": "`ttfb - appconnect` includes one RTT plus server time; subtract a known-good baseline before blaming the handler."
        },
        {
          "h": "Instrument the server, not just the network",
          "p": [
            "Tools see one request. Metrics see the population. Record a histogram of request duration labelled by route, a counter of upstream errors labelled by status class, and a gauge of in-flight requests. Add connection-level counters: new connections, reused connections, checkout waits, and resets. Those four numbers explain most incidents that look like application bugs.",
            "On the tracing side, a span per request with the peer address and the route, and a child span per upstream call, gives you the breakdown without a packet capture. Enable protocol logs selectively: `RUST_LOG=hyper=debug,h2=debug` is invaluable on one instance and ruinous on a fleet, so make it a per-instance toggle rather than a deployment setting."
          ],
          "code": [
            "use std::time::Instant;",
            "use metrics::{counter, histogram};",
            "use tracing::Instrument;",
            "",
            "pub async fn handle(route: &'static str, peer: std::net::SocketAddr) -> Result<(), String> {",
            "    let started = Instant::now();",
            "    let span = tracing::info_span!(\"http.request\", route, peer = %peer);",
            "",
            "    let result = do_work().instrument(span).await;",
            "",
            "    histogram!(\"http_request_duration_seconds\", \"route\" => route)",
            "        .record(started.elapsed().as_secs_f64());",
            "",
            "    match &result {",
            "        Ok(()) => {}",
            "        Err(reason) => {",
            "            counter!(\"http_request_errors_total\", \"route\" => route).increment(1);",
            "            tracing::warn!(%reason, \"request failed\");",
            "        }",
            "    }",
            "",
            "    result",
            "}",
            "",
            "async fn do_work() -> Result<(), String> {",
            "    Ok(())",
            "}"
          ].join("\n"),
          "tip": "Export connection reuse and checkout wait time; a service with stable latency and falling reuse is one deploy away from a handshake storm."
        }
      ],
      "exercise": {
        "prompt": "A request is slow only from one region. Write the commands that separate DNS, TCP, TLS, server think time, and transfer time, and name the metric you would add on the server so the next occurrence is diagnosable in one query.",
        "starter": "# 1. timing breakdown from the affected region\n# 2. TLS/ALPN check\n# 3. socket and retransmit check\n# 4. server-side metric to add\n",
        "hint": "curl -w gives dns/connect/appconnect/starttransfer/total; openssl s_client isolates TLS and ALPN; ss -tin shows retransmits. Add a duration histogram per route plus a counter of upstream errors so the next report is a query, not a capture.",
        "solution": "HOST=api.example.com\n\n# 1. Phase-by-phase timing from the affected region, then from a healthy one.\ncurl -sS -o /dev/null -w 'dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total}\\n' \"https://$HOST/health\"\n\n# 2. TLS and ALPN, independent of the HTTP client.\nopenssl s_client -connect \"$HOST:443\" -servername \"$HOST\" -alpn h2 < /dev/null 2>/dev/null | head -20\n\n# 3. Sockets and path quality.\nss -s\nss -tin dst \"$HOST\"\nmtr --report --report-cycles 20 \"$HOST\"\n\n# 4. Server-side: add these and the next report is one query.\n#    histogram http_request_duration_seconds{route}\n#    counter   http_request_errors_total{route,status_class}\n#    gauge     http_requests_in_flight\n#    counter   connection_new_total / connection_reused_total\n#    histogram pool_checkout_wait_seconds{upstream}"
      },
      "questions": [
        {
          "q": "curl reports time_connect equal to time_namelookup, but time_appconnect much later. Where is the time going?",
          "options": [
            "The TLS handshake",
            "DNS resolution",
            "The response body transfer",
            "TCP retransmission of the first request"
          ],
          "answer": 0,
          "explain": "appconnect minus connect is the TLS handshake. Equal dns and connect times mean name resolution was cached and the TCP handshake was immediate."
        },
        {
          "q": "Which command summarises sockets, including those in TIME_WAIT?",
          "options": ["ss -s", "dig +trace", "mtr --report", "openssl s_client"],
          "answer": 0,
          "explain": "ss -s prints a summary by socket state. ss -tan state time-wait lists the individual sockets if you need the detail."
        },
        {
          "q": "Connection resets rise while request rate is flat. What is the most likely explanation?",
          "options": [
            "A keep-alive or drain problem at an intermediary",
            "A DNS TTL change",
            "An MTU mismatch",
            "An expired TLS certificate"
          ],
          "answer": 0,
          "explain": "Stable traffic with rising resets points at socket lifecycle: idle-timeout races, a deploy sending GOAWAY or closing connections, or a load balancer reaping them."
        }
      ],
      "quickbytes": [
        "`ss -tin` is the fastest look at cwnd, RTT and retransmits for one connection",
        "curl -w splits dns / connect / tls / ttfb / total in a single request",
        "Compare the same request inside and outside the cluster before blaming the code",
        "Label duration histograms by route; without the label the p99 is unactionable"
      ],
      "production": [
        "Every route has a duration histogram and an error counter labelled by status class.",
        "Connection reuse and checkout wait are exported, not inferred from latency.",
        "Protocol debug logging is a per-instance toggle with an expiry, never a fleet-wide default.",
        "A runbook names the first three commands for a latency report and who owns DNS, TLS, and the edge."
      ],
      "crates": ["metrics", "tracing", "tokio"],
      "github": [
        { "name": "metrics", "url": "https://github.com/metrics-rs/metrics" }
      ],
      "pitfall": "Running tcpdump on a busy host as the first step: the capture is enormous, the buffer drops the packets you needed, and the real answer was in `ss -tin` or a duration histogram all along.",
      "resources": [
        { "title": "metrics crate: counters, gauges, histograms", "url": "https://docs.rs/metrics/latest/metrics/", "kind": "docs" },
        { "title": "metrics::histogram macro", "url": "https://docs.rs/metrics/latest/metrics/macro.histogram.html", "kind": "docs" },
        { "title": "MDN: HTTP messages and raw request inspection", "url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Messages", "kind": "docs" },
        { "title": "metrics-rs repository", "url": "https://github.com/metrics-rs/metrics", "kind": "repo" },
        { "title": "fasterthanlime: Rust internals, profiling and debugging deep dives", "url": "https://www.youtube.com/@fasterthanlime", "kind": "video" }
      ]
    }
  ]
};
