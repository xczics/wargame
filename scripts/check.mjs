#!/usr/bin/env node
// Static checks of `pnpm check`: every error message has a translation, components name their plugin,
// formatting goes through the shared modules and templates hold no untranslated words.
//
// A plugin's `new GameError(code, message, status, owner)` reaches the client as the key "<owner>.<message>",
// so the message (a literal, or a template whose `${…}` parts are a pattern key's {0}, {1}…) must be a key of
// the owner's data/i18n.csv, and the owner must be given. Errors of the kernel (no owner) are translated by
// src/kernel/i18n.csv. Likewise every literal given to a plugin's `text(…)` (from `uiTexts('<id>')`).
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const root = new URL('..', import.meta.url).pathname;
const shape = (text) => text.replace(/\{\d+\}/g, '{}');

function csvKeys(file) {
	const keys = new Set();
	let header = true;
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		if (!line.trim() || line.startsWith('#')) continue;
		if (header) {
			header = false;
			continue;
		}
		const m = /^"((?:[^"]|"")*)"|^([^,]*)/.exec(line);
		keys.add((m[1] ?? m[2]).replace(/""/g, '"'));
	}
	return keys;
}

// Plugin id -> its keys (the dir's index.ts / server.ts names the id).
const keysOf = new Map();
const idOfDir = new Map(); // "src/plugins/<dir>" -> plugin id
for (const base of ['src/plugins', 'examples']) {
	for (const dir of readdirSync(join(root, base))) {
		const csv = join(root, base, dir, 'data/i18n.csv');
		const entry = ['index.ts', 'server.ts'].map((f) => join(root, base, dir, f)).find(existsSync);
		if (!entry || !existsSync(csv)) continue;
		const id = /\bid: '([a-z][a-z0-9-]*)'/.exec(readFileSync(entry, 'utf8'))?.[1];
		if (id) keysOf.set(id, csvKeys(csv));
		if (id) idOfDir.set(join(base, dir), id);
	}
}
// The kernel's own messages ("kernel.<key>").
keysOf.set('kernel', csvKeys(join(root, 'src/kernel/i18n.csv')));

function files(dir) {
	return readdirSync(dir).flatMap((f) => {
		const p = join(dir, f);
		if (statSync(p).isDirectory()) return f === 'node_modules' ? [] : files(p);
		return p.endsWith('.ts') && !p.endsWith('.d.ts') ? [p] : [];
	});
}

const problems = [];
let checked = 0;
for (const file of [...files(join(root, 'src')), ...files(join(root, 'examples'))]) {
	const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
	const inPlugin = /^(src\/plugins|examples)\//.test(relative(root, file));
	// The texts a message expression can be: literals, templates ("${…}" as {}), both sides of a condition,
	// and for a helper's parameter (`const fail = (m) => { throw new GameError(…, m, …) }`) the literals it is
	// called with. A value from elsewhere (a hook's reason) is another plugin's key already: not checked here.
	const texts = (e, where) => {
		if (!e) return [];
		if (ts.isParenthesizedExpression(e)) return texts(e.expression, where);
		if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
		if (ts.isTemplateExpression(e)) return [e.head.text + e.templateSpans.map((x) => `{}${x.literal.text}`).join('')];
		if (ts.isConditionalExpression(e)) return [...texts(e.whenTrue, where), ...texts(e.whenFalse, where)];
		if (ts.isIdentifier(e)) {
			let fn = e.parent;
			while (fn && !ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn) && !ts.isFunctionDeclaration(fn)) fn = fn.parent;
			const param = fn?.parameters.findIndex((p) => p.name.getText(source) === e.text) ?? -1;
			const name =
				fn && param >= 0
					? ts.isFunctionDeclaration(fn)
						? fn.name?.text
						: ts.isVariableDeclaration(fn.parent)
							? fn.parent.name.getText(source)
							: null
					: null;
			if (!name) return [];
			const out = [];
			const calls = (n) => {
				if (ts.isCallExpression(n) && n.expression.getText(source) === name) out.push(...texts(n.arguments[param], where));
				ts.forEachChild(n, calls);
			};
			calls(source);
			return out;
		}
		return [];
	};
	// A plugin file's errors come from `const fail = gameErrors('<id>')`: that id must be the plugin's own.
	const rel = relative(root, file);
	const dirKey = rel
		.split('/')
		.slice(0, inPlugin ? (rel.startsWith('src/') ? 3 : 2) : 0)
		.join('/');
	const factory = /const fail = gameErrors\('([a-z][a-z0-9-]*)'\)/.exec(readFileSync(file, 'utf8'))?.[1] ?? null;
	if (factory && idOfDir.get(dirKey) && factory !== idOfDir.get(dirKey))
		problems.push(`${rel}: gameErrors('${factory}') in plugin "${idOfDir.get(dirKey)}"`);
	// Display texts from `const text = uiTexts('<id>')` are keys of that plugin too.
	const textOwner = /const text = uiTexts\('([a-z][a-z0-9-]*)'\)/.exec(readFileSync(file, 'utf8'))?.[1] ?? null;
	// A key picked by id ("mission:${m.mission}", "stat:${side}.${stat}"): fine when the plugin has keys of that kind.
	const byId = (text) => /^[\w-]+:/.test(text) && !/\s/.test(text);
	const checkTexts = (message, where, id) => {
		for (const text of texts(message, where)) {
			if (byId(text)) {
				const kind = text.slice(0, text.indexOf(':') + 1);
				if (![...(keysOf.get(id) ?? [])].some((k) => k.startsWith(kind))) problems.push(`${where}: ${id} has no "${kind}…" keys`);
				continue;
			}
			// Layout only ("{0} · {1}", "—"): shown as it is, nothing to translate.
			if (!/\p{L}/u.test(text.replace(/\{[^}]*\}/g, ''))) continue;
			checked++;
			const keys = keysOf.get(id);
			if (!keys) problems.push(`${where}: plugin "${id}" has no data/i18n.csv`);
			else if (![...keys].some((k) => shape(k) === shape(text))) problems.push(`${where}: "${text}" is not a key of ${id}`);
		}
	};
	const visit = (node) => {
		const where = () => `${rel}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
		if (ts.isNewExpression(node) && node.expression.getText(source) === 'GameError') {
			if (inPlugin) problems.push(`${where()}: use the plugin's \`fail\` (gameErrors), not new GameError`);
			else checkTexts(node.arguments?.[1], where(), 'kernel');
		}
		if (ts.isCallExpression(node) && node.expression.getText(source) === 'fail' && factory) checkTexts(node.arguments[1], where(), factory);
		if (ts.isCallExpression(node) && node.expression.getText(source) === 'text' && textOwner) {
			const arg = node.arguments[0];
			if (arg && ts.isTemplateExpression(arg) && !byId(arg.head.text))
				problems.push(`${where()}: text() takes a key; put the variable parts in its vars`);
			else checkTexts(arg, where(), textOwner);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
}

// A client plugin's words are its own keys ("@<plugin>.<text>"), found by the game its components get from
// `useGame('<plugin>')`: each component must name the plugin it belongs to (web/plugins/<dir>: that plugin;
// web/widgets: "widgets"; examples/<dir>: the example's client plugin).
const clientId = (dir, entry) => (existsSync(entry) ? /\bid: '([a-z][a-z0-9-]*)'/.exec(readFileSync(entry, 'utf8'))?.[1] : undefined);
const owners = [
	['web/widgets', () => 'widgets'],
	['web/plugins', (dir) => clientId(dir, join(root, 'web/plugins', dir, 'index.ts'))],
	['examples', (dir) => clientId(dir, join(root, 'examples', dir, 'client.ts'))],
];
for (const [base, idOf] of owners) {
	const all = readdirSync(join(root, base), { recursive: true }).filter((f) => /\.(vue|ts)$/.test(f));
	for (const f of all) {
		const text = readFileSync(join(root, base, f), 'utf8');
		const id = idOf(f.split('/')[0]);
		for (const m of text.matchAll(/useGame\(([^)]*)\)/g))
			if (m[1] !== `'${id}'`) problems.push(`${base}/${f}: useGame(${m[1]}) should be useGame('${id}')`);
	}
}

// Shared formatting only (architecture review E): numbers and dates through src/shared/format.ts /
// web/core/format.ts, heroes' names through `heroes.nameKey` (name-part keys the client spells).
const formatters = new Set(['src/shared/format.ts', 'web/core/format.ts']);
for (const file of [...files(join(root, 'src')), ...files(join(root, 'examples')), ...files(join(root, 'web'))]) {
	const where = relative(root, file);
	if (formatters.has(where)) continue;
	const text = readFileSync(file, 'utf8');
	text.split('\n').forEach((line, i) => {
		if (/\.toLocale(String|DateString|TimeString)\(/.test(line))
			problems.push(`${where}:${i + 1}: format with src/shared/format.ts or web/core/format.ts`);
		if (/\$\{[\w.!()]*surname\} \$\{[\w.!()]*given\}/.test(line) && !/const nameKey =/.test(line))
			problems.push(`${where}:${i + 1}: send a hero's name with heroes.nameKey`);
	});
}
// Words in .vue templates go through game.t: no English typed straight into the markup.
for (const base of ['web', 'examples']) {
	for (const f of readdirSync(join(root, base), { recursive: true }).filter((f) => f.endsWith('.vue'))) {
		const source = readFileSync(join(root, base, f), 'utf8');
		const start = source.indexOf('<template>');
		const end = source.lastIndexOf('</template>');
		if (start < 0 || end < 0) continue;
		const template = source
			.slice(start + 10, end)
			.replace(/<!--[\s\S]*?-->/g, '')
			.replace(/\{\{[\s\S]*?\}\}/g, ' ')
			.replace(/<(?:"[^"]*"|'[^']*'|[^'">])*>/g, '\n');
		for (const piece of template.split('\n')) {
			const words = piece
				.replace(/&[a-z]+;/g, '')
				.replace(/\b(GM|Wargame)\b/g, '')
				.trim();
			if (/[A-Za-z]{2,}/.test(words)) problems.push(`${base}/${f}: untranslated text in the template: "${piece.trim().slice(0, 60)}"`);
		}
	}
}

if (problems.length) {
	console.error(`Static checks failed (${problems.length}):\n${problems.map((p) => `  ${p}`).join('\n')}`);
	process.exit(1);
}
console.log(`check: ${checked} error messages and texts translated; formatting and templates clean`);
