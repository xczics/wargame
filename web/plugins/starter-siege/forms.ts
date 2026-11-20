// The starter-siege plugin's share in its forms ("forms.prepare", src/shared/forms.ts): the defences' count says its
// "at most" from this settlement's stock held in the browser (`resources.pool`), so it follows every command at once.
import type { FormPart, ResourcePool, SiegeBuildFormData } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { timesPaid } from '../../../src/shared/troops';

const build: FormPart<SiegeBuildFormData> = (d, { patch, data }) => {
	const pool = data<ResourcePool | null>('resources.pool');
	const stock = pool && pool.holder === `settlement:${patch.defaults?.settlement}` ? pool.amounts : undefined;
	const values = Object.fromEntries(
		Object.entries(d.costs).map(([id, cost]) => [id, stock ? Math.max(0, Math.min(d.batch, timesPaid(cost, stock))) : d.batch]),
	);
	return { ...patch, atMostBy: { ...patch.atMostBy, count: { field: 'device', values } } };
};

export const formParts = [defineClientPart({ point: 'forms.prepare', id: 'starter-siege.build', part: build, needs: ['resources.pool'] })];
