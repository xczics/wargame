#!/usr/bin/env node
// Every message a player can be shown in an error has a translation (part of `pnpm check`).
//
// A plugin's `new GameError(code, message, status, owner)` reaches the client as the key "<owner>.<message>",
// so the message (a literal, or a template whose `${…}` parts are a pattern key's {0}, {1}…) must be a key of
// the owner's data/i18n.csv, and the owner must be given. Errors of the kernel (no owner) are translated by
// the client core (web/core/messages.ts). The other texts (views, forms, meta) are covered by the i18n tests.
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
for (const base of ['src/plugins', 'examples']) {
	for (const dir of readdirSync(join(root, base))) {
		const csv = join(root, base, dir, 'data/i18n.csv');
		const entry = ['index.ts', 'server.ts'].map((f) => join(root, base, dir, f)).find(existsSync);
		if (!entry || !existsSync(csv)) continue;
		const id = /\bid: '([a-z][a-z0-9-]*)'/.exec(readFileSync(entry, 'utf8'))?.[1];
		if (id) keysOf.set(id, csvKeys(csv));
	}
}
const kernelKeys = new Set(
	[...readFileSync(join(root, 'web/core/messages.ts'), 'utf8').matchAll(/^\t(?:'((?:[^'\\]|\\.)*)'|(\w+)):/gm)].map((m) => m[1] ?? m[2]),
);

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
	const visit = (node) => {
		if (ts.isNewExpression(node) && node.expression.getText(source) === 'GameError') {
			const [, message, , owner] = node.arguments ?? [];
			const where = `${relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
			const id = owner && ts.isStringLiteral(owner) ? owner.text : null;
			if (inPlugin && !id) problems.push(`${where}: no owner (4th argument: the plugin id)`);
			for (const text of texts(message, where)) {
				checked++;
				const keys = id ? keysOf.get(id) : kernelKeys;
				if (!keys) problems.push(`${where}: plugin "${id}" has no data/i18n.csv`);
				else if (![...keys].some((k) => shape(k) === text))
					problems.push(`${where}: "${text}" is not a key of ${id ?? 'web/core/messages.ts'}`);
			}
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

if (problems.length) {
	console.error(`Untranslated error messages (${problems.length}):\n${problems.map((p) => `  ${p}`).join('\n')}`);
	process.exit(1);
}
console.log(`i18n: ${checked} error messages, all translated`);
