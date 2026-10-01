import { cloudflare } from '@cloudflare/vite-plugin';
import vue from '@vitejs/plugin-vue';
import type { AddressInfo } from 'node:net';
import { defineConfig, type Plugin } from 'vite';

/**
 * One dev server for everything: the Vue client (with HMR) plus the Worker, Durable
 * Objects and D1 running in workerd via the Cloudflare plugin.
 *
 * Local data (players, accounts, invites, GM rules) is persisted in `.data/local` and
 * survives restarts; only `pnpm data:reset` deletes it. `wrangler d1 ... --persist-to`
 * in package.json points at the same directory.
 */
// WARGAME_DATA_DIR lets throwaway runs (smoke tests) use their own data without touching yours.
export const LOCAL_DATA_DIR = process.env.WARGAME_DATA_DIR ?? '.data/local';

/**
 * Local servers do not run Cron Triggers, so due timeline events (armies arriving, mail...)
 * would only be committed when someone acts. Fire the Worker's scheduled handler every minute,
 * like production (`triggers.crons` in wrangler.jsonc).
 */
function localCron(): Plugin {
	const start = (server: { httpServer: { address(): AddressInfo | string | null; once(e: 'close', f: () => void): unknown } | null }) => {
		const timer = setInterval(async () => {
			const address = server.httpServer?.address();
			if (!address || typeof address === 'string') return;
			try {
				await fetch(`http://localhost:${address.port}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*`);
			} catch {
				// The server is restarting or shutting down: try again next minute.
			}
		}, 60_000);
		server.httpServer?.once('close', () => clearInterval(timer));
	};
	return { name: 'wargame-local-cron', configureServer: start, configurePreviewServer: start };
}

export default defineConfig({
	plugins: [vue(), cloudflare({ persistState: { path: LOCAL_DATA_DIR } }), localCron()],
});
