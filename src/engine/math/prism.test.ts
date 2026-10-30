import { describe, expect, it } from 'vitest';
import { CROSS, IN, inside, OUT, relate, type Prism } from './prism.ts';

// an l-shape: the square 0..10 less its north-east quarter
const l = Float64Array.from([0, 0, 10, 0, 10, 5, 5, 5, 5, 10, 0, 10]);
const full: Prism = { polygon: l, z: [-Infinity, Infinity] };

describe('inside', () => {
	it('follows the even-odd rule', () => {
		expect(inside(l, 2, 2)).toBe(true);
		expect(inside(l, 7, 2)).toBe(true);
		expect(inside(l, 7, 7)).toBe(false);
		expect(inside(l, -1, 2)).toBe(false);
		// a square with a square hole wound the same way
		const ring = Float64Array.from([0, 0, 4, 0, 4, 4, 0, 4, 0, 0, 1, 1, 3, 1, 3, 3, 1, 3, 1, 1]);
		expect(inside(ring, 0.5, 2)).toBe(true);
		expect(inside(ring, 2, 2)).toBe(false);
	});
});

describe('relate', () => {
	const box = (x0: number, y0: number, x1: number, y1: number, z0 = 0, z1 = 1) =>
		[
			[x0, y0, z0],
			[x1, y1, z1]
		] as const;

	it('is IN for a box wholly inside, OUT wholly outside, CROSS where an edge meets it', () => {
		expect(relate(full, ...box(1, 1, 4, 4))).toBe(IN);
		expect(relate(full, ...box(6, 6, 9, 9))).toBe(OUT);
		expect(relate(full, ...box(20, 20, 30, 30))).toBe(OUT);
		expect(relate(full, ...box(4, 4, 6, 6))).toBe(CROSS);
		// the polygon wholly inside the box
		expect(relate(full, ...box(-5, -5, 15, 15))).toBe(CROSS);
	});

	it('limits by height: OUT beyond the range, CROSS where the box spans an end', () => {
		const prism: Prism = { polygon: l, z: [0, 10] };
		expect(relate(prism, ...box(1, 1, 4, 4, 2, 3))).toBe(IN);
		expect(relate(prism, ...box(1, 1, 4, 4, 11, 12))).toBe(OUT);
		expect(relate(prism, ...box(1, 1, 4, 4, 9, 11))).toBe(CROSS);
		expect(relate(prism, ...box(6, 6, 9, 9, 9, 11))).toBe(OUT);
	});
});
