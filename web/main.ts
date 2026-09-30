import { createApp } from 'vue';
import App from './core/App.vue';
import { bootGame, GameKey, GameUiKey } from './core/game';
import { plugins } from './plugins';
import './styles.css';

try {
	const { game, ui } = await bootGame(plugins);
	createApp(App).provide(GameKey, game).provide(GameUiKey, ui).mount('#app');
} catch (err) {
	document.getElementById('app')!.textContent = `Failed to start: ${err instanceof Error ? err.message : err}`;
	console.error(err);
}
