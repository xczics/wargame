/**
 * Static views across deploys (src/runtime/statics.ts): a new build bakes again only the views its code changed (their
 * fingerprints, worked out by the build), and writes only bodies that came out different.
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { createKernel, definePlugin } from '../src/kernel';
import { staticFingerprints, staticVersions, type StaticStore } from '../src/runtime/statics';

describe('static views across builds', () => {
	it('a new build keeps the views whose fingerprint is the same, bakes the others, writes only what changed', async () => {
		const files = new Map<string, string>();
		const puts: string[] = [];
		const baked: string[] = [];
		const store: StaticStore = {
			get: async (k) => files.get(k) ?? null,
			put: async (k, body) => void (puts.push(k), files.set(k, body)),
		};
		let shape = 1;
		const plugin = definePlugin({
			id: 'statics-test',
			version: '0.0.1',
			setup(ctx) {
				ctx.services.provide('staticStore', store);
				ctx.statics.add({ id: 'statics-test.a', compute: () => (baked.push('a'), { a: 1 }) });
				ctx.statics.add({ id: 'statics-test.b', compute: () => (baked.push('b'), { b: shape }) });
			},
		});
		const rules = { values: {}, version: 1 };
		const first = createKernel([plugin], { build: 'one' });
		const fp1 = await staticFingerprints(first);
		baked.length = 0;
		const v1 = await staticVersions(first, env, rules, fp1);
		expect(baked.sort()).toEqual(['a', 'b']);
		// Another build, the same code for both: nothing baked, nothing written.
		puts.length = 0;
		baked.length = 0;
		const second = createKernel([plugin], { build: 'two' });
		expect(await staticVersions(second, env, rules, await staticFingerprints(second).then((f) => ((baked.length = 0), f)))).toEqual(v1);
		expect(baked).toEqual([]);
		expect(puts.filter((k) => !k.endsWith('manifest.json'))).toEqual([]);
		// A build that changes b: only b is baked again and written.
		shape = 2;
		puts.length = 0;
		const third = createKernel([plugin], { build: 'three' });
		const fp3 = await staticFingerprints(third);
		baked.length = 0;
		const v3 = await staticVersions(third, env, rules, fp3);
		expect(baked).toEqual(['b']);
		expect(v3['statics-test.a']).toBe(v1['statics-test.a']);
		expect(v3['statics-test.b']).not.toBe(v1['statics-test.b']);
		expect(puts.filter((k) => !k.endsWith('manifest.json'))).toEqual([`static/statics-test.b/${v3['statics-test.b']}.json`]);
	});
});
