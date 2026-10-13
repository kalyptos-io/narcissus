// a deterministic world over denmark, built in memory on request

import type { Fetch } from '../../ports.ts';
import type { Idx, PageRow, UnitKey, World } from '../../format/types.ts';
import { contentName, encodeIdx, encodePage, mulberry32 } from '../../format/encode.ts';
import { parseUnitPath, unitPath } from '../../format/idx.ts';
import {
	BASE_PLANES,
	C0,
	LEAF,
	PACK_TRAILER,
	PAGE_HEADER,
	PAGE_SIDE,
	ROW_BYTES,
	SH_COEFFS
} from '../../format/spec.ts';
import { httpError } from '../../adapters/http.ts';

interface Page {
	g: number;
	i: number;
	j: number;
}

interface Named {
	column: number;
	row: number;
	unit: UnitKey;
}

type Range = readonly [number, number] | null;

/** a page is a GRID x GRID lattice of splats, so each quadrant holds a quarter */
const GRID = 128;
const PAGE_SPLATS = GRID * GRID;
/** codebook entries, sized for PAGE_SPLATS as format.md writes them */
const BOOK = Math.min(PAGE_SPLATS, 2048, Math.max(256, Math.ceil(PAGE_SPLATS / 12 / 64) * 64));
const PAYLOAD = PAGE_HEADER + (BASE_PLANES + 2) * PAGE_SPLATS + BOOK * SH_COEFFS;
/** data bytes of a deflate stored block at most, and its byte-aligned header */
const STORED = 65535;
const STORED_HEADER = 5;
/** bytes of every page blob */
const BLOB = PAYLOAD + Math.ceil(PAYLOAD / STORED) * STORED_HEADER;
/** the level of both roots */
const TOP = 12;

/** in lattice cells: a centre's jitter either way, and splat sigmas along and across the ground */
const JITTER = 0.4;
const WIDE_MIN = 0.6;
const WIDE_MAX = 1.2;
const FLAT = 0.15;
/** radians a splat tilts out of the ground at most */
const TILT = 0.1;
/** sh1 magnitude at most */
const SH = 0.04;

/** amplitude in metres, then wavenumber and phase east, then north; amplitudes sum to MID */
const WAVES: [number, number, number, number, number][] = [
	[12, 1 / 7000, 0, 1 / 9000, 0.7],
	[9, 1 / 2300, 1.1, 1 / 3100, 0.4],
	[6, 1 / 800, 0.3, 1 / 1100, 2],
	[3, 1 / 150, 0.9, 1 / 210, 1.7]
];
const MID = 30;
/** metres of rise per metre east plus per metre north, at most */
const SLOPE = WAVES.reduce((sum, [a, ke, , kn]) => sum + a * (ke + kn), 0);

/** BOOK distinct sh1 vectors: coefficients 0 and 1 alone tell up to 1530 entries apart */
const PALETTE = Float32Array.from({ length: BOOK * SH_COEFFS }, (_, k) => {
	const s = Math.floor(k / SH_COEFFS);
	const m = k % SH_COEFFS;
	let code = ((s * (37 + 2 * m) + 11 * m) % 255) - 127;
	if (m === 0) code = (s % 255) - 127;
	if (m === 1) code = 20 * Math.floor(s / 255) - 50;
	return (code / 127) * SH;
});

const text = new TextEncoder();

const ROOTS: UnitKey[] = [5120000, 6144000].map((n) => ({ level: TOP, e: 0, n }));

const WORLD: World = {
	version: 4,
	crs: 'EPSG:25832',
	height: 'DVR90',
	leaf: LEAF,
	roots: ROOTS.map((key) => ({ ...key, idx: unitPath(key, nameOf(key, 'idx'), 'idx') })),
	extent: { e: [440000, 900000], n: [6050000, 6410000], h: [0, 80] },
	attribution: { retrieved: '2026-10-01', epoch: 'synthetic' }
};

const WORLD_JSON = text.encode(JSON.stringify(WORLD));

/** the synthetic world under any base; a file it does not hold rejects with http 404 */
export function synthetic(): Fetch {
	return async (url, range) => {
		if (url.endsWith('world.json')) return part(WORLD_JSON, range);
		const unit = parseUnitPath(url);
		const ext = url.slice(url.lastIndexOf('.') + 1);
		if (
			!unit ||
			(ext !== 'idx' && ext !== 'pack') ||
			!exists(unit) ||
			unit.hash !== nameOf(unit, ext)
		) {
			throw httpError(404, url);
		}
		if (ext === 'idx') return part(await idxBytes(unit), range);
		return packBytes(unit, range, url);
	};
}

/** metres, the synthetic ground under (e, n), between 0 and 2 MID */
export function ground(e: number, n: number): number {
	let h = MID;
	for (const [a, ke, pe, kn, pn] of WAVES) {
		h += a * Math.sin(ke * e + pe) * Math.sin(kn * n + pn);
	}
	return h;
}

function part(bytes: Uint8Array, range: Range): Uint8Array {
	return range ? bytes.slice(range[0], range[1]) : bytes.slice();
}

/** hashes follow from the unit alone, so a parent names its children without building them */
function nameOf(key: UnitKey, ext: string): string {
	return contentName(text.encode(`${key.level}/${key.e}/${key.n}.${ext}`));
}

/** the square of side metres at (e, n) overlaps the extent */
function meets(e: number, n: number, side: number): boolean {
	const { e: east, n: north } = WORLD.extent;
	return e < east[1] && e + side > east[0] && n < north[1] && n + side > north[0];
}

function exists({ level, e, n }: UnitKey): boolean {
	const side = LEAF * 2 ** level;
	return level <= TOP && e % side === 0 && n % side === 0 && meets(e, n, side);
}

/** page levels of a unit, coarsest first */
function levels(level: number): number[] {
	if (level === 0) return [1, 0];
	if (level === TOP) return [TOP + 4, TOP + 3, TOP + 2, TOP + 1];
	return [level + 1];
}

/** the even bits of m packed together: column then row of morton code m and m >> 1 */
function even(m: number): number {
	let v = 0;
	for (let b = 0; b < 8; b++) v |= ((m >> (2 * b)) & 1) << b;
	return v;
}

/** a unit's pages that meet the extent, in pack order: coarsest level first, morton within */
function pagesOf(key: UnitKey): Page[] {
	const pages: Page[] = [];
	for (const g of levels(key.level)) {
		const side = PAGE_SIDE * 2 ** g;
		const span = (LEAF * 2 ** key.level) / side;
		for (let m = 0; m < span * span; m++) {
			const i = even(m);
			const j = even(m >> 1);
			if (meets(key.e + i * side, key.n + j * side, side)) pages.push({ g, i, j });
		}
	}
	return pages;
}

/** the units depth levels down inside key that meet the extent, by column and row */
function below(key: UnitKey, depth: number): Named[] {
	const level = key.level - depth;
	const side = LEAF * 2 ** level;
	const found: Named[] = [];
	for (let row = 0; level >= 0 && row < 2 ** depth; row++) {
		for (let column = 0; column < 2 ** depth; column++) {
			const unit = { level, e: key.e + column * side, n: key.n + row * side };
			if (meets(unit.e, unit.n, side)) found.push({ column, row, unit });
		}
	}
	return found;
}

/** the row of a page, its box from the ground's slope and the splats' largest extents */
function pageRow(key: UnitKey, { g, i, j }: Page, offset: number): PageRow {
	const side = PAGE_SIDE * 2 ** g;
	const cell = side / GRID;
	const wide = 3 * WIDE_MAX * cell;
	// twice the tilt also covers the error of the 8-bit rotation
	const deep = 3 * (FLAT + 2 * TILT * WIDE_MAX) * cell;
	const mid = ground(key.e + (i + 0.5) * side, key.n + (j + 0.5) * side);
	const reach = (SLOPE * side) / 2;
	const box = Float32Array.of(
		i * side - wide,
		j * side - wide,
		Math.max(0, mid - reach) - deep,
		(i + 1) * side + wide,
		(j + 1) * side + wide,
		Math.min(2 * MID, mid + reach) + deep
	);
	const quarter = PAGE_SPLATS / 4;
	const quadrants: [number, number, number] = [quarter, 2 * quarter, 3 * quarter];
	return { g, i, j, count: PAGE_SPLATS, quadrants, box, offset, length: BLOB };
}

function idxBytes(key: UnitKey): Promise<Uint8Array> {
	const pages = pagesOf(key);
	const children: Idx['children'] = [];
	for (const { column, row, unit } of below(key, 1)) {
		children.push({ quadrant: column + 2 * row, idx: nameOf(unit, 'idx') });
	}
	const descendants: Idx['descendants'] = [];
	for (const depth of [2, 3]) {
		for (const { column, row, unit } of below(key, depth)) {
			descendants.push({ depth, column, row, idx: nameOf(unit, 'idx') });
		}
	}
	return encodeIdx({
		level: key.level,
		e: key.e,
		n: key.n,
		pack: nameOf(key, 'pack'),
		packSize: pages.length * (BLOB + ROW_BYTES) + PACK_TRAILER,
		col: null,
		rows: pages.map((page, r) => pageRow(key, page, r * BLOB)),
		children,
		descendants
	});
}

/** the blobs of the pages range covers; it must start and end on page boundaries */
function packBytes(key: UnitKey, range: Range, url: string): Uint8Array {
	const pages = pagesOf(key);
	if (
		!range ||
		range[0] % BLOB !== 0 ||
		range[1] % BLOB !== 0 ||
		range[0] >= range[1] ||
		range[1] > pages.length * BLOB
	) {
		throw new Error(`${url}: the synthetic world serves whole pages only`);
	}
	const out = new Uint8Array(range[1] - range[0]);
	for (let at = 0; at < out.length; at += BLOB) {
		store(payload(key, pages[(range[0] + at) / BLOB]), out, at);
	}
	return out;
}

/** payload as deflate stored blocks into out at offset */
function store(payload: Uint8Array, out: Uint8Array, offset: number): void {
	let at = offset;
	for (let from = 0; from < payload.length; from += STORED) {
		const length = Math.min(STORED, payload.length - from);
		// bfinal in bit 0 and btype 00, padded to the byte; then len and its complement
		out[at] = from + length === payload.length ? 1 : 0;
		out[at + 1] = length & 0xff;
		out[at + 2] = length >> 8;
		out[at + 3] = ~length & 0xff;
		out[at + 4] = (~length >> 8) & 0xff;
		out.set(payload.subarray(from, from + length), at + STORED_HEADER);
		at += STORED_HEADER + length;
	}
}

/** mulberry32 seeded from text */
const numbers = (seed: string) => mulberry32(parseInt(contentName(text.encode(seed)).slice(8), 16));

/** the payload of a page of unit key: a jittered lattice draped over the ground */
function payload(key: UnitKey, { g, i, j }: Page): Uint8Array {
	const count = PAGE_SPLATS;
	const cell = (PAGE_SIDE * 2 ** g) / GRID;
	const next = numbers(`${key.level}/${key.e}/${key.n}/${g}/${i}/${j}`);
	const position = new Float64Array(3 * count);
	const rotation = new Float32Array(4 * count);
	const scale = new Float32Array(3 * count);
	const alpha = new Float32Array(count);
	const dc = new Float32Array(3 * count);
	const sh = new Float32Array(SH_COEFFS * count);
	for (let t = 0; t < count; t++) {
		const x = (i * GRID + (t % GRID) + 0.5 + JITTER * (2 * next() - 1)) * cell;
		const y = (j * GRID + Math.floor(t / GRID) + 0.5 + JITTER * (2 * next() - 1)) * cell;
		const z = ground(key.e + x, key.n + y);
		position[3 * t] = x;
		position[3 * t + 1] = y;
		position[3 * t + 2] = z;

		// half angles of a turn about up, then a small tilt
		const turn = Math.PI * next();
		const lean = (TILT / 2) * (2 * next() - 1);
		rotation[4 * t] = Math.cos(turn) * Math.cos(lean);
		rotation[4 * t + 1] = Math.cos(turn) * Math.sin(lean);
		rotation[4 * t + 2] = Math.sin(turn) * Math.sin(lean);
		rotation[4 * t + 3] = Math.sin(turn) * Math.cos(lean);
		for (let a = 0; a < 2; a++) {
			scale[3 * t + a] = Math.log(cell * (WIDE_MIN + (WIDE_MAX - WIDE_MIN) * next()));
		}
		scale[3 * t + 2] = Math.log(cell * FLAT * (0.5 + 0.5 * next()));
		alpha[t] = 0.35 + 0.65 * next();

		// displayed colour from height and broad patches, stored as f_dc
		const rise = z / (2 * MID);
		const patch = 0.5 + 0.5 * Math.sin((key.e + x) / 410) * Math.sin((key.n + y) / 330);
		dc[3 * t] = (0.32 + 0.2 * rise + 0.1 * patch - 0.5) / C0;
		dc[3 * t + 1] = (0.42 + 0.15 * patch - 0.1 * rise - 0.5) / C0;
		dc[3 * t + 2] = (0.25 + 0.1 * rise + 0.04 * next() - 0.5) / C0;
		const label = t % BOOK;
		sh.set(PALETTE.subarray(SH_COEFFS * label, SH_COEFFS * (label + 1)), SH_COEFFS * t);
	}
	return encodePage({ count, position, rotation, scale, alpha, dc, sh }, { g, i, j }).payload;
}
