import type { Col, DecodedPage, PageRow } from './types.ts';
import { sampleCol } from './col.ts';
import {
	BASE_PLANES,
	C0,
	CLUSTER,
	COL_CHANNELS,
	COLOUR_WORDS,
	GEOMETRY_WORDS,
	PAGE_HEADER,
	PAGE_PARAMS,
	PARAMS,
	PLANES,
	SH_COEFFS
} from './spec.ts';

/** a stored smallest-three rotation component by its byte */
const ROTATION = Float64Array.from({ length: 256 }, (_, b) => (b / 255 - 0.5) * Math.SQRT2);

/** the unit quaternion w x y z of a stored rotation, into out */
function rotation(index: number, a: number, b: number, c: number, out: Float64Array): void {
	const v0 = ROTATION[a];
	const v1 = ROTATION[b];
	const v2 = ROTATION[c];
	out[index] = Math.sqrt(Math.max(0, 1 - v0 * v0 - v1 * v1 - v2 * v2));
	out[index > 0 ? 0 : 1] = v0;
	out[index > 1 ? 1 : 2] = v1;
	out[index > 2 ? 2 : 3] = v2;
}

/** 3-sigma half extents along x, y, z of unit quaternion q (w x y z) and scales s, into out */
export function extents(
	q: ArrayLike<number>,
	s0: number,
	s1: number,
	s2: number,
	out: Float64Array
): void {
	const qw = q[0];
	const qi = q[1];
	const qj = q[2];
	const qk = q[3];
	const a0 = s0 * s0;
	const a1 = s1 * s1;
	const a2 = s2 * s2;
	// sqrt of the diagonal of R diag(s^2) R^T
	const m00 = 1 - 2 * (qj * qj + qk * qk);
	const m01 = 2 * (qi * qj - qw * qk);
	const m02 = 2 * (qi * qk + qw * qj);
	const m10 = 2 * (qi * qj + qw * qk);
	const m11 = 1 - 2 * (qi * qi + qk * qk);
	const m12 = 2 * (qj * qk - qw * qi);
	const m20 = 2 * (qi * qk - qw * qj);
	const m21 = 2 * (qj * qk + qw * qi);
	const m22 = 1 - 2 * (qi * qi + qj * qj);
	out[0] = 3 * Math.sqrt(m00 * m00 * a0 + m01 * m01 * a1 + m02 * m02 * a2);
	out[1] = 3 * Math.sqrt(m10 * m10 * a0 + m11 * m11 * a1 + m12 * m12 * a2);
	out[2] = 3 * Math.sqrt(m20 * m20 * a0 + m21 * m21 * a1 + m22 * m22 * a2);
}

function header(payload: Uint8Array): DataView {
	if (payload.length < PAGE_HEADER) throw new Error('page payload is shorter than its header');
	return new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
}

function layout(payload: Uint8Array): { view: DataView; count: number; k: number; book: number } {
	const view = header(payload);
	const count = view.getUint32(0, true);
	const k = view.getUint16(16, true);
	const book = PAGE_HEADER + (BASE_PLANES + (k > 0 ? 2 : 0)) * count;
	const size = book + k * SH_COEFFS;
	if (payload.length !== size) {
		throw new Error(`page payload holds ${payload.length} bytes, its header needs ${size}`);
	}
	return { view, count, k, book };
}

function quadrants(view: DataView): [number, number, number] {
	return [view.getUint32(4, true), view.getUint32(8, true), view.getUint32(12, true)];
}

/**
 * an inflated page payload as pool records, with col (when given) added to every splat's dc and
 * sh1 at its unit-local centre, and the cluster boxes of its splats' 3-sigma extents
 */
export function decodePage(payload: Uint8Array, col: Col | null): DecodedPage {
	const { view, count: n, k, book } = layout(payload);
	const params = new Float32Array(PAGE_PARAMS);
	for (let f = 0; f < PAGE_PARAMS; f++) params[f] = view.getFloat32(20 + 4 * f, true);
	if (k === 0) params.fill(0, PARAMS.shScale);
	const geometry = new Uint32Array(n * GEOMETRY_WORDS);
	const clusters = new Float32Array(Math.ceil(n / CLUSTER) * 6);

	const scales = new Float64Array(3 * 256);
	for (let a = 0; a < 3; a++) {
		const lo = params[PARAMS.scaleMin + a];
		const span = params[PARAMS.scaleMax + a] - lo;
		for (let b = 0; b < 256; b++) scales[a * 256 + b] = Math.exp(lo + (b / 255) * span);
	}
	const stepX = params[PARAMS.step];
	const stepY = params[PARAMS.step + 1];
	const stepZ = params[PARAMS.step + 2];
	const px = PAGE_HEADER + PLANES.position * n;
	const pa = PAGE_HEADER + PLANES.alpha * n;
	const pi = PAGE_HEADER + PLANES.rotationIndex * n;
	const pr = PAGE_HEADER + PLANES.rotation * n;
	const ps = PAGE_HEADER + PLANES.scale * n;
	const q = new Float64Array(4);
	const e = new Float64Array(3);

	let qx = 0;
	let qy = 0;
	let qz = 0;
	for (let c = 0, t = 0; t < n; c++) {
		let x0 = Infinity;
		let y0 = Infinity;
		let z0 = Infinity;
		let x1 = -Infinity;
		let y1 = -Infinity;
		let z1 = -Infinity;
		for (const end = Math.min(t + CLUSTER, n); t < end; t++) {
			let d = payload[px + t] | (payload[px + n + t] << 8);
			qx = (qx + ((d >>> 1) ^ -(d & 1))) & 0xffff;
			d = payload[px + 2 * n + t] | (payload[px + 3 * n + t] << 8);
			qy = (qy + ((d >>> 1) ^ -(d & 1))) & 0xffff;
			d = payload[px + 4 * n + t] | (payload[px + 5 * n + t] << 8);
			qz = (qz + ((d >>> 1) ^ -(d & 1))) & 0xffff;
			const index = payload[pi + t];
			const r0 = payload[pr + t];
			const r1 = payload[pr + n + t];
			const r2 = payload[pr + 2 * n + t];
			const s0 = payload[ps + t];
			const s1 = payload[ps + n + t];
			const s2 = payload[ps + 2 * n + t];
			const w = t * GEOMETRY_WORDS;
			geometry[w] = qx | (qy << 16);
			geometry[w + 1] = qz | (payload[pa + t] << 16) | (index << 24);
			geometry[w + 2] = r0 | (r1 << 8) | (r2 << 16) | (s0 << 24);
			geometry[w + 3] = s1 | (s2 << 8);

			rotation(index, r0, r1, r2, q);
			extents(q, scales[s0], scales[256 + s1], scales[512 + s2], e);
			const cx = qx * stepX;
			const cy = qy * stepY;
			const cz = qz * stepZ;
			x0 = Math.min(x0, cx - e[0]);
			y0 = Math.min(y0, cy - e[1]);
			z0 = Math.min(z0, cz - e[2]);
			x1 = Math.max(x1, cx + e[0]);
			y1 = Math.max(y1, cy + e[1]);
			z1 = Math.max(z1, cz + e[2]);
		}
		clusters.set([x0, y0, z0, x1, y1, z1], c * 6);
	}

	const colour = col
		? correctedColour(payload, n, k, book, geometry, params, col)
		: fileColour(payload, n, k, book);
	return { count: n, quadrants: quadrants(view), geometry, colour, params, clusters };
}

/** the file's dc and codebook bytes unchanged */
function fileColour(
	payload: Uint8Array,
	n: number,
	k: number,
	book: number
): Uint32Array<ArrayBuffer> {
	const colour = new Uint32Array(n * COLOUR_WORDS);
	const pd = PAGE_HEADER + PLANES.dc * n;
	const pl = PAGE_HEADER + PLANES.label * n;
	for (let t = 0; t < n; t++) {
		const w = t * COLOUR_WORDS;
		colour[w] = payload[pd + t] | (payload[pd + n + t] << 8) | (payload[pd + 2 * n + t] << 16);
		if (k === 0) continue;
		const e = book + (payload[pl + t] | (payload[pl + n + t] << 8)) * SH_COEFFS;
		colour[w] |= payload[e] << 24;
		colour[w + 1] =
			payload[e + 1] | (payload[e + 2] << 8) | (payload[e + 3] << 16) | (payload[e + 4] << 24);
		colour[w + 2] =
			payload[e + 5] | (payload[e + 6] << 8) | (payload[e + 7] << 16) | (payload[e + 8] << 24);
	}
	return colour;
}

/** dc and sh with col added at each centre, re-coded over their new ranges, which go into params */
function correctedColour(
	payload: Uint8Array,
	n: number,
	k: number,
	book: number,
	geometry: Uint32Array,
	params: Float32Array,
	col: Col
): Uint32Array<ArrayBuffer> {
	const pd = PAGE_HEADER + PLANES.dc * n;
	const pl = PAGE_HEADER + PLANES.label * n;
	const codes = new Int8Array(payload.buffer, payload.byteOffset + book, k * SH_COEFFS);
	// f32 so each range end is exactly one of the values it is re-coded over
	const dc = new Float32Array(n * 3);
	const sh = new Float32Array(n * SH_COEFFS);
	const dcLo = [Infinity, Infinity, Infinity];
	const dcHi = [-Infinity, -Infinity, -Infinity];
	const shMax = new Float32Array(SH_COEFFS);
	const sample = new Float32Array(COL_CHANNELS);
	const ox = params[PARAMS.origin];
	const oy = params[PARAMS.origin + 1];
	const sx = params[PARAMS.step];
	const sy = params[PARAMS.step + 1];
	// the file's values by dc code and by codebook entry; a page without a codebook reads zeros
	const dcFile = new Float64Array(3 * 256);
	for (let c = 0; c < 3; c++) {
		const lo = params[PARAMS.dcMin + c];
		const span = params[PARAMS.dcMax + c] - lo;
		for (let b = 0; b < 256; b++) dcFile[c * 256 + b] = lo + (b / 255) * span;
	}
	const shFile = new Float64Array(Math.max(k, 1) * SH_COEFFS);
	for (let e = 0; e < k * SH_COEFFS; e++) {
		shFile[e] = (codes[e] / 127) * params[PARAMS.shScale + (e % SH_COEFFS)];
	}

	// corrected values and their ranges
	for (let t = 0; t < n; t++) {
		const g = geometry[t * GEOMETRY_WORDS];
		sampleCol(col, ox + (g & 0xffff) * sx, oy + (g >>> 16) * sy, sample);
		for (let c = 0; c < 3; c++) {
			const at = t * 3 + c;
			dc[at] = dcFile[c * 256 + payload[pd + c * n + t]] + sample[c] / C0;
			dcLo[c] = Math.min(dcLo[c], dc[at]);
			dcHi[c] = Math.max(dcHi[c], dc[at]);
		}
		const e = k > 0 ? (payload[pl + t] | (payload[pl + n + t] << 8)) * SH_COEFFS : 0;
		for (let m = 0; m < SH_COEFFS; m++) {
			const at = t * SH_COEFFS + m;
			sh[at] = shFile[e + m] + sample[3 + m];
			shMax[m] = Math.max(shMax[m], Math.abs(sh[at]));
		}
	}
	for (let c = 0; c < 3; c++) {
		params[PARAMS.dcMin + c] = n > 0 ? dcLo[c] : 0;
		params[PARAMS.dcMax + c] = n > 0 ? dcHi[c] : 0;
	}
	params.set(shMax, PARAMS.shScale);

	// re-code over the new ranges
	const dcCode = [0, 1, 2].map((c) => {
		const span = params[PARAMS.dcMax + c] - params[PARAMS.dcMin + c];
		return span > 0 ? 255 / span : 0;
	});
	const shCode = Array.from(shMax, (s) => (s > 0 ? 127 / s : 0));
	const dcMin = [0, 1, 2].map((c) => params[PARAMS.dcMin + c]);
	const colour = new Uint32Array(n * COLOUR_WORDS);
	// a record's bytes are its 3 dc then its 9 sh, little-endian as every upload is
	const bytes = new Uint8Array(colour.buffer);
	for (let t = 0; t < n; t++) {
		const at = t * 4 * COLOUR_WORDS;
		for (let c = 0; c < 3; c++) {
			const b = Math.round((dc[t * 3 + c] - dcMin[c]) * dcCode[c]);
			bytes[at + c] = Math.min(255, Math.max(0, b));
		}
		for (let m = 0; m < SH_COEFFS; m++) {
			const b = Math.round(sh[t * SH_COEFFS + m] * shCode[m]);
			bytes[at + 3 + m] = Math.min(127, Math.max(-127, b));
		}
	}
	return colour;
}

/** the splat count and quadrants of a payload's header, for checks against its row */
export function pageHeader(payload: Uint8Array): Pick<PageRow, 'count' | 'quadrants'> {
	const view = header(payload);
	return { count: view.getUint32(0, true), quadrants: quadrants(view) };
}

export interface SplatValues {
	/** unit-local metres */
	position: [number, number, number];
	/** w x y z */
	rotation: [number, number, number, number];
	/** metres */
	scale: [number, number, number];
	alpha: number;
	/** displayed base colour, 0.5 + C0 f_dc */
	colour: [number, number, number];
	/** sh[c][m] at 3c + m */
	sh: number[];
}

function three(f: (a: number) => number): [number, number, number] {
	return [f(0), f(1), f(2)];
}

/** splat t of a decoded page as the gpu reads it, for tests and cpu references */
export function readSplat(page: DecodedPage, t: number): SplatValues {
	const p = page.params;
	const g = page.geometry.subarray(t * GEOMETRY_WORDS, (t + 1) * GEOMETRY_WORDS);
	const c = page.colour.subarray(t * COLOUR_WORDS, (t + 1) * COLOUR_WORDS);
	// byte k of the record's words, counting from the low byte of the first
	const byte = (words: Uint32Array, k: number) => (words[k >> 2] >>> (8 * (k & 3))) & 0xff;
	const decode = (min: number, max: number, a: number, b: number) =>
		p[min + a] + (b / 255) * (p[max + a] - p[min + a]);
	const q = [g[0] & 0xffff, g[0] >>> 16, g[1] & 0xffff];
	const r = new Float64Array(4);
	rotation(byte(g, 7), byte(g, 8), byte(g, 9), byte(g, 10), r);
	const sh: number[] = [];
	for (let m = 0; m < SH_COEFFS; m++) {
		sh.push((((byte(c, m + 3) << 24) >> 24) / 127) * p[PARAMS.shScale + m]);
	}
	return {
		position: three((a) => p[PARAMS.origin + a] + q[a] * p[PARAMS.step + a]),
		rotation: [r[0], r[1], r[2], r[3]],
		scale: three((a) => Math.exp(decode(PARAMS.scaleMin, PARAMS.scaleMax, a, byte(g, 11 + a)))),
		alpha: byte(g, 6) / 255,
		colour: three((a) => 0.5 + C0 * decode(PARAMS.dcMin, PARAMS.dcMax, a, byte(c, a))),
		sh
	};
}
