import type { D1Result } from "@cloudflare/workers-types";
import {
  Errors,
  createJsonResponse,
  toError,
} from "@jango-blockchained/hoox-shared/errors";
import { createRouter } from "@jango-blockchained/hoox-shared/router";
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
 * Checks that the request has a JSON Content-Type and a reasonable body size.
 * Returns a Response (error) if validation fails, or null if the body is acceptable.
 */
function requireJsonBody(request: Request): Response | null {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) {
    return Errors.badRequest("Content-Type must be application/json");
  }
  // Check body size roughly (Content-Length header)
  const contentLength = request.headers.get("Content-Length");
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (isNaN(size) || size > 1024 * 1024) {
      return Errors.badRequest("Request body too large (max 1MB)");
    }
  }
  return null;
}

// --- Worker Definition ---

const router = createRouter<Env>();
const requireAuth = createInternalAuthMiddleware();

// Health check endpoint
router.get(
  "/health",
  async (request: Request, env: Env, ctx: ExecutionContext) => {
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

      let payload: QueryPayload;
      try {
        payload = await request.json();
      } catch {
        return Errors.badRequest("Invalid JSON in request body");
      }

      if (!payload || typeof payload.query !== "string") {
        return Errors.badRequest(
          "Invalid payload: missing or invalid 'query' field."
        );
      }

      const params = payload.params || [];

      // Validate query security
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
          })
        );

        return response;
      } else if (
        payload.query.startsWith("INSERT") ||
        payload.query.startsWith("UPDATE") ||
        payload.query.startsWith("DELETE") ||
        payload.query.startsWith("REPLACE")
      ) {
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
          })
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
        })
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

      let payload: BatchPayload;
      try {
        payload = await request.json();
      } catch {
        return Errors.badRequest("Invalid JSON in request body");
      }

      if (!payload || !Array.isArray(payload.statements)) {
        return Errors.badRequest("Missing or invalid statements array");
      }

      // Validate all statements before batch execution
      for (const stmt of payload.statements) {
        if (typeof stmt.query !== "string" || !stmt.query.trim()) {
          return Errors.badRequest("Each statement must have a 'query' field");
        }

        const validation = validateQuery(stmt.query);
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
        })
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
        })
      );

      return Errors.internal(errorMsg);
    }
  },
  [requireAuth]
);

// Dashboard settings endpoint
router.get(
  "/api/settings",
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    try {
      const settings: Record<string, unknown> = {};

      const prefixes = ["global:", "webhook:", "trade:", "agent:"];

      for (const prefix of prefixes) {
        const list = await env.CONFIG_KV.list({ prefix });
        for (const key of list.keys) {
          const data = await env.CONFIG_KV.get(key.name);
          if (data) {
            try {
              settings[key.name] = JSON.parse(data);
            } catch {
              settings[key.name] = data;
            }
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
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    try {
      const bodyGuard = requireJsonBody(request);
      if (bodyGuard) return bodyGuard;

      let payload: Record<string, unknown>;
      try {
        payload = await request.json();
      } catch {
        return Errors.badRequest("Invalid JSON in request body");
      }

      const key = payload.key;
      if (!key || typeof key !== "string") {
        return Errors.badRequest("Missing key");
      }

      const worker =
        typeof payload.worker === "string" ? payload.worker : "default";
      const configKey = `${worker}:${key}`;

      await env.CONFIG_KV.put(configKey, JSON.stringify(payload.value ?? {}));

      return createJsonResponse({ success: true, key: configKey });
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
  async (request: Request, env: Env, ctx: ExecutionContext) =>
    handleGetBalances(env, logger),
  [requireAuth]
);

// Dashboard positions endpoint
router.get(
  "/api/positions",
  async (request: Request, env: Env, ctx: ExecutionContext) =>
    handleGetPositions(env, logger),
  [requireAuth]
);

// Dashboard-prefixed aliases for agent-worker compatibility
router.get(
  "/api/dashboard/balances",
  async (request: Request, env: Env, ctx: ExecutionContext) =>
    handleGetBalances(env, logger),
  [requireAuth]
);

router.get(
  "/api/dashboard/positions",
  async (request: Request, env: Env, ctx: ExecutionContext) =>
    handleGetPositions(env, logger),
  [requireAuth]
);

// Dashboard logs endpoint
router.get(
  "/api/logs",
  async (request: Request, env: Env, ctx: ExecutionContext) => {
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
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    const result = await computeDashboardStats(env.DB);
    if ("error" in result) {
      logger.error("Dashboard stats error", { error: result.error });
      return Errors.internal(result.error);
    }
    return createJsonResponse({ success: true, stats: result.stats });
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
