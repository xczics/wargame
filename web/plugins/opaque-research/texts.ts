// Applications as players read them: the sentences picked from the static texts by the application's tags and seed
// (the same application, the same text, on every screen), the placeholders filled in the player's language.
import type { OpaqueApplication, OpaqueTexts } from '../../../src/shared/api';
import { seededRandom } from '../../../src/shared/random';

export const SECTIONS = ['background', 'content', 'method', 'basis'] as const;
export type Translate = (text: string, vars?: Record<string, string | number>) => string;

/** What a group gives, by name ("Stone production, Wood production"): its bonuses as the rule lays them out. */
export const groupName = (group: number, texts: OpaqueTexts, t: Translate) =>
	(texts.groups[group] ?? [])
		.map((p) => texts.bonuses[p.bonus])
		.filter(Boolean)
		.map((b) => t(b.name))
		.join(t(', '));

/** The names a sentence may use: the dimension's code name, its group's bonus, the hero and its best attribute... */
export function placeholders(a: OpaqueApplication, texts: OpaqueTexts, t: Translate, tierName: string) {
	return {
		code: t(texts.codes[a.target] ?? String(a.target)),
		bonus: groupName(a.group, texts, t),
		attr: texts.attributes[a.tags.attr] ? t(texts.attributes[a.tags.attr]) : '',
		hero: t(a.heroName),
		tier: tierName,
		rate: `${Math.round(a.rate * 100)}%`,
	};
}

/** Up to `count` sentences of a section that fit the tags, drawn by weight without repeats. */
export function pick(a: OpaqueApplication, texts: OpaqueTexts, section: string, count: number): string[] {
	const fit = texts.sentences.filter((s) => s.section === section && Object.entries(s.when).every(([k, v]) => a.tags[k] === v));
	const random = seededRandom(`${a.seed}:${section}`);
	const out: string[] = [];
	while (out.length < count && fit.length) {
		const total = fit.reduce((n, s) => n + s.weight, 0);
		let r = random() * total;
		const i = Math.max(
			0,
			fit.findIndex((s) => (r -= s.weight) < 0),
		);
		out.push(fit[i].text);
		fit.splice(i, 1);
	}
	return out;
}

/** The reviewer of a review (anonymous, as reviews are). */
export const reviewer = (a: OpaqueApplication, texts: OpaqueTexts) =>
	texts.reviewers[Math.floor(seededRandom(`${a.seed}:reviewer`)() * texts.reviewers.length)] ?? '';
