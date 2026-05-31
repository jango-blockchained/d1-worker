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
    // Total trades
    const totalRow = await db
      .prepare("SELECT COUNT(*) as count FROM trades")
      .first<{ count: number }>();
    const totalTrades = totalRow?.count ?? 0;

    // Active positions count
    const activePosRow = await db
      .prepare("SELECT COUNT(*) as count FROM positions WHERE status = 'OPEN'")
      .first<{ count: number }>();
    const activePositionsCount = activePosRow?.count ?? 0;

    // Trades today (unix epoch start of current day)
    const now = Math.floor(Date.now() / 1000);
    const todayStart = now - (now % 86400);
    const dailyRow = await db
      .prepare("SELECT COUNT(*) as count FROM trades WHERE timestamp >= ?")
      .bind(todayStart)
      .first<{ count: number }>();
    const dailyTradesCount = dailyRow?.count ?? 0;

    // Calculate win rate and total P&L
    const profitableRow = await db
      .prepare(
        "SELECT COUNT(*) as count FROM positions WHERE status = 'CLOSED' AND unrealized_pnl > 0"
      )
      .first<{ count: number }>();
    const totalClosedPositionsRow = await db
      .prepare(
        "SELECT COUNT(*) as count FROM positions WHERE status = 'CLOSED'"
      )
      .first<{ count: number }>();

    let winRate = 0;
    if (totalClosedPositionsRow?.count && totalClosedPositionsRow.count > 0) {
      winRate =
        Math.round(
          ((profitableRow?.count ?? 0) / totalClosedPositionsRow.count) *
            100 *
            10
        ) / 10;
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
