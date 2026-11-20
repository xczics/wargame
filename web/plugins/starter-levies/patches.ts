// The levy quota as the forms held in the browser show it, counted on as the server counts it (user 2026-11-20: "你告诉
// 前端成功了，前端不就能更新了吗？"): an order used adds its quota, training ordered takes one a unit. Pure: the tests run it.
import type { FormPatches, LevyQuotaData } from '../../../src/shared/api';

const PART = 'starter-levies.quota';

/** Every levy order's form for `unit` with its quota changed by `by` (never below none). */
export function quotaChanged(patches: FormPatches, unit: string, by: (q: LevyQuotaData) => number): FormPatches {
	let changed = false;
	const forms = patches.forms.map((f) => {
		const q = f.patch?.data?.[PART] as LevyQuotaData | undefined;
		if (!q || q.unit !== unit) return f;
		changed = true;
		return { ...f, patch: { ...f.patch, data: { ...f.patch!.data, [PART]: { ...q, quota: Math.max(0, q.quota + by(q)) } } } };
	});
	return changed ? { ...patches, forms } : patches;
}
