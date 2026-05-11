import type {
  D1Database,
  D1Result,
  KVNamespace,
} from "@cloudflare/workers-types";
import {
  Errors,
  createJsonResponse,
} from "@jango-blockchained/hoox-shared/errors";
import { createRouter } from "@jango-blockchained/hoox-shared/router";
import type { Handler } from "@jango-blockchained/hoox-shared/types/router";
import type {
  QueryPayload,
  BatchPayload,
} from "@jango-blockchained/hoox-shared/types";
import { trackAnalytics } from "@jango-blockchained/hoox-shared/analytics";
import type { AnalyticsEnv } from "@jango-blockchained/hoox-shared/analytics";
import {
  createLogger,
  requireInternalAuth,
  corsHeaders,
  withRequestLog,
} from "@jango-blockchained/hoox-shared/middleware";
import { healthCheck } from "@jango-blockchained/hoox-shared/health";

// --- Type Definitions ---

interface Env extends AnalyticsEnv {
  DB: D1Database;
  CONFIG_KV: KVNamespace;
  D1_INTERNAL_KEY?: string;
}

// --- Worker Definition ---

const router = createRouter<Env>();

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

    // Internal authentication check
    const authError = requireInternalAuth(request, env, "D1_INTERNAL_KEY");
    if (authError) return authError;

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

      console.log(`Executing D1 query:`, payload.query);
      const stmt = env.DB.prepare(payload.query).bind(...params);

      // Check if query is likely read or write
      if (query.startsWith("SELECT")) {
        const result: D1Result<Record<string, unknown>> = await stmt.all();
        console.log(`D1 SELECT result: success=${result.success}`);
        if (!result.success) {
          throw new Error(result.error || "D1 SELECT query failed");
        }
        return createJsonResponse({ success: true, results: result.results });
      } else if (
        query.startsWith("INSERT") ||
        query.startsWith("UPDATE") ||
        query.startsWith("DELETE") ||
        query.startsWith("REPLACE")
      ) {
        const result: D1Result = await stmt.run();
        console.log(
          `D1 write result: success=${result.success}, changes=${result.meta?.changes}`
        );
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
        trackAnalytics(env, "/track/api-call", {
          worker: "d1-worker",
          endpoint: "/query",
          latencyMs,
          success: true,
        });

        return response;
      } else {
        console.warn(
          `Unsupported query type starting with: ${query.substring(0, 10)}...`
        );
        return Errors.badRequest(
          "Unsupported query type (must be SELECT, INSERT, UPDATE, DELETE, REPLACE)"
        );
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Query error: ${errorMsg}`);

      // Track failed API call (non-blocking)
      const latencyMs = Date.now() - startTime;
      trackAnalytics(env, "/track/api-call", {
        worker: "d1-worker",
        endpoint: "/query",
        latencyMs,
        success: false,
      });

      return Errors.internal(errorMsg);
    }
  }
);

// Batch endpoint
router.post(
  "/batch",
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    const startTime = Date.now();

    // Internal authentication check
    const internalKey = env.D1_INTERNAL_KEY;
    if (internalKey) {
      const providedKey = request.headers.get("X-Internal-Auth-Key");
      if (!providedKey || providedKey !== internalKey) {
        return Errors.unauthorized();
      }
    }

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

      const results = [];
      for (const stmt of payload.statements) {
        if (typeof stmt.query !== "string" || !stmt.query.trim()) {
          return Errors.badRequest("Each statement must have a 'query' field");
        }
        const result = await env.DB.prepare(stmt.query);
        if (stmt.params && stmt.params.length > 0) {
          result.bind(...stmt.params);
        }
        const response = await result.run();
        results.push(response);
      }

      // Check for partial failures
      const failedResult = results.find((r) => r.success === false);
      const allSuccess = !failedResult;

      // Track API call analytics (non-blocking)
      const latencyMs = Date.now() - startTime;
      trackAnalytics(env, "/track/api-call", {
        worker: "d1-worker",
        endpoint: "/batch",
        latencyMs,
        success: allSuccess,
      });

      if (!allSuccess) {
        return createJsonResponse({
          success: false,
          error: failedResult.error || "Batch statement failed",
          results,
        });
      }

      return createJsonResponse({ success: true, results });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Batch error: ${errorMsg}`);

      // Track failed API call (non-blocking)
      const latencyMs = Date.now() - startTime;
      trackAnalytics(env, "/track/api-call", {
        worker: "d1-worker",
        endpoint: "/batch",
        latencyMs,
        success: false,
      });

      return Errors.internal(errorMsg);
    }
  }
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

      return new Response(JSON.stringify({ success: true, settings }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Settings error: ${errorMsg}`);
      return Errors.internal(errorMsg);
    }
  }
);

// Dashboard settings POST endpoint
router.post(
  "/api/settings",
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    const internalKey = env.D1_INTERNAL_KEY;
    if (internalKey) {
      const providedKey = request.headers.get("X-Internal-Auth-Key");
      if (!providedKey || providedKey !== internalKey) {
        return Errors.unauthorized();
      }
    }

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
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Settings POST error: ${errorMsg}`);
      return Errors.internal(errorMsg);
    }
  }
);

// Dashboard balances endpoint
router.get(
  "/api/balances",
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    try {
      const latestSnapshots = await env.DB.prepare(
        `
      SELECT b.exchange, b.asset, b.total, b.snapshot_at
      FROM balances b
      INNER JOIN (
        SELECT exchange, asset, MAX(snapshot_at) as max_time
        FROM balances
        GROUP BY exchange, asset
      ) latest ON b.exchange = latest.exchange AND b.asset = latest.asset AND b.snapshot_at = latest.max_time
    `
      ).all();

      const totalBalance = (latestSnapshots.results || []).reduce(
        (sum: number, row: any) => {
          return sum + (row.total || 0);
        },
        0
      );

      return new Response(
        JSON.stringify({
          success: true,
          totalBalance,
          balances: latestSnapshots.results || [],
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Balances error: ${errorMsg}`);
      return Errors.internal(errorMsg);
    }
  }
);

// Dashboard positions endpoint
router.get(
  "/api/positions",
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    try {
      const positionsData = await env.DB.prepare(
        "SELECT * FROM positions WHERE status = 'OPEN' ORDER BY updated_at DESC"
      ).all();

      return new Response(
        JSON.stringify({
          success: true,
          positions: positionsData.results || [],
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Positions error: ${errorMsg}`);
      return Errors.internal(errorMsg);
    }
  }
);

// Dashboard logs endpoint
router.get(
  "/api/logs",
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    try {
      const logsData = await env.DB.prepare(
        "SELECT * FROM system_logs ORDER BY timestamp DESC LIMIT 50"
      ).all();

      return new Response(
        JSON.stringify({ success: true, logs: logsData.results || [] }),
        { headers: { "Content-Type": "application/json" } }
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Logs error: ${errorMsg}`);
      return Errors.internal(errorMsg);
    }
  }
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
        return new Response(null, { headers: cors });
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
