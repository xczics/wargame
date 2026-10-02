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
	executeCommand,
	GameError,
	numberFields,
	numberInRange,
	PluginError,
	seededRandom,
	type EngineApi,
	type ReadApi,
} from '../../kernel';
import { requestContext } from '../../runtime/context';
import type { AdventureInfo, InjuryInfo, RealmInfo, RealmMail, RealmsOverview, RealmTaskInfo, RewardLine } from '../../shared/api';
import { fightGroups, type AdventureStats, type GroupOutcome, type MonsterGroup } from '../../shared/realms';
import type { Hero } from '../heroes';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';

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
	/**
	 * How many things a beaten group drops: relative weights of 0, 1, 2... drops (e.g. [45, 40, 12, 3]);
	 * each drop is drawn from the pool on its own.
	 */
	dropCounts: number[];
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

export interface DropDef {
	id: string;
	/** Relative weight in the pool; may depend on the realm, task and rules (0 = not there). */
	weight: number | ((realm: RealmDef, task: number, api: ReadApi) => number);
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
	dependsOn: ['heroes', 'settlements', 'resources', 'stats', 'timeline', 'world-map', 'mail', 'ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv);
		const heroes = ctx.services.get('heroes');
		const settlements = ctx.services.get('settlements');
		const resources = ctx.services.get('resources');
		const stats = ctx.services.get('stats');
		const timeline = ctx.services.get('timeline');
		const map = ctx.services.get('worldMap');
		const mail = ctx.services.get('mail');
		const realms = new Map<string, RealmDef>();
		const statSources: HeroStatsSource[] = [];
		const drops = new Map<string, DropDef>();
		const clearRewards = new Map<string, ClearReward>();

		const rules = ctx.config.define('rules', {
			description:
				'groupSeconds per monster group fought; minDamage: least share of attack a blow does; sitesPerRealm map tiles per realm; heal.* treatment time and cost per hero level; dropTiers.common / uncommon: shares of the pool shown as common / uncommon (else rare).',
			default: () => RULES as Record<string, unknown>,
			parse(raw) {
				const top = numberFields(() => ({
					groupSeconds: RULES.groupSeconds as number,
					minDamage: RULES.minDamage as number,
					sitesPerRealm: RULES.sitesPerRealm as number,
				}))(Object.fromEntries(Object.entries((raw ?? {}) as Record<string, unknown>).filter(([k]) => k !== 'heal' && k !== 'dropTiers')));
				const heal = numberFields(() => RULES.heal as Record<string, number>)((raw as { heal?: unknown } | null)?.heal ?? {});
				const dropTiers = numberFields(
					() => RULES.dropTiers as Record<string, number>,
					0,
					1,
				)((raw as { dropTiers?: unknown } | null)?.dropTiers ?? {});
				if (top.minDamage > 1) throw new GameError('bad_config', 'minDamage is a share (0-1)');
				return { ...top, heal, dropTiers };
			},
		});
		const rule = (api: ReadApi) =>
			rules.get(api) as {
				groupSeconds: number;
				minDamage: number;
				sitesPerRealm: number;
				heal: Record<string, number>;
				dropTiers: { common: number; uncommon: number };
			};
		const dropWeights = ctx.config.define('dropWeights', {
			description: 'Weight of each drop in the reward pool, by drop id (0 = never). Partial: other drops keep their own weight.',
			default: () => ({}) as Record<string, number>,
			parse(raw) {
				if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new GameError('bad_config', 'Expected { dropId: weight }');
				return Object.fromEntries(
					Object.entries(raw).map(([id, w]) => {
						if (!drops.has(id)) throw new GameError('bad_config', `Unknown drop "${id}"`);
						return [id, numberInRange(0, 1e6)(w)];
					}),
				);
			},
		});
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
			define(def) {
				if (realms.has(def.id)) throw new PluginError(`Realm "${def.id}" defined twice`);
				realms.set(def.id, def);
			},
			list: () => [...realms.values()].sort((a, b) => a.order - b.order),
			get(id) {
				const r = realms.get(id);
				if (!r) throw new GameError('bad_payload', `Unknown realm "${id}"`);
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
			addDrop(def) {
				if (drops.has(def.id)) throw new PluginError(`Realm drop "${def.id}" defined twice`);
				drops.set(def.id, def);
			},
			addClearReward(def) {
				if (clearRewards.has(def.id)) throw new PluginError(`Realm clear reward "${def.id}" defined twice`);
				clearRewards.set(def.id, def);
			},
			async isUnlocked(api, playerId, realmId) {
				return !service.get(realmId).locked || (await loadUnlocked(api, playerId)).has(realmId);
			},
			async unlock(api, playerId, realmId) {
				if (await service.isUnlocked(api, playerId, realmId)) throw new GameError('blocked', 'That realm is open already');
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
				if (!hero || !row) throw new GameError('blocked', 'That hero is not injured');
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

		/** The drops that can fall in a task, with their weights now (GM weights win). */
		const poolOf = (api: ReadApi, realm: RealmDef, task: number) => {
			const gm = dropWeights.get(api);
			return [...drops.values()]
				.filter((d) => !d.where || d.where(realm, task))
				.map((d) => ({ def: d, weight: gm[d.id] ?? (typeof d.weight === 'function' ? d.weight(realm, task, api) : d.weight) }))
				.filter((d) => d.weight > 0);
		};
		/** Possible drops grouped by how often they fall, for a task the player has cleared. */
		const dropList = (api: ReadApi, realm: RealmDef, task: number) => {
			const pool = poolOf(api, realm, task);
			const total = pool.reduce((a, d) => a + d.weight, 0);
			const { common, uncommon } = rule(api).dropTiers;
			const out: RealmTaskInfo['drops'] = { common: [], uncommon: [], rare: [], clear: [] };
			for (const d of [...pool].sort((a, b) => b.weight - a.weight)) {
				const share = d.weight / total;
				out![share >= common ? 'common' : share >= uncommon ? 'uncommon' : 'rare'].push(d.def.preview);
			}
			for (const r of clearRewards.values()) if (!r.where || r.where(realm, task)) out!.clear.push(r.preview(realm, task));
			return out;
		};
		const loadCleared = (api: ReadApi, playerId: string) =>
			api.memo(`realms:cleared:${playerId}`, async () => {
				const { results } = await api.db
					.prepare('SELECT realm, task FROM realms_cleared WHERE player_id = ?')
					.bind(playerId)
					.all<{ realm: string; task: number }>();
				return new Set(results.map((r) => `${r.realm}:${r.task}`));
			});

		/** What a beaten group drops: how many (by the task's weights), then each from the pool. */
		function rollDrops(api: ReadApi, realm: RealmDef, task: number, counts: number[], luck: number, random: () => number): string[] {
			const pick = <T>(list: T[], weight: (x: T) => number): T | null => {
				const total = list.reduce((a, x) => a + weight(x), 0);
				let at = random() * total;
				for (const x of list) if ((at -= weight(x)) < 0) return x;
				return null;
			};
			const n =
				pick(
					// Luck: each extra drop weighs (1 + luck%) more than the one before.
					counts.map((w, i) => ({ i, w: w * (1 + luck / 100) ** i })),
					(x) => x.w,
				)?.i ?? 0;
			const pool = poolOf(api, realm, task).map((d) => ({ id: d.def.id, w: d.weight }));
			const out: string[] = [];
			for (let k = 0; k < n; k++) {
				const d = pick(pool, (x) => x.w);
				if (d) out.push(d.id);
			}
			return out;
		}

		ctx.commands.add<{ hero: string; realm: string; task: number }>({
			type: 'realms.adventure',
			description: 'Send a hero on an adventure. Payload: { "hero", "realm", "task": 0-4 }',
			// On the map, when a realm's site is selected (the Realms page has its own controls).
			form: {
				title: 'Send a hero on an adventure',
				placement: 'tile',
				fields: [
					{ name: 'realm', label: 'realm', type: 'hidden' },
					{ name: 'hero', label: 'Hero', type: 'select', required: true },
					{ name: 'task', label: 'Task', type: 'select', required: true },
				],
				submitLabel: 'Set out',
				async prepare(api, params) {
					const x = Number(params.x);
					const y = Number(params.y);
					const site = (await loadSites(api)).find((s) => s.x === x && s.y === y);
					const realm = site && realms.get(site.realm);
					if (!realm) return false;
					const open = await service.isUnlocked(api, api.playerId, realm.id);
					const idle = (await heroes.list(api, api.playerId)).filter((h) => h.duty === 'idle');
					return {
						description: open ? (realm.quote ?? '') : 'Locked: open it with its key (from the hardest task of the realm before).',
						defaults: { realm: realm.id, task: '0' },
						options: {
							hero: open ? idle.map((h) => ({ value: h.id, label: `${heroes.nameOf(h)} (Lv ${h.level})` })) : [],
							task: realm.tasks(api).map((t, i) => ({ value: String(i), label: t.name })),
						},
					};
				},
			},
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.hero !== 'string' || typeof p.realm !== 'string') throw new GameError('bad_payload', 'hero and realm are required');
				const task = Number(p.task);
				if (!Number.isInteger(task) || task < 0) throw new GameError('bad_payload', 'task must be a whole number');
				return { hero: p.hero, realm: p.realm, task };
			},
			async execute(api, { hero: heroId, realm: realmId, task }) {
				const hero = (await heroes.list(api, api.playerId)).find((h) => h.id === heroId);
				if (!hero) throw new GameError('not_found', 'No such hero', 404);
				if (hero.duty !== 'idle') throw new GameError('blocked', 'Only idle heroes can go on an adventure');
				const realm = service.get(realmId);
				if (!(await service.isUnlocked(api, api.playerId, realm.id))) throw new GameError('blocked', 'That realm is locked');
				const t = realm.tasks(api)[task];
				if (!t) throw new GameError('bad_payload', 'No such task');
				const stats = await service.heroStats(api, hero);
				const { minDamage, groupSeconds } = rule(api);
				const outcomes = fightGroups(stats, t.groups, minDamage);
				const random = seededRandom(`${hero.id}:${api.now}:${crypto.randomUUID()}`);
				const dropped: Record<number, string[]> = {};
				outcomes.forEach((o, i) => {
					const d = o.won ? rollDrops(api, realm, task, t.dropCounts, stats.luck ?? 0, random) : [];
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
					for (const id of Array.isArray(ids) ? ids : ids ? [ids] : []) {
						const drop = drops.get(id);
						if (drop && realm) rewards.push(...(await drop.give(api, { playerId: hero.playerId, hero, realm, task: row.task, random })));
					}
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
			if (lost) {
				const injuryRow: InjuryRow = { hero_id: hero.id, player_id: hero.playerId, healing_until: null };
				(await loadInjuries(api, hero.playerId)).push(injuryRow);
				api.write(
					api.db
						.prepare('INSERT INTO realms_injuries (hero_id, player_id, healing_until) VALUES (?, ?, NULL)')
						.bind(hero.id, hero.playerId),
				);
				await heroes.assign(api, hero.id, INJURED, null);
			} else await heroes.assign(api, hero.id, 'idle', null);
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
				title: result.cleared ? 'Adventure in {realm}: cleared' : lost ? 'Adventure in {realm}: defeated' : 'Adventure in {realm}',
				vars: { realm: report.realmName },
				data: report,
				at: event.dueAt,
			});
		});

		/* ----- injuries --------------------------------------------------------------------- */

		ctx.commands.add<{ hero: string }>({
			type: 'realms.heal',
			description: 'Start treating an injured hero (paid by its settlement). Payload: { "hero" }',
			parse(raw) {
				const hero = (raw as { hero?: unknown } | null)?.hero;
				if (typeof hero !== 'string') throw new GameError('bad_payload', 'hero is required');
				return { hero };
			},
			async execute(api, { hero: heroId }) {
				const hero = (await heroes.list(api, api.playerId)).find((h) => h.id === heroId);
				if (!hero) throw new GameError('not_found', 'No such hero', 404);
				const row = await injury(api, api.playerId, hero.id);
				if (!row) throw new GameError('blocked', 'That hero is not injured');
				if (row.healing_until !== null) throw new GameError('busy', 'Already being treated');
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
				title: 'Speed up an adventure or treatment',
				placement: 'gm',
				fields: [
					{ name: 'hero', label: 'Hero', type: 'select', required: true },
					{ name: 'minutes', label: 'Minutes to skip (0 = end now)', type: 'number', min: 0, default: 0 },
				],
				submitLabel: 'Speed up',
				async prepare(api) {
					const mine = await heroes.list(api, api.playerId);
					const options: { value: string; label: string }[] = [];
					for (const a of await loadAdventures(api, api.playerId)) {
						const h = mine.find((x) => x.id === a.hero_id);
						if (h && a.finishes_at > api.now)
							options.push({
								value: h.id,
								label: `${heroes.nameOf(h)} · ${realms.get(a.realm)?.name ?? a.realm} · ${Math.ceil((a.finishes_at - api.now) / 60_000)} min`,
							});
					}
					for (const i of await loadInjuries(api, api.playerId)) {
						const h = mine.find((x) => x.id === i.hero_id);
						if (h && i.healing_until && i.healing_until > api.now)
							options.push({
								value: h.id,
								label: `${heroes.nameOf(h)} · treatment · ${Math.ceil((i.healing_until - api.now) / 60_000)} min`,
							});
					}
					return options.length ? { options: { hero: options } } : false;
				},
			},
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.hero !== 'string') throw new GameError('bad_payload', 'hero is required');
				const seconds = numberInRange(0, 1e9)(Number(p.seconds !== undefined ? p.seconds : Number(p.minutes ?? 0) * 60));
				return { hero: p.hero, seconds: seconds || 1e9 }; // 0 = end it now
			},
			async execute(api, { hero, seconds }) {
				if (!(await heroes.list(api, api.playerId)).some((h) => h.id === hero)) throw new GameError('not_found', 'No such hero', 404);
				if (!(await service.speedUp(api, hero, seconds)))
					throw new GameError('blocked', 'That hero is neither adventuring nor being treated');
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
				title: 'Place realm sites',
				placement: 'gm',
				fields: [{ name: 'count', label: 'At most', type: 'number', required: true, min: 1, max: 100, default: 30 }],
				submitLabel: 'Place',
			},
			parse: (raw) => ({ count: Math.floor(numberInRange(1, 100)((raw as { count?: unknown } | null)?.count ?? 10)) }),
			async execute(api, { count }) {
				const sites = await loadSites(api);
				let budget = count;
				for (const realm of service.list()) {
					let missing = rule(api).sitesPerRealm - sites.filter((s) => s.realm === realm.id).length;
					while (missing-- > 0 && budget-- > 0) {
						const tile = await map.findFreeSquare(api, 0);
						if (!tile) throw new GameError('map_full', 'Could not find free land', 503);
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

		ctx.views.add({
			id: 'realms.overview',
			async compute(api): Promise<RealmsOverview> {
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
							dropCounts: t.dropCounts,
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
				return { realms: out, adventures, injured, heroStats, groupSeconds, minDamage };
			},
		});

		ctx.meta.add('realms', () => service.list().map((r) => ({ id: r.id, name: r.name, order: r.order })));

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		ui.page({ id: 'realms', label: 'Realms', order: 6.5 });
		ui.block({ page: 'realms', column: 'left', widget: 'realms.adventures' });
		ui.block({ page: 'realms', column: 'right', widget: 'realms.page' });
		ui.mail('realms.report', 'realms.report');
		ui.slot({ slot: 'hero-card', widget: 'realms.adventure' });
	},
});
