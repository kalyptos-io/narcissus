import { describe, expect, it } from 'vitest';
import { CROSS, edges, IN, inside, OUT, relate, type Prism } from './prism.ts';

// an l-shape: the square 0..10 less its north-east quarter
const l = edges([
	[
		[0, 0],
		[10, 0],
		[10, 5],
		[5, 5],
		[5, 10],
		[0, 10]
	]
]);
const full: Prism = { edges: l, z: [-Infinity, Infinity], outside: false };

/** a square ring from (x, y) of side s */
const square = (x: number, y: number, s: number): [number, number][] => [
	[x, y],
	[x + s, y],
	[x + s, y + s],
	[x, y + s]
];

// a square 0..12 with a hole 2..10 and an island 4..8 in the hole
const holed = edges([square(0, 0, 12), square(2, 2, 8), square(4, 4, 4)]);

const box = (x0: number, y0: number, x1: number, y1: number, z0 = 0, z1 = 1) =>
	[
		[x0, y0, z0],
		[x1, y1, z1]
	] as const;

describe('inside', () => {
	it('follows the even-odd rule', () => {
		expect(inside(l, 2, 2)).toBe(true);
		expect(inside(l, 7, 2)).toBe(true);
		expect(inside(l, 7, 7)).toBe(false);
		expect(inside(l, -1, 2)).toBe(false);
	});

	it('leaves out holes and keeps islands in them, with no bridge edges', () => {
		expect(inside(holed, 1, 6)).toBe(true);
		expect(inside(holed, 3, 6)).toBe(false);
		expect(inside(holed, 6, 6)).toBe(true);
		expect(inside(holed, 13, 6)).toBe(false);
	});

	it('takes a ring that repeats its first corner as GeoJSON does', () => {
		const closed = edges([[...square(0, 0, 4), [0, 0]]]);
		expect(inside(closed, 2, 2)).toBe(true);
		expect(inside(closed, 5, 2)).toBe(false);
	});
});

describe('relate', () => {
	it('is IN for a box wholly inside, OUT wholly outside, CROSS where an edge meets it', () => {
		expect(relate(full, ...box(1, 1, 4, 4))).toBe(IN);
		expect(relate(full, ...box(6, 6, 9, 9))).toBe(OUT);
		expect(relate(full, ...box(20, 20, 30, 30))).toBe(OUT);
		expect(relate(full, ...box(4, 4, 6, 6))).toBe(CROSS);
		// the polygon wholly inside the box
		expect(relate(full, ...box(-5, -5, 15, 15))).toBe(CROSS);
	});

	it('limits by height: OUT beyond the range, CROSS where the box spans an end', () => {
		const prism: Prism = { edges: l, z: [0, 10], outside: false };
		expect(relate(prism, ...box(1, 1, 4, 4, 2, 3))).toBe(IN);
		expect(relate(prism, ...box(1, 1, 4, 4, 11, 12))).toBe(OUT);
		expect(relate(prism, ...box(1, 1, 4, 4, 9, 11))).toBe(CROSS);
		expect(relate(prism, ...box(6, 6, 9, 9, 9, 11))).toBe(OUT);
	});

	it('relates holes and islands by their edges', () => {
		const prism: Prism = { edges: holed, z: [-Infinity, Infinity], outside: false };
		expect(relate(prism, ...box(0.5, 3, 1.5, 9))).toBe(IN);
		expect(relate(prism, ...box(2.5, 2.5, 3.5, 3.5))).toBe(OUT);
		expect(relate(prism, ...box(5, 5, 7, 7))).toBe(IN);
		expect(relate(prism, ...box(3, 3, 5, 5))).toBe(CROSS);
	});

	it('swaps IN and OUT for a prism that acts outside, height range too', () => {
		const prism: Prism = { edges: l, z: [0, 10], outside: true };
		expect(relate(prism, ...box(1, 1, 4, 4, 2, 3))).toBe(OUT);
		expect(relate(prism, ...box(6, 6, 9, 9))).toBe(IN);
		expect(relate(prism, ...box(1, 1, 4, 4, 11, 12))).toBe(IN);
		expect(relate(prism, ...box(4, 4, 6, 6))).toBe(CROSS);
		expect(relate(prism, ...box(1, 1, 4, 4, 9, 11))).toBe(CROSS);
	});
});
