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

  // Mock environment setup function - remove internal key secret
  const createMockEnv = () => ({
    // INTERNAL_SERVICE_KEY_SECRET is no longer used
    DB: mockDB,
  });

  // Mock environment used in tests (instantiated per test)
  let mockEnv: ReturnType<typeof createMockEnv>;
  // TEST_INTERNAL_KEY is no longer needed

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
  /*
  test("validates internal service key", async () => {
    // ... removed ...
  });

  test("rejects request if header key doesn't match retrieved secret", async () => {
     // ... removed ...
  });

  test("validates request ID", async () => {
    // ... removed ...
  });
  */

  test("returns 404 for unknown endpoint", async () => {
    const request = new Request("https://d1-worker.workers.dev/unknown", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // No auth headers needed now
        // "X-Internal-Key": "test-internal-key",
        // "X-Request-ID": "test-request-id",
      },
      body: JSON.stringify(validQueryRequest),
    });

    const response = await d1Worker.fetch(request, mockEnv);
    expect(response.status).toBe(404);
  });

  test("handles SELECT query", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // No auth headers needed
      },
      body: JSON.stringify({
        query: "SELECT * FROM trade_requests",
        params: [],
      }),
    });

    const response = await d1Worker.fetch(request, mockEnv);
    expect(response.status).toBe(200);
    // expect(mockEnv.INTERNAL_SERVICE_KEY_SECRET.get).toHaveBeenCalledTimes(1);

    const responseData = await response.json();
    expect(responseData.success).toBe(true);
    expect(responseData.results).toBeDefined();
  });

  test("handles INSERT query", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
         // No auth headers needed
      },
      body: JSON.stringify({
        query: "INSERT INTO trade_requests (method, path) VALUES (?, ?)",
        params: ["POST", "/trade"],
      }),
    });

    const response = await d1Worker.fetch(request, mockEnv);
    expect(response.status).toBe(200);

    const responseData = await response.json();
    expect(responseData.success).toBe(true);
    expect(responseData.lastRowId).toBeDefined();
    expect(responseData.changes).toBeDefined();
  });

  test("handles batch operations", async () => {
    const request = new Request("https://d1-worker.workers.dev/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // No auth headers needed
      },
      body: JSON.stringify(validBatchRequest),
    });

    const response = await d1Worker.fetch(request, mockEnv);
    expect(response.status).toBe(200);

    const responseData = await response.json();
    expect(responseData.success).toBe(true);
    expect(responseData.results).toBeDefined();
  });

  test("rejects unsupported methods", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        // No auth headers needed
      },
    });

    const response = await d1Worker.fetch(request, mockEnv);
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
        // No auth headers needed
      },
      body: JSON.stringify(validQueryRequest),
    });

    const response = await d1Worker.fetch(request, mockEnv);
    expect(response.status).toBe(500);
    // expect(mockEnv.INTERNAL_SERVICE_KEY_SECRET.get).toHaveBeenCalledTimes(1);

    const responseData = await response.json();
    expect(responseData.success).toBe(false);
    expect(responseData.error).toBeDefined();
  });
});
