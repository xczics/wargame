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

export interface StatDef {
	id: string;
	description: string;
	/** Base value for a target (e.g. read a config handle). */
	base(api: ReadApi, target: string): number;
	integer?: boolean;
	min?: number;
	max?: number;
}

export interface Bonus {
	flat?: number;
	percent?: number;
}

/** Returns the bonus a source grants to `target` (an entity id like "settlement:<id>" or "player:<id>"). */
export type Contributor = (api: ReadApi, target: string) => Promise<Bonus | null>;

export interface StatsService {
	define(def: StatDef): void;
	contribute(statId: string, contributor: Contributor): void;
	get(api: ReadApi, statId: string, target: string): Promise<number>;
	list(): readonly StatDef[];
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
	setup(ctx) {
		const defs = new Map<string, StatDef>();
		const contributors = new Map<string, Contributor[]>();

		const service: StatsService = {
			define(def) {
				if (defs.has(def.id)) throw new PluginError(`Stat "${def.id}" defined twice`);
				defs.set(def.id, def);
			},
			contribute(statId, contributor) {
				const list = contributors.get(statId) ?? [];
				list.push(contributor);
				contributors.set(statId, list);
			},
			// Not memoised: contributors read memoised rows, and values must reflect changes made earlier in the same command.
			async get(api, statId, target) {
				const def = defs.get(statId);
				if (!def) throw new PluginError(`Unknown stat "${statId}"`);
				let flat = def.base(api, target);
				let percent = 0;
				for (const c of contributors.get(statId) ?? []) {
					const b = await c(api, target);
					flat += b?.flat ?? 0;
					percent += b?.percent ?? 0;
				}
				let value = flat * (1 + percent / 100);
				if (def.integer) value = Math.floor(value);
				if (def.min !== undefined) value = Math.max(def.min, value);
				if (def.max !== undefined) value = Math.min(def.max, value);
				return value;
			},
			list: () => [...defs.values()],
		};
		ctx.services.provide('stats', service);
		ctx.meta.add('stats', () => service.list().map(({ id, description }) => ({ id, description })));
	},
});
