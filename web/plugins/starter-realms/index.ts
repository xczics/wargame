// The starter-realms plugin in the browser: words its realm keys' forms from the data their `prepare` sends (./forms.ts),
// and adds its share of a hero's adventure numbers on the hero cards (./parts.ts).
import type { RealmsOverview } from '../../../src/shared/api';
import { defineClientPlugin } from '../../core/game';
import { formParts } from './forms';
import { parts } from './parts';

export default defineClientPlugin({
	id: 'starter-realms',
	setup(game) {
		for (const p of [...formParts, ...parts]) game.clientPart(p);
		// A realm key used to open (user 2026-11-20: opened with a key, the realm still showed locked until a reload): the
		// realm is in the realms' overview held here at once (the key itself is taken off by the items plugin, every use).
		const prefix = 'items.use.realm-key-';
		game.afterCommand(
			(type) => type.startsWith(prefix),
			(type, payload) => {
				const realm = type.slice(prefix.length);
				if ((payload as { action?: string })?.action === 'unlock')
					game.patchView<RealmsOverview>('realms.overview', (o) =>
						o.unlocked.includes(realm) ? o : { ...o, unlocked: [...o.unlocked, realm] },
					);
			},
		);
	},
});
