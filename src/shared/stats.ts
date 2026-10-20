/**
 * Where a number comes from, as data and as the lines players read (AGENTS.md: the server sends data, the browser words
 * it). The stats plugin works out the parts (`stats.breakdown`, `stats.factorParts`); views send them as they are, and
 * the browser (or a server view not moved yet, through `stats.describe` / `stats.factors`) turns them into lines here.
 * Each source is a label key of the plugin that gives the bonus (a name, "Heroes on duty"), from the meta's translations.
 */
import { signed, whole } from './format';
import { uiTexts } from './i18n';
import type { UiText } from './ui';

const text = uiTexts('stats');

/** One source of a stat's value: what it adds (`flat`) and by how much it raises the sum (`percent`). */
export interface StatPart {
	source: UiText;
	flat: number;
	percent: number;
}

/** A multiplier from a named source (e.g. a time modifier): 0.88 = 12% less. */
export interface FactorPart {
	source: UiText;
	factor: number;
}

/** A stat's base and its parts (`stats.breakdown` without the value), as views send it. */
export interface StatBreakdown {
	base: number;
	parts: StatPart[];
}

/**
 * Parts as lines: "Institute +20%", "Warehouse +50,000". `flatAsPercent`: flat bonuses are shares of 1 (a speed of
 * 1 + 0.2 shows "+20%"). `base`: a first line "Base 10,000".
 */
export function partTexts(parts: StatPart[], options: { flatAsPercent?: boolean; base?: number } = {}): UiText[] {
	const line = (source: UiText, value: string) => text('{0} {1}', { 0: source, 1: value });
	const out = options.base !== undefined ? [text('Base {0}', { 0: whole(options.base) })] : [];
	for (const p of parts) {
		if (p.flat) out.push(line(p.source, options.flatAsPercent ? signed(p.flat * 100, true, 1) : signed(p.flat)));
		if (p.percent) out.push(line(p.source, signed(p.percent, true, 1)));
	}
	return out;
}

/** A breakdown with its base first ("Base 10,000", "Warehouse +50,000"). */
export const breakdownTexts = (b: StatBreakdown) => partTexts(b.parts, { base: b.base });

/** Factors as lines: 0.88 → "Heroes on duty −12%" (time, cost...). Factors of 1 are left out. */
export const factorTexts = (parts: FactorPart[]): UiText[] =>
	parts.filter((p) => p.factor !== 1).map((p) => text('{0} {1}', { 0: p.source, 1: signed((p.factor - 1) * 100, true, 1) }));
