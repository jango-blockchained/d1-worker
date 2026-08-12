# HOOX · D1 Worker

**The relational spine — every structured read and write in the mesh passes through this isolate.**

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Runtime](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh) [![Platform](https://img.shields.io/badge/Platform-Cloudflare%C2%AE%20Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/) [![License](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)

**Part of the [HOOX](https://github.com/hoox-sh/hoox) edge-trading mesh — a production-grade algorithmic trading framework on Cloudflare Workers.**  
**Site:** [hoox.sh](https://hoox.sh) · **Docs:** [docs.hoox.sh](https://docs.hoox.sh) · **Paper:** [`hoox-arxiv-paper-core.pdf`](https://github.com/hoox-sh/hoox/blob/main/papers/hoox-arxiv-paper-core.pdf)

---

The d1-worker is the centralized data access layer for the entire HOOX ecosystem. Every D1 query — trade history, position snapshots, balance records, system logs — routes through this single isolate. It enforces a strict **table allowlist** (`trade_signals`, `trades`, `positions`, `balances`, `system_logs`, `trade_requests`, `trade_responses`) and rejects any SQL referencing tables outside that set with a `403 Forbidden`. Destructive SQL keywords (`DROP`, `PRAGMA`, `ALTER`, `TRUNCATE`, `VACUUM`, `ATTACH`, `DETACH`, `CREATE`, …) are blocked at the parser level. Multi-statement SQL (semicolons) and string literals are rejected so all values must use `?` bind parameters.

`POST /query` and `POST /batch` are **read-only** (SELECT) free-form paths kept for ad-hoc reads. **Prefer named `/rpc/*` templates** for known hot paths: mutations (`insert-trade`, `upsert-position`, `insert-signal`, `insert-system-log`) and list reads (`list-signals`, `list-system-logs`). Free-form writes return `410` with `USE_NAMED_RPC`. Batches are capped (`MAX_BATCH_STATEMENTS=50`, max 64 params per statement, max SQL length 8 KiB). The worker also exposes a KV-backed settings API (`CONFIG_KV`) for configuration under known prefixes (`global:`, `webhook:`, `trade:`, `agent:`, …).

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
| [`trade-worker`](https://github.com/hoox-sh/trade-worker)         | HTTP service binding |
| [`agent-worker`](https://github.com/hoox-sh/agent-worker)         | HTTP service binding |
| [`analytics-worker`](https://github.com/hoox-sh/analytics-worker) | HTTP service binding |
| [`report-worker`](https://github.com/hoox-sh/report-worker)       | HTTP service binding |
| Dashboard                                 | HTTP service binding |

### Entry Points

| Method     | Path                     | Auth         | Schema                                                          |
| ---------- | ------------------------ | ------------ | --------------------------------------------------------------- |
| `POST`     | `/query`                 | Read key     | Free-form `{ query, params[] }` SELECT-only (prefer `/rpc/*`)   |
| `POST`     | `/batch`                 | Read key     | `{ statements: [{query,params}] }` SELECT-only atomic batch     |
| `POST`     | `/rpc/insert-trade`      | Write key    | Named trade insert (fixed SQL template)                         |
| `POST`     | `/rpc/upsert-position`   | Write key    | Named position REPLACE                                          |
| `POST`     | `/rpc/insert-signal`     | Write key    | Named trade_signals insert                                      |
| `POST`     | `/rpc/insert-system-log` | Write key    | Named system_logs insert                                        |
| `GET/POST` | `/rpc/list-signals`      | Read key     | `{ limit?, offset? }` → trade_signals (limit max 100)           |
| `GET/POST` | `/rpc/list-system-logs`  | Read key     | `{ limit?, offset? }` → system_logs (limit max 100)             |
| `GET/POST` | `/api/settings`          | Read/Write   | KV config (known prefixes only)                                 |
| `GET`      | `/api/balances`          | Read key     | Latest per-exchange balance snapshots                           |
| `GET`      | `/api/positions`         | Read key     | Open positions, `updated_at DESC`                               |
| `GET`      | `/api/logs`              | Read key     | Last N `system_logs` entries (capped)                           |
| `GET`      | `/api/dashboard/stats`   | Read key     | Live-only aggregates (excludes testnet fills/positions)         |
| `GET`      | `/health`                | None         | `SELECT 1` connectivity check                                   |

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
- **Keyword firewall**: `DROP`, `ALTER`, `TRUNCATE`, `PRAGMA`, `VACUUM`, `ATTACH`, `DETACH`, `CREATE`, … → `403`
- **Multi-statement rejection**: any non-trailing `;` → `403`
- **Params only**: string literals / quoted identifiers → `400`
- **Batch/size limits**: max 50 statements, 64 params, 8 KiB SQL, 1 MiB JSON body
- **Read-only free-form path**: `/query` + `/batch` SELECT only (prefer named list RPCs when available); free-form writes → `410 USE_NAMED_RPC`
- **Named RPC**: fixed SQL templates under `/rpc/*` for writes and common list reads (bound params only; list limit capped at 100)
- **Fail-closed auth**: scoped read/write keys (`D1_READ_KEY_BINDING` / `D1_WRITE_KEY_BINDING`) with legacy `INTERNAL_KEY_BINDING` fallback; missing key → `401`

### Development

```bash
bun test workers/d1-worker
```

### Mesh interconnect

| Direction | Peers |
| --------- | ----- |
| **Called by** | [trade-worker](https://github.com/hoox-sh/trade-worker), [agent-worker](https://github.com/hoox-sh/agent-worker), [analytics-worker](https://github.com/hoox-sh/analytics-worker), [report-worker](https://github.com/hoox-sh/report-worker), dashboard. |
| **This worker calls** | See list below |

- **[analytics-worker](https://github.com/hoox-sh/analytics-worker)** — ANALYTICS_SERVICE — optional query-side telemetry

Full mesh (all isolates live as git submodules under [`hoox-sh/hoox`](https://github.com/hoox-sh/hoox) `workers/`):

| Isolate | Role | Repository |
| ------- | ---- | ---------- |
| [hoox-worker](https://github.com/hoox-sh/hoox-worker) | Public webhook gateway (WAF, idempotency, dispatch) | monorepo `workers/hoox-worker` |
| [trade-worker](https://github.com/hoox-sh/trade-worker) | Multi-exchange order execution (Binance / Bybit / MEXC) | monorepo `workers/trade-worker` |
| [agent-worker](https://github.com/hoox-sh/agent-worker) | AI risk manager (configurable cron 1–1440 min, kill switch) | monorepo `workers/agent-worker` |
| [d1-worker](https://github.com/hoox-sh/d1-worker) | D1 SQL proxy + settings / balances / positions | monorepo `workers/d1-worker` |
| [telegram-worker](https://github.com/hoox-sh/telegram-worker) | Alerts, bot commands, RAG copilot | monorepo `workers/telegram-worker` |
| [email-worker](https://github.com/hoox-sh/email-worker) | Mailgun / email signal parsing → trade | monorepo `workers/email-worker` |
| [analytics-worker](https://github.com/hoox-sh/analytics-worker) | Analytics Engine write + query path | monorepo `workers/analytics-worker` |
| [report-worker](https://github.com/hoox-sh/report-worker) | PDF reports via Browser Rendering → R2 | monorepo `workers/report-worker` |
| [web3-wallet-worker](https://github.com/hoox-sh/web3-wallet-worker) | On-chain wallet identity (ethers.js) | monorepo `workers/web3-wallet-worker` |
| [dashboard](https://github.com/hoox-sh/hoox/tree/main/workers/dashboard) | Next.js ops console (OpenNext, public) | monorepo `workers/dashboard` |

### Docs & monorepo

| Resource | Link |
| -------- | ---- |
| Isolate profile (operators) | [https://docs.hoox.sh/docs/devops/workers/d1-worker](https://docs.hoox.sh/docs/devops/workers/d1-worker) |
| Parent monorepo | [github.com/hoox-sh/hoox](https://github.com/hoox-sh/hoox) |
| This repository | [github.com/hoox-sh/d1-worker](https://github.com/hoox-sh/d1-worker) |
| Workers index | [docs.hoox.sh → Workers](https://docs.hoox.sh/docs/devops/workers) |
| CLI | `@hoox-sh/hoox-cli` · `hoox deploy worker d1-worker` |

### License

[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — part of the HOOX open-core mesh.
