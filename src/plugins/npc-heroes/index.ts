/**
 * NPC heroes (user 2026-11-18: "要不要单独写个NPC英雄生成器?"; "然后流寇、营寨也可以用得上？"; "我是想做出'活人感'的NPC
 * 英雄。就是像不同阶段的玩家能养出来的英雄。"): leaders for those who have no heroes of their own (a trade route's enemy
 * columns; later bandits, NPC camps), made to a spec, "a hero of this venue, recruited when its building was at this
 * level, now at this level", the way a player would have raised one. This plugin knows no venue: the content that
 * recruits heroes says how (`addRecipe`: its own draw, talents and a player-like way of spending the free points), with
 * a random fixed by a seed (the place it stands), so every general is a person of its own and the same one each time.
 * What a general gives in a fight is the heroes' content's business too: pass it as a battle side's `generals`.
 */
import { definePlugin, PluginError, type RuleView, seededRandom } from '../../kernel';
import type { NpcHero, NpcHeroSpec } from '../../shared/npc-heroes';

export type { NpcHero, NpcHeroSpec } from '../../shared/npc-heroes';

/** A hero of the venue to the spec, drawn with `random`: attributes at its level, name keys, its build (a text key). */
export type NpcRecipe = (api: RuleView, spec: NpcHeroSpec, random: () => number) => Omit<NpcHero, keyof NpcHeroSpec>;

export interface NpcHeroesService {
	addRecipe(venue: string, recipe: NpcRecipe): void;
	/** The hero of the spec standing at `seed` (the same seed, the same hero). */
	make(api: RuleView, spec: NpcHeroSpec, seed: string): NpcHero;
}

declare module '../../kernel' {
	interface ServiceMap {
		npcHeroes: NpcHeroesService;
	}
}

export default definePlugin({
	id: 'npc-heroes',
	version: '0.1.0',
	description: 'NPC heroes: leaders made to a spec (venue, its level, the hero level), as a player would have raised them',
	setup(ctx) {
		const recipes = new Map<string, NpcRecipe>();
		ctx.services.provide('npcHeroes', {
			addRecipe(venue, recipe) {
				if (recipes.has(venue)) throw new PluginError(`npc-heroes: a recipe for "${venue}" twice`);
				recipes.set(venue, recipe);
			},
			make(api, spec, seed) {
				const recipe = recipes.get(spec.venue);
				if (!recipe) throw new PluginError(`npc-heroes: no recipe for venue "${spec.venue}"`);
				return { ...spec, ...recipe(api, spec, seededRandom(`npc-heroes:${seed}`)) };
			},
		});
	},
});
