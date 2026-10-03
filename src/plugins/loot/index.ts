/**
 * Loot: reward pools and the drop algorithm (docs/design/gameplay.md §9.5). Whoever owns a source of
 * rewards (realms, bandits, NPC settlements, attacks on players...) defines its pool and decides how much a
 * win is worth; any plugin adds things to a pool, with their weight and what they hand out.
 *
 * Each drop has a weight and a value; without a value it is worth the base weight (one for every pool, GM rule
 * `loot.rules.baseWeight`) over its own: twice as rare, twice as much, and what one drop is worth does not
 * change when others are added to its pool. A roll takes only a minimum total value and draws by weight
 * until the drops are worth at least that much.
 *
 * Every pool that has drops also holds an empty slot (rule `loot.rules.empty`): a share of the draws that
 * hands out nothing but counts a little towards the minimum. A small minimum then often ends empty-handed,
 * a large one hardly ever; how much drops grows with the minimum instead of jumping from none to one.
 *
 * Pools named "<group>.<name>" (e.g. one per realm and task, "realms.<realm>.<task>") form a group: GM
 * weights may be given for the whole group ("realms") or one pool.
 */
import {
	csvRules,
	definePlugin,
	type EngineApi,
	gameErrors,
	numberFields,
	numberInRange,
	PluginError,
	type ReadApi,
	recordOf,
} from '../../kernel';
import type { RewardLine } from '../../shared/api';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';

const RULES = csvRules(rulesCsv) as {
	maxDraws: number;
	baseWeight: number;
	empty: { share: number; value: number };
	tiers: { common: number; uncommon: number };
};
const fail = gameErrors('loot');
/** The empty slot's id in draws (never a drop's: ids are kebab-case). */
const EMPTY = '';
/** `meanDrops` results by pool, minimum and the drops in play: the same answer until rules or content change. */
const MEAN_CACHE = new Map<string, { mean: number; nothing: number }>();
const MEAN_CACHE_MAX = 2000;

/** How a drop looks in a list of possible rewards (`name`: an i18n key). */
export type LootPreview = Omit<RewardLine, 'count' | 'lost'>;

/** Something a pool can drop. `C`: what the pool's owner says about the occasion (e.g. the realm and task). */
export interface LootDrop<C> {
	/** Unique in its pool; GM weight overrides use it (`loot.weights`). */
	id: string;
	/** Relative chance of being drawn on this occasion (0 or less: not in the pool). */
	weight: number | ((c: C, api: ReadApi) => number);
	/** What it counts towards the minimum total value; default: the base weight (`loot.rules.baseWeight`) / its weight. */
	value?: number;
	/** Only on these occasions (default: all). */
	where?(c: C): boolean;
	/** What players see in the list of possible rewards (pools nobody previews need none). */
	preview?: LootPreview;
	/** Hand it out (in the same commit); the lines go into the report. */
	give(api: EngineApi, c: C & { playerId: string; random: () => number }): Promise<RewardLine[]>;
}

export interface LootService {
	/** Open a pool (by its owner). Its id is namespaced by convention: "<pluginId>" or "<pluginId>.<name>". */
	definePool(pool: string): void;
	/** Put something in a pool. Its preview and reward names are i18n keys of the plugin adding it. */
	addDrop<C>(pool: string, drop: LootDrop<C>): void;
	/** The ids of what was put in a pool, or in every pool of a group (for GM weights and tests). */
	drops(poolOrGroup: string): string[];
	/** Whether a pool was defined (e.g. pools made from content once every plugin is set up). */
	has(pool: string): boolean;
	/** Nothing was ever put in this pool: callers skip working out a roll. */
	empty(pool: string): boolean;
	/** Draw from `pool` by weight until worth at least `minValue` (none for 0): the drops' ids, repeats possible; empty draws left out. */
	roll<C>(api: ReadApi, pool: string, c: C, minValue: number, random: () => number): string[];
	/** Hand out drops by id (e.g. ones rolled earlier and kept); unknown ids are skipped. */
	give<C>(api: EngineApi, pool: string, ids: string[], c: C & { playerId: string; random: () => number }): Promise<RewardLine[]>;
	/** What can drop on this occasion, most likely first, grouped as "common", "uncommon" and "rare" (GM rule `loot.rules.tiers`). */
	preview<C>(api: ReadApi, pool: string, c: C): Record<'common' | 'uncommon' | 'rare', LootPreview[]>;
	/**
	 * What a roll of `minValue` gives on this occasion: drops on average, and how often none (sampled once,
	 * then kept while nothing changes).
	 */
	meanDrops<C>(api: ReadApi, pool: string, c: C, minValue: number, seed: () => number): { mean: number; nothing: number };
}

declare module '../../kernel' {
	interface ServiceMap {
		loot: LootService;
	}
}

export default definePlugin({
	id: 'loot',
	version: '0.1.0',
	description: 'Reward pools and the drop algorithm: draw by weight until a minimum total value is reached',
	dependsOn: ['i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const pools = new Map<string, Map<string, LootDrop<unknown>>>();
		/** "realms.<realm>.<task>" belongs to group "realms"; a pool without a dot is its own group. */
		const groupOf = (pool: string) => pool.split('.')[0];
		const inGroup = (group: string) => [...pools.keys()].filter((p) => groupOf(p) === group);
		const rules = ctx.config.define('rules', {
			description:
				'maxDraws: most draws in one roll (a safety cap); baseWeight: a drop without its own value is worth baseWeight / its weight; empty.share / empty.value: the empty slot of every pool, its share of the draws and what it counts towards the minimum; tiers.common / uncommon: share of the pool weight from which a drop shows as common / uncommon (else rare).',
			default: () => RULES,
			parse(raw) {
				const r = (raw ?? {}) as { maxDraws?: unknown; baseWeight?: unknown; empty?: unknown; tiers?: unknown };
				const empty = numberFields(() => RULES.empty, 0, 1e9)(r.empty ?? {});
				if (empty.share >= 1) throw fail('bad_config', 'empty.share is a share below 1');
				return {
					maxDraws: r.maxDraws === undefined ? RULES.maxDraws : numberInRange(1, 1e4)(r.maxDraws),
					baseWeight: r.baseWeight === undefined ? RULES.baseWeight : numberInRange(0.000001, 1e9)(r.baseWeight),
					empty,
					tiers: numberFields(() => RULES.tiers, 0, 1)(r.tiers ?? {}),
				};
			},
		});
		const weights = ctx.config.define('weights', {
			description:
				'Weight of drops by pool (or group of pools, e.g. "realms" for every realm and task) and drop id, e.g. { "realms": { "scrap-metal": 0 } } (0 = never). A pool\'s own entry wins over its group\'s. Partial: others keep theirs.',
			default: () => ({}) as Record<string, Record<string, number>>,
			// A pool's or a group's own drop ids: an id from elsewhere is a mistake, not a weight.
			parse(raw) {
				const out: Record<string, Record<string, number>> = {};
				const known = () => new Set([...pools.keys(), ...[...pools.keys()].map(groupOf)]);
				for (const [key, w] of Object.entries(recordOf(known, (x) => x)(raw)))
					out[key] = recordOf(() => service.drops(key), numberInRange(0, 1e9))(w);
				return out;
			},
		});

		const poolOf = (pool: string) => {
			const p = pools.get(pool);
			if (!p) throw new PluginError(`Unknown loot pool "${pool}"`);
			return p;
		};
		/**
		 * The live entries on an occasion: weight (GM: the pool's, else its group's, else its own) and value
		 * (default from the base weight), then the empty slot. `shown`: share among the drops alone (the list).
		 */
		const entries = <C>(api: ReadApi, pool: string, c: C) => {
			const all = weights.get(api);
			const gm = { ...(all[groupOf(pool)] ?? {}), ...(all[pool] ?? {}) };
			const live = [...poolOf(pool).values()]
				.filter((d) => !d.where || d.where(c))
				.map((d) => ({
					drop: d as LootDrop<unknown> | null,
					id: d.id,
					weight: gm[d.id] ?? (typeof d.weight === 'function' ? d.weight(c, api) : d.weight),
				}))
				.filter((d) => d.weight > 0);
			const real = live.reduce((a, d) => a + d.weight, 0);
			const { baseWeight, empty } = rules.get(api);
			const out = live.map((d) => ({ ...d, shown: d.weight / real, value: d.drop!.value ?? baseWeight / d.weight }));
			if (live.length && empty.share > 0)
				out.push({ drop: null, id: EMPTY, weight: (real * empty.share) / (1 - empty.share), shown: 0, value: empty.value });
			const total = out.reduce((a, d) => a + d.weight, 0);
			return out.map((d) => ({ ...d, share: d.weight / total })).sort((a, b) => b.weight - a.weight);
		};

		/** Draw from the live entries by weight until their values reach `minValue` (the empty slot included). */
		function draw(api: ReadApi, live: ReturnType<typeof entries>, minValue: number, random: () => number) {
			const out: string[] = [];
			if (!live.length) return out;
			let worth = 0;
			for (let i = 0; i < rules.get(api).maxDraws && worth < minValue; i++) {
				let at = random();
				const e = live.find((x) => (at -= x.share) < 0) ?? live[live.length - 1];
				out.push(e.id);
				worth += e.value;
			}
			return out;
		}
		const real = (ids: string[]) => ids.filter((id) => id !== EMPTY);

		const service: LootService = {
			definePool(pool) {
				if (pools.has(pool)) throw new PluginError(`Loot pool "${pool}" defined twice`);
				pools.set(pool, new Map());
			},
			addDrop(pool, drop) {
				const p = poolOf(pool);
				if (p.has(drop.id)) throw new PluginError(`Loot "${drop.id}" added to "${pool}" twice`);
				// What it shows and hands out is named in i18n keys of the plugin adding it (full keys stay as they are).
				const own = ctx.services.get('i18n').scope();
				p.set(drop.id, {
					...(drop as LootDrop<unknown>),
					...(drop.preview ? { preview: { ...drop.preview, name: own(drop.preview.name) } } : {}),
					give: async (api, c) => (await (drop as LootDrop<unknown>).give(api, c)).map((l) => ({ ...l, name: own(l.name) })),
				});
			},
			drops: (key) => (pools.has(key) ? [...poolOf(key).keys()] : [...new Set(inGroup(key).flatMap((p) => [...poolOf(p).keys()]))]),
			has: (pool) => pools.has(pool),
			empty: (pool) => !poolOf(pool).size,
			roll(api, pool, c, minValue, random) {
				// An empty pool (e.g. NPC settlements before any plugin adds loot) costs nothing.
				if (minValue <= 0 || !poolOf(pool).size) return [];
				return real(draw(api, entries(api, pool, c), minValue, random));
			},
			async give(api, pool, ids, c) {
				const p = poolOf(pool);
				const out: RewardLine[] = [];
				for (const id of ids) {
					const d = p.get(id);
					if (d) out.push(...(await d.give(api, c)));
				}
				return out;
			},
			preview(api, pool, c) {
				const out: Record<'common' | 'uncommon' | 'rare', LootPreview[]> = { common: [], uncommon: [], rare: [] };
				if (!poolOf(pool).size) return out;
				const { common, uncommon } = rules.get(api).tiers;
				for (const e of entries(api, pool, c))
					if (e.drop?.preview) out[e.shown >= common ? 'common' : e.shown >= uncommon ? 'uncommon' : 'rare'].push(e.drop.preview);
				return out;
			},
			meanDrops(api, pool, c, minValue, seed) {
				if (minValue <= 0 || !poolOf(pool).size) return { mean: 0, nothing: 1 };
				const live = entries(api, pool, c);
				if (!live.length) return { mean: 0, nothing: 1 };
				// Sampled once per isolate for what is in play (ids, weights, values; the GM's rules included).
				const key = `${pool}|${minValue}|${rules.get(api).maxDraws}|${live.map((e) => `${e.id}:${e.weight}:${e.value}`).join(',')}`;
				const known = MEAN_CACHE.get(key);
				if (known) return known;
				const n = 400;
				let total = 0;
				let none = 0;
				for (let i = 0; i < n; i++) {
					const got = real(draw(api, live, minValue, seed)).length;
					total += got;
					if (!got) none++;
				}
				if (MEAN_CACHE.size >= MEAN_CACHE_MAX) MEAN_CACHE.clear();
				const result = { mean: total / n, nothing: none / n };
				MEAN_CACHE.set(key, result);
				return result;
			},
		};
		ctx.services.provide('loot', service);
	},
});
