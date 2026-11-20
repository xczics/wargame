// The starter-levies plugin in the browser: words its levy orders' forms from the data their `prepare` sends (./forms.ts),
// and counts the quota on in the forms held here as orders are used and units trained (./patches.ts).
import type { FormPatches } from '../../../src/shared/api';
import { defineClientPlugin } from '../../core/game';
import { formParts } from './forms';
import { quotaChanged } from './patches';

const PREFIX = 'items.use.levy-';

export default defineClientPlugin({
	id: 'starter-levies',
	setup(game) {
		for (const p of formParts) game.clientPart(p);
		game.afterCommand(
			(type) => type.startsWith(PREFIX),
			(type) => game.patchView<FormPatches>('forms.patches', (p) => quotaChanged(p, type.slice(PREFIX.length), (q) => q.adds)),
		);
		// The GM's quota for the player.
		game.afterCommand('starter-levies.grant', (_type, payload) => {
			const { unit, quota } = payload as { unit: string; quota: number };
			game.patchView<FormPatches>('forms.patches', (p) => quotaChanged(p, unit, () => Number(quota)));
		});
		// Training ordered takes quota of a levied unit (the server's training requirement; others have no levy form).
		game.afterCommand('troops.train', (_type, payload) => {
			const { unit, count } = payload as { unit: string; count: number };
			game.patchView<FormPatches>('forms.patches', (p) => quotaChanged(p, unit, () => -Number(count)));
		});
	},
});
