/**
 * Default research content (docs/design/gameplay.md §8): the tech tree — civil and military
 * branches in four tiers, crossing each other — and the Institute where research happens.
 * Everything is data in ./data (CSV):
 *   - techs.csv: the tree (branch, tier, quote, prerequisites, building level gates);
 *   - levels.csv: costs and times;
 *   - effects.csv: what each tech does per level, GM-tunable as `starter-research.effects`.
 *
 * Effects go through the other systems' own extension points: stats (flat / percent), each
 * resource's own production stat, battle modifiers, construction / training / upkeep /
 * research time modifiers, march speed and terrain bonuses. None of those systems knows about techs.
 */
import { csvMap, csvNumber, csvRows, definePlugin, gameErrors, PluginError, type ReadApi } from '../../kernel';
import { keyText, uiTexts } from '../../shared/i18n';
import type { UiText } from '../../shared/ui';
import type { BattleStat } from '../battle';
import buildingLevelsCsv from './data/building-levels.csv?raw';
import buildingsCsv from './data/buildings.csv?raw';
import effectsCsv from './data/effects.csv?raw';
import levelsCsv from './data/levels.csv?raw';
import techsCsv from './data/techs.csv?raw';
import i18nCsv from './data/i18n.csv?raw';

const fail = gameErrors('starter-research');
const text = uiTexts('starter-research');

type Kind = 'stat' | 'percent' | 'output' | 'battle' | 'time' | 'speed' | 'terrain';
interface Effect {
	kind: Kind;
	target: string;
	value: number;
	family?: string;
	/** A milestone: `value` once the tech reaches this level, instead of `value` per level. */
	atLevel?: number;
}
const KINDS = new Set<Kind>(['stat', 'percent', 'output', 'battle', 'time', 'speed', 'terrain']);
const BATTLE = new Set<BattleStat>(['attack', 'defense', 'hp', 'counter', 'casualty', 'loot', 'carry']);
const TIMES = new Set(['construction', 'training', 'upkeep', 'research']);

const FILE_EFFECTS: Record<string, Effect[]> = {};
for (const r of csvRows(effectsCsv)) {
	(FILE_EFFECTS[r.tech] ??= []).push({
		kind: r.kind as Kind,
		target: r.target,
		value: csvNumber(r, 'value'),
		...(r.family ? { family: r.family } : {}),
		...(r.atLevel ? { atLevel: csvNumber(r, 'atLevel') } : {}),
	});
}
/** What one row gives at a tech level. */
const amount = (e: Effect, level: number) => (e.atLevel ? (level >= e.atLevel ? e.value : 0) : e.value * level);

function parseEffect(raw: unknown, where: string, resourceIds: () => Set<string>, terrainIds: () => Set<string>): Effect {
	const e = (raw ?? {}) as Record<string, unknown>;
	const invalid = (m: UiText): never => {
		throw fail('bad_config', text('{0}: {1}', { 0: where, 1: m }));
	};
	if (typeof e.kind !== 'string' || !KINDS.has(e.kind as Kind)) invalid(text('kind must be one of {0}', { 0: [...KINDS].join(', ') }));
	if (typeof e.target !== 'string' || !/^[\w.-]{1,64}$/.test(e.target)) invalid(text('target must be an id'));
	const target = e.target as string;
	if (e.kind === 'battle' && !BATTLE.has(target as BattleStat))
		invalid(text('battle target must be one of {0}', { 0: [...BATTLE].join(', ') }));
	if (e.kind === 'time' && !TIMES.has(target)) invalid(text('time target must be one of {0}', { 0: [...TIMES].join(', ') }));
	if (e.kind === 'output' && !resourceIds().has(target)) invalid(text('unknown resource "{0}"', { 0: target }));
	if (e.kind === 'speed' && target !== 'march') invalid(text('speed target must be "march"'));
	if (e.kind === 'terrain') {
		const [terrain, resource] = target.split('.');
		if (!terrainIds().has(terrain) || !resourceIds().has(resource)) invalid(text('terrain target must be "<terrain>.<resource>"'));
	}
	const value = Number(e.value);
	if (!Number.isFinite(value) || Math.abs(value) > 1e6) invalid(text('value must be a number'));
	if (e.family !== undefined && (typeof e.family !== 'string' || (e.kind !== 'battle' && e.kind !== 'speed')))
		invalid(text('family is for battle and speed effects only'));
	if (e.atLevel !== undefined && (!Number.isInteger(e.atLevel) || (e.atLevel as number) < 1 || (e.atLevel as number) > 1000))
		invalid(text('atLevel must be a level'));
	return {
		kind: e.kind as Kind,
		target,
		value,
		...(e.family ? { family: e.family as string } : {}),
		...(e.atLevel !== undefined ? { atLevel: e.atLevel as number } : {}),
	};
}

export default definePlugin({
	id: 'starter-research',
	version: '0.3.0',
	description: 'The tech tree: civil and military branches in four tiers, their effects, and the Institute',
	dependsOn: ['research', 'buildings', 'settlements', 'resources', 'stats', 'troops', 'battle', 'armies', 'terrain', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const research = ctx.services.get('research');
		const settlements = ctx.services.get('settlements');
		const resources = ctx.services.get('resources');
		const stats = ctx.services.get('stats');
		const troops = ctx.services.get('troops');
		const battle = ctx.services.get('battle');
		ctx.services.get('buildings').defineFromCsv(buildingsCsv, buildingLevelsCsv);
		research.defineFromCsv(techsCsv, levelsCsv);
		// Research is started at the buildings that give labs.
		for (const b of csvRows(buildingsCsv)) if (csvMap(b.stats)['research.labs']) research.addLab(b.id);
		for (const tech of Object.keys(FILE_EFFECTS))
			if (!research.list().some((t) => t.id === tech)) throw new PluginError(`effects.csv: unknown tech "${tech}"`);

		/* ----- the effects table and its GM rule ---------------------------------------- */

		const effects = ctx.config.define<Record<string, Effect[]>>('effects', {
			description:
				'What techs do per level, by tech (a tech listed here replaces all its rows). Each row: { kind: stat|percent|output|battle|time, target, value, family?, atLevel? } — see effects.csv.',
			default: () => FILE_EFFECTS,
			parse(raw) {
				if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw fail('bad_config', 'Expected { tech: [effects] }');
				const known = new Set(research.list().map((t) => t.id));
				const resourceIds = () => new Set(resources.list().map((r) => r.id));
				const terrainIds = () =>
					new Set(
						ctx.services
							.get('terrain')
							.list()
							.map((t) => t.id),
					);
				const out = { ...FILE_EFFECTS };
				for (const [tech, rows] of Object.entries(raw)) {
					if (!known.has(tech)) throw fail('bad_config', text('Unknown tech "{0}"', { 0: tech }));
					if (!Array.isArray(rows)) throw fail('bad_config', text('{0}: expected a list of effects', { 0: tech }));
					out[tech] = rows.map((e, i) => parseEffect(e, `${tech}[${i}]`, resourceIds, terrainIds));
				}
				// A rule may name stats the data file does not: make sure they are contributed to.
				for (const list of Object.values(out)) for (const e of list) ensureStat(e);
				return out;
			},
		});

		/** The summed value of every (kind, target) row over the player's tech levels. */
		async function total(api: ReadApi, playerId: string, kind: Kind, target: string, family?: string) {
			const levels = await research.levelsOf(api, playerId);
			let sum = 0;
			for (const [tech, rows] of Object.entries(effects.get(api)))
				for (const e of rows) if (e.kind === kind && e.target === target && e.family === family) sum += amount(e, levels.get(tech) ?? 0);
			return sum;
		}
		const ownerOf = async (api: ReadApi, target: string) =>
			target.startsWith('player:')
				? target.slice('player:'.length)
				: target.startsWith('settlement:')
					? ((await settlements.get(api, target.slice('settlement:'.length)))?.ownerId ?? null)
					: null;

		// Stats: flat and percent bonuses, and each resource's own production stat.
		const contributed = new Set<string>();
		function ensureStat(e: Effect) {
			if (e.kind !== 'stat' && e.kind !== 'percent' && e.kind !== 'output') return;
			const statId = e.kind === 'output' ? `resources.output.${e.target}` : e.target;
			const key = `${e.kind}:${e.target}`;
			if (contributed.has(key)) return;
			contributed.add(key);
			stats.contribute(statId, async (api, target) => {
				const owner = await ownerOf(api, target);
				if (!owner) return null;
				const sum = await total(api, owner, e.kind, e.target);
				return sum ? (e.kind === 'stat' ? { flat: sum } : { percent: sum }) : null;
			});
		}
		for (const list of Object.values(FILE_EFFECTS)) for (const e of list) ensureStat(e);

		// Battle: the side's player's techs, as modifiers named after the tech.
		battle.addModifier(async (api, side) => {
			if (!side.playerId) return [];
			const levels = await research.levelsOf(api, side.playerId);
			const names = new Map(research.list().map((t) => [t.id, t.name]));
			const out = [];
			for (const [tech, rows] of Object.entries(effects.get(api))) {
				const level = levels.get(tech) ?? 0;
				if (!level) continue;
				for (const e of rows)
					if (e.kind === 'battle')
						out.push({
							source: keyText(names.get(tech) ?? tech),
							stat: e.target as BattleStat,
							percent: amount(e, level),
							...(e.family ? { family: e.family } : {}),
						});
			}
			return out;
		});

		// Time and upkeep: each "x% less" multiplies by (1 - x%).
		const less = async (api: ReadApi, owner: string | null, target: string) =>
			owner ? Math.max(0, 1 - (await total(api, owner, 'time', target)) / 100) : 1;
		ctx.services.get('buildings').addTimeModifier((api, req) => less(api, req.settlement.ownerId, 'construction'));
		troops.addTrainingTimeModifier((api, s) => less(api, s.ownerId, 'training'));
		troops.addUpkeepModifier(async (api, settlementId) => less(api, (await settlements.get(api, settlementId))?.ownerId ?? null, 'upkeep'));
		research.addCostModifier(async (api, req) => ({ timeFactor: await less(api, req.playerId, 'research') }));

		// March speed: all units, or one family's.
		ctx.services.get('armies').addSpeedModifier(async (api, playerId, unit) => {
			const all = await total(api, playerId, 'speed', 'march');
			const own = unit.family ? await total(api, playerId, 'speed', 'march', unit.family) : 0;
			return Math.max(0, 1 + (all + own) / 100);
		});

		// Terrain: more of a resource where the district stands on some terrain ("river.food").
		ctx.services.get('terrain').addBonus(async (api, settlement, terrain) => {
			if (!settlement.ownerId) return {};
			const levels = await research.levelsOf(api, settlement.ownerId);
			const out: Record<string, number> = {};
			for (const [tech, rows] of Object.entries(effects.get(api)))
				for (const e of rows) {
					const [t, resource] = e.target.split('.');
					if (e.kind === 'terrain' && t === terrain) out[resource] = (out[resource] ?? 0) + amount(e, levels.get(tech) ?? 0);
				}
			return out;
		});

		// On the tech cards.
		research.addEffectDescriber((api, _playerId, tech) =>
			(effects.get(api)[tech] ?? []).map((e) => ({
				target: e.kind === 'stat' || e.kind === 'percent' ? e.target : `${e.kind}.${e.target}`,
				// Time effects are reductions: shown as negative.
				value: e.kind === 'time' ? -e.value : e.value,
				percent: e.kind !== 'stat',
				...(e.family ? { family: e.family, familyName: battle.families().find((f) => f.id === e.family)?.name ?? e.family } : {}),
				...(e.atLevel ? { atLevel: e.atLevel } : {}),
			})),
		);
	},
});
