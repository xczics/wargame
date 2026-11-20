// Items: the Items page's cards and the item buttons elsewhere, worked out here from what the player has
// (`items.owned`, `items.extra`) and the statics; where they show is the server plugin's layout (generic widgets).
import { defineClientPlugin } from '../../core/game';
import { formParts } from './forms';
import { counted } from './patches';
import { views } from './views';

export default defineClientPlugin({
	id: 'items',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
		for (const p of formParts) game.clientPart(p);
		// Used (user 2026-11-20: "你告诉前端成功了，前端不就能更新了吗？"): one fewer in the inventory held here, on every page
		// that shows it; what the item did is the part of the plugin that defined it.
		const prefix = 'items.use.';
		game.afterCommand(
			(type) => type.startsWith(prefix),
			(type) => game.patchView<Record<string, number>>('items.owned', (owned) => counted(owned, type.slice(prefix.length), -1)),
		);
		// The GM's gift (negative: taken, never below none).
		game.afterCommand('items.grant', (_type, payload) => {
			const { item, count = 1 } = payload as { item: string; count?: number };
			game.patchView<Record<string, number>>('items.owned', (owned) => counted(owned, item, Number(count)));
		});
	},
});
