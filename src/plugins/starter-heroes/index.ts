/**
 * Default hero content (docs/design/gameplay.md §5), all numbers in ./data (CSV): the six
 * attributes, the tavern / academy / music house where heroes are recruited (attribute ranges,
 * which attribute stands out, gender, rarity, cost), how many candidates a building offers and
 * how often, and the name lists (with how each part is written in each language).
 *
 * Name parts are stored as keys ("s:Zhao", "m:Zilong"); the client joins their spelling for
 * its language (meta `heroNames`), so equal pinyin in different lists never mix up.
 */
import { csvMap, csvNumber, csvRows, csvRules, definePlugin, GameError, numberFields, PluginError, type ReadApi } from '../../kernel';
import type { HeroPost } from '../../shared/api';
import type { Hero, HeroDraft } from '../heroes';
import attributesCsv from './data/attributes.csv?raw';
import buildingsCsv from './data/buildings.csv?raw';
import femaleCsv from './data/given-f.csv?raw';
import maleCsv from './data/given-m.csv?raw';
import levelsCsv from './data/levels.csv?raw';
import rangesCsv from './data/ranges.csv?raw';
import rulesCsv from './data/rules.csv?raw';
import dutiesCsv from './data/duties.csv?raw';
import effectsCsv from './data/effects.csv?raw';
import surnamesCsv from './data/surnames.csv?raw';
import venuesCsv from './data/venues.csv?raw';

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
		talent: range(r.talent || '3-3', `venues.csv (${r.id}, talent)`),
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
	dependsOn: ['heroes', 'buildings', 'settlements', 'resources', 'stats', 'troops', 'research', 'armies', 'battle'],
	setup(ctx) {
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
				if (typeof raw !== 'object' || raw === null) throw new GameError('bad_config', 'Expected { venue: { attribute: [min, max] } }');
				const out = structuredClone(RANGES);
				for (const [venue, attrs] of Object.entries(raw)) {
					if (!out[venue]) throw new GameError('bad_config', `Unknown venue "${venue}"`);
					for (const [attr, r] of Object.entries(attrs as Record<string, unknown>)) {
						if (!out[venue][attr]) throw new GameError('bad_config', `Unknown attribute "${attr}"`);
						if (!Array.isArray(r) || r.length !== 2 || !r.every((n) => typeof n === 'number' && n >= 0) || r[0] > r[1])
							throw new GameError('bad_config', `${venue}.${attr}: expected [min, max]`);
						out[venue][attr] = [r[0], r[1]];
					}
				}
				return out;
			},
		});

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
						talent: v.talent[0] + Math.floor(random() * (v.talent[1] - v.talent[0] + 1)),
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
			description: 'perPoint: % per attribute point where an attribute applies (100 points x 0.2 = +20%).',
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
			Promise.all(group.map(async (h) => ({ attrs: await heroes.attributesOf(api, h) })));
		const faster = (pct: number) => Math.max(0, 1 - pct / 100);
		/** Summed effects of a group of heroes acting as `duty`, in effects.csv order. */
		const effectsOf = async (api: ReadApi, duty: string, heroGroup: Hero[]) => {
			const group = await withBonuses(api, heroGroup);
			const out = new Map<string, number>();
			for (const e of EFFECTS.filter((x) => x.duty === duty))
				out.set(
					e.effect,
					(out.get(e.effect) ?? 0) + group.reduce((sum, h) => sum + (h.attrs[e.attribute] ?? 0), 0) * effect.get(api).perPoint,
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

		/** Heroes chosen to lead an army: at most heroes.commanders, idle, attached to the settlement it leaves from. */
		armies.addSendOption({
			key: 'heroes',
			async fields(api) {
				const idle = (await heroes.list(api, api.playerId)).filter((h) => h.duty === 'idle');
				if (!idle.length) return [];
				const n = await stats.get(api, 'heroes.commanders', `player:${api.playerId}`);
				// Each hero is offered only while its own settlement is the origin, and in one slot at a time.
				const options = [{ value: '', label: '—' }, ...idle.map((h) => ({ value: h.id, label: heroName(h), when: { from: h.home } }))];
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
					throw new GameError('blocked', 'Too many heroes for one army');
				const mine = await heroes.list(api, api.playerId);
				for (const id of unique) {
					const h = mine.find((x) => x.id === id);
					if (!h) throw new GameError('bad_payload', 'No such hero');
					if (h.home !== from) throw new GameError('blocked', 'A hero can only lead troops from the settlement it is attached to');
					// Governors, scholars and heroes on any other duty stay at their post.
					if (h.duty !== 'idle') throw new GameError('blocked', 'That hero is busy with another duty');
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

		const BATTLE_STATS = new Set(['attack', 'defense', 'hp', 'casualty']);
		/** Battle modifiers from a group of heroes acting as `role` (command / defend). */
		const heroModifiers = async (api: ReadApi, heroGroup: Hero[], role: string) => {
			if (!heroGroup.length) return [];
			const group = await withBonuses(api, heroGroup);
			const out = new Map<string, number>();
			for (const e of EFFECTS.filter((x) => x.duty === role && BATTLE_STATS.has(x.effect)))
				for (const h of group) out.set(e.effect, (out.get(e.effect) ?? 0) + (h.attrs[e.attribute] ?? 0) * effect.get(api).perPoint);
			// Casualties go down, everything else up.
			return [...out].map(([stat, pct]) => ({
				source: role === 'command' ? 'Commanding heroes' : 'Defending heroes',
				stat: stat as 'attack' | 'defense' | 'hp' | 'casualty',
				percent: stat === 'casualty' ? -pct : pct,
			}));
		};
		ctx.services.get('battle').addModifier(async (api, side) => {
			if (side.role === 'attacker' && side.armyId) return heroModifiers(api, await heroes.onDuty(api, 'command', side.armyId), 'command');
			if (side.role === 'defender' && side.settlement?.ownerId) {
				const n = await stats.get(api, 'heroes.defenders', settlements.entity(side.settlement.id));
				return heroModifiers(api, await heroes.defenders(api, side.settlement.id, n), 'defend');
			}
			return [];
		});
		const defendAttrs = [...new Set(EFFECTS.filter((e) => e.duty === 'defend').map((e) => e.attribute))];
		heroes.setDefenseScore((h) => defendAttrs.reduce((sum, a) => sum + (h.attrs[a] ?? 0), 0));

		ctx.meta.add('heroNames', () => {
			const all = [...SURNAMES, ...GIVEN.m, ...GIVEN.f];
			return { en: Object.fromEntries(all.map((n) => [n.key, n.en])), 'zh-CN': Object.fromEntries(all.map((n) => [n.key, n.zh])) };
		});

		/* ----- what the heroes of a settlement give it ---------------------------------- */

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
						name: d.name,
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
					name: 'Defending',
					limit: n,
					heroes: defenders.map((h) => h.id),
					effects: await effectsOf(api, 'defend', defenders),
				});
				return out;
			},
		});
	},
});
