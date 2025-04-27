import { log } from '@shared/utils';
import type { D1Database, D1Result } from "@cloudflare/workers-types";

// --- Type Definitions ---

interface Env {
  DB: D1Database;
  // Add other bindings/vars if needed (e.g., secrets if auth is re-added)
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

  // Authentication check was removed - re-add if calls can come from untrusted sources

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