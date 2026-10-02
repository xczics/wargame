import { describe, expect, it } from 'vitest';
import {
	createKernel,
	fields,
	shape,
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

describe('command payloads (fields, shape)', () => {
	const parse = shape({
		settlement: fields.id(),
		count: fields.int(1, 100),
		share: fields.orElse(fields.number(0, 1), 0.5),
		note: fields.optional(fields.text({ max: 10 })),
		kind: fields.oneOf(['city', 'fortress'] as const),
		units: fields.optional(fields.record(fields.int(0, 1e6), { keys: () => ['spearman', 'militia'] })),
		lanes: fields.optional(fields.list(fields.oneOf(['infantry', 'archer']), { min: 5, max: 5 })),
	});
	const ok = { settlement: 's-1', count: '7', kind: 'city' };

	it('returns typed values: numeric strings from forms count, defaults fill in, unknown keys are dropped', () => {
		expect(parse({ ...ok, extra: 1 })).toEqual({ settlement: 's-1', count: 7, share: 0.5, kind: 'city' });
		expect(
			parse({ ...ok, note: '  hi ', units: { spearman: 3 }, lanes: ['infantry', 'archer', 'archer', 'infantry', 'archer'] }),
		).toMatchObject({
			note: 'hi',
			units: { spearman: 3 },
			lanes: ['infantry', 'archer', 'archer', 'infantry', 'archer'],
		});
		expect(parse({ ...ok, note: '' })).not.toHaveProperty('note');
	});

	it("refuses with the kernel's own bad_payload errors: a key of its translations and the field's path", () => {
		const refused = (raw: unknown) => {
			try {
				parse(raw);
			} catch (err) {
				return { code: (err as { code: string }).code, ...(err as { text: { text: string; vars?: Record<string, unknown> } }).text };
			}
			return null;
		};
		const k = (key: string, vars: Record<string, unknown>) => ({ code: 'bad_payload', text: `kernel.${key}`, vars });
		expect(refused({ ...ok, settlement: undefined })).toEqual(k('{0} is required', { 0: 'settlement' }));
		expect(refused({ ...ok, settlement: 'a b' })).toEqual(k('{0} must be an id', { 0: 'settlement' }));
		expect(refused({ ...ok, count: 1.5 })).toEqual(k('{0} must be a whole number from {1} to {2}', { 0: 'count', 1: 1, 2: 100 }));
		expect(refused({ ...ok, count: 101 })).toEqual(k('{0} must be a whole number from {1} to {2}', { 0: 'count', 1: 1, 2: 100 }));
		expect(refused({ ...ok, share: 2 })).toEqual(k('{0} must be a number from {1} to {2}', { 0: 'share', 1: 0, 2: 1 }));
		expect(refused({ ...ok, note: 'x'.repeat(11) })).toEqual(k('{0}: {1}-{2} characters', { 0: 'note', 1: 1, 2: 10 }));
		expect(refused({ ...ok, kind: 'village' })).toEqual(k('{0} must be one of: {1}', { 0: 'kind', 1: 'city, fortress' }));
		expect(refused({ ...ok, units: { knight: 1 } })).toEqual(k('{0} is unknown', { 0: 'units.knight' }));
		expect(refused({ ...ok, units: { spearman: -1 } })).toEqual(
			k('{0} must be a whole number from {1} to {2}', { 0: 'units.spearman', 1: 0, 2: 1e6 }),
		);
		expect(refused({ ...ok, lanes: ['infantry'] })).toEqual(k('{0} must be a list of {1}-{2} items', { 0: 'lanes', 1: 5, 2: 5 }));
		expect(refused('nope')).toEqual({ code: 'bad_payload', text: 'kernel.The payload must be an object' });
	});
});
