import { describe, expect, it } from 'vitest';
import { Missing, type Fetch } from '../../ports.ts';
import {
	parseIdx,
	unitPath,
	inflate,
	decodePage,
	linkRow,
	linkStart,
	linkUnit,
	readSplat,
	LEAF,
	PACK_TRAILER,
	PAGE_SIDE,
	PARAMS,
	ROW_BYTES,
	TOP_PAGE,
	parseWorld,
	type DecodedPage,
	type Idx,
	type PageRow,
	type UnitKey
} from '../../format/index.ts';
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

/** the unit a link of a node in unit idx names: idx itself or its child */
async function target(fetch: Fetch, idx: Idx, link: number): Promise<Idx> {
	const unit = linkUnit(link);
	if (!unit) return idx;
	const q = unit - 1;
	const half = LEAF * 2 ** (idx.level - 1);
	const key = { level: idx.level - 1, e: idx.e + (q & 1) * half, n: idx.n + (q >> 1) * half };
	const named = idx.children.find((child) => child.quadrant === q)!;
	return open(fetch, unitPath(key, named.idx, 'idx'));
}

describe('synthetic', () => {
	it('serves a world with two level 12 roots over its whole extent', async () => {
		const { roots, extent } = await world(synthetic());
		expect(roots.map(({ level, e, n }) => ({ level, e, n }))).toEqual([
			{ level: 12, e: 0, n: 5120000 },
			{ level: 12, e: 0, n: 6144000 }
		]);
		expect(extent).toEqual({ e: [0, 1024000], n: [5120000, 7168000], h: [0, 80] });
	});

	it("lists a root's bands fine to coarse, its top page last, and all its children", async () => {
		const fetch = synthetic();
		const idx = await open(fetch, (await world(fetch)).roots[1].idx);
		const bands = idx.rows.map((row) => row.g);
		expect(tally(bands)).toEqual({ 13: 64, 14: 16, 15: 4, 16: 1 });
		expect(bands).toEqual([...bands].sort((a, b) => a - b));
		expect(idx.rows.map((row) => row.flags).indexOf(TOP_PAGE)).toBe(idx.rows.length - 1);
		expect(idx.children.map((child) => child.quadrant)).toEqual([0, 1, 2, 3]);
		expect(tally(idx.descendants.map((d) => d.depth))).toEqual({ 2: 16, 3: 64 });
		expect(idx.col).toBeNull();
	});

	it('lists both bands of a leaf, fine first, and nothing below it', async () => {
		const idx = await walk(synthetic(), COPENHAGEN);
		expect({ level: idx.level, e: idx.e, n: idx.n }).toEqual(COPENHAGEN);
		expect(tally(idx.rows.map((row) => row.g))).toEqual({ 0: 256, 1: 64 });
		expect(idx.rows[0].g).toBe(0);
		expect(idx.children).toEqual([]);
		expect(idx.descendants).toEqual([]);
	});

	it('packs pages back to back at the offsets and lengths its idx gives', async () => {
		const fetch = synthetic();
		const idx = await walk(fetch, COPENHAGEN);
		let end = 0;
		for (const row of idx.rows) {
			expect(row.offset).toBe(end);
			end += row.length;
		}
		expect(idx.packSize).toBe(end + idx.rows.length * ROW_BYTES + PACK_TRAILER);
		const rows = [idx.rows[255], idx.rows[256]];
		const [fit, parents] = await decode(fetch, idx, rows);
		expect([fit.count, parents.count]).toEqual([rows[0].count, rows[1].count]);
		expect(fit.nodes.links.length).toBe(0);
		expect(parents.nodes.links.length).toBe(parents.count);
		expect(new Set(parents.nodes.counts)).toEqual(new Set([4]));
	});

	it('flat-tops some parents and no fit splat', async () => {
		const fetch = synthetic();
		const idx = await walk(fetch, COPENHAGEN);
		const [fit] = await decode(fetch, idx, [idx.rows[0]]);
		const [parents] = await decode(fetch, idx, [idx.rows[300]]);
		const opacities = (page: DecodedPage) =>
			Array.from({ length: page.count }, (_, t) => readSplat(page, t).opacity);
		expect(Math.max(...opacities(fit))).toBeLessThanOrEqual(1);
		const flat = opacities(parents).filter((a) => a > 1).length / parents.count;
		expect(flat).toBeGreaterThan(0.05);
		expect(flat).toBeLessThan(0.15);
	});

	it('links every family under its parent, on a leaf, across units and in a root', async () => {
		const fetch = synthetic();
		const leaf = await walk(fetch, COPENHAGEN);
		const mid = await walk(fetch, { level: 1, e: 724000, n: 6176000 });
		const root = await open(fetch, (await world(fetch)).roots[1].idx);
		for (const [idx, row] of [
			[leaf, leaf.rows[260]],
			[mid, mid.rows[9]],
			[root, root.rows[0]],
			[root, root.rows[root.rows.length - 1]]
		] as const) {
			const [page] = await decode(fetch, idx, [row]);
			for (const t of [0, 1, 4093, page.count - 1]) {
				const { links, counts } = page.nodes;
				const there = await target(fetch, idx, links[t]);
				const [family] = await decode(fetch, there, [there.rows[linkRow(links[t])]]);
				const parent = readSplat(page, t).position;
				const cell = (PAGE_SIDE * 2 ** row.g) / 128;
				for (let k = 0; k < counts[t]; k++) {
					const child = readSplat(family, linkStart(links[t]) + k).position;
					const d = Math.hypot(
						idx.e + parent[0] - there.e - child[0],
						idx.n + parent[1] - there.n - child[1]
					);
					expect(d).toBeLessThan(1.5 * cell);
				}
			}
		}
	});

	it('keeps every node extent inside its row box on a leaf and a root', async () => {
		const fetch = synthetic();
		const leaf = await walk(fetch, COPENHAGEN);
		const root = await open(fetch, (await world(fetch)).roots[1].idx);
		const [fine] = await decode(fetch, leaf, [leaf.rows[100]]);
		const [coarse] = await decode(fetch, root, [root.rows[0]]);
		expect(inside(fine, leaf.rows[100].box)).toBe(true);
		expect(inside(coarse, root.rows[0].box)).toBe(true);
	});

	it('rejects a wrong hash, an unknown unit and a col with Missing', async () => {
		const fetch = synthetic();
		const { idx } = (await world(fetch)).roots[1];
		const wrong = idx.replace(/[0-9a-f]{16}/, '0123456789abcdef');
		await expect(fetch(BASE + wrong, null)).rejects.toBeInstanceOf(Missing);
		await expect(fetch(BASE + 'u/0/0/0.0123456789abcdef.idx', null)).rejects.toBeInstanceOf(
			Missing
		);
		await expect(fetch(BASE + idx.replace(/idx$/, 'col'), null)).rejects.toBeInstanceOf(Missing);
	});

	it('rejects a pack range that cuts a page', async () => {
		const fetch = synthetic();
		const idx = await walk(fetch, COPENHAGEN);
		const pack = BASE + unitPath(idx, idx.pack, 'pack');
		await expect(fetch(pack, [0, idx.rows[0].length - 1])).rejects.toThrow('whole pages');
		await expect(fetch(pack, null)).rejects.toThrow('whole pages');
	});
});
