/**
 * Default hero content (docs/design/gameplay.md §5), all numbers in ./data (CSV): the six
 * attributes, the tavern / academy / music house where heroes are recruited (attribute ranges,
 * which attribute stands out, gender, rarity, cost), how many candidates a building offers and
 * how often, and the name lists (with how each part is written in each language).
 *
 * Name parts are stored as keys ("s:Zhao", "m:Zilong"); the client joins their spelling for
 * its language (meta `heroNames`), so equal pinyin in different lists never mix up.
 */
import {
	csvMap,
	csvNumber,
	csvRows,
	csvRules,
	definePlugin,
	derive,
	type EngineApi,
	fields,
	gameErrors,
	numberFields,
	numberInRange,
	PluginError,
	type ReadApi,
	type RuleView,
	shape,
	derivedKind,
} from '../../kernel';
import type { HeroPost } from '../../shared/api';
import { dutyEffects, type HeroEffectRow, type HeroEffectRules, type HeroEffectsStatic, rowPercent } from '../../shared/starter-heroes';
import type { Hero, HeroDraft } from '../heroes';
import attributesCsv from './data/attributes.csv?raw';
import buildingsCsv from './data/buildings.csv?raw';
import femaleCsv from './data/given-f.csv?raw';
import maleCsv from './data/given-m.csv?raw';
import levelsCsv from './data/levels.csv?raw';
import rangesCsv from './data/ranges.csv?raw';
import rulesCsv from './data/rules.csv?raw';
import dutiesCsv from './data/duties.csv?raw';
import battleFlatCsv from './data/battle-flat.csv?raw';
import effectsCsv from './data/effects.csv?raw';
import surnamesCsv from './data/surnames.csv?raw';
import talentsCsv from './data/talents.csv?raw';
import venuesCsv from './data/venues.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { keyText, uiTexts } from '../../shared/i18n';

// Its derived values (`api.derived`): key prefix and shape version, one place for every path.
const COMMANDERS = derivedKind('starter-heroes:commanders', 0);

const fail = gameErrors('starter-heroes');
const text = uiTexts('starter-heroes');

const RULES = csvRules(rulesCsv);
const ATTRIBUTES = csvRows(attributesCsv);
const DUTIES = csvRows(dutiesCsv);
/** Name lists: keys with a list prefix, and their spelling by locale. */
const names = (prefix: string, csv: string) => csvRows(csv).map((r) => ({ key: `${prefix}:${r.key}`, en: r.en, zh: r.zh }));
const SURNAMES = names('s', surnamesCsv);
const GIVEN = { m: names('m', maleCsv), f: names('f', femaleCsv) };

function range(cell: string, where: string): [number, number] {
	const [min, max] = cell.split('-').map(Number);
	if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) throw new PluginError(`${where}: bad range "${cell}"`);
	return [min, max];
}

/** Talent totals and their weights, by venue (./data/talents.csv). */
const TALENTS: Record<string, Record<string, number>> = {};
for (const r of csvRows(talentsCsv)) (TALENTS[r.venue] ??= {})[r.points] = csvNumber(r, 'weight');

const VENUES = csvRows(venuesCsv).map((r) => {
	if (r.gender !== 'm' && r.gender !== 'f') throw new PluginError(`Venue "${r.id}": gender must be m or f`);
	return {
		id: r.id,
		name: r.name,
		building: r.building,
		gender: r.gender as 'm' | 'f',
		chance: csvNumber(r, 'chance'),
		slots: csvNumber(r, 'slots'),
		maxSlots: csvNumber(r, 'maxSlots'),
		cost: csvMap(r.cost),
		emphasis: r.emphasis ? r.emphasis.split(';').map((a) => a.trim()) : [],
		stunt: csvNumber(r, 'stunt', 0),
		talentMin: csvNumber(r, 'talentMin', 0),
		talentMax: r.talentMax ? csvNumber(r, 'talentMax') : Infinity,
	};
});
/** [min, max] of each attribute, by venue. */
const RANGES: Record<string, Record<string, [number, number]>> = Object.fromEntries(
	csvRows(rangesCsv).map(({ venue, ...cells }) => [
		venue,
		Object.fromEntries(Object.entries(cells).map(([attr, cell]) => [attr, range(cell, `ranges.csv (${venue}, ${attr})`)])),
	]),
);

export default definePlugin({
	id: 'starter-heroes',
	version: '0.1.0',
	description: 'Tavern, academy and music house; hero attributes, names and rolls',
	dependsOn: [
		'heroes',
		'buildings',
		'settlements',
		'resources',
		'stats',
		'troops',
		'research',
		'armies',
		'battle',
		'realms',
		'timeline',
		'i18n',
		'ui',
	],
	setup(ctx) {
		// Other plugins' tables, for the lists below that name what is read on the way (not their names).
		const TIMELINE = ctx.tablesOf('timeline');
		const RESOURCES = ctx.tablesOf('resources');
		// Texts shown in this plugin's own views (names from its tables) are its i18n keys.
		const own = ctx.services.get('i18n').scope();
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const heroes = ctx.services.get('heroes');
		const buildings = ctx.services.get('buildings');
		const settlements = ctx.services.get('settlements');
		const resources = ctx.services.get('resources');
		const stats = ctx.services.get('stats');
		buildings.defineFromCsv(buildingsCsv, levelsCsv);
		for (const a of ATTRIBUTES) heroes.defineAttribute({ id: a.id, name: a.name });

		const offer = ctx.config.define('offer', {
			description:
				'Candidates per venue: one more slot every levelsPerSlot building levels (up to the venue maximum); refresh every hours, minus hoursPerLevel per level above 1, at least minHours.',
			default: () => RULES.offer as Record<string, number>,
			parse: numberFields(() => RULES.offer),
		});
		const levelFactor = ctx.config.define('levelFactor', {
			description:
				"Candidates' attributes by the venue building's level when they came: first at level 1, evenly to at10 at level 10 and to at20 at level 20, then times growth a level.",
			default: () => RULES.levelFactor as Record<string, number>,
			parse: numberFields(() => RULES.levelFactor, 0, 100),
		});
		/** The multiplier of a candidate's attributes at a building level. */
		const factorAt = (api: ReadApi, level: number) => {
			const f = levelFactor.get(api);
			if (level <= 1) return f.first;
			if (level <= 10) return f.first + ((f.at10 - f.first) * (level - 1)) / 9;
			if (level <= 20) return f.at10 + ((f.at20 - f.at10) * (level - 10)) / 10;
			return f.at20 * f.growth ** (level - 20);
		};
		const ranges = ctx.config.define('ranges', {
			description: 'Attribute ranges [min, max] by venue and attribute (partial overrides allowed).',
			default: () => RANGES,
			parse(raw) {
				if (typeof raw !== 'object' || raw === null) throw fail('bad_config', 'Expected { venue: { attribute: [min, max] } }');
				const out = structuredClone(RANGES);
				for (const [venue, attrs] of Object.entries(raw)) {
					if (!out[venue]) throw fail('bad_config', text('Unknown venue "{0}"', { 0: venue }));
					for (const [attr, r] of Object.entries(attrs as Record<string, unknown>)) {
						if (!out[venue][attr]) throw fail('bad_config', text('Unknown attribute "{0}"', { 0: attr }));
						if (!Array.isArray(r) || r.length !== 2 || !r.every((n) => typeof n === 'number' && n >= 0) || r[0] > r[1])
							throw fail('bad_config', text('{0}.{1}: expected [min, max]', { 0: venue, 1: attr }));
						out[venue][attr] = [r[0], r[1]];
					}
				}
				return out;
			},
		});

		const talentRule = ctx.config.define('talents', {
			description:
				'Talent totals by venue and their weights (higher = rarer): { venue: { "<points>": weight } } (a venue given replaces its table).',
			default: () => TALENTS,
			parse(raw) {
				if (typeof raw !== 'object' || raw === null) throw fail('bad_config', 'Expected { venue: { points: weight } }');
				const out = structuredClone(TALENTS);
				for (const [venue, table] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
					if (!out[venue]) throw fail('bad_config', text('Unknown venue "{0}"', { 0: venue }));
					out[venue] = Object.fromEntries(
						Object.entries(table ?? {}).map(([pts, w]) => {
							if (!/^\d+$/.test(pts)) throw fail('bad_config', text('{0}: "{1}" is not a number of points', { 0: venue, 1: pts }));
							return [pts, numberInRange(0, 1e6)(w)];
						}),
					);
				}
				return out;
			},
		});
		/** Total by the venue's weights, then point by point to attributes weighted by the venue's ranges. */
		function rollTalents(api: ReadApi, venue: string, random: () => number) {
			const table = Object.entries(talentRule.get(api)[venue] ?? { 3: 1 }).map(([p, w]) => ({ p: Number(p), w }));
			const total = table.reduce((a, x) => a + x.w, 0);
			let at = random() * total;
			let points = table[table.length - 1].p;
			for (const x of table)
				if ((at -= x.w) < 0) {
					points = x.p;
					break;
				}
			// The venue's bounds per attribute (the music house: 1-3 each): the least first, then the rest at random among those
			// below the most, every attribute alike; unbounded venues lean the way their attribute ranges do.
			const { talentMin: least, talentMax: most } = VENUES.find((v) => v.id === venue) ?? { talentMin: 0, talentMax: Infinity };
			const weights = Object.entries(ranges.get(api)[venue] ?? {}).map(([a, [min, max]]) => ({
				a,
				w: Number.isFinite(most) ? 1 : (min + max) / 2,
			}));
			const out: Record<string, number> = {};
			if (least > 0) for (const x of weights) out[x.a] = least;
			points = Math.min(points, weights.length * most);
			for (let i = weights.length * least; i < points; i++) {
				const open = weights.filter((x) => (out[x.a] ?? 0) < most);
				let r = random() * open.reduce((a, x) => a + x.w, 0);
				const hit = open.find((x) => (r -= x.w) < 0) ?? open[open.length - 1];
				out[hit.a] = (out[hit.a] ?? 0) + 1;
			}
			return out;
		}

		for (const v of VENUES) {
			heroes.defineVenue({
				id: v.id,
				name: v.name,
				building: v.building,
				offer(api, level) {
					const o = offer.get(api);
					const count = Math.min(v.maxSlots, v.slots + Math.floor((level - 1) / Math.max(1, o.levelsPerSlot)));
					const hours = Math.max(o.minHours, o.hours - o.hoursPerLevel * (level - 1));
					return { count, seconds: hours * 3600 };
				},
				draft(api, random, _slot, level): HeroDraft | null {
					if (random() >= v.chance) return null; // rare venues often have nobody
					const attrs: Record<string, number> = {};
					for (const [attr, [min, max]] of Object.entries(ranges.get(api)[v.id] ?? {}))
						attrs[attr] = Math.round(min + random() * (max - min));
					// Every hero stands out somewhere: one emphasised attribute near its maximum...
					if (v.emphasis.length) {
						const a = v.emphasis[Math.floor(random() * v.emphasis.length)];
						const [, max] = ranges.get(api)[v.id][a];
						attrs[a] = Math.max(attrs[a], Math.round(max - random() * 5));
					}
					// ...and at the music house one "stunt" attribute may break through 100.
					if (v.stunt) {
						const keys = Object.keys(attrs);
						const a = keys[Math.floor(random() * keys.length)];
						attrs[a] = Math.max(attrs[a], Math.round(100 + random() * (v.stunt - 100)));
					}
					// The building's level when this round came: better candidates at higher levels.
					const factor = factorAt(api, level);
					for (const a of Object.keys(attrs)) attrs[a] = Math.max(1, Math.round(attrs[a] * factor));
					const given = GIVEN[v.gender];
					return {
						surname: SURNAMES[Math.floor(random() * SURNAMES.length)].key,
						given: given[Math.floor(random() * given.length)].key,
						gender: v.gender,
						attrs,
						talents: rollTalents(api, v.id, random),
					};
				},
				cost: () => v.cost,
			});
		}

		/* ----- duties and their effects ------------------------------------------------ */

		const limits = ctx.config.define('limits', {
			description: 'Most heroes per target on each duty, before bonuses (stats heroes.governors, heroes.scholars, ...).',
			default: () => RULES.limits as Record<string, number>,
			parse: numberFields(() => RULES.limits, 0, 1000),
		});
		for (const [key, statId] of [
			['governors', 'heroes.governors'],
			['scholars', 'heroes.scholars'],
			['commanders', 'heroes.commanders'],
			['defenders', 'heroes.defenders'],
		] as const)
			stats.define({ id: statId, description: `hero ${key}`, base: (api) => limits.get(api)[key] ?? 0, integer: true, min: 0 });

		for (const d of DUTIES) {
			heroes.defineDuty({
				id: d.id,
				name: d.name,
				inTown: d.inTown === 'yes',
				manual: true,
				async check(api, _hero, target) {
					if (!target) return text('Choose a settlement');
					if (d.needs && !(await buildings.level(api, target, d.needs)))
						return text('Requires {0}', { 0: keyText(buildings.get(d.needs).name) });
					const max = d.limit ? await stats.get(api, d.limit, settlements.entity(target)) : Infinity;
					return (await heroes.onDuty(api, d.id, target)).length >= max ? text('At most {0} heroes here', { 0: max }) : null;
				},
			});
		}

		const effect = ctx.config.define('effect', {
			description:
				'perPoint: % per attribute point (governing, research, battle casualties) where effects.csv gives none; maxCostCut: most % research cost heroes cut; battlePerPoint x level^battleLevelPower: % battle attack / defence / hp per point; flatLevelPower: flat battle numbers x level^this.',
			default: () => RULES.effect as Record<string, number>,
			parse: numberFields(() => RULES.effect, 0, 100),
		});
		const EFFECTS = csvRows(effectsCsv);
		const ROWS: HeroEffectRow[] = EFFECTS.map((e) => ({
			duty: e.duty,
			effect: e.effect,
			attribute: e.attribute,
			...(e.perPoint ? { perPoint: Number(e.perPoint) } : {}),
		}));
		const effectRules = (api: RuleView): HeroEffectRules => effect.get(api) as unknown as HeroEffectRules;
		// The rows and the rule as the browser works the hero cards out with them (src/shared/starter-heroes.ts).
		ctx.statics.add({
			id: 'starter-heroes.effects',
			compute: ({ rules }): HeroEffectsStatic => ({ rows: ROWS, rules: effectRules(rules) }),
		});
		/** Total % of `kind` for a settlement: its heroes on duty there, the attributes that count. */
		// A row's own % per point (perPoint column), else the general rule: each effect its own formula.
		const perPointOf = (api: ReadApi, e: Record<string, string>) => (e.perPoint ? Number(e.perPoint) : effect.get(api).perPoint);
		/**
		 * What the heroes on duty in a settlement give it, by effect (construction, training, production...): asked on most
		 * commands and pages, so worked out for all effects at once and kept as a derived value (their duties, levels and
		 * equipment are tables of the owner's, the per-point numbers rules).
		 */
		const percents = async (api: Parameters<typeof heroes.onDuty>[0], settlementId: string) =>
			derive(
				api,
				`starter-heroes:duty:${settlementId}`,
				{ owner: (await settlements.get(api, settlementId))?.ownerId ?? null },
				async () => {
					const out: Record<string, number> = {};
					for (const e of EFFECTS)
						for (const h of await heroes.onDuty(api, e.duty, settlementId))
							out[e.effect] = (out[e.effect] ?? 0) + ((await heroes.attributesOf(api, h))[e.attribute] ?? 0) * perPointOf(api, e);
					return out;
				},
			);
		const percent = async (api: Parameters<typeof heroes.onDuty>[0], settlementId: string, kind: string) =>
			(await percents(api, settlementId))[kind] ?? 0;
		/** The heroes' attributes with every bonus (equipment...). */
		const withBonuses = async (api: ReadApi, group: Hero[]) =>
			Promise.all(group.map(async (h) => ({ attrs: await heroes.attributesOf(api, h), level: h.level })));
		const faster = (pct: number) => Math.max(0, 1 - pct / 100);
		/** Summed effects of a group of heroes acting as `duty`, in effects.csv order. */
		const effectsOf = async (api: ReadApi, duty: string, heroGroup: Hero[]) =>
			dutyEffects(ROWS, effectRules(api), duty, await withBonuses(api, heroGroup));

		const onDuty = text('Heroes on duty');
		stats.contribute(
			'resources.productionFactor',
			async (api, target) => {
				const id = settlements.idOf(target);
				return id ? { percent: await percent(api, id, 'production') } : null;
			},
			onDuty,
		);
		buildings.addTimeModifier(async (api, req) => faster(await percent(api, req.settlement.id, 'construction')), onDuty);
		ctx.services.get('troops').addTrainingTimeModifier(async (api, s) => faster(await percent(api, s.id, 'training')), onDuty);
		ctx.services.get('troops').addUpkeepModifier(async (api, settlementId) => faster(await percent(api, settlementId, 'upkeep')), onDuty);
		ctx.services.get('research').addCostModifier(
			async (api, req) => ({
				timeFactor: faster(await percent(api, req.settlementId, 'research')),
				// Cheaper research: its own attributes and rates, at most `maxCostCut` %.
				costFactor: faster(Math.min(effect.get(api).maxCostCut, await percent(api, req.settlementId, 'researchCost'))),
			}),
			onDuty,
		);

		// Production and upkeep change with the heroes on duty: bank the old rates first.
		heroes.onDutyChange(
			async (api, hero, next) => {
				for (const target of new Set([hero.dutyTarget, next.target]))
					if (target && (await settlements.get(api, target))) await resources.settle(api, settlements.entity(target));
			},
			// An idle hero (no post) taking an army (not a settlement): nothing to bank.
			(hero, next) => (!hero.dutyTarget && next.duty === 'command' ? [] : null),
		);
		// ...and with the attributes of a hero on duty.
		heroes.onAttributesChange(
			async (api, hero) => {
				if (hero.dutyTarget && (await settlements.get(api, hero.dutyTarget)))
					await resources.settle(api, settlements.entity(hero.dutyTarget));
			},
			// Not posted to a settlement: nothing to bank.
			(hero) => (hero.dutyTarget ? null : []),
		);

		/* ----- leading armies and defending --------------------------------------------- */

		const armies = ctx.services.get('armies');
		heroes.defineDuty({ id: 'command', name: 'Leading an army', inTown: false, manual: false, anywhere: true });
		heroes.setNameGenerator((random, gender) => ({
			surname: SURNAMES[Math.floor(random() * SURNAMES.length)].key,
			given: GIVEN[gender][Math.floor(random() * GIVEN[gender].length)].key,
		}));

		const heroList = shape({ heroes: fields.optional(fields.list(fields.id(), { min: 0, max: 20 })) });
		/** How many heroes may lead one army, kept for the flat `armies.send` (worked out by the send form). */
		const commandersOf = (api: EngineApi) =>
			derive(api, COMMANDERS.key(api.playerId), { owner: api.playerId, salt: COMMANDERS.salt(), ignore: [...TIMELINE, ...RESOURCES] }, () =>
				stats.get(api, 'heroes.commanders', `player:${api.playerId}`),
			);
		/** Heroes chosen to lead an army: at most heroes.commanders, idle, attached to the settlement it leaves from. */
		armies.addSendOption({
			key: 'heroes',
			async fields(api) {
				const idle = (await heroes.list(api, api.playerId)).filter((h) => h.duty === 'idle');
				if (!idle.length) return [];
				const n = await commandersOf(api);
				// Each hero is offered only while its own settlement is the origin, and in one slot at a time.
				const options = [
					{ value: '', label: text('—') },
					...idle.map((h) => ({ value: h.id, label: keyText(heroes.nameKey(h)), when: { from: h.home } })),
				];
				return Array.from({ length: n }, (_, i) => ({
					name: `hero${i + 1}`,
					label: text('Hero {0}'),
					index: i + 1,
					type: 'select' as const,
					options,
					distinct: 'heroes',
				}));
			},
			async parse(api, raw, { from }) {
				const unique = chosenHeroes(raw);
				if (!unique.length) return undefined;
				if (unique.length > (await stats.get(api, 'heroes.commanders', `player:${api.playerId}`)))
					throw fail('blocked', 'Too many heroes for one army');
				for (const id of unique) {
					const h = await heroes.requireOwned(api, api.playerId, id);
					if (h.home !== from) throw fail('blocked', 'A hero can only lead troops from the settlement it is attached to');
					// Governors, scholars and heroes on any other duty stay at their post.
					if (h.duty !== 'idle') throw fail('blocked', 'That hero is busy with another duty');
				}
				return unique;
			},
			async onSend(api, value, army) {
				for (const id of value as string[]) await heroes.assign(api, id, 'command', army.id);
			},
			// As `parse` + `onSend` from the player's hero rows; anything refused goes the regular way.
			flat: {
				derived: (f, { raw }) => (chosenHeroes(raw).length ? [COMMANDERS.wanted(f.playerId)] : []),
				reads: (f, { raw }): Record<string, D1PreparedStatement> =>
					chosenHeroes(raw).length ? { heroes: heroes.flat.reads(f, f.playerId) } : {},
				run(f, { raw, from, army, rows, derived }) {
					const unique = chosenHeroes(raw);
					if (!unique.length) return { value: undefined };
					if (unique.length > (derived[COMMANDERS.key(f.playerId)] as number)) return null;
					const mine = heroes.flat.heroes(rows.heroes);
					const writes: D1PreparedStatement[] = [];
					for (const id of unique) {
						const h = mine.find((x) => x.id === id);
						if (!h || h.home !== from || h.duty !== 'idle') return null;
						const w = heroes.flat.assign(f, h, 'command', army);
						if (!w) return null;
						writes.push(...w);
					}
					return { value: unique, writes };
				},
			},
		});
		/** A `heroes` list through the API, or the form's selects "hero1", "hero2"... */
		function chosenHeroes(raw: Record<string, unknown>) {
			const ids =
				heroList(raw).heroes ??
				Object.entries(raw)
					.filter(([k, v]) => /^hero\d+$/.test(k) && v)
					.map(([k, v]) => fields.id()(v, k));
			return [...new Set(ids)];
		}
		// Back home, the army's heroes are free again; stationed elsewhere, they now belong there.
		armies.onReturn(async (api, army) => {
			for (const h of await heroes.onDuty(api, 'command', army.id)) {
				await heroes.assign(api, h.id, 'idle', null);
				if (army.at !== army.from) await heroes.setHome(api, h.id, army.at);
			}
		});

		const FLAT = csvRows(battleFlatCsv).map((r) => ({
			duty: r.duty,
			attribute: r.attribute,
			stat: r.stat,
			perPoint: csvNumber(r, 'perPoint'),
		}));
		const flatRule = ctx.config.define('battleFlat', {
			description:
				'Flat numbers heroes add to every lane when leading or defending: rows { duty: command|defend, attribute, stat: attack|defense|hp, perPoint } (replaces the whole table).',
			default: () => FLAT,
			parse(raw) {
				if (!Array.isArray(raw)) throw fail('bad_config', 'Expected a list of rows');
				return raw.map((r, i) => {
					const x = (r ?? {}) as Record<string, unknown>;
					if (x.duty !== 'command' && x.duty !== 'defend') throw fail('bad_config', text('[{0}].duty must be command or defend', { 0: i }));
					if (typeof x.attribute !== 'string' || !heroes.attributes().some((a) => a.id === x.attribute))
						throw fail('bad_config', text('[{0}].attribute is unknown', { 0: i }));
					if (x.stat !== 'attack' && x.stat !== 'defense' && x.stat !== 'hp')
						throw fail('bad_config', text('[{0}].stat must be attack, defense or hp', { 0: i }));
					return { duty: x.duty, attribute: x.attribute, stat: x.stat, perPoint: numberInRange(0, 1e6)(x.perPoint) };
				});
			},
		});
		const BATTLE_STATS = new Set(['attack', 'defense', 'hp', 'casualty']);
		/** Battle modifiers from a group of heroes acting as `role` (command / defend). */
		const heroModifiers = async (api: ReadApi, heroGroup: Hero[], role: string) => {
			if (!heroGroup.length) return [];
			const group = await withBonuses(api, heroGroup);
			const out = new Map<string, number>();
			for (const row of ROWS.filter((x) => x.duty === role && BATTLE_STATS.has(x.effect)))
				for (const h of group) out.set(row.effect, (out.get(row.effect) ?? 0) + rowPercent(row, effectRules(api), h));
			const source = text(role === 'command' ? 'Commanding heroes' : 'Defending heroes');
			// Casualties go down, everything else up.
			const percents = [...out].map(([stat, pct]) => ({
				source,
				stat: stat as 'attack' | 'defense' | 'hp' | 'casualty',
				percent: stat === 'casualty' ? -pct : pct,
			}));
			// And flat numbers in every lane, from the attributes (equipment included).
			const flat = new Map<string, number>();
			for (const f of flatRule.get(api).filter((x) => x.duty === role))
				for (const h of group)
					flat.set(f.stat, (flat.get(f.stat) ?? 0) + (h.attrs[f.attribute] ?? 0) * f.perPoint * h.level ** effect.get(api).flatLevelPower);
			return [
				...percents,
				...[...flat].filter(([, v]) => v).map(([stat, v]) => ({ source, stat: stat as 'attack' | 'defense' | 'hp', flat: Math.round(v) })),
			];
		};
		ctx.services.get('battle').addModifier(async (api, side) => {
			if (side.role === 'attacker' && side.armyId) return heroModifiers(api, await heroes.onDuty(api, 'command', side.armyId), 'command');
			if (side.role === 'defender' && side.settlement?.ownerId) {
				const n = await stats.get(api, 'heroes.defenders', settlements.entity(side.settlement.id));
				return heroModifiers(api, await heroes.defenders(api, side.settlement.id, n), 'defend');
			}
			return [];
		});
		// A routed side's leaders come back injured, as from a lost adventure: the heroes leading the army, and
		// (暂按) the heroes who were defending the settlement.
		const realms = ctx.services.get('realms');
		ctx.services.get('battle').onFought(async (api, side, result) => {
			const grade = result.detail.grade;
			if (grade.attacker === 'routed' && side.attacker.armyId)
				for (const h of await heroes.onDuty(api, 'command', side.attacker.armyId)) await realms.injure(api, h);
			const town = side.defender.settlement;
			if (grade.defender === 'routed' && town?.ownerId) {
				const n = await stats.get(api, 'heroes.defenders', settlements.entity(town.id));
				for (const h of await heroes.defenders(api, town.id, n)) await realms.injure(api, h);
			}
		});
		const defendAttrs = [...new Set(EFFECTS.filter((e) => e.duty === 'defend').map((e) => e.attribute))];
		heroes.setDefenseScore((h) => defendAttrs.reduce((sum, a) => sum + (h.attrs[a] ?? 0), 0));

		ctx.meta.add('heroNames', () => {
			const all = [...SURNAMES, ...GIVEN.m, ...GIVEN.f];
			return { en: Object.fromEntries(all.map((n) => [n.key, n.en])), 'zh-CN': Object.fromEntries(all.map((n) => [n.key, n.zh])) };
		});

		/* ----- what the heroes of a settlement give it ---------------------------------- */

		// The city page's posts (`starter-heroes.posts-city`) and those of buildings on their entries (`-entry`) are
		// assembled from it in the browser. Who is on duty changes with the player's commands (a hero's level from an
		// adventure: at the next one).
		ctx.views.add({
			id: 'starter-heroes.posts',
			...settlements.storedView('starter-heroes:posts', 1, async (api, s): Promise<HeroPost[]> => {
				const entity = settlements.entity(s.id);
				const out: HeroPost[] = [];
				for (const d of DUTIES) {
					const group = await heroes.onDuty(api, d.id, s.id);
					out.push({
						post: d.id,
						name: own(d.name),
						...(d.needs ? { building: d.needs } : {}),
						limit: d.limit ? await stats.get(api, d.limit, entity) : 0,
						heroes: group.map((h) => h.id),
						names: group.map((h) => heroes.nameKey(h)),
						effects: await effectsOf(api, d.id, group),
					});
				}
				const n = await stats.get(api, 'heroes.defenders', entity);
				const defenders = await heroes.defenders(api, s.id, n);
				out.push({
					post: 'defend',
					name: own('Defending'),
					limit: n,
					heroes: defenders.map((h) => h.id),
					names: defenders.map((h) => heroes.nameKey(h)),
					effects: await effectsOf(api, 'defend', defenders),
				});
				return out;
			}),
		});

		// On hero cards, what the hero would give in each role: worked out in the browser (the starter-heroes client part at
		// "heroes.card", `roleEffects` on the static `starter-heroes.effects`).
		// Posts: the city page shows the settlement's own; buildings with posts (e.g. the institute) show theirs.
		const ui = ctx.services.get('ui');
		ui.block({ page: 'city', column: 'left', widget: 'ui.rows', order: 20, props: { view: 'starter-heroes.posts-city' } });
		ui.entry({ kind: 'building', widget: 'ui.rows', props: { view: 'starter-heroes.posts-entry' } });
	},
});
