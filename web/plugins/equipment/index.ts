// Equipment in the browser: the gear rows and the paper doll worked out from the settlement's gear data (the server
// sends data only; the widgets and their places are declared by the server plugin). The doll's art comes from a content
// plugin through the `equipment` service (`setArt`); without one the doll shows the frames only. The same art draws the
// equipment's icons everywhere else (art icon scheme "equipment", src/shared/equipment.ts: ./PieceIcon.vue).
import { shallowRef, type ShallowRef } from 'vue';
import { EQUIPMENT_ICON } from '../../../src/shared/equipment';
import { ICON_POINT } from '../../../src/shared/icons';
import { defineClientPlugin } from '../../core/game';
import type { DollArt } from './art';
import Doll from './Doll.vue';
import PieceIcon from './PieceIcon.vue';
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
		game.clientPart({ point: ICON_POINT, id: EQUIPMENT_ICON, part: PieceIcon });
		for (const v of views) game.clientView(v.id, v);
	},
});
