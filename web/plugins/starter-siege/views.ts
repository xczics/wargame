// The starter-siege plugin's views assembled in the browser (src/shared/client-views.ts).
import type {
	SettlementKindMeta,
	SettlementSummary,
	SiegeRules,
	SiegeUpkeepPart,
	SiegeWallData,
	StatPercentPart,
} from '../../../src/shared/api';
import { type ClientViewGet, defineClientView } from '../../../src/shared/client-views';
import { siegeWallOf } from '../../../src/shared/siege';
import { wallQueue, wallRows } from './wall';

/** The wall held (`starter-siege.wall`) with the rules' numbers (static `starter-siege.rules`): undefined until both are. */
function wallOf(get: ClientViewGet) {
	const d = get.data<SiegeWallData | null>('starter-siege.wall');
	const rules = get.static<SiegeRules>('starter-siege.rules');
	if (d === undefined || (d && !rules)) return { wall: undefined };
	if (!d || !rules) return { wall: null };
	// This settlement's kind, from what every page syncs and the meta: its wall's rule, and whether troops stand there.
	const kind = get.data<SettlementSummary[]>('settlements.mine')?.find((s) => s.id === d.settlement)?.kind;
	const rule = kind ? rules.kinds[kind] : undefined;
	return { wall: siegeWallOf(d, rules, rule), kind, rule, rules };
}

export const views = [
	defineClientView({
		id: 'starter-siege.queue',
		needs: ['starter-siege.wall', 'settlements.mine'],
		compute: (get) => wallQueue(wallOf(get).wall, get.meta('resources') ?? []),
	}),
	defineClientView({
		id: 'starter-siege.rows',
		points: ['stats.known', 'starter-siege.upkeep'],
		// (`settlements.mine` comes with every sync anyway: the settlement's kind.)
		needs: ['starter-siege.wall', 'settlements.mine'],
		compute: (get) => {
			const { wall: w, kind, rule, rules } = wallOf(get);
			const meta = get.meta<SettlementKindMeta[]>('settlementKinds')?.find((k) => k.id === kind);
			// Other plugins' parts, from what the browser holds (research levels, the temple's progress): none until known.
			const known = [...get.parts<StatPercentPart>('stats.known').values()].flatMap(
				(part) => part('starter-siege.deviceStrength', get) ?? [],
			);
			const cuts = [...get.parts<SiegeUpkeepPart>('starter-siege.upkeep').values()].flatMap((part) => part(get) ?? []);
			return wallRows(w, get.meta('resources') ?? [], {
				rule,
				works: rules?.works,
				garrison: meta?.garrison ?? true,
				...(known.length ? { known } : {}),
				cuts,
			});
		},
	}),
];
