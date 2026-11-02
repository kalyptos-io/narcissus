import { describe, expect, it } from 'vitest';
import { relate } from '../math/prism.ts';
import { Masks, type Spec } from './masks.ts';
import { testDevice } from './test-device.ts';
import { rect } from './test-mask.ts';

/** a mask over the square of side from (x, y), over z, that hides the world's splats */
const square = (x: number, y: number, side: number, z: [number, number] = [-5, 5]) =>
	rect(x, y, x + side, y + side, { z });

describe('Masks', () => {
	it('relates a box to the masks it meets as a scan of every mask does, small and wide alike', async () => {
		const masks = new Masks(await testDevice());
		let seed = 7;
		const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 200 - 100;
		const squares: Spec[] = [];
		for (let k = 0; k < 300; k++)
			squares.push(square(random(), random(), 1 + Math.abs(random()) / 50));
		// a few that span many cells of a typical mask's size
		squares.push(square(-100, -100, 150), square(20, -90, 60, [0, 1]));
		const ids = squares.map((s) => masks.add(s));
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
				.map((id) => [id, relate(squares[ids.indexOf(id)].prism, min, max)]);
			expect(held).toBe(scanned.some(([, r]) => r === 1));
			if (!held)
				expect(crossing.map((entry) => entry / 2).sort((a, b) => a - b)).toEqual(
					scanned.filter(([, r]) => r === 2).map(([id]) => id)
				);
		}
		masks.destroy();
	});

	it('lists a fading mask over a box it holds, and an outside one over every box beyond it', async () => {
		const masks = new Masks(await testDevice());
		const hide = masks.add(rect(0, 0, 10, 10, { z: [-5, 5], outside: true }));
		const fade = masks.add(rect(2, 2, 4, 4, { z: [-5, 5], opacity: 0.5 }));
		const far = masks.add(rect(500, 500, 502, 502, { z: [-5, 5], opacity: 0.5 }));
		const relation = (x: number, y: number, s: number) => {
			const listed: number[] = [];
			const hidden = masks.relate(0, [x, y, 0], [x + s, y + s, 1], listed);
			return hidden ? 'hidden' : listed;
		};
		// a box the mask holds whole is marked so, sparing the shader its edges
		expect(relation(2.5, 2.5, 1)).toEqual([2 * fade + 1]);
		expect(relation(1, 1, 2)).toEqual([2 * fade]);
		expect(relation(9, 9, 2)).toEqual([2 * hide]);
		expect(relation(1e4, 1e4, 1)).toBe('hidden');
		expect(relation(500.5, 500.5, 1)).toBe('hidden');
		masks.enable(hide, false);
		expect(relation(500.5, 500.5, 1)).toEqual([2 * far + 1]);
		// a set keeps its place in the list
		masks.enable(hide, true);
		masks.set(hide, rect(0, 0, 10, 10, { z: [-5, 5], outside: true, opacity: 0.5 }));
		expect(relation(1, 1, 10)).toEqual([2 * hide, 2 * fade]);
		masks.destroy();
	});
});
