/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

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
    // db.batch must return a 6-element array because workers/d1-worker/src/stats.ts
    // destructures 6 aggregate results (totalRow, activePosRow, totalClosedRow,
    // profitableRow, dailyRow, pnlRow). Each count result includes
    // `results: [{ count: 0 }]`; pnlRow uses `results: [{ total: 0 }]`.
    // The /batch endpoint only checks success/error, so the 6-element shape
    // does not regress existing batch tests.
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
        {
          success: true,
          error: null,
          results: [{ total: 0 }],
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

  test("scoped read key can access GET balances but not write RPC", async () => {
    const readEnv = {
      ...mockEnv,
      D1_READ_KEY_BINDING: "read-only-key",
      D1_WRITE_KEY_BINDING: "write-key",
      INTERNAL_KEY_BINDING: undefined,
    };

    const readBalances = new Request(
      "https://d1-worker.workers.dev/api/balances",
      {
        method: "GET",
        headers: { "X-Internal-Auth-Key": "read-only-key" },
      }
    );
    const balancesRes = await d1Worker.fetch(
      readBalances as any,
      readEnv as any,
      createMockCtx() as any
    );
    expect(balancesRes.status).toBe(200);

    const writeAttempt = new Request(
      "https://d1-worker.workers.dev/rpc/insert-trade",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Auth-Key": "read-only-key",
        },
        body: JSON.stringify({
          exchange: "binance",
          symbol: "BTCUSDT",
          action: "LONG",
          quantity: 0.01,
        }),
      }
    );
    const rpcRes = await d1Worker.fetch(
      writeAttempt as any,
      readEnv as any,
      createMockCtx() as any
    );
    expect(rpcRes.status).toBe(401);
  });

  test("scoped write key can access write RPC", async () => {
    mockDB.prepare = mock(() =>
      createMockPreparedStatement({
        runResult: {
          success: true,
          error: null,
          meta: { changes: 1, last_row_id: 1 },
        },
      })
    );

    const writeEnv = {
      ...mockEnv,
      D1_WRITE_KEY_BINDING: "write-key",
      INTERNAL_KEY_BINDING: undefined,
    };

    const request = new Request(
      "https://d1-worker.workers.dev/rpc/insert-trade",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Auth-Key": "write-key",
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
      writeEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(200);
  });

  test("reflects CORS_ALLOW_ORIGIN for matching browser Origin", async () => {
    const request = new Request("https://d1-worker.workers.dev/health", {
      method: "GET",
      headers: { Origin: "https://dashboard.hoox.sh" },
    });
    const response = await d1Worker.fetch(
      request as any,
      { ...mockEnv, CORS_ALLOW_ORIGIN: "https://dashboard.hoox.sh" } as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://dashboard.hoox.sh"
    );
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

  test("rejects multi-statement SELECT (semicolon abuse)", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({
        query: "SELECT * FROM trades; DROP TABLE trades",
        params: [],
      }),
    });
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(403);
    const data = (await response.json()) as any;
    expect(data.success).toBe(false);
    expect(String(data.error)).toMatch(/multi-statement|forbidden sql keyword/i);
  });

  test("rejects SELECT containing forbidden keyword (ATTACH)", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({
        // Keyword firewall must block even when the first token is SELECT
        query: "SELECT * FROM trades WHERE ATTACH IS NOT NULL",
        params: [],
      }),
    });
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(403);
    const data = (await response.json()) as any;
    expect(data.success).toBe(false);
    expect(String(data.error)).toMatch(/forbidden sql keyword/i);
  });

  test("rejects string literals in SELECT (must use params)", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({
        query: "SELECT * FROM trades WHERE symbol = 'BTCUSDT'",
        params: [],
      }),
    });
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(400);
    const data = (await response.json()) as any;
    expect(String(data.error)).toMatch(/string literal/i);
  });

  test("batch rejects oversized statement lists", async () => {
    const statements = Array.from({ length: 51 }, () => ({
      query: "SELECT * FROM trades LIMIT ?",
      params: [1],
    }));
    const request = new Request("https://d1-worker.workers.dev/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({ statements }),
    });
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(400);
    const data = (await response.json()) as any;
    expect(String(data.error)).toMatch(/max statements/i);
  });

  test("rejects too many bind params", async () => {
    const params = Array.from({ length: 65 }, (_, i) => i);
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({
        query: "SELECT * FROM trades WHERE id = ?",
        params,
      }),
    });
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(400);
    const data = (await response.json()) as any;
    expect(String(data.error)).toMatch(/too many params/i);
  });

  // ── Validation edge cases ──

  test("rejects UNION in SELECT", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({
        query: "SELECT id FROM trades UNION SELECT id FROM positions",
        params: [],
      }),
    });
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(403);
    const data = (await response.json()) as any;
    expect(String(data.error)).toMatch(/UNION/i);
  });

  test("rejects subqueries in WHERE", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({
        query: "SELECT * FROM trades WHERE (SELECT 1)",
        params: [],
      }),
    });
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(403);
    const data = (await response.json()) as any;
    expect(String(data.error)).toMatch(/Subquer/i);
  });

  test("rejects double-quoted identifiers", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({
        query: 'SELECT * FROM trades WHERE "id" = ?',
        params: [1],
      }),
    });
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(400);
    const data = (await response.json()) as any;
    expect(String(data.error)).toMatch(/Quoted identifiers/i);
  });

  test("strips SQL comments before validation (comment-only DROP bypass)", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({
        // DROP is still present after comment strip? Actually DROP is in the
        // statement text outside the comment — forbidden keyword firewall.
        query: "SELECT * FROM trades /* ignore */ WHERE id = ?",
        params: [1],
      }),
    });
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    // Clean SELECT with comment should pass validation and hit DB
    expect(response.status).toBe(200);
  });

  test("rejects empty query string", async () => {
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({ query: "   ", params: [] }),
    });
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    // Whitespace-only is not SELECT → free-form write rejection (410)
    // or validation 400 depending on order of checks.
    expect([400, 403, 410]).toContain(response.status);
  });

  test("rejects oversized SQL statement", async () => {
    // Length check runs on comment-stripped SQL, so pad with identifiers
    // (not a trailing `--` comment that would be stripped away).
    const huge =
      "SELECT " + Array.from({ length: 2000 }, (_, i) => `c${i}`).join(",") +
      " FROM trades";
    const request = new Request("https://d1-worker.workers.dev/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({ query: huge, params: [] }),
    });
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(400);
    const data = (await response.json()) as any;
    expect(String(data.error)).toMatch(/max length/i);
  });

  test("GET /api/logs returns log rows", async () => {
    mockPreparedStatement = createMockPreparedStatement({
      allResult: {
        success: true,
        error: null,
        results: [
          {
            id: 1,
            timestamp: 1,
            level: "INFO",
            module: "test",
            message: "hi",
            context: null,
          },
        ],
      },
    });
    mockDB = createMockDB(mockPreparedStatement);
    mockEnv = createMockEnv(mockDB, mockKV);

    const request = new Request("https://d1-worker.workers.dev/api/logs", {
      method: "GET",
      headers: { "X-Internal-Auth-Key": TEST_INTERNAL_KEY },
    });
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.success).toBe(true);
    expect(Array.isArray(data.logs)).toBe(true);
  });

  test("dashboard stats computes winRate when closed positions exist", async () => {
    // batch returns: totalTrades, activeOpen, totalClosed, profitable, daily, pnl
    mockDB.batch = mock(() =>
      Promise.resolve([
        { success: true, results: [{ count: 10 }] },
        { success: true, results: [{ count: 2 }] },
        { success: true, results: [{ count: 8 }] },
        { success: true, results: [{ count: 4 }] },
        { success: true, results: [{ count: 1 }] },
        { success: true, results: [{ total: 123.45 }] },
      ])
    );
    mockEnv = createMockEnv(mockDB, mockKV);

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
    expect(data.stats.totalTrades).toBe(10);
    expect(data.stats.winRate).toBe(50);
    expect(data.stats.totalPnlUSDT).toBe(123.45);
    expect(data.stats.activePositionsCount).toBe(2);
    expect(data.stats.dailyTradesCount).toBe(1);
  });

  test("POST /rpc/upsert-position accepts write", async () => {
    mockPreparedStatement = createMockPreparedStatement({
      runResult: {
        success: true,
        error: null,
        meta: { changes: 1, last_row_id: 1 },
      },
    });
    mockDB = createMockDB(mockPreparedStatement);
    mockEnv = createMockEnv(mockDB, mockKV);

    const request = new Request(
      "https://d1-worker.workers.dev/rpc/upsert-position",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
        },
        body: JSON.stringify({
          id: "pos-1",
          exchange: "binance",
          symbol: "BTCUSDT",
          side: "LONG",
          size: 0.01,
          status: "OPEN",
        }),
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
  });

  test("POST /rpc/upsert-position rejects missing fields", async () => {
    const request = new Request(
      "https://d1-worker.workers.dev/rpc/upsert-position",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
        },
        body: JSON.stringify({ id: "pos-1" }),
      }
    );
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(400);
  });

  test("POST /rpc/insert-signal accepts write", async () => {
    mockPreparedStatement = createMockPreparedStatement({
      runResult: {
        success: true,
        error: null,
        meta: { changes: 1, last_row_id: 1 },
      },
    });
    mockDB = createMockDB(mockPreparedStatement);
    mockEnv = createMockEnv(mockDB, mockKV);

    const request = new Request(
      "https://d1-worker.workers.dev/rpc/insert-signal",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
        },
        body: JSON.stringify({
          symbol: "ETHUSDT",
          signal_type: "BUY",
          timestamp: 1_700_000_000,
          source: "test",
        }),
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
    expect(data.signal_id).toBeDefined();
  });

  test("POST /rpc/insert-system-log accepts write", async () => {
    mockPreparedStatement = createMockPreparedStatement({
      runResult: {
        success: true,
        error: null,
        meta: { changes: 1, last_row_id: 1 },
      },
    });
    mockDB = createMockDB(mockPreparedStatement);
    mockEnv = createMockEnv(mockDB, mockKV);

    const request = new Request(
      "https://d1-worker.workers.dev/rpc/insert-system-log",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
        },
        body: JSON.stringify({
          level: "ERROR",
          source: "unit-test",
          message: "something broke",
          details: { code: 1 },
        }),
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
  });

  test("POST /rpc/insert-system-log rejects empty message", async () => {
    const request = new Request(
      "https://d1-worker.workers.dev/rpc/insert-system-log",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
        },
        body: JSON.stringify({ level: "INFO" }),
      }
    );
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(400);
  });

  test("batch rejects empty statements array", async () => {
    const request = new Request("https://d1-worker.workers.dev/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth-Key": TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({ statements: [] }),
    });
    const response = await d1Worker.fetch(
      request as any,
      mockEnv as any,
      createMockCtx() as any
    );
    expect(response.status).toBe(400);
  });

  test("dashboard stats returns 500 when batch throws", async () => {
    mockDB.batch = mock(() => Promise.reject(new Error("db offline")));
    mockEnv = createMockEnv(mockDB, mockKV);
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
    expect(response.status).toBe(500);
  });
});
