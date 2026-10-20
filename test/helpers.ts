import { buildingTemplate } from '../src/shared/buildings';
import { defineTemplates, mergeCards, mergeRows, mergeTree } from '../src/shared/statics';
import type { CardsData, RowsData, TreeData } from '../src/shared/ui';
/** Shared by the engine tests (test/game/*.spec.ts): the database, the fake clock's start, kernels and a player. */
import { env } from 'cloudflare:workers';
import { computeViews, createKernel, definePlugin, type EngineContext, engineContext, executeCommand, type Kernel } from '../src/kernel';
import { plugins } from '../src/plugins';
import { bucketFiles } from '../src/runtime/files';
import { clientViews } from '../web/views';
import { resolveForms } from '../src/shared/forms';
import type { FormPatches, FormSpecs, ResolvedForm } from '../src/shared/api';
import type { MailInbox, MailMessage, ResourcePool, SettlementDetail, SettlementSummary } from '../src/shared/api';
import type { UiText } from '../src/shared/ui';

export const db = env.DB;
/** The file bucket, as requests see it (`EngineContext.files`). */
export const files = bucketFiles(env.FILES);
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
		for (const v of client) out[v.id] = v.compute({ data: (view) => got[view] as never, static: (id) => statics.get(id) as never, params });
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
/** The mailbox's first page, each message whole (as the client has it once opened: view `mail.message`). */
export const inbox = async (p: ReturnType<typeof player>, now: number, params: Record<string, string> = {}) => {
	const box = (await p.views(now, ['mail.inbox'], params))['mail.inbox'] as MailInbox;
	const messages: MailMessage[] = [];
	for (const m of box.messages) messages.push((await p.views(now, ['mail.message'], { mail: m.id }))['mail.message'] as MailMessage);
	return { ...box, messages };
};
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

/** The forms as the browser shows them for a context (`forms.patches` put together with the static `forms.specs`). */
export async function resolvedForms(
	ctx: EngineContext,
	params: Record<string, string>,
	kernel: Kernel = defaultKernel,
): Promise<ResolvedForm[]> {
	const patches = (await computeViews(kernel, db, ctx, ['forms.patches'], params)).views['forms.patches'] as FormPatches;
	return resolveForms(await formSpecs(kernel), patches) ?? [];
}
/** The static `forms.specs`. */
export const formSpecs = async (kernel: Kernel = defaultKernel) =>
	(await kernel.statics.find((x) => x.id === 'forms.specs')!.compute({ rules: { config: {} }, db } as never)) as FormSpecs;
