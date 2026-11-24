// The world map's geometry, the same in the Worker and the browser (a march's distance, its arrival worked out in the
// browser: user 2026-11-24 "行军到达时间……前端是知道的呀"): a 1024 x 1024 grid whose edges wrap on both axes.

export const MAP_MIN = -511;
export const MAP_MAX = 512;
export const MAP_SIZE = MAP_MAX - MAP_MIN + 1;

/** Bring any integer coordinate back onto the map. */
export const wrap = (v: number) => ((((v - MAP_MIN) % MAP_SIZE) + MAP_SIZE) % MAP_SIZE) + MAP_MIN;
/** Shortest signed offset from a to b along one axis (in -511..512). */
export const delta = (a: number, b: number) => wrap(b - a);
/** Euclidean distance using the shortest way around. */
export const mapDistance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(delta(a.x, b.x), delta(a.y, b.y));
