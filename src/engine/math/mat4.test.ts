import { describe, expect, it } from 'vitest';
import { invert, multiply, perspective, transform, view } from './mat4.ts';
import { boxVisible, planes } from './frustum.ts';

const rad = Math.PI / 180;

describe('view', () => {
	it('puts what lies ahead down -z, east to the right of a north-facing camera', () => {
		const m = view(new Float64Array(16), [100, 200, 30], 0, 0);
		const ahead = transform(m, [100, 210, 30]);
		const east = transform(m, [101, 200, 30]);
		const above = transform(m, [100, 200, 31]);
		expect(ahead[2]).toBeCloseTo(-10);
		expect(east[0]).toBeCloseTo(1);
		expect(above[1]).toBeCloseTo(1);
	});

	it('turns clockwise with yaw and looks down with negative pitch', () => {
		const east = view(new Float64Array(16), [0, 0, 0], 90 * rad, 0);
		expect(transform(east, [5, 0, 0])[2]).toBeCloseTo(-5);
		const down = view(new Float64Array(16), [0, 0, 0], 0, -90 * rad);
		expect(transform(down, [0, 0, -7])[2]).toBeCloseTo(-7);
		expect(transform(down, [0, 1, -7])[1]).toBeCloseTo(1);
	});
});

describe('perspective', () => {
	it('maps near to clip depth 0 and far to 1', () => {
		const p = perspective(new Float64Array(16), 45 * rad, 1, 1, 100);
		const near = transform(p, [0, 0, -1]);
		const far = transform(p, [0, 0, -100]);
		expect(near[2] / near[3]).toBeCloseTo(0);
		expect(far[2] / far[3]).toBeCloseTo(1);
	});
});

describe('invert', () => {
	it('undoes a view', () => {
		const m = view(new Float64Array(16), [3, -4, 5], 0.3, -0.6);
		const i = invert(new Float64Array(16), m)!;
		const id = multiply(new Float64Array(16), m, i);
		expect([...id].map((v) => Math.round(v * 1e9) / 1e9 + 0)).toEqual([
			1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1
		]);
	});
});

describe('planes', () => {
	it('keeps a box ahead and drops one behind or past the far plane', () => {
		const vp = multiply(
			new Float64Array(16),
			perspective(new Float64Array(16), 60 * rad, 16 / 9, 0.5, 1000),
			view(new Float64Array(16), [0, 0, 0], 0, 0)
		);
		const p = planes(new Float64Array(24), vp);
		expect(boxVisible(p, [-1, 9, -1], [1, 11, 1])).toBe(true);
		expect(boxVisible(p, [-1, -11, -1], [1, -9, 1])).toBe(false);
		expect(boxVisible(p, [-1, 1009, -1], [1, 1011, 1])).toBe(false);
		expect(boxVisible(p, [-1000, 9, -1], [-900, 11, 1])).toBe(false);
	});
});
