import { createApp, type App } from 'vue';
import Frame from './core/App.vue';
import { bootGame, GameKey, GameUiKey, type BootCarry } from './core/game';
import { plugins } from './plugins';
import './styles.css';

let app: App | null = null;
async function start(carry?: BootCarry) {
	try {
		const { game, ui } = await bootGame(plugins, { carry, restart: (next) => void start(next) });
		app?.unmount();
		app = createApp(Frame).provide(GameKey, game).provide(GameUiKey, ui);
		app.mount('#app');
	} catch (err) {
		document.getElementById('app')!.textContent = `Failed to start: ${err instanceof Error ? err.message : err}`;
		console.error(err);
	}
}
await start();
