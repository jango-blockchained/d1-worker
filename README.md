# D1 Worker

**Last Updated:** April 2026

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescript-lang.org/) [![Runtime](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh) [![Platform](https://img.shields.io/badge/Platform-Cloudflare®%20Edge%20Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/) [![License](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/) [![Build Status](https://github.com/jango-blockchained/hoox-setup/actions/workflows/opencode.yml/badge.svg)](https://github.com/jango-blockchained/hoox-setup/actions/workflows/opencode.yml)

**[Main Repository](https://github.com/jango-blockchained/hoox-setup)** · **[View on GitHub](https://github.com/jango-blockchained/d1-worker)**

An example Cloudflare® Worker service demonstrating interaction with a Cloudflare® D1 database. In the main Hoox project, workers typically interact with D1 directly using bindings configured in their `wrangler.jsonc` files, but this serves as a standalone example.

---

## About

This worker is part of the **[Hoox Trading System](https://github.com/jango-blockchained/hoox-setup)** - a zero-latency edge trading ecosystem. The `d1-worker` handles:

- **Data Aggregation**: Collects and stores trade histories from all workers
- **SQL Operations**: Provides standardized database queries via D1 bindings
- **Trade Logging**: Persists all trade executions and signals for analysis
- **System Logs**: Aggregates logs from all workers for monitoring
- **Atomic Storage**: Leverages D1's distributed SQLite for reliable data persistence

## Features

- Demonstrates basic D1 database operations (querying, inserting).
- Uses parameterized queries for security.

## Prerequisites

- Node.js >= 16
- Bun
- Wrangler CLI
- Cloudflare® Workers account with D1 database access enabled.

## Setup

1. Install dependencies:
   ```bash
   bun install
   ```
2. Create a D1 database (if you haven't already):
   ```bash
   npx wrangler d1 create my-d1-database-example
   ```
3. Update `wrangler.jsonc` with your Cloudflare® Account ID and the D1 Database ID:
   ```jsonc
   {
     "name": "d1-worker-example",
     "main": "src/index.ts", // Ensure this points to your entry file
     "compatibility_date": "2025-03-07",
     "compatibility_flags": ["nodejs_compat"],
     "account_id": "YOUR_CLOUDFLARE_ACCOUNT_ID",
     "d1_databases": [
       {
         "binding": "DB", // How you'll access it in your code (e.g., env.DB)
         "database_name": "my-d1-database-example",
         "database_id": "YOUR_D1_DATABASE_ID", // Get this from the 'wrangler d1 create' output
       },
     ],
     "observability": {
       "enabled": true,
       "head_sampling_rate": 1,
     },
     // Add any necessary vars or secrets if your example requires them
   }
   ```
4. Update the corresponding `worker-configuration.d.ts` file.
5. Create a schema file (e.g., `schema.sql`) and apply it:
   ```sql
   -- schema.sql Example
   DROP TABLE IF EXISTS ExampleData;
   CREATE TABLE ExampleData (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL,
       value REAL,
       timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
   );
   ```
   ```bash
   npx wrangler d1 execute my-d1-database-example --file=./schema.sql
   ```
6. For local development using a local D1 database, add `--local` to the `wrangler dev` command and run the `wrangler d1 execute` command with `--local` as well.
   ```bash
   # Apply schema locally
   npx wrangler d1 execute my-d1-database-example --file=./schema.sql --local
   # Run locally
   bun run dev --local
   ```

## Development

Run locally:

```bash
# Use a local D1 database for development
bun run dev --local

# Or connect to your actual Cloudflare® D1 database (charges may apply)
bun run dev
```

Deploy:

```bash
bun run deploy
```

## API Usage

This example worker might expose simple endpoints (e.g., `/`, `/insert`, `/list`) to demonstrate D1 interaction. Refer to the worker's source code (`src/index.ts`) for specific endpoints and expected request/response formats.

Example (Conceptual):

```http
# Fetch data
GET /

# Insert data
POST /insert
Content-Type: application/json

{
  "name": "Test Item",
  "value": 123.45
}
```

## Security

- Use parameterized queries (`env.DB.prepare(...)`) to prevent SQL injection.
- Avoid exposing sensitive database details in error messages.
- If exposing endpoints publicly, add authentication/authorization.

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a new Pull Request

---

_Cloudflare® and the Cloudflare logo are trademarks and/or registered trademarks of Cloudflare, Inc. in the United States and other jurisdictions._
