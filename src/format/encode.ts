// writers from the spec, for tests and synthetic worlds

import type { Col, Idx, PageRow } from './types.ts';
import { toHalf } from './half.ts';
import { deflate } from './inflate.ts';
import { extents, sigmas } from './page.ts';
import {
	BASE_PLANES,
	CHILD_BYTES,
	COL_CHANNELS,
	COL_HEADER,
	COL_MAGIC,
	COL_VERSION,
	DESCENDANT_BYTES,
	IDX_HEADER,
	IDX_MAGIC,
	LINK_PLANES,
	OPACITY_MAX,
	PACK_MAGIC,
	PACK_TRAILER,
	PAGE_HEADER,
	PLANES,
	PREFIX,
	ROW_BYTES,
	SH_COEFFS,
	VERSION
} from './spec.ts';

export { deflate, toHalf };

/** nodes of one page in unit-local ENU, in the order the page stores them */
export interface Nodes {
	count: number;
	/** 3 per node, metres */
	position: Float64Array;
	/** 4 per node, w x y z */
	rotation: Float32Array;
	/** 3 per node, log metres */
	scale: Float32Array;
	/** 0..1000 */
	opacity: Float32Array;
	/** 3 per node, f_dc */
	dc: Float32Array;
	/** 9 per node, sh[c][m] at 3c + m, or null for none */
	sh: Float32Array | null;
	/** per node, its family's count, 0 for none */
	children: Uint8Array;
	/** per node, its family's link (see link()); read only where children is not 0 */
	links: Uint32Array;
}

/** a parent's link to the family of count nodes from start in page row of unit, 0 for the same unit and 1 + q for its child at q */
export function link(unit: number, row: number, start: number): number {
	return ((unit << 29) | (row << 20) | start) >>> 0;
}

/** metres, the position step at band 0 */
const STEP = 0.0005;
/** codebook entries at most */
const BOOK = 2048;
/** entries of the fallback codebook when a page has more distinct sh1 vectors than BOOK */
const SAMPLE = 256;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** byte of v over [lo, hi], nearest code */
function code(v: number, lo: number, hi: number): number {
	return hi > lo ? clamp(Math.round(((v - lo) / (hi - lo)) * 255), 0, 255) : 0;
}

/** linear i8 code of v over [-scale, scale] */
function i8(v: number, scale: number): number {
	return scale > 0 ? clamp(Math.round((v / scale) * 127), -127, 127) : 0;
}

/** per-coefficient max magnitude, f32 as the header stores it */
function shScale(sh: Float32Array, n: number): Float32Array {
	const scale = new Float32Array(SH_COEFFS);
	for (let t = 0; t < n; t++) {
		for (let m = 0; m < SH_COEFFS; m++) {
			scale[m] = Math.max(scale[m], Math.abs(sh[t * SH_COEFFS + m]));
		}
	}
	return scale;
}

/** exact when the page has at most BOOK distinct i8 vectors, else nearest of a fixed sample */
function codebook(
	sh: Float32Array,
	n: number,
	scale: Float32Array
): { book: Int8Array; labels: Uint16Array } {
	const codes = new Int8Array(n * SH_COEFFS);
	for (let t = 0; t < n; t++) {
		for (let m = 0; m < SH_COEFFS; m++) {
			codes[t * SH_COEFFS + m] = i8(sh[t * SH_COEFFS + m], scale[m]);
		}
	}
	const vector = (t: number) => codes.subarray(t * SH_COEFFS, (t + 1) * SH_COEFFS);
	const seen = new Map<string, number>();
	const firsts: number[] = [];
	const labels = new Uint16Array(n);
	for (let t = 0; t < n; t++) {
		const key = vector(t).join();
		let label = seen.get(key);
		if (label === undefined) {
			label = firsts.length;
			seen.set(key, label);
			firsts.push(t);
		}
		labels[t] = label;
	}
	if (firsts.length > BOOK) {
		const stride = firsts.length / SAMPLE;
		const picks = Array.from({ length: SAMPLE }, (_, s) => firsts[Math.floor(s * stride)]);
		firsts.splice(0, firsts.length, ...picks);
		for (let t = 0; t < n; t++) {
			let best = Infinity;
			for (let s = 0; s < SAMPLE; s++) {
				let d = 0;
				for (let m = 0; m < SH_COEFFS; m++) {
					d += (codes[t * SH_COEFFS + m] - codes[firsts[s] * SH_COEFFS + m]) ** 2;
				}
				if (d < best) {
					best = d;
					labels[t] = s;
				}
			}
		}
	}
	const book = new Int8Array(firsts.length * SH_COEFFS);
	firsts.forEach((t, s) => book.set(vector(t), s * SH_COEFFS));
	return { book, labels };
}

/** the inflated payload of page (g, i, j) and its row (offset and length 0) */
export function encodePage(
	nodes: Nodes,
	page: { g: number; i: number; j: number; flags?: number }
): {
	payload: Uint8Array;
	row: PageRow;
} {
	const { count: n, position, rotation, scale, opacity, dc, sh, children, links } = nodes;

	// ranges
	const lo = [Infinity, Infinity, Infinity];
	const hi = [-Infinity, -Infinity, -Infinity];
	const scaleLo = [...lo];
	const scaleHi = [...hi];
	const dcLo = [...lo];
	const dcHi = [...hi];
	let m = 0;
	for (let t = 0; t < n; t++) {
		for (let a = 0; a < 3; a++) {
			lo[a] = Math.min(lo[a], position[t * 3 + a]);
			hi[a] = Math.max(hi[a], position[t * 3 + a]);
			scaleLo[a] = Math.min(scaleLo[a], scale[t * 3 + a]);
			scaleHi[a] = Math.max(scaleHi[a], scale[t * 3 + a]);
			dcLo[a] = Math.min(dcLo[a], dc[t * 3 + a]);
			dcHi[a] = Math.max(dcHi[a], dc[t * 3 + a]);
		}
		if (children[t] > 0) m++;
	}
	const floor = STEP * 2 ** page.g;
	const origin = Float32Array.from(lo);
	const step = Float32Array.from(lo, (l, a) => Math.max(floor, (hi[a] - l) / 65535));
	const q = new Uint16Array(n * 3);
	for (let t = 0; t < n; t++) {
		for (let a = 0; a < 3; a++) {
			const v = (position[t * 3 + a] - origin[a]) / step[a];
			q[t * 3 + a] = clamp(Math.round(v), 0, 65535);
		}
	}

	const shMax = sh ? shScale(sh, n) : new Float32Array(SH_COEFFS);
	const { book, labels } = sh ? codebook(sh, n, shMax) : { book: null, labels: null };
	const k = book ? book.length / SH_COEFFS : 0;
	const planes = BASE_PLANES + (k > 0 ? 2 : 0);
	const linkPlanes = PAGE_HEADER + planes * n;
	const payload = new Uint8Array(linkPlanes + LINK_PLANES * m + k * SH_COEFFS);
	const view = new DataView(payload.buffer);
	view.setUint32(0, n, true);
	view.setUint32(4, m, true);
	view.setUint16(16, k, true);
	const floats = [...origin, ...step, ...scaleLo, ...scaleHi, ...dcLo, ...dcHi, ...shMax];
	floats.forEach((v, f) => view.setFloat32(20 + 4 * f, v, true));

	// planes, and the extent box: centres less and plus k(α) sigma per axis
	const plane = (p: number) => PAGE_HEADER + p * n;
	const box = new Float32Array([...lo, ...hi]);
	const r = new Float64Array(4);
	const e = new Float64Array(3);
	const prev = [0, 0, 0];
	for (let t = 0, s = 0; t < n; t++) {
		for (let a = 0; a < 3; a++) {
			const delta = ((q[t * 3 + a] - prev[a]) << 16) >> 16;
			const zigzag = delta < 0 ? -2 * delta - 1 : 2 * delta;
			prev[a] = q[t * 3 + a];
			payload[plane(PLANES.position + 2 * a) + t] = zigzag & 0xff;
			payload[plane(PLANES.position + 2 * a + 1) + t] = zigzag >> 8;
		}
		const half = toHalf(Math.min(opacity[t], OPACITY_MAX));
		payload[plane(PLANES.opacityLow) + t] = half & 0xff;
		payload[plane(PLANES.opacityHigh) + t] = half >> 8;
		payload[plane(PLANES.children) + t] = children[t];
		if (children[t] > 0) {
			for (let b = 0; b < LINK_PLANES; b++) payload[linkPlanes + b * m + s] = links[t] >>> (8 * b);
			s++;
		}

		const norm = Math.hypot(...rotation.subarray(t * 4, t * 4 + 4));
		for (let c = 0; c < 4; c++) r[c] = rotation[t * 4 + c] / norm;
		let big = 0;
		for (let c = 1; c < 4; c++) if (Math.abs(r[c]) > Math.abs(r[big])) big = c;
		const sign = r[big] < 0 ? -1 : 1;
		payload[plane(PLANES.rotationIndex) + t] = big;
		for (let c = 0, out = 0; c < 4; c++) {
			if (c === big) continue;
			const b = Math.round(((sign * r[c]) / Math.SQRT2 + 0.5) * 255);
			payload[plane(PLANES.rotation + out++) + t] = clamp(b, 0, 255);
		}

		for (let a = 0; a < 3; a++) {
			payload[plane(PLANES.scale + a) + t] = code(scale[t * 3 + a], scaleLo[a], scaleHi[a]);
			payload[plane(PLANES.dc + a) + t] = code(dc[t * 3 + a], dcLo[a], dcHi[a]);
		}
		if (labels) {
			payload[plane(PLANES.label) + t] = labels[t] & 0xff;
			payload[plane(PLANES.label + 1) + t] = labels[t] >> 8;
		}

		const [s0, s1, s2] = [0, 1, 2].map((a) => Math.exp(scale[t * 3 + a]));
		extents(r, s0, s1, s2, sigmas(opacity[t]), e);
		for (let a = 0; a < 3; a++) {
			box[a] = Math.min(box[a], position[t * 3 + a] - e[a]);
			box[3 + a] = Math.max(box[3 + a], position[t * 3 + a] + e[a]);
		}
	}
	if (book) payload.set(new Uint8Array(book.buffer), linkPlanes + LINK_PLANES * m);

	const { g, i, j, flags = 0 } = page;
	const row = { g, i, j, flags, count: n, box, offset: 0, length: 0 };
	return { payload, row };
}

function writeRow(view: DataView, at: number, row: PageRow): void {
	view.setUint8(at, row.g);
	view.setUint8(at + 1, row.i);
	view.setUint8(at + 2, row.j);
	view.setUint8(at + 3, row.flags);
	view.setUint32(at + 4, row.count, true);
	row.box.forEach((v, c) => view.setFloat32(at + 8 + 4 * c, v, true));
	view.setUint32(at + 32, row.offset, true);
	view.setUint32(at + 36, row.length, true);
}

/** blobs (deflated payloads) in row order as a .pack of fit splats; fills each row's offset and length */
export function encodePack(pages: { row: PageRow; blob: Uint8Array }[], fit: number): Uint8Array {
	const table = pages.reduce((sum, p) => sum + p.blob.length, 0);
	const out = new Uint8Array(table + pages.length * ROW_BYTES + PACK_TRAILER);
	const view = new DataView(out.buffer);
	let at = 0;
	for (const { row, blob } of pages) {
		row.offset = at;
		row.length = blob.length;
		out.set(blob, at);
		at += blob.length;
	}
	for (const { row } of pages) {
		writeRow(view, at, row);
		at += ROW_BYTES;
	}
	view.setUint32(at, fit, true);
	view.setUint32(at + 4, table, true);
	view.setUint32(at + 8, pages.length, true);
	writeMagic(out, at + 12, PACK_MAGIC);
	view.setUint16(at + 16, VERSION, true);
	return out;
}

function writeMagic(out: Uint8Array, at: number, magic: string): void {
	for (let c = 0; c < 4; c++) out[at + c] = magic.charCodeAt(c);
}

function unhex(hash: string): Uint8Array {
	return Uint8Array.from({ length: 8 }, (_, b) => parseInt(hash.slice(2 * b, 2 * b + 2), 16));
}

/** magic, version and the deflated body */
export async function wrap(body: Uint8Array, magic: string, version: number): Promise<Uint8Array> {
	const z = await deflate(body);
	const out = new Uint8Array(PREFIX + z.length);
	writeMagic(out, 0, magic);
	new DataView(out.buffer).setUint16(4, version, true);
	out.set(z, PREFIX);
	return out;
}

export async function encodeIdx(idx: Idx): Promise<Uint8Array> {
	const { rows, children, descendants } = idx;
	const body = new Uint8Array(
		IDX_HEADER +
			rows.length * ROW_BYTES +
			children.length * CHILD_BYTES +
			descendants.length * DESCENDANT_BYTES
	);
	const view = new DataView(body.buffer);
	view.setUint8(0, idx.level);
	view.setInt32(4, idx.e, true);
	view.setInt32(8, idx.n, true);
	body.set(unhex(idx.pack), 12);
	view.setUint32(20, idx.packSize, true);
	if (idx.col) body.set(unhex(idx.col), 24);
	view.setUint16(32, rows.length, true);
	view.setUint8(34, children.length);
	view.setUint16(36, descendants.length, true);
	let at = IDX_HEADER;
	for (const row of rows) {
		writeRow(view, at, row);
		at += ROW_BYTES;
	}
	for (const child of children) {
		view.setUint8(at, child.quadrant);
		body.set(unhex(child.idx), at + 1);
		at += CHILD_BYTES;
	}
	for (const d of descendants) {
		view.setUint8(at, d.depth);
		view.setUint8(at + 1, d.column);
		view.setUint8(at + 2, d.row);
		body.set(unhex(d.idx), at + 3);
		at += DESCENDANT_BYTES;
	}
	return wrap(body, IDX_MAGIC, VERSION);
}

export async function encodeCol(col: Col): Promise<Uint8Array> {
	const { n, values } = col;
	const plane = n * n;
	const body = new Uint8Array(COL_HEADER + COL_CHANNELS * plane);
	const view = new DataView(body.buffer);
	view.setUint16(0, n, true);
	view.setFloat32(4, col.pitch, true);
	view.setFloat32(8, col.margin, true);
	let at = COL_HEADER;
	for (let c = 0; c < COL_CHANNELS; c++) {
		const channel = values.subarray(c * plane, (c + 1) * plane);
		const scale = Math.fround(channel.reduce((max, v) => Math.max(max, Math.abs(v)), 0));
		view.setFloat32(12 + 4 * c, scale, true);
		for (let j = 0; j < n; j++) {
			let prev = 0;
			for (let i = 0; i < n; i++) {
				const q = i8(channel[j * n + i], scale);
				body[at++] = (q - prev) & 0xff;
				prev = q;
			}
		}
	}
	return wrap(body, COL_MAGIC, COL_VERSION);
}

/** 16 hex digits naming bytes; readers never check it, so synthetic worlds need not use blake2b */
export function contentName(bytes: Uint8Array): string {
	// fnv-1a 64 in two 32-bit halves; the prime is 2^40 + 0x1b3
	let hi = 0xcbf29ce4;
	let lo = 0x84222325;
	for (let b = 0; b < bytes.length; b++) {
		lo = (lo ^ bytes[b]) >>> 0;
		const low = lo * 0x1b3;
		hi = (hi * 0x1b3 + ((lo << 8) >>> 0) + Math.floor(low / 0x100000000)) >>> 0;
		lo = low >>> 0;
	}
	return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

/** mulberry32: numbers in [0, 1) from a 32-bit seed */
export function mulberry32(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
	};
}
