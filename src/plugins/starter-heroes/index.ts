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
	GameError,
	numberFields,
	numberInRange,
	PluginError,
	type EngineApi,
	type ReadApi,
} from '../../kernel';
import type { HeroPost, HeroRoles } from '../../shared/api';
import type { RowsData, UiRow } from '../../shared/ui';
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

const RULES = csvRules(rulesCsv);
const ATTRIBUTES = csvRows(attributesCsv);
const DUTIES = csvRows(dutiesCsv);
/** Name lists: keys with a list prefix, and their spelling by locale. */
const names = (prefix: string, csv: string) => csvRows(csv).map((r) => ({ key: `${prefix}:${r.key}`, en: r.en, zh: r.zh }));
const SURNAMES = names('s', surnamesCsv);
const GIVEN = { m: names('m', maleCsv), f: names('f', femaleCsv) };
const NAMES = new Map([...SURNAMES, ...GIVEN.m, ...GIVEN.f].map((n) => [n.key, n]));

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
	dependsOn: ['heroes', 'buildings', 'settlements', 'resources', 'stats', 'troops', 'research', 'armies', 'battle', 'realms', 'i18n', 'ui'],
	setup(ctx) {
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
		const ranges = ctx.config.define('ranges', {
			description: 'Attribute ranges [min, max] by venue and attribute (partial overrides allowed).',
			default: () => RANGES,
			parse(raw) {
				if (typeof raw !== 'object' || raw === null)
					throw new GameError('bad_config', 'Expected { venue: { attribute: [min, max] } }', 400, 'starter-heroes');
				const out = structuredClone(RANGES);
				for (const [venue, attrs] of Object.entries(raw)) {
					if (!out[venue]) throw new GameError('bad_config', `Unknown venue "${venue}"`, 400, 'starter-heroes');
					for (const [attr, r] of Object.entries(attrs as Record<string, unknown>)) {
						if (!out[venue][attr]) throw new GameError('bad_config', `Unknown attribute "${attr}"`, 400, 'starter-heroes');
						if (!Array.isArray(r) || r.length !== 2 || !r.every((n) => typeof n === 'number' && n >= 0) || r[0] > r[1])
							throw new GameError('bad_config', `${venue}.${attr}: expected [min, max]`, 400, 'starter-heroes');
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
				if (typeof raw !== 'object' || raw === null)
					throw new GameError('bad_config', 'Expected { venue: { points: weight } }', 400, 'starter-heroes');
				const out = structuredClone(TALENTS);
				for (const [venue, table] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
					if (!out[venue]) throw new GameError('bad_config', `Unknown venue "${venue}"`, 400, 'starter-heroes');
					out[venue] = Object.fromEntries(
						Object.entries(table ?? {}).map(([pts, w]) => {
							if (!/^\d+$/.test(pts))
								throw new GameError('bad_config', `${venue}: "${pts}" is not a number of points`, 400, 'starter-heroes');
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
			const weights = Object.entries(ranges.get(api)[venue] ?? {}).map(([a, [min, max]]) => ({ a, w: (min + max) / 2 }));
			const sum = weights.reduce((a, x) => a + x.w, 0);
			const out: Record<string, number> = {};
			for (let i = 0; i < points; i++) {
				let r = random() * sum;
				const hit = weights.find((x) => (r -= x.w) < 0) ?? weights[weights.length - 1];
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
				draft(api, random): HeroDraft | null {
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
					if (!target) return 'Choose a settlement';
					if (d.needs && !(await buildings.level(api, target, d.needs))) return `Requires ${buildings.get(d.needs).name}`;
					const max = d.limit ? await stats.get(api, d.limit, settlements.entity(target)) : Infinity;
					return (await heroes.onDuty(api, d.id, target)).length >= max ? `At most ${max} heroes here` : null;
				},
			});
		}

		const effect = ctx.config.define('effect', {
			description:
				'perPoint: % per attribute point (governing, research, battle casualties); battlePerPoint x level^battleLevelPower: % battle attack / defence / hp per point; flatLevelPower: flat battle numbers x level^this.',
			default: () => RULES.effect as Record<string, number>,
			parse: numberFields(() => RULES.effect, 0, 100),
		});
		const EFFECTS = csvRows(effectsCsv);
		/** Total % of `kind` for a settlement: its heroes on duty there, the attributes that count. */
		async function percent(api: Parameters<typeof heroes.onDuty>[0], settlementId: string, kind: string) {
			let pts = 0;
			for (const e of EFFECTS.filter((x) => x.effect === kind))
				for (const h of await heroes.onDuty(api, e.duty, settlementId)) pts += (await heroes.attributesOf(api, h))[e.attribute] ?? 0;
			return pts * effect.get(api).perPoint;
		}
		/** The heroes' attributes with every bonus (equipment...). */
		const withBonuses = async (api: ReadApi, group: Hero[]) =>
			Promise.all(group.map(async (h) => ({ attrs: await heroes.attributesOf(api, h), level: h.level })));
		const faster = (pct: number) => Math.max(0, 1 - pct / 100);
		/** Summed effects of a group of heroes acting as `duty`, in effects.csv order. */
		/** % from one hero's attribute: battle attack / defence / hp grow with the hero's level; the rest is per point. */
		const pctOf = (api: ReadApi, effectId: string, h: { attrs: Record<string, number>; level: number }, attribute: string) => {
			const e = effect.get(api);
			const pts = h.attrs[attribute] ?? 0;
			return BATTLE_GROWING.has(effectId) ? pts * e.battlePerPoint * h.level ** e.battleLevelPower : pts * e.perPoint;
		};
		const effectsOf = async (api: ReadApi, duty: string, heroGroup: Hero[]) => {
			const group = await withBonuses(api, heroGroup);
			const out = new Map<string, number>();
			const battle = duty === 'command' || duty === 'defend';
			for (const e of EFFECTS.filter((x) => x.duty === duty))
				out.set(
					e.effect,
					(out.get(e.effect) ?? 0) +
						group.reduce(
							(sum, h) => sum + (battle ? pctOf(api, e.effect, h, e.attribute) : (h.attrs[e.attribute] ?? 0) * effect.get(api).perPoint),
							0,
						),
				);
			return [...out].map(([id, pct]) => ({ effect: id, percent: pct }));
		};

		stats.contribute('resources.productionFactor', async (api, target) =>
			target.startsWith('settlement:') ? { percent: await percent(api, target.slice('settlement:'.length), 'production') } : null,
		);
		buildings.addTimeModifier(async (api, req) => faster(await percent(api, req.settlement.id, 'construction')));
		ctx.services.get('troops').addTrainingTimeModifier(async (api, s) => faster(await percent(api, s.id, 'training')));
		ctx.services.get('troops').addUpkeepModifier(async (api, settlementId) => faster(await percent(api, settlementId, 'upkeep')));
		ctx.services
			.get('research')
			.addCostModifier(async (api, req) => ({ timeFactor: faster(await percent(api, req.settlementId, 'research')) }));

		// Production and upkeep change with the heroes on duty: bank the old rates first.
		heroes.onDutyChange(async (api, hero, next) => {
			for (const target of new Set([hero.dutyTarget, next.target]))
				if (target && (await settlements.get(api, target))) await resources.settle(api, settlements.entity(target));
		});
		// ...and with the attributes of a hero on duty.
		heroes.onAttributesChange(async (api, hero) => {
			if (hero.dutyTarget && (await settlements.get(api, hero.dutyTarget)))
				await resources.settle(api, settlements.entity(hero.dutyTarget));
		});

		/* ----- leading armies and defending --------------------------------------------- */

		const armies = ctx.services.get('armies');
		heroes.defineDuty({ id: 'command', name: 'Leading an army', inTown: false, manual: false, anywhere: true });
		const spelled = (key: string) => NAMES.get(key)?.en ?? key;
		const heroName = (h: { surname: string; given: string }) => `${spelled(h.surname)} ${spelled(h.given)}`;
		heroes.setNameFormatter(heroName);
		heroes.setNameGenerator((random, gender) => ({
			surname: SURNAMES[Math.floor(random() * SURNAMES.length)].key,
			given: GIVEN[gender][Math.floor(random() * GIVEN[gender].length)].key,
		}));

		/** Heroes chosen to lead an army: at most heroes.commanders, idle, attached to the settlement it leaves from. */
		armies.addSendOption({
			key: 'heroes',
			async fields(api) {
				const idle = (await heroes.list(api, api.playerId)).filter((h) => h.duty === 'idle');
				if (!idle.length) return [];
				const n = await stats.get(api, 'heroes.commanders', `player:${api.playerId}`);
				// Each hero is offered only while its own settlement is the origin, and in one slot at a time.
				const options = [
					{ value: '', label: '—' },
					...idle.map((h) => ({ value: h.id, label: `${h.surname} ${h.given}`, when: { from: h.home } })),
				];
				return Array.from({ length: n }, (_, i) => ({
					name: `hero${i + 1}`,
					label: `Hero ${i + 1}`,
					type: 'select' as const,
					options,
					distinct: 'heroes',
				}));
			},
			async parse(api, raw, { from }) {
				const ids = Array.isArray(raw.heroes)
					? raw.heroes
					: Object.entries(raw)
							.filter(([k, v]) => /^hero\d+$/.test(k) && typeof v === 'string' && v)
							.map(([, v]) => v);
				const unique = [...new Set(ids)];
				if (!unique.length) return undefined;
				if (unique.length > (await stats.get(api, 'heroes.commanders', `player:${api.playerId}`)))
					throw new GameError('blocked', 'Too many heroes for one army', 400, 'starter-heroes');
				const mine = await heroes.list(api, api.playerId);
				for (const id of unique) {
					const h = mine.find((x) => x.id === id);
					if (!h) throw new GameError('bad_payload', 'No such hero', 400, 'starter-heroes');
					if (h.home !== from)
						throw new GameError('blocked', 'A hero can only lead troops from the settlement it is attached to', 400, 'starter-heroes');
					// Governors, scholars and heroes on any other duty stay at their post.
					if (h.duty !== 'idle') throw new GameError('blocked', 'That hero is busy with another duty', 400, 'starter-heroes');
				}
				return unique;
			},
			async onSend(api, value, army) {
				for (const id of value as string[]) await heroes.assign(api, id, 'command', army.id);
			},
		});
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
				if (!Array.isArray(raw)) throw new GameError('bad_config', 'Expected a list of rows', 400, 'starter-heroes');
				return raw.map((r, i) => {
					const x = (r ?? {}) as Record<string, unknown>;
					if (x.duty !== 'command' && x.duty !== 'defend')
						throw new GameError('bad_config', `[${i}].duty must be command or defend`, 400, 'starter-heroes');
					if (typeof x.attribute !== 'string' || !heroes.attributes().some((a) => a.id === x.attribute))
						throw new GameError('bad_config', `[${i}].attribute is unknown`, 400, 'starter-heroes');
					if (x.stat !== 'attack' && x.stat !== 'defense' && x.stat !== 'hp')
						throw new GameError('bad_config', `[${i}].stat must be attack, defense or hp`, 400, 'starter-heroes');
					return { duty: x.duty, attribute: x.attribute, stat: x.stat, perPoint: numberInRange(0, 1e6)(x.perPoint) };
				});
			},
		});
		const BATTLE_GROWING = new Set(['attack', 'defense', 'hp']);
		const BATTLE_STATS = new Set(['attack', 'defense', 'hp', 'casualty']);
		/** Battle modifiers from a group of heroes acting as `role` (command / defend). */
		const heroModifiers = async (api: ReadApi, heroGroup: Hero[], role: string) => {
			if (!heroGroup.length) return [];
			const group = await withBonuses(api, heroGroup);
			const out = new Map<string, number>();
			for (const e of EFFECTS.filter((x) => x.duty === role && BATTLE_STATS.has(x.effect)))
				for (const h of group) out.set(e.effect, (out.get(e.effect) ?? 0) + pctOf(api, e.effect, h, e.attribute));
			const source = role === 'command' ? 'Commanding heroes' : 'Defending heroes';
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

		// What each of the player's heroes would give in each role (its attributes with bonuses).
		ctx.views.add({
			id: 'starter-heroes.roles',
			async compute(api): Promise<HeroRoles> {
				const out: HeroRoles = {};
				const roles = [...new Set(EFFECTS.map((e) => e.duty))];
				for (const h of await heroes.list(api, api.playerId)) {
					out[h.id] = {};
					for (const role of roles) out[h.id][role] = await effectsOf(api, role, [h]);
				}
				return out;
			},
		});

		ctx.views.add({
			id: 'starter-heroes.posts',
			async compute(api, params): Promise<HeroPost[] | null> {
				const s = await settlements.resolve(api, params);
				if (!s) return null;
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
					effects: await effectsOf(api, 'defend', defenders),
				});
				return out;
			},
		});

		// Posts for the generic rows widget: the settlement's own on the city page, each building's on
		// its entry (`where`: the building type).
		const REDUCTIONS = new Set(['construction', 'training', 'upkeep', 'research', 'casualty']);
		// On hero cards: what the hero would give in each role (leading an army and defending give the
		// same, so they are shown once as "military").
		const ROLE_NAMES: Record<string, string> = {
			governor: 'Governor',
			scholar: 'Institute post',
			command: 'Leading an army',
			defend: 'Defending',
			military: 'Military bonus',
		};
		heroes.addCardLines(async (api, h) => {
			const all: Record<string, { effect: string; percent: number }[]> = {};
			for (const role of new Set(EFFECTS.map((e) => e.duty))) all[role] = await effectsOf(api, role, [h]);
			if (all.command && JSON.stringify(all.command) === JSON.stringify(all.defend)) {
				all.military = all.command;
				delete all.command;
				delete all.defend;
			}
			return Object.entries(all)
				.filter(([, list]) => list.length)
				.map(([role, list]) => ({
					text: {
						text: '{0}: {1}',
						vars: {
							0: ROLE_NAMES[role] ?? role,
							1: list.map((e) => ({
								text: '{effect} {value}',
								vars: { effect: `effect:${e.effect}`, value: `${REDUCTIONS.has(e.effect) ? '−' : '+'}${e.percent.toFixed(1)}%` },
							})),
						},
					},
					tone: 'muted' as const,
				}));
		});
		const postRows = async (api: EngineApi, params: Record<string, string>, onEntry: boolean): Promise<RowsData | null> => {
			const s = await settlements.resolve(api, params);
			if (!s) return null;
			const entity = settlements.entity(s.id);
			const rows: (UiRow & { where?: string })[] = [];
			const add = async (
				id: string,
				name: string,
				building: string | undefined,
				limit: number,
				group: Hero[],
				effects: { effect: string; percent: number }[],
			) =>
				rows.push({
					id,
					...(building ? { where: building } : {}),
					title: { text: name },
					...(limit ? { badge: { text: '{n} / {max}', vars: { n: group.length, max: limit } } } : {}),
					lines: group.length
						? [
								{
									text: {
										text: '{list}',
										vars: { list: group.map((h) => ({ text: '{hero}', vars: { hero: `${h.surname} ${h.given}` } })) },
									},
								},
								{
									text: {
										text: '{list}',
										vars: {
											list: effects.map((e) => ({
												text: '{effect} {value}',
												vars: { effect: `effect:${e.effect}`, value: `${REDUCTIONS.has(e.effect) ? '−' : '+'}${e.percent.toFixed(1)}%` },
											})),
										},
									},
									tone: 'muted',
								},
							]
						: [{ text: { text: 'Nobody.' }, tone: 'muted' }],
					...(group.length ? {} : { actions: [{ page: 'heroes', label: { text: 'Assign heroes' } }] }),
				});
			for (const d of DUTIES) {
				if (!!d.needs !== onEntry) continue;
				const group = await heroes.onDuty(api, d.id, s.id);
				await add(d.id, d.name, d.needs, d.limit ? await stats.get(api, d.limit, entity) : 0, group, await effectsOf(api, d.id, group));
			}
			if (!onEntry) {
				const n = await stats.get(api, 'heroes.defenders', entity);
				const defenders = await heroes.defenders(api, s.id, n);
				await add('defend', 'Defending', undefined, n, defenders, await effectsOf(api, 'defend', defenders));
			}
			if (!rows.length) return null;
			// One section per row on entries (each row's building), one for the city page.
			return onEntry
				? { title: { text: 'Heroes here' }, sections: rows.map(({ where, ...r }) => ({ ...(where ? { where } : {}), rows: [r] })) }
				: { title: { text: 'Heroes of this settlement' }, sections: [{ rows }] };
		};
		ctx.views.add({ id: 'starter-heroes.posts-city', compute: (api, params) => postRows(api, params, false) });
		ctx.views.add({ id: 'starter-heroes.posts-entry', compute: (api, params) => postRows(api, params, true) });
		// Posts: the city page shows the settlement's own; buildings with posts (e.g. the institute) show theirs.
		const ui = ctx.services.get('ui');
		ui.block({ page: 'city', column: 'left', widget: 'ui.rows', order: 20, props: { view: 'starter-heroes.posts-city' } });
		ui.entry({ kind: 'building', widget: 'ui.rows', props: { view: 'starter-heroes.posts-entry' } });
	},
});
