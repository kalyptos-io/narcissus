import { describe, expect, it } from 'vitest';
import { Graphics } from './overlay.ts';

describe('Graphics', () => {
	it('gives the capsules scaled by the ratio only when they changed', () => {
		let changes = 0;
		const graphics = new Graphics(() => changes++);
		graphics.line(
			[
				[0, 0, 0],
				[1, 0, 0],
				[1, 1, 0]
			],
			{ width: 4, closed: true }
		);
		graphics.marker([5, 5, 5]);
		expect(changes).toBe(2);
		const capsules = graphics.capsules(2)!;
		expect(capsules.map((c) => [c.a, c.b, c.radius])).toEqual([
			[[0, 0, 0], [1, 0, 0], 4],
			[[1, 0, 0], [1, 1, 0], 4],
			[[1, 1, 0], [0, 0, 0], 4],
			[[5, 5, 5], [5, 5, 5], 12]
		]);
		expect(graphics.capsules(2)).toBeNull();
		graphics.reshape();
		expect(graphics.capsules(1)).toHaveLength(4);
		expect(changes).toBe(2);
	});

	it('moves a graphic with set and ends it with remove, after which it does nothing', () => {
		let changes = 0;
		const graphics = new Graphics(() => changes++);
		const marker = graphics.marker([0, 0, 0]);
		const line = graphics.line([[0, 0, 0]]);
		graphics.capsules(1);
		marker.set([1, 2, 3]);
		expect(graphics.capsules(1)!.map((c) => c.a)).toEqual([
			[1, 2, 3],
			[0, 0, 0]
		]);
		marker.remove();
		expect(graphics.capsules(1)!.map((c) => c.a)).toEqual([[0, 0, 0]]);
		expect(changes).toBe(4);
		marker.set([4, 5, 6]);
		marker.remove();
		expect(graphics.capsules(1)).toBeNull();
		expect(changes).toBe(4);
		expect(() => line.set([])).toThrow();
		expect(() => line.set([[0, NaN, 0]])).toThrow();
	});
});
