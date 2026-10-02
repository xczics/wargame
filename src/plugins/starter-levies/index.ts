/**
 * Levy orders (docs/design/gameplay.md §2.5): training units of tiers 2-4 needs quota, one per
 * unit, which "<unit> Levy Order" items give (./data/levies.csv: how much, price, where they drop).
 * Quota is spent when training is ordered and never comes back. Units come from the troops
 * plugin by tier (whatever families content defines); the orders are sold in the coupon shop,
 * drop in realms (each family on its own tasks, ./data/tasks.csv) and show up on the entries of the buildings that train their unit.
 */
import { csvNumber, csvRows, definePlugin, type EngineApi, fields, gameErrors, type ReadApi, shape } from '../../kernel';
import banditsCsv from './data/bandits.csv?raw';
import familiesCsv from './data/families.csv?raw';
import leviesCsv from './data/levies.csv?raw';
import tasksCsv from './data/tasks.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { keyText, uiTexts } from '../../shared/i18n';

const fail = gameErrors('starter-levies');
const text = uiTexts('starter-levies');

const LEVIES = new Map(
	csvRows(leviesCsv).map((r) => [
		csvNumber(r, 'tier'),
		{
			quota: csvNumber(r, 'quota'),
			price: csvNumber(r, 'price'),
			dropWeight: csvNumber(r, 'dropWeight'),
			from: csvNumber(r, 'from'),
			to: csvNumber(r, 'to'),
		},
	]),
);
const itemId = (unit: string) => `levy-${unit}`;
/** Families dropping in each task of realm 1 (later realms shift it along; ./data/tasks.csv). */
const PATTERN = csvRows(tasksCsv).map((r) => new Set(r.families.split(';').map((f) => f.trim())));
const BANDIT_DROPS = new Map(
	csvRows(banditsCsv).map((r) => [csvNumber(r, 'tier'), { weight: csvNumber(r, 'weight'), fromLevel: csvNumber(r, 'fromLevel') }]),
);
const FAMILY_WEIGHT = new Map(csvRows(familiesCsv).map((r) => [r.family, csvNumber(r, 'weight')]));
/** Does `family` drop in `task` (0-based) of the realm with this order? */
function dropsIn(family: string, order: number, task: number) {
	if (!PATTERN.some((s) => s.has(family))) return true;
	const n = PATTERN.length;
	return PATTERN[(((task - (order - 1)) % n) + n) % n].has(family);
}

export default definePlugin({
	id: 'starter-levies',
	version: '0.1.0',
	description: 'Levy orders: quota for training tier 2-4 units',
	// After the army content: its units must be defined to get their orders.
	dependsOn: ['troops', 'items', 'shop', 'realms', 'bandits', 'starter-army', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const troops = ctx.services.get('troops');
		const items = ctx.services.get('items');
		const shop = ctx.services.get('shop');
		const realms = ctx.services.get('realms');
		const bandits = ctx.services.get('bandits');

		const loadQuota = (api: ReadApi, playerId: string, unit: string) =>
			api.memo(`starter-levies:${playerId}:${unit}`, async () => ({
				quota:
					(
						await api.db
							.prepare('SELECT quota FROM starter_levies_quota WHERE player_id = ? AND unit = ?')
							.bind(playerId, unit)
							.first<{ quota: number }>()
					)?.quota ?? 0,
			}));
		const save = (api: EngineApi, playerId: string, unit: string, quota: number) =>
			api.write(
				api.db
					.prepare(
						'INSERT INTO starter_levies_quota (player_id, unit, quota) VALUES (?, ?, ?) ON CONFLICT (player_id, unit) DO UPDATE SET quota = excluded.quota',
					)
					.bind(playerId, unit, quota),
			);
		const levyOf = (unit: { tier?: number; family?: string }) => (unit.family && unit.tier ? LEVIES.get(unit.tier) : undefined);

		troops.addTrainingRequirement({
			async check(api, s, unit, count) {
				if (!levyOf(unit) || !s.ownerId) return null;
				const { quota } = await loadQuota(api, s.ownerId, unit.id);
				return quota >= count ? null : text('Needs levy quota: {0} left (use a {1} Levy Order)', { 0: quota, 1: keyText(unit.name) });
			},
			async consume(api, s, unit, count) {
				if (!levyOf(unit) || !s.ownerId) return;
				const q = await loadQuota(api, s.ownerId, unit.id);
				q.quota -= count;
				save(api, s.ownerId, unit.id, q.quota);
			},
		});

		// One order per levied unit; the unit list is complete once content plugins have run, so this
		// is set up for every unit with a tier that has a levy row.
		for (const unit of troops.list()) {
			const levy = levyOf(unit);
			if (!levy) continue;
			const id = itemId(unit.id);
			const orderName = ctx.services.get('i18n').derive(`item:${id}`, text('{0} Levy Order', { 0: keyText(unit.name) }));
			items.define<null>({
				id,
				name: orderName,
				icon: '📜',
				category: 'levies',
				description: ctx.services.get('i18n').derive(
					`item-description:${id}`,
					text('Adds {0} to how many {1} you may train. Spent when training is ordered; not returned.', {
						0: levy.quota,
						1: keyText(unit.name),
					}),
				),
				...(unit.trainedAt ? { shortcuts: [`building:${unit.trainedAt}`] } : {}),
				use: {
					parse: () => null,
					async apply(api) {
						const q = await loadQuota(api, api.playerId, unit.id);
						q.quota += levy.quota;
						save(api, api.playerId, unit.id, q.quota);
					},
					form: {
						title: text('Use: {0} Levy Order', { 0: keyText(unit.name) }),
						fields: [],
						submitLabel: text('Use'),
						async prepare(api) {
							return { description: text('Quota now: {0}', { 0: (await loadQuota(api, api.playerId, unit.id)).quota }) };
						},
					},
				},
			});
			shop.defineOffer({ id, item: id, count: 1, price: levy.price, category: 'levies', dailyLimit: 0 });
			realms.addDrop({
				id,
				weight: levy.dropWeight * (FAMILY_WEIGHT.get(unit.family!) ?? 1),
				where: (realm, task) => levy.from <= realm.order && realm.order <= levy.to && dropsIn(unit.family!, realm.order, task),
				preview: { kind: 'item', name: orderName, icon: '📜' },
				async give(api, c) {
					await items.grant(api, c.playerId, id, 1);
					return [{ kind: 'item', name: orderName, icon: '📜', count: 1 }];
				},
			});
			items.addSource(id, 'realms');
			// Beaten bandits: orders for the families they fight with, higher tiers from stronger bands.
			const fromBandits = BANDIT_DROPS.get(unit.tier!);
			if (fromBandits)
				bandits.addDrop({
					id: `starter-levies.${id}`,
					weight: (kind, level) => {
						const total = Object.values(kind.families).reduce((a, b) => a + b, 0);
						return level >= fromBandits.fromLevel && total ? (fromBandits.weight * (kind.families[unit.family!] ?? 0)) / total : 0;
					},
					async give(api, c) {
						await items.grant(api, c.playerId, id, 1);
						return [{ kind: 'item', name: orderName, icon: '📜', count: 1 }];
					},
				});
		}

		ctx.commands.add<{ unit: string; quota: number }>({
			type: 'starter-levies.grant',
			privileged: true,
			description: 'Add (or with a negative amount, remove) levy quota. Payload: { "unit": "infantry-2", "quota": 1000 }',
			parse: shape({ unit: fields.id(), quota: fields.int(-1e9, 1e9) }),
			async execute(api, { unit, quota }) {
				const def = troops.get(unit);
				if (!def || !levyOf(def)) throw fail('bad_payload', 'That unit needs no levy');
				const q = await loadQuota(api, api.playerId, unit);
				q.quota = Math.max(0, q.quota + quota);
				save(api, api.playerId, unit, q.quota);
			},
		});
	},
});
