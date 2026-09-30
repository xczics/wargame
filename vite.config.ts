import { cloudflare } from '@cloudflare/vite-plugin';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

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

export default defineConfig({
	plugins: [vue(), cloudflare({ persistState: { path: LOCAL_DATA_DIR } })],
});
