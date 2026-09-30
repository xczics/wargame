import { describe, expect, it } from 'vitest';
import { createKernel, definePlugin, numberInRange, PluginError, resolveConfig, sortPlugins, type Plugin } from '../src/kernel';

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

	it('rejects duplicate keys', () => {
		expect(() => createKernel([p('tun', [], (c) => (c.config.define('a', tunableDef), c.config.define('a', tunableDef)))])).toThrow(
			/Config "tun.a"/,
		);
	});
});

const tunableDef = { description: '', default: () => 0, parse: (x: unknown) => x as number };
