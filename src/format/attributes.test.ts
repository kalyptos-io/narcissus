// the golden attribute tree, fixtures/attributes/ (its README.md): guldmund writes it, and this
// test reads it against expected.json, structure and decoded values, whichever writer made it.
// NARCISSUS_FIXTURES=write writes a provisional one from the generator below, through the
// format's own writers

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Attribute, Idx, PageRow, UnitKey } from './types.ts';
import { parseAtr, readRecords, readValues } from './atr.ts';
import {
	deflate,
	encodeAtr,
	encodeChunk,
	encodeIdx,
	encodePack,
	encodePage,
	mulberry32,
	type Splats
} from './encode.ts';
import { contentHash } from './hash.ts';
import { packRows, parseIdx, unitPath } from './idx.ts';
import { inflate } from './inflate.ts';
import { ENCODING, PAGE_SIDE } from './spec.ts';
import { parseWorld } from './world.ts';

const DIR = new URL('../../fixtures/attributes/', import.meta.url);

const ATTRIBUTES: Record<string, Attribute> = {
	'test.class': { type: 'u16', components: 1, default: [0], rule: 'preserved' },
	'test.tone': { type: 'f16', components: 2, default: [0.5, 0.5], rule: 'aggregated' },
	'test.parts': { type: 'records', components: 0, default: [], rule: 'preserved' }
};
const STREAMS = Object.keys(ATTRIBUTES);
/** stream, encoding */
const ENCODINGS: [string, number][] = [
	['test.class', ENCODING.dictionary],
	['test.tone', ENCODING.plain],
	['test.parts', ENCODING.sparse]
];
const CLASSES = [0, 3, 17, 900, 65535];

const W: UnitKey = { level: 0, e: 723000, n: 6177000 };
const E: UnitKey = { level: 0, e: 723250, n: 6177000 };
const M: UnitKey = { level: 1, e: 723000, n: 6177000 };
const R: UnitKey = { level: 2, e: 723000, n: 6177000 };

interface Plan {
	key: UnitKey;
	/** g, i, j of each page; listed: in the .idx */
	pages: { g: number; i: number; j: number; listed: boolean }[];
	/** has an .atr; pages whose blob gets no test.tone chunk, by g/i/j */
	atr: boolean;
	untoned: string[];
}

const PLANS: Plan[] = [
	{
		key: W,
		pages: [
			{ g: 1, i: 1, j: 1, listed: true },
			{ g: 1, i: 6, j: 2, listed: true },
			{ g: 0, i: 3, j: 3, listed: true },
			{ g: 0, i: 10, j: 5, listed: true }
		],
		atr: true,
		untoned: ['1/6/2']
	},
	{
		key: E,
		pages: [
			{ g: 1, i: 1, j: 4, listed: true },
			{ g: 0, i: 2, j: 8, listed: true }
		],
		atr: false,
		untoned: []
	},
	{
		key: M,
		pages: [
			{ g: 3, i: 1, j: 1, listed: false },
			{ g: 2, i: 2, j: 2, listed: true },
			{ g: 2, i: 5, j: 3, listed: true }
		],
		atr: true,
		untoned: []
	},
	{
		key: R,
		pages: [
			{ g: 4, i: 0, j: 0, listed: true },
			{ g: 3, i: 1, j: 1, listed: true },
			{ g: 3, i: 2, j: 0, listed: true }
		],
		atr: true,
		untoned: []
	}
];

interface Expected {
	world: string;
	units: (Omit<Idx, 'rows'> & { path: string; rows: Omit<PageRow, 'box' | 'quadrants'>[] })[];
	atrs: {
		path: string;
		pack: string;
		streams: string[];
		chunks: {
			stream: number;
			encoding: number;
			offset: number;
			rows: number;
			/** contentHash of the inflated body */
			body: string;
			values?: number[];
			records?: number[][];
		}[];
	}[];
}

const morton = ({ i, j }: { i: number; j: number }) => {
	let m = 0;
	for (let b = 0; b < 8; b++) m |= (((i >> b) & 1) << (2 * b)) | (((j >> b) & 1) << (2 * b + 1));
	return m;
};

function splats(next: () => number, { g, i, j }: { g: number; i: number; j: number }): Splats {
	const count = 20 + Math.floor(next() * 41);
	const side = PAGE_SIDE * 2 ** g;
	const rotation = Float32Array.from({ length: 4 * count }, () => next() - 0.5);
	return {
		count,
		position: Float64Array.from({ length: 3 * count }, (_, k) =>
			k % 3 === 2 ? 28 + 4 * next() : ((k % 3 === 0 ? i : j) + next()) * side
		),
		rotation,
		scale: Float32Array.from({ length: 3 * count }, () => -4 + 3 * next()),
		alpha: Float32Array.from({ length: count }, () => 0.05 + 0.9 * next()),
		dc: Float32Array.from({ length: 3 * count }, () => next() - 0.5),
		sh: null
	};
}

/** a page's values of each stream, by row */
function values(next: () => number, rows: number) {
	return {
		'test.class': Array.from({ length: rows }, () => CLASSES[Math.floor(next() * CLASSES.length)]),
		// sixty-fourths are exact in f16
		'test.tone': Array.from({ length: 2 * rows }, () => (Math.floor(next() * 256) - 128) / 64),
		'test.parts': Array.from({ length: rows }, () =>
			next() < 0.3
				? Uint8Array.from({ length: 1 + Math.floor(next() * 9) }, () => Math.floor(next() * 256))
				: new Uint8Array(0)
		)
	};
}

/** every file of the tree by path, and what a reader must find in it */
async function generate(): Promise<{ files: Map<string, Uint8Array>; expected: Expected }> {
	const next = mulberry32(20261103);
	const files = new Map<string, Uint8Array>();
	const expected: Expected = { world: 'world.json', units: [], atrs: [] };
	const idxOf = new Map<string, string>();
	const keyOf = (key: UnitKey) => `${key.level}/${key.e}/${key.n}`;
	for (const plan of PLANS) {
		const { key } = plan;
		const ordered = plan.pages.toSorted((a, b) => b.g - a.g || morton(a) - morton(b));
		// every draw before the first await, so the order of the numbers is fixed
		const drawn = ordered.map((page) => {
			const { payload, row } = encodePage(splats(next, page), page);
			return { page, row, payload, values: values(next, row.count) };
		});
		const pages = await Promise.all(
			drawn.map(async ({ payload, ...page }) => ({ ...page, blob: await deflate(payload) }))
		);
		const pack = encodePack(pages.map(({ row, blob }) => ({ row, blob })));
		const packHash = contentHash(pack);
		files.set(unitPath(key, packHash, 'pack'), pack);

		let atr: string | null = null;
		let atrSize = 0;
		if (plan.atr) {
			const chunks = pages.flatMap(({ page, row, values: v }) =>
				ENCODINGS.filter(
					([name]) =>
						name !== 'test.tone' || !plan.untoned.includes(`${page.g}/${page.i}/${page.j}`)
				).map(([name, encoding]) => ({
					stream: STREAMS.indexOf(name),
					encoding,
					offset: row.offset,
					rows: row.count,
					body: encodeChunk(v[name as keyof typeof v], ATTRIBUTES[name], encoding),
					values: v[name as keyof typeof v]
				}))
			);
			const bytes = await encodeAtr(packHash, STREAMS, chunks);
			atr = contentHash(bytes);
			atrSize = bytes.length;
			const path = unitPath(key, atr, 'atr');
			files.set(path, bytes);
			expected.atrs.push({
				path,
				pack: packHash,
				streams: STREAMS,
				chunks: chunks
					.toSorted((a, b) => a.offset - b.offset || a.stream - b.stream)
					.map(({ stream, encoding, offset, rows, body, values: v }) => ({
						stream,
						encoding,
						offset,
						rows,
						body: contentHash(body),
						...(ATTRIBUTES[STREAMS[stream]].type === 'records'
							? { records: (v as Uint8Array[]).map((r) => Array.from(r)) }
							: { values: Array.from(v as number[]) })
					}))
			});
		}

		const below = PLANS.filter((p) => p.key.level < key.level);
		const inside = (p: Plan) => {
			const side = 250 * 2 ** key.level;
			return (
				p.key.e >= key.e && p.key.e < key.e + side && p.key.n >= key.n && p.key.n < key.n + side
			);
		};
		const idx: Idx = {
			...key,
			pack: packHash,
			packSize: pack.length,
			col: null,
			atr,
			atrSize,
			rows: pages.filter(({ page }) => page.listed).map(({ row }) => row),
			children: below
				.filter((p) => p.key.level === key.level - 1 && inside(p))
				.map((p) => {
					const half = 250 * 2 ** p.key.level;
					const quadrant = (p.key.e - key.e) / half + 2 * ((p.key.n - key.n) / half);
					return { quadrant, idx: idxOf.get(keyOf(p.key))! };
				}),
			descendants: below
				.filter((p) => key.level - p.key.level >= 2 && inside(p))
				.map((p) => {
					const side = 250 * 2 ** p.key.level;
					return {
						depth: key.level - p.key.level,
						column: (p.key.e - key.e) / side,
						row: (p.key.n - key.n) / side,
						idx: idxOf.get(keyOf(p.key))!
					};
				})
		};
		const idxBytes = await encodeIdx(idx);
		const idxHash = contentHash(idxBytes);
		idxOf.set(keyOf(key), idxHash);
		const path = unitPath(key, idxHash, 'idx');
		files.set(path, idxBytes);
		const { rows, ...header } = idx;
		expected.units.push({
			path,
			...header,
			rows: rows.map(({ g, i, j, count, offset, length }) => ({ g, i, j, count, offset, length }))
		});
	}
	const root = expected.units.find((u) => u.level === R.level)!;
	const rootRows = (await parseIdx(files.get(root.path)!)).rows;
	const lo = (a: number) => Math.min(...rootRows.map((r) => r.box[a]));
	const hi = (a: number) => Math.max(...rootRows.map((r) => r.box[3 + a]));
	const cm = (v: number, up: boolean) => (up ? Math.ceil(v * 100) : Math.floor(v * 100)) / 100;
	const world = {
		version: 1,
		crs: 'EPSG:25832',
		height: 'DVR90',
		leaf: 250,
		roots: [{ ...R, idx: root.path }],
		extent: {
			e: [cm(R.e + lo(0), false), cm(R.e + hi(0), true)],
			n: [cm(R.n + lo(1), false), cm(R.n + hi(1), true)],
			h: [cm(lo(2), false), cm(hi(2), true)]
		},
		attributes: {
			'test.class': { type: 'u16', components: 1, default: 0, rule: 'preserved' },
			'test.tone': { type: 'f16', components: 2, default: [0.5, 0.5], rule: 'aggregated' },
			'test.parts': { type: 'records', rule: 'preserved' }
		}
	};
	files.set('world.json', new TextEncoder().encode(JSON.stringify(world, null, '\t') + '\n'));
	return { files, expected };
}

const readme = readFileSync(new URL('README.md', DIR), 'utf8');

const read = (path: string) => new Uint8Array(readFileSync(new URL(path, DIR)));
const load = () => JSON.parse(readFileSync(new URL('expected.json', DIR), 'utf8')) as Expected;
const world = () => parseWorld(JSON.parse(readFileSync(new URL('world.json', DIR), 'utf8')));

describe('golden attribute fixture', () => {
	it.runIf(process.env.NARCISSUS_FIXTURES === 'write')('is written afresh', async () => {
		const { files, expected } = await generate();
		rmSync(DIR, { recursive: true, force: true });
		for (const [path, bytes] of files) {
			const url = new URL(path, DIR);
			mkdirSync(new URL('.', url), { recursive: true });
			writeFileSync(url, bytes);
		}
		writeFileSync(new URL('expected.json', DIR), JSON.stringify(expected, null, '\t') + '\n');
		writeFileSync(new URL('README.md', DIR), readme);
		expect(files.size).toBe(12);
	});

	it('declares the three streams in world.json, and its roots are units it lists', () => {
		const { attributes, roots } = world();
		const shape = Object.fromEntries(
			Object.entries(attributes).map(([name, { type, components }]) => [name, { type, components }])
		);
		expect(shape).toEqual({
			'test.class': { type: 'u16', components: 1 },
			'test.tone': { type: 'f16', components: 2 },
			'test.parts': { type: 'records', components: 0 }
		});
		const paths = new Set(load().units.map((u) => u.path));
		for (const root of roots) expect(paths.has(root.idx), root.idx).toBe(true);
	});

	it('reads every idx as written, version 1 without an .atr', async () => {
		for (const { path, rows, ...header } of load().units) {
			const bytes = read(path);
			expect(contentHash(bytes), path).toBe(path.split('.').at(-2));
			expect(new DataView(bytes.buffer).getUint16(4, true), path).toBe(header.atr ? 2 : 1);
			const idx = await parseIdx(bytes);
			expect(idx).toMatchObject(header);
			expect(
				idx.rows.map(({ g, i, j, count, offset, length }) => ({ g, i, j, count, offset, length }))
			).toEqual(rows);
		}
	});

	it('reads every .atr as written, each chunk on a page of its pack', async () => {
		const units = load().units;
		const declared = world().attributes;
		for (const atr of load().atrs) {
			const bytes = read(atr.path);
			expect(contentHash(bytes), atr.path).toBe(atr.path.split('.').at(-2));
			const unit = units.find((u) => u.atr === atr.path.split('.').at(-2))!;
			expect(bytes.length).toBe(unit.atrSize);
			const parsed = parseAtr(bytes, bytes.length);
			expect(parsed.pack).toBe(unit.pack);
			expect(parsed.streams).toEqual(atr.streams);
			const pack = read(unitPath(unit, unit.pack, 'pack'));
			const table = await packRows(async (s, e) => pack.subarray(s, e), pack.length);
			expect(parsed.chunks).toHaveLength(atr.chunks.length);
			for (const [c, chunk] of parsed.chunks.entries()) {
				const want = atr.chunks[c];
				expect(chunk).toMatchObject({
					stream: want.stream,
					encoding: want.encoding,
					offset: want.offset,
					rows: want.rows
				});
				expect(table.find((row) => row.offset === chunk.offset)?.count).toBe(chunk.rows);
				const body = await inflate(bytes.subarray(chunk.at, chunk.at + chunk.length));
				expect(contentHash(body)).toBe(want.body);
				const a = declared[parsed.streams[chunk.stream]];
				if (want.records) {
					expect(readRecords(body, chunk, a).map((r) => Array.from(r))).toEqual(want.records);
				} else {
					expect(Array.from(readValues(body, chunk, a))).toEqual(want.values);
				}
			}
		}
	});

	it('holds a unit without an .atr, a chunk of a page its idx does not list, and a page without a chunk', () => {
		const { units, atrs } = load();
		expect(units.some((u) => u.atr === null)).toBe(true);
		const unlisted = atrs.some((atr) => {
			const unit = units.find((u) => u.pack === atr.pack)!;
			const listed = new Set(unit.rows.map((r) => r.offset));
			return atr.chunks.some((c) => !listed.has(c.offset));
		});
		expect(unlisted).toBe(true);
		const lacking = atrs.some((atr) => {
			const unit = units.find((u) => u.pack === atr.pack)!;
			return atr.streams.some((_, s) =>
				unit.rows.some((r) => !atr.chunks.some((c) => c.stream === s && c.offset === r.offset))
			);
		});
		expect(lacking).toBe(true);
	});
});
