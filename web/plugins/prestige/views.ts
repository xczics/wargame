// The prestige plugin's views assembled in the browser (src/shared/client-views.ts).
import type { PrestigeData, PrestigeRanks } from '../../../src/shared/api';
import { prestigeOf } from '../../../src/shared/prestige';
import { defineClientView } from '../../../src/shared/client-views';
import { prestigeBadge } from './badge';

export const views = [
	defineClientView({
		id: 'prestige.badge',
		needs: ['prestige.status'],
		compute: (get) => {
			const d = get.data<PrestigeData | null>('prestige.status');
			const ranks = get.static<PrestigeRanks>('prestige.ranks');
			if (d === undefined || (d && !ranks)) return undefined;
			return prestigeBadge(d && ranks ? prestigeOf(d, ranks) : null);
		},
	}),
];
