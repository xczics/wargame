// Plugin names and rule descriptions: each server plugin ships them as its own keys ("<id>.plugin:<id>",
// "<owner>.rule:<key>"); the kernel's are in src/kernel/i18n.csv ("kernel.rule:<key>").
import type { ConfigEntry } from '../../../src/shared/api';
import type { Game } from '../../core/game';

const first = (game: Game, keys: string[]) => keys.find((k) => game.hasText(k));

export function pluginName(game: Game, id: string): string {
	const key = first(game, [`${id}.plugin:${id}`, `plugin:${id}`]);
	return key ? game.t(key) : id;
}

export function ruleText(game: Game, rule: ConfigEntry): string {
	const key = first(game, [`${rule.owner}.rule:${rule.key}`, `rule:${rule.key}`]);
	return game.t(key ?? rule.description);
}
