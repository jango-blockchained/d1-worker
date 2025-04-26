/**
 * D1 Worker for Hoox Trading Database Operations
 */
import { verifyInternalService } from "../../shared/utils.js"; // Import the function

// ES Module format requires a default export
export default {
  async fetch(request, env) {
    return await handleRequest(request, env);
  },
};

async function handleRequest(request, env) {
  try {
    // Verify internal service key
    const internalKeyHeader = request.headers.get("X-Internal-Key");
    const requestId = request.headers.get("X-Request-ID");

    // Get the expected key from Secrets Store
    const expectedInternalKey = await env.INTERNAL_SERVICE_KEY_SECRET?.get();

    if (!expectedInternalKey) {
      console.error(
        "INTERNAL_SERVICE_KEY_SECRET binding not configured or accessible."
      );
      return new Response(
        JSON.stringify({
          success: false,
          error: "Service configuration error",
        }),
        { status: 500 }
      );
    }

    if (
      !internalKeyHeader ||
      internalKeyHeader !== expectedInternalKey ||
      !requestId
    ) {
      console.warn("Unauthorized attempt blocked.");
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized" }),
        { status: 403 }
      );
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Route handling
    switch (path) {
      case "/query": {
        if (request.method !== "POST") {
          return new Response(
            JSON.stringify({
              success: false,
              error: "Method not allowed",
            }),
            { status: 405 }
          );
        }
        const { query, params } = await request.json();

        // Check if query is INSERT, UPDATE, or DELETE
        const isWrite =
          query.trim().toUpperCase().startsWith("INSERT") ||
          query.trim().toUpperCase().startsWith("UPDATE") ||
          query.trim().toUpperCase().startsWith("DELETE");

        if (isWrite) {
          // For write operations
          const stmt = env.DB.prepare(query).bind(...(params || []));
          const result = await stmt.run();
          return new Response(
            JSON.stringify({
              success: true,
              lastRowId: result.meta?.last_row_id,
              changes: result.meta?.changes,
            }),
            {
              headers: { "Content-Type": "application/json" },
            }
          );
        } else {
          // For read operations
          const result = await env.DB.prepare(query)
            .bind(...(params || []))
            .all();
          return new Response(
            JSON.stringify({
              success: true,
              results: result.results,
            }),
            {
              headers: { "Content-Type": "application/json" },
            }
          );
        }
      }

      case "/batch": {
        if (request.method !== "POST") {
          return new Response(
            JSON.stringify({
              success: false,
              error: "Method not allowed",
            }),
            { status: 405 }
          );
        }
        const { statements } = await request.json();
        const batch = env.DB.batch(
          statements.map(({ query, params }) =>
            env.DB.prepare(query).bind(...(params || []))
          )
        );
        const batchResult = await batch.run();
        return new Response(
          JSON.stringify({
            success: true,
            results: batchResult,
          }),
          {
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      default: {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Not found",
          }),
          { status: 404 }
        );
      }
    }
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

/**
 * Handle database actions based on request data
 * @param {object} data - Request body data
 * @param {D1Database} db - D1 Database binding
 * @returns {Promise<any>} Results from the database operation
 */
async function handleDatabaseAction(data, db) {
  const { action } = data;
  let results;

  switch (action) {
    case "SELECT": {
      const { statement, params } = data;
      results = await db
        .prepare(statement)
        .bind(...params)
        .all();
      break;
    }
    case "EXEC": {
      const { statement, params } = data;
      results = await db
        .prepare(statement)
        .bind(...params)
        .run();
      break;
    }
    default:
      throw new Error(`Unsupported action: ${action}`);
  }

  return results;
}

/**
 * Fetch handler for the Worker
 * @param {Request} request
 * @param {Env} env
 * @param {ExecutionContext} ctx
 * @returns {Promise<Response>}
 */
async function _handleFetch(request, env, _ctx) {
  // Prefix ctx
  // Verify internal service authentication
  const authResponse = verifyInternalService(request, env);
  if (authResponse) {
    return authResponse;
  }

  const { method } = request;

  try {
    switch (method) {
      case "GET": {
        const { pathname } = new URL(request.url);
        return new Response(`GET request received at ${pathname}`);
      }
      case "POST": {
        let body = await request.json();
        const results = await handleDatabaseAction(body, env.DB);
        return Response.json({ success: true, results });
      }
      default: {
        return new Response("Method Not Allowed", { status: 405 });
      }
    }
  } catch (e) {
    console.error("Error handling request:", e);
    return Response.json(
      {
        success: false,
        error: e.message || "Internal Server Error",
      },
      { status: 500 }
    );
  }
}
