// The Map page: a window onto the wrapping world map. Selecting a free tile shows the
// server-driven forms for it (placement "tile", e.g. founding a city or fortress).
import { defineClientPlugin } from '../../core/game';
import MapPage from './MapPage.vue';

export default defineClientPlugin({
	id: 'world-map',
	dependsOn: ['settlement', 'forms'],
	setup(game) {
		game.messages('zh-CN', {
			Map: '地图',
			'My settlement': '我的城池',
			Go: '前往',
			'centre ({x}, {y}) · the world wraps at ±512': '中心 ({x}, {y}) · 世界在 ±512 处首尾相接',
			'Tile ({x}, {y})': '地块 ({x}, {y})',
			yours: '你的',
			Open: '打开',
			'Free land.': '空地。',
			'NPC settlements nearby': '周边 NPC 城池',
			Within: '范围',
			'{n} tiles': '{n} 格',
			'Around the centre of the map ({x}, {y}).': '以地图中心（{x}, {y}）为圆心。',
			'None.': '无。',
			'{name} ({kind})': '{name}（{kind}）',
		});
		// The map needs the whole area: the server declares a page taken over by this widget.
		game.widget('world-map.page', MapPage);
	},
});
