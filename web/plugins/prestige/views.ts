// The prestige plugin's views assembled in the browser (src/shared/client-views.ts).
import type { PrestigeStatus } from '../../../src/shared/api';
import { defineClientView } from '../../../src/shared/client-views';
import { prestigeBadge } from './badge';

export const views = [
	defineClientView({
		id: 'prestige.badge',
		needs: ['prestige.status'],
		compute: (get) => prestigeBadge(get.data<PrestigeStatus | null>('prestige.status')),
	}),
];
