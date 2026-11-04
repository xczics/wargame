/**
 * Where a number comes from, as data and as the lines players read (AGENTS.md: the server sends data, the browser words
 * it). The stats plugin works out the parts (`stats.breakdown`, `stats.factorParts`); views send them as they are, and
 * the browser turns them into lines here.
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

/**
 * Time factors as speed: 0.8 → "Heroes on duty +25%" (time ÷ 1.25 = speed × 1.25). A time cut reads as the speed it
 * gives, which says exactly what it does however they pile up (user 2026-11-04: "建造速度 +X%"…"统一修改之").
 */
export const speedTexts = (parts: FactorPart[]): UiText[] =>
	parts
		.filter((p) => p.factor !== 1 && p.factor > 0)
		.map((p) => text('{0} {1}', { 0: p.source, 1: signed((1 / p.factor - 1) * 100, true, 1) }));

/** Factors as lines: 0.88 → "Heroes on duty −12%" (cost, upkeep...). Factors of 1 are left out. */
export const factorTexts = (parts: FactorPart[]): UiText[] =>
	parts.filter((p) => p.factor !== 1).map((p) => text('{0} {1}', { 0: p.source, 1: signed((p.factor - 1) * 100, true, 1) }));

/**
 * A decrease's factor for a percent: 1 / (1 + p / 100) (100% = half, never to nothing): speed bonuses, cost cuts, fewer
 * losses. Every decrease goes through it, its sources' points summed first (user 2026-11-04: "这些加速、减消耗的效果
 * 叠加时，设计上都是让它有效果，但又不能溢出到0"): each more point still helps, less and less, and nothing reaches 0.
 */
export const reduction = (percent: number) => 1 / (1 + percent / 100);
/** A signed percent as a factor: more by 1 + p / 100, less (negative) by `reduction`, so a pile of cuts never reaches 0. */
export const percentFactor = (percent: number) => (percent >= 0 ? 1 + percent / 100 : reduction(-percent));
