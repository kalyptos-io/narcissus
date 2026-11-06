// a world checked as a reader meets it: every file there and well formed, and when deep what its name says

import {
	atrTrailer,
	contentHash,
	decodePage,
	directory,
	inflate,
	packRows,
	parseAtr,
	parseCol,
	parseUnitPath,
	readRecords,
	readValues,
	unitPath,
	ATR_TRAILER,
	type Attribute,
	type Idx,
	type PageRow
} from '../format/index.ts';
import { Missing, reason, type Fetch } from '../ports.ts';
import { openWorld, walk, type Unit } from './walk.ts';

export interface Fault {
	/** relative to world.json */
	path: string;
	fault: string;
}

export interface Report {
	units: number;
	/** the .idx, .pack, .col and .atr files reached */
	files: number;
	/** their bytes, a pack by the size its .idx gives */
	bytes: number;
	faults: Fault[];
}

export interface ValidateOptions {
	/** also reads every pack and .atr whole: each file's hash against its name, every page and chunk decoded */
	deep?: boolean;
	/** also asks an http world's server, with a plain request, for a range and for cors */
	server?: boolean;
	/** runs as each unit is done */
	progress?: (report: Report) => void;
}

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
		await checkUnit(source, base, unit, world.attributes, options.deep ?? false, report);
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

async function checkUnit(
	source: Fetch,
	base: string,
	unit: Unit,
	attributes: Record<string, Attribute>,
	deep: boolean,
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
	let table: PageRow[] | null = null;
	try {
		report.files++;
		report.bytes += idx.packSize;
		const { whole, read } = await reader(source, base + pack, idx.packSize, deep);
		if (whole && contentHash(whole) !== idx.pack) fault(pack, 'does not have the hash in its name');
		table = await packRows(read, idx.packSize);
		const pages = new Map(table.map((row) => [`${row.g}/${row.i}/${row.j}`, row]));
		for (const row of idx.rows) {
			const key = `${row.g}/${row.i}/${row.j}`;
			const page = `page ${key}`;
			const listed = pages.get(key);
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
	if (idx.atr) await checkAtr(source, base, idx, table, attributes, deep, report);
}

/** ranges of the file at url of size bytes, from the whole of it when deep; throws on a short file */
async function reader(source: Fetch, url: string, size: number, deep: boolean) {
	const whole = deep ? await source(url, null) : null;
	if (whole && whole.length !== size) {
		throw new Error(`holds ${whole.length} bytes, its .idx gives ${size}`);
	}
	const read = async (start: number, end: number) => {
		const part = whole ? whole.subarray(start, end) : await source(url, [start, end]);
		if (part.length !== end - start)
			throw new Error(`gives ${part.length} bytes for ${start}-${end}`);
		return part;
	};
	return { whole, read };
}

/** an .atr against its unit's pack table, when it read, and the streams world.json declares */
async function checkAtr(
	source: Fetch,
	base: string,
	idx: Idx,
	table: PageRow[] | null,
	attributes: Record<string, Attribute>,
	deep: boolean,
	report: Report
) {
	const path = unitPath(idx, idx.atr!, 'atr');
	const fault = (what: string) => report.faults.push({ path, fault: what });
	const size = idx.atrSize;
	report.files++;
	report.bytes += size;
	try {
		const { whole, read } = await reader(source, base + path, size, deep);
		if (whole && contentHash(whole) !== idx.atr) fault('does not have the hash in its name');
		const { tables } = atrTrailer(await read(size - ATR_TRAILER, size), size);
		const atr = parseAtr(await read(tables, size), size);
		if (atr.pack !== idx.pack) fault(`describes pack ${atr.pack}, not ${idx.pack}`);
		for (const name of atr.streams) {
			if (!attributes[name]) fault(`holds stream ${name}, which world.json does not declare`);
		}
		const pages = new Map(table?.map((row) => [row.offset, row]));
		for (const chunk of atr.chunks) {
			const name = atr.streams[chunk.stream];
			const at = `the ${name} chunk at blob offset ${chunk.offset}`;
			const page = pages.get(chunk.offset);
			if (table && !page) fault(`has ${at}, where no page of the pack starts`);
			else if (page && page.count !== chunk.rows) {
				fault(`has ${at} of ${chunk.rows} rows, for a page of ${page.count}`);
			}
			const a = attributes[name];
			if (!whole || !a) continue;
			try {
				const body = await inflate(whole.subarray(chunk.at, chunk.at + chunk.length));
				if (a.type === 'records') readRecords(body, chunk, a);
				else readValues(body, chunk, a);
			} catch (error) {
				fault(`has ${at} that does not decode: ${reason(error)}`);
			}
		}
	} catch (error) {
		fault(told(error));
	}
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
