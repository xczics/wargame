/** Where a heroine's granted number of accessories is kept (`Hero.extras`). */
export const ACCESSORY_EXTRA = 'starter-equipment.accessories';

/** Static view `starter-equipment.accessories`: the most accessories a heroine wears (the content's table). */
export interface StarterAccessories {
	max: number;
}

/**
 * How many accessories a hero may wear (the equipment's group limit "accessory"): heroines what they were granted, at
 * most `max`; heroes none. Both ends: the server's limit, the browser's row for a hero it made (a recruit).
 */
export function accessoriesOf(hero: { gender: string; extras: Record<string, unknown> }, max: number): number {
	if (hero.gender !== 'f') return 0;
	const n = hero.extras[ACCESSORY_EXTRA];
	return typeof n === 'number' ? Math.min(max, Math.max(0, Math.floor(n))) : 0;
}
