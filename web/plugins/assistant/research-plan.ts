// The research queue's plan (docs/design/gameplay.md §15.2.1): targets ("Economics to 5") expanded into one-level
// steps from the static tech tree, prerequisites first (and theirs before them), each level once however many targets
// need it, and nothing the player already has. Pure: the assistant's engine and page both use it, the tests run it.

/** What expanding needs of a tech: its cap and prerequisites (a `TechPlan` of the static `research.techs`). */
export interface TechNode {
	id: string;
	maxLevel: number;
	requires?: Record<string, number>;
}

export interface PlanTarget {
	id: string;
	tech: string;
	level: number;
}

/** One level of one tech, for the first target (in order) that needs it. */
export interface PlanStep {
	tech: string;
	level: number;
	target: string;
}

/** Why a target cannot be planned: a tech the tree lacks, a level past a cap, prerequisites going round. */
export interface PlanProblem {
	tech: string;
	reason: 'unknown' | 'max' | 'cycle';
	/** For "max": the level asked and the tech's cap. */
	level?: number;
	max?: number;
}

export interface ResearchPlan {
	steps: PlanStep[];
	/** By target id: those planned nothing for (their steps are left out whole). */
	problems: Record<string, PlanProblem>;
}

/**
 * Expand `targets` in their order. A target already reached adds nothing; one that cannot be reached (see
 * `PlanProblem`) adds nothing either, not even the prerequisites it would have shared: the next targets go on.
 */
export function planResearch(
	targets: readonly PlanTarget[],
	techs: ReadonlyMap<string, TechNode>,
	levels: Readonly<Record<string, number>>,
): ResearchPlan {
	/** The level each tech has once the steps so far are done. */
	const planned = new Map(Object.entries(levels));
	const steps: PlanStep[] = [];
	const problems: Record<string, PlanProblem> = {};
	for (const target of targets) {
		const mine = new Map(planned);
		const added: PlanStep[] = [];
		const visit = (tech: string, level: number, path: string[]): PlanProblem | null => {
			const def = techs.get(tech);
			if (!def) return { tech, reason: 'unknown' };
			if ((mine.get(tech) ?? 0) >= level) return null;
			if (level > def.maxLevel) return { tech, reason: 'max', level, max: def.maxLevel };
			if (path.includes(tech)) return { tech, reason: 'cycle' };
			for (const [req, n] of Object.entries(def.requires ?? {})) {
				const problem = visit(req, n, [...path, tech]);
				if (problem) return problem;
			}
			for (let l = (mine.get(tech) ?? 0) + 1; l <= level; l++) added.push({ tech, level: l, target: target.id });
			mine.set(tech, level);
			return null;
		};
		const problem = visit(target.tech, target.level, []);
		if (problem) {
			problems[target.id] = problem;
			continue;
		}
		steps.push(...added);
		for (const [k, v] of mine) planned.set(k, v);
	}
	return { steps, problems };
}

/** A step's key (its notes are kept by it). */
export const stepKey = (s: Pick<PlanStep, 'tech' | 'level'>) => `${s.tech}@${s.level}`;

/** A problem in words (`t`: the assistant's words, `name`: a tech's name), for the page and the log alike. */
export function problemText(
	p: PlanProblem,
	name: (tech: string) => string,
	t: (text: string, vars: Record<string, string | number>) => string,
) {
	return p.reason === 'unknown'
		? t('No such tech: {0}', { 0: p.tech })
		: p.reason === 'max'
			? t('{0} goes up to Lv {1} only (Lv {2} asked)', { 0: name(p.tech), 1: p.max ?? 0, 2: p.level ?? 0 })
			: t('{0}: its prerequisites go round in a circle', { 0: name(p.tech) });
}
