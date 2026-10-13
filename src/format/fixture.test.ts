import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCol, sampleCol } from './col.ts';
import { parseIdx, parseUnitPath } from './idx.ts';
import { inflate } from './inflate.ts';
import { decodePage, pageHeader, readSplat } from './page.ts';
import { C0, PARAMS } from './spec.ts';
import { parseWorld } from './world.ts';

interface Row {
	g: number;
	i: number;
	j: number;
	count: number;
	quadrants: number[];
	box: number[];
	offset: number;
	length: number;
}

interface Expected {
	world: string;
	units: {
		path: string;
		level: number;
		e: number;
		n: number;
		pack: string;
		packSize: number;
		col: string | null;
		rows: Row[];
		children: { quadrant: number; idx: string }[];
		descendants: { depth: number; column: number; row: number; idx: string }[];
	}[];
	cols: {
		path: string;
		n: number;
		pitch: number;
		margin: number;
		samples: { x: number; y: number; values: number[] }[];
	}[];
	pages: {
		pack: string;
		col: string | null;
		row: Row;
		splats: {
			t: number;
			position: number[];
			rotation: number[];
			scale: number[];
			alpha: number;
			colour: number[];
			sh: number[];
		}[];
	}[];
}

const DIR = new URL('../../fixtures/tree/', import.meta.url);
const EXPECTED = new URL('expected.json', DIR);

const read = (path: string) => new Uint8Array(readFileSync(new URL(path, DIR)));
const load = () => JSON.parse(readFileSync(EXPECTED, 'utf8')) as Expected;

function close(
	what: string,
	got: ArrayLike<number>,
	want: number[],
	tolerance: (k: number) => number
): void {
	expect(got.length, what).toBe(want.length);
	for (let k = 0; k < want.length; k++) {
		expect(Math.abs(got[k] - want[k]), `${what} ${k}`).toBeLessThanOrEqual(tolerance(k));
	}
}

// guldmund writes the fixture; it is copied here by hand, so it may be absent
describe.skipIf(!existsSync(EXPECTED))('golden fixture', () => {
	it('parses its world.json and reaches the root units', () => {
		const { world, units } = load();
		const worldUrl = new URL(world, DIR);
		const parsed = parseWorld(JSON.parse(readFileSync(worldUrl, 'utf8')));
		const paths = new Set(units.map((u) => new URL(u.path, DIR).href));
		for (const root of parsed.roots) {
			expect(paths.has(new URL(root.idx, worldUrl).href), root.idx).toBe(true);
		}
	});

	it('reads every idx as guldmund wrote it', async () => {
		for (const unit of load().units) {
			const { path, rows, ...header } = unit;
			expect(parseUnitPath(path)).toMatchObject({ level: unit.level, e: unit.e, n: unit.n });
			const idx = await parseIdx(read(path));
			expect(idx).toMatchObject(header);
			expect(idx.rows.length).toBe(rows.length);
			idx.rows.forEach((row, r) => {
				const { box, ...rest } = rows[r];
				expect(row).toMatchObject(rest);
				close(`${path} row ${r} box`, row.box, box, (k) => 1e-6 * Math.max(1, Math.abs(box[k])));
			});
		}
	});

	it('samples every col as guldmund does', async () => {
		const out = new Float32Array(12);
		for (const c of load().cols) {
			const col = await parseCol(read(c.path));
			expect(col.n).toBe(c.n);
			expect(col.pitch).toBeCloseTo(c.pitch, 5);
			expect(col.margin).toBeCloseTo(c.margin, 5);
			for (const s of c.samples) {
				close(`${c.path} at ${s.x} ${s.y}`, sampleCol(col, s.x, s.y, out), s.values, () => 1e-5);
			}
		}
	});

	it('decodes every listed splat as guldmund does', async () => {
		for (const entry of load().pages) {
			const { offset, length } = entry.row;
			const payload = await inflate(read(entry.pack).subarray(offset, offset + length));
			expect(pageHeader(payload)).toEqual({
				count: entry.row.count,
				quadrants: entry.row.quadrants
			});
			const page = decodePage(payload, entry.col ? await parseCol(read(entry.col)) : null);
			const p = page.params;
			const dcStep = (c: number) => (C0 * (p[PARAMS.dcMax + c] - p[PARAMS.dcMin + c])) / 255;
			const shStep = (m: number) => p[PARAMS.shScale + m] / 127;
			for (const s of entry.splats) {
				const v = readSplat(page, s.t);
				const at = `${entry.pack} ${offset} splat ${s.t}`;
				close(`${at} position`, v.position, s.position, () => 1e-4);
				close(`${at} rotation`, v.rotation, s.rotation, () => 1e-5);
				close(`${at} scale`, v.scale, s.scale, (k) => 1e-5 * s.scale[k]);
				close(`${at} alpha`, [v.alpha], [s.alpha], () => 1e-6);
				close(`${at} colour`, v.colour, s.colour, (c) => dcStep(c) + 1e-6);
				close(`${at} sh`, v.sh, s.sh, (m) => shStep(m) + 1e-6);
			}
		}
	});
});
