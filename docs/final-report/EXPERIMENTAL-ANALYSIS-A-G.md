# Experimental Analysis — A–G

> **Evidence status:** This document interprets the completed A–G benchmark results supplied from `benchmark/results/processed/`. It does not replace the generated result matrix. Numerical values below are the observed aggregate values used for the analysis.

## 1. Purpose

This document converts the A–G measurements into technical findings while keeping three things separate:

1. measured benchmark results;
2. implementation/architecture explanations;
3. requirement-driven conclusions.

The goal is **not** to declare one universal transport winner.

---

## 2. Scenario A — Baseline

Scenario A is the normal-workload baseline.

| Transport | p50 (ms) | p95 (ms) | p99 (ms) | Delivery |
|---|---:|---:|---:|---:|
| Short Polling | 3164 | 4372 | 4417 | 100.0% |
| Long Polling | 884 | 926 | 938 | 100.0% |
| SSE | 1026 | 1045 | 1051 | 100.0% |
| WebSocket | 813 | 835 | 835 | 100.0% |

Short Polling has a materially larger latency tail: approximately 4.4 s at p95 versus less than 1.1 s for the other three transports.

This supports the architectural expectation that periodic polling introduces request/discovery waiting overhead. It does **not** establish WebSocket as universally fastest; it only shows that WebSocket had the lowest observed latency in this workload.

---

## 3. Scenario B — Burst

Scenario B uses 20 subscribers and a burst of 100 posts. Its scenario definition explicitly targets queue/fan-out behavior, latency and duplicate handling (`benchmark/scenarios/B.json`).

| Transport | p50 (ms) | p95 (ms) | p99 (ms) | Delivery | Errors |
|---|---:|---:|---:|---:|---:|
| Short Polling | 10581 | 16047 | 16785 | 99.9% | 0 |
| Long Polling | 13904 | 33736 | 37221 | 87.8% | 2261 |
| SSE | 889 | 1297 | 1419 | 100.0% | 0 |
| WebSocket | 771 | 1214 | 1383 | 100.0% | 0 |

B shows a strong separation between polling-based and persistent/server-push delivery under burst pressure.

The backend hot path is approximately:

```text
createPost
  -> validate author DB
  -> post DB insert/read
  -> fan-out DB transaction
  -> commit
  -> DB re-query after commit
  -> SSE/WebSocket publish
  -> WebSocket socket.send
  -> client ACK
  -> ACK DB write
```

Therefore the E2E latency must not be attributed entirely to `socket.send`. Under burst/fan-out contention, database work, fan-out processing and event-loop pressure can delay notification availability before the transport write.

**Finding:** persistent server-push transports handled the tested burst substantially better than polling-based delivery, while server-side fan-out/database/event-loop work is an important contributor to total latency.

---

## 4. Scenario C — Massive Fan-out

Scenario C increases the subscriber population to 1,000 and targets fan-out scale (`benchmark/scenarios/C.json`).

| Transport | p50 (ms) | p95 (ms) | p99 (ms) | Delivery |
|---|---:|---:|---:|---:|
| Short Polling | 4410 | 5227 | 5471 | 92.5% |
| Long Polling | 968 | 1500 | 1601 | 100.0% |
| SSE | 1396 | 1518 | 1523 | 100.0% |
| WebSocket | 634 | 1160 | 1256 | 100.0% |

At the tested scale, Short Polling has both higher latency and lower delivery completeness. Long Polling, SSE and WebSocket achieved 100% delivery.

The conclusion is workload-bounded: at this tested fan-out size and event rate, persistent/server-push transports maintained better latency and delivery completeness than Short Polling. This should not be generalized to arbitrary production-scale subscriber counts without additional experiments.

---

## 5. Scenario D — High-frequency

Scenario D uses a sustained fixed rate of 10 posts/second with 50 subscribers rather than a single burst. Its purpose is continuous high-frequency load (`benchmark/scenarios/D.json`).

| Transport | p50 (ms) | p95 (ms) | p99 (ms) | Delivery |
|---|---:|---:|---:|---:|
| Short Polling | 3328 | 5790 | 6234 | 99.8% |
| Long Polling | 925 | 1478 | 1660 | 100.0% |
| SSE | 870 | 1305 | 1435 | 100.0% |
| WebSocket | 715 | 1140 | 1191 | 100.0% |

D reinforces the observation that polling request overhead becomes increasingly visible as notification frequency rises. The three long-lived transports remain much closer to one another while Short Polling develops a substantially larger tail.

B and D should be interpreted together:

- **B:** concentrated burst pressure;
- **D:** sustained high-frequency pressure.

Their different workload shapes mean they are complementary rather than duplicate experiments.

---

## 6. Scenario E — Connection Storm

Scenario E stresses connection establishment by ramping 300 subscribers over approximately two seconds (`benchmark/scenarios/E.json`).

| Transport | p50 (ms) | p95 (ms) | p99 (ms) | Delivery |
|---|---:|---:|---:|---:|
| Short Polling | 2215 | 5418 | 6088 | 98.0% |
| Long Polling | 1053 | 1597 | 1753 | 100.0% |
| SSE | 1011 | 1494 | 1552 | 100.0% |
| WebSocket | 1121 | 1814 | 1949 | 100.0% |

E is an important counterexample to any claim that WebSocket is always the lowest-latency option. SSE has the lowest p95 among the three long-lived transports in this workload, while WebSocket has the highest.

The experiment therefore indicates that connection lifecycle cost matters in addition to steady-state notification transmission.

---

## 7. Scenario F — Reconnection Storm

Scenario F disconnects all subscribers and reconnects them at the configured storm point. The scenario definition explicitly notes that it is most meaningful for SSE/WebSocket/Long Polling because Short Polling has no equivalent persistent-connection lifecycle (`benchmark/scenarios/F.json`).

| Transport | p50 (ms) | p95 (ms) | p99 (ms) | Delivery | Reconnects | Duplicates |
|---|---:|---:|---:|---:|---:|---:|
| Short Polling | 3358 | 5662 | 6129 | 95.4% | 0 | 412 |
| Long Polling | 1061 | 1626 | 1721 | 100.0% | 0 | 0 |
| SSE | 1189 | 1834 | 2143 | 100.0% | 300 | 1389 |
| WebSocket | 697 | 1097 | 1163 | 100.0% | 300 | 1713 |

F demonstrates why latency, delivery completeness, reconnect behavior and duplicates must be evaluated separately.

WebSocket achieved 100% delivery and the lowest p50/p95 among the tested transports, but it also produced the largest duplicate count. This does **not** by itself indicate a transport failure. The project uses cursor-based recovery and at-least-once-oriented delivery rather than exactly-once user-visible delivery. Replayed notifications are therefore possible during reconnect/catch-up, and client-side deduplication remains part of the delivery model.

The WebSocket ACK records acknowledgement state in the backend; it is not evidence that a human user actually saw or read the notification.

**Finding:** reconnection recovery creates a measurable trade-off between loss avoidance and duplicate delivery. Duplicates should therefore be reported separately from delivery failure.

---

## 8. Scenario G — Slow Client

Scenario G simulates slow application-level processing by making 30% of clients slow and adding a three-second delay (`benchmark/scenarios/G.json`). It is **not** a true TCP/socket-buffer backpressure experiment.

| Transport | p50 (ms) | p95 (ms) | p99 (ms) | Delivery |
|---|---:|---:|---:|---:|
| Short Polling | 3548 | 6939 | 8273 | 97.1% |
| Long Polling | 864 | 3102 | 3742 | 100.0% |
| SSE | 788 | 1196 | 1208 | 100.0% |
| WebSocket | 748 | 1198 | 1300 | 100.0% |

G shows a large tail-latency penalty for Short Polling and a larger p95/p99 for Long Polling than for SSE/WebSocket.

The conclusion must remain limited to application-level slow-client behavior. G should **not** be used as evidence about real network backpressure, kernel socket buffers, TCP congestion or browser transport buffering.

---

# 9. Cross-scenario Findings

## 9.1 Persistent/server-push transports generally reduce discovery latency

Across A–G, Short Polling consistently exhibits a materially larger latency tail than the long-lived/server-push alternatives, especially in A, B, D and G.

The experiment supports the architectural expectation that periodic polling introduces request/discovery waiting overhead. It does not prove that one persistent transport is universally superior.

## 9.2 WebSocket is not universally the fastest transport

WebSocket has strong results in A, B, C, D and F, but E is a clear counterexample: SSE has a lower p95 than WebSocket during the connection-storm workload.

The appropriate conclusion is workload-dependent rather than a global ranking.

## 9.3 Under burst pressure, server-side work matters in addition to transport transmission

Scenario B is particularly useful because backend instrumentation observes the hot path rather than only client-visible latency.

```text
DB validation/insert
    -> notification fan-out transaction
    -> post-commit notification re-query
    -> PushHub publish
    -> socket.send
    -> client ACK
    -> ACK DB write
```

A transport comparison must therefore not attribute the entire E2E latency to `socket.send`. Database contention, fan-out processing and event-loop pressure can delay notification availability before the transport write.

## 9.4 Delivery reliability and duplicate behavior are separate dimensions

Scenario F is the clearest example: WebSocket achieved 100% delivery while also recording a high duplicate count during reconnect recovery.

```text
low latency
    != delivery completeness
    != reconnect success
    != duplicate-free delivery
    != user-visible acknowledgement
```

These dimensions should remain separate in the final comparison.

## 9.5 Workload shape changes relative transport behavior

| Scenario | Primary stress |
|---|---|
| A | Normal baseline |
| B | Concentrated burst |
| C | Fan-out scale |
| D | Sustained event frequency |
| E | Connection establishment |
| F | Reconnection/recovery |
| G | Slow application-level clients |

The results show why A–G should not be collapsed into a single aggregate score or used to declare a universal benchmark winner.

---

# 10. Experimental Conclusion for A–G

Within the tested A–G workloads, long-lived/server-push transports generally achieved lower latency and higher delivery completeness than Short Polling. WebSocket showed particularly strong results under burst, sustained high-frequency and reconnection workloads, while SSE remained competitive and had the lowest p95 among the long-lived transports in the connection-storm scenario.

The more important finding is that **transport-level transmission is only one part of notification latency**. Under burst/fan-out pressure, server-side database work, fan-out processing and event-loop contention can materially affect the time before a notification reaches the client. Reconnect scenarios expose a separate trade-off between recovery completeness and duplicate delivery.

Therefore, the A–G experiments support a requirement-driven decision rather than a universal ranking:

- **Short Polling:** appropriate when simplicity/stateless HTTP is more important than low latency and update frequency is modest.
- **Long Polling:** useful when server-driven waiting is needed but SSE/WebSocket is undesirable or unavailable.
- **SSE:** appropriate for predominantly server-to-client realtime streams where browser-managed reconnect is valuable and bidirectional messaging is unnecessary.
- **WebSocket:** appropriate when bidirectional communication or very frequent realtime interaction justifies additional connection/state complexity.
- **Web Push:** evaluate separately for offline/background or OS-level notifications because its browser/Push Service delivery path is fundamentally different from the four in-app transports.

These conclusions apply only to the tested implementation, workload configurations and execution environment. The completed A–G analysis should now be read together with the generated H, I and J results; those scenarios extend coverage to the configured Toxiproxy impairment profile, payload-size behavior and mixed workload respectively.