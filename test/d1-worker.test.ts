import { describe, expect, test, beforeEach, mock, jest } from "@jest/globals";
import d1Worker from "../src/index.js";

describe("D1 Worker", () => {
  // Mock D1 database prepared statement and response
  const mockPreparedStatement = {
    bind: mock(() => mockPreparedStatement),
    run: mock(() =>
      Promise.resolve({
        meta: {
          last_row_id: 123,
          changes: 1,
        },
      })
    ),
    all: mock(() =>
      Promise.resolve({
        results: [{ id: 1, name: "test" }],
      })
    ),
  };

  // Mock D1 database
  const mockDB = {
    prepare: mock(() => mockPreparedStatement),
    batch: mock((statements) => ({
      run: mock(() =>
        Promise.resolve([
          { meta: { last_row_id: 123, changes: 1 } },
          { meta: { changes: 1 } },
        ])
      ),
    })),
  };

  // Mock environment setup function
  const createMockEnv = (internalKey: string | null | undefined) => ({
    INTERNAL_SERVICE_KEY_SECRET: {
      get: jest.fn().mockResolvedValue(internalKey),
    },
    DB: mockDB,
  });

  // Mock environment used in tests (instantiated per test)
  let mockEnv: ReturnType<typeof createMockEnv>;
  const TEST_INTERNAL_KEY = "test-internal-key";

  beforeEach(() => {
    // Reset DB mocks before each test
    jest.clearAllMocks();
    // Create a fresh env mock for each test
    // Default to providing a valid key unless overridden in the test
    mockEnv = createMockEnv(TEST_INTERNAL_KEY);
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

  test("validates internal service key", async () => {
    // Override env to provide no key for this test
    mockEnv = createMockEnv(null);
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": "invalid-key", // Header key doesn't match (or is missing)
        "X-Request-ID": "test-request-id",
      },
      body: JSON.stringify(validQueryRequest),
    });

    const response = await d1Worker.fetch(request, mockEnv);
    expect(response.status).toBe(500); // Should be 500 if secret binding fails
    const body = await response.json();
    expect(body.error).toContain("Service configuration error");
    expect(mockEnv.INTERNAL_SERVICE_KEY_SECRET.get).toHaveBeenCalledTimes(1);
  });

  test("rejects request if header key doesn't match retrieved secret", async () => {
    // Env provides TEST_INTERNAL_KEY
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": "wrong-key-in-header", // This key doesn't match TEST_INTERNAL_KEY
        "X-Request-ID": "test-request-id",
      },
      body: JSON.stringify(validQueryRequest),
    });

    const response = await d1Worker.fetch(request, mockEnv);
    expect(response.status).toBe(403);
    expect(mockEnv.INTERNAL_SERVICE_KEY_SECRET.get).toHaveBeenCalledTimes(1);
  });

  test("validates request ID", async () => {
    // Env provides TEST_INTERNAL_KEY
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": TEST_INTERNAL_KEY, // Correct key
        // Missing X-Request-ID
      },
      body: JSON.stringify(validQueryRequest),
    });

    const response = await d1Worker.fetch(request, mockEnv);
    expect(response.status).toBe(403);
    expect(mockEnv.INTERNAL_SERVICE_KEY_SECRET.get).toHaveBeenCalledTimes(1);
  });

  test("returns 404 for unknown endpoint", async () => {
    const request = new Request("https://d1-worker.workers.dev/unknown", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": "test-internal-key",
        "X-Request-ID": "test-request-id",
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
        "X-Internal-Key": TEST_INTERNAL_KEY, // Use the test key
        "X-Request-ID": "test-request-id",
      },
      body: JSON.stringify({
        query: "SELECT * FROM trade_requests",
        params: [],
      }),
    });

    const response = await d1Worker.fetch(request, mockEnv);
    expect(response.status).toBe(200);
    expect(mockEnv.INTERNAL_SERVICE_KEY_SECRET.get).toHaveBeenCalledTimes(1);

    const responseData = await response.json();
    expect(responseData.success).toBe(true);
    expect(responseData.results).toBeDefined();
  });

  test("handles INSERT query", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": TEST_INTERNAL_KEY, // Use the test key
        "X-Request-ID": "test-request-id",
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
        "X-Internal-Key": TEST_INTERNAL_KEY, // Use the test key
        "X-Request-ID": "test-request-id",
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
        "X-Internal-Key": TEST_INTERNAL_KEY, // Use the test key
        "X-Request-ID": "test-request-id",
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
        "X-Internal-Key": TEST_INTERNAL_KEY, // Use the test key
        "X-Request-ID": "test-request-id",
      },
      body: JSON.stringify(validQueryRequest),
    });

    const response = await d1Worker.fetch(request, mockEnv);
    expect(response.status).toBe(500);
    expect(mockEnv.INTERNAL_SERVICE_KEY_SECRET.get).toHaveBeenCalledTimes(1);

    const responseData = await response.json();
    expect(responseData.success).toBe(false);
    expect(responseData.error).toBeDefined();
  });
});
