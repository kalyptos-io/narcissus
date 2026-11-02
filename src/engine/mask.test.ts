import { describe, expect, it } from 'vitest';
import { CLUSTER } from '../format/index.ts';
import { encodeLayer } from '../format/encode.ts';
import { Pool } from './gpu/pool.ts';
import { testDevice } from './gpu/test-device.ts';
import { layerPages, Layers, type Layer } from './layer.ts';
import { createMask, type MaskOptions } from './mask.ts';
import type { Ring } from './types.ts';

const square: Ring = [
	[0, 0],
	[10, 0],
	[10, 10],
	[0, 10]
];

/** a layer of one splat in layers */
async function layerIn(layers: Layers): Promise<Layer> {
	const { pack, origin } = await encodeLayer({
		count: 1,
		position: Float64Array.of(1, 1, 1),
		rotation: Float32Array.of(1, 0, 0, 0),
		scale: new Float32Array(3).fill(Math.log(0.1)),
		alpha: Float32Array.of(1),
		dc: new Float32Array(3),
		sh: null
	});
	return layers.add(await layerPages(pack, origin), { bytes: pack, origin })!;
}

describe('createMask', () => {
	async function setup() {
		const pool = new Pool(await testDevice(), 4 * CLUSTER);
		const layers = new Layers(
			pool,
			() => false,
			() => {}
		);
		const changes = { count: 0 };
		const mask = (options: MaskOptions) => createMask(pool, options, layers, () => changes.count++);
		/** the masks' relation to the world's 1 m box at (x, y, z): hidden, or the ids listed */
		const relation = (x: number, y: number, z = 0, layer = 0) => {
			const listed: number[] = [];
			const hidden = pool.masks.relate(layer, [x, y, z], [x + 1, y + 1, z + 1], listed);
			return hidden ? 'hidden' : listed.length;
		};
		return { pool, layers, changes, mask, relation };
	}

	it('throws a RangeError naming the option that is wrong, and keeps nothing', async () => {
		const { pool, layers, changes, mask } = await setup();
		const removed = await layerIn(layers);
		removed.remove();
		const other = await layerIn(
			new Layers(
				pool,
				() => false,
				() => {}
			)
		);
		const world = { polygon: square, targets: ['world'] } as const;
		const bad: [Partial<MaskOptions>, RegExp][] = [
			[{ polygon: [] }, /polygon/],
			[{ polygon: square.slice(0, 2) }, /polygon/],
			[{ polygon: [square, square.slice(2)] }, /polygon/],
			[
				{
					polygon: [
						[0, 0],
						[1, NaN],
						[2, 2]
					]
				},
				/polygon/
			],
			[{ z: [5, 1] }, /z/],
			[{ z: [NaN, 1] }, /z/],
			[{ opacity: 1.5 }, /opacity/],
			[{ opacity: NaN }, /opacity/],
			[{ tint: [1, 0, 0] as unknown as MaskOptions['tint'] }, /tint/],
			[{ tint: [0, 0, 0, 2] }, /tint/],
			[{ targets: [removed] }, /targets/],
			[{ targets: [other] }, /targets/]
		];
		for (const [options, message] of bad) {
			expect(() => mask({ ...world, ...options })).toThrow(RangeError);
			expect(() => mask({ ...world, ...options })).toThrow(message);
		}
		expect(pool.masks.size).toBe(0);
		expect(changes.count).toBe(0);
		const handle = mask(world);
		expect(() => (handle.opacity = -1)).toThrow(/opacity/);
		expect(() => (handle.targets = [removed])).toThrow(/targets/);
		expect([handle.opacity, handle.targets]).toEqual([0, ['world']]);
		expect(changes.count).toBe(1);
		pool.destroy();
	});

	it('acts as each field is set, and does nothing once removed', async () => {
		const { pool, layers, changes, mask, relation } = await setup();
		const handle = mask({ polygon: square, targets: ['world'] });
		expect([handle.z, handle.outside, handle.opacity, handle.tint]).toEqual([
			[-Infinity, Infinity],
			false,
			0,
			[0, 0, 0, 0]
		]);
		expect([relation(2, 2), relation(20, 20)]).toEqual(['hidden', 0]);
		handle.outside = true;
		expect([relation(2, 2), relation(20, 20)]).toEqual([0, 'hidden']);
		handle.opacity = 0.5;
		expect(relation(20, 20)).toBe(1);
		handle.outside = false;
		handle.opacity = 0;
		// a hole where the box is
		handle.polygon = [
			square,
			[
				[1, 1],
				[5, 1],
				[5, 5],
				[1, 5]
			]
		];
		expect([relation(2, 2), relation(7, 7)]).toEqual([0, 'hidden']);
		handle.z = [5, 10];
		expect([relation(7, 7), relation(7, 7, 6)]).toEqual([0, 'hidden']);
		const layer = await layerIn(layers);
		handle.targets = [layer];
		const number = layers.numberOf(layer)!;
		expect([relation(7, 7, 6), relation(7, 7, 6, number)]).toEqual([0, 'hidden']);
		handle.tint = [1, 0, 0, 1];
		expect(changes.count).toBe(9);

		handle.remove();
		expect(pool.masks.size).toBe(0);
		handle.opacity = 1;
		handle.z = [0, 1];
		handle.enabled = false;
		expect([handle.opacity, handle.z, handle.enabled, handle.tint]).toEqual([
			0,
			[5, 10],
			true,
			[1, 0, 0, 1]
		]);
		expect(changes.count).toBe(10);
		pool.destroy();
	});

	it('keeps the splats of a mask with a tint unless told otherwise', async () => {
		const { pool, mask, relation } = await setup();
		const tinted = mask({ polygon: square, targets: ['world'], tint: [1, 0, 0, 0.5] });
		expect([tinted.opacity, relation(2, 2)]).toEqual([1, 1]);
		tinted.remove();
		const hiding = mask({ polygon: square, targets: ['world'], tint: [1, 0, 0, 0.5], opacity: 0 });
		expect([hiding.opacity, relation(2, 2)]).toEqual([0, 'hidden']);
		pool.destroy();
	});
});
