import { describe, expect, it } from 'vitest';
import { capacities, rebase, unproject } from './engine.ts';
import { CLUSTER } from '../format/index.ts';
import { forward, multiply, perspective, transform, view } from './math/mat4.ts';

const MiB = 2 ** 20;
const DEG = Math.PI / 180;

describe('capacities', () => {
	it('gives the pool 2.5 and a frame 2 times the budget in whole clusters', () => {
		const limits = { maxStorageBufferBindingSize: 2 ** 31, maxBufferSize: 2 ** 32 };
		const { pool, frame } = capacities(2_000_000, limits);
		expect(pool).toBe(5_000_192);
		expect(frame).toBe(4_000_000);
		expect(pool % CLUSTER).toBe(0);
		expect(frame % CLUSTER).toBe(0);
	});

	it('keeps the widest binding of each within the binding size', () => {
		const limits = { maxStorageBufferBindingSize: 128 * MiB, maxBufferSize: 256 * MiB };
		expect(capacities(16_000_000, limits)).toEqual({ pool: 8_388_608, frame: 5_592_320 });
	});

	it('keeps every buffer within the buffer size when that is the smaller limit', () => {
		const limits = { maxStorageBufferBindingSize: 1024 * MiB, maxBufferSize: 64 * MiB };
		expect(capacities(16_000_000, limits)).toEqual({ pool: 4_194_304, frame: 2_796_032 });
	});
});

describe('rebase', () => {
	it('keeps the origin while the camera stays within 2048 m of it', () => {
		const origin = [722944, 6176768, 0] as const;
		expect(rebase(origin, [724944, 6176768, 100])).toBe(origin);
	});

	it('moves the origin to the nearest 1024 m grid point once the camera strays further', () => {
		expect(rebase([0, 0, 0], [723100.4, 6177000, 30])).toEqual([722944, 6176768, 0]);
	});
});

describe('unproject', () => {
	it('takes a pixel and its view depth back to the world point under it', () => {
		const origin = [722944, 6176768, 0] as const;
		const eye = [50, 20, 120] as const;
		const [yaw, pitch] = [30 * DEG, -35 * DEG];
		const f = forward(yaw, pitch);
		const local = [eye[0] + 60 * f[0] + 3, eye[1] + 60 * f[1] - 2, eye[2] + 60 * f[2]] as const;
		const v = view(new Float64Array(16), eye, yaw, pitch);
		const p = perspective(new Float64Array(16), 45 * DEG, 16 / 9, 0.2, 5000);
		const [cx, cy, , cw] = transform(multiply(new Float64Array(16), p, v), local);
		const depth = -transform(v, local)[2];
		const size = [1920, 1080] as const;
		const pixel = [((cx / cw + 1) / 2) * size[0], ((1 - cy / cw) / 2) * size[1]] as const;
		const point = unproject(pixel, size, depth, p, v, origin);
		point.forEach((x, k) => expect(x).toBeCloseTo(local[k] + origin[k], 5));
	});
});
