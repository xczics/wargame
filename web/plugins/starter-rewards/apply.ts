// What the starter kinds of rewards change in the player's data held in the browser, once a claim went through: parts at
// "rewards.apply" by kind, doing what their `give` did on the server (src/plugins/starter-rewards). Items and yuanbao are
// counted on; troops join the capital's garrison; a hero, a piece of equipment or the defence are the server's to tell
// (drawn there, or numbers the browser does not hold): their views are asked for again where they show next. Resources
// need nothing: the pool is in every sync. Pure: the tests run them.
import type { GarrisonInfo, Meta, RewardApplyPart, SettlementSummary, ShopWallet, TroopsState, UnitCatalog } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { movedUnits } from '../../../src/shared/troops';

/** A garrison with `n` of `unit` come in (the upkeep scaled with the units, as the troops' own patches do). */
const joined = <G extends { units: { id: string; count: number }[]; upkeep: Record<string, number> }>(
	g: G,
	unit: string,
	n: number,
	catalog: UnitCatalog | undefined,
) => movedUnits(g, { [unit]: -n }, (u) => catalog?.[u]);

export const applyParts = [
	defineClientPart<RewardApplyPart>({
		point: 'rewards.apply',
		id: 'item',
		part: (c, to) => {
			const { item, count } = c as { item: string; count: number };
			to.patchView<Record<string, number>>('items.owned', (owned) => ({ ...owned, [item]: (owned[item] ?? 0) + count * to.times }));
		},
	}),
	defineClientPart<RewardApplyPart>({
		point: 'rewards.apply',
		id: 'coupons',
		part: (c, to) => {
			const n = (c as { amount: number }).amount * to.times;
			to.patchView<ShopWallet>('shop.wallet', (w) => ({ ...w, balance: w.balance + n }));
		},
	}),
	defineClientPart<RewardApplyPart>({
		point: 'rewards.apply',
		id: 'troops',
		part: (c, to) => {
			const { unit, count } = c as { unit: string; count: number };
			const capitalKind = to.get.meta<Meta['settlementKinds']>('settlementKinds')?.find((k) => k.capital)?.id;
			const capital = to.get.data<SettlementSummary[]>('settlements.mine')?.find((s) => s.kind === capitalKind)?.id;
			if (!capital) {
				to.markStale('troops.state');
				to.markStale('troops.garrison');
				return;
			}
			const catalog = to.get.static<UnitCatalog>('troops.units');
			const n = count * to.times;
			let empty = false;
			to.patchView<TroopsState>('troops.state', (s) => ({
				...s,
				garrisons: s.garrisons.map((g) => {
					if (g.settlement !== capital) return g;
					empty ||= !g.units.length;
					return joined(g, unit, n, catalog);
				}),
			}));
			to.patchView<GarrisonInfo | null>('troops.garrison', (g) => {
				if (!g || g.settlement !== capital) return g;
				empty ||= !g.units.length;
				return joined(g, unit, n, catalog);
			});
			// Upkeep scales from what the garrison had: from none, only the server can say what it is.
			if (empty) {
				to.markStale('troops.state');
				to.markStale('troops.garrison');
			}
		},
	}),
	// A piece made like a drop (its stats drawn): the storage as the server has it next time it shows.
	defineClientPart<RewardApplyPart>({ point: 'rewards.apply', id: 'equipment', part: (_c, to) => to.markStale('equipment.items') }),
	// The wall's defence on the City page (its effects there).
	defineClientPart<RewardApplyPart>({ point: 'rewards.apply', id: 'defense', part: (_c, to) => to.markStale('buildings.state') }),
	...['hero', 'hero-female'].map((id) =>
		defineClientPart<RewardApplyPart>({
			point: 'rewards.apply',
			id,
			// Drawn on the server (its name, attributes, id): wherever heroes are listed.
			part: (_c, to) => {
				for (const view of ['heroes.list', 'heroes.state', 'realms.overview', 'equipment.items']) to.markStale(view);
			},
		}),
	),
];
