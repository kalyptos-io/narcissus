import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disk } from '../adapters/disk.ts';
import { C0, type SplatValues } from '../format/index.ts';
import { exportPly, plySplat } from './ply.ts';
import { build, write } from './test-world.ts';

const FLOATS = 23;
const dir = mkdtempSync(join(tmpdir(), 'narcissus-'));
const WORLD = `${dir}/world.json`;
const units = build();
beforeAll(() => write(dir, units));
afterAll(() => rmSync(dir, { recursive: true }));

async function ply(options?: Parameters<typeof exportPly>[2]) {
	const parts: Uint8Array[] = [];
	for await (const part of exportPly(disk, WORLD, options)) parts.push(part);
	const [head, ...pages] = parts;
	const header = new TextDecoder().decode(head);
	const body = new Float32Array(
		pages.flatMap((page) => [...new Float32Array(page.slice().buffer)])
	);
	return { header, body };
}

const fits = units
	.flatMap((unit) => unit.pages.flatMap((page) => page.nodes))
	.filter((node) => !node.children);

describe('exportPly', () => {
	it('writes every fit splat at detail 0, 23 floats each, under a header with their count', async () => {
		const { header, body } = await ply();
		expect(fits).toHaveLength(96);
		expect(header).toContain(`element vertex ${fits.length}\n`);
		expect(header.endsWith('end_header\n')).toBe(true);
		expect(header.match(/^property float /gm)).toHaveLength(FLOATS);
		expect(body.length).toBe(fits.length * FLOATS);
		expect(body.every(Number.isFinite)).toBe(true);
	});

	it('writes fewer, coarser nodes at a coarser detail, down to the top page', async () => {
		const counts = [];
		for (const detail of [0, 1, 4, 1000]) {
			const { header } = await ply({ detail });
			counts.push(Number(/^element vertex (\d+)$/m.exec(header)![1]));
		}
		expect(counts[0]).toBe(96);
		expect(counts.at(-1)).toBe(2);
		expect(counts).toEqual([...counts].sort((a, b) => b - a));
	});

	it('warns once when it writes nodes past opacity 1', async () => {
		const told: string[] = [];
		await ply({ detail: 1000, warn: (message) => told.push(message) });
		const flat = units[0].pages[2].nodes.filter((node) => node.opacity > 1).length;
		expect(told).toEqual(
			flat ? [`${flat} nodes past opacity 1 written at opacity 1: a ply holds no flat tops`] : []
		);
		const quiet: string[] = [];
		await ply({ warn: (message) => quiet.push(message) });
		expect(quiet).toEqual([]);
	});

	it('puts positions in the square of the root unit once its origin is added', async () => {
		const [root] = units;
		const { header, body } = await ply();
		const [e, n] = /^comment origin (\S+) (\S+):/m.exec(header)!.slice(1).map(Number);
		for (let t = 0; t < body.length; t += FLOATS) {
			expect(body[t] + e).toBeGreaterThan(root.e);
			expect(body[t] + e).toBeLessThan(root.e + 500);
			expect(body[t + 2] + n).toBeGreaterThan(root.n);
			expect(body[t + 2] + n).toBeLessThan(root.n + 500);
		}
	});

	it('writes only the pages that touch a box', async () => {
		const all = await ply();
		const west = await ply({ box: [723000, 6177000, 723100, 6177250] });
		expect(west.body.length).toBeGreaterThan(0);
		expect(west.body.length).toBeLessThan(all.body.length);
		expect(await ply({ box: [0, 0, 1, 1] })).toMatchObject({ body: new Float32Array(0) });
	});
});

describe('plySplat', () => {
	it('turns a splat a quarter about east, as docs/format.md maps such a ply back', () => {
		const splat: SplatValues = {
			position: [12, 34, 5],
			rotation: [0.5, -0.1, 0.7, Math.sqrt(1 - 0.25 - 0.01 - 0.49)],
			scale: [0.2, 0.3, 0.05],
			opacity: 0.75,
			colour: [0.2, 0.5, 0.9],
			sh: [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09]
		};
		const p = new Float32Array(FLOATS);
		plySplat(splat, [10, 30], p);
		// back to east, north, up: p = (x, z, -y), q = (√½, -√½, 0, 0) ⊗ q, sh[c] = (-f[3c+1], f[3c], f[3c+2])
		const h = Math.SQRT1_2;
		const [w, x, y, z] = p.subarray(19, 23);
		const near = (got: number[], want: number[]) => {
			got.forEach((value, k) => expect(value).toBeCloseTo(want[k], 5));
		};
		near([p[0] + 10, p[2] + 30, -p[1]], splat.position);
		near([h * (w + x), h * (x - w), h * (y + z), h * (z - y)], splat.rotation);
		near(
			[0, 1, 2].flatMap((c) => [-p[7 + 3 * c], p[6 + 3 * c], p[8 + 3 * c]]),
			splat.sh
		);
		near(
			[...p.subarray(3, 6)].map((f) => 0.5 + C0 * f),
			splat.colour
		);
		near([...p.subarray(16, 19)].map(Math.exp), splat.scale);
		expect(1 / (1 + Math.exp(-p[15]))).toBeCloseTo(splat.opacity, 5);
	});

	it('keeps the opacity of a solid, an empty and a flat-topped splat finite', () => {
		const p = new Float32Array(FLOATS);
		const splat = {
			position: [0, 0, 0],
			rotation: [1, 0, 0, 0],
			scale: [1, 1, 1],
			colour: [0, 0, 0]
		};
		for (const opacity of [0, 1, 40]) {
			plySplat({ ...splat, opacity, sh: Array(9).fill(0) } as SplatValues, [0, 0], p);
			expect(Number.isFinite(p[15])).toBe(true);
		}
	});
});
