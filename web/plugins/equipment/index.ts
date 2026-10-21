// Equipment in the browser: the gear rows and the paper doll worked out from the settlement's gear data (the server
// sends data only; the widgets and their places are declared by the server plugin). The doll's art comes from a content
// plugin through the `equipment` service (`setArt`); without one the doll shows the frames only.
import { shallowRef, type ShallowRef } from 'vue';
import { defineClientPlugin } from '../../core/game';
import type { DollArt } from './art';
import Doll from './Doll.vue';
import { views } from './views';

export interface EquipmentClientService {
	art: ShallowRef<DollArt | null>;
	setArt(art: DollArt): void;
}

declare module '../../core/game' {
	interface ClientServiceMap {
		equipment: EquipmentClientService;
	}
}

export default defineClientPlugin({
	id: 'equipment',
	setup(game) {
		game.messages('zh-CN', {
			'Needs level {0}': '需要 {0} 级',
			'Empty slot': '空位',
			Stored: '存放',
			Worn: '已穿戴',
		});
		const art = shallowRef<DollArt | null>(null);
		game.provide('equipment', { art, setArt: (a) => (art.value = a) });
		game.widget('equipment.doll', Doll);
		for (const v of views) game.clientView(v.id, v);
	},
});
