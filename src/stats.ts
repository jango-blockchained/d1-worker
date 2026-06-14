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

    // All 5 queries are independent aggregates — batch them for single round-trip
    const stmts = [
      db.prepare("SELECT COUNT(*) as count FROM trades"),
      db.prepare(
        "SELECT COUNT(*) as count FROM positions WHERE status = 'OPEN'"
      ),
      db.prepare(
        "SELECT COUNT(*) as count FROM positions WHERE status = 'CLOSED'"
      ),
      db.prepare(
        "SELECT COUNT(*) as count FROM positions WHERE status = 'CLOSED' AND unrealized_pnl > 0"
      ),
      db
        .prepare("SELECT COUNT(*) as count FROM trades WHERE timestamp >= ?")
        .bind(todayStart),
    ];

    const [totalRow, activePosRow, totalClosedRow, profitableRow, dailyRow] =
      await db.batch(stmts);

    const totalTrades = (totalRow as { count: number } | null)?.count ?? 0;
    const activePositionsCount =
      (activePosRow as { count: number } | null)?.count ?? 0;
    const dailyTradesCount = (dailyRow as { count: number } | null)?.count ?? 0;

    const closedCount =
      (totalClosedRow as { count: number } | null)?.count ?? 0;
    const profitCount = (profitableRow as { count: number } | null)?.count ?? 0;

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
