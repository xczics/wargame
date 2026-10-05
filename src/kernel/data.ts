/**
 * Plain-text data tables for plugins: content and design numbers live in CSV files next to
 * the plugin (`data/*.csv`, imported with `?raw`), not in code. These helpers only parse;
 * each plugin validates what it reads, like any other untrusted input.
 *
 * Format: the first line is the header; blank lines and lines starting with `#` are skipped;
 * cells may be quoted ("a, b") with "" for a quote inside.
 */
import { PluginError } from './errors';
import type { PlanRow } from '../shared/levels';

function splitLine(line: string): string[] {
	const cells: string[] = [];
	let cell = '';
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (quoted) {
			if (c === '"' && line[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (c === '"') quoted = false;
			else cell += c;
		} else if (c === '"') quoted = true;
		else if (c === ',') {
			cells.push(cell.trim());
			cell = '';
		} else cell += c;
	}
	cells.push(cell.trim());
	return cells;
}

/** Rows of a CSV table as `{ header: cell }` objects (empty cells are ""). */
export function csvRows(text: string): Record<string, string>[] {
	const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trimStart().startsWith('#'));
	if (!lines.length) return [];
	const header = splitLine(lines[0]);
	return lines.slice(1).map((line, i) => {
		const cells = splitLine(line);
		if (cells.length > header.length) throw new PluginError(`CSV line ${i + 2}: more cells than columns (${header.join(', ')})`);
		return Object.fromEntries(header.map((h, j) => [h, cells[j] ?? '']));
	});
}

/** A number cell; throws a clear error for anything else (empty allowed only with a fallback). */
export function csvNumber(row: Record<string, string>, column: string, fallback?: number): number {
	const raw = row[column];
	if (raw === undefined || raw === '') {
		if (fallback !== undefined) return fallback;
		throw new PluginError(`CSV: missing number in column "${column}" (${JSON.stringify(row)})`);
	}
	const n = Number(raw);
	if (!Number.isFinite(n)) throw new PluginError(`CSV: "${raw}" in column "${column}" is not a number`);
	return n;
}

/** "food:1; wood:2.5" -> { food: 1, wood: 2.5 } (empty -> {}). */
export function csvMap(cell: string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const part of cell
		.split(';')
		.map((p) => p.trim())
		.filter(Boolean)) {
		const [k, v] = part.split(':').map((x) => x.trim());
		const n = Number(v);
		if (!k || !Number.isFinite(n)) throw new PluginError(`CSV: bad "key:number" pair "${part}"`);
		out[k] = n;
	}
	return out;
}

/**
 * A rules table with columns `key,value` (plus any notes columns): numbers by dotted key,
 * e.g. `casualty.crushing,0.3` -> { casualty: { crushing: 0.3 } }.
 */
export function csvRules(text: string): Record<string, any> {
	const out: Record<string, any> = {};
	for (const row of csvRows(text)) {
		const path = row.key.split('.');
		let node = out;
		for (const p of path.slice(0, -1)) node = node[p] ??= {};
		node[path.at(-1)!] = csvNumber(row, 'value');
	}
	return out;
}

/**
 * Planning tables: one row per level with an id column (default "id"), "level", "seconds",
 * and one column per resource (empty = not needed). Returns each id's rows by level
 * (index = level - 1); levels without a row are null — they grow from the nearest lower row
 * (see `planRow`). Level 1 must be given.
 */
export function csvLevels(text: string, idColumn = 'id'): Map<string, (PlanRow | null)[]> {
	const out = new Map<string, (PlanRow | null)[]>();
	for (const row of csvRows(text)) {
		const cost: Record<string, number> = {};
		for (const [col, cell] of Object.entries(row)) {
			if (col === idColumn || col === 'level' || col === 'seconds' || col === 'note' || cell === '') continue;
			cost[col] = csvNumber(row, col);
		}
		const level = csvNumber(row, 'level');
		if (!Number.isInteger(level) || level < 1) throw new PluginError(`CSV: level must be a whole number from 1 ("${row[idColumn]}")`);
		const list = out.get(row[idColumn]) ?? [];
		while (list.length < level) list.push(null);
		if (list[level - 1]) throw new PluginError(`CSV: level ${level} of "${row[idColumn]}" given twice`);
		list[level - 1] = { cost, seconds: csvNumber(row, 'seconds') };
		out.set(row[idColumn], list);
	}
	for (const [id, rows] of out) if (!rows[0]) throw new PluginError(`CSV: "${id}" has no level 1`);
	return out;
}

// The level math both ends use (the client works out building cards past their table): in src/shared/levels.ts.
export { planRow, stagedGrowth, type GrowthStage, type PlanRow } from '../shared/levels';
