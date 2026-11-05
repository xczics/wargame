/**
 * The wall's upkeep in a settlement whose kind keeps it differently (starter-siege rule `kinds`; resource fortresses:
 * user 2026-10-19 "城防设施维护消耗减半，且不再消耗金币…金币的维护消耗部分分摊给其他资源"): the currency share goes
 * to the other resources in their shares (none other: it stays), then everything x `upkeep`. The shares are the whole
 * wall's (`base`, default: this upkeep itself): one defence's row shares its currency out as the wall's total does, so
 * the rows add up to it (user 2026-11-05: "前端根据规则正常显示，和服务端保持一致"). Pure: both ends use it.
 */
export function wallUpkeep(
	upkeep: Record<string, number>,
	kind: { upkeep: number; noGold: number } | null | undefined,
	base: Record<string, number> = upkeep,
): Record<string, number> {
	const out = { ...upkeep };
	if (!kind || !Object.keys(out).length) return out;
	if (kind.noGold && out.gold) {
		const others = Object.keys(base).filter((r) => r !== 'gold' && base[r] > 0);
		const rest = others.reduce((n, r) => n + base[r], 0);
		if (rest > 0) {
			for (const r of others) out[r] = (out[r] ?? 0) + (out.gold * base[r]) / rest;
			delete out.gold;
		}
	}
	for (const r of Object.keys(out)) out[r] *= kind.upkeep;
	return out;
}

/** Upkeep amounts added together (e.g. each defence x how many, each work at its level). */
export function addUpkeep(into: Record<string, number>, upkeep: Record<string, number>, times = 1): Record<string, number> {
	for (const [r, v] of Object.entries(upkeep)) into[r] = (into[r] ?? 0) + v * times;
	return into;
}
