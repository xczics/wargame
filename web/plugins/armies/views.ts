// The armies plugin's views assembled in the browser (src/shared/client-views.ts).
import type { ArmyMarch, IncomingAttack, ResourceMeta, UnitMeta } from '../../../src/shared/api';
import { defineClientView } from '../../../src/shared/client-views';
import { alertTimers, marchTimers } from './timers';

export const views = [
	defineClientView({
		id: 'armies.alerts',
		needs: ['armies.incoming'],
		compute: (get) => alertTimers(get.data<IncomingAttack[]>('armies.incoming'), get.meta<UnitMeta[]>('units')),
	}),
	defineClientView({
		id: 'armies.marches',
		needs: ['armies.list'],
		compute: (get) =>
			marchTimers(
				get.data<ArmyMarch[]>('armies.list'),
				get.meta<UnitMeta[]>('units'),
				get.meta<ResourceMeta[]>('resources'),
				get.meta<Record<string, string>>('armyMissions'),
			),
	}),
];
