import { describe, expect, test, beforeEach, mock } from "bun:test";
import d1Worker from "../src/index.js";

describe("D1 Worker", () => {
  const TEST_INTERNAL_KEY = "test-internal-key";

  const createMockPreparedStatement = (
    overrides: Partial<{
      allResult: { success: boolean; error: string | null; results: any[] };
      runResult: { success: boolean; error: string | null; meta: any };
      firstResult: any;
    }> = {}
  ) => {
    const allResult = overrides.allResult || {
      success: true,
      error: null,
      results: [{ id: 1, name: "test" }],
    };
    const runResult = overrides.runResult || {
      success: true,
      error: null,
      meta: { last_row_id: 123, changes: 1 },
    };
    const firstResult = overrides.firstResult || { count: 0 };

    return {
      bind: mock(() => createMockPreparedStatement(overrides)),
      run: mock(() => Promise.resolve(runResult)),
      all: mock(() => Promise.resolve(allResult)),
      first: mock((col?: string) => {
        if (col === "count") return Promise.resolve(firstResult);
        return Promise.resolve(null);
      }),
    };
  };

  const createMockDB = (preparedStatement = createMockPreparedStatement()) => ({
    prepare: mock(() => preparedStatement),
    // db.batch must return a 5-element array because workers/d1-worker/src/stats.ts
    // destructures 5 aggregate results (totalRow, activePosRow, totalClosedRow,
    // profitableRow, dailyRow) and reads `.results[0].count` from each. Each result
    // must include a `results: [{ count: 0 }]` row; `count: 0` is a safe default —
    // every aggregate in stats.ts uses `?? 0` fallback, and the winRate path is
    // guarded by `closedCount > 0`. The /batch endpoint (which calls db.batch with
    // a variable-length statement list) only checks `success`/error, not element
    // count, so the 5-element shape does not regress the existing batch tests.
    batch: mock(() =>
      Promise.resolve([
        {
          success: true,
          error: null,
          results: [{ count: 0 }],
          meta: { last_row_id: 123, changes: 1 },
        },
        {
          success: true,
          error: null,
          results: [{ count: 0 }],
          meta: { changes: 1 },
        },
        {
          success: true,
          error: null,
          results: [{ count: 0 }],
          meta: { changes: 1 },
        },
        {
          success: true,
          error: null,
          results: [{ count: 0 }],
          meta: { changes: 1 },
        },
        {
          success: true,
          error: null,
          results: [{ count: 0 }],
          meta: { changes: 1 },
        },
      ])
    ),
  });

  const createMockKV = () => ({
    get: mock((key: string) => Promise.resolve<string | null>(null)),
    put: mock(() => Promise.resolve()),
    list: mock((options?: { prefix?: string }) =>
      Promise.resolve({ keys: [] as { name: string; expiration: number }[] })
    ),
    delete: mock(() => Promise.resolve()),
  });

  const createMockCtx = () => ({ waitUntil: mock(() => {}) });

  const createMockEnv = (db = createMockDB(), kv = createMockKV()) => ({
    DB: db,
    INTERNAL_KEY_BINDING: TEST_INTERNAL_KEY,
    CONFIG_KV: kv,
  });

  let mockDB = createMockDB();
  let mockKV = createMockKV();
  let mockEnv = createMockEnv(mockDB, mockKV);
  let mockPreparedStatement: ReturnType<typeof createMockPreparedStatement>;

  beforeEach(() => {
    mockPreparedStatement = createMockPreparedStatement();
    mockDB = createMockDB(mockPreparedStatement);
    mockKV = createMockKV();
    mockEnv = createMockEnv(mockDB, mockKV);
  });

  // Valid query request payload
  const validQueryRequest = {
    query: "SELECT * FROM trade_requests WHERE id = ?",
    params: [123],
  };

  // Remove tests related to internal service key validation
  test("allows request when internal auth key is provided", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({
        query: "SELECT * FROM trade_requests",
        params: [],
      }),
    });

    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(200);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(true);
  });

  test("rejects request when internal auth key is missing", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: "SELECT * FROM trade_requests",
        params: [],
      }),
    });

    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(401);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(false);
  });

  test("rejects request when internal auth key is invalid", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": "wrong-key",
      },
      body: JSON.stringify({
        query: "SELECT * FROM trade_requests",
        params: [],
      }),
    });

    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(401);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(false);
  });

  test("rejects requests when no internal key is configured", async () => {
    const envWithoutKey = {
      DB: mockDB,
      INTERNAL_KEY_BINDING: undefined,
      CONFIG_KV: mockKV,
    };
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: "SELECT * FROM trade_requests",
        params: [],
      }),
    });

    const response = await d1Worker.fetch(request as any, envWithoutKey as any);
    // Auth middleware fails closed — rejects when INTERNAL_KEY_BINDING is not configured
    expect(response.status).toBe(401);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(false);
  });

  test("returns 404 for unknown endpoint", async () => {
    const request = new Request("https://d1-worker.workers.dev/unknown", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify(validQueryRequest),
    });

    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(404);
  });

  test("GET /health returns healthy status when DB is reachable", async () => {
    const request = new Request("https://d1-worker.workers.dev/health", {
      method: "GET",
    });
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.success).toBe(true);
    expect(data.result.status).toBe("ok");
    expect(data.result.service).toBe("d1-worker");
  });

  test("GET /health returns 500 when DB is unreachable", async () => {
    const failingStmt = createMockPreparedStatement();
    failingStmt.first = mock(() =>
      Promise.reject(new Error("Connection failed"))
    );
    const failingDB = createMockDB(failingStmt);
    const env = createMockEnv(failingDB, mockKV);
    const request = new Request("https://d1-worker.workers.dev/health", {
      method: "GET",
    });
    const response = await d1Worker.fetch(
      request as any,
      env as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(500);
  });

  test("GET /api/settings returns KV config settings", async () => {
    const kvWithData = createMockKV();
    (kvWithData.list as ReturnType<typeof mock>).mockImplementation(
      (options?: { prefix?: string }) => {
        if (options?.prefix === "global:") {
          return Promise.resolve({
            keys: [{ name: "global:test-key", expiration: 0 }],
          });
        }
        return Promise.resolve({ keys: [] });
      }
    );
    (kvWithData.get as ReturnType<typeof mock>).mockImplementation(
      (key: string) => {
        if (key === "global:test-key") return Promise.resolve('"hello"');
        return Promise.resolve(null);
      }
    );
    const env = createMockEnv(mockDB, kvWithData);
    const request = new Request("https://d1-worker.workers.dev/api/settings", {
      method: "GET",
      headers: { "X-Internal-Auth-Key": TEST_INTERNAL_KEY },
    });
    const response = await d1Worker.fetch(
      request as any,
      env as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.success).toBe(true);
    expect(data.settings).toBeDefined();
    expect(data.settings["global:test-key"]).toBe("hello");
  });

  test("POST /api/settings writes to KV config", async () => {
    const request = new Request("https://d1-worker.workers.dev/api/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({
        key: "global:test-key",
        value: "test-value",
      }),
    });
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.success).toBe(true);
    // Key is stored as-is (already prefixed by the dashboard), no double-prefix
    expect(data.key).toBe("global:test-key");
    // Verify the KV put was called with the un-prefixed key
    expect(mockKV.put).toHaveBeenCalledWith(
      "global:test-key",
      JSON.stringify("test-value")
    );
  });

  test("POST /api/settings rejects missing key", async () => {
    const request = new Request("https://d1-worker.workers.dev/api/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({ value: "test" }),
    });
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(400);
  });

  test("rejects queries with DROP keyword", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({ query: "DROP TABLE trades", params: [] }),
    });
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    // Non-SELECT free-form SQL is permanently disabled (410 + named RPC)
    expect(response.status).toBe(410);
    const data = (await response.json()) as any;
    expect(data.success).toBe(false);
    expect(data.code).toBe("USE_NAMED_RPC");
  });

  test("rejects queries referencing unauthorized tables", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({ query: "SELECT * FROM secret_table", params: [] }),
    });
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(403);
    const data = (await response.json()) as any;
    expect(data.success).toBe(false);
    expect(data.error).toContain("Unauthorized table");
  });

  test("rejects unsupported query types like CREATE", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({
        query: "CREATE TABLE test (id INTEGER)",
        params: [],
      }),
    });
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(410);
    const data = (await response.json()) as any;
    expect(data.success).toBe(false);
    expect(data.code).toBe("USE_NAMED_RPC");
  });

  test("handles OPTIONS preflight request", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "OPTIONS",
    });
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(204);
    // Internal worker: no open browser CORS
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("does not open CORS on health responses (internal worker)", async () => {
    const request = new Request("https://d1-worker.workers.dev/health", {
      method: "GET",
    });
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("handles SELECT query", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({
        query: "SELECT * FROM trade_requests",
        params: [],
      }),
    });

    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(200);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(true);
    expect(responseData.results).toBeDefined();
  });

  test("rejects free-form INSERT on /query (writes moved to named RPC)", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({
        query: "INSERT INTO evil_table (id) VALUES (?)",
        params: [1],
      }),
    });

    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    // 410 Gone — free-form writes permanently disabled
    expect(response.status).toBe(410);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("USE_NAMED_RPC");
  });

  test("rejects free-form INSERT even for allowlisted tables on /query", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({
        query: "INSERT INTO trade_requests (method, path) VALUES (?, ?)",
        params: ["POST", "/trade"],
      }),
    });

    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(410);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("USE_NAMED_RPC");
  });

  test("named RPC /rpc/insert-trade accepts write", async () => {
    mockDB.prepare = mock(() =>
      createMockPreparedStatement({
        runResult: {
          success: true,
          error: null,
          meta: { changes: 1, last_row_id: 1 },
        },
      })
    );

    const request = new Request(
      "https://d1-worker.workers.dev/rpc/insert-trade",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
        },
        body: JSON.stringify({
          exchange: "binance",
          symbol: "BTCUSDT",
          action: "LONG",
          quantity: 0.01,
        }),
      }
    );

    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; id?: string };
    expect(body.success).toBe(true);
    expect(body.id).toBeDefined();
  });

  test("handles batch operations", async () => {
    const request = new Request("https://d1-worker.workers.dev/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({
        statements: [
          {
            query: "SELECT * FROM trade_requests WHERE id = ?",
            params: [1],
          },
          {
            query: "SELECT * FROM trade_signals ORDER BY id DESC LIMIT ?",
            params: [10],
          },
        ],
      }),
    });

    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(200);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(true);
    expect(responseData.results).toBeDefined();
  });

  test("batch rejects statements missing query field", async () => {
    const request = new Request("https://d1-worker.workers.dev/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({
        statements: [{ params: ["POST", "/trade"] }],
      }),
    });
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(400);
  });

  test("batch rejects unsupported query types", async () => {
    const request = new Request("https://d1-worker.workers.dev/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({
        statements: [
          { query: "ALTER TABLE trades ADD COLUMN x INTEGER", params: [] },
        ],
      }),
    });
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(410);
    const data = (await response.json()) as { code?: string };
    expect(data.code).toBe("USE_NAMED_RPC");
  });

  test("GET /api/dashboard/positions returns open positions", async () => {
    const request = new Request(
      "https://d1-worker.workers.dev/api/dashboard/positions",
      {
        method: "GET",
        headers: { "X-Internal-Auth-Key": TEST_INTERNAL_KEY },
      }
    );
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.success).toBe(true);
    expect(data.positions).toBeDefined();
  });

  test("GET /api/dashboard/balances returns balance snapshots", async () => {
    const request = new Request(
      "https://d1-worker.workers.dev/api/dashboard/balances",
      {
        method: "GET",
        headers: { "X-Internal-Auth-Key": TEST_INTERNAL_KEY },
      }
    );
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.success).toBe(true);
    expect(data.totalBalance).toBeDefined();
    expect(data.balances).toBeDefined();
  });

  test("both /api/positions and /api/dashboard/positions return same structure", async () => {
    const req1 = new Request("https://d1-worker.workers.dev/api/positions", {
      method: "GET",
      headers: { "X-Internal-Auth-Key": TEST_INTERNAL_KEY },
    });
    const req2 = new Request(
      "https://d1-worker.workers.dev/api/dashboard/positions",
      {
        method: "GET",
        headers: { "X-Internal-Auth-Key": TEST_INTERNAL_KEY },
      }
    );
    const [res1, res2] = await Promise.all([
      d1Worker.fetch(req1 as any, mockEnv as any, createMockCtx() as any),
      d1Worker.fetch(req2 as any, mockEnv as any, createMockCtx() as any),
    ]);
    const data1 = await res1.json();
    const data2 = await res2.json();
    expect(data1).toEqual(data2);
  });

  test("GET /api/dashboard/stats returns aggregated statistics", async () => {
    const request = new Request(
      "https://d1-worker.workers.dev/api/dashboard/stats",
      {
        method: "GET",
        headers: { "X-Internal-Auth-Key": TEST_INTERNAL_KEY },
      }
    );
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.success).toBe(true);
    expect(data.stats).toBeDefined();
    expect(typeof data.stats.totalTrades).toBe("number");
    expect(typeof data.stats.winRate).toBe("number");
    expect(typeof data.stats.totalPnlUSDT).toBe("number");
    expect(typeof data.stats.activePositionsCount).toBe("number");
    expect(typeof data.stats.dailyTradesCount).toBe("number");
  });

  test("GET /api/dashboard/stats requires auth", async () => {
    const request = new Request(
      "https://d1-worker.workers.dev/api/dashboard/stats",
      {
        method: "GET",
      }
    );
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(401);
  });

  test("rejects unsupported methods", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
    });

    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(405);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(false);
  });
});
