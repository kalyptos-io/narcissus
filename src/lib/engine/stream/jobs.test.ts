import { describe, expect, it } from 'vitest';
import type { Cache, Fetch } from '../ports.ts';
import type { Col, Idx } from '../types.ts';
import { parseCol } from '../format/col.ts';
import { encodeCol, encodeIdx, encodePack, encodePage, type Splats } from '../format/encode.ts';
import { parseIdx } from '../format/idx.ts';
import { deflate } from '../format/inflate.ts';
import { decodePage } from '../format/page.ts';
import { PAGE_SIDE } from '../format/spec.ts';
import { loadBatch, loadIdx, type Sources } from './jobs.ts';
import { memoryCache } from './memory.ts';
import type { Batch, PageJob } from './scheduler.ts';

const base = 'https://w/';
const unit = { level: 0, e: 724000, n: 6177000 };
const PACK = 'u/0/724000/6177000.0123456789abcdef.pack';
const COL = 'u/0/724000/6177000.fedcba9876543210.col';
const IDX = 'u/0/724000/6177000.00112233445566ff.idx';

const none: Cache = { get: async () => undefined, put: async () => undefined };

/** count splats of quadrant 0 of page column i */
function splats(count: number, i: number): Splats {
	const position = new Float64Array(3 * count);
	const rotation = new Float32Array(4 * count);
	const dc = new Float32Array(3 * count);
	for (let t = 0; t < count; t++) {
		position.set([PAGE_SIDE * i + 0.5 + 0.8 * t, 2 + 0.5 * t, 10 + 0.1 * t], 3 * t);
		rotation.set([1, 0, 0, 0], 4 * t);
		dc.set([0.1 * t, -0.2, 0.3], 3 * t);
	}
	const scale = new Float32Array(3 * count).fill(-3);
	const alpha = new Float32Array(count).fill(0.5);
	return { count, position, rotation, scale, alpha, dc, sh: null };
}

/** a unit of three adjacent pages with a col and an idx, served from memory */
async function world() {
	const pages = await Promise.all(
		[0, 1, 2].map(async (i) => {
			const { payload, row } = encodePage(splats(6 + i, i), { g: 0, i, j: 0 });
			return { payload, row, blob: await deflate(payload) };
		})
	);
	let offset = 0;
	for (const page of pages) {
		page.row = { ...page.row, offset, length: page.blob.length };
		offset += page.blob.length;
	}
	const pack = encodePack(pages.map(({ row, blob }) => ({ row, blob })));
	const col: Col = { n: 2, pitch: 250, margin: 0, values: new Float32Array(48).fill(0.02) };
	const colBytes = await encodeCol(col);
	const idx: Idx = {
		...unit,
		pack: '0123456789abcdef',
		packSize: pack.length,
		col: 'fedcba9876543210',
		rows: pages.map(({ row }) => row),
		children: [],
		descendants: []
	};
	const idxBytes = await encodeIdx(idx);
	const files = new Map([
		[base + PACK, pack],
		[base + COL, colBytes],
		[base + IDX, idxBytes]
	]);
	const calls: { url: string; range: readonly [number, number] | null }[] = [];
	const fetch: Fetch = async (url, range) => {
		calls.push({ url, range });
		const file = files.get(url);
		if (!file) throw new Error(`no ${url}`);
		return range ? file.slice(range[0], range[1]) : file.slice();
	};
	const jobs: PageJob[] = pages.map(({ row }, k) => ({
		id: k + 1,
		pack: PACK,
		col: COL,
		offset: row.offset,
		length: row.length
	}));
	const parsed = await parseCol(colBytes);
	const decoded = pages.map(({ payload }) => decodePage(payload, parsed));
	return { fetch, calls, jobs, decoded, idxBytes };
}

function batch(pages: PageJob[]): Batch {
	return {
		pack: PACK,
		col: COL,
		start: Math.min(...pages.map((p) => p.offset)),
		end: Math.max(...pages.map((p) => p.offset + p.length)),
		window: 0,
		pages
	};
}

const sources = (fetch: Fetch, cache: Cache): Sources => ({ fetch, cache, base });

describe('loadBatch', () => {
	it('decodes and colour corrects every page of a batch from one range request', async () => {
		const { fetch, calls, jobs, decoded } = await world();
		const all = batch(jobs);
		const loaded = await Array.fromAsync(
			loadBatch(sources(fetch, memoryCache(2 ** 20)), all, new Map())
		);
		expect(loaded).toEqual([
			{ id: 1, page: decoded[0] },
			{ id: 2, page: decoded[1] },
			{ id: 3, page: decoded[2] }
		]);
		expect(calls.filter((c) => c.url === base + PACK)).toEqual([
			{ url: base + PACK, range: [all.start, all.end] }
		]);
		expect(calls.filter((c) => c.url === base + COL)).toHaveLength(1);
	});

	it('skips the fetch when every page and the col hit the cache', async () => {
		const { fetch, calls, jobs, decoded } = await world();
		const cache = memoryCache(2 ** 20);
		await Array.fromAsync(loadBatch(sources(fetch, cache), batch(jobs), new Map()));
		const fetched = calls.length;
		const again = await Array.fromAsync(
			loadBatch(sources(fetch, cache), batch(jobs.slice(1, 2)), new Map())
		);
		expect(again).toEqual([{ id: 2, page: decoded[1] }]);
		expect(calls).toHaveLength(fetched);
	});

	it('fetches the whole range once when only some pages hit', async () => {
		const { fetch, calls, jobs, decoded } = await world();
		const cache = memoryCache(2 ** 20);
		const cols = new Map<string, Promise<Col>>();
		await Array.fromAsync(loadBatch(sources(fetch, cache), batch(jobs.slice(0, 1)), cols));
		calls.length = 0;
		const all = batch(jobs);
		const loaded = await Array.fromAsync(loadBatch(sources(fetch, cache), all, cols));
		expect(loaded.map(({ page }) => page)).toEqual(decoded);
		expect(calls).toEqual([{ url: base + PACK, range: [all.start, all.end] }]);
	});

	it('fetches and parses a col once per path through cols', async () => {
		const { fetch, calls, jobs } = await world();
		const cols = new Map<string, Promise<Col>>();
		await Array.fromAsync(loadBatch(sources(fetch, none), batch(jobs.slice(0, 1)), cols));
		await Array.fromAsync(loadBatch(sources(fetch, none), batch(jobs.slice(2, 3)), cols));
		expect(calls.filter((c) => c.url === base + COL)).toHaveLength(1);
		expect([...cols.keys()]).toEqual([COL]);
	});

	it('rejects with an AbortError and fetches no pages once aborted', async () => {
		const { fetch, calls, jobs } = await world();
		const loading = Array.fromAsync(
			loadBatch(sources(fetch, none), batch(jobs), new Map(), AbortSignal.abort())
		);
		const error = await loading.catch((e: unknown) => e);
		expect((error as DOMException).name).toBe('AbortError');
		expect(calls.filter((c) => c.url === base + PACK)).toHaveLength(0);
	});
});

describe('loadIdx', () => {
	it('parses the idx and serves it from the cache the second time', async () => {
		const { fetch, calls, idxBytes } = await world();
		const cache = memoryCache(2 ** 20);
		const idx = await loadIdx(sources(fetch, cache), IDX);
		expect(idx).toEqual(await parseIdx(idxBytes));
		expect(await loadIdx(sources(fetch, cache), IDX)).toEqual(idx);
		expect(calls).toEqual([{ url: base + IDX, range: null }]);
	});
});
