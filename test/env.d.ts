declare namespace Cloudflare {
	interface Env {
		// Defined in vitest.config.mts; only present in tests.
		TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
	}
}
