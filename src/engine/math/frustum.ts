import type { Mat4 } from './mat4.ts';

// left, right, bottom, top, near, far: clip row, its ndc bound, the side inside faces
const ROWS: [number, number, number][] = [
	[0, -1, 1],
	[0, 1, -1],
	[1, -1, 1],
	[1, 1, -1],
	[2, 0, 1],
	[2, 1, -1]
];

/**
 * the six planes of a webgpu view-projection (clip z 0..1), normalised; inside when n.p + d >= 0.
 * sides moves left, right, bottom, top to those ndc bounds
 */
export function planes(
	out: Float32Array | Float64Array,
	m: Mat4,
	sides?: readonly number[]
): typeof out {
	ROWS.forEach(([r, full, sign], p) => {
		const bound = sides?.[p] ?? full;
		for (let k = 0; k < 4; k++) out[p * 4 + k] = sign * (m[k * 4 + r] - bound * m[k * 4 + 3]);
		const len = Math.hypot(out[p * 4], out[p * 4 + 1], out[p * 4 + 2]) || 1;
		for (let k = 0; k < 4; k++) out[p * 4 + k] /= len;
	});
	return out;
}

/** false only when the box lies wholly outside one plane */
export function boxVisible(
	p: ArrayLike<number>,
	min: ArrayLike<number>,
	max: ArrayLike<number>
): boolean {
	for (let i = 0; i < 24; i += 4) {
		const x = p[i] >= 0 ? max[0] : min[0];
		const y = p[i + 1] >= 0 ? max[1] : min[1];
		const z = p[i + 2] >= 0 ? max[2] : min[2];
		if (p[i] * x + p[i + 1] * y + p[i + 2] * z + p[i + 3] < 0) return false;
	}
	return true;
}
