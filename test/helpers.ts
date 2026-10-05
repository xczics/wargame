import { buildingTemplate } from '../src/shared/buildings';
import { defineTemplates, mergeCards, mergeRows, mergeTree } from '../src/shared/statics';
import type { CardsData, RowsData, TreeData } from '../src/shared/ui';
/** Shared by the engine tests (test/game/*.spec.ts): the database, the fake clock's start, kernels and a player. */
import { env } from 'cloudflare:workers';
import { computeViews, createKernel, definePlugin, engineContext, executeCommand, type Kernel } from '../src/kernel';
import { plugins } from '../src/plugins';
import type { MailInbox, ResourcePool, SettlementDetail, SettlementSummary } from '../src/shared/api';
import type { UiText } from '../src/shared/ui';

export const db = env.DB;
export const T0 = 2_000_000_000_000;
// The client builders of templates static views name (web/plugins: the same registration).
defineTemplates('buildings', buildingTemplate);
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

export function player(extra?: Record<string, unknown>, kernel: Kernel = defaultKernel) {
	// No built-in income, no terrain bonus and full planning-table costs, so the numbers come only from buildings.
	const overrides = {
		'starter-content.baseProduction': {},
		'terrain.bonus': NO_TERRAIN_BONUS,
		'buildings.ownResourceFreeUntil': 0,
		// Cities and fortresses start at 0 (techs, prestige and items raise them); tests that found some need a few.
		'player-settlements.limits': { city: 2, 'fortress-resource': 3, 'fortress-military': 3 },
		...extra,
	};
	const id = crypto.randomUUID();
	const at = (now: number, privileged = false) => engineContext(kernel, id, now, overrides, privileged);
	const views = async (now: number, ids: string[], params: Record<string, string> = {}) =>
		(await computeViews(kernel, db, at(now), ids, params)).views as Record<string, unknown>;
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
		detail: async (now: number, settlement?: string) =>
			(await views(now, ['settlements.detail'], settlement ? { settlement } : {}))['settlements.detail'] as SettlementDetail,
		pool: async (now: number, settlement?: string) =>
			(await views(now, ['resources.pool'], settlement ? { settlement } : {}))['resources.pool'] as ResourcePool,
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
export const inbox = async (p: ReturnType<typeof player>, now: number) => (await p.views(now, ['mail.inbox']))['mail.inbox'] as MailInbox;
export const outer = (d: SettlementDetail, i = 0) => d.districts.filter((x) => x.type === 'outer')[i];

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
