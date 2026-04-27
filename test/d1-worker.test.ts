import { describe, expect, test, beforeEach, mock, jest } from "bun:test";
import d1Worker from "../src/index.js";

describe("D1 Worker", () => {
  const TEST_INTERNAL_KEY = "test-internal-key";

  const createMockPreparedStatement = (overrides: Partial<{
    allResult: { success: boolean; error: string | null; results: any[] };
    runResult: { success: boolean; error: string | null; meta: any };
    firstResult: any;
  }> = {}) => {
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
    batch: mock(() =>
      Promise.resolve([
        { success: true, error: null, meta: { last_row_id: 123, changes: 1 } },
        { success: true, error: null, meta: { changes: 1 } },
      ])
    ),
  });

  const createMockKV = () => ({
    get: mock((key: string) => Promise.resolve<string | null>(null)),
    put: mock(() => Promise.resolve()),
    list: mock((options?: { prefix?: string }) => Promise.resolve({ keys: [] as { name: string; expiration: number }[] })),
    delete: mock(() => Promise.resolve()),
  });

  const createMockEnv = (db = createMockDB(), kv = createMockKV()) => ({
    DB: db,
    D1_INTERNAL_KEY: TEST_INTERNAL_KEY,
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

  // Valid batch request payload
  const validBatchRequest = {
    statements: [
      {
        query: "INSERT INTO trade_requests (method, path) VALUES (?, ?)",
        params: ["POST", "/trade"],
      },
      {
        query: "UPDATE trade_responses SET error = ? WHERE request_id = ?",
        params: ["Connection timeout", 123],
      },
    ],
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

    const response = await d1Worker.fetch(request as any, mockEnv as any);
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

    const response = await d1Worker.fetch(request as any, mockEnv as any);
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

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(401);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(false);
  });

  test("allows requests when no internal key is configured", async () => {
    const envWithoutKey = {
      DB: mockDB,
      D1_INTERNAL_KEY: undefined,
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
    expect(response.status).toBe(200);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(true);
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

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(404);
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

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(200);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(true);
    expect(responseData.results).toBeDefined();
  });

  test("handles INSERT query", async () => {
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

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(200);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(true);
    expect(responseData.lastRowId).toBeDefined();
    expect(responseData.changes).toBeDefined();
  });

  test("handles batch operations", async () => {
    const request = new Request("https://d1-worker.workers.dev/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify(validBatchRequest),
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(200);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(true);
    expect(responseData.results).toBeDefined();
  });

  test("rejects unsupported methods", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(405);
  });

  test("handles database errors", async () => {
    // Override the mock DB behavior
    mockDB.prepare.mockImplementation(() => {
      throw new Error("Database error");
    });

    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify(validQueryRequest),
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(500);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(false);
    expect(responseData.error).toBeDefined();
  });

  test("handles CORS preflight OPTIONS request", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "OPTIONS",
      headers: {
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  test("rejects /query with missing query field", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({ params: [1, 2] }),
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(400);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(false);
    expect(responseData.error).toContain("query");
  });

  test("rejects /query with invalid query type", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({ query: 123 }),
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(400);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(false);
  });

  test("rejects /query with invalid JSON", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: "not valid json",
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(400);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(false);
  });

  test("handles SELECT query with D1 error", async () => {
    const failingStmt = createMockPreparedStatement({
      allResult: { success: false, error: "Table not found", results: [] },
    });
    const failingDB = createMockDB(failingStmt);
    const env = createMockEnv(failingDB, mockKV);

    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({
        query: "SELECT * FROM nonexistent_table",
        params: [],
      }),
    });

    const response = await d1Worker.fetch(request as any, env as any);
    expect(response.status).toBe(500);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(false);
    expect(responseData.error).toContain("Table not found");
  });

  test("handles write query with D1 error", async () => {
    const failingStmt = createMockPreparedStatement({
      runResult: { success: false, error: "Constraint violation", meta: {} },
    });
    const failingDB = createMockDB(failingStmt);
    const env = createMockEnv(failingDB, mockKV);

    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({
        query: "INSERT INTO trade_requests (id) VALUES (?)",
        params: [1],
      }),
    });

    const response = await d1Worker.fetch(request as any, env as any);
    expect(response.status).toBe(500);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(false);
  });

  test("rejects unsupported query type", async () => {
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

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(400);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(false);
    expect(responseData.error).toContain("Unsupported query type");
  });

  test("handles /api/dashboard/stats endpoint", async () => {
    mockPreparedStatement.first.mockImplementation((col?: string) => {
      if (col === "count") return Promise.resolve({ count: 10 });
      return Promise.resolve(null);
    });
    mockPreparedStatement.all.mockImplementationOnce(() =>
      Promise.resolve({
        success: true,
        error: null,
        results: [{ id: 1, symbol: "BTC/USD" }],
      })
    );

    const request = new Request("https://d1-worker.workers.dev/api/dashboard/stats", {
      method: "GET",
      headers: {
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(200);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(true);
    expect(responseData.stats).toBeDefined();
    expect(responseData.recentActivity).toBeDefined();
  });

  test("handles /api/dashboard/stats with db error", async () => {
    mockPreparedStatement.first.mockImplementation(() => {
      throw new Error("DB error");
    });

    const request = new Request("https://d1-worker.workers.dev/api/dashboard/stats", {
      method: "GET",
      headers: {
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(500);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(false);
  });

  test("handles /api/dashboard/positions endpoint", async () => {
    mockPreparedStatement.all.mockImplementationOnce(() =>
      Promise.resolve({
        success: true,
        error: null,
        results: [{ id: 1, symbol: "BTC/USD", status: "OPEN" }],
      })
    );

    const request = new Request("https://d1-worker.workers.dev/api/dashboard/positions", {
      method: "GET",
      headers: {
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(200);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(true);
    expect(responseData.positions).toBeDefined();
  });

  test("handles /api/dashboard/positions with db error", async () => {
    mockPreparedStatement.all.mockImplementationOnce(() => {
      throw new Error("DB error");
    });

    const request = new Request("https://d1-worker.workers.dev/api/dashboard/positions", {
      method: "GET",
      headers: {
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(500);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(false);
  });

  test("handles /api/dashboard/logs endpoint", async () => {
    mockPreparedStatement.all.mockImplementationOnce(() =>
      Promise.resolve({
        success: true,
        error: null,
        results: [{ id: 1, message: "test log" }],
      })
    );

    const request = new Request("https://d1-worker.workers.dev/api/dashboard/logs", {
      method: "GET",
      headers: {
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(200);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(true);
    expect(responseData.logs).toBeDefined();
  });

  test("handles /api/dashboard/logs with db error", async () => {
    mockPreparedStatement.all.mockImplementationOnce(() => {
      throw new Error("DB error");
    });

    const request = new Request("https://d1-worker.workers.dev/api/dashboard/logs", {
      method: "GET",
      headers: {
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(500);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(false);
  });

  test("handles /api/dashboard/balances endpoint", async () => {
    mockPreparedStatement.all.mockImplementationOnce(() =>
      Promise.resolve({
        success: true,
        error: null,
        results: [
          { exchange: "binance", asset: "BTC", total: 1.5, snapshot_at: "2024-01-01" },
        ],
      })
    );

    const request = new Request("https://d1-worker.workers.dev/api/dashboard/balances", {
      method: "GET",
      headers: {
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(200);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(true);
    expect(responseData.totalBalance).toBeDefined();
    expect(responseData.balances).toBeDefined();
  });

  test("handles /api/dashboard/balances with db error", async () => {
    mockPreparedStatement.all.mockImplementationOnce(() => {
      throw new Error("DB error");
    });

    const request = new Request("https://d1-worker.workers.dev/api/dashboard/balances", {
      method: "GET",
      headers: {
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(500);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(false);
  });

  test("handles /api/settings GET with KV values", async () => {
    mockKV.list.mockImplementation((options?: { prefix?: string }) =>
      Promise.resolve({
        keys: [{ name: `${options?.prefix || ""}test`, expiration: 0 }],
      })
    );
    mockKV.get.mockImplementation((key: string) =>
      Promise.resolve(JSON.stringify({ enabled: true }))
    );

    const request = new Request("https://d1-worker.workers.dev/api/settings", {
      method: "GET",
      headers: {
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(200);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(true);
    expect(responseData.settings).toBeDefined();
  });

  test("handles /api/settings POST with valid payload", async () => {
    const request = new Request("https://d1-worker.workers.dev/api/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({
        worker: "test-worker",
        key: "test:key",
        value: { setting: "value" },
      }),
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(200);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(true);
    expect(responseData.key).toBe("test:key");
  });

  test("rejects /api/settings POST with missing key", async () => {
    const request = new Request("https://d1-worker.workers.dev/api/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({
        worker: "test-worker",
        value: { setting: "value" },
      }),
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(400);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(false);
    expect(responseData.error).toContain("Missing key");
  });

  test("handles /api/settings POST with JSON parse error", async () => {
    const request = new Request("https://d1-worker.workers.dev/api/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: "invalid json",
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(500);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(false);
  });

  test("rejects batch with missing statements array", async () => {
    const request = new Request("https://d1-worker.workers.dev/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({ data: [] }),
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(400);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(false);
    expect(responseData.error).toContain("statements");
  });

  test("rejects batch with statement missing query field", async () => {
    const request = new Request("https://d1-worker.workers.dev/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({
        statements: [{ params: [1] }],
      }),
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(400);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(false);
    expect(responseData.error).toContain("query");
  });

  test("handles batch with partial failure", async () => {
    mockDB.batch.mockImplementationOnce(() =>
      Promise.resolve([
        { success: true, error: null, meta: { last_row_id: 123, changes: 1 } },
        { success: false, error: "Constraint violation", meta: { changes: 0 } } as any,
      ])
    );

    const request = new Request("https://d1-worker.workers.dev/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify(validBatchRequest),
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(200);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(false);
    expect(responseData.error).toContain("Constraint violation");
    expect(responseData.results).toBeDefined();
  });

  test("handles /health endpoint", async () => {
    mockPreparedStatement.first.mockImplementation(() => Promise.resolve({ "1": 1 }));

    const request = new Request("https://d1-worker.workers.dev/health", {
      method: "GET",
      headers: {
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(200);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(true);
    expect(responseData.result.status).toBe("ok");
    expect(responseData.result.service).toBe("d1-worker");
  });

  test("handles /health with db error", async () => {
    mockPreparedStatement.first.mockImplementation(() => {
      throw new Error("DB unavailable");
    });

    const request = new Request("https://d1-worker.workers.dev/health", {
      method: "GET",
      headers: {
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(500);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(false);
  });

  test("rejects /health with wrong method", async () => {
    const request = new Request("https://d1-worker.workers.dev/health", {
      method: "POST",
      headers: {
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
    });

    const response = await d1Worker.fetch(request as any, mockEnv as any);
    expect(response.status).toBe(405);

    const responseData = (await response.json()) as any;
    expect(responseData.success).toBe(false);
  });
});
