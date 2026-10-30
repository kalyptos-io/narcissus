import { describe, expect, it } from 'vitest';
import { relate, type Prism } from '../math/prism.ts';
import { Masks } from './masks.ts';
import { testDevice } from './test-device.ts';

/** a square prism of side `side` from (x, y), over z */
function square(x: number, y: number, side: number, z: [number, number] = [-5, 5]): Prism {
	return { polygon: Float64Array.from([x, y, x + side, y, x + side, y + side, x, y + side]), z };
}

describe('Masks', () => {
	it('relates a box to the masks it meets as a scan of every mask does, small and wide alike', async () => {
		const masks = new Masks(await testDevice());
		let seed = 7;
		const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 200 - 100;
		const prisms: Prism[] = [];
		for (let k = 0; k < 300; k++)
			prisms.push(square(random(), random(), 1 + Math.abs(random()) / 50));
		// a few that span many cells of a typical mask's size
		prisms.push(square(-100, -100, 150), square(20, -90, 60, [0, 1]));
		const ids = prisms.map((p) => masks.add(p, new Set([0])));
		masks.delete(ids[3]);
		masks.enable(ids[4], false);
		const boxes = [
			...Array.from({ length: 200 }, () => {
				const [x, y, s] = [random(), random(), Math.abs(random()) / 20];
				return [
					[x, y, -1],
					[x + s, y + s, 1]
				];
			}),
			[
				[-1e4, -1e4, -1e4],
				[1e4, 1e4, 1e4]
			]
		];
		for (const [min, max] of boxes) {
			const crossing: number[] = [];
			const held = masks.relate(0, min, max, crossing);
			const scanned = ids
				.filter((id, k) => k !== 3 && k !== 4)
				.map((id) => [id, relate(prisms[ids.indexOf(id)], min, max)]);
			expect(held).toBe(scanned.some(([, r]) => r === 1));
			if (!held)
				expect(crossing.sort((a, b) => a - b)).toEqual(
					scanned.filter(([, r]) => r === 2).map(([id]) => id)
				);
		}
		masks.destroy();
	});
});
