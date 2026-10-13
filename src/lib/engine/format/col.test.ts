import { describe, expect, it } from 'vitest';
import type { Col } from '../types.ts';
import { parseCol, sampleCol } from './col.ts';
import { encodeCol } from './encode.ts';
import { deflate } from './inflate.ts';

function grid(n: number, f: (c: number, i: number, j: number) => number): Col {
	const values = new Float32Array(12 * n * n);
	for (let c = 0; c < 12; c++) {
		for (let j = 0; j < n; j++) {
			for (let i = 0; i < n; i++) values[(c * n + j) * n + i] = f(c, i, j);
		}
	}
	return { n, pitch: 50, margin: 25, values };
}

describe('parseCol', () => {
	it('reads back what encodeCol wrote within half an i8 step', async () => {
		// channel 0 swings between the extremes, so its deltas wrap
		const swing = (i: number) => (i % 2 ? 0.5 : -0.5);
		const col = grid(7, (c, i, j) => (c === 0 ? swing(i) : Math.sin(c * 31 + i * 7 + j)));
		const read = await parseCol(await encodeCol(col));
		expect([read.n, read.pitch, read.margin]).toEqual([7, 50, 25]);
		let worst = 0;
		for (let c = 0; c < 12; c++) {
			const channel = col.values.subarray(c * 49, (c + 1) * 49);
			const scale = Math.max(...channel.map(Math.abs));
			for (let k = 0; k < 49; k++) {
				const error = Math.abs(read.values[c * 49 + k] - channel[k]);
				worst = Math.max(worst, error / (scale / 254 + 1e-7));
			}
		}
		expect(worst).toBeLessThanOrEqual(1);
		expect(read.values[0]).toBeCloseTo(-0.5, 6);
		expect(read.values[1]).toBeCloseTo(0.5, 6);
	});

	it('rejects a body cut short of its nodes', async () => {
		const body = new Uint8Array(60 + 12 * 9);
		new DataView(body.buffer).setUint16(0, 4, true);
		const z = await deflate(body);
		const file = new Uint8Array(8 + z.length);
		file.set([71, 77, 67, 76, 1, 0, 0, 0]);
		file.set(z, 8);
		await expect(parseCol(file)).rejects.toThrow('.col holds 168 bytes, 4 nodes need 252');
	});
});

describe('sampleCol', () => {
	// linear in i and j, so bilinear sampling reproduces it exactly between nodes
	const n = 6;
	const col = grid(n, (c, i, j) => c * 100 + j * n + i);
	const out = new Float32Array(12);

	it('returns node values at node centres', () => {
		sampleCol(col, -25 + 2.5 * 50, -25 + 3.5 * 50, out);
		expect(out[0]).toBeCloseTo(3 * n + 2, 4);
		expect(out[11]).toBeCloseTo(1100 + 3 * n + 2, 4);
	});

	it('interpolates between node centres', () => {
		sampleCol(col, 50 * 1.25, 50 * 0.6, out);
		expect(out[5]).toBeCloseTo(500 + 0.6 * n + 1.25, 4);
	});

	it('clamps to the outer nodes', () => {
		sampleCol(col, -40, 400, out);
		expect(out[1]).toBeCloseTo(100 + (n - 1) * n, 4);
		sampleCol(col, 1000, -1000, out);
		expect(out[1]).toBeCloseTo(100 + n - 1, 4);
	});
});
