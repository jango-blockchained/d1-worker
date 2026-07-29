/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

import type { D1Database } from "@cloudflare/workers-types";
import { toError } from "@jango-blockchained/hoox-shared/errors";

export interface DashboardStats {
  totalTrades: number;
  winRate: number;
  totalPnlUSDT: number;
  activePositionsCount: number;
  dailyTradesCount: number;
}

export async function computeDashboardStats(
  db: D1Database
): Promise<{ stats: DashboardStats } | { error: string }> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const todayStart = now - (now % 86400);

    // All 5 queries are independent aggregates — batch them for single round-trip.
    // Exclude testnet fills (status TEST_EXECUTED) and namespaced test positions
    // (`%-testnet-%` ids) so dashboard headlines reflect live exposure only.
    const stmts = [
      db.prepare(
        "SELECT COUNT(*) as count FROM trades WHERE status IS NULL OR status != 'TEST_EXECUTED'"
      ),
      db.prepare(
        "SELECT COUNT(*) as count FROM positions WHERE status = 'OPEN' AND id NOT LIKE '%-testnet-%'"
      ),
      db.prepare(
        "SELECT COUNT(*) as count FROM positions WHERE status = 'CLOSED' AND id NOT LIKE '%-testnet-%'"
      ),
      db.prepare(
        "SELECT COUNT(*) as count FROM positions WHERE status = 'CLOSED' AND id NOT LIKE '%-testnet-%' AND unrealized_pnl > 0"
      ),
      db
        .prepare(
          "SELECT COUNT(*) as count FROM trades WHERE timestamp >= ? AND (status IS NULL OR status != 'TEST_EXECUTED')"
        )
        .bind(todayStart),
    ];

    const [totalRow, activePosRow, totalClosedRow, profitableRow, dailyRow] =
      await db.batch(stmts);

    // db.batch returns D1Result[] — each .results array contains the rows
    const totalTrades =
      (totalRow.results?.[0] as { count: number } | undefined)?.count ?? 0;
    const activePositionsCount =
      (activePosRow.results?.[0] as { count: number } | undefined)?.count ?? 0;
    const dailyTradesCount =
      (dailyRow.results?.[0] as { count: number } | undefined)?.count ?? 0;

    const closedCount =
      (totalClosedRow.results?.[0] as { count: number } | undefined)?.count ??
      0;
    const profitCount =
      (profitableRow.results?.[0] as { count: number } | undefined)?.count ?? 0;

    let winRate = 0;
    if (closedCount > 0) {
      winRate = Math.round((profitCount / closedCount) * 100 * 10) / 10;
    }

    return {
      stats: {
        totalTrades,
        winRate,
        totalPnlUSDT: 0,
        activePositionsCount,
        dailyTradesCount,
      },
    };
  } catch (error) {
    return { error: toError(error) };
  }
}
