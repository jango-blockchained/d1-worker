/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test, mock } from "bun:test";
import { computeDashboardStats } from "../src/stats";

function mockDb(
  rows: Array<{ count?: number; total?: number } | Error>
): D1Database {
  return {
    prepare: mock(() => ({
      bind: mock(() => ({
        // unused — batch path only
      })),
    })),
    batch: mock(async () => {
      return rows.map((r) => {
        if (r instanceof Error) throw r;
        if ("total" in r) {
          return { success: true, results: [{ total: r.total }] };
        }
        return { success: true, results: [{ count: r.count ?? 0 }] };
      });
    }),
  } as unknown as D1Database;
}

describe("computeDashboardStats", () => {
  test("returns zeros when all aggregates empty", async () => {
    const db = mockDb([
      { count: 0 },
      { count: 0 },
      { count: 0 },
      { count: 0 },
      { count: 0 },
      { total: 0 },
    ]);
    const result = await computeDashboardStats(db);
    expect("stats" in result).toBe(true);
    if ("stats" in result) {
      expect(result.stats.winRate).toBe(0);
      expect(result.stats.totalTrades).toBe(0);
      expect(result.stats.totalPnlUSDT).toBe(0);
    }
  });

  test("computes winRate from closed profitable positions", async () => {
    const db = mockDb([
      { count: 20 },
      { count: 3 },
      { count: 10 },
      { count: 7 },
      { count: 2 },
      { total: 999.5 },
    ]);
    const result = await computeDashboardStats(db);
    expect("stats" in result).toBe(true);
    if ("stats" in result) {
      expect(result.stats.winRate).toBe(70);
      expect(result.stats.totalPnlUSDT).toBe(999.5);
      expect(result.stats.activePositionsCount).toBe(3);
      expect(result.stats.dailyTradesCount).toBe(2);
    }
  });

  test("returns error object when batch fails", async () => {
    // prepare().bind() is called when building stmts; then batch throws.
    const db = {
      prepare: mock(() => ({
        bind: mock(() => ({})),
      })),
      batch: mock(async () => {
        throw new Error("batch failed");
      }),
    } as unknown as D1Database;
    const result = await computeDashboardStats(db);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/batch failed/);
    }
  });

  test("coerces non-finite PnL to 0", async () => {
    const db = mockDb([
      { count: 1 },
      { count: 0 },
      { count: 0 },
      { count: 0 },
      { count: 0 },
      { total: Number.NaN },
    ]);
    const result = await computeDashboardStats(db);
    if ("stats" in result) {
      expect(result.stats.totalPnlUSDT).toBe(0);
    }
  });
});
