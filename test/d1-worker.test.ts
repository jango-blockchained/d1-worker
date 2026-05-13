import { describe, expect, test, beforeEach, mock, jest } from "bun:test";
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
    list: mock((options?: { prefix?: string }) =>
      Promise.resolve({ keys: [] as { name: string; expiration: number }[] })
    ),
    delete: mock(() => Promise.resolve()),
  });

  const createMockCtx = () => ({ waitUntil: mock(() => {}) });

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

    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
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

    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
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
