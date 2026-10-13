import type { Mat4 } from './mat4.ts';

/** the six planes of a webgpu view-projection (clip z 0..1), normalised; inside when n.p + d >= 0 */
export function planes(out: Float32Array | Float64Array, m: Mat4): typeof out {
	const row = (r: number, k: number) => m[k * 4 + r];
	// left, right, bottom, top, near, far
	const rows: [number, number][] = [
		[0, 1],
		[0, -1],
		[1, 1],
		[1, -1],
		[2, 0],
		[2, -1]
	];
	rows.forEach(([r, sign], p) => {
		for (let k = 0; k < 4; k++) out[p * 4 + k] = sign ? row(3, k) + sign * row(r, k) : row(r, k);
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
