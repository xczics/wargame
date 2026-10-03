/**
 * Auxiliary units (docs/design/gameplay.md §3.10), trained at the supply depot; numbers in ./data:
 *   - field surgeons save part of their side's fallen (a casualty hook on the final losses);
 *   - supply trains carry a lot;
 *   - carts carry the army's slowest units, which then march at the cart's speed (a pace modifier).
 * They have no family, so the battle keeps them out of the lanes. Upkeep includes currency.
 */
import { csvMap, csvNumber, csvRows, csvRules, definePlugin, numberFields, PluginError } from '../../kernel';
import buildingsCsv from './data/buildings.csv?raw';
import levelsCsv from './data/levels.csv?raw';
import rulesCsv from './data/rules.csv?raw';
import unitsCsv from './data/units.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { keyText, uiTexts } from '../../shared/i18n';

const text = uiTexts('starter-auxiliary');

const RULES = csvRules(rulesCsv);
const UNITS = csvRows(unitsCsv).map((r) => {
	if (!['medic', 'supply', 'cart'].includes(r.role)) throw new PluginError(`units.csv: unknown role "${r.role}" (${r.id})`);
	return {
		id: r.id,
		name: r.name,
		icon: r.icon || undefined,
		role: r.role as 'medic' | 'supply' | 'cart',
		depot: csvNumber(r, 'depot'),
		carts: csvNumber(r, 'carts', 0),
		speed: csvNumber(r, 'speed'),
		carry: csvNumber(r, 'carry'),
		cost: csvMap(r.cost),
		seconds: csvNumber(r, 'seconds'),
		upkeep: Object.fromEntries(Object.entries(csvMap(r.upkeep)).map(([k, v]) => [k, v / 3600])),
	};
});
const DEPOT = 'supply-depot';

export default definePlugin({
	id: 'starter-auxiliary',
	version: '0.1.0',
	description: 'Field surgeons, supply trains and carts, trained at the supply depot',
	dependsOn: ['troops', 'battle', 'armies', 'buildings', 'stats', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const troops = ctx.services.get('troops');
		const buildings = ctx.services.get('buildings');
		buildings.defineFromCsv(buildingsCsv, levelsCsv);
		const rules = ctx.config.define('rules', {
			description: 'medic.save: fallen saved per field surgeon; medic.cap: at most this share of the losses.',
			default: () => RULES as Record<string, Record<string, number>>,
			parse: (raw) => ({
				medic: numberFields(() => RULES.medic as Record<string, number>, 0, 1e6)((raw as { medic?: unknown } | null)?.medic ?? {}),
			}),
		});

		for (const u of UNITS)
			troops.define({
				id: u.id,
				name: u.name,
				icon: u.icon,
				trainedAt: DEPOT,
				stats: { attack: 0, defense: 0, hp: 1, speed: u.speed, carry: u.carry, cost: u.cost, seconds: u.seconds, upkeep: u.upkeep },
			});
		const need = new Map(UNITS.map((u) => [u.id, u.depot]));
		troops.addTrainingGate(async (api, s, unit) => {
			const level = need.get(unit.id);
			if (level === undefined) return null;
			return (await buildings.level(api, s.id, DEPOT)) >= level
				? null
				: text('Requires {0} Lv {1}', { 0: keyText(buildings.get(DEPOT).name), 1: level });
		});

		// Field surgeons: a share of the fallen walk home after all.
		// Their own march speed, which others raise (e.g. research: percent on `starter-auxiliary.speed`).
		const stats = ctx.services.get('stats');
		stats.define({ id: 'starter-auxiliary.speed', description: 'auxiliary march speed', base: () => 1, min: 0 });
		const ours = new Set(UNITS.map((u) => u.id));
		ctx.services
			.get('armies')
			.addSpeedModifier(async (api, playerId, unit) =>
				ours.has(unit.id) ? stats.get(api, 'starter-auxiliary.speed', `player:${playerId}`) : 1,
			);

		const medics = UNITS.filter((u) => u.role === 'medic').map((u) => u.id);
		ctx.services.get('battle').addCasualtyHook({
			source: text('Field surgeons'),
			async final(api, { units, losses }) {
				const surgeons = medics.reduce((sum, id) => sum + (units[id] ?? 0), 0);
				const total = Object.values(losses).reduce((a, b) => a + b, 0);
				if (!surgeons || !total) return null;
				const { save, cap } = rules.get(api).medic;
				const ratio = Math.min(cap, (surgeons * save) / total);
				const out: Record<string, number> = {};
				for (const [u, n] of Object.entries(losses)) out[u] = n - Math.floor(n * ratio);
				return out;
			},
		});

		// Carts: the fastest carts take the slowest units (not other carts), who then go at the cart's speed.
		const carts = new Map(UNITS.filter((u) => u.role === 'cart').map((u) => [u.id, u.carts]));
		ctx.services.get('armies').addPaceModifier(async (_api, units, speedOf) => {
			const fleet = [...carts.keys()]
				.filter((id) => units[id])
				.map((id) => ({ speed: speedOf(id), seats: carts.get(id)! * units[id] }))
				.sort((a, b) => b.speed - a.speed);
			if (!fleet.length) return null;
			const walkers = Object.entries(units)
				.filter(([id, n]) => n > 0 && !carts.has(id))
				.map(([id, n]) => ({ speed: speedOf(id), n }))
				.sort((a, b) => a.speed - b.speed);
			let pace = Math.min(...fleet.map((c) => c.speed));
			let c = 0;
			for (const w of walkers) {
				let left = w.n;
				// Only worth a seat when the cart is faster.
				while (left > 0 && c < fleet.length && fleet[c].speed > w.speed) {
					const take = Math.min(left, fleet[c].seats);
					left -= take;
					fleet[c].seats -= take;
					pace = Math.min(pace, fleet[c].speed);
					if (!fleet[c].seats) c++;
				}
				if (left > 0) pace = Math.min(pace, w.speed);
			}
			return pace;
		});
	},
});
