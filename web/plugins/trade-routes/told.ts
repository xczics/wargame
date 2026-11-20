// Pure parts of what the trade routes' commands tell the browser's data (./commands.ts): the tests run them.
import type { TradeColumn, TradeMerchant } from '../../../src/shared/trade-routes';

/** Everyone a team takes along: its columns' men and the auxiliaries. */
export function teamMen(team: readonly TradeColumn[], auxiliaries: Record<string, number>): Record<string, number> {
	const all: Record<string, number> = {};
	for (const [u, n] of Object.entries(auxiliaries)) all[u] = (all[u] ?? 0) + n;
	for (const c of team) for (const [u, n] of Object.entries(c.units)) all[u] = (all[u] ?? 0) + n;
	return all;
}

/** A merchant's goods after one is bought. */
export const boughtOne = (m: TradeMerchant | null, goods: string): TradeMerchant | null =>
	m && m.goods.some((g) => g.id === goods) ? { ...m, goods: m.goods.map((g) => (g.id === goods ? { ...g, bought: g.bought + 1 } : g)) } : m;
