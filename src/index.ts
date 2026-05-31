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
  requireInternalAuth,
  createInternalAuthMiddleware,
  corsHeaders,
  withRequestLog,
  type Logger,
} from "@jango-blockchained/hoox-shared/middleware";
import { healthCheck } from "@jango-blockchained/hoox-shared/health";
import { computeDashboardStats } from "./stats";

const logger = createLogger({ service: "d1-worker", module: "router" });

// --- Type Definitions ---

export interface Env extends Cloudflare.Env {
  [key: string]: unknown;
  DB: D1Database;
  CONFIG_KV: KVNamespace;
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

const FORBIDDEN_KEYWORDS = [
  "DROP",
  "PRAGMA",
  "ALTER",
  "TRUNCATE",
  "VACUUM",
  "ATTACH",
  "DETACH",
];

/**
 * Validates a SQL query against an allowlist of tables and forbidden keywords.
 * This is a basic security measure to prevent unauthorized access or destructive operations.
 */
function validateQuery(query: string): { valid: boolean; error?: string } {
  const normalized = query.trim().toUpperCase();

  // 1. Check for forbidden keywords
  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (normalized.includes(keyword)) {
      return { valid: false, error: `Forbidden keyword detected: ${keyword}` };
    }
  }

  // 2. Basic table name extraction and validation
  // This regex looks for words after FROM, JOIN, INTO, UPDATE
  const tableRegex = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-zA-Z0-9_]+)/gi;
  let match;
  const tablesFound = new Set<string>();

  while ((match = tableRegex.exec(query)) !== null) {
    tablesFound.add(match[1].toLowerCase());
  }

  // If no tables found, it might be a simple SELECT 1 or similar, which is fine.
  // But if tables are found, they must be in the allowlist.
  for (const table of tablesFound) {
    if (!TABLE_ALLOWLIST.includes(table)) {
      return { valid: false, error: `Unauthorized table access: ${table}` };
    }
  }

  return { valid: true };
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

      const query = payload.query.trim().toUpperCase();
      const params = payload.params || [];

      // Validate query security
      const validation = validateQuery(payload.query);
      if (!validation.valid) {
        logger.warn("Query validation failed", {
          error: validation.error,
          query: payload.query,
        });
        return Errors.forbidden(validation.error || "Query validation failed");
      }

      logger.info("Executing D1 query", { query: payload.query });
      const stmt = env.DB.prepare(payload.query).bind(...params);

      // Check if query is likely read or write
      if (query.startsWith("SELECT")) {
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
        query.startsWith("INSERT") ||
        query.startsWith("UPDATE") ||
        query.startsWith("DELETE") ||
        query.startsWith("REPLACE")
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
          prefix: query.substring(0, 10),
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
      const logsData = await env.DB.prepare(
        "SELECT * FROM system_logs ORDER BY timestamp DESC LIMIT 50"
      ).all();

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
        return new Response(null, { status: 204, headers: cors });
      }
      const response = await router.handle(request, env, ctx);
      const newResponse = new Response(response.body, response);
      for (const [key, value] of Object.entries(cors)) {
        newResponse.headers.set(key, value);
      }
      return newResponse;
    },
    { service: "d1-worker", module: "router" }
  ),
};
