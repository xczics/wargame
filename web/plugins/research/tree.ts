// The tech tree's views, assembled in the browser (AGENTS.md: the server sends data only) from the player's part
// (`research.state`) and the shared tree (static `research.techs`, its `data`): the tree with each tech's next level
// priced (`research.tree`), the research queue, what an institute researches and can start, the Research page's tree.
// Pure: the tests run them. The research plugin's own words (its i18n keys), as when the server built them.
import type { ResearchJob, ResearchState, ResearchTree, TechInfo } from '../../../src/shared/api';
import { keyText, uiTexts } from '../../../src/shared/i18n';
import { factorTexts, partTexts } from '../../../src/shared/stats';
import {
	effectLine,
	type ResearchCatalog,
	type TechPlan,
	techQuote,
	tierLabel,
	treeLayout,
	unlockLines,
} from '../../../src/shared/research';
import type { CardsData, TimersData, TreeData, TreeNodePatch, UiCard, UiLine, UiText } from '../../../src/shared/ui';

const text = uiTexts('research');

/** Every tech the player sees, in the server's order: the content's, then the runtime nodes in the order they were added. */
function techsOf(state: ResearchState, catalog: ResearchCatalog): TechPlan[] {
	if (!state.own?.length) return catalog.techs;
	const byId = new Map([...catalog.techs, ...state.own].map((t) => [t.id, t]));
	const runtime = new Set(state.nodes ?? []);
	return [
		...catalog.techs.filter((t) => !runtime.has(t.id)),
		...(state.nodes ?? []).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
	];
}

const jobOf = (j: ResearchJob): ResearchJob => ({
	settlement: j.settlement,
	tech: j.tech,
	targetLevel: j.targetLevel,
	startedAt: j.startedAt,
	finishesAt: j.finishesAt,
});

/** Each tech with its level and, in the selected settlement, its next level's price and why it cannot start. */
export function researchTree(state: ResearchState | undefined, catalog: ResearchCatalog | undefined): ResearchTree | undefined {
	if (!state || !catalog) return undefined;
	const techs = techsOf(state, catalog);
	const all = new Map(techs.map((t) => [t.id, t]));
	const lv = (id: string) => state.levels[id] ?? 0;
	const here = state.here;
	const current = here ? state.jobs.find((j) => j.settlement === here.id) : undefined;
	/** The first prerequisite tech the player still lacks, as a reason. */
	const missing = (d: TechPlan): UiText | null => {
		for (const [req, n] of Object.entries(d.requires ?? {}))
			if (lv(req) < n) return text('Requires {0} Lv {1}', { 0: keyText(all.get(req)?.name ?? req), 1: n });
		return null;
	};
	/** Why its next level cannot start here (ignoring cost), as starting it would say. */
	const blocked = (h: NonNullable<ResearchState['here']>, d: TechPlan): UiText | null => {
		if (lv(d.id) + 1 > d.maxLevel) return text('Fully researched');
		if (h.labs < 1) return text('Needs an institute in this settlement');
		// One research per institute, and one tech in one settlement at a time.
		if (current?.tech === d.id) return text('Being researched here');
		if (current) return text('This settlement is researching another tech');
		const elsewhere = state.jobs.find((j) => j.tech === d.id);
		if (elsewhere)
			return elsewhere.name
				? text('Being researched in {0}', { 0: keyText(elsewhere.name) })
				: text('Being researched in another settlement');
		return missing(d) ?? h.gates[d.id] ?? null;
	};
	return {
		techs: techs.map((d): TechInfo => {
			const level = lv(d.id);
			const f = here && (here.factors.techs?.[d.id] ?? here.factors);
			const next =
				level >= d.maxLevel || !here || !f
					? null
					: {
							level: level + 1,
							...techQuote(d, level + 1, catalog, { labSpeed: here.labSpeed, costFactor: f.cost, timeFactor: f.time }),
							blocked: blocked(here, d) ?? undefined,
							locked: missing(d) ?? undefined,
						};
			return {
				id: d.id,
				name: d.name,
				description: d.description,
				level,
				maxLevel: d.maxLevel,
				next,
				branch: d.branch,
				tier: d.tier,
				order: d.order,
				quote: d.quote,
				requires: d.requires ?? {},
				unlocks: d.unlocks ?? [],
				effects: d.effects,
			};
		}),
		current: here ? (current ? jobOf(current) : null) : null,
		all: state.jobs.map(jobOf),
		speed: here && here.labs >= 1 ? here.labSpeed * catalog.speed : 0,
	};
}

const techName = (t: ResearchTree, id: string) => keyText(t.techs.find((x) => x.id === id)?.name ?? id);
const jobTimer = (t: ResearchTree, j: ResearchJob, where?: string) => ({
	id: j.settlement,
	title: text('{tech} {n}', { tech: techName(t, j.tech), n: j.targetLevel }),
	startedAt: j.startedAt,
	endsAt: j.finishesAt,
	...(where ? { lines: [{ text: keyText(where), tone: 'muted' as const }] } : {}),
});

/** The Research page's queue: everything being researched, soonest first, with where. */
export function researchQueue(state: ResearchState | undefined, catalog: ResearchCatalog | undefined): TimersData | undefined {
	const t = researchTree(state, catalog);
	if (!t || !state) return undefined;
	const jobs = [...t.all].sort((a, b) => a.finishesAt - b.finishesAt);
	return {
		title: text('Research queue'),
		items: jobs.map((j) => jobTimer(t, j, state.jobs.find((x) => x.settlement === j.settlement)?.name ?? j.settlement)),
		notes: jobs.length
			? []
			: [{ text: text('Nothing is being researched. Start research at an institute (open it on the Overview page).'), tone: 'muted' }],
	};
}

/** An institute's entry: what it researches now, its speed and where speed, time and cost come from. */
export function researchCurrent(state: ResearchState | undefined, catalog: ResearchCatalog | undefined): TimersData | null | undefined {
	const t = researchTree(state, catalog);
	if (!t || !state || !catalog) return undefined;
	const here = state.here;
	if (!here) return null;
	const notes: UiLine[] = [
		{
			text: text('Researching in {name} (speed ×{speed}); costs are paid by it.', {
				name: keyText(here.name),
				speed: t.speed.toFixed(2),
			}),
			tone: 'muted',
		},
	];
	if (t.speed && here.sources) {
		const speedParts = [
			...partTexts(here.sources.speed, { flatAsPercent: true }),
			...(catalog.speed !== 1 ? [text('All servers ×{0}', { 0: catalog.speed })] : []),
		];
		if (speedParts.length) notes.push({ text: text('Speed: {0}', { 0: speedParts }), tone: 'muted' });
		if (here.sources.time.length) notes.push({ text: text('Research time: {0}', { 0: factorTexts(here.sources.time) }), tone: 'muted' });
		if (here.sources.cost.length) notes.push({ text: text('Research cost: {0}', { 0: factorTexts(here.sources.cost) }), tone: 'muted' });
	}
	return { title: text('Research here'), items: t.current ? [jobTimer(t, t.current)] : [], notes };
}

/** What an institute can start: one branch and tier at a time, each tech a card with its effects and price. */
export function researchOptions(state: ResearchState | undefined, catalog: ResearchCatalog | undefined): CardsData | null | undefined {
	const t = researchTree(state, catalog);
	if (!t || !state || !catalog) return undefined;
	const here = state.here;
	if (!here) return null;
	const plans = new Map(techsOf(state, catalog).map((p) => [p.id, p]));
	// Only what can be researched now (prerequisites met, not maxed), one branch and tier at a time
	// (filter buttons "Civil · Foundation"…), each tech a card like the tree's; the whole tree is on the Research page.
	const open = t.techs.filter((x): x is TechInfo & { next: NonNullable<TechInfo['next']> } => !!x.next && !x.next.locked);
	const keys = [...new Set(open.map((x) => `${x.branch ?? 'Other'}|${x.tier ?? 1}`))].sort((a, b) => {
		const [ba, ta] = a.split('|');
		const [bb, tb] = b.split('|');
		return ba === bb ? Number(ta) - Number(tb) : 0;
	});
	const cards: UiCard[] = [];
	for (const x of [...open].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
		const plan = plans.get(x.id)!;
		// Whether the price can be paid is the widget's, by the resources the browser counts on ("resource:<id>"): the
		// view itself does not change as they grow.
		const blocked = x.next.blocked ?? (t.current ? text('This settlement is researching another tech') : null);
		cards.push({
			id: x.id,
			group: `${x.branch ?? 'Other'}|${x.tier ?? 1}`,
			title: keyText(x.name),
			badge: text('Lv {n}/{max}', { n: x.level, max: x.maxLevel }),
			...(x.quote ? { quote: keyText(x.quote) } : {}),
			lines: [
				...unlockLines(x, catalog).map((l) => ({ text: l, tone: 'muted' as const })),
				...x.effects.filter((e) => !e.atLevel || x.level >= e.atLevel).map((e) => effectLine(e, plan, x.level, catalog)),
				...x.effects.filter((e) => e.atLevel && x.level < e.atLevel).map((e) => effectLine(e, plan, x.level, catalog)),
				...(x.next.blocked ? [{ text: x.next.blocked, tone: 'warn' as const }] : []),
			],
			actions: [
				{
					command: 'research.start',
					payload: { tech: x.id, settlement: here.id },
					label: text('Research Lv {n} ·', { n: x.next.level }),
					// The price: each resource, red when short (then off with `short`); then the time.
					parts: [
						...Object.entries(x.next.cost)
							.filter(([, n]) => n > 0)
							.map(([r, n]) => ({ need: { counter: `resource:${r}`, amount: n, icon: catalog.icons[r] ?? r } })),
						{ seconds: x.next.seconds },
					],
					short: text('Not enough resources'),
					...(blocked ? { blocked } : {}),
				},
			],
		});
	}
	return {
		title: text('Research'),
		groups: keys.map((key) => {
			const [, tier] = key.split('|');
			const sample = open.find((x) => `${x.branch ?? 'Other'}|${x.tier ?? 1}` === key)!;
			return {
				id: key,
				label: text('{branch} · {tier}', {
					branch: sample.branch ? keyText(sample.branch) : text('Other'),
					tier: tierLabel(plans.get(sample.id), tier),
				}),
			};
		}),
		...(keys.length ? { defaultGroup: keys[0] } : {}),
		cards,
		empty: text('Nothing can be researched right now. See the tech tree on the Research page.'),
	};
}

/**
 * The Research page's tree over the static one (`research.techs`): each node's level, state, prerequisites met,
 * unlocks and what is under way; techs added for this player alone whole, as the static tree has not got them.
 */
export function researchGraph(state: ResearchState | undefined, catalog: ResearchCatalog | undefined): TreeData | undefined {
	if (!state || !catalog) return undefined;
	const techs = techsOf(state, catalog);
	const all = new Map(techs.map((t) => [t.id, t]));
	const lv = (id: string) => state.levels[id] ?? 0;
	const researching = new Map(state.jobs.map((j) => [j.tech, j.targetLevel]));
	const nodes: Record<string, TreeNodePatch> = {};
	for (const d of techs) {
		const level = lv(d.id);
		const missing = Object.entries(d.requires ?? {}).find(([req, n]) => lv(req) < n);
		const active = researching.get(d.id);
		const unlocks = unlockLines({ level, unlocks: d.unlocks ?? [] }, catalog);
		nodes[d.id] = {
			badge: text('{n}/{max}', { n: level, max: d.maxLevel }),
			state: active ? 'active' : level >= d.maxLevel ? 'done' : missing ? 'locked' : level ? 'started' : 'open',
			met: Object.entries(d.requires ?? {})
				.filter(([req, n]) => lv(req) >= n)
				.map(([req]) => req),
			...(unlocks.length || active || missing
				? {
						lines: [
							...unlocks.map((l) => ({ text: l })),
							...(active
								? [{ text: text('Researching Lv {n}', { n: active }) }]
								: missing && level < d.maxLevel
									? [
											{
												text: text('Requires {0} Lv {1}', { 0: keyText(all.get(missing[0])?.name ?? missing[0]), 1: missing[1] }),
												tone: 'warn' as const,
											},
										]
									: []),
						],
					}
				: {}),
		};
	}
	const own = new Set(state.own?.map((d) => d.id));
	const extra = techs.filter((d) => own.has(d.id));
	return { base: 'research.techs', groups: extra.length ? treeLayout(extra, all, catalog) : [], nodes };
}
