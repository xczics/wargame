#!/usr/bin/env node
/**
 * `pnpm setup:cloudflare`: put the game on Cloudflare, step by step, asking as it goes (docs/deployment.md §5). Safe to
 * run again: what exists (database, bucket, secrets) is reused, and it can update a deployment (new domain...).
 *
 *   1. log in (wrangler), pick the account;
 *   2. the D1 database (created where the players are) and the R2 bucket (R2 has to be enabled in the dashboard once);
 *   3. writes your own copy of wrangler.jsonc, wrangler.production.jsonc (not committed: database id, domain, account),
 *      with its `production` environment between the cloudflare-setup markers;
 *   4. applies the migrations, runs the Worker next to the database (placement), deploys with the secrets (GM name,
 *      initial GM password, the usage guard's API token: asked here, never written to disk but a 0600 temp file that
 *      is removed right after);
 *   5. optionally: the bucket's public domain (+ CORS), a new map generated and imported.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const BASE = 'wrangler.jsonc';
/** The deployment's own config: never committed (.gitignore). */
const CONFIG = 'wrangler.production.jsonc';
const BEGIN = '// cloudflare-setup:begin';
const END = '// cloudflare-setup:end';
const DB = 'wargame-db';
const BUCKET = 'wargame-files';
const WORKER = 'wargame';

/* ----- terminal ------------------------------------------------------------------------------------- */

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let muted = false;
const write = rl._writeToOutput.bind(rl);
rl._writeToOutput = (s) => (muted ? (s.includes('\n') ? write('\n') : undefined) : write(s));
const question = (q) => new Promise((ok) => rl.question(q, ok));
async function ask(q, fallback = '') {
	const a = (await question(fallback ? `${q} [${fallback}]: ` : `${q}: `)).trim();
	return a || fallback;
}
async function yes(q, fallback = true) {
	const a = (await question(`${q} [${fallback ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();
	return a ? a.startsWith('y') : fallback;
}
async function secret(q) {
	process.stdout.write(`${q}: `);
	muted = true;
	const a = await question('');
	muted = false;
	return a;
}
const step = (n, text) => console.log(`\n\x1b[1m${n}. ${text}\x1b[0m`);
const note = (text) => console.log(`   ${text}`);
function stop(text) {
	console.error(`\n✘ ${text}`);
	rl.close();
	process.exit(1);
}

/* ----- commands ------------------------------------------------------------------------------------- */

let account = '';
const env = () => ({ ...process.env, ...(account ? { CLOUDFLARE_ACCOUNT_ID: account } : {}) });
/** Run and capture (stdout + stderr). */
function run(cmd, args, input) {
	const r = spawnSync(cmd, args, { encoding: 'utf8', env: env(), input, maxBuffer: 64 * 1024 * 1024 });
	return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
/** Run in the terminal (the user sees it, answers its own questions). */
function show(cmd, args, extraEnv = {}) {
	return spawnSync(cmd, args, { stdio: 'inherit', env: { ...env(), ...extraEnv } }).status === 0;
}
const wrangler = (...args) => run('pnpm', ['exec', 'wrangler', ...args]);

/* ----- wrangler.jsonc ------------------------------------------------------------------------------- */

function currentBlock() {
	if (!existsSync(CONFIG)) copyFileSync(BASE, CONFIG);
	const text = readFileSync(CONFIG, 'utf8');
	const a = text.indexOf(BEGIN);
	const b = text.indexOf(END);
	if (a < 0 || b < 0) stop(`${CONFIG}: the "${BEGIN}" / "${END}" markers are missing`);
	return text.slice(a, b);
}
const pick = (block, re) => re.exec(block)?.[1] ?? '';

function writeBlock(c) {
	const lines = [
		`${BEGIN} (written by \`pnpm setup:cloudflare\`; edit by hand or run it again)`,
		'/**',
		' * The deployment on Cloudflare (`CLOUDFLARE_ENV=production`, set by `pnpm run deploy` and `pnpm db:migrate`). The',
		' * top level stays without a database id: local dev, tests and Docker keep their own database (with an id, the local',
		' * database file would change). Bindings and vars are not inherited, so they are given again here.',
		' */',
		'"env": {',
		'	"production": {',
		`		"name": "${WORKER}",`,
		'		// Run next to the database: a sync makes a dozen queries one after another, each a round trip from where the',
		'		// Worker runs (across continents ~250 ms each). Named from where the database answers; else Smart Placement.',
		c.region ? `		"placement": { "region": "${c.region}" },` : '		"placement": { "mode": "smart" },',
		'		// Every minute: each task keeps its own pace (`every`, `probe`: src/runtime/tasks.ts); with nothing to do a run is one D1 call.',
		'		"triggers": { "crons": ["* * * * *"] },',
		`		"d1_databases": [{ "binding": "DB", "database_name": "${DB}", "database_id": "${c.databaseId}", "migrations_dir": "migrations" }],`,
		`		"r2_buckets": [{ "binding": "FILES", "bucket_name": "${BUCKET}" }],`,
		'		// CF_ACCOUNT_ID, FILES_BUCKET and the secret CF_API_TOKEN: the usage guard (src/plugins/usage-guard) asks what R2',
		'		// used and pauses the game near its free tier; required, so nothing deploys unguarded.',
		`		"vars": { "FILES_BASE_URL": "${c.filesUrl}", "CF_ACCOUNT_ID": "${account}", "FILES_BUCKET": "${BUCKET}" },`,
		'		"secrets": { "required": ["GM_USERNAME", "GM_PASSWORD", "CF_API_TOKEN"] },',
		...(c.domain ? [`		"routes": [{ "pattern": "${c.domain}", "custom_domain": true }],`] : []),
		'	},',
		'},',
	];
	const text = readFileSync(CONFIG, 'utf8');
	const a = text.indexOf(BEGIN);
	const b = text.indexOf(END);
	writeFileSync(
		CONFIG,
		text.slice(0, a) +
			lines
				.map((l) => `\t${l}`)
				.join('\n')
				.trimStart() +
			'\n\t' +
			text.slice(b),
	);
	run('pnpm', ['exec', 'prettier', '--write', CONFIG]);
}

/** Where a D1 primary answers from (its colo) -> a placement region hint next to it. */
const REGIONS = {
	KIX: 'aws:ap-northeast-3',
	NRT: 'aws:ap-northeast-1',
	HND: 'aws:ap-northeast-1',
	ICN: 'aws:ap-northeast-2',
	HKG: 'aws:ap-east-1',
	SIN: 'aws:ap-southeast-1',
	SYD: 'aws:ap-southeast-2',
	BOM: 'aws:ap-south-1',
	FRA: 'aws:eu-central-1',
	AMS: 'gcp:europe-west4',
	LHR: 'aws:eu-west-2',
	CDG: 'aws:eu-west-3',
	DUB: 'aws:eu-west-1',
	ARN: 'aws:eu-north-1',
	IAD: 'aws:us-east-1',
	EWR: 'aws:us-east-1',
	ORD: 'gcp:us-central1',
	SJC: 'aws:us-west-1',
	SEA: 'aws:us-west-2',
	LAX: 'aws:us-west-1',
};

/** The Cloudflare zone of a host name (its id), through the API with wrangler's own login; null: not found. */
async function zoneOf(host, credentials) {
	let token = '';
	try {
		token = /oauth_token\s*=\s*"([^"]+)"/.exec(readFileSync(credentials, 'utf8'))?.[1] ?? '';
	} catch {
		/* not readable: asked for below */
	}
	if (token) {
		const parts = host.split('.');
		for (let i = 0; i < parts.length - 1; i++) {
			const name = parts.slice(i).join('.');
			const res = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(name)}`, {
				headers: { Authorization: `Bearer ${token}` },
			}).catch(() => null);
			const body = res ? await res.json().catch(() => null) : null;
			if (body?.result?.[0]?.id) return body.result[0].id;
		}
	}
	return null;
}

/* ----- the steps ------------------------------------------------------------------------------------ */

console.log(
	'\n\x1b[1m把游戏部署到 Cloudflare（Workers 免费计划）\x1b[0m — 每一步都会先问你；已有的会复用。详细说明：docs/deployment.md 第 5 节。',
);

step(1, '登录 Cloudflare');
let who = wrangler('whoami');
if (!/Account ID/.test(who.out)) {
	note('还没登录：接下来会打开浏览器授权（选"域名所在的那个账号"）。');
	if (!show('pnpm', ['exec', 'wrangler', 'login'])) stop('登录没有完成');
	who = wrangler('whoami');
}
const accounts = [...who.out.matchAll(/│\s*(.+?)\s*│\s*([0-9a-f]{32})\s*│/g)].map((m) => ({ name: m[1], id: m[2] }));
if (!accounts.length) stop(`读不到账号：\n${who.out}`);
const credentials = pick(who.out, /Credentials are stored in:\s*(\S+)/);
if (accounts.length === 1) account = accounts[0].id;
else {
	accounts.forEach((a, i) => note(`${i + 1}) ${a.name}  ${a.id}`));
	const n = Number(await ask('用哪个账号（序号）', '1'));
	account = accounts[n - 1]?.id ?? stop('没有这个序号');
}
note(`账号：${accounts.find((a) => a.id === account).name}`);

const before = currentBlock();
step(2, '域名');
note('游戏的网址（这个域名必须已经接入同一个 Cloudflare 账号，且该主机名没有 CNAME 记录）；留空则用 *.workers.dev。');
const domain = await ask('游戏域名，例如 game.example.com', pick(before, /"pattern":\s*"([^"]+)"/));

step(3, 'D1 数据库');
const dbs = JSON.parse(wrangler('d1', 'list', '--json').out.replace(/^[^[]*/s, '') || '[]');
let databaseId = dbs.find((d) => d.name === DB)?.uuid ?? '';
if (databaseId) note(`已有 ${DB}（${databaseId}），沿用。`);
else {
	note('建在离玩家近的区域：apac（亚太）、weur / eeur（欧洲西 / 东）、enam / wnam（北美东 / 西）、oc（大洋洲）。');
	const location = await ask('区域', 'apac');
	const created = wrangler('d1', 'create', DB, '--location', location);
	databaseId =
		pick(created.out, /"database_id":\s*"([0-9a-f-]{36})"/) ||
		pick(created.out, /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
	if (!created.ok || !databaseId) stop(`建库失败：\n${created.out}`);
	note(`已建 ${DB}（${databaseId}）。`);
}

step(4, 'R2 存储桶');
for (;;) {
	const list = wrangler('r2', 'bucket', 'list');
	if (list.ok) {
		if (list.out.includes(`name:           ${BUCKET}`) || new RegExp(`\\b${BUCKET}\\b`).test(list.out)) note(`已有 ${BUCKET}，沿用。`);
		else {
			const made = wrangler('r2', 'bucket', 'create', BUCKET);
			if (!made.ok) stop(`建桶失败：\n${made.out}`);
			note(`已建 ${BUCKET}。`);
		}
		break;
	}
	if (/10042|enable R2/i.test(list.out)) {
		note('这个账号还没开通 R2：控制台 → R2 对象存储 → 开通（要绑付款方式；免费额度内不扣费，游戏自带用量保护，');
		note('本月任一项用到一半就暂停游戏，见 docs/deployment.md）。开通后回到这里。');
		await question('   开通好了按回车… ');
		continue;
	}
	stop(`读不到 R2：\n${list.out}`);
}

const filesUrl = pick(before, /"FILES_BASE_URL":\s*"([^"]*)"/);
writeBlock({ databaseId, domain, filesUrl, region: pick(before, /"region":\s*"([^"]+)"/) });
note(`已写入 ${CONFIG}（你自己的部署配置，不会被 git 提交）。`);

step(5, '建表（数据库迁移）');
if (!show('pnpm', ['db:migrate'])) stop('迁移失败');

// Next to the database: where its primary answers from.
const probe = wrangler('d1', 'execute', 'DB', '--remote', '-c', CONFIG, '--env', 'production', '--json', '--command', 'SELECT 1');
const colo = pick(probe.out, /"served_by_colo":\s*"([A-Z]{3})"/);
const region = REGIONS[colo] ?? '';
writeBlock({ databaseId, domain, filesUrl, region });
note(region ? `数据库在 ${colo}：Worker 固定在 ${region} 运行。` : `数据库在 ${colo || '未知'}：用 Smart Placement。`);

step(6, '密钥与部署');
note('GM 是用户名等于 GM_USERNAME 的账号；GM_PASSWORD 只是初始密码，第一次登录后必须改成自己的。');
note('CF_API_TOKEN 给用量保护查 R2 用量：控制台 → 右上角头像 → 我的个人资料 → API 令牌 → 创建令牌 → 创建自定义令牌，');
note('权限两项：账户 · 账户分析 · 读取；账户 · Workers R2 存储 · 编辑；账户资源选这个账号。');
const keep = /production/.test(before) && (await yes('密钥以前设过，保持不变（不重新输入）？', false));
let gm = { username: '', password: '' };
const secrets = {};
if (!keep) {
	gm.username = await ask('GM 用户名');
	for (;;) {
		gm.password = await secret('GM 初始密码（不显示）');
		if (gm.password.length >= 8 && gm.password === (await secret('再输一遍'))) break;
		note('两次不一致或少于 8 位，重来。');
	}
	secrets.GM_USERNAME = gm.username;
	secrets.GM_PASSWORD = gm.password;
	secrets.CF_API_TOKEN = await secret('CF_API_TOKEN（不显示）');
	if (!secrets.CF_API_TOKEN) stop('CF_API_TOKEN 是必需的（没有它部署会失败）');
}
if (!show('pnpm', ['run', 'build'], { CLOUDFLARE_ENV: 'production', WARGAME_WRANGLER_CONFIG: CONFIG })) stop('构建失败');
const dir = mkdtempSync(join(tmpdir(), 'wargame-'));
const file = join(dir, 'secrets.json');
let deployed;
try {
	if (!keep) writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
	deployed = run('pnpm', ['exec', 'wrangler', 'deploy', ...(keep ? [] : ['--secrets-file', file])]);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
console.log(
	deployed.out
		.split('\n')
		.filter((l) => /Deployed|https:\/\/|Current Version|✘|ERROR/i.test(l))
		.map((l) => `   ${l}`)
		.join('\n'),
);
if (!deployed.ok) stop('部署失败（上面是 wrangler 的输出）');
const url = domain ? `https://${domain}` : pick(deployed.out, /(https:\/\/[^\s]+\.workers\.dev)/);

step(7, 'R2 公开域名（可选）');
note('浏览器直接从 R2 取地图和静态数据，省 Worker 请求；不设也能玩（经由 Worker）。例如 files.example.com。');
const filesHost = await ask('文件域名（留空跳过）', filesUrl.replace(/^https:\/\//, ''));
if (filesHost && `https://${filesHost}` !== filesUrl) {
	const zone = (await zoneOf(filesHost, credentials)) ?? (await ask('找不到它的 Zone ID，请从控制台该域名的概览页右下角复制'));
	const added = wrangler('r2', 'bucket', 'domain', 'add', BUCKET, '--domain', filesHost, '--zone-id', zone, '--min-tls', '1.2', '-y');
	if (!added.ok && !/already/i.test(added.out)) stop(`绑定失败：\n${added.out}`);
	const cors = join(mkdtempSync(join(tmpdir(), 'wargame-')), 'cors.json');
	writeFileSync(
		cors,
		JSON.stringify({ rules: [{ allowed: { origins: [url], methods: ['GET', 'HEAD'], headers: ['*'] }, maxAgeSeconds: 86400 }] }),
	);
	wrangler('r2', 'bucket', 'cors', 'set', BUCKET, '--file', cors, '-y');
	rmSync(cors, { force: true });
	writeBlock({ databaseId, domain, filesUrl: `https://${filesHost}`, region });
	note('证书几分钟内签好；重新部署让游戏改用它…');
	if (!show('pnpm', ['run', 'deploy'])) stop('重新部署失败');
}

step(8, '地图（新世界必需）');
if (await yes('生成一张新地图并导入？（已有世界、已导入过地图的选 n）', !keep)) {
	const seed = await ask(
		'地图种子（同一个种子生成同一张图）',
		`${(domain || WORKER).split('.')[0]}-${new Date().toISOString().slice(0, 10)}`,
	);
	if (!show('pnpm', ['map:generate', '--seed', seed])) stop('生成地图失败');
	if (!gm.username) gm = { username: await ask('GM 用户名'), password: await secret('GM 密码（不显示）') };
	if (
		!show('node', ['scripts/map/import.mjs', join('.data/maps', seed, 'map.csv'), '--url', url, '--yes'], {
			GM_USERNAME: gm.username,
			GM_PASSWORD: gm.password,
		})
	)
		stop('导入地图失败');
}

console.log(`\n\x1b[1m完成。\x1b[0m 打开 ${url} ，用 GM 账号和初始密码登录，按提示改密码。`);
note('以后：有新的 migrations/*.sql 时先 `pnpm db:migrate`，再 `pnpm run deploy`；否则直接 `pnpm run deploy`。');
note(`你的部署配置在 ${CONFIG}（已在 .gitignore 里，不会进公开仓库）；备份好它，换电脑时拷过去。`);
rl.close();
