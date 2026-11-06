// what a stream worker does, as plain functions over the ports

import { reason, type Cache, type Fetch } from '../../ports.ts';
import {
	atrTrailer,
	chunkWords,
	parseAtr,
	packRows,
	parseCol,
	parseIds,
	parseIdx,
	parseUnitPath,
	inflate,
	decodePage,
	ATR_TRAILER,
	type Atr,
	type AtrChunk,
	type Col,
	type DecodedPage,
	type Idx,
	type PageAttribute,
	type PageRow
} from '../../format/index.ts';
import type { Wanted } from './attributes.ts';
import type { UnitFile, Batch } from './scheduler.ts';

export interface Sources {
	fetch: Fetch;
	cache: Cache;
	/** url of world.json's directory, ending in / */
	base: string;
}

/** parsed .col files and .atr tables kept per worker, each */
const KEPT = 64;
/** bytes read from an .atr's end in the hope they hold its tables */
const TAIL = 16 * 1024;
/** bytes two chunks may lie apart and still share a request */
const GAP = 64 * 1024;

/** what a worker keeps of the units it met, by path */
export interface Kept {
	cols: Map<string, Promise<Col>>;
	atrs: Map<string, Promise<Atr>>;
}

export async function loadIdx(sources: Sources, path: string): Promise<Idx> {
	return parseIdx(await whole(sources, path));
}

/**
 * the object ids at url of a unit whose pack is at pack, by the blob offset of each page: cut by
 * its .idx rows, or by its pack's table when the pack keeps levels the rows leave out; the .ids
 * stays out of the cache. throws when the ids fit neither
 */
export async function loadIds(
	sources: Sources,
	url: string,
	pack: UnitFile,
	rows: readonly PageRow[]
): Promise<Map<number, Uint16Array>> {
	const ids = await parseIds(await sources.fetch(url, null));
	const listed = rows.reduce((sum, row) => sum + row.count, 0);
	if (ids.length === listed) return slices(ids, rows);
	// a unit's own level comes last in its pack, so its table starts where the rows' last blob ends
	const from = Math.max(0, ...rows.map((row) => row.offset + row.length));
	const end = pack.size;
	const packUrl = sources.base + pack.path;
	const tail = from < end ? await sources.fetch(packUrl, [from, end]) : new Uint8Array(0);
	const read = async (start: number, stop: number) =>
		start >= from && stop <= end && tail.length === end - from
			? tail.subarray(start - from, stop - from)
			: sources.fetch(packUrl, [start, stop]);
	const table = await packRows(read, pack.size);
	const splats = table.reduce((sum, row) => sum + row.count, 0);
	if (ids.length !== splats) {
		throw new Error(
			`it holds ${ids.length} ids for ${listed} splats, or ${splats} with every level of its pack`
		);
	}
	return slices(ids, table);
}

/** ids cut into the pages of rows, in blob order */
function slices(ids: Uint16Array, rows: readonly PageRow[]): Map<number, Uint16Array> {
	const pages = new Map<number, Uint16Array>();
	let first = 0;
	for (const { offset, count } of rows.toSorted((a, b) => a.offset - b.offset)) {
		pages.set(offset, ids.subarray(first, first + count));
		first += count;
	}
	return pages;
}

/**
 * each page of the batch decoded and colour corrected, with its chunks of the streams wanted, as
 * soon as it is; each page's and chunk's raw bytes are cached alone, so a later batch of other
 * neighbours still hits. a stream no hook requires that fails to load takes its default
 */
export async function* loadBatch(
	sources: Sources,
	batch: Batch,
	streams: readonly Wanted[],
	kept: Kept,
	signal?: AbortSignal
): AsyncGenerator<{ id: number; page: DecodedPage }> {
	const col =
		batch.col === null
			? null
			: keep(kept.cols, batch.col, (path) => whole(sources, path).then(parseCol));
	const attributes =
		batch.atr && streams.length
			? pageAttributes(sources, batch, batch.atr, streams, kept.atrs, signal).catch(
					(error: unknown) => {
						if (signal?.aborted || streams.some((s) => s.required)) throw error;
						console.warn(`${batch.atr!.path}: its streams take their defaults: ${reason(error)}`);
						return null;
					}
				)
			: null;
	// awaited after the blobs, which may fail first
	attributes?.catch(() => undefined);
	const blobs = await pageBlobs(sources, batch, signal);
	const correction = await col;
	const chunks = await attributes;
	for (const [k, job] of batch.pages.entries()) {
		const payload = await inflate(blobs[k]);
		signal?.throwIfAborted();
		const page = decodePage(payload, correction);
		const own = chunks?.get(job.offset)?.filter(({ rows, required }) => {
			if (rows === page.count) return true;
			const fault = `${batch.atr!.path}: a chunk of ${rows} rows for a page of ${page.count}`;
			if (required) throw new Error(fault);
			console.warn(`${fault}; its rows take the default`);
			return false;
		});
		if (own?.length) page.attributes = own.map(({ attribute }) => attribute);
		yield { id: job.id, page };
	}
}

/** by blob offset, the chunks of the batch's pages of the declared streams, as the gpu reads them */
async function pageAttributes(
	sources: Sources,
	batch: Batch,
	file: UnitFile,
	streams: readonly Wanted[],
	atrs: Map<string, Promise<Atr>>,
	signal?: AbortSignal
): Promise<Map<number, { rows: number; required: boolean; attribute: PageAttribute }[]>> {
	const atr = await keep(atrs, file.path, () => atrTables(sources, file));
	const pack = parseUnitPath(batch.pack)?.hash;
	if (atr.pack !== pack) throw new Error(`${file.path} describes pack ${atr.pack}, not ${pack}`);
	const byName = new Map(streams.map((s) => [s.name, s]));
	const offsets = new Set(batch.pages.map((job) => job.offset));
	const wanted = atr.chunks.filter(
		(chunk) => offsets.has(chunk.offset) && byName.has(atr.streams[chunk.stream])
	);
	const deflated = await chunkBodies(sources, file.path, wanted, signal);
	const bodies = await Promise.all(deflated.map((body) => inflate(body)));
	const pages = new Map<number, { rows: number; required: boolean; attribute: PageAttribute }[]>();
	for (const [k, chunk] of wanted.entries()) {
		const { id, required, attribute } = byName.get(atr.streams[chunk.stream])!;
		const words = chunkWords(bodies[k], chunk, attribute);
		const list = pages.get(chunk.offset) ?? [];
		list.push({ rows: chunk.rows, required, attribute: { stream: id, ...words } });
		pages.set(chunk.offset, list);
	}
	return pages;
}

/** an .atr's tables: from its last TAIL bytes when they hold them, else a second read */
async function atrTables(sources: Sources, { path, size }: UnitFile): Promise<Atr> {
	const key = `${path}#tail`;
	const hit = await sources.cache.get(key);
	if (hit) return parseAtr(hit, size);
	const from = Math.max(0, size - TAIL);
	let tail = await range(sources, path, from, size);
	const { tables } = atrTrailer(tail.subarray(tail.length - ATR_TRAILER), size);
	if (tables < from) {
		const head = await range(sources, path, tables, from);
		const joined = new Uint8Array(head.length + tail.length);
		joined.set(head);
		joined.set(tail, head.length);
		tail = joined;
	} else {
		tail = tail.slice(tables - from);
	}
	const atr = parseAtr(tail, size);
	void sources.cache.put(key, tail);
	return atr;
}

/** the deflated chunks, from the cache when all hit, else by a range request a run of near ones, the runs at once */
async function chunkBodies(
	sources: Sources,
	path: string,
	chunks: readonly AtrChunk[],
	signal?: AbortSignal
): Promise<Uint8Array[]> {
	const keys = chunks.map((chunk) => `${path}#${chunk.at}+${chunk.length}`);
	const hits = await Promise.all(keys.map((key) => sources.cache.get(key)));
	signal?.throwIfAborted();
	if (hits.every((hit) => hit !== undefined)) return hits as Uint8Array[];
	const order = chunks.map((_, k) => k).sort((a, b) => chunks[a].at - chunks[b].at);
	const bodies: Uint8Array[] = [];
	const runs: Promise<void>[] = [];
	for (let r = 0; r < order.length;) {
		let end = r + 1;
		let last = chunks[order[r]].at + chunks[order[r]].length;
		while (end < order.length && chunks[order[end]].at - last <= GAP) {
			last = Math.max(last, chunks[order[end]].at + chunks[order[end]].length);
			end++;
		}
		const start = chunks[order[r]].at;
		const run = order.slice(r, end);
		runs.push(
			range(sources, path, start, last, signal).then((bytes) => {
				for (const k of run) {
					const { at, length } = chunks[k];
					bodies[k] = hits[k] ?? bytes.slice(at - start, at - start + length);
					if (!hits[k]) void sources.cache.put(keys[k], bodies[k]);
				}
			})
		);
		r = end;
	}
	await Promise.all(runs);
	return bodies;
}

/** bytes start to end of path, which must give them all */
async function range(
	sources: Sources,
	path: string,
	start: number,
	end: number,
	signal?: AbortSignal
): Promise<Uint8Array> {
	const bytes = await sources.fetch(sources.base + path, [start, end], signal);
	if (bytes.length !== end - start)
		throw new Error(`${path}: ${bytes.length} bytes for ${start}-${end}`);
	return bytes;
}

async function whole(sources: Sources, path: string): Promise<Uint8Array> {
	const hit = await sources.cache.get(path);
	if (hit) return hit;
	const bytes = await sources.fetch(sources.base + path, null);
	void sources.cache.put(path, bytes);
	return bytes;
}

/** the batch's deflated pages, from the cache when all hit, else from one range request */
async function pageBlobs(sources: Sources, batch: Batch, signal?: AbortSignal) {
	const keys = batch.pages.map((job) => `${batch.pack}#${job.offset}+${job.length}`);
	const hits = await Promise.all(keys.map((key) => sources.cache.get(key)));
	signal?.throwIfAborted();
	if (hits.every((hit) => hit !== undefined)) return hits as Uint8Array[];
	const bytes = await range(sources, batch.pack, batch.start, batch.end, signal);
	return batch.pages.map((job, k) => {
		const blob = bytes.slice(job.offset - batch.start, job.offset - batch.start + job.length);
		if (!hits[k]) void sources.cache.put(keys[k], blob);
		return blob;
	});
}

/** what load gives for path, kept in map, most recent last, up to KEPT */
function keep<T>(
	map: Map<string, Promise<T>>,
	path: string,
	load: (path: string) => Promise<T>
): Promise<T> {
	let value = map.get(path);
	if (value) map.delete(path);
	else {
		const loading = load(path);
		// a failed load is not kept, so the next batch retries it
		loading.catch(() => {
			if (map.get(path) === loading) map.delete(path);
		});
		value = loading;
	}
	map.set(path, value);
	if (map.size > KEPT) {
		const [oldest] = map.keys();
		map.delete(oldest);
	}
	return value;
}
