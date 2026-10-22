// a world checked as a reader meets it: every file there and well formed, and when deep what its name says

import {
	contentHash,
	decodePage,
	directory,
	inflate,
	PACK_MAGIC,
	PACK_TRAILER,
	parseCol,
	parseUnitPath,
	ROW_BYTES,
	rowAt,
	unitPath,
	VERSION,
	type PageRow
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
	/** also reads every pack whole: each file's hash against its name, and every page decoded */
	deep?: boolean;
	/** also asks an http world's server, with a plain request, for a range and for cors */
	server?: boolean;
	/** runs as each unit is done */
	progress?: (report: Report) => void;
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
const told = (error: unknown) => (error instanceof Missing ? 'is missing' : reason(error));

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
	const check = async (unit: Unit) => {
		await checkUnit(source, base, unit, options.deep ?? false, report);
		options.progress?.(report);
	};
	// a deep check holds a whole pack per unit
	const abreast = options.deep ? 2 : 8;
	let probed = !options.server;
	let running: Promise<void>[] = [];
	for await (const unit of walk(source, worldUrl, world, fault)) {
		if (!probed) {
			probed = true;
			const pack = unitPath(unit.idx, unit.idx.pack, 'pack');
			for (const found of await probe(base + pack))
				report.faults.push({ path: pack, fault: found });
		}
		running.push(check(unit));
		if (running.length < abreast) continue;
		await Promise.all(running);
		running = [];
	}
	await Promise.all(running);
	return report;
}

async function checkUnit(source: Fetch, base: string, unit: Unit, deep: boolean, report: Report) {
	const { idx, path, bytes } = unit;
	const fault = (at: string, what: string) => report.faults.push({ path: at, fault: what });
	report.units++;
	report.files++;
	report.bytes += bytes.length;
	const named = parseUnitPath(path)!;
	if (named.level !== idx.level || named.e !== idx.e || named.n !== idx.n) {
		fault(path, `holds unit ${idx.level}/${idx.e}/${idx.n}`);
	}
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
		const table = await packTable(read, idx.packSize);
		for (const row of idx.rows) {
			const key = `${row.g}/${row.i}/${row.j}`;
			const page = `page ${key}`;
			const listed = table.get(key);
			if (!listed || listed.offset !== row.offset || listed.length !== row.length) {
				fault(pack, `does not list ${page} as its .idx does`);
			} else if (whole) {
				const found = await checkPage(await read(row.offset, row.offset + row.length), row);
				if (found) fault(pack, `${page} ${found}`);
			}
		}
	} catch (error) {
		fault(pack, told(error));
	}
}

/** the rows of a pack's page table by g/i/j, through read(start, end) */
async function packTable(
	read: (start: number, end: number) => Promise<Uint8Array>,
	size: number
): Promise<Map<string, PageRow>> {
	if (size < PACK_TRAILER) throw new Error('is shorter than a pack trailer');
	const trailer = await read(size - PACK_TRAILER, size);
	const view = new DataView(trailer.buffer, trailer.byteOffset, trailer.byteLength);
	if (String.fromCharCode(...trailer.subarray(8, 12)) !== PACK_MAGIC) {
		throw new Error('does not end in a pack trailer');
	}
	const version = view.getUint16(12, true);
	if (version !== VERSION) throw new Error(`is version ${version}; narcissus reads ${VERSION}`);
	const offset = view.getUint32(0, true);
	const rows = view.getUint32(4, true);
	if (offset + rows * ROW_BYTES !== size - PACK_TRAILER) {
		throw new Error('has a page table that does not end at its trailer');
	}
	const bytes = await read(offset, size - PACK_TRAILER);
	const table = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const byPage = new Map<string, PageRow>();
	for (let r = 0; r < rows; r++) {
		const row = rowAt(table, r * ROW_BYTES);
		byPage.set(`${row.g}/${row.i}/${row.j}`, row);
	}
	return byPage;
}

/** what is wrong with a page blob against its row, or nothing */
async function checkPage(blob: Uint8Array, row: PageRow): Promise<string | undefined> {
	let payload: Uint8Array;
	try {
		payload = await inflate(blob);
	} catch {
		return 'is not a valid deflate stream';
	}
	try {
		const page = decodePage(payload, null);
		if (page.count !== row.count) return `holds ${page.count} splats, its row ${row.count}`;
		if (page.quadrants.some((first, q) => first !== row.quadrants[q])) {
			return 'does not start its quadrants where its row does';
		}
	} catch (error) {
		return `does not decode: ${reason(error)}`;
	}
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
