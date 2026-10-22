import { describe, expect, it } from 'vitest';
import type { Col } from './types.ts';
import { sampleCol } from './col.ts';
import { encodePage, mulberry32, type Splats } from './encode.ts';
import { deflate, inflate } from './inflate.ts';
import { decodePage, pageHeader, readSplat } from './page.ts';
import { C0, CLUSTER, PAGE_SIDE, PARAMS } from './spec.ts';

const PAGE = { g: 1, i: 3, j: 5 };
const SIDE = PAGE_SIDE * 2 ** PAGE.g;
const MID = [(PAGE.i + 0.5) * SIDE, (PAGE.j + 0.5) * SIDE];

/** n splats in PAGE, none within 1% of a side of its quadrant lines */
function splats(n: number, seed: number, sh = true): Splats {
	const rnd = mulberry32(seed);
	const away = (u: number) => (u < 0.5 ? u * 0.98 : 0.02 + u * 0.98) * SIDE;
	const s: Splats = {
		count: n,
		position: new Float64Array(n * 3),
		rotation: new Float32Array(n * 4),
		scale: new Float32Array(n * 3),
		alpha: new Float32Array(n),
		dc: new Float32Array(n * 3),
		sh: sh ? new Float32Array(n * 9) : null
	};
	for (let t = 0; t < n; t++) {
		const [x, y] = [PAGE.i, PAGE.j].map((k) => k * SIDE + away(rnd()));
		s.position.set([x, y, 40 * rnd()], t * 3);
		const q = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
		const norm = Math.hypot(...q);
		s.rotation.set(
			q.map((v) => v / norm),
			t * 4
		);
		s.scale.set([-5 + 4 * rnd(), -5 + 4 * rnd(), -5 + 4 * rnd()], t * 3);
		s.alpha[t] = rnd();
		s.dc.set([3 * rnd() - 1.5, 3 * rnd() - 1.5, 3 * rnd() - 1.5], t * 3);
		if (s.sh) {
			for (let m = 0; m < 9; m++) s.sh[t * 9 + m] = 0.6 * rnd() - 0.3;
		}
	}
	return s;
}

async function roundTrip(s: Splats) {
	const { payload, row } = encodePage(s, PAGE);
	return { payload, row, page: decodePage(await inflate(await deflate(payload)), null) };
}

/** the input splat closest to p */
function nearest(s: Splats, p: number[]): number {
	let best = 0;
	let distance = Infinity;
	for (let t = 0; t < s.count; t++) {
		const d = Math.hypot(...p.map((v, a) => v - s.position[t * 3 + a]));
		if (d < distance) {
			distance = d;
			best = t;
		}
	}
	return best;
}

function quadrantOf(p: ArrayLike<number>): number {
	return (p[0] >= MID[0] ? 1 : 0) + 2 * (p[1] >= MID[1] ? 1 : 0);
}

const IDENTITY = [
	[1, 0, 0],
	[0, 1, 0],
	[0, 0, 1]
];

/** v rotated by unit quaternion q (w x y z) */
function rotate(q: number[], v: number[]): number[] {
	const [w, x, y, z] = q;
	const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
	return [
		v[0] + w * t[0] + (y * t[2] - z * t[1]),
		v[1] + w * t[1] + (z * t[0] - x * t[2]),
		v[2] + w * t[2] + (x * t[1] - y * t[0])
	];
}

/** 3-sigma half extents along x, y, z */
function sigma3(rotation: number[], scale: number[]): number[] {
	const axes = IDENTITY.map((axis, k) => rotate(rotation, axis).map((v) => v * scale[k]));
	return [0, 1, 2].map((a) => 3 * Math.hypot(axes[0][a], axes[1][a], axes[2][a]));
}

describe('decodePage', () => {
	it('reads back every field of an encoded page within the format steps', async () => {
		const s = splats(1000, 1);
		const { page } = await roundTrip(s);
		const p = page.params;
		const worst = { position: 0, rotation: 0, scale: 0, alpha: 0, colour: 0, sh: 0 };
		const matched = new Set<number>();
		for (let t = 0; t < page.count; t++) {
			const v = readSplat(page, t);
			const u = nearest(s, v.position);
			matched.add(u);
			for (let a = 0; a < 3; a++) {
				const position = Math.abs(v.position[a] - s.position[u * 3 + a]);
				worst.position = Math.max(worst.position, position / (p[PARAMS.step + a] / 2 + 1e-6));
				const scale = Math.abs(v.scale[a] / Math.exp(s.scale[u * 3 + a]) - 1);
				worst.scale = Math.max(worst.scale, scale / 0.015);
				const colour = Math.abs(v.colour[a] - 0.5 - C0 * s.dc[u * 3 + a]);
				const dcRange = p[PARAMS.dcMax + a] - p[PARAMS.dcMin + a];
				worst.colour = Math.max(worst.colour, colour / ((C0 * dcRange) / 255));
			}
			const dot = v.rotation.reduce((sum, c, m) => sum + c * s.rotation[u * 4 + m], 0);
			worst.rotation = Math.max(worst.rotation, Math.acos(Math.min(1, Math.abs(dot))) / 0.01);
			worst.alpha = Math.max(worst.alpha, Math.abs(v.alpha - s.alpha[u]) / (1 / 510 + 1e-7));
			for (let m = 0; m < 9; m++) {
				const sh = Math.abs(v.sh[m] - s.sh![u * 9 + m]);
				worst.sh = Math.max(worst.sh, sh / ((2 * p[PARAMS.shScale + m]) / 127));
			}
		}
		expect(matched.size).toBe(s.count);
		for (const [field, ratio] of Object.entries(worst)) {
			expect(ratio, field).toBeLessThanOrEqual(1);
		}
	});

	it('orders splats by quadrant at the boundaries the header names', async () => {
		const s = splats(2000, 2);
		const { payload, row, page } = await roundTrip(s);
		expect(pageHeader(payload)).toEqual({ count: 2000, quadrants: row.quadrants });
		expect(page.quadrants).toEqual(row.quadrants);
		const counts = [0, 0, 0, 0];
		for (let t = 0; t < s.count; t++) counts[quadrantOf(s.position.subarray(t * 3))]++;
		const starts = [0, ...page.quadrants, page.count];
		const misplaced: number[] = [];
		for (let k = 0; k < 4; k++) {
			expect(starts[k + 1] - starts[k]).toBe(counts[k]);
			for (let t = starts[k]; t < starts[k + 1]; t++) {
				if (quadrantOf(readSplat(page, t).position) !== k) misplaced.push(t);
			}
		}
		expect(misplaced).toEqual([]);
	});

	it('boxes every cluster tightly around its splats 3-sigma extents', async () => {
		const { page } = await roundTrip(splats(1000, 3));
		const clusters = Math.ceil(1000 / CLUSTER);
		expect(page.clusters.length).toBe(clusters * 6);
		const origin = page.params.subarray(PARAMS.origin, PARAMS.origin + 3);
		for (let c = 0; c < clusters; c++) {
			const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
			for (let t = c * CLUSTER; t < Math.min((c + 1) * CLUSTER, page.count); t++) {
				const v = readSplat(page, t);
				const e = sigma3(v.rotation, v.scale);
				for (let a = 0; a < 3; a++) {
					box[a] = Math.min(box[a], v.position[a] - origin[a] - e[a]);
					box[3 + a] = Math.max(box[3 + a], v.position[a] - origin[a] + e[a]);
				}
			}
			const got = [...page.clusters.subarray(c * 6, c * 6 + 6)];
			got.forEach((v, k) => expect(v).toBeCloseTo(box[k], 4));
		}
	});

	it('adds the colour field at each centre to colour and sh', () => {
		const n = 6;
		const values = Float32Array.from({ length: 12 * n * n }, (_, k) => 0.05 * Math.sin(k));
		const col: Col = { n, pitch: 50, margin: 25, values };
		const { payload } = encodePage(splats(1500, 4), PAGE);
		const plain = decodePage(payload, null);
		const corrected = decodePage(payload, col);
		expect(corrected.geometry).toEqual(plain.geometry);
		const p = corrected.params;
		const sample = new Float32Array(12);
		let worst = 0;
		let moved = 0;
		for (let t = 0; t < plain.count; t++) {
			const a = readSplat(plain, t);
			const b = readSplat(corrected, t);
			sampleCol(col, a.position[0], a.position[1], sample);
			for (let c = 0; c < 3; c++) {
				const step = (C0 * (p[PARAMS.dcMax + c] - p[PARAMS.dcMin + c])) / 255;
				worst = Math.max(worst, Math.abs(b.colour[c] - a.colour[c] - sample[c]) / step);
				moved = Math.max(moved, Math.abs(b.colour[c] - a.colour[c]));
			}
			for (let m = 0; m < 9; m++) {
				const step = p[PARAMS.shScale + m] / 127;
				worst = Math.max(worst, Math.abs(b.sh[m] - a.sh[m] - sample[3 + m]) / step);
			}
		}
		expect(worst).toBeLessThanOrEqual(1);
		expect(moved).toBeGreaterThan(0.02);
	});

	it('keeps sh at zero on a page without a codebook or colour field', () => {
		const page = decodePage(encodePage(splats(300, 5, false), PAGE).payload, null);
		expect([...page.params.subarray(PARAMS.shScale)]).toEqual(new Array(9).fill(0));
		expect(readSplat(page, 17).sh).toEqual(new Array(9).fill(0));
	});

	it('gives a page without a codebook the colour field sh', () => {
		const n = 4;
		const values = Float32Array.from({ length: 12 * n * n }, (_, k) => 0.04 * Math.cos(k));
		const col: Col = { n, pitch: 80, margin: 35, values };
		const page = decodePage(encodePage(splats(300, 5, false), PAGE).payload, col);
		const sample = new Float32Array(12);
		let worst = 0;
		for (let t = 0; t < page.count; t++) {
			const v = readSplat(page, t);
			sampleCol(col, v.position[0], v.position[1], sample);
			for (let m = 0; m < 9; m++) {
				const step = page.params[PARAMS.shScale + m] / 127;
				worst = Math.max(worst, Math.abs(v.sh[m] - sample[3 + m]) / step);
			}
		}
		expect(Math.min(...page.params.subarray(PARAMS.shScale))).toBeGreaterThan(0);
		expect(worst).toBeLessThanOrEqual(1);
	});

	it('rejects a payload whose size does not match its header', () => {
		const { payload } = encodePage(splats(100, 6), PAGE);
		expect(() => decodePage(payload.subarray(0, payload.length - 1), null)).toThrow(
			'its header needs'
		);
		expect(() => pageHeader(payload.subarray(0, 100))).toThrow('shorter than its header');
	});
});

describe('encodePage', () => {
	it('boxes the page around every centre less and plus 3 sigma', () => {
		const s = splats(500, 7);
		const { row } = encodePage(s, PAGE);
		const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
		for (let t = 0; t < s.count; t++) {
			const rotation = [...s.rotation.subarray(t * 4, t * 4 + 4)];
			const e = sigma3(
				rotation,
				[0, 1, 2].map((a) => Math.exp(s.scale[t * 3 + a]))
			);
			for (let a = 0; a < 3; a++) {
				box[a] = Math.min(box[a], s.position[t * 3 + a] - e[a]);
				box[3 + a] = Math.max(box[3 + a], s.position[t * 3 + a] + e[a]);
			}
		}
		expect(row).toMatchObject({ ...PAGE, count: 500, offset: 0, length: 0 });
		[...row.box].forEach((v, k) => expect(v).toBeCloseTo(box[k], 3));
	});

	it('builds an exact codebook up to 2048 vectors and a smaller one past it', () => {
		const size = (payload: Uint8Array) => new DataView(payload.buffer).getUint16(16, true);
		expect(size(encodePage(splats(1000, 8), PAGE).payload)).toBe(1000);
		const { payload } = encodePage(splats(3000, 9), PAGE);
		expect(size(payload)).toBeGreaterThan(0);
		expect(size(payload)).toBeLessThanOrEqual(2048);
		const page = decodePage(payload, null);
		const scale = page.params.subarray(PARAMS.shScale, PARAMS.shScale + 9);
		for (const t of [0, 1499, 2999]) {
			readSplat(page, t).sh.forEach((v, m) => expect(Math.abs(v)).toBeLessThanOrEqual(scale[m]));
		}
	});
});
