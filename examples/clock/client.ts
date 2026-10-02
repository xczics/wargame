// The client half of the clock example: registers the widget; where it goes is declared by ./server.ts
// (ui.band), and the server's view gives the setting.
import { defineClientPlugin } from '../../web/core/game';
import Clock from './Clock.vue';

export default defineClientPlugin({
	id: 'clock',
	setup(game) {
		game.messages('zh-CN', { 'Server time': '服务器时间' });
		game.widget('clock.time', Clock);
	},
});
