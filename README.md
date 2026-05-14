# @hoox/d1-worker

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Runtime](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh) [![Platform](https://img.shields.io/badge/Platform-Cloudflare%C2%AE%20Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/) [![License](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)

Centralized SQLite database service — stores trade history, positions, and system logs.

## For CLI Users

Use this worker indirectly when you run `hoox` commands:

- `hoox db apply --remote` — apply database schemas
- `hoox db query "SELECT COUNT(*) FROM trades" --remote` — run read-only queries

→ [Database Ops Guide](../../docs/guides/database-ops.md) · [CLI Reference](../../docs/reference/cli-commands.md)

## For Operators

This worker provides the centralized data access layer for the Hoox ecosystem. It exposes a REST API over D1 (Cloudflare's serverless SQLite), serving trade history, open positions, system logs, and aggregated dashboard metrics to all internal workers and the dashboard.

→ [Operator Docs](../../docs/devops/workers/d1-worker.md)

## Development

```bash
bun test workers/d1-worker
```
