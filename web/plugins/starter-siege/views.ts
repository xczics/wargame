// The starter-siege plugin's views assembled in the browser (src/shared/client-views.ts).
import type {
	SettlementKindMeta,
	SettlementSummary,
	SiegeRules,
	SiegeUpkeepPart,
	SiegeWall,
	StatPercentPart,
} from '../../../src/shared/api';
import { defineClientView } from '../../../src/shared/client-views';
import { wallQueue, wallRows } from './wall';

export const views = [
	defineClientView({
		id: 'starter-siege.queue',
		needs: ['starter-siege.wall'],
		compute: (get) => wallQueue(get.data<SiegeWall | null>('starter-siege.wall'), get.meta('resources') ?? []),
	}),
	defineClientView({
		id: 'starter-siege.rows',
		points: ['stats.known', 'starter-siege.upkeep'],
		// (`settlements.mine` comes with every sync anyway: the settlement's kind.)
		needs: ['starter-siege.wall', 'settlements.mine'],
		compute: (get) => {
			const w = get.data<SiegeWall | null>('starter-siege.wall');
			// This settlement's kind, from what every page syncs and the meta: its wall's rule, and whether troops stand there.
			const kind = w ? get.data<SettlementSummary[]>('settlements.mine')?.find((s) => s.id === w.settlement)?.kind : undefined;
			const meta = get.meta<SettlementKindMeta[]>('settlementKinds')?.find((k) => k.id === kind);
			const rules = get.static<SiegeRules>('starter-siege.rules');
			// Other plugins' parts, from what the browser holds (research levels, the temple's progress): none until known.
			const known = [...get.parts<StatPercentPart>('stats.known').values()].flatMap(
				(part) => part('starter-siege.deviceStrength', get) ?? [],
			);
			const cuts = [...get.parts<SiegeUpkeepPart>('starter-siege.upkeep').values()].flatMap((part) => part(get) ?? []);
			return wallRows(w, get.meta('resources') ?? [], {
				rule: kind ? rules?.kinds[kind] : undefined,
				works: rules?.works,
				garrison: meta?.garrison ?? true,
				...(known.length ? { known } : {}),
				cuts,
			});
		},
	}),
];
