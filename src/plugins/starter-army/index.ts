/**
 * Default army content (docs/design/gameplay.md §2): unit families with six tiers each, their
 * numbers computed from GM-tunable formulas, and the barracks that train them. The data —
 * families, counters, formula parameters, resource shares, barracks — is in ./data (CSV).
 *
 * This plugin is what connects the troop system to the building and battle systems: the
 * troops plugin knows nothing about barracks, and the buildings plugin nothing about troops.
 *
 * - Attributes: tier 1 = base, specialty ×specialty; tier 2 = ×tier2, specialty ×tier2Specialty
 *   more; later tiers compound ×growth (specialty ×specialtyGrowth).
 * - Training cost, upkeep and time follow r = total attributes / tier-1 total: cost ∝ r^1.2
 *   (twice the strength costs more than twice), upkeep ∝ r^0.8 (less than twice), time ∝ r^1.3.
 * - Each family has its own barracks. Its level decides the highest tier it trains, and
 *   shortens training time at the same cost; the top tiers come only from battle.
 */
import { csvNumber, csvRows, csvRules, definePlugin, numberFields, numberInRange, PluginError, recordOf, type ReadApi } from '../../kernel';
import type { UnitStats } from '../troops';
import buildingsCsv from './data/buildings.csv?raw';
import countersCsv from './data/counters.csv?raw';
import familiesCsv from './data/families.csv?raw';
import levelsCsv from './data/levels.csv?raw';
import rulesCsv from './data/rules.csv?raw';
import sharesCsv from './data/shares.csv?raw';

interface Family {
	id: string;
	name: string;
	icon: string;
	specialty: 'attack' | 'defense' | 'hp';
	/** Upkeep resource whose shortage makes these units drop a tier. */
	downgradeOn: string;
	barracks: string;
	/** Moves at the mounted (cavalry) speeds. */
	mounted: boolean;
}

const FAMILIES: Family[] = csvRows(familiesCsv).map((r) => {
	if (!['attack', 'defense', 'hp'].includes(r.specialty))
		throw new PluginError(`Family "${r.id}": specialty must be attack, defense or hp`);
	return {
		id: r.id,
		name: r.name,
		icon: r.icon,
		specialty: r.specialty as Family['specialty'],
		downgradeOn: r.downgradeOn,
		barracks: r.barracks,
		mounted: r.mounted === 'yes',
	};
});
const RULES = csvRules(rulesCsv);
const TIERS = Array.from({ length: RULES.tiers.count }, (_, i) => i + 1);
/** Resource shares (%) by kind ("cost" / "upkeep") and family. */
const SHARES: Record<string, Record<string, Record<string, number>>> = {};
for (const row of csvRows(sharesCsv)) {
	const { kind, family, ...cells } = row;
	(SHARES[kind] ??= {})[family] = Object.fromEntries(
		Object.entries(cells)
			.filter(([, v]) => v !== '')
			.map(([r]) => [r, csvNumber(row, r)]),
	);
}

export default definePlugin({
	id: 'starter-army',
	version: '0.2.0',
	description: 'Infantry, archers and cavalry in six tiers; their three barracks',
	dependsOn: ['troops', 'buildings', 'resources', 'battle'],
	setup(ctx) {
		const troops = ctx.services.get('troops');
		const buildings = ctx.services.get('buildings');
		const resources = ctx.services.get('resources');
		const battle = ctx.services.get('battle');

		/** One GM-tunable group of rules.csv (e.g. "attributes"), partial overrides merged over the file. */
		const rules = <K extends string>(group: K, description: string, min = 0) =>
			ctx.config.define(group, {
				description,
				default: () => RULES[group] as Record<string, number>,
				parse: numberFields(() => RULES[group], min),
			});
		const attributes = rules(
			'attributes',
			'Unit attributes: base (tier 1), specialty (tier-1 bonus on the family specialty), tier2 (×), tier2Specialty (extra × on the specialty), growth / specialtyGrowth (× per tier from tier 3).',
		);
		const speed = rules(
			'speed',
			'Marching speed in tiles per hour: base (foot units, every tier), cavalry1 (× for tier-1 mounted units), cavalryGrowth (× per mounted tier).',
			0.001,
		);
		const carry = rules('carry', 'Loot per unit = base × tier × family factor.');
		const training = rules(
			'training',
			'Per unit, with r = total attributes relative to tier 1: total cost = cost × r^costExponent; seconds = seconds × r^timeExponent (before barracks level).',
		);
		const upkeep = rules('upkeep', 'Upkeep per unit per hour (all resources together) = perHour × r^exponent.');
		const speedUp = rules(
			'barracksSpeed',
			'Training time by barracks level: each level up to linearUntil takes off `step` (additive), each level after multiplies by `factor`.',
		);
		const unlock = rules('barracksLevels', 'Barracks level needed to train each tier (tierN); tiers without a row are never trained.');

		const shares = (kind: 'cost' | 'upkeep') =>
			ctx.config.define(`${kind}Shares`, {
				description: `How the ${kind === 'cost' ? 'training cost' : 'upkeep'} splits over resources, in % per family (partial: only the families given are replaced).`,
				default: () => SHARES[kind],
				parse: (raw) => ({
					...SHARES[kind],
					...recordOf(
						() => FAMILIES.map((f) => f.id),
						recordOf(
							() => resources.list().map((r) => r.id),
							(v) => numberInRange(0, 100)(v),
						),
					)(raw),
				}),
			});
		const costShares = shares('cost');
		const upkeepShares = shares('upkeep');

		/** Attack / defense / hp of one unit. */
		function attrs(api: ReadApi, family: Family, tier: number) {
			const a = attributes.get(api);
			const one = (special: boolean) => {
				let v = a.base * (special ? a.specialty : 1);
				if (tier >= 2) v *= a.tier2 * (special ? a.tier2Specialty : 1);
				for (let t = 3; t <= tier; t++) v *= special ? a.specialtyGrowth : a.growth;
				return v;
			};
			return {
				attack: one(family.specialty === 'attack'),
				defense: one(family.specialty === 'defense'),
				hp: one(family.specialty === 'hp'),
			};
		}
		const total = (x: { attack: number; defense: number; hp: number }) => x.attack + x.defense + x.hp;
		const split = (amount: number, pct: Record<string, number>, round: boolean) =>
			Object.fromEntries(
				Object.entries(pct)
					.filter(([, p]) => p > 0)
					.map(([r, p]) => [r, round ? Math.round((amount * p) / 100) : (amount * p) / 100]),
			);

		function unitStats(api: ReadApi, family: Family, tier: number): UnitStats {
			const own = attrs(api, family, tier);
			// Families have the same total at every tier, so r is the same for all of them.
			const r = total(own) / total(attrs(api, family, 1));
			const tr = training.get(api);
			const up = upkeep.get(api);
			const sp = speed.get(api);
			return {
				...own,
				speed: family.mounted ? sp.base * sp.cavalry1 * sp.cavalryGrowth ** (tier - 1) : sp.base,
				carry: carry.get(api).base * tier * (carry.get(api)[family.id] ?? 1),
				cost: split(tr.cost * r ** tr.costExponent, costShares.get(api)[family.id] ?? {}, true),
				seconds: tr.seconds * r ** tr.timeExponent,
				upkeep: split((up.perHour * r ** up.exponent) / 3600, upkeepShares.get(api)[family.id] ?? {}, false),
			};
		}

		// Battle lanes, and who beats whom.
		for (const f of FAMILIES) battle.defineFamily({ id: f.id, name: f.name, icon: f.icon });
		for (const c of csvRows(countersCsv)) battle.addCounter(c.strong, c.weak);

		for (const family of FAMILIES) {
			for (const tier of TIERS) {
				troops.define({
					id: `${family.id}-${tier}`,
					name: `${family.name} (Lv ${tier})`,
					icon: family.icon,
					family: family.id,
					tier,
					trainable: tier <= RULES.tiers.trainable,
					stats: (api) => unitStats(api, family, tier),
				});
			}
		}
		const ours = (unit: { family?: string }) => FAMILIES.find((f) => f.id === unit.family);

		// Short of their special upkeep (e.g. infantry: metal for gear) units drop a tier; any
		// other shortage (food, pay) makes them rout — the troops plugin's default.
		troops.addShortageRule((unit, resource) => (ours(unit)?.downgradeOn === resource ? 'downgrade' : null));

		buildings.defineFromCsv(buildingsCsv, levelsCsv);
		troops.addTrainingGate(async (api, s, unit) => {
			const family = ours(unit);
			if (!family) return null; // someone else's unit
			const need = unlock.get(api)[`tier${unit.tier}`];
			if (need === undefined) return null;
			return (await buildings.level(api, s.id, family.barracks)) >= need ? null : `Requires ${buildings.get(family.barracks).name} ${need}`;
		});
		troops.addTrainingTimeModifier(async (api, s, unit) => {
			const family = ours(unit);
			if (!family) return 1;
			const level = Math.max(1, await buildings.level(api, s.id, family.barracks));
			const { step, linearUntil, factor } = speedUp.get(api);
			const linear = Math.max(0.01, 1 - step * (Math.min(level, linearUntil) - 1));
			return linear * factor ** Math.max(0, level - linearUntil);
		});
	},
});
