import { buildingTemplate } from '../src/shared/buildings';
import { defineItemCards } from '../src/shared/items';
import { defineTemplates, mergeCards, mergeRows, mergeTree } from '../src/shared/statics';
import type { CardsData, RowsData, TreeData } from '../src/shared/ui';
/** Shared by the engine tests (test/game/*.spec.ts): the database, the fake clock's start, kernels and a player. */
import { env } from 'cloudflare:workers';
import {
	computeViews,
	createKernel,
	definePlugin,
	type EngineApi,
	type EngineContext,
	engineContext,
	executeCommand,
	type Kernel,
} from '../src/kernel';
import { plugins } from '../src/plugins';
import { bucketFiles } from '../src/runtime/files';
import { puzzleItemCards } from '../web/plugins/puzzles/item-cards';
import { partsAt } from '../src/shared/client-views';
import { clientParts, clientViews } from '../web/views';
import { type FormsInput, resolveForms } from '../src/shared/forms';
import type { FormPatches, FormSpecs, ResolvedForm } from '../src/shared/api';
import type {
	EquipmentState,
	HeroDraftInfo,
	HeroOffers,
	MailInbox,
	MailMessage,
	MapWindow,
	MapWindowSettlements,
	ResourcePool,
	SettlementSummary,
} from '../src/shared/api';
import { detailOf, type SettlementDetail } from './detail';
import { probe, viewIn } from './probe';
import type { UiText } from '../src/shared/ui';
import type { BattleReport, MapSideCamps, NpcCampLevels } from '../src/shared/api';
import { layoutOf, type LayoutRules, mapGeometry, standingCamps } from '../src/shared/npc-camps';
import { MAP_MAX, MAP_MIN } from '../src/plugins/world-map';

export const db = env.DB;
/** The file bucket, as requests see it (`EngineContext.files`). */
export const files = bucketFiles(env.FILES);
export const T0 = 2_000_000_000_000;
/** The database as D1 sees it: one entry per call (a batch is one), the number of statements in it. */
export function d1Calls(base: D1Database = db) {
	const sent: number[] = [];
	const counted = new Proxy(base, {
		get(target, key) {
			if (key === 'prepare')
				return (q: string) => {
					const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
						new Proxy(s, {
							get(t, k) {
								if (k === 'bind') return (...v: unknown[]) => wrap(t.bind(...v));
								if (k === 'all' || k === 'first' || k === 'run' || k === 'raw') sent.push(1);
								const v = Reflect.get(t, k, t);
								return typeof v === 'function' ? v.bind(t) : v;
							},
						});
					return wrap(target.prepare(q));
				};
			if (key === 'batch') return (list: D1PreparedStatement[]) => (sent.push(list.length), target.batch(list));
			const v = Reflect.get(target, key, target);
			return typeof v === 'function' ? v.bind(target) : v;
		},
	});
	return { sent, db: counted };
}
// The client builders of templates static views name (web/plugins: the same registration).
defineTemplates('buildings', buildingTemplate);
defineItemCards('starter-puzzles', puzzleItemCards);
export const defaultKernel = createKernel(plugins);
/**
 * A text as a player reads it in English (the client's rules: vars that are texts translated, lists
 * joined, values as they are; a key without a translation, e.g. a layout, without its plugin id). For checks on a sentence made of several texts; prefer the structure.
 */
export function en(ui: UiText | undefined, kernel: Kernel = defaultKernel): string {
	if (!ui) return '';
	const table = (kernel.meta.get('i18n')!() as Record<string, Record<string, string>>).en;
	const render = (t: UiText): string =>
		(table[t.text] ?? t.text.replace(/^[a-z][a-z0-9-]*\./, '')).replace(/\{(\w+)\}/g, (all, k: string) => {
			const v = t.vars?.[k];
			if (v === undefined) return all;
			if (Array.isArray(v)) return v.map(render).join(', ');
			return typeof v === 'object' ? render(v) : String(v);
		});
	return render(ui);
}
export const NO_TERRAIN_BONUS = Object.fromEntries(
	defaultKernel.services
		.get('terrain')
		.list()
		.map((t) => [t.id, {}]),
);

/**
 * Simple fixed-number units, so battle and march tests do not depend on the starter army's
 * formulas (tested on their own): militia needs a barracks, spearmen a level-2 one.
 */
export const testUnits = definePlugin({
	id: 'test-units',
	version: '0',
	dependsOn: ['troops', 'buildings'],
	setup(ctx) {
		const troops = ctx.services.get('troops');
		const buildings = ctx.services.get('buildings');
		troops.define({
			id: 'militia',
			name: 'Militia',
			stats: { attack: 5, defense: 8, hp: 10, speed: 12, carry: 20, cost: { food: 30, wood: 10 }, seconds: 5, upkeep: { food: 0.02 } },
		});
		troops.define({
			id: 'spearman',
			name: 'Spearman',
			stats: {
				attack: 12,
				defense: 15,
				hp: 20,
				speed: 9,
				carry: 35,
				cost: { food: 50, wood: 40, stone: 20, gold: 10 },
				seconds: 12,
				upkeep: { food: 0.04, gold: 0.01 },
			},
		});
		const need: Record<string, number> = { militia: 1, spearman: 2 };
		troops.addTrainingGate(async (api, s, unit) =>
			!need[unit.id] || (await buildings.level(api, s.id, 'barracks')) >= need[unit.id]
				? null
				: { text: 'test-units.Requires Barracks {0}', vars: { 0: need[unit.id] } },
		);
	},
});
export const unitsKernel = createKernel([...plugins, testUnits]);

/** A piece of equipment of the player's (`p.bag`). */
export interface BagPiece {
	id: string;
	base: string;
	/** Name key (its base's). */
	name: string;
	slot: string;
	tier: number;
	rarity: string;
	stats: Record<string, number>;
	/** The hero wearing it, or null: then it is stored in `settlement`. */
	hero: string | null;
	settlement: string | null;
	/** Heroes below this level cannot wear it. */
	minLevel?: number;
	/** Its set's name key. */
	set?: string;
}
/** Everything the player's equipment is (`p.bag`). */
export interface Bag {
	pieces: BagPiece[];
	/** How full each settlement's storage is. */
	storage: Record<string, { used: number; capacity: number }>;
	/** How many accessories each hero may wear, by hero id. */
	groups: Record<string, { accessory: number }>;
}

/** A venue's candidates (`p.candidates`). */
export interface Candidates {
	venue: string;
	name: string;
	settlement: string;
	refreshesAt: number;
	cost: Record<string, number>;
	taken: number[];
	candidates: (({ slot: number; gift?: string } & HeroDraftInfo) | null)[];
}

/** A tile a settlement stands on (`p.tiles`). `name`: the key of its kind's name, or what the player called it. */
export interface MapTile {
	x: number;
	y: number;
	settlement: string;
	kind: string;
	name: string;
	/** The settlement's own tile (its inner city or fortress). */
	centre: boolean;
	/** A player's (else an NPC's). */
	owned: boolean;
}

export function player(extra?: Record<string, unknown>, kernel: Kernel = defaultKernel) {
	// No built-in income, no terrain bonus and full planning-table costs, so the numbers come only from buildings.
	const overrides = {
		'starter-content.baseProduction': {},
		'terrain.bonus': NO_TERRAIN_BONUS,
		'buildings.ownResourceFreeUntil': 0,
		// No camps placed by the rule: tests put the camps they need where they want them (npc-camps.spawnAt); the rule's
		// own tests turn it on.
		'npc-camps.density': { perBlock: 0, spread: 0 },
		// Round output for readable numbers: a farm level makes 1 food a second (the content's 0.1 x 10), a quarry 0.8.
		'buildings.productionMultiplier': 10,
		// Short adventures with round experience (2-minute groups, 20 a group): the game's are longer (balancing).
		'realms.rules': { groupSeconds: 120 },
		'starter-realms.exp': { base: 20 },
		// Cities and fortresses start at 0 (techs, prestige and items raise them); tests that found some need a few.
		'player-settlements.limits': { city: 2, 'fortress-resource': 3, 'fortress-military': 3 },
		...extra,
	};
	const id = crypto.randomUUID();
	// The meta depends on the deploy only: worked out once per player, as the browser loads it once.
	const metaCache = new Map<string, unknown>();
	const at = (now: number, privileged = false) => ({ ...engineContext(kernel, id, now, overrides, privileged), files });
	/**
	 * Views as the client has them: server views as the engine works them out, views assembled in the browser
	 * (web/views.ts) by the same functions from the data views they read and the statics.
	 */
	const views = async (now: number, ids: string[], params: Record<string, string> = {}) => {
		const client = ids.flatMap((id) => clientViews.filter((v) => v.id === id));
		const server = [...new Set([...ids.filter((id) => !client.some((v) => v.id === id)), ...client.flatMap((v) => v.needs)])];
		const got = (await computeViews(kernel, db, at(now), server, params)).views as Record<string, unknown>;
		const statics = new Map<string, unknown>();
		if (client.length)
			for (const def of kernel.statics) statics.set(def.id, await def.compute({ rules: { config: at(now).config }, db } as never));
		const out: Record<string, unknown> = Object.fromEntries(ids.filter((id) => id in got).map((id) => [id, got[id]]));
		const meta = (key: string) => (metaCache.has(key) ? metaCache.get(key) : metaCache.set(key, kernel.meta.get(key)?.()).get(key));
		for (const v of client)
			out[v.id] = v.compute({
				data: (view) => got[view] as never,
				static: (id) => statics.get(id) as never,
				params,
				meta: meta as never,
				parts: (point) => partsAt(clientParts, point),
			});
		return out;
	};
	/** The stamps of views that have one (what the client sends back): the same stamp = not sent again. */
	const stamps = async (now: number, ids: string[], params: Record<string, string> = {}) =>
		(await computeViews(kernel, db, at(now), ids, params)).stamps ?? {};
	/** Views as the client shows them: a view over a static one (`base`) merged with it (src/shared/statics.ts). */
	const shown = async (now: number, ids: string[], params: Record<string, string> = {}) => {
		const out = await views(now, ids, params);
		for (const [k, v] of Object.entries(out)) {
			const base = (v as { base?: string } | null)?.base;
			const def = base && kernel.statics.find((x) => x.id === base);
			if (!def) continue;
			const b = await def.compute({ rules: { config: at(now).config }, db });
			const x = v as object;
			out[k] =
				'cards' in x
					? mergeCards(b as CardsData, x as unknown as CardsData)
					: 'sections' in x
						? mergeRows(b as RowsData, x as unknown as RowsData)
						: mergeTree(b as TreeData, x as unknown as TreeData);
		}
		return out;
	};
	const p = {
		id,
		shown,
		stamps,
		/** The rule overrides this player's calls run with. */
		overrides,
		run: (now: number, type: string, payload: unknown = null, privileged = false) =>
			executeCommand(kernel, db, at(now, privileged), type, payload),
		views,
		/** Run test code in the engine as this player, as a view would (test/probe.ts). */
		probe: <T>(now: number, fn: (api: EngineApi, kernel: Kernel) => Promise<T>, params: Record<string, string> = {}) =>
			probe(kernel, at(now), fn, params),
		/**
		 * All the player's equipment at once, as the stored rows have it (where a piece of a dismissed hero lies: the
		 * capital), and from `equipment.state` of each settlement and hero how full storage is and how many accessories fit.
		 */
		bag: (now: number) =>
			probe(kernel, at(now), async (api, k): Promise<Bag> => {
				const settlements = k.services.get('settlements');
				const heroes = await k.services.get('heroes').list(api, api.playerId);
				const ids = new Set(heroes.map((h) => h.id));
				const capital = (await settlements.capital(api, api.playerId))?.id ?? null;
				const bases = new Map(
					k.services
						.get('equipment')
						.bases()
						.map((b) => [b.id, b]),
				);
				const { results } = await api.db
					.prepare('SELECT * FROM equipment_items WHERE player_id = ? ORDER BY created_at')
					.bind(api.playerId)
					.all<{
						id: string;
						base: string;
						slot: string;
						tier: number;
						rarity: string;
						stats: string;
						hero_id: string | null;
						settlement_id: string | null;
					}>();
				const pieces = results.map((r): BagPiece => {
					const hero = r.hero_id && ids.has(r.hero_id) ? r.hero_id : null;
					const b = bases.get(r.base);
					return {
						id: r.id,
						base: r.base,
						name: b?.name ?? r.base,
						...(b?.minLevel ? { minLevel: b.minLevel } : {}),
						...(b?.set ? { set: b.set.name } : {}),
						slot: r.slot,
						tier: r.tier,
						rarity: r.rarity,
						stats: JSON.parse(r.stats),
						hero,
						settlement: !hero && !r.settlement_id ? capital : r.settlement_id,
					};
				});
				const state = (settlement: string, hero?: string) =>
					viewIn<EquipmentState>(k, api, 'equipment.state', hero ? { settlement, hero } : { settlement });
				const storage: Bag['storage'] = {};
				for (const s of await settlements.mine(api, api.playerId)) storage[s.id] = (await state(s.id)).storage;
				const groups: Bag['groups'] = {};
				for (const h of heroes) groups[h.id] = { accessory: (await state(h.home, h.id)).accessories };
				return { pieces, storage, groups };
			}),
		/** A static view as this player's rules bake it. */
		static: async <T>(now: number, id: string) =>
			(await kernel.statics.find((x) => x.id === id)!.compute({ rules: { config: at(now).config }, db } as never)) as T,
		/** A command, then server views as its answer carries them (worked out with what the command kept current). */
		async answer(now: number, type: string, payload: unknown, ids: string[]) {
			const { carried } = await executeCommand(kernel, db, at(now), type, payload);
			return (await computeViews(kernel, db, at(now), ids, {}, [], carried)).views as Record<string, unknown>;
		},
		/** A settlement's districts slot by slot, with what each may start now (test/detail.ts). */
		detail: (now: number, settlement?: string) => detailOf(kernel, at(now), settlement),
		pool: async (now: number, settlement?: string) =>
			(await views(now, ['resources.pool'], settlement ? { settlement } : {}))['resources.pool'] as ResourcePool,
		/** Items the player has, by id (view `items.owned`). */
		owned: async (now: number) => (await views(now, ['items.owned']))['items.owned'] as Record<string, number>,
		/**
		 * Each venue's candidates in a settlement (view `heroes.offers`), the GM's gifts after the regular ones (slot -1,
		 * `gift`: its id), as the cards list them.
		 */
		candidates: async (now: number, settlement?: string): Promise<Candidates[]> => {
			const o = (await views(now, ['heroes.offers'], settlement ? { settlement } : {}))['heroes.offers'] as HeroOffers | null;
			return (o?.venues ?? []).map((v) => ({
				venue: v.venue,
				name: v.name,
				settlement: o!.settlement,
				refreshesAt: v.refreshesAt,
				cost: v.cost,
				taken: v.taken,
				candidates: [
					...v.candidates.map((c, slot) => (c ? { slot, ...c } : null)),
					...v.gifts.map(({ id, ...g }) => ({ slot: -1, gift: id, ...g })),
				],
			}));
		},
		/** The tiles settlements stand on around (x, y), `r` tiles out (the map's data, view `world-map.window`). */
		tiles: async (now: number, x: number, y: number, r: number): Promise<MapTile[]> => {
			const w = (await views(now, ['world-map.window'], { x: String(x), y: String(y), r: String(r) }))['world-map.window'] as MapWindow;
			const found = (w.layers.settlements ?? {}) as MapWindowSettlements;
			const stored = Object.entries(w.held).flatMap(([tile, entity]): MapTile[] => {
				const s = entity.startsWith('settlement:') ? found[entity.slice('settlement:'.length)] : undefined;
				if (!s) return [];
				const [tx, ty] = tile.split(',').map(Number);
				const name = s.name.text === 'i18n.{0}' ? String(s.name.vars![0]) : s.name.text;
				return [
					{
						x: tx,
						y: ty,
						settlement: entity.slice('settlement:'.length),
						kind: s.kind,
						name,
						centre: tx === s.x && ty === s.y,
						owned: !!(s.mine || s.owner),
					},
				];
			});
			// The rules' camps, worked out as the browser does (web/plugins/npc-camps/map.ts) from what the server sent.
			const side = w.sides['npc-camps'] as MapSideCamps | undefined;
			const statics = async (id: string) =>
				kernel.statics.find((d) => d.id === id)!.compute({ rules: { config: at(now).config }, db } as never) as unknown;
			const rules = (await statics('npc-camps.layout')) as LayoutRules;
			const levels = (await statics('npc-camps.levels')) as NpcCampLevels;
			const { size, wrap } = mapGeometry(MAP_MIN, MAP_MAX);
			const taken = new Set([...(side?.taken ?? []), ...Object.keys(w.held)]);
			const camps = side
				? standingCamps(layoutOf(rules, size, wrap).around(w.centre, r), {
						removed: (cid) => !!side.states[cid]?.removed,
						taken: (key) => taken.has(key),
						capitals: side.capitals,
						wrap,
					})
				: [];
			return [
				...stored,
				...camps.map((c) => ({
					x: c.x,
					y: c.y,
					settlement: c.id,
					kind: c.kind,
					name: levels[c.kind]?.[c.level]?.name ?? c.kind,
					centre: true,
					owned: false,
				})),
			];
		},
		mine: async (now: number) => (await views(now, ['settlements.mine']))['settlements.mine'] as SettlementSummary[],
		/** Found the capital and return its detail. */
		async start(now = T0) {
			await p.run(now, 'settlements.foundCapital');
			return p.detail(now);
		},
		construct: (now: number, settlement: string, district: string, slot: number, building?: string) =>
			p.run(now, 'buildings.construct', { settlement, district, slot, building }),
		grant: (now: number, resource: string, amount: number, settlement?: string) =>
			p.run(now, 'resources.grant', { resource, amount, settlement }, true),
	};
	return p;
}

export const inner = (d: SettlementDetail) => d.districts.find((x) => x.type === 'inner')!;
/** The mailbox's first page, each message whole (as the client has it once opened: view `mail.message`). */
export const inbox = async (p: ReturnType<typeof player>, now: number, params: Record<string, string> = {}) => {
	const box = (await p.views(now, ['mail.inbox'], params))['mail.inbox'] as MailInbox;
	const messages: MailMessage[] = [];
	for (const m of box.messages) messages.push((await p.views(now, ['mail.message'], { mail: m.id }))['mail.message'] as MailMessage);
	return { ...box, messages };
};
/** The battle a war report tells of: the shared row (`war_reports_battles`), or the report itself in a mail from before. */
export const battleOf = async (data: unknown): Promise<BattleReport> => {
	const d = data as { battle?: string; report?: BattleReport };
	if (d.report) return d.report;
	const row = await db
		.prepare('SELECT data FROM war_reports_battles WHERE id = ?')
		.bind(d.battle ?? '')
		.first<{ data: string }>();
	if (!row) throw new Error(`no battle ${d.battle}`);
	return JSON.parse(row.data) as BattleReport;
};
export const outer = (d: SettlementDetail, i = 0) => d.districts.filter((x) => x.type === 'outer')[i];

/** A settlement's defence formation (default: the capital's), and whether the player set it (else the default one). */
export const formationOf = (p: ReturnType<typeof player>, now: number, settlement?: string) =>
	p.probe(now, async (api, kernel) => {
		const s = settlement ?? (await kernel.services.get('settlements').capital(api, api.playerId))!.id;
		const row = await api.db
			.prepare('SELECT lanes FROM battle_formations WHERE settlement_id = ?')
			.bind(s)
			.first<{ lanes: string | null }>();
		return { settlement: s, lanes: await kernel.services.get('battle').formation(api, s), saved: !!row?.lanes };
	});

/** Rule overrides leaving only some drops in a loot pool (the others at weight 0; the kept keep their own), without the empty slot. */
export const onlyLoot = (kernel: Kernel, pool: string, keep: (id: string) => boolean) => ({
	'loot.weights': {
		[pool]: Object.fromEntries(
			kernel.services
				.get('loot')
				.drops(pool)
				.filter((id) => !keep(id))
				.map((id) => [id, 0]),
		),
	},
	'loot.rules': { empty: { share: 0 } },
});

/** The forms as the browser shows them for a context (`forms.patches` put together with the static `forms.specs`). */
export async function resolvedForms(
	ctx: EngineContext,
	params: Record<string, string>,
	kernel: Kernel = defaultKernel,
): Promise<ResolvedForm[]> {
	const patches = (await computeViews(kernel, db, ctx, ['forms.patches'], params)).views['forms.patches'] as FormPatches;
	return resolveForms(await formsInput(kernel), patches) ?? [];
}
/** What the browser resolves forms with: the static `forms.specs`, the meta, the client parts (web/views.ts). */
export const formsInput = async (kernel: Kernel = defaultKernel): Promise<FormsInput> => {
	const specs = (await kernel.statics.find((x) => x.id === 'forms.specs')!.compute({ rules: { config: {} }, db } as never)) as FormSpecs;
	const meta = new Map<string, unknown>();
	return {
		static: ((id: string) => (id === 'forms.specs' ? specs : undefined)) as FormsInput['static'],
		meta: ((key: string) => (meta.has(key) ? meta.get(key) : meta.set(key, kernel.meta.get(key)?.()).get(key))) as FormsInput['meta'],
		parts: (point) => partsAt(clientParts, point),
	};
};
