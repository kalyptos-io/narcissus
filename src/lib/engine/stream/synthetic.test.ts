import { describe, expect, it } from 'vitest';
import type { Fetch } from '../ports.ts';
import type { DecodedPage, Idx, PageRow, UnitKey } from '../types.ts';
import { parseIdx, unitPath } from '../format/idx.ts';
import { inflate } from '../format/inflate.ts';
import { decodePage } from '../format/page.ts';
import { LEAF, PACK_TRAILER, PARAMS, ROW_BYTES } from '../format/spec.ts';
import { parseWorld } from '../format/world.ts';
import { synthetic } from './synthetic.ts';

const BASE = 'synthetic/';
const COPENHAGEN = { level: 0, e: 724000, n: 6176000 };

async function world(fetch: Fetch) {
	const json = new TextDecoder().decode(await fetch(BASE + 'world.json', null));
	return parseWorld(JSON.parse(json));
}

async function open(fetch: Fetch, path: string): Promise<Idx> {
	return parseIdx(await fetch(BASE + path, null));
}

/** the idx of the unit at key, walked down from its root three levels at a time */
async function walk(fetch: Fetch, key: UnitKey): Promise<Idx> {
	const { roots } = await world(fetch);
	const root = roots.find((top) => key.n >= top.n && key.n < top.n + LEAF * 2 ** top.level)!;
	let idx = await open(fetch, root.idx);
	while (idx.level > key.level) {
		const level = idx.level - 3;
		const side = LEAF * 2 ** level;
		const c = Math.floor((key.e - idx.e) / side);
		const r = Math.floor((key.n - idx.n) / side);
		const named = idx.descendants.find((d) => d.depth === 3 && d.column === c && d.row === r)!;
		const unit = { level, e: idx.e + c * side, n: idx.n + r * side };
		idx = await open(fetch, unitPath(unit, named.idx, 'idx'));
	}
	return idx;
}

/** rows of idx, adjacent in its pack, fetched as one range and decoded */
async function decode(fetch: Fetch, idx: Idx, rows: PageRow[]): Promise<DecodedPage[]> {
	const start = rows[0].offset;
	const end = rows[rows.length - 1].offset + rows[rows.length - 1].length;
	const bytes = await fetch(BASE + unitPath(idx, idx.pack, 'pack'), [start, end]);
	expect(bytes.length).toBe(end - start);
	const pages: DecodedPage[] = [];
	for (const row of rows) {
		const at = row.offset - start;
		pages.push(decodePage(await inflate(bytes.subarray(at, at + row.length)), null));
	}
	return pages;
}

function tally(values: number[]): Record<number, number> {
	const counts: Record<number, number> = {};
	for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
	return counts;
}

/** every cluster's extent, moved by the page origin, lies inside box */
function inside(page: DecodedPage, box: Float32Array): boolean {
	const origin = page.params.subarray(PARAMS.origin, PARAMS.origin + 3);
	const slack = 1e-6 * (box[3] - box[0]);
	for (let c = 0; c < page.clusters.length; c += 6) {
		for (let a = 0; a < 3; a++) {
			if (origin[a] + page.clusters[c + a] < box[a] - slack) return false;
			if (origin[a] + page.clusters[c + 3 + a] > box[3 + a] + slack) return false;
		}
	}
	return true;
}

describe('synthetic', () => {
	it('serves a version 4 world over Denmark with two level 12 roots', async () => {
		const { roots, extent } = await world(synthetic());
		expect(roots.map(({ level, e, n }) => ({ level, e, n }))).toEqual([
			{ level: 12, e: 0, n: 5120000 },
			{ level: 12, e: 0, n: 6144000 }
		]);
		expect(extent).toEqual({ e: [440000, 900000], n: [6050000, 6410000], h: [0, 80] });
	});

	it('lists the levels, children and descendants of a root that meet the extent', async () => {
		const fetch = synthetic();
		const idx = await open(fetch, (await world(fetch)).roots[1].idx);
		const levels = idx.rows.map((row) => row.g);
		expect(tally(levels)).toEqual({ 13: 15, 14: 6, 15: 2, 16: 1 });
		expect(levels).toEqual([...levels].sort((a, b) => b - a));
		expect(idx.children.map((child) => child.quadrant)).toEqual([0, 1]);
		expect(tally(idx.descendants.map((d) => d.depth))).toEqual({ 2: 6, 3: 15 });
		expect(idx.col).toBeNull();
	});

	it('lists both levels of a leaf, coarsest first, and nothing below it', async () => {
		const idx = await walk(synthetic(), COPENHAGEN);
		expect({ level: idx.level, e: idx.e, n: idx.n }).toEqual(COPENHAGEN);
		expect(tally(idx.rows.map((row) => row.g))).toEqual({ 0: 256, 1: 64 });
		expect(idx.rows[0].g).toBe(1);
		expect(idx.children).toEqual([]);
		expect(idx.descendants).toEqual([]);
	});

	it('packs pages back to back at the offsets and lengths its idx gives', async () => {
		const fetch = synthetic();
		const idx = await walk(fetch, COPENHAGEN);
		const { length } = idx.rows[0];
		idx.rows.forEach((row, r) => expect([row.offset, row.length]).toEqual([r * length, length]));
		expect(idx.packSize).toBe(idx.rows.length * (length + ROW_BYTES) + PACK_TRAILER);
		const rows = idx.rows.slice(64, 66);
		const pages = await decode(fetch, idx, rows);
		pages.forEach((page, k) => {
			expect(page.count).toBe(rows[k].count);
			expect(page.quadrants).toEqual(rows[k].quadrants);
		});
	});

	it('keeps every splat extent inside its row box on a leaf and a root', async () => {
		const fetch = synthetic();
		const leaf = await walk(fetch, COPENHAGEN);
		const root = await open(fetch, (await world(fetch)).roots[1].idx);
		const [fine] = await decode(fetch, leaf, [leaf.rows[100]]);
		const [coarse] = await decode(fetch, root, [root.rows[0]]);
		expect(inside(fine, leaf.rows[100].box)).toBe(true);
		expect(inside(coarse, root.rows[0].box)).toBe(true);
	});

	it('rejects a wrong hash, an unknown unit and a col with http 404', async () => {
		const fetch = synthetic();
		const { idx } = (await world(fetch)).roots[1];
		const missing = /^http 404 /;
		const wrong = idx.replace(/[0-9a-f]{16}/, '0123456789abcdef');
		await expect(fetch(BASE + wrong, null)).rejects.toThrow(missing);
		await expect(fetch(BASE + 'u/0/0/0.0123456789abcdef.idx', null)).rejects.toThrow(missing);
		await expect(fetch(BASE + idx.replace(/idx$/, 'col'), null)).rejects.toThrow(missing);
	});

	it('rejects a pack range that cuts a page', async () => {
		const fetch = synthetic();
		const idx = await walk(fetch, COPENHAGEN);
		const pack = BASE + unitPath(idx, idx.pack, 'pack');
		await expect(fetch(pack, [0, idx.rows[0].length - 1])).rejects.toThrow('whole pages');
		await expect(fetch(pack, null)).rejects.toThrow('whole pages');
	});
});
