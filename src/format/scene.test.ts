// the examples' world, fixtures/scene/ (its README.md): one unit of blocks on a field, with a
// confidence and an object stream that follow from each splat's centre, so a reader checks them
// against the pages. NARCISSUS_FIXTURES=write writes it through the format's own writers

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Attribute, PageRow, UnitKey } from './types.ts';
import { parseAtr, readValues } from './atr.ts';
import { deflate, encodeAtr, encodeChunk, encodeIdx, encodePack, encodePage } from './encode.ts';
import { contentHash } from './hash.ts';
import { packRows, parseIdx, unitPath } from './idx.ts';
import { inflate } from './inflate.ts';
import { decodePage, readSplat } from './page.ts';
import { C0, ENCODING, PAGE_SIDE } from './spec.ts';
import { parseWorld } from './world.ts';

const DIR = new URL('../../fixtures/scene/', import.meta.url);

const UNIT: UnitKey = { level: 0, e: 723000, n: 6177000 };
/** pages of level G, PAGES by PAGES from the unit's corner */
const G = 1;
const PAGES = 2;
/** metres across a block; four splats top each */
const LOT = 1.25;
const LOTS = Math.round((PAGES * PAGE_SIDE * 2 ** G) / LOT);
/** object ids run up to 2^20 */
const OBJECTS = 2 ** 20;
/** where the scanner stood, unit-local metres, and the range its confidence falls to 0 at */
const SCANNER = [8, 8, 2];
const RANGE = 90;

const ATTRIBUTES: Record<string, Attribute> = {
	'example.confidence': { type: 'f16', components: 1, default: [0], rule: 'aggregated' },
	'example.object': { type: 'u32', components: 1, default: [0], rule: 'preserved' }
};
const STREAMS = Object.keys(ATTRIBUTES);

/** a lot's integer hash, the same for its splats */
const hash = (i: number, j: number) => Math.imul(i * 73856093 + j * 19349663, 2654435761) >>> 0;
const lotOf = (x: number, y: number) => [Math.floor(x / LOT), Math.floor(y / LOT)];

/** each stream's value at a unit-local centre */
const VALUES: Record<string, (p: readonly number[]) => number> = {
	'example.confidence': ([x, y, z]) => {
		const [i, j] = lotOf(x, y);
		const reach = 1 - Math.hypot(x - SCANNER[0], y - SCANNER[1], z - SCANNER[2]) / RANGE;
		// sixty-fourths are exact in f16
		return (
			Math.round(64 * Math.max(0, reach) * (0.85 + 0.15 * ((hash(i, j) >>> 8) / 2 ** 24))) / 64
		);
	},
	'example.object': ([x, y]) => {
		const [i, j] = lotOf(x, y);
		return hash(i, j) % OBJECTS;
	}
};

/** the top of lot (i, j): rolling ground, each block raised by its hash */
function height(i: number, j: number): number {
	const x = (i + 0.5) * LOT;
	const y = (j + 0.5) * LOT;
	const ground = 1.5 + Math.sin(x / 9) * Math.sin(y / 13) + 0.4 * Math.sin((x + y) / 5);
	return ground + 0.8 * ((hash(i, j) & 0xff) / 255);
}

/** page (i, j)'s splats: four flat ones atop each lot, turned at random about up */
function splats(pi: number, pj: number) {
	const side = PAGE_SIDE * 2 ** G;
	const per = side / LOT;
	const n = per * per * 4;
	const position = new Float64Array(n * 3);
	const rotation = new Float32Array(n * 4);
	const scale = new Float32Array(n * 3);
	const dc = new Float32Array(n * 3);
	let t = 0;
	for (let a = 0; a < per; a++)
		for (let b = 0; b < per; b++) {
			const [i, j] = [pi * per + a, pj * per + b];
			const z = height(i, j);
			const tone = 0.35 + 0.25 * (z / 3.5);
			for (let k = 0; k < 4; k++, t++) {
				const x = (i + 0.25 + 0.5 * (k & 1)) * LOT;
				const y = (j + 0.25 + 0.5 * (k >> 1)) * LOT;
				position.set([x, y, z], t * 3);
				const turn = Math.PI * ((hash(i * 4 + k, j) & 0xffff) / 0xffff);
				rotation.set([Math.cos(turn), 0, 0, Math.sin(turn)], t * 4);
				scale.set([Math.log(0.22), Math.log(0.14), Math.log(0.01)], t * 3);
				dc.set(
					[tone, tone + 0.05, tone - 0.03].map((c) => (c - 0.5) / C0),
					t * 3
				);
			}
		}
	return {
		count: n,
		position,
		rotation,
		scale,
		alpha: new Float32Array(n).fill(0.95),
		dc,
		sh: null
	};
}

/** every file of the world by path */
async function generate(): Promise<Map<string, Uint8Array>> {
	const files = new Map<string, Uint8Array>();
	const pages: { row: PageRow; centres: number[][]; blob: Uint8Array }[] = [];
	for (let pj = 0; pj < PAGES; pj++)
		for (let pi = 0; pi < PAGES; pi++) {
			const { payload, row } = encodePage(splats(pi, pj), { g: G, i: pi, j: pj });
			const page = decodePage(payload, null);
			const centres = Array.from({ length: row.count }, (_, t) => readSplat(page, t).position);
			pages.push({ row, centres, blob: await deflate(payload) });
		}
	// blobs in morton order of (i, j), as format.md lays out a pack: for 2 by 2, j then i
	pages.sort((a, b) => a.row.j - b.row.j || a.row.i - b.row.i);
	const pack = encodePack(pages.map(({ row, blob }) => ({ row, blob })));
	const packHash = contentHash(pack);
	files.set(unitPath(UNIT, packHash, 'pack'), pack);
	const chunks = pages.flatMap(({ row, centres }) =>
		STREAMS.map((name, stream) => ({
			stream,
			encoding: ENCODING.plain,
			offset: row.offset,
			rows: row.count,
			body: encodeChunk(centres.map(VALUES[name]), ATTRIBUTES[name], ENCODING.plain)
		}))
	);
	const atr = await encodeAtr(packHash, STREAMS, chunks);
	const atrHash = contentHash(atr);
	files.set(unitPath(UNIT, atrHash, 'atr'), atr);
	const idx = await encodeIdx({
		...UNIT,
		pack: packHash,
		packSize: pack.length,
		col: null,
		atr: atrHash,
		atrSize: atr.length,
		rows: pages.map(({ row }) => row),
		children: [],
		descendants: []
	});
	const idxPath = unitPath(UNIT, contentHash(idx), 'idx');
	files.set(idxPath, idx);
	const box = (a: number, up: boolean) =>
		(up ? Math.max : Math.min)(...pages.map(({ row }) => row.box[a + (up ? 3 : 0)]));
	const cm = (v: number, up: boolean) => (up ? Math.ceil(v * 100) : Math.floor(v * 100)) / 100;
	const world = {
		version: 1,
		crs: 'EPSG:25832',
		height: 'DVR90',
		leaf: 250,
		roots: [{ ...UNIT, idx: idxPath }],
		extent: {
			e: [cm(UNIT.e + box(0, false), false), cm(UNIT.e + box(0, true), true)],
			n: [cm(UNIT.n + box(1, false), false), cm(UNIT.n + box(1, true), true)],
			h: [cm(box(2, false), false), cm(box(2, true), true)]
		},
		attributes: Object.fromEntries(
			Object.entries(ATTRIBUTES).map(([name, { type, components, default: d, rule }]) => [
				name,
				{ type, components, default: d[0], rule }
			])
		)
	};
	files.set('world.json', new TextEncoder().encode(JSON.stringify(world, null, '\t') + '\n'));
	return files;
}

const read = (path: string) => new Uint8Array(readFileSync(new URL(path, DIR)));

describe('example scene', () => {
	it.runIf(process.env.NARCISSUS_FIXTURES === 'write')('is written afresh', async () => {
		const readme = readFileSync(new URL('README.md', DIR), 'utf8');
		const files = await generate();
		rmSync(DIR, { recursive: true, force: true });
		for (const [path, bytes] of files) {
			const url = new URL(path, DIR);
			mkdirSync(new URL('.', url), { recursive: true });
			writeFileSync(url, bytes);
		}
		writeFileSync(new URL('README.md', DIR), readme);
		expect(files.size).toBe(4);
	});

	it("holds each stream's value for every row of every page, as its centre gives it", async () => {
		const world = parseWorld(JSON.parse(new TextDecoder().decode(read('world.json'))));
		expect(Object.keys(world.attributes)).toEqual(STREAMS);
		const idx = await parseIdx(read(world.roots[0].idx));
		const pack = read(unitPath(UNIT, idx.pack, 'pack'));
		const atr = read(unitPath(UNIT, idx.atr!, 'atr'));
		const parsed = parseAtr(atr, atr.length);
		expect(parsed.streams).toEqual(STREAMS);
		const rows = await packRows(async (s, e) => pack.subarray(s, e), pack.length);
		expect(parsed.chunks).toHaveLength(rows.length * STREAMS.length);
		let objects = new Set<number>();
		for (const row of rows) {
			const page = decodePage(
				await inflate(pack.subarray(row.offset, row.offset + row.length)),
				null
			);
			for (const chunk of parsed.chunks.filter((c) => c.offset === row.offset)) {
				const name = parsed.streams[chunk.stream];
				const body = await inflate(atr.subarray(chunk.at, chunk.at + chunk.length));
				const values = readValues(body, chunk, world.attributes[name]);
				const want = Array.from({ length: row.count }, (_, t) =>
					VALUES[name](readSplat(page, t).position)
				);
				expect(Array.from(values), name).toEqual(want);
				if (name === 'example.object') objects = objects.union(new Set(want));
			}
		}
		expect(objects.size).toBeGreaterThan(LOTS * LOTS * 0.99);
		expect(Math.max(...objects)).toBeGreaterThan(OBJECTS * 0.99);
	});
});
