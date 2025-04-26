/**
 * D1 Worker for Hoox Trading Database Operations
 */
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
      case "/query":
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

      case "/batch":
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

      default:
        return new Response(
          JSON.stringify({
            success: false,
            error: "Not found",
          }),
          { status: 404 }
        );
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
