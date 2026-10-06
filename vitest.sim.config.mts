// `pnpm sim`: simulated play-throughs (test/sim/*.sim.ts) with the engine and a fake clock, for balancing; not part of
// `pnpm check` (slow, and they print reports rather than assert).
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.mts';

export default defineConfig(async (env) =>
	mergeConfig(await (typeof base === 'function' ? base(env) : base), { test: { include: ['test/sim/**/*.sim.ts'], testTimeout: 600_000 } }),
);
