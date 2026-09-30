import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Only applies migrations not yet applied, so it is safe to run for every test file.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
