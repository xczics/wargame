/**
 * Realms (docs/design/gameplay.md §9): places on the map heroes visit alone. An adventure is one
 * of a realm's tasks: monster groups fought in order with the shared "trading blows" rule
 * (src/shared/realms.ts) until the hero wins through or falls.
 *
 * The system knows none of the content: realms and their tasks, what heroes' attributes are worth
 * in a fight (`addHeroStats`), what can drop (`addDrop`, `addClearReward`) are registered by other
 * plugins. It owns the map sites, unlocking, the adventures themselves, injuries and the report.
 *
 * An adventure is decided when it starts (fights, which groups drop what) and paid out when it
 * ends, by a timeline event on the hero's home settlement (heroes on an adventure or injured
 * cannot move home). Rewards, injury and the report are committed together.
 */
import {
	csvRules,
	definePlugin,
	type EngineApi,
	executeCommand,
	fields,
	gameErrors,
	numberFields,
	PluginError,
	type ReadApi,
	seededRandom,
	shape,
} from '../../kernel';
import { requestContext } from '../../runtime/context';
import { amount, amounts, duration } from '../../shared/format';
import type { ReportData, RowsData, SyncData, TimersData, UiLine, UiText, UiTimer } from '../../shared/ui';
import type { AdventureInfo, InjuryInfo, RealmInfo, RealmMail, RealmsOverview, RealmTaskInfo, RewardLine } from '../../shared/api';
import { fightGroups, margin, type AdventureStats, type GroupOutcome, type MonsterGroup } from '../../shared/realms';
import type { Hero } from '../heroes';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { keyText, literal, uiTexts } from '../../shared/i18n';

const fail = gameErrors('realms');
const text = uiTexts('realms');

const RULES = csvRules(rulesCsv);
const ADVENTURE = 'realms.adventure';
const INJURED = 'realms.injured';
const DONE = 'realms.done';
const HEALED = 'realms.healed';

export interface RealmTask {
	name: string;
	groups: MonsterGroup[];
	/** Experience for beating each group (same length as `groups`). */
	exp: number[];
	/** What a beaten group drops is worth at least this much (the `loot` algorithm; x (1 + luck%)). */
	loot: number;
}

export interface RealmDef {
	id: string;
	name: string;
	quote?: string;
	/** Difficulty order (1 = easiest). */
	order: number;
	/** Needs unlocking (with a key) before heroes can go. */
	locked: boolean;
	/** The tasks under the current rules, easiest first. */
	tasks(api: ReadApi): RealmTask[];
	/** How many tasks it has (fixed: each has its own loot pool, made when the game boots). */
	taskCount: number;
}

/** Where a reward is being handed out. `random` is seeded by the adventure, so a retry gives the same. */
export interface RewardContext {
	playerId: string;
	hero: Hero;
	realm: RealmDef;
	/** Task index (0 = first). */
	task: number;
	random: () => number;
}

/** How a drop or reward looks in the list of possible drops (`name` is text to translate). */
export type RewardPreview = Omit<RewardLine, 'count' | 'lost'>;

/**
 * Each task of each realm has its own loot pool, "realms.<realm>.<task>" (the group "realms": GM weights for
 * all of them at once); what a drop is told about its occasion.
 */
const GROUP = 'realms';
const poolOf = (realm: string, task: number) => `${GROUP}.${realm}.${task}`;
type Occasion = { realm: RealmDef; task: number; hero?: Hero };

export interface DropDef {
	id: string;
	/** Relative weight in the pool; may depend on the realm, task and rules (0 = not there). */
	weight: number | ((realm: RealmDef, task: number, api: ReadApi) => number);
	/** What it is worth towards a group's loot (the `loot` plugin); default: from its weight (the rarer, the more). */
	value?: number;
	/** What players see in the list of possible drops. */
	preview: RewardPreview;
	/** Which realms / tasks it can drop in (default: all). */
	where?(realm: RealmDef, task: number): boolean;
	/** Hand it out; the lines go into the report. */
	give(api: EngineApi, ctx: RewardContext): Promise<RewardLine[]>;
}

export interface ClearReward {
	id: string;
	/** What players see in the list of rewards for clearing (may depend on the realm). */
	preview(realm: RealmDef, task: number): RewardPreview;
	where?(realm: RealmDef, task: number): boolean;
	give(api: EngineApi, ctx: RewardContext): Promise<RewardLine[]>;
}

/** Adventure numbers a plugin adds to a hero (summed over all sources). Must only read. */
export type HeroStatsSource = (api: ReadApi, hero: Hero, attrs: Record<string, number>) => Promise<Partial<AdventureStats>>;

export interface RealmsService {
	define(def: RealmDef): void;
	list(): readonly RealmDef[];
	get(id: string): RealmDef;
	addHeroStats(source: HeroStatsSource): void;
	heroStats(api: ReadApi, hero: Hero): Promise<AdventureStats>;
	addDrop(def: DropDef): void;
	addClearReward(def: ClearReward): void;
	isUnlocked(api: ReadApi, playerId: string, realmId: string): Promise<boolean>;
	/** Open a locked realm for a player; throws if it is not locked or open already. */
	unlock(api: EngineApi, playerId: string, realmId: string): Promise<void>;
	/** Whether a hero is injured (being treated or not). */
	isInjured(api: ReadApi, heroId: string): Promise<boolean>;
	/** Injure a hero (e.g. leading a routed army): as after a lost adventure, it needs treatment. No-op if injured already. */
	injure(api: EngineApi, hero: Hero): Promise<void>;
	/** Heal an injured hero at once (e.g. a salve); throws if it is not injured. */
	healNow(api: EngineApi, heroId: string): Promise<void>;
	/**
	 * Take `seconds` off a hero's adventure (or, when injured and being treated, its treatment);
	 * at 0 it ends now, report and all. False if the hero has neither under way.
	 */
	speedUp(api: EngineApi, heroId: string, seconds: number): Promise<boolean>;
}

declare module '../../kernel' {
	interface ServiceMap {
		realms: RealmsService;
	}
}

/** What is decided when an adventure starts. */
interface Result {
	stats: AdventureStats;
	groups: MonsterGroup[];
	exp: number[];
	outcomes: GroupOutcome[];
	/** Drop ids by group index (beaten groups only); a single id in adventures started before multiple drops. */
	drops: Record<number, string[] | string>;
	cleared: boolean;
	taskName: string;
}
interface AdventureRow {
	id: string;
	player_id: string;
	hero_id: string;
	realm: string;
	task: number;
	started_at: number;
	finishes_at: number;
	result: string;
}
interface InjuryRow {
	hero_id: string;
	player_id: string;
	healing_until: number | null;
}

export default definePlugin({
	id: 'realms',
	version: '0.1.0',
	description: 'Realms: hero adventures against monster groups, rewards, keys, injuries',
	dependsOn: ['heroes', 'settlements', 'resources', 'stats', 'timeline', 'world-map', 'mail', 'loot', 'ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const heroes = ctx.services.get('heroes');
		const settlements = ctx.services.get('settlements');
		const resources = ctx.services.get('resources');
		const stats = ctx.services.get('stats');
		const timeline = ctx.services.get('timeline');
		const map = ctx.services.get('worldMap');
		const mail = ctx.services.get('mail');
		const realms = new Map<string, RealmDef>();
		const statSources: HeroStatsSource[] = [];
		const clearRewards = new Map<string, ClearReward>();
		// What beaten groups can drop (`addDrop`), sorted into each task's pool once every realm and drop is known.
		const dropDefs: DropDef[] = [];
		ctx.onReady(() => {
			const loot = ctx.services.get('loot');
			for (const realm of realms.values())
				for (let task = 0; task < realm.taskCount; task++) {
					const pool = poolOf(realm.id, task);
					loot.definePool(pool);
					for (const def of dropDefs) {
						if (def.where && !def.where(realm, task)) continue;
						const weight = def.weight;
						loot.addDrop<Occasion>(pool, {
							id: def.id,
							weight: typeof weight === 'function' ? (_c, api) => weight(realm, task, api) : weight,
							...(def.value !== undefined ? { value: def.value } : {}),
							preview: def.preview,
							give: (api, c) => def.give(api, { playerId: c.playerId, hero: c.hero!, realm, task, random: c.random }),
						});
					}
				}
		});

		const rules = ctx.config.define('rules', {
			description:
				'groupSeconds per monster group fought; minDamage: least share of attack a blow does; miss: chance (0-1) each blow misses; outlook.easy / even / hard: margins for the four expected outcomes (above easy: an easy win; above even: worth a try; above hard: an uphill fight; below: a heavy loss); sitesPerRealm map tiles per realm; heal.* treatment time and cost per hero level.',
			default: () => RULES as Record<string, unknown>,
			parse(raw) {
				const top = numberFields(() => ({
					groupSeconds: RULES.groupSeconds as number,
					minDamage: RULES.minDamage as number,
					miss: RULES.miss as number,
					sitesPerRealm: RULES.sitesPerRealm as number,
				}))(Object.fromEntries(Object.entries((raw ?? {}) as Record<string, unknown>).filter(([k]) => k !== 'heal' && k !== 'outlook')));
				const outlook = numberFields(
					() => RULES.outlook as Record<string, number>,
					0,
					100,
				)((raw as { outlook?: unknown } | null)?.outlook ?? {});
				const heal = numberFields(() => RULES.heal as Record<string, number>)((raw as { heal?: unknown } | null)?.heal ?? {});
				if (top.minDamage > 1) throw fail('bad_config', 'minDamage is a share (0-1)');
				if (top.miss >= 1) throw fail('bad_config', 'miss is a chance (0-1)');
				return { ...top, heal, outlook };
			},
		});
		const rule = (api: ReadApi) =>
			rules.get(api) as {
				groupSeconds: number;
				minDamage: number;
				miss: number;
				sitesPerRealm: number;
				outlook: { easy: number; even: number; hard: number };
				heal: Record<string, number>;
			};
		stats.define({ id: 'realms.recovery', description: 'adventure recovery (% points)', base: () => 0 });

		heroes.defineDuty({ id: ADVENTURE, name: 'On an adventure', inTown: false, manual: false, anywhere: true });
		heroes.defineDuty({ id: INJURED, name: 'Injured', inTown: false, manual: false, anywhere: true });

		/* ----- data ---------------------------------------------------------------------- */

		const loadAdventures = (api: ReadApi, playerId: string) =>
			api.memo(`realms:adventures:${playerId}`, async () => {
				const { results } = await api.db
					.prepare('SELECT * FROM realms_adventures WHERE player_id = ? ORDER BY finishes_at')
					.bind(playerId)
					.all<AdventureRow>();
				return results;
			});
		const loadInjuries = (api: ReadApi, playerId: string) =>
			api.memo(`realms:injuries:${playerId}`, async () => {
				const { results } = await api.db.prepare('SELECT * FROM realms_injuries WHERE player_id = ?').bind(playerId).all<InjuryRow>();
				return results;
			});
		/** The hero needs treatment before it can go out again (adventures, armies). */
		async function injure(api: EngineApi, hero: Hero) {
			const list = await loadInjuries(api, hero.playerId);
			if (list.some((i) => i.hero_id === hero.id)) return;
			list.push({ hero_id: hero.id, player_id: hero.playerId, healing_until: null });
			api.write(
				api.db.prepare('INSERT INTO realms_injuries (hero_id, player_id, healing_until) VALUES (?, ?, NULL)').bind(hero.id, hero.playerId),
			);
			await heroes.assign(api, hero.id, INJURED, null);
		}
		const loadUnlocked = (api: ReadApi, playerId: string) =>
			api.memo(`realms:unlocked:${playerId}`, async () => {
				const { results } = await api.db
					.prepare('SELECT realm FROM realms_unlocked WHERE player_id = ?')
					.bind(playerId)
					.all<{ realm: string }>();
				return new Set(results.map((r) => r.realm));
			});
		const loadSites = (api: ReadApi) =>
			api.memo('realms:sites', async () => {
				const { results } = await api.db.prepare('SELECT * FROM realms_sites').all<{ id: string; realm: string; x: number; y: number }>();
				return results;
			});
		/** The injury row of one of the player's heroes. */
		const injury = async (api: ReadApi, playerId: string, heroId: string) =>
			(await loadInjuries(api, playerId)).find((r) => r.hero_id === heroId);
		const ownerOfHero = async (api: ReadApi, heroId: string) => (await heroes.get(api, heroId))?.playerId ?? null;

		const service: RealmsService = {
			injure: (api, hero) => injure(api, hero),
			define(def) {
				if (realms.has(def.id)) throw new PluginError(`Realm "${def.id}" defined twice`);
				// Names are i18n keys of the plugin defining the realm (tasks and monsters come later, from its tables).
				const own = ctx.services.get('i18n').scope();
				const tasks = def.tasks;
				realms.set(def.id, {
					...def,
					name: own(def.name),
					...(def.quote ? { quote: own(def.quote) } : {}),
					tasks: (api) => tasks(api).map((t) => ({ ...t, name: own(t.name), groups: t.groups.map((g) => ({ ...g, name: own(g.name) })) })),
				});
			},
			list: () => [...realms.values()].sort((a, b) => a.order - b.order),
			get(id) {
				const r = realms.get(id);
				if (!r) throw fail('bad_payload', text('Unknown realm "{0}"', { 0: id }));
				return r;
			},
			addHeroStats: (s) => void statSources.push(s),
			async heroStats(api, hero) {
				const attrs = await heroes.attributesOf(api, hero);
				const out: Required<AdventureStats> = { attack: 0, defense: 0, hp: 0, recovery: 0, luck: 0 };
				for (const s of statSources)
					for (const [k, v] of Object.entries(await s(api, hero, attrs))) if (k in out) out[k as keyof AdventureStats] += v ?? 0;
				out.recovery += await stats.get(api, 'realms.recovery', `player:${hero.playerId}`);
				return {
					attack: Math.max(0, out.attack),
					defense: Math.max(0, out.defense),
					hp: Math.max(1, out.hp),
					recovery: Math.max(0, out.recovery),
					luck: Math.max(0, out.luck),
				};
			},
			// Into the pools of the tasks it fits (made when every plugin is set up). Its names are the adding
			// plugin's keys: made full now, while its setup runs.
			addDrop(def) {
				if (dropDefs.some((d) => d.id === def.id)) throw new PluginError(`Realm drop "${def.id}" added twice`);
				const own = ctx.services.get('i18n').scope();
				dropDefs.push({
					...def,
					preview: { ...def.preview, name: own(def.preview.name) },
					give: async (api, c) => (await def.give(api, c)).map((l) => ({ ...l, name: own(l.name) })),
				});
			},
			addClearReward(def) {
				if (clearRewards.has(def.id)) throw new PluginError(`Realm clear reward "${def.id}" defined twice`);
				const own = ctx.services.get('i18n').scope();
				clearRewards.set(def.id, {
					...def,
					preview: (realm, task) => {
						const p = def.preview(realm, task);
						return { ...p, name: own(p.name) };
					},
					give: async (api, c) => (await def.give(api, c)).map((l) => ({ ...l, name: own(l.name) })),
				});
			},
			async isUnlocked(api, playerId, realmId) {
				return !service.get(realmId).locked || (await loadUnlocked(api, playerId)).has(realmId);
			},
			async unlock(api, playerId, realmId) {
				if (await service.isUnlocked(api, playerId, realmId)) throw fail('blocked', 'That realm is open already');
				(await loadUnlocked(api, playerId)).add(realmId);
				api.write(api.db.prepare('INSERT INTO realms_unlocked (player_id, realm) VALUES (?, ?)').bind(playerId, realmId));
			},
			async isInjured(api, heroId) {
				const owner = await ownerOfHero(api, heroId);
				return !!owner && !!(await injury(api, owner, heroId));
			},
			async healNow(api, heroId) {
				const hero = await heroes.get(api, heroId);
				const row = hero && (await injury(api, hero.playerId, heroId));
				if (!hero || !row) throw fail('blocked', 'That hero is not injured');
				if (row.healing_until !== null) timeline.cancelWhere(api, settlements.entity(hero.home), HEALED, { hero: heroId });
				await recover(api, hero);
			},
			speedUp: async () => false, // set below, once the loaders it needs exist
		};
		service.speedUp = async (api, heroId, seconds) => {
			const hero = await heroes.get(api, heroId);
			if (!hero) return false;
			const home = settlements.entity(hero.home);
			await timeline.sync(api, home); // what is due first
			const adventure = (await loadAdventures(api, hero.playerId)).find((a) => a.hero_id === hero.id);
			if (adventure) {
				adventure.finishes_at = Math.max(api.now, adventure.finishes_at - seconds * 1000);
				api.write(api.db.prepare('UPDATE realms_adventures SET finishes_at = ? WHERE id = ?').bind(adventure.finishes_at, adventure.id));
				timeline.cancelWhere(api, home, DONE, { adventure: adventure.id });
				timeline.schedule(api, home, adventure.finishes_at, DONE, { adventure: adventure.id, hero: hero.id });
			} else {
				const row = await injury(api, hero.playerId, hero.id);
				if (row?.healing_until == null) return false;
				row.healing_until = Math.max(api.now, row.healing_until - seconds * 1000);
				api.write(api.db.prepare('UPDATE realms_injuries SET healing_until = ? WHERE hero_id = ?').bind(row.healing_until, hero.id));
				timeline.cancelWhere(api, home, HEALED, { hero: hero.id });
				timeline.schedule(api, home, row.healing_until, HEALED, { hero: hero.id });
			}
			await timeline.sync(api, home);
			return true;
		};
		ctx.services.provide('realms', service);

		async function recover(api: EngineApi, hero: Hero) {
			const list = await loadInjuries(api, hero.playerId);
			const i = list.findIndex((r) => r.hero_id === hero.id);
			if (i >= 0) list.splice(i, 1);
			api.write(api.db.prepare('DELETE FROM realms_injuries WHERE hero_id = ?').bind(hero.id));
			await heroes.assign(api, hero.id, 'idle', null);
		}

		const healQuote = (api: ReadApi, level: number) => {
			const h = rule(api).heal;
			return {
				cost: Object.fromEntries(
					Object.entries({ food: h.food * level, gold: h.gold * level }).filter(
						([r, n]) => n > 0 && resources.list().some((d) => d.id === r),
					),
				),
				seconds: Math.ceil(h.seconds + h.secondsPerLevel * level),
			};
		};

		/* ----- adventures ----------------------------------------------------------------- */

		const loot = ctx.services.get('loot');
		/** Possible drops grouped by how often they fall, for a task the player has cleared. */
		const dropList = (api: ReadApi, realm: RealmDef, task: number): RealmTaskInfo['drops'] => {
			const clear = [...clearRewards.values()].filter((r) => !r.where || r.where(realm, task)).map((r) => r.preview(realm, task));
			const pool = poolOf(realm.id, task);
			const drops = loot.has(pool) ? loot.preview<Occasion>(api, pool, { realm, task }) : { common: [], uncommon: [], rare: [] };
			return { ...drops, clear };
		};
		const loadCleared = (api: ReadApi, playerId: string) =>
			api.memo(`realms:cleared:${playerId}`, async () => {
				const { results } = await api.db
					.prepare('SELECT realm, task FROM realms_cleared WHERE player_id = ?')
					.bind(playerId)
					.all<{ realm: string; task: number }>();
				return new Set(results.map((r) => `${r.realm}:${r.task}`));
			});

		/** What a beaten group drops: drawn from the task's pool until worth its `loot` x (1 + luck%). */
		const rollDrops = (api: ReadApi, realm: RealmDef, task: RealmTask, index: number, luck: number, random: () => number) =>
			loot.has(poolOf(realm.id, index))
				? loot.roll<Occasion>(api, poolOf(realm.id, index), { realm, task: index }, task.loot * (1 + Math.max(0, luck) / 100), random)
				: [];

		ctx.commands.add<{ hero: string; realm: string; task: number }>({
			type: 'realms.adventure',
			description: 'Send a hero on an adventure. Payload: { "hero", "realm", "task": 0-4 }',
			// On the map, when a realm's site is selected (the Realms page has its own controls).
			form: {
				title: text('Send a hero on an adventure'),
				placement: 'tile',
				fields: [
					{ name: 'realm', label: text('realm'), type: 'hidden' },
					{ name: 'hero', label: text('Hero'), type: 'select', required: true },
					{ name: 'task', label: text('Task'), type: 'select', required: true },
				],
				submitLabel: text('Set out'),
				async prepare(api, params) {
					const x = Number(params.x);
					const y = Number(params.y);
					const site = (await loadSites(api)).find((s) => s.x === x && s.y === y);
					const realm = site && realms.get(site.realm);
					if (!realm) return false;
					const open = await service.isUnlocked(api, api.playerId, realm.id);
					const idle = (await heroes.list(api, api.playerId)).filter((h) => h.duty === 'idle');
					return {
						...(open
							? realm.quote
								? { description: keyText(realm.quote) }
								: {}
							: { description: text('Locked: open it with its key (from the hardest task of the realm before).') }),
						defaults: { realm: realm.id, task: '0' },
						options: {
							hero: open ? idle.map((h) => ({ value: h.id, label: text('{0} (Lv {1})', { 0: heroes.nameKey(h), 1: h.level }) })) : [],
							task: realm.tasks(api).map((t, i) => ({ value: String(i), label: keyText(t.name) })),
						},
					};
				},
			},
			parse: shape({ hero: fields.id(), realm: fields.id(), task: fields.int(0, 100) }),
			async execute(api, { hero: heroId, realm: realmId, task }) {
				const hero = await heroes.requireOwned(api, api.playerId, heroId);
				if (hero.duty !== 'idle') throw fail('blocked', 'Only idle heroes can go on an adventure');
				const realm = service.get(realmId);
				if (!(await service.isUnlocked(api, api.playerId, realm.id))) throw fail('blocked', 'That realm is locked');
				const t = realm.tasks(api)[task];
				if (!t) throw fail('bad_payload', 'No such task');
				const stats = await service.heroStats(api, hero);
				const { minDamage, groupSeconds, miss } = rule(api);
				const random = seededRandom(`${hero.id}:${api.now}:${crypto.randomUUID()}`);
				// Decided at departure, misses and all: a close fight can go either way.
				const outcomes = fightGroups(stats, t.groups, minDamage, { miss, random });
				const dropped: Record<number, string[]> = {};
				outcomes.forEach((o, i) => {
					const d = o.won ? rollDrops(api, realm, t, task, stats.luck ?? 0, random) : [];
					if (d.length) dropped[i] = d;
				});
				const result: Result = {
					stats,
					groups: t.groups,
					exp: t.exp,
					outcomes,
					drops: dropped,
					cleared: outcomes.length === t.groups.length && outcomes.every((o) => o.won),
					taskName: t.name,
				};
				const row: AdventureRow = {
					id: crypto.randomUUID(),
					player_id: api.playerId,
					hero_id: hero.id,
					realm: realm.id,
					task,
					started_at: api.now,
					finishes_at: api.now + Math.max(1, outcomes.length) * groupSeconds * 1000,
					result: JSON.stringify(result),
				};
				(await loadAdventures(api, api.playerId)).push(row);
				api.write(
					api.db
						.prepare(
							'INSERT INTO realms_adventures (id, player_id, hero_id, realm, task, started_at, finishes_at, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
						)
						.bind(row.id, row.player_id, row.hero_id, row.realm, row.task, row.started_at, row.finishes_at, row.result),
				);
				await heroes.assign(api, hero.id, ADVENTURE, row.id);
				timeline.schedule(api, settlements.entity(hero.home), row.finishes_at, DONE, { adventure: row.id, hero: hero.id });
			},
		});

		timeline.on<{ adventure: string; hero: string }>(DONE, async (api, event) => {
			const hero = await heroes.get(api, event.payload.hero);
			if (!hero) return;
			const list = await loadAdventures(api, hero.playerId);
			const i = list.findIndex((r) => r.id === event.payload.adventure);
			if (i < 0) return;
			const [row] = list.splice(i, 1);
			api.write(api.db.prepare('DELETE FROM realms_adventures WHERE id = ?').bind(row.id));
			const result = JSON.parse(row.result) as Result;
			const realm = realms.get(row.realm);
			const random = seededRandom(`realm:${row.id}`);
			const groups: RealmMail['groups'] = [];
			let exp = 0;
			for (const [idx, o] of result.outcomes.entries()) {
				const rewards: RewardLine[] = [];
				if (o.won) {
					exp += result.exp[idx] ?? 0;
					const ids = result.drops[idx];
					if (realm && loot.has(poolOf(realm.id, row.task)))
						rewards.push(
							...(await loot.give<Occasion>(api, poolOf(realm.id, row.task), Array.isArray(ids) ? ids : ids ? [ids] : [], {
								playerId: hero.playerId,
								hero,
								realm,
								task: row.task,
								random,
							})),
						);
				}
				groups.push({ ...result.groups[idx], ...o, rewards });
			}
			const clear: RewardLine[] = [];
			if (result.cleared && realm)
				for (const r of clearRewards.values())
					if (!r.where || r.where(realm, row.task))
						clear.push(...(await r.give(api, { playerId: hero.playerId, hero, realm, task: row.task, random })));
			if (result.cleared) {
				(await loadCleared(api, hero.playerId)).add(`${row.realm}:${row.task}`);
				api.write(
					api.db
						.prepare('INSERT OR IGNORE INTO realms_cleared (player_id, realm, task) VALUES (?, ?, ?)')
						.bind(hero.playerId, row.realm, row.task),
				);
			}
			const levels = await heroes.grantExp(api, hero.id, exp);
			const lost = !result.outcomes.every((o) => o.won);
			if (lost) await injure(api, hero);
			else await heroes.assign(api, hero.id, 'idle', null);
			const report: RealmMail = {
				realm: row.realm,
				realmName: realm?.name ?? row.realm,
				task: row.task,
				taskName: result.taskName,
				hero: { id: hero.id, surname: hero.surname, given: hero.given },
				stats: result.stats,
				groups,
				exp,
				levels,
				cleared: result.cleared,
				clearRewards: clear,
				injured: lost,
			};
			mail.send(api, hero.playerId, {
				kind: 'realms.report',
				title: text(result.cleared ? 'Adventure in {realm}: cleared' : lost ? 'Adventure in {realm}: defeated' : 'Adventure in {realm}', {
					realm: keyText(report.realmName),
				}),
				data: report,
				at: event.dueAt,
			});
		});

		/* ----- injuries --------------------------------------------------------------------- */

		ctx.commands.add<{ hero: string }>({
			type: 'realms.heal',
			description: 'Start treating an injured hero (paid by its settlement). Payload: { "hero" }',
			parse: shape({ hero: fields.id() }),
			async execute(api, { hero: heroId }) {
				const hero = await heroes.requireOwned(api, api.playerId, heroId);
				const row = await injury(api, api.playerId, hero.id);
				if (!row) throw fail('blocked', 'That hero is not injured');
				if (row.healing_until !== null) throw fail('busy', 'Already being treated');
				const { cost, seconds } = healQuote(api, hero.level);
				await resources.spend(api, settlements.entity(hero.home), cost);
				row.healing_until = api.now + seconds * 1000;
				api.write(api.db.prepare('UPDATE realms_injuries SET healing_until = ? WHERE hero_id = ?').bind(row.healing_until, hero.id));
				timeline.schedule(api, settlements.entity(hero.home), row.healing_until, HEALED, { hero: hero.id });
			},
		});
		timeline.on<{ hero: string }>(HEALED, async (api, event) => {
			const hero = await heroes.get(api, event.payload.hero);
			if (hero && (await injury(api, hero.playerId, hero.id))) await recover(api, hero);
		});

		ctx.commands.add<{ hero: string; seconds: number }>({
			type: 'realms.hasten',
			privileged: true,
			description: 'Shorten a hero\'s adventure (or treatment) by `seconds`; 0 = end it now. Payload: { "hero", "seconds": 600 }',
			form: {
				title: text('Speed up an adventure or treatment'),
				placement: 'gm',
				fields: [
					{ name: 'hero', label: text('Hero'), type: 'select', required: true },
					{ name: 'minutes', label: text('Minutes to skip (0 = end now)'), type: 'number', min: 0, default: 0 },
				],
				submitLabel: text('Speed up'),
				async prepare(api) {
					const mine = await heroes.list(api, api.playerId);
					const options: { value: string; label: UiText }[] = [];
					for (const a of await loadAdventures(api, api.playerId)) {
						const h = mine.find((x) => x.id === a.hero_id);
						if (h && a.finishes_at > api.now)
							options.push({
								value: h.id,
								label: text('{0} · {1} · {2} min', {
									0: heroes.nameKey(h),
									1: keyText(realms.get(a.realm)?.name ?? a.realm),
									2: Math.ceil((a.finishes_at - api.now) / 60_000),
								}),
							});
					}
					for (const i of await loadInjuries(api, api.playerId)) {
						const h = mine.find((x) => x.id === i.hero_id);
						if (h && i.healing_until && i.healing_until > api.now)
							options.push({
								value: h.id,
								label: text('{0} · treatment · {1} min', { 0: heroes.nameKey(h), 1: Math.ceil((i.healing_until - api.now) / 60_000) }),
							});
					}
					return options.length ? { options: { hero: options } } : false;
				},
			},
			// Seconds through the API, minutes from the GM form; 0 = end it now.
			parse: shape(
				{ hero: fields.id(), seconds: fields.optional(fields.number(0, 1e9)), minutes: fields.optional(fields.number(0, 1e7)) },
				(p) => ({ hero: p.hero, seconds: (p.seconds ?? (p.minutes ?? 0) * 60) || 1e9 }),
			),
			async execute(api, { hero, seconds }) {
				await heroes.requireOwned(api, api.playerId, hero);
				if (!(await service.speedUp(api, hero, seconds))) throw fail('blocked', 'That hero is neither adventuring nor being treated');
			},
		});

		// Commit adventures and treatments that are due (the client calls this when one ends).
		ctx.commands.add<null>({
			type: 'realms.sync',
			description: 'Finish your due adventures and treatments now.',
			parse: () => null,
			async execute(api) {
				const homes = new Set<string>();
				const mine = await heroes.list(api, api.playerId);
				for (const a of await loadAdventures(api, api.playerId)) {
					const h = mine.find((x) => x.id === a.hero_id);
					if (h) homes.add(h.home);
				}
				for (const i of await loadInjuries(api, api.playerId)) {
					const h = mine.find((x) => x.id === i.hero_id);
					if (h && i.healing_until !== null) homes.add(h.home);
				}
				for (const home of homes) await timeline.sync(api, settlements.entity(home));
			},
		});

		/* ----- the map ------------------------------------------------------------------------ */

		map.addMarkers('realm', async (api, ids) => {
			const sites = await loadSites(api);
			const out = new Map<string, { kind: string; icon: string; name: string; data: Record<string, string> }>();
			for (const id of ids) {
				const s = sites.find((x) => x.id === id);
				const r = s && realms.get(s.realm);
				if (s && r) out.set(id, { kind: 'realms.site', icon: '⛩️', name: r.name, data: { realm: r.id } });
			}
			return out;
		});

		ctx.commands.add<{ count: number }>({
			type: 'realms.spawnSites',
			privileged: true,
			description:
				'Place missing realm sites on random free tiles (up to sitesPerRealm each; at most `count` now). Payload: { "count": 10 }',
			form: {
				title: text('Place realm sites'),
				placement: 'gm',
				fields: [{ name: 'count', label: text('At most'), type: 'number', required: true, min: 1, max: 100, default: 30 }],
				submitLabel: text('Place'),
			},
			parse: shape({ count: fields.orElse(fields.int(1, 100), 10) }),
			async execute(api, { count }) {
				const sites = await loadSites(api);
				let budget = count;
				for (const realm of service.list()) {
					let missing = rule(api).sitesPerRealm - sites.filter((s) => s.realm === realm.id).length;
					while (missing-- > 0 && budget-- > 0) {
						const tile = await map.findFreeSquare(api, 0);
						if (!tile) throw fail('map_full', 'Could not find free land', 503);
						const id = crypto.randomUUID();
						await map.claim(api, [tile], `realm:${id}`);
						sites.push({ id, realm: realm.id, ...tile });
						api.write(api.db.prepare('INSERT INTO realms_sites (id, realm, x, y) VALUES (?, ?, ?, ?)').bind(id, realm.id, tile.x, tile.y));
					}
				}
			},
		});
		ctx.tasks.add({
			id: 'realms.sites',
			async run({ kernel, env }) {
				const context = await requestContext(kernel, env, 'npc:world', true);
				const want = rule(context as unknown as ReadApi).sitesPerRealm * realms.size;
				const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM realms_sites').first<{ n: number }>();
				if ((row?.n ?? 0) < want) await executeCommand(kernel, env.DB, context, 'realms.spawnSites', { count: 5 });
			},
		});

		/* ----- view ----------------------------------------------------------------------------- */

		async function overviewOf(api: EngineApi): Promise<RealmsOverview> {
			{
				const mine = await heroes.list(api, api.playerId);
				// Due adventures and treatments are applied first (written only by commands).
				for (const home of new Set(mine.map((h) => h.home))) await timeline.sync(api, settlements.entity(home));
				const sites = await loadSites(api);
				const cleared = await loadCleared(api, api.playerId);
				const out: RealmInfo[] = [];
				for (const r of service.list())
					out.push({
						id: r.id,
						name: r.name,
						...(r.quote ? { quote: r.quote } : {}),
						order: r.order,
						unlocked: await service.isUnlocked(api, api.playerId, r.id),
						sites: sites.filter((s) => s.realm === r.id).map(({ x, y }) => ({ x, y })),
						tasks: r.tasks(api).map((t, index) => ({
							index,
							name: t.name,
							groups: t.groups,
							exp: t.exp,
							loot: t.loot,
							cleared: cleared.has(`${r.id}:${index}`),
							// Only once cleared: the possible drops, by how often they fall (whatever plugins added to the pool).
							...(cleared.has(`${r.id}:${index}`) ? { drops: dropList(api, r, index) } : {}),
						})),
					});
				const adventures: AdventureInfo[] = (await loadAdventures(api, api.playerId)).map((a) => ({
					id: a.id,
					hero: a.hero_id,
					realm: a.realm,
					task: a.task,
					startedAt: a.started_at,
					finishesAt: a.finishes_at,
				}));
				const injured: InjuryInfo[] = [];
				for (const i of await loadInjuries(api, api.playerId)) {
					const h = mine.find((x) => x.id === i.hero_id);
					if (h) injured.push({ hero: h.id, healingUntil: i.healing_until, ...healQuote(api, h.level) });
				}
				const heroStats: RealmsOverview['heroStats'] = {};
				for (const h of mine) heroStats[h.id] = await service.heroStats(api, h);
				const { groupSeconds, minDamage } = rule(api);
				return { realms: out, adventures, injured, heroStats, groupSeconds, minDamage, outlook: rule(api).outlook };
			}
		}
		const overview = (api: EngineApi) => api.memo('realms:overview', () => overviewOf(api));
		ctx.views.add({ id: 'realms.overview', compute: (api) => overview(api) });

		// The Realms page's left column with the generic timers widget: heroes away, then the injured.
		const heroName = async (api: ReadApi, id: string) => {
			const h = await heroes.get(api, id);
			// Name-part keys: the client spells them.
			return h ? heroes.nameKey(h) : id;
		};
		// The Realms page's list (generic `ui.rows`): pick an idle hero (client param `hero`), see each open
		// realm's tasks — monsters, experience, what drops — how far that hero would get, and send it.
		ctx.views.add({
			id: 'realms.list',
			async compute(api, params): Promise<RowsData> {
				const o = await overviewOf(api);
				const idle = (await heroes.list(api, api.playerId)).filter((h) => h.duty === 'idle');
				const hero = idle.find((h) => h.id === params.hero) ?? idle[0];
				const stats = hero ? o.heroStats[hero.id] : undefined;
				const preview = (r: Omit<RewardLine, 'count' | 'lost'>) => ({
					text: text('{0}{1}', { 0: r.icon ?? '', 1: keyText(r.name) }),
					...(r.rarity ? { rarity: r.rarity } : {}),
				});
				// A button per realm; the newest open one by default (the shop on the left follows the choice).
				const latest = [...o.realms].reverse().find((r) => r.unlocked) ?? o.realms[0];
				return {
					title: text('Realms'),
					tabs: o.realms.map((r) => ({
						id: r.id,
						label: text(r.unlocked ? '{0}. {1}' : '{0}. {1} 🔒', { 0: r.order, 1: keyText(r.name) }),
					})),
					...(latest ? { defaultTab: latest.id } : {}),
					...(hero
						? {
								picker: {
									param: 'hero',
									options: idle.map((h) => ({
										value: h.id,
										label: text('{0} (Lv {1})', { 0: heroes.nameKey(h), 1: h.level }),
									})),
									selected: hero.id,
								},
							}
						: {}),
					sections: [
						{
							rows: [],
							lines: stats
								? [
										{
											text: text(
												stats.luck
													? 'Attack {a} · Defence {d} · HP {h} · Recovery {r}% · Luck +{l}%'
													: 'Attack {a} · Defence {d} · HP {h} · Recovery {r}%',
												{
													a: amount(stats.attack),
													d: amount(stats.defense),
													h: amount(stats.hp),
													r: amount(stats.recovery, 1),
													l: amount(stats.luck ?? 0, 1),
												},
											),
											tone: 'muted',
										},
									]
								: [{ text: text('No idle hero.'), tone: 'muted' }],
						},
						...o.realms.map((r): RowsData['sections'][number] => ({
							group: r.id,
							title: r.unlocked
								? text('{0}. {1}', { 0: r.order, 1: keyText(r.name) })
								: text('{0}. {1} · 🔒 {2}', { 0: r.order, 1: keyText(r.name), 2: text('Locked') }),
							intro: [
								...(r.sites.length
									? [
											{
												text: text('On the map: {places}', { places: r.sites.map((s) => text('({0}, {1})', { 0: s.x, 1: s.y })) }),
												tone: 'muted' as const,
											},
										]
									: []),
								...(r.quote ? [{ text: keyText(r.quote), tone: 'muted' as const }] : []),
								...(r.unlocked
									? []
									: [{ text: text('Open it with its key, dropped by the hardest task of the realm before.'), tone: 'muted' as const }]),
							],
							rows: r.unlocked
								? r.tasks.map((t) => {
										const k = stats ? margin(stats, t.groups, o.minDamage) : null;
										// About how many things a beaten group drops, and how often none, without luck.
										const pool = poolOf(r.id, t.index);
										const { mean, nothing } = loot.has(pool)
											? loot.meanDrops<Occasion>(
													api,
													pool,
													{ realm: service.get(r.id), task: t.index },
													t.loot,
													seededRandom(`${r.id}:${t.index}`),
												)
											: { mean: 0, nothing: 1 };
										return {
											id: `${r.id}/${t.index}`,
											title: text('{0}. {1}', { 0: t.index + 1, 1: keyText(t.name) }),
											lines: [
												{
													text: text(
														'{0} groups · strongest {1} / {2} / {3} · exp {4} · loot worth {5} · about {6} drops a group, none {7}',
														{
															0: t.groups.length,
															1: amount(Math.max(...t.groups.map((g) => g.attack))),
															2: amount(Math.max(...t.groups.map((g) => g.defense))),
															3: amount(Math.max(...t.groups.map((g) => g.hp))),
															4: amount(t.exp.reduce((a, b) => a + b, 0)),
															5: amount(t.loot, 1),
															6: amount(mean, 1),
															7: `${Math.round(nothing * 100)}%`,
														},
													),
												},
												...(t.drops
													? (['common', 'uncommon', 'rare', 'clear'] as const)
															.filter((g) => t.drops![g].length)
															.map((g): UiLine => ({ text: text(`drops:${g}`), tone: 'muted', parts: t.drops![g].map(preview) }))
													: [{ text: text('Clear it once to see what it can drop.'), tone: 'muted' as const }]),
												...(k !== null
													? [
															{
																// Four rough outlooks, not the exact group: strikes may miss.
																text:
																	k >= o.outlook.easy
																		? text('Outlook: an easy win')
																		: k >= o.outlook.even
																			? text('Outlook: worth a try')
																			: k >= o.outlook.hard
																				? text('Outlook: an uphill fight')
																				: text('Outlook: a heavy loss'),
																tone: k >= o.outlook.even ? ('info' as const) : ('warn' as const),
															},
														]
													: []),
											],
											actions: [
												{
													command: 'realms.adventure',
													payload: { hero: hero?.id, realm: r.id, task: t.index },
													label: text('Set out'),
													...(hero ? {} : { blocked: text('No idle hero.') }),
												},
											],
										};
									})
								: [],
						})),
					],
				};
			},
		});

		ctx.views.add({
			id: 'realms.away',
			async compute(api): Promise<TimersData> {
				const o = await overview(api);
				const realm = (id: string) => o.realms.find((r) => r.id === id);
				return {
					title: text('On adventures'),
					items: await Promise.all(
						o.adventures.map(async (a): Promise<UiTimer> => ({
							id: a.id,
							title: text('{hero}', { hero: await heroName(api, a.hero) }),
							lines: [
								{
									text: text('{realm} · {task}', {
										realm: keyText(realm(a.realm)?.name ?? a.realm),
										task: keyText(realm(a.realm)?.tasks[a.task]?.name ?? ''),
									}),
									tone: 'muted',
								},
							],
							startedAt: a.startedAt,
							endsAt: a.finishesAt,
						})),
					),
					...(o.adventures.length ? {} : { notes: [{ text: text('Nobody is away.'), tone: 'muted' as const }] }),
				};
			},
		});
		ctx.views.add({
			id: 'realms.injured',
			async compute(api): Promise<TimersData | null> {
				const o = await overview(api);
				if (!o.injured.length) return null;
				const icons = Object.fromEntries(resources.list().map((r) => [r.id, r.icon ?? r.id]));
				return {
					title: text('Injured heroes'),
					items: await Promise.all(
						o.injured.map(async (i): Promise<UiTimer> => ({
							id: i.hero,
							title: text('{hero}', { hero: await heroName(api, i.hero) }),
							...(i.healingUntil
								? { endsAt: i.healingUntil, lines: [{ text: text('Being treated'), tone: 'muted' as const }] }
								: {
										actions: [
											{
												command: 'realms.heal',
												payload: { hero: i.hero },
												label: text('Treat ({cost}, {t})', { cost: amounts(i.cost, icons), t: duration(i.seconds) }),
											},
										],
									}),
						})),
					),
				};
			},
		});

		ctx.meta.add('realms', () => service.list().map((r) => ({ id: r.id, name: r.name, order: r.order })));

		// Where its screens go (meta `ui`; the client has the widgets).
		// Commit adventures and treatments as they end, on any page (generic `ui.sync`), so the report
		// arrives at once; from the committed rows, so ones that ended while the player was away commit at load.
		ctx.views.add({
			id: 'realms.due',
			async compute(api): Promise<SyncData> {
				const adventures = await api.db
					.prepare('SELECT finishes_at AS at FROM realms_adventures WHERE player_id = ?')
					.bind(api.playerId)
					.all<{ at: number }>();
				const healing = await api.db
					.prepare('SELECT healing_until AS at FROM realms_injuries WHERE player_id = ? AND healing_until IS NOT NULL')
					.bind(api.playerId)
					.all<{ at: number }>();
				return { items: [...adventures.results, ...healing.results].map(({ at }) => ({ at, command: 'realms.sync' })) };
			},
		});

		// The adventure report in the mailbox (generic `ui.report`): each group fought as a row.
		const rewardText = (l: RewardLine): UiText =>
			text(l.lost ? '{0}{1}{2} {3}' : '{0}{1}{2}', {
				0: l.icon ?? '',
				1: keyText(l.name),
				2: l.count && l.count > 1 ? ` ×${l.count}` : '',
				3: [text('(lost: bag full)')],
			});
		mail.present('realms.report', async (_api, message): Promise<ReportData> => {
			const r = message.data as RealmMail;
			return {
				tone: r.injured ? 'bad' : 'good',
				lines: [
					{ text: text('{0} · {1} · {2}', { 0: heroes.nameKey(r.hero), 1: keyText(r.realmName), 2: keyText(r.taskName) }) },
					{
						text: text('Attack {a} · Defence {d} · HP {h} · Recovery {r}%', {
							a: amount(r.stats.attack),
							d: amount(r.stats.defense),
							h: amount(r.stats.hp),
							r: amount(r.stats.recovery, 1),
						}),
						tone: 'muted',
					},
				],
				lanes: {
					columns: [text('Group'), text('Attack / defence / HP'), text('Hero HP'), text(''), text('Rewards')],
					rows: r.groups.map((g) => ({
						label: text('{0}{1}', { 0: g.boss ? '👑 ' : '', 1: keyText(g.name) }),
						tone: g.won ? ('good' as const) : ('bad' as const),
						cells: [
							[{ text: literal(`${amount(g.attack)} / ${amount(g.defense)} / ${amount(g.hp)}`) }],
							[{ text: literal(`${amount(g.hpBefore)} → ${amount(g.hpAfter)}`) }],
							[{ text: text(g.won ? '✔' : '✘') }],
							g.rewards.map((l): UiLine => ({ text: rewardText(l), ...(l.rarity ? { rarity: l.rarity } : {}) })),
						],
					})),
				},
				fields: [
					{
						label: text('Experience'),
						value: [
							{
								text: r.levels ? text('+{0} · up {1} levels', { 0: amount(r.exp), 1: r.levels }) : literal(`+${amount(r.exp)}`),
							},
						],
					},
					...(r.clearRewards.length
						? [
								{
									label: text('Clear rewards'),
									value: r.clearRewards.map((l) => ({ text: rewardText(l), ...(l.rarity ? { rarity: l.rarity } : {}) })),
								},
							]
						: []),
				],
				...(r.injured
					? { notes: [{ text: text('The hero fell and is injured: treat it at its settlement.'), tone: 'warn' as const }] }
					: {}),
			};
		});

		const ui = ctx.services.get('ui');
		ui.band({ band: 'top', widget: 'ui.sync', props: { view: 'realms.due' } });
		ui.page({ id: 'realms', label: 'Realms', order: 6.5 });
		ui.block({ page: 'realms', column: 'left', widget: 'ui.timers', props: { view: 'realms.away' } });
		ui.block({ page: 'realms', column: 'left', widget: 'ui.timers', order: 1, props: { view: 'realms.injured' } });
		ui.block({ page: 'realms', column: 'right', widget: 'ui.rows', props: { view: 'realms.list', filter: 'realms.realm' } });
		ui.mail('realms.report', 'ui.report');
		// On hero cards: its adventure numbers (equipment and research included).
		heroes.addCardLines(async (api, h) => {
			const s = await service.heroStats(api, h);
			return [
				{
					text: text(s.luck ? 'Adventure: {a} / {d} / {h} · Recovery {r}% · Luck +{l}%' : 'Adventure: {a} / {d} / {h} · Recovery {r}%', {
						a: amount(s.attack),
						d: amount(s.defense),
						h: amount(s.hp),
						r: amount(s.recovery, 1),
						l: amount(s.luck ?? 0, 1),
					}),
					tone: 'muted',
				},
			];
		});
	},
});
