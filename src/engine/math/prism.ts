// vertical prisms: rings in e, n over a height range; the masks' geometry

import type { Ring } from '../types.ts';

/**
 * edges of its rings as ax, ay, bx, by, ..; inside by the even-odd rule, so holes and islands need
 * no bridge edges. z the height range, infinite for the full height
 */
export interface Prism {
	edges: Float64Array;
	z: readonly [number, number];
	/** acts on what lies outside the prism instead */
	outside: boolean;
}

/** a box's relation to what a prism acts on, for every point in the box */
export const OUT = 0;
export const IN = 1;
export const CROSS = 2;

/** the edges of rings, each closed */
export function edges(rings: readonly Ring[]): Float64Array {
	const out: number[] = [];
	for (const ring of rings)
		ring.forEach(([ax, ay], k) => out.push(ax, ay, ...ring[(k + 1) % ring.length]));
	return Float64Array.from(out);
}

/** (x, y) inside edges by the even-odd rule; masks.wgsl tests the same way */
export function inside(edges: ArrayLike<number>, x: number, y: number): boolean {
	let odd = false;
	for (let k = 0; k < edges.length; k += 4) {
		const ax = edges[k];
		const ay = edges[k + 1];
		const bx = edges[k + 2];
		const by = edges[k + 3];
		if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) odd = !odd;
	}
	return odd;
}

/** segment (ax, ay)-(bx, by) meets the closed rectangle [x0, x1] x [y0, y1]; liang-barsky */
function meets(
	ax: number,
	ay: number,
	bx: number,
	by: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number
): boolean {
	let t0 = 0;
	let t1 = 1;
	const dx = bx - ax;
	const dy = by - ay;
	for (const [p, q] of [
		[-dx, ax - x0],
		[dx, x1 - ax],
		[-dy, ay - y0],
		[dy, y1 - ay]
	]) {
		if (p === 0) {
			if (q < 0) return false;
			continue;
		}
		const t = q / p;
		if (p < 0) t0 = Math.max(t0, t);
		else t1 = Math.min(t1, t);
		if (t0 > t1) return false;
	}
	return true;
}

/** OUT, IN or CROSS of what prism acts on, for the box min x, y, z to max x, y, z */
export function relate(prism: Prism, min: ArrayLike<number>, max: ArrayLike<number>): number {
	const relation = within(prism, min, max);
	if (!prism.outside || relation === CROSS) return relation;
	return relation === IN ? OUT : IN;
}

/** OUT, IN or CROSS of the prism itself */
function within(prism: Prism, min: ArrayLike<number>, max: ArrayLike<number>): number {
	const { edges, z } = prism;
	if (max[2] < z[0] || min[2] > z[1]) return OUT;
	for (let k = 0; k < edges.length; k += 4) {
		if (meets(edges[k], edges[k + 1], edges[k + 2], edges[k + 3], min[0], min[1], max[0], max[1]))
			return CROSS;
	}
	// no edge meets the box, so it lies wholly on one side
	if (!inside(edges, min[0], min[1])) return OUT;
	return min[2] >= z[0] && max[2] <= z[1] ? IN : CROSS;
}
