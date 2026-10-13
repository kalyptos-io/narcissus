// what a stream worker does, as plain functions over the ports

import type { Cache, Fetch } from '../../ports.ts';
import type { Col, DecodedPage, Idx } from '../../format/types.ts';
import { parseCol } from '../../format/col.ts';
import { parseIdx } from '../../format/idx.ts';
import { inflate } from '../../format/inflate.ts';
import { decodePage } from '../../format/page.ts';
import type { Batch } from './scheduler.ts';

export interface Sources {
	fetch: Fetch;
	cache: Cache;
	/** url of world.json's directory, ending in / */
	base: string;
}

/** parsed .col files kept per worker */
const COLS = 64;

export async function loadIdx(sources: Sources, path: string): Promise<Idx> {
	return parseIdx(await whole(sources, path));
}

/**
 * each page of the batch decoded and colour corrected, as soon as it is; each page's raw bytes are
 * cached alone, so a later batch of other neighbours still hits; cols holds parsed .col files by path
 */
export async function* loadBatch(
	sources: Sources,
	batch: Batch,
	cols: Map<string, Promise<Col>>,
	signal?: AbortSignal
): AsyncGenerator<{ id: number; page: DecodedPage }> {
	const col = batch.col === null ? null : colOf(sources, batch.col, cols);
	const blobs = await pageBlobs(sources, batch, signal);
	const correction = await col;
	for (const [k, job] of batch.pages.entries()) {
		const payload = await inflate(blobs[k]);
		signal?.throwIfAborted();
		yield { id: job.id, page: decodePage(payload, correction) };
	}
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
	const bytes = await sources.fetch(sources.base + batch.pack, [batch.start, batch.end], signal);
	if (bytes.length !== batch.end - batch.start) {
		throw new Error(`${batch.pack}: ${bytes.length} bytes for ${batch.start}-${batch.end}`);
	}
	return batch.pages.map((job, k) => {
		const blob = bytes.slice(job.offset - batch.start, job.offset - batch.start + job.length);
		if (!hits[k]) void sources.cache.put(keys[k], blob);
		return blob;
	});
}

function colOf(sources: Sources, path: string, cols: Map<string, Promise<Col>>): Promise<Col> {
	let col = cols.get(path);
	if (col) cols.delete(path);
	else {
		const loading = whole(sources, path).then(parseCol);
		// a failed load is not kept, so the next batch retries it
		loading.catch(() => {
			if (cols.get(path) === loading) cols.delete(path);
		});
		col = loading;
	}
	cols.set(path, col);
	if (cols.size > COLS) {
		const [oldest] = cols.keys();
		cols.delete(oldest);
	}
	return col;
}
