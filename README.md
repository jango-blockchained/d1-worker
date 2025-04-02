# D1 Worker

A Cloudflare Worker service that provides a centralized database interface for other workers in the hoox trading system. This worker manages the D1 database operations and provides a secure API for data access.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yourusername/hoox-trading/tree/main/d1-worker)

## Features

- Centralized database operations
- Secure API with authentication via internal service key
- Support for single queries and batch operations
- Error handling and logging
- SQL injection prevention through parameterized queries

## Prerequisites

- Node.js >= 16
- Bun (for package management)
- Wrangler CLI
- Cloudflare Workers account with D1 database access

## Setup

1. Install dependencies:
```bash
bun install
```

2. Create a D1 database:
```bash
wrangler d1 create hoox-trading-db
```

3. Update the database_id in `wrangler.toml` with the ID from the previous command.

4. Set your Cloudflare account ID in `wrangler.toml`:
```toml
name = "d1-worker"
account_id = "your_account_id_here"
main = "src/index.js"
```

5. Configure environment variables in `.dev.vars` for local development:
```env
INTERNAL_SERVICE_KEY=your_internal_key
```

6. Configure production secrets:
```bash
wrangler secret put INTERNAL_SERVICE_KEY
```

## Development

### Local Development

For local development, this worker should run on port 8787:

```bash
# Use a local D1 database for development
bun run dev -- --port 8787 --local

# Or connect to your actual Cloudflare D1 database (charges apply)
bun run dev -- --port 8787
```

The worker uses environment variables from `.dev.vars` during local development instead of the values in `wrangler.toml` or Cloudflare secrets.

### Production Deployment

Deploy to production:
```bash
bun run deploy
```

## API Usage

### Single Query

```http
POST /query
Content-Type: application/json
X-Internal-Key: your_internal_key
X-Request-ID: unique_request_id

{
  "query": "SELECT * FROM trade_requests WHERE id = ?",
  "params": [123]
}
```

#### Response Format (SELECT)

```json
{
  "success": true,
  "results": [
    {
      "id": 123,
      "timestamp": "2024-03-26T12:00:00Z",
      "method": "POST",
      "path": "/trade"
    }
  ]
}
```

#### Response Format (INSERT, UPDATE, DELETE)

```json
{
  "success": true,
  "lastRowId": 124,
  "changes": 1
}
```

### Batch Operations

```http
POST /batch
Content-Type: application/json
X-Internal-Key: your_internal_key
X-Request-ID: unique_request_id

{
  "statements": [
    {
      "query": "INSERT INTO trade_requests (method, path) VALUES (?, ?)",
      "params": ["POST", "/trade"]
    },
    {
      "query": "UPDATE trade_responses SET error = ? WHERE request_id = ?",
      "params": ["Connection timeout", 123]
    }
  ]
}
```

#### Response Format (Batch)

```json
{
  "success": true,
  "results": [
    {
      "meta": {
        "last_row_id": 124,
        "changes": 1
      }
    },
    {
      "meta": {
        "changes": 1
      }
    }
  ]
}
```

## Database Schema

### Trade Requests Table
```sql
CREATE TABLE trade_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    headers TEXT,
    body TEXT,
    source_ip TEXT,
    user_agent TEXT
);
```

### Trade Responses Table
```sql
CREATE TABLE trade_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    status_code INTEGER,
    headers TEXT,
    body TEXT,
    error TEXT,
    execution_time_ms INTEGER,
    FOREIGN KEY (request_id) REFERENCES trade_requests(id)
);
```

## Security

- All requests must include a valid X-Internal-Key header
- All requests must include an X-Request-ID header
- Parameterized queries to prevent SQL injection
- Error messages don't expose database details

## Error Handling

The worker includes error handling for:
- Authentication failures
- Invalid SQL queries
- Database connection issues
- Parameter validation
- Batch operation failures

## Error Response Format

```json
{
  "success": false,
  "error": "Error message"
}
```

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a new Pull Request 