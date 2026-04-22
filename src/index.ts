import { log } from '@shared/utils';
import type { D1Database, D1Result, KVNamespace, SecretBinding } from "@cloudflare/workers-types";

// --- Type Definitions ---

interface Env {
  DB: D1Database;
  CONFIG_KV: KVNamespace;
  D1_INTERNAL_KEY?: SecretBinding;
}

interface QueryPayload {
    query: string;
    params?: any[]; // D1 params can be various types
}

interface BatchPayload {
    statements: QueryPayload[];
}

interface StandardResponse {
  success: boolean;
  results?: unknown[]; // For SELECT queries
  lastRowId?: number | null; // For INSERT
  changes?: number | null; // For INSERT/UPDATE/DELETE
  error?: string | null;
}

// --- Worker Definition ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return await handleRequest(request, env);
  },
};

// --- Helper Function ---

function createJsonResponse(
  body: StandardResponse,
  status: number = 200
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// --- Request Handler ---

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const requestId = request.headers.get("X-Request-ID") || "unknown"; // Get tracing ID if present

  console.log(`[${requestId}] D1 Worker received request: ${request.method} ${path}`);

  // Internal authentication check
  const internalKey = await env.D1_INTERNAL_KEY?.get();
  if (internalKey) {
    const providedKey = request.headers.get("X-Internal-Auth-Key");
    if (!providedKey || providedKey !== internalKey) {
      console.warn(`[${requestId}] Unauthorized request to ${path} - invalid or missing internal auth key`);
      return createJsonResponse({ success: false, error: "Unauthorized" }, 401);
    }
  }

  try {
    // Basic path-based routing
    switch (path) {
      case "/query": {
        if (request.method !== "POST") {
          return createJsonResponse({ success: false, error: "Method Not Allowed" }, 405);
        }
        // Validate payload structure
        let payload: QueryPayload;
        try {
            payload = await request.json();
            if (!payload || typeof payload.query !== 'string') {
                 throw new Error("Invalid payload: missing or invalid 'query' field.");
            }
        } catch (e: unknown) {
            const errorMsg = e instanceof Error ? e.message : "Invalid JSON payload";
             console.error(`[${requestId}] Payload parsing error for /query:`, errorMsg);
            return createJsonResponse({ success: false, error: errorMsg }, 400);
        }

        const query = payload.query.trim().toUpperCase();
        const params = payload.params || [];

        console.log(`[${requestId}] Executing D1 query:`, payload.query);
        const stmt = env.DB.prepare(payload.query).bind(...params);

        // Check if query is likely read or write
        if (query.startsWith("SELECT")) {
           const result: D1Result<Record<string, unknown>> = await stmt.all();
           console.log(`[${requestId}] D1 SELECT result: success=${result.success}`);
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
            console.log(`[${requestId}] D1 write result: success=${result.success}, changes=${result.meta?.changes}`);
            if (!result.success) {
                throw new Error(result.error || "D1 write query failed");
            }
            return createJsonResponse({
                success: true,
                lastRowId: result.meta?.last_row_id ?? null,
                changes: result.meta?.changes ?? null,
            });
        } else {
             console.warn(`[${requestId}] Unsupported query type starting with: ${query.substring(0, 10)}...`);
             return createJsonResponse({ success: false, error: "Unsupported query type (must be SELECT, INSERT, UPDATE, DELETE, REPLACE)"}, 400);
        }
      }

      case "/api/dashboard/stats": {
        if (request.method !== "GET") return createJsonResponse({ success: false, error: "Method Not Allowed" }, 405);
        try {
          const totalTrades = await env.DB.prepare("SELECT COUNT(*) as count FROM trades").first("count");
          const openPositions = await env.DB.prepare("SELECT COUNT(*) as count FROM positions WHERE status = 'OPEN'").first("count");
          const recentActivityData = await env.DB.prepare("SELECT * FROM trades ORDER BY timestamp DESC LIMIT 10").all();
          
          return new Response(JSON.stringify({
             success: true, 
             stats: {
                totalTrades: totalTrades || 0,
                openPositions: openPositions || 0,
                winRate: "N/A",
             },
             recentActivity: recentActivityData.results || []
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        } catch (e: any) {
          return createJsonResponse({ success: false, error: e.message }, 500);
        }
      }

      case "/api/dashboard/positions": {
        if (request.method !== "GET") return createJsonResponse({ success: false, error: "Method Not Allowed" }, 405);
        try {
          const positionsData = await env.DB.prepare("SELECT * FROM positions WHERE status = 'OPEN' ORDER BY updated_at DESC").all();
          return new Response(JSON.stringify({ success: true, positions: positionsData.results || [] }), { status: 200, headers: { "Content-Type": "application/json" } });
        } catch (e: any) {
          return createJsonResponse({ success: false, error: e.message }, 500);
        }
      }

      case "/api/dashboard/logs": {
        if (request.method !== "GET") return createJsonResponse({ success: false, error: "Method Not Allowed" }, 405);
        try {
          const logsData = await env.DB.prepare("SELECT * FROM system_logs ORDER BY timestamp DESC LIMIT 50").all();
          return new Response(JSON.stringify({ success: true, logs: logsData.results || [] }), { status: 200, headers: { "Content-Type": "application/json" } });
        } catch (e: any) {
          return createJsonResponse({ success: false, error: e.message }, 500);
        }
      }

      case "/api/settings": {
        if (request.method !== "POST") return createJsonResponse({ success: false, error: "Method Not Allowed" }, 405);
        try {
          const payload = await request.json();
          const { worker, key, value } = payload;

          if (!worker || !key) {
            return createJsonResponse({ success: false, error: "Missing worker or key" }, 400);
          }

          const kvKey = `dashboard:${worker}:${key}`;
          await env.CONFIG_KV.put(kvKey, JSON.stringify(value));

          return createJsonResponse({ success: true, worker, key });
        } catch (e: any) {
          return createJsonResponse({ success: false, error: e.message }, 500);
        }
      }

      // GET /api/settings/{worker}
        if (path.startsWith("/api/settings/")) {
          const worker = path.replace("/api/settings/", "");

          if (request.method !== "GET") return createJsonResponse({ success: false, error: "Method Not Allowed" }, 405);

          const settings: Record<string, string | number | boolean> = {};
          const list = await env.CONFIG_KV.list({ prefix: `dashboard:${worker}:` });

          for (const kv of list.keys) {
            const key = kv.name.replace(`dashboard:${worker}:`, "");
            const value = await env.CONFIG_KV.get(kv.name);
            if (value) {
              try {
                settings[key] = JSON.parse(value);
              } catch {
                settings[key] = value;
              }
            }
          }

          return new Response(JSON.stringify({ success: true, worker, settings }), { status: 200, headers: { "Content-Type": "application/json" } });
        }

      case "/batch": {
        if (request.method !== "POST") {
          return createJsonResponse({ success: false, error: "Method Not Allowed" }, 405);
        }
         // Validate payload structure
        let payload: BatchPayload;
        try {
            payload = await request.json();
            if (!payload || !Array.isArray(payload.statements)) {
                 throw new Error("Invalid payload: missing or invalid 'statements' array.");
            }
            // Basic check on statements array contents
            if (payload.statements.some(s => !s || typeof s.query !== 'string')) {
                throw new Error("Invalid payload: one or more statements missing 'query'.");
            }
        } catch (e: unknown) {
            const errorMsg = e instanceof Error ? e.message : "Invalid JSON payload";
            console.error(`[${requestId}] Payload parsing error for /batch:`, errorMsg);
            return createJsonResponse({ success: false, error: errorMsg }, 400);
        }

        console.log(`[${requestId}] Executing D1 batch with ${payload.statements.length} statements.`);
        const preparedStatements = payload.statements.map(({ query, params }) =>
            env.DB.prepare(query).bind(...(params || []))
        );
        const batchResult: D1Result[] = await env.DB.batch(preparedStatements);
        
        // Note: D1 batch() currently returns results from .run() for each statement.
        // Check overall success based on individual results
        const overallSuccess = batchResult.every(r => r.success);
        console.log(`[${requestId}] D1 batch result: overallSuccess=${overallSuccess}`);

        if (!overallSuccess) {
             // Find first error message if possible
            const firstError = batchResult.find(r => !r.success)?.error || "One or more batch statements failed";
            console.error(`[${requestId}] D1 batch failure:`, firstError);
            // Return combined results even on partial failure for debugging
             return createJsonResponse({ success: false, error: firstError, results: batchResult });
        }
        
        return createJsonResponse({ success: true, results: batchResult }); // Return array of D1Result
      }

      default: {
        return createJsonResponse({ success: false, error: "Not Found" }, 404);
      }
    }
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error || "Unknown D1 worker error");
    console.error(`[${requestId}] Error handling D1 request:`, errorMsg, error);
    return createJsonResponse({ success: false, error: errorMsg }, 500);
  }
} 