# Incident Report: OOM Crash — VTEX Search Flood

**Date:** 2026-03-06
**Duration:** ~10:09 – ~11:29 UTC (07:09 – 08:29 BRT)
**Severity:** Critical (full service outage)
**Namespace:** `deco-mcp-mesh`
**Affected Pods:** All mesh pods (ReplicaSet `deco-mcp-mesh-99dc5cf9`)

---

## Summary

All mesh pods were OOM-killed simultaneously starting at ~10:09 UTC due to a massive burst of `VTEX_SEARCH_PRODUCTS_FILTERED_AND_ORDERED` tool calls via connection `conn_T_lsKjFAFvFCHEFYvD7jH`. The calls paginated through 3 product clusters with 50-item pages, generating large JSON payloads that exhausted the 1 GB memory limit on every pod. The cascade of OOM kills caused a full service outage lasting over an hour.

---

## Timeline

| Time (UTC) | Event |
|---|---|
| 09:00–10:03 | Pods stable at ~215–224 MB memory (3 pods: `rhj29`, `gpxkh`, `pl99w`) |
| ~10:08:58 | Burst of requests hits `conn_T_lsKjFAFvFCHEFYvD7jH` — "VTEX Commerce APIs" connection |
| 10:09:09 | Slow queries start: `begin` transactions taking 8–9s, `monitoring_logs` inserts taking 400ms–1.4s |
| 10:09:11 | `VTEX_SEARCH_PRODUCTS_FILTERED_AND_ORDERED` tool calls begin paginating heavily across 3 product clusters (`1031`, `1047`, `1748`), 50 items per page |
| ~10:10 | Memory spikes from ~224 MB to **901 MB** on pod `rhj29` |
| 10:09:35 | First OOM kill detected (pod `gpxkh`, 512 MB at time of kill) |
| 10:09–10:35 | **Cascading OOM kills** on all 6 pods. 152+ VTEX search calls logged, paginating from `_from=0` up to `_from=399` |
| 10:12–10:30 | CrashLoopBackOff on all pods, BackOff counts escalating to 90+ |
| 10:14:55 | HPA `FailedComputeMetricsReplicas` — cannot autoscale because pods are crashing |
| 10:44–10:46 | Old crashing pods finally terminated |
| 11:03 | HPA scales up from 3 to 5 pods (memory pressure from survivors) |
| 11:13–11:14 | HPA scales back down to 3 (metrics stabilize) |
| 11:23–11:24 | New deployment rolled out: `99dc5cf9` → `74d9c65dd4` (rolling update) |
| 11:29 | New pods stabilize. Service restored. |

---

## Root Cause

A client issued a high volume of `VTEX_SEARCH_PRODUCTS_FILTERED_AND_ORDERED` calls through connection `conn_T_lsKjFAFvFCHEFYvD7jH` ("VTEX Commerce APIs"). The calls paginated through **3 product clusters** (`1031`, `1047`, `1748`) in 50-item batches, ranging from `_from=0` up to `_from=399` — potentially fetching 400+ products per cluster.

Each call was proxied through mesh, which held the full VTEX response payload (product data with images, descriptions, variants, etc.) in memory. Additionally, each tool call triggered a `monitoring_logs` INSERT storing the full input and output inline, which:

1. Further increased per-request memory footprint
2. Caused database transaction slowdowns (`begin` taking 8–9 seconds)
3. Created backpressure that kept connections open longer, accumulating more in-flight data

Memory spiked from ~220 MB to 900+ MB within minutes on all pods (requests were load-balanced), exceeding the 1 GB container limit and triggering OOM kills across the entire fleet simultaneously.

---

## Cascade Mechanism

1. Pods get OOM-killed
2. Kubernetes restarts them
3. Restarted pods immediately pick up queued/retried requests from the same VTEX flood
4. OOM again within seconds
5. CrashLoopBackOff kicks in with exponential delays
6. HPA cannot compute metrics (no healthy pods reporting) → stuck at previous replica count
7. Full outage until the request storm subsides and a new deployment is rolled out

---

## Contributing Factors

- **No backpressure or rate limiting** on tool calls per connection — a single client could saturate all pods
- **`monitoring_logs` stores full input/output** — large VTEX product payloads stored inline cause both memory pressure and slow DB transactions
- **1 GB memory limit** is tight for handling large API responses with concurrent pagination across multiple pods
- **No circuit breaker** to shed load when memory pressure is detected

---

## Evidence

### OOM Events (from Goldilocks VPA recommender)

All OOM events reported `Memory: 536870912` (512 MB at time of kill) with container `chart-deco-mcp-mesh`:

- 10:09:35 — `gpxkh` (first OOM)
- 10:12:15 — `9twkj`
- 10:13:28 — `9twkj`, `gvv5d`
- 10:14:07 — `gpxkh`
- 10:14:18 — `rhj29`
- 10:14:30 — `gvv5d`
- 10:14:33 — `9twkj`
- 10:14:37 — `ft94b`
- 10:15:00 — `ft94b`
- ... (28+ OOM events total across all pods through 11:03)

### Memory Profile (pod `rhj29`)

```
09:00  220 MB  (stable)
09:07  216 MB
09:56  220 MB
10:03  224 MB
10:10  901 MB  ← spike
10:14  285 MB  (after restart)
10:17  167 MB  (after restart)
10:19  841 MB  ← spike again
10:22    4 MB  (OOM killed)
10:28  602 MB  ← spike on restart
```

### Slow Queries

```
Slow query detected: {
  sql: "begin",
  durationMs: 8901.99
}

Slow query detected: {
  sql: "insert into \"monitoring_logs\" ...",
  durationMs: 1387.52
}
```

### VTEX Tool Calls (152 logged)

Pagination pattern across all pods:
```
productClusterIds:1031  _from=0    to _from=399
productClusterIds:1047  _from=0    to _from=249
productClusterIds:1748  _from=50   to _from=399
```

---

## Recommendations

### Short-term

1. **Truncate large tool outputs** before storing in `monitoring_logs` — cap the output size (e.g., 64 KB) to prevent memory bloat from large VTEX payloads
2. **Increase memory limit** to 2 GB as a safety margin while other fixes are applied

### Medium-term

3. **Add per-connection request concurrency limits** — prevent a single connection from flooding all pods with concurrent tool calls
4. **Add pagination limits** on proxied tool calls — cap the maximum `_from` value or total pages per session
5. **Stream large responses** instead of buffering them fully in memory before forwarding

### Long-term

6. **Implement memory-based backpressure** — reject or queue new tool calls when pod memory usage exceeds a threshold (e.g., 70% of limit)
7. **Add circuit breaker per connection** — if a connection causes repeated failures or excessive resource usage, temporarily disable it
8. **Move `monitoring_logs` output storage** to object storage (S3) with only a reference/summary in the database

---

## Related

- Commit `1a00f614` — "fix: remove eager tool backfill from connection GET to prevent resource exhaustion (#2588)"
- Commit `aeb60eec` — "fix(billing): optimize monitoring queries to reduce memory usage (#2589)"
