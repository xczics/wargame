import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
	const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					bindings: {
						// Test-only: lets test/apply-migrations.ts create the D1 schema.
						TEST_MIGRATIONS: migrations,
						// Stand-ins for the GM secrets.
						GM_USERNAME: 'gm',
						GM_PASSWORD: 'gm-test-password',
					},
				},
			}),
		],
		test: { setupFiles: ['./test/apply-migrations.ts'] },
	};
});
