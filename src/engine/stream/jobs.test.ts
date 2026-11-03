import { describe, expect, it, vi } from 'vitest';
import type { Cache, Fetch } from '../../ports.ts';
import {
	namedUnits,
	parseCol,
	parseIdx,
	parseWorld,
	unitPath,
	decodePage,
	ENCODING,
	LEAF,
	PAGE_SIDE,
	type Attribute,
	type Col,
	type Idx,
	type UnitKey
} from '../../format/index.ts';
import {
	deflate,
	encodeAtr,
	encodeChunk,
	encodeCol,
	encodeIds,
	encodeIdx,
	encodePack,
	encodePage,
	type Splats
} from '../../format/encode.ts';
import type { Wanted } from './attributes.ts';
import { loadBatch, loadIdx, loadIds, type Kept, type Sources } from './jobs.ts';
import { memoryCache } from '../../adapters/memory.ts';
import type { Batch, PageJob } from './scheduler.ts';
import { synthetic } from './synthetic.ts';

const base = 'https://w/';
const unit = { level: 0, e: 724000, n: 6177000 };
const PACK = 'u/0/724000/6177000.0123456789abcdef.pack';
const COL = 'u/0/724000/6177000.fedcba9876543210.col';
const IDX = 'u/0/724000/6177000.00112233445566ff.idx';
const ATR = 'u/0/724000/6177000.aabbccddeeff0011.atr';
const IDS = 'https://host/6177000.ids';
const CLASS: Attribute = { type: 'u16', components: 1, default: [0], rule: 'preserved' };

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
		atr: null,
		atrSize: 0,
		rows: pages.map(({ row }) => row),
		children: [],
		descendants: []
	};
	const idxBytes = await encodeIdx(idx);
	// a class per splat: its index, on every page but the last
	const classes = pages.map(({ row }) => Array.from({ length: row.count }, (_, t) => t + 1));
	const atr = await encodeAtr(
		'0123456789abcdef',
		['test.class'],
		pages.slice(0, 2).map(({ row }, k) => ({
			stream: 0,
			encoding: ENCODING.plain,
			offset: row.offset,
			rows: row.count,
			body: encodeChunk(classes[k], CLASS, ENCODING.plain)
		}))
	);
	const files = new Map([
		[base + PACK, pack],
		[base + COL, colBytes],
		[base + IDX, idxBytes],
		[base + ATR, atr],
		[IDS, await encodeIds(Uint16Array.from({ length: 21 }, (_, k) => k))]
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
		atr: { path: ATR, size: atr.length },
		offset: row.offset,
		length: row.length
	}));
	const parsed = await parseCol(colBytes);
	const decoded = pages.map(({ payload }) => decodePage(payload, parsed));
	return { fetch, files, calls, jobs, decoded, idxBytes, classes, rows: idx.rows, pack };
}

const kept = (): Kept => ({ cols: new Map(), atrs: new Map() });
const CLASSES: Wanted = { id: 4, name: 'test.class', required: false, attribute: CLASS };

function batch(pages: PageJob[]): Batch {
	return {
		pack: PACK,
		col: COL,
		atr: pages[0].atr,
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
			loadBatch(sources(fetch, memoryCache(2 ** 20)), all, [], kept())
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
		await Array.fromAsync(loadBatch(sources(fetch, cache), batch(jobs), [], kept()));
		const fetched = calls.length;
		const again = await Array.fromAsync(
			loadBatch(sources(fetch, cache), batch(jobs.slice(1, 2)), [], kept())
		);
		expect(again).toEqual([{ id: 2, page: decoded[1] }]);
		expect(calls).toHaveLength(fetched);
	});

	it('fetches the whole range once when only some pages hit', async () => {
		const { fetch, calls, jobs, decoded } = await world();
		const cache = memoryCache(2 ** 20);
		const own = kept();
		await Array.fromAsync(loadBatch(sources(fetch, cache), batch(jobs.slice(0, 1)), [], own));
		calls.length = 0;
		const all = batch(jobs);
		const loaded = await Array.fromAsync(loadBatch(sources(fetch, cache), all, [], own));
		expect(loaded.map(({ page }) => page)).toEqual(decoded);
		expect(calls).toEqual([{ url: base + PACK, range: [all.start, all.end] }]);
	});

	it('fetches and parses a col once per path through cols', async () => {
		const { fetch, calls, jobs } = await world();
		const own = kept();
		await Array.fromAsync(loadBatch(sources(fetch, none), batch(jobs.slice(0, 1)), [], own));
		await Array.fromAsync(loadBatch(sources(fetch, none), batch(jobs.slice(2, 3)), [], own));
		expect(calls.filter((c) => c.url === base + COL)).toHaveLength(1);
		expect([...own.cols.keys()]).toEqual([COL]);
	});

	it('rejects with an AbortError and fetches no pages once aborted', async () => {
		const { fetch, calls, jobs } = await world();
		const loading = Array.fromAsync(
			loadBatch(sources(fetch, none), batch(jobs), [], kept(), AbortSignal.abort())
		);
		const error = await loading.catch((e: unknown) => e);
		expect((error as DOMException).name).toBe('AbortError');
		expect(calls.filter((c) => c.url === base + PACK)).toHaveLength(0);
	});
});

describe('loadBatch with attribute streams', () => {
	const values = (page: { attributes?: { words: Uint32Array }[] }) =>
		page.attributes?.map(({ words }) => Array.from(new Uint16Array(words.buffer)));

	it('gives each page its chunks, from one read of the tables and one of the chunks', async () => {
		const { fetch, calls, jobs, classes } = await world();
		const own = kept();
		const loaded = await Array.fromAsync(
			loadBatch(sources(fetch, none), batch(jobs), [CLASSES], own)
		);
		expect(loaded[0].page.attributes?.map((a) => a.stream)).toEqual([4]);
		expect(values(loaded[0].page)?.[0].slice(0, classes[0].length)).toEqual(classes[0]);
		expect(values(loaded[1].page)?.[0].slice(0, classes[1].length)).toEqual(classes[1]);
		// the last page has no chunk: its rows take the default
		expect(loaded[2].page.attributes).toBeUndefined();
		const atr = calls.filter((c) => c.url === base + ATR);
		expect(atr).toHaveLength(2);
		await Array.fromAsync(loadBatch(sources(fetch, none), batch(jobs.slice(1, 2)), [CLASSES], own));
		expect(calls.filter((c) => c.url === base + ATR)).toHaveLength(3);
	});

	it('serves tables and chunks from the cache the second time', async () => {
		const { fetch, calls, jobs } = await world();
		const cache = memoryCache(2 ** 20);
		await Array.fromAsync(loadBatch(sources(fetch, cache), batch(jobs), [CLASSES], kept()));
		calls.length = 0;
		const again = await Array.fromAsync(
			loadBatch(sources(fetch, cache), batch(jobs), [CLASSES], kept())
		);
		expect(again[0].page.attributes).toHaveLength(1);
		expect(calls).toEqual([]);
	});

	it('loads pages without a stream no hook requires when its .atr fails, and fails with one', async () => {
		const { fetch, files, jobs } = await world();
		files.delete(base + ATR);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const loaded = await Array.fromAsync(
			loadBatch(sources(fetch, none), batch(jobs), [CLASSES], kept())
		);
		expect(loaded.every(({ page }) => page.attributes === undefined)).toBe(true);
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
		const required = { ...CLASSES, required: true };
		await expect(
			Array.fromAsync(loadBatch(sources(fetch, none), batch(jobs), [required], kept()))
		).rejects.toThrow(`no ${base + ATR}`);
	});

	it('fetches nothing of the .atr while no stream is wanted', async () => {
		const { fetch, calls, jobs } = await world();
		await Array.fromAsync(loadBatch(sources(fetch, none), batch(jobs), [], kept()));
		expect(calls.filter((c) => c.url === base + ATR)).toEqual([]);
	});

	it('reads the synthetic world quadrant stream, one chunk a page', async () => {
		const fetch = synthetic();
		const at = 'synthetic/';
		const declared = parseWorld(
			JSON.parse(new TextDecoder().decode(await fetch(`${at}world.json`, null)))
		);
		const key: UnitKey = { level: 0, e: 724000, n: 6176000 };
		// down from the root over it, as many levels as an idx names at once
		let idx = await parseIdx(
			await fetch(
				at + declared.roots.find((r) => key.n >= r.n && key.n < r.n + LEAF * 2 ** r.level)!.idx,
				null
			)
		);
		while (idx.level > 0) {
			const inside = namedUnits(idx).filter(({ key: k }) => {
				const side = LEAF * 2 ** k.level;
				return key.e >= k.e && key.e < k.e + side && key.n >= k.n && key.n < k.n + side;
			});
			const { key: below, hash } = inside.reduce((a, b) => (a.key.level < b.key.level ? a : b));
			idx = await parseIdx(await fetch(at + unitPath(below, hash, 'idx'), null));
		}
		const pack = unitPath(idx, idx.pack, 'pack');
		const atr = { path: unitPath(idx, idx.atr!, 'atr'), size: idx.atrSize };
		const pages = idx.rows
			.slice(0, 2)
			.map((row, k) => ({ id: k, pack, col: null, atr, offset: row.offset, length: row.length }));
		const stream: Wanted = {
			id: 0,
			name: 'synthetic.quadrant',
			required: true,
			attribute: declared.attributes['synthetic.quadrant']
		};
		const loaded = await Array.fromAsync(
			loadBatch(
				{ fetch, cache: none, base: at },
				{
					pack,
					col: null,
					atr,
					start: pages[0].offset,
					end: pages[1].offset + pages[1].length,
					window: 0,
					pages
				},
				[stream],
				kept()
			)
		);
		for (const { page } of loaded) {
			const [{ words }] = page.attributes!;
			const quadrants = new Uint8Array(words.buffer, 0, page.count);
			const want = Array.from({ length: page.count }, (_, t) =>
				t >= page.quadrants[2] ? 3 : t >= page.quadrants[1] ? 2 : t >= page.quadrants[0] ? 1 : 0
			);
			expect(Array.from(quadrants)).toEqual(want);
		}
	});
});

describe('loadIds', () => {
	it('cuts the ids by the rows of the .idx in blob order', async () => {
		const { fetch, rows, pack } = await world();
		const ids = Uint16Array.from({ length: 21 }, (_, k) => k);
		const pages = await loadIds(
			sources(fetch, none),
			IDS,
			{ path: PACK, size: pack.length },
			rows.toReversed()
		);
		expect(Array.from(pages.get(rows[1].offset)!)).toEqual(Array.from(ids.subarray(6, 13)));
	});

	it('cuts them by the pack table, read in one request, when the .idx lists fewer pages', async () => {
		const { fetch, calls, rows, pack } = await world();
		const listed = rows.slice(1);
		const pages = await loadIds(
			sources(fetch, none),
			IDS,
			{ path: PACK, size: pack.length },
			listed
		);
		expect(Array.from(pages.get(rows[2].offset)!)).toEqual([13, 14, 15, 16, 17, 18, 19, 20]);
		const end = rows[2].offset + rows[2].length;
		expect(calls.filter((c) => c.url === base + PACK)).toEqual([
			{ url: base + PACK, range: [end, pack.length] }
		]);
	});

	it('throws when the ids fit neither', async () => {
		const { fetch, files, rows, pack } = await world();
		files.set(IDS, await encodeIds(new Uint16Array(5)));
		await expect(
			loadIds(sources(fetch, none), IDS, { path: PACK, size: pack.length }, rows)
		).rejects.toThrow('it holds 5 ids for 21 splats, or 21 with every level of its pack');
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
