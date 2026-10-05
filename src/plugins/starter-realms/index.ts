/**
 * Default realm content (docs/design/gameplay.md §9), all numbers in ./data (CSV): the ten
 * realms and their five tasks (monster numbers grow with a difficulty step), what a hero's
 * attributes are worth in an adventure, the item drops, and the keys — dropped by clearing a
 * realm's hardest task, used to open the next realm or traded for a few resources.
 */
import {
	csvNumber,
	csvRows,
	csvRules,
	definePlugin,
	fields,
	gameErrors,
	numberFields,
	PluginError,
	type ReadApi,
	shape,
} from '../../kernel';
import type { MonsterGroup } from '../../shared/realms';
import type { RealmDef, RealmTask } from '../realms';
import dropsCsv from './data/drops.csv?raw';
import heroStatsCsv from './data/hero-stats.csv?raw';
import realmsCsv from './data/realms.csv?raw';
import rulesCsv from './data/rules.csv?raw';
import tasksCsv from './data/tasks.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { uiTexts } from '../../shared/i18n';

const fail = gameErrors('starter-realms');
const text = uiTexts('starter-realms');

const RULES = csvRules(rulesCsv);
const REALMS = csvRows(realmsCsv).map((r) => ({
	id: r.id,
	name: r.name,
	order: csvNumber(r, 'order'),
	quote: r.quote || undefined,
	monsters: r.monsters.split(';').map((m) => m.trim()),
	boss: r.boss,
	difficulty: r.difficulty ? csvNumber(r, 'difficulty') : 1,
}));
/** Each realm's tasks, easiest first (tasks.csv: 4-6 a realm). */
const TASKS = new Map<string, { name: string; groups: number; power: number; loot: number; exp: number }[]>();
for (const r of csvRows(tasksCsv)) {
	const list = TASKS.get(r.realm) ?? [];
	if (csvNumber(r, 'task') !== list.length + 1) throw new PluginError(`tasks.csv: ${r.realm}'s tasks must be numbered 1, 2, ... in order`);
	list.push(taskRow(r));
	TASKS.set(r.realm, list);
}
function taskRow(r: Record<string, string>) {
	return {
		name: r.name,
		groups: csvNumber(r, 'groups'),
		power: csvNumber(r, 'power'),
		loot: csvNumber(r, 'loot'),
		exp: csvNumber(r, 'exp'),
	};
}
for (const r of REALMS) if (!TASKS.get(r.id)?.length) throw new PluginError(`tasks.csv: realm "${r.id}" has no tasks`);
/** Adventure stat -> { base, attribute: factor }. */
const HERO_STATS: Record<string, Record<string, number>> = Object.fromEntries(
	csvRows(heroStatsCsv).map(({ stat, ...cells }) => [stat, Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, Number(v) || 0]))]),
);
const DROPS = csvRows(dropsCsv).map((r) => ({
	id: r.id,
	item: r.item,
	count: csvNumber(r, 'count'),
	weight: csvNumber(r, 'weight'),
	from: csvNumber(r, 'from'),
	to: csvNumber(r, 'to'),
}));
const keyId = (realm: string) => `realm-key-${realm}`;

export default definePlugin({
	id: 'starter-realms',
	version: '0.1.0',
	description: 'Ten realms, their monsters, adventure stats, drops and keys',
	dependsOn: ['realms', 'heroes', 'items', 'starter-items', 'settlements', 'resources', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const realms = ctx.services.get('realms');
		const items = ctx.services.get('items');
		const settlements = ctx.services.get('settlements');
		const resources = ctx.services.get('resources');

		const monsters = ctx.config.define('monsters', {
			description:
				'Monster groups: attack / defense / hp at realm 1 task 1, x growth per difficulty step (5 per realm, 1 per task), +groupStep per later group, x boss for the boss.',
			default: () => RULES.monsters as Record<string, number>,
			parse: numberFields(() => RULES.monsters as Record<string, number>, 0, 1e9),
		});
		const exp = ctx.config.define('exp', {
			description: 'Experience per beaten group: base x growth^step (x the task factor in tasks.csv).',
			default: () => RULES.exp as Record<string, number>,
			parse: numberFields(() => RULES.exp as Record<string, number>, 0, 1e9),
		});
		const keyRule = ctx.config.define('key', {
			description: 'perRealm: a key to realm N trades for perRealm x N of every resource.',
			default: () => RULES.key as Record<string, number>,
			parse: numberFields(() => RULES.key as Record<string, number>, 0, 1e9),
		});
		const heroStats = ctx.config.define('heroStats', {
			description:
				'Adventure numbers from attributes: { attack|defense|hp|recovery: { base, <attribute>: factor } } (partial overrides allowed).',
			default: () => HERO_STATS,
			parse(raw) {
				if (typeof raw !== 'object' || raw === null) throw fail('bad_config', 'Expected { stat: { base, attribute: factor } }');
				const out = structuredClone(HERO_STATS);
				for (const [stat, row] of Object.entries(raw)) {
					if (!out[stat]) throw fail('bad_config', text('Unknown stat "{0}"', { 0: stat }));
					out[stat] = numberFields(() => HERO_STATS[stat], -1e6, 1e6)(row);
				}
				return out;
			},
		});

		const difficulty = ctx.config.define('difficulty', {
			description: "Each realm's monsters (attack, defence, hp) x this, by realm (partial: the realms given change).",
			default: () => Object.fromEntries(REALMS.map((r) => [r.id, r.difficulty])),
			parse: numberFields(() => Object.fromEntries(REALMS.map((r) => [r.id, r.difficulty])), 0.01, 100),
		});
		const tasksOf = (api: ReadApi, r: (typeof REALMS)[number]): RealmTask[] => {
			const m = monsters.get(api);
			const e = exp.get(api);
			const tasks = TASKS.get(r.id)!;
			return tasks.map((t, ti) => {
				// The realm's strength, times the task's own (tasks.csv `power`).
				const step = 5 * (r.order - 1);
				const scale = m.growth ** step * t.power * (difficulty.get(api)[r.id] ?? 1);
				const groups: MonsterGroup[] = Array.from({ length: t.groups }, (_, g) => {
					const boss = ti === tasks.length - 1 && g === t.groups - 1;
					const k = scale * (1 + m.groupStep * g) * (boss ? m.boss : 1);
					return {
						name: boss ? r.boss : r.monsters[g % r.monsters.length],
						attack: Math.round(m.attack * k),
						defense: Math.round(m.defense * k),
						hp: Math.round(m.hp * k),
						...(boss ? { boss: true } : {}),
					};
				});
				const perGroup = Math.round(e.base * e.growth ** step * t.exp);
				return { name: t.name, groups, exp: groups.map(() => perGroup), loot: t.loot };
			});
		};
		const defs = new Map<string, RealmDef>();
		for (const r of REALMS) {
			const def: RealmDef = {
				id: r.id,
				name: r.name,
				quote: r.quote,
				order: r.order,
				locked: r.order > 1,
				tasks: (api) => tasksOf(api, r),
				taskCount: TASKS.get(r.id)?.length ?? 0,
			};
			defs.set(r.id, def);
			realms.define(def);
		}

		realms.addHeroStats(async (api, _hero, attrs) => {
			const out: Record<string, number> = {};
			for (const [stat, row] of Object.entries(heroStats.get(api)))
				out[stat] = Object.entries(row).reduce((sum, [k, f]) => sum + (k === 'base' ? f : (attrs[k] ?? 0) * f), 0);
			return out;
		});

		/* ----- drops ------------------------------------------------------------------------ */

		const itemLine = (id: string, count: number) => {
			const def = items.list().find((d) => d.id === id)!;
			return { kind: 'item', name: def.name, icon: def.icon, count };
		};
		for (const d of DROPS) {
			if (!items.list().some((i) => i.id === d.item)) throw new PluginError(`drops.csv: unknown item "${d.item}"`);
			const def = items.list().find((i) => i.id === d.item)!;
			items.addSource(d.item, 'realms');
			realms.addDrop({
				id: d.id,
				weight: d.weight,
				preview: { kind: 'item', name: def.name, ...(def.icon ? { icon: def.icon } : {}) },
				where: (realm) => realm.order >= d.from && realm.order <= d.to,
				async give(api, c) {
					await items.grant(api, c.playerId, d.item, d.count);
					return [itemLine(d.item, d.count)];
				},
			});
		}

		/* ----- keys --------------------------------------------------------------------------- */

		const next = (realm: RealmDef) => [...defs.values()].find((r) => r.order === realm.order + 1);
		realms.addClearReward({
			id: 'starter-realms.key',
			where: (realm, task) => task === (TASKS.get(realm.id)?.length ?? 0) - 1 && !!next(realm),
			preview: (realm) => ({ kind: 'item', name: items.list().find((d) => d.id === keyId(next(realm)!.id))!.name, icon: '🗝️' }),
			async give(api, c) {
				const to = next(c.realm)!;
				await items.grant(api, c.playerId, keyId(to.id), 1);
				return [itemLine(keyId(to.id), 1)];
			},
		});
		for (const realm of defs.values()) {
			if (!realm.locked) continue;
			items.define<{ action: 'unlock' | 'exchange'; settlement: string | null }>({
				id: keyId(realm.id),
				name: ctx.services.get('i18n').derive(`item:${keyId(realm.id)}`, text('Key to {0}', { 0: text(realm.name) })),
				icon: '🗝️',
				category: 'keys',
				description: ctx.services
					.get('i18n')
					.derive(
						`item-description:${keyId(realm.id)}`,
						text('Opens {0} for good or trades for a few resources.', { 0: text(realm.name) }),
					),
				use: {
					parse: shape({
						action: fields.oneOf(['unlock', 'exchange'] as const),
						settlement: fields.orElse<string | null>(fields.id(), null),
					}),
					async apply(api, { action, settlement }) {
						if (action === 'unlock') return realms.unlock(api, api.playerId, realm.id);
						if (!settlement) throw fail('bad_payload', 'Choose a settlement for the resources');
						const s = await settlements.requireOwned(api, settlement);
						const n = keyRule.get(api).perRealm * realm.order;
						for (const r of resources.list()) await resources.add(api, settlements.entity(s.id), r.id, n);
					},
					form: {
						title: text('Use a key to {0}', { 0: text(realm.name) }),
						fields: [
							{ name: 'settlement', label: text('settlement'), type: 'hidden' },
							{ name: 'action', label: text('Use it to'), type: 'select', required: true },
						],
						submitLabel: text('Use key'),
						async prepare(api, params) {
							const s = await settlements.resolve(api, params);
							const open = await realms.isUnlocked(api, api.playerId, realm.id);
							const n = keyRule.get(api).perRealm * realm.order;
							return {
								defaults: { settlement: s?.id ?? '', action: open ? 'exchange' : 'unlock' },
								options: {
									action: [
										...(open ? [] : [{ value: 'unlock', label: text('Open {0}', { 0: text(realm.name) }) }]),
										...(s ? [{ value: 'exchange', label: text('Trade for {0} of every resource', { 0: n }) }] : []),
									],
								},
							};
						},
					},
				},
			});
		}
	},
});
