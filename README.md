# HOOX · D1 Worker

**The relational spine — every structured read and write in the mesh passes through this isolate.**

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Runtime](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh) [![Platform](https://img.shields.io/badge/Platform-Cloudflare%C2%AE%20Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/) [![License](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)

**Part of the [HOOX](https://github.com/jango-blockchained/hoox) edge-trading mesh — a production-grade algorithmic trading framework on Cloudflare Workers.**  
**Site:** [hoox.sh](https://hoox.sh) · **Docs:** [docs.hoox.sh](https://docs.hoox.sh) · **Paper:** [`hoox-arxiv-paper-core.pdf`](https://github.com/jango-blockchained/hoox/blob/main/papers/hoox-arxiv-paper-core.pdf)

---

The d1-worker is the centralized data access layer for the entire HOOX ecosystem. Every D1 query — trade history, position snapshots, balance records, system logs — routes through this single isolate. It enforces a strict **table allowlist** (`trade_signals`, `trades`, `positions`, `balances`, `system_logs`, `trade_requests`, `trade_responses`) and rejects any SQL referencing tables outside that set with a `403 Forbidden`. Destructive SQL keywords (`DROP`, `PRAGMA`, `ALTER`, `TRUNCATE`, `VACUUM`, `ATTACH`, `DETACH`) are blocked at the parser level.

Query execution supports single-statement (`POST /query`) and atomic multi-statement batches (`POST /batch`, backed by `DB.batch()`). All mutations return `lastRowId` + `changes` metadata. The worker also exposes a KV-backed settings API (`CONFIG_KV`) for reading and writing configuration values under key prefixes (`global:`, `webhook:`, `trade:`, `agent:`).

### Role in the Mesh

```
trade-worker ──┐
agent-worker ──┤
dashboard   ──┤──► d1-worker ──► D1 (trade-data-db)
analytics   ──┤
report      ──┘
               └──► CONFIG_KV (settings)

Every read/write goes through table allowlist + SQL firewall.
```

### Service Bindings

| Consumer Workers                          | Protocol             |
| ----------------------------------------- | -------------------- |
| [`trade-worker`](../trade-worker)         | HTTP service binding |
| [`agent-worker`](../agent-worker)         | HTTP service binding |
| [`analytics-worker`](../analytics-worker) | HTTP service binding |
| [`report-worker`](../report-worker)       | HTTP service binding |
| Dashboard                                 | HTTP service binding |

### Entry Points

| Method     | Path             | Auth         | Schema                                                |
| ---------- | ---------------- | ------------ | ----------------------------------------------------- |
| `POST`     | `/query`         | Internal key | `{ sql, params[] }` → `{ results[], success }`        |
| `POST`     | `/batch`         | Internal key | `[sql, params[]][]` → atomic batch                    |
| `GET/POST` | `/api/settings`  | Internal key | KV config (`global:`, `webhook:`, `trade:`, `agent:`) |
| `GET`      | `/api/balances`  | Internal key | Latest per-exchange balance snapshots                 |
| `GET`      | `/api/positions` | Internal key | Open positions, `updated_at DESC`                     |
| `GET`      | `/api/logs`      | Internal key | Last 50 `system_logs` entries                         |
| `GET`      | `/health`        | None         | `SELECT 1` connectivity check                         |

### Database Schema (D1: `trade-data-db`)

| Table                                | Purpose                                                |
| ------------------------------------ | ------------------------------------------------------ |
| `trade_signals`                      | Incoming signals with raw payload + parse status       |
| `trades`                             | Executed orders (exchange, symbol, qty, price, status) |
| `positions`                          | Open/closed positions with `unrealized_pnl`            |
| `balances`                           | Exchange+asset balance snapshots (timestamped)         |
| `system_logs`                        | Structured application log events                      |
| `trade_requests` / `trade_responses` | Request-response audit trail                           |

### Security Model

- **Table allowlist**: queries referencing non-allowlisted tables → `403`
- **Keyword firewall**: `DROP`, `ALTER`, `TRUNCATE`, `PRAGMA`, `VACUUM`, `ATTACH`, `DETACH` → `403`
- **Read-only enforcement**: `SELECT` allowed; `INSERT`/`UPDATE`/`DELETE`/`REPLACE` allowed; schema mutations blocked
- **Internal auth**: All endpoints except `/health` require `X-Internal-Auth-Key` header

### Development

```bash
bun test workers/d1-worker
```

### License

[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — part of the HOOX open-core mesh.
