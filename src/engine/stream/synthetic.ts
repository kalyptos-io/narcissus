// a deterministic world, built in memory on request: a lattice of fit splats merged four to one up to two roots

import { Missing, type Fetch } from '../../ports.ts';
import {
	evenBits,
	morton,
	parseUnitPath,
	sigmas,
	unitPath,
	BASE_PLANES,
	C0,
	LEAF,
	LINK_PLANES,
	PACK_TRAILER,
	PAGE_HEADER,
	PAGE_SIDE,
	ROW_BYTES,
	SH_COEFFS,
	TOP_PAGE,
	VERSION,
	type Idx,
	type PageNodes,
	type PageRow,
	type UnitKey
} from '../../format/index.ts';
import { contentName, encodeIdx, encodePage, link, mulberry32 } from '../../format/encode.ts';

interface Page {
	g: number;
	i: number;
	j: number;
}

type Range = readonly [number, number] | null;

/** a page is a GRID x GRID lattice of nodes in morton order, so a family is four in a row */
const GRID = 128;
const PAGE_NODES = GRID * GRID;
/** codebook entries, sized for PAGE_NODES as format.md writes them */
const BOOK = Math.min(PAGE_NODES, 2048, Math.max(256, Math.ceil(PAGE_NODES / 12 / 64) * 64));
/** payload bytes of a page of fit splats and of a page of parents */
const PAYLOAD = PAGE_HEADER + (BASE_PLANES + 2) * PAGE_NODES + BOOK * SH_COEFFS;
const PARENTS_PAYLOAD = PAYLOAD + LINK_PLANES * PAGE_NODES;
/** data bytes of a deflate stored block at most, and its byte-aligned header */
const STORED = 65535;
const STORED_HEADER = 5;
const blob = (payload: number) => payload + Math.ceil(payload / STORED) * STORED_HEADER;
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
/** share of parents flat-topped past opacity 1, and their opacity at most */
const FLAT_TOPPED = 0.1;
const OPACITY = 3;

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
const SIDE = LEAF * 2 ** TOP;

const WORLD = {
	version: VERSION,
	crs: 'synthetic',
	height: 'synthetic',
	leaf: LEAF,
	roots: ROOTS.map((key) => ({ ...key, idx: unitPath(key, nameOf(key, 'idx'), 'idx') })),
	extent: { e: [0, SIDE], n: [ROOTS[0].n, ROOTS[1].n + SIDE], h: [0, 80] }
};

const WORLD_JSON = text.encode(JSON.stringify(WORLD));

/** the synthetic world under any base; a file it does not hold rejects with Missing */
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
			throw new Missing(`no file ${url}`);
		}
		if (ext === 'idx') return part(await idxBytes(unit), range);
		return packBytes(unit, range, url);
	};
}

/**
 * the nodes the cut reads of row of unit key, straight from the lattice without its jitter or
 * flat tops: for tests that cover more pages than they could build
 */
export function latticeNodes(key: UnitKey, row: number): PageNodes {
	const page = pagesOf(key.level)[row];
	const { g, i, j } = page;
	const cell = (PAGE_SIDE * 2 ** g) / GRID;
	const parents = g > 0 ? PAGE_NODES : 0;
	const centres = new Float32Array(3 * parents);
	const links = new Uint32Array(parents);
	for (let t = 0; t < parents; t++) {
		const cx = evenBits(t);
		const cy = evenBits(t >> 1);
		const x = (i * GRID + cx + 0.5) * cell;
		const y = (j * GRID + cy + 0.5) * cell;
		centres.set([x, y, ground(key.e + x, key.n + y)], 3 * t);
		links[t] = familyOf(key.level, page, cx, cy);
	}
	return {
		counts: new Uint8Array(PAGE_NODES).fill(parents ? 4 : 0),
		centres,
		radii: new Float32Array(parents).fill((cell * (WIDE_MIN + WIDE_MAX + 0.75 * FLAT)) / 3),
		links
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
	return contentName(text.encode(`${VERSION}/${key.level}/${key.e}/${key.n}.${ext}`));
}

/** every unit under a root */
function exists({ level, e, n }: UnitKey): boolean {
	const side = LEAF * 2 ** level;
	const root = ROOTS.find((key) => n >= key.n && n < key.n + SIDE);
	return (
		level <= TOP && e % side === 0 && n % side === 0 && e >= 0 && e < SIDE && root !== undefined
	);
}

/** a unit's bands in row order, fine to coarse; a root's last is its top page */
function bands(level: number): number[] {
	if (level === 0) return [0, 1];
	if (level === TOP) return [TOP + 1, TOP + 2, TOP + 3, TOP + 4];
	return [level + 1];
}

/** pages a side of band g in a unit of level */
const span = (level: number, g: number) => (LEAF * 2 ** level) / (PAGE_SIDE * 2 ** g);

/** a unit's pages in row order: each band fine to coarse, morton within */
function pagesOf(level: number): Page[] {
	const pages: Page[] = [];
	for (const g of bands(level)) {
		const pagesSide = span(level, g);
		for (let m = 0; m < pagesSide * pagesSide; m++)
			pages.push({ g, i: evenBits(m), j: evenBits(m >> 1) });
	}
	return pages;
}

/** the row of page (g, i, j) in a unit of level */
function rowOf(level: number, g: number, i: number, j: number): number {
	let row = 0;
	for (const b of bands(level)) {
		if (b === g) return row + morton(i, j);
		row += span(level, b) ** 2;
	}
	throw new Error(`band ${g} is not a band of a level ${level} unit`);
}

/** the family of cell (x, y) of page (g, i, j) in a unit of level: the four cells under it a band down */
function familyOf(level: number, { g, i, j }: Page, x: number, y: number): number {
	const band = g - 1;
	let cx = 2 * (i * GRID + x);
	let cy = 2 * (j * GRID + y);
	let unit = 0;
	let at = level;
	if (!bands(level).includes(band)) {
		const half = ((LEAF * 2 ** (level - 1)) / (PAGE_SIDE * 2 ** band)) * GRID;
		const a = cx >= half ? 1 : 0;
		const b = cy >= half ? 1 : 0;
		cx -= a * half;
		cy -= b * half;
		unit = 1 + a + 2 * b;
		at = level - 1;
	}
	const row = rowOf(at, band, cx >> 7, cy >> 7);
	return link(unit, row, morton(cx & (GRID - 1), cy & (GRID - 1)));
}

const isTop = (level: number, g: number) => level === TOP && g === TOP + 4;
const blobOf = (g: number) => blob(g === 0 ? PAYLOAD : PARENTS_PAYLOAD);

/** the row of a page, its box from the ground's slope and the nodes' largest extents */
function pageRow(key: UnitKey, { g, i, j }: Page, offset: number): PageRow {
	const side = PAGE_SIDE * 2 ** g;
	const cell = side / GRID;
	const k = g === 0 ? 3 : sigmas(OPACITY);
	const wide = k * WIDE_MAX * cell;
	// twice the tilt also covers the error of the 8-bit rotation
	const deep = k * (FLAT + 2 * TILT * WIDE_MAX) * cell;
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
	const flags = isTop(key.level, g) ? TOP_PAGE : 0;
	return { g, i, j, flags, count: PAGE_NODES, box, offset, length: blobOf(g) };
}

/** the units depth levels down inside key, by column and row */
function below(key: UnitKey, depth: number): { column: number; row: number; unit: UnitKey }[] {
	const level = key.level - depth;
	const side = LEAF * 2 ** level;
	const found = [];
	for (let row = 0; level >= 0 && row < 2 ** depth; row++) {
		for (let column = 0; column < 2 ** depth; column++) {
			found.push({ column, row, unit: { level, e: key.e + column * side, n: key.n + row * side } });
		}
	}
	return found;
}

function rowsOf(key: UnitKey): PageRow[] {
	let offset = 0;
	return pagesOf(key.level).map((page) => {
		const row = pageRow(key, page, offset);
		offset += row.length;
		return row;
	});
}

function idxBytes(key: UnitKey): Promise<Uint8Array> {
	const rows = rowsOf(key);
	const children: Idx['children'] = below(key, 1).map(({ column, row, unit }) => ({
		quadrant: column + 2 * row,
		idx: nameOf(unit, 'idx')
	}));
	const descendants: Idx['descendants'] = [];
	for (const depth of [2, 3]) {
		for (const { column, row, unit } of below(key, depth)) {
			descendants.push({ depth, column, row, idx: nameOf(unit, 'idx') });
		}
	}
	const last = rows[rows.length - 1];
	return encodeIdx({
		level: key.level,
		e: key.e,
		n: key.n,
		pack: nameOf(key, 'pack'),
		packSize: last.offset + last.length + rows.length * ROW_BYTES + PACK_TRAILER,
		col: null,
		rows,
		children,
		descendants
	});
}

/** the blobs of the pages range covers; it must start and end on page boundaries */
function packBytes(key: UnitKey, range: Range, url: string): Uint8Array {
	const pages = pagesOf(key.level);
	const rows = rowsOf(key);
	const first = range ? rows.findIndex((row) => row.offset === range[0]) : -1;
	const last = range ? rows.findIndex((row) => row.offset + row.length === range[1]) : -1;
	if (!range || first < 0 || last < first) {
		throw new Error(`${url}: the synthetic world serves whole pages only`);
	}
	const out = new Uint8Array(range[1] - range[0]);
	for (let r = first; r <= last; r++) store(payload(key, pages[r]), out, rows[r].offset - range[0]);
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

/** the payload of a page of unit key: a jittered lattice draped over the ground, each node a family of four a band down */
function payload(key: UnitKey, page: Page): Uint8Array {
	const { g, i, j } = page;
	const count = PAGE_NODES;
	const cell = (PAGE_SIDE * 2 ** g) / GRID;
	const next = numbers(`${key.level}/${key.e}/${key.n}/${g}/${i}/${j}`);
	const position = new Float64Array(3 * count);
	const rotation = new Float32Array(4 * count);
	const scale = new Float32Array(3 * count);
	const opacity = new Float32Array(count);
	const dc = new Float32Array(3 * count);
	const sh = new Float32Array(SH_COEFFS * count);
	const children = new Uint8Array(count);
	const links = new Uint32Array(count);
	for (let t = 0; t < count; t++) {
		const cx = evenBits(t);
		const cy = evenBits(t >> 1);
		const x = (i * GRID + cx + 0.5 + JITTER * (2 * next() - 1)) * cell;
		const y = (j * GRID + cy + 0.5 + JITTER * (2 * next() - 1)) * cell;
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
		const flat = g > 0 && next() < FLAT_TOPPED;
		opacity[t] = flat ? 1 + (OPACITY - 1) * next() : 0.35 + 0.65 * next();

		// displayed colour from height and broad patches, stored as f_dc
		const rise = z / (2 * MID);
		const patch = 0.5 + 0.5 * Math.sin((key.e + x) / 410) * Math.sin((key.n + y) / 330);
		dc[3 * t] = (0.32 + 0.2 * rise + 0.1 * patch - 0.5) / C0;
		dc[3 * t + 1] = (0.42 + 0.15 * patch - 0.1 * rise - 0.5) / C0;
		dc[3 * t + 2] = (0.25 + 0.1 * rise + 0.04 * next() - 0.5) / C0;
		const label = t % BOOK;
		sh.set(PALETTE.subarray(SH_COEFFS * label, SH_COEFFS * (label + 1)), SH_COEFFS * t);
		if (g > 0) {
			children[t] = 4;
			links[t] = familyOf(key.level, page, cx, cy);
		}
	}
	const nodes = { count, position, rotation, scale, opacity, dc, sh, children, links };
	return encodePage(nodes, page).payload;
}
