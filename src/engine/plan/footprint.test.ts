import { describe, expect, it } from 'vitest';
import { centreWeight, footprint } from './footprint.ts';

const identity = () => Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
const box = (x = 0, z = -10) => [x - 1, -1, z - 1, x + 1, 1, z + 1];

describe('centreWeight', () => {
	it('asks sixteen times the density at the centre and none extra at the edge', () => {
		expect(centreWeight(0, 0, 0, 0)).toBe(16);
		expect(centreWeight(1, 1, 1, 1)).toBe(1);
		expect(centreWeight(-1, 1, -1, 1)).toBeCloseTo(1 + 15 / 9);
	});
});

describe('footprint', () => {
	it('uses perspective, viewport size and partial visibility without changing density', () => {
		const m = identity();
		const projected = (b: number[], width = 1000, height = 1000) =>
			footprint(b, m, width, height, 1, 0.1, 1000);
		expect(projected(box()).pixels).toBeGreaterThan(projected(box(0, -20)).pixels);
		expect(projected(box(), 500, 500).pixels).toBeCloseTo(projected(box()).pixels / 4);
		expect(projected(box(20)).pixels).toBe(0);
		expect(projected(box(0, 20)).pixels).toBe(0);
		expect(projected(box(9)).pixels).toBeGreaterThanOrEqual(projected(box()).pixels);
		expect(projected(box(9)).weight).toBeLessThan(projected(box()).weight);
		expect(projected(box(-9)).weight).toBeCloseTo(projected(box(9)).weight);
	});

	it('covers at least the screen when a region surrounds the camera', () => {
		const m = identity();
		expect(footprint(box(0, -1), m, 1000, 1000, 1, 0.1, 1000).pixels).toBeGreaterThan(1_000_000);
		expect(footprint(box(12), m, 1000, 1000, 1, 0.1, 1000).pixels).toBe(0);
	});

	it('keeps a box just past the screen edge inside a wider margin', () => {
		const m = identity();
		expect(footprint(box(12.5), m, 1000, 1000, 1, 0.1, 1000).pixels).toBe(0);
		expect(footprint(box(12.5), m, 1000, 1000, 1, 0.1, 1000, 1.1).pixels).toBeGreaterThan(0);
	});

	it('reports viewport visibility separately from the fringe', () => {
		for (const b of [box(), box(9), box(12.5), box(20), box(0, 20), box(0, -1)]) {
			const plain = footprint(b, identity(), 1000, 1000, 1, 0.1, 1000);
			const fringe = footprint(b, identity(), 1000, 1000, 1, 0.1, 1000, 1.1);
			expect(fringe.shown).toBe(plain.pixels > 0);
		}
	});
});
