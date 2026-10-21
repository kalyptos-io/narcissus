// a world checked as a reader meets it: every file there and well formed, and when deep what its name says and the tree its pages make

import {
	contentHash,
	decodePage,
	directory,
	extents,
	inflate,
	linkRow,
	linkStart,
	linkUnit,
	PACK_MAGIC,
	PACK_TRAILER,
	PAGE_SIDE,
	PARAMS,
	parseCol,
	parseUnitPath,
	readSplat,
	ROW_BYTES,
	rowAt,
	sigmas,
	TOP_PAGE,
	unitPath,
	VERSION,
	LEAF,
	type DecodedPage,
	type Idx,
	type PageRow,
	type UnitKey
} from '../format/index.ts';
import { Missing, type Fetch } from '../ports.ts';
import { openWorld, walk, type Unit } from './walk.ts';

export interface Fault {
	/** relative to world.json */
	path: string;
	fault: string;
}

export interface Report {
	units: number;
	/** the .idx, .pack and .col files reached */
	files: number;
	/** their bytes, a pack by the size its .idx gives */
	bytes: number;
	faults: Fault[];
}

export interface ValidateOptions {
	/** also reads every pack whole: each file's hash against its name, every page decoded, and the tree its links make */
	deep?: boolean;
	/** also asks an http world's server, with a plain request, for a range and for cors */
	server?: boolean;
	/** runs as each unit is done */
	progress?: (report: Report) => void;
}

/** a family by its page row, first node and count, in the unit that stores it */
type Family = [row: number, start: number, count: number];

/** what the deep check carries from a unit to its children: the families its links reach in each, by unit key; null where it could not tell */
type Incoming = Map<string, Family[] | null>;

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
const told = (error: unknown) => (error instanceof Missing ? 'is missing' : reason(error));
const keyOf = ({ level, e, n }: UnitKey) => `${level}/${e}/${n}`;

export async function validate(
	source: Fetch,
	worldUrl: string,
	options: ValidateOptions = {}
): Promise<Report> {
	const report: Report = { units: 0, files: 0, bytes: 0, faults: [] };
	const fault = (path: string, error: unknown) => report.faults.push({ path, fault: told(error) });
	let world;
	try {
		world = await openWorld(source, worldUrl);
	} catch (error) {
		fault('world.json', error);
		return report;
	}
	const base = directory(worldUrl);
	const roots = new Set(world.roots.map(keyOf));
	const incoming: Incoming = new Map();
	const check = async (unit: Unit) => {
		await checkUnit(source, base, unit, roots, options.deep ? incoming : null, report);
		options.progress?.(report);
	};
	// a deep check holds a whole pack per unit
	const abreast = options.deep ? 2 : 8;
	let probed = !options.server;
	let running: Promise<void>[] = [];
	let level = -1;
	for await (const unit of walk(source, worldUrl, world, fault)) {
		if (!probed) {
			probed = true;
			const pack = unitPath(unit.idx, unit.idx.pack, 'pack');
			for (const found of await probe(base + pack))
				report.faults.push({ path: pack, fault: found });
		}
		// a deep check of a unit needs its parent's done
		if (options.deep && unit.idx.level !== level) {
			level = unit.idx.level;
			await Promise.all(running);
			running = [];
		}
		running.push(check(unit));
		if (running.length < abreast) continue;
		await Promise.all(running);
		running = [];
	}
	await Promise.all(running);
	return report;
}

async function checkUnit(
	source: Fetch,
	base: string,
	unit: Unit,
	roots: Set<string>,
	incoming: Incoming | null,
	report: Report
) {
	const { idx, path, bytes } = unit;
	const fault = (at: string, what: string) => report.faults.push({ path: at, fault: what });
	report.units++;
	report.files++;
	report.bytes += bytes.length;
	const named = parseUnitPath(path)!;
	if (named.level !== idx.level || named.e !== idx.e || named.n !== idx.n) {
		fault(path, `holds unit ${idx.level}/${idx.e}/${idx.n}`);
	}
	const root = roots.has(keyOf(idx));
	const order = rowOrder(idx, root);
	if (order) fault(path, order);
	const deep = incoming !== null;
	if (deep && contentHash(bytes) !== named.hash) fault(path, 'does not have the hash in its name');

	if (idx.col) {
		const col = unitPath(idx, idx.col, 'col');
		try {
			const file = await source(base + col, null);
			report.files++;
			report.bytes += file.length;
			await parseCol(file);
			if (deep && contentHash(file) !== idx.col) fault(col, 'does not have the hash in its name');
		} catch (error) {
			fault(col, told(error));
		}
	}

	const pack = unitPath(idx, idx.pack, 'pack');
	// the decoded pages by row, a page that did not decode null
	const pages: (DecodedPage | null)[] = [];
	try {
		report.files++;
		report.bytes += idx.packSize;
		const whole = deep ? await source(base + pack, null) : null;
		if (whole && whole.length !== idx.packSize) {
			throw new Error(`holds ${whole.length} bytes, its .idx gives ${idx.packSize}`);
		}
		if (whole && contentHash(whole) !== idx.pack) fault(pack, 'does not have the hash in its name');
		const read = async (start: number, end: number) => {
			const part = whole ? whole.subarray(start, end) : await source(base + pack, [start, end]);
			if (part.length !== end - start) {
				throw new Error(`gives ${part.length} bytes for ${start}-${end}`);
			}
			return part;
		};
		const { rows, fit } = await packTable(read, idx.packSize);
		let fits = 0;
		for (const [r, row] of idx.rows.entries()) {
			const page = `page ${row.g}/${row.i}/${row.j}`;
			const listed = rows[r];
			if (!listed || !sameRow(listed, row)) {
				fault(pack, `does not list ${page} as its .idx does`);
				pages.push(null);
			} else if (whole) {
				const { found, decoded } = await checkPage(
					await read(row.offset, row.offset + row.length),
					row
				);
				if (found) fault(pack, `${page} ${found}`);
				pages.push(decoded ?? null);
				if (decoded) for (const count of decoded.nodes.counts) if (!count) fits++;
			}
		}
		const expected = idx.level === 0 ? fits : 0;
		if (whole && pages.every(Boolean) && fit !== expected) {
			fault(pack, `gives ${fit} fit splats in its trailer, its pages hold ${expected}`);
		}
	} catch (error) {
		fault(pack, told(error));
	}
	if (incoming) checkTree(idx, root, pages, incoming, (what) => fault(pack, what));
}

/** what is wrong with the order, bands and flags of a unit's rows, or nothing */
function rowOrder(idx: Idx, root: boolean): string | undefined {
	const own = idx.level === 0 ? [0, 1] : [idx.level + 1];
	const coarsest = own[own.length - 1];
	const last = idx.rows.length - 1;
	let previous = -1;
	for (const [r, { g, i, j, flags }] of idx.rows.entries()) {
		const top = (flags & TOP_PAGE) !== 0;
		if (top && (!root || r !== last)) return "marks a top page that is not a root's last row";
		if (g < own[0] || (!root && g > coarsest)) return `lists a page of band ${g}, not its own`;
		const span = Math.max(1, (LEAF * 2 ** idx.level) / (PAGE_SIDE * 2 ** g));
		if (i >= span || j >= span) return `lists page ${g}/${i}/${j} outside its square`;
		const at = g * 2 ** 32 + morton(i, j);
		if (at <= previous)
			return 'does not list its rows fine to coarse, in morton order within a band';
		previous = at;
	}
	if (root && ((idx.rows[last]?.flags ?? 0) & TOP_PAGE) === 0)
		return 'is a root without a top page';
}

/**
 * the tree a unit's pages make: every link in range, every node of its own pages reached exactly
 * once from the top (a root's top page, else the families its parent's links reach), and the
 * families its links reach in its children handed on to them
 */
function checkTree(
	idx: Idx,
	root: boolean,
	pages: (DecodedPage | null)[],
	incoming: Incoming,
	fault: (what: string) => void
): void {
	const key = keyOf(idx);
	const given = incoming.get(key);
	incoming.delete(key);
	const half = (LEAF * 2 ** idx.level) / 2;
	const childKeys = [0, 1, 2, 3].map((q) =>
		keyOf({ level: idx.level - 1, e: idx.e + (q & 1) * half, n: idx.n + (q >> 1) * half })
	);
	const named = new Set(idx.children.map((child) => child.quadrant));
	const unknown = () => {
		for (const q of named) incoming.set(childKeys[q], null);
	};
	if ((!root && !given) || pages.length !== idx.rows.length || !pages.every(Boolean)) {
		unknown();
		return;
	}
	const decoded = pages as DecodedPage[];
	const reached = decoded.map((page) => new Uint8Array(page.count));
	const ranks = decoded.map((page) => {
		const rank = new Int32Array(page.count).fill(-1);
		let s = 0;
		page.nodes.counts.forEach((count, t) => {
			if (count) rank[t] = s++;
		});
		return rank;
	});
	// faults a page and kind, counted so a broken page is one line
	const counted = new Map<string, number>();
	const tally = (what: string) => counted.set(what, (counted.get(what) ?? 0) + 1);
	const name = (r: number) => `page ${idx.rows[r].g}/${idx.rows[r].i}/${idx.rows[r].j}`;
	const handed: Family[][] = [[], [], [], []];
	const stack: Family[] = [];
	if (root) stack.push([idx.rows.length - 1, 0, decoded[idx.rows.length - 1].count]);
	else stack.push(...given!);
	while (stack.length) {
		const [r, start, count] = stack.pop()!;
		const page = decoded[r];
		if (!page || start + count > page.count) {
			tally(`has links to a family past ${page ? name(r) : `row ${r}`}`);
			continue;
		}
		for (let t = start; t < start + count; t++) {
			if (reached[r][t]++) {
				tally(`${name(r)} has nodes reached more than once`);
				continue;
			}
			const children = page.nodes.counts[t];
			if (!children) continue;
			const link = page.nodes.links[ranks[r][t]];
			const family: Family = [linkRow(link), linkStart(link), children];
			const unit = linkUnit(link);
			if (unit === 0) stack.push(family);
			else if (unit <= 4 && named.has(unit - 1)) handed[unit - 1].push(family);
			else tally(`${name(r)} links to a child unit it does not name`);
		}
	}
	reached.forEach((page, r) => {
		const missed = page.reduce((sum, times) => sum + (times ? 0 : 1), 0);
		if (missed) tally(`${name(r)} has ${missed} nodes not reached from the top`);
	});
	for (const [what, times] of counted) fault(times > 1 ? `${what} (${times} times)` : what);
	for (const q of named) incoming.set(childKeys[q], handed[q]);
}

/** two rows the same in every field */
function sameRow(a: PageRow, b: PageRow): boolean {
	return (
		a.g === b.g &&
		a.i === b.i &&
		a.j === b.j &&
		a.flags === b.flags &&
		a.count === b.count &&
		a.offset === b.offset &&
		a.length === b.length &&
		a.box.every((v, c) => v === b.box[c])
	);
}

function morton(i: number, j: number): number {
	let m = 0;
	for (let b = 0; b < 8; b++) m |= (((i >> b) & 1) << (2 * b)) | (((j >> b) & 1) << (2 * b + 1));
	return m;
}

/** the rows of a pack's page table in order and its trailer's fit splats, through read(start, end) */
async function packTable(
	read: (start: number, end: number) => Promise<Uint8Array>,
	size: number
): Promise<{ rows: PageRow[]; fit: number }> {
	if (size < PACK_TRAILER) throw new Error('is shorter than a pack trailer');
	const trailer = await read(size - PACK_TRAILER, size);
	const view = new DataView(trailer.buffer, trailer.byteOffset, trailer.byteLength);
	if (String.fromCharCode(...trailer.subarray(12, 16)) !== PACK_MAGIC) {
		throw new Error('does not end in a pack trailer');
	}
	const version = view.getUint16(16, true);
	if (version !== VERSION) throw new Error(`is version ${version}; narcissus reads ${VERSION}`);
	const fit = view.getUint32(0, true);
	const offset = view.getUint32(4, true);
	const count = view.getUint32(8, true);
	if (offset + count * ROW_BYTES !== size - PACK_TRAILER) {
		throw new Error('has a page table that does not end at its trailer');
	}
	const bytes = await read(offset, size - PACK_TRAILER);
	const table = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const rows = Array.from({ length: count }, (_, r) => rowAt(table, r * ROW_BYTES));
	return { rows, fit };
}

/** a page blob decoded, and what is wrong with it against its row */
async function checkPage(
	blob: Uint8Array,
	row: PageRow
): Promise<{ found?: string; decoded?: DecodedPage }> {
	let payload: Uint8Array;
	try {
		payload = await inflate(blob);
	} catch {
		return { found: 'is not a valid deflate stream' };
	}
	let decoded: DecodedPage;
	try {
		decoded = decodePage(payload, null);
	} catch (error) {
		return { found: `does not decode: ${reason(error)}` };
	}
	if (decoded.count !== row.count) {
		return { found: `holds ${decoded.count} nodes, its row ${row.count}` };
	}
	const outside = beyondBox(decoded, row.box);
	if (outside) return { found: `has ${outside} nodes reaching past its row's box`, decoded };
	return { decoded };
}

/** nodes whose k(α) sigma extents leave box by more than their codes can move them */
function beyondBox(page: DecodedPage, box: Float32Array): number {
	const step = Math.max(...page.params.subarray(PARAMS.step, PARAMS.step + 3));
	const e = new Float64Array(3);
	let outside = 0;
	for (let t = 0; t < page.count; t++) {
		const { position, rotation, scale, opacity } = readSplat(page, t);
		const k = sigmas(opacity);
		extents(rotation, scale[0], scale[1], scale[2], k, e);
		// a code is half a step off in position, and a few hundredths of a scale in rotation and scale
		const slack = step + 0.03 * k * Math.max(...scale);
		for (let a = 0; a < 3; a++) {
			if (position[a] - e[a] < box[a] - slack || position[a] + e[a] > box[3 + a] + slack) {
				outside++;
				break;
			}
		}
	}
	return outside;
}

/** what a browser on another origin would miss from the server of url: ranges answered as ranges, and cors */
export async function probe(url: string): Promise<string[]> {
	const origin = 'https://narcissus.example';
	const faults: string[] = [];
	let response: Response;
	try {
		response = await fetch(url, { headers: { Range: 'bytes=0-0', Origin: origin } });
		await response.arrayBuffer();
	} catch (error) {
		return [`the server did not answer: ${reason(error)}`];
	}
	if (response.status !== 206) {
		faults.push(`the server answers a range request with status ${response.status}, not 206`);
	}
	const allowed = response.headers.get('access-control-allow-origin');
	if (allowed !== '*' && allowed !== origin) {
		faults.push('the server sends no access-control-allow-origin for another origin');
	}
	return faults;
}
