// vertical prisms: a polygon in e, n over a height range; the masks' geometry

/** polygon as e0, n0, e1, n1, ..; z the height range, infinite for the full height */
export interface Prism {
	polygon: Float64Array;
	z: readonly [number, number];
}

/** a box's relation to a prism, for every point in the box */
export const OUT = 0;
export const IN = 1;
export const CROSS = 2;

/** (x, y) inside polygon by the even-odd rule; masks.wgsl tests the same way */
export function inside(polygon: ArrayLike<number>, x: number, y: number): boolean {
	let odd = false;
	const n = polygon.length / 2;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const ax = polygon[2 * i];
		const ay = polygon[2 * i + 1];
		const bx = polygon[2 * j];
		const by = polygon[2 * j + 1];
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

/** OUT, IN or CROSS for the box min x, y, z to max x, y, z */
export function relate(prism: Prism, min: ArrayLike<number>, max: ArrayLike<number>): number {
	const { polygon, z } = prism;
	if (max[2] < z[0] || min[2] > z[1]) return OUT;
	const n = polygon.length / 2;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const [ax, ay, bx, by] = [
			polygon[2 * i],
			polygon[2 * i + 1],
			polygon[2 * j],
			polygon[2 * j + 1]
		];
		if (meets(ax, ay, bx, by, min[0], min[1], max[0], max[1])) return CROSS;
	}
	// no edge meets the box, so it lies wholly on one side
	if (!inside(polygon, min[0], min[1])) return OUT;
	return min[2] >= z[0] && max[2] <= z[1] ? IN : CROSS;
}
