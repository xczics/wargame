/**
 * Stats: numbers that other systems can raise — limits, capacities, queue sizes.
 *
 * value = (base + sum of flat bonuses) * (1 + sum of percent bonuses / 100)
 *
 * The owner of a stat defines it (with a base, usually a GM-tunable config); anything
 * else — buildings, research, items, events — adds contributors. Nothing that grants a
 * bonus needs to know who consumes it, and vice versa.
 */
import { definePlugin, PluginError, type ReadApi } from '../../kernel';
import { signed, whole } from '../../shared/format';
import { keyText, uiTexts } from '../../shared/i18n';
import type { UiText } from '../../shared/ui';
import i18nCsv from './data/i18n.csv?raw';

const text = uiTexts('stats');

export interface StatDef {
	id: string;
	/** A key of the defining plugin's translations, or a text built from others' ("{0} level cap"). */
	description: string | UiText;
	/** The value is a percentage (bonuses show as "+3%"). */
	percent?: boolean;
	/** Base value for a target (e.g. read a config handle). */
	base(api: ReadApi, target: string): number;
	integer?: boolean;
	min?: number;
	max?: number;
	/** Bookkeeping, not an effect to show players (e.g. how many labs a settlement has). */
	hidden?: boolean;
}

export interface Bonus {
	flat?: number;
	percent?: number;
	/** Where it comes from, when it depends on the target (e.g. "Institute Lv 3"); else the contributor's own. */
	source?: UiText;
}

/** A multiplier from a named source (e.g. a time modifier): 0.88 = 12% less. */
export interface FactorPart {
	source: UiText;
	factor: number;
}

/** One source of a stat's value, as players see it (`breakdown`). */
export interface StatPart {
	source: UiText;
	flat: number;
	percent: number;
}

/**
 * Returns the bonus a source grants to `target` (an entity id like "settlement:<id>" or "player:<id>"); one
 * contributor standing for several sources (every tech, every building) returns one bonus per source.
 */
export type Contributor = (api: ReadApi, target: string) => Promise<Bonus | Bonus[] | null>;

export interface StatsService {
	define(def: StatDef): void;
	/** `source`: what players see it as, unless a bonus names its own (contributions without one show as "Other"). */
	contribute(statId: string, contributor: Contributor, source?: UiText): void;
	get(api: ReadApi, statId: string, target: string): Promise<number>;
	/** The value and where it comes from: the base, then each bonus that applies (sources named alike are summed). */
	breakdown(api: ReadApi, statId: string, target: string): Promise<{ base: number; parts: StatPart[]; value: number }>;
	/**
	 * A breakdown as lines players read: "Institute +20%", "Warehouse +50,000". `flatAsPercent`: flat bonuses
	 * are shares of 1 (a speed of 1 + 0.2 shows "+20%"). `base`: a first line "Base 10,000".
	 */
	describe(parts: StatPart[], options?: { flatAsPercent?: boolean; base?: number }): UiText[];
	/** Factors from named sources as lines: 0.88 → "Heroes on duty −12%" (time, cost...). Factors of 1 are left out. */
	factors(parts: FactorPart[]): UiText[];
	/** Factors by source, as modifier owners collect them: same-named sources multiply into one part; unnamed ones are "Other". */
	factorParts(entries: { source?: UiText; factor: number }[]): FactorPart[];
	list(): readonly (StatDef & { description: UiText })[];
}

declare module '../../kernel' {
	interface ServiceMap {
		stats: StatsService;
	}
}

export default definePlugin({
	id: 'stats',
	version: '0.1.0',
	description: 'Base values plus bonuses from any plugin (limits, capacities, ...)',
	dependsOn: ['i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const defs = new Map<string, StatDef & { description: UiText }>();
		const contributors = new Map<string, { fn: Contributor; source?: UiText }[]>();
		const other = text('Other');

		/** Every bonus that applies, with its source (in the order contributed). */
		async function collect(api: ReadApi, statId: string, target: string) {
			const def = defs.get(statId);
			if (!def) throw new PluginError(`Unknown stat "${statId}"`);
			const parts: StatPart[] = [];
			for (const c of contributors.get(statId) ?? []) {
				const got = await c.fn(api, target);
				for (const b of Array.isArray(got) ? got : got ? [got] : [])
					if (b.flat || b.percent) parts.push({ source: b.source ?? c.source ?? other, flat: b.flat ?? 0, percent: b.percent ?? 0 });
			}
			return { def, base: def.base(api, target), parts };
		}
		function valueOf(def: StatDef, base: number, parts: StatPart[]) {
			const flat = parts.reduce((a, p) => a + p.flat, base);
			const percent = parts.reduce((a, p) => a + p.percent, 0);
			let value = flat * (1 + percent / 100);
			if (def.integer) value = Math.floor(value);
			if (def.min !== undefined) value = Math.max(def.min, value);
			if (def.max !== undefined) value = Math.min(def.max, value);
			return value;
		}

		const service: StatsService = {
			define(def) {
				if (defs.has(def.id)) throw new PluginError(`Stat "${def.id}" defined twice`);
				const description = typeof def.description === 'string' ? keyText(ctx.services.get('i18n').own(def.description)) : def.description;
				defs.set(def.id, { ...def, description });
			},
			contribute(statId, contributor, source) {
				const list = contributors.get(statId) ?? [];
				list.push({ fn: contributor, ...(source ? { source } : {}) });
				contributors.set(statId, list);
			},
			// Not memoised: contributors read memoised rows, and values must reflect changes made earlier in the same command.
			async get(api, statId, target) {
				const { def, base, parts } = await collect(api, statId, target);
				return valueOf(def, base, parts);
			},
			async breakdown(api, statId, target) {
				const { def, base, parts } = await collect(api, statId, target);
				// One line per source: two techs both called "Agriculture"... are the same thing to a player.
				const merged = new Map<string, StatPart>();
				for (const p of parts) {
					const key = JSON.stringify(p.source);
					const m = merged.get(key);
					if (m) {
						m.flat += p.flat;
						m.percent += p.percent;
					} else merged.set(key, { ...p });
				}
				return { base, parts: [...merged.values()], value: valueOf(def, base, parts) };
			},
			describe(parts, options = {}) {
				const line = (source: UiText, value: string) => text('{0} {1}', { 0: source, 1: value });
				const out = options.base !== undefined ? [text('Base {0}', { 0: whole(options.base) })] : [];
				for (const p of parts) {
					if (p.flat) out.push(line(p.source, options.flatAsPercent ? signed(p.flat * 100, true, 1) : signed(p.flat)));
					if (p.percent) out.push(line(p.source, signed(p.percent, true, 1)));
				}
				return out;
			},
			factors: (parts) =>
				parts.filter((p) => p.factor !== 1).map((p) => text('{0} {1}', { 0: p.source, 1: signed((p.factor - 1) * 100, true, 1) })),
			factorParts(entries) {
				const by = new Map<string, FactorPart>();
				for (const e of entries) {
					const source = e.source ?? other;
					const key = JSON.stringify(source);
					const p = by.get(key);
					if (p) p.factor *= e.factor;
					else by.set(key, { source, factor: e.factor });
				}
				return [...by.values()];
			},
			list: () => [...defs.values()],
		};
		ctx.services.provide('stats', service);
		ctx.meta.add('stats', () =>
			service.list().map(({ id, description, percent }) => ({ id, description, ...(percent ? { percent } : {}) })),
		);
	},
});
