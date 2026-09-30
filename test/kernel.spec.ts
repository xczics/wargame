import { describe, expect, it } from 'vitest';
import {
	createKernel,
	csvLevels,
	csvMap,
	csvRows,
	csvRules,
	definePlugin,
	numberFields,
	planRow,
	numberInRange,
	PluginError,
	loadConfig,
	resolveConfig,
	sortPlugins,
	type Plugin,
} from '../src/kernel';

const p = (id: string, dependsOn: string[] = [], setup: Plugin['setup'] = () => {}) =>
	definePlugin({ id, version: '0.0.0', dependsOn, setup });

describe('sortPlugins', () => {
	it('orders dependencies first, keeping declaration order otherwise', () => {
		const order = sortPlugins([p('c', ['b']), p('a'), p('b', ['a'])]).map((x) => x.id);
		expect(order).toEqual(['a', 'b', 'c']);
	});

	it('rejects missing dependencies, cycles, duplicates and bad ids', () => {
		expect(() => sortPlugins([p('a', ['nope'])])).toThrow(/not enabled/);
		expect(() => sortPlugins([p('a', ['b']), p('b', ['a'])])).toThrow(/cycle/);
		expect(() => sortPlugins([p('a'), p('a')])).toThrow(/Duplicate/);
		expect(() => sortPlugins([p('Bad_Id')])).toThrow(PluginError);
	});
});

describe('createKernel', () => {
	it('lets a plugin consume services of its dependencies', () => {
		const provider = p('provider', [], (ctx) => ctx.services.provide('session' as never, { hello: () => 'hi' } as never));
		let got = '';
		const consumer = p('consumer', ['provider'], (ctx) => {
			got = (ctx.services.get('session' as never) as { hello(): string }).hello();
		});
		createKernel([consumer, provider]);
		expect(got).toBe('hi');
	});

	it('rejects two plugins claiming the same command', () => {
		const cmd = { type: 'x.do', parse: () => null, execute: async () => {} };
		expect(() => createKernel([p('a', [], (c) => c.commands.add(cmd)), p('b', [], (c) => c.commands.add(cmd))])).toThrow(
			/both "a" and "b"/,
		);
	});
});

describe('config', () => {
	const tunable = p('tun', [], (c) => c.config.define('speed', { description: 'x', default: () => 1, parse: numberInRange(0, 10) }));

	it('namespaces keys, registers engine rules, and validates overrides', () => {
		const kernel = createKernel([tunable]);
		expect([...kernel.config.keys()]).toEqual(expect.arrayContaining(['engine.maxOfflineSeconds', 'tun.speed']));
		const { values, errors } = resolveConfig(kernel, { 'tun.speed': 99, 'gone.key': 1 });
		expect(values['tun.speed']).toBe(1);
		expect(Object.keys(errors).sort()).toEqual(['gone.key', 'tun.speed']);
		expect(resolveConfig(kernel, { 'tun.speed': 3 }).values['tun.speed']).toBe(3);
	});

	it('prunes stored overrides of rules that no longer exist, keeping invalid values of known rules', async () => {
		const stored: Record<string, unknown> = { 'tun.speed': 99, 'gone.key': 1 };
		const pruned: string[][] = [];
		const store = p('store', [], (c) =>
			c.services.provide('configStore', {
				load: async () => ({ ...stored }),
				prune: async (_env, keys) => void pruned.push(keys),
			}),
		);
		const { errors } = await loadConfig(createKernel([tunable, store]), {} as Env);
		expect(pruned).toEqual([['gone.key']]);
		expect(Object.keys(errors)).toEqual(['tun.speed']);
	});

	it('rejects duplicate keys', () => {
		expect(() => createKernel([p('tun', [], (c) => (c.config.define('a', tunableDef), c.config.define('a', tunableDef)))])).toThrow(
			/Config "tun.a"/,
		);
	});
});

const tunableDef = { description: '', default: () => 0, parse: (x: unknown) => x as number };

describe('data tables (CSV)', () => {
	it('reads rows, skipping comments and blank lines; quoted cells may hold commas', () => {
		const csv = '# a comment\nid,name,note\n\na,Alpha,"x, y"\nb,"Say ""hi""",\n';
		expect(csvRows(csv)).toEqual([
			{ id: 'a', name: 'Alpha', note: 'x, y' },
			{ id: 'b', name: 'Say "hi"', note: '' },
		]);
		expect(() => csvRows('a,b\n1,2,3')).toThrow(PluginError);
	});

	it('reads maps, dotted rules and planning tables', () => {
		expect(csvMap('food:1; wood:2.5')).toEqual({ food: 1, wood: 2.5 });
		expect(csvMap('')).toEqual({});
		expect(csvRules('key,value,note\na.b,1,x\na.c,2,\nd,3,')).toEqual({ a: { b: 1, c: 2 }, d: 3 });
		const levels = csvLevels('id,level,food,wood,seconds\nfarm,2,70,,25\nfarm,1,40,60,10');
		expect(levels.get('farm')).toEqual([
			{ cost: { food: 40, wood: 60 }, seconds: 10 },
			{ cost: { food: 70 }, seconds: 25 },
		]);
		expect(() => csvLevels('id,level,seconds\nx,2,5')).toThrow(/no level 1/);
		// Levels may be left out: they grow from the nearest lower row.
		const sparse = csvLevels('id,level,food,seconds\nw,1,10,5\nw,3,50,20').get('w')!;
		expect(sparse).toEqual([{ cost: { food: 10 }, seconds: 5 }, null, { cost: { food: 50 }, seconds: 20 }]);
		expect(planRow(sparse, 2)).toEqual({ row: sparse[0], beyond: 1 });
		expect(planRow(sparse, 3)).toEqual({ row: sparse[2], beyond: 0 });
		expect(planRow(sparse, 5)).toEqual({ row: sparse[2], beyond: 2 });
	});

	it('merges partial GM overrides over the file defaults', () => {
		const parse = numberFields(() => ({ a: 1, b: 2 }));
		expect(parse({ b: 5 })).toEqual({ a: 1, b: 5 });
		expect(() => parse({ c: 1 })).toThrow(/Unknown field/);
	});
});
