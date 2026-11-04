// The drawn icon set: icon ids ("grain", src/shared/icons.ts) drawn as pixel sprites by the renderer of the art icon
// scheme "icon" (registered at "ui.icon", web/widgets/Icon.vue). The system knows no icon of its own: content plugins
// add their art packs through the `icons` service (`add`); an id no pack draws shows nothing.
import { shallowReactive } from 'vue';
import { ICON_POINT, ICON_SET } from '../../../src/shared/icons';
import { defineClientPlugin } from '../../core/game';
import type { IconArt } from './image';
import SetIcon from './SetIcon.vue';

export type { IconArt };

export interface IconsClientService {
	/** Add icons (a later pack's icon of the same id replaces the earlier one: a third party may redraw). */
	add(pack: Record<string, IconArt>): void;
	get(id: string): IconArt | undefined;
}

declare module '../../core/game' {
	interface ClientServiceMap {
		icons: IconsClientService;
	}
}

export default defineClientPlugin({
	id: 'icons',
	setup(game) {
		const art = shallowReactive(new Map<string, IconArt>());
		game.provide('icons', {
			add: (pack) => Object.entries(pack).forEach(([id, a]) => art.set(id, a)),
			get: (id) => art.get(id),
		});
		game.clientPart({ point: ICON_POINT, id: ICON_SET, part: SetIcon });
	},
});
