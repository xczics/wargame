// What `research.start` did, applied to the research held in the browser (user 2026-11-24: "命令之后，根据服务端返回内容
// 直接更新前端大对象"): the job, from the clock the command ran at to when the answer says it ends (that settlement's
// modifiers: the browser may hold only another's). Pure: the tests run it against the server's re-read.
import type { ResearchState } from '../../../src/shared/api';

export function researchStarted(
	s: ResearchState,
	p: { settlement: string; tech: string },
	at: { now: number; finishesAt: number; name?: string },
): ResearchState {
	if (s.jobs.some((j) => j.settlement === p.settlement || j.tech === p.tech)) return s;
	const job = {
		settlement: p.settlement,
		tech: p.tech,
		targetLevel: (s.levels[p.tech] ?? 0) + 1,
		startedAt: at.now,
		finishesAt: at.finishesAt,
		...(at.name !== undefined ? { name: at.name } : {}),
	};
	// Nothing starts here while a job runs here; the tech under way neither, anywhere (the server's `hereOf`).
	const here = s.here && (s.here.id === p.settlement ? { ...s.here, gates: {} } : { ...s.here, gates: without(s.here.gates, p.tech) });
	return { ...s, jobs: [...s.jobs, job], here };
}

const without = <T>(r: Record<string, T>, key: string) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== key));
