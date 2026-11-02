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

	it('sets each field by assignment, leaves hidden ones out, and ignores setters after remove', () => {
		let changes = 0;
		const graphics = new Graphics(() => changes++);
		const marker = graphics.marker([0, 0, 0]);
		const line = graphics.line([[0, 0, 0]]);
		graphics.capsules(1);
		marker.point = [1, 2, 3];
		expect(graphics.capsules(1)!.map((c) => c.a)).toEqual([
			[1, 2, 3],
			[0, 0, 0]
		]);
		line.points = [
			[0, 0, 0],
			[1, 0, 0]
		];
		line.style = { ...line.style, colour: [1, 0, 0, 1] };
		expect(line.style).toEqual({ colour: [1, 0, 0, 1], width: 2, closed: false, occlude: true });
		marker.style = { size: 6 };
		expect(marker.style).toEqual({ colour: [1, 1, 1, 1], size: 6, occlude: true });
		expect(graphics.capsules(1)!.map((c) => [c.b, c.radius, c.colour])).toEqual([
			[[1, 2, 3], 3, [1, 1, 1, 1]],
			[[1, 0, 0], 1, [1, 0, 0, 1]]
		]);
		line.visible = false;
		expect(line.visible).toBe(false);
		expect(graphics.capsules(1)!.map((c) => c.a)).toEqual([[1, 2, 3]]);
		line.visible = true;
		expect(graphics.capsules(1)).toHaveLength(2);
		marker.remove();
		expect(graphics.capsules(1)!.map((c) => c.a)).toEqual([[0, 0, 0]]);
		expect(changes).toBe(9);
		marker.point = [4, 5, 6];
		marker.visible = false;
		marker.remove();
		expect(marker.point).toEqual([1, 2, 3]);
		expect(marker.visible).toBe(true);
		expect(graphics.capsules(1)).toBeNull();
		expect(changes).toBe(9);
	});

	it('throws a RangeError naming the argument for a bad point or style', () => {
		const graphics = new Graphics(() => {});
		const line = graphics.line([[0, 0, 0]]);
		expect(() => (line.points = [])).toThrow(/^points/);
		expect(
			() =>
				(line.points = [
					[0, 0, 0],
					[0, NaN, 0]
				])
		).toThrow(/^points\[1\]/);
		expect(() => graphics.marker([0, 0] as never)).toThrow(/^point /);
		expect(() => (line.style = { colour: [1, 1, 2, 1] })).toThrow(/^colour/);
		expect(() => (line.style = { colour: [1, 1, 1] as never })).toThrow(/^colour/);
		expect(() => (line.style = { width: 0 })).toThrow(/^width/);
		expect(() => graphics.marker([0, 0, 0], { size: Infinity })).toThrow(/^size/);
		expect(() => graphics.line([[0, 0, 0]], { width: -1 })).toThrow(RangeError);
		expect(line.points).toEqual([[0, 0, 0]]);
		expect(line.style.width).toBe(2);
	});
});
