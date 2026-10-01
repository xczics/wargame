/**
 * Default equipment content (docs/design/gameplay.md §10), all numbers in ./data (CSV): five
 * slots, a base per slot and tier, five rarities. It also connects equipment to the rest:
 *   - realms: a piece of equipment is in every realm's reward pool (tier by realm, rarity rolled),
 *     and worn pieces add to the hero's adventure numbers ("adv.*" stats);
 *   - battle: "battle.attack / battle.defense" are % bonuses while the wearer leads or defends;
 *   - smelting gives a little metal;
 *   - the armory, a building that stores more of a settlement's spare gear.
 */
import { csvMap, csvNumber, csvRows, csvRules, definePlugin, numberFields, type ReadApi } from '../../kernel';
import type { AdventureStats } from '../../shared/realms';
import type { Hero } from '../heroes';
import basesCsv from './data/bases.csv?raw';
import buildingsCsv from './data/buildings.csv?raw';
import levelsCsv from './data/levels.csv?raw';
import raritiesCsv from './data/rarities.csv?raw';
import rulesCsv from './data/rules.csv?raw';
import slotsCsv from './data/slots.csv?raw';

const RULES = csvRules(rulesCsv);
const BASES = csvRows(basesCsv).map((r) => ({
	id: r.id,
	name: r.name,
	slot: r.slot,
	tier: csvNumber(r, 'tier'),
	icon: r.icon || undefined,
	stats: csvMap(r.stats),
}));
const RARITIES = csvRows(raritiesCsv).map((r) => ({
	id: r.id,
	name: r.name,
	order: csvNumber(r, 'order'),
	mult: csvNumber(r, 'mult'),
	attrs: csvNumber(r, 'attrs'),
	attrMin: csvNumber(r, 'attrMin'),
	attrMax: csvNumber(r, 'attrMax'),
	weights: [1, 2, 3, 4, 5].map((t) => csvNumber(r, `t${t}`)),
}));
const TIERS = Math.max(...BASES.map((b) => b.tier));
/** Battle % keeps a decimal; everything else is whole. */
const round = (key: string, v: number) => (key.startsWith('battle.') || key === 'adv.recovery' ? Math.round(v * 10) / 10 : Math.round(v));

export default definePlugin({
	id: 'starter-equipment',
	version: '0.1.0',
	description: 'Weapons, helms, armour, boots and charms; equipment drops in realms, adventure and battle bonuses',
	dependsOn: ['equipment', 'heroes', 'realms', 'battle', 'stats', 'settlements', 'buildings'],
	setup(ctx) {
		const equipment = ctx.services.get('equipment');
		const heroes = ctx.services.get('heroes');
		const realms = ctx.services.get('realms');
		const stats = ctx.services.get('stats');
		const settlements = ctx.services.get('settlements');
		ctx.services.get('buildings').defineFromCsv(buildingsCsv, levelsCsv);
		for (const s of csvRows(slotsCsv)) equipment.defineSlot({ id: s.id, name: s.name });
		for (const b of BASES) equipment.defineBase({ id: b.id, name: b.name, slot: b.slot, tier: b.tier, icon: b.icon });
		for (const r of RARITIES) equipment.defineRarity({ id: r.id, name: r.name, order: r.order });

		const rules = ctx.config.define('rules', {
			description:
				'drop.variance of rolled stats, smelt.metal x tier x rarity multiplier (the drop weight is tuned with realms.dropWeights).',
			default: () => RULES as Record<string, Record<string, number>>,
			parse(raw) {
				const r = (raw ?? {}) as Record<string, unknown>;
				return {
					drop: numberFields(() => RULES.drop as Record<string, number>, 0, 1e6)(r.drop ?? {}),
					smelt: numberFields(() => RULES.smelt as Record<string, number>, 0, 1e9)(r.smelt ?? {}),
				};
			},
		});
		const mult = new Map(RARITIES.map((r) => [r.id, r.mult]));
		equipment.setSmeltValue((api, p) => ({ metal: Math.round(rules.get(api).smelt.metal * p.tier * (mult.get(p.rarity) ?? 1)) }));

		/* ----- drops in realms ------------------------------------------------------------- */

		const pick = <T>(list: T[], weight: (x: T) => number, random: () => number) => {
			const total = list.reduce((a, x) => a + weight(x), 0);
			let at = random() * total;
			for (const x of list) if ((at -= weight(x)) < 0) return x;
			return list[list.length - 1];
		};
		// One drop per rarity, weighted by the realm's tier, so a rare piece shows as a rare drop.
		const tierOf = (order: number) => Math.min(TIERS, Math.max(1, Math.ceil(order / 2)));
		for (const rarity of RARITIES) {
			realms.addDrop({
				id: `starter-equipment.${rarity.id}`,
				// GM: tune it with realms.dropWeights like any other drop.
				weight: (realm) => {
					const weights = RARITIES.map((r) => r.weights[tierOf(realm.order) - 1] ?? 0);
					const total = weights.reduce((a, b) => a + b, 0);
					return total ? ((RULES.drop.weight as number) * (rarity.weights[tierOf(realm.order) - 1] ?? 0)) / total : 0;
				},
				preview: { kind: 'equipment', name: 'Equipment', icon: '🎁', rarity: rarity.id },
				async give(api, c) {
					const tier = tierOf(c.realm.order);
					const base = pick(
						BASES.filter((b) => b.tier === tier),
						() => 1,
						c.random,
					);
					const variance = rules.get(api).drop.variance;
					const rolled: Record<string, number> = {};
					for (const [k, v] of Object.entries(base.stats))
						rolled[k] = round(k, v * rarity.mult * (1 - variance + 2 * variance * c.random()));
					const attrs = heroes.attributes();
					for (let i = 0; i < rarity.attrs && attrs.length; i++) {
						const a = `attr.${attrs[Math.floor(c.random() * attrs.length)].id}`;
						rolled[a] = (rolled[a] ?? 0) + Math.round((rarity.attrMin + c.random() * (rarity.attrMax - rarity.attrMin)) * tier);
					}
					const piece = await equipment.create(api, c.playerId, c.hero.home, { base: base.id, rarity: rarity.id, stats: rolled });
					return [{ kind: 'equipment', name: base.name, icon: base.icon, rarity: rarity.id, ...(piece ? {} : { lost: true }) }];
				},
			});
		}

		/* ----- what worn pieces do ------------------------------------------------------------ */

		const sum = async (api: ReadApi, hero: Hero, prefix: string) => {
			const out: Record<string, number> = {};
			for (const p of await equipment.worn(api, hero.id))
				for (const [k, v] of Object.entries(p.stats))
					if (k.startsWith(prefix)) out[k.slice(prefix.length)] = (out[k.slice(prefix.length)] ?? 0) + v;
			return out;
		};
		realms.addHeroStats(async (api, hero) => (await sum(api, hero, 'adv.')) as Partial<AdventureStats>);

		// Battle: the heroes leading the army (duty "command") or defending the settlement.
		ctx.services.get('battle').addModifier(async (api, side) => {
			let group: Hero[] = [];
			if (side.role === 'attacker' && side.armyId) group = await heroes.onDuty(api, 'command', side.armyId);
			else if (side.role === 'defender' && side.settlement?.ownerId)
				group = await heroes.defenders(
					api,
					side.settlement.id,
					await stats.get(api, 'heroes.defenders', settlements.entity(side.settlement.id)),
				);
			const total: Record<string, number> = {};
			for (const h of group) for (const [k, v] of Object.entries(await sum(api, h, 'battle.'))) total[k] = (total[k] ?? 0) + v;
			return Object.entries(total)
				.filter(([k, v]) => v && (k === 'attack' || k === 'defense'))
				.map(([k, v]) => ({ source: 'Equipment', stat: k as 'attack' | 'defense', percent: Math.round(v * 10) / 10 }));
		});
	},
});
