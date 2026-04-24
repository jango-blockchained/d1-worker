import { describe, expect, test, beforeEach, mock, jest } from "bun:test";
import d1Worker from "../src/index.js";

describe("D1 Worker", () => {
  // Mock D1 database prepared statement and response
  const mockPreparedStatement = {
    bind: mock(() => mockPreparedStatement),
    run: mock(() =>
      Promise.resolve({
        success: true,
        error: null,
        meta: {
          last_row_id: 123,
          changes: 1,
        },
      })
    ),
    all: mock(() =>
      Promise.resolve({
        success: true,
        error: null,
        results: [{ id: 1, name: "test" }],
      })
    ),
  };

  // Mock D1 database
  const mockDB = {
    prepare: mock(() => mockPreparedStatement),
    batch: mock((statements) =>
      Promise.resolve([
        { success: true, error: null, meta: { last_row_id: 123, changes: 1 } },
        { success: true, error: null, meta: { changes: 1 } },
      ])
    ),
  };

  const TEST_INTERNAL_KEY = "test-internal-key";

  // Mock secret binding for internal key
  const mockSecretBinding = {
    get: mock(() => Promise.resolve(TEST_INTERNAL_KEY)),
  };

  // Mock KV namespace for config
  const mockKV = {
    get: mock((key: string) => Promise.resolve(null)),
    put: mock(() => Promise.resolve()),
    list: mock(() => Promise.resolve({ keys: [] })),
    delete: mock(() => Promise.resolve()),
  };

  // Mock environment setup function - with internal key secret
  const createMockEnv = (withKey = true) => ({
    DB: mockDB,
    D1_INTERNAL_KEY: withKey ? mockSecretBinding : undefined,
    CONFIG_KV: mockKV,
  });

  // Mock environment used in tests (instantiated per test)
  let mockEnv: ReturnType<typeof createMockEnv>;

  beforeEach(() => {
    // Reset DB mocks before each test
    jest.clearAllMocks();
    // Create a fresh env mock for each test
    mockEnv = createMockEnv();
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
    const envWithoutKey = createMockEnv(false);
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
});
