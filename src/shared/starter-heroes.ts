/**
 * How the heroes' effects read (starter-heroes): on the server (hero cards) and in the browser (the posts' rows) alike.
 */
import { signed } from './format';

// Effects that lower something (time, cost, losses): a reduction reads as a minus.
const REDUCTIONS = new Set(['construction', 'training', 'upkeep', 'research', 'researchCost', 'casualty']);

/** An effect's value as shown: "+12%", or "−5%" for a reduction. */
export const effectValue = (e: { effect: string; percent: number }) => signed(REDUCTIONS.has(e.effect) ? -e.percent : e.percent, true, 1);
