import type { D1Result } from "@cloudflare/workers-types";
import {
  Errors,
  createJsonResponse,
  toError,
} from "@jango-blockchained/hoox-shared/errors";
import {
  createRouter,
  type MiddlewareHandler,
} from "@jango-blockchained/hoox-shared/router";
import type {
  QueryPayload,
  BatchPayload,
} from "@jango-blockchained/hoox-shared/types";
import { trackAnalytics } from "@jango-blockchained/hoox-shared/analytics";
import {
  createLogger,
  createInternalAuthMiddleware,
  corsHeaders,
  withRequestLog,
  wrapWithSecurityHeaders,
  type Logger,
} from "@jango-blockchained/hoox-shared/middleware";
import { healthCheck } from "@jango-blockchained/hoox-shared/health";
import { computeDashboardStats } from "./stats";

const logger = createLogger({ service: "d1-worker", module: "router" });

// --- Type Definitions ---

export interface Env extends Cloudflare.Env {
  DB: D1Database;
  CONFIG_KV: KVNamespace;
  LOG_LIMIT?: string; // Optional binding, defaults to "50"
}

// Known KV key prefixes the dashboard reads/writes. Mirrors the prefix list
// in workers/dashboard/src/app/api/settings/route.ts — keep them in sync.
const KNOWN_PREFIXES = [
  "global:",
  "webhook:",
  "trade:",
  "agent:",
  "bot:",
  "email:",
  "database:",
  "retention:",
  "routing:",
  "behavior:",
  "cron:",
  "ai:",
] as const;

type KnownPrefix = (typeof KNOWN_PREFIXES)[number];

function hasKnownPrefix(key: string): boolean {
  return KNOWN_PREFIXES.some((prefix) => key.startsWith(prefix));
}

// --- Security Helpers ---

const TABLE_ALLOWLIST = [
  "trade_signals",
  "trades",
  "positions",
  "balances",
  "system_logs",
  "trade_requests",
  "trade_responses",
];

/**
 * Strips SQL comments from a query string to prevent comment-based bypass
 * of validation checks. Handles both single-line (--) and multi-line (/* * /) comments.
 */
function stripSqlComments(sql: string): string {
  let result = "";
  let i = 0;
  while (i < sql.length) {
    // Single-line comment: --
    if (sql[i] === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    // Multi-line comment: /* */
    if (sql[i] === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    result += sql[i];
    i++;
  }
  return result;
}

/**
 * Validates a SQL query for security.
 *
 * SECURITY MODEL:
 * - SQL comments are stripped before validation to prevent bypasses
 * - Only SELECT queries are allowed (writes use parameterized prepared statements)
 * - String literals in query are rejected -> all values must use ? placeholders
 * - Table names validated against allowlist -> 403 Forbidden
 * - UNION and subqueries in WHERE/HAVING are restricted -> 403 Forbidden
 */
function validateQuery(query: string): {
  valid: boolean;
  error?: string;
  statusCode?: number;
} {
  // 0. Strip SQL comments to prevent comment-based bypass of validation
  const cleaned = stripSqlComments(query);
  const normalized = cleaned.trim().toUpperCase();

  // 1. Check query type - only SELECT queries are allowed
  const queryType = normalized.split(/\s+/)[0];
  if (queryType !== "SELECT") {
    return {
      valid: false,
      error: `Unsupported query type: ${queryType}. Only SELECT queries are allowed.`,
      statusCode: 400,
    };
  }

  // 2. Reject string literals - all values must use ? parameter placeholders -> 400
  // Prevents injection via string concatenation like: WHERE id = '1' OR '1'='1'
  const stringLiteralRegex = /'([^']|'')*'/g;
  if (stringLiteralRegex.test(cleaned)) {
    return {
      valid: false,
      error:
        "String literals not allowed in query. Use parameter placeholders (?) instead.",
      statusCode: 400,
    };
  }

  // 3. Reject double-quoted identifiers -> 400
  const doubleQuotedRegex = /"[^"]*"/g;
  if (doubleQuotedRegex.test(cleaned)) {
    return {
      valid: false,
      error: "Quoted identifiers not allowed in query.",
      statusCode: 400,
    };
  }

  // 4. Validate table names against allowlist -> 403
  // Extract table names from FROM, JOIN, INTO, UPDATE clauses
  const tableRegex = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-zA-Z0-9_]+)/gi;
  let match;
  const tablesFound = new Set<string>();

  while ((match = tableRegex.exec(cleaned)) !== null) {
    tablesFound.add(match[1].toLowerCase());
  }

  // If tables are found, they must be in the allowlist
  for (const table of tablesFound) {
    if (!TABLE_ALLOWLIST.includes(table)) {
      return {
        valid: false,
        error: `Unauthorized table access: ${table}`,
        statusCode: 403,
      };
    }
  }

  // 5. Reject UNION (can be used for data exfiltration) -> 403
  if (/\bUNION\b/i.test(cleaned)) {
    return {
      valid: false,
      error: "UNION not allowed in SELECT queries",
      statusCode: 403,
    };
  }

  // 6. Reject subqueries in WHERE/HAVING (complexity/DoS risk) -> 403
  if (/\b(WHERE|HAVING)\s*\(/i.test(cleaned)) {
    return {
      valid: false,
      error: "Subqueries in WHERE/HAVING not allowed",
      statusCode: 403,
    };
  }

  return { valid: true };
}

/**
 * Validates INSERT/UPDATE/DELETE/REPLACE writes from trusted internal callers.
 * Defense-in-depth: table allowlist + no string literals (parameters only).
 */
function validateWriteQuery(query: string): {
  valid: boolean;
  error?: string;
  statusCode?: number;
} {
  const cleaned = stripSqlComments(query);
  const normalized = cleaned.trim().toUpperCase();
  const queryType = normalized.split(/\s+/)[0];

  if (!["INSERT", "UPDATE", "DELETE", "REPLACE"].includes(queryType)) {
    return {
      valid: false,
      error: `Unsupported write type: ${queryType}`,
      statusCode: 400,
    };
  }

  const stringLiteralRegex = /'([^']|'')*'/g;
  if (stringLiteralRegex.test(cleaned)) {
    return {
      valid: false,
      error:
        "String literals not allowed in write query. Use parameter placeholders (?) instead.",
      statusCode: 400,
    };
  }

  const doubleQuotedRegex = /"[^"]*"/g;
  if (doubleQuotedRegex.test(cleaned)) {
    return {
      valid: false,
      error: "Quoted identifiers not allowed in write query.",
      statusCode: 400,
    };
  }

  const tableRegex = /\b(?:INTO|UPDATE|FROM)\s+([a-zA-Z0-9_]+)/gi;
  let match;
  const tablesFound = new Set<string>();
  while ((match = tableRegex.exec(cleaned)) !== null) {
    tablesFound.add(match[1].toLowerCase());
  }

  for (const table of tablesFound) {
    if (!TABLE_ALLOWLIST.includes(table)) {
      return {
        valid: false,
        error: `Unauthorized table access: ${table}`,
        statusCode: 403,
      };
    }
  }

  return { valid: true };
}

const MAX_JSON_BODY_BYTES = 1024 * 1024; // 1 MiB

/**
 * Checks that the request has a JSON Content-Type and a reasonable body size.
 * Returns a Response (error) if validation fails, or null if the body is acceptable.
 *
 * Content-Length is an early reject when present; callers that need a hard
 * cap regardless of headers should read via `readJsonBodyWithLimit`.
 */
function requireJsonBody(request: Request): Response | null {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) {
    return Errors.badRequest("Content-Type must be application/json");
  }
  const contentLength = request.headers.get("Content-Length");
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (isNaN(size) || size > MAX_JSON_BODY_BYTES) {
      return Errors.badRequest("Request body too large (max 1MB)");
    }
  }
  return null;
}

/**
 * Parse JSON body with a hard byte cap (does not trust Content-Length alone).
 */
async function readJsonBodyWithLimit(
  request: Request,
  maxBytes: number = MAX_JSON_BODY_BYTES
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const reader = request.body?.getReader();
  if (!reader) {
    return { ok: false, response: Errors.badRequest("Empty request body") };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return {
          ok: false,
          response: Errors.badRequest("Request body too large (max 1MB)"),
        };
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  try {
    const text = new TextDecoder().decode(merged);
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: Errors.badRequest("Invalid JSON in request body") };
  }
}

// --- Worker Definition ---

const router = createRouter<Env>();
// Cast: createInternalAuthMiddleware returns MiddlewareHandler<InternalAuthEnv>
// but our router is typed for MiddlewareHandler<Env>. The middleware only
// reads `INTERNAL_KEY_BINDING` which is present on both types.
const requireAuth =
  createInternalAuthMiddleware() as unknown as MiddlewareHandler<Env>;

// Health check endpoint
router.get(
  "/health",
  async (_request: Request, env: Env, _ctx: ExecutionContext) => {
    try {
      await env.DB.prepare("SELECT 1").first();
    } catch {
      return Errors.internal("Database unreachable");
    }
    return healthCheck({ worker: "d1-worker" });
  }
);

// Query endpoint
router.post(
  "/query",
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    const startTime = Date.now();

    try {
      const bodyGuard = requireJsonBody(request);
      if (bodyGuard) return bodyGuard;

      const parsedBody = await readJsonBodyWithLimit(request);
      if (!parsedBody.ok) return parsedBody.response;
      const payload = parsedBody.value as QueryPayload;

      if (!payload || typeof payload.query !== "string") {
        return Errors.badRequest(
          "Invalid payload: missing or invalid 'query' field."
        );
      }

      const params = payload.params || [];

      // SELECT reads pass through the full SQL guard; trusted internal
      // writes (INSERT/UPDATE/DELETE/REPLACE) use bound parameters only.
      if (payload.query.trim().toUpperCase().startsWith("SELECT")) {
        const validation = validateQuery(payload.query);
        if (!validation.valid) {
          logger.warn("Query validation failed", {
            error: validation.error,
            query: payload.query,
          });
          const statusCode = validation.statusCode || 403;
          if (statusCode === 400) {
            return Errors.badRequest(
              validation.error || "Query validation failed"
            );
          }
          return Errors.forbidden(validation.error || "Query validation failed");
        }
      }

      logger.info("Executing D1 query", { query: payload.query });
      const stmt = env.DB.prepare(payload.query).bind(...params);

      // Check if query is likely read or write
      if (payload.query.startsWith("SELECT")) {
        const result: D1Result<Record<string, unknown>> = await stmt.all();
        logger.info("D1 SELECT result", { success: result.success });
        if (!result.success) {
          throw new Error(result.error || "D1 SELECT query failed");
        }
        const response = createJsonResponse({
          success: true,
          results: result.results,
        });

        // Track SELECT analytics (non-blocking)
        const selectLatency = Date.now() - startTime;
        ctx.waitUntil(
          trackAnalytics(env, "/track/api-call", {
            worker: "d1-worker",
            endpoint: "/query",
            latencyMs: selectLatency,
            success: true,
            queryType: "SELECT",
          }).catch((err) =>
            logger.error("trackAnalytics failed", { error: String(err) })
          )
        );

        return response;
      } else if (
        payload.query.startsWith("INSERT") ||
        payload.query.startsWith("UPDATE") ||
        payload.query.startsWith("DELETE") ||
        payload.query.startsWith("REPLACE")
      ) {
        const writeValidation = validateWriteQuery(payload.query);
        if (!writeValidation.valid) {
          logger.warn("Write query validation failed", {
            error: writeValidation.error,
            query: payload.query,
          });
          const statusCode = writeValidation.statusCode || 403;
          if (statusCode === 400) {
            return Errors.badRequest(
              writeValidation.error || "Write query validation failed"
            );
          }
          return Errors.forbidden(
            writeValidation.error || "Write query validation failed"
          );
        }

        const result: D1Result = await stmt.run();
        logger.info("D1 write result", {
          success: result.success,
          changes: result.meta?.changes,
        });
        if (!result.success) {
          throw new Error(result.error || "D1 write query failed");
        }
        const response = createJsonResponse({
          success: true,
          lastRowId: result.meta?.last_row_id ?? null,
          changes: result.meta?.changes ?? null,
        });

        // Track API call analytics (non-blocking)
        const latencyMs = Date.now() - startTime;
        ctx.waitUntil(
          trackAnalytics(env, "/track/api-call", {
            worker: "d1-worker",
            endpoint: "/query",
            latencyMs,
            success: true,
            queryType: "WRITE",
          }).catch((err) =>
            logger.error("trackAnalytics failed", { error: String(err) })
          )
        );

        return response;
      } else {
        logger.warn("Unsupported query type", {
          prefix: payload.query.substring(0, 10),
        });
        return Errors.badRequest(
          "Unsupported query type (must be SELECT, INSERT, UPDATE, DELETE, REPLACE)"
        );
      }
    } catch (error) {
      const errorMsg = toError(error);
      logger.error("Query error", { error: errorMsg });

      // Track failed API call (non-blocking)
      const latencyMs = Date.now() - startTime;
      ctx.waitUntil(
        trackAnalytics(env, "/track/api-call", {
          worker: "d1-worker",
          endpoint: "/query",
          latencyMs,
          success: false,
        }).catch((err) =>
          logger.error("trackAnalytics failed", { error: String(err) })
        )
      );

      return Errors.internal(errorMsg);
    }
  },
  [requireAuth]
);

// Batch endpoint
router.post(
  "/batch",
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    const startTime = Date.now();

    try {
      const bodyGuard = requireJsonBody(request);
      if (bodyGuard) return bodyGuard;

      const parsedBody = await readJsonBodyWithLimit(request);
      if (!parsedBody.ok) return parsedBody.response;
      const payload = parsedBody.value as BatchPayload;

      if (!payload || !Array.isArray(payload.statements)) {
        return Errors.badRequest("Missing or invalid statements array");
      }

      // Validate all statements before batch execution.
      // SELECT → full read guard; writes → table allowlist + no literals.
      for (const stmt of payload.statements) {
        if (typeof stmt.query !== "string" || !stmt.query.trim()) {
          return Errors.badRequest("Each statement must have a 'query' field");
        }

        const isSelect = stmt.query.trim().toUpperCase().startsWith("SELECT");
        const validation = isSelect
          ? validateQuery(stmt.query)
          : validateWriteQuery(stmt.query);
        if (!validation.valid) {
          logger.warn("Batch statement validation failed", {
            error: validation.error,
            query: stmt.query,
          });
          const statusCode = validation.statusCode || 403;
          if (statusCode === 400) {
            return Errors.badRequest(
              validation.error || "Statement validation failed"
            );
          }
          return Errors.forbidden(
            validation.error || "Statement validation failed"
          );
        }
      }

      // Use native DB.batch() for atomic, faster execution
      const stmts = payload.statements.map((s) => {
        const prepared = env.DB.prepare(s.query);
        if (s.params && s.params.length > 0) {
          return prepared.bind(...s.params);
        }
        return prepared;
      });
      const results = await env.DB.batch(stmts);

      // Check for partial failures
      const failedResult = results.find((r) => r.error);
      const allSuccess = !failedResult;

      // Track API call analytics (non-blocking)
      const latencyMs = Date.now() - startTime;
      ctx.waitUntil(
        trackAnalytics(env, "/track/api-call", {
          worker: "d1-worker",
          endpoint: "/batch",
          latencyMs,
          success: allSuccess,
        }).catch((err) =>
          logger.error("trackAnalytics failed", { error: String(err) })
        )
      );

      if (!allSuccess) {
        return createJsonResponse({
          success: false,
          error: failedResult.error || "Batch statement failed",
          results,
        });
      }

      return createJsonResponse({ success: true, results });
    } catch (error) {
      const errorMsg = toError(error);
      logger.error("Batch error", { error: errorMsg });

      // Track failed API call (non-blocking)
      const latencyMs = Date.now() - startTime;
      ctx.waitUntil(
        trackAnalytics(env, "/track/api-call", {
          worker: "d1-worker",
          endpoint: "/batch",
          latencyMs,
          success: false,
        }).catch((err) =>
          logger.error("trackAnalytics failed", { error: String(err) })
        )
      );

      return Errors.internal(errorMsg);
    }
  },
  [requireAuth]
);

// Dashboard settings endpoint
router.get(
  "/api/settings",
  async (_request: Request, env: Env, _ctx: ExecutionContext) => {
    try {
      const settings: Record<string, unknown> = {};

      const prefixes: readonly KnownPrefix[] = KNOWN_PREFIXES;

      // List all prefixes in parallel
      const lists = await Promise.all(
        prefixes.map((prefix) => env.CONFIG_KV.list({ prefix }))
      );

      // Collect all key names from all lists
      const allKeys: string[] = [];
      for (const list of lists) {
        allKeys.push(...list.keys.map((k) => k.name));
      }

      // Get all values in parallel
      const values = await Promise.all(
        allKeys.map((key) => env.CONFIG_KV.get(key))
      );

      // Build settings object
      for (let i = 0; i < allKeys.length; i++) {
        const data = values[i];
        if (data) {
          try {
            settings[allKeys[i]] = JSON.parse(data);
          } catch {
            settings[allKeys[i]] = data;
          }
        }
      }

      return createJsonResponse({ success: true, settings });
    } catch (error) {
      const errorMsg = toError(error);
      logger.error("Settings error", { error: errorMsg });
      return Errors.internal(errorMsg);
    }
  },
  [requireAuth]
);

// Dashboard settings POST endpoint
router.post(
  "/api/settings",
  async (request: Request, env: Env, _ctx: ExecutionContext) => {
    try {
      const bodyGuard = requireJsonBody(request);
      if (bodyGuard) return bodyGuard;

      const parsedBody = await readJsonBodyWithLimit(request);
      if (!parsedBody.ok) return parsedBody.response;
      const payload = parsedBody.value as Record<string, unknown>;

      const key = payload.key;
      if (!key || typeof key !== "string") {
        return Errors.badRequest("Missing key");
      }

      // The dashboard already sends fully-prefixed keys (e.g. "global:kill_switch").
      // Store the key as-is to avoid double-prefixing. Validate it starts with one
      // of the known prefixes to keep the KV namespace well-formed.
      if (!hasKnownPrefix(key)) {
        return Errors.badRequest(
          `Key must start with one of: ${KNOWN_PREFIXES.join(", ")}`
        );
      }

      await env.CONFIG_KV.put(key, JSON.stringify(payload.value ?? {}));

      return createJsonResponse({ success: true, key });
    } catch (error) {
      const errorMsg = toError(error);
      logger.error("Settings POST error", { error: errorMsg });
      return Errors.internal(errorMsg);
    }
  },
  [requireAuth]
);

// --- Extracted Handler Functions ---

async function handleGetBalances(env: Env, logger: Logger): Promise<Response> {
  try {
    const latestSnapshots = await env.DB.prepare(
      `
    SELECT b.exchange, b.asset, b.total, b.timestamp
    FROM balances b
    INNER JOIN (
      SELECT exchange, asset, MAX(timestamp) as max_time
      FROM balances
      GROUP BY exchange, asset
    ) latest ON b.exchange = latest.exchange AND b.asset = latest.asset AND b.timestamp = latest.max_time
  `
    ).all();

    const totalBalance = (latestSnapshots.results || []).reduce(
      (sum: number, row: Record<string, unknown>) => {
        return sum + ((row.total as number) || 0);
      },
      0
    );

    return createJsonResponse({
      success: true,
      totalBalance,
      balances: latestSnapshots.results || [],
    });
  } catch (error) {
    const errorMsg = toError(error);
    logger.error("Balances error", { error: errorMsg });
    return Errors.internal(errorMsg);
  }
}

async function handleGetPositions(env: Env, logger: Logger): Promise<Response> {
  try {
    const positionsData = await env.DB.prepare(
      "SELECT * FROM positions WHERE status = 'OPEN' ORDER BY updated_at DESC"
    ).all();

    return createJsonResponse({
      success: true,
      positions: positionsData.results || [],
    });
  } catch (error) {
    const errorMsg = toError(error);
    logger.error("Positions error", { error: errorMsg });
    return Errors.internal(errorMsg);
  }
}

// Dashboard balances endpoint
router.get(
  "/api/balances",
  async (_request: Request, env: Env, _ctx: ExecutionContext) =>
    handleGetBalances(env, logger),
  [requireAuth]
);

// Dashboard positions endpoint
router.get(
  "/api/positions",
  async (_request: Request, env: Env, _ctx: ExecutionContext) =>
    handleGetPositions(env, logger),
  [requireAuth]
);

// Dashboard-prefixed aliases for agent-worker compatibility
router.get(
  "/api/dashboard/balances",
  async (_request: Request, env: Env, _ctx: ExecutionContext) =>
    handleGetBalances(env, logger),
  [requireAuth]
);

router.get(
  "/api/dashboard/positions",
  async (_request: Request, env: Env, _ctx: ExecutionContext) =>
    handleGetPositions(env, logger),
  [requireAuth]
);

// Dashboard logs endpoint
router.get(
  "/api/logs",
  async (_request: Request, env: Env, _ctx: ExecutionContext) => {
    try {
      const limit = Math.min(
        Math.max(parseInt(env.LOG_LIMIT || "50", 10) || 50, 1),
        1000
      );
      const logsData = await env.DB.prepare(
        "SELECT id, timestamp, level, module, message, context FROM system_logs ORDER BY timestamp DESC LIMIT ?"
      )
        .bind(limit)
        .all();

      return createJsonResponse({
        success: true,
        logs: logsData.results || [],
      });
    } catch (error) {
      const errorMsg = toError(error);
      logger.error("Logs error", { error: errorMsg });
      return Errors.internal(errorMsg);
    }
  },
  [requireAuth]
);

// Dashboard stats endpoint
router.get(
  "/api/dashboard/stats",
  async (_request: Request, env: Env, _ctx: ExecutionContext) => {
    const result = await computeDashboardStats(env.DB);
    if ("error" in result) {
      logger.error("Dashboard stats error", { error: result.error });
      return Errors.internal(result.error);
    }
    return createJsonResponse({ success: true, stats: result.stats });
  },
  [requireAuth]
);

// ── Named RPC write endpoints ──────────────────────────────────────
// Prefer these over free-form /query for internal writers. Fixed SQL
// templates eliminate injection surface and keep the table allowlist
// implicit in the route.

async function rpcJsonBody(
  request: Request
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const bodyGuard = requireJsonBody(request);
  if (bodyGuard) return { ok: false, response: bodyGuard };
  const parsed = await readJsonBodyWithLimit(request);
  if (!parsed.ok) return parsed;
  if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return {
      ok: false,
      response: Errors.badRequest("Body must be a JSON object"),
    };
  }
  return { ok: true, value: parsed.value as Record<string, unknown> };
}

/** POST /rpc/insert-trade — insert a executed trade row */
router.post(
  "/rpc/insert-trade",
  async (request: Request, env: Env, _ctx: ExecutionContext) => {
    const body = await rpcJsonBody(request);
    if (!body.ok) return body.response;
    const b = body.value;
    const id = typeof b.id === "string" ? b.id : crypto.randomUUID();
    const timestamp =
      typeof b.timestamp === "number"
        ? b.timestamp
        : Math.floor(Date.now() / 1000);
    const exchange = String(b.exchange ?? "");
    const symbol = String(b.symbol ?? "");
    const action = String(b.action ?? "");
    const quantity = Number(b.quantity);
    if (!exchange || !symbol || !action || !Number.isFinite(quantity)) {
      return Errors.badRequest(
        "Required: exchange, symbol, action, quantity"
      );
    }
    try {
      const result = await env.DB.prepare(
        `INSERT INTO trades (id, timestamp, exchange, symbol, action, quantity, price, leverage, status, raw_response)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          id,
          timestamp,
          exchange,
          symbol,
          action,
          quantity,
          b.price ?? null,
          b.leverage ?? null,
          String(b.status ?? "EXECUTED"),
          typeof b.raw_response === "string"
            ? b.raw_response
            : JSON.stringify(b.raw_response ?? null)
        )
        .run();
      if (!result.success) {
        throw new Error(result.error || "insert-trade failed");
      }
      return createJsonResponse({
        success: true,
        id,
        changes: result.meta?.changes ?? null,
      });
    } catch (error) {
      logger.error("rpc/insert-trade failed", { error: toError(error) });
      return Errors.internal(toError(error));
    }
  },
  [requireAuth]
);

/** POST /rpc/upsert-position — REPLACE a positions row */
router.post(
  "/rpc/upsert-position",
  async (request: Request, env: Env, _ctx: ExecutionContext) => {
    const body = await rpcJsonBody(request);
    if (!body.ok) return body.response;
    const b = body.value;
    const id = String(b.id ?? "");
    const exchange = String(b.exchange ?? "");
    const symbol = String(b.symbol ?? "");
    const side = String(b.side ?? "");
    const size = Number(b.size);
    const status = String(b.status ?? "OPEN");
    const updatedAt =
      typeof b.updated_at === "number"
        ? b.updated_at
        : Math.floor(Date.now() / 1000);
    if (!id || !exchange || !symbol || !side || !Number.isFinite(size)) {
      return Errors.badRequest(
        "Required: id, exchange, symbol, side, size"
      );
    }
    try {
      const result = await env.DB.prepare(
        `REPLACE INTO positions (id, exchange, symbol, side, size, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(id, exchange, symbol, side, size, status, updatedAt)
        .run();
      if (!result.success) {
        throw new Error(result.error || "upsert-position failed");
      }
      return createJsonResponse({
        success: true,
        id,
        changes: result.meta?.changes ?? null,
      });
    } catch (error) {
      logger.error("rpc/upsert-position failed", { error: toError(error) });
      return Errors.internal(toError(error));
    }
  },
  [requireAuth]
);

/** POST /rpc/insert-signal — insert a trade_signals row */
router.post(
  "/rpc/insert-signal",
  async (request: Request, env: Env, _ctx: ExecutionContext) => {
    const body = await rpcJsonBody(request);
    if (!body.ok) return body.response;
    const b = body.value;
    const signalId =
      typeof b.signal_id === "string" ? b.signal_id : crypto.randomUUID();
    const timestamp = Number(b.timestamp);
    const symbol = String(b.symbol ?? "");
    const signalType = String(b.signal_type ?? "");
    if (!symbol || !signalType || !Number.isFinite(timestamp)) {
      return Errors.badRequest(
        "Required: symbol, signal_type, timestamp"
      );
    }
    try {
      const result = await env.DB.prepare(
        `INSERT INTO trade_signals (signal_id, timestamp, symbol, signal_type, source, raw_data)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          signalId,
          timestamp,
          symbol,
          signalType,
          b.source ?? null,
          typeof b.raw_data === "string"
            ? b.raw_data
            : JSON.stringify(b.raw_data ?? null)
        )
        .run();
      if (!result.success) {
        throw new Error(result.error || "insert-signal failed");
      }
      return createJsonResponse({ success: true, signal_id: signalId });
    } catch (error) {
      logger.error("rpc/insert-signal failed", { error: toError(error) });
      return Errors.internal(toError(error));
    }
  },
  [requireAuth]
);

/** POST /rpc/insert-system-log — insert a system_logs row */
router.post(
  "/rpc/insert-system-log",
  async (request: Request, env: Env, _ctx: ExecutionContext) => {
    const body = await rpcJsonBody(request);
    if (!body.ok) return body.response;
    const b = body.value;
    const level = String(b.level ?? "INFO");
    const source = String(b.source ?? "unknown");
    const message = String(b.message ?? "");
    if (!message) {
      return Errors.badRequest("Required: message");
    }
    try {
      const result = await env.DB.prepare(
        `INSERT INTO system_logs (level, source, message, details) VALUES (?, ?, ?, ?)`
      )
        .bind(
          level,
          source,
          message,
          typeof b.details === "string"
            ? b.details
            : JSON.stringify(b.details ?? null)
        )
        .run();
      if (!result.success) {
        throw new Error(result.error || "insert-system-log failed");
      }
      return createJsonResponse({
        success: true,
        changes: result.meta?.changes ?? null,
      });
    } catch (error) {
      logger.error("rpc/insert-system-log failed", { error: toError(error) });
      return Errors.internal(toError(error));
    }
  },
  [requireAuth]
);

export default {
  fetch: withRequestLog(
    async (
      request: Request,
      env: Env,
      ctx: ExecutionContext
    ): Promise<Response> => {
      const cors = corsHeaders();
      if (request.method === "OPTIONS") {
        return wrapWithSecurityHeaders(
          new Response(null, { status: 204, headers: cors })
        );
      }
      try {
        const response = await router.handle(request, env, ctx);
        const newResponse = new Response(response.body, response);
        for (const [key, value] of Object.entries(cors)) {
          newResponse.headers.set(key, value);
        }
        return wrapWithSecurityHeaders(newResponse);
      } catch (error) {
        logger.error("Unhandled router error", { error: toError(error) });
        return wrapWithSecurityHeaders(Errors.internal(toError(error)));
      }
    },
    { service: "d1-worker", module: "router" }
  ),
};
