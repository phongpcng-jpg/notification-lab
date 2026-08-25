# Experimental Analysis — A–J and H

> **Evidence status:** This document interprets the completed benchmark results stored in `benchmark/results/processed/`. It does not replace the generated result matrix. Numerical values below are observed aggregate values used for analysis.

## 1. Purpose

This document converts the benchmark measurements into technical findings while keeping three things separate:

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

Short Polling has a materially larger latency tail in the benchmarked workload. WebSocket had the lowest observed latency in this workload, but this does not establish a universal ranking.

## 3. Scenario B — Burst

Scenario B uses a concentrated burst workload targeting queue/fan-out behavior.

| Transport | p50 (ms) | p95 (ms) | p99 (ms) | Delivery | Errors |
|---|---:|---:|---:|---:|---:|
| Short Polling | 10581 | 16047 | 16785 | 99.9% | 0 |
| Long Polling | 13904 | 33736 | 37221 | 87.8% | 2261 |
| SSE | 889 | 1297 | 1419 | 100.0% | 0 |
| WebSocket | 771 | 1214 | 1383 | 100.0% | 0 |

In the benchmarked workload, SSE/WebSocket separated clearly from polling-based delivery. Long Polling is an important reliability counterexample because its aggregate delivery was 87.8% with 2261 errors.

The backend hot path is approximately:

```text
createPost
  -> DB validation / post insert
  -> fan-out DB transaction
  -> commit
  -> DB re-query after commit
  -> PushHub publish
  -> socket.send
  -> client ACK
  -> ACK DB write
```

The measured E2E latency therefore cannot be attributed entirely to `socket.send`; database work, fan-out processing and event-loop pressure can delay notification availability before transport transmission.

## 4. Scenario C — Massive Fan-out

At the tested fan-out size, Short Polling had higher latency and lower delivery completeness, while Long Polling, SSE and WebSocket reached 100% delivery. This is evidence about the benchmarked workload, not a production-scale capacity limit.

## 5. Scenario D — High-frequency

Scenario D uses sustained high event frequency.

| Transport | p50 (ms) | p95 (ms) | p99 (ms) | Delivery |
|---|---:|---:|---:|---:|
| Short Polling | 3328 | 5790 | 6234 | 99.8% |
| Long Polling | 925 | 1478 | 1660 | 100.0% |
| SSE | 870 | 1305 | 1435 | 100.0% |
| WebSocket | 715 | 1140 | 1191 | 100.0% |

In the benchmarked workload, polling request overhead is substantially more visible than for the long-lived transports.

## 6. Scenario E — Connection Storm

Scenario E stresses connection establishment.

| Transport | p50 (ms) | p95 (ms) | p99 (ms) | Delivery |
|---|---:|---:|---:|---:|
| Short Polling | 2215 | 5418 | 6088 | 98.0% |
| Long Polling | 1053 | 1597 | 1753 | 100.0% |
| SSE | 1011 | 1494 | 1552 | 100.0% |
| WebSocket | 1121 | 1814 | 1949 | 100.0% |

E is a counterexample to any universal claim that WebSocket has the lowest latency: in this benchmarked workload, SSE had the lowest p95 among the long-lived transports.

## 7. Scenario F — Reconnection Storm

F exercises reconnect/recovery behavior. Short Polling has no persistent connection lifecycle equivalent, so its reconnect metric is not directly comparable.

| Transport | p50 (ms) | p95 (ms) | p99 (ms) | Delivery | Reconnects | Duplicates |
|---|---:|---:|---:|---:|---:|---:|
| Short Polling | 3358 | 5662 | 6129 | 95.4% | 0 | 412 |
| Long Polling | 1061 | 1626 | 1721 | 100.0% | 0 | 0 |
| SSE | 1189 | 1834 | 2143 | 100.0% | 300 | 1389 |
| WebSocket | 697 | 1097 | 1163 | 100.0% | 300 | 1713 |

In the benchmarked workload, WebSocket combined 100% delivery with the lowest p50/p95 among the transports while also recording the highest duplicate count. This is consistent with the project's at-least-once-oriented cursor recovery model. Duplicate delivery is therefore a separate reliability/recovery signal, not automatically a transport failure.

The WebSocket ACK records application acknowledgement in the backend; it is not evidence that a human user saw or read the notification.

## 8. Scenario G — Slow Client

G simulates slow application-level processing. It is **not** a true TCP/socket-buffer backpressure experiment.

In the benchmarked workload, Short Polling had the largest latency tail, while Long Polling had a higher p95/p99 than SSE/WebSocket. The conclusion is limited to application-level slow-client behavior.

## 9. Scenario H — Configured Toxiproxy impairment profile

H is intentionally separate from the main matrix and represents only the **configured Toxiproxy impairment profile** used by the benchmark.

| Transport | p50 (ms) | p95 (ms) | p99 (ms) | Delivery | Errors | Reconnects |
|---|---:|---:|---:|---:|---:|---:|
| Long Polling | 671 | 1096 | 1174 | 100.0% | 0 | 0 |
| Short Polling | 3324 | 5643 | 5930 | 100.0% | 0 | 0 |
| SSE | 684 | 1413 | 1430 | 100.0% | 0 | 0 |
| WebSocket | 775 | 1156 | 1220 | 100.0% | 0 | 0 |

The benchmarked H workload produced no observed delivery failures, errors or reconnects. This does not characterize arbitrary Internet conditions; it only describes the configured impairment profile.

## 10. Scenario I — Large Payload

I evaluates larger notification payloads.

| Transport | p50 (ms) | p95 (ms) | p99 (ms) | Delivery |
|---|---:|---:|---:|---:|
| Short Polling | 3544 | 5823 | 5946 | 100.0% |
| Long Polling | 843 | 1212 | 1255 | 100.0% |
| SSE | 1017 | 1434 | 1448 | 100.0% |
| WebSocket | 834 | 1352 | 1424 | 100.0% |

In the benchmarked workload, larger payloads did not produce delivery failure. The result does not establish a maximum supported payload size.

## 11. Scenario J — Mixed Workload

J combines burst, reconnect storm, slow clients and larger payloads.

| Transport | p50 (ms) | p95 (ms) | p99 (ms) | Delivery | Reconnects | Duplicates |
|---|---:|---:|---:|---:|---:|---:|
| Short Polling | 2703 | 5174 | 6168 | 100.0% | 0 | 2543 |
| Long Polling | 3667 | 7545 | 8740 | 100.0% | 0 | 0 |
| SSE | 1051 | 1556 | 1728 | 100.0% | 300 | 6000 |
| WebSocket | 801 | 1277 | 1377 | 100.0% | 300 | 4317 |

J shows the strongest interaction between latency, recovery and duplicate behavior in the benchmarked workloads. The high duplicate counts should be interpreted with the project's at-least-once-oriented recovery model rather than as delivery failure, since delivery remained 100%.

## 12. Cross-scenario findings

1. **Short Polling generally had the largest latency tail in the benchmarked workloads.** This is especially visible in A, B, D, G and I/J.
2. **SSE and WebSocket were often lower-latency in the benchmarked workloads with burst or sustained event activity.** This is workload-specific evidence, not a universal protocol ranking.
3. **Long Polling is a useful intermediate model in the benchmarked workloads**, but B shows that burst/fan-out contention can coincide with poor reliability.
4. **Latency, delivery, reconnects and duplicates are separate dimensions.** F and J make this particularly clear.
5. **Server-side work matters.** B instrumentation shows that DB/fan-out/event-loop work can contribute materially to notification latency before transport transmission.
6. **No single transport wins every benchmarked workload.** E is an explicit counterexample to a WebSocket-always-fastest claim.

## 13. Experimental conclusion

Across the benchmarked A–J workloads plus the configured H impairment profile, the strongest practical conclusion is requirement-driven rather than a universal ranking. Short Polling favors simplicity and stateless HTTP at the cost of higher latency tails in many benchmarked workloads. Long Polling provides server-side waiting without a persistent bidirectional channel but can be sensitive to contention. SSE is a strong fit for one-way in-app realtime with browser-managed reconnect. WebSocket is a strong fit when bidirectional interaction and application-level ACK justify its additional connection/state complexity. Web Push should be evaluated separately for background/offline and OS-level notification use cases.

These conclusions apply to the tested implementation, workload configurations and execution environment. They should not be interpreted as production capacity limits or universal Internet performance claims.
