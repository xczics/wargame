/**
 * The CSV parser itself, with no imports: the build runs it too (`csvPrecompile` in vite.config.ts), so the rows a
 * Worker reads precompiled are exactly the ones `csvRows` (src/kernel/data.ts) would parse.
 *
 * Format: the first line is the header; blank lines and lines starting with `#` are skipped; cells may be quoted
 * ("a, b") with "" for a quote inside.
 */

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

/** Rows as `{ header: cell }` objects (empty cells are ""); throws a plain `Error` for a malformed line. */
export function parseTable(text: string): Record<string, string>[] {
	const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trimStart().startsWith('#'));
	if (!lines.length) return [];
	const header = splitLine(lines[0]);
	return lines.slice(1).map((line, i) => {
		const cells = splitLine(line);
		if (cells.length > header.length) throw new Error(`CSV line ${i + 2}: more cells than columns (${header.join(', ')})`);
		return Object.fromEntries(header.map((h, j) => [h, cells[j] ?? '']));
	});
}

/** What the build stores for a table: its rows as JSON. */
export const csvRowsJson = (text: string) => JSON.stringify(parseTable(text));
